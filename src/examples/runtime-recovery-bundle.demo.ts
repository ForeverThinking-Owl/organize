// ============================================================================
// runtime-recovery-bundle.demo.ts — v0.4.2
// 验证 PendingRun + Trace + Memory 的组合恢复包
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
import {
  assertRuntimeRecoveryStoreSnapshot,
  JsonRuntimeRecoveryStore,
} from "../runtime/json-runtime-recovery-store";
import {
  RUNTIME_RECOVERY_STORE_SCHEMA_VERSION,
  createRuntimeRecoveryBundle,
  restoreRuntimeRecoveryBundle,
  type RuntimeRecoveryBundle,
} from "../runtime/runtime-recovery-bundle";
import { saveRuntimeRecoveryBundle, loadRuntimeRecoveryBundle, deleteRuntimeRecoveryBundle } from "../runtime/runtime-recovery-persistence";
import type { TraceEvent } from "../core/types/trace";

const BASE_ACTOR_CONFIG = {
  actor_id: "customer_service_actor", organization_id: "org_001",
  unit_id: "unit_customer_service", name: "客服 Actor",
  type: "ai" as const, role: "customer_service",
  responsibility: "接收客户问题、查询上下文、处理 recovery bundle 恢复、生成后续处理建议",
  autonomy_level: "L2_read_and_draft",
  memory: [
    "涉及退款时，不要承诺退款完成，只能说提交退款申请或等待财务确认。",
    "设备连接问题通常需要技术排查。",
  ],
  permissions: {
    allowed_tools: ["query_order_info", "query_ticket_history", "create_ticket"],
    denied_tools: ["create_refund_request", "approve_refund"],
    allowed_skills: ["bundle_human", "bundle_skill_approval", "bundle_tool_approval"],
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

const HUMAN_INPUT_SKILL = {
  skill_id: "bundle_human", name: "Recovery Bundle Human Input",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "ask_human", type: "human_input",
      prompt: "请人工补充是否允许继续。", output_key: "human_confirmation" },
    { step_key: "return", type: "return",
      output_mapping: { summary: "human bundle restored", human_confirmation: "{{outputs.human_confirmation}}" } },
  ],
};

const SKILL_APPROVAL_SKILL = {
  skill_id: "bundle_skill_approval", name: "Recovery Bundle Skill Approval",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "manual_approval", type: "wait_approval",
      reason: "请人工审批是否允许继续。", output_key: "approval_result" },
    { step_key: "return", type: "return",
      output_mapping: {
        summary: "skill approval bundle restored",
        approval_decision: "{{outputs.approval_result.decision}}",
        approval_comment: "{{outputs.approval_result.comment}}",
      } },
  ],
};

