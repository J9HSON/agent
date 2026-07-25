import { describe, expect, it } from "vitest";
import { HttpMcpToolClient, McpCallError } from "../src/mcp-client.ts";

describe("HTTP MCP tool client", () => {
	it("sends exactly one tools/call request and returns the upstream text", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const client = new HttpMcpToolClient("http://127.0.0.1:9991/mcp", 1_000, async (url, init) => {
			requests.push({ url: String(url), init });
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						content: [{ type: "text", text: "motion accepted" }],
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		await expect(client.callTool("move_forward", { speed_mps: 0.3, duration_s: 4 })).resolves.toBe("motion accepted");
		expect(requests).toHaveLength(1);
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "move_forward",
				arguments: { speed_mps: 0.3, duration_s: 4 },
			},
		});
	});

	it("treats an MCP tool result marked isError as a failed call", async () => {
		const client = new HttpMcpToolClient("http://127.0.0.1:9991/mcp", 1_000, async () => {
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						isError: true,
						content: [{ type: "text", text: "upstream stop failed" }],
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		await expect(client.callTool("stop_all", {})).rejects.toThrow("upstream stop failed");
	});

	it("treats a DIMOS wrapped exception as a failed call", async () => {
		const client = new HttpMcpToolClient("http://127.0.0.1:9991/mcp", 1_000, async () => {
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						content: [{ type: "text", text: "Error running tool 'stop_all': transport failed" }],
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		await expect(client.callTool("stop_all", {})).rejects.toThrow("transport failed");
	});

	it("treats a structured wrapper error as a failed call", async () => {
		const client = new HttpMcpToolClient("http://127.0.0.1:9991/mcp", 1_000, async () => {
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						content: [{ type: "text", text: '{"status":"error","error":"movement is busy"}' }],
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		await expect(client.callTool("move_forward", {})).rejects.toThrow("movement is busy");
	});

	it("classifies an unreachable wrapper without exposing transport details to callers", async () => {
		const client = new HttpMcpToolClient("http://127.0.0.1:9991/mcp", 1_000, async () => {
			throw new TypeError("fetch failed", {
				cause: new Error("connect ECONNREFUSED 127.0.0.1:9991"),
			});
		});

		const error = await client.callTool("stop_all", {}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(McpCallError);
		expect((error as McpCallError).kind).toBe("unavailable");
		expect((error as McpCallError).message).toBe("MCP wrapper is unavailable");
	});

	it("classifies a wrapper timeout as an ambiguous result", async () => {
		const client = new HttpMcpToolClient("http://127.0.0.1:9991/mcp", 1, async (_url, init) => {
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		});

		const error = await client.callTool("relative_move", {}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(McpCallError);
		expect((error as McpCallError).kind).toBe("timeout");
	});
});
