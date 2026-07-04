# codebase-memory-mcp (C) vs Sarosis 内置 Codebase 工具 — 深度重新对比分析

> 分析日期：2026-07-04  
> C 源码位置：`G:\CustomWorkspaces\AIProjects\codebase-memory-mcp`  
> Sarosis 内置实现位置：`g:\CustomWorkspaces\AIProjects\sarosis-agents-client\src\vs\sessions\contrib\agentStudio\browser`

---

## 执行摘要

本次重新分析在上一轮已实现 BM25、结构 boosting、search_code 三模式、trace_path mode 等基础上，发现了 **3 个影响可用性的关键缺陷**：

1. **`search_code` 实际无法返回结果**（P0）  
   - `CodebaseGraphService.searchCode()` 传入的 `fileContentProvider` 直接返回 `undefined`（`codebaseGraphService.ts:1724-1726`）。  
   - 即使提供 content provider，索引管道创建 file 节点时未设置 `label` 字段（`codebaseGraphPipeline.ts:133-140`），而 `CodebaseGraphStore.findNodesByLabel('file')` 按 `node.label` 索引（`codebaseGraphStore.ts:329-332`），因此找不到任何文件节点。  
   - 工具层 handler 在 `raw` 为空后直接返回 "no matches found"，从未进入富化逻辑。

2. **`manage_adr` 完全为 stub**（P0）  
   - `builtinToolProvider.ts:4006-4039` 仅返回 JSON hint，让 LLM 用 `file_list/file_read/file_write` 自行操作。  
   - 但 `codebaseGraphAdr.ts` 已经完整实现了 `AdrManager`（list/get/create/update/delete/validate/解析），却**没有任何地方实例化或调用**它。

3. **多个工具存在 "schema 声明 vs 实现" 脱节**（P1）  
   - `query_graph.max_rows`：schema 声明了，handler 未传给 Cypher 引擎。  
   - `detect_changes.since`：schema 声明了，底层未使用；文件哈希回退未真正比较哈希。  
   - `index_repository.mode`：声明 fast/moderate/full，但底层未按 mode 调整解析策略。  
   - `get_architecture.path`：声明了，但仅作为元数据返回，未做范围过滤。  

其余差距与上一轮基本一致：语义向量搜索、Cypher 高级语法（UNION/WITH/变长路径）、运行时 trace 摄入精确匹配、跨服务追踪数据、架构 hotspots 等仍为长期差距。

---

## 一、项目架构对比

| 维度 | codebase-memory-mcp (C) | Sarosis (TypeScript) |
|------|---------------------------|----------------------|
| 语言 | C11，零运行时依赖 | TypeScript，Electron renderer 进程 |
| 存储 | SQLite + FTS5 (BM25) + mmap | 内存 Map + 自定义 BM25 + JSON/ZST 持久化 |
| 解析器 | vendored tree-sitter (158 语言) | VS Code 内置 tree-sitter WASM |
| 工具暴露 | MCP stdio 独立进程 | 编辑器内嵌 `builtinToolProvider` |
| 代码搜索 | 系统 `grep` 子进程 + 图富化 | 内存搜索（当前不可用） |
| 文件索引范围 | 仅已索引文件 | 默认全文件，但实现未利用该范围 |

---

## 二、工具函数逐项对比

### 1. `index_repository`

**C 版本**
- 入口：`src/mcp/mcp.c:3453-3579` (`handle_index_repository`)
- 参数：`repo_path`, `mode` (full/moderate/fast/cross-repo-intelligence), `target_projects`, `name`, `persistence`
- 关键能力：
  - 所有模式都执行**类型感知的 LSP 调用/使用解析**（per-file + cross-file）。
  - `full`：所有文件 + 相似/语义边；`moderate`：过滤文件 + 相似/语义；`fast`：过滤文件，无相似/语义。
  - `cross-repo-intelligence`：匹配 Route/Channel 创建 `CROSS_HTTP_CALLS` / `CROSS_ASYNC_CALLS` / `CROSS_CHANNEL` 等跨仓库边。
  - 支持团队产物 `.codebase-memory/graph.db.zst` 的导出与引导（`try_artifact_bootstrap`）。
  - dump-verify 完整性校验，失败时标记 `degraded`。
