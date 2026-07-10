import type { MemorySnapshot } from "../memory/memory-snapshot";
import type { PendingRunSnapshot } from "../runtime/pending-run-snapshot";
import type { TraceSnapshot } from "../trace/trace-snapshot";
import type { RegisteredActor } from "./actor-registry";
import type { ActorMessage } from "./actor-message";
import type { Organization } from "./organization";
import type { OrganizationTask } from "./task";
import type { OrganizationTraceEvent } from "./organization-trace";

export const ORGANIZATION_SNAPSHOT_SCHEMA_VERSION = "organization.snapshot.v2" as const;
export const ORGANIZATION_STORE_SCHEMA_VERSION = "organization.store.v2" as const;

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

export function assertOrganizationSnapshot(value: unknown): asserts value is OrganizationSnapshot {
  if (!isRecord(value) || value.schemaVersion !== ORGANIZATION_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Invalid OrganizationSnapshot schemaVersion");
  }
  if (typeof value.savedAt !== "string" || value.savedAt.length === 0) {
    throw new Error("Invalid OrganizationSnapshot savedAt");
  }
  if (!isRecord(value.organization) || typeof value.organization.organizationId !== "string") {
    throw new Error("Invalid OrganizationSnapshot organization");
  }
  for (const field of ["actors", "tasks", "taskQueue", "messages", "trace"] as const) {
    if (!Array.isArray(value[field])) {
      throw new Error(`Invalid OrganizationSnapshot ${field}`);
    }
  }
  if (!isRecord(value.inboxOrder)) {
    throw new Error("Invalid OrganizationSnapshot inboxOrder");
  }
  if (value.runtimeRecovery !== undefined) {
    if (!isRecord(value.runtimeRecovery) || !Array.isArray(value.runtimeRecovery.pendingRuns)) {
      throw new Error("Invalid OrganizationSnapshot runtimeRecovery");
    }
    if (!isRecord(value.runtimeRecovery.trace) || !isRecord(value.runtimeRecovery.memory)) {
      throw new Error("Invalid OrganizationSnapshot runtime recovery state");
    }
  }
}

export function assertOrganizationStoreSnapshot(value: unknown): asserts value is OrganizationStoreSnapshot {
  if (!isRecord(value) || value.schemaVersion !== ORGANIZATION_STORE_SCHEMA_VERSION) {
    throw new Error("Invalid OrganizationStoreSnapshot schemaVersion");
  }
  if (typeof value.savedAt !== "string" || value.savedAt.length === 0) {
    throw new Error("Invalid OrganizationStoreSnapshot savedAt");
  }
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
