// ============================================================================
// ExternalEventRuntime
// v0.4.5: runtime helpers for wait_external_event waiting / continue semantics
// ============================================================================

import type { WaitExternalEventStep } from "../core/types/skill";
import { traceLogger } from "../trace/trace-logger";
import { resolveTemplateValue, type SkillState } from "./skill-runtime";
import { summarizePayload } from "./external-event-validation";

export interface ExternalEventRequest {
  externalEventRequestId: string;
  stepKey: string;
  eventName: string;
  correlationKey?: string;
  reason?: string;
  outputKey: string;
  eventSchema?: Record<string, unknown>;
}

export interface ExternalEventReceived {
  externalEventRequestId: string;
  eventName: string;
  correlationKey?: string;
  payload: unknown;
  receivedBy?: string;
  receivedAt?: string;
}

export interface ExternalEventRecord {
  externalEventRequestId: string;
  eventName: string;
  correlationKey?: string;
  payload: unknown;
  receivedBy?: string;
  receivedAt: string;
}

function optionalResolvedString(template: string | undefined, state: SkillState): string | undefined {
  if (template === undefined) return undefined;
  const value = resolveTemplateValue(template, state);
  if (value === undefined || value === null) return undefined;
  return String(value);
}

export function buildExternalEventRequest(
  step: WaitExternalEventStep,
  state: SkillState,
  actorRunId: string
): ExternalEventRequest {
  const request: ExternalEventRequest = {
    externalEventRequestId: `evt_wait_${step.stepKey}_${Date.now()}`,
    stepKey: step.stepKey,
    eventName: step.eventName,
    correlationKey: optionalResolvedString(step.correlationKey, state),
    reason: step.reason,
    outputKey: step.outputKey,
    eventSchema: step.eventSchema,
  };

  traceLogger.record(actorRunId, "skill_step_start", {
    stepKey: step.stepKey,
    stepType: "wait_external_event",
  });

  traceLogger.record(actorRunId, "external_event_requested", {
    ...request,
  });

  return request;
}

export function applyExternalEventReceived(
  request: ExternalEventRequest,
  event: ExternalEventReceived,
  state: SkillState,
  actorRunId: string
): ExternalEventRecord {
  const record: ExternalEventRecord = {
    externalEventRequestId: request.externalEventRequestId,
    eventName: event.eventName,
    correlationKey: request.correlationKey,
    payload: event.payload,
    receivedBy: event.receivedBy,
    receivedAt: event.receivedAt ?? new Date().toISOString(),
  };

  state.steps[request.stepKey] = record;
  state.outputs[request.outputKey] = record;

  traceLogger.record(actorRunId, "external_event_received", {
    externalEventRequestId: request.externalEventRequestId,
    stepKey: request.stepKey,
    eventName: event.eventName,
    correlationKey: request.correlationKey,
    receivedBy: event.receivedBy,
    receivedAt: record.receivedAt,
    payloadSummary: summarizePayload(event.payload),
  });

  traceLogger.record(actorRunId, "skill_step_end", {
    stepKey: request.stepKey,
    outputKey: request.outputKey,
    eventName: event.eventName,
  });

  return record;
}
