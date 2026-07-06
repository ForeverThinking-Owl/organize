// ============================================================================
// LLMGateway
// v0.2.0: 可替换模型适配层，默认 mock，real 模式走 OpenAI-compatible
// ============================================================================

import { LLMProvider, LLMStructuredInput, LLMStructuredOutput } from "./llm.types";
import { MockLLMProvider } from "./providers/mock-llm.provider";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.provider";
import { validateStructuredOutput } from "./structured-output-validator";

function getMode(): "mock" | "real" {
  return process.env.LLM_MODE === "real" ? "real" : "mock";
}

export class LLMGateway {
  private mockProvider: LLMProvider = new MockLLMProvider();
  private realProvider: LLMProvider = new OpenAICompatibleProvider();

  async generateStructured<T>(input: LLMStructuredInput<T>): Promise<LLMStructuredOutput<T>> {
    const provider = getMode() === "real" ? this.realProvider : this.mockProvider;
    const output = await provider.generateStructured<T>(input);
    const validation = validateStructuredOutput(output.data, input.schema);

    if (!validation.valid) {
      // real 模式下先失败；后续可加 retry + repair
      if (getMode() === "real") {
        throw new Error(`LLM structured output invalid: ${validation.errors.join("; ")}`);
      }
    }

    return output;
  }
}

export const llmGateway = new LLMGateway();
