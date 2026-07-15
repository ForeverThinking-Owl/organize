// ============================================================================
// organization-handoff-recovery.demo.ts — v0.6.0
// Governed Organization handoff recovery, migration, and tamper resistance
// ============================================================================

import { isDeepStrictEqual } from "node:util";
import { approvalGate } from "../approvals/approval-gate";
import type { ActorConfig } from "../core/types/actor";
import type { SkillConfig } from "../core/types/skill";
import { memoryService } from "../memory/memory-service";
import { OrganizationError } from "../organization/organization-error";
import { OrganizationRuntime } from "../organization/organization-runtime";
import type { OrganizationCapability } from "../organization/organization-permission";
import type { OrganizationSnapshot } from "../organization/organization-snapshot";
import {
  LEGACY_ORGANIZATION_SNAPSHOT_SCHEMA_VERSION,
  normalizeOrganizationSnapshot,
} from "../organization/organization-snapshot-migration";
import { ActorRuntime } from "../runtime/actor-runtime";
import { LEGACY_TRACE_SNAPSHOT_SCHEMA_VERSION } from "../trace/trace-snapshot";
import { traceLogger } from "../trace/trace-logger";

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

type HandoffStage = "queued" | "waiting" | "terminal";

interface HandoffFixture {
  organizationId: string;
  runtime: OrganizationRuntime;
  actorRuntime: ActorRuntime;
  snapshot: OrganizationSnapshot;
  sourceTaskId: string;
  childTaskId: string;
  sourceRunId: string;
  childRunId?: string;
  handoffRequestId: string;
  requestMessageId: string;
  responseMessageId?: string;
  deliveredResponseId?: string;
  coldBoundary: boolean;
}

interface RejectedRestoreProbe {
  rejected: boolean;
  errorMessage: string;
  organizationAbsent: boolean;
  actorRuntimeAbsent: boolean;
  actorTraceAbsent: boolean;
  memoryAbsent: boolean;
  validRetrySucceeded: boolean;
}

const SOURCE_ACTOR_ID = "triage";
const TARGET_ACTOR_ID = "specialist";
const COMPLETE_SKILL_ID = "complete_handoff_child";
const WAIT_SKILL_ID = "review_handoff_child";

const SOURCE_CAPABILITIES: OrganizationCapability[] = [
  "organization:manage",
  "task:create",
  "task:assign",
  "task:execute",
  "task:delegate",
  "message:send",
  "message:receive",
  "organization:snapshot",
  "approval:decide",
  "event:receive",
];

const TARGET_CAPABILITIES: OrganizationCapability[] = [
  "task:execute",
  "message:receive",
];

const COMPLETE_SKILL: SkillConfig = {
  skill_id: COMPLETE_SKILL_ID,
  name: "Complete delegated handoff child",
  steps: [{
    step_key: "return",
    type: "return",
    output_mapping: {
      status: "completed",
      case_id: "{{context.case_id}}",
      original_text: "{{context.original_text}}",
    },
  }],
};

const WAIT_SKILL: SkillConfig = {
  skill_id: WAIT_SKILL_ID,
  name: "Review delegated handoff child",
  steps: [
    {
      step_key: "collect_review",
      type: "human_input",
      prompt: "Review the delegated case after cold recovery",
      output_key: "review",
    },
    {
      step_key: "return",
      type: "return",
      output_mapping: {
        status: "reviewed",
        case_id: "{{context.case_id}}",
        review: "{{outputs.review}}",
      },
    },
  ],
};

function format(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function check(label: string, pass: boolean, detail: unknown): CheckResult {
  return { label, pass, detail: format(detail) };
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
    responsibility: "Exercise governed handoff recovery",
    autonomy_level: "L3_low_risk_execute",
    memory: [`${organizationId}:${actorId}:recovery-seed`],
    permissions: {
      allowed_tools: [],
      denied_tools: [],
      allowed_skills: allowedSkills,
    },
    approval_judgment: { must_request_approval_when: [] },
  };
}

function sourceSkill(targetSkillId: string): SkillConfig {
  return {
    skill_id: `handoff_to_${targetSkillId}`,
    name: `Handoff to ${targetSkillId}`,
    steps: [{
      step_key: "delegate",
      type: "handoff",
      target_actor_id: TARGET_ACTOR_ID,
      target_skill_id: targetSkillId,
      reason: "A specialist must own this case",
      input_mapping: {
        case_id: "{{context.case_id}}",
        original_text: "{{context.original_text}}",
      },
    }],
  };
}

function registerHandoffActors(
  runtime: OrganizationRuntime,
  organizationId: string,
  targetSkillId: string
): void {
  const handoffSkill = sourceSkill(targetSkillId);
  runtime.registerActor(organizationId, {
    actorConfig: actorConfig(organizationId, SOURCE_ACTOR_ID, [handoffSkill.skill_id]),
    skills: [handoffSkill],
    capabilities: SOURCE_CAPABILITIES,
  });
  runtime.registerActor(organizationId, {
    actorConfig: actorConfig(
      organizationId,
      TARGET_ACTOR_ID,
      [COMPLETE_SKILL_ID, WAIT_SKILL_ID]
    ),
    skills: [COMPLETE_SKILL, WAIT_SKILL],
    capabilities: TARGET_CAPABILITIES,
  }, SOURCE_ACTOR_ID);
}

