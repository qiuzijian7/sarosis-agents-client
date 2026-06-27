# Codebase Memory 完整功能对标设计方案

> 目标：在 VS Code (Sarosis) 内嵌实现 codebase-memory-mcp 的全部核心功能，消除对外部 C 二进制的依赖。

## 一、现状差距总览

| 能力 | 本项目现状 | 原版对标 | 差距 |
|------|-----------|---------|------|
| 语言支持 | 14 种 (WASM) | 158 种 (编译) | -144 |
| 解析深度 | 单次 AST 遍历 | 22 pass pipeline | 缺 21 pass |
| 图存储 | JSON 文件 | SQLite + FTS5 + zstd | 无索引/无压缩 |
| 查询 | 正则搜索 | Cypher + FTS5 + 语义搜索 | 缺全部高级查询 |
| 增量索引 | 无（全量重建） | SHA-256 + upsert | 缺 |
| 3D 布局 | JS O(n²) 力导向 | Barnes-Hut O(n log n) + LOD | 性能差 10x |
| 架构分析 | 无 | 7 维度分析 | 缺 |
| 变更检测 | 无 | git diff 影响分析 | 缺 |
| 文件监听 | 无 | 自适应轮询 | 缺 |
| 节点类型 | 7 种 | 20+ 种 | 缺 13+ |
| 边类型 | 4 种 | 20+ 种 | 缺 16+ |

## 二、技术选型

| 领域 | 选型 | 理由 |
|------|------|------|
| **图存储** | `sql.js` (SQLite WASM) | 纯 JS，VS Code renderer 可用，支持 FTS5 |
| **持久化压缩** | `fzstd` (zstd WASM) | 纯 JS zstd 实现，浏览器兼容 |
| **Cypher 引擎** | 自研 TS 子集 | 原版 152KB C，TS 移植可行 |
| **语义搜索** | TF-IDF + Random Indexing | 轻量级，无需 ML 模型；后期可接入 transformers.js |
| **3D 布局** | Barnes-Hut octree (TS) | O(n log n)，支持 5 万节点 |
| **Bloom 效果** | Three.js UnrealBloomPass | postprocessing 库 |
| **文件哈希** | Web Crypto API (SHA-256) | 浏览器原生，无需依赖 |
| **正则引擎** | JS RegExp | 原版用 TRE，JS RegExp 足够 |

## 三、分阶段实施计划

### Phase 1：图存储升级（SQLite + 增量索引）

**目标**：用 SQLite WASM 替换 JSON 文件，实现增量索引和文件监听。

#### 1.1 SQLite 图存储层

```
新建: codebaseGraphStore.ts
```

**数据结构**：

```typescript
// 节点表
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  label TEXT NOT NULL,          -- Function, Class, Method, Module, File, Interface, Route...
  name TEXT NOT NULL,
  qualified_name TEXT,
  file_path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  properties_json TEXT,          -- 任意 JSON 扩展属性
  UNIQUE(project, qualified_name)
);

// 边表
CREATE TABLE edges (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  type TEXT NOT NULL,            -- CALLS, IMPORTS, DEFINES, IMPLEMENTS...
  properties_json TEXT,
  UNIQUE(source_id, target_id, type),
  FOREIGN KEY (source_id) REFERENCES nodes(id),
  FOREIGN KEY (target_id) REFERENCES nodes(id)
);

// 文件哈希表（增量索引）
CREATE TABLE file_hashes (
  project TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mtime_ns INTEGER,
  size INTEGER,
  PRIMARY KEY (project, rel_path)
);

// FTS5 全文索引
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  name, qualified_name, file_path,
  content='nodes',
  tokenize='cbm_camel_split'   -- camelCase/snake_case 感知分词
);

// 布局缓存
CREATE TABLE layout_cache (
  project TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  x REAL, y REAL, z REAL,
  PRIMARY KEY (project, node_id)
);
```

**API 设计**：

