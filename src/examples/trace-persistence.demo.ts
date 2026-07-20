// ============================================================================
// trace-persistence.demo.ts — v0.3.7
// 验证 Trace 持久化：TraceSnapshot + JsonTraceStore + clear/restore 后可复盘
// ============================================================================

import { randomUUID } from "node:crypto";
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
import { JsonTraceStore } from "../trace/json-trace-store";
import { loadTraceLogger, saveTraceLogger } from "../trace/trace-persistence";
import {
  TRACE_SNAPSHOT_SCHEMA_VERSION,
  assertTraceSnapshot,
  type TraceSnapshot,
} from "../trace/trace-snapshot";
import { memoryService } from "../memory/memory-service";
import { approvalGate } from "../approvals/approval-gate";
import type { ActorRunTrace, TraceEvent } from "../core/types/trace";

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
    allowed_skills: ["trace_persistence"],
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
  skill_id: "trace_persistence", name: "Trace Persistence 验证",
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

async function approveIfNeeded(output: ActorRunOutput): Promise<ActorRunOutput> {
  if (output.status !== "waiting_approval" || !output.pendingApproval) return output;
  return actorRuntime.continue(output.actorRunId, {
    type: "approval_decision",
    decision: {
      approvalRequestId: output.pendingApproval.approvalRequestId,
      decision: "approve",
      comment: "Trace Persistence Demo 自动审批通过",
      decidedBy: "trace_persistence_demo_approver",
      decidedAt: new Date().toISOString(),
    },
  });
}

async function runPractice(): Promise<ActorRunOutput> {
  let output = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: "客户说扫码枪连不上系统，还要求退款。" },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  });
  output = await approveIfNeeded(output);
  return output;
}

function hasEvent(trace: ActorRunTrace | undefined, eventType: string): boolean {
  return Boolean(trace?.events.some((event) => event.eventType === eventType));
}

function hasCompletedEnd(trace: ActorRunTrace | undefined): boolean {
  return Boolean(trace?.events.some((event) =>
    event.eventType === "actor_run_end" && event.data.status === "completed"
  ));
}

function eventSignature(events: TraceEvent[]): string {
  return events
    .map((event) => `${event.sequence}:${event.eventType}:${event.stepKey ?? ""}`)
    .join("|");
}

