// ============================================================================
// continuation-validation.demo.ts — v0.5.0 release hardening
// 验证四类 waiting continuation 在错误 event type / request id 后仍可安全重试
// ============================================================================

import type { ActorConfig } from "../core/types/actor";
import type { SkillConfig } from "../core/types/skill";
import type { TraceEvent } from "../core/types/trace";
import type { ToolCallRequest, ToolDefinition, ToolObservation } from "../core/types/tool";
import { approvalGate } from "../approvals/approval-gate";
import { memoryService } from "../memory/memory-service";
import type { MemorySnapshot } from "../memory/memory-snapshot";
import type { MemoryStore } from "../memory/memory-store";
import {
  ActorRuntime,
  actorRuntime,
  type ActorContinueEvent,
  type ActorRunOutput,
  type ActorRunStatus,
} from "../runtime/actor-runtime";
import type { PendingRunSnapshot } from "../runtime/pending-run-snapshot";
import {
  createRuntimeRecoveryBundle,
  restoreRuntimeRecoveryBundle,
} from "../runtime/runtime-recovery-bundle";
import { traceLogger } from "../trace/trace-logger";
import { createTicketTool, type MockToolExecutor } from "../tools/mock-tools";
import { toolGateway } from "../tools/tool-gateway";

const ACTOR_CONFIG = {
  actor_id: "continuation_validation_actor",
  organization_id: "org_continuation_validation",
  name: "Continuation Validation Actor",
  type: "ai",
  role: "runtime_validator",
  responsibility: "验证 waiting continuation 的 retry-safe 语义",
  autonomy_level: "L2_read_and_draft",
  memory: [],
  permissions: {
    allowed_tools: ["create_ticket"],
    denied_tools: [],
    allowed_skills: [
      "continuation_human_input",
      "continuation_skill_approval",
      "continuation_tool_approval",
      "continuation_external_event",
    ],
  },
  approval_judgment: {
    must_request_approval_when: ["创建 urgent 工单"],
  },
} satisfies ActorConfig;

const HUMAN_INPUT_SKILL = {
  skill_id: "continuation_human_input",
  name: "Continuation Human Input",
  owner_actor_id: ACTOR_CONFIG.actor_id,
  steps: [
    {
      step_key: "ask_human",
      type: "human_input",
      prompt: "请确认是否继续。",
      output_key: "human_answer",
    },
    {
      step_key: "return",
      type: "return",
      output_mapping: { answer: "{{outputs.human_answer}}" },
    },
  ],
} satisfies SkillConfig;

const SKILL_APPROVAL_SKILL = {
  skill_id: "continuation_skill_approval",
  name: "Continuation Skill Approval",
  owner_actor_id: ACTOR_CONFIG.actor_id,
  steps: [
    {
      step_key: "manual_approval",
      type: "wait_approval",
      reason: "请审批是否继续。",
      output_key: "approval_result",
    },
    {
      step_key: "return",
      type: "return",
      output_mapping: { decision: "{{outputs.approval_result.decision}}" },
    },
  ],
} satisfies SkillConfig;

const TOOL_APPROVAL_SKILL = {
  skill_id: "continuation_tool_approval",
  name: "Continuation Tool Approval",
  owner_actor_id: ACTOR_CONFIG.actor_id,
  steps: [
    {
      step_key: "create_urgent_ticket",
      type: "tool_call",
      tool_name: "create_ticket",
      input_mapping: {
        title: "Continuation validation",
        type: "technical",
        priority: "urgent",
      },
      output_key: "ticket_result",
    },
    {
      step_key: "return",
      type: "return",
      output_mapping: { ticket_id: "{{outputs.ticket_result.ticketId}}" },
    },
  ],
} satisfies SkillConfig;

const EXTERNAL_EVENT_SKILL = {
  skill_id: "continuation_external_event",
  name: "Continuation External Event",
  owner_actor_id: ACTOR_CONFIG.actor_id,
  steps: [
    {
      step_key: "wait_confirmation",
      type: "wait_external_event",
      event_name: "continuation.confirmed",
      output_key: "confirmation_event",
      event_schema: {
        type: "object",
        required: ["confirmation"],
        properties: { confirmation: { type: "string" } },
      },
    },
    {
      step_key: "return",
      type: "return",
      output_mapping: {
        confirmation: "{{outputs.confirmation_event.payload.confirmation}}",
      },
    },
  ],
} satisfies SkillConfig;

let toolExecutionCount = 0;

class CountingCreateTicketExecutor implements MockToolExecutor {
  async execute(request: ToolCallRequest): Promise<ToolObservation> {
    toolExecutionCount += 1;
    return {
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      status: "success",
      data: {
        ticketId: `COUNTED_TICKET_${toolExecutionCount}`,
        priority: request.arguments.priority,
      },
      executedAt: new Date().toISOString(),
    };
  }
}

class ThrowingCreateTicketExecutor implements MockToolExecutor {
  async execute(): Promise<ToolObservation> {
    toolExecutionCount += 1;
    throw new Error("synthetic tool executor failure");
  }
}

class ErrorCreateTicketExecutor implements MockToolExecutor {
  async execute(request: ToolCallRequest): Promise<ToolObservation> {
    toolExecutionCount += 1;
    return {
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      status: "error",
      error: "synthetic tool error observation",
      executedAt: new Date().toISOString(),
    };
  }
}

class RetainedObservationExecutor implements MockToolExecutor {
  retained?: ToolObservation;

  async execute(request: ToolCallRequest): Promise<ToolObservation> {
    this.retained = {
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      status: "success",
      data: { value: "AUDITED_SAFE" },
      executedAt: new Date().toISOString(),
    };
    return this.retained;
  }
}

class BlockingCreateTicketExecutor implements MockToolExecutor {
  private readonly startedPromise: Promise<void>;
  private markStarted!: () => void;
  private finishExecution?: () => void;

  constructor() {
    this.startedPromise = new Promise<void>((resolve) => { this.markStarted = resolve; });
  }

  waitUntilStarted(): Promise<void> {
    return this.startedPromise;
  }

  finish(): void {
    this.finishExecution?.();
  }

  async execute(request: ToolCallRequest): Promise<ToolObservation> {
    toolExecutionCount += 1;
    this.markStarted();
    await new Promise<void>((resolve) => { this.finishExecution = resolve; });
    return {
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      status: "success",
      data: { ticketId: "BLOCKING_TICKET_1" },
      executedAt: new Date().toISOString(),
    };
  }
}

class BlockingMissMemoryStore implements MemoryStore {
  private readonly startedPromise: Promise<void>;
  private markStarted!: () => void;
  private releaseLoad?: () => void;

  constructor() {
    this.startedPromise = new Promise<void>((resolve) => { this.markStarted = resolve; });
  }

  waitUntilStarted(): Promise<void> {
    return this.startedPromise;
  }

  release(): void {
    this.releaseLoad?.();
  }

  async load(): Promise<MemorySnapshot | null> {
    this.markStarted();
    await new Promise<void>((resolve) => { this.releaseLoad = resolve; });
    return null;
  }

  async save(): Promise<void> {}
  async clear(): Promise<void> {}
}

type PendingKind = PendingRunSnapshot["pendingKind"];

