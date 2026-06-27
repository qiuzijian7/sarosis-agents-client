# Codebase Memory 1:1 复刻方案

> 目标：将原版 C 项目 `codebase-memory-mcp` 的全部功能 1:1 复刻为 TypeScript 实现，作为 VS Code 内嵌原生服务。
>
> 参考源：`G:\CustomWorkspaces\AIProjects\codebase-memory-mcp\` (C11, ~50 万行)
> 本项目：`src/vs/sessions/contrib/agentStudio/browser/codebase*.ts` (27 文件, ~340KB)

---

## 一、当前差距总览

| 维度 | 原版 C | 本项目 TS | 覆盖率 |
|------|--------|----------|--------|
| 存储引擎 | SQLite + FTS5 + WAL + zstd | 内存 Map + JSON | 30% |
| 解析 Pass | 22 pass + 多线程并行 | 10 pass 单线程 | 45% |
| 语义信号 | 11 信号 + 768 维向量 + LSH | 6 信号简化 | 55% |
| Cypher | 完整子集 (152KB C) | 基础子集 (~400 行) | 60% |
| MCP 工具 | 14 个 JSON-RPC | 7 个内嵌 API | 50% |
| 社区检测 | 多级 Leiden + refinement | Label Propagation | 30% |
| 3D 布局 | Barnes-Hut + 两级 LOD + 位置缓存 | Barnes-Hut octree | 70% |
| 语言支持 | 158 种 | 14 种 (受 VS Code WASM 限制) | 9% |
| 类型推断 | Hybrid LSP (9 语言) | VS Code LSP API (未集成管线) | 10% |
| 增量索引 | 磁盘 SQLite 增量 + WAL | 内存 SHA-256 跳过 | 40% |
| 持久化 | graph.db.zst 压缩制品 | JSON (无压缩) | 20% |
| 跨仓库 | 自动发现 + 6 种 CROSS_* 边 | 手动 addCrossEdge | 10% |
| ADR | 完整 CRUD + 分节 + 校验 | 空壳 | 20% |
| Trace 摄入 | OTLP 解析 + 图增强 | 空壳 | 10% |

---

## 二、完全缺失的功能（A 类 — 必须补齐）

### A1. Graph Buffer 中间层 (graph_buffer.c — 56KB)

**原版 API**：
```c
typedef struct cbm_gbuf_t cbm_gbuf_t;
typedef struct cbm_gbuf_node_t { u64 id; char* label; char* name; ... } cbm_gbuf_node_t;
typedef struct cbm_gbuf_edge_t { u64 source_id; u64 target_id; char* type; ... } cbm_gbuf_edge_t;

cbm_gbuf_t* cbm_gbuf_create(size_t initial_capacity);
u64 cbm_gbuf_add_node(cbm_gbuf_t* gbuf, const char* label, const char* name, ...);
void cbm_gbuf_add_edge(cbm_gbuf_t* gbuf, u64 source_id, u64 target_id, const char* type, ...);
void cbm_gbuf_merge_into(cbm_gbuf_t* dst, cbm_gbuf_t* src);  // 批量合并
void cbm_gbuf_dump_to_store(cbm_gbuf_t* gbuf, cbm_store_t* store);  // 序列化到 SQLite
```

**复刻规格**：
```typescript
// codebaseGraphBuffer.ts (新建)
export class GraphBuffer {
  private _nodes: Map<string, GraphBufferNode> = new Map();  // QN → node
  private _edges: GraphBufferEdge[] = [];
  private _nextId = 1;

  addNode(label: string, name: string, opts: GraphNodeOpts): number;
  addEdge(sourceId: number, targetId: number, type: string, opts?: EdgeOpts): void;
  mergeInto(dst: GraphBuffer): Map<number, number>;  // 返回 ID 映射
  dumpToStore(store: CodebaseGraphStore, project: string): void;
  clear(): void;
  get size(): { nodes: number; edges: number };
}
```

**用途**：并行管线中每个 worker 独立写入 gbuf，最后 merge 到主 gbuf，再 dump 到 store。

---

### A2. 多线程并行管线 (pass_parallel.c — 115KB)

**原版三阶段**：
- Phase 3A：并行提取（per-worker gbuf，文件级隔离）
- Phase 3B：串行注册表构建（合并 gbuf + 构建名称索引）
- Phase 4：并行调用/用法/语义解析（基于注册表）

**复刻规格**：
```typescript
// codebaseGraphParallelPipeline.ts (新建)
export class ParallelPipeline {
  constructor(
    private _fileService: IFileService,
    private _treeSitterLib: ITreeSitterLibraryService,
    private _store: CodebaseGraphStore,
    private _logService: ILogService,
  ) {}

