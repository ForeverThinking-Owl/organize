# CHANGELOG / 更新日志

README 是项目入口文档；版本演进、验收覆盖和路线规划放在这里。

README is the project entry point. Version history, verification coverage, and roadmap live here.

---

## Current State / 当前状态

Current version: `v0.4.4 — External Event Waiting`

当前版本：`v0.4.4 — External Event Waiting`

| Boundary / 边界 | Status / 状态 |
|---|---|
| Actor Kernel | Single-Actor loop supports ToolCall, tool approval, Skill wait_approval, human input, external event waiting, continue, Trace lifecycle, memory crystallization, store-backed runs, persistent Trace snapshots, persistent pending runs, coordinated recovery bundles, and process-boundary recovery validation. / 单 Actor 闭环已支持 ToolCall、工具审批、Skill wait_approval、human input、external event waiting、continue、Trace 生命周期、记忆沉淀、Store-backed run、Trace 快照持久化、pending run 持久化、组合恢复包与进程边界恢复验证。 |
| Waiting / Resume | Human input, Skill approval, ToolCall approval, and external events share explicit suspend / resume lifecycle Trace events. / human input、Skill approval、ToolCall approval 与 external event 已统一使用显式 suspend / resume 生命周期 Trace。 |
| External Event | `wait_external_event` can pause a run, return `pendingExternalEvent`, resume through `continue(external_event_received)`, and feed event payload to later steps through `steps` / `outputs`. / `wait_external_event` 可暂停运行、返回 `pendingExternalEvent`、通过 `continue(external_event_received)` 恢复，并通过 `steps` / `outputs` 供后续步骤读取事件 payload。 |
| Runtime Recovery | `RuntimeRecoveryBundle` coordinates PendingRunSnapshot, TraceSnapshot, and MemorySnapshot across all waiting kinds, including external events. / `RuntimeRecoveryBundle` 协调 PendingRunSnapshot、TraceSnapshot、MemorySnapshot，并覆盖包括 external event 在内的等待边界。 |
| Pending Runs | Suspended runs can be dumped, saved, restored, and resumed through `continue()`. / suspended run 可导出、保存、恢复，并通过 `continue()` 继续执行。 |
| Skill Runtime | Strict step parsing, first-class transform execution, human_input waiting, wait_approval waiting, wait_external_event waiting, return output mapping, and explicit unsupported-step errors are available. / 已支持严格 step 解析、transform 一等执行、human_input 等待、wait_approval 等待、wait_external_event 等待、return output mapping、未支持步骤显式报错。 |

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

---

## Planned: v0.4.5 — External Event Safety / Validation

Goal: harden external event boundaries with schema validation, safer payload handling, and stricter correlation checks.

目标：通过 schema 校验、更安全的 payload 处理和更严格的 correlation 检查，加固 external event 边界。

Possible scope / 可能范围：

- Validate external event payloads against `event_schema`.
- Add correlation-key matching for incoming external events.
- Decide whether and how external payload summaries should appear in Trace.
- Keep all existing demos green.

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

中文：

- 新增 `WaitExternalEventStep` / `wait_external_event` Skill step 类型。
- `ActorRunOutput`、`ActorRunTrace`、`SkillState` 状态联合新增 `waiting_external_event`。
- 新增 `pendingExternalEvent` 输出结构，包含 request id、step key、event name、correlation key、reason、output key。
- 新增 `external_event_received` continue 事件 payload。
- 新增 External Event Runtime helper，用于创建事件请求与写入收到的事件。
- ActorRuntime 执行到 `wait_external_event` 时会暂停，并在 `continue(external_event_received)` 后恢复。
- 外部事件 payload 会写入 `state.steps[stepKey]` 与 `state.outputs[outputKey]`。
- 新增 `external_event_requested` 与 `external_event_received` Trace 事件。
- Trace 默认只记录外部事件元数据，不保存完整 payload。
- PendingRunSnapshot / RuntimeRecoveryBundle 扩展支持 `pendingKind: "external_event"`。
- Cross-process Recovery Demo 扩展覆盖 external event。
- 新增 `demo:external:event`，包含 15 条验收。
- CI 增加 External Event Runtime Demo。
- README 与 package 元数据对齐到 v0.4.4。