interface ScenarioSpec {
  label: string;
  pendingKind: PendingKind;
  waitingStatus: Extract<
    ActorRunStatus,
    "waiting_human_input" | "waiting_approval" | "waiting_external_event"
  >;
  skillConfig: SkillConfig;
  wrongTypeEvent: (waiting: ActorRunOutput) => ActorContinueEvent;
  wrongRequestIdEvent: (waiting: ActorRunOutput) => ActorContinueEvent;
  validEvent: (waiting: ActorRunOutput) => ActorContinueEvent;
  validResult: (output: ActorRunOutput) => boolean;
}

interface ScenarioResult {
  spec: ScenarioSpec;
  waiting: ActorRunOutput;
  wrongType: ActorRunOutput;
  wrongRequestId: ActorRunOutput;
  completed: ActorRunOutput;
  pendingBefore: PendingRunSnapshot | null;
  pendingAfterWrongType: PendingRunSnapshot | null;
  pendingAfterWrongRequestId: PendingRunSnapshot | null;
  pendingAfterRestore: PendingRunSnapshot | null;
  eventsAfterInvalid: TraceEvent[];
  toolExecutionsBeforeRetry: number;
  toolExecutionsAfterRetry: number;
}

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

function resetRuntime(): void {
  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
  toolExecutionCount = 0;
  toolGateway.registerDefinition(createTicketTool);
  toolGateway.registerExecutor("create_ticket", new CountingCreateTicketExecutor());
}

function pendingWithoutSavedAt(snapshot: PendingRunSnapshot | null): unknown {
  if (!snapshot) return null;
  const { savedAt: _savedAt, ...stable } = snapshot;
  return stable;
}

function pendingUnchanged(
  before: PendingRunSnapshot | null,
  after: PendingRunSnapshot | null
): boolean {
  return JSON.stringify(pendingWithoutSavedAt(before)) === JSON.stringify(pendingWithoutSavedAt(after));
}

function approvalEvent(approvalRequestId: string): ActorContinueEvent {
  return {
    type: "approval_decision",
    decision: {
      approvalRequestId,
      decision: "approve",
      decidedBy: "release_hardening_approver",
      decidedAt: new Date().toISOString(),
    },
  };
}

function humanInputEvent(humanInputRequestId: string, value: string): ActorContinueEvent {
  return {
    type: "human_input_response",
    response: {
      humanInputRequestId,
      value,
      respondedBy: "release_hardening_operator",
      respondedAt: new Date().toISOString(),
    },
  };
}

function externalEvent(
  externalEventRequestId: string,
  confirmation: string
): ActorContinueEvent {
  return {
    type: "external_event_received",
    event: {
      externalEventRequestId,
      eventName: "continuation.confirmed",
      payload: { confirmation },
      receivedBy: "release_hardening_webhook",
      receivedAt: new Date().toISOString(),
    },
  };
}

function requireHumanRequestId(waiting: ActorRunOutput): string {
  const requestId = waiting.pendingHumanInput?.humanInputRequestId;
  if (!requestId) throw new Error("Expected pendingHumanInput");
  return requestId;
}

function requireApprovalRequestId(waiting: ActorRunOutput): string {
  const requestId = waiting.pendingApproval?.approvalRequestId;
  if (!requestId) throw new Error("Expected pendingApproval");
  return requestId;
}

function requireExternalEventRequestId(waiting: ActorRunOutput): string {
  const requestId = waiting.pendingExternalEvent?.externalEventRequestId;
  if (!requestId) throw new Error("Expected pendingExternalEvent");
  return requestId;
}

const SCENARIOS: ScenarioSpec[] = [
  {
    label: "human_input",
    pendingKind: "human_input",
    waitingStatus: "waiting_human_input",
    skillConfig: HUMAN_INPUT_SKILL,
    wrongTypeEvent: () => approvalEvent("wrong_type_human"),
    wrongRequestIdEvent: () => humanInputEvent("wrong_human_request", "invalid"),
    validEvent: (waiting) => humanInputEvent(requireHumanRequestId(waiting), "human-ok"),
    validResult: (output) => output.result?.answer === "human-ok",
  },
  {
    label: "skill_approval",
    pendingKind: "skill_approval",
    waitingStatus: "waiting_approval",
    skillConfig: SKILL_APPROVAL_SKILL,
    wrongTypeEvent: () => externalEvent("wrong_type_skill_approval", "invalid"),
    wrongRequestIdEvent: () => approvalEvent("wrong_skill_approval_request"),
    validEvent: (waiting) => approvalEvent(requireApprovalRequestId(waiting)),
    validResult: (output) => output.result?.decision === "approve",
  },
  {
    label: "tool_approval",
    pendingKind: "tool_approval",
    waitingStatus: "waiting_approval",
    skillConfig: TOOL_APPROVAL_SKILL,
    wrongTypeEvent: () => externalEvent("wrong_type_tool_approval", "invalid"),
    wrongRequestIdEvent: () => approvalEvent("wrong_tool_approval_request"),
    validEvent: (waiting) => approvalEvent(requireApprovalRequestId(waiting)),
    validResult: (output) => output.result?.ticket_id === "COUNTED_TICKET_1",
  },
  {
    label: "external_event",
    pendingKind: "external_event",
    waitingStatus: "waiting_external_event",
    skillConfig: EXTERNAL_EVENT_SKILL,
    wrongTypeEvent: () => approvalEvent("wrong_type_external_event"),
    wrongRequestIdEvent: () => externalEvent("wrong_external_event_request", "invalid"),
    validEvent: (waiting) => externalEvent(requireExternalEventRequestId(waiting), "external-ok"),
    validResult: (output) => output.result?.confirmation === "external-ok",
  },
];

async function runScenario(spec: ScenarioSpec): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: spec.skillConfig,
    input: { text: `Run ${spec.label} continuation validation` },
  });
  const pendingBefore = actorRuntime.dumpPendingRun(waiting.actorRunId);

  const wrongType = await actorRuntime.continue(
    waiting.actorRunId,
    spec.wrongTypeEvent(waiting)
  );
  const pendingAfterWrongType = actorRuntime.dumpPendingRun(waiting.actorRunId);

  const wrongRequestId = await actorRuntime.continue(
    waiting.actorRunId,
    spec.wrongRequestIdEvent(waiting)
  );
  const pendingAfterWrongRequestId = actorRuntime.dumpPendingRun(waiting.actorRunId);
  const eventsAfterInvalid = [...(traceLogger.getTrace(waiting.actorRunId)?.events ?? [])];
  const toolExecutionsBeforeRetry = toolExecutionCount;

  const recoveryBundle = createRuntimeRecoveryBundle(waiting.actorRunId);
  if (!recoveryBundle) throw new Error(`Expected ${spec.label} recovery bundle`);
  actorRuntime.clearRun(waiting.actorRunId);
  traceLogger.clear();
  memoryService.clear();
  restoreRuntimeRecoveryBundle(recoveryBundle);
  const pendingAfterRestore = actorRuntime.dumpPendingRun(waiting.actorRunId);

  const completed = await actorRuntime.continue(
    waiting.actorRunId,
    spec.validEvent(waiting)
  );

  return {
    spec,
    waiting,
    wrongType,
    wrongRequestId,
    completed,
    pendingBefore,
    pendingAfterWrongType,
    pendingAfterWrongRequestId,
    pendingAfterRestore,
    eventsAfterInvalid,
    toolExecutionsBeforeRetry,
    toolExecutionsAfterRetry: toolExecutionCount,
  };
}

