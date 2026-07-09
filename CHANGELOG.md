# CHANGELOG / 更新日志

README 是项目入口文档；版本演进、验收覆盖和路线规划放在这里。

README is the project entry point. Version history, verification coverage, and roadmap live here.

---

## Current State / 当前状态

Current version: `v0.4.5 — External Event Safety / Validation`

当前版本：`v0.4.5 — External Event Safety / Validation`

| Boundary / 边界 | Status / 状态 |
|---|---|
| Actor Kernel | Single-Actor loop supports ToolCall, tool approval, Skill wait_approval, human input, external event waiting, continue, Trace lifecycle, memory crystallization, store-backed runs, persistent Trace snapshots, persistent pending runs, coordinated recovery bundles, process-boundary recovery validation, and external event safety checks. / 单 Actor 闭环已支持 ToolCall、工具审批、Skill wait_approval、human input、external event waiting、continue、Trace 生命周期、记忆沉淀、Store-backed run、Trace 快照持久化、pending run 持久化、组合恢复包、进程边界恢复验证与外部事件安全校验。 |
| Waiting / Resume | Human input, Skill approval, ToolCall approval, and external events share explicit suspend / resume lifecycle Trace events. / human input、Skill approval、ToolCall approval 与 external event 已统一使用显式 suspend / resume 生命周期 Trace。 |
| External Event Safety | External events validate request id, event name, correlation key when provided, and lightweight payload schema before resume. / 外部事件在 resume 前会校验 request id、event name、提供时的 correlation key，以及轻量 payload schema。 |
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
| `npm run demo:external:event:validation` | External Event Validation demo, 18 checks / External Event Validation Demo，18 条验收 |

---

## Planned: v0.5.0 — Organization Runtime Foundation

Goal: introduce the first organization layer above ActorRuntime: organization model, actor registry, task delegation, actor messages, and organization trace.

目标：在 ActorRuntime 之上引入第一层组织运行时：组织模型、Actor Registry、任务委派、Actor Message 与 Organization Trace。

---

## v0.4.5 — External Event Safety / Validation

- Added lightweight external event payload validation for `event_schema`.
- Added correlation-key mismatch validation when incoming events provide `correlationKey`.
- Added `external_event_validation_failed` Trace event type.
- External event validation now happens before `actor_run_resumed`.
- Failed external events end the run with `error` and do not record `actor_run_resumed` or `external_event_received`.
- External event Trace records metadata and `payloadSummary`, not full payload.
- `ExternalEventRequest` now preserves `eventSchema` through pending snapshots and recovery bundles.
- Hardened PendingRunSnapshot validation for `pendingKind: "external_event"`.
- Hardened RuntimeRecoveryBundle validation for external-event pending runs.
- Added `demo:external:event:validation` with 18 checks covering success, invalid payload, wrong correlation, and recovery-after-restore rejection.
- Added External Event Validation Demo to CI.
- Updated README and package metadata to v0.4.5.

中文：

- 新增基于 `event_schema` 的轻量外部事件 payload 校验。
- 当外部事件提供 `correlationKey` 时，校验 correlation-key mismatch。
- 新增 `external_event_validation_failed` Trace 事件类型。
- external event 校验发生在 `actor_run_resumed` 之前。
- 校验失败的外部事件会以 `error` 结束 run，且不会记录 `actor_run_resumed` 或 `external_event_received`。
- 外部事件 Trace 只记录 metadata 和 `payloadSummary`，不记录完整 payload。
- `ExternalEventRequest` 现在会把 `eventSchema` 保留到 pending snapshot 与 recovery bundle 中。
- 加固 `pendingKind: "external_event"` 的 PendingRunSnapshot 校验。
- 加固 external-event pending run 的 RuntimeRecoveryBundle 校验。
- 新增 `demo:external:event:validation`，包含成功、非法 payload、错误 correlation、恢复后拒绝四类共 18 条验收。
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