- 限制：所有索引操作被 `cbm_pipeline_lock` 串行化；排除目录最多展示 25 个，跳过文件最多 50 个。

**Sarosis 版本**
- 入口：`builtinToolProvider.ts:3431-3465`
- 调用：`codebaseGraphService.indexWorkspace(wsPath, { mode, excludeDirs: [] })`
- 差距：
  - 只透传 `mode` 和空 `excludeDirs`，未暴露 `IIndexConfig` 中的 `keepDirs`、`subPath`、`crossRepoIntelligence` 等。
  - `mode` 在实现中未显著区分扫描深度（未按 mode 调整 tree-sitter 解析策略或边生成）。
  - 每次都是全量重建，无增量/artifact 引导。

**建议**：P1 — 按 mode 真正控制解析 passes；暴露 keepDirs/subPath；支持 artifact 引导。

---

### 2. `search_graph`

**C 版本**
- 入口：`src/mcp/mcp.c:1910-2052` (`handle_search_graph`)
- 参数：丰富的过滤与搜索参数（`query`, `name_pattern`, `qn_pattern`, `file_pattern`, `label`, `relationship`, `min_degree`, `max_degree`, `exclude_entry_points`, `include_connected`, `semantic_query`, `limit`, `offset`）
- 关键能力：
  - 优先 BM25/FTS5 路径（`bm25_search`），`query` 一旦提供则忽略 `name_pattern`。
  - **FTS5 contentless 虚拟表**，按 token 反向索引；`limit` 默认 200，BM25 内层候选上限 2000。
  - camelCase 分词：`updateCloudClient` → `update`, `cloud`, `client`。
  - 结构 boosting：`Function/Method +10`, `Route +8`, `Class/Interface +5`。
  - 噪声标签过滤：`File/Folder/Module/Section/Variable` 默认排除。
  - 语义向量搜索：每个关键词独立计算 min-cosine，最多 32 个关键词（`semantic_query`）。
  - `relationship` 大写+下划线校验，且最长 64 字符。
  - 返回 `total` / `has_more` 支持翻页。

**Sarosis 版本**
- 入口：`builtinToolProvider.ts:3531-3607` → `codebaseGraphService.searchGraph()`
- 当前能力：
  - BM25 全文搜索已实现（`codebaseGraphStore.ts`）。
  - camelCase/snake_case 分词已实现。
  - 结构 boosting 已实现（Function/Method +10, Route +8, Class/Interface +5）。
  - 标签、文件路径、度数、关系类型过滤已实现。
  - 分页返回 `total` / `hasMore`。
- 差距：
  - **无语义向量搜索**（`semantic_query`）。
  - BM25 的 TF 固定为 1（仅记录词项存在性），没有 TF-IDF 加权。
  - `file_pattern` 使用简单 `globToRegex`，不支持 `**` 等复杂 glob。
  - `relType` 过滤只检查节点是否拥有该类型边，不返回具体边。
  - 无 `exclude_entry_points` / `include_connected` 参数。

**建议**：P1 — 实现语义向量搜索；P2 — 改进 glob 支持、TF-IDF、返回具体边。

---

### 3. `query_graph`

**C 版本**
- 入口：`src/mcp/mcp.c:2054-2131`
- 参数：`query`, `project`, `max_rows`
- 关键能力：完整 Cypher 解析器（159KB `cypher.c`）；支持 `MATCH`, `WHERE`, `RETURN`, `ORDER BY`, `LIMIT`, `WITH`, `UNION`/`UNION ALL`；100k 行上限；节点可查询 complexity 属性（cyclomatic, cognitive, loop_count, loop_depth, transitive_loop_depth, recursive, linear_scan_in_loop, alloc_in_loop 等）。

