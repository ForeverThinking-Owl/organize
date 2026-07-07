// ============================================================================
// MemoryPersistence
// v0.3.4: helpers that connect MemoryService to a MemoryStore boundary
// ============================================================================

import type { MemoryService } from "./memory-service";
import type { MemoryStore } from "./memory-store";

export async function saveMemoryService(service: MemoryService, store: MemoryStore): Promise<void> {
  await store.save(service.dumpSnapshot());
}

export async function loadMemoryService(service: MemoryService, store: MemoryStore): Promise<boolean> {
  const snapshot = await store.load();
  if (!snapshot) return false;
  service.restoreSnapshot(snapshot);
  return true;
}
