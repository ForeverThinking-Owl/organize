// ============================================================================
// JsonMemoryStore
// v0.3.4: MemoryStore implementation backed by one local JSON snapshot file
// ============================================================================

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION, MemorySnapshot } from "./memory-snapshot";
import type { MemoryStore } from "./memory-store";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

export function assertMemorySnapshot(value: unknown): asserts value is MemorySnapshot {
  if (!isObject(value)) {
    throw new Error("Invalid MemorySnapshot: expected object");
  }
  if (value.schemaVersion !== MEMORY_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Invalid MemorySnapshot: unsupported schemaVersion " + String(value.schemaVersion));
  }
  if (typeof value.savedAt !== "string") {
    throw new Error("Invalid MemorySnapshot: savedAt must be a string");
  }
  if (!Array.isArray(value.memories)) {
    throw new Error("Invalid MemorySnapshot: memories must be an array");
  }
  if (!Array.isArray(value.candidates)) {
    throw new Error("Invalid MemorySnapshot: candidates must be an array");
  }
}

export async function saveMemorySnapshot(filePath: string, snapshot: MemorySnapshot): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

export async function loadMemorySnapshot(filePath: string): Promise<MemorySnapshot> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertMemorySnapshot(parsed);
  return parsed;
}

export class JsonMemoryStore implements MemoryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<MemorySnapshot | null> {
    try {
      return await loadMemorySnapshot(this.filePath);
    } catch (error) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
  }

  async save(snapshot: MemorySnapshot): Promise<void> {
    await saveMemorySnapshot(this.filePath, snapshot);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
