// ============================================================================
// tool-approval-fail-closed.demo.ts — v0.5.1
// Security regression: unimplemented Tool approval stages must fail closed.
// ============================================================================

import { actorRuntime } from "../runtime/actor-runtime";
import { approvalGate } from "../approvals/approval-gate";
import { memoryService } from "../memory/memory-service";
import { traceLogger } from "../trace/trace-logger";
import { ToolGateway, toolGateway } from "../tools/tool-gateway";
import type { MockToolExecutor } from "../tools/mock-tools";
import type {
  ToolApprovalPolicy,
  ToolCallRequest,
  ToolDefinition,
  ToolObservation,
} from "../core/types/tool";

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

interface RejectedScenarioResult {
  name: string;
  stage: "afterCall" | "beforeWriteback";
  registrationError: string;
  executionError: string;
  definitionRegistered: boolean;
  executorCalls: number;
  toolCallStarts: number;
}

class CountingExecutor implements MockToolExecutor {
  calls = 0;

  constructor(private readonly toolName: string) {}

  async execute(request: ToolCallRequest): Promise<ToolObservation> {
    this.calls += 1;
    return {
      toolCallId: request.toolCallId,
      toolName: this.toolName,
      status: "success",
      data: { executed: true },
      executedAt: new Date().toISOString(),
    };
  }
}

class BlockingExecutor implements MockToolExecutor {
  calls = 0;
  private signalStarted!: () => void;
  private signalReleased!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.signalStarted = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.signalReleased = resolve;
  });

  release(): void {
    this.signalReleased();
  }

  async execute(request: ToolCallRequest): Promise<ToolObservation> {
    this.calls += 1;
    this.signalStarted();
    await this.released;
    return {
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      status: "success",
      data: { executed: true },
      executedAt: new Date().toISOString(),
    };
  }
}

function toolDefinition(toolName: string, approvalPolicy: ToolApprovalPolicy): ToolDefinition {
  return {
    toolName,
    description: `Security regression Tool: ${toolName}`,
    direction: "write",
    riskLevel: "high",
    inputSchema: {
      type: "object",
      required: ["amount"],
      properties: { amount: { type: "number" } },
    },
    approvalPolicy,
  };
}

function toolCall(toolName: string): ToolCallRequest {
  return {
    toolCallId: `call_${toolName}`,
    toolName,
    arguments: { amount: 150 },
    actorId: "approval_security_actor",
    actorRunId: `run_${toolName}`,
    stepKey: "governed_write",
  };
}

async function rejectedScenario(
  name: string,
  stage: RejectedScenarioResult["stage"],
  approvalPolicy: ToolApprovalPolicy
): Promise<RejectedScenarioResult> {
  const gateway = new ToolGateway();
  const executor = new CountingExecutor(name);
  gateway.registerExecutor(name, executor);

  let registrationError = "";
  try {
    gateway.registerDefinition(toolDefinition(name, approvalPolicy));
  } catch (error) {
    registrationError = error instanceof Error ? error.message : String(error);
  }

  let executionError = "";
  const actorRunId = `run_${name}`;
  traceLogger.startRun(actorRunId, "approval_security_actor", "tool_approval_fail_closed");
  try {
    await gateway.execute(toolCall(name), actorRunId);
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
  }
  const toolCallStarts =
    traceLogger
      .getTrace(actorRunId)
      ?.events.filter((event) => event.eventType === "tool_call_start").length ?? 0;

  return {
    name,
    stage,
    registrationError,
    executionError,
    definitionRegistered: gateway.getDefinition(name) !== undefined,
    executorCalls: executor.calls,
    toolCallStarts,
  };
}

const BEFORE_CALL_POLICY = {
  requiredWhen: [{ field: "amount", operator: ">=" as const, value: 100 }],
  allowReject: true,
  allowComment: true,
};