const TOOL_APPROVAL_SKILL = {
  skill_id: "bundle_tool_approval", name: "Recovery Bundle Tool Approval",
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
interface ScenarioResult {
  label: string;
  waiting: ActorRunOutput;
  bundle: RuntimeRecoveryBundle | null;
  loaded: RuntimeRecoveryBundle | null;
  completed: ActorRunOutput;
  listCountAfterSave: number;
  listCountAfterDelete: number;
  memoryCountAfterRestore: number;
  traceEventCountAfterRestore: number;
  unrelatedStatePreserved: boolean;
  hasResumed: boolean;
  hasCompletedEnd: boolean;
}

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

function clearRuntimeEnvironment(actorRunId: string): void {
  actorRuntime.clearRun(actorRunId);
  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
  registerTools();
}

function traceEvents(output: ActorRunOutput): TraceEvent[] {
  return traceLogger.getTrace(output.actorRunId)?.events ?? [];
}

function hasEvent(output: ActorRunOutput, eventType: string): boolean {
  return traceEvents(output).some((event) => event.eventType === eventType);
}

function hasCompletedEnd(output: ActorRunOutput): boolean {
  return traceEvents(output).some((event) => event.eventType === "actor_run_end" && event.data.status === "completed");
}

function restoredTraceEventCount(actorRunId: string): number {
  return traceLogger.getTrace(actorRunId)?.events.length ?? 0;
}

function runArgs(skillConfig: typeof HUMAN_INPUT_SKILL | typeof SKILL_APPROVAL_SKILL | typeof TOOL_APPROVAL_SKILL, text: string) {
  return {
    actorConfig: BASE_ACTOR_CONFIG,
    skillConfig,
    input: { text },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  };
}

async function persistClearRestore(
  store: JsonRuntimeRecoveryStore,
  waiting: ActorRunOutput
): Promise<{
  bundle: RuntimeRecoveryBundle | null;
  loaded: RuntimeRecoveryBundle | null;
  listCountAfterSave: number;
  listCountAfterDelete: number;
  memoryCountAfterRestore: number;
  traceEventCountAfterRestore: number;
  unrelatedStatePreserved: boolean;
}> {
  const bundle = createRuntimeRecoveryBundle(waiting.actorRunId);
  if (!bundle) {
    return { bundle, loaded: null, listCountAfterSave: 0, listCountAfterDelete: 0, memoryCountAfterRestore: 0, traceEventCountAfterRestore: 0, unrelatedStatePreserved: false };
  }

  await saveRuntimeRecoveryBundle(store, bundle);
  const listCountAfterSave = (await store.list()).length;

  clearRuntimeEnvironment(waiting.actorRunId);
  const betaMemory = memoryService.addMemory({
    organizationId: "org_beta_preserved",
    actorId: "beta_actor",
    scope: "actor_private",
    type: "semantic",
    content: `preserve-${waiting.actorRunId}`,
    status: "active",
  });
  const betaRunId = `beta_${waiting.actorRunId}`;
  traceLogger.startRun(betaRunId, "beta_actor", "beta_skill");
  traceLogger.suspendRun(betaRunId, "waiting_human_input", {
    waitingKind: "human_input",
    requestId: `beta_request_${waiting.actorRunId}`,
  });
  const loaded = await loadRuntimeRecoveryBundle(store, waiting.actorRunId);
  if (loaded) restoreRuntimeRecoveryBundle(loaded);

  const memoryCountAfterRestore = memoryService.getStats().memoryCount;
  const traceEventCountAfterRestore = restoredTraceEventCount(waiting.actorRunId);
  const unrelatedStatePreserved =
    memoryService.dumpOrganizationSnapshot("org_beta_preserved").memories
      .some((memory) => memory.memoryId === betaMemory.memoryId) &&
    traceLogger.getTrace(betaRunId)?.status === "waiting_human_input";

  await deleteRuntimeRecoveryBundle(store, waiting.actorRunId);
  const listCountAfterDelete = (await store.list()).length;

  return { bundle, loaded, listCountAfterSave, listCountAfterDelete, memoryCountAfterRestore, traceEventCountAfterRestore, unrelatedStatePreserved };
}

function traceSummary(completed: ActorRunOutput): { hasResumed: boolean; hasCompletedEnd: boolean } {
  return {
    hasResumed: hasEvent(completed, "actor_run_resumed"),
    hasCompletedEnd: hasCompletedEnd(completed),
  };
}

async function runHumanInputScenario(store: JsonRuntimeRecoveryStore): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runArgs(HUMAN_INPUT_SKILL, "客户需要人工补充意见。"));
  const persisted = await persistClearRestore(store, waiting);
  if (!waiting.pendingHumanInput) throw new Error("Expected pendingHumanInput");
  const completed = await actorRuntime.continue(waiting.actorRunId, {
    type: "human_input_response",
    response: {
      humanInputRequestId: waiting.pendingHumanInput.humanInputRequestId,
      value: "允许继续。",
      respondedBy: "human_operator",
      respondedAt: new Date().toISOString(),
    },
  });
  return { label: "human_input", waiting, completed, ...persisted, ...traceSummary(completed) };
}

