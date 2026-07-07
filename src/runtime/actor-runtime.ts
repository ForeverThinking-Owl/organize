// ============================================================================
// ActorRuntime — Actor Kernel 主执行器
// v0.3.8: human_input 支持 waiting / continue 运行语义
// ============================================================================

import { ActorConfig } from "../core/types/actor";
import {
  Skill,
  SkillConfig,
  SkillStep,
  SkillStepConfig,
  ToolCallStep,
  LLMJudgeStep,
  ReturnStep,
  TransformStep,
  HumanInputStep,
  WaitApprovalStep,
  EndStep,
} from "../core/types/skill";
import { ToolCallRequest } from "../core/types/tool";
import { ApprovalDecision } from "../core/types/approval";
import type { MemoryStore } from "../memory/memory-store";
import { actorContextBuilder } from "./actor-context-builder";
import { skillRuntime, SkillState, buildToolCallRequest } from "./skill-runtime";
import { actorDecisionEngine } from "./actor-decision-engine";
import { actorDecisionExecutor } from "./actor-decision-executor";
import { memoryService } from "../memory/memory-service";
import { traceLogger } from "../trace/trace-logger";
import { loadRuntimeMemoryStore, saveRuntimeMemoryStore } from "./runtime-memory-store";
import {
  applyHumanInputResponse,
  buildHumanInputRequest,
  type HumanInputRequest,
  type HumanInputResponse,
} from "./human-input-runtime";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface ActorRuntimeOptions {
  /** Optional store-backed memory lifecycle for this run. */
  memoryStore?: MemoryStore;
}

export interface ActorRunInput {
  actorConfig: ActorConfig;
  skillConfig: SkillConfig;
  input: { text?: string; payload?: Record<string, unknown> };
  runtimeContext?: Record<string, unknown>;
  runtimeOptions?: ActorRuntimeOptions;
}

export type ActorRunStatus = "completed" | "waiting_approval" | "waiting_human_input" | "error";

export interface ActorRunOutput {
  actorRunId: string;
  status: ActorRunStatus;
  result: Record<string, unknown> | null;
  pendingApproval?: {
    approvalRequestId: string;
    toolName: string;
    reason: string;
  };
  pendingHumanInput?: HumanInputRequest;
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

export type ActorContinueEvent =
  | { type: "approval_decision"; decision: ApprovalDecision }
  | { type: "human_input_response"; response: HumanInputResponse };

let runCounter = 0;

// ---------------------------------------------------------------------------
// SkillConfig → Skill
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(config: SkillStepConfig, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Skill step ${config.step_key} (${config.type}) requires string field: ${key}`);
  }
  return value;
}

function optionalString(config: SkillStepConfig, key: string): string | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Skill step ${config.step_key} (${config.type}) field ${key} must be a string`);
  }
  return value;
}

function requiredMapping(config: SkillStepConfig, key: string): Record<string, string> {
  const value = config[key];
  if (!isRecord(value)) {
    throw new Error(`Skill step ${config.step_key} (${config.type}) requires mapping field: ${key}`);
  }
  for (const [mappingKey, mappingValue] of Object.entries(value)) {
    if (typeof mappingValue !== "string") {
      throw new Error(`Skill step ${config.step_key} (${config.type}) mapping ${key}.${mappingKey} must be a string`);
    }
  }
  return value as Record<string, string>;
}

