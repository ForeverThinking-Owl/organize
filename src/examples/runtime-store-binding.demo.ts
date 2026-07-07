// ============================================================================
// runtime-store-binding.demo.ts — v0.3.6
// 验证 ActorRuntime 与 MemoryStore 的自然绑定：run 前 load，run 后 save
// ============================================================================

import { mkdtemp, rm } from "node:fs/promises";
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
import { memoryService } from "../memory/memory-service";
import { approvalGate } from "../approvals/approval-gate";
import { JsonMemoryStore } from "../memory/json-memory-store";
import type { MemoryStore } from "../memory/memory-store";
import type { TraceEvent } from "../core/types/trace";

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
    allowed_skills: ["runtime_store_binding"],
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
  skill_id: "runtime_store_binding", name: "Runtime Store Binding 验证",
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

function resetRuntime(): void {
  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
  registerTools();
}

function traceEvents(output: ActorRunOutput): TraceEvent[] {
  return traceLogger.getTrace(output.actorRunId)?.events ?? [];
}

function findEvent(output: ActorRunOutput, eventType: string): TraceEvent | undefined {
  return traceEvents(output).find((event) => event.eventType === eventType);
}

function hasStoreEvent(output: ActorRunOutput): boolean {
  return traceEvents(output).some((event) => event.eventType.startsWith("memory_store_"));
}

async function approveIfNeeded(output: ActorRunOutput): Promise<ActorRunOutput> {
  if (output.status !== "waiting_approval" || !output.pendingApproval) return output;
  return actorRuntime.continue(output.actorRunId, {
    type: "approval_decision",
    decision: {
      approvalRequestId: output.pendingApproval.approvalRequestId,
      decision: "approve",
      comment: "Runtime Store Binding Demo 自动审批通过",
      decidedBy: "runtime_store_binding_demo_approver",
      decidedAt: new Date().toISOString(),
    },
  });
}

async function runPractice(inputText: string, orderId: string, memoryStore?: MemoryStore): Promise<ActorRunOutput> {
  let output = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: inputText },
    runtimeContext: { order_id: orderId, customer_id: "C001" },
    runtimeOptions: memoryStore ? { memoryStore } : undefined,
  });
  output = await approveIfNeeded(output);
  return output;
}

