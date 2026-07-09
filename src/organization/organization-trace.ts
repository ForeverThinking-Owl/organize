// ============================================================================
// Organization Trace
// ============================================================================

export type OrganizationTraceEventType =
  | "organization_created"
  | "actor_registered"
  | "task_created"
  | "task_assigned"
  | "message_sent"
  | "message_received"
  | "task_completed";

export interface OrganizationTraceEvent {
  eventType: OrganizationTraceEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export class OrganizationTrace {
  private events: OrganizationTraceEvent[] = [];

  record(eventType: OrganizationTraceEventType, data: Record<string, unknown>): void {
    this.events.push({
      eventType,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  getEvents(): OrganizationTraceEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}

export const organizationTrace = new OrganizationTrace();
