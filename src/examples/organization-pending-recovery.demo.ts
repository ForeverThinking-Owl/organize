import { approvalGate } from "../approvals/approval-gate";
import type { ActorConfig } from "../core/types/actor";
import type { SkillConfig } from "../core/types/skill";
import type { ToolCallRequest, ToolDefinition, ToolObservation } from "../core/types/tool";
import { memoryService } from "../memory/memory-service";
import type { OrganizationCapability } from "../organization/organization-permission";
import { OrganizationError } from "../organization/organization-error";
import { OrganizationRuntime } from "../organization/organization-runtime";
import { actorRuntime, type ActorContinueEvent } from "../runtime/actor-runtime";
import type { PendingRunKind } from "../runtime/pending-run-snapshot";
import type { MockToolExecutor } from "../tools/mock-tools";
import { toolGateway } from "../tools/tool-gateway";
import { traceLogger } from "../trace/trace-logger";

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

const TOOL: ToolDefinition = {
  toolName: "organization_recovery_governed_tool",
  description: "Governed tool for Organization pending-kind recovery",
  direction: "write",
  riskLevel: "high",
  approvalPolicy: {
    beforeCall: {
      requiredWhen: [{ field: "mode", operator: "==", value: "governed" }],
      allowModifyArguments: true,
      allowReject: true,
      allowComment: true,
    },
  },
};

class RecoveryToolExecutor implements MockToolExecutor {
  executions = 0;

  async execute(request: ToolCallRequest): Promise<ToolObservation> {
    this.executions += 1;
    return {
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      status: "success",
      data: { execution: this.executions },
      executedAt: new Date().toISOString(),
    };
  }
}

const SKILLS: Record<PendingRunKind, SkillConfig> = {
  human_input: {
    skill_id: "recover_human",
    name: "Recover Human Input",
    steps: [
      { step_key: "wait", type: "human_input", prompt: "Provide input", output_key: "input" },
      { step_key: "return", type: "return", output_mapping: { value: "{{outputs.input}}" } },
    ],
  },
  skill_approval: {
    skill_id: "recover_skill_approval",
    name: "Recover Skill Approval",
    steps: [
      {
        step_key: "wait",
        type: "wait_approval",
        approval_request_id: "organization_skill_approval",
        reason: "Independent approval required",
        output_key: "approval",
      },
      { step_key: "return", type: "return", output_mapping: { value: "{{outputs.approval.decision}}" } },
    ],
  },
  tool_approval: {
    skill_id: "recover_tool_approval",
    name: "Recover Tool Approval",
    steps: [
      {
        step_key: "tool",
        type: "tool_call",
        tool_name: TOOL.toolName,
        input_mapping: { mode: "governed" },
        output_key: "tool_result",
      },
      { step_key: "return", type: "return", output_mapping: { value: "{{outputs.tool_result.execution}}" } },
    ],
  },
  external_event: {
    skill_id: "recover_external",
    name: "Recover External Event",
    steps: [
      {
        step_key: "wait",
        type: "wait_external_event",
        event_name: "organization.recovery.ready",
        correlation_key: "{{context.correlation_id}}",
        output_key: "event",
        event_schema: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "string" } },
        },
      },
      { step_key: "return", type: "return", output_mapping: { value: "{{outputs.event.payload.value}}" } },
    ],
  },
};

const CAPABILITIES: OrganizationCapability[] = [
  "organization:manage",
  "task:create",
  "task:assign",
  "task:execute",
  "message:send",
  "message:receive",
  "organization:snapshot",
  "approval:decide",
  "event:receive",
];

function config(organizationId: string, actorId: string): ActorConfig {
  return {
    actor_id: actorId,
    organization_id: organizationId,
    name: actorId,
    type: "ai",
    role: actorId,
    responsibility: "Recover every Organization pending kind",
    autonomy_level: "L3_low_risk_execute",
    memory: [`${organizationId}:${actorId}:pending-recovery`],
    permissions: {
      allowed_tools: [TOOL.toolName],
      denied_tools: [],
      allowed_skills: Object.values(SKILLS).map((skill) => skill.skill_id),
    },
    approval_judgment: {
      must_request_approval_when: [],
      can_approve: [{ tool_name: TOOL.toolName }],
    },
  };
}