  async run(files: string[], config: IPipelineConfig, token: CancellationToken): Promise<IPipelineResult> {
    // Phase 3A: 并行提取（使用 VS Code Worker 或 Promise.all 分批）
    const workerResults = await this._parallelExtract(files, config, token);
    // Phase 3B: 串行合并 + 名称索引构建
    const registry = this._buildRegistry(workerResults);
    // Phase 4: 并行解析调用/用法/语义边
    await this._parallelResolve(workerResults, registry, token);
    // Dump to store
    this._dumpToStore(workerResults);
    return { filesProcessed: files.length, nodesExtracted: ..., edgesExtracted: ... };
  }

  private async _parallelExtract(files: string[], config: IPipelineConfig, token: CancellationToken): Promise<GraphBuffer[]> {
    // 使用 Promise.all 分批（每批 8 个文件），避免 Web Worker 跨域限制
    const BATCH_SIZE = 8;
    const batches = this._chunk(files, BATCH_SIZE);
    const results: GraphBuffer[] = [];
    for (const batch of batches) {
      if (token.isCancellationRequested) break;
      const batchResults = await Promise.all(batch.map(f => this._extractFile(f, config, token)));
      results.push(...batchResults);
    }
    return results;
  }
}
```

**关键点**：VS Code renderer 进程无真线程，用 `Promise.all` 分批实现"伪并行"（IO 并发 + CPU 串行）。若需真并行，可用 Web Worker（`worker_threads`）。

---

### A3. 跨文件 LSP 类型推断 (pass_lsp_cross.c — 24KB)

**原版**：per-language 预构建注册表（`CBMCrossLspRegistries`），module-def 索引，类型感知调用解析。

**复刻规格**：
```typescript
// codebaseGraphLsp.ts (扩展现有)
export class LspCrossResolver {
  private _defIndex: Map<string, Map<string, number>> = new Map();  // module → (name → nodeId)
  private _registries: Map<string, CrossLspRegistry> = new Map();  // language → registry

  /** 预构建：扫描所有文件，建立 module→name→nodeId 索引 */
  buildDefIndex(nodes: GraphNode[]): void;

  /** 跨文件调用解析：给定调用点 (file, calleeName) → 返回目标 nodeId */
  resolveCall(filePath: string, calleeName: string, language: string): number | undefined;

  /** 使用 VS Code LSP API 精确解析（fallback） */
  async resolveViaLsp(uri: URI, position: Position): Promise<number | undefined>;
}

interface CrossLspRegistry {
  language: string;
  moduleExports: Map<string, Set<number>>;  // moduleName → nodeIds
  typeDefinitions: Map<string, number>;      // typeName → nodeId
  importAliases: Map<string, string>;        // alias → realPath (path_alias)
}
```

---

### A4. 路径别名解析 (path_alias.c — 16KB)

**复刻规格**：
```typescript
// codebaseGraphPathAlias.ts (新建)
export class PathAliasResolver {
  private _aliases: Map<string, PathAlias[]> = new Map();  // dir → aliases (目录作用域)

  /** 解析 tsconfig.json/jsconfig.json 的 compilerOptions.paths */
  loadFromTsConfig(rootPath: string): Promise<void>;

  /** 解析当前文件作用域内的别名 */
  resolveAlias(importPath: string, fromFile: string): string | undefined;

  /** 查找文件最近的祖先配置 */
  findConfigForFile(filePath: string): string | undefined;
}

interface PathAlias {
  pattern: string;      // "@/*"
  replacement: string;  // "src/*"
  baseUrl: string;      // "."
}
```

---

### A5. 环境变量 URL 扫描 (pass_envscan.c — 15KB)

**复刻规格**：
```typescript
// codebaseGraphEnvScan.ts (新建)
export interface EnvBinding {
  key: string;
  value: string;
  url?: string;
  filePath: string;
  lineNo: number;
  isSecret: boolean;
}

