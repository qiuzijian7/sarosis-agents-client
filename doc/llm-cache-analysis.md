# agentmemory 源码缓存命中率优化特性分析及对比优化方案

> 对比项目：`G:\CustomWorkspaces\AIProjects\agentmemory` vs `sarosis-agents-client`
> 分析时间：2026-07-04

---

## 一、agentmemory 中的缓存相关特性

agentmemory 有 **5 个独立的缓存层**，从算法级到应用级逐层优化：

### 1.1 BM25 前缀缓存（算法级）

**文件**：`src/state/search-index.ts`

```typescript
private sortedTerms: string[] | null = null;  // 惰性缓存

getSortedTerms(): string[] {
    if (!this.sortedTerms) {
        this.sortedTerms = Array.from(this.invertedIndex.keys()).sort();
    }
    return this.sortedTerms;
}
```

- **失效策略**：写时失效（`add()/remove()/clear()` 时置 null）
- **使用方式**：通过 `lowerBound()` 二分查找前缀起始位置，线性扫描前缀匹配词条
- **作用**：避免每次搜索都对倒排索引 keys 重新排序（O(n log n) → O(log n + m)）

### 1.2 上下文注入缓存（应用级）

**文件**：`plugin/opencode/agentmemory-capture.ts`

```typescript
const startContextCache = new Map<string, string>();  // sessionId → context

// session.created: 调用 /session/start，缓存返回的 context
startContextCache.set(sessionId, startResult.context);

// chat.system.transform: 优读缓存，fallback 到 /context
let ctx = startContextCache.get(sid);
if (!ctx) ctx = (await postJson("/context", {...})).context;
else startContextCache.delete(sid);  // 用后即删

// session.deleted: 清理残留
startContextCache.delete(sid);
```

- **生命周期**：session.created 写入 → chat.system.transform 读取后删除（一次性）
- **作用**：避免 session 创建和 system transform 之间重复调用 `/context` API
- **价值**：减少 50% 的 context API 调用次数

### 1.3 请求内查询缓存（数据访问级）

**文件**：`src/functions/search.ts`

```typescript
const sessionCache = new Map<string, Session | null>();        // 按 sessionId
const memoryProjectCache = new Map<string, string | null>();  // 按 obsId

loadSession(sessionId):     缓存 session KV 查询
loadMemoryProject(obsId):   缓存 memory project KV 查询
```

- **生命周期**：单次 `mem::search` 调用期间（请求范围）
- **作用**：避免搜索结果的 project/session 过滤循环中重复数据库查询
- **价值**：一次搜索可能有 100+ 个候选结果，每个都要查 session，缓存可减少 99% 的重复查询

### 1.4 Context 组装稳定排序（语义级）

**文件**：`src/functions/context.ts`

上下文块的组装顺序是**固定的**：

```
1. Pinned slots（固定槽位，如 Persona）
2. Project profile（项目概况：概念、文件、约定、常见错误）
3. Lessons learned（经验教训：project-scoped 优先，按 confidence 排序，top 10）
4. Session summaries（有 summary 的会话）
5. Observations（无 summary 会话的高 importance observations）
   ↓ 全部按 recency 排序
   ↓ 按 token budget 贪心截断
6. 包装为 <agentmemory-context project="xxx"> tags
```

**关键设计**：固定的块组装顺序（slots → profile → lessons → sessions → observations）保证了相同输入产生相同的 context 字符串，这对 prompt cache 命中率至关重要。

### 1.5 Cache Token 观测（监控级）

**文件**：`plugin/opencode/agentmemory-capture.ts:315-316`

```typescript
tokens: {
    input: tokens?.input ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    cache_read: (tokens?.cache as any)?.read ?? 0,   // ← Anthropic cache 读数
    cache_write: (tokens?.cache as any)?.write ?? 0,  // ← Anthropic cache 写数
}
```

从 OpenCode 上报的 `message.updated` 事件中提取 Anthropic prompt cache 读/写 token 数，存入 session observation 作为长期监控指标。

### 1.6 额外：Token 缓存（矛盾检测）

**文件**：`src/functions/auto-forget.ts`