---

## v0.4.3 — Cross-process Recovery Demo

- Added `demo:recovery:cross-process`.
- Added `cross-process-recovery.demo.ts` with parent / save / restore phases.
- Save phase runs to suspended state, creates RuntimeRecoveryBundle, and stores it in `JsonRuntimeRecoveryStore`.
- Restore phase starts from a fresh process-like runtime, registers tools, loads the bundle, restores Runtime / Trace / Memory, and continues to completion.
- Covered human_input, Skill wait_approval, and ToolCall approval across process-like boundaries.
- Verified ToolCall approval can restore pending executor state and execute the pending ToolCall after tool executors are re-registered.
- Added Cross Process Recovery Demo to CI.
- Updated README and package metadata to v0.4.3.

## v0.4.2 — Runtime Recovery Bundle

- Added `RuntimeRecoveryBundle` schema: `runtime_recovery.bundle.v1`.
- Added `RuntimeRecoveryStore` interface: `load()`, `save()`, `delete()`, `list()`, `clear()`.
- Implemented `JsonRuntimeRecoveryStore` with JSON store snapshot validation.
- Added runtime recovery persistence helpers.
- Added `createRuntimeRecoveryBundle(actorRunId)` and `restoreRuntimeRecoveryBundle(bundle)`.
- Recovery bundles combine `PendingRunSnapshot`, `TraceSnapshot`, and `MemorySnapshot` without collapsing their boundaries.
- Restore order is MemorySnapshot → TraceSnapshot → PendingRunSnapshot.
- Covered human_input, Skill wait_approval, and ToolCall approval bundle restore flows.
- Added `demo:recovery:bundle` with 21 checks.
- Added Runtime Recovery Bundle Demo to CI.
- Updated README and package metadata to v0.4.2.

## v0.4.1 — Persistent Pending Runs

- Added `PendingRunSnapshot` schema: `pending_run.snapshot.v1`.
- Added `PendingRunStore` interface: `load()`, `save()`, `delete()`, `list()`, `clear()`.
- Implemented `JsonPendingRunStore` with JSON store snapshot validation.
- Added pending run persistence helpers.
- Added `ActorRuntime.dumpPendingRun()`, `restorePendingRun()`, and `clearRun()`.
- Added `ApprovalGate.restorePending()` and `clearPending()` so ToolCall approvals can be restored.
- Pending snapshots keep execution state separate from TraceSnapshot and MemorySnapshot.
- Covered human_input, Skill wait_approval, and ToolCall approval pending restore flows.
- Added `demo:pending:run` with 18 checks.
- Added Pending Run Persistence Demo to CI.
- Updated README and package metadata to v0.4.1.

## v0.4.0 — General Waiting / Resume Model

- Added `actor_run_suspended` and `actor_run_resumed` Trace event types.
- Added `TraceLogger.suspendRun()` and `TraceLogger.resumeRun()`.
- Restricted `TraceLogger.endRun()` to terminal states: `completed` / `error`.
- Human input waiting now records `actor_run_suspended(waitingKind=human_input)` instead of `actor_run_end(waiting_human_input)`.
- Skill wait approval now records `actor_run_suspended(waitingKind=skill_approval)` instead of `actor_run_end(waiting_approval)`.
- ToolCall approval now records `actor_run_suspended(waitingKind=tool_approval)` instead of `actor_run_end(waiting_approval)`.
- Continue paths now record `actor_run_resumed` for human input, Skill approval, and ToolCall approval.
- Updated human input and wait approval demos to validate suspend / resume lifecycle.
- Added `demo:waiting:resume` with 15 checks across all three waiting boundaries.
- Added General Waiting Resume Demo to CI.
- Updated README and package metadata to v0.4.0.

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
