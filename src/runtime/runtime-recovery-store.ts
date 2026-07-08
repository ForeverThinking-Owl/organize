// ============================================================================
// RuntimeRecoveryStore
// v0.4.2: persistence boundary for coordinated recovery bundles
// ============================================================================

import type { RuntimeRecoveryBundle } from "./runtime-recovery-bundle";

export interface RuntimeRecoveryStore {
  load(actorRunId: string): Promise<RuntimeRecoveryBundle | null>;
  save(bundle: RuntimeRecoveryBundle): Promise<void>;
  delete(actorRunId: string): Promise<void>;
  list(): Promise<RuntimeRecoveryBundle[]>;
  clear(): Promise<void>;
}
