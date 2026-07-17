# 记忆存储路径对比分析

> 对比项目：`vssaros-agents-client`（本项目）vs `agentmemory`（原版）

---

## 一、当前项目存储路径

### 实际磁盘结构

```
C:\Users\<user>\.saros\.agentmemory\
├── default\
│   ├── long-term.jsonl           (1 byte — 空文件)
│   └── short-term.jsonl          (1 byte — 空文件)
├── saros-claw\
│   ├── long-term.jsonl           (6,470 bytes)
│   ├── short-term.jsonl          (107,968 bytes)
│   ├── vector-index.json         (24,090 bytes)
│   ├── vector-index.manifest.json (0 bytes — P0 分片 manifest)
│   └── vector-index.json.shard.{N} (大索引时分片文件)
```

### 数据组织方式

| 文件 | 内容 | 格式 | 写入方式 |
|------|------|------|----------|
| `long-term.jsonl` | 所有长期记忆（Episodic/Semantic/Procedural 混在一起） | JSONL（每行一个 JSON） | **全量替换** |
| `short-term.jsonl` | 所有短期记忆（Working） | JSONL | **全量替换** |
| `vector-index.json` | 向量索引（所有 embedding） | JSON | **全量替换** |
| `vector-index.manifest.json` | 分片 manifest | JSON | 全量替换 |
| `vector-index.json.shard.{N}` | 索引分片 | 文本 | 全量替换 |

### 代码常量

```typescript
const SHORT_TERM_FILE = 'short-term.jsonl';
const LONG_TERM_FILE = 'long-term.jsonl';
const VECTOR_INDEX_FILE = 'vector-index.json';
const VECTOR_MANIFEST_FILE = 'vector-index.manifest.json';
const INDEX_SHARD_CHARS = 2_000_000; // 2MB per shard
```

### 关键问题

1. **全量写入**：每次 flush 都重写整个文件，即使只变更了 1 条记忆
2. **混合存储**：Episodic/Semantic/Procedural 三种不同层级的记忆混在一个 `long-term.jsonl` 中
3. **无元数据**：没有记录数据版本、创建时间、条目数等元信息
4. **无 workspace 隔离**：所有 workspace 共享同一个 `.agentmemory` 目录

---

## 二、原版 agentmemory 存储路径

### 存储结构

```
./data/state_store.db  (SQLite 文件，通过 iii-engine StateKV 管理)
```

### KV Scope 组织（44 个功能域）

```typescript
export const KV = {
  // 核心记忆
  sessions:    "mem:sessions",           // 会话
  observations: (sessionId) => `mem:obs:${sessionId}`,  // 观察记录（按会话分 scope）
  memories:    "mem:memories",            // 记忆
  summaries:   "mem:summaries",           // 摘要

  // 4-Tier 层级
  semantic:    "mem:semantic",            // 语义记忆（独立 scope）
  procedural:  "mem:procedural",          // 程序记忆（独立 scope）

  // 索引
  bm25Index:   "mem:index:bm25",          // BM25 索引
  embeddings:  (obsId) => `mem:emb:${obsId}`,  // 嵌入向量（按 obsId 分 scope）

  // 知识图谱
  graphNodes:     "mem:graph:nodes",
  graphEdges:     "mem:graph:edges",
  graphSnapshot:  "mem:graph:snapshot",
  graphNameIndex: "mem:graph:name-index",
  graphEdgeKey:   "mem:graph:edge-key",
  graphNodeDegree:"mem:graph:node-degree",

  // 辅助数据
  lessons:     "mem:lessons",             // 教训
  slots:       "mem:slots",               // 槽位
  audit:       "mem:audit",               // 审计日志
  commits:     "mem:commits",             // 提交记录
  relations:   "mem:relations",           // 关系
  profiles:    "mem:profiles",            // 配置文件
  insights:    "mem:insights",            // 洞察

  // 运维数据
  metrics:     "mem:metrics",             // 指标
  health:      "mem:health",              // 健康
  retentionScores: "mem:retention",       // 保留分数
  accessLog:   "mem:access",              // 访问日志
  recentSearches: "mem:recent-searches",  // 最近搜索

  // 团队
  teamShared:  (teamId) => `mem:team:${teamId}:shared`,
  teamUsers:   (teamId, userId) => `mem:team:${teamId}:users:${userId}`,

  // ... 共 44 个 scope
} as const;
```

