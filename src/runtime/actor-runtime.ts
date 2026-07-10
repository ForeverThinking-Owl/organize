// ============================================================================
// ActorRuntime — Actor Kernel 主执行器
// v0.4.5: wait_external_event validates payload / correlation before resume
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
  WaitExternalEventStep,
  EndStep,
} from "../core/types/skill";
import { ToolCallRequest } from "../core/types/tool";
import type { ApprovalDecision, ApprovalRequest } from "../core/types/approval";
import type { MemoryStore } from "../memory/memory-store";
import { actorContextBuilder } from "./actor-context-builder";
import { skillRuntime, SkillState, buildToolCallRequest } from "./skill-runtime";
import { actorDecisionEngine } from "./actor-decision-engine";
import { actorDecisionExecutor, type PendingExecution } from "./actor-decision-executor";
import { approvalGate } from "../approvals/approval-gate";
import { memoryService } from "../memory/memory-service";
import { traceLogger } from "../trace/trace-logger";
import { loadRuntimeMemoryStore, saveRuntimeMemoryStore } from "./runtime-memory-store";
import {
  applyHumanInputResponse,
  buildHumanInputRequest,
  type HumanInputRequest,
  type HumanInputResponse,
} from "./human-input-runtime";
import {
  applySkillApprovalDecision,
  approvalAllowsResume,
  buildSkillApprovalRequest,
  type SkillApprovalRequest,
} from "./wait-approval-runtime";
import {
  applyExternalEventReceived,
  buildExternalEventRequest,
  type ExternalEventReceived,
  type ExternalEventRequest,
} from "./external-event-runtime";
import { validateExternalEventReceived } from "./external-event-validation";
import {
  PENDING_RUN_SNAPSHOT_SCHEMA_VERSION,
  type PendingRunKind,
  type PendingRunSnapshot,
  type PendingToolApprovalSnapshot,
  type PendingToolExecutionSnapshot,
} from "./pending-run-snapshot";

export interface ActorRuntimeOptions {
  memoryStore?: MemoryStore;
}

export interface ActorRunInput {
  actorConfig: ActorConfig;
  skillConfig: SkillConfig;
  input: { text?: string; payload?: Record<string, unknown> };
  runtimeContext?: Record<string, unknown>;
  runtimeOptions?: ActorRuntimeOptions;
}

export type ActorRunStatus = "completed" | "waiting_approval" | "waiting_human_input" | "waiting_external_event" | "error";

export interface PendingApprovalOutput {
  approvalRequestId: string;
  reason: string;
  approvalKind: "tool_call" | "skill_step";
  toolName?: string;
  stepKey?: string;
  outputKey?: string;
}

export interface ActorRunOutput {
  actorRunId: string;
  status: ActorRunStatus;
  result: Record<string, unknown> | null;
  pendingApproval?: PendingApprovalOutput;
  pendingHumanInput?: HumanInputRequest;
  pendingExternalEvent?: ExternalEventRequest;
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
  | { type: "human_input_response"; response: HumanInputResponse }
  | { type: "external_event_received"; event: ExternalEventReceived };

let runCounter = 0;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

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
        approvalRequestId: optionalString(config, "approval_request_id"),
        reason: requiredString(config, "reason"),
        outputKey: requiredString(config, "output_key"),
      } as WaitApprovalStep;
    case "wait_external_event":
      return {
        ...base,
        type: "wait_external_event",
        eventName: requiredString(config, "event_name"),
        correlationKey: optionalString(config, "correlation_key"),
        reason: optionalString(config, "reason"),
        outputKey: requiredString(config, "output_key"),
        eventSchema: isRecord(config.event_schema) ? config.event_schema : undefined,
      } as WaitExternalEventStep;
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

export class ActorRuntime {
  private runs: Map<string, {
    skill: Skill; state: SkillState;
    context: ReturnType<typeof actorContextBuilder.build>;
    memoryStore?: MemoryStore;
    pendingHumanInput?: HumanInputRequest;
    pendingSkillApproval?: SkillApprovalRequest;
    pendingExternalEvent?: ExternalEventRequest;
  }> = new Map();