async function runSkillApprovalScenario(store: JsonRuntimeRecoveryStore): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runArgs(SKILL_APPROVAL_SKILL, "客户需要人工审批。"));
  const persisted = await persistClearRestore(store, waiting);
  if (!waiting.pendingApproval) throw new Error("Expected pendingApproval");
  const completed = await actorRuntime.continue(waiting.actorRunId, {
    type: "approval_decision",
    decision: {
      approvalRequestId: waiting.pendingApproval.approvalRequestId,
      decision: "approve_with_comment",
      comment: "允许继续。",
      decidedBy: "approval_operator",
      decidedAt: new Date().toISOString(),
    },
  });
  return { label: "skill_approval", waiting, completed, ...persisted, ...traceSummary(completed) };
}

async function runToolApprovalScenario(store: JsonRuntimeRecoveryStore): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runArgs(TOOL_APPROVAL_SKILL, "客户说扫码枪连不上系统，还要求退款。"));
  const persisted = await persistClearRestore(store, waiting);
  if (!waiting.pendingApproval) throw new Error("Expected pendingApproval");
  const completed = await actorRuntime.continue(waiting.actorRunId, {
    type: "approval_decision",
    decision: {
      approvalRequestId: waiting.pendingApproval.approvalRequestId,
      decision: "approve",
      comment: "允许创建 urgent 工单。",
      decidedBy: "approval_operator",
      decidedAt: new Date().toISOString(),
    },
  });
  return { label: "tool_approval", waiting, completed, ...persisted, ...traceSummary(completed) };
}

