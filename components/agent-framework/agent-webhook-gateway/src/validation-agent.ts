import type { McpToolCaller, UserTextAgent } from "./types.ts";

const MAX_STAGE_ONE_DISTANCE_M = 1;

export class ValidationUserTextAgent implements UserTextAgent {
	private readonly mcp: McpToolCaller;

	constructor(mcp: McpToolCaller) {
		this.mcp = mcp;
	}

	async run(text: string): Promise<string> {
		const normalized = text.normalize("NFKC").trim().toLowerCase();

		if (/(回到|返回).{0,4}起点|return\s+to\s+start/u.test(normalized)) {
			const accepted = await this.mcp.callTool("return_to_start", {});
			return `已提交返回起点；这只代表命令已受理。${await this.readEvidence()} 下层返回：${accepted}`;
		}

		const distance = parseForwardDistance(normalized);
		if (distance !== undefined) {
			if (distance > MAX_STAGE_ONE_DISTANCE_M) {
				return `Stage 1 单次前进上限为 ${MAX_STAGE_ONE_DISTANCE_M} 米，本次未执行。`;
			}
			const accepted = await this.mcp.callTool("relative_move", {
				forward: distance,
				left: 0,
				degrees: 0,
			});
			return `已提交向前 ${distance} 米；这只代表命令已受理。${await this.readEvidence()} 下层返回：${accepted}`;
		}

		if (/停止|stop/u.test(normalized)) {
			const stopped = await this.mcp.callTool("stop_all", {});
			return `已调用统一停止。${await this.readEvidence()} 下层返回：${stopped}`;
		}

		if (/状态|里程计|轨迹|status|summary|odometry/u.test(normalized)) {
			return this.readEvidence();
		}

		return "Stage 1 验证 Agent 只支持：向前移动不超过 1 米、回到起点、查询状态/轨迹、停止。";
	}

	private async readEvidence(): Promise<string> {
		const [motionRaw, summaryRaw] = await Promise.all([
			this.mcp.callTool("motion_status", {}),
			this.mcp.callTool("get_robot_summary", {}),
		]);
		const motion = parseObject(motionRaw);
		const summary = parseObject(summaryRaw);
		const odometry = isObject(summary.odometry) ? summary.odometry : {};
		return [
			`命令状态=${String(motion.command_state ?? "unknown")}`,
			`里程计=${String(summary.status ?? "unknown")}`,
			`fresh=${String(odometry.fresh ?? false)}`,
			`当前相对 Runtime 起点位移=${String(summary.displacement_from_start_m ?? "unknown")}米`,
			`累计实际路程=${String(summary.distance_travelled_m ?? "unknown")}米`,
			`观测运动状态=${String(summary.observed_motion_state ?? "unknown")}`,
		].join("，");
	}
}

function parseForwardDistance(text: string): number | undefined {
	const match = text.match(/(?:向前|前进|forward).*?(\d+(?:\.\d+)?)\s*(?:米|m\b)/u);
	if (!match) {
		return undefined;
	}
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseObject(raw: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(raw);
		return isObject(value) ? value : {};
	} catch {
		return {};
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