export function scanEnvUrls(rootPath: string, fileService: IFileService): Promise<EnvBinding[]>;
// 扫描 .env, Dockerfile, *.sh, *.yaml, *.toml, *.tf, *.properties
// 过滤密钥（AWS_SECRET_ACCESS_KEY, *_TOKEN, *_PASSWORD 等）
// 提取 URL 值 → 建立 ENV_URL 边
```

---

### A6. 配置-代码链接 (pass_configlink.c — 14KB)

**复刻规格**：
```typescript
// codebaseGraphConfigLink.ts (新建)
export interface ConfigLink {
  configNode: number;
  codeNode: number;
  strategy: 'key_to_symbol' | 'dep_to_import' | 'file_to_ref';
  confidence: number;
}

export function linkConfigToCode(
  store: CodebaseGraphStore,
  project: string,
  configFiles: string[],
): ConfigLink[];
// 策略 1: 配置键归一化 → 匹配函数名 (置信度 0.6)
// 策略 2: 包清单依赖 → 匹配 IMPORTS 边 (置信度 0.8)
// 策略 3: 源码字符串引用配置文件路径 (置信度 0.9)
```

---

### A7. 跨仓库自动发现 (pass_cross_repo.c — 28KB)

**复刻规格**：
```typescript
// codebaseGraphCrossRepo.ts (新建，替换现有空壳)
export class CrossRepoMatcher {
  constructor(private _multiProject: CodebaseGraphMultiProject) {}

  /** 自动发现跨仓库边 */
  async discoverCrossRepoEdges(): Promise<CrossRepoEdge[]> {
    const edges: CrossRepoEdge[] = [];
    // 1. 收集所有项目的 Route/Channel 节点
    const allRoutes = this._collectAllRoutes();
    // 2. 对每个 HTTP_CALLS 边，在其他项目找匹配 Route
    for (const call of this._httpCalls) {
      const match = this._findRoute(call.url, call.method, allRoutes);
      if (match) edges.push({ type: 'CROSS_HTTP_CALLS', ... });
    }
    // 3. Channel 匹配（EMITS ↔ LISTENS_ON 跨项目）
    // 4. gRPC/GraphQL/tRPC 服务调用
    return edges;
  }
}
```

---

### A8. 磁盘增量索引 (pipeline_incremental.c — 38KB)

**复刻规格**：
```typescript
// codebaseGraphIncremental.ts (新建)
export class IncrementalIndexer {
  constructor(private _store: CodebaseGraphStore) {}

  /** 磁盘增量索引：直接操作 store，不重建内存图 */
  async runIncremental(rootPath: string, config: IIndexConfig, token: CancellationToken): Promise<IIndexResult> {
    // 1. 扫描文件，比较 mtime+size（比 SHA-256 快）
    const { added, modified, deleted, unchanged } = await this._classifyFiles(rootPath);
    // 2. 删除变更文件的节点（级联删边）
    for (const f of [...deleted, ...modified]) {
      this._store.deleteNodesByFile(project, f);
    }
    // 3. 只解析新增/修改文件
    for (const f of [...added, ...modified]) {
      const result = await this._parseFile(f, token);
      this._store.upsertNodes(result.nodes);
      this._store.insertEdges(result.edges);
    }
    // 4. WAL checkpoint
    this._store.checkpoint();
    return { added, modified, deleted, unchanged, duration };
  }
}
```

---

### A9. 索引锁 (pipeline.h)

**复刻规格**：
```typescript
// codebaseGraphService.ts (集成)
private _indexLock: Promise<void> = Promise.resolve();
private _isIndexLocked = false;

async tryLockIndex(): boolean {
  if (this._isIndexLocked) return false;
  this._isIndexLocked = true;
  return true;
}

async lockIndex(): Promise<() => void> {
  const prev = this._indexLock;
  let release!: () => void;
  this._indexLock = new Promise(r => { release = () => { this._isIndexLocked = false; r(); }; });
  await prev;
  this._isIndexLocked = true;
  return release;
}
```

---

### A10. 压缩制品持久化 (artifact.c — 25KB)

**复刻规格**：
```typescript
// codebaseGraphPersistence.ts (重写)
import * as fzstd from 'fzstd';  // zstd WASM

