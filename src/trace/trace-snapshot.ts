// ============================================================================
// TraceSnapshot
// v0.3.7: snapshot schema for persisting ActorRunTrace records
// ============================================================================

import type { ActorRunTrace } from "../core/types/trace";

export const TRACE_SNAPSHOT_SCHEMA_VERSION = "trace.snapshot.v1";

export interface TraceSnapshot {
  schemaVersion: typeof TRACE_SNAPSHOT_SCHEMA_VERSION;
  savedAt: string;
  traces: ActorRunTrace[];
}
