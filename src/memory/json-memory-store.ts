// ============================================================================
// JsonMemoryStore
// v0.3.4: MemoryStore implementation backed by one local JSON snapshot file
// ============================================================================

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION, MemorySnapshot } from "./memory-snapshot";
import type { MemoryStore } from "./memory-store";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Invalid MemorySnapshot: ${path} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) requireString(value, path, true);
}

function optionalFiniteNumber(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`Invalid MemorySnapshot: ${path} must be a finite number when present`);
  }
}

function assertJsonSafe(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid MemorySnapshot: ${path} must contain finite numbers`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Invalid MemorySnapshot: ${path} is not JSON-safe`);
  }
  if (ancestors.has(value)) {
    throw new Error(`Invalid MemorySnapshot: ${path} contains a circular reference`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) {
        throw new Error(`Invalid MemorySnapshot: ${path}[${index}] is a sparse array entry`);
      }
      assertJsonSafe(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new Error(`Invalid MemorySnapshot: ${path} must be a plain JSON object`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafe(item, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

const MEMORY_SCOPES = new Set(["organization_public", "unit", "actor_private", "scene_shared"]);
const MEMORY_TYPES = new Set([
  "working", "structured", "semantic", "episodic", "procedural", "governance",
  "case_pattern", "run_summary", "policy_hint", "failure_lesson", "approval_lesson",
]);
const MEMORY_STATUSES = new Set(["candidate", "active", "approved", "rejected", "archived", "expired"]);
const MEMORY_SOURCE_TYPES = new Set([
  "seed", "actor_run", "tool_observation", "approval_decision", "final_output", "human_review",
]);

function requireEnum(value: unknown, values: Set<string>, path: string): void {
  if (typeof value !== "string" || !values.has(value)) {
    throw new Error(`Invalid MemorySnapshot: ${path} is unsupported`);
  }
}

function assertMemoryRecord(value: unknown, index: number): string {
  const path = `memories[${index}]`;
  if (!isObject(value)) throw new Error(`Invalid MemorySnapshot: ${path} must be an object`);
  const memoryId = requireString(value.memoryId, `${path}.memoryId`);
  requireString(value.organizationId, `${path}.organizationId`);
  optionalString(value.unitId, `${path}.unitId`);
  optionalString(value.actorId, `${path}.actorId`);
  optionalString(value.sceneId, `${path}.sceneId`);
  requireEnum(value.scope, MEMORY_SCOPES, `${path}.scope`);
  requireEnum(value.type, MEMORY_TYPES, `${path}.type`);
  requireString(value.content, `${path}.content`, true);
  if (value.structuredData !== undefined && !isObject(value.structuredData)) {
    throw new Error(`Invalid MemorySnapshot: ${path}.structuredData must be an object when present`);
  }
  if (
    value.visibility !== undefined &&
    !["public", "unit_only", "actor_private", "scene_participants"].includes(String(value.visibility))
  ) {
    throw new Error(`Invalid MemorySnapshot: ${path}.visibility is unsupported`);
  }
  requireEnum(value.status, MEMORY_STATUSES, `${path}.status`);
  optionalFiniteNumber(value.confidence, `${path}.confidence`);
  optionalFiniteNumber(value.importance, `${path}.importance`);
  if (value.sourceType !== undefined) {
    requireEnum(value.sourceType, MEMORY_SOURCE_TYPES, `${path}.sourceType`);
  }
  optionalString(value.sourceRunId, `${path}.sourceRunId`);
  optionalString(value.sourceActorId, `${path}.sourceActorId`);
  requireString(value.createdAt, `${path}.createdAt`);
  optionalString(value.updatedAt, `${path}.updatedAt`);
  optionalString(value.expiresAt, `${path}.expiresAt`);
  optionalString(value.lastUsedAt, `${path}.lastUsedAt`);
  if (
    value.useCount !== undefined &&
    (!Number.isSafeInteger(value.useCount) || (value.useCount as number) < 0)
  ) {
    throw new Error(`Invalid MemorySnapshot: ${path}.useCount must be a non-negative safe integer`);
  }
  assertJsonSafe(value, path);
  return memoryId;
}

function assertMemoryCandidate(value: unknown, index: number): string {
  const path = `candidates[${index}]`;
  if (!isObject(value)) throw new Error(`Invalid MemorySnapshot: ${path} must be an object`);
  const candidateId = requireString(value.candidateId, `${path}.candidateId`);
  requireString(value.actorRunId, `${path}.actorRunId`);
  requireString(value.actorId, `${path}.actorId`);
  optionalString(value.organizationId, `${path}.organizationId`);
  optionalString(value.unitId, `${path}.unitId`);
  optionalString(value.sceneId, `${path}.sceneId`);
  requireEnum(value.scope, MEMORY_SCOPES, `${path}.scope`);
  requireEnum(value.type, MEMORY_TYPES, `${path}.type`);
  requireString(value.content, `${path}.content`, true);
  if (value.structuredData !== undefined && !isObject(value.structuredData)) {
    throw new Error(`Invalid MemorySnapshot: ${path}.structuredData must be an object when present`);
  }
  optionalFiniteNumber(value.confidence, `${path}.confidence`);
  optionalFiniteNumber(value.importance, `${path}.importance`);
  if (
    value.riskLevel !== undefined &&
    !["low", "medium", "high", "critical"].includes(String(value.riskLevel))
  ) {
    throw new Error(`Invalid MemorySnapshot: ${path}.riskLevel is unsupported`);
  }
  if (value.sourceType !== undefined) {
    requireEnum(value.sourceType, MEMORY_SOURCE_TYPES, `${path}.sourceType`);
  }
  if (
    value.status !== undefined &&
    !["candidate", "accepted", "rejected"].includes(String(value.status))
  ) {
    throw new Error(`Invalid MemorySnapshot: ${path}.status is unsupported`);
  }
  requireString(value.createdAt, `${path}.createdAt`);
  assertJsonSafe(value, path);
  return candidateId;
}

function assertWriteSummary(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isObject(value)) {
    throw new Error("Invalid MemorySnapshot: lastWriteSummary must be an object or null");
  }
  const fields = [
    "extractedCandidates", "uniqueCandidates", "skippedBatchDuplicates",
    "skippedGlobalCandidateDuplicates", "candidateOnlyCandidates", "rejectedCandidates",
    "acceptedCandidates", "createdRecords", "dedupedRecords",
  ];
  for (const field of fields) {
    const item = value[field];
    if (!Number.isSafeInteger(item) || (item as number) < 0) {
      throw new Error(`Invalid MemorySnapshot: lastWriteSummary.${field} must be a non-negative safe integer`);
    }
  }
  assertJsonSafe(value, "lastWriteSummary");
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
  requireString(value.savedAt, "savedAt");
  if (!Array.isArray(value.memories)) {
    throw new Error("Invalid MemorySnapshot: memories must be an array");
  }
  if (!Array.isArray(value.candidates)) {
    throw new Error("Invalid MemorySnapshot: candidates must be an array");
  }
  const memoryIds = new Set<string>();
  value.memories.forEach((memory, index) => {
    const memoryId = assertMemoryRecord(memory, index);
    if (memoryIds.has(memoryId)) {
      throw new Error(`Invalid MemorySnapshot: duplicate memoryId ${memoryId}`);
    }
    memoryIds.add(memoryId);
  });
  const candidateIds = new Set<string>();
  value.candidates.forEach((candidate, index) => {
    const candidateId = assertMemoryCandidate(candidate, index);
    if (candidateIds.has(candidateId)) {
      throw new Error(`Invalid MemorySnapshot: duplicate candidateId ${candidateId}`);
    }
    candidateIds.add(candidateId);
  });
  assertWriteSummary(value.lastWriteSummary);
  assertJsonSafe(value, "snapshot");
}

export async function saveMemorySnapshot(filePath: string, snapshot: MemorySnapshot): Promise<void> {
  assertMemorySnapshot(snapshot);
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function loadMemorySnapshot(filePath: string): Promise<MemorySnapshot> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertMemorySnapshot(parsed);
  return parsed;
}

export class JsonMemoryStore implements MemoryStore {
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

  async load(): Promise<MemorySnapshot | null> {
    await this.waitForMutations();
    try {
      return await loadMemorySnapshot(this.filePath);
    } catch (error) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
  }

  async save(snapshot: MemorySnapshot): Promise<void> {
    assertMemorySnapshot(snapshot);
    const storedSnapshot = structuredClone(snapshot);
    await this.enqueueMutation(async () => {
      await saveMemorySnapshot(this.filePath, storedSnapshot);
    });
  }

  async clear(): Promise<void> {
    await this.enqueueMutation(async () => {
      await rm(this.filePath, { force: true });
    });
  }
}
