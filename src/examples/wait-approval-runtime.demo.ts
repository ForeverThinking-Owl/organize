// ============================================================================
// wait-approval-runtime.demo.ts — v0.3.9
// 验证 wait_approval Runtime 语义：waiting_approval → continue → completed
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
  responsibility: "接收客户问题、查询上下文、等待人工审批、生成后续处理建议",
  autonomy_level: "L2_read_and_draft",
  memory: [
    "涉及退款时，不要承诺退款完成，只能说提交退款申请或等待财务确认。",
    "设备连接问题通常需要技术排查。",
  ],
  permissions: {
    allowed_tools: ["query_order_info"],
    denied_tools: ["create_refund_request", "approve_refund"],
    allowed_skills: ["wait_approval_runtime"],
  },
  approval_judgment: {
    must_request_approval_when: ["创建 urgent 工单", "外部正式发送客户回复", "涉及退款承诺"],
  },
};

const SKILL_CONFIG = {
  skill_id: "wait_approval_runtime", name: "Wait Approval Runtime 语义验证",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "manual_approval", type: "wait_approval",
      reason: "请人工审批是否允许继续生成正式客户回复。",
      output_key: "approval_result" },
    { step_key: "draft_reply", type: "transform",
      mapping: {
        summary: "Wait Approval Runtime 验证完成",
        order_id: "{{outputs.order_info.orderId}}",
        approval_decision_from_output: "{{outputs.approval_result.decision}}",
        approval_comment_from_output: "{{outputs.approval_result.comment}}",
        approval_decision_from_step: "{{steps.manual_approval.decision}}",
        draft: "审批结果：{{outputs.approval_result.decision}}；审批意见：{{outputs.approval_result.comment}}；订单 {{outputs.order_info.orderId}} 可以继续生成回复草稿。",
      },
      output_key: "reply_draft" },
    { step_key: "return", type: "return",
      output_mapping: {
        summary: "{{outputs.reply_draft.summary}}",
        order_id: "{{outputs.reply_draft.order_id}}",
        approval_decision_from_output: "{{outputs.reply_draft.approval_decision_from_output}}",
        approval_comment_from_output: "{{outputs.reply_draft.approval_comment_from_output}}",
        approval_decision_from_step: "{{outputs.reply_draft.approval_decision_from_step}}",
        draft: "{{outputs.reply_draft.draft}}",
        source: "wait_approval_runtime",
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

function hasRunEndStatus(output: ActorRunOutput, status: string): boolean {
  return traceEvents(output).some((event) =>
    event.eventType === "actor_run_end" && event.data.status === status
  );
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.3.9 — Wait Approval Runtime Demo");
  console.log("=".repeat(60));
  console.log();

  resetRuntime();

  console.log("🚀 第一次运行：执行到 wait_approval 时应暂停等待审批");
  const waiting = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: "客户说扫码枪连不上系统，需要人工审批是否继续生成正式回复。" },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  });

  const requestedEvent = findEvent(waiting, "approval_requested");
  console.log("  Status: " + waiting.status);
  console.log("  PendingApproval: " + JSON.stringify(waiting.pendingApproval ?? null));
  console.log("  ApprovalRequested: " + JSON.stringify(requestedEvent?.data ?? null));
  console.log();

  if (!waiting.pendingApproval) {
    throw new Error("Expected pendingApproval before continue");
  }

  const approvalComment = "允许继续生成草稿，但需要避免承诺退款已完成。";

  console.log("✅ 提交 approval_decision，Runtime 应恢复执行后续 transform / return");
  const completed = await actorRuntime.continue(waiting.actorRunId, {
    type: "approval_decision",
    decision: {
      approvalRequestId: waiting.pendingApproval.approvalRequestId,
      decision: "approve_with_comment",
      comment: approvalComment,
      decidedBy: "approval_operator",
      decidedAt: new Date().toISOString(),
    },
  });

  const decidedEvent = findEvent(completed, "approval_decided");
  const result = completed.result ?? {};
  console.log("  Status: " + completed.status);
  console.log("  Result: " + JSON.stringify(result));
  console.log("  ApprovalDecided: " + JSON.stringify(decidedEvent?.data ?? null));
  console.log();

  const checks: CheckResult[] = [
    {
      label: "执行到 wait_approval 时返回 waiting_approval",
      pass: waiting.status === "waiting_approval",
      detail: "status=" + waiting.status,
    },
    {
      label: "输出 pendingApproval request",
      pass:
        waiting.pendingApproval.approvalKind === "skill_step" &&
        waiting.pendingApproval.stepKey === "manual_approval" &&
        waiting.pendingApproval.outputKey === "approval_result" &&
        waiting.pendingApproval.reason.includes("人工审批"),
      detail: JSON.stringify(waiting.pendingApproval),
    },
    {
      label: "Trace 记录 approval_requested 且 approvalKind=skill_step",
      pass:
        requestedEvent?.data.approvalKind === "skill_step" &&
        requestedEvent.data.approvalRequestId === waiting.pendingApproval.approvalRequestId,
      detail: JSON.stringify(requestedEvent?.data ?? null),
    },
    {
      label: "waiting_approval 时 Trace 记录 actor_run_end",
      pass: hasRunEndStatus(waiting, "waiting_approval"),
      detail: "hasWaitingEnd=" + hasRunEndStatus(waiting, "waiting_approval"),
    },
    {
      label: "continue(approval_decision) 后恢复并 completed",
      pass: completed.status === "completed",
      detail: "status=" + completed.status,
    },
    {
      label: "Trace 记录 approval_decided 且来源为 skill_step",
      pass:
        decidedEvent?.data.approvalKind === "skill_step" &&
        decidedEvent.data.decision === "approve_with_comment" &&
        decidedEvent.data.decidedBy === "approval_operator",
      detail: JSON.stringify(decidedEvent?.data ?? null),
    },
    {
      label: "approval decision 写入 state.outputs 并被 transform 读取",
      pass: result.approval_decision_from_output === "approve_with_comment" && result.approval_comment_from_output === approvalComment,
      detail: "decision=" + String(result.approval_decision_from_output) + ", comment=" + String(result.approval_comment_from_output),
    },
    {
      label: "approval decision 写入 state.steps 并被 transform 读取",
      pass: result.approval_decision_from_step === "approve_with_comment",
      detail: "approval_decision_from_step=" + String(result.approval_decision_from_step),
    },
    {
      label: "return output_mapping 输出 approval decision",
      pass: String(result.draft ?? "").includes(approvalComment) && result.source === "wait_approval_runtime",
      detail: "draft=" + String(result.draft) + ", source=" + String(result.source),
    },
    {
      label: "最终 Trace 记录 completed actor_run_end",
      pass: hasRunEndStatus(completed, "completed"),
      detail: "hasCompletedEnd=" + hasRunEndStatus(completed, "completed"),
    },
  ];

  console.log("=".repeat(60));
  console.log("  ✅ Wait Approval Runtime 验收检查 (10 条)");
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
    ? "  🎉 Wait Approval Runtime 验证通过！"
    : "  ❌ 部分验收标准未通过");
  console.log("-".repeat(60));

  if (passCount !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error("Wait Approval Runtime Demo 执行失败:", error);
  process.exit(1);
});
