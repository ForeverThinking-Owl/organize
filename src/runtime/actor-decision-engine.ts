// ============================================================================
// ActorDecisionEngine — Actor 决策引擎
// 根据当前步骤和上下文生成 ActorDecision
// v0.1.2: mockLLMJudge 只在 ActorRuntime 预执行阶段调用一次；
//         decideLLMJudge 从 state 读取已存入的 judge 结果做后续决策
// ============================================================================

import {
  ActorDecision,
  ToolCallDecision,
  FinalOutputDecision,
} from "../core/types/actor-decision";
import { SkillStep, ToolCallStep, LLMJudgeStep, ReturnStep } from "../core/types/skill";
import { ActorContext } from "../core/types/actor";
import { SkillState } from "./skill-runtime";
import { traceLogger } from "../trace/trace-logger";

/**
 * Mock LLM 判断逻辑（纯函数，可独立测试）
 * 基于输入文本关键词做规则判断，模拟 LLM 的分流决策
 */
export function mockLLMJudge(
  _instruction: string,
  context: ActorContext,
  state: SkillState
): Record<string, unknown> {
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
  };
}

export class ActorDecisionEngine {
  /**
   * 根据当前步骤生成决策
   * 注意：llm_judge 的结果应已由 ActorRuntime 预执行存入 state
   */
  decide(
    step: SkillStep,
    context: ActorContext,
    state: SkillState,
    actorRunId: string
  ): ActorDecision {
    switch (step.type) {
      case "tool_call":
        return this.decideToolCall(step as ToolCallStep, context, actorRunId);

      case "llm_judge":
        return this.decideFromJudgeResult(
          step as LLMJudgeStep,
          context,
          state,
          actorRunId
        );

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

  /**
   * tool_call step → 生成 tool_call 决策
   * 参数解析由 buildToolCallRequest 在 executor 中完成
   */
  private decideToolCall(
    step: ToolCallStep,
    context: ActorContext,
    actorRunId: string
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
        arguments: {}, // 由 executor 通过 buildToolCallRequest 解析
        purpose: tool?.description ?? `执行 ${step.toolName}`,
      },
      permissionCheck: {
        allowed: context.permissions.allowedTools.includes(step.toolName),
      },
      approvalCheck: { required: false },
    };
  }

  /**
   * llm_judge step → 从 state 读取已计算的 judge 结果，判断后续动作
   */
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

    // 判断是否需要创建工单
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

    // 不需要创建工单，返回判断结果
    return {
      decisionType: "final_output",
      reasoningSummary: `分流判断完成: ${judgeResult.reason ?? ""}`,
      result: { triage: judgeResult },
    };
  }

  /**
   * return step → 汇总输出
   */
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
