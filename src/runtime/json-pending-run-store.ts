// ============================================================================
// JsonPendingRunStore
// v0.4.1: PendingRunStore implementation backed by one local JSON file
// ============================================================================

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PENDING_RUN_SNAPSHOT_SCHEMA_VERSION,
  PENDING_RUN_STORE_SCHEMA_VERSION,
  type PendingRunSnapshot,
  type PendingRunStoreSnapshot,
} from "./pending-run-snapshot";
import type { PendingRunStore } from "./pending-run-store";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function assertStringField(value: Record<string, unknown>, key: string, label: string): void {
  if (typeof value[key] !== "string") {
    throw new Error(`Invalid ${label}: ${key} must be a string`);
  }
}

function assertObjectField(value: Record<string, unknown>, key: string, label: string): void {
  if (!isObject(value[key])) {
    throw new Error(`Invalid ${label}: ${key} must be an object`);
  }
}

export function assertPendingRunSnapshot(value: unknown): asserts value is PendingRunSnapshot {
  if (!isObject(value)) {
    throw new Error("Invalid PendingRunSnapshot: expected object");
  }
  if (value.schemaVersion !== PENDING_RUN_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Invalid PendingRunSnapshot: unsupported schemaVersion " + String(value.schemaVersion));
  }

  assertStringField(value, "savedAt", "PendingRunSnapshot");
  assertStringField(value, "actorRunId", "PendingRunSnapshot");
  assertStringField(value, "actorId", "PendingRunSnapshot");
  assertStringField(value, "skillId", "PendingRunSnapshot");

  if (value.status !== "waiting_human_input" && value.status !== "waiting_approval") {
    throw new Error("Invalid PendingRunSnapshot: status must be waiting_human_input or waiting_approval");
  }
  if (!["human_input", "skill_approval", "tool_approval"].includes(String(value.pendingKind))) {
    throw new Error("Invalid PendingRunSnapshot: unsupported pendingKind " + String(value.pendingKind));
  }

  assertObjectField(value, "skill", "PendingRunSnapshot");
  assertObjectField(value, "state", "PendingRunSnapshot");
  assertObjectField(value, "context", "PendingRunSnapshot");

  if (value.pendingKind === "human_input") {
    assertObjectField(value, "pendingHumanInput", "PendingRunSnapshot");
  }
  if (value.pendingKind === "skill_approval") {
    assertObjectField(value, "pendingSkillApproval", "PendingRunSnapshot");
  }
  if (value.pendingKind === "tool_approval") {
    assertObjectField(value, "pendingToolApproval", "PendingRunSnapshot");
    const toolApproval = value.pendingToolApproval as Record<string, unknown>;
    assertObjectField(toolApproval, "approvalRequest", "PendingToolApprovalSnapshot");
    assertObjectField(toolApproval, "pendingExec", "PendingToolApprovalSnapshot");
  }
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
  value.runs.forEach(assertPendingRunSnapshot);
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
  await writeFile(filePath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

export async function loadPendingRunStoreSnapshot(filePath: string): Promise<PendingRunStoreSnapshot> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertPendingRunStoreSnapshot(parsed);
  return parsed;
}

export class JsonPendingRunStore implements PendingRunStore {
  constructor(private readonly filePath: string) {}

  private async loadStore(): Promise<PendingRunStoreSnapshot> {
    try {
      return await loadPendingRunStoreSnapshot(this.filePath);
    } catch (error) {
      if (isFileNotFound(error)) return emptyStoreSnapshot();
      throw error;
    }
  }

  async load(actorRunId: string): Promise<PendingRunSnapshot | null> {
    const store = await this.loadStore();
    return store.runs.find((run) => run.actorRunId === actorRunId) ?? null;
  }

  async save(snapshot: PendingRunSnapshot): Promise<void> {
    assertPendingRunSnapshot(snapshot);
    const store = await this.loadStore();
    const remaining = store.runs.filter((run) => run.actorRunId !== snapshot.actorRunId);
    await savePendingRunStoreSnapshot(this.filePath, {
      schemaVersion: PENDING_RUN_STORE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      runs: [...remaining, snapshot],
    });
  }

  async delete(actorRunId: string): Promise<void> {
    const store = await this.loadStore();
    await savePendingRunStoreSnapshot(this.filePath, {
      schemaVersion: PENDING_RUN_STORE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      runs: store.runs.filter((run) => run.actorRunId !== actorRunId),
    });
  }

  async list(): Promise<PendingRunSnapshot[]> {
    const store = await this.loadStore();
    return store.runs;
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
