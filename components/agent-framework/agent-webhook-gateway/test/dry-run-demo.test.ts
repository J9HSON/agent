import { describe, expect, it } from "vitest";
import { runDryRunDemo } from "./support/dry-run-demo.ts";

describe("local dry-run end-to-end demo", () => {
	it("routes robot actions and explicit Agent speech through separate MCP endpoints", async () => {
		const summary = await runDryRunDemo();

		expect(summary).toEqual({
			agentRuns: 1,
			wrapperToolCalls: ["move_forward", "stop_all"],
			dogToolCalls: ["move_forward", "stop_all"],
			ttsToolCalls: ["speak"],
			spokenTexts: ["dry-run 指令已被 MCP 接受。"],
		});
	});
});
