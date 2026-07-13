// ============================================================================
// Process-wide Organization operation lease
//
// OrganizationRuntime instances share the singleton Memory/Trace services.
// Track in-flight work by organization id at that same process scope so a
// second runtime instance cannot clear shared state owned by an active run.
// ============================================================================

const activeOperations = new Map<string, number>();
const organizationOwners = new Map<string, symbol>();
const standaloneRuns = new Map<string, Set<string>>();

export function claimOrganizationOwnership(organizationId: string, owner: symbol): boolean {
  const current = organizationOwners.get(organizationId);
  if (current && current !== owner) return false;
  if ((standaloneRuns.get(organizationId)?.size ?? 0) > 0) return false;
  organizationOwners.set(organizationId, owner);
  return true;
}

export function claimStandaloneOrganizationRun(
  organizationId: string,
  actorRunId: string,
  organizationOwner?: symbol
): boolean {
  const currentOwner = organizationOwners.get(organizationId);
  if (currentOwner) return currentOwner === organizationOwner;
  const runs = standaloneRuns.get(organizationId) ?? new Set<string>();
  runs.add(actorRunId);
  standaloneRuns.set(organizationId, runs);
  return true;
}

export function releaseStandaloneOrganizationRun(
  organizationId: string,
  actorRunId: string
): void {
  const runs = standaloneRuns.get(organizationId);
  if (!runs) return;
  runs.delete(actorRunId);
  if (runs.size === 0) standaloneRuns.delete(organizationId);
}

export function hasStandaloneOrganizationRuns(organizationId: string): boolean {
  return (standaloneRuns.get(organizationId)?.size ?? 0) > 0;
}

export function hasOrganizationOwner(organizationId: string): boolean {
  return organizationOwners.has(organizationId);
}

export function isOrganizationOwner(organizationId: string, owner: symbol): boolean {
  return organizationOwners.get(organizationId) === owner;
}

export function releaseOrganizationOwnership(organizationId: string, owner: symbol): void {
  if (organizationOwners.get(organizationId) === owner) {
    organizationOwners.delete(organizationId);
  }
}

export function beginOrganizationOperation(organizationId: string): void {
  activeOperations.set(organizationId, (activeOperations.get(organizationId) ?? 0) + 1);
}

export function endOrganizationOperation(organizationId: string): void {
  const remaining = (activeOperations.get(organizationId) ?? 0) - 1;
  if (remaining > 0) {
    activeOperations.set(organizationId, remaining);
  } else {
    activeOperations.delete(organizationId);
  }
}

export function hasActiveOrganizationOperation(organizationId: string): boolean {
  return (activeOperations.get(organizationId) ?? 0) > 0;
}
