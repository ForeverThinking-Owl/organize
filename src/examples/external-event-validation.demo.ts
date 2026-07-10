// ============================================================================
// external-event-validation.demo.ts — v0.4.5
// 验证 external event schema / correlation validation 与恢复后拒绝路径
// ============================================================================

import { actorRuntime, ActorRunOutput } from "../runtime/actor-runtime";
import { toolGateway } from "../tools/tool-gateway";
import { queryOrderInfoTool, QueryOrderInfoExecutor } from "../tools/mock-tools";
import { traceLogger } from "../trace/trace-logger";
import { memoryService } from "../memory/memory-service";
import { approvalGate } from "../approvals/approval-gate";
import { createRuntimeRecoveryBundle, restoreRuntimeRecoveryBundle } from "../runtime/runtime-recovery-bundle";
import type { TraceEvent } from "../core/types/trace";
import { validateExternalEventCorrelation } from "../runtime/external-event-validation";

const ACTOR_CONFIG = {
  actor_id: "customer_service_actor", organization_id: "org_001",
  unit_id: "unit_customer_service", name: "客服 Actor",
  type: "ai" as const, role: "customer_service",
  responsibility: "等待外部支付事件并安全校验事件 payload / correlation",
  autonomy_level: "L2_read_and_draft",
  memory: [
    "外部支付确认事件到达后，才能继续处理支付相关回复。",
    "外部事件 payload 不应完整写入 Trace。",
  ],
  permissions: {
    allowed_tools: ["query_order_info"],
    denied_tools: ["create_refund_request", "approve_refund"],
    allowed_skills: ["external_event_validation"],
  },
  approval_judgment: {
    must_request_approval_when: ["外部正式发送客户回复"],
  },
};

const SKILL_CONFIG = {
  skill_id: "external_event_validation", name: "External Event Validation 语义验证",
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
    { step_key: "return", type: "return",
      output_mapping: {
        summary: "external event validation completed",
        payment_id: "{{outputs.payment_event.payload.payment_id}}",
        status: "{{outputs.payment_event.payload.status}}",
      } },
  ],
};

interface CheckResult { label: string; pass: boolean; detail: string; }
interface ScenarioResult {
  waiting: ActorRunOutput;
  completed: ActorRunOutput;
  events: TraceEvent[];
  validationFailed?: TraceEvent;
  received?: TraceEvent;
  pendingSnapshotKind?: string;
  pendingSnapshotRequestId?: string;
  hasResumed: boolean;
  hasReceived: boolean;
  hasCompletedEnd: boolean;
  hasErrorEnd: boolean;
  hasErrorTrace: boolean;
  traceEventCountAfterRestore?: number;
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

function hasRunEndStatus(output: ActorRunOutput, status: string): boolean {
  return traceEvents(output).some((event) => event.eventType === "actor_run_end" && event.data.status === status);
}

function runInput() {
  return {
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: "客户支付后等待支付系统确认。" },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  };
}

function requestId(waiting: ActorRunOutput): string {
  if (!waiting.pendingExternalEvent) throw new Error("Expected pendingExternalEvent");
  return waiting.pendingExternalEvent.externalEventRequestId;
}

function correlationKey(waiting: ActorRunOutput): string {
  if (!waiting.pendingExternalEvent?.correlationKey) throw new Error("Expected correlationKey");
  return waiting.pendingExternalEvent.correlationKey;
}

