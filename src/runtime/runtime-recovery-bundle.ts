// ============================================================================
// RuntimeRecoveryBundle
// v0.4.5: coordinated recovery package validates external event waits
// ============================================================================

import { memoryService } from "../memory/memory-service";
import type { MemorySnapshot } from "../memory/memory-snapshot";
import { assertMemorySnapshot } from "../memory/json-memory-store";
import {
  assertTraceSnapshot,
  TRACE_SNAPSHOT_SCHEMA_VERSION,
  type TraceSnapshot,
} from "../trace/trace-snapshot";
import { traceLogger } from "../trace/trace-logger";
import { actorRuntime } from "./actor-runtime";
import type { PendingRunKind, PendingRunSnapshot, PendingRunStatus } from "./pending-run-snapshot";
import { assertPendingRunSnapshot } from "./pending-run-validation";
import { assertPendingMemoryTraceConsistency } from "./pending-memory-validation";
import { assertPendingRunTraceConsistency } from "./pending-trace-validation";
import { assertPendingStateTraceConsistency } from "./pending-state-trace-validation";
import { assertPendingToolGovernance } from "./pending-tool-governance-validation";
import { hasOrganizationOwner } from "../organization/organization-operation-lease";

export const RUNTIME_RECOVERY_BUNDLE_SCHEMA_VERSION = "runtime_recovery.bundle.v2";
export const RUNTIME_RECOVERY_STORE_SCHEMA_VERSION = "runtime_recovery.store.v2";

export interface RuntimeRecoveryBundle {
  schemaVersion: typeof RUNTIME_RECOVERY_BUNDLE_SCHEMA_VERSION;
  savedAt: string;

  actorRunId: string;
  actorId: string;
  skillId: string;
  status: PendingRunStatus;
  pendingKind: PendingRunKind;

  pendingRun: PendingRunSnapshot;
  trace: TraceSnapshot;
  memory: MemorySnapshot;
}

