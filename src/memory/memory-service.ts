// ============================================================================
// MemoryService — 内存记忆服务
// v0.1.2: MemoryCandidate 从实践数据提炼：
//         工具结果 + Actor 判断 + 审批修正 + 最终结果
// ============================================================================

import { MemoryEntry, MemoryCandidate } from "../core/types/memory";
import { ActorProfile } from "../core/types/actor";
import { ToolObservation } from "../core/types/tool";

let memoryCounter = 0;
let candidateCounter = 0;

export interface CandidateInput {
  inputText: string;
  finalResult: Record<string, unknown> | null;
  observations: ToolObservation[];
  actorMemory: string[];
  approvalJudgment: { mustRequestApprovalWhen: string[] };
}

export class MemoryService {
  private memories: MemoryEntry[] = [];

  addMemory(entry: Omit<MemoryEntry, "memoryId" | "createdAt">): MemoryEntry {
    const memory: MemoryEntry = {
      ...entry, memoryId: `mem_${++memoryCounter}`, createdAt: new Date().toISOString(),
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
      this.addMemory({
        organizationId: actor.organizationId, actorId: actor.actorId,
        scope: "actor_private", type: "procedural", content, status: "active",
      });
    }
  }

  /**
   * 从实践数据生成记忆候选
   * 提炼维度：工具结果模式、Actor 判断逻辑、审批触发场景
   */
  generateCandidates(
    actorRunId: string,
    actorId: string,
    input: CandidateInput
  ): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    const text = input.inputText;

    // 1. 模式提炼：从工具结果和输入中识别关联模式
    const patterns = this.extractPatterns(text, input.observations, input.finalResult);
    for (const p of patterns) {
      candidates.push({
        candidateId: `cand_${++candidateCounter}`,
        actorRunId, actorId,
        scope: "actor_private",
        type: "case_pattern",
        content: p,
        confidence: 0.8,
        createdAt: new Date().toISOString(),
      });
    }

    // 2. 程序性知识：从审批触发中提炼
    const procedural = this.extractProcedural(text, input);
    for (const p of procedural) {
      candidates.push({
        candidateId: `cand_${++candidateCounter}`,
        actorRunId, actorId,
        scope: "actor_private",
        type: "procedural",
        content: p,
        confidence: 0.75,
        createdAt: new Date().toISOString(),
      });
    }

    // 3. 汇总摘要
    if (input.finalResult?.summary) {
      candidates.push({
        candidateId: `cand_${++candidateCounter}`,
        actorRunId, actorId,
        scope: "actor_private",
        type: "run_summary",
        content: `[${new Date().toISOString()}] ${input.finalResult.summary}: ${text}`,
        confidence: 0.6,
        createdAt: new Date().toISOString(),
      });
    }

    return candidates;
  }

  // -----------------------------------------------------------------------
  // 提炼逻辑
  // -----------------------------------------------------------------------

  private extractPatterns(
    text: string,
    observations: ToolObservation[],
    finalResult: Record<string, unknown> | null
  ): string[] {
    const patterns: string[] = [];

    const hasRefund = /退款/.test(text);
    const hasConnection = /连不上|连接|无法连接/.test(text);
    const hasScanner = /扫码枪|扫描枪|scanner/i.test(text);

    // 模式：扫码枪问题 + 退款 → 多线处理
    if (hasScanner && hasRefund && hasConnection) {
      patterns.push(
        "扫码枪连接问题常同时涉及技术排查、售后判断和退款风险，应触发多线并行处理。"
      );
    }

    // 模式：设备连接 + 历史工单
    const ticketObs = observations.find((o) => o.toolName === "query_ticket_history");
    if (ticketObs?.data) {
      const tickets = (ticketObs.data as Record<string, unknown>).tickets as Array<Record<string, unknown>> | undefined;
      if (tickets && tickets.length > 0 && hasConnection) {
        patterns.push(
          "设备连接类问题在历史工单中重复出现时，应考虑升级为产品缺陷而非个例处理。"
        );
      }
    }

    // 模式：退款 + 在保
    const orderObs = observations.find((o) => o.toolName === "query_order_info");
    if (orderObs?.data) {
      const orderData = orderObs.data as Record<string, unknown>;
      if (orderData.warrantyStatus === "in_warranty" && hasRefund) {
        patterns.push(
          "在保设备出现退款诉求时，应先走售后换修流程，退款作为最后选项。"
        );
      }
    }

    return patterns;
  }

  private extractProcedural(
    text: string,
    input: CandidateInput
  ): string[] {
    const procedural: string[] = [];

    // 退款话语规范
    if (/退款/.test(text)) {
      const hasRule = input.actorMemory.some((m) => /退款.*承诺/.test(m));
      if (hasRule) {
        procedural.push(
          '涉及退款诉求时，客服回复应使用“提交退款申请”或“等待财务确认”，避免承诺退款已完成。'
        );
      }
    }

    // urgent 审批触发
    if (input.approvalJudgment.mustRequestApprovalWhen.some((r) => /urgent/.test(r))) {
      procedural.push(
        "创建 urgent 优先级工单需经审批，确保 urgent 标签不被滥用。"
      );
    }

    return procedural;
  }

  clear(): void {
    this.memories = [];
    memoryCounter = 0;
    candidateCounter = 0;
  }
}

export const memoryService = new MemoryService();
