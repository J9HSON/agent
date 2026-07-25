import { McpCallError } from "./mcp-client.ts";
import type { GatewayStore, StoredInstructionView, StoredTaskBinding } from "./store.ts";
import {
	buildRouteLegTaskSpec,
	buildTaskSpec,
	formatTerminalTaskReply,
	type MissionTaskSnapshot,
	type TaskParameterCompiler,
	totalRouteLegs,
	type VisitRouteParameters,
} from "./task-contract.ts";
import { TaskMonitor } from "./task-monitor.ts";
import {
	type ExternalInstruction,
	FAILURE_REPLY_TEXT,
	FOLLOW_ACCEPTED_REPLY_TEXT,
	type McpToolCaller,
	type ReplyEventDelivery,
	STOP_ACCEPTED_REPLY_TEXT,
	type UserTextAgent,
} from "./types.ts";

export class InstructionConflictError extends Error {}

type PriorityCommand =
	| { kind: "stop_all" }
	| { kind: "pause_task" }
	| { kind: "resume_task" }
	| { kind: "cancel_task" }
	| { kind: "get_robot_status" }
	| {
			kind: "manual_move";
			reply: string;
			arguments_: {
				forward: number;
				left: number;
				degrees: number;
			};
	  };

export interface AgentWebhookServiceOptions {
	store: GatewayStore;
	agent?: UserTextAgent;
	taskCompiler?: TaskParameterCompiler;
	mcp: McpToolCaller;
	replyClient: ReplyEventDelivery;
	retryBaseMs?: number;
	retryMaxMs?: number;
	taskPollIntervalMs?: number;
	taskTimeoutMs?: number;
	onBackgroundError?: (error: unknown) => void;
}

export class AgentWebhookService {
	private readonly store: GatewayStore;
	private readonly agent?: UserTextAgent;
	private readonly taskCompiler?: TaskParameterCompiler;
	private readonly mcp: McpToolCaller;
	private readonly taskMonitor: TaskMonitor;
	private readonly replyClient: ReplyEventDelivery;
	private readonly retryBaseMs: number;
	private readonly retryMaxMs: number;
	private readonly onBackgroundError: (error: unknown) => void;
	private agentDrainPromise?: Promise<void>;
	private stopDrainPromise?: Promise<void>;
	private deliveryPromise?: Promise<void>;
	private retryTimer?: NodeJS.Timeout;
	private taskAbortController = new AbortController();
	private closed = false;

	constructor(options: AgentWebhookServiceOptions) {
		if (Boolean(options.agent) === Boolean(options.taskCompiler)) {
			throw new Error("AgentWebhookService requires exactly one agent or taskCompiler");
		}
		this.store = options.store;
		this.agent = options.agent;
		this.taskCompiler = options.taskCompiler;
		this.mcp = options.mcp;
		this.taskMonitor = new TaskMonitor(options.mcp, {
			pollIntervalMs: options.taskPollIntervalMs,
			timeoutMs: options.taskTimeoutMs,
		});
		this.replyClient = options.replyClient;
		this.retryBaseMs = options.retryBaseMs ?? 1_000;
		this.retryMaxMs = options.retryMaxMs ?? 60_000;
		this.onBackgroundError = options.onBackgroundError ?? ((error) => console.error(error));
	}

	start(): void {
		this.store.recoverInterrupted(new Date().toISOString(), FAILURE_REPLY_TEXT);
		this.scheduleAgentDrain();
		this.scheduleStopDrain();
		this.scheduleDelivery();
	}

	acceptInstruction(instruction: ExternalInstruction): void {
		const priorityCommand = parsePriorityCommand(instruction.text);
		const result = this.store.acceptInstruction(instruction, priorityCommand !== undefined, new Date().toISOString());
		if (result === "conflict") {
			throw new InstructionConflictError(
				`instruction_id ${instruction.instructionId} is already associated with different text`,
			);
		}
		if (result === "accepted") {
			if (priorityCommand) {
				this.scheduleStopDrain();
			} else {
				this.scheduleAgentDrain();
			}
		}
	}

