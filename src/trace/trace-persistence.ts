// ============================================================================
// TracePersistence
// v0.3.7: helpers that connect TraceLogger to a TraceStore boundary
// ============================================================================

import type { TraceLogger } from "./trace-logger";
import type { TraceStore } from "./trace-store";

export async function saveTraceLogger(logger: TraceLogger, store: TraceStore): Promise<void> {
  await store.save(logger.dumpSnapshot());
}

export async function loadTraceLogger(logger: TraceLogger, store: TraceStore): Promise<boolean> {
  const snapshot = await store.load();
  if (!snapshot) return false;
  logger.restoreSnapshot(snapshot);
  return true;
}
