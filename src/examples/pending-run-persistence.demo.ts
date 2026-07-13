// ============================================================================
// pending-run-persistence.demo.ts — v0.4.1
// 验证 suspended run 可 dump / save / clear / load / restore / continue
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
  assertPendingRunSnapshot,
  assertPendingRunStoreSnapshot,
  JsonPendingRunStore,
} from "../runtime/json-pending-run-store";
import { loadPendingRunSnapshot, savePendingRunSnapshot, deletePendingRunSnapshot } from "../runtime/pending-run-persistence";
import {
  PENDING_RUN_STORE_SCHEMA_VERSION,
  type PendingRunSnapshot,
} from "../runtime/pending-run-snapshot";
import type { TraceEvent } from "../core/types/trace";

const BASE_ACTOR_CONFIG = {
  actor_id: "customer_service_actor", organization_id: "org_001",
  unit_id: "unit_customer_service", name: "客服 Actor",
  type: "ai" as const, role: "customer_service",
  responsibility: "接收客户问题、查询上下文、处理 pending run 持久化恢复、生成后续处理建议",
  autonomy_level: "L2_read_and_draft",
  memory: [
    "涉及退款时，不要承诺退款完成，只能说提交退款申请或等待财务确认。",
    "设备连接问题通常需要技术排查。",
  ],
  permissions: {
    allowed_tools: ["query_order_info", "query_ticket_history", "create_ticket"],
    denied_tools: ["create_refund_request", "approve_refund"],
    allowed_skills: ["pending_human", "pending_skill_approval", "pending_tool_approval"],
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
  skill_id: "pending_human", name: "Pending Human Input Persistence",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "ask_human", type: "human_input",
      prompt: "请人工补充是否允许继续。", output_key: "human_confirmation" },
    { step_key: "return", type: "return",
      output_mapping: { summary: "human restored", human_confirmation: "{{outputs.human_confirmation}}" } },
  ],
};

const SKILL_APPROVAL_SKILL = {
  skill_id: "pending_skill_approval", name: "Pending Skill Approval Persistence",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "manual_approval", type: "wait_approval",
      reason: "请人工审批是否允许继续。", output_key: "approval_result" },
    { step_key: "return", type: "return",
      output_mapping: {
        summary: "skill approval restored",
        approval_decision: "{{outputs.approval_result.decision}}",
        approval_comment: "{{outputs.approval_result.comment}}",
      } },
  ],
};

