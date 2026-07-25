#!/usr/bin/env node
import { PiUserTextAgent } from "./agent-runtime.ts";
import { readGatewayConfig } from "./config.ts";
import { HealthMcpClient, StdioHealthMcpTransport } from "./health-mcp-client.ts";
import { HealthNotificationService } from "./health-service.ts";
import { HealthWebhookReceiver } from "./health-webhook.ts";
import { createInstructionServer } from "./http-server.ts";
import { HttpMcpToolClient } from "./mcp-client.ts";
import { AgentWebhookService } from "./service.ts";
import { GatewayStore } from "./store.ts";

async function main(): Promise<void> {
	const config = readGatewayConfig();
	const mcp = new HttpMcpToolClient(config.mcpWrapperUrl, config.mcpTimeoutMs);
	const ttsMcp = config.ttsMcpUrl ? new HttpMcpToolClient(config.ttsMcpUrl, config.ttsMcpTimeoutMs) : undefined;
	const store = new GatewayStore(config.databasePath);
	const agent = await PiUserTextAgent.create({
		cwd: config.agentCwd,
		agentDir: config.agentDir,
		sessionDir: config.sessionDir,
		defaultSpeedMps: config.defaultSpeedMps,
		mcp,
		ttsMcp,
	});
	const service = new AgentWebhookService({
		store,
		agent,
		mcp,
	});
	let healthService: HealthNotificationService | undefined;
	let healthReceiver: HealthWebhookReceiver | undefined;
	if (config.health) {
		const healthMcp = new HealthMcpClient(
			new StdioHealthMcpTransport(config.health.mcpCommand, config.health.mcpArgs, config.health.mcpTimeoutMs),
		);
		healthService = new HealthNotificationService({
			store,
			mcp: healthMcp,
			wearerId: config.health.wearerId,
			retryBaseMs: config.health.retryBaseMs,
			retryMaxMs: config.health.retryMaxMs,
		});
		healthReceiver = new HealthWebhookReceiver({
			store,
			healthService,
		});
		healthService.start();
	}
	service.start();
	const server = createInstructionServer(service, healthReceiver);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, resolve);
	});
	console.log(`agent webhook gateway listening on http://${config.host}:${config.port}/v1/instructions`);
	if (healthReceiver) {
		console.log(`health webhook receiver listening on http://${config.host}:${config.port}/v1/health-events`);
	}

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		if (shutdownPromise) {
			return shutdownPromise;
		}
		shutdownPromise = (async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			await healthService?.close();
			await service.close();
		})();
		return shutdownPromise;
	};
	process.once("SIGINT", () => {
		void shutdown().then(() => {
			process.exitCode = 0;
		});
	});
	process.once("SIGTERM", () => {
		void shutdown().then(() => {
			process.exitCode = 0;
		});
	});
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
