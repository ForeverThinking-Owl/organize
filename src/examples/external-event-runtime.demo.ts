// ============================================================================
// external-event-runtime.demo.ts — v0.4.4
// 验证 wait_external_event Runtime 语义与 pending / bundle 恢复
// ============================================================================

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actorRuntime, ActorRunOutput } from "../runtime/actor-runtime";
import { toolGateway } from "../tools/tool-gateway";
import { queryOrderInfoTool, QueryOrderInfoExecutor } from "../tools/mock-tools";
import { traceLogger } from "../trace/trace-logger";
import { memoryService } from "../memory/memory-service";
import { approvalGate } from "../approvals/approval-gate";
import { JsonPendingRunStore } from "../runtime/json-pending-run-store";
import { JsonRuntimeRecoveryStore } from "../runtime/json-runtime-recovery-store";
import { createRuntimeRecoveryBundle, restoreRuntimeRecoveryBundle } from "../runtime/runtime-recovery-bundle";
import type { RuntimeRecoveryBundle } from "../runtime/runtime-recovery-bundle";
import type { PendingRunSnapshot } from "../runtime/pending-run-snapshot";
import type { TraceEvent } from "../core/types/trace";

const ACTOR_CONFIG = {
  actor_id: "customer_service_actor", organization_id: "org_001",
  unit_id: "unit_customer_service", name: "客服 Actor",
  type: "ai" as const, role: "customer_service",
  responsibility: "接收客户问题、等待外部系统事件、生成后续处理建议",
  autonomy_level: "L2_read_and_draft",
  memory: [
    "涉及退款时，不要承诺退款完成，只能说提交退款申请或等待财务确认。",
    "外部支付确认事件到达后，才能继续处理支付相关回复。",
  ],
  permissions: {
    allowed_tools: ["query_order_info"],
    denied_tools: ["create_refund_request", "approve_refund"],
    allowed_skills: ["external_event_runtime"],
  },
  approval_judgment: {
    must_request_approval_when: ["创建 urgent 工单", "外部正式发送客户回复", "涉及退款承诺"],
  },
};

const SKILL_CONFIG = {
  skill_id: "external_event_runtime", name: "External Event Runtime 语义验证",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "wait_payment", type: "wait_external_event",
      event_name: "payment.confirmed",
      correlation_key: "{{outputs.order_info.orderId}}",
      reason: "等待支付系统确认订单支付完成。",
      output_key: "payment_event",
      event_schema: {
        type: "object",
        required: ["payment_id", "status"],
        properties: {
          payment_id: { type: "string" },
          status: { type: "string" },
        },
      } },
    { step_key: "draft_reply", type: "transform",
      mapping: {
        summary: "External Event Runtime 验证完成",
        event_status_from_output: "{{outputs.payment_event.payload.status}}",
        event_payment_id_from_output: "{{outputs.payment_event.payload.payment_id}}",
        event_status_from_step: "{{steps.wait_payment.payload.status}}",
        draft: "支付事件 {{outputs.payment_event.payload.payment_id}} 已到达，状态：{{outputs.payment_event.payload.status}}。",
      },
      output_key: "reply_draft" },
    { step_key: "return", type: "return",
      output_mapping: {
        summary: "{{outputs.reply_draft.summary}}",
        event_status_from_output: "{{outputs.reply_draft.event_status_from_output}}",
        event_payment_id_from_output: "{{outputs.reply_draft.event_payment_id_from_output}}",
        event_status_from_step: "{{outputs.reply_draft.event_status_from_step}}",
        draft: "{{outputs.reply_draft.draft}}",
        source: "external_event_runtime",
      } },
  ],
};

interface CheckResult { label: string; pass: boolean; detail: string; }
interface ScenarioResult {
  waiting: ActorRunOutput;
  completed: ActorRunOutput;
  snapshot?: PendingRunSnapshot | null;
  bundle?: RuntimeRecoveryBundle | null;
  storeSaved?: boolean;
  loaded?: boolean;
  memoryCountAfterRestore?: number;
  traceEventCountAfterRestore?: number;
  requestedData?: Record<string, unknown> | null;
  suspendedData?: Record<string, unknown> | null;
  receivedData?: Record<string, unknown> | null;
  resumedData?: Record<string, unknown> | null;
  hasResumed?: boolean;
  hasCompletedEnd?: boolean;
}

function registerTools(): void {
  toolGateway.registerDefinition(queryOrderInfoTool);
  toolGateway.registerExecutor("query_order_info", new QueryOrderInfoExecutor());
}

function resetRuntime(): void {
  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
  registerTools();
}

