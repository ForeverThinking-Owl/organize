// ============================================================================
// ActorRuntime — Actor Kernel 主执行器
// v0.3.0: ActorContextBuilder 接入 Hybrid Memory；MemoryCandidate 自动进入 MemoryPolicy
// ============================================================================

import { ActorConfig } from "../core/types/actor";
import { Skill, SkillConfig, ToolCallStep, LLMJudgeStep, ReturnStep, TransformStep } from "../core/types/skill";
import { ToolCallRequest } from "../core/types/tool";
import { ApprovalDecision } from "../core/types/approval";
import { actorContextBuilder } from "./actor-context-builder";
import { skillRuntime, SkillState, buildToolCallRequest } from "./skill-runtime";
import { actorDecisionEngine } from "./actor-decision-engine";
import { actorDecisionExecutor } from "./actor-decision-executor";
import { memoryService } from "../memory/memory-service";
import { traceLogger } from "../trace/trace-logger";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface ActorRunInput {
  actorConfig: ActorConfig;
  skillConfig: SkillConfig;
  input: { text?: string; payload?: Record<string, unknown> };
  runtimeContext?: Record<string, unknown>;
}

export interface ActorRunOutput {
  actorRunId: string;
  status: "completed" | "waiting_approval" | "error";
  result: Record<string, unknown> | null;
  pendingApproval?: {
    approvalRequestId: string;
    toolName: string;
    reason: string;
  };
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    stepKey?: string;
  }>;
  approvals: Array<{
    approvalRequestId: string;
    toolName: string;
    toolCallId?: string;
    stage?: string;
    reason?: string;
    decision?: string;
    decidedBy?: string;
  }>;
  memoryCandidates: Array<{
    candidateId: string; scope: string; type: string; content: string; confidence?: number;
  }>;
  trace: {
    actorRunId: string; eventCount: number;
    events: Array<{ type: string; stepKey?: string }>;
  };
}

let runCounter = 0;

// ---------------------------------------------------------------------------
// SkillConfig → Skill
// ---------------------------------------------------------------------------

