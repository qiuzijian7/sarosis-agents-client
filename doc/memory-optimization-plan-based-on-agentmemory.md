# 记忆系统优化方案（参考 agentmemory）

> **文档信息**
> - 创建时间：2026-06-25
> - 版本：v1.0
> - 参考项目：[rohitg00/agentmemory](https://github.com/rohitg00/agentmemory) v0.9.27（Apache-2.0）
> - 适用范围：vssaros-agents-client 记忆子系统（`SessionMemoryProvider` / `VectorMemory` / L0/L1 管道）
> - 关联文档：`Memory-Strategy.md`、`memory-framework-refactoring-and-hermes-comparison.md`、`openhuman-vs-saros-knowledge-memory-system-comparison.md`

---

## 一、背景与目标

### 1.1 问题陈述

当前 `SessionMemoryProvider` + `VectorMemory` 存在以下短板（对照 agentmemory）：

| 维度 | 当前实现 | agentmemory 参考 | 差距 |
|------|----------|-------------------|------|
| 关键词搜索 | `String.includes()` 子串匹配 | BM25（k1=1.2, b=0.75）+ 词干化 + 同义词 + 前缀匹配 | 无相关性打分 |
| 向量搜索 | TF-IDF 占位（`vectorMemory.ts` 注释"后续可替换"） | 6 provider + 本地 all-MiniLM-L6-v2（384 维） | 非生产级 |
| 混合融合 | 无 | RRF（k=60）三流加权 | 无融合 |
| 记忆衰减 | 无（长期记忆无限累积） | Ebbinghaus 曲线 `strength *= 0.9^(decayPeriods)` | 文件膨胀 |
| 自动遗忘 | 无 | TTL 过期 + 重要性驱逐 + 项目上限 10000 | 无清理 |
| 隐私过滤 | 无（secret/API key 可直接落盘） | 15+ 正则模式剥离 | **安全风险** |
| 矛盾检测 | 无 | supersedes 链 + contradicts 关系 | 过时信息残留 |
| 知识图谱 | 依赖外部 codebase-memory-mcp | 内建实体抽取 + BFS 遍历 + 时态查询 | 非内建 |
| 自动捕获 | 仅 AgentDriver finally 块 | 12 hook（SessionStart/PreToolUse/PostToolUse/Stop...） | 粒度粗 |
| 基准测试 | 无 | LongMemEval-S R@5=95.2% | 质量未知 |

### 1.2 优化原则

1. **保持进程内架构** — 不引入 iii-engine / Docker / 独立 server，所有能力以 VS Code 原生服务实现
2. **借鉴算法不照搬架构** — 移植 agentmemory 的 BM25/RRF/衰减/隐私过滤算法，但用 `IFileService` + JSONL 而非 KV store
3. **渐进式增强** — P0（安全+检索）→ P1（生命周期）→ P2（图谱+可观测）→ P3（基准），每阶段可独立上线
4. **向后兼容** — 不破坏现有 `IMemoryProvider` 接口和 `.saros/memory/<agentId>/*.jsonl` 文件布局

### 1.3 不采纳的部分

| agentmemory 特性 | 不采纳原因 |
|------------------|-----------|
| iii-engine 运行时 | 外部 Rust 二进制，Windows 不友好，违反 IDE 原生原则 |
| 独立 REST server（128 端点） | IDE 内无需 HTTP 桥接，增加延迟 |
| 53 MCP 工具 | 本项目 LLM 工具应保持精简（当前 4 个），过多增加模型选择负担 |
| 4 端口架构（3111/3112/3113/49134） | 进程内直接调用，不需要端口 |
| iii console OTEL | 过重，用 `IAgentStudioLogService` + 记忆详情面板替代 |

---

## 二、当前架构回顾

### 2.1 文件布局

```
<userRoamingDataHome>/.saros/memory/<agentId>/
├── short-term.jsonl    # 短期记忆（环形缓冲，FIFO，默认 200 条）
└── long-term.jsonl     # 长期记忆（无上限，追加写入）
```

### 2.2 接口契约

```typescript
// src/vs/sessions/contrib/agentStudio/common/providers.ts
export interface IMemoryProvider {
  readonly id: string;
  readonly name: string;
  loadContext(agentId: string, sessionId: string, query?: string, options?: IMemoryRecallOptions): Promise<IMemoryContext>;
  writeMemory(agentId: string, entry: IMemoryEntry): Promise<void>;
  searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]>;
}

export interface IMemoryEntry {
  readonly id: string;
  readonly type: 'short_term' | 'long_term';
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp?: number;
  readonly importance?: number;  // 0-10
  readonly score?: number;        // for search results
}
```

### 2.3 现有实现关键文件

| 文件 | 职责 | 问题 |
|------|------|------|
| `browser/providers/memory/sessionMemoryProvider.ts` | JSONL 读写 + 原子写入 + 文件锁 + 会话缓存 | 搜索仅 `String.includes()` |
| `browser/providers/memory/vectorMemory.ts` | TF-IDF 向量占位 | 非真正 embedding，无持久化 |
| `browser/agentOSService.ts` | L1 自动提取（每 3 轮） | 提取后无衰减/无矛盾检测 |
| `browser/agentDriverService.ts` | L0 fire-and-forget 写入 | 仅 finally 块，无工具级捕获 |

---

## 三、优化方案总览

```
P0 — 检索质量基础（安全 + 搜索）
  ├── P0.1 隐私过滤器（secret/API key 剥离）
  ├── P0.2 BM25 关键词索引
  ├── P0.3 本地向量 embedding（all-MiniLM-L6-v2）
  └── P0.4 RRF 三流融合搜索

P1 — 记忆生命周期
  ├── P1.1 记忆衰减（Ebbinghaus 曲线）
  ├── P1.2 自动遗忘（TTL + 重要性驱逐 + 上限）
  ├── P1.3 矛盾检测与 supersedes 链
  └── P1.4 工具级自动捕获 hook

P2 — 知识与可观测性
  ├── P2.1 轻量知识图谱（实体 + 关系）
  ├── P2.2 记忆详情实时查看器
  └── P2.3 审计 trail

P3 — 质量保障
  ├── P3.1 基准测试框架
  └── P3.2 回归 CI
```

---

## 四、P0 — 检索质量基础

### P0.1 隐私过滤器

**目标**：在 `writeMemory` 落盘前剥离 secret/API key/token，防止敏感信息持久化。

**参考**：`agentmemory/src/functions/privacy.ts`

**设计**：

新增 `browser/providers/memory/privacyFilter.ts`：

```typescript
/**
 * 隐私过滤器 — 在记忆落盘前剥离敏感信息。
 * 参考 agentmemory src/functions/privacy.ts
 */

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;

const SECRET_PATTERNS = [
  // 通用 key=value 模式
  /(?:api[_-]?key|secret|token|password|credential|auth)[\s]*[=:]\s*["']?[A-Za-z0-9_\-/.+]{20,}["']?/gi,
  // Bearer token
  /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
  // OpenAI
  /sk-proj-[A-Za-z0-9\-_]{20,}/g,
  /(?:sk|pk|rk|ak)-[A-Za-z0-9][A-Za-z0-9\-_]{19,}/g,
  // Anthropic
  /sk-ant-[A-Za-z0-9\-_]{20,}/g,
  // GitHub
  /gh[pus]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  // Slack
  /xoxb-[A-Za-z0-9\-]+/g,
  // AWS
  /AKIA[0-9A-Z]{16}/g,
  // Google
  /AIza[A-Za-z0-9\-_]{35}/g,
  // JWT
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // npm
  /npm_[A-Za-z0-9]{36}/g,
  // GitLab
  /glpat-[A-Za-z0-9\-_]{20,}/g,
  // 腾讯云/TOF 票据（本项目特有）
  /x-tai-identity[:\s=]+[A-Za-z0-9._\-]{20,}/gi,
];

export function stripPrivateData(input: string): string {
  let result = input.replace(PRIVATE_TAG_RE, '[REDACTED]');
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    result = result.replace(re, '[REDACTED_SECRET]');
  }
  return result;
}
```

**集成点**：在 `SessionMemoryProvider.writeMemory` 入口处调用：

```typescript
// sessionMemoryProvider.ts writeMemory 方法开头
const sanitizedContent = stripPrivateData(entry.content);
const sanitizedEntry: IMemoryEntry = { ...entry, content: sanitizedContent };
// 后续用 sanitizedEntry 替代 entry
```

**验收**：
- 包含 `sk-ant-xxx` 的内容落盘后变为 `[REDACTED_SECRET]`
- 包含 `<private>敏感内容</private>` 的内容落盘后变为 `[REDACTED]`
- 普通文本不受影响

---

### P0.2 BM25 关键词索引

**目标**：替代 `String.includes()`，实现基于相关性的关键词搜索，支持词干化、同义词扩展、前缀匹配。

**参考**：`agentmemory/src/state/search-index.ts`

**设计**：

新增 `browser/providers/memory/bm25Index.ts`：

```typescript
/**
 * BM25 搜索索引 — 基于 Okapi BM25 算法的关键词检索。
 * 参考 agentmemory src/state/search-index.ts
 *
 * 参数：k1=1.2（词频饱和）, b=0.75（文档长度归一化）
 */

export interface BM25SearchResult {
  id: string;
  score: number;
}

export class BM25Index {
  private entries = new Map<string, { id: string; termCount: number }>();
  private invertedIndex = new Map<string, Set<string>>();
  private docTermCounts = new Map<string, Map<string, number>>();
  private totalDocLength = 0;
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  /** 简单词干化（Porter stemmer 简化版） */
  private stem(word: string): string {
    return word
      .replace(/(ies)$/i, 'y')
      .replace(/(sses)$/i, 'ss')
      .replace(/(ss)$/i, 'ss')
      .replace(/(ing|ed|tion|sion|ment|ness)$/i, '');
  }

  /** CJK 检测（中文/日文/韩文） */
  private hasCJK(text: string): boolean {
    return /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text);
  }

  /** 分词 */
  private tokenize(text: string): string[] {
    const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s/.\\-_]/gu, ' ');
    const out: string[] = [];
    for (const raw of cleaned.split(/\s+/)) {
      if (raw.length < 2) continue;
      if (this.hasCJK(raw)) {
        // CJK 简单按字符切分（后续可接 jieba）
        for (const ch of raw) {
          if (/[\u4e00-\u9fff]/.test(ch)) out.push(ch);
        }
      } else {
        out.push(this.stem(raw));
      }
    }
    return out;
  }

  add(id: string, content: string): void {
    // 先移除旧条目（如果存在）
    if (this.entries.has(id)) this.remove(id);

    const terms = this.tokenize(content);
    const termFreq = new Map<string, number>();
    let termCount = 0;

    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
      termCount++;
    }

    this.entries.set(id, { id, termCount });
    this.docTermCounts.set(id, termFreq);
    this.totalDocLength += termCount;

    for (const term of termFreq.keys()) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Set());
      }
      this.invertedIndex.get(term)!.add(id);
    }
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const termFreq = this.docTermCounts.get(id);
    if (termFreq) {
      for (const term of termFreq.keys()) {
        const posting = this.invertedIndex.get(term);
        if (posting) {
          posting.delete(id);
          if (posting.size === 0) this.invertedIndex.delete(term);
        }
      }
      this.docTermCounts.delete(id);
    }
    this.totalDocLength = Math.max(0, this.totalDocLength - entry.termCount);
    this.entries.delete(id);
  }

  search(query: string, limit = 20): BM25SearchResult[] {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0 || this.entries.size === 0) return [];

    const N = this.entries.size;
    const avgDocLen = this.totalDocLength / N;
    const scores = new Map<string, number>();

    for (const term of queryTerms) {
      const matchingDocs = this.invertedIndex.get(term);
      if (!matchingDocs) continue;

      const df = matchingDocs.size;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const id of matchingDocs) {
        const entry = this.entries.get(id)!;
        const docTerms = this.docTermCounts.get(id);
        const tf = docTerms?.get(term) || 0;
        const docLen = entry.termCount;

        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
        const bm25Score = idf * (numerator / denominator);

        scores.set(id, (scores.get(id) || 0) + bm25Score);
      }
    }

    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  get size(): number { return this.entries.size; }
  clear(): void {
    this.entries.clear();
    this.invertedIndex.clear();
    this.docTermCounts.clear();
    this.totalDocLength = 0;
  }
}
```

**持久化**：索引随记忆文件重建（启动时遍历 `long-term.jsonl` 调用 `add`）。或序列化到 `.saros/memory/<agentId>/bm25-index.json`，参考 agentmemory 的 `serialize/deserialize`。

---

### P0.3 本地向量 embedding

**目标**：替代 TF-IDF 占位，使用 `@xenova/transformers` 本地推理 all-MiniLM-L6-v2（384 维，离线免费）。

**参考**：`agentmemory/src/state/vector-index.ts`

**依赖**：

```bash
npm install @xenova/transformers
```

> 注意：`@xenova/transformers` 是 optionalDependency，首次使用时动态 import，不阻塞启动。

**设计**：

新增 `browser/providers/memory/vectorIndex.ts`：

```typescript
/**
 * 向量索引 — 基于 all-MiniLM-L6-v2 的语义检索。
 * 参考 agentmemory src/state/vector-index.ts
 *
 * embedding: 384 维 Float32Array
 * 相似度: cosine similarity
 * 持久化: base64 编码存储到 .saros/memory/<agentId>/vector-index.json
 */

// 懒加载 transformers.js（避免未使用时加载 ONNX runtime）
let _pipeline: any = null;
async function getPipeline() {
  if (!_pipeline) {
    const { pipeline } = await import('@xenova/transformers');
    _pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return _pipeline;
}

export async function embed(text: string): Promise<Float32Array> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return output.data as Float32Array;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface VectorSearchResult {
  id: string;
  score: number;
}

export class VectorIndex {
  private vectors = new Map<string, Float32Array>();

  add(id: string, embedding: Float32Array): void {
    this.vectors.set(id, embedding);
  }

  remove(id: string): void {
    this.vectors.delete(id);
  }

  search(queryVec: Float32Array, limit = 20): VectorSearchResult[] {
    const results: VectorSearchResult[] = [];
    for (const [id, vec] of this.vectors) {
      const score = cosineSimilarity(queryVec, vec);
      results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  get size(): number { return this.vectors.size; }

  // 持久化（参考 agentmemory 的 float32ToBase64）
  serialize(): string {
    // Float32Array → base64
    const data: Array<[string, string]> = [];
    for (const [id, vec] of this.vectors) {
      const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      data.push([id, buf.toString('base64')]);
    }
    return JSON.stringify(data);
  }

  static deserialize(json: string): VectorIndex {
    const idx = new VectorIndex();
    try {
      const data = JSON.parse(json);
      if (!Array.isArray(data)) return idx;
      for (const [id, b64] of data) {
        const buf = Buffer.from(b64, 'base64');
        idx.vectors.set(id, new Float32Array(
          buf.buffer, buf.byteOffset,
          buf.byteLength / Float32Array.BYTES_PER_ELEMENT
        ));
      }
    } catch { /* 空或损坏，返回空索引 */ }
    return idx;
  }
}
```

---

### P0.4 RRF 三流融合搜索

**目标**：将 BM25 + 向量 + 现有子串匹配三路结果用 RRF（Reciprocal Rank Fusion）融合，提升召回质量。

**参考**：`agentmemory/src/state/hybrid-search.ts`

**设计**：

修改 `SessionMemoryProvider.searchMemory`：

```typescript
// 新增 searchHybrid 方法
private async _searchHybrid(
  agentId: string,
  query: string,
  limit: number,
): Promise<IMemoryEntry[]> {
  const RRF_K = 60;
  const allEntries = await this._loadAllEntries(agentId);

  // 1. BM25 搜索
  for (const e of allEntries) {
    this._bm25Index.add(e.id, e.content);
  }
  const bm25Results = this._bm25Index.search(query, limit * 2);

  // 2. 向量搜索（如果 embedding 可用）
  let vectorResults: VectorSearchResult[] = [];
  try {
    const queryVec = await embed(query);
    vectorResults = this._vectorIndex.search(queryVec, limit * 2);
  } catch {
    // embedding 不可用时降级到 BM25-only
  }

  // 3. 子串匹配（保留现有逻辑作为兜底流）
  const textQuery = query.toLowerCase();
  const textResults = allEntries
    .filter(e => e.content.toLowerCase().includes(textQuery))
    .slice(0, limit * 2);

  // 4. RRF 融合
  const scores = new Map<string, { score: number; entry: IMemoryEntry }>();
  const entryMap = new Map(allEntries.map(e => [e.id, e]));

  const bm25Weight = 0.4;
  const vectorWeight = this._vectorIndex.size > 0 ? 0.6 : 0;
  const textWeight = 0.2;
  const totalW = bm25Weight + vectorWeight + textWeight || 1;

  bm25Results.forEach((r, i) => {
    const entry = entryMap.get(r.id);
    if (!entry) return;
    const rankScore = (bm25Weight / totalW) * (1 / (RRF_K + i + 1));
    scores.set(r.id, { score: rankScore, entry });
  });

  vectorResults.forEach((r, i) => {
    const entry = entryMap.get(r.id);
    if (!entry) return;
    const rankScore = (vectorWeight / totalW) * (1 / (RRF_K + i + 1));
    const existing = scores.get(r.id);
    if (existing) existing.score += rankScore;
    else scores.set(r.id, { score: rankScore, entry });
  });

  textResults.forEach((entry, i) => {
    const rankScore = (textWeight / totalW) * (1 / (RRF_K + i + 1));
    const existing = scores.get(entry.id);
    if (existing) existing.score += rankScore;
    else scores.set(entry.id, { score: rankScore, entry });
  });

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => ({ ...s.entry, score: s.score }));
}
```

**写入时同步索引**：

```typescript
// writeMemory 方法中，写入文件后同步更新索引
async writeMemory(agentId: string, entry: IMemoryEntry): Promise<void> {
  const sanitizedEntry = { ...entry, content: stripPrivateData(entry.content) };
  // ... 现有原子写入逻辑 ...

  // 异步更新索引（不阻塞写入）
  this._updateIndex(agentId, sanitizedEntry).catch(err => {
    this.logService.warn(`[SessionMemoryProvider] index update failed: ${err}`);
  });
}

private async _updateIndex(agentId: string, entry: IMemoryEntry): Promise<void> {
  if (entry.type === 'long_term') {
    this._bm25Index.add(entry.id, entry.content);
    try {
      const vec = await embed(entry.content);
      this._vectorIndex.add(entry.id, vec);
    } catch { /* embedding 不可用，仅 BM25 */ }
  }
}
```

**验收**：
- 搜索"数据库性能优化"能召回内容为"N+1 查询修复"的记忆（语义匹配，非子串）
- 搜索精确关键词时 BM25 权重更高
- embedding 不可用时自动降级到 BM25 + 子串

---

## 五、P1 — 记忆生命周期

### P1.1 记忆衰减

**目标**：长期记忆按 Ebbinghaus 曲线衰减，频繁访问的记忆增强，防止无限累积。

**参考**：`agentmemory/src/functions/consolidation-pipeline.ts` 的 `applyDecay` 函数

**设计**：

扩展 `IMemoryEntry`（向后兼容，新增可选字段）：

```typescript
export interface IMemoryEntry {
  // ... 现有字段 ...
  readonly strength?: number;        // 0-1，衰减后的强度（默认 1.0）
  readonly lastAccessedAt?: number;  // 最后访问时间戳
  readonly accessCount?: number;      // 访问次数
  readonly forgetAfter?: number;      // TTL 过期时间戳
}
```

新增 `browser/providers/memory/decayManager.ts`：

```typescript
/**
 * 记忆衰减管理器 — 基于 Ebbinghaus 遗忘曲线。
 * 参考 agentmemory src/functions/consolidation-pipeline.ts applyDecay
 *
 * 规则：
 *   - 超过 decayDays 天未访问的记忆，每个 decayDays 周期 strength *= 0.9
 *   - strength 下限 0.1（不会完全消失，除非被遗忘策略清除）
 *   - 每次搜索命中时 strength += 0.1（上限 1.0），accessCount++
 */

const DEFAULT_DECAY_DAYS = 30;
const MIN_STRENGTH = 0.1;
const DECAY_FACTOR = 0.9;
const REINFORCE_INCREMENT = 0.1;
const MAX_STRENGTH = 1.0;

export function applyDecay<T extends { strength: number; lastAccessedAt?: number; updatedAt?: string }>(
  items: T[],
  decayDays: number = DEFAULT_DECAY_DAYS,
): void {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return;
  const now = Date.now();
  for (const item of items) {
    const lastAccess = item.lastAccessedAt || (item.updatedAt ? new Date(item.updatedAt).getTime() : now);
    const daysSince = (now - lastAccess) / (1000 * 60 * 60 * 24);
    if (daysSince > decayDays) {
      const decayPeriods = Math.floor(daysSince / decayDays);
      item.strength = Math.max(MIN_STRENGTH, item.strength * Math.pow(DECAY_FACTOR, decayPeriods));
    }
  }
}

export function reinforce<T extends { strength: number; accessCount: number; lastAccessedAt: number }>(
  item: T,
): T {
  return {
    ...item,
    strength: Math.min(MAX_STRENGTH, item.strength + REINFORCE_INCREMENT),
    accessCount: (item.accessCount || 0) + 1,
    lastAccessedAt: Date.now(),
  };
}
```

**触发时机**：在 `loadContext` 加载记忆时对长期记忆执行 `applyDecay`，在 `searchMemory` 命中时对匹配项执行 `reinforce`。

---

### P1.2 自动遗忘

**目标**：定期清理过期/低重要性/超上限的记忆，控制文件大小。

**参考**：`agentmemory/src/functions/evict.ts`

**设计**：

新增 `browser/providers/memory/evictionManager.ts`：

```typescript
/**
 * 自动遗忘管理器 — 定期清理过期/低重要性记忆。
 * 参考 agentmemory src/functions/evict.ts
 *
 * 清理策略：
 *   1. TTL 过期：forgetAfter < now → 删除
 *   2. 低重要性过期：importance < 3 且 age > 90 天 → 删除
 *   3. 衰减清除：strength < 0.2 → 删除
 *   4. 上限驱逐：长期记忆 > maxEntries → 按重要性升序删除最弱的
 */

export interface EvictionConfig {
  staleSessionDays: number;          // 默认 30
  lowImportanceMaxDays: number;     // 默认 90
  lowImportanceThreshold: number;   // 默认 3
  maxLongTermEntries: number;       // 默认 5000
  strengthFloor: number;            // 默认 0.2
}

export const DEFAULT_EVICTION_CONFIG: EvictionConfig = {
  staleSessionDays: 30,
  lowImportanceMaxDays: 90,
  lowImportanceThreshold: 3,
  maxLongTermEntries: 5000,
  strengthFloor: 0.2,
};

export interface EvictionStats {
  expiredEntries: number;
  lowImportanceEvicted: number;
  strengthEvicted: number;
  capEvicted: number;
  totalEvicted: number;
}

export function shouldEvict(
  entry: IMemoryEntry,
  config: EvictionConfig,
  now: number = Date.now(),
): { evict: boolean; reason: string } {
  const age = now - (entry.timestamp ?? now);
  const maxAge = config.lowImportanceMaxDays * 24 * 60 * 60 * 1000;

  // 1. TTL 过期
  if (entry.metadata?.['forgetAfter'] && now > Number(entry.metadata['forgetAfter'])) {
    return { evict: true, reason: 'expired_ttl' };
  }

  // 2. 低重要性过期
  if ((entry.importance ?? 5) < config.lowImportanceThreshold && age > maxAge) {
    return { evict: true, reason: 'low_importance_old' };
  }

  // 3. 衰减清除
  const strength = entry.metadata?.['strength'] as number | undefined;
  if (strength !== undefined && strength < config.strengthFloor) {
    return { evict: true, reason: 'strength_below_floor' };
  }

  return { evict: false, reason: '' };
}
```

**触发时机**：IDE 启动时执行一次 + 每 24 小时定时执行（用 `setInterval` 或 `ITimerService`）。

---

### P1.3 矛盾检测与 supersedes 链

**目标**：新写入长期记忆时检测与现有记忆的矛盾，标记旧记忆为 superseded。

**参考**：`agentmemory` 的 `Memory.supersedes` + `MemoryRelation.type: 'contradicts'`

**设计**：

```typescript
/**
 * 矛盾检测 — 新记忆与现有记忆 content 高度相似但语义冲突时标记。
 * 参考 agentmemory 的 supersedes 链机制
 */

export interface SupersedeResult {
  supersededIds: string[];  // 被取代的旧记忆 ID
  newEntryId: string;
}

export async function detectContradiction(
  newEntry: IMemoryEntry,
  existingEntries: IMemoryEntry[],
  embeddingFn: (text: string) => Promise<Float32Array>,
  threshold = 0.85,
): Promise<SupersedeResult> {
  if (existingEntries.length === 0) {
    return { supersededIds: [], newEntryId: newEntry.id };
  }

  const newVec = await embeddingFn(newEntry.content);
  const superseded: string[] = [];

  for (const existing of existingEntries) {
    if (existing.id === newEntry.id) continue;
    // 跳过已标记为 superseded 的
    if (existing.metadata?.['supersededBy']) continue;

    // 向量相似度高于阈值 → 可能是同一主题的更新
    const existingVec = await embeddingFn(existing.content);
    const sim = cosineSimilarity(newVec, existingVec);

    if (sim > threshold) {
      // 标记旧记忆为 superseded
      superseded.push(existing.id);
    }
  }

  return { supersededIds: superseded, newEntryId: newEntry.id };
}
```

**集成**：在 `writeMemory` 写入长期记忆后，对同类记忆执行矛盾检测，被 superseded 的记忆写入 `metadata.supersededBy = newEntryId`，搜索时过滤掉。

---

### P1.4 工具级自动捕获 hook

**目标**：在每次工具调用后自动捕获观察（L0），而非仅在 AgentDriver finally 块。

**参考**：`agentmemory` 的 12 hook 矩阵（PostToolUse/PreToolUse 等）

**设计**：

利用现有 `IAgentHooks.postToolUse`（已在 `agentStudioTypes.ts` 定义），在 Agent 执行循环中注入记忆写入：

```typescript
// 在 agentDriverService.ts 的工具执行后
if (agent.hooks?.postToolUse) {
  for (const hook of agent.hooks.postToolUse) {
    if (hook.type === 'prompt') {
      // 将工具调用结果作为 L0 观察写入记忆
      await memoryProvider.writeMemory(agentId, {
        id: generateId(),
        type: 'short_term',
        content: `[Tool: ${toolName}] ${summarizeToolResult(result)}`,
        metadata: {
          hookType: 'post_tool_use',
          toolName,
          toolArgs: sanitizeToolArgs(args),
          sessionId,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
        importance: 3,
      });
    }
  }
}
```

**捕获内容**（参考 agentmemory 的 hook 矩阵）：

| Hook 时机 | 捕获内容 | importance |
|-----------|----------|------------|
| 会话开始 | 项目路径、会话 ID | 5 |
| 用户提交 | 用户 prompt（隐私过滤后） | 7 |
| 工具调用前 | 工具名 + 输入参数 | 3 |
| 工具调用后 | 工具名 + 输出摘要 | 4 |
| 工具失败 | 错误上下文 | 6 |
| 会话结束 | 会话摘要 | 8 |

---

## 六、P2 — 知识与可观测性

### P2.1 轻量知识图谱

**目标**：在 L1 提取时同步抽取实体和关系，构建轻量知识图谱，支持搜索时 BFS 扩展上下文。

**参考**：`agentmemory/src/functions/graph.ts` + `graph-retrieval.ts`

**设计**：

新增 `browser/providers/memory/knowledgeGraph.ts`：

```typescript
/**
 * 轻量知识图谱 — 实体抽取 + 关系建模 + BFS 遍历。
 * 参考 agentmemory src/functions/graph.ts
 *
 * 存储：.saros/memory/<agentId>/graph.json
 * 节点类型：file, function, concept, error, decision, pattern
 * 边类型：uses, imports, modifies, causes, fixes, depends_on, related_to
 */

export interface GraphNode {
  id: string;
  type: 'file' | 'function' | 'concept' | 'error' | 'decision' | 'pattern';
  name: string;
  sourceMemoryIds: string[];
  createdAt: string;
  updatedAt?: string;
}

export interface GraphEdge {
  id: string;
  type: 'uses' | 'imports' | 'modifies' | 'causes' | 'fixes' | 'depends_on' | 'related_to';
  sourceNodeId: string;
  targetNodeId: string;
  weight: number;
  sourceMemoryIds: string[];
  createdAt: string;
}

export class KnowledgeGraph {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private nameIndex = new Map<string, string>(); // name → nodeId

  addNode(node: GraphNode): void { /* ... */ }
  addEdge(edge: GraphEdge): void { /* ... */ }

  /** BFS 遍历：从实体出发，找到 depth 跳内的相关节点 */
  bfs(entityNames: string[], depth: number, limit: number): GraphNode[] {
    const visited = new Set<string>();
    const queue: Array<{ id: string; d: number }> = [];
    const results: GraphNode[] = [];

    for (const name of entityNames) {
      const nodeId = this.nameIndex.get(name.toLowerCase());
      if (nodeId && !visited.has(nodeId)) {
        queue.push({ id: nodeId, d: 0 });
        visited.add(nodeId);
      }
    }

    while (queue.length > 0 && results.length < limit) {
      const { id, d } = queue.shift()!;
      const node = this.nodes.get(id);
      if (node) results.push(node);
      if (d >= depth) continue;

      for (const edge of this.edges.values()) {
        if (edge.sourceNodeId === id && !visited.has(edge.targetNodeId)) {
          visited.add(edge.targetNodeId);
          queue.push({ id: edge.targetNodeId, d: d + 1 });
        }
        if (edge.targetNodeId === id && !visited.has(edge.sourceNodeId)) {
          visited.add(edge.sourceNodeId);
          queue.push({ id: edge.sourceNodeId, d: d + 1 });
        }
      }
    }
    return results;
  }

  /** 持久化 */
  serialize(): string { /* JSON.stringify nodes + edges */ }
  static deserialize(json: string): KnowledgeGraph { /* ... */ }
}
```

**实体抽取**（在 L1 提取时同步）：

扩展 `agentOSService.ts` 的 `triggerL1Extraction`，在 LLM 提取 prompt 中增加实体/关系抽取指令：

```text
请从以下对话中提取结构化记忆，并同时抽取实体和关系：

实体格式：
<entity type="file|function|concept|error|decision|pattern" name="...">...</entity>

关系格式：
<relation type="uses|imports|modifies|causes|fixes|depends_on|related_to" source="..." target="...">...</relation>
```

解析 LLM 输出的 XML 标签，写入知识图谱。

---

### P2.2 记忆详情实时查看器

**目标**：将 `memoryDetailEditorPane.ts` 从静态面板升级为实时观察流 + 会话回放。

**参考**：`agentmemory` 的 port 3113 viewer

**设计**：

基于现有 `codebaseMemoryDetailEditorPane.ts` 的 webview 模式，新增 Tab：

| Tab | 功能 | 数据源 |
|-----|------|--------|
| **记忆列表** | 长期/短期记忆浏览 + 搜索 + 编辑 | `IMemoryProvider.searchMemory` |
| **观察流** | 实时工具调用 → 记忆写入的 live stream | `Event` 订阅 `onMemoryWrite` |
| **知识图谱** | 实体节点 + 关系边的可视化 | `KnowledgeGraph` 序列化 |
| **衰减看板** | 各记忆的 strength/accessCount/forgetAfter | `applyDecay` 结果 |
| **会话回放** | 时间线 scrub 查看历史记忆构建 | L0 原始日志 |

---

### P2.3 审计 trail

**目标**：记录每次记忆操作（write/search/delete/forget/decay），供追溯。

**参考**：`agentmemory/src/functions/audit.ts`

**设计**：

新增 `browser/providers/memory/auditLog.ts`：

```typescript
export interface AuditEntry {
  id: string;
  timestamp: number;
  operation: 'write' | 'search' | 'delete' | 'forget' | 'decay' | 'reinforce' | 'consolidate';
  agentId: string;
  targetIds: string[];
  details: Record<string, unknown>;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly maxEntries = 1000;

  record(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    this.entries.push({
      ...entry,
      id: generateId(),
      timestamp: Date.now(),
    });
    // FIFO 清理
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  query(filter?: Partial<Pick<AuditEntry, 'operation' | 'agentId'>>): AuditEntry[] {
    return this.entries.filter(e =>
      (!filter?.operation || e.operation === filter.operation) &&
      (!filter?.agentId || e.agentId === filter.agentId)
    );
  }
}
```

存储到 `.saros/memory/<agentId>/audit.jsonl`。

---

## 七、P3 — 质量保障

### P3.1 基准测试框架

**目标**：移植 agentmemory 的 eval 框架，量化记忆系统检索质量。

**参考**：`agentmemory/eval/`（LongMemEval-S 500 题 + coding-agent-life-v1 15 session）

**设计**：

新增 `src/vs/sessions/test/memory/` 目录：

```
test/memory/
├── benchmark-runner.ts      # 测试运行器
├── test-cases/
│   ├── semantic-search.test.ts    # 语义搜索测试
│   ├── keyword-search.test.ts      # 关键词搜索测试
│   ├── decay-lifecycle.test.ts     # 衰减生命周期测试
│   └── eviction-policy.test.ts     # 遗忘策略测试
└── fixtures/
    └── sample-memories.jsonl       # 测试记忆数据
```

**关键指标**：

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| Recall@5 | ≥ 80% | 语义搜索能召回 5 个相关记忆中的 4 个 |
| Precision@5 | ≥ 60% | 前 5 结果中 3 个以上相关 |
| MRR | ≥ 0.7 | 第一个相关结果平均排名 ≤ 1.4 |
| 搜索延迟 p50 | ≤ 50ms | 1000 条记忆下的中位搜索时间 |
| 衰减准确性 | 100% | 30 天未访问的 strength 确实下降 |

### P3.2 回归 CI

在 `package.json` 添加测试脚本：

```json
{
  "scripts": {
    "test:memory": "vitest run test/memory/"
  }
}
```

---

## 八、实施计划

### 8.1 阶段划分

| 阶段 | 内容 | 预估工时 | 优先级 |
|------|------|----------|--------|
| P0.1 | 隐私过滤器 | 0.5 天 | 紧急（安全） |
| P0.2 | BM25 索引 | 2 天 | 高 |
| P0.3 | 本地向量 embedding | 2 天 | 高 |
| P0.4 | RRF 融合搜索 | 1 天 | 高 |
| P1.1 | 记忆衰减 | 1 天 | 中 |
| P1.2 | 自动遗忘 | 1.5 天 | 中 |
| P1.3 | 矛盾检测 | 1 天 | 中 |
| P1.4 | 工具级捕获 hook | 1 天 | 中 |
| P2.1 | 知识图谱 | 3 天 | 低 |
| P2.2 | 实时查看器 | 2 天 | 低 |
| P2.3 | 审计 trail | 0.5 天 | 低 |
| P3.1 | 基准测试 | 2 天 | 低 |
| P3.2 | 回归 CI | 0.5 天 | 低 |
| **合计** | | **~18 天** | |

### 8.2 文件变更清单

| 操作 | 文件路径 | 阶段 |
|------|----------|------|
| 新增 | `browser/providers/memory/privacyFilter.ts` | P0.1 |
| 新增 | `browser/providers/memory/bm25Index.ts` | P0.2 |
| 新增 | `browser/providers/memory/vectorIndex.ts` | P0.3 |
| 修改 | `browser/providers/memory/sessionMemoryProvider.ts` | P0.4 |
| 新增 | `browser/providers/memory/decayManager.ts` | P1.1 |
| 新增 | `browser/providers/memory/evictionManager.ts` | P1.2 |
| 新增 | `browser/providers/memory/contradictionDetector.ts` | P1.3 |
| 修改 | `browser/agentDriverService.ts` | P1.4 |
| 新增 | `browser/providers/memory/knowledgeGraph.ts` | P2.1 |
| 修改 | `browser/memoryDetailEditorPane.ts` | P2.2 |
| 新增 | `browser/providers/memory/auditLog.ts` | P2.3 |
| 修改 | `common/providers.ts`（扩展 IMemoryEntry） | P1.1 |
| 新增 | `test/memory/` 目录 | P3 |

### 8.3 依赖变更

```json
// package.json optionalDependencies
{
  "@xenova/transformers": "^2.17.2"
}
```

---

## 九、验收标准

### 9.1 P0 验收

- [ ] 包含 `sk-ant-xxx` 的内容落盘后变为 `[REDACTED_SECRET]`
- [ ] BM25 搜索返回按相关性排序的结果（非子串匹配顺序）
- [ ] 向量搜索能语义匹配（搜索"数据库优化"召回"N+1 查询"记忆）
- [ ] RRF 融合后的 Recall@5 ≥ 80%
- [ ] embedding 不可用时自动降级到 BM25 + 子串

### 9.2 P1 验收

- [ ] 30 天未访问的记忆 strength 下降到 ≤ 0.9
- [ ] 90 天 + importance < 3 的记忆被自动清理
- [ ] 长期记忆超过 5000 条时按 importance 升序驱逐最弱的
- [ ] 新写入与旧记忆矛盾时，旧记忆标记 `supersededBy`
- [ ] 工具调用后自动写入 L0 观察（非仅 finally 块）

### 9.3 P2 验收

- [ ] L1 提取同步生成知识图谱节点和边
- [ ] BFS 遍历能从"JWT"找到相关的"auth.ts"节点
- [ ] 记忆详情面板显示实时观察流
- [ ] 审计日志记录所有记忆操作

### 9.4 P3 验收

- [ ] 基准测试通过率 ≥ 90%
- [ ] 搜索延迟 p50 ≤ 50ms（1000 条记忆）

---

## 十、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `@xenova/transformers` 首次加载慢（下载 ONNX 模型 ~80MB） | 首次使用体验差 | 懒加载 + 后台预热 + 降级到 BM25-only |
| BM25 索引重建耗时（大量记忆时） | 启动变慢 | 增量索引 + 持久化到文件 |
| 衰减误删重要记忆 | 数据丢失 | strength 下限 0.1 + 审计 trail + 软删除（先标记后清理） |
| 向量维度不匹配（模型切换） | 索引损坏 | 持久化时记录维度，加载时校验，不匹配则重建 |
| iii-engine 版本锁定（如未来用 agentmemory） | 迁移成本 | 本方案不依赖 iii-engine，纯 TS 实现 |

---

## 附录 A：agentmemory 关键实现参考

### A.1 BM25 参数

```
k1 = 1.2  // 词频饱和参数
b  = 0.75 // 文档长度归一化参数
```

来源：`agentmemory/src/state/search-index.ts:19-20`

### A.2 RRF 融合公式

```
combinedScore = w_bm25 * (1 / (k + bm25Rank))
               + w_vector * (1 / (k + vectorRank))
               + w_graph * (1 / (k + graphRank))
```

其中 `k = 60`（RRF 常数），权重归一化：`w_i /= (w_bm25 + w_vector + w_graph)`

来源：`agentmemory/src/state/hybrid-search.ts:216-218`

### A.3 衰减公式

```
strength = max(0.1, strength * 0.9^decayPeriods)
decayPeriods = floor(daysSinceLastAccess / decayDays)
```

来源：`agentmemory/src/functions/consolidation-pipeline.ts:21-43`

### A.4 隐私过滤正则模式

来源：`agentmemory/src/functions/privacy.ts:5-20`（本文档 P0.1 已完整移植）

### A.5 驱逐策略

| 策略 | 阈值 | 来源 |
|------|------|------|
| 过期会话 | 30 天无摘要 | `evict.ts:24` staleSessionDays |
| 低重要性观察 | importance < 3 且 age > 90 天 | `evict.ts:25-27` |
| 项目观察上限 | 10000 条/项目 | `evict.ts:28` |
| TTL 过期记忆 | forgetAfter < now | `evict.ts:274-305` |
| 非最新记忆 | isLatest=false 且 age > 90 天 | `evict.ts:307-340` |

---

## 附录 B：与现有 Memory-Strategy.md 的关系

本方案是 `Memory-Strategy.md` 中"提升优化方向"的具体实施落地：

| Memory-Strategy.md 提及的方向 | 本方案对应 |
|-------------------------------|-----------|
| 冷热分层（3 个月以上 L0 归档） | P1.2 自动遗忘 |
| 加密落盘（敏感信息过滤） | P0.1 隐私过滤器 |
| owner 标记（每条 L0 带 owner） | P1.4 工具级捕获 hook（metadata.agentId） |
| 窗口大小自适应 | 不在本方案范围（属上下文压缩） |
| 滑出即触发抽取 | P1.4 工具级捕获 hook |
| 多级摘要（周/月摘要） | P1.1 衰减 + 未来扩展 |

---

*本文档基于 agentmemory v0.9.27 源码分析编写，所有算法实现已验证可移植到 VS Code 进程内架构。*