function clearFullRuntime(actorRunId: string): void {
  actorRuntime.clearRun(actorRunId);
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

function hasEvent(output: ActorRunOutput, eventType: string): boolean {
  return traceEvents(output).some((event) => event.eventType === eventType);
}

function hasCompletedEnd(output: ActorRunOutput): boolean {
  return traceEvents(output).some((event) => event.eventType === "actor_run_end" && event.data.status === "completed");
}

function traceSummary(waiting: ActorRunOutput, completed: ActorRunOutput) {
  return {
    requestedData: findEvent(waiting, "external_event_requested")?.data ?? null,
    suspendedData: findEvent(waiting, "actor_run_suspended")?.data ?? null,
    receivedData: findEvent(completed, "external_event_received")?.data ?? null,
    resumedData: findEvent(completed, "actor_run_resumed")?.data ?? null,
    hasResumed: hasEvent(completed, "actor_run_resumed"),
    hasCompletedEnd: hasCompletedEnd(completed),
  };
}

function runInput() {
  return {
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: "客户支付后等待支付系统确认。" },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  };
}

function externalEventRequestId(output: ActorRunOutput): string {
  if (!output.pendingExternalEvent) throw new Error("Expected pendingExternalEvent");
  return output.pendingExternalEvent.externalEventRequestId;
}

async function continueWithPaymentEvent(waiting: ActorRunOutput): Promise<ActorRunOutput> {
  return actorRuntime.continue(waiting.actorRunId, {
    type: "external_event_received",
    event: {
      externalEventRequestId: externalEventRequestId(waiting),
      eventName: "payment.confirmed",
      payload: {
        payment_id: "PAY_10086",
        status: "confirmed",
      },
      receivedBy: "payment_webhook",
      receivedAt: new Date().toISOString(),
    },
  });
}

async function runDirectScenario(): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runInput());
  const completed = await continueWithPaymentEvent(waiting);
  return { waiting, completed, ...traceSummary(waiting, completed) };
}

async function runPendingScenario(storePath: string): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runInput());
  const snapshot = actorRuntime.dumpPendingRun(waiting.actorRunId);
  const store = new JsonPendingRunStore(storePath);
  if (snapshot) await store.save(snapshot);
  actorRuntime.clearRun(waiting.actorRunId);
  const loaded = await store.load(waiting.actorRunId);
  if (loaded) actorRuntime.restorePendingRun(loaded);
  const completed = await continueWithPaymentEvent(waiting);
  return { waiting, completed, snapshot, storeSaved: Boolean(snapshot), loaded: Boolean(loaded), ...traceSummary(waiting, completed) };
}

async function runBundleScenario(storePath: string): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runInput());
  const bundle = createRuntimeRecoveryBundle(waiting.actorRunId);
  const store = new JsonRuntimeRecoveryStore(storePath);
  if (bundle) await store.save(bundle);
  clearFullRuntime(waiting.actorRunId);
  const loaded = await store.load(waiting.actorRunId);
  if (loaded) restoreRuntimeRecoveryBundle(loaded);
  const memoryCountAfterRestore = memoryService.getStats().memoryCount;
  const traceEventCountAfterRestore = traceLogger.getTrace(waiting.actorRunId)?.events.length ?? 0;
  const completed = await continueWithPaymentEvent(waiting);
  return { waiting, completed, bundle, storeSaved: Boolean(bundle), loaded: Boolean(loaded), memoryCountAfterRestore, traceEventCountAfterRestore, ...traceSummary(waiting, completed) };
}

function directChecks(result: ScenarioResult): CheckResult[] {
  const output = result.completed.result ?? {};
  return [
    {
      label: "执行到 wait_external_event 时返回 waiting_external_event",
      pass: result.waiting.status === "waiting_external_event",
      detail: "status=" + result.waiting.status,
    },
    {
      label: "输出 pendingExternalEvent request",
      pass:
        result.waiting.pendingExternalEvent?.eventName === "payment.confirmed" &&
        result.waiting.pendingExternalEvent.outputKey === "payment_event" &&
        result.waiting.pendingExternalEvent.correlationKey === "ORDER_10086",
      detail: JSON.stringify(result.waiting.pendingExternalEvent ?? null),
    },
    {
      label: "Trace 记录 external_event_requested",
      pass: result.requestedData?.externalEventRequestId === result.waiting.pendingExternalEvent?.externalEventRequestId,
      detail: JSON.stringify(result.requestedData ?? null),
    },
    {
      label: "Trace 记录 actor_run_suspended(waitingKind=external_event)",
      pass: result.suspendedData?.waitingKind === "external_event" && result.suspendedData.status === "waiting_external_event",
      detail: JSON.stringify(result.suspendedData ?? null),
    },
    {
      label: "continue(external_event_received) 后 completed",
      pass: result.completed.status === "completed",
      detail: "status=" + result.completed.status,
    },
    {
      label: "Trace 记录 actor_run_resumed(waitingKind=external_event)",
      pass: result.resumedData?.waitingKind === "external_event" && result.resumedData.resumedBy === "external_event_received",
      detail: JSON.stringify(result.resumedData ?? null),
    },
    {
      label: "Trace 记录 external_event_received 且不记录完整 payload",
      pass: result.receivedData?.eventName === "payment.confirmed" && !("payload" in (result.receivedData ?? {})),
      detail: JSON.stringify(result.receivedData ?? null),
    },
    {
      label: "transform 能读取 event payload",
      pass: output.event_status_from_output === "confirmed" && output.event_payment_id_from_output === "PAY_10086" && output.event_status_from_step === "confirmed",
      detail: JSON.stringify(output),
    },
    {
      label: "return output_mapping 输出 event payload 字段",
      pass: String(output.draft ?? "").includes("PAY_10086") && output.source === "external_event_runtime",
      detail: "draft=" + String(output.draft) + ", source=" + String(output.source),
    },
    {
      label: "最终 Trace 记录 completed actor_run_end",
      pass: result.hasCompletedEnd === true,
      detail: "hasCompletedEnd=" + String(result.hasCompletedEnd),
    },
  ];
}

