import type { HealthGatewayConfig } from "./config.ts";
import { HealthMcpClient, StreamableHttpHealthMcpTransport } from "./health-mcp-client.ts";
import { HealthNotificationService } from "./health-service.ts";
import { HealthWebhookReceiver } from "./health-webhook.ts";
import type { GatewayStore } from "./store.ts";

export interface HealthGatewayIntegration {
	service: HealthNotificationService;
	receiver: HealthWebhookReceiver;
}

export function createHealthGatewayIntegration(
	config: HealthGatewayConfig,
	store: GatewayStore,
): HealthGatewayIntegration {
	const service = new HealthNotificationService({
		store,
		mcp: new HealthMcpClient(new StreamableHttpHealthMcpTransport(config.mcpUrl, config.mcpTimeoutMs)),
		wearerId: config.wearerId,
		retryBaseMs: config.retryBaseMs,
		retryMaxMs: config.retryMaxMs,
	});
	return {
		service,
		receiver: new HealthWebhookReceiver({ store, healthService: service }),
	};
}
