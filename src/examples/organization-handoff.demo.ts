// ============================================================================
// organization-handoff.demo.ts — v0.6.0
// Governed, single-direction OrganizationRuntime handoff demo
// ============================================================================

import { isDeepStrictEqual } from "node:util";
import { approvalGate } from "../approvals/approval-gate";
import type { ActorConfig } from "../core/types/actor";
import type { SkillConfig } from "../core/types/skill";
import { memoryService } from "../memory/memory-service";
import type { ActorMessage } from "../organization/actor-message";
import { OrganizationError } from "../organization/organization-error";
import {
  computeOrganizationHandoffFingerprint,
  type OrganizationHandoffRecord,
} from "../organization/organization-handoff";
import type { OrganizationCapability } from "../organization/organization-permission";
import {
  OrganizationRuntime,
  type TaskExecutionResult,
} from "../organization/organization-runtime";
import type { OrganizationTask } from "../organization/task";
import { actorRuntime, type HandoffRequest } from "../runtime/actor-runtime";
import { traceLogger } from "../trace/trace-logger";

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

interface QueuedHandoffScenario {
  runtime: OrganizationRuntime;
  organizationId: string;
  sourceActorId: string;
  targetActorId: string;
  rootSkill: SkillConfig;
  targetSkillId: string;
  rootTask: OrganizationTask;
}

interface RejectedHandoffResult {
  label: string;
  error: unknown;
  task: OrganizationTask;
  taskCount: number;
  queueCount: number;
  messageCount: number;
  handoffCount: number;
}

const SOURCE_CAPABILITIES: OrganizationCapability[] = [
  "organization:manage",
  "task:create",
  "task:assign",
  "task:execute",
  "task:delegate",
  "message:send",
  "message:receive",
  "organization:snapshot",
];

const TARGET_CAPABILITIES: OrganizationCapability[] = [
  "task:execute",
  "message:receive",
];

const ROOT_CONTEXT = {
  case_id: "CASE-0600",
  priority: "urgent",
  evidence: {
    channel: "organization-demo",
    signals: ["handoff", "governance", "recovery-ready"],
  },
};

const EXPECTED_CHILD_INPUT = {
  payload: {
    caseId: ROOT_CONTEXT.case_id,
    priority: ROOT_CONTEXT.priority,
    evidence: ROOT_CONTEXT.evidence,
  },
};

function format(value: unknown): string {
  return JSON.stringify(value);
}

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
    responsibility: "Exercise governed OrganizationRuntime handoff semantics",
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

function handoffSkill(input: {
  skillId: string;
  targetActorId: string;
  targetSkillId: string;
  reason?: string;
}): SkillConfig {
  return {
    skill_id: input.skillId,
    name: `Delegate through ${input.skillId}`,
    steps: [
      {
        step_key: "delegate",
        type: "handoff",
        target_actor_id: input.targetActorId,
        target_skill_id: input.targetSkillId,
        reason: input.reason ?? "A specialist must own the next bounded task",
        input_mapping: {
          caseId: "{{context.case_id}}",
          priority: "{{context.priority}}",
          evidence: "{{context.evidence}}",
        },
      },
    ],
  };
}

function completeSkill(skillId: string, handledBy: string): SkillConfig {
  return {
    skill_id: skillId,
    name: `Complete delegated task as ${handledBy}`,
    steps: [
      {
        step_key: "return",
        type: "return",
        output_mapping: {
          handledBy,
          caseId: "{{context.caseId}}",
          priority: "{{context.priority}}",
          handoffRequestId: "{{context.handoff_request_id}}",
          parentTaskId: "{{context.handoff_parent_task_id}}",
        },
      },
    ],
  };
}

function waitSkill(skillId: string): SkillConfig {
  return {
    skill_id: skillId,
    name: "Wait inside bounded dispatch",
    steps: [
      {
        step_key: "review",
        type: "human_input",
        prompt: "Review the blocked task",
        output_key: "review",
      },
      {
        step_key: "return",
        type: "return",
        output_mapping: { review: "{{outputs.review}}" },
      },
    ],
  };
}

function waitThenHandoffSkill(input: {
  skillId: string;
  targetActorId: string;
  targetSkillId: string;
}): SkillConfig {
  return {
    skill_id: input.skillId,
    name: "Wait before requesting a governed handoff",
    steps: [
      {
        step_key: "review",
        type: "human_input",
        prompt: "Confirm that the task should be delegated",
        output_key: "review",
      },
      {
        step_key: "delegate",
        type: "handoff",
        target_actor_id: input.targetActorId,
        target_skill_id: input.targetSkillId,
        reason: "The resumed Actor run requires another specialist",
        input_mapping: {
          review: "{{outputs.review}}",
        },
      },
    ],
  };
}

