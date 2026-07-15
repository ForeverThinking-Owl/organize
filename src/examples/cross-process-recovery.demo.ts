// ============================================================================
// cross-process-recovery.demo.ts — v0.4.4
// 验证 RuntimeRecoveryBundle 可以跨 process-like 边界 save / load / restore / continue
// 覆盖 human_input、Skill approval、ToolCall approval、external_event
// ============================================================================

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { actorRuntime } from "../runtime/actor-runtime";
import { toolGateway } from "../tools/tool-gateway";
import {
  queryOrderInfoTool, QueryOrderInfoExecutor,
  queryTicketHistoryTool, QueryTicketHistoryExecutor,
  createTicketTool, CreateTicketExecutor,
} from "../tools/mock-tools";
import { traceLogger } from "../trace/trace-logger";
import { memoryService } from "../memory/memory-service";
import { approvalGate } from "../approvals/approval-gate";
import { JsonRuntimeRecoveryStore } from "../runtime/json-runtime-recovery-store";
import {
  createRuntimeRecoveryBundle,
  restoreRuntimeRecoveryBundle,
  type RuntimeRecoveryBundle,
} from "../runtime/runtime-recovery-bundle";
import type { TraceEvent } from "../core/types/trace";

const SUMMARY_PREFIX = "__CROSS_PROCESS_RECOVERY_SUMMARY__";
const KINDS = ["human_input", "skill_approval", "tool_approval", "external_event"] as const;
type RecoveryKind = typeof KINDS[number];
type Phase = "save" | "restore";

const BASE_ACTOR_CONFIG = {
  actor_id: "customer_service_actor", organization_id: "org_001",
  unit_id: "unit_customer_service", name: "客服 Actor",
  type: "ai" as const, role: "customer_service",
  responsibility: "接收客户问题、跨进程恢复后继续执行、生成后续处理建议",
  autonomy_level: "L2_read_and_draft",
  memory: [
    "涉及退款时，不要承诺退款完成，只能说提交退款申请或等待财务确认。",
    "外部支付确认事件到达后，才能继续处理支付相关回复。",
  ],
  permissions: {
    allowed_tools: ["query_order_info", "query_ticket_history", "create_ticket"],
    denied_tools: ["create_refund_request", "approve_refund"],
    allowed_skills: ["cross_process_human", "cross_process_skill_approval", "cross_process_tool_approval", "cross_process_external_event"],
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
  skill_id: "cross_process_human", name: "Cross Process Human Input",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "ask_human", type: "human_input",
      prompt: "请人工补充是否允许继续。", output_key: "human_confirmation" },
    { step_key: "return", type: "return",
      output_mapping: { summary: "human cross-process restored", human_confirmation: "{{outputs.human_confirmation}}" } },
  ],
};

const SKILL_APPROVAL_SKILL = {
  skill_id: "cross_process_skill_approval", name: "Cross Process Skill Approval",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "manual_approval", type: "wait_approval",
      reason: "请人工审批是否允许继续。", output_key: "approval_result" },
    { step_key: "return", type: "return",
      output_mapping: {
        summary: "skill approval cross-process restored",
        approval_decision: "{{outputs.approval_result.decision}}",
        approval_comment: "{{outputs.approval_result.comment}}",
      } },
  ],
};

const TOOL_APPROVAL_SKILL = {
  skill_id: "cross_process_tool_approval", name: "Cross Process Tool Approval",
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

const EXTERNAL_EVENT_SKILL = {
  skill_id: "cross_process_external_event", name: "Cross Process External Event",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "wait_payment", type: "wait_external_event",
      event_name: "payment.confirmed",
      correlation_key: "{{outputs.order_info.orderId}}",
      reason: "等待支付系统确认订单支付完成。",
      output_key: "payment_event" },
    { step_key: "return", type: "return",
      output_mapping: {
        summary: "external event cross-process restored",
        event_status: "{{outputs.payment_event.payload.status}}",
        payment_id: "{{outputs.payment_event.payload.payment_id}}",
      } },
  ],
};

