// ============================================================================
// RuntimeRecoveryBundle
// v0.4.5: coordinated recovery package validates external event waits
// ============================================================================

import { memoryService } from "../memory/memory-service";
import type { MemorySnapshot } from "../memory/memory-snapshot";
import { TRACE_SNAPSHOT_SCHEMA_VERSION, type TraceSnapshot } from "../trace/trace-snapshot";
import { traceLogger } from "../trace/trace-logger";
import { actorRuntime } from "./actor-runtime";
import type { PendingRunKind, PendingRunSnapshot, PendingRunStatus } from "./pending-run-snapshot";

export const RUNTIME_RECOVERY_BUNDLE_SCHEMA_VERSION = "runtime_recovery.bundle.v1";
export const RUNTIME_RECOVERY_STORE_SCHEMA_VERSION = "runtime_recovery.store.v1";

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
  if (bundle.trace === null || typeof bundle.trace !== "object") {
    throw new Error("Invalid RuntimeRecoveryBundle: trace must be an object");
  }
  if (bundle.memory === null || typeof bundle.memory !== "object") {
    throw new Error("Invalid RuntimeRecoveryBundle: memory must be an object");
  }

  const pendingRun = bundle.pendingRun as Record<string, unknown>;
  if (pendingRun.actorRunId !== bundle.actorRunId) {
    throw new Error("Invalid RuntimeRecoveryBundle: pendingRun.actorRunId mismatch");
  }
  if (pendingRun.pendingKind !== bundle.pendingKind) {
    throw new Error("Invalid RuntimeRecoveryBundle: pendingRun.pendingKind mismatch");
  }
  if (pendingRun.status !== bundle.status) {
    throw new Error("Invalid RuntimeRecoveryBundle: pendingRun.status mismatch");
  }
  if (bundle.pendingKind === "external_event") {
    if (bundle.status !== "waiting_external_event") {
      throw new Error("Invalid RuntimeRecoveryBundle: external_event must use waiting_external_event status");
    }
    if (pendingRun.pendingExternalEvent === undefined || pendingRun.pendingExternalEvent === null || typeof pendingRun.pendingExternalEvent !== "object") {
      throw new Error("Invalid RuntimeRecoveryBundle: external_event requires pendingExternalEvent");
    }
  }

  const trace = bundle.trace as TraceSnapshot;
  if (!trace.traces?.some((runTrace) => runTrace.actorRunId === bundle.actorRunId)) {
    throw new Error("Invalid RuntimeRecoveryBundle: trace does not contain actorRunId " + String(bundle.actorRunId));
  }
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
    memory: memoryService.dumpSnapshot(),
  };

  assertRuntimeRecoveryBundle(bundle);
  return cloneJson(bundle);
}

export function restoreRuntimeRecoveryBundle(bundle: RuntimeRecoveryBundle): void {
  assertRuntimeRecoveryBundle(bundle);
  const restored = cloneJson(bundle);
  memoryService.restoreSnapshot(restored.memory);
  traceLogger.restoreSnapshot(restored.trace);
  actorRuntime.restorePendingRun(restored.pendingRun);
}
