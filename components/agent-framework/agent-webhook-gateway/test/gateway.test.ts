import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWebhookService, createInstructionServer, GatewayStore, isStopPhrase } from "../src/index.ts";

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

function readInstructionState(
	databasePath: string,
	instructionId: string,
): {
	status: string;
	outboxExists: boolean;
} {
	const database = new DatabaseSync(databasePath);
	try {
		const row = database.prepare("SELECT status FROM instructions WHERE instruction_id = ?").get(instructionId) as {
			status: string;
		};
		const outbox =
			database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'outbox'").get() !==
			undefined;
		return { status: row.status, outboxExists: outbox };
	} finally {
		database.close();
	}
}

describe("Agent input webhook", () => {
	it("matches only the documented normalized stop phrases", () => {
		for (const text of ["停", "停。", " STOP ", "stop!"]) {
			expect(isStopPhrase(text), text).toBe(true);
		}
		for (const text of ["别停", "停止", "请停下来", "stop now"]) {
			expect(isStopPhrase(text), text).toBe(false);
		}
	});

	it("persists and completes one Agent instruction without creating a reply outbox", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		const databasePath = join(directory, "gateway.sqlite");
		const logs: string[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(databasePath),
			agent: { run: async () => "internal final text" },
			mcp: {
				callTool: async () => {
					throw new Error("MCP should not be called by this instruction");
				},
			},
			onLog: (line) => logs.push(line),
		});
		try {
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
			await waitFor(() => logs.some((line) => line.includes("instruction.completed")));
			const events = logs.map((line) => /^\[agent-webhook\] \S+Z (\S+) /u.exec(line)?.[1]).filter(Boolean);
			expect(events).toEqual(["instruction.accepted", "instruction.processing", "instruction.completed"]);
			expect(logs.join("\n")).not.toContain("reply.");
		} finally {
			await service.close();
		}

		expect(readInstructionState(databasePath, "instruction-1")).toEqual({
			status: "completed",
			outboxExists: false,
		});
	});

	it("logs rejected requests without echoing malformed bodies", async () => {
		const logs: string[] = [];
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: { run: async () => "unused" },
			mcp: { callTool: async () => "unused" },
			onLog: (line) => logs.push(line),
		});
		try {
			const gatewayUrl = await listen(createInstructionServer(service, undefined, (line) => logs.push(line)));
			const malformedBody = "{instruction_id:secret-value}";

			const response = await fetch(`${gatewayUrl}/v1/instructions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: malformedBody,
			});

			expect(response.status).toBe(400);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatch(/^\[agent-webhook\] \S+Z request\.rejected /u);
			expect(logs[0]).not.toContain(malformedBody);
			const details = JSON.parse(logs[0]?.split(" request.rejected ")[1] ?? "") as Record<string, unknown>;
			expect(details).toEqual({
				method: "POST",
				path: "/v1/instructions",
				status: 400,
				reason: "invalid_json",
			});

			const queryResponse = await fetch(`${gatewayUrl}/v1/instructions?token=secret-query-value`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(queryResponse.status).toBe(404);
			const queryLog = logs.at(-1);
			expect(queryLog).not.toContain("secret-query-value");
			const queryDetails = JSON.parse(queryLog?.split(" request.rejected ")[1] ?? "") as Record<string, unknown>;
			expect(queryDetails).toEqual({
				method: "POST",
				path: "/v1/instructions",
				status: 404,
				reason: "not_found",
			});
		} finally {
			await service.close();
		}
	});

	it("deduplicates identical instruction IDs and rejects conflicting text", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		const prompts: string[] = [];
		const logs: string[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: {
				run: async (text) => {
					prompts.push(text);
					return "完成";
				},
			},
			mcp: { callTool: async () => "unused" },
			onLog: (line) => logs.push(line),
		});
		try {
			service.start();
			const gatewayUrl = await listen(createInstructionServer(service, undefined, (line) => logs.push(line)));
			const submit = (text: string) =>
				fetch(`${gatewayUrl}/v1/instructions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ instruction_id: "stable-id", text }),
				});

			expect((await submit("向前走")).status).toBe(202);
			const duplicateResponse = await submit("向前走");
			expect(duplicateResponse.status).toBe(202);
			expect(await duplicateResponse.json()).toEqual({
				instruction_id: "stable-id",
				status: "accepted",
			});
			expect((await submit("向后走")).status).toBe(409);
			await waitFor(() => prompts.length === 1);
			expect(prompts).toEqual(["向前走"]);
			expect(logs.some((line) => line.includes("instruction.duplicate"))).toBe(true);
			expect(
				logs.some(
					(line) =>
						line.includes("request.rejected") &&
						line.includes('"status":409') &&
						line.includes('"reason":"instruction_id_conflict"'),
				),
			).toBe(true);
		} finally {
			await service.close();
		}
	});

	it("runs normal instructions through one fixed Agent session in persisted order", async () => {
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

	it("bypasses the busy Agent for an exact normalized stop phrase without automatic speech", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		let releaseAgent: (() => void) | undefined;
		const agentBlocked = new Promise<void>((resolve) => {
			releaseAgent = resolve;
		});
		const toolCalls: string[] = [];
		const logs: string[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: {
				run: async () => {
					await agentBlocked;
					return "普通内部结果";
				},
			},
			mcp: {
				callTool: async (name) => {
					toolCalls.push(name);
					return "accepted";
				},
			},
			onLog: (line) => logs.push(line),
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
		await waitFor(() =>
			logs.some((line) => line.includes("instruction.completed") && line.includes('"instruction_id":"stop"')),
		);
		expect(logs.join("\n")).not.toContain("reply.");

		releaseAgent?.();
		await service.close();
	});

	it("marks failed Agent and stop processing complete without creating fallback replies", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		const databasePath = join(directory, "gateway.sqlite");
		const logs: string[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(databasePath),
			agent: {
				run: async () => {
					throw new Error("provider unavailable Authorization: Bearer sk-secret-value token=private-token-value");
				},
			},
			mcp: {
				callTool: async () => {
					throw new Error("upstream stop failed");
				},
			},
			onLog: (line) => logs.push(line),
		});
		try {
			service.start();
			service.acceptInstruction({ instructionId: "failed-agent", text: "做一件事" });
			service.acceptInstruction({ instructionId: "failed-stop", text: "停" });
			await waitFor(() => logs.filter((line) => line.includes("instruction.completed")).length === 2);

			expect(logs.some((line) => line.includes("instruction.agent_failed"))).toBe(true);
			expect(logs.some((line) => line.includes("instruction.stop_failed"))).toBe(true);
			expect(logs.join("\n")).toContain("Authorization: [redacted]");
			expect(logs.join("\n")).not.toContain("sk-secret-value");
			expect(logs.join("\n")).not.toContain("private-token-value");
			expect(logs.join("\n")).not.toContain("暂时无法完成此请求");
		} finally {
			await service.close();
		}

		expect(readInstructionState(databasePath, "failed-agent")).toEqual({
			status: "completed",
			outboxExists: false,
		});
		expect(readInstructionState(databasePath, "failed-stop")).toEqual({
			status: "completed",
			outboxExists: false,
		});
	});

	it("does not rerun an instruction that was processing when the gateway stopped", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-gateway-"));
		directories.push(directory);
		const databasePath = join(directory, "gateway.sqlite");
		const firstStore = new GatewayStore(databasePath);
		firstStore.acceptInstruction({ instructionId: "interrupted", text: "执行一次" }, false, new Date().toISOString());
		expect(firstStore.claimNextNormalInstruction()).toEqual({
			instructionId: "interrupted",
			text: "执行一次",
		});
		firstStore.close();

		let restartedAgentRuns = 0;
		const secondService = new AgentWebhookService({
			store: new GatewayStore(databasePath),
			agent: {
				run: async () => {
					restartedAgentRuns++;
					return "不应执行";
				},
			},
			mcp: { callTool: async () => "unused" },
		});
		secondService.start();
		await secondService.close();

		expect(restartedAgentRuns).toBe(0);
		expect(readInstructionState(databasePath, "interrupted")).toEqual({
			status: "completed",
			outboxExists: false,
		});
	});
});