function scenarioChecks(result: ScenarioResult): CheckResult[] {
  const { spec } = result;
  const eventTypes: string[] = result.eventsAfterInvalid.map((event) => event.eventType);
  const forbiddenBeforeRetry = [
    "actor_run_resumed",
    "human_input_received",
    "approval_decided",
    "external_event_received",
    "tool_call_start",
    "error",
    "actor_run_end",
  ];
  const validationFailureCount = eventTypes.filter(
    (eventType) =>
      eventType === "continuation_validation_failed" ||
      eventType === "external_event_validation_failed"
  ).length;

  return [
    {
      label: `${spec.label}: starts in ${spec.waitingStatus} with ${spec.pendingKind}`,
      pass:
        result.waiting.status === spec.waitingStatus &&
        result.pendingBefore?.pendingKind === spec.pendingKind,
      detail: `${result.waiting.status}/${result.pendingBefore?.pendingKind ?? "missing"}`,
    },
    {
      label: `${spec.label}: wrong event type remains waiting on same run`,
      pass:
        result.wrongType.status === spec.waitingStatus &&
        result.wrongType.actorRunId === result.waiting.actorRunId,
      detail: `${result.wrongType.status}/${result.wrongType.actorRunId}`,
    },
    {
      label: `${spec.label}: wrong event type leaves pending unchanged`,
      pass: pendingUnchanged(result.pendingBefore, result.pendingAfterWrongType),
      detail: `kind=${result.pendingAfterWrongType?.pendingKind ?? "missing"}`,
    },
    {
      label: `${spec.label}: wrong request id remains waiting on same run`,
      pass:
        result.wrongRequestId.status === spec.waitingStatus &&
        result.wrongRequestId.actorRunId === result.waiting.actorRunId,
      detail: `${result.wrongRequestId.status}/${result.wrongRequestId.actorRunId}`,
    },
    {
      label: `${spec.label}: wrong request id leaves pending unchanged`,
      pass: pendingUnchanged(result.pendingBefore, result.pendingAfterWrongRequestId),
      detail: `kind=${result.pendingAfterWrongRequestId?.pendingKind ?? "missing"}`,
    },
    {
      label: `${spec.label}: invalid attempts record validation failures`,
      pass: validationFailureCount === 2,
      detail: `validationFailureCount=${validationFailureCount}`,
    },
    {
      label: `${spec.label}: invalid attempts do not resume, consume, execute, error, or end`,
      pass: forbiddenBeforeRetry.every((eventType) => !eventTypes.includes(eventType)),
      detail: `events=${eventTypes.join(",")}`,
    },
    {
      label: `${spec.label}: pending remains restorable after invalid attempts`,
      pass: pendingUnchanged(result.pendingBefore, result.pendingAfterRestore),
      detail: `kind=${result.pendingAfterRestore?.pendingKind ?? "missing"}`,
    },
    {
      label: `${spec.label}: valid retry completes the same run`,
      pass:
        result.completed.status === "completed" &&
        result.completed.actorRunId === result.waiting.actorRunId,
      detail: `${result.completed.status}/${result.completed.actorRunId}`,
    },
    {
      label: `${spec.label}: valid retry produces expected result`,
      pass: spec.validResult(result.completed),
      detail: JSON.stringify(result.completed.result),
    },
  ];
}

type ToolTerminalMode = "reject" | "throw" | "error_observation";

interface ToolTerminalResult {
  mode: ToolTerminalMode;
  waiting: ActorRunOutput;
  output: ActorRunOutput;
  hasRunAfter: boolean;
  pendingAfter: PendingRunSnapshot | null;
  gatePendingAfter: boolean;
  events: TraceEvent[];
  executions: number;
}

async function runToolTerminalScenario(mode: ToolTerminalMode): Promise<ToolTerminalResult> {
  resetRuntime();
  if (mode === "throw") {
    toolGateway.registerExecutor("create_ticket", new ThrowingCreateTicketExecutor());
  } else if (mode === "error_observation") {
    toolGateway.registerExecutor("create_ticket", new ErrorCreateTicketExecutor());
  }

  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: TOOL_APPROVAL_SKILL,
    input: { text: `Run Tool approval terminal scenario: ${mode}` },
  });
  const approvalRequestId = requireApprovalRequestId(waiting);
  const event: ActorContinueEvent = {
    type: "approval_decision",
    decision: {
      approvalRequestId,
      decision: mode === "reject" ? "reject" : "approve",
      decidedBy: "release_hardening_approver",
      decidedAt: new Date().toISOString(),
    },
  };
  const output = await actorRuntime.continue(waiting.actorRunId, event);

  return {
    mode,
    waiting,
    output,
    hasRunAfter: actorRuntime.hasRun(waiting.actorRunId),
    pendingAfter: actorRuntime.dumpPendingRun(waiting.actorRunId),
    gatePendingAfter: Boolean(approvalGate.getPending(waiting.actorRunId)),
    events: [...(traceLogger.getTrace(waiting.actorRunId)?.events ?? [])],
    executions: toolExecutionCount,
  };
}

function toolTerminalChecks(result: ToolTerminalResult): CheckResult[] {
  const errorEndCount = result.events.filter(
    (event) => event.eventType === "actor_run_end" && event.data.status === "error"
  ).length;
  const errorEventCount = result.events.filter((event) => event.eventType === "error").length;
  const expectedExecutions = result.mode === "reject" ? 0 : 1;
  return [
    {
      label: `tool ${result.mode}: returns one terminal error`,
      pass:
        result.output.status === "error" &&
        errorEndCount === 1 &&
        errorEventCount === 1,
      detail: `status=${result.output.status}, errorEvents=${errorEventCount}, errorEnds=${errorEndCount}`,
    },
    {
      label: `tool ${result.mode}: clears Runtime, Executor, Gate, and pending state`,
      pass:
        !result.hasRunAfter &&
        result.pendingAfter === null &&
        !result.gatePendingAfter,
      detail: `hasRun=${result.hasRunAfter}, pending=${String(result.pendingAfter)}, gate=${result.gatePendingAfter}`,
    },
    {
      label: `tool ${result.mode}: executes the tool ${expectedExecutions} time(s)`,
      pass: result.executions === expectedExecutions,
      detail: `executions=${result.executions}`,
    },
  ];
}

interface InvalidApprovalResult {
  waiting: ActorRunOutput;
  invalidOutputs: ActorRunOutput[];
  pendingBefore: PendingRunSnapshot | null;
  pendingAfter: PendingRunSnapshot | null;
  eventsBeforeRetry: TraceEvent[];
  completed: ActorRunOutput;
  executions: number;
}

