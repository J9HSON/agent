export type GatewayLogSink = (line: string) => void;

const MAX_ERROR_MESSAGE_LENGTH = 240;

export const consoleGatewayLogSink: GatewayLogSink = (line) => console.log(line);

export function describeGatewayError(error: unknown): string {
	if (!(error instanceof Error)) {
		return "non_error_failure";
	}
	const redacted = (error.message.trim() || error.name)
		.replace(/\bAuthorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/giu, "Authorization: [redacted]")
		.replace(/\b(api[_ -]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/giu, "$1$2[redacted]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [redacted]")
		.replace(/\b(?:sk|pk|api)-[A-Za-z0-9_-]{8,}\b/giu, "[redacted]");
	return redacted.length <= MAX_ERROR_MESSAGE_LENGTH
		? redacted
		: `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}

export function writeGatewayLog(sink: GatewayLogSink, event: string, details: Readonly<Record<string, unknown>>): void {
	sink(`[agent-webhook] ${new Date().toISOString()} ${event} ${JSON.stringify(details)}`);
}
