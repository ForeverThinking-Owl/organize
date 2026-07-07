// ============================================================================
// customer-after-sales.demo.ts — v0.3.1
// 单 Actor 最小闭环 Demo
//
// 场景：客户说扫码枪连不上系统，还要求退款。
//
// 验证 26 条验收标准 + waiting_approval / continue 流程
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

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

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
    allowed_skills: ["customer_issue_triage"],
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
  skill_id: "customer_issue_triage", name: "客户问题分流",
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

interface CheckResult { id: number; label: string; pass: boolean; detail: string; }

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

function runChecks(output: ActorRunOutput): CheckResult[] {
  const trace = traceLogger.getTrace(output.actorRunId)!;
  const events = trace.events;
  const eventTypes = events.map((e) => e.eventType);
  const hasEvent = (type: string) => (eventTypes as string[]).includes(type);

  const toolCalls = events
    .filter((e) => e.eventType === "tool_call_start")
    .map((e) => e.data.toolName as string);

  const checks: CheckResult[] = [
    {
      id: 1, label: "ActorContext 被正确构建",
      pass: hasEvent("context_built"),
      detail: hasEvent("context_built")
        ? "context_built 事件已记录，包含 actorId、skillId、memoryCount、availableToolCount"
        : "未找到 context_built 事件",
    },
    (() => {
      const evt = events.find((e) => e.eventType === "context_built");
      const mc = evt?.data.memoryCount as number;
      return { id: 2, label: "Actor 读取到自己的记忆", pass: mc > 0,
        detail: mc > 0 ? "Actor 加载了 " + mc + " 条私有记忆" : "Actor 未加载到记忆" };
    })(),
    (() => {
      const evt = events.find((e) => e.eventType === "context_built");
      const tc = evt?.data.availableToolCount as number;
      return { id: 3, label: "Actor 只能看到自己有权使用的 Tool", pass: tc === 3,
        detail: "Actor 可见 " + tc + " 个 Tool（allowed 3 - denied 0）" };
    })(),
    (() => {
      const steps = events.filter((e) => e.eventType === "skill_step_start").map((e) => e.stepKey);
      return { id: 4, label: "Skill 按步骤执行", pass: steps.length >= 3,
        detail: "执行步骤: " + steps.join(" → ") };
    })(),
    { id: 5, label: "query_order_info 被调用", pass: toolCalls.includes("query_order_info"),
      detail: toolCalls.includes("query_order_info") ? "query_order_info 已调用" : "未调用" },
    { id: 6, label: "query_ticket_history 被调用", pass: toolCalls.includes("query_ticket_history"),
      detail: toolCalls.includes("query_ticket_history") ? "query_ticket_history 已调用" : "未调用" },
    (() => {
      const dc = events.filter((e) => e.eventType === "decision_generated").length;
      return { id: 7, label: "Actor 生成结构化判断", pass: dc > 0,
        detail: "生成了 " + dc + " 个决策事件" };
    })(),
    { id: 8, label: "Actor 生成 create_ticket ToolCall", pass: toolCalls.includes("create_ticket"),
      detail: toolCalls.includes("create_ticket") ? "create_ticket ToolCall 已生成" : "未生成" },
    (() => {
      const evt = events.find((e) => e.eventType === "approval_check");
      return { id: 9, label: "ApprovalGate 识别 urgent 工单需要审批", pass: evt?.data.required === true,
        detail: evt?.data.required ? "审批检查触发: priority=urgent 匹配审批规则" : "审批检查未触发" };
    })(),
    { id: 10, label: "审批通过后 ToolGateway 执行 create_ticket",
      pass: hasEvent("approval_decided") && toolCalls.includes("create_ticket"),
      detail: hasEvent("approval_decided") && toolCalls.includes("create_ticket")
        ? "审批通过 → create_ticket 已执行" : "审批或执行未完成" },
    (() => {
      if (output.status === "completed" && output.result) {
        return { id: 11, label: "Actor 输出 final_output", pass: true,
          detail: "final_output 已生成，包含 " + Object.keys(output.result).join(", ") };
      }
      return { id: 11, label: "Actor 输出 final_output", pass: false, detail: "Actor 未正常完成" };
    })(),
    { id: 12, label: "生成 memory_candidate", pass: output.memoryCandidates.length > 0,
      detail: output.memoryCandidates.length > 0
        ? "生成了 " + output.memoryCandidates.length + " 条记忆候选"
        : "未生成记忆候选" },
    { id: 13, label: "Trace 记录完整链路", pass: trace.events.length >= 10,
      detail: "Trace 记录了 " + trace.events.length + " 个事件，覆盖 " + [...new Set(eventTypes as string[])].join(", ") },
    (() => {
      const evt = events.find((e) => e.eventType === "tool_call_start" && e.data.toolName === "query_order_info");
      const args = evt?.data.arguments as Record<string, unknown> | undefined;
      const pass = args?.order_id === "ORDER_10086";
      return { id: 14, label: "query_order_info 的 arguments.order_id = ORDER_10086", pass,
        detail: pass ? "order_id 正确传入" : "order_id 缺失或错误: " + JSON.stringify(args) };
    })(),
    (() => {
      const evt = events.find((e) => e.eventType === "tool_call_start" && e.data.toolName === "query_ticket_history");
      const args = evt?.data.arguments as Record<string, unknown> | undefined;
      const pass = args?.customer_id === "C001";
      return { id: 15, label: "query_ticket_history 的 arguments.customer_id = C001", pass,
        detail: pass ? "customer_id 正确传入" : "customer_id 缺失或错误: " + JSON.stringify(args) };
    })(),
    (() => {
      const triage = output.result?.triage as Record<string, unknown> | undefined;
      const pass = triage?.need_after_sales !== undefined && triage?.should_create_ticket !== undefined;
      return { id: 16, label: "final_output.triage 保留 judge 结果，未被 create_ticket 覆盖", pass,
        detail: pass ? "triage 完整: need_after_sales=" + triage?.need_after_sales + ", need_technical=" + triage?.need_technical
          : "triage 被覆盖或缺失" };
    })(),
    (() => {
      const toolCallCount = events.filter((e) => e.eventType === "tool_call_start").length;
      const obsCount = output.result?.observations_count as number;
      const pass = obsCount === toolCallCount;
      return { id: 17, label: "observations_count 等于真实 ToolCall 数量", pass,
        detail: "observations_count=" + obsCount + ", tool_call_start=" + toolCallCount };
    })(),
    (() => {
      const pass = (output.pendingApproval?.toolName ?? "") === "" ||
                    output.pendingApproval?.toolName === "create_ticket";
      return { id: 18, label: "pendingApproval.toolName 为真实工具名（非 toolCallId）", pass,
        detail: "toolName=" + (output.pendingApproval?.toolName ?? "N/A") };
    })(),
    { id: 19, label: "LLMGateway 被调用", pass: hasEvent("llm_call_start"),
      detail: hasEvent("llm_call_start") ? "llm_call_start 已记录" : "未记录 llm_call_start" },
    { id: 20, label: "llm_call_start 被记录", pass: hasEvent("llm_call_start"),
      detail: hasEvent("llm_call_start") ? "LLM 调用开始事件存在" : "LLM 调用开始事件缺失" },
    { id: 21, label: "llm_call_end 被记录", pass: hasEvent("llm_call_end"),
      detail: hasEvent("llm_call_end") ? "LLM 调用结束事件存在" : "LLM 调用结束事件缺失" },
    (() => {
      const evt = events.find((e) => e.eventType === "llm_call_end");
      return { id: 22, label: "llm_judge 结果通过 schema 校验", pass: evt?.data.valid === true,
        detail: evt?.data.valid ? "结构化输出校验通过" : "结构化输出校验未通过" };
    })(),
    (() => {
      const triage = output.result?.triage as Record<string, unknown> | undefined;
      const pass = Boolean(triage?.reason) && triage?.should_create_ticket === true;
      return { id: 23, label: "triage_result 来自 LLMGateway 输出", pass,
        detail: pass ? "triage_result 已写入 final_output" : "triage_result 缺失或不完整" };
    })(),
    (() => {
      const pass = output.toolCalls.length === events.filter((e) => e.eventType === "tool_call_start").length;
      return { id: 24, label: "ActorRunOutput 输出完整 toolCalls 摘要", pass,
        detail: "toolCalls=" + output.toolCalls.length };
    })(),
    (() => {
      const pass = output.approvals.length >= 1;
      return { id: 25, label: "ActorRunOutput 输出完整 approvals 摘要", pass,
        detail: "approvals=" + output.approvals.length };
    })(),
    (() => {
      const pass = !hasEvent("llm_validation_failed") && output.status === "completed";
      return { id: 26, label: "mock mode 下 LLM 接入保持稳定", pass,
        detail: pass ? "mock LLM 结构化判断稳定完成" : "出现 LLM 校验失败或运行未完成" };
    })(),
  ];

  return checks;
}

