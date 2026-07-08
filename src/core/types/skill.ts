// ============================================================================
// Skill 类型定义
// Skill 是 Actor 的实践程式（SOP），编排 Actor 自己的 Tool
// ============================================================================

/**
 * Skill 定义
 */
export interface Skill {
  skillId: string;
  name: string;
  description?: string;
  ownerActorId: string;
  steps: SkillStep[];
}

/**
 * Skill 步骤
 */
export type SkillStep =
  | ToolCallStep
  | LLMJudgeStep
  | TransformStep
  | ReturnStep
  | HumanInputStep
  | WaitApprovalStep
  | WaitExternalEventStep
  | EndStep;

export interface SkillStepBase {
  stepKey: string;
  description?: string;
}

export interface ToolCallStep extends SkillStepBase {
  type: "tool_call";
  toolName: string;
  inputMapping: Record<string, string>;
  outputKey: string;
}

export interface LLMJudgeStep extends SkillStepBase {
  type: "llm_judge";
  instruction: string;
  outputKey: string;
  /** v0.2.0: 结构化判断输出 schema */
  outputSchema?: Record<string, unknown>;
}

export interface TransformStep extends SkillStepBase {
  type: "transform";
  mapping: Record<string, string>;
  outputKey: string;
}

export interface ReturnStep extends SkillStepBase {
  type: "return";
  outputMapping?: Record<string, string>;
}

export interface HumanInputStep extends SkillStepBase {
  type: "human_input";
  prompt: string;
  outputKey: string;
}

export interface WaitApprovalStep extends SkillStepBase {
  type: "wait_approval";
  approvalRequestId?: string;
  reason: string;
  outputKey: string;
}

export interface WaitExternalEventStep extends SkillStepBase {
  type: "wait_external_event";
  eventName: string;
  correlationKey?: string;
  reason?: string;
  outputKey: string;
  eventSchema?: Record<string, unknown>;
}

export interface EndStep extends SkillStepBase {
  type: "end";
}

/**
 * Skill 配置（JSON 格式，用于初始化）
 */
export interface SkillConfig {
  skill_id: string;
  name: string;
  description?: string;
  owner_actor_id?: string;
  steps: SkillStepConfig[];
}

export type SkillStepConfig = Record<string, unknown> & {
  step_key: string;
  type: string;
};
