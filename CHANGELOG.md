# CHANGELOG / 更新日志

README 是项目入口文档；版本演进、验收覆盖和路线规划放在这里。

README is the project entry point. Version history, verification coverage, and roadmap live here.

---

## Current State / 当前状态

Current version: `v0.6.0 — Governed Actor Handoff`

当前版本：`v0.6.0 — Governed Actor Handoff`

| Boundary / 边界 | Status / 状态 |
|---|---|
| Organization Runtime | Organization-scoped ActorRegistry, governed terminal handoff, immutable task lineage, correlated request/response messages, bounded dispatch-until-idle, capability enforcement, and real ActorRuntime run / continue dispatch are available. / 已支持按组织隔离的 ActorRegistry、受治理的终态 handoff、不可变任务 lineage、关联 request/response 消息、有界 dispatch-until-idle、能力校验，以及真实 ActorRuntime run / continue 调度。 |
| Actor Messaging | FIFO Actor Inbox uses explicit queued / delivered / acknowledged states; internal handoff messages have canonical correlation / causation while public send cannot forge them. / FIFO Actor Inbox 使用显式 queued / delivered / acknowledged 状态；内部 handoff 消息具有 canonical correlation / causation，公开发送接口不能伪造这些字段。 |
| Organization Recovery | OrganizationSnapshot v3 persists Registry, task lineage, Handoff Registry, Inbox, Organization Trace, PendingRunSnapshot, and partitioned Memory / Trace; restore preflight validates their deep cross-references and purely migrates valid v2 checkpoints. / OrganizationSnapshot v3 可持久化 Registry、任务 lineage、Handoff Registry、Inbox、Organization Trace、PendingRunSnapshot 与分区 Memory / Trace；恢复 preflight 深度校验交叉引用，并纯函数迁移合法 v2 checkpoint。 |
| Actor Kernel | Single-Actor loop supports ToolCall, approvals, human input, external events, continue, terminal `handoff_requested`, Trace lifecycle v2, memory crystallization, store-backed runs, persistent pending runs, and coordinated recovery bundles. / 单 Actor 闭环已支持 ToolCall、审批、human input、external event、continue、终态 `handoff_requested`、Trace 生命周期 v2、记忆沉淀、Store-backed run、pending run 持久化与组合恢复包。 |
| Waiting / Resume | Human input, Skill approval, ToolCall approval, and external events validate before resume; invalid continuations preserve pending state for a valid retry. / human input、Skill approval、ToolCall approval 与 external event 都在 resume 前校验；非法 continuation 会保留 pending state 供合法重试。 |
| Tool Governance | Only `beforeCall` approval is implemented; Tool definitions declaring `afterCall` or `beforeWriteback` fail registration before any executor can run. / 当前只实现 `beforeCall` 审批；声明 `afterCall` 或 `beforeWriteback` 的 Tool 会在任何 executor 执行前注册失败。 |
| External Event Safety | Configured correlation keys and every interpolation token must resolve to non-empty scalars without unresolved templates before suspension; incoming events then validate request id, event name, correlation, and payload schema. / 已声明的 correlation 及其每个插值 token 都必须在 suspend 前解析为无残留模板的非空标量；入站事件随后校验 request id、event name、correlation 与 payload schema。 |
| Runtime Recovery | `RuntimeRecoveryBundle` coordinates PendingRunSnapshot, TraceSnapshot, and MemorySnapshot across all waiting kinds, including validated external events. / `RuntimeRecoveryBundle` 协调 PendingRunSnapshot、TraceSnapshot、MemorySnapshot，并覆盖通过校验的 external event 等待边界。 |
| Skill Runtime | Strict step parsing, transform execution, waiting steps, return mapping, and a final-only explicit handoff step with JSON-safe input mapping are available. / 已支持严格 step 解析、transform 执行、等待步骤、return mapping，以及仅可位于末步且具有 JSON-safe input mapping 的显式 handoff。 |

## Verification Matrix / 验收矩阵