function allMessages(runtime: OrganizationRuntime, organizationId: string) {
  return [
    ...runtime.listInbox({
      organizationId,
      requestedByActorId: SOURCE_ACTOR_ID,
      actorId: SOURCE_ACTOR_ID,
    }),
    ...runtime.listInbox({
      organizationId,
      requestedByActorId: SOURCE_ACTOR_ID,
      actorId: TARGET_ACTOR_ID,
    }),
  ];
}

function hasNoRuntimeResidue(
  actorRuntime: ActorRuntime,
  organizationId: string,
  actorRunIds: string[]
): {
  actorRuntimeAbsent: boolean;
  actorTraceAbsent: boolean;
  memoryAbsent: boolean;
} {
  const memory = memoryService.dumpOrganizationSnapshot(organizationId);
  return {
    actorRuntimeAbsent: actorRunIds.every((actorRunId) =>
      !actorRuntime.hasRun(actorRunId) && actorRuntime.dumpPendingRun(actorRunId) === null
    ),
    actorTraceAbsent: actorRunIds.every((actorRunId) =>
      traceLogger.getTrace(actorRunId) === undefined
    ),
    memoryAbsent: memory.memories.length === 0 && memory.candidates.length === 0,
  };
}

async function createHandoffFixture(input: {
  organizationId: string;
  stage: HandoffStage;
  deliverResponse?: boolean;
}): Promise<HandoffFixture> {
  const actorRuntime = new ActorRuntime();
  const runtime = new OrganizationRuntime(actorRuntime);
  const targetSkillId = input.stage === "waiting" ? WAIT_SKILL_ID : COMPLETE_SKILL_ID;
  const handoffSkill = sourceSkill(targetSkillId);

  runtime.createOrganization({
    organizationId: input.organizationId,
    name: `Handoff Recovery ${input.stage}`,
  });
  registerHandoffActors(runtime, input.organizationId, targetSkillId);

  const sourceTask = runtime.createTask({
    organizationId: input.organizationId,
    requestedByActorId: SOURCE_ACTOR_ID,
    title: `Recover handoff at ${input.stage}`,
    input: { text: `handoff-${input.stage}` },
    runtimeContext: {
      case_id: `case-${input.stage}`,
      original_text: `original-${input.stage}`,
    },
  });
  runtime.assignTask({
    organizationId: input.organizationId,
    requestedByActorId: SOURCE_ACTOR_ID,
    taskId: sourceTask.taskId,
    actorId: SOURCE_ACTOR_ID,
    skillId: handoffSkill.skill_id,
  });
  runtime.enqueueTask({
    organizationId: input.organizationId,
    requestedByActorId: SOURCE_ACTOR_ID,
    taskId: sourceTask.taskId,
  });

  const sourceResult = await runtime.dispatchNext({ organizationId: input.organizationId });
  if (
    !sourceResult?.handoff ||
    sourceResult.output.status !== "handoff_requested" ||
    !sourceResult.output.handoffRequest
  ) {
    throw new Error(`Expected a terminal handoff for ${input.organizationId}`);
  }

  const childTaskId = sourceResult.handoff.childTask.taskId;
  let childRunId: string | undefined;
  let responseMessageId: string | undefined;
  if (input.stage !== "queued") {
    const childResult = await runtime.dispatchNext({ organizationId: input.organizationId });
    if (!childResult || childResult.task.taskId !== childTaskId) {
      throw new Error(`Expected delegated child dispatch for ${input.organizationId}`);
    }
    childRunId = childResult.output.actorRunId;
    responseMessageId = childResult.responseMessage?.messageId;
    if (input.stage === "waiting" && !childResult.output.pendingHumanInput) {
      throw new Error(`Expected delegated child to wait for human input in ${input.organizationId}`);
    }
    if (input.stage === "terminal" && childResult.task.status !== "completed") {
      throw new Error(`Expected delegated child to complete in ${input.organizationId}`);
    }
  }

  let deliveredResponseId: string | undefined;
  if (input.deliverResponse) {
    const delivered = runtime.receiveNextMessage({
      organizationId: input.organizationId,
      actorId: SOURCE_ACTOR_ID,
    });
    if (!delivered || delivered.type !== "task_response") {
      throw new Error(`Expected a handoff response for ${input.organizationId}`);
    }
    deliveredResponseId = delivered.messageId;
  }

  const snapshot = runtime.dumpSnapshot({
    organizationId: input.organizationId,
    requestedByActorId: SOURCE_ACTOR_ID,
  });
  const sourceRunId = sourceResult.output.actorRunId;
  const actorRunIds = [sourceRunId, ...(childRunId ? [childRunId] : [])];
  runtime.clearOrganization(input.organizationId);
  const residue = hasNoRuntimeResidue(
    actorRuntime,
    input.organizationId,
    actorRunIds
  );

  return {
    organizationId: input.organizationId,
    runtime,
    actorRuntime,
    snapshot,
    sourceTaskId: sourceTask.taskId,
    childTaskId,
    sourceRunId,
    childRunId,
    handoffRequestId: sourceResult.handoff.record.handoffRequestId,
    requestMessageId: sourceResult.handoff.requestMessage.messageId,
    responseMessageId,
    deliveredResponseId,
    coldBoundary:
      residue.actorRuntimeAbsent &&
      residue.actorTraceAbsent &&
      residue.memoryAbsent,
  };
}