### 数据组织方式

| 特性 | 说明 |
|------|------|
| **存储引擎** | SQLite（iii-engine StateKV 管理） |
| **操作粒度** | 单条 KV（key-value），增量写入 |
| **查询能力** | 按 scope/key 精确查询，支持 `state::list` 枚举 |
| **并发安全** | SQLite WAL 模式，并发读不阻塞写 |
| **事务保证** | 原子提交，写入失败不影响已有数据 |
| **分片支持** | IndexPersistence 内置 ~2MB 分片 + manifest |
| **维度校验** | 加载时校验向量维度，不匹配则丢弃重建 |

---

## 三、对比分析

| 维度 | 当前项目 | 原版 agentmemory | 差距评估 |
|------|---------|------------------|----------|
| **存储引擎** | JSONL 文件（host.mjs HTTP 服务器） | SQLite（iii-engine StateKV） | 原版有事务、并发安全 |
| **数据组织** | 3-4 个大文件（按 agentId 分目录） | 44 个 KV scope（按功能域分） | 原版按功能域细分 |
| **持久化粒度** | **全量写入**（每次 flush 重写整个文件） | **增量写入**（单条 KV 操作） | **最大差距**：全量写入开销大 |
| **查询能力** | 全量加载到内存后搜索 | KV 按 scope/key 精确查询 | 原版支持部分加载 |
| **并发安全** | 原子写入（tmp+rename）但不支持并发读写 | SQLite WAL 模式 | 原版支持并发读 |
| **数据恢复** | 文件损坏则该 agent 全部数据丢失 | SQLite 事务保证 | 原版更可靠 |
| **层级隔离** | Episodic/Semantic/Procedural 混在一个文件 | 三个独立 scope | 原版层级清晰 |
| **分片支持** | ✅ P0 已实现（2MB/块 + manifest） | iii-engine 内置分片 | 已追赶 |
| **维度校验** | ✅ P1 已实现 | 原版有 | 已追赶 |
| **索引重建** | ✅ P2 已实现 | 原版有 | 已追赶 |
| **错误处理** | ✅ P3 已实现（60s 节流） | 原版有 | 已追赶 |
| **信号处理** | ✅ P4 已实现（beforeunload + /flush-all） | 原版有（SIGINT/SIGTERM） | 已追赶 |
| **健康监控** | ✅ P5 已实现（60s 定时器） | 原版有 HealthMonitor | 已追赶 |

---

## 四、优化方案

### 方案 1：按功能域拆分文件（推荐优先实施）

**问题**：当前 `long-term.jsonl` 混合了 Episodic/Semantic/Procedural 三种记忆，每次 flush 都全量写入。

**方案**：拆分为独立文件，只写入变更的部分。

```
.agentmemory/{agentId}/
├── episodic.jsonl       ← 情景记忆（高频写入）
├── semantic.jsonl       ← 语义记忆（低频写入）
├── procedural.jsonl     ← 程序记忆（低频写入）
├── short-term.jsonl     ← 短期记忆（高频写入）
├── lessons.jsonl        ← 教训（低频写入）
├── slots.jsonl          ← 槽位（低频写入）
├── audit.jsonl          ← 审计日志（追加写入）
├── commits.jsonl        ← 提交记录（追加写入）
├── vector-index.json    ← 向量索引
├── vector-index.manifest.json
└── meta.json            ← 元数据（版本、时间戳、条目数）
```