interface SaveSummary {
  phase: "save";
  kind: RecoveryKind;
  actorRunId: string;
  status: string;
  pendingKind: string | null;
  bundleSaved: boolean;
  hasPendingRun: boolean;
  hasTrace: boolean;
  hasMemory: boolean;
  traceEventCount: number;
  memoryCount: number;
  hasPendingToolCall: boolean;
  hasPendingExternalEvent: boolean;
}

interface RestoreSummary {
  phase: "restore";
  kind: RecoveryKind;
  actorRunId: string;
  completed: boolean;
  status: string;
  hasResumed: boolean;
  hasCompletedEnd: boolean;
  traceEventCountAfterRestore: number;
  memoryCountAfterRestore: number;
  resultKeys: string[];
  approvalDecision?: string;
  eventStatus?: string;
  hasCreateTicketResult: boolean;
  observationsCount: number;
}

interface CheckResult { label: string; pass: boolean; detail: string; }

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function isRecoveryKind(value: string | undefined): value is RecoveryKind {
  return KINDS.includes(value as RecoveryKind);
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

function traceEvents(actorRunId: string): TraceEvent[] {
  return traceLogger.getTrace(actorRunId)?.events ?? [];
}

function hasTraceEvent(actorRunId: string, eventType: string): boolean {
  return traceEvents(actorRunId).some((event) => event.eventType === eventType);
}

function hasCompletedEnd(actorRunId: string): boolean {
  return traceEvents(actorRunId).some((event) =>
    event.eventType === "actor_run_end" && event.data.status === "completed"
  );
}

function skillForKind(kind: RecoveryKind): typeof HUMAN_INPUT_SKILL | typeof SKILL_APPROVAL_SKILL | typeof TOOL_APPROVAL_SKILL | typeof EXTERNAL_EVENT_SKILL {
  switch (kind) {
    case "human_input": return HUMAN_INPUT_SKILL;
    case "skill_approval": return SKILL_APPROVAL_SKILL;
    case "tool_approval": return TOOL_APPROVAL_SKILL;
    case "external_event": return EXTERNAL_EVENT_SKILL;
  }
}

function inputTextForKind(kind: RecoveryKind): string {
  switch (kind) {
    case "human_input": return "客户需要人工补充意见。";
    case "skill_approval": return "客户需要人工审批。";
    case "tool_approval": return "客户说扫码枪连不上系统，还要求退款。";
    case "external_event": return "客户支付后等待支付系统确认。";
  }
}

function runArgs(kind: RecoveryKind) {
  return {
    actorConfig: BASE_ACTOR_CONFIG,
    skillConfig: skillForKind(kind),
    input: { text: inputTextForKind(kind) },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  };
}

function emitSummary(summary: SaveSummary | RestoreSummary): void {
  console.log(SUMMARY_PREFIX + JSON.stringify(summary));
}

async function runSavePhase(kind: RecoveryKind, storePath: string): Promise<void> {
  resetRuntime();
  const output = await actorRuntime.run(runArgs(kind));
  const bundle = createRuntimeRecoveryBundle(output.actorRunId);
  if (!bundle) throw new Error("Expected RuntimeRecoveryBundle for suspended run " + output.actorRunId);

  const store = new JsonRuntimeRecoveryStore(storePath);
  await store.save(bundle);

  emitSummary({
    phase: "save",
    kind,
    actorRunId: output.actorRunId,
    status: output.status,
    pendingKind: bundle.pendingKind,
    bundleSaved: Boolean(await store.load(output.actorRunId)),
    hasPendingRun: Boolean(bundle.pendingRun),
    hasTrace: bundle.trace.traces.length === 1,
    hasMemory: bundle.memory.schemaVersion === "memory.snapshot.v1",
    traceEventCount: bundle.trace.traces[0]?.events.length ?? 0,
    memoryCount: bundle.memory.memories.length,
    hasPendingToolCall: Boolean(bundle.pendingRun.pendingToolApproval?.pendingExec.pendingToolCall.toolName),
    hasPendingExternalEvent: Boolean(bundle.pendingRun.pendingExternalEvent?.externalEventRequestId),
  });
}

function continuePayloadForBundle(bundle: RuntimeRecoveryBundle) {
  switch (bundle.pendingKind) {
    case "human_input": {
      const pending = bundle.pendingRun.pendingHumanInput;
      if (!pending) throw new Error("Bundle missing pendingHumanInput");
      return {
        type: "human_input_response" as const,
        response: {
          humanInputRequestId: pending.humanInputRequestId,
          value: "跨进程恢复后允许继续。",
          respondedBy: "restore_process_operator",
          respondedAt: new Date().toISOString(),
        },
      };
    }
    case "skill_approval": {
      const pending = bundle.pendingRun.pendingSkillApproval;
      if (!pending) throw new Error("Bundle missing pendingSkillApproval");
      return {
        type: "approval_decision" as const,
        decision: {
          approvalRequestId: pending.approvalRequestId,
          decision: "approve_with_comment" as const,
          comment: "跨进程恢复后允许继续。",
          decidedBy: "restore_process_approver",
          decidedAt: new Date().toISOString(),
        },
      };
    }
    case "tool_approval": {
      const pending = bundle.pendingRun.pendingToolApproval;
      if (!pending) throw new Error("Bundle missing pendingToolApproval");
      return {
        type: "approval_decision" as const,
        decision: {
          approvalRequestId: pending.approvalRequest.approvalRequestId,
          decision: "approve" as const,
          comment: "跨进程恢复后允许执行 pending ToolCall。",
          decidedBy: "restore_process_approver",
          decidedAt: new Date().toISOString(),
        },
      };
    }
    case "external_event": {
      const pending = bundle.pendingRun.pendingExternalEvent;
      if (!pending) throw new Error("Bundle missing pendingExternalEvent");
      return {
        type: "external_event_received" as const,
        event: {
          externalEventRequestId: pending.externalEventRequestId,
          eventName: pending.eventName,
          correlationKey: pending.correlationKey,
          payload: {
            payment_id: "PAY_10086",
            status: "confirmed",
          },
          receivedBy: "restore_process_webhook",
          receivedAt: new Date().toISOString(),
        },
      };
    }
  }
}

async function runRestorePhase(kind: RecoveryKind, storePath: string, actorRunId: string): Promise<void> {
  resetRuntime();
  const store = new JsonRuntimeRecoveryStore(storePath);
  const bundle = await store.load(actorRunId);
  if (!bundle) throw new Error("RuntimeRecoveryBundle not found for " + actorRunId);

  restoreRuntimeRecoveryBundle(bundle);
  const traceEventCountAfterRestore = traceEvents(actorRunId).length;
  const memoryCountAfterRestore = memoryService.getStats().memoryCount;

  const output = await actorRuntime.continue(actorRunId, continuePayloadForBundle(bundle));
  const result = output.result ?? {};

  emitSummary({
    phase: "restore",
    kind,
    actorRunId,
    completed: output.status === "completed",
    status: output.status,
    hasResumed: hasTraceEvent(actorRunId, "actor_run_resumed"),
    hasCompletedEnd: hasCompletedEnd(actorRunId),
    traceEventCountAfterRestore,
    memoryCountAfterRestore,
    resultKeys: Object.keys(result),
    approvalDecision: typeof result.approval_decision === "string" ? result.approval_decision : undefined,
    eventStatus: typeof result.event_status === "string" ? result.event_status : undefined,
    hasCreateTicketResult: Boolean(result.create_ticket_result),
    observationsCount: typeof result.observations_count === "number" ? result.observations_count : 0,
  });
}

function runChildProcess(args: string[]): SaveSummary | RestoreSummary {
  const entryPath = process.argv[1];
  if (!entryPath) throw new Error("Expected demo entry path");
  const scriptPath = resolve(entryPath);
  const childArgs = scriptPath.endsWith(".ts")
    ? ["--import", "tsx", scriptPath, ...args]
    : [scriptPath, ...args];
  const result = spawnSync(process.execPath, childArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });

  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const summaryLine = stdout.split(/\r?\n/).find((line) => line.startsWith(SUMMARY_PREFIX));

  if (result.status !== 0 || !summaryLine) {
    console.error(stdout);
    console.error(stderr);
    throw new Error("Child process failed: " + args.join(" "));
  }

  return JSON.parse(summaryLine.slice(SUMMARY_PREFIX.length)) as SaveSummary | RestoreSummary;
}