export class GraphPersistence {
  /** 导出压缩制品 graph.db.zst */
  async exportArtifact(store: CodebaseGraphStore, targetPath: string): Promise<void> {
    const json = store.toJSON();
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const compressed = fzstd.compress(jsonBytes);
    await this._fileService.writeFile(URI.file(targetPath), VSBuffer.wrap(compressed));
  }

  /** 从制品导入 */
  async importArtifact(store: CodebaseGraphStore, sourcePath: string): Promise<boolean> {
    const content = await this._fileService.readFile(URI.file(sourcePath));
    const compressed = content.value.buffer;
    const decompressed = fzstd.decompress(compressed);
    const json = JSON.parse(new TextDecoder().decode(decompressed));
    store.fromJSON(json);
    return true;
  }
}
```

**依赖**：`npm install fzstd` (zstd WASM, ~50KB)

---

### A11. gRPC/GraphQL/tRPC 服务调用检测

**复刻规格**：
```typescript
// codebaseGraphQueries.ts (扩展)
// gRPC: 检测 .proto 文件中的 service/rpc 声明 + 客户端 stub 调用
// GraphQL: 检测 query/mutation 字符串 + gql`` 模板标签
// tRPC: 检测 trpc.router() + procedure 调用

// 新增边类型: GRPC_CALLS, GRAPHQL_CALLS, TRPC_CALLS
```

---

### A12. compile_commands.json 解析 (pass_compile_commands.c — 12KB)

**复刻规格**：
```typescript
// codebaseGraphCompileCommands.ts (新建)
export function parseCompileCommands(rootPath: string): Map<string, string[]> {
  // 解析 compile_commands.json → filePath → includePaths[]
  // 用于 C/C++ 精确头文件解析
}
```

---

### A13. 死代码检测增强 (原版含于 architecture.c)

**复刻规格**：
```typescript
// codebaseGraphChanges.ts (扩展)
export function detectDeadCode(store: CodebaseGraphStore, project: string): DeadCodeReport {
  // 1. 入口点：main(), export, Route handler, @EventListener
  // 2. BFS 从入口点可达性分析
  // 3. 不可达 = 死代码
  // 4. 按文件聚合，输出报告
}
```

---

## 三、简化的功能（B 类 — 需升级到 1:1）

### B1. SQLite 持久化（当前：JSON）

**原版**：SQLite + FTS5 全文索引 + WAL + zstd 压缩 + 60+ API

**复刻方案**：使用 `sql.js` (SQLite WASM)

```typescript
// codebaseGraphStore.ts (重写)
import initSqlJs, { Database } from 'sql.js';

export class CodebaseGraphStore {
  private _db: Database | undefined;

  async init(): Promise<void> {
    const SQL = await initSqlJs({ locateFile: f => `/resources/sql-wasm/${f}` });
    this._db = new SQL.Database();
    this._createSchema();
  }

  private _createSchema(): void {
    this._db!.run(`
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        label TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT,
        file_path TEXT,
        start_line INTEGER,
        end_line INTEGER,
        properties_json TEXT,
        in_degree INTEGER DEFAULT 0,
        out_degree INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
      CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_qn ON nodes(qualified_name);

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        properties_json TEXT,
        FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);

      CREATE TABLE IF NOT EXISTS file_hashes (
        project TEXT NOT NULL,
        file_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mtime INTEGER,
        size INTEGER,
        PRIMARY KEY (project, file_path)
      );

      CREATE TABLE IF NOT EXISTS communities (
        project TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        community_id INTEGER NOT NULL,
        PRIMARY KEY (project, node_id)
      );

      -- FTS5 全文索引
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        name, qualified_name, file_path, label,
        content='nodes', content_rowid='id'
      );
    `);
  }

  // FTS5 全文搜索
  searchBM25(query: string, limit: number): SearchResult[] {
    const stmt = this._db!.prepare(`
      SELECT n.*, bm25(nodes_fts) as score
      FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY score LIMIT ?
    `);
    stmt.bind([query, limit]);
    // ...
  }

  // WAL checkpoint
  checkpoint(): void { this._db!.run('PRAGMA wal_checkpoint(TRUNCATE)'); }