	getInstructionView(instructionId: string): StoredInstructionView | undefined {
		return this.store.getInstructionView(instructionId);
	}

	private scheduleAgentDrain(): void {
		if (this.closed || this.agentDrainPromise) {
			return;
		}
		this.agentDrainPromise = Promise.resolve()
			.then(async () => {
				while (!this.closed) {
					if (this.taskCompiler) {
						const recoverable = this.store.nextRecoverableTaskBinding();
						if (recoverable) {
							await this.monitorTaskBinding(recoverable, recoverable.compileStatus === "compiled");
							continue;
						}
					}
					const instruction = this.store.claimNextNormalInstruction();
					if (!instruction) {
						return;
					}
					if (this.taskCompiler) {
						await this.processTaskInstruction(instruction);
						continue;
					}
					let replyText = FAILURE_REPLY_TEXT;
					try {
						if (!this.agent) {
							throw new Error("User text agent is unavailable");
						}
						const result = await this.agent.run(instruction.text);
						if (result.trim()) {
							replyText = result;
						}
					} catch {
						replyText = FAILURE_REPLY_TEXT;
					}
					this.store.completeInstruction(instruction.instructionId, replyText, new Date().toISOString());
					this.scheduleDelivery();
				}
			})
			.catch(this.onBackgroundError)
			.finally(() => {
				this.agentDrainPromise = undefined;
				if (!this.closed && this.store.hasPendingNormalInstruction()) {
					this.scheduleAgentDrain();
				}
			});
	}

	private async processTaskInstruction(instruction: ExternalInstruction): Promise<void> {
		try {
			const parameters = await this.taskCompiler?.compile(instruction.text);
			if (!parameters) {
				throw new Error("Task compiler is unavailable");
			}
			if (parameters.kind === "follow_person") {
				const result = await this.mcp.callTool("follow_person", {
					query: "the person closest to the center of the image",
				});
				if (!result.includes("Starting to follow")) {
					throw new Error(`Official person follow did not start: ${result}`);
				}
				this.store.completeInstruction(
					instruction.instructionId,
					FOLLOW_ACCEPTED_REPLY_TEXT,
					new Date().toISOString(),
				);
				this.scheduleDelivery();
				return;
			}
			if (parameters.kind === "mark_place") {
				await this.markCurrentPlace(parameters.name);
				this.store.completeInstruction(
					instruction.instructionId,
					`已将当前位置标记为“${parameters.name}”。`,
					new Date().toISOString(),
				);
				this.scheduleDelivery();
				return;
			}
			const now = new Date();
			if (parameters.kind === "visit_route") {
				await this.validateRoutePlaces(parameters);
				const task = buildRouteLegTaskSpec(instruction, parameters, 0, now);
				const binding = this.store.createRouteBinding(
					instruction.instructionId,
					parameters,
					task,
					now.toISOString(),
				);
				await this.monitorTaskBinding(binding, true);
				return;
			}
			const task = buildTaskSpec(instruction, parameters, now);
			const binding = this.store.createTaskBinding(instruction.instructionId, task, now.toISOString());
			await this.monitorTaskBinding(binding, true);
		} catch (error) {
			if (this.closed && this.taskAbortController.signal.aborted) {
				return;
			}
			const binding = this.store.getTaskBinding(instruction.instructionId);
			if (binding) {
				this.store.markTaskBindingFailed(binding.taskId, new Date().toISOString());
			}
			this.store.completeInstruction(
				instruction.instructionId,
				userFacingFailureReply(error),
				new Date().toISOString(),
			);
			if (error instanceof Error) {
				this.onBackgroundError(error);
			}
			this.scheduleDelivery();
		}
	}