  dumpPendingRun(actorRunId: string): PendingRunSnapshot | null {
    const saved = this.runs.get(actorRunId);
    if (!saved) return null;
    if (saved.state.status !== "waiting_human_input" && saved.state.status !== "waiting_approval" && saved.state.status !== "waiting_external_event") return null;

    let pendingKind: PendingRunKind | null = null;
    let pendingToolApproval: PendingToolApprovalSnapshot | undefined;

    if (saved.pendingHumanInput) {
      pendingKind = "human_input";
    } else if (saved.pendingSkillApproval) {
      pendingKind = "skill_approval";
    } else if (saved.pendingExternalEvent) {
      pendingKind = "external_event";
    } else {
      const activeRun = actorDecisionExecutor.getRun(actorRunId);
      const pendingExec = activeRun?.pendingExec;
      const approvalRequest = approvalGate.getPending(actorRunId);
      if (pendingExec && approvalRequest) {
        pendingKind = "tool_approval";
        const pendingToolExec: PendingToolExecutionSnapshot = {
          actorRunId: pendingExec.actorRunId,
          actorId: pendingExec.actorId,
          pendingToolCall: pendingExec.pendingToolCall,
          pendingToolName: pendingExec.pendingToolName,
          originatingStepKey: pendingExec.originatingStepKey,
          originatingOutputKey: pendingExec.originatingOutputKey,
          decisionOutputKey: pendingExec.decisionOutputKey,
        };
        pendingToolApproval = { approvalRequest, pendingExec: pendingToolExec };
      }
    }

    if (!pendingKind) return null;

    return cloneJson({
      schemaVersion: PENDING_RUN_SNAPSHOT_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      actorRunId,
      actorId: saved.context.actor.actorId,
      skillId: saved.skill.skillId,
      status: saved.state.status as "waiting_human_input" | "waiting_approval" | "waiting_external_event",
      pendingKind,
      skill: saved.skill,
      state: saved.state,
      context: saved.context,
      pendingHumanInput: saved.pendingHumanInput,
      pendingSkillApproval: saved.pendingSkillApproval,
      pendingExternalEvent: saved.pendingExternalEvent,
      pendingToolApproval,
    } as PendingRunSnapshot);
  }

  restorePendingRun(snapshot: PendingRunSnapshot): void {
    if (snapshot.schemaVersion !== PENDING_RUN_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error("Unsupported PendingRunSnapshot schemaVersion: " + String(snapshot.schemaVersion));
    }

    const restored = cloneJson(snapshot);
    restored.state.status = restored.status;

    this.runs.set(restored.actorRunId, {
      skill: restored.skill,
      state: restored.state,
      context: restored.context,
      pendingHumanInput: restored.pendingHumanInput,
      pendingSkillApproval: restored.pendingSkillApproval,
      pendingExternalEvent: restored.pendingExternalEvent,
    });

    const pendingToolExec = restored.pendingToolApproval?.pendingExec;
    const restoredPendingExec = pendingToolExec ? ({
      ...pendingToolExec,
      context: restored.context,
      state: restored.state,
    } as PendingExecution) : null;

    actorDecisionExecutor.registerRun({
      actorRunId: restored.actorRunId,
      actorId: restored.actorId,
      context: restored.context,
      state: restored.state,
      pendingExec: restoredPendingExec,
    });

    if (restored.pendingToolApproval) {
      approvalGate.restorePending(restored.actorRunId, restored.pendingToolApproval.approvalRequest);
    }
  }

  clearRun(actorRunId: string): void {
    this.runs.delete(actorRunId);
    actorDecisionExecutor.removeRun(actorRunId);
    approvalGate.clearPending(actorRunId);
  }

