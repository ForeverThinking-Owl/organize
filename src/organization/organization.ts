import { randomUUID } from "node:crypto";

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

export function createOrganization(input: CreateOrganizationInput): Organization {
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
