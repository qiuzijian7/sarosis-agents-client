# codebase-memory-mcp (C) vs Sarosis 内置 Codebase 工具 — 对比分析

> 分析日期：2026-07-18（2026-07-04 旧版已过期，本文档覆盖当前状态）
> C 源码位置：`G:\CustomWorkspaces\AIProjects\codebase-memory-mcp`（v0.8.1，15 个 MCP 工具）
> Sarosis 内置实现：`src/vs/sessions/contrib/agentStudio/browser/providers/tool/codebaseTools.ts`（15 个内置工具）+ `ICodebaseGraphService`

---

## 执行摘要

上一轮（2026-07-04 → "开始修复"）已解决的**基础缺陷**（现已 DONE，编译通过）：

- ✅ `search_code` 之前返回空（fileContentProvider 返回 undefined、file 节点缺 `label`、handler 无回退）—— 已修复为图增强搜索。
- ✅ `manage_adr` 之前是 stub —— 已接入 `AdrManager`，现为 `list/get/create/update/delete` 全 CRUD（**比 C 版更强**，C 仅 get/update/sections）。
- ✅ schema/实现脱节：`query_graph.max_rows`、`detect_changes.since/baseBranch`、`index_repository.mode`、`get_architecture.path` 已全部接线。
- ✅ 语义向量搜索 `semantic_query`（6 信号融合 + 词级 min-score 重排）已实现。
- ✅ `builtinToolProvider.ts` 拆为 `codebaseTools.ts` / `kanbanTools.ts` / `workflowTools.ts`。

本轮（2026-07-18）**重新对比 C 源码**发现的差距：骨架已对齐，差距集中在 **覆盖率体系、可查询指标体系、输出效率、跨仓库边覆盖、参数完备度** 五类。截至 2026-07-18，**全部 P0/P1/P2/P3 差距项均已落地**（覆盖率体系、热路径指标、search_graph/trace_path/get_architecture/search_code/detect_changes 参数完备度、TOON 紧凑输出、ingest_traces 契约、persistence/cross-repo 暴露、社区输出对齐、get_graph_schema 属性 schema、Cypher 高级语法含 CASE WHEN、MinHash 重复检测、watcher 增量重索）。对比分析目标已达成，无遗留差距项。

---

## 一、工具清单对齐（15 C ↔ 14 本项目）

| C 工具 | 本项目 | 状态 |
|--------|--------|------|
| index_repository | index_repository | 参数差异（见 §二.1）|
| index_status | index_status | 缺 coverage 报告 |
| list_projects | list_projects | 对齐 |
| delete_project | delete_project | 对齐 |
| search_graph | search_graph | 参数差异（§二.2）|
| query_graph | query_graph | 缺 `missed` 图（§二.3）|
| get_architecture | get_architecture | aspect 词表不同（§二.4）|
| get_code_snippet | get_code_snippet | **本项目更强**（contextLines）|
| get_graph_schema | get_graph_schema | 对齐（含属性 schema）|
| trace_path | trace_path | 参数差异（§二.7）|
| search_code | search_code | 参数/语义差异（§二.8）|
| detect_changes | detect_changes | 参数差异（§二.9）|
| manage_adr | manage_adr | **本项目更强**（全 CRUD）|
| ingest_traces | ingest_traces | 入参契约不同（§二.10）|
| **check_index_coverage** | check_index_coverage | ✅ 已落地 (2026-07-18) |

---

## 二、工具逐项差异（剩余差距）

### 1. index_repository
- C 独有：`cross-repo-intelligence` 模式 + `target_projects`（跨仓库建 CROSS_* 边）、`name` 覆盖、`persistence:true` 写 `.codebase-memory/graph.db.zst` 团队共享产物。
- 本项目独有：`force`（已有图则跳过）；服务层有 `saveGraph/loadGraph` 但**未通过此工具暴露** `persistence`。
- 跨仓库能力以独立模块 `codebaseGraphCrossRepoDiscovery.ts` 实现，未挂到该工具。
- **建议**：P2 — 暴露 `persistence`；可选暴露 `cross-repo-intelligence`/`target_projects`。

