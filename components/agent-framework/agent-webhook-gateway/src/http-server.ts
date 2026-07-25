import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HealthWebhookReceiver } from "./health-webhook.ts";
import { consoleGatewayLogSink, type GatewayLogSink, writeGatewayLog } from "./logging.ts";
import { type AgentWebhookService, InstructionConflictError } from "./service.ts";

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(response: ServerResponse, statusCode: number, body: Readonly<Record<string, unknown>>): void {
	response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
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

function requestPath(request: IncomingMessage): string | null {
	if (!request.url) {
		return null;
	}
	try {
		return new URL(request.url, "http://gateway.invalid").pathname;
	} catch {
		return request.url.split(/[?#]/u, 1)[0] || null;
	}
}

export function createInstructionServer(
	service: AgentWebhookService,
	healthReceiver?: HealthWebhookReceiver,
	onLog: GatewayLogSink = consoleGatewayLogSink,
): Server {
	return createServer(async (request, response) => {
		const rejectRequest = (status: number, error: string, reason: string): void => {
			writeGatewayLog(onLog, "request.rejected", {
				method: request.method ?? null,
				path: requestPath(request),
				status,
				reason,
			});
			sendJson(response, status, { error });
		};
		if (request.url === "/v1/health-events" && healthReceiver) {
			await healthReceiver.handle(request, response);
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/instructions") {
			rejectRequest(404, "not_found", "not_found");
			return;
		}
		if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
			rejectRequest(400, "invalid_request", "invalid_content_type");
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
				rejectRequest(409, "instruction_id_conflict", "instruction_id_conflict");
				return;
			}
			if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("Request body"))) {
				rejectRequest(400, "invalid_request", error instanceof SyntaxError ? "invalid_json" : "invalid_schema");
				return;
			}
			if (
				error instanceof Error &&
				(error.message.startsWith("instruction_id") || error.message.startsWith("text must"))
			) {
				rejectRequest(400, "invalid_request", "invalid_schema");
				return;
			}
			rejectRequest(503, "persistence_unavailable", "persistence_unavailable");
		}
	});
}