const TOOL_APPROVAL_SKILL = {
  skill_id: "pending_tool_approval", name: "Pending Tool Approval Persistence",
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
  snapshot: PendingRunSnapshot | null;
  loaded: PendingRunSnapshot | null;
  completed: ActorRunOutput;
  listCountAfterSave: number;
  listCountAfterDelete: number;
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

function traceEvents(output: ActorRunOutput): TraceEvent[] {
  return traceLogger.getTrace(output.actorRunId)?.events ?? [];
}

function hasEvent(output: ActorRunOutput, eventType: string): boolean {
  return traceEvents(output).some((event) => event.eventType === eventType);
}

function hasCompletedEnd(output: ActorRunOutput): boolean {
  return traceEvents(output).some((event) => event.eventType === "actor_run_end" && event.data.status === "completed");
}

function runArgs(skillConfig: typeof HUMAN_INPUT_SKILL | typeof SKILL_APPROVAL_SKILL | typeof TOOL_APPROVAL_SKILL, text: string) {
  return {
    actorConfig: BASE_ACTOR_CONFIG,
    skillConfig,
    input: { text },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  };
}

async function persistClearRestore(store: JsonPendingRunStore, waiting: ActorRunOutput): Promise<{ snapshot: PendingRunSnapshot | null; loaded: PendingRunSnapshot | null; listCountAfterSave: number; listCountAfterDelete: number }> {
  const snapshot = actorRuntime.dumpPendingRun(waiting.actorRunId);
  if (!snapshot) return { snapshot, loaded: null, listCountAfterSave: 0, listCountAfterDelete: 0 };

  await savePendingRunSnapshot(store, snapshot);
  const listCountAfterSave = (await store.list()).length;

  actorRuntime.clearRun(waiting.actorRunId);
  const loaded = await loadPendingRunSnapshot(store, waiting.actorRunId);
  if (loaded) actorRuntime.restorePendingRun(loaded);

  await deletePendingRunSnapshot(store, waiting.actorRunId);
  const listCountAfterDelete = (await store.list()).length;
  return { snapshot, loaded, listCountAfterSave, listCountAfterDelete };
}

function traceSummary(completed: ActorRunOutput): { hasResumed: boolean; hasCompletedEnd: boolean } {
  return {
    hasResumed: hasEvent(completed, "actor_run_resumed"),
    hasCompletedEnd: hasCompletedEnd(completed),
  };
}

function snapshotValidationRejects(snapshot: PendingRunSnapshot): boolean {
  try {
    assertPendingRunSnapshot(snapshot);
    return false;
  } catch {
    return true;
  }
}

async function runHumanInputScenario(store: JsonPendingRunStore): Promise<ScenarioResult> {
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

async function runSkillApprovalScenario(store: JsonPendingRunStore): Promise<ScenarioResult> {
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

async function runToolApprovalScenario(store: JsonPendingRunStore): Promise<ScenarioResult> {
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

function scenarioChecks(result: ScenarioResult, expectedKind: "human_input" | "skill_approval" | "tool_approval"): CheckResult[] {
  return [
    {
      label: `${result.label}: dumpPendingRun 得到 ${expectedKind}`,
      pass: result.snapshot?.pendingKind === expectedKind,
      detail: JSON.stringify({ pendingKind: result.snapshot?.pendingKind, status: result.snapshot?.status }),
    },
    {
      label: `${result.label}: PendingRunStore save/list/load/delete 正常`,
      pass:
        result.listCountAfterSave === 1 &&
        result.loaded?.actorRunId === result.waiting.actorRunId &&
        result.listCountAfterDelete === 0,
      detail: `saveCount=${result.listCountAfterSave}, loaded=${String(result.loaded?.actorRunId)}, deleteCount=${result.listCountAfterDelete}`,
    },
    {
      label: `${result.label}: restore 后 continue completed`,
      pass: result.completed.status === "completed",
      detail: "status=" + result.completed.status,
    },
    {
      label: `${result.label}: Trace 记录 resumed + completed end`,
      pass: result.hasResumed && result.hasCompletedEnd,
      detail: `hasResumed=${result.hasResumed}, hasCompletedEnd=${result.hasCompletedEnd}`,
    },
  ];
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.4.1 — Pending Run Persistence Demo");
  console.log("=".repeat(60));
  console.log();

  const tempDir = await mkdtemp(join(tmpdir(), "organize-pending-runs-"));
  const store = new JsonPendingRunStore(join(tempDir, "pending-runs.json"));

  try {
    console.log("🙋 场景 A：human_input pending run persistence");
    const human = await runHumanInputScenario(store);
    console.log("  WaitingStatus: " + human.waiting.status);
    console.log("  SnapshotKind: " + String(human.snapshot?.pendingKind));
    console.log("  CompletedStatus: " + human.completed.status);
    console.log();

    console.log("✅ 场景 B：Skill wait_approval pending run persistence");
    const skillApproval = await runSkillApprovalScenario(store);
    console.log("  WaitingStatus: " + skillApproval.waiting.status);
    console.log("  SnapshotKind: " + String(skillApproval.snapshot?.pendingKind));
    console.log("  CompletedStatus: " + skillApproval.completed.status);
    console.log();

    console.log("🛠️ 场景 C：ToolCall approval pending run persistence");
    const toolApproval = await runToolApprovalScenario(store);
    console.log("  WaitingStatus: " + toolApproval.waiting.status);
    console.log("  SnapshotKind: " + String(toolApproval.snapshot?.pendingKind));
    console.log("  CompletedStatus: " + toolApproval.completed.status);
    console.log();

    const completedDump = actorRuntime.dumpPendingRun(toolApproval.completed.actorRunId);
    const corruptedForRuntime = structuredClone(human.snapshot!);
    corruptedForRuntime.state.skillId = "forged_skill";
    let directRestoreRejected = false;
    try {
      actorRuntime.restorePendingRun(corruptedForRuntime);
    } catch {
      directRestoreRejected = actorRuntime.dumpPendingRun(corruptedForRuntime.actorRunId) === null;
    } finally {
      actorRuntime.clearRun(corruptedForRuntime.actorRunId);
    }

    const corruptedForStore = structuredClone(human.snapshot!);
    corruptedForStore.state.status = "waiting_approval";
    let storeSaveRejected = false;
    try {
      await store.save(corruptedForStore);
    } catch {
      storeSaveRejected = (await store.list()).length === 0;
    }
    const forgedToolArguments = structuredClone(toolApproval.snapshot!);
    const forgedCall = forgedToolArguments.pendingToolApproval!.pendingExec.pendingToolCall;
    forgedCall.arguments.priority = "ordinary";
    forgedToolArguments.pendingToolApproval!.approvalRequest.proposedArguments =
      structuredClone(forgedCall.arguments);
    const forgedToolArgumentsRejected = snapshotValidationRejects(forgedToolArguments);

    const forgedOutputRoute = structuredClone(toolApproval.snapshot!);
    forgedOutputRoute.pendingToolApproval!.pendingExec.decisionOutputKey = "forged_result";
    const forgedOutputRouteRejected = snapshotValidationRejects(forgedOutputRoute);

    const deniedToolContext = structuredClone(toolApproval.snapshot!);
    deniedToolContext.context.permissions.deniedTools.push("create_ticket");
    const deniedToolContextRejected = snapshotValidationRejects(deniedToolContext);

    const forgedRisk = structuredClone(toolApproval.snapshot!);
    forgedRisk.pendingToolApproval!.approvalRequest.riskLevel = "low";
    const forgedRiskRejected = snapshotValidationRejects(forgedRisk);

    const extraContextField = structuredClone(toolApproval.snapshot!);
    (extraContextField.context as unknown as Record<string, unknown>).forged = true;
    const extraContextFieldRejected = snapshotValidationRejects(extraContextField);

    const duplicateAvailableTool = structuredClone(toolApproval.snapshot!);
    duplicateAvailableTool.context.availableTools.push(
      structuredClone(duplicateAvailableTool.context.availableTools[0])
    );
    const duplicateAvailableToolRejected = snapshotValidationRejects(duplicateAvailableTool);
    let duplicateStoreRunsRejected = false;
    try {
      assertPendingRunStoreSnapshot({
        schemaVersion: PENDING_RUN_STORE_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        runs: [structuredClone(human.snapshot!), structuredClone(human.snapshot!)],
      });
    } catch {
      duplicateStoreRunsRejected = true;
    }
    await Promise.all([
      store.save(structuredClone(human.snapshot!)),
      store.save(structuredClone(skillApproval.snapshot!)),
    ]);
    const concurrentStoreSavesPreservedBoth = (await store.list()).length === 2;
    await store.clear();
    const checks: CheckResult[] = [
      {
        label: "human_input run 进入 waiting_human_input",
        pass: human.waiting.status === "waiting_human_input" && Boolean(human.waiting.pendingHumanInput),
        detail: "status=" + human.waiting.status,
      },
      ...scenarioChecks(human, "human_input"),
      {
        label: "Skill wait_approval run 进入 waiting_approval + skill_step",
        pass: skillApproval.waiting.status === "waiting_approval" && skillApproval.waiting.pendingApproval?.approvalKind === "skill_step",
        detail: JSON.stringify(skillApproval.waiting.pendingApproval ?? null),
      },
      ...scenarioChecks(skillApproval, "skill_approval"),
      {
        label: "ToolCall approval run 进入 waiting_approval + tool_call",
        pass: toolApproval.waiting.status === "waiting_approval" && toolApproval.waiting.pendingApproval?.approvalKind === "tool_call",
        detail: JSON.stringify(toolApproval.waiting.pendingApproval ?? null),
      },
      ...scenarioChecks(toolApproval, "tool_approval"),
      {
        label: "ToolCall pending snapshot 包含 pendingToolCall",
        pass: Boolean(toolApproval.snapshot?.pendingToolApproval?.pendingExec.pendingToolCall.toolName),
        detail: JSON.stringify(toolApproval.snapshot?.pendingToolApproval?.pendingExec.pendingToolCall ?? null),
      },
      {
        label: "ToolCall restore 后真正执行 pending tool 并写入 result",
        pass: Boolean((toolApproval.completed.result ?? {}).create_ticket_result) && Number((toolApproval.completed.result ?? {}).observations_count ?? 0) > 0,
        detail: JSON.stringify(toolApproval.completed.result ?? null),
      },
      {
        label: "completed run dumpPendingRun 返回 null",
        pass: completedDump === null,
        detail: "completedDump=" + String(completedDump),
      },
      {
        label: "ActorRuntime direct restore 拒绝不自洽 snapshot",
        pass: directRestoreRejected,
        detail: String(directRestoreRejected),
      },
      {
        label: "PendingRunStore save 拒绝不自洽 snapshot",
        pass: storeSaveRejected,
        detail: String(storeSaveRejected),
      },
      {
        label: "llm_judge Tool approval 拒绝篡改 arguments",
        pass: forgedToolArgumentsRejected,
        detail: String(forgedToolArgumentsRejected),
      },
      {
        label: "llm_judge Tool approval 拒绝篡改 output route",
        pass: forgedOutputRouteRejected,
        detail: String(forgedOutputRouteRejected),
      },
      {
        label: "Tool approval 拒绝 context denied Tool",
        pass: deniedToolContextRejected,
        detail: String(deniedToolContextRejected),
      },
      {
        label: "Tool approval 拒绝伪造 riskLevel",
        pass: forgedRiskRejected,
        detail: String(forgedRiskRejected),
      },
      {
        label: "Pending Context 拒绝额外顶层字段",
        pass: extraContextFieldRejected,
        detail: String(extraContextFieldRejected),
      },
      {
        label: "Pending Context 拒绝重复 available Tool",
        pass: duplicateAvailableToolRejected,
        detail: String(duplicateAvailableToolRejected),
      },
      {
        label: "PendingRunStore 拒绝重复 actorRunId",
        pass: duplicateStoreRunsRejected,
        detail: String(duplicateStoreRunsRejected),
      },
      {
        label: "PendingRunStore 同实例并发 save 保留两个 run",
        pass: concurrentStoreSavesPreservedBoth,
        detail: String(concurrentStoreSavesPreservedBoth),
      },
    ];

    console.log("=".repeat(60));
    console.log(`  ✅ Pending Run Persistence 验收检查 (${checks.length} 条)`);
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
      ? "  🎉 Pending Run Persistence 验证通过！"
      : "  ❌ 部分验收标准未通过");
    console.log("-".repeat(60));

    if (passCount !== checks.length) process.exit(1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Pending Run Persistence Demo 执行失败:", error);
  process.exit(1);
});
