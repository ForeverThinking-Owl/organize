[中文](#organize--自运组织) | [English](#organize--self-operating-organization) | [CHANGELOG](./CHANGELOG.md)

---

# organize — 自运组织

> foreverthinking · 让 AI 参与社会实践调度，人类保留实践主权

## 这是什么

organize 是一个面向“自运组织”的 Actor Kernel 原型。它把 AI 视为参与组织实践的主体，而不是单次问答工具：Actor 有身份、记忆、权限、审批边界、技能流程和工具范围，并在每次实践后沉淀经验，让下一次实践变得更好。

它目前聚焦一个最小但完整的闭环：

```text
输入一个实践事件
  ↓
构建 ActorContext：身份、权限、工具、记忆、输入
  ↓
执行 Skill：判断、调用工具、等待人工输入、等待显式审批、处理工具审批、生成结果
  ↓
记录 Trace：可审计、可复盘、可调试
  ↓
沉淀 Memory：候选、策略、去重、检索、持久化
```

人类从常规执行中上移，保留实践主权。实践主权包括：设定目标、制定边界、审批风险、监督过程、裁决例外、承担最终责任。

## 当前版本

```text
v0.3.9 — Wait Approval Runtime Semantics
```

当前版本在 v0.3.8 Human Input Runtime Semantics 基础上，为 `wait_approval` 增加一等 Skill waiting 语义：ActorRuntime 执行到 `wait_approval` 时会返回 `waiting_approval`，输出 `pendingApproval` 且标记 `approvalKind: "skill_step"`；调用方通过 `continue({ type: "approval_decision" })` 提交审批后，Runtime 会把审批结果写入 `steps` / `outputs`，继续执行后续 `transform` / `return` 步骤。ToolCall approval 仍保留原有专用治理链路。

版本历史、验收矩阵、CI 覆盖和下一步计划见 [CHANGELOG.md](./CHANGELOG.md)。

## 核心概念

| 概念 | 说明 |
|---|---|
| Actor | 组织中的实践主体，拥有身份、职责、权限、自主等级和记忆。 |
| ActorContext | 每次运行前构建的完整上下文，包含 Actor Profile、输入、权限、可见工具和混合记忆。 |
| Skill | Actor 的实践程式，描述按步骤执行的 SOP。 |
| Human Input | Skill 运行中的人工补充输入边界，支持 waiting_human_input / continue。 |
| Wait Approval | Skill 运行中的显式人工审批边界，支持 waiting_approval / continue。 |
| Tool | 实践入口，包含名称、方向、风险等级、输入输出 schema 和审批策略。 |
| ApprovalGate | 高风险工具调用的审批边界，支持 ToolCall before_call approval / continue。 |
| Trace | 运行全过程事件记录，用于审计、调试和验收，并可通过 `TraceStore` 持久化。 |
| MemoryStore | 记忆快照存储抽象，目前由 `JsonMemoryStore` 实现，可绑定到 ActorRuntime run 生命周期。 |

## 架构概览

```text
ActorRuntime
  ├─ Human Input Runtime
  │    ├─ waiting_human_input
  │    └─ continue(human_input_response)
  ├─ Wait Approval Runtime
  │    ├─ waiting_approval for skill_step approval
  │    └─ continue(approval_decision)
  ├─ Runtime MemoryStore Binding
  │    ├─ load MemoryStore before ActorContext build
  │    └─ save MemoryStore after memory generation
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
npm run typecheck                  # TypeScript type-check
npm run build                      # Compile
```

## Skill Runtime 语义

v0.3.9 中，Skill Runtime 的声明与运行行为继续对齐：

```text
SkillConfig
  ├─ tool_call      → 构建 ToolCallRequest，经 Policy / Approval / ToolGateway 执行
  ├─ llm_judge      → 调用 LLMGateway，写入 steps / outputs
  ├─ human_input    → 返回 waiting_human_input，等待 continue 写入 steps / outputs
  ├─ wait_approval  → 返回 waiting_approval，等待 approval_decision 写入 steps / outputs
  ├─ transform      → 直接执行模板映射，写入 steps / outputs
  └─ return         → 使用 output_mapping 生成 final_output
```

`wait_approval` 示例：

```ts
{
  step_key: "manual_approval",
  type: "wait_approval",
  reason: "请人工审批是否允许继续生成正式客户回复。",
  output_key: "approval_result"
}
```

后续步骤可以读取：

```text
{{outputs.approval_result.decision}}
{{outputs.approval_result.comment}}
{{steps.manual_approval.decision}}
```

## 等待边界

当前 Runtime 支持三类人类介入边界：

```text
human_input
  → waiting_human_input
  → continue(human_input_response)
  → 写入 steps / outputs
  → resume

wait_approval
  → waiting_approval + approvalKind=skill_step
  → continue(approval_decision)
  → 写入 steps / outputs
  → resume

tool_call approval
  → waiting_approval + approvalKind=tool_call
  → continue(approval_decision)
  → 执行 pending ToolCall
  → resume
```

## 记忆、Trace 与存储

记忆和 Trace 仍然是轻量级本地实现，但边界已清晰：

```text
MemoryService: retrieve / generateCandidatesWithSummary / dumpSnapshot / restoreSnapshot
MemoryStore:   load / save / clear
TraceLogger:   dumpSnapshot / restoreSnapshot
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

下一阶段将继续沿着运行时正确性推进，优先处理更通用的 Skill waiting / resume 模型、暂停恢复事件语义，以及更清晰的运行生命周期边界。

---

# organize — Self-Operating Organization

> foreverthinking · AI participates in social practice. Humans retain practice sovereignty.

## What it is

organize is an Actor Kernel prototype for self-operating organizations. It treats AI as a practice participant inside an organization, not as a one-off Q&A tool. An Actor has identity, memory, permissions, approval boundaries, skill workflows, and tool access. Each practice run can crystallize experience into memory, making the next run better.

The current loop is:

```text
Input a practice event
  ↓
Build ActorContext: identity, permissions, tools, memory, input
  ↓
Execute Skill: judge, call tools, wait for human input, wait for explicit approval, handle tool approval, return result
  ↓
Record Trace: auditable, replayable, debuggable
  ↓
Crystallize Memory: candidates, policy, deduplication, retrieval, persistence
```

Humans move up from routine execution while retaining practice sovereignty: setting goals, defining boundaries, approving risk, supervising process, adjudicating exceptions, and bearing final responsibility.

## Current Version

```text
v0.3.9 — Wait Approval Runtime Semantics
```

This version gives `wait_approval` a first-class Skill waiting contract on top of v0.3.8 Human Input Runtime Semantics. When ActorRuntime reaches `wait_approval`, it returns `waiting_approval` with `pendingApproval` marked as `approvalKind: "skill_step"`; callers can submit `continue({ type: "approval_decision" })`; Runtime writes the approval result into `steps` / `outputs` and continues through later `transform` / `return` steps. ToolCall approval keeps its existing governance path.

Version history, verification matrix, CI coverage, and the next-step plan live in [CHANGELOG.md](./CHANGELOG.md).

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
npm run typecheck
npm run build
```

## Runtime Waiting Boundaries

```text
human_input
  → waiting_human_input
  → continue(human_input_response)
  → write steps / outputs
  → resume

wait_approval
  → waiting_approval + approvalKind=skill_step
  → continue(approval_decision)
  → write steps / outputs
  → resume

tool_call approval
  → waiting_approval + approvalKind=tool_call
  → continue(approval_decision)
  → execute pending ToolCall
  → resume
```

## Project Status

This is still an experimental Actor Kernel. The goal is not to implement every capability at once, but to make each boundary explicit and verifiable: Actor, Skill, Tool, Policy, Approval, Trace, Memory, and Store now have a minimal running loop that can be hardened incrementally.

The next stage will continue improving runtime correctness, especially a more general Skill waiting / resume model, suspend/resume Trace semantics, and clearer run lifecycle boundaries.