```typescript
const tokenCache = new Map<string, Set<string>>();  // memory → 分词缓存
```

用于 Jaccard 相似度计算的矛盾检测，避免对每个 memory pair 重复分词——这是计算优化而非缓存命中率优化。

---

## 二、agentmemory vs sarosis-agents-client 对比

### 2.1 功能对比矩阵

| 特性 | agentmemory | sarosis-agents-client | 差距 |
|------|------------|----------------------|------|
| BM25 前缀缓存 | ✅ sortedTerms + lowerBound | ❌ 无前缀缓存 | 🔴 缺失 |
| 上下文注入缓存 | ✅ startContextCache（用后即删） | ❌ 每次 loadContext 全量查询 | 🔴 缺失 |
| 请求内查询缓存 | ✅ sessionCache + memoryProjectCache | ❌ 搜索时重复 KV 查询 | 🟡 中等 |
| Context 组装稳定性 | ✅ 固定块顺序 + recency 排序 | ⚠️ 多个源拼接但无显式排序 | 🟡 中等 |
| Cache token 监控 | ✅ cache_read/write 记录 | ✅ prompt_tokens_details 消费过 | ✅ 都有 |
| Anthropic cache_control | ❌ 未使用 | ✅ messageFormatConverter 注入 | 🟢 sarosis 更好 |
| 冻结快照模式 | ❌ 未显式实现 | ✅ 代码注释 + 会话内不刷新 | 🟢 sarosis 更好 |
| 上下文压缩 | ❌ 无（仅 summerize） | ✅ Hermes 三段式 + anti-thrashing | 🟢 sarosis 更好 |
| Pre-compact 注入 | ✅ session.compacting hook | ✅ PreCompactInjector 4-Tier | ✅ 都有 |
| 压缩元数据嵌入 | ❌ | ✅ saros-compaction comment | 🟢 sarosis 更好 |

### 2.2 Context 组装对比

**agentmemory** (`context.ts` 的 `mem::context`):
```
[Pinned Slots] → [Project Profile] → [Lessons] → [Session Summaries] → [Observations]
→ 统一按 recency 排序 → 按 budget 贪心截断 → 包装进 <agentmemory-context>
```
特点：**稳定的块组装顺序 + recency 统一排序**

**sarosis** (`memoryProvider.ts:loadContext` + `agentOSService.ts`):
```
[_slots.buildSystemPrompt()] + [_workingMemory.buildContext()] + [_buildSystemPrompt(long,short)] + [consolidation.buildContext()]
→ 多个源直接拼接，无统一排序 → 包装进 <agentmemory-context>
```
特点：**多个独立源各自生成文本然后拼接 → 任意源变化都导致整体变化**

### 2.3 BM25 搜索性能对比

**agentmemory** (`search-index.ts`):
- 有 `sortedTerms` 前缀缓存，`lowerBound()` 二分查找
- 搜索结果按 BM25 分数排序，支持 prefix 匹配和 synonym 扩展
- 返回 `{obsId, sessionId, score}` 结构

**sarosis** (`bm25Index.ts`):
- 无前缀缓存，每次搜索遍历所有 terms
- 返回 `{id, score}`，无 sessionId 关联
- 无 synonym 扩展

---

## 三、优化方案（按优先级）

### 3.1 P0 — Context 组装顺序稳定化（对缓存命中影响最大）

**现状问题**：
```
// memoryProvider.ts loadContext 的输出是多个源直接拼接
systemPrompt = slots.buildSystemPrompt(agentId)
    + '\n\n' + workingMemory.buildContext(agentId)
    + '\n\n' + _buildSystemPrompt(topLong, topShort)
    + (consolidation.get(agentId)?.buildContext(agentId) ?? '');
```

**问题**：
- 各源各自管理输出格式，无统一的块抽象（ContextBlock）
- 各源内容变化时整体 systemPrompt 字符串变化
- 没有统一的递归排序/截断策略

**优化方案**：引入 ContextBlock 抽象 + 统一组装管线

