import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentModelConfig, ToolProfile } from "./config.ts";
import { createConfiguredAgentModel } from "./model-provider.ts";
import {
	type CompiledTaskParameters,
	parseCompiledTaskParameters,
	type TaskParameterCompiler,
} from "./task-contract.ts";
import type { McpToolCaller, UserTextAgent } from "./types.ts";

export function buildTaskCompilerSystemPrompt(): string {
	return `你是 Stage 2 机器狗任务参数编译器，不是任务执行器。

你没有任何工具，也不能调用 MCP、控制机器狗、生成 task_id、时间戳或任务终态。
	当前支持四种严格 JSON：
	- “去某个已确认地点”：
	{"kind":"go_to_place","destination":"地点名称"}
	- “把当前位置标记为某个名称”：
	{"kind":"mark_place","name":"地点名称"}
	- “依次前往多个已确认地点并重复有限次数”：
	{"kind":"visit_route","waypoints":["地点A","地点B"],"repeat_count":2}
	- “跟着我”“开始跟随我”：锁定启动时画面中央的人：
	{"kind":"follow_person"}

	只输出一行 JSON，不要 Markdown、解释或额外字段。地点名称必须保留用户原话。
	visit_route 必须至少两个地点，repeat_count 必须是用户明确给出的 1 到 20 的整数；
	没有明确次数时使用 1，绝不能输出无限循环。只有用户明确要求跟随自己时才使用
	follow_person；它不能包含人员描述、照片、bbox 或身份字段。无法确定意图时不要猜测。`;
}

export function buildAgentSystemPrompt(defaultSpeedMps: number, toolProfile: ToolProfile = "product"): string {
	const profileRules =
		toolProfile === "validation"
			? `当前是 Stage 1 真机验证模式，只允许五个工具：
- relative_move：执行短距离相对移动；
- return_to_start：返回本次 Runtime 捕获的起点；
- motion_status：读取本地命令执行状态；
- get_robot_summary：读取真实 odometry、actual path 和数据新鲜度；
- stop_all：立即停止所有活动。

执行移动或返回后，必须继续读取 motion_status 和 get_robot_summary。MCP 返回 accepted/started 只表示命令被接受，不等于机器人已经移动或到达。只有 fresh odometry 发生变化才能说机器人移动；只有回到容差内且状态 idle 才能说返回完成。`
			: `当前是 product 模式。只使用已注册的高层导航、探索、观察、状态和停止工具。
不得自行换算并调用低层相对位移、定时速度或运动动作工具。`;
	return `你是一个通过 MCP 控制机器狗的本地探索 Agent。

你的最终输出会直接发给用户。最终回复必须完整、简洁、直接面向用户，不得输出内部推理、工具调用过程、原始工具结果或异常堆栈。

${profileRules}

共同运动规则：
- 部署标定参考速度是 ${defaultSpeedMps} 米每秒，但不得用它伪造里程计结果。
- 禁止执行 Bound（包括大小写或格式变体）以及任何空翻动作，包括前空翻、后空翻、侧空翻、连续空翻，或命令名中含 flip、somersault 的动作。
- 收到上述禁止动作请求时必须明确拒绝；不得调用 execute_sport_command 或任何其他运动工具，也不得改写或映射为其他动作。

导航规则：
- 用户指定具名地点或自然语言目的地时，可调用 navigate_with_text；不得把它改写成定时直行。
- tag_location 只用于把机器狗当前地图位置保存为名称。
- “回到起点”或“返回启动位置”使用 return_to_start；它返回本次下层进程捕获的第一帧有效里程计位置，不依赖手工打点。
- “回到用户身边并打招呼”使用 return_to_user_and_greet；调用前必须已用 tag_location 标记“用户身边”，底层确认到达后静止 1 秒再执行 Hello，禁止拆成多个工具调用。
- “探索未知区域并尽量覆盖”使用 begin_exploration；“在已建图区域来回巡视”使用 start_patrol；“像人散步一样随机选一条未知分支并放弃其他分支”使用 start_stroll，三者不得混为一谈。
- 停止任何活动都使用 stop_all；它会统一停止定时速度、定点导航、探索、巡逻、散步和持续视觉查找。
- 导航、探索、巡逻、散步、视觉和设备控制只在下层 Go2 模式可用；下层返回 dry-run 或错误时，必须如实告诉用户没有启动真实能力。

规范化后精确等于“停”或“stop”的输入会在进入你之前由输入网关处理。其他文本都作为普通用户请求处理。`;
}

