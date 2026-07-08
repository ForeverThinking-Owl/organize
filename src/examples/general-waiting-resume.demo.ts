// ============================================================================
// general-waiting-resume.demo.ts — v0.4.0
// 验证通用 waiting / resume 生命周期：human_input、Skill approval、ToolCall approval
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
import type { TraceEvent } from "../core/types/trace";

const BASE_ACTOR_CONFIG = {
  actor_id: "customer_service_actor", organization_id: "org_001",
  unit_id: "unit_customer_service", name: "客服 Actor",
  type: "ai" as const, role: "customer_service",
  responsibility: "接收客户问题、查询上下文、处理等待/恢复、生成后续处理建议",
  autonomy_level: "L2_read_and_draft",
  memory: [
    "涉及退款时，不要承诺退款完成，只能说提交退款申请或等待财务确认。",
    "设备连接问题通常需要技术排查。",
  ],
  permissions: {
    allowed_tools: ["query_order_info", "query_ticket_history", "create_ticket"],
    denied_tools: ["create_refund_request", "approve_refund"],
    allowed_skills: ["general_waiting_human", "general_waiting_skill_approval", "general_waiting_tool_approval"],
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

const HUMAN_INPUT_SKILL = {
  skill_id: "general_waiting_human", name: "General Waiting Human Input",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "ask_human", type: "human_input",
      prompt: "请人工补充是否允许继续。", output_key: "human_confirmation" },
    { step_key: "return", type: "return",
      output_mapping: { summary: "human input completed", human_confirmation: "{{outputs.human_confirmation}}" } },
  ],
};

const SKILL_APPROVAL_SKILL = {
  skill_id: "general_waiting_skill_approval", name: "General Waiting Skill Approval",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "manual_approval", type: "wait_approval",
      reason: "请人工审批是否允许继续。", output_key: "approval_result" },
    { step_key: "return", type: "return",
      output_mapping: { summary: "skill approval completed", approval_decision: "{{outputs.approval_result.decision}}" } },
  ],
};

const TOOL_APPROVAL_SKILL = {
  skill_id: "general_waiting_tool_approval", name: "General Waiting Tool Approval",
  owner_actor_id: "customer_service_actor",
  steps: [
    { step_key: "query_order", type: "tool_call", tool_name: "query_order_info",
      input_mapping: { order_id: "{{context.order_id}}" }, output_key: "order_info" },
    { step_key: "query_history", type: "tool_call", tool_name: "query_ticket_history",
      input_mapping: { customer_id: "{{context.customer_id}}" }, output_key: "ticket_history" },
    { step_key: "judge", type: "llm_judge",
      instruction: "判断客户问题是否涉及售后、技术、财务，并决定是否创建工单。",
      output_key: "triage_result", output_schema: TRIAGE_OUTPUT_SCHEMA },
    { step_key: "return", type: "return" },
  ],
};

interface CheckResult { label: string; pass: boolean; detail: string; }
interface ScenarioResult {
  waiting: ActorRunOutput;
  completed: ActorRunOutput;
  waitingRunEndCount: number;
  waitingEndedAt: string | undefined;
}

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

function traceEvents(output: ActorRunOutput): TraceEvent[] {
  return traceLogger.getTrace(output.actorRunId)?.events ?? [];
}

function findEvent(output: ActorRunOutput, eventType: string): TraceEvent | undefined {
  return traceEvents(output).find((event) => event.eventType === eventType);
}

function countRunEndEvents(output: ActorRunOutput): number {
  return traceEvents(output).filter((event) => event.eventType === "actor_run_end").length;
}

function endedAt(output: ActorRunOutput): string | undefined {
  return traceLogger.getTrace(output.actorRunId)?.endedAt;
}

function hasCompletedEnd(output: ActorRunOutput): boolean {
  return traceEvents(output).some((event) => event.eventType === "actor_run_end" && event.data.status === "completed");
}

function runArgs(skillConfig: typeof HUMAN_INPUT_SKILL | typeof SKILL_APPROVAL_SKILL | typeof TOOL_APPROVAL_SKILL, text: string) {
  return {
    actorConfig: BASE_ACTOR_CONFIG,
    skillConfig,
    input: { text },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  };
}

async function runHumanInputScenario(): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runArgs(HUMAN_INPUT_SKILL, "客户需要人工补充意见。"));
  const waitingRunEndCount = countRunEndEvents(waiting);
  const waitingEndedAt = endedAt(waiting);
  if (!waiting.pendingHumanInput) throw new Error("human_input scenario expected pendingHumanInput");
  const completed = await actorRuntime.continue(waiting.actorRunId, {
    type: "human_input_response",
    response: {
      humanInputRequestId: waiting.pendingHumanInput.humanInputRequestId,
      value: "允许继续。",
      respondedBy: "human_operator",
      respondedAt: new Date().toISOString(),
    },
  });
  return { waiting, completed, waitingRunEndCount, waitingEndedAt };
}

