import { describe, expect, it } from "vitest";
import { buildTaskSpec, type MissionTaskSpec } from "../src/task-contract.ts";
import { TaskMonitor } from "../src/task-monitor.ts";
import type { McpToolCaller } from "../src/types.ts";

function task(): MissionTaskSpec {
	return buildTaskSpec(
		{ instructionId: "instruction-monitor-1", text: "去门口测试点" },
		{ kind: "go_to_place", destination: "门口测试点" },
		new Date("2026-07-25T00:00:00Z"),
	);
}

function sequenceMcp(
	responses: string[],
	calls: Array<{ name: string; arguments_: Readonly<Record<string, unknown>> }>,
): McpToolCaller {
	return {
		async callTool(name, arguments_) {
			calls.push({ name, arguments_ });
			const response = responses.shift();
			if (response === undefined) {
				throw new Error(`No fake response for ${name}`);
			}
			return response;
		},
	};
}

describe("TaskMonitor", () => {
	it("submits once and waits through accepted/navigating until terminal inactive", async () => {
		const calls: Array<{
			name: string;
			arguments_: Readonly<Record<string, unknown>>;
		}> = [];
		const mission = task();
		const mcp = sequenceMcp(
			[
				JSON.stringify({
					accepted: true,
					task_id: mission.task_id,
					state: "queued",
				}),
				JSON.stringify({
					task: mission,
					state: "navigating",
					active: true,
				}),
				JSON.stringify({
					task: mission,
					state: "completed",
					active: true,
					result: {
						summary: "arrived",
						evidence_ids: [`arrival:${mission.task_id}`],
					},
				}),
				JSON.stringify({
					task: mission,
					state: "completed",
					active: false,
					result: {
						summary: "arrived",
						evidence_ids: [`arrival:${mission.task_id}`],
					},
				}),
			],
			calls,
		);
		const monitor = new TaskMonitor(mcp, {
			pollIntervalMs: 1,
			timeoutMs: 1_000,
			sleep: async () => {},
		});
		const states: string[] = [];

		await monitor.submit(mission);
		const terminal = await monitor.waitForTerminal(mission, (snapshot) => states.push(snapshot.state));

		expect(terminal.state).toBe("completed");
		expect(terminal.active).toBe(false);
		expect(states).toEqual(["navigating", "completed", "completed"]);
		expect(calls.filter((call) => call.name === "start_task")).toHaveLength(1);
		expect(calls[0]).toEqual({
			name: "start_task",
			arguments_: { task_json: JSON.stringify(mission) },
		});
	});

	it("recovers by polling only and never resubmits the task", async () => {
		const calls: Array<{
			name: string;
			arguments_: Readonly<Record<string, unknown>>;
		}> = [];
		const mission = task();
		const monitor = new TaskMonitor(
			sequenceMcp(
				[
					JSON.stringify({
						task: mission,
						state: "cancelled",
						active: true,
						terminal_reason: "operator cancelled task",
					}),
					JSON.stringify({
						task: mission,
						state: "cancelled",
						active: false,
						terminal_reason: "operator cancelled task",
					}),
				],
				calls,
			),
			{
				pollIntervalMs: 1,
				timeoutMs: 1_000,
				sleep: async () => {},
			},
		);

		const terminal = await monitor.waitForTerminal(mission);

		expect(terminal.state).toBe("cancelled");
		expect(terminal.active).toBe(false);
		expect(calls.map((call) => call.name)).toEqual(["get_task_status", "get_task_status"]);
	});

	it("rejects another task or an idle executor instead of guessing", async () => {
		const mission = task();
		const other = { ...mission, task_id: "task-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
		const mismatch = new TaskMonitor(
			sequenceMcp(
				[
					JSON.stringify({
						task: other,
						state: "navigating",
						active: true,
					}),
				],
				[],
			),
			{ pollIntervalMs: 1, timeoutMs: 1_000, sleep: async () => {} },
		);
		const idle = new TaskMonitor(sequenceMcp([JSON.stringify({ active: false, state: "idle" })], []), {
			pollIntervalMs: 1,
			timeoutMs: 1_000,
			sleep: async () => {},
		});

		await expect(mismatch.waitForTerminal(mission)).rejects.toThrow("another task");
		await expect(idle.waitForTerminal(mission)).rejects.toThrow("does not know");
	});
});
