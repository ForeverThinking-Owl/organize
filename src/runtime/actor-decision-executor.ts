// ============================================================================
// ActorDecisionExecutor — 决策执行器
// v0.1.3: prebuiltRequest 直传，ToolCallDecision.outputKey 控制写入，
//         finalizeToolCall 是 state 写入的唯一入口
// ============================================================================

import { ActorDecision, ToolCallDecision } from "../core/types/actor-decision";
import { ActorContext } from "../core/types/actor";
import {
  ToolCallRequest,
  ToolObservation,
  ToolCallRequest as ToolCallReq,
} from "../core/types/tool";
import { ApprovalRequest } from "../core/types/approval";
import { SkillState } from "./skill-runtime";
import { policyEngine } from "../policy/policy-engine";
import { approvalGate } from "../approvals/approval-gate";
import { toolGateway } from "../tools/tool-gateway";
import { traceLogger } from "../trace/trace-logger";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ExecutionResult =
  | { outcome: "completed"; observation?: ToolObservation }
  | { outcome: "final_output"; result: Record<string, unknown> }
  | { outcome: "waiting_approval"; approvalRequest: ApprovalRequest; pendingToolCall: ToolCallReq }
  | { outcome: "handoff"; targetRole: string; targetSkill: string }
  | { outcome: "error"; reason: string };

export interface PendingExecution {
  actorRunId: string;
  actorId: string;
  context: ActorContext;
  state: SkillState;
  pendingToolCall: ToolCallReq;
  pendingToolName: string;
  originatingStepKey?: string;
  originatingOutputKey?: string;
  /** 决策中的 outputKey，优先于 originatingOutputKey */
  decisionOutputKey?: string;
}

