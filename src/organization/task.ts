import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ActorRunInput } from "../runtime/actor-runtime";
import { OrganizationError } from "./organization-error";
import { assertJsonSafe } from "./organization-permission";

export const MAX_HANDOFF_DEPTH = 1 as const;

export type OrganizationTaskStatus =
  | "created"
  | "assigned"
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_human_input"
  | "waiting_external_event"
  | "delegated"
  | "completed"
  | "failed"
  | "cancelled";

export type WaitingTaskStatus = Extract<OrganizationTaskStatus, `waiting_${string}`>;

export interface OrganizationTask {
  organizationId: string;
  taskId: string;
  title: string;
  description?: string;
  createdBy: string;
  assignedTo?: string;
  skillId?: string;
  input: ActorRunInput["input"];
  runtimeContext?: Record<string, unknown>;
  rootTaskId: string;
  parentTaskId?: string;
  handoffDepth: number;
  incomingHandoffRequestId?: string;
  outgoingHandoffRequestId?: string;
  status: OrganizationTaskStatus;
  actorRunId?: string;
  result?: Record<string, unknown> | null;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  createdBy: string;
  input: ActorRunInput["input"];
  runtimeContext?: Record<string, unknown>;
}

export interface DelegateTaskInput {
  handoffRequestId: string;
  targetActorId: string;
  targetSkillId: string;
  input: ActorRunInput["input"];
  runtimeContext?: Record<string, unknown>;
  title?: string;
  description?: string;
}

export interface DelegatedTaskPair {
  sourceTask: OrganizationTask;
  childTask: OrganizationTask;
}

const WAITING = new Set<OrganizationTaskStatus>([
  "waiting_approval",
  "waiting_human_input",
  "waiting_external_event",
]);
const TASK_STATUSES = new Set<OrganizationTaskStatus>([
  "created", "assigned", "queued", "running", "waiting_approval",
  "waiting_human_input", "waiting_external_event", "delegated", "completed", "failed", "cancelled",
]);

const TASK_FIELDS = new Set([
  "organizationId", "taskId", "title", "description", "createdBy", "assignedTo", "skillId",
  "input", "runtimeContext", "rootTaskId", "parentTaskId", "handoffDepth",
  "incomingHandoffRequestId", "outgoingHandoffRequestId", "status", "actorRunId", "result",
  "failureReason", "createdAt", "updatedAt",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OrganizationError("invalid_input", `${path} must be a non-empty string`);
  }
}

function assertTaskRunInput(input: unknown, path: string): asserts input is ActorRunInput["input"] {
  if (!isPlainRecord(input)) {
    throw new OrganizationError("invalid_input", `${path} must be a plain object`);
  }
  if (Object.keys(input).some((field) => field !== "text" && field !== "payload")) {
    throw new OrganizationError("invalid_input", `${path} has unsupported fields`);
  }
  if (input.text !== undefined && typeof input.text !== "string") {
    throw new OrganizationError("invalid_input", `${path}.text must be a string`);
  }
  if (input.payload !== undefined && !isPlainRecord(input.payload)) {
    throw new OrganizationError("invalid_input", `${path}.payload must be a plain object`);
  }
  assertJsonSafe(input, path);
}

export function assertCreateTaskInput(input: CreateTaskInput): void {
  if (!isPlainRecord(input)) {
    throw new OrganizationError("invalid_input", "task must be a plain object");
  }
  const allowedFields = new Set(["title", "description", "createdBy", "input", "runtimeContext"]);
  if (Object.keys(input).some((field) => !allowedFields.has(field))) {
    throw new OrganizationError("invalid_input", "task has unsupported fields");
  }
  if (typeof input.title !== "string" || input.title.length === 0) {
    throw new OrganizationError("invalid_input", "task.title must be a non-empty string");
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new OrganizationError("invalid_input", "task.description must be a string");
  }
  if (typeof input.createdBy !== "string" || input.createdBy.length === 0) {
    throw new OrganizationError("invalid_input", "task.createdBy must be a non-empty string");
  }
  assertTaskRunInput(input.input, "task.input");
  if (input.runtimeContext !== undefined && !isPlainRecord(input.runtimeContext)) {
    throw new OrganizationError("invalid_input", "task.runtimeContext must be a plain object");
  }
  if (input.runtimeContext !== undefined) {
    assertJsonSafe(input.runtimeContext, "task.runtimeContext");
  }
}

