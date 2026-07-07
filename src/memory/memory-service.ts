// ============================================================================
// MemoryService — 内存混合记忆服务
// v0.3.1: MemoryCandidate / MemoryRecord 去重，检索排序稳定化
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

function normalizeText(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、“”‘’；：,.!！?？]/g, "");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function memoryFingerprint(input: {
  organizationId?: string;
  unitId?: string;
  actorId?: string;
  sceneId?: string;
  scope: string;
  type: string;
  content: string;
  structuredData?: Record<string, unknown>;
}): string {
  const structured = input.structuredData ? stableStringify(input.structuredData) : "";
  return [
    input.organizationId ?? "",
    input.unitId ?? "",
    input.actorId ?? "",
    input.sceneId ?? "",
    input.scope,
    input.type,
    normalizeText(input.content),
    structured,
  ].join("|");
}

function typeBucket(type: MemoryType): keyof Omit<HybridMemoryView,
  "working" | "organizationPublic" | "unitMemory" | "actorPrivate" | "sceneShared"> {
  if (type === "episodic" || type === "run_summary") return "episodic";
  if (type === "procedural") return "procedural";
  if (type === "governance" || type === "approval_lesson") return "governance";
  if (type === "structured" || type === "policy_hint") return "structured";
  return "semantic";
}

function scopePriority(scope: string): number {
  switch (scope) {
    case "scene_shared": return 4;
    case "actor_private": return 3;
    case "unit": return 2;
    case "organization_public": return 1;
    default: return 0;
  }
}

function typePriority(type: MemoryType): number {
  switch (type) {
    case "procedural": return 5;
    case "governance": return 4;
    case "case_pattern": return 3;
    case "semantic": return 2;
    case "episodic": return 1;
    default: return 0;
  }
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
  score += scopePriority(record.scope) * 0.25;
  score += typePriority(record.type) * 0.1;
  return score;
}

export class MemoryService {
  private memories: MemoryRecord[] = [];
  private candidates: MemoryCandidate[] = [];
  private memoryFingerprints: Set<string> = new Set();
  private candidateFingerprints: Set<string> = new Set();

  addMemory(entry: Omit<MemoryRecord, "memoryId" | "createdAt">): MemoryRecord {
    const fingerprint = memoryFingerprint(entry);
    const existing = this.memories.find((m) => memoryFingerprint(m) === fingerprint && m.status !== "archived" && m.status !== "expired");
    if (existing) {
      existing.confidence = Math.max(existing.confidence ?? 0, entry.confidence ?? 0);
      existing.importance = Math.max(existing.importance ?? 0, entry.importance ?? 0);
      existing.updatedAt = new Date().toISOString();
      return existing;
    }

    const now = new Date().toISOString();
    const memory: MemoryRecord = {
      ...entry,
      memoryId: `mem_${++memoryCounter}`,
      createdAt: now,
      updatedAt: now,
      useCount: entry.useCount ?? 0,
    };
    this.memories.push(memory);
    this.memoryFingerprints.add(fingerprint);
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

    const seen = new Set<string>();
    const records = accessible
      .map((record) => ({ record, score: scoreMemory(record, input.query) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if ((b.record.importance ?? 0) !== (a.record.importance ?? 0)) return (b.record.importance ?? 0) - (a.record.importance ?? 0);
        if ((b.record.confidence ?? 0) !== (a.record.confidence ?? 0)) return (b.record.confidence ?? 0) - (a.record.confidence ?? 0);
        if (scopePriority(b.record.scope) !== scopePriority(a.record.scope)) return scopePriority(b.record.scope) - scopePriority(a.record.scope);
        return a.record.memoryId.localeCompare(b.record.memoryId);
      })
      .filter(({ record }) => {
        const fp = memoryFingerprint(record);
        if (seen.has(fp)) return false;
        seen.add(fp);
        return true;
      })
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

    const bucketSeen = new Set<string>();
    const pushUnique = (bucket: string, content: string, push: () => void) => {
      const key = `${bucket}|${normalizeText(content)}`;
      if (bucketSeen.has(key)) return;
      bucketSeen.add(key);
      push();
    };

    for (const record of records) {
      if (record.scope === "organization_public") pushUnique("organizationPublic", record.content, () => view.organizationPublic.push(record.content));
      if (record.scope === "unit") pushUnique("unitMemory", record.content, () => view.unitMemory.push(record.content));
      if (record.scope === "actor_private") pushUnique("actorPrivate", record.content, () => view.actorPrivate.push(record.content));
      if (record.scope === "scene_shared") view.sceneShared[record.memoryId] = record.structuredData ?? record.content;

      const bucket = typeBucket(record.type);
      pushUnique(bucket, record.content, () => view[bucket].push(record.content));
    }

    return view;
  }

  acceptCandidate(candidate: MemoryCandidate): MemoryRecord | null {
    const fingerprint = memoryFingerprint(candidate);
    if (this.candidateFingerprints.has(fingerprint)) {
      return null;
    }

    const decision = memoryPolicy.decide(candidate);
    this.candidateFingerprints.add(fingerprint);
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

    const extracted = memoryExtractor.extract(extractionInput);
    const uniqueCandidates: MemoryCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of extracted) {
      const fp = memoryFingerprint(candidate);
      if (seen.has(fp)) continue;
      seen.add(fp);
      uniqueCandidates.push(candidate);
      this.acceptCandidate(candidate);
    }
    return uniqueCandidates;
  }

  getAllMemories(): MemoryRecord[] {
    return [...this.memories];
  }

  getCandidates(): MemoryCandidate[] {
    return [...this.candidates];
  }

  getStats(): { memoryCount: number; candidateCount: number; activeMemoryCount: number } {
    return {
      memoryCount: this.memories.length,
      candidateCount: this.candidates.length,
      activeMemoryCount: this.memories.filter((m) => m.status === "active").length,
    };
  }

  clear(): void {
    this.memories = [];
    this.candidates = [];
    this.memoryFingerprints.clear();
    this.candidateFingerprints.clear();
    memoryCounter = 0;
    memoryExtractor.reset();
  }
}

export const memoryService = new MemoryService();
