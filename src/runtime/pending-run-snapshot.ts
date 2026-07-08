// ============================================================================
// PendingRunSnapshot
// v0.4.1: serializable suspended-run state required to resume execution
// ============================================================================

import type { ActorContext } from "../core/types/actor";
import type { ApprovalRequest } from "../core/types/approval";
import type { Skill } from "../core/types/skill";
import type { ToolCallRequest } from "../core/types/tool";
import type { HumanInputRequest } from "./human-input-runtime";
import type { SkillState } from "./skill-runtime";
import type { SkillApprovalRequest } from "./wait-approval-runtime";

export const PENDING_RUN_SNAPSHOT_SCHEMA_VERSION = "pending_run.snapshot.v1";
export const PENDING_RUN_STORE_SCHEMA_VERSION = "pending_run.store.v1";

export type PendingRunStatus = "waiting_human_input" | "waiting_approval";
export type PendingRunKind = "human_input" | "skill_approval" | "tool_approval";

export interface PendingToolExecutionSnapshot {
  actorRunId: string;
  actorId: string;
  pendingToolCall: ToolCallRequest;
  pendingToolName: string;
  originatingStepKey?: string;
  originatingOutputKey?: string;
  decisionOutputKey?: string;
}

export interface PendingToolApprovalSnapshot {
  approvalRequest: ApprovalRequest;
  pendingExec: PendingToolExecutionSnapshot;
}

export interface PendingRunSnapshot {
  schemaVersion: typeof PENDING_RUN_SNAPSHOT_SCHEMA_VERSION;
  savedAt: string;

  actorRunId: string;
  actorId: string;
  skillId: string;
  status: PendingRunStatus;
  pendingKind: PendingRunKind;

  skill: Skill;
  state: SkillState;
  context: ActorContext;

  pendingHumanInput?: HumanInputRequest;
  pendingSkillApproval?: SkillApprovalRequest;
  pendingToolApproval?: PendingToolApprovalSnapshot;
}

export interface PendingRunStoreSnapshot {
  schemaVersion: typeof PENDING_RUN_STORE_SCHEMA_VERSION;
  savedAt: string;
  runs: PendingRunSnapshot[];
}