| Command / 命令 | Purpose / 用途 |
|---|---|
| `npm run typecheck` | TypeScript type-check / 类型检查 |
| `npm run build` | Compile / 编译 |
| `npm run start:dist` | Compiled output runtime smoke / 编译产物运行冒烟测试 |
| `npm run start:dist:handoff` | Compiled terminal handoff smoke / 编译产物 handoff 冒烟测试 |
| `npm run start:dist:organization:handoff` | Compiled governed Organization handoff smoke / 编译产物受治理 Organization handoff 冒烟测试 |
| `npm run demo` | Actor Kernel demo, 26 checks / Actor Kernel Demo，26 条验收 |
| `npm run demo:memory` | Hybrid Memory demo, 12 checks / 混合记忆 Demo，12 条验收 |
| `npm run demo:memory:persistence` | MemorySnapshot demo, 10 checks / 记忆快照 Demo，10 条验收 |
| `npm run demo:memory:store` | MemoryStore demo, 9 checks / 记忆存储抽象 Demo，9 条验收 |
| `npm run demo:skill` | Skill Runtime Semantics demo, 10 checks / Skill Runtime 语义 Demo，10 条验收 |
| `npm run demo:runtime:store` | Runtime Store Binding demo, 13 checks / Runtime Store Binding Demo，13 条验收 |
| `npm run demo:trace:persistence` | Trace Persistence demo, 15 checks / Trace Persistence Demo，15 条验收 |
| `npm run demo:human:input` | Human Input Runtime demo, 10 checks / Human Input Runtime Demo，10 条验收 |
| `npm run demo:wait:approval` | Wait Approval Runtime demo, 10 checks / Wait Approval Runtime Demo，10 条验收 |
| `npm run demo:waiting:resume` | General Waiting / Resume demo, 15 checks / 通用等待恢复 Demo，15 条验收 |
| `npm run demo:pending:run` | Pending Run Persistence demo, 28 checks / Pending Run 持久化 Demo，28 条验收 |
| `npm run demo:recovery:bundle` | Runtime Recovery Bundle demo, 30 checks / Runtime Recovery Bundle Demo，30 条验收 |
| `npm run demo:recovery:cross-process` | Cross-process Recovery demo, 24 checks / 跨进程恢复 Demo，24 条验收 |
| `npm run demo:external:event` | External Event Runtime demo, 15 checks / External Event Runtime Demo，15 条验收 |
| `npm run demo:external:event:validation` | External Event Validation demo, 69 checks / External Event Validation Demo，69 条验收 |
| `npm run demo:tool:approval:fail-closed` | Tool Approval Fail-Closed demo, 15 checks / Tool Approval Fail-Closed Demo，15 条验收 |
| `npm run demo:continuation:validation` | Retry-safe continuation demo, 81 checks / Retry-safe continuation Demo，81 条验收 |
| `npm run demo:organization` | Organization Runtime demo, 32 checks / Organization Runtime Demo，32 条验收 |
| `npm run demo:organization:recovery` | Organization Recovery demo, 44 checks / Organization Recovery Demo，44 条验收 |
| `npm run demo:organization:pending:recovery` | Four pending kinds recovery demo, 21 checks / 四类 pending 恢复 Demo，21 条验收 |
| `npm run demo:organization:lifecycle` | In-flight lifecycle hardening demo, 19 checks / 运行中生命周期加固 Demo，19 条验收 |
| `npm run demo:handoff:runtime` | Terminal Actor Handoff demo, 26 checks / 终态 Actor Handoff Demo，26 条验收 |
| `npm run demo:organization:handoff` | Governed Organization Handoff demo, 43 checks / 受治理 Organization Handoff Demo，43 条验收 |
| `npm run demo:organization:handoff:recovery` | Handoff Recovery v3 and migration demo, 53 checks / Handoff Recovery v3 与迁移 Demo，53 条验收 |

---

## v0.6.0 — Governed Actor Handoff

- Add a strict final-only Skill `handoff` step with explicit target Actor / Skill, reason, JSON-safe input mapping, and a terminal `handoff_requested` ActorRuntime result. A handoff is never a PendingRun and never emits `final_output`.
- Upgrade Actor Trace to `trace.snapshot.v2`; valid v1 snapshots normalize purely, while v2 lifecycle validation binds exactly one handoff event to a terminal handoff run.
- Materialize an accepted handoff atomically as a `delegated` source task, one depth-1 queued child task, one fingerprinted registry record, and one canonical correlated `task_request`.
- Enforce source `task:delegate` / `message:receive`, target `task:execute` / `message:receive`, active membership, explicit Skill ownership, no self-handoff, and `MAX_HANDOFF_DEPTH = 1` before leaving any organization artifact.
- Deliver and acknowledge the exact request before child execution. A terminal child produces exactly one correlated / caused `task_response`; the source task stays delegated and its terminal Actor run is never resumed.
- Add bounded `dispatchUntilIdle()` orchestration with explicit idle / dispatch-limit results and blocked waiting-task reporting. It is not a daemon or durable queue worker.
- Upgrade Organization snapshot/store to v3 with task lineage and Handoff Registry state. Recovery deeply cross-validates Task, Actor/Skill, handoff fingerprint, canonical messages, Organization Trace, Actor Trace, PendingRun, Memory, and response lifecycle before commit.
- Add a pure v2-to-v3 Organization migration plus nested Trace v1-to-v2 normalization. Mixed-version envelopes, future versions, and legacy snapshots containing v3-only handoff metadata fail closed.
- Preserve at-least-once recovery semantics. Stable IDs and fingerprints make artifacts idempotent inside one loaded aggregate, but crash-safe exactly-once still requires a host transactional outbox or durable idempotency store.
- Add dedicated Runtime (26 checks), governed Organization (43 checks), and recovery/tamper (53 checks) handoff demos. The 24 CI demos now cover 630 unique checks and include compiled Runtime and Organization handoff smokes.
- Synchronize package / lockfile / Docker Compose metadata at v0.6.0.

