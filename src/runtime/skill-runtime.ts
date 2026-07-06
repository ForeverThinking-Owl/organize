// ============================================================================
// SkillRuntime — Skill 执行器
// 按步骤执行 Skill，管理步骤间的输入输出映射
// v0.1.2: buildToolCallRequest 从 executeToolCall 中拆出，
//         统一 ToolCall 管线在 ActorDecisionExecutor 中组装
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
  status: "running" | "completed" | "waiting_approval" | "error";
  observations: ToolObservation[];
}

/** 模板解析：将 "{{context.order_id}}" 替换为实际值 */
export function resolveTemplate(template: string, state: SkillState): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const parts = path.trim().split(".");
    let value: unknown = state.context;
    for (const part of parts) {
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[part];
      } else {
        return `{{${path}}}`;
      }
    }
    return String(value ?? `{{${path}}}`);
  });
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
    resolvedArgs[key] = resolveTemplate(template, state);
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
   * 记录 tool_call 步骤完成，将结果写入 state
   */
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
      result[key] = resolveTemplate(template, state);
    }
    state.steps[step.stepKey] = result;
    state.outputs[step.outputKey] = result;

    traceLogger.record(actorRunId, "skill_step_end", {
      stepKey: step.stepKey,
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
