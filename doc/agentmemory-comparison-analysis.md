# AgentMemory 记忆数据加载功能对比分析

> 对比项目：`G:\CustomWorkspaces\AIProjects\agentmemory`（原版）vs `sarosis-agents-client`（本项目）

---

## 一、架构对比

### 原版 agentmemory

```
┌─ Renderer (MCP Client) ──────────────────────────────┐
│  LLM Agent → MCP Tools (observe/remember/search)     │
└───────────────────────┬──────────────────────────────┘
                        │ JSON-RPC / HTTP
┌───────────────────────▼──────────────────────────────┐
│  iii-engine (独立进程, port 3111)                     │
│  ┌─ StateKV ────────┐  ┌─ IndexPersistence ────────┐ │
│  │ state::get/set   │  │ 分片(Shard)机制 ~2MB/块    │ │
│  │ state::list      │  │ BM25 + Vector 独立持久化   │ │
│  └──────────────────┘  └────────────────────────────┘ │
│  ┌─ Triggers (REST) ─┐  ┌─ Health Monitor ─────────┐ │
│  │ /observe /search  │  │ 自动重连 + 降级          │ │
│  └──────────────────┘  └────────────────────────────┘ │
└───────────────────────┬──────────────────────────────┘
                        │ iii-sdk 原语
┌───────────────────────▼──────────────────────────────┐
│  底层存储 (SQLite / 内存 / 文件系统)                   │
└──────────────────────────────────────────────────────┘
```

### 本项目 sarosis-agents-client

```
┌─ Renderer (Electron Browser) ────────────────────────┐
│  AgentMemoryProvider (内存 Maps)                      │
│  ┌─ _shortTerm / _longTerm ──┐  ┌─ BM25 / Vector ──┐ │
│  │  in-memory only            │  │  in-memory only  │ │
│  └────────────┬───────────────┘  └────────┬─────────┘ │
│               │ _flushPendingWrites()      │           │
│               │ writeFile() HTTP PUT       │           │
│  ┌────────────▼───────────────┐  ┌────────▼─────────┐ │
│  │ fetch → host.mjs:3111      │  │ fetch → host.mjs │ │
│  │ PUT /mem/<id>/<file>       │  │ (单个 JSON 文件) │ │
│  └────────────────────────────┘  └──────────────────┘ │
└───────────────────────────────────────────────────────┘
                        │ HTTP (需 CORS)
┌───────────────────────▼──────────────────────────────┐
│  host.mjs (子进程, port 3111)                         │
│  原子写入 .jsonl 文件到 ~/.saros/.agentmemory/        │
└──────────────────────────────────────────────────────┘
```

---

## 二、关键差异对比

| 维度 | 原版 agentmemory | 本项目 sarosis | 差距 |
|------|------------------|----------------|------|
| **底层存储** | iii-engine StateKV (SQLite/内存) | host.mjs HTTP 文件服务器 | 本项目依赖 HTTP fetch，有 CORS/网络问题 |
| **索引持久化** | 分片(Shard)机制 ~2MB/块 | 整体序列化为单个 JSON | 大索引可能超 HTTP 限制 |
| **防抖延迟** | 5000ms (DEBOUNCE_MS) | 1000ms (已优化) | 本项目更激进，但原版有 iii-engine 可靠写入兜底 |
| **错误处理** | logFailure() 带 60s 节流 + 不崩溃 | console.error 无节流 | 原版更健壮 |
| **加载机制** | StateKV.get() 同步可靠 | HTTP fetch + CORS 依赖 | 原版无网络依赖 |
| **维度校验** | 有（防止 provider 切换损坏索引） | 无 | 本项目切换 embedding provider 后索引可能损坏 |
| **索引重建** | 索引为空时自动 rebuild | 无 | 本项目索引丢失后无法恢复 |
| **信号处理** | SIGINT/SIGTERM → save() + shutdown() | dispose() fire-and-forget | 原版确保关闭时刷盘 |
| **数据格式** | KV scope (结构化) | JSONL (文本行) | 各有优劣 |
| **健康监控** | HealthMonitor 自动重连+降级 | checkHealth() 一次性 | 原版更鲁棒 |

