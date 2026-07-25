import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type MissionTaskSnapshot,
	type MissionTaskSpec,
	type TaskState,
	totalRouteLegs,
	type VisitRouteParameters,
} from "./task-contract.ts";
import type { AgentReplyEvent, ExternalInstruction } from "./types.ts";

type InstructionRow = {
	instruction_id: string;
	text: string;
	is_stop: number;
};

type InstructionViewRow = {
	instruction_id: string;
	text: string;
	status: InstructionLifecycleStatus;
	received_at: string;
};

type OutboxRow = {
	reply_id: string;
	instruction_id: string;
	text: string;
	completed_at: string;
	attempts: number;
};

type TaskBindingRow = {
	instruction_id: string;
	task_id: string;
	task_json: string;
	compile_status: TaskBindingStatus;
	last_state: string | null;
	last_snapshot_json: string | null;
	route_json: string | null;
	route_leg_index: number | null;
	created_at: string;
	updated_at: string;
};

export type TaskBindingStatus = "compiled" | "submitted" | "monitoring" | "terminal" | "failed";
export type InstructionLifecycleStatus = "pending" | "processing" | "completed";

export interface StoredTaskBinding {
	instructionId: string;
	taskId: string;
	task: MissionTaskSpec;
	compileStatus: TaskBindingStatus;
	lastState?: TaskState;
	lastSnapshot?: MissionTaskSnapshot;
	route?: VisitRouteParameters;
	routeLegIndex?: number;
	createdAt: string;
	updatedAt: string;
}

export interface StoredInstructionView {
	instructionId: string;
	text: string;
	status: InstructionLifecycleStatus;
	receivedAt: string;
	task?: StoredTaskBinding;
	reply?: AgentReplyEvent;
}

export type AcceptInstructionResult = "accepted" | "duplicate" | "conflict";
export interface PendingReply {
	event: AgentReplyEvent;
	attempts: number;
}

