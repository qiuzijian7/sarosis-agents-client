# cognee vs sarosis-agents-client 全功能对比分析

> 分析时间：2026-07-06
> cognee v1.2.2 (Python/FastAPI) vs sarosis v2.2.25903 (TypeScript/VS Code)

---

## 一、架构差异总览

| 维度 | cognee | sarosis |
|------|--------|---------|
| 语言/运行时 | Python 3.10+, FastAPI | TypeScript, VS Code 扩展 |
| 图数据库 | Neo4j (GraphDBInterface) | 内置 CodebaseGraph (22-pass) |
| 向量数据库 | LanceDB (VectorDBInterface) | trigram fallback / Xenova 可选 |
| 关系数据库 | SQLite / PostgreSQL (SQLAlchemy) | SQLite KV Store |
| 缓存层 | Redis / DiskCache | 内置 Map 级缓存 (P3 指纹 + 60s TTL) |
| LLM 集成 | LiteLLM 网关 (OpenAI/Anthropic/... 多模型) | Anthropic Claude / BYOK provider |
| 搜索 | Graph Search + Vector Search | BM25 + Vector RRF 融合 |
| MCP 支持 | cognee-mcp 独立服务 | 内置 tools + codebase-mcp |
| 前端 | Next.js Dashboard | VS Code Webview Panel |
| 部署 | Docker / Modal (分布式) | VS Code 扩展 + 子进程 |

---

## 二、核心功能矩阵

### 2.1 数据摄入

| 功能 | cognee | sarosis | 差距 |
|------|--------|---------|------|
| 文档加载 | ✅ PDF/DOCX/TXT/MD/CSV/JSON/图片（多格式加载器） | ❌ 仅文本/代码 | **G1** |
| 文本分块 | ✅ 多级分块引擎 (fixed/semantic/markdown/code) | ❌ 简单截断 | **G2** |
| 批量摄入 | ✅ add() API + dataset_queue | ✅ writeMemory (fire-and-forget) | 对齐 |
| 文件系统监控 | ✅ FileStorage (file_change 概念) | ❌ | G3 |
| 流式摄入 | ✅ StreamingIngestionManager | ❌ | 低优 |

### 2.2 图谱构建 (Cognify)

| 功能 | cognee | sarosis | 差距 |
|------|--------|---------|------|
| 实体提取 | ✅ LLM 驱动 (Entity/Triplet 三元组) | ⚠️ CodebaseGraph (代码层) | 各有侧重 |
| 关系推理 | ✅ 多类型关系 (is_a/has_a/calls/...) + 时序图谱 | ✅ Codebase 调用图 (CALLS/IMPORTS/...) | 对齐 |
| 本体引导 | ✅ 自定义 Ontology 解析 | ❌ | **G4** |
| 图谱丰富化 | ✅ Memify pipeline (多个增强 pass) | ⚠️ ConsolidationPipeline (部分) | **G5** |
| 回滚 | ✅ 图谱回滚 (GraphRollBack) | ❌ | G6 |
| 图谱可视化 | ✅ 前端 D3.js/Force Graph | ⚠️ memoryDetailEditorPane (简化) | G7 |
| 时序图谱 | ✅ TemporalGraph (历史版本追踪) | ✅ _temporalGraphs | 对齐 |

### 2.3 搜索与检索

| 功能 | cognee | sarosis | 差距 |
|------|--------|---------|------|
| 图谱搜索 | ✅ Cypher/关系遍历 | ✅ CodebaseGraph search | 对齐 |
| 向量搜索 | ✅ LanceDB + 多种嵌入模型 | ✅ embedSync + RRF | 对齐 |
| 多策略检索 | ✅ search/adapter.py (13 种策略) | ⚠️ 2 种 (BM25+Vector) | **G8** |
| Reranker | ✅ Cross-encoder re-ranking | ❌ RRF 仅权重融合 | **G9** |
| Completion | ✅ GraphRAG AnswerGen (LLM 生成) | ❌ | **G10** |
| Agentic Retriever | ✅ AgenticRetriever (工具调用检索) | ❌ | G11 |
| 搜索结果缓存 | ❌ | ✅ _searchCache LRU | sarosis 领先 |

