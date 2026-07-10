// ============================================================================
// WaitApprovalRuntime
// v0.3.9: runtime helpers for Skill wait_approval waiting / continue semantics
// ============================================================================

import { randomUUID } from "node:crypto";
import type { ApprovalDecision } from "../core/types/approval";
import type { WaitApprovalStep } from "../core/types/skill";
import { traceLogger } from "../trace/trace-logger";
import type { SkillState } from "./skill-runtime";

export interface SkillApprovalRequest {
  approvalKind: "skill_step";
  approvalRequestId: string;
  stepKey: string;
  reason: string;
  outputKey: string;
}

export interface SkillApprovalDecisionRecord {
  approvalRequestId: string;
  decision: ApprovalDecision["decision"];
  comment?: string;
  decidedBy?: string;
  decidedAt: string;
}

export function buildSkillApprovalRequest(
  step: WaitApprovalStep,
  actorRunId: string
): SkillApprovalRequest {
  const request: SkillApprovalRequest = {
    approvalKind: "skill_step",
    approvalRequestId: step.approvalRequestId ?? `apr_${randomUUID()}`,
    stepKey: step.stepKey,
    reason: step.reason,
    outputKey: step.outputKey,
  };

  traceLogger.record(actorRunId, "skill_step_start", {
    stepKey: step.stepKey,
    stepType: "wait_approval",
  });

  traceLogger.record(actorRunId, "approval_requested", {
    ...request,
  });

  return request;
}

export function approvalAllowsResume(decision: ApprovalDecision): boolean {
  return decision.decision === "approve" || decision.decision === "approve_with_comment";
}

export function applySkillApprovalDecision(
  request: SkillApprovalRequest,
  decision: ApprovalDecision,
  state: SkillState,
  actorRunId: string
): SkillApprovalDecisionRecord {
  const result: SkillApprovalDecisionRecord = {
    approvalRequestId: request.approvalRequestId,
    decision: decision.decision,
    comment: decision.comment,
    decidedBy: decision.decidedBy,
    decidedAt: decision.decidedAt,
  };

  state.steps[request.stepKey] = result;
  state.outputs[request.outputKey] = result;

  traceLogger.record(actorRunId, "approval_decided", {
    approvalKind: request.approvalKind,
    approvalRequestId: request.approvalRequestId,
    stepKey: request.stepKey,
    outputKey: request.outputKey,
    decision: decision.decision,
    comment: decision.comment,
    decidedBy: decision.decidedBy,
    decidedAt: decision.decidedAt,
  });

  traceLogger.record(actorRunId, "skill_step_end", {
    stepKey: request.stepKey,
    outputKey: request.outputKey,
    decision: decision.decision,
  });

  return result;
}
