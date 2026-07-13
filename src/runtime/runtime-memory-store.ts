// ============================================================================
// RuntimeMemoryStore — ActorRuntime / MemoryStore lifecycle binding
// v0.3.6: load before context build, save after memory generation, trace lifecycle
// ============================================================================

import type { MemoryStore } from "../memory/memory-store";
import { assertMemorySnapshot } from "../memory/json-memory-store";
import { memoryService } from "../memory/memory-service";
import { traceLogger } from "../trace/trace-logger";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function memoryStats(organizationId: string): { memoryCount: number; candidateCount: number } {
  const snapshot = memoryService.dumpOrganizationSnapshot(organizationId);
  return {
    memoryCount: snapshot.memories.length,
    candidateCount: snapshot.candidates.length,
  };
}

/**
 * Load a MemoryStore snapshot into MemoryService before ActorContext is built.
 *
 * Returning false marks the run as failed while preserving trace visibility.
 */
export async function loadRuntimeMemoryStore(
  actorRunId: string,
  organizationId: string,
  store?: MemoryStore
): Promise<boolean> {
  if (!store) return true;

  try {
    const snapshot = await store.load();
    if (!snapshot) {
      traceLogger.record(actorRunId, "memory_store_load", {
        status: "miss",
        ...memoryStats(organizationId),
      });
      return true;
    }

    assertMemorySnapshot(snapshot);
    const previousPartition = memoryService.dumpOrganizationSnapshot(organizationId);
    try {
      memoryService.mergeOrganizationSnapshot(organizationId, snapshot);
    } catch (error) {
      memoryService.restoreOrganizationSnapshot(organizationId, previousPartition);
      throw error;
    }
    traceLogger.record(actorRunId, "memory_store_load", {
      status: "loaded",
      schemaVersion: snapshot.schemaVersion,
      snapshotSavedAt: snapshot.savedAt,
      ...memoryStats(organizationId),
    });
    return true;
  } catch (error) {
    traceLogger.record(actorRunId, "memory_store_error", {
      stage: "load",
      message: errorMessage(error),
    });
    return false;
  }
}

/**
 * Save the current MemoryService snapshot after memory generation completes.
 *
 * Returning false lets ActorRuntime end the run as error without throwing away
 * the trace events that explain the failure.
 */
export async function saveRuntimeMemoryStore(
  actorRunId: string,
  organizationId: string,
  store?: MemoryStore
): Promise<boolean> {
  if (!store) return true;

  try {
    const snapshot = memoryService.dumpOrganizationSnapshot(organizationId);
    await store.save(snapshot);
    traceLogger.record(actorRunId, "memory_store_save", {
      status: "saved",
      schemaVersion: snapshot.schemaVersion,
      snapshotSavedAt: snapshot.savedAt,
      ...memoryStats(organizationId),
    });
    return true;
  } catch (error) {
    traceLogger.record(actorRunId, "memory_store_error", {
      stage: "save",
      message: errorMessage(error),
    });
    return false;
  }
}
