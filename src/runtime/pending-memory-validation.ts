import { isDeepStrictEqual } from "node:util";
import type { ActorRunTrace } from "../core/types/trace";
import type { MemoryRecord } from "../core/types/memory";
import { memoryService } from "../memory/memory-service";
import type { MemorySnapshot } from "../memory/memory-snapshot";
import type { PendingRunSnapshot } from "./pending-run-snapshot";

function invalid(message: string): never {
  throw new Error(`Invalid pending Memory binding: ${message}`);
}

function recordIsVisibleToPendingRun(
  record: MemoryRecord,
  pending: PendingRunSnapshot
): boolean {
  if (record.organizationId !== pending.context.actor.organizationId) return false;
  if (record.status !== "active" && record.status !== "approved") return false;
  switch (record.scope) {
    case "organization_public":
      return true;
    case "unit":
      return Boolean(pending.context.actor.unitId && record.unitId === pending.context.actor.unitId);
    case "actor_private":
      return record.actorId === pending.actorId;
    case "scene_shared":
      return Boolean(
        pending.context.runtimeContext.scene_id &&
        record.sceneId === pending.context.runtimeContext.scene_id
      );
  }
}

/** Rebuild the exact memory view captured at context-build time from audited ids. */
export function assertPendingMemoryTraceConsistency(
  pending: PendingRunSnapshot,
  trace: ActorRunTrace,
  memory: MemorySnapshot
): void {
  const retrievalEvents = trace.events.filter((event) => event.eventType === "memory_retrieved");
  if (retrievalEvents.length !== 1) {
    invalid(`run ${pending.actorRunId} must have exactly one memory_retrieved event`);
  }
  const memoryIds = retrievalEvents[0].data.memoryIds;
  if (!Array.isArray(memoryIds) || memoryIds.some((memoryId) => typeof memoryId !== "string")) {
    invalid(`run ${pending.actorRunId} has invalid audited memory ids`);
  }
  if (new Set(memoryIds).size !== memoryIds.length || memoryIds.length > 12) {
    invalid(`run ${pending.actorRunId} has duplicate or excessive audited memory ids`);
  }

  const recordsById = new Map(memory.memories.map((record) => [record.memoryId, record]));
  const records = (memoryIds as string[]).map((memoryId) => {
    const record = recordsById.get(memoryId);
    if (!record || !recordIsVisibleToPendingRun(record, pending)) {
      invalid(`run ${pending.actorRunId} references inaccessible memory ${memoryId}`);
    }
    return record;
  });
  const retrieval = retrievalEvents[0].data;
  if (
    retrieval.count !== records.length ||
    !isDeepStrictEqual(retrieval.types, records.map((record) => record.type)) ||
    !isDeepStrictEqual(retrieval.scopes, records.map((record) => record.scope))
  ) {
    invalid(`run ${pending.actorRunId} has inconsistent memory retrieval metadata`);
  }
  const summaries = retrieval.summaries;
  if (!Array.isArray(summaries) || summaries.length !== records.length) {
    invalid(`run ${pending.actorRunId} has inconsistent memory summaries`);
  }
  records.forEach((record, index) => {
    const summary = summaries[index];
    const content = record.content.length > 48
      ? `${record.content.slice(0, 48)}...`
      : record.content;
    if (
      summary === null ||
      typeof summary !== "object" ||
      Array.isArray(summary) ||
      (summary as Record<string, unknown>).memoryId !== record.memoryId ||
      (summary as Record<string, unknown>).scope !== record.scope ||
      (summary as Record<string, unknown>).type !== record.type ||
      (summary as Record<string, unknown>).content !== content ||
      !Number.isSafeInteger((summary as Record<string, unknown>).useCount) ||
      ((summary as Record<string, unknown>).useCount as number) < 0 ||
      ((summary as Record<string, unknown>).useCount as number) > (record.useCount ?? 0)
    ) {
      invalid(`run ${pending.actorRunId} has a forged memory summary for ${record.memoryId}`);
    }
  });
  const expectedView = memoryService.toHybridView(records);
  if (!isDeepStrictEqual(expectedView, pending.context.memory)) {
    invalid(`run ${pending.actorRunId} memory view differs from its audited Memory snapshot`);
  }
}
