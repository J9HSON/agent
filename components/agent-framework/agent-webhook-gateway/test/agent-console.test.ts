import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentReplyEvent, AgentWebhookService, createInstructionServer, GatewayStore } from "../src/index.ts";

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
		throw new Error("Expected an IPv4 server address");
	}
	return `http://127.0.0.1:${address.port}`;
}

async function waitForReply(baseUrl: string, instructionId: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const response = await fetch(`${baseUrl}/v1/instructions/${instructionId}`);
		const body = (await response.json()) as Record<string, unknown>;
		if (body.reply) {
			return body;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for Agent Console reply");
}

describe("Agent Console", () => {
	it("serves one same-origin map and instruction surface", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-console-"));
		directories.push(directory);
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: { run: async () => "unused" },
			mcp: { callTool: async () => "unused" },
			replyClient: { deliver: async () => {} },
		});
		const baseUrl = await listen(
			createInstructionServer(service, {
				mapUrl: "http://127.0.0.1:9878/",
			}),
		);

		const page = await fetch(baseUrl);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Go2 Agent 控制台");
		expect(page.headers.get("content-security-policy")).toContain("frame-src http://127.0.0.1:9878");

		const config = await fetch(`${baseUrl}/v1/ui-config`);
		expect(await config.json()).toEqual({ map_url: "http://127.0.0.1:9878/" });
		await service.close();
	});

	it("shows persisted processing state and the final Agent reply", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-console-"));
		directories.push(directory);
		const delivered: AgentReplyEvent[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: { run: async () => "已完成测试任务。" },
			mcp: { callTool: async () => "unused" },
			replyClient: {
				deliver: async (event) => {
					delivered.push(event);
				},
			},
		});
		service.start();
		const baseUrl = await listen(createInstructionServer(service));

		const accepted = await fetch(`${baseUrl}/v1/instructions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				instruction_id: "console-instruction-1",
				text: "去测试点",
			}),
		});
		expect(accepted.status).toBe(202);

		const view = await waitForReply(baseUrl, "console-instruction-1");
		expect(view).toMatchObject({
			instruction_id: "console-instruction-1",
			text: "去测试点",
			status: "completed",
			task: null,
			reply: {
				event: "agent.reply.completed",
				instruction_id: "console-instruction-1",
				text: "已完成测试任务。",
			},
		});
		expect(delivered).toHaveLength(1);

		const callback = await fetch(`${baseUrl}/v1/ui-replies`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(delivered[0]),
		});
		expect(callback.status).toBe(204);
		await service.close();
	});

	it("does not acknowledge a reply that is absent from the persisted outbox", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-console-"));
		directories.push(directory);
		const service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent: { run: async () => "unused" },
			mcp: { callTool: async () => "unused" },
			replyClient: { deliver: async () => {} },
		});
		const baseUrl = await listen(createInstructionServer(service));

		const callback = await fetch(`${baseUrl}/v1/ui-replies`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				event: "agent.reply.completed",
				reply_id: "unknown-reply",
				instruction_id: "unknown-instruction",
				text: "不存在",
				completed_at: "2026-07-26T00:00:00.000Z",
			}),
		});
		expect(callback.status).toBe(409);
		await service.close();
	});
});