async function runInvalidApprovalScenario(): Promise<InvalidApprovalResult> {
  resetRuntime();
  const disallowModifiedArguments = structuredClone(createTicketTool);
  if (disallowModifiedArguments.approvalPolicy?.beforeCall) {
    disallowModifiedArguments.approvalPolicy.beforeCall.allowModifyArguments = false;
  }
  toolGateway.registerDefinition(disallowModifiedArguments);

  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: TOOL_APPROVAL_SKILL,
    input: { text: "Validate malformed approval decisions" },
  });
  const approvalRequestId = requireApprovalRequestId(waiting);
  const pendingBefore = actorRuntime.dumpPendingRun(waiting.actorRunId);
  const invalidEvents = [
    { type: "unknown_continuation" },
    { type: "approval_decision", decision: null },
    {
      type: "approval_decision",
      decision: {
        approvalRequestId,
        decision: "approve_evil",
        decidedAt: new Date().toISOString(),
      },
    },
    {
      type: "approval_decision",
      decision: {
        approvalRequestId,
        decision: "approve",
        decidedAt: new Date().toISOString(),
        extra: 1n,
      },
    },
    {
      type: "approval_decision",
      decision: {
        approvalRequestId,
        decision: "approve",
        modifiedArguments: { title: "bypass", type: "finance", priority: "urgent" },
        decidedAt: new Date().toISOString(),
      },
    },
    {
      type: "approval_decision",
      decision: {
        approvalRequestId,
        decision: "approve_with_modified_arguments",
        modifiedArguments: { title: "bypass", type: "finance", priority: "urgent" },
        decidedAt: new Date().toISOString(),
      },
    },
    {
      type: "approval_decision",
      decision: {
        approvalRequestId,
        decision: "approve_with_modified_result_view",
        modifiedResultView: { ticketId: "redacted" },
        decidedAt: new Date().toISOString(),
      },
    },
  ] as unknown as ActorContinueEvent[];

  const invalidOutputs: ActorRunOutput[] = [];
  for (const event of invalidEvents) {
    invalidOutputs.push(await actorRuntime.continue(waiting.actorRunId, event));
  }
  const pendingAfter = actorRuntime.dumpPendingRun(waiting.actorRunId);
  const eventsBeforeRetry = [...(traceLogger.getTrace(waiting.actorRunId)?.events ?? [])];
  const completed = await actorRuntime.continue(
    waiting.actorRunId,
    approvalEvent(approvalRequestId)
  );

  return {
    waiting,
    invalidOutputs,
    pendingBefore,
    pendingAfter,
    eventsBeforeRetry,
    completed,
    executions: toolExecutionCount,
  };
}

function invalidApprovalChecks(result: InvalidApprovalResult): CheckResult[] {
  const validationFailures = result.eventsBeforeRetry.filter(
    (event) => event.eventType === "continuation_validation_failed"
  ).length;
  const forbidden = result.eventsBeforeRetry.filter((event) =>
    ["actor_run_resumed", "approval_decided", "tool_call_start", "error", "actor_run_end"].includes(
      event.eventType
    )
  );
  return [
    {
      label: "malformed/unsupported approvals all remain waiting",
      pass: result.invalidOutputs.every((output) => output.status === "waiting_approval"),
      detail: result.invalidOutputs.map((output) => output.status).join(","),
    },
    {
      label: "malformed/unsupported approvals preserve the exact pending run",
      pass: pendingUnchanged(result.pendingBefore, result.pendingAfter),
      detail: `kind=${result.pendingAfter?.pendingKind ?? "missing"}`,
    },
    {
      label: "malformed/unsupported approvals validate before resume or consumption",
      pass:
        validationFailures === result.invalidOutputs.length &&
        forbidden.length === 0,
      detail: `validationFailures=${validationFailures}, forbidden=${forbidden.length}`,
    },
    {
      label: "a valid approval still retries and executes exactly once",
      pass:
        result.completed.status === "completed" &&
        result.executions === 1 &&
        result.completed.result?.ticket_id === "COUNTED_TICKET_1",
      detail: `${result.completed.status}/${result.executions}/${JSON.stringify(result.completed.result)}`,
    },
  ];
}

async function runApprovalPolicyDriftChecks(): Promise<CheckResult[]> {
  resetRuntime();
  const originalPolicy = structuredClone(createTicketTool);
  if (!originalPolicy.approvalPolicy?.beforeCall) {
    throw new Error("Expected create_ticket before-call approval policy");
  }
  originalPolicy.approvalPolicy.beforeCall.allowModifyArguments = false;
  toolGateway.registerDefinition(originalPolicy);
  // Mutating the caller's registration object must not mutate the Registry.
  originalPolicy.approvalPolicy.beforeCall.allowModifyArguments = true;

  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: TOOL_APPROVAL_SKILL,
    input: { text: "Reject approval policy expansion" },
  });
  const approvalRequestId = requireApprovalRequestId(waiting);
  const pendingBefore = actorRuntime.dumpPendingRun(waiting.actorRunId);

  // Explicitly hot-swap the registered policy while the old request waits.
  toolGateway.registerDefinition(createTicketTool);
  const driftAttempt = await actorRuntime.continue(waiting.actorRunId, {
    type: "approval_decision",
    decision: {
      approvalRequestId,
      decision: "approve_with_modified_arguments",
      modifiedArguments: { title: "changed", type: "finance", priority: "urgent" },
      decidedAt: new Date().toISOString(),
    },
  });
  const pendingAfterDrift = actorRuntime.dumpPendingRun(waiting.actorRunId);
  const validationFailures = traceLogger.getTrace(waiting.actorRunId)?.events.filter(
    (event) => event.eventType === "continuation_validation_failed"
  ).length ?? 0;
  const executionsAfterDrift = toolExecutionCount;

  const restoredPolicy = structuredClone(createTicketTool);
  if (restoredPolicy.approvalPolicy?.beforeCall) {
    restoredPolicy.approvalPolicy.beforeCall.allowModifyArguments = false;
  }
  toolGateway.registerDefinition(restoredPolicy);
  const completed = await actorRuntime.continue(
    waiting.actorRunId,
    approvalEvent(approvalRequestId)
  );

  return [
    {
      label: "Tool Registry detaches the caller's mutable definition",
      pass: pendingBefore?.pendingToolApproval?.approvalRequest.policy.allowModifyArguments === false,
      detail: String(pendingBefore?.pendingToolApproval?.approvalRequest.policy.allowModifyArguments),
    },
    {
      label: "pending Tool approval rejects post-request policy expansion",
      pass:
        driftAttempt.status === "waiting_approval" &&
        pendingUnchanged(pendingBefore, pendingAfterDrift) &&
        executionsAfterDrift === 0 &&
        validationFailures === 1,
      detail: `${driftAttempt.status}/executions=${executionsAfterDrift}/validation=${validationFailures}`,
    },
    {
      label: "restoring the original Tool policy permits a valid retry",
      pass: completed.status === "completed" && toolExecutionCount === 1,
      detail: `${completed.status}/${toolExecutionCount}`,
    },
  ];
}

interface JsonSafetyResult {
  humanInvalidStatus: ActorRunStatus;
  humanPendingUnchanged: boolean;
  humanValidationFailures: number;
  humanRetryStatus: ActorRunStatus;
  externalInvalidStatus: ActorRunStatus;
  externalPendingUnchanged: boolean;
  externalValidationFailures: number;
  externalRetryStatus: ActorRunStatus;
}