中文：

- 新增严格的末步 `handoff` Skill step，显式声明目标 Actor / Skill、reason 与 JSON-safe input mapping；ActorRuntime 以终态 `handoff_requested` 返回。handoff 从不成为 PendingRun，也不产生 `final_output`。
- Actor Trace 升级为 `trace.snapshot.v2`；合法 v1 快照通过纯函数 normalize，v2 生命周期校验将唯一 handoff 事件绑定到终态 handoff run。
- 被接受的 handoff 会原子物化为 `delegated` 源任务、一个 depth-1 queued 子任务、一条带 fingerprint 的 registry 记录和一条 canonical correlated `task_request`。
- 在留下任何组织 artifact 前，强制校验源端 `task:delegate` / `message:receive`、目标端 `task:execute` / `message:receive`、active 成员、显式 Skill ownership、禁止 self-handoff，并限制 `MAX_HANDOFF_DEPTH = 1`。
- 子任务执行前精确 deliver / acknowledge 对应 request。子任务终止后仅产生一条具有 correlation / causation 的 `task_response`；源任务保持 delegated，终态源 Actor run 永不恢复。
- 新增有界 `dispatchUntilIdle()`，明确返回 idle / dispatch-limit 与 blocked waiting tasks；它不是 daemon 或持久队列 worker。
- Organization snapshot/store 升级为 v3，保存任务 lineage 与 Handoff Registry。恢复提交前深度交叉校验 Task、Actor/Skill、handoff fingerprint、canonical messages、Organization Trace、Actor Trace、PendingRun、Memory 与 response 生命周期。
- 新增纯函数 Organization v2→v3 迁移及嵌套 Trace v1→v2 normalize；混合版本 envelope、未来版本和在旧快照中夹带 v3-only handoff 元数据都会 fail closed。
- 保持 at-least-once 恢复语义。稳定 ID 与 fingerprint 可保证单个已加载 aggregate 内的 artifact 幂等，但崩溃安全的 exactly-once 仍需宿主提供 transactional outbox 或持久幂等存储。
- 新增 Runtime（26 条）、受治理 Organization（43 条）与 recovery/tamper（53 条）三条 handoff Demo；24 个 CI Demo 现共覆盖 630 条独立检查，并包含 Runtime/Organization 编译产物 handoff smoke。
- package、lockfile 与 Docker Compose 元数据同步到 v0.6.0。

---

## v0.5.1 — Governance Fail-Closed

- Reject Tool definitions that declare the unimplemented `afterCall` or `beforeWriteback` approval stages, including empty or mixed-stage policies; only `beforeCall` is currently executable.
- Perform definition, executor, and JSON-safe request preflight before `tool_call_start`, so rejected definitions and malformed requests cannot produce false execution lifecycle events.
- Require every configured external-event correlation key and each interpolation token to resolve before suspension to a non-empty string, number, or boolean with no unresolved template delimiters.
- Fail the Actor run before allocating a request id, creating a pending run, or recording `external_event_requested` / `actor_run_suspended` when correlation setup is unsafe.
- Revalidate correlation resolution during PendingRun restore, so unsafe v0.5.0 v2 checkpoints fail closed without a schema-version bump.
- Preserve compatibility for literal correlation keys, fully resolved templates, and Skills that omit correlation.
- Expand External Event Validation from 25 to 69 checks, Organization Recovery from 42 to 44 checks, and add 15 Tool Approval Fail-Closed checks. The 21 CI demos now cover 508 unique checks.
- Emit CommonJS that runs without a development loader, and execute the compiled demo through native Node via `start:dist` after every CI build.
- Synchronize package / lockfile / Docker Compose metadata at v0.5.1.

