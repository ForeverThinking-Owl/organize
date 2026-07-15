import { assertMemorySnapshot } from "../memory/json-memory-store";
import type { MemorySnapshot } from "../memory/memory-snapshot";
import { assertPendingRunSnapshot } from "../runtime/pending-run-validation";
import type { PendingRunSnapshot } from "../runtime/pending-run-snapshot";
import { assertTraceSnapshot, TRACE_SNAPSHOT_SCHEMA_VERSION } from "../trace/trace-snapshot";
import type { TraceSnapshot } from "../trace/trace-snapshot";
import { ActorRegistry, type RegisteredActor } from "./actor-registry";
import { ActorInbox, type ActorMessage } from "./actor-message";
import {
  OrganizationHandoffRegistry,
  type OrganizationHandoffRecord,
} from "./organization-handoff";
import { assertOrganization, type Organization } from "./organization";
import { assertJsonSafe } from "./organization-permission";
import { TaskManager, type OrganizationTask } from "./task";
import {
  ORGANIZATION_TRACE_EVENT_TYPES,
  type OrganizationTraceEvent,
} from "./organization-trace";

export const ORGANIZATION_SNAPSHOT_SCHEMA_VERSION = "organization.snapshot.v3" as const;
export const ORGANIZATION_STORE_SCHEMA_VERSION = "organization.store.v3" as const;

export interface OrganizationRuntimeRecoverySnapshot {
  pendingRuns: PendingRunSnapshot[];
  trace: TraceSnapshot;
  memory: MemorySnapshot;
}

export interface OrganizationSnapshot {
  schemaVersion: typeof ORGANIZATION_SNAPSHOT_SCHEMA_VERSION;
  savedAt: string;
  organization: Organization;
  actors: RegisteredActor[];
  tasks: OrganizationTask[];
  taskQueue: string[];
  messages: ActorMessage[];
  inboxOrder: Record<string, string[]>;
  handoffs: OrganizationHandoffRecord[];
  trace: OrganizationTraceEvent[];
  runtimeRecovery?: OrganizationRuntimeRecoverySnapshot;
}

