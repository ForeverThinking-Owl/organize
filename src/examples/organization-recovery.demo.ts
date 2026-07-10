import { rm } from "node:fs/promises";
import { approvalGate } from "../approvals/approval-gate";
import type { ActorConfig } from "../core/types/actor";
import type { SkillConfig } from "../core/types/skill";
import { memoryService } from "../memory/memory-service";
import { JsonOrganizationStore } from "../organization/json-organization-store";
import type { OrganizationStore } from "../organization/organization-store";
import { OrganizationError } from "../organization/organization-error";
import { OrganizationRuntime } from "../organization/organization-runtime";
import type { OrganizationCapability } from "../organization/organization-permission";
import type { OrganizationSnapshot } from "../organization/organization-snapshot";
import { actorRuntime } from "../runtime/actor-runtime";
import { traceLogger } from "../trace/trace-logger";

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

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

const COMPLETE_SKILL: SkillConfig = {
  skill_id: "complete_task",
  name: "Complete Task",
  steps: [{
    step_key: "return",
    type: "return",
    output_mapping: {
      status: "completed",
      task_id: "{{context.organization_task_id}}",
    },
  }],
};

const WAIT_SKILL: SkillConfig = {
  skill_id: "wait_for_review",
  name: "Wait For Review",
  steps: [
    {
      step_key: "review",
      type: "human_input",
      prompt: "Review this task",
      output_key: "review",
    },
    {
      step_key: "return",
      type: "return",
      output_mapping: {
        status: "reviewed",
        review: "{{outputs.review}}",
      },
    },
  ],
};

function config(organizationId: string, actorId: string, skills: string[]): ActorConfig {
  return {
    actor_id: actorId,
    organization_id: organizationId,
    name: actorId,
    type: "ai",
    role: actorId,
    responsibility: "Organization recovery demo",
    autonomy_level: "L3_low_risk_execute",
    memory: [`${organizationId}:${actorId}:seed`],
    permissions: {
      allowed_tools: [],
      denied_tools: [],
      allowed_skills: skills,
    },
    approval_judgment: { must_request_approval_when: [] },
  };
}

function register(runtime: OrganizationRuntime, organizationId: string): void {
  runtime.registerActor(organizationId, {
    actorConfig: config(organizationId, "manager", ["complete_task"]),
    skills: [COMPLETE_SKILL],
    capabilities: CAPABILITIES,
  });
  runtime.registerActor(organizationId, {
    actorConfig: config(organizationId, "worker", ["complete_task", "wait_for_review"]),
    skills: [COMPLETE_SKILL, WAIT_SKILL],
    capabilities: CAPABILITIES,
  }, "manager");
}

function resetKernel(): void {
  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
}

function corruptedSnapshotRejected(
  snapshot: OrganizationSnapshot,
  mutate: (candidate: OrganizationSnapshot) => void
): boolean {
  const corrupted = structuredClone(snapshot);
  mutate(corrupted);
  try {
    new OrganizationRuntime(actorRuntime).restoreSnapshot(corrupted);
    return false;
  } catch (error) {
    return error instanceof OrganizationError && error.code === "invalid_input";
  }
}

function stablePendingSnapshot(value: ReturnType<typeof actorRuntime.dumpPendingRun>): string {
  if (!value) return "null";
  const snapshot = structuredClone(value);
  snapshot.savedAt = "<ignored>";
  return JSON.stringify(snapshot);
}

