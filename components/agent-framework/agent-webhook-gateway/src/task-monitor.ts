import {
	isTerminalTaskState,
	type MissionTaskSnapshot,
	type MissionTaskSpec,
	parseTaskSnapshot,
} from "./task-contract.ts";
import type { McpToolCaller } from "./types.ts";

export interface TaskMonitorOptions {
	pollIntervalMs?: number;
	timeoutMs?: number;
	sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class TaskMonitor {
	private readonly mcp: McpToolCaller;
	private readonly pollIntervalMs: number;
	private readonly timeoutMs: number;
	private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

	constructor(mcp: McpToolCaller, options: TaskMonitorOptions = {}) {
		this.mcp = mcp;
		this.pollIntervalMs = options.pollIntervalMs ?? 500;
		this.timeoutMs = options.timeoutMs ?? 330_000;
		this.sleep = options.sleep ?? abortableSleep;
		if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
			throw new Error("Task poll interval must be a positive finite number");
		}
		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
			throw new Error("Task monitor timeout must be a positive finite number");
		}
	}

	async submit(task: MissionTaskSpec, signal?: AbortSignal): Promise<void> {
		const raw = await this.mcp.callTool("start_task", { task_json: JSON.stringify(task) }, signal);
		const acknowledgement = parseStartAcknowledgement(raw);
		if (!acknowledgement.accepted) {
			if (acknowledgement.activeTaskId === task.task_id) {
				return;
			}
			throw new Error(acknowledgement.reason ?? `MissionExecutor rejected task ${task.task_id}`);
		}
		if (acknowledgement.taskId !== task.task_id) {
			throw new Error("MissionExecutor acknowledged a different task ID");
		}
	}

	async waitForTerminal(
		task: MissionTaskSpec,
		onSnapshot: (snapshot: MissionTaskSnapshot) => void = () => {},
		signal?: AbortSignal,
	): Promise<MissionTaskSnapshot> {
		const taskId = task.task_id;
		const deadline = Date.now() + this.timeoutMs;
		while (Date.now() < deadline) {
			signal?.throwIfAborted();
			const raw = await this.mcp.callTool("get_task_status", {}, signal);
			const snapshot = parseTaskSnapshot(raw);
			if (snapshot.task.task_id !== taskId) {
				throw new Error(`MissionExecutor is running another task: ${snapshot.task.task_id}`);
			}
			onSnapshot(snapshot);
			if (isTerminalTaskState(snapshot.state) && !snapshot.active) {
				return snapshot;
			}
			await this.sleep(this.pollIntervalMs, signal);
		}
		throw new Error(`Timed out waiting for task ${taskId} terminal state`);
	}
}

interface StartAcknowledgement {
	accepted: boolean;
	taskId?: string;
	activeTaskId?: string;
	reason?: string;
}

function parseStartAcknowledgement(raw: string): StartAcknowledgement {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("start_task returned invalid JSON");
	}
	if (!isObject(value) || typeof value.accepted !== "boolean") {
		throw new Error("start_task returned an invalid acknowledgement");
	}
	return {
		accepted: value.accepted,
		taskId: typeof value.task_id === "string" ? value.task_id : undefined,
		activeTaskId: typeof value.active_task_id === "string" ? value.active_task_id : undefined,
		reason: typeof value.reason === "string" ? value.reason : undefined,
	};
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abortSignal = signal;
		const finish = () => {
			abortSignal?.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(finish, milliseconds);
		timer.unref();
		const abort = () => {
			clearTimeout(timer);
			abortSignal?.removeEventListener("abort", abort);
			reject(abortSignal?.reason);
		};
		if (!abortSignal) {
			return;
		}
		if (abortSignal.aborted) {
			abort();
			return;
		}
		abortSignal.addEventListener("abort", abort, { once: true });
	});
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
