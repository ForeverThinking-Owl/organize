// ============================================================================
// ActorDecisionEngine — Actor 决策引擎
// v0.2.0: llm_judge 结果来源改为 LLMGateway，默认 mock，可切换 real
// ============================================================================

import {
  ActorDecision,
  ToolCallDecision,
  FinalOutputDecision,
} from "../core/types/actor-decision";
import { SkillStep, ToolCallStep, LLMJudgeStep, ReturnStep } from "../core/types/skill";
import { ActorContext } from "../core/types/actor";
import { ToolCallRequest } from "../core/types/tool";
import { SkillState } from "./skill-runtime";
import { traceLogger } from "../trace/trace-logger";
import { llmGateway } from "../llm/llm-gateway";
import { buildActorJudgePrompt } from "../llm/prompts/actor-judge.prompt";

export const DEFAULT_TRIAGE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["need_after_sales", "need_technical", "need_finance", "should_create_ticket", "reason"],
  properties: {
    analysis: { type: "object" },
    need_after_sales: { type: "boolean" },
    need_technical: { type: "boolean" },
    need_finance: { type: "boolean" },
    should_create_ticket: { type: "boolean" },
    reason: { type: "string" },
    risk_level: { type: "string", enum: ["low", "medium", "high"] },
  },
};

function safeFallbackJudgeResult(reason: string): Record<string, unknown> {
  return {
    analysis: { fallback: true, reason },
    need_after_sales: true,
    need_technical: true,
    need_finance: true,
    should_create_ticket: true,
    reason: `LLM 判断失败，采用保守策略：${reason}`,
    risk_level: "medium",
  };
}

export class ActorDecisionEngine {
  async generateJudgeResult(input: {
    step: LLMJudgeStep;
    context: ActorContext;
    state: SkillState;
    actorRunId: string;
  }): Promise<Record<string, unknown>> {
    const { step, context, state, actorRunId } = input;
    const schema = step.outputSchema ?? DEFAULT_TRIAGE_OUTPUT_SCHEMA;
    const taskName = `${state.skillId}.${step.stepKey}`;
    const { systemPrompt, userPrompt } = buildActorJudgePrompt({ context, state, step, schema });

    traceLogger.record(actorRunId, "llm_call_start", {
      taskName,
      stepKey: step.stepKey,
      schemaName: "llm_judge_output",
    });

    try {
      const output = await llmGateway.generateStructured<Record<string, unknown>>({
        taskName,
        systemPrompt,
        userPrompt,
        schema,
        temperature: 0,
        metadata: { context, state, stepKey: step.stepKey },
      });

      traceLogger.record(actorRunId, "llm_call_end", {
        taskName,
        stepKey: step.stepKey,
        model: output.model,
        latencyMs: output.latencyMs,
        usage: output.usage,
        valid: true,
      });

      return output.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      traceLogger.record(actorRunId, "llm_validation_failed", {
        taskName,
        stepKey: step.stepKey,
        error: message,
      });
      return safeFallbackJudgeResult(message);
    }
  }

  /**
   * @param prebuiltRequest 当 step.type === "tool_call" 时，已解析好 arguments 的请求
   */
  decide(
    step: SkillStep,
    context: ActorContext,
    state: SkillState,
    actorRunId: string,
    prebuiltRequest?: ToolCallRequest
  ): ActorDecision {
    switch (step.type) {
      case "tool_call":
        return this.decideToolCall(step as ToolCallStep, context, actorRunId, prebuiltRequest);

      case "llm_judge":
        return this.decideFromJudgeResult(step as LLMJudgeStep, context, state, actorRunId);

      case "return":
        return this.decideReturn(step as ReturnStep, state, actorRunId);

      default:
        return {
          decisionType: "final_output",
          reasoningSummary: `步骤类型 ${step.type} 无需生成决策`,
          result: {},
        };
    }
  }

  private decideToolCall(
    step: ToolCallStep,
    context: ActorContext,
    actorRunId: string,
    prebuiltRequest?: ToolCallRequest
  ): ToolCallDecision {
    const tool = context.availableTools.find((t) => t.name === step.toolName);

    traceLogger.record(actorRunId, "decision_generated", {
      stepKey: step.stepKey,
      decisionType: "tool_call",
      toolName: step.toolName,
    });

    return {
      decisionType: "tool_call",
      reasoningSummary: `Skill 步骤 ${step.stepKey} → ${step.toolName}`,
      toolCall: {
        toolName: step.toolName,
        arguments: prebuiltRequest?.arguments ?? {},
        purpose: tool?.description ?? `执行 ${step.toolName}`,
      },
      permissionCheck: {
        allowed: context.permissions.allowedTools.includes(step.toolName),
      },
      approvalCheck: { required: false },
    };
  }

  private decideFromJudgeResult(
    step: LLMJudgeStep,
    context: ActorContext,
    state: SkillState,
    actorRunId: string
  ): ActorDecision {
    const judgeResult = (state.steps[step.stepKey] ?? {}) as Record<string, unknown>;

    traceLogger.record(actorRunId, "decision_generated", {
      stepKey: step.stepKey,
      decisionType: "post_judge",
      judgeResult,
    });

    if (judgeResult.should_create_ticket === true) {
      const ticketDecision: ToolCallDecision = {
        decisionType: "tool_call",
        reasoningSummary: `分流判断: ${judgeResult.reason ?? ""}`,
        toolCall: {
          toolName: "create_ticket",
          arguments: {
            title: "客户问题处理工单",
            type: ["technical", "after_sales"].join(","),
            priority: "urgent",
            description: `客户反馈：${context.input.text}`,
            order_id: context.runtimeContext.order_id ?? "ORDER_10086",
            customer_id: context.runtimeContext.customer_id ?? "C001",
          },
          purpose: "为客户问题创建处理工单",
          outputKey: "create_ticket_result",
        },
        permissionCheck: {
          allowed: context.permissions.allowedTools.includes("create_ticket"),
        },
        approvalCheck: {
          required: judgeResult.need_finance === true,
          reason: judgeResult.need_finance ? "涉及退款，可能需要审批" : undefined,
        },
      };

      traceLogger.record(actorRunId, "decision_generated", {
        stepKey: step.stepKey,
        decisionType: "create_ticket_followup",
      });

      return ticketDecision;
    }

    return {
      decisionType: "final_output",
      reasoningSummary: `分流判断完成: ${judgeResult.reason ?? ""}`,
      result: { triage: judgeResult },
    };
  }

  private decideReturn(
    _step: ReturnStep,
    state: SkillState,
    actorRunId: string
  ): FinalOutputDecision {
    const result: Record<string, unknown> = {
      summary: "客户问题分流完成",
      triage: state.steps["judge"] ?? {},
      order_info: state.steps["query_order"] ?? {},
      ticket_history: state.steps["query_history"] ?? {},
      create_ticket_result: state.outputs["create_ticket_result"] ?? null,
      observations_count: state.observations.length,
    };

    traceLogger.record(actorRunId, "decision_generated", {
      stepKey: _step.stepKey,
      decisionType: "final_output",
    });

    return {
      decisionType: "final_output",
      reasoningSummary: "Skill 所有步骤执行完成，输出汇总结果",
      result,
    };
  }
}

export const actorDecisionEngine = new ActorDecisionEngine();
