import { isDeepStrictEqual } from "node:util";
import type { ActorRunTrace, TraceEvent } from "../core/types/trace";
import type { ToolObservation } from "../core/types/tool";
import type { PendingRunSnapshot } from "./pending-run-snapshot";
import { buildCanonicalPendingToolDescriptor } from "./pending-tool-descriptor";
import { resolveTemplateValue, type SkillState } from "./skill-runtime";

function invalid(message: string): never {
  throw new Error(`Invalid pending execution state: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function filteredTraceObservation(
  event: TraceEvent,
  deniedFields: string[]
): ToolObservation {
  const observation = structuredClone(event.data) as unknown as ToolObservation;
  if (observation.data && deniedFields.length > 0) {
    observation.data = { ...observation.data };
    for (const field of deniedFields) delete observation.data[field];
  }
  return observation;
}

function outputData(observation: ToolObservation): Record<string, unknown> {
  return observation.data ?? {};
}

function findStepEvent(
  trace: ActorRunTrace,
  eventType: "skill_step_start" | "skill_step_end",
  stepKey: string
): TraceEvent | undefined {
  return trace.events.find(
    (event) => event.eventType === eventType && event.stepKey === stepKey
  );
}

/**
 * Bind persisted SkillState to the audited prefix that produced it. Values
 * intentionally omitted from Trace (human/external payloads) remain covered
 * by the documented trusted-snapshot integrity boundary.
 */
export function assertPendingStateTraceConsistency(
  pending: PendingRunSnapshot,
  trace: ActorRunTrace
): void {
  const deniedFields = pending.context.permissions.deniedFields ?? [];
  const auditedObservations = trace.events
    .filter((event) => event.eventType === "tool_observation")
    .map((event) => filteredTraceObservation(event, deniedFields));
  if (!isDeepStrictEqual(auditedObservations, pending.state.observations)) {
    invalid(`Tool observations differ from Trace for ${pending.actorRunId}`);
  }

  const allowedStepKeys = new Set<string>(auditedObservations.map((item) => item.toolName));
  const allowedOutputKeys = new Set<string>();
  const currentIndex = pending.state.currentStepIndex;
  const replayState: SkillState = {
    skillId: pending.skillId,
    currentStepIndex: 0,
    steps: {},
    outputs: {},
    context: structuredClone(pending.state.context),
    status: "running",
    observations: [],
  };

  for (let index = 0; index <= currentIndex; index++) {
    const step = pending.skill.steps[index];
    const isCurrent = index === currentIndex;
    const currentHasResult = isCurrent && step.type === "llm_judge";
    if (isCurrent && !currentHasResult) break;
    if (step.type === "return" || step.type === "end") {
      invalid(`terminal step ${step.stepKey} appears before a pending wait`);
    }

    allowedStepKeys.add(step.stepKey);
    if ("outputKey" in step) allowedOutputKeys.add(step.outputKey);

    if (step.type === "tool_call") {
      const start = findStepEvent(trace, "skill_step_start", step.stepKey);
      const end = findStepEvent(trace, "skill_step_end", step.stepKey);
      if (!start || !end || start.sequence >= end.sequence) {
        invalid(`completed Tool step ${step.stepKey} lacks a valid Trace interval`);
      }
      const observationEvent = trace.events.find(
        (event) =>
          event.eventType === "tool_observation" &&
          event.sequence > start.sequence &&
          event.sequence < end.sequence &&
          event.data.toolName === step.toolName
      );
      if (!observationEvent) {
        invalid(`completed Tool step ${step.stepKey} lacks an audited observation`);
      }
      const result = outputData(filteredTraceObservation(observationEvent, deniedFields));
      if (
        !isDeepStrictEqual(pending.state.steps[step.stepKey], result) ||
        !isDeepStrictEqual(pending.state.outputs[step.outputKey], result)
      ) {
        invalid(`completed Tool step ${step.stepKey} differs from its observation`);
      }
      replayState.steps[step.stepKey] = structuredClone(result);
      replayState.steps[step.toolName] = structuredClone(result);
      replayState.outputs[step.outputKey] = structuredClone(result);
      continue;
    }

    if (step.type === "llm_judge") {
      const judged = trace.events.find(
        (event) =>
          event.eventType === "decision_generated" &&
          event.stepKey === step.stepKey &&
          event.data.decisionType === "post_judge"
      );
      if (
        !judged ||
        !isDeepStrictEqual(pending.state.steps[step.stepKey], judged.data.judgeResult) ||
        !isDeepStrictEqual(pending.state.outputs[step.outputKey], judged.data.judgeResult)
      ) {
        invalid(`LLM step ${step.stepKey} differs from its audited result`);
      }
      replayState.steps[step.stepKey] = structuredClone(judged.data.judgeResult);
      replayState.outputs[step.outputKey] = structuredClone(judged.data.judgeResult);
      if (!isCurrent) {
        const descriptor = buildCanonicalPendingToolDescriptor(
          step,
          pending.state,
          pending.context
        );
        if (!descriptor?.decisionOutputKey) {
          invalid(`completed LLM step ${step.stepKey} lacks its canonical Tool decision`);
        }
        allowedStepKeys.add(descriptor.toolName);
        allowedOutputKeys.add(descriptor.decisionOutputKey);
        const end = findStepEvent(trace, "skill_step_end", step.stepKey);
        const nextStart = trace.events.find(
          (event) =>
            event.eventType === "skill_step_start" &&
            end !== undefined &&
            event.sequence > end.sequence
        );
        const observationEvent = trace.events.find(
          (event) =>
            event.eventType === "tool_observation" &&
            end !== undefined &&
            event.sequence > end.sequence &&
            (nextStart === undefined || event.sequence < nextStart.sequence) &&
            event.data.toolName === descriptor.toolName
        );
        if (!observationEvent) {
          invalid(`completed LLM Tool decision ${step.stepKey} lacks an observation`);
        }
        const result = outputData(filteredTraceObservation(observationEvent, deniedFields));
        if (
          !isDeepStrictEqual(pending.state.steps[descriptor.toolName], result) ||
          !isDeepStrictEqual(pending.state.outputs[descriptor.decisionOutputKey], result)
        ) {
          invalid(`completed LLM Tool decision ${step.stepKey} differs from its observation`);
        }
        replayState.steps[descriptor.toolName] = structuredClone(result);
        replayState.outputs[descriptor.decisionOutputKey] = structuredClone(result);
      }
      continue;
    }

    if (step.type === "transform") {
      const result: Record<string, unknown> = {};
      for (const [key, template] of Object.entries(step.mapping)) {
        result[key] = resolveTemplateValue(template, replayState);
      }
      if (
        !isDeepStrictEqual(pending.state.steps[step.stepKey], result) ||
        !isDeepStrictEqual(pending.state.outputs[step.outputKey], result)
      ) {
        invalid(`transform step ${step.stepKey} differs from canonical replay`);
      }
      replayState.steps[step.stepKey] = structuredClone(result);
      replayState.outputs[step.outputKey] = structuredClone(result);
      continue;
    }

    if (step.type === "wait_approval") {
      const result = pending.state.steps[step.stepKey];
      const decided = trace.events.find(
        (event) =>
          event.eventType === "approval_decided" &&
          event.stepKey === step.stepKey &&
          isRecord(result) &&
          event.data.approvalRequestId === result.approvalRequestId
      );
      if (
        !isRecord(result) ||
        !decided ||
        decided.data.decision !== result.decision ||
        decided.data.decidedBy !== result.decidedBy ||
        (Object.prototype.hasOwnProperty.call(decided.data, "comment") &&
          decided.data.comment !== result.comment) ||
        (Object.prototype.hasOwnProperty.call(decided.data, "decidedAt") &&
          decided.data.decidedAt !== result.decidedAt)
      ) {
        invalid(`Skill approval step ${step.stepKey} differs from its audit event`);
      }
    }

    if (
      !isDeepStrictEqual(
        pending.state.steps[step.stepKey],
        pending.state.outputs[step.outputKey]
      )
    ) {
      invalid(`completed step ${step.stepKey} has inconsistent state/output values`);
    }
    replayState.steps[step.stepKey] = structuredClone(pending.state.steps[step.stepKey]);
    replayState.outputs[step.outputKey] = structuredClone(pending.state.outputs[step.outputKey]);
  }

  for (const key of Object.keys(pending.state.steps)) {
    if (!allowedStepKeys.has(key)) {
      invalid(`state.steps contains unaudited key ${key}`);
    }
  }
  for (const key of Object.keys(pending.state.outputs)) {
    if (!allowedOutputKeys.has(key)) {
      invalid(`state.outputs contains unaudited key ${key}`);
    }
  }
}
