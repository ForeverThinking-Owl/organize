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
执行 Skill：判断、调用工具、等待人工输入、等待显式审批、处理工具审批、生成结果
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
v0.4.3 — Cross-process Recovery Demo
```

当前版本在 v0.4.2 Runtime Recovery Bundle 基础上，新增跨进程恢复 Demo：一个子进程 run 到 suspended 并保存 `RuntimeRecoveryBundle` 到 JSON store，另一个子进程重新启动、重新注册工具、加载 bundle、恢复 Runtime / Trace / Memory，并通过 `continue()` 完成执行。`human_input`、Skill `wait_approval`、ToolCall approval 三类等待边界都已覆盖。

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
  ├─ Cross-process Recovery Demo
  │    ├─ process A: run → suspended → save RuntimeRecoveryBundle
  │    └─ process B: load → restore → continue → completed
  ├─ Runtime Recovery Bundle
  │    ├─ PendingRunSnapshot
  │    ├─ TraceSnapshot
  │    └─ MemorySnapshot
  ├─ Pending Run Persistence
  ├─ General Waiting / Resume Model
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
npm run typecheck                  # TypeScript type-check
npm run build                      # Compile
```

## Cross-process Recovery

v0.4.3 的 demo 使用 Node 子进程模拟真实进程边界：

```text
process A
  → register tools
  → run 到 waiting
  → createRuntimeRecoveryBundle(actorRunId)
  → JsonRuntimeRecoveryStore.save(bundle)
  → exit

process B
  → register tools
  → JsonRuntimeRecoveryStore.load(actorRunId)
  → restoreRuntimeRecoveryBundle(bundle)
  → continue(...)
  → completed
```

工具定义和 executor 不会被序列化到 bundle；它们仍由应用启动时显式注册。Bundle 只保存运行状态、Trace 状态和 Memory 状态。

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

这样 continue 之后可以把 `actor_run_resumed` / `actor_run_end` 接回旧 Trace，同时用恢复后的 MemoryService 继续去重和沉淀经验。

## 项目状态

当前仍是实验性 Actor Kernel。重点不是一次做完所有能力，而是逐步明确边界：Actor、Skill、Tool、Policy、Approval、Trace、Memory、Store 都先形成最小可运行闭环，再逐步硬化。

下一阶段将继续推进运行时正确性，尤其是外部事件等待、恢复边界安全性和更真实的进程级恢复入口。

---

# organize — Self-Operating Organization

> foreverthinking · AI participates in social practice. Humans retain practice sovereignty.

## What it is

organize is an Actor Kernel prototype for self-operating organizations. It treats AI as a practice participant inside an organization, not as a one-off Q&A tool. An Actor has identity, memory, permissions, approval boundaries, skill workflows, and tool access. Each practice run can crystallize experience into memory, making the next run better.

## Current Version

```text
v0.4.3 — Cross-process Recovery Demo
```

This version adds a cross-process recovery demo on top of `RuntimeRecoveryBundle`: one process-like phase saves a suspended run bundle to JSON, and another process-like phase reloads tools, loads the bundle, restores Runtime / Trace / Memory, and continues the run to completion.

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
npm run typecheck
npm run build
```

## Cross-process Recovery

```text
process A: run → suspended → save RuntimeRecoveryBundle → exit
process B: register tools → load bundle → restore → continue → completed
```

The bundle carries state. Tool registration remains application-owned.

## Project Status

This is still an experimental Actor Kernel. The goal is not to implement every capability at once, but to make each boundary explicit and verifiable: Actor, Skill, Tool, Policy, Approval, Trace, Memory, and Store now have a minimal running loop that can be hardened incrementally.

The next stage will continue improving runtime correctness, especially external-event waiting, safer recovery boundaries, and more realistic process-level recovery entry points.