function createQueuedHandoffScenario(input: {
  suffix: string;
  sourceCapabilities?: OrganizationCapability[];
  targetCapabilities?: OrganizationCapability[];
  targetSkillAvailable?: boolean;
  selfHandoff?: boolean;
}): QueuedHandoffScenario {
  const organizationId = `org_handoff_${input.suffix}`;
  const sourceActorId = `source_${input.suffix}`;
  const targetActorId = input.selfHandoff ? sourceActorId : `target_${input.suffix}`;
  const rootSkillId = `root_handoff_${input.suffix}`;
  const targetSkillId = `explicit_target_${input.suffix}`;
  const rootSkill = handoffSkill({
    skillId: rootSkillId,
    targetActorId,
    targetSkillId,
  });
  const targetSkill = completeSkill(targetSkillId, targetActorId);
  const runtime = new OrganizationRuntime(actorRuntime);
  runtime.createOrganization({ organizationId, name: `Handoff ${input.suffix}` });

  const sourceSkills = input.selfHandoff ? [rootSkill, targetSkill] : [rootSkill];
  runtime.registerActor(organizationId, {
    actorConfig: actorConfig(
      organizationId,
      sourceActorId,
      sourceSkills.map((skill) => skill.skill_id)
    ),
    skills: sourceSkills,
    capabilities: input.sourceCapabilities ?? SOURCE_CAPABILITIES,
  });

  if (!input.selfHandoff) {
    const targetSkills = input.targetSkillAvailable === false ? [] : [targetSkill];
    runtime.registerActor(organizationId, {
      actorConfig: actorConfig(
        organizationId,
        targetActorId,
        targetSkills.map((skill) => skill.skill_id)
      ),
      skills: targetSkills,
      capabilities: input.targetCapabilities ?? TARGET_CAPABILITIES,
    }, sourceActorId);
  }

  const rootTask = runtime.createTask({
    organizationId,
    requestedByActorId: sourceActorId,
    title: `Root task ${input.suffix}`,
    input: { text: "Route this case to the explicitly addressed specialist" },
    runtimeContext: ROOT_CONTEXT,
  });
  runtime.assignTask({
    organizationId,
    requestedByActorId: sourceActorId,
    taskId: rootTask.taskId,
    actorId: sourceActorId,
    skillId: rootSkillId,
  });
  runtime.enqueueTask({
    organizationId,
    requestedByActorId: sourceActorId,
    taskId: rootTask.taskId,
  });

  return {
    runtime,
    organizationId,
    sourceActorId,
    targetActorId,
    rootSkill,
    targetSkillId,
    rootTask,
  };
}

async function rejectedHandoff(input: {
  label: string;
  suffix: string;
  sourceCapabilities?: OrganizationCapability[];
  targetCapabilities?: OrganizationCapability[];
  targetSkillAvailable?: boolean;
  selfHandoff?: boolean;
}): Promise<RejectedHandoffResult> {
  const scenario = createQueuedHandoffScenario(input);
  let error: unknown;
  try {
    await scenario.runtime.dispatchNext({ organizationId: scenario.organizationId });
  } catch (caught) {
    error = caught;
  }
  const snapshot = scenario.runtime.dumpSnapshot({
    organizationId: scenario.organizationId,
    requestedByActorId: scenario.sourceActorId,
  });
  return {
    label: input.label,
    error,
    task: scenario.runtime.getTask(scenario.organizationId, scenario.rootTask.taskId),
    taskCount: snapshot.tasks.length,
    queueCount: snapshot.taskQueue.length,
    messageCount: snapshot.messages.length,
    handoffCount: snapshot.handoffs.length,
  };
}

function isOrganizationError(error: unknown, code: string): boolean {
  return error instanceof OrganizationError && error.code === code;
}

function rejectionChecks(
  result: RejectedHandoffResult,
  expectedCode: string
): CheckResult[] {
  return [
    {
      label: `${result.label} is rejected fail closed`,
      pass: isOrganizationError(result.error, expectedCode) && result.task.status === "failed",
      detail: format({
        code: result.error instanceof OrganizationError ? result.error.code : null,
        message: result.error instanceof Error ? result.error.message : null,
        taskStatus: result.task.status,
      }),
    },
    {
      label: `${result.label} leaves no child, queue, message, or handoff artifact`,
      pass:
        result.taskCount === 1 &&
        result.queueCount === 0 &&
        result.messageCount === 0 &&
        result.handoffCount === 0 &&
        result.task.outgoingHandoffRequestId === undefined,
      detail: format({
        taskCount: result.taskCount,
        queueCount: result.queueCount,
        messageCount: result.messageCount,
        handoffCount: result.handoffCount,
        outgoingHandoffRequestId: result.task.outgoingHandoffRequestId,
      }),
    },
  ];
}

async function depthLimitScenario(): Promise<{
  error: unknown;
  sourceTask: OrganizationTask;
  childTask: OrganizationTask;
  handoffs: OrganizationHandoffRecord[];
  messages: ActorMessage[];
  taskCount: number;
  queueCount: number;
  rejectedRequest?: HandoffRequest;
}> {
  const organizationId = "org_handoff_depth_limit";
  const sourceActorId = "depth_source";
  const middleActorId = "depth_middle";
  const leafActorId = "depth_leaf";
  const rootSkill = handoffSkill({
    skillId: "depth_root",
    targetActorId: middleActorId,
    targetSkillId: "depth_middle_handoff",
  });
  const middleSkill = handoffSkill({
    skillId: "depth_middle_handoff",
    targetActorId: leafActorId,
    targetSkillId: "depth_leaf_complete",
  });
  const leafSkill = completeSkill("depth_leaf_complete", leafActorId);
  const runtime = new OrganizationRuntime(actorRuntime);
  runtime.createOrganization({ organizationId, name: "Depth limit" });
  runtime.registerActor(organizationId, {
    actorConfig: actorConfig(organizationId, sourceActorId, [rootSkill.skill_id]),
    skills: [rootSkill],
    capabilities: SOURCE_CAPABILITIES,
  });
  runtime.registerActor(organizationId, {
    actorConfig: actorConfig(organizationId, middleActorId, [middleSkill.skill_id]),
    skills: [middleSkill],
    capabilities: ["task:execute", "task:delegate", "message:receive"],
  }, sourceActorId);
  runtime.registerActor(organizationId, {
    actorConfig: actorConfig(organizationId, leafActorId, [leafSkill.skill_id]),
    skills: [leafSkill],
    capabilities: TARGET_CAPABILITIES,
  }, sourceActorId);

  const rootTask = runtime.createTask({
    organizationId,
    requestedByActorId: sourceActorId,
    title: "Do not permit a second handoff",
    input: { text: "Depth one only" },
    runtimeContext: ROOT_CONTEXT,
  });
  runtime.assignTask({
    organizationId,
    requestedByActorId: sourceActorId,
    taskId: rootTask.taskId,
    actorId: sourceActorId,
    skillId: rootSkill.skill_id,
  });
  runtime.enqueueTask({
    organizationId,
    requestedByActorId: sourceActorId,
    taskId: rootTask.taskId,
  });
  const rootDispatch = await runtime.dispatchNext({ organizationId });
  if (!rootDispatch?.handoff) throw new Error("Expected the depth root to hand off");

  let error: unknown;
  try {
    await runtime.dispatchNext({ organizationId });
  } catch (caught) {
    error = caught;
  }

  const childTask = runtime.getTask(organizationId, rootDispatch.handoff.childTask.taskId);
  const childTrace = childTask.actorRunId
    ? traceLogger.getTrace(childTask.actorRunId)?.events ?? []
    : [];
  const rejectedRequest = childTrace.find((event) => event.eventType === "handoff")
    ?.data as unknown as HandoffRequest | undefined;
  const snapshot = runtime.dumpSnapshot({
    organizationId,
    requestedByActorId: sourceActorId,
  });
  return {
    error,
    sourceTask: runtime.getTask(organizationId, rootTask.taskId),
    childTask,
    handoffs: snapshot.handoffs,
    messages: snapshot.messages,
    taskCount: snapshot.tasks.length,
    queueCount: snapshot.taskQueue.length,
    rejectedRequest,
  };
}