async function runJsonSafetyScenario(): Promise<JsonSafetyResult> {
  resetRuntime();
  const humanWaiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: HUMAN_INPUT_SKILL,
    input: { text: "Reject non-JSON human input" },
  });
  const humanBefore = actorRuntime.dumpPendingRun(humanWaiting.actorRunId);
  const humanInvalid = await actorRuntime.continue(humanWaiting.actorRunId, {
    type: "human_input_response",
    response: {
      humanInputRequestId: requireHumanRequestId(humanWaiting),
      value: { unsafe: 1n },
      respondedAt: new Date().toISOString(),
    },
  });
  const humanAfter = actorRuntime.dumpPendingRun(humanWaiting.actorRunId);
  const humanValidationFailures =
    traceLogger.getTrace(humanWaiting.actorRunId)?.events.filter(
      (event) => event.eventType === "continuation_validation_failed"
    ).length ?? 0;
  const humanRetry = await actorRuntime.continue(
    humanWaiting.actorRunId,
    humanInputEvent(requireHumanRequestId(humanWaiting), "json-safe")
  );

  resetRuntime();
  const externalWaiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: EXTERNAL_EVENT_SKILL,
    input: { text: "Reject non-JSON external payload" },
  });
  const externalBefore = actorRuntime.dumpPendingRun(externalWaiting.actorRunId);
  const externalInvalid = await actorRuntime.continue(externalWaiting.actorRunId, {
    type: "external_event_received",
    event: {
      externalEventRequestId: requireExternalEventRequestId(externalWaiting),
      eventName: "continuation.confirmed",
      payload: { confirmation: "unsafe", unsafe: 1n },
      receivedAt: new Date().toISOString(),
    },
  });
  const externalAfter = actorRuntime.dumpPendingRun(externalWaiting.actorRunId);
  const externalValidationFailures =
    traceLogger.getTrace(externalWaiting.actorRunId)?.events.filter(
      (event) => event.eventType === "continuation_validation_failed"
    ).length ?? 0;
  const externalRetry = await actorRuntime.continue(
    externalWaiting.actorRunId,
    externalEvent(requireExternalEventRequestId(externalWaiting), "json-safe")
  );

  return {
    humanInvalidStatus: humanInvalid.status,
    humanPendingUnchanged: pendingUnchanged(humanBefore, humanAfter),
    humanValidationFailures,
    humanRetryStatus: humanRetry.status,
    externalInvalidStatus: externalInvalid.status,
    externalPendingUnchanged: pendingUnchanged(externalBefore, externalAfter),
    externalValidationFailures,
    externalRetryStatus: externalRetry.status,
  };
}

function jsonSafetyChecks(result: JsonSafetyResult): CheckResult[] {
  return [
    {
      label: "non-JSON human response remains retry-safe",
      pass:
        result.humanInvalidStatus === "waiting_human_input" &&
        result.humanPendingUnchanged &&
        result.humanValidationFailures === 1 &&
        result.humanRetryStatus === "completed",
      detail: `${result.humanInvalidStatus}/${result.humanPendingUnchanged}/${result.humanValidationFailures}/${result.humanRetryStatus}`,
    },
    {
      label: "non-JSON external payload remains retry-safe",
      pass:
        result.externalInvalidStatus === "waiting_external_event" &&
        result.externalPendingUnchanged &&
        result.externalValidationFailures === 1 &&
        result.externalRetryStatus === "completed",
      detail: `${result.externalInvalidStatus}/${result.externalPendingUnchanged}/${result.externalValidationFailures}/${result.externalRetryStatus}`,
    },
  ];
}

interface InFlightClearResult {
  occupiedWhileRunning: boolean;
  clearRejected: boolean;
  completedStatus: ActorRunStatus;
  hasRunAfter: boolean;
  executions: number;
}

async function runInFlightClearScenario(): Promise<InFlightClearResult> {
  resetRuntime();
  const executor = new BlockingCreateTicketExecutor();
  toolGateway.registerExecutor("create_ticket", executor);
  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: TOOL_APPROVAL_SKILL,
    input: { text: "Reject clearRun while continuation is in flight" },
  });
  const continuation = actorRuntime.continue(
    waiting.actorRunId,
    approvalEvent(requireApprovalRequestId(waiting))
  );
  await executor.waitUntilStarted();
  const occupiedWhileRunning = actorRuntime.hasRun(waiting.actorRunId);
  let clearRejected = false;
  try {
    actorRuntime.clearRun(waiting.actorRunId);
  } catch {
    clearRejected = true;
  }
  executor.finish();
  const completed = await continuation;
  return {
    occupiedWhileRunning,
    clearRejected,
    completedStatus: completed.status,
    hasRunAfter: actorRuntime.hasRun(waiting.actorRunId),
    executions: toolExecutionCount,
  };
}

function inFlightClearChecks(result: InFlightClearResult): CheckResult[] {
  return [
    {
      label: "in-flight continuation reserves its Actor run and rejects clearRun",
      pass: result.occupiedWhileRunning && result.clearRejected,
      detail: `occupied=${result.occupiedWhileRunning}, clearRejected=${result.clearRejected}`,
    },
    {
      label: "rejected clearRun does not disturb the terminal continuation",
      pass:
        result.completedStatus === "completed" &&
        !result.hasRunAfter &&
        result.executions === 1,
      detail: `${result.completedStatus}/hasRun=${result.hasRunAfter}/executions=${result.executions}`,
    },
  ];
}

interface MutexResult {
  outputs: ActorRunOutput[];
  events: TraceEvent[];
  hasRunAfter: boolean;
  executions: number;
}

async function runContinuationMutexScenario(): Promise<MutexResult> {
  resetRuntime();
  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: TOOL_APPROVAL_SKILL,
    input: { text: "Validate per-run continuation mutex" },
  });
  const event = approvalEvent(requireApprovalRequestId(waiting));
  const outputs = await Promise.all([
    actorRuntime.continue(waiting.actorRunId, event),
    actorRuntime.continue(waiting.actorRunId, event),
  ]);
  return {
    outputs,
    events: [...(traceLogger.getTrace(waiting.actorRunId)?.events ?? [])],
    hasRunAfter: actorRuntime.hasRun(waiting.actorRunId),
    executions: toolExecutionCount,
  };
}

function mutexChecks(result: MutexResult): CheckResult[] {
  const completedCount = result.outputs.filter((output) => output.status === "completed").length;
  const errorOutputCount = result.outputs.filter((output) => output.status === "error").length;
  const resumedCount = result.events.filter((event) => event.eventType === "actor_run_resumed").length;
  const decidedCount = result.events.filter((event) => event.eventType === "approval_decided").length;
  const toolCallCount = result.events.filter((event) => event.eventType === "tool_call_start").length;
  const endCount = result.events.filter((event) => event.eventType === "actor_run_end").length;
  return [
    {
      label: "concurrent continuation processes the valid event once",
      pass: completedCount === 1 && errorOutputCount === 1,
      detail: result.outputs.map((output) => output.status).join(","),
    },
    {
      label: "concurrent continuation preserves a single valid lifecycle",
      pass:
        resumedCount === 1 &&
        decidedCount === 1 &&
        toolCallCount === 1 &&
        result.executions === 1 &&
        endCount === 1 &&
        !result.hasRunAfter,
      detail: `resumed=${resumedCount}, decided=${decidedCount}, toolCalls=${toolCallCount}, executions=${result.executions}, ends=${endCount}, hasRun=${result.hasRunAfter}`,
    },
  ];
}

