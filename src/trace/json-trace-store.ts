// ============================================================================
// JsonTraceStore
// v0.3.7: TraceStore implementation backed by one local JSON snapshot file
// ============================================================================

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TRACE_SNAPSHOT_SCHEMA_VERSION, type TraceSnapshot } from "./trace-snapshot";
import type { TraceStore } from "./trace-store";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function assertTraceEvent(value: unknown, index: number, traceId: string): void {
  if (!isObject(value)) {
    throw new Error(`Invalid TraceSnapshot: trace ${traceId} event ${index} must be an object`);
  }
  if (typeof value.eventId !== "string") {
    throw new Error(`Invalid TraceSnapshot: trace ${traceId} event ${index}.eventId must be a string`);
  }
  if (typeof value.actorRunId !== "string") {
    throw new Error(`Invalid TraceSnapshot: trace ${traceId} event ${index}.actorRunId must be a string`);
  }
  if (typeof value.sequence !== "number") {
    throw new Error(`Invalid TraceSnapshot: trace ${traceId} event ${index}.sequence must be a number`);
  }
  if (typeof value.eventType !== "string") {
    throw new Error(`Invalid TraceSnapshot: trace ${traceId} event ${index}.eventType must be a string`);
  }
  if (typeof value.timestamp !== "string") {
    throw new Error(`Invalid TraceSnapshot: trace ${traceId} event ${index}.timestamp must be a string`);
  }
  if (!isObject(value.data)) {
    throw new Error(`Invalid TraceSnapshot: trace ${traceId} event ${index}.data must be an object`);
  }
}

function assertActorRunTrace(value: unknown, index: number): void {
  if (!isObject(value)) {
    throw new Error(`Invalid TraceSnapshot: traces[${index}] must be an object`);
  }
  if (typeof value.actorRunId !== "string") {
    throw new Error(`Invalid TraceSnapshot: traces[${index}].actorRunId must be a string`);
  }
  if (typeof value.actorId !== "string") {
    throw new Error(`Invalid TraceSnapshot: traces[${index}].actorId must be a string`);
  }
  if (typeof value.skillId !== "string") {
    throw new Error(`Invalid TraceSnapshot: traces[${index}].skillId must be a string`);
  }
  if (typeof value.startedAt !== "string") {
    throw new Error(`Invalid TraceSnapshot: traces[${index}].startedAt must be a string`);
  }
  if (typeof value.status !== "string") {
    throw new Error(`Invalid TraceSnapshot: traces[${index}].status must be a string`);
  }
  if (!Array.isArray(value.events)) {
    throw new Error(`Invalid TraceSnapshot: traces[${index}].events must be an array`);
  }

  const actorRunId = value.actorRunId;
  const events = value.events as unknown[];
  events.forEach((event, eventIndex) => assertTraceEvent(event, eventIndex, actorRunId));
}

export function assertTraceSnapshot(value: unknown): asserts value is TraceSnapshot {
  if (!isObject(value)) {
    throw new Error("Invalid TraceSnapshot: expected object");
  }
  if (value.schemaVersion !== TRACE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Invalid TraceSnapshot: unsupported schemaVersion " + String(value.schemaVersion));
  }
  if (typeof value.savedAt !== "string") {
    throw new Error("Invalid TraceSnapshot: savedAt must be a string");
  }
  if (!Array.isArray(value.traces)) {
    throw new Error("Invalid TraceSnapshot: traces must be an array");
  }

  const traces = value.traces as unknown[];
  traces.forEach(assertActorRunTrace);
}

export async function saveTraceSnapshot(filePath: string, snapshot: TraceSnapshot): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

export async function loadTraceSnapshot(filePath: string): Promise<TraceSnapshot> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertTraceSnapshot(parsed);
  return parsed;
}

export class JsonTraceStore implements TraceStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<TraceSnapshot | null> {
    try {
      return await loadTraceSnapshot(this.filePath);
    } catch (error) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
  }

  async save(snapshot: TraceSnapshot): Promise<void> {
    assertTraceSnapshot(snapshot);
    await saveTraceSnapshot(this.filePath, snapshot);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