**Sarosis 版本**
- 入口：`builtinToolProvider.ts:3610-3640` → `codebaseGraphCypher.ts`
- 当前能力：基础 `MATCH`, `WHERE`, `RETURN`, 聚合, `ORDER BY`, `LIMIT`, `SKIP`。
- 差距：
  - `max_rows` 参数在 handler 中未传给 Cypher 引擎。
  - 不支持 `UNION`, `WITH`, `OPTIONAL MATCH`, `CASE`。
  - 不支持变长路径 `-[*1..3]->`（`codebaseGraphAdvancedAnalysis.ts` 有 `executeExtendedCypher` 但未被调用）。
  - 关系遍历只沿出边方向，不支持 `<-` 反向。
  - 虽然 `codebaseGraphPipeline.ts` 和 `codebaseGraphService.ts` 已计算 `cyclomatic` / `loop_depth` 到 `properties`，但 Cypher 引擎未解析 `.properties.cyclomatic` 这类属性访问。
  - 无查询超时保护。

**建议**：P1 — 把 `max_rows` 参数接入 Cypher；P2 — 支持属性访问与复杂语法。

---

### 4. `get_architecture`

**C 版本**
- 入口：`src/mcp/mcp.c`（对应 `get_architecture`）
- 参数：`aspects`（all/overview/structure/dependencies/routes/languages/packages/entry_points/hotspots/boundaries/layers/file_tree/clusters），`path`（目录前缀）
- 关键能力：Leiden 社区检测，clusters 带 `cohesion_score`, `top_nodes`, `packages`, `edge_types`；hotspots 结合复杂度与 git 变更频率；layers 分层分析。

**Sarosis 版本**
- 入口：`builtinToolProvider.ts:3643-3699` → `codebaseGraphArchitecture.ts`
- 当前能力：语言统计、包/目录摘要、入口点、热点、跨包边界、层级推断、社区检测、死代码检测。
- 差距：
  - `path` 范围过滤**未实现**，仅作为 `_scopePath` 元数据返回。
  - `aspects` 过滤在 `overview` 时硬编码映射，不够灵活。
  - 社区检测已实现 Leiden，但缺少 `cohesion`, `top_nodes`, `packages`, `edge_types` 输出（上一轮分析仍为未实现）。
  - 路由检测依赖 `label === 'route'`，但索引阶段未生成 route 节点。

**建议**：P1 — 实现 `path` 范围过滤；P2 — 增强社区输出（cohesion/top_nodes/packages/edge_types）。

---

### 5. `get_code_snippet`

**C 版本**
- 入口：`src/mcp/mcp.c`（对应 `get_code_snippet`）
- 参数：`qualified_name`, `project`, `include_neighbors`
- 关键能力：从磁盘读取实际文件内容；支持 `include_neighbors` 返回相邻函数。

**Sarosis 版本**
- 入口：`builtinToolProvider.ts:3702-3730` → `codebaseGraphService.getCodeSnippet()`
- 当前能力：从磁盘读取文件并切片（`codebaseGraphService.ts:1813-1840`）；支持 `includeNeighbors`。
- 差距：
  - 依赖准确的 `qualifiedName`（`filePath::name` 格式），用户难以提前知道。
  - 邻居查找在文件节点数 >20000 时可能截断。
  - 未处理嵌套类/方法的重名情况。

**建议**：P2 — 支持按名称模糊匹配/返回候选列表。

---

### 6. `get_graph_schema`

**C 版本**：返回节点标签分布、边类型分布，带 `project` 参数。

**Sarosis 版本**
- 入口：`builtinToolProvider.ts:3732-3745` → `codebaseGraphTrace.ts:268-283`
- 当前能力：返回 `nodeLabels`, `edgeTypes`, `totalNodes`, `totalEdges`。
- 差距：不返回属性 schema、关系方向统计；无 `project` 参数支持。

**建议**：P2 — 暴露属性 schema（properties 字段统计）。

---

### 7. `trace_path`

