// ============================================================================
// ExternalEventValidation
// v0.4.5: lightweight schema and correlation checks for external events
// ============================================================================

import type { ExternalEventReceived, ExternalEventRequest } from "./external-event-runtime";

export interface ExternalEventValidationResult {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSchemaType(value: unknown): value is "string" | "number" | "boolean" | "object" | "array" {
  return value === "string" || value === "number" || value === "boolean" || value === "object" || value === "array";
}

function actualType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateValue(path: string, value: unknown, schema: Record<string, unknown>, errors: string[]): void {
  const expectedType = schema.type;
  if (isSchemaType(expectedType)) {
    const actual = actualType(value);
    if (actual !== expectedType) {
      errors.push(`${path} expected ${expectedType}, got ${actual}`);
      return;
    }
  }

  if (schema.type === "object" && isRecord(value) && isRecord(schema.properties)) {
    validateObject(path, value, schema, errors);
  }
}

function validateObject(path: string, payload: Record<string, unknown>, schema: Record<string, unknown>, errors: string[]): void {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const field of required) {
    if (typeof field !== "string") continue;
    if (!(field in payload)) {
      errors.push(`${path}.${field} is required`);
    }
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [field, propertySchema] of Object.entries(properties)) {
    if (!(field in payload)) continue;
    if (!isRecord(propertySchema)) continue;
    validateValue(`${path}.${field}`, payload[field], propertySchema, errors);
  }
}

export function validateExternalEventPayload(
  payload: unknown,
  schema?: Record<string, unknown>
): ExternalEventValidationResult {
  if (!schema) return { valid: true, errors: [] };

  const errors: string[] = [];
  validateValue("payload", payload, schema, errors);
  return { valid: errors.length === 0, errors };
}

export function validateExternalEventCorrelation(
  request: ExternalEventRequest,
  event: ExternalEventReceived
): ExternalEventValidationResult {
  if (!request.correlationKey) return { valid: true, errors: [] };

  if (!event.correlationKey) {
    return {
      valid: false,
      errors: [`correlationKey is required; expected ${request.correlationKey}`],
    };
  }

  if (request.correlationKey !== event.correlationKey) {
    return {
      valid: false,
      errors: [`correlationKey mismatch: expected ${request.correlationKey}, received ${event.correlationKey}`],
    };
  }

  return { valid: true, errors: [] };
}

export function validateExternalEventReceived(
  request: ExternalEventRequest,
  event: ExternalEventReceived
): ExternalEventValidationResult {
  const errors: string[] = [];

  if (request.externalEventRequestId !== event.externalEventRequestId) {
    errors.push(`externalEventRequestId mismatch: expected ${request.externalEventRequestId}, received ${event.externalEventRequestId}`);
  }
  if (request.eventName !== event.eventName) {
    errors.push(`eventName mismatch: expected ${request.eventName}, received ${event.eventName}`);
  }

  const correlation = validateExternalEventCorrelation(request, event);
  errors.push(...correlation.errors);

  const payload = validateExternalEventPayload(event.payload, request.eventSchema);
  errors.push(...payload.errors);

  return { valid: errors.length === 0, errors };
}

export function summarizePayload(payload: unknown): Record<string, unknown> {
  if (Array.isArray(payload)) {
    return { payloadType: "array", length: payload.length };
  }
  if (isRecord(payload)) {
    return { payloadType: "object", payloadKeys: Object.keys(payload).sort() };
  }
  return { payloadType: actualType(payload) };
}
