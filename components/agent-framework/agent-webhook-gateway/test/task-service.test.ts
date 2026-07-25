import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpCallError } from "../src/mcp-client.ts";
import { AgentWebhookService } from "../src/service.ts";
import { GatewayStore } from "../src/store.ts";
import {
	buildRouteLegTaskSpec,
	buildTaskSpec,
	type TaskParameterCompiler,
	type VisitRouteParameters,
} from "../src/task-contract.ts";
import type { AgentReplyEvent, McpToolCaller, ReplyEventDelivery } from "../src/types.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function databasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "gateway-task-service-"));
	directories.push(directory);
	return join(directory, "gateway.sqlite");
}

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for task service");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

class RecordingCompiler implements TaskParameterCompiler {
	readonly prompts: string[] = [];

	async compile(text: string) {
		this.prompts.push(text);
		return { kind: "go_to_place" as const, destination: "门口测试点" };
	}
}

class FollowCompiler implements TaskParameterCompiler {
	async compile() {
		return { kind: "follow_person" as const };
	}
}

class MarkPlaceCompiler implements TaskParameterCompiler {
	async compile() {
		return { kind: "mark_place" as const, name: "会场门口" };
	}
}

class RouteCompiler implements TaskParameterCompiler {
	async compile() {
		return {
			kind: "visit_route" as const,
			waypoints: ["客厅", "门口"],
			repeat_count: 2,
		};
	}
}

class RecordingDelivery implements ReplyEventDelivery {
	readonly events: AgentReplyEvent[] = [];

	async deliver(event: AgentReplyEvent): Promise<void> {
		this.events.push(event);
	}
}