**C 版本**
- 入口：`src/mcp/mcp.c`（对应 `trace_path`）
- 参数：`function_name`, `project`, `direction`, `depth`, `mode` (calls/data_flow/cross_service), `parameter_name`, `edge_types`, `risk_labels`, `include_tests`
- 关键能力：三种模式分别追踪 `CALLS` / `CALLS+DATA_FLOWS` / `HTTP_CALLS+ASYNC_CALLS+DATA_FLOWS+CROSS_*`。

**Sarosis 版本**
- 入口：`builtinToolProvider.ts:3748-3780`
- 当前能力：支持 `calls` / `data_flow` / `cross_service` 三种模式；支持 `callers` / `callees` / `both` 方向；每跳风险评级。
- 差距：
  - schema 中 `maxDepth` 默认写 3，但服务层 `tracePathAdvanced` 默认 10，不一致。
  - 仅支持单一起始节点，不支持多源追踪。
  - 找到 target 后立即 break，不返回完整路径，只返回访问过的 hops。
  - `data_flow` / `cross_service` 依赖 `DATA_FLOWS` / `HTTP_CALLS` / `ASYNC_CALLS` 边，索引阶段生成极少。

**建议**：P1 — 统一 `maxDepth` 默认；P2 — 返回完整路径、多源追踪。

---

### 8. `search_code` ⚠️ 关键缺陷

**C 版本**
- 入口：`src/mcp/mcp.c:4644-4830+` (`handle_search_code`)
- 参数：`pattern`, `project`, `file_pattern`, `path_filter`, `mode`, `limit`, `context`, `regex`
- 关键流程：
  1. Phase 0：参数验证、正则校验、管道字符警告。
  2. Phase 0.5：多词转换 `"foo bar" → "foo.*bar"`。
  3. Phase 1：**调用系统 `grep` 子进程**，先通过 `write_scoped_filelist` 将搜索范围限定在**已索引文件**。
  4. Phase 2+3：图谱富化，去重到包含函数，按定义优先、热门函数、测试最后排序。
  5. Phase 3：输出 `compact`（签名）/ `full`（源码）/ `files`（文件列表）。

**Sarosis 版本**
- 入口：`builtinToolProvider.ts:3783-3924` → `codebaseGraphService.searchCode()` → `codebaseGraphTrace.ts:299-...`
- **致命问题 1**：`codebaseGraphService.searchCode()` 中 `fileContentProvider` 直接返回 `undefined`：

```typescript
// codebaseGraphService.ts:1723-1728
searchCode(query: string, limit: number = 50): any[] {
    const fileContentProvider = (filePath: string): string | undefined => {
        return undefined;  // ← 永远返回空
    };
    return graphSearchCode(this._graph.store, this._projectName, query, fileContentProvider, limit);
}
```

- **致命问题 2**：即使修复 content provider，索引管道创建 file 节点时**未设置 `label` 字段**：

```typescript
// codebaseGraphPipeline.ts:132-140
nodes.push({
    id: fileId,
    name: fileName,
    type: 'file',      // 设置了 type
    filePath,
    qualifiedName: filePath,
    startLine: 1,
    endLine: 1,
    // label 字段缺失！
});
```

而 `codebaseGraphStore.findNodesByLabel('file')` 按 `node.label` 索引（`codebaseGraphStore.ts:329-332`），因此找不到任何文件节点。

- **致命问题 3**：工具层 handler 在 `raw` 为空后直接返回，未尝试回退：

```typescript
// builtinToolProvider.ts:3822-3825
const raw = this.codebaseGraphService.searchCode(searchQuery, limit * 5);
if (!raw || raw.length === 0) {
    return text('search_code: no matches found.');
}
```

**建议**：P0 — 立即修复：
1. 在 `indexWorkspace` 或 `CodebaseGraphStore.addNode` 中确保 file 节点 `label = 'File'`。
2. 在 `CodebaseGraphService.searchCode` 中通过 `fileService.readFile` 真正读取文件内容。
3. 或改为工具层直接使用 `fileService` 遍历索引文件做 grep，再调用图做富化（与 C 版一致）。

---

### 9. `detect_changes`

**C 版本**
- 入口：`src/mcp/mcp.c`（对应 `detect_changes`）
- 参数：`project`, `scope`, `depth`, `base_branch`, `since`
- 关键能力：`since` 与 `base_branch` 做真实 diff，影响分析从改动文件出发追踪下游。

