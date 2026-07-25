import { describe, expect, it } from "vitest";
import { runHealthCrossRepoDemo } from "./support/health-cross-repo-demo.ts";

const upstreamRoot = process.env.SMART_NECKBAND_HEALTH_ROOT;
const upstreamPython = process.env.SMART_NECKBAND_HEALTH_PYTHON;

describe.skipIf(!upstreamRoot || !upstreamPython)("Smart Collar Health MCP cross-repository integration", () => {
	it("delivers a real notification through the real stdio MCP without authentication or physical actions", async () => {
		const summary = await runHealthCrossRepoDemo({
			upstreamRoot: upstreamRoot!,
			upstreamPython: upstreamPython!,
		});

		expect(summary).toMatchObject({
			initialAck: "accepted",
			initialOutcome: "verified_no_action",
			duplicateAck: "duplicate",
			conflictStatus: 409,
			unauthenticatedStatus: 202,
			legacyAuthenticationHeadersStatus: 202,
			headerMismatchStatus: 400,
			schemaRejectionStatus: 400,
			replayOutcome: "unsafe_event_source",
			eventMismatchOutcome: "event_mismatch",
			concurrentAcks: { accepted: 1, duplicate: 4 },
			agentRuns: 0,
			dimosCalls: 0,
			robotCalls: 0,
		});
		expect(summary.healthMcpCalls).toBe(4);
	});
});
