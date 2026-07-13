// ============================================================================
// JsonPendingRunStore
// v0.4.5: PendingRunStore implementation validates external event waits
// ============================================================================

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PENDING_RUN_STORE_SCHEMA_VERSION,
  type PendingRunSnapshot,
  type PendingRunStoreSnapshot,
} from "./pending-run-snapshot";
import { assertPendingRunSnapshot } from "./pending-run-validation";
import type { PendingRunStore } from "./pending-run-store";

export { assertPendingRunSnapshot } from "./pending-run-validation";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

export function assertPendingRunStoreSnapshot(value: unknown): asserts value is PendingRunStoreSnapshot {
  if (!isObject(value)) {
    throw new Error("Invalid PendingRunStoreSnapshot: expected object");
  }
  if (value.schemaVersion !== PENDING_RUN_STORE_SCHEMA_VERSION) {
    throw new Error("Invalid PendingRunStoreSnapshot: unsupported schemaVersion " + String(value.schemaVersion));
  }
  if (typeof value.savedAt !== "string") {
    throw new Error("Invalid PendingRunStoreSnapshot: savedAt must be a string");
  }
  if (!Array.isArray(value.runs)) {
    throw new Error("Invalid PendingRunStoreSnapshot: runs must be an array");
  }
  const actorRunIds = new Set<string>();
  value.runs.forEach((run) => {
    assertPendingRunSnapshot(run);
    if (actorRunIds.has(run.actorRunId)) {
      throw new Error(`Invalid PendingRunStoreSnapshot: duplicate actorRunId ${run.actorRunId}`);
    }
    actorRunIds.add(run.actorRunId);
  });
}

function emptyStoreSnapshot(): PendingRunStoreSnapshot {
  return {
    schemaVersion: PENDING_RUN_STORE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    runs: [],
  };
}

export async function savePendingRunStoreSnapshot(filePath: string, snapshot: PendingRunStoreSnapshot): Promise<void> {
  assertPendingRunStoreSnapshot(snapshot);
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function loadPendingRunStoreSnapshot(filePath: string): Promise<PendingRunStoreSnapshot> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertPendingRunStoreSnapshot(parsed);
  return parsed;
}

export class JsonPendingRunStore implements PendingRunStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private enqueueMutation(mutation: () => Promise<void>): Promise<void> {
    const queued = this.mutationTail.then(mutation);
    this.mutationTail = queued.catch(() => undefined);
    return queued;
  }

  private async waitForMutations(): Promise<void> {
    await this.mutationTail;
  }

  private async loadStore(): Promise<PendingRunStoreSnapshot> {
    try {
      return await loadPendingRunStoreSnapshot(this.filePath);
    } catch (error) {
      if (isFileNotFound(error)) return emptyStoreSnapshot();
      throw error;
    }
  }

  async load(actorRunId: string): Promise<PendingRunSnapshot | null> {
    await this.waitForMutations();
    const store = await this.loadStore();
    const run = store.runs.find((item) => item.actorRunId === actorRunId);
    return run ? structuredClone(run) : null;
  }

  async save(snapshot: PendingRunSnapshot): Promise<void> {
    assertPendingRunSnapshot(snapshot);
    const storedSnapshot = structuredClone(snapshot);
    await this.enqueueMutation(async () => {
      const store = await this.loadStore();
      const remaining = store.runs.filter((run) => run.actorRunId !== storedSnapshot.actorRunId);
      await savePendingRunStoreSnapshot(this.filePath, {
        schemaVersion: PENDING_RUN_STORE_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        runs: [...remaining, storedSnapshot],
      });
    });
  }

  async delete(actorRunId: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const store = await this.loadStore();
      await savePendingRunStoreSnapshot(this.filePath, {
        schemaVersion: PENDING_RUN_STORE_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        runs: store.runs.filter((run) => run.actorRunId !== actorRunId),
      });
    });
  }

  async list(): Promise<PendingRunSnapshot[]> {
    await this.waitForMutations();
    const store = await this.loadStore();
    return structuredClone(store.runs);
  }

  async clear(): Promise<void> {
    await this.enqueueMutation(async () => {
      await rm(this.filePath, { force: true });
    });
  }
}