async function main(): Promise<void> {
  resetKernel();
  const storePath = `/tmp/organize-v0.5.0-recovery-${process.pid}.json`;
  const store = new JsonOrganizationStore(storePath);
  const runtime = new OrganizationRuntime(actorRuntime);

  try {
    const alpha = runtime.createOrganization({ organizationId: "org_recovery_alpha", name: "Recovery Alpha" });
    const beta = runtime.createOrganization({ organizationId: "org_recovery_beta", name: "Recovery Beta" });
    register(runtime, alpha.organizationId);
    register(runtime, beta.organizationId);

    const betaTask = runtime.createTask({
      organizationId: beta.organizationId,
      requestedByActorId: "manager",
      title: "Beta isolation task",
      input: { text: "beta" },
    });
    runtime.assignTask({
      organizationId: beta.organizationId,
      requestedByActorId: "manager",
      taskId: betaTask.taskId,
      actorId: "worker",
      skillId: "wait_for_review",
    });
    runtime.enqueueTask({
      organizationId: beta.organizationId,
      requestedByActorId: "manager",
      taskId: betaTask.taskId,
    });
    const betaRun = await runtime.dispatchNext({ organizationId: beta.organizationId });
    if (!betaRun?.output.pendingHumanInput) throw new Error("Expected waiting beta run");
    const betaMemorySnapshotBefore = memoryService.dumpOrganizationSnapshot(beta.organizationId);
    const betaMemoryBefore = JSON.stringify({
      memories: betaMemorySnapshotBefore.memories,
      candidates: betaMemorySnapshotBefore.candidates,
    });
    const betaTraceBefore = JSON.stringify(traceLogger.getTrace(betaRun.output.actorRunId));

    const waitingTask = runtime.createTask({
      organizationId: alpha.organizationId,
      requestedByActorId: "manager",
      title: "Waiting task",
      input: { text: "wait" },
    });
    runtime.assignTask({
      organizationId: alpha.organizationId,
      requestedByActorId: "manager",
      taskId: waitingTask.taskId,
      actorId: "worker",
      skillId: "wait_for_review",
    });
    runtime.enqueueTask({
      organizationId: alpha.organizationId,
      requestedByActorId: "manager",
      taskId: waitingTask.taskId,
    });
    const waitingRun = await runtime.dispatchNext({ organizationId: alpha.organizationId });
    if (!waitingRun?.output.pendingHumanInput) throw new Error("Expected waiting human input");

    const queuedTask = runtime.createTask({
      organizationId: alpha.organizationId,
      requestedByActorId: "manager",
      title: "Queued after restore",
      input: { text: "queued" },
    });
    runtime.assignTask({
      organizationId: alpha.organizationId,
      requestedByActorId: "manager",
      taskId: queuedTask.taskId,
      actorId: "worker",
      skillId: "complete_task",
    });
    runtime.enqueueTask({
      organizationId: alpha.organizationId,
      requestedByActorId: "manager",
      taskId: queuedTask.taskId,
    });

    const deliveredMessage = runtime.sendMessage({
      organizationId: alpha.organizationId,
      fromActorId: "manager",
      toActorId: "worker",
      type: "task_request",
      payload: { taskId: waitingTask.taskId },
    });
    runtime.receiveNextMessage({ organizationId: alpha.organizationId, actorId: "worker" });

    const snapshot = await runtime.saveSnapshot({
      organizationId: alpha.organizationId,
      requestedByActorId: "manager",
      store,
    });
    snapshot.organization.name = "mutated after save";
    const stored = await store.load(alpha.organizationId);
    if (!stored) throw new Error("Expected stored organization snapshot");
    const pending = stored.runtimeRecovery?.pendingRuns[0]?.pendingHumanInput;
    if (!pending) throw new Error("Expected pending human input in recovery snapshot");

    const betaSnapshot = runtime.dumpSnapshot({
      organizationId: beta.organizationId,
      requestedByActorId: "manager",
    });
    await Promise.all([store.save(stored), store.save(betaSnapshot)]);
    const concurrentStoreIds = new Set(
      (await store.list()).map((item) => item.organization.organizationId)
    );

    const storedAlphaMemory = JSON.stringify({
      memories: stored.runtimeRecovery?.memory.memories ?? [],
      candidates: stored.runtimeRecovery?.memory.candidates ?? [],
    });

    runtime.clearOrganization(alpha.organizationId);

    const coldAlphaMemory = memoryService.dumpOrganizationSnapshot(alpha.organizationId);
    const alphaMemoryCleared =
      coldAlphaMemory.memories.length === 0 && coldAlphaMemory.candidates.length === 0;
    const alphaTraceCleared = traceLogger.getTrace(waitingRun.output.actorRunId) === undefined;
    const alphaPendingCleared = actorRuntime.dumpPendingRun(waitingRun.output.actorRunId) === null;
    const betaPendingSurvivedClear = Boolean(actorRuntime.dumpPendingRun(betaRun.output.actorRunId));
    const betaPendingBeforeCorruption = stablePendingSnapshot(
      actorRuntime.dumpPendingRun(betaRun.output.actorRunId)
    );
    const corruptedCrossReferenceRejected = corruptedSnapshotRejected(stored, (candidate) => {
      if (candidate.messages[0]) candidate.messages[0].toActorId = "missing_actor";
    });
    const duplicateQueueRejected = corruptedSnapshotRejected(stored, (candidate) => {
      if (candidate.taskQueue[0]) candidate.taskQueue.push(candidate.taskQueue[0]);
    });
    const duplicatePendingRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const pendingRun = candidate.runtimeRecovery?.pendingRuns[0];
      if (pendingRun) candidate.runtimeRecovery?.pendingRuns.push(structuredClone(pendingRun));
    });
    const missingActorTraceRejected = corruptedSnapshotRejected(stored, (candidate) => {
      if (candidate.runtimeRecovery) candidate.runtimeRecovery.trace.traces = [];
    });
    const embeddedSkillMutationRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const pendingRun = candidate.runtimeRecovery?.pendingRuns[0];
      if (pendingRun?.skill.steps[1]) {
        pendingRun.skill.steps[1].description = "tampered future execution step";
      }
    });
    const expandedPermissionRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const pendingRun = candidate.runtimeRecovery?.pendingRuns[0];
      pendingRun?.context.permissions.allowedTools.push("forged_admin_tool");
    });
    const taskInputMismatchRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const pendingRun = candidate.runtimeRecovery?.pendingRuns[0];
      if (pendingRun) pendingRun.context.input.text = "forged task input";
    });
    const memoryViewMutationRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const pendingRun = candidate.runtimeRecovery?.pendingRuns[0];
      pendingRun?.context.memory.actorPrivate.push("forged cross-organization memory");
    });
    const auditedStateMutationRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const pendingRun = candidate.runtimeRecovery?.pendingRuns[0];
      if (!pendingRun) return;
      pendingRun.state.steps.query_order = { forged: true };
      pendingRun.state.outputs.order_info = { forged: true };
    });
    const suspensionTokenMutationRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const events = candidate.runtimeRecovery?.trace.traces[0]?.events;
      const suspended = [...(events ?? [])]
        .reverse()
        .find((event) => event.eventType === "actor_run_suspended");
      if (suspended) suspended.data.requestId = "hin_forged_request";
    });
    const invalidTaskStatusRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const task = candidate.tasks.find((item) => item.status === "queued");
      if (task) task.status = "forged" as typeof task.status;
    });
    const invalidTaskInputRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const task = candidate.tasks[0];
      if (task) task.input.text = 123 as unknown as string;
    });
    const invalidMessageLifecycleRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const message = candidate.messages[0];
      if (message) message.status = "forged" as typeof message.status;
    });
    const invalidActorPermissionsRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const actor = candidate.actors[0];
      if (actor) {
        actor.actorConfig.permissions.allowed_tools = null as unknown as string[];
      }
    });
    const invalidOrganizationNameRejected = corruptedSnapshotRejected(stored, (candidate) => {
      candidate.organization.name = 1n as unknown as string;
    });
    const invalidUnitHierarchyRejected = corruptedSnapshotRejected(stored, (candidate) => {
      candidate.organization.units = [{
        unitId: "orphan_unit",
        name: "Orphan Unit",
        parentUnitId: "missing_parent",
      }];
    });
    const invalidActorUnitRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const actor = candidate.actors[0];
      if (actor) actor.actorConfig.unit_id = "missing_unit";
    });
    const invalidOrganizationTraceTypeRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const event = candidate.trace[0];
      if (event) event.eventType = "forged_event" as typeof event.eventType;
    });
    const invalidStepStateRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const pendingRun = candidate.runtimeRecovery?.pendingRuns[0];
      if (pendingRun) pendingRun.state.currentStepIndex = 1;
    });
    const actorTraceSequenceRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const event = candidate.runtimeRecovery?.trace.traces[0]?.events[0];
      if (event) event.sequence = 2;
    });
    const actorTraceRunReferenceRejected = corruptedSnapshotRejected(stored, (candidate) => {
      const event = candidate.runtimeRecovery?.trace.traces[0]?.events[0];
      if (event) event.actorRunId = "arun_forged";
    });
    const corruptionChecksPreserveBeta =
      stablePendingSnapshot(actorRuntime.dumpPendingRun(betaRun.output.actorRunId)) ===
        betaPendingBeforeCorruption &&
      JSON.stringify(traceLogger.getTrace(betaRun.output.actorRunId)) === betaTraceBefore &&
      (() => {
        const current = memoryService.dumpOrganizationSnapshot(beta.organizationId);
        return JSON.stringify({ memories: current.memories, candidates: current.candidates }) === betaMemoryBefore;
      })();

    const mismatchedStore: OrganizationStore = {
      load: async () => structuredClone(stored),
      save: async () => undefined,
      delete: async () => undefined,
      list: async () => [structuredClone(stored)],
      clear: async () => undefined,
    };
    let mismatchedStoreOrganizationRejected = false;
    try {
      await new OrganizationRuntime(actorRuntime).loadSnapshot(
        "org_requested_but_not_returned",
        mismatchedStore
      );
    } catch (error) {
      mismatchedStoreOrganizationRejected =
        error instanceof OrganizationError && error.code === "cross_organization";
    }

    await runtime.loadSnapshot(alpha.organizationId, store);

    const restoredWaiting = runtime.getTask(alpha.organizationId, waitingTask.taskId);
    const restoredQueued = runtime.getTask(alpha.organizationId, queuedTask.taskId);
    const redelivered = runtime.receiveNextMessage({
      organizationId: alpha.organizationId,
      actorId: "worker",
    });
    const restoredTrace = runtime.getTrace(alpha.organizationId);
    const restoredAlphaMemory = memoryService.dumpOrganizationSnapshot(alpha.organizationId);
    const alphaMemoryRestored = JSON.stringify({
      memories: restoredAlphaMemory.memories,
      candidates: restoredAlphaMemory.candidates,
    }) === storedAlphaMemory;
    const alphaActorTraceRestored = Boolean(traceLogger.getTrace(waitingRun.output.actorRunId));
    const betaTaskStillWaiting = runtime.getTask(beta.organizationId, betaTask.taskId);
    const betaPendingAfterRestore = Boolean(actorRuntime.dumpPendingRun(betaRun.output.actorRunId));
    const betaMemoryPreserved = (() => {
      const current = memoryService.dumpOrganizationSnapshot(beta.organizationId);
      return JSON.stringify({ memories: current.memories, candidates: current.candidates }) === betaMemoryBefore;
    })();
    const betaTracePreserved = JSON.stringify(traceLogger.getTrace(betaRun.output.actorRunId)) === betaTraceBefore;

    const continued = await runtime.continueTask({
      organizationId: alpha.organizationId,
      requestedByActorId: "worker",
      taskId: waitingTask.taskId,
      event: {
        type: "human_input_response",
        response: {
          humanInputRequestId: pending.humanInputRequestId,
          value: "restored approval",
          respondedBy: "worker",
        },
      },
    });
    const queuedRun = await runtime.dispatchNext({ organizationId: alpha.organizationId });
    if (!queuedRun) throw new Error("Expected restored queued task to dispatch");
    const betaContinued = await runtime.continueTask({
      organizationId: beta.organizationId,
      requestedByActorId: "worker",
      taskId: betaTask.taskId,
      event: {
        type: "human_input_response",
        response: {
          humanInputRequestId: betaRun.output.pendingHumanInput.humanInputRequestId,
          value: "beta preserved",
          respondedBy: "worker",
        },
      },
    });

    const checks: CheckResult[] = [
      {
        label: "store round-trip preserves original snapshot",
        pass: stored.organization.name === "Recovery Alpha",
        detail: stored.organization.name,
      },
      {
        label: "snapshot contains one pending ActorRuntime run",
        pass: stored.runtimeRecovery?.pendingRuns.length === 1,
        detail: String(stored.runtimeRecovery?.pendingRuns.length),
      },
      {
        label: "snapshot filters Actor trace to organization runs",
        pass:
          stored.runtimeRecovery?.trace.traces.length === 1 &&
          stored.runtimeRecovery.trace.traces[0].actorRunId === waitingRun.output.actorRunId,
        detail: stored.runtimeRecovery?.trace.traces.map((trace) => trace.actorRunId).join(",") ?? "none",
      },
      {
        label: "snapshot filters memory by organization",
        pass: stored.runtimeRecovery?.memory.memories.every((memory) => memory.organizationId === alpha.organizationId) === true,
        detail: String(stored.runtimeRecovery?.memory.memories.length),
      },
      {
        label: "clear creates a cold organization boundary",
        pass: alphaMemoryCleared && alphaTraceCleared && alphaPendingCleared,
        detail: `memory=${alphaMemoryCleared}, trace=${alphaTraceCleared}, pending=${alphaPendingCleared}`,
      },
      {
        label: "cold restore reinstates memory and Actor trace",
        pass: alphaMemoryRestored && alphaActorTraceRestored,
        detail: `memory=${alphaMemoryRestored}, trace=${alphaActorTraceRestored}`,
      },
      {
        label: "waiting task restores with original run binding",
        pass:
          restoredWaiting.status === "waiting_human_input" &&
          restoredWaiting.actorRunId === waitingRun.output.actorRunId,
        detail: `${restoredWaiting.status}/${restoredWaiting.actorRunId}`,
      },
      {
        label: "queued task and scheduler order restore",
        pass: restoredQueued.status === "queued",
        detail: restoredQueued.status,
      },
      {
        label: "delivered but unacknowledged message redelivers",
        pass: redelivered?.messageId === deliveredMessage.messageId && redelivered.status === "delivered",
        detail: `${redelivered?.messageId}/${redelivered?.status}`,
      },
      {
        label: "organization trace restores and appends restore event",
        pass:
          restoredTrace.some((event) => event.eventType === "snapshot_created") &&
          restoredTrace.some((event) => event.eventType === "snapshot_restored"),
        detail: restoredTrace.map((event) => event.eventType).join(","),
      },
      {
        label: "restored pending run continues to completion",
        pass:
          continued.task.status === "completed" &&
          continued.output.result?.review === "restored approval",
        detail: JSON.stringify(continued.output.result),
      },
      {
        label: "restored queue dispatches a new unique Actor run",
        pass:
          queuedRun.task.status === "completed" &&
          queuedRun.output.actorRunId !== waitingRun.output.actorRunId,
        detail: `${waitingRun.output.actorRunId} -> ${queuedRun.output.actorRunId}`,
      },
      {
        label: "restoring alpha preserves beta organization state",
        pass:
          betaTaskStillWaiting.status === "waiting_human_input" &&
          runtime.getOrganization(beta.organizationId).name === "Recovery Beta",
        detail: betaTaskStillWaiting.status,
      },
      {
        label: "restoring alpha preserves beta pending run",
        pass: betaPendingSurvivedClear && betaPendingAfterRestore,
        detail: `after-clear=${betaPendingSurvivedClear}, after-restore=${betaPendingAfterRestore}`,
      },
      {
        label: "restoring alpha preserves beta memory partition",
        pass: betaMemoryPreserved,
        detail: String(memoryService.dumpOrganizationSnapshot(beta.organizationId).memories.length),
      },
      {
        label: "restoring alpha preserves beta Actor trace",
        pass: betaTracePreserved,
        detail: betaRun.output.actorRunId,
      },
      {
        label: "preserved beta pending run continues",
        pass: betaContinued.task.status === "completed" && betaContinued.output.result?.review === "beta preserved",
        detail: JSON.stringify(betaContinued.output.result),
      },
      {
        label: "corrupted snapshot references are rejected",
        pass: corruptedCrossReferenceRejected,
        detail: String(corruptedCrossReferenceRejected),
      },
      {
        label: "duplicate scheduler entries are rejected",
        pass: duplicateQueueRejected,
        detail: String(duplicateQueueRejected),
      },
      {
        label: "duplicate pending runs are rejected",
        pass: duplicatePendingRejected,
        detail: String(duplicatePendingRejected),
      },
      {
        label: "missing Actor traces are rejected",
        pass: missingActorTraceRejected,
        detail: String(missingActorTraceRejected),
      },
      {
        label: "embedded Skill mutations are rejected",
        pass: embeddedSkillMutationRejected,
        detail: String(embeddedSkillMutationRejected),
      },
      {
        label: "expanded recovered permissions are rejected",
        pass: expandedPermissionRejected,
        detail: String(expandedPermissionRejected),
      },
      {
        label: "recovered task input mismatches are rejected",
        pass: taskInputMismatchRejected,
        detail: String(taskInputMismatchRejected),
      },
      {
        label: "recovered Memory view must match audited Memory ids",
        pass: memoryViewMutationRejected,
        detail: String(memoryViewMutationRejected),
      },
      {
        label: "recovered Skill state must match audited Tool observations",
        pass: auditedStateMutationRejected,
        detail: String(auditedStateMutationRejected),
      },
      {
        label: "recovered continuation token must match the suspend Trace",
        pass: suspensionTokenMutationRejected,
        detail: String(suspensionTokenMutationRejected),
      },
      {
        label: "recovery rejects unknown Task status",
        pass: invalidTaskStatusRejected,
        detail: String(invalidTaskStatusRejected),
      },
      {
        label: "recovery rejects malformed Task input",
        pass: invalidTaskInputRejected,
        detail: String(invalidTaskInputRejected),
      },
      {
        label: "recovery rejects malformed Message lifecycle",
        pass: invalidMessageLifecycleRejected,
        detail: String(invalidMessageLifecycleRejected),
      },
      {
        label: "recovery rejects malformed Actor permissions",
        pass: invalidActorPermissionsRejected,
        detail: String(invalidActorPermissionsRejected),
      },
      {
        label: "recovery rejects non-JSON organization identity fields",
        pass: invalidOrganizationNameRejected,
        detail: String(invalidOrganizationNameRejected),
      },
      {
        label: "recovery rejects invalid organization unit hierarchy",
        pass: invalidUnitHierarchyRejected,
        detail: String(invalidUnitHierarchyRejected),
      },
      {
        label: "recovery rejects Actor references to missing units",
        pass: invalidActorUnitRejected,
        detail: String(invalidActorUnitRejected),
      },
      {
        label: "recovery rejects unknown Organization Trace event types",
        pass: invalidOrganizationTraceTypeRejected,
        detail: String(invalidOrganizationTraceTypeRejected),
      },
      {
        label: "loadSnapshot rejects a Store response for another organization",
        pass: mismatchedStoreOrganizationRejected,
        detail: String(mismatchedStoreOrganizationRejected),
      },
      {
        label: "invalid pending Skill state is rejected",
        pass: invalidStepStateRejected,
        detail: String(invalidStepStateRejected),
      },
      {
        label: "corrupted Actor Trace sequence is rejected",
        pass: actorTraceSequenceRejected,
        detail: String(actorTraceSequenceRejected),
      },
      {
        label: "corrupted Actor Trace run references are rejected",
        pass: actorTraceRunReferenceRejected,
        detail: String(actorTraceRunReferenceRejected),
      },
      {
        label: "failed recovery preflight preserves another organization",
        pass: corruptionChecksPreserveBeta,
        detail: String(corruptionChecksPreserveBeta),
      },
      {
        label: "concurrent store saves preserve both organizations",
        pass:
          concurrentStoreIds.has(alpha.organizationId) &&
          concurrentStoreIds.has(beta.organizationId) &&
          concurrentStoreIds.size === 2,
        detail: [...concurrentStoreIds].join(","),
      },
      {
        label: "store lists saved organizations",
        pass: (await store.list()).length === 2,
        detail: String((await store.list()).length),
      },
    ];

    console.log("=".repeat(68));
    console.log(`  ForeverThinking v0.5.0 — Organization Recovery (${checks.length} checks)`);
    console.log("=".repeat(68));
    let passed = 0;
    checks.forEach((check, index) => {
      if (check.pass) passed++;
      console.log(`${check.pass ? "✅" : "❌"} ${String(index + 1).padStart(2, "0")}. ${check.label}`);
      console.log(`    ${check.detail}`);
    });
    console.log(`Passed: ${passed}/${checks.length}`);
    if (passed !== checks.length) process.exitCode = 1;
  } finally {
    await store.clear();
    await rm(storePath, { force: true });
  }
}

main().catch((error) => {
  console.error("Organization Recovery Demo failed:", error);
  process.exit(1);
});