---

## 三、本项目已修复的问题（本次会话）

| 问题 | 根因 | 修复 |
|------|------|------|
| CORS 拒绝 | host.mjs 未设置 CORS 头 | 添加 `Access-Control-Allow-Origin: *` |
| `raw.trim is not a function` | readFile 用 `resp.json()` 解析 JSONL | 改用 `resp.text()` |
| 启动时序 | `_serverAvailable=false` 后永不重试 | 不标记 `_loaded`，允许重试 |
| 防抖过长 | 5000ms 延迟 | 降至 1000ms + 30s 定期保存 |
| 教训页签卡死 | `_renderEmpty()` 清除导航栏 | 重新渲染 `_renderViewNav()` |

---

## 四、优化方案（按优先级）

### P0: 索引分片持久化（防止大索引写入失败）

**问题**：当前 `vector-index.json` 整体序列化为单个 JSON 字符串，通过 HTTP PUT 写入。当索引过大时（>5MB），可能超过 HTTP 请求体限制或导致写入超时。

**原版方案**：`IndexPersistence` 将序列化数据按 ~2MB 分块，通过 manifest 管理分片位置。

**本项目优化**：

```typescript
// memoryProvider.ts
private static readonly INDEX_SHARD_SIZE = 2_000_000; // 2MB per shard

private async _writeShardedIndex(agentId: string, baseFile: string, serialized: string): Promise<void> {
    const shards: Array<{ index: number; data: string }> = [];
    for (let i = 0; i < serialized.length; i += AgentMemoryProvider.INDEX_SHARD_SIZE) {
        shards.push({ index: shards.length, data: serialized.slice(i, i + AgentMemoryProvider.INDEX_SHARD_SIZE) });
    }
    const manifest = { v: 1, shardCount: shards.length, chars: serialized.length };
    
    // 写入 manifest
    await writeFile(agentId, `${baseFile}.manifest`, JSON.stringify(manifest));
    // 写入各分片
    await Promise.all(shards.map(s => writeFile(agentId, `${baseFile}.shard.${s.index}`, s.data)));
}

private async _readShardedIndex(agentId: string, baseFile: string): Promise<string> {
    const manifestRaw = await readFile(agentId, `${baseFile}.manifest`);
    if (!manifestRaw || manifestRaw.trim().length === 0) {
        // 回退到旧格式（兼容）
        return await readFile(agentId, baseFile);
    }
    const manifest = JSON.parse(manifestRaw);
    const shards = await Promise.all(
        Array.from({ length: manifest.shardCount }, (_, i) => readFile(agentId, `${baseFile}.shard.${i}`))
    );
    return shards.join('');
}
```

### P1: 维度校验（防止 provider 切换损坏索引）

**问题**：切换 embedding provider 后，向量维度可能不同（如 384 → 768），旧索引无法使用但不会报错，导致搜索结果错误。

**原版方案**：加载时校验向量维度，不匹配则丢弃旧索引并重建。

**本项目优化**：

```typescript
// memoryProvider.ts - _ensureLoaded() 中
if (vectorRaw && vectorRaw.trim().length > 0) {
    const expectedDim = embed('test')?.length ?? 0;
    const restored = vector.deserialize(vectorRaw);
    if (restored > 0 && vector.dimension !== expectedDim) {
        console.warn(`[AgentMemory] vector dimension mismatch: stored=${vector.dimension}, expected=${expectedDim}, rebuilding index`);
        vector = new VectorIndex(); // 丢弃旧索引
        // 重新计算所有 embedding
        for (const entry of longEntries) {
            const vec = embedSyncCached(entry.content);
            if (vec) vector.add(entry.id, vec);
        }
    }
}
```

### P2: 索引重建机制（索引丢失后自动恢复）

**问题**：如果 `vector-index.json` 文件损坏或丢失，索引无法恢复，搜索功能降级。

**原版方案**：索引为空时遍历所有 observations 重建。

**本项目优化**：