async function runModifiedArgumentSchemaScenario(): Promise<CheckResult[]> {
  resetRuntime();
  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: TOOL_APPROVAL_SKILL,
    input: { text: "Validate modified argument schema" },
  });
  const requestId = requireApprovalRequestId(waiting);
  const before = actorRuntime.dumpPendingRun(waiting.actorRunId);
  const invalid = await actorRuntime.continue(waiting.actorRunId, {
    type: "approval_decision",
    decision: {
      approvalRequestId: requestId,
      decision: "approve_with_modified_arguments",
      modifiedArguments: {},
      decidedAt: new Date().toISOString(),
    },
  });
  const after = actorRuntime.dumpPendingRun(waiting.actorRunId);
  const executionsBeforeRetry = toolExecutionCount;
  const completed = await actorRuntime.continue(waiting.actorRunId, approvalEvent(requestId));
  return [
    {
      label: "schema-invalid modified Tool arguments remain retry-safe",
      pass:
        invalid.status === "waiting_approval" &&
        pendingUnchanged(before, after) &&
        executionsBeforeRetry === 0,
      detail: `${invalid.status}/${executionsBeforeRetry}/${after?.pendingKind ?? "missing"}`,
    },
    {
      label: "valid retry after schema-invalid modification executes once",
      pass: completed.status === "completed" && toolExecutionCount === 1,
      detail: `${completed.status}/${toolExecutionCount}`,
    },
  ];
}

async function runDefensiveCloneScenario(): Promise<CheckResult[]> {
  resetRuntime();
  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: HUMAN_INPUT_SKILL,
    input: { text: "Validate caller payload detachment" },
  });
  const callerValue: Record<string, unknown> = { answer: "safe" };
  const completed = await actorRuntime.continue(waiting.actorRunId, {
    type: "human_input_response",
    response: {
      humanInputRequestId: requireHumanRequestId(waiting),
      value: callerValue,
    },
  });
  callerValue.answer = 1n;
  let traceStillSerializable = true;
  try {
    traceLogger.dumpSnapshot();
  } catch {
    traceStillSerializable = false;
  }

  resetRuntime();
  const humanWaiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: HUMAN_INPUT_SKILL,
    input: { text: "Validate pending output detachment" },
  });
  const originalHumanRequestId = requireHumanRequestId(humanWaiting);
  humanWaiting.pendingHumanInput!.humanInputRequestId = "forged_from_output";
  const forgedHumanAttempt = await actorRuntime.continue(
    humanWaiting.actorRunId,
    humanInputEvent("forged_from_output", "forged")
  );
  const humanPendingAfterMutation = actorRuntime.dumpPendingRun(humanWaiting.actorRunId);
  const validHumanRetry = await actorRuntime.continue(
    humanWaiting.actorRunId,
    humanInputEvent(originalHumanRequestId, "safe")
  );

  resetRuntime();
  const externalWaiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: EXTERNAL_EVENT_SKILL,
    input: { text: "Validate exposed schema detachment" },
  });
  const originalExternalRequestId = requireExternalEventRequestId(externalWaiting);
  const exposedSchema = externalWaiting.pendingExternalEvent?.eventSchema as {
    properties?: { confirmation?: { type?: string } };
  } | undefined;
  if (exposedSchema?.properties?.confirmation) {
    exposedSchema.properties.confirmation.type = "number";
  }
  const forgedExternalAttempt = await actorRuntime.continue(externalWaiting.actorRunId, {
    type: "external_event_received",
    event: {
      externalEventRequestId: originalExternalRequestId,
      eventName: "continuation.confirmed",
      payload: { confirmation: 123 },
    },
  });
  const externalPendingAfterMutation = actorRuntime.dumpPendingRun(externalWaiting.actorRunId);
  const validExternalRetry = await actorRuntime.continue(
    externalWaiting.actorRunId,
    externalEvent(originalExternalRequestId, "safe")
  );

  resetRuntime();
  const retainedTool: ToolDefinition = {
    toolName: "retained_observation_tool",
    description: "Returns an observation retained by its executor",
    direction: "read",
    riskLevel: "low",
    outputSchema: {
      type: "object",
      required: ["value"],
      properties: { value: { type: "string" } },
    },
  };
  const retainedExecutor = new RetainedObservationExecutor();
  toolGateway.registerDefinition(retainedTool);
  toolGateway.registerExecutor(retainedTool.toolName, retainedExecutor);
  const retainedActor = structuredClone(ACTOR_CONFIG) as ActorConfig;
  retainedActor.permissions.allowed_tools.push(retainedTool.toolName);
  retainedActor.permissions.allowed_skills!.push("retained_observation_skill");
  const retainedSkill: SkillConfig = {
    skill_id: "retained_observation_skill",
    name: "Retained Observation Isolation",
    owner_actor_id: retainedActor.actor_id,
    steps: [
      {
        step_key: "tool",
        type: "tool_call",
        tool_name: retainedTool.toolName,
        input_mapping: {},
        output_key: "tool_result",
      },
      {
        step_key: "wait",
        type: "human_input",
        prompt: "Pause after Tool return",
        output_key: "human",
      },
      {
        step_key: "return",
        type: "return",
        output_mapping: { value: "{{outputs.tool_result.value}}" },
      },
    ],
  };
  const retainedWaiting = await actorRuntime.run({
    actorConfig: retainedActor,
    skillConfig: retainedSkill,
    input: { text: "Detach Tool observation" },
  });
  if (retainedExecutor.retained?.data) {
    retainedExecutor.retained.data.value = "MUTATED_AFTER_TOOL_RETURN";
  }
  const retainedCompleted = await actorRuntime.continue(
    retainedWaiting.actorRunId,
    humanInputEvent(requireHumanRequestId(retainedWaiting), "continue")
  );
  const auditedObservation = traceLogger.getTrace(retainedWaiting.actorRunId)?.events.find(
    (event) => event.eventType === "tool_observation"
  );
  return [
    {
      label: "continuation detaches state/result from caller-owned payloads",
      pass:
        (completed.result?.answer as Record<string, unknown> | undefined)?.answer === "safe",
      detail: String((completed.result?.answer as Record<string, unknown> | undefined)?.answer),
    },
    {
      label: "caller mutation cannot corrupt the persisted Trace",
      pass: traceStillSerializable,
      detail: String(traceStillSerializable),
    },
    {
      label: "mutating pendingHumanInput output cannot forge the live request id",
      pass:
        forgedHumanAttempt.status === "waiting_human_input" &&
        humanPendingAfterMutation?.pendingHumanInput?.humanInputRequestId === originalHumanRequestId &&
        validHumanRetry.status === "completed",
      detail: `${forgedHumanAttempt.status}/${String(humanPendingAfterMutation?.pendingHumanInput?.humanInputRequestId)}/${validHumanRetry.status}`,
    },
    {
      label: "mutating pendingExternalEvent output cannot widen the live schema",
      pass:
        forgedExternalAttempt.status === "waiting_external_event" &&
        (externalPendingAfterMutation?.pendingExternalEvent?.eventSchema as {
          properties?: { confirmation?: { type?: string } };
        } | undefined)?.properties?.confirmation?.type === "string" &&
        validExternalRetry.status === "completed",
      detail: `${forgedExternalAttempt.status}/${validExternalRetry.status}`,
    },
    {
      label: "Tool observations detach executor aliases before state and Trace use",
      pass:
        retainedCompleted.status === "completed" &&
        retainedCompleted.result?.value === "AUDITED_SAFE" &&
        (auditedObservation?.data.data as Record<string, unknown> | undefined)?.value === "AUDITED_SAFE",
      detail: `${retainedCompleted.status}/${String(retainedCompleted.result?.value)}/${String((auditedObservation?.data.data as Record<string, unknown> | undefined)?.value)}`,
    },
  ];
}

