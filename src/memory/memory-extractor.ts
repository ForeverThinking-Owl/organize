// ============================================================================
// MemoryExtractor
// v0.3.0: 从实践运行结果中提取混合记忆候选
// ============================================================================

import { MemoryCandidate } from "../core/types/memory";
import { ToolObservation } from "../core/types/tool";

let candidateCounter = 0;

export interface MemoryExtractionInput {
  actorRunId: string;
  actorId: string;
  organizationId?: string;
  unitId?: string;
  sceneId?: string;
  inputText: string;
  finalResult: Record<string, unknown> | null;
  observations: ToolObservation[];
  actorMemory: string[];
  approvalJudgment: { mustRequestApprovalWhen: string[] };
}

function candidate(input: Omit<MemoryCandidate, "candidateId" | "createdAt">): MemoryCandidate {
  return {
    ...input,
    candidateId: `cand_${++candidateCounter}`,
    createdAt: new Date().toISOString(),
    status: "candidate",
  };
}

export class MemoryExtractor {
  extract(input: MemoryExtractionInput): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    const text = input.inputText;

    const hasRefund = /退款/.test(text);
    const hasConnection = /连不上|连接|无法连接/.test(text);
    const hasScanner = /扫码枪|扫描枪|scanner/i.test(text);

    if (hasScanner && hasRefund && hasConnection) {
      candidates.push(candidate({
        actorRunId: input.actorRunId,
        actorId: input.actorId,
        organizationId: input.organizationId,
        unitId: input.unitId,
        sceneId: input.sceneId,
        scope: "actor_private",
        type: "case_pattern",
        content: "扫码枪连接问题常同时涉及技术排查、售后判断和退款风险，应触发多线并行处理。",
        structuredData: {
          product_category: "scanner",
          issue_type: "connection_issue",
          associated_risks: ["refund", "after_sales", "technical_diagnosis"],
        },
        confidence: 0.82,
        importance: 0.75,
        riskLevel: "low",
        sourceType: "actor_run",
      }));
    }

    const ticketObs = input.observations.find((o) => o.toolName === "query_ticket_history");
    const tickets = ticketObs?.data ? (ticketObs.data as Record<string, unknown>).tickets as Array<Record<string, unknown>> | undefined : undefined;
    if (tickets && tickets.length > 0 && hasConnection) {
      candidates.push(candidate({
        actorRunId: input.actorRunId,
        actorId: input.actorId,
        organizationId: input.organizationId,
        unitId: input.unitId,
        sceneId: input.sceneId,
        scope: "actor_private",
        type: "episodic",
        content: "设备连接类问题在历史工单中重复出现时，应考虑升级为产品缺陷而非个例处理。",
        structuredData: {
          repeated_ticket_count: tickets.length,
          issue_type: "connection_issue",
        },
        confidence: 0.78,
        importance: 0.7,
        riskLevel: "low",
        sourceType: "tool_observation",
      }));
    }

    const orderObs = input.observations.find((o) => o.toolName === "query_order_info");
    const orderData = orderObs?.data as Record<string, unknown> | undefined;
    if (orderData?.warrantyStatus === "in_warranty" && hasRefund) {
      candidates.push(candidate({
        actorRunId: input.actorRunId,
        actorId: input.actorId,
        organizationId: input.organizationId,
        unitId: input.unitId,
        sceneId: input.sceneId,
        scope: "actor_private",
        type: "semantic",
        content: "在保设备出现退款诉求时，应先走售后换修流程，退款作为最后选项。",
        structuredData: {
          warranty_status: "in_warranty",
          requested_action: "refund",
          preferred_path: "after_sales_repair_or_replace_first",
        },
        confidence: 0.8,
        importance: 0.8,
        riskLevel: "low",
        sourceType: "tool_observation",
      }));
    }

    if (/退款/.test(text)) {
      const hasRule = input.actorMemory.some((m) => /退款.*承诺/.test(m));
      if (hasRule) {
        candidates.push(candidate({
          actorRunId: input.actorRunId,
          actorId: input.actorId,
          organizationId: input.organizationId,
          unitId: input.unitId,
          sceneId: input.sceneId,
          scope: "actor_private",
          type: "procedural",
          content: "涉及退款诉求时，客服回复应使用“提交退款申请”或“等待财务确认”，避免承诺退款已完成。",
          structuredData: {
            communication_rule: "avoid_refund_completed_claim",
            safe_phrases: ["提交退款申请", "等待财务确认"],
          },
          confidence: 0.82,
          importance: 0.85,
          riskLevel: "low",
          sourceType: "actor_run",
        }));
      }
    }

    if (input.approvalJudgment.mustRequestApprovalWhen.some((r) => /urgent/.test(r))) {
      candidates.push(candidate({
        actorRunId: input.actorRunId,
        actorId: input.actorId,
        organizationId: input.organizationId,
        unitId: input.unitId,
        sceneId: input.sceneId,
        scope: "actor_private",
        type: "governance",
        content: "创建 urgent 优先级工单需经审批，确保 urgent 标签不被滥用。",
        structuredData: {
          governance_point: "urgent_ticket_creation",
          approval_required: true,
        },
        confidence: 0.75,
        importance: 0.8,
        riskLevel: "medium",
        sourceType: "approval_decision",
      }));
    }

    if (input.finalResult?.summary) {
      candidates.push(candidate({
        actorRunId: input.actorRunId,
        actorId: input.actorId,
        organizationId: input.organizationId,
        unitId: input.unitId,
        sceneId: input.sceneId,
        scope: "actor_private",
        type: "run_summary",
        content: `${input.finalResult.summary}: ${text}`,
        structuredData: {
          summary: input.finalResult.summary,
          input: text,
        },
        confidence: 0.6,
        importance: 0.5,
        riskLevel: "low",
        sourceType: "final_output",
      }));
    }

    return candidates;
  }

  reset(): void {
    candidateCounter = 0;
  }
}

export const memoryExtractor = new MemoryExtractor();
