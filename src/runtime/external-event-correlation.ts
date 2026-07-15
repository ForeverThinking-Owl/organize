// ============================================================================
// ExternalEventCorrelation
// v0.5.1: correlation-specific template resolution with fail-closed semantics
// ============================================================================

import type { WaitExternalEventStep } from "../core/types/skill";
import {
  resolveTemplateValue,
  type SkillState,
} from "./skill-runtime";
import { validateResolvedExternalEventCorrelationKey } from "./external-event-validation";

type CorrelationStep = Pick<WaitExternalEventStep, "stepKey" | "correlationKey">;

function unsafeCorrelation(stepKey: string, errors: string[]): never {
  throw new Error(
    `Unsafe external event correlationKey at step ${stepKey}: ${errors.join("; ")}`
  );
}

function validateCorrelationValue(value: unknown, stepKey: string): string {
  const validation = validateResolvedExternalEventCorrelationKey(value, true);
  if (!validation.valid) unsafeCorrelation(stepKey, validation.errors);
  return String(value);
}

/**
 * Resolve a configured external-event correlation key without inheriting the
 * generic Tool-template behavior that JSON-stringifies object values.
 *
 * Every interpolation token is validated before it is added to a surrounding
 * string. This prevents partial templates such as `tenant/{{context.id}}` from
 * accepting objects, arrays, blanks, or unresolved values.
 */
export function resolveExternalEventCorrelationKey(
  step: CorrelationStep,
  state: SkillState
): string | undefined {
  const template = step.correlationKey;
  if (template === undefined) return undefined;

  const fullMatch = template.match(/^\s*\{\{([^}]+)\}\}\s*$/);
  if (fullMatch) {
    const resolved = resolveTemplateValue(`{{${fullMatch[1]}}}`, state);
    return validateCorrelationValue(resolved, step.stepKey);
  }

  const resolved = template.replace(/\{\{([^}]+)\}\}/g, (_token, path: string) => {
    const tokenValue = resolveTemplateValue(`{{${path}}}`, state);
    return validateCorrelationValue(tokenValue, step.stepKey);
  });

  return validateCorrelationValue(resolved, step.stepKey);
}
