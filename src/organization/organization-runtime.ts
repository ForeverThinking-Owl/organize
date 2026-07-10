import type {
  ActorContinueEvent,
  ActorRunOutput,
  ActorRunStatus,
  ActorRuntime,
} from "../runtime/actor-runtime";
import { actorRuntime } from "../runtime/actor-runtime";
import { memoryService } from "../memory/memory-service";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION } from "../memory/memory-snapshot";
import { assertPendingRunSnapshot } from "../runtime/json-pending-run-store";
import { traceLogger } from "../trace/trace-logger";
import { TRACE_SNAPSHOT_SCHEMA_VERSION } from "../trace/trace-snapshot";
import { ActorRegistry, type RegisterActorInput, type RegisteredActor } from "./actor-registry";
import { ActorInbox, type ActorMessage, type ActorMessageType } from "./actor-message";
import {
  createOrganization,
  type CreateOrganizationInput,
  type Organization,
} from "./organization";
import { OrganizationError } from "./organization-error";
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
import { OrganizationTrace, type OrganizationTraceEvent } from "./organization-trace";

interface OrganizationState {
  organization: Organization;
  actors: ActorRegistry;
  tasks: TaskManager;
  inbox: ActorInbox;
  trace: OrganizationTrace;
}

export interface TaskExecutionResult {
  task: OrganizationTask;
  output: ActorRunOutput;
}

function clone<T>(value: T): T {
  return structuredClone(value);
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
    const trace = new OrganizationTrace(organization.organizationId);
    const state: OrganizationState = {
      organization,
      actors: new ActorRegistry(organization.organizationId),
      tasks: new TaskManager(organization.organizationId),
      inbox: new ActorInbox(organization.organizationId),
      trace,
    };
    this.organizations.set(organization.organizationId, state);
    trace.record("organization_created", {}, { name: organization.name });
    return clone(organization);
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
        const authorities = approver.actorConfig.approval_judgment.can_approve ?? [];
        if (!toolName || !authorities.some((authority) => authority.tool_name === toolName)) {
          throw new OrganizationError(
            "permission_denied",
            `Actor ${approver.actorId} cannot approve tool ${toolName ?? "unknown"}`
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

    state.tasks.beginContinue(input.taskId);
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
    if (output.trace.events.some((event) => event.type === "actor_run_resumed")) {
      state.trace.record("task_resumed", {
        actorId: waitingTask.assignedTo,
        taskId: input.taskId,
        actorRunId: waitingTask.actorRunId,
      }, { eventType: authorizedEvent.type });
    }
    return { task: this.applyRunOutput(state, input.taskId, output), output };
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
    const organizationId = snapshot.organization.organizationId;
    if (this.organizations.has(organizationId)) {
      throw new OrganizationError(
        "already_exists",
        `Organization ${organizationId} is already loaded; clear it before restore`
      );
    }
    if (!snapshot.runtimeRecovery) {
      throw new OrganizationError("invalid_input", "Organization snapshot lacks runtime recovery state");
    }

    const actorIds = new Set(snapshot.actors.map((actor) => actor.actorId));
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
    const actorsById = new Map(snapshot.actors.map((actor) => [actor.actorId, actor]));
    const taskIds = new Set(snapshot.tasks.map((task) => task.taskId));
    if (taskIds.size !== snapshot.tasks.length) {
      throw new OrganizationError("invalid_input", "Task snapshot contains duplicate task ids");
    }
    for (const task of snapshot.tasks) {
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
      if (
        task.organizationId !== organizationId ||
        !actorIds.has(task.createdBy) ||
        task.status === "running" ||
        hasPartialAssignment ||
        (requiresAssignment && !hasAssignment) ||
        (requiresRun && !task.actorRunId) ||
        (forbidsRun && Boolean(task.actorRunId)) ||
        (task.status === "created" && hasAssignment) ||
        (hasAssignment && (
          !assignedActor ||
          !assignedActor.skills[task.skillId!] ||
          !assignedActor.capabilities.includes("task:execute")
        ))
      ) {
        throw new OrganizationError("invalid_input", `Task ${task.taskId} has invalid state or actor references`);
      }
      assertJsonSafe(task.input, `task ${task.taskId}.input`);
      assertJsonSafe(task.runtimeContext ?? {}, `task ${task.taskId}.runtimeContext`);
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
      assertPendingRunSnapshot(pending);
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
    }
    if (
      traceRunIds.size !== tasksByRunId.size ||
      [...tasksByRunId.keys()].some((actorRunId) => !traceRunIds.has(actorRunId))
    ) {
      throw new OrganizationError("invalid_input", "Actor traces do not match task run bindings");
    }

    const memory = snapshot.runtimeRecovery.memory;
    if (
      memory.schemaVersion !== MEMORY_SNAPSHOT_SCHEMA_VERSION ||
      memory.memories.some((item) => item.organizationId !== organizationId) ||
      memory.candidates.some((item) => item.organizationId !== organizationId)
    ) {
      throw new OrganizationError("cross_organization", "Memory snapshot crosses organizations");
    }

    const messageIds = new Set(snapshot.messages.map((message) => message.messageId));
    if (messageIds.size !== snapshot.messages.length) {
      throw new OrganizationError("invalid_input", "Message snapshot contains duplicate message ids");
    }
    const sequences = new Set<number>();
    const eventIds = new Set<string>();
    for (const [index, event] of snapshot.trace.entries()) {
      if (
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
    };
    state.actors.restore(snapshot.actors);
    state.tasks.restore(snapshot.tasks, snapshot.taskQueue);
    state.inbox.restore(snapshot.messages, snapshot.inboxOrder);
    state.trace.restore(snapshot.trace);

    for (const actorRunId of tasksByRunId.keys()) {
      if (this.runtime.dumpPendingRun(actorRunId) || traceLogger.getTrace(actorRunId)) {
        throw new OrganizationError("already_exists", `Actor run ${actorRunId} already exists`);
      }
    }

    const previousMemory = memoryService.dumpOrganizationSnapshot(organizationId);
    const previousTrace = traceLogger.dumpRunsSnapshot(tasksByRunId.keys());
    const restoredRunIds: string[] = [];
    try {
      memoryService.restoreOrganizationSnapshot(organizationId, memory);
      traceLogger.restoreRunsSnapshot(runtimeTrace);
      for (const pending of snapshot.runtimeRecovery.pendingRuns) {
        restoredRunIds.push(pending.actorRunId);
        this.runtime.restorePendingRun(pending);
      }
    } catch (error) {
      restoredRunIds.forEach((actorRunId) => this.runtime.clearRun(actorRunId));
      traceLogger.clearRuns(tasksByRunId.keys());
      traceLogger.restoreRunsSnapshot(previousTrace);
      memoryService.restoreOrganizationSnapshot(organizationId, previousMemory);
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
    return this.restoreSnapshot(snapshot);
  }

  clearOrganization(organizationId: string): void {
    const state = this.organizations.get(organizationId);
    if (!state) return;
    const actorRunIds: string[] = [];
    for (const task of state.tasks.list()) {
      if (task.actorRunId) this.runtime.clearRun(task.actorRunId);
      if (task.actorRunId) actorRunIds.push(task.actorRunId);
    }
    traceLogger.clearRuns(actorRunIds);
    memoryService.clearOrganization(organizationId);
    this.organizations.delete(organizationId);
  }
}

export const organizationRuntime = new OrganizationRuntime();
