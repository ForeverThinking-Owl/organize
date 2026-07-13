// ============================================================================
// ApprovalGate — 审批网关
// 判断 ToolCall 是否需要审批，处理审批请求和决策
// v0.4.1: allow pending approval restore for persistent pending runs
// ============================================================================

import { randomUUID } from "node:crypto";
import { ApprovalRequest, ApprovalDecision } from "../core/types/approval";
import { ToolCallRequest, ToolDefinition } from "../core/types/tool";
import { traceLogger } from "../trace/trace-logger";
import { buildCanonicalToolApprovalMetadata } from "./tool-approval-policy";

export class ApprovalGate {
  /** 待审批请求（按 actorRunId 索引） */
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();

  /**
   * 检查 ToolCall 是否需要审批
   * 返回 null 表示不需要审批，否则返回审批请求
   */
  check(
    request: ToolCallRequest,
    toolDef: ToolDefinition
  ): ApprovalRequest | null {
    const metadata = buildCanonicalToolApprovalMetadata(toolDef, request.arguments);
    if (!metadata) return null;

    const approvalRequest: ApprovalRequest = {
      approvalRequestId: `appr_${randomUUID()}`,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      ...metadata,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    traceLogger.record(request.actorRunId, "approval_check", {
      required: true,
      toolName: request.toolName,
      reason: approvalRequest.reason,
      approvalRequestId: approvalRequest.approvalRequestId,
    });

    traceLogger.record(request.actorRunId, "approval_requested", {
      approvalRequestId: approvalRequest.approvalRequestId,
      toolCallId: approvalRequest.toolCallId,
      toolName: approvalRequest.toolName,
      stage: approvalRequest.stage,
      reason: approvalRequest.reason,
      proposedArguments: approvalRequest.proposedArguments,
    });

    // 记录为待审批
    this.pendingApprovals.set(request.actorRunId, approvalRequest);
    return approvalRequest;
  }

  /**
   * 获取待审批请求
   */
  getPending(actorRunId: string): ApprovalRequest | undefined {
    const pending = this.pendingApprovals.get(actorRunId);
    return pending ? structuredClone(pending) : undefined;
  }

  /**
   * v0.4.1: 从 PendingRunSnapshot 恢复待审批请求。
   */
  restorePending(actorRunId: string, approvalRequest: ApprovalRequest): void {
    this.pendingApprovals.set(actorRunId, structuredClone(approvalRequest));
  }

  /**
   * v0.4.1: 清理单个 run 的待审批请求。
   */
  clearPending(actorRunId: string): void {
    this.pendingApprovals.delete(actorRunId);
  }

  /**
   * 外部提交审批决策（continue 流程入口）
   */
  submitDecision(
    actorRunId: string,
    decision: ApprovalDecision
  ): { accepted: boolean; reason?: string } {
    const pending = this.pendingApprovals.get(actorRunId);
    if (!pending) {
      return { accepted: false, reason: `No pending approval for run ${actorRunId}` };
    }
    if (pending.approvalRequestId !== decision.approvalRequestId) {
      return { accepted: false, reason: "ApprovalRequestId mismatch" };
    }

    traceLogger.record(actorRunId, "approval_decided", {
      ...decision,
      toolName: pending.toolName,
      toolCallId: pending.toolCallId,
    } as unknown as Record<string, unknown>);

    // 清除待审批状态
    this.pendingApprovals.delete(actorRunId);
    return { accepted: true };
  }

  /**
   * Demo 用：自动审批通过
   */
  autoApprove(
    actorRunId: string
  ): ApprovalDecision | null {
    const pending = this.pendingApprovals.get(actorRunId);
    if (!pending) return null;

    const decision: ApprovalDecision = {
      approvalRequestId: pending.approvalRequestId,
      decision: "approve",
      comment: "自动审批通过（Demo 模式）",
      decidedBy: "demo_approver",
      decidedAt: new Date().toISOString(),
    };

    this.submitDecision(actorRunId, decision);
    return decision;
  }

  clear(): void {
    this.pendingApprovals.clear();
  }
}

export const approvalGate = new ApprovalGate();
