// ============================================================================
// Memory 类型定义
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
 * 记忆条目
 */
export interface MemoryEntry {
  memoryId: string;
  organizationId: string;
  unitId?: string;
  actorId?: string;
  scope: MemoryScope;
  type: string;
  content: string;
  sourceRunId?: string;
  status: "active" | "archived";
  createdAt: string;
}

/**
 * 记忆候选（Actor 运行后生成，需人工或规则确认后归档）
 */
export interface MemoryCandidate {
  candidateId: string;
  actorRunId: string;
  actorId: string;
  scope: MemoryScope;
  type: string;
  content: string;
  confidence?: number;
  createdAt: string;
}
