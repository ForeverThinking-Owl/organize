# CHANGELOG / 更新日志

README 是项目入口文档；版本演进、验收覆盖和路线规划放在这里。

README is the project entry point. Version history, verification coverage, and roadmap live here.

---

## Current State / 当前状态

Current version: `v0.3.9 — Wait Approval Runtime Semantics`

当前版本：`v0.3.9 — Wait Approval Runtime Semantics`

| Boundary / 边界 | Status / 状态 |
|---|---|
| Actor Kernel | Single-Actor loop supports ToolCall, tool approval, Skill wait_approval, human input, continue, Trace, memory crystallization, store-backed runs, and persistent Trace snapshots. / 单 Actor 闭环已支持 ToolCall、工具审批、Skill wait_approval、human input、continue、Trace、记忆沉淀、Store-backed run 与 Trace 快照持久化。 |
| Skill Runtime | Strict step parsing, first-class transform execution, human_input waiting, wait_approval waiting, return output mapping, and explicit unsupported-step errors are available. / 已支持严格 step 解析、transform 一等执行、human_input 等待、wait_approval 等待、return output mapping、未支持步骤显式报错。 |
| LLM Gateway | Supports mock / real structured-output mode. / 支持 mock / real 结构化输出模式。 |
| Policy / Approval | Tool permission, autonomy level, before_call approval, and Skill-step approval are wired in. / Tool 权限、自主等级、before_call 审批与 Skill-step 审批已接入。 |
| Hybrid Memory | Candidate, record, policy, extraction, retrieval, and view are wired in. / 候选、记录、策略、提取、检索与视图已接入。 |
| Memory Store | `MemoryStore`, `JsonMemoryStore`, and Runtime Store Binding are verified. / `MemoryStore`、`JsonMemoryStore` 与 Runtime Store Binding 已验证。 |
| Trace Persistence | `TraceSnapshot`, `TraceStore`, `JsonTraceStore`, and TraceLogger dump / restore are verified. / `TraceSnapshot`、`TraceStore`、`JsonTraceStore` 与 TraceLogger dump / restore 已验证。 |
| Human Input | `human_input` can pause a run, return `pendingHumanInput`, resume through `continue()`, and feed later steps through `steps` / `outputs`. / `human_input` 可暂停运行、返回 `pendingHumanInput`、通过 `continue()` 恢复，并通过 `steps` / `outputs` 供后续步骤读取。 |
| Wait Approval | `wait_approval` can pause a run, return `pendingApproval`, resume through `continue()`, and feed later steps through `steps` / `outputs`. / `wait_approval` 可暂停运行、返回 `pendingApproval`、通过 `continue()` 恢复，并通过 `steps` / `outputs` 供后续步骤读取。 |

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

---

## Planned: v0.4.0 — General Waiting / Resume Model

Goal: unify the waiting boundaries that now exist for human input, Skill-step approval, and ToolCall approval into a clearer run lifecycle model.

目标：把 human input、Skill-step approval、ToolCall approval 已经形成的等待边界整理成更清晰的运行生命周期模型。

Possible scope / 可能范围：

- Add explicit suspend / resume Trace events instead of overloading actor_run_end for waiting states.
- Normalize pending wait output shapes where appropriate.
- Clarify which wait types can be persisted and resumed across process boundaries.
- Keep all existing demos green.

中文可能范围：

- 新增显式 suspend / resume Trace 事件，避免只用 actor_run_end 表示等待态。
- 在合适范围内规范 pending wait 输出结构。
- 明确哪些等待类型可以跨进程持久化并恢复。
- 保持现有 demos 全部通过。

---

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

中文：

- `WaitApprovalStep` 扩展为可选 `approvalRequestId`、必填 `reason`、必填 `outputKey`。
- 新增带 `approvalKind: "skill_step"` 的 `SkillApprovalRequest`。
- 新增 Wait Approval Runtime helper，用于创建审批请求与写入审批决策。
- ActorRuntime 执行到 `wait_approval` 时会以 `waiting_approval` 暂停，并在 `continue(approval_decision)` 后恢复。
- Skill-step 审批决策会写入 `state.steps[stepKey]` 与 `state.outputs[outputKey]`。
- 复用 `approval_requested` 与 `approval_decided` Trace 事件，并带上 `approvalKind: "skill_step"`。
- 保留现有 ToolCall approval 行为，并在 pending output 中标记 `approvalKind: "tool_call"`。
- 新增 `demo:wait:approval`，包含 10 条验收。
- CI 增加 Wait Approval Runtime Demo。
- README 与 package 元数据对齐到 v0.3.9。

---

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