function messageCounts(runtime: OrganizationRuntime, organizationId: string) {
  const messages = allMessages(runtime, organizationId);
  return {
    requestCount: messages.filter((message) => message.type === "task_request").length,
    responseCount: messages.filter((message) => message.type === "task_response").length,
    messages,
  };
}

async function queuedChildRecoveryChecks(): Promise<CheckResult[]> {
  const fixture = await createHandoffFixture({
    organizationId: "org_handoff_recovery_queued",
    stage: "queued",
  });
  const beforeSource = fixture.snapshot.tasks.find(
    (task) => task.taskId === fixture.sourceTaskId
  );
  const beforeChild = fixture.snapshot.tasks.find(
    (task) => task.taskId === fixture.childTaskId
  );
  const beforeRequest = fixture.snapshot.messages.find(
    (message) => message.messageId === fixture.requestMessageId
  );

  fixture.runtime.restoreSnapshot(fixture.snapshot);
  const restoredSource = fixture.runtime.getTask(fixture.organizationId, fixture.sourceTaskId);
  const restoredChild = fixture.runtime.getTask(fixture.organizationId, fixture.childTaskId);
  const restoredCounts = messageCounts(fixture.runtime, fixture.organizationId);
  const loop = await fixture.runtime.dispatchUntilIdle({
    organizationId: fixture.organizationId,
    maxDispatches: 4,
  });
  const completedChild = fixture.runtime.getTask(fixture.organizationId, fixture.childTaskId);
  const completedCounts = messageCounts(fixture.runtime, fixture.organizationId);
  const handoff = fixture.runtime.listHandoffs(fixture.organizationId)[0];
  const request = completedCounts.messages.find(
    (message) => message.messageId === fixture.requestMessageId
  );
  const response = completedCounts.messages.find(
    (message) => message.messageId === handoff.responseMessageId
  );
  const secondLoop = await fixture.runtime.dispatchUntilIdle({
    organizationId: fixture.organizationId,
    maxDispatches: 4,
  });
  const finalCounts = messageCounts(fixture.runtime, fixture.organizationId);

  const checks = [
    check(
      "queued child: v3 snapshot captures one terminal handoff and v2 Actor Trace",
      fixture.snapshot.schemaVersion === "organization.snapshot.v3" &&
        fixture.snapshot.runtimeRecovery?.trace.schemaVersion === "trace.snapshot.v2" &&
        fixture.snapshot.handoffs.length === 1,
      {
        snapshot: fixture.snapshot.schemaVersion,
        actorTrace: fixture.snapshot.runtimeRecovery?.trace.schemaVersion,
        handoffs: fixture.snapshot.handoffs.length,
      }
    ),
    check(
      "queued child: source is delegated while its child and request remain queued",
      beforeSource?.status === "delegated" &&
        beforeChild?.status === "queued" &&
        beforeRequest?.status === "queued",
      { source: beforeSource?.status, child: beforeChild?.status, request: beforeRequest?.status }
    ),
    check(
      "queued child: clear establishes a cold boundary with no runtime residue",
      fixture.coldBoundary,
      fixture.coldBoundary
    ),
    check(
      "queued child: restore preserves root/parent/depth lineage",
      restoredSource.rootTaskId === fixture.sourceTaskId &&
        restoredChild.rootTaskId === fixture.sourceTaskId &&
        restoredChild.parentTaskId === fixture.sourceTaskId &&
        restoredChild.handoffDepth === 1,
      {
        sourceRoot: restoredSource.rootTaskId,
        childRoot: restoredChild.rootTaskId,
        parent: restoredChild.parentTaskId,
        depth: restoredChild.handoffDepth,
      }
    ),
    check(
      "queued child: restore does not duplicate child, request, or handoff record",
      fixture.runtime.listTasks(fixture.organizationId).length === 2 &&
        restoredCounts.requestCount === 1 &&
        restoredCounts.responseCount === 0 &&
        fixture.runtime.listHandoffs(fixture.organizationId).length === 1,
      {
        tasks: fixture.runtime.listTasks(fixture.organizationId).length,
        requests: restoredCounts.requestCount,
        responses: restoredCounts.responseCount,
        handoffs: fixture.runtime.listHandoffs(fixture.organizationId).length,
      }
    ),
    check(
      "queued child: bounded dispatch resumes with exactly the restored child",
      loop.dispatches === 1 &&
        loop.dispatchedTaskIds[0] === fixture.childTaskId &&
        loop.stopReason === "idle",
      loop
    ),
    check(
      "queued child: restored child completes and binds a single response",
      completedChild.status === "completed" &&
        handoff.status === "responded" &&
        completedCounts.responseCount === 1,
      { child: completedChild.status, handoff: handoff.status, responses: completedCounts.responseCount }
    ),
    check(
      "queued child: response correlation and causation point to the original request",
      response?.correlationId === fixture.handoffRequestId &&
        response?.causationMessageId === request?.messageId,
      {
        correlationId: response?.correlationId,
        causationMessageId: response?.causationMessageId,
        requestMessageId: request?.messageId,
      }
    ),
    check(
      "queued child: a second dispatch loop is idle",
      secondLoop.dispatches === 0 && secondLoop.stopReason === "idle",
      secondLoop
    ),
    check(
      "queued child: replay leaves exactly two tasks, one request, and one response",
      fixture.runtime.listTasks(fixture.organizationId).length === 2 &&
        finalCounts.requestCount === 1 &&
        finalCounts.responseCount === 1,
      {
        tasks: fixture.runtime.listTasks(fixture.organizationId).length,
        requests: finalCounts.requestCount,
        responses: finalCounts.responseCount,
      }
    ),
  ];
  fixture.runtime.clearOrganization(fixture.organizationId);
  return checks;
}

