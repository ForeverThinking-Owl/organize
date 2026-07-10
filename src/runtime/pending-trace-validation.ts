import { isDeepStrictEqual } from "node:util";
import type { ActorRunTrace } from "../core/types/trace";
import type { PendingRunSnapshot } from "./pending-run-snapshot";

function invalid(message: string): never {
  throw new Error(`Invalid pending Trace binding: ${message}`);
}

/**
 * Bind the continuation token in a PendingRunSnapshot to the last audited
 * suspension event. Structural Trace validation must run before this helper.
 */
export function assertPendingRunTraceConsistency(
  pending: PendingRunSnapshot,
  trace: ActorRunTrace
): void {
  if (
    trace.actorRunId !== pending.actorRunId ||
    trace.actorId !== pending.actorId ||
    trace.skillId !== pending.skillId ||
    trace.status !== pending.status
  ) {
    invalid(`run identity/status differs for ${pending.actorRunId}`);
  }

  const suspended = [...trace.events]
    .reverse()
    .find((event) => event.eventType === "actor_run_suspended");
  if (!suspended) invalid(`run ${pending.actorRunId} has no suspension event`);

  const expected = (() => {
    switch (pending.pendingKind) {
      case "human_input":
        return {
          waitingKind: "human_input",
          requestId: pending.pendingHumanInput!.humanInputRequestId,
          stepKey: pending.pendingHumanInput!.stepKey,
        };
      case "skill_approval":
        return {
          waitingKind: "skill_approval",
          requestId: pending.pendingSkillApproval!.approvalRequestId,
          stepKey: pending.pendingSkillApproval!.stepKey,
          reason: pending.pendingSkillApproval!.reason,
        };
      case "tool_approval":
        return {
          waitingKind: "tool_approval",
          requestId: pending.pendingToolApproval!.approvalRequest.approvalRequestId,
          stepKey: pending.pendingToolApproval!.pendingExec.originatingStepKey,
          toolName: pending.pendingToolApproval!.approvalRequest.toolName,
          reason: pending.pendingToolApproval!.approvalRequest.reason,
        };
      case "external_event":
        return {
          waitingKind: "external_event",
          requestId: pending.pendingExternalEvent!.externalEventRequestId,
          stepKey: pending.pendingExternalEvent!.stepKey,
          eventName: pending.pendingExternalEvent!.eventName,
          correlationKey: pending.pendingExternalEvent!.correlationKey,
        };
    }
  })();

  if (suspended.data.status !== pending.status) {
    invalid(`suspension status differs for ${pending.actorRunId}`);
  }

  if (pending.pendingKind === "human_input") {
    const request = pending.pendingHumanInput!;
    const requested = trace.events.find(
      (event) =>
        event.eventType === "human_input_requested" &&
        event.data.humanInputRequestId === request.humanInputRequestId
    );
    if (
      !requested ||
      requested.sequence >= suspended.sequence ||
      requested.data.stepKey !== request.stepKey ||
      requested.data.prompt !== request.prompt ||
      requested.data.outputKey !== request.outputKey
    ) {
      invalid(`human input request audit data differs for ${pending.actorRunId}`);
    }
  }

  if (pending.pendingKind === "skill_approval") {
    const request = pending.pendingSkillApproval!;
    const requested = trace.events.find(
      (event) =>
        event.eventType === "approval_requested" &&
        event.data.approvalKind === "skill_step" &&
        event.data.approvalRequestId === request.approvalRequestId
    );
    if (
      !requested ||
      requested.sequence >= suspended.sequence ||
      requested.data.stepKey !== request.stepKey ||
      requested.data.reason !== request.reason ||
      requested.data.outputKey !== request.outputKey
    ) {
      invalid(`Skill approval request audit data differs for ${pending.actorRunId}`);
    }
  }

  if (pending.pendingKind === "external_event") {
    const request = pending.pendingExternalEvent!;
    const requested = trace.events.find(
      (event) =>
        event.eventType === "external_event_requested" &&
        event.data.externalEventRequestId === request.externalEventRequestId
    );
    if (
      !requested ||
      requested.sequence >= suspended.sequence ||
      requested.data.stepKey !== request.stepKey ||
      requested.data.eventName !== request.eventName ||
      requested.data.correlationKey !== request.correlationKey ||
      requested.data.reason !== request.reason ||
      requested.data.outputKey !== request.outputKey ||
      !isDeepStrictEqual(requested.data.eventSchema, request.eventSchema)
    ) {
      invalid(`external event request audit data differs for ${pending.actorRunId}`);
    }
  }
  for (const [field, value] of Object.entries(expected)) {
    if (
      pending.pendingKind === "tool_approval" &&
      field === "stepKey" &&
      suspended.data.stepKey === undefined
    ) {
      continue;
    }
    if (suspended.data[field] !== value) {
      invalid(`suspension ${field} differs for ${pending.actorRunId}`);
    }
  }

  if (pending.pendingKind === "tool_approval") {
    const approval = pending.pendingToolApproval!.approvalRequest;
    const requested = [...trace.events].reverse().find(
      (event) =>
        event.eventType === "approval_requested" &&
        event.data.approvalRequestId === approval.approvalRequestId
    );
    if (
      !requested ||
      requested.sequence >= suspended.sequence ||
      requested.data.toolCallId !== approval.toolCallId ||
      requested.data.toolName !== approval.toolName ||
      requested.data.stage !== approval.stage ||
      requested.data.reason !== approval.reason ||
      !isDeepStrictEqual(requested.data.proposedArguments, approval.proposedArguments)
    ) {
      invalid(`approval request audit data differs for ${pending.actorRunId}`);
    }

    const currentStep = pending.skill.steps[pending.state.currentStepIndex];
    if (currentStep.type === "llm_judge") {
      const judged = [...trace.events].reverse().find(
        (event) =>
          event.eventType === "decision_generated" &&
          event.stepKey === currentStep.stepKey &&
          event.data.decisionType === "post_judge"
      );
      if (
        !judged ||
        !isDeepStrictEqual(judged.data.judgeResult, pending.state.steps[currentStep.stepKey]) ||
        !isDeepStrictEqual(
          pending.state.outputs[currentStep.outputKey],
          pending.state.steps[currentStep.stepKey]
        )
      ) {
        invalid(`llm_judge state differs from its audit event for ${pending.actorRunId}`);
      }
    }
  }
}