### 2.4 记忆模型

| 功能 | cognee | sarosis | 差距 |
|------|--------|---------|------|
| 4-Tier 模型 | ❌ 基于 Graph 的扁平模型 | ✅ Working→Episodic→Semantic→Procedural | sarosis 领先 |
| Unified Memory API | ✅ remember/recall/improve/forget | ⚠️ writeMemory/searchMemory (部分) | **G12** |
| Session 蒸馏 | ✅ SessionDistillationEngine (LLM 摘要) | ✅ ConsolidationPipeline | 对齐 |
| 记忆去重 | ⚠️ 基于 ID 去重 | ✅ BloomFilter + SHA-256 + toolCallId | sarosis 领先 |
| 经验衰减 | ❌ | ✅ Lesson decay + reinforce | sarosis 领先 |
| Skills 提取 | ❌ | ✅ SkillExtractor + SKILL.md | sarosis 领先 |
| 跨会话固化 | ✅ Cognify pipeline (每次 cognify) | ✅ ConsolidationPipeline (session_end) | 对齐 |

### 2.5 缓存与性能优化

| 功能 | cognee | sarosis | 差距 |
|------|--------|---------|------|
| 磁盘缓存 | ✅ DiskCache (持久化) | ❌ 仅内存级 | **G13** |
| Redis 缓存 | ✅ 支持 | ❌ | G14 |
| BM25 惰性缓存 | ❌ | ✅ sortedTerms + lowerBound | sarosis 领先 |
| Context 结果缓存 | ❌ | ✅ P3 fingerprint + TTL | sarosis 领先 |
| Anthropic cache_control | ❌ | ✅ | sarosis 领先 |
| Anti-thrashing | ❌ | ✅ 压缩抗抖动 | sarosis 领先 |

### 2.6 工具与生态

| 功能 | cognee | sarosis | 差距 |
|------|--------|---------|------|
| MCP 服务器 | ✅ cognee-mcp (独立) | ✅ 内置 MCP bridge | 对齐 |
| CLI 工具 | ✅ 丰富 CLI | ⚠️ host.mjs 简单启动 | G15 |
| 数据迁移 | ✅ Mem0/Zep/Letta 迁移器 | ❌ | G16 |
| Agent 装饰器 | ✅ @memorize 装饰器 | ❌ | G17 |
| 可观测性 | ✅ OpenTelemetry (OTLP) | ⚠️ AuditLog | **G18** |
| 前端 Dashboard | ✅ Next.js + shadcn/ui | ✅ VS Code Webview | 各有侧重 |

---

## 三、优化建议

### G1 — 多格式文档加载器 (高优先级)

**差异**: cognee 支持 PDF/DOCX/TXT/MD/CSV/JSON/图片加载，sarosis 仅支持文本。

**方案**: 在 `memoryProvider` 或 `agentOSService` 中添加 `loadDocument(filePath, format)` 方法，使用 node.js 的 `pdf-parse`、`mammoth`（docx）、`csv-parse` 等库按格式分块后写入 memory。

```typescript
// 新增方法
async loadDocument(filePath: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  let text = '';
  if (ext === '.pdf') text = await pdfParse(filePath);
  else if (ext === '.docx') text = await mammoth(filePath);
  // ... 分块后 writeMemory
}
```

### G2 — 多级文本分块引擎 (高优先级)

**差异**: cognee 有 fixed/semantic/markdown/code 多种分块策略，sarosis 仅简单截断。

**方案**: 在 `memoryProvider` 中添加 `ChunkStrategy` 枚举和分块器。

```typescript
enum ChunkStrategy { fixed, semantic, markdown, code }
function chunk(text: string, strategy: ChunkStrategy, chunkSize: number): string[]
```

