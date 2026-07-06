// ============================================================================
// OpenAICompatibleProvider
// v0.2.0: 使用 OpenAI-compatible Chat Completions 接口返回结构化 JSON
// ============================================================================

import { LLMProvider, LLMStructuredInput, LLMStructuredOutput } from "../llm.types";

function readEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export class OpenAICompatibleProvider implements LLMProvider {
  name = "openai-compatible";

  async generateStructured<T>(input: LLMStructuredInput<T>): Promise<LLMStructuredOutput<T>> {
    const baseUrl = readEnv("LLM_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
    const apiKey = readEnv("LLM_API_KEY");
    const model = readEnv("LLM_MODEL", "gpt-4.1-mini");
    const timeoutMs = Number(readEnv("LLM_TIMEOUT_MS", "30000"));

    if (!apiKey) {
      throw new Error("LLM_API_KEY is required when LLM_MODE=real");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: input.temperature ?? 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM request failed: ${response.status} ${text}`);
      }

      const json = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        model?: string;
      };

      const rawText = json.choices?.[0]?.message?.content ?? "{}";
      const data = JSON.parse(rawText) as T;

      return {
        data,
        rawText,
        model: json.model ?? model,
        usage: {
          inputTokens: json.usage?.prompt_tokens,
          outputTokens: json.usage?.completion_tokens,
          totalTokens: json.usage?.total_tokens,
        },
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
