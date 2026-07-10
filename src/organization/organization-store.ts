import type { OrganizationSnapshot } from "./organization-snapshot";

export interface OrganizationStore {
  load(organizationId: string): Promise<OrganizationSnapshot | null>;
  save(snapshot: OrganizationSnapshot): Promise<void>;
  delete(organizationId: string): Promise<void>;
  list(): Promise<OrganizationSnapshot[]>;
  clear(): Promise<void>;
}