```typescript
interface IGraphStore {
  // 生命周期
  open(dbPath: string): Promise<void>;
  openMemory(): Promise<void>;
  close(): void;

  // 事务
  begin(): void;
  commit(): void;
  rollback(): void;
  beginBulk(): void;  // PRAGMA 调优
  endBulk(): void;

  // Node CRUD
  upsertNode(node: GraphNode): number;  // 返回 id
  upsertNodeBatch(nodes: GraphNode[]): void;
  findNodeById(id: number): GraphNode | undefined;
  findNodeByQN(project: string, qn: string): GraphNode | undefined;
  findNodesByFile(project: string, filePath: string): GraphNode[];
  findNodesByLabel(project: string, label: string): GraphNode[];

  // Edge CRUD
  insertEdge(edge: GraphEdge): void;
  insertEdgeBatch(edges: GraphEdge[]): void;
  findEdgesBySource(nodeId: number): GraphEdge[];
  findEdgesByTarget(nodeId: number): GraphEdge[];
  findEdgesByType(project: string, type: string): GraphEdge[];

  // 文件哈希
  upsertFileHash(hash: FileHash): void;
  getFileHash(project: string, relPath: string): FileHash | undefined;
  deleteFileHash(project: string, relPath: string): void;

  // 搜索
  search(params: SearchParams): SearchResult;
  ftsSearch(query: string, limit: number): GraphNode[];

  // 统计
  getNodeCount(project: string): number;
  getEdgeCount(project: string): number;
  getNodeTypes(project: string): Map<string, number>;
  getEdgeTypes(project: string): Map<string, number>;

  // 布局缓存
  saveLayout(project: string, nodeId: number, x: number, y: number, z: number): void;
  loadLayout(project: string): Map<number, {x: number, y: number, z: number}>;
}
```

#### 1.2 增量索引

```
修改: codebaseGraphService.ts → indexWorkspace()
```

**流程**：
1. 扫描文件列表
2. 对每个文件计算 SHA-256 + mtime
3. 查询 `file_hashes` 表，比对哈希
4. 仅解析变更文件（新增/修改）
5. 对变更文件的节点：upsert（保留 id）
6. 对变更文件的边：先删旧边，再插新边
7. 更新 `file_hashes` 表
8. 删除已删除文件的节点和边

```typescript
async indexWorkspace(rootPath: string, config: IIndexConfig): Promise<IIndexResult> {
  const files = await this.scanFiles(rootPath, config);
  const project = this.getProjectName(rootPath);

  let changed = 0, skipped = 0;
  for (const filePath of files) {
    const hash = await this.computeFileHash(filePath);
    const oldHash = this._store.getFileHash(project, relPath);

    if (oldHash && oldHash.sha256 === hash.sha256) {
      skipped++;
      continue;
    }

    // Parse changed file
    const { nodes, edges } = await this.parseFile(filePath);
    // Delete old nodes/edges for this file
    this._store.deleteNodesByFile(project, relPath);
    // Insert new
    for (const node of nodes) this._store.upsertNode(node);
    for (const edge of edges) this._store.insertEdge(edge);
    // Update hash
    this._store.upsertFileHash(hash);
    changed++;
  }
}
```

#### 1.3 文件监听

```
新建: codebaseGraphWatcher.ts
```

**自适应轮询策略**（对标原版）：
- 基础间隔 5s
- 每增加 500 文件 +1s
- 上限 60s
- git HEAD 变化时触发全量检查

```typescript
class CodebaseGraphWatcher {
  private _pollInterval = 5000;  // ms, adaptive
  private _lastGitHead: string | undefined;

  start(rootPath: string): void {
    this._schedulePoll(rootPath);
  }

  private async _poll(rootPath: string): Promise<void> {
    // 1. Check git HEAD
    const head = await this._getGitHead(rootPath);
    if (head !== this._lastGitHead) {
      this._lastGitHead = head;
      this._onDidChange.fire({ type: 'git-head', head });
      return;
    }

    // 2. Check file hashes (sampling)
    const changes = await this._detectChanges(rootPath);
    if (changes.length > 0) {
      this._onDidChange.fire({ type: 'files', files: changes });
    }

    // 3. Adaptive interval
    const fileCount = await this._estimateFileCount(rootPath);
    this._pollInterval = Math.min(60000, 5000 + Math.floor(fileCount / 500) * 1000);

    this._schedulePoll(rootPath);
  }
}
```

**修改 `codebaseGraphBootstrap.ts`**：监听 watcher 事件 → 触发增量索引。

