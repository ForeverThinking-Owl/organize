// ============================================================================
// JsonRuntimeRecoveryStore
// v0.4.2: RuntimeRecoveryStore implementation backed by one local JSON file
// ============================================================================

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertMemorySnapshot } from "../memory/json-memory-store";
import { assertTraceSnapshot } from "../trace/json-trace-store";
import { assertPendingRunSnapshot } from "./json-pending-run-store";
import type { RuntimeRecoveryStore } from "./runtime-recovery-store";
import {
  RUNTIME_RECOVERY_STORE_SCHEMA_VERSION,
  assertRuntimeRecoveryBundle,
  type RuntimeRecoveryBundle,
  type RuntimeRecoveryStoreSnapshot,
} from "./runtime-recovery-bundle";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

export function assertRuntimeRecoveryStoreSnapshot(value: unknown): asserts value is RuntimeRecoveryStoreSnapshot {
  if (!isObject(value)) {
    throw new Error("Invalid RuntimeRecoveryStoreSnapshot: expected object");
  }
  if (value.schemaVersion !== RUNTIME_RECOVERY_STORE_SCHEMA_VERSION) {
    throw new Error("Invalid RuntimeRecoveryStoreSnapshot: unsupported schemaVersion " + String(value.schemaVersion));
  }
  if (typeof value.savedAt !== "string") {
    throw new Error("Invalid RuntimeRecoveryStoreSnapshot: savedAt must be a string");
  }
  if (!Array.isArray(value.bundles)) {
    throw new Error("Invalid RuntimeRecoveryStoreSnapshot: bundles must be an array");
  }
  const actorRunIds = new Set<string>();
  value.bundles.forEach((bundle) => {
    assertRuntimeRecoveryBundle(bundle);
    assertPendingRunSnapshot(bundle.pendingRun);
    assertTraceSnapshot(bundle.trace);
    assertMemorySnapshot(bundle.memory);
    if (actorRunIds.has(bundle.actorRunId)) {
      throw new Error(`Invalid RuntimeRecoveryStoreSnapshot: duplicate actorRunId ${bundle.actorRunId}`);
    }
    actorRunIds.add(bundle.actorRunId);
  });
}

function emptyStoreSnapshot(): RuntimeRecoveryStoreSnapshot {
  return {
    schemaVersion: RUNTIME_RECOVERY_STORE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    bundles: [],
  };
}

export async function saveRuntimeRecoveryStoreSnapshot(
  filePath: string,
  snapshot: RuntimeRecoveryStoreSnapshot
): Promise<void> {
  assertRuntimeRecoveryStoreSnapshot(snapshot);
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function loadRuntimeRecoveryStoreSnapshot(filePath: string): Promise<RuntimeRecoveryStoreSnapshot> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertRuntimeRecoveryStoreSnapshot(parsed);
  return parsed;
}

export class JsonRuntimeRecoveryStore implements RuntimeRecoveryStore {
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

  private async loadStore(): Promise<RuntimeRecoveryStoreSnapshot> {
    try {
      return await loadRuntimeRecoveryStoreSnapshot(this.filePath);
    } catch (error) {
      if (isFileNotFound(error)) return emptyStoreSnapshot();
      throw error;
    }
  }

  async load(actorRunId: string): Promise<RuntimeRecoveryBundle | null> {
    await this.waitForMutations();
    const store = await this.loadStore();
    const bundle = store.bundles.find((item) => item.actorRunId === actorRunId);
    return bundle ? structuredClone(bundle) : null;
  }

  async save(bundle: RuntimeRecoveryBundle): Promise<void> {
    assertRuntimeRecoveryBundle(bundle);
    assertPendingRunSnapshot(bundle.pendingRun);
    assertTraceSnapshot(bundle.trace);
    assertMemorySnapshot(bundle.memory);

    const storedBundle = structuredClone(bundle);
    await this.enqueueMutation(async () => {
      const store = await this.loadStore();
      const remaining = store.bundles.filter((item) => item.actorRunId !== storedBundle.actorRunId);
      await saveRuntimeRecoveryStoreSnapshot(this.filePath, {
        schemaVersion: RUNTIME_RECOVERY_STORE_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        bundles: [...remaining, storedBundle],
      });
    });
  }

  async delete(actorRunId: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const store = await this.loadStore();
      await saveRuntimeRecoveryStoreSnapshot(this.filePath, {
        schemaVersion: RUNTIME_RECOVERY_STORE_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        bundles: store.bundles.filter((bundle) => bundle.actorRunId !== actorRunId),
      });
    });
  }

  async list(): Promise<RuntimeRecoveryBundle[]> {
    await this.waitForMutations();
    const store = await this.loadStore();
    return structuredClone(store.bundles);
  }

  async clear(): Promise<void> {
    await this.enqueueMutation(async () => {
      await rm(this.filePath, { force: true });
    });
  }
}
