// ============================================================================
// TraceLogger — 内存 Trace 记录器
// v0.4.4: explicit suspend / resume lifecycle supports external events
// ============================================================================

import { randomUUID } from "node:crypto";
import { TraceEvent, TraceEventType, ActorRunTrace } from "../core/types/trace";
import {
  TRACE_SNAPSHOT_SCHEMA_VERSION,
  assertTraceSnapshot,
  normalizeTraceSnapshot,
  type TraceSnapshot,
} from "./trace-snapshot";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type RunTerminalStatus = "completed" | "handoff_requested" | "error";
export type RunWaitingStatus = "waiting_approval" | "waiting_human_input" | "waiting_external_event";

export class TraceLogger {
  private traces: Map<string, ActorRunTrace> = new Map();

  startRun(actorRunId: string, actorId: string, skillId: string): void {
    this.traces.set(actorRunId, {
      actorRunId,
      actorId,
      skillId,
      startedAt: new Date().toISOString(),
      status: "running",
      events: [],
    });
    this.record(actorRunId, "actor_run_start", {
      actorId,
      skillId,
    });
  }

  suspendRun(
    actorRunId: string,
    status: RunWaitingStatus,
    data: Record<string, unknown> = {}
  ): void {
    const trace = this.traces.get(actorRunId);
    if (trace) {
      trace.status = status;
    }
    this.record(actorRunId, "actor_run_suspended", { status, ...data });
  }

  resumeRun(actorRunId: string, data: Record<string, unknown> = {}): void {
    const trace = this.traces.get(actorRunId);
    if (trace) {
      trace.status = "running";
    }
    this.record(actorRunId, "actor_run_resumed", data);
  }

  endRun(actorRunId: string, status: RunTerminalStatus): void {
    const trace = this.traces.get(actorRunId);
    if (trace) {
      trace.status = status;
      trace.endedAt = new Date().toISOString();
    }
    this.record(actorRunId, "actor_run_end", { status });
  }

  record(
    actorRunId: string,
    eventType: TraceEventType,
    data: Record<string, unknown> = {},
    stepKey?: string
  ): void {
    const trace = this.traces.get(actorRunId);
    if (!trace) return;

    // 自动从 data 中提取 stepKey（如果调用方传在 data 里）
    const resolvedStepKey = stepKey ?? (data.stepKey as string | undefined);

    trace.events.push({
      eventId: `evt_${randomUUID()}`,
      actorRunId,
      sequence: trace.events.length + 1,
      eventType,
      timestamp: new Date().toISOString(),
      stepKey: resolvedStepKey,
      data: cloneJson(data),
    });
  }

  getTrace(actorRunId: string): ActorRunTrace | undefined {
    const trace = this.traces.get(actorRunId);
    return trace ? cloneJson(trace) : undefined;
  }

  getAllTraces(): ActorRunTrace[] {
    return cloneJson(Array.from(this.traces.values()));
  }

  dumpSnapshot(): TraceSnapshot {
    return {
      schemaVersion: TRACE_SNAPSHOT_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      traces: cloneJson(this.getAllTraces()),
    };
  }

  dumpRunsSnapshot(actorRunIds: Iterable<string>): TraceSnapshot {
    const ids = new Set(actorRunIds);
    return {
      schemaVersion: TRACE_SNAPSHOT_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      traces: cloneJson(this.getAllTraces().filter((trace) => ids.has(trace.actorRunId))),
    };
  }

  restoreSnapshot(snapshot: TraceSnapshot): void {
    const normalized = normalizeTraceSnapshot(snapshot);

    const traces = cloneJson(normalized.traces);
    this.traces = new Map(traces.map((trace) => [trace.actorRunId, trace]));
  }

  /** Upsert selected run traces without replacing unrelated process state. */
  restoreRunsSnapshot(snapshot: TraceSnapshot): void {
    const normalized = normalizeTraceSnapshot(snapshot);

    const incoming = cloneJson(normalized.traces);
    const incomingRunIds = new Set(incoming.map((trace) => trace.actorRunId));
    assertTraceSnapshot({
      schemaVersion: TRACE_SNAPSHOT_SCHEMA_VERSION,
      savedAt: normalized.savedAt,
      traces: [
        ...cloneJson(this.getAllTraces().filter((trace) => !incomingRunIds.has(trace.actorRunId))),
        ...incoming,
      ],
    });

    for (const trace of incoming) {
      this.traces.set(trace.actorRunId, trace);
    }
  }

  clearRuns(actorRunIds: Iterable<string>): void {
    for (const actorRunId of actorRunIds) {
      this.traces.delete(actorRunId);
    }
  }

  clear(): void {
    this.traces.clear();
  }
}

export const traceLogger = new TraceLogger();
