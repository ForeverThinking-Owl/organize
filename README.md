[中文](#organize--自运组织) | [English](#organize--self-operating-organization)

---

# organize — 自运组织

> foreverthinking · 让 AI 参与社会实践调度，人类保留实践主权

## 目标

organize 的目标，是构建一个面向自运组织的 Actor Kernel，让 AI 能像人类社会中的实践主体一样参与组织实践：判断 5W1H、调度任务、编排工具、协调角色、沉淀经验。

人类从常规执行中上移，保留实践主权。实践主权包括：设定目标、制定边界、审批风险、监督过程、裁决例外、承担最终责任。

```text
输入一个实践事件
  ↓
AI 判断 5W1H（何时、何地、何事、何因、何人、如何）
  ↓
选择合适的 Actor → 执行 Skill → 编排 Tool
  ↓
高风险动作进入审批
  ↓
结果沉淀为记忆 → 下一次实践变得更好
```

## 当前版本

```text
v0.3.4 — Memory Store Abstraction
```

v0.3.4 在 v0.3.3 的记忆快照持久化基础上抽出存储边界：新增 `MemoryStore` 接口、`JsonMemoryStore` 实现，以及 `saveMemoryService()` / `loadMemoryService()` helper。这样 MemoryService 只负责 dump/restore snapshot，具体存储实现可以后续替换。仍是本地 JSON 快照，不含 SQLite、向量检索或图记忆数据库。

## 当前能力地图

```text
ActorRuntime
  ├─ ActorContextBuilder：组装 Actor Profile、权限、工具、混合记忆
  ├─ SkillRuntime：执行 Skill 步骤，维护 state / outputs / observations
  ├─ ActorDecisionEngine：生成 ToolCall / final_output / LLM judge 决策
  ├─ ActorDecisionExecutor：统一执行 ToolCall、审批继续、state 写入
  ├─ PolicyEngine：权限检查与 Observation 字段过滤
  ├─ ApprovalGate：高风险 ToolCall 审批
  ├─ ToolGateway：工具定义与执行器路由
  ├─ LLMGateway：mock / real LLM 结构化输出入口
  ├─ MemoryService：记忆提取、去重、检索、快照 dump/restore
  └─ MemoryStore：记忆快照存储抽象，当前实现为 JsonMemoryStore
```

## 已完成的关键边界

| 边界 | 当前状态 |
|---|---|
| Actor Kernel | 单 Actor 闭环已可运行，支持 ToolCall、审批、continue、Trace、记忆沉淀 |
| LLM Gateway | 支持 mock / real 模式，结构化输出校验失败后由 ActorDecisionEngine 保守 fallback |
| Policy / Approval | Tool 权限、写操作等级、before_call 审批已进入运行链路 |
| Hybrid Memory | MemoryCandidate / MemoryRecord / MemoryPolicy / MemoryExtractor / HybridMemoryView 已接入 |
| Memory Dedup | fingerprint 稳定化，重复实践不重复写入同一批记忆 |
| Memory Observability | `memory_write_summary` Trace 事件与 `lastWriteSummary` 统计已接入 |
| Memory Persistence | MemorySnapshot JSON dump / restore 已验证 |
| Memory Store | `MemoryStore` 抽象与 `JsonMemoryStore` 实现已验证 |

## 验证脚本

```bash
npm run demo                       # Mock LLM Actor Kernel Demo，26 条验收
npm run demo:memory                # Hybrid Memory / Observability Demo，12 条验收
npm run demo:memory:persistence    # MemorySnapshot 持久化 Demo，10 条验收
npm run demo:memory:store          # MemoryStore 抽象 Demo，8 条验收
npm run typecheck                  # TypeScript 类型检查
npm run build                      # 编译
```

CI 当前覆盖：

```text
typecheck
build
demo
demo:memory
demo:memory:persistence
demo:memory:store
```

## 快速开始

```bash
npm install
npm run demo
```

默认 demo 使用 mock LLM，稳定验证本地闭环。

真实 LLM 模式需要先配置 `.env.example` 中的变量，然后运行：

```bash
npm run demo:llm
```

## 版本路线

```text
v0.3.0 — Hybrid Memory System
v0.3.1 — Memory Hardening
v0.3.2 — Memory Observability
v0.3.3 — Memory Persistence
v0.3.4 — Memory Store Abstraction
v0.3.5 — Skill Runtime Semantics（计划中）
```

v0.3.5 的建议目标：让 `SkillConfig` 中声明的步骤类型和 `ActorRuntime` 的真实执行语义完全一致，重点包括严格解析 Skill step、正式接入 transform 步骤、支持 `ReturnStep.outputMapping`，以及显式处理 unsupported step type。

## 工程脚本

```bash
npm run demo                       # 运行 Mock LLM Demo
npm run demo:llm                   # 运行真实 LLM Demo
npm run demo:memory                # 运行记忆观测 Demo
npm run demo:memory:persistence    # 运行记忆持久化 Demo
npm run demo:memory:store          # 运行记忆存储抽象 Demo
npm run typecheck                  # TypeScript 类型检查
npm run build                      # 编译
npm run start:dist                 # 运行编译产物
```

---

# organize — Self-Operating Organization

> foreverthinking · AI participates in social practice. Humans retain practice sovereignty.

## Vision

organize aims to build an Actor Kernel for self-operating organizations, enabling AI to participate in organizational practice as practice subjects within human society: judging 5W1H, scheduling tasks, orchestrating tools, coordinating roles, and crystallizing experience.

Humans move up from routine execution, retaining practice sovereignty. Practice sovereignty includes: setting goals, defining boundaries, approving risks, supervising processes, adjudicating exceptions, and bearing ultimate responsibility.

```text
Input a practice event
  ↓
AI judges 5W1H (When, Where, What, Why, Who, How)
  ↓
Selects Actor → executes Skill → orchestrates Tool
  ↓
High-risk actions enter approval
  ↓
Results crystallize as memory → next practice gets better
```

## Current Version

```text
v0.3.4 — Memory Store Abstraction
```

v0.3.4 extracts a storage boundary on top of v0.3.3 memory snapshot persistence: a `MemoryStore` interface, a `JsonMemoryStore` implementation, and `saveMemoryService()` / `loadMemoryService()` helpers. MemoryService now owns snapshot dump/restore while storage implementations can be replaced later. Still local JSON snapshot-backed memory, no SQLite, vector search, or graph memory database.

## Capability Map

```text
ActorRuntime
  ├─ ActorContextBuilder: assembles Actor Profile, permissions, tools, and hybrid memory
  ├─ SkillRuntime: executes Skill steps and maintains state / outputs / observations
  ├─ ActorDecisionEngine: produces ToolCall / final_output / LLM judge decisions
  ├─ ActorDecisionExecutor: executes ToolCalls, approval continuation, and state writes
  ├─ PolicyEngine: checks permissions and filters observation fields
  ├─ ApprovalGate: handles high-risk ToolCall approval
  ├─ ToolGateway: routes tool definitions and executors
  ├─ LLMGateway: mock / real structured LLM output boundary
  ├─ MemoryService: extraction, deduplication, retrieval, snapshot dump/restore
  └─ MemoryStore: snapshot storage abstraction, currently backed by JsonMemoryStore
```

## Completed Boundaries

| Boundary | Current status |
|---|---|
| Actor Kernel | Single-Actor loop supports ToolCall, approval, continue, Trace, and memory crystallization |
| LLM Gateway | Supports mock / real modes; structured-output failures fall back conservatively in ActorDecisionEngine |
| Policy / Approval | Tool permission, write-operation autonomy level, and before_call approval are wired into runtime |
| Hybrid Memory | MemoryCandidate / MemoryRecord / MemoryPolicy / MemoryExtractor / HybridMemoryView are wired in |
| Memory Dedup | Stable fingerprints prevent duplicate writes across repeated practice runs |
| Memory Observability | `memory_write_summary` Trace event and `lastWriteSummary` stats are available |
| Memory Persistence | MemorySnapshot JSON dump / restore is verified |
| Memory Store | `MemoryStore` abstraction and `JsonMemoryStore` implementation are verified |

## Verification Scripts

```bash
npm run demo                       # Mock LLM Actor Kernel Demo, 26 checks
npm run demo:memory                # Hybrid Memory / Observability Demo, 12 checks
npm run demo:memory:persistence    # MemorySnapshot persistence Demo, 10 checks
npm run demo:memory:store          # MemoryStore abstraction Demo, 8 checks
npm run typecheck                  # TypeScript type-check
npm run build                      # Compile
```

CI currently covers:

```text
typecheck
build
demo
demo:memory
demo:memory:persistence
demo:memory:store
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

## Roadmap

```text
v0.3.0 — Hybrid Memory System
v0.3.1 — Memory Hardening
v0.3.2 — Memory Observability
v0.3.3 — Memory Persistence
v0.3.4 — Memory Store Abstraction
v0.3.5 — Skill Runtime Semantics (planned)
```

The recommended v0.3.5 goal is to align declared `SkillConfig` step types with actual `ActorRuntime` execution semantics, especially strict Skill step parsing, first-class transform execution, `ReturnStep.outputMapping`, and explicit unsupported-step handling.

## Scripts

```bash
npm run demo                       # Run mock LLM demo
npm run demo:llm                   # Run real LLM demo
npm run demo:memory                # Run memory observability demo
npm run demo:memory:persistence    # Run memory persistence demo
npm run demo:memory:store          # Run memory store abstraction demo
npm run typecheck                  # TypeScript type-check
npm run build                      # Compile
npm run start:dist                 # Run compiled output
```