```typescript
interface ContextBlock {
    type: 'slot' | 'profile' | 'lesson' | 'episodic' | 'semantic' | 'procedural' | 'working';
    content: string;
    tokens: number;
    recency: number;        // 时间戳，用于排序
    priority: number;       // 0=固定槽位, 1=核心记忆, 2=动态召回
    sourceIds?: string[];   // 来源 ID，用于访问记录
}

// 在 memoryProvider 中：
function assembleContext(agentId: string, budget: number): { text: string; blocks: ContextBlock[] } {
    const blocks: ContextBlock[] = [];
    
    // 1. 固定槽位（最高优先级，永不变化）
    blocks.push(...collectSlotBlocks(agentId, 'pinned'));
    
    // 2. Core memory（working memory 的 pinned 条目）
    blocks.push(...collectCoreMemoryBlocks(agentId));
    
    // 3. 高频 Lessons（按 confidence × project_score 排序，top 10）
    blocks.push(...collectLessonBlocks(agentId, project));
    
    // 4. Episodic/Semantic/Procedural（按 strength 排序）
    blocks.push(...collectConsolidationBlocks(agentId));
    
    // 统一按 (priority ASC, recency DESC, strength DESC) 排序
    blocks.sort((a, b) => a.priority - b.priority || b.recency - a.recency);
    
    // 按 budget 贪心截断
    const selected = selectByBudget(blocks, budget);
    
    return {
        text: `<agentmemory-context>\n${selected.map(b => b.content).join('\n\n')}\n</agentmemory-context>`,
        blocks: selected,
    };
}
```

**收益**：
- 固定块顺序 → 相同记忆产出来自组装管道同一位置 → prompt cache 命中率提升
- 统一截断策略 → 即使总块数变化，前 N 个块仍然一致
- 访问记录追踪 → `sourceIds` 可用于强化记忆

### 3.2 P1 — BM25 前缀缓存（搜索性能优化）

**现状**：sarosis 的 `bm25Index.ts` 每次 `search()` 都遍历所有倒排索引词条：
```typescript
// bm25Index.ts 当前实现
for (const [term, postingList] of this._index) {
    for (const id of postingList) {
        // BM25 打分
    }
}
```

**优化方案**：对齐 agentmemory 的 `sortedTerms` + `lowerBound` 模式

```typescript
private _sortedTerms: string[] | null = null;

private getSortedTerms(): string[] {
    if (!this._sortedTerms) {
        this._sortedTerms = Array.from(this._index.keys()).sort();
    }
    return this._sortedTerms;
}

// 二分查找
private lowerBound(arr: string[], target: string): number {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
}

// 在 add/remove/clear 时失效
add(docId: string, content: string): void {
    // ...
    this._sortedTerms = null;  // 写时失效
}
```

**收益**：搜索算法复杂度从 O(N)（遍历所有 term）降为 O(log N + M)（二分查找 + 前缀扫描）

### 3.3 P2 — 请求内查询缓存（减少重复 KV 读取）

**现状**：`memoryProvider.ts` 的 `_hybridSearch` 在过滤结果时可能重复调用 KV 读取：

```typescript
// 当前：每次都重新加载 long-term entries
const longEntries = this._longTerm.get(agentId) ?? [];
for (const result of searchResults) {
    const entry = longEntries.find(e => e.id === result.id);  // O(n) 每结果
}
```

**优化方案**：添加请求内缓存，对齐 agentmemory 的 `sessionCache` + `memoryProjectCache` 模式

```typescript
// 在 _hybridSearch 内部
const entryCache = new Map<string, IMemoryEntry | null>();  // id → entry

const getEntry = (id: string): IMemoryEntry | null => {
    if (entryCache.has(id)) return entryCache.get(id)!;
    const entry = longEntries.find(e => e.id === id) ?? null;
    entryCache.set(id, entry);
    return entry;
};

// 后续过滤循环中使用 getEntry(id) 代替直接 find
```

**收益**：搜索结果过滤时避免每次都对 longEntries 做 O(n) 查找（当搜索结果 100+ 个时，O(100n) → O(n+100)）

### 3.4 P3 — 搜索缓存（跨请求记忆）

