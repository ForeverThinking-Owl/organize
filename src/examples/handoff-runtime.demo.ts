// ============================================================================
// handoff-runtime.demo.ts — v0.6.0
// Terminal ActorRuntime handoff contract and fail-closed validation demo
// ============================================================================

import { isDeepStrictEqual } from "node:util";
import type { ActorConfig } from "../core/types/actor";
import type { SkillConfig } from "../core/types/skill";
import type { TraceEvent } from "../core/types/trace";
import {
  ActorRuntime,
  type ActorRunOutput,
  type HandoffRequest,
} from "../runtime/actor-runtime";
import { approvalGate } from "../approvals/approval-gate";
import { memoryService } from "../memory/memory-service";
import type { MemoryStore } from "../memory/memory-store";
import { traceLogger } from "../trace/trace-logger";
import { assertTraceSnapshot } from "../trace/trace-snapshot";

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

interface RejectedScenario {
  output: ActorRunOutput;
  errorMessage: string;
  handoffCount: number;
  hasRun: boolean;
  hasPendingRun: boolean;
}

const VALID_SKILL_ID = "handoff_runtime_valid";
const RESTORED_SKILL_ID = "handoff_runtime_after_restore";

const ACTOR_CONFIG: ActorConfig = {
  actor_id: "triage_actor",
  organization_id: "org_handoff_runtime_demo",
  unit_id: "unit_support",
  name: "Triage Actor",
  type: "ai",
  role: "triage",
  responsibility: "Validate terminal, explicitly addressed Actor handoffs",
  autonomy_level: "L2_read_and_draft",
  memory: [],
  permissions: {
    allowed_tools: [],
    denied_tools: [],
    allowed_skills: [
      VALID_SKILL_ID,
      RESTORED_SKILL_ID,
      "handoff_non_terminal",
      "handoff_unknown_field",
      "handoff_empty_actor",
      "handoff_empty_skill",
      "handoff_non_string_mapping",
      "handoff_unresolved",
    ],
  },
  approval_judgment: { must_request_approval_when: [] },
};

const COMPLETE_CONTEXT = {
  text_value: "customer needs specialist review",
  number_value: 42,
  boolean_value: true,
  object_value: { category: "technical", priority: 2 },
  array_value: ["scanner", 3, false, { source: "runtime" }],
};

const EXPECTED_HANDOFF_CONTEXT = {
  text: COMPLETE_CONTEXT.text_value,
  count: COMPLETE_CONTEXT.number_value,
  urgent: COMPLETE_CONTEXT.boolean_value,
  metadata: COMPLETE_CONTEXT.object_value,
  evidence: COMPLETE_CONTEXT.array_value,
};

function handoffStep(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    step_key: "delegate_to_specialist",
    type: "handoff",
    target_actor_id: "specialist_actor",
    target_skill_id: "specialist_review",
    reason: "Triage requires specialist ownership",
    input_mapping: {
      text: "{{context.text_value}}",
      count: "{{context.number_value}}",
      urgent: "{{context.boolean_value}}",
      metadata: "{{context.object_value}}",
      evidence: "{{context.array_value}}",
    },
    ...overrides,
  };
}

function skillConfig(
  skillId: string,
  steps: Array<Record<string, unknown>>
): SkillConfig {
  return {
    skill_id: skillId,
    name: `Handoff demo: ${skillId}`,
    owner_actor_id: ACTOR_CONFIG.actor_id,
    steps: steps as SkillConfig["steps"],
  };
}

function events(actorRunId: string): TraceEvent[] {
  return traceLogger.getTrace(actorRunId)?.events ?? [];
}

function eventsOfType(actorRunId: string, eventType: string): TraceEvent[] {
  return events(actorRunId).filter((event) => event.eventType === eventType);
}

function firstErrorMessage(output: ActorRunOutput): string {
  const error = eventsOfType(output.actorRunId, "error")[0];
  return typeof error?.data.message === "string" ? error.data.message : "";
}

function format(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function requestHasCompleteIdentity(
  request: HandoffRequest | undefined,
  output: ActorRunOutput
): boolean {
  return Boolean(
    request &&
      /^hreq_[0-9a-f-]+$/i.test(request.handoffRequestId) &&
      request.actorRunId === output.actorRunId &&
      request.sourceActorId === ACTOR_CONFIG.actor_id &&
      request.sourceSkillId === VALID_SKILL_ID &&
      request.stepKey === "delegate_to_specialist" &&
      request.targetActorId === "specialist_actor" &&
      request.targetSkillId === "specialist_review" &&
      request.reason === "Triage requires specialist ownership"
  );
}

async function rejectedScenario(
  runtime: ActorRuntime,
  config: SkillConfig,
  runtimeContext: Record<string, unknown> = COMPLETE_CONTEXT
): Promise<RejectedScenario> {
  const output = await runtime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: config,
    input: { text: "Validate fail-closed handoff configuration" },
    runtimeContext,
  });
  return {
    output,
    errorMessage: firstErrorMessage(output),
    handoffCount: eventsOfType(output.actorRunId, "handoff").length,
    hasRun: runtime.hasRun(output.actorRunId),
    hasPendingRun: runtime.dumpPendingRun(output.actorRunId) !== null,
  };
}

