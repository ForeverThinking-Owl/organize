// ============================================================================
// external-event-validation.demo.ts — v0.5.1
// 验证 external event correlation fail-closed、schema 校验与恢复后拒绝路径
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
import type { SkillConfig } from "../core/types/skill";
import type { PendingRunSnapshot } from "../runtime/pending-run-snapshot";

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

interface CorrelationSetupScenario {
  output: ActorRunOutput;
  events: TraceEvent[];
  pendingSnapshot: PendingRunSnapshot | null;
  errorMessage?: string;
}

interface RejectedBundleCorrelationRestoreScenario {
  actorRunId: string;
  errorMessage?: string;
  hasRun: boolean;
  hasPendingRun: boolean;
  hasTrace: boolean;
  memoryUnchanged: boolean;
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

function correlationOnlySkillConfig(correlationKey?: string): SkillConfig {
  const waitStep: Record<string, unknown> = {
    step_key: "wait_payment",
    type: "wait_external_event",
    event_name: "payment.confirmed",
    output_key: "payment_event",
  };
  if (correlationKey !== undefined) waitStep.correlation_key = correlationKey;

  return {
    skill_id: "external_event_validation",
    name: "External Event Correlation Fail-Closed",
    owner_actor_id: "customer_service_actor",
    steps: [
      waitStep as SkillConfig["steps"][number],
      {
        step_key: "return",
        type: "return",
        output_mapping: { status: "completed" },
      },
    ],
  };
}

async function runCorrelationSetupScenario(
  correlationKey: string | undefined,
  runtimeContext: Record<string, unknown> = {}
): Promise<CorrelationSetupScenario> {
  resetRuntime();
  const output = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: correlationOnlySkillConfig(correlationKey),
    input: { text: "等待 correlation fail-closed 验证事件。" },
    runtimeContext,
  });
  const events = [...traceEvents(output)];
  const pendingSnapshot = actorRuntime.dumpPendingRun(output.actorRunId);
  const errorMessage = events.find((event) => event.eventType === "error")?.data.message;
  if (pendingSnapshot) actorRuntime.clearRun(output.actorRunId);
  return {
    output,
    events,
    pendingSnapshot,
    errorMessage: typeof errorMessage === "string" ? errorMessage : undefined,
  };
}

function correlationSetupFailClosedChecks(
  label: string,
  scenario: CorrelationSetupScenario,
  expectedErrorFragment: string
): CheckResult[] {
  const eventTypes = scenario.events.map((event) => event.eventType);
  return [
    {
      label: `${label}: run fails before waiting`,
      pass:
        scenario.output.status === "error" &&
        scenario.output.pendingExternalEvent === undefined &&
        scenario.pendingSnapshot === null,
      detail:
        `status=${scenario.output.status}, responsePending=${Boolean(scenario.output.pendingExternalEvent)}, ` +
        `snapshotPending=${Boolean(scenario.pendingSnapshot)}`,
    },
    {
      label: `${label}: no request or suspension Trace is written`,
      pass:
        !eventTypes.includes("external_event_requested") &&
        !eventTypes.includes("actor_run_suspended"),
      detail: JSON.stringify(eventTypes),
    },
    {
      label: `${label}: security error explains the rejection`,
      pass: scenario.errorMessage?.includes(expectedErrorFragment) === true,
      detail: scenario.errorMessage ?? "missing error Trace",
    },
  ];
}

function unsafeLegacySnapshot(
  snapshot: PendingRunSnapshot,
  correlationKey: string
): PendingRunSnapshot {
  const unsafe = JSON.parse(JSON.stringify(snapshot)) as PendingRunSnapshot;
  const step = unsafe.skill.steps[unsafe.state.currentStepIndex];
  if (step?.type !== "wait_external_event" || !unsafe.pendingExternalEvent) {
    throw new Error("Expected external-event pending snapshot");
  }
  step.correlationKey = correlationKey;
  unsafe.pendingExternalEvent.correlationKey = correlationKey;
  return unsafe;
}

function unsafeLegacyPartialTemplateSnapshot(
  snapshot: PendingRunSnapshot,
  correlationValue: unknown,
  storedCorrelationKey: string
): PendingRunSnapshot {
  const unsafe = unsafeLegacySnapshot(
    snapshot,
    "tenant/{{context.correlation_id}}"
  );
  unsafe.state.context.correlation_id = correlationValue;
  if (!unsafe.pendingExternalEvent) {
    throw new Error("Expected external-event pending snapshot");
  }
  unsafe.pendingExternalEvent.correlationKey = storedCorrelationKey;
  return unsafe;
}

