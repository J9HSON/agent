import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GatewayStore } from "../src/store.ts";
import { buildRouteLegTaskSpec, buildTaskSpec } from "../src/task-contract.ts";

function withStore(run: (store: GatewayStore) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "gateway-task-store-"));
	const store = new GatewayStore(join(directory, "gateway.sqlite"));
	try {
		run(store);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("GatewayStore task bindings", () => {
	it("persists exactly one task for one processing instruction", () => {
		withStore((store) => {
			const instruction = {
				instructionId: "instruction-binding-1",
				text: "去门口测试点",
			};
			store.acceptInstruction(instruction, false, "2026-07-25T00:00:00.000Z");
			expect(store.claimNextNormalInstruction()).toEqual(instruction);
			const task = buildTaskSpec(
				instruction,
				{ kind: "go_to_place", destination: "门口测试点" },
				new Date("2026-07-25T00:00:01Z"),
			);

			const first = store.createTaskBinding(instruction.instructionId, task, "2026-07-25T00:00:01.000Z");
			const second = store.createTaskBinding(instruction.instructionId, task, "2026-07-25T00:00:02.000Z");

			expect(second).toEqual(first);
			expect(store.getTaskBinding(instruction.instructionId)?.taskId).toBe(task.task_id);
		});
	});

	it("keeps bound processing work recoverable but fails closed for unbound work", () => {
		withStore((store) => {
			const bound = {
				instructionId: "instruction-bound",
				text: "去门口测试点",
			};
			const unbound = {
				instructionId: "instruction-unbound",
				text: "没有绑定",
			};
			store.acceptInstruction(bound, false, "2026-07-25T00:00:00.000Z");
			store.acceptInstruction(unbound, false, "2026-07-25T00:00:00.000Z");
			expect(store.claimNextNormalInstruction()).toEqual(bound);
			const task = buildTaskSpec(
				bound,
				{ kind: "go_to_place", destination: "门口测试点" },
				new Date("2026-07-25T00:00:01Z"),
			);
			store.createTaskBinding(bound.instructionId, task, "2026-07-25T00:00:01.000Z");
			expect(store.claimNextNormalInstruction()).toEqual(unbound);

			store.recoverInterrupted("2026-07-25T00:00:02.000Z", "暂时无法完成此请求，请稍后重试。");

			expect(store.nextRecoverableTaskBinding()?.taskId).toBe(task.task_id);
			expect(store.nextDueReply(Date.now())?.event.instruction_id).toBe(unbound.instructionId);
		});
	});

	it("persists one route on the existing binding and advances one leg at a time", () => {
		withStore((store) => {
			const instruction = {
				instructionId: "instruction-route-binding",
				text: "客厅和门口往返两次",
			};
			const route = {
				kind: "visit_route" as const,
				waypoints: ["客厅", "门口"],
				repeat_count: 2,
			};
			store.acceptInstruction(instruction, false, "2026-07-25T00:00:00.000Z");
			expect(store.claimNextNormalInstruction()).toEqual(instruction);
			const firstTask = buildRouteLegTaskSpec(instruction, route, 0, new Date("2026-07-25T00:00:01Z"));

			const first = store.createRouteBinding(
				instruction.instructionId,
				route,
				firstTask,
				"2026-07-25T00:00:01.000Z",
			);
			expect(first.route).toEqual(route);
			expect(first.routeLegIndex).toBe(0);

			store.recordTaskSnapshot(
				firstTask.task_id,
				{
					task: firstTask,
					state: "completed",
					active: false,
					result: {
						summary: "arrived",
						evidence_ids: [`arrival:${firstTask.task_id}`],
					},
				},
				"2026-07-25T00:00:02.000Z",
			);
			const secondTask = buildRouteLegTaskSpec(instruction, route, 1, new Date("2026-07-25T00:00:03Z"));
			const second = store.advanceRouteBinding(instruction.instructionId, secondTask, 1, "2026-07-25T00:00:03.000Z");

			expect(second.task).toEqual(secondTask);
			expect(second.routeLegIndex).toBe(1);
			expect(second.compileStatus).toBe("compiled");
			expect(store.nextRecoverableTaskBinding()?.taskId).toBe(secondTask.task_id);
		});
	});

	it("adds route columns to an existing task-binding database", () => {
		const directory = mkdtempSync(join(tmpdir(), "gateway-task-store-migration-"));
		const path = join(directory, "gateway.sqlite");
		const database = new DatabaseSync(path);
		database.exec(`
			CREATE TABLE instructions (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				instruction_id TEXT NOT NULL UNIQUE,
				text TEXT NOT NULL,
				is_stop INTEGER NOT NULL,
				status TEXT NOT NULL,
				received_at TEXT NOT NULL
			);
			CREATE TABLE instruction_task_bindings (
				instruction_id TEXT PRIMARY KEY REFERENCES instructions(instruction_id),
				task_id TEXT NOT NULL UNIQUE,
				task_json TEXT NOT NULL,
				compile_status TEXT NOT NULL,
				last_state TEXT,
				last_snapshot_json TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
		database.close();

		const store = new GatewayStore(path);
		try {
			const instruction = {
				instructionId: "instruction-route-migration",
				text: "客厅和门口走一轮",
			};
			const route = {
				kind: "visit_route" as const,
				waypoints: ["客厅", "门口"],
				repeat_count: 1,
			};
			store.acceptInstruction(instruction, false, "2026-07-25T00:00:00.000Z");
			store.claimNextNormalInstruction();
			const task = buildRouteLegTaskSpec(instruction, route, 0, new Date("2026-07-25T00:00:01Z"));

			const binding = store.createRouteBinding(instruction.instructionId, route, task, "2026-07-25T00:00:01.000Z");

			expect(binding.route).toEqual(route);
			expect(binding.routeLegIndex).toBe(0);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
