export interface ExternalInstruction {
	instructionId: string;
	text: string;
}

export type AgentRunLogEvent =
	| { event: "agent.run_started" }
	| { event: "agent.turn_started" }
	| { event: "agent.response_started" }
	| { event: "agent.response_completed"; output?: string }
	| {
			event: "agent.tool_started";
			tool_call_id: string;
			tool_name: string;
			arguments: string;
	  }
	| {
			event: "agent.tool_completed";
			tool_call_id: string;
			tool_name: string;
			is_error: boolean;
			output?: string;
	  }
	| { event: "agent.turn_completed"; tool_result_count: number; stop_reason?: string }
	| { event: "agent.run_completed"; will_retry: boolean }
	| {
			event: "agent.retry_started";
			attempt: number;
			max_attempts: number;
			delay_ms: number;
			error: string;
	  }
	| { event: "agent.retry_completed"; success: boolean; attempt: number; final_error?: string }
	| { event: "agent.compaction_started"; reason: "manual" | "threshold" | "overflow" }
	| {
			event: "agent.compaction_completed";
			reason: "manual" | "threshold" | "overflow";
			aborted: boolean;
			will_retry: boolean;
			error?: string;
	  };

export type AgentRunLogSink = (event: AgentRunLogEvent) => void;

export interface UserTextAgent {
	run(text: string, onLog?: AgentRunLogSink): Promise<string>;
	close?(): Promise<void> | void;
}

export interface McpToolCaller {
	callTool(name: string, arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<string>;
}
