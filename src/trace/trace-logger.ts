// ============================================================================
// TraceLogger — 内存 Trace 记录器
// v0.4.4: explicit suspend / resume lifecycle supports external events
// ============================================================================

import { TraceEvent, TraceEventType, ActorRunTrace } from "../core/types/trace";
import { TRACE_SNAPSHOT_SCHEMA_VERSION, type TraceSnapshot } from "./trace-snapshot";

let traceCounter = 0;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function maxCounterFromEventIds(traces: ActorRunTrace[]): number {
  let max = 0;
  for (const trace of traces) {
    for (const event of trace.events) {
      if (!event.eventId.startsWith("evt_")) continue;
      const n = Number(event.eventId.slice("evt_".length));
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return max;
}

export type RunTerminalStatus = "completed" | "error";
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
      eventId: "evt_" + String(++traceCounter),
      actorRunId,
      sequence: trace.events.length + 1,
      eventType,
      timestamp: new Date().toISOString(),
      stepKey: resolvedStepKey,
      data,
    });
  }

  getTrace(actorRunId: string): ActorRunTrace | undefined {
    return this.traces.get(actorRunId);
  }

  getAllTraces(): ActorRunTrace[] {
    return Array.from(this.traces.values());
  }

  dumpSnapshot(): TraceSnapshot {
    return {
      schemaVersion: TRACE_SNAPSHOT_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      traces: cloneJson(this.getAllTraces()),
    };
  }

  restoreSnapshot(snapshot: TraceSnapshot): void {
    if (snapshot.schemaVersion !== TRACE_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error("Unsupported TraceSnapshot schemaVersion: " + String(snapshot.schemaVersion));
    }

    const traces = cloneJson(snapshot.traces);
    this.traces = new Map(traces.map((trace) => [trace.actorRunId, trace]));
    traceCounter = maxCounterFromEventIds(traces);
  }

  clear(): void {
    this.traces.clear();
    traceCounter = 0;
  }
}

export const traceLogger = new TraceLogger();
