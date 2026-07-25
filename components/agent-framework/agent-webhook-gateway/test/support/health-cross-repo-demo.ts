import { equal, ok } from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { HealthMcpClient, StdioHealthMcpTransport } from "../../src/health-mcp-client.ts";
import { HealthNotificationService, type HealthProcessingOutcome } from "../../src/health-service.ts";
import { HealthWebhookReceiver } from "../../src/health-webhook.ts";
import { createInstructionServer } from "../../src/http-server.ts";
import { AgentWebhookService } from "../../src/service.ts";
import { GatewayStore } from "../../src/store.ts";

const execFileAsync = promisify(execFile);
const WEARER_ID = "xwen";
const CURRENT_KEY_ID = "health-integration-current";
const CURRENT_SECRET_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

interface UpstreamFixtureSummary {
	notification_id: string;
	event_id: string;
	event_revision: number;
	state_revision: number;
	raw_body_base64: string;
	raw_body_sha256: string;
	raw_body_byte_length: number;
	http_status: number;
	attempt_count: number;
}

export interface HealthCrossRepoDemoOptions {
	upstreamRoot: string;
	upstreamPython: string;
}

export interface HealthCrossRepoDemoSummary {
	initialAck: string;
	initialOutcome: HealthProcessingOutcome;
	duplicateAck: string;
	conflictStatus: number;
	unauthenticatedStatus: number;
	legacyAuthenticationHeadersStatus: number;
	headerMismatchStatus: number;
	schemaRejectionStatus: number;
	replayOutcome: HealthProcessingOutcome;
	eventMismatchOutcome: HealthProcessingOutcome;
	concurrentAcks: { accepted: number; duplicate: number };
	healthMcpCalls: number;
	upstreamDeliveryStatus: number;
	rawBodySha256: string;
	rawBodyByteLength: number;
	agentRuns: number;
	dimosCalls: number;
	robotCalls: number;
}

interface HealthResponse {
	status: number;
	body: Record<string, unknown>;
}

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected an IPv4 test server address");
	}
	return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}
	await new Promise<void>((resolveClose, reject) => {
		server.close((error) => (error ? reject(error) : resolveClose()));
	});
}

async function waitForOutcome(
	outcomes: HealthProcessingOutcome[],
	startIndex: number,
): Promise<HealthProcessingOutcome> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const outcome = outcomes[startIndex];
		if (outcome) {
			return outcome;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
	throw new Error("Timed out waiting for Health notification processing");
}

async function sendHealth(
	gatewayUrl: string,
	rawBody: Buffer,
	options: {
		notificationIdHeader?: string;
		legacyAuthenticationHeaders?: Readonly<Record<string, string>>;
	} = {},
): Promise<HealthResponse> {
	const payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
	const response = await fetch(`${gatewayUrl}/v1/health-events`, {
		method: "POST",
		headers: {
			"content-type": "application/json; charset=utf-8",
			"x-smart-collar-notification-id": options.notificationIdHeader ?? String(payload.notification_id),
			...options.legacyAuthenticationHeaders,
		},
		body: rawBody,
	});
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
	};
}

function changedBody(rawBody: Buffer, changes: Record<string, unknown>): Buffer {
	const payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
	return Buffer.from(JSON.stringify({ ...payload, ...changes }), "utf8");
}

async function seedAndDeliverUpstream(
	options: HealthCrossRepoDemoOptions,
	databasePath: string,
	gatewayUrl: string,
): Promise<UpstreamFixtureSummary> {
	const fixtureScript = resolve(import.meta.dirname, "smart-neckband-health-fixture.py");
	const { stdout, stderr } = await execFileAsync(
		options.upstreamPython,
		[
			fixtureScript,
			"--db",
			databasePath,
			"--wearer-id",
			WEARER_ID,
			"--webhook-url",
			`${gatewayUrl}/v1/health-events`,
			"--key-id",
			CURRENT_KEY_ID,
			"--secret-hex",
			CURRENT_SECRET_HEX,
		],
		{
			cwd: resolve(options.upstreamRoot, "pc_app"),
			encoding: "utf8",
			timeout: 20_000,
			windowsHide: true,
		},
	);
	if (stderr.trim()) {
		throw new Error(`Smart Collar fixture wrote unexpected stderr: ${stderr.trim()}`);
	}
	return JSON.parse(stdout) as UpstreamFixtureSummary;
}