export class GatewayStore {
	private readonly database: DatabaseSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.database = new DatabaseSync(path);
		this.database.exec("PRAGMA journal_mode = WAL");
		this.database.exec("PRAGMA foreign_keys = ON");
		this.database.exec("PRAGMA busy_timeout = 5000");
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS instructions (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				instruction_id TEXT NOT NULL UNIQUE,
				text TEXT NOT NULL,
				is_stop INTEGER NOT NULL CHECK (is_stop IN (0, 1)),
				status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed')),
				received_at TEXT NOT NULL
			);
				CREATE TABLE IF NOT EXISTS outbox (
				reply_id TEXT PRIMARY KEY,
				instruction_id TEXT NOT NULL UNIQUE REFERENCES instructions(instruction_id),
				text TEXT NOT NULL,
				completed_at TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
					delivered_at TEXT
				);
			CREATE TABLE IF NOT EXISTS instruction_task_bindings (
				instruction_id TEXT PRIMARY KEY REFERENCES instructions(instruction_id),
				task_id TEXT NOT NULL UNIQUE,
				task_json TEXT NOT NULL,
				compile_status TEXT NOT NULL CHECK (
					compile_status IN ('compiled', 'submitted', 'monitoring', 'terminal', 'failed')
				),
				last_state TEXT,
				last_snapshot_json TEXT,
				route_json TEXT,
				route_leg_index INTEGER CHECK (route_leg_index IS NULL OR route_leg_index >= 0),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			`);
		this.ensureTaskBindingColumn("route_json", "TEXT");
		this.ensureTaskBindingColumn(
			"route_leg_index",
			"INTEGER CHECK (route_leg_index IS NULL OR route_leg_index >= 0)",
		);
	}

	acceptInstruction(instruction: ExternalInstruction, isStop: boolean, receivedAt: string): AcceptInstructionResult {
		const existing = this.database
			.prepare("SELECT text FROM instructions WHERE instruction_id = ?")
			.get(instruction.instructionId) as { text: string } | undefined;
		if (existing) {
			return existing.text === instruction.text ? "duplicate" : "conflict";
		}

		this.database
			.prepare(
				`INSERT INTO instructions (instruction_id, text, is_stop, status, received_at)
				 VALUES (?, ?, ?, 'pending', ?)`,
			)
			.run(instruction.instructionId, instruction.text, isStop ? 1 : 0, receivedAt);
		return "accepted";
	}

	claimNextNormalInstruction(): ExternalInstruction | undefined {
		return this.claimNext("is_stop = 0");
	}

	claimNextStopInstruction(): ExternalInstruction | undefined {
		return this.claimNext("is_stop = 1");
	}

	private claimNext(filter: string): ExternalInstruction | undefined {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const row = this.database
				.prepare(
					`SELECT instruction_id, text, is_stop
					 FROM instructions
					 WHERE status = 'pending' AND ${filter}
					 ORDER BY sequence
					 LIMIT 1`,
				)
				.get() as InstructionRow | undefined;
			if (!row) {
				this.database.exec("COMMIT");
				return undefined;
			}
			this.database
				.prepare("UPDATE instructions SET status = 'processing' WHERE instruction_id = ? AND status = 'pending'")
				.run(row.instruction_id);
			this.database.exec("COMMIT");
			return { instructionId: row.instruction_id, text: row.text };
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	completeInstruction(instructionId: string, text: string, completedAt: string): AgentReplyEvent {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.database
				.prepare(
					`SELECT reply_id, instruction_id, text, completed_at, attempts
					 FROM outbox
					 WHERE instruction_id = ?`,
				)
				.get(instructionId) as OutboxRow | undefined;
			if (existing) {
				this.database.exec("COMMIT");
				return this.toReplyEvent(existing);
			}

			const replyId = randomUUID();
			this.database
				.prepare(
					`INSERT INTO outbox (reply_id, instruction_id, text, completed_at)
					 VALUES (?, ?, ?, ?)`,
				)
				.run(replyId, instructionId, text, completedAt);
			this.database
				.prepare("UPDATE instructions SET status = 'completed' WHERE instruction_id = ?")
				.run(instructionId);
			this.database.exec("COMMIT");
			return {
				event: "agent.reply.completed",
				reply_id: replyId,
				instruction_id: instructionId,
				text,
				completed_at: completedAt,
			};
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	createTaskBinding(instructionId: string, task: MissionTaskSpec, createdAt: string): StoredTaskBinding {
		const taskJson = JSON.stringify(task);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const instruction = this.database
				.prepare("SELECT status FROM instructions WHERE instruction_id = ?")
				.get(instructionId) as { status: string } | undefined;
			if (!instruction) {
				throw new Error(`Unknown instruction_id ${instructionId}`);
			}
			if (instruction.status !== "processing") {
				throw new Error(`Instruction ${instructionId} is not in processing state`);
			}
			const existing = this.readTaskBindingRow(instructionId);
			if (existing) {
				if (existing.task_id !== task.task_id || existing.task_json !== taskJson) {
					throw new Error(`Instruction ${instructionId} is already bound to another task`);
				}
				this.database.exec("COMMIT");
				return this.toTaskBinding(existing);
			}
			this.database
				.prepare(
					`INSERT INTO instruction_task_bindings (
						instruction_id, task_id, task_json, compile_status,
						created_at, updated_at
					) VALUES (?, ?, ?, 'compiled', ?, ?)`,
				)
				.run(instructionId, task.task_id, taskJson, createdAt, createdAt);
			const created = this.readTaskBindingRow(instructionId);
			if (!created) {
				throw new Error("Task binding insert did not persist");
			}
			this.database.exec("COMMIT");
			return this.toTaskBinding(created);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	createRouteBinding(
		instructionId: string,
		route: VisitRouteParameters,
		task: MissionTaskSpec,
		createdAt: string,
	): StoredTaskBinding {
		const taskJson = JSON.stringify(task);
		const routeJson = JSON.stringify(route);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const instruction = this.database
				.prepare("SELECT status FROM instructions WHERE instruction_id = ?")
				.get(instructionId) as { status: string } | undefined;
			if (!instruction) {
				throw new Error(`Unknown instruction_id ${instructionId}`);
			}
			if (instruction.status !== "processing") {
				throw new Error(`Instruction ${instructionId} is not in processing state`);
			}
			const existing = this.readTaskBindingRow(instructionId);
			if (existing) {
				if (
					existing.task_id !== task.task_id ||
					existing.task_json !== taskJson ||
					existing.route_json !== routeJson ||
					existing.route_leg_index !== 0
				) {
					throw new Error(`Instruction ${instructionId} is already bound to another task or route`);
				}
				this.database.exec("COMMIT");
				return this.toTaskBinding(existing);
			}
			this.database
				.prepare(
					`INSERT INTO instruction_task_bindings (
						instruction_id, task_id, task_json, compile_status,
						route_json, route_leg_index, created_at, updated_at
					) VALUES (?, ?, ?, 'compiled', ?, 0, ?, ?)`,
				)
				.run(instructionId, task.task_id, taskJson, routeJson, createdAt, createdAt);
			const created = this.readTaskBindingRow(instructionId);
			if (!created) {
				throw new Error("Route binding insert did not persist");
			}
			this.database.exec("COMMIT");
			return this.toTaskBinding(created);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	advanceRouteBinding(
		instructionId: string,
		task: MissionTaskSpec,
		legIndex: number,
		updatedAt: string,
	): StoredTaskBinding {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.readTaskBindingRow(instructionId);
			if (!existing || !existing.route_json || existing.route_leg_index === null) {
				throw new Error(`Instruction ${instructionId} has no route binding`);
			}
			const route = JSON.parse(existing.route_json) as VisitRouteParameters;
			if (
				!Number.isInteger(legIndex) ||
				legIndex !== existing.route_leg_index + 1 ||
				legIndex >= totalRouteLegs(route)
			) {
				throw new Error(`Route ${instructionId} cannot advance to leg ${legIndex}`);
			}
			const result = this.database
				.prepare(
					`UPDATE instruction_task_bindings
					 SET task_id = ?, task_json = ?, compile_status = 'compiled',
						 last_state = NULL, last_snapshot_json = NULL,
						 route_leg_index = ?, updated_at = ?
					 WHERE instruction_id = ? AND task_id = ?`,
				)
				.run(task.task_id, JSON.stringify(task), legIndex, updatedAt, instructionId, existing.task_id);
			if (result.changes !== 1) {
				throw new Error(`Route ${instructionId} changed while advancing`);
			}
			const updated = this.readTaskBindingRow(instructionId);
			if (!updated) {
				throw new Error("Advanced route binding disappeared");
			}
			this.database.exec("COMMIT");
			return this.toTaskBinding(updated);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	markTaskSubmitted(taskId: string, updatedAt: string): void {
		this.updateTaskBindingStatus(taskId, "submitted", updatedAt);
	}

	recordTaskSnapshot(taskId: string, snapshot: MissionTaskSnapshot, updatedAt: string): void {
		const status: TaskBindingStatus =
			!snapshot.active &&
			(snapshot.state === "completed" || snapshot.state === "failed" || snapshot.state === "cancelled")
				? "terminal"
				: "monitoring";
		const result = this.database
			.prepare(
				`UPDATE instruction_task_bindings
				 SET compile_status = ?, last_state = ?, last_snapshot_json = ?,
					 updated_at = ?
				 WHERE task_id = ?`,
			)
			.run(status, snapshot.state, JSON.stringify(snapshot), updatedAt, taskId);
		if (result.changes !== 1) {
			throw new Error(`Unknown task_id ${taskId}`);
		}
	}

	markTaskBindingFailed(taskId: string, updatedAt: string): void {
		this.updateTaskBindingStatus(taskId, "failed", updatedAt);
	}

	getTaskBinding(instructionId: string): StoredTaskBinding | undefined {
		const row = this.readTaskBindingRow(instructionId);
		return row ? this.toTaskBinding(row) : undefined;
	}

	getInstructionView(instructionId: string): StoredInstructionView | undefined {
		const instruction = this.database
			.prepare(
				`SELECT instruction_id, text, status, received_at
				 FROM instructions
				 WHERE instruction_id = ?`,
			)
			.get(instructionId) as InstructionViewRow | undefined;
		if (!instruction) {
			return undefined;
		}
		const reply = this.database
			.prepare(
				`SELECT reply_id, instruction_id, text, completed_at, attempts
				 FROM outbox
				 WHERE instruction_id = ?`,
			)
			.get(instructionId) as OutboxRow | undefined;
		const task = this.readTaskBindingRow(instructionId);
		return {
			instructionId: instruction.instruction_id,
			text: instruction.text,
			status: instruction.status,
			receivedAt: instruction.received_at,
			task: task ? this.toTaskBinding(task) : undefined,
			reply: reply ? this.toReplyEvent(reply) : undefined,
		};
	}

	nextRecoverableTaskBinding(): StoredTaskBinding | undefined {
		const row = this.database
			.prepare(
				`SELECT b.instruction_id, b.task_id, b.task_json, b.compile_status,
						b.last_state, b.last_snapshot_json, b.route_json,
						b.route_leg_index, b.created_at, b.updated_at
				 FROM instruction_task_bindings AS b
				 JOIN instructions AS i ON i.instruction_id = b.instruction_id
				 WHERE i.status = 'processing'
				   AND b.compile_status IN ('compiled', 'submitted', 'monitoring')
				 ORDER BY i.sequence
				 LIMIT 1`,
			)
			.get() as TaskBindingRow | undefined;
		return row ? this.toTaskBinding(row) : undefined;
	}

	nextDueReply(nowMs: number): PendingReply | undefined {
		const row = this.database
			.prepare(
				`SELECT reply_id, instruction_id, text, completed_at, attempts
				 FROM outbox
				 WHERE delivered_at IS NULL AND next_attempt_at_ms <= ?
				 ORDER BY completed_at, reply_id
				 LIMIT 1`,
			)
			.get(nowMs) as OutboxRow | undefined;
		return row ? { event: this.toReplyEvent(row), attempts: row.attempts } : undefined;
	}

	nextUndeliveredAttemptAtMs(): number | undefined {
		const row = this.database
			.prepare(
				`SELECT MIN(next_attempt_at_ms) AS next_attempt_at_ms
				 FROM outbox
				 WHERE delivered_at IS NULL`,
			)
			.get() as { next_attempt_at_ms: number | null };
		return row.next_attempt_at_ms ?? undefined;
	}

	markReplyDelivered(replyId: string, deliveredAt: string): void {
		this.database.prepare("UPDATE outbox SET delivered_at = ? WHERE reply_id = ?").run(deliveredAt, replyId);
	}

	markReplyFailed(replyId: string, nextAttemptAtMs: number): void {
		this.database
			.prepare(
				`UPDATE outbox
				 SET attempts = attempts + 1, next_attempt_at_ms = ?
				 WHERE reply_id = ? AND delivered_at IS NULL`,
			)
			.run(nextAttemptAtMs, replyId);
	}

	hasPendingNormalInstruction(): boolean {
		return this.hasPending("is_stop = 0");
	}

	hasPendingStopInstruction(): boolean {
		return this.hasPending("is_stop = 1");
	}

	private hasPending(filter: string): boolean {
		return (
			this.database
				.prepare(`SELECT 1 AS present FROM instructions WHERE status = 'pending' AND ${filter} LIMIT 1`)
				.get() !== undefined
		);
	}

	recoverInterrupted(completedAt: string, fallbackText: string): void {
		const rows = this.database
			.prepare("SELECT instruction_id FROM instructions WHERE status = 'processing' ORDER BY sequence")
			.all() as Array<{ instruction_id: string }>;
		const unboundRows = rows.filter((row) => this.readTaskBindingRow(row.instruction_id) === undefined);
		for (const row of unboundRows) {
			this.completeInstruction(row.instruction_id, fallbackText, completedAt);
		}
	}

	close(): void {
		this.database.close();
	}

	private toReplyEvent(row: OutboxRow): AgentReplyEvent {
		return {
			event: "agent.reply.completed",
			reply_id: row.reply_id,
			instruction_id: row.instruction_id,
			text: row.text,
			completed_at: row.completed_at,
		};
	}

	private updateTaskBindingStatus(taskId: string, status: TaskBindingStatus, updatedAt: string): void {
		const result = this.database
			.prepare(
				`UPDATE instruction_task_bindings
				 SET compile_status = ?, updated_at = ?
				 WHERE task_id = ?`,
			)
			.run(status, updatedAt, taskId);
		if (result.changes !== 1) {
			throw new Error(`Unknown task_id ${taskId}`);
		}
	}

	private readTaskBindingRow(instructionId: string): TaskBindingRow | undefined {
		return this.database
			.prepare(
				`SELECT instruction_id, task_id, task_json, compile_status,
						last_state, last_snapshot_json, route_json,
						route_leg_index, created_at, updated_at
				 FROM instruction_task_bindings
				 WHERE instruction_id = ?`,
			)
			.get(instructionId) as TaskBindingRow | undefined;
	}

	private toTaskBinding(row: TaskBindingRow): StoredTaskBinding {
		return {
			instructionId: row.instruction_id,
			taskId: row.task_id,
			task: JSON.parse(row.task_json) as MissionTaskSpec,
			compileStatus: row.compile_status,
			lastState: row.last_state ? (row.last_state as TaskState) : undefined,
			lastSnapshot: row.last_snapshot_json ? (JSON.parse(row.last_snapshot_json) as MissionTaskSnapshot) : undefined,
			route: row.route_json ? (JSON.parse(row.route_json) as VisitRouteParameters) : undefined,
			routeLegIndex: row.route_leg_index ?? undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private ensureTaskBindingColumn(name: string, definition: string): void {
		const columns = this.database.prepare("PRAGMA table_info(instruction_task_bindings)").all() as Array<{
			name: string;
		}>;
		if (columns.some((column) => column.name === name)) {
			return;
		}
		this.database.exec(`ALTER TABLE instruction_task_bindings ADD COLUMN ${name} ${definition}`);
	}
}
