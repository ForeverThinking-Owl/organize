import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ORGANIZATION_STORE_SCHEMA_VERSION,
  assertOrganizationSnapshot,
  assertOrganizationStoreSnapshot,
  type OrganizationSnapshot,
  type OrganizationStoreSnapshot,
} from "./organization-snapshot";
import type { OrganizationStore } from "./organization-store";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class JsonOrganizationStore implements OrganizationStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private enqueueMutation(mutation: () => Promise<void>): Promise<void> {
    const queuedMutation = this.mutationTail.then(mutation);
    this.mutationTail = queuedMutation.catch(() => undefined);
    return queuedMutation;
  }

  private async waitForMutations(): Promise<void> {
    await this.mutationTail;
  }

  private async readStore(): Promise<OrganizationStoreSnapshot> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      assertOrganizationStoreSnapshot(parsed);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          schemaVersion: ORGANIZATION_STORE_SCHEMA_VERSION,
          savedAt: new Date().toISOString(),
          organizations: [],
        };
      }
      throw error;
    }
  }

  private async writeStore(store: OrganizationStoreSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(store, null, 2), "utf8");
    await rename(temporaryPath, this.filePath);
  }

  async load(organizationId: string): Promise<OrganizationSnapshot | null> {
    await this.waitForMutations();
    const snapshot = (await this.readStore()).organizations.find(
      (item) => item.organization.organizationId === organizationId
    );
    return snapshot ? clone(snapshot) : null;
  }

  async save(snapshot: OrganizationSnapshot): Promise<void> {
    assertOrganizationSnapshot(snapshot);
    const storedSnapshot = clone(snapshot);
    await this.enqueueMutation(async () => {
      const store = await this.readStore();
      const organizationId = storedSnapshot.organization.organizationId;
      const organizations = store.organizations.filter(
        (item) => item.organization.organizationId !== organizationId
      );
      organizations.push(storedSnapshot);
      await this.writeStore({
        schemaVersion: ORGANIZATION_STORE_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        organizations,
      });
    });
  }

  async delete(organizationId: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const store = await this.readStore();
      await this.writeStore({
        ...store,
        savedAt: new Date().toISOString(),
        organizations: store.organizations.filter(
          (snapshot) => snapshot.organization.organizationId !== organizationId
        ),
      });
    });
  }

  async list(): Promise<OrganizationSnapshot[]> {
    await this.waitForMutations();
    return clone((await this.readStore()).organizations);
  }

  async clear(): Promise<void> {
    await this.enqueueMutation(async () => {
      await rm(this.filePath, { force: true });
    });
  }
}
