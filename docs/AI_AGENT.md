# AI Agent 设计

## Agent 模型

ForeverThinking 中的 AI Agent 是一个**实践调度者**，不是对话机器人。

AI 的核心作用是参与实践调度，判断：

- 何时实践 (When)
- 何地实践 (Where)
- 何事实践 (What)
- 何因实践 (Why)
- 何人实践 (Who)
- 如何实践 (How)

即实践的 5W1H。

## Agent 决策协议

Agent 每一步输出结构化决策（ActorDecision），而非自由文本。

```typescript
type ActorDecision =
  | ToolCallDecision       // 调用工具
  | RequestApprovalDecision // 请求审批
  | HandoffDecision        // 移交给其他 Actor
  | FinalOutputDecision;   // 输出最终结果
```

## Mock LLM 实现

当前 MVP 使用规则引擎模拟 LLM 判断：

- 关键词匹配（退款、连不上、扫码枪等）
- 输出结构化分流结果
- 决定是否需要创建工单

下一步将替换为真实 LLM（通过 llm-gateway.service）。

## Agent 安全边界

1. **Prompt 前过滤**：移除无权访问的记忆、工具、字段
2. **Decision 后校验**：校验模型输出的动作是否越权
3. **Observation 后过滤**：对返回结果做字段过滤、脱敏

## Agent 的自主范围

Agent 的自主范围由 Autonomy Level 定义：

- L0-L1：只能读，不能写
- L2：可生成草稿，不可直接执行
- L3-L4：可执行，但有审批约束

Agent 不能：
- 超出自己的 Tool Scope
- 访问 denied_fields
- 绕过 Approval Policy
- 修改自己的 Permission
- 在没有 handoff 的情况下执行其他 Actor 的 Skill
