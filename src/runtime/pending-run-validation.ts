import { isDeepStrictEqual } from "node:util";
import type { ActorContext } from "../core/types/actor";
import type { ApprovalRequest } from "../core/types/approval";
import type { Skill, SkillStep } from "../core/types/skill";
import type { ToolCallRequest, ToolObservation } from "../core/types/tool";
import {
  PENDING_RUN_SNAPSHOT_SCHEMA_VERSION,
  type PendingRunKind,
  type PendingRunSnapshot,
  type PendingRunStatus,
  type PendingToolApprovalSnapshot,
} from "./pending-run-snapshot";
import { buildCanonicalPendingToolDescriptor } from "./pending-tool-descriptor";
import { resolveExternalEventCorrelationKey } from "./external-event-correlation";
import type { SkillState } from "./skill-runtime";

type JsonRecord = Record<string, unknown>;

const PENDING_FIELDS = [
  "pendingHumanInput",
  "pendingSkillApproval",
  "pendingToolApproval",
  "pendingExternalEvent",
] as const;

const STATUS_BY_KIND: Record<PendingRunKind, PendingRunStatus> = {
  human_input: "waiting_human_input",
  skill_approval: "waiting_approval",
  tool_approval: "waiting_approval",
  external_event: "waiting_external_event",
};

function invalid(message: string): never {
  throw new Error(`Invalid PendingRunSnapshot: ${message}`);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) invalid(`${path} must be an object`);
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`);
  return value;
}

function requireString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    invalid(`${path} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path, true);
}

function requireStringArray(value: unknown, path: string): string[] {
  const items = requireArray(value, path);
  for (let index = 0; index < items.length; index++) {
    requireString(items[index], `${path}[${index}]`, true);
  }
  return items as string[];
}

function assertExactKeys(
  value: JsonRecord,
  required: readonly string[],
  allowed: readonly string[],
  path: string
): void {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      invalid(`${path}.${key} is required`);
    }
  }
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) invalid(`${path}.${key} is not supported`);
  }
}

function assertUniqueStrings(values: string[], path: string): void {
  if (new Set(values).size !== values.length) invalid(`${path} must not contain duplicates`);
}

