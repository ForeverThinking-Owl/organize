// ============================================================================
// Approval 类型定义
// Approval 是 ToolCall 生命周期中的治理闸门
// ============================================================================

/**
 * 审批阶段
 */
export type ApprovalStage = "before_call" | "after_call" | "before_writeback";

/**
 * 审批请求
 */
export interface ApprovalRequest {
  approvalRequestId: string;
  toolCallId: string;
  /** 真实工具名，供审批页、Trace 和 ActorRunOutput 直接展示 */
  toolName: string;
  stage: ApprovalStage;
  riskLevel: "low" | "medium" | "high" | "critical";
  reason: string;
  proposedArguments?: Record<string, unknown>;
  rawResult?: Record<string, unknown>;
  suggestedApproverRole?: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "escalated";
  createdAt: string;
}

/**
 * 审批决策
 */
export interface ApprovalDecision {
  approvalRequestId: string;
  decision:
    | "approve"
    | "reject"
    | "approve_with_modified_arguments"
    | "approve_with_modified_result_view"
    | "approve_with_comment"
    | "request_more_info"
    | "escalate"
    | "cancel";
  modifiedArguments?: Record<string, unknown>;
  modifiedResultView?: Record<string, unknown>;
  comment?: string;
  decidedBy?: string;
  decidedAt: string;
}
