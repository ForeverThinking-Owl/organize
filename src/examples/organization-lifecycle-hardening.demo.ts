import { approvalGate } from "../approvals/approval-gate";
import type { ActorConfig } from "../core/types/actor";
import type { SkillConfig } from "../core/types/skill";
import type { ToolCallRequest, ToolDefinition, ToolObservation } from "../core/types/tool";
import { memoryService } from "../memory/memory-service";
import { OrganizationError } from "../organization/organization-error";
import type { OrganizationCapability } from "../organization/organization-permission";
import { OrganizationRuntime } from "../organization/organization-runtime";
import { actorRuntime } from "../runtime/actor-runtime";
import type { MockToolExecutor } from "../tools/mock-tools";
import { toolGateway } from "../tools/tool-gateway";
import { traceLogger } from "../trace/trace-logger";

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

interface DeferredCall {
  request: ToolCallRequest;
  release: () => void;
}

class DeferredToolExecutor implements MockToolExecutor {
  readonly calls: DeferredCall[] = [];
  private waiters: Array<{ count: number; resolve: () => void }> = [];

  async execute(request: ToolCallRequest): Promise<ToolObservation> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.calls.push({ request, release });
    this.flushWaiters();
    await released;
    return {
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      status: "success",
      data: { call: this.calls.length, value: request.arguments.value },
      executedAt: new Date().toISOString(),
    };
  }

  waitForCalls(count: number): Promise<void> {
    if (this.calls.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push({ count, resolve });
    });
  }

  release(index: number): void {
    const call = this.calls[index];
    if (!call) throw new Error(`Deferred call ${index} does not exist`);
    call.release();
  }

  private flushWaiters(): void {
    const ready = this.waiters.filter((waiter) => this.calls.length >= waiter.count);
    this.waiters = this.waiters.filter((waiter) => this.calls.length < waiter.count);
    ready.forEach((waiter) => waiter.resolve());
  }
}

const TOOL: ToolDefinition = {
  toolName: "release_hardening_deferred_tool",
  description: "A controllable tool used to expose organization lifecycle races",
  direction: "read",
  riskLevel: "low",
};

const DIRECT_SKILL: SkillConfig = {
  skill_id: "deferred_dispatch",
  name: "Deferred Dispatch",
  steps: [
    {
      step_key: "call",
      type: "tool_call",
      tool_name: TOOL.toolName,
      input_mapping: { value: "dispatch" },
      output_key: "tool_result",
    },
    {
      step_key: "return",
      type: "return",
      output_mapping: { status: "dispatch-completed" },
    },
  ],
};