function rejectedCheck(
  label: string,
  scenario: RejectedScenario,
  expectedError: string
): CheckResult {
  return {
    label,
    pass:
      scenario.output.status === "error" &&
      scenario.errorMessage.includes(expectedError) &&
      scenario.handoffCount === 0 &&
      !scenario.hasRun &&
      !scenario.hasPendingRun,
    detail: format({
      status: scenario.output.status,
      error: scenario.errorMessage,
      handoffCount: scenario.handoffCount,
      hasRun: scenario.hasRun,
      hasPendingRun: scenario.hasPendingRun,
    }),
  };
}

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("  ForeverThinking v0.6.0 — Terminal Handoff Runtime Demo");
  console.log("=".repeat(72));

  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();

  const runtime = new ActorRuntime();
  const direct = await runtime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: skillConfig(VALID_SKILL_ID, [handoffStep()]),
    input: { text: "Delegate this case to the technical specialist" },
    runtimeContext: COMPLETE_CONTEXT,
  });
  const directRequest = direct.handoffRequest;
  const directTrace = traceLogger.getTrace(direct.actorRunId);
  const directHandoffs = eventsOfType(direct.actorRunId, "handoff");
  const directEnds = eventsOfType(direct.actorRunId, "actor_run_end");
  const traceBeforeRejectedContinue = events(direct.actorRunId);

  const rejectedContinue = await runtime.continue(direct.actorRunId, {
    type: "human_input_response",
    response: {
      humanInputRequestId: "not_pending",
      value: "must not resume a terminal handoff",
      respondedBy: "demo",
      respondedAt: new Date().toISOString(),
    },
  });
  const traceAfterRejectedContinue = events(direct.actorRunId);

  const nonTerminal = await rejectedScenario(
    runtime,
    skillConfig("handoff_non_terminal", [
      handoffStep(),
      { step_key: "must_not_run", type: "return" },
    ])
  );
  const unknownField = await rejectedScenario(
    runtime,
    skillConfig("handoff_unknown_field", [handoffStep({ unexpected: true })])
  );
  const emptyActor = await rejectedScenario(
    runtime,
    skillConfig("handoff_empty_actor", [handoffStep({ target_actor_id: "" })])
  );
  const emptySkill = await rejectedScenario(
    runtime,
    skillConfig("handoff_empty_skill", [handoffStep({ target_skill_id: "" })])
  );
  const nonStringMapping = await rejectedScenario(
    runtime,
    skillConfig("handoff_non_string_mapping", [
      handoffStep({ input_mapping: { invalid: 17 } }),
    ])
  );
  const unresolved = await rejectedScenario(
    runtime,
    skillConfig("handoff_unresolved", [
      handoffStep({ input_mapping: { missing: "{{context.not_available}}" } }),
    ]),
    {}
  );

  const failingMemoryStore: MemoryStore = {
    async load() { return null; },
    async save() { throw new Error("intentional handoff memory save failure"); },
    async clear() {},
  };
  const failedSave = await new ActorRuntime().run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: skillConfig(VALID_SKILL_ID, [handoffStep()]),
    input: { text: "Do not expose a handoff before durable memory save" },
    runtimeContext: COMPLETE_CONTEXT,
    runtimeOptions: { memoryStore: failingMemoryStore },
  });
  const failedSaveTrace = traceLogger.getTrace(failedSave.actorRunId);
  let failedSaveTraceSnapshotValid = true;
  try {
    assertTraceSnapshot(traceLogger.dumpRunsSnapshot([failedSave.actorRunId]));
  } catch {
    failedSaveTraceSnapshotValid = false;
  }

  const waitingRuntime = new ActorRuntime();
  const futureHandoffSkill = skillConfig(RESTORED_SKILL_ID, [
    {
      step_key: "collect_handoff_note",
      type: "human_input",
      prompt: "Provide the note that must survive PendingRun recovery",
      output_key: "handoff_note",
    },
    handoffStep({
      step_key: "delegate_after_restore",
      reason: "Human note was recovered and is ready for delegation",
      input_mapping: {
        note: "{{outputs.handoff_note}}",
        evidence: "{{context.array_value}}",
      },
    }),
  ]);
  const waiting = await waitingRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: futureHandoffSkill,
    input: { text: "Pause before delegating" },
    runtimeContext: COMPLETE_CONTEXT,
  });
  const pendingSnapshot = waitingRuntime.dumpPendingRun(waiting.actorRunId);
  const pendingContainsFutureHandoff =
    pendingSnapshot?.skill.steps[1]?.type === "handoff";

  waitingRuntime.clearRun(waiting.actorRunId);
  const restoredRuntime = new ActorRuntime();
  if (pendingSnapshot) restoredRuntime.restorePendingRun(pendingSnapshot);
  const redumpedSnapshot = restoredRuntime.dumpPendingRun(waiting.actorRunId);
  const restoredHasPendingRun = restoredRuntime.hasRun(waiting.actorRunId);

  const restoredNote = "route with the recovered human decision";
  const restored = waiting.pendingHumanInput
    ? await restoredRuntime.continue(waiting.actorRunId, {
        type: "human_input_response",
        response: {
          humanInputRequestId: waiting.pendingHumanInput.humanInputRequestId,
          value: restoredNote,
          respondedBy: "recovery_operator",
          respondedAt: new Date().toISOString(),
        },
      })
    : null;
  const restoredHandoffs = restored
    ? eventsOfType(restored.actorRunId, "handoff")
    : [];
  const restoredEnds = restored
    ? eventsOfType(restored.actorRunId, "actor_run_end")
    : [];

  const checks: CheckResult[] = [
    {
      label: "handoff is a terminal handoff_requested ActorRun status",
      pass:
        direct.status === "handoff_requested" &&
        directTrace?.status === "handoff_requested" &&
        typeof directTrace.endedAt === "string",
      detail: format({ output: direct.status, trace: directTrace?.status }),
    },
    {
      label: "terminal handoff has a null result",
      pass: direct.result === null,
      detail: format(direct.result),
    },
    {
      label: "handoff mapping preserves strings",
      pass: directRequest?.handoffContext.text === EXPECTED_HANDOFF_CONTEXT.text,
      detail: format(directRequest?.handoffContext.text),
    },
    {
      label: "handoff mapping preserves numbers",
      pass: directRequest?.handoffContext.count === EXPECTED_HANDOFF_CONTEXT.count,
      detail: format(directRequest?.handoffContext.count),
    },
    {
      label: "handoff mapping preserves booleans",
      pass: directRequest?.handoffContext.urgent === EXPECTED_HANDOFF_CONTEXT.urgent,
      detail: format(directRequest?.handoffContext.urgent),
    },
    {
      label: "handoff mapping preserves nested objects",
      pass: isDeepStrictEqual(
        directRequest?.handoffContext.metadata,
        EXPECTED_HANDOFF_CONTEXT.metadata
      ),
      detail: format(directRequest?.handoffContext.metadata),
    },
    {
      label: "handoff mapping preserves arrays and their nested values",
      pass: isDeepStrictEqual(
        directRequest?.handoffContext.evidence,
        EXPECTED_HANDOFF_CONTEXT.evidence
      ),
      detail: format(directRequest?.handoffContext.evidence),
    },
    {
      label: "handoff output preserves the complete runtime-owned request identity",
      pass: requestHasCompleteIdentity(directRequest, direct),
      detail: format(directRequest),
    },
    {
      label: "Trace contains exactly one handoff identical to the output request",
      pass:
        directHandoffs.length === 1 &&
        isDeepStrictEqual(directHandoffs[0].data, directRequest),
      detail: format(directHandoffs.map((event) => event.data)),
    },
    {
      label: "Trace contains exactly one terminal handoff_requested actor_run_end",
      pass:
        directEnds.length === 1 &&
        directEnds[0].data.status === "handoff_requested" &&
        directTrace?.events.at(-1)?.eventType === "actor_run_end",
      detail: format(directEnds.map((event) => event.data)),
    },
    {
      label: "terminal handoff never emits final_output",
      pass: eventsOfType(direct.actorRunId, "final_output").length === 0,
      detail: `finalOutputCount=${eventsOfType(direct.actorRunId, "final_output").length}`,
    },
    {
      label: "terminal handoff leaves no PendingRun or live ActorRun",
      pass:
        runtime.dumpPendingRun(direct.actorRunId) === null &&
        !runtime.hasRun(direct.actorRunId),
      detail: format({
        pending: runtime.dumpPendingRun(direct.actorRunId),
        hasRun: runtime.hasRun(direct.actorRunId),
      }),
    },
    {
      label: "continue rejects a terminal handoff and cannot mutate its terminal Trace",
      pass:
        rejectedContinue.status === "error" &&
        rejectedContinue.trace.eventCount === 0 &&
        !rejectedContinue.handoffRequest &&
        isDeepStrictEqual(traceAfterRejectedContinue, traceBeforeRejectedContinue) &&
        !runtime.hasRun(direct.actorRunId),
      detail: format({
        status: rejectedContinue.status,
        eventCount: rejectedContinue.trace.eventCount,
        originalTraceUnchanged: isDeepStrictEqual(
          traceAfterRejectedContinue,
          traceBeforeRejectedContinue
        ),
      }),
    },
    rejectedCheck(
      "handoff followed by another step is rejected before execution",
      nonTerminal,
      "must be the final step"
    ),
    rejectedCheck(
      "unknown handoff config fields are rejected fail closed",
      unknownField,
      "unexpected is not supported"
    ),
    rejectedCheck(
      "an empty target_actor_id is rejected fail closed",
      emptyActor,
      "requires string field: target_actor_id"
    ),
    rejectedCheck(
      "an empty target_skill_id is rejected fail closed",
      emptySkill,
      "requires string field: target_skill_id"
    ),
    rejectedCheck(
      "non-string input_mapping values are rejected fail closed",
      nonStringMapping,
      "must be a string"
    ),
    rejectedCheck(
      "unresolved handoff templates fail closed without a handoff event",
      unresolved,
      "contains an unresolved template"
    ),
    {
      label: "MemoryStore save failure suppresses the terminal handoff request",
      pass:
        failedSave.status === "error" &&
        failedSave.handoffRequest === undefined &&
        failedSave.result === null,
      detail: format({ status: failedSave.status, request: failedSave.handoffRequest }),
    },
    {
      label: "MemoryStore save failure leaves an error Trace without handoff artifacts",
      pass:
        failedSaveTrace?.status === "error" &&
        eventsOfType(failedSave.actorRunId, "handoff").length === 0 &&
        eventsOfType(failedSave.actorRunId, "final_output").length === 0 &&
        eventsOfType(failedSave.actorRunId, "memory_store_error").length === 1,
      detail: format({
        traceStatus: failedSaveTrace?.status,
        handoffs: eventsOfType(failedSave.actorRunId, "handoff").length,
        memoryErrors: eventsOfType(failedSave.actorRunId, "memory_store_error").length,
      }),
    },
    {
      label: "MemoryStore save failure still produces a valid TraceSnapshot v2",
      pass: failedSaveTraceSnapshotValid,
      detail: String(failedSaveTraceSnapshotValid),
    },
    {
      label: "a wait before a future handoff can be dumped as a PendingRun",
      pass:
        waiting.status === "waiting_human_input" &&
        Boolean(waiting.pendingHumanInput) &&
        Boolean(pendingSnapshot) &&
        pendingContainsFutureHandoff,
      detail: format({
        status: waiting.status,
        pendingKind: pendingSnapshot?.pendingKind,
        futureStepType: pendingSnapshot?.skill.steps[1]?.type,
      }),
    },
    {
      label: "the PendingRun can be restored and dumped again before continue",
      pass:
        restoredHasPendingRun &&
        Boolean(redumpedSnapshot) &&
        isDeepStrictEqual(
          redumpedSnapshot?.pendingHumanInput,
          pendingSnapshot?.pendingHumanInput
        ) &&
        redumpedSnapshot?.skill.steps[1]?.type === "handoff",
      detail: format({
        hasRun: restoredHasPendingRun,
        redumpedKind: redumpedSnapshot?.pendingKind,
        futureStepType: redumpedSnapshot?.skill.steps[1]?.type,
      }),
    },
    {
      label: "continue after restore reaches the future terminal handoff",
      pass:
        restored?.status === "handoff_requested" &&
        restored.result === null &&
        restored.handoffRequest?.sourceSkillId === RESTORED_SKILL_ID &&
        restored.handoffRequest.stepKey === "delegate_after_restore" &&
        restored.handoffRequest.handoffContext.note === restoredNote &&
        isDeepStrictEqual(
          restored.handoffRequest.handoffContext.evidence,
          COMPLETE_CONTEXT.array_value
        ),
      detail: format(restored?.handoffRequest),
    },
    {
      label: "restored handoff has one handoff/end pair, no final_output, and no live run",
      pass:
        restoredHandoffs.length === 1 &&
        restoredEnds.length === 1 &&
        restoredEnds[0].data.status === "handoff_requested" &&
        Boolean(restored) &&
        eventsOfType(restored?.actorRunId ?? "", "final_output").length === 0 &&
        !restoredRuntime.hasRun(waiting.actorRunId) &&
        restoredRuntime.dumpPendingRun(waiting.actorRunId) === null,
      detail: format({
        handoffCount: restoredHandoffs.length,
        endCount: restoredEnds.length,
        finalOutputCount: eventsOfType(
          restored?.actorRunId ?? "",
          "final_output"
        ).length,
        hasRun: restoredRuntime.hasRun(waiting.actorRunId),
        hasPendingRun:
          restoredRuntime.dumpPendingRun(waiting.actorRunId) !== null,
      }),
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