export function assertOrganizationTask(
  value: unknown,
  expectedOrganizationId?: string
): asserts value is OrganizationTask {
  if (!isPlainRecord(value)) {
    throw new OrganizationError("invalid_input", "Task must be a plain object");
  }
  if (Object.keys(value).some((field) => !TASK_FIELDS.has(field))) {
    throw new OrganizationError("invalid_input", "Task has unsupported fields");
  }
  for (const field of [
    "organizationId", "taskId", "title", "createdBy", "rootTaskId", "createdAt", "updatedAt",
  ] as const) {
    assertNonEmptyString(value[field], `task.${field}`);
  }
  if (expectedOrganizationId !== undefined && value.organizationId !== expectedOrganizationId) {
    throw new OrganizationError("cross_organization", "Task snapshot crosses organizations");
  }
  for (const field of [
    "description", "assignedTo", "skillId", "parentTaskId", "incomingHandoffRequestId",
    "outgoingHandoffRequestId", "actorRunId", "failureReason",
  ] as const) {
    if (value[field] !== undefined) assertNonEmptyString(value[field], `task.${field}`);
  }
  if (!TASK_STATUSES.has(value.status as OrganizationTaskStatus)) {
    throw new OrganizationError("invalid_input", `Task ${value.taskId} has invalid status`);
  }
  if (!Number.isSafeInteger(value.handoffDepth) || (value.handoffDepth as number) < 0) {
    throw new OrganizationError("invalid_input", `Task ${value.taskId} has invalid handoffDepth`);
  }
  if ((value.handoffDepth as number) > MAX_HANDOFF_DEPTH) {
    throw new OrganizationError("invalid_input", `Task ${value.taskId} exceeds the handoff depth limit`);
  }
  assertTaskRunInput(value.input, `task ${value.taskId}.input`);
  if (value.runtimeContext !== undefined) {
    if (!isPlainRecord(value.runtimeContext)) {
      throw new OrganizationError("invalid_input", `Task ${value.taskId} runtimeContext must be an object`);
    }
    assertJsonSafe(value.runtimeContext, `task ${value.taskId}.runtimeContext`);
  }
  if (value.result !== undefined && value.result !== null) {
    if (!isPlainRecord(value.result)) {
      throw new OrganizationError("invalid_input", `Task ${value.taskId} result must be an object or null`);
    }
    assertJsonSafe(value.result, `task ${value.taskId}.result`);
  }
  const isRoot = value.handoffDepth === 0;
  if (isRoot) {
    if (
      value.rootTaskId !== value.taskId ||
      value.parentTaskId !== undefined ||
      value.incomingHandoffRequestId !== undefined
    ) {
      throw new OrganizationError("invalid_input", `Root task ${value.taskId} has invalid lineage`);
    }
  } else if (
    value.rootTaskId === value.taskId ||
    value.parentTaskId === undefined ||
    value.incomingHandoffRequestId === undefined
  ) {
    throw new OrganizationError("invalid_input", `Child task ${value.taskId} has invalid lineage`);
  }
  if ((value.status === "delegated") !== (value.outgoingHandoffRequestId !== undefined)) {
    throw new OrganizationError("invalid_input", `Task ${value.taskId} has inconsistent delegation state`);
  }
  if (value.status === "delegated" && (value.handoffDepth as number) >= MAX_HANDOFF_DEPTH) {
    throw new OrganizationError("invalid_input", `Task ${value.taskId} cannot delegate beyond the depth limit`);
  }
  const hasAssignment = value.assignedTo !== undefined && value.skillId !== undefined;
  const hasPartialAssignment =
    (value.assignedTo !== undefined) !== (value.skillId !== undefined);
  const requiresAssignment = [
    "assigned", "queued", "running", "waiting_approval", "waiting_human_input",
    "waiting_external_event", "delegated", "completed", "failed",
  ].includes(value.status as string);
  const requiresRun = [
    "waiting_approval", "waiting_human_input", "waiting_external_event", "delegated", "completed",
  ].includes(value.status as string);
  const forbidsRun = ["created", "assigned", "queued", "cancelled"].includes(
    value.status as string
  );
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasFailure = Object.prototype.hasOwnProperty.call(value, "failureReason");
  if (
    hasPartialAssignment ||
    (requiresAssignment && !hasAssignment) ||
    (value.status === "created" && hasAssignment) ||
    (requiresRun && value.actorRunId === undefined) ||
    (forbidsRun && value.actorRunId !== undefined) ||
    (value.status === "completed" && (!hasResult || hasFailure)) ||
    (value.status === "failed" && (!hasFailure || hasResult)) ||
    (!["completed", "failed"].includes(value.status as string) && (hasResult || hasFailure))
  ) {
    throw new OrganizationError(
      "invalid_input",
      `Task ${value.taskId} has inconsistent lifecycle fields`
    );
  }
}

