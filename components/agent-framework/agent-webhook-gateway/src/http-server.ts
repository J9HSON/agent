import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentWebhookService, InstructionConflictError } from "./service.ts";
import type { AgentReplyEvent } from "./types.ts";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_STATIC_DIRECTORY = fileURLToPath(new URL("../web", import.meta.url));

export interface AgentConsoleOptions {
	mapUrl?: string;
	staticDirectory?: string;
}

function sendJson(response: ServerResponse, statusCode: number, body: Readonly<Record<string, unknown>>): void {
	response.writeHead(statusCode, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
	});
	response.end(JSON.stringify(body));
}

function sendNoContent(response: ServerResponse): void {
	response.writeHead(204, {
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	response.end();
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	let body = "";
	let bytes = 0;
	request.setEncoding("utf8");
	for await (const chunk of request) {
		const text = String(chunk);
		bytes += Buffer.byteLength(text);
		if (bytes > MAX_BODY_BYTES) {
			throw new Error("Request body is too large");
		}
		body += text;
	}
	return JSON.parse(body);
}

function parseInstruction(value: unknown): { instructionId: string; text: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Request body must be a JSON object");
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== 2 || keys[0] !== "instruction_id" || keys[1] !== "text") {
		throw new Error("Request body must contain only instruction_id and text");
	}
	if (typeof record.instruction_id !== "string" || !record.instruction_id.trim()) {
		throw new Error("instruction_id must be a non-empty string");
	}
	if (typeof record.text !== "string" || !record.text.trim()) {
		throw new Error("text must be a non-empty string");
	}
	return { instructionId: record.instruction_id, text: record.text };
}

function parseReplyEvent(value: unknown): AgentReplyEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Reply body must be a JSON object");
	}
	const record = value as Record<string, unknown>;
	if (
		record.event !== "agent.reply.completed" ||
		typeof record.reply_id !== "string" ||
		typeof record.instruction_id !== "string" ||
		typeof record.text !== "string" ||
		typeof record.completed_at !== "string"
	) {
		throw new Error("Reply body does not match agent.reply.completed");
	}
	return {
		event: record.event,
		reply_id: record.reply_id,
		instruction_id: record.instruction_id,
		text: record.text,
		completed_at: record.completed_at,
	};
}

function instructionViewBody(service: AgentWebhookService, instructionId: string): Record<string, unknown> | undefined {
	const view = service.getInstructionView(instructionId);
	if (!view) {
		return undefined;
	}
	const task = view.task;
	return {
		instruction_id: view.instructionId,
		text: view.text,
		status: view.status,
		received_at: view.receivedAt,
		task: task
			? {
					task_id: task.taskId,
					destination: task.task.destination,
					compile_status: task.compileStatus,
					state: task.lastState ?? task.compileStatus,
					active: task.lastSnapshot?.active ?? false,
					route: task.route ?? null,
					route_leg_index: task.routeLegIndex ?? null,
					updated_at: task.updatedAt,
				}
			: null,
		reply: view.reply ?? null,
	};
}

function replyMatchesStored(service: AgentWebhookService, reply: AgentReplyEvent): boolean {
	const stored = service.getInstructionView(reply.instruction_id)?.reply;
	return (
		stored?.reply_id === reply.reply_id && stored.text === reply.text && stored.completed_at === reply.completed_at
	);
}

async function sendAsset(
	response: ServerResponse,
	staticDirectory: string,
	filename: string,
	contentType: string,
	frameOrigin: string,
): Promise<void> {
	try {
		const body = await readFile(join(staticDirectory, filename));
		response.writeHead(200, {
			"cache-control": "no-store",
			"content-security-policy": [
				"default-src 'self'",
				"base-uri 'none'",
				"form-action 'self'",
				"frame-ancestors 'none'",
				`frame-src ${frameOrigin}`,
				`connect-src 'self' ${frameOrigin}`,
				"img-src 'self' data:",
				"script-src 'self'",
				"style-src 'self'",
			].join("; "),
			"content-type": contentType,
			"x-content-type-options": "nosniff",
		});
		response.end(body);
	} catch {
		sendJson(response, 500, { error: "console_asset_unavailable" });
	}
}

export function createInstructionServer(service: AgentWebhookService, options: AgentConsoleOptions = {}): Server {
	const mapUrl = new URL(options.mapUrl ?? "http://127.0.0.1:9878/");
	const staticDirectory = options.staticDirectory ?? DEFAULT_STATIC_DIRECTORY;
	const frameOrigin = mapUrl.origin;
	return createServer(async (request, response) => {
		const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method === "GET" && requestUrl.pathname === "/") {
			await sendAsset(response, staticDirectory, "index.html", "text/html; charset=utf-8", frameOrigin);
			return;
		}
		if (request.method === "GET" && requestUrl.pathname === "/app.js") {
			await sendAsset(response, staticDirectory, "app.js", "text/javascript; charset=utf-8", frameOrigin);
			return;
		}
		if (request.method === "GET" && requestUrl.pathname === "/styles.css") {
			await sendAsset(response, staticDirectory, "styles.css", "text/css; charset=utf-8", frameOrigin);
			return;
		}
		if (request.method === "GET" && requestUrl.pathname === "/favicon.ico") {
			sendNoContent(response);
			return;
		}
		if (request.method === "GET" && requestUrl.pathname === "/v1/ui-config") {
			sendJson(response, 200, { map_url: mapUrl.toString() });
			return;
		}
		if (request.method === "GET" && requestUrl.pathname.startsWith("/v1/instructions/")) {
			const instructionId = decodeURIComponent(requestUrl.pathname.slice("/v1/instructions/".length));
			const body = instructionViewBody(service, instructionId);
			if (!body) {
				sendJson(response, 404, { error: "instruction_not_found" });
				return;
			}
			sendJson(response, 200, body);
			return;
		}
		if (request.method === "POST" && requestUrl.pathname === "/v1/ui-replies") {
			try {
				const reply = parseReplyEvent(await readJsonBody(request));
				if (!replyMatchesStored(service, reply)) {
					sendJson(response, 409, { error: "reply_mismatch" });
					return;
				}
				sendNoContent(response);
			} catch {
				sendJson(response, 400, { error: "invalid_reply" });
			}
			return;
		}
		if (request.method !== "POST" || requestUrl.pathname !== "/v1/instructions") {
			sendJson(response, 404, { error: "not_found" });
			return;
		}
		if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}

		try {
			const instruction = parseInstruction(await readJsonBody(request));
			service.acceptInstruction(instruction);
			sendJson(response, 202, {
				instruction_id: instruction.instructionId,
				status: "accepted",
			});
		} catch (error) {
			if (error instanceof InstructionConflictError) {
				sendJson(response, 409, { error: "instruction_id_conflict" });
				return;
			}
			if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("Request body"))) {
				sendJson(response, 400, { error: "invalid_request" });
				return;
			}
			if (
				error instanceof Error &&
				(error.message.startsWith("instruction_id") || error.message.startsWith("text must"))
			) {
				sendJson(response, 400, { error: "invalid_request" });
				return;
			}
			sendJson(response, 503, { error: "persistence_unavailable" });
		}
	});
}