  async run(input: ActorRunInput): Promise<ActorRunOutput> {
    const actorRunId = `arun_${++runCounter}`;
    const actorId = input.actorConfig.actor_id;
    const memoryStore = input.runtimeOptions?.memoryStore;
    traceLogger.startRun(actorRunId, actorId, input.skillConfig.skill_id);

    try {
      const memoryLoaded = await loadRuntimeMemoryStore(actorRunId, memoryStore);
      if (!memoryLoaded) throw new Error("MemoryStore load failed");

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

  private endErroredContinue(actorRunId: string, state: SkillState, message: string): ActorRunOutput {
    traceLogger.record(actorRunId, "error", { message });
    state.status = "error";
    traceLogger.endRun(actorRunId, "error");
    actorDecisionExecutor.removeRun(actorRunId);
    this.runs.delete(actorRunId);
    return this.buildOutput(actorRunId, "error", null);
  }

  async continue(actorRunId: string, event: ActorContinueEvent): Promise<ActorRunOutput> {
    const saved = this.runs.get(actorRunId);
    if (!saved) {
      return { actorRunId, status: "error", result: null, toolCalls: [], approvals: [], memoryCandidates: [],
        trace: { actorRunId, eventCount: 0, events: [] } };
    }

    const { context, state, skill, memoryStore } = saved;
    const actorId = context.actor.actorId;

    if (event.type === "approval_decision") {
      if (saved.pendingSkillApproval) {
        const pending = saved.pendingSkillApproval;
        if (pending.approvalRequestId !== event.decision.approvalRequestId) {
          return this.endErroredContinue(actorRunId, state, `Skill approval response id mismatch: ${event.decision.approvalRequestId}`);
        }

        traceLogger.resumeRun(actorRunId, { resumedBy: "approval_decision", waitingKind: "skill_approval", requestId: pending.approvalRequestId, stepKey: pending.stepKey });
        applySkillApprovalDecision(pending, event.decision, state, actorRunId);
        saved.pendingSkillApproval = undefined;

        if (!approvalAllowsResume(event.decision)) {
          return this.endErroredContinue(actorRunId, state, `Skill approval did not approve resume: ${event.decision.decision}`);
        }

        state.status = "running";
        skillRuntime.advanceStep(state);
        return await this.executeLoop(actorRunId, actorId, context, state, skill, memoryStore);
      }

      traceLogger.resumeRun(actorRunId, { resumedBy: "approval_decision", waitingKind: "tool_approval", requestId: event.decision.approvalRequestId });
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
        const message = pending ? `Human input response id mismatch: ${event.response.humanInputRequestId}` : `No pending human input for ${actorRunId}`;
        return this.endErroredContinue(actorRunId, state, message);
      }

      traceLogger.resumeRun(actorRunId, { resumedBy: "human_input_response", waitingKind: "human_input", requestId: pending.humanInputRequestId, stepKey: pending.stepKey });
      applyHumanInputResponse(pending, event.response, state, actorRunId);
      saved.pendingHumanInput = undefined;
      state.status = "running";
      skillRuntime.advanceStep(state);
      return await this.executeLoop(actorRunId, actorId, context, state, skill, memoryStore);
    }

    if (event.type === "external_event_received") {
      const pending = saved.pendingExternalEvent;
      if (!pending) {
        return this.endErroredContinue(actorRunId, state, `No pending external event for ${actorRunId}`);
      }

      const validation = validateExternalEventReceived(pending, event.event);
      if (!validation.valid) {
        traceLogger.record(actorRunId, "external_event_validation_failed", {
          externalEventRequestId: event.event.externalEventRequestId,
          stepKey: pending.stepKey,
          eventName: event.event.eventName,
          validationErrors: validation.errors,
          expectedCorrelationKey: pending.correlationKey,
          receivedCorrelationKey: event.event.correlationKey,
        });
        state.status = "waiting_external_event";
        return this.buildOutput(actorRunId, "waiting_external_event", null);
      }

      traceLogger.resumeRun(actorRunId, { resumedBy: "external_event_received", waitingKind: "external_event", requestId: pending.externalEventRequestId, stepKey: pending.stepKey, eventName: pending.eventName });
      applyExternalEventReceived(pending, event.event, state, actorRunId);
      saved.pendingExternalEvent = undefined;
      state.status = "running";
      skillRuntime.advanceStep(state);
      return await this.executeLoop(actorRunId, actorId, context, state, skill, memoryStore);
    }

    return await this.executeLoop(actorRunId, actorId, context, state, skill, memoryStore);
  }

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
        traceLogger.suspendRun(actorRunId, "waiting_human_input", { waitingKind: "human_input", stepKey: request.stepKey, requestId: request.humanInputRequestId });
        return this.buildOutput(actorRunId, "waiting_human_input", null, undefined, undefined, request);
      }