function parseSkill(config: SkillConfig, actorId: string): Skill {
  return {
    skillId: config.skill_id, name: config.name, description: config.description,
    ownerActorId: config.owner_actor_id ?? actorId,
    steps: config.steps.map((s) => {
      const base = { stepKey: s.step_key, description: s.description as string | undefined };
      switch (s.type) {
        case "tool_call":
          return { ...base, type: "tool_call", toolName: s.tool_name as string,
            inputMapping: s.input_mapping as Record<string, string>, outputKey: s.output_key as string } as ToolCallStep;
        case "llm_judge":
          return { ...base, type: "llm_judge", instruction: s.instruction as string,
            outputKey: s.output_key as string,
            outputSchema: s.output_schema as Record<string, unknown> | undefined } as LLMJudgeStep;
        case "transform":
          return { ...base, type: "transform",
            mapping: s.mapping as Record<string, string>, outputKey: s.output_key as string } as TransformStep;
        case "return":
          return { ...base, type: "return",
            outputMapping: s.output_mapping as Record<string, string> | undefined } as ReturnStep;
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
  private runs: Map<string, {
    skill: Skill; state: SkillState;
    context: ReturnType<typeof actorContextBuilder.build>;
  }> = new Map();

  async run(input: ActorRunInput): Promise<ActorRunOutput> {
    const actorRunId = `arun_${++runCounter}`;
    const actorId = input.actorConfig.actor_id;

    if (input.actorConfig.memory?.length) {
      memoryService.initActorMemory(
        { actorId, organizationId: input.actorConfig.organization_id ?? "org_default",
          unitId: input.actorConfig.unit_id, type: input.actorConfig.type,
          name: input.actorConfig.name, role: input.actorConfig.role,
          responsibility: input.actorConfig.responsibility,
          autonomyLevel: input.actorConfig.autonomy_level as "L2_read_and_draft", status: "active" },
        input.actorConfig.memory
      );
    }

    const skill = parseSkill(input.skillConfig, actorId);
    traceLogger.startRun(actorRunId, actorId, skill.skillId);

    try {
      const context = actorContextBuilder.build(input.actorConfig, input.input, input.runtimeContext ?? {}, actorRunId);
      traceLogger.record(actorRunId, "context_built", {
        actorId, skillId: skill.skillId,
        memoryCount: context.memory.actorPrivate.length,
        hybridMemoryCount:
          context.memory.structured.length + context.memory.semantic.length + context.memory.episodic.length +
          context.memory.procedural.length + context.memory.governance.length,
        availableToolCount: context.availableTools.length,
      });

      const state = skillRuntime.initState(skill, {
        context: { order_id: input.runtimeContext?.order_id ?? "ORDER_10086",
          customer_id: input.runtimeContext?.customer_id ?? "C001", ...input.runtimeContext },
        ...input.input.payload, ...input.runtimeContext,
      });

      actorDecisionExecutor.registerRun({ actorRunId, actorId, context, state, pendingExec: null });
      this.runs.set(actorRunId, { skill, state, context });

      return await this.executeLoop(actorRunId, actorId, context, state, skill);
    } catch (error) {
      traceLogger.record(actorRunId, "error", { message: error instanceof Error ? error.message : String(error) });
      traceLogger.endRun(actorRunId, "error");
      return this.buildOutput(actorRunId, "error", null);
    }
  }

  async continue(
    actorRunId: string,
    event: { type: "approval_decision"; decision: ApprovalDecision }
  ): Promise<ActorRunOutput> {
    const saved = this.runs.get(actorRunId);
    if (!saved) {
      return { actorRunId, status: "error", result: null, toolCalls: [], approvals: [], memoryCandidates: [],
        trace: { actorRunId, eventCount: 0, events: [] } };
    }

    const { context, state, skill } = saved;
    const actorId = context.actor.actorId;

    if (event.type === "approval_decision") {
      const execResult = await actorDecisionExecutor.continueAfterApproval(actorRunId, event.decision);
      if (execResult.outcome === "error") {
        state.status = "error";
        traceLogger.endRun(actorRunId, "error");
        return this.buildOutput(actorRunId, "error", null);
      }
      if (execResult.outcome === "completed") {
        state.status = "running";
        skillRuntime.advanceStep(state);
        return await this.executeLoop(actorRunId, actorId, context, state, skill);
      }
    }

    return await this.executeLoop(actorRunId, actorId, context, state, skill);
  }

  // -----------------------------------------------------------------------
  // 主循环
  // -----------------------------------------------------------------------

  private async executeLoop(
    actorRunId: string, actorId: string,
    context: ReturnType<typeof actorContextBuilder.build>,
    state: SkillState, skill: Skill
  ): Promise<ActorRunOutput> {
    let finalResult: Record<string, unknown> | null = null;

    while (state.status === "running") {
      const step = skillRuntime.getCurrentStep(skill, state);
      if (!step) { state.status = "completed"; break; }

      if (step.type === "llm_judge") {
        const judgeStep = step as LLMJudgeStep;
        const judgeResult = await actorDecisionEngine.generateJudgeResult({
          step: judgeStep,
          context,
          state,
          actorRunId,
        });
        skillRuntime.executeLLMJudge(judgeStep, state, actorRunId, judgeResult);
      }

      let prebuiltRequest: ToolCallRequest | undefined;
      if (step.type === "tool_call") {
        const toolStep = step as ToolCallStep;
        prebuiltRequest = buildToolCallRequest(toolStep, state, actorId, actorRunId);
        skillRuntime.startToolCallStep(toolStep, actorRunId);
      }

      const decision = actorDecisionEngine.decide(step, context, state, actorRunId, prebuiltRequest);

      const execResult = await actorDecisionExecutor.execute(
        decision, context, state, actorRunId, actorId,
        step.type === "tool_call"
          ? { stepKey: step.stepKey, outputKey: (step as ToolCallStep).outputKey, prebuiltRequest }
          : { stepKey: step.stepKey }
      );

      switch (execResult.outcome) {
        case "completed": {
          if (step.type === "tool_call" && execResult.observation) {
            skillRuntime.completeToolCallStep(step as ToolCallStep, state, execResult.observation, actorRunId);
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
        case "handoff": break;
        case "error": {
          state.status = "error";
          traceLogger.record(actorRunId, "error", { message: execResult.reason });
          break;
        }
      }

      if (state.status !== "running") break;
      skillRuntime.advanceStep(state);
    }

    const memoryCandidates = memoryService.generateCandidates(actorRunId, actorId, {
      organizationId: context.actor.organizationId,
      unitId: context.actor.unitId,
      sceneId: context.runtimeContext.scene_id as string | undefined,
      inputText: context.input.text ?? "", finalResult,
      observations: state.observations,
      actorMemory: context.memory.actorPrivate,
      approvalJudgment: context.approvalJudgment,
    });

    for (const c of memoryCandidates) {
      traceLogger.record(actorRunId, "memory_candidate_generated", {
        candidateId: c.candidateId, scope: c.scope, type: c.type, content: c.content,
      } as Record<string, unknown>);
      const accepted = memoryService.getAllMemories().find((m) => m.sourceRunId === actorRunId && m.content === c.content);
      if (accepted) {
        traceLogger.record(actorRunId, "memory_accepted", {
          memoryId: accepted.memoryId,
          candidateId: c.candidateId,
          scope: accepted.scope,
          type: accepted.type,
        });
      }
    }

    const endStatus = state.status === "waiting_approval" ? "waiting_approval"
      : state.status === "completed" ? "completed" : "error";
    traceLogger.endRun(actorRunId, endStatus);

    actorDecisionExecutor.removeRun(actorRunId);
    this.runs.delete(actorRunId);

    return this.buildOutput(actorRunId, endStatus as "completed" | "waiting_approval" | "error", finalResult, undefined, memoryCandidates);
  }

  private buildOutput(
    actorRunId: string,
    status: "completed" | "waiting_approval" | "error",
    result: Record<string, unknown> | null,
    pendingApproval?: import("../core/types/approval").ApprovalRequest,
    memoryCandidates?: Array<{ candidateId: string; scope: string; type: string; content: string; confidence?: number }>
  ): ActorRunOutput {
    const trace = traceLogger.getTrace(actorRunId)!;

    const toolCalls = trace.events
      .filter((e) => e.eventType === "tool_call_start")
      .map((e) => ({
        toolCallId: String(e.data.toolCallId ?? ""),
        toolName: String(e.data.toolName ?? ""),
        arguments: (e.data.arguments ?? {}) as Record<string, unknown>,
        stepKey: e.stepKey,
      }));

    const approvals = trace.events
      .filter((e) => e.eventType === "approval_requested")
      .map((e) => {
        const decision = trace.events.find((d) =>
          d.eventType === "approval_decided" &&
          d.data.approvalRequestId === e.data.approvalRequestId
        );
        return {
          approvalRequestId: String(e.data.approvalRequestId ?? ""),
          toolName: String(e.data.toolName ?? ""),
          toolCallId: e.data.toolCallId ? String(e.data.toolCallId) : undefined,
          stage: e.data.stage ? String(e.data.stage) : undefined,
          reason: e.data.reason ? String(e.data.reason) : undefined,
          decision: decision?.data.decision ? String(decision.data.decision) : undefined,
          decidedBy: decision?.data.decidedBy ? String(decision.data.decidedBy) : undefined,
        };
      });

    return {
      actorRunId, status, result,
      pendingApproval: pendingApproval ? {
        approvalRequestId: pendingApproval.approvalRequestId,
        toolName: pendingApproval.toolName,
        reason: pendingApproval.reason,
      } : undefined,
      toolCalls,
      approvals,
      memoryCandidates: memoryCandidates ?? [],
      trace: {
        actorRunId, eventCount: trace.events.length,
        events: trace.events.map((e) => ({ type: e.eventType, stepKey: e.stepKey })),
      },
    };
  }
}

export const actorRuntime = new ActorRuntime();
