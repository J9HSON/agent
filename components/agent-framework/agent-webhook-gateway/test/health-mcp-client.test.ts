import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	HealthMcpClient,
	type HealthMcpJsonRpcTransport,
	type JsonObject,
	StdioHealthMcpTransport,
	StreamableHttpHealthMcpTransport,
} from "../src/index.ts";
import { startFakeHealthStreamableHttpMcp } from "./support/fake-health-streamable-http-mcp.ts";

describe("Health MCP client contract", () => {
	it("initializes once and requires TextContent to equal structuredContent", async () => {
		const requests: Array<{ method: string; params: JsonObject }> = [];
		const notifications: Array<{ method: string; params: JsonObject }> = [];
		const envelope = {
			ok: true,
			data: { device: { status: "ok" } },
			meta: {
				schema_version: "0.2.0",
				generated_at: "2026-07-23T02:10:00.250Z",
				data_source: "live",
				age_ms: 35,
				trace_id: "7a916c4a-3b3e-4ec5-8491-e5fc7e843863",
			},
			error: null,
		};
		const transport: HealthMcpJsonRpcTransport = {
			request: async (method, params) => {
				requests.push({ method, params });
				if (method === "initialize") {
					return {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "smart-neckband-health", version: "0.2.0" },
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(envelope) }],
					structuredContent: envelope,
					isError: false,
				};
			},
			notify: async (method, params) => {
				notifications.push({ method, params });
			},
			close: async () => {},
		};
		const client = new HealthMcpClient(transport);

		await expect(
			Promise.all([
				client.callTool("health.get_heart_rate", { window_s: 30 }),
				client.callTool("health.get_heart_rate", { window_s: 30 }),
			]),
		).resolves.toEqual([
			{ isError: false, structuredContent: envelope },
			{ isError: false, structuredContent: envelope },
		]);

		expect(requests.map((request) => request.method)).toEqual(["initialize", "tools/call", "tools/call"]);
		expect(requests[0]?.params).toEqual({
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "pi-health-consumer", version: "0.2.0" },
		});
		expect(notifications).toEqual([{ method: "notifications/initialized", params: {} }]);
	});

	it("rejects a result whose compatibility TextContent disagrees with structuredContent", async () => {
		const transport: HealthMcpJsonRpcTransport = {
			request: async (method) => {
				if (method === "initialize") {
					return {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "smart-neckband-health", version: "0.2.0" },
					};
				}
				return {
					content: [{ type: "text", text: '{"ok":false}' }],
					structuredContent: { ok: true },
					isError: false,
				};
			},
			notify: async () => {},
			close: async () => {},
		};

		await expect(new HealthMcpClient(transport).callTool("health.get_heart_rate", { window_s: 30 })).rejects.toThrow(
			"TextContent does not equal structuredContent",
		);
	});

	it("initializes a restarted transport session before the next tool call", async () => {
		const requests: string[] = [];
		const envelope = { ok: true, data: {}, meta: {}, error: null };
		const transport: HealthMcpJsonRpcTransport & { sessionGeneration: number } = {
			sessionGeneration: 0,
			request: async (method) => {
				requests.push(method);
				if (method === "initialize") {
					return {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "smart-neckband-health", version: "0.2.0" },
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(envelope) }],
					structuredContent: envelope,
					isError: false,
				};
			},
			notify: async () => {},
			close: async () => {},
		};
		const client = new HealthMcpClient(transport);

		await client.callTool("health.get_heart_rate", { window_s: 30 });
		transport.sessionGeneration += 1;
		await client.callTool("health.get_heart_rate", { window_s: 30 });

		expect(requests).toEqual(["initialize", "tools/call", "initialize", "tools/call"]);
	});

	it("exchanges newline-delimited JSON-RPC with a stdio child process", async () => {
		const fixturePath = fileURLToPath(new URL("./support/fake-health-mcp.mjs", import.meta.url));
		const client = new HealthMcpClient(new StdioHealthMcpTransport(process.execPath, [fixturePath], 1_000));

		await expect(client.callTool("health.get_heart_rate", { window_s: 30 })).resolves.toMatchObject({
			isError: false,
			structuredContent: {
				ok: true,
				data: { echoed_tool: "health.get_heart_rate" },
			},
		});

		await client.close();
	});

	it("uses a local JSON Streamable HTTP MCP session without authentication and deletes it on close", async () => {
		const fake = await startFakeHealthStreamableHttpMcp();
		const client = new HealthMcpClient(new StreamableHttpHealthMcpTransport(fake.url, 1_000));
		try {
			await expect(client.callTool("health.get_heart_rate", { window_s: 30 })).resolves.toMatchObject({
				isError: false,
				structuredContent: {
					ok: true,
					data: { echoed_tool: "health.get_heart_rate" },
				},
			});
			await client.close();

			expect(fake.requests.map(({ httpMethod, body }) => [httpMethod, body?.method])).toEqual([
				["POST", "initialize"],
				["POST", "notifications/initialized"],
				["POST", "tools/call"],
				["DELETE", undefined],
			]);
			expect(fake.requests[0]?.headers.accept).toBe("application/json, text/event-stream");
			expect(fake.requests[0]?.headers["mcp-session-id"]).toBeUndefined();
			expect(fake.requests[0]?.headers["mcp-protocol-version"]).toBeUndefined();
			for (const request of fake.requests.slice(1)) {
				expect(request.headers["mcp-session-id"]).toBe("health-session-1");
				expect(request.headers["mcp-protocol-version"]).toBe("2025-11-25");
			}
			expect(fake.requests.every(({ headers }) => headers.authorization === undefined)).toBe(true);
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("accepts local Streamable HTTP SSE responses", async () => {
		const fake = await startFakeHealthStreamableHttpMcp({ responseFormat: "sse" });
		const client = new HealthMcpClient(new StreamableHttpHealthMcpTransport(fake.url, 1_000));
		try {
			await expect(client.callTool("health.get_heart_rate", { window_s: 30 })).resolves.toMatchObject({
				isError: false,
				structuredContent: {
					ok: true,
					data: { echoed_tool: "health.get_heart_rate" },
				},
			});
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("reinitializes and retries a read-only tool call when the HTTP session expires", async () => {
		const fake = await startFakeHealthStreamableHttpMcp({ expireFirstToolSession: true });
		const client = new HealthMcpClient(new StreamableHttpHealthMcpTransport(fake.url, 1_000));
		try {
			await expect(client.callTool("health.get_heart_rate", { window_s: 30 })).resolves.toMatchObject({
				isError: false,
				structuredContent: {
					ok: true,
					data: { echoed_tool: "health.get_heart_rate" },
				},
			});
			await client.close();

			expect(fake.requests.filter(({ body }) => body?.method === "initialize")).toHaveLength(2);
			expect(fake.requests.filter(({ body }) => body?.method === "tools/call")).toHaveLength(2);
			expect(
				fake.requests
					.filter(({ body }) => body?.method === "initialize")
					.every(({ headers }) => headers["mcp-session-id"] === undefined),
			).toBe(true);
			expect(fake.requests.at(-1)?.httpMethod).toBe("DELETE");
			expect(fake.requests.at(-1)?.headers["mcp-session-id"]).toBe("health-session-2");
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it("does not let a delayed 404 from an old concurrent request invalidate the replacement session", async () => {
		const fake = await startFakeHealthStreamableHttpMcp({ expireConcurrentSession: true });
		const client = new HealthMcpClient(new StreamableHttpHealthMcpTransport(fake.url, 1_000));
		try {
			await expect(
				Promise.all([
					client.callTool("health.get_event_details", { event_id: "event-1" }),
					client.callTool("health.get_current_state", { wearer_id: "xwen" }),
				]),
			).resolves.toHaveLength(2);
			expect(fake.requests.filter(({ body }) => body?.method === "initialize")).toHaveLength(2);
			expect(
				fake.requests
					.filter(({ body }) => body?.method === "tools/call")
					.slice(-2)
					.map(({ headers }) => headers["mcp-session-id"]),
			).toEqual(["health-session-2", "health-session-2"]);
		} finally {
			await client.close();
			await fake.close();
		}
	});

	it.each([
		{
			name: "HTTP",
			toolError: { kind: "http" as const, status: 503 },
			expected: "Health MCP server returned HTTP 503",
		},
		{
			name: "JSON-RPC",
			toolError: { kind: "json-rpc" as const, code: -32_603, message: "Internal error" },
			expected: "Health MCP JSON-RPC error -32603: Internal error",
		},
	])("propagates local $name error responses without retrying", async ({ toolError, expected }) => {
		const fake = await startFakeHealthStreamableHttpMcp({ toolError });
		const client = new HealthMcpClient(new StreamableHttpHealthMcpTransport(fake.url, 1_000));
		try {
			await expect(client.callTool("health.get_heart_rate", { window_s: 30 })).rejects.toThrow(expected);
			expect(fake.requests.filter(({ body }) => body?.method === "initialize")).toHaveLength(1);
			expect(fake.requests.filter(({ body }) => body?.method === "tools/call")).toHaveLength(1);
		} finally {
			await client.close();
			await fake.close();
		}
	});
});
