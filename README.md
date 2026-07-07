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
v0.3.2 — Memory Observability
```

v0.3.2 在 v0.3.1 的混合记忆硬化基础上增加记忆写入观测：抽出共享 memory fingerprint 工具，记录 `memory_write_summary` Trace 事件，暴露 MemoryService 最近一次写入摘要，并在 CI 中加入 build 验证。仍是内存版，不含向量检索或图记忆数据库。

```bash
npm run demo:memory    # 记忆观测闭环验证
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

## 工程脚本

```bash
npm run demo        # 运行 Mock LLM Demo
npm run demo:llm    # 运行真实 LLM Demo
npm run typecheck   # TypeScript 类型检查
npm run build       # 编译
npm run start:dist  # 运行编译产物
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
v0.3.2 — Memory Observability
```

v0.3.2 adds memory write observability on top of v0.3.1 hybrid memory hardening: shared memory fingerprint utilities, a `memory_write_summary` Trace event, the latest write summary in MemoryService stats, and build verification in CI. Still in-memory only, no vector search or graph memory database.

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

## Scripts

```bash
npm run demo        # Run mock LLM demo
npm run demo:llm    # Run real LLM demo
npm run typecheck   # TypeScript type-check
npm run build       # Compile
npm run start:dist  # Run compiled output
```
