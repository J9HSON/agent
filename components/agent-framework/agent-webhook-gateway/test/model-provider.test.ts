import { describe, expect, it } from "vitest";
import { createConfiguredAgentModel } from "../src/model-provider.ts";

describe("configured Agent model", () => {
	it("builds the requested OpenAI-compatible model without network discovery", async () => {
		const configured = await createConfiguredAgentModel({
			provider: "siliconflow-test",
			modelId: "zai-org/GLM-5.2",
			baseUrl: "https://api.siliconflow.cn/v1",
			apiKey: "test-api-key",
		});

		expect(configured.model).toMatchObject({
			provider: "siliconflow-test",
			id: "zai-org/GLM-5.2",
			api: "openai-completions",
			baseUrl: "https://api.siliconflow.cn/v1",
			reasoning: false,
			input: ["text"],
		});
		expect(configured.model.compat).toMatchObject({
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		});
	});
});