async function continuedChildGovernanceFailureScenario(): Promise<{
  error: unknown;
  duplicateContinueError: unknown;
  sourceTask: OrganizationTask;
  childTask: OrganizationTask;
  messages: ActorMessage[];
  handoffs: OrganizationHandoffRecord[];
  trace: ReturnType<OrganizationRuntime["getTrace"]>;
  requestMessageId: string;
  originalHandoffRequestId: string;
}> {
  const organizationId = "org_handoff_continue_governance_failure";
  const sourceActorId = "continue_source";
  const middleActorId = "continue_middle";
  const leafActorId = "continue_leaf";
  const middleSkillId = "continue_wait_then_handoff";
  const leafSkillId = "continue_leaf_complete";
  const rootSkill = handoffSkill({
    skillId: "continue_root_handoff",
    targetActorId: middleActorId,
    targetSkillId: middleSkillId,
  });
  const middleSkill = waitThenHandoffSkill({
    skillId: middleSkillId,
    targetActorId: leafActorId,
    targetSkillId: leafSkillId,
  });
  const leafSkill = completeSkill(leafSkillId, leafActorId);
  const runtime = new OrganizationRuntime(actorRuntime);
  runtime.createOrganization({ organizationId, name: "Continue governance failure" });
  runtime.registerActor(organizationId, {
    actorConfig: actorConfig(organizationId, sourceActorId, [rootSkill.skill_id]),
    skills: [rootSkill],
    capabilities: SOURCE_CAPABILITIES,
  });
  runtime.registerActor(organizationId, {
    actorConfig: actorConfig(organizationId, middleActorId, [middleSkill.skill_id]),
    skills: [middleSkill],
    // Deliberately omit task:delegate. The Actor run is allowed to resume, but
    // OrganizationRuntime must fail the child when materialization is denied.
    capabilities: ["task:execute", "message:receive"],
  }, sourceActorId);
  runtime.registerActor(organizationId, {
    actorConfig: actorConfig(organizationId, leafActorId, [leafSkill.skill_id]),
    skills: [leafSkill],
    capabilities: TARGET_CAPABILITIES,
  }, sourceActorId);

  const rootTask = runtime.createTask({
    organizationId,
    requestedByActorId: sourceActorId,
    title: "Resume before a denied handoff",
    input: { text: "Create a depth-1 waiting child" },
    runtimeContext: ROOT_CONTEXT,
  });
  runtime.assignTask({
    organizationId,
    requestedByActorId: sourceActorId,
    taskId: rootTask.taskId,
    actorId: sourceActorId,
    skillId: rootSkill.skill_id,
  });
  runtime.enqueueTask({
    organizationId,
    requestedByActorId: sourceActorId,
    taskId: rootTask.taskId,
  });

  const rootDispatch = await runtime.dispatchNext({ organizationId, actorId: sourceActorId });
  requireRootHandoff(rootDispatch);
  const waitingDispatch = await runtime.dispatchNext({ organizationId, actorId: middleActorId });
  if (!waitingDispatch?.output.pendingHumanInput) {
    throw new Error("Expected the delegated child to wait for HumanInput");
  }

  let error: unknown;
  try {
    await runtime.continueTask({
      organizationId,
      requestedByActorId: middleActorId,
      taskId: rootDispatch.handoff.childTask.taskId,
      event: {
        type: "human_input_response",
        response: {
          humanInputRequestId:
            waitingDispatch.output.pendingHumanInput.humanInputRequestId,
          value: "delegate after review",
          respondedBy: middleActorId,
        },
      },
    });
  } catch (caught) {
    error = caught;
  }

  let duplicateContinueError: unknown;
  try {
    await runtime.continueTask({
      organizationId,
      requestedByActorId: middleActorId,
      taskId: rootDispatch.handoff.childTask.taskId,
      event: {
        type: "human_input_response",
        response: {
          humanInputRequestId:
            waitingDispatch.output.pendingHumanInput.humanInputRequestId,
          value: "must not respond twice",
          respondedBy: middleActorId,
        },
      },
    });
  } catch (caught) {
    duplicateContinueError = caught;
  }

  const snapshot = runtime.dumpSnapshot({ organizationId, requestedByActorId: sourceActorId });
  return {
    error,
    duplicateContinueError,
    sourceTask: runtime.getTask(organizationId, rootTask.taskId),
    childTask: runtime.getTask(organizationId, rootDispatch.handoff.childTask.taskId),
    messages: snapshot.messages,
    handoffs: snapshot.handoffs,
    trace: runtime.getTrace(organizationId),
    requestMessageId: rootDispatch.handoff.requestMessage.messageId,
    originalHandoffRequestId: rootDispatch.output.handoffRequest.handoffRequestId,
  };
}