function bundleChecks(result: ScenarioResult, expectedKind: "human_input" | "skill_approval" | "tool_approval"): CheckResult[] {
  return [
    {
      label: `${result.label}: createRuntimeRecoveryBundle 得到 ${expectedKind}`,
      pass: result.bundle?.pendingKind === expectedKind,
      detail: JSON.stringify({ pendingKind: result.bundle?.pendingKind, status: result.bundle?.status }),
    },
    {
      label: `${result.label}: bundle 包含 pendingRun / trace / memory 三段`,
      pass: Boolean(result.bundle?.pendingRun && result.bundle.trace.traces.length === 1 && result.bundle.memory.schemaVersion === "memory.snapshot.v1"),
      detail: JSON.stringify({ hasPendingRun: Boolean(result.bundle?.pendingRun), traceCount: result.bundle?.trace.traces.length, memorySchema: result.bundle?.memory.schemaVersion }),
    },
    {
      label: `${result.label}: JsonRuntimeRecoveryStore save/list/load/delete 正常`,
      pass:
        result.listCountAfterSave === 1 &&
        result.loaded?.actorRunId === result.waiting.actorRunId &&
        result.listCountAfterDelete === 0,
      detail: `saveCount=${result.listCountAfterSave}, loaded=${String(result.loaded?.actorRunId)}, deleteCount=${result.listCountAfterDelete}`,
    },
    {
      label: `${result.label}: restore 后 memory / trace 均恢复`,
      pass: result.memoryCountAfterRestore > 0 && result.traceEventCountAfterRestore > 0,
      detail: `memoryCount=${result.memoryCountAfterRestore}, traceEvents=${result.traceEventCountAfterRestore}`,
    },
    {
      label: `${result.label}: restore 保留其他 organization 的 Memory / Trace`,
      pass: result.unrelatedStatePreserved,
      detail: String(result.unrelatedStatePreserved),
    },
    {
      label: `${result.label}: restore 后 continue completed 且 Trace 接续`,
      pass: result.completed.status === "completed" && result.hasResumed && result.hasCompletedEnd,
      detail: `status=${result.completed.status}, hasResumed=${result.hasResumed}, hasCompletedEnd=${result.hasCompletedEnd}`,
    },
  ];
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.4.2 — Runtime Recovery Bundle Demo");
  console.log("=".repeat(60));
  console.log();

  const tempDir = await mkdtemp(join(tmpdir(), "organize-runtime-recovery-"));
  const store = new JsonRuntimeRecoveryStore(join(tempDir, "runtime-recovery.json"));

  try {
    console.log("🙋 场景 A：human_input recovery bundle");
    const human = await runHumanInputScenario(store);
    console.log("  WaitingStatus: " + human.waiting.status);
    console.log("  BundleKind: " + String(human.bundle?.pendingKind));
    console.log("  CompletedStatus: " + human.completed.status);
    console.log();

    console.log("✅ 场景 B：Skill wait_approval recovery bundle");
    const skillApproval = await runSkillApprovalScenario(store);
    console.log("  WaitingStatus: " + skillApproval.waiting.status);
    console.log("  BundleKind: " + String(skillApproval.bundle?.pendingKind));
    console.log("  CompletedStatus: " + skillApproval.completed.status);
    console.log();

    console.log("🛠️ 场景 C：ToolCall approval recovery bundle");
    const toolApproval = await runToolApprovalScenario(store);
    console.log("  WaitingStatus: " + toolApproval.waiting.status);
    console.log("  BundleKind: " + String(toolApproval.bundle?.pendingKind));
    console.log("  CompletedStatus: " + toolApproval.completed.status);
    console.log();

    const completedBundle = createRuntimeRecoveryBundle(toolApproval.completed.actorRunId);
    const baselineMemorySnapshot = memoryService.dumpSnapshot();
    const baselineMemory = JSON.stringify({
      memories: baselineMemorySnapshot.memories,
      candidates: baselineMemorySnapshot.candidates,
      lastWriteSummary: baselineMemorySnapshot.lastWriteSummary,
    });
    const baselineTrace = JSON.stringify(traceLogger.getAllTraces());
    const mismatchedTraceBundle = structuredClone(human.bundle!);
    mismatchedTraceBundle.trace.traces[0].actorId = "forged_actor";
    const startEvent = mismatchedTraceBundle.trace.traces[0].events[0];
    startEvent.data.actorId = "forged_actor";
    let mismatchedTraceRejected = false;
    try {
      restoreRuntimeRecoveryBundle(mismatchedTraceBundle);
    } catch {
      mismatchedTraceRejected = true;
    }
    const rejectedBundlePreservedState =
      baselineMemory === (() => {
        const current = memoryService.dumpSnapshot();
        return JSON.stringify({
          memories: current.memories,
          candidates: current.candidates,
          lastWriteSummary: current.lastWriteSummary,
        });
      })() &&
      baselineTrace === JSON.stringify(traceLogger.getAllTraces()) &&
      actorRuntime.dumpPendingRun(mismatchedTraceBundle.actorRunId) === null;
    const originalRestorePendingRun = actorRuntime.restorePendingRun;
    let commitFailureRolledBack = false;
    actorRuntime.restorePendingRun = () => {
      throw new Error("injected restore failure");
    };
    try {
      restoreRuntimeRecoveryBundle(structuredClone(human.bundle!));
    } catch {
      const currentMemory = memoryService.dumpSnapshot();
      commitFailureRolledBack =
        baselineMemory === JSON.stringify({
          memories: currentMemory.memories,
          candidates: currentMemory.candidates,
          lastWriteSummary: currentMemory.lastWriteSummary,
        }) &&
        baselineTrace === JSON.stringify(traceLogger.getAllTraces()) &&
        actorRuntime.dumpPendingRun(human.bundle!.actorRunId) === null;
    } finally {
      actorRuntime.restorePendingRun = originalRestorePendingRun;
    }
    const betaPreservedAfterFailure =
      memoryService.dumpOrganizationSnapshot("org_beta_preserved").memories.length > 0 &&
      traceLogger.getTrace(`beta_${toolApproval.waiting.actorRunId}`)?.status ===
        "waiting_human_input";
    let duplicateStoreBundlesRejected = false;
    try {
      assertRuntimeRecoveryStoreSnapshot({
        schemaVersion: RUNTIME_RECOVERY_STORE_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        bundles: [structuredClone(human.bundle!), structuredClone(human.bundle!)],
      });
    } catch {
      duplicateStoreBundlesRejected = true;
    }
    await Promise.all([
      store.save(structuredClone(human.bundle!)),
      store.save(structuredClone(skillApproval.bundle!)),
    ]);
    const concurrentStoreSavesPreservedBoth = (await store.list()).length === 2;
    await store.clear();
    const checks: CheckResult[] = [
      {
        label: "human_input run 进入 waiting_human_input",
        pass: human.waiting.status === "waiting_human_input" && Boolean(human.waiting.pendingHumanInput),
        detail: "status=" + human.waiting.status,
      },
      ...bundleChecks(human, "human_input"),
      {
        label: "Skill wait_approval run 进入 waiting_approval + skill_step",
        pass: skillApproval.waiting.status === "waiting_approval" && skillApproval.waiting.pendingApproval?.approvalKind === "skill_step",
        detail: JSON.stringify(skillApproval.waiting.pendingApproval ?? null),
      },
      ...bundleChecks(skillApproval, "skill_approval"),
      {
        label: "ToolCall approval run 进入 waiting_approval + tool_call",
        pass: toolApproval.waiting.status === "waiting_approval" && toolApproval.waiting.pendingApproval?.approvalKind === "tool_call",
        detail: JSON.stringify(toolApproval.waiting.pendingApproval ?? null),
      },
      ...bundleChecks(toolApproval, "tool_approval"),
      {
        label: "ToolCall bundle 包含 pendingToolApproval / pendingToolCall",
        pass: Boolean(toolApproval.bundle?.pendingRun.pendingToolApproval?.pendingExec.pendingToolCall.toolName),
        detail: JSON.stringify(toolApproval.bundle?.pendingRun.pendingToolApproval?.pendingExec.pendingToolCall ?? null),
      },
      {
        label: "ToolCall restore 后真正执行 pending tool 并写入 result",
        pass: Boolean((toolApproval.completed.result ?? {}).create_ticket_result) && Number((toolApproval.completed.result ?? {}).observations_count ?? 0) > 0,
        detail: JSON.stringify(toolApproval.completed.result ?? null),
      },
      {
        label: "completed run createRuntimeRecoveryBundle 返回 null",
        pass: completedBundle === null,
        detail: "completedBundle=" + String(completedBundle),
      },
      {
        label: "RecoveryBundle 拒绝与 pending identity 不匹配的 Trace",
        pass: mismatchedTraceRejected,
        detail: String(mismatchedTraceRejected),
      },
      {
        label: "RecoveryBundle preflight 失败不修改 Memory / Trace / Run",
        pass: rejectedBundlePreservedState,
        detail: String(rejectedBundlePreservedState),
      },
      {
        label: "RecoveryBundle commit 失败回滚 Memory / Trace / Run",
        pass: commitFailureRolledBack,
        detail: String(commitFailureRolledBack),
      },
      {
        label: "RecoveryBundle commit 失败仍保留 beta organization",
        pass: betaPreservedAfterFailure,
        detail: String(betaPreservedAfterFailure),
      },
      {
        label: "RuntimeRecoveryStore 拒绝重复 actorRunId",
        pass: duplicateStoreBundlesRejected,
        detail: String(duplicateStoreBundlesRejected),
      },
      {
        label: "RuntimeRecoveryStore 同实例并发 save 保留两个 bundle",
        pass: concurrentStoreSavesPreservedBoth,
        detail: String(concurrentStoreSavesPreservedBoth),
      },
    ];

    console.log("=".repeat(60));
    console.log(`  ✅ Runtime Recovery Bundle 验收检查 (${checks.length} 条)`);
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
      ? "  🎉 Runtime Recovery Bundle 验证通过！"
      : "  ❌ 部分验收标准未通过");
    console.log("-".repeat(60));

    if (passCount !== checks.length) process.exit(1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Runtime Recovery Bundle Demo 执行失败:", error);
  process.exit(1);
});