async function waitingChildRecoveryChecks(): Promise<CheckResult[]> {
  const fixture = await createHandoffFixture({
    organizationId: "org_handoff_recovery_waiting",
    stage: "waiting",
  });
  const beforeChild = fixture.snapshot.tasks.find(
    (task) => task.taskId === fixture.childTaskId
  );
  const beforeRequest = fixture.snapshot.messages.find(
    (message) => message.messageId === fixture.requestMessageId
  );
  const beforePending = fixture.snapshot.runtimeRecovery?.pendingRuns[0];

  fixture.runtime.restoreSnapshot(fixture.snapshot);
  const restoredPending = fixture.childRunId
    ? fixture.actorRuntime.dumpPendingRun(fixture.childRunId)
    : null;
  const restoredCounts = messageCounts(fixture.runtime, fixture.organizationId);
  if (!restoredPending?.pendingHumanInput || !fixture.childRunId) {
    throw new Error("Expected restored delegated child HumanInput pending state");
  }

  const completed = await fixture.runtime.continueTask({
    organizationId: fixture.organizationId,
    requestedByActorId: TARGET_ACTOR_ID,
    taskId: fixture.childTaskId,
    event: {
      type: "human_input_response",
      response: {
        humanInputRequestId: restoredPending.pendingHumanInput.humanInputRequestId,
        value: "approved after cold restore",
        respondedBy: TARGET_ACTOR_ID,
        respondedAt: new Date().toISOString(),
      },
    },
  });
  const completedCounts = messageCounts(fixture.runtime, fixture.organizationId);
  const handoff = fixture.runtime.listHandoffs(fixture.organizationId)[0];
  const response = completedCounts.messages.find(
    (message) => message.messageId === handoff.responseMessageId
  );
  let duplicateContinueRejected = false;
  try {
    await fixture.runtime.continueTask({
      organizationId: fixture.organizationId,
      requestedByActorId: TARGET_ACTOR_ID,
      taskId: fixture.childTaskId,
      event: {
        type: "human_input_response",
        response: {
          humanInputRequestId: restoredPending.pendingHumanInput.humanInputRequestId,
          value: "must not apply twice",
          respondedBy: TARGET_ACTOR_ID,
        },
      },
    });
  } catch (error) {
    duplicateContinueRejected =
      error instanceof OrganizationError && error.code === "invalid_state";
  }
  const afterRetryCounts = messageCounts(fixture.runtime, fixture.organizationId);
  const idle = await fixture.runtime.dispatchUntilIdle({
    organizationId: fixture.organizationId,
    maxDispatches: 2,
  });

  const checks = [
    check(
      "waiting child: snapshot binds one pending run to the delegated child",
      beforeChild?.status === "waiting_human_input" &&
        beforePending?.actorRunId === fixture.childRunId &&
        beforePending?.pendingKind === "human_input",
      {
        taskStatus: beforeChild?.status,
        pendingRunId: beforePending?.actorRunId,
        pendingKind: beforePending?.pendingKind,
      }
    ),
    check(
      "waiting child: dispatch acknowledged the original task_request before suspension",
      beforeRequest?.status === "acknowledged",
      beforeRequest?.status
    ),
    check(
      "waiting child: clear removes pending state, Actor Trace, and memory",
      fixture.coldBoundary,
      fixture.coldBoundary
    ),
    check(
      "waiting child: restore recreates the same pending run identity",
      restoredPending.actorRunId === fixture.childRunId &&
        restoredPending.pendingKind === "human_input",
      { actorRunId: restoredPending.actorRunId, kind: restoredPending.pendingKind }
    ),
    check(
      "waiting child: restore keeps a single child, request, and handoff",
      fixture.runtime.listTasks(fixture.organizationId).length === 2 &&
        restoredCounts.requestCount === 1 &&
        restoredCounts.responseCount === 0 &&
        fixture.runtime.listHandoffs(fixture.organizationId).length === 1,
      {
        tasks: fixture.runtime.listTasks(fixture.organizationId).length,
        requests: restoredCounts.requestCount,
        responses: restoredCounts.responseCount,
      }
    ),
    check(
      "waiting child: restored continuation completes the same Actor run",
      completed.task.status === "completed" &&
        completed.output.actorRunId === fixture.childRunId,
      { status: completed.task.status, actorRunId: completed.output.actorRunId }
    ),
    check(
      "waiting child: completion enqueues exactly one correlated response",
      completedCounts.responseCount === 1 &&
        response?.correlationId === fixture.handoffRequestId &&
        response?.causationMessageId === fixture.requestMessageId,
      {
        responses: completedCounts.responseCount,
        correlation: response?.correlationId,
        causation: response?.causationMessageId,
      }
    ),
    check(
      "waiting child: completed response carries the recovered result",
      response?.type === "task_response" &&
        (response.payload as Record<string, unknown>).status === "completed" &&
        isDeepStrictEqual(
          (response.payload as Record<string, unknown>).result,
          completed.task.result
        ),
      response?.payload
    ),
    check(
      "waiting child: duplicate continuation is rejected without another response",
      duplicateContinueRejected && afterRetryCounts.responseCount === 1,
      { duplicateContinueRejected, responses: afterRetryCounts.responseCount }
    ),
    check(
      "waiting child: no queued work remains after continuation",
      idle.dispatches === 0 && idle.stopReason === "idle" && idle.blockedTaskIds.length === 0,
      idle
    ),
  ];
  fixture.runtime.clearOrganization(fixture.organizationId);
  return checks;
}

