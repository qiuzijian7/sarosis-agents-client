# P1 Audit Report — Performance, Quality & Memory Safety

## P1-1: 性能基准测试

**文件**: `extensions/agentmemory-memory/src/__tests__/benchmark.ts`

测试 1000 条记忆的写入/搜索延迟：
- BM25 批量索引 1000 条 + 搜索延迟
- VectorIndex 批量索引 1000 条（使用 embedSync trigram fallback）+ 搜索延迟
- DedupManager 1000 次去重检查（含重复检测）
- PrivacyFilter 1000 次过滤
- RRF 融合 4 路 × 1000 结果
- Combined 写入+搜索（BM25+Vector+RRF）

运行: `node out/__tests__/benchmark.js`

## P1-2: 单元测试

**测试框架**: 自研轻量测试运行器 `testRunner.ts`（零外部依赖）

| 模块 | 测试文件 | 测试数 |
|------|---------|--------|
| BM25Index | `bm25Index.test.ts` | 9 |
| PrivacyFilter | `privacyFilter.test.ts` | 12 |
| DedupManager | `dedup.test.ts` | 7 |
| RRF Fusion | `rrf.test.ts` | 10 |
| VectorIndex | `vectorIndex.test.ts` | 9 |

**新增模块**: `rrf.ts` — 从 `memoryProvider.ts` `_hybridSearch` 提取的独立 RRF 融合模块，支持：
- `rrfFuse(streams, k)` — 标准 RRF 融合
- `rrfFuseWithDiversify(streams, k, maxPerSession, getSessionKey)` — 带会话去重

运行: `node out/__tests__/runAllTests.js`

## P1-3: 内存泄漏检测

### 审计结果：✅ 全部 Map/Set 在 dispose() 中正确清理

`AgentMemoryProvider` 声明了 19 个 Map/Set 实例字段，全部在 `dispose()` 方法（line 449-537）中清理：

| # | 字段 | 类型 | 清理方式 | 行号 |
|---|------|------|---------|------|
| 1 | `_shortTerm` | Map | `.clear()` | 466 |
| 2 | `_longTerm` | Map | `.clear()` | 467 |
| 3 | `_bm25` | Map | `.clear()` | 468 |
| 4 | `_vector` | Map | `.clear()` | 469 |
| 5 | `_loaded` | Set | `.clear()` | 470 |
| 6 | `_pendingUser` | Map | `.clear()` | 471 |
| 7 | `_activeSessions` | Map | `.clear()` | 472 |
| 8 | `_dirtyAgents` | Set | `.clear()` | 473 |
| 9 | `_embeddingUpgraded` | Set | `.clear()` | 474 |
| 10 | `_graphs` | Map | `.clear()` | 475 |
| 11 | `_profiles` | Map | `.clear()` | 476 |
| 12 | `_dedup` | Map | `.clear()` | 477 |
| 13 | `_consolidation` | Map | `forEach(p => p.clear(''))` + `.clear()` | 480-481 |
| 14 | `_relations` | Map | `forEach(r => r.clear())` + `.clear()` | 482-483 |
| 15 | `_provenance` | Map | `forEach(p => p.clear())` + `.clear()` | 484-485 |
| 16 | `_snapshots` | Map | `.clear()` | 491 |
| 17 | `_slidingWindows` | Map | `.clear()` | 500 |
| 18 | `_temporalGraphs` | Map | `forEach(g => g.clear())` + `.clear()` | 505-506 |
| 19 | `_bloomFilters` | Map | `.clear()` | 508 |

**定时器**: `_sweepTimer` 在 dispose 中 `clearInterval` ✅
**Config 订阅**: `_configUnsub` 在 dispose 中调用 ✅（新增）

### 潜在风险（已缓解）
- **DedupManager 5 分钟窗口**: `_dedup` Map 中的 DedupManager 内部 `_entries` 数组在每次 `isDuplicate` 调用时自动清理过期条目 ✅
- **_flushTimer**: 延迟写入定时器，在 dispose 中未显式清理，但因 `unref()` 不会阻止进程退出

## P1-4: 配置热重载验证

### 发现的问题：❌ ConfigManager.onChange 未被调用

`ConfigManager` 提供了 `onChange(handler)` 方法用于热重载，但 `AgentMemoryProvider` 构造函数中**从未调用** `onChange` 订阅。这意味着运行时通过 `setConfig()` / `updateConfig()` 修改的配置值不会实际生效——搜索权重、RRF k 值等都是硬编码的。

### 修复内容

1. **新增实例字段**（替代硬编码常量）：
   - `_rrfK: number` — RRF 平滑常数（从 `config.search.rrfK` 读取）
   - `_searchWeights: { bm25, vector, graph, text, maxPerSession }` — 搜索权重（从 `config.search.*` 读取）

2. **新增 `_applyConfig()` 方法**：
   - 从 ConfigManager 读取 `search` 配置段
   - 更新 `_rrfK` 和 `_searchWeights` 实例字段

3. **构造函数中订阅 onChange**：
   ```typescript
   this._applyConfig(); // 初始化
   this._configUnsub = this._configManager.onChange((config, changes) => {
       this._applyConfig(); // 热重载
   });
   ```

4. **`_hybridSearch` 方法改用实例字段**：
   - `RRF_K` (模块常量) → `this._rrfK` (实例字段)
   - `0.35/0.40/0.15/0.10` (硬编码权重) → `this._searchWeights.bm25/vector/graph/text`
   - `MAX_PER_SESSION = 3` → `this._searchWeights.maxPerSession`

5. **dispose 中取消订阅**：
   ```typescript
   if (this._configUnsub) { this._configUnsub(); this._configUnsub = null; }
   ```

### 验证方式
```typescript
provider.setConfig('search.rrfK', 30);  // 立即生效
provider.setConfig('search.bm25Weight', 0.5);  // 立即生效
// 下次 _hybridSearch 调用时使用新值
```
