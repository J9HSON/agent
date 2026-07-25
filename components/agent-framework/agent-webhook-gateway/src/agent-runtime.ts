import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeGatewayLogText } from "./logging.ts";
import type { AgentRunLogEvent, McpToolCaller, UserTextAgent } from "./types.ts";

export function buildAgentSystemPrompt(defaultSpeedMps: number, ttsEnabled = false): string {
	return `你是一个通过 MCP 控制机器狗的本地探索 Agent。

语音输出规则：
- 你的最终 assistant 文本不会通过回复 Webhook 自动发送，只用于结束内部回合。
${
	ttsEnabled
		? `- 当前已配置独立 TTS MCP。所有需要让用户听到的内容，包括追问、拒绝、错误说明和动作结果，都必须调用 speak，并把完整、简洁、直接面向用户的文本放入 text。
- speak 成功只表示 TTS MCP 接受了请求；不得虚构扬声器已经出声。speak 失败时不得自动重试或声称播报成功。`
		: "- 当前没有配置 TTS MCP，不能向用户播报，也不得声称已经播报。"
}
- 面向用户的内容不得包含内部推理、工具调用过程、原始工具结果或异常堆栈。

运动规则：
- 用户可以提供“速度加时长”“距离加时长”或仅“距离”。方向可选，方向默认为向前。
- “距离加时长”使用“距离 ÷ 时长”计算速度。
- 仅提供距离时，使用部署标定速度 ${defaultSpeedMps} 米每秒计算时长。
- 速度和时长只需是正的有限数值，不添加硬编码范围限制，也不得擅自改变用户指定的数值。
- 只有时长或只有速度时参数不完整，必须向用户追问，不得调用运动工具或套用默认参数。
- 当前只支持向前和向后。左、右、转向等请求必须说明尚不支持，不得映射为前后运动。
- 距离运动是基于速度和时长的估算，不得声称机器狗精确移动或到达了指定距离。
- 工具调用成功只说明命令已被 MCP 接受；面向用户的 speak 文本不得虚构机器狗遥测或物理状态。
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

export function createDogTools(mcp: McpToolCaller) {
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

	return [
		moveForward,
		moveBackward,
		stopAll,
		motionStatus,
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
	] as const;
}

export function createSpeechTool(mcp: McpToolCaller) {
	return defineTool({
		name: "speak",
		label: "Speak",
		description: "把完整的用户可见文本发送给独立 TTS MCP，由该服务负责语音合成与播放。",
		promptSnippet: "通过独立 TTS MCP 向用户播报文本",
		parameters: Type.Object(
			{
				text: Type.String({
					minLength: 1,
					description: "需要由 TTS 完整播报给用户的文本",
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => ({
			content: [{ type: "text", text: await mcp.callTool("speak", { text: params.text }, signal) }],
			details: {},
		}),
	});
}

export interface PiUserTextAgentOptions {
	cwd: string;
	agentDir: string;
	sessionDir: string;
	defaultSpeedMps: number;
	mcp: McpToolCaller;
	ttsMcp?: McpToolCaller;
}

export function agentSessionEventToRunLog(event: AgentSessionEvent): AgentRunLogEvent | undefined {
	switch (event.type) {
		case "agent_start":
			return { event: "agent.run_started" };
		case "turn_start":
			return { event: "agent.turn_started" };
		case "message_start":
			return isAssistantMessage(event.message) ? { event: "agent.response_started" } : undefined;
		case "message_end": {
			if (!isAssistantMessage(event.message)) {
				return undefined;
			}
			const output = readTextContent(event.message);
			return {
				event: "agent.response_completed",
				...(output === undefined ? {} : { output }),
			};
		}
		case "tool_execution_start":
			return {
				event: "agent.tool_started",
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				arguments: describeLogValue(event.args),
			};
		case "tool_execution_end": {
			const output = readTextContent(event.result);
			return {
				event: "agent.tool_completed",
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				is_error: event.isError,
				...(output === undefined ? {} : { output }),
			};
		}
		case "turn_end": {
			const stopReason =
				isRecord(event.message) && typeof event.message.stopReason === "string"
					? describeGatewayLogText(event.message.stopReason)
					: undefined;
			return {
				event: "agent.turn_completed",
				tool_result_count: event.toolResults.length,
				...(stopReason === undefined ? {} : { stop_reason: stopReason }),
			};
		}
		case "agent_end":
			return { event: "agent.run_completed", will_retry: event.willRetry };
		case "auto_retry_start":
			return {
				event: "agent.retry_started",
				attempt: event.attempt,
				max_attempts: event.maxAttempts,
				delay_ms: event.delayMs,
				error: describeGatewayLogText(event.errorMessage),
			};
		case "auto_retry_end":
			return {
				event: "agent.retry_completed",
				success: event.success,
				attempt: event.attempt,
				...(event.finalError === undefined ? {} : { final_error: describeGatewayLogText(event.finalError) }),
			};
		case "compaction_start":
			return { event: "agent.compaction_started", reason: event.reason };
		case "compaction_end":
			return {
				event: "agent.compaction_completed",
				reason: event.reason,
				aborted: event.aborted,
				will_retry: event.willRetry,
				...(event.errorMessage === undefined ? {} : { error: describeGatewayLogText(event.errorMessage) }),
			};
		default:
			return undefined;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

function isAssistantMessage(value: unknown): value is Readonly<Record<string, unknown>> {
	return isRecord(value) && value.role === "assistant";
}

function readTextContent(value: unknown): string | undefined {
	if (!isRecord(value) || !Array.isArray(value.content)) {
		return undefined;
	}
	const text = value.content
		.filter(
			(item): item is Readonly<{ type: "text"; text: string }> =>
				isRecord(item) && item.type === "text" && typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("");
	return text.length === 0 ? undefined : describeGatewayLogText(text);
}

function describeLogValue(value: unknown): string {
	try {
		return describeGatewayLogText(JSON.stringify(value) ?? "undefined");
	} catch {
		return "[unserializable]";
	}
}

export async function createPiAgentSession(options: PiUserTextAgentOptions): Promise<AgentSession> {
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
		systemPrompt: buildAgentSystemPrompt(options.defaultSpeedMps, options.ttsMcp !== undefined),
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.continueRecent(options.cwd, options.sessionDir);
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		resourceLoader,
		sessionManager,
		noTools: "builtin",
		customTools: [...createDogTools(options.mcp), ...(options.ttsMcp ? [createSpeechTool(options.ttsMcp)] : [])],
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

	async run(text: string, onLog?: (event: AgentRunLogEvent) => void): Promise<string> {
		const assistantMessagesBefore = this.session.messages.filter((message) => message.role === "assistant").length;
		const unsubscribe = onLog
			? this.session.subscribe((event) => {
					const logEvent = agentSessionEventToRunLog(event);
					if (logEvent) {
						onLog(logEvent);
					}
				})
			: undefined;
		try {
			await this.session.prompt(text, { expandPromptTemplates: false });
			const assistantMessagesAfter = this.session.messages.filter((message) => message.role === "assistant").length;
			if (assistantMessagesAfter <= assistantMessagesBefore) {
				throw new Error("Agent did not produce a final assistant message");
			}
			const assistantText = this.session.getLastAssistantText();
			if (!assistantText) {
				throw new Error("Agent produced an empty final assistant message");
			}
			return assistantText;
		} finally {
			unsubscribe?.();
		}
	}

	close(): void {
		this.session.dispose();
	}
}