---

### Phase 2：多 Pass 解析管线

**目标**：从单次 AST 遍历升级为多阶段解析管线，覆盖 20+ 节点类型和 20+ 边类型。

#### 2.1 Pass 架构

```
新建: codebaseGraphPipeline.ts
```

```
文件 → [Pass 1: definitions]     → 函数/类/接口/枚举/结构体节点
     → [Pass 2: calls]          → CALLS 边
     → [Pass 3: imports]        → IMPORTS 边
     → [Pass 4: class_hier]     → INHERITS/IMPLEMENTS 边
     → [Pass 5: routes]         → Route 节点 + HTTP_CALLS 边
     → [Pass 6: events]         → EMITS/LISTENS_ON 边
     → [Pass 7: data_flow]     → DATA_FLOWS 边
     → [Pass 8: decorators]     → DECORATES 边
     → [Pass 9: complexity]     → Halstead/cyclomatic 指标 → properties_json
     → [Pass 10: file_structure]→ File/Folder 节点 + CONTAINS 边
     → [Post: match_calls]     → 跨文件调用匹配
     → [Post: type_inference]  → 类型解析（可选，需 LSP）
```

#### 2.2 扩展的 tree-sitter 查询

```
新建: codebaseGraphQueries.ts
```

每个 Pass 使用 tree-sitter Query API 提取特定信息：

```typescript
// Pass 1: Definitions
const FUNCTION_QUERY = {
  typescript: `(function_declaration name: (identifier) @name) @func`,
  python: `(function_definition name: (identifier) @name) @func`,
  go: `(function_declaration name: (identifier) @name) @func`,
  // ... 14 种语言
};

// Pass 5: Routes (框架特定)
const ROUTE_QUERIES = {
  typescript: [
    // Express: app.get('/path', handler)
    `(call_expression
      function: (member_expression
        object: (identifier) @obj
        property: (property_identifier) @method)
      arguments: (arguments (string) @path))
     (#match? @method "^(get|post|put|delete|patch|use)$")`,
    // Fastify: fastify.get('/path', handler)
    // NestJS: @Get('/path')
  ],
};

// Pass 6: Events
const EVENT_QUERIES = {
  typescript: [
    // EventEmitter.emit('event')
    `(call_expression
      function: (member_expression
        property: (property_identifier) @method)
      arguments: (arguments (string) @event))
     (#match? @method "^emit$")`,
  ],
};
```

#### 2.3 扩展节点/边类型

```typescript
// 节点类型 (7 → 20+)
type NodeType =
  | 'function' | 'class' | 'method' | 'module' | 'file'
  | 'interface' | 'enum' | 'variable' | 'constant' | 'struct'
  | 'trait' | 'route' | 'package' | 'service'
  | 'configmap' | 'secret' | 'deployment' | 'namespace';

// 边类型 (4 → 20+)
type EdgeType =
  | 'CALLS' | 'IMPORTS' | 'DEFINES' | 'CONTAINS_FILE' | 'CONTAINS_FOLDER'
  | 'IMPLEMENTS' | 'INHERITS' | 'HTTP_CALLS' | 'EMITS' | 'LISTENS_ON'
  | 'DATA_FLOWS' | 'SIMILAR_TO' | 'HANDLES' | 'USAGE' | 'RAISES'
  | 'WRITES' | 'THROWS' | 'DECORATES' | 'CONTAINS_PACKAGE';
```

---

### Phase 3：查询引擎

**目标**：实现 Cypher 子集 + FTS5 全文搜索 + 语义搜索。

#### 3.1 Cypher 查询引擎

```
新建: codebaseGraphCypher.ts
```

**支持的 Cypher 子集**：

```cypher
-- 基本 MATCH
MATCH (n) RETURN n LIMIT 10
MATCH (n:Function) RETURN n.name, n.file_path

-- 关系遍历
MATCH (a)-[r:CALLS]->(b) RETURN a.name, b.name
MATCH (a)-[r]->(b) WHERE type(r) = 'CALLS' RETURN a, b

-- WHERE 过滤
MATCH (n) WHERE n.label = 'Function' AND n.name =~ '.*Handler.*' RETURN n

-- 多跳
MATCH (a)-[:CALLS]->(b)-[:CALLS]->(c) RETURN a.name, c.name