**收益**：
- 只 flush 变更的文件，减少 I/O 开销
- 层级隔离，单文件损坏不影响其他层级
- 支持部分加载（只加载需要的层级）

### 方案 2：增量写入（长期优化）

**问题**：每次 flush 都全量写入所有数据（10 万条记忆 = 100KB+ 写入），即使只变更了 1 条。

**方案**：改为追加写入 + 定期压缩。

```typescript
// 增量写入：只追加新条目
private async _appendEntries(agentId: string, file: string, entries: InternalMemoryEntry[]): Promise<void> {
    const jsonl = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    await appendFile(agentId, file, jsonl);  // 追加模式
}

// 定期压缩：合并 + 去重 + 清理已删除条目
private async _compactFile(agentId: string, file: string): Promise<void> {
    const raw = await readFile(agentId, file);
    const entries = this._parseJsonl(raw);
    const seen = new Set<string>();
    const compacted = entries.filter(e => {
        if (seen.has(e.id) || e.supersededBy) return false;
        seen.add(e.id);
        return true;
    });
    await writeFile(agentId, file, compacted.map(e => JSON.stringify(e)).join('\n') + '\n');
}
```

**收益**：
- 日常写入只追加变更条目（~1KB），而非全量重写（~100KB）
- 定期压缩清理冗余（可配置间隔，如每小时或每 1000 次写入）

### 方案 3：元数据文件（低成本高收益）

**问题**：没有记录数据版本、创建时间、条目数等元信息，加载时无法快速判断数据是否需要迁移或重建。

**方案**：添加 `meta.json` 文件。

```json
{
  "version": 2,
  "agentId": "saros-claw",
  "createdAt": 1719480000000,
  "updatedAt": 1719481200000,
  "entryCounts": {
    "episodic": 15,
    "semantic": 3,
    "procedural": 2,
    "shortTerm": 42,
    "lessons": 5,
    "slots": 3
  },
  "indexStatus": {
    "vectorDimension": 384,
    "vectorCount": 20,
    "vectorSharded": false,
    "lastRebuildAt": 1719480000000
  }
}
```

**收益**：
- 加载时快速判断数据完整性
- 支持数据迁移（版本号）
- 索引重建决策（维度不匹配时）

### 方案 4：Workspace 隔离（按需实施）

**问题**：所有 workspace 共享同一个 `.agentmemory` 目录，多 workspace 场景下数据混合。

**方案**：

```
.agentmemory/
├── {workspaceId}/
│   ├── {agentId}/
│   │   ├── episodic.jsonl
│   │   └── ...
├── _global/
│   ├── audit.jsonl
│   └── commits.jsonl
```

**收益**：
- 多 workspace 数据隔离
- 全局数据（审计、提交）独立存储

---

## 五、实施优先级

| 优先级 | 方案 | 改动量 | 收益 | 风险 |
|--------|------|--------|------|------|
| **P0** | 方案 3：元数据文件 | 小 | 高 | 低 |
| **P1** | 方案 1：按功能域拆分文件 | 中 | 高 | 中（需数据迁移） |
| **P2** | 方案 2：增量写入 | 大 | 高 | 中（需压缩逻辑） |
| **P3** | 方案 4：Workspace 隔离 | 中 | 低 | 低 |

---

## 六、总结

当前项目的 JSONL 存储方案经过 P0-P5 优化后，在分片持久化、维度校验、索引重建、错误处理、信号处理和健康监控方面已达到接近原版的可靠性水平。

**剩余的主要差距**是：
1. **全量写入**（每次 flush 重写整个文件）→ 建议方案 2 增量写入
2. **混合存储**（三种层级混在一个文件）→ 建议方案 1 按功能域拆分
3. **无元数据**（无法快速判断数据状态）→ 建议方案 3 添加 meta.json

这三项优化可以显著减少 I/O 开销、提高数据隔离性、增强可维护性。
