// ============================================================================
// Memory 类型定义
// v0.3.0: Hybrid Memory System
// Memory 是实践沉淀，让下一次实践变得更好
// ============================================================================

/**
 * 记忆范围
 */
export type MemoryScope =
  | "organization_public"
  | "unit"
  | "actor_private"
  | "scene_shared";

/**
 * 混合记忆类型
 */
export type MemoryType =
  | "working"
  | "structured"
  | "semantic"
  | "episodic"
  | "procedural"
  | "governance"
  | "case_pattern"
  | "run_summary"
  | "policy_hint"
  | "failure_lesson"
  | "approval_lesson";

export type MemoryStatus =
  | "candidate"
  | "active"
  | "approved"
  | "rejected"
  | "archived"
  | "expired";

export type MemorySourceType =
  | "seed"
  | "actor_run"
  | "tool_observation"
  | "approval_decision"
  | "final_output"
  | "human_review";

/**
 * 权威记忆记录
 */
export interface MemoryRecord {
  memoryId: string;
  organizationId: string;
  unitId?: string;
  actorId?: string;
  sceneId?: string;
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  structuredData?: Record<string, unknown>;
  visibility?: "public" | "unit_only" | "actor_private" | "scene_participants";
  status: MemoryStatus;
  confidence?: number;
  importance?: number;
  sourceType?: MemorySourceType;
  sourceRunId?: string;
  sourceActorId?: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
  lastUsedAt?: string;
  useCount?: number;
}

/**
 * 向后兼容：旧 MemoryEntry 暂时等同 MemoryRecord
 */
export type MemoryEntry = MemoryRecord;

/**
 * 记忆候选（Actor 运行后生成，需策略或人工确认后归档）
 */
export interface MemoryCandidate {
  candidateId: string;
  actorRunId: string;
  actorId: string;
  organizationId?: string;
  unitId?: string;
  sceneId?: string;
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  structuredData?: Record<string, unknown>;
  confidence?: number;
  importance?: number;
  riskLevel?: "low" | "medium" | "high" | "critical";
  sourceType?: MemorySourceType;
  status?: "candidate" | "accepted" | "rejected";
  createdAt: string;
}

/**
 * ActorContext 中的混合记忆视图
 */
export interface HybridMemoryView {
  working: Record<string, unknown>;
  organizationPublic: string[];
  unitMemory: string[];
  actorPrivate: string[];
  sceneShared: Record<string, unknown>;
  structured: string[];
  semantic: string[];
  episodic: string[];
  procedural: string[];
  governance: string[];
}

export interface MemoryRetrievalInput {
  organizationId: string;
  unitId?: string;
  actorId: string;
  sceneId?: string;
  query?: string;
  topK?: number;
}

export interface MemoryRetrievalResult {
  records: MemoryRecord[];
  view: HybridMemoryView;
}
