// ============================================================================
// hybrid-memory.demo.ts — v0.3.2
// 验证混合记忆观测：去重、稳定检索、Trace 摘要、写入统计、重复实践不重复写入
// ============================================================================

import { actorRuntime, ActorRunOutput } from "../runtime/actor-runtime";
import { toolGateway } from "../tools/tool-gateway";
import {
  queryOrderInfoTool, QueryOrderInfoExecutor,
  queryTicketHistoryTool, QueryTicketHistoryExecutor,
  createTicketTool, CreateTicketExecutor,
} from "../tools/mock-tools";
import { traceLogger } from "../trace/trace-logger";
import { memoryService, type MemoryWriteSummary } from "../memory/memory-service";
import { memoryFingerprint } from "../memory/memory-fingerprint";
import { approvalGate } from "../approvals/approval-gate";
import { MemoryRecord } from "../core/types/memory";

const ACTOR_CONFIG = {
  actor_id: "customer_service_actor", organization_id: "org_001",
  unit_id: "unit_customer_service", name: "客服 Actor",
  type: "ai" as const, role: "customer_service",
  responsibility: "接收客户问题、查询上下文、判断问题类型、生成后续处理建议",
  autonomy_level: "L2_read_and_draft",
  memory: [
    "涉及退款时，不要承诺退款完成，只能说提交退款申请或等待财务确认。",
    "设备连接问题通常需要技术排查。",
  ],
  permissions: {
    allowed_tools: ["query_order_info", "query_ticket_history", "create_ticket"],
    denied_tools: ["create_refund_request", "approve_refund"],
    allowed_skills: ["customer_issue_triage"],
  },
  approval_judgment: {
    must_request_approval_when: ["创建 urgent 工单", "外部正式发送客户回复", "涉及退款承诺"],
  },
};

const TRIAGE_OUTPUT_SCHEMA = {
  type: "object",
  required: ["need_after_sales", "need_technical", "need_finance", "should_create_ticket", "reason"],
  properties: {
    analysis: { type: "object" },
    need_after_sales: { type: "boolean" },
    need_technical: { type: "boolean" },
    need_finance: { type: "boolean" },
    should_create_ticket: { type: "boolean" },
    reason: { type: "string" },
    risk_level: { type: "string", enum: ["low", "medium", "high"] },
  },
};

const SKILL_CONFIG = {
  skill_id: "customer_issue_triage", name: "客户问题分流",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "query_history", type: "tool_call", tool_name: "query_ticket_history",
      input_mapping: { customer_id: "{{context.customer_id}}" }, output_key: "ticket_history" },
    { step_key: "judge", type: "llm_judge",
      instruction: "判断客户问题是否涉及售后、技术、财务，并决定是否创建工单。",
      output_key: "triage_result", output_schema: TRIAGE_OUTPUT_SCHEMA },
    { step_key: "return", type: "return" },
  ],
};

function registerTools(): void {
  toolGateway.registerDefinition(queryOrderInfoTool);
  toolGateway.registerDefinition(queryTicketHistoryTool);
  toolGateway.registerDefinition(createTicketTool);
  toolGateway.registerExecutor("query_order_info", new QueryOrderInfoExecutor());
  toolGateway.registerExecutor("query_ticket_history", new QueryTicketHistoryExecutor());
  toolGateway.registerExecutor("create_ticket", new CreateTicketExecutor());
}

async function approveIfNeeded(output: ActorRunOutput): Promise<ActorRunOutput> {
  if (output.status !== "waiting_approval" || !output.pendingApproval) return output;
  return actorRuntime.continue(output.actorRunId, {
    type: "approval_decision",
    decision: {
      approvalRequestId: output.pendingApproval.approvalRequestId,
      decision: "approve",
      comment: "Hybrid Memory Demo 自动审批通过",
      decidedBy: "memory_demo_approver",
      decidedAt: new Date().toISOString(),
    },
  });
}

function memoryRetrievedEvent(actorRunId: string) {
  const trace = traceLogger.getTrace(actorRunId)!;
  return trace.events.find((e) => e.eventType === "memory_retrieved");
}

function memoryRetrievedCount(actorRunId: string): number {
  return memoryRetrievedEvent(actorRunId)?.data.count as number ?? 0;
}

function memoryWriteSummary(actorRunId: string): MemoryWriteSummary | null {
  const trace = traceLogger.getTrace(actorRunId)!;
  const event = trace.events.find((e) => e.eventType === "memory_write_summary");
  return event?.data as unknown as MemoryWriteSummary | null;
}

function hasEvent(actorRunId: string, eventType: string): boolean {
  const trace = traceLogger.getTrace(actorRunId)!;
  return trace.events.some((e) => e.eventType === eventType);
}

