import { describe, expect, it } from "vitest";
import { readGatewayConfig } from "../src/config.ts";

describe("gateway configuration", () => {
	it("keeps the documented local defaults without an output webhook", () => {
		const config = readGatewayConfig({}, "C:/gateway", "C:/Users/operator");

		expect(config).toMatchObject({
			host: "127.0.0.1",
			port: 8080,
			mcpWrapperUrl: "http://127.0.0.1:9991/mcp",
			mcpTimeoutMs: 120_000,
			ttsMcpUrl: undefined,
			ttsMcpTimeoutMs: 10_000,
			defaultSpeedMps: 0.1,
			health: undefined,
		});
		expect(config.databasePath.replaceAll("\\", "/")).toBe("C:/gateway/data/agent-webhook.sqlite");
		expect(config.agentDir.replaceAll("\\", "/")).toBe("C:/Users/operator/.pi/agent");
	});

	it("accepts an optional TTS MCP URL and rejects malformed values", () => {
		const config = readGatewayConfig(
			{
				AGENT_WEBHOOK_TTS_MCP_URL: "http://127.0.0.1:9090/mcp",
				AGENT_WEBHOOK_TTS_MCP_TIMEOUT_MS: "2500",
			},
			"C:/gateway",
			"C:/Users/operator",
		);

		expect(config).toMatchObject({
			ttsMcpUrl: "http://127.0.0.1:9090/mcp",
			ttsMcpTimeoutMs: 2_500,
		});
		expect(() =>
			readGatewayConfig({ AGENT_WEBHOOK_TTS_MCP_URL: "not-a-url" }, "C:/gateway", "C:/Users/operator"),
		).toThrow("AGENT_WEBHOOK_TTS_MCP_URL must be an absolute HTTP(S) URL");
		expect(() =>
			readGatewayConfig(
				{
					AGENT_WEBHOOK_MCP_URL: "http://127.0.0.1:9991/mcp",
					AGENT_WEBHOOK_TTS_MCP_URL: "http://127.0.0.1:9991/mcp",
				},
				"C:/gateway",
				"C:/Users/operator",
			),
		).toThrow("AGENT_WEBHOOK_TTS_MCP_URL must differ from AGENT_WEBHOOK_MCP_URL");
	});

	it("enables the isolated health receiver with a remote MCP URL and no authentication", () => {
		const config = readGatewayConfig(
			{
				AGENT_WEBHOOK_HEALTH_WEARER_ID: "xwen",
				AGENT_WEBHOOK_HEALTH_MCP_URL: "http://192.168.66.224:8765/mcp",
			},
			"C:/gateway",
			"C:/Users/operator",
		);

		expect(config.health).toMatchObject({
			wearerId: "xwen",
			mcpUrl: "http://192.168.66.224:8765/mcp",
			mcpTimeoutMs: 10_000,
		});
	});

	it("requires both Health deployment values and validates the remote URL", () => {
		expect(() =>
			readGatewayConfig({ AGENT_WEBHOOK_HEALTH_WEARER_ID: "xwen" }, "C:/gateway", "C:/Users/operator"),
		).toThrow("AGENT_WEBHOOK_HEALTH_MCP_URL is required");
		expect(() =>
			readGatewayConfig(
				{ AGENT_WEBHOOK_HEALTH_MCP_URL: "http://health-host:8765/mcp" },
				"C:/gateway",
				"C:/Users/operator",
			),
		).toThrow("AGENT_WEBHOOK_HEALTH_WEARER_ID is required");
		expect(() =>
			readGatewayConfig(
				{
					AGENT_WEBHOOK_HEALTH_WEARER_ID: "xwen",
					AGENT_WEBHOOK_HEALTH_MCP_URL: "not-a-url",
				},
				"C:/gateway",
				"C:/Users/operator",
			),
		).toThrow("AGENT_WEBHOOK_HEALTH_MCP_URL must be an absolute HTTP(S) URL");
	});

	it("ignores removed health authentication variables", () => {
		const config = readGatewayConfig(
			{
				AGENT_WEBHOOK_HEALTH_KEY_ID: "ignored",
				AGENT_WEBHOOK_HEALTH_SECRET_HEX: "ignored",
				AGENT_WEBHOOK_HEALTH_PREVIOUS_KEY_ID: "ignored",
				AGENT_WEBHOOK_HEALTH_PREVIOUS_SECRET_HEX: "ignored",
			},
			"C:/gateway",
			"C:/Users/operator",
		);

		expect(config.health).toBeUndefined();
	});
});