function summarize(waiting: ActorRunOutput, completed: ActorRunOutput, traceEventCountAfterRestore?: number): ScenarioResult {
  const events = [...traceEvents(completed)];
  const pendingSnapshot = actorRuntime.dumpPendingRun(completed.actorRunId);

  return {
    waiting,
    completed,
    events,
    validationFailed: events.find((event) => event.eventType === "external_event_validation_failed"),
    received: events.find((event) => event.eventType === "external_event_received"),
    pendingSnapshotKind: pendingSnapshot?.pendingKind,
    pendingSnapshotRequestId: pendingSnapshot?.pendingExternalEvent?.externalEventRequestId,
    hasResumed: events.some((event) => event.eventType === "actor_run_resumed"),
    hasReceived: events.some((event) => event.eventType === "external_event_received"),
    hasCompletedEnd: events.some(
      (event) => event.eventType === "actor_run_end" && event.data.status === "completed"
    ),
    hasErrorEnd: events.some(
      (event) => event.eventType === "actor_run_end" && event.data.status === "error"
    ),
    hasErrorTrace: events.some((event) => event.eventType === "error"),
    traceEventCountAfterRestore,
  };
}

async function continueValid(waiting: ActorRunOutput): Promise<ActorRunOutput> {
  return actorRuntime.continue(waiting.actorRunId, {
    type: "external_event_received",
    event: {
      externalEventRequestId: requestId(waiting),
      eventName: "payment.confirmed",
      correlationKey: correlationKey(waiting),
      payload: { payment_id: "PAY_10086", status: "confirmed" },
      receivedBy: "payment_webhook",
      receivedAt: new Date().toISOString(),
    },
  });
}

async function continueInvalidPayload(waiting: ActorRunOutput): Promise<ActorRunOutput> {
  return actorRuntime.continue(waiting.actorRunId, {
    type: "external_event_received",
    event: {
      externalEventRequestId: requestId(waiting),
      eventName: "payment.confirmed",
      correlationKey: correlationKey(waiting),
      payload: { payment_id: 123 },
      receivedBy: "payment_webhook",
      receivedAt: new Date().toISOString(),
    },
  });
}

async function continueWrongCorrelation(waiting: ActorRunOutput): Promise<ActorRunOutput> {
  return actorRuntime.continue(waiting.actorRunId, {
    type: "external_event_received",
    event: {
      externalEventRequestId: requestId(waiting),
      eventName: "payment.confirmed",
      correlationKey: "ORDER_WRONG",
      payload: { payment_id: "PAY_10086", status: "confirmed" },
      receivedBy: "payment_webhook",
      receivedAt: new Date().toISOString(),
    },
  });
}

async function continueMissingCorrelation(waiting: ActorRunOutput): Promise<ActorRunOutput> {
  return actorRuntime.continue(waiting.actorRunId, {
    type: "external_event_received",
    event: {
      externalEventRequestId: requestId(waiting),
      eventName: "payment.confirmed",
      payload: { payment_id: "PAY_10086", status: "confirmed" },
      receivedBy: "payment_webhook",
      receivedAt: new Date().toISOString(),
    },
  });
}

async function runValidScenario(): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runInput());
  const completed = await continueValid(waiting);
  return summarize(waiting, completed);
}

async function runInvalidPayloadScenario(): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runInput());
  const completed = await continueInvalidPayload(waiting);
  const scenario = summarize(waiting, completed);
  actorRuntime.clearRun(waiting.actorRunId);
  return scenario;
}

async function runWrongCorrelationScenario(): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runInput());
  const completed = await continueWrongCorrelation(waiting);
  const scenario = summarize(waiting, completed);
  actorRuntime.clearRun(waiting.actorRunId);
  return scenario;
}

async function runMissingCorrelationScenario(): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runInput());
  const completed = await continueMissingCorrelation(waiting);
  const scenario = summarize(waiting, completed);
  actorRuntime.clearRun(waiting.actorRunId);
  return scenario;
}

async function runInvalidThenValidScenario(): Promise<{
  waiting: ActorRunOutput;
  rejected: ActorRunOutput;
  completed: ActorRunOutput;
  pendingAfterRejectKind?: string;
  pendingAfterRejectRequestId?: string;
}> {
  resetRuntime();
  const waiting = await actorRuntime.run(runInput());
  const rejected = await continueInvalidPayload(waiting);
  const pendingAfterReject = actorRuntime.dumpPendingRun(waiting.actorRunId);
  const completed = await continueValid(waiting);
  return {
    waiting,
    rejected,
    completed,
    pendingAfterRejectKind: pendingAfterReject?.pendingKind,
    pendingAfterRejectRequestId:
      pendingAfterReject?.pendingExternalEvent?.externalEventRequestId,
  };
}

