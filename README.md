[中文](#organize--自运组织) | [English](#organize--self-operating-organization) | [CHANGELOG](./CHANGELOG.md)

---

# organize — 自运组织

> foreverthinking · 让 AI 参与社会实践调度，人类保留实践主权

## 这是什么

organize 是一个面向“自运组织”的 Actor Kernel 原型。它把 AI 视为参与组织实践的主体，而不是单次问答工具：Actor 有身份、记忆、权限、审批边界、技能流程和工具范围，并在每次实践后沉淀经验，让下一次实践变得更好。

当前闭环：

```text
输入实践事件
  ↓
构建 ActorContext：身份、权限、工具、记忆、输入
  ↓
执行 Skill：判断、调用工具、等待人工输入、等待显式审批、等待外部事件、处理工具审批、生成结果
  ↓
Trace 记录：start / suspended / resumed / end / validation_failed
  ↓
Runtime Recovery Bundle：PendingRun + Trace + Memory 可组合保存与恢复
  ↓
跨进程恢复：process A save bundle，process B load / restore / continue
  ↓
沉淀 Memory：候选、策略、去重、检索、持久化
```

## 当前版本

```text
v0.4.5 — External Event Safety / Validation
```

当前版本加固 `wait_external_event` 边界：外部事件在 resume 前会校验 request id、event name、correlation key（当事件提供 correlation key 时）和轻量 JSON schema。校验失败会记录 `external_event_validation_failed` 并以 `error` 结束，不会产生 `actor_run_resumed` 或 `external_event_received`。成功事件的完整 payload 只写入 `steps` / `outputs`，Trace 只记录 metadata 与 payload summary。

版本历史、验收矩阵、CI 覆盖和下一步计划见 [CHANGELOG.md](./CHANGELOG.md)。

## 核心概念

| 概念 | 说明 |
|---|---|
| Actor | 组织中的实践主体，拥有身份、职责、权限、自主等级和记忆。 |
| Skill | Actor 的实践程式，描述按步骤执行的 SOP。 |
| Human Input | Skill 运行中的人工补充输入边界，支持 waiting_human_input / continue。 |
| Wait Approval | Skill 运行中的显式人工审批边界，支持 waiting_approval / continue。 |
| Tool Approval | ToolCall 前的治理审批边界，支持 waiting_approval / continue。 |
| External Event | 外部系统事件驱动的等待边界，支持 waiting_external_event / continue，并带 schema / correlation 校验。 |
| Trace Lifecycle | `actor_run_start` → `actor_run_suspended` / `actor_run_resumed` → `actor_run_end`。 |
| PendingRunSnapshot | 恢复 suspended run 执行所需的 Runtime state，不包含 Trace / Memory。 |
| RuntimeRecoveryBundle | 组合 PendingRunSnapshot、TraceSnapshot、MemorySnapshot 的恢复包。 |

## 验证脚本

```bash
npm run demo                       # Mock LLM Actor Kernel Demo
npm run demo:memory                # Hybrid Memory / Observability Demo
npm run demo:memory:persistence    # MemorySnapshot persistence Demo
npm run demo:memory:store          # MemoryStore abstraction Demo
npm run demo:skill                 # Skill Runtime Semantics Demo
npm run demo:runtime:store         # Runtime Store Binding Demo
npm run demo:trace:persistence     # Trace Persistence Demo
npm run demo:human:input           # Human Input Runtime Demo
npm run demo:wait:approval         # Wait Approval Runtime Demo
npm run demo:waiting:resume        # General Waiting / Resume Demo
npm run demo:pending:run           # Pending Run Persistence Demo
npm run demo:recovery:bundle       # Runtime Recovery Bundle Demo
npm run demo:recovery:cross-process # Cross-process Recovery Demo
npm run demo:external:event        # External Event Runtime Demo
npm run demo:external:event:validation # External Event Validation Demo
npm run typecheck                  # TypeScript type-check
npm run build                      # Compile
```

## External Event Safety

`wait_external_event` 可声明 `event_schema` 和 `correlation_key`：

```ts
{
  step_key: "wait_payment",
  type: "wait_external_event",
  event_name: "payment.confirmed",
  correlation_key: "{{outputs.order_info.orderId}}",
  output_key: "payment_event",
  event_schema: {
    type: "object",
    required: ["payment_id", "status"],
    properties: {
      payment_id: { type: "string" },
      status: { type: "string" }
    }
  }
}
```

恢复时：

```ts
await actorRuntime.continue(actorRunId, {
  type: "external_event_received",
  event: {
    externalEventRequestId,
    eventName: "payment.confirmed",
    correlationKey: "ORDER_10086",
    payload: { payment_id: "PAY_10086", status: "confirmed" },
    receivedBy: "payment_webhook",
    receivedAt: new Date().toISOString(),
  },
});
```

成功后 payload 写入 `steps` / `outputs`：

```text
{{outputs.payment_event.payload.status}}
{{steps.wait_payment.payload.payment_id}}
```

Trace 只记录 metadata 与 payload summary，不记录完整 payload。

## 等待 / 恢复生命周期

```text
human_input          → actor_run_suspended(waitingKind=human_input)       → actor_run_resumed → actor_run_end
wait_approval        → actor_run_suspended(waitingKind=skill_approval)    → actor_run_resumed → actor_run_end
tool_call approval   → actor_run_suspended(waitingKind=tool_approval)     → actor_run_resumed → actor_run_end
wait_external_event  → actor_run_suspended(waitingKind=external_event)    → actor_run_resumed → actor_run_end
```

## Runtime Recovery Bundle

```text
PendingRunSnapshot = 可恢复执行的 suspended Runtime state
TraceSnapshot      = 可审计复盘的 Trace state
MemorySnapshot     = 可长期沉淀的经验 state
```

恢复顺序固定为：

```text
MemorySnapshot → TraceSnapshot → PendingRunSnapshot
```

---

# organize — Self-Operating Organization

## Current Version

```text
v0.4.5 — External Event Safety / Validation
```

This version hardens `wait_external_event` with request id, event name, correlation-key, and lightweight payload schema validation before resume. Failed events record `external_event_validation_failed` and end with `error` without producing `actor_run_resumed`.

## Verification Scripts

```bash
npm run demo
npm run demo:memory
npm run demo:memory:persistence
npm run demo:memory:store
npm run demo:skill
npm run demo:runtime:store
npm run demo:trace:persistence
npm run demo:human:input
npm run demo:wait:approval
npm run demo:waiting:resume
npm run demo:pending:run
npm run demo:recovery:bundle
npm run demo:recovery:cross-process
npm run demo:external:event
npm run demo:external:event:validation
npm run typecheck
npm run build
```
