// ============================================================================
// human-input-runtime.demo.ts — v0.4.0
// 验证 human_input Runtime 语义：suspend → resume → completed
// ============================================================================

import { actorRuntime, ActorRunOutput } from "../runtime/actor-runtime";
import { toolGateway } from "../tools/tool-gateway";
import { queryOrderInfoTool, QueryOrderInfoExecutor } from "../tools/mock-tools";
import { traceLogger } from "../trace/trace-logger";
import { memoryService } from "../memory/memory-service";
import { approvalGate } from "../approvals/approval-gate";
import type { TraceEvent } from "../core/types/trace";

const ACTOR_CONFIG = {
  actor_id: "customer_service_actor", organization_id: "org_001",
  unit_id: "unit_customer_service", name: "客服 Actor",
  type: "ai" as const, role: "customer_service",
  responsibility: "接收客户问题、查询上下文、等待人工补充输入、生成后续处理建议",
  autonomy_level: "L2_read_and_draft",
  memory: [
    "涉及退款时，不要承诺退款完成，只能说提交退款申请或等待财务确认。",
    "设备连接问题通常需要技术排查。",
  ],
  permissions: {
    allowed_tools: ["query_order_info"],
    denied_tools: ["create_refund_request", "approve_refund"],
    allowed_skills: ["human_input_runtime"],
  },
  approval_judgment: {
    must_request_approval_when: ["创建 urgent 工单", "外部正式发送客户回复", "涉及退款承诺"],
  },
};

const SKILL_CONFIG = {
  skill_id: "human_input_runtime", name: "Human Input Runtime 语义验证",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "ask_human", type: "human_input",
      prompt: "请人工确认是否允许继续生成客户回复草稿。",
      output_key: "human_confirmation" },
    { step_key: "draft_reply", type: "transform",
      mapping: {
        summary: "Human Input Runtime 验证完成",
        order_id: "{{outputs.order_info.orderId}}",
        human_confirmation_from_output: "{{outputs.human_confirmation}}",
        human_confirmation_from_step: "{{steps.ask_human}}",
        draft: "人工确认：{{outputs.human_confirmation}}；订单 {{outputs.order_info.orderId}} 可以继续生成回复草稿。",
      },
      output_key: "reply_draft" },
    { step_key: "return", type: "return",
      output_mapping: {
        summary: "{{outputs.reply_draft.summary}}",
        order_id: "{{outputs.reply_draft.order_id}}",
        human_confirmation_from_output: "{{outputs.reply_draft.human_confirmation_from_output}}",
        human_confirmation_from_step: "{{outputs.reply_draft.human_confirmation_from_step}}",
        draft: "{{outputs.reply_draft.draft}}",
        source: "human_input_runtime",
      } },
  ],
};

interface CheckResult { label: string; pass: boolean; detail: string; }

function registerTools(): void {
  toolGateway.registerDefinition(queryOrderInfoTool);
  toolGateway.registerExecutor("query_order_info", new QueryOrderInfoExecutor());
}

function resetRuntime(): void {
  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
  registerTools();
}

function traceEvents(output: ActorRunOutput): TraceEvent[] {
  return traceLogger.getTrace(output.actorRunId)?.events ?? [];
}

function findEvent(output: ActorRunOutput, eventType: string): TraceEvent | undefined {
  return traceEvents(output).find((event) => event.eventType === eventType);
}

function countRunEndEvents(output: ActorRunOutput): number {
  return traceEvents(output).filter((event) => event.eventType === "actor_run_end").length;
}