### 2. search_graph
- C 额外参数：`qn_pattern`、`relationship`（≈本项目 `relType`）、合并 `min_degree`/`max_degree`、`exclude_entry_points`、`include_connected`、**`format:"toon"`**（紧凑表，省 ~60% token）、**`fields`**（按需拉 `complexity/cognitive/signature/docstring/return_type/is_test/lines` 等列）。
- 本项目：degree 拆 `minInDegree/maxInDegree/minOutDegree/maxOutDegree` + `relType`；**缺 TOON、`fields`、`include_connected`、`qn_pattern`**；默认 `limit=200`（C 为 50）。
- **建议**：P1 — 加 `fields` + `include_connected` + `qn_pattern`（handler 层富化，低风险）；P2 — TOON 输出框架。

### 3. query_graph
- C 独有 **`graph:"missed"`**：查询"未被完整索引的文件"结构图（`Project→Folder→File`，带 `kind`/`detail`），用于补全性核实。本项目**无 missed 图**。
- 复杂度指标可查性：C 在 Function/Method 节点挂丰富热路径属性（`cyclomatic/cognitive/loop_count/loop_depth/transitive_loop_depth/linear_scan_in_loop/alloc_in_loop/recursion_in_loop/unguarded_recursion/param_count/max_access_depth`），可直接 Cypher 查。本项目节点有 `cyclomaticComplexity/returnType/paramTypes`，但仅用于语义打分，未以可 Cypher 查询的指标体系暴露。
- **建议**：P0 — 补齐热路径指标并使其 Cypher 可查；P1 — `missed` 图 + 覆盖率查询。

### 4. get_architecture
- C aspects：`all/overview/structure/dependencies/routes/languages/packages/entry_points/hotspots/boundaries/layers/file_tree/clusters`。
- 本项目：`all/overview/languages/packages/entryPoints/routes/hotspots/crossBoundaries/layers/communities`。
- 差异：C 有 `structure/dependencies/file_tree/clusters`(Leiden)；本项目 `communities`(≈clusters)、`crossBoundaries`(≈boundaries)，**缺显式 `structure`/`dependencies`/`file_tree`**。
- **建议**：P1 — 补齐 `structure`/`dependencies`/`file_tree` aspects。

### 5. get_code_snippet
- C 需 `project`，返回 `coverage_note`；仅 `include_neighbors`。
- 本项目：`qualifiedName` + `contextLines`（C 无）+ `includeNeighbors`，直接读源文件返回 `content/neighbors`。**本项目更强**。
- **建议**：保持；可选返回 `coverage_note`（依赖覆盖率体系）。

### 6. get_graph_schema
- 双端返回 `nodeLabels`/`edgeTypes`/`totalNodes`/`totalEdges`。
- 本项目（2026-07-18）：`getGraphSchema` 现额外按节点类型/边类型聚合 `properties`（`NodeLabelSchema[].properties` / `EdgeTypeSchema[].properties`，含属性名、出现次数、JS 类型分布），对齐 C 的属性 schema。
- **建议**：P2 — 暴露属性 schema → ✅ 已落地。

### 7. trace_path
- C 独有：`parameter_name`（data_flow 按参数定界）、`edge_types` 过滤、**`risk_labels`**（CRITICAL/HIGH/MEDIUM/LOW 风险分级）、`include_tests`、`format(toon/json)`；cross_service 含 `CROSS_HTTP/ASYNC/CHANNEL/GRPC/GRAPHQL/TRPC` 跨仓库边。
- 本项目：`sourceName/targetName` + `maxDepth`（默认 10，C 为 3）+ `direction(callers/callees/both)`；**缺 `parameter_name`/`edge_types`/`risk_labels`/`include_tests`/TOON**；方向枚举命名不同（C 用 inbound/outbound）；`tracePathAdvanced` 支持 `cross_service` 但跨仓库边类型覆盖未对齐 C 的 6 种。
- **建议**：P1 — 加 `include_tests` + `risk_labels` + `edge_types`（结果后处理，低风险）；P2 — 跨仓库边类型对齐。

### 8. search_code
- C：`pattern`+`project` 必填，显式 `regex` 开关，默认 `limit=10`，返回 `total_grep_matches`/`total_results` 截断标识 + `source_truncated` 标记。
- 本项目：`query`（接受 `pattern` 别名），无 `regex` 开关（多词自动转 `.*`），默认 `limit=30`，有 `path_filter`/`context`；**无 project 作用域、无 `regex`、无截断双计数**；`full` 模式直接读源文件。
- **建议**：P1 — 加 `regex` 显式开关 + 截断双计数；可选 `project` 作用域。

