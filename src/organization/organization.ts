import { randomUUID } from "node:crypto";
import { OrganizationError } from "./organization-error";

export interface OrganizationUnit {
  unitId: string;
  name: string;
  parentUnitId?: string;
}

export interface Organization {
  organizationId: string;
  name: string;
  description?: string;
  units: OrganizationUnit[];
  actorIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrganizationInput {
  organizationId?: string;
  name: string;
  description?: string;
  units?: OrganizationUnit[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OrganizationError("invalid_input", `${path} must be a non-empty string`);
  }
}

function assertUnits(value: unknown, path: string): asserts value is OrganizationUnit[] {
  if (!Array.isArray(value)) {
    throw new OrganizationError("invalid_input", `${path} must be an array`);
  }

  const unitIds = new Set<string>();
  for (const [index, unit] of value.entries()) {
    const unitPath = `${path}[${index}]`;
    if (!isRecord(unit)) {
      throw new OrganizationError("invalid_input", `${unitPath} must be an object`);
    }
    const allowedFields = new Set(["unitId", "name", "parentUnitId"]);
    if (Object.keys(unit).some((field) => !allowedFields.has(field))) {
      throw new OrganizationError("invalid_input", `${unitPath} has unsupported fields`);
    }
    requireNonEmptyString(unit.unitId, `${unitPath}.unitId`);
    requireNonEmptyString(unit.name, `${unitPath}.name`);
    if (unit.parentUnitId !== undefined) {
      requireNonEmptyString(unit.parentUnitId, `${unitPath}.parentUnitId`);
    }
    if (unitIds.has(unit.unitId)) {
      throw new OrganizationError("invalid_input", `Duplicate organization unit ${unit.unitId}`);
    }
    unitIds.add(unit.unitId);
  }

  const parentByUnit = new Map(
    value.map((unit) => [unit.unitId, unit.parentUnitId] as const)
  );
  for (const unit of value) {
    if (unit.parentUnitId && !unitIds.has(unit.parentUnitId)) {
      throw new OrganizationError(
        "invalid_input",
        `Organization unit ${unit.unitId} has missing parent ${unit.parentUnitId}`
      );
    }
    const visited = new Set<string>();
    let current: string | undefined = unit.unitId;
    while (current) {
      if (visited.has(current)) {
        throw new OrganizationError("invalid_input", `Organization unit hierarchy contains a cycle at ${current}`);
      }
      visited.add(current);
      current = parentByUnit.get(current);
    }
  }
}

export function assertOrganization(value: unknown): asserts value is Organization {
  if (!isRecord(value)) {
    throw new OrganizationError("invalid_input", "organization must be an object");
  }
  const allowedFields = new Set([
    "organizationId", "name", "description", "units", "actorIds", "createdAt", "updatedAt",
  ]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new OrganizationError("invalid_input", "organization has unsupported fields");
  }
  requireNonEmptyString(value.organizationId, "organization.organizationId");
  requireNonEmptyString(value.name, "organization.name");
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new OrganizationError("invalid_input", "organization.description must be a string");
  }
  assertUnits(value.units, "organization.units");
  if (!Array.isArray(value.actorIds)) {
    throw new OrganizationError("invalid_input", "organization.actorIds must be an array");
  }
  value.actorIds.forEach((actorId, index) =>
    requireNonEmptyString(actorId, `organization.actorIds[${index}]`)
  );
  if (new Set(value.actorIds).size !== value.actorIds.length) {
    throw new OrganizationError("invalid_input", "organization.actorIds must not contain duplicates");
  }
  requireNonEmptyString(value.createdAt, "organization.createdAt");
  requireNonEmptyString(value.updatedAt, "organization.updatedAt");
}

function assertCreateOrganizationInput(value: unknown): asserts value is CreateOrganizationInput {
  if (!isRecord(value)) {
    throw new OrganizationError("invalid_input", "organization input must be an object");
  }
  const allowedFields = new Set(["organizationId", "name", "description", "units"]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new OrganizationError("invalid_input", "organization input has unsupported fields");
  }
  if (value.organizationId !== undefined) {
    requireNonEmptyString(value.organizationId, "organizationId");
  }
  requireNonEmptyString(value.name, "name");
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new OrganizationError("invalid_input", "description must be a string");
  }
  assertUnits(value.units ?? [], "units");
}

export function createOrganization(input: CreateOrganizationInput): Organization {
  assertCreateOrganizationInput(input);
  const now = new Date().toISOString();
  return {
    organizationId: input.organizationId ?? `org_${randomUUID()}`,
    name: input.name,
    description: input.description,
    units: structuredClone(input.units ?? []),
    actorIds: [],
    createdAt: now,
    updatedAt: now,
  };
}
