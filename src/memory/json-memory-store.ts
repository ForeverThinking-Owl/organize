// ============================================================================
// JsonMemoryStore
// v0.3.3: minimal file-backed MemorySnapshot persistence
// ============================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION, MemorySnapshot } from "./memory-snapshot";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
