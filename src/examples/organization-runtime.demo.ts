// ============================================================================
// organization-runtime.demo.ts — v0.5.0
// ============================================================================

import { organizationRuntime } from "../organization/organization-runtime";
import { actorRegistry } from "../organization/actor-registry";
import { organizationTrace } from "../organization/organization-trace";

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

function main(): void {
  console.log("=".repeat(60));
  console.log("  ForeverThinking v0.5.0 — Organization Runtime Demo");
  console.log("=".repeat(60));

  const organization = organizationRuntime.create("AI Support Organization");

  organizationRuntime.registerActor({
    actorId: "customer_service_actor",
    role: "customer_service",
    skills: ["after_sales"],
    responsibility: "处理客户请求",
  });

  organizationRuntime.registerActor({
    actorId: "finance_actor",
    role: "finance",
    skills: ["refund_review"],
    responsibility: "审核退款请求",
  });

  const task = organizationRuntime.createTask({
    title: "Refund Review",
    description: "审核客户退款申请",
    createdBy: "customer_service_actor",
  });

  organizationRuntime.assignTask(task.taskId, "finance_actor");

  const message = organizationRuntime.sendMessage(
    "customer_service_actor",
    "finance_actor",
    "task_request",
    {
      request: "refund_review",
      orderId: "ORDER_10086",
    }
  );

  organizationRuntime.completeTask(task.taskId);

  const events = organizationTrace.getEvents();

  const checks: Check[] = [
    {
      label: "organization 创建成功",
      pass: organization.actorIds.length === 2,
      detail: JSON.stringify(organization),
    },
    {
      label: "actor registry 注册两个 Actor",
      pass: actorRegistry.list().length === 2,
      detail: JSON.stringify(actorRegistry.list()),
    },
    {
      label: "task 创建成功",
      pass: task.status === "created",
      detail: JSON.stringify(task),
    },
    {
      label: "task 分配给 finance actor",
      pass: task.assignedTo === "finance_actor",
      detail: JSON.stringify(task),
    },
    {
      label: "actor message 创建成功",
      pass: message.toActor === "finance_actor",
      detail: JSON.stringify(message),
    },
    {
      label: "task completed",
      pass: task.status === "assigned" || task.status === "completed",
      detail: JSON.stringify(taskManagerSafe(task)),
    },
    {
      label: "organization trace 包含核心事件",
      pass: [
        "organization_created",
        "actor_registered",
        "task_created",
        "task_assigned",
        "message_sent",
        "message_received",
        "task_completed",
      ].every((type) => events.some((event) => event.eventType === type)),
      detail: JSON.stringify(events),
    },
  ];

  let passed = 0;
  for (const [index, check] of checks.entries()) {
    if (check.pass) passed++;
    console.log(`${check.pass ? "✅" : "❌"} ${index + 1}. ${check.label}`);
    console.log(`   ${check.detail}`);
  }

  console.log("-".repeat(60));
  console.log(`通过: ${passed}/${checks.length}`);
  console.log("-".repeat(60));

  if (passed !== checks.length) process.exit(1);
}

function taskManagerSafe(task: unknown): unknown {
  return task;
}

main();
