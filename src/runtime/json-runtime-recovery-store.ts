// ============================================================================
// JsonRuntimeRecoveryStore
// v0.4.2: RuntimeRecoveryStore implementation backed by one local JSON file
// ============================================================================

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  value.bundles.forEach((bundle) => {
    assertRuntimeRecoveryBundle(bundle);
    assertPendingRunSnapshot(bundle.pendingRun);
    assertTraceSnapshot(bundle.trace);
    assertMemorySnapshot(bundle.memory);
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
  await writeFile(filePath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

export async function loadRuntimeRecoveryStoreSnapshot(filePath: string): Promise<RuntimeRecoveryStoreSnapshot> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertRuntimeRecoveryStoreSnapshot(parsed);
  return parsed;
}

export class JsonRuntimeRecoveryStore implements RuntimeRecoveryStore {
  constructor(private readonly filePath: string) {}

  private async loadStore(): Promise<RuntimeRecoveryStoreSnapshot> {
    try {
      return await loadRuntimeRecoveryStoreSnapshot(this.filePath);
    } catch (error) {
      if (isFileNotFound(error)) return emptyStoreSnapshot();
      throw error;
    }
  }

  async load(actorRunId: string): Promise<RuntimeRecoveryBundle | null> {
    const store = await this.loadStore();
    return store.bundles.find((bundle) => bundle.actorRunId === actorRunId) ?? null;
  }

  async save(bundle: RuntimeRecoveryBundle): Promise<void> {
    assertRuntimeRecoveryBundle(bundle);
    assertPendingRunSnapshot(bundle.pendingRun);
    assertTraceSnapshot(bundle.trace);
    assertMemorySnapshot(bundle.memory);

    const store = await this.loadStore();
    const remaining = store.bundles.filter((item) => item.actorRunId !== bundle.actorRunId);
    await saveRuntimeRecoveryStoreSnapshot(this.filePath, {
      schemaVersion: RUNTIME_RECOVERY_STORE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      bundles: [...remaining, bundle],
    });
  }

  async delete(actorRunId: string): Promise<void> {
    const store = await this.loadStore();
    await saveRuntimeRecoveryStoreSnapshot(this.filePath, {
      schemaVersion: RUNTIME_RECOVERY_STORE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      bundles: store.bundles.filter((bundle) => bundle.actorRunId !== actorRunId),
    });
  }

  async list(): Promise<RuntimeRecoveryBundle[]> {
    const store = await this.loadStore();
    return store.bundles;
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