function traceSnapshotRejected(snapshot: TraceSnapshot): boolean {
  try {
    assertTraceSnapshot(snapshot);
    return false;
  } catch {
    return true;
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.3.7 — Trace Persistence Demo");
  console.log("=".repeat(60));
  console.log();

  resetRuntime();

  const tempDir = await mkdtemp(join(tmpdir(), "organize-trace-store-"));
  const storePath = join(tempDir, "trace-store.json");
  const store = new JsonTraceStore(storePath);

  try {
    console.log("🚀 运行一次 Actor practice，生成内存 Trace");
    const initialLoad = await store.load();
    const output = await runPractice();
    const originalTrace = traceLogger.getTrace(output.actorRunId);
    const originalEvents = originalTrace?.events ?? [];
    const originalSignature = eventSignature(originalEvents);
    const originalEventIds = new Set(originalEvents.map((event) => event.eventId));
    console.log("  Status: " + output.status);
    console.log("  ActorRunId: " + output.actorRunId);
    console.log("  TraceEvents: " + originalEvents.length);
    console.log();

    console.log("💾 dump TraceSnapshot 并通过 JsonTraceStore 保存");
    const snapshot = traceLogger.dumpSnapshot();
    await saveTraceLogger(traceLogger, store);
    const storedSnapshot = await store.load();
    console.log("  SnapshotSchema: " + snapshot.schemaVersion);
    console.log("  SnapshotTraceCount: " + snapshot.traces.length);
    console.log("  StoredTraceCount: " + String(storedSnapshot?.traces.length ?? 0));
    console.log();

    console.log("🧹 清空 TraceLogger，再从 JsonTraceStore 恢复");
    traceLogger.clear();
    const clearedTraceCount = traceLogger.getAllTraces().length;
    const loaded = await loadTraceLogger(traceLogger, store);
    const restoredTrace = traceLogger.getTrace(output.actorRunId);
    const restoredEvents = restoredTrace?.events ?? [];
    const restoredSignature = eventSignature(restoredEvents);
    console.log("  ClearedTraceCount: " + clearedTraceCount);
    console.log("  LoadTraceLogger: " + loaded);
    console.log("  RestoredTraceEvents: " + restoredEvents.length);
    console.log();

    console.log("🔂 恢复后继续运行一次，验证 eventId UUID 不冲突");
    const afterRestore = await runPractice();
    const afterRestoreTrace = traceLogger.getTrace(afterRestore.actorRunId);
    const firstNewEventId = afterRestoreTrace?.events[0]?.eventId ?? "missing";
    console.log("  NewActorRunId: " + afterRestore.actorRunId);
    console.log("  FirstNewEventId: " + firstNewEventId);
    console.log();

    const validationBeforeSuspend = structuredClone(snapshot);
    const validationTrace = validationBeforeSuspend.traces[0];
    validationTrace.events.splice(1, 0, {
      eventId: `evt_${randomUUID()}`,
      actorRunId: validationTrace.actorRunId,
      sequence: 2,
      eventType: "continuation_validation_failed",
      timestamp: new Date().toISOString(),
      data: { validationErrors: ["forged running-state validation"] },
    });
    validationTrace.events.forEach((event, index) => { event.sequence = index + 1; });
    const validationBeforeSuspendRejected = traceSnapshotRejected(validationBeforeSuspend);

    const waitingDirectlyEnds = structuredClone(snapshot);
    const waitingTrace = waitingDirectlyEnds.traces[0];
    const suspendIndex = waitingTrace.events.findIndex(
      (event) => event.eventType === "actor_run_suspended"
    );
    if (suspendIndex < 0) throw new Error("Expected a suspended lifecycle in Trace demo");
    waitingTrace.events = waitingTrace.events.slice(0, suspendIndex + 1);
    waitingTrace.events.push({
      eventId: `evt_${randomUUID()}`,
      actorRunId: waitingTrace.actorRunId,
      sequence: waitingTrace.events.length + 1,
      eventType: "actor_run_end",
      timestamp: new Date().toISOString(),
      data: { status: "error" },
    });
    waitingTrace.status = "error";
    waitingTrace.endedAt = new Date().toISOString();
    const waitingDirectlyEndsRejected = traceSnapshotRejected(waitingDirectlyEnds);

    const duplicateEventIdsWithinRun = structuredClone(snapshot);
    duplicateEventIdsWithinRun.traces[0].events[1].eventId =
      duplicateEventIdsWithinRun.traces[0].events[0].eventId;
    const duplicateEventIdsWithinRunRejected = traceSnapshotRejected(duplicateEventIdsWithinRun);

    const legacyCrossRunEventIds = structuredClone(snapshot);
    const duplicateTrace = structuredClone(legacyCrossRunEventIds.traces[0]);
    duplicateTrace.actorRunId = `${duplicateTrace.actorRunId}_duplicate`;
    duplicateTrace.events.forEach((event) => { event.actorRunId = duplicateTrace.actorRunId; });
    legacyCrossRunEventIds.traces.push(duplicateTrace);
    const legacyCrossRunEventIdsAccepted = !traceSnapshotRejected(legacyCrossRunEventIds);

    const newerSnapshot = traceLogger.dumpSnapshot();
    await Promise.all([store.save(structuredClone(snapshot)), store.save(newerSnapshot)]);
    const concurrentlyStored = await store.load();
    const concurrentTraceSavesPreserveCallOrder =
      concurrentlyStored?.traces.length === newerSnapshot.traces.length &&
      concurrentlyStored.traces.some((trace) => trace.actorRunId === afterRestore.actorRunId);

    const checks: CheckResult[] = [
      {
        label: "Actor practice 正常 completed 并产生 Trace",
        pass: output.status === "completed" && originalTrace?.status === "completed" && originalEvents.length > 0,
        detail: "status=" + output.status + ", traceStatus=" + String(originalTrace?.status) + ", events=" + originalEvents.length,
      },
      {
        label: "Trace 包含 actor_run_start",
        pass: hasEvent(originalTrace, "actor_run_start"),
        detail: "hasStart=" + hasEvent(originalTrace, "actor_run_start"),
      },
      {
        label: "Trace 包含 context_built",
        pass: hasEvent(originalTrace, "context_built"),
        detail: "hasContextBuilt=" + hasEvent(originalTrace, "context_built"),
      },
      {
        label: "Trace 包含 memory_retrieved",
        pass: hasEvent(originalTrace, "memory_retrieved"),
        detail: "hasMemoryRetrieved=" + hasEvent(originalTrace, "memory_retrieved"),
      },
      {
        label: "Trace 包含 completed actor_run_end",
        pass: hasCompletedEnd(originalTrace),
        detail: "hasCompletedEnd=" + hasCompletedEnd(originalTrace),
      },
      {
        label: "dumpSnapshot 导出 trace.snapshot.v2",
        pass: snapshot.schemaVersion === TRACE_SNAPSHOT_SCHEMA_VERSION && snapshot.traces.length === 1,
        detail: "schema=" + snapshot.schemaVersion + ", traces=" + snapshot.traces.length,
      },
      {
        label: "JsonTraceStore.save/load 成功保存 TraceSnapshot",
        pass: Boolean(
          initialLoad === null &&
          storedSnapshot &&
          storedSnapshot.schemaVersion === TRACE_SNAPSHOT_SCHEMA_VERSION &&
          storedSnapshot.traces.length === 1
        ),
        detail: "initialLoad=" + String(initialLoad) + ", storedTraces=" + String(storedSnapshot?.traces.length ?? 0),
      },
      {
        label: "traceLogger.clear 后 Trace 为空",
        pass: clearedTraceCount === 0,
        detail: "clearedTraceCount=" + clearedTraceCount,
      },
      {
        label: "JsonTraceStore.load + restoreSnapshot 后 Trace 可恢复",
        pass: loaded && Boolean(restoredTrace) && restoredTrace?.actorRunId === output.actorRunId,
        detail: "loaded=" + loaded + ", restoredActorRunId=" + String(restoredTrace?.actorRunId),
      },
      {
        label: "恢复后的 Trace 保留顺序且新 eventId 使用不冲突 UUID",
        pass:
          restoredTrace?.status === originalTrace?.status &&
          restoredEvents.length === originalEvents.length &&
          restoredSignature === originalSignature &&
          /^evt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(firstNewEventId) &&
          !originalEventIds.has(firstNewEventId),
        detail:
          "restoredStatus=" + String(restoredTrace?.status) +
          ", events=" + restoredEvents.length +
          ", sameOrder=" + String(restoredSignature === originalSignature) +
          ", firstNewEventId=" + firstNewEventId +
          ", collides=" + String(originalEventIds.has(firstNewEventId)),
      },
      {
        label: "Trace 拒绝 waiting 之前的 continuation validation 事件",
        pass: validationBeforeSuspendRejected,
        detail: String(validationBeforeSuspendRejected),
      },
      {
        label: "Trace 拒绝 waiting 未 resume 就直接终止",
        pass: waitingDirectlyEndsRejected,
        detail: String(waitingDirectlyEndsRejected),
      },
      {
        label: "TraceSnapshot 拒绝同一 run 内重复 eventId",
        pass: duplicateEventIdsWithinRunRejected,
        detail: String(duplicateEventIdsWithinRunRejected),
      },
      {
        label: "TraceSnapshot 接受不同 run 的 legacy eventId 重复",
        pass: legacyCrossRunEventIdsAccepted,
        detail: String(legacyCrossRunEventIdsAccepted),
      },
      {
        label: "JsonTraceStore 同实例并发 save 按调用顺序提交",
        pass: concurrentTraceSavesPreserveCallOrder,
        detail: String(concurrentTraceSavesPreserveCallOrder),
      },
    ];

    console.log("=".repeat(60));
    console.log(`  ✅ Trace Persistence 验收检查 (${checks.length} 条)`);
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
      ? "  🎉 Trace Persistence 验证通过！"
      : "  ❌ 部分验收标准未通过");
    console.log("-".repeat(60));

    if (passCount !== checks.length) process.exit(1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Trace Persistence Demo 执行失败:", error);
  process.exit(1);
});
