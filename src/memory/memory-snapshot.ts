// ============================================================================
// MemorySnapshot
// v0.3.3: portable snapshot format for in-memory hybrid memory persistence
// ============================================================================

import { MemoryCandidate, MemoryRecord } from "../core/types/memory";
import type { MemoryWriteSummary } from "./memory-service";

export const MEMORY_SNAPSHOT_SCHEMA_VERSION = "memory.snapshot.v1" as const;

export interface MemorySnapshot {
  schemaVersion: typeof MEMORY_SNAPSHOT_SCHEMA_VERSION;
  savedAt: string;
  memories: MemoryRecord[];
  candidates: MemoryCandidate[];
  lastWriteSummary?: MemoryWriteSummary | null;
}
