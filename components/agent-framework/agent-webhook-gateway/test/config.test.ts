import { describe, expect, it } from "vitest";
import { readGatewayConfig } from "../src/config.ts";

describe("gateway configuration", () => {
	it("uses the local Agent Console for replies and keeps the documented defaults", () => {
		const config = readGatewayConfig({}, "/gateway", "/Users/operator");

		expect(config).toMatchObject({
			host: "127.0.0.1",
			port: 8080,
			replyWebhookUrl: "http://127.0.0.1:8080/v1/ui-replies",
			mapUrl: "http://127.0.0.1:9878/",
			mcpWrapperUrl: "http://127.0.0.1:9991/mcp",
			mcpTimeoutMs: 120_000,
			taskPollIntervalMs: 500,
			taskTimeoutMs: 330_000,
			defaultSpeedMps: 0.1,
			toolProfile: "product",
			agentRuntime: "pi",
			agentModel: {
				provider: "siliconflow",
				modelId: "zai-org/GLM-5.2",
				baseUrl: "https://api.siliconflow.cn/v1",
			},
		});
		expect(config.agentModel.apiKey).toContain("security find-generic-password");
		expect(config.databasePath).toBe("/gateway/data/agent-webhook.sqlite");
		expect(config.agentDir).toBe("/Users/operator/.pi/agent");
	});

	it("rejects an invalid explicit reply URL", () => {
		expect(() => readGatewayConfig({ AGENT_WEBHOOK_REPLY_URL: "not-a-url" }, "/gateway", "/Users/operator")).toThrow(
			"AGENT_WEBHOOK_REPLY_URL must be an absolute HTTP(S) URL",
		);
	});

	it("reads explicit external reply and official map URLs", () => {
		const config = readGatewayConfig(
			{
				AGENT_WEBHOOK_REPLY_URL: "https://receiver.example.test/replies",
				AGENT_WEBHOOK_MAP_URL: "http://127.0.0.1:9090/",
			},
			"/gateway",
			"/Users/operator",
		);

		expect(config.replyWebhookUrl).toBe("https://receiver.example.test/replies");
		expect(config.mapUrl).toBe("http://127.0.0.1:9090/");
	});

	it("reads the explicit stage-one validation profile", () => {
		const config = readGatewayConfig(
			{
				AGENT_WEBHOOK_REPLY_URL: "http://127.0.0.1:9080/replies",
				AGENT_WEBHOOK_TOOL_PROFILE: "validation",
			},
			"/gateway",
			"/Users/operator",
		);

		expect(config.toolProfile).toBe("validation");
		expect(config.agentRuntime).toBe("validation");
	});

	it("rejects an unknown tool profile", () => {
		expect(() =>
			readGatewayConfig(
				{
					AGENT_WEBHOOK_REPLY_URL: "http://127.0.0.1:9080/replies",
					AGENT_WEBHOOK_TOOL_PROFILE: "everything",
				},
				"/gateway",
				"/Users/operator",
			),
		).toThrow("AGENT_WEBHOOK_TOOL_PROFILE must be one of: product, validation");
	});

	it("reads an explicit OpenAI-compatible Agent model configuration", () => {
		const config = readGatewayConfig(
			{
				AGENT_WEBHOOK_REPLY_URL: "http://127.0.0.1:9080/replies",
				AGENT_WEBHOOK_MODEL_PROVIDER: "private-provider",
				AGENT_WEBHOOK_MODEL_ID: "org/model",
				AGENT_WEBHOOK_MODEL_BASE_URL: "https://models.example.test/v1/",
				AGENT_WEBHOOK_MODEL_API_KEY: "test-api-key",
			},
			"/gateway",
			"/Users/operator",
		);

		expect(config.agentModel).toEqual({
			provider: "private-provider",
			modelId: "org/model",
			baseUrl: "https://models.example.test/v1",
			apiKey: "test-api-key",
		});
	});
});
