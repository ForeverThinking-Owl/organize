import type { ApprovalPolicyBinding, ApprovalStage } from "../core/types/approval";
import type { ApprovalCondition, ToolDefinition } from "../core/types/tool";

export interface CanonicalToolApprovalMetadata {
  stage: ApprovalStage;
  riskLevel: ToolDefinition["riskLevel"];
  reason: string;
  proposedArguments: Record<string, unknown>;
  suggestedApproverRole: string;
  policy: ApprovalPolicyBinding;
}

function conditionMatches(
  condition: ApprovalCondition,
  arguments_: Record<string, unknown>
): boolean {
  const actual = arguments_[condition.field];
  switch (condition.operator) {
    case "==": return actual === condition.value;
    case "!=": return actual !== condition.value;
    case ">": return (actual as number) > (condition.value as number);
    case ">=": return (actual as number) >= (condition.value as number);
    case "<": return (actual as number) < (condition.value as number);
    case "<=": return (actual as number) <= (condition.value as number);
  }
}

/** Pure counterpart of ApprovalGate.check for recovery preflight. */
export function buildCanonicalToolApprovalMetadata(
  tool: ToolDefinition,
  arguments_: Record<string, unknown>
): CanonicalToolApprovalMetadata | null {
  const conditions = tool.approvalPolicy?.beforeCall?.requiredWhen ?? [];
  const matched = conditions.find((condition) => conditionMatches(condition, arguments_));
  if (!matched) return null;

  return {
    stage: "before_call",
    riskLevel: tool.riskLevel,
    reason: `Tool ${tool.toolName} 参数 ${matched.field} ${matched.operator} ${matched.value} 触发审批`,
    proposedArguments: arguments_,
    suggestedApproverRole: "customer_service_manager",
    policy: {
      requiredWhen: structuredClone(conditions),
      allowModifyArguments: tool.approvalPolicy?.beforeCall?.allowModifyArguments === true,
      allowReject: tool.approvalPolicy?.beforeCall?.allowReject === true,
      allowComment: tool.approvalPolicy?.beforeCall?.allowComment === true,
    },
  };
}
