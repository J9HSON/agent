import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	agentSessionEventToRunLog,
	buildAgentSystemPrompt,
	createDogTools,
	createPiAgentSession,
	createSpeechTool,
} from "../src/agent-runtime.ts";

describe("fixed Pi agent runtime", () => {
	it("routes user-facing speech through the optional TTS MCP instead of a final-output webhook", () => {
		const prompt = buildAgentSystemPrompt(0.1, true);

		expect(prompt).toContain("不会通过回复 Webhook 自动发送");
		expect(prompt).toContain("必须调用 speak");
		expect(prompt).toContain("只用于结束内部回合");
		expect(prompt).toContain("距离 ÷ 时长");
		expect(prompt).toContain("0.1 米每秒");
		expect(prompt).toContain("方向默认为向前");
	});

	it("does not promise speech when the TTS MCP is not configured", () => {
		const prompt = buildAgentSystemPrompt(0.1, false);

		expect(prompt).toContain("当前没有配置 TTS MCP");
		expect(prompt).not.toContain("必须调用 speak");
	});

	it("forbids Bound and every form of flip in the fixed Agent prompt", () => {
		const prompt = buildAgentSystemPrompt(0.1);

		expect(prompt).toContain("禁止执行 Bound");
		expect(prompt).toContain("任何空翻动作");
		expect(prompt).toContain("前空翻、后空翻、侧空翻、连续空翻");
		expect(prompt).toContain("flip、somersault");
		expect(prompt).toContain("不得调用 execute_sport_command 或任何其他运动工具");
		expect(prompt).toContain("不得改写或映射为其他动作");
	});

	it("uses the atomic return-to-user greeting tool for that workflow", () => {
		const prompt = buildAgentSystemPrompt(0.1);

		expect(prompt).toContain("用户身边");
		expect(prompt).toContain("return_to_user_and_greet");
		expect(prompt).toContain("到达后静止 1 秒");
	});

	it("registers supported pinned official and custom wrapper MCP tools", () => {
		const tools = createDogTools({
			callTool: async () => "accepted",
		});

		expect(tools.map((tool) => tool.name)).toEqual([
			"move_forward",
			"move_backward",
			"stop_all",
			"motion_status",
			"server_status",
			"list_modules",
			"agent_send",
			"relative_move",
			"wait",
			"current_time",
			"execute_sport_command",
			"get_battery_soc",
			"observe",
			"tag_location",
			"navigate_with_text",
			"return_to_start",
			"return_to_user_and_greet",
			"begin_exploration",
			"start_patrol",
			"look_out_for",
			"start_stroll",
		]);
	});

	it("forwards speak text once to the dedicated TTS MCP", async () => {
		const calls: Array<{ name: string; arguments: Readonly<Record<string, unknown>> }> = [];
		const tool = createSpeechTool({
			callTool: async (name, arguments_) => {
				calls.push({ name, arguments: arguments_ });
				return "queued";
			},
		});

		await expect(
			tool.execute("speech-1", { text: "请注意前方。" }, undefined, undefined, undefined as never),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "queued" }],
		});
		expect(calls).toEqual([{ name: "speak", arguments: { text: "请注意前方。" } }]);
	});

	it("maps Agent session boundaries to structured logs without streaming reasoning deltas", () => {
		expect(agentSessionEventToRunLog({ type: "agent_start" })).toEqual({ event: "agent.run_started" });
		expect(
			agentSessionEventToRunLog({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "move_forward",
				args: { speed_mps: 0.1, duration_s: 2 },
			}),
		).toEqual({
			event: "agent.tool_started",
			tool_call_id: "call-1",
			tool_name: "move_forward",
			arguments: '{"speed_mps":0.1,"duration_s":2}',
		});
		expect(
			agentSessionEventToRunLog({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "move_forward",
				result: { content: [{ type: "text", text: "accepted" }], details: {} },
				isError: false,
			}),
		).toEqual({
			event: "agent.tool_completed",
			tool_call_id: "call-1",
			tool_name: "move_forward",
			is_error: false,
			output: "accepted",
		});
		expect(
			agentSessionEventToRunLog({
				type: "message_update",
				message: { role: "assistant", content: [], api: "test", provider: "test", model: "test" },
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "private reasoning",
					partial: { role: "assistant", content: [], api: "test", provider: "test", model: "test" },
				},
			} as never),
		).toBeUndefined();
		expect(
			agentSessionEventToRunLog({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 100,
				errorMessage: "Authorization: Bearer sk-secret-value",
			}),
		).toEqual({
			event: "agent.retry_started",
			attempt: 1,
			max_attempts: 3,
			delay_ms: 100,
			error: "Authorization: [redacted]",
		});
	});

	it("keeps robot and TTS MCP tools active while disabling built-in coding tools", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-runtime-"));
		try {
			const session = await createPiAgentSession({
				cwd: directory,
				agentDir: join(directory, "agent"),
				sessionDir: join(directory, "session"),
				defaultSpeedMps: 0.1,
				mcp: { callTool: async () => "accepted" },
				ttsMcp: { callTool: async () => "queued" },
			});

			expect(session.getActiveToolNames()).toEqual([
				"move_forward",
				"move_backward",
				"stop_all",
				"motion_status",
				"server_status",
				"list_modules",
				"agent_send",
				"relative_move",
				"wait",
				"current_time",
				"execute_sport_command",
				"get_battery_soc",
				"observe",
				"tag_location",
				"navigate_with_text",
				"return_to_start",
				"return_to_user_and_greet",
				"begin_exploration",
				"start_patrol",
				"look_out_for",
				"start_stroll",
				"speak",
			]);
			session.dispose();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
