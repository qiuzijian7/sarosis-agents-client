# agentmemory 缓存命中率深度对比分析（第二轮）

> 分析时间：2026-07-04
> 对比项目：`G:\CustomWorkspaces\AIProjects\agentmemory` vs `sarosis-agents-client`
> 前置：已实施 P0-P5 优化，此轮为细节级深度对比

---

## 一、缓存清单总览

### agentmemory 缓存层（共 9 个）

| # | 缓存名 | 文件 | 类型 | TTL | 失效策略 | sarosis 对等 |
|---|--------|------|------|-----|----------|--------------|
| 1 | `startContextCache` | plugin L72 | session 级 context | 无 | consume-on-read + session.deleted | ✅ `_sessionContextCache` (已实现) |
| 2 | `contextInjectedSessions` | plugin L66 | Set<sessionId> 注入去重 | 无 | session.deleted | ❌ 缺失 |
| 3 | `stashedFiles` | plugin L63 | Map<sid,Set<path>> 文件路径暂存 | 无 | 消费逐个删 + session.deleted | ❌ 缺失 |
| 4 | `seenSubtaskIds` | plugin L64 | Map<sid,Set<id>> 子任务去重 | 无 | session.deleted | ❌ 缺失 |
| 5 | `seenToolCallIds` | plugin L65 | Map<sid,Set<id>> 工具调用去重 | 无 | session.deleted | ❌ 缺失 |
| 6 | `sortedTerms` | search-index L17 | BM25 词条排序 | 无 | 写时失效 | ✅ `_sortedTerms` (已实现) |
| 7 | `lowerBound` | search-index L271 | 二分查找 | N/A | N/A | ✅ `_lowerBound` (已实现) |
| 8 | `obsCache` | file-index L61 | 单次调用局部缓存 | 函数生命周期 | 局部变量 | ⚠️ 部分 (`_hybridSearch.entryMap`) |
| 9 | `_contextCache` | (本项目新增) | 跨请求 context 结果 | 60s | 写时 + 版本号 | ✅ 本项目独有 |

### sarosis 独有缓存（agentmemory 没有）

| # | 缓存名 | 文件 | 说明 |
|---|--------|------|------|
| A | `_contextCache` | memoryProvider L526 | 跨请求 context 结果缓存（fingerprint + 60s TTL） |
| B | `_sessionContextCache` | memoryProvider L531 | session 生命周期内 context 缓存 |
| C | `_searchCache` | memoryProvider L524 | LRU 搜索结果缓存（100 条，5 分钟 TTL） |
| D | `_contextGeneration` | memoryProvider L529 | 版本号失效机制 |
| E | Anthropic `cache_control` | messageFormatConverter | 消息级 cache 标记 |
| F | 冻结快照 | agentOSService L920-1055 | 会话内不刷新注入 |
| G | anti-thrashing | contextManager | 压缩抗抖动 |

---

## 二、逐项深度对比

### 2.1 startContextCache — 会话级上下文预取

#### agentmemory 实现

```typescript
// plugin L72
const startContextCache = new Map<string, string>();

// session.created (L191-204): 预取并缓存
const startResult = await postJson("/session/start", { sessionId, ... });
const startCtx = startResult?.context;
if (startCtx) startContextCache.set(sessionId, startCtx);

// chat.system.transform (L611-620): 读取后删除
let ctx = startContextCache.get(sid);
if (!ctx) {
    ctx = (await postJson("/context", { sessionId, project })).context;  // fallback
} else {
    startContextCache.delete(sid);  // consume-on-read
}

// session.deleted (L276): 清理
startContextCache.delete(sid);
```

**关键细节**：
1. **consume-on-read**：读取后立即删除，防止同一 session 多次注入
2. **fallback**：缓存未命中时实时调用 `/context`
3. **session.created 即时预取**：不等 chat.system.transform 才请求
4. **快照不变性**：缓存的是 session 创建时刻的 context 快照

#### sarosis 实现

```typescript
// memoryProvider.ts L531
private _sessionContextCache = new Map<string, IMemoryContext>();

// loadContext: 新会话首轮缓存
if (isNewSession && (!query || query.trim().length === 0)) {
    this._sessionContextCache.set(agentId, result);
}

// 后续无 query 时直接返回
if (!isNewSession && this._sessionContextCache.has(agentId) && (!query || query.trim().length === 0)) {
    return this._sessionContextCache.get(agentId)!;
}

// _endSession / _invalidateContextCache: 清除
```

#### 差异分析

