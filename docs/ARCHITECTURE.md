# Architectures

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
