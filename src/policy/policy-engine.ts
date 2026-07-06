// ============================================================================
// PolicyEngine — 权限与审批策略引擎
// 在 Prompt 前过滤、Decision 后校验、Observation 后过滤
// ============================================================================

import { ActorContext } from "../core/types/actor";
import { ActorDecision } from "../core/types/actor-decision";
import { ToolCallRequest, ToolObservation } from "../core/types/tool";
import { traceLogger } from "../trace/trace-logger";

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

export class PolicyEngine {
  /**
   * Decision 后校验：检查 Actor 是否有权执行该决策
   */
  checkDecision(
    decision: ActorDecision,
    context: ActorContext,
    actorRunId: string
  ): PolicyResult {
    if (decision.decisionType === "tool_call") {
      return this.checkToolCall(decision.toolCall.toolName, context, actorRunId);
    }
    // handoff / final_output / request_approval 默认允许
    return { allowed: true };
  }

  /**
   * 检查 ToolCall 权限（接受 ToolCallRequest 或 toolName）
   */
  checkToolCall(
    toolName: string,
    context: ActorContext,
    actorRunId: string
  ): PolicyResult {
    // 检查 denied_tools
    if (context.permissions.deniedTools.includes(toolName)) {
      const reason = `Actor ${context.actor.actorId} 无权调用 Tool: ${toolName}`;
      traceLogger.record(actorRunId, "permission_check", {
        allowed: false,
        reason,
        toolName,
      });
      return { allowed: false, reason };
    }

    // 检查 allowed_tools
    if (!context.permissions.allowedTools.includes(toolName)) {
      const reason = `Tool ${toolName} 不在 Actor ${context.actor.actorId} 的允许列表中`;
      traceLogger.record(actorRunId, "permission_check", {
        allowed: false,
        reason,
        toolName,
      });
      return { allowed: false, reason };
    }

    // 检查 autonomy_level — 写操作需要至少 L2
    const toolDef = context.availableTools.find((t) => t.name === toolName);
    if (toolDef?.direction === "write") {
      const level = context.actor.autonomyLevel;
      if (level === "L0_observe_only" || level === "L1_suggest_only") {
        const reason = `Actor ${context.actor.actorId} (${level}) 无权执行写操作`;
        traceLogger.record(actorRunId, "permission_check", {
          allowed: false,
          reason,
          toolName,
        });
        return { allowed: false, reason };
      }
    }

    traceLogger.record(actorRunId, "permission_check", {
      allowed: true,
      toolName,
    });
    return { allowed: true };
  }

  /**
   * Observation 后过滤：对返回结果做字段脱敏/过滤
   */
  filterObservation(
    observation: ToolObservation,
    context: ActorContext
  ): ToolObservation {
    const deniedFields = context.permissions.deniedFields ?? [];
    if (deniedFields.length === 0 || !observation.data) {
      return observation;
    }

    // 浅层过滤 denied_fields
    const filtered = { ...observation.data };
    for (const field of deniedFields) {
      delete filtered[field];
    }

    return { ...observation, data: filtered };
  }
}

export const policyEngine = new PolicyEngine();