async function terminalResponseRecoveryChecks(): Promise<CheckResult[]> {
  const fixture = await createHandoffFixture({
    organizationId: "org_handoff_recovery_terminal",
    stage: "terminal",
    deliverResponse: true,
  });
  const beforeChild = fixture.snapshot.tasks.find(
    (task) => task.taskId === fixture.childTaskId
  );
  const beforeResponse = fixture.snapshot.messages.find(
    (message) => message.messageId === fixture.responseMessageId
  );

  fixture.runtime.restoreSnapshot(fixture.snapshot);
  const restoredChild = fixture.runtime.getTask(fixture.organizationId, fixture.childTaskId);
  const restoredCounts = messageCounts(fixture.runtime, fixture.organizationId);
  const restoredResponse = restoredCounts.messages.find(
    (message) => message.messageId === fixture.responseMessageId
  );
  const redelivered = fixture.runtime.receiveNextMessage({
    organizationId: fixture.organizationId,
    actorId: SOURCE_ACTOR_ID,
  });
  const acknowledged = redelivered
    ? fixture.runtime.acknowledgeMessage({
        organizationId: fixture.organizationId,
        actorId: SOURCE_ACTOR_ID,
        messageId: redelivered.messageId,
      })
    : null;
  const nextMessage = fixture.runtime.receiveNextMessage({
    organizationId: fixture.organizationId,
    actorId: SOURCE_ACTOR_ID,
  });
  const idle = await fixture.runtime.dispatchUntilIdle({
    organizationId: fixture.organizationId,
    maxDispatches: 2,
  });
  const finalCounts = messageCounts(fixture.runtime, fixture.organizationId);
  const request = finalCounts.messages.find(
    (message) => message.messageId === fixture.requestMessageId
  );

  const checks = [
    check(
      "terminal child: pre-snapshot child is completed with a delivered response",
      beforeChild?.status === "completed" &&
        beforeResponse?.status === "delivered" &&
        fixture.deliveredResponseId === fixture.responseMessageId,
      {
        child: beforeChild?.status,
        response: beforeResponse?.status,
        deliveredResponseId: fixture.deliveredResponseId,
      }
    ),
    check(
      "terminal child: snapshot has exactly one responded handoff",
      fixture.snapshot.handoffs.length === 1 &&
        fixture.snapshot.handoffs[0].status === "responded" &&
        fixture.snapshot.handoffs[0].responseMessageId === fixture.responseMessageId,
      fixture.snapshot.handoffs[0]
    ),
    check(
      "terminal child: clear establishes a cold terminal boundary",
      fixture.coldBoundary,
      fixture.coldBoundary
    ),
    check(
      "terminal child: restore preserves result and delivered response lifecycle",
      restoredChild.status === "completed" &&
        restoredResponse?.status === "delivered" &&
        restoredCounts.responseCount === 1,
      {
        child: restoredChild.status,
        response: restoredResponse?.status,
        responses: restoredCounts.responseCount,
      }
    ),
    check(
      "terminal child: receive returns the same delivered response without duplication",
      redelivered?.messageId === fixture.responseMessageId &&
        redelivered?.status === "delivered" &&
        restoredCounts.responseCount === 1,
      { messageId: redelivered?.messageId, status: redelivered?.status }
    ),
    check(
      "terminal child: restored response can be acknowledged",
      acknowledged?.messageId === fixture.responseMessageId &&
        acknowledged?.status === "acknowledged",
      { messageId: acknowledged?.messageId, status: acknowledged?.status }
    ),
    check(
      "terminal child: acknowledged response is no longer receivable",
      nextMessage === null,
      nextMessage
    ),
    check(
      "terminal child: restored terminal organization has no dispatch work",
      idle.dispatches === 0 && idle.stopReason === "idle",
      idle
    ),
    check(
      "terminal child: response retains original correlation, causation, and result",
      restoredResponse?.correlationId === fixture.handoffRequestId &&
        restoredResponse.causationMessageId === request?.messageId &&
        isDeepStrictEqual(
          (restoredResponse.payload as Record<string, unknown>).result,
          restoredChild.result
        ),
      {
        correlation: restoredResponse?.correlationId,
        causation: restoredResponse?.causationMessageId,
        payload: restoredResponse?.payload,
      }
    ),
    check(
      "terminal child: recovery leaves exactly one child, request, and response",
      fixture.runtime.listTasks(fixture.organizationId).length === 2 &&
        finalCounts.requestCount === 1 &&
        finalCounts.responseCount === 1,
      {
        tasks: fixture.runtime.listTasks(fixture.organizationId).length,
        requests: finalCounts.requestCount,
        responses: finalCounts.responseCount,
      }
    ),
  ];
  fixture.runtime.clearOrganization(fixture.organizationId);
  return checks;
}

