// ============================================================================
// ActorDecisionExecutor — 决策执行器
// 统一执行 ActorDecision，组装 ToolCall 管线：
//   buildToolCallRequest → PolicyEngine.checkToolCall → ApprovalGate.check → ToolGateway.execute
// v0.1.2: 从 ActorRuntime 拆出，支持 waiting_approval / continue
// ============================================================================

import { ActorDecision, ToolCallDecision } from "../core/types/actor-decision";
import { ActorContext } from "../core/types/actor";
import {
  ToolCallRequest,
  ToolObservation,
  ToolCallRequest as ToolCallReq,
} from "../core/types/tool";
import { ApprovalRequest } from "../core/types/approval";
import { ToolCallStep, LLMJudgeStep } from "../core/types/skill";
import { SkillState, buildToolCallRequest } from "./skill-runtime";
import { policyEngine } from "../policy/policy-engine";
import { approvalGate } from "../approvals/approval-gate";
import { toolGateway } from "../tools/tool-gateway";
import { traceLogger } from "../trace/trace-logger";
import { skillRuntime } from "./skill-runtime";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 决策执行结果 */
export type ExecutionResult =
  | { outcome: "completed"; observation?: ToolObservation }
  | { outcome: "final_output"; result: Record<string, unknown> }
  | { outcome: "waiting_approval"; approvalRequest: ApprovalRequest; pendingToolCall: ToolCallReq }
  | { outcome: "handoff"; targetRole: string; targetSkill: string }
  | { outcome: "error"; reason: string };

/** 外部继续事件 */
export type ContinueEvent =
  | { type: "approval_decision"; decision: import("../core/types/approval").ApprovalDecision }
  | { type: "tool_observation"; observation: ToolObservation }
  | { type: "human_input"; data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// 运行时状态（用于 continue）
// ---------------------------------------------------------------------------

export interface PendingExecution {
  actorRunId: string;
  actorId: string;
  context: ActorContext;
  state: SkillState;
  pendingToolCall: ToolCallReq;
  /** 原始 step（用于完成时写入 state） */
  originatingStepKey?: string;
  originatingOutputKey?: string;
}

/** 活跃运行状态 */
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
  /** 活跃运行 */
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
  // 主入口：执行一个决策
  // -----------------------------------------------------------------------

  async execute(
    decision: ActorDecision,
    context: ActorContext,
    state: SkillState,
    actorRunId: string,
    actorId: string,
    /** 当 decision 来自 skill step 时的原始步骤 */
    originatingStep?: { stepKey: string; outputKey?: string }
  ): Promise<ExecutionResult> {
    switch (decision.decisionType) {
      case "tool_call":
        return this.executeToolCall(
          decision,
          context,
          state,
          actorRunId,
          actorId,
          originatingStep
        );
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
  // continue: 外部递交事件后继续执行
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

    // 提交审批决策
    const result = approvalGate.submitDecision(actorRunId, decision);
    if (!result.accepted) {
      return { outcome: "error", reason: result.reason ?? "Approval rejected" };
    }

    if (!decision.decision.startsWith("approve")) {
      runState.pendingExec = null;
      return { outcome: "error", reason: `审批拒绝: ${decision.decision}` };
    }

    // 审批通过，使用可能修改过的参数执行 ToolCall
    const toolCall = pending.pendingToolCall;
    if (decision.modifiedArguments) {
      toolCall.arguments = decision.modifiedArguments;
    }

    return this.finalizeToolCall(
      toolCall,
      runState,
      pending.originatingStepKey,
      pending.originatingOutputKey
    );
  }

  // -----------------------------------------------------------------------
  // 各决策类型执行
  // -----------------------------------------------------------------------

  private async executeToolCall(
    decision: ToolCallDecision,
    context: ActorContext,
    state: SkillState,
    actorRunId: string,
    actorId: string,
    originatingStep?: { stepKey: string; outputKey?: string }
  ): Promise<ExecutionResult> {
    const toolName = decision.toolCall.toolName;

    // 1. 构建 ToolCallRequest（如果来自 skill step，解析 inputMapping）
    let request: ToolCallReq;
    if (decision.toolCall.arguments && Object.keys(decision.toolCall.arguments).length > 0) {
      // 手动构造的 ToolCall（如 llm_judge follow-up），直接使用已有 arguments
      request = {
        toolCallId: `tc_${originatingStep?.stepKey ?? "manual"}_${Date.now()}`,
        toolName,
        arguments: decision.toolCall.arguments,
        actorId,
        actorRunId,
        stepKey: originatingStep?.stepKey ?? "manual",
      };
    } else {
      // 需要解析 inputMapping 的情况 — 但这需要 ToolCallStep，此处通过 originating step 间接处理
      // 实际上，对于 skill step，request 在进入 executor 前已经由调用方构建好了
      request = {
        toolCallId: `tc_${originatingStep?.stepKey ?? "unknown"}_${Date.now()}`,
        toolName,
        arguments: {},
        actorId,
        actorRunId,
        stepKey: originatingStep?.stepKey ?? "unknown",
      };
    }

    // 2. PolicyEngine 权限校验
    const policyResult = policyEngine.checkToolCall(toolName, context, actorRunId);
    if (!policyResult.allowed) {
      return { outcome: "error", reason: policyResult.reason ?? "Permission denied" };
    }

    // 3. ApprovalGate 审批检查
    const toolDef = toolGateway.getDefinition(toolName);
    if (toolDef) {
      const approvalReq = approvalGate.check(request, toolDef);
      if (approvalReq) {
        // 需要审批 → 进入 waiting_approval
        const runState = this.activeRuns.get(actorRunId);
        if (runState) {
          runState.pendingExec = {
            actorRunId,
            actorId,
            context,
            state,
            pendingToolCall: request,
            originatingStepKey: originatingStep?.stepKey,
            originatingOutputKey: originatingStep?.outputKey,
          };
        }
        return { outcome: "waiting_approval", approvalRequest: approvalReq, pendingToolCall: request };
      }
    }

    // 4. 无需审批 → 直接执行
    return this.finalizeToolCall(
      request,
      this.activeRuns.get(actorRunId)!,
      originatingStep?.stepKey,
      originatingStep?.outputKey
    );
  }

  private async finalizeToolCall(
    request: ToolCallReq,
    runState: ActiveRunState,
    originatingStepKey?: string,
    originatingOutputKey?: string
  ): Promise<ExecutionResult> {
    // ToolGateway.execute
    const observation = await toolGateway.execute(request, runState.actorRunId);

    // 过滤结果
    const filtered = policyEngine.filterObservation(observation, runState.context);

    // 写入 state
    if (originatingStepKey) {
      runState.state.steps[originatingStepKey] = filtered.data ?? {};
      if (originatingOutputKey) {
        runState.state.outputs[originatingOutputKey] = filtered.data ?? {};
      }
    }
    runState.state.steps[request.toolName] = filtered.data ?? {};
    runState.state.observations.push(filtered);

    // 清除 pending
    runState.pendingExec = null;

    return { outcome: "completed", observation: filtered };
  }

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