```typescript
// memoryProvider.ts - _ensureLoaded() 中
if (restoredVectors === 0 && longEntries.length > 0) {
    console.log(`[AgentMemory] no persisted vectors, rebuilding from ${longEntries.length} entries`);
    for (const entry of longEntries) {
        if (entry.supersededBy) continue;
        const vec = embedSyncCached(entry.content);
        if (vec) vector.add(entry.id, vec);
    }
    this._schedulePersist(agentId); // 保存重建的索引
}
```

### P3: 错误处理增强（节流日志 + 重试）

**问题**：当前错误日志无节流，高频失败时刷屏；写入失败后无重试。

**原版方案**：`logFailure()` 带 60s 节流；iii-engine 内部有重试。

**本项目优化**：

```typescript
// memoryProvider.ts
private _lastFailureLogAt = 0;
private static readonly FAILURE_LOG_THROTTLE_MS = 60_000;

private _logPersistenceFailure(err: unknown): void {
    const now = Date.now();
    if (now - this._lastFailureLogAt < AgentMemoryProvider.FAILURE_LOG_THROTTLE_MS) return;
    this._lastFailureLogAt = now;
    console.error('[AgentMemory] persistence failure (throttled 60s):', err);
}
```

### P4: host.mjs 信号处理（确保关闭时刷盘）

**问题**：host.mjs 有 SIGINT/SIGTERM 处理，但 AgentMemoryProvider 在渲染进程中，`dispose()` 的 flush 是 fire-and-forget。

**原版方案**：SIGINT/SIGTERM → `indexPersistence.save()` → `sdk.shutdown()`。

**本项目优化**：

```typescript
// memoryProvider.ts - 构造函数中
// 监听页面卸载事件，同步触发 flush
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        if (this._dirtyAgents.size > 0) {
            // 使用同步 XHR 确保数据发送（fetch 在 beforeunload 中不可靠）
            const data = JSON.stringify({
                agents: Array.from(this._dirtyAgents),
                longTerm: Array.from(this._longTerm.entries()).map(([id, entries]) => [id, entries]),
                shortTerm: Array.from(this._shortTerm.entries()).map(([id, entries]) => [id, entries]),
            });
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${serverBase()}/flush-all`, false); // 同步
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(data);
        }
    });
}
```

```javascript
// host.mjs - 添加 /flush-all 端点
if (url.pathname === '/flush-all' && req.method === 'POST') {
    const body = await collectBody(req);
    const { agents, longTerm, shortTerm } = JSON.parse(body);
    for (const [agentId, entries] of [...longTerm, ...shortTerm]) {
        const file = longTerm.some(([id]) => id === agentId) ? 'long-term.jsonl' : 'short-term.jsonl';
        const jsonl = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
        const agentDir = path.join(dataDir, sanitize(agentId));
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, file), jsonl, 'utf8');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
}
```

### P5: 健康监控（自动重连 + 降级）

**问题**：当前 `checkHealth()` 只在首次调用时检查，之后即使服务器恢复也不重试（已部分修复，但重试逻辑较简单）。

**原版方案**：`HealthMonitor` 持续监控，自动重连，降级到内存模式。

**本项目优化**：

```typescript
// memoryProvider.ts - 添加健康监控定时器
private _healthMonitorTimer: ReturnType<typeof setInterval> | undefined;

// 构造函数中
this._healthMonitorTimer = setInterval(async () => {
    if (!this._serverAvailable) {
        const healthy = await checkHealth();
        if (healthy) {
            console.log('[AgentMemory] server recovered! reloading all agents...');
            this._serverAvailable = true;
            this._healthChecked = true;
            // 重新加载所有已加载的 agent
            for (const agentId of this._loaded) {
                this._loaded.delete(agentId);
                await this._ensureLoaded(agentId);
            }
        }
    }
}, 60_000); // 每分钟检查一次
```

---

## 五、总结

本项目已通过 CORS 修复、JSONL 解析修复、启动时序修复解决了数据丢失的核心问题。后续优化应聚焦于：

1. **P0 分片持久化** — 防止大索引写入失败
2. **P1 维度校验** — 防止 provider 切换损坏索引
3. **P2 索引重建** — 索引丢失后自动恢复
4. **P3 错误处理** — 节流日志 + 重试
5. **P4 信号处理** — 确保关闭时刷盘
6. **P5 健康监控** — 自动重连 + 降级