	private async monitorTaskBinding(binding: StoredTaskBinding, submit: boolean): Promise<void> {
		try {
			let current = binding;
			let shouldSubmit = submit;
			while (true) {
				let terminal: MissionTaskSnapshot;
				if (shouldSubmit) {
					let submissionError: unknown;
					try {
						await this.taskMonitor.submit(current.task, this.taskAbortController.signal);
						this.store.markTaskSubmitted(current.taskId, new Date().toISOString());
					} catch (startError) {
						submissionError = startError;
					}
					// A transport failure can happen after the upstream accepted the
					// deterministic task ID. Observe that ID before reporting failure.
					try {
						terminal = await this.waitForTask(current);
					} catch (monitorError) {
						throw submissionError ?? monitorError;
					}
				} else {
					terminal = await this.waitForTask(current);
				}

				const next = this.nextRouteLeg(current, terminal);
				if (!next) {
					this.completeTaskBinding(current, terminal);
					return;
				}
				current = next;
				shouldSubmit = true;
			}
		} catch (error) {
			if (this.closed && this.taskAbortController.signal.aborted) {
				return;
			}
			const current = this.store.getTaskBinding(binding.instructionId);
			this.store.markTaskBindingFailed(current?.taskId ?? binding.taskId, new Date().toISOString());
			this.store.completeInstruction(binding.instructionId, userFacingFailureReply(error), new Date().toISOString());
			if (error instanceof Error) {
				this.onBackgroundError(error);
			}
			this.scheduleDelivery();
		}
	}

	private waitForTask(binding: StoredTaskBinding) {
		return this.taskMonitor.waitForTerminal(
			binding.task,
			(snapshot) => {
				this.store.recordTaskSnapshot(binding.taskId, snapshot, new Date().toISOString());
			},
			this.taskAbortController.signal,
		);
	}

	private completeTaskBinding(binding: StoredTaskBinding, terminal: MissionTaskSnapshot): void {
		const reply =
			binding.route && terminal.state === "completed"
				? formatCompletedRouteReply(binding.route)
				: formatTerminalTaskReply(terminal);
		this.store.completeInstruction(binding.instructionId, reply, new Date().toISOString());
		this.scheduleDelivery();
	}

	private nextRouteLeg(binding: StoredTaskBinding, terminal: MissionTaskSnapshot): StoredTaskBinding | undefined {
		if (
			terminal.state !== "completed" ||
			!binding.route ||
			binding.routeLegIndex === undefined ||
			binding.routeLegIndex + 1 >= totalRouteLegs(binding.route)
		) {
			return undefined;
		}
		const nextLegIndex = binding.routeLegIndex + 1;
		const nextTask = buildRouteLegTaskSpec(
			{ instructionId: binding.instructionId, text: "" },
			binding.route,
			nextLegIndex,
			new Date(),
		);
		return this.store.advanceRouteBinding(binding.instructionId, nextTask, nextLegIndex, new Date().toISOString());
	}

	private async markCurrentPlace(name: string): Promise<void> {
		const summary = parseJsonObject(await this.mcp.callTool("get_robot_summary", {}), "get_robot_summary");
		const odometry = requireObject(summary.odometry, "get_robot_summary.odometry");
		if (odometry.fresh !== true) {
			throw new Error("Current odometry is not fresh");
		}
		const relocalization =
			summary.relocalization === undefined
				? undefined
				: requireObject(summary.relocalization, "get_robot_summary.relocalization");
		if (relocalization?.required === true && relocalization.ready !== true) {
			throw new Error("Relocalization is required but not ready");
		}
		const poseSource = summary.stable_pose ?? (relocalization?.required === true ? undefined : summary.latest_pose);
		const pose = parseSemanticPose(poseSource);
		const result = parseJsonObject(
			await this.mcp.callTool("confirm_semantic_place", {
				place_json: JSON.stringify({
					name,
					aliases: [],
					pose,
				}),
			}),
			"confirm_semantic_place",
		);
		const confirmedPlace =
			result.place === undefined ? undefined : requireObject(result.place, "confirm_semantic_place.place");
		if (result.accepted !== true || confirmedPlace?.name !== name) {
			throw new Error(
				typeof result.reason === "string" ? result.reason : "Semantic place confirmation was rejected",
			);
		}
	}