async function runRejectedScenarios(): Promise<RejectedScenarioResult[]> {
  return Promise.all([
    rejectedScenario("after_call_only", "afterCall", {
      afterCall: { allowComment: true },
    }),
    rejectedScenario("before_writeback_only", "beforeWriteback", {
      beforeWriteback: {},
    }),
    rejectedScenario("before_and_after_call", "afterCall", {
      beforeCall: BEFORE_CALL_POLICY,
      afterCall: {},
    }),
    rejectedScenario("before_and_before_writeback", "beforeWriteback", {
      beforeCall: BEFORE_CALL_POLICY,
      beforeWriteback: { allowReject: true },
    }),
  ]);
}

async function runMalformedRequestScenario() {
  const toolName = "malformed_request";
  const actorRunId = `run_${toolName}`;
  const gateway = new ToolGateway();
  const executor = new CountingExecutor(toolName);
  gateway.registerDefinition(toolDefinition(toolName, {}));
  gateway.registerExecutor(toolName, executor);
  traceLogger.startRun(actorRunId, "approval_security_actor", "tool_approval_fail_closed");

  let executionError = "";
  try {
    await gateway.execute(
      {
        ...toolCall(toolName),
        arguments: { amount: 150, unsafe: undefined },
      },
      actorRunId
    );
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
  }

  const events = traceLogger.getTrace(actorRunId)?.events ?? [];
  return {
    executionError,
    executorCalls: executor.calls,
    toolCallStarts: events.filter((event) => event.eventType === "tool_call_start").length,
  };
}

async function runMissingExecutorScenario() {
  const toolName = "missing_executor";
  const actorRunId = `run_${toolName}`;
  const gateway = new ToolGateway();
  gateway.registerDefinition(toolDefinition(toolName, {}));
  traceLogger.startRun(actorRunId, "approval_security_actor", "tool_approval_fail_closed");

  const observation = await gateway.execute(toolCall(toolName), actorRunId);
  const events = traceLogger.getTrace(actorRunId)?.events ?? [];
  return {
    observation,
    toolCallStarts: events.filter((event) => event.eventType === "tool_call_start").length,
    toolCallEnds: events.filter((event) => event.eventType === "tool_call_end").length,
    toolObservations: events.filter((event) => event.eventType === "tool_observation").length,
  };
}

async function runCallerMutationScenario() {
  const toolName = "caller_mutation";
  const actorRunId = `run_${toolName}`;
  const gateway = new ToolGateway();
  const executor = new BlockingExecutor();
  gateway.registerDefinition(toolDefinition(toolName, {}));
  gateway.registerExecutor(toolName, executor);
  traceLogger.startRun(actorRunId, "approval_security_actor", "tool_approval_fail_closed");

  const request = toolCall(toolName);
  const execution = gateway.execute(request, actorRunId);
  await executor.started;
  request.toolName = "mutated_after_start";
  request.toolCallId = "mutated_call_id";
  request.arguments.amount = 999;
  executor.release();
  const observation = await execution;

  const events = traceLogger.getTrace(actorRunId)?.events ?? [];
  const start = events.find((event) => event.eventType === "tool_call_start");
  const end = events.find((event) => event.eventType === "tool_call_end");
  const recordedObservation = events.find(
    (event) => event.eventType === "tool_observation"
  );
  return { toolName, executor, observation, start, end, recordedObservation };
}

