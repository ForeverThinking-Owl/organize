# CHANGELOG / 更新日志

README 是项目入口文档；版本演进、验收覆盖和路线规划放在这里。

README is the project entry point. Version history, verification coverage, and roadmap live here.

---

## Current State / 当前状态

Current version: `v0.5.0 — Organization Runtime Foundation`

当前版本：`v0.5.0 — Organization Runtime Foundation`

| Boundary / 边界 | Status / 状态 |
|---|---|
| Organization Runtime | Organization-scoped ActorRegistry, capability enforcement, immutable Task state, atomic queue claim, and real ActorRuntime run / continue dispatch are available. / 已支持按组织隔离的 ActorRegistry、能力校验、不可变 Task 状态、原子队列 claim，以及真实 ActorRuntime run / continue 调度。 |
| Actor Messaging | FIFO Actor Inbox uses explicit queued / delivered / acknowledged states and validates both members and capabilities. / FIFO Actor Inbox 使用显式 queued / delivered / acknowledged 状态，并校验消息双方成员与能力。 |
| Organization Recovery | OrganizationSnapshot persists Registry, Task Queue, Inbox, Organization Trace, PendingRunSnapshot, and organization/run-partitioned Memory / Trace recovery state. / OrganizationSnapshot 可持久化 Registry、Task Queue、Inbox、Organization Trace、PendingRunSnapshot，以及按组织/运行分区的 Memory / Trace 恢复状态。 |
| Actor Kernel | Single-Actor loop supports ToolCall, tool approval, Skill wait_approval, human input, external event waiting, continue, Trace lifecycle, memory crystallization, store-backed runs, persistent Trace snapshots, persistent pending runs, coordinated recovery bundles, process-boundary recovery validation, and external event safety checks. / 单 Actor 闭环已支持 ToolCall、工具审批、Skill wait_approval、human input、external event waiting、continue、Trace 生命周期、记忆沉淀、Store-backed run、Trace 快照持久化、pending run 持久化、组合恢复包、进程边界恢复验证与外部事件安全校验。 |
| Waiting / Resume | Human input, Skill approval, ToolCall approval, and external events share explicit suspend / resume lifecycle Trace events. / human input、Skill approval、ToolCall approval 与 external event 已统一使用显式 suspend / resume 生命周期 Trace。 |
| External Event Safety | External events validate request id, event name, required correlation key, and lightweight payload schema before resume; invalid events preserve the pending run for retry. / 外部事件在 resume 前会校验 request id、event name、必需的 correlation key 与轻量 payload schema；非法事件会保留 pending run 供后续重试。 |
| Runtime Recovery | `RuntimeRecoveryBundle` coordinates PendingRunSnapshot, TraceSnapshot, and MemorySnapshot across all waiting kinds, including validated external events. / `RuntimeRecoveryBundle` 协调 PendingRunSnapshot、TraceSnapshot、MemorySnapshot，并覆盖通过校验的 external event 等待边界。 |
| Skill Runtime | Strict step parsing, transform execution, human_input waiting, wait_approval waiting, wait_external_event waiting, return output mapping, and explicit unsupported-step errors are available. / 已支持严格 step 解析、transform 执行、human_input 等待、wait_approval 等待、wait_external_event 等待、return output mapping、未支持步骤显式报错。 |

## Verification Matrix / 验收矩阵