async function createBlockedDispatchScenario(): Promise<{
  result: Awaited<ReturnType<OrganizationRuntime["dispatchUntilIdle"]>>;
  task: OrganizationTask;
}> {
  const organizationId = "org_handoff_dispatch_blocked";
  const actorId = "blocked_actor";
  const skill = waitSkill("blocked_wait");
  const runtime = new OrganizationRuntime(actorRuntime);
  runtime.createOrganization({ organizationId, name: "Blocked bounded dispatch" });
  runtime.registerActor(organizationId, {
    actorConfig: actorConfig(organizationId, actorId, [skill.skill_id]),
    skills: [skill],
    capabilities: [
      "organization:manage",
      "task:create",
      "task:assign",
      "task:execute",
    ],
  });
  const task = runtime.createTask({
    organizationId,
    requestedByActorId: actorId,
    title: "Block on human input",
    input: { text: "Wait" },
  });
  runtime.assignTask({
    organizationId,
    requestedByActorId: actorId,
    taskId: task.taskId,
    actorId,
    skillId: skill.skill_id,
  });
  runtime.enqueueTask({
    organizationId,
    requestedByActorId: actorId,
    taskId: task.taskId,
  });
  const result = await runtime.dispatchUntilIdle({ organizationId, maxDispatches: 5 });
  return { result, task: runtime.getTask(organizationId, task.taskId) };
}

