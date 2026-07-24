import {
	type AuthoritativeHealthEvent,
	type AuthoritativeHealthState,
	HealthMcpResultError,
	type HealthMcpToolCaller,
	type HealthWebhookNotification,
	parseHealthWebhookNotification,
	readAuthoritativeHealthEvent,
	readAuthoritativeHealthState,
} from "./health-contract.ts";
import { HealthMcpProtocolError } from "./health-mcp-client.ts";
import type { GatewayStore } from "./store.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type HealthProcessingOutcome =
	| "verified_no_action"
	| "obsolete_notification"
	| "unsupported_wearer"
	| "event_mismatch"
	| "unsafe_event_source"
	| "unsafe_state"
	| "invalid_mcp_result";

export interface HealthNotificationServiceOptions {
	store: GatewayStore;
	mcp: HealthMcpToolCaller;
	wearerId: string;
	retryBaseMs?: number;
	retryMaxMs?: number;
	onOutcome?: (outcome: HealthProcessingOutcome, notification: HealthWebhookNotification) => void;
	onBackgroundError?: (error: unknown) => void;
}

export class HealthNotificationService {
	private readonly store: GatewayStore;
	private readonly mcp: HealthMcpToolCaller;
	private readonly wearerId: string;
	private readonly retryBaseMs: number;
	private readonly retryMaxMs: number;
	private readonly onOutcome: (outcome: HealthProcessingOutcome, notification: HealthWebhookNotification) => void;
	private readonly onBackgroundError: (error: unknown) => void;
	private drainPromise?: Promise<void>;
	private retryTimer?: NodeJS.Timeout;
	private closed = false;

	constructor(options: HealthNotificationServiceOptions) {
		this.store = options.store;
		this.mcp = options.mcp;
		this.wearerId = options.wearerId;
		this.retryBaseMs = options.retryBaseMs ?? 1_000;
		this.retryMaxMs = options.retryMaxMs ?? 60_000;
		this.onOutcome = options.onOutcome ?? (() => {});
		this.onBackgroundError = options.onBackgroundError ?? ((error) => console.error(error));
	}

	start(): void {
		this.store.recoverInterruptedHealthNotifications();
		this.scheduleDrain();
	}

	notifyAccepted(): void {
		this.scheduleDrain();
	}

	private scheduleDrain(): void {
		if (this.closed || this.drainPromise) {
			return;
		}
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		this.drainPromise = Promise.resolve()
			.then(async () => {
				while (!this.closed) {
					const pending = this.store.claimNextHealthNotification(Date.now());
					if (!pending) {
						return;
					}
					try {
						const notification = parseHealthWebhookNotification(JSON.parse(pending.rawBody.toString("utf8")));
						const previousRevision = this.store.highestProcessedHealthEventRevision(notification.event_id);
						if (previousRevision !== undefined && previousRevision >= notification.event_revision) {
							this.complete(notification, "obsolete_notification", "event revision was already processed");
							continue;
						}
						const outcome = await this.verifyAuthoritativeState(notification);
						this.complete(notification, outcome, outcome.replaceAll("_", " "));
					} catch (error) {
						const retryDelay = Math.min(
							Math.max(
								Math.min(this.retryBaseMs * 2 ** pending.attempts, this.retryMaxMs),
								error instanceof HealthMcpResultError && error.retryable ? (error.retryAfterMs ?? 0) : 0,
							),
							MAX_TIMER_DELAY_MS,
						);
						this.store.retryHealthNotification(pending.notificationId, Date.now() + retryDelay);
						this.onBackgroundError(error);
						return;
					}
				}
			})
			.catch(this.onBackgroundError)
			.finally(() => {
				this.drainPromise = undefined;
				this.scheduleNextWakeup();
			});
	}

	private async verifyAuthoritativeState(notification: HealthWebhookNotification): Promise<HealthProcessingOutcome> {
		if (notification.wearer_id !== this.wearerId) {
			return "unsupported_wearer";
		}
		if (notification.data_source !== "live" || notification.test_mode) {
			return "unsafe_event_source";
		}

		let event: AuthoritativeHealthEvent;
		let state: AuthoritativeHealthState;
		try {
			event = readAuthoritativeHealthEvent(
				await this.mcp.callTool("health.get_event_details", { event_id: notification.event_id }),
			);
			state = readAuthoritativeHealthState(
				await this.mcp.callTool("health.get_current_state", {
					wearer_id: notification.wearer_id,
					max_age_ms: 2000,
				}),
			);
		} catch (error) {
			if (error instanceof HealthMcpResultError && error.retryable) {
				throw error;
			}
			if (error instanceof HealthMcpResultError || error instanceof HealthMcpProtocolError) {
				return "invalid_mcp_result";
			}
			throw error;
		}

		if (
			event.eventId !== notification.event_id ||
			event.eventRevision < notification.event_revision ||
			event.eventType !== notification.event_type ||
			event.wearerId !== notification.wearer_id ||
			event.sourceInstanceId !== notification.source_instance_id
		) {
			return "event_mismatch";
		}
		if (event.dataSource !== "live" || event.testMode) {
			return "unsafe_event_source";
		}
		if (
			state.wearerId !== notification.wearer_id ||
			state.sourceInstanceId !== notification.source_instance_id ||
			state.stateRevision < notification.state_revision ||
			state.dataSource !== "live" ||
			state.testMode ||
			state.freshness !== "fresh"
		) {
			return "unsafe_state";
		}

		return "verified_no_action";
	}

	private complete(notification: HealthWebhookNotification, outcome: HealthProcessingOutcome, detail: string): void {
		this.store.completeHealthNotification(notification, outcome, detail, new Date().toISOString());
		this.onOutcome(outcome, notification);
	}

	private scheduleNextWakeup(): void {
		if (this.closed || this.drainPromise || this.retryTimer) {
			return;
		}
		const nextAttemptAtMs = this.store.nextHealthAttemptAtMs();
		if (nextAttemptAtMs === undefined) {
			return;
		}
		const delayMs = Math.max(0, nextAttemptAtMs - Date.now());
		if (delayMs === 0) {
			this.scheduleDrain();
			return;
		}
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.scheduleDrain();
		}, delayMs);
		this.retryTimer.unref();
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		await this.drainPromise;
		await this.mcp.close?.();
	}
}