function continuationEvent(
  kind: PendingRunKind,
  pending: NonNullable<ReturnType<typeof actorRuntime.dumpPendingRun>>
): ActorContinueEvent {
  switch (kind) {
    case "human_input":
      return {
        type: "human_input_response",
        response: {
          humanInputRequestId: pending.pendingHumanInput!.humanInputRequestId,
          value: "human-restored",
          respondedBy: "worker",
        },
      };
    case "skill_approval":
      return {
        type: "approval_decision",
        decision: {
          approvalRequestId: pending.pendingSkillApproval!.approvalRequestId,
          decision: "approve",
          decidedBy: "manager",
          decidedAt: new Date().toISOString(),
        },
      };
    case "tool_approval":
      return {
        type: "approval_decision",
        decision: {
          approvalRequestId: pending.pendingToolApproval!.approvalRequest.approvalRequestId,
          decision: "approve",
          decidedBy: "manager",
          decidedAt: new Date().toISOString(),
        },
      };
    case "external_event":
      return {
        type: "external_event_received",
        event: {
          externalEventRequestId: pending.pendingExternalEvent!.externalEventRequestId,
          eventName: pending.pendingExternalEvent!.eventName,
          correlationKey: pending.pendingExternalEvent!.correlationKey,
          payload: { value: "external-restored" },
          receivedBy: "manager",
        },
      };
  }
}

async function runRecoveryCase(kind: PendingRunKind): Promise<CheckResult[]> {
  const runtime = new OrganizationRuntime(actorRuntime);
  const organizationId = `org_pending_${kind}`;
  runtime.createOrganization({ organizationId, name: `Pending ${kind}` });
  runtime.registerActor(organizationId, {
    actorConfig: config(organizationId, "manager"),
    skills: Object.values(SKILLS),
    capabilities: CAPABILITIES,
  });
  runtime.registerActor(organizationId, {
    actorConfig: config(organizationId, "worker"),
    skills: Object.values(SKILLS),
    capabilities: CAPABILITIES,
  }, "manager");

  const task = runtime.createTask({
    organizationId,
    requestedByActorId: "manager",
    title: `Recover ${kind}`,
    input: { text: kind },
    runtimeContext: { correlation_id: `correlation-${kind}` },
  });
  runtime.assignTask({
    organizationId,
    requestedByActorId: "manager",
    taskId: task.taskId,
    actorId: "worker",
    skillId: SKILLS[kind].skill_id,
  });
  runtime.enqueueTask({ organizationId, requestedByActorId: "manager", taskId: task.taskId });
  const waiting = await runtime.dispatchNext({ organizationId });
  if (!waiting) throw new Error(`Expected ${kind} waiting run`);
  const before = actorRuntime.dumpPendingRun(waiting.output.actorRunId);
  if (!before) throw new Error(`Expected ${kind} pending snapshot`);

  const snapshot = runtime.dumpSnapshot({ organizationId, requestedByActorId: "manager" });
  runtime.clearOrganization(organizationId);
  const cold =
    actorRuntime.dumpPendingRun(waiting.output.actorRunId) === null &&
    traceLogger.getTrace(waiting.output.actorRunId) === undefined;

  let forgedPolicyRejected: boolean | null = null;
  if (kind === "tool_approval") {
    const forgedPolicy = structuredClone(snapshot);
    const approval = forgedPolicy.runtimeRecovery?.pendingRuns[0]?.pendingToolApproval?.approvalRequest;
    if (!approval) throw new Error("Expected Tool approval in Organization snapshot");
    approval.reason = "low risk and safe";
    try {
      runtime.restoreSnapshot(forgedPolicy);
      forgedPolicyRejected = false;
    } catch {
      forgedPolicyRejected = true;
    } finally {
      runtime.clearOrganization(organizationId);
    }
  }

  runtime.restoreSnapshot(snapshot);
  const restored = actorRuntime.dumpPendingRun(waiting.output.actorRunId);
  if (!restored) throw new Error(`Expected restored ${kind} pending run`);
  const requestedByActorId = kind === "human_input" ? "worker" : "manager";
  const completed = await runtime.continueTask({
    organizationId,
    requestedByActorId,
    taskId: task.taskId,
    event: continuationEvent(kind, restored),
  });

  const checks: CheckResult[] = [
    {
      label: `${kind}: snapshot captures the expected pending kind`,
      pass: before.pendingKind === kind && snapshot.runtimeRecovery?.pendingRuns.length === 1,
      detail: `${before.pendingKind}/${snapshot.runtimeRecovery?.pendingRuns.length}`,
    },
    {
      label: `${kind}: clear produces a cold run boundary`,
      pass: cold,
      detail: String(cold),
    },
    {
      label: `${kind}: restore preserves Task and Actor run binding`,
      pass:
        restored.pendingKind === kind &&
        runtime.getTask(organizationId, task.taskId).actorRunId === waiting.output.actorRunId,
      detail: `${restored.pendingKind}/${restored.actorRunId}`,
    },
    {
      label: `${kind}: restored run continues to completion`,
      pass:
        completed.task.status === "completed" &&
        completed.output.actorRunId === waiting.output.actorRunId,
      detail: `${completed.task.status}/${completed.output.actorRunId}`,
    },
  ];
  if (forgedPolicyRejected !== null) {
    checks.push({
      label: `${kind}: restore rejects forged Tool approval policy metadata`,
      pass: forgedPolicyRejected,
      detail: String(forgedPolicyRejected),
    });
  }
  runtime.clearOrganization(organizationId);
  return checks;
}