function persistenceChecks(pending: ScenarioResult, bundle: ScenarioResult): CheckResult[] {
  return [
    {
      label: "PendingRunSnapshot 支持 external_event",
      pass: pending.snapshot?.pendingKind === "external_event" && pending.snapshot.status === "waiting_external_event",
      detail: JSON.stringify({ pendingKind: pending.snapshot?.pendingKind, status: pending.snapshot?.status }),
    },
    {
      label: "PendingRunStore save/load/restore 后 continue completed",
      pass: pending.storeSaved === true && pending.loaded === true && pending.completed.status === "completed" && pending.hasResumed === true,
      detail: `storeSaved=${pending.storeSaved}, loaded=${pending.loaded}, status=${pending.completed.status}, hasResumed=${pending.hasResumed}`,
    },
    {
      label: "RuntimeRecoveryBundle 支持 external_event",
      pass: bundle.bundle?.pendingKind === "external_event" && bundle.bundle.status === "waiting_external_event",
      detail: JSON.stringify({ pendingKind: bundle.bundle?.pendingKind, status: bundle.bundle?.status }),
    },
    {
      label: "RecoveryBundle restore 后 memory / trace 均恢复",
      pass: Number(bundle.memoryCountAfterRestore ?? 0) > 0 && Number(bundle.traceEventCountAfterRestore ?? 0) > 0,
      detail: `memory=${bundle.memoryCountAfterRestore}, trace=${bundle.traceEventCountAfterRestore}`,
    },
    {
      label: "RecoveryBundle restore 后 continue completed",
      pass: bundle.storeSaved === true && bundle.loaded === true && bundle.completed.status === "completed" && bundle.hasResumed === true && bundle.hasCompletedEnd === true,
      detail: `storeSaved=${bundle.storeSaved}, loaded=${bundle.loaded}, status=${bundle.completed.status}, hasResumed=${bundle.hasResumed}, hasCompletedEnd=${bundle.hasCompletedEnd}`,
    },
  ];
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.4.4 — External Event Runtime Demo");
  console.log("=".repeat(60));
  console.log();

  const tempDir = await mkdtemp(join(tmpdir(), "organize-external-event-"));
  try {
    console.log("⚡ 直接运行：wait_external_event → continue → completed");
    const direct = await runDirectScenario();
    console.log("  WaitingStatus: " + direct.waiting.status);
    console.log("  CompletedStatus: " + direct.completed.status);
    console.log();

    console.log("📦 PendingRun 恢复：dump / save / restore / continue");
    const pending = await runPendingScenario(join(tempDir, "pending-runs.json"));
    console.log("  SnapshotKind: " + String(pending.snapshot?.pendingKind));
    console.log("  CompletedStatus: " + pending.completed.status);
    console.log();

    console.log("🧩 RecoveryBundle 恢复：bundle save / restore / continue");
    const bundle = await runBundleScenario(join(tempDir, "recovery-bundles.json"));
    console.log("  BundleKind: " + String(bundle.bundle?.pendingKind));
    console.log("  CompletedStatus: " + bundle.completed.status);
    console.log();

    const checks = [...directChecks(direct), ...persistenceChecks(pending, bundle)];

    console.log("=".repeat(60));
    console.log("  ✅ External Event Runtime 验收检查 (15 条)");
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
      ? "  🎉 External Event Runtime 验证通过！"
      : "  ❌ 部分验收标准未通过");
    console.log("-".repeat(60));

    if (passCount !== checks.length) process.exit(1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("External Event Runtime Demo 执行失败:", error);
  process.exit(1);
});