**Sarosis 版本**
- 入口：`builtinToolProvider.ts:3927-3956`
- 当前能力：Git API 获取 workingTree/index changes；影响分析 BFS 追踪 CALLS/IMPORTS/USAGE，最多 500 节点、深度 5；风险评级。
- 差距：
  - `since` 参数完全未使用，无法按 commit/tag 对比。
  - 文件哈希回退未真正比较哈希，只是把所有追踪过的文件都标为 `'M'`。
  - Git 对比使用当前工作区状态，不是与 `baseBranch` 做 diff。
  - 未持久化变更历史。

**建议**：P1 — 实现 `since` 与 `baseBranch` 的真实 diff；P2 — 文件哈希真正比较。

---

### 10. `ingest_traces`

**C 版本**
- 入口：`src/mcp/mcp.c`（对应 `ingest_traces`）
- 参数：`traces`（caller/callee/count 数组），`project`

**Sarosis 版本**
- 入口：`builtinToolProvider.ts:3959-3984`
- 当前能力：解析 OTLP JSON / 平铺数组；按 span kind 分类为 CALLS/HTTP_CALLS/ASYNC_CALLS；聚合 latency、count、errorRate；写入图边。
- 差距：
  - span name 到图节点的匹配仅靠函数名正则，易错（同名函数多文件时取第一个）。
  - 不支持批量摄入、去重、时间窗口过滤。
  - 无持久化，服务重启后丢失。

**建议**：P2 — 按 qualifiedName 匹配；持久化；去重。

---

### 11. `manage_adr` ⚠️ 关键缺陷

**C 版本**
- 入口：`src/mcp/mcp.c`（对应 `manage_adr`）
- 参数：`project`, `mode` (get/update/sections), `content`, `sections`

**Sarosis 版本**
- 入口：`builtinToolProvider.ts:3988-4040`
- **关键问题**：handler 是**纯 stub**，仅返回 JSON hint 让 LLM 用文件工具操作 `.saros/adr/`。
- 但 `codebaseGraphAdr.ts` 已完整实现 `AdrManager` 类：
  - `list(rootUri)`：读取 `docs/adr/` 下 Markdown，解析 front matter 和分节。
  - `get(rootUri, id)`
  - `create(rootUri, adr)`：生成模板并写入文件。
  - `update(rootUri, id, sections)`
  - `delete(rootUri, id)`
  - `validate(adr)`
- 然而 `AdrManager` 在当前代码库中**只有定义，没有实例化或引用**（搜索 `AdrManager` 仅命中 `codebaseGraphAdr.ts`）。

**建议**：P0 — 立即在 `builtinToolProvider` 中实例化 `AdrManager` 并接入，替换 stub 逻辑。

---

## 三、索引管道与数据结构对比

### 1. 复杂度指标

**C 版本**：`internal/cbm/helpers.c:586-656` / `pass_complexity.c` 计算：
- `cyclomatic`（分支节点计数）
- `cognitive`（嵌套加权）
- `loop_count`, `loop_depth`
- `max_access_depth`
- 过程间传播：`transitive_loop_depth`, `recursive`, `linear_scan_in_loop`, `alloc_in_loop`, `recursion_in_loop`, `unguarded_recursion`

**Sarosis 版本**：
- `codebaseGraphService.ts:1279-1305` 已实现 `_computeComplexity()`，计算 `cyclomatic` + `maxLoopDepth`。
- `codebaseGraphPipeline.ts:305-312` 将 `cyclomatic`, `loops`, `conditionals` 写入 `node.properties`。
- 但 `cognitive`, `transitive_loop_depth`, `linear_scan_in_loop` 等高级指标未实现。

**差距**：P1 — 补齐 cognitive、transitive_loop_depth、linear_scan_in_loop。

### 2. 社区检测

**C 版本**：`src/store/store.c:5084-5481` 实现 Leiden 多层级检测，输出 `cohesion`, `top_nodes`, `packages`, `edge_types`。

