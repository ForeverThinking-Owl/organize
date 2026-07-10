// ============================================================================
// MemoryService — 内存混合记忆服务
// v0.3.3: MemoryCandidate / MemoryRecord 写入观测、稳定 fingerprint、快照恢复
// ============================================================================

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import { memoryFingerprint, normalizeMemoryText } from "./memory-fingerprint";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION, type MemorySnapshot } from "./memory-snapshot";

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

export interface MemoryWriteSummary {
  extractedCandidates: number;
  uniqueCandidates: number;
  skippedBatchDuplicates: number;
  skippedGlobalCandidateDuplicates: number;
  candidateOnlyCandidates: number;
  rejectedCandidates: number;
  acceptedCandidates: number;
  createdRecords: number;
  dedupedRecords: number;
}

export interface CandidateGenerationResult {
  candidates: MemoryCandidate[];
  summary: MemoryWriteSummary;
}

export interface MemoryServiceStats {
  memoryCount: number;
  candidateCount: number;
  activeMemoryCount: number;
  lastWriteSummary: MemoryWriteSummary | null;
}

interface MemoryAddResult {
  record: MemoryRecord;
  created: boolean;
}

interface MemoryCandidateAcceptanceResult {
  action: "auto_accept" | "candidate_only" | "reject" | "duplicate_candidate";
  reason: string;
  record: MemoryRecord | null;
  createdRecord: boolean;
  dedupedRecord: boolean;
}