export function cloneOrganizationTask(task: OrganizationTask): OrganizationTask {
  return clone(task);
}

export class TaskManager {
  private tasks = new Map<string, OrganizationTask>();
  private queue: string[] = [];

  constructor(public readonly organizationId: string) {}

  private requireInternal(taskId: string): OrganizationTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new OrganizationError("not_found", `Task ${taskId} was not found`);
    return task;
  }

  private replace(task: OrganizationTask, patch: Partial<OrganizationTask>): OrganizationTask {
    const next = { ...task, ...patch, updatedAt: new Date().toISOString() };
    this.tasks.set(task.taskId, next);
    return clone(next);
  }

  create(input: CreateTaskInput): OrganizationTask {
    assertCreateTaskInput(input);
    const now = new Date().toISOString();
    const task: OrganizationTask = {
      organizationId: this.organizationId,
      taskId: `task_${randomUUID()}`,
      title: input.title,
      description: input.description,
      createdBy: input.createdBy,
      input: clone(input.input),
      runtimeContext: clone(input.runtimeContext ?? {}),
      rootTaskId: "",
      handoffDepth: 0,
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
    task.rootTaskId = task.taskId;
    this.tasks.set(task.taskId, task);
    return clone(task);
  }

  assign(taskId: string, actorId: string, skillId: string): OrganizationTask {
    const task = this.requireInternal(taskId);
    if (task.status !== "created") {
      throw new OrganizationError("invalid_state", `Task ${taskId} cannot be assigned from ${task.status}`);
    }
    return this.replace(task, { status: "assigned", assignedTo: actorId, skillId });
  }

  enqueue(taskId: string): OrganizationTask {
    const task = this.requireInternal(taskId);
    if (task.status !== "assigned") {
      throw new OrganizationError("invalid_state", `Task ${taskId} cannot be queued from ${task.status}`);
    }
    if (!this.queue.includes(taskId)) this.queue.push(taskId);
    return this.replace(task, { status: "queued" });
  }

  claimNext(actorId?: string): OrganizationTask | null {
    const index = this.queue.findIndex((taskId) => {
      const task = this.tasks.get(taskId);
      return Boolean(task?.status === "queued" && (!actorId || task.assignedTo === actorId));
    });
    if (index < 0) return null;
    const [taskId] = this.queue.splice(index, 1);
    const task = this.requireInternal(taskId);
    return this.replace(task, { status: "running" });
  }

  bindRun(taskId: string, actorRunId: string): OrganizationTask {
    const task = this.requireInternal(taskId);
    if (task.status !== "running") {
      throw new OrganizationError("invalid_state", `Task ${taskId} is not running`);
    }
    return this.replace(task, { actorRunId });
  }

  delegate(taskId: string, input: DelegateTaskInput): DelegatedTaskPair {
    const task = this.requireInternal(taskId);
    assertNonEmptyString(input.handoffRequestId, "handoffRequestId");
    assertNonEmptyString(input.targetActorId, "targetActorId");
    assertNonEmptyString(input.targetSkillId, "targetSkillId");
    assertTaskRunInput(input.input, "handoff.input");
    if (input.runtimeContext !== undefined) {
      if (!isPlainRecord(input.runtimeContext)) {
        throw new OrganizationError("invalid_input", "handoff.runtimeContext must be a plain object");
      }
      assertJsonSafe(input.runtimeContext, "handoff.runtimeContext");
    }
    if (input.title !== undefined && (typeof input.title !== "string" || input.title.length === 0)) {
      throw new OrganizationError("invalid_input", "handoff.title must be a non-empty string");
    }
    if (input.description !== undefined && typeof input.description !== "string") {
      throw new OrganizationError("invalid_input", "handoff.description must be a string");
    }

    if (task.status === "delegated" && task.outgoingHandoffRequestId === input.handoffRequestId) {
      const child = Array.from(this.tasks.values()).find(
        (candidate) => candidate.incomingHandoffRequestId === input.handoffRequestId
      );
      if (
        !child ||
        child.parentTaskId !== task.taskId ||
        child.assignedTo !== input.targetActorId ||
        child.skillId !== input.targetSkillId ||
        !isDeepStrictEqual(child.input, input.input) ||
        !isDeepStrictEqual(child.runtimeContext ?? {}, input.runtimeContext ?? {})
      ) {
        throw new OrganizationError("invalid_state", `Task ${taskId} has an inconsistent delegation`);
      }
      return { sourceTask: clone(task), childTask: clone(child) };
    }
    if (task.status !== "running") {
      throw new OrganizationError("invalid_state", `Task ${taskId} cannot delegate from ${task.status}`);
    }
    if (task.handoffDepth >= MAX_HANDOFF_DEPTH || task.outgoingHandoffRequestId !== undefined) {
      throw new OrganizationError("invalid_state", `Task ${taskId} cannot delegate beyond depth ${MAX_HANDOFF_DEPTH}`);
    }
    if (Array.from(this.tasks.values()).some(
      (candidate) => candidate.incomingHandoffRequestId === input.handoffRequestId
    )) {
      throw new OrganizationError("already_exists", `Handoff ${input.handoffRequestId} already has a child task`);
    }

    const now = new Date().toISOString();
    const childTaskId = `task_${randomUUID()}`;
    const sourceTask: OrganizationTask = {
      ...task,
      status: "delegated",
      outgoingHandoffRequestId: input.handoffRequestId,
      updatedAt: now,
    };
    const childTask: OrganizationTask = {
      organizationId: this.organizationId,
      taskId: childTaskId,
      title: input.title ?? task.title,
      description: input.description ?? task.description,
      createdBy: task.assignedTo ?? task.createdBy,
      assignedTo: input.targetActorId,
      skillId: input.targetSkillId,
      input: clone(input.input),
      runtimeContext: clone(input.runtimeContext ?? {}),
      rootTaskId: task.rootTaskId,
      parentTaskId: task.taskId,
      handoffDepth: task.handoffDepth + 1,
      incomingHandoffRequestId: input.handoffRequestId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, sourceTask);
    this.tasks.set(childTask.taskId, childTask);
    this.queue.push(childTask.taskId);
    return { sourceTask: clone(sourceTask), childTask: clone(childTask) };
  }

  beginContinue(taskId: string): OrganizationTask {
    const task = this.requireInternal(taskId);
    if (!WAITING.has(task.status)) {
      throw new OrganizationError("invalid_state", `Task ${taskId} is not waiting`);
    }
    return this.replace(task, { status: "running" });
  }

  suspend(taskId: string, status: WaitingTaskStatus, actorRunId: string): OrganizationTask {
    const task = this.requireInternal(taskId);
    if (task.status !== "running" && !WAITING.has(task.status)) {
      throw new OrganizationError("invalid_state", `Task ${taskId} cannot suspend from ${task.status}`);
    }
    return this.replace(task, { status, actorRunId });
  }

  complete(taskId: string, actorRunId: string, result: Record<string, unknown> | null): OrganizationTask {
    const task = this.requireInternal(taskId);
    if (task.status !== "running") {
      throw new OrganizationError("invalid_state", `Task ${taskId} cannot complete from ${task.status}`);
    }
    assertJsonSafe(result, "task.result");
    return this.replace(task, { status: "completed", actorRunId, result: clone(result) });
  }

  fail(taskId: string, actorRunId: string | undefined, reason: string): OrganizationTask {
    const task = this.requireInternal(taskId);
    if (["delegated", "completed", "cancelled"].includes(task.status)) {
      throw new OrganizationError("invalid_state", `Task ${taskId} cannot fail from ${task.status}`);
    }
    return this.replace(task, { status: "failed", actorRunId, failureReason: reason });
  }

  cancel(taskId: string): OrganizationTask {
    const task = this.requireInternal(taskId);
    if (!["created", "assigned", "queued"].includes(task.status)) {
      throw new OrganizationError("invalid_state", `Task ${taskId} cannot be cancelled from ${task.status}`);
    }
    this.queue = this.queue.filter((id) => id !== taskId);
    return this.replace(task, { status: "cancelled" });
  }

  get(taskId: string): OrganizationTask {
    return clone(this.requireInternal(taskId));
  }

  list(): OrganizationTask[] {
    return Array.from(this.tasks.values(), clone);
  }

  listQueue(): string[] {
    return [...this.queue];
  }

  restore(tasks: OrganizationTask[], queue: string[]): void {
    const nextTasks = new Map<string, OrganizationTask>();
    for (const task of tasks) {
      assertOrganizationTask(task, this.organizationId);
      if (nextTasks.has(task.taskId)) {
        throw new OrganizationError("invalid_input", `Duplicate task ${task.taskId} in snapshot`);
      }
      nextTasks.set(task.taskId, clone(task));
    }
    const queueIds = new Set(queue);
    if (queueIds.size !== queue.length) {
      throw new OrganizationError("invalid_input", "Task queue contains duplicate task ids");
    }
    const queuedTaskIds = tasks.filter((task) => task.status === "queued").map((task) => task.taskId);
    if (
      queue.some((taskId) => nextTasks.get(taskId)?.status !== "queued") ||
      queuedTaskIds.length !== queue.length ||
      queuedTaskIds.some((taskId) => !queueIds.has(taskId))
    ) {
      throw new OrganizationError("invalid_input", "Task queue references a missing or non-queued task");
    }

    const incomingIds = new Set<string>();
    const outgoingIds = new Set<string>();
    for (const task of nextTasks.values()) {
      if (task.incomingHandoffRequestId) {
        if (incomingIds.has(task.incomingHandoffRequestId)) {
          throw new OrganizationError("invalid_input", `Duplicate incoming handoff ${task.incomingHandoffRequestId}`);
        }
        incomingIds.add(task.incomingHandoffRequestId);
        const parent = nextTasks.get(task.parentTaskId!);
        if (
          !parent ||
          parent.rootTaskId !== task.rootTaskId ||
          parent.handoffDepth + 1 !== task.handoffDepth ||
          parent.outgoingHandoffRequestId !== task.incomingHandoffRequestId
        ) {
          throw new OrganizationError("invalid_input", `Task ${task.taskId} has an invalid parent lineage`);
        }
      }
      if (task.outgoingHandoffRequestId) {
        if (outgoingIds.has(task.outgoingHandoffRequestId)) {
          throw new OrganizationError("invalid_input", `Duplicate outgoing handoff ${task.outgoingHandoffRequestId}`);
        }
        outgoingIds.add(task.outgoingHandoffRequestId);
      }
    }
    if (
      incomingIds.size !== outgoingIds.size ||
      Array.from(incomingIds).some((id) => !outgoingIds.has(id))
    ) {
      throw new OrganizationError("invalid_input", "Task handoff lineage is incomplete");
    }
    this.tasks = nextTasks;
    this.queue = [...queue];
  }
}
