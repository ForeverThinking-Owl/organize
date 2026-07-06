# Architecture

## 系统架构

```
┌─────────────────────────────────────────────────┐
│                  ActorRuntime                     │
│  (主执行器：加载 → 构建上下文 → 执行循环 → 输出)    │
└─────────────────────────────────────────────────┘
         │                │              │
    ┌────▼────┐    ┌──────▼──────┐  ┌───▼────────┐
    │Context  │    │  Decision   │  │  Policy     │
    │Builder  │    │  Engine     │  │  Engine     │
    └─────────┘    └─────────────┘  └─────────────┘
                         │
         ┌───────────────┼───────────────┐
    ┌────▼────┐    ┌─────▼─────┐   ┌─────▼─────┐
    │  Skill  │    │  Approval │   │   Tool    │
    │ Runtime │    │   Gate    │   │  Gateway  │
    └─────────┘    └───────────┘   └───────────┘
                                            │
                              ┌─────────────┼─────────────┐
                         ┌────▼───┐   ┌─────▼────┐  ┌────▼───┐
                         │  HTTP  │   │   SQL    │  │  Mock  │
                         │  API   │   │Executor  │  │ Tools  │
                         └────────┘   └──────────┘  └────────┘

┌──────────┐  ┌──────────┐  ┌──────────┐
│  Memory  │  │  Trace   │  │  Types   │
│  Service │  │  Logger  │  │  (Core)  │
└──────────┘  └──────────┘  └──────────┘
```

## 运行流程

```
1. 加载 ActorProfile
2. 加载 ActorMemory
3. 解析 ActorPermission
4. 加载 ActorApprovalPolicy
5. 加载 Skill
6. 构建 ActorContext
     ↓
7. 逐步执行 SkillStep
   ├── tool_call → ToolGateway.execute
   ├── llm_judge → MockLLM → Decision
   └── return   → FinalOutput
     ↓
8. PolicyEngine.check (permission)
9. ApprovalGate.check (approval)
     ↓
10. ToolGateway.execute (tool execution)
11. ToolObservation → 更新上下文
     ↓
12. FinalOutput
13. MemoryCandidate
14. TraceLogger.save
```

## 核心设计原则

- **Actor** = Identity + Memory + Permission + Approval + Skill + Tool Scope
- **Skill** = Actor 的实践程式（SOP），编排 Tool
- **Tool** = 实践入口，read/write
- **Approval** = ToolCall 治理闸门
- **Memory** = 实践沉淀，分四层作用域
- **Trace** = 全过程可追溯

## 项目结构

```
organize/
  docs/                   # 设计文档
  src/
    core/types/           # 核心类型定义（7 files）
    runtime/              # 核心运行时（5 files）
    policy/               # 权限与审批策略引擎
    tools/                # 工具网关 + Mock 实现
    approvals/            # 审批网关（pause/resume）
    memory/               # 记忆服务
    trace/                # Trace 记录器
    examples/             # 验证 Demo
```

## 路线图

**v0.1 (已完成)** — Single Actor Kernel Demo
- ActorProfile / ActorContext / ActorDecision
- SkillRuntime + ToolGateway + ApprovalGate
- Mock LLM + 3 Mock Tools
- MemoryCandidate + TraceLogger
- waiting_approval / continue

**v0.2** — 真实接入
- 接入真实 LLM
- 接入数据库（Actor / Skill / Memory 持久化）
- denial_fields 过滤 + after_call 审批

**v0.3** — 多 Actor 协同
- Scene 编排引擎
- Actor 间 Handoff
- Scene Shared Context

**v0.4** — 工具扩展
- SQL Executor
- HTTP API Executor
- RPA Executor
- MCP Executor

**v0.5** — 生产化
- 真实审批页面
- 向量记忆检索
- 复杂权限继承
