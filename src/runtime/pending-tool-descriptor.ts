import type { ActorContext } from "../core/types/actor";
import type { SkillStep } from "../core/types/skill";
import { resolveTemplateValue, type SkillState } from "./skill-runtime";

export interface CanonicalPendingToolDescriptor {
  toolName: string;
  arguments: Record<string, unknown>;
  originatingStepKey: string;
  originatingOutputKey?: string;
  decisionOutputKey?: string;
}

/**
 * Rebuild the Tool execution a suspended step must be waiting to approve.
 *
 * This helper is deliberately pure: recovery preflight must not append Trace
 * events, advance state, call a Tool, or consult mutable approval state.
 */
export function buildCanonicalPendingToolDescriptor(
  step: SkillStep,
  state: SkillState,
  context: ActorContext
): CanonicalPendingToolDescriptor | null {
  if (step.type === "tool_call") {
    const args: Record<string, unknown> = {};
    for (const [key, template] of Object.entries(step.inputMapping)) {
      args[key] = resolveTemplateValue(template, state);
    }
    return {
      toolName: step.toolName,
      arguments: args,
      originatingStepKey: step.stepKey,
      originatingOutputKey: step.outputKey,
    };
  }

  if (step.type !== "llm_judge") return null;
  const judgeResult = state.steps[step.stepKey];
  if (
    judgeResult === null ||
    typeof judgeResult !== "object" ||
    Array.isArray(judgeResult) ||
    (judgeResult as Record<string, unknown>).should_create_ticket !== true
  ) {
    return null;
  }

  return {
    toolName: "create_ticket",
    arguments: {
      title: "客户问题处理工单",
      type: ["technical", "after_sales"].join(","),
      priority: "urgent",
      description: `客户反馈：${context.input.text}`,
      order_id: context.runtimeContext.order_id ?? "ORDER_10086",
      customer_id: context.runtimeContext.customer_id ?? "C001",
    },
    originatingStepKey: step.stepKey,
    decisionOutputKey: "create_ticket_result",
  };
}