function retrievedSummaries(output: ActorRunOutput): Array<{ content?: string; memoryId?: string; type?: string; scope?: string }> {
  const event = findEvent(output, "memory_retrieved");
  return (event?.data.summaries ?? []) as Array<{ content?: string; memoryId?: string; type?: string; scope?: string }>;
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.3.6 — Runtime Store Binding Demo");
  console.log("=".repeat(60));
  console.log();

  resetRuntime();

  const tempDir = await mkdtemp(join(tmpdir(), "organize-runtime-store-"));
  const storePath = join(tempDir, "memory-store.json");
  const store = new JsonMemoryStore(storePath);

  try {
    console.log("📦 第一次运行：空 Store 进入 ActorRuntime.run(runtimeOptions.memoryStore)");
    const initialStoreLoad = await store.load();
    const first = await runPractice("客户说扫码枪连不上系统，还要求退款。", "ORDER_10086", store);
    const firstLoadEvent = findEvent(first, "memory_store_load");
    const firstSaveEvent = findEvent(first, "memory_store_save");
    const firstStoredSnapshot = await store.load();
    const firstSnapshotMemoryCount = firstStoredSnapshot?.memories.length ?? 0;
    console.log("  InitialStoreLoad: " + (initialStoreLoad === null ? "null" : "snapshot"));
    console.log("  Status: " + first.status);
    console.log("  StoreLoadTrace: " + JSON.stringify(firstLoadEvent?.data ?? null));
    console.log("  StoreSaveTrace: " + JSON.stringify(firstSaveEvent?.data ?? null));
    console.log("  StoredMemoryCount: " + firstSnapshotMemoryCount);
    console.log();

    console.log("🧹 清空 MemoryService 与 Trace，第二次运行应由 Runtime 自动 load Store");
    memoryService.clear();
    traceLogger.clear();
    approvalGate.clear();
    registerTools();

    const second = await runPractice("客户说扫码枪连不上系统，还要求退款。", "ORDER_10086", store);
    const secondLoadEvent = findEvent(second, "memory_store_load");
    const secondSaveEvent = findEvent(second, "memory_store_save");
    const secondRetrieval = findEvent(second, "memory_retrieved");
    const secondSummaries = retrievedSummaries(second);
    const secondStats = memoryService.getStats();
    const secondStoredSnapshot = await store.load();
    const hasRestoredCasePattern = secondSummaries.some((summary) =>
      String(summary.content ?? "").includes("扫码枪连接问题常同时涉及")
    );
    console.log("  Status: " + second.status);
    console.log("  StoreLoadTrace: " + JSON.stringify(secondLoadEvent?.data ?? null));
    console.log("  StoreSaveTrace: " + JSON.stringify(secondSaveEvent?.data ?? null));
    console.log("  RetrievedCount: " + String(secondRetrieval?.data.count ?? 0));
    console.log("  RuntimeMemoryCount: " + secondStats.memoryCount);
    console.log("  StoredMemoryCount: " + String(secondStoredSnapshot?.memories.length ?? 0));
    console.log();

    console.log("🧪 不传 memoryStore：保持旧的纯内存运行行为，不记录 store lifecycle trace");
    resetRuntime();
    const noStore = await runPractice("客户说扫码枪连不上系统。", "ORDER_10086");
    console.log("  Status: " + noStore.status);
    console.log("  HasStoreTrace: " + hasStoreEvent(noStore));
    console.log();

    const checks: CheckResult[] = [
      {
        label: "空 JsonMemoryStore 初始 load 返回 null",
        pass: initialStoreLoad === null,
        detail: "initialStoreLoad=" + String(initialStoreLoad),
      },
      {
        label: "首次 store-backed run 正常 completed",
        pass: first.status === "completed",
        detail: "status=" + first.status,
      },
      {
        label: "首次运行前 Runtime 记录 memory_store_load: miss",
        pass: firstLoadEvent?.data.status === "miss",
        detail: JSON.stringify(firstLoadEvent?.data ?? null),
      },
      {
        label: "首次运行后 Runtime 记录 memory_store_save: saved",
        pass: firstSaveEvent?.data.status === "saved",
        detail: JSON.stringify(firstSaveEvent?.data ?? null),
      },
      {
        label: "首次运行后 Store 中存在 MemorySnapshot",
        pass: Boolean(firstStoredSnapshot && firstSnapshotMemoryCount > 0),
        detail: "storedMemories=" + firstSnapshotMemoryCount,
      },
      {
        label: "清空 MemoryService 后第二次运行自动 load Store",
        pass: secondLoadEvent?.data.status === "loaded" && Number(secondLoadEvent.data.memoryCount ?? 0) === firstSnapshotMemoryCount,
        detail: JSON.stringify(secondLoadEvent?.data ?? null),
      },
      {
        label: "第二次 context 构建时检索到 Store 恢复的历史记忆",
        pass: Number(secondRetrieval?.data.count ?? 0) > 0 && hasRestoredCasePattern,
        detail: "retrieved=" + String(secondRetrieval?.data.count ?? 0) + ", hasCasePattern=" + String(hasRestoredCasePattern),
      },
      {
        label: "第二次运行后 Runtime 再次 save Store",
        pass: second.status === "completed" && secondSaveEvent?.data.status === "saved",
        detail: JSON.stringify(secondSaveEvent?.data ?? null),
      },
      {
        label: "Store restore 后重复实践不重复写入 MemoryRecord",
        pass: secondStats.memoryCount === firstSnapshotMemoryCount && (secondStoredSnapshot?.memories.length ?? 0) === firstSnapshotMemoryCount,
        detail: "firstSnapshot=" + firstSnapshotMemoryCount + ", runtime=" + secondStats.memoryCount + ", stored=" + String(secondStoredSnapshot?.memories.length ?? 0),
      },
      {
        label: "不传 memoryStore 时保持纯内存行为且不记录 store trace",
        pass: noStore.status === "completed" && !hasStoreEvent(noStore),
        detail: "status=" + noStore.status + ", hasStoreTrace=" + hasStoreEvent(noStore),
      },
    ];

    console.log("=".repeat(60));
    console.log("  ✅ Runtime Store Binding 验收检查 (10 条)");
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
      ? "  🎉 Runtime Store Binding 验证通过！"
      : "  ❌ 部分验收标准未通过");
    console.log("-".repeat(60));

    if (passCount !== checks.length) process.exit(1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Runtime Store Binding Demo 执行失败:", error);
  process.exit(1);
});
