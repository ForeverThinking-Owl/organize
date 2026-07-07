// ============================================================================
// MemoryService — 内存混合记忆服务
// v0.3.0: Working / Structured / Semantic / Episodic / Procedural / Governance
// ============================================================================

import {
  HybridMemoryView,
  MemoryCandidate,
  MemoryRecord,
  MemoryRetrievalInput,
  MemoryRetrievalResult,
  MemoryType,
} from "../core/types/memory";
import { ActorProfile } from "../core/types/actor";
import { ToolObservation } from "../core/types/tool";
import { memoryExtractor, MemoryExtractionInput } from "./memory-extractor";
import { memoryPolicy } from "./memory-policy";

let memoryCounter = 0;

export interface CandidateInput {
  inputText: string;
  finalResult: Record<string, unknown> | null;
  observations: ToolObservation[];
  actorMemory: string[];
  approvalJudgment: { mustRequestApprovalWhen: string[] };
  organizationId?: string;
  unitId?: string;
  sceneId?: string;
}

function typeBucket(type: MemoryType): keyof Omit<HybridMemoryView,
  "working" | "organizationPublic" | "unitMemory" | "actorPrivate" | "sceneShared"> {
  if (type === "episodic" || type === "run_summary") return "episodic";
  if (type === "procedural") return "procedural";
  if (type === "governance" || type === "approval_lesson") return "governance";
  if (type === "structured" || type === "policy_hint") return "structured";
  return "semantic";
}

function scoreMemory(record: MemoryRecord, query?: string): number {
  let score = 0;
  const content = record.content.toLowerCase();
  const q = (query ?? "").toLowerCase();

  if (q) {
    for (const token of q.split(/\s+|，|。|、|；|：|,|\.|;/).filter(Boolean)) {
      if (content.includes(token)) score += 2;
    }
    if (/扫码枪|扫描枪|scanner/i.test(q) && /扫码枪|扫描枪|scanner/i.test(content)) score += 5;
    if (/退款/.test(q) && /退款/.test(content)) score += 5;
    if (/连不上|连接|无法连接/.test(q) && /连接|连不上|无法连接/.test(content)) score += 5;
  }

  score += (record.importance ?? 0.5) * 3;
  score += (record.confidence ?? 0.5) * 2;
  score += Math.min(record.useCount ?? 0, 5) * 0.5;
  return score;
}

export class MemoryService {
  private memories: MemoryRecord[] = [];
  private candidates: MemoryCandidate[] = [];

  addMemory(entry: Omit<MemoryRecord, "memoryId" | "createdAt">): MemoryRecord {
    const now = new Date().toISOString();
    const memory: MemoryRecord = {
      ...entry,
      memoryId: `mem_${++memoryCounter}`,
      createdAt: now,
      updatedAt: now,
      useCount: entry.useCount ?? 0,
    };
    this.memories.push(memory);
    return memory;
  }

  getOrganizationPublic(organizationId: string): string[] {
    return this.memories
      .filter((m) => m.organizationId === organizationId && m.scope === "organization_public" && m.status === "active")
      .map((m) => m.content);
  }

  getUnitMemory(unitId: string): string[] {
    return this.memories
      .filter((m) => m.unitId === unitId && m.scope === "unit" && m.status === "active")
      .map((m) => m.content);
  }

  getActorPrivate(actorId: string): string[] {
    return this.memories
      .filter((m) => m.actorId === actorId && m.scope === "actor_private" && m.status === "active")
      .map((m) => m.content);
  }

  initActorMemory(actor: ActorProfile, memoryStrings: string[]): void {
    for (const content of memoryStrings) {
      const exists = this.memories.some((m) =>
        m.actorId === actor.actorId && m.scope === "actor_private" && m.content === content && m.status === "active"
      );
      if (exists) continue;
      this.addMemory({
        organizationId: actor.organizationId,
        unitId: actor.unitId,
        actorId: actor.actorId,
        scope: "actor_private",
        type: "procedural",
        content,
        status: "active",
        confidence: 1,
        importance: 0.8,
        sourceType: "seed",
        visibility: "actor_private",
      });
    }
  }

  retrieve(input: MemoryRetrievalInput): MemoryRetrievalResult {
    const topK = input.topK ?? 8;
    const accessible = this.memories.filter((m) => {
      if (m.status !== "active" && m.status !== "approved") return false;
      if (m.organizationId !== input.organizationId) return false;
      if (m.scope === "organization_public") return true;
      if (m.scope === "unit") return Boolean(input.unitId && m.unitId === input.unitId);
      if (m.scope === "actor_private") return m.actorId === input.actorId;
      if (m.scope === "scene_shared") return Boolean(input.sceneId && m.sceneId === input.sceneId);
      return false;
    });

    const records = accessible
      .map((record) => ({ record, score: scoreMemory(record, input.query) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ record }) => {
        record.useCount = (record.useCount ?? 0) + 1;
        record.lastUsedAt = new Date().toISOString();
        return record;
      });

    return { records, view: this.toHybridView(records) };
  }

  toHybridView(records: MemoryRecord[]): HybridMemoryView {
    const view: HybridMemoryView = {
      working: {},
      organizationPublic: [],
      unitMemory: [],
      actorPrivate: [],
      sceneShared: {},
      structured: [],
      semantic: [],
      episodic: [],
      procedural: [],
      governance: [],
    };

    for (const record of records) {
      if (record.scope === "organization_public") view.organizationPublic.push(record.content);
      if (record.scope === "unit") view.unitMemory.push(record.content);
      if (record.scope === "actor_private") view.actorPrivate.push(record.content);
      if (record.scope === "scene_shared") view.sceneShared[record.memoryId] = record.structuredData ?? record.content;

      const bucket = typeBucket(record.type);
      view[bucket].push(record.content);
    }

    return view;
  }

  acceptCandidate(candidate: MemoryCandidate): MemoryRecord | null {
    const decision = memoryPolicy.decide(candidate);
    this.candidates.push({ ...candidate, status: decision.action === "reject" ? "rejected" : "candidate" });

    if (decision.action !== "auto_accept") {
      return null;
    }

    return this.addMemory(memoryPolicy.toRecord(candidate, decision.status));
  }

  generateCandidates(
    actorRunId: string,
    actorId: string,
    input: CandidateInput
  ): MemoryCandidate[] {
    const extractionInput: MemoryExtractionInput = {
      actorRunId,
      actorId,
      organizationId: input.organizationId,
      unitId: input.unitId,
      sceneId: input.sceneId,
      inputText: input.inputText,
      finalResult: input.finalResult,
      observations: input.observations,
      actorMemory: input.actorMemory,
      approvalJudgment: input.approvalJudgment,
    };

    const candidates = memoryExtractor.extract(extractionInput);
    for (const candidate of candidates) {
      this.acceptCandidate(candidate);
    }
    return candidates;
  }

  getAllMemories(): MemoryRecord[] {
    return [...this.memories];
  }

  getCandidates(): MemoryCandidate[] {
    return [...this.candidates];
  }

  clear(): void {
    this.memories = [];
    this.candidates = [];
    memoryCounter = 0;
    memoryExtractor.reset();
  }
}

export const memoryService = new MemoryService();
