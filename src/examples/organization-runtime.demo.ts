import { approvalGate } from "../approvals/approval-gate";
import type { ActorConfig } from "../core/types/actor";
import type { SkillConfig } from "../core/types/skill";
import { memoryService } from "../memory/memory-service";
import { OrganizationError } from "../organization/organization-error";
import { OrganizationRuntime } from "../organization/organization-runtime";
import type { OrganizationCapability } from "../organization/organization-permission";
import { actorRuntime } from "../runtime/actor-runtime";
import { traceLogger } from "../trace/trace-logger";

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

const ALL_CAPABILITIES: OrganizationCapability[] = [
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

const COMPLETE_SKILL: SkillConfig = {
  skill_id: "complete_task",
  name: "Complete Organization Task",
  steps: [
    {
      step_key: "return",
      type: "return",
      output_mapping: {
        status: "completed",
        organization_id: "{{context.organization_id}}",
        task_id: "{{context.organization_task_id}}",
        request: "{{context.request}}",
        input_value: "{{context.inputValue}}",
      },
    },
  ],
};

const REVIEW_SKILL: SkillConfig = {
  skill_id: "wait_for_review",
  name: "Wait For Review",
  steps: [
    {
      step_key: "review",
      type: "human_input",
      prompt: "Please review the organization task.",
      output_key: "review",
    },
    {
      step_key: "return",
      type: "return",
      output_mapping: {
        status: "reviewed",
        review: "{{outputs.review}}",
        task_id: "{{context.organization_task_id}}",
      },
    },
  ],
};

const APPROVAL_SKILL: SkillConfig = {
  skill_id: "wait_for_approval",
  name: "Wait For Independent Approval",
  steps: [
    {
      step_key: "approval",
      type: "wait_approval",
      reason: "A different actor must approve this task.",
      output_key: "approval",
    },
    {
      step_key: "return",
      type: "return",
      output_mapping: {
        status: "approved",
        decision: "{{outputs.approval.decision}}",
        decided_by: "{{outputs.approval.decidedBy}}",
      },
    },
  ],
};

function actorConfig(
  organizationId: string,
  actorId: string,
  allowedSkills: string[]
): ActorConfig {
  return {
    actor_id: actorId,
    organization_id: organizationId,
    name: actorId,
    type: "ai",
    role: actorId,
    responsibility: "Execute organization tasks",
    autonomy_level: "L3_low_risk_execute",
    memory: [],
    permissions: {
      allowed_tools: [],
      denied_tools: [],
      allowed_skills: allowedSkills,
    },
    approval_judgment: { must_request_approval_when: [] },
  };
}

function resetKernel(): void {
  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
}

function capturesError(fn: () => unknown, code?: string): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof OrganizationError && (!code || error.code === code);
  }
}

