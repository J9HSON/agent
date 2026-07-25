import { describe, expect, it } from "vitest";
import { readGatewayConfig } from "../src/config.ts";

describe("gateway configuration", () => {
	it("requires one deployment-level reply URL and keeps the documented local defaults", () => {
		const config = readGatewayConfig(
			{ AGENT_WEBHOOK_REPLY_URL: "http://127.0.0.1:9080/replies" },
			"C:/gateway",
			"C:/Users/operator",
			"win32",
		);

		expect(config).toMatchObject({
			host: "127.0.0.1",
			port: 8080,
			replyWebhookUrl: "http://127.0.0.1:9080/replies",
			mcpWrapperUrl: "http://127.0.0.1:9991/mcp",
			mcpTimeoutMs: 120_000,
			defaultSpeedMps: 0.1,
			health: undefined,
		});
		expect(config.databasePath.replaceAll("\\", "/")).toBe("C:/gateway/data/agent-webhook.sqlite");
		expect(config.agentDir.replaceAll("\\", "/")).toBe("C:/Users/operator/.pi/agent");
	});

	it("rejects startup without a valid reply URL", () => {
		expect(() => readGatewayConfig({}, "C:/gateway", "C:/Users/operator")).toThrow(
			"AGENT_WEBHOOK_REPLY_URL is required",
		);
		expect(() =>
			readGatewayConfig({ AGENT_WEBHOOK_REPLY_URL: "not-a-url" }, "C:/gateway", "C:/Users/operator"),
		).toThrow("AGENT_WEBHOOK_REPLY_URL must be an absolute HTTP(S) URL");
	});

	it("enables the isolated health receiver only with a complete contract-valid configuration", () => {
		const config = readGatewayConfig(
			{
				AGENT_WEBHOOK_REPLY_URL: "http://127.0.0.1:9080/replies",
				AGENT_WEBHOOK_HEALTH_WEARER_ID: "xwen",
				AGENT_WEBHOOK_HEALTH_KEY_ID: "health-webhook-2026-07",
				AGENT_WEBHOOK_HEALTH_SECRET_HEX: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
				AGENT_WEBHOOK_HEALTH_PREVIOUS_KEY_ID: "health-webhook-2026-06",
				AGENT_WEBHOOK_HEALTH_PREVIOUS_SECRET_HEX:
					"101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f",
			},
			"C:/gateway",
			"C:/Users/operator",
			"win32",
		);

		expect(config.health).toMatchObject({
			wearerId: "xwen",
			mcpCommand: "py",
			mcpArgs: ["-3.12", "-m", "smart_neckband.health_mcp", "--transport", "stdio"],
			mcpTimeoutMs: 10_000,
		});
		expect([...config.health!.keys.keys()]).toEqual(["health-webhook-2026-07", "health-webhook-2026-06"]);
	});

	it("uses the native Python 3 command when Health runs on Linux", () => {
		const config = readGatewayConfig(
			{
				AGENT_WEBHOOK_REPLY_URL: "http://127.0.0.1:9080/replies",
				AGENT_WEBHOOK_HEALTH_WEARER_ID: "xwen",
				AGENT_WEBHOOK_HEALTH_KEY_ID: "health-webhook-2026-07",
				AGENT_WEBHOOK_HEALTH_SECRET_HEX: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
			},
			"/home/pi/pi-hackason/components/agent-framework/agent-webhook-gateway",
			"/home/pi",
			"linux",
		);

		expect(config.health).toMatchObject({
			mcpCommand: "python3",
			mcpArgs: ["-m", "smart_neckband.health_mcp", "--transport", "stdio"],
		});
	});

	it("fails closed for partial or malformed health webhook secrets", () => {
		const replyOnly = { AGENT_WEBHOOK_REPLY_URL: "http://127.0.0.1:9080/replies" };
		expect(() =>
			readGatewayConfig(
				{
					...replyOnly,
					AGENT_WEBHOOK_HEALTH_WEARER_ID: "xwen",
					AGENT_WEBHOOK_HEALTH_KEY_ID: "health-webhook-2026-07",
				},
				"C:/gateway",
				"C:/Users/operator",
			),
		).toThrow("AGENT_WEBHOOK_HEALTH_SECRET_HEX is required");
		expect(() =>
			readGatewayConfig(
				{
					...replyOnly,
					AGENT_WEBHOOK_HEALTH_WEARER_ID: "xwen",
					AGENT_WEBHOOK_HEALTH_KEY_ID: "health-webhook-2026-07",
					AGENT_WEBHOOK_HEALTH_SECRET_HEX: "000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F",
				},
				"C:/gateway",
				"C:/Users/operator",
			),
		).toThrow("AGENT_WEBHOOK_HEALTH_SECRET_HEX must be exactly 64 lowercase hexadecimal characters");
	});
});