export interface ActiveRunState {
  actorRunId: string;
  actorId: string;
  context: ActorContext;
  state: SkillState;
  pendingExec: PendingExecution | null;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class ActorDecisionExecutor {
  private activeRuns: Map<string, ActiveRunState> = new Map();

  registerRun(runState: ActiveRunState): void {
    this.activeRuns.set(runState.actorRunId, runState);
  }

  getRun(actorRunId: string): ActiveRunState | undefined {
    return this.activeRuns.get(actorRunId);
  }

  removeRun(actorRunId: string): void {
    this.activeRuns.delete(actorRunId);
  }

  // -----------------------------------------------------------------------
  // 主入口
  // -----------------------------------------------------------------------

  async execute(
    decision: ActorDecision,
    context: ActorContext,
    state: SkillState,
    actorRunId: string,
    actorId: string,
    /** skill tool_call step 的原始信息 + 预构建 request */
    originating?: { stepKey: string; outputKey?: string; prebuiltRequest?: ToolCallReq }
  ): Promise<ExecutionResult> {
    switch (decision.decisionType) {
      case "tool_call":
        return this.executeToolCall(decision, context, state, actorRunId, actorId, originating);
      case "request_approval":
        return this.executeRequestApproval(decision, actorRunId);
      case "handoff":
        return this.executeHandoff(decision, actorRunId);
      case "final_output":
        return this.executeFinalOutput(decision, actorRunId);
      default:
        return { outcome: "error", reason: "Unknown decision type" };
    }
  }

  // -----------------------------------------------------------------------
  // continue
  // -----------------------------------------------------------------------

  async continueAfterApproval(
    actorRunId: string,
    decision: import("../core/types/approval").ApprovalDecision
  ): Promise<ExecutionResult> {
    const runState = this.activeRuns.get(actorRunId);
    if (!runState || !runState.pendingExec) {
      return { outcome: "error", reason: `No pending execution for ${actorRunId}` };
    }

    const pending = runState.pendingExec;
    const result = approvalGate.submitDecision(actorRunId, decision);
    if (!result.accepted) {
      return { outcome: "error", reason: result.reason ?? "Approval rejected" };
    }

    if (!decision.decision.startsWith("approve")) {
      runState.pendingExec = null;
      return { outcome: "error", reason: `审批拒绝: ${decision.decision}` };
    }

    if (decision.modifiedArguments) {
      pending.pendingToolCall.arguments = decision.modifiedArguments;
    }

    return this.finalizeToolCall(pending);
  }

  // -----------------------------------------------------------------------
  // ToolCall 执行
  // -----------------------------------------------------------------------

  private async executeToolCall(
    decision: ToolCallDecision,
    context: ActorContext,
    state: SkillState,
    actorRunId: string,
    actorId: string,
    originating?: { stepKey: string; outputKey?: string; prebuiltRequest?: ToolCallReq }
  ): Promise<ExecutionResult> {
    const toolName = decision.toolCall.toolName;

    // 1. 构建 ToolCallRequest：优先使用 prebuiltRequest（已解析 arguments）
    const request: ToolCallReq = originating?.prebuiltRequest
      ? { ...originating.prebuiltRequest }
      : {
          toolCallId: `tc_${originating?.stepKey ?? "manual"}_${Date.now()}`,
          toolName,
          arguments: decision.toolCall.arguments,
          actorId, actorRunId,
          stepKey: originating?.stepKey ?? "manual",
        };

    // 2. PolicyEngine
    const policyResult = policyEngine.checkToolCall(toolName, context, actorRunId);
    if (!policyResult.allowed) {
      return { outcome: "error", reason: policyResult.reason ?? "Permission denied" };
    }

    // 3. ApprovalGate
    const toolDef = toolGateway.getDefinition(toolName);
    if (toolDef) {
      const approvalReq = approvalGate.check(request, toolDef);
      if (approvalReq) {
        const runState = this.activeRuns.get(actorRunId);
        if (runState) {
          runState.pendingExec = {
            actorRunId, actorId, context, state,
            pendingToolCall: request,
            pendingToolName: toolName,
            originatingStepKey: originating?.stepKey,
            originatingOutputKey: originating?.outputKey,
            decisionOutputKey: decision.toolCall.outputKey,
          };
        }
        return { outcome: "waiting_approval", approvalRequest: approvalReq, pendingToolCall: request };
      }
    }

    // 4. 无需审批 → 直接执行
    return this.finalizeToolCall({
      actorRunId, actorId, context, state,
      pendingToolCall: request,
      pendingToolName: toolName,
      originatingStepKey: originating?.stepKey,
      originatingOutputKey: originating?.outputKey,
      decisionOutputKey: decision.toolCall.outputKey,
    });
  }

  // -----------------------------------------------------------------------
  // 最终执行 + 写入 state（唯一入口）
  // -----------------------------------------------------------------------

  private async finalizeToolCall(pending: PendingExecution): Promise<ExecutionResult> {
    const request = pending.pendingToolCall;
    const runState = this.activeRuns.get(pending.actorRunId)!;

    const observation = await toolGateway.execute(request, pending.actorRunId);
    const filtered = policyEngine.filterObservation(observation, runState.context);

    // 写入 state — 使用决策中的 outputKey，不覆盖非 tool_call 步骤的结果
    const outputKey = pending.decisionOutputKey ?? pending.originatingOutputKey;
    if (outputKey) {
      runState.state.outputs[outputKey] = filtered.data ?? {};
    }
    // 步骤级结果（仅当来自 skill tool_call step 时写 steps）
    if (pending.originatingStepKey && !pending.decisionOutputKey) {
      runState.state.steps[pending.originatingStepKey] = filtered.data ?? {};
    }
    runState.state.steps[request.toolName] = filtered.data ?? {};
    runState.state.observations.push(filtered);

    runState.pendingExec = null;
    return { outcome: "completed", observation: filtered };
  }

  // -----------------------------------------------------------------------
  // 其他决策类型
  // -----------------------------------------------------------------------

  private executeRequestApproval(
    decision: ActorDecision & { decisionType: "request_approval" },
    actorRunId: string
  ): ExecutionResult {
    traceLogger.record(actorRunId, "approval_requested", {
      approvalRequest: decision.approvalRequest as unknown as Record<string, unknown>,
    });
    return { outcome: "waiting_approval", approvalRequest: decision.approvalRequest as unknown as ApprovalRequest, pendingToolCall: {} as ToolCallReq };
  }

  private executeHandoff(
    decision: ActorDecision & { decisionType: "handoff" },
    actorRunId: string
  ): ExecutionResult {
    traceLogger.record(actorRunId, "handoff", {
      targetRole: decision.targetRole,
      targetSkill: decision.targetSkill,
    });
    return { outcome: "handoff", targetRole: decision.targetRole, targetSkill: decision.targetSkill };
  }

  private executeFinalOutput(
    decision: ActorDecision & { decisionType: "final_output" },
    actorRunId: string
  ): ExecutionResult {
    traceLogger.record(actorRunId, "final_output", decision.result as Record<string, unknown>);
    return { outcome: "final_output", result: decision.result };
  }
}

export const actorDecisionExecutor = new ActorDecisionExecutor();
