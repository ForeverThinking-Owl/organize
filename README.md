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
执行 Skill：判断、调用工具、处理审批、生成结果
  ↓
记录 Trace：可审计、可复盘、可调试
  ↓
沉淀 Memory：候选、策略、去重、检索、持久化
```

人类从常规执行中上移，保留实践主权。实践主权包括：设定目标、制定边界、审批风险、监督过程、裁决例外、承担最终责任。

## 当前版本

```text
v0.3.5 — Skill Runtime Semantics
```

当前版本在 v0.3.4 的 Memory Store 抽象基础上，硬化 Skill Runtime 的执行语义：`SkillConfig` 会严格解析，未知 step type 会显式失败；`transform` 成为一等运行步骤；`return` 支持 `output_mapping`，可以从 `context`、`steps`、`outputs` 中生成最终输出。这样 Skill DSL 的声明和 ActorRuntime 的真实执行行为开始对齐。

版本历史、验收矩阵、CI 覆盖和下一步计划见 [CHANGELOG.md](./CHANGELOG.md)。

## 核心概念

| 概念 | 说明 |
|---|---|
| Actor | 组织中的实践主体，拥有身份、职责、权限、自主等级和记忆。 |
| ActorContext | 每次运行前构建的完整上下文，包含 Actor Profile、输入、权限、可见工具和混合记忆。 |
| Skill | Actor 的实践程式，描述按步骤执行的 SOP。 |
| Tool | 实践入口，包含名称、方向、风险等级、输入输出 schema 和审批策略。 |
| ApprovalGate | 高风险工具调用的审批边界，支持 waiting_approval / continue 流程。 |
| Trace | 运行全过程事件记录，用于审计、调试和验收。 |
| MemoryCandidate | 实践结束后提取出的记忆候选。 |
| MemoryRecord | 进入长期记忆的权威记录。 |
| MemoryStore | 记忆快照存储抽象，目前由 `JsonMemoryStore` 实现。 |

## 架构概览

```text
ActorRuntime
  ├─ ActorContextBuilder
  │    ├─ ActorProfile
  │    ├─ permissions
  │    ├─ available tools
  │    └─ hybrid memory retrieval
  ├─ SkillRuntime
  ├─ ActorDecisionEngine
  │    └─ LLMGateway mock / real
  ├─ ActorDecisionExecutor
  │    ├─ PolicyEngine
  │    ├─ ApprovalGate
  │    └─ ToolGateway
  ├─ TraceLogger
  └─ MemoryService
       ├─ MemoryExtractor
       ├─ MemoryPolicy
       ├─ memoryFingerprint
       ├─ MemorySnapshot dump / restore
       └─ MemoryStore / JsonMemoryStore
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
npm run typecheck                  # TypeScript type-check
npm run build                      # Compile
```

## Skill Runtime 语义

v0.3.5 开始，Skill Runtime 的目标是让配置声明和运行行为一致：

```text
SkillConfig
  ├─ tool_call      → 构建 ToolCallRequest，经 Policy / Approval / ToolGateway 执行
  ├─ llm_judge      → 调用 LLMGateway，写入 steps / outputs
  ├─ transform      → 直接执行模板映射，写入 steps / outputs
  └─ return         → 使用 output_mapping 生成 final_output
```

模板支持这些根路径：

```text
{{context.order_id}}
{{steps.query_order.status}}
{{outputs.triage_result.reason}}
```

完整占位符会保留原始类型，因此 `{{outputs.triage_result}}` 可以返回对象，`{{outputs.triage_result.should_create_ticket}}` 可以返回布尔值。

## 记忆与存储

当前记忆系统仍然是轻量级本地实现，但已经具备清晰边界：

```text
MemoryService
  ├─ retrieve()                     # 检索可访问记忆
  ├─ generateCandidatesWithSummary() # 提取候选并记录写入摘要
  ├─ dumpSnapshot()                 # 导出 MemorySnapshot
  └─ restoreSnapshot()              # 从 MemorySnapshot 恢复

MemoryStore
  ├─ load()
  ├─ save(snapshot)
  └─ clear()
```

这意味着后续可以在不改动记忆核心语义的前提下，替换具体存储实现。

## 项目状态

当前仍是实验性 Actor Kernel。它的重点不是把所有能力一次做完，而是逐步明确边界：Actor、Skill、Tool、Policy、Approval、Trace、Memory、Store 都先形成最小可运行闭环，再逐步硬化。

下一阶段将继续沿着运行时正确性推进，优先处理 Runtime 与持久化 Store 的更自然绑定、Trace 持久化，以及更通用的 Skill 执行语义。

---

# organize — Self-Operating Organization

> foreverthinking · AI participates in social practice. Humans retain practice sovereignty.

## What it is

organize is an Actor Kernel prototype for self-operating organizations. It treats AI as a practice participant inside an organization, not as a one-off Q&A tool. An Actor has identity, memory, permissions, approval boundaries, skill workflows, and tool access. Each practice run can crystallize experience into memory, making the next run better.

The current system focuses on a minimal but complete loop:

```text
Input a practice event
  ↓
