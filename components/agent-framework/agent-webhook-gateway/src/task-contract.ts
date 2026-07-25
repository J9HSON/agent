import { createHash } from "node:crypto";
import type { ExternalInstruction } from "./types.ts";

export const TASK_STATES = [
	"queued",
	"resolving",
	"exploring",
	"navigating",
	"recovering",
	"verifying",
	"following",
	"paused",
	"completed",
	"failed",
	"cancelled",
] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type TerminalTaskState = Extract<TaskState, "completed" | "failed" | "cancelled">;

export interface VisitRouteParameters {
	kind: "visit_route";
	waypoints: string[];
	repeat_count: number;
}

export type CompiledTaskParameters =
	| {
			kind: "go_to_place";
			destination: string;
	  }
	| {
			kind: "mark_place";
			name: string;
	  }
	| VisitRouteParameters
	| {
			kind: "follow_person";
	  };

export interface TaskParameterCompiler {
	compile(text: string): Promise<CompiledTaskParameters>;
	close?(): Promise<void> | void;
}

export interface MissionTaskSpec {
	task_id: string;
	kind: "go_to_place";
	destination: string;
	target_description: null;
	question: null;
	priority: "normal";
	created_at: string;
}

export interface MissionTaskResult {
	summary: string;
	evidence_ids: string[];
}

export interface MissionTaskSnapshot {
	task: MissionTaskSpec;
	state: TaskState;
	active: boolean;
	result?: MissionTaskResult;
	terminal_reason?: string;
	resume_state?: TaskState;
	updated_at?: string;
	navigation_idle?: boolean;
}

export function parseCompiledTaskParameters(raw: string): CompiledTaskParameters {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("Agent task parameters must be one JSON object");
	}
	if (!isObject(value)) {
		throw new Error("Agent task parameters must be one JSON object");
	}
	const keys = Object.keys(value).sort();
	if (value.kind === "follow_person") {
		if (keys.length !== 1 || keys[0] !== "kind") {
			throw new Error("follow_person parameters must contain only kind");
		}
		return { kind: "follow_person" };
	}
	if (value.kind === "mark_place") {
		if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "name") {
			throw new Error("mark_place parameters must contain only kind and name");
		}
		return {
			kind: "mark_place",
			name: normalizeLabel(value.name, "name"),
		};
	}
	if (value.kind === "visit_route") {
		if (keys.length !== 3 || keys[0] !== "kind" || keys[1] !== "repeat_count" || keys[2] !== "waypoints") {
			throw new Error("visit_route parameters must contain only kind, waypoints, and repeat_count");
		}
		if (!Array.isArray(value.waypoints) || value.waypoints.length < 2 || value.waypoints.length > 20) {
			throw new Error("waypoints must contain 2 to 20 place names");
		}
		if (
			typeof value.repeat_count !== "number" ||
			!Number.isInteger(value.repeat_count) ||
			value.repeat_count < 1 ||
			value.repeat_count > 20
		) {
			throw new Error("repeat_count must be an integer from 1 to 20");
		}
		return {
			kind: "visit_route",
			waypoints: value.waypoints.map((waypoint) => normalizeLabel(waypoint, "waypoint")),
			repeat_count: value.repeat_count,
		};
	}
	if (value.kind !== "go_to_place") {
		throw new Error("Agent supports only go_to_place, mark_place, visit_route, or follow_person");
	}
	if (keys.length !== 2 || keys[0] !== "destination" || keys[1] !== "kind") {
		throw new Error("go_to_place parameters must contain only kind and destination");
	}
	return {
		kind: "go_to_place",
		destination: normalizeLabel(value.destination, "destination"),
	};
}

export function taskIdForInstruction(instructionId: string): string {
	const digest = createHash("sha256").update(instructionId, "utf8").digest("hex");
	return `task-${digest.slice(0, 32)}`;
}

export function taskIdForRouteLeg(instructionId: string, legIndex: number): string {
	if (!Number.isInteger(legIndex) || legIndex < 0) {
		throw new Error("Route leg index must be a non-negative integer");
	}
	const digest = createHash("sha256").update(`${instructionId}\u0000${legIndex}`, "utf8").digest("hex");
	return `task-${digest.slice(0, 32)}`;
}

export function totalRouteLegs(route: VisitRouteParameters): number {
	return route.waypoints.length * route.repeat_count;
}

export function buildTaskSpec(
	instruction: ExternalInstruction,
	parameters: Extract<CompiledTaskParameters, { kind: "go_to_place" }>,
	createdAt: Date = new Date(),
): MissionTaskSpec {
	return buildGoToPlaceTaskSpec(taskIdForInstruction(instruction.instructionId), parameters.destination, createdAt);
}

export function buildRouteLegTaskSpec(
	instruction: ExternalInstruction,
	route: VisitRouteParameters,
	legIndex: number,
	createdAt: Date = new Date(),
): MissionTaskSpec {
	const totalLegs = totalRouteLegs(route);
	if (!Number.isInteger(legIndex) || legIndex < 0 || legIndex >= totalLegs) {
		throw new Error(`Route leg index must be from 0 to ${totalLegs - 1}`);
	}
	return buildGoToPlaceTaskSpec(
		taskIdForRouteLeg(instruction.instructionId, legIndex),
		route.waypoints[legIndex % route.waypoints.length] ?? "",
		createdAt,
	);
}

