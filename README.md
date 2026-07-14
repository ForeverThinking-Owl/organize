[中文](#organize--自运组织) | [English](#organize--self-operating-organization) | [CHANGELOG](./CHANGELOG.md)

---

# organize — 自运组织

> foreverthinking · 让 AI 参与社会实践调度，人类保留实践主权

## 这是什么

organize 是一个面向“自运组织”的 Actor Kernel 原型。它把 AI 视为参与组织实践的主体，而不是单次问答工具：Actor 有身份、记忆、权限、审批边界、技能流程和工具范围，并在每次实践后沉淀经验，让下一次实践变得更好。

当前闭环：

```text
组织创建任务 / Actor 发送消息
  ↓
OrganizationRuntime：成员、权限、任务队列、Inbox、组织 Trace
  ↓
任务 dispatch 到已注册 Actor + Skill
  ↓
构建 ActorContext：身份、权限、工具、记忆、输入
  ↓
执行 Skill：判断、调用工具、等待人工输入、等待显式审批、等待外部事件、处理工具审批、生成结果
  ↓
Trace 记录：start / suspended / resumed / end / validation_failed
  ↓
Runtime Recovery Bundle：PendingRun + Trace + Memory 可组合保存与恢复
  ↓
跨进程恢复：process A save bundle，process B load / restore / continue
  ↓
沉淀 Memory：候选、策略、去重、检索、持久化
  ↓
OrganizationSnapshot：按组织保存 Registry、Task、Inbox、Trace 与 pending Actor runs
```

## 当前版本

```text
v0.5.1 — Governance Fail-Closed
```

当前版本保留 v0.5.0 的 Organization Runtime Foundation，并补上两个 fail-closed 治理边界：Tool approval 目前只实现 `beforeCall`，声明 `afterCall` 或 `beforeWriteback` 的 Tool 会在注册时被拒绝；声明了 `correlation_key` 的 external-event wait 及其每个插值 token 都必须在进入等待前解析为非空标量，且不能残留模板占位符。解析失败会终止该 run，不创建 pending request，也不记录 `external_event_requested`。v0.5.0 的不安全 pending snapshot 在恢复时同样会被拒绝。

版本历史、验收矩阵、CI 覆盖和下一步计划见 [CHANGELOG.md](./CHANGELOG.md)。

## 核心概念

| 概念 | 说明 |
|---|---|
| Actor | 组织中的实践主体，拥有身份、职责、权限、自主等级和记忆。 |
| OrganizationRuntime | 多组织编排入口，按 organizationId 隔离 Actor、Task、Message 与 Trace。 |
| Organization Task | `created → assigned → queued → running → waiting_* / completed / failed` 的受控任务状态机。 |
| Actor Inbox | 消息按 FIFO 经历 queued / delivered / acknowledged，不在 send 时伪造 received。 |
| OrganizationSnapshot | 保存 Registry、Task Queue、Inbox、Organization Trace 与组织分区的 Actor Runtime 恢复状态。 |
| Skill | Actor 的实践程式，描述按步骤执行的 SOP。 |
| Human Input | Skill 运行中的人工补充输入边界，支持 waiting_human_input / continue。 |
| Wait Approval | Skill 运行中的显式人工审批边界，支持 waiting_approval / continue。 |
| Tool Approval | ToolCall 前的治理审批边界，支持 waiting_approval / continue。 |
| External Event | 外部系统事件驱动的等待边界，支持 waiting_external_event / continue，并带 schema / correlation 校验。 |
| Trace Lifecycle | `actor_run_start` → `actor_run_suspended` / `actor_run_resumed` → `actor_run_end`。 |
| PendingRunSnapshot | 恢复 suspended run 执行所需的 Runtime state，不包含 Trace / Memory。 |
| RuntimeRecoveryBundle | 组合 PendingRunSnapshot、TraceSnapshot、MemorySnapshot 的恢复包。 |

## 验证脚本

```bash
npm run demo                       # Mock LLM Actor Kernel Demo
npm run demo:memory                # Hybrid Memory / Observability Demo
npm run demo:memory:persistence    # MemorySnapshot persistence Demo
npm run demo:memory:store          # MemoryStore abstraction Demo
npm run demo:skill                 # Skill Runtime Semantics Demo
npm run demo:runtime:store         # Runtime Store Binding Demo
npm run demo:trace:persistence     # Trace Persistence Demo
npm run demo:human:input           # Human Input Runtime Demo
npm run demo:wait:approval         # Wait Approval Runtime Demo
npm run demo:waiting:resume        # General Waiting / Resume Demo
npm run demo:pending:run           # Pending Run Persistence Demo
npm run demo:recovery:bundle       # Runtime Recovery Bundle Demo
npm run demo:recovery:cross-process # Cross-process Recovery Demo
npm run demo:external:event        # External Event Runtime Demo
npm run demo:external:event:validation # External Event Validation Demo
npm run demo:tool:approval:fail-closed # Tool Approval Fail-Closed Demo
npm run demo:continuation:validation # Retry-safe Continuation Validation Demo
npm run demo:organization          # Organization Runtime Demo
npm run demo:organization:recovery # Organization Snapshot / Recovery Demo
npm run demo:organization:pending:recovery # Four Pending Kinds Recovery Demo
npm run demo:organization:lifecycle # In-flight Clear Protection Demo
npm run typecheck                  # TypeScript type-check
npm run build                      # Compile
npm run start:dist                 # Compiled output runtime smoke
```

## Organization Runtime Foundation

组织层保持 `ActorRuntime.run()` / `continue()` API 不变，只在其上增加编排与治理：

```text
OrganizationRuntime
  ├─ ActorRegistry        → ActorConfig + SkillConfig + capabilities
  ├─ TaskManager          → assign / enqueue / atomic claim / dispatch / continue
  ├─ ActorInbox           → queued / delivered / acknowledged
  ├─ OrganizationTrace    → task / message / permission / recovery metadata
  └─ OrganizationSnapshot → Registry + Queue + Inbox + pending Actor runs
```

安全边界：

- Actor、Task、Message 和恢复状态必须属于同一个 organizationId。
- 首个 Actor 必须持有 `organization:manage`，后续 Actor 只能由已有 manager 注册，避免自授予权限。
- Skill 必须属于目标 Actor，并出现在 `allowed_skills` 中。
- Task 与 Message API 强制检查组织能力；跨 Actor Inbox 读取需要 `organization:manage`。
- Human input、approval 与 external event continuation 分别校验执行、审批与事件接收能力；审批者不能批准自己的任务运行。`requestedByActorId` 等调用身份必须由可信宿主认证后传入，Capability 负责授权而不负责身份认证。
- Human input、Skill approval、Tool approval 与 External event 都在 resume / consume 前校验 event type 与 request ID；非法 continuation 不结束运行、不消费审批，并允许合法重试。
- TaskManager 与 Inbox 返回深拷贝，后续状态变化不会改写历史快照。
- 恢复先完整校验 Registry、Queue、Inbox、Task ↔ PendingRun ↔ canonical Actor/Skill/Tool policy ↔ Trace 绑定，再提交目标组织的 Memory、Trace 与 pending runs；失败时回滚全局恢复状态。
- PendingRun、RuntimeRecoveryBundle 与 Organization snapshot/store 使用 v2 schema；缺少 Tool policy fingerprint 的 v1 Tool-approval checkpoint 会安全拒绝。
- `runtimeOptions.memoryStore` 按当前 organization 分区 merge / save，不覆盖同进程其他组织或同组织并发 pending run。
- Tool approval 固化 policy fingerprint；Tool 定义、请求与 observation 在边界深拷贝并校验 identity、JSON shape 与 output schema。
- Tool approval 当前只支持 `beforeCall`；`afterCall` 与 `beforeWriteback` 是预留阶段，Tool 注册会明确拒绝，避免治理配置被静默忽略。
- Snapshot preflight 提供结构与内部一致性校验，不提供加密真实性；将快照放在不可信存储时仍需要由部署层提供签名或完整性保护。
- `clearOrganization()` 是可信宿主生命周期 API；存在 in-flight dispatch / continue 时会拒绝清理，避免产生 orphan Actor run。
- OrganizationRuntime ownership 是进程内状态；宿主卸载组织时必须显式调用 `clearOrganization()` 释放。
- 所有 JSON Store 在单实例内串行化写入并使用临时文件原子替换；多个实例或进程共享同一文件仍需由部署层提供锁或单写者约束。
- Recovery 是 at-least-once：Tool executor 必须按 snapshot 中稳定的 `toolCallId` 去重，checkpoint 推进/删除由宿主管理；崩溃安全的 exactly-once 需要 transactional outbox 或持久幂等存储。
- Message payload、外部事件 payload 和完整 runtimeContext 不写入 Organization Trace。

## External Event Safety

`wait_external_event` 可声明 `event_schema` 和 `correlation_key`：

一旦声明 `correlation_key`，最终结果及每个 `{{...}}` 插值 token 都必须在 suspend 前解析为非空的 string / number / boolean。缺失、空值、对象、数组或未解析模板都会让 run fail closed，包括对象或空值嵌入 `tenant/{{context.id}}` 这样的部分模板；未声明 correlation 的 Skill 保持兼容。

```ts
{
  step_key: "wait_payment",
  type: "wait_external_event",
  event_name: "payment.confirmed",
  correlation_key: "{{outputs.order_info.orderId}}",
  output_key: "payment_event",
  event_schema: {
    type: "object",
    required: ["payment_id", "status"],
    properties: {
      payment_id: { type: "string" },
      status: { type: "string" }
    }
  }
}
```

恢复时：

```ts
await actorRuntime.continue(actorRunId, {
  type: "external_event_received",
  event: {
    externalEventRequestId,
    eventName: "payment.confirmed",
    correlationKey: "ORDER_10086",
    payload: { payment_id: "PAY_10086", status: "confirmed" },
    receivedBy: "payment_webhook",
    receivedAt: new Date().toISOString(),
  },
});
```

成功后 payload 写入 `steps` / `outputs`：

```text
{{outputs.payment_event.payload.status}}
{{steps.wait_payment.payload.payment_id}}
```

Trace 只记录 metadata 与 payload summary，不记录完整 payload。

## 等待 / 恢复生命周期

```text
human_input          → actor_run_suspended(waitingKind=human_input)       → actor_run_resumed → actor_run_end
wait_approval        → actor_run_suspended(waitingKind=skill_approval)    → actor_run_resumed → actor_run_end
tool_call approval   → actor_run_suspended(waitingKind=tool_approval)     → actor_run_resumed → actor_run_end
wait_external_event  → actor_run_suspended(waitingKind=external_event)    → actor_run_resumed → actor_run_end
```

## Runtime Recovery Bundle

```text
PendingRunSnapshot = 可恢复执行的 suspended Runtime state
TraceSnapshot      = 可审计复盘的 Trace state
MemorySnapshot     = 可长期沉淀的经验 state
```

恢复顺序固定为：

```text
MemorySnapshot → TraceSnapshot → PendingRunSnapshot
```

---

# organize — Self-Operating Organization

## Current Version

```text
v0.5.1 — Governance Fail-Closed
```

This version retains the v0.5.0 Organization Runtime Foundation and closes two governance gaps. Tool approval currently implements only `beforeCall`; Tool definitions that declare `afterCall` or `beforeWriteback` now fail registration instead of silently bypassing those policies. A configured external-event correlation key and every interpolation token must resolve before suspension to a non-empty scalar with no unresolved template delimiters. Unsafe setup ends the run without a pending request or `external_event_requested` Trace, and unsafe v0.5.0 pending snapshots fail closed on restore.

Recovery is at-least-once. Tool executors must durably deduplicate the stable snapshot `toolCallId`, and the host owns checkpoint advancement/deletion; crash-safe exactly-once delivery requires a transactional outbox or durable idempotency store. JSON stores serialize atomic replacement only within one instance, so shared multi-instance/process files require an external lock or single writer. PendingRun, RuntimeRecoveryBundle, and Organization checkpoint schemas are v2 and reject unsafe v1 Tool-approval checkpoints that lack a policy fingerprint.

## Verification Scripts

```bash
npm run demo
npm run demo:memory
npm run demo:memory:persistence
npm run demo:memory:store
npm run demo:skill
npm run demo:runtime:store
npm run demo:trace:persistence
npm run demo:human:input
npm run demo:wait:approval
npm run demo:waiting:resume
npm run demo:pending:run
npm run demo:recovery:bundle
npm run demo:recovery:cross-process
npm run demo:external:event
npm run demo:external:event:validation
npm run demo:tool:approval:fail-closed
npm run demo:continuation:validation
npm run demo:organization
npm run demo:organization:recovery
npm run demo:organization:pending:recovery
npm run demo:organization:lifecycle
npm run typecheck
npm run build
npm run start:dist
```
