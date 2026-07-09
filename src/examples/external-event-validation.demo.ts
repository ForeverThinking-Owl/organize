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
  validationFailed?: TraceEvent;
  hasResumed: boolean;
  hasReceived: boolean;
  hasCompletedEnd: boolean;
  hasErrorEnd: boolean;
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
  return {
    waiting,
    completed,
    validationFailed: findEvent(completed, "external_event_validation_failed"),
    hasResumed: hasEvent(completed, "actor_run_resumed"),
    hasReceived: hasEvent(completed, "external_event_received"),
    hasCompletedEnd: hasRunEndStatus(completed, "completed"),
    hasErrorEnd: hasRunEndStatus(completed, "error"),
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
  return summarize(waiting, completed);
}

async function runWrongCorrelationScenario(): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runInput());
  const completed = await continueWrongCorrelation(waiting);
  return summarize(waiting, completed);
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
  return summarize(waiting, completed, traceEventCountAfterRestore);
}

function successChecks(scenario: ScenarioResult): CheckResult[] {
  const output = scenario.completed.result ?? {};
  const received = findEvent(scenario.completed, "external_event_received");
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
  return [
    {
      label: `${label}: rejected with error status`,
      pass: scenario.completed.status === "error" && scenario.hasErrorEnd,
      detail: `status=${scenario.completed.status}, hasErrorEnd=${scenario.hasErrorEnd}`,
    },
    {
      label: `${label}: Trace has external_event_validation_failed`,
      pass: Boolean(scenario.validationFailed),
      detail: JSON.stringify(scenario.validationFailed?.data ?? null),
    },
    {
      label: `${label}: validation error mentions ${expectedErrorFragment}`,
      pass: errors.some((error) => error.includes(expectedErrorFragment)),
      detail: JSON.stringify(errors),
    },
    {
      label: `${label}: no actor_run_resumed and no external_event_received`,
      pass: !scenario.hasResumed && !scenario.hasReceived,
      detail: `hasResumed=${scenario.hasResumed}, hasReceived=${scenario.hasReceived}`,
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

  console.log("📦 Case D: recovery bundle restored run still validates");
  const recoveryInvalid = await runRecoveryInvalidScenario();
  console.log("  Status: " + recoveryInvalid.completed.status);
  console.log();

  const checks: CheckResult[] = [
    ...successChecks(valid),
    ...rejectedChecks("invalid payload", invalidPayload, "payload.payment_id expected string"),
    ...rejectedChecks("wrong correlation", wrongCorrelation, "correlationKey mismatch"),
    {
      label: "recovery restored trace before invalid event",
      pass: Number(recoveryInvalid.traceEventCountAfterRestore ?? 0) > 0,
      detail: `traceEventCountAfterRestore=${recoveryInvalid.traceEventCountAfterRestore}`,
    },
    ...rejectedChecks("recovery invalid payload", recoveryInvalid, "payload.payment_id expected string"),
  ];

  console.log("=".repeat(60));
  console.log("  ✅ External Event Validation 验收检查 (18 条)");
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
