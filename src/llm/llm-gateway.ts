// ============================================================================
// LLMGateway
// v0.2.1: 加载 .env，增加 retry，失败交由 ActorDecisionEngine fallback
// ============================================================================

import { LLMProvider, LLMStructuredInput, LLMStructuredOutput } from "./llm.types";
import { MockLLMProvider } from "./providers/mock-llm.provider";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.provider";
import { validateStructuredOutput } from "./structured-output-validator";
import { loadEnvFile } from "./env";

loadEnvFile();

function getMode(): "mock" | "real" {
  return process.env.LLM_MODE === "real" ? "real" : "mock";
}

function getMaxRetries(): number {
  const value = Number(process.env.LLM_MAX_RETRIES ?? "1");
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
}

export class LLMGateway {
  private mockProvider: LLMProvider = new MockLLMProvider();
  private realProvider: LLMProvider = new OpenAICompatibleProvider();

  async generateStructured<T>(input: LLMStructuredInput<T>): Promise<LLMStructuredOutput<T>> {
    const provider = getMode() === "real" ? this.realProvider : this.mockProvider;
    const maxRetries = getMode() === "real" ? getMaxRetries() : 0;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const output = await provider.generateStructured<T>({
          ...input,
          metadata: {
            ...(input.metadata ?? {}),
            llmMode: getMode(),
            provider: provider.name,
            attempt,
          },
        });

        const validation = validateStructuredOutput(output.data, input.schema);
        if (!validation.valid) {
          throw new Error(`LLM structured output invalid: ${validation.errors.join("; ")}`);
        }

        return output;
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries) break;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

export const llmGateway = new LLMGateway();
