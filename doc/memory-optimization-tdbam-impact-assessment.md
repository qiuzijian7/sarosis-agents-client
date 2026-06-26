# 优化方案对 TDB-AM 框架的影响评估

> **文档信息**
> - 创建时间：2026-06-26
> - 版本：v1.0
> - 评估对象：`memory-optimization-plan-based-on-agentmemory.md` 中 P0-P3 优化方案
> - 受影响系统：TDB-AM（TencentDB-Agent-Memory）框架集成
> - 关联文档：`Memory-Strategy.md`、`memory-optimization-plan-based-on-agentmemory.md`、`memory-framework-refactoring-and-hermes-comparison.md`

---

## 一、当前 TDB-AM 集成架构

### 1.1 双层记忆 Provider 架构

当前项目通过 `SlotRegistry` 的 priority 机制运行**两个 MemoryProvider**，按优先级自动选择活跃 Provider：

```
SlotRegistry.getActiveMemoryProvider()
  │
  ├─ Priority 80: TdbAmMemoryProvider (活跃 — gateway 可用时)
  │   └─ HTTP → 127.0.0.1:8420 (host.mjs 子进程)
  │       └─ vendor TdaiGateway
  │           ├─ L0: auto-capture (SQLite + JSONL)
  │           ├─ L1: l1-extractor (LLM 提取)
  │           ├─ L2: scene-extractor (场景摘要)
  │           ├─ L3: persona-generator (人格画像)
  │           ├─ VectorStore (FTS5 + embedding)
  │           ├─ EmbeddingService (KnotBridge → OpenAI 兼容)
  │           ├─ MemoryPipelineManager (L0→L1→L2→L3 调度)
  │           └─ l1-dedup (去重 + 冲突检测)
  │
  └─ Priority 50: SessionMemoryProvider (兜底 — gateway 不可用时)
      └─ JSONL 文件 (short-term.jsonl + long-term.jsonl)
          ├─ searchMemory: String.includes() 子串匹配
          ├─ VectorMemory: TF-IDF 占位
          └─ 原子写入 + 文件锁
```

**关键事实**：`slotRegistry.ts` 中 `getActiveMemoryProvider()` 返回 priority 最高的 Provider。TDB-AM (80) > SessionMemoryProvider (50)。因此 **TDB-AM 是活跃 Provider**，SessionMemoryProvider 仅在 gateway 子进程未启动或不可达时作为兜底。

### 1.2 TDB-AM 已具备的能力

| 能力 | TDB-AM 实现 | 优化方案对应 |
|------|------------|-------------|
| **关键词搜索** | SQLite FTS5（全文检索） | P0.2 BM25 |
| **向量搜索** | EmbeddingService（KnotBridge → OpenAI 兼容接口） | P0.3 本地 embedding |
| **混合搜索** | VectorStore query（FTS5 + vector 融合） | P0.4 RRF 融合 |
| **L0 自动捕获** | `auto-capture.ts` hook + `l0-recorder.ts` | P1.4 工具级捕获 hook |
| **L1 提取** | `l1-extractor.ts`（LLM 调用）+ `pipeline-manager.ts` 调度 | agentOSService.ts `triggerL1Extraction` |
| **L2 场景** | `scene-extractor.ts` | agentOSService.ts `triggerL2Extraction` |
| **L3 人格** | `persona-generator.ts` | agentOSService.ts `triggerL3Extraction` |
| **去重** | `l1-dedup.ts`（vector + keyword 双路） | P1.3 矛盾检测 |
| **代码块清洗** | `sanitize.ts`（剥离 ``` 代码块） | — |
| **隐私剥离** | `stripUndefinedLiterals`（仅剥离 "undefined" 字面量） | P0.1 隐私过滤器（更完整） |
| **衰减** | ❌ 无 | P1.1 Ebbinghaus 衰减 |
| **自动遗忘** | ❌ 无 | P1.2 TTL + 重要性驱逐 |
| **知识图谱** | ❌ 无 | P2.1 轻量知识图谱 |
| **审计 trail** | ❌ 无 | P2.3 审计 trail |
| **基准测试** | ❌ 无 | P3.1 基准框架 |

### 1.3 agentOSService.ts 的并行管线

`agentOSService.ts` 内部实现了**独立的 L1/L2/L3 管线**，与 TDB-AM vendor 的 pipeline-manager **并行运行**：

```
agentOSService.ts:
  triggerL1Extraction()  → 每 3 轮调 LLM 提取 → writeMemory(long_term)
  triggerL2Extraction()   → L1 完成后延迟 30s → 场景摘要
  triggerL3Extraction()   → L2 完成后 → 人格生成（全局互斥）