async function runSkillApprovalScenario(): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runArgs(SKILL_APPROVAL_SKILL, "客户需要人工审批。"));
  const waitingRunEndCount = countRunEndEvents(waiting);
  const waitingEndedAt = endedAt(waiting);
  if (!waiting.pendingApproval) throw new Error("skill approval scenario expected pendingApproval");
  const completed = await actorRuntime.continue(waiting.actorRunId, {
    type: "approval_decision",
    decision: {
      approvalRequestId: waiting.pendingApproval.approvalRequestId,
      decision: "approve",
      comment: "允许继续。",
      decidedBy: "approval_operator",
      decidedAt: new Date().toISOString(),
    },
  });
  return { waiting, completed, waitingRunEndCount, waitingEndedAt };
}

async function runToolApprovalScenario(): Promise<ScenarioResult> {
  resetRuntime();
  const waiting = await actorRuntime.run(runArgs(TOOL_APPROVAL_SKILL, "客户说扫码枪连不上系统，还要求退款。"));
  const waitingRunEndCount = countRunEndEvents(waiting);
  const waitingEndedAt = endedAt(waiting);
  if (!waiting.pendingApproval) throw new Error("tool approval scenario expected pendingApproval");
  const completed = await actorRuntime.continue(waiting.actorRunId, {
    type: "approval_decision",
    decision: {
      approvalRequestId: waiting.pendingApproval.approvalRequestId,
      decision: "approve",
      comment: "允许创建 urgent 工单。",
      decidedBy: "approval_operator",
      decidedAt: new Date().toISOString(),
    },
  });
  return { waiting, completed, waitingRunEndCount, waitingEndedAt };
}

function lifecycleChecks(label: string, waitingKind: string, scenario: ScenarioResult): CheckResult[] {
  const { waiting, completed, waitingRunEndCount, waitingEndedAt } = scenario;
  const suspended = findEvent(waiting, "actor_run_suspended");
  const resumed = findEvent(completed, "actor_run_resumed");
  return [
    {
      label: `${label}: waiting 阶段记录 actor_run_suspended`,
      pass: suspended?.data.waitingKind === waitingKind,
      detail: JSON.stringify(suspended?.data ?? null),
    },
    {
      label: `${label}: waiting 阶段不记录 actor_run_end / endedAt`,
      pass: waitingRunEndCount === 0 && waitingEndedAt === undefined,
      detail: `waitingRunEndCount=${waitingRunEndCount}, waitingEndedAt=${String(waitingEndedAt)}`,
    },
    {
      label: `${label}: continue 后记录 actor_run_resumed`,
      pass: resumed?.data.waitingKind === waitingKind,
      detail: JSON.stringify(resumed?.data ?? null),
    },
    {
      label: `${label}: 最终只记录 completed actor_run_end`,
      pass: completed.status === "completed" && hasCompletedEnd(completed) && countRunEndEvents(completed) === 1 && typeof endedAt(completed) === "string",
      detail: `status=${completed.status}, runEndCount=${countRunEndEvents(completed)}, endedAt=${String(endedAt(completed))}`,
    },
  ];
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.4.0 — General Waiting / Resume Demo");
  console.log("=".repeat(60));
  console.log();

  console.log("🙋 场景 A：human_input waiting / resume");
  const human = await runHumanInputScenario();
  console.log("  WaitingStatus: " + human.waiting.status);
  console.log("  CompletedStatus: " + human.completed.status);
  console.log();

  console.log("✅ 场景 B：Skill wait_approval waiting / resume");
  const skillApproval = await runSkillApprovalScenario();
  console.log("  WaitingStatus: " + skillApproval.waiting.status);
  console.log("  CompletedStatus: " + skillApproval.completed.status);
  console.log();

  console.log("🛠️ 场景 C：ToolCall approval waiting / resume");
  const toolApproval = await runToolApprovalScenario();
  console.log("  WaitingStatus: " + toolApproval.waiting.status);
  console.log("  CompletedStatus: " + toolApproval.completed.status);
  console.log();

  const checks: CheckResult[] = [
    {
      label: "human_input 返回 waiting_human_input",
      pass: human.waiting.status === "waiting_human_input" && Boolean(human.waiting.pendingHumanInput),
      detail: "status=" + human.waiting.status,
    },
    ...lifecycleChecks("human_input", "human_input", human),
    {
      label: "Skill wait_approval 返回 waiting_approval + approvalKind=skill_step",
      pass: skillApproval.waiting.status === "waiting_approval" && skillApproval.waiting.pendingApproval?.approvalKind === "skill_step",
      detail: JSON.stringify(skillApproval.waiting.pendingApproval ?? null),
    },
    ...lifecycleChecks("skill_approval", "skill_approval", skillApproval),
    {
      label: "ToolCall approval 返回 waiting_approval + approvalKind=tool_call",
      pass: toolApproval.waiting.status === "waiting_approval" && toolApproval.waiting.pendingApproval?.approvalKind === "tool_call",
      detail: JSON.stringify(toolApproval.waiting.pendingApproval ?? null),
    },
    ...lifecycleChecks("tool_approval", "tool_approval", toolApproval),
  ];

  console.log("=".repeat(60));
  console.log("  ✅ General Waiting / Resume 验收检查 (15 条)");
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
    ? "  🎉 General Waiting / Resume 验证通过！"
    : "  ❌ 部分验收标准未通过");
  console.log("-".repeat(60));

  if (passCount !== checks.length) process.exit(1);
}

main().catch((error) => {
  console.error("General Waiting / Resume Demo 执行失败:", error);
  process.exit(1);
});