export interface RuntimeRecoveryStoreSnapshot {
  schemaVersion: typeof RUNTIME_RECOVERY_STORE_SCHEMA_VERSION;
  savedAt: string;
  bundles: RuntimeRecoveryBundle[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function assertRuntimeRecoveryBundle(value: unknown): asserts value is RuntimeRecoveryBundle {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid RuntimeRecoveryBundle: expected object");
  }
  const bundle = value as Record<string, unknown>;
  if (bundle.schemaVersion !== RUNTIME_RECOVERY_BUNDLE_SCHEMA_VERSION) {
    throw new Error("Invalid RuntimeRecoveryBundle: unsupported schemaVersion " + String(bundle.schemaVersion));
  }
  if (typeof bundle.savedAt !== "string") {
    throw new Error("Invalid RuntimeRecoveryBundle: savedAt must be a string");
  }
  if (typeof bundle.actorRunId !== "string") {
    throw new Error("Invalid RuntimeRecoveryBundle: actorRunId must be a string");
  }
  if (typeof bundle.actorId !== "string") {
    throw new Error("Invalid RuntimeRecoveryBundle: actorId must be a string");
  }
  if (typeof bundle.skillId !== "string") {
    throw new Error("Invalid RuntimeRecoveryBundle: skillId must be a string");
  }
  if (!["waiting_human_input", "waiting_approval", "waiting_external_event"].includes(String(bundle.status))) {
    throw new Error("Invalid RuntimeRecoveryBundle: unsupported status " + String(bundle.status));
  }
  if (!["human_input", "skill_approval", "tool_approval", "external_event"].includes(String(bundle.pendingKind))) {
    throw new Error("Invalid RuntimeRecoveryBundle: unsupported pendingKind " + String(bundle.pendingKind));
  }
  if (bundle.pendingRun === null || typeof bundle.pendingRun !== "object") {
    throw new Error("Invalid RuntimeRecoveryBundle: pendingRun must be an object");
  }
  assertPendingRunSnapshot(bundle.pendingRun);
  if (bundle.trace === null || typeof bundle.trace !== "object") {
    throw new Error("Invalid RuntimeRecoveryBundle: trace must be an object");
  }
  if (bundle.memory === null || typeof bundle.memory !== "object") {
    throw new Error("Invalid RuntimeRecoveryBundle: memory must be an object");
  }
  assertTraceSnapshot(bundle.trace);
  assertMemorySnapshot(bundle.memory);

  const pendingRun = bundle.pendingRun;
  const organizationId = pendingRun.context.actor.organizationId;
  if (pendingRun.actorRunId !== bundle.actorRunId) {
    throw new Error("Invalid RuntimeRecoveryBundle: pendingRun.actorRunId mismatch");
  }
  if (pendingRun.actorId !== bundle.actorId) {
    throw new Error("Invalid RuntimeRecoveryBundle: pendingRun.actorId mismatch");
  }
  if (pendingRun.skillId !== bundle.skillId) {
    throw new Error("Invalid RuntimeRecoveryBundle: pendingRun.skillId mismatch");
  }
  if (pendingRun.pendingKind !== bundle.pendingKind) {
    throw new Error("Invalid RuntimeRecoveryBundle: pendingRun.pendingKind mismatch");
  }
  if (pendingRun.status !== bundle.status) {
    throw new Error("Invalid RuntimeRecoveryBundle: pendingRun.status mismatch");
  }
  if (
    bundle.memory.memories.some((memory) => memory.organizationId !== organizationId) ||
    bundle.memory.candidates.some((candidate) => candidate.organizationId !== organizationId)
  ) {
    throw new Error(
      `Invalid RuntimeRecoveryBundle: memory must be limited to organization ${organizationId}`
    );
  }
  if (bundle.pendingKind === "external_event") {
    if (bundle.status !== "waiting_external_event") {
      throw new Error("Invalid RuntimeRecoveryBundle: external_event must use waiting_external_event status");
    }
    if (pendingRun.pendingExternalEvent === undefined || pendingRun.pendingExternalEvent === null || typeof pendingRun.pendingExternalEvent !== "object") {
      throw new Error("Invalid RuntimeRecoveryBundle: external_event requires pendingExternalEvent");
    }
  }

  const trace = bundle.trace.traces[0];
  if (
    bundle.trace.traces.length !== 1 ||
    !trace ||
    trace.actorRunId !== bundle.actorRunId ||
    trace.actorId !== bundle.actorId ||
    trace.skillId !== bundle.skillId ||
    trace.status !== bundle.status
  ) {
    throw new Error("Invalid RuntimeRecoveryBundle: trace must exactly match its pending run");
  }
  assertPendingRunTraceConsistency(pendingRun, trace);
  assertPendingMemoryTraceConsistency(pendingRun, trace, bundle.memory);
  assertPendingStateTraceConsistency(pendingRun, trace);
}

export function createRuntimeRecoveryBundle(actorRunId: string): RuntimeRecoveryBundle | null {
  const pendingRun = actorRuntime.dumpPendingRun(actorRunId);
  if (!pendingRun) return null;

  const trace = traceLogger.getTrace(actorRunId);
  if (!trace) {
    throw new Error("Cannot create RuntimeRecoveryBundle: trace not found for " + actorRunId);
  }

  const savedAt = new Date().toISOString();
  const bundle: RuntimeRecoveryBundle = {
    schemaVersion: RUNTIME_RECOVERY_BUNDLE_SCHEMA_VERSION,
    savedAt,
    actorRunId,
    actorId: pendingRun.actorId,
    skillId: pendingRun.skillId,
    status: pendingRun.status,
    pendingKind: pendingRun.pendingKind,
    pendingRun,
    trace: {
      schemaVersion: TRACE_SNAPSHOT_SCHEMA_VERSION,
      savedAt,
      traces: [cloneJson(trace)],
    },
    memory: memoryService.dumpOrganizationSnapshot(pendingRun.context.actor.organizationId),
  };

  assertRuntimeRecoveryBundle(bundle);
  return cloneJson(bundle);
}

export function restoreRuntimeRecoveryBundle(bundle: RuntimeRecoveryBundle): void {
  assertRuntimeRecoveryBundle(bundle);
  assertPendingToolGovernance(bundle.pendingRun);
  const organizationId = bundle.pendingRun.context.actor.organizationId;
  if (hasOrganizationOwner(organizationId)) {
    throw new Error(
      `Organization ${organizationId} is owned by OrganizationRuntime; restore its OrganizationSnapshot instead`
    );
  }
  if (actorRuntime.hasRun(bundle.actorRunId) || traceLogger.getTrace(bundle.actorRunId)) {
    throw new Error(`Actor run ${bundle.actorRunId} already exists`);
  }
  const restored = cloneJson(bundle);
  const restoredOrganizationId = restored.pendingRun.context.actor.organizationId;
  const previousMemory = memoryService.dumpOrganizationSnapshot(restoredOrganizationId);
  const previousTrace = traceLogger.dumpRunsSnapshot([restored.actorRunId]);
  try {
    memoryService.mergeOrganizationSnapshot(restoredOrganizationId, restored.memory);
    traceLogger.restoreRunsSnapshot(restored.trace);
    actorRuntime.restorePendingRun(restored.pendingRun);
  } catch (error) {
    actorRuntime.clearRun(restored.actorRunId);
    traceLogger.clearRuns([restored.actorRunId]);
    traceLogger.restoreRunsSnapshot(previousTrace);
    memoryService.restoreOrganizationSnapshot(restoredOrganizationId, previousMemory);
    throw error;
  }
}
