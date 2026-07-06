// ============================================================================
// ActorDecision — 系统最核心的协议
// Actor 每一步输出的结构化决策
// 第一版支持四种：tool_call | request_approval | handoff | final_output
// ============================================================================

/**
 * Actor 决策联合类型
 */
export type ActorDecision =
  | ToolCallDecision
  | RequestApprovalDecision
  | HandoffDecision
  | FinalOutputDecision;

/**
 * 决策基础字段
 */
export interface DecisionBase {
  /** 决策摘要，用于 Trace 和调试 */
  reasoningSummary: string;
}

// ---------------------------------------------------------------------------
// tool_call
// ---------------------------------------------------------------------------

export interface ToolCallDecision extends DecisionBase {
  decisionType: "tool_call";
  toolCall: {
    toolName: string;
    arguments: Record<string, unknown>;
    purpose: string;
  };
  permissionCheck?: {
    allowed: boolean;
    reason?: string;
  };
  approvalCheck?: {
    required: boolean;
    reason?: string;
  };
}

// ---------------------------------------------------------------------------
// request_approval
// ---------------------------------------------------------------------------

export interface RequestApprovalDecision extends DecisionBase {
  decisionType: "request_approval";
  approvalRequest: {
    stage: "before_call" | "after_call" | "before_writeback";
    toolName: string;
    proposedArguments?: Record<string, unknown>;
    rawResult?: Record<string, unknown>;
    reason: string;
    suggestedApproverRole?: string;
  };
}

// ---------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------

export interface HandoffDecision extends DecisionBase {
  decisionType: "handoff";
  targetRole: string;
  targetSkill: string;
  reason: string;
  handoffContext: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// final_output
// ---------------------------------------------------------------------------

export interface FinalOutputDecision extends DecisionBase {
  decisionType: "final_output";
  result: Record<string, unknown>;
}