中文：

- Tool 声明尚未实现的 `afterCall` 或 `beforeWriteback` 审批阶段时直接拒绝注册，包括空策略和与 `beforeCall` 混合的策略；当前只有 `beforeCall` 可执行。
- Definition、executor 与 JSON-safe request preflight 都发生在 `tool_call_start` 之前，因此不受支持的治理配置和畸形请求都不会留下虚假的执行生命周期事件。
- 已声明的 external-event correlation 及其每个插值 token 都必须在 suspend 前解析为非空 string / number / boolean，并且不能残留模板占位符。
- correlation 配置不安全时，在分配 request id、创建 pending run、记录 `external_event_requested` 或 `actor_run_suspended` 之前终止 Actor run。
- PendingRun 恢复会重新校验 correlation 解析，因此不安全的 v0.5.0 v2 checkpoint 会在不升级 schema 的前提下 fail closed。
- 字面 correlation、完整解析的模板以及未声明 correlation 的 Skill 保持兼容。
- External Event Validation 从 25 条扩展到 69 条、Organization Recovery 从 42 条扩展到 44 条，并新增 15 条 Tool Approval Fail-Closed 验收；21 个 CI Demo 共覆盖 508 条独立检查。
- 编译产物改为无需开发加载器的 CommonJS；CI 每次 build 后都会通过原生 Node 的 `start:dist` 运行编译 Demo。
- package、lockfile 与 Docker Compose 元数据同步到 v0.5.1。

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
- Human input, Skill approval, Tool approval, and External event continuations now validate event kind and request identity before resume or consumption; invalid attempts preserve the original pending run and allow a valid retry.
- Added FIFO `ActorInbox` with explicit queued, delivered, and acknowledged states; unacknowledged delivered messages can be redelivered.
- Added organization-level Trace for permission, task, message, and recovery metadata without storing message/event payloads.
- Added `OrganizationSnapshot`, `OrganizationStore`, and `JsonOrganizationStore` with serialized in-instance mutations and atomic file replacement. Cross-process writers still require an external lock or single-writer deployment.
- Organization recovery persists Registry, Tasks, queue order, Inbox, Organization Trace, PendingRunSnapshot entries, filtered Actor Trace, and organization-scoped Memory.
- Added organization-partitioned Memory dump/restore and run-partitioned Trace dump/restore so restoring one organization preserves others.
- ActorRuntime now uses UUID run IDs, preventing process-local counters from colliding during organization recovery.
- Tool calls, approval requests, waiting requests, Trace events, Memory records, and candidates now use UUID-backed identities; stable `toolCallId` values survive snapshots and are the host idempotency key.
- Actor / Skill / input preflight now completes before ownership claims, MemoryStore access, seed writes, or Tool execution, and runtime execution uses detached canonical copies to close caller-mutation races.
- Tool definitions and observations are detached at the gateway; observations must match request identity, JSON shape, status, and output schema before entering state or Trace.
- Tool approval snapshots bind the complete before-call policy fingerprint. Registry or policy drift, including post-request argument-modification expansion, is rejected without consuming the pending run.
- Runtime MemoryStore load/merge/save is organization-scoped and preserves concurrent partitions and pending runs.
- PendingRun restore validates its Skill, state, context, current waiting step, exact pending payload union, and Tool approval cross-references at every restore entry point.
- Organization recovery validates embedded execution and policy state against canonical ActorConfig, SkillConfig, current Tool definitions, Task input/runtime context, and deep Actor Trace lifecycle before mutating shared runtime state, with rollback on commit failure.
- Actor Trace restore validates run/event identity, sequence, event types, JSON-safe data, and lifecycle/status consistency.
- `clearOrganization()` rejects in-flight dispatch/continue operations so an organization cannot be removed before its Actor run is bound or settled.
- Caller Actor IDs are explicitly a trusted-host authentication input; Organization capabilities are authorization rather than authentication.
- Snapshot validation enforces structure and internal consistency but is not a cryptographic authenticity guarantee; untrusted storage still requires deployment-level integrity protection.
- PendingRun, RuntimeRecoveryBundle, and Organization snapshot/store schemas are now v2; unsafe v1 Tool-approval checkpoints fail closed because they do not contain a policy fingerprint.
- Recovery is at-least-once, not exactly-once: Tool executors must deduplicate the stable `toolCallId`, and crash-safe exactly-once delivery requires a host transactional outbox or durable idempotency store. The host owns checkpoint advancement/deletion.
- All JSON stores serialize mutations and use atomic replacement only within one store instance. Multiple instances or processes sharing a file require an external lock or single-writer deployment.
- OrganizationRuntime ownership is process-local and must be released with `clearOrganization()` when the host unloads an organization.
- The 20 CI demos now cover 447 checks, including 81 continuation, 42 Organization recovery, 21 four-kind pending recovery, and 19 lifecycle-hardening checks.
- Added all release-hardening demos to CI and kept package / lockfile metadata at v0.5.0.

