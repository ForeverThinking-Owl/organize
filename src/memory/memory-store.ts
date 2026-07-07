// ============================================================================
// MemoryStore
// v0.3.4: persistence boundary for MemorySnapshot storage implementations
// ============================================================================

import type { MemorySnapshot } from "./memory-snapshot";

export interface MemoryStore {
  load(): Promise<MemorySnapshot | null>;
  save(snapshot: MemorySnapshot): Promise<void>;
  clear(): Promise<void>;
}
