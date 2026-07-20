// ============================================================================
// HandoffRuntime — terminal Actor-to-Actor handoff contract
// ============================================================================

import { randomUUID } from "node:crypto";
import type { HandoffDecision } from "../core/types/actor-decision";
import type { HandoffStep } from "../core/types/skill";
import { resolveTemplateValue, type SkillState } from "./skill-runtime";

export interface HandoffRequest {
  handoffRequestId: string;
  actorRunId: string;
  sourceActorId: string;
  sourceSkillId: string;
  stepKey: string;
  targetActorId: string;
  targetSkillId: string;
  reason: string;
  handoffContext: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonSafetyError(
  value: unknown,
  path: string,
  ancestors = new Set<object>()
): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : `${path} must contain finite numbers`;
  }
  if (typeof value !== "object") return `${path} is not JSON-safe`;
  if (ancestors.has(value)) return `${path} contains a circular reference`;

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) return `${path}[${index}] is a sparse array entry`;
      const error = jsonSafetyError(value[index], `${path}[${index}]`, ancestors);
      if (error) return error;
    }
  } else {
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
      return `${path} must be a plain JSON object`;
    }
    for (const [key, item] of Object.entries(value)) {
      const error = jsonSafetyError(item, `${path}.${key}`, ancestors);
      if (error) return error;
    }
  }
  ancestors.delete(value);
  return null;
}

function containsUnresolvedTemplate(value: unknown): boolean {
  if (typeof value === "string") return /\{\{[^{}]+\}\}/.test(value);
  if (Array.isArray(value)) return value.some(containsUnresolvedTemplate);
  if (isPlainRecord(value)) return Object.values(value).some(containsUnresolvedTemplate);
  return false;
}

/** Resolve a handoff input mapping without permitting unresolved or unsafe data. */
export function buildHandoffContext(
  step: HandoffStep,
  state: SkillState
): Record<string, unknown> {
  // A null-prototype staging object preserves JSON keys such as "__proto__"
  // as data instead of invoking Object.prototype setters.
  const context = Object.create(null) as Record<string, unknown>;
  for (const [key, template] of Object.entries(step.inputMapping)) {
    const value = resolveTemplateValue(template, state);
    if (containsUnresolvedTemplate(value)) {
      throw new Error(
        `Handoff step ${step.stepKey} inputMapping.${key} contains an unresolved template`
      );
    }
    const error = jsonSafetyError(value, `handoffContext.${key}`);
    if (error) throw new Error(`Handoff step ${step.stepKey}: ${error}`);
    context[key] = value;
  }

  // Detach mapped data from mutable Skill state before crossing the runtime
  // boundary. The prior checks guarantee JSON serialization is lossless.
  return JSON.parse(JSON.stringify(context)) as Record<string, unknown>;
}

/** Create the immutable runtime-owned request identity for a valid decision. */
export function createHandoffRequest(input: {
  decision: HandoffDecision;
  actorRunId: string;
  sourceActorId: string;
  sourceSkillId: string;
  stepKey: string;
}): HandoffRequest {
  const { decision } = input;
  for (const [field, value] of [
    ["targetActorId", decision.targetActorId],
    ["targetSkillId", decision.targetSkillId],
    ["reason", decision.reason],
    ["actorRunId", input.actorRunId],
    ["sourceActorId", input.sourceActorId],
    ["sourceSkillId", input.sourceSkillId],
    ["stepKey", input.stepKey],
  ] as const) {
    if (value.length === 0) throw new Error(`HandoffRequest ${field} must be non-empty`);
  }
  const contextError = jsonSafetyError(decision.handoffContext, "handoffContext");
  if (contextError) throw new Error(`Invalid HandoffRequest: ${contextError}`);

  return {
    handoffRequestId: `hreq_${randomUUID()}`,
    actorRunId: input.actorRunId,
    sourceActorId: input.sourceActorId,
    sourceSkillId: input.sourceSkillId,
    stepKey: input.stepKey,
    targetActorId: decision.targetActorId,
    targetSkillId: decision.targetSkillId,
    reason: decision.reason,
    handoffContext: JSON.parse(JSON.stringify(decision.handoffContext)) as Record<string, unknown>,
  };
}