  // 完整性检查
  checkIntegrity(): boolean {
    const result = this._db!.exec('PRAGMA integrity_check');
    return result[0].values[0][0] === 'ok';
  }

  // 导出二进制
  dump(): Uint8Array { return this._db!.export(); }
  restore(data: Uint8Array): void { this._db = new (this._db!.constructor as any)(data); }
}
```

**依赖**：`npm install sql.js` (SQLite WASM, ~1.2MB)

---

### B2. Cypher 引擎升级

**缺失语法**：UNION / UNWIND / CASE / 子查询 / 多跳 / 复杂表达式

**复刻规格**：
```typescript
// codebaseGraphCypher.ts (扩展)
// 新增支持：
// - MATCH (n)-[r*1..3]->(m)  多跳变长路径
// - WHERE n.name CONTAINS 'foo' OR n.name STARTS WITH 'bar'
// - WITH n, count(r) as relCount WHERE relCount > 5
// - RETURN n, collect(r.type) as relTypes
// - ORDER BY relCount DESC SKIP 10 LIMIT 20
// - UNION / UNION ALL
// - CASE WHEN ... THEN ... ELSE ... END
```

---

### B3. 语义搜索升级（11 信号）

**原版 11 信号**：
1. TF-IDF ✓ (已实现)
2. Random Indexing ✓ (已实现)
3. API Signature ✓ (已实现)
4. AST Profile ✓ (已实现)
5. Halstead Complexity ✓ (已实现)
6. Graph Diffusion ✓ (已实现)
7. MinHash + LSH ✗ (近似克隆)
8. Type Signature ✗ (类型签名)
9. Decorator Signature ✗ (装饰器签名)
10. Data Flow ✗ (数据流)
11. Behavioral ✗ (行为模式)

**复刻规格**：
```typescript
// codebaseGraphSemantic.ts (扩展)
// 新增 5 个信号：

// 7. MinHash + LSH（近似克隆检测）
class MinHashSignal {
  private _hashFunctions: ((s: string) => number)[];
  compute(tokens: string[]): number[];  // MinHash 签名
  similarity(a: number[], b: number[]): number;  // Jaccard 估计
}

// 8. Type Signature（类型签名）
class TypeSignatureSignal {
  compute(node: GraphNode): string;  // "fn(string, number): Promise<boolean>"
}

// 9. Decorator Signature
class DecoratorSignal {
  compute(node: GraphNode): string[];  // ["@Injectable", "@Controller"]
}

// 10. Data Flow（数据流）
class DataFlowSignal {
  // 追踪变量/参数从定义到使用的路径
  compute(node: GraphNode): string[];  // 数据流签名
}

// 11. Behavioral（行为模式）
class BehavioralSignal {
  // 检测 IO/计算/副作用模式
  compute(node: GraphNode): string;  // "io-heavy" | "compute-heavy" | "side-effect"
}
```

---

### B4. 社区检测升级（多级 Leiden）

**原版**：Traag 2019 多级 Leiden + refinement 阶段

**复刻规格**：
```typescript
// codebaseGraphLayout.ts (扩展)
export class LeidenCommunityDetection {
  /** 多级 Leiden 算法 */
  detect(graph: { nodes: number[]; edges: [number, number][] }, resolution: number = 1.0): Map<number, number> {
    // Phase 1: 本地移动（节点 → 使模块度增益最大的社区）
    // Phase 2: refinement（每个社区细分，确保连通性）
    // Phase 3: 聚合（社区 → 超节点）
    // 重复直到稳定
  }

  private _localMove(...): void;
  private _refine(...): void;
  private _aggregate(...): void;
  private _modularityDelta(...): number;
}
```

---

### B5. 3D 布局升级（两级 LOD + 位置缓存）

**复刻规格**：
```typescript
// codebaseGraphLayout.ts (扩展)
export class Layout3D {
  private _positionCache: Map<number, Vec3> = new Map();