```

**双重管线问题**：agentOSService 的 L1 提取结果通过 `writeMemory` 写入活跃 Provider（即 TDB-AM），TDB-AM 的 pipeline-manager **也会独立触发 L1 提取**。两条管线可能产生重复提取。

---

## 二、影响评估矩阵

### 2.1 按优化项评估

| 优化项 | 目标 Provider | 对 TDB-AM 的影响 | 风险等级 | 评估 |
|--------|-------------|-----------------|----------|------|
| **P0.1 隐私过滤器** | SessionMemoryProvider | **无直接影响**（TDB-AM 有自己的 sanitize） | 🟢 低 | TDB-AM 的 `stripUndefinedLiterals` 仅剥离 "undefined" 字面量，**不剥离 API key/secret**。建议隐私过滤应在 **TdbAmMemoryProvider.writeMemory 入口处也加上**，补齐 TDB-AM 的安全短板 |
| **P0.2 BM25 索引** | SessionMemoryProvider | **无影响**（TDB-AM 用 FTS5） | 🟢 低 | 仅增强兜底 Provider。TDB-AM gateway 可用时不走此路径 |
| **P0.3 本地向量 embedding** | SessionMemoryProvider | **无影响**（TDB-AM 用 KnotBridge embedding） | 🟢 低 | 仅增强兜底 Provider |
| **P0.4 RRF 融合搜索** | SessionMemoryProvider | **无影响**（TDB-AM 有自己的 VectorStore 融合） | 🟢 低 | 仅增强兜底 Provider |
| **P1.1 记忆衰减** | SessionMemoryProvider | **无直接影响**，但需考虑 TDB-AM 侧 | 🟡 中 | TDB-AM 无衰减机制，记忆无限累积。如果仅对 SessionMemoryProvider 加衰减，TDB-AM 侧的 SQLite 会持续膨胀。**建议衰减策略也应作用于 TDB-AM**（通过 gateway admin API） |
| **P1.2 自动遗忘** | SessionMemoryProvider | **同 P1.1** | 🟡 中 | TDB-AM 无自动遗忘。需评估是否扩展到 TDB-AM 侧 |
| **P1.3 矛盾检测** | SessionMemoryProvider | **无影响**（TDB-AM 有 l1-dedup） | 🟢 低 | TDB-AM 的 `l1-dedup.ts` 已做 vector + keyword 双路去重。SessionMemoryProvider 侧加矛盾检测不冲突 |
| **P1.4 工具级捕获 hook** | agentDriverService.ts | **有影响** — 与 TDB-AM auto-capture 可能重复 | 🔴 高 | TDB-AM 的 `auto-capture.ts` 已在 `/capture` 端点自动记录 L0。如果 agentOSService 再加工具级 hook 写入，会**双重写入**：一次走 TdbAmMemoryProvider.writeMemory → /capture，一次走新 hook → writeMemory → /capture |
| **P2.1 知识图谱** | 新增（独立于 Provider） | **无影响** | 🟢 低 | 知识图谱是独立模块，不经过 MemoryProvider。可与 TDB-AM 并存 |
| **P2.2 实时查看器** | memoryDetailEditorPane.ts | **需适配 TDB-AM 数据源** | 🟡 中 | 查看器需要同时支持 SessionMemoryProvider 的 JSONL 数据和 TDB-AM 的 HTTP API 数据（/list/conversations, /list/memories） |
| **P2.3 审计 trail** | 新增（独立于 Provider） | **无影响** | 🟢 低 | 审计 trail 在 Provider 层之上，记录所有 Provider 的操作 |
| **P3.1 基准测试** | 测试框架 | **无影响** | 🟢 低 | 基准测试不影响运行时 |

### 2.2 风险汇总

| 风险 | 等级 | 说明 |
|------|------|------|
| **双重 L1 提取** | 🔴 高 | agentOSService.triggerL1Extraction + TDB-AM pipeline-manager 两条管线并行运行，可能产生重复记忆 |
| **双重 L0 捕获** | 🔴 高 | P1.4 工具级 hook + TDB-AM auto-capture 可能对同一工具调用写入两次 |
| **衰减不对称** | 🟡 中 | 仅 SessionMemoryProvider 衰减，TDB-AM SQLite 无衰减 → 长期膨胀 |
| **查看器数据源不统一** | 🟡 中 | 查看器需要适配两种 Provider 的不同数据格式 |
| **隐私过滤覆盖不全** | 🟡 中 | P0.1 仅作用于 SessionMemoryProvider，TDB-AM 侧的 `/capture` 入口未过滤 |

---

## 三、详细影响分析

### 3.1 P0.1 隐私过滤器 — 需扩展到 TDB-AM 入口

**现状**：
- `TdbAmMemoryProvider.writeMemory` 仅调用 `stripUndefinedLiterals`（剥离 "undefined" 字面量）
- TDB-AM vendor 的 `sanitize.ts` 仅剥离代码块，**不剥离 API key/secret/token**
- 敏感信息（TOF 票据、JWT、API key）可通过 `/capture` 直接落盘到 SQLite L0 表

**影响**：
- P0.1 隐私过滤器如果仅加在 `SessionMemoryProvider`，对 TDB-AM **无效**（活跃 Provider 是 TDB-AM）
- 必须同时在 `TdbAmMemoryProvider.writeMemory` 入口处调用 `stripPrivateData`

**建议**：
```typescript
// TdbAmMemoryProvider.writeMemory 入口处
const sanitizedContent = stripPrivateData(stripUndefinedLiterals(entry.content));
// 后续用 sanitizedContent 替代 entry.content
```

### 3.2 P1.4 工具级捕获 hook — 与 TDB-AM auto-capture 冲突

**现状**：
- TDB-AM 的 `auto-capture.ts` 在 `/capture` 端点自动记录 L0（user_content + assistant_content）
- `agentDriverService.ts` 的 finally 块调 `writeMemory` → `TdbAmMemoryProvider.writeMemory` → `/capture`
- TDB-AM pipeline-manager 从 L0 数据调度 L1 提取

**影响**：
- 如果 P1.4 在每次工具调用后额外调 `writeMemory`，TDB-AM 会收到额外的 `/capture` 请求
- 但 `/capture` 要求 `user_content` + `assistant_content` 配对，工具调用单独写入会导致 HTTP 400（TdbAmMemoryProvider 已有此防护）
- 即便不报错，也会产生**碎片化的 L0 记录**，干扰 TDB-AM 的 L1 提取质量

**建议**：
- P1.4 工具级捕获 **不通过 writeMemory** 写入，而是**仅写入 SessionMemoryProvider**（兜底 Provider）的短期记忆
- 或者：在 TdbAmMemoryProvider 中新增 `writeObservation` 方法，走 `/inject/l1` 而非 `/capture`，避免干扰 L0 配对逻辑

### 3.3 P1.1/P1.2 衰减与遗忘 — TDB-AM 侧缺失

**现状**：
- TDB-AM 无衰减机制，SQLite 中 L0/L1 记录无限累积
- `Memory-Strategy.md` 已提及"冷热分层：3 个月以上 L0 自动转冷归档"，但未实现

**影响**：
- 如果仅对 SessionMemoryProvider 加衰减，TDB-AM 侧的 SQLite 会持续膨胀
- 长期使用后 gateway 启动变慢（加载大量 L0 记录）、FTS5 索引膨胀

**建议**：
- 衰减/遗忘策略应**同时作用于 TDB-AM**
- 通过 TDB-AM gateway 的 admin API（`/admin/*`）实现 TTL 清理
- 或者：在 `TdbAmMemoryProvider` 中增加定期清理逻辑，调 gateway 的清理端点

### 3.4 P2.2 实时查看器 — 需适配双数据源

**现状**：
- `memoryDetailEditorPane.ts` 当前仅读取 SessionMemoryProvider 的 JSONL
- TDB-AM 的数据在 gateway 子进程的 SQLite 中，需通过 HTTP API 访问（`/list/conversations`, `/list/memories`）

**影响**：
- 查看器需要**根据当前活跃 Provider 动态切换数据源**
- TDB-AM 活跃时：调 `/list/conversations` + `/list/memories`
- SessionMemoryProvider 活跃时：读 JSONL 文件

**建议**：
- 查看器应通过 `IMemoryProvider.searchMemory` 统一接口获取数据，而非直接读文件
- TDB-AM 特有的 L2/L3 数据通过额外 HTTP API 获取

---

## 四、建议的调整方案

### 4.1 调整原则

1. **活跃 Provider 优先**：优化应优先作用于 TDB-AM（priority=80），而非仅 SessionMemoryProvider（priority=50）
2. **避免双重管线**：agentOSService 的 L1/L2/L3 与 TDB-AM pipeline-manager 需统一为一条
3. **兜底 Provider 增强**：SessionMemoryProvider 的增强仍有价值（gateway 不可用时的降级体验）

### 4.2 调整后的优先级

| 原方案 | 调整后 | 理由 |
|--------|--------|------|
| P0.1 仅 SessionMemoryProvider | **P0.1 双入口**：SessionMemoryProvider + TdbAmMemoryProvider | TDB-AM 是活跃 Provider，隐私过滤必须覆盖 |
| P0.2-P0.4 SessionMemoryProvider | **保持不变**（仅增强兜底） | TDB-AM 已有 FTS5 + VectorStore，兜底增强即可 |
| P1.1 衰减仅 SessionMemoryProvider | **P1.1 双侧**：SessionMemoryProvider + TDB-AM admin API | TDB-AM 侧 SQLite 需同步衰减 |
| P1.2 遗忘仅 SessionMemoryProvider | **P1.2 双侧**：同上 | 同上 |
| P1.3 矛盾检测 SessionMemoryProvider | **保持不变** | TDB-AM 已有 l1-dedup |
| P1.4 工具级 hook → writeMemory | **P1.4 改为独立观察流**，不经过 writeMemory | 避免与 TDB-AM /capture 冲突 |
| P2.2 查看器读 JSONL | **P2.2 通过 IMemoryProvider 接口**统一数据源 | 适配双 Provider |

### 4.3 新增：统一 L1 管线

**当前问题**：agentOSService.triggerL1Extraction + TDB-AM pipeline-manager 双重 L1 提取

**建议**：
- 方案 A（推荐）：**禁用 agentOSService 的 L1/L2/L3**，完全依赖 TDB-AM pipeline-manager
- 方案 B：**禁用 TDB-AM pipeline-manager 的 L1 调度**（通过配置 `pipeline.enabled=false`），仅用 agentOSService 的本地管线

选择依据：
- 方案 A 适合 TDB-AM gateway 稳定运行的场景（vendor 管线更成熟）
- 方案 B 适合需要离线/降级场景（不依赖 gateway 子进程）

---

## 五、不冲突的优化项（可直接实施）

以下优化项**不影响 TDB-AM**，可直接按原方案实施：

| 优化项 | 理由 |
|--------|------|
| P0.2 BM25 索引 | 仅增强 SessionMemoryProvider（兜底），TDB-AM 用 FTS5 |
| P0.3 本地向量 embedding | 仅增强 SessionMemoryProvider，TDB-AM 用 KnotBridge |
| P0.4 RRF 融合搜索 | 仅增强 SessionMemoryProvider，TDB-AM 有自己的融合 |
| P1.3 矛盾检测 | TDB-AM 已有 l1-dedup，SessionMemoryProvider 侧独立增强 |
| P2.1 知识图谱 | 独立模块，不经过 MemoryProvider |
| P2.3 审计 trail | Provider 层之上，记录所有 Provider 操作 |
| P3.1 基准测试 | 测试框架，不影响运行时 |

---

## 六、需要调整的优化项

### 6.1 P0.1 隐私过滤器 — 扩展到 TDB-AM 入口

```
原方案：仅 SessionMemoryProvider.writeMemory 加 stripPrivateData
调整后：SessionMemoryProvider + TdbAmMemoryProvider 双入口加 stripPrivateData
```

文件变更增加：
- `extensions/tdb-am-memory/src/memoryProvider.ts` — `writeMemory` 入口加 `stripPrivateData`

### 6.2 P1.1/P1.2 衰减与遗忘 — 扩展到 TDB-AM 侧

```
原方案：仅 SessionMemoryProvider 加 decay + eviction
调整后：SessionMemoryProvider 加 decay + eviction + TdbAmMemoryProvider 加 gateway admin 清理
```

文件变更增加：
- `extensions/tdb-am-memory/src/memoryProvider.ts` — 新增定期清理逻辑，调 gateway `/admin/cleanup` 端点
- 或：在 vendor 侧 `pipeline-manager.ts` 增加 decay sweep（需改 vendor 源码）

### 6.3 P1.4 工具级捕获 hook — 改为独立观察流

```
原方案：工具调用后调 writeMemory → /capture
调整后：工具调用后写入独立观察流（不经过 MemoryProvider），供查看器展示
```

变更：
- 新增 `browser/providers/memory/observationStream.ts` — 独立的观察事件流（EventEmitter）
- 工具调用后 `_observationStream.emit({ hookType, toolName, ... })`
- 查看器订阅此流展示实时观察
- **不调 writeMemory**，避免干扰 TDB-AM 的 /capture 配对逻辑

### 6.4 P2.2 查看器 — 通过 IMemoryProvider 接口统一数据源

```
原方案：查看器直接读 JSONL 文件
调整后：查看器通过 getActiveMemoryProvider().searchMemory() 统一获取数据
```

变更：
- `memoryDetailEditorPane.ts` 改为调 `IMemoryProvider.searchMemory` 而非直接读文件
- TDB-AM 活跃时自动走 HTTP API，SessionMemoryProvider 活跃时走 JSONL

---

## 七、风险评估总结

### 7.1 高风险（需优先处理）

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 双重 L1 提取 | 重复记忆、LLM token 浪费 | 统一为单条管线（禁用 agentOSService 或 TDB-AM 之一） |
| 双重 L0 捕获 | /capture 配对混乱、HTTP 400 | P1.4 改为独立观察流，不经过 writeMemory |
| 隐私过滤覆盖不全 | API key 落盘 TDB-AM SQLite | P0.1 扩展到 TdbAmMemoryProvider 入口 |

### 7.2 中风险（需评估后处理）

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 衰减不对称 | TDB-AM SQLite 膨胀 | 衰减策略扩展到 TDB-AM admin API |
| 查看器数据源不统一 | 无法展示 TDB-AM 数据 | 查看器通过 IMemoryProvider 接口统一 |

### 7.3 低风险（可直接实施）

| 优化项 | 理由 |
|--------|------|
| P0.2-P0.4 | 仅增强兜底 Provider，不影响 TDB-AM |
| P1.3 | TDB-AM 已有 dedup，独立增强不冲突 |
| P2.1/P2.3 | 独立模块，不经过 MemoryProvider |
| P3.1 | 测试框架，不影响运行时 |

---

## 八、结论

优化方案对 TDB-AM 框架的影响可分为三类：

1. **不冲突（可直接实施）**：P0.2-P0.4、P1.3、P2.1、P2.3、P3.1 — 这些仅增强兜底 Provider 或独立模块，不影响 TDB-AM 运行时

2. **需调整后实施**：P0.1（扩展到 TDB-AM 入口）、P1.1/P1.2（扩展到 TDB-AM 侧清理）、P1.4（改为独立观察流）、P2.2（通过 IMemoryProvider 接口统一）— 这些需适配 TDB-AM 的双 Provider 架构

3. **需优先解决的架构问题**：agentOSService 与 TDB-AM pipeline-manager 的双重 L1/L2/L3 管线 — 这不是优化方案引入的新问题，而是现有架构的遗留问题，优化方案实施前应先统一为单条管线

**核心建议**：优化方案应明确区分"增强兜底 Provider"和"增强活跃 Provider"两个层次。当前方案主要针对 SessionMemoryProvider（兜底），但 TDB-AM（活跃）才是实际运行的记忆系统。隐私过滤、衰减、遗忘等关键能力必须同时覆盖 TDB-AM 侧，否则优化效果对用户不可见。

---

*本文档基于 `extensions/tdb-am-memory/`、`extensions/tdb-am-gateway/vendor/tdbam/`、`agentOSService.ts`、`slotRegistry.ts` 源码分析编写。*
