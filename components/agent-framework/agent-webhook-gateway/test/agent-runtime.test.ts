import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildAgentSystemPrompt,
	buildTaskCompilerSystemPrompt,
	createDogTools,
	createPiAgentSession,
	createPiTaskCompilerSession,
} from "../src/agent-runtime.ts";

const TEST_AGENT_MODEL = {
	provider: "siliconflow-test",
	modelId: "zai-org/GLM-5.2",
	baseUrl: "https://api.siliconflow.cn/v1",
	apiKey: "test-api-key",
} as const;

describe("fixed Pi agent runtime", () => {
	it("constrains the Stage 2 compiler to strict parameters without task identity", () => {
		const prompt = buildTaskCompilerSystemPrompt();

		expect(prompt).toContain('"kind":"go_to_place"');
		expect(prompt).toContain('"destination":"地点名称"');
		expect(prompt).toContain('"kind":"mark_place"');
		expect(prompt).toContain('"kind":"visit_route"');
		expect(prompt).toContain('"repeat_count":2');
		expect(prompt).toContain('"kind":"follow_person"');
		expect(prompt).toContain("启动时画面中央的人");
		expect(prompt).toContain("不能调用 MCP");
		expect(prompt).toContain("不能");
		expect(prompt).toContain("task_id");
	});

	it("creates the product task compiler with no active tools", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-task-compiler-"));
		try {
			const session = await createPiTaskCompilerSession({
				cwd: directory,
				agentDir: join(directory, "agent"),
				sessionDir: join(directory, "session"),
				agentModel: TEST_AGENT_MODEL,
			});

			expect(session.getActiveToolNames()).toEqual([]);
			expect(session.model).toMatchObject({
				provider: "siliconflow-test",
				id: "zai-org/GLM-5.2",
			});
			session.dispose();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("always tells the model that its final answer is delivered directly to the user", () => {
		const prompt = buildAgentSystemPrompt(0.1, "validation");

		expect(prompt).toContain("你的最终输出会直接发给用户");
		expect(prompt).toContain("Stage 1");
		expect(prompt).toContain("relative_move");
		expect(prompt).toContain("get_robot_summary");
		expect(prompt).toContain("accepted");
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
			"stop_all",
			"motion_status",
			"get_robot_summary",
			"server_status",
			"list_modules",
			"current_time",
			"get_battery_soc",
			"observe",
			"start_task",
			"pause_task",
			"resume_task",
			"cancel_task",
			"get_task_status",
			"list_semantic_places",
		]);
	});

	it("registers exactly the five Stage 1 validation tools", () => {
		const tools = createDogTools(
			{
				callTool: async () => "accepted",
			},
			"validation",
		);

		expect(tools.map((tool) => tool.name)).toEqual([
			"relative_move",
			"return_to_start",
			"motion_status",
			"get_robot_summary",
			"stop_all",
		]);
	});

	it("keeps only product MCP tools active while disabling built-in coding tools", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-runtime-"));
		try {
			const session = await createPiAgentSession({
				cwd: directory,
				agentDir: join(directory, "agent"),
				sessionDir: join(directory, "session"),
				defaultSpeedMps: 0.1,
				agentModel: TEST_AGENT_MODEL,
				mcp: { callTool: async () => "accepted" },
			});

			expect(session.getActiveToolNames()).toEqual([
				"stop_all",
				"motion_status",
				"get_robot_summary",
				"server_status",
				"list_modules",
				"current_time",
				"get_battery_soc",
				"observe",
				"start_task",
				"pause_task",
				"resume_task",
				"cancel_task",
				"get_task_status",
				"list_semantic_places",
			]);
			expect(session.model).toMatchObject({
				provider: "siliconflow-test",
				id: "zai-org/GLM-5.2",
			});
			session.dispose();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
