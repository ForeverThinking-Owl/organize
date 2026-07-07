# CHANGELOG / 更新日志

README 是项目入口文档；版本演进、验收覆盖和路线规划放在这里。

README is the project entry point. Version history, verification coverage, and roadmap live here.

---

## Current State / 当前状态

Current version: `v0.3.5 — Skill Runtime Semantics`

当前版本：`v0.3.5 — Skill Runtime Semantics`

| Boundary / 边界 | Status / 状态 |
|---|---|
| Actor Kernel | Single-Actor loop supports ToolCall, approval, continue, Trace, memory crystallization, and stricter Skill semantics. / 单 Actor 闭环已支持 ToolCall、审批、continue、Trace、记忆沉淀与更严格的 Skill 语义。 |
| Skill Runtime | Strict step parsing, first-class transform execution, return output mapping, and explicit unsupported-step errors are available. / 已支持严格 step 解析、transform 一等执行、return output mapping、未支持步骤显式报错。 |
| LLM Gateway | Supports mock / real structured-output mode. / 支持 mock / real 结构化输出模式。 |
| Policy / Approval | Tool permission, autonomy level, and before_call approval are wired in. / Tool 权限、自主等级、before_call 审批已接入。 |
| Hybrid Memory | Candidate, record, policy, extraction, retrieval, and view are wired in. / 候选、记录、策略、提取、检索与视图已接入。 |
| Memory Dedup | Stable fingerprints prevent duplicate writes across repeated runs. / 稳定 fingerprint 防止重复实践重复写入。 |
| Memory Observability | `memory_write_summary` and `lastWriteSummary` are available. / 已有写入摘要 Trace 和最近写入统计。 |
| Memory Persistence | JSON snapshot dump / restore is verified. / JSON 快照 dump / restore 已验证。 |
| Memory Store | `MemoryStore` and `JsonMemoryStore` are verified. / `MemoryStore` 与 `JsonMemoryStore` 已验证。 |

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

---

## Planned: v0.3.6 — Runtime Store Binding

Goal: make store-backed runtime usage more natural without changing the MemoryStore boundary.

目标：在不改变 MemoryStore 边界的前提下，让运行时使用持久化 Store 更自然。

Possible scope / 可能范围：

- Runtime helper or wrapper that loads MemoryStore before a run and saves after completion.
- Trace event for memory store load/save lifecycle.
- Store-backed demo that runs across separate service clear/restore boundaries.
- Keep existing Skill, Actor, memory, persistence, and store demos green.

中文可能范围：

- 增加运行时 helper 或 wrapper，在运行前 load MemoryStore，运行后 save。
- 增加 memory store load/save 生命周期 Trace。
- 新增基于 Store 的跨 clear/restore 运行 Demo。
- 保持现有 Skill、Actor、memory、persistence、store demos 全部通过。

---

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

中文：

- 模板解析支持 `context`、`steps`、`outputs` 三个根路径。
- 完整占位符保留对象、布尔值、数字等原始类型。
- 新增严格 `SkillConfig` step 解析。
- 未知 step type 显式失败，不再静默转成 `return`。
- `ActorRuntime` 正式执行 `transform` 步骤。
- `ReturnStep.outputMapping` 支持生成最终输出。
- `human_input`、`wait_approval`、`end` 等未支持步骤显式处理。
- 新增 `demo:skill`，包含 10 条验收。
- CI 增加 Skill Runtime Semantics Demo。
- README 与 package 元数据对齐到 v0.3.5。

---

## v0.3.4 — Memory Store Abstraction

- Added `MemoryStore` interface: `load()`, `save()`, `clear()`.
- Implemented `JsonMemoryStore`.
- Kept `saveMemorySnapshot()` / `loadMemorySnapshot()` helpers.
- Added `saveMemoryService()` / `loadMemoryService()` helpers.
- Added `demo:memory:store` with 8 checks.
- Added Memory Store Demo to CI.
- Updated README and package metadata to v0.3.4.

中文：

- 新增 `MemoryStore` 接口：`load()`、`save()`、`clear()`。
- 实现 `JsonMemoryStore`。
- 保留 `saveMemorySnapshot()` / `loadMemorySnapshot()` helper。
- 新增 `saveMemoryService()` / `loadMemoryService()` helper。
- 新增 `demo:memory:store`，包含 8 条验收。
- CI 增加 Memory Store Demo。
- README 与 package 元数据对齐到 v0.3.4。

## v0.3.3 — Memory Persistence

- Added `MemorySnapshot` schema: `memory.snapshot.v1`.
- Added JSON snapshot save/load helpers.
- Added `MemoryService.dumpSnapshot()` / `restoreSnapshot()`.
- Rebuilt fingerprints and counters after restore.
- Added `demo:memory:persistence` with 10 checks.
- Added Memory Persistence Demo to CI.

中文：

- 新增 `MemorySnapshot` schema：`memory.snapshot.v1`。
- 新增 JSON 快照保存/加载 helper。
- 新增 `MemoryService.dumpSnapshot()` / `restoreSnapshot()`。
- restore 后重建 fingerprint 和计数器。
- 新增 `demo:memory:persistence`，包含 10 条验收。
- CI 增加 Memory Persistence Demo。

## v0.3.2 — Memory Observability

- Extracted shared memory fingerprint utilities.
- Added `MemoryWriteSummary`.
- Added `memory_write_summary` Trace event.
- Exposed `lastWriteSummary` through `MemoryService.getStats()`.
- Extended memory demo to 12 checks.
- Added build step to CI.

中文：

- 抽出共享 memory fingerprint 工具。
- 新增 `MemoryWriteSummary`。
- 新增 `memory_write_summary` Trace 事件。
- `MemoryService.getStats()` 暴露 `lastWriteSummary`。
- memory demo 扩展到 12 条验收。
- CI 增加 build。

## v0.3.1 — Memory Hardening

- Removed dynamic timestamp from `run_summary.content`.
- Hardened MemoryCandidate / MemoryRecord deduplication.
- Stabilized memory retrieval ordering.
- Extended `demo:memory` to 10 checks.
- Added repeated-practice regression check: `before=8, after=8`.

中文：

- 移除 `run_summary.content` 中的动态时间戳。
- 加固 MemoryCandidate / MemoryRecord 去重。
- 稳定 memory retrieval 排序。
- `demo:memory` 扩展到 10 条验收。
- 新增重复实践回归检查：`before=8, after=8`。

## v0.3.0 — Hybrid Memory System

- Added `MemoryRecord`, `MemoryCandidate`, and `HybridMemoryView`.
- Added `MemoryPolicy` and `MemoryExtractor`.
- Refactored `MemoryService` for retrieval and accepted memories.
- Wired hybrid memory retrieval into `ActorContextBuilder`.
- Added `memory_retrieved` and `memory_accepted` Trace events.
- Added `hybrid-memory.demo.ts` and `demo:memory`.

中文：

- 新增 `MemoryRecord`、`MemoryCandidate`、`HybridMemoryView`。
- 新增 `MemoryPolicy` 与 `MemoryExtractor`。
- 重构 `MemoryService`，支持检索与 accepted memories。
- `ActorContextBuilder` 接入混合记忆检索。
- 新增 `memory_retrieved` 与 `memory_accepted` Trace 事件。
- 新增 `hybrid-memory.demo.ts` 与 `demo:memory`。
