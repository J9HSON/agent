import { describe, expect, it } from "vitest";
import type { McpToolCaller } from "../src/types.ts";
import { ValidationUserTextAgent } from "../src/validation-agent.ts";

function fakeMcp(calls: Array<{ name: string; arguments_: Readonly<Record<string, unknown>> }>): McpToolCaller {
	return {
		async callTool(name, arguments_) {
			calls.push({ name, arguments_ });
			if (name === "motion_status") {
				return JSON.stringify({ command_state: "idle" });
			}
			if (name === "get_robot_summary") {
				return JSON.stringify({
					status: "ready",
					odometry: { fresh: true },
					displacement_from_start_m: 0.3,
					distance_travelled_m: 0.31,
					observed_motion_state: "stationary",
				});
			}
			return "accepted";
		},
	};
}

describe("ValidationUserTextAgent", () => {
	it("routes a bounded forward instruction through relative_move and reads evidence", async () => {
		const calls: Array<{ name: string; arguments_: Readonly<Record<string, unknown>> }> = [];
		const reply = await new ValidationUserTextAgent(fakeMcp(calls)).run("向前移动 0.3 米");

		expect(calls[0]).toEqual({
			name: "relative_move",
			arguments_: { forward: 0.3, left: 0, degrees: 0 },
		});
		expect(
			calls
				.slice(1)
				.map((call) => call.name)
				.sort(),
		).toEqual(["get_robot_summary", "motion_status"]);
		expect(reply).toContain("只代表命令已受理");
		expect(reply).toContain("fresh=true");
	});

	it("routes return to start and does not claim arrival", async () => {
		const calls: Array<{ name: string; arguments_: Readonly<Record<string, unknown>> }> = [];
		const reply = await new ValidationUserTextAgent(fakeMcp(calls)).run("回到起点");

		expect(calls[0]?.name).toBe("return_to_start");
		expect(reply).toContain("只代表命令已受理");
	});

	it("refuses a forward request above the Stage 1 bound without an MCP call", async () => {
		const calls: Array<{ name: string; arguments_: Readonly<Record<string, unknown>> }> = [];
		const reply = await new ValidationUserTextAgent(fakeMcp(calls)).run("向前移动 1.2 米");

		expect(calls).toEqual([]);
		expect(reply).toContain("未执行");
	});
});
