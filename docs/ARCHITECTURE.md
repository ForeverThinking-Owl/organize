# Architecture

## 系统边界

organize 由两个相互独立但可组合的运行时组成：

```text
可信宿主
  │
  ├─ OrganizationRuntime
  │    ├─ ActorRegistry          Actor、Skill 与组织能力
  │    ├─ TaskManager            任务状态、lineage 与进程内 FIFO 队列
  │    ├─ ActorInbox             queued / delivered / acknowledged
  │    ├─ HandoffRegistry        请求、路由、fingerprint 与响应绑定
  │    ├─ OrganizationTrace      组织级任务、消息与治理事件
  │    └─ OrganizationSnapshot   组织聚合与 Actor Runtime 恢复状态
  │                 │
  │                 └─ dispatch / continue
  │
  └─ ActorRuntime
       ├─ ContextBuilder         身份、权限、工具、记忆与输入
       ├─ SkillRuntime           顺序执行 SkillStep
       ├─ DecisionEngine         生成结构化 ActorDecision
       ├─ Policy / Approval      Tool 权限与审批边界
       ├─ ToolGateway            Tool 执行
       ├─ MemoryService          候选、接受与持久化
       └─ TraceLogger            Actor run 生命周期
```

`ActorRuntime` 不查找组织成员，也不创建组织任务；它只执行一个已解析的
Actor/Skill。`OrganizationRuntime` 负责路由、能力检查、任务物化、消息关联和组织级
恢复。可信宿主负责认证调用身份、持久化 checkpoint，以及决定何时调度或继续任务。

## Actor run 生命周期

```text
run
 ├─ completed
 ├─ handoff_requested
 ├─ waiting_approval ─────────── continue ─┐
 ├─ waiting_human_input ──────── continue ─┼─ completed / handoff_requested / error
 ├─ waiting_external_event ───── continue ─┘
 └─ error
```

`completed`、`handoff_requested` 和 `error` 是终态。只有 `waiting_*` 状态拥有
`PendingRunSnapshot` 并可调用 `continue()`。终态 run 会清理运行态，因而
`handoff_requested` 不是第五种 pending 状态，也不能被恢复为原 Actor 继续执行。

## Governed Actor handoff

### Runtime contract

handoff 由 Skill 的最后一个步骤显式声明：

```yaml
- step_key: delegate_review
  type: handoff
  target_actor_id: actor_reviewer
  target_skill_id: review_case
  reason: "交由复核 Actor 处理"
  input_mapping:
    case_id: "{{context.case_id}}"
    draft: "{{outputs.draft}}"
```

当前协议只接受稳定的 `target_actor_id` 与 `target_skill_id`，不做角色寻址或 LLM
动态选路。`input_mapping` 必须完全解析为 JSON-safe 数据；空目标、未知字段、残留模板、
非安全 JSON 值或非末尾 handoff 都会 fail closed。

合法步骤生成一个运行时拥有身份的 `HandoffRequest`：

```text
handoffRequestId + actorRunId + sourceActorId + sourceSkillId + stepKey
+ targetActorId + targetSkillId + reason + handoffContext
```

Actor Trace 恰好记录一次完整的 `handoff` 事件，并以
`actor_run_end(status=handoff_requested)` 结束；输出没有 final result，也没有 pending
run。独立使用 `ActorRuntime` 时，消费和路由该请求是调用方的责任。

### Organization governance

`OrganizationRuntime` 接到 terminal handoff 后，在物化前验证：

- 请求必须与正在运行的源 Task、Actor、Skill 和 actorRunId 完全绑定；
- 源 Actor 与目标 Actor 必须不同且同属当前组织；
- 源 Actor 必须 active，并持有 `task:delegate` 与 `message:receive`；
- 目标 Actor 必须 active，并持有 `task:execute` 与 `message:receive`；
- 目标 Skill 必须由目标 Actor 注册并通过其 Skill allowlist；
- 源 Task 必须仍可委派，且不能超过 `MAX_HANDOFF_DEPTH = 1`。

内部 `task_request` / `task_response` 由 OrganizationRuntime 生成，不要求 Actor 伪装成
调用方执行通用 `message:send`。外部显式调用消息 API 时仍需执行正常的 send/receive
能力检查。

### Task、Queue 与 Inbox

一次通过治理的 handoff 在进程内组织聚合上按 commit-or-rollback 方式物化：

```text
源 Task (depth 0, running)
  ├─ status = delegated
  ├─ outgoingHandoffRequestId = handoffRequestId
  │
  └─ 子 Task (depth 1, queued)
       ├─ rootTaskId   = 源 Task.rootTaskId
       ├─ parentTaskId = 源 Task.taskId
       ├─ incomingHandoffRequestId = handoffRequestId
       ├─ assignedTo / skillId = 显式目标
       └─ input.payload = handoffContext
```

同一事务还创建不可变 `OrganizationHandoffRecord`、一个排队的 `task_request` 以及对应
Organization Trace。请求使用：

```text
task_request.correlationId = handoffRequestId
task_request.causationMessageId = undefined
```