| Command / 命令 | Purpose / 用途 |
|---|---|
| `npm run typecheck` | TypeScript type-check / 类型检查 |
| `npm run build` | Compile / 编译 |
| `npm run demo` | Actor Kernel demo, 26 checks / Actor Kernel Demo，26 条验收 |
| `npm run demo:memory` | Hybrid Memory demo, 12 checks / 混合记忆 Demo，12 条验收 |
| `npm run demo:memory:persistence` | MemorySnapshot demo, 10 checks / 记忆快照 Demo，10 条验收 |
| `npm run demo:memory:store` | MemoryStore demo, 8 checks / 记忆存储抽象 Demo，8 条验收 |
| `npm run demo:skill` | Skill Runtime Semantics demo, 10 checks / Skill Runtime 语义 Demo，10 条验收 |
| `npm run demo:runtime:store` | Runtime Store Binding demo, 10 checks / Runtime Store Binding Demo，10 条验收 |
| `npm run demo:trace:persistence` | Trace Persistence demo, 10 checks / Trace Persistence Demo，10 条验收 |
| `npm run demo:human:input` | Human Input Runtime demo, 10 checks / Human Input Runtime Demo，10 条验收 |
| `npm run demo:wait:approval` | Wait Approval Runtime demo, 10 checks / Wait Approval Runtime Demo，10 条验收 |
| `npm run demo:waiting:resume` | General Waiting / Resume demo, 15 checks / 通用等待恢复 Demo，15 条验收 |
| `npm run demo:pending:run` | Pending Run Persistence demo, 18 checks / Pending Run 持久化 Demo，18 条验收 |
| `npm run demo:recovery:bundle` | Runtime Recovery Bundle demo, 21 checks / Runtime Recovery Bundle Demo，21 条验收 |
| `npm run demo:recovery:cross-process` | Cross-process Recovery demo, 24 checks / 跨进程恢复 Demo，24 条验收 |
| `npm run demo:external:event` | External Event Runtime demo, 15 checks / External Event Runtime Demo，15 条验收 |
| `npm run demo:external:event:validation` | External Event Validation demo, 25 checks / External Event Validation Demo，25 条验收 |
| `npm run demo:organization` | Organization Runtime demo, 29 checks / Organization Runtime Demo，29 条验收 |
| `npm run demo:organization:recovery` | Organization Recovery demo, 23 checks / Organization Recovery Demo，23 条验收 |

---

## v0.5.0 — Organization Runtime Foundation

- Rebuilt v0.5.0 from the merged v0.4.5 main instead of continuing the diverged prototype branch.
- Added organization-scoped `ActorRegistry`, `TaskManager`, `ActorInbox`, and `OrganizationTrace` state; shared ActorRuntime Memory / Trace services are restored only through organization/run partitions.
- Registered Actors now retain executable `ActorConfig`, owned `SkillConfig` entries, lifecycle status, and organization capabilities.
- Enforced organization membership, active status, `allowed_skills`, Skill ownership, managed Actor registration, protected Inbox reads, event-specific continuation authority, and task/message capabilities.
- Added immutable `TaskManager` state with controlled created → assigned → queued → running → waiting / completed / failed transitions.
- Added synchronous single-runtime queue claim before ActorRuntime execution so concurrent dispatch cannot run one task twice.
- `OrganizationRuntime.dispatchNext()` now calls `ActorRuntime.run()` and binds the returned actorRunId to the Organization Task.
- `OrganizationRuntime.continueTask()` resumes the bound Actor run and maps waiting/completed/error results back to Task state.
- Added FIFO `ActorInbox` with explicit queued, delivered, and acknowledged states; unacknowledged delivered messages can be redelivered.
- Added organization-level Trace for permission, task, message, and recovery metadata without storing message/event payloads.
- Added `OrganizationSnapshot`, `OrganizationStore`, and `JsonOrganizationStore` with serialized in-instance mutations and atomic file replacement. Cross-process writers still require an external lock or single-writer deployment.
- Organization recovery persists Registry, Tasks, queue order, Inbox, Organization Trace, PendingRunSnapshot entries, filtered Actor Trace, and organization-scoped Memory.
- Added organization-partitioned Memory dump/restore and run-partitioned Trace dump/restore so restoring one organization preserves others.
- ActorRuntime now uses UUID run IDs, preventing process-local counters from colliding during organization recovery.
- Recovery performs complete Registry, Queue, Inbox, Organization Trace, Task/PendingRun/Actor Trace, and Memory partition preflight before mutating shared runtime state, with rollback on commit failure.
- Added `demo:organization` with 29 checks covering isolation, managed permissions, independent approval, pending-safe event routing, JSON-safe messages, dispatch input/identity binding, continuation, immutable state, queue claim, protected Inbox reads, and FIFO messaging.
- Added `demo:organization:recovery` with 23 checks covering true cold restore, pending-run continuation, queue/inbox restore, malformed snapshot rejection, serialized concurrent saves, and preservation/continuation of another organization's pending run.
- Added both Organization demos to CI and synchronized package / lockfile metadata to v0.5.0.

