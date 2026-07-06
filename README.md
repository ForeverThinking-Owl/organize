# organize — 自运组织

> foreverthinking 公司 | Single Actor Kernel Demo — Verified ✅

## 项目简介

organize 是一个面向未来组织运行方式的 AI-Agent 系统。当前为 MVP 第一阶段：**单 Actor 最小闭环**。

## 运行 Demo

```bash
npm install
npm run demo
```

## 项目结构

```
organize/
  docs/                   # 设计文档
  src/
    core/types/           # 核心类型定义
      actor.ts            # ActorProfile, ActorContext, ToolForActor
      actor-decision.ts   # ActorDecision（联合类型）
      skill.ts            # Skill, SkillStep
      tool.ts             # ToolDefinition, ToolCallRequest, ToolObservation
      approval.ts         # ApprovalRequest, ApprovalDecision
      memory.ts           # MemoryEntry, MemoryCandidate
      trace.ts            # TraceEvent, ActorRunTrace

    runtime/              # 核心运行时
      actor-context-builder.ts   # 构建 ActorContext
      actor-runtime.ts           # Actor Kernel 主执行器
      skill-runtime.ts           # Skill 步骤执行器
      actor-decision-engine.ts   # 决策引擎（Mock LLM）
      actor-decision-executor.ts # 统一 ToolCall 管线

    policy/
      policy-engine.ts    # 权限与审批策略引擎

    tools/
      tool-gateway.ts     # 工具网关（路由 + 执行）
      mock-tools.ts       # 3 个 Mock Tool 实现

    approvals/
      approval-gate.ts    # 审批网关（支持 pause/resume）

    memory/
      memory-service.ts   # 记忆服务

    trace/
      trace-logger.ts     # Trace 记录器

    examples/
      customer-after-sales.demo.ts  # 验证 Demo
```

## MVP 验收结果

已通过全部 13 条验收标准：

| # | 标准 | 状态 |
|---|------|------|
| 1 | ActorContext 被正确构建 | ✅ |
| 2 | Actor 读取到自己的记忆 | ✅ |
| 3 | Actor 只能看到自己有权使用的 Tool | ✅ |
| 4 | Skill 按步骤执行 | ✅ |
| 5 | query_order_info 被调用 | ✅ |
| 6 | query_ticket_history 被调用 | ✅ |
| 7 | Actor 生成结构化判断 | ✅ |
| 8 | Actor 生成 create_ticket ToolCall | ✅ |
| 9 | ApprovalGate 识别 urgent 工单需要审批 | ✅ |
| 10 | 审批通过后 ToolGateway 执行 create_ticket | ✅ |
| 11 | Actor 输出 final_output | ✅ |
| 12 | 生成 memory_candidate | ✅ |
| 13 | Trace 记录完整链路 | ✅ |

## 下一步

- 接入真实 LLM
- 接入真实数据库
- 扩展 Scene（多 Actor 协同）
- 接入更多 Tool 类型（SQL、RPA、MCP）
