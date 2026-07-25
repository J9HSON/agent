#!/usr/bin/env node
import { PiTaskParameterCompiler, PiUserTextAgent } from "./agent-runtime.ts";
import { readGatewayConfig } from "./config.ts";
import { createInstructionServer } from "./http-server.ts";
import { HttpMcpToolClient } from "./mcp-client.ts";
import { ReplyWebhookClient } from "./reply-client.ts";
import { AgentWebhookService } from "./service.ts";
import { GatewayStore } from "./store.ts";
import { ValidationUserTextAgent } from "./validation-agent.ts";

async function main(): Promise<void> {
	const config = readGatewayConfig();
	const mcp = new HttpMcpToolClient(config.mcpWrapperUrl, config.mcpTimeoutMs);
	const store = new GatewayStore(config.databasePath);
	const execution =
		config.toolProfile === "product"
			? {
					taskCompiler: await PiTaskParameterCompiler.create({
						cwd: config.agentCwd,
						agentDir: config.agentDir,
						sessionDir: config.sessionDir,
						agentModel: config.agentModel,
					}),
				}
			: {
					agent:
						config.agentRuntime === "validation"
							? new ValidationUserTextAgent(mcp)
							: await PiUserTextAgent.create({
									cwd: config.agentCwd,
									agentDir: config.agentDir,
									sessionDir: config.sessionDir,
									defaultSpeedMps: config.defaultSpeedMps,
									toolProfile: config.toolProfile,
									agentModel: config.agentModel,
									mcp,
								}),
				};
	const service = new AgentWebhookService({
		store,
		...execution,
		mcp,
		replyClient: new ReplyWebhookClient(config.replyWebhookUrl, config.replyTimeoutMs),
		retryBaseMs: config.retryBaseMs,
		retryMaxMs: config.retryMaxMs,
		taskPollIntervalMs: config.taskPollIntervalMs,
		taskTimeoutMs: config.taskTimeoutMs,
	});
	service.start();
	const server = createInstructionServer(service, { mapUrl: config.mapUrl });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, resolve);
	});
	console.log(`agent console listening on http://${config.host}:${config.port}/`);

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		if (shutdownPromise) {
			return shutdownPromise;
		}
		shutdownPromise = (async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
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
