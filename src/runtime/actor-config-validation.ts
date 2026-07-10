import type { ActorConfig } from "../core/types/actor";

function invalid(message: string): never {
  throw new Error(`Invalid ActorConfig: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonSafe(
  value: unknown,
  path: string,
  ancestors = new Set<object>()
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} must contain finite numbers`);
    return;
  }
  if (typeof value !== "object") invalid(`${path} is not JSON-safe`);
  if (ancestors.has(value)) invalid(`${path} contains a circular reference`);

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) invalid(`${path}[${index}] is a sparse array entry`);
      assertJsonSafe(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      invalid(`${path} must be a plain JSON object`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafe(item, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function requireString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    invalid(`${path} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array`);
  value.forEach((item, index) => requireString(item, `${path}[${index}]`));
  if (new Set(value).size !== value.length) invalid(`${path} must not contain duplicates`);
  return value as string[];
}

function assertConditions(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) invalid(`${path} must be an array`);
  value.forEach((condition, index) => {
    if (!isRecord(condition)) invalid(`${path}[${index}] must be an object`);
    requireString(condition.field, `${path}[${index}].field`);
    if (!["<=", ">=", "<", ">", "==", "!="].includes(String(condition.operator))) {
      invalid(`${path}[${index}].operator is unsupported`);
    }
    if (!["string", "number", "boolean"].includes(typeof condition.value)) {
      invalid(`${path}[${index}].value has an unsupported type`);
    }
  });
}

export function assertActorConfig(value: unknown): asserts value is ActorConfig {
  if (!isRecord(value)) invalid("expected object");
  requireString(value.actor_id, "actor_id");
  if (value.organization_id !== undefined) requireString(value.organization_id, "organization_id");
  if (value.unit_id !== undefined) requireString(value.unit_id, "unit_id");
  requireString(value.name, "name");
  if (!["ai", "human", "hybrid", "system"].includes(String(value.type))) {
    invalid("type is unsupported");
  }
  requireString(value.role, "role");
  requireString(value.responsibility, "responsibility", true);
  if (![
    "L0_observe_only",
    "L1_suggest_only",
    "L2_read_and_draft",
    "L3_low_risk_execute",
    "L4_governed_execute",
  ].includes(String(value.autonomy_level))) {
    invalid("autonomy_level is unsupported");
  }
  stringArray(value.memory, "memory");

  if (!isRecord(value.permissions)) invalid("permissions must be an object");
  const allowedTools = stringArray(value.permissions.allowed_tools, "permissions.allowed_tools");
  const deniedTools = stringArray(value.permissions.denied_tools, "permissions.denied_tools");
  if (allowedTools.some((toolName) => deniedTools.includes(toolName))) {
    invalid("allowed_tools and denied_tools must not overlap");
  }
  if (value.permissions.allowed_skills !== undefined) {
    stringArray(value.permissions.allowed_skills, "permissions.allowed_skills");
  }
  if (value.permissions.denied_fields !== undefined) {
    stringArray(value.permissions.denied_fields, "permissions.denied_fields");
  }

  if (!isRecord(value.approval_judgment)) {
    invalid("approval_judgment must be an object");
  }
  stringArray(
    value.approval_judgment.must_request_approval_when,
    "approval_judgment.must_request_approval_when"
  );
  if (value.approval_judgment.can_approve !== undefined) {
    if (!Array.isArray(value.approval_judgment.can_approve)) {
      invalid("approval_judgment.can_approve must be an array");
    }
    value.approval_judgment.can_approve.forEach((authority, index) => {
      if (!isRecord(authority)) {
        invalid(`approval_judgment.can_approve[${index}] must be an object`);
      }
      requireString(authority.tool_name, `approval_judgment.can_approve[${index}].tool_name`);
      assertConditions(authority.conditions, `approval_judgment.can_approve[${index}].conditions`);
      assertConditions(
        authority.must_escalate_when,
        `approval_judgment.can_approve[${index}].must_escalate_when`
      );
    });
  }

  assertJsonSafe(value, "config");
}