async function migrationChecks(): Promise<CheckResult[]> {
  const organizationId = "org_handoff_recovery_migration";
  const actorRuntime = new ActorRuntime();
  const runtime = new OrganizationRuntime(actorRuntime);
  runtime.createOrganization({ organizationId, name: "Pure v2 Migration" });
  runtime.registerActor(organizationId, {
    actorConfig: actorConfig(organizationId, SOURCE_ACTOR_ID, [COMPLETE_SKILL_ID]),
    skills: [COMPLETE_SKILL],
    capabilities: SOURCE_CAPABILITIES,
  });
  const root = runtime.createTask({
    organizationId,
    requestedByActorId: SOURCE_ACTOR_ID,
    title: "Legacy root task",
    input: { text: "legacy", payload: { case_id: "legacy-case", original_text: "legacy" } },
  });
  runtime.assignTask({
    organizationId,
    requestedByActorId: SOURCE_ACTOR_ID,
    taskId: root.taskId,
    actorId: SOURCE_ACTOR_ID,
    skillId: COMPLETE_SKILL_ID,
  });
  runtime.enqueueTask({
    organizationId,
    requestedByActorId: SOURCE_ACTOR_ID,
    taskId: root.taskId,
  });
  const completed = await runtime.dispatchNext({ organizationId });
  if (!completed || completed.task.status !== "completed") {
    throw new Error("Expected a real no-handoff snapshot source task");
  }
  const current = runtime.dumpSnapshot({
    organizationId,
    requestedByActorId: SOURCE_ACTOR_ID,
  });
  runtime.clearOrganization(organizationId);

  const legacy = structuredClone(current) as unknown as Record<string, unknown>;
  legacy.schemaVersion = LEGACY_ORGANIZATION_SNAPSHOT_SCHEMA_VERSION;
  delete legacy.handoffs;
  for (const actor of legacy.actors as Array<Record<string, unknown>>) {
    actor.capabilities = (actor.capabilities as string[]).filter(
      (capability) => capability !== "task:delegate"
    );
    actor.status = "inactive";
  }
  for (const task of legacy.tasks as Array<Record<string, unknown>>) {
    delete task.rootTaskId;
    delete task.parentTaskId;
    delete task.handoffDepth;
    delete task.incomingHandoffRequestId;
    delete task.outgoingHandoffRequestId;
  }
  for (const message of legacy.messages as Array<Record<string, unknown>>) {
    delete message.correlationId;
    delete message.causationMessageId;
  }
  for (const event of legacy.trace as Array<Record<string, unknown>>) {
    delete event.handoffRequestId;
  }
  const legacyRecovery = legacy.runtimeRecovery as Record<string, unknown>;
  const legacyActorTrace = legacyRecovery.trace as Record<string, unknown>;
  legacyActorTrace.schemaVersion = LEGACY_TRACE_SNAPSHOT_SCHEMA_VERSION;

  const legacyBefore = structuredClone(legacy);
  const migrated = normalizeOrganizationSnapshot(legacy);
  const inputUnchanged = isDeepStrictEqual(legacy, legacyBefore);
  const originalLegacyTitle = (legacy.tasks as Array<Record<string, unknown>>)[0].title;
  migrated.tasks[0].title = "mutated returned clone";
  const outputDetached =
    (legacy.tasks as Array<Record<string, unknown>>)[0].title === originalLegacyTitle;
  migrated.tasks[0].title = String(originalLegacyTitle);
  const migratedBeforeRestore = structuredClone(migrated);

  runtime.restoreSnapshot(migrated);
  const restoredTask = runtime.getTask(organizationId, root.taskId);
  const restoredHandoffs = runtime.listHandoffs(organizationId);
  const restoreDidNotMutate = isDeepStrictEqual(migrated, migratedBeforeRestore);

  const checks = [
    check(
      "migration: normalization never mutates the supplied v2 snapshot",
      inputUnchanged,
      inputUnchanged
    ),
    check(
      "migration: normalization returns detached objects",
      outputDetached,
      { legacyTitle: originalLegacyTitle, migratedTitle: migrated.tasks[0].title }
    ),
    check(
      "migration: organization.snapshot.v2 becomes organization.snapshot.v3",
      legacy.schemaVersion === "organization.snapshot.v2" &&
        migrated.schemaVersion === "organization.snapshot.v3",
      { input: legacy.schemaVersion, output: migrated.schemaVersion }
    ),
    check(
      "migration: trace.snapshot.v1 becomes trace.snapshot.v2",
      legacyActorTrace.schemaVersion === "trace.snapshot.v1" &&
        migrated.runtimeRecovery?.trace.schemaVersion === "trace.snapshot.v2",
      { input: legacyActorTrace.schemaVersion, output: migrated.runtimeRecovery?.trace.schemaVersion }
    ),
    check(
      "migration: every legacy task becomes a depth-zero self-root",
      migrated.tasks.every((task) =>
        task.rootTaskId === task.taskId &&
        task.handoffDepth === 0 &&
        task.parentTaskId === undefined &&
        task.incomingHandoffRequestId === undefined &&
        task.outgoingHandoffRequestId === undefined
      ),
      migrated.tasks.map((task) => ({
        taskId: task.taskId,
        rootTaskId: task.rootTaskId,
        depth: task.handoffDepth,
      }))
    ),
    check(
      "migration: v2 history does not invent handoff records or task:delegate authority",
      migrated.handoffs.length === 0 &&
        migrated.actors.every((actor) => !actor.capabilities.includes("task:delegate")),
      {
        handoffs: migrated.handoffs.length,
        delegatedActors: migrated.actors.filter((actor) =>
          actor.capabilities.includes("task:delegate")
        ).length,
      }
    ),
    check(
      "migration: inactive legacy Actor keeps its historical completed task restorable",
      restoredTask.status === "completed" &&
        migrated.actors.every((actor) => actor.status === "inactive") &&
        restoredTask.actorRunId === completed.output.actorRunId &&
        traceLogger.getTrace(completed.output.actorRunId)?.status === "completed",
      {
        actorStatuses: migrated.actors.map((actor) => actor.status),
        taskStatus: restoredTask.status,
        actorRunId: restoredTask.actorRunId,
        traceStatus: traceLogger.getTrace(completed.output.actorRunId)?.status,
      }
    ),
    check(
      "migration: restore also treats the normalized snapshot as immutable input",
      restoreDidNotMutate && restoredHandoffs.length === 0,
      { restoreDidNotMutate, handoffs: restoredHandoffs.length }
    ),
  ];
  runtime.clearOrganization(organizationId);
  return checks;
}

