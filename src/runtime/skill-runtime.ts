// ============================================================================
// SkillRuntime — Skill 执行器
// 按步骤执行 Skill，管理步骤间的输入输出映射
// v0.3.8: SkillState 支持 waiting_human_input
// ============================================================================

import {
  Skill,
  SkillStep,
  ToolCallStep,
  LLMJudgeStep,
  TransformStep,
} from "../core/types/skill";
import { ToolCallRequest, ToolObservation } from "../core/types/tool";
import { traceLogger } from "../trace/trace-logger";

/** Skill 运行时状态 */
export interface SkillState {
  skillId: string;
  currentStepIndex: number;
  /** 步骤结果: stepKey → output */
  steps: Record<string, unknown>;
  /** 输出结果: outputKey → data（给后续步骤引用） */
  outputs: Record<string, unknown>;
  /** 可引用的上下文变量 */
  context: Record<string, unknown>;
  status: "running" | "completed" | "waiting_approval" | "waiting_human_input" | "error";
  observations: ToolObservation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function templateScope(state: SkillState): Record<string, unknown> {
  const embeddedContext = isRecord(state.context.context) ? state.context.context : {};
  return {
    context: { ...state.context, ...embeddedContext },
    steps: state.steps,
    outputs: state.outputs,
  };
}

function readPath(path: string, state: SkillState): unknown {
  const parts = path.trim().split(".").filter(Boolean);
  if (parts.length === 0) return undefined;

  let value: unknown = templateScope(state)[parts[0]];
  for (const part of parts.slice(1)) {
    if (!isRecord(value)) return undefined;
    value = value[part];
  }
  return value;
}

function stringifyTemplateValue(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * 解析模板并保留完整占位符的原始值。
 *
 * - "{{context.order_id}}" → 原始值
 * - "订单 {{context.order_id}}" → 字符串插值
 * - 支持根路径：context / steps / outputs
 */
export function resolveTemplateValue(template: string, state: SkillState): unknown {
  const fullMatch = template.match(/^\s*\{\{([^}]+)\}\}\s*$/);
  if (fullMatch) {
    const value = readPath(fullMatch[1], state);
    return value ?? `{{${fullMatch[1].trim()}}}`;
  }

  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const fallback = `{{${path}}}`;
    const value = readPath(path, state);
    return stringifyTemplateValue(value, fallback);
  });
}

/** 模板解析：将 "{{context.order_id}}" 替换为字符串值 */
export function resolveTemplate(template: string, state: SkillState): string {
  return stringifyTemplateValue(resolveTemplateValue(template, state), template);
}

/**
 * 构建 ToolCallRequest（解析 inputMapping → 完整 arguments）
 * 这是统一 ToolCall 管线的入口：所有 ToolCall 都从这里生成请求
 */
export function buildToolCallRequest(
  step: ToolCallStep,
  state: SkillState,
  actorId: string,
  actorRunId: string
): ToolCallRequest {
  const resolvedArgs: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(step.inputMapping)) {
    resolvedArgs[key] = resolveTemplateValue(template, state);
  }

  return {
    toolCallId: `tc_${step.stepKey}_${Date.now()}`,
    toolName: step.toolName,
    arguments: resolvedArgs,
    actorId,
    actorRunId,
    stepKey: step.stepKey,
  };
}

export class SkillRuntime {
  /**
   * 初始化 Skill 执行状态
   */
  initState(skill: Skill, context: Record<string, unknown>): SkillState {
    return {
      skillId: skill.skillId,
      currentStepIndex: 0,
      steps: {},
      outputs: {},
      context,
      status: "running",
      observations: [],
    };
  }

  /**
   * 获取当前步骤
   */
  getCurrentStep(skill: Skill, state: SkillState): SkillStep | null {
    if (state.currentStepIndex >= skill.steps.length) return null;
    return skill.steps[state.currentStepIndex];
  }

  /**
   * 记录 tool_call 步骤开始
   */
  startToolCallStep(step: ToolCallStep, actorRunId: string): void {
    traceLogger.record(actorRunId, "skill_step_start", {
      stepKey: step.stepKey,
      stepType: "tool_call",
      toolName: step.toolName,
    });
  }

  /**
   * 记录 tool_call 步骤完成（仅 trace，state 写入由 ActorDecisionExecutor 负责）
   */
  completeToolCallStep(
    step: ToolCallStep,
    _state: SkillState,
    observation: ToolObservation,
    actorRunId: string
  ): void {
    traceLogger.record(actorRunId, "skill_step_end", {
      stepKey: step.stepKey,
      status: observation.status,
    });
  }

  /**
   * 执行 llm_judge 步骤（判断结果由外部提供）
   */
  executeLLMJudge(
    step: LLMJudgeStep,
    state: SkillState,
    actorRunId: string,
    judgeResult: Record<string, unknown>
  ): void {
    traceLogger.record(actorRunId, "skill_step_start", {
      stepKey: step.stepKey,
      stepType: "llm_judge",
    });

    state.steps[step.stepKey] = judgeResult;
    state.outputs[step.outputKey] = judgeResult;

    traceLogger.record(actorRunId, "skill_step_end", {
      stepKey: step.stepKey,
      outputKey: step.outputKey,
    });
  }

  /**
   * 执行 transform 步骤
   */
  executeTransform(
    step: TransformStep,
    state: SkillState,
    actorRunId: string
  ): void {
    traceLogger.record(actorRunId, "skill_step_start", {
      stepKey: step.stepKey,
      stepType: "transform",
    });

    const result: Record<string, unknown> = {};
    for (const [key, template] of Object.entries(step.mapping)) {
      result[key] = resolveTemplateValue(template, state);
    }
    state.steps[step.stepKey] = result;
    state.outputs[step.outputKey] = result;

    traceLogger.record(actorRunId, "skill_step_end", {
      stepKey: step.stepKey,
      outputKey: step.outputKey,
    });
  }

  /**
   * 前进到下一步
   */
  advanceStep(state: SkillState): void {
    state.currentStepIndex++;
  }
}

export const skillRuntime = new SkillRuntime();