	private async validateRoutePlaces(route: VisitRouteParameters): Promise<void> {
		const response = parseJsonObject(await this.mcp.callTool("list_semantic_places", {}), "list_semantic_places");
		if (!isNonEmptyString(response.map_id) || !isNonEmptyString(response.map_version)) {
			throw new Error("Current semantic map identity is unavailable");
		}
		if (!Array.isArray(response.places)) {
			throw new Error("list_semantic_places did not return places");
		}
		const knownLabels = new Set<string>();
		for (const value of response.places) {
			const place = requireObject(value, "list_semantic_places.place");
			if (!isNonEmptyString(place.name)) {
				throw new Error("Semantic place is missing a name");
			}
			knownLabels.add(normalizeLabelKey(place.name));
			if (!Array.isArray(place.aliases)) {
				throw new Error(`Semantic place ${place.name} has invalid aliases`);
			}
			for (const alias of place.aliases) {
				if (!isNonEmptyString(alias)) {
					throw new Error(`Semantic place ${place.name} has an invalid alias`);
				}
				knownLabels.add(normalizeLabelKey(alias));
			}
		}
		const missing = route.waypoints.filter((waypoint) => !knownLabels.has(normalizeLabelKey(waypoint)));
		if (missing.length > 0) {
			throw new Error(`Route contains unconfirmed places: ${[...new Set(missing)].join(", ")}`);
		}
	}

	private scheduleStopDrain(): void {
		if (this.closed || this.stopDrainPromise) {
			return;
		}
		this.stopDrainPromise = Promise.resolve()
			.then(async () => {
				while (!this.closed) {
					const instruction = this.store.claimNextStopInstruction();
					if (!instruction) {
						return;
					}
					let replyText = FAILURE_REPLY_TEXT;
					try {
						const command = parsePriorityCommand(instruction.text);
						if (!command) {
							throw new Error("Priority instruction no longer matches a supported command");
						}
						replyText = await this.executePriorityCommand(command);
					} catch (error) {
						replyText = userFacingFailureReply(error);
					}
					this.store.completeInstruction(instruction.instructionId, replyText, new Date().toISOString());
					this.scheduleDelivery();
				}
			})
			.catch(this.onBackgroundError)
			.finally(() => {
				this.stopDrainPromise = undefined;
				if (!this.closed && this.store.hasPendingStopInstruction()) {
					this.scheduleStopDrain();
				}
			});
	}

	private async executePriorityCommand(command: PriorityCommand): Promise<string> {
		if (command.kind === "stop_all") {
			ensureToolSucceeded(await this.mcp.callTool("stop_all", {}), "stop_all");
			return STOP_ACCEPTED_REPLY_TEXT;
		}
		if (command.kind === "manual_move") {
			ensureToolSucceeded(await this.mcp.callTool("stop_all", {}), "stop_all");
			ensureToolSucceeded(await this.mcp.callTool("relative_move", command.arguments_), "relative_move");
			return command.reply;
		}
		if (command.kind === "get_robot_status") {
			const [taskRaw, robotRaw, placesRaw] = await Promise.all([
				this.mcp.callTool("get_task_status", {}),
				this.mcp.callTool("get_robot_summary", {}),
				this.mcp.callTool("list_semantic_places", {}),
			]);
			return formatRobotStatus(taskRaw, robotRaw, placesRaw);
		}

		const binding = this.store.nextRecoverableTaskBinding();
		if (!binding) {
			return "当前没有可控制的任务。";
		}
		const toolName = command.kind;
		ensureToolSucceeded(await this.mcp.callTool(toolName, { task_id: binding.taskId }), toolName);
		if (command.kind === "pause_task") {
			return `已请求暂停任务“${binding.task.destination}”。`;
		}
		if (command.kind === "resume_task") {
			return `已请求继续任务“${binding.task.destination}”。`;
		}
		return `已请求取消任务“${binding.task.destination}”。`;
	}