`handoffRequestId` 与请求 envelope 的 SHA-256 fingerprint 构成进程内幂等边界。重放
相同请求返回已有的 child/request artifacts；相同 ID 但不同路由或内容会被拒绝。该边界
防止已加载聚合中的重复物化，但不等于跨进程 exactly-once。

子 Task 被 claim 时，其 `task_request` 先 delivered 再 acknowledged，随后才进入
ActorRuntime。子 Task 完成或失败时，系统只生成一次关联响应：

```text
task_response.correlationId = handoffRequestId
task_response.causationMessageId = task_request.messageId
```

响应携带 child 的 `completed` result 或 `failed` reason，并进入源 Actor Inbox。源 Task
保持 `delegated`，源 Actor 不会自动恢复或消费响应；父 Actor continuation 不属于当前
协议。

### Bounded scheduling

`dispatchNext()` 每次 claim 并执行一个排队任务。`dispatchUntilIdle()` 是其有界循环，
默认最多 dispatch 100 次，也可按 Actor 筛选；它只返回 `idle` 或 `dispatch_limit`，并
报告剩余 queued Task 与所有 `waiting_*` blocked Task。它不是后台 worker、定时器或持久
队列消费者，同一 OrganizationRuntime 中也不允许两个该循环并行运行。

由于 `MAX_HANDOFF_DEPTH = 1`，只有 depth 0 根任务可以产生一个 depth 1 子任务；子任务
再次 handoff 会被组织层拒绝。当前没有链式委派、fan-out 或任意 DAG。

## Recovery 与持久化

当前相关 schema：

| 数据 | Schema | 说明 |
|---|---|---|
| Organization checkpoint | `organization.snapshot.v3` | Registry、Task/Queue、Inbox、Handoff、Organization Trace 与 runtime recovery |
| Organization JSON store | `organization.store.v3` | 一个或多个 v3 Organization checkpoint |
| Actor Trace | `trace.snapshot.v2` | 支持 terminal `handoff_requested` 与 handoff 事件约束 |
| Pending run | `pending_run.snapshot.v2` | 仅保存 `waiting_*` run；handoff 不在其中 |
| Runtime recovery bundle | `runtime_recovery.store.v2` | PendingRun、Trace 与 Memory 的组合恢复边界 |

v3 OrganizationSnapshot 保存完整 handoff lineage 和 request/response 引用，并在恢复前交叉
校验 Task、Queue、Actor/Skill、能力、Inbox correlation、Handoff fingerprint、Actor Trace、
Organization Trace、PendingRun 和 Memory。失败恢复会回滚本进程中已提交的 Memory、Trace、
PendingRun 与 ownership，避免留下部分恢复状态。

`organization.snapshot.v2` / `organization.store.v2` 通过纯 normalize 迁移到 v3：旧任务成为
`handoffDepth = 0` 且 `rootTaskId = taskId` 的根任务，handoff registry 为空；嵌套旧 Actor
Trace 同时迁移到 `trace.snapshot.v2`。迁移不修改输入或原文件，下一次显式 save 才写入 v3。
标记为 v2 却包含 handoff step、`task:delegate`、lineage、correlation 或 v3 Trace 事件的混合
数据会被拒绝，而不会被猜测性迁移。

## 保证与非目标

当前实现保证：

- OrganizationRuntime 按 `organizationId` 隔离注册表、任务、消息、handoff 与恢复状态；
- 同一进程内一个组织只能由一个 OrganizationRuntime owner 加载；
- 任务委派物化和响应物化失败时回滚组织聚合，不保留半条 lineage 或半条消息链；
- JSON Store 在单实例中串行写入，并以临时文件 rename 原子替换；
- Recovery 对结构、引用和运行时一致性 fail closed；
- Handoff 请求在已加载聚合中按 request ID 和 fingerprint 幂等。

当前实现不保证：

- 父 Actor 等待子结果、自动恢复或双向 continuation；
- 角色路由、动态目标选择、链式 handoff、fan-out、Scene 或任意任务 DAG；
- 多进程 worker、租约、分布式锁、跨进程 CAS 或共享文件多写者安全；
- transactional outbox、跨存储事务或崩溃安全的 exactly-once；
- 自动重试、退避、DLQ 或远程消息 broker；
- snapshot 加密真实性，或对宿主传入身份的认证。

整体恢复语义仍是 at-least-once。Tool executor 必须用稳定的 `toolCallId` 做持久幂等，
宿主必须管理 checkpoint 推进与删除。若需要 crash-safe exactly-once，部署层或后续版本必须
提供 durable idempotency / transactional outbox；若多个进程共享 JSON store，则必须提供外部
锁或单写者约束。

## 项目结构

```text
src/
  core/types/       Actor、Skill、Decision、Trace 等核心协议
  runtime/          ActorRuntime、SkillRuntime、handoff 与 pending recovery
  organization/     Registry、Task、Inbox、Handoff、Trace、Snapshot 与 migration
  approvals/        Skill / Tool 审批边界
  policy/           Actor Tool 权限策略
  tools/            ToolGateway 与 executors
  memory/           Memory service、snapshot 与 store
  trace/            Actor Trace logger、snapshot 与 store
  examples/         可执行验收 Demo
```