| 维度 | agentmemory | sarosis | 差距 |
|------|-------------|---------|------|
| 缓存键 | `sessionId` | `agentId` | sarosis 用 agentId 可能跨多个 sessionId 复用 |
| consume-on-read | ✅ 读取后删除 | ❌ 不删除，持续复用 | sarosis 更激进（持续命中） |
| 有 query 时不缓存 | N/A (总是无 query) | ✅ 有 query 时跳过 | sarosis 更智能 |
| 写操作失效 | N/A (server 端处理) | ✅ `_invalidateContextCache` | sarosis 更完整 |
| 预取时机 | session.created 立即预取 | loadContext 首次调用时 | sarosis 懒加载 |

**优化建议 P6**：sarosis 的 `_sessionContextCache` 用 agentId 做 key，但一个 agent 可能有多轮会话（不同 sessionId）。当前实现中 `_endSession` 会清除缓存，但 `loadContext` 被调用时 `sessionId` 参数未被用于 key。建议：用 `${agentId}::${sessionId}` 做 key，确保跨 session 不串数据。

### 2.2 contextInjectedSessions — 注入幂等去重

#### agentmemory 实现

```typescript
// plugin L66
const contextInjectedSessions = new Set<string>();

// chat.system.transform (L605, L624)
if (!contextInjectedSessions.has(sid)) {
    // ... 注入 instructions + context
    contextInjectedSessions.add(sid);
}

// session.deleted (L279)
contextInjectedSessions.delete(sid);
```

**设计意图**：防止同一 session 被多次注入 `AGENTMEMORY_INSTRUCTIONS` 和 context。

#### sarosis 现状

```typescript
// agentOSService.ts L920-1055
// 每次 executeAgentTurn 都会调用 loadContext + 注入
// 但 memoryProvider 内部有 _sessionContextCache 缓存，所以 context 内容相同
// 然而：注入逻辑本身没有幂等去重
```

**差异**：sarosis 的 agentOSService 每轮都执行注入逻辑（即使 context 内容相同）。虽然 context 内容相同（因为缓存命中），但注入操作本身的开销（XML 标签组装、消息数组操作）每轮都执行。

**优化建议 P7**：在 agentOSService 中添加 `injectedSessions: Set<string>`，同一 session 只注入一次。

### 2.3 stashedFiles — 文件路径暂存

#### agentmemory 实现

```typescript
// plugin L63
const stashedFiles = new Map<string, Set<string>>();

// tool.execute (L471, L542, L590): 收集文件路径
for (const fp of extractFilePaths(args)) {
    stash.add(fp);
}

// chat.system.transform (L629-642): 批量 enrich
const files = [...stash].slice(0, 10);
const enrichResult = await postJson("/enrich", { sessionId, files, toolName: "enrich_inject" });
for (const f of files) stash.delete(f);  // 消费后删除
```

**设计意图**：工具执行时收集涉及的文件路径，在下一轮 system.transform 时批量 enrich（避免每个工具调用都触发 enrich）。

#### sarosis 现状

sarosis 没有等价机制。工具执行后不暂存文件路径，也没有批量 enrich 管道。

**差距**：这是 agentmemory 独有的"文件级上下文增强"机制，对代码理解类任务有帮助。

**优化建议 P8（架构级）**：在 agentOSService 中添加 `stashedFiles` 机制，工具执行时收集文件路径，下一轮 loadContext 时批量 enrich。

### 2.4 seenSubtaskIds / seenToolCallIds — 去重集合

#### agentmemory 实现

```typescript
// plugin L64-65
const seenSubtaskIds = new Map<string, Set<string>>();
const seenToolCallIds = new Map<string, Set<string>>();

// subtask.execute (L348): 检查并添加
if (!subtaskSet.has(subtaskId)) {
    subtaskSet.add(subtaskId);
    await observe(sessionId, "subtask", { ... });
}

// tool.execute (L368): 检查并添加
if (!toolCallSet.has(toolCallId)) {
    toolCallSet.add(toolCallId);
    await observe(sessionId, "tool_call", { ... });
}
```

**设计意图**：防止重复 observe 同一 subtask/tool call（如流式重试、compaction 后重放）。

#### sarosis 现状

sarosis 的 `writeMemory` 有 `DedupManager`（内容哈希去重），但没有按 `toolCallId` 去重的机制。

**差异**：sarosis 用内容哈希去重（更宽松），agentmemory 用 ID 去重（更精确）。

**优化建议 P9**：在 `memoryProvider.writeMemory` 中增加 `toolCallId` 维度去重（metadata 中带 `toolCallId` 时检查）。

