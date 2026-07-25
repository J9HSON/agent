import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HealthWebhookNotification } from "./health-contract.ts";
import type { ExternalInstruction } from "./types.ts";

type InstructionRow = {
	instruction_id: string;
	text: string;
	is_stop: number;
};

export type AcceptInstructionResult = "accepted" | "duplicate" | "conflict";
export interface PendingHealthNotification {
	notificationId: string;
	rawBody: Buffer;
	attempts: number;
}
export type AcceptHealthNotificationResult = "accepted" | "duplicate" | "conflict";

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
					CREATE TABLE IF NOT EXISTS health_notifications (
					notification_id TEXT PRIMARY KEY,
					notification_sequence INTEGER NOT NULL,
					event_id TEXT NOT NULL,
					event_revision INTEGER NOT NULL,
					wearer_id TEXT NOT NULL,
					raw_body_sha256 TEXT NOT NULL,
					raw_body BLOB NOT NULL,
					received_at TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS health_queue (
					notification_id TEXT PRIMARY KEY REFERENCES health_notifications(notification_id),
					status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed')),
					attempts INTEGER NOT NULL DEFAULT 0,
					next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
					processed_at TEXT,
					outcome TEXT
				);
				CREATE TABLE IF NOT EXISTS health_event_revisions (
					event_id TEXT PRIMARY KEY,
					highest_revision INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS health_audit (
					sequence INTEGER PRIMARY KEY AUTOINCREMENT,
					notification_id TEXT NOT NULL REFERENCES health_notifications(notification_id),
					event_id TEXT NOT NULL,
					event_revision INTEGER NOT NULL,
					outcome TEXT NOT NULL,
					detail TEXT NOT NULL,
					processed_at TEXT NOT NULL
				);
			`);
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

	completeInstruction(instructionId: string): void {
		this.database.prepare("UPDATE instructions SET status = 'completed' WHERE instruction_id = ?").run(instructionId);
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

	recoverInterrupted(): void {
		this.database.prepare("UPDATE instructions SET status = 'completed' WHERE status = 'processing'").run();
	}

	acceptHealthNotification(
		notification: HealthWebhookNotification,
		rawBody: Buffer,
		rawBodySha256: string,
		receivedAt: string,
	): AcceptHealthNotificationResult {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const inserted = this.database
				.prepare(
					`INSERT INTO health_notifications (
						notification_id, notification_sequence, event_id, event_revision,
						wearer_id, raw_body_sha256, raw_body, received_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(notification_id) DO NOTHING`,
				)
				.run(
					notification.notification_id,
					notification.notification_sequence,
					notification.event_id,
					notification.event_revision,
					notification.wearer_id,
					rawBodySha256,
					rawBody,
					receivedAt,
				);
			if (Number(inserted.changes) === 1) {
				this.database
					.prepare("INSERT INTO health_queue (notification_id, status) VALUES (?, 'pending')")
					.run(notification.notification_id);
				this.database.exec("COMMIT");
				return "accepted";
			}
			const existing = this.database
				.prepare("SELECT raw_body_sha256 FROM health_notifications WHERE notification_id = ?")
				.get(notification.notification_id) as { raw_body_sha256: string };
			this.database.exec("COMMIT");
			return existing.raw_body_sha256 === rawBodySha256 ? "duplicate" : "conflict";
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	claimNextHealthNotification(nowMs: number): PendingHealthNotification | undefined {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const row = this.database
				.prepare(
					`SELECT n.notification_id, n.raw_body, q.attempts
					 FROM health_queue q
					 JOIN health_notifications n ON n.notification_id = q.notification_id
					 WHERE q.status = 'pending' AND q.next_attempt_at_ms <= ?
					 ORDER BY n.notification_sequence, n.notification_id
					 LIMIT 1`,
				)
				.get(nowMs) as { notification_id: string; raw_body: Uint8Array; attempts: number } | undefined;
			if (!row) {
				this.database.exec("COMMIT");
				return undefined;
			}
			this.database
				.prepare("UPDATE health_queue SET status = 'processing' WHERE notification_id = ? AND status = 'pending'")
				.run(row.notification_id);
			this.database.exec("COMMIT");
			return {
				notificationId: row.notification_id,
				rawBody: Buffer.from(row.raw_body),
				attempts: row.attempts,
			};
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	highestProcessedHealthEventRevision(eventId: string): number | undefined {
		const row = this.database
			.prepare("SELECT highest_revision FROM health_event_revisions WHERE event_id = ?")
			.get(eventId) as { highest_revision: number } | undefined;
		return row?.highest_revision;
	}

	completeHealthNotification(
		notification: HealthWebhookNotification,
		outcome: string,
		detail: string,
		processedAt: string,
	): void {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.database
				.prepare(
					`INSERT INTO health_audit (
						notification_id, event_id, event_revision, outcome, detail, processed_at
					) VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					notification.notification_id,
					notification.event_id,
					notification.event_revision,
					outcome,
					detail,
					processedAt,
				);
			this.database
				.prepare(
					`INSERT INTO health_event_revisions (event_id, highest_revision)
					 VALUES (?, ?)
					 ON CONFLICT(event_id) DO UPDATE SET
						highest_revision = MAX(highest_revision, excluded.highest_revision)`,
				)
				.run(notification.event_id, notification.event_revision);
			this.database
				.prepare(
					`UPDATE health_queue
					 SET status = 'completed', processed_at = ?, outcome = ?
					 WHERE notification_id = ?`,
				)
				.run(processedAt, outcome, notification.notification_id);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	retryHealthNotification(notificationId: string, nextAttemptAtMs: number): void {
		this.database
			.prepare(
				`UPDATE health_queue
				 SET status = 'pending', attempts = attempts + 1, next_attempt_at_ms = ?
				 WHERE notification_id = ?`,
			)
			.run(nextAttemptAtMs, notificationId);
	}

	recoverInterruptedHealthNotifications(): void {
		this.database.prepare("UPDATE health_queue SET status = 'pending' WHERE status = 'processing'").run();
	}

	nextHealthAttemptAtMs(): number | undefined {
		const row = this.database
			.prepare(
				`SELECT MIN(next_attempt_at_ms) AS next_attempt_at_ms
				 FROM health_queue
				 WHERE status = 'pending'`,
			)
			.get() as { next_attempt_at_ms: number | null };
		return row.next_attempt_at_ms ?? undefined;
	}

	close(): void {
		this.database.close();
	}
}
