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
v0.3.0 — Hybrid Memory System
```

v0.3.0 引入内存版混合记忆系统：MemoryRecord、MemoryCandidate、MemoryPolicy、MemoryExtractor、HybridMemoryView。Actor 不只完成一次实践，而能从实践中沉淀经验，并在下一次实践中读取经验。仍是内存版，不含向量检索或图记忆数据库。

```bash
npm run demo:memory    # 混合记忆闭环验证
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
v0.2.1 — LLM Integration Hardening
```

v0.2.1 hardens the LLM integration layer after v0.2.0 Real LLM Integration: CI, lightweight `.env` loading, LLM retry, and controlled fallback boundaries for structured-output failures. Actor Kernel boundaries remain unchanged. PolicyEngine, ApprovalGate, ToolGateway and MemoryService continue to operate outside the model boundary.

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