### 2.5 BM25 sortedTerms + lowerBound — 已对齐

#### 完全对齐

| 维度 | agentmemory | sarosis |
|------|-------------|---------|
| `sortedTerms` 类型 | `string[] \| null` | `string[] \| null` |
| 写时失效 | `add()` L47, `remove()` L74, `clear()` L171, `restoreFrom()` L191 | `add()`, `remove()`, `clear()` |
| `getSortedTerms()` | L264-269 惰性初始化 | `_getSortedTerms()` |
| `lowerBound()` | L271-280 二分查找 | `_lowerBound()` |
| 前缀匹配权重 | `* 0.5` (L136) | `* 0.5` |
| 同义词扩展权重 | `0.7` (L98) | 无权重（直接加 IDF） |

**差异**：agentmemory 的同义词有权重（0.7），sarosis 的同义词无权重（直接加 IDF）。

**优化建议 P10**：sarosis BM25 的同义词扩展应加权重（精确匹配 > 同义词 > 前缀匹配）。

### 2.6 context.ts — ContextBlock 组装

#### agentmemory 实现

```typescript
// context.ts L199
blocks.sort((a, b) => b.recency - a.recency);

// 贪心截断
for (const block of blocks) {
    if (usedTokens + block.tokens > budget) continue;
    selected.push(block.content);
    usedTokens += block.tokens;
    if (block.sourceIds) accessedIds.push(...block.sourceIds);
}

// recordAccessBatch
void recordAccessBatch(kv, accessedIds);
```

**关键细节**：
1. **所有 block 平等排序**（只按 recency 降序），没有 priority 分层
2. **读取时写回 accessCount**（write-through on read）
3. **批量记录访问**（`recordAccessBatch`）

#### sarosis 实现

```typescript
// contextBuilder.ts selectWithBudgetAndPriority
// 按 (priority ASC, recency DESC) 排序
const sorted = [...blocks].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.recency - a.recency;
});

// priority=0 的固定块不受 budget 限制
if (block.priority === 0) {
    selected.push(block);
    usedTokens += block.tokens;
    continue;
}
```

#### 差异分析

| 维度 | agentmemory | sarosis |
|------|-------------|---------|
| 排序策略 | 仅 recency | priority + recency |
| 固定块保护 | ❌ 无 | ✅ priority=0 不受 budget 限制 |
| 读取写回 accessCount | ✅ write-through | ❌ 无 |
| 批量记录访问 | ✅ `recordAccessBatch` | ⚠️ `_slidingWindow.access()` 逐个记录 |
| block 类型 | memory/summary/observation | slot/lesson/episodic/semantic/procedural/working |

**优化建议 P11**：sarosis 的 ContextBlock 选择应增加"读取时写回 accessCount"机制（对齐 agentmemory 的 write-through on read），提升热点记忆的评分。

### 2.7 working-memory.ts — Core + Archival 分层

#### agentmemory 实现

```typescript
// working-memory.ts L114
const coreBudget = Math.floor(budget * 0.3);  // 30% 给 core
// 剩余 70% 给 archival

// L118-127: core 先选 pinned，再选 unpinned（按 scoreEntry 排序）
for (const entry of [...pinned, ...unpinned]) {
    if (usedTokens + tokens > coreBudget && !entry.pinned) continue;
    coreLines.push(`- ${entry.content}`);
    // write-through: 读取时递增 accessCount + lastAccessedAt
    entry.accessCount++;
    entry.lastAccessedAt = accessTimestamp;
    accessUpdates.push({ id: entry.id, entry });
}

// L129-131: 异步写回
Promise.allSettled(accessUpdates.map(({ id, entry }) => kv.set(CORE_SCOPE, id, entry))).catch(() => {});

// L194-253: auto-page — core 超预算时降级到 archival
```

#### sarosis 现状

sarosis 没有明确的 "core memory" vs "archival memory" 分层。所有记忆在 `_longTerm` / `_shortTerm` 中，`loadContext` 按 strength 排序选择。

**差异**：
1. agentmemory 有 core（高优先级、pinned）+ archival（低优先级）分层
2. agentmemory 的 core memory 有 auto-page 机制（超预算自动降级）
3. agentmemory 读取时写回 accessCount（write-through）

**优化建议 P12**：sarosis 的 `IMemoryEntry` 已有 `importance` 和 `strength`，但缺少 `pinned` 字段和 auto-page 降级机制。

### 2.8 scoreEntry 评分函数

#### agentmemory

