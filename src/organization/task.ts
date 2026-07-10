import { randomUUID } from "node:crypto";
import type { ActorRunInput } from "../runtime/actor-runtime";
import { OrganizationError } from "./organization-error";
import { assertJsonSafe } from "./organization-permission";

export type OrganizationTaskStatus =
  | "created"
  | "assigned"
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_human_input"
  | "waiting_external_event"
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

const WAITING = new Set<OrganizationTaskStatus>([
  "waiting_approval",
  "waiting_human_input",
  "waiting_external_event",
]);
const TASK_STATUSES = new Set<OrganizationTaskStatus>([
  "created", "assigned", "queued", "running", "waiting_approval",
  "waiting_human_input", "waiting_external_event", "completed", "failed", "cancelled",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertCreateTaskInput(input: CreateTaskInput): void {
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
  if (!isPlainRecord(input.input)) {
    throw new OrganizationError("invalid_input", "task.input must be a plain object");
  }
  if (Object.keys(input.input).some((field) => field !== "text" && field !== "payload")) {
    throw new OrganizationError("invalid_input", "task.input has unsupported fields");
  }
  if (input.input.text !== undefined && typeof input.input.text !== "string") {
    throw new OrganizationError("invalid_input", "task.input.text must be a string");
  }
  if (input.input.payload !== undefined && !isPlainRecord(input.input.payload)) {
    throw new OrganizationError("invalid_input", "task.input.payload must be a plain object");
  }
  if (input.runtimeContext !== undefined && !isPlainRecord(input.runtimeContext)) {
    throw new OrganizationError("invalid_input", "task.runtimeContext must be a plain object");
  }
  assertJsonSafe(input.input, "task.input");
  if (input.runtimeContext !== undefined) {
    assertJsonSafe(input.runtimeContext, "task.runtimeContext");
  }
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
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
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
    if (task.status === "completed" || task.status === "cancelled") {
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
    this.tasks.clear();
    for (const task of tasks) {
      if (task.organizationId !== this.organizationId) {
        throw new OrganizationError("cross_organization", "Task snapshot crosses organizations");
      }
      if (this.tasks.has(task.taskId)) {
        throw new OrganizationError("invalid_input", `Duplicate task ${task.taskId} in snapshot`);
      }
      if (!TASK_STATUSES.has(task.status)) {
        throw new OrganizationError("invalid_input", `Task ${task.taskId} has invalid status`);
      }
      this.tasks.set(task.taskId, clone(task));
    }
    const queueIds = new Set(queue);
    if (queueIds.size !== queue.length) {
      throw new OrganizationError("invalid_input", "Task queue contains duplicate task ids");
    }
    const queuedTaskIds = tasks.filter((task) => task.status === "queued").map((task) => task.taskId);
    if (
      queue.some((taskId) => this.tasks.get(taskId)?.status !== "queued") ||
      queuedTaskIds.length !== queue.length ||
      queuedTaskIds.some((taskId) => !queueIds.has(taskId))
    ) {
      throw new OrganizationError("invalid_input", "Task queue references a missing or non-queued task");
    }
    this.queue = [...queue];
  }
}
