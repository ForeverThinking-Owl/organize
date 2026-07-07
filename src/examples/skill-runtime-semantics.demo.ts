// ============================================================================
// skill-runtime-semantics.demo.ts — v0.3.5
// 验证 Skill Runtime 语义：严格解析、transform 一等执行、return output_mapping
// ============================================================================

import { actorRuntime, ActorRunOutput } from "../runtime/actor-runtime";
import { toolGateway } from "../tools/tool-gateway";
import {
  queryOrderInfoTool, QueryOrderInfoExecutor,
  queryTicketHistoryTool, QueryTicketHistoryExecutor,
  createTicketTool, CreateTicketExecutor,
} from "../tools/mock-tools";
import { traceLogger } from "../trace/trace-logger";
import { memoryService } from "../memory/memory-service";
import { approvalGate } from "../approvals/approval-gate";

const ACTOR_CONFIG = {
  actor_id: "customer_service_actor", organization_id: "org_001",
  unit_id: "unit_customer_service", name: "客服 Actor",
  type: "ai" as const, role: "customer_service",
  responsibility: "接收客户问题、查询上下文、判断问题类型、生成后续处理建议",
  autonomy_level: "L2_read_and_draft",
  memory: [
    "涉及退款时，不要承诺退款完成，只能说提交退款申请或等待财务确认。",
    "设备连接问题通常需要技术排查。",
  ],
  permissions: {
    allowed_tools: ["query_order_info", "query_ticket_history", "create_ticket"],
    denied_tools: ["create_refund_request", "approve_refund"],
    allowed_skills: ["skill_runtime_semantics"],
  },
  approval_judgment: {
    must_request_approval_when: ["创建 urgent 工单", "外部正式发送客户回复", "涉及退款承诺"],
  },
};

const TRIAGE_OUTPUT_SCHEMA = {
  type: "object",
  required: ["need_after_sales", "need_technical", "need_finance", "should_create_ticket", "reason"],
  properties: {
    analysis: { type: "object" },
    need_after_sales: { type: "boolean" },
    need_technical: { type: "boolean" },
    need_finance: { type: "boolean" },
    should_create_ticket: { type: "boolean" },
    reason: { type: "string" },
    risk_level: { type: "string", enum: ["low", "medium", "high"] },
  },
};

const SKILL_CONFIG = {
  skill_id: "skill_runtime_semantics", name: "Skill Runtime 语义验证",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "query_history", type: "tool_call", tool_name: "query_ticket_history",
      input_mapping: { customer_id: "{{context.customer_id}}" }, output_key: "ticket_history" },
    { step_key: "judge", type: "llm_judge",
      instruction: "判断客户咨询是否需要创建工单。",
      output_key: "triage_result", output_schema: TRIAGE_OUTPUT_SCHEMA },
    { step_key: "draft_reply", type: "transform",
      mapping: {
        summary: "Skill Runtime Semantics 验证完成",
        order_id: "{{context.order_id}}",
        order_status: "{{steps.query_order.status}}",
        customer_id: "{{steps.query_history.customerId}}",
        triage: "{{outputs.triage_result}}",
        should_create_ticket: "{{outputs.triage_result.should_create_ticket}}",
        observed_ticket_count: "{{steps.query_history.totalTickets}}",
      },
      output_key: "reply_draft" },
    { step_key: "return", type: "return",
      output_mapping: {
        summary: "{{outputs.reply_draft.summary}}",
        order_id: "{{outputs.reply_draft.order_id}}",
        order_status: "{{outputs.reply_draft.order_status}}",
        triage: "{{outputs.triage_result}}",
        should_create_ticket: "{{outputs.reply_draft.should_create_ticket}}",
        observed_ticket_count: "{{outputs.reply_draft.observed_ticket_count}}",
        source: "return_output_mapping",
      } },
  ],
};

const INVALID_SKILL_CONFIG = {
  skill_id: "invalid_skill_runtime_semantics", name: "非法 Skill Step 验证",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "bad_step", type: "unknown_step" },
  ],
};

interface CheckResult { label: string; pass: boolean; detail: string; }

function registerTools(): void {
  toolGateway.registerDefinition(queryOrderInfoTool);
  toolGateway.registerDefinition(queryTicketHistoryTool);
  toolGateway.registerDefinition(createTicketTool);
  toolGateway.registerExecutor("query_order_info", new QueryOrderInfoExecutor());
  toolGateway.registerExecutor("query_ticket_history", new QueryTicketHistoryExecutor());
  toolGateway.registerExecutor("create_ticket", new CreateTicketExecutor());
}

