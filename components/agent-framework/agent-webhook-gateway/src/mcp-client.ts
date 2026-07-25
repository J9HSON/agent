import type { McpToolCaller } from "./types.ts";

type JsonObject = Record<string, unknown>;

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
		const response = await this.fetchFunction(this.endpointUrl, {
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
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`MCP server returned HTTP ${response.status}`);
		}

		const payload: unknown = await response.json();
		if (!isObject(payload)) {
			throw new Error("MCP server returned a non-object JSON response");
		}
		if (isObject(payload.error)) {
			const code = typeof payload.error.code === "number" ? payload.error.code : "unknown";
			const message = typeof payload.error.message === "string" ? payload.error.message : "unknown MCP error";
			throw new Error(`MCP server error ${code}: ${message}`);
		}
		if (!isObject(payload.result)) {
			throw new Error("MCP server response does not contain a result object");
		}

		const resultText = readResultText(payload.result);
		if (payload.result.isError === true) {
			throw new Error(resultText || "MCP server reported a tool execution error");
		}
		const toolError = readToolError(resultText);
		if (toolError) {
			throw new Error(toolError);
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
			return typeof payload.error === "string" ? payload.error : "MCP server reported a tool execution error";
		}
	} catch {
		return undefined;
	}
	return undefined;
}
