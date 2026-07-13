// ============================================================================
// JsonTraceStore
// v0.3.7: TraceStore implementation backed by one local JSON snapshot file
// ============================================================================

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assertTraceSnapshot, type TraceSnapshot } from "./trace-snapshot";
import type { TraceStore } from "./trace-store";

export { assertTraceSnapshot } from "./trace-snapshot";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

export async function saveTraceSnapshot(filePath: string, snapshot: TraceSnapshot): Promise<void> {
  assertTraceSnapshot(snapshot);
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function loadTraceSnapshot(filePath: string): Promise<TraceSnapshot> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertTraceSnapshot(parsed);
  return parsed;
}

export class JsonTraceStore implements TraceStore {
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

  async load(): Promise<TraceSnapshot | null> {
    await this.waitForMutations();
    try {
      return await loadTraceSnapshot(this.filePath);
    } catch (error) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
  }

  async save(snapshot: TraceSnapshot): Promise<void> {
    assertTraceSnapshot(snapshot);
    const storedSnapshot = structuredClone(snapshot);
    await this.enqueueMutation(async () => {
      await saveTraceSnapshot(this.filePath, storedSnapshot);
    });
  }

  async clear(): Promise<void> {
    await this.enqueueMutation(async () => {
      await rm(this.filePath, { force: true });
    });
  }
}