**Sarosis 版本**：`codebaseGraphArchitecture.ts` 已有 Leiden，但缺少 cohesion、top_nodes、packages、edge_types 输出。

**差距**：P2 — 与 C 版对齐输出结构。

### 3. 文件节点索引

**C 版本**：FTS5 索引文件路径与内容，file 节点作为可搜索节点。

**Sarosis 版本**：file 节点创建时缺少 `label` 字段，导致 `findNodesByLabel('file')` 失效。这是 `search_code` 不可用的根因之一。

---

## 四、完整优先级矩阵

| 优先级 | 功能/问题 | 状态 | 建议文件 | 备注 |
|--------|-----------|------|----------|------|
| **P0** | `search_code` 返回空结果 | ❌ 严重 bug | `codebaseGraphService.ts`, `codebaseGraphPipeline.ts`, `builtinToolProvider.ts` | `fileContentProvider` 返回 undefined；file 节点缺少 `label` |
| **P0** | `manage_adr` 完全 stub | ❌ 严重 bug | `builtinToolProvider.ts`, `codebaseGraphAdr.ts` | AdrManager 已完整实现但未接入 |
| **P1** | `query_graph.max_rows` 未生效 | ❌ 参数脱节 | `builtinToolProvider.ts`, `codebaseGraphCypher.ts` | schema 声明未传递 |
| **P1** | `detect_changes.since` 未使用 | ❌ 参数脱节 | `codebaseGraphService.ts` | 无法按 commit/tag 对比 |
| **P1** | `detect_changes` 文件哈希未真正比较 | ❌ 逻辑缺陷 | `codebaseGraphChanges.ts` | 所有文件被标为 'M' |
| **P1** | `index_repository.mode` 未真正区分 | ❌ 参数脱节 | `codebaseGraphService.ts`, `codebaseGraphPipeline.ts` | 声明 fast/moderate/full 但行为一致 |
| **P1** | `get_architecture.path` 未实现过滤 | ❌ 参数脱节 | `codebaseGraphArchitecture.ts`, `builtinToolProvider.ts` | 仅作为元数据返回 |
| **P1** | `trace_path` maxDepth schema 与服务默认不一致 | ⚠️ | `builtinToolProvider.ts`, `codebaseGraphService.ts` | 3 vs 10 |
| **P1** | 语义向量搜索 (`semantic_query`) | ❌ 缺失 | `codebaseGraphSemantic.ts`, `builtinToolProvider.ts` | C 版核心能力 |
| **P1** | complexity 属性在 Cypher 中不可查 | ⚠️ 未暴露 | `codebaseGraphCypher.ts` | 已计算但未解析 `.properties.x` |
| **P2** | `get_architecture` 社区 cohesion/top_nodes/packages | ❌ 缺失 | `codebaseGraphArchitecture.ts` | 与 C 版差距 |
| **P2** | `trace_path` 返回完整路径/多源追踪 | ❌ 缺失 | `codebaseGraphTrace.ts` | 找到 target 即 break |
| **P2** | `search_graph` TF-IDF / 高级 glob | ⚠️ 简化 | `codebaseGraphStore.ts` | TF 固定为 1；glob 不支持 `**` |
| **P2** | `get_code_snippet` 模糊匹配 | ❌ 缺失 | `codebaseGraphService.ts` | 依赖精确 qualifiedName |
| **P2** | `get_graph_schema` 属性 schema | ❌ 缺失 | `codebaseGraphTrace.ts` | 不返回属性统计 |
| **P2** | Cypher `UNION`/`WITH`/反向边/变长路径 | ❌ 缺失 | `codebaseGraphCypher.ts` | 有 `executeExtendedCypher` 但未调用 |
| **P2** | 运行时 trace 持久化/精确匹配 | ❌ 缺失 | `codebaseGraphTraces.ts` | span name 匹配易错 |
| **P3** | 高级 complexity（cognitive/transitive/linear_scan） | ⚠️ 部分 | `codebaseGraphPipeline.ts` | 已计算 cyclomatic/loop_depth |

