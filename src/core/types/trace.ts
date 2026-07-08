// ============================================================================
// Trace 类型定义
// Trace 记录全过程，确保可审计、可复盘、可调试、可优化、可训练
// ============================================================================

/**
 * Trace 事件类型
 */
export type TraceEventType =
  | "actor_run_start"
  | "actor_run_suspended"
  | "actor_run_resumed"
  | "actor_run_end"
  | "context_built"
  | "memory_retrieved"
  | "memory_store_load"
  | "memory_store_save"
  | "memory_store_error"
  | "skill_step_start"
  | "skill_step_end"
  | "tool_call_start"
  | "tool_call_end"
  | "tool_observation"
  | "decision_generated"
  | "permission_check"
  | "approval_check"
  | "approval_requested"
  | "approval_decided"
  | "human_input_requested"
  | "human_input_received"
  | "llm_call_start"
  | "llm_call_end"
  | "llm_validation_failed"
  | "handoff"
  | "final_output"
  | "memory_candidate_generated"
  | "memory_accepted"
  | "memory_write_summary"
  | "error";

/**
 * Trace 事件
 */
export interface TraceEvent {
  eventId: string;
  actorRunId: string;
  sequence: number;
  eventType: TraceEventType;
  timestamp: string;
  stepKey?: string;
  data: Record<string, unknown>;
}

/**
 * Actor 运行 Trace
 */
export interface ActorRunTrace {
  actorRunId: string;
  actorId: string;
  skillId: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "waiting_approval" | "waiting_human_input" | "error";
  events: TraceEvent[];
}