      if (step.type === "wait_approval") {
        const request = buildSkillApprovalRequest(step as WaitApprovalStep, actorRunId);
        const saved = this.runs.get(actorRunId);
        if (saved) saved.pendingSkillApproval = request;
        state.status = "waiting_approval";
        traceLogger.suspendRun(actorRunId, "waiting_approval", { waitingKind: "skill_approval", stepKey: request.stepKey, requestId: request.approvalRequestId, reason: request.reason });
        return this.buildOutput(actorRunId, "waiting_approval", null, request);
      }

      if (step.type === "wait_external_event") {
        const request = buildExternalEventRequest(step as WaitExternalEventStep, state, actorRunId);
        const saved = this.runs.get(actorRunId);
        if (saved) saved.pendingExternalEvent = request;
        state.status = "waiting_external_event";
        traceLogger.suspendRun(actorRunId, "waiting_external_event", { waitingKind: "external_event", stepKey: request.stepKey, requestId: request.externalEventRequestId, eventName: request.eventName, correlationKey: request.correlationKey });
        return this.buildOutput(actorRunId, "waiting_external_event", null, undefined, undefined, undefined, request);
      }

      if (step.type === "end") {
        const message = `Unsupported runtime skill step type: ${step.type}`;
        traceLogger.record(actorRunId, "error", { message, stepKey: step.stepKey });
        state.status = "error";
        break;
      }

      if (step.type === "llm_judge") {
        const judgeStep = step as LLMJudgeStep;
        const judgeResult = await actorDecisionEngine.generateJudgeResult({ step: judgeStep, context, state, actorRunId });
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
          traceLogger.suspendRun(actorRunId, "waiting_approval", { waitingKind: "tool_approval", requestId: execResult.approvalRequest.approvalRequestId, toolName: execResult.approvalRequest.toolName, reason: execResult.approvalRequest.reason });
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
      traceLogger.record(actorRunId, "memory_candidate_generated", { candidateId: c.candidateId, scope: c.scope, type: c.type, content: c.content } as Record<string, unknown>);
      const accepted = memoryService.getAllMemories().find((m) => m.sourceRunId === actorRunId && m.content === c.content);
      if (accepted) {
        traceLogger.record(actorRunId, "memory_accepted", { memoryId: accepted.memoryId, candidateId: c.candidateId, scope: accepted.scope, type: accepted.type });
      }
    }

    traceLogger.record(actorRunId, "memory_write_summary", memoryGeneration.summary as unknown as Record<string, unknown>);

    const memorySaved = await saveRuntimeMemoryStore(actorRunId, memoryStore);
    if (!memorySaved) state.status = "error";

    const endStatus: "completed" | "error" = state.status === "completed" ? "completed" : "error";
    traceLogger.endRun(actorRunId, endStatus);

    actorDecisionExecutor.removeRun(actorRunId);
    this.runs.delete(actorRunId);

    return this.buildOutput(actorRunId, endStatus, finalResult, undefined, memoryCandidates);
  }

  private buildPendingApprovalOutput(pendingApproval: ApprovalRequest | SkillApprovalRequest): PendingApprovalOutput {
    const maybeSkillApproval = pendingApproval as Partial<SkillApprovalRequest>;
    if (maybeSkillApproval.approvalKind === "skill_step") {
      const skillApproval = pendingApproval as SkillApprovalRequest;
      return { approvalKind: "skill_step", approvalRequestId: skillApproval.approvalRequestId, stepKey: skillApproval.stepKey, outputKey: skillApproval.outputKey, reason: skillApproval.reason };
    }

    const toolApproval = pendingApproval as ApprovalRequest;
    return { approvalKind: "tool_call", approvalRequestId: toolApproval.approvalRequestId, toolName: toolApproval.toolName, reason: toolApproval.reason };
  }

  private buildOutput(
    actorRunId: string,
    status: ActorRunStatus,
    result: Record<string, unknown> | null,
    pendingApproval?: ApprovalRequest | SkillApprovalRequest,
    memoryCandidates?: Array<{ candidateId: string; scope: string; type: string; content: string; confidence?: number }>,
    pendingHumanInput?: HumanInputRequest,
    pendingExternalEvent?: ExternalEventRequest
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
        const decision = trace.events.find((d) => d.eventType === "approval_decided" && d.data.approvalRequestId === e.data.approvalRequestId);
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
      pendingApproval: pendingApproval ? this.buildPendingApprovalOutput(pendingApproval) : undefined,
      pendingHumanInput,
      pendingExternalEvent,
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
