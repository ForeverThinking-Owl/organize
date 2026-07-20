// ============================================================================
// TraceSnapshot
// v0.3.7: snapshot schema for persisting ActorRunTrace records
// ============================================================================

import type { ActorRunTrace, TraceEventType } from "../core/types/trace";

export const LEGACY_TRACE_SNAPSHOT_SCHEMA_VERSION = "trace.snapshot.v1";
export const TRACE_SNAPSHOT_SCHEMA_VERSION = "trace.snapshot.v2";

export interface TraceSnapshot {
  schemaVersion:
    | typeof TRACE_SNAPSHOT_SCHEMA_VERSION
    | typeof LEGACY_TRACE_SNAPSHOT_SCHEMA_VERSION;
  savedAt: string;
  traces: ActorRunTrace[];
}

export interface NormalizedTraceSnapshot extends TraceSnapshot {
  schemaVersion: typeof TRACE_SNAPSHOT_SCHEMA_VERSION;
}

const TRACE_EVENT_TYPES = new Set<TraceEventType>([
  "actor_run_start",
  "actor_run_suspended",
  "actor_run_resumed",
  "actor_run_end",
  "context_built",
  "memory_retrieved",
  "memory_store_load",
  "memory_store_save",
  "memory_store_error",
  "skill_step_start",
  "skill_step_end",
  "tool_call_start",
  "tool_call_end",
  "tool_observation",
  "decision_generated",
  "permission_check",
  "approval_check",
  "approval_requested",
  "approval_decided",
  "human_input_requested",
  "human_input_received",
  "external_event_requested",
  "external_event_received",
  "external_event_validation_failed",
  "continuation_validation_failed",
  "llm_call_start",
  "llm_call_end",
  "llm_validation_failed",
  "handoff",
  "final_output",
  "memory_candidate_generated",
  "memory_accepted",
  "memory_write_summary",
  "error",
]);

const WAITING_STATUSES = new Set<ActorRunTrace["status"]>([
  "waiting_approval",
  "waiting_human_input",
  "waiting_external_event",
]);

const TERMINAL_STATUSES = new Set<ActorRunTrace["status"]>([
  "completed",
  "handoff_requested",
  "error",
]);

const LEGACY_TERMINAL_STATUSES = new Set<ActorRunTrace["status"]>([
  "completed",
  "error",
]);

