// ============================================================================
// MemoryPolicy
// v0.3.0: 控制 MemoryCandidate 如何进入长期记忆
// ============================================================================

import { MemoryCandidate, MemoryRecord, MemoryStatus } from "../core/types/memory";

export interface MemoryPolicyDecision {
  action: "auto_accept" | "candidate_only" | "reject";
  reason: string;
  status: MemoryStatus;
}

export class MemoryPolicy {
  decide(candidate: MemoryCandidate): MemoryPolicyDecision {
    // 第一版策略：
    // 1. actor_private 且低风险的 case_pattern / procedural / run_summary 自动进入 active
    // 2. unit / organization 级记忆保留为 candidate，后续人工确认
    // 3. 高风险治理记忆暂不自动写入 ActorContext
    if (candidate.riskLevel === "high" || candidate.riskLevel === "critical") {
      return {
        action: "candidate_only",
        reason: "高风险记忆需要人工确认",
        status: "candidate",
      };
    }

    if (candidate.scope === "actor_private" &&
        ["case_pattern", "procedural", "run_summary", "episodic", "semantic"].includes(candidate.type)) {
      return {
        action: "auto_accept",
        reason: "actor_private 低风险实践记忆自动写入",
        status: "active",
      };
    }

    return {
      action: "candidate_only",
      reason: "需要更高层级确认后写入长期记忆",
      status: "candidate",
    };
  }

  toRecord(candidate: MemoryCandidate, status: MemoryStatus): Omit<MemoryRecord, "memoryId" | "createdAt"> {
    return {
      organizationId: candidate.organizationId ?? "org_default",
      unitId: candidate.unitId,
      actorId: candidate.actorId,
      sceneId: candidate.sceneId,
      scope: candidate.scope,
      type: candidate.type,
      content: candidate.content,
      structuredData: candidate.structuredData,
      status,
      confidence: candidate.confidence,
      importance: candidate.importance,
      sourceType: candidate.sourceType,
      sourceRunId: candidate.actorRunId,
      sourceActorId: candidate.actorId,
      visibility: candidate.scope === "actor_private" ? "actor_private" : undefined,
    };
  }
}

export const memoryPolicy = new MemoryPolicy();