function optionalMapping(config: SkillStepConfig, key: string): Record<string, string> | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Skill step ${config.step_key} (${config.type}) field ${key} must be a mapping`);
  }
  for (const [mappingKey, mappingValue] of Object.entries(value)) {
    if (typeof mappingValue !== "string") {
      throw new Error(`Skill step ${config.step_key} (${config.type}) mapping ${key}.${mappingKey} must be a string`);
    }
  }
  return value as Record<string, string>;
}

function parseSkillStep(config: SkillStepConfig): SkillStep {
  const base = {
    stepKey: config.step_key,
    description: optionalString(config, "description"),
  };

  switch (config.type) {
    case "tool_call":
      return {
        ...base,
        type: "tool_call",
        toolName: requiredString(config, "tool_name"),
        inputMapping: requiredMapping(config, "input_mapping"),
        outputKey: requiredString(config, "output_key"),
      } as ToolCallStep;

    case "llm_judge":
      return {
        ...base,
        type: "llm_judge",
        instruction: requiredString(config, "instruction"),
        outputKey: requiredString(config, "output_key"),
        outputSchema: isRecord(config.output_schema) ? config.output_schema : undefined,
      } as LLMJudgeStep;

    case "transform":
      return {
        ...base,
        type: "transform",
        mapping: requiredMapping(config, "mapping"),
        outputKey: requiredString(config, "output_key"),
      } as TransformStep;

    case "return":
      return {
        ...base,
        type: "return",
        outputMapping: optionalMapping(config, "output_mapping"),
      } as ReturnStep;

    case "human_input":
      return {
        ...base,
        type: "human_input",
        prompt: requiredString(config, "prompt"),
        outputKey: requiredString(config, "output_key"),
      } as HumanInputStep;

    case "wait_approval":
      return {
        ...base,
        type: "wait_approval",
        approvalRequestId: requiredString(config, "approval_request_id"),
      } as WaitApprovalStep;

    case "end":
      return { ...base, type: "end" } as EndStep;

    default:
      throw new Error(`Unsupported skill step type: ${String(config.type)} at step ${config.step_key}`);
  }
}

function parseSkill(config: SkillConfig, actorId: string): Skill {
  return {
    skillId: config.skill_id,
    name: config.name,
    description: config.description,
    ownerActorId: config.owner_actor_id ?? actorId,
    steps: config.steps.map(parseSkillStep),
  };
}

// ---------------------------------------------------------------------------
// ActorRuntime
// ---------------------------------------------------------------------------

export class ActorRuntime {
  private runs: Map<string, {
    skill: Skill; state: SkillState;
    context: ReturnType<typeof actorContextBuilder.build>;
    memoryStore?: MemoryStore;
    pendingHumanInput?: HumanInputRequest;
  }> = new Map();

  async run(input: ActorRunInput): Promise<ActorRunOutput> {
    const actorRunId = `arun_${++runCounter}`;
    const actorId = input.actorConfig.actor_id;
    const memoryStore = input.runtimeOptions?.memoryStore;
    traceLogger.startRun(actorRunId, actorId, input.skillConfig.skill_id);

    try {
      const memoryLoaded = await loadRuntimeMemoryStore(actorRunId, memoryStore);
      if (!memoryLoaded) {
        throw new Error("MemoryStore load failed");
      }

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
      this.runs.set(actorRunId, { skill, state, context, memoryStore });

      return await this.executeLoop(actorRunId, actorId, context, state, skill, memoryStore);
    } catch (error) {
      traceLogger.record(actorRunId, "error", { message: error instanceof Error ? error.message : String(error) });
      traceLogger.endRun(actorRunId, "error");
      actorDecisionExecutor.removeRun(actorRunId);
      this.runs.delete(actorRunId);
      return this.buildOutput(actorRunId, "error", null);
    }
  }

  async continue(
    actorRunId: string,
    event: ActorContinueEvent
  ): Promise<ActorRunOutput> {
    const saved = this.runs.get(actorRunId);
    if (!saved) {
      return { actorRunId, status: "error", result: null, toolCalls: [], approvals: [], memoryCandidates: [],
        trace: { actorRunId, eventCount: 0, events: [] } };
    }

    const { context, state, skill, memoryStore } = saved;
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
        return await this.executeLoop(actorRunId, actorId, context, state, skill, memoryStore);
      }
    }

    if (event.type === "human_input_response") {
      const pending = saved.pendingHumanInput;
      if (!pending || pending.humanInputRequestId !== event.response.humanInputRequestId) {
        const message = pending
          ? `Human input response id mismatch: ${event.response.humanInputRequestId}`
          : `No pending human input for ${actorRunId}`;
        traceLogger.record(actorRunId, "error", { message });
        state.status = "error";
        traceLogger.endRun(actorRunId, "error");
        actorDecisionExecutor.removeRun(actorRunId);
        this.runs.delete(actorRunId);
        return this.buildOutput(actorRunId, "error", null);
      }

      applyHumanInputResponse(pending, event.response, state, actorRunId);
      saved.pendingHumanInput = undefined;
      state.status = "running";
      skillRuntime.advanceStep(state);
      return await this.executeLoop(actorRunId, actorId, context, state, skill, memoryStore);
    }

    return await this.executeLoop(actorRunId, actorId, context, state, skill, memoryStore);
  }

  // -----------------------------------------------------------------------
  // 主循环
  // -----------------------------------------------------------------------

  private async executeLoop(
    actorRunId: string, actorId: string,
    context: ReturnType<typeof actorContextBuilder.build>,
    state: SkillState, skill: Skill,
    memoryStore?: MemoryStore
  ): Promise<ActorRunOutput> {
    let finalResult: Record<string, unknown> | null = null;

    while (state.status === "running") {
      const step = skillRuntime.getCurrentStep(skill, state);
      if (!step) { state.status = "completed"; break; }

      if (step.type === "transform") {
        skillRuntime.executeTransform(step as TransformStep, state, actorRunId);
        skillRuntime.advanceStep(state);
        continue;
      }

      if (step.type === "human_input") {
        const request = buildHumanInputRequest(step as HumanInputStep, actorRunId);
        const saved = this.runs.get(actorRunId);
        if (saved) saved.pendingHumanInput = request;
        state.status = "waiting_human_input";
        traceLogger.endRun(actorRunId, "waiting_human_input");
        return this.buildOutput(actorRunId, "waiting_human_input", null, undefined, undefined, request);
      }

      if (step.type === "wait_approval" || step.type === "end") {
        const message = `Unsupported runtime skill step type: ${step.type}`;
        traceLogger.record(actorRunId, "error", { message, stepKey: step.stepKey });
        state.status = "error";
        break;
      }

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

    const memoryGeneration = memoryService.generateCandidatesWithSummary(actorRunId, actorId, {
      organizationId: context.actor.organizationId,
      unitId: context.actor.unitId,
      sceneId: context.runtimeContext.scene_id as string | undefined,
      inputText: context.input.text ?? "", finalResult,
      observations: state.observations,
      actorMemory: context.memory.actorPrivate,
      approvalJudgment: context.approvalJudgment,
    });
    const memoryCandidates = memoryGeneration.candidates;

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

    traceLogger.record(actorRunId, "memory_write_summary", memoryGeneration.summary as unknown as Record<string, unknown>);

    const memorySaved = await saveRuntimeMemoryStore(actorRunId, memoryStore);
    if (!memorySaved) {
      state.status = "error";
    }

    const endStatus: ActorRunStatus = state.status === "waiting_approval" ? "waiting_approval"
      : state.status === "waiting_human_input" ? "waiting_human_input"
      : state.status === "completed" ? "completed" : "error";
    traceLogger.endRun(actorRunId, endStatus);

    actorDecisionExecutor.removeRun(actorRunId);
    this.runs.delete(actorRunId);

    return this.buildOutput(actorRunId, endStatus, finalResult, undefined, memoryCandidates);
  }

  private buildOutput(
    actorRunId: string,
    status: ActorRunStatus,
    result: Record<string, unknown> | null,
    pendingApproval?: import("../core/types/approval").ApprovalRequest,
    memoryCandidates?: Array<{ candidateId: string; scope: string; type: string; content: string; confidence?: number }>,
    pendingHumanInput?: HumanInputRequest
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
      pendingHumanInput,
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
