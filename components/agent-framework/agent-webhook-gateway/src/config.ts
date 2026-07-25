import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;
export type ToolProfile = "product" | "validation";
export type AgentRuntime = "pi" | "validation";

export interface AgentModelConfig {
	provider: string;
	modelId: string;
	baseUrl: string;
	apiKey: string;
}

export interface GatewayConfig {
	host: string;
	port: number;
	databasePath: string;
	replyWebhookUrl: string;
	mapUrl: string;
	mcpWrapperUrl: string;
	mcpTimeoutMs: number;
	replyTimeoutMs: number;
	retryBaseMs: number;
	retryMaxMs: number;
	taskPollIntervalMs: number;
	taskTimeoutMs: number;
	agentCwd: string;
	agentDir: string;
	sessionDir: string;
	defaultSpeedMps: number;
	toolProfile: ToolProfile;
	agentRuntime: AgentRuntime;
	agentModel: AgentModelConfig;
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

function readToolProfile(environment: Environment): ToolProfile {
	const value = environment.AGENT_WEBHOOK_TOOL_PROFILE?.trim().toLowerCase() || "product";
	if (value !== "product" && value !== "validation") {
		throw new Error("AGENT_WEBHOOK_TOOL_PROFILE must be one of: product, validation");
	}
	return value;
}

function readAgentRuntime(environment: Environment, toolProfile: ToolProfile): AgentRuntime {
	const value =
		environment.AGENT_WEBHOOK_RUNTIME?.trim().toLowerCase() || (toolProfile === "validation" ? "validation" : "pi");
	if (value !== "pi" && value !== "validation") {
		throw new Error("AGENT_WEBHOOK_RUNTIME must be one of: pi, validation");
	}
	return value;
}

function readAgentModelConfig(environment: Environment): AgentModelConfig {
	return {
		provider: environment.AGENT_WEBHOOK_MODEL_PROVIDER?.trim() || "siliconflow",
		modelId: environment.AGENT_WEBHOOK_MODEL_ID?.trim() || "zai-org/GLM-5.2",
		baseUrl: readHttpUrl(environment, "AGENT_WEBHOOK_MODEL_BASE_URL", "https://api.siliconflow.cn/v1").replace(
			/\/$/u,
			"",
		),
		apiKey:
			environment.AGENT_WEBHOOK_MODEL_API_KEY?.trim() ||
			"!security find-generic-password -s agent-webhook-gateway-siliconflow -w",
	};
}

export function readGatewayConfig(
	environment: Environment = process.env,
	processCwd: string = process.cwd(),
	userHome: string = homedir(),
): GatewayConfig {
	const dataDirectory = resolve(processCwd, "data");
	const agentCwd = readPath(environment, "AGENT_WEBHOOK_AGENT_CWD", processCwd, processCwd);
	const toolProfile = readToolProfile(environment);
	const port = readPort(environment);
	return {
		host: environment.AGENT_WEBHOOK_HOST?.trim() || "127.0.0.1",
		port,
		databasePath: readPath(
			environment,
			"AGENT_WEBHOOK_DATABASE_PATH",
			join(dataDirectory, "agent-webhook.sqlite"),
			processCwd,
		),
		replyWebhookUrl: readHttpUrl(environment, "AGENT_WEBHOOK_REPLY_URL", `http://127.0.0.1:${port}/v1/ui-replies`),
		mapUrl: readHttpUrl(environment, "AGENT_WEBHOOK_MAP_URL", "http://127.0.0.1:9878/"),
		mcpWrapperUrl: readHttpUrl(environment, "AGENT_WEBHOOK_MCP_URL", "http://127.0.0.1:9991/mcp"),
		mcpTimeoutMs: readPositiveNumber(environment, "AGENT_WEBHOOK_MCP_TIMEOUT_MS", 120_000),
		replyTimeoutMs: readPositiveNumber(environment, "AGENT_WEBHOOK_REPLY_TIMEOUT_MS", 10_000),
		retryBaseMs: readPositiveNumber(environment, "AGENT_WEBHOOK_RETRY_BASE_MS", 1_000),
		retryMaxMs: readPositiveNumber(environment, "AGENT_WEBHOOK_RETRY_MAX_MS", 60_000),
		taskPollIntervalMs: readPositiveNumber(environment, "AGENT_WEBHOOK_TASK_POLL_INTERVAL_MS", 500),
		taskTimeoutMs: readPositiveNumber(environment, "AGENT_WEBHOOK_TASK_TIMEOUT_MS", 330_000),
		agentCwd,
		agentDir: readPath(environment, "AGENT_WEBHOOK_AGENT_DIR", join(userHome, ".pi", "agent"), processCwd),
		sessionDir: readPath(environment, "AGENT_WEBHOOK_SESSION_DIR", join(dataDirectory, "agent-session"), processCwd),
		defaultSpeedMps: readPositiveNumber(environment, "AGENT_WEBHOOK_DEFAULT_SPEED_MPS", 0.1),
		toolProfile,
		agentRuntime: readAgentRuntime(environment, toolProfile),
		agentModel: readAgentModelConfig(environment),
	};
}
