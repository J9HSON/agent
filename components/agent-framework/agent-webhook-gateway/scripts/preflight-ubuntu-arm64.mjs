#!/usr/bin/env node
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function requireCondition(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}

function parseOsRelease(contents) {
	const entries = [];
	for (const line of contents.split(/\r?\n/u)) {
		const separator = line.indexOf("=");
		if (separator <= 0) {
			continue;
		}
		const key = line.slice(0, separator);
		const rawValue = line.slice(separator + 1);
		const value =
			rawValue.length >= 2 && rawValue[0] === '"' && rawValue.at(-1) === '"'
				? rawValue.slice(1, -1)
				: rawValue;
		entries.push([key, value]);
	}
	return Object.fromEntries(entries);
}

requireCondition(process.platform === "linux", `expected Linux, got ${process.platform}`);
requireCondition(process.arch === "arm64", `expected Node arm64, got ${process.arch}`);

if (!existsSync("/etc/os-release")) {
	failures.push("/etc/os-release is missing");
} else {
	const osRelease = parseOsRelease(readFileSync("/etc/os-release", "utf8"));
	requireCondition(osRelease.ID === "ubuntu", `expected Ubuntu, got ${osRelease.ID ?? "unknown"}`);
	requireCondition(osRelease.VERSION_ID === "24.04", `expected Ubuntu 24.04, got ${osRelease.VERSION_ID ?? "unknown"}`);
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
requireCondition(
	nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19),
	`expected Node.js >=22.19.0, got ${process.version}`,
);

try {
	const database = new DatabaseSync(":memory:");
	database.exec("SELECT 1");
	database.close();
} catch (error) {
	failures.push(`node:sqlite is unavailable: ${error instanceof Error ? error.message : String(error)}`);
}

const envPath = join(componentRoot, ".env");
if (!existsSync(envPath)) {
	failures.push(`${envPath} is missing; copy .env.example and configure it`);
} else {
	process.loadEnvFile(envPath);
	const replyUrl = process.env.AGENT_WEBHOOK_REPLY_URL;
	try {
		const parsed = new URL(replyUrl ?? "");
		requireCondition(parsed.protocol === "http:" || parsed.protocol === "https:", "AGENT_WEBHOOK_REPLY_URL must use HTTP(S)");
	} catch {
		failures.push("AGENT_WEBHOOK_REPLY_URL must be an absolute HTTP(S) URL");
	}
}

for (const requiredPath of [
	join(componentRoot, "dist", "cli.js"),
	join(componentRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
]) {
	requireCondition(existsSync(requiredPath), `${requiredPath} is missing; run npm ci --ignore-scripts and npm run build`);
}

const databasePath = resolve(
	componentRoot,
	process.env.AGENT_WEBHOOK_DATABASE_PATH?.trim() || join("data", "agent-webhook.sqlite"),
);
const sessionPath = resolve(
	componentRoot,
	process.env.AGENT_WEBHOOK_SESSION_DIR?.trim() || join("data", "agent-session"),
);
const agentPath = resolve(
	componentRoot,
	process.env.AGENT_WEBHOOK_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"),
);

for (const writablePath of [dirname(databasePath), sessionPath]) {
	try {
		mkdirSync(writablePath, { recursive: true });
		accessSync(writablePath, constants.R_OK | constants.W_OK);
	} catch (error) {
		failures.push(`${writablePath} must be readable and writable: ${error instanceof Error ? error.message : String(error)}`);
	}
}
if (existsSync(databasePath)) {
	try {
		accessSync(databasePath, constants.R_OK | constants.W_OK);
	} catch (error) {
		failures.push(`${databasePath} must be readable and writable: ${error instanceof Error ? error.message : String(error)}`);
	}
}
try {
	accessSync(agentPath, constants.R_OK);
} catch (error) {
	failures.push(
		`${agentPath} must contain readable Pi model authentication: ${error instanceof Error ? error.message : String(error)}`,
	);
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`preflight failed: ${failure}`);
	}
	process.exitCode = 1;
} else {
	const glibc = process.report.getReport().header.glibcVersionRuntime ?? "unknown";
	console.log(
		`ubuntu arm64 preflight passed: os=24.04 arch=${process.arch} node=${process.version} glibc=${glibc} sqlite=available`,
	);
}