中文：

- 从已合并 v0.4.5 的 main 重建 v0.5.0，不再延续已分叉的原型分支。
- ActorRegistry、TaskManager、ActorInbox 与 OrganizationTrace 按 organizationId 隔离；共享的 ActorRuntime Memory / Trace 服务仅按组织/运行分区恢复。
- Actor 注册保存可执行 ActorConfig、SkillConfig、状态与组织能力，并强制校验成员、active、allowed_skills、Skill owner、manager 注册、Inbox 读取与 continuation 权限边界。
- Task 使用不可变受控状态机和同步队列 claim，避免并发 dispatch 重复执行。
- OrganizationRuntime 真实调用 ActorRuntime.run / continue，并保存 Task ↔ actorRunId 绑定。
- Actor Inbox 使用 queued / delivered / acknowledged FIFO 语义，未 ack 的 delivered message 可重新投递。
- Organization Trace 记录权限、任务、消息与恢复 metadata，不记录完整 payload。
- 新增 OrganizationSnapshot、OrganizationStore 与单实例写入串行化、原子文件替换的 JsonOrganizationStore；跨进程并发写仍需外部锁或单写者部署。
- 恢复包保存 Registry、Task Queue、Inbox、Organization Trace、PendingRunSnapshot，并按 organizationId / actorRunId 分区恢复 Memory 与 Actor Trace。
- ActorRuntime 改用 UUID run ID，避免跨进程恢复时的计数器碰撞。
- 恢复会预校验 Registry、Queue、Inbox、Organization Trace、Task/PendingRun/Actor Trace 与 Memory 分区，并在提交失败时回滚。
- 新增 Organization Runtime 29 条验收与 Organization Recovery 23 条验收，并接入 CI。
- package.json 与 package-lock.json 对齐到 v0.5.0。

---

## v0.4.5 — External Event Safety / Validation

- Added lightweight external event payload validation for `event_schema`.
- Require incoming `correlationKey` whenever the pending request has one, and reject missing or mismatched values.
- Added `external_event_validation_failed` Trace event type.
- External event validation now happens before `actor_run_resumed`.
- Failed external events preserve the original `waiting_external_event` pending run, record no resume/received/terminal event, and allow a later valid retry.
- External event Trace records metadata and `payloadSummary`, not full payload.
- `ExternalEventRequest` now preserves `eventSchema` through pending snapshots and recovery bundles.
- Hardened PendingRunSnapshot validation for `pendingKind: "external_event"`.
- Hardened RuntimeRecoveryBundle validation for external-event pending runs.
- Added `demo:external:event:validation` with 25 checks covering success, invalid payload, wrong or missing correlation, recovery-after-restore rejection, and valid retry after rejection.
- Added External Event Validation Demo to CI.
- Updated README and package metadata to v0.4.5.

中文：

- 新增基于 `event_schema` 的轻量外部事件 payload 校验。
- pending request 存在 `correlationKey` 时，incoming event 必须提供并匹配，缺失或不匹配都会被拒绝。
- 新增 `external_event_validation_failed` Trace 事件类型。
- external event 校验发生在 `actor_run_resumed` 之前。
- 校验失败会保留原 `waiting_external_event` pending run，不记录 resume / received / terminal 事件，并允许后续合法事件重试。
- 外部事件 Trace 只记录 metadata 和 `payloadSummary`，不记录完整 payload。
- `ExternalEventRequest` 现在会把 `eventSchema` 保留到 pending snapshot 与 recovery bundle 中。
- 加固 `pendingKind: "external_event"` 的 PendingRunSnapshot 校验。
- 加固 external-event pending run 的 RuntimeRecoveryBundle 校验。
- 新增 `demo:external:event:validation`，包含成功、非法 payload、错误或缺失 correlation、恢复后拒绝与拒绝后合法重试，共 25 条验收。
- CI 增加 External Event Validation Demo。
- README 与 package 元数据对齐到 v0.4.5。

