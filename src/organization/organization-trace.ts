import { randomUUID } from "node:crypto";

export type OrganizationTraceEventType =
  | "organization_created"
  | "actor_registered"
  | "permission_denied"
  | "task_created"
  | "task_assigned"
  | "task_queued"
  | "task_run_started"
  | "task_suspended"
  | "task_resumed"
  | "task_completed"
  | "task_failed"
  | "message_enqueued"
  | "message_delivered"
  | "message_acknowledged"
  | "snapshot_created"
  | "snapshot_restored";

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
  data: Record<string, unknown>;
}

export type OrganizationTraceContext = Pick<
  OrganizationTraceEvent,
  "actorId" | "taskId" | "messageId" | "actorRunId"
>;

export class OrganizationTrace {
  private events: OrganizationTraceEvent[] = [];

  constructor(public readonly organizationId: string) {}

  record(
    eventType: OrganizationTraceEventType,
    context: OrganizationTraceContext = {},
    data: Record<string, unknown> = {}
  ): OrganizationTraceEvent {
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
    if (events.some((event) => event.organizationId !== this.organizationId)) {
      throw new Error("Organization trace snapshot crosses organizations");
    }
    this.events = structuredClone(events).sort((a, b) => a.sequence - b.sequence);
  }
}
