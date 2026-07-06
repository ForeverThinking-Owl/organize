// ============================================================================
// MockLLMProvider
// v0.2.0: 默认 Demo / 测试使用的稳定结构化判断
// ============================================================================

import { ActorContext } from "../../core/types/actor";
import { SkillState } from "../../runtime/skill-runtime";
import { LLMProvider, LLMStructuredInput, LLMStructuredOutput } from "../llm.types";

function mockJudge(context: ActorContext, state: SkillState): Record<string, unknown> {
  const inputText = (context.input.text ?? "").toLowerCase();
  const orderInfo = (state.steps["query_order"] as Record<string, unknown>) ?? {};
  const ticketHistory = (state.steps["query_history"] as Record<string, unknown>) ?? {};

  const hasRefund = /退款/.test(inputText);
  const hasConnection = /连不上|连接|无法连接|蓝牙|网络/.test(inputText);
  const hasScanner = /扫码枪|扫描枪|scanner/.test(inputText);

  return {
    analysis: { hasRefund, hasConnection, hasScanner, orderInfo, ticketHistory },
    need_after_sales: hasRefund,
    need_technical: hasConnection,
    need_finance: hasRefund,
    should_create_ticket: hasConnection || hasRefund,
    reason: [
      hasRefund ? "客户要求退款，需要售后和财务处理" : "",
      hasConnection ? "设备连接问题，需要技术排查" : "",
    ].filter(Boolean).join("；"),
    risk_level: hasRefund ? "medium" : "low",
  };
}

export class MockLLMProvider implements LLMProvider {
  name = "mock";

  async generateStructured<T>(input: LLMStructuredInput<T>): Promise<LLMStructuredOutput<T>> {
    const context = input.metadata?.context as ActorContext | undefined;
    const state = input.metadata?.state as SkillState | undefined;
    const startedAt = Date.now();

    const data = context && state
      ? mockJudge(context, state)
      : {};

    return {
      data: data as T,
      rawText: JSON.stringify(data),
      model: "mock-llm",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      latencyMs: Date.now() - startedAt,
    };
  }
}
