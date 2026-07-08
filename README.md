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
Trace 记录：start / suspended / resumed / end
  ↓
Runtime Recovery Bundle：PendingRun + Trace + Memory 可组合保存与恢复
  ↓
跨进程恢复：process A save bundle，process B load / restore / continue
  ↓
沉淀 Memory：候选、策略、去重、检索、持久化
```

人类从常规执行中上移，保留实践主权：设定目标、制定边界、审批风险、监督过程、裁决例外、承担最终责任。

## 当前版本

```text
v0.4.4 — External Event Waiting
```

当前版本新增 `wait_external_event`：ActorRuntime 执行到外部事件等待步骤时会返回 `waiting_external_event` 和 `pendingExternalEvent`，通过 `continue({ type: "external_event_received" })` 恢复，并把事件 payload 写入 `steps` / `outputs` 供后续步骤读取。外部事件等待同时接入 suspend / resume、PendingRunSnapshot、RuntimeRecoveryBundle 和跨进程恢复 Demo。

版本历史、验收矩阵、CI 覆盖和下一步计划见 [CHANGELOG.md](./CHANGELOG.md)。

## 核心概念

| 概念 | 说明 |
|---|---|
| Actor | 组织中的实践主体，拥有身份、职责、权限、自主等级和记忆。 |
| ActorContext | 每次运行前构建的完整上下文，包含 Actor Profile、输入、权限、可见工具和混合记忆。 |
| Skill | Actor 的实践程式，描述按步骤执行的 SOP。 |
| Human Input | Skill 运行中的人工补充输入边界，支持 waiting_human_input / continue。 |
| Wait Approval | Skill 运行中的显式人工审批边界，支持 waiting_approval / continue。 |
| Tool Approval | ToolCall 前的治理审批边界，支持 waiting_approval / continue。 |
| External Event | 外部系统事件驱动的等待边界，支持 waiting_external_event / continue。 |
| Trace Lifecycle | `actor_run_start` → `actor_run_suspended` / `actor_run_resumed` → `actor_run_end`。 |
| PendingRunSnapshot | 恢复 suspended run 执行所需的 Runtime state，不包含 Trace / Memory。 |
| RuntimeRecoveryBundle | 组合 PendingRunSnapshot、TraceSnapshot、MemorySnapshot 的恢复包。 |
| RuntimeRecoveryStore | recovery bundle 存储抽象，目前由 `JsonRuntimeRecoveryStore` 实现。 |
| Cross-process Recovery | 通过磁盘 bundle 让不同进程完成 save / restore / continue。 |
| MemoryStore | 记忆快照存储抽象，目前由 `JsonMemoryStore` 实现，可绑定到 ActorRuntime run 生命周期。 |
| TraceStore | Trace 快照存储抽象，目前由 `JsonTraceStore` 实现。 |

## 架构概览

```text
ActorRuntime
  ├─ Waiting Boundaries
  │    ├─ human_input          → waiting_human_input
  │    ├─ wait_approval        → waiting_approval + approvalKind=skill_step
  │    ├─ tool_call approval   → waiting_approval + approvalKind=tool_call
  │    └─ wait_external_event  → waiting_external_event
  ├─ Cross-process Recovery Demo
  ├─ Runtime Recovery Bundle
  ├─ Pending Run Persistence
  ├─ Runtime MemoryStore Binding
  ├─ ActorContextBuilder
  ├─ SkillRuntime
  ├─ ActorDecisionEngine / LLMGateway mock-real
  ├─ ActorDecisionExecutor / PolicyEngine / ApprovalGate / ToolGateway
  ├─ TraceLogger / TraceSnapshot / TraceStore
  └─ MemoryService / MemorySnapshot / MemoryStore
```

## 快速开始

```bash
npm install
npm run demo
```

默认 demo 使用 mock LLM，适合稳定验证本地闭环。

真实 LLM 模式需要先配置 `.env.example` 中的变量，然后运行：

```bash
npm run demo:llm
```

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
npm run typecheck                  # TypeScript type-check
npm run build                      # Compile
```

## External Event Waiting

`wait_external_event` 表示 Skill 流程暂停等待外部系统事件：

```ts
{
  step_key: "wait_payment",
  type: "wait_external_event",
  event_name: "payment.confirmed",
  correlation_key: "{{outputs.order_info.orderId}}",
  reason: "等待支付系统确认订单支付完成。",
  output_key: "payment_event"
}
```

恢复时：

```ts
await actorRuntime.continue(actorRunId, {
  type: "external_event_received",
  event: {
    externalEventRequestId,
    eventName: "payment.confirmed",
    payload: { payment_id: "PAY_10086", status: "confirmed" },
    receivedBy: "payment_webhook",
    receivedAt: new Date().toISOString(),
  },
});
```

事件 payload 写入 `steps` / `outputs`，后续步骤可读取：

```text
{{outputs.payment_event.payload.status}}
{{steps.wait_payment.payload.payment_id}}
```

Trace 默认只记录事件 metadata，不记录完整 payload。

## 等待 / 恢复生命周期

```text
human_input          → actor_run_suspended(waitingKind=human_input)       → actor_run_resumed → actor_run_end
wait_approval        → actor_run_suspended(waitingKind=skill_approval)    → actor_run_resumed → actor_run_end
tool_call approval   → actor_run_suspended(waitingKind=tool_approval)     → actor_run_resumed → actor_run_end
wait_external_event  → actor_run_suspended(waitingKind=external_event)    → actor_run_resumed → actor_run_end
```

## Runtime Recovery Bundle

`RuntimeRecoveryBundle` 只做组合，不合并边界：

```text
PendingRunSnapshot = 可恢复执行的 suspended Runtime state
TraceSnapshot      = 可审计复盘的 Trace state
MemorySnapshot     = 可长期沉淀的经验 state
```

恢复顺序固定为：

```text
MemorySnapshot → TraceSnapshot → PendingRunSnapshot
```

## 项目状态

当前仍是实验性 Actor Kernel。重点不是一次做完所有能力，而是逐步明确边界：Actor、Skill、Tool、Policy、Approval、Trace、Memory、Store 都先形成最小可运行闭环，再逐步硬化。

下一阶段将继续推进运行时正确性，尤其是外部事件边界安全性、事件 payload 校验和更真实的外部事件入口。

---

# organize — Self-Operating Organization

> foreverthinking · AI participates in social practice. Humans retain practice sovereignty.

## Current Version

```text
v0.4.4 — External Event Waiting
```

This version adds `wait_external_event`, a fourth waiting boundary. It suspends with `waiting_external_event`, resumes through `continue({ type: "external_event_received" })`, writes the external event payload into `steps` / `outputs`, and participates in pending-run persistence, recovery bundles, and cross-process recovery.

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
npm run typecheck
npm run build
```

## Runtime Waiting Boundaries

```text
human_input         → waiting_human_input
skill_approval      → waiting_approval
tool_approval       → waiting_approval
external_event      → waiting_external_event
```

The public Runtime API remains `run()` / `continue()`. Recovery helpers compose the existing boundaries instead of replacing them.