async function runForeignRuntimeClearScenario(): Promise<CheckResult[]> {
  resetRuntime();
  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: TOOL_APPROVAL_SKILL,
    input: { text: "Validate ActorRuntime run ownership" },
  });
  const requestId = requireApprovalRequestId(waiting);
  let foreignClearRejected = false;
  try {
    new ActorRuntime().clearRun(waiting.actorRunId);
  } catch {
    foreignClearRejected = true;
  }
  const pendingSurvived = actorRuntime.dumpPendingRun(waiting.actorRunId)?.pendingKind === "tool_approval";
  const completed = await actorRuntime.continue(waiting.actorRunId, approvalEvent(requestId));
  return [
    {
      label: "a foreign ActorRuntime cannot clear another runtime's run",
      pass: foreignClearRejected && pendingSurvived,
      detail: `${foreignClearRejected}/${pendingSurvived}`,
    },
    {
      label: "foreign clear attempt does not disturb valid continuation",
      pass: completed.status === "completed" && toolExecutionCount === 1,
      detail: `${completed.status}/${toolExecutionCount}`,
    },
  ];
}

async function runEmptyApprovalIdScenario(): Promise<CheckResult> {
  resetRuntime();
  const invalidSkill = structuredClone(SKILL_APPROVAL_SKILL) as SkillConfig;
  invalidSkill.steps[0].approval_request_id = "";
  const output = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: invalidSkill,
    input: { text: "Reject empty approval request id" },
  });
  return {
    label: "empty configured approval request id fails before creating pending state",
    pass: output.status === "error" && actorRuntime.dumpPendingRun(output.actorRunId) === null,
    detail: output.status,
  };
}

async function runPreflightSideEffectChecks(): Promise<CheckResult[]> {
  resetRuntime();
  const invalidActor = structuredClone(ACTOR_CONFIG) as ActorConfig;
  invalidActor.memory = ["POISON_FROM_INVALID_ACTOR"];
  invalidActor.autonomy_level = "INVALID_AUTONOMY";
  const invalidActorOutput = await actorRuntime.run({
    actorConfig: invalidActor,
    skillConfig: HUMAN_INPUT_SKILL,
    input: { text: "Invalid Actor preflight" },
  });
  const memoryAfterInvalidActor = memoryService.dumpOrganizationSnapshot(
    ACTOR_CONFIG.organization_id
  ).memories;

  const invalidSkill = structuredClone(HUMAN_INPUT_SKILL) as SkillConfig;
  invalidSkill.steps[0].type = "unknown_step";
  const actorWithSkillPoison = structuredClone(ACTOR_CONFIG) as ActorConfig;
  actorWithSkillPoison.memory = ["POISON_FROM_INVALID_SKILL"];
  const invalidSkillOutput = await actorRuntime.run({
    actorConfig: actorWithSkillPoison,
    skillConfig: invalidSkill,
    input: { text: "Invalid Skill preflight" },
  });
  const memoryAfterInvalidSkill = memoryService.dumpOrganizationSnapshot(
    ACTOR_CONFIG.organization_id
  ).memories;

  const actorWithInputPoison = structuredClone(ACTOR_CONFIG) as ActorConfig;
  actorWithInputPoison.memory = ["POISON_FROM_INVALID_INPUT"];
  const invalidInputOutput = await actorRuntime.run({
    actorConfig: actorWithInputPoison,
    skillConfig: HUMAN_INPUT_SKILL,
    input: { payload: { nonJson: 1n } },
  });
  const memoryAfterInvalidInput = memoryService.dumpOrganizationSnapshot(
    ACTOR_CONFIG.organization_id
  ).memories;

  const unownedSkill = structuredClone(HUMAN_INPUT_SKILL) as SkillConfig;
  unownedSkill.owner_actor_id = "another_actor";
  const actorWithOwnerPoison = structuredClone(ACTOR_CONFIG) as ActorConfig;
  actorWithOwnerPoison.memory = ["POISON_FROM_UNOWNED_SKILL"];
  const unownedSkillOutput = await actorRuntime.run({
    actorConfig: actorWithOwnerPoison,
    skillConfig: unownedSkill,
    input: { text: "Unowned Skill preflight" },
  });
  const memoryAfterUnownedSkill = memoryService.dumpOrganizationSnapshot(
    ACTOR_CONFIG.organization_id
  ).memories;

  const deniedSkill = structuredClone(HUMAN_INPUT_SKILL) as SkillConfig;
  deniedSkill.skill_id = "not_in_allowed_skills";
  const actorWithPermissionPoison = structuredClone(ACTOR_CONFIG) as ActorConfig;
  actorWithPermissionPoison.memory = ["POISON_FROM_DENIED_SKILL"];
  const deniedSkillOutput = await actorRuntime.run({
    actorConfig: actorWithPermissionPoison,
    skillConfig: deniedSkill,
    input: { text: "Denied Skill preflight" },
  });
  const memoryAfterDeniedSkill = memoryService.dumpOrganizationSnapshot(
    ACTOR_CONFIG.organization_id
  ).memories;

  return [
    {
      label: "invalid Actor config is rejected before Memory seed side effects",
      pass: invalidActorOutput.status === "error" && memoryAfterInvalidActor.length === 0,
      detail: `${invalidActorOutput.status}/${memoryAfterInvalidActor.length}`,
    },
    {
      label: "invalid Skill config is rejected before Memory seed side effects",
      pass: invalidSkillOutput.status === "error" && memoryAfterInvalidSkill.length === 0,
      detail: `${invalidSkillOutput.status}/${memoryAfterInvalidSkill.length}`,
    },
    {
      label: "non-JSON input is rejected before Memory seed side effects",
      pass: invalidInputOutput.status === "error" && memoryAfterInvalidInput.length === 0,
      detail: `${invalidInputOutput.status}/${memoryAfterInvalidInput.length}`,
    },
    {
      label: "unowned Skill is rejected before Memory seed side effects",
      pass: unownedSkillOutput.status === "error" && memoryAfterUnownedSkill.length === 0,
      detail: `${unownedSkillOutput.status}/${memoryAfterUnownedSkill.length}`,
    },
    {
      label: "Skill outside allowed_skills is rejected before Memory seed side effects",
      pass: deniedSkillOutput.status === "error" && memoryAfterDeniedSkill.length === 0,
      detail: `${deniedSkillOutput.status}/${memoryAfterDeniedSkill.length}`,
    },
  ];
}