### G4 — 本体引导解析 (中优先级)

**差异**: cognee 支持自定义 Ontology 解析实体类型和关系，sarosis 无此机制。

**方案**: 为 `ConsolidationPipeline` 添加 `ontology?: OntologyConfig` 参数，LLM prompt 中注入本体定义指导提取。

### G5 — Memify 图谱丰富化 (中优先级)

**差异**: cognee 的 Memify 管道有多 pass 增强（去重、合并、精化、推理），sarosis 的 ConsolidationPipeline 只有 3 tier。

**方案**: 扩展 ConsolidationPipeline 添加 `dedup_pass`、`merge_pass`、`refine_pass`、`infer_pass` 增强阶段。

### G8/G9 — 多策略检索 + Reranker (高优先级)

**差异**: cognee 的 `search/adapter.py` 定义了 13 种搜索策略，包含 Cross-encoder re-ranking。

**方案**:
- 添加混合搜索策略枚举 (graph_only, vector_only, hybrid, graph_first, vector_first)
- 引入 light-weight re-ranker (或简单 TF-IDF 重新排序)

### G10 — GraphRAG Answer Generation (中优先级)

**差异**: cognee 的 `search/operations.py` 包含 `generate_single_completion`，用图谱+检索结果生成答案。

**方案**: 在 memoryProvider 中加 `generateAnswer(agentId, query)` 方法，调用 LLM 生成带记忆上下文的答案。

### G12 — Unified Memory API (中优先级)

**差异**: cognee 的 `remember/recall/improve/forget` API 更语义化。

**方案**: 在 `builtinToolProvider` 中添加 `memory_recall`、`memory_improve`、`memory_forget` 工具，与现有 `memory_remember/search/delete/list` 组成完整 CRUD。

### G13 — 磁盘级缓存 (中优先级)

**差异**: cognee 的 DiskCache 持久化缓存结果，sarosis 所有缓存都在内存中。

**方案**: 在 `_contextCache` 和 `_searchCache` 外包装 `DiskCacheAdapter`，将缓存内容定期 flush 到 SQLite。

### G18 — OpenTelemetry 可观测性 (低优先级)

**差异**: cognee 集成 OpenTelemetry 进行分布式追踪和指标收集。

**方案**: 扩展 `AuditLog` 为 OpenTelemetry exporter，或保持当前 AuditLog 作为轻量替代。

---

## 四、对比总结

| 领域 | cognee 领先 | sarosis 领先 |
|------|-------------|-------------|
| 数据摄入 | ✅ 多格式加载 + 分块引擎 | - |
| 图谱 | ✅ 本体引导 + Memify + 可视化 | ✅ Codebase 22-pass |
| 搜索 | ✅ 13 种策略 + Re-ranker + AnswerGen | ✅ RRF 融合 + BM25 前缀 |
| 记忆模型 | - | ✅ 4-Tier + 衰减 + Skills |
| 缓存 | ✅ Redis + Disk + 持久化 | ✅ 13 层内存优化 + cache_control |
| 工具链 | ✅ CLI + 迁移 + Agent 装饰器 | ✅ 内置 MCP + LLM tools |

### 建议实施优先级

| 优化 | 描述 | 改动量 | 影响 |
|------|------|--------|------|
| G2 | 多级文本分块引擎 | ~80 行 | 提升长文档记忆质量 |
| G8/G9 | 多策略检索 + Re-ranker | ~100 行 | 搜索精度显著提升 |
| G10 | GraphRAG AnswerGen | ~60 行 | Agent 可获取结构化答案 |
| G12 | memory_recall/improve/forget | ~80 行 | 完整 CRUD 语义 API |
| G4 | 本体引导解析 | ~100 行 | 定制化实体提取 |
| G5 | Memify 丰富化 | ~150 行 | 图谱质量提升 |
| G1 | 多格式文档加载 | ~120 行 | 扩展数据源 |
| G13 | 磁盘缓存 | ~60 行 | 持久化缓存 |