function emptyWriteSummary(): MemoryWriteSummary {
  return {
    extractedCandidates: 0,
    uniqueCandidates: 0,
    skippedBatchDuplicates: 0,
    skippedGlobalCandidateDuplicates: 0,
    candidateOnlyCandidates: 0,
    rejectedCandidates: 0,
    acceptedCandidates: 0,
    createdRecords: 0,
    dedupedRecords: 0,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  private lastWriteSummary: MemoryWriteSummary | null = null;

  private rebuildFingerprints(): void {
    this.memoryFingerprints = new Set(this.memories.map((memory) => memoryFingerprint(memory)));
    this.candidateFingerprints = new Set(this.candidates.map((candidate) => memoryFingerprint(candidate)));
  }

  private addMemoryWithResult(entry: Omit<MemoryRecord, "memoryId" | "createdAt">): MemoryAddResult {
    const fingerprint = memoryFingerprint(entry);
    const existing = this.memories.find((m) =>
      memoryFingerprint(m) === fingerprint && m.status !== "archived" && m.status !== "expired"
    );
    if (existing) {
      existing.confidence = Math.max(existing.confidence ?? 0, entry.confidence ?? 0);
      existing.importance = Math.max(existing.importance ?? 0, entry.importance ?? 0);
      existing.updatedAt = new Date().toISOString();
      this.memoryFingerprints.add(fingerprint);
      return { record: existing, created: false };
    }

    const now = new Date().toISOString();
    const memory: MemoryRecord = {
      ...entry,
      memoryId: `mem_${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      useCount: entry.useCount ?? 0,
    };
    this.memories.push(memory);
    this.memoryFingerprints.add(fingerprint);
    return { record: memory, created: true };
  }

  addMemory(entry: Omit<MemoryRecord, "memoryId" | "createdAt">): MemoryRecord {
    return this.addMemoryWithResult(entry).record;
  }

  dumpSnapshot(): MemorySnapshot {
    return {
      schemaVersion: MEMORY_SNAPSHOT_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      memories: cloneJson(this.memories),
      candidates: cloneJson(this.candidates),
      lastWriteSummary: this.lastWriteSummary ? cloneJson(this.lastWriteSummary) : null,
    };
  }

  restoreSnapshot(snapshot: MemorySnapshot): void {
    if (snapshot.schemaVersion !== MEMORY_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error("Unsupported MemorySnapshot schemaVersion: " + String(snapshot.schemaVersion));
    }

    this.memories = cloneJson(snapshot.memories);
    this.candidates = cloneJson(snapshot.candidates);
    this.lastWriteSummary = snapshot.lastWriteSummary ? cloneJson(snapshot.lastWriteSummary) : null;
    this.rebuildFingerprints();
  }

  /**
   * Export only the memory owned by one organization.
   *
   * Organization recovery must not serialize or later overwrite memories from
   * unrelated organizations that happen to share the same process.
   */
  dumpOrganizationSnapshot(organizationId: string): MemorySnapshot {
    return {
      schemaVersion: MEMORY_SNAPSHOT_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      memories: cloneJson(this.memories.filter((memory) => memory.organizationId === organizationId)),
      candidates: cloneJson(this.candidates.filter((candidate) => candidate.organizationId === organizationId)),
      lastWriteSummary: null,
    };
  }

  /**
   * Replace one organization's memory partition while preserving every other
   * organization already loaded in the shared MemoryService.
   */
  restoreOrganizationSnapshot(organizationId: string, snapshot: MemorySnapshot): void {
    if (snapshot.schemaVersion !== MEMORY_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error("Unsupported MemorySnapshot schemaVersion: " + String(snapshot.schemaVersion));
    }
    if (snapshot.memories.some((memory) => memory.organizationId !== organizationId)) {
      throw new Error(`MemorySnapshot contains memory outside organization ${organizationId}`);
    }
    if (snapshot.candidates.some((candidate) => candidate.organizationId !== organizationId)) {
      throw new Error(`MemorySnapshot contains candidate outside organization ${organizationId}`);
    }

    const otherMemories = this.memories.filter((memory) => memory.organizationId !== organizationId);
    const otherCandidates = this.candidates.filter((candidate) => candidate.organizationId !== organizationId);
    this.memories = [...otherMemories, ...cloneJson(snapshot.memories)];
    this.candidates = [...otherCandidates, ...cloneJson(snapshot.candidates)];
    this.rebuildFingerprints();
  }

  /**
   * Merge a recovery bundle's organization partition without rolling back
   * records already restored by another pending run from the same organization.
   * Existing ids win only when their immutable identity/content agrees.
   */
  mergeOrganizationSnapshot(organizationId: string, snapshot: MemorySnapshot): void {
    if (snapshot.schemaVersion !== MEMORY_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error("Unsupported MemorySnapshot schemaVersion: " + String(snapshot.schemaVersion));
    }
    if (snapshot.memories.some((memory) => memory.organizationId !== organizationId)) {
      throw new Error(`MemorySnapshot contains memory outside organization ${organizationId}`);
    }
    if (snapshot.candidates.some((candidate) => candidate.organizationId !== organizationId)) {
      throw new Error(`MemorySnapshot contains candidate outside organization ${organizationId}`);
    }

    const memoryIdentity = (memory: MemoryRecord) => ({
      memoryId: memory.memoryId,
      organizationId: memory.organizationId,
      unitId: memory.unitId,
      actorId: memory.actorId,
      sceneId: memory.sceneId,
      scope: memory.scope,
      type: memory.type,
      content: memory.content,
      structuredData: memory.structuredData,
      visibility: memory.visibility,
      sourceType: memory.sourceType,
      sourceRunId: memory.sourceRunId,
      sourceActorId: memory.sourceActorId,
      createdAt: memory.createdAt,
    });
    const candidateIdentity = (candidate: MemoryCandidate) => ({
      candidateId: candidate.candidateId,
      actorRunId: candidate.actorRunId,
      actorId: candidate.actorId,
      organizationId: candidate.organizationId,
      unitId: candidate.unitId,
      sceneId: candidate.sceneId,
      scope: candidate.scope,
      type: candidate.type,
      content: candidate.content,
      structuredData: candidate.structuredData,
      sourceType: candidate.sourceType,
      createdAt: candidate.createdAt,
    });

    for (const incoming of cloneJson(snapshot.memories)) {
      const existing = this.memories.find(
        (memory) =>
          memory.organizationId === organizationId && memory.memoryId === incoming.memoryId
      );
      if (existing) {
        if (!isDeepStrictEqual(memoryIdentity(existing), memoryIdentity(incoming))) {
          throw new Error(`MemorySnapshot conflicts with existing memory ${incoming.memoryId}`);
        }
        const existingVersion = existing.updatedAt ?? existing.lastUsedAt ?? existing.createdAt;
        const incomingVersion = incoming.updatedAt ?? incoming.lastUsedAt ?? incoming.createdAt;
        const newer = incomingVersion > existingVersion ? incoming : existing;
        Object.assign(existing, cloneJson(newer), {
          confidence: Math.max(existing.confidence ?? 0, incoming.confidence ?? 0),
          importance: Math.max(existing.importance ?? 0, incoming.importance ?? 0),
          useCount: Math.max(existing.useCount ?? 0, incoming.useCount ?? 0),
          updatedAt: [existing.updatedAt, incoming.updatedAt].filter(Boolean).sort().at(-1),
          lastUsedAt: [existing.lastUsedAt, incoming.lastUsedAt].filter(Boolean).sort().at(-1),
        });
      } else {
        this.memories.push(incoming);
      }
    }
    for (const incoming of cloneJson(snapshot.candidates)) {
      const existing = this.candidates.find(
        (candidate) =>
          candidate.organizationId === organizationId &&
          candidate.candidateId === incoming.candidateId
      );
      if (existing) {
        if (!isDeepStrictEqual(candidateIdentity(existing), candidateIdentity(incoming))) {
          throw new Error(`MemorySnapshot conflicts with existing candidate ${incoming.candidateId}`);
        }
        existing.confidence = Math.max(existing.confidence ?? 0, incoming.confidence ?? 0);
        existing.importance = Math.max(existing.importance ?? 0, incoming.importance ?? 0);
        if (existing.status === "candidate" && incoming.status !== "candidate") {
          existing.status = incoming.status;
        }
      } else {
        this.candidates.push(incoming);
      }
    }
    this.rebuildFingerprints();
  }

  clearOrganization(organizationId: string): void {
    this.memories = this.memories.filter((memory) => memory.organizationId !== organizationId);
    this.candidates = this.candidates.filter((candidate) => candidate.organizationId !== organizationId);
    this.rebuildFingerprints();
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
      const key = `${bucket}|${normalizeMemoryText(content)}`;
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

  private acceptCandidateWithResult(candidate: MemoryCandidate): MemoryCandidateAcceptanceResult {
    const fingerprint = memoryFingerprint(candidate);
    if (this.candidateFingerprints.has(fingerprint)) {
      return {
        action: "duplicate_candidate",
        reason: "duplicate candidate fingerprint",
        record: null,
        createdRecord: false,
        dedupedRecord: false,
      };
    }

    const decision = memoryPolicy.decide(candidate);
    this.candidateFingerprints.add(fingerprint);
    this.candidates.push({
      ...candidate,
      status: decision.action === "reject" ? "rejected" : decision.action === "auto_accept" ? "accepted" : "candidate",
    });

    if (decision.action !== "auto_accept") {
      return {
        action: decision.action,
        reason: decision.reason,
        record: null,
        createdRecord: false,
        dedupedRecord: false,
      };
    }

    const result = this.addMemoryWithResult(memoryPolicy.toRecord(candidate, decision.status));
    return {
      action: decision.action,
      reason: decision.reason,
      record: result.record,
      createdRecord: result.created,
      dedupedRecord: !result.created,
    };
  }

  acceptCandidate(candidate: MemoryCandidate): MemoryRecord | null {
    return this.acceptCandidateWithResult(candidate).record;
  }

  generateCandidatesWithSummary(
    actorRunId: string,
    actorId: string,
    input: CandidateInput
  ): CandidateGenerationResult {
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
    const summary = emptyWriteSummary();
    summary.extractedCandidates = extracted.length;

    const uniqueCandidates: MemoryCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of extracted) {
      const fp = memoryFingerprint(candidate);
      if (seen.has(fp)) {
        summary.skippedBatchDuplicates++;
        continue;
      }

      seen.add(fp);
      uniqueCandidates.push(candidate);
      const result = this.acceptCandidateWithResult(candidate);

      if (result.action === "duplicate_candidate") summary.skippedGlobalCandidateDuplicates++;
      if (result.action === "candidate_only") summary.candidateOnlyCandidates++;
      if (result.action === "reject") summary.rejectedCandidates++;
      if (result.action === "auto_accept") summary.acceptedCandidates++;
      if (result.createdRecord) summary.createdRecords++;
      if (result.dedupedRecord) summary.dedupedRecords++;
    }

    summary.uniqueCandidates = uniqueCandidates.length;
    this.lastWriteSummary = summary;
    return { candidates: uniqueCandidates, summary };
  }

  generateCandidates(
    actorRunId: string,
    actorId: string,
    input: CandidateInput
  ): MemoryCandidate[] {
    return this.generateCandidatesWithSummary(actorRunId, actorId, input).candidates;
  }

  getAllMemories(): MemoryRecord[] {
    return [...this.memories];
  }

  getCandidates(): MemoryCandidate[] {
    return [...this.candidates];
  }

  getStats(): MemoryServiceStats {
    return {
      memoryCount: this.memories.length,
      candidateCount: this.candidates.length,
      activeMemoryCount: this.memories.filter((m) => m.status === "active").length,
      lastWriteSummary: this.lastWriteSummary,
    };
  }

  clear(): void {
    this.memories = [];
    this.candidates = [];
    this.memoryFingerprints.clear();
    this.candidateFingerprints.clear();
    this.lastWriteSummary = null;
    memoryExtractor.reset();
  }
}

export const memoryService = new MemoryService();
