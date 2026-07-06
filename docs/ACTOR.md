# Actor

Actor 是 AI-Agent 的基本单位。

## 结构

```
Actor = Identity + Role + Responsibility + Memory + Permission
        + Approval Judgment + Skill Set + Tool Scope + Autonomy Level + Runtime State
```

## 自主等级

| Level | 名称 | 能力 |
|-------|------|------|
| L0 | observe_only | 只能观察、总结、标注 |
| L1 | suggest_only | 可提建议，不可写 |
| L2 | read_and_draft | 可查询数据、生成草稿 |
| L3 | low_risk_execute | 可执行低风险动作 |
| L4 | governed_execute | 在审批规则约束下执行 |

## 记忆（四层作用域）

| 作用域 | 可读 | 可写 |
|--------|------|------|
| organization_public | 所有 Actor | 不可 |
| unit | 同 Unit Actor | 候选写入 |
| actor_private | 仅自己 | 可 |
| scene_shared | Scene 内 | Scene 内 |

## 权限（六类）

1. Skill Permission
2. Tool Permission（allowed / restricted / denied）
3. Data Permission（资源 + 字段级）
4. Write Permission（allowed_low_risk / requires_approval）
5. Scene Permission
6. Approval Permission

## 审批判断

- Request Approval：发现自己需要审批
- Approve Others：有审批权限，可审批他人请求

## MVP Actor 配置

```json
{
  "actor_id": "customer_service_actor",
  "name": "客服 Actor",
  "type": "ai",
  "role": "customer_service",
  "autonomy_level": "L2_read_and_draft",
  "memory": [
    "涉及退款时，不要承诺退款完成。",
    "设备连接问题通常需要技术排查。"
  ],
  "permissions": {
    "allowed_tools": ["query_order_info", "query_ticket_history", "create_ticket"],
    "denied_tools": ["create_refund_request", "approve_refund"]
  },
  "approval_judgment": {
    "must_request_approval_when": [
      "创建 urgent 工单",
      "外部正式发送客户回复",
      "涉及退款承诺"
    ]
  }
}
```
