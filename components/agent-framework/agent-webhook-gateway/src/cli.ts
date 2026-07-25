#!/usr/bin/env node
import { PiUserTextAgent } from "./agent-runtime.ts";
import { readGatewayConfig } from "./config.ts";
import { startGatewayListener } from "./gateway-lifecycle.ts";
import { createHealthGatewayIntegration } from "./health-gateway.ts";
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
	const healthIntegration = config.health ? createHealthGatewayIntegration(config.health, store) : undefined;
	const server = createInstructionServer(service, healthIntegration?.receiver);
	const gateway = await startGatewayListener({
		server,
		host: config.host,
		port: config.port,
		service,
		healthService: healthIntegration?.service,
	});
	console.log(`agent webhook gateway listening on http://${config.host}:${config.port}/v1/instructions`);
	if (healthIntegration) {
		console.log(`health webhook receiver listening on http://${config.host}:${config.port}/v1/health-events`);
	}

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		shutdownPromise ??= gateway.close();
		return shutdownPromise;
	};
	const handleShutdown = (): void => {
		void shutdown().then(
			() => {
				process.exitCode = 0;
			},
			(error: unknown) => {
				console.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			},
		);
	};
	process.once("SIGINT", handleShutdown);
	process.once("SIGTERM", handleShutdown);
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
