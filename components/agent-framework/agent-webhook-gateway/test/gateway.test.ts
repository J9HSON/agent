import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentWebhookService,
	createInstructionServer,
	GatewayStore,
	isStopPhrase,
	type McpToolCaller,
	ReplyWebhookClient,
	type UserTextAgent,
} from "../src/index.ts";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected an IPv4 test server address");
	}
	return `http://127.0.0.1:${address.port}`;
}

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for asynchronous gateway work");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("Agent input and final reply webhook", () => {
	it("matches normalized natural-language stop phrases without matching negation", () => {
		for (const text of ["停", "停。", " STOP ", "stop!", "停止", "请停下来", "马上停", "别动", "stop now"]) {
			expect(isStopPhrase(text), text).toBe(true);
		}
		for (const text of ["别停", "不要停止任务", "停靠在门口"]) {
			expect(isStopPhrase(text), text).toBe(false);
		}
	});

	it("accepts a persisted instruction before delivering one complete agent reply", async () => {
		const replies: unknown[] = [];
		const callbackUrl = await listen(
			createServer((request, response) => {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk: string) => {
					body += chunk;
				});
				request.on("end", () => {
					replies.push(JSON.parse(body));
					response.writeHead(204).end();
				});
			}),
		);
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		const agent: UserTextAgent = {
			run: async () => "我已经处理完成。",
		};
		const mcp: McpToolCaller = {
			callTool: async () => {
				throw new Error("MCP should not be called by this instruction");
			},
		};
		const store = new GatewayStore(join(directory, "gateway.sqlite"));
		const service = new AgentWebhookService({
			store,
			agent,
			mcp,
			replyClient: new ReplyWebhookClient(callbackUrl, 1_000),
		});
		service.start();
		const gatewayUrl = await listen(createInstructionServer(service));

		const response = await fetch(`${gatewayUrl}/v1/instructions`, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				instruction_id: "instruction-1",
				text: "你好",
			}),
		});

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			instruction_id: "instruction-1",
			status: "accepted",
		});
		await waitFor(() => replies.length === 1);
		expect(replies).toEqual([
			{
				event: "agent.reply.completed",
				reply_id: expect.any(String),
				instruction_id: "instruction-1",
				text: "我已经处理完成。",
				completed_at: expect.stringMatching(/Z$/),
			},
		]);

		await service.close();
	});

	it("deduplicates identical instruction IDs and rejects conflicting text", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		const prompts: string[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: {
				run: async (text) => {
					prompts.push(text);
					return "完成";
				},
			},
			mcp: {
				callTool: async () => "unused",
			},
			replyClient: {
				deliver: async () => {},
			},
		});
		service.start();
		const gatewayUrl = await listen(createInstructionServer(service));
		const submit = (text: string) =>
			fetch(`${gatewayUrl}/v1/instructions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ instruction_id: "stable-id", text }),
			});

		expect((await submit("解释一下当前状态")).status).toBe(202);
		expect((await submit("解释一下当前状态")).status).toBe(202);
		expect((await submit("解释一下地图")).status).toBe(409);
		await waitFor(() => prompts.length === 1);
		expect(prompts).toEqual(["解释一下当前状态"]);

		await service.close();
	});

	it("runs normal instructions through one fixed agent session in persisted order", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		const prompts: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstPromptBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: {
				run: async (text) => {
					prompts.push(text);
					if (text === "第一条") {
						await firstPromptBlocked;
					}
					return `${text}完成`;
				},
			},
			mcp: { callTool: async () => "unused" },
			replyClient: { deliver: async () => {} },
		});
		service.start();
		const gatewayUrl = await listen(createInstructionServer(service));
		const submit = (instructionId: string, text: string) =>
			fetch(`${gatewayUrl}/v1/instructions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ instruction_id: instructionId, text }),
			});

		await Promise.all([submit("first", "第一条"), submit("second", "第二条")]);
		await waitFor(() => prompts.length === 1);
		expect(prompts).toEqual(["第一条"]);
		releaseFirst?.();
		await waitFor(() => prompts.length === 2);
		expect(prompts).toEqual(["第一条", "第二条"]);

		await service.close();
	});

	it("bypasses the busy agent for an exact normalized stop phrase", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		let releaseAgent: (() => void) | undefined;
		const agentBlocked = new Promise<void>((resolve) => {
			releaseAgent = resolve;
		});
		const toolCalls: string[] = [];
		const replies: Array<{ instruction_id: string; text: string }> = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: {
				run: async () => {
					await agentBlocked;
					return "普通回复";
				},
			},
			mcp: {
				callTool: async (name) => {
					toolCalls.push(name);
					return "accepted";
				},
			},
			replyClient: {
				deliver: async (event) => {
					replies.push(event);
				},
			},
		});
		service.start();
		const gatewayUrl = await listen(createInstructionServer(service));
		const submit = (instructionId: string, text: string) =>
			fetch(`${gatewayUrl}/v1/instructions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ instruction_id: instructionId, text }),
			});

		await submit("busy", "解释一下状态");
		await submit("stop", " STOP！ ");
		await waitFor(() => toolCalls.length === 1);
		expect(toolCalls).toEqual(["stop_all"]);
		await waitFor(() => replies.some((reply) => reply.instruction_id === "stop"));
		expect(replies.find((reply) => reply.instruction_id === "stop")?.text).toBe("已发送停止指令。");

		releaseAgent?.();
		await service.close();
	});

	it("uses the fixed failure reply when stop_all is not accepted", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		const replies: string[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: { run: async () => "unused" },
			mcp: {
				callTool: async () => {
					throw new Error("upstream stop failed");
				},
			},
			replyClient: {
				deliver: async (event) => {
					replies.push(event.text);
				},
			},
		});
		service.start();
		service.acceptInstruction({ instructionId: "failed-stop", text: "停" });
		await waitFor(() => replies.length === 1);

		expect(replies).toEqual(["暂时无法完成此请求，请稍后重试。"]);
		await service.close();
	});

	it("retries the same persisted reply without rerunning the agent", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		let agentRuns = 0;
		const deliveryIds: string[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: {
				run: async () => {
					agentRuns++;
					return "唯一回复";
				},
			},
			mcp: { callTool: async () => "unused" },
			replyClient: {
				deliver: async (event) => {
					deliveryIds.push(event.reply_id);
					if (deliveryIds.length === 1) {
						throw new Error("temporary callback failure");
					}
				},
			},
			retryBaseMs: 5,
			retryMaxMs: 5,
		});
		service.start();
		const gatewayUrl = await listen(createInstructionServer(service));

		await fetch(`${gatewayUrl}/v1/instructions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ instruction_id: "retry", text: "回复我" }),
		});
		await waitFor(() => deliveryIds.length === 2);

		expect(new Set(deliveryIds).size).toBe(1);
		expect(agentRuns).toBe(1);
		await service.close();
	});

	it("delivers the fixed user-facing text when the agent cannot complete", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		const replies: string[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: {
				run: async () => {
					throw new Error("provider unavailable");
				},
			},
			mcp: { callTool: async () => "unused" },
			replyClient: {
				deliver: async (event) => {
					replies.push(event.text);
				},
			},
		});
		service.start();
		const gatewayUrl = await listen(createInstructionServer(service));

		await fetch(`${gatewayUrl}/v1/instructions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ instruction_id: "failed", text: "做一件事" }),
		});
		await waitFor(() => replies.length === 1);
		expect(replies).toEqual(["暂时无法完成此请求，请稍后重试。"]);

		await service.close();
	});

	it("resumes an outbox retry after restart without rerunning the completed instruction", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		const databasePath = join(directory, "gateway.sqlite");
		let firstDeliveryAttempts = 0;
		const firstService = new AgentWebhookService({
			store: new GatewayStore(databasePath),
			agent: { run: async () => "已完成" },
			mcp: { callTool: async () => "unused" },
			replyClient: {
				deliver: async () => {
					firstDeliveryAttempts++;
					throw new Error("receiver unavailable");
				},
			},
			retryBaseMs: 100,
			retryMaxMs: 100,
		});
		firstService.start();
		firstService.acceptInstruction({ instructionId: "restart-retry", text: "执行一次" });
		await waitFor(() => firstDeliveryAttempts === 1);
		await firstService.close();

		let restartedAgentRuns = 0;
		const deliveredReplyIds: string[] = [];
		const secondService = new AgentWebhookService({
			store: new GatewayStore(databasePath),
			agent: {
				run: async () => {
					restartedAgentRuns++;
					return "不应执行";
				},
			},
			mcp: { callTool: async () => "unused" },
			replyClient: {
				deliver: async (event) => {
					deliveredReplyIds.push(event.reply_id);
				},
			},
			retryBaseMs: 100,
			retryMaxMs: 100,
		});
		secondService.start();
		await waitFor(() => deliveredReplyIds.length === 1);

		expect(restartedAgentRuns).toBe(0);
		await secondService.close();
	});
});