-- ORDER BY / LIMIT
MATCH (n:Function) RETURN n.name, n.complexity ORDER BY n.complexity DESC LIMIT 10

-- 聚合
MATCH (n) RETURN n.label, count(n) AS cnt ORDER BY cnt DESC
```

**实现架构**：

```typescript
class CypherEngine {
  // 1. Lexer: 字符串 → Token 流
  lex(source: string): Token[];

  // 2. Parser: Token → AST
  parse(tokens: Token[]): CypherAST;

  // 3. Executor: AST → SQLite 查询 → 结果
  async execute(ast: CypherAST, store: IGraphStore): Promise<any[]>;
}
```

**Executor 策略**：将 Cypher MATCH/WHERE 翻译为 SQL JOIN 查询，利用 SQLite 索引。

#### 3.2 FTS5 全文搜索

```typescript
// 注册自定义分词器 (camelCase/snake_case 感知)
function camelSplit(input: string): string[] {
  // "getUserInfo" → ["get", "user", "info"]
  // "get_user_info" → ["get", "user", "info"]
  // "GetUserInfo" → ["get", "user", "info"]
}

// 搜索 API
function ftsSearch(query: string, options: {
  label?: string;
  filePattern?: string;
  limit?: number;
}): GraphNode[] {
  // SELECT * FROM nodes_fts WHERE nodes_fts MATCH ?
  // AND label = ? AND file_path GLOB ?
  // LIMIT ?
}
```

#### 3.3 语义搜索

```
新建: codebaseGraphSemantic.ts
```

**11 信号融合**（简化版，先实现前 6 个核心信号）：

```typescript
interface SemanticSignal {
  name: string;
  weight: number;
  compute(node: GraphNode, query: string): number; // 0-1 相似度
}

// 核心 6 信号（Phase 3 实现）
const signals: SemanticSignal[] = [
  { name: 'tfidf',      weight: 0.25, compute: tfidfSimilarity },
  { name: 'random_idx', weight: 0.20, compute: randomIndexingSimilarity },
  { name: 'api_sig',   weight: 0.15, compute: apiSignatureSimilarity },
  { name: 'ast_profile',weight: 0.15, compute: astProfileSimilarity },
  { name: 'halstead',  weight: 0.10, compute: halsteadSimilarity },
  { name: 'graph_diff',weight: 0.15, compute: graphDiffusionSimilarity },
];

// 后续 5 信号（Phase 4+）
// minhash, type_sig, decorator_sig, data_flow, behavioral