	private scheduleDelivery(): void {
		if (this.closed || this.deliveryPromise) {
			return;
		}
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		this.deliveryPromise = Promise.resolve()
			.then(async () => {
				while (!this.closed) {
					const pending = this.store.nextDueReply(Date.now());
					if (!pending) {
						return;
					}
					try {
						await this.replyClient.deliver(pending.event);
						this.store.markReplyDelivered(pending.event.reply_id, new Date().toISOString());
					} catch {
						const retryDelay = Math.min(this.retryBaseMs * 2 ** pending.attempts, this.retryMaxMs);
						const retryAt = Date.now() + retryDelay;
						this.store.markReplyFailed(pending.event.reply_id, retryAt);
						return;
					}
				}
			})
			.catch(this.onBackgroundError)
			.finally(() => {
				this.deliveryPromise = undefined;
				this.scheduleNextDeliveryWakeup();
			});
	}

	private scheduleNextDeliveryWakeup(): void {
		if (this.closed || this.deliveryPromise || this.retryTimer) {
			return;
		}
		const nextAttemptAtMs = this.store.nextUndeliveredAttemptAtMs();
		if (nextAttemptAtMs === undefined) {
			return;
		}
		const delayMs = Math.max(0, nextAttemptAtMs - Date.now());
		if (delayMs === 0) {
			this.scheduleDelivery();
			return;
		}
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.scheduleDelivery();
		}, delayMs);
		this.retryTimer.unref();
	}

	async close(): Promise<void> {
		this.closed = true;
		this.taskAbortController.abort(new Error("Agent webhook service is closing"));
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		await Promise.all([this.agentDrainPromise, this.stopDrainPromise, this.deliveryPromise]);
		await this.agent?.close?.();
		await this.taskCompiler?.close?.();
		this.store.close();
	}
}

export function isStopPhrase(text: string): boolean {
	const command = stripPoliteCommandFraming(normalizeExactCommand(text));
	return /^(?:(?:马上|立即|立刻)\s*)?(?:停|停下|停下来|停止|停止移动|停止任务|别动|不要动|stop|stop now)$/u.test(
		command,
	);
}

