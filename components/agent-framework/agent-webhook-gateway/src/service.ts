import { consoleGatewayLogSink, describeGatewayError, type GatewayLogSink, writeGatewayLog } from "./logging.ts";
import type { GatewayStore } from "./store.ts";
import type { ExternalInstruction, McpToolCaller, UserTextAgent } from "./types.ts";

export class InstructionConflictError extends Error {}

export interface AgentWebhookServiceOptions {
	store: GatewayStore;
	agent: UserTextAgent;
	mcp: McpToolCaller;
	onBackgroundError?: (error: unknown) => void;
	onLog?: GatewayLogSink;
}

export class AgentWebhookService {
	private readonly store: GatewayStore;
	private readonly agent: UserTextAgent;
	private readonly mcp: McpToolCaller;
	private readonly onBackgroundError: (error: unknown) => void;
	private readonly onLog: GatewayLogSink;
	private agentDrainPromise?: Promise<void>;
	private stopDrainPromise?: Promise<void>;
	private closed = false;

	constructor(options: AgentWebhookServiceOptions) {
		this.store = options.store;
		this.agent = options.agent;
		this.mcp = options.mcp;
		this.onLog = options.onLog ?? consoleGatewayLogSink;
		this.onBackgroundError =
			options.onBackgroundError ??
			((error) => {
				this.log("background.failed", { error: describeGatewayError(error) });
			});
	}

	start(): void {
		this.store.recoverInterrupted();
		this.scheduleAgentDrain();
		this.scheduleStopDrain();
	}

	acceptInstruction(instruction: ExternalInstruction): void {
		const stopPhrase = isStopPhrase(instruction.text);
		const result = this.store.acceptInstruction(instruction, stopPhrase, new Date().toISOString());
		if (result === "conflict") {
			throw new InstructionConflictError(
				`instruction_id ${instruction.instructionId} is already associated with different text`,
			);
		}
		if (result === "duplicate") {
			this.log("instruction.duplicate", {
				instruction_id: instruction.instructionId,
				kind: stopPhrase ? "stop" : "agent",
				text: instruction.text,
			});
			return;
		}
		if (result === "accepted") {
			this.log("instruction.accepted", {
				instruction_id: instruction.instructionId,
				kind: stopPhrase ? "stop" : "agent",
				text: instruction.text,
			});
			if (stopPhrase) {
				this.scheduleStopDrain();
			} else {
				this.scheduleAgentDrain();
			}
		}
	}

	private scheduleAgentDrain(): void {
		if (this.closed || this.agentDrainPromise) {
			return;
		}
		this.agentDrainPromise = Promise.resolve()
			.then(async () => {
				while (!this.closed) {
					const instruction = this.store.claimNextNormalInstruction();
					if (!instruction) {
						return;
					}
					this.log("instruction.processing", {
						instruction_id: instruction.instructionId,
						kind: "agent",
					});
					try {
						await this.agent.run(instruction.text);
					} catch (error) {
						this.log("instruction.agent_failed", {
							instruction_id: instruction.instructionId,
							error: describeGatewayError(error),
						});
					}
					this.completeInstruction(instruction.instructionId);
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
					this.log("instruction.processing", {
						instruction_id: instruction.instructionId,
						kind: "stop",
					});
					try {
						await this.mcp.callTool("stop_all", {});
					} catch (error) {
						this.log("instruction.stop_failed", {
							instruction_id: instruction.instructionId,
							error: describeGatewayError(error),
						});
					}
					this.completeInstruction(instruction.instructionId);
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

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([this.agentDrainPromise, this.stopDrainPromise]);
		await this.agent.close?.();
		this.store.close();
	}

	private log(event: string, details: Readonly<Record<string, unknown>>): void {
		writeGatewayLog(this.onLog, event, details);
	}

	private completeInstruction(instructionId: string): void {
		this.store.completeInstruction(instructionId);
		this.log("instruction.completed", {
			instruction_id: instructionId,
		});
	}
}

export function isStopPhrase(text: string): boolean {
	const normalized = text
		.normalize("NFKC")
		.trim()
		.replace(/[。.！!?？]+$/u, "")
		.trim()
		.toLowerCase();
	return normalized === "停" || normalized === "stop";
}