async function runParent(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.4.4 — Cross-process Recovery Demo");
  console.log("=".repeat(60));
  console.log();

  const tempDir = await mkdtemp(join(tmpdir(), "organize-cross-process-recovery-"));

  try {
    const saves = new Map<RecoveryKind, SaveSummary>();
    const restores = new Map<RecoveryKind, RestoreSummary>();

    for (const kind of KINDS) {
      const storePath = join(tempDir, `${kind}.json`);
      console.log(`💾 save process: ${kind}`);
      const save = runChildProcess(["--phase", "save", "--kind", kind, "--store", storePath]) as SaveSummary;
      saves.set(kind, save);
      console.log("  actorRunId=" + save.actorRunId + ", status=" + save.status + ", pendingKind=" + save.pendingKind);

      console.log(`🔁 restore process: ${kind}`);
      const restore = runChildProcess(["--phase", "restore", "--kind", kind, "--store", storePath, "--actorRunId", save.actorRunId]) as RestoreSummary;
      restores.set(kind, restore);
      console.log("  completed=" + restore.completed + ", status=" + restore.status + ", resultKeys=" + restore.resultKeys.join(","));
      console.log();
    }

    const humanSave = saves.get("human_input")!;
    const humanRestore = restores.get("human_input")!;
    const skillSave = saves.get("skill_approval")!;
    const skillRestore = restores.get("skill_approval")!;
    const toolSave = saves.get("tool_approval")!;
    const toolRestore = restores.get("tool_approval")!;
    const externalSave = saves.get("external_event")!;
    const externalRestore = restores.get("external_event")!;

    const checks: CheckResult[] = [
      { label: "human_input save phase 输出 waiting_human_input", pass: humanSave.status === "waiting_human_input", detail: JSON.stringify(humanSave) },
      { label: "human_input bundle pendingKind=human_input", pass: humanSave.pendingKind === "human_input", detail: "pendingKind=" + String(humanSave.pendingKind) },
      { label: "human_input bundle 包含 pendingRun / trace / memory", pass: humanSave.hasPendingRun && humanSave.hasTrace && humanSave.hasMemory, detail: `pending=${humanSave.hasPendingRun}, trace=${humanSave.hasTrace}, memory=${humanSave.hasMemory}` },
      { label: "skill_approval save phase 输出 waiting_approval", pass: skillSave.status === "waiting_approval", detail: JSON.stringify(skillSave) },
      { label: "skill_approval bundle pendingKind=skill_approval", pass: skillSave.pendingKind === "skill_approval", detail: "pendingKind=" + String(skillSave.pendingKind) },
      { label: "skill_approval bundle 包含 pendingRun / trace / memory", pass: skillSave.hasPendingRun && skillSave.hasTrace && skillSave.hasMemory, detail: `pending=${skillSave.hasPendingRun}, trace=${skillSave.hasTrace}, memory=${skillSave.hasMemory}` },
      { label: "tool_approval save phase 输出 waiting_approval", pass: toolSave.status === "waiting_approval", detail: JSON.stringify(toolSave) },
      { label: "tool_approval bundle pendingKind=tool_approval", pass: toolSave.pendingKind === "tool_approval", detail: "pendingKind=" + String(toolSave.pendingKind) },
      { label: "tool_approval bundle 包含 pendingToolCall", pass: toolSave.hasPendingToolCall, detail: "hasPendingToolCall=" + String(toolSave.hasPendingToolCall) },
      { label: "external_event save phase 输出 waiting_external_event", pass: externalSave.status === "waiting_external_event", detail: JSON.stringify(externalSave) },
      { label: "external_event bundle pendingKind=external_event", pass: externalSave.pendingKind === "external_event", detail: "pendingKind=" + String(externalSave.pendingKind) },
      { label: "external_event bundle 包含 pendingExternalEvent", pass: externalSave.hasPendingExternalEvent, detail: "hasPendingExternalEvent=" + String(externalSave.hasPendingExternalEvent) },
      { label: "human_input restore phase completed", pass: humanRestore.completed && humanRestore.status === "completed", detail: JSON.stringify(humanRestore) },
      { label: "human_input restore Trace 包含 actor_run_resumed", pass: humanRestore.hasResumed, detail: "hasResumed=" + String(humanRestore.hasResumed) },
      { label: "human_input restore Trace 包含 completed actor_run_end", pass: humanRestore.hasCompletedEnd, detail: "hasCompletedEnd=" + String(humanRestore.hasCompletedEnd) },
      { label: "skill_approval restore phase completed", pass: skillRestore.completed && skillRestore.status === "completed", detail: JSON.stringify(skillRestore) },
      { label: "skill_approval approval decision 出现在 result", pass: skillRestore.approvalDecision === "approve_with_comment", detail: "approvalDecision=" + String(skillRestore.approvalDecision) },
      { label: "skill_approval restore Trace completed", pass: skillRestore.hasCompletedEnd, detail: "hasCompletedEnd=" + String(skillRestore.hasCompletedEnd) },
      { label: "tool_approval restore phase completed", pass: toolRestore.completed && toolRestore.status === "completed", detail: JSON.stringify(toolRestore) },
      { label: "tool_approval pending ToolCall 被真实执行", pass: toolRestore.hasCreateTicketResult && toolRestore.observationsCount > 0, detail: `hasCreateTicketResult=${toolRestore.hasCreateTicketResult}, observations=${toolRestore.observationsCount}` },
      { label: "tool_approval Trace completed 且 memory stats 非空", pass: toolRestore.hasCompletedEnd && toolRestore.memoryCountAfterRestore > 0, detail: `hasCompletedEnd=${toolRestore.hasCompletedEnd}, memoryCount=${toolRestore.memoryCountAfterRestore}` },
      { label: "external_event restore phase completed", pass: externalRestore.completed && externalRestore.status === "completed", detail: JSON.stringify(externalRestore) },
      { label: "external_event payload 出现在 result", pass: externalRestore.eventStatus === "confirmed", detail: "eventStatus=" + String(externalRestore.eventStatus) },
      { label: "external_event Trace completed 且 memory stats 非空", pass: externalRestore.hasCompletedEnd && externalRestore.memoryCountAfterRestore > 0, detail: `hasCompletedEnd=${externalRestore.hasCompletedEnd}, memoryCount=${externalRestore.memoryCountAfterRestore}` },
    ];

    console.log("=".repeat(60));
    console.log("  ✅ Cross-process Recovery 验收检查 (24 条)");
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
    console.log(passCount === checks.length ? "  🎉 Cross-process Recovery 验证通过！" : "  ❌ 部分验收标准未通过");
    console.log("-".repeat(60));

    if (passCount !== checks.length) process.exit(1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const phase = parseArg("--phase") as Phase | undefined;
  if (!phase) {
    await runParent();
    return;
  }

  const kindArg = parseArg("--kind");
  const storePath = parseArg("--store");
  if (!isRecoveryKind(kindArg)) throw new Error("Invalid --kind: " + String(kindArg));
  if (!storePath) throw new Error("Missing --store");

  if (phase === "save") {
    await runSavePhase(kindArg, storePath);
    return;
  }

  if (phase === "restore") {
    const actorRunId = parseArg("--actorRunId");
    if (!actorRunId) throw new Error("Missing --actorRunId");
    await runRestorePhase(kindArg, storePath, actorRunId);
    return;
  }

  throw new Error("Invalid --phase: " + String(phase));
}

main().catch((error) => {
  console.error("Cross-process Recovery Demo 执行失败:", error);
  process.exit(1);
});