export function createDogTools(mcp: McpToolCaller, toolProfile: ToolProfile = "product") {
	const noArguments = Type.Object({}, { additionalProperties: false });
	const noArgumentTool = (name: string, label: string, description: string, promptSnippet: string) =>
		defineTool({
			name,
			label,
			description,
			promptSnippet,
			parameters: noArguments,
			executionMode: "sequential",
			execute: async (_toolCallId, _params, signal) => ({
				content: [{ type: "text", text: await mcp.callTool(name, {}, signal) }],
				details: {},
			}),
		});
	const motionParameters = Type.Object(
		{
			speed_mps: Type.Number({
				description: "用户指定或根据距离与时长计算得到的正有限速度，单位 m/s",
				exclusiveMinimum: 0,
			}),
			duration_s: Type.Number({
				description: "用户指定或根据距离与标定速度计算得到的正有限时长，单位秒",
				exclusiveMinimum: 0,
			}),
		},
		{ additionalProperties: false },
	);

	const moveForward = defineTool({
		name: "move_forward",
		label: "Move Forward",
		description: "按给定正速度和正时长让机器狗向前运动。",
		promptSnippet: "按用户给定或计算得到的速度和时长向前运动",
		parameters: motionParameters,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool(
						"move_forward",
						{ speed_mps: params.speed_mps, duration_s: params.duration_s },
						signal,
					),
				},
			],
			details: {},
		}),
	});

	const moveBackward = defineTool({
		name: "move_backward",
		label: "Move Backward",
		description: "按给定正速度和正时长让机器狗向后运动。",
		promptSnippet: "按用户给定或计算得到的速度和时长向后运动",
		parameters: motionParameters,
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool(
						"move_backward",
						{ speed_mps: params.speed_mps, duration_s: params.duration_s },
						signal,
					),
				},
			],
			details: {},
		}),
	});

	const stopAll = noArgumentTool(
		"stop_all",
		"Stop All",
		"统一停止定时速度、定点导航、探索、巡逻、散步和持续视觉查找。",
		"停止机器狗当前的所有活动",
	);

	const motionStatus = defineTool({
		name: "motion_status",
		label: "Motion Status",
		description: "读取 MCP 本地运动命令状态；该结果不是机器狗遥测。",
		promptSnippet: "读取本地运动命令状态",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("motion_status", {}, signal) }],
			details: {},
		}),
	});

	const getRobotSummary = noArgumentTool(
		"get_robot_summary",
		"Get Robot Summary",
		"读取真实 odometry、actual path、位移、累计路程和数据新鲜度。",
		"读取机器狗真实轨迹和状态摘要",
	);

	const serverStatus = noArgumentTool(
		"server_status",
		"Server Status",
		"读取下层 DIMOS MCP 的进程、模块与工具状态。",
		"读取下层 DIMOS MCP 状态",
	);

	const listModules = noArgumentTool(
		"list_modules",
		"List Modules",
		"列出下层 DIMOS 当前部署的模块及其工具。",
		"列出 DIMOS 模块",
	);

	const agentSend = defineTool({
		name: "agent_send",
		label: "Agent Send",
		description: "向下层 DIMOS Agent 的活动输入传输发送消息。",
		promptSnippet: "向下层 DIMOS Agent 发送消息",
		parameters: Type.Object(
			{ message: Type.String({ minLength: 1, description: "要发送给下层 Agent 的消息" }) },
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("agent_send", { message: params.message }, signal) }],
			details: {},
		}),
	});

	const relativeMove = defineTool({
		name: "relative_move",
		label: "Relative Move",
		description: "调用 DIMOS 官方相对位移，以当前位置为基准前后、左右移动并旋转。",
		promptSnippet: "按相对坐标移动机器狗",
		parameters: Type.Object(
			{
				forward: Type.Optional(Type.Number({ description: "前向位移，单位米，负数表示后退" })),
				left: Type.Optional(Type.Number({ description: "左向位移，单位米，负数表示向右" })),
				degrees: Type.Optional(Type.Number({ description: "最终相对旋转角度，单位度" })),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool(
						"relative_move",
						{
							forward: params.forward ?? 0,
							left: params.left ?? 0,
							degrees: params.degrees ?? 0,
						},
						signal,
					),
				},
			],
			details: {},
		}),
	});

	const wait = defineTool({
		name: "wait",
		label: "Wait",
		description: "调用 DIMOS 官方等待工具。",
		promptSnippet: "等待指定秒数",
		parameters: Type.Object(
			{ seconds: Type.Number({ minimum: 0, description: "等待秒数" }) },
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("wait", { seconds: params.seconds }, signal) }],
			details: {},
		}),
	});

	const currentTime = noArgumentTool(
		"current_time",
		"Current Time",
		"读取下层 DIMOS 运行环境的当前时间。",
		"读取机器端当前时间",
	);

	const executeSportCommand = defineTool({
		name: "execute_sport_command",
		label: "Execute Sport Command",
		description: "执行 DIMOS 官方 Unitree 命名运动指令。",
		promptSnippet: "执行 Unitree 命名运动指令",
		parameters: Type.Object(
			{ command_name: Type.String({ minLength: 1, description: "官方 Unitree 运动指令名称" }) },
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool("execute_sport_command", { command_name: params.command_name }, signal),
				},
			],
			details: {},
		}),
	});

	const getBatterySoc = noArgumentTool(
		"get_battery_soc",
		"Get Battery SOC",
		"读取 Go2 官方电池剩余百分比。",
		"读取机器狗电量",
	);

	const observe = noArgumentTool("observe", "Observe", "获取 Go2 官方当前相机观察结果。", "观察机器狗当前视野");

	const tagLocation = defineTool({
		name: "tag_location",
		label: "Tag Location",
		description: "把机器狗当前地图位置保存为可复用的名称。",
		promptSnippet: "命名并保存当前地图位置",
		parameters: Type.Object(
			{
				location_name: Type.String({
					description: "当前位置的人类可读名称",
					minLength: 1,
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool("tag_location", { location_name: params.location_name }, signal),
				},
			],
			details: {},
		}),
	});

	const navigateWithText = defineTool({
		name: "navigate_with_text",
		label: "Navigate With Text",
		description: "让 DIMOS 解析自然语言目的地，并使用官方地图和路径规划开始导航。",
		promptSnippet: "导航到具名地点或自然语言描述的目的地",
		parameters: Type.Object(
			{
				query: Type.String({
					description: "自然语言目的地或已标记位置名称",
					minLength: 1,
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool("navigate_with_text", { query: params.query }, signal),
				},
			],
			details: {},
		}),
	});

	const returnToStart = noArgumentTool(
		"return_to_start",
		"Return To Start",
		"返回本次下层进程启动后捕获的第一帧有效里程计位置；20 厘米内直接报告已在起点。",
		"返回本次运行的启动位置",
	);

	const returnToUserAndGreet = noArgumentTool(
		"return_to_user_and_greet",
		"Return To User And Greet",
		"导航到预先标记的“用户身边”，确认到达后静止 1 秒，再执行 Unitree Hello 问候动作。",
		"回到用户身边，静止一秒后打招呼",
	);

	const beginExploration = defineTool({
		name: "begin_exploration",
		label: "Begin Exploration",
		description: "启动 DIMOS Wavefront Frontier 自主探索未知区域。",
		promptSnippet: "开始自主探索未知区域",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("begin_exploration", {}, signal) }],
			details: {},
		}),
	});

	const startPatrol = defineTool({
		name: "start_patrol",
		label: "Start Patrol",
		description: "启动 DIMOS 在已知地图内的自主巡逻。",
		promptSnippet: "开始在已知地图内自主巡逻",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("start_patrol", {}, signal) }],
			details: {},
		}),
	});

	const lookOutFor = defineTool({
		name: "look_out_for",
		label: "Look Out For",
		description: "持续观察指定目标，发现后可触发另一个官方工具。",
		promptSnippet: "持续寻找指定目标",
		parameters: Type.Object(
			{
				description_of_things: Type.Array(Type.String({ minLength: 1 }), {
					minItems: 1,
					description: "要寻找的目标描述列表",
				}),
				// biome-ignore lint/suspicious/noThenProperty: DiMOS 0.0.14b1 defines this exact MCP argument name.
				then: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool(
						"look_out_for",
						{
							description_of_things: params.description_of_things,
							// biome-ignore lint/suspicious/noThenProperty: DiMOS 0.0.14b1 defines this exact MCP argument name.
							then: params.then ?? null,
						},
						signal,
					),
				},
			],
			details: {},
		}),
	});

	const startStroll = noArgumentTool(
		"start_stroll",
		"Start Stroll",
		"开始人类式散步：在局部未知分支中随机选一条并放弃其他分支，不追求地图覆盖率。",
		"开始非穷举的人类式自主散步",
	);

	const startTask = defineTool({
		name: "start_task",
		label: "Start Task",
		description: "向唯一 MissionExecutor 提交一个 canonical TaskSpec JSON。",
		promptSnippet: "提交高层机器狗任务",
		parameters: Type.Object(
			{
				task_json: Type.String({
					minLength: 1,
					description: "由 Gateway 生成的 canonical TaskSpec JSON",
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [
				{
					type: "text",
					text: await mcp.callTool("start_task", { task_json: params.task_json }, signal),
				},
			],
			details: {},
		}),
	});
	const taskIdTool = (name: "pause_task" | "resume_task" | "cancel_task", label: string, description: string) =>
		defineTool({
			name,
			label,
			description,
			promptSnippet: description,
			parameters: Type.Object(
				{
					task_id: Type.String({
						minLength: 8,
						description: "Gateway 持久化的稳定任务 ID",
					}),
				},
				{ additionalProperties: false },
			),
			executionMode: "sequential",
			execute: async (_toolCallId, params, signal) => ({
				content: [
					{
						type: "text",
						text: await mcp.callTool(name, { task_id: params.task_id }, signal),
					},
				],
				details: {},
			}),
		});
	const pauseTask = taskIdTool("pause_task", "Pause Task", "暂停 canonical 任务");
	const resumeTask = taskIdTool("resume_task", "Resume Task", "恢复 canonical 任务");
	const cancelTask = taskIdTool("cancel_task", "Cancel Task", "取消 canonical 任务");
	const getTaskStatus = noArgumentTool(
		"get_task_status",
		"Get Task Status",
		"读取 canonical 任务状态；accepted 不等于 completed。",
		"读取任务状态",
	);
	const listSemanticPlaces = noArgumentTool(
		"list_semantic_places",
		"List Semantic Places",
		"列出当前地图版本下已确认的语义地点。",
		"列出已确认地点",
	);

	const tools = [
		moveForward,
		moveBackward,
		stopAll,
		motionStatus,
		getRobotSummary,
		serverStatus,
		listModules,
		agentSend,
		relativeMove,
		wait,
		currentTime,
		executeSportCommand,
		getBatterySoc,
		observe,
		tagLocation,
		navigateWithText,
		returnToStart,
		returnToUserAndGreet,
		beginExploration,
		startPatrol,
		lookOutFor,
		startStroll,
		startTask,
		pauseTask,
		resumeTask,
		cancelTask,
		getTaskStatus,
		listSemanticPlaces,
	] as const;
	const profileToolNames =
		toolProfile === "validation"
			? ["relative_move", "return_to_start", "motion_status", "get_robot_summary", "stop_all"]
			: [
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
				];
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	return profileToolNames.map((name) => {
		const tool = toolsByName.get(name);
		if (!tool) {
			throw new Error(`Tool profile references unknown tool: ${name}`);
		}
		return tool;
	});
}

export interface PiUserTextAgentOptions {
	cwd: string;
	agentDir: string;
	sessionDir: string;
	defaultSpeedMps: number;
	toolProfile?: ToolProfile;
	agentModel: AgentModelConfig;
	mcp: McpToolCaller;
}

export async function createPiAgentSession(options: PiUserTextAgentOptions): Promise<AgentSession> {
	const configuredModel = await createConfiguredAgentModel(options.agentModel);
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: buildAgentSystemPrompt(options.defaultSpeedMps, options.toolProfile),
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.continueRecent(options.cwd, options.sessionDir);
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		resourceLoader,
		sessionManager,
		modelRuntime: configuredModel.modelRuntime,
		model: configuredModel.model,
		thinkingLevel: "off",
		noTools: "builtin",
		customTools: [...createDogTools(options.mcp, options.toolProfile)],
	});
	return session;
}