async function runRecoveryInvalidScenario(): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runInput());
  const bundle = createRuntimeRecoveryBundle(waiting.actorRunId);
  if (!bundle) throw new Error("Expected recovery bundle");

  clearFullRuntime(waiting.actorRunId);
  restoreRuntimeRecoveryBundle(bundle);
  const traceEventCountAfterRestore = traceLogger.getTrace(waiting.actorRunId)?.events.length ?? 0;
  const completed = await continueInvalidPayload(waiting);
  const scenario = summarize(waiting, completed, traceEventCountAfterRestore);
  actorRuntime.clearRun(waiting.actorRunId);
  return scenario;
}

function successChecks(scenario: ScenarioResult): CheckResult[] {
  const output = scenario.completed.result ?? {};
  const received = scenario.received;
  return [
    {
      label: "valid event completed",
      pass: scenario.completed.status === "completed" && scenario.hasResumed && scenario.hasCompletedEnd,
      detail: `status=${scenario.completed.status}, resumed=${scenario.hasResumed}, completedEnd=${scenario.hasCompletedEnd}`,
    },
    {
      label: "valid event output contains payment_id/status",
      pass: output.payment_id === "PAY_10086" && output.status === "confirmed",
      detail: JSON.stringify(output),
    },
    {
      label: "Trace has external_event_received metadata",
      pass: Boolean(received) && received?.data.eventName === "payment.confirmed",
      detail: JSON.stringify(received?.data ?? null),
    },
    {
      label: "Trace does not store full payload",
      pass: received !== undefined && !("payload" in received.data),
      detail: JSON.stringify(received?.data ?? null),
    },
    {
      label: "Trace stores payloadSummary",
      pass: Array.isArray((received?.data.payloadSummary as Record<string, unknown> | undefined)?.payloadKeys),
      detail: JSON.stringify(received?.data.payloadSummary ?? null),
    },
  ];
}