function hasDuplicateMemories(memories: MemoryRecord[]): boolean {
  const seen = new Set<string>();
  for (const memory of memories) {
    const key = memoryFingerprint(memory);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

async function runPractice(inputText: string, orderId: string): Promise<ActorRunOutput> {
  let output = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: inputText },
    runtimeContext: { order_id: orderId, customer_id: "C001" },
  });
  output = await approveIfNeeded(output);
  return output;
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.3.2 — Memory Observability Demo");
  console.log("=".repeat(60));
  console.log();

  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
  registerTools();

  console.log("🚀 第一次运行：生成并写入实践记忆");
  const first = await runPractice("客户说扫码枪连不上系统，还要求退款。", "ORDER_10086");

  const memoriesAfterFirst = memoryService.getAllMemories();
  const acceptedCount = memoriesAfterFirst.filter((m) => m.sourceRunId === first.actorRunId).length;
  const firstWriteSummary = memoryWriteSummary(first.actorRunId);
  console.log("  Status: " + first.status);
  console.log("  MemoryCandidates: " + first.memoryCandidates.length);
  console.log("  AcceptedMemories: " + acceptedCount);
  console.log("  TotalMemories: " + memoriesAfterFirst.length);
  console.log("  MemoryWriteSummary: " + JSON.stringify(firstWriteSummary));
  console.log();

  console.log("🔁 第二次运行：检索第一次沉淀的经验");
  const second = await runPractice("客户说扫描枪又连不上了。", "ORDER_10087");

  const memoriesAfterSecond = memoryService.getAllMemories();
  const firstRetrieved = memoryRetrievedCount(first.actorRunId);
  const secondRetrieved = memoryRetrievedCount(second.actorRunId);
  console.log("  Status: " + second.status);
  console.log("  RetrievedMemoryCount: " + secondRetrieved);
  console.log("  TotalMemories: " + memoriesAfterSecond.length);
  console.log();

  console.log("🔂 第三次运行：重复第一次实践，验证去重和观测");
  const beforeThirdCount = memoryService.getAllMemories().length;
  const third = await runPractice("客户说扫码枪连不上系统，还要求退款。", "ORDER_10086");
  const afterThirdMemories = memoryService.getAllMemories();
  const afterThirdCount = afterThirdMemories.length;
  const thirdWriteSummary = memoryWriteSummary(third.actorRunId);
  console.log("  Status: " + third.status);
  console.log("  BeforeThirdMemories: " + beforeThirdCount);
  console.log("  AfterThirdMemories: " + afterThirdCount);
  console.log("  MemoryWriteSummary: " + JSON.stringify(thirdWriteSummary));
  console.log();

  const secondRetrievedEvent = memoryRetrievedEvent(second.actorRunId);
  const secondSummaries = (secondRetrievedEvent?.data.summaries as unknown[] | undefined) ?? [];
  const stats = memoryService.getStats();

  const checks = [
    {
      label: "第一次运行生成 MemoryCandidate",
      pass: first.memoryCandidates.length > 0,
      detail: "MemoryCandidates=" + first.memoryCandidates.length,
    },
    {
      label: "MemoryPolicy 自动接受 actor_private 低风险记忆",
      pass: acceptedCount > 0,
      detail: "AcceptedMemories=" + acceptedCount,
    },
    {
      label: "Trace 记录 memory_accepted",
      pass: hasEvent(first.actorRunId, "memory_accepted"),
      detail: hasEvent(first.actorRunId, "memory_accepted") ? "memory_accepted 已记录" : "未记录 memory_accepted",
    },
    {
      label: "第二次运行记录 memory_retrieved",
      pass: hasEvent(second.actorRunId, "memory_retrieved"),
      detail: "memory_retrieved count=" + secondRetrieved,
    },
    {
      label: "第二次运行检索到的记忆多于第一次 seed 记忆",
      pass: secondRetrieved > firstRetrieved,
      detail: "first=" + firstRetrieved + ", second=" + secondRetrieved,
    },
    {
      label: "memory_retrieved Trace 包含摘要",
      pass: secondSummaries.length === secondRetrieved && secondSummaries.length > 0,
      detail: "summaries=" + secondSummaries.length,
    },
    {
      label: "MemoryRecord 无重复 fingerprint",
      pass: !hasDuplicateMemories(afterThirdMemories),
      detail: hasDuplicateMemories(afterThirdMemories) ? "存在重复记忆" : "无重复记忆",
    },
    {
      label: "重复实践不会重复写入同一批记忆",
      pass: afterThirdCount === beforeThirdCount,
      detail: "before=" + beforeThirdCount + ", after=" + afterThirdCount,
    },
    {
      label: "Trace 记录 memory_write_summary",
      pass: Boolean(thirdWriteSummary),
      detail: thirdWriteSummary ? JSON.stringify(thirdWriteSummary) : "未记录 memory_write_summary",
    },
    {
      label: "重复实践观测到 Candidate 去重且无新增 Record",
      pass: Boolean(thirdWriteSummary && thirdWriteSummary.skippedGlobalCandidateDuplicates > 0 && thirdWriteSummary.createdRecords === 0),
      detail: JSON.stringify(thirdWriteSummary),
    },
    {
      label: "MemoryService 统计信息稳定且暴露最近写入摘要",
      pass: stats.memoryCount === afterThirdCount && stats.activeMemoryCount === afterThirdCount && Boolean(stats.lastWriteSummary),
      detail: JSON.stringify(stats),
    },
    {
      label: "第三次运行保持 Actor Kernel 完成状态",
      pass: third.status === "completed",
      detail: "Status=" + third.status,
    },
  ];

  console.log("=".repeat(60));
  console.log("  ✅ Memory Observability 验收检查 (12 条)");
  console.log("=".repeat(60));

  let passCount = 0;
  for (const [index, check] of checks.entries()) {
    if (check.pass) passCount++;
    console.log("  " + (check.pass ? "✅" : "❌") + " " + String(index + 1).padStart(2, "0") + ". " + check.label);
    console.log("      " + check.detail);
    console.log();
  }

  console.log("-".repeat(60));
  console.log("  通过: " + passCount + "/" + checks.length);
  console.log(passCount === checks.length
    ? "  🎉 Memory Observability 验证通过！"
    : "  ❌ 部分验收标准未通过");
  console.log("-".repeat(60));

  if (passCount !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error("Memory Observability Demo 执行失败:", error);
  process.exit(1);
});
