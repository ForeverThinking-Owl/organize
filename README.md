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
沉淀 Memory：候选、策略、去重、检索、持久化
```

人类从常规执行中上移，保留实践主权：设定目标、制定边界、审批风险、监督过程、裁决例外、承担最终责任。

## 当前版本

```text
v0.4.0 — General Waiting / Resume Model
```

当前版本把 v0.3.x 已经形成的三类等待边界整理成统一生命周期：`human_input`、Skill `wait_approval`、ToolCall approval 都通过 `actor_run_suspended` 表示暂停，通过 `actor_run_resumed` 表示恢复，`actor_run_end` 只表示真正终局：`completed` 或 `error`。外部 API 仍保持 `run()` / `continue()`，waiting 输出仍保持 `pendingHumanInput` / `pendingApproval`。

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
| MemoryStore | 记忆快照存储抽象，目前由 `JsonMemoryStore` 实现，可绑定到 ActorRuntime run 生命周期。 |
| TraceStore | Trace 快照存储抽象，目前由 `JsonTraceStore` 实现。 |

## 架构概览

```text
ActorRuntime
  ├─ General Waiting / Resume Model
  │    ├─ human_input          → waiting_human_input
  │    ├─ wait_approval        → waiting_approval + approvalKind=skill_step
  │    └─ tool_call approval   → waiting_approval + approvalKind=tool_call
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
npm run typecheck                  # TypeScript type-check
npm run build                      # Compile
```

## Skill Runtime 语义

```text
SkillConfig
  ├─ tool_call      → 构建 ToolCallRequest，经 Policy / Approval / ToolGateway 执行
  ├─ llm_judge      → 调用 LLMGateway，写入 steps / outputs
  ├─ human_input    → suspend: waiting_human_input，continue 后写入 steps / outputs
  ├─ wait_approval  → suspend: waiting_approval，approval_decision 后写入 steps / outputs
  ├─ transform      → 直接执行模板映射，写入 steps / outputs
  └─ return         → 使用 output_mapping 生成 final_output
```

## 等待 / 恢复生命周期

```text
human_input
  → actor_run_suspended(waitingKind=human_input)
  → continue(human_input_response)
  → actor_run_resumed(waitingKind=human_input)
  → actor_run_end(completed/error)

wait_approval
  → actor_run_suspended(waitingKind=skill_approval)
  → continue(approval_decision)
  → actor_run_resumed(waitingKind=skill_approval)
  → actor_run_end(completed/error)

tool_call approval
  → actor_run_suspended(waitingKind=tool_approval)
  → continue(approval_decision)
  → actor_run_resumed(waitingKind=tool_approval)
  → actor_run_end(completed/error)
```

等待态不再写 `endedAt`，也不再记录 `actor_run_end`。真正完成或错误时才记录 `actor_run_end` 并设置 `endedAt`。

## 记忆、Trace 与存储

```text
MemoryService: retrieve / generateCandidatesWithSummary / dumpSnapshot / restoreSnapshot
MemoryStore:   load / save / clear
TraceLogger:   dumpSnapshot / restoreSnapshot / suspendRun / resumeRun / endRun
TraceStore:    load / save / clear
```

MemoryStore 可以交给 Runtime：

```ts
await actorRuntime.run({
  actorConfig,
  skillConfig,
  input,
  runtimeContext,
  runtimeOptions: { memoryStore },
});
```

Trace 可以独立保存与恢复：

```ts
await saveTraceLogger(traceLogger, traceStore);
traceLogger.clear();
await loadTraceLogger(traceLogger, traceStore);
```

## 项目状态

当前仍是实验性 Actor Kernel。重点不是一次做完所有能力，而是逐步明确边界：Actor、Skill、Tool、Policy、Approval、Trace、Memory、Store 都先形成最小可运行闭环，再逐步硬化。

下一阶段将继续推进运行时正确性，尤其是跨进程恢复、pending run 持久化和更通用的外部事件等待。

---

# organize — Self-Operating Organization

> foreverthinking · AI participates in social practice. Humans retain practice sovereignty.

## What it is

organize is an Actor Kernel prototype for self-operating organizations. It treats AI as a practice participant inside an organization, not as a one-off Q&A tool. An Actor has identity, memory, permissions, approval boundaries, skill workflows, and tool access. Each practice run can crystallize experience into memory, making the next run better.

## Current Version

```text
v0.4.0 — General Waiting / Resume Model
```

This version unifies the waiting boundaries introduced throughout v0.3.x. `human_input`, Skill `wait_approval`, and ToolCall approval now suspend through `actor_run_suspended`, resume through `actor_run_resumed`, and reserve `actor_run_end` for terminal states only: `completed` or `error`. The public API remains `run()` / `continue()`, and waiting outputs remain `pendingHumanInput` / `pendingApproval`.

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
npm run typecheck
npm run build
```

## Runtime Waiting Boundaries

```text
human_input
  → actor_run_suspended(waitingKind=human_input)
  → continue(human_input_response)
  → actor_run_resumed(waitingKind=human_input)
  → actor_run_end(completed/error)

wait_approval
  → actor_run_suspended(waitingKind=skill_approval)
  → continue(approval_decision)
  → actor_run_resumed(waitingKind=skill_approval)
  → actor_run_end(completed/error)

tool_call approval
  → actor_run_suspended(waitingKind=tool_approval)
  → continue(approval_decision)
  → actor_run_resumed(waitingKind=tool_approval)
  → actor_run_end(completed/error)
```

## Project Status

This is still an experimental Actor Kernel. The goal is not to implement every capability at once, but to make each boundary explicit and verifiable: Actor, Skill, Tool, Policy, Approval, Trace, Memory, and Store now have a minimal running loop that can be hardened incrementally.

The next stage will continue improving runtime correctness, especially cross-process resume, persistent pending runs, and broader external-event waiting semantics.