function rejectedRestoreError(snapshot: PendingRunSnapshot): string | undefined {
  try {
    actorRuntime.restorePendingRun(snapshot);
    actorRuntime.clearRun(snapshot.actorRunId);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function runTamperedBundleCorrelationRestoreScenario(): Promise<RejectedBundleCorrelationRestoreScenario> {
  resetRuntime();
  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: correlationOnlySkillConfig(
      "tenant/{{context.correlation_id}}"
    ),
    input: { text: "等待 RuntimeRecoveryBundle correlation 篡改验证事件。" },
    runtimeContext: { correlation_id: "ORDER_10086" },
  });
  const bundle = createRuntimeRecoveryBundle(waiting.actorRunId);
  if (!bundle) throw new Error("Expected recovery bundle");

  clearFullRuntime(waiting.actorRunId);
  const memoryBefore = memoryService.dumpSnapshot();
  const unsafe = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
  const step = unsafe.pendingRun.skill.steps[unsafe.pendingRun.state.currentStepIndex];
  const pendingExternalEvent = unsafe.pendingRun.pendingExternalEvent;
  if (step?.type !== "wait_external_event" || !pendingExternalEvent) {
    throw new Error("Expected external-event recovery bundle");
  }

  const storedCorrelationKey =
    'tenant/{"tenant":"org_001","order":"ORDER_10086"}';
  const tamperedCorrelation = {
    tenant: "org_001",
    order: "ORDER_10086",
  };
  unsafe.pendingRun.state.context.correlation_id = tamperedCorrelation;
  const embeddedContext = unsafe.pendingRun.state.context.context;
  if (
    embeddedContext !== null &&
    typeof embeddedContext === "object" &&
    !Array.isArray(embeddedContext)
  ) {
    (embeddedContext as Record<string, unknown>).correlation_id =
      tamperedCorrelation;
  }
  pendingExternalEvent.correlationKey = storedCorrelationKey;
  for (const event of unsafe.trace.traces[0]?.events ?? []) {
    if (
      event.eventType === "external_event_requested" ||
      event.eventType === "actor_run_suspended"
    ) {
      event.data.correlationKey = storedCorrelationKey;
    }
  }

  let errorMessage: string | undefined;
  try {
    restoreRuntimeRecoveryBundle(unsafe);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const hasRun = actorRuntime.hasRun(waiting.actorRunId);
  const hasPendingRun = actorRuntime.dumpPendingRun(waiting.actorRunId) !== null;
  const hasTrace = traceLogger.getTrace(waiting.actorRunId) !== undefined;
  const memoryAfter = memoryService.dumpSnapshot();
  const memoryUnchanged = JSON.stringify({
    memories: memoryAfter.memories,
    candidates: memoryAfter.candidates,
    lastWriteSummary: memoryAfter.lastWriteSummary,
  }) === JSON.stringify({
    memories: memoryBefore.memories,
    candidates: memoryBefore.candidates,
    lastWriteSummary: memoryBefore.lastWriteSummary,
  });

  actorRuntime.clearRun(waiting.actorRunId);
  traceLogger.clearRuns([waiting.actorRunId]);
  return {
    actorRunId: waiting.actorRunId,
    errorMessage,
    hasRun,
    hasPendingRun,
    hasTrace,
    memoryUnchanged,
  };
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
  console.log("  ForeverThinking v0.5.1 — External Event Validation Demo");
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

  console.log("🛡️ Case G: unsafe configured correlations fail before waiting");
  const unresolvedCorrelation = await runCorrelationSetupScenario(
    "{{context.missing_correlation}}"
  );
  const partiallyUnresolvedCorrelation = await runCorrelationSetupScenario(
    "ORDER-{{context.missing_correlation}}"
  );
  const emptyCorrelation = await runCorrelationSetupScenario(
    "{{context.correlation_id}}",
    { correlation_id: "" }
  );
  const nullCorrelation = await runCorrelationSetupScenario(
    "{{context.correlation_id}}",
    { correlation_id: null }
  );
  const objectCorrelation = await runCorrelationSetupScenario(
    "{{context.correlation_id}}",
    { correlation_id: { tenant: "org_001", order: "ORDER_10086" } }
  );
  const partialObjectCorrelation = await runCorrelationSetupScenario(
    "tenant/{{context.correlation_id}}",
    { correlation_id: { tenant: "org_001", order: "ORDER_10086" } }
  );
  const partialArrayCorrelation = await runCorrelationSetupScenario(
    "tenant/{{context.correlation_id}}",
    { correlation_id: ["org_001", "ORDER_10086"] }
  );
  const partialEmptyCorrelation = await runCorrelationSetupScenario(
    "tenant/{{context.correlation_id}}",
    { correlation_id: "" }
  );
  const partialWhitespaceCorrelation = await runCorrelationSetupScenario(
    "tenant/{{context.correlation_id}}",
    { correlation_id: "   " }
  );
  const emptyTemplateDelimiters = await runCorrelationSetupScenario("{{}}");
  const literalBypass = await actorRuntime.continue(unresolvedCorrelation.output.actorRunId, {
    type: "external_event_received",
    event: {
      externalEventRequestId: "forged_unresolved_request",
      eventName: "payment.confirmed",
      correlationKey: "{{context.missing_correlation}}",
      payload: { payment_id: "PAY_FORGED", status: "confirmed" },
    },
  });
  const directLiteralBypass = validateExternalEventCorrelation(
    {
      externalEventRequestId: "legacy_unresolved_request",
      stepKey: "wait_payment",
      eventName: "payment.confirmed",
      correlationKey: "{{context.missing_correlation}}",
      outputKey: "payment_event",
    },
    {
      externalEventRequestId: "legacy_unresolved_request",
      eventName: "payment.confirmed",
      correlationKey: "{{context.missing_correlation}}",
      payload: { payment_id: "PAY_FORGED", status: "confirmed" },
    }
  );
  console.log("  Unresolved status: " + unresolvedCorrelation.output.status);
  console.log("  Literal bypass status: " + literalBypass.status);
  console.log();

  console.log("✅ Case H: legal correlation modes remain compatible");
  const literalCorrelation = await runCorrelationSetupScenario("ORDER_LITERAL");
  const resolvedTemplateCorrelation = await runCorrelationSetupScenario(
    "tenant/{{context.correlation_id}}",
    { correlation_id: "ORDER_10086" }
  );
  const numberCorrelation = await runCorrelationSetupScenario(
    "{{context.correlation_id}}",
    { correlation_id: 10086 }
  );
  const booleanCorrelation = await runCorrelationSetupScenario(
    "tenant/{{context.correlation_id}}",
    { correlation_id: true }
  );
  const omittedCorrelation = await runCorrelationSetupScenario(undefined);
  console.log("  Literal status: " + literalCorrelation.output.status);
  console.log("  Resolved template status: " + resolvedTemplateCorrelation.output.status);
  console.log("  Number template status: " + numberCorrelation.output.status);
  console.log("  Boolean template status: " + booleanCorrelation.output.status);
  console.log("  Omitted correlation status: " + omittedCorrelation.output.status);
  console.log();

  if (!literalCorrelation.pendingSnapshot) {
    throw new Error("Expected literal correlation pending snapshot");
  }
  console.log("📦 Case I: unsafe v0.5.0 pending snapshots fail closed on restore");
  const unresolvedRestoreError = rejectedRestoreError(
    unsafeLegacySnapshot(
      literalCorrelation.pendingSnapshot,
      "{{context.missing_correlation}}"
    )
  );
  const emptyRestoreError = rejectedRestoreError(
    unsafeLegacySnapshot(literalCorrelation.pendingSnapshot, "")
  );
  const partialObjectRestoreError = rejectedRestoreError(
    unsafeLegacyPartialTemplateSnapshot(
      literalCorrelation.pendingSnapshot,
      { tenant: "org_001", order: "ORDER_10086" },
      'tenant/{"tenant":"org_001","order":"ORDER_10086"}'
    )
  );
  const partialArrayRestoreError = rejectedRestoreError(
    unsafeLegacyPartialTemplateSnapshot(
      literalCorrelation.pendingSnapshot,
      ["org_001", "ORDER_10086"],
      'tenant/["org_001","ORDER_10086"]'
    )
  );
  const partialEmptyRestoreError = rejectedRestoreError(
    unsafeLegacyPartialTemplateSnapshot(
      literalCorrelation.pendingSnapshot,
      "",
      "tenant/"
    )
  );
  const partialWhitespaceRestoreError = rejectedRestoreError(
    unsafeLegacyPartialTemplateSnapshot(
      literalCorrelation.pendingSnapshot,
      "   ",
      "tenant/   "
    )
  );
  console.log("  Unresolved snapshot rejected: " + Boolean(unresolvedRestoreError));
  console.log("  Empty snapshot rejected: " + Boolean(emptyRestoreError));
  console.log("  Partial object snapshot rejected: " + Boolean(partialObjectRestoreError));
  console.log("  Partial array snapshot rejected: " + Boolean(partialArrayRestoreError));
  console.log("  Partial empty snapshot rejected: " + Boolean(partialEmptyRestoreError));
  console.log("  Partial whitespace snapshot rejected: " + Boolean(partialWhitespaceRestoreError));
  console.log();

  console.log("📦 Case J: tampered RuntimeRecoveryBundle correlation fails atomically");
  const tamperedBundleCorrelation =
    await runTamperedBundleCorrelationRestoreScenario();
  console.log("  Bundle rejected: " + Boolean(tamperedBundleCorrelation.errorMessage));
  console.log(
    "  Partial state absent: " +
      String(
        !tamperedBundleCorrelation.hasRun &&
        !tamperedBundleCorrelation.hasPendingRun &&
        !tamperedBundleCorrelation.hasTrace &&
        tamperedBundleCorrelation.memoryUnchanged
      )
  );
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
    ...correlationSetupFailClosedChecks(
      "missing correlation template",
      unresolvedCorrelation,
      "contains an unresolved template"
    ),
    ...correlationSetupFailClosedChecks(
      "partially unresolved correlation template",
      partiallyUnresolvedCorrelation,
      "contains an unresolved template"
    ),
    ...correlationSetupFailClosedChecks(
      "empty resolved correlation",
      emptyCorrelation,
      "resolved to an empty string"
    ),
    ...correlationSetupFailClosedChecks(
      "null resolved correlation",
      nullCorrelation,
      "contains an unresolved template"
    ),
    ...correlationSetupFailClosedChecks(
      "object resolved correlation",
      objectCorrelation,
      "must resolve to a string, number, or boolean"
    ),
    ...correlationSetupFailClosedChecks(
      "partial template with object correlation",
      partialObjectCorrelation,
      "must resolve to a string, number, or boolean"
    ),
    ...correlationSetupFailClosedChecks(
      "partial template with array correlation",
      partialArrayCorrelation,
      "must resolve to a string, number, or boolean"
    ),
    ...correlationSetupFailClosedChecks(
      "partial template with empty correlation",
      partialEmptyCorrelation,
      "resolved to an empty string"
    ),
    ...correlationSetupFailClosedChecks(
      "partial template with whitespace correlation",
      partialWhitespaceCorrelation,
      "resolved to an empty string"
    ),
    ...correlationSetupFailClosedChecks(
      "empty template delimiters",
      emptyTemplateDelimiters,
      "contains an unresolved template"
    ),
    {
      label: "literal placeholder cannot bypass correlation after setup rejection",
      pass:
        literalBypass.status === "error" &&
        literalBypass.trace.eventCount === 0 &&
        unresolvedCorrelation.pendingSnapshot === null &&
        !directLiteralBypass.valid &&
        directLiteralBypass.errors.some((error) =>
          error.includes("contains an unresolved template")
        ),
      detail:
        `status=${literalBypass.status}, traceEvents=${literalBypass.trace.eventCount}, ` +
        `pending=${Boolean(unresolvedCorrelation.pendingSnapshot)}, ` +
        `directValidation=${JSON.stringify(directLiteralBypass)}`,
    },
    {
      label: "literal correlation remains compatible",
      pass:
        literalCorrelation.output.status === "waiting_external_event" &&
        literalCorrelation.output.pendingExternalEvent?.correlationKey === "ORDER_LITERAL" &&
        literalCorrelation.pendingSnapshot?.pendingKind === "external_event",
      detail: JSON.stringify(literalCorrelation.output.pendingExternalEvent ?? null),
    },
    {
      label: "resolved template correlation remains compatible",
      pass:
        resolvedTemplateCorrelation.output.status === "waiting_external_event" &&
        resolvedTemplateCorrelation.output.pendingExternalEvent?.correlationKey ===
          "tenant/ORDER_10086" &&
        resolvedTemplateCorrelation.pendingSnapshot?.pendingKind === "external_event",
      detail: JSON.stringify(resolvedTemplateCorrelation.output.pendingExternalEvent ?? null),
    },
    {
      label: "number correlation token remains compatible",
      pass:
        numberCorrelation.output.status === "waiting_external_event" &&
        numberCorrelation.output.pendingExternalEvent?.correlationKey === "10086" &&
        numberCorrelation.pendingSnapshot?.pendingKind === "external_event",
      detail: JSON.stringify(numberCorrelation.output.pendingExternalEvent ?? null),
    },
    {
      label: "boolean correlation token remains compatible",
      pass:
        booleanCorrelation.output.status === "waiting_external_event" &&
        booleanCorrelation.output.pendingExternalEvent?.correlationKey ===
          "tenant/true" &&
        booleanCorrelation.pendingSnapshot?.pendingKind === "external_event",
      detail: JSON.stringify(booleanCorrelation.output.pendingExternalEvent ?? null),
    },
    {
      label: "omitted correlation remains compatible",
      pass:
        omittedCorrelation.output.status === "waiting_external_event" &&
        omittedCorrelation.output.pendingExternalEvent?.correlationKey === undefined &&
        omittedCorrelation.pendingSnapshot?.pendingKind === "external_event",
      detail: JSON.stringify(omittedCorrelation.output.pendingExternalEvent ?? null),
    },
    {
      label: "legacy snapshot with unresolved correlation is rejected on restore",
      pass:
        unresolvedRestoreError?.includes("contains an unresolved template") === true &&
        !actorRuntime.hasRun(literalCorrelation.output.actorRunId),
      detail: unresolvedRestoreError ?? "restore unexpectedly succeeded",
    },
    {
      label: "legacy snapshot with empty correlation is rejected on restore",
      pass:
        emptyRestoreError?.includes("resolved to an empty string") === true &&
        !actorRuntime.hasRun(literalCorrelation.output.actorRunId),
      detail: emptyRestoreError ?? "restore unexpectedly succeeded",
    },
    {
      label: "legacy partial-template snapshot with object token is rejected",
      pass:
        partialObjectRestoreError?.includes(
          "must resolve to a string, number, or boolean"
        ) === true && !actorRuntime.hasRun(literalCorrelation.output.actorRunId),
      detail: partialObjectRestoreError ?? "restore unexpectedly succeeded",
    },
    {
      label: "legacy partial-template snapshot with array token is rejected",
      pass:
        partialArrayRestoreError?.includes(
          "must resolve to a string, number, or boolean"
        ) === true && !actorRuntime.hasRun(literalCorrelation.output.actorRunId),
      detail: partialArrayRestoreError ?? "restore unexpectedly succeeded",
    },
    {
      label: "legacy partial-template snapshot with empty token is rejected",
      pass:
        partialEmptyRestoreError?.includes("resolved to an empty string") === true &&
        !actorRuntime.hasRun(literalCorrelation.output.actorRunId),
      detail: partialEmptyRestoreError ?? "restore unexpectedly succeeded",
    },
    {
      label: "legacy partial-template snapshot with whitespace token is rejected",
      pass:
        partialWhitespaceRestoreError?.includes("resolved to an empty string") === true &&
        !actorRuntime.hasRun(literalCorrelation.output.actorRunId),
      detail: partialWhitespaceRestoreError ?? "restore unexpectedly succeeded",
    },
    {
      label: "tampered RuntimeRecoveryBundle correlation is rejected",
      pass:
        tamperedBundleCorrelation.errorMessage?.includes(
          "must resolve to a string, number, or boolean"
        ) === true,
      detail:
        tamperedBundleCorrelation.errorMessage ?? "restore unexpectedly succeeded",
    },
    {
      label: "rejected RuntimeRecoveryBundle leaves no partial runtime state",
      pass:
        !tamperedBundleCorrelation.hasRun &&
        !tamperedBundleCorrelation.hasPendingRun &&
        !tamperedBundleCorrelation.hasTrace &&
        tamperedBundleCorrelation.memoryUnchanged,
      detail:
        `actorRunId=${tamperedBundleCorrelation.actorRunId}, ` +
        `run=${tamperedBundleCorrelation.hasRun}, ` +
        `pending=${tamperedBundleCorrelation.hasPendingRun}, ` +
        `trace=${tamperedBundleCorrelation.hasTrace}, ` +
        `memoryUnchanged=${tamperedBundleCorrelation.memoryUnchanged}`,
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