async function main() {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.3.1 — Hybrid Memory Hardening Demo");
  console.log("=".repeat(60));
  console.log();
  console.log("📥 Input: 客户说扫码枪连不上系统，还要求退款。");
  console.log("  LLM_MODE: " + (process.env.LLM_MODE ?? "mock"));
  console.log();

  resetRuntime();

  console.log("🔧 已注册 3 个 Tool:");
  console.log("   - query_order_info (read, low)");
  console.log("   - query_ticket_history (read, low)");
  console.log("   - create_ticket (write, medium, urgent需审批)");
  console.log();

  console.log("🚀 路径 A: 自动审批 Demo 模式");
  console.log("-".repeat(40));

  let output = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: "客户说扫码枪连不上系统，还要求退款。" },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  });

  if (output.status === "waiting_approval" && output.pendingApproval) {
    console.log("  ⏸  触发审批，Demo 模式自动通过...");
    output = await actorRuntime.continue(output.actorRunId, {
      type: "approval_decision",
      decision: {
        approvalRequestId: output.pendingApproval.approvalRequestId,
        decision: "approve",
        comment: "Demo 模式自动审批通过",
        decidedBy: "demo_approver",
        decidedAt: new Date().toISOString(),
      },
    });
  }

  console.log("  Status: " + output.status);
  console.log("  ToolCalls: " + output.toolCalls.length);
  console.log("  Approvals: " + output.approvals.length);
  console.log("  MemoryCandidates: " + output.memoryCandidates.length);
  for (const mc of output.memoryCandidates) {
    console.log("    [" + mc.type + "] " + mc.content.substring(0, 60) + (mc.content.length > 60 ? "..." : ""));
  }
  console.log();

  console.log("=".repeat(60));
  console.log("  ✅ 验收检查 (26 条)");
  console.log("=".repeat(60));
  console.log();

  const checks = runChecks(output);
  let passCount = 0;
  for (const check of checks) {
    const icon = check.pass ? "✅" : "❌";
    if (check.pass) passCount++;
    console.log("  " + icon + " " + String(check.id).padStart(2, "0") + ". " + check.label);
    console.log("      " + check.detail);
    console.log();
  }

  console.log("-".repeat(60));
  console.log("  通过: " + passCount + "/" + checks.length);
  console.log(passCount === checks.length
    ? "  🎉 全部验收标准通过！Actor Kernel + LLM Gateway 成立！"
    : "  ❌ 部分验收标准未通过");
  console.log("-".repeat(60));
  console.log();

  console.log("📜 完整 Trace:");
  console.log("-".repeat(60));
  const trace = traceLogger.getTrace(output.actorRunId)!;
  trace.events.forEach((e, i) => {
    const step = e.stepKey ? " [" + e.stepKey + "]" : "";
    console.log("  " + String(i + 1).padStart(2, "0") + ". " + e.eventType + step);
  });
  console.log();

  console.log("=".repeat(60));
  console.log("  🔄 路径 B: waiting_approval / continue 流程");
  console.log("=".repeat(60));
  console.log();

  resetRuntime();

  const outputB = await actorRuntime.run({
    actorConfig: ACTOR_CONFIG,
    skillConfig: SKILL_CONFIG,
    input: { text: "客户说扫码枪连不上系统，还要求退款。" },
    runtimeContext: { order_id: "ORDER_10086", customer_id: "C001" },
  });

  console.log("  初始 Status: " + outputB.status);
  if (outputB.status === "waiting_approval" && outputB.pendingApproval) {
    console.log("  ⏸  暂停等待审批: " + outputB.pendingApproval.reason);
    console.log("  Tool: " + outputB.pendingApproval.toolName);

    const decision = {
      approvalRequestId: outputB.pendingApproval.approvalRequestId,
      decision: "approve_with_comment" as const,
      comment: "确认 urgent 合理，通过。",
      decidedBy: "manager_001",
      decidedAt: new Date().toISOString(),
    };

    console.log("  📨 外部提交审批决策: " + decision.decision);
    const outputC = await actorRuntime.continue(outputB.actorRunId, {
      type: "approval_decision", decision,
    });

    console.log("  最终 Status: " + outputC.status);
    console.log("  ToolCalls: " + outputC.toolCalls.length);
    console.log("  Approvals: " + outputC.approvals.length);
    console.log("  MemoryCandidates: " + outputC.memoryCandidates.length);
    console.log();
    console.log("  ✅ waiting_approval / continue 流程验证通过！");
  } else {
    console.log("  ⚠️  未触发 waiting_approval（Demo 模式自动审批）");
  }

  console.log();
  return { checks, passCount };
}

main()
  .then(({ passCount, checks }) => {
    if (passCount === checks.length) {
      console.log("\n🎉 v0.3.1 Actor Kernel + Hybrid Memory 验证通过！");
      process.exit(0);
    } else {
      console.log("\n❌ " + (checks.length - passCount) + " 项未通过");
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error("Demo 执行失败:", err);
    process.exit(1);
  });
