// ============================================================================
// memory-persistence.demo.ts — v0.3.3
// 验证 MemorySnapshot 持久化：dump、JSON 保存、clear、restore、恢复后去重
// ============================================================================

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actorRuntime, ActorRunOutput } from "../runtime/actor-runtime";
import { toolGateway } from "../tools/tool-gateway";
import {
  queryOrderInfoTool, QueryOrderInfoExecutor,
  queryTicketHistoryTool, QueryTicketHistoryExecutor,
  createTicketTool, CreateTicketExecutor,
} from "../tools/mock-tools";
import { traceLogger } from "../trace/trace-logger";
import { memoryService, type MemoryWriteSummary } from "../memory/memory-service";
import { approvalGate } from "../approvals/approval-gate";
import { loadMemorySnapshot, saveMemorySnapshot } from "../memory/json-memory-store";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION, type MemorySnapshot } from "../memory/memory-snapshot";

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

interface CheckResult { label: string; pass: boolean; detail: string; }

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
      comment: "Memory Persistence Demo 自动审批通过",
      decidedBy: "memory_persistence_demo_approver",
      decidedAt: new Date().toISOString(),
    },
  });
}

function memoryWriteSummary(actorRunId: string): MemoryWriteSummary | null {
  const trace = traceLogger.getTrace(actorRunId)!;
  const event = trace.events.find((e) => e.eventType === "memory_write_summary");
  return event?.data as unknown as MemoryWriteSummary | null;
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
  console.log("  ForeverThinking v0.3.3 — Memory Persistence Demo");
  console.log("=".repeat(60));
  console.log();

  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
  registerTools();

  const tempDir = await mkdtemp(join(tmpdir(), "organize-memory-"));
  const snapshotPath = join(tempDir, "memory-snapshot.json");

  try {
    console.log("🚀 第一次运行：生成记忆并导出快照");
    const first = await runPractice("客户说扫码枪连不上系统，还要求退款。", "ORDER_10086");
    const firstStats = memoryService.getStats();
    const snapshot = memoryService.dumpSnapshot();
    await saveMemorySnapshot(snapshotPath, snapshot);
    const fileStat = await stat(snapshotPath);
    const loadedSnapshot: MemorySnapshot = await loadMemorySnapshot(snapshotPath);

    console.log("  Status: " + first.status);
    console.log("  MemoryCount: " + firstStats.memoryCount);
    console.log("  CandidateCount: " + firstStats.candidateCount);
    console.log("  SnapshotPath: " + snapshotPath);
    console.log("  SnapshotBytes: " + fileStat.size);
    console.log();

    console.log("🧹 清空内存后恢复快照");
    memoryService.clear();
    const clearedStats = memoryService.getStats();
    memoryService.restoreSnapshot(loadedSnapshot);
    const restoredStats = memoryService.getStats();
    const restoredRetrieval = memoryService.retrieve({
      organizationId: "org_001",
      unitId: "unit_customer_service",
      actorId: "customer_service_actor",
      query: "扫码枪 退款 连不上",
      topK: 12,
    });

    console.log("  ClearedMemoryCount: " + clearedStats.memoryCount);
    console.log("  RestoredMemoryCount: " + restoredStats.memoryCount);
    console.log("  RestoredCandidateCount: " + restoredStats.candidateCount);
    console.log("  RestoredRetrievalCount: " + restoredRetrieval.records.length);
    console.log();

    console.log("🔂 恢复后重复第一次实践，验证不重复写入");
    const beforeRepeatCount = memoryService.getAllMemories().length;
    const repeat = await runPractice("客户说扫码枪连不上系统，还要求退款。", "ORDER_10086");
    const afterRepeatCount = memoryService.getAllMemories().length;
    const repeatSummary = memoryWriteSummary(repeat.actorRunId);

    console.log("  Status: " + repeat.status);
    console.log("  BeforeRepeatMemories: " + beforeRepeatCount);
    console.log("  AfterRepeatMemories: " + afterRepeatCount);
    console.log("  MemoryWriteSummary: " + JSON.stringify(repeatSummary));
    console.log();

    const checks: CheckResult[] = [
      {
        label: "第一次运行生成可持久化记忆",
        pass: first.status === "completed" && firstStats.memoryCount > 0,
        detail: "status=" + first.status + ", memoryCount=" + firstStats.memoryCount,
      },
      {
        label: "MemorySnapshot schemaVersion 正确",
        pass: snapshot.schemaVersion === MEMORY_SNAPSHOT_SCHEMA_VERSION && loadedSnapshot.schemaVersion === MEMORY_SNAPSHOT_SCHEMA_VERSION,
        detail: "schemaVersion=" + loadedSnapshot.schemaVersion,
      },
      {
        label: "MemorySnapshot 文件成功写入",
        pass: fileStat.size > 0,
        detail: "bytes=" + fileStat.size,
      },
      {
        label: "Snapshot 保存 MemoryRecord 与 MemoryCandidate",
        pass: snapshot.memories.length === firstStats.memoryCount && snapshot.candidates.length === firstStats.candidateCount,
        detail: "memories=" + snapshot.memories.length + ", candidates=" + snapshot.candidates.length,
      },
      {
        label: "clear 后 MemoryService 为空",
        pass: clearedStats.memoryCount === 0 && clearedStats.candidateCount === 0,
        detail: JSON.stringify(clearedStats),
      },
      {
        label: "restore 后 memory/candidate 数量恢复",
        pass: restoredStats.memoryCount === snapshot.memories.length && restoredStats.candidateCount === snapshot.candidates.length,
        detail: JSON.stringify(restoredStats),
      },
      {
        label: "restore 后可检索历史记忆",
        pass: restoredRetrieval.records.length > 0,
        detail: "retrieved=" + restoredRetrieval.records.length,
      },
      {
        label: "restore 后重复实践不重复写入 MemoryRecord",
        pass: afterRepeatCount === beforeRepeatCount,
        detail: "before=" + beforeRepeatCount + ", after=" + afterRepeatCount,
      },
      {
        label: "restore 后 memory_write_summary 记录去重",
        pass: Boolean(repeatSummary && repeatSummary.skippedGlobalCandidateDuplicates > 0 && repeatSummary.createdRecords === 0),
        detail: JSON.stringify(repeatSummary),
      },
      {
        label: "恢复后的 Actor Kernel 保持 completed",
        pass: repeat.status === "completed",
        detail: "status=" + repeat.status,
      },
    ];

    console.log("=".repeat(60));
    console.log("  ✅ Memory Persistence 验收检查 (10 条)");
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
      ? "  🎉 Memory Persistence 验证通过！"
      : "  ❌ 部分验收标准未通过");
    console.log("-".repeat(60));

    if (passCount !== checks.length) process.exit(1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Memory Persistence Demo 执行失败:", error);
  process.exit(1);
});
