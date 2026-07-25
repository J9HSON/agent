import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type HealthWebhookNotification, parseHealthWebhookNotification } from "./health-contract.ts";
import type { HealthNotificationService } from "./health-service.ts";
import type { GatewayStore } from "./store.ts";

const HEALTH_WEBHOOK_PATH = "/v1/health-events";
const MAX_BODY_BYTES = 65_536;
const CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8\s*)?$/iu;

export interface HealthWebhookReceiverOptions {
	store: GatewayStore;
	healthService: HealthNotificationService;
}

export class HealthWebhookReceiver {
	private readonly store: GatewayStore;
	private readonly healthService: HealthNotificationService;

	constructor(options: HealthWebhookReceiverOptions) {
		this.store = options.store;
		this.healthService = options.healthService;
	}

	async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			sendJson(response, 405, { error: "method_not_allowed" }, { allow: "POST" });
			return;
		}
		if (request.url !== HEALTH_WEBHOOK_PATH) {
			sendJson(response, 404, { error: "not_found" });
			return;
		}
		if (!isAcceptedContentType(readSingleHeader(request, "content-type"))) {
			sendJson(response, 415, { error: "unsupported_media_type" });
			return;
		}

		const contentLengthText = readSingleHeader(request, "content-length");
		if (
			request.headers["transfer-encoding"] !== undefined ||
			contentLengthText === undefined ||
			!/^[0-9]+$/u.test(contentLengthText)
		) {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}
		const contentLength = Number(contentLengthText);
		if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}
		if (contentLength > MAX_BODY_BYTES) {
			sendJson(response, 413, { error: "body_too_large" });
			return;
		}

		let rawBody: Buffer;
		try {
			rawBody = await readRawBody(request);
		} catch {
			sendJson(response, 413, { error: "body_too_large" });
			return;
		}
		if (rawBody.length !== contentLength) {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}

		let notification: HealthWebhookNotification;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
			notification = parseHealthWebhookNotification(JSON.parse(text));
		} catch {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}

		const notificationIdHeader = readSingleHeader(request, "x-smart-collar-notification-id");
		if (notificationIdHeader !== notification.notification_id) {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}

		try {
			const digest = createHash("sha256").update(rawBody).digest("hex");
			const outcome = this.store.acceptHealthNotification(notification, rawBody, digest, new Date().toISOString());
			if (outcome === "conflict") {
				sendJson(response, 409, { error: "notification_id_conflict" });
				return;
			}
			if (outcome === "accepted") {
				this.healthService.notifyAccepted();
			}
			sendJson(response, 202, {
				notification_id: notification.notification_id,
				status: outcome,
			});
		} catch {
			sendJson(response, 503, { error: "internal_error" });
		}
	}
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_BODY_BYTES) {
			throw new Error("Health webhook body is too large");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, bytes);
}

function isAcceptedContentType(value: string | undefined): boolean {
	return value !== undefined && CONTENT_TYPE_PATTERN.test(value);
}

function readSingleHeader(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return typeof value === "string" ? value : undefined;
}

function sendJson(
	response: ServerResponse,
	statusCode: number,
	body: Readonly<Record<string, unknown>>,
	headers: Readonly<Record<string, string>> = {},
): void {
	response.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		...headers,
	});
	response.end(JSON.stringify(body));
}
