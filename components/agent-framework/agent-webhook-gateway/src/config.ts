import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

export interface GatewayConfig {
	host: string;
	port: number;
	databasePath: string;
	replyWebhookUrl: string;
	mcpWrapperUrl: string;
	mcpTimeoutMs: number;
	replyTimeoutMs: number;
	retryBaseMs: number;
	retryMaxMs: number;
	agentCwd: string;
	agentDir: string;
	sessionDir: string;
	defaultSpeedMps: number;
	health: HealthGatewayConfig | undefined;
}

export interface HealthGatewayConfig {
	wearerId: string;
	keys: ReadonlyMap<string, Uint8Array>;
	mcpCommand: string;
	mcpArgs: readonly string[];
	mcpTimeoutMs: number;
	retryBaseMs: number;
	retryMaxMs: number;
}

function readPositiveNumber(environment: Environment, name: string, fallback: number): number {
	const raw = environment[name];
	const value = raw === undefined ? fallback : Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive finite number`);
	}
	return value;
}

function readPort(environment: Environment): number {
	const value = readPositiveNumber(environment, "AGENT_WEBHOOK_PORT", 8080);
	if (!Number.isInteger(value) || value > 65_535) {
		throw new Error("AGENT_WEBHOOK_PORT must be an integer from 1 to 65535");
	}
	return value;
}

function readHttpUrl(environment: Environment, name: string, fallback?: string): string {
	const raw = environment[name]?.trim() || fallback;
	if (!raw) {
		throw new Error(`${name} is required`);
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${name} must be an absolute HTTP(S) URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${name} must be an absolute HTTP(S) URL`);
	}
	return url.toString();
}

function readPath(environment: Environment, name: string, fallback: string, cwd: string): string {
	return resolve(cwd, environment[name]?.trim() || fallback);
}

function readHealthConfig(environment: Environment, runtimePlatform: NodeJS.Platform): HealthGatewayConfig | undefined {
	const enabled = Object.keys(environment).some((name) => name.startsWith("AGENT_WEBHOOK_HEALTH_"));
	if (!enabled) {
		return undefined;
	}
	const wearerId = readRequired(environment, "AGENT_WEBHOOK_HEALTH_WEARER_ID");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(wearerId)) {
		throw new Error("AGENT_WEBHOOK_HEALTH_WEARER_ID does not match the Health MCP wearer_id contract");
	}
	const currentKeyId = readRequired(environment, "AGENT_WEBHOOK_HEALTH_KEY_ID");
	const keys = new Map<string, Uint8Array>([
		[currentKeyId, readSecret(environment, "AGENT_WEBHOOK_HEALTH_SECRET_HEX")],
	]);
	const previousKeyId = environment.AGENT_WEBHOOK_HEALTH_PREVIOUS_KEY_ID?.trim();
	const previousSecret = environment.AGENT_WEBHOOK_HEALTH_PREVIOUS_SECRET_HEX;
	if ((previousKeyId === undefined) !== (previousSecret === undefined)) {
		throw new Error(
			"AGENT_WEBHOOK_HEALTH_PREVIOUS_KEY_ID and AGENT_WEBHOOK_HEALTH_PREVIOUS_SECRET_HEX must be configured together",
		);
	}
	if (previousKeyId && previousSecret !== undefined) {
		if (keys.has(previousKeyId)) {
			throw new Error("AGENT_WEBHOOK_HEALTH_PREVIOUS_KEY_ID must differ from AGENT_WEBHOOK_HEALTH_KEY_ID");
		}
		keys.set(previousKeyId, readSecret(environment, "AGENT_WEBHOOK_HEALTH_PREVIOUS_SECRET_HEX"));
	}

	return {
		wearerId,
		keys,
		mcpCommand:
			environment.AGENT_WEBHOOK_HEALTH_MCP_COMMAND?.trim() || (runtimePlatform === "linux" ? "python3" : "py"),
		mcpArgs: readStringArray(
			environment,
			"AGENT_WEBHOOK_HEALTH_MCP_ARGS_JSON",
			runtimePlatform === "linux"
				? ["-m", "smart_neckband.health_mcp", "--transport", "stdio"]
				: ["-3.12", "-m", "smart_neckband.health_mcp", "--transport", "stdio"],
		),
		mcpTimeoutMs: readPositiveNumber(environment, "AGENT_WEBHOOK_HEALTH_MCP_TIMEOUT_MS", 10_000),
		retryBaseMs: readPositiveNumber(environment, "AGENT_WEBHOOK_HEALTH_RETRY_BASE_MS", 1_000),
		retryMaxMs: readPositiveNumber(environment, "AGENT_WEBHOOK_HEALTH_RETRY_MAX_MS", 60_000),
	};
}

function readRequired(environment: Environment, name: string): string {
	const value = environment[name]?.trim();
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
}

function readSecret(environment: Environment, name: string): Uint8Array {
	const value = environment[name];
	if (value === undefined || value === "") {
		throw new Error(`${name} is required`);
	}
	if (!/^[0-9a-f]{64}$/u.test(value)) {
		throw new Error(`${name} must be exactly 64 lowercase hexadecimal characters`);
	}
	return Buffer.from(value, "hex");
}

function readStringArray(environment: Environment, name: string, fallback: readonly string[]): readonly string[] {
	const raw = environment[name];
	if (raw === undefined) {
		return fallback;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(`${name} must be a JSON array of strings`);
	}
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${name} must be a JSON array of strings`);
	}
	return value;
}

export function readGatewayConfig(
	environment: Environment = process.env,
	processCwd: string = process.cwd(),
	userHome: string = homedir(),
	runtimePlatform: NodeJS.Platform = process.platform,
): GatewayConfig {
	const dataDirectory = resolve(processCwd, "data");
	const agentCwd = readPath(environment, "AGENT_WEBHOOK_AGENT_CWD", processCwd, processCwd);
	return {
		host: environment.AGENT_WEBHOOK_HOST?.trim() || "127.0.0.1",
		port: readPort(environment),
		databasePath: readPath(
			environment,
			"AGENT_WEBHOOK_DATABASE_PATH",
			join(dataDirectory, "agent-webhook.sqlite"),
			processCwd,
		),
		replyWebhookUrl: readHttpUrl(environment, "AGENT_WEBHOOK_REPLY_URL"),
		mcpWrapperUrl: readHttpUrl(environment, "AGENT_WEBHOOK_MCP_URL", "http://127.0.0.1:9991/mcp"),
		mcpTimeoutMs: readPositiveNumber(environment, "AGENT_WEBHOOK_MCP_TIMEOUT_MS", 120_000),
		replyTimeoutMs: readPositiveNumber(environment, "AGENT_WEBHOOK_REPLY_TIMEOUT_MS", 10_000),
		retryBaseMs: readPositiveNumber(environment, "AGENT_WEBHOOK_RETRY_BASE_MS", 1_000),
		retryMaxMs: readPositiveNumber(environment, "AGENT_WEBHOOK_RETRY_MAX_MS", 60_000),
		agentCwd,
		agentDir: readPath(environment, "AGENT_WEBHOOK_AGENT_DIR", join(userHome, ".pi", "agent"), processCwd),
		sessionDir: readPath(environment, "AGENT_WEBHOOK_SESSION_DIR", join(dataDirectory, "agent-session"), processCwd),
		defaultSpeedMps: readPositiveNumber(environment, "AGENT_WEBHOOK_DEFAULT_SPEED_MPS", 0.1),
		health: readHealthConfig(environment, runtimePlatform),
	};
}
