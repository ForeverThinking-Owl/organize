// ============================================================================
// PendingRunPersistence
// v0.4.1: helpers connecting ActorRuntime pending snapshots to a store
// ============================================================================

import type { PendingRunStore } from "./pending-run-store";
import type { PendingRunSnapshot } from "./pending-run-snapshot";

export async function savePendingRunSnapshot(
  store: PendingRunStore,
  snapshot: PendingRunSnapshot
): Promise<void> {
  await store.save(snapshot);
}

export async function loadPendingRunSnapshot(
  store: PendingRunStore,
  actorRunId: string
): Promise<PendingRunSnapshot | null> {
  return store.load(actorRunId);
}

export async function deletePendingRunSnapshot(
  store: PendingRunStore,
  actorRunId: string
): Promise<void> {
  await store.delete(actorRunId);
}
