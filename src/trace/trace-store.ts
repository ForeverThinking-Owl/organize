// ============================================================================
// TraceStore
// v0.3.7: persistence boundary for TraceSnapshot storage implementations
// ============================================================================

import type { TraceSnapshot } from "./trace-snapshot";

export interface TraceStore {
  load(): Promise<TraceSnapshot | null>;
  save(snapshot: TraceSnapshot): Promise<void>;
  clear(): Promise<void>;
}