function sourceAndChild(snapshot: OrganizationSnapshot) {
  const handoff = snapshot.handoffs[0];
  const source = snapshot.tasks.find((task) => task.taskId === handoff.sourceTaskId);
  const child = snapshot.tasks.find((task) => task.taskId === handoff.childTaskId);
  if (!source || !child) throw new Error("Expected source and child tasks in handoff snapshot");
  return { handoff, source, child };
}

function requestAndResponse(snapshot: OrganizationSnapshot) {
  const handoff = snapshot.handoffs[0];
  const request = snapshot.messages.find(
    (message) => message.messageId === handoff.requestMessageId
  );
  const response = snapshot.messages.find(
    (message) => message.messageId === handoff.responseMessageId
  );
  if (!request || !response) throw new Error("Expected request and response messages");
  return { handoff, request, response };
}

function actorRunIds(snapshot: OrganizationSnapshot): string[] {
  return snapshot.tasks.flatMap((task) => task.actorRunId ? [task.actorRunId] : []);
}

function organizationIsAbsent(runtime: OrganizationRuntime, organizationId: string): boolean {
  try {
    runtime.getOrganization(organizationId);
    return false;
  } catch (error) {
    return error instanceof OrganizationError && error.code === "not_found";
  }
}

function probeRejectedRestore(
  validSnapshot: OrganizationSnapshot,
  mutate: (candidate: OrganizationSnapshot) => void
): RejectedRestoreProbe {
  const actorRuntime = new ActorRuntime();
  const runtime = new OrganizationRuntime(actorRuntime);
  const candidate = structuredClone(validSnapshot);
  mutate(candidate);

  let rejected = false;
  let errorMessage = "restore unexpectedly succeeded";
  try {
    runtime.restoreSnapshot(candidate);
  } catch (error) {
    rejected = true;
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const organizationId = validSnapshot.organization.organizationId;
  const runIds = actorRunIds(validSnapshot);
  const organizationAbsent = organizationIsAbsent(runtime, organizationId);
  const residue = hasNoRuntimeResidue(actorRuntime, organizationId, runIds);

  // Clean up an unexpectedly accepted candidate so the valid retry remains a
  // useful ownership/rollback probe rather than cascading into later cases.
  if (!organizationAbsent) {
    runtime.clearOrganization(organizationId);
  } else {
    for (const actorRunId of runIds) {
      try {
        actorRuntime.clearRun(actorRunId);
      } catch {
        // The residue checks above retain the failure signal.
      }
    }
    traceLogger.clearRuns(runIds);
    memoryService.clearOrganization(organizationId);
  }

  let validRetrySucceeded = false;
  try {
    runtime.restoreSnapshot(validSnapshot);
    validRetrySucceeded = true;
    runtime.clearOrganization(organizationId);
  } catch {
    validRetrySucceeded = false;
  }

  return {
    rejected,
    errorMessage,
    organizationAbsent,
    actorRuntimeAbsent: residue.actorRuntimeAbsent,
    actorTraceAbsent: residue.actorTraceAbsent,
    memoryAbsent: residue.memoryAbsent,
    validRetrySucceeded,
  };
}

function rejectedRestoreCheck(label: string, probe: RejectedRestoreProbe): CheckResult {
  return check(
    `tamper: ${label} is atomically rejected with zero residue`,
    probe.rejected &&
      probe.organizationAbsent &&
      probe.actorRuntimeAbsent &&
      probe.actorTraceAbsent &&
      probe.memoryAbsent &&
      probe.validRetrySucceeded,
    probe
  );
}

async function tamperChecks(): Promise<CheckResult[]> {
  const terminal = await createHandoffFixture({
    organizationId: "org_handoff_recovery_tamper_terminal",
    stage: "terminal",
  });
  const waiting = await createHandoffFixture({
    organizationId: "org_handoff_recovery_tamper_waiting",
    stage: "waiting",
  });

  const cases: Array<{
    label: string;
    snapshot: OrganizationSnapshot;
    mutate: (candidate: OrganizationSnapshot) => void;
  }> = [
    {
      label: "forged child parentTaskId",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        sourceAndChild(candidate).child.parentTaskId = "task_missing_parent";
      },
    },
    {
      label: "forged handoff childTaskId",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        candidate.handoffs[0].childTaskId = "task_missing_child";
      },
    },
    {
      label: "request correlation mismatch",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        requestAndResponse(candidate).request.correlationId = "hreq_forged_request";
      },
    },
    {
      label: "response correlation mismatch",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        requestAndResponse(candidate).response.correlationId = "hreq_orphan_response";
      },
    },
    {
      label: "response causation mismatch",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        requestAndResponse(candidate).response.causationMessageId = "msg_missing_cause";
      },
    },
    {
      label: "valid-but-inconsistent target Skill",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        candidate.handoffs[0].targetSkillId = WAIT_SKILL_ID;
      },
    },
    {
      label: "source Skill declaration rewritten after handoff",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        const { source } = sourceAndChild(candidate);
        const actor = candidate.actors.find(
          (item) => item.actorId === source.assignedTo
        );
        const skill = source.skillId ? actor?.skills[source.skillId] : undefined;
        const step = skill?.steps.find((item) => item.step_key === "delegate");
        if (!step) throw new Error("Expected the source handoff Skill declaration");
        step.target_skill_id = WAIT_SKILL_ID;
        step.reason = "A rewritten policy selects a different route";
      },
    },
    {
      label: "handoff fingerprint mismatch",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        candidate.handoffs[0].fingerprint = "f".repeat(64);
      },
    },
    {
      label: "forged Actor handoff Trace",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        const { source } = sourceAndChild(candidate);
        const trace = candidate.runtimeRecovery!.trace.traces.find(
          (item) => item.actorRunId === source.actorRunId
        );
        const event = trace?.events.find((item) => item.eventType === "handoff");
        if (!event) throw new Error("Expected source handoff Trace event");
        event.data.reason = "forged recovery route";
      },
    },
    {
      label: "orphan duplicate response",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        const { response } = requestAndResponse(candidate);
        const orphan = structuredClone(response);
        orphan.messageId = `${response.messageId}_orphan`;
        candidate.messages.push(orphan);
        candidate.inboxOrder[orphan.toActorId].push(orphan.messageId);
      },
    },
    {
      label: "response payload diverging from child result",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        requestAndResponse(candidate).response.payload = {
          handoffRequestId: candidate.handoffs[0].handoffRequestId,
          sourceTaskId: candidate.handoffs[0].sourceTaskId,
          childTaskId: candidate.handoffs[0].childTaskId,
          status: "completed",
          result: { forged: true },
        };
      },
    },
    {
      label: "child handoff depth reset",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        sourceAndChild(candidate).child.handoffDepth = 0;
      },
    },
    {
      label: "child rootTaskId mismatch",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        sourceAndChild(candidate).child.rootTaskId = "task_forged_root";
      },
    },
    {
      label: "source rootTaskId mismatch",
      snapshot: terminal.snapshot,
      mutate: (candidate) => {
        sourceAndChild(candidate).source.rootTaskId = "task_forged_source_root";
      },
    },
    {
      label: "source terminal run forged as PendingRun",
      snapshot: waiting.snapshot,
      mutate: (candidate) => {
        const { source } = sourceAndChild(candidate);
        const pending = candidate.runtimeRecovery?.pendingRuns[0];
        if (!pending || !source.actorRunId) throw new Error("Expected waiting child PendingRun");
        pending.actorRunId = source.actorRunId;
      },
    },
  ];

  return cases.map((scenario) => rejectedRestoreCheck(
    scenario.label,
    probeRejectedRestore(scenario.snapshot, scenario.mutate)
  ));
}

async function main(): Promise<void> {
  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();

  const checks: CheckResult[] = [];
  checks.push(...await queuedChildRecoveryChecks());
  checks.push(...await waitingChildRecoveryChecks());
  checks.push(...await terminalResponseRecoveryChecks());
  checks.push(...await migrationChecks());
  checks.push(...await tamperChecks());

  console.log("=".repeat(78));
  console.log(`  ForeverThinking v0.6.0 — Organization Handoff Recovery (${checks.length} checks)`);
  console.log("=".repeat(78));
  let passed = 0;
  checks.forEach((result, index) => {
    if (result.pass) passed += 1;
    console.log(`${result.pass ? "✅" : "❌"} ${String(index + 1).padStart(2, "0")}. ${result.label}`);
    console.log(`    ${result.detail}`);
  });
  console.log(`Passed: ${passed}/${checks.length}`);
  if (passed !== checks.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Organization Handoff Recovery Demo failed:", error);
  process.exit(1);
});
