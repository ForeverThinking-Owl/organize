// ============================================================================
// ToolGateway — 工具网关
// 接收 ToolCall，路由到对应实现，返回 ToolObservation
// ============================================================================

import {
  ToolCallRequest,
  ToolObservation,
  ToolDefinition,
} from "../core/types/tool";
import { MockToolExecutor } from "./mock-tools";
import { traceLogger } from "../trace/trace-logger";
import { validateToolOutput } from "./tool-schema-validation";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${path} must be a plain JSON object`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonSafe(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function cloneJson<T>(value: T): T {
  assertJsonSafe(value, "Tool value");
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertToolDefinition(definition: unknown): asserts definition is ToolDefinition {
  assertJsonSafe(definition, "Tool definition");
  if (!isPlainRecord(definition)) throw new Error("Tool definition must be a plain object");
  const allowed = new Set([
    "toolName", "displayName", "description", "direction", "riskLevel",
    "inputSchema", "outputSchema", "approvalPolicy",
  ]);
  if (Object.keys(definition).some((field) => !allowed.has(field))) {
    throw new Error("Tool definition has unsupported fields");
  }
  if (typeof definition.toolName !== "string" || definition.toolName.length === 0) {
    throw new Error("Tool definition requires a non-empty toolName");
  }
  if (definition.displayName !== undefined && typeof definition.displayName !== "string") {
    throw new Error(`Tool ${definition.toolName} displayName must be a string`);
  }
  if (typeof definition.description !== "string") {
    throw new Error(`Tool ${definition.toolName} description must be a string`);
  }
  if (!["read", "write"].includes(String(definition.direction))) {
    throw new Error(`Tool ${definition.toolName} direction is invalid`);
  }
  if (!["low", "medium", "high", "critical"].includes(String(definition.riskLevel))) {
    throw new Error(`Tool ${definition.toolName} riskLevel is invalid`);
  }
  for (const field of ["inputSchema", "outputSchema"] as const) {
    if (definition[field] !== undefined && !isPlainRecord(definition[field])) {
      throw new Error(`Tool ${definition.toolName} ${field} must be an object`);
    }
  }
  if (definition.approvalPolicy === undefined) return;
  if (!isPlainRecord(definition.approvalPolicy)) {
    throw new Error(`Tool ${definition.toolName} approvalPolicy must be an object`);
  }
  const stages = new Set(["beforeCall", "afterCall", "beforeWriteback"]);
  if (Object.keys(definition.approvalPolicy).some((field) => !stages.has(field))) {
    throw new Error(`Tool ${definition.toolName} approvalPolicy has unsupported stages`);
  }
  const unimplementedStage = (["afterCall", "beforeWriteback"] as const).find((stage) =>
    Object.prototype.hasOwnProperty.call(definition.approvalPolicy, stage)
  );
  if (unimplementedStage) {
    throw new Error(
      `Tool ${definition.toolName} approvalPolicy.${unimplementedStage} is not implemented; only beforeCall is supported`
    );
  }
  for (const [stageName, stageValue] of Object.entries(definition.approvalPolicy)) {
    if (!isPlainRecord(stageValue)) {
      throw new Error(`Tool ${definition.toolName} ${stageName} policy must be an object`);
    }
    const stageFields = new Set([
      "requiredWhen", "allowModifyArguments", "allowReject", "allowComment",
    ]);
    if (Object.keys(stageValue).some((field) => !stageFields.has(field))) {
      throw new Error(`Tool ${definition.toolName} ${stageName} policy has unsupported fields`);
    }
    for (const flag of ["allowModifyArguments", "allowReject", "allowComment"] as const) {
      if (stageValue[flag] !== undefined && typeof stageValue[flag] !== "boolean") {
        throw new Error(`Tool ${definition.toolName} ${stageName}.${flag} must be boolean`);
      }
    }
    if (stageValue.requiredWhen === undefined) continue;
    if (!Array.isArray(stageValue.requiredWhen)) {
      throw new Error(`Tool ${definition.toolName} ${stageName}.requiredWhen must be an array`);
    }
    for (const [index, condition] of stageValue.requiredWhen.entries()) {
      if (!isPlainRecord(condition)) {
        throw new Error(`Tool ${definition.toolName} ${stageName}.requiredWhen[${index}] is invalid`);
      }
      const conditionFields = new Set(["field", "operator", "value"]);
      if (
        Object.keys(condition).some((field) => !conditionFields.has(field)) ||
        typeof condition.field !== "string" ||
        condition.field.length === 0 ||
        !["<=", ">=", "<", ">", "==", "!="].includes(String(condition.operator)) ||
        !["string", "number", "boolean"].includes(typeof condition.value)
      ) {
        throw new Error(`Tool ${definition.toolName} ${stageName}.requiredWhen[${index}] is invalid`);
      }
    }
  }
}

function assertObservation(
  value: unknown,
  request: ToolCallRequest,
  definition: ToolDefinition
): asserts value is ToolObservation {
  if (!isPlainRecord(value)) throw new Error(`Tool ${request.toolName} returned a non-object observation`);
  const allowed = new Set(["toolCallId", "toolName", "status", "data", "error", "executedAt"]);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new Error(`Tool ${request.toolName} returned unsupported observation fields`);
  }
  if (value.toolCallId !== request.toolCallId || value.toolName !== request.toolName) {
    throw new Error(`Tool ${request.toolName} returned mismatched observation identity`);
  }
  if (!["success", "error", "permission_denied", "pending_approval"].includes(String(value.status))) {
    throw new Error(`Tool ${request.toolName} returned an invalid observation status`);
  }
  if (typeof value.executedAt !== "string" || value.executedAt.length === 0) {
    throw new Error(`Tool ${request.toolName} returned an invalid executedAt`);
  }
  if (value.data !== undefined && !isPlainRecord(value.data)) {
    throw new Error(`Tool ${request.toolName} returned invalid observation data`);
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    throw new Error(`Tool ${request.toolName} returned an invalid observation error`);
  }
  assertJsonSafe(value, `Tool ${request.toolName} observation`);
  if (value.status === "success" && definition.outputSchema) {
    const errors = validateToolOutput(value.data, definition.outputSchema);
    if (errors.length > 0) {
      throw new Error(`Tool ${request.toolName} returned invalid output: ${errors.join("; ")}`);
    }
  }
}

export class ToolGateway {
  private toolDefinitions: Map<string, ToolDefinition> = new Map();
  private executors: Map<string, MockToolExecutor> = new Map();

  /** 注册 Tool 定义 */
  registerDefinition(def: ToolDefinition): void {
    assertToolDefinition(def);
    this.toolDefinitions.set(def.toolName, cloneJson(def));
  }

  /** 注册 Tool 执行器 */
  registerExecutor(toolName: string, executor: MockToolExecutor): void {
    this.executors.set(toolName, executor);
  }

  /** 获取 Tool 定义 */
  getDefinition(toolName: string): ToolDefinition | undefined {
    const definition = this.toolDefinitions.get(toolName);
    return definition ? structuredClone(definition) : undefined;
  }

  /** 获取所有 Tool 定义 */
  getAllDefinitions(): ToolDefinition[] {
    return Array.from(this.toolDefinitions.values(), (definition) => structuredClone(definition));
  }

  /** 执行 Tool */
  async execute(
    request: ToolCallRequest,
    actorRunId: string
  ): Promise<ToolObservation> {
    const definition = this.toolDefinitions.get(request.toolName);
    if (!definition) {
      throw new Error(`Tool ${request.toolName} has no registered definition`);
    }

    const executor = this.executors.get(request.toolName);
    if (!executor) {
      const obs: ToolObservation = {
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        status: "error",
        error: `No executor found for tool: ${request.toolName}`,
        executedAt: new Date().toISOString(),
      };
      traceLogger.record(actorRunId, "tool_observation", obs as unknown as Record<string, unknown>);
      return obs;
    }

    // Validate and detach the request before declaring execution started. An
    // invalid request must never produce a false tool_call_start event.
    const safeRequest = cloneJson(request);
    traceLogger.record(actorRunId, "tool_call_start", {
      toolName: safeRequest.toolName,
      arguments: safeRequest.arguments,
      toolCallId: safeRequest.toolCallId,
    });

    const observation = await executor.execute(cloneJson(safeRequest));
    assertObservation(observation, safeRequest, definition);
    const safeObservation = cloneJson(observation);
    traceLogger.record(actorRunId, "tool_call_end", {
      toolName: safeRequest.toolName,
      status: safeObservation.status,
    });
    traceLogger.record(actorRunId, "tool_observation", safeObservation as unknown as Record<string, unknown>);
    return cloneJson(safeObservation);
  }
}

export const toolGateway = new ToolGateway();
