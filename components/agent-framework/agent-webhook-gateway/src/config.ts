import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

export interface GatewayConfig {
	host: string;
	port: number;
	databasePath: string;
	mcpWrapperUrl: string;
	mcpTimeoutMs: number;
	ttsMcpUrl: string | undefined;
	ttsMcpTimeoutMs: number;
	agentCwd: string;
	agentDir: string;
	sessionDir: string;
	defaultSpeedMps: number;
	health: HealthGatewayConfig | undefined;
}

export interface HealthGatewayConfig {
	wearerId: string;
	mcpUrl: string;
	mcpTimeoutMs: number;
	retryBaseMs: number;
	retryMaxMs: number;
}

const HEALTH_CONFIGURATION_NAMES = [
	"AGENT_WEBHOOK_HEALTH_WEARER_ID",
	"AGENT_WEBHOOK_HEALTH_MCP_URL",
	"AGENT_WEBHOOK_HEALTH_MCP_TIMEOUT_MS",
	"AGENT_WEBHOOK_HEALTH_RETRY_BASE_MS",
	"AGENT_WEBHOOK_HEALTH_RETRY_MAX_MS",
] as const;

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

function readOptionalHttpUrl(environment: Environment, name: string): string | undefined {
	return environment[name]?.trim() ? readHttpUrl(environment, name) : undefined;
}

function readPath(environment: Environment, name: string, fallback: string, cwd: string): string {
	return resolve(cwd, environment[name]?.trim() || fallback);
}

function readHealthConfig(environment: Environment): HealthGatewayConfig | undefined {
	const enabled = HEALTH_CONFIGURATION_NAMES.some((name) => environment[name] !== undefined);
	if (!enabled) {
		return undefined;
	}
	const wearerId = readRequired(environment, "AGENT_WEBHOOK_HEALTH_WEARER_ID");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(wearerId)) {
		throw new Error("AGENT_WEBHOOK_HEALTH_WEARER_ID does not match the Health MCP wearer_id contract");
	}
	const mcpUrl = readHttpUrl(environment, "AGENT_WEBHOOK_HEALTH_MCP_URL");
	const parsedMcpUrl = new URL(mcpUrl);
	if (parsedMcpUrl.username || parsedMcpUrl.password) {
		throw new Error("AGENT_WEBHOOK_HEALTH_MCP_URL must not contain credentials");
	}

	return {
		wearerId,
		mcpUrl,
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

export function readGatewayConfig(
	environment: Environment = process.env,
	processCwd: string = process.cwd(),
	userHome: string = homedir(),
): GatewayConfig {
	const dataDirectory = resolve(processCwd, "data");
	const agentCwd = readPath(environment, "AGENT_WEBHOOK_AGENT_CWD", processCwd, processCwd);
	const mcpWrapperUrl = readHttpUrl(environment, "AGENT_WEBHOOK_MCP_URL", "http://127.0.0.1:9991/mcp");
	const ttsMcpUrl = readOptionalHttpUrl(environment, "AGENT_WEBHOOK_TTS_MCP_URL");
	if (ttsMcpUrl === mcpWrapperUrl) {
		throw new Error("AGENT_WEBHOOK_TTS_MCP_URL must differ from AGENT_WEBHOOK_MCP_URL");
	}
	return {
		host: environment.AGENT_WEBHOOK_HOST?.trim() || "127.0.0.1",
		port: readPort(environment),
		databasePath: readPath(
			environment,
			"AGENT_WEBHOOK_DATABASE_PATH",
			join(dataDirectory, "agent-webhook.sqlite"),
			processCwd,
		),
		mcpWrapperUrl,
		mcpTimeoutMs: readPositiveNumber(environment, "AGENT_WEBHOOK_MCP_TIMEOUT_MS", 120_000),
		ttsMcpUrl,
		ttsMcpTimeoutMs: readPositiveNumber(environment, "AGENT_WEBHOOK_TTS_MCP_TIMEOUT_MS", 10_000),
		agentCwd,
		agentDir: readPath(environment, "AGENT_WEBHOOK_AGENT_DIR", join(userHome, ".pi", "agent"), processCwd),
		sessionDir: readPath(environment, "AGENT_WEBHOOK_SESSION_DIR", join(dataDirectory, "agent-session"), processCwd),
		defaultSpeedMps: readPositiveNumber(environment, "AGENT_WEBHOOK_DEFAULT_SPEED_MPS", 0.1),
		health: readHealthConfig(environment),
	};
}
