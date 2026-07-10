// ============================================================================
// HumanInputRuntime
// v0.3.8: runtime helpers for Skill human_input waiting / continue semantics
// ============================================================================

import { randomUUID } from "node:crypto";
import type { HumanInputStep } from "../core/types/skill";
import { traceLogger } from "../trace/trace-logger";
import type { SkillState } from "./skill-runtime";

export interface HumanInputRequest {
  humanInputRequestId: string;
  stepKey: string;
  prompt: string;
  outputKey: string;
}

export interface HumanInputResponse {
  humanInputRequestId: string;
  value: unknown;
  respondedBy?: string;
  respondedAt?: string;
}

export function buildHumanInputRequest(
  step: HumanInputStep,
  actorRunId: string
): HumanInputRequest {
  const request: HumanInputRequest = {
    humanInputRequestId: `hin_${randomUUID()}`,
    stepKey: step.stepKey,
    prompt: step.prompt,
    outputKey: step.outputKey,
  };

  traceLogger.record(actorRunId, "skill_step_start", {
    stepKey: step.stepKey,
    stepType: "human_input",
  });

  traceLogger.record(actorRunId, "human_input_requested", {
    ...request,
  });

  return request;
}

export function applyHumanInputResponse(
  request: HumanInputRequest,
  response: HumanInputResponse,
  state: SkillState,
  actorRunId: string
): void {
  state.steps[request.stepKey] = response.value;
  state.outputs[request.outputKey] = response.value;

  traceLogger.record(actorRunId, "human_input_received", {
    humanInputRequestId: request.humanInputRequestId,
    stepKey: request.stepKey,
    outputKey: request.outputKey,
    respondedBy: response.respondedBy,
    respondedAt: response.respondedAt,
  });

  traceLogger.record(actorRunId, "skill_step_end", {
    stepKey: request.stepKey,
    outputKey: request.outputKey,
  });
}
