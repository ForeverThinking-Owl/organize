import { isDeepStrictEqual } from "node:util";
import type { ApprovalCondition } from "../core/types/actor";
import type {
  ActorContinueEvent,
  ActorRunOutput,
  ActorRunStatus,
  ActorRuntime,
} from "../runtime/actor-runtime";
import { actorRuntime } from "../runtime/actor-runtime";
import { memoryService } from "../memory/memory-service";
import { assertMemorySnapshot } from "../memory/json-memory-store";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION } from "../memory/memory-snapshot";
import { assertPendingRunSnapshot } from "../runtime/json-pending-run-store";
import type { PendingRunSnapshot } from "../runtime/pending-run-snapshot";
import { assertPendingMemoryTraceConsistency } from "../runtime/pending-memory-validation";
import { assertPendingRunTraceConsistency } from "../runtime/pending-trace-validation";
import { assertPendingStateTraceConsistency } from "../runtime/pending-state-trace-validation";
import {
  buildActorApprovalJudgment,
  buildActorPermissions,
  buildActorProfile,
  buildAvailableTools,
} from "../runtime/actor-context-builder";
import { buildInitialSkillContext, parseSkillConfig } from "../runtime/runtime-skill-config";
import { buildToolCallRequest } from "../runtime/skill-runtime";
import { buildCanonicalToolApprovalMetadata } from "../approvals/tool-approval-policy";
import { toolGateway } from "../tools/tool-gateway";
import { traceLogger } from "../trace/trace-logger";
import { assertTraceSnapshot, TRACE_SNAPSHOT_SCHEMA_VERSION } from "../trace/trace-snapshot";
import { ActorRegistry, type RegisterActorInput, type RegisteredActor } from "./actor-registry";
import { ActorInbox, type ActorMessage, type ActorMessageType } from "./actor-message";
import {
  assertOrganization,
  createOrganization,
  type CreateOrganizationInput,
  type Organization,
} from "./organization";
import { OrganizationError } from "./organization-error";
import {
  beginOrganizationOperation,
  claimOrganizationOwnership,
  endOrganizationOperation,
  hasActiveOrganizationOperation,
  hasOrganizationOwner,
  isOrganizationOwner,
  releaseOrganizationOwnership,
} from "./organization-operation-lease";
import { assertJsonSafe, type OrganizationCapability } from "./organization-permission";
import {
  ORGANIZATION_SNAPSHOT_SCHEMA_VERSION,
  assertOrganizationSnapshot,
  type OrganizationSnapshot,
} from "./organization-snapshot";
import type { OrganizationStore } from "./organization-store";
import {
  TaskManager,
  type CreateTaskInput,
  type OrganizationTask,
  type OrganizationTaskStatus,
  type WaitingTaskStatus,
} from "./task";
import {
  ORGANIZATION_TRACE_EVENT_TYPES,
  OrganizationTrace,
  type OrganizationTraceEvent,
} from "./organization-trace";

interface OrganizationState {
  organization: Organization;
  actors: ActorRegistry;
  tasks: TaskManager;
  inbox: ActorInbox;
  trace: OrganizationTrace;
  activeOperations: number;
}