function requireRootHandoff(result: TaskExecutionResult | null): asserts result is TaskExecutionResult & {
  handoff: NonNullable<TaskExecutionResult["handoff"]>;
  output: TaskExecutionResult["output"] & { handoffRequest: HandoffRequest };
} {
  if (!result?.handoff || !result.output.handoffRequest) {
    throw new Error("Expected a governed root handoff result");
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(76));
  console.log("  ForeverThinking v0.6.0 — Governed Organization Handoff Demo");
  console.log("=".repeat(76));

  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();

  // Main A -> B lifecycle: Actor A's root Skill explicitly selects Actor B's Skill.
  const mainScenario = createQueuedHandoffScenario({ suffix: "main" });
  const rootDispatch = await mainScenario.runtime.dispatchNext({
    organizationId: mainScenario.organizationId,
    actorId: mainScenario.sourceActorId,
  });
  requireRootHandoff(rootDispatch);
  const request = rootDispatch.output.handoffRequest;
  const sourceAfterHandoff = mainScenario.runtime.getTask(
    mainScenario.organizationId,
    mainScenario.rootTask.taskId
  );
  const childAfterHandoff = mainScenario.runtime.getTask(
    mainScenario.organizationId,
    rootDispatch.handoff.childTask.taskId
  );
  const targetInboxAfterHandoff = mainScenario.runtime.listInbox({
    organizationId: mainScenario.organizationId,
    requestedByActorId: mainScenario.targetActorId,
  });
  const requestMessage = targetInboxAfterHandoff[0];
  const rootSnapshot = mainScenario.runtime.dumpSnapshot({
    organizationId: mainScenario.organizationId,
    requestedByActorId: mainScenario.sourceActorId,
  });
  const expectedFingerprint = computeOrganizationHandoffFingerprint({
    organizationId: mainScenario.organizationId,
    sourceTaskId: sourceAfterHandoff.taskId,
    handoffRequestId: request.handoffRequestId,
    actorRunId: request.actorRunId,
    sourceActorId: request.sourceActorId,
    sourceSkillId: request.sourceSkillId,
    stepKey: request.stepKey,
    targetActorId: request.targetActorId,
    targetSkillId: request.targetSkillId,
    reason: request.reason,
    handoffContext: request.handoffContext,
  });
  const requestPayload = requestMessage?.payload as Record<string, unknown> | undefined;

  const childDispatch = await mainScenario.runtime.dispatchNext({
    organizationId: mainScenario.organizationId,
    actorId: mainScenario.targetActorId,
  });
  if (!childDispatch) throw new Error("Expected the delegated child to dispatch");
  const sourceAfterChild = mainScenario.runtime.getTask(
    mainScenario.organizationId,
    mainScenario.rootTask.taskId
  );
  const childAfterCompletion = mainScenario.runtime.getTask(
    mainScenario.organizationId,
    childAfterHandoff.taskId
  );
  const targetInboxAfterChild = mainScenario.runtime.listInbox({
    organizationId: mainScenario.organizationId,
    requestedByActorId: mainScenario.targetActorId,
  });
  const sourceInboxAfterChild = mainScenario.runtime.listInbox({
    organizationId: mainScenario.organizationId,
    requestedByActorId: mainScenario.sourceActorId,
  });
  const acknowledgedRequest = targetInboxAfterChild.find(
    (message) => message.messageId === requestMessage.messageId
  );
  const responseMessage = sourceInboxAfterChild.find(
    (message) => message.type === "task_response"
  );
  const responsePayload = responseMessage?.payload as Record<string, unknown> | undefined;
  const respondedHandoff = mainScenario.runtime.listHandoffs(mainScenario.organizationId)[0];
  const mainTrace = mainScenario.runtime.getTrace(mainScenario.organizationId);

  const countsBeforeIdempotentIdle = {
    tasks: mainScenario.runtime.listTasks(mainScenario.organizationId).length,
    handoffs: mainScenario.runtime.listHandoffs(mainScenario.organizationId).length,
    sourceMessages: sourceInboxAfterChild.length,
    targetMessages: targetInboxAfterChild.length,
    trace: mainTrace.length,
  };
  const idempotentIdle = await mainScenario.runtime.dispatchUntilIdle({
    organizationId: mainScenario.organizationId,
    maxDispatches: 5,
  });
  const countsAfterIdempotentIdle = {
    tasks: mainScenario.runtime.listTasks(mainScenario.organizationId).length,
    handoffs: mainScenario.runtime.listHandoffs(mainScenario.organizationId).length,
    sourceMessages: mainScenario.runtime.listInbox({
      organizationId: mainScenario.organizationId,
      requestedByActorId: mainScenario.sourceActorId,
    }).length,
    targetMessages: mainScenario.runtime.listInbox({
      organizationId: mainScenario.organizationId,
      requestedByActorId: mainScenario.targetActorId,
    }).length,
    trace: mainScenario.runtime.getTrace(mainScenario.organizationId).length,
  };

  // Governance failures are isolated so residue checks are exact.
  const withoutDelegate = await rejectedHandoff({
    label: "a source without task:delegate",
    suffix: "deny_delegate",
    sourceCapabilities: SOURCE_CAPABILITIES.filter((item) => item !== "task:delegate"),
  });
  const withoutSourceReceive = await rejectedHandoff({
    label: "a source without message:receive",
    suffix: "deny_source_receive",
    sourceCapabilities: SOURCE_CAPABILITIES.filter((item) => item !== "message:receive"),
  });
  const withoutTargetExecute = await rejectedHandoff({
    label: "a target without task:execute",
    suffix: "deny_target_execute",
    targetCapabilities: TARGET_CAPABILITIES.filter((item) => item !== "task:execute"),
  });
  const withoutTargetReceive = await rejectedHandoff({
    label: "a target without message:receive",
    suffix: "deny_target_receive",
    targetCapabilities: TARGET_CAPABILITIES.filter((item) => item !== "message:receive"),
  });
  const withoutTargetSkill = await rejectedHandoff({
    label: "a target without the explicitly selected Skill",
    suffix: "deny_target_skill",
    targetSkillAvailable: false,
  });
  const selfHandoff = await rejectedHandoff({
    label: "a self-handoff",
    suffix: "deny_self",
    selfHandoff: true,
  });
  const depthLimit = await depthLimitScenario();
  const continuedChildFailure = await continuedChildGovernanceFailureScenario();
  const continuedChildResponses = continuedChildFailure.messages.filter(
    (message) =>
      message.type === "task_response" &&
      message.correlationId === continuedChildFailure.originalHandoffRequestId
  );
  const continuedChildResponse = continuedChildResponses[0];
  const continuedChildResponsePayload = continuedChildResponse?.payload as
    | Record<string, unknown>
    | undefined;
  const continuedChildFailureEvents = continuedChildFailure.trace.filter(
    (event) =>
      event.eventType === "task_failed" && event.taskId === continuedChildFailure.childTask.taskId
  );
  const continuedChildResponseEvents = continuedChildFailure.trace.filter(
    (event) =>
      event.eventType === "handoff_response_enqueued" &&
      event.handoffRequestId === continuedChildFailure.originalHandoffRequestId
  );

  // The public messaging API may carry a task_request-shaped message, but it
  // cannot mint internal correlation or causation metadata.
  const forgedScenario = createQueuedHandoffScenario({ suffix: "forged_metadata" });
  const forged = forgedScenario.runtime.sendMessage({
    organizationId: forgedScenario.organizationId,
    fromActorId: forgedScenario.sourceActorId,
    toActorId: forgedScenario.targetActorId,
    type: "task_request",
    payload: { forged: true },
    correlationId: "hreq_forged",
    causationMessageId: "msg_forged",
  } as Parameters<OrganizationRuntime["sendMessage"]>[0] & {
    correlationId: string;
    causationMessageId: string;
  });

  // dispatchUntilIdle: full progress, dispatch limit, idle, and blocked wait.
  const loopScenario = createQueuedHandoffScenario({ suffix: "loop_complete" });
  const completeLoop = await loopScenario.runtime.dispatchUntilIdle({
    organizationId: loopScenario.organizationId,
    maxDispatches: 5,
  });
  const loopTasks = loopScenario.runtime.listTasks(loopScenario.organizationId);
  const loopIdle = await loopScenario.runtime.dispatchUntilIdle({
    organizationId: loopScenario.organizationId,
    maxDispatches: 5,
  });

  const limitScenario = createQueuedHandoffScenario({ suffix: "loop_limit" });
  const limitedLoop = await limitScenario.runtime.dispatchUntilIdle({
    organizationId: limitScenario.organizationId,
    maxDispatches: 1,
  });
  const limitedTasks = limitScenario.runtime.listTasks(limitScenario.organizationId);
  const blocked = await createBlockedDispatchScenario();

  const delegatedEvents = mainTrace.filter((event) => event.eventType === "task_delegated");
  const runStartedEvents = mainTrace.filter((event) => event.eventType === "task_run_started");
  const requestDeliveredIndex = mainTrace.findIndex(
    (event) => event.eventType === "message_delivered" && event.messageId === requestMessage.messageId
  );
  const requestAcknowledgedIndex = mainTrace.findIndex(
    (event) => event.eventType === "message_acknowledged" && event.messageId === requestMessage.messageId
  );
  const childRunStartedIndex = mainTrace.findIndex(
    (event) => event.eventType === "task_run_started" && event.taskId === childAfterHandoff.taskId
  );
  const childCompletedIndex = mainTrace.findIndex(
    (event) => event.eventType === "task_completed" && event.taskId === childAfterHandoff.taskId
  );
  const responseEnqueuedIndex = mainTrace.findIndex(
    (event) => event.eventType === "handoff_response_enqueued"
  );

  const checks: CheckResult[] = [
    {
      label: "Actor A's root Skill terminates as handoff_requested",
      pass:
        rootDispatch.output.status === "handoff_requested" &&
        rootDispatch.output.result === null &&
        rootDispatch.output.pendingApproval === undefined &&
        rootDispatch.output.pendingHumanInput === undefined &&
        rootDispatch.output.pendingExternalEvent === undefined,
      detail: format({ status: rootDispatch.output.status, result: rootDispatch.output.result }),
    },
    {
      label: "the handoff explicitly addresses Actor B and its exact Skill",
      pass:
        request.sourceActorId === mainScenario.sourceActorId &&
        request.sourceSkillId === mainScenario.rootSkill.skill_id &&
        request.targetActorId === mainScenario.targetActorId &&
        request.targetSkillId === mainScenario.targetSkillId,
      detail: format({
        sourceActorId: request.sourceActorId,
        sourceSkillId: request.sourceSkillId,
        targetActorId: request.targetActorId,
        targetSkillId: request.targetSkillId,
      }),
    },
    {
      label: "the source task becomes delegated and keeps its terminal Actor run",
      pass:
        sourceAfterHandoff.status === "delegated" &&
        sourceAfterHandoff.actorRunId === request.actorRunId &&
        sourceAfterHandoff.outgoingHandoffRequestId === request.handoffRequestId,
      detail: format({
        status: sourceAfterHandoff.status,
        actorRunId: sourceAfterHandoff.actorRunId,
        outgoing: sourceAfterHandoff.outgoingHandoffRequestId,
      }),
    },
    {
      label: "one depth-1 child is queued with explicit Actor and Skill assignment",
      pass:
        childAfterHandoff.status === "queued" &&
        childAfterHandoff.parentTaskId === sourceAfterHandoff.taskId &&
        childAfterHandoff.rootTaskId === sourceAfterHandoff.taskId &&
        childAfterHandoff.handoffDepth === 1 &&
        childAfterHandoff.assignedTo === mainScenario.targetActorId &&
        childAfterHandoff.skillId === mainScenario.targetSkillId &&
        childAfterHandoff.incomingHandoffRequestId === request.handoffRequestId,
      detail: format({
        status: childAfterHandoff.status,
        parentTaskId: childAfterHandoff.parentTaskId,
        rootTaskId: childAfterHandoff.rootTaskId,
        depth: childAfterHandoff.handoffDepth,
        assignedTo: childAfterHandoff.assignedTo,
        skillId: childAfterHandoff.skillId,
      }),
    },
    {
      label: "root dispatch atomically creates one child, queue item, request, and handoff",
      pass:
        rootSnapshot.tasks.length === 2 &&
        isDeepStrictEqual(rootSnapshot.taskQueue, [childAfterHandoff.taskId]) &&
        rootSnapshot.messages.length === 1 &&
        rootSnapshot.handoffs.length === 1,
      detail: format({
        tasks: rootSnapshot.tasks.length,
        taskQueue: rootSnapshot.taskQueue,
        messages: rootSnapshot.messages.length,
        handoffs: rootSnapshot.handoffs.length,
      }),
    },
    {
      label: "the child input is the detached mapped handoff context",
      pass:
        isDeepStrictEqual(request.handoffContext, EXPECTED_CHILD_INPUT.payload) &&
        isDeepStrictEqual(childAfterHandoff.input, EXPECTED_CHILD_INPUT),
      detail: format({ request: request.handoffContext, child: childAfterHandoff.input }),
    },
    {
      label: "the request correlation id is the runtime-owned handoff request id",
      pass:
        requestMessage.type === "task_request" &&
        requestMessage.status === "queued" &&
        requestMessage.correlationId === request.handoffRequestId &&
        requestMessage.causationMessageId === undefined,
      detail: format({
        type: requestMessage.type,
        status: requestMessage.status,
        correlationId: requestMessage.correlationId,
        causationMessageId: requestMessage.causationMessageId,
      }),
    },
    {
      label: "the handoff fingerprint is canonical and shared by record and request payload",
      pass:
        rootDispatch.handoff.record.fingerprint === expectedFingerprint &&
        requestPayload?.fingerprint === expectedFingerprint &&
        /^[a-f0-9]{64}$/.test(expectedFingerprint),
      detail: format({
        expectedFingerprint,
        recordFingerprint: rootDispatch.handoff.record.fingerprint,
        payloadFingerprint: requestPayload?.fingerprint,
      }),
    },
    {
      label: "the task_request payload binds source, child, route, reason, and input",
      pass:
        requestPayload?.handoffRequestId === request.handoffRequestId &&
        requestPayload.sourceTaskId === sourceAfterHandoff.taskId &&
        requestPayload.childTaskId === childAfterHandoff.taskId &&
        requestPayload.sourceActorRunId === request.actorRunId &&
        requestPayload.sourceSkillId === request.sourceSkillId &&
        requestPayload.sourceStepKey === request.stepKey &&
        requestPayload.targetActorId === request.targetActorId &&
        requestPayload.targetSkillId === request.targetSkillId &&
        requestPayload.reason === request.reason &&
        isDeepStrictEqual(requestPayload.input, childAfterHandoff.input),
      detail: format(requestPayload),
    },
    {
      label: "dispatching the child acknowledges the exact handoff request",
      pass:
        targetInboxAfterChild.length === 1 &&
        acknowledgedRequest?.status === "acknowledged" &&
        Boolean(acknowledgedRequest.deliveredAt) &&
        Boolean(acknowledgedRequest.acknowledgedAt) &&
        acknowledgedRequest.correlationId === request.handoffRequestId,
      detail: format(acknowledgedRequest),
    },
    {
      label: "the explicit child Skill completes with governed handoff context",
      pass:
        childDispatch.output.status === "completed" &&
        childAfterCompletion.status === "completed" &&
        childAfterCompletion.result?.handledBy === mainScenario.targetActorId &&
        childAfterCompletion.result.caseId === ROOT_CONTEXT.case_id &&
        childAfterCompletion.result.priority === ROOT_CONTEXT.priority &&
        childAfterCompletion.result.handoffRequestId === request.handoffRequestId &&
        childAfterCompletion.result.parentTaskId === sourceAfterHandoff.taskId,
      detail: format(childAfterCompletion.result),
    },
    {
      label: "child completion creates exactly one task_response",
      pass:
        sourceInboxAfterChild.length === 1 &&
        responseMessage?.type === "task_response" &&
        responseMessage.status === "queued" &&
        childDispatch.responseMessage?.messageId === responseMessage.messageId,
      detail: format(responseMessage),
    },
    {
      label: "the response preserves correlation and points causation to the request",
      pass:
        responseMessage?.correlationId === request.handoffRequestId &&
        responseMessage.causationMessageId === requestMessage.messageId,
      detail: format({
        correlationId: responseMessage?.correlationId,
        causationMessageId: responseMessage?.causationMessageId,
        requestMessageId: requestMessage.messageId,
      }),
    },
    {
      label: "the response payload identifies the terminal child and its result",
      pass:
        responsePayload?.handoffRequestId === request.handoffRequestId &&
        responsePayload.sourceTaskId === sourceAfterHandoff.taskId &&
        responsePayload.childTaskId === childAfterCompletion.taskId &&
        responsePayload.status === "completed" &&
        isDeepStrictEqual(responsePayload.result, childAfterCompletion.result),
      detail: format(responsePayload),
    },
    {
      label: "the handoff record responds exactly once with the generated response",
      pass:
        respondedHandoff.status === "responded" &&
        respondedHandoff.responseMessageId === responseMessage?.messageId &&
        Boolean(respondedHandoff.respondedAt) &&
        mainScenario.runtime.listHandoffs(mainScenario.organizationId).length === 1,
      detail: format(respondedHandoff),
    },
    {
      label: "the delegated parent remains terminal and is never resumed",
      pass:
        sourceAfterChild.status === "delegated" &&
        sourceAfterChild.result === undefined &&
        mainTrace.every(
          (event) => event.eventType !== "task_resumed" || event.taskId !== sourceAfterChild.taskId
        ) &&
        !actorRuntime.hasRun(request.actorRunId) &&
        actorRuntime.dumpPendingRun(request.actorRunId) === null,
      detail: format({
        status: sourceAfterChild.status,
        result: sourceAfterChild.result,
        hasActorRun: actorRuntime.hasRun(request.actorRunId),
        hasPendingRun: actorRuntime.dumpPendingRun(request.actorRunId) !== null,
      }),
    },
    {
      label: "a repeated idle dispatch cannot duplicate governed artifacts",
      pass:
        idempotentIdle.dispatches === 0 &&
        idempotentIdle.stopReason === "idle" &&
        isDeepStrictEqual(countsAfterIdempotentIdle, countsBeforeIdempotentIdle),
      detail: format({ idempotentIdle, before: countsBeforeIdempotentIdle, after: countsAfterIdempotentIdle }),
    },
    ...rejectionChecks(withoutDelegate, "permission_denied"),
    ...rejectionChecks(withoutSourceReceive, "permission_denied"),
    ...rejectionChecks(withoutTargetExecute, "permission_denied"),
    ...rejectionChecks(withoutTargetReceive, "permission_denied"),
    ...rejectionChecks(withoutTargetSkill, "permission_denied"),
    ...rejectionChecks(selfHandoff, "invalid_input"),
    {
      label: "a depth-1 child cannot hand off again",
      pass:
        isOrganizationError(depthLimit.error, "invalid_state") &&
        depthLimit.childTask.status === "failed" &&
        depthLimit.sourceTask.status === "delegated" &&
        depthLimit.rejectedRequest?.sourceActorId === "depth_middle",
      detail: format({
        code: depthLimit.error instanceof OrganizationError ? depthLimit.error.code : null,
        message: depthLimit.error instanceof Error ? depthLimit.error.message : null,
        sourceStatus: depthLimit.sourceTask.status,
        childStatus: depthLimit.childTask.status,
        rejectedRequestId: depthLimit.rejectedRequest?.handoffRequestId,
      }),
    },
    {
      label: "depth rejection creates no grandchild, queue, second request, or handoff record",
      pass:
        depthLimit.taskCount === 2 &&
        depthLimit.queueCount === 0 &&
        depthLimit.handoffs.length === 1 &&
        depthLimit.childTask.outgoingHandoffRequestId === undefined &&
        depthLimit.messages.length === 2 &&
        depthLimit.messages.every(
          (message) => message.correlationId !== depthLimit.rejectedRequest?.handoffRequestId
        ),
      detail: format({
        taskCount: depthLimit.taskCount,
        queueCount: depthLimit.queueCount,
        handoffCount: depthLimit.handoffs.length,
        messageTypes: depthLimit.messages.map((message) => message.type),
        messageCorrelations: depthLimit.messages.map((message) => message.correlationId),
        rejectedRequestId: depthLimit.rejectedRequest?.handoffRequestId,
      }),
    },
    {
      label: "a denied handoff after continueTask fails the running child",
      pass:
        isOrganizationError(continuedChildFailure.error, "permission_denied") &&
        continuedChildFailure.sourceTask.status === "delegated" &&
        continuedChildFailure.childTask.status === "failed" &&
        continuedChildFailure.childTask.failureReason?.includes("task:delegate") === true &&
        continuedChildFailure.childTask.actorRunId !== undefined &&
        actorRuntime.dumpPendingRun(continuedChildFailure.childTask.actorRunId) === null &&
        continuedChildFailureEvents.length === 1,
      detail: format({
        code:
          continuedChildFailure.error instanceof OrganizationError
            ? continuedChildFailure.error.code
            : null,
        sourceStatus: continuedChildFailure.sourceTask.status,
        childStatus: continuedChildFailure.childTask.status,
        failureReason: continuedChildFailure.childTask.failureReason,
        taskFailedEvents: continuedChildFailureEvents.length,
      }),
    },
    {
      label: "the failed continued child emits exactly one correlated response",
      pass:
        continuedChildFailure.messages.length === 2 &&
        continuedChildFailure.handoffs.length === 1 &&
        continuedChildFailure.handoffs[0].status === "responded" &&
        continuedChildFailure.handoffs[0].responseMessageId ===
          continuedChildResponse?.messageId &&
        continuedChildResponses.length === 1 &&
        continuedChildResponse?.causationMessageId ===
          continuedChildFailure.requestMessageId &&
        continuedChildResponsePayload?.status === "failed" &&
        continuedChildResponsePayload?.childTaskId === continuedChildFailure.childTask.taskId &&
        continuedChildResponseEvents.length === 1,
      detail: format({
        messageCount: continuedChildFailure.messages.length,
        responseIds: continuedChildResponses.map((message) => message.messageId),
        responsePayload: continuedChildResponsePayload,
        handoff: continuedChildFailure.handoffs[0],
        responseTraceEvents: continuedChildResponseEvents.length,
      }),
    },
    {
      label: "retrying the failed continuation cannot duplicate handoff artifacts",
      pass:
        isOrganizationError(continuedChildFailure.duplicateContinueError, "invalid_state") &&
        continuedChildFailure.childTask.outgoingHandoffRequestId === undefined &&
        continuedChildFailure.handoffs.length === 1 &&
        continuedChildResponses.length === 1 &&
        continuedChildFailure.messages.every(
          (message) =>
            message.correlationId === continuedChildFailure.originalHandoffRequestId
        ),
      detail: format({
        retryCode:
          continuedChildFailure.duplicateContinueError instanceof OrganizationError
            ? continuedChildFailure.duplicateContinueError.code
            : null,
        outgoingHandoffRequestId: continuedChildFailure.childTask.outgoingHandoffRequestId,
        handoffCount: continuedChildFailure.handoffs.length,
        responseCount: continuedChildResponses.length,
        correlations: continuedChildFailure.messages.map((message) => message.correlationId),
      }),
    },
    {
      label: "ordinary sendMessage cannot forge correlation or causation metadata",
      pass:
        forged.type === "task_request" &&
        forged.correlationId === undefined &&
        forged.causationMessageId === undefined &&
        forgedScenario.runtime.listHandoffs(forgedScenario.organizationId).length === 0,
      detail: format({
        type: forged.type,
        correlationId: forged.correlationId,
        causationMessageId: forged.causationMessageId,
        handoffCount: forgedScenario.runtime.listHandoffs(forgedScenario.organizationId).length,
      }),
    },
    {
      label: "dispatchUntilIdle completes a root handoff and its child",
      pass:
        completeLoop.dispatches === 2 &&
        completeLoop.stopReason === "idle" &&
        completeLoop.dispatchedTaskIds.length === 2 &&
        completeLoop.remainingQueuedTaskIds.length === 0 &&
        completeLoop.blockedTaskIds.length === 0 &&
        loopTasks.some((task) => task.status === "delegated") &&
        loopTasks.some((task) => task.status === "completed"),
      detail: format({ completeLoop, statuses: loopTasks.map((task) => task.status) }),
    },
    {
      label: "dispatchUntilIdle reports dispatch_limit with the child still queued",
      pass:
        limitedLoop.dispatches === 1 &&
        limitedLoop.stopReason === "dispatch_limit" &&
        limitedLoop.remainingQueuedTaskIds.length === 1 &&
        limitedTasks.some((task) => task.status === "delegated") &&
        limitedTasks.some(
          (task) => task.status === "queued" && limitedLoop.remainingQueuedTaskIds.includes(task.taskId)
        ),
      detail: format({ limitedLoop, statuses: limitedTasks.map((task) => task.status) }),
    },
    {
      label: "dispatchUntilIdle reports a stable idle organization",
      pass:
        loopIdle.dispatches === 0 &&
        loopIdle.stopReason === "idle" &&
        loopIdle.remainingQueuedTaskIds.length === 0 &&
        loopIdle.blockedTaskIds.length === 0,
      detail: format(loopIdle),
    },
    {
      label: "dispatchUntilIdle exposes waiting work as blocked, not queued",
      pass:
        blocked.result.dispatches === 1 &&
        blocked.result.stopReason === "idle" &&
        blocked.result.remainingQueuedTaskIds.length === 0 &&
        isDeepStrictEqual(blocked.result.blockedTaskIds, [blocked.task.taskId]) &&
        blocked.task.status === "waiting_human_input",
      detail: format({ result: blocked.result, taskStatus: blocked.task.status }),
    },
    {
      label: "Organization Trace sequences the two task run lifecycles",
      pass:
        mainTrace.every((event, index) => event.sequence === index + 1) &&
        runStartedEvents.length === 2 &&
        runStartedEvents[0].taskId === sourceAfterHandoff.taskId &&
        runStartedEvents[1].taskId === childAfterCompletion.taskId,
      detail: format(runStartedEvents.map((event) => ({ sequence: event.sequence, taskId: event.taskId }))),
    },
    {
      label: "Organization Trace records one governed task_delegated event",
      pass:
        delegatedEvents.length === 1 &&
        delegatedEvents[0].taskId === sourceAfterHandoff.taskId &&
        delegatedEvents[0].actorRunId === request.actorRunId &&
        delegatedEvents[0].handoffRequestId === request.handoffRequestId &&
        delegatedEvents[0].data.childTaskId === childAfterCompletion.taskId &&
        delegatedEvents[0].data.requestMessageId === requestMessage.messageId &&
        delegatedEvents[0].data.fingerprint === expectedFingerprint,
      detail: format(delegatedEvents[0]),
    },
    {
      label: "Organization Trace acknowledges the request before child execution",
      pass:
        requestDeliveredIndex >= 0 &&
        requestAcknowledgedIndex === requestDeliveredIndex + 1 &&
        childRunStartedIndex > requestAcknowledgedIndex,
      detail: format({ requestDeliveredIndex, requestAcknowledgedIndex, childRunStartedIndex }),
    },
    {
      label: "Organization Trace enqueues the response after child completion",
      pass:
        childCompletedIndex >= 0 &&
        responseEnqueuedIndex > childCompletedIndex &&
        mainTrace[responseEnqueuedIndex]?.handoffRequestId === request.handoffRequestId &&
        mainTrace[responseEnqueuedIndex]?.messageId === responseMessage?.messageId,
      detail: format({ childCompletedIndex, responseEnqueuedIndex, responseEvent: mainTrace[responseEnqueuedIndex] }),
    },
  ];

  console.log();
  let passed = 0;
  for (const [index, check] of checks.entries()) {
    if (check.pass) passed += 1;
    console.log(
      `  ${check.pass ? "PASS" : "FAIL"} ${String(index + 1).padStart(2, "0")}. ${check.label}`
    );
    console.log(`       ${check.detail}`);
  }

  console.log();
  console.log(`Passed ${passed}/${checks.length}`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