function rejectedChecks(label: string, scenario: ScenarioResult, expectedErrorFragment: string): CheckResult[] {
  const errors = (scenario.validationFailed?.data.validationErrors ?? []) as string[];
  const expectedRequestId = scenario.waiting.pendingExternalEvent?.externalEventRequestId;
  const pendingRequestId = scenario.pendingSnapshotRequestId;

  return [
    {
      label: `${label}: rejected and pending run preserved`,
      pass:
        scenario.completed.status === "waiting_external_event" &&
        scenario.completed.pendingExternalEvent === undefined &&
        scenario.pendingSnapshotKind === "external_event" &&
        pendingRequestId === expectedRequestId,
      detail:
        `status=${scenario.completed.status}, snapshotKind=${scenario.pendingSnapshotKind}, ` +
        `pendingRequestId=${pendingRequestId}, responseEcho=${Boolean(scenario.completed.pendingExternalEvent)}`,
    },
    {
      label: `${label}: validation Trace contains ${expectedErrorFragment}`,
      pass:
        Boolean(scenario.validationFailed) &&
        errors.some((error) => error.includes(expectedErrorFragment)),
      detail: JSON.stringify(scenario.validationFailed?.data ?? null),
    },
    {
      label: `${label}: no actor_run_resumed and no external_event_received`,
      pass: !scenario.hasResumed && !scenario.hasReceived,
      detail: `hasResumed=${scenario.hasResumed}, hasReceived=${scenario.hasReceived}`,
    },
    {
      label: `${label}: no terminal actor_run_end`,
      pass: !scenario.hasCompletedEnd && !scenario.hasErrorEnd && !scenario.hasErrorTrace,
      detail:
        `completedEnd=${scenario.hasCompletedEnd}, errorEnd=${scenario.hasErrorEnd}, ` +
        `errorTrace=${scenario.hasErrorTrace}`,
    },
  ];
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.4.5 — External Event Validation Demo");
  console.log("=".repeat(60));
  console.log();

  console.log("✅ Case A: valid payload + valid correlation");
  const valid = await runValidScenario();
  console.log("  Status: " + valid.completed.status);
  console.log();

  console.log("❌ Case B: invalid payload");
  const invalidPayload = await runInvalidPayloadScenario();
  console.log("  Status: " + invalidPayload.completed.status);
  console.log();

  console.log("❌ Case C: wrong correlationKey");
  const wrongCorrelation = await runWrongCorrelationScenario();
  console.log("  Status: " + wrongCorrelation.completed.status);
  console.log();

  console.log("❌ Case D: missing correlationKey");
  const missingCorrelation = await runMissingCorrelationScenario();
  console.log("  Status: " + missingCorrelation.completed.status);
  console.log();

  console.log("📦 Case E: recovery bundle restored run still validates");
  const recoveryInvalid = await runRecoveryInvalidScenario();
  console.log("  Status: " + recoveryInvalid.completed.status);
  console.log();

  console.log("🔁 Case F: invalid event can be retried with a valid event");
  const retryAfterInvalid = await runInvalidThenValidScenario();
  console.log("  Rejected status: " + retryAfterInvalid.rejected.status);
  console.log("  Final status: " + retryAfterInvalid.completed.status);
  console.log();

  const optionalCorrelation = validateExternalEventCorrelation(
    {
      externalEventRequestId: "optional_correlation_request",
      stepKey: "wait_optional_event",
      eventName: "optional.event",
      outputKey: "optional_event",
    },
    {
      externalEventRequestId: "optional_correlation_request",
      eventName: "optional.event",
      payload: {},
    }
  );

  const checks: CheckResult[] = [
    {
      label: "event without declared correlation remains compatible",
      pass: optionalCorrelation.valid,
      detail: JSON.stringify(optionalCorrelation),
    },
    ...successChecks(valid),
    ...rejectedChecks("invalid payload", invalidPayload, "payload.payment_id expected string"),
    ...rejectedChecks("wrong correlation", wrongCorrelation, "correlationKey mismatch"),
    ...rejectedChecks("missing correlation", missingCorrelation, "correlationKey is required"),
    {
      label: "recovery restored trace before invalid event",
      pass: Number(recoveryInvalid.traceEventCountAfterRestore ?? 0) > 0,
      detail: `traceEventCountAfterRestore=${recoveryInvalid.traceEventCountAfterRestore}`,
    },
    ...rejectedChecks("recovery invalid payload", recoveryInvalid, "payload.payment_id expected string"),
    {
      label: "invalid event leaves retry scenario waiting",
      pass:
        retryAfterInvalid.rejected.status === "waiting_external_event" &&
        retryAfterInvalid.rejected.pendingExternalEvent === undefined &&
        retryAfterInvalid.pendingAfterRejectKind === "external_event" &&
        retryAfterInvalid.pendingAfterRejectRequestId ===
          retryAfterInvalid.waiting.pendingExternalEvent?.externalEventRequestId,
      detail:
        `status=${retryAfterInvalid.rejected.status}, ` +
        `snapshotKind=${retryAfterInvalid.pendingAfterRejectKind}`,
    },
    {
      label: "valid retry completes the same pending run",
      pass:
        retryAfterInvalid.completed.status === "completed" &&
        retryAfterInvalid.completed.result?.payment_id === "PAY_10086",
      detail: JSON.stringify(retryAfterInvalid.completed.result),
    },
  ];

  console.log("=".repeat(60));
  console.log("  ✅ External Event Validation 验收检查 (" + checks.length + " 条)");
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
    ? "  🎉 External Event Validation 验证通过！"
    : "  ❌ 部分验收标准未通过");
  console.log("-".repeat(60));

  if (passCount !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error("External Event Validation Demo 执行失败:", error);
  process.exit(1);
});