describe("AgentWebhookService task execution", () => {
	it("marks the current stable pose in the existing SemanticWorld", async () => {
		const delivery = new RecordingDelivery();
		const calls: Array<{ name: string; arguments_: Readonly<Record<string, unknown>> }> = [];
		const store = new GatewayStore(databasePath());
		const service = new AgentWebhookService({
			store,
			taskCompiler: new MarkPlaceCompiler(),
			mcp: {
				async callTool(name, arguments_) {
					calls.push({ name, arguments_ });
					if (name === "get_robot_summary") {
						return JSON.stringify({
							status: "ready",
							odometry: { fresh: true },
							relocalization: { required: true, ready: true },
							stable_pose: {
								frame_id: "map",
								source_ts: 100,
								x: 1.2,
								y: 3.4,
								z: 0,
								qx: 0,
								qy: 0,
								qz: 0.1,
								qw: 0.995,
								yaw_rad: 0.2,
							},
						});
					}
					if (name === "confirm_semantic_place") {
						return JSON.stringify({
							accepted: true,
							place: { name: "会场门口" },
						});
					}
					throw new Error(`Unexpected tool ${name}`);
				},
			},
			replyClient: delivery,
		});
		service.start();

		service.acceptInstruction({
			instructionId: "instruction-mark-place",
			text: "把这里标记为会场门口",
		});
		await waitFor(() => delivery.events.length === 1);

		expect(calls.map((call) => call.name)).toEqual(["get_robot_summary", "confirm_semantic_place"]);
		const placeJson = String(calls[1]?.arguments_.place_json);
		expect(JSON.parse(placeJson)).toEqual({
			name: "会场门口",
			aliases: [],
			pose: {
				frame_id: "map",
				ts: 100,
				x: 1.2,
				y: 3.4,
				z: 0,
				qx: 0,
				qy: 0,
				qz: 0.1,
				qw: 0.995,
			},
		});
		expect(delivery.events[0]?.text).toBe("已将当前位置标记为“会场门口”。");
		await service.close();
	});

	it("runs a finite named route by reusing existing go_to_place tasks", async () => {
		const delivery = new RecordingDelivery();
		const submittedTasks: Array<{ task_id: string; destination: string }> = [];
		let activeTask: Record<string, unknown> | undefined;
		const store = new GatewayStore(databasePath());
		const service = new AgentWebhookService({
			store,
			taskCompiler: new RouteCompiler(),
			mcp: {
				async callTool(name, arguments_) {
					if (name === "list_semantic_places") {
						return JSON.stringify({
							map_id: "venue",
							map_version: "v1",
							places: [
								{ name: "客厅", aliases: [] },
								{ name: "门口", aliases: [] },
							],
						});
					}
					if (name === "start_task") {
						activeTask = JSON.parse(String(arguments_.task_json)) as Record<string, unknown>;
						submittedTasks.push({
							task_id: String(activeTask.task_id),
							destination: String(activeTask.destination),
						});
						return JSON.stringify({
							accepted: true,
							task_id: activeTask.task_id,
							state: "queued",
						});
					}
					if (name === "get_task_status" && activeTask) {
						return JSON.stringify({
							task: activeTask,
							state: "completed",
							active: false,
							result: {
								summary: `arrived at ${String(activeTask.destination)}`,
								evidence_ids: [`arrival:${String(activeTask.task_id)}`],
							},
						});
					}
					throw new Error(`Unexpected tool ${name}`);
				},
			},
			replyClient: delivery,
			taskPollIntervalMs: 1,
			taskTimeoutMs: 1_000,
		});
		service.start();

		service.acceptInstruction({
			instructionId: "instruction-route-1",
			text: "在客厅和门口之间往返两次",
		});
		await waitFor(() => delivery.events.length === 1);

		expect(submittedTasks.map((task) => task.destination)).toEqual(["客厅", "门口", "客厅", "门口"]);
		expect(new Set(submittedTasks.map((task) => task.task_id)).size).toBe(4);
		expect(delivery.events[0]?.text).toBe("路线任务已完成：客厅 → 门口，共 2 轮。");
		const binding = store.getTaskBinding("instruction-route-1");
		expect(binding?.routeLegIndex).toBe(3);
		expect(binding?.compileStatus).toBe("terminal");
		await service.close();
	});

	it("routes exact manual inputs through the existing priority path without using the model", async () => {
		const delivery = new RecordingDelivery();
		const calls: Array<{ name: string; arguments_: Readonly<Record<string, unknown>> }> = [];
		const compiler: TaskParameterCompiler = {
			compile: async () => {
				throw new Error("manual input must bypass the model");
			},
		};
		const service = new AgentWebhookService({
			store: new GatewayStore(databasePath()),
			taskCompiler: compiler,
			mcp: {
				async callTool(name, arguments_) {
					calls.push({ name, arguments_ });
					return JSON.stringify({ status: "accepted" });
				},
			},
			replyClient: delivery,
		});
		service.start();

		service.acceptInstruction({
			instructionId: "instruction-manual-forward",
			text: "前进",
		});
		await waitFor(() => delivery.events.length === 1);

		expect(calls).toEqual([
			{ name: "stop_all", arguments_: {} },
			{
				name: "relative_move",
				arguments_: { forward: 0.2, left: 0, degrees: 0 },
			},
		]);
		expect(delivery.events[0]?.text).toBe("已提交前进一步指令。");
		await service.close();
	});

	it.each(["往前走", "请你往前走一下", "让机器狗向前移动", "move forward"])(
		"maps natural-language forward command %s to one bounded relative move",
		async (text) => {
			const delivery = new RecordingDelivery();
			const calls: Array<{ name: string; arguments_: Readonly<Record<string, unknown>> }> = [];
			const service = new AgentWebhookService({
				store: new GatewayStore(databasePath()),
				taskCompiler: {
					compile: async () => {
						throw new Error("natural-language manual input must bypass the model");
					},
				},
				mcp: {
					async callTool(name, arguments_) {
						calls.push({ name, arguments_ });
						return JSON.stringify({ status: "accepted" });
					},
				},
				replyClient: delivery,
			});
			service.start();

			service.acceptInstruction({
				instructionId: `instruction-natural-forward-${text}`,
				text,
			});
			await waitFor(() => delivery.events.length === 1);

			expect(calls).toEqual([
				{ name: "stop_all", arguments_: {} },
				{
					name: "relative_move",
					arguments_: { forward: 0.2, left: 0, degrees: 0 },
				},
			]);
			expect(delivery.events[0]?.text).toBe("已提交前进一步指令。");
			await service.close();
		},
	);

	it.each([
		["往后走", { forward: -0.2, left: 0, degrees: 0 }],
		["请向左走一下", { forward: 0, left: 0.2, degrees: 0 }],
		["让狗子往右移动", { forward: 0, left: -0.2, degrees: 0 }],
		["麻烦你左转一下", { forward: 0, left: 0, degrees: 15 }],
		["让机器人往右转", { forward: 0, left: 0, degrees: -15 }],
	] as const)(
		"maps natural-language manual command %s to the fixed product parameters",
		async (text, expectedArguments) => {
			const delivery = new RecordingDelivery();
			const calls: Array<{ name: string; arguments_: Readonly<Record<string, unknown>> }> = [];
			const service = new AgentWebhookService({
				store: new GatewayStore(databasePath()),
				taskCompiler: {
					compile: async () => {
						throw new Error("natural-language manual input must bypass the model");
					},
				},
				mcp: {
					async callTool(name, arguments_) {
						calls.push({ name, arguments_ });
						return JSON.stringify({ status: "accepted" });
					},
				},
				replyClient: delivery,
			});
			service.start();

			service.acceptInstruction({
				instructionId: `instruction-natural-manual-${text}`,
				text,
			});
			await waitFor(() => delivery.events.length === 1);

			expect(calls).toEqual([
				{ name: "stop_all", arguments_: {} },
				{ name: "relative_move", arguments_: expectedArguments },
			]);
			await service.close();
		},
	);

	it.each([
		"不要往前走",
		"往前走到门口",
		"往前走2米",
		"往前走然后左转",
		"向左边的厨房走",
		"左转后去门口",
		"看看状态然后去门口",
		"停一下再前进",
	])("does not turn compound or negated phrase %s into a direct physical command", async (text) => {
		const delivery = new RecordingDelivery();
		const prompts: string[] = [];
		const calls: string[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(databasePath()),
			taskCompiler: {
				compile: async (prompt) => {
					prompts.push(prompt);
					throw new Error("unsupported compound command");
				},
			},
			mcp: {
				callTool: async (name) => {
					calls.push(name);
					throw new Error("compound command must not reach MCP");
				},
			},
			replyClient: delivery,
		});
		service.start();

		service.acceptInstruction({
			instructionId: `instruction-natural-negative-${text}`,
			text,
		});
		await waitFor(() => delivery.events.length === 1);

		expect(prompts).toEqual([text]);
		expect(calls).toEqual([]);
		await service.close();
	});

	it("explains when the local MCP control chain is unavailable", async () => {
		const delivery = new RecordingDelivery();
		const service = new AgentWebhookService({
			store: new GatewayStore(databasePath()),
			taskCompiler: {
				compile: async () => {
					throw new Error("manual input must bypass the model");
				},
			},
			mcp: {
				callTool: async () => {
					throw new McpCallError("unavailable", "MCP wrapper is unavailable");
				},
			},
			replyClient: delivery,
		});
		service.start();

		service.acceptInstruction({
			instructionId: "instruction-control-chain-offline",
			text: "往前走",
		});
		await waitFor(() => delivery.events.length === 1);

		expect(delivery.events[0]?.text).toBe("控制链未连接：请先启动唯一 DimOS Runtime 和 MCP Wrapper。");
		await service.close();
	});

	it("does not report manual movement success when official relative_move fails", async () => {
		const delivery = new RecordingDelivery();
		const service = new AgentWebhookService({
			store: new GatewayStore(databasePath()),
			taskCompiler: {
				compile: async () => {
					throw new Error("manual input must bypass the model");
				},
			},
			mcp: {
				async callTool(name) {
					if (name === "stop_all") {
						return JSON.stringify({ status: "stopped", failed_components: [] });
					}
					if (name === "relative_move") {
						return "Navigation was cancelled or failed";
					}
					throw new Error(`Unexpected tool ${name}`);
				},
			},
			replyClient: delivery,
		});
		service.start();

		service.acceptInstruction({
			instructionId: "instruction-manual-failed",
			text: "前进",
		});
		await waitFor(() => delivery.events.length === 1);

		expect(delivery.events[0]?.text).toBe("暂时无法完成此请求，请稍后重试。");
		await service.close();
	});

	it("rejects place marking when odometry is stale", async () => {
		const delivery = new RecordingDelivery();
		const calls: string[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(databasePath()),
			taskCompiler: new MarkPlaceCompiler(),
			mcp: {
				async callTool(name) {
					calls.push(name);
					if (name === "get_robot_summary") {
						return JSON.stringify({
							status: "stale",
							odometry: { fresh: false },
							relocalization: { required: true, ready: true },
							stable_pose: {
								frame_id: "map",
								ts: 100,
								x: 1,
								y: 2,
								z: 0,
								qx: 0,
								qy: 0,
								qz: 0,
								qw: 1,
							},
						});
					}
					throw new Error(`Unexpected tool ${name}`);
				},
			},
			replyClient: delivery,
			onBackgroundError: () => {},
		});
		service.start();

		service.acceptInstruction({
			instructionId: "instruction-mark-stale",
			text: "把这里标记为会场门口",
		});
		await waitFor(() => delivery.events.length === 1);

		expect(calls).toEqual(["get_robot_summary"]);
		expect(delivery.events[0]?.text).toBe("暂时无法完成此请求，请稍后重试。");
		await service.close();
	});

	it("rejects a route containing an unconfirmed place before start_task", async () => {
		const delivery = new RecordingDelivery();
		const calls: string[] = [];
		const service = new AgentWebhookService({
			store: new GatewayStore(databasePath()),
			taskCompiler: new RouteCompiler(),
			mcp: {
				async callTool(name) {
					calls.push(name);
					if (name === "list_semantic_places") {
						return JSON.stringify({
							map_id: "venue",
							map_version: "v1",
							places: [{ name: "客厅", aliases: [] }],
						});
					}
					throw new Error(`Unexpected tool ${name}`);
				},
			},
			replyClient: delivery,
			onBackgroundError: () => {},
		});
		service.start();

		service.acceptInstruction({
			instructionId: "instruction-route-missing",
			text: "在客厅和门口之间往返两次",
		});
		await waitFor(() => delivery.events.length === 1);

		expect(calls).toEqual(["list_semantic_places"]);
		expect(delivery.events[0]?.text).toBe("暂时无法完成此请求，请稍后重试。");
		await service.close();
	});

	it("preempts an active task with exact pause, resume, and cancel commands", async () => {
		const compiler = new RecordingCompiler();
		const delivery = new RecordingDelivery();
		const calls: Array<{ name: string; arguments_: Readonly<Record<string, unknown>> }> = [];
		let activeTask: Record<string, unknown> | undefined;
		let cancelled = false;
		const service = new AgentWebhookService({
			store: new GatewayStore(databasePath()),
			taskCompiler: compiler,
			mcp: {
				async callTool(name, arguments_) {
					calls.push({ name, arguments_ });
					if (name === "start_task") {
						activeTask = JSON.parse(String(arguments_.task_json)) as Record<string, unknown>;
						return JSON.stringify({
							accepted: true,
							task_id: activeTask.task_id,
							state: "queued",
						});
					}
					if (name === "get_task_status" && activeTask) {
						if (cancelled) {
							return JSON.stringify({
								task: activeTask,
								state: "cancelled",
								active: false,
								terminal_reason: "operator cancelled task",
							});
						}
						return JSON.stringify({
							task: activeTask,
							state: "navigating",
							active: true,
						});
					}
					if (name === "pause_task" || name === "resume_task") {
						return JSON.stringify({ accepted: true });
					}
					if (name === "cancel_task") {
						cancelled = true;
						return JSON.stringify({ accepted: true });
					}
					throw new Error(`Unexpected tool ${name}`);
				},
			},
			replyClient: delivery,
			taskPollIntervalMs: 5,
			taskTimeoutMs: 1_000,
		});
		service.start();
		service.acceptInstruction({
			instructionId: "instruction-priority-task",
			text: "去门口测试点",
		});
		await waitFor(() => calls.some((call) => call.name === "get_task_status"));

		service.acceptInstruction({ instructionId: "instruction-pause", text: "暂停" });
		await waitFor(() => delivery.events.some((event) => event.instruction_id === "instruction-pause"));
		service.acceptInstruction({ instructionId: "instruction-resume", text: "继续" });
		await waitFor(() => delivery.events.some((event) => event.instruction_id === "instruction-resume"));
		service.acceptInstruction({ instructionId: "instruction-cancel", text: "取消任务" });
		await waitFor(() => delivery.events.length === 4);

		expect(compiler.prompts).toEqual(["去门口测试点"]);
		expect(calls.filter((call) => call.name === "pause_task")).toHaveLength(1);
		expect(calls.filter((call) => call.name === "resume_task")).toHaveLength(1);
		expect(calls.filter((call) => call.name === "cancel_task")).toHaveLength(1);
		expect(delivery.events.find((event) => event.instruction_id === "instruction-priority-task")?.text).toBe(
			"任务已取消：operator cancelled task。",
		);
		await service.close();
	});

	it("reports existing task, odometry, and semantic-place state without using the model", async () => {
		const delivery = new RecordingDelivery();
		const compiler: TaskParameterCompiler = {
			compile: async () => {
				throw new Error("status input must bypass the model");
			},
		};
		const service = new AgentWebhookService({
			store: new GatewayStore(databasePath()),
			taskCompiler: compiler,
			mcp: {
				async callTool(name) {
					if (name === "get_task_status") {
						return JSON.stringify({ state: "idle", active: false });
					}
					if (name === "get_robot_summary") {
						return JSON.stringify({
							status: "ready",
							odometry: { fresh: true },
						});
					}
					if (name === "list_semantic_places") {
						return JSON.stringify({
							map_id: "home",
							map_version: "v1",
							places: [{ name: "客厅" }, { name: "门口" }],
						});
					}
					throw new Error(`Unexpected tool ${name}`);
				},
			},
			replyClient: delivery,
		});
		service.start();

		service.acceptInstruction({ instructionId: "instruction-status", text: "状态" });
		await waitFor(() => delivery.events.length === 1);

		expect(delivery.events[0]?.text).toBe("机器人：ready；里程计：fresh；任务：idle（未运行）；已标记地点：2 个。");
		await service.close();
	});

	it("starts the official background follow tool and replies without inventing a MissionTask", async () => {
		const delivery = new RecordingDelivery();
		const calls: Array<{ name: string; arguments_: Readonly<Record<string, unknown>> }> = [];
		const store = new GatewayStore(databasePath());
		const service = new AgentWebhookService({
			store,
			taskCompiler: new FollowCompiler(),
			mcp: {
				async callTool(name, arguments_) {
					calls.push({ name, arguments_ });
					return "Found the person. Starting to follow.";
				},
			},
			replyClient: delivery,
		});
		service.start();

		service.acceptInstruction({
			instructionId: "instruction-follow-1",
			text: "跟着我",
		});
		await waitFor(() => delivery.events.length === 1);

		expect(calls).toEqual([
			{
				name: "follow_person",
				arguments_: {
					query: "the person closest to the center of the image",
				},
			},
		]);
		expect(delivery.events[0]?.text).toContain("画面中央的人");
		expect(store.getTaskBinding("instruction-follow-1")).toBeUndefined();
		await service.close();
	});

	it("does not reply on accepted or navigating and submits a duplicate instruction only once", async () => {
		const compiler = new RecordingCompiler();
		const delivery = new RecordingDelivery();
		const calls: string[] = [];
		let statusCalls = 0;
		let releaseCompletion: (() => void) | undefined;
		const completionAllowed = new Promise<void>((resolve) => {
			releaseCompletion = resolve;
		});
		let taskId = "";
		let taskJson = "";
		const mcp: McpToolCaller = {
			async callTool(name, arguments_) {
				calls.push(name);
				if (name === "start_task") {
					taskJson = String(arguments_.task_json);
					taskId = JSON.parse(taskJson).task_id as string;
					return JSON.stringify({
						accepted: true,
						task_id: taskId,
						state: "queued",
					});
				}
				if (name === "get_task_status") {
					statusCalls++;
					if (statusCalls === 1) {
						return JSON.stringify({
							task: JSON.parse(taskJson),
							state: "navigating",
							active: true,
						});
					}
					await completionAllowed;
					return JSON.stringify({
						task: JSON.parse(taskJson),
						state: "completed",
						active: false,
						result: {
							summary: "arrived",
							evidence_ids: [`arrival:${taskId}`],
						},
					});
				}
				throw new Error(`Unexpected tool ${name}`);
			},
		};
		const store = new GatewayStore(databasePath());
		const service = new AgentWebhookService({
			store,
			taskCompiler: compiler,
			mcp,
			replyClient: delivery,
			taskPollIntervalMs: 1,
			taskTimeoutMs: 1_000,
		});
		service.start();

		service.acceptInstruction({
			instructionId: "instruction-semantic-1",
			text: "去门口测试点",
		});
		service.acceptInstruction({
			instructionId: "instruction-semantic-1",
			text: "去门口测试点",
		});
		await waitFor(() => statusCalls >= 1);
		expect(delivery.events).toEqual([]);
		releaseCompletion?.();
		await waitFor(() => delivery.events.length === 1);

		expect(compiler.prompts).toEqual(["去门口测试点"]);
		expect(calls.filter((name) => name === "start_task")).toHaveLength(1);
		expect(delivery.events[0]?.text).toBe("任务已完成：已到达“门口测试点”。");
		expect(store.getTaskBinding("instruction-semantic-1")?.taskId).toBe(taskId);

		await service.close();
	});

	it("recovers a bound instruction by monitoring without calling start_task again", async () => {
		const path = databasePath();
		const instruction = {
			instructionId: "instruction-restart-1",
			text: "回到测试起点",
		};
		const firstStore = new GatewayStore(path);
		firstStore.acceptInstruction(instruction, false, "2026-07-25T00:00:00.000Z");
		firstStore.claimNextNormalInstruction();
		const task = buildTaskSpec(
			instruction,
			{ kind: "go_to_place", destination: "测试起点" },
			new Date("2026-07-25T00:00:01Z"),
		);
		firstStore.createTaskBinding(instruction.instructionId, task, "2026-07-25T00:00:01.000Z");
		firstStore.markTaskSubmitted(task.task_id, "2026-07-25T00:00:02.000Z");
		firstStore.close();

		const calls: string[] = [];
		const delivery = new RecordingDelivery();
		const compiler: TaskParameterCompiler = {
			compile: async () => {
				throw new Error("recovery must not recompile");
			},
		};
		const secondStore = new GatewayStore(path);
		const service = new AgentWebhookService({
			store: secondStore,
			taskCompiler: compiler,
			mcp: {
				async callTool(name) {
					calls.push(name);
					return JSON.stringify({
						task,
						state: "cancelled",
						active: false,
						terminal_reason: "operator cancelled task",
					});
				},
			},
			replyClient: delivery,
			taskPollIntervalMs: 1,
			taskTimeoutMs: 1_000,
		});

		service.start();
		await waitFor(() => delivery.events.length === 1);

		expect(calls).toEqual(["get_task_status"]);
		expect(delivery.events[0]?.text).toBe("任务已取消：operator cancelled task。");
		expect(secondStore.getTaskBinding(instruction.instructionId)?.compileStatus).toBe("terminal");
		await service.close();
	});

	it("resumes only the remaining route legs after a gateway restart", async () => {
		const path = databasePath();
		const instruction = {
			instructionId: "instruction-route-restart",
			text: "从客厅去门口",
		};
		const route: VisitRouteParameters = {
			kind: "visit_route",
			waypoints: ["客厅", "门口"],
			repeat_count: 1,
		};
		const firstTask = buildRouteLegTaskSpec(instruction, route, 0, new Date("2026-07-25T00:00:01Z"));
		const firstStore = new GatewayStore(path);
		firstStore.acceptInstruction(instruction, false, "2026-07-25T00:00:00.000Z");
		firstStore.claimNextNormalInstruction();
		firstStore.createRouteBinding(instruction.instructionId, route, firstTask, "2026-07-25T00:00:01.000Z");
		firstStore.markTaskSubmitted(firstTask.task_id, "2026-07-25T00:00:02.000Z");
		firstStore.close();

		const calls: Array<{ name: string; taskId?: string }> = [];
		let activeTask: Record<string, unknown> = { ...firstTask };
		const delivery = new RecordingDelivery();
		const secondStore = new GatewayStore(path);
		const service = new AgentWebhookService({
			store: secondStore,
			taskCompiler: {
				compile: async () => {
					throw new Error("route recovery must not recompile");
				},
			},
			mcp: {
				async callTool(name, arguments_) {
					if (name === "start_task") {
						activeTask = JSON.parse(String(arguments_.task_json)) as Record<string, unknown>;
						calls.push({ name, taskId: String(activeTask.task_id) });
						return JSON.stringify({
							accepted: true,
							task_id: activeTask.task_id,
							state: "queued",
						});
					}
					if (name === "get_task_status") {
						calls.push({ name, taskId: String(activeTask.task_id) });
						return JSON.stringify({
							task: activeTask,
							state: "completed",
							active: false,
							result: {
								summary: `arrived at ${String(activeTask.destination)}`,
								evidence_ids: [`arrival:${String(activeTask.task_id)}`],
							},
						});
					}
					throw new Error(`Unexpected tool ${name}`);
				},
			},
			replyClient: delivery,
			taskPollIntervalMs: 1,
			taskTimeoutMs: 1_000,
		});

		service.start();
		await waitFor(() => delivery.events.length === 1);

		expect(calls[0]).toEqual({ name: "get_task_status", taskId: firstTask.task_id });
		expect(calls.filter((call) => call.name === "start_task")).toHaveLength(1);
		expect(calls.find((call) => call.name === "start_task")?.taskId).not.toBe(firstTask.task_id);
		expect(delivery.events[0]?.text).toBe("路线任务已完成：客厅 → 门口，共 1 轮。");
		expect(secondStore.getTaskBinding(instruction.instructionId)?.routeLegIndex).toBe(1);
		expect(secondStore.getTaskBinding(instruction.instructionId)?.compileStatus).toBe("terminal");
		await service.close();
	});
});
