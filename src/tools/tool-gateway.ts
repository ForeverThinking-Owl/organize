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

export class ToolGateway {
  private toolDefinitions: Map<string, ToolDefinition> = new Map();
  private executors: Map<string, MockToolExecutor> = new Map();

  /** 注册 Tool 定义 */
  registerDefinition(def: ToolDefinition): void {
    this.toolDefinitions.set(def.toolName, def);
  }

  /** 注册 Tool 执行器 */
  registerExecutor(toolName: string, executor: MockToolExecutor): void {
    this.executors.set(toolName, executor);
  }

  /** 获取 Tool 定义 */
  getDefinition(toolName: string): ToolDefinition | undefined {
    return this.toolDefinitions.get(toolName);
  }

  /** 获取所有 Tool 定义 */
  getAllDefinitions(): ToolDefinition[] {
    return Array.from(this.toolDefinitions.values());
  }

  /** 执行 Tool */
  async execute(
    request: ToolCallRequest,
    actorRunId: string
  ): Promise<ToolObservation> {
    traceLogger.record(actorRunId, "tool_call_start", {
      toolName: request.toolName,
      arguments: request.arguments,
      toolCallId: request.toolCallId,
    });

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

    const observation = await executor.execute(request);
    traceLogger.record(actorRunId, "tool_call_end", {
      toolName: request.toolName,
      status: observation.status,
    });
    traceLogger.record(actorRunId, "tool_observation", observation as unknown as Record<string, unknown>);
    return observation;
  }
}

export const toolGateway = new ToolGateway();
