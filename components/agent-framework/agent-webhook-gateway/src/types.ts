export const FAILURE_REPLY_TEXT = "暂时无法完成此请求，请稍后重试。";
export const STOP_ACCEPTED_REPLY_TEXT = "已发送停止指令。";
export const FOLLOW_ACCEPTED_REPLY_TEXT = "已锁定启动时画面中央的人并开始跟随；发送“停”可结束跟随。";

export interface ExternalInstruction {
	instructionId: string;
	text: string;
}

export interface AgentReplyEvent {
	event: "agent.reply.completed";
	reply_id: string;
	instruction_id: string;
	text: string;
	completed_at: string;
}

export interface UserTextAgent {
	run(text: string): Promise<string>;
	close?(): Promise<void> | void;
}

export interface McpToolCaller {
	callTool(name: string, arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<string>;
}

export interface ReplyEventDelivery {
	deliver(event: AgentReplyEvent): Promise<void>;
}