export async function runHealthCrossRepoDemo(options: HealthCrossRepoDemoOptions): Promise<HealthCrossRepoDemoSummary> {
	const directory = mkdtempSync(join(tmpdir(), "health-cross-repo-"));
	const gatewayDatabasePath = join(directory, "gateway.sqlite");
	const upstreamDatabasePath = join(directory, "health.sqlite");
	const outcomes: HealthProcessingOutcome[] = [];
	const backgroundErrors: unknown[] = [];
	let agentRuns = 0;
	let dimosCalls = 0;
	let robotCalls = 0;
	let instructionService: AgentWebhookService | undefined;
	let healthService: HealthNotificationService | undefined;
	let gatewayServer: Server | undefined;

	try {
		const store = new GatewayStore(gatewayDatabasePath);
		instructionService = new AgentWebhookService({
			store,
			agent: {
				run: async () => {
					agentRuns++;
					return "unexpected";
				},
			},
			mcp: {
				callTool: async () => {
					dimosCalls++;
					robotCalls++;
					return "unexpected";
				},
			},
		});
		instructionService.start();

		const healthMcp = new HealthMcpClient(
			new StdioHealthMcpTransport(
				options.upstreamPython,
				[
					"-m",
					"smart_neckband.health_mcp",
					"--transport",
					"stdio",
					"--db",
					upstreamDatabasePath,
					"--wearer-id",
					WEARER_ID,
				],
				5_000,
			),
		);
		healthService = new HealthNotificationService({
			store,
			mcp: healthMcp,
			wearerId: WEARER_ID,
			retryBaseMs: 10,
			retryMaxMs: 10,
			onOutcome: (outcome) => outcomes.push(outcome),
			onBackgroundError: (error) => backgroundErrors.push(error),
		});
		const receiver = new HealthWebhookReceiver({
			store,
			healthService,
		});
		healthService.start();
		gatewayServer = createInstructionServer(instructionService, receiver);
		const gatewayUrl = await listen(gatewayServer);

		const fixture = await seedAndDeliverUpstream(options, upstreamDatabasePath, gatewayUrl);
		equal(fixture.http_status, 202);
		const rawBody = Buffer.from(fixture.raw_body_base64, "base64");
		equal(createHash("sha256").update(rawBody).digest("hex"), fixture.raw_body_sha256);
		equal(rawBody.length, fixture.raw_body_byte_length);
		const initialOutcome = await waitForOutcome(outcomes, 0);

		const duplicate = await sendHealth(gatewayUrl, rawBody);
		const conflict = await sendHealth(gatewayUrl, changedBody(rawBody, { sent_at: "2026-07-23T02:10:03.121Z" }));
		const unauthenticatedStart = outcomes.length;
		const unauthenticated = await sendHealth(gatewayUrl, changedBody(rawBody, { notification_id: randomUUID() }));
		equal(unauthenticated.status, 202);
		await waitForOutcome(outcomes, unauthenticatedStart);
		const legacyAuthenticationHeadersStart = outcomes.length;
		const legacyAuthenticationHeaders = await sendHealth(
			gatewayUrl,
			changedBody(rawBody, { notification_id: randomUUID() }),
			{
				legacyAuthenticationHeaders: {
					"x-smart-collar-key-id": "unknown-key",
					"x-smart-collar-timestamp": "1",
					"x-smart-collar-signature": "invalid",
				},
			},
		);
		equal(legacyAuthenticationHeaders.status, 202);
		await waitForOutcome(outcomes, legacyAuthenticationHeadersStart);
		const headerMismatch = await sendHealth(gatewayUrl, rawBody, {
			notificationIdHeader: randomUUID(),
		});
		const schemaRejection = await sendHealth(
			gatewayUrl,
			changedBody(rawBody, { notification_id: randomUUID(), extra: true }),
		);

		const replayStart = outcomes.length;
		const replay = await sendHealth(
			gatewayUrl,
			changedBody(rawBody, {
				notification_id: randomUUID(),
				event_id: randomUUID(),
				data_source: "replay",
				test_mode: true,
			}),
		);
		equal(replay.status, 202);
		const replayOutcome = await waitForOutcome(outcomes, replayStart);

		const mismatchStart = outcomes.length;
		const mismatch = await sendHealth(
			gatewayUrl,
			changedBody(rawBody, {
				notification_id: randomUUID(),
				event_revision: fixture.event_revision + 1,
			}),
		);
		equal(mismatch.status, 202);
		const eventMismatchOutcome = await waitForOutcome(outcomes, mismatchStart);

		const concurrentStart = outcomes.length;
		const concurrentBody = changedBody(rawBody, { notification_id: randomUUID() });
		const concurrent = await Promise.all(Array.from({ length: 5 }, () => sendHealth(gatewayUrl, concurrentBody)));
		const concurrentStatuses = concurrent.map((response) => response.body.status);
		const concurrentAcks = {
			accepted: concurrentStatuses.filter((status) => status === "accepted").length,
			duplicate: concurrentStatuses.filter((status) => status === "duplicate").length,
		};
		equal(concurrentAcks.accepted, 1);
		equal(concurrentAcks.duplicate, 4);
		await waitForOutcome(outcomes, concurrentStart);

		const upstreamDatabase = new DatabaseSync(upstreamDatabasePath, { readOnly: true });
		const healthMcpCalls = Number(
			(upstreamDatabase.prepare("SELECT COUNT(*) AS count FROM health_mcp_audit").get() as { count: number }).count,
		);
		upstreamDatabase.close();

		equal(backgroundErrors.length, 0);
		ok(outcomes.includes("verified_no_action"));
		return {
			initialAck: "accepted",
			initialOutcome,
			duplicateAck: String(duplicate.body.status),
			conflictStatus: conflict.status,
			unauthenticatedStatus: unauthenticated.status,
			legacyAuthenticationHeadersStatus: legacyAuthenticationHeaders.status,
			headerMismatchStatus: headerMismatch.status,
			schemaRejectionStatus: schemaRejection.status,
			replayOutcome,
			eventMismatchOutcome,
			concurrentAcks,
			healthMcpCalls,
			upstreamDeliveryStatus: fixture.http_status,
			rawBodySha256: fixture.raw_body_sha256,
			rawBodyByteLength: fixture.raw_body_byte_length,
			agentRuns,
			dimosCalls,
			robotCalls,
		};
	} finally {
		if (gatewayServer) {
			await closeServer(gatewayServer);
		}
		await healthService?.close();
		await instructionService?.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

const isDirectRun = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
	const upstreamRoot = process.env.SMART_NECKBAND_HEALTH_ROOT;
	const upstreamPython = process.env.SMART_NECKBAND_HEALTH_PYTHON;
	if (!upstreamRoot || !upstreamPython) {
		throw new Error("SMART_NECKBAND_HEALTH_ROOT and SMART_NECKBAND_HEALTH_PYTHON are required");
	}
	runHealthCrossRepoDemo({ upstreamRoot, upstreamPython })
		.then((summary) => {
			console.log("health cross-repo integration passed");
			console.log(JSON.stringify(summary, null, 2));
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.stack : String(error));
			process.exitCode = 1;
		});
}
