// ============================================================================
// RuntimeRecoveryPersistence
// v0.4.2: helpers that connect RuntimeRecoveryBundle to a store
// ============================================================================

import type { RuntimeRecoveryBundle } from "./runtime-recovery-bundle";
import type { RuntimeRecoveryStore } from "./runtime-recovery-store";

export async function saveRuntimeRecoveryBundle(
  store: RuntimeRecoveryStore,
  bundle: RuntimeRecoveryBundle
): Promise<void> {
  await store.save(bundle);
}

export async function loadRuntimeRecoveryBundle(
  store: RuntimeRecoveryStore,
  actorRunId: string
): Promise<RuntimeRecoveryBundle | null> {
  return store.load(actorRunId);
}

export async function deleteRuntimeRecoveryBundle(
  store: RuntimeRecoveryStore,
  actorRunId: string
): Promise<void> {
  await store.delete(actorRunId);
}