export interface OrganizationStoreSnapshot {
  schemaVersion: typeof ORGANIZATION_STORE_SCHEMA_VERSION;
  savedAt: string;
  organizations: OrganizationSnapshot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${path}: expected a non-empty string`);
  }
}

function assertRuntimeRecoverySnapshot(
  value: unknown
): asserts value is OrganizationRuntimeRecoverySnapshot {
  if (!isRecord(value)) {
    throw new Error("Invalid OrganizationSnapshot runtimeRecovery");
  }
  assertExactKeys(value, ["pendingRuns", "trace", "memory"], "OrganizationSnapshot runtimeRecovery");
  if (!Array.isArray(value.pendingRuns)) {
    throw new Error("Invalid OrganizationSnapshot runtimeRecovery.pendingRuns");
  }
  value.pendingRuns.forEach(assertPendingRunSnapshot);
  if (!isRecord(value.trace) || value.trace.schemaVersion !== TRACE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Invalid OrganizationSnapshot runtimeRecovery.trace schemaVersion");
  }
  assertTraceSnapshot(value.trace);
  assertMemorySnapshot(value.memory);
}

function assertOrganizationTrace(
  value: unknown,
  organizationId: string
): asserts value is OrganizationTraceEvent[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid OrganizationSnapshot trace");
  }
  const supportedTypes = new Set<string>(ORGANIZATION_TRACE_EVENT_TYPES);
  const eventIds = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const path = `OrganizationSnapshot trace[${index}]`;
    if (!isRecord(candidate)) {
      throw new Error(`Invalid ${path}: expected an object`);
    }
    assertExactKeys(candidate, [
      "eventId", "organizationId", "sequence", "eventType", "timestamp",
      "actorId", "taskId", "messageId", "actorRunId", "handoffRequestId", "data",
    ], path);
    assertNonEmptyString(candidate.eventId, `${path}.eventId`);
    if (eventIds.has(candidate.eventId)) {
      throw new Error(`Invalid OrganizationSnapshot trace: duplicate eventId ${candidate.eventId}`);
    }
    eventIds.add(candidate.eventId);
    if (
      candidate.organizationId !== organizationId ||
      candidate.sequence !== index + 1 ||
      typeof candidate.eventType !== "string" ||
      !supportedTypes.has(candidate.eventType)
    ) {
      throw new Error(`Invalid ${path}: identity, sequence, or event type mismatch`);
    }
    assertNonEmptyString(candidate.timestamp, `${path}.timestamp`);
    for (const key of [
      "actorId", "taskId", "messageId", "actorRunId", "handoffRequestId",
    ] as const) {
      if (candidate[key] !== undefined) {
        assertNonEmptyString(candidate[key], `${path}.${key}`);
      }
    }
    if (!isRecord(candidate.data)) {
      throw new Error(`Invalid ${path}.data: expected an object`);
    }
    assertJsonSafe(candidate.data, `${path}.data`);
  }
}

export function assertOrganizationSnapshot(value: unknown): asserts value is OrganizationSnapshot {
  if (!isRecord(value) || value.schemaVersion !== ORGANIZATION_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Invalid OrganizationSnapshot schemaVersion");
  }
  assertExactKeys(value, [
    "schemaVersion", "savedAt", "organization", "actors", "tasks", "taskQueue",
    "messages", "inboxOrder", "handoffs", "trace", "runtimeRecovery",
  ], "OrganizationSnapshot");
  assertNonEmptyString(value.savedAt, "OrganizationSnapshot savedAt");
  assertOrganization(value.organization);
  const organizationId = value.organization.organizationId;

  if (!Array.isArray(value.actors)) {
    throw new Error("Invalid OrganizationSnapshot actors");
  }
  new ActorRegistry(organizationId).restore(value.actors as RegisteredActor[]);

  if (!Array.isArray(value.tasks) || !Array.isArray(value.taskQueue)) {
    throw new Error("Invalid OrganizationSnapshot tasks or taskQueue");
  }
  new TaskManager(organizationId).restore(
    value.tasks as OrganizationTask[],
    value.taskQueue as string[]
  );
  if ((value.tasks as OrganizationTask[]).some((task) => task.status === "running")) {
    throw new Error("Invalid OrganizationSnapshot: running tasks cannot be checkpointed");
  }

  if (!Array.isArray(value.messages) || !isRecord(value.inboxOrder)) {
    throw new Error("Invalid OrganizationSnapshot messages or inboxOrder");
  }
  new ActorInbox(organizationId).restore(
    value.messages as ActorMessage[],
    value.inboxOrder as Record<string, string[]>
  );

  if (!Array.isArray(value.handoffs)) {
    throw new Error("Invalid OrganizationSnapshot handoffs");
  }
  new OrganizationHandoffRegistry(organizationId).restore(
    value.handoffs as OrganizationHandoffRecord[]
  );
  assertOrganizationTrace(value.trace, organizationId);

  if (value.runtimeRecovery !== undefined) {
    assertRuntimeRecoverySnapshot(value.runtimeRecovery);
  }
}

export function assertOrganizationStoreSnapshot(value: unknown): asserts value is OrganizationStoreSnapshot {
  if (!isRecord(value) || value.schemaVersion !== ORGANIZATION_STORE_SCHEMA_VERSION) {
    throw new Error("Invalid OrganizationStoreSnapshot schemaVersion");
  }
  assertExactKeys(
    value,
    ["schemaVersion", "savedAt", "organizations"],
    "OrganizationStoreSnapshot"
  );
  assertNonEmptyString(value.savedAt, "OrganizationStoreSnapshot savedAt");
  if (!Array.isArray(value.organizations)) {
    throw new Error("Invalid OrganizationStoreSnapshot organizations");
  }
  const organizationIds = new Set<string>();
  value.organizations.forEach((snapshot) => {
    assertOrganizationSnapshot(snapshot);
    const organizationId = snapshot.organization.organizationId;
    if (organizationIds.has(organizationId)) {
      throw new Error(`Invalid OrganizationStoreSnapshot duplicate organizationId ${organizationId}`);
    }
    organizationIds.add(organizationId);
  });
}
