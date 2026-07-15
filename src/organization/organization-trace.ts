import { randomUUID } from "node:crypto";
import { OrganizationError } from "./organization-error";
import { assertJsonSafe } from "./organization-permission";

export const ORGANIZATION_TRACE_EVENT_TYPES = [
  "organization_created",
  "actor_registered",
  "permission_denied",
  "task_created",
  "task_assigned",
  "task_queued",
  "task_run_started",
  "task_delegated",
  "task_suspended",
  "task_resumed",
  "task_completed",
  "task_failed",
  "message_enqueued",
  "message_delivered",
  "message_acknowledged",
  "handoff_response_enqueued",
  "snapshot_created",
  "snapshot_restored",
] as const;

export type OrganizationTraceEventType = typeof ORGANIZATION_TRACE_EVENT_TYPES[number];

export interface OrganizationTraceEvent {
  eventId: string;
  organizationId: string;
  sequence: number;
  eventType: OrganizationTraceEventType;
  timestamp: string;
  actorId?: string;
  taskId?: string;
  messageId?: string;
  actorRunId?: string;
  handoffRequestId?: string;
  data: Record<string, unknown>;
}

export type OrganizationTraceContext = Pick<
  OrganizationTraceEvent,
  "actorId" | "taskId" | "messageId" | "actorRunId" | "handoffRequestId"
>;

const TRACE_EVENT_FIELDS = new Set([
  "eventId", "organizationId", "sequence", "eventType", "timestamp", "actorId", "taskId",
  "messageId", "actorRunId", "handoffRequestId", "data",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function assertOrganizationTraceEvent(
  value: unknown,
  expectedOrganizationId?: string
): asserts value is OrganizationTraceEvent {
  if (!isPlainRecord(value) || Object.keys(value).some((field) => !TRACE_EVENT_FIELDS.has(field))) {
    throw new OrganizationError("invalid_input", "Organization trace event has unsupported fields");
  }
  if (
    !isNonEmptyString(value.eventId) ||
    !isNonEmptyString(value.organizationId) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    !ORGANIZATION_TRACE_EVENT_TYPES.includes(value.eventType as OrganizationTraceEventType) ||
    !isNonEmptyString(value.timestamp) ||
    !isPlainRecord(value.data)
  ) {
    throw new OrganizationError("invalid_input", "Organization trace event has invalid fields");
  }
  if (expectedOrganizationId !== undefined && value.organizationId !== expectedOrganizationId) {
    throw new OrganizationError("cross_organization", "Organization trace snapshot crosses organizations");
  }
  for (const field of [
    "actorId", "taskId", "messageId", "actorRunId", "handoffRequestId",
  ] as const) {
    if (value[field] !== undefined && !isNonEmptyString(value[field])) {
      throw new OrganizationError("invalid_input", `Organization trace ${field} must be non-empty`);
    }
  }
  assertJsonSafe(value.data, `organization trace event ${value.eventId}.data`);
}

export function cloneOrganizationTraceEvent(event: OrganizationTraceEvent): OrganizationTraceEvent {
  return structuredClone(event);
}

export class OrganizationTrace {
  private events: OrganizationTraceEvent[] = [];

  constructor(public readonly organizationId: string) {}

  record(
    eventType: OrganizationTraceEventType,
    context: OrganizationTraceContext = {},
    data: Record<string, unknown> = {}
  ): OrganizationTraceEvent {
    if (!isPlainRecord(context)) {
      throw new OrganizationError("invalid_input", "Organization trace context must be a plain object");
    }
    if (!isPlainRecord(data)) {
      throw new OrganizationError("invalid_input", "Organization trace data must be a plain object");
    }
    if (!ORGANIZATION_TRACE_EVENT_TYPES.includes(eventType)) {
      throw new OrganizationError("invalid_input", `Unknown organization trace event ${String(eventType)}`);
    }
    const allowedContextFields = new Set([
      "actorId", "taskId", "messageId", "actorRunId", "handoffRequestId",
    ]);
    if (Object.keys(context).some((field) => !allowedContextFields.has(field))) {
      throw new OrganizationError("invalid_input", "Organization trace context has unsupported fields");
    }
    for (const [field, value] of Object.entries(context)) {
      if (!isNonEmptyString(value)) {
        throw new OrganizationError("invalid_input", `Organization trace ${field} must be non-empty`);
      }
    }
    assertJsonSafe(data, "organization trace data");
    const event: OrganizationTraceEvent = {
      eventId: `org_evt_${randomUUID()}`,
      organizationId: this.organizationId,
      sequence: this.events.length + 1,
      eventType,
      timestamp: new Date().toISOString(),
      ...context,
      data: structuredClone(data),
    };
    this.events.push(event);
    return structuredClone(event);
  }

  getEvents(): OrganizationTraceEvent[] {
    return structuredClone(this.events);
  }

  restore(events: OrganizationTraceEvent[]): void {
    const restored = structuredClone(events).sort((a, b) => a.sequence - b.sequence);
    const eventIds = new Set<string>();
    for (let index = 0; index < restored.length; index++) {
      const event = restored[index];
      assertOrganizationTraceEvent(event, this.organizationId);
      if (event.sequence !== index + 1) {
        throw new OrganizationError("invalid_input", "Organization trace sequence must be contiguous");
      }
      if (eventIds.has(event.eventId)) {
        throw new OrganizationError("invalid_input", `Duplicate organization trace event ${event.eventId}`);
      }
      eventIds.add(event.eventId);
    }
    this.events = restored;
  }
}
