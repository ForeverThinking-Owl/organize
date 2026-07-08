# CHANGELOG / 更新日志

README 是项目入口文档；版本演进、验收覆盖和路线规划放在这里。

README is the project entry point. Version history, verification coverage, and roadmap live here.

---

## Current State / 当前状态

Current version: `v0.4.3 — Cross-process Recovery Demo`

当前版本：`v0.4.3 — Cross-process Recovery Demo`

| Boundary / 边界 | Status / 状态 |
|---|---|
| Actor Kernel | Single-Actor loop supports ToolCall, tool approval, Skill wait_approval, human input, continue, Trace lifecycle, memory crystallization, store-backed runs, persistent Trace snapshots, persistent pending runs, coordinated recovery bundles, and process-boundary recovery validation. / 单 Actor 闭环已支持 ToolCall、工具审批、Skill wait_approval、human input、continue、Trace 生命周期、记忆沉淀、Store-backed run、Trace 快照持久化、pending run 持久化、组合恢复包与进程边界恢复验证。 |
| Runtime Recovery | `RuntimeRecoveryBundle` coordinates PendingRunSnapshot, TraceSnapshot, and MemorySnapshot, and the cross-process demo verifies save in one process-like phase and restore / continue in another. / `RuntimeRecoveryBundle` 协调 PendingRunSnapshot、TraceSnapshot、MemorySnapshot，cross-process demo 验证一个 process-like 阶段保存，另一个阶段恢复并继续执行。 |
| Waiting / Resume | Human input, Skill approval, and ToolCall approval share explicit suspend / resume lifecycle Trace events. / human input、Skill approval、ToolCall approval 已统一使用显式 suspend / resume 生命周期 Trace。 |
| Pending Runs | Suspended runs can be dumped, saved, restored, and resumed through `continue()`. / suspended run 可导出、保存、恢复，并通过 `continue()` 继续执行。 |
| Skill Runtime | Strict step parsing, first-class transform execution, human_input waiting, wait_approval waiting, return output mapping, and explicit unsupported-step errors are available. / 已支持严格 step 解析、transform 一等执行、human_input 等待、wait_approval 等待、return output mapping、未支持步骤显式报错。 |
| Policy / Approval | Tool permission, autonomy level, before_call approval, and Skill-step approval are wired in. / Tool 权限、自主等级、before_call 审批与 Skill-step 审批已接入。 |
| Memory Store | `MemoryStore`, `JsonMemoryStore`, and Runtime Store Binding are verified. / `MemoryStore`、`JsonMemoryStore` 与 Runtime Store Binding 已验证。 |
| Trace Persistence | `TraceSnapshot`, `TraceStore`, `JsonTraceStore`, and TraceLogger dump / restore are verified. / `TraceSnapshot`、`TraceStore`、`JsonTraceStore` 与 TraceLogger dump / restore 已验证。 |

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
| `npm run demo:recovery:cross-process` | Cross-process Recovery demo, 18 checks / 跨进程恢复 Demo，18 条验收 |

---

## Planned: v0.4.4 — External Event Waiting

Goal: add a new waiting boundary for external events while reusing the lifecycle, recovery, and persistence foundations built in v0.4.0–v0.4.3.

目标：新增外部事件等待边界，并复用 v0.4.0–v0.4.3 已完成的 lifecycle、recovery 与 persistence 基础。

Possible scope / 可能范围：

- Define `wait_external_event` Skill step semantics.
- Add pending external event request / response shape.
- Ensure pending external-event runs can enter suspend / resume and recovery bundle flows.
- Keep all existing demos green.

中文可能范围：

- 定义 `wait_external_event` Skill step 语义。
- 新增 pending external event request / response 结构。
- 确保外部事件等待 run 可以接入 suspend / resume 与 recovery bundle 流程。
- 保持现有 demos 全部通过。

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

中文：

- 新增 `demo:recovery:cross-process`。
- 新增 `cross-process-recovery.demo.ts`，包含 parent / save / restore 三种模式。
- save phase 运行到 suspended，创建 RuntimeRecoveryBundle，并保存到 `JsonRuntimeRecoveryStore`。
- restore phase 从全新 process-like runtime 启动，重新注册工具，加载 bundle，恢复 Runtime / Trace / Memory，并继续执行到 completed。
- 覆盖 human_input、Skill wait_approval、ToolCall approval 三类进程边界恢复。
- 验证 ToolCall approval 可以恢复 pending executor state，并在重新注册 tool executor 后执行 pending ToolCall。
- CI 增加 Cross Process Recovery Demo。
- README 与 package 元数据对齐到 v0.4.3。

---

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

## v0.3.9 — Wait Approval Runtime Semantics

- Extended `WaitApprovalStep` with optional `approvalRequestId`, required `reason`, and required `outputKey`.
- Added `SkillApprovalRequest` with `approvalKind: "skill_step"`.
- Added Wait Approval Runtime helpers to build requests and apply approval decisions.
- ActorRuntime now pauses at `wait_approval` with `waiting_approval` and resumes after `continue(approval_decision)`.
- Skill-step approval decisions are written into `state.steps[stepKey]` and `state.outputs[outputKey]`.
- Reused `approval_requested` and `approval_decided` Trace events with `approvalKind: "skill_step"`.
- Preserved existing ToolCall approval behavior with `approvalKind: "tool_call"` in pending output.
- Added `demo:wait:approval` with 10 checks.
- Added Wait Approval Runtime Demo to CI.
- Updated README and package metadata to v0.3.9.