Build ActorContext: identity, permissions, tools, memory, input
  ↓
Execute Skill: judge, call tools, handle approval, return result
  ↓
Record Trace: auditable, replayable, debuggable
  ↓
Crystallize Memory: candidates, policy, deduplication, retrieval, persistence
```

Humans move up from routine execution while retaining practice sovereignty: setting goals, defining boundaries, approving risk, supervising process, adjudicating exceptions, and bearing final responsibility.

## Current Version

```text
v0.3.5 — Skill Runtime Semantics
```

This version hardens Skill Runtime semantics on top of v0.3.4 Memory Store Abstraction: `SkillConfig` is parsed strictly, unknown step types fail explicitly, `transform` is now a first-class runtime step, and `return` supports `output_mapping` from `context`, `steps`, and `outputs`. This begins aligning the declared Skill DSL with actual ActorRuntime execution behavior.

Version history, verification matrix, CI coverage, and the next-step plan live in [CHANGELOG.md](./CHANGELOG.md).

## Core Concepts

| Concept | Description |
|---|---|
| Actor | A practice subject inside an organization, with identity, responsibility, permissions, autonomy level, and memory. |
| ActorContext | The complete runtime context built before each run: Actor Profile, input, permissions, visible tools, and hybrid memory. |
| Skill | The Actor's practice procedure, expressed as a step-based SOP. |
| Tool | A practice entry point with name, direction, risk level, input/output schema, and approval policy. |
| ApprovalGate | The approval boundary for high-risk tool calls, supporting waiting_approval / continue. |
| Trace | Event log for auditability, debugging, and acceptance checks. |
| MemoryCandidate | A memory candidate extracted after a practice run. |
| MemoryRecord | An authoritative long-term memory record. |
| MemoryStore | Snapshot storage abstraction, currently implemented by `JsonMemoryStore`. |

## Architecture Overview

```text
ActorRuntime
  ├─ ActorContextBuilder
  │    ├─ ActorProfile
  │    ├─ permissions
  │    ├─ available tools
  │    └─ hybrid memory retrieval
  ├─ SkillRuntime
  ├─ ActorDecisionEngine
  │    └─ LLMGateway mock / real
  ├─ ActorDecisionExecutor
  │    ├─ PolicyEngine
  │    ├─ ApprovalGate
  │    └─ ToolGateway
  ├─ TraceLogger
  └─ MemoryService
       ├─ MemoryExtractor
       ├─ MemoryPolicy
       ├─ memoryFingerprint
       ├─ MemorySnapshot dump / restore
       └─ MemoryStore / JsonMemoryStore
```

## Quick Start

```bash
npm install
npm run demo
```

The default demo uses mock LLM for deterministic local validation.

Real LLM mode requires `.env.example` variables, then run:

```bash
npm run demo:llm
```

## Verification Scripts

```bash
npm run demo                       # Mock LLM Actor Kernel Demo
npm run demo:memory                # Hybrid Memory / Observability Demo
npm run demo:memory:persistence    # MemorySnapshot persistence Demo
npm run demo:memory:store          # MemoryStore abstraction Demo
npm run demo:skill                 # Skill Runtime Semantics Demo
npm run typecheck                  # TypeScript type-check
npm run build                      # Compile
```

## Skill Runtime Semantics

Starting in v0.3.5, Skill Runtime aims to align configuration declarations with runtime behavior:

```text
SkillConfig
  ├─ tool_call      → builds ToolCallRequest and executes through Policy / Approval / ToolGateway
  ├─ llm_judge      → calls LLMGateway and writes to steps / outputs
  ├─ transform      → directly executes template mappings and writes to steps / outputs
  └─ return         → uses output_mapping to produce final_output
```

Templates support these root paths:

```text
{{context.order_id}}
{{steps.query_order.status}}
{{outputs.triage_result.reason}}
```

A full-placeholder template preserves raw values, so `{{outputs.triage_result}}` can return an object and `{{outputs.triage_result.should_create_ticket}}` can return a boolean.

## Memory and Storage

The current memory system is still lightweight and local, but its boundaries are explicit:

```text
MemoryService
  ├─ retrieve()                     # Retrieve accessible memories
  ├─ generateCandidatesWithSummary() # Extract candidates and record write summary
  ├─ dumpSnapshot()                 # Export MemorySnapshot
  └─ restoreSnapshot()              # Restore from MemorySnapshot

MemoryStore
  ├─ load()
  ├─ save(snapshot)
  └─ clear()
```

This makes it possible to replace the storage implementation later without changing the core memory semantics.

## Project Status

This is still an experimental Actor Kernel. The goal is not to implement every capability at once, but to make each boundary explicit and verifiable: Actor, Skill, Tool, Policy, Approval, Trace, Memory, and Store now have a minimal running loop that can be hardened incrementally.

The next stage will continue improving runtime correctness, especially more natural Runtime/Store binding, Trace persistence, and more general Skill execution semantics.