function parsePriorityCommand(text: string): PriorityCommand | undefined {
	if (isStopPhrase(text)) {
		return { kind: "stop_all" };
	}
	const normalized = stripPoliteCommandFraming(normalizeExactCommand(text));
	const exactCommands: Readonly<Record<string, PriorityCommand>> = {
		暂停: { kind: "pause_task" },
		暂停任务: { kind: "pause_task" },
		pause: { kind: "pause_task" },
		继续: { kind: "resume_task" },
		继续任务: { kind: "resume_task" },
		resume: { kind: "resume_task" },
		取消任务: { kind: "cancel_task" },
		cancel: { kind: "cancel_task" },
		状态: { kind: "get_robot_status" },
		机器人状态: { kind: "get_robot_status" },
		任务状态: { kind: "get_robot_status" },
		查看状态: { kind: "get_robot_status" },
		查询状态: { kind: "get_robot_status" },
		现在什么状态: { kind: "get_robot_status" },
		status: { kind: "get_robot_status" },
		前进: {
			kind: "manual_move",
			reply: "已提交前进一步指令。",
			arguments_: { forward: 0.2, left: 0, degrees: 0 },
		},
		向前: {
			kind: "manual_move",
			reply: "已提交前进一步指令。",
			arguments_: { forward: 0.2, left: 0, degrees: 0 },
		},
		forward: {
			kind: "manual_move",
			reply: "已提交前进一步指令。",
			arguments_: { forward: 0.2, left: 0, degrees: 0 },
		},
		后退: {
			kind: "manual_move",
			reply: "已提交后退一步指令。",
			arguments_: { forward: -0.2, left: 0, degrees: 0 },
		},
		向后: {
			kind: "manual_move",
			reply: "已提交后退一步指令。",
			arguments_: { forward: -0.2, left: 0, degrees: 0 },
		},
		backward: {
			kind: "manual_move",
			reply: "已提交后退一步指令。",
			arguments_: { forward: -0.2, left: 0, degrees: 0 },
		},
		左移: {
			kind: "manual_move",
			reply: "已提交向左一步指令。",
			arguments_: { forward: 0, left: 0.2, degrees: 0 },
		},
		向左: {
			kind: "manual_move",
			reply: "已提交向左一步指令。",
			arguments_: { forward: 0, left: 0.2, degrees: 0 },
		},
		右移: {
			kind: "manual_move",
			reply: "已提交向右一步指令。",
			arguments_: { forward: 0, left: -0.2, degrees: 0 },
		},
		向右: {
			kind: "manual_move",
			reply: "已提交向右一步指令。",
			arguments_: { forward: 0, left: -0.2, degrees: 0 },
		},
		左转: {
			kind: "manual_move",
			reply: "已提交向左转动指令。",
			arguments_: { forward: 0, left: 0, degrees: 15 },
		},
		右转: {
			kind: "manual_move",
			reply: "已提交向右转动指令。",
			arguments_: { forward: 0, left: 0, degrees: -15 },
		},
	};
	const exactCommand = exactCommands[normalized];
	if (exactCommand) {
		return exactCommand;
	}
	if (/^(?:向前走|往前走|朝前走|向前移动|往前移动|朝前移动|move forward)$/u.test(normalized)) {
		return exactCommands.前进;
	}
	if (/^(?:向后走|往后走|退后|向后移动|往后移动|move backward)$/u.test(normalized)) {
		return exactCommands.后退;
	}
	if (/^(?:向左走|往左走|向左移动|往左移动|move left)$/u.test(normalized)) {
		return exactCommands.左移;
	}
	if (/^(?:向右走|往右走|向右移动|往右移动|move right)$/u.test(normalized)) {
		return exactCommands.右移;
	}
	if (/^(?:向左转|往左转|turn left)$/u.test(normalized)) {
		return exactCommands.左转;
	}
	if (/^(?:向右转|往右转|turn right)$/u.test(normalized)) {
		return exactCommands.右转;
	}
	return undefined;
}

function normalizeExactCommand(text: string): string {
	return text
		.normalize("NFKC")
		.trim()
		.replace(/[。.！!?？]+$/u, "")
		.trim()
		.toLowerCase();
}

function stripPoliteCommandFraming(text: string): string {
	let command = text;
	const prefix =
		/^(?:请帮我|麻烦你|请你|帮我|麻烦|请|让机器狗|让机器人|让狗狗|让狗子|机器狗|机器人|狗狗|狗子)[，,\s]*/u;
	const suffix = /[，,\s]*(?:可以吗|好吗|谢谢|一下|一步|吧)$/u;
	for (let index = 0; index < 3; index++) {
		const stripped = command.replace(prefix, "").replace(suffix, "").trim();
		if (stripped === command) {
			break;
		}
		command = stripped;
	}
	return command;
}

function userFacingFailureReply(error: unknown): string {
	const message = errorMessageWithCause(error);
	if (/movement is disabled|blocked move command/iu.test(message)) {
		return "机器人运动未启用：请先在唯一 DimOS Runtime 中启用运动。";
	}
	if (error instanceof McpCallError) {
		if (error.kind === "unavailable") {
			return "控制链未连接：请先启动唯一 DimOS Runtime 和 MCP Wrapper。";
		}
		if (error.kind === "timeout") {
			return "控制链响应超时：执行结果未确认，请先检查 Runtime 状态，不要重复发送同一动作。";
		}
		if (error.kind === "protocol") {
			return "控制链协议异常：请确认 Runtime 与 MCP Wrapper 使用同一 product 工具版本。";
		}
		return "DimOS Runtime 拒绝了该动作，机器人没有开始执行。";
	}
	if (/\b(?:fetch failed|econnrefused|enotfound|ehostunreach|network is unreachable)\b/iu.test(message)) {
		return "控制链未连接：请先启动唯一 DimOS Runtime 和 MCP Wrapper。";
	}
	if (/\b(?:timeout|timed out|aborted due to timeout)\b/iu.test(message)) {
		return "控制链响应超时：执行结果未确认，请先检查 Runtime 状态，不要重复发送同一动作。";
	}
	if (
		/agent supports only|parameters must contain only|parameters must be valid json|task compiler is unavailable/iu.test(
			message,
		)
	) {
		return "未执行：我没有理解这条指令。可以说“往前走”“停下来”“去客厅”或“把这里标记为门口”。";
	}
	return FAILURE_REPLY_TEXT;
}

