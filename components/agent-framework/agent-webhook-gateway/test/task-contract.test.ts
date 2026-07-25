import { describe, expect, it } from "vitest";
import {
	buildRouteLegTaskSpec,
	buildTaskSpec,
	parseCompiledTaskParameters,
	taskIdForInstruction,
	taskIdForRouteLeg,
	totalRouteLegs,
} from "../src/task-contract.ts";

describe("Stage 2 task contract", () => {
	it("accepts only one strict go_to_place parameter object", () => {
		expect(parseCompiledTaskParameters('{"kind":"go_to_place","destination":" 门口测试点 "}')).toEqual({
			kind: "go_to_place",
			destination: "门口测试点",
		});

		for (const raw of [
			'{"kind":"find_target","destination":"门"}',
			'{"kind":"go_to_place","destination":""}',
			'{"kind":"go_to_place","destination":"门口","task_id":"model-id"}',
			'```json\n{"kind":"go_to_place","destination":"门口"}\n```',
			"not json",
		]) {
			expect(() => parseCompiledTaskParameters(raw), raw).toThrow();
		}
	});

	it("accepts only the fixed center-person follow parameter object", () => {
		expect(parseCompiledTaskParameters('{"kind":"follow_person"}')).toEqual({
			kind: "follow_person",
		});

		for (const raw of [
			'{"kind":"follow_person","target_description":"穿红衣服的人"}',
			'{"kind":"follow_person","task_id":"model-id"}',
			'{"kind":"follow_person","destination":"用户身边"}',
		]) {
			expect(() => parseCompiledTaskParameters(raw), raw).toThrow();
		}
	});

	it("accepts strict current-place marking without coordinates from the model", () => {
		expect(parseCompiledTaskParameters('{"kind":"mark_place","name":" 会场   门口 "}')).toEqual({
			kind: "mark_place",
			name: "会场 门口",
		});

		for (const raw of [
			'{"kind":"mark_place","name":""}',
			'{"kind":"mark_place","name":"门口","x":1,"y":2}',
			'{"kind":"mark_place","name":"门口","aliases":[]}',
		]) {
			expect(() => parseCompiledTaskParameters(raw), raw).toThrow();
		}
	});

	it("accepts only finite named routes with at least two waypoints", () => {
		expect(
			parseCompiledTaskParameters('{"kind":"visit_route","waypoints":[" 客厅 "," 门口 "],"repeat_count":2}'),
		).toEqual({
			kind: "visit_route",
			waypoints: ["客厅", "门口"],
			repeat_count: 2,
		});

		for (const raw of [
			'{"kind":"visit_route","waypoints":["客厅"],"repeat_count":2}',
			'{"kind":"visit_route","waypoints":["客厅","门口"],"repeat_count":0}',
			'{"kind":"visit_route","waypoints":["客厅","门口"],"repeat_count":1.5}',
			'{"kind":"visit_route","waypoints":["客厅",""],"repeat_count":1}',
			'{"kind":"visit_route","waypoints":["客厅","门口"],"repeat_count":1,"forever":true}',
		]) {
			expect(() => parseCompiledTaskParameters(raw), raw).toThrow();
		}
	});

	it("derives one legal stable task ID from the instruction ID", () => {
		const first = taskIdForInstruction("ring instruction/中文/001");
		const second = taskIdForInstruction("ring instruction/中文/001");

		expect(first).toBe(second);
		expect(first).toMatch(/^task-[a-f0-9]{32}$/u);
		expect(taskIdForInstruction("different")).not.toBe(first);
	});

	it("lets the gateway own task identity and UTC creation time", () => {
		const task = buildTaskSpec(
			{ instructionId: "instruction-stage2-1", text: "去门口测试点" },
			{ kind: "go_to_place", destination: "门口测试点" },
			new Date("2026-07-25T06:00:00+08:00"),
		);

		expect(task).toEqual({
			task_id: taskIdForInstruction("instruction-stage2-1"),
			kind: "go_to_place",
			destination: "门口测试点",
			target_description: null,
			question: null,
			priority: "normal",
			created_at: "2026-07-24T22:00:00.000Z",
		});
	});

	it("expands a route into deterministic existing go_to_place tasks", () => {
		const instruction = {
			instructionId: "instruction-route-1",
			text: "客厅和门口往返两次",
		};
		const route = {
			kind: "visit_route" as const,
			waypoints: ["客厅", "门口"],
			repeat_count: 2,
		};

		expect(totalRouteLegs(route)).toBe(4);
		expect(taskIdForRouteLeg(instruction.instructionId, 0)).toBe(taskIdForRouteLeg(instruction.instructionId, 0));
		expect(taskIdForRouteLeg(instruction.instructionId, 0)).not.toBe(taskIdForRouteLeg(instruction.instructionId, 1));
		expect(
			[0, 1, 2, 3].map(
				(index) => buildRouteLegTaskSpec(instruction, route, index, new Date("2026-07-25T00:00:00Z")).destination,
			),
		).toEqual(["客厅", "门口", "客厅", "门口"]);
	});
});
