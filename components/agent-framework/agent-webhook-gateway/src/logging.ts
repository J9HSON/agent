export type GatewayLogSink = (line: string) => void;

const MAX_ERROR_MESSAGE_LENGTH = 240;
const MAX_LOG_TEXT_LENGTH = 2_000;

export const consoleGatewayLogSink: GatewayLogSink = (line) => console.log(line);

export function describeGatewayError(error: unknown): string {
	if (!(error instanceof Error)) {
		return "non_error_failure";
	}
	return truncateGatewayText(redactGatewayText(error.message.trim() || error.name), MAX_ERROR_MESSAGE_LENGTH);
}

export function describeGatewayLogText(text: string): string {
	return truncateGatewayText(redactGatewayText(text), MAX_LOG_TEXT_LENGTH);
}

function redactGatewayText(text: string): string {
	return text
		.replace(/\bAuthorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/giu, "Authorization: [redacted]")
		.replace(/\b(api[_ -]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/giu, "$1$2[redacted]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [redacted]")
		.replace(/\b(?:sk|pk|api)-[A-Za-z0-9_-]{8,}\b/giu, "[redacted]");
}

function truncateGatewayText(text: string, maximumLength: number): string {
	return text.length <= maximumLength ? text : `${text.slice(0, maximumLength - 1)}…`;
}

export function writeGatewayLog(sink: GatewayLogSink, event: string, details: Readonly<Record<string, unknown>>): void {
	sink(`[agent-webhook] ${new Date().toISOString()} ${event} ${JSON.stringify(details)}`);
}
