// ============================================================================
// LLM 类型定义
// v0.2.0: 真实 LLM 接入的适配层类型
// ============================================================================

export interface LLMStructuredInput<T> {
  taskName: string;
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

export interface LLMStructuredOutput<T> {
  data: T;
  rawText?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  latencyMs?: number;
}

export interface LLMProvider {
  name: string;
  generateStructured<T>(input: LLMStructuredInput<T>): Promise<LLMStructuredOutput<T>>;
}

export type LLMMode = "mock" | "real";
