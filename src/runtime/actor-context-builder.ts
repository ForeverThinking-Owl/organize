// ============================================================================
// ActorContextBuilder — 构建 Actor 运行上下文
// 每次 Actor 运行前，组装完整上下文：
//   Actor Profile + Hybrid Memory + Permission + Approval Policy + Available Tools + Input
// ============================================================================

import { ActorContext, ActorConfig, ToolForActor } from "../core/types/actor";
import { memoryService } from "../memory/memory-service";
import { toolGateway } from "../tools/tool-gateway";
import { traceLogger } from "../trace/trace-logger";
import { assertActorConfig } from "./actor-config-validation";

function preview(content: string, length = 48): string {
  return content.length > length ? content.slice(0, length) + "..." : content;
}

/**
 * 从 JSON 配置构建 ActorProfile
 */
export function buildActorProfile(config: ActorConfig): ActorContext["actor"] {
  return {
    actorId: config.actor_id,
    organizationId: config.organization_id ?? "org_default",
    unitId: config.unit_id,
    type: config.type,
    name: config.name,
    role: config.role,
    responsibility: config.responsibility,
    autonomyLevel: config.autonomy_level as ActorContext["actor"]["autonomyLevel"],
    status: "active",
  };
}

/**
 * 构建 ToolForActor 列表（只包含 allowed 且不在 denied 中的工具）
 */
export function buildAvailableTools(
  allowedTools: string[],
  deniedTools: string[]
): ToolForActor[] {
  const allDefs = toolGateway.getAllDefinitions();
  return allDefs
    .filter(
      (def) => allowedTools.includes(def.toolName) && !deniedTools.includes(def.toolName)
    )
    .map((def) => ({
      name: def.toolName,
      description: def.description,
      direction: def.direction,
      riskLevel: def.riskLevel,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
    }));
}

export function buildActorPermissions(config: ActorConfig): ActorContext["permissions"] {
  return {
    allowedTools: [...config.permissions.allowed_tools],
    deniedTools: [...config.permissions.denied_tools],
    allowedSkills: [...(config.permissions.allowed_skills ?? [])],
    deniedFields: config.permissions.denied_fields
      ? [...config.permissions.denied_fields]
      : undefined,
  };
}

export function buildActorApprovalJudgment(
  config: ActorConfig
): ActorContext["approvalJudgment"] {
  return {
    mustRequestApprovalWhen: [...config.approval_judgment.must_request_approval_when],
    canApprove: config.approval_judgment.can_approve
      ? structuredClone(config.approval_judgment.can_approve)
      : undefined,
  };
}

export class ActorContextBuilder {
  /**
   * 构建完整的 ActorContext
   */
  build(
    config: ActorConfig,
    input: {
      text?: string;
      payload?: Record<string, unknown>;
    },
    runtimeContext: Record<string, unknown> = {},
    actorRunId?: string
  ): ActorContext {
    assertActorConfig(config);
    const actor = buildActorProfile(config);
    const retrieval = memoryService.retrieve({
      organizationId: actor.organizationId,
      unitId: actor.unitId,
      actorId: actor.actorId,
      sceneId: runtimeContext.scene_id as string | undefined,
      query: input.text,
      topK: 12,
    });

    if (actorRunId) {
      traceLogger.record(actorRunId, "memory_retrieved", {
        count: retrieval.records.length,
        types: retrieval.records.map((m) => m.type),
        scopes: retrieval.records.map((m) => m.scope),
        memoryIds: retrieval.records.map((m) => m.memoryId),
        summaries: retrieval.records.map((m) => ({
          memoryId: m.memoryId,
          scope: m.scope,
          type: m.type,
          content: preview(m.content),
          useCount: m.useCount ?? 0,
        })),
      });
    }

    return {
      actor,
      input,
      runtimeContext,
      memory: retrieval.view,
      permissions: buildActorPermissions(config),
      approvalJudgment: buildActorApprovalJudgment(config),
      availableTools: buildAvailableTools(
        config.permissions.allowed_tools,
        config.permissions.denied_tools
      ),
    };
  }
}

export const actorContextBuilder = new ActorContextBuilder();