## v0.3.8 — Human Input Runtime Semantics

- Added `waiting_human_input` to ActorRunOutput / ActorRunTrace / SkillState status unions.
- Added `pendingHumanInput` output shape with request id, step key, prompt, and output key.
- Added `human_input_response` continue event payload.
- Added Human Input Runtime helpers to build requests and apply responses.
- ActorRuntime now pauses at `human_input` and resumes after `continue()`.
- Human responses are written into `state.steps[stepKey]` and `state.outputs[outputKey]`.
- Added `human_input_requested` and `human_input_received` Trace events.
- Trace records human input metadata but does not store the full response value by default.
- Added `demo:human:input` with 10 checks.
- Added Human Input Runtime Demo to CI.
- Updated README and package metadata to v0.3.8.

## v0.3.7 — Trace Persistence

- Added `TraceSnapshot` schema: `trace.snapshot.v1`.
- Added `TraceStore` interface: `load()`, `save()`, `clear()`.
- Implemented `JsonTraceStore` with JSON snapshot validation.
- Added `saveTraceLogger()` / `loadTraceLogger()` helpers.
- Added `TraceLogger.dumpSnapshot()` / `restoreSnapshot()`.
- Restored Trace event counter from snapshot event IDs after restore.
- Added `demo:trace:persistence` with 10 checks.
- Added Trace Persistence Demo to CI.
- Updated README and package metadata to v0.3.7.

## v0.3.6 — Runtime Store Binding

- Added optional `runtimeOptions.memoryStore` to `ActorRuntime.run()`.
- Runtime now loads `MemoryStore` before `ActorContext` construction so restored memories can participate in retrieval.
- Runtime now saves `MemoryStore` after memory generation and `memory_write_summary`.
- Added `memory_store_load`, `memory_store_save`, and `memory_store_error` Trace event types.
- Added Runtime MemoryStore helper functions for load/save lifecycle binding.
- Preserved existing pure in-memory behavior when no `memoryStore` is provided.
- Added `demo:runtime:store` with 10 checks.
- Added Runtime Store Binding Demo to CI.
- Updated README and package metadata to v0.3.6.

## v0.3.5 — Skill Runtime Semantics

- Added state-aware template resolution for `context`, `steps`, and `outputs`.
- Full-placeholder templates now preserve raw values such as objects, booleans, and numbers.
- Added strict `SkillConfig` step parsing.
- Unknown step types now fail explicitly instead of silently becoming `return`.
- Added first-class `transform` execution in `ActorRuntime`.
- Added `ReturnStep.outputMapping` support for final output generation.
- Added explicit unsupported-step handling for `human_input`, `wait_approval`, and `end`.
- Added `demo:skill` with 10 checks.
- Added Skill Runtime Semantics Demo to CI.
- Updated README and package metadata to v0.3.5.

## v0.3.4 — Memory Store Abstraction

- Added `MemoryStore` interface: `load()`, `save()`, `clear()`.
- Implemented `JsonMemoryStore`.
- Kept `saveMemorySnapshot()` / `loadMemorySnapshot()` helpers.
- Added `saveMemoryService()` / `loadMemoryService()` helpers.
- Added `demo:memory:store` with 8 checks.
- Added Memory Store Demo to CI.
- Updated README and package metadata to v0.3.4.

## v0.3.3 — Memory Persistence

- Added `MemorySnapshot` schema: `memory.snapshot.v1`.
- Added JSON snapshot save/load helpers.
- Added `MemoryService.dumpSnapshot()` / `restoreSnapshot()`.
- Rebuilt fingerprints and counters after restore.
- Added `demo:memory:persistence` with 10 checks.
- Added Memory Persistence Demo to CI.

## v0.3.2 — Memory Observability

- Extracted shared memory fingerprint utilities.
- Added `MemoryWriteSummary`.
- Added `memory_write_summary` Trace event.
- Exposed `lastWriteSummary` through `MemoryService.getStats()`.
- Extended memory demo to 12 checks.
- Added build step to CI.

## v0.3.1 — Memory Hardening

- Removed dynamic timestamp from `run_summary.content`.
- Hardened MemoryCandidate / MemoryRecord deduplication.
- Stabilized memory retrieval ordering.
- Extended `demo:memory` to 10 checks.
- Added repeated-practice regression check: `before=8, after=8`.

## v0.3.0 — Hybrid Memory System

- Added `MemoryRecord`, `MemoryCandidate`, and `HybridMemoryView`.
- Added `MemoryPolicy` and `MemoryExtractor`.
- Refactored `MemoryService` for retrieval and accepted memories.
- Wired hybrid memory retrieval into `ActorContextBuilder`.
- Added `memory_retrieved` and `memory_accepted` Trace events.
- Added `hybrid-memory.demo.ts` and `demo:memory`.