export interface TaskExecutionResult {
  task: OrganizationTask;
  output: ActorRunOutput;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function jsonComparable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertRecoveryEqual(actual: unknown, expected: unknown, message: string): void {
  if (!isDeepStrictEqual(jsonComparable(actual), jsonComparable(expected))) {
    throw new OrganizationError("invalid_input", message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function approvalConditionMatches(
  condition: ApprovalCondition,
  arguments_: Record<string, unknown>
): boolean {
  const actual = arguments_[condition.field];
  switch (condition.operator) {
    case "==": return actual === condition.value;
    case "!=": return actual !== condition.value;
    case ">": return (actual as number) > (condition.value as number);
    case ">=": return (actual as number) >= (condition.value as number);
    case "<": return (actual as number) < (condition.value as number);
    case "<=": return (actual as number) <= (condition.value as number);
  }
}

function assertRecoveryTaskShape(task: OrganizationTask): void {
  if (
    typeof task.organizationId !== "string" ||
    typeof task.taskId !== "string" ||
    typeof task.title !== "string" ||
    typeof task.createdBy !== "string" ||
    typeof task.createdAt !== "string" ||
    typeof task.updatedAt !== "string" ||
    (task.description !== undefined && typeof task.description !== "string") ||
    (task.assignedTo !== undefined && typeof task.assignedTo !== "string") ||
    (task.skillId !== undefined && typeof task.skillId !== "string") ||
    (task.actorRunId !== undefined && typeof task.actorRunId !== "string") ||
    (task.failureReason !== undefined && typeof task.failureReason !== "string")
  ) {
    throw new OrganizationError("invalid_input", `Task ${String(task.taskId)} has invalid fields`);
  }
  if (!isRecord(task.input)) {
    throw new OrganizationError("invalid_input", `Task ${task.taskId} input must be an object`);
  }
  if (Object.keys(task.input).some((key) => key !== "text" && key !== "payload")) {
    throw new OrganizationError("invalid_input", `Task ${task.taskId} input has unsupported fields`);
  }
  if (task.input.text !== undefined && typeof task.input.text !== "string") {
    throw new OrganizationError("invalid_input", `Task ${task.taskId} input.text must be a string`);
  }
  if (task.input.payload !== undefined && !isRecord(task.input.payload)) {
    throw new OrganizationError("invalid_input", `Task ${task.taskId} input.payload must be an object`);
  }
  if (task.runtimeContext !== undefined && !isRecord(task.runtimeContext)) {
    throw new OrganizationError("invalid_input", `Task ${task.taskId} runtimeContext must be an object`);
  }
  if (task.result !== undefined && task.result !== null && !isRecord(task.result)) {
    throw new OrganizationError("invalid_input", `Task ${task.taskId} result must be an object or null`);
  }
  assertJsonSafe(task.input, `task ${task.taskId}.input`);
  assertJsonSafe(task.runtimeContext ?? {}, `task ${task.taskId}.runtimeContext`);
  if (task.result !== undefined) assertJsonSafe(task.result, `task ${task.taskId}.result`);
}

function validatePendingAgainstOrganization(
  pending: PendingRunSnapshot,
  task: OrganizationTask,
  actor: RegisteredActor,
  organizationId: string
): void {
  if (actor.status !== "active") {
    throw new OrganizationError("invalid_input", `Pending run ${pending.actorRunId} uses an inactive actor`);
  }
  const skillConfig = actor.skills[pending.skillId];
  if (!skillConfig || !actor.actorConfig.permissions.allowed_skills?.includes(pending.skillId)) {
    throw new OrganizationError("invalid_input", `Pending run ${pending.actorRunId} uses an unregistered skill`);
  }

  let canonicalSkill;
  try {
    canonicalSkill = parseSkillConfig(skillConfig, actor.actorId);
  } catch (error) {
    throw new OrganizationError(
      "invalid_input",
      `Pending run ${pending.actorRunId} has invalid canonical skill config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  assertRecoveryEqual(
    pending.skill,
    canonicalSkill,
    `Pending run ${pending.actorRunId} skill differs from the Actor Registry`
  );

  const effectiveRuntimeContext = {
    ...(task.runtimeContext ?? {}),
    organization_id: organizationId,
    organization_task_id: task.taskId,
  };
  assertRecoveryEqual(
    pending.context.actor,
    buildActorProfile(actor.actorConfig),
    `Pending run ${pending.actorRunId} Actor profile differs from the Actor Registry`
  );
  assertRecoveryEqual(
    pending.context.input,
    task.input,
    `Pending run ${pending.actorRunId} input differs from its task`
  );
  assertRecoveryEqual(
    pending.context.runtimeContext,
    effectiveRuntimeContext,
    `Pending run ${pending.actorRunId} runtime context differs from its task`
  );
  assertRecoveryEqual(
    pending.context.permissions,
    buildActorPermissions(actor.actorConfig),
    `Pending run ${pending.actorRunId} permissions differ from the Actor Registry`
  );
  assertRecoveryEqual(
    pending.context.approvalJudgment,
    buildActorApprovalJudgment(actor.actorConfig),
    `Pending run ${pending.actorRunId} approval policy differs from the Actor Registry`
  );
  const availableTools = buildAvailableTools(
    actor.actorConfig.permissions.allowed_tools,
    actor.actorConfig.permissions.denied_tools
  );
  const restoredAvailableTools = [...pending.context.availableTools]
    .sort((left, right) => left.name.localeCompare(right.name));
  const canonicalAvailableTools = [...availableTools]
    .sort((left, right) => left.name.localeCompare(right.name));
  assertRecoveryEqual(
    restoredAvailableTools,
    canonicalAvailableTools,
    `Pending run ${pending.actorRunId} available tools differ from the current Tool Registry`
  );
  assertRecoveryEqual(
    pending.state.context,
    buildInitialSkillContext(task.input, effectiveRuntimeContext),
    `Pending run ${pending.actorRunId} Skill context differs from its task`
  );

  if (pending.pendingKind === "tool_approval") {
    const toolApproval = pending.pendingToolApproval!;
    const pendingExec = toolApproval.pendingExec;
    const toolName = pendingExec.pendingToolName;
    const canonicalTool = availableTools.find((tool) => tool.name === toolName);
    const toolDefinition = toolGateway.getDefinition(toolName);
    if (
      !actor.actorConfig.permissions.allowed_tools.includes(toolName) ||
      actor.actorConfig.permissions.denied_tools.includes(toolName) ||
      !canonicalTool ||
      !toolDefinition ||
      toolApproval.approvalRequest.riskLevel !== canonicalTool.riskLevel
    ) {
      throw new OrganizationError(
        "invalid_input",
        `Pending run ${pending.actorRunId} cannot restore mismatched tool governance for ${toolName}`
      );
    }
    const expectedApproval = buildCanonicalToolApprovalMetadata(
      toolDefinition,
      pendingExec.pendingToolCall.arguments
    );
    if (!expectedApproval) {
      throw new OrganizationError(
        "invalid_input",
        `Pending run ${pending.actorRunId} Tool call no longer requires approval`
      );
    }
    assertRecoveryEqual(
      {
        stage: toolApproval.approvalRequest.stage,
        riskLevel: toolApproval.approvalRequest.riskLevel,
        reason: toolApproval.approvalRequest.reason,
        proposedArguments: toolApproval.approvalRequest.proposedArguments,
        suggestedApproverRole: toolApproval.approvalRequest.suggestedApproverRole,
        policy: toolApproval.approvalRequest.policy,
      },
      expectedApproval,
      `Pending run ${pending.actorRunId} approval metadata differs from the current Tool policy`
    );
    const currentStep = canonicalSkill.steps[pending.state.currentStepIndex];
    if (currentStep.type === "tool_call") {
      const expectedCall = buildToolCallRequest(
        currentStep,
        pending.state,
        pending.actorId,
        pending.actorRunId
      );
      assertRecoveryEqual(
        pendingExec.pendingToolCall.arguments,
        expectedCall.arguments,
        `Pending run ${pending.actorRunId} tool arguments differ from its Skill step`
      );
    }
  }
}

function waitingTaskStatus(status: ActorRunStatus): WaitingTaskStatus | null {
  switch (status) {
    case "waiting_approval":
      return "waiting_approval";
    case "waiting_human_input":
      return "waiting_human_input";
    case "waiting_external_event":
      return "waiting_external_event";
    default:
      return null;
  }
}

export class OrganizationRuntime {
  private organizations = new Map<string, OrganizationState>();
  private readonly ownershipToken = Symbol("OrganizationRuntime owner");

  constructor(private readonly runtime: ActorRuntime = actorRuntime) {}

  private requireState(organizationId: string): OrganizationState {
    const state = this.organizations.get(organizationId);
    if (!state) {
      throw new OrganizationError("not_found", `Organization ${organizationId} was not found`);
    }
    return state;
  }

  private requireCapability(
    state: OrganizationState,
    actorId: string,
    capability: OrganizationCapability
  ): RegisteredActor {
    try {
      return state.actors.requireCapability(actorId, capability);
    } catch (error) {
      state.trace.record("permission_denied", { actorId }, {
        capability,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  createOrganization(input: CreateOrganizationInput): Organization {
    const organization = createOrganization(input);
    if (this.organizations.has(organization.organizationId)) {
      throw new OrganizationError(
        "already_exists",
        `Organization ${organization.organizationId} already exists`
      );
    }
    if (!claimOrganizationOwnership(organization.organizationId, this.ownershipToken)) {
      throw new OrganizationError(
        "already_exists",
        `Organization ${organization.organizationId} is already loaded by another runtime`
      );
    }
    const trace = new OrganizationTrace(organization.organizationId);
    try {
      const state: OrganizationState = {
        organization,
        actors: new ActorRegistry(organization.organizationId),
        tasks: new TaskManager(organization.organizationId),
        inbox: new ActorInbox(organization.organizationId),
        trace,
        activeOperations: 0,
      };
      this.organizations.set(organization.organizationId, state);
      trace.record("organization_created", {}, { name: organization.name });
      return clone(organization);
    } catch (error) {
      this.organizations.delete(organization.organizationId);
      releaseOrganizationOwnership(organization.organizationId, this.ownershipToken);
      throw error;
    }
  }

  getOrganization(organizationId: string): Organization {
    return clone(this.requireState(organizationId).organization);
  }

  registerActor(
    organizationId: string,
    input: RegisterActorInput,
    requestedByActorId?: string
  ): RegisteredActor {
    const state = this.requireState(organizationId);
    if (state.actors.list().length === 0) {
      if (!input.capabilities.includes("organization:manage")) {
        throw new OrganizationError(
          "permission_denied",
          "The bootstrap actor must hold organization:manage"
        );
      }
    } else {
      if (!requestedByActorId) {
        throw new OrganizationError(
          "permission_denied",
          "Registering an additional actor requires an organization manager"
        );
      }
      this.requireCapability(state, requestedByActorId, "organization:manage");
    }
    const unitId = input.actorConfig.unit_id;
    if (unitId && !state.organization.units.some((unit) => unit.unitId === unitId)) {
      throw new OrganizationError("invalid_input", `Unit ${unitId} does not exist`);
    }
    const actor = state.actors.register(input);
    state.organization = {
      ...state.organization,
      actorIds: [...state.organization.actorIds, actor.actorId],
      updatedAt: new Date().toISOString(),
    };
    state.trace.record("actor_registered", { actorId: actor.actorId }, {
      capabilities: actor.capabilities,
      skillIds: Object.keys(actor.skills),
    });
    return actor;
  }

  listActors(organizationId: string): RegisteredActor[] {
    return this.requireState(organizationId).actors.list();
  }

  createTask(input: {
    organizationId: string;
    requestedByActorId: string;
  } & Omit<CreateTaskInput, "createdBy">): OrganizationTask {
    const state = this.requireState(input.organizationId);
    this.requireCapability(state, input.requestedByActorId, "task:create");
    const task = state.tasks.create({
      title: input.title,
      description: input.description,
      createdBy: input.requestedByActorId,
      input: input.input,
      runtimeContext: input.runtimeContext,
    });
    state.trace.record("task_created", { actorId: input.requestedByActorId, taskId: task.taskId });
    return task;
  }

  assignTask(input: {
    organizationId: string;
    requestedByActorId: string;
    taskId: string;
    actorId: string;
    skillId: string;
  }): OrganizationTask {
    const state = this.requireState(input.organizationId);
    this.requireCapability(state, input.requestedByActorId, "task:assign");
    this.requireCapability(state, input.actorId, "task:execute");
    state.actors.getSkill(input.actorId, input.skillId);
    const task = state.tasks.assign(input.taskId, input.actorId, input.skillId);
    state.trace.record("task_assigned", { actorId: input.actorId, taskId: input.taskId }, {
      requestedByActorId: input.requestedByActorId,
      skillId: input.skillId,
    });
    return task;
  }

  enqueueTask(input: {
    organizationId: string;
    requestedByActorId: string;
    taskId: string;
  }): OrganizationTask {
    const state = this.requireState(input.organizationId);
    this.requireCapability(state, input.requestedByActorId, "task:assign");
    const task = state.tasks.enqueue(input.taskId);
    state.trace.record("task_queued", { actorId: task.assignedTo, taskId: task.taskId });
    return task;
  }

  private applyRunOutput(
    state: OrganizationState,
    taskId: string,
    output: ActorRunOutput
  ): OrganizationTask {
    const waitingStatus = waitingTaskStatus(output.status);
    if (waitingStatus) {
      const task = state.tasks.suspend(taskId, waitingStatus, output.actorRunId);
      state.trace.record("task_suspended", {
        actorId: task.assignedTo,
        taskId,
        actorRunId: output.actorRunId,
      }, { status: waitingStatus });
      return task;
    }
    if (output.status === "completed") {
      const task = state.tasks.complete(taskId, output.actorRunId, output.result);
      state.trace.record("task_completed", {
        actorId: task.assignedTo,
        taskId,
        actorRunId: output.actorRunId,
      });
      return task;
    }

    const pending = this.runtime.dumpPendingRun(output.actorRunId);
    if (pending) {
      const task = state.tasks.suspend(taskId, pending.status, output.actorRunId);
      state.trace.record("task_suspended", {
        actorId: task.assignedTo,
        taskId,
        actorRunId: output.actorRunId,
      }, { status: pending.status, runtimeReturnedError: true });
      return task;
    }

    const task = state.tasks.fail(taskId, output.actorRunId, "ActorRuntime returned error");
    state.trace.record("task_failed", {
      actorId: task.assignedTo,
      taskId,
      actorRunId: output.actorRunId,
    });
    return task;
  }

  async dispatchNext(input: {
    organizationId: string;
    actorId?: string;
  }): Promise<TaskExecutionResult | null> {
    const state = this.requireState(input.organizationId);
    const task = state.tasks.claimNext(input.actorId);
    if (!task) return null;
    const actorId = task.assignedTo!;
    const skillId = task.skillId!;

    state.activeOperations += 1;
    beginOrganizationOperation(input.organizationId);
    try {
      const actor = this.requireCapability(state, actorId, "task:execute");
      const skillConfig = state.actors.getSkill(actorId, skillId);
      state.trace.record("task_run_started", {
        actorId,
        taskId: task.taskId,
      }, { skillId });
      const output = await this.runtime.run({
        actorConfig: actor.actorConfig,
        skillConfig,
        input: task.input,
        runtimeContext: {
          ...(task.runtimeContext ?? {}),
          organization_id: input.organizationId,
          organization_task_id: task.taskId,
        },
        runtimeOptions: { organizationOwnerToken: this.ownershipToken },
      });
      state.tasks.bindRun(task.taskId, output.actorRunId);
      return { task: this.applyRunOutput(state, task.taskId, output), output };
    } catch (error) {
      const failed = state.tasks.fail(
        task.taskId,
        undefined,
        error instanceof Error ? error.message : String(error)
      );
      state.trace.record("task_failed", { actorId, taskId: task.taskId }, {
        reason: failed.failureReason,
      });
      throw error;
    } finally {
      state.activeOperations -= 1;
      endOrganizationOperation(input.organizationId);
    }
  }

  async continueTask(input: {
    organizationId: string;
    requestedByActorId: string;
    taskId: string;
    event: ActorContinueEvent;
  }): Promise<TaskExecutionResult> {
    const state = this.requireState(input.organizationId);
    const waitingTask = state.tasks.get(input.taskId);
    if (!waitingTask.assignedTo || !waitingTask.actorRunId) {
      throw new OrganizationError("invalid_state", `Task ${input.taskId} has no active Actor run`);
    }

    const pending = this.runtime.dumpPendingRun(waitingTask.actorRunId);
    if (!pending) {
      throw new OrganizationError("invalid_state", `Task ${input.taskId} has no pending Actor run`);
    }

    const eventMatchesPending =
      (pending.pendingKind === "human_input" && input.event.type === "human_input_response") ||
      (["skill_approval", "tool_approval"].includes(pending.pendingKind) &&
        input.event.type === "approval_decision") ||
      (pending.pendingKind === "external_event" && input.event.type === "external_event_received");
    if (!eventMatchesPending) {
      throw new OrganizationError(
        "invalid_input",
        `Event ${input.event.type} cannot continue pending kind ${pending.pendingKind}`
      );
    }

    const authorizedEvent = clone(input.event);
    if (authorizedEvent.type === "human_input_response") {
      if (input.requestedByActorId === waitingTask.assignedTo) {
        this.requireCapability(state, input.requestedByActorId, "task:execute");
      } else {
        this.requireCapability(state, input.requestedByActorId, "task:assign");
      }
      if (
        authorizedEvent.response.respondedBy &&
        authorizedEvent.response.respondedBy !== input.requestedByActorId
      ) {
        state.trace.record("permission_denied", { actorId: input.requestedByActorId, taskId: input.taskId }, {
          reason: "human input identity does not match authenticated actor",
        });
        throw new OrganizationError("permission_denied", "Human input identity mismatch");
      }
      authorizedEvent.response.respondedBy = input.requestedByActorId;
    }
    if (authorizedEvent.type === "approval_decision") {
      const approver = this.requireCapability(state, input.requestedByActorId, "approval:decide");
      if (input.requestedByActorId === waitingTask.assignedTo) {
        throw new OrganizationError(
          "permission_denied",
          `Actor ${input.requestedByActorId} cannot approve its own task run`
        );
      }
      if (
        authorizedEvent.decision.decidedBy &&
        authorizedEvent.decision.decidedBy !== input.requestedByActorId
      ) {
        throw new OrganizationError("permission_denied", "Approval identity mismatch");
      }
      if (pending.pendingKind === "tool_approval") {
        const toolName = pending.pendingToolApproval?.approvalRequest.toolName;
        const proposedArguments =
          pending.pendingToolApproval?.approvalRequest.proposedArguments ?? {};
        const effectiveArguments =
          authorizedEvent.decision.decision === "approve_with_modified_arguments" &&
          isRecord(authorizedEvent.decision.modifiedArguments)
            ? authorizedEvent.decision.modifiedArguments
            : proposedArguments;
        const authorities = (approver.actorConfig.approval_judgment.can_approve ?? [])
          .filter((authority) => authority.tool_name === toolName);
        if (!toolName || authorities.length === 0) {
          throw new OrganizationError(
            "permission_denied",
            `Actor ${approver.actorId} cannot approve tool ${toolName ?? "unknown"}`
          );
        }
        const mustEscalate = authorities.some((authority) =>
          (authority.must_escalate_when ?? []).some((condition) =>
            approvalConditionMatches(condition, effectiveArguments)
          )
        );
        if (mustEscalate && authorizedEvent.decision.decision !== "escalate") {
          throw new OrganizationError(
            "permission_denied",
            `Tool ${toolName} approval must be escalated for the proposed arguments`
          );
        }
        const withinAuthority = authorities.some((authority) =>
          (authority.conditions ?? []).every((condition) =>
            approvalConditionMatches(condition, effectiveArguments)
          )
        );
        if (!mustEscalate && !withinAuthority) {
          throw new OrganizationError(
            "permission_denied",
            `Actor ${approver.actorId} approval conditions do not cover tool ${toolName}`
          );
        }
      }
      authorizedEvent.decision.decidedBy = input.requestedByActorId;
    }
    if (authorizedEvent.type === "external_event_received") {
      this.requireCapability(state, input.requestedByActorId, "event:receive");
      if (
        authorizedEvent.event.receivedBy &&
        authorizedEvent.event.receivedBy !== input.requestedByActorId
      ) {
        throw new OrganizationError("permission_denied", "External event identity mismatch");
      }
      authorizedEvent.event.receivedBy = input.requestedByActorId;
    }

    state.activeOperations += 1;
    beginOrganizationOperation(input.organizationId);
    try {
      state.tasks.beginContinue(input.taskId);
      const actorTraceEventCountBefore =
        traceLogger.getTrace(waitingTask.actorRunId)?.events.length ?? 0;
      let output: ActorRunOutput;
      try {
        output = await this.runtime.continue(waitingTask.actorRunId, authorizedEvent);
      } catch (error) {
        if (this.runtime.dumpPendingRun(waitingTask.actorRunId)) {
          state.tasks.suspend(
            input.taskId,
            waitingTask.status as WaitingTaskStatus,
            waitingTask.actorRunId
          );
        } else {
          state.tasks.fail(
            input.taskId,
            waitingTask.actorRunId,
            error instanceof Error ? error.message : String(error)
          );
        }
        throw error;
      }
      const actorTraceEventsThisAttempt =
        traceLogger.getTrace(waitingTask.actorRunId)?.events.slice(actorTraceEventCountBefore) ?? [];
      if (actorTraceEventsThisAttempt.some((event) => event.eventType === "actor_run_resumed")) {
        state.trace.record("task_resumed", {
          actorId: waitingTask.assignedTo,
          taskId: input.taskId,
          actorRunId: waitingTask.actorRunId,
        }, { eventType: authorizedEvent.type });
      }
      return { task: this.applyRunOutput(state, input.taskId, output), output };
    } finally {
      state.activeOperations -= 1;
      endOrganizationOperation(input.organizationId);
    }
  }

  getTask(organizationId: string, taskId: string): OrganizationTask {
    return this.requireState(organizationId).tasks.get(taskId);
  }

  listTasks(organizationId: string): OrganizationTask[] {
    return this.requireState(organizationId).tasks.list();
  }

  sendMessage(input: {
    organizationId: string;
    fromActorId: string;
    toActorId: string;
    type: ActorMessageType;
    payload: unknown;
  }): ActorMessage {
    const state = this.requireState(input.organizationId);
    this.requireCapability(state, input.fromActorId, "message:send");
    this.requireCapability(state, input.toActorId, "message:receive");
    const message = state.inbox.send({
      fromActorId: input.fromActorId,
      toActorId: input.toActorId,
      type: input.type,
      payload: input.payload,
    });
    state.trace.record("message_enqueued", {
      actorId: input.fromActorId,
      messageId: message.messageId,
    }, { toActorId: input.toActorId, type: input.type });
    return message;
  }

  receiveNextMessage(input: { organizationId: string; actorId: string }): ActorMessage | null {
    const state = this.requireState(input.organizationId);
    this.requireCapability(state, input.actorId, "message:receive");
    const message = state.inbox.deliverNext(input.actorId);
    if (message) {
      state.trace.record("message_delivered", {
        actorId: input.actorId,
        messageId: message.messageId,
      }, { fromActorId: message.fromActorId, type: message.type });
    }
    return message;
  }

  acknowledgeMessage(input: {
    organizationId: string;
    actorId: string;
    messageId: string;
  }): ActorMessage {
    const state = this.requireState(input.organizationId);
    this.requireCapability(state, input.actorId, "message:receive");
    const message = state.inbox.acknowledge(input.actorId, input.messageId);
    state.trace.record("message_acknowledged", {
      actorId: input.actorId,
      messageId: input.messageId,
    });
    return message;
  }

  listInbox(input: {
    organizationId: string;
    requestedByActorId: string;
    actorId?: string;
  }): ActorMessage[] {
    const state = this.requireState(input.organizationId);
    const actorId = input.actorId ?? input.requestedByActorId;
    if (actorId === input.requestedByActorId) {
      this.requireCapability(state, input.requestedByActorId, "message:receive");
    } else {
      this.requireCapability(state, input.requestedByActorId, "organization:manage");
    }
    return state.inbox.listInbox(actorId);
  }

  getTrace(organizationId: string): OrganizationTraceEvent[] {
    return this.requireState(organizationId).trace.getEvents();
  }

  dumpSnapshot(input: {
    organizationId: string;
    requestedByActorId: string;
  }): OrganizationSnapshot {
    const state = this.requireState(input.organizationId);
    this.requireCapability(state, input.requestedByActorId, "organization:snapshot");
    const tasks = state.tasks.list();
    if (tasks.some((task) => task.status === "running")) {
      throw new OrganizationError("invalid_state", "Cannot snapshot an organization with running tasks");
    }

    const waitingTasks = tasks.filter((task) => task.status.startsWith("waiting_"));
    const pendingRuns = waitingTasks.map((task) => {
      const pending = task.actorRunId ? this.runtime.dumpPendingRun(task.actorRunId) : null;
      if (!pending) {
        throw new OrganizationError(
          "invalid_state",
          `Waiting task ${task.taskId} has no restorable pending run`
        );
      }
      return pending;
    });
    const actorRunIds = tasks.flatMap((task) => task.actorRunId ? [task.actorRunId] : []);
    state.trace.record("snapshot_created", { actorId: input.requestedByActorId }, {
      taskCount: tasks.length,
      pendingRunCount: pendingRuns.length,
    });

    return clone({
      schemaVersion: ORGANIZATION_SNAPSHOT_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      organization: state.organization,
      actors: state.actors.list(),
      tasks,
      taskQueue: state.tasks.listQueue(),
      messages: state.inbox.listAll(),
      inboxOrder: state.inbox.dumpInboxOrder(),
      trace: state.trace.getEvents(),
      runtimeRecovery: {
        pendingRuns,
        trace: traceLogger.dumpRunsSnapshot(actorRunIds),
        memory: memoryService.dumpOrganizationSnapshot(input.organizationId),
      },
    } satisfies OrganizationSnapshot);
  }

  restoreSnapshot(snapshot: OrganizationSnapshot): Organization {
    assertOrganizationSnapshot(snapshot);
    assertOrganization(snapshot.organization);
    const organizationId = snapshot.organization.organizationId;
    if (this.organizations.has(organizationId)) {
      throw new OrganizationError(
        "already_exists",
        `Organization ${organizationId} is already loaded; clear it before restore`
      );
    }
    if (
      hasOrganizationOwner(organizationId) &&
      !isOrganizationOwner(organizationId, this.ownershipToken)
    ) {
      throw new OrganizationError(
        "already_exists",
        `Organization ${organizationId} is already loaded by another runtime`
      );
    }
    if (!snapshot.runtimeRecovery) {
      throw new OrganizationError("invalid_input", "Organization snapshot lacks runtime recovery state");
    }

    const actorIds = new Set(snapshot.actors.map((actor) => actor.actorId));
    const unitIds = new Set(snapshot.organization.units.map((unit) => unit.unitId));
    if (
      actorIds.size !== snapshot.actors.length ||
      new Set(snapshot.organization.actorIds).size !== snapshot.organization.actorIds.length ||
      actorIds.size !== snapshot.organization.actorIds.length ||
      snapshot.organization.actorIds.some((actorId) => !actorIds.has(actorId)) ||
      snapshot.actors.some((actor) =>
        actor.organizationId !== organizationId ||
        actor.actorConfig.organization_id !== organizationId ||
        actor.actorConfig.actor_id !== actor.actorId
      )
    ) {
      throw new OrganizationError("cross_organization", "Actor snapshot crosses organizations");
    }
    if (snapshot.actors.some((actor) =>
      Boolean(actor.actorConfig.unit_id && !unitIds.has(actor.actorConfig.unit_id))
    )) {
      throw new OrganizationError("invalid_input", "Actor snapshot references a missing unit");
    }
    const actorsById = new Map(snapshot.actors.map((actor) => [actor.actorId, actor]));
    const taskIds = new Set(snapshot.tasks.map((task) => task.taskId));
    if (taskIds.size !== snapshot.tasks.length) {
      throw new OrganizationError("invalid_input", "Task snapshot contains duplicate task ids");
    }
    for (const task of snapshot.tasks) {
      assertRecoveryTaskShape(task);
      const validStatus = [
        "created", "assigned", "queued", "running", "waiting_approval",
        "waiting_human_input", "waiting_external_event", "completed", "failed", "cancelled",
      ].includes(task.status);
      const assignedActor = task.assignedTo ? actorsById.get(task.assignedTo) : undefined;
      const hasAssignment = Boolean(task.assignedTo && task.skillId);
      const hasPartialAssignment = Boolean(task.assignedTo) !== Boolean(task.skillId);
      const requiresAssignment = [
        "assigned",
        "queued",
        "waiting_approval",
        "waiting_human_input",
        "waiting_external_event",
        "completed",
        "failed",
      ].includes(task.status);
      const requiresRun = task.status.startsWith("waiting_") || task.status === "completed";
      const forbidsRun = ["created", "assigned", "queued", "cancelled"].includes(task.status);
      const hasResult = Object.prototype.hasOwnProperty.call(task, "result");
      const hasFailure = Object.prototype.hasOwnProperty.call(task, "failureReason");
      if (
        !validStatus ||
        task.organizationId !== organizationId ||
        !actorIds.has(task.createdBy) ||
        task.status === "running" ||
        hasPartialAssignment ||
        (requiresAssignment && !hasAssignment) ||
        (requiresRun && !task.actorRunId) ||
        (forbidsRun && Boolean(task.actorRunId)) ||
        (task.status === "completed" && (!hasResult || hasFailure)) ||
        (task.status === "failed" && (!hasFailure || hasResult || !task.failureReason)) ||
        (!["completed", "failed"].includes(task.status) && (hasResult || hasFailure)) ||
        (task.status === "created" && hasAssignment) ||
        (hasAssignment && (
          !assignedActor ||
          !assignedActor.skills[task.skillId!] ||
          !assignedActor.capabilities.includes("task:execute")
        ))
      ) {
        throw new OrganizationError("invalid_input", `Task ${task.taskId} has invalid state or actor references`);
      }
    }
    if (snapshot.messages.some((message) =>
      message.organizationId !== organizationId ||
      !actorIds.has(message.fromActorId) ||
      !actorIds.has(message.toActorId)
    )) {
      throw new OrganizationError("invalid_input", "Message snapshot has invalid actor references");
    }

    const tasksByRunId = new Map<string, OrganizationTask>();
    for (const task of snapshot.tasks) {
      if (!task.actorRunId) continue;
      if (tasksByRunId.has(task.actorRunId)) {
        throw new OrganizationError("invalid_input", `Actor run ${task.actorRunId} is bound to multiple tasks`);
      }
      tasksByRunId.set(task.actorRunId, task);
    }

    const pendingRunIds = new Set<string>();
    for (const pending of snapshot.runtimeRecovery.pendingRuns) {
      try {
        assertPendingRunSnapshot(pending);
      } catch (error) {
        throw new OrganizationError(
          "invalid_input",
          error instanceof Error ? error.message : String(error)
        );
      }
      if (pendingRunIds.has(pending.actorRunId)) {
        throw new OrganizationError("invalid_input", `Duplicate pending run ${pending.actorRunId}`);
      }
      pendingRunIds.add(pending.actorRunId);
      const task = tasksByRunId.get(pending.actorRunId);
      if (
        !task ||
        !task.status.startsWith("waiting_") ||
        task.status !== pending.status ||
        task.assignedTo !== pending.actorId ||
        task.skillId !== pending.skillId ||
        pending.context.actor.organizationId !== organizationId ||
        pending.context.actor.actorId !== pending.actorId ||
        pending.context.runtimeContext.organization_id !== organizationId ||
        pending.context.runtimeContext.organization_task_id !== task.taskId
      ) {
        throw new OrganizationError("invalid_input", `Pending run ${pending.actorRunId} does not match its task`);
      }
      const actor = actorsById.get(pending.actorId);
      if (!actor) {
        throw new OrganizationError("invalid_input", `Pending run ${pending.actorRunId} has no registered actor`);
      }
      validatePendingAgainstOrganization(pending, task, actor, organizationId);
    }
    const waitingTasks = snapshot.tasks.filter((task) => task.status.startsWith("waiting_"));
    if (
      pendingRunIds.size !== waitingTasks.length ||
      waitingTasks.some((task) => !task.actorRunId || !pendingRunIds.has(task.actorRunId))
    ) {
      throw new OrganizationError("invalid_input", "Pending runs do not match waiting tasks");
    }

    const runtimeTrace = snapshot.runtimeRecovery.trace;
    if (runtimeTrace.schemaVersion !== TRACE_SNAPSHOT_SCHEMA_VERSION) {
      throw new OrganizationError("invalid_input", "Invalid Actor Trace snapshot schema");
    }
    try {
      assertTraceSnapshot(runtimeTrace);
    } catch (error) {
      throw new OrganizationError(
        "invalid_input",
        error instanceof Error ? error.message : String(error)
      );
    }
    const traceRunIds = new Set<string>();
    for (const trace of runtimeTrace.traces) {
      if (traceRunIds.has(trace.actorRunId)) {
        throw new OrganizationError("invalid_input", `Duplicate Actor trace ${trace.actorRunId}`);
      }
      traceRunIds.add(trace.actorRunId);
      const task = tasksByRunId.get(trace.actorRunId);
      if (
        !task ||
        trace.actorId !== task.assignedTo ||
        trace.skillId !== task.skillId ||
        (task.status.startsWith("waiting_") && trace.status !== task.status) ||
        (task.status === "completed" && trace.status !== "completed") ||
        (task.status === "failed" && trace.status !== "error")
      ) {
        throw new OrganizationError("invalid_input", `Actor trace ${trace.actorRunId} does not match its task`);
      }
      if (task.status === "completed") {
        const finalOutputs = trace.events.filter((event) => event.eventType === "final_output");
        if (
          finalOutputs.length > 1 ||
          (task.result !== null && task.result !== undefined && finalOutputs.length !== 1)
        ) {
          throw new OrganizationError(
            "invalid_input",
            `Completed task ${task.taskId} has inconsistent final output Trace`
          );
        }
        if (finalOutputs.length === 1) {
          assertRecoveryEqual(
            task.result,
            finalOutputs[0].data,
            `Completed task ${task.taskId} result differs from Actor Trace`
          );
        }
      }
    }
    if (
      traceRunIds.size !== tasksByRunId.size ||
      [...tasksByRunId.keys()].some((actorRunId) => !traceRunIds.has(actorRunId))
    ) {
      throw new OrganizationError("invalid_input", "Actor traces do not match task run bindings");
    }

    const memory = snapshot.runtimeRecovery.memory;
    try {
      assertMemorySnapshot(memory);
    } catch (error) {
      throw new OrganizationError(
        "invalid_input",
        error instanceof Error ? error.message : String(error)
      );
    }
    if (
      memory.schemaVersion !== MEMORY_SNAPSHOT_SCHEMA_VERSION ||
      memory.memories.some((item) => item.organizationId !== organizationId) ||
      memory.candidates.some((item) => item.organizationId !== organizationId)
    ) {
      throw new OrganizationError("cross_organization", "Memory snapshot crosses organizations");
    }
    try {
      const tracesByRunId = new Map(
        runtimeTrace.traces.map((trace) => [trace.actorRunId, trace])
      );
      for (const pending of snapshot.runtimeRecovery.pendingRuns) {
        const trace = tracesByRunId.get(pending.actorRunId);
        if (!trace) {
          throw new Error(`Actor trace ${pending.actorRunId} is missing`);
        }
        assertPendingRunTraceConsistency(pending, trace);
        assertPendingMemoryTraceConsistency(pending, trace, memory);
        assertPendingStateTraceConsistency(pending, trace);
      }
    } catch (error) {
      throw new OrganizationError(
        "invalid_input",
        error instanceof Error ? error.message : String(error)
      );
    }

    const messageIds = new Set(snapshot.messages.map((message) => message.messageId));
    if (messageIds.size !== snapshot.messages.length) {
      throw new OrganizationError("invalid_input", "Message snapshot contains duplicate message ids");
    }
    const sequences = new Set<number>();
    const eventIds = new Set<string>();
    const traceEventTypes = new Set<string>(ORGANIZATION_TRACE_EVENT_TYPES);
    for (const [index, event] of snapshot.trace.entries()) {
      if (
        typeof event.eventId !== "string" ||
        event.eventId.length === 0 ||
        !traceEventTypes.has(event.eventType) ||
        typeof event.timestamp !== "string" ||
        event.timestamp.length === 0 ||
        !isRecord(event.data) ||
        event.organizationId !== organizationId ||
        event.sequence !== index + 1 ||
        sequences.has(event.sequence) ||
        eventIds.has(event.eventId) ||
        Boolean(event.actorId && !actorIds.has(event.actorId)) ||
        Boolean(event.taskId && !taskIds.has(event.taskId)) ||
        Boolean(event.messageId && !messageIds.has(event.messageId)) ||
        Boolean(event.actorRunId && !tasksByRunId.has(event.actorRunId))
      ) {
        throw new OrganizationError("invalid_input", "Organization Trace has invalid references or sequence");
      }
      sequences.add(event.sequence);
      eventIds.add(event.eventId);
      assertJsonSafe(event.data, `organization trace event ${event.eventId}.data`);
    }

    const state: OrganizationState = {
      organization: clone(snapshot.organization),
      actors: new ActorRegistry(organizationId),
      tasks: new TaskManager(organizationId),
      inbox: new ActorInbox(organizationId),
      trace: new OrganizationTrace(organizationId),
      activeOperations: 0,
    };
    state.actors.restore(snapshot.actors);
    state.tasks.restore(snapshot.tasks, snapshot.taskQueue);
    state.inbox.restore(snapshot.messages, snapshot.inboxOrder);
    state.trace.restore(snapshot.trace);

    for (const actorRunId of tasksByRunId.keys()) {
      if (this.runtime.hasRun(actorRunId) || traceLogger.getTrace(actorRunId)) {
        throw new OrganizationError("already_exists", `Actor run ${actorRunId} already exists`);
      }
    }

    if (!claimOrganizationOwnership(organizationId, this.ownershipToken)) {
      throw new OrganizationError(
        "already_exists",
        `Organization ${organizationId} is already loaded by another runtime`
      );
    }
    const previousMemory = memoryService.dumpOrganizationSnapshot(organizationId);
    const previousTrace = traceLogger.dumpRunsSnapshot(tasksByRunId.keys());
    const restoredRunIds: string[] = [];
    try {
      memoryService.restoreOrganizationSnapshot(organizationId, memory);
      traceLogger.restoreRunsSnapshot(runtimeTrace);
      for (const pending of snapshot.runtimeRecovery.pendingRuns) {
        restoredRunIds.push(pending.actorRunId);
        this.runtime.restorePendingRun(pending, {
          organizationOwnerToken: this.ownershipToken,
        });
      }
    } catch (error) {
      restoredRunIds.forEach((actorRunId) => this.runtime.clearRun(actorRunId));
      traceLogger.clearRuns(tasksByRunId.keys());
      traceLogger.restoreRunsSnapshot(previousTrace);
      memoryService.restoreOrganizationSnapshot(organizationId, previousMemory);
      releaseOrganizationOwnership(organizationId, this.ownershipToken);
      throw error;
    }

    this.organizations.set(organizationId, state);
    state.trace.record("snapshot_restored", {}, {
      taskCount: snapshot.tasks.length,
      pendingRunCount: pendingRunIds.size,
    });
    return clone(state.organization);
  }

  async saveSnapshot(input: {
    organizationId: string;
    requestedByActorId: string;
    store: OrganizationStore;
  }): Promise<OrganizationSnapshot> {
    const snapshot = this.dumpSnapshot(input);
    await input.store.save(snapshot);
    return snapshot;
  }

  async loadSnapshot(organizationId: string, store: OrganizationStore): Promise<Organization> {
    const snapshot = await store.load(organizationId);
    if (!snapshot) {
      throw new OrganizationError("not_found", `No snapshot for organization ${organizationId}`);
    }
    if (snapshot.organization.organizationId !== organizationId) {
      throw new OrganizationError(
        "cross_organization",
        `Store returned organization ${snapshot.organization.organizationId} for ${organizationId}`
      );
    }
    return this.restoreSnapshot(snapshot);
  }

  clearOrganization(organizationId: string): void {
    const state = this.organizations.get(organizationId);
    if (!state) return;
    if (!isOrganizationOwner(organizationId, this.ownershipToken)) {
      throw new OrganizationError(
        "invalid_state",
        `Organization ${organizationId} is owned by another runtime`
      );
    }
    if (
      state.activeOperations > 0 ||
      hasActiveOrganizationOperation(organizationId) ||
      state.tasks.list().some((task) => task.status === "running")
    ) {
      throw new OrganizationError(
        "invalid_state",
        `Organization ${organizationId} has active task operations and cannot be cleared`
      );
    }
    const actorRunIds: string[] = [];
    for (const task of state.tasks.list()) {
      if (task.actorRunId) this.runtime.clearRun(task.actorRunId);
      if (task.actorRunId) actorRunIds.push(task.actorRunId);
    }
    traceLogger.clearRuns(actorRunIds);
    memoryService.clearOrganization(organizationId);
    this.organizations.delete(organizationId);
    releaseOrganizationOwnership(organizationId, this.ownershipToken);
  }
}

export const organizationRuntime = new OrganizationRuntime();
