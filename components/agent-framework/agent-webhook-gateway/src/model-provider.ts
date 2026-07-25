import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentModelConfig } from "./config.ts";

const EMPTY_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
} as const;

export interface ConfiguredAgentModel {
	modelRuntime: ModelRuntime;
	model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
}

export async function createConfiguredAgentModel(config: AgentModelConfig): Promise<ConfiguredAgentModel> {
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	modelRuntime.registerProvider(config.provider, {
		name: config.provider,
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		api: "openai-completions",
		authHeader: true,
		models: [
			{
				id: config.modelId,
				name: config.modelId,
				reasoning: false,
				input: ["text"],
				cost: EMPTY_COST,
				contextWindow: 1_000_000,
				maxTokens: 4_096,
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
			},
		],
	});
	await modelRuntime.refresh({ allowNetwork: false });
	const model = modelRuntime.getModel(config.provider, config.modelId);
	if (!model) {
		throw new Error(`Configured Agent model is unavailable: ${config.provider}/${config.modelId}`);
	}
	return { modelRuntime, model };
}