  /** 两级 LOD：Overview（全局）+ Detail（局部） */
  computeLayout(nodes: GraphNode[], edges: GraphEdge[], lod: 'overview' | 'detail'): Map<number, Vec3> {
    // Overview: Barnes-Hut + 社区约束（社区内紧凑，社区间分离）
    // Detail: 社区内力导向 + 精细布局
    // 位置缓存：增量索引时复用未变更节点的坐标
  }
}
```

---

## 四、API 签名差异（C 类）

| API | 原版签名 | 本项目签名 | 差异 |
|-----|---------|----------|------|
| `index_repository` | `(project, repo_path, mode, sub_path, exclude_dirs, timeout_s)` | `indexWorkspace(rootPath, config)` | 缺 timeout 参数 |
| `search_graph` | `(project, name_pattern, label, limit, offset, sort_by, min_degree, rel_type)` | `searchNodes(pattern, nodeType)` | 缺 limit/offset/sort/degree/rel 过滤 |
| `query_graph` | `(project, query)` 返回 columns+rows | `executeCypher(query)` | 缺 project 参数 |
| `trace_path` | `(project, source, target, mode, max_depth, exclude_entry)` | `tracePath(sourceName, targetName, mode)` | 缺 max_depth/exclude_entry |
| `get_architecture` | `(project, dimensions[])` | `getArchitecture()` | 缺 dimensions 选择 |
| `detect_changes` | `(project, since, base_branch, impact_analysis)` | 无（用 watcher 代替） | 缺 git diff 精确分析 |
| `manage_adr` | `(project, action, id, title, content, status)` | 空壳 | 全缺 |
| `ingest_traces` | `(project, traces_otlp_json, merge_strategy)` | 空壳 | 全缺 |
| `list_projects` | `()` 返回 `[{name, path, node_count, ...}]` | 空壳 | 全缺 |
| `delete_project` | `(name)` | 空壳 | 全缺 |
| `get_code_snippet` | `(project, qualified_name, context_lines)` | 空壳 | 全缺 |
| `get_graph_schema` | `(project)` 返回 labels+edge_types | `getGraphSchema()` | 基本对齐 |

---

## 五、数据结构差异（D 类）

### D1. 节点 properties_json（原版有，本项目缺）

**原版**：每个节点有 `properties_json TEXT` 字段，存储任意扩展属性（复杂度、装饰器、API 签名等）

**复刻**：在 `CodebaseGraphStore` 中为 `nodes` 表添加 `properties_json` 列。

### D2. 边 properties_json

同上，边也需要 `properties_json`。

### D3. 文件哈希表（mtime + size + sha256）

**原版**：`file_hashes(project, file_path, sha256, mtime, size)`

**本项目**：仅有 SHA-256，缺 mtime/size（用于快速增量检测，避免每次算 SHA-256）

### D4. 社区存储

**原版**：`communities(project, node_id, community_id)`

**本项目**：无持久化，每次重新计算

---

## 六、1:1 复刻优先级清单

### P0 — 基础设施（必须，影响所有功能）

| # | 任务 | 新建/修改 | 工作量 |
|---|------|----------|--------|
| 1 | SQLite WASM 存储层（sql.js） | 重写 `codebaseGraphStore.ts` | 2 天 |
| 2 | Graph Buffer 中间层 | 新建 `codebaseGraphBuffer.ts` | 1 天 |
| 3 | 压缩制品持久化（zstd） | 重写 `codebaseGraphPersistence.ts` | 0.5 天 |
| 4 | 磁盘增量索引 | 新建 `codebaseGraphIncremental.ts` | 1 天 |
| 5 | 索引锁 | 修改 `codebaseGraphService.ts` | 0.5 天 |
| 6 | FTS5 全文搜索 | 集成到 store | 0.5 天 |

### P1 — 解析能力（高价值）

| # | 任务 | 新建/修改 | 工作量 |
|---|------|----------|--------|
| 7 | 路径别名解析 | 新建 `codebaseGraphPathAlias.ts` | 1 天 |
| 8 | 跨文件 LSP 类型推断 | 扩展 `codebaseGraphLsp.ts` | 2 天 |
| 9 | 并行管线 | 新建 `codebaseGraphParallelPipeline.ts` | 2 天 |
| 10 | pass_usages（引用边） | 扩展 pipeline | 1 天 |
| 11 | pass_semantic_edges | 扩展 pipeline | 1 天 |
| 12 | pass_similarity（MinHash 克隆） | 扩展 `codebaseGraphPasses.ts` | 1 天 |
| 13 | pass_tests | 扩展 pipeline | 0.5 天 |
| 14 | gRPC/GraphQL/tRPC 检测 | 扩展 queries | 1 天 |
| 15 | compile_commands 解析 | 新建 | 0.5 天 |

### P2 — 分析能力（中价值）

| # | 任务 | 新建/修改 | 工作量 |
|---|------|----------|--------|
| 16 | 环境变量 URL 扫描 | 新建 `codebaseGraphEnvScan.ts` | 1 天 |
| 17 | 配置-代码链接 | 新建 `codebaseGraphConfigLink.ts` | 1 天 |
| 18 | 跨仓库自动发现 | 重写 `codebaseGraphCrossRepo.ts` | 2 天 |
| 19 | Cypher UNION/CASE/子查询 | 扩展 `codebaseGraphCypher.ts` | 2 天 |
| 20 | 语义搜索 5 新信号 | 扩展 `codebaseGraphSemantic.ts` | 2 天 |
| 21 | 多级 Leiden 社区检测 | 扩展 `codebaseGraphLayout.ts` | 1.5 天 |
| 22 | 两级 LOD 3D 布局 | 扩展 `codebaseGraphLayout.ts` | 1 天 |
| 23 | 死代码检测增强 | 扩展 `codebaseGraphChanges.ts` | 0.5 天 |
| 24 | ADR 完整实现 | 重写 `codebaseGraphAdr.ts` | 1.5 天 |
| 25 | OTLP Trace 摄入 | 重写 `codebaseGraphTraces.ts` | 1.5 天 |
| 26 | git history 变更耦合 | 扩展 `codebaseGraphGitHistory.ts` | 1 天 |

### P3 — API 对齐（收尾）

| # | 任务 | 修改 | 工作量 |
|---|------|------|--------|
| 27 | search_graph 参数对齐 | service | 0.5 天 |
| 28 | trace_path 参数对齐 | service | 0.5 天 |
| 29 | get_architecture dimensions | service | 0.5 天 |
| 30 | get_code_snippet 实现 | service | 0.5 天 |
| 31 | list_projects/delete_project | service | 0.5 天 |
| 32 | detect_changes git diff | service | 1 天 |

**总工作量**：约 35 人天

---

## 七、依赖引入

```json
// package.json
{
  "dependencies": {
    "sql.js": "^1.10.0",      // SQLite WASM (~1.2MB)
    "fzstd": "^0.2.0",        // zstd 压缩 WASM (~50KB)
    "@vscode/tree-sitter-wasm": "已有"
  }
}
```

**WASM 资源放置**：
- `resources/sql-wasm/sql-wasm.wasm` (1.2MB)
- `resources/tree-sitter-wasm/*.wasm` (已有)

---

## 八、执行顺序

```
Week 1: P0 基础设施（#1-6）
  ↓ 所有后续依赖 SQLite 存储
Week 2: P1 解析能力（#7-15）
  ↓ 依赖存储 + 管线
Week 3: P2 分析能力（#16-26）
  ↓ 依赖完整图数据
Week 4: P3 API 对齐（#27-32）+ 集成测试
```

---

## 九、验收标准

1:1 复刻完成的验收标准：

- [ ] `index_repository` 索引 10K 文件仓库 < 30s（增量 < 5s）
- [ ] `search_graph` 支持 name_pattern + label + limit + offset + sort + degree + rel_type
- [ ] `query_graph` 执行 Cypher `MATCH (n)-[r*1..3]->(m) RETURN ...` < 100ms
- [ ] `trace_path` 支持 calls/data_flow/cross_service 三种模式
- [ ] `get_architecture` 输出 10 维度报告
- [ ] `detect_changes` 基于 git diff 精确影响分析
- [ ] `manage_adr` 完整 CRUD + 分节解析 + 校验
- [ ] `ingest_traces` 接收 OTLP JSON + 图增强
- [ ] `list_projects` / `delete_project` 多项目管理
- [ ] `get_code_snippet` 带行号高亮的代码片段
- [ ] `get_graph_schema` 完整节点标签 + 边类型
- [ ] 语义搜索 11 信号融合
- [ ] 社区检测多级 Leiden
- [ ] 3D 布局两级 LOD + 位置缓存
- [ ] 持久化 graph.db.zst 压缩制品
- [ ] 跨仓库自动发现 6 种 CROSS_* 边
