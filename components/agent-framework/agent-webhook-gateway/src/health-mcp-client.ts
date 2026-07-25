import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import {
	type HealthMcpToolCaller,
	type HealthMcpToolResult,
	isJsonObject,
	type JsonObject,
} from "./health-contract.ts";

const MCP_PROTOCOL_VERSION = "2025-11-25";

export class HealthMcpProtocolError extends Error {}

export class HealthMcpSessionExpiredError extends Error {}

export interface HealthMcpJsonRpcTransport {
	readonly sessionGeneration?: number;
	request(method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject>;
	notify(method: string, params: JsonObject): Promise<void>;
	close(): Promise<void>;
}

export class StreamableHttpHealthMcpTransport implements HealthMcpJsonRpcTransport {
	private readonly endpointUrl: string;
	private readonly timeoutMs: number;
	private readonly fetchFunction: typeof fetch;
	private nextRequestId = 1;
	private sessionId?: string;
	private closed = false;
	private generation = 0;

	get sessionGeneration(): number {
		return this.generation;
	}

	constructor(endpointUrl: string, timeoutMs: number, fetchFunction: typeof fetch = fetch) {
		this.endpointUrl = endpointUrl;
		this.timeoutMs = timeoutMs;
		this.fetchFunction = fetchFunction;
	}