async function runConstrainedApprovalCase(): Promise<CheckResult[]> {
  const runtime = new OrganizationRuntime(actorRuntime);
  const organizationId = "org_pending_constrained_approval";
  runtime.createOrganization({ organizationId, name: "Constrained Approval" });
  const managerConfig = config(organizationId, "manager");
  managerConfig.approval_judgment.can_approve = [{
    tool_name: TOOL.toolName,
    conditions: [{ field: "mode", operator: "==", value: "governed" }],
    must_escalate_when: [{ field: "mode", operator: "==", value: "escalate" }],
  }];
  runtime.registerActor(organizationId, {
    actorConfig: managerConfig,
    skills: Object.values(SKILLS),
    capabilities: CAPABILITIES,
  });
  runtime.registerActor(organizationId, {
    actorConfig: config(organizationId, "worker"),
    skills: Object.values(SKILLS),
    capabilities: CAPABILITIES,
  }, "manager");
  const task = runtime.createTask({
    organizationId,
    requestedByActorId: "manager",
    title: "Constrained Tool approval",
    input: { text: "constrained" },
  });
  runtime.assignTask({
    organizationId,
    requestedByActorId: "manager",
    taskId: task.taskId,
    actorId: "worker",
    skillId: SKILLS.tool_approval.skill_id,
  });
  runtime.enqueueTask({ organizationId, requestedByActorId: "manager", taskId: task.taskId });
  const waiting = await runtime.dispatchNext({ organizationId });
  const pending = waiting && actorRuntime.dumpPendingRun(waiting.output.actorRunId);
  if (!waiting || !pending?.pendingToolApproval) {
    throw new Error("Expected constrained Tool approval");
  }
  const requestId = pending.pendingToolApproval.approvalRequest.approvalRequestId;
  const attemptModified = async (mode: string): Promise<boolean> => {
    try {
      await runtime.continueTask({
        organizationId,
        requestedByActorId: "manager",
        taskId: task.taskId,
        event: {
          type: "approval_decision",
          decision: {
            approvalRequestId: requestId,
            decision: "approve_with_modified_arguments",
            modifiedArguments: { mode },
            decidedAt: new Date().toISOString(),
          },
        },
      });
      return false;
    } catch (error) {
      return error instanceof OrganizationError && error.code === "permission_denied";
    }
  };
  const outsideAuthorityRejected = await attemptModified("outside");
  const escalationBypassRejected = await attemptModified("escalate");
  const stillPending =
    actorRuntime.dumpPendingRun(waiting.output.actorRunId)?.pendingKind === "tool_approval" &&
    runtime.getTask(organizationId, task.taskId).status === "waiting_approval";
  const completed = await runtime.continueTask({
    organizationId,
    requestedByActorId: "manager",
    taskId: task.taskId,
    event: continuationEvent(
      "tool_approval",
      actorRuntime.dumpPendingRun(waiting.output.actorRunId)!
    ),
  });
  runtime.clearOrganization(organizationId);
  return [
    {
      label: "Tool approver conditions evaluate effective modified arguments",
      pass: outsideAuthorityRejected,
      detail: String(outsideAuthorityRejected),
    },
    {
      label: "Tool approver cannot bypass must_escalate_when with modified arguments",
      pass: escalationBypassRejected,
      detail: String(escalationBypassRejected),
    },
    {
      label: "rejected constrained approvals preserve pending state for a valid retry",
      pass: stillPending && completed.task.status === "completed",
      detail: `${stillPending}/${completed.task.status}`,
    },
  ];
}

async function main(): Promise<void> {
  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
  const toolExecutor = new RecoveryToolExecutor();
  toolGateway.registerDefinition(TOOL);
  toolGateway.registerExecutor(TOOL.toolName, toolExecutor);

  const kinds: PendingRunKind[] = [
    "human_input",
    "skill_approval",
    "tool_approval",
    "external_event",
  ];
  const checks = (await Promise.all(kinds.map(runRecoveryCase))).flat();
  checks.push(...await runConstrainedApprovalCase());
  checks.push({
    label: "each accepted Tool approval executes once across both scenarios",
    pass: toolExecutor.executions === 2,
    detail: String(toolExecutor.executions),
  });

  console.log("=".repeat(72));
  console.log(`  ForeverThinking v0.5.0 — Organization Pending Recovery (${checks.length} checks)`);
  console.log("=".repeat(72));
  let passed = 0;
  checks.forEach((check, index) => {
    if (check.pass) passed++;
    console.log(`${check.pass ? "✅" : "❌"} ${String(index + 1).padStart(2, "0")}. ${check.label}`);
    console.log(`    ${check.detail}`);
  });
  console.log(`Passed: ${passed}/${checks.length}`);
  if (passed !== checks.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Organization Pending Recovery Demo failed:", error);
  process.exit(1);
});
