// ============================================================================
// ActorRuntime — Actor Kernel 主执行器
// v0.1.2: 决策执行拆到 ActorDecisionExecutor；
//         支持 waiting_approval / continue；
//         统一 ToolCall 管线：buildRequest → policy → approval → execute
// ============================================================================

import { ActorConfig } from "../core/types/actor";
import { Skill, SkillConfig, ToolCallStep, LLMJudgeStep, ReturnStep, TransformStep } from "../core/types/skill";
import { ToolCallRequest } from "../core/types/tool";
import { ApprovalDecision } from "../core/types/approval";
import { actorContextBuilder } from "./actor-context-builder";
import { skillRuntime, SkillState, buildToolCallRequest } from "./skill-runtime";
import { actorDecisionEngine, mockLLMJudge } from "./actor-decision-engine";
import { actorDecisionExecutor, ActiveRunState } from "./actor-decision-executor";
import { approvalGate } from "../approvals/approval-gate";
import { toolGateway } from "../tools/tool-gateway";
import { memoryService } from "../memory/memory-service";
import { traceLogger } from "../trace/trace-logger";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface ActorRunInput {
  actorConfig: ActorConfig;
  skillConfig: SkillConfig;
  input: {
    text?: string;
    payload?: Record<string, unknown>;
  };
  runtimeContext?: Record<string, unknown>;
}

export interface ActorRunOutput {
  actorRunId: string;
  status: "completed" | "waiting_approval" | "error";
  result: Record<string, unknown> | null;
  /** 如果 waiting_approval，包含审批请求信息 */
  pendingApproval?: {
    approvalRequestId: string;
    toolName: string;
    reason: string;
  };
  memoryCandidates: Array<{
    candidateId: string;
    scope: string;
    type: string;
    content: string;
    confidence?: number;
  }>;
  trace: {
    actorRunId: string;
    eventCount: number;
    events: Array<{ type: string; stepKey?: string }>;
  };
}

let runCounter = 0;

// ---------------------------------------------------------------------------
// SkillConfig → Skill
// ---------------------------------------------------------------------------