async function runToolCallIdUniquenessCheck(): Promise<CheckResult> {
  resetRuntime();
  const [first, second] = await Promise.all([
    actorRuntime.run({
      actorConfig: ACTOR_CONFIG,
      skillConfig: TOOL_APPROVAL_SKILL,
      input: { text: "First concurrent Tool call" },
    }),
    actorRuntime.run({
      actorConfig: ACTOR_CONFIG,
      skillConfig: TOOL_APPROVAL_SKILL,
      input: { text: "Second concurrent Tool call" },
    }),
  ]);
  const firstId = actorRuntime.dumpPendingRun(first.actorRunId)
    ?.pendingToolApproval?.pendingExec.pendingToolCall.toolCallId;
  const secondId = actorRuntime.dumpPendingRun(second.actorRunId)
    ?.pendingToolApproval?.pendingExec.pendingToolCall.toolCallId;
  actorRuntime.clearRun(first.actorRunId);
  actorRuntime.clearRun(second.actorRunId);
  const uuidPattern = /^tc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return {
    label: "concurrent runs receive distinct UUID Tool call ids for idempotency",
    pass: Boolean(
      firstId && secondId && firstId !== secondId &&
      uuidPattern.test(firstId) && uuidPattern.test(secondId)
    ),
    detail: `${String(firstId)}/${String(secondId)}`,
  };
}

async function runCallerMutationIsolationCheck(): Promise<CheckResult> {
  resetRuntime();
  const store = new BlockingMissMemoryStore();
  const actorConfig = structuredClone(ACTOR_CONFIG) as ActorConfig;
  const skillConfig = structuredClone(HUMAN_INPUT_SKILL) as SkillConfig;
  const actorInput = { text: "original input" };
  const runtimeContext = { marker: "original context" };
  const runPromise = actorRuntime.run({
    actorConfig,
    skillConfig,
    input: actorInput,
    runtimeContext,
    runtimeOptions: { memoryStore: store },
  });
  await store.waitUntilStarted();
  actorConfig.memory.push("MUTATED_AFTER_PREFLIGHT");
  skillConfig.steps[0].prompt = "mutated prompt";
  actorInput.text = "mutated input";
  runtimeContext.marker = "mutated context";
  store.release();
  const waiting = await runPromise;
  const pending = actorRuntime.dumpPendingRun(waiting.actorRunId);
  const leakedMemory = memoryService.dumpOrganizationSnapshot(
    ACTOR_CONFIG.organization_id
  ).memories.some((memory) => memory.content === "MUTATED_AFTER_PREFLIGHT");
  actorRuntime.clearRun(waiting.actorRunId);
  return {
    label: "run detaches caller data before the first async boundary",
    pass: Boolean(
      pending &&
      pending.pendingHumanInput?.prompt === "请确认是否继续。" &&
      pending.context.input.text === "original input" &&
      pending.context.runtimeContext.marker === "original context" &&
      !leakedMemory
    ),
    detail: `${pending?.pendingHumanInput?.prompt}/${String(pending?.context.input.text)}/${String(pending?.context.runtimeContext.marker)}/leaked=${leakedMemory}`,
  };
}

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("  ForeverThinking v0.5.0 — Continuation Validation Hardening Demo");
  console.log("=".repeat(72));
  console.log();

  const results: ScenarioResult[] = [];
  for (const spec of SCENARIOS) {
    console.log(`▶ ${spec.label}: wrong type → wrong request id → valid retry`);
    const result = await runScenario(spec);
    results.push(result);
    console.log(`  ${result.waiting.status} → ${result.wrongType.status} → ${result.wrongRequestId.status} → ${result.completed.status}`);
    console.log();
  }

  const toolApproval = results.find((result) => result.spec.pendingKind === "tool_approval");
  if (!toolApproval) throw new Error("Expected tool approval scenario");

  console.log("▶ malformed approval payloads remain retry-safe");
  const invalidApproval = await runInvalidApprovalScenario();
  console.log(`  invalid=${invalidApproval.invalidOutputs.length} → ${invalidApproval.completed.status}`);
  console.log();

  console.log("▶ Tool approval terminal cleanup: reject / throw / error observation");
  const toolTerminalResults: ToolTerminalResult[] = [];
  for (const mode of ["reject", "throw", "error_observation"] as const) {
    toolTerminalResults.push(await runToolTerminalScenario(mode));
  }
  console.log(`  ${toolTerminalResults.map((result) => `${result.mode}:${result.output.status}`).join(" / ")}`);
  console.log();

  console.log("▶ non-JSON continuation values remain pending and retryable");
  const jsonSafetyResult = await runJsonSafetyScenario();
  console.log(`  human=${jsonSafetyResult.humanInvalidStatus} / external=${jsonSafetyResult.externalInvalidStatus}`);
  console.log();

  console.log("▶ clearRun is rejected while a continuation is in flight");
  const inFlightClearResult = await runInFlightClearScenario();
  console.log(`  clearRejected=${inFlightClearResult.clearRejected} → ${inFlightClearResult.completedStatus}`);
  console.log();

  console.log("▶ concurrent continuation is serialized per Actor run");
  const mutexResult = await runContinuationMutexScenario();
  console.log(`  outputs=${mutexResult.outputs.map((output) => output.status).join(",")}`);
  console.log();

  const modifiedArgumentChecks = await runModifiedArgumentSchemaScenario();
  const defensiveCloneChecks = await runDefensiveCloneScenario();
  const foreignRuntimeChecks = await runForeignRuntimeClearScenario();
  const emptyApprovalIdCheck = await runEmptyApprovalIdScenario();
  const preflightSideEffectChecks = await runPreflightSideEffectChecks();
  const toolCallIdUniquenessCheck = await runToolCallIdUniquenessCheck();
  const callerMutationIsolationCheck = await runCallerMutationIsolationCheck();
  const approvalPolicyDriftChecks = await runApprovalPolicyDriftChecks();

  const checks = [
    ...results.flatMap(scenarioChecks),
    {
      label: "tool approval: invalid attempts execute no tool",
      pass: toolApproval.toolExecutionsBeforeRetry === 0,
      detail: `executionsBeforeRetry=${toolApproval.toolExecutionsBeforeRetry}`,
    },
    {
      label: "tool approval: valid retry executes tool exactly once",
      pass: toolApproval.toolExecutionsAfterRetry === 1,
      detail: `executionsAfterRetry=${toolApproval.toolExecutionsAfterRetry}`,
    },
    ...invalidApprovalChecks(invalidApproval),
    ...toolTerminalResults.flatMap(toolTerminalChecks),
    ...jsonSafetyChecks(jsonSafetyResult),
    ...inFlightClearChecks(inFlightClearResult),
    ...mutexChecks(mutexResult),
    ...modifiedArgumentChecks,
    ...defensiveCloneChecks,
    ...foreignRuntimeChecks,
    emptyApprovalIdCheck,
    ...preflightSideEffectChecks,
    toolCallIdUniquenessCheck,
    callerMutationIsolationCheck,
    ...approvalPolicyDriftChecks,
  ] satisfies CheckResult[];

  console.log("=".repeat(72));
  console.log(`  Continuation Validation 验收检查 (${checks.length} 条)`);
  console.log("=".repeat(72));

  let passCount = 0;
  for (const [index, check] of checks.entries()) {
    if (check.pass) passCount += 1;
    console.log(`  ${check.pass ? "✅" : "❌"} ${String(index + 1).padStart(2, "0")}. ${check.label}`);
    console.log(`      ${check.detail}`);
  }

  console.log();
  console.log(`  通过: ${passCount}/${checks.length}`);
  if (passCount !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error("Continuation Validation Demo 执行失败:", error);
  process.exit(1);
});
