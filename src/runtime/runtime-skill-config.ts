import type {
  EndStep,
  HandoffStep,
  HumanInputStep,
  LLMJudgeStep,
  ReturnStep,
  Skill,
  SkillConfig,
  SkillStep,
  SkillStepConfig,
  ToolCallStep,
  TransformStep,
  WaitApprovalStep,
  WaitExternalEventStep,
} from "../core/types/skill";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonSafe(value: unknown, path: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain finite numbers`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} is not JSON-safe`);
  if (seen.has(value)) throw new Error(`${path} contains a circular reference`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) throw new Error(`${path}[${index}] is a sparse array entry`);
      assertJsonSafe(value[index], `${path}[${index}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new Error(`${path} must be a plain JSON object`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafe(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
}

function assertSkillStepShape(config: SkillStepConfig, index: number): void {
  if (!isRecord(config)) throw new Error(`Skill step ${index} must be an object`);
  const base = ["step_key", "type", "description"];
  const specific: Record<string, string[]> = {
    tool_call: ["tool_name", "input_mapping", "output_key"],
    llm_judge: ["instruction", "output_key", "output_schema"],
    transform: ["mapping", "output_key"],
    return: ["output_mapping"],
    handoff: ["target_actor_id", "target_skill_id", "reason", "input_mapping"],
    human_input: ["prompt", "output_key"],
    wait_approval: ["approval_request_id", "reason", "output_key"],
    wait_external_event: ["event_name", "correlation_key", "reason", "output_key", "event_schema"],
    end: [],
  };
  if (typeof config.type !== "string" || !(config.type in specific)) {
    throw new Error(`Unsupported skill step type: ${String(config.type)} at step ${String(config.step_key)}`);
  }
  assertExactKeys(config, [...base, ...specific[config.type]], `steps[${index}]`);
}

export function assertSkillConfig(value: unknown): asserts value is SkillConfig {
  assertJsonSafe(value, "SkillConfig");
  if (!isRecord(value)) throw new Error("Skill config must be an object");
  assertExactKeys(value, ["skill_id", "name", "description", "owner_actor_id", "steps"], "SkillConfig");
  if (typeof value.skill_id !== "string" || value.skill_id.length === 0) {
    throw new Error("Skill config requires a non-empty skill_id");
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error(`Skill ${value.skill_id} requires a non-empty name`);
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error(`Skill ${value.skill_id} description must be a string`);
  }
  if (
    value.owner_actor_id !== undefined &&
    (typeof value.owner_actor_id !== "string" || value.owner_actor_id.length === 0)
  ) {
    throw new Error(`Skill ${value.skill_id} owner_actor_id must be a non-empty string`);
  }
  if (!Array.isArray(value.steps)) {
    throw new Error(`Skill ${value.skill_id} requires a steps array`);
  }
  value.steps.forEach((step, index) =>
    assertSkillStepShape(step as SkillStepConfig, index)
  );
}

function requiredString(config: SkillStepConfig, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Skill step ${config.step_key} (${config.type}) requires string field: ${key}`);
  }
  return value;
}

function optionalString(config: SkillStepConfig, key: string): string | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Skill step ${config.step_key} (${config.type}) field ${key} must be a string`);
  }
  return value;
}

function optionalNonEmptyString(config: SkillStepConfig, key: string): string | undefined {
  const value = optionalString(config, key);
  if (value !== undefined && value.length === 0) {
    throw new Error(`Skill step ${config.step_key} (${config.type}) field ${key} must not be empty`);
  }
  return value;
}

function requiredMapping(config: SkillStepConfig, key: string): Record<string, string> {
  const value = config[key];
  if (!isRecord(value)) {
    throw new Error(`Skill step ${config.step_key} (${config.type}) requires mapping field: ${key}`);
  }
  for (const [mappingKey, mappingValue] of Object.entries(value)) {
    if (typeof mappingValue !== "string") {
      throw new Error(`Skill step ${config.step_key} (${config.type}) mapping ${key}.${mappingKey} must be a string`);
    }
  }
  return value as Record<string, string>;
}

function optionalMapping(config: SkillStepConfig, key: string): Record<string, string> | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Skill step ${config.step_key} (${config.type}) field ${key} must be a mapping`);
  }
  for (const [mappingKey, mappingValue] of Object.entries(value)) {
    if (typeof mappingValue !== "string") {
      throw new Error(`Skill step ${config.step_key} (${config.type}) mapping ${key}.${mappingKey} must be a string`);
    }
  }
  return value as Record<string, string>;
}