const CONTINUE_SKILL: SkillConfig = {
  skill_id: "deferred_continue",
  name: "Deferred Continue",
  steps: [
    {
      step_key: "input",
      type: "human_input",
      prompt: "Continue into the deferred tool",
      output_key: "input",
    },
    {
      step_key: "call",
      type: "tool_call",
      tool_name: TOOL.toolName,
      input_mapping: { value: "{{outputs.input}}" },
      output_key: "tool_result",
    },
    {
      step_key: "return",
      type: "return",
      output_mapping: { status: "continue-completed" },
    },
  ],
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

function actorConfig(organizationId: string, actorId: string): ActorConfig {
  return {
    actor_id: actorId,
    organization_id: organizationId,
    name: actorId,
    type: "ai",
    role: actorId,
    responsibility: "Exercise organization lifecycle hardening",
    autonomy_level: "L3_low_risk_execute",
    memory: [`${organizationId}:${actorId}:lifecycle`],
    permissions: {
      allowed_tools: [TOOL.toolName],
      denied_tools: [],
      allowed_skills: [DIRECT_SKILL.skill_id, CONTINUE_SKILL.skill_id],
    },
    approval_judgment: { must_request_approval_when: [] },
  };
}

function clearRejected(runtime: OrganizationRuntime, organizationId: string): boolean {
  try {
    runtime.clearOrganization(organizationId);
    return false;
  } catch (error) {
    return error instanceof OrganizationError && error.code === "invalid_state";
  }
}

function organizationMissing(runtime: OrganizationRuntime, organizationId: string): boolean {
  try {
    runtime.getOrganization(organizationId);
    return false;
  } catch (error) {
    return error instanceof OrganizationError && error.code === "not_found";
  }
}

async function main(): Promise<void> {
  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();

  const executor = new DeferredToolExecutor();
  toolGateway.registerDefinition(TOOL);
  toolGateway.registerExecutor(TOOL.toolName, executor);

  const invalidOrganizationId = "org_lifecycle_invalid_create";
  const validationRuntime = new OrganizationRuntime(actorRuntime);
  let invalidOrganizationRejected = false;
  try {
    validationRuntime.createOrganization({
      organizationId: invalidOrganizationId,
      name: (() => "not JSON") as unknown as string,
    });
  } catch (error) {
    invalidOrganizationRejected =
      error instanceof OrganizationError && error.code === "invalid_input";
  }
  const reclaimedAfterInvalidCreate = validationRuntime.createOrganization({
    organizationId: invalidOrganizationId,
    name: "Valid after rejected create",
  });
  validationRuntime.clearOrganization(reclaimedAfterInvalidCreate.organizationId);

  const runtime = new OrganizationRuntime(actorRuntime);
  const organization = runtime.createOrganization({
    organizationId: "org_lifecycle_hardening",
    name: "Lifecycle Hardening",
  });
  runtime.registerActor(organization.organizationId, {
    actorConfig: actorConfig(organization.organizationId, "manager"),
    skills: [DIRECT_SKILL, CONTINUE_SKILL],
    capabilities: CAPABILITIES,
  });
  runtime.registerActor(organization.organizationId, {
    actorConfig: actorConfig(organization.organizationId, "worker"),
    skills: [DIRECT_SKILL, CONTINUE_SKILL],
    capabilities: CAPABILITIES,
  }, "manager");

  const actorCountBeforeInvalidRegistration = runtime.listActors(organization.organizationId).length;
  const actorIdsBeforeInvalidRegistration = runtime.getOrganization(organization.organizationId).actorIds;
  const traceCountBeforeInvalidRegistration = runtime.getTrace(organization.organizationId).length;
  const poisonedSkill = {
    ...structuredClone(DIRECT_SKILL),
    poison: 1n,
  } as unknown as SkillConfig;
  let invalidSkillRegistrationRejected = false;
  try {
    runtime.registerActor(organization.organizationId, {
      actorConfig: actorConfig(organization.organizationId, "poisoned_actor"),
      skills: [poisonedSkill],
      capabilities: CAPABILITIES,
    }, "manager");
  } catch (error) {
    invalidSkillRegistrationRejected =
      error instanceof OrganizationError && error.code === "invalid_input";
  }
  const invalidSkillRegistrationLeavesNoGhost =
    invalidSkillRegistrationRejected &&
    runtime.listActors(organization.organizationId).length === actorCountBeforeInvalidRegistration &&
    JSON.stringify(runtime.getOrganization(organization.organizationId).actorIds) ===
      JSON.stringify(actorIdsBeforeInvalidRegistration) &&
    runtime.getTrace(organization.organizationId).length === traceCountBeforeInvalidRegistration;

  const taskCountBeforeInvalidCreate = runtime.listTasks(organization.organizationId).length;
  let invalidTaskRejected = false;
  try {
    runtime.createTask({
      organizationId: organization.organizationId,
      requestedByActorId: "manager",
      title: (() => "not JSON") as unknown as string,
      input: { text: "must not create a ghost task" },
    });
  } catch (error) {
    invalidTaskRejected = error instanceof OrganizationError && error.code === "invalid_input";
  }
  const invalidTaskLeavesNoGhost =
    invalidTaskRejected &&
    runtime.listTasks(organization.organizationId).length === taskCountBeforeInvalidCreate;

  let invalidMessageTypeRejected = false;
  try {
    runtime.sendMessage({
      organizationId: organization.organizationId,
      fromActorId: "manager",
      toActorId: "worker",
      type: "forged_type" as "information",
      payload: { text: "must not enqueue a ghost message" },
    });
  } catch (error) {
    invalidMessageTypeRejected =
      error instanceof OrganizationError && error.code === "invalid_input";
  }
  const invalidMessageLeavesNoGhost =
    invalidMessageTypeRejected &&
    runtime.listInbox({
      organizationId: organization.organizationId,
      requestedByActorId: "worker",
    }).length === 0;

  const dispatchTask = runtime.createTask({
    organizationId: organization.organizationId,
    requestedByActorId: "manager",
    title: "Deferred dispatch",
    input: { text: "dispatch" },
  });
  runtime.assignTask({
    organizationId: organization.organizationId,
    requestedByActorId: "manager",
    taskId: dispatchTask.taskId,
    actorId: "worker",
    skillId: DIRECT_SKILL.skill_id,
  });
  runtime.enqueueTask({
    organizationId: organization.organizationId,
    requestedByActorId: "manager",
    taskId: dispatchTask.taskId,
  });

  const dispatchPromise = runtime.dispatchNext({ organizationId: organization.organizationId });
  await executor.waitForCalls(1);
  const clearDuringDispatchRejected = clearRejected(runtime, organization.organizationId);
  const shadowRuntime = new OrganizationRuntime(actorRuntime);
  let duplicateRuntimeOwnershipRejected = false;
  try {
    shadowRuntime.createOrganization({
      organizationId: organization.organizationId,
      name: "Shadow Lifecycle Runtime",
    });
  } catch (error) {
    duplicateRuntimeOwnershipRejected =
      error instanceof OrganizationError && error.code === "already_exists";
  }
  shadowRuntime.clearOrganization(organization.organizationId);
  const memoryPreservedAfterCrossRuntimeClear =
    memoryService.dumpOrganizationSnapshot(organization.organizationId).memories.length > 0;
  const dispatchTaskWhileActive = runtime.getTask(organization.organizationId, dispatchTask.taskId);
  executor.release(0);
  const dispatched = await dispatchPromise;
  if (!dispatched) throw new Error("Expected deferred dispatch result");

  const continueTask = runtime.createTask({
    organizationId: organization.organizationId,
    requestedByActorId: "manager",
    title: "Deferred continuation",
    input: { text: "continue" },
  });
  runtime.assignTask({
    organizationId: organization.organizationId,
    requestedByActorId: "manager",
    taskId: continueTask.taskId,
    actorId: "worker",
    skillId: CONTINUE_SKILL.skill_id,
  });
  runtime.enqueueTask({
    organizationId: organization.organizationId,
    requestedByActorId: "manager",
    taskId: continueTask.taskId,
  });
  const waiting = await runtime.dispatchNext({ organizationId: organization.organizationId });
  if (!waiting?.output.pendingHumanInput) throw new Error("Expected pending human input");
  shadowRuntime.clearOrganization(organization.organizationId);
  const idlePendingPreservedAfterCrossRuntimeClear =
    memoryService.dumpOrganizationSnapshot(organization.organizationId).memories.length > 0 &&
    actorRuntime.dumpPendingRun(waiting.output.actorRunId)?.pendingKind === "human_input";

  const continuePromise = runtime.continueTask({
    organizationId: organization.organizationId,
    requestedByActorId: "worker",
    taskId: continueTask.taskId,
    event: {
      type: "human_input_response",
      response: {
        humanInputRequestId: waiting.output.pendingHumanInput.humanInputRequestId,
        value: "continue-value",
        respondedBy: "worker",
      },
    },
  });
  await executor.waitForCalls(2);
  const clearDuringContinueRejected = clearRejected(runtime, organization.organizationId);
  shadowRuntime.clearOrganization(organization.organizationId);
  const activeContinuationPreservedAfterCrossRuntimeClear =
    memoryService.dumpOrganizationSnapshot(organization.organizationId).memories.length > 0;
  const continueTaskWhileActive = runtime.getTask(organization.organizationId, continueTask.taskId);
  executor.release(1);
  const continued = await continuePromise;

  const actorRunIds = [dispatched.output.actorRunId, continued.output.actorRunId];
  runtime.clearOrganization(organization.organizationId);
  shadowRuntime.clearOrganization(organization.organizationId);

  const checks: CheckResult[] = [
    {
      label: "invalid organization create leaves no ghost state or ownership",
      pass: invalidOrganizationRejected && reclaimedAfterInvalidCreate.organizationId === invalidOrganizationId,
      detail: `${invalidOrganizationRejected}/${reclaimedAfterInvalidCreate.organizationId}`,
    },
    {
      label: "invalid Task fields are rejected before mutation",
      pass: invalidTaskLeavesNoGhost,
      detail: String(invalidTaskLeavesNoGhost),
    },
    {
      label: "invalid Message type is rejected before mutation",
      pass: invalidMessageLeavesNoGhost,
      detail: String(invalidMessageLeavesNoGhost),
    },
    {
      label: "invalid Skill registration leaves no Actor or Trace ghost state",
      pass: invalidSkillRegistrationLeavesNoGhost,
      detail: String(invalidSkillRegistrationLeavesNoGhost),
    },
    {
      label: "clear is rejected while dispatch is in flight",
      pass: clearDuringDispatchRejected,
      detail: String(clearDuringDispatchRejected),
    },
    {
      label: "dispatch task remains attached while active",
      pass: dispatchTaskWhileActive.status === "running",
      detail: dispatchTaskWhileActive.status,
    },
    {
      label: "a second runtime cannot claim an already loaded organization",
      pass: duplicateRuntimeOwnershipRejected,
      detail: String(duplicateRuntimeOwnershipRejected),
    },
    {
      label: "rejected cross-runtime clear preserves organization memory",
      pass: memoryPreservedAfterCrossRuntimeClear,
      detail: String(memoryPreservedAfterCrossRuntimeClear),
    },
    {
      label: "deferred dispatch completes normally",
      pass: dispatched.task.status === "completed",
      detail: dispatched.task.status,
    },
    {
      label: "clear is rejected while continuation is in flight",
      pass: clearDuringContinueRejected,
      detail: String(clearDuringContinueRejected),
    },
    {
      label: "continued task remains attached while active",
      pass: continueTaskWhileActive.status === "running",
      detail: continueTaskWhileActive.status,
    },
    {
      label: "an unowned runtime cannot clear an idle pending organization",
      pass: idlePendingPreservedAfterCrossRuntimeClear,
      detail: String(idlePendingPreservedAfterCrossRuntimeClear),
    },
    {
      label: "an unowned runtime cannot clear shared state during continuation",
      pass: activeContinuationPreservedAfterCrossRuntimeClear,
      detail: String(activeContinuationPreservedAfterCrossRuntimeClear),
    },
    {
      label: "deferred continuation completes the original run",
      pass:
        continued.task.status === "completed" &&
        continued.output.actorRunId === waiting.output.actorRunId,
      detail: `${continued.task.status}/${continued.output.actorRunId}`,
    },
    {
      label: "each active operation executes its tool exactly once",
      pass: executor.calls.length === 2,
      detail: String(executor.calls.length),
    },
    {
      label: "clear succeeds after active operations finish",
      pass: organizationMissing(runtime, organization.organizationId),
      detail: organization.organizationId,
    },
    {
      label: "final clear removes Actor traces",
      pass: actorRunIds.every((actorRunId) => traceLogger.getTrace(actorRunId) === undefined),
      detail: actorRunIds.join(","),
    },
    {
      label: "final clear removes pending runs",
      pass: actorRunIds.every((actorRunId) => actorRuntime.dumpPendingRun(actorRunId) === null),
      detail: actorRunIds.join(","),
    },
    {
      label: "final clear removes organization memory",
      pass:
        memoryService.dumpOrganizationSnapshot(organization.organizationId).memories.length === 0,
      detail: String(memoryService.dumpOrganizationSnapshot(organization.organizationId).memories.length),
    },
  ];

  console.log("=".repeat(72));
  console.log(`  ForeverThinking v0.5.0 — Organization Lifecycle Hardening (${checks.length} checks)`);
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
  console.error("Organization Lifecycle Hardening Demo failed:", error);
  process.exit(1);
});