function buildGoToPlaceTaskSpec(taskId: string, destination: string, createdAt: Date): MissionTaskSpec {
	if (!Number.isFinite(createdAt.getTime())) {
		throw new Error("Task creation time must be valid");
	}
	const common = {
		task_id: taskId,
		question: null,
		priority: "normal",
		created_at: createdAt.toISOString(),
	} as const;
	return {
		...common,
		kind: "go_to_place",
		destination,
		target_description: null,
	};
}

export function parseTaskSnapshot(raw: string): MissionTaskSnapshot {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("get_task_status returned invalid JSON");
	}
	if (!isObject(value)) {
		throw new Error("get_task_status returned a non-object");
	}
	if (value.state === "idle" && value.active === false && value.task === undefined) {
		throw new Error("MissionExecutor does not know the expected task");
	}
	if (!isObject(value.task)) {
		throw new Error("get_task_status did not include a task");
	}
	const task = parseTaskSpec(value.task);
	if (!isTaskState(value.state)) {
		throw new Error("get_task_status returned an invalid task state");
	}
	if (typeof value.active !== "boolean") {
		throw new Error("get_task_status did not include boolean active");
	}

	const snapshot: MissionTaskSnapshot = {
		task,
		state: value.state,
		active: value.active,
	};
	if (value.result !== null && value.result !== undefined) {
		snapshot.result = parseTaskResult(value.result);
	}
	if (value.terminal_reason !== null && value.terminal_reason !== undefined) {
		if (typeof value.terminal_reason !== "string" || !value.terminal_reason.trim()) {
			throw new Error("terminal_reason must be a non-empty string");
		}
		snapshot.terminal_reason = value.terminal_reason;
	}
	if (value.resume_state !== null && value.resume_state !== undefined) {
		if (!isTaskState(value.resume_state)) {
			throw new Error("resume_state must be a known task state");
		}
		snapshot.resume_state = value.resume_state;
	}
	if (value.updated_at !== undefined) {
		if (typeof value.updated_at !== "string" || Number.isNaN(Date.parse(value.updated_at))) {
			throw new Error("updated_at must be an ISO timestamp");
		}
		snapshot.updated_at = value.updated_at;
	}
	if (value.navigation_idle !== undefined) {
		if (typeof value.navigation_idle !== "boolean") {
			throw new Error("navigation_idle must be boolean");
		}
		snapshot.navigation_idle = value.navigation_idle;
	}
	validateTerminalPayload(snapshot);
	return snapshot;
}

export function isTerminalTaskState(state: TaskState): state is TerminalTaskState {
	return state === "completed" || state === "failed" || state === "cancelled";
}

export function formatTerminalTaskReply(snapshot: MissionTaskSnapshot): string {
	if (!isTerminalTaskState(snapshot.state) || snapshot.active) {
		throw new Error("Cannot format a reply before the task is terminal and inactive");
	}
	if (snapshot.state === "completed") {
		return `任务已完成：已到达“${snapshot.task.destination}”。`;
	}
	if (snapshot.state === "cancelled") {
		return `任务已取消：${snapshot.terminal_reason ?? "任务已停止"}。`;
	}
	return `任务未完成：${snapshot.terminal_reason ?? "执行失败"}。`;
}

function parseTaskSpec(value: Record<string, unknown>): MissionTaskSpec {
	const requiredKeys = ["created_at", "destination", "kind", "priority", "question", "target_description", "task_id"];
	if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(requiredKeys)) {
		throw new Error("TaskSpec fields do not match the Stage 2 contract");
	}
	if (typeof value.task_id !== "string" || !value.task_id.match(/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u)) {
		throw new Error("TaskSpec contains an invalid task_id");
	}
	if (typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
		throw new Error("TaskSpec contains an invalid created_at");
	}
	if (value.kind !== "go_to_place") {
		throw new Error("TaskSpec kind is not supported in Stage 2");
	}
	if (typeof value.destination !== "string" || !value.destination.trim() || value.destination.length > 200) {
		throw new Error("TaskSpec contains an invalid destination");
	}
	if (value.target_description !== null || value.question !== null || value.priority !== "normal") {
		throw new Error("TaskSpec contains invalid go_to_place fields");
	}
	return {
		task_id: value.task_id,
		kind: "go_to_place",
		destination: value.destination.trim(),
		target_description: null,
		question: null,
		priority: "normal",
		created_at: value.created_at,
	};
}

function parseTaskResult(value: unknown): MissionTaskResult {
	if (!isObject(value)) {
		throw new Error("Task result must be an object");
	}
	if (
		typeof value.summary !== "string" ||
		!value.summary.trim() ||
		!Array.isArray(value.evidence_ids) ||
		value.evidence_ids.length === 0 ||
		!value.evidence_ids.every((evidenceId) => typeof evidenceId === "string" && evidenceId.length > 0)
	) {
		throw new Error("Task result is missing summary or evidence");
	}
	return {
		summary: value.summary,
		evidence_ids: [...value.evidence_ids],
	};
}

function validateTerminalPayload(snapshot: MissionTaskSnapshot): void {
	if (snapshot.state === "completed" && !snapshot.result) {
		throw new Error("completed task status requires result evidence");
	}
	if ((snapshot.state === "failed" || snapshot.state === "cancelled") && !snapshot.terminal_reason) {
		throw new Error(`${snapshot.state} task status requires terminal_reason`);
	}
}

function isTaskState(value: unknown): value is TaskState {
	return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLabel(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new Error(`${field} must be a string`);
	}
	const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
	if (!normalized || normalized.length > 200) {
		throw new Error(`${field} must contain 1 to 200 characters`);
	}
	return normalized;
}