**现状**：`memoryProvider.ts` 的 `_searchCache` 已经存在但只用于特定场景：
```typescript
private _searchCache = new SearchCache<IMemoryEntry[]>(100, 5 * 60 * 1000);
```

**优化方案**：将 search cache 扩展到 context 组装结果缓存，对齐 agentmemory 的 `startContextCache` 模式

```typescript
// 新增 context 结果缓存
private _contextCache = new Map<string, { result: string; hash: string; ts: number }>();

async loadContext(agentId: string, sessionId: string, query?: string, options?: any) {
    // 计算当前记忆状态的指纹
    const memoryFingerprint = this._computeMemoryFingerprint(agentId);
    const cacheKey = `${agentId}::${this._tokenBudget}::${options?.scope ?? 'agent'}`;
    
    const cached = this._contextCache.get(cacheKey);
    if (cached && cached.hash === memoryFingerprint) {
        return cached.result;  // 缓存命中，跳过重建
    }
    
    // 正常重建
    const result = await this._buildContext(agentId, sessionId, query, options);
    this._contextCache.set(cacheKey, { result, hash: memoryFingerprint, ts: Date.now() });
    return result;
}
```

**收益**：在记忆未变化的连续请求中，避免重复执行 context 组装

### 3.5 P4 — 压缩后注入位置修复（见上轮分析）

如前次分析指出，当前 `contextManager.ts:1934` 将 Pre-compact 注入消息放在 `finalMessages` 最前面：
```typescript
finalMessages = [
    { role: 'system', content: injectResult.injectedContext },  // ← 最前面，破坏缓存
    ...sanitized,
];
```

**修复**：将注入放在固定 system 之后、摘要之前

### 3.6 P5 — 缓存命中率监控增强

**现状**：已消费 `prompt_tokens_details.cached_tokens`，但未持久化观测。

**优化方案**：对齐 agentmemory，将缓存 token 数据写入 memory observation

```typescript
// 在 agentOSService.ts 每轮迭代后
if (usage?.cache_read_input_tokens > 0 || usage?.cache_creation_input_tokens > 0) {
    await memProvider.writeMemory(agentId, {
        id: `cache-metric-${Date.now()}`,
        type: 'working',
        content: `Cache: read=${usage.cache_read_input_tokens} write=${usage.cache_creation_input_tokens} total=${usage.total_tokens}`,
        metadata: {
            source: 'cache_metrics',
            cacheRead: usage.cache_read_input_tokens,
            cacheWrite: usage.cache_creation_input_tokens,
            totalTokens: usage.total_tokens,
        },
        timestamp: Date.now(),
    });
}
```

---

## 四、对比总结

| 维度 | agentmemory | sarosis-agents-client | 优化方向 |
|------|------------|----------------------|----------|
| Context 组装 | ✅ ContextBlock + 固定顺序 + 统一截断 | ❌ 多源直接拼接，无统一抽象 | P0 |
| BM25 前缀缓存 | ✅ sortedTerms + lowerBound | ❌ 全量遍历 | P1 |
| 请求内查询缓存 | ✅ sessionCache + memoryProjectCache | ❌ O(n²) 查找 | P2 |
| Context 结果缓存 | ✅ startContextCache（一次性） | ❌ 每请求重建 | P3 |
| 注入位置 | ✅ session.compacting hook 自然位置 | ❌ finalMessages 最前端破坏缓存 | P4 |
| 缓存监控 | ✅ cache_read/write 持久化 | ✅ 消费但不持久化 | P5 |
| Anthropic cache_control | ❌ | ✅ messageFormatConverter 注入 | sarosis 领先 |
| 冻结快照 | ❌ | ✅ 会话内不刷新 | sarosis 领先 |
| 抗抖动压缩 | ❌ | ✅ anti-thrashing + 窗口重载保护 | sarosis 领先 |

**核心理念差异**：agentmemory 在 context **组装层面**做了稳定化设计（ContextBlock 抽象 + 固定排序 + 统一截断），而 sarosis 在 **API 层面**做了更多 LLM 缓存优化（cache_control 注入 + 冻结快照 + 压缩元数据）。两者互补——sarosis 应该吸收 agentmemory 的组装层优化，同时保持自己的 API 层优势。