中文：

- 从已合并 v0.4.5 的 main 重建 v0.5.0，不再延续已分叉的原型分支。
- ActorRegistry、TaskManager、ActorInbox 与 OrganizationTrace 按 organizationId 隔离；共享的 ActorRuntime Memory / Trace 服务仅按组织/运行分区恢复。
- Actor 注册保存可执行 ActorConfig、SkillConfig、状态与组织能力，并强制校验成员、active、allowed_skills、Skill owner、manager 注册、Inbox 读取与 continuation 权限边界。
- Task 使用不可变受控状态机和同步队列 claim，避免并发 dispatch 重复执行。
- OrganizationRuntime 真实调用 ActorRuntime.run / continue，并保存 Task ↔ actorRunId 绑定。
- Human input、Skill approval、Tool approval 与 External event 都在 resume / consume 前校验事件类型与 request ID；非法输入保留 pending run 并允许合法重试。
- Actor Inbox 使用 queued / delivered / acknowledged FIFO 语义，未 ack 的 delivered message 可重新投递。
- Organization Trace 记录权限、任务、消息与恢复 metadata，不记录完整 payload。
- 新增 OrganizationSnapshot、OrganizationStore 与单实例写入串行化、原子文件替换的 JsonOrganizationStore；跨进程并发写仍需外部锁或单写者部署。
- 恢复包保存 Registry、Task Queue、Inbox、Organization Trace、PendingRunSnapshot，并按 organizationId / actorRunId 分区恢复 Memory 与 Actor Trace。
- ActorRuntime 改用 UUID run ID，避免跨进程恢复时的计数器碰撞。
- Tool call、审批/等待请求、Trace、Memory 与 candidate 全部使用 UUID 身份；snapshot 会保留稳定 `toolCallId` 作为宿主幂等键。
- Actor / Skill / input 在 ownership claim、MemoryStore、seed 与 Tool 副作用前完成 preflight，执行期只使用与调用方脱离的 canonical 副本。
- Tool 定义和 observation 在 Gateway 边界深拷贝；identity、JSON shape、status 与 output schema 校验通过后才进入 state / Trace。
- Tool pending snapshot 固化 before-call policy fingerprint；等待期间 Registry / policy 漂移或事后扩权不会消费 pending run。
- Runtime MemoryStore 按 organization 分区 merge / save，不覆盖同进程其他组织或并发 pending run。
- PendingRun 的所有恢复入口都会校验 Skill、状态、上下文、当前等待步骤、唯一 pending payload 与 Tool approval 交叉引用。
- Organization 恢复会把执行与权限状态和 canonical ActorConfig、SkillConfig、当前 Tool、Task 上下文及 Actor Trace 生命周期做完整 preflight，并在提交失败时回滚。
- `clearOrganization()` 会拒绝 in-flight dispatch / continue，避免组织删除后留下 orphan run。
- 明确调用方 Actor ID 必须来自可信宿主认证；Capability 只负责授权。
- Snapshot 校验保证结构和内部一致性，不提供加密真实性；不可信存储仍需部署层完整性保护。
- PendingRun、RuntimeRecoveryBundle 与 Organization snapshot/store 升级为 v2；缺少 policy fingerprint 的不安全 v1 Tool checkpoint 会 fail closed。
- Recovery 是 at-least-once 而非 exactly-once：Tool executor 必须按稳定 `toolCallId` 去重；崩溃安全的 exactly-once 需要宿主 transactional outbox 或持久幂等存储，checkpoint 推进/删除也由宿主管理。
- 所有 JSON Store 只保证同一实例内写入串行化与原子替换；多实例/多进程共享文件仍需外部锁或单写者部署。
- OrganizationRuntime ownership 是进程内状态，宿主卸载组织时必须显式调用 `clearOrganization()` 释放。
- 20 个 CI Demo 现覆盖 447 条验收，其中 continuation 81 条、Organization Recovery 42 条、四类 pending 恢复 21 条、生命周期加固 19 条。
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
