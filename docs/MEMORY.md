# Memory

Memory 是实践沉淀，让下一次实践变得更好。

## 四层记忆模型

```
organization_public_memory
  └── unit_memory
        └── actor_private_memory
              └── scene_shared_context (临时)
```

## 读写权限

| Memory 层 | 谁可读 | 谁可写 |
|-----------|--------|--------|
| organization_public | 所有 Actor | 不可 |
| unit_memory | 同 Unit Actor | 候选写入 |
| actor_private | 仅 Actor 自己 | Actor 自己 |
| scene_shared_context | Scene 内 Actor | Scene 内 Actor |

## 记忆生成

每次 Actor 运行完成后，MemoryService 生成 MemoryCandidate：

- 候选记忆需要人工或规则确认后才能归档为正式记忆
- 包含 confidence 字段表示置信度
- 关联 sourceRunId 用于追溯

## 当前 MVP 实现

- 纯内存存储（数组）
- Actor 配置中的 `memory` 数组直接初始化
- 运行后自动生成一条 case_pattern 候选记忆

## 下一步

- 向量化存储
- 相似记忆检索
- 记忆衰减/归档策略
- 跨 Actor 记忆共享
