// ============================================================================
// TraceLogger — 内存 Trace 记录器
// 记录 Actor 运行全过程事件
// ============================================================================

import { TraceEvent, TraceEventType, ActorRunTrace } from "../core/types/trace";

let traceCounter = 0;

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

  endRun(actorRunId: string, status: ActorRunTrace["status"]): void {
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

  clear(): void {
    this.traces.clear();
    traceCounter = 0;
  }
}

export const traceLogger = new TraceLogger();
