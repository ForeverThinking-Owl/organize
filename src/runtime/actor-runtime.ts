// ============================================================================
// ActorRuntime — Actor Kernel 主执行器
// v0.4.5: wait_external_event validates payload / correlation before resume
// ============================================================================

import { randomUUID } from "node:crypto";
import { ActorConfig } from "../core/types/actor";
import {
  Skill,
  SkillConfig,
  ToolCallStep,
  LLMJudgeStep,
  TransformStep,
  HumanInputStep,
  WaitApprovalStep,
  WaitExternalEventStep,
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
import { buildInitialSkillContext, parseSkillConfig } from "./runtime-skill-config";
import { assertPendingRunSnapshot } from "./pending-run-validation";
import { toolGateway } from "../tools/tool-gateway";
import { validateToolArguments } from "../tools/tool-schema-validation";
import { assertPendingToolGovernance } from "./pending-tool-governance-validation";
import { assertActorConfig } from "./actor-config-validation";
import {
  claimStandaloneOrganizationRun,
  releaseStandaloneOrganizationRun,
} from "../organization/organization-operation-lease";

export interface ActorRuntimeOptions {
  memoryStore?: MemoryStore;
  /** Internal token used when an OrganizationRuntime owns this partition. */
  organizationOwnerToken?: symbol;
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const APPROVAL_DECISIONS = new Set<ApprovalDecision["decision"]>([
  "approve",
  "reject",
  "approve_with_modified_arguments",
  "approve_with_modified_result_view",
  "approve_with_comment",
  "request_more_info",
  "escalate",
  "cancel",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function jsonSafetyError(
  value: unknown,
  path: string,
  ancestors = new Set<object>()
): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : `${path} must contain finite numbers`;
  }
  if (typeof value !== "object") return `${path} is not JSON-safe`;
  if (ancestors.has(value)) return `${path} contains a circular reference`;

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) return `${path}[${index}] is a sparse array entry`;
      const error = jsonSafetyError(value[index], `${path}[${index}]`, ancestors);
      if (error) return error;
    }
  } else {
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
      return `${path} must be a plain JSON object`;
    }
    for (const [key, item] of Object.entries(value)) {
      const error = jsonSafetyError(item, `${path}.${key}`, ancestors);
      if (error) return error;
    }
  }
  ancestors.delete(value);
  return null;
}

interface CanonicalActorRunInput {
  actorConfig: ActorConfig;
  skill: Skill;
  input: ActorRunInput["input"];
  runtimeContext: Record<string, unknown>;
}