export function parseSkillStepConfig(config: SkillStepConfig): SkillStep {
  const base = {
    stepKey: requiredString(config, "step_key"),
    description: optionalString(config, "description"),
  };

  switch (config.type) {
    case "tool_call":
      return {
        ...base,
        type: "tool_call",
        toolName: requiredString(config, "tool_name"),
        inputMapping: requiredMapping(config, "input_mapping"),
        outputKey: requiredString(config, "output_key"),
      } as ToolCallStep;
    case "llm_judge":
      if (config.output_schema !== undefined && !isRecord(config.output_schema)) {
        throw new Error(`Skill step ${config.step_key} (${config.type}) field output_schema must be an object`);
      }
      return {
        ...base,
        type: "llm_judge",
        instruction: requiredString(config, "instruction"),
        outputKey: requiredString(config, "output_key"),
        outputSchema: isRecord(config.output_schema) ? config.output_schema : undefined,
      } as LLMJudgeStep;
    case "transform":
      return {
        ...base,
        type: "transform",
        mapping: requiredMapping(config, "mapping"),
        outputKey: requiredString(config, "output_key"),
      } as TransformStep;
    case "return":
      return {
        ...base,
        type: "return",
        outputMapping: optionalMapping(config, "output_mapping"),
      } as ReturnStep;
    case "handoff":
      return {
        ...base,
        type: "handoff",
        targetActorId: requiredString(config, "target_actor_id"),
        targetSkillId: requiredString(config, "target_skill_id"),
        reason: requiredString(config, "reason"),
        inputMapping: requiredMapping(config, "input_mapping"),
      } as HandoffStep;
    case "human_input":
      return {
        ...base,
        type: "human_input",
        prompt: requiredString(config, "prompt"),
        outputKey: requiredString(config, "output_key"),
      } as HumanInputStep;
    case "wait_approval":
      return {
        ...base,
        type: "wait_approval",
        approvalRequestId: optionalNonEmptyString(config, "approval_request_id"),
        reason: requiredString(config, "reason"),
        outputKey: requiredString(config, "output_key"),
      } as WaitApprovalStep;
    case "wait_external_event":
      if (config.event_schema !== undefined && !isRecord(config.event_schema)) {
        throw new Error(`Skill step ${config.step_key} (${config.type}) field event_schema must be an object`);
      }
      return {
        ...base,
        type: "wait_external_event",
        eventName: requiredString(config, "event_name"),
        correlationKey: optionalString(config, "correlation_key"),
        reason: optionalString(config, "reason"),
        outputKey: requiredString(config, "output_key"),
        eventSchema: isRecord(config.event_schema) ? config.event_schema : undefined,
      } as WaitExternalEventStep;
    case "end":
      return { ...base, type: "end" } as EndStep;
    default:
      throw new Error(`Unsupported skill step type: ${String(config.type)} at step ${config.step_key}`);
  }
}

export function parseSkillConfig(config: SkillConfig, actorId: string): Skill {
  assertSkillConfig(config);
  const steps = config.steps.map(parseSkillStepConfig);
  const stepKeys = new Set<string>();
  for (const step of steps) {
    if (stepKeys.has(step.stepKey)) {
      throw new Error(`Skill ${config.skill_id} contains duplicate step_key ${step.stepKey}`);
    }
    stepKeys.add(step.stepKey);
  }
  const handoffIndex = steps.findIndex((step) => step.type === "handoff");
  if (handoffIndex !== -1 && handoffIndex !== steps.length - 1) {
    throw new Error(
      `Skill ${config.skill_id} handoff step ${steps[handoffIndex].stepKey} must be the final step`
    );
  }
  return {
    skillId: config.skill_id,
    name: config.name,
    description: config.description,
    ownerActorId: config.owner_actor_id ?? actorId,
    steps,
  };
}

export function buildInitialSkillContext(
  input: { payload?: Record<string, unknown> },
  runtimeContext: Record<string, unknown>
): Record<string, unknown> {
  return {
    context: {
      order_id: runtimeContext.order_id ?? "ORDER_10086",
      customer_id: runtimeContext.customer_id ?? "C001",
      ...runtimeContext,
    },
    ...input.payload,
    ...runtimeContext,
  };
}