export class PiUserTextAgent implements UserTextAgent {
	private readonly session: AgentSession;

	private constructor(session: AgentSession) {
		this.session = session;
	}

	static async create(options: PiUserTextAgentOptions): Promise<PiUserTextAgent> {
		return new PiUserTextAgent(await createPiAgentSession(options));
	}

	async run(text: string): Promise<string> {
		const assistantMessagesBefore = this.session.messages.filter((message) => message.role === "assistant").length;
		await this.session.prompt(text, { expandPromptTemplates: false });
		const assistantMessagesAfter = this.session.messages.filter((message) => message.role === "assistant").length;
		if (assistantMessagesAfter <= assistantMessagesBefore) {
			throw new Error("Agent did not produce a final assistant message");
		}
		const reply = this.session.getLastAssistantText();
		if (!reply) {
			throw new Error("Agent produced an empty final assistant message");
		}
		return reply;
	}

	close(): void {
		this.session.dispose();
	}
}

export interface PiTaskParameterCompilerOptions {
	cwd: string;
	agentDir: string;
	sessionDir: string;
	agentModel: AgentModelConfig;
}

export async function createPiTaskCompilerSession(options: PiTaskParameterCompilerOptions): Promise<AgentSession> {
	const configuredModel = await createConfiguredAgentModel(options.agentModel);
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: buildTaskCompilerSystemPrompt(),
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.continueRecent(options.cwd, options.sessionDir);
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		resourceLoader,
		sessionManager,
		modelRuntime: configuredModel.modelRuntime,
		model: configuredModel.model,
		thinkingLevel: "off",
		noTools: "all",
	});
	return session;
}

export class PiTaskParameterCompiler implements TaskParameterCompiler {
	private readonly session: AgentSession;

	private constructor(session: AgentSession) {
		this.session = session;
	}

	static async create(options: PiTaskParameterCompilerOptions): Promise<PiTaskParameterCompiler> {
		return new PiTaskParameterCompiler(await createPiTaskCompilerSession(options));
	}

	async compile(text: string): Promise<CompiledTaskParameters> {
		const assistantMessagesBefore = this.session.messages.filter((message) => message.role === "assistant").length;
		await this.session.prompt(`将下面用户指令编译为规定的一行 JSON：\n${text}`, { expandPromptTemplates: false });
		const assistantMessagesAfter = this.session.messages.filter((message) => message.role === "assistant").length;
		if (assistantMessagesAfter <= assistantMessagesBefore) {
			throw new Error("Task compiler did not produce an assistant message");
		}
		const raw = this.session.getLastAssistantText();
		if (!raw) {
			throw new Error("Task compiler produced an empty response");
		}
		return parseCompiledTaskParameters(raw);
	}

	close(): void {
		this.session.dispose();
	}
}
