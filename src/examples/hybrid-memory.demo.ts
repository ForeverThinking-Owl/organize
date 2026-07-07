// ============================================================================
// hybrid-memory.demo.ts — v0.3.0
// 验证混合记忆最小闭环：第一次运行沉淀记忆，第二次运行检索记忆
// ============================================================================

import { actorRuntime, ActorRunOutput } from "../runtime/actor-runtime";
import { toolGateway } from "../tools/tool-gateway";
import {
  queryOrderInfoTool, QueryOrderInfoExecutor,
  queryTicketHistoryTool, QueryTicketHistoryExecutor,
  createTicketTool, CreateTicketExecutor,
} from "../tools/mock-tools";
import { traceLogger } from "../trace/trace-logger";
import { memoryService } from "../memory/memory-service";
import { approvalGate } from "../approvals/approval-gate";

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

function memoryRetrievedCount(actorRunId: string): number {
  const trace = traceLogger.getTrace(actorRunId)!;
  const event = trace.events.find((e) => e.eventType === "memory_retrieved");
  return event?.data.count as number ?? 0;
}

function hasEvent(actorRunId: string, eventType: string): boolean {
  const trace = traceLogger.getTrace(actorRunId)!;
  return trace.events.some((e) => e.eventType === eventType);
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.3.0 — Hybrid Memory Demo");
  console.log("=".repeat(60));
  console.log();

  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
  registerTools();

  console.log("🚀 第一次运行：生成并写入实践记忆");
  let first = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: "客户说扫码枪连不上系统，还要求退款。" },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  });
  first = await approveIfNeeded(first);

  const memoriesAfterFirst = memoryService.getAllMemories();
  const acceptedCount = memoriesAfterFirst.filter((m) => m.sourceRunId === first.actorRunId).length;
  console.log("  Status: " + first.status);
  console.log("  MemoryCandidates: " + first.memoryCandidates.length);
  console.log("  AcceptedMemories: " + acceptedCount);
  console.log("  TotalMemories: " + memoriesAfterFirst.length);
  console.log();

  console.log("🔁 第二次运行：检索第一次沉淀的经验");
  let second = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: "客户说扫描枪又连不上了。" },
    runtimeContext: { order_id: "ORDER_10087", customer_id: "C001" },
  });
  second = await approveIfNeeded(second);

  const firstRetrieved = memoryRetrievedCount(first.actorRunId);
  const secondRetrieved = memoryRetrievedCount(second.actorRunId);

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
      label: "第二次运行保持 Actor Kernel 完成状态",
      pass: second.status === "completed",
      detail: "Status=" + second.status,
    },
  ];

  console.log("=".repeat(60));
  console.log("  ✅ Hybrid Memory 验收检查 (6 条)");
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
    ? "  🎉 Hybrid Memory 最小闭环验证通过！"
    : "  ❌ 部分验收标准未通过");
  console.log("-".repeat(60));

  if (passCount !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error("Hybrid Memory Demo 执行失败:", error);
  process.exit(1);
});