function semanticSearch(query: string, limit: number): GraphNode[] {
  const candidates = store.ftsSearch(query, { limit: limit * 3 });
  return candidates
    .map(node => ({
      node,
      score: signals.reduce((sum, s) => sum + s.weight * s.compute(node, query), 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

---

### Phase 4：3D 可视化升级

**目标**：Barnes-Hut octree 布局 + LOD + Bloom + 跨仓库星系。

#### 4.1 Barnes-Hut octree 布局

```
新建: codebaseGraphLayout.ts
```

```typescript
class BarnesHutLayout3D {
  private _root: OctreeNode | null = null;
  private readonly _theta = 0.9;  // 开启阈值
  private readonly _epsilon = 0.1; // 软化因子

  compute(nodes: GraphNode[], edges: GraphEdge[], iterations: number): void {
    // 1. 构建 octree
    this._root = this.buildOctree(nodes);
    // 2. 每次迭代
    for (let i = 0; i < iterations; i++) {
      // 2a. 计算排斥力 (O(n log n), 远距离用质心近似)
      for (const node of nodes) {
        const force = this.calculateRepulsion(node, this._root);
        node.fx += force.x;
        // ...
      }
      // 2b. 计算吸引力 (边)
      for (const edge of edges) {
        const force = this.calculateAttraction(edge);
        // ...
      }
      // 2c. 更新位置
      for (const node of nodes) {
        node.x += node.fx * dt;
        // ...
      }
    }
  }
}
```

#### 4.2 两级 LOD

```typescript
// Overview 模式: 显示聚类质心（~1K-10K 节点）
function computeOverview(nodes: GraphNode[], communities: Map<number, number>): GraphNode[] {
  // Leiden 社区检测 → 聚类
  // 每个聚类 → 质心节点 (位置 = 成员平均, 大小 = 成员数)
}

// Detail 模式: 点击聚类 → 展开区域内个体
function expandCluster(clusterId: number): GraphNode[] {
  // 返回该聚类内的所有节点
}
```

#### 4.3 Bloom 后处理

```javascript
// 替换当前 toneMapped:false 模拟
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(width, height),
  0.8,  // strength
  0.4,  // radius
  0.85  // threshold
);
composer.addPass(bloomPass);
// 渲染时: composer.render() 替代 renderer.render()
```

#### 4.4 布局缓存

布局计算后存入 SQLite `layout_cache` 表，下次加载直接读缓存：

```typescript
// 索引完成后计算布局并缓存
async function computeAndCacheLayout(project: string): Promise<void> {
  const layout = new BarnesHutLayout3D();
  layout.compute(nodes, edges, 100);
  // 缓存
  for (const node of nodes) {
    store.saveLayout(project, node.id, node.x!, node.y!, node.z!);
  }
}
```

---

### Phase 5：架构分析 + 变更检测

#### 5.1 架构分析

```
新建: codebaseGraphArchitecture.ts
```

```typescript
interface ArchitectureReport {
  languages: Map<string, { files: number; nodes: number; loc: number }>;
  packages: PackageSummary[];
  entryPoints: GraphNode[];
  routes: RouteSummary[];
  hotspots: GraphNode[];          // 高入度节点
  crossPackageBoundaries: Edge[];
  serviceLinks: ServiceLink[];
  layers: LayerAssignment[];      // 自动分层 (Controller → Service → Repository)
  communities: Community[];       // Leiden 社区检测
}

function getArchitecture(project: string): ArchitectureReport {
  return {
    languages: analyzeLanguages(),
    packages: analyzePackages(),
    entryPoints: findEntryPoints(),       // 零入度 + 非 private + 非 test
    routes: extractRoutes(),
    hotspots: findHotspots(),             // inDegree > P95
    crossPackageBoundaries: findCrossPackageEdges(),
    serviceLinks: findServiceCalls(),    // HTTP_CALLS 边
    layers: assignLayers(),               // 基于文件路径 + 调用模式
    communities: leidenCommunityDetection(),
  };
}
```

#### 5.2 Leiden 社区检测

```typescript
// 简化版 Leiden 算法 (本地移动 + 细化)
function leidenCommunities(
  nodes: GraphNode[],
  edges: GraphEdge[],
  resolution: number = 1.0
): Map<number, number> {  // nodeId → communityId
  // 1. 每个节点初始为自己的社区
  // 2. 本地移动：将节点移到使模块度增益最大的相邻社区
  // 3. 细化：构建聚合图
  // 4. 重复 2-3 直到收敛
}
```

#### 5.3 变更检测

```
新建: codebaseGraphChanges.ts
```

```typescript
interface ChangeImpact {
  commit: string;
  affectedFiles: string[];
  affectedNodes: GraphNode[];
  affectedEdges: GraphEdge[];
  riskLevel: 'Critical' | 'High' | 'Medium' | 'Low';
  riskReasons: string[];
  downstreamImpact: GraphNode[];  // 被影响节点的下游调用链
}

async function detectChanges(
  project: string,
  rootPath: string,
  baseCommit?: string
): Promise<ChangeImpact> {
  // 1. git diff 获取变更文件列表
  const changedFiles = await gitDiff(rootPath, baseCommit);
  // 2. 映射到图节点
  const affectedNodes = store.findNodesByFiles(project, changedFiles);
  // 3. BFS 遍历下游影响
  const downstream = bfsDownstream(affectedNodes, maxDepth: 3);
  // 4. 风险分级
  return {
    riskLevel: assessRisk(affectedNodes, downstream),
    riskReasons: explainRisk(affectedNodes, downstream),
    // ...
  };
}
```

---

### Phase 6：高级功能

#### 6.1 跨仓库分析

```typescript
// 多项目注册
interface ProjectRegistry {
  projects: Map<string, ProjectInfo>;
  crossEdges: CrossEdge[];  // 跨仓库调用边
}

// 3D 星系可视化
function renderGalaxy(): void {
  // 每个项目 = 一个星系（带偏移坐标）
  // crossEdges = 星系间的连线
}
```

#### 6.2 基础设施即代码

```typescript
// Pass: infrascan — 解析 Dockerfile, K8s manifests
const INFRA_QUERIES = {
  yaml: [
    // apiVersion: apps/v1 → kind: Deployment → Deployment 节点
    // containers[].image → ConfigMap/Secret 引用边
  ],
  dockerfile: [
    // FROM → 基础镜像引用
    // ENV → 配置项
  ],
};
```

#### 6.3 死代码检测

```typescript
function findDeadCode(project: string): GraphNode[] {
  // 零入度函数 + 非入口点 + 非 export
  const allFunctions = store.findNodesByLabel(project, 'Function');
  const entryPoints = findEntryPoints(project);
  return allFunctions.filter(fn =>
    fn.inDegree === 0 &&
    !entryPoints.includes(fn.id) &&
    !isExported(fn)
  );
}
```

---

## 四、文件清单

### 新建文件

| 文件 | Phase | 功能 |
|------|-------|------|
| `codebaseGraphStore.ts` | 1 | SQLite WASM 图存储层 |
| `codebaseGraphWatcher.ts` | 1 | 自适应文件监听 |
| `codebaseGraphPipeline.ts` | 2 | 多 pass 解析管线 |
| `codebaseGraphQueries.ts` | 2 | tree-sitter 查询定义（20+ 语言） |
| `codebaseGraphCypher.ts` | 3 | Cypher 子集查询引擎 |
| `codebaseGraphSemantic.ts` | 3 | 语义搜索（11 信号融合） |
| `codebaseGraphLayout.ts` | 4 | Barnes-Hut octree 3D 布局 |
| `codebaseGraphArchitecture.ts` | 5 | 架构分析（7 维度） |
| `codebaseGraphChanges.ts` | 5 | 变更检测 + 影响分析 |
| `codebaseGraphCommunity.ts` | 5 | Leiden 社区检测 |

### 修改文件

| 文件 | Phase | 改动 |
|------|-------|------|
| `codebaseGraphService.ts` | 1-2 | 用 SQLite 替换 JSON 存储；集成多 pass pipeline |
| `codebaseGraphBootstrap.ts` | 1 | 集成 watcher |
| `codebaseGraphViewerEditorPane.ts` | 4 | Barnes-Hut 布局 + LOD + Bloom |
| `codebaseMemoryDetailEditorPane.ts` | 5 | 架构分析/变更检测结果展示 |

### 依赖新增

| 包 | 用途 | 大小 |
|----|------|------|
| `sql.js` | SQLite WASM | ~2.5 MB (WASM) |
| `fzstd` | zstd 压缩/解压 | ~50 KB |
| `three/examples/jsm/postprocessing` | Bloom 效果 | 已含在 three 中 |

## 五、实施优先级

```
Phase 1 (存储 + 增量)  ──────────→  基础设施，其他 Phase 依赖
Phase 2 (多 Pass 解析)  ──────────→  数据质量，决定查询能力上限
Phase 3 (查询引擎)      ──────────→  用户价值最大，Cypher + FTS5 + 语义
Phase 4 (3D 升级)       ──────────→  视觉体验，Barnes-Hut + LOD + Bloom
Phase 5 (架构 + 变更)    ──────────→  高级分析，社区检测 + 影响分析
Phase 6 (高级功能)       ──────────→  跨仓库 + 基础设施 + 死代码
```

建议执行顺序：1 → 2 → 3 → 4 → 5 → 6，每个 Phase 可独立交付。

## 六、性能预期

| 指标 | 当前 | 目标 | 原版参考 |
|------|------|------|---------|
| 索引 1 万文件 | ~30s (全量) | <5s (增量) | 6s (Django) |
| 查询延迟 | O(n) 扫描 | <10ms (SQLite) | <1ms (Cypher) |
| 3D 节点上限 | ~2000 | ~50000 | 481 万 |
| 内存占用 | 全量加载 | 按需查询 | LZ4 压缩 |
| 持久化大小 | JSON (大) | SQLite + zstd (8-13:1) | graph.db.zst |