async function main(): Promise<void> {
  resetKernel();
  const runtime = new OrganizationRuntime(actorRuntime);
  const orgA = runtime.createOrganization({ organizationId: "org_alpha", name: "Alpha" });
  const orgB = runtime.createOrganization({ organizationId: "org_beta", name: "Beta" });

  runtime.registerActor(orgA.organizationId, {
    actorConfig: actorConfig(orgA.organizationId, "manager", ["complete_task"]),
    skills: [COMPLETE_SKILL],
    capabilities: ALL_CAPABILITIES,
  });
  runtime.registerActor(orgA.organizationId, {
    actorConfig: actorConfig(orgA.organizationId, "shared_actor", ["complete_task", "wait_for_review", "wait_for_approval"]),
    skills: [COMPLETE_SKILL, REVIEW_SKILL, APPROVAL_SKILL],
    capabilities: ALL_CAPABILITIES,
  }, "manager");
  runtime.registerActor(orgA.organizationId, {
    actorConfig: actorConfig(orgA.organizationId, "viewer", []),
    skills: [],
    capabilities: ["message:receive"],
  }, "manager");
  runtime.registerActor(orgB.organizationId, {
    actorConfig: actorConfig(orgB.organizationId, "shared_actor", ["complete_task"]),
    skills: [COMPLETE_SKILL],
    capabilities: ALL_CAPABILITIES,
  });

  const wrongOrganizationRejected = capturesError(() => runtime.registerActor(orgA.organizationId, {
    actorConfig: actorConfig(orgB.organizationId, "intruder", ["complete_task"]),
    skills: [COMPLETE_SKILL],
    capabilities: ALL_CAPABILITIES,
  }, "manager"), "cross_organization");
  const permissionDenied = capturesError(() => runtime.createTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "viewer",
    title: "Forbidden",
    input: { text: "forbidden" },
  }), "permission_denied");
  const unmanagedRegistrationDenied = capturesError(() => runtime.registerActor(orgA.organizationId, {
    actorConfig: actorConfig(orgA.organizationId, "self_granted_admin", ["complete_task"]),
    skills: [COMPLETE_SKILL],
    capabilities: ALL_CAPABILITIES,
  }), "permission_denied");
  const inboxReadDenied = capturesError(() => runtime.listInbox({
    organizationId: orgA.organizationId,
    requestedByActorId: "viewer",
    actorId: "shared_actor",
  }), "permission_denied");

  const created = runtime.createTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "manager",
    title: "Complete request",
    input: { text: "complete", payload: { inputValue: "forwarded" } },
    runtimeContext: { request: "alpha_request", organization_id: "spoofed" },
  });
  created.title = "tampered outside runtime";
  runtime.assignTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "manager",
    taskId: created.taskId,
    actorId: "shared_actor",
    skillId: "complete_task",
  });
  runtime.enqueueTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "manager",
    taskId: created.taskId,
  });
  const [firstDispatch, duplicateDispatch] = await Promise.all([
    runtime.dispatchNext({ organizationId: orgA.organizationId }),
    runtime.dispatchNext({ organizationId: orgA.organizationId }),
  ]);

  const waitingTask = runtime.createTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "manager",
    title: "Review request",
    input: { text: "review" },
  });
  runtime.assignTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "manager",
    taskId: waitingTask.taskId,
    actorId: "shared_actor",
    skillId: "wait_for_review",
  });
  runtime.enqueueTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "manager",
    taskId: waitingTask.taskId,
  });
  const waiting = await runtime.dispatchNext({ organizationId: orgA.organizationId });
  if (!waiting?.output.pendingHumanInput) throw new Error("Expected pending human input");
  let mismatchedContinueRejected = false;
  try {
    await runtime.continueTask({
      organizationId: orgA.organizationId,
      requestedByActorId: "shared_actor",
      taskId: waitingTask.taskId,
      event: {
        type: "approval_decision",
        decision: {
          approvalRequestId: "wrong_event_kind",
          decision: "approve",
          decidedBy: "shared_actor",
          decidedAt: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    mismatchedContinueRejected = error instanceof OrganizationError && error.code === "invalid_input";
  }
  const pendingAfterMismatchedContinue = actorRuntime.dumpPendingRun(waiting.output.actorRunId);
  const continued = await runtime.continueTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "shared_actor",
    taskId: waitingTask.taskId,
    event: {
      type: "human_input_response",
      response: {
        humanInputRequestId: waiting.output.pendingHumanInput.humanInputRequestId,
        value: "approved",
        respondedBy: "shared_actor",
      },
    },
  });

  const approvalTask = runtime.createTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "manager",
    title: "Independent approval",
    input: { text: "approve independently" },
  });
  runtime.assignTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "manager",
    taskId: approvalTask.taskId,
    actorId: "shared_actor",
    skillId: "wait_for_approval",
  });
  runtime.enqueueTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "manager",
    taskId: approvalTask.taskId,
  });
  const waitingApproval = await runtime.dispatchNext({ organizationId: orgA.organizationId });
  if (!waitingApproval?.output.pendingApproval) throw new Error("Expected pending approval");
  let selfApprovalDenied = false;
  try {
    await runtime.continueTask({
      organizationId: orgA.organizationId,
      requestedByActorId: "shared_actor",
      taskId: approvalTask.taskId,
      event: {
        type: "approval_decision",
        decision: {
          approvalRequestId: waitingApproval.output.pendingApproval.approvalRequestId,
          decision: "approve",
          decidedBy: "shared_actor",
          decidedAt: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    selfApprovalDenied = error instanceof OrganizationError && error.code === "permission_denied";
  }
  const pendingAfterSelfApproval = actorRuntime.dumpPendingRun(waitingApproval.output.actorRunId);
  const taskAfterSelfApproval = runtime.getTask(orgA.organizationId, approvalTask.taskId);
  const independentlyApproved = await runtime.continueTask({
    organizationId: orgA.organizationId,
    requestedByActorId: "manager",
    taskId: approvalTask.taskId,
    event: {
      type: "approval_decision",
      decision: {
        approvalRequestId: waitingApproval.output.pendingApproval.approvalRequestId,
        decision: "approve",
        decidedBy: "manager",
        decidedAt: new Date().toISOString(),
      },
    },
  });

  const messageOne = runtime.sendMessage({
    organizationId: orgA.organizationId,
    fromActorId: "manager",
    toActorId: "shared_actor",
    type: "information",
    payload: { secret: "payload_must_not_enter_trace", sequence: 1 },
  });
  const messageTwo = runtime.sendMessage({
    organizationId: orgA.organizationId,
    fromActorId: "manager",
    toActorId: "shared_actor",
    type: "information",
    payload: { sequence: 2 },
  });
  const deliveredOne = runtime.receiveNextMessage({
    organizationId: orgA.organizationId,
    actorId: "shared_actor",
  });
  const redeliveredOne = runtime.receiveNextMessage({
    organizationId: orgA.organizationId,
    actorId: "shared_actor",
  });
  const acknowledged = runtime.acknowledgeMessage({
    organizationId: orgA.organizationId,
    actorId: "shared_actor",
    messageId: messageOne.messageId,
  });
  const deliveredTwo = runtime.receiveNextMessage({
    organizationId: orgA.organizationId,
    actorId: "shared_actor",
  });
  const nonJsonMessageRejected = capturesError(() => runtime.sendMessage({
    organizationId: orgA.organizationId,
    fromActorId: "manager",
    toActorId: "shared_actor",
    type: "information",
    payload: { createdAt: new Date() },
  }), "invalid_input");

  const trace = runtime.getTrace(orgA.organizationId);
  const checks: CheckResult[] = [
    {
      label: "organizations isolate identical actor ids",
      pass:
        runtime.listActors(orgA.organizationId).filter((actor) => actor.actorId === "shared_actor").length === 1 &&
        runtime.listActors(orgB.organizationId).filter((actor) => actor.actorId === "shared_actor").length === 1,
      detail: `alpha=${runtime.listActors(orgA.organizationId).length}, beta=${runtime.listActors(orgB.organizationId).length}`,
    },
    { label: "cross-organization actor registration rejected", pass: wrongOrganizationRejected, detail: String(wrongOrganizationRejected) },
    { label: "task creation capability enforced", pass: permissionDenied, detail: String(permissionDenied) },
    { label: "actor registration requires a manager", pass: unmanagedRegistrationDenied, detail: String(unmanagedRegistrationDenied) },
    { label: "cross-actor inbox reads require management", pass: inboxReadDenied, detail: String(inboxReadDenied) },
    {
      label: "returned task mutation cannot alter runtime state",
      pass:
        created.status === "created" &&
        runtime.getTask(orgA.organizationId, created.taskId).title === "Complete request",
      detail: `${created.title}/${runtime.getTask(orgA.organizationId, created.taskId).title}`,
    },
    { label: "task dispatched through ActorRuntime", pass: firstDispatch?.task.status === "completed", detail: firstDispatch?.task.status ?? "null" },
    { label: "dispatch binds ActorRuntime run id", pass: Boolean(firstDispatch?.task.actorRunId), detail: firstDispatch?.task.actorRunId ?? "none" },
    { label: "reserved organization context cannot be spoofed", pass: firstDispatch?.output.result?.organization_id === orgA.organizationId, detail: JSON.stringify(firstDispatch?.output.result) },
    { label: "reserved task context reaches Skill", pass: firstDispatch?.output.result?.task_id === created.taskId, detail: JSON.stringify(firstDispatch?.output.result) },
    { label: "task input payload reaches Skill", pass: firstDispatch?.output.result?.input_value === "forwarded", detail: JSON.stringify(firstDispatch?.output.result) },
    { label: "concurrent dispatch claims task once", pass: duplicateDispatch === null, detail: String(duplicateDispatch) },
    { label: "waiting status maps to organization task", pass: waiting?.task.status === "waiting_human_input", detail: waiting?.task.status ?? "null" },
    {
      label: "wrong continue event preserves pending run",
      pass:
        mismatchedContinueRejected &&
        pendingAfterMismatchedContinue?.status === "waiting_human_input",
      detail: `${mismatchedContinueRejected}/${pendingAfterMismatchedContinue?.status ?? "missing"}`,
    },
    { label: "continueTask reuses ActorRuntime run", pass: continued.output.actorRunId === waiting?.output.actorRunId, detail: continued.output.actorRunId },
    { label: "continued task completes", pass: continued.task.status === "completed" && continued.output.result?.review === "approved", detail: JSON.stringify(continued.output.result) },
    {
      label: "task executor cannot self-approve",
      pass: selfApprovalDenied,
      detail: String(selfApprovalDenied),
    },
    {
      label: "denied self-approval preserves pending run",
      pass:
        pendingAfterSelfApproval?.status === "waiting_approval" &&
        taskAfterSelfApproval.status === "waiting_approval",
      detail: `${pendingAfterSelfApproval?.status ?? "missing"}/${taskAfterSelfApproval.status}`,
    },
    {
      label: "independent approver completes task",
      pass:
        independentlyApproved.task.status === "completed" &&
        independentlyApproved.output.result?.decided_by === "manager",
      detail: JSON.stringify(independentlyApproved.output.result),
    },
    { label: "cross-organization task lookup is blocked", pass: capturesError(() => runtime.getTask(orgB.organizationId, created.taskId), "not_found"), detail: created.taskId },
    { label: "message starts queued", pass: messageOne.status === "queued" && messageTwo.status === "queued", detail: `${messageOne.status}/${messageTwo.status}` },
    { label: "inbox delivers FIFO", pass: deliveredOne?.messageId === messageOne.messageId, detail: deliveredOne?.messageId ?? "null" },
    { label: "unacknowledged message is redelivered", pass: redeliveredOne?.messageId === messageOne.messageId, detail: redeliveredOne?.messageId ?? "null" },
    { label: "message acknowledgement is explicit", pass: acknowledged.status === "acknowledged", detail: acknowledged.status },
    { label: "next message follows acknowledgement", pass: deliveredTwo?.messageId === messageTwo.messageId, detail: deliveredTwo?.messageId ?? "null" },
    { label: "non-JSON message payload is rejected", pass: nonJsonMessageRejected, detail: String(nonJsonMessageRejected) },
    {
      label: "organization trace covers task and message lifecycle",
      pass: ["task_run_started", "task_suspended", "task_resumed", "task_completed", "message_enqueued", "message_delivered", "message_acknowledged"].every(
        (eventType) => trace.some((event) => event.eventType === eventType)
      ),
      detail: trace.map((event) => event.eventType).join(","),
    },
    {
      label: "organization trace excludes message payload",
      pass: !JSON.stringify(trace).includes("payload_must_not_enter_trace"),
      detail: `events=${trace.length}`,
    },
    {
      label: "ActorRuntime trace exists for dispatched task",
      pass: Boolean(
        firstDispatch?.task.actorRunId &&
        traceLogger.getTrace(firstDispatch.task.actorRunId)?.actorId === "shared_actor" &&
        traceLogger.getTrace(firstDispatch.task.actorRunId)?.skillId === "complete_task"
      ),
      detail: firstDispatch?.task.actorRunId ?? "none",
    },
  ];

  console.log("=".repeat(68));
  console.log(`  ForeverThinking v0.5.0 — Organization Runtime (${checks.length} checks)`);
  console.log("=".repeat(68));
  let passed = 0;
  checks.forEach((check, index) => {
    if (check.pass) passed++;
    console.log(`${check.pass ? "✅" : "❌"} ${String(index + 1).padStart(2, "0")}. ${check.label}`);
    console.log(`    ${check.detail}`);
  });
  console.log(`Passed: ${passed}/${checks.length}`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error("Organization Runtime Demo failed:", error);
  process.exit(1);
});