async function runSupportedBeforeCallScenario() {
  const toolName = "governed_write_v051";
  const executor = new CountingExecutor(toolName);
  const definition = toolDefinition(toolName, { beforeCall: BEFORE_CALL_POLICY });

  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
  toolGateway.registerDefinition(definition);
  toolGateway.registerExecutor(toolName, executor);

  const waiting = await actorRuntime.run({
    actorConfig: {
      actor_id: "approval_security_actor",
      organization_id: "approval_security_org",
      unit_id: "approval_security_unit",
      name: "Approval Security Actor",
      type: "ai",
      role: "security_test",
      responsibility: "Verify fail-closed Tool approval governance",
      autonomy_level: "L4_governed_execute",
      memory: [],
      permissions: {
        allowed_tools: [toolName],
        denied_tools: [],
        allowed_skills: ["tool_approval_fail_closed"],
      },
      approval_judgment: { must_request_approval_when: ["high-risk writes"] },
    },
    skillConfig: {
      skill_id: "tool_approval_fail_closed",
      name: "Tool approval fail-closed security regression",
      owner_actor_id: "approval_security_actor",
      steps: [
        {
          step_key: "governed_write",
          type: "tool_call",
          tool_name: toolName,
          input_mapping: { amount: "{{context.amount}}" },
          output_key: "write_result",
        },
        {
          step_key: "return",
          type: "return",
          output_mapping: { executed: "{{outputs.write_result.executed}}" },
        },
      ],
    },
    input: { text: "Execute a governed high-risk write." },
    runtimeContext: { amount: 150 },
  });

  const callsWhileWaiting = executor.calls;
  const pending = waiting.pendingApproval;
  const completed = pending
    ? await actorRuntime.continue(waiting.actorRunId, {
        type: "approval_decision",
        decision: {
          approvalRequestId: pending.approvalRequestId,
          decision: "approve",
          comment: "Security regression approval",
          decidedBy: "security_reviewer",
          decidedAt: new Date().toISOString(),
        },
      })
    : waiting;

  const events = traceLogger.getTrace(waiting.actorRunId)?.events ?? [];
  return {
    definition: toolGateway.getDefinition(toolName),
    waiting,
    completed,
    callsWhileWaiting,
    finalExecutorCalls: executor.calls,
    approvalRequested: events.find((event) => event.eventType === "approval_requested"),
  };
}

