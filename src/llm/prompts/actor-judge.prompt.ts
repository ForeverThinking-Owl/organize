// ============================================================================
// Actor Judge Prompt
// v0.2.0: 为 llm_judge step 构建结构化判断 Prompt
// ============================================================================

import { ActorContext } from "../../core/types/actor";
import { LLMJudgeStep } from "../../core/types/skill";
import { SkillState } from "../../runtime/skill-runtime";

export interface ActorJudgePromptInput {
  context: ActorContext;
  state: SkillState;
  step: LLMJudgeStep;
  schema: Record<string, unknown>;
}

export function buildActorJudgePrompt(input: ActorJudgePromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const { context, state, step, schema } = input;

  const systemPrompt = [
    "你是 Actor 的实践判断模块。",
    "你只能基于给定 ActorContext、SkillStep、已有 Observation 和可见记忆进行判断。",
    "你必须输出严格 JSON，不要输出 Markdown、解释文字或代码块。",
    "你不能执行工具。",
    "你不能越过 Actor 权限。",
    "你不能承诺超出 Actor 职责范围的结果。",
  ].join("\n");

  const payload = {
    actor: {
      role: context.actor.role,
      responsibility: context.actor.responsibility,
      autonomy_level: context.actor.autonomyLevel,
    },
    input: context.input,
    runtime_context: context.runtimeContext,
    memory: context.memory,
    permissions: context.permissions,
    available_tools: context.availableTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      direction: tool.direction,
      risk_level: tool.riskLevel,
    })),
    current_state: {
      steps: state.steps,
      outputs: state.outputs,
      observations: state.observations,
    },
    skill_step: {
      step_key: step.stepKey,
      instruction: step.instruction,
      output_key: step.outputKey,
    },
    required_output_schema: schema,
  };

  const userPrompt = JSON.stringify(payload, null, 2);

  return { systemPrompt, userPrompt };
}
