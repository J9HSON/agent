import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	HealthMcpClient,
	type HealthMcpJsonRpcTransport,
	type JsonObject,
	StdioHealthMcpTransport,
	StreamableHttpHealthMcpTransport,
} from "../src/index.ts";

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
				client.callTool("health.get_device_status", { wearer_id: "xwen" }),
				client.callTool("health.get_device_status", { wearer_id: "xwen" }),
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

		await expect(
			new HealthMcpClient(transport).callTool("health.get_device_status", { wearer_id: "xwen" }),
		).rejects.toThrow("TextContent does not equal structuredContent");
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

		await client.callTool("health.get_device_status", { wearer_id: "xwen" });
		transport.sessionGeneration += 1;
		await client.callTool("health.get_device_status", { wearer_id: "xwen" });

		expect(requests).toEqual(["initialize", "tools/call", "initialize", "tools/call"]);
	});

	it("exchanges newline-delimited JSON-RPC with a stdio child process", async () => {
		const fixturePath = fileURLToPath(new URL("./support/fake-health-mcp.mjs", import.meta.url));
		const client = new HealthMcpClient(new StdioHealthMcpTransport(process.execPath, [fixturePath], 1_000));

		await expect(client.callTool("health.get_device_status", { wearer_id: "xwen" })).resolves.toMatchObject({
			isError: false,
			structuredContent: {
				ok: true,
				data: { echoed_tool: "health.get_device_status" },
			},
		});

		await client.close();
	});

	it("uses remote Streamable HTTP with session headers and no authentication", async () => {
		const requests: Array<{ url: string; method: string; headers: Headers; body: JsonObject | undefined }> = [];
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
		const fetchFunction: typeof fetch = async (input, init) => {
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as JsonObject) : undefined;
			const request = {
				url: String(input),
				method: init?.method ?? "GET",
				headers: new Headers(init?.headers),
				body,
			};
			requests.push(request);
			if (request.method === "DELETE") {
				return new Response(null, { status: 204 });
			}
			if (body?.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			if (body?.method === "initialize") {
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							serverInfo: { name: "smart-neckband-health", version: "0.2.0" },
						},
					},
					{
						headers: {
							"content-type": "application/json",
							"mcp-session-id": "health-session-1",
						},
					},
				);
			}
			return Response.json({
				jsonrpc: "2.0",
				id: body?.id,
				result: {
					content: [{ type: "text", text: JSON.stringify(envelope) }],
					structuredContent: envelope,
					isError: false,
				},
			});
		};
		const client = new HealthMcpClient(
			new StreamableHttpHealthMcpTransport("http://health-host:8765/mcp", 1_000, fetchFunction),
		);

		await expect(client.callTool("health.get_device_status", { wearer_id: "xwen" })).resolves.toEqual({
			isError: false,
			structuredContent: envelope,
		});
		await client.close();

		expect(requests.map(({ method, body }) => [method, body?.method])).toEqual([
			["POST", "initialize"],
			["POST", "notifications/initialized"],
			["POST", "tools/call"],
			["DELETE", undefined],
		]);
		expect(requests.every(({ url }) => url === "http://health-host:8765/mcp")).toBe(true);
		expect(requests[0]?.headers.get("accept")).toBe("application/json, text/event-stream");
		expect(requests[0]?.headers.has("mcp-session-id")).toBe(false);
		expect(requests[0]?.headers.has("mcp-protocol-version")).toBe(false);
		for (const request of requests.slice(1)) {
			expect(request.headers.get("mcp-session-id")).toBe("health-session-1");
			expect(request.headers.get("mcp-protocol-version")).toBe("2025-11-25");
		}
		expect(requests.every(({ headers }) => !headers.has("authorization"))).toBe(true);
	});

	it("accepts a Streamable HTTP SSE response for a tool call", async () => {
		const envelope = { ok: true, data: {}, meta: {}, error: null };
		const fetchFunction: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as JsonObject;
			if (body.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			const result =
				body.method === "initialize"
					? {
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							serverInfo: { name: "smart-neckband-health", version: "0.2.0" },
						}
					: {
							content: [{ type: "text", text: JSON.stringify(envelope) }],
							structuredContent: envelope,
							isError: false,
						};
			return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		};
		const client = new HealthMcpClient(
			new StreamableHttpHealthMcpTransport("http://health-host:8765/mcp", 1_000, fetchFunction),
		);

		await expect(client.callTool("health.get_device_status", { wearer_id: "xwen" })).resolves.toEqual({
			isError: false,
			structuredContent: envelope,
		});
	});

	it("invalidates an expired HTTP session so the client reinitializes on retry", async () => {
		const initializeHeaders: Headers[] = [];
		let initializeCount = 0;
		const envelope = { ok: true, data: {}, meta: {}, error: null };
		const fetchFunction: typeof fetch = async (_input, init) => {
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body)) as JsonObject;
			if (body.method === "initialize") {
				initializeHeaders.push(headers);
				initializeCount += 1;
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							serverInfo: { name: "smart-neckband-health", version: "0.2.0" },
						},
					},
					{ headers: { "mcp-session-id": `health-session-${initializeCount}` } },
				);
			}
			if (body.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			if (headers.get("mcp-session-id") === "health-session-1") {
				return new Response(null, { status: 404 });
			}
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					content: [{ type: "text", text: JSON.stringify(envelope) }],
					structuredContent: envelope,
					isError: false,
				},
			});
		};
		const client = new HealthMcpClient(
			new StreamableHttpHealthMcpTransport("http://health-host:8765/mcp", 1_000, fetchFunction),
		);

		await expect(client.callTool("health.get_device_status", { wearer_id: "xwen" })).rejects.toThrow(
			"session expired",
		);
		await expect(client.callTool("health.get_device_status", { wearer_id: "xwen" })).resolves.toEqual({
			isError: false,
			structuredContent: envelope,
		});
		expect(initializeHeaders).toHaveLength(2);
		expect(initializeHeaders.every((headers) => !headers.has("mcp-session-id"))).toBe(true);
	});
});
