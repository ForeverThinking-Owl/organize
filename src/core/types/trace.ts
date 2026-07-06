// ============================================================================
// Trace 类型定义
// Trace 记录全过程，确保可审计、可复盘、可调试、可优化、可训练
// ============================================================================

/**
 * Trace 事件类型
 */
export type TraceEventType =
  | "actor_run_start"
  | "actor_run_end"
  | "context_built"
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
  | "llm_call_start"
  | "llm_call_end"
  | "llm_validation_failed"
  | "handoff"
  | "final_output"
  | "memory_candidate_generated"
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
  status: "running" | "completed" | "waiting_approval" | "error";
  events: TraceEvent[];
}