function validateActorRunPreflight(input: ActorRunInput): CanonicalActorRunInput {
  assertActorConfig(input.actorConfig);

  const skillJsonError = jsonSafetyError(input.skillConfig, "skillConfig");
  if (skillJsonError) throw new Error(skillJsonError);
  const skill = parseSkillConfig(input.skillConfig, input.actorConfig.actor_id);
  if (skill.ownerActorId !== input.actorConfig.actor_id) {
    throw new Error(
      `Skill ${skill.skillId} is owned by ${skill.ownerActorId}, not ${input.actorConfig.actor_id}`
    );
  }
  if (!(input.actorConfig.permissions.allowed_skills ?? []).includes(skill.skillId)) {
    throw new Error(
      `Skill ${skill.skillId} is not allowed for Actor ${input.actorConfig.actor_id}`
    );
  }

  if (!isPlainRecord(input.input)) {
    throw new Error("input must be a plain object");
  }
  for (const field of Object.keys(input.input)) {
    if (field !== "text" && field !== "payload") {
      throw new Error(`Unsupported Actor input field: ${field}`);
    }
  }
  if (input.input.text !== undefined && typeof input.input.text !== "string") {
    throw new Error("input.text must be a string when present");
  }
  if (input.input.payload !== undefined && !isPlainRecord(input.input.payload)) {
    throw new Error("input.payload must be a plain object when present");
  }
  const inputJsonError = jsonSafetyError(input.input, "input");
  if (inputJsonError) throw new Error(inputJsonError);

  const runtimeContext = input.runtimeContext ?? {};
  if (!isPlainRecord(runtimeContext)) {
    throw new Error("runtimeContext must be a plain object");
  }
  const runtimeContextJsonError = jsonSafetyError(runtimeContext, "runtimeContext");
  if (runtimeContextJsonError) throw new Error(runtimeContextJsonError);

  // Detach all execution-bearing data before claim/await. The parsed Skill
  // retains mappings and schemas from its config, so clone it as well.
  return {
    actorConfig: cloneJson(input.actorConfig),
    skill: cloneJson(skill),
    input: cloneJson(input.input),
    runtimeContext: cloneJson(runtimeContext),
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
  private continuationTails: Map<string, Promise<void>> = new Map();

  hasRun(actorRunId: string): boolean {
    return Boolean(
      this.runs.has(actorRunId) ||
      actorDecisionExecutor.getRun(actorRunId) ||
      approvalGate.getPending(actorRunId) ||
      this.continuationTails.has(actorRunId)
    );
  }

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

    const snapshot = cloneJson({
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
    assertPendingRunSnapshot(snapshot);
    return snapshot;
  }

  restorePendingRun(
    snapshot: PendingRunSnapshot,
    options: Pick<ActorRuntimeOptions, "organizationOwnerToken"> = {}
  ): void {
    assertPendingRunSnapshot(snapshot);
    assertPendingToolGovernance(snapshot);
    if (
      this.hasRun(snapshot.actorRunId)
    ) {
      throw new Error(`Actor run ${snapshot.actorRunId} already exists`);
    }
    const organizationId = snapshot.context.actor.organizationId;
    if (
      !claimStandaloneOrganizationRun(
        organizationId,
        snapshot.actorRunId,
        options.organizationOwnerToken
      )
    ) {
      throw new Error(`Organization ${organizationId} is owned by OrganizationRuntime`);
    }

    try {
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
    } catch (error) {
      this.runs.delete(snapshot.actorRunId);
      actorDecisionExecutor.removeRun(snapshot.actorRunId);
      approvalGate.clearPending(snapshot.actorRunId);
      releaseStandaloneOrganizationRun(organizationId, snapshot.actorRunId);
      throw error;
    }
  }

  clearRun(actorRunId: string): void {
    const saved = this.runs.get(actorRunId);
    if (!saved) {
      if (actorDecisionExecutor.getRun(actorRunId) || approvalGate.getPending(actorRunId)) {
        throw new Error(`Actor run ${actorRunId} is owned by another ActorRuntime`);
      }
      return;
    }
    if (this.continuationTails.has(actorRunId)) {
      throw new Error(`Actor run ${actorRunId} has an in-flight continuation`);
    }
    this.runs.delete(actorRunId);
    actorDecisionExecutor.removeRun(actorRunId);
    approvalGate.clearPending(actorRunId);
    releaseStandaloneOrganizationRun(saved.context.actor.organizationId, actorRunId);
  }

  async run(input: ActorRunInput): Promise<ActorRunOutput> {
    const actorRunId = `arun_${randomUUID()}`;
    const receivedActorId = typeof input?.actorConfig?.actor_id === "string"
      ? input.actorConfig.actor_id
      : "invalid_actor";
    const receivedSkillId = typeof input?.skillConfig?.skill_id === "string"
      ? input.skillConfig.skill_id
      : "invalid_skill";
    let canonical: CanonicalActorRunInput;
    try {
      canonical = validateActorRunPreflight(input);
    } catch (error) {
      traceLogger.startRun(
        actorRunId,
        receivedActorId || "invalid_actor",
        receivedSkillId || "invalid_skill"
      );
      traceLogger.record(actorRunId, "error", {
        message: error instanceof Error ? error.message : String(error),
      });
      traceLogger.endRun(actorRunId, "error");
      return this.buildOutput(actorRunId, "error", null);
    }

    const { actorConfig, skill, runtimeContext } = canonical;
    const actorId = actorConfig.actor_id;
    const organizationId = actorConfig.organization_id ?? "org_default";
    const memoryStore = input.runtimeOptions?.memoryStore;
    if (
      !claimStandaloneOrganizationRun(
        organizationId,
        actorRunId,
        input.runtimeOptions?.organizationOwnerToken
      )
    ) {
      throw new Error(`Organization ${organizationId} is owned by OrganizationRuntime`);
    }
    traceLogger.startRun(actorRunId, actorId, skill.skillId);

    try {
      const memoryLoaded = await loadRuntimeMemoryStore(actorRunId, organizationId, memoryStore);
      if (!memoryLoaded) throw new Error("MemoryStore load failed");

      if (actorConfig.memory.length) {
        memoryService.initActorMemory(
          { actorId, organizationId,
            unitId: actorConfig.unit_id, type: actorConfig.type,
            name: actorConfig.name, role: actorConfig.role,
            responsibility: actorConfig.responsibility,
            autonomyLevel: actorConfig.autonomy_level as "L2_read_and_draft", status: "active" },
          actorConfig.memory
        );
      }

      const context = actorContextBuilder.build(
        actorConfig,
        canonical.input,
        runtimeContext,
        actorRunId
      );
      traceLogger.record(actorRunId, "context_built", {
        actorId, skillId: skill.skillId,
        memoryCount: context.memory.actorPrivate.length,
        hybridMemoryCount:
          context.memory.structured.length + context.memory.semantic.length + context.memory.episodic.length +
          context.memory.procedural.length + context.memory.governance.length,
        availableToolCount: context.availableTools.length,
      });

      const state = skillRuntime.initState(
        skill,
        buildInitialSkillContext(canonical.input, runtimeContext)
      );

      actorDecisionExecutor.registerRun({ actorRunId, actorId, context, state, pendingExec: null });
      this.runs.set(actorRunId, { skill, state, context, memoryStore });
      return await this.executeLoop(actorRunId, actorId, context, state, skill, memoryStore);
    } catch (error) {
      traceLogger.record(actorRunId, "error", { message: error instanceof Error ? error.message : String(error) });
      traceLogger.endRun(actorRunId, "error");
      actorDecisionExecutor.removeRun(actorRunId);
      this.runs.delete(actorRunId);
      releaseStandaloneOrganizationRun(organizationId, actorRunId);
      return this.buildOutput(actorRunId, "error", null);
    }
  }

  private endErroredContinue(actorRunId: string, state: SkillState, message: string): ActorRunOutput {
    const organizationId = this.runs.get(actorRunId)?.context.actor.organizationId;
    traceLogger.record(actorRunId, "error", { message });
    state.status = "error";
    traceLogger.endRun(actorRunId, "error");
    approvalGate.clearPending(actorRunId);
    actorDecisionExecutor.removeRun(actorRunId);
    this.runs.delete(actorRunId);
    if (organizationId) releaseStandaloneOrganizationRun(organizationId, actorRunId);
    return this.buildOutput(actorRunId, "error", null);
  }

  private receivedContinuationMetadata(event: unknown): {
    receivedEventType: string;
    receivedRequestId?: string;
  } {
    if (!isRecord(event)) return { receivedEventType: "invalid" };
    const receivedEventType = typeof event.type === "string" ? event.type : "invalid";
    const body =
      receivedEventType === "human_input_response"
        ? event.response
        : receivedEventType === "approval_decision"
          ? event.decision
          : receivedEventType === "external_event_received"
            ? event.event
            : undefined;
    if (!isRecord(body)) return { receivedEventType };
    const requestId =
      receivedEventType === "human_input_response"
        ? body.humanInputRequestId
        : receivedEventType === "approval_decision"
          ? body.approvalRequestId
          : body.externalEventRequestId;
    return {
      receivedEventType,
      ...(typeof requestId === "string" ? { receivedRequestId: requestId } : {}),
    };
  }

  private rejectInvalidContinuation(
    pending: PendingRunSnapshot,
    event: unknown,
    validationErrors: string[]
  ): ActorRunOutput {
    const received = this.receivedContinuationMetadata(event);
    const expectedRequestId =
      pending.pendingHumanInput?.humanInputRequestId ??
      pending.pendingSkillApproval?.approvalRequestId ??
      pending.pendingToolApproval?.approvalRequest.approvalRequestId ??
      pending.pendingExternalEvent?.externalEventRequestId;

    traceLogger.record(pending.actorRunId, "continuation_validation_failed", {
      pendingKind: pending.pendingKind,
      receivedEventType: received.receivedEventType,
      expectedRequestId,
      ...(received.receivedRequestId
        ? { receivedRequestId: received.receivedRequestId }
        : {}),
      validationErrors,
    });
    return this.buildOutput(pending.actorRunId, pending.status, null);
  }

  private validateApprovalDecision(
    pending: PendingRunSnapshot,
    value: unknown
  ): string[] {
    if (!isRecord(value)) return ["Approval decision must be an object"];

    const errors: string[] = [];
    const allowedFields = new Set([
      "approvalRequestId",
      "decision",
      "modifiedArguments",
      "modifiedResultView",
      "comment",
      "decidedBy",
      "decidedAt",
    ]);
    for (const field of Object.keys(value)) {
      if (!allowedFields.has(field)) errors.push(`Unsupported approval decision field: ${field}`);
    }
    const decisionJsonError = jsonSafetyError(value, "decision");
    if (decisionJsonError) errors.push(decisionJsonError);
    if (typeof value.approvalRequestId !== "string" || value.approvalRequestId.length === 0) {
      errors.push("approvalRequestId must be a non-empty string");
    }
    if (typeof value.decision !== "string" || !APPROVAL_DECISIONS.has(value.decision as ApprovalDecision["decision"])) {
      errors.push(`Unsupported approval decision: ${describeUnknown(value.decision)}`);
    }
    if (typeof value.decidedAt !== "string" || value.decidedAt.length === 0) {
      errors.push("decidedAt must be a non-empty string");
    }
    for (const field of ["comment", "decidedBy"] as const) {
      if (value[field] !== undefined && typeof value[field] !== "string") {
        errors.push(`${field} must be a string when present`);
      }
    }

    const decision = value.decision;
    const capturedPolicy = pending.pendingToolApproval?.approvalRequest.policy;
    if (pending.pendingKind === "tool_approval") {
      if (decision === "reject" && capturedPolicy?.allowReject !== true) {
        errors.push("Pending Tool approval policy does not allow rejection");
      }
      if (
        (decision === "approve_with_comment" || value.comment !== undefined) &&
        capturedPolicy?.allowComment !== true
      ) {
        errors.push("Pending Tool approval policy does not allow comments");
      }
    }
    const hasModifiedArguments = value.modifiedArguments !== undefined;
    if (hasModifiedArguments) {
      if (!isPlainRecord(value.modifiedArguments)) {
        errors.push("modifiedArguments must be a plain object");
      } else {
        const jsonError = jsonSafetyError(value.modifiedArguments, "modifiedArguments");
        if (jsonError) errors.push(jsonError);
      }
      if (decision !== "approve_with_modified_arguments") {
        errors.push("modifiedArguments requires approve_with_modified_arguments");
      }
    }
    if (value.modifiedResultView !== undefined || decision === "approve_with_modified_result_view") {
      errors.push("approve_with_modified_result_view is not valid for a before-call approval");
    }

    if (decision === "approve_with_modified_arguments") {
      if (pending.pendingKind !== "tool_approval") {
        errors.push("approve_with_modified_arguments is only valid for Tool approval");
      }
      if (!hasModifiedArguments) {
        errors.push("approve_with_modified_arguments requires modifiedArguments");
      }
      const toolName = pending.pendingToolApproval?.approvalRequest.toolName;
      const toolDefinition = toolName ? toolGateway.getDefinition(toolName) : undefined;
      if (capturedPolicy?.allowModifyArguments !== true) {
        errors.push(`Tool ${toolName ?? "unknown"} does not allow argument modification`);
      }
      if (isPlainRecord(value.modifiedArguments)) {
        errors.push(...validateToolArguments(value.modifiedArguments, toolDefinition?.inputSchema));
      }
    }

    return errors;
  }

  private validateContinuation(
    pending: PendingRunSnapshot,
    event: unknown
  ): string[] {
    if (!isRecord(event)) return ["Continuation event must be an object"];
    const expectedEventType =
      pending.pendingKind === "human_input"
        ? "human_input_response"
        : pending.pendingKind === "external_event"
          ? "external_event_received"
          : "approval_decision";
    if (event.type !== expectedEventType) {
      return [`Expected ${expectedEventType} for ${pending.pendingKind}, received ${describeUnknown(event.type)}`];
    }
    const bodyField =
      expectedEventType === "human_input_response"
        ? "response"
        : expectedEventType === "approval_decision"
          ? "decision"
          : "event";
    const envelopeErrors = Object.keys(event)
      .filter((field) => field !== "type" && field !== bodyField)
      .map((field) => `Unsupported continuation event field: ${field}`);
    const eventJsonError = jsonSafetyError(event, "event");
    if (eventJsonError) envelopeErrors.push(eventJsonError);

    if (pending.pendingKind === "human_input") {
      if (!isRecord(event.response)) return ["Human input response must be an object"];
      const errors: string[] = [...envelopeErrors];
      const allowedFields = new Set([
        "humanInputRequestId",
        "value",
        "respondedBy",
        "respondedAt",
      ]);
      for (const field of Object.keys(event.response)) {
        if (!allowedFields.has(field)) errors.push(`Unsupported human input response field: ${field}`);
      }
      if (
        typeof event.response.humanInputRequestId !== "string" ||
        pending.pendingHumanInput?.humanInputRequestId !== event.response.humanInputRequestId
      ) {
        errors.push("Human input request id mismatch");
      }
      if (!("value" in event.response)) {
        errors.push("Human input response requires value");
      } else {
        const jsonError = jsonSafetyError(event.response.value, "response.value");
        if (jsonError) errors.push(jsonError);
      }
      for (const field of ["respondedBy", "respondedAt"] as const) {
        if (event.response[field] !== undefined && typeof event.response[field] !== "string") {
          errors.push(`${field} must be a string when present`);
        }
      }
      return errors;
    }

    if (pending.pendingKind === "skill_approval" || pending.pendingKind === "tool_approval") {
      const errors = [
        ...envelopeErrors,
        ...this.validateApprovalDecision(pending, event.decision),
      ];
      if (pending.pendingKind === "tool_approval") {
        try {
          assertPendingToolGovernance(pending);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (isRecord(event.decision)) {
        const expectedRequestId =
          pending.pendingSkillApproval?.approvalRequestId ??
          pending.pendingToolApproval?.approvalRequest.approvalRequestId;
        if (event.decision.approvalRequestId !== expectedRequestId) {
          errors.push(`${pending.pendingKind === "skill_approval" ? "Skill" : "Tool"} approval request id mismatch`);
        }
      }
      return errors;
    }

    if (!isRecord(event.event)) return ["External event must be an object"];
    const errors: string[] = [...envelopeErrors];
    const allowedFields = new Set([
      "externalEventRequestId",
      "eventName",
      "correlationKey",
      "payload",
      "receivedBy",
      "receivedAt",
    ]);
    for (const field of Object.keys(event.event)) {
      if (!allowedFields.has(field)) errors.push(`Unsupported external event field: ${field}`);
    }
    for (const field of ["externalEventRequestId", "eventName"] as const) {
      if (typeof event.event[field] !== "string" || event.event[field].length === 0) {
        errors.push(`${field} must be a non-empty string`);
      }
    }
    if (!("payload" in event.event)) {
      errors.push("External event requires payload");
    } else {
      const jsonError = jsonSafetyError(event.event.payload, "event.payload");
      if (jsonError) errors.push(jsonError);
    }
    for (const field of ["correlationKey", "receivedBy", "receivedAt"] as const) {
      if (event.event[field] !== undefined && typeof event.event[field] !== "string") {
        errors.push(`${field} must be a string when present`);
      }
    }
    return errors;
  }

  async continue(actorRunId: string, event: ActorContinueEvent): Promise<ActorRunOutput> {
    const previous = this.continuationTails.get(actorRunId) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => slot);
    this.continuationTails.set(actorRunId, tail);

    await previous.catch(() => undefined);
    try {
      try {
        return await this.continueUnlocked(actorRunId, event);
      } catch (error) {
        const saved = this.runs.get(actorRunId);
        if (!saved) throw error;
        return this.endErroredContinue(
          actorRunId,
          saved.state,
          `Continuation failed: ${error instanceof Error ? error.message : describeUnknown(error)}`
        );
      }
    } finally {
      release();
      if (this.continuationTails.get(actorRunId) === tail) {
        this.continuationTails.delete(actorRunId);
      }
    }
  }

  private async continueUnlocked(actorRunId: string, event: ActorContinueEvent): Promise<ActorRunOutput> {
    const saved = this.runs.get(actorRunId);
    if (!saved) {
      return { actorRunId, status: "error", result: null, toolCalls: [], approvals: [], memoryCandidates: [],
        trace: { actorRunId, eventCount: 0, events: [] } };
    }

    const { context, state, skill, memoryStore } = saved;
    const actorId = context.actor.actorId;
    const pending = this.dumpPendingRun(actorRunId);
    if (pending) {
      const validationErrors = this.validateContinuation(pending, event);
      if (validationErrors.length > 0) {
        return this.rejectInvalidContinuation(pending, event, validationErrors);
      }
      // Detach live execution state from caller-owned objects after validation.
      event = cloneJson(event);
    }

    if (event.type === "approval_decision") {
      if (saved.pendingSkillApproval) {
        const pending = saved.pendingSkillApproval;
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
      let execResult;
      try {
        execResult = await actorDecisionExecutor.continueAfterApproval(actorRunId, event.decision);
      } catch (error) {
        return this.endErroredContinue(
          actorRunId,
          state,
          `Tool approval continuation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (execResult.outcome === "error") {
        return this.endErroredContinue(actorRunId, state, execResult.reason);
      }
      if (execResult.outcome === "completed") {
        state.status = "running";
        skillRuntime.advanceStep(state);
        return await this.executeLoop(actorRunId, actorId, context, state, skill, memoryStore);
      }
    }

    if (event.type === "human_input_response") {
      const pending = saved.pendingHumanInput;
      if (!pending) {
        const message = `No pending human input for ${actorRunId}`;
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
          traceLogger.suspendRun(actorRunId, "waiting_approval", { waitingKind: "tool_approval", requestId: execResult.approvalRequest.approvalRequestId, stepKey: step.stepKey, toolName: execResult.approvalRequest.toolName, reason: execResult.approvalRequest.reason });
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

    const memorySaved = await saveRuntimeMemoryStore(
      actorRunId,
      context.actor.organizationId,
      memoryStore
    );
    if (!memorySaved) state.status = "error";

    const endStatus: "completed" | "error" = state.status === "completed" ? "completed" : "error";
    traceLogger.endRun(actorRunId, endStatus);

    actorDecisionExecutor.removeRun(actorRunId);
    this.runs.delete(actorRunId);
    releaseStandaloneOrganizationRun(context.actor.organizationId, actorRunId);

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

    return cloneJson({
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
    });
  }
}

export const actorRuntime = new ActorRuntime();
