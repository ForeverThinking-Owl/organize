import {
  LEGACY_TRACE_SNAPSHOT_SCHEMA_VERSION,
  normalizeTraceSnapshot,
} from "../trace/trace-snapshot";
import {
  ORGANIZATION_SNAPSHOT_SCHEMA_VERSION,
  ORGANIZATION_STORE_SCHEMA_VERSION,
  assertOrganizationSnapshot,
  assertOrganizationStoreSnapshot,
  type OrganizationSnapshot,
  type OrganizationStoreSnapshot,
} from "./organization-snapshot";

export const LEGACY_ORGANIZATION_SNAPSHOT_SCHEMA_VERSION = "organization.snapshot.v2" as const;
export const LEGACY_ORGANIZATION_STORE_SCHEMA_VERSION = "organization.store.v2" as const;

const LEGACY_SNAPSHOT_FIELDS = [
  "schemaVersion", "savedAt", "organization", "actors", "tasks", "taskQueue",
  "messages", "inboxOrder", "trace", "runtimeRecovery",
] as const;

const LEGACY_TASK_FIELDS = [
  "organizationId", "taskId", "title", "description", "createdBy", "assignedTo",
  "skillId", "input", "runtimeContext", "status", "actorRunId", "result",
  "failureReason", "createdAt", "updatedAt",
] as const;

const LEGACY_MESSAGE_FIELDS = [
  "organizationId", "messageId", "fromActorId", "toActorId", "type", "payload",
  "status", "createdAt", "deliveredAt", "acknowledgedAt",
] as const;

const LEGACY_TASK_STATUSES = new Set([
  "created", "assigned", "queued", "running", "waiting_approval",
  "waiting_human_input", "waiting_external_event", "completed", "failed", "cancelled",
]);

const V3_ORGANIZATION_TRACE_EVENT_TYPES = new Set([
  "task_delegated",
  "handoff_response_enqueued",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  const allowedKeys = new Set(allowed);
  const unsupported = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unsupported) {
    throw new Error(`Invalid ${path}: unsupported field ${unsupported}`);
  }
}

function assertNoHandoffSkillStep(value: unknown, path: string): void {
  if (!isRecord(value) || !Array.isArray(value.steps)) return;
  if (value.steps.some((step) => isRecord(step) && step.type === "handoff")) {
    throw new Error(`Invalid ${path}: v2 cannot contain a handoff step`);
  }
}

function assertLegacyActors(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("Invalid legacy OrganizationSnapshot actors");
  }
  value.forEach((actor, actorIndex) => {
    if (!isRecord(actor)) return;
    assertExactKeys(actor, [
      "organizationId", "actorId", "status", "actorConfig", "skills", "capabilities",
      "registeredAt",
    ], `legacy OrganizationSnapshot actors[${actorIndex}]`);
    if (Array.isArray(actor.capabilities) && actor.capabilities.includes("task:delegate")) {
      throw new Error(
        `Invalid legacy OrganizationSnapshot actors[${actorIndex}]: v2 cannot delegate tasks`
      );
    }
    if (!isRecord(actor.skills)) return;
    for (const [skillId, skill] of Object.entries(actor.skills)) {
      assertNoHandoffSkillStep(
        skill,
        `legacy OrganizationSnapshot actors[${actorIndex}].skills.${skillId}`
      );
    }
  });
}

function assertLegacyOrganizationTrace(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("Invalid legacy OrganizationSnapshot trace");
  }
  value.forEach((event, index) => {
    if (!isRecord(event)) return;
    if (
      Object.prototype.hasOwnProperty.call(event, "handoffRequestId") ||
      V3_ORGANIZATION_TRACE_EVENT_TYPES.has(String(event.eventType))
    ) {
      throw new Error(
        `Invalid legacy OrganizationSnapshot trace[${index}]: v2 cannot contain handoff metadata`
      );
    }
  });
}

