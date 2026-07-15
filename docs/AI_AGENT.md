# AI Agent 设计

## Agent 模型

ForeverThinking 中的 AI Agent 是一个**实践调度者**，不是无边界的对话机器人。

Actor 在已注册的 Skill 中执行结构化步骤。身份、记忆、工具权限、审批政策与 Skill allowlist
构成运行边界；OrganizationRuntime 再为多 Actor 任务增加成员状态、组织能力、队列、Inbox
与恢复约束。可信宿主负责认证调用身份，Capability 只负责授权。

## 结构化决策协议

Agent 每一步产生 `ActorDecision`，而不是把自由文本直接当成动作：

```typescript
type ActorDecision =
  | ToolCallDecision
  | RequestApprovalDecision
  | HandoffDecision
  | FinalOutputDecision;
```

其中 handoff 决策使用稳定的 Actor/Skill 地址：

```typescript
interface HandoffDecision {
  decisionType: "handoff";
  reasoningSummary: string;
  targetActorId: string;
  targetSkillId: string;
  reason: string;
  handoffContext: Record<string, unknown>;
}
```

当前 `DecisionEngine` 从声明式 Skill step 确定 handoff 目标，不允许模型临时选择角色或目标
Actor。OrganizationRuntime 也不会按自然语言 role 做模糊匹配。

## Skill handoff

handoff 必须是 Skill 的最后一步，并显式声明目标与输入映射：

```typescript
{
  step_key: "delegate_review",
  type: "handoff",
  target_actor_id: "actor_reviewer",
  target_skill_id: "review_case",
  reason: "需要独立复核",
  input_mapping: {
    case_id: "{{context.case_id}}",
    draft: "{{outputs.draft}}"
  }
}
```

运行前后边界如下：

1. Skill parser 拒绝空目标、未知字段与非末尾 handoff。
2. DecisionEngine 解析 `input_mapping`；残留模板或非 JSON-safe 数据会在写 handoff audit
   event 前失败。
3. Executor 创建带唯一 `handoffRequestId` 的 `HandoffRequest`，并把完整请求写入 Actor
   Trace。
4. ActorRuntime 以 terminal `handoff_requested` 结束，返回 `handoffRequest`，清理运行态。
5. 独立 ActorRuntime 调用方自行消费请求；OrganizationRuntime 调用方进入组织治理流程。

`handoff_requested` 不是 pending：它没有 PendingRunSnapshot，不能 `continue()`，也不会同时
产生 final output。handoff 之前仍可经历 human input、approval 或 external event 等等待；等待
恢复后到达 handoff 时，该 run 的最终输出仍按相同终态协议处理。

## 组织治理

OrganizationRuntime 只接受与当前 Task/Actor/Skill/actorRun 完全一致的 HandoffRequest，并在
创建子任务前检查：

- 源 Actor active，且拥有 `task:delegate` 与 `message:receive`；
- 目标 Actor active，且拥有 `task:execute` 与 `message:receive`；
- 目标 Skill 已注册给目标 Actor，并处于其允许范围；
- 源和目标不是同一 Actor；
- 源 Task 是 depth 0、正在运行且尚未委派。

当前 `MAX_HANDOFF_DEPTH = 1`。通过治理后，源 Task 进入 `delegated`，系统原子创建一个已
分配并 `queued` 的 depth 1 子 Task、一个 handoff record 和一个 `task_request`。子 Task
claim 时 request 才 delivered / acknowledged，随后目标 Actor 执行目标 Skill。

request 与 response 的关联规则固定：

```text
task_request.correlationId  = handoffRequestId
task_response.correlationId = handoffRequestId
task_response.causationMessageId = task_request.messageId
```

子 Task `completed` 或 `failed` 时只生成一次 `task_response`。该消息为 Inbox/audit 结果；源
Task 仍保持 `delegated`，源 Actor 不会恢复。父 Actor 等待子结果并 continuation 是后续协议，
不是当前实现。

`dispatchUntilIdle({ maxDispatches })` 只是一个有上限的进程内调度循环。它可连续运行根任务
与新排队的 child，达到上限或没有匹配 queued Task 时返回，并报告 waiting tasks；它不是
后台 worker 或分布式队列。

## 安全边界

Agent 不能：

- 超出自己的 Tool Scope 或访问 `denied_fields`；
- 绕过 Tool permission、Approval Policy 或 continuation identity 校验；
- 修改自己的 Actor permission 或 Organization capability；
- 在没有合法 handoff 的情况下执行其他 Actor 的 Skill；
- 用 role、自由文本或未解析模板替代明确的目标 Actor/Skill；
- self-handoff，或从 depth 1 子任务再次 handoff；
- 把 `handoff_requested` 当作 suspended run 恢复；
- 通过伪造 correlation、causation、task lineage 或 Trace 引用恢复快照。

handoff 的 `handoffRequestId` 与 request fingerprint 提供已加载组织聚合中的幂等检查，
OrganizationSnapshot v3 恢复还会交叉验证 Actor Trace v2、Task lineage、Handoff registry、
Inbox request/response、Organization Trace、能力和目标 Skill。它们不提供跨进程 CAS、签名或
transactional outbox。

## 当前自治范围

- Actor 可以在自己的 Skill 中判断、调用获准 Tool、请求审批或等待输入/事件。
- depth 0 Actor 可以通过预先声明的 terminal step 向一个显式 Actor/Skill 单向移交任务。
- OrganizationRuntime 可以通过有界调度执行 child，并把终态结果作为 correlated response
  放入源 Actor Inbox。
- 父 Actor 不消费 response 后恢复；没有链式 handoff、fan-out、Scene/DAG、重试/DLQ、
  多进程 worker 或动态 LLM 路由。

系统恢复语义仍是 at-least-once。Tool executor 必须按稳定 `toolCallId` 做持久幂等；JSON
store 的串行与原子替换仅限单实例。多进程共享存储需要外部锁或单写者，crash-safe
exactly-once 需要 durable idempotency 或 transactional outbox。