function resetRuntime(): void {
  traceLogger.clear();
  memoryService.clear();
  approvalGate.clear();
  registerTools();
}

function traceEvents(output: ActorRunOutput) {
  return traceLogger.getTrace(output.actorRunId)?.events ?? [];
}

function hasStepEvent(output: ActorRunOutput, eventType: string, stepKey: string): boolean {
  return traceEvents(output).some((event) => event.eventType === eventType && event.stepKey === stepKey);
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.3.5 — Skill Runtime Semantics Demo");
  console.log("=".repeat(60));
  console.log();

  resetRuntime();

  console.log("🚀 运行合法 Skill：tool_call → llm_judge → transform → return(output_mapping)");
  const output = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: "客户想查询订单状态。" },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  });

  console.log("  Status: " + output.status);
  console.log("  Result: " + JSON.stringify(output.result));
  console.log("  ToolCalls: " + output.toolCalls.length);
  console.log();

  console.log("🧪 运行非法 Skill：未知 step type 应显式失败");
  const invalidOutput = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: INVALID_SKILL_CONFIG,
    input: { text: "非法步骤验证。" },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  });
  const invalidError = traceEvents(invalidOutput).find((event) => event.eventType === "error");

  console.log("  InvalidStatus: " + invalidOutput.status);
  console.log("  InvalidError: " + String(invalidError?.data.message ?? ""));
  console.log();

  const result = output.result ?? {};
  const triage = result.triage as Record<string, unknown> | undefined;
  const checks: CheckResult[] = [
    {
      label: "合法 Skill 正常 completed",
      pass: output.status === "completed",
      detail: "status=" + output.status,
    },
    {
      label: "transform step_start 已记录",
      pass: hasStepEvent(output, "skill_step_start", "draft_reply"),
      detail: hasStepEvent(output, "skill_step_start", "draft_reply") ? "draft_reply start 已记录" : "缺少 draft_reply start",
    },
    {
      label: "transform step_end 已记录",
      pass: hasStepEvent(output, "skill_step_end", "draft_reply"),
      detail: hasStepEvent(output, "skill_step_end", "draft_reply") ? "draft_reply end 已记录" : "缺少 draft_reply end",
    },
    {
      label: "return 使用 output_mapping 生成最终输出",
      pass: result.source === "return_output_mapping",
      detail: "source=" + String(result.source),
    },
    {
      label: "output_mapping 可读取 context 值",
      pass: result.order_id === "ORDER_10086",
      detail: "order_id=" + String(result.order_id),
    },
    {
      label: "output_mapping 可读取 steps 值",
      pass: result.order_status === "delivered",
      detail: "order_status=" + String(result.order_status),
    },
    {
      label: "output_mapping 可保留 outputs 对象值",
      pass: typeof triage === "object" && triage?.should_create_ticket === false,
      detail: "triage=" + JSON.stringify(triage),
    },
    {
      label: "完整占位符保留布尔与数字类型",
      pass: result.should_create_ticket === false && result.observed_ticket_count === 2,
      detail: "should_create_ticket=" + String(result.should_create_ticket) + ", observed_ticket_count=" + String(result.observed_ticket_count),
    },
    {
      label: "未触发 create_ticket，final_output 未被后续工具覆盖",
      pass: !output.toolCalls.some((toolCall) => toolCall.toolName === "create_ticket") && result.source === "return_output_mapping",
      detail: "toolCalls=" + output.toolCalls.map((toolCall) => toolCall.toolName).join(", "),
    },
    {
      label: "未知 step type 显式进入 error",
      pass: invalidOutput.status === "error" && /Unsupported skill step type/.test(String(invalidError?.data.message ?? "")),
      detail: "status=" + invalidOutput.status + ", error=" + String(invalidError?.data.message ?? ""),
    },
  ];

  console.log("=".repeat(60));
  console.log("  ✅ Skill Runtime Semantics 验收检查 (10 条)");
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
    ? "  🎉 Skill Runtime Semantics 验证通过！"
    : "  ❌ 部分验收标准未通过");
  console.log("-".repeat(60));

  if (passCount !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error("Skill Runtime Semantics Demo 执行失败:", error);
  process.exit(1);
});