---

## v0.4.4 — External Event Waiting

- Added `WaitExternalEventStep` / `wait_external_event` Skill step type.
- Added `waiting_external_event` status to ActorRunOutput, ActorRunTrace, and SkillState.
- Added `pendingExternalEvent` output shape with request id, step key, event name, correlation key, reason, and output key.
- Added `external_event_received` continue event payload.
- Added External Event Runtime helpers to build event requests and apply received events.
- ActorRuntime now pauses at `wait_external_event` and resumes after `continue(external_event_received)`.
- External event payloads are written into `state.steps[stepKey]` and `state.outputs[outputKey]`.
- Added `external_event_requested` and `external_event_received` Trace events.
- Trace records external event metadata but does not store the full payload by default.
- Extended PendingRunSnapshot / RuntimeRecoveryBundle support to `pendingKind: "external_event"`.
- Extended Cross-process Recovery Demo to cover external events.
- Added `demo:external:event` with 15 checks.
- Added External Event Runtime Demo to CI.
- Updated README and package metadata to v0.4.4.

## v0.4.3 — Cross-process Recovery Demo

- Added `demo:recovery:cross-process`.
- Added `cross-process-recovery.demo.ts` with parent / save / restore phases.
- Save phase runs to suspended state, creates RuntimeRecoveryBundle, and stores it in `JsonRuntimeRecoveryStore`.
- Restore phase starts from a fresh process-like runtime, registers tools, loads the bundle, restores Runtime / Trace / Memory, and continues to completion.
- Covered human_input, Skill wait_approval, ToolCall approval, and external_event across process-like boundaries.
- Added Cross Process Recovery Demo to CI.
- Updated README and package metadata to v0.4.3.

## v0.4.2 — Runtime Recovery Bundle

- Added `RuntimeRecoveryBundle` schema and `JsonRuntimeRecoveryStore`.
- Added `createRuntimeRecoveryBundle(actorRunId)` and `restoreRuntimeRecoveryBundle(bundle)`.
- Recovery bundles combine `PendingRunSnapshot`, `TraceSnapshot`, and `MemorySnapshot` without collapsing their boundaries.
- Restore order is MemorySnapshot → TraceSnapshot → PendingRunSnapshot.
- Added `demo:recovery:bundle` and CI coverage.

## v0.4.1 — Persistent Pending Runs

- Added `PendingRunSnapshot`, `PendingRunStore`, and `JsonPendingRunStore`.
- Added `ActorRuntime.dumpPendingRun()`, `restorePendingRun()`, and `clearRun()`.
- Covered human_input, Skill wait_approval, and ToolCall approval pending restore flows.
- Added `demo:pending:run` and CI coverage.

## v0.4.0 — General Waiting / Resume Model

- Added `actor_run_suspended` and `actor_run_resumed` Trace event types.
- Added `TraceLogger.suspendRun()` and `TraceLogger.resumeRun()`.
- Restricted `TraceLogger.endRun()` to terminal states: `completed` / `error`.
- Added `demo:waiting:resume` and CI coverage.

## v0.3.x — Earlier Actor Kernel Hardening

- v0.3.9: Wait Approval Runtime Semantics.
- v0.3.8: Human Input Runtime Semantics.
- v0.3.7: Trace Persistence.
- v0.3.6: Runtime Store Binding.
- v0.3.5: Skill Runtime Semantics.
- v0.3.4: Memory Store Abstraction.
- v0.3.3: Memory Persistence.
- v0.3.2: Memory Observability.
- v0.3.1: Memory Hardening.
- v0.3.0: Hybrid Memory System.