function errorMessageWithCause(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const cause = "cause" in error ? error.cause : undefined;
	return cause === undefined ? `${error.name}: ${error.message}` : `${error.name}: ${error.message}; ${String(cause)}`;
}

function formatCompletedRouteReply(route: VisitRouteParameters): string {
	return `路线任务已完成：${route.waypoints.join(" → ")}，共 ${route.repeat_count} 轮。`;
}

function parseSemanticPose(value: unknown): {
	frame_id: string;
	ts: number;
	x: number;
	y: number;
	z: number;
	qx: number;
	qy: number;
	qz: number;
	qw: number;
} {
	const pose = requireObject(value, "get_robot_summary pose");
	if (!isNonEmptyString(pose.frame_id)) {
		throw new Error("Robot pose has no frame_id");
	}
	const timestamp = pose.ts ?? pose.source_ts;
	return {
		frame_id: pose.frame_id.trim(),
		ts: requireFiniteNumber(timestamp, "pose timestamp"),
		x: requireFiniteNumber(pose.x, "pose.x"),
		y: requireFiniteNumber(pose.y, "pose.y"),
		z: requireFiniteNumber(pose.z, "pose.z"),
		qx: requireFiniteNumber(pose.qx, "pose.qx"),
		qy: requireFiniteNumber(pose.qy, "pose.qy"),
		qz: requireFiniteNumber(pose.qz, "pose.qz"),
		qw: requireFiniteNumber(pose.qw, "pose.qw"),
	};
}

function formatRobotStatus(taskRaw: string, robotRaw: string, placesRaw: string): string {
	const task = parseJsonObject(taskRaw, "get_task_status");
	const robot = parseJsonObject(robotRaw, "get_robot_summary");
	const places = parseJsonObject(placesRaw, "list_semantic_places");
	const odometry =
		robot.odometry === undefined ? undefined : requireObject(robot.odometry, "get_robot_summary.odometry");
	const taskState = isNonEmptyString(task.state) ? task.state : "未知";
	const taskActivity = task.active === true ? "执行中" : "未运行";
	const robotStatus = isNonEmptyString(robot.status) ? robot.status : "未知";
	const odometryStatus = odometry?.fresh === true ? "fresh" : "不可用或过期";
	const placeCount = Array.isArray(places.places) ? places.places.length : 0;
	return `机器人：${robotStatus}；里程计：${odometryStatus}；任务：${taskState}（${taskActivity}）；已标记地点：${placeCount} 个。`;
}

function ensureToolSucceeded(raw: string, toolName: string): void {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		if (/\b(error|failed|rejected|timed out|cancelled)\b/iu.test(raw)) {
			throw new Error(`${toolName} failed: ${raw}`);
		}
		return;
	}
	if (!isObject(value)) {
		return;
	}
	if (value.accepted === false || value.status === "error" || value.status === "failed") {
		throw new Error(`${toolName} failed: ${typeof value.reason === "string" ? value.reason : raw}`);
	}
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(`${label} returned invalid JSON`);
	}
	return requireObject(value, label);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
	if (!isObject(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number`);
	}
	return value;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function normalizeLabelKey(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
