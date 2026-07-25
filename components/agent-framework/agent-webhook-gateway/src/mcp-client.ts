import type { McpToolCaller } from "./types.ts";

type JsonObject = Record<string, unknown>;
export type McpCallErrorKind = "unavailable" | "timeout" | "protocol" | "rejected";

export class McpCallError extends Error {
	readonly kind: McpCallErrorKind;

	constructor(kind: McpCallErrorKind, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "McpCallError";
		this.kind = kind;
	}
}

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class HttpMcpToolClient implements McpToolCaller {
	private readonly endpointUrl: string;
	private readonly timeoutMs: number;
	private readonly fetchFunction: typeof fetch;
	private nextRequestId = 1;

	constructor(endpointUrl: string, timeoutMs: number, fetchFunction: typeof fetch = fetch) {
		this.endpointUrl = endpointUrl;
		this.timeoutMs = timeoutMs;
		this.fetchFunction = fetchFunction;
	}

	async callTool(
		name: string,
		arguments_: Readonly<Record<string, unknown>>,
		externalSignal?: AbortSignal,
	): Promise<string> {
		const requestId = this.nextRequestId++;
		const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
		const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
		let response: Response;
		try {
			response = await this.fetchFunction(this.endpointUrl, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: requestId,
					method: "tools/call",
					params: { name, arguments: arguments_ },
				}),
				signal,
			});
		} catch (error) {
			if (externalSignal?.aborted) {
				throw error;
			}
			if (timeoutSignal.aborted) {
				throw new McpCallError("timeout", "MCP wrapper request timed out", { cause: error });
			}
			throw new McpCallError("unavailable", "MCP wrapper is unavailable", { cause: error });
		}
		if (!response.ok) {
			await response.body?.cancel();
			if (response.status === 408 || response.status === 504) {
				throw new McpCallError("timeout", `MCP wrapper returned HTTP ${response.status}`);
			}
			if (response.status >= 500) {
				throw new McpCallError("unavailable", `MCP wrapper returned HTTP ${response.status}`);
			}
			throw new McpCallError("protocol", `MCP wrapper returned HTTP ${response.status}`);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new McpCallError("protocol", "MCP wrapper returned invalid JSON", { cause: error });
		}
		if (!isObject(payload)) {
			throw new McpCallError("protocol", "MCP wrapper returned a non-object JSON response");
		}
		if (isObject(payload.error)) {
			const code = typeof payload.error.code === "number" ? payload.error.code : "unknown";
			const message = typeof payload.error.message === "string" ? payload.error.message : "unknown MCP error";
			throw new McpCallError("rejected", `MCP wrapper error ${code}: ${message}`);
		}
		if (!isObject(payload.result)) {
			throw new McpCallError("protocol", "MCP wrapper response does not contain a result object");
		}

		const resultText = readResultText(payload.result);
		if (payload.result.isError === true) {
			throw new McpCallError("rejected", resultText || "MCP wrapper reported a tool execution error");
		}
		const toolError = readToolError(resultText);
		if (toolError) {
			throw new McpCallError("rejected", toolError);
		}
		return resultText || JSON.stringify(payload.result);
	}
}

function readResultText(result: JsonObject): string {
	const content = result.content;
	if (Array.isArray(content)) {
		const text = content
			.filter(
				(item): item is { type: "text"; text: string } =>
					isObject(item) && item.type === "text" && typeof item.text === "string",
			)
			.map((item) => item.text)
			.join("\n");
		if (text) {
			return text;
		}
	}
	return "";
}

function readToolError(resultText: string): string | undefined {
	if (resultText.startsWith("Error running tool '")) {
		return resultText;
	}
	try {
		const payload: unknown = JSON.parse(resultText);
		if (isObject(payload) && payload.status === "error") {
			return typeof payload.error === "string" ? payload.error : "MCP wrapper reported a tool execution error";
		}
	} catch {
		return undefined;
	}
	return undefined;
}
