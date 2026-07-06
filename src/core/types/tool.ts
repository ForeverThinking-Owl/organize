// ============================================================================
// Tool 类型定义
// Tool 是实践入口 = Name + Direction + Input/Output Schema + Risk Level + Approval Policy
// ============================================================================

/**
 * Tool 定义
 */
export interface ToolDefinition {
  toolName: string;
  displayName?: string;
  description: string;
  direction: "read" | "write";
  riskLevel: "low" | "medium" | "high" | "critical";
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  approvalPolicy?: ToolApprovalPolicy;
}

/**
 * Tool 审批策略
 */
export interface ToolApprovalPolicy {
  beforeCall?: ApprovalStagePolicy;
  afterCall?: ApprovalStagePolicy;
  beforeWriteback?: ApprovalStagePolicy;
}

export interface ApprovalStagePolicy {
  requiredWhen?: ApprovalCondition[];
  allowModifyArguments?: boolean;
  allowReject?: boolean;
  allowComment?: boolean;
}

export interface ApprovalCondition {
  field: string;
  operator: "<=" | ">=" | "<" | ">" | "==" | "!=";
  value: string | number | boolean;
}

/**
 * Tool 调用请求
 */
export interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  actorId: string;
  actorRunId: string;
  stepKey: string;
}

/**
 * Tool 调用结果（Observation）
 */
export interface ToolObservation {
  toolCallId: string;
  toolName: string;
  status: "success" | "error" | "permission_denied" | "pending_approval";
  data?: Record<string, unknown>;
  error?: string;
  executedAt: string;
}

/**
 * Tool 配置（JSON 格式）
 */
export interface ToolConfig {
  tool_name: string;
  display_name?: string;
  description?: string;
  direction: "read" | "write";
  risk_level: "low" | "medium" | "high" | "critical";
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  approval_policy?: {
    before_call?: {
      required_when?: Array<{
        field: string;
        operator: string;
        value: string | number | boolean;
      }>;
      allow_modify_arguments?: boolean;
      allow_reject?: boolean;
      allow_comment?: boolean;
    };
  };
}
