// ============================================================================
// PendingRunStore
// v0.4.1: persistence boundary for suspended ActorRuntime runs
// ============================================================================

import type { PendingRunSnapshot } from "./pending-run-snapshot";

export interface PendingRunStore {
  load(actorRunId: string): Promise<PendingRunSnapshot | null>;
  save(snapshot: PendingRunSnapshot): Promise<void>;
  delete(actorRunId: string): Promise<void>;
  list(): Promise<PendingRunSnapshot[]>;
  clear(): Promise<void>;
}