	async request(method: string, params: JsonObject, externalSignal?: AbortSignal): Promise<JsonObject> {
		this.ensureOpen();
		const id = this.nextRequestId++;
		const sessionId = this.sessionId;
		const response = await this.postJsonRpc({ jsonrpc: "2.0", id, method, params }, externalSignal, sessionId);
		if (response.status === 404 && sessionId) {
			await response.body?.cancel();
			this.invalidateSession(sessionId);
			throw new HealthMcpSessionExpiredError("Health MCP HTTP session expired");
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Health MCP server returned HTTP ${response.status}`);
		}
		const result = await readHttpJsonRpcResult(response, id);
		if (method === "initialize") {
			this.captureSession(response.headers.get("mcp-session-id"));
		}
		return result;
	}

	async notify(method: string, params: JsonObject): Promise<void> {
		this.ensureOpen();
		const sessionId = this.sessionId;
		const response = await this.postJsonRpc({ jsonrpc: "2.0", method, params }, undefined, sessionId);
		if (response.status === 404 && sessionId) {
			await response.body?.cancel();
			this.invalidateSession(sessionId);
			throw new HealthMcpSessionExpiredError("Health MCP HTTP session expired");
		}
		if (response.status !== 202) {
			await response.body?.cancel();
			throw new Error(`Health MCP notification returned HTTP ${response.status}; expected 202`);
		}
		await response.body?.cancel();
	}

	private async postJsonRpc(
		message: JsonObject,
		externalSignal: AbortSignal | undefined,
		sessionId: string | undefined,
	): Promise<Response> {
		const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
		const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
		const headers = new Headers({
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
		});
		if (message.method !== "initialize") {
			headers.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
		}
		if (sessionId) {
			headers.set("mcp-session-id", sessionId);
		}
		return await this.fetchFunction(this.endpointUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(message),
			signal,
		});
	}

	private captureSession(sessionId: string | null): void {
		if (sessionId === null) {
			return;
		}
		if (!/^[\x21-\x7e]+$/u.test(sessionId)) {
			throw new HealthMcpProtocolError("Health MCP returned an invalid MCP-Session-Id");
		}
		this.sessionId = sessionId;
	}

	private invalidateSession(expiredSessionId: string): void {
		if (this.sessionId !== expiredSessionId) {
			return;
		}
		this.sessionId = undefined;
		this.generation += 1;
	}

	private ensureOpen(): void {
		if (this.closed) {
			throw new Error("Health MCP HTTP transport is closed");
		}
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const sessionId = this.sessionId;
		this.sessionId = undefined;
		if (!sessionId) {
			return;
		}
		try {
			const response = await this.fetchFunction(this.endpointUrl, {
				method: "DELETE",
				headers: {
					accept: "application/json, text/event-stream",
					"mcp-protocol-version": MCP_PROTOCOL_VERSION,
					"mcp-session-id": sessionId,
				},
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			await response.body?.cancel();
		} catch {
			// Session termination is best effort during gateway shutdown.
		}
	}
}

async function readHttpJsonRpcResult(response: Response, requestId: number): Promise<JsonObject> {
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType === "application/json") {
		return readJsonRpcResult(await response.json(), requestId);
	}
	if (contentType === "text/event-stream") {
		const messages = readSseJsonMessages(await response.text());
		for (const message of messages) {
			if (isJsonObject(message) && message.id === requestId) {
				return readJsonRpcResult(message, requestId);
			}
		}
		throw new HealthMcpProtocolError(`Health MCP SSE response did not contain JSON-RPC id ${requestId}`);
	}
	await response.body?.cancel();
	throw new HealthMcpProtocolError(`Health MCP returned unsupported Content-Type ${contentType ?? "(missing)"}`);
}

function readSseJsonMessages(body: string): unknown[] {
	const messages: unknown[] = [];
	const normalized = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	for (const event of normalized.split("\n\n")) {
		const data = event
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data) {
			continue;
		}
		try {
			messages.push(JSON.parse(data));
		} catch {
			throw new HealthMcpProtocolError("Health MCP SSE response contains invalid JSON");
		}
	}
	return messages;
}

function readJsonRpcResult(payload: unknown, requestId: number | string): JsonObject {
	if (!isJsonObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== requestId) {
		throw new HealthMcpProtocolError("Health MCP JSON-RPC response has an invalid version or id");
	}
	if (isJsonObject(payload.error)) {
		const code = typeof payload.error.code === "number" ? payload.error.code : "unknown";
		const message = typeof payload.error.message === "string" ? payload.error.message : "unknown JSON-RPC error";
		throw new HealthMcpProtocolError(`Health MCP JSON-RPC error ${code}: ${message}`);
	}
	if (!isJsonObject(payload.result)) {
		throw new HealthMcpProtocolError("Health MCP JSON-RPC response is missing result");
	}
	return payload.result;
}

export class HealthMcpClient implements HealthMcpToolCaller {
	private readonly transport: HealthMcpJsonRpcTransport;
	private initializePromise?: Promise<void>;
	private initializingGeneration?: number;
	private initializedGeneration?: number;

	constructor(transport: HealthMcpJsonRpcTransport) {
		this.transport = transport;
	}

	async callTool(
		name: string,
		arguments_: Readonly<Record<string, unknown>>,
		signal?: AbortSignal,
	): Promise<HealthMcpToolResult> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				await this.initialize();
				const result = await this.transport.request(
					"tools/call",
					{
						name,
						arguments: { ...arguments_ },
					},
					signal,
				);
				const structuredContent = result.structuredContent;
				const content = result.content;
				if (!isJsonObject(structuredContent) || typeof result.isError !== "boolean") {
					throw new HealthMcpProtocolError("Health MCP tools/call result is missing structuredContent or isError");
				}
				if (!Array.isArray(content) || content.length !== 1) {
					throw new HealthMcpProtocolError("Health MCP tools/call result must contain exactly one TextContent");
				}
				const textContent = content[0];
				if (!isJsonObject(textContent) || textContent.type !== "text" || typeof textContent.text !== "string") {
					throw new HealthMcpProtocolError("Health MCP tools/call result contains invalid TextContent");
				}
				let textEnvelope: unknown;
				try {
					textEnvelope = JSON.parse(textContent.text);
				} catch {
					throw new HealthMcpProtocolError("Health MCP TextContent is not valid JSON");
				}
				if (!isDeepStrictEqual(textEnvelope, structuredContent)) {
					throw new HealthMcpProtocolError("Health MCP TextContent does not equal structuredContent");
				}
				return {
					isError: result.isError,
					structuredContent,
				};
			} catch (error) {
				if (attempt === 0 && error instanceof HealthMcpSessionExpiredError) {
					continue;
				}
				throw error;
			}
		}
	}

	private initialize(): Promise<void> {
		const generation = this.transport.sessionGeneration;
		if (
			this.initializePromise &&
			(generation === undefined ||
				generation === this.initializingGeneration ||
				generation === this.initializedGeneration)
		) {
			return this.initializePromise;
		}
		this.initializingGeneration = generation;
		const tracked = this.initializeTransport().then(
			() => {
				if (this.initializePromise === tracked) {
					this.initializingGeneration = undefined;
				}
			},
			(error: unknown) => {
				if (this.initializePromise === tracked) {
					this.initializePromise = undefined;
					this.initializingGeneration = undefined;
					this.initializedGeneration = undefined;
				}
				throw error;
			},
		);
		this.initializePromise = tracked;
		return tracked;
	}

	private async initializeTransport(): Promise<void> {
		const result = await this.transport.request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: {
				name: "pi-health-consumer",
				version: "0.2.0",
			},
		});
		const negotiatedGeneration = this.transport.sessionGeneration;
		if (
			result.protocolVersion !== MCP_PROTOCOL_VERSION ||
			!isJsonObject(result.capabilities) ||
			!isJsonObject(result.serverInfo)
		) {
			throw new HealthMcpProtocolError(`Health MCP server did not negotiate protocol ${MCP_PROTOCOL_VERSION}`);
		}
		await this.transport.notify("notifications/initialized", {});
		if (this.transport.sessionGeneration !== negotiatedGeneration) {
			throw new Error("Health MCP transport session changed during initialization");
		}
		this.initializedGeneration = negotiatedGeneration;
	}

	async close(): Promise<void> {
		await this.transport.close();
	}
}

interface PendingRequest {
	resolve: (value: JsonObject) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
	signal: AbortSignal | undefined;
	abortListener: (() => void) | undefined;
}

export class StdioHealthMcpTransport implements HealthMcpJsonRpcTransport {
	private readonly command: string;
	private readonly args: readonly string[];
	private readonly timeoutMs: number;
	private child?: ChildProcessWithoutNullStreams;
	private lines?: ReadlineInterface;
	private readonly pending = new Map<string, PendingRequest>();
	private nextRequestId = 1;
	private closed = false;
	private generation = 0;

	get sessionGeneration(): number {
		return this.generation;
	}

	constructor(command: string, args: readonly string[], timeoutMs: number) {
		this.command = command;
		this.args = args;
		this.timeoutMs = timeoutMs;
	}

	async request(method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
		const child = this.ensureStarted();
		const id = this.nextRequestId++;
		const key = String(id);
		return await new Promise<JsonObject>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.rejectPending(key, new Error(`Health MCP request timed out after ${this.timeoutMs} ms`));
			}, this.timeoutMs);
			timeout.unref();
			const abortListener = signal
				? () => this.rejectPending(key, new Error("Health MCP request was aborted"))
				: undefined;
			if (signal?.aborted) {
				clearTimeout(timeout);
				reject(new Error("Health MCP request was aborted"));
				return;
			}
			if (signal && abortListener) {
				signal.addEventListener("abort", abortListener, { once: true });
			}
			this.pending.set(key, { resolve, reject, timeout, signal, abortListener });
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, "utf8", (error) => {
				if (error) {
					this.rejectPending(key, error);
				}
			});
		});
	}

	async notify(method: string, params: JsonObject): Promise<void> {
		const child = this.ensureStarted();
		await new Promise<void>((resolve, reject) => {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf8", (error) => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}

	private ensureStarted(): ChildProcessWithoutNullStreams {
		if (this.closed) {
			throw new Error("Health MCP stdio transport is closed");
		}
		if (this.child) {
			return this.child;
		}
		const child = spawn(this.command, [...this.args], {
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
		this.lines = createInterface({ input: child.stdout });
		this.lines.on("line", (line) => this.handleLine(line));
		child.once("error", (error) => {
			this.clearExitedChild(child);
			this.failAll(error);
		});
		child.once("exit", (code, signal) => {
			this.clearExitedChild(child);
			if (!this.closed) {
				this.failAll(new Error(`Health MCP process exited (code=${String(code)}, signal=${String(signal)})`));
			}
		});
		child.stderr.pipe(process.stderr, { end: false });
		return child;
	}

	private clearExitedChild(child: ChildProcessWithoutNullStreams): void {
		if (this.child !== child) {
			return;
		}
		this.lines?.close();
		this.lines = undefined;
		this.child = undefined;
		this.generation += 1;
	}

	private handleLine(line: string): void {
		let payload: unknown;
		try {
			payload = JSON.parse(line);
		} catch {
			this.failAll(new HealthMcpProtocolError("Health MCP wrote invalid JSON to stdout"));
			return;
		}
		if (!isJsonObject(payload) || (typeof payload.id !== "number" && typeof payload.id !== "string")) {
			return;
		}
		const key = String(payload.id);
		const pending = this.takePending(key);
		if (!pending) {
			return;
		}
		try {
			pending.resolve(readJsonRpcResult(payload, payload.id));
		} catch (error) {
			pending.reject(error instanceof Error ? error : new HealthMcpProtocolError(String(error)));
		}
	}

	private rejectPending(key: string, error: Error): void {
		this.takePending(key)?.reject(error);
	}

	private takePending(key: string): PendingRequest | undefined {
		const pending = this.pending.get(key);
		if (!pending) {
			return undefined;
		}
		this.pending.delete(key);
		clearTimeout(pending.timeout);
		if (pending.signal && pending.abortListener) {
			pending.signal.removeEventListener("abort", pending.abortListener);
		}
		return pending;
	}

	private failAll(error: Error): void {
		for (const key of [...this.pending.keys()]) {
			this.rejectPending(key, error);
		}
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.lines?.close();
		this.failAll(new Error("Health MCP stdio transport closed"));
		const child = this.child;
		if (!child) {
			return;
		}
		child.stdin.end();
		if (child.exitCode === null && child.signalCode === null) {
			child.kill();
		}
	}
}