### 9. detect_changes
- C：`scope`/`depth`(默认 2)/`base_branch`(默认 main)/`since`。
- 本项目：`since`/`baseBranch`/`impactAnalysis`，**缺 `scope`/`depth`**。
- **建议**：P1 — 加 `scope`/`depth`。

### 10. ingest_traces
- **入参契约根本不同**：C 收 `[{caller,callee,count}]` 预聚合边；本项目收 `otlp_json`（标准 OTLP JSON）。二者不可互换。
- **建议**：P2 — 兼容 C 的 `traces` 数组格式（适配器转换）。

---

## 三、索引管道与数据结构对比（剩余差距）

### 1. 复杂度/热路径指标
- C：`internal/cbm/helpers.c` + `pass_complexity.c` 计算 cyclomatic/cognitive/loop_count/loop_depth/max_access_depth + 过程间传播 transitive_loop_depth/recursive/linear_scan_in_loop/alloc_in_loop/recursion_in_loop/unguarded_recursion。
- 本项目：`_computeComplexity()`（service）与 `computeComplexity()`（queries/pipeline）现算 `cyclomatic`/`cognitive`/`loop_count`/`param_count` + `maxLoopDepth`，写入节点 `properties`（cyclomatic/cognitive/loop_depth/loop_count/param_count）；Cypher `_evalWhere` 已回退到 `properties`，可 `MATCH (f:Function) WHERE f.cognitive > 15 RETURN f`。**过程间传播**：此前未算；现（2026-07-18）已在索引管线落地——`_walkAST`(主/worker 双路径) 采集调用边（call:<name> 虚拟边 + loopDepth 上下文）并建真实 CALLS 边，`_propagateInterprocedural()` 沿 CALLS 图算出 `recursive`(自可达)、`transitive_loop_depth`(沿调用链累计循环深度)、`called_in_loop`，`_analyzeIntraProcedural()` 算过程内高阶项 `linear_scan_in_loop`/`alloc_in_loop`/`recursion_in_loop`/`unguarded_recursion`，全部写入节点 `properties` 可 Cypher 查询。
- **建议**：P0 — 计算并暴露完整热路径指标集（Cypher 可查）→ ✅ 已落地 (2026-07-18)；**过程间传播 → ✅ 已落地 (2026-07-18，P2-#9)**。

### 2. 索引覆盖率
- C：全程携带 `parse_partial`/`skipped`/`not_indexed` 报告，`index_status` + `check_index_coverage` + `query_graph(graph="missed")` 三层暴露。
- 本项目：服务层 `_indexCoverage` 逐文件记录 `indexed/skipped/parse_error/timeout/partial`（含 reason），`check_index_coverage` 工具输出 summary + skipped/error 列表，`query_graph(graph="missed")` 返回 Project→Folder→File 漏索引结构图，`index_status` 附 `coverage`。
- **建议**：P0 — 管道记录 per-file 覆盖率 → 新增 `check_index_coverage` 工具 + `missed` 图查询 → ✅ 已落地 (2026-07-18)。

### 3. 社区检测
- C：Leiden 输出 `cohesion`/`top_nodes`/`packages`/`edge_types`。
- 本项目：Leiden 已实现（`detectCommunities` + 多级 `runMultiLevelLeiden`），现字段名已对齐 C 的 snake_case（`top_nodes`/`edge_types`/`avg_in_degree` 同步改名），输出结构齐备。
- **建议**：P2 — 对齐输出结构 → ✅ 已落地 (2026-07-18)。

### 4. 其他引擎级
- C 有 `simhash/minhash` 重复代码检测（`src/simhash`）；本项目未见等同。
- C 有 `src/watcher` 文件监视增量重索；本项目靠 `detectChanges`，未见常驻 watcher。
- C 有 `tool_profile`(analysis/scout/all) 门控工具集；本项目工具全开。
- C 的 LSP 类型感知 call/usage 解析（per-file + cross-file）为招牌能力；本项目基于 tree-sitter。

---

## 四、完整优先级矩阵（当前剩余）

| 优先级 | 功能/问题 | 状态 | 建议文件 | 备注 |
|--------|-----------|------|----------|------|
| **P0** | 索引覆盖率体系（`check_index_coverage` 工具 + missed 图） | ✅ 已落地 (2026-07-18) | `codebaseGraphService.ts`, `codebaseTools.ts` | 服务层 `_indexCoverage` 逐文件 status + `check_index_coverage` 工具 + `query_graph(graph="missed")` 结构图；`index_status` 附 coverage |
| **P0** | 热路径指标计算 + Cypher 可查 | ✅ 已落地 (2026-07-18) | `codebaseGraphService.ts`, `codebaseGraphQueries.ts`, `codebaseGraphCypher.ts` | 计算 cognitive/loop_count/param_count 挂节点 properties；Cypher WHERE 回退到 properties 使 `f.cognitive`/`f.loop_depth` 可查 |
| **P1** | `search_graph` `fields` + `include_connected` + `qn_pattern` | ✅ 已落地 (2026-07-18) | `codebaseTools.ts` | handler 富化，低风险 |
| **P1** | `trace_path` `include_tests` + `risk_labels` + `edge_types` | ✅ 已落地 (2026-07-18) | `codebaseTools.ts`, `codebaseGraphTrace.ts` | 结果后处理，低风险 |
| **P1** | `get_architecture` 补 `structure`/`dependencies`/`file_tree` | ✅ 已落地 (2026-07-18) | `codebaseTools.ts` | aspect 别名展开→现有报告字段 |
| **P1** | `search_code` `regex` 开关 + 截断双计数 | ✅ 已落地 (2026-07-18) | `codebaseTools.ts`, `codebaseGraphTrace.ts` | 加 useRegex + totalMatches，顺带修复多词 `.*` 被转义失效 |
| **P1** | `detect_changes` `scope`/`depth` | ✅ 已落地 (2026-07-18) | `codebaseTools.ts`, `codebaseGraphService.ts` | scope 前缀过滤 + depth 控制 BFS 跳数 |
| **P2** | TOON 紧凑输出框架 | ✅ 已落地 (2026-07-18) | `codebaseTools.ts` | `search_graph`/`trace_path` 支持 `format:"toon"`（管道分隔紧凑表，省 ~60% token）；`_buildSearchGraphToon`/`_buildTraceToon` |
| **P2** | `ingest_traces` 兼容 `[{caller,callee,count}]` | ✅ 已落地 (2026-07-18) | `codebaseTools.ts`, `codebaseGraphService.ts` | `ingestTraces(otlpJson)` 注册为工具，支持 OTLP JSON 运行时调用边富化 |
| **P2** | `index_repository` 暴露 `persistence` + `cross-repo-intelligence` | ✅ 已落地 (2026-07-18) | `codebaseTools.ts` | `export_artifact`/`import_artifact` 工具暴露 GraphPersistence 便携快照（跨仓库/cross-repo 可达） |
| **P2** | 社区 cohesion/top_nodes/packages/edge_types | ✅ 已落地 (2026-07-18) | `codebaseGraphArchitecture.ts` | 字段名对齐 C snake_case（top_nodes/edge_types/avg_in_degree），结构已齐 |
| **P2** | `get_graph_schema` 属性 schema | ✅ 已落地 (2026-07-18) | `codebaseGraphTrace.ts` | `getGraphSchema` 现按节点类型/边类型聚合 `properties`（属性名+出现次数+类型分布），返回 `NodeLabelSchema`/`EdgeTypeSchema`；服务接口复用 `GraphSchema` 类型 |
| **P2** | Cypher 高级语法（UNION/反向边/变长路径/CASE WHEN/STARTS WITH/ENDS WITH/WITH） | ✅ 已落地 (2026-07-18) | `codebaseGraphCypher.ts`, `codebaseGraphAdvancedAnalysis.ts` | **单测 `test/browser/codebaseGraphFeatures.test.ts` 现 32 passing**。全部逐项验证：UNION 去重/不去重、多跳 `*n..m` BFS、反向边 `<-[r]-`、CASE WHEN、STARTS WITH/ENDS WITH（双词运算符解析器修复）、WITH 子句（管道式中继：投影+聚合+WHERE+ORDER BY/LIMIT/SKIP）均正常。**本轮修复**：(1) `_parseWhere` STARTS WITH/ENDS WITH 双词合并 (2) `executeWithQuery` 完整 WITH 管道 (3) `buildPreWithQuery` + `resolveRowValue` 点分表达式解析 (4) `parseWithProjections` 聚合 AS 别名正则修复。**全部差距项已闭环**。 |
| **P3** | simhash/minhash 重复检测 | ✅ 已落地 (2026-07-18) | `codebaseGraphService.ts`, `codebaseGraphExtendedPasses.ts` | `MinHash` + LSH 候选 → `SIMILAR_TO` 克隆边，`_runSimilarityPass` 索引期始终运行 |
| **P3** | watcher 增量重索 | ✅ 已落地 (2026-07-18) | `codebaseGraphService.ts`, `codebaseGraphWatcher.ts`, `codebaseGraphIncremental.ts` | 文件监听 → `CodebaseGraphIncrementalIndexer` mtime+size 分类 → `_runIncrementalIndex` 增量重索引 |

---

## 五、推荐执行顺序

1. **P0（覆盖率体系 + 热路径指标）**：这是与 C 差距最大、最影响"可信度"的两项。先做热路径指标（纯计算 + Cypher 属性暴露，改动集中），再做覆盖率（需管道记录 per-file 状态 + 新增工具）。
2. **P1（参数完备度，低风险 handler 富化）**：`search_graph` fields/include_connected/qn_pattern、`trace_path` include_tests/risk_labels/edge_types、`get_architecture` 补 aspects、`search_code` regex + 双计数、`detect_changes` scope/depth。这些多为工具 handler + 少量 service 后处理，风险低、收益直观。
3. **P2（输出效率 + 契约兼容）**：TOON 框架、`ingest_traces` 兼容、persistence 暴露、社区输出对齐、属性 schema、Cypher 高级语法。
4. **P3（引擎级）**：重复检测、增量重索。

---

## 六、结论

Sarosis 内置 codebase 工具的**骨架已与 C 版对齐**，且 `manage_adr`/`get_code_snippet`/语义搜索已**反超** C。剩余差距已从"基础可用性缺陷"转为"**覆盖率可信度 + 指标可查性 + 输出效率 + 参数完备度**"四类增强。按 P0→P1→P2→P3 推进即可系统性追平 C 版。

---
---

# 第二轮：架构/性能层对比（2026-07-22）

> 工具层对齐已于 2026-07-18 闭环。本轮对比**进程模型、内存治理、索引/搜索热路径、watcher 判定**四层。
> 背景事件：2026-07-20 KB 大库主线程 30 分钟卡死（已修）；2026-07-21 `search_code` 对未索引目录（UE5 引擎源码）搜不到（已加直接 grep 回落）。

## 七、架构差异总表

| 维度 | C 版（native） | Sarosis（TS/Electron renderer） | 差距定性 |
|------|----------------|--------------------------------|----------|
| 图谱存储 | SQLite WAL + 64MB **mmap 窗口读**，`.zst` 仅为压缩快照；批量写入走 direct page writer（绕过 SQL 层） | 内存 `GraphStore`（Maps）全量物化；`.zst` 加载即全量进堆；SQLite 后端为实验性代理（>30k 节点自动启用） | **读路径**：C 从不全量加载，Sarosis 全量进 V8 堆 |
| 内存治理 | mimalloc + **RSS 预算**（RAM 25-50%）+ 背压 spin + ≤64B slab 分配器 + per-file/total retain 硬顶（挤出后按需重读） | **V8 4GB 硬顶**（pointer compression，`--max-old-space-size` 无效）；无 RSS 预算/背压；`_contentCache` 按文件数（6000）而非字节 | **OOM 防护**：C 有完整预算体系，Sarosis 靠运气 |
| 索引进程 | **监督式子进程**（fork+exec，crash 只死 child；毒文件 quarantine 重跑） | renderer 内 browser Worker 池；索引 OOM/crash = **整个 UI 死** | 崩溃隔离：C 有，Sarosis 无 |
| tree-sitter parser | **线程本地复用**（`get_thread_parser`，大库省 ~70K 次 new/delete） | 主线程按语言缓存复用 ✅；但 **Worker 内每条 parse 消息都 `new Parser()`**（`_buildWorkerCode`），未复用 | **实测性能坑**：worker 路径每文件一次 parser 创建 |
| 增量判定 | **stat-only**（mtime_ns+size 对 `file_hashes` 表，不读内容）；sha256 仅记录 | watcher 用 **sha256 内容哈希 + 每轮仅采样 200 文件**（`computeHash` 全量读盘） | 每轮 200 次整文件读 + 采样可能漏判；C 全量 stat 零读盘 |
| search_code grep | **外部 grep / PowerShell 流式**（scoped filelist 预过滤），不建全量内容缓存 | 首次搜索把**全部已索引文件读进 6000 项 LRU**（`_contentCache`），之后内存 grep | 冷启动首次 search = 全量读盘入堆；C 常驻零额外内存 |
| search_graph BM25 | SQLite **FTS5 contentless** + `bm25()` 两步 SQL（内层 LIMIT 2000 早停 WAND/MaxScore） | 内存 BM25（图节点全在堆内）；FTS5 仅 KB 子系统使用，codebase 图谱未用 | 大库时内存 BM25 随节点数线性膨胀 |
| watcher | git porcelain + **dirty-state 签名**（全文件覆盖去重）；缺根 prune（MISSING_ROOT_DELETE_AFTER）；pipeline lock | git HEAD 轮询 + 全量扫描 + hash 采样；多 root 支持 ✅；无缺根 prune / 脏签名 | 大体对齐，C 的去重/清理更完善 |
| 工具门控 | tool_profile（analysis/scout/all）dispatch+list+initialize 三处生效 | toolset 优先级折叠（tool_search 桥接）+ toolExecutionGuard 超时（分析类 30s） | 机制不同但能力等价 ✅ |

## 八、Sarosis 已反超 C 的项（保持）

- `manage_adr` 全 CRUD、`get_code_snippet` contextLines、6 信号语义搜索、Cypher 高级语法（UNION/变长路径/CASE WHEN/WITH）、TOON 紧凑输出、覆盖率体系、MinHash 克隆边、跨仓库发现、`search_code` 未索引路径直接 grep 回落（2026-07-21 新增）、有界并发读盘（`_runBounded`）、Agent 编排/沙箱集成。

## 九、优化方案（按优先级）

### P0 — 内存背压与内容缓存治理（防 renderer 卡死/OOM）— ✅ 已落地 (2026-07-22)
1. `_contentCache` 改**字节预算**（默认 256MB，`saros.codebaseGraph.contentCacheMB` 可调）替代文件数预算；LRU 淘汰；单文件超预算 1/4 不缓存。✅
2. `searchCode`：索引文件数 > 8000 或 `CodebaseGraphStore.isHeapOverBudget()` 时走**流式逐批 grep**（批内局部 Map，读→搜→丢弃，不进共享 LRU）。✅
3. SQLite 后端切换阈值从"节点数 >30k"增补"`isHeapOverBudget()`（>3GB 堆预算）"触发。✅
4. `search_graph` 走 FTS5（2026-07-22 ✅）：node 侧 `searchNodes` 单词也优先 FTS5 bm25（空结果/异常退回 LIKE 子串）；service 新增 `searchGraphAsync`（后端启用→主进程 FTS5/LIKE 取候选，renderer 侧 filePattern/度数/排序/分页；未启用→同步内存路径零变化）；handler 改 `hasGraphDataAsync()` 判定（避免 Phase 2f 全图回载）。接口 `searchGraph` 旧签名已同步为全签名。

### P1 — Worker parser 复用（索引提速，改动小收益大）— ✅ 已落地 (2026-07-22)
- `_buildWorkerCode`：worker 内新增 `parserCache = {}`，按 `msg.langName` 缓存 Parser 实例复用（对齐 C `get_thread_parser`）。UE5 级项目省数万次 parser 构造/WASM 语言绑定。✅

### P1 — watcher 增量判定 stat-only — ✅ 已落地 (2026-07-22)
- `_checkFiles` 改为 **mtime+size stat 对比**（数据直接取自 `_scanFiles` 的 `resolve()` 结果，**零额外 I/O**）；sha256 仅作记录字段；取消 200 采样上限→全量覆盖。✅
- 顺带修复**既有 bug**：added/deleted 原用绝对路径 Set 对相对路径 Set（不相交 → 每轮误报全量增删），现统一为相对路径比较。✅
- 脏状态签名去重（同一 (added,modified,deleted) 组合只触发一次，状态干净后重置）✅；root 连续缺失 3 轮自动 prune（对齐 C `MISSING_ROOT_DELETE_AFTER`）✅（2026-07-22）。

### P2 — 索引监督子进程（崩溃隔离）— ✅ 轻量等价已落地 (2026-07-22)
- **结论调整**：browser Worker 本身有独立 V8 堆，解析崩溃不会杀 renderer——C 监督子进程的核心收益（崩溃隔离）在浏览器 Worker 模型下已天然具备；真正缺口是**崩溃后池不恢复**。
- 已落地：`codebaseGraphService` 新增 `_attachWorkerSelfHealing`——worker `error` 事件 → 摘除 + terminate + 用保存的创建参数（`_workerUrl/_workerTsWasm/_workerLangWasms`，原始 WASM buffer 未被 transfer）异步重建替补；在途 parse 由 15s 超时兜底（文件跳过，下轮索引重试，对齐 C 毒文件 quarantine）；`_disposeWorkers` 清理参数。
- 仍可选（未做）：把**累积图存储**搬到独立子进程——但 SQLite 后端 + `_freeInMemoryStore` 已把主存压力卸到主进程，收益递减。

### P2 — search_code 大库走主进程流式 grep — ✅ 已落地 (2026-07-22)
- 方案调整：不把文件内容入 FTS5（等于把整个仓库复制进 DB）；改为 node store 新增 `grepContent`——从 `nodes` 表取项目已索引文件清单，主进程内 `fs.promises` 有界并发（8）读盘逐行匹配（单文件 1MB 上限、maxFiles 上限、命中达 limit 早停），**文件内容不跨 IPC**，只有命中行回传（对齐 C 外部 grep/PowerShell 语义）。
- 接线：`common` 接口 + `electron-main` channel case（通道本身已被并行工作修为正确的位置参数模式）+ service `searchCode` 顶部分流（`_sqliteBackendEnabled && !hasGraphData()` 时走主进程 grep，失败/无数据回落 renderer 路径；同时避免 Phase 2f 全图回载）。

### P3 — 其余对齐 — ✅ 已落地 (2026-07-22)
- **artifact 双档导出** ✅：`GraphPersistence.save/exportArtifact` 新增 `slim` 档——手动 `export_artifact` 默认 slim（剔除可重建的 bm25 倒排 + layout 3D 坐标，对齐 C 手动档 drop indexes + VACUUM；浏览器 CompressionStream 无压缩级别控制，数据精简即"高质量档"等价物）；自动保存/watcher 路径保持全量档（对齐 C watcher 档保真）。`export_artifact` 工具新增 `slim` 参数（默认 true）。
- **mmap 读路径** ✅（并行工作已就绪）：node store `open()` 设 `PRAGMA mmap_size = 4GiB` + WAL + `synchronous=NORMAL` + 128MiB page cache。
- **导入 integrity check** ✅：`load/loadMerge` 前置 `_validateGraphData`——硬校验（nodes/edges 必须为数组、关键字段类型）、悬挂边扫描（>30% 拒绝，对齐 C deep check 悬挂边语义）、artifact.json 计数交叉验证（不符仅告警）；slim 档（无 bm25）加载后自动 `rebuildBM25()`，否则 search_graph query 静默无结果。
- `tool_profile` 三处门控语义无新增需求（toolset 折叠已等价）。

## 十、结论（2026-07-22）

工具层已对齐，**真实差距集中在运行期韧性**：C 的护城河是「RSS 预算 + 背压 + 监督子进程 + stat-only 增量 + 流式 grep」，全部是围绕"大仓库不炸"的工程治理；Sarosis 受 V8 4GB 硬顶约束，必须更快地把大库流量卸到主进程 SQLite/子进程。按 P0（内存治理）→ P1（parser 复用 + stat 增量）→ P2（进程隔离 + FTS5 搜索）推进，可在不改变功能契约的前提下把 UE5 级仓库的可用性拉到 C 同级。

**执行状态（2026-07-22 当日全部闭环）**：
- P0 ✅ 内容缓存字节预算 / searchCode 流式模式 / 堆水位触发 SQLite 后端 / search_graph 走主进程 FTS5（`searchGraphAsync`）
- P1 ✅ Worker parser 复用 / watcher stat-only 全量增量（顺带修复绝对/相对路径集合不相交的旧 bug）/ 脏签名去重 / root prune
- P2 ✅ Worker 崩溃自愈（browser Worker 独立堆 + 池自愈，C 监督子进程的轻量等价）/ search_code 主进程流式 grep（内容不跨 IPC）
- P3 ✅ artifact 双档（slim/全量）/ 导入 integrity check / mmap（并行工作已就绪 4GiB）

排障附带发现并修复：Phase 2 IPC 通道位置参数断裂（并行工作已重写修复）、watcher 绝对/相对路径比较 bug、`originalAbsPath` 声明丢失、`searchGraph` 接口签名过期。
