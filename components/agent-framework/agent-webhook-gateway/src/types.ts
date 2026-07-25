export interface ExternalInstruction {
	instructionId: string;
	text: string;
}

export interface UserTextAgent {
	run(text: string): Promise<string>;
	close?(): Promise<void> | void;
}

export interface McpToolCaller {
	callTool(name: string, arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<string>;
}