type LifecycleStatus = "not_started" | ActorRunTrace["status"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid TraceSnapshot: ${path} must be a non-empty string`);
  }
}

function assertJsonSafe(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid TraceSnapshot: ${path} must contain finite numbers`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Invalid TraceSnapshot: ${path} is not JSON-safe`);
  }
  if (ancestors.has(value)) {
    throw new Error(`Invalid TraceSnapshot: ${path} contains a circular reference`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        throw new Error(`Invalid TraceSnapshot: ${path}[${index}] is a sparse array entry`);
      }
      assertJsonSafe(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new Error(`Invalid TraceSnapshot: ${path} must be a plain JSON object`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafe(item, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertHandoffRequestData(
  trace: ActorRunTrace,
  traceIndex: number,
  eventIndex: number,
  data: Record<string, unknown>,
  eventStepKey: string | undefined
): void {
  const path = `traces[${traceIndex}].events[${eventIndex}].data`;
  const requiredFields = [
    "handoffRequestId",
    "actorRunId",
    "sourceActorId",
    "sourceSkillId",
    "stepKey",
    "targetActorId",
    "targetSkillId",
    "reason",
    "handoffContext",
  ] as const;
  const allowed = new Set<string>(requiredFields);
  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) {
      throw new Error(`Invalid TraceSnapshot: ${path}.${field} is required`);
    }
  }
  for (const field of Object.keys(data)) {
    if (!allowed.has(field)) {
      throw new Error(`Invalid TraceSnapshot: ${path}.${field} is not supported`);
    }
  }
  for (const field of requiredFields.slice(0, 8)) {
    assertNonEmptyString(data[field], `${path}.${field}`);
  }
  if (!isRecord(data.handoffContext)) {
    throw new Error(`Invalid TraceSnapshot: ${path}.handoffContext must be an object`);
  }
  if (
    data.actorRunId !== trace.actorRunId ||
    data.sourceActorId !== trace.actorId ||
    data.sourceSkillId !== trace.skillId ||
    data.stepKey !== eventStepKey
  ) {
    throw new Error(`Invalid TraceSnapshot: ${path} identity does not match its trace event`);
  }
}

function assertTraceLifecycle(
  trace: ActorRunTrace,
  traceIndex: number,
  schemaVersion: TraceSnapshot["schemaVersion"]
): void {
  const path = `traces[${traceIndex}]`;
  let lifecycle: LifecycleStatus = "not_started";
  const terminalStatuses = schemaVersion === TRACE_SNAPSHOT_SCHEMA_VERSION
    ? TERMINAL_STATUSES
    : LEGACY_TERMINAL_STATUSES;
  const handoffEvents: Array<{ index: number; data: Record<string, unknown>; stepKey?: string }> = [];
  let finalOutputCount = 0;

  for (const [eventIndex, event] of trace.events.entries()) {
    const eventPath = `${path}.events[${eventIndex}]`;
    switch (event.eventType) {
      case "actor_run_start":
        if (eventIndex !== 0 || lifecycle !== "not_started") {
          throw new Error(`Invalid TraceSnapshot: ${eventPath} has an unexpected actor_run_start`);
        }
        if (event.data.actorId !== trace.actorId || event.data.skillId !== trace.skillId) {
          throw new Error(`Invalid TraceSnapshot: ${eventPath} start identity does not match its trace`);
        }
        lifecycle = "running";
        break;

      case "actor_run_suspended": {
        const waitingStatus = event.data.status;
        if (lifecycle !== "running" || !WAITING_STATUSES.has(waitingStatus as ActorRunTrace["status"])) {
          throw new Error(`Invalid TraceSnapshot: ${eventPath} has an invalid suspend transition`);
        }
        lifecycle = waitingStatus as ActorRunTrace["status"];
        break;
      }

      case "actor_run_resumed":
        if (!WAITING_STATUSES.has(lifecycle as ActorRunTrace["status"])) {
          throw new Error(`Invalid TraceSnapshot: ${eventPath} resumes a run that is not waiting`);
        }
        lifecycle = "running";
        break;

      case "actor_run_end": {
        const terminalStatus = event.data.status;
        if (
          lifecycle !== "running" ||
          !terminalStatuses.has(terminalStatus as ActorRunTrace["status"])
        ) {
          throw new Error(`Invalid TraceSnapshot: ${eventPath} has an invalid terminal transition`);
        }
        lifecycle = terminalStatus as ActorRunTrace["status"];
        break;
      }

      default:
        if (lifecycle === "not_started" || terminalStatuses.has(lifecycle as ActorRunTrace["status"])) {
          throw new Error(`Invalid TraceSnapshot: ${eventPath} occurs outside an active run`);
        }
        if (
          event.eventType === "continuation_validation_failed" &&
          !WAITING_STATUSES.has(lifecycle as ActorRunTrace["status"])
        ) {
          throw new Error(`Invalid TraceSnapshot: ${eventPath} requires a waiting run`);
        }
        if (
          event.eventType === "external_event_validation_failed" &&
          lifecycle !== "waiting_external_event"
        ) {
          throw new Error(`Invalid TraceSnapshot: ${eventPath} requires an external-event wait`);
        }
        // Invalid external events are recorded without resuming or re-suspending
        // the run, so this audit event may legitimately follow a suspend event.
        if (WAITING_STATUSES.has(lifecycle as ActorRunTrace["status"])) {
          if (
            event.eventType !== "continuation_validation_failed" &&
            (event.eventType !== "external_event_validation_failed" ||
              lifecycle !== "waiting_external_event")
          ) {
            throw new Error(`Invalid TraceSnapshot: ${eventPath} occurs while the run is waiting`);
          }
        }
        if (event.eventType === "handoff") {
          handoffEvents.push({ index: eventIndex, data: event.data, stepKey: event.stepKey });
        }
        if (event.eventType === "final_output") finalOutputCount += 1;
    }
  }

  if (lifecycle === "not_started") {
    throw new Error(`Invalid TraceSnapshot: ${path} has no actor_run_start event`);
  }
  if (trace.status !== lifecycle) {
    throw new Error(`Invalid TraceSnapshot: ${path}.status does not match its lifecycle`);
  }
  if (terminalStatuses.has(trace.status)) {
    assertNonEmptyString(trace.endedAt, `${path}.endedAt`);
  } else if (trace.endedAt !== undefined) {
    throw new Error(`Invalid TraceSnapshot: ${path}.endedAt is only valid for a terminal run`);
  }

  if (trace.status === "handoff_requested") {
    if (
      schemaVersion !== TRACE_SNAPSHOT_SCHEMA_VERSION ||
      handoffEvents.length !== 1 ||
      finalOutputCount !== 0
    ) {
      throw new Error(`Invalid TraceSnapshot: ${path} must contain exactly one terminal handoff event`);
    }
    const handoff = handoffEvents[0];
    assertHandoffRequestData(
      trace,
      traceIndex,
      handoff.index,
      handoff.data,
      handoff.stepKey
    );
  } else if (
    schemaVersion === TRACE_SNAPSHOT_SCHEMA_VERSION &&
    handoffEvents.length !== 0
  ) {
    throw new Error(`Invalid TraceSnapshot: ${path} has a handoff event without a handoff terminal status`);
  }
}

/** Validate a TraceSnapshot before it can replace or join live Trace state. */
export function assertTraceSnapshot(snapshot: unknown): asserts snapshot is TraceSnapshot {
  if (
    !isRecord(snapshot) ||
    (snapshot.schemaVersion !== TRACE_SNAPSHOT_SCHEMA_VERSION &&
      snapshot.schemaVersion !== LEGACY_TRACE_SNAPSHOT_SCHEMA_VERSION)
  ) {
    throw new Error("Invalid TraceSnapshot: unsupported schemaVersion " +
      String(isRecord(snapshot) ? snapshot.schemaVersion : undefined));
  }
  assertNonEmptyString(snapshot.savedAt, "savedAt");
  if (!Array.isArray(snapshot.traces)) {
    throw new Error("Invalid TraceSnapshot: traces must be an array");
  }

  const actorRunIds = new Set<string>();
  for (const [traceIndex, candidate] of snapshot.traces.entries()) {
    const path = `traces[${traceIndex}]`;
    if (!isRecord(candidate)) {
      throw new Error(`Invalid TraceSnapshot: ${path} must be an object`);
    }
    assertNonEmptyString(candidate.actorRunId, `${path}.actorRunId`);
    assertNonEmptyString(candidate.actorId, `${path}.actorId`);
    assertNonEmptyString(candidate.skillId, `${path}.skillId`);
    assertNonEmptyString(candidate.startedAt, `${path}.startedAt`);
    if (actorRunIds.has(candidate.actorRunId)) {
      throw new Error(`Invalid TraceSnapshot: duplicate actorRunId ${candidate.actorRunId}`);
    }
    actorRunIds.add(candidate.actorRunId);
    const terminalStatuses = snapshot.schemaVersion === TRACE_SNAPSHOT_SCHEMA_VERSION
      ? TERMINAL_STATUSES
      : LEGACY_TERMINAL_STATUSES;
    if (!["running", ...WAITING_STATUSES, ...terminalStatuses].includes(
      candidate.status as ActorRunTrace["status"]
    )) {
      throw new Error(`Invalid TraceSnapshot: ${path}.status is invalid`);
    }
    if (!Array.isArray(candidate.events)) {
      throw new Error(`Invalid TraceSnapshot: ${path}.events must be an array`);
    }

    // v1 snapshots created by separate processes may both contain legacy
    // counter-based event IDs such as evt_1. Event identity is scoped to its
    // Actor run, while actorRunId is the globally unique merge key.
    const eventIds = new Set<string>();
    for (const [eventIndex, event] of candidate.events.entries()) {
      const eventPath = `${path}.events[${eventIndex}]`;
      if (!isRecord(event)) {
        throw new Error(`Invalid TraceSnapshot: ${eventPath} must be an object`);
      }
      assertNonEmptyString(event.eventId, `${eventPath}.eventId`);
      if (eventIds.has(event.eventId)) {
        throw new Error(`Invalid TraceSnapshot: duplicate eventId ${event.eventId}`);
      }
      eventIds.add(event.eventId);
      if (event.actorRunId !== candidate.actorRunId) {
        throw new Error(`Invalid TraceSnapshot: ${eventPath}.actorRunId does not match its trace`);
      }
      if (event.sequence !== eventIndex + 1) {
        throw new Error(`Invalid TraceSnapshot: ${eventPath}.sequence is not contiguous`);
      }
      if (!TRACE_EVENT_TYPES.has(event.eventType as TraceEventType)) {
        throw new Error(`Invalid TraceSnapshot: ${eventPath}.eventType is invalid`);
      }
      assertNonEmptyString(event.timestamp, `${eventPath}.timestamp`);
      if (event.stepKey !== undefined && typeof event.stepKey !== "string") {
        throw new Error(`Invalid TraceSnapshot: ${eventPath}.stepKey must be a string when present`);
      }
      if (!isRecord(event.data)) {
        throw new Error(`Invalid TraceSnapshot: ${eventPath}.data must be an object`);
      }
      assertJsonSafe(event.data, `${eventPath}.data`);
    }

    assertTraceLifecycle(
      candidate as unknown as ActorRunTrace,
      traceIndex,
      snapshot.schemaVersion
    );
  }
}

/** Validate either supported schema and detach it as the latest v2 shape. */
export function normalizeTraceSnapshot(snapshot: unknown): NormalizedTraceSnapshot {
  assertTraceSnapshot(snapshot);
  const normalized: NormalizedTraceSnapshot = {
    schemaVersion: TRACE_SNAPSHOT_SCHEMA_VERSION,
    savedAt: snapshot.savedAt,
    traces: JSON.parse(JSON.stringify(snapshot.traces)) as ActorRunTrace[],
  };
  assertTraceSnapshot(normalized);
  return normalized;
}
