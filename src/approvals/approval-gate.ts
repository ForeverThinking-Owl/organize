// ============================================================================
// ApprovalGate — 审批网关
// 判断 ToolCall 是否需要审批，处理审批请求和决策
// v0.4.1: allow pending approval restore for persistent pending runs
// ============================================================================

import {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalStage,
} from "../core/types/approval";
import { ToolCallRequest, ToolDefinition } from "../core/types/tool";
import { traceLogger } from "../trace/trace-logger";

let approvalCounter = 0;

function counterFromApprovalId(approvalRequestId: string): number | null {
  if (!approvalRequestId.startsWith("appr_")) return null;
  const n = Number(approvalRequestId.slice("appr_".length));
  return Number.isInteger(n) ? n : null;
}

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
    const policy = toolDef.approvalPolicy;
    if (!policy || !policy.beforeCall?.requiredWhen) {
      return null;
    }

    // 检查每条审批规则
    for (const condition of policy.beforeCall.requiredWhen) {
      const argValue = request.arguments[condition.field];
      let matches = false;

      switch (condition.operator) {
        case "==":
          matches = argValue === condition.value;
          break;
        case "!=":
          matches = argValue !== condition.value;
          break;
        case ">":
          matches = (argValue as number) > (condition.value as number);
          break;
        case ">=":
          matches = (argValue as number) >= (condition.value as number);
          break;
        case "<":
          matches = (argValue as number) < (condition.value as number);
          break;
        case "<=":
          matches = (argValue as number) <= (condition.value as number);
          break;
      }

      if (matches) {
        const approvalRequest: ApprovalRequest = {
          approvalRequestId: `appr_${++approvalCounter}`,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          stage: "before_call" as ApprovalStage,
          riskLevel: toolDef.riskLevel,
          reason: `Tool ${request.toolName} 参数 ${condition.field} ${condition.operator} ${condition.value} 触发审批`,
          proposedArguments: request.arguments,
          suggestedApproverRole: "customer_service_manager",
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
    }

    return null;
  }

  /**
   * 获取待审批请求
   */
  getPending(actorRunId: string): ApprovalRequest | undefined {
    return this.pendingApprovals.get(actorRunId);
  }

  /**
   * v0.4.1: 从 PendingRunSnapshot 恢复待审批请求。
   */
  restorePending(actorRunId: string, approvalRequest: ApprovalRequest): void {
    this.pendingApprovals.set(actorRunId, approvalRequest);
    const counter = counterFromApprovalId(approvalRequest.approvalRequestId);
    if (counter !== null && counter > approvalCounter) {
      approvalCounter = counter;
    }
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
    approvalCounter = 0;
  }
}

export const approvalGate = new ApprovalGate();
