import { OrganizationError } from "./organization-error";

export const ORGANIZATION_CAPABILITIES = [
  "organization:manage",
  "task:create",
  "task:assign",
  "task:execute",
  "task:delegate",
  "message:send",
  "message:receive",
  "organization:snapshot",
  "approval:decide",
  "event:receive",
] as const;

export type OrganizationCapability = typeof ORGANIZATION_CAPABILITIES[number];

export function isOrganizationCapability(value: unknown): value is OrganizationCapability {
  return ORGANIZATION_CAPABILITIES.some((capability) => capability === value);
}

export interface OrganizationPrincipal {
  actorId: string;
  status: "active" | "inactive";
  capabilities: OrganizationCapability[];
}

export function assertCapability(
  actor: OrganizationPrincipal,
  capability: OrganizationCapability
): void {
  if (actor.status !== "active") {
    throw new OrganizationError("permission_denied", `Actor ${actor.actorId} is inactive`);
  }
  if (!actor.capabilities.includes(capability)) {
    throw new OrganizationError(
      "permission_denied",
      `Actor ${actor.actorId} lacks capability ${capability}`
    );
  }
}

export function assertJsonSafe(value: unknown, path = "value", seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OrganizationError("invalid_input", `${path} must contain finite numbers`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new OrganizationError("invalid_input", `${path} is not JSON-safe`);
  }
  if (seen.has(value)) {
    throw new OrganizationError("invalid_input", `${path} contains a circular reference`);
  }

  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        throw new OrganizationError("invalid_input", `${path}[${index}] is a sparse array entry`);
      }
      assertJsonSafe(value[index], `${path}[${index}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new OrganizationError("invalid_input", `${path} must be a plain JSON object`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafe(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}