function hasRunEndStatus(output: ActorRunOutput, status: string): boolean {
  return traceEvents(output).some((event) =>
    event.eventType === "actor_run_end" && event.data.status === status
  );
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.4.0 — Human Input Runtime Demo");
  console.log("=".repeat(60));
  console.log();

  resetRuntime();

  console.log("🚀 第一次运行：执行到 human_input 时应暂停等待人工输入");
  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: "客户说扫码枪连不上系统，需要人工确认回复边界。" },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  });

  const requestedEvent = findEvent(waiting, "human_input_requested");
  const suspendedEvent = findEvent(waiting, "actor_run_suspended");
  const waitingRunEndCount = countRunEndEvents(waiting);
  console.log("  Status: " + waiting.status);
  console.log("  PendingHumanInput: " + JSON.stringify(waiting.pendingHumanInput ?? null));
  console.log("  HumanInputRequested: " + JSON.stringify(requestedEvent?.data ?? null));
  console.log("  RunSuspended: " + JSON.stringify(suspendedEvent?.data ?? null));
  console.log();

  if (!waiting.pendingHumanInput) {
    throw new Error("Expected pendingHumanInput before continue");
  }

  const humanValue = "允许继续生成草稿，但不要承诺退款已完成。";

  console.log("🙋 提交 human_input_response，Runtime 应 resume 并执行后续 transform / return");
  const completed = await actorRuntime.continue(waiting.actorRunId, {
    type: "human_input_response",
    response: {
      humanInputRequestId: waiting.pendingHumanInput.humanInputRequestId,
      value: humanValue,
      respondedBy: "human_operator",
      respondedAt: new Date().toISOString(),
    },
  });

  const receivedEvent = findEvent(completed, "human_input_received");
  const resumedEvent = findEvent(completed, "actor_run_resumed");
  const result = completed.result ?? {};
  console.log("  Status: " + completed.status);
  console.log("  Result: " + JSON.stringify(result));
  console.log("  RunResumed: " + JSON.stringify(resumedEvent?.data ?? null));
  console.log("  HumanInputReceived: " + JSON.stringify(receivedEvent?.data ?? null));
  console.log();

  const checks: CheckResult[] = [
    {
      label: "执行到 human_input 时返回 waiting_human_input",
      pass: waiting.status === "waiting_human_input",
      detail: "status=" + waiting.status,
    },
    {
      label: "输出 pendingHumanInput request",
      pass:
        waiting.pendingHumanInput.stepKey === "ask_human" &&
        waiting.pendingHumanInput.outputKey === "human_confirmation" &&
        waiting.pendingHumanInput.prompt.includes("人工确认"),
      detail: JSON.stringify(waiting.pendingHumanInput),
    },
    {
      label: "Trace 记录 human_input_requested",
      pass: requestedEvent?.data.humanInputRequestId === waiting.pendingHumanInput.humanInputRequestId,
      detail: JSON.stringify(requestedEvent?.data ?? null),
    },
    {
      label: "waiting_human_input 时 Trace 记录 actor_run_suspended 而不是 actor_run_end",
      pass:
        suspendedEvent?.data.status === "waiting_human_input" &&
        suspendedEvent.data.waitingKind === "human_input" &&
        waitingRunEndCount === 0,
      detail: "suspended=" + JSON.stringify(suspendedEvent?.data ?? null) + ", waitingRunEndCount=" + waitingRunEndCount,
    },
    {
      label: "continue(human_input_response) 后恢复并 completed",
      pass: completed.status === "completed",
      detail: "status=" + completed.status,
    },
    {
      label: "Trace 记录 actor_run_resumed",
      pass:
        resumedEvent?.data.waitingKind === "human_input" &&
        resumedEvent.data.resumedBy === "human_input_response",
      detail: JSON.stringify(resumedEvent?.data ?? null),
    },
    {
      label: "Trace 记录 human_input_received 且不记录完整 response value",
      pass:
        receivedEvent?.data.humanInputRequestId === waiting.pendingHumanInput.humanInputRequestId &&
        receivedEvent.data.respondedBy === "human_operator" &&
        !("value" in receivedEvent.data),
      detail: JSON.stringify(receivedEvent?.data ?? null),
    },
    {
      label: "human response 写入 state.outputs / state.steps 并被 transform 读取",
      pass: result.human_confirmation_from_output === humanValue && result.human_confirmation_from_step === humanValue,
      detail: "fromOutput=" + String(result.human_confirmation_from_output) + ", fromStep=" + String(result.human_confirmation_from_step),
    },
    {
      label: "return output_mapping 输出 human input 结果",
      pass: String(result.draft ?? "").includes(humanValue) && result.source === "human_input_runtime",
      detail: "draft=" + String(result.draft) + ", source=" + String(result.source),
    },
    {
      label: "最终 Trace 只记录 completed actor_run_end",
      pass: hasRunEndStatus(completed, "completed") && countRunEndEvents(completed) === 1,
      detail: "hasCompletedEnd=" + hasRunEndStatus(completed, "completed") + ", runEndCount=" + countRunEndEvents(completed),
    },
  ];

  console.log("=".repeat(60));
  console.log("  ✅ Human Input Runtime 验收检查 (10 条)");
  console.log("=".repeat(60));

  let passCount = 0;
  for (const [index, check] of checks.entries()) {
    if (check.pass) passCount++;
    console.log("  " + (check.pass ? "✅" : "❌") + " " + String(index + 1).padStart(2, "0") + ". " + check.label);
    console.log("      " + check.detail);
    console.log();
  }

  console.log("-".repeat(60));
  console.log("  通过: " + passCount + "/" + checks.length);
  console.log(passCount === checks.length
    ? "  🎉 Human Input Runtime 验证通过！"
    : "  ❌ 部分验收标准未通过");
  console.log("-".repeat(60));

  if (passCount !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error("Human Input Runtime Demo 执行失败:", error);
  process.exit(1);
});