```typescript
// working-memory.ts L25-32
function scoreEntry(entry: CoreMemoryEntry, now: number): number {
    const recencyDays = (now - new Date(entry.lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24);
    const recencyScore = 1 / (1 + recencyDays * 0.1);  // 时间衰减
    const accessScore = Math.log2(entry.accessCount + 1) / 10;  // 对数访问
    const importanceScore = entry.importance / 10;
    return importanceScore * 0.5 + recencyScore * 0.3 + accessScore * 0.2;
}
```

#### sarosis

sarosis 的 `loadContext` 按 `strength` 排序，`strength` 由 `MemoryDecay` 管理（时间衰减 + 访问增强），但没有明确的三因子加权公式。

**差异**：agentmemory 的评分是三因子加权（importance 0.5 + recency 0.3 + access 0.2），sarosis 是单一 strength 值。

**优化建议 P13**：sarosis 的 strength 计算可借鉴三因子加权公式，使评分更均衡。

---

## 三、优化方案

按优先级排序：

### P6 — sessionContextCache key 改用 agentId+sessionId

**问题**：当前用 `agentId` 做 key，跨 session 可能串数据。

**方案**：
```typescript
// 改用复合 key
const sessionKey = `${agentId}::${sessionId}`;
this._sessionContextCache.set(sessionKey, result);

// 读取
const cached = this._sessionContextCache.get(`${agentId}::${sessionId}`);
```

### P7 — 注入幂等去重

**问题**：agentOSService 每轮都执行注入逻辑（即使 context 内容相同）。

**方案**：
```typescript
// agentOSService.ts
private _injectedSessions = new Set<string>();

// 在 loadContext + 注入逻辑中
if (!this._injectedSessions.has(sessionId)) {
    // ... 执行注入
    this._injectedSessions.add(sessionId);
}
```

### P8 — 文件路径暂存 + 批量 enrich（架构级）

**问题**：工具执行后不暂存文件路径，无法批量增强。

**方案**：在 agentOSService 中添加 `stashedFiles` 机制。

### P9 — toolCallId 维度去重

**问题**：writeMemory 用内容哈希去重，流式重试时同一 toolCallId 可能重复写入。

**方案**：writeMemory 时检查 metadata.toolCallId。

### P10 — BM25 同义词权重

**问题**：同义词无权重，精确匹配和同义词贡献相同。

**方案**：
```typescript
// 精确匹配 weight=1.0
// 同义词 weight=0.7
// 前缀匹配 weight=0.5
```

### P11 — 读取时写回 accessCount

**问题**：loadContext 读取记忆时不递增 accessCount，热点记忆评分不提升。

**方案**：在 loadContext 选中 topLong 后，异步写回 accessCount++。

### P12 — Core/Archival 分层 + auto-page

**问题**：所有记忆平等，没有 pinned 保护和高频降级。

**方案**：IMemoryEntry 添加 `pinned` 字段；loadContext 优先选 pinned；超预算时降级低分到 archival。

### P13 — 三因子加权评分

**问题**：单一 strength 值不如三因子加权均衡。

**方案**：strength = importance*0.5 + recency*0.3 + access*0.2。

---

## 四、对比总结

| 维度 | agentmemory | sarosis | 优化方向 |
|------|-------------|---------|----------|
| startContextCache | consume-on-read | 持续复用 | P6 key 改进 |
| 注入幂等去重 | ✅ Set<sid> | ❌ | P7 |
| 文件路径暂存 | ✅ stashedFiles | ❌ | P8 |
| subtask/toolCall 去重 | ✅ ID 去重 | ⚠️ 内容哈希 | P9 |
| BM25 同义词权重 | ✅ 0.7 | ❌ 无权重 | P10 |
| 读取写回 accessCount | ✅ write-through | ❌ | P11 |
| Core/Archival 分层 | ✅ + auto-page | ❌ | P12 |
| 三因子评分 | ✅ 0.5/0.3/0.2 | ⚠️ 单一 strength | P13 |
| 跨请求 context 缓存 | ❌ | ✅ fingerprint + TTL | sarosis 领先 |
| LRU 搜索缓存 | ❌ | ✅ 100 条 5 分钟 | sarosis 领先 |
| Anthropic cache_control | ❌ | ✅ | sarosis 领先 |
| 冻结快照 | ❌ | ✅ 会话内不刷新 | sarosis 领先 |
| anti-thrashing | ❌ | ✅ | sarosis 领先 |
| ContextBlock priority | ❌ 仅 recency | ✅ priority + recency | sarosis 领先 |