function assertLegacySnapshotEnvelope(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || value.schemaVersion !== LEGACY_ORGANIZATION_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Invalid legacy OrganizationSnapshot schemaVersion");
  }
  assertExactKeys(value, LEGACY_SNAPSHOT_FIELDS, "legacy OrganizationSnapshot");
  if (typeof value.savedAt !== "string" || value.savedAt.length === 0) {
    throw new Error("Invalid legacy OrganizationSnapshot savedAt");
  }
  assertLegacyActors(value.actors);
  if (!Array.isArray(value.tasks)) {
    throw new Error("Invalid legacy OrganizationSnapshot tasks");
  }
  value.tasks.forEach((task, index) => {
    if (!isRecord(task)) {
      throw new Error(`Invalid legacy OrganizationSnapshot tasks[${index}]`);
    }
    // v2 never had lineage or handoff metadata. Strict keys prevent a future or
    // partially backported handoff shape from being silently reinterpreted.
    assertExactKeys(task, LEGACY_TASK_FIELDS, `legacy OrganizationSnapshot tasks[${index}]`);
    if (typeof task.taskId !== "string" || task.taskId.length === 0) {
      throw new Error(`Invalid legacy OrganizationSnapshot tasks[${index}].taskId`);
    }
    if (!LEGACY_TASK_STATUSES.has(String(task.status))) {
      throw new Error(`Invalid legacy OrganizationSnapshot tasks[${index}].status`);
    }
  });
  if (!Array.isArray(value.messages)) {
    throw new Error("Invalid legacy OrganizationSnapshot messages");
  }
  value.messages.forEach((message, index) => {
    if (!isRecord(message)) {
      throw new Error(`Invalid legacy OrganizationSnapshot messages[${index}]`);
    }
    assertExactKeys(
      message,
      LEGACY_MESSAGE_FIELDS,
      `legacy OrganizationSnapshot messages[${index}]`
    );
  });
  assertLegacyOrganizationTrace(value.trace);
  if (value.runtimeRecovery !== undefined) {
    if (!isRecord(value.runtimeRecovery)) {
      throw new Error("Invalid legacy OrganizationSnapshot runtimeRecovery");
    }
    assertExactKeys(
      value.runtimeRecovery,
      ["pendingRuns", "trace", "memory"],
      "legacy OrganizationSnapshot runtimeRecovery"
    );
    if (
      !isRecord(value.runtimeRecovery.trace) ||
      value.runtimeRecovery.trace.schemaVersion !== LEGACY_TRACE_SNAPSHOT_SCHEMA_VERSION
    ) {
      throw new Error("Invalid legacy OrganizationSnapshot runtimeRecovery.trace schemaVersion");
    }
    if (
      Array.isArray(value.runtimeRecovery.trace.traces) &&
      value.runtimeRecovery.trace.traces.some((trace) =>
        isRecord(trace) &&
        Array.isArray(trace.events) &&
        trace.events.some((event) => isRecord(event) && event.eventType === "handoff")
      )
    ) {
      throw new Error(
        "Invalid legacy OrganizationSnapshot runtimeRecovery.trace: v2 cannot contain handoff events"
      );
    }
    if (!Array.isArray(value.runtimeRecovery.pendingRuns)) {
      throw new Error("Invalid legacy OrganizationSnapshot runtimeRecovery.pendingRuns");
    }
    value.runtimeRecovery.pendingRuns.forEach((pending, index) => {
      if (!isRecord(pending)) return;
      assertNoHandoffSkillStep(
        pending.skill,
        `legacy OrganizationSnapshot runtimeRecovery.pendingRuns[${index}].skill`
      );
    });
  }
}

/**
 * Convert a persisted Organization snapshot into the current in-memory shape.
 * The conversion is pure: it never mutates or writes the supplied snapshot.
 */
export function normalizeOrganizationSnapshot(value: unknown): OrganizationSnapshot {
  if (!isRecord(value)) {
    throw new Error("Invalid OrganizationSnapshot: expected an object");
  }
  if (value.schemaVersion === ORGANIZATION_SNAPSHOT_SCHEMA_VERSION) {
    assertOrganizationSnapshot(value);
    return clone(value);
  }
  if (value.schemaVersion !== LEGACY_ORGANIZATION_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Invalid OrganizationSnapshot: unsupported schemaVersion ${String(value.schemaVersion)}`
    );
  }

  assertLegacySnapshotEnvelope(value);
  const legacy = clone(value);
  const tasks = (legacy.tasks as Record<string, unknown>[]).map((task) => ({
    ...task,
    rootTaskId: task.taskId as string,
    handoffDepth: 0,
  }));
  const runtimeRecovery = legacy.runtimeRecovery as Record<string, unknown> | undefined;
  const migrated: unknown = {
    ...legacy,
    schemaVersion: ORGANIZATION_SNAPSHOT_SCHEMA_VERSION,
    tasks,
    messages: clone(legacy.messages),
    handoffs: [],
    ...(runtimeRecovery === undefined ? {} : {
      runtimeRecovery: {
        ...runtimeRecovery,
        trace: normalizeTraceSnapshot(runtimeRecovery.trace),
      },
    }),
  };
  assertOrganizationSnapshot(migrated);
  return migrated;
}

/** Normalize a v2 or v3 store envelope without rewriting its backing file. */
export function normalizeOrganizationStoreSnapshot(value: unknown): OrganizationStoreSnapshot {
  if (!isRecord(value)) {
    throw new Error("Invalid OrganizationStoreSnapshot: expected an object");
  }
  if (value.schemaVersion === ORGANIZATION_STORE_SCHEMA_VERSION) {
    assertOrganizationStoreSnapshot(value);
    return clone(value);
  }
  if (value.schemaVersion !== LEGACY_ORGANIZATION_STORE_SCHEMA_VERSION) {
    throw new Error(
      `Invalid OrganizationStoreSnapshot: unsupported schemaVersion ${String(value.schemaVersion)}`
    );
  }

  assertExactKeys(
    value,
    ["schemaVersion", "savedAt", "organizations"],
    "legacy OrganizationStoreSnapshot"
  );
  if (typeof value.savedAt !== "string" || value.savedAt.length === 0) {
    throw new Error("Invalid legacy OrganizationStoreSnapshot savedAt");
  }
  if (!Array.isArray(value.organizations)) {
    throw new Error("Invalid legacy OrganizationStoreSnapshot organizations");
  }
  if (value.organizations.some((snapshot) =>
    !isRecord(snapshot) ||
    snapshot.schemaVersion !== LEGACY_ORGANIZATION_SNAPSHOT_SCHEMA_VERSION
  )) {
    throw new Error("Invalid legacy OrganizationStoreSnapshot: mixed organization schema versions");
  }

  const migrated: unknown = {
    schemaVersion: ORGANIZATION_STORE_SCHEMA_VERSION,
    savedAt: value.savedAt,
    organizations: value.organizations.map(normalizeOrganizationSnapshot),
  };
  assertOrganizationStoreSnapshot(migrated);
  return migrated;
}