async function main(): Promise<void> {
  console.log("=".repeat(68));
  console.log("  v0.5.1 Tool Approval Fail-Closed Security Regression");
  console.log("=".repeat(68));

  const rejected = await runRejectedScenarios();
  const malformedRequest = await runMalformedRequestScenario();
  const missingExecutor = await runMissingExecutorScenario();
  const callerMutation = await runCallerMutationScenario();
  const supported = await runSupportedBeforeCallScenario();
  const checks: CheckResult[] = [];

  for (const scenario of rejected) {
    checks.push({
      label: `${scenario.name} registration is rejected`,
      pass:
        scenario.registrationError.includes(`approvalPolicy.${scenario.stage}`) &&
        scenario.registrationError.includes("is not implemented") &&
        !scenario.definitionRegistered,
      detail: scenario.registrationError || "registration unexpectedly succeeded",
    });
  }

  checks.push(
    {
      label: "Rejected definitions cannot reach any executor",
      pass: rejected.every((scenario) => scenario.executorCalls === 0),
      detail: rejected.map((scenario) => `${scenario.name}=${scenario.executorCalls}`).join(", "),
    },
    {
      label: "Rejected definitions cannot emit a false tool_call_start",
      pass: rejected.every((scenario) => scenario.toolCallStarts === 0),
      detail: rejected.map((scenario) => `${scenario.name}=${scenario.toolCallStarts}`).join(", "),
    },
    {
      label: "Rejected definitions remain unavailable for execution",
      pass: rejected.every(
        (scenario) =>
          !scenario.definitionRegistered &&
          scenario.executionError.includes("has no registered definition")
      ),
      detail: rejected.map((scenario) => scenario.executionError).join(" | "),
    },
    {
      label: "Malformed requests fail before executor and tool_call_start",
      pass:
        malformedRequest.executionError.includes("is not JSON-safe") &&
        malformedRequest.executorCalls === 0 &&
        malformedRequest.toolCallStarts === 0,
      detail:
        `error=${malformedRequest.executionError}, executorCalls=${malformedRequest.executorCalls}, ` +
        `toolCallStarts=${malformedRequest.toolCallStarts}`,
    },
    {
      label: "Missing executor reports an observation without a false call lifecycle",
      pass:
        missingExecutor.observation.status === "error" &&
        missingExecutor.observation.error?.includes("No executor found") === true &&
        missingExecutor.toolCallStarts === 0 &&
        missingExecutor.toolCallEnds === 0 &&
        missingExecutor.toolObservations === 1,
      detail:
        `status=${missingExecutor.observation.status}, starts=${missingExecutor.toolCallStarts}, ` +
        `ends=${missingExecutor.toolCallEnds}, observations=${missingExecutor.toolObservations}`,
    },
    {
      label: "Caller mutation cannot split Tool lifecycle identity",
      pass:
        callerMutation.executor.calls === 1 &&
        callerMutation.start?.data.toolName === callerMutation.toolName &&
        callerMutation.start.data.toolCallId === `call_${callerMutation.toolName}` &&
        (callerMutation.start.data.arguments as Record<string, unknown>).amount === 150 &&
        callerMutation.end?.data.toolName === callerMutation.toolName &&
        callerMutation.observation.toolName === callerMutation.toolName &&
        callerMutation.observation.toolCallId === `call_${callerMutation.toolName}` &&
        callerMutation.recordedObservation?.data.toolName === callerMutation.toolName &&
        callerMutation.recordedObservation.data.toolCallId ===
          `call_${callerMutation.toolName}`,
      detail:
        `start=${JSON.stringify(callerMutation.start?.data ?? null)}, ` +
        `end=${JSON.stringify(callerMutation.end?.data ?? null)}, ` +
        `observation=${JSON.stringify(callerMutation.recordedObservation?.data ?? null)}`,
    },
    {
      label: "beforeCall-only policy still registers with its policy intact",
      pass:
        supported.definition?.approvalPolicy?.beforeCall?.requiredWhen?.[0]?.field === "amount" &&
        supported.definition.approvalPolicy.beforeCall.requiredWhen[0]?.operator === ">=",
      detail: JSON.stringify(supported.definition?.approvalPolicy ?? null),
    },
    {
      label: "Matching beforeCall policy still suspends for Tool approval",
      pass:
        supported.waiting.status === "waiting_approval" &&
        supported.waiting.pendingApproval?.approvalKind === "tool_call" &&
        supported.waiting.pendingApproval.toolName === "governed_write_v051",
      detail: `status=${supported.waiting.status}, pending=${JSON.stringify(supported.waiting.pendingApproval ?? null)}`,
    },
    {
      label: "beforeCall executor invocation remains zero while approval is pending",
      pass: supported.callsWhileWaiting === 0,
      detail: `executorCalls=${supported.callsWhileWaiting}`,
    },
    {
      label: "Approval request retains the canonical before_call stage",
      pass: supported.approvalRequested?.data.stage === "before_call",
      detail: JSON.stringify(supported.approvalRequested?.data ?? null),
    },
    {
      label: "Approved beforeCall flow completes and executes exactly once",
      pass:
        supported.completed.status === "completed" &&
        supported.completed.result?.executed === true &&
        supported.finalExecutorCalls === 1,
      detail: `status=${supported.completed.status}, result=${JSON.stringify(supported.completed.result)}, executorCalls=${supported.finalExecutorCalls}`,
    }
  );

  let passCount = 0;
  for (const [index, check] of checks.entries()) {
    if (check.pass) passCount += 1;
    console.log(`  ${check.pass ? "✅" : "❌"} ${String(index + 1).padStart(2, "0")}. ${check.label}`);
    console.log(`      ${check.detail}`);
  }

  console.log("-".repeat(68));
  console.log(`  Passed: ${passCount}/${checks.length}`);
  if (passCount !== checks.length) {
    throw new Error(`${checks.length - passCount} Tool approval security checks failed`);
  }
  console.log("  Tool approval stage governance fails closed; beforeCall is unchanged.");
}

main().catch((error) => {
  console.error("Tool Approval Fail-Closed Demo failed:", error);
  process.exit(1);
});