function parseSkill(config: SkillConfig, actorId: string): Skill {
  return {
    skillId: config.skill_id,
    name: config.name,
    description: config.description,
    ownerActorId: config.owner_actor_id ?? actorId,
    steps: config.steps.map((s) => {
      const base = { stepKey: s.step_key, description: s.description as string | undefined };
      switch (s.type) {
        case "tool_call":
          return { ...base, type: "tool_call", toolName: s.tool_name as string, inputMapping: s.input_mapping as Record<string, string>, outputKey: s.output_key as string } as ToolCallStep;
        case "llm_judge":
          return { ...base, type: "llm_judge", instruction: s.instruction as string, outputKey: s.output_key as string } as LLMJudgeStep;
        case "transform":
          return { ...base, type: "transform", mapping: s.mapping as Record<string, string>, outputKey: s.output_key as string } as TransformStep;
        case "return":
          return { ...base, type: "return", outputMapping: s.output_mapping as Record<string, string> | undefined } as ReturnStep;
        default:
          return { ...base, type: "return" } as ReturnStep;
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// ActorRuntime
// ---------------------------------------------------------------------------

export class ActorRuntime {
  /** 活跃运行（用于 continue） */
  private runs: Map<string, {
    skill: Skill;
    state: SkillState;
    context: ReturnType<typeof actorContextBuilder.build>;
  }> = new Map();

  /**
   * 执行 Actor 完整运行（首次）
   */
  async run(input: ActorRunInput): Promise<ActorRunOutput> {
    const actorRunId = `arun_${++runCounter}`;
    const actorId = input.actorConfig.actor_id;

    // 1. 初始化记忆
    if (input.actorConfig.memory?.length) {
      memoryService.initActorMemory(
        {
          actorId, organizationId: input.actorConfig.organization_id ?? "org_default",
          unitId: input.actorConfig.unit_id, type: input.actorConfig.type,
          name: input.actorConfig.name, role: input.actorConfig.role,
          responsibility: input.actorConfig.responsibility,
          autonomyLevel: input.actorConfig.autonomy_level as "L2_read_and_draft",
          status: "active",
        },
        input.actorConfig.memory
      );
    }

    // 2. Trace
    const skill = parseSkill(input.skillConfig, actorId);
    traceLogger.startRun(actorRunId, actorId, skill.skillId);

    try {
      // 3. Context
      const context = actorContextBuilder.build(input.actorConfig, input.input, input.runtimeContext ?? {});
      traceLogger.record(actorRunId, "context_built", {
        actorId, skillId: skill.skillId,
        memoryCount: context.memory.actorPrivate.length,
        availableToolCount: context.availableTools.length,
      });

      // 4. SkillState
      const state = skillRuntime.initState(skill, {
        context: {
          order_id: input.runtimeContext?.order_id ?? "ORDER_10086",
          customer_id: input.runtimeContext?.customer_id ?? "C001",
          ...input.runtimeContext,
        },
        ...input.input.payload,
        ...input.runtimeContext,
      });

      // 5. 注册到 executor
      actorDecisionExecutor.registerRun({
        actorRunId, actorId, context, state, pendingExec: null,
      });
      this.runs.set(actorRunId, { skill, state, context });

      // 6. 执行主循环
      return await this.executeLoop(actorRunId, actorId, context, state, skill);

    } catch (error) {
      traceLogger.record(actorRunId, "error", { message: error instanceof Error ? error.message : String(error) });
      traceLogger.endRun(actorRunId, "error");
      return this.buildOutput(actorRunId, "error", null);
    }
  }

  /**
   * continue: 外部递交事件后继续执行
   */
  async continue(
    actorRunId: string,
    event: { type: "approval_decision"; decision: ApprovalDecision }
  ): Promise<ActorRunOutput> {
    const saved = this.runs.get(actorRunId);
    if (!saved) {
      return { actorRunId, status: "error", result: null, memoryCandidates: [], trace: { actorRunId, eventCount: 0, events: [] } };
    }

    const { context, state, skill } = saved;
    const actorId = context.actor.actorId;

    // 处理审批决策
    if (event.type === "approval_decision") {
      const execResult = await actorDecisionExecutor.continueAfterApproval(actorRunId, event.decision);

      if (execResult.outcome === "error") {
        state.status = "error";
        traceLogger.endRun(actorRunId, "error");
        return this.buildOutput(actorRunId, "error", null);
      }

      if (execResult.outcome === "completed") {
        // ToolCall 执行完成，重置状态继续主循环
        state.status = "running";
        skillRuntime.advanceStep(state);
        return await this.executeLoop(actorRunId, actorId, context, state, skill);
      }
    }

    return await this.executeLoop(actorRunId, actorId, context, state, skill);
  }

  // -----------------------------------------------------------------------
  // 主执行循环
  // -----------------------------------------------------------------------

  private async executeLoop(
    actorRunId: string,
    actorId: string,
    context: ReturnType<typeof actorContextBuilder.build>,
    state: SkillState,
    skill: Skill
  ): Promise<ActorRunOutput> {
    let finalResult: Record<string, unknown> | null = null;

    while (state.status === "running") {
      const step = skillRuntime.getCurrentStep(skill, state);
      if (!step) { state.status = "completed"; break; }

      // ---- 预执行：llm_judge 先计算结果存入 state ----
      if (step.type === "llm_judge") {
        const judgeStep = step as LLMJudgeStep;
        const judgeResult = mockLLMJudge(judgeStep.instruction, context, state);
        skillRuntime.executeLLMJudge(judgeStep, state, actorRunId, judgeResult);
      }

      // ---- 预执行：tool_call 先构建 request（解析 inputMapping） ----
      let prebuiltRequest: ToolCallRequest | undefined;
      if (step.type === "tool_call") {
        const toolStep = step as ToolCallStep;
        prebuiltRequest = buildToolCallRequest(toolStep, state, actorId, actorRunId);
        skillRuntime.startToolCallStep(toolStep, actorRunId);
      }

      // ---- 生成决策 ----
      const decision = actorDecisionEngine.decide(step, context, state, actorRunId);

      // ---- 执行决策（executor 内部完成 policy / approval / gateway 管线） ----
      const execResult = await actorDecisionExecutor.execute(
        decision, context, state, actorRunId, actorId,
        step.type === "tool_call"
          ? { stepKey: step.stepKey, outputKey: (step as ToolCallStep).outputKey }
          : { stepKey: step.stepKey }
      );

      switch (execResult.outcome) {
        case "completed": {
          // tool_call 步骤完成，记录 step 结果
          if (step.type === "tool_call") {
            const toolStep = step as ToolCallStep;
            skillRuntime.completeToolCallStep(toolStep, state, execResult.observation!, actorRunId);
          }
          break;
        }

        case "waiting_approval": {
          state.status = "waiting_approval";
          traceLogger.endRun(actorRunId, "waiting_approval");
          return this.buildOutput(actorRunId, "waiting_approval", null, execResult.approvalRequest);
        }

        case "final_output": {
          finalResult = execResult.result;
          state.status = "completed";
          break;
        }

        case "handoff": {
          // log only for v0.1
          break;
        }

        case "error": {
          state.status = "error";
          traceLogger.record(actorRunId, "error", { message: execResult.reason });
          break;
        }
      }

      if (state.status !== "running") break;
      skillRuntime.advanceStep(state);
    }

    // ---- 生成 MemoryCandidate ----
    const memoryCandidates = memoryService.generateCandidates(actorRunId, actorId, {
      inputText: context.input.text ?? "",
      finalResult,
      observations: state.observations,
      actorMemory: context.memory.actorPrivate,
      approvalJudgment: context.approvalJudgment,
    });

    for (const c of memoryCandidates) {
      traceLogger.record(actorRunId, "memory_candidate_generated", {
        candidateId: c.candidateId, scope: c.scope, type: c.type, content: c.content,
      } as Record<string, unknown>);
    }

    // ---- 结束 ----
    const endStatus = state.status === "waiting_approval" ? "waiting_approval"
      : state.status === "completed" ? "completed" : "error";
    traceLogger.endRun(actorRunId, endStatus);

    // 清理
    actorDecisionExecutor.removeRun(actorRunId);
    this.runs.delete(actorRunId);

    return this.buildOutput(actorRunId, endStatus as "completed" | "waiting_approval" | "error", finalResult, undefined, memoryCandidates);
  }

  // -----------------------------------------------------------------------
  // 构建输出
  // -----------------------------------------------------------------------

  private buildOutput(
    actorRunId: string,
    status: "completed" | "waiting_approval" | "error",
    result: Record<string, unknown> | null,
    pendingApproval?: import("../core/types/approval").ApprovalRequest,
    memoryCandidates?: Array<{ candidateId: string; scope: string; type: string; content: string; confidence?: number }>
  ): ActorRunOutput {
    const trace = traceLogger.getTrace(actorRunId)!;
    return {
      actorRunId,
      status,
      result,
      pendingApproval: pendingApproval ? {
        approvalRequestId: pendingApproval.approvalRequestId,
        toolName: pendingApproval.toolCallId,
        reason: pendingApproval.reason,
      } : undefined,
      memoryCandidates: memoryCandidates ?? [],
      trace: {
        actorRunId,
        eventCount: trace.events.length,
        events: trace.events.map((e) => ({ type: e.eventType, stepKey: e.stepKey })),
      },
    };
  }
}

export const actorRuntime = new ActorRuntime();
