import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonObject } from "../../src/health-contract.ts";

export interface FakeHealthToolResponse {
	isError?: boolean;
	structuredContent: JsonObject;
}

export interface FakeHealthStreamableHttpMcpOptions {
	responseFormat?: "json" | "sse";
	expireFirstToolSession?: boolean;
	expireConcurrentSession?: boolean;
	toolError?:
		| {
				kind: "http";
				status: number;
		  }
		| {
				kind: "json-rpc";
				code: number;
				message: string;
		  };
	callTool?: (name: string, arguments_: JsonObject) => FakeHealthToolResponse;
}

export interface FakeHealthMcpRequest {
	httpMethod: string;
	headers: IncomingHttpHeaders;
	body: JsonObject | undefined;
}

export interface FakeHealthStreamableHttpMcp {
	url: string;
	server: Server;
	requests: FakeHealthMcpRequest[];
	close(): Promise<void>;
}

function writeJsonRpcResponse(
	response: ServerResponse<IncomingMessage>,
	responseFormat: "json" | "sse",
	payload: JsonObject,
	headers: Readonly<Record<string, string>> = {},
): void {
	if (responseFormat === "json") {
		response.writeHead(200, { "content-type": "application/json", ...headers });
		response.end(JSON.stringify(payload));
		return;
	}
	response.writeHead(200, { "content-type": "text/event-stream", ...headers });
	response.end(
		["id: bootstrap", "data:", "", "event: message", `data: ${JSON.stringify(payload)}`, "", ""].join("\n"),
	);
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Expected a JSON object request body");
	}
	return payload as JsonObject;
}

export async function startFakeHealthStreamableHttpMcp(
	options: FakeHealthStreamableHttpMcpOptions = {},
): Promise<FakeHealthStreamableHttpMcp> {
	const responseFormat = options.responseFormat ?? "json";
	const requests: FakeHealthMcpRequest[] = [];
	const activeSessions = new Set<string>();
	let nextSessionNumber = 1;
	let toolRequestCount = 0;
	let releaseDelayedExpiredResponse: (() => void) | undefined;

	const server = createServer((request, response) => {
		void (async () => {
			const httpMethod = request.method ?? "GET";
			if (httpMethod === "DELETE") {
				requests.push({ httpMethod, headers: { ...request.headers }, body: undefined });
				const sessionId = request.headers["mcp-session-id"];
				if (typeof sessionId === "string") {
					activeSessions.delete(sessionId);
				}
				response.writeHead(204);
				response.end();
				return;
			}
			if (httpMethod !== "POST") {
				response.writeHead(405);
				response.end();
				return;
			}

			const body = await readJsonBody(request);
			requests.push({ httpMethod, headers: { ...request.headers }, body });
			const method = body.method;
			if (method === "initialize") {
				const sessionId = `health-session-${nextSessionNumber++}`;
				activeSessions.add(sessionId);
				writeJsonRpcResponse(
					response,
					responseFormat,
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							serverInfo: { name: "fake-health-mcp", version: "0.3.0" },
						},
					},
					{ "mcp-session-id": sessionId },
				);
				return;
			}

			const sessionId = request.headers["mcp-session-id"];
			if (typeof sessionId !== "string" || !activeSessions.has(sessionId)) {
				response.writeHead(typeof sessionId === "string" ? 404 : 400);
				response.end();
				return;
			}
			if (request.headers["mcp-protocol-version"] !== "2025-11-25") {
				response.writeHead(400);
				response.end();
				return;
			}
			if (method === "notifications/initialized") {
				response.writeHead(202);
				response.end();
				if (sessionId === "health-session-2") {
					releaseDelayedExpiredResponse?.();
					releaseDelayedExpiredResponse = undefined;
				}
				return;
			}
			if (method !== "tools/call") {
				response.writeHead(400);
				response.end();
				return;
			}

			toolRequestCount += 1;
			if (options.expireConcurrentSession && sessionId === "health-session-1") {
				if (toolRequestCount === 1) {
					await new Promise<void>((resolve) => {
						releaseDelayedExpiredResponse = () => {
							response.writeHead(404);
							response.end();
							resolve();
						};
					});
					return;
				}
				activeSessions.delete(sessionId);
				response.writeHead(404);
				response.end();
				return;
			}
			if (options.expireFirstToolSession && toolRequestCount === 1) {
				activeSessions.delete(sessionId);
				response.writeHead(404);
				response.end();
				return;
			}
			if (options.toolError?.kind === "http") {
				response.writeHead(options.toolError.status);
				response.end();
				return;
			}
			if (options.toolError?.kind === "json-rpc") {
				writeJsonRpcResponse(response, responseFormat, {
					jsonrpc: "2.0",
					id: body.id,
					error: {
						code: options.toolError.code,
						message: options.toolError.message,
					},
				});
				return;
			}

			const params =
				body.params && typeof body.params === "object" && !Array.isArray(body.params)
					? (body.params as JsonObject)
					: {};
			const name = typeof params.name === "string" ? params.name : "";
			const arguments_ =
				params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
					? (params.arguments as JsonObject)
					: {};
			const toolResponse = options.callTool?.(name, arguments_) ?? {
				structuredContent: {
					ok: true,
					data: { echoed_tool: name },
					meta: {},
					error: null,
				},
			};
			writeJsonRpcResponse(response, responseFormat, {
				jsonrpc: "2.0",
				id: body.id,
				result: {
					content: [{ type: "text", text: JSON.stringify(toolResponse.structuredContent) }],
					structuredContent: toolResponse.structuredContent,
					isError: toolResponse.isError ?? false,
				},
			});
		})().catch((error: unknown) => {
			response.writeHead(500, { "content-type": "text/plain" });
			response.end(error instanceof Error ? error.message : String(error));
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		server,
		requests,
		close: async () => {
			releaseDelayedExpiredResponse?.();
			releaseDelayedExpiredResponse = undefined;
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}
