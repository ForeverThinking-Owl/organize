// ============================================================================
// Organization Core Model
// v0.5.0: organization layer foundation
// ============================================================================

export interface Organization {
  organizationId: string;
  name: string;
  description?: string;
  actorIds: string[];
  units: OrganizationUnit[];
  createdAt: string;
}

export interface OrganizationUnit {
  unitId: string;
  name: string;
  actorIds: string[];
  parentUnitId?: string;
}

export interface ActorMembership {
  actorId: string;
  organizationId: string;
  unitId?: string;
  role: string;
  responsibility?: string;
}

export function createOrganization(name: string, organizationId = `org_${Date.now()}`): Organization {
  return {
    organizationId,
    name,
    actorIds: [],
    units: [],
    createdAt: new Date().toISOString(),
  };
}
