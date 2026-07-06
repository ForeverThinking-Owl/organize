// ============================================================================
// Actor 核心类型定义
// Actor 是 AI-Agent 的基本单位：
//   有身份、有记忆、有权限、有审批判断、有技能、有工具范围、有运行边界
// ============================================================================

/**
 * Actor 主体信息
 */
export interface ActorProfile {
  actorId: string;
  organizationId: string;
  unitId?: string;
  type: "ai" | "human" | "hybrid" | "system";
  name: string;
  role: string;
  responsibility: string;
  autonomyLevel:
    | "L0_observe_only"
    | "L1_suggest_only"
    | "L2_read_and_draft"
    | "L3_low_risk_execute"
    | "L4_governed_execute";
  status: "active" | "inactive";
}

/**
 * Actor 运行时上下文
 * 每次运行前由 ActorContextBuilder 构建
 */
export interface ActorContext {
  actor: ActorProfile;
  input: {
    text?: string;
    payload?: Record<string, unknown>;
  };
  runtimeContext: Record<string, unknown>;
  memory: {
    /** 组织公共记忆 */
    organizationPublic: string[];
    /** 所属单元记忆 */
    unitMemory: string[];
    /** Actor 私有记忆 */
    actorPrivate: string[];
    /** 当前场景共享上下文 */
    sceneShared: Record<string, unknown>;
  };
  permissions: {
    allowedTools: string[];
    deniedTools: string[];
    allowedSkills: string[];
    deniedFields?: string[];
  };
  approvalJudgment: {
    /** 哪些情况下必须请求审批 */
    mustRequestApprovalWhen: string[];
    /** 审批权限配置（具备审批能力时） */
    canApprove?: ApprovalAuthorityItem[];
  };
  /** 当前 Actor 可见的工具列表（已过滤） */
  availableTools: ToolForActor[];
}

/**
 * Actor 可用的工具视图（已过滤权限后的精简信息）
 */
export interface ToolForActor {
  name: string;
  description: string;
  direction: "read" | "write";
  riskLevel: "low" | "medium" | "high" | "critical";
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/**
 * Actor 配置（用于初始化 Actor）
 */
export interface ActorConfig {
  actor_id: string;
  organization_id?: string;
  unit_id?: string;
  name: string;
  type: "ai" | "human" | "hybrid" | "system";
  role: string;
  responsibility: string;
  autonomy_level: string;
  memory: string[];
  permissions: {
    allowed_tools: string[];
    denied_tools: string[];
    allowed_skills?: string[];
    denied_fields?: string[];
  };
  approval_judgment: {
    must_request_approval_when: string[];
    can_approve?: ApprovalAuthorityItem[];
  };
}

/**
 * 审批权限项
 */
export interface ApprovalAuthorityItem {
  tool_name: string;
  conditions?: ApprovalCondition[];
  must_escalate_when?: ApprovalCondition[];
}

/**
 * 审批条件
 */
export interface ApprovalCondition {
  field: string;
  operator: "<=" | ">=" | "<" | ">" | "==" | "!=";
  value: string | number | boolean;
}