function assertJsonSafe(value: unknown, path: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} must contain finite numbers`);
    return;
  }
  if (typeof value !== "object") invalid(`${path} is not JSON-safe`);
  if (seen.has(value)) invalid(`${path} contains a circular reference`);

  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) invalid(`${path}[${index}] is a sparse array entry`);
      assertJsonSafe(value[index], `${path}[${index}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      invalid(`${path} must be a plain JSON object`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafe(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertStringMapping(value: unknown, path: string): void {
  const mapping = requireRecord(value, path);
  for (const [key, item] of Object.entries(mapping)) {
    requireString(item, `${path}.${key}`, true);
  }
}

function assertSkillStep(value: unknown, index: number): asserts value is SkillStep {
  const path = `skill.steps[${index}]`;
  const step = requireRecord(value, path);
  requireString(step.stepKey, `${path}.stepKey`);
  optionalString(step.description, `${path}.description`);

  switch (step.type) {
    case "tool_call":
      requireString(step.toolName, `${path}.toolName`);
      assertStringMapping(step.inputMapping, `${path}.inputMapping`);
      requireString(step.outputKey, `${path}.outputKey`);
      break;
    case "llm_judge":
      requireString(step.instruction, `${path}.instruction`);
      requireString(step.outputKey, `${path}.outputKey`);
      if (step.outputSchema !== undefined) requireRecord(step.outputSchema, `${path}.outputSchema`);
      break;
    case "transform":
      assertStringMapping(step.mapping, `${path}.mapping`);
      requireString(step.outputKey, `${path}.outputKey`);
      break;
    case "return":
      if (step.outputMapping !== undefined) {
        assertStringMapping(step.outputMapping, `${path}.outputMapping`);
      }
      break;
    case "human_input":
      requireString(step.prompt, `${path}.prompt`);
      requireString(step.outputKey, `${path}.outputKey`);
      break;
    case "wait_approval":
      optionalString(step.approvalRequestId, `${path}.approvalRequestId`);
      requireString(step.reason, `${path}.reason`);
      requireString(step.outputKey, `${path}.outputKey`);
      break;
    case "wait_external_event":
      requireString(step.eventName, `${path}.eventName`);
      optionalString(step.correlationKey, `${path}.correlationKey`);
      optionalString(step.reason, `${path}.reason`);
      requireString(step.outputKey, `${path}.outputKey`);
      if (step.eventSchema !== undefined) requireRecord(step.eventSchema, `${path}.eventSchema`);
      break;
    case "end":
      break;
    default:
      invalid(`${path}.type is unsupported: ${String(step.type)}`);
  }
  assertJsonSafe(step, path);
}

function assertSkill(value: unknown): asserts value is Skill {
  const skill = requireRecord(value, "skill");
  requireString(skill.skillId, "skill.skillId");
  requireString(skill.name, "skill.name");
  optionalString(skill.description, "skill.description");
  requireString(skill.ownerActorId, "skill.ownerActorId");
  const steps = requireArray(skill.steps, "skill.steps");
  const stepKeys = new Set<string>();
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    assertSkillStep(step, index);
    if (stepKeys.has(step.stepKey)) {
      invalid(`skill.steps contains duplicate stepKey ${step.stepKey}`);
    }
    stepKeys.add(step.stepKey);
  }
}

function assertToolObservation(value: unknown, index: number): void {
  const path = `state.observations[${index}]`;
  const observation = requireRecord(value, path);
  requireString(observation.toolCallId, `${path}.toolCallId`);
  requireString(observation.toolName, `${path}.toolName`);
  if (!["success", "error", "permission_denied", "pending_approval"].includes(String(observation.status))) {
    invalid(`${path}.status is unsupported: ${String(observation.status)}`);
  }
  if (observation.data !== undefined) requireRecord(observation.data, `${path}.data`);
  optionalString(observation.error, `${path}.error`);
  requireString(observation.executedAt, `${path}.executedAt`);
  assertJsonSafe(observation, path);
}

function assertSkillState(value: unknown, skill: Skill): asserts value is SkillState {
  const state = requireRecord(value, "state");
  requireString(state.skillId, "state.skillId");
  if (!Number.isInteger(state.currentStepIndex)) {
    invalid("state.currentStepIndex must be an integer");
  }
  const currentStepIndex = state.currentStepIndex as number;
  if (currentStepIndex < 0 || currentStepIndex >= skill.steps.length) {
    invalid("state.currentStepIndex must identify a current skill step");
  }
  requireRecord(state.steps, "state.steps");
  requireRecord(state.outputs, "state.outputs");
  requireRecord(state.context, "state.context");
  if (!["running", "completed", "waiting_approval", "waiting_human_input", "waiting_external_event", "error"].includes(String(state.status))) {
    invalid(`state.status is unsupported: ${String(state.status)}`);
  }
  const observations = requireArray(state.observations, "state.observations");
  observations.forEach(assertToolObservation);
  assertJsonSafe(state.steps, "state.steps");
  assertJsonSafe(state.outputs, "state.outputs");
  assertJsonSafe(state.context, "state.context");
}

function assertActorContext(value: unknown, actorId: string): asserts value is ActorContext {
  const context = requireRecord(value, "context");
  const contextFields = [
    "actor",
    "input",
    "runtimeContext",
    "memory",
    "permissions",
    "approvalJudgment",
    "availableTools",
  ] as const;
  assertExactKeys(context, contextFields, contextFields, "context");
  const actor = requireRecord(context.actor, "context.actor");
  if (requireString(actor.actorId, "context.actor.actorId") !== actorId) {
    invalid("context.actor.actorId must match actorId");
  }
  requireString(actor.organizationId, "context.actor.organizationId");
  optionalString(actor.unitId, "context.actor.unitId");
  if (!["ai", "human", "hybrid", "system"].includes(String(actor.type))) {
    invalid(`context.actor.type is unsupported: ${String(actor.type)}`);
  }
  requireString(actor.name, "context.actor.name");
  requireString(actor.role, "context.actor.role");
  requireString(actor.responsibility, "context.actor.responsibility", true);
  requireString(actor.autonomyLevel, "context.actor.autonomyLevel");
  if (actor.status !== "active" && actor.status !== "inactive") {
    invalid(`context.actor.status is unsupported: ${String(actor.status)}`);
  }
  if (actor.status !== "active") {
    invalid("context.actor.status must be active for a pending run");
  }

  const input = requireRecord(context.input, "context.input");
  optionalString(input.text, "context.input.text");
  if (input.payload !== undefined) requireRecord(input.payload, "context.input.payload");
  requireRecord(context.runtimeContext, "context.runtimeContext");

  const memory = requireRecord(context.memory, "context.memory");
  requireRecord(memory.working, "context.memory.working");
  requireStringArray(memory.organizationPublic, "context.memory.organizationPublic");
  requireStringArray(memory.unitMemory, "context.memory.unitMemory");
  requireStringArray(memory.actorPrivate, "context.memory.actorPrivate");
  requireRecord(memory.sceneShared, "context.memory.sceneShared");
  requireStringArray(memory.structured, "context.memory.structured");
  requireStringArray(memory.semantic, "context.memory.semantic");
  requireStringArray(memory.episodic, "context.memory.episodic");
  requireStringArray(memory.procedural, "context.memory.procedural");
  requireStringArray(memory.governance, "context.memory.governance");

  const permissions = requireRecord(context.permissions, "context.permissions");
  const allowedTools = requireStringArray(
    permissions.allowedTools,
    "context.permissions.allowedTools"
  );
  const deniedTools = requireStringArray(
    permissions.deniedTools,
    "context.permissions.deniedTools"
  );
  assertUniqueStrings(allowedTools, "context.permissions.allowedTools");
  assertUniqueStrings(deniedTools, "context.permissions.deniedTools");
  if (allowedTools.some((toolName) => deniedTools.includes(toolName))) {
    invalid("context.permissions allowedTools and deniedTools must not overlap");
  }
  requireStringArray(permissions.allowedSkills, "context.permissions.allowedSkills");
  if (permissions.deniedFields !== undefined) {
    requireStringArray(permissions.deniedFields, "context.permissions.deniedFields");
  }

  const approvalJudgment = requireRecord(context.approvalJudgment, "context.approvalJudgment");
  requireStringArray(
    approvalJudgment.mustRequestApprovalWhen,
    "context.approvalJudgment.mustRequestApprovalWhen"
  );
  if (approvalJudgment.canApprove !== undefined) {
    const authorities = requireArray(approvalJudgment.canApprove, "context.approvalJudgment.canApprove");
    authorities.forEach((authority, index) => {
      const record = requireRecord(authority, `context.approvalJudgment.canApprove[${index}]`);
      requireString(record.tool_name, `context.approvalJudgment.canApprove[${index}].tool_name`);
    });
  }

  const availableTools = requireArray(context.availableTools, "context.availableTools");
  const availableToolNames = new Set<string>();
  availableTools.forEach((tool, index) => {
    const record = requireRecord(tool, `context.availableTools[${index}]`);
    const toolName = requireString(record.name, `context.availableTools[${index}].name`);
    if (availableToolNames.has(toolName)) {
      invalid(`context.availableTools contains duplicate Tool ${toolName}`);
    }
    availableToolNames.add(toolName);
    if (!allowedTools.includes(toolName) || deniedTools.includes(toolName)) {
      invalid(`context.availableTools Tool ${toolName} is not allowed by permissions`);
    }
    requireString(record.description, `context.availableTools[${index}].description`, true);
    if (record.direction !== "read" && record.direction !== "write") {
      invalid(`context.availableTools[${index}].direction is unsupported`);
    }
    if (!["low", "medium", "high", "critical"].includes(String(record.riskLevel))) {
      invalid(`context.availableTools[${index}].riskLevel is unsupported`);
    }
  });
  assertJsonSafe(context, "context");
}

function assertHumanInputRequest(value: unknown, currentStep: SkillStep): void {
  const request = requireRecord(value, "pendingHumanInput");
  requireString(request.humanInputRequestId, "pendingHumanInput.humanInputRequestId");
  requireString(request.stepKey, "pendingHumanInput.stepKey");
  requireString(request.prompt, "pendingHumanInput.prompt", true);
  requireString(request.outputKey, "pendingHumanInput.outputKey");
  if (
    currentStep.type !== "human_input" ||
    request.stepKey !== currentStep.stepKey ||
    request.prompt !== currentStep.prompt ||
    request.outputKey !== currentStep.outputKey
  ) {
    invalid("pendingHumanInput does not match the current human_input step");
  }
  assertJsonSafe(request, "pendingHumanInput");
}

function assertSkillApprovalRequest(value: unknown, currentStep: SkillStep): void {
  const request = requireRecord(value, "pendingSkillApproval");
  if (request.approvalKind !== "skill_step") {
    invalid("pendingSkillApproval.approvalKind must be skill_step");
  }
  requireString(request.approvalRequestId, "pendingSkillApproval.approvalRequestId");
  requireString(request.stepKey, "pendingSkillApproval.stepKey");
  requireString(request.reason, "pendingSkillApproval.reason", true);
  requireString(request.outputKey, "pendingSkillApproval.outputKey");
  if (
    currentStep.type !== "wait_approval" ||
    request.stepKey !== currentStep.stepKey ||
    request.reason !== currentStep.reason ||
    request.outputKey !== currentStep.outputKey ||
    (currentStep.approvalRequestId !== undefined &&
      request.approvalRequestId !== currentStep.approvalRequestId)
  ) {
    invalid("pendingSkillApproval does not match the current wait_approval step");
  }
  assertJsonSafe(request, "pendingSkillApproval");
}

function expectedCorrelationKey(step: Extract<SkillStep, { type: "wait_external_event" }>, state: SkillState): string | undefined {
  try {
    return resolveExternalEventCorrelationKey(step, state);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
}

function assertExternalEventRequest(value: unknown, currentStep: SkillStep, state: SkillState): void {
  const request = requireRecord(value, "pendingExternalEvent");
  requireString(request.externalEventRequestId, "pendingExternalEvent.externalEventRequestId");
  requireString(request.stepKey, "pendingExternalEvent.stepKey");
  requireString(request.eventName, "pendingExternalEvent.eventName");
  optionalString(request.correlationKey, "pendingExternalEvent.correlationKey");
  optionalString(request.reason, "pendingExternalEvent.reason");
  requireString(request.outputKey, "pendingExternalEvent.outputKey");
  if (request.eventSchema !== undefined) {
    requireRecord(request.eventSchema, "pendingExternalEvent.eventSchema");
  }
  if (
    currentStep.type !== "wait_external_event" ||
    request.stepKey !== currentStep.stepKey ||
    request.eventName !== currentStep.eventName ||
    request.correlationKey !== expectedCorrelationKey(currentStep, state) ||
    request.reason !== currentStep.reason ||
    request.outputKey !== currentStep.outputKey ||
    !isDeepStrictEqual(request.eventSchema, currentStep.eventSchema)
  ) {
    invalid("pendingExternalEvent does not match the current wait_external_event step");
  }
  assertJsonSafe(request, "pendingExternalEvent");
}

function assertToolCallRequest(value: unknown): asserts value is ToolCallRequest {
  const request = requireRecord(value, "pendingToolApproval.pendingExec.pendingToolCall");
  requireString(request.toolCallId, "pendingToolApproval.pendingExec.pendingToolCall.toolCallId");
  requireString(request.toolName, "pendingToolApproval.pendingExec.pendingToolCall.toolName");
  requireRecord(request.arguments, "pendingToolApproval.pendingExec.pendingToolCall.arguments");
  requireString(request.actorId, "pendingToolApproval.pendingExec.pendingToolCall.actorId");
  requireString(request.actorRunId, "pendingToolApproval.pendingExec.pendingToolCall.actorRunId");
  requireString(request.stepKey, "pendingToolApproval.pendingExec.pendingToolCall.stepKey");
  assertJsonSafe(request, "pendingToolApproval.pendingExec.pendingToolCall");
}

function assertApprovalRequest(value: unknown): asserts value is ApprovalRequest {
  const request = requireRecord(value, "pendingToolApproval.approvalRequest");
  assertExactKeys(
    request,
    [
      "approvalRequestId", "toolCallId", "toolName", "stage", "riskLevel",
      "reason", "policy", "status", "createdAt",
    ],
    [
      "approvalRequestId", "toolCallId", "toolName", "stage", "riskLevel",
      "reason", "proposedArguments", "rawResult", "suggestedApproverRole",
      "policy", "status", "createdAt",
    ],
    "pendingToolApproval.approvalRequest"
  );
  requireString(request.approvalRequestId, "pendingToolApproval.approvalRequest.approvalRequestId");
  requireString(request.toolCallId, "pendingToolApproval.approvalRequest.toolCallId");
  requireString(request.toolName, "pendingToolApproval.approvalRequest.toolName");
  if (request.stage !== "before_call") {
    invalid("pendingToolApproval.approvalRequest.stage must be before_call");
  }
  if (!["low", "medium", "high", "critical"].includes(String(request.riskLevel))) {
    invalid(`pendingToolApproval.approvalRequest.riskLevel is unsupported: ${String(request.riskLevel)}`);
  }
  requireString(request.reason, "pendingToolApproval.approvalRequest.reason", true);
  if (request.proposedArguments !== undefined) {
    requireRecord(request.proposedArguments, "pendingToolApproval.approvalRequest.proposedArguments");
  }
  if (request.rawResult !== undefined) {
    requireRecord(request.rawResult, "pendingToolApproval.approvalRequest.rawResult");
  }
  optionalString(request.suggestedApproverRole, "pendingToolApproval.approvalRequest.suggestedApproverRole");
  const policy = requireRecord(
    request.policy,
    "pendingToolApproval.approvalRequest.policy"
  );
  assertExactKeys(
    policy,
    ["requiredWhen", "allowModifyArguments", "allowReject", "allowComment"],
    ["requiredWhen", "allowModifyArguments", "allowReject", "allowComment"],
    "pendingToolApproval.approvalRequest.policy"
  );
  const conditions = requireArray(
    policy.requiredWhen,
    "pendingToolApproval.approvalRequest.policy.requiredWhen"
  );
  conditions.forEach((candidate, index) => {
    const condition = requireRecord(
      candidate,
      `pendingToolApproval.approvalRequest.policy.requiredWhen[${index}]`
    );
    assertExactKeys(
      condition,
      ["field", "operator", "value"],
      ["field", "operator", "value"],
      `pendingToolApproval.approvalRequest.policy.requiredWhen[${index}]`
    );
    requireString(
      condition.field,
      `pendingToolApproval.approvalRequest.policy.requiredWhen[${index}].field`
    );
    if (!["<=", ">=", "<", ">", "==", "!="].includes(String(condition.operator))) {
      invalid(`pendingToolApproval.approvalRequest.policy.requiredWhen[${index}].operator is unsupported`);
    }
    if (!["string", "number", "boolean"].includes(typeof condition.value)) {
      invalid(`pendingToolApproval.approvalRequest.policy.requiredWhen[${index}].value is unsupported`);
    }
  });
  for (const field of ["allowModifyArguments", "allowReject", "allowComment"] as const) {
    if (typeof policy[field] !== "boolean") {
      invalid(`pendingToolApproval.approvalRequest.policy.${field} must be boolean`);
    }
  }
  if (request.status !== "pending") {
    invalid("pendingToolApproval.approvalRequest.status must be pending");
  }
  requireString(request.createdAt, "pendingToolApproval.approvalRequest.createdAt");
  assertJsonSafe(request, "pendingToolApproval.approvalRequest");
}

function assertToolApproval(
  value: unknown,
  currentStep: SkillStep,
  actorRunId: string,
  actorId: string,
  state: SkillState,
  context: ActorContext
): asserts value is PendingToolApprovalSnapshot {
  const pending = requireRecord(value, "pendingToolApproval");
  assertApprovalRequest(pending.approvalRequest);
  const approvalRequest = pending.approvalRequest;
  const pendingExec = requireRecord(pending.pendingExec, "pendingToolApproval.pendingExec");
  const execRunId = requireString(pendingExec.actorRunId, "pendingToolApproval.pendingExec.actorRunId");
  const execActorId = requireString(pendingExec.actorId, "pendingToolApproval.pendingExec.actorId");
  const pendingToolName = requireString(
    pendingExec.pendingToolName,
    "pendingToolApproval.pendingExec.pendingToolName"
  );
  optionalString(pendingExec.originatingStepKey, "pendingToolApproval.pendingExec.originatingStepKey");
  optionalString(pendingExec.originatingOutputKey, "pendingToolApproval.pendingExec.originatingOutputKey");
  optionalString(pendingExec.decisionOutputKey, "pendingToolApproval.pendingExec.decisionOutputKey");
  assertToolCallRequest(pendingExec.pendingToolCall);
  const call = pendingExec.pendingToolCall;

  const expected = buildCanonicalPendingToolDescriptor(currentStep, state, context);
  if (!expected) invalid("tool approval current step does not produce a Tool call");
  if (
    execRunId !== actorRunId ||
    call.actorRunId !== actorRunId ||
    execActorId !== actorId ||
    call.actorId !== actorId
  ) {
    invalid("pendingToolApproval run or actor identity mismatch");
  }
  if (pendingExec.originatingStepKey !== expected.originatingStepKey ||
    call.stepKey !== expected.originatingStepKey) {
    invalid("pendingToolApproval step reference does not match the current step");
  }
  if (
    pendingToolName !== call.toolName ||
    approvalRequest.toolName !== call.toolName ||
    approvalRequest.toolCallId !== call.toolCallId
  ) {
    invalid("pendingToolApproval tool references are inconsistent");
  }
  if (
    call.toolName !== expected.toolName ||
    !isDeepStrictEqual(call.arguments, expected.arguments) ||
    pendingExec.originatingOutputKey !== expected.originatingOutputKey ||
    pendingExec.decisionOutputKey !== expected.decisionOutputKey
  ) {
    invalid("pendingToolApproval differs from the canonical current-step Tool call");
  }
  if (
    approvalRequest.proposedArguments === undefined ||
    !isDeepStrictEqual(approvalRequest.proposedArguments, call.arguments)
  ) {
    invalid("pendingToolApproval proposedArguments must match pendingToolCall.arguments");
  }
  if (
    !context.permissions.allowedTools.includes(call.toolName) ||
    context.permissions.deniedTools.includes(call.toolName)
  ) {
    invalid(`pendingToolApproval Tool ${call.toolName} is not allowed by its context`);
  }
  const available = context.availableTools.filter((tool) => tool.name === call.toolName);
  if (available.length !== 1) {
    invalid(`pendingToolApproval Tool ${call.toolName} must have one available Tool definition`);
  }
  if (approvalRequest.riskLevel !== available[0].riskLevel) {
    invalid("pendingToolApproval riskLevel differs from its available Tool definition");
  }
  assertJsonSafe(pendingExec, "pendingToolApproval.pendingExec");
}

function assertExactlyOnePendingPayload(snapshot: JsonRecord, pendingKind: PendingRunKind): void {
  const fieldsByKind: Record<PendingRunKind, typeof PENDING_FIELDS[number]> = {
    human_input: "pendingHumanInput",
    skill_approval: "pendingSkillApproval",
    tool_approval: "pendingToolApproval",
    external_event: "pendingExternalEvent",
  };
  const expectedField = fieldsByKind[pendingKind];
  const present = PENDING_FIELDS.filter((field) => snapshot[field] !== undefined);
  if (present.length !== 1 || present[0] !== expectedField) {
    invalid(`${pendingKind} must contain only ${expectedField}`);
  }
}

export function assertPendingRunSnapshot(value: unknown): asserts value is PendingRunSnapshot {
  const snapshot = requireRecord(value, "snapshot");
  if (snapshot.schemaVersion !== PENDING_RUN_SNAPSHOT_SCHEMA_VERSION) {
    invalid(`unsupported schemaVersion ${String(snapshot.schemaVersion)}`);
  }
  requireString(snapshot.savedAt, "savedAt");
  const actorRunId = requireString(snapshot.actorRunId, "actorRunId");
  const actorId = requireString(snapshot.actorId, "actorId");
  const skillId = requireString(snapshot.skillId, "skillId");

  if (!["waiting_human_input", "waiting_approval", "waiting_external_event"].includes(String(snapshot.status))) {
    invalid(`unsupported status ${String(snapshot.status)}`);
  }
  if (!["human_input", "skill_approval", "tool_approval", "external_event"].includes(String(snapshot.pendingKind))) {
    invalid(`unsupported pendingKind ${String(snapshot.pendingKind)}`);
  }
  const status = snapshot.status as PendingRunStatus;
  const pendingKind = snapshot.pendingKind as PendingRunKind;
  if (status !== STATUS_BY_KIND[pendingKind]) {
    invalid(`${pendingKind} must use ${STATUS_BY_KIND[pendingKind]} status`);
  }
  assertExactlyOnePendingPayload(snapshot, pendingKind);

  assertSkill(snapshot.skill);
  const skill = snapshot.skill;
  assertSkillState(snapshot.state, skill);
  const state = snapshot.state;
  assertActorContext(snapshot.context, actorId);
  if (skill.skillId !== skillId || state.skillId !== skillId) {
    invalid("skillId must match skill.skillId and state.skillId");
  }
  if (state.status !== status) {
    invalid("state.status must match status");
  }

  const currentStep = skill.steps[state.currentStepIndex];
  switch (pendingKind) {
    case "human_input":
      assertHumanInputRequest(snapshot.pendingHumanInput, currentStep);
      break;
    case "skill_approval":
      assertSkillApprovalRequest(snapshot.pendingSkillApproval, currentStep);
      break;
    case "tool_approval":
      assertToolApproval(
        snapshot.pendingToolApproval,
        currentStep,
        actorRunId,
        actorId,
        state,
        snapshot.context
      );
      break;
    case "external_event":
      assertExternalEventRequest(snapshot.pendingExternalEvent, currentStep, state);
      break;
  }
  assertJsonSafe(snapshot, "snapshot");
}

export function assertToolObservations(value: unknown): asserts value is ToolObservation[] {
  const observations = requireArray(value, "state.observations");
  observations.forEach(assertToolObservation);
}