---

## 五、关键修复建议（按优先级排序）

### P0：立即修复 `search_code`

方案 A（最小改动）：
1. 在 `codebaseGraphPipeline.ts:132-140` 为 file 节点增加 `label: 'file'`。
2. 在 `codebaseGraphService.ts:1723-1728` 将 `fileContentProvider` 改为从 `fileService.readFile` 读取：

```typescript
const fileContentProvider = async (filePath: string): Promise<string | undefined> => {
    const folders = this._workspaceService.getWorkspace().folders;
    for (const folder of folders) {
        const candidate = URI.joinPath(folder.uri, filePath);
        if (await this._fileService.exists(candidate)) {
            const content = await this._fileService.readFile(candidate);
            return content.value.toString();
        }
    }
    return undefined;
};
```

3. 如果 `graphSearchCode` 保持同步，需要把 provider 签名改为异步。

方案 B（与 C 版对齐，推荐）：
- 工具层直接使用 `fileService` 遍历已索引文件做 grep/regex 匹配，再调用 `searchGraph` 获取包含函数做富化。这样不依赖 file 节点的 content 缓存，也能自然支持 `filePattern` 和 `path_filter`。

### P0：立即修复 `manage_adr`

在 `builtinToolProvider.ts` 中注入 `IFileService` 并实例化 `AdrManager`：

```typescript
private readonly _adrManager = new AdrManager(this.fileService);

// handler 中:
const rootUri = this.workspaceService.getWorkspace().folders[0]?.uri;
if (!rootUri) { return text('No workspace folder'); }

switch (action) {
  case 'list': return json(await this._adrManager.list(rootUri));
  case 'get': return json(await this._adrManager.get(rootUri, id!));
  case 'create': return json({ id: await this._adrManager.create(rootUri, { id, title, content }) });
  case 'update': return json({ success: await this._adrManager.update(rootUri, id!, { content }) });
  case 'delete': return json({ success: await this._adrManager.delete(rootUri, id!) });
}
```

### P1：修复 schema/实现脱节

1. **`query_graph.max_rows`**：在 `builtinToolProvider.ts` 中读取 `args.max_rows`，调用 `codebaseGraphService.executeCypher(query, maxRows)` 并在 Cypher 引擎中截断结果。
2. **`detect_changes.since` / `baseBranch`**：在 `codebaseGraphService.detectChanges` 中若 `since` 存在，则使用 Git API 获取 `since...HEAD` 的 diff；否则回退到 working tree。文件哈希回退应计算每个文件当前 SHA 并与存储的哈希比较。
3. **`index_repository.mode`**：将 mode 传入 `indexWorkspace` 并控制 passes 执行（如 `fast` 跳过 similarity/semantic/extended passes；`moderate` 执行过滤 + similarity；`full` 执行全部）。
4. **`get_architecture.path`**：在 `analyzeArchitecture` 中按 `path` 前缀过滤节点和文件。

### P2：中长期能力补齐

- 语义向量搜索 (`semantic_query`)：复用 `SemanticSearch` 类，提供 min-cosine 重排。
- Cypher 高级语法：反向边、属性访问、UNION/WITH、变长路径（可调用 `executeExtendedCypher`）。
- 社区检测增强：cohesion、top_nodes、packages、edge_types。
- `trace_path` 完整路径与多源追踪。
- 高级 complexity 指标。

---

## 六、结论

Sarosis 的内置 codebase 工具已经搭建了与 codebase-memory-mcp 对齐的**骨架**：索引、BM25 搜索、Cypher、架构分析、追踪、变更检测等模块均已存在。但当前最大的风险不是缺少高级功能，而是 **基础工具存在可用性缺陷**：`search_code` 实际无法工作，`manage_adr` 为纯 stub，多个 schema 参数与实现脱节。

建议按 **P0 → P1 → P2** 顺序修复：先让 `search_code` 和 `manage_adr` 真正可用，再补齐 schema/实现一致性，最后追赶语义搜索、Cypher 高级语法、社区 cohesion 等高级能力。
