/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Native Codebase Graph Service — 无需外部 EXE，直接使用 VS Code 内置 tree-sitter WASM 解析代码。
 *
 * 架构：
 * 1. 使用 ITreeSitterLibraryService 加载 tree-sitter WASM 语法文件
 * 2. 解析源文件 AST，提取节点（函数、类、接口等）和边（调用、导入等）
 * 3. 内存 GraphStore 存储图数据
 * 4. JSON 持久化到 {rootPath}/.codebase-memory/graph.db.zst
 * 5. 3D Graph Viewer 直接调用 API 获取数据（无 MCP stdio 开销）
 */

import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ITreeSitterLibraryService } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
// getModuleLocation / FileAccess / wrapWorkerUrl 已随 Worker 池迁到 codebaseGraphParserPool
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import type { Parser as TreeSitterParser, Language as TreeSitterLanguage } from '@vscode/tree-sitter-wasm';
import { CodebaseGraphStore, resolveSearchFileCandidates } from './codebaseGraphStore.js';
import { CypherEngine } from './codebaseGraphCypher.js';
import { SemanticSearch } from './codebaseGraphSemantic.js';
import { analyzeArchitecture } from './codebaseGraphArchitecture.js';
import { tracePath, getGraphSchema as getSchema, GraphSchema, searchCode as graphSearchCode, getIndexStatus } from './codebaseGraphTrace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { createCodebaseGraphSqliteBackend } from './codebaseGraphStoreProxy.js';
import { createCodebaseGraphIndexChannel } from './codebaseGraphIndexProxy.js';
import type { ICodebaseGraphIndexChannel } from '../common/codebaseGraphIndexChannel.js';
import type { ICodebaseGraphSqliteBackend } from '../common/codebaseGraphStoreChannel.js';
import { IUtilityProcessWorkerWorkbenchService } from '../../../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { LspCrossResolver } from './codebaseGraphLsp.js';
import { extractInherits } from './codebaseGraphQueries.js';
import { INDEX_LOCK_FILENAME, INDEX_LOCK_HEARTBEAT_MS, createIndexLockToken, isIndexLockStale, parseIndexLock, serializeIndexLock } from './codebaseIndexLock.js';
import { buildSemanticEdges, detectSimilarCode, detectSimilarCodeIncremental, MinHash, MINHASH_PERM } from './codebaseGraphExtendedPasses.js';
import { runMultiLevelLeiden, detectDeadCodeEnhanced, computeTwoLevelLOD, executeExtendedCypher, computeAllSignals } from './codebaseGraphAdvancedAnalysis.js';
import { CrossRepoDiscovery } from './codebaseGraphCrossRepoDiscovery.js';
import { GraphPersistence } from './codebaseGraphPersistence.js';
import { scanEnvUrls } from './codebaseGraphEnvScan.js';
import { linkConfigToCode } from './codebaseGraphConfigLink.js';
import { TraceIngester } from './codebaseGraphTraces.js';
import { ICodebaseGraphWatcher, CodebaseGraphWatcher, CodebaseGraphChangeEvent } from './codebaseGraphWatcher.js';
import { CodebaseGraphIncrementalIndexer } from './codebaseGraphIncremental.js';
import { shouldRecordHashAfterParse, EXTENSION_TO_WASM_LANG, AST_TO_NODE_TYPE, planForeignProjectPrune } from '../common/codebaseIndexDefaults.js';
import { resetMaxBlockMs, takeMaxBlockMs, wsStage, wsStageEnd } from './wsSwitchDiag.js';
import { SLICE_CHECK_EVERY, sliceBudgetExceeded, yieldToEventLoop } from '../common/asyncSlice.js';
import { CodebaseGraphExcludeResolver } from './codebaseGraphExcludeResolver.js';
import { resolveParseHeapAction } from './codebaseGraphMemoryWatchdog.js';
import { CodebaseGraphScanner } from './codebaseGraphScanner.js';
import { CodebaseGraphParserPool } from './codebaseGraphParserPool.js';
import { buildWorkerCode } from './codebaseGraphWorkerCode.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GraphNode {
	id: string;
	name: string;
	type: string;       // function, class, interface, module, file, variable, enum
	label?: string;    // 节点标签（与 type 对齐，用于 findNodesByLabel 查询）
	filePath?: string;
	qualifiedName?: string;
	inDegree: number;
	outDegree: number;
	startLine?: number;
	endLine?: number;
	project?: string;   // project name (default: '_default')
	properties?: Record<string, any>;
}

export interface GraphEdge {
	source: string;
	target: string;
	type: string;       // CALLS, IMPORTS, DEFINES, CONTAINS_FILE
	properties?: Record<string, any>;  // 调用边携带 loopDepth 等上下文（#9 过程间传播）
	/**
	 * **SQLite 行 id**（2026-09-16 新增；只有 `getAllEdges(…, afterId)` 这条读路径会带回来）。
	 *
	 * 用途：keyset 分页游标 —— `LIMIT/OFFSET` 在大表上是 O(offset) 累计（见 store 内注释），
	 * 改为「上一页最后一行的 id」作游标后是 O(n) 总量。
	 *
	 * ⚠ **不要**把它当内存 store 的边 id 用：store 的边 id 由 `insertEdge` 自增分配，
	 * 与 SQLite 行 id 是两套编号（跨项目加载时直接沿用会撞号）—— 只读作游标。
	 */
	id?: string;
}

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/** 预计算的可视化节点 — extension host 已计算好位置/颜色/大小，webview 直接渲染 */
export interface VisualizationNode {
	id: string;
	name: string;
	type: string;
	filePath?: string;
	qualifiedName?: string;
	x: number;
	y: number;
	z: number;
	size: number;
	color: string;
	inDegree: number;
	outDegree: number;
}

export interface VisualizationData {
	nodes: VisualizationNode[];
	edges: GraphEdge[];
	totalNodes: number;
}

export interface IIndexConfig {
	mode: 'fast' | 'moderate' | 'full';
	excludeDirs: string[];
	/** 保留目录（即使父目录被排除也不跳过），相对路径如 "Content/Script" */
	keepDirs?: string[];
	subPath?: string;
	/**
	 * 项目名（多 folder 工作区：每个 folder 用唯一项目名，如 "S1Game" / "UE5EA"）。
	 * 与 subPath 语义分离：subPath 是扫描子路径过滤，projectName 才是图中节点的 project 归属。
	 * 未提供时回退到 subPath，再回退到 '_default'。
	 */
	projectName?: string;
	crossRepoIntelligence?: boolean;
}

export interface IIndexResult {
	success: boolean;
	message: string;
	duration?: number;
	stats?: {
		filesScanned: number;
		nodesExtracted: number;
		edgesExtracted: number;
	};
	/**
	 * 本次索引的 root（2026-09-15）。
	 *
	 * ★ 多 folder 工作区下**必须**是「刚索引的那个 folder」——订阅方
	 * （`codebaseGraphBootstrap` 的 `onDidIndexComplete`）据此决定刷新哪个 root 的 watcher；
	 * 它原先用 `folders[0]`（`_primaryFolder()`）⇒ 索引 folder B 却只刷新 folder A 的 watcher，
	 * B 的排除集（`.cbmignore` 刚被写入）永不生效（与 `_onWatcherChange` / `_resolveActiveProject`
	 * 同一条「用 folders[0] 代替事件所属 root」的教训）。
	 */
	rootPath?: string;
	/**
	 * 全量 / 增量（2026-09-15）。
	 * 增量由 **watcher 自己**触发（watcher 必然已存在、排除集未变）⇒ 订阅方**不需要**刷新 watcher，
	 * 否则每轮增量都会重跑一次 `_excludeResolver.resolve()` + 替换 root 条目 + 两条日志。
	 */
	kind?: 'full' | 'incremental';
}

/** 单文件索引覆盖率状态（对标 C 的 parse_partial/skipped/not_indexed） */
// 状态类型下沉到 common（store 与测试共用）；此处 re-export 保持既有 import 路径兼容
import { FileCoverageStatus } from '../common/codebaseIndexDefaults.js';
export type { FileCoverageStatus };

export interface IFileCoverage {
	path: string;            // 相对路径
	status: FileCoverageStatus;
	reason?: string;         // skipped/parse_error/timeout 的原因
	nodes?: number;          // indexed/partial 时提取的节点数
	ext?: string;
}

export interface IIndexCoverageReport {
	project: string;
	totalFiles: number;
	indexed: number;
	skipped: number;
	parseError: number;
	timeout: number;
	partial: number;
	coveragePct: number;     // indexed / totalFiles * 100
	skippedFiles: IFileCoverage[];
	errorFiles: IFileCoverage[];
}

/**
 * 索引健康度报告（2026-09-09）。
 * 判据 nodesPerFile < 2 = 残缺：解析大面积失败且失败被固化时，图只剩被编辑过的文件。
 */
export interface IIndexHealthReport {
	nodeCount: number;
	fileCount: number;        // fileHashes 基线条数（参与过索引的文件数）
	nodesPerFile: number;     // nodeCount / fileCount，正常 ≥ 2
	parseFailedFiles: number; // 本轮覆盖率里 parse_error + timeout 数
	absPathViolations: number;// filePath 写成绝对路径的契约违规数
	deficient: boolean;
	message?: string;         // 残缺时的用户可读提示
}

export interface IGraphStatus {
	exists: boolean;
	graphPath?: string;
	size?: number;
	lastModified?: string;
	nodeCount?: number;
	edgeCount?: number;
}

// ─── Service Interface ──────────────────────────────────────────────────────

export const ICodebaseGraphService = createDecorator<ICodebaseGraphService>('ICodebaseGraphService');

/** 类继承树节点（VA View / HCB 风格，递归树）。 */
export interface IClassHierarchyNode {
	node: GraphNode;
	/** 根节点为 'root'；基类方向来自 INHERITS，接口方向来自 IMPLEMENTS。 */
	kind: 'root' | 'INHERITS' | 'IMPLEMENTS';
	bases: IClassHierarchyNode[];
	derived: IClassHierarchyNode[];
}

export interface ICodebaseGraphService {
	readonly _serviceBrand: undefined;
	readonly onDidIndexProgress: Event<string>;
	readonly onDidIndexComplete: Event<IIndexResult>;
	readonly isIndexing: boolean;

	/**
	 * 是否正在**加载/合并**图谱制品（`loadGraphMerge` 进行中；启动期大图实测 10~40s）。
	 *
	 * 2026-09-15 新增。UI（Find Symbol / Open File / 类继承 / 三个 QuickPick 命令）在用户打开
	 * 那一刻若正处于加载中，必须显示「正在加载，请稍候」并**等它结束** —— 因为加载期间
	 * `isIndexing === false` 且 `hasGraphData() === false`（数据还没进 store），
	 * 不做区分就会误判「无图」而**在加载中再发起一次全量索引**（与加载抢 store，双重开销）。
	 *
	 * 注：`onDidIndexProgress` 只覆盖索引路径，加载必须单独暴露（见 `onDidGraphLoadProgress`）。
	 */
	readonly isGraphLoading: boolean;
	/** 图谱**加载/合并**的阶段进展（文案行）。与索引的 `onDidIndexProgress` 语义分开。 */
	readonly onDidGraphLoadProgress: Event<string>;

	indexWorkspace(rootPath: string, config: IIndexConfig, token?: CancellationToken): Promise<IIndexResult>;
	cancelIndex(): void;
	startWatching(rootPath: string, extraExcludeDirs?: readonly string[], keepDirs?: readonly string[]): void;
	getGraphStatus(workspacePath?: string): Promise<IGraphStatus>;
	saveGraph(targetPath: string): Promise<void>;
	loadGraph(sourcePath: string): Promise<boolean>;
	/**
	 * 强制落盘所有待发的延迟保存（增量索引的落盘是延迟合并的，见 SAVE_DEBOUNCE_MS）。
	 * 供窗口关闭前 / 显式"保存图谱"等场景调用，避免延迟窗口内的索引结果丢失。
	 */
	flushPendingSave(): Promise<void>;
	/**
	 * 合并加载：把 sourcePath 的图【追加】到当前内存 store（不清空），用于多 folder 工作区。
	 * @param projectOverride 覆盖加载数据的项目名（每 folder 唯一，如 "UE5EA"）
	 * @param rebuildBM25 合并完成后是否重建 BM25（多 folder 建议全部合并后仅最后一次重建）
	 */
	loadGraphMerge(sourcePath: string, projectOverride?: string, rebuildBM25?: boolean): Promise<boolean>;

	/**
	 * ★★★ 2026-09-18（P1-1）：「制品解析可跳过」判据（实现见 `CodebaseGraphService.canSkipArtifactParse`）。
	 * 主进程 SQLite 已有该项目、且节点数 **≥** `artifact.json` 的 `node_count` ⇒ 返回 true；
	 * 拿不到计数 / 判据异常 ⇒ **false**（保守：照旧解析制品）。
	 */
	canSkipArtifactParse(project: string, graphFilePath: string): Promise<boolean>;

	/**
	 * ★★★ 2026-09-18（P1-1 步骤3）：从 **SQLite 快照制品**（队友共享 / 新机器冷启动）分页载入内存 store。
	 * 与原产物（gzip+JSON）相比**完全不解析 JSON** ✓；载入收尾释放只读快照实例。
	 */
	loadSnapshotArtifact(dbPath: string): Promise<boolean>;

	/**
	 * 等待所有进行中的图谱加载（loadGraphMerge）完成后再返回（带超时保护）。
	 * 修复竞态：启动时 bootstrap 异步合并加载大图谱（18w+ 节点需数十秒），
	 * 期间 LLM 调 index_status/search_graph 会看到"无数据"误判未索引 → 触发全量重建。
	 * 所有"图是否有数据"的判定路径必须先 await 此方法。
	 */
	whenGraphLoaded(timeoutMs?: number): Promise<void>;
	/** 按 rootPath 判断对应 folder 的项目是否已有节点数据（多 folder 逐个守卫用）。 */
	hasProjectData(rootPath: string): boolean;

	// ── 非主 root 大图的**延迟加载**（2026-09-15 用户裁决方案 C）────────────────────
	//
	// 背景：`codebaseGraphBootstrap._bootstrap()` 原本无条件加载**所有** folder 的图，
	// 而图谱解压/反序列化是 CPU/内存密集的同步重活（实测 sarosis 8.2MB ⇒ 21.6s/17.9 万节点、
	// UE5EA 24.6MB ⇒ 数十秒/87.6 万节点）⇒ 切到含大图非主 root 的工作区会整窗卡死数十秒。
	// 但默认检索作用域只到主 root（`_resolveActiveProject()` 取 folders 顺序里第一个有映射的项目）
	// ⇒ 非主图在「打开工作区」这一刻并不必要 ⇒ 延迟到**真正用到**时再加载。

	/**
	 * 注册「按需加载器」—— 由 `codebaseGraphBootstrap` 注入（只有它知道 folder 顺序、
	 * `_readyFolders` 状态与被延迟的集合）。返回 disposable 用于注销。
	 */
	registerDeferredGraphLoader(loader: (reason: string) => Promise<void>): IDisposable;

	/**
	 * 触发「被延迟加载的图谱」—— 供**真正要用图**的路径调用
	 * （codebase 工具预检 `ensureGraph()` / 子代理预检 `_ensureGraphReadyForExplore()`）。
	 *
	 * 幂等：没有待加载项时是空操作；进行中复用同一 promise。
	 * 失败只 warn（**绝不**退化成全量重建 —— 见 `_bootstrap()` 里同名教训）。
	 */
	ensureDeferredGraphsLoaded(reason: string): Promise<void>;

	/** Export the current graph as a compressed artifact (graph.db.zst + artifact.json) for team sharing. opts.slim 默认 true（剔除可重建的 bm25/layout）。 */
	exportArtifact(targetPath: string, opts?: { slim?: boolean }): Promise<{ size: number; nodeCount: number; edgeCount: number }>;
	/** Import a compressed artifact (graph.db.zst / graph.db.gz / graph.json) and replace the current graph. */
	importArtifact(sourcePath: string): Promise<boolean>;

	getGraphData(): GraphData;
	getGraphDataDownsampled(maxNodes: number): GraphData;
	getVisualizationData(maxNodes: number): VisualizationData;
	getVisualizationNodes(offset: number, limit: number): { nodes: VisualizationNode[]; total: number };
	getVisualizationEdges(nodeIds: Set<string>, offset: number, limit: number): GraphEdge[];
	getTotalEdgeCount(): number;
	hasGraphData(): boolean;
	getTotalNodeCount(): number;

	/**
	 * 指定项目在内存 store 中的节点数。
	 *
	 * ★ 2026-09-15（用户日志 `vscode-app-1789480447320.log`）：用于区分「**加载成功但为空**」——
	 * 被落盘竞态写坏的制品**仍能成功解压成一张空图**，`loadGraphMerge` 返回 `true`，
	 * 若据此直接标记「已就绪」，该 folder 就**永远不会重建** ✗。
	 */
	getProjectNodeCount(project: string): number;

	/**
	 * 最近一次针对该 root 的 `loadGraphMerge()` 是否**解析成功但结果为空**（0 节点）。
	 *
	 * ★ 2026-09-16（用户报「PJDB\S1Game 一份 **10KB** 空图永远不重建」）：
	 * 调用方要在「**跳过**自动索引（避免对几十 MB 的巨图反复全量重建）」与「**允许**重建
	 * （制品其实是空的）」之间二选一，而这两种情况的返回值、节点数、**字节数**都可能相同 ——
	 * 只有解析方（本服务）知道区别：**能解压出内容 ⇒ 制品是空的；解压报错 ⇒ 制品是坏的**。
	 * 于是把判据从「字节数」这个**代理**换回事实。
	 *
	 * ⚠ 契约：只反映**最近一次**针对该 root 的合并结果 ⇒ 必须**紧接在 `loadGraphMerge` 之后**调用；
	 * 之后任何一次非空合并都会清除该标记。`rootPath` 传该 folder 的根（与构造制品路径时同一来源）。
	 */
	isLastMergeEmpty(rootPath: string): boolean;

	/** Phase 2c async overloads — 当 `saros.codebaseGraph.sqliteBackend` 启用时走 SQLite 后端 */
	getVisualizationNodesAsync(offset: number, limit: number): Promise<{ nodes: VisualizationNode[]; total: number }>;
	getVisualizationEdgesAsync(nodeIds: Set<string>, offset: number, limit: number): Promise<GraphEdge[]>;
	getTotalNodeCountAsync(): Promise<number>;
	getTotalEdgeCountAsync(): Promise<number>;
	searchNodesAsync(pattern: string, nodeType?: string, limit?: number): Promise<GraphNode[]>;
	getNodeAsync(id: string): Promise<GraphNode | undefined>;
	listProjectsAsync(): Promise<{ name: string; nodeCount: number; edgeCount: number; fileCount: number }[]>;
	hasGraphDataAsync(): Promise<boolean>;
	/** 已索引文件清单（P1b）：search_files target=files 快路径；project 缺省跨全部项目。 */
	listIndexedFilePaths(project?: string): Promise<{ filePath: string; project: string }[]>;
	getNodeTypesAsync(project?: string): Promise<Record<string, number>>;
	getEdgeTypesAsync(project?: string): Promise<Record<string, number>>;

	searchNodes(pattern: string, nodeType?: string): GraphNode[];
	getNode(id: string): GraphNode | undefined;
	getNodeSignals(qualifiedName: string): { name: string; score: number; detail: string }[] | undefined;
	getEdges(nodeId?: string): GraphEdge[];

	/**
	 * 符号引用查找（对齐 VAX Find References，Shift+Alt+F）。
	 * 返回所有指向该符号的入边（CALLS / INHERITS / IMPLEMENTS / IMPORTS / USAGE …）的源节点。
	 * @param qualifiedName 符号 QN（file::name）或纯名称（内部反查）
	 * @param edgeTypes 可选过滤边类型（如 ['CALLS']）；缺省返回全部引用
	 * @param access 可选读写过滤（'read' | 'write'，仅对 USAGE 边生效；其余边恒视为 read）
	 */
	getNodeReferences(qualifiedName: string, edgeTypes?: string[], access?: 'read' | 'write'): { node: GraphNode; edgeType: string; access: 'read' | 'write' }[] | undefined;

	executeCypher(query: string, maxRows?: number): { columns: string[]; rows: any[][] };
	semanticSearch(query: string, limit?: number): { node: GraphNode; score: number; signals: Record<string, number> }[];

	getArchitecture(): Promise<any>;
	getGraphSchema(): GraphSchema;
	getIndexStatus(): { project: string; exists: boolean; nodeCount: number; edgeCount: number; fileCount: number; coverage?: IIndexCoverageReport };
	getIndexStatusAsync(): Promise<{ project: string; exists: boolean; nodeCount: number; edgeCount: number; fileCount: number; coverage?: IIndexCoverageReport }>;
	getIndexCoverage(): IIndexCoverageReport;
	/**
	 * 索引健康度（2026-09-09）。「有数据」≠「健康」——图可能只含被编辑过的文件
	 * （解析大面积失败且失败被固化）。供 UI 在空结果时给出「图谱残缺，请重建」提示。
	 */
	getIndexHealth(): IIndexHealthReport;
	getMissedGraph(): { nodes: { id: string; name: string; type: string; kind?: string; detail?: string }[]; edges: { source: string; target: string; type: string }[] };

	tracePath(sourceName: string, targetName: string | undefined, mode?: string): any;
	searchCode(query: string, limit?: number, filePattern?: string, useRegex?: boolean, project?: string): Promise<{ results: { filePath: string; lineNo: number; text: string; node?: GraphNode; relevanceScore: number }[]; totalMatches: number; coverage?: { scanned: number; total: number } }>;

	searchGraph(params: {
		project?: string;
		query?: string;
		namePattern?: string;
		label?: string;
		filePattern?: string;
		/**
		 * 需要排除的节点类型（**非符号**容器/桩节点，2026-09-15）。
		 * 约定值见 `common/codebaseIndexDefaults.ts` 的 `NON_SYMBOL_NODE_TYPES`。
		 * 语义：**下推到 SQL**（否则 `LIMIT` 已先把符号挤掉，见 `searchNodes` 注释），
		 * 内存回退路径与 renderer 后置过滤再各兜一层。比较大小写不敏感。
		 */
		excludeTypes?: readonly string[];
		/**
		 * 只匹配 `name` 列（**符号名检索**，2026-09-15）。
		 *
		 * 为什么需要：QN = `<相对文件路径>::<符号名>`，不限定字段时搜 `test` 会命中 QN 里的
		 * `…/classifyLLM.test.ts` ⇒ Find Symbol 返回 `MockClassifyLLM`（用户截图报障）。
		 * 语义：下推到 SQL（`nameOnly` 时**跳过 FTS 直接走 `name LIKE`** —— FTS 是词元匹配，
		 * `testHelper` 会被漏掉），内存路径同口径过滤，renderer 再兜一层。
		 */
		nameOnly?: boolean;
		limit?: number;
		offset?: number;
		sortBy?: 'name' | 'inDegree' | 'outDegree' | 'degree';
		sortDesc?: boolean;
		minInDegree?: number;
		maxInDegree?: number;
		minOutDegree?: number;
		maxOutDegree?: number;
		relType?: string;
	}): { nodes: GraphNode[]; total: number; scores?: Record<number, number>; hasMore?: boolean };

	/**
	 * searchGraph 的 SQLite 后端感知异步版（P0）：后端启用时文本/名称检索走主进程
	 * FTS5/LIKE（不占 renderer 堆，也不需要把图全量回载内存）；未启用时退化为同步内存路径。
	 */
	searchGraphAsync(params: {
		project?: string;
		query?: string;
		namePattern?: string;
		label?: string;
		filePattern?: string;
		/**
		 * 需要排除的节点类型（**非符号**容器/桩节点，2026-09-15）。
		 * 约定值见 `common/codebaseIndexDefaults.ts` 的 `NON_SYMBOL_NODE_TYPES`。
		 * 语义：**下推到 SQL**（否则 `LIMIT` 已先把符号挤掉，见 `searchNodes` 注释），
		 * 内存回退路径与 renderer 后置过滤再各兜一层。比较大小写不敏感。
		 */
		excludeTypes?: readonly string[];
		/**
		 * 只匹配 `name` 列（**符号名检索**，2026-09-15）。
		 *
		 * 为什么需要：QN = `<相对文件路径>::<符号名>`，不限定字段时搜 `test` 会命中 QN 里的
		 * `…/classifyLLM.test.ts` ⇒ Find Symbol 返回 `MockClassifyLLM`（用户截图报障）。
		 * 语义：下推到 SQL（`nameOnly` 时**跳过 FTS 直接走 `name LIKE`** —— FTS 是词元匹配，
		 * `testHelper` 会被漏掉），内存路径同口径过滤，renderer 再兜一层。
		 */
		nameOnly?: boolean;
		limit?: number;
		offset?: number;
		sortBy?: 'name' | 'inDegree' | 'outDegree' | 'degree';
		sortDesc?: boolean;
		minInDegree?: number;
		maxInDegree?: number;
		minOutDegree?: number;
		maxOutDegree?: number;
		relType?: string;
	}): Promise<{
		nodes: GraphNode[]; total: number; scores?: Record<number, number>; hasMore?: boolean;
		/** 命中全部落在其它已索引项目时的分布（当前项目 0 命中才置位）。 */
		crossProjectOnly?: { project: string; count: number }[];
	}>;

	tracePathAdvanced(sourceName: string, targetName: string | undefined, opts?: {
		mode?: 'calls' | 'data_flow' | 'cross_service';
		maxDepth?: number;
		excludeEntry?: boolean;
		direction?: 'both' | 'callers' | 'callees';
		includeTests?: boolean;
		edgeTypes?: string[];
	}): any;

	/**
	 * 类继承树（VA View / Hovering Class Browser 风格）：沿 INHERITS/IMPLEMENTS 边双向 BFS。
	 * @param qualifiedName 类节点 QN（如 file::Foo），或纯名称（内部用 searchNodes 反查）
	 * @param direction  'bases'（向上基类）| 'derived'（向下派生）| 'both'
	 * @param maxDepth   最大深度（默认 8，防环防爆）
	 * @returns 嵌套树：节点 + bases[] + derived[]，每层附 kind（INHERITS|IMPLEMENTS）
	 */
	getClassHierarchy(qualifiedName: string, direction?: 'bases' | 'derived' | 'both', maxDepth?: number): IClassHierarchyNode | undefined;

	/**
	 * 高级架构分析（Leiden 社区检测 + dead code 检测）。
	 * @param dimensions 请求的报告维度（可省略 → 全量）
	 * @param project 限定项目名；缺省用当前项目（_projectName），跨项目则显式传。
	 *               2026-08-09：此前固定传 undefined 会全量分析含 UE5EA 等所有项目，
	 *               70 万节点导致 get_architecture 卡住数分钟（日志 1786268047075）。
	 */
	getArchitectureAdvanced(dimensions?: string[], project?: string): Promise<any>;
	getCodeSnippet(qualifiedName: string, contextLines?: number, includeNeighbors?: boolean): Promise<{ filePath: string; startLine: number; endLine: number; content: string; language: string; neighbors?: { name: string; content: string }[] } | null>;

	listProjects(): { name: string; nodeCount: number; edgeCount: number; fileCount: number }[];
	deleteProject(name: string): void;
	/** project → 索引根路径（rootPath）映射，来自 _rootProjectMap 反转；供工具输出把项目相对 filePath 还原为绝对路径。 */
	getProjectRoots(): Record<string, string>;

	/**
	 * 把图谱节点的 root 相对 `filePath` 解析为**真实存在**的绝对 URI + 1-based 行号。
	 *
	 * 所有「从图谱节点跳到源码」的入口（Find Symbol / Class Hierarchy / Open File /
	 * Goto Implementation / 语言特性 provider）都必须走这里，不要再各自拼串。
	 *
	 * @param node       至少要有 `filePath`；`startLine` 缺失时行号回落 1
	 *                   （图谱里 `label='file'` 的 stub 节点本来就没有行号）
	 * @param opts.quiet true = 未命中不告警（语言特性 provider 逐节点探测，跳过属正常路径）
	 * @returns 命中的 `{ uri, line }`；索引陈旧 / 文件已删时返回 undefined
	 */
	resolveNodeLocation(node: { name?: string; filePath?: string; project?: string; startLine?: number }, opts?: { quiet?: boolean }): Promise<{ uri: URI; line: number } | undefined>;

	detectChanges(opts?: { since?: string; baseBranch?: string; impactAnalysis?: boolean; scope?: string; depth?: number }): Promise<any>;

	/** Phase 2f：确保内存 store 中有图数据（启用 SQLite 后端时按需从 SQLite 加载） */
	tryLoadFromSqlite(): Promise<boolean>;

	tryLockIndex(): boolean;
	isIndexLocked: boolean;

	ingestTraces(otlpJson: string): { spansIngested: number; edgesWritten: number };
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * `_loadGraphFromSqlite()` 的分页大小（单次 IPC 负载行数，2026-09-16）。
 *
 * 取 5000：单批 upsert/insertEdge 约 5~20ms（正好在 8ms 切片预算附近，会被 `yieldToEventLoop`
 * 切掉），且单条 IPC 消息控制在 MB 级 —— 大了则单批处理时间长，小了则往返次数太多。
 */
const SQLITE_LOAD_PAGE_SIZE = 5000;

/**
 * `onDidGraphLoadProgress` 的**终态行**前缀（2026-09-16）。
 *
 * 语义：UI 收到以它开头的行 = 「本次加载已结束」，可清掉「正在加载… 请稍候」提示并刷新列表。
 * 为什么用前缀约定而不加一个新事件：该事件已被 merge / BM25 / SQLite 同步等多处消费，改事件
 * 类型会牵动全部消费点；而常量**两端同一个来源**，不会退化成各写一遍的魔法字符串。
 *
 * 目前只有 `_loadGraphFromSqlite()`（SQLite 按需载入，实测 13~32s —— 正是「LLM 输出时 app
 * 无响应」那条）会发终态行；制品合并路径（`loadGraphMerge`）有 `isGraphLoading` 状态可判。
 */
export const GRAPH_LOAD_DONE_PREFIX = '✅ 图谱加载完成';

// EXTENSION_TO_WASM_LANG 已下沉到 common/codebaseIndexDefaults.js（service 与 Scanner 共用）



/** 分支节点类型 — 用于计算圈复杂度 */
const BRANCH_NODE_TYPES = new Set([
	'if_statement', 'else_clause', 'for_statement', 'while_statement',
	'do_statement', 'switch_statement', 'case_statement', 'catch_clause',
	'conditional_expression', 'ternary_expression',
]);

/** 循环节点类型 — 用于计算嵌套循环深度 */
const LOOP_NODE_TYPES = new Set([
	'for_statement', 'while_statement', 'do_statement',
]);

/**
 * 通用默认排除目录 —— 单一来源见 `common/codebaseIndexDefaults.ts`。
 * UE / 游戏引擎等特异性排除不再硬编码，改为读取 code-workspace 的
 * `search.exclude`/`files.exclude` 配置。
 *
 * 注：原 `DEFAULT_EXCLUDE_DIRS` 已随排除集解析一并移入 CodebaseGraphExcludeResolver
 * （2026-09-09，P1-5）——档位基线统一由 `excludeDirsForProfile()` 提供，避免两处口径漂移。
 */

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const MAX_LINE_LENGTH = 10000;   // 超过此行长的文件跳过（minified/生成代码会导致 tree-sitter 挂起）

/**
 * 增量索引落盘的延迟合并窗口（ms）。
 *
 * 落盘是**全图**序列化 + gzip（12.4w 节点），与变更集大小无关。增量索引每轮都落盘的话，
 * 连续保存 N 个文件就是 N 次全量压缩（配合 watcher 5~60s 轮询会持续触发）。
 * 延迟窗口内的多次索引结果合并为一次落盘。
 *
 * 取值权衡：太小（<5s）合并不充分；太大则崩溃时丢失的索引进度更多（图可重建，
 * 仅是重索引耗时）。30s 对齐 watcher 平均轮询间隔量级，且制品写的是 slim 档，
 * 丢失的最坏后果是下次启动重新索引，不丢用户数据。
 */
const SAVE_DEBOUNCE_MS = 30000;

/**
 * 增量索引触发 zst 全量落盘（_saveGraph，96MB 序列化 + gzip）的最小间隔（ms）。
 *
 * 背景（2026-09-02，日志 vscode-app-1788352997271）：增量索引每轮都排队一次全图
 * 落盘，而变更本身已由 `_syncIncrementalToSqlite` 写入主进程 SQLite（实测 40-442ms）。
 * SQLite 后端启用时，zst 制品退化为「冷启动快照」，每次增量重写 96MB 是纯冗余开销
 * —— 故按此间隔节流，窗口内的增量只更新 SQLite。
 *
 * 取值：30min。zst 是权威快照（SQLite 允许落后，见 _syncIncrementalToSqlite 注释
 * 「失败仅让 sqlite 落后于内存」），但有两条兜底：① 正常退出经 dispose→flushPendingSave
 * 强制落盘，不丢数据；② 崩溃丢失的增量由 watcher 经 fileHashes 差异自动补回（自愈）。
 * 故可放宽到 30min，换取更少的 96MB 全量重写。
 * 未启用 SQLite 后端时不节流（此时 zst 是唯一持久化，必须每次落盘）。
 */
const ZST_SAVE_MIN_INTERVAL_MS = 30 * 60 * 1000;

/**
 * ★★ 2026-09-19：**全量 SQLite 同步**的最小重试间隔（冷却）。
 *
 * 为什么需要：`_syncGraphToSqlite` 实测 **82s**（180115 节点 + 522085 边，走 IPC + FTS 逐批插入）。
 * 它现在由「载入路径」与「查询期 freshness」两处**按需**触发 ⇒ 若判据在失败/竞态后仍反复成立，
 * 就会每次都付 82s ✗。冷却 + 「同步中」守卫一起把损失限制为「最多每 5 分钟一次、且不并发」✓。
 */
const FULL_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 延迟落盘的**最长等待**上限（ms）。
 *
 * 纯 debounce 有饥饿问题：持续保存文件时每次都重置窗口，落盘被无限推迟，
 * 制品长期停在旧版本（崩溃即丢失全部近期索引结果）。
 * 首个待发请求超过本上限时，不再等待，立即落盘。
 */
const SAVE_MAX_DEFER_MS = 120000;

/**
 * ★ 2026-09-20（方案 B：有检索在飞 ⇒ 推迟落盘）：被推迟后的重试间隔（ms）。
 *
 * 取值权衡：太长 ⇒ 检索结束后制品迟迟不更新；太短 ⇒ 连续检索时反复空转（每次只是判断一下，
 * 成本极低，但仍无意义）。1.5s 既能跟上「连续检索之间的间隙」，又不会忙等 ✓。
 * ⚠ 它**不延长**既有上限：总推迟仍受 `SAVE_MAX_DEFER_MS` 约束（见 `_fireSaveOrDefer` ✓）。
 */
const SAVE_DEFER_BY_SEARCH_MS = 1500;

// ─── GraphStore (legacy compatibility wrapper) ─────────────────────────────

class GraphStore {
	// Index signature so the legacy compatibility wrapper can be accessed by
	// bracket notation from CodebaseGraphService (e.g. `graph['_revIdMap']`).
	// Without it TS reports "Element implicitly has an 'any' type" under
	// noImplicitAny for those private-member accesses.
	[key: string]: any;

	private _store: CodebaseGraphStore = new CodebaseGraphStore();
	get store(): CodebaseGraphStore { return this._store; }
	/**
	 * 活跃项目：indexWorkspace/增量索引开始时由服务层设置。
	 * addNode/addEdge/deleteByFile 以此标记项目——严禁回退为硬编码 '_default'，
	 * 否则按 _projectName 过滤的 post-passes（CALLS/SIMILAR/Leiden）与
	 * _saveGraph(project) 流式保存会全部落空（曾导致索引 5.6w 节点落盘 0、无限重建循环）。
	 */
	private _activeProject: string = '_default';
	setActiveProject(project: string): void { this._activeProject = project || '_default'; }
	private _nodeIdMap: Map<string, number> = new Map();
	private _revIdMap: Map<number, string> = new Map();
	private _nodesByFile: Map<string, string[]> = new Map();
	private _fileHashes: Map<string, { sha256: string; mtimeNs: number; size: number }> = new Map();

	clear(): void {
		this._store.clear();
		this._nodeIdMap.clear();
		this._revIdMap.clear();
		this._nodesByFile.clear();
		this._fileHashes.clear();
	}

	// ── Node operations ──

	addNode(node: GraphNode): number {
		const numericId = this._toNumId(node.id);
		this._store.upsertNode({
			project: this._activeProject,
			id: numericId,
			label: node.type,
			name: node.name,
			qualifiedName: node.qualifiedName || node.name,
			filePath: node.filePath,
			startLine: node.startLine,
			endLine: node.endLine,
			properties: node.properties || {},
		});
		if (node.filePath) {
			const fileNodes = this._nodesByFile.get(node.filePath) || [];
			fileNodes.push(node.id);
			this._nodesByFile.set(node.filePath, fileNodes);
		}
		return numericId;
	}

	getNode(id: string): GraphNode | undefined {
		const numericId = this._nodeIdMap.get(id);
		if (numericId === undefined) { return undefined; }
		const node = this._store.getNode(numericId);
		if (!node) { return undefined; }
		return this._nodeToGraphNode(node);
	}

	searchByName(pattern: RegExp, nodeType?: string): GraphNode[] {
		const results: GraphNode[] = [];
		// 多 folder：跨全部项目搜索（节点按真实项目名存储，不再存在 '_default' 硬过滤）
		const allNodes = this._store.getAllNodes();
		for (const node of allNodes) {
			if (nodeType && node.label !== nodeType) { continue; }
			if (pattern.test(node.name) || pattern.test(node.qualifiedName || '')) {
				results.push(this._nodeToGraphNode(node));
			}
		}
		return results;
	}

	getEdgesOf(nodeId: string): GraphEdge[] {
		const numericId = this._nodeIdMap.get(nodeId);
		if (numericId === undefined) { return []; }
		const edges = this._store.getEdgesBySource(numericId);
		return edges.map(e => this._edgeToGraphEdge(e));
	}

	getAllEdges(): GraphEdge[] {
		// 多 folder：保留端点存在性校验，跨全部项目（不再限定 '_default'）
		const edges = this._store.getAllEdges().filter(e => {
			const src = this._store.getNode(e.sourceId);
			const tgt = this._store.getNode(e.targetId);
			return src && tgt;
		});
		return edges.map(e => this._edgeToGraphEdge(e));
	}

	toJSON(): GraphData {
		const nodes = this._store.getAllNodes().map(n => this._nodeToGraphNode(n));
		const edges = this.getAllEdges();
		return { nodes, edges };
	}

	/**
	 * 高效降采样：直接从 store 迭代器中选取 top-N 节点（按 degree 排序），
	 * 避免创建 25 万节点的完整数组。仅转换 N 个节点为 GraphNode 格式。
	 */
	toJSONDownsampled(maxNodes: number): GraphData {
		// 多 folder：跨全部项目降采样（不再限定 '_default'）
		const storeNodes = this._store.getAllNodes();

		// Sort by degree descending, take top-N
		storeNodes.sort((a, b) => ((b.inDegree || 0) + (b.outDegree || 0)) - ((a.inDegree || 0) + (a.outDegree || 0)));
		const topNodes = storeNodes.slice(0, maxNodes);

		// Build set of kept numeric IDs for edge filtering
		const keptIds = new Set(topNodes.map(n => n.id));

		// Convert only N nodes
		const nodes = topNodes.map(n => this._nodeToGraphNode(n));

		// Get edges between kept nodes only (iterate store edges once)
		const edges: GraphEdge[] = [];
		for (const edge of this._store.getAllEdges()) {
			if (keptIds.has(edge.sourceId) && keptIds.has(edge.targetId)) {
				edges.push(this._edgeToGraphEdge(edge));
			}
		}

		return { nodes, edges };
	}

	/** 轻量级检查：图中是否有数据（不创建完整数组）。多 folder：任一项目有数据即视为有数据。 */
	hasData(): boolean {
		return this._store.getNodeCount() > 0;
	}

	fromJSON(data: GraphData): void {
		this.clear();
		for (const node of data.nodes) {
			this.addNode(node);
		}
		for (const edge of data.edges) {
			this.addEdge(edge);
		}
	}

	/**
	 * 异步分批加载：每 BATCH_SIZE 项后 yield 到 UI 线程。
	 * addNode/addEdge 内部会更新 BM25 索引，比 CodebaseGraphStore.fromJSON 更重。
	 */
	async fromJSONAsync(data: GraphData, onProgress?: (loaded: number, total: number) => void): Promise<void> {
		this.clear();
		const BATCH_SIZE = 5000;
		const total = data.nodes.length + data.edges.length;

		// 延迟 BM25：加载阶段跳过逐条索引，完成后一次性重建
		this._store.setDeferBM25(true);

		for (let i = 0; i < data.nodes.length; i += BATCH_SIZE) {
			const end = Math.min(i + BATCH_SIZE, data.nodes.length);
			for (let j = i; j < end; j++) {
				this.addNode(data.nodes[j]);
			}
			if (onProgress) { onProgress(end, total); }
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}

		for (let i = 0; i < data.edges.length; i += BATCH_SIZE) {
			const end = Math.min(i + BATCH_SIZE, data.edges.length);
			for (let j = i; j < end; j++) {
				this.addEdge(data.edges[j]);
			}
			if (onProgress) { onProgress(data.nodes.length + end, total); }
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}

		// 批量重建 BM25 索引。
		// force=true：本路径是加载/合并且 defer 期间无脏集累积，增量模式会因脏集为空
		// 直接返回，导致 BM25 静默为空（search_graph 无结果）。
		this._store.setDeferBM25(false);
		await this._store.rebuildBM25(undefined, true);
	}

	// 合并加载（loadGraphMerge）后，节点按真实项目名（如 S1Game/UE5EA）存储，
	// 不存在 '_default' 项目，故必须返回合并总数，否则恒为 0。
	get nodeCount(): number {
		return this._store.getNodeCount();
	}

	get edgeCount(): number {
		return this.getAllEdges().length;
	}

	// ── Internal helpers ──

	private _toNumId(strId: string): number {
		if (!this._nodeIdMap.has(strId)) {
			// Bug（2026-09-09，用户堆栈实锤）：原 `newId = this._nodeIdMap.size + 1`——
			// 加载恢复后映射表为空而 store 已有 17.5w 节点，新节点 id 从 1 开始**覆盖
			// 已有节点** → 下一轮删除旧节点时把新节点连带删除 → QN 键悬空 →
			// 第三轮 upsertNode 读 `existing.inDegree` 崩溃（且图数据被污染）。
			// 改从 store 的 _nextNodeId 分配（与持久化恢复的计数器衔接，永不冲突）。
			const newId = this._store.allocNodeId();
			this._nodeIdMap.set(strId, newId);
			this._revIdMap.set(newId, strId);
		}
		return this._nodeIdMap.get(strId)!;
	}

	private _nodeToGraphNode(node: any): GraphNode {
		return {
			id: this._revIdMap.get(node.id) || String(node.id),
			name: node.name,
			type: node.label,
			filePath: node.filePath,
			qualifiedName: node.qualifiedName,
			inDegree: node.inDegree || 0,
			outDegree: node.outDegree || 0,
			startLine: node.startLine,
			endLine: node.endLine,
			project: node.project || '_default',
			properties: node.properties,
		};
	}

	private _edgeToGraphEdge(edge: any): GraphEdge {
		const srcStr = this._revIdMap.get(edge.sourceId) || String(edge.sourceId);
		const tgtStr = this._revIdMap.get(edge.targetId) || String(edge.targetId);
		return { source: srcStr, target: tgtStr, type: edge.type };
	}

	addEdge(edge: GraphEdge): void {
		const srcNumeric = this._toNumId(edge.source);
		const tgtNumeric = this._toNumId(edge.target);
		// CONTAINS 边的 source 是"文件路径伪节点"（解析器只产出定义节点，从不产出 file 节点）。
		// 在此实体化为 label='file' 的 stub 节点——否则持久化图谱中 CONTAINS 全部悬空，
		// 悬空率 >30% 会触发 GraphPersistence 完整性校验拒绝 → 启动判"无图" → 无限全量重建。
		// （UE5EA 实证：227310/495254=45.9% 悬空被拒；悬空数恰等于节点数=每定义一条 CONTAINS）
		if (edge.type === 'CONTAINS' && edge.source.indexOf('::') === -1) {
			this._store.upsertNode({
				project: this._activeProject,
				id: srcNumeric,
				label: 'file',
				name: edge.source.split('/').pop() || edge.source,
				qualifiedName: edge.source,
				filePath: edge.source,
				properties: {},
			});
		}
		this._store.insertEdge({
			project: this._activeProject,
			sourceId: srcNumeric,
			targetId: tgtNumeric,
			type: edge.type,
			properties: {},
		});
	}

	/** 删除某文件的所有节点及其关联边（增量重索引用）。保留 id 映射以便重新索引复用同一 numeric id（避免 id 碰撞）。 */
	deleteByFile(filePath: string): void {
		this._nodesByFile.delete(filePath);
		this._store.deleteNodesByFile(this._activeProject, filePath);
	}
}

// ─── Main Service ──────────────────────────────────────────────────────────

export class CodebaseGraphService extends Disposable implements ICodebaseGraphService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidIndexProgress = this._register(new Emitter<string>());
	readonly onDidIndexProgress: Event<string> = this._onDidIndexProgress.event;

	private readonly _onDidIndexComplete = this._register(new Emitter<IIndexResult>());
	readonly onDidIndexComplete: Event<IIndexResult> = this._onDidIndexComplete.event;

	private _isIndexing = false;
	get isIndexing(): boolean { return this._isIndexing; }

	/**
	 * 图谱加载/合并的阶段进展（2026-09-15 新增，供 UI 显示「正在加载…请稍候」）。
	 * 与 `_onDidIndexProgress` 分开：那条语义是「索引」，这条是「读制品/合并/重建 BM25/同步 SQLite」。
	 */
	private readonly _onDidGraphLoadProgress = this._register(new Emitter<string>());
	readonly onDidGraphLoadProgress: Event<string> = this._onDidGraphLoadProgress.event;

	/** `loadGraphMerge` 进行中（`_graphLoadingCount > 0`）。UI 用它区分「加载中」与「真无图」。 */
	get isGraphLoading(): boolean { return this._graphLoadingCount > 0; }

	private _indexCts?: CancellationTokenSource;
	private _indexLocked = false;

	get isIndexLocked(): boolean { return this._indexLocked; }

	private _graph: GraphStore = new GraphStore();
	private _parsers: Map<string, TreeSitterParser> = new Map();
	private _languages: Map<string, TreeSitterLanguage> = new Map();
	/** 每个根目录"已生效的索引范围"（解析后的排除集 + keepDirs）— indexWorkspace / watcher / incremental 三条扫描路径口径一致 */
	private readonly _watchScopeCache = new Map<string, { excludeDirs: Set<string>; keepDirs?: string[] }>();
	private _cypherEngine: CypherEngine | undefined;
	private _semanticSearch: SemanticSearch | undefined;
	/** 排除集解析（P1-5 拆分；见 codebaseGraphExcludeResolver.ts）。 */
	private readonly _excludeResolver: CodebaseGraphExcludeResolver;
	/** 文件扫描（P1-5 拆分；见 codebaseGraphScanner.ts）。 */
	private readonly _scanner: CodebaseGraphScanner;
	private _projectName = '_default';
	/** 多 folder：归一化 rootPath → 项目名，供增量索引/监听/保存按 folder 解析正确的 project。 */
	private _rootProjectMap = new Map<string, string>();
	/**
	 * **解析成功但 0 节点**的 root（归一化）。见接口注释 `isLastMergeEmpty`：
	 * bootstrap 需要它把「空制品」与「损坏/超大的制品」区分开 —— 前者允许重建，后者跳过。
	 */
	private readonly _emptyArtifactRoots = new Set<string>();
	/** 累积的调用边（虚拟目标 call:<name>），索引后由 _matchCallsToDefinitions 解析为真实 CALLS 边（#9） */
	private _pendingCallEdges: { source: string; callee: string; loopDepth: number }[] = [];
	/** 累积的继承边（虚拟目标 inherits:/implements:<baseName>），索引后由 _matchInheritsToDefinitions 解析为真实 INHERITS/IMPLEMENTS 边 */
	private _pendingInheritEdges: { source: string; baseName: string; kind: 'INHERITS' | 'IMPLEMENTS' }[] = [];
	/** 累积的使用边（虚拟目标 usage:<name>，access=read|write），索引后由 _matchUsageEdgesToDefinitions 解析为真实 USAGE 边 */
	private _pendingUsageEdges: { source: string; name: string; access: 'read' | 'write' }[] = [];
	private _lspResolver: LspCrossResolver | undefined;
	private _crossRepoEnabled = false;

	// ─── Watcher / Incremental Indexing (P2-#8) ───────────────────────────
	private _incrementalIndexer: CodebaseGraphIncrementalIndexer | undefined;
	private _watchRootPath = '';

	// ─── 延迟合并落盘（2026-08-27）────────────────────────────────────────
	/**
	 * 待落盘的保存请求：归一化 rootPath → { project, timer }。
	 *
	 * 背景：`_saveGraph` 是**全图**序列化 + gzip（12.4w 节点），与改了几个文件无关，
	 * 是增量索引卡顿的最大单点。增量索引每轮都调用它 → 每次保存文件都全量压缩一次。
	 * 此处把落盘延迟 SAVE_DEBOUNCE_MS，期间到达的新请求合并（覆盖同 root 的待发请求），
	 * 静默期结束只落盘一次。全量索引用 `_saveGraph` 立即落盘（不走延迟）。
	 *
	 * 数据安全：`dispose()` 与 `flushPendingSave()` 会强制落盘未完成的请求。
	 */
	// 注意：key 是归一化 rootPath（用于同 root 去重），value 里必须保留**原始** rootPath——
	// 归一化会转小写并把 \ 换成 /，直接拿 key 去落盘在 Windows 上会写到错误路径。
	private _pendingSaves = new Map<string, { rootPath: string; project?: string; timer: any; firstRequestedAt: number }>();
	/** 正在执行的落盘 Promise（防止并发落盘同一制品）。 */
	private _savingGraph: Promise<void> = Promise.resolve();

	// ─── MinHash Clone Detection (P2-#7) ──────────────────────────────────
	private _minHasher: MinHash | undefined;
	private readonly _codeTokenCap = 900; // 单函数代码 token 上限（控制签名计算成本）

	// 索引覆盖率：逐文件记录 status（对标 C 的 parse_partial/skipped/not_indexed）
	private _indexCoverage: Map<string, IFileCoverage> = new Map();

	// ─── Worker Pool (parallel tree-sitter parsing) ────────────────────
	// 池的创建 / 自愈 / 解析调度已拆到 CodebaseGraphParserPool（P1-5，2026-09-09）。
	private readonly _parserPool: CodebaseGraphParserPool;
	/** 兼容转发：既有调用点仍按池列表读取（实际由 _parserPool 持有）。 */
	private get _parserWorkers(): readonly Worker[] { return this._parserPool.workers; }
	// 增量解析复用的请求 id 计数器（与池轮询配对，保证并发请求 id 唯一）
	private _parseReqId = 0;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ITreeSitterLibraryService private readonly _treeSitterLib: ITreeSitterLibraryService,
		@ICommandService private readonly _commandService: ICommandService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@ICodebaseGraphWatcher private readonly _graphWatcher: CodebaseGraphWatcher,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IUtilityProcessWorkerWorkbenchService private readonly _utilityProcessWorkerService: IUtilityProcessWorkerWorkbenchService,
	) {
		super();
		this._excludeResolver = this._instantiationService.createInstance(CodebaseGraphExcludeResolver);
		this._scanner = this._instantiationService.createInstance(CodebaseGraphScanner, this._excludeResolver);
		this._parserPool = this._instantiationService.createInstance(
			CodebaseGraphParserPool,
			(tsJsContent: string) => this._buildWorkerCode(tsJsContent),
		);

		// Phase 2 接线：经主进程代理的 SQLite 后端（默认不启用；见 `_sqliteBackendEnabled`）。
		// renderer sandbox 不能加载原生模块，SQLite 宿主在 main 进程，这里只是透明代理。
		this._sqliteBackend = createCodebaseGraphSqliteBackend(this._mainProcessService);

		// ★★★ 2026-09-19（P2-1 Step 3「方案 B」**探活**）：证明 renderer **能起索引 worker 并取到通道**。
		//
		// 与 Step 2 的差别（重要）：那条路径是 renderer → **main 进程**宿主（现已被否定并删除 ✗ ——
		// main 侧 `createWorker` 是「窗口请求的服务端」，不提供 client channel）。
		// 现在走框架既定用法：renderer 自己 `createWorker` 直连 utility process（同 `watcherClient.ts` ✓）。
		// ⇒ 本探活是**唯一**能证明「进程能起 + 入口模块被解析 + 通道名一致」的证据 ✓。
		// ⚠ 代价：会在启动时真起一个 utility process（这正是 Phase 1 想要的那个进程 ✓）；
		//   入口模块是诚实桩（`runIndex` 返回 not implemented）⇒ **不触发任何索引** ✓，对索引行为零影响。
		// ⚠ 失败必须**响亮**：起不来/通道名漂移都会让这里 reject，绝不能静默（本仓反复踩过"静默"✗）。
		this._indexWorkerDisposables = this._register(new DisposableStore());
		this._indexChannel = createCodebaseGraphIndexChannel(
			this._utilityProcessWorkerService,
			this._logService,
			this._indexWorkerDisposables,
		);
		void this._indexChannel.isRunning('_probe')
			.then(ok => this._logService.info('[CodebaseGraph]', `[index-channel] 探活 OK：isRunning=${ok}（P2-1 Step 3：索引 utility process 直连已连通；编排尚未搬迁）`))
			.catch(err => this._logService.warn('[CodebaseGraph]', `[index-channel] 探活失败：${err?.message || err}（索引 worker 未启动/通道未连通 ✗）`));

		// 文件监听 → 增量重索引（P2-#8）。事件仅在 startWatching() 调用 start() 后产生。
		this._register(this._graphWatcher.onDidChange(e =>
			void this._onWatcherChange(e).catch(err =>
				this._logService.error('[CodebaseGraph]', 'Watcher change handler failed:', err))));

		// 工作区 folder 集合变化 ⇒ 丢弃不属于当前工作区的项目数据（2026-09-15）。
		// 背景：工作区切换走 `replaceWorkspaceFoldersInMemory()`（**不 reload renderer**，见
		// WorkspaceSwitch 日志），而本服务是**窗口内单例** ⇒ 旧工作区的图会永久驻留内存
		// （实测同窗口 3 个工作区共 1,119,421 节点：S1Game 34 万 + UE5EA 78 万 + 本仓），
		// 既污染检索口径（`_projectName` / 项目收敛），也是「UI 卡死」的既有根因。
		// 注：并发 loadGraphMerge 的「迟到者」由 `_loadGraphMergeImpl` 的完成守卫单独兜住。
		this._register(this._workspaceService.onDidChangeWorkspaceFolders(() => {
			// ★★ 2026-09-15（用户报「切换工作区时 app 卡住」）：**推迟到本次事件派发之后再修剪**。
			//
			// 本处理器是在 `onDidChangeWorkspaceFolders` 的**同步派发**里被调用的（异常栈可见
			// `_pruneForeignProjects ← (anonymous) ← _deliver ← fire ← updateWorkspaceAndInitializeConfiguration`），
			// 而修剪要 `deleteProject` 掉**不属于新工作区的全部项目** —— 实测一次切换丢 176836 个节点
			// （`[prune] dropped non-workspace project(s): sarosis-agents-client(176836), ...`），
			// 这轮节点/边/BM25/QN/文件哈希清理**直接把切换 UI 卡住**。
			//
			// 修剪只做两件不影响切换正确性的事：回收内存 + 停掉旧 watcher ⇒ 挪到下一个任务即可。
			// `setTimeout(0)` 会让出当前同步派发 ⇒ 切换本身的「换 folder / 刷新 sideview / 重算配置」
			// 先跑完，用户先看到界面切过去，而不是先卡住。
			//
			// ⚠ 仍遗留：单次 `deleteProject`（17.6 万节点）本身是同步重活，只是被挪到了切换之后。
			//    彻底解法要让 store 的删除分片让出主线程（独立项）。
			setTimeout(() => this._pruneForeignProjects('workspace folders changed'), 0);
		}));
	}

	/**
	 * Phase 2 接线：经主进程代理的 SQLite 后端。
	 * 当前仅用于「文件哈希双写 + 作为后续读路径切换的落点」，默认不启用，避免改变 live 行为。
	 * 启用：`"saros.codebaseGraph.sqliteBackend": true`（实验性，根治 V8 4GB 的开关之一）。
	 */
	private readonly _sqliteBackend: ICodebaseGraphSqliteBackend;

	/**
	 * ★ 2026-09-19（P2-1 Step 3）：渲染侧持有的**索引通道**（直连索引 utility process，方案 B ✓）。
	 * 惰性建进程 ⇒ 构造它本身零成本；真正起 worker 的是第一次方法调用（当前只有构造期的探活 ✓）。
	 */
	private readonly _indexChannel: ICodebaseGraphIndexChannel;

	/**
	 * 索引 worker 句柄的归属（窗口销毁时随之终止 ✓）。
	 * 用 `DisposableStore` 而不是直接 `_register(worker)`：worker 是**惰性**创建的，
	 * 外部无法在构造期拿到它 ⇒ 只能把「容器」交出去，由代理在创建后往里塞 ✓。
	 */
	private readonly _indexWorkerDisposables: DisposableStore;

	/**
	 * 主进程 SQLite 后端是否启用：**默认开启**。
	 * 仅显式设置 `saros.codebaseGraph.sqliteBackend=false` 才会关闭；
	 * 未配置或显式 true 均启用（搜索/查询走 FTS5 索引，避免内存全量扫描）。
	 */
	private get _sqliteBackendEnabled(): boolean {
		return this._configurationService.getValue<boolean | undefined>('saros.codebaseGraph.sqliteBackend') !== false;
	}

	/**
	 * 已确认「sqlite 库为空」的 project 集合（2026-08-20）。
	 * 图从 gzip artifact 加载但本会话未做 sqlite 同步时，sqlite 恒为空；命中一次后
	 * 记入本集合，searchGraphAsync 后续直接走内存图，省掉每次查询的无效 IPC 往返。
	 * _syncGraphToSqlite / _syncIncrementalToSqlite 成功后清除对应标记。
	 */
	private readonly _sqliteEmptyProjects = new Set<string>();

	/** 把内存 store 的文件哈希同步到主进程 SQLite（fire-and-forget，失败静默）。 */
	private _syncFileHashToSqlite(project: string, relPath: string, sha256: string, mtimeNs: number, size: number): void {
		if (!this._sqliteBackendEnabled) { return; }
		this._sqliteBackend.setFileHash(`${project}:${relPath}`, { project, relPath, sha256, mtimeNs, size })
			.catch(err => this._logService.warn('[CodebaseGraph]', 'sqlite fileHash sync failed:', err));
	}

	/**
	 * ★★★ 2026-09-19：**SQLite 追平的唯一「后台」入口**（带「同步中」守卫 + 冷却）。
	 * 真正干活的是 `_catchUpSqlite`（**先增量 → 仍落后才退回全量** ✓）；本方法只管
	 * 「何时跑 / 同一项目同时只跑一个 / 失败后多久才允许再试」。
	 *
	 * 为什么要它（实测）：`_syncGraphToSqlite` 全量同步 **82s**（180115 节点 + 522085 边，
	 * 走 IPC + FTS 逐批插入）。它此前有两个触发点 —— 载入路径（`await` ✗ 把启动卡到 **91.6s**）
	 * 与查询期 `_ensureSqliteFreshness`（fire-and-forget，但**没有守卫**）：
	 *   · 载入路径 **绝不能 await** —— 载入只需要内存 store（已就绪 ✓），DB 是**查询侧**的东西；
	 *   · 无守卫 ⇒ 两条链路可**并发**对同一项目做 `deleteProject + 批量插入` ⇒ 互相覆盖 ✗✗
	 *     （且与 `_runIncrementalIndex` 的增量补丁并发时同样有覆盖风险 ✗）。
	 *
	 * 语义：同一 project **同时只跑一个**；距上次尝试不足 `FULL_SYNC_MIN_INTERVAL_MS` 则跳过（冷却）；
	 * 起止/失败**都打日志**（不静默 ✗），失败保留给下一次触发重试（自愈 ✓）。
	 * ⚠ 失败的代价被冷却限制为「最坏每 5 分钟一次」——这是刻意的：宁可慢追平，也不要 82s 反复卡 ✗。
	 */
	private _scheduleSqliteCatchUp(project: string, reason: string): void {
		if (!this._sqliteBackendEnabled) { return; }
		if (this._sqliteCatchUpInFlight.has(project)) {
			this._logService.info('[CodebaseGraph]', `[sqlite-sync] "${project}" 已有追平任务在跑 ⇒ 本次跳过（触发原因：${reason}）`);
			return;
		}
		const since = Date.now() - (this._sqliteCatchUpLastAttemptAt.get(project) ?? 0);
		if (since < FULL_SYNC_MIN_INTERVAL_MS) {
			this._logService.info('[CodebaseGraph]', `[sqlite-sync] "${project}" 距上次尝试仅 ${Math.round(since / 1000)}s（冷却 ${FULL_SYNC_MIN_INTERVAL_MS / 1000}s）⇒ 本次跳过（触发原因：${reason}）`);
			return;
		}
		this._sqliteCatchUpLastAttemptAt.set(project, Date.now());
		this._sqliteCatchUpInFlight.add(project);
		const t0 = Date.now();
		this._logService.info('[CodebaseGraph]', `[sqlite-sync] 开始**后台**追平 "${project}"（原因：${reason}）—— 先试增量、仍落后才全量；不阻塞载入 ✓`);
		void this._catchUpSqlite(project).then(how => {
			this._logService.info('[CodebaseGraph]', `[sqlite-sync] 后台追平完成 "${project}"（方式=${how}，${Math.round((Date.now() - t0) / 1000)}s）`);
		}).catch((err: any) => {
			this._logService.warn('[CodebaseGraph]', `[sqlite-sync] 后台追平失败 "${project}"（${Math.round((Date.now() - t0) / 1000)}s；下次载入/查询会重试）：${err?.message || err}`);
		}).finally(() => {
			this._sqliteCatchUpInFlight.delete(project);
		});
	}

	/**
	 * ★★★ 2026-09-19（**两步式追平**）：先增量（秒级），仅当增量不适用 / 仍落后才退回全量（实测 **128s** ✗）。
	 *
	 * ① 增量：内存节点 id **单调递增**，而全量同步是**按内存 id 显式写入**的
	 *    （正确性前提见 `_syncIncrementalToSqlite` 头部 ✓）⇒ **DB 缺的节点 = 内存里 id > DB 的 max 那批** ✓
	 *    ⇒ 只需一次标量查询（`getMaxNodeId`）+ 按文件走既有补丁路径，**不必** `deleteProject` + 重插整项目 ✓✓。
	 * ② 复核：增量补完**必须再数一次** —— 缺的也可能是 id ≤ max 的（补丁删了却没能插上 ✗），
	 *    只有仍落后（超容差）才退回全量 ✓（两步式，别只信一步）。
	 * ③ 保护：漂移文件占比 > 20% 时**直接走全量**（按文件逐个补已不比整体重插划算 ✗）。
	 */
	private async _catchUpSqlite(project: string): Promise<'incremental' | 'full'> {
		const expected = this._graph.store.getNodeCount(project);
		try {
			const maxId = await this._sqliteBackend.getMaxNodeId(project);
			if (maxId > 0) {
				// 单趟遍历同时收集两类信息：① id > maxId 的缺失节点及其文件 ② 本项目全部文件（做分母）
				const missingFiles = new Set<string>();
				const allFiles = new Set<string>();
				let missingNodes = 0;
				for (const n of this._graph.store.getAllNodes()) {
					if (n.project !== project) { continue; }
					if (n.filePath) { allFiles.add(n.filePath); }
					if (typeof n.id === 'number' && n.id > maxId) {
						missingNodes++;
						if (n.filePath) { missingFiles.add(n.filePath); }
					}
				}
				const share = allFiles.size > 0 ? missingFiles.size / allFiles.size : 1;
				if (missingNodes > 0 && missingFiles.size > 0 && share <= 0.2) {
					this._logService.info('[CodebaseGraph]', `[sqlite-sync] 增量追平 "${project}"：maxId=${maxId}，缺 ${missingNodes} 节点 / ${missingFiles.size} 文件（占 ${(share * 100).toFixed(1)}%）⇒ 走按文件补丁`);
					await this._syncIncrementalToSqlite(project, [...missingFiles]);
					const after = await this._sqliteBackend.getNodeCount(project);
					// 容差与载入判据同口径（并发增量索引可能又插了新的 ⇒ 不必要求严格相等 ✓）
					const tol = Math.max(2000, Math.floor(expected * 0.02));
					if (after + tol >= expected) {
						return 'incremental';
					}
					this._logService.info('[CodebaseGraph]', `[sqlite-sync] 增量追平后仍落后 "${project}"（sqlite=${after} < 期望 ${expected}，超容差 ${tol}）⇒ 退回全量 ✗`);
				} else {
					this._logService.info('[CodebaseGraph]', `[sqlite-sync] 增量追平不适用 "${project}"（缺 ${missingNodes} 节点 / ${missingFiles.size} 文件，占 ${(share * 100).toFixed(1)}% > 20% 或无可补文件）⇒ 直接全量 ✗`);
				}
			} else {
				this._logService.info('[CodebaseGraph]', `[sqlite-sync] "${project}" 在 SQLite 里无该项目节点（maxId=0）⇒ 走全量（首次同步）`);
			}
		} catch (err: any) {
			this._logService.warn('[CodebaseGraph]', `[sqlite-sync] 增量追平失败（退回全量）"${project}"：${err?.message || err}`);
		}
		// 全局串行：显式事务一次只能一个（详见 `_sqliteSyncChain` 注释）
		await this._runSerializedSqliteSync(() => this._syncGraphToSqlite(project));
		return 'full';
	}

	/** 追平任务「同步中」守卫（按项目）—— 见 `_scheduleSqliteCatchUp` ✓。 */
	private readonly _sqliteCatchUpInFlight = new Set<string>();
	/** 上次**尝试**追平的时刻（按项目）—— 冷却用，见 `FULL_SYNC_MIN_INTERVAL_MS` ✓。 */
	private readonly _sqliteCatchUpLastAttemptAt = new Map<string, number>();

	/**
	 * ★ 2026-09-20（多根工作区竞态）：SQLite 的**显式事务是整个 DB 一把**
	 * （`node/codebaseGraphSqliteStore.ts` 的 `_explicitTx`），而调用方是**按项目**调度的
	 * ——`_sqliteCatchUpInFlight` 只挡「同一项目」并发 ⇒ 两个不同项目同时全量同步时，
	 * 后到的 `beginProjectSync` 必撞「已有进行中的显式事务（不得嵌套 ✗）」而整体失败，
	 * 表现为 WARN `后台追平失败`（实测：工作区含第二个小项目时，它的追平常与主仓
	 * 数十秒的全量同步重叠，1s 就失败，然后吃 5 分钟冷却）。
	 *
	 * 修法：**调用侧全局串行**（排队），而不是放宽 store 的嵌套断言 ——
	 * 真正的嵌套仍然是 bug，断言要留着才能暴露 ✓。
	 */
	private _sqliteSyncChain: Promise<void> = Promise.resolve();

	/** 把一次「会用显式事务」的同步排进全局串行链（前一棒失败也要继续，不打断链 ✓）。 */
	private _runSerializedSqliteSync<T>(fn: () => Promise<T>): Promise<T> {
		const run = this._sqliteSyncChain.then(fn, fn);
		this._sqliteSyncChain = run.then(() => undefined, () => undefined);
		return run;
	}

	/**
	 * Phase 2b 核心：将内存 store 的完整图数据批量复制到主进程 SQLite。
	 * 在 indexWorkspace 末尾调用（当 `saros.codebaseGraph.sqliteBackend` 启用时）；
	 * 也可传 projectOverride 同步指定项目（如 gzip 加载的 UE5EA）。
	 *
	 * 使用与内存 store 相同的 numeric id，确保边引用一致。
	 * 采用分批 + progress fire 以避免大图时长时间阻塞 UI。
	 */
	async _syncGraphToSqlite(projectOverride?: string): Promise<void> {
		if (!this._sqliteBackendEnabled) { return; }
		const store = this._graph.store;
		const project = projectOverride ?? this._projectName;
		const nodes = store.getAllNodes().filter(n => n.project === project);
		// 只同步本项目边（旧实现同步全项目边：2.8M 全量重插且 upsertEdge 无 id 冲突可撞
		// → 每次同步重复累积，边表无限膨胀）
		const edges = store.getAllEdges().filter(e => e.project === project);

		if (nodes.length === 0) { return; }

		// ★★★ 2026-09-20（真机 P0）：**(project, qualified_name) 去重 —— 否则整批 abort** ✗✗
		//
		// 真机证据（用户日志 2026-09-20）：全量同步跑 **84s** 后抛
		// `SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: nodes.project, nodes.qualified_name`
		// ⇒ `upsertNodesBatch` 整批回滚 ⇒ DB **永远落后**，且「下次载入/查询会重试」⇒ **每窗白付 84s** ✗✗✗。
		// 根因：DB 侧 `UNIQUE(project, qualified_name)`，而内存里存在**同 (project, qualified_name)
		// 但不同 id** 的节点（重解析泄漏 / 同名符号 ✗）；显式 id 的 upsert 只处理 `ON CONFLICT(id)`
		// ⇒ 撞 qualified_name 时无解 ✗（SQLite 一条 INSERT 只能有一个冲突目标）。
		//
		// 手法：**保留 id 最大（最新）的那条**（与 store 侧兜底同语义 ✓ —— 重解析泄漏时旧的那条是陈旧的 ✗），
		// 并把被丢掉节点的 id **重映射**到幸存者（否则那些边会指向不存在的行 ⇒ 悬空边 ✗✗）。
		// 顺带打点：`重复数 > 0` 就是「内存里存在重复」的硬证据 ⇒ 值得追重解析泄漏 ✓。
		const byQualifiedName = new Map<string, (typeof nodes)[number]>();
		/** 被去重丢掉的节点 id → 幸存节点 id（供边重映射 ✓）。 */
		const remapDroppedNodeId = new Map<number, number>();
		let duplicateNodes = 0;
		for (const n of nodes) {
			const key = `${n.project} ${n.qualifiedName ?? ''}`;
			const prev = byQualifiedName.get(key);
			if (!prev) { byQualifiedName.set(key, n); continue; }
			duplicateNodes++;
			const prevId = typeof prev.id === 'number' ? prev.id : -1;
			const curId = typeof n.id === 'number' ? n.id : -1;
			if (curId > prevId) {
				byQualifiedName.set(key, n);
				if (prevId >= 0 && curId >= 0) { remapDroppedNodeId.set(prevId, curId); }
			} else if (prevId >= 0 && curId >= 0) { remapDroppedNodeId.set(curId, prevId); }
		}
		const syncNodes = duplicateNodes > 0 ? [...byQualifiedName.values()] : nodes;
		if (duplicateNodes > 0) {
			this._logService.warn('[CodebaseGraph]', `[sqlite-sync] "${project}" 内存里有 ${duplicateNodes} 个重复 (project, qualified_name) 节点`
				+ `（181k 中）⇒ 已按「保留最新 id」去重 + 边重映射，避免撞 UNIQUE 使整批 abort（84s 白跑 ✗）；`
				+ `若该数持续增长 ⇒ 查重解析是否漏删旧节点 ✗`);
		}

		// ★★★ 2026-09-19（P0-1）：全量同步**原子化** —— 包进**跨 IPC 显式事务**（begin→…→commit；错 ⇒ abort）。
		// ⇒ 崩在中间 = **DB 原样** ✓✓（此前逐批各自 COMMIT ⇒ 崩在 delete 与 insert 之间 ⇒ 项目残缺 ✗）。
		// ⚠ 事务存续期其它写入（如并发增量补丁）会**加入**本事务 ✗ —— 最坏随 abort 回滚（落后由追平补 ✓），
		//   不结构性损坏 ✓（机制与风险见 `node/codebaseGraphSqliteStore.ts` 的显式事务头注 ✓）。
		// ⚠ 事务里**不做 checkpoint**（WAL checkpoint 在打开的写事务里被拒 ✗）⇒ 改到 commit 之后 ✓。
		await this._sqliteBackend.beginProjectSync(project);
		let __committed = false;
		try {
			// 幂等同步：内存 id 空间是会话级序号，跨会话重插会撞 UNIQUE(project, qualified_name)
			// （旧 id 空间残留，upsert 冲突目标仅 id 主键）——先按项目清除旧数据再写入。
			// keepFileHashes：保留增量索引哈希，否则下次启动全量重解析。
			// ⚠（P0-1 缩进说明：本 try 块内部**未重排缩进**，以把原子化 diff 控在最小 ✓ —— 勿据此推断层级 ✗）
			await this._sqliteBackend.deleteProject(project, { keepFileHashes: true });

		const BATCH = 5000;
		const tStart = Date.now();

		// ── 节点 ──（用**去重后**的 syncNodes ✓）
		for (let i = 0; i < syncNodes.length; i += BATCH) {
			const chunk = syncNodes.slice(i, i + BATCH);
			// 将内存 store 的 StoreNode 转换为 GraphNode 格式，带上 numeric id
			const graphNodes = chunk.map(n => ({
				id: String(n.id),
				name: n.name,
				type: n.label || n.type || '',
				label: n.label,
				qualifiedName: n.qualifiedName,
				filePath: n.filePath,
				startLine: n.startLine,
				endLine: n.endLine,
				inDegree: n.inDegree,
				outDegree: n.outDegree,
				project: n.project,
				properties: n.properties,
			}));
			await this._sqliteBackend.upsertNodesBatch(graphNodes);
			if ((i + BATCH) % 50000 === 0 || i + BATCH >= syncNodes.length) {
				const done = Math.min(i + BATCH, syncNodes.length);
				this._logService.info('[CodebaseGraph]', `SQLite sync nodes: ${done}/${syncNodes.length}`);
				this._onDidIndexProgress.fire(`💾 同步 SQLite: ${done}/${nodes.length} 节点...`);
			}
			// 分批 checkpoint：防止 WAL 膨胀到数百 MB（读查询需合并 WAL 会显著变慢）
			if ((i + BATCH) % 200000 === 0 || i + BATCH >= nodes.length) {
				await this._sqliteBackend.checkpoint();
			}
			// yield to UI
			if (i % 20000 === 0 && i > 0) {
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
		}

		// ── 边 ──
		for (let i = 0; i < edges.length; i += BATCH) {
			const chunk = edges.slice(i, i + BATCH);
			const edgePayloads = chunk.map(e => {
				// ★ 2026-09-20：端点若因去重被丢掉 ⇒ 重映射到幸存节点（否则边指向不存在的行 ⇒ 悬空 ✗）
				const sid = (typeof e.sourceId === 'number' ? remapDroppedNodeId.get(e.sourceId) : undefined) ?? e.sourceId;
				const tid = (typeof e.targetId === 'number' ? remapDroppedNodeId.get(e.targetId) : undefined) ?? e.targetId;
				return {
					source: String(sid),
					target: String(tid),
					type: e.type,
					sourceId: sid,
					targetId: tid,
					properties: e.properties,
				};
			});
			await this._sqliteBackend.upsertEdgesBatch(edgePayloads);
			if ((i + BATCH) % 50000 === 0 || i + BATCH >= edges.length) {
				const done = Math.min(i + BATCH, edges.length);
				this._logService.info('[CodebaseGraph]', `SQLite sync edges: ${done}/${edges.length}`);
				this._onDidIndexProgress.fire(`💾 同步 SQLite: ${done}/${edges.length} 边...`);
			}
			if (i % 20000 === 0 && i > 0) {
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
		}

		// ★★★ 2026-09-18（P0 性能）：**删除这里的全量 FTS5 重建** —— 经查证它是**纯重复劳动**。
		//
		// 旧实现在此处调 `rebuildFTS()`（`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`），
		// 语义 = 「把整个 nodes 表重读一遍 + 重建整棵倒排索引」。但：
		//   ① 上面的 `upsertNodesBatch`（service:1097）→ `upsertNode` **逐节点**已写好 FTS
		//      （`_upsertFTS`，见 node/codebaseGraphSqliteStore.ts:433 / 448-469）；
		//   ② 本方法开头 `deleteProject`（:1074）也已清掉本项目的 FTS 行
		//      （store:566，且在删 nodes:569 **之前**，满足 external content 的删除语义）；
		// ⇒ 这里重建出来的索引与「什么都不做」**逐条相同**，代价却是整库重索引 ✗✗
		//   （大仓上正是同步收尾最贵的一段；同 BM25 那次一样属"重复劳动"型浪费）。
		//
		// 一致性依据（勿绕过）：批量写必走 `upsertNode` ⇒ 必调 `_upsertFTS`；
		// `_upsertFTS` 失败会先 DELETE+INSERT 重试、再失败即抛（不静默缺行）。
		// `rebuildFTS()` 仍保留，供整库修复/手工导入等场景显式调用。
		// ⚠ 将来若出现「批量写 nodes 但不走 upsertNode」的新路径，必须回来重新评估此处。
		// 重建后 WAL checkpoint（TRUNCATE）压缩 WAL——否则大同步后 WAL 达数百 MB，读查询要合并 WAL 显著变慢
		await this._sqliteBackend.checkpoint();

		const dur = Date.now() - tStart;
		this._logService.info('[CodebaseGraph]', `SQLite sync done: ${nodes.length} nodes + ${edges.length} edges in ${dur}ms`);
		// sqlite 已填充 → 清除「空库」标记，让 searchGraphAsync 恢复走 FTS5 快路径。
		this._sqliteEmptyProjects.delete(project);

			await this._sqliteBackend.commitProjectSync(project);
			__committed = true;
		} finally {
			if (__committed) {
				// ★ 提交后才 checkpoint：WAL checkpoint 在打开的写事务里会被拒（SQLITE_BUSY ✗）。
				await this._sqliteBackend.checkpoint();
			} else {
				// 异常路径 ⇒ 回滚（不掩盖原始错误 ✓）；幂等 ✓。
				try { await this._sqliteBackend.abortProjectSync(project); } catch { /* ignore */ }
			}
		}

		// 注意：SQLite 默认开启后【不】自动释放内存 store——
		// GotoImpl/ListMethods 等同步路径依赖 hasGraphData()/searchGraph() 的内存数据，
		// 释放会让这些入口失效（图谱"消失"）。SQLite 仅作为异步加速读路径 + FTS5 搜索，
		// 内存 store 保留供同步查询与回退兜底（V8 堆压力留给未来 async 读路径改造解决）。
	}

	/**
	 * Phase 2b 增量补丁：仅把变更文件同步到主进程 SQLite（不触发全量 deleteProject+upsert+rebuildFTS）。
	 *
	 * 正确性前提：全量同步（_syncGraphToSqlite）用内存 numeric id 显式写入，故内存 id 与 sqlite id 一致；
	 * 增量重解析给变更文件分配的新 id 单调递增（一定大于 sqlite 现存最大 id），deleteNodesByFile
	 * 清掉旧节点后，显式 id upsert 无冲突，边引用（sourceId/targetId 用内存 id）保持有效。
	 * 失败仅让 sqlite 落后于内存（搜索回退内存兜底），不影响增量索引本身。
	 */
	private async _syncIncrementalToSqlite(project: string, changedRels: string[]): Promise<void> {
		if (!this._sqliteBackendEnabled || changedRels.length === 0) { return; }
		const store = this._graph.store;
		const tStart = Date.now();
		try {
			// 1. 删除变更文件的旧节点/边/FTS（sqlite 侧，含其他文件指向变更节点的边）
			for (const rel of changedRels) {
				await this._sqliteBackend.deleteNodesByFile(project, rel);
			}
			// 2. 收集变更文件的内存节点（显式 id = 内存 id，与 sqlite id 保持一致）
			const nodes: GraphNode[] = [];
			const changedNodeIds = new Set<number>();
			// ★★ 2026-09-18 性能修复（**2026-09-19 重放** —— 本文件今日被并行会话覆盖过一次 ✗）：
			// **按文件索引取节点**，不再全图遍历 ✗✗
			// 旧实现 `for (const n of store.getAllNodes())` + `changedSet.has(n.filePath)`
			// ⇒ 每轮增量都要**扫完整张图**（真机 181,014 节点 ✗），成本 ∝ **图规模**、
			// 与「这次改了几个文件」无关 ✗ —— 这正是该段耗时剧烈波动的原因：
			//   · 1 个文件 → 197 / 250ms；3 个文件 → 503ms；同一轮 551 节点 → **1622ms** ✗
			// 改用 `findNodesByFile(project, rel)`（走 `_nodesByFile` 索引 ⇒ O(该文件节点数) ✓）。
			// 语义等价（同 project + 同 filePath ⇒ 同一批节点 ✓）；⚠ `new Set()` 不能省 ✗：
			// 调用方传的是 `[...deleted, ...modified, ...added]`（可能同路径重复 ✓），
			// 旧实现的 `changedSet` 顺带去重 ✓，直接遍历会让同一节点 push 多次（日志与批量翻倍 ✗）
			for (const rel of new Set(changedRels)) {
				for (const n of store.findNodesByFile(project, rel)) {
					nodes.push({
						id: String(n.id),
						name: n.name,
						type: n.type ?? n.label,
						label: n.label,
						filePath: n.filePath,
						qualifiedName: n.qualifiedName,
						inDegree: n.inDegree,
						outDegree: n.outDegree,
						startLine: n.startLine,
						endLine: n.endLine,
						project: n.project,
						properties: n.properties,
					});
					if (typeof n.id === 'number') { changedNodeIds.add(n.id); }
				}
			}
			await this._sqliteBackend.upsertNodesBatch(nodes as (GraphNode & { id?: string | number })[]);
			// 3. 收集涉及变更文件节点的边（源或目标 ∈ 变更节点），用内存 id 引用，去重后批量 upsert
			const edgeMap = new Map<string, { sourceId: number; targetId: number; type: string; properties?: Record<string, any> }>();
			for (const nid of changedNodeIds) {
				for (const e of store.getEdgesBySource(nid)) {
					if (e.sourceId == null || e.targetId == null) { continue; }
					edgeMap.set(`${e.sourceId}:${e.targetId}:${e.type}`, { sourceId: e.sourceId, targetId: e.targetId, type: e.type, properties: e.properties });
				}
				for (const e of store.getEdgesByTarget(nid)) {
					if (e.sourceId == null || e.targetId == null) { continue; }
					edgeMap.set(`${e.sourceId}:${e.targetId}:${e.type}`, { sourceId: e.sourceId, targetId: e.targetId, type: e.type, properties: e.properties });
				}
			}
			const edges = [...edgeMap.values()];
			await this._sqliteBackend.upsertEdgesBatch(edges as (GraphEdge & { sourceId?: number; targetId?: number })[]);
			const dur = Date.now() - tStart;
			this._logService.info('[CodebaseGraph]', `SQLite incremental patch done: ${nodes.length} nodes + ${edges.length} edges (${changedRels.length} files, ${dur}ms)`);
			// 增量补丁**写入成功**即清除「空库」标记（见 _sqliteEmptyProjects）。
			// Bug（2026-09-09）：旧实现只在 `nodes.length > 0` 时清除——若本轮变更没有
			// 新节点（仅删除文件 / 改动文件解析失败），标记会**永久残留**，此后即使
			// SQLite 已可用也一直走内存路径（慢且可能与 SQLite 不一致）。
			this._sqliteEmptyProjects.delete(project);
		} catch (err) {
			this._logService.warn('[CodebaseGraph]', 'SQLite incremental patch failed (sqlite may lag until next full sync):', err);
		}
	}

	/**
	 * ★★★ 2026-09-18（P1-1 步骤3）：从 **SQLite 快照制品**载入（供「队友共享制品 / 新机器冷启动」用）。
	 *
	 * 与既有 JSON 制品路径的区别：**完全不解析 JSON** —— 由主进程按路径开一个**只读**实例，
	 * 按 keyset 分页把节点/边送过来（分页 + 8ms 切片 + 进度上报全复用 `_loadGraphFromSqlite`）✓。
	 * 载入收尾释放只读实例（`closeSnapshot`），避免长期占 fd / 页缓存。
	 *
	 * ⚠ 不改变「谁权威」：这只是一种**载入来源**，内存 store 的语义与其它路径一致 ✓；
	 *   缓存库与本机 SQLite 的关系、漂移自愈等均由既有机制负责，本方法不参与 ✓。
	 */
	async loadSnapshotArtifact(dbPath: string): Promise<boolean> {
		try {
			return await this._loadGraphFromSqlite({ snapshotDbPath: dbPath });
		} finally {
			try { await this._sqliteBackend.closeSnapshot(dbPath); } catch { /* 未打开过则无需关闭 */ }
		}
	}

	/**
	 * 注意：历史上有"同步后自动释放内存 store（_freeInMemoryStore）"以腾出 V8 堆。
	 * SQLite 默认开启后【不】自动释放——GotoImpl/ListMethods 等同步路径依赖
	 * hasGraphData()/searchGraph() 的内存数据，释放会让图谱在这些入口"消失"。
	 * 需要释放内存时，调用方显式 replace GraphStore._store 并清空 _cachedSortedNodes。
	 */

	/**
	 * Phase 2f：当 `_sqliteBackendEnabled` 且内存 store 为空时，从主进程 SQLite 按需
	 * 加载全量节点/边到内存 store。供低频的图计算路径（trace / architecture / semantic / Cypher）
	 * 在 store 被 Phase 2e 释放后恢复工作。
	 *
	 * 仅在使用者显式调用分析工具时触发（ensureGraph），首次加载后 store 保持 populated，
	 * 后续调用不重复加载。交互式读路径（viz/search/node）继续走 async SQLite 重载。
	 */
	private async _loadGraphFromSqlite(opts?: { snapshotDbPath?: string }): Promise<boolean> {
		if (!this._sqliteBackendEnabled) { return false; }
		// ★★★ 2026-09-18（P1-1 步骤3）：**「从哪个 db 载入」参数化** ——
		//   · 不传 `snapshotDbPath`：读**本机缓存库**（原行为，零变化 ✓）；
		//   · 传了：读**只读快照制品**（队友共享 / 新机器冷启动）—— 主进程按路径另开只读实例
		//     （`snapshot*` 那组 IPC，见 host 的 `_snapshotStore`）。
		// 两条路**分页语义完全相同**（同一个 store 类 + 同一套 keyset 游标）⇒ 下面的循环只换 backend ✓
		const snap = opts?.snapshotDbPath;
		const backend = snap
			? {
				listProjects: () => this._sqliteBackend.snapshotListProjects(snap),
				getAllNodes: (p: string, limit: number, offset: number | undefined, afterId: number | undefined) =>
					this._sqliteBackend.snapshotGetAllNodes(snap, p, limit, offset, afterId),
				getAllEdges: (p: string, limit: number, offset: number | undefined, afterId: number | undefined) =>
					this._sqliteBackend.snapshotGetAllEdges(snap, p, limit, offset, afterId),
			}
			: {
				listProjects: () => this._sqliteBackend.listProjects(),
				getAllNodes: (p: string, limit: number, offset: number | undefined, afterId: number | undefined) =>
					this._sqliteBackend.getAllNodes(p, limit, offset, afterId),
				getAllEdges: (p: string, limit: number, offset: number | undefined, afterId: number | undefined) =>
					this._sqliteBackend.getAllEdges(p, limit, offset, afterId),
			};
		const store = this._graph.store;
		// 用「当前工作区项目」而不是 `_projectName`：后者可能被并发 merge 钉在别的工作区上
		// （见 `_resolveActiveProject`），会让下面的空图守卫与节点归属判断全部错位。
		const project = this._resolveActiveProject();

		if (store.getNodeCount(project) > 0) { return true; }

		const tStart = Date.now();
		// 多 folder 支持：加载当前工作区的**全部**项目（不限单项目，使 query_graph /
		// trace_path / get_architecture 等内存工具能跨 folder 工作）。
		// ⚠ 2026-09-15 修：旧实现直接 `listProjects()` **全量**加载 —— 主进程 SQLite 是跨工作区
		// 共享的持久层，里面还留着历史工作区的项目（实测 S1Game 34 万 + UE5EA 78 万），
		// 全灌进内存既污染检索，也是 UI 卡死的根因。现按当前工作区 folder 收敛。
		const allProjects = await backend.listProjects();
		const wsProjects = this._workspaceProjects();
		const projectsToLoad = wsProjects.length > 0
			? allProjects.map(p => p.name).filter(n => wsProjects.includes(n))
			: [project];
		// 2026-09-16：这条重活此前**完全沉默**（只有结束时一条 info 日志）⇒ 用户面对的是
		// 「按了没反应/界面卡住」。现在全程上报，UI 可显示「正在加载…请稍候」。
		this._onDidGraphLoadProgress.fire(`正在从 SQLite 载入图谱（${projectsToLoad.length} 个项目：${projectsToLoad.slice(0, 3).join(', ')}${projectsToLoad.length > 3 ? ' …' : ''}）…`);

		// ── 分页 + 时间切片（2026-09-16）─────────────────────────────────────────
		// 旧实现一次 `getAllNodes(p)` **全量**跨 IPC（几十万对象：主进程 stringify + renderer
		// **同步** parse），随后是一段**无 yield** 的 upsert / insertEdge 长循环 ⇒ 主线程冻结
		// 十几~三十几秒（用户日志实测 13~32s；注意那是**抛错之前**的耗时 —— 所以修掉
		// `push(...)` 的栈溢出并**不等于**不卡）。
		// 现改为 keyset 分页（`id > 游标`，O(n)；`LIMIT/OFFSET` 是 O(offset) 累计）+ 8ms 切片让出。
		store.setDeferBM25(true);
		let maxId = 0;
		let loadedNodes = 0;
		let loadedEdges = 0;
		for (const p of projectsToLoad) {
			let cursor: number | undefined;
			let sliceStart = performance.now();
			for (;;) {
				// ⚠ 绝不要再写 `allNodes.push(...batch)`：单项目节点可达数十万（UE5EA 78 万 /
				// S1Game 34 万 / 本仓 17.6 万），展开成函数实参会直接抛
				// `Maximum call stack size exceeded`（V8 实参上限约 6~12 万）——
				// 这正是 2026-09-16 用户日志 `20260916T102421` 的根因。逐条处理即可，无数量上限。
				const batch = await backend.getAllNodes(p, SQLITE_LOAD_PAGE_SIZE, undefined, cursor);
				if (batch.length === 0) { break; }
				for (const node of batch) {
					const id = Number(node.id);
					if (id > maxId) { maxId = id; }
					// 还原节点（SQLite rowid → 内存 store id，保持一致）
					store.upsertNode({
						id,
						project: node.project || project,
						label: node.label || node.type || '',
						name: node.name,
						qualifiedName: node.qualifiedName || node.name,
						filePath: node.filePath,
						startLine: node.startLine,
						endLine: node.endLine,
						properties: node.properties || {},
					});
					loadedNodes++;
					if ((loadedNodes % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
						await yieldToEventLoop();
						sliceStart = performance.now();
					}
				}
				cursor = Number(batch[batch.length - 1].id);
				if (batch.length < SQLITE_LOAD_PAGE_SIZE) { break; }
				this._onDidGraphLoadProgress.fire(`已载入项目 "${p}"：${loadedNodes} 节点…`);
			}
		}
		if (loadedNodes === 0) { store.setDeferBM25(false); return false; }
		// 更新 _nextNodeId 避免后续自动分配冲突
		(store as any)._nextNodeId = maxId + 1;
		this._onDidGraphLoadProgress.fire(`节点已还原（${loadedNodes} 个），正在载入边…`);

		// 还原边（SQLite source/target 已是整数 id，与节点一致）；多 folder：加载全部项目的边
		for (const p of projectsToLoad) {
			let cursor: number | undefined;
			let sliceStart = performance.now();
			for (;;) {
				const batch = await backend.getAllEdges(p, SQLITE_LOAD_PAGE_SIZE, undefined, cursor);
				if (batch.length === 0) { break; }
				for (const e of batch) {
					store.insertEdge({
						project: p,
						sourceId: Number(e.source),
						targetId: Number(e.target),
						type: e.type,
						properties: e.properties || {},
					});
					loadedEdges++;
					if ((loadedEdges % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
						await yieldToEventLoop();
						sliceStart = performance.now();
					}
				}
				// 游标 = 本页最后一行的 **SQLite 行 id**（只作游标；不能当 store 边 id 传进
				// insertEdge —— 两套编号，见 GraphEdge.id 注释）。缺 id 时无法继续分页 ⇒ 跳出防死循环。
				const lastId = batch[batch.length - 1].id;
				if (lastId === undefined) { break; }
				cursor = Number(lastId);
				if (batch.length < SQLITE_LOAD_PAGE_SIZE) { break; }
				this._onDidGraphLoadProgress.fire(`已载入项目 "${p}"：${loadedEdges} 边…`);
			}
		}
		this._onDidGraphLoadProgress.fire(`边已还原（${loadedEdges} 条），正在重建全文索引…`);

		store.setDeferBM25(false);
		// force=true：加载路径无脏集，增量模式会空转使 BM25 为空
		// ★ 2026-09-18（P0 性能收口）：本方法**只在** `_sqliteBackendEnabled` 时可达（见开头）⇒
		// 检索由 FTS5 提供、内存倒排为纯灾备 ⇒ 不再无条件重建（这条是「按需载入」路径，会被多次
		// 触发，每次都白付 9s 级主线程重建 ✗）。见 `_rebuildBM25OrDefer`。
		await this._rebuildBM25OrDefer(`SQLite 按需载入（${loadedNodes} 节点 / ${loadedEdges} 边）`);

		const dur = Date.now() - tStart;
		// 终态行（前缀常量）：UI 据此清掉「正在加载…」提示并刷新列表（本路径没有独立完成事件）
		this._onDidGraphLoadProgress.fire(`${GRAPH_LOAD_DONE_PREFIX}（${loadedNodes} 节点 / ${loadedEdges} 边，${dur}ms）`);
		this._logService.info('[CodebaseGraph]', `_loadGraphFromSqlite: ${loadedNodes} nodes + ${loadedEdges} edges loaded (${projectsToLoad.length} projects) in ${dur}ms`);
		return true;
	}

	/**
	 * Phase 2f 公开入口：确保内存 store 中有图数据可用。
	 * 当 `_sqliteBackendEnabled` 时从 SQLite 按需加载；否则检查原有内存 store。
	 *
	 * ★★ 2026-09-16：**失败记忆 + 退避**（修「LLM 输出时 app 反复无响应」）。
	 *
	 * ## 为什么必须有
	 *
	 * `_loadGraphFromSqlite()` 是**同步 CPU/内存重活**（几十万节点读入内存 + `rebuildBM25`
	 * 全量重建）。而所有「要用图」的工具（`index_status` / `get_architecture` / `search_graph` /
	 * `delegate_task` 图预检…）都走 `codebaseTools.ensureGraph()`：
	 * ```ts
	 * await whenGraphLoaded();
	 * await ensureDeferredGraphsLoaded(...);          // 取走并清空集合 ⇒ 只会跑一次
	 * if (!hasGraphData()) { if (!await tryLoadFromSqlite()) return false; }   // ← 这里会反复跑
	 * ```
	 * 内存 store 为空时（制品损坏 / 图被 prune / 本次尚未加载），**每次工具调用都会重跑
	 * 一次这份重活**；一旦它失败（实测 `Maximum call stack size exceeded`），下一次调用
	 * 又从头再来 —— 用户日志 `20260916T102421` 实证：`index_status` 在 10:34~10:45 反复
	 * FAILED **13.6s / 16.5s / 25.2s / 29.5s / 30.2s / 32.4s**，期间 renderer 主线程被同步
	 * 阻塞 ⇒ 并发的 `file_read` **全部等满 60s 超时**（9 次），表现就是「LLM 输出过程中
	 * app 短暂无响应」。
	 *
	 * ⚠ 关键事实：**同步**重活**无法**被 `Promise.race(timeout)` / `setTimeout` 抢占 ——
	 * 计时器回调要等 JS 让出主线程才会执行。所以对这条路径，唯一有效的止血手段是
	 * **不要再试**（把损失从"每次调用几十秒"限制为"最多一两次"），而不是加超时。
	 *
	 * 语义：失败达上限 / 处于退避窗口内 ⇒ **快速返回 false**（调用方 `ensureGraph()` 会
	 * 走 `noGraphGuidance()` 给出可执行指引），不再触发重活。成功即清零；
	 * 工作区切换（`_pruneForeignProjects`）也会清零，避免误伤"换个工作区就好了"的场景。
	 */
	async tryLoadFromSqlite(): Promise<boolean> {
		if (!this._sqliteBackendEnabled) {
			return this._graph.nodeCount > 0;
		}
		if (this._sqliteLoadFailures >= CodebaseGraphService.SQLITE_LOAD_MAX_FAILURES) {
			if (!this._sqliteLoadGaveUpLogged) {
				this._sqliteLoadGaveUpLogged = true;
				this._logService.warn('[CodebaseGraph]', `tryLoadFromSqlite: 已放弃本会话的按需加载（连续失败 ${this._sqliteLoadFailures} 次，最后一次: ${this._sqliteLoadLastError ?? 'unknown'}）` +
					'—— 不再重跑数十秒同步重活；切换工作区或重新索引可重置');
			}
			return this._graph.nodeCount > 0;
		}
		if (this._sqliteLoadFailures > 0
			&& Date.now() - this._sqliteLoadLastFailureAt < CodebaseGraphService.SQLITE_LOAD_BACKOFF_MS) {
			return this._graph.nodeCount > 0;
		}

		const t0 = Date.now();
		try {
			const ok = await this._loadGraphFromSqlite();
			if (ok && this._graph.nodeCount > 0) {
				this._sqliteLoadFailures = 0;
				this._sqliteLoadLastError = undefined;
			} else {
				// 「成功但 0 节点」同样要记：否则下一次调用还会再跑一遍同样的空活
				this._noteSqliteLoadFailure(`load returned ${ok ? 'true but 0 nodes' : 'false'}`);
			}
			return ok;
		} catch (err) {
			this._noteSqliteLoadFailure(err);
			// 首次失败**如实抛出**（保留真实错误给调用方与日志，便于定位爆栈点）；
			// 下一次调用会被上面的失败记忆拦成快速返回。
			throw err;
		} finally {
			const dur = Date.now() - t0;
			// 耗时入日志：这条重活此前没有耗时记录，导致"反复卡 30s"只能靠时间戳推断。
			if (dur > 1000) {
				this._logService.warn('[CodebaseGraph]', `tryLoadFromSqlite took ${dur}ms (attempt ${this._sqliteLoadFailures + 1}/${CodebaseGraphService.SQLITE_LOAD_MAX_FAILURES})`);
			}
		}
	}

	private _noteSqliteLoadFailure(err: unknown): void {
		this._sqliteLoadFailures++;
		this._sqliteLoadLastFailureAt = Date.now();
		this._sqliteLoadLastError = err instanceof Error ? err.message : String(err);
		this._logService.warn('[CodebaseGraph]', `tryLoadFromSqlite failed (${this._sqliteLoadFailures}/${CodebaseGraphService.SQLITE_LOAD_MAX_FAILURES}): ${this._sqliteLoadLastError}`);
	}

	/** 见 `tryLoadFromSqlite` 注释：工作区切换时重置失败记忆（新工作区可能是另一份健康的图）。 */
	private _resetSqliteLoadFailures(): void {
		this._sqliteLoadFailures = 0;
		this._sqliteLoadLastError = undefined;
		this._sqliteLoadGaveUpLogged = false;
	}

	tryLockIndex(): boolean {
		if (this._indexLocked) { return false; }
		this._indexLocked = true;
		return true;
	}

	private async _lockIndex(rootPath: string): Promise<() => void> {
		if (this._indexLocked) {
			throw new Error('Index already locked');
		}
		this._indexLocked = true;
		// 跨进程文件锁（多开 --instance / 同 workspace 多窗口）：防止并发写
		// <root>/.codebase-memory/graph.db.zst 导致图谱损坏。获取失败时回滚进程内锁并抛出。
		try {
			return await this._acquireIndexFileLock(rootPath);
		} catch (err) {
			this._indexLocked = false;
			throw err;
		}
	}

	/** 本进程（窗口）的索引锁 token——实例 ID + 随机串，用于释放时归属校验。 */
	private _indexLockToken: string | undefined;
	private _indexLockHeartbeat: ReturnType<typeof setInterval> | undefined;

	// ── P2-2 诊断轨迹（内存趋势）─────────────────────────────────────────────
	/** 内存/诊断轨迹的采样定时器（惰性启动，见 `_ensureMemTrajectorySampler`）。 */
	private _memTrajectoryTimer: ReturnType<typeof setInterval> | undefined;
	/** 上次采样时的堆占用（用于「只在增长足够多时才打印」的判据）。 */
	private _memTrajectoryLastUsed = 0;

	/**
	 * ★★★ 2026-09-19（P2-2 诊断轨迹）：**轻量**周期采样 —— 只打日志，**不新建 NDJSON/文件写入器**。
	 *
	 * 为什么不做成 CBM 的 `trajectory.ndjson`（5s 采样 + 8MB 轮转）：那要引入文件写入 + 轮转 + 路径管理 ✗，
	 * 而本仓**宿主本身就会轮转 `renderer.log`** ⇒ 用日志即可得到等价的趋势源 ✓（把机制成本降到最低）。
	 *
	 * 生命周期：**首次真正使用图谱时惰性启动**（从不用图谱的工作区不起定时器 ✓），`dispose()` 里清理
	 * （照抄 `_indexLockHeartbeat` 的三段式）。
	 * 打印策略：**仅当堆增长 ≥ 32MB 才打一条** —— 否则每 5 分钟一条「没变化」的纯噪音 ✗
	 * （这条教训来自本会话刚修的内存告警：那次也是判据没考虑"本来就这么大"）。
	 */
	private _ensureMemTrajectorySampler(): void {
		if (this._memTrajectoryTimer) { return; }
		this._memTrajectoryLastUsed = this._graphMemoryUsedBytes().usedBytes;
		this._memTrajectoryTimer = setInterval(() => {
			try {
				const { usedBytes, source } = this._graphMemoryUsedBytes();
				const growth = usedBytes - this._memTrajectoryLastUsed;
				if (growth < 32 * 1048576) { return; }   // 波动/噪声不打印，趋势要看「持续爬升」
				this._memTrajectoryLastUsed = usedBytes;
				this._logService.info('[CodebaseGraph]', `[mem-trajectory] 堆 ${(usedBytes / 1048576).toFixed(0)}MB`
					+ `（较上次采样 +${(growth / 1048576).toFixed(0)}MB；来源=${source}）`
					+ `｜nodes=${this._graph.store.getNodeCount()} edges=${this._graph.store.getEdgeCount()}`
					+ `｜预算=${(this._graphMemoryBudgetBytes() / 1048576).toFixed(0)}MB —— 若持续爬升请带此行反馈`);
			} catch { /* 采样失败绝不影响主流程 */ }
		}, 5 * 60 * 1000);
	}

	/**
	 * 获取 `<root>/.codebase-memory/index.lock` 跨进程文件锁。
	 * 新鲜锁属其他实例 → 抛错；锁过期（持有方崩溃）→ 接管；同实例残留锁（进程重启/上次中断）→ 覆盖接管。
	 * 返回释放函数（仅删自己的锁）。
	 */
	private async _acquireIndexFileLock(rootPath: string): Promise<() => void> {
		const lockUri = URI.joinPath(URI.file(rootPath), '.codebase-memory', INDEX_LOCK_FILENAME);
		if (!this._indexLockToken) {
			const instanceId = (this._environmentService as unknown as { instanceId?: string }).instanceId;
			this._indexLockToken = createIndexLockToken(instanceId);
		}
		const token = this._indexLockToken;
		const myInstance = (this._environmentService as unknown as { instanceId?: string }).instanceId ?? 'default';

		// 1. 读现有锁：新鲜且属其他实例 → 拒绝；同实例（token 不同 = 本进程上次中断残留）→ 覆盖接管
		try {
			const existing = await this._fileService.readFile(lockUri);
			const mtime = (await this._fileService.stat(lockUri)).mtime;
			const content = parseIndexLock(existing.value.toString());
			if (content && content.token !== token && !isIndexLockStale(mtime, Date.now())) {
				const lockInstance = content.instanceId ?? 'default';
				if (lockInstance !== myInstance) {
					throw new Error(`索引正被另一进程执行（实例 ${lockInstance}），请稍候`);
				}
				// 同实例残留锁（上次索引被中断/进程重启后 _indexLocked=false）：允许覆盖接管
				this._logService.info('[CodebaseGraph]', `index lock: taking over own residual lock (instance ${lockInstance})`);
			}
		} catch (err) {
			// 文件不存在 → 无锁可继续；其他错误若非"拒绝"语义则视为无锁（宽松获取）
			if (err instanceof Error && err.message.includes('索引正被另一进程执行')) { throw err; }
		}

		// 2. 写入自己的锁 + 启动心跳刷新 mtime
		const writeLock = async () => {
			await this._fileService.writeFile(lockUri, VSBuffer.fromString(serializeIndexLock({
				token,
				instanceId: (this._environmentService as unknown as { instanceId?: string }).instanceId,
				acquiredAt: Date.now(),
			})));
		};
		await this._fileService.createFolder(URI.joinPath(URI.file(rootPath), '.codebase-memory'));
		await writeLock();
		this._indexLockHeartbeat = setInterval(() => { void writeLock().catch(() => { /* 心跳失败忽略 */ }); }, INDEX_LOCK_HEARTBEAT_MS);

		// 3. 释放：停心跳，仅当锁仍属自己才删除
		return () => {
			if (this._indexLockHeartbeat) {
				clearInterval(this._indexLockHeartbeat);
				this._indexLockHeartbeat = undefined;
			}
			void (async () => {
				try {
					const cur = await this._fileService.readFile(lockUri);
					const content = parseIndexLock(cur.value.toString());
					if (content?.token === token) {
						await this._fileService.del(lockUri);
					}
				} catch { /* 锁已被删/被接管，忽略 */ }
			})();
			this._indexLocked = false;
		};
	}

	// ─── Worker Pool: parallel tree-sitter parsing ──────────────────────

	/**
	 * 初始化 Worker 池：读取 tree-sitter.js + WASM 文件，创建 N 个 Worker。
	 * 失败时返回 false，调用方 fallback 到主线程解析。
	 */
	/** 初始化池（委托 CodebaseGraphParserPool；失败返回 false → 调用方 fallback 主线程）。 */
	private async _ensureWorkerPool(): Promise<boolean> {
		// ★★★ 2026-09-18（用户报「C++ 项目检索不到内容」）：**缺 grammar 必须在索引开始前就点名** ——
		// 否则这些语言的源文件注定解析出 0 个符号，而用户只会看到「检索不到内容」：
		// 实测 535 个 .cpp/.h 全部 0 节点、`failed=0`、日志一片绿 ✗（旧实现把这些记成 `indexed`）。
		// 消费 `missingLanguages`（池子在读取 wasm 失败时逐语言记名，见 `CodebaseGraphParserPool`）。
		return this._parserPool.ensure().then(ready => {
			const missing = this._parserPool.missingLanguages;
			if (missing.length > 0) {
				this._logService.warn('[CodebaseGraph]',
					`本次索引缺少 ${missing.length} 个语言的 tree-sitter grammar：${missing.join(', ')}` +
					` —— 这些语言的源文件**本次会解析出 0 个符号**（属构建/打包缺陷，不是「该目录没有代码」）；` +
					`已加载：${this._parserPool.loadedLanguages.join(', ') || 'none'}`);
			}
			return ready;
		});
	}

	/**
	 * 构建 Worker 代码：AMD shim + tree-sitter.js 内联 + AST 遍历逻辑。
	 *
	 * ★ 待拆（P1-5 最后一块，2026-09-09 评估后主动留待完整会话）：
	 *   本方法 ~353 行**字符串内嵌 JS**（无类型检查 / lint / 测试覆盖），加上
	 *   `_ensureWorkerPool` / `_createAndInitWorker` / `_parseViaWorker` 共约 550 行，
	 *   拆到 `codebaseGraphParserPool.ts` 需要一次性完整读取 + 逐字复制，中断会留半成品。
	 *   搬迁要点：① 字符串必须逐字复制（建议搬完用 `new Function(code)` 做一次语法自检）
	 *   ② 打包版依赖「Worker 内 fileService 读 wasm」的路径，**不得**改为独立 worker 文件
	 *   ③ 池实例与 `_parserWorkers` / `_workerUrl` / `_workerTsWasm` / `_workerLangWasms`
	 *      / `_parseReqId` 一并迁移，service 侧保留委托方法。
	 */
	/**
	 * 构建 Worker 代码（AMD shim + tree-sitter.js 内联 + AST 遍历逻辑）。
	 * 实现已迁到 CodebaseGraphWorkerCode（P1-5 收尾，2026-09-09）——该字符串不受 tsgo/lint
	 * 检查，独立成文件后便于后续加语法自检与逐步改造。
	 */
	private _buildWorkerCode(tsJsContent: string): string {
		return buildWorkerCode(tsJsContent);
	}

	/**
	 * 通过 Worker 解析单个文件（带 15 秒超时，防止 tree-sitter 挂起导致死锁）
	 */
	/** 提交一次解析（委托 CodebaseGraphParserPool，含 15s 超时兜底）。 */
	private _parseViaWorker(worker: Worker, id: number, source: string, langName: string, filePath: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; status: FileCoverageStatus; reason?: string }> {
		return this._parserPool.parse(worker, id, source, langName, filePath);
	}

	private _disposeWorkers(): void {
		this._parserPool.dispose();
	}

	// ─── Main Index Method ──────────────────────────────────────────────

	/** 每轮索引的「内存超预算」只告警一次（防刷屏）；见 `_reportGraphMemory`。 */
	private _memBudgetWarned = false;
	/**
	 * 本轮索引**起点**的堆占用（字节）。★ 2026-09-19 修正：判据改用**增量**，
	 * 因为绝对堆占用包含了编辑器/扩展/webview 等与图谱无关的部分 ✗（本机静止即 556MB，
	 * 越过了 512MB 默认档 ⇒ 每轮一开场就误报超预算）。
	 */
	private _memBaselineBytes = 0;
	// ── 解析期内存看门狗状态（每轮索引开始时重置；见 `_parseMemoryWatchdog`）──
	private _parseMemHardAbortFired = false;
	private _parseMemSoftWarned = false;

	/**
	 * ★★★ 2026-09-19（P1-5 内存预算）：图谱内存预算（字节）。
	 *
	 * 对齐 CBM `mem.c:184-247` 的 RAM 分档**思想**（不搬其预算引擎/准入屏障那套复杂度）：
	 * 先看配置，未设则按设备内存分档。配置项是**权威旋钮**（`saros.codebaseGraph.memoryBudgetMb`，
	 * 0 = 自动）—— 因为 renderer 侧只能拿到 `navigator.deviceMemory`（Chromium，粒度粗且封顶 8 ✗）。
	 */
	private _graphMemoryBudgetBytes(): number {
		const cfgMb = this._configurationService.getValue<number>('saros.codebaseGraph.memoryBudgetMb') ?? 0;
		if (cfgMb > 0) { return cfgMb * 1024 * 1024; }
		const devGb = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 0;
		const tierMb = devGb > 0 ? (devGb <= 4 ? 256 : devGb <= 8 ? 512 : 768) : 512;
		return tierMb * 1024 * 1024;
	}

	/**
	 * 现用内存估算。优先 Chromium `performance.memory.usedJSHeapSize`（Electron renderer 可用，
	 * 注意它是**整个 renderer 堆**而非图谱独占 ⇒ 只作量级判据 ✓）；拿不到时退化到规模估算。
	 * ⚠ 两者都**不是精确账**，用途是「超预算即响亮告警」，不是计费 —— 别拿它做精确断言。
	 */
	private _graphMemoryUsedBytes(): { usedBytes: number; source: string } {
		const m = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
		if (m && typeof m.usedJSHeapSize === 'number' && m.usedJSHeapSize > 0) {
			return { usedBytes: m.usedJSHeapSize, source: 'usedJSHeapSize(整个 renderer 堆)' };
		}
		// 退化路径：按规模粗估（口径取自本仓堆快照的量级，仅作参考 ✗ 不精确）
		const nodes = this._graph.store.getNodeCount();
		const edges = this._graph.store.getEdgeCount();
		return { usedBytes: nodes * 200 + edges * 80, source: '规模粗估(节点/边)' };
	}

	/**
	 * **阶段边界**的内存检查（挂进 `_seg`，覆盖增量索引的每个阶段）。
	 *
	 * 契约：**超预算必须响亮告警**（每轮一次，防刷屏）—— 本仓「静默 0 / 静默降级」类事故的共同教训是
	 * 「有问题但没人知道」✗。返回 `已用/上限` 文本供对账行使用（返回文本与是否告警**无关** ✓）。
	 */
	private _reportGraphMemory(stage: string): string {
		// ★ 2026-09-19（P2-2）：惰性启动内存趋势采样 —— 首个用到图谱的阶段即开始（见 `_ensureMemTrajectorySampler`）
		this._ensureMemTrajectorySampler();
		const budget = this._graphMemoryBudgetBytes();
		const { usedBytes, source } = this._graphMemoryUsedBytes();
		// ★★★ 2026-09-19 修正（运行实例实测踩到）：判据必须是**本轮索引内的增量**，不是绝对堆占用。
		// 旧口径拿「整个 renderer 堆」去比「图谱预算」⇒ 本机静止堆已 556MB、越过默认档 512MB，
		// 于是**每轮索引一开场就报超预算**（日志 12:58:16 实测 ✗）＝纯噪音。
		// 现在：基线 = 本轮起始堆；`增长 = 当前 - 基线` ⇒ 这个阈值才代表「本次索引吃掉的」✓。
		// （基线为 0 时只报文本、不判警告 —— 那些调用点没有基线可比，强行比会重演误报 ✗）
		const baseline = this._memBaselineBytes;
		const growthBytes = baseline > 0 ? Math.max(0, usedBytes - baseline) : 0;
		const mb = (n: number): string => (n / 1048576).toFixed(0);
		const text = baseline > 0
			? `本轮+${mb(growthBytes)}MB / 上限${mb(budget)}MB（堆 ${mb(usedBytes)}MB，基线 ${mb(baseline)}MB）`
			: `堆 ${mb(usedBytes)}MB / 上限${mb(budget)}MB（无基线，不判超限）`;
		if (baseline > 0 && growthBytes > budget && !this._memBudgetWarned) {
			this._memBudgetWarned = true;
			this._logService.warn('[CodebaseGraph]', `★ 本轮索引内存增长超预算（${text} @ 阶段「${stage}」，来源=${source}）`
				+ ` ⇒ 索引已进入内存压力区。可重建结构（内存 BM25 / layout）按需重建、不常驻；`
				+ `若要放宽请调 \`saros.codebaseGraph.memoryBudgetMb\`（0=自动按设备分档）✓`);
		}
		return text;
	}

	/**
	 * 解析期内存看门狗（2026-09-21，UE 95k 文件 OOM 实证）。
	 *
	 * 挂在解析循环里按固定文件数调用（全量/增量/主线程兜底三处）。语义：
	 *   · 越过硬上限 ⇒ WARN + 进度提示 + `cts.cancel()` —— 循环各点都认 token ⇒ 本轮解析中止，
	 *     **已解析部分照常走收尾（post-pass/落盘/SQLite 补丁）**：哈希只记已解析文件 ⇒
	 *     下次增量把剩余文件自动补齐（渐进收敛，不再「崩溃留残缺 → 下次又全量」）；
	 *   · 本轮增量超预算 ×1.5 ⇒ WARN 一次，继续跑。
	 * `performance.memory` 不可用（非 Chromium）⇒ 直接跳过（看门狗失效但不阻断）。
	 */
	private _parseMemoryWatchdog(cts: CancellationTokenSource, label: string): void {
		const { usedBytes } = this._graphMemoryUsedBytes();
		if (usedBytes <= 0) { return; }
		const action = resolveParseHeapAction({
			usedBytes,
			baselineBytes: this._memBaselineBytes,
			budgetBytes: this._graphMemoryBudgetBytes(),
			hardLimitBytes: this._parseHardHeapLimitBytes(),
		});
		if (action === 'ok') { return; }
		if (action === 'soft') {
			if (this._parseMemSoftWarned) { return; }
			this._parseMemSoftWarned = true;
			this._logService.warn('[CodebaseGraph]',
				`★ 解析期内存增长超预算 1.5x（+${((usedBytes - this._memBaselineBytes) / 1048576).toFixed(0)}MB `
				+ `/ 预算 ${(this._graphMemoryBudgetBytes() / 1048576).toFixed(0)}MB @ ${label}）—— 继续观察，越硬上限将中止解析`);
			return;
		}
		// abort
		if (this._parseMemHardAbortFired) { return; }
		this._parseMemHardAbortFired = true;
		const usedMb = (usedBytes / 1048576).toFixed(0);
		const hardMb = (this._parseHardHeapLimitBytes() / 1048576).toFixed(0);
		this._logService.warn('[CodebaseGraph]',
			`★ 解析期堆越过硬上限（${usedMb}MB > ${hardMb}MB @ ${label}）⇒ **中止本轮解析**（防 renderer OOM）：`
			+ `已解析部分照常收尾落盘，剩余文件哈希未记 ⇒ 后续增量索引会自动补齐。`
			+ `若需放宽请调 \`saros.codebaseGraph.hardHeapLimitMb\`（0=默认 3072MB）。`);
		this._onDidIndexProgress.fire(`⚠ 内存超限（${usedMb}MB > ${hardMb}MB），已中止解析 —— 已解析部分照常保留，剩余文件将由增量索引逐步补齐`);
		cts.cancel();
	}

	/** 解析期硬堆上限（字节）。`saros.codebaseGraph.hardHeapLimitMb` > 0 时用配置；否则默认 3072MB。 */
	private _parseHardHeapLimitBytes(): number {
		const cfgMb = this._configurationService.getValue<number>('saros.codebaseGraph.hardHeapLimitMb') ?? 0;
		if (cfgMb > 0) { return cfgMb * 1024 * 1024; }
		// Chromium 渲染进程 V8 堆上限 ~4GB；留 ~1GB 给 UI/编辑器/压缩器工作集。
		return 3072 * 1024 * 1024;
	}

	async indexWorkspace(rootPath: string, config: IIndexConfig, token?: CancellationToken): Promise<IIndexResult> {
		// [TRACE] 追踪 indexWorkspace 的所有调用入口，帮助定位"启动时总是自动重新索引"的来源
		try {
			const stack = new Error().stack || '';
			const caller = stack.split('\n').slice(2, 6).map(l => l.trim()).join(' | ');
			this._logService.info('[CodebaseGraph]', `[TRACE] indexWorkspace called: rootPath=${rootPath} project=${config.projectName || this._projectName} caller=${caller}`);
		} catch { /* ignore trace errors */ }
		const cts = new CancellationTokenSource(token);
		const startTime = Date.now();

		// 重置调用边累积器（#9 过程间传播）
		this._pendingCallEdges = [];

		if (this._isIndexing) {
			return { success: false, message: '索引正在进行中，请稍候...', rootPath, kind: 'full' };
		}

		this._isIndexing = true;
		this._indexCts = cts;
		// 解析期内存看门狗状态每轮重置（见 `_parseMemoryWatchdog`）；基线堆供软告警按增量判定
		this._parseMemHardAbortFired = false;
		this._parseMemSoftWarned = false;
		this._memBaselineBytes = this._graphMemoryUsedBytes().usedBytes;

		let releaseLock: () => void;
		try {
			releaseLock = await this._lockIndex(rootPath);
		} catch (lockErr) {
			this._isIndexing = false;
			return { success: false, message: lockErr instanceof Error ? lockErr.message : '索引已被锁定，请稍候...', rootPath, kind: 'full' };
		}

		try {
		this._onDidIndexProgress.fire('▶ 开始索引工作区...');
		// 多 folder：projectName 优先（每 folder 唯一），回退 subPath，再回退 basename，最后 '_default'。
		//
		// 2026-09-15：本轮索引的 project 捕获为**局部常量**，方法体内一律用它（不再读 `this._projectName`）。
		// 原因：`_projectName` 是可变字段，而一轮全量索引要跑数分钟——期间 bootstrap 的
		// `loadGraphMerge`（大图 10~40s）、工作区切换（`_pruneForeignProjects`）或 viewer 的
		// `_autoDetectProjectName` 都可能把它改成别的工作区的项目 ⇒ 本轮的 post-pass / 文件哈希 /
		// 落盘会按错误项目过滤：边被静默丢弃、制品内容错位（`_saveGraph` 的 sanity check 只能事后告警）。
		// 注：helper 方法内部仍读该字段 ⇒ 由 `_setProjectNameUnlessIndexing()` 保证索引期间不被改写。
		const projectName = config.projectName || config.subPath || this._basename(rootPath) || '_default';
		this._projectName = projectName;
		this._rootProjectMap.set(this._normalizeRoot(rootPath), projectName);
		// P0 修复：解析产出的节点/边必须打上真实项目名，否则 post-passes 与按项目保存全部落空
		this._graph.setActiveProject(projectName);
		this._indexCoverage = new Map(); // 重置逐文件覆盖率记录


		// 1. Scan files
		// 全量索引前刷新缓存：用户可能刚改过 .cbmignore / 刚添加 .uproject
		this._excludeResolver.invalidate(rootPath);
		const excludeDirs = await this._excludeResolver.resolve(rootPath, config.excludeDirs);
		// 记录本次全量索引的生效范围，供 watcher/增量索引用同一口径（防幻影变更）
		this._watchScopeCache.set(this._normalizeRoot(rootPath), { excludeDirs, keepDirs: config.keepDirs ? [...config.keepDirs] : undefined });
		this._onDidIndexProgress.fire('📁 扫描文件...');
		const files = await this._scanner.scanFiles(
			rootPath, excludeDirs, config.subPath, cts.token, config.keepDirs,
			msg => this._onDidIndexProgress.fire(msg),
		);
			const filesScanned = files.length;
			this._onDidIndexProgress.fire(`📁 找到 ${filesScanned} 个源文件`);

			if (cts.token.isCancellationRequested) {
				return { success: false, message: '索引已取消', duration: 0, rootPath, kind: 'full' };
			}

		// 2. Parse files
		let nodesExtracted = 0;
		let edgesExtracted = 0;

		// 开启 BM25 延迟模式：解析阶段跳过逐条索引更新，解析完成后一次性重建
		this._graph.store.setDeferBM25(true);

		// 尝试初始化 Worker 池（将 tree-sitter 解析移到独立线程，避免阻塞 UI）
		this._onDidIndexProgress.fire('🔧 初始化并行解析器...');
		const workersReady = await this._ensureWorkerPool();

		if (workersReady && this._parserWorkers.length > 0) {
			// ── Worker 池并行解析：每个 Worker 从共享队列取文件 ──
			this._onDidIndexProgress.fire(`🚀 并行解析 (${this._parserWorkers.length} workers)...`);
			let fileIdx = 0;
			const nextFile = (): number => {
				if (cts.token.isCancellationRequested || fileIdx >= files.length) { return -1; }
				return fileIdx++;
			};

			const workerTask = async (worker: Worker, workerId: number) => {
				// Worker 崩溃时记录日志（不阻止循环继续，但该 worker 的后续请求会超时被跳过）
				worker.onerror = (e: ErrorEvent) => {
					this._logService.warn('[CodebaseGraph]', `Worker ${workerId} crashed: ${e.message || e.error?.message || 'unknown'}`);
				};

				while (true) {
					const idx = nextFile();
					if (idx === -1) { break; }
					// ★ 2026-09-21 内存看门狗：越硬上限即取消本轮（已解析部分照常收尾落盘 ✓）
					if (idx % CodebaseGraphService.PARSE_MEM_CHECK_EVERY === 0) {
						this._parseMemoryWatchdog(cts, `全量并行解析 ${idx}/${filesScanned}`);
					}

			const filePath = files[idx];
			const relPath = this._getRelativePath(filePath);
			const ext = this._getExtension(filePath);
			const langName = EXTENSION_TO_WASM_LANG[ext];
			// 跳过文件也必须记录哈希——否则 watcher 每轮轮询都会把它们报为 "added"，
			// 形成永不收敛的脏集（配合增量→重启 watcher→再触发 的循环，即每 30s 一次空增量）
			if (!langName) { this._recordCoverage(relPath, 'skipped', `unsupported extension .${ext}`); await this._recordFileHash(projectName, relPath, filePath); continue; }

			// 主线程读取文件内容 (async I/O)
			let source: string;
			try {
				const content = await this._fileService.readFile(URI.file(filePath));
				source = content.value.toString();
			} catch { this._recordCoverage(relPath, 'skipped', 'read failed'); await this._recordFileHash(projectName, relPath, filePath); continue; }
				if (source.length > MAX_FILE_SIZE) { this._recordCoverage(relPath, 'skipped', `file too large (${source.length} > ${MAX_FILE_SIZE})`); await this._recordFileHash(projectName, relPath, filePath); continue; }
				// 跳过超长行文件（minified/生成代码会导致 tree-sitter 挂起）
				if (source.indexOf('\n', 0) === -1 && source.length > 50000) { this._recordCoverage(relPath, 'skipped', 'single-line file > 50KB (minified?)'); await this._recordFileHash(projectName, relPath, filePath); continue; } // 单行超 50K
				// 快速检测最长行（只检查前 100 行，避免开销）
				let maxLineLen = 0;
				const lines = source.split('\n');
				const checkLines = Math.min(lines.length, 100);
				for (let li = 0; li < checkLines; li++) { if (lines[li].length > maxLineLen) { maxLineLen = lines[li].length; } }
				// 防护类 skipped（永不可解析）必须记哈希——否则 watcher 每轮重报 added 翻烧饼
				if (maxLineLen > MAX_LINE_LENGTH) { this._recordCoverage(relPath, 'skipped', `line too long (${maxLineLen} > ${MAX_LINE_LENGTH})`); await this._recordFileHash(projectName, relPath, filePath); continue; }

				// 诊断日志：每 500 文件记录当前解析路径，便于定位卡死文件
				if (idx % 500 === 0) {
					this._logService.info('[CodebaseGraph]', `Worker ${workerId}: #${idx}/${filesScanned} ${filePath}`);
				}

				// Worker 线程解析 (不阻塞主线程，15s 超时自动跳过)
			const result = await this._parseViaWorker(worker, idx, source, langName, relPath);

			for (const node of result.nodes) { this._graph.addNode(node); nodesExtracted++; }
			for (const edge of result.edges) {
				// call: 虚拟边暂存，待 _matchCallsToDefinitions 解析为真实 CALLS 边（#9）
				if (edge.target && typeof edge.target === 'string' && edge.target.startsWith('call:')) {
					this._pendingCallEdges.push({ source: edge.source, callee: edge.target.slice(5), loopDepth: edge.properties?.loopDepth ?? 0 });
				} else if (edge.target && typeof edge.target === 'string' && (edge.target.startsWith('inherits:') || edge.target.startsWith('implements:'))) {
					// inherits:/implements: 虚拟边暂存，待 _matchInheritsToDefinitions 解析为真实继承边
					const kind: 'INHERITS' | 'IMPLEMENTS' = edge.target.startsWith('implements:') ? 'IMPLEMENTS' : 'INHERITS';
					this._pendingInheritEdges.push({ source: edge.source, baseName: edge.target.slice(edge.target.indexOf(':') + 1), kind });
				} else if (edge.target && typeof edge.target === 'string' && edge.target.startsWith('usage:')) {
					// usage: 虚拟边暂存，待 _matchUsageEdgesToDefinitions 解析为真实 USAGE 边（带 access 读写）
					const name = edge.target.slice(6);
					const access: 'read' | 'write' = edge.properties?.access === 'write' ? 'write' : 'read';
					this._pendingUsageEdges.push({ source: edge.source, name, access });
				} else {
					this._graph.addEdge(edge);
				}
				edgesExtracted++;
			}

			// 记录逐文件覆盖率（indexed/partial/parse_error/timeout）
			this._recordCoverage(relPath, result.status, result.reason, result.nodes.length);

				// 记录文件哈希（mtime+size），供增量重索引分类使用。
				// parse_error/timeout 不记（重试，见 _recordHashAfterParse）——否则失败固化。
				await this._recordHashAfterParse(projectName, relPath, filePath, result.status);

				if (idx % 50 === 0) {
						const pct = Math.round(idx / filesScanned * 100);
						this._onDidIndexProgress.fire(`🔍 解析中 (${idx}/${filesScanned}) ${pct}% - ${nodesExtracted} 节点, ${edgesExtracted} 边`);
					}
					// 定期 yield 让 UI 刷新
					if (idx > 0 && idx % 50 === 0) {
						await new Promise<void>(resolve => setTimeout(resolve, 0));
					}
				}
			};

			// 启动所有 Worker 并行处理
			await Promise.all(this._parserWorkers.map((w, i) => workerTask(w, i)));
		} else {
			// ── Fallback: 主线程解析 (Worker 不可用时) ──
			this._onDidIndexProgress.fire('🔍 主线程解析中...');
			const YIELD_INTERVAL = 20;
			for (let i = 0; i < files.length; i++) {
				if (cts.token.isCancellationRequested) { break; }
				if (i % 50 === 0) {
					const pct = Math.round(i / filesScanned * 100);
					this._onDidIndexProgress.fire(`🔍 解析中 (${i}/${filesScanned}) ${pct}% - ${nodesExtracted} 节点, ${edgesExtracted} 边`);
					// ★ 2026-09-21 内存看门狗（与并行路径同一道保险丝 ✓）
					this._parseMemoryWatchdog(cts, `主线程解析 ${i}/${filesScanned}`);
				}
				const filePath = files[i];
				const relPath = this._getRelativePath(filePath);
			const result = await this._parseFile(filePath, cts.token);
			for (const node of result.nodes) { this._graph.addNode(node); nodesExtracted++; }
			for (const edge of result.edges) {
				// call: 虚拟边暂存，待 _matchCallsToDefinitions 解析为真实 CALLS 边（#9）
				if (edge.target && typeof edge.target === 'string' && edge.target.startsWith('call:')) {
					this._pendingCallEdges.push({ source: edge.source, callee: edge.target.slice(5), loopDepth: edge.properties?.loopDepth ?? 0 });
				} else if (edge.target && typeof edge.target === 'string' && (edge.target.startsWith('inherits:') || edge.target.startsWith('implements:'))) {
					// inherits:/implements: 虚拟边暂存，待 _matchInheritsToDefinitions 解析为真实继承边
					const kind: 'INHERITS' | 'IMPLEMENTS' = edge.target.startsWith('implements:') ? 'IMPLEMENTS' : 'INHERITS';
					this._pendingInheritEdges.push({ source: edge.source, baseName: edge.target.slice(edge.target.indexOf(':') + 1), kind });
				} else if (edge.target && typeof edge.target === 'string' && edge.target.startsWith('usage:')) {
					// usage: 虚拟边暂存，待 _matchUsageEdgesToDefinitions 解析为真实 USAGE 边（带 access 读写）
					const name = edge.target.slice(6);
					const access: 'read' | 'write' = edge.properties?.access === 'write' ? 'write' : 'read';
					this._pendingUsageEdges.push({ source: edge.source, name, access });
				} else {
					this._graph.addEdge(edge);
				}
				edgesExtracted++;
			}
			// 记录逐文件覆盖率（indexed/partial/parse_error/timeout/skipped）
			this._recordCoverage(relPath, result.status, result.reason, result.nodes.length);
			// 记录文件哈希（mtime+size），供增量重索引分类使用。parse_error/timeout 不记（重试）。
			await this._recordHashAfterParse(projectName, relPath, filePath, result.status);
			if (i > 0 && i % YIELD_INTERVAL === 0) {
					await new Promise<void>(resolve => setTimeout(resolve, 0));
				}
			}
		}

		// 解析完成，释放 Worker 池
		this._disposeWorkers();

		// 批量重建 BM25 索引
		this._graph.store.setDeferBM25(false);
		// 时间切片重建（async，内部每 1000 节点 yield，避免大图冻结 UI）。
		// force=true：全量索引是整图从零构建，按全图口径重建（进度分母也才是全图节点数）
		// ★ 2026-09-18（P0 性能收口）：检索走 FTS5 时**不建**内存倒排 —— 否则每次全量索引
		// 都要在主线程白付一次 9s 级重建（进度条也会显示一段用户并不需要的等待）。见 `_rebuildBM25OrDefer`。
		await this._rebuildBM25OrDefer(`全量索引收尾（${nodesExtracted} 节点）`, (done, total) => {
			if (done % 50000 === 0 || done === total) {
				this._onDidIndexProgress.fire(`📝 BM25 索引: ${done}/${total}...`);
			}
		});

			// 3. Match calls to definitions
			this._onDidIndexProgress.fire('🔗 匹配调用关系...');
		const matchedEdges = await this._matchCallsToDefinitions();
		edgesExtracted += matchedEdges;

		// 3.5 Match inheritance edges to class definitions (INHERITS / IMPLEMENTS)
		const matchedInherits = await this._matchInheritsToDefinitions();
		edgesExtracted += matchedInherits;

		// 3.6 Match usage edges to variable/type definitions (USAGE, access=read|write)
		const matchedUsage = await this._matchUsageEdgesToDefinitions();
		edgesExtracted += matchedUsage;

		// #9 过程间热路径传播（基于已解析的 CALLS 图）
		await this._propagateInterprocedural();

			// 4. Similarity (MinHash 代码克隆检测) — 始终运行（签名已预计算，成本低）
			this._onDidIndexProgress.fire('🔁 代码克隆检测 (MinHash)...');
			const similarEdges = await this._runSimilarityPass();
			edgesExtracted += similarEdges;

			// 5. Extended passes (skip in fast mode to save time)
			const enableExtended = config.mode !== 'fast';
			if (enableExtended) {
				this._onDidIndexProgress.fire('🔬 运行扩展 pass...');
				const extendedEdges = this._runExtendedPasses();
				edgesExtracted += extendedEdges;
			}

			// 5. LSP cross-file type inference (skip in fast mode)
			if (enableExtended) {
				this._onDidIndexProgress.fire('🧠 跨文件 LSP 类型推断...');
				this._lspResolver = new LspCrossResolver();
				this._lspResolver.buildDefIndex(this._graph.store, projectName);
			}

			// 6. Community detection (Leiden) — always run (used by get_architecture)
			this._onDidIndexProgress.fire('🏘️ 社区检测 (Leiden)...');
			try {
				const leidenResult = await runMultiLevelLeiden(this._graph.store, projectName, 1.0, 5);
				this._logService.info('[CodebaseGraph]', `Leiden: ${leidenResult.communities.size} communities`);
			} catch (err: any) {
				this._logService.debug('[CodebaseGraph]', `Leiden failed: ${err?.message || err}`);
			}

			// 7. Post-index analysis (skip in fast mode to avoid expensive filesystem scans)
			if (enableExtended) {
				this._onDidIndexProgress.fire('🔍 环境变量扫描...');
				this._logService.info('[CodebaseGraph]', 'Post-index: env scan starting...');
				try {
					const envBindings = await scanEnvUrls(rootPath, this._fileService);
					if (envBindings.length > 0) {
						this._logService.info('[CodebaseGraph]', `Env scan: ${envBindings.length} bindings`);
					}
				} catch (err: any) {
					this._logService.debug('[CodebaseGraph]', `Env scan failed: ${err?.message || err}`);
				}

				this._onDidIndexProgress.fire('⚙️ 配置链接分析...');
				this._logService.info('[CodebaseGraph]', 'Post-index: config linking starting...');
				try {
					const configFileNodes = this._graph.store.getAllNodes().filter(n =>
						n.project === projectName && n.filePath && (
							n.filePath.endsWith('.env') || n.filePath.endsWith('.yaml') ||
							n.filePath.endsWith('.yml') || n.filePath.endsWith('.toml') ||
							n.filePath.endsWith('package.json') || n.filePath.endsWith('go.mod')
						)
					);
					const configPaths = [...new Set(configFileNodes.map(n => n.filePath!).filter(Boolean))];
					const configLinks = linkConfigToCode(this._graph.store, projectName, configPaths);
					if (configLinks.length > 0) {
						this._logService.info('[CodebaseGraph]', `Config link: ${configLinks.length} links`);
					}
				} catch (err: any) {
					this._logService.debug('[CodebaseGraph]', `Config link failed: ${err?.message || err}`);
				}

				// Cross-repo discovery
				this._logService.info('[CodebaseGraph]', 'Post-index: cross-repo discovery...');
				try {
					const projects = this._graph.store.listProjects();
					if (projects.length >= 2 || this._crossRepoEnabled) {
						const discovery = new CrossRepoDiscovery(this._graph.store);
						const crossEdges = discovery.discover();
						if (crossEdges.length > 0) {
							this._logService.info('[CodebaseGraph]', `Cross-repo: ${crossEdges.length} edges`);
							discovery.insertCrossEdges(crossEdges);
						}
					}
				} catch (err: any) {
					this._logService.debug('[CodebaseGraph]', `Cross-repo discovery failed: ${err?.message || err}`);
				}
			} else {
				this._logService.info('[CodebaseGraph]', 'Skipping post-index analysis (fast mode)');
			}

			// 8. Save graph to {rootPath}/.codebase-memory/graph.db.zst（仅本 folder 子图）
			// 先取消该 root 的待发延迟落盘：全量索引即将写一份完整快照，
			// 若延迟任务稍后 firing 会重复写同一制品（且内容更旧或更新，竞态）。
			this._cancelPendingSave(rootPath);
			// 串行化：等待任何正在跑的落盘结束，避免两个 save 同时写同一个 .tmp 制品
			// 2026-09-15：project 用本轮局部常量（原为 `this._projectName`，索引期间可能被
			// 别的工作区的 merge 改写 ⇒ 制品内容错位甚至为空）。
			this._savingGraph = this._savingGraph.then(
				() => this._saveGraph(rootPath, projectName),
				() => this._saveGraph(rootPath, projectName),
			);
			await this._savingGraph;

			// Phase 2b：将完整图数据同步到主进程 SQLite（默认开启；仅显式 false 关闭）。
			// 所有模式（含 fast）都全量同步——保证 sqlite 库始终有最新完整图数据，搜索走 FTS5；
			// 增量变更走 _syncIncrementalToSqlite 补丁（见 _runIncrementalIndex）。
			// 同步成功后不再释放内存 store（同步路径 hasGraphData()/searchGraph 依赖它）。
		if (this._sqliteBackendEnabled) {
			this._onDidIndexProgress.fire('💾 同步到 SQLite 后端...');
			try {
				// 显式传本轮 project（`_syncGraphToSqlite()` 缺省读 `this._projectName`，同上有被改写风险）
				// 全局串行：正在跑的后台追平若已开了显式事务，这里排队等它结束
				await this._runSerializedSqliteSync(() => this._syncGraphToSqlite(projectName));
			} catch (err) {
				this._logService.error('[CodebaseGraph]', 'SQLite sync failed:', err);
			}
		}

			const duration = Math.round((Date.now() - startTime) / 1000);
			// 汇总诊断：全量轮 coverage 已 reset，直接统计全部 entries
			this._logIndexSummary('full');
			const result: IIndexResult = {
				success: true,
				message: `索引完成: ${filesScanned} 文件, ${nodesExtracted} 节点, ${edgesExtracted} 边`
				+ (this._parseMemHardAbortFired ? ' ⚠（内存超限已提前中止解析，剩余文件将由后续增量索引逐步补齐）' : ''),
				duration,
				stats: { filesScanned, nodesExtracted, edgesExtracted },
				rootPath,
				kind: 'full',
			};
			this._onDidIndexProgress.fire(`✓ ${result.message} (${duration}s)`);
			this._onDidIndexComplete.fire(result);
			return result;

		} catch (err: any) {
			const duration = Math.round((Date.now() - startTime) / 1000);
			const msg = cts.token.isCancellationRequested
				? `索引已取消 (${duration}s)`
				: `索引失败: ${err.message || String(err)}`;
			const result: IIndexResult = { success: false, message: msg, duration, rootPath, kind: 'full' };
			this._onDidIndexProgress.fire(`✗ ${msg}`);
			this._onDidIndexComplete.fire(result);
			return result;
		} finally {
			this._isIndexing = false;
			this._indexCts?.dispose();
			this._indexCts = undefined;
			this._disposeWorkers(); // 安全清理 Worker 池
			releaseLock();
		}
	}

	cancelIndex(): void {
		if (this._isIndexing && this._indexCts) {
			this._onDidIndexProgress.fire('▶ 正在取消索引...');
			this._indexCts.cancel();
		}
	}

	// ─── Watcher & Incremental Indexing (P2-#8) ──────────────────────────

	/** 启动文件监听（增量重索引触发源）。应在首次全量索引 / 加载既有图谱完成后调用。 */
	startWatching(rootPath: string, extraExcludeDirs?: readonly string[], keepDirs?: readonly string[]): void {
		this._watchRootPath = rootPath;
		const supportedExtensions = new Set(Object.keys(EXTENSION_TO_WASM_LANG));
		// 多 folder：用该 root 对应的项目名。回退按 basename 解析（与 indexWorkspace 一致）——
		// 旧实现回退 _projectName，root↔project 会错配（曾致 S1Game watcher 拿 UE5EA 哈希比对，
		// 报出 +188742 ~0 -28674 的荒诞变更集）。
		const project = this._rootProjectMap.get(this._normalizeRoot(rootPath)) || this._basename(rootPath.replace(/[\\/]+$/, '')) || this._projectName;
		// 统一入口写回映射（覆盖 loadMerge/自动索引等所有建立 project 的路径，避免 watcher 用错 project）
		this._rootProjectMap.set(this._normalizeRoot(rootPath), project);
		// watcher 扫描与索引扫描使用同一套目录排除（否则 Intermediate/ 等目录每轮误报全量 added）。
		// 排除集解析含异步探测（.cbmignore / workspace exclude 配置），故 start 延后到解析完成。
		void this._excludeResolver.resolve(rootPath, extraExcludeDirs).then(excludeDirs => {
			// 2026-09-15：排除集解析是异步的（含 .cbmignore / 工作区配置探测）。若期间用户切走了
			// 工作区，这个 root 已不属于本窗口 ⇒ **不要**注册 watcher（否则它会一直轮询并 fire
			// 变更，把已 prune 的跨工作区数据重建回来）。
			if (!this._isRootInCurrentWorkspace(this._normalizeRoot(rootPath))) {
				this._logService.info('[CodebaseGraph]', `Skipped starting watcher for ${rootPath} — no longer part of the current workspace`);
				return;
			}
			const keep = keepDirs?.length ? [...keepDirs] : undefined;
			// 记录生效范围：增量索引 / git-head 全量重建复用同一口径（防幻影变更翻烧饼）
			this._watchScopeCache.set(this._normalizeRoot(rootPath), { excludeDirs, keepDirs: keep });
			this._logService.info('[CodebaseGraph]', `Starting graph watcher for ${rootPath} (project=${project}, ${supportedExtensions.size} extensions, ${excludeDirs.size} excluded dirs, keepDirs=${keep?.length ?? 0})`);
			this._graphWatcher.start(rootPath, this._graph.store, project, supportedExtensions, excludeDirs, keep);
		}, err => {
			this._logService.warn('[CodebaseGraph]', `Failed to start watcher for ${rootPath}: ${err?.message || err}`);
		});
	}

	private async _onWatcherChange(e: CodebaseGraphChangeEvent): Promise<void> {
		// 用事件携带的 rootPath（多 root 监听下 _watchRootPath 单字段会串 folder——
		// 曾致 UE5EA 的变更集在 S1Game 上跑增量，真正的脏集永不收敛、每 30s 空转）
		const rootPath = e.rootPath || this._watchRootPath;
		// 2026-09-15：工作区已切走时（原地切换不 reload renderer），旧 root 的 watcher 可能还有
		// **已 fire 未处理**的变更事件（去抖窗口 2s）——必须丢弃：否则增量索引会为已 prune 的
		// 项目重新建数据，与 `_pruneForeignProjects` 形成互相抵消的循环。
		if (rootPath && !this._isRootInCurrentWorkspace(this._normalizeRoot(rootPath))) {
			this._logService.info('[CodebaseGraph]', `Ignoring watcher change for ${rootPath} — no longer part of the current workspace`);
			return;
		}
		if (e.type === 'git-head') {
			this._logService.info('[CodebaseGraph]', `[TRACE] watcher git-head changed → indexWorkspace: ${rootPath}`);
			this._logService.info('[CodebaseGraph]', 'Git HEAD changed, running full re-index...');
			// 复用该 root 已生效的索引范围（用户 excludeDirs + keepDirs），避免全量重建丢配置。
			// 已解析的排除集作为 extra 再次并入是幂等的（mergeExcludeDirs 去重）。
			const scope = this._watchScopeCache.get(this._normalizeRoot(rootPath));
			await this.indexWorkspace(rootPath, { mode: 'fast', excludeDirs: scope ? [...scope.excludeDirs] : [], keepDirs: scope?.keepDirs });
		} else if (e.type === 'files' && (e.added?.length || e.modified?.length || e.deleted?.length)) {
			this._logService.info('[CodebaseGraph]', `[TRACE] watcher files changed → incremental index: ${rootPath}`);
			this._logService.info('[CodebaseGraph]', 'Files changed, running incremental index...');
			// 把 watcher 已精确算好的变更集传下去，让增量走快路径（跳过全量 _scanFiles +
			// classifyFiles 逐文件 stat）。旧实现只传 rootPath，变更集被丢弃 → 单文件
			// 保存也全量扫 6351 文件耗时 23s（日志 1787282021811）。
			await this._runIncrementalIndex(rootPath, undefined, {
				added: e.added ?? [],
				modified: e.modified ?? [],
				deleted: e.deleted ?? [],
			});
		}
	}

	private _getIncrementalIndexer(): CodebaseGraphIncrementalIndexer {
		if (!this._incrementalIndexer) {
			this._incrementalIndexer = new CodebaseGraphIncrementalIndexer(this._graph.store, this._fileService);
		}
		return this._incrementalIndexer;
	}

	/**
	 * 增量重索引：仅解析新增/修改/删除的文件，通过 GraphStore 包装层写入（保持 string↔numeric id 映射一致）。
	 * 复用 CodebaseGraphIncrementalIndexer 做 mtime+size 快速分类。
	 *
	 * @param changeSet watcher 已算好的变更集（root-relative 相对路径）。提供且非空时走
	 *        快路径（跳过全量 `_scanFiles` 遍历 + `classifyFiles` 逐文件 stat）；未提供时
	 *        走全量扫描兜底（watcher 漏报 / 进程重启后首次 / 变更集为空等场景）。
	 */
	private async _runIncrementalIndex(
		rootPath: string,
		token?: CancellationToken,
		changeSet?: { added: string[]; modified: string[]; deleted: string[] },
	): Promise<IIndexResult> {
		if (!rootPath) { return { success: false, message: '未指定监听根路径', kind: 'incremental' }; }
		if (this._isIndexing) {
			return { success: false, message: '索引正在进行中，跳过增量索引', rootPath, kind: 'incremental' };
		}

		const cts = new CancellationTokenSource(token);
		const startTime = Date.now();
		// ─── 阶段耗时埋点（2026-09-02）─────────────────────────────────────
		// 背景：日志 1788352997271 实测增量索引 13-16s，却产出 0 节点 0 边；而既有日志
		// 只有一条「✓ 增量索引完成 (15s)」，无法判断耗时落在锁等待 / 扫描 / 解析 /
		// BM25 / 克隆检测 / 边匹配 / SQLite 补丁中的哪一段（快路径已跳过全量扫描）。
		// 故逐段计时，完成时输出一条对账行：各段之和应≈总耗时，差额即未被埋点覆盖的开销。
		let _segStart = startTime;
		const _segMarks: string[] = [];
		// ★★ 2026-09-19：序列开头**丢掉陈旧累积** —— 否则 `_seg` 的第一段（`获取索引锁`）会把
		// 「自上次读取以来」的全局最大阻塞揽下来 ✗（`_maxBlockMs` 是全局累加器、只在被读时清零；
		// 上一次读取可能属于另一个消费者 `loadMerge` 的 `timed`，且发生在更早）。见 `resetMaxBlockMs` 说明。
		resetMaxBlockMs();
		const _seg = (name: string): void => {
			const now = Date.now();
			// ★ 2026-09-19：段耗时（含 await）**不等于**主线程被占 ⇒ 一并记「该段内最长连续占用」
			//（`takeMaxBlockMs()` 读+清零，由看门狗喂 ✓）。⚠ 别用 `asyncSlice.takeMaxSliceMs()`：
			// 它只在切片循环被喂 ⇒ 这些阶段多数不走切片 ⇒ 必然假阴性 ✗（实测 8 段全无标记 ✗）
			const blockMs = Math.round(takeMaxBlockMs());
			_segMarks.push(`${name}=${now - _segStart}ms${blockMs > 12 ? `[阻塞${blockMs}ms]` : ''}`);
			_segStart = now;
			// ★ 2026-09-19（P1-5）：**阶段边界**顺带做内存检查（超预算即在**出现问题的那个阶段**告警，
			// 而不是结束后让用户去猜是哪一段吃掉了内存 ✗）。成本仅一次 `performance.memory` 读取 ✓
			this._reportGraphMemory(name);
		};
		this._memBudgetWarned = false;   // 每轮重置「只告警一次」闸（见 `_reportGraphMemory`）
		// ★ 2026-09-19：同时记录本轮**基线堆** —— 判据是「本轮增长」而非绝对堆占用（见 `_memBaselineBytes`）
		this._memBaselineBytes = this._graphMemoryUsedBytes().usedBytes;
		// 解析期内存看门狗状态每轮重置（见 `_parseMemoryWatchdog`）
		this._parseMemHardAbortFired = false;
		this._parseMemSoftWarned = false;
		this._isIndexing = true;
		this._indexCts = cts;

		let releaseLock: () => void;
		// 变更文件清单（catch 里也要能读到——classification 是 try 块级作用域）
		let changedFilesBrief = '';
		try {
			releaseLock = await this._lockIndex(rootPath);
		} catch (lockErr) {
			this._isIndexing = false;
			return { success: false, message: lockErr instanceof Error ? lockErr.message : '索引已被锁定，跳过增量索引', rootPath, kind: 'incremental' };
		}

		try {
			_seg('获取索引锁');
			// 多 folder：按 root 解析对应项目名（回退到当前 _projectName）
			const project = this._rootProjectMap.get(this._normalizeRoot(rootPath)) || this._projectName;
			// P0 修复：增量重解析的节点/边同样按真实项目名写入
			this._graph.setActiveProject(project);

			// 复用 watcher/全量索引已生效的索引范围（用户 excludeDirs + keepDirs）——
			// 旧实现空调用 _resolveExcludeDirs(rootPath)（零 extra、无 keepDirs），与全量索引口径不一致，
			// 导致基线 fileHashes 与增量扫描集错配：watcher 报幻影 deleted → 增量又报 added（翻烧饼循环）。
			const cachedScope = this._watchScopeCache.get(this._normalizeRoot(rootPath));
			const incExcludeDirs = cachedScope?.excludeDirs ?? await this._excludeResolver.resolve(rootPath);

			// ─── 增量快路径（2026-08-21，日志 1787282021811）────────────────────────
			// watcher 已算出变更集（root-relative '/' 分隔，与 _getRelativePath 口径一致），
			// 旧实现却把它丢弃、无条件 _scanFiles 全量遍历 + classifyFiles 逐文件 stat：
			// 单文件保存也要全量扫 6351 文件耗时 23s（日志 7023→9337）。
			// 快路径直接用变更集构造 relToAbs + 分类；全量路径保留作兜底。
			let absFiles: string[];
			let relToAbs: Map<string, string>;
			let classification: { added: string[]; modified: string[]; deleted: string[]; unchanged: string[] };
			const hasChangeSet = !!(changeSet && (changeSet.added.length || changeSet.modified.length || changeSet.deleted.length));
			// 空基线守卫（2026-09-08）：图无节点或 fileHashes 基线为空 = 从未完成全量索引。
			// 此时快路径只索引「本次变更的文件」，图谱永远残缺——只含被编辑过的文件，
			// Find Symbol / Open File 检索不到其它任何源文件（用户实测：快照仅 4 文件 739
			// 节点，instantNodes.ts 的 rotateDegrees 不在图内）。降级为全量扫描 + 分类：
			// 无哈希记录的文件全部判为 added → 等效全量重建，一次补齐基线。
			//
			// 残缺检测（2026-09-09，快照取证 fileHashes=6017 但仅 1196 节点）：有基线 ≠ 健康——
			// 旧实现解析失败（parse_error/timeout）也记哈希 → classifyFiles 全判 unchanged →
			// **失败永久固化**（6017 文件全部 skipped，只有被编辑过的文件产出节点）。
			// 每文件平均节点数 < 2 即判残缺（正常项目 ≥ 5），清哈希强制全量重建。
			const graphNodeCount = this._graph.store.getNodeCount();
			const hashCount = this._graph.store.getFileHashCount();
			const deficientGraph = graphNodeCount > 0 && hashCount > 0 && graphNodeCount / hashCount < 2;
			if (deficientGraph) {
				this._graph.store.clearFileHashes();
				this._logService.warn('[CodebaseGraph]', `[baseline] deficient graph: ${graphNodeCount} nodes / ${hashCount} hashes — clearing hashes to force full re-index`);
			}
			const hasBaseline = graphNodeCount > 0 && this._graph.store.getFileHashCount() > 0;
			if (hasChangeSet && hasBaseline) {
				const added = changeSet!.added;
				const modified = changeSet!.modified;
				const deleted = changeSet!.deleted;
				relToAbs = new Map<string, string>();
				absFiles = [];
				// 仅 added/modified 需重新解析（deleted 只需 rel 做 deleteByFile）
				for (const rel of [...added, ...modified]) {
					const abs = this._relToAbs(rootPath, rel);
					relToAbs.set(rel, abs);
					absFiles.push(abs);
				}
				classification = { added, modified, deleted, unchanged: [] };
				this._onDidIndexProgress.fire(`⚡ 增量索引：watcher 变更集 +${added.length} ~${modified.length} -${deleted.length}（跳过全量扫描）`);
			} else {
				this._onDidIndexProgress.fire('⚡ 增量索引：扫描变更文件...');
				const absFilesScan = await this._scanner.scanFiles(
					rootPath, incExcludeDirs, undefined, cts.token, cachedScope?.keepDirs,
					msg => this._onDidIndexProgress.fire(msg),
				);
				relToAbs = new Map<string, string>();
				for (const abs of absFilesScan) { relToAbs.set(this._getRelativePath(abs), abs); }
				absFiles = absFilesScan;
				classification = await this._getIncrementalIndexer().classifyFiles(
					project, absFilesScan, (abs) => this._getRelativePath(abs));
				this._onDidIndexProgress.fire(`⚡ 增量分类: +${classification.added.length} ~${classification.modified.length} -${classification.deleted.length} =${classification.unchanged.length}`);
			}
			_seg(hasChangeSet ? 'watcher变更集快路径' : '全量扫描+分类');

			// 零变更短路：跳过后续全部重活（BM25 重建/249k 节点相似度 pass/全量图谱保存）。
			// 旧实现零变更也每轮全跑（30s+），配合 watcher 误报形成"扫描→空增量→保存→再扫描"卡顿循环
			if (classification.added.length === 0 && classification.modified.length === 0 && classification.deleted.length === 0) {
				const duration = Math.round((Date.now() - startTime) / 1000);
				const noChangeMsg = `增量索引：无变更 (${duration}s)`;
				this._onDidIndexProgress.fire(`✓ ${noChangeMsg}`);
				const noChangeResult: IIndexResult = {
					success: true,
					message: noChangeMsg,
					duration,
					stats: { filesScanned: absFiles.length, nodesExtracted: 0, edgesExtracted: 0 },
					rootPath,
					kind: 'incremental',
				};
				this._onDidIndexComplete.fire(noChangeResult);
				return noChangeResult;
			}

			// 1. 删除被删/被改文件的旧节点与边
			for (const rel of [...classification.deleted, ...classification.modified]) {
				this._graph.deleteByFile(rel);
				this._graph.store.deleteFileHash(project, rel);
				// 同步移除旧覆盖率条目：被改文件随后会重新 _recordCoverage，
				// 被删文件则不应继续留在 coverage（否则 check_index_coverage 报幻影条目）
				this._indexCoverage.delete(rel);
			}
			for (const rel of classification.deleted) {
				this._parseFailCounts.delete(rel);
			}

			// 2. 重新解析新增/被改文件
			let nodesExtracted = 0;
			let edgesExtracted = 0;
			// 收集本次重解析节点的数字 id（供增量克隆检测：只对新节点做 LSH 配对，
			// 避免每次 1 文件保存都全量 MinHash 扫描 12.4w 节点 → 同步卡死 renderer）。
			const newOrChangedNodeIds = new Set<number>();
			// 0 节点诊断（2026-09-02）：记录每个解析出 0 节点的文件的 status/reason。
			// _parseFile 的 skipped/parse_error 路径此前无任何 INFO 日志，导致「改了源码
			// 却 0 节点」无法定位 —— 典型 reason：unsupported extension / file too large /
			// single-line file > 50KB (minified?) / line too long / no parser / parse_error。
			const _zeroNodeFiles: string[] = [];
			this._graph.store.setDeferBM25(true);
			const toParseRel = [...classification.added, ...classification.modified];
			// ── 阶段 1：受限并发解析（2026-09-03）──
			// 旧实现逐文件串行 await：6 文件轮解析 2818ms（平均 470ms/文件），而 Worker 池有
			// N 个可并行。解析是「读文件 + Worker CPU」，对图无共享写，可安全并发。动态队列
			// （nextIdx++）分发，大文件不会绑死某个 runner；墙钟时间 ≈ 最慢单文件而非总和。
			// 主线程 fallback（Worker 池不可用）保持 K=1 串行——主线程并发解析只会互卡。
			// 并发下每文件后的 yield 移除（Worker 模式主线程本就空闲），改到阶段 2 统一让出。
			const parseTargets: { rel: string; abs: string }[] = [];
			for (const rel of toParseRel) {
				const abs = relToAbs.get(rel);
				if (abs) { parseTargets.push({ rel, abs }); }
			}
			const poolReady = await this._ensureWorkerPool();
			const parseParallelism = poolReady
				? Math.max(1, Math.min(this._parserWorkers.length, parseTargets.length))
				: 1;
			type ParsedFile = Awaited<ReturnType<CodebaseGraphService['_parseFile']>>;
			const parseResults: { idx: number; rel: string; abs: string; result: ParsedFile }[] = [];
			{
				let nextIdx = 0;
				const runOne = async (): Promise<void> => {
					while (!cts.token.isCancellationRequested) {
						const idx = nextIdx++;
						if (idx >= parseTargets.length) { break; }
						const t = parseTargets[idx];
						try {
							const result = await this._parseFile(t.abs, cts.token);
							parseResults.push({ idx, rel: t.rel, abs: t.abs, result });
							// ★ 2026-09-21 内存看门狗（UE 95k 文件 OOM 实证）：解析结果全部攒在
							// parseResults（阶段 2 才写入 store）⇒ 解析阶段是内存无出口的最长段——
							// 阶段边界的 `_reportGraphMemory` 来不及响 ⇒ 必须在循环内检查。
							// 越硬上限即取消本轮；已解析部分照常写入/落盘（渐进收敛 ✓）。
							if (parseResults.length % CodebaseGraphService.PARSE_MEM_CHECK_EVERY === 0) {
								this._parseMemoryWatchdog(cts, `增量解析 ${parseResults.length}/${parseTargets.length}`);
							}
						} catch (err: any) {
							this._logService.debug('[CodebaseGraph]', `Incremental parse failed ${t.abs}: ${err?.message || err}`);
						}
					}
				};
				await Promise.all(Array.from({ length: parseParallelism }, () => runOne()));
			}

			// ── 阶段 2：按原文件顺序写入（upsert/虚拟边分流/哈希为有序主线程操作）──
			parseResults.sort((a, b) => a.idx - b.idx);
			for (const { rel, abs, result } of parseResults) {
				// 记录逐文件覆盖率（与全量路径同口径）。此前增量路径只写 _zeroNodeFiles 诊断、
				// 不写 coverage → [summary] 在增量轮恒为 indexed=0（无法反映真实处理量）。
				this._recordCoverage(rel, result.status, result.reason, result.nodes.length);
				if (result.nodes.length === 0) {
					_zeroNodeFiles.push(`${rel}[${result.status}${result.reason ? ': ' + result.reason : ''}]`);
				}
				for (const n of result.nodes) { newOrChangedNodeIds.add(this._graph.addNode(n)); nodesExtracted++; }
				for (const e of result.edges) {
					// call:/inherits:/implements:/usage: 虚拟边暂存（与全量索引同一分流逻辑）
					if (e.target && typeof e.target === 'string' && e.target.startsWith('call:')) {
						this._pendingCallEdges.push({ source: e.source, callee: e.target.slice(5), loopDepth: e.properties?.loopDepth ?? 0 });
					} else if (e.target && typeof e.target === 'string' && (e.target.startsWith('inherits:') || e.target.startsWith('implements:'))) {
						const kind: 'INHERITS' | 'IMPLEMENTS' = e.target.startsWith('implements:') ? 'IMPLEMENTS' : 'INHERITS';
						this._pendingInheritEdges.push({ source: e.source, baseName: e.target.slice(e.target.indexOf(':') + 1), kind });
					} else if (e.target && typeof e.target === 'string' && e.target.startsWith('usage:')) {
						const name = e.target.slice(6);
						const access: 'read' | 'write' = e.properties?.access === 'write' ? 'write' : 'read';
						this._pendingUsageEdges.push({ source: e.source, name, access });
					} else {
						this._graph.addEdge(e);
					}
					edgesExtracted++;
				}
				// 更新文件哈希（仅 mtime+size，避免 SHA-256 开销）。
				// parse_error/timeout 不记（允许下轮重试，见 _recordHashAfterParse）——否则失败固化。
				try {
					if (result.status === 'parse_error' || result.status === 'timeout') {
						await this._recordHashAfterParse(project, rel, abs, result.status);
					} else {
						const stat = await this._fileService.stat(URI.file(abs));
						this._graph.store.upsertFileHash({
							project,
							relPath: rel,
							sha256: '',
							mtimeNs: stat.mtime * 1_000_000,
							size: stat.size,
						});
						// Phase 2 接线：同步到主进程 SQLite 后端（默认关闭）
						this._syncFileHashToSqlite(project, rel, '', stat.mtime * 1_000_000, stat.size);
						this._parseFailCounts.delete(rel);
					}
				} catch { /* 忽略哈希更新失败 */ }
				// 每个文件后让出主线程（旧值 i%50：改动 <50 个文件时**一次都不让出**，
				// 节点写入整段独占主线程，是"改 1 个文件也卡"的直接原因）。
				// setTimeout(0) 单次开销极小（微秒级），相对毫秒级的写入可忽略。
				await new Promise<void>(r => setTimeout(r, 0));
			}
			_seg(`解析${toParseRel.length}个文件`);
			this._graph.store.setDeferBM25(false);
			// 增量模式（force=false）：只刷新 defer 期间累积的脏集（本次变更的节点），
			// 而非 clear() + 遍历全图 12.4w 节点——这是增量索引卡顿的最大单点之一。
			// ★ 2026-09-18（P0 性能收口）：检索走 FTS5 时内存倒排**无人查询**（同步 searchGraph
			// 无外部调用者，见 `_rebuildBM25OrDefer`）⇒ 增量维护也一并跳过：脏集留待「按需全量重建」
			// 时被 `force=true` 统一消化（它开头就 `clear()` 脏集，不会无界增长）。
			// ⚠ 这里**不**置「按需重建」标记 —— 若此前已按需建好，置标记会让它下次白重建一遍 ✗。
			if (this._sqliteBackendEnabled) {
				this._graph.store.checkpoint();
				_seg('BM25跳过(FTS5)+checkpoint');
			} else {
				await this._graph.store.rebuildBM25();
				this._graph.store.checkpoint();
				_seg('BM25增量重建+checkpoint');
			}

			// 增量克隆检测：只对本次重解析的新节点做「新节点 vs 全量」配对（insertEdge
			// 按端点去重，天然幂等）。旧实现 `_runSimilarityPass()` 无参全量扫 12.4w 节点
			// 做 MinHash/LSH，是同步无 yield 的重活——单文件保存也卡死 renderer 数秒。
			const similarEdges = await this._runSimilarityPass(newOrChangedNodeIds);
			_seg(`克隆检测(新节点${newOrChangedNodeIds.size})`);

			// 增量继承边匹配（暂存的 inherits:/implements: 虚拟边 → 真实 INHERITS/IMPLEMENTS 边）
			const matchedInherits = await this._matchInheritsToDefinitions();
			edgesExtracted += matchedInherits;

			// 增量使用边匹配（暂存的 usage: 虚拟边 → 真实 USAGE 边，带 access 读写）
			const matchedUsage = await this._matchUsageEdgesToDefinitions();
			edgesExtracted += matchedUsage;
			_seg('继承边+使用边匹配');

			// 延迟合并落盘：全图序列化 + gzip 是本流程最大单点（与变更集大小无关）。
			// 连续保存时多次索引结果合并为一次落盘；dispose/显式刷新会强制落盘。
			//
			// SQLite 后端启用时，本次变更随后由 _syncIncrementalToSqlite 写入主进程
			// SQLite（实测 40-442ms），zst 制品退化为「冷启动快照」—— 每次增量都重写
			// 96MB 是纯冗余，故按 ZST_SAVE_MIN_INTERVAL_MS 节流（窗口内只更新 SQLite）。
			// 未启用 SQLite 后端时不节流（此时 zst 是唯一持久化，必须落盘）。
			const zstThrottled = this._sqliteBackendEnabled
				&& (Date.now() - this._lastZstSaveAt) < ZST_SAVE_MIN_INTERVAL_MS;
			if (!zstThrottled) {
				this._scheduleSaveGraph(rootPath, project);
			}

			// Phase 2b 增量补丁：仅同步变更文件到 sqlite（不触发全量重建）
			if (this._sqliteBackendEnabled) {
				this._onDidIndexProgress.fire('💾 SQLite 增量补丁...');
				await this._syncIncrementalToSqlite(project, [...classification.deleted, ...classification.modified, ...classification.added]);
			}
			_seg('SQLite增量补丁');

			// ─── 埋点对账行（2026-09-02）─────────────────────────────────────
			// 各段之和应≈总耗时；若「未覆盖」占比大，说明耗时在未被埋点的代码段
			// （如 deleteByFile 循环、文件哈希 stat、进度事件派发等）。
			const _totalMs = Date.now() - startTime;
			const _sumMs = _segMarks.reduce((acc, m) => acc + parseInt(m.slice(m.lastIndexOf('=') + 1), 10), 0);
			this._logService.info('[CodebaseGraph]', `增量索引阶段耗时: ${_segMarks.join(' | ')} | 合计=${_sumMs}ms / 总=${_totalMs}ms / 未覆盖=${_totalMs - _sumMs}ms | 内存=${this._reportGraphMemory('增量索引收尾')}`);
			// 0 节点诊断：仅在实际发生时输出，避免正常路径噪音。
			if (_zeroNodeFiles.length > 0) {
				this._logService.info('[CodebaseGraph]', `增量解析 0 节点文件 ${_zeroNodeFiles.length}/${toParseRel.length}: ${_zeroNodeFiles.slice(0, 5).join(', ')}${_zeroNodeFiles.length > 5 ? ` ...(另${_zeroNodeFiles.length - 5}个)` : ''}`);
			}

			// 汇总诊断：增量轮 coverage 是累积的，按本轮处理范围取子集
			this._logIndexSummary('incremental', [...classification.added, ...classification.modified, ...classification.deleted]);
			changedFilesBrief = [...classification.added, ...classification.modified, ...classification.deleted].join(', ');

			const duration = Math.round((Date.now() - startTime) / 1000);
			const message = `增量索引完成: +${classification.added.length} ~${classification.modified.length} -${classification.deleted.length} (${nodesExtracted} 节点, ${edgesExtracted} 边, ${similarEdges} 克隆边, ${duration}s, ${zstThrottled ? 'zst落盘已节流(SQLite已持久化)' : '落盘已排队'})`
				+ (this._parseMemHardAbortFired ? ' ⚠（内存超限已提前中止解析，剩余文件将由后续增量索引逐步补齐）' : '');
			this._onDidIndexProgress.fire(`✓ ${message}`);
			const result: IIndexResult = {
				success: true,
				message,
				duration,
				stats: { filesScanned: absFiles.length, nodesExtracted, edgesExtracted },
				rootPath,
				kind: 'incremental',
			};
			this._onDidIndexComplete.fire(result);
			return result;
		} catch (err: any) {
			// stack 必须输出：「undefined reading X」类错误只有堆栈才能定位（2026-09-09 教训——
			// 只有 message 时无法定位 inDegree 崩溃点，排查耗时）。
			this._logService.error('[CodebaseGraph]', `增量索引失败 stack:\n${err?.stack || '(no stack)'}`);
			const msg = `增量索引失败: ${err?.message || String(err)} (files: ${changedFilesBrief || 'unknown'})`;
			this._onDidIndexProgress.fire(`✗ ${msg}`);
			return { success: false, message: msg, duration: 0, rootPath, kind: 'incremental' };
		} finally {
			this._isIndexing = false;
			this._indexCts?.dispose();
			this._indexCts = undefined;
			releaseLock();
		}
	}

	/**
	 * 延迟合并落盘（增量索引用）。
	 *
	 * 与 watcher 去抖（CHANGE_DEBOUNCE_MS）分处两层、互补：
	 *   - watcher 去抖：合并「变更事件」→ 减少增量索引**次数**
	 *   - 本方法：合并「索引结果」→ 减少全图落盘**次数**
	 * 连续保存文件时，即便索引只跑一次，其后若又触发新索引，落盘仍可再合并。
	 *
	 * 全量索引不走这里（用 _saveGraph 立即落盘）：全量是用户显式触发的重活，
	 * 且结果必须尽快持久化。
	 */
	/** 上次 zst 全量落盘时刻（节流基准，见 ZST_SAVE_MIN_INTERVAL_MS）。 */
	private _lastZstSaveAt = 0;

	// ─── 检索让路（2026-09-20，方案 B）───────────────────────────────────────
	/** 正在飞的 `searchGraphAsync` 数（>0 ⇒ 不启动 zst 全量落盘，见 `searchGraphAsync` 注释）。 */
	private _searchesInFlight = 0;
	/** 因「有检索在飞」被推迟的落盘（归一化 root 集合）⇒ 检索结束后由 `_flushSavesDeferredBySearch` 补跑 ✓。 */
	private readonly _savesDeferredBySearch = new Set<string>();
	/** 被推迟后的重试定时器（按归一化 root），防止重复排 ✓。 */
	private readonly _saveRetryTimers = new Map<string, any>();

	/**
	 * 落盘的**唯一出口**（延时到期 / 饥饿到期 / 检索结束后补跑都走它 ✓）。
	 *
	 * 让路规则：`_searchesInFlight > 0` 且**未到饥饿上限** ⇒ 不启动，登记 + 稍后重试
	 * （间隔 `SAVE_DEFER_BY_SEARCH_MS`）。饥饿上限沿用既有 `SAVE_MAX_DEFER_MS`
	 * ⇒ **连续检索流也不会把落盘无限推迟** ✓（数据安全边界不变 ✓）。
	 */
	private _fireSaveOrDefer(key: string, rootPath: string, project?: string): void {
		const pending = this._pendingSaves.get(key);
		const first = pending?.firstRequestedAt ?? Date.now();
		const starved = (Date.now() - first) >= SAVE_MAX_DEFER_MS;
		if (this._searchesInFlight > 0 && !starved) {
			this._savesDeferredBySearch.add(key);
			if (!this._saveRetryTimers.has(key)) {
				const t = setTimeout(() => {
					this._saveRetryTimers.delete(key);
					this._fireSaveOrDefer(key, rootPath, project);
				}, SAVE_DEFER_BY_SEARCH_MS);
				this._saveRetryTimers.set(key, t);
			}
			return;
		}
		this._savesDeferredBySearch.delete(key);
		const retry = this._saveRetryTimers.get(key);
		if (retry) { clearTimeout(retry); this._saveRetryTimers.delete(key); }
		if (pending) { clearTimeout(pending.timer); this._pendingSaves.delete(key); }
		if (this._searchesInFlight > 0) {
			// 到点了但检索还在飞 ⇒ 记一行（饥饿保护已判过 ⇒ 必然是 starved 才走到这里）
			this._logService.info('[CodebaseGraph]', `[save-defer] "${rootPath}" 已达饥饿上限 ${SAVE_MAX_DEFER_MS}ms ⇒ 即使有检索在飞也强制落盘 ✓（数据安全优先）`);
		}
		this._savingGraph = this._savingGraph.then(
			() => this._saveGraph(rootPath, project),
			() => this._saveGraph(rootPath, project),
		);
	}

	/** 检索全部结束 ⇒ 立刻补跑被推迟的落盘（不等重试定时器，缩短空窗 ✓）。 */
	private _flushSavesDeferredBySearch(): void {
		if (this._savesDeferredBySearch.size === 0) { return; }
		for (const key of [...this._savesDeferredBySearch]) {
			const pending = this._pendingSaves.get(key);
			if (!pending) { this._savesDeferredBySearch.delete(key); continue; }
			const retry = this._saveRetryTimers.get(key);
			if (retry) { clearTimeout(retry); this._saveRetryTimers.delete(key); }
			this._fireSaveOrDefer(key, pending.rootPath, pending.project);
		}
	}

	private _scheduleSaveGraph(rootPath: string, project?: string): void {
		const key = this._normalizeRoot(rootPath);
		const pending = this._pendingSaves.get(key);
		const now = Date.now();

		// 饥饿保护：持续有变更时每次都重置窗口会让落盘无限推迟。
		// 距首次请求已超过 SAVE_MAX_DEFER_MS → 不再等待，立即落盘（仍经让路判据 ✓）。
		if (pending && (now - pending.firstRequestedAt) >= SAVE_MAX_DEFER_MS) {
			clearTimeout(pending.timer);
			this._fireSaveOrDefer(key, rootPath, project);
			return;
		}

		if (pending) {
			clearTimeout(pending.timer);
		}
		// 同 root 的后到请求覆盖先到（保存的是 store 当前快照，参数以最新为准）；
		// 首次请求时间沿用最早的，保证饥饿保护基于「第一个待发请求」计时。
		const firstRequestedAt = pending?.firstRequestedAt ?? now;
		// 剩余窗口：不超过上限
		const remaining = Math.max(0, SAVE_MAX_DEFER_MS - (now - firstRequestedAt));
		const delay = Math.min(SAVE_DEBOUNCE_MS, remaining);
		const timer = setTimeout(() => {
			// ★ 2026-09-20：到期不直接落盘 ⇒ 经 `_fireSaveOrDefer` 让路判据（有检索在飞则推迟 ✓）
			this._fireSaveOrDefer(key, rootPath, project);
		}, delay);
		this._pendingSaves.set(key, { rootPath, project, timer, firstRequestedAt });
	}

	/** 取消某个 root 的待发延迟落盘（全量索引即将写完整快照时用）。 */
	private _cancelPendingSave(rootPath: string): void {
		const key = this._normalizeRoot(rootPath);
		const pending = this._pendingSaves.get(key);
		if (pending) {
			clearTimeout(pending.timer);
			this._pendingSaves.delete(key);
		}
		// ★ 2026-09-20：连带清掉「检索让路」的重试定时器与登记（否则取消后仍会补跑一次 ✗）
		const retry = this._saveRetryTimers.get(key);
		if (retry) { clearTimeout(retry); this._saveRetryTimers.delete(key); }
		this._savesDeferredBySearch.delete(key);
	}

	/**
	 * 强制落盘所有待发的延迟保存（dispose / 显式刷新 / 关键路径前调用）。
	 * 并发安全：串行等待正在执行的落盘，避免两个 save 同时写同一个 .tmp 制品。
	 */
	async flushPendingSave(): Promise<void> {
		const pendingList = [...this._pendingSaves.values()];
		if (pendingList.length === 0) {
			await this._savingGraph; // 仍要等已在跑的落盘完成
			return;
		}
		// 清 timer 时用归一化 key；落盘时用 value.rootPath（原始路径，Windows 盘符/大小写安全）
		for (const [key, pending] of [...this._pendingSaves.entries()]) {
			clearTimeout(pending.timer);
			this._pendingSaves.delete(key);
			// ★ 2026-09-20：本路径**无条件**落盘（dispose/显式刷新要保数据，不受"检索让路"约束 ✓），
			// 但必须撤掉让路登记与重试定时器 ⇒ 否则稍后又补跑一次重复落盘 ✗。
			const retry = this._saveRetryTimers.get(key);
			if (retry) { clearTimeout(retry); this._saveRetryTimers.delete(key); }
			this._savesDeferredBySearch.delete(key);
			const rootPath = pending.rootPath;
			this._savingGraph = this._savingGraph.then(
				() => this._saveGraph(rootPath, pending.project),
				() => this._saveGraph(rootPath, pending.project),
			);
		}
		await this._savingGraph;
	}

	/**
	 * 持久化图谱到 {rootPath}/.codebase-memory/graph.db.zst（全量与增量共用）。
	 * 多 folder：project 提供时仅保存该 folder 的子图，避免把其它 folder 的节点写进本 folder 的制品。
	 * 注：自动保存/增量路径统一写 slim 档（剔除可重建的 bm25/layout），既能缩小制品体积，
	 * 也避免下次启动 loadMerge 时对整段倒排索引做一次同步 JSON.parse 卡死 UI（bm25 在合并后统一 rebuildBM25）。
	 */
	private async _saveGraph(rootPath: string, project?: string): Promise<void> {
		const graphDir = URI.joinPath(URI.file(rootPath), '.codebase-memory');
		try {
			await this._fileService.createFolder(graphDir);
			const artifactFile = URI.joinPath(graphDir, 'graph.db.zst');
			try {
			const persistence = new GraphPersistence(this._fileService, this._logService);

			// ★★★ 2026-09-15（**把用户 8.2MB 索引写成 99 字节**的数据丢失事故）：
			// 「要保存的子图是 0 节点」**不等于**「图谱是空的」——它意味着本会话此刻**不知道**
			// 这个项目的内容（项目已被 `_pruneForeignProjects` 删掉、或尚未加载）。
			// 此时**必须直接放弃写盘**，否则就是用空图覆盖磁盘上完好的制品。
			//
			// 实测事故（用户日志 `vscode-app-1789480089965.log`，21:47:32）：
			//   ① 增量索引结束 → `_scheduleSaveGraph(root, 'sarosis-agents-client')` 排入 30s 防抖；
			//   ② 用户切走工作区 → `_pruneForeignProjects` 把该项目从 store 删掉（`store nodes=0`）；
			//   ③ **那个定时器随后才触发** → 本方法拿到 0 节点 → 把 99 字节写进
			//      `.codebase-memory/graph.db.zst`（原 8.2MB / 176620 节点 ⇒ 索引被毁）。
			// 原因：原先的 sanity check **在 save 之后**才跑，而且只在 `totalCount > 0` 时告警
			// （针对"节点项目标记错位"）；本例 `totalCount === 0`（store 全空）
			// ⇒ **守卫沉默、照写不误** ✗。
			//
			// ⚠ 守卫必须在 `save` **之前** —— `persistence.save` 落地即覆盖，事后无法挽回。
			// ⚠ 副作用（期望的）：原本「项目标记错位致空制品 + 无限重建循环」那条路径，
			//   现在变成「跳过写盘、保留旧制品」——比写空图好得多。
			const savedCount = project ? this._graph.store.getNodeCount(project) : this._graph.nodeCount;
			const totalCount = this._graph.store.getNodeCount();
			if (savedCount === 0) {
				this._logService.warn('[CodebaseGraph]',
					`Graph save SKIPPED (refusing to overwrite a good artifact with an empty graph) | ` +
					`artifact=${artifactFile.fsPath} project=${project ?? 'all'} savedNodes=0 storeNodes=${totalCount}`);
				return;
			}

			// ★★★ 2026-09-18（P1-1 第二步+）：制品写出策略 = `saros.codebaseGraph.artifactFormat`
			//   · `'json'`（**默认** —— 行为与改动前**完全一致**，随时可回退 ✓）：流式 gzip+JSON，
			//     代价是 renderer 主线程要序列化整张图（大图数秒 + 内存峰值 ✗）；
			//   · `'sqlite'`：**只写 SQLite 快照**（主进程 `VACUUM INTO` ⇒ renderer **零序列化** ✓）；
			//   · `'both'`：两份都写（迁移期用；读侧仍走既有 JSON 路径）。
			// ⚠ 顺序是「先快照 → **校验节点数** → 再决定跳过 JSON」：快照失败 / 计数不符 ⇒ **回退写 JSON** ✓
			//   （绝不允许因为省时间而留下一个空的/半截的制品 —— 本仓有过 99 字节毁图的先例 ✗）。
			// ⚠⚠ `artifact.json`（含 `node_count`）**无论如何都要写**：它是 P1-1 步骤 1
			//   `canSkipArtifactParse()` 的**唯一数据源**，漏写会让「SQLite 不落后 ⇒ 不解析制品」直接失效 ✗。
			const artifactFormat = this._configurationService.getValue<string>('saros.codebaseGraph.artifactFormat') ?? 'json';
			const wantSnapshot = this._sqliteBackendEnabled && (artifactFormat === 'sqlite' || artifactFormat === 'both');
			const snapPath = artifactFile.fsPath.replace(/graph\.db\.\w+$/, 'graph.db.sqlite');
			let snapshotOk = false;
			const expectedNodes = savedCount;
			const expectedEdges = project ? this._graph.store.getEdgeCount(project) : this._graph.store.getEdgeCount();
			if (wantSnapshot) {
				const tmpPath = snapPath + '.tmp';
				try {
					// VACUUM INTO 要求目标文件**不存在**（SQLite 规定）
					try { await this._fileService.del(URI.file(tmpPath)); } catch { /* 不存在即可 */ }
					const snap = await this._sqliteBackend.exportSnapshot(tmpPath);
					// ★ 校验：快照必须真的装下本次要保存的规模，否则不许跳过 JSON 写盘
					if (snap.nodeCount <= 0 || snap.nodeCount < expectedNodes) {
						throw new Error(`snapshot node count mismatch: snapshot=${snap.nodeCount} expected>=${expectedNodes}`);
					}
					await this._fileService.move(URI.file(tmpPath), URI.file(snapPath), true);
					snapshotOk = true;
					this._logService.info('[CodebaseGraph]', `SQLite 快照制品已写出：${snapPath}（${snap.nodeCount} 节点 / ${snap.edgeCount} 边，${artifactFormat} 档）`);
				} catch (err: any) {
					this._logService.warn('[CodebaseGraph]', `SQLite 快照导出失败（将回退写 JSON 制品）：${err?.message || err}`);
				}
			}

			if (artifactFormat !== 'sqlite' || !snapshotOk) {
				let lastLoggedMB = 0;
				await persistence.save(this._graph.store, artifactFile.fsPath, project, { slim: true }, (writtenMB) => {
					// 每 32MB 报一次保存进度（避免大图谱保存期间 UI 看似假死）
					if (writtenMB - lastLoggedMB >= 32) {
						lastLoggedMB = writtenMB;
						this._onDidIndexProgress.fire(`💾 保存图谱: ${writtenMB.toFixed(0)} MB...`);
					}
				});
			} else {
				this._logService.info('[CodebaseGraph]', `跳过 JSON 制品序列化（artifactFormat=sqlite 且快照已校验）—— renderer 不再做全图 gzip+JSON ✓`);
			}

			// ★★ `artifact.json` 必须**两条路径都写**（它是 `canSkipArtifactParse` 的唯一数据源，见上）。
			// 原子写（先 .tmp 再改名）：它是「是否跳过解析」的判据，半写会误导判断 ✗。
			try {
				const metaPath = artifactFile.fsPath.replace(/graph\.db\.\w+$/, 'artifact.json');
				const metaTmp = metaPath + '.tmp';
				const meta = {
					node_count: expectedNodes,
					edge_count: expectedEdges,
					format: snapshotOk && artifactFormat !== 'json' ? 'sqlite-snapshot' : 'gzip-json',
					saved_at: Date.now(),
					project: project ?? null,
				};
				await this._fileService.writeFile(URI.file(metaTmp), VSBuffer.fromString(JSON.stringify(meta, null, 2)));
				await this._fileService.move(URI.file(metaTmp), URI.file(metaPath), true);
			} catch (err: any) {
				this._logService.warn('[CodebaseGraph]', `artifact.json 写出失败（会让下次载入保守地回到解析路径）：${err?.message || err}`);
			}
			this._logService.info('[CodebaseGraph]', `Graph saved: ${artifactFile.fsPath} (project=${project ?? 'all'}, ${savedCount} nodes)`);
			// 记录 zst 全量落盘时刻，作为增量路径节流基准（ZST_SAVE_MIN_INTERVAL_MS）
			this._lastZstSaveAt = Date.now();
			} catch (err: any) {
				// best-effort 不等于静默：保存失败（如大图谱序列化 OOM）必须可见，否则启动加载不到图会莫名全量重建
				this._logService.warn('[CodebaseGraph]', `Graph save failed: ${artifactFile.fsPath}: ${err?.message || err}`);
			}
		} catch (err: any) {
			this._logService.warn('[CodebaseGraph]', `Failed to save graph: ${err?.message || err}`);
		}
	}


	// ─── Exclude Dirs Resolution (P1/P3/P4) ──────────────────────────────────

	// 排除集解析已拆到 CodebaseGraphExcludeResolver（P1-5，2026-09-09）。
	// 注意：档位基线由 resolver 统一解析，此处不再重复（避免两处口径漂移）。

	// ─── File Scanning ───────────────────────────────────────────────────────
	// 文件遍历（含 keepDirs 例外下钻）已拆到 CodebaseGraphScanner（P1-5，2026-09-09）。

	private _getExtension(fileName: string): string {
		const idx = fileName.lastIndexOf('.');
		return idx >= 0 ? fileName.substring(idx).toLowerCase() : '';
	}

	/** 取路径最后一段作为默认项目名（多 folder：每 folder 用其目录名作项目名）。 */
	private _basename(p: string): string {
		const norm = p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
		const idx = norm.lastIndexOf('/');
		return idx >= 0 ? norm.substring(idx + 1) : norm;
	}

	/** 归一化 rootPath 作为 _rootProjectMap 的键（去尾分隔符、统一为 /、小写盘符）。 */
	private _normalizeRoot(p: string): string {
		return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
	}

	/**
	 * 解析「当前活跃项目」= 当前工作区 folders[0] 对应的项目名。
	 *
	 * 2026-09-15 修（用户报「当前工作区是 sarosis，却按 S1Game 检索」）：
	 * `_projectName` 原先是「**首个完成的 loadGraphMerge** 胜」（`if (_projectName === '_default')`），
	 * 而工作区切换走 `replaceWorkspaceFoldersInMemory()`（**不 reload**，见 WorkspaceSwitch 日志）
	 * ⇒ 同一个 renderer 里多个工作区的图**并发**合并进同一 store，先完成者把 `_projectName`
	 * 永久钉住。实测时间线（日志 20260915T132615）：
	 *   13:26:23 切到 sarosis（merge 启动，21.6s 才完成）
	 *   13:26:30 切到 S1Game+UE5EA（merge 启动，11.0s 就完成）
	 *   13:26:42 S1Game 先完成 ⇒ `_projectName = "S1Game"`
	 *   13:26:45 sarosis 完成 ⇒ 因 `_projectName !== '_default'` **不再更新**
	 * 后果：`searchGraphAsync` 的 `params.project ?? this._projectName` 收敛到 S1Game，
	 * 把 sqlite 跨项目搜回的 89 条 sarosis 命中全部丢弃（find symbol 0 结果）。
	 *
	 * 判据顺序：`_rootProjectMap`（真实索引/加载过的映射）→ folder 目录名（与 bootstrap 的
	 * `projectOverride = _basename(folder)` 口径一致，解决「映射尚未建立」的窗口期）→ fallback。
	 */
	private _resolveActiveProject(fallback?: string): string {
		const folders = this._workspaceService.getWorkspace().folders;
		for (const f of folders) {
			const mapped = this._rootProjectMap.get(this._normalizeRoot(f.uri.fsPath));
			if (mapped) { return mapped; }
		}
		const first = folders[0];
		if (first) {
			const byName = this._basename(first.uri.fsPath);
			if (byName) { return byName; }
		}
		return fallback ?? this._projectName;
	}

	/**
	 * 改写 `_projectName`，但**全量索引进行中时拒绝**（2026-09-15）。
	 *
	 * 为什么需要：`indexWorkspace` 的 post-passes（`_matchCallsToDefinitions` /
	 * `_matchInheritsToDefinitions` / `_matchUsageEdgesToDefinitions` / `_propagateInterprocedural` /
	 * `_runSimilarityPass` / `_runExtendedPasses`）内部仍直接读 `this._projectName`。
	 * 一轮全量索引要跑数分钟，期间 bootstrap 的 `loadGraphMerge`（大图 10~40s，**极易重叠**）、
	 * 工作区切换或 viewer 的 `_autoDetectProjectName` 若改写它 ⇒ 这些 pass 产出的边会被打上
	 * 错误的 project，随后被 `_saveGraph(projectName)` 过滤掉 ⇒ **CALLS/克隆/Leiden 边静默丢失**。
	 *
	 * 索引内**直接**读点已改成本轮局部常量 `projectName`（见 `indexWorkspace`），本方法覆盖
	 * helper 内部读点这一残余面。索引结束后无需补偿：查询缺省值一律走 `_resolveActiveProject()`
	 * （不依赖本字段），下一次 index/merge 会把它重新对齐。
	 */
	private _setProjectNameUnlessIndexing(project: string): void {
		if (!project) { return; }
		if (this._isIndexing) {
			this._logService.debug('[CodebaseGraph]', `[projectName] deferred "${project}" — full/incremental index in progress (keeping "${this._projectName}")`);
			return;
		}
		this._projectName = project;
	}

	/** 当前工作区各 folder 对应的项目名（`_rootProjectMap` 优先，缺失时回落目录名）。 */
	private _workspaceProjects(): string[] {
		const out: string[] = [];
		for (const f of this._workspaceService.getWorkspace().folders) {
			const name = this._rootProjectMap.get(this._normalizeRoot(f.uri.fsPath)) || this._basename(f.uri.fsPath);
			if (name && !out.includes(name)) { out.push(name); }
		}
		return out;
	}

	/**
	 * 归一化 rootPath 是否仍属于当前工作区。
	 * 无工作区（启动早期 / 空窗口）时返回 true —— 宁可不判断，也不误删。
	 */
	private _isRootInCurrentWorkspace(normRoot: string): boolean {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) { return true; }
		return folders.some(f => this._normalizeRoot(f.uri.fsPath) === normRoot);
	}

	/**
	 * 丢弃**不属于当前工作区**的项目数据（2026-09-15，用户报「工作区是 sarosis 却按 S1Game 检索」）。
	 *
	 * 为什么需要：本服务是窗口内单例，而工作区切换走 `replaceWorkspaceFoldersInMemory()`
	 * （不 reload renderer）⇒ 旧工作区的图永久驻留内存。实测同窗口 3 个工作区共 111.9 万节点，
	 * 直接后果有二：① `_projectName` / `searchGraphAsync` 的项目收敛指向别的项目；
	 * ② 巨量堆 + 每 folder 一个 watcher，是「UI 卡死」的既有根因。
	 *
	 * **只动内存**：主进程 SQLite 是跨工作区共享的持久层，其数据保留（下次切回该工作区可直接复用，
	 * 无需重建）。同时收敛 `_rootProjectMap`（否则 `_resolveActiveProject` 仍会指向已丢弃的项目）。
	 *
	 * @returns 被丢弃的项目名（含节点数），供日志/诊断
	 */
	private _pruneForeignProjects(reason: string): string[] {
		// ★ 2026-09-16 诊断（用户报「切换工作区就卡住」）：本方法是**同步删数据**（实测一次丢
		// 176836 个节点 —— store 清理 + BM25/QN/文件哈希 + cypher/semantic 引擎失效），
		// 与紧随其后的图谱加载叠在一起就是用户感知的卡住。打阶段标记 + 总耗时。
		wsStage(`graph: prune 外来项目（删 store 数据，reason=${reason}）`);
		const tPrune = Date.now();
		// ★ 2026-09-16：工作区变了 ⇒ 重置「按需加载失败记忆」。
		// 新工作区可能是另一份健康的图，不该继承上一个工作区的失败退避 —— 否则用户
		// "换个工作区"却会发现图功能仍然不可用（见 `tryLoadFromSqlite` 的注释）。
		this._resetSqliteLoadFailures();
		// ① 先停掉已不属于本工作区的 watcher 根。顺序很重要：watcher 每轮（5~60s）会检测变更并
		//    fire 事件，`_onWatcherChange` 会为「已丢弃的项目」再跑增量索引，把刚清掉的数据
		//    **重新建回来**（与 prune 互相抵消）。所以必须先断掉事件源，再清数据。
		const unwatched: string[] = [];
		for (const root of this._graphWatcher.getWatchedRoots()) {
			if (!this._isRootInCurrentWorkspace(this._normalizeRoot(root))) {
				if (this._graphWatcher.unwatch(root) > 0) { unwatched.push(root); }
			}
		}

		// ①b ★★★ 2026-09-15（**数据丢失事故的源头**）：**先取消这些 root 已排队的延迟落盘**。
		//
		// 增量索引结束时 `_scheduleSaveGraph(rootPath, project)` 会排入一个 30s 防抖定时器；
		// 若期间用户切走工作区，下面第 ② 步会把该项目从 store 删掉，而**那个定时器随后才触发**
		// ⇒ `_saveGraph` 拿到的子图已是 0 节点 ⇒ 用空图覆盖磁盘上完好的制品
		// （实测：8.2MB / 176620 节点的 `graph.db.zst` 被改写成 **99 字节**）。
		// ⇒ 必须在删数据**之前**把定时器拆掉。（`_saveGraph` 里另有一道「空子图不写盘」的守卫兜底。）
		//
		// 判据用 **root 是否仍在当前工作区**，而不是项目名：`_pendingSaves` 的 `project` 可能
		// 为 `undefined`（全量保存），只有 root 可靠。
		const cancelled: string[] = [];
		for (const [key, pending] of [...this._pendingSaves]) {
			if (!this._isRootInCurrentWorkspace(key)) {
				clearTimeout(pending.timer);
				this._pendingSaves.delete(key);
				cancelled.push(pending.rootPath);
			}
		}
		if (cancelled.length > 0) {
			this._logService.info('[CodebaseGraph]',
				`[prune] cancelled ${cancelled.length} queued graph save(s) for roots that left the workspace: ${cancelled.join(', ')}`);
		}

		// ② 丢弃内存 store 中不属于当前工作区的项目。
		//    判据下沉为纯函数（`planForeignProjectPrune`，有单测）：无工作区 ⇒ 返回空 ⇒ 不误删。
		//    ★ 2026-09-16：判据从「项目名」升级为「**root**」（用户报同名 S1Game 互相污染）——
		//    切到 D:\GR_\S1Game 时，内存里来自 D:\PJDB\S1Game 的同名项目必须被丢弃。
		const keep = this._workspaceProjects();
		const projects = this._graph.store.listProjects();
		const wsRoots = this._workspaceService.getWorkspace().folders.map(f => this._normalizeRoot(f.uri.fsPath));
		const victims = planForeignProjectPrune(projects.map(p => p.name), keep, this._rootProjectMap, wsRoots);
		const nodeCounts = new Map(projects.map(p => [p.name, p.nodeCount]));
		const dropped: string[] = [];
		for (const name of victims) {
			try {
				this.deleteProject(name); // 含 store 清理（节点/边/BM25/QN/文件哈希）+ cypher/semantic 引擎失效
				this._sqliteEmptyProjects.delete(name);
				dropped.push(`${name}(${nodeCounts.get(name) ?? 0})`);
			} catch (err: any) {
				this._logService.warn('[CodebaseGraph]', `[prune] deleteProject "${name}" failed: ${err?.message || err}`);
			}
		}

		// ③ **同名多 root 的残留告警**（2026-09-16）：store / SQLite 以**项目名**为唯一键，
		// 所以「一个项目名对应多个 root」（GR_\S1Game 与 PJDB\S1Game 都被加载过）时，两份数据在
		// 内存里已经合并、无法再按 root 拆开 ⇒ 这里只**告警**（不擅自丢弃 —— 那会把当前工作区的
		// 数据一起删掉）。用户视角的症状是「检索结果串进了另一个同名工程的内容」，看到此告警
		// 即可确认；彻底修需要「项目名按 root 唯一」。
		// ⚠ 必须在 ④ 删映射**之前**统计：否则外来 root 的痕迹已被抹掉，永远统计不到。
		const wsRootSet = new Set(wsRoots);
		const sameNameMixed: string[] = [];
		if (wsRootSet.size > 0) {
			for (const p of projects.map(x => x.name)) {
				if (!keep.includes(p)) { continue; } // 已被丢弃 ⇒ 无残留问题
				const roots = [...this._rootProjectMap].filter(([, proj]) => proj === p).map(([r]) => r);
				const foreign = roots.filter(r => !wsRootSet.has(r));
				if (foreign.length > 0) { sameNameMixed.push(`${p}(外: ${foreign.join(', ')})`); }
			}
		}

		// ④ 映射同步收敛：丢掉**根已不属于当前工作区**的映射。
		// ★ 2026-09-16：原判据是「项目名不在 keep 里」（`!keepSet.has(proj)`）—— 同名不同 root 时，
		// 旧工作区（PJDB\S1Game）的映射会因名字恰好也是当前工作区的项目名而被**保留** ✗，
		// 于是它以「已注册」的身份继续参与 ② 的 root 判据、并让 `_resolveActiveProject` 有歧义。
		// 改为以**根**为准（与 ② 同一把尺子）。
		const droppedMappings: string[] = [];
		for (const [root, proj] of [...this._rootProjectMap]) {
			if (!wsRootSet.has(root)) {
				this._rootProjectMap.delete(root);
				droppedMappings.push(`${proj}@${root}`);
			}
		}

		if (sameNameMixed.length > 0) {
			this._logService.warn('[CodebaseGraph]', `[prune] same-name project(s) span multiple roots — data already merged under one project key, cannot split by root: ${sameNameMixed.join('; ')}`);
		}

		if (dropped.length > 0 || unwatched.length > 0 || droppedMappings.length > 0) {
			// 索引进行中时不改写字段（见 `_setProjectNameUnlessIndexing`）；日志用实时解析值，避免打印陈旧字段
			const activeProject = this._resolveActiveProject();
			this._setProjectNameUnlessIndexing(activeProject);
			this._logService.warn('[CodebaseGraph]', `[prune] dropped non-workspace project(s): ${dropped.join(', ') || '(none)'}` +
				`${unwatched.length > 0 ? `; stopped watching: ${unwatched.join(', ')}` : ''}` +
				`${droppedMappings.length > 0 ? `; pruned stale root mapping(s): ${droppedMappings.join(', ')}` : ''}` +
				` (reason=${reason}); store nodes=${this._graph.nodeCount}, project="${activeProject}"`);
		}
		// ★ 2026-09-16 诊断：本方法**总是**报耗时（含「什么都没丢」的快路径）——
		// 否则「切换卡住」时无法区分「prune 慢」与「prune 很快、是别处慢」。
		this._logService.info('[CodebaseGraph]', `[prune] 完成（${Date.now() - tPrune}ms）：丢弃 ${dropped.length} 个项目、后续延迟保存 ${cancelled.length} 个、过期映射 ${droppedMappings.length} 个（reason=${reason}）`);
		return dropped;
	}

	// ─── Tree-sitter Parsing ────────────────────────────────────────────────

	private async _getParser(wasmLang: string): Promise<{ parser: TreeSitterParser; language: TreeSitterLanguage } | undefined> {
		if (this._parsers.has(wasmLang) && this._languages.has(wasmLang)) {
			return { parser: this._parsers.get(wasmLang)!, language: this._languages.get(wasmLang)! };
		}

		try {
			const language = await this._treeSitterLib.getLanguagePromise(wasmLang);
			if (!language) {
				this._logService.debug('[CodebaseGraph]', `Language not available: ${wasmLang}`);
				return undefined;
			}
			const ParserClass = await this._treeSitterLib.getParserClass();
			const parser = new ParserClass();
			parser.setLanguage(language);
			this._parsers.set(wasmLang, parser);
			this._languages.set(wasmLang, language);
			return { parser, language };
		} catch (err: any) {
			this._logService.debug('[CodebaseGraph]', `Failed to load parser ${wasmLang}: ${err?.message || err}`);
			return undefined;
		}
	}

	private async _parseFile(filePath: string, token: CancellationToken): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; status: FileCoverageStatus; reason?: string }> {
		const ext = this._getExtension(filePath);
		const wasmLang = EXTENSION_TO_WASM_LANG[ext];
		if (!wasmLang) { return { nodes: [], edges: [], status: 'skipped', reason: `unsupported extension .${ext}` }; }

		// 优先走 Worker 池解析（与全量索引同一机制，打包 app 中可用）。
		// 背景（2026-08-29）：增量索引若走主线程 TreeSitterLibraryService.getLanguagePromise，
		// 其内部 importAMDNodeModule 会把 @vscode/tree-sitter-wasm/wasm/tree-sitter.js 以
		// vscode-file:// 网络 GET 加载，在打包 app 中 ERR_FILE_NOT_FOUND（该 scheme 下不可加载）。
		// 全量索引之所以不报错，是因为 Worker 内部改用 fileService(asFileUri) 读取同一文件，
		// file:// 由磁盘 FS provider 处理、路径可用。故增量解析必须复用 Worker 池，避开主线程加载路径。
		const workerReady = await this._ensureWorkerPool();
		if (workerReady && this._parserWorkers.length > 0) {
			const content = await this._fileService.readFile(URI.file(filePath));
			const source = content.value.toString();

			if (source.length > MAX_FILE_SIZE) {
				return { nodes: [], edges: [], status: 'skipped', reason: `file too large (${source.length} > ${MAX_FILE_SIZE})` };
			}
			// 跳过超长行文件（minified/生成代码会导致 tree-sitter 挂起）
			if (source.indexOf('\n', 0) === -1 && source.length > 50000) {
				return { nodes: [], edges: [], status: 'skipped', reason: 'single-line file > 50KB (minified?)' };
			}
			{
				let maxLineLen = 0;
				const lines = source.split('\n');
				const checkLines = Math.min(lines.length, 100);
				for (let li = 0; li < checkLines; li++) { if (lines[li].length > maxLineLen) { maxLineLen = lines[li].length; } }
				if (maxLineLen > MAX_LINE_LENGTH) {
					return { nodes: [], edges: [], status: 'skipped', reason: `line too long (${maxLineLen} > ${MAX_LINE_LENGTH})` };
				}
			}
			const id = ++this._parseReqId;
			const worker = this._parserWorkers[id % this._parserWorkers.length];
			// 必须传相对路径：Worker 内 walkAST 直接把 filePath 写进节点（全量索引传 relPath，
			// 回归 2026-09-08：增量曾传绝对路径 → 图里 filePath 混入 g:\... 绝对路径，
			// OpenFileModal joinPath(root, abs) 拼出错误路径静默打不开）。
			return await this._parseViaWorker(worker, id, source, wasmLang, this._getRelativePath(filePath));
		}

		// Fallback（dev/非打包环境）：主线程解析（依赖 importAMDNodeModule 加载 tree-sitter）。
		// 仅当 Worker 池不可用（极少见）时回退——此时打包 app 同样可能因文件缺失而失败，
		// 但路径与全量索引一致，不会因 scheme 差异凭空报错。
		const parserResult = await this._getParser(wasmLang);
		if (!parserResult) { return { nodes: [], edges: [], status: 'skipped', reason: `no parser for .${ext}` }; }

		const { parser } = parserResult;

		try {
			const fileUri = URI.file(filePath);
			const content = await this._fileService.readFile(fileUri);
			const source = content.value.toString();

			if (source.length > MAX_FILE_SIZE) {
				this._logService.debug('[CodebaseGraph]', `File too large: ${filePath}`);
				return { nodes: [], edges: [], status: 'skipped', reason: `file too large (${source.length} > ${MAX_FILE_SIZE})` };
			}
			// 跳过超长行文件（minified/生成代码会导致 tree-sitter 挂起）
			if (source.indexOf('\n', 0) === -1 && source.length > 50000) {
				return { nodes: [], edges: [], status: 'skipped', reason: 'single-line file > 50KB (minified?)' };
			}
			{
				let maxLineLen = 0;
				const lines = source.split('\n');
				const checkLines = Math.min(lines.length, 100);
				for (let li = 0; li < checkLines; li++) { if (lines[li].length > maxLineLen) { maxLineLen = lines[li].length; } }
				if (maxLineLen > MAX_LINE_LENGTH) {
					return { nodes: [], edges: [], status: 'skipped', reason: `line too long (${maxLineLen} > ${MAX_LINE_LENGTH})` };
				}
			}

		const tree = parser.parse(source);
		if (!tree) { return { nodes: [], edges: [], status: 'parse_error', reason: 'tree-sitter returned null' }; }

		try {
			const nodes: GraphNode[] = [];
			const edges: GraphEdge[] = [];
			const relPath = this._getRelativePath(filePath);

			// Walk AST and extract nodes/edges
			this._walkAST(tree.rootNode, source, relPath, nodes, edges);

			const status: FileCoverageStatus = nodes.length > 0 ? 'indexed' : 'indexed';
			return { nodes, edges, status, reason: nodes.length === 0 ? 'no definitions found' : undefined };
		} finally {
			// 必须释放：每棵语法树都占 WASM 线性内存，不释放数万棵后
			// ts_malloc_default 分配失败 → abort()（曾致 13k 文件后连续 Aborted 崩溃）
			tree.delete();
		}
		} catch (err: any) {
			this._logService.debug('[CodebaseGraph]', `Parse failed ${filePath}: ${err?.message || err}`);
			return { nodes: [], edges: [], status: 'parse_error', reason: err?.message || String(err) };
		}
	}

	private _walkAST(node: any, source: string, filePath: string, nodes: GraphNode[], edges: GraphEdge[], loopDepth: number = 0, currentFnId?: string): void {
		const nodeType = AST_TO_NODE_TYPE[node.type];

		// 调用边采集（在循环上下文中记录 caller / callee / loopDepth）→ 供 #9 过程间传播与 trace_path
		if (currentFnId && (node.type === 'call_expression' || node.type === 'call' || node.type === 'method_invocation' || node.type === 'invocation_expression')) {
			const callee = this._extractCalleeName(node, source);
			if (callee) {
				edges.push({ source: currentFnId, target: `call:${callee}`, type: 'CALLS', properties: { loopDepth } });
			}
		}

		// 使用边采集（读写区分）→ 供 Find References 读/写过滤（对齐 VAX）
		if (currentFnId && this._isUsageNode(node.type)) {
			this._collectUsageEdges(node, source, currentFnId, edges);
		}

		let enclosingFnId = currentFnId;
		if (nodeType) {
			const name = this._extractName(node, source);
			if (name) {
				const qualifiedName = `${filePath}::${name}`;
				const startLine = node.startPosition?.row ? node.startPosition.row + 1 : undefined;
				const endLine = node.endPosition?.row ? node.endPosition.row + 1 : undefined;

		// 计算该节点子树内的圈复杂度、认知复杂度、最大循环深度、循环数、参数数
		const { cyclomatic, maxLoopDepth, cognitive, loopCount, paramCount } = this._computeComplexity(node);

		// 过程内高阶热路径指标（#9 过程间传播的基础）
		const intra = (nodeType === 'function' || nodeType === 'method')
			? this._analyzeIntraProcedural(node, source, name)
			: undefined;

		// 计算代码体 MinHash 签名（函数/方法），供 #7 克隆检测使用。
		let minHashSig: number[] | undefined;
		if (nodeType === 'function' || nodeType === 'method') {
			const codeTokens = this._collectCodeTokens(node, this._codeTokenCap);
			if (codeTokens.length > 0) {
				minHashSig = this._getMinHasher().compute(codeTokens);
			}
		}

		const hasMetrics = cyclomatic > 0 || maxLoopDepth > 0 || cognitive > 0;
		const props: Record<string, any> | undefined =
			(hasMetrics || minHashSig || intra) ? {
				...(hasMetrics ? { cyclomatic, loop_depth: maxLoopDepth, cognitive, loop_count: loopCount, param_count: paramCount } : {}),
				...(minHashSig ? { minHash: minHashSig } : {}),
				...(intra ? {
					linear_scan_in_loop: intra.linearScanInLoop ? 1 : 0,
					alloc_in_loop: intra.allocInLoop ? 1 : 0,
					recursion_in_loop: intra.recursionInLoop ? 1 : 0,
					unguarded_recursion: intra.unguardedRecursion ? 1 : 0,
				} : {}),
			} : undefined;

			nodes.push({
				id: qualifiedName,
				name,
				type: nodeType,
				filePath,
				qualifiedName,
				inDegree: 0,
				outDegree: 0,
				startLine,
				endLine,
				properties: props,
			});

				// Add file containment edge
				edges.push({
					source: filePath,
					target: qualifiedName,
					type: 'CONTAINS',
				});

				// 继承/接口实现边（虚拟目标 inherits:/implements:<baseName>，
				// 索引后由 _matchInheritsToDefinitions 解析为真实 INHERITS/IMPLEMENTS 边）
				if (nodeType === 'class' || nodeType === 'interface') {
					// C++ base_class_clause 不区分 kind，只产 INHERITS（避免 implements 分支重复收集）
					const isCpp = node.type === 'class_specifier' || node.type === 'struct_specifier';
					for (const base of extractInherits(node, 'extends')) {
						edges.push({ source: qualifiedName, target: `inherits:${base}`, type: 'INHERITS' });
					}
					if (!isCpp) {
						for (const base of extractInherits(node, 'implements')) {
							edges.push({ source: qualifiedName, target: `implements:${base}`, type: 'IMPLEMENTS' });
						}
					}
				}

				enclosingFnId = qualifiedName;
			}
		}

		// 跟踪循环嵌套深度
		const nextLoopDepth = LOOP_NODE_TYPES.has(node.type) ? loopDepth + 1 : loopDepth;

		// Recurse into children
		if (node.children) {
			for (const child of node.children) {
				this._walkAST(child, source, filePath, nodes, edges, nextLoopDepth, enclosingFnId);
			}
		}
	}

	/** 复用单个 MinHash 实例（签名长度 MINHASH_PERM），避免每个函数重建排列。 */
	private _getMinHasher(): MinHash {
		if (!this._minHasher) { this._minHasher = new MinHash(MINHASH_PERM); }
		return this._minHasher;
	}

	/**
	 * 抽取函数子树的代码体 token 流，用于 MinHash 克隆检测。
	 * 混合「结构 token (node.type)」与「标识符/字面量文本」，对重命名鲁棒、对结构变化敏感。
	 * 上限 cap 个 token（避免超大函数爆炸），先序遍历即可。
	 */
	private _collectCodeTokens(node: any, cap: number): string[] {
		const tokens: string[] = [];
		const stack: any[] = [node];
		while (stack.length > 0 && tokens.length < cap) {
			const n = stack.pop();
			if (!n || !n.type) { continue; }
			tokens.push(n.type);
			// 叶子：标识符 / 字段 / 属性 / 字符串 / 数字 —— 带上文本以区分不同实现
			if ((!n.children || n.children.length === 0)) {
				if (/identifier|property|field|string|number|true|false|null/i.test(n.type)) {
					const txt = typeof n.text === 'string' ? n.text : '';
					if (txt && txt.length <= 40) { tokens.push('v:' + txt); }
				}
			}
			if (n.children) {
				for (let i = n.children.length - 1; i >= 0; i--) { stack.push(n.children[i]); }
			}
		}
		return tokens;
	}

	/** 遍历节点子树，计算圈复杂度、认知复杂度、最大循环深度、循环数、参数数 */
	private _computeComplexity(node: any): { cyclomatic: number; maxLoopDepth: number; cognitive: number; loopCount: number; paramCount: number } {
		let cyclomatic = 0;
		let maxLoopDepth = 0;
		let cognitive = 0;
		let loopCount = 0;

		const traverse = (n: any, currentLoopDepth: number, nesting: number): void => {
			// 计数分支节点（循环节点同时是分支点；用 else-if 避免认知复杂度重复计数）
			let isStructure = false;
			if (LOOP_NODE_TYPES.has(n.type)) {
				loopCount++;
				cyclomatic++;
				cognitive += 1 + nesting;
				currentLoopDepth++;
				if (currentLoopDepth > maxLoopDepth) {
					maxLoopDepth = currentLoopDepth;
				}
				isStructure = true;
			} else if (BRANCH_NODE_TYPES.has(n.type)) {
				cyclomatic++;
				cognitive += 1 + nesting;
				isStructure = true;
			}

			const nextNesting = isStructure ? nesting + 1 : nesting;
			if (n.children) {
				for (const child of n.children) {
					traverse(child, currentLoopDepth, nextNesting);
				}
			}
		};

		traverse(node, 0, 0);

		// 参数数：从 parameters 字段统计形参
		let paramCount = 0;
		const paramsField = node.childForFieldName?.('parameters') ?? node.childForFieldName?.('parameters');
		const paramsNode = paramsField || this._findChildByType(node, 'parameters');
		if (paramsNode) {
			for (const p of paramsNode.children || []) {
				if (p.type === 'identifier' || p.type === 'formal_parameter' || p.type === 'parameter' ||
					p.type === 'required_parameter' || p.type === 'optional_parameter' || p.type === 'typed_parameter') {
					paramCount++;
				}
			}
		}

		return { cyclomatic, maxLoopDepth, cognitive, loopCount, paramCount };
	}

	/**
	 * 提取调用表达式的被调函数名（函数名或 method_expression 的方法名）。
	 * 供 _analyzeIntraProcedural 与 _walkAST 的调用边采集共用。
	 */
	/** USAGE 提取关注的 AST 节点类型（赋值=写引用，其余=读引用）。 */
	private _isUsageNode(nodeType: string): boolean {
		return nodeType === 'assignment_expression' || nodeType === 'assignment' ||
			nodeType === 'augmented_assignment_expression' || nodeType === 'compound_assignment_expression' ||
			nodeType === 'type_annotation' || nodeType === 'type_identifier' || nodeType === 'type_hint' ||
			nodeType === 'new_expression' || nodeType === 'object_creation_expression';
	}

	/** 从赋值/类型注解/构造节点中提取 USAGE 虚拟边（access=read|write），仅当有明确目标名时。 */
	private _collectUsageEdges(node: any, source: string, currentFnId: string, edges: GraphEdge[]): void {
		const add = (name: string | undefined, access: 'read' | 'write'): void => {
			if (name && name.length > 0 && name !== 'this') {
				edges.push({ source: currentFnId, target: `usage:${name}`, type: 'USAGE', properties: { access } });
			}
		};
		// 赋值：左侧为目标变量（写），右侧可有条件地取引用（读）——为控制边数，仅记录左侧
		if (node.type === 'assignment_expression' || node.type === 'assignment' ||
			node.type === 'augmented_assignment_expression' || node.type === 'compound_assignment_expression') {
			const left = node.childForFieldName ? (node.childForFieldName('left') ?? node.childForFieldName('target')) : undefined;
			if (left) {
				if (left.type === 'identifier' || left.type === 'field_identifier') {
					add(source.substring(left.startIndex, left.endIndex), 'write');
				} else if (left.childForFieldName) {
					const prop = left.childForFieldName('property') ?? left.childForFieldName('field');
					if (prop && (prop.type === 'property_identifier' || prop.type === 'identifier')) {
						add(source.substring(prop.startIndex, prop.endIndex), 'write');
					}
				}
			}
			return;
		}
		// 类型注解 / 类型引用：读
		if (node.type === 'type_annotation' || node.type === 'type_hint') {
			for (const child of node.children || []) {
				if (child.type === 'type_identifier' || child.type === 'identifier') {
					add(source.substring(child.startIndex, child.endIndex), 'read');
				}
			}
			return;
		}
		if (node.type === 'type_identifier') {
			add(source.substring(node.startIndex, node.endIndex), 'read');
			return;
		}
		// 构造表达式：读
		if (node.type === 'new_expression' || node.type === 'object_creation_expression') {
			const ctor = node.childForFieldName ? (node.childForFieldName('constructor') ?? node.childForFieldName('type') ?? node.childForFieldName('class')) : undefined;
			if (ctor) {
				add(source.substring(ctor.startIndex, ctor.endIndex), 'read');
			}
		}
	}

	private _extractCalleeName(node: any, source: string): string | undefined {
		const fnNode = node.childForFieldName ? node.childForFieldName('function') : undefined;
		if (fnNode) {
			const name = this._extractName(fnNode, source);
			if (name) { return name; }
			if (fnNode.type === 'member_expression') {
				const prop = fnNode.childForFieldName ? fnNode.childForFieldName('property') : undefined;
				if (prop) { return source.substring(prop.startIndex, prop.endIndex); }
			}
			return undefined;
		}
		return undefined;
	}

	/**
	 * 过程内高阶热路径分析（#9 过程间传播的基础）。
	 * 遍历函数子树，启发式判定循环内线性扫描 / 分配 / 自递归 / 无保护递归。
	 * 目标：对齐 C 版 pass_complexity.c 的高阶指标集，使这些属性可在 Cypher 中查询。
	 */
	private _analyzeIntraProcedural(node: any, source: string, fnName: string): {
		linearScanInLoop: boolean; allocInLoop: boolean; recursionInLoop: boolean; unguardedRecursion: boolean;
	} {
		const ITERATOR_APIS = new Set([
			'forEach', 'map', 'filter', 'reduce', 'reduceRight', 'find', 'findIndex',
			'some', 'every', 'flatMap', 'each', 'collect', 'eachChild', 'walk', 'each', 'iterate',
		]);
		const ALLOC_APIS = new Set([
			'new', 'alloc', 'allocate', 'create', 'make', 'build', 'malloc', 'construct', 'clone',
		]);
		let linearScanInLoop = false;
		let allocInLoop = false;
		let recursionInLoop = false;
		let isRecursive = false;
		let unguardedRecursion = false;

		const visit = (n: any, loopDepth: number, underGuard: boolean): void => {
			if (n.type === 'call_expression' || n.type === 'call' || n.type === 'method_invocation' || n.type === 'invocation_expression') {
				const callee = this._extractCalleeName(n, source);
				if (callee) {
					if (callee === fnName) {
						isRecursive = true;
						if (loopDepth > 0) { recursionInLoop = true; }
						// 无保护递归：递归调用未被任何条件分支直接祖先守卫
						if (!underGuard) { unguardedRecursion = true; }
					}
					if (loopDepth > 0) {
						if (ITERATOR_APIS.has(callee)) { linearScanInLoop = true; }
						if (ALLOC_APIS.has(callee)) { allocInLoop = true; }
					}
				}
			}
			// 循环内的对象分配
			if (loopDepth > 0 && n.type === 'new_expression') { allocInLoop = true; }

			const isGuard = n.type === 'if_statement' || n.type === 'conditional_expression' ||
				n.type === 'ternary_expression' || n.type === 'switch_statement' || n.type === 'when_clause' ||
				n.type === 'match_arm' || n.type === 'else_clause';
			const nextLoop = LOOP_NODE_TYPES.has(n.type) ? loopDepth + 1 : loopDepth;
			const nextGuard = underGuard || isGuard;
			if (n.children) {
				for (const c of n.children) { visit(c, nextLoop, nextGuard); }
			}
		};
		visit(node, 0, false);
		// 仅当函数自递归时，无保护递归才有意义
		if (!isRecursive) { unguardedRecursion = false; }
		return { linearScanInLoop, allocInLoop, recursionInLoop, unguardedRecursion };
	}

	private _findChildByType(node: any, type: string): any {
		if (!node?.children) { return undefined; }
		for (const c of node.children) {
			if (c.type === type) { return c; }
			const found = this._findChildByType(c, type);
			if (found) { return found; }
		}
		return undefined;
	}

	/** 记录单文件索引覆盖率状态（相对路径为 key，保证幂等） */
	private _recordCoverage(relPath: string, status: FileCoverageStatus, reason?: string, nodeCount?: number): void {
		const ext = this._getExtension(relPath);
		this._indexCoverage.set(relPath, { path: relPath, status, reason, nodes: nodeCount, ext });
	}

	/** 解析失败重试上限（会话级内存）：超过后记哈希放弃，防「失败文件每轮 watcher 重报」翻烧饼。 */
	private _parseFailCounts = new Map<string, number>();
	private static readonly PARSE_FAIL_RETRY_MAX = 3;

	/**
	 * 解析后按结果决定是否记录哈希基线（统一全量/增量两条路径的策略）。
	 *
	 * Bug（2026-09-09，快照取证）：旧实现**无论解析成败都记哈希**——全量轮 6000 文件
	 * 解析失败（parse_error/timeout）后哈希照记 → classifyFiles 全判 unchanged →
	 * **失败永久固化**（图只剩被编辑过的文件，Find Symbol 检索不到任何未编辑符号）。
	 * 现在：parse_error/timeout 不记哈希允许重试，但会话内失败超上限后放弃（防翻烧饼）；
	 * 实例重启清零计数——环境修复（如 wasm 可用）后重启即自愈。
	 */
	private async _recordHashAfterParse(project: string, relPath: string, absPath: string, status: FileCoverageStatus): Promise<void> {
		let fails = 0;
		if (status === 'parse_error' || status === 'timeout') {
			fails = (this._parseFailCounts.get(relPath) ?? 0) + 1;
			this._parseFailCounts.set(relPath, fails);
		} else {
			this._parseFailCounts.delete(relPath); // 成功/防护类跳过：清计数
		}
		// 策略判定抽为纯函数（common），可被单测直接覆盖
		if (!shouldRecordHashAfterParse(status, fails, CodebaseGraphService.PARSE_FAIL_RETRY_MAX)) {
			return; // 不记哈希：下次 watcher 轮询重试
		}
		if (fails > 0) {
			this._logService.debug('[CodebaseGraph]', `[parse] ${relPath} failed ${fails}x — recording hash to stop retrying (restart to reset)`);
		}
		await this._recordFileHash(project, relPath, absPath);
	}

	/** 记录文件哈希（仅 mtime+size，避免 SHA-256 开销），供增量重索引的 mtime/size 分类使用。 */
	private async _recordFileHash(project: string, relPath: string, absPath: string): Promise<void> {
		try {
			const stat = await this._fileService.stat(URI.file(absPath));
			this._graph.store.upsertFileHash({
				project,
				relPath,
				sha256: '',
				mtimeNs: stat.mtime * 1_000_000,
				size: stat.size,
			});
			// Phase 2 接线：同步到主进程 SQLite 后端（默认关闭）
			this._syncFileHashToSqlite(project, relPath, '', stat.mtime * 1_000_000, stat.size);
		} catch { /* 忽略哈希记录失败 */ }
	}

	/**
	 * 提取 AST 节点的名称。
	 *
	 * C/C++ tree-sitter 中标识符通常不在直接子节点中：
	 *   function_definition → declarator:function_declarator → declarator:field_identifier
	 *   class_specifier     → name:type_identifier
	 *
	 * 修复（2026-07-04）：递归搜索所有子节点，同时扩展 C++ 特有类型匹配。
	 */
	/**
	 * 从 C/C++ 函数节点沿 declarator 链提取真正函数名。
	 *
	 * 背景（2026-08-06 修复）：tree-sitter-cpp 的 function_definition 结构为
	 *   function_definition → type(返回类型) + declarator:function_declarator → declarator:名称节点
	 * 通用 DFS 先序会先命中返回类型里的 type_identifier（如 `inline TArray<uint8> X::ConvertToArray()`
	 * 会被误取名 "TArray"），必须优先走 declarator 链。支持解包 qualified_identifier
	 * （取 name 字段）、pointer/reference/parenthesized 包装与 operator/destructor 名。
	 */
	private _extractFunctionName(node: any, source: string): string | undefined {
		const isWrapper = (t: string): boolean => t === 'function_declarator' || t === 'pointer_declarator' ||
			t === 'reference_declarator' || t === 'parenthesized_declarator' || t === 'init_declarator';
		// 部分包装（如 reference_declarator 的 function_declarator）没有 declarator 字段，从 children 里找声明符系列
		const findDeclaratorChild = (n: any): any | undefined => {
			for (const c of (n.children || [])) {
				if (isWrapper(c.type)) { return c; }
			}
			return undefined;
		};
		let n: any = node;
		for (let i = 0; i < 12; i++) {
			let decl = n.childForFieldName ? n.childForFieldName('declarator') : undefined;
			if (!decl) { decl = findDeclaratorChild(n); }
			if (!decl) { break; }
			n = decl;
			if (isWrapper(n.type)) { continue; }
			break;
		}
		// qualified_identifier（成员函数定义 X::foo）：name 字段可能嵌套（ns::deep::method → deep::method），循环取最内层
		while (n.type === 'qualified_identifier') {
			const nm = n.childForFieldName ? n.childForFieldName('name') : undefined;
			if (!nm || typeof nm.startIndex !== 'number') { break; }
			if (nm.type === 'qualified_identifier') { n = nm; continue; }
			return source.substring(nm.startIndex, nm.endIndex);
		}
		if (n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier' ||
			n.type === 'destructor_name' || n.type === 'operator_name' || n.type === 'template_name' ||
			n.type === 'namespace_identifier') {
			return source.substring(n.startIndex, n.endIndex);
		}
		return undefined;
	}

	private _extractName(node: any, source: string): string | undefined {
		// C/C++ 函数定义/声明：返回类型（type）在 DFS 中先于函数名，必须优先走 declarator 链
		if (node.type === 'function_definition' || node.type === 'function_declaration' || node.type === 'function_declarator') {
			const fnName = this._extractFunctionName(node, source);
			if (fnName !== undefined) { return fnName; }
		}
		const IDENTIFIER_TYPES = new Set([
			'identifier', 'field_identifier', 'type_identifier',
			'namespace_identifier', 'template_name', 'destructor_name',
		]);

		// 递归搜索子节点树
		const recurse = (n: any): string | undefined => {
			// 如果自身就是标识符
			if (IDENTIFIER_TYPES.has(n.type)) {
				return source.substring(n.startIndex, n.endIndex);
			}
			// 或者有 field name 'name'
			if (n.type === 'name') {
				return source.substring(n.startIndex, n.endIndex);
			}
			// 递归搜索子节点（限制深度避免性能问题）
			for (const child of (n.children || [])) {
				const result = recurse(child);
				if (result !== undefined) { return result; }
			}
			return undefined;
		};

		return recurse(node);
	}

	// ─── Call Matching ─────────────────────────────────────────────────────

	/**
	 * 解析索引期采集的调用边（虚拟目标 call:<name>）为真实 CALLS 边。
	 * 跨文件 callee 解析：优先同文件定义，否则取首个同名定义（启发式）。
	 * 同时写入调用点的 loopDepth，供 #9 过程间 loop 传播使用。
	 */
	private async _matchCallsToDefinitions(): Promise<number> {
		if (this._pendingCallEdges.length === 0) { return 0; }
		const store = this._graph.store;
		const project = this._projectName;

		// 构建 name → nodeId[] 索引（供跨文件 callee 解析）
		const nameIndex = new Map<string, number[]>();
		for (const n of store.getAllNodes()) {
			if (n.project !== project) { continue; }
			const list = nameIndex.get(n.name);
			if (list) { list.push(n.id); } else { nameIndex.set(n.name, [n.id]); }
		}

		let added = 0;
		let sinceYield = 0;
		for (const call of this._pendingCallEdges) {
			// 时间切片：大仓库 36万+ 调用点同步循环会冻结 UI 数秒，定期让出主线程
			if (++sinceYield >= 20000) {
				sinceYield = 0;
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
			const srcNode = store.findNodeByQN(project, call.source);
			if (!srcNode) { continue; }
			const cands = nameIndex.get(call.callee);
			if (!cands || cands.length === 0) { continue; }
			// 跨文件解析：优先同文件 callee
			let targetId = cands[0];
			const srcFile = call.source.split('::')[0];
			for (const cid of cands) {
				const cn = store.getNode(cid);
				if (cn && cn.filePath === srcFile) { targetId = cid; break; }
			}
			const edge = store.insertEdge({
				project,
				sourceId: srcNode.id,
				targetId,
				type: 'CALLS',
				properties: { loopDepth: call.loopDepth },
			});
			if (edge) { added++; }
		}
		this._logService.info('[CodebaseGraph]', `Matched ${added} CALLS edges from ${this._pendingCallEdges.length} call sites`);
		this._pendingCallEdges = [];
		return added;
	}

	/**
	 * 把虚拟继承边（inherits:/implements:<baseName>）解析为真实 INHERITS / IMPLEMENTS 边。
	 * 与 _matchCallsToDefinitions 同构：全局 name → nodeId 索引 + 同文件优先。
	 * 目标必须是 class/interface 节点；未找到（如基类在外部依赖/标准库）则丢弃虚拟边。
	 */
	private async _matchInheritsToDefinitions(): Promise<number> {
		if (this._pendingInheritEdges.length === 0) { return 0; }
		const store = this._graph.store;
		const project = this._projectName;

		// 构建 name → nodeId[] 索引（只收 class/interface，避免把基类误解析到同名函数/变量）
		const nameIndex = new Map<string, number[]>();
		for (const n of store.getAllNodes()) {
			if (n.project !== project) { continue; }
			if (n.label !== 'class' && n.label !== 'interface') { continue; }
			const list = nameIndex.get(n.name);
			if (list) { list.push(n.id); } else { nameIndex.set(n.name, [n.id]); }
		}

		let added = 0;
		let sinceYield = 0;
		for (const inh of this._pendingInheritEdges) {
			// 时间切片：大仓库大量继承点同步循环会冻结 UI
			if (++sinceYield >= 20000) {
				sinceYield = 0;
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
			const srcNode = store.findNodeByQN(project, inh.source);
			if (!srcNode) { continue; }
			const cands = nameIndex.get(inh.baseName);
			if (!cands || cands.length === 0) { continue; }
			// 优先同文件基类（类与其基类常在同头文件声明；跨文件退化为第一个匹配）
			let targetId = cands[0];
			const srcFile = inh.source.split('::')[0];
			for (const cid of cands) {
				const cn = store.getNode(cid);
				if (cn && cn.filePath === srcFile) { targetId = cid; break; }
			}
			const edge = store.insertEdge({
				project,
				sourceId: srcNode.id,
				targetId,
				type: inh.kind,
				properties: {},
			});
			if (edge) { added++; }
		}
		this._logService.info('[CodebaseGraph]', `Matched ${added} INHERITS/IMPLEMENTS edges from ${this._pendingInheritEdges.length} base clauses`);
		this._pendingInheritEdges = [];
		return added;
	}

	/**
	 * 把虚拟使用边（usage:<name>）解析为真实 USAGE 边（携带 access=read|write 属性，
	 * 供 Find References 读/写过滤）。与继承/调用匹配同构：name → nodeId 索引 + 同文件优先。
	 * 目标限定 class/interface/variable（类型与变量引用）；未找到则丢弃虚拟边。
	 */
	private async _matchUsageEdgesToDefinitions(): Promise<number> {
		if (this._pendingUsageEdges.length === 0) { return 0; }
		const store = this._graph.store;
		const project = this._projectName;

		const nameIndex = new Map<string, number[]>();
		for (const n of store.getAllNodes()) {
			if (n.project !== project) { continue; }
			if (n.label !== 'class' && n.label !== 'interface' && n.label !== 'variable') { continue; }
			const list = nameIndex.get(n.name);
			if (list) { list.push(n.id); } else { nameIndex.set(n.name, [n.id]); }
		}

		let added = 0;
		let sinceYield = 0;
		for (const u of this._pendingUsageEdges) {
			if (++sinceYield >= 20000) {
				sinceYield = 0;
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
			const srcNode = store.findNodeByQN(project, u.source);
			if (!srcNode) { continue; }
			const cands = nameIndex.get(u.name);
			if (!cands || cands.length === 0) { continue; }
			let targetId = cands[0];
			const srcFile = u.source.split('::')[0];
			for (const cid of cands) {
				const cn = store.getNode(cid);
				if (cn && cn.filePath === srcFile) { targetId = cid; break; }
			}
			const edge = store.insertEdge({
				project,
				sourceId: srcNode.id,
				targetId,
				type: 'USAGE',
				properties: { access: u.access },
			});
			if (edge) { added++; }
		}
		this._logService.info('[CodebaseGraph]', `Matched ${added} USAGE edges from ${this._pendingUsageEdges.length} usage sites`);
		this._pendingUsageEdges = [];
		return added;
	}

	/**
	 * 过程间热路径传播（#9）。基于已解析的 CALLS 图计算：
	 *  - recursive：函数沿 CALLS 是否自可达（递归）。
	 *  - transitive_loop_depth：沿调用链累计的循环嵌套深度（被循环上下文中的调用间接卷入）。
	 *  - called_in_loop：是否存在 loopDepth>0 的调用点。
	 * 结果写回节点 properties，使其可在 Cypher 中查询。
	 */
	private async _propagateInterprocedural(): Promise<number> {
		const store = this._graph.store;
		const project = this._projectName;
		// 时间切片：26w+ CALLS 边规模下各循环均为百万级运算，同步执行会冻结 UI
		const yieldEvery = async (counter: number, interval: number) => {
			if (counter % interval === 0) { await new Promise<void>(r => setTimeout(r, 0)); }
		};

		const callEdges: { callerId: number; calleeId: number; loopDepth: number }[] = [];
		let ec = 0;
		for (const e of store.getAllEdges()) {
			if (e.project === project && e.type === 'CALLS') {
				callEdges.push({
					callerId: e.sourceId,
					calleeId: e.targetId,
					loopDepth: (e.properties && (e.properties.loopDepth as number)) ?? 0,
				});
			}
			await yieldEvery(++ec, 200000);
		}
		if (callEdges.length === 0) { return 0; }

		// caller → callees
		const callees = new Map<number, { calleeId: number; loopDepth: number }[]>();
		for (const ce of callEdges) {
			let arr = callees.get(ce.callerId);
			if (!arr) { arr = []; callees.set(ce.callerId, arr); }
			arr.push({ calleeId: ce.calleeId, loopDepth: ce.loopDepth });
		}

		// recursive：caller 沿 CALLS 是否可达自身
		const recursive = new Set<number>();
		let sc = 0;
		for (const start of callees.keys()) {
			const visited = new Set<number>();
			const stack: number[] = [start];
			let selfReached = false;
			while (stack.length) {
				const cur = stack.pop()!;
				if (cur === start && visited.size > 0) { selfReached = true; break; }
				if (visited.has(cur)) { continue; }
				visited.add(cur);
				const next = callees.get(cur);
				if (next) {
					for (const n of next) { if (!visited.has(n.calleeId)) { stack.push(n.calleeId); } }
				}
			}
			if (selfReached) { recursive.add(start); }
			await yieldEvery(++sc, 1000);
		}

		// transitive_loop_depth：沿 CALLS 传播 loop 上下文（迭代至收敛；有环时也安全）
		const inherited = new Map<number, number>();
		const calledInLoop = new Set<number>();
		let changed = true;
		let iter = 0;
		while (changed && iter < 200) {
			changed = false; iter++;
			for (const ce of callEdges) {
				const base = inherited.get(ce.callerId) ?? 0;
				const contrib = base + ce.loopDepth;
				if (contrib > (inherited.get(ce.calleeId) ?? 0)) {
					inherited.set(ce.calleeId, contrib);
					changed = true;
				}
				if (ce.loopDepth > 0) { calledInLoop.add(ce.calleeId); }
			}
			// 每轮不动点迭代让出一次（单轮即 26w+ 运算）
			await new Promise<void>(r => setTimeout(r, 0));
		}

		// 写回节点 properties
		let updated = 0;
		for (const n of store.getAllNodes()) {
			if (n.project !== project) { continue; }
			const tloop = inherited.get(n.id) ?? 0;
			const isRec = recursive.has(n.id);
			const cIL = calledInLoop.has(n.id);
			if (tloop > 0 || isRec || cIL) {
				const props = n.properties ? { ...n.properties } : {};
				props.transitive_loop_depth = tloop;
				props.recursive = isRec ? 1 : 0;
				props.called_in_loop = cIL ? 1 : 0;
				n.properties = props;
				updated++;
			}
		}
		this._logService.info('[CodebaseGraph]', `Interprocedural propagated: recursive=${recursive.size}, calledInLoop=${calledInLoop.size}, tloop>0=${[...inherited.values()].filter(v => v > 0).length}`);
		return updated;
	}

	// ─── Extended Passes ──────────────────────────────────────────────────

	private _runExtendedPasses(): number {
		let edgesAdded = 0;
		const store = this._graph.store;
		const project = this._projectName;
		const allNodes = store.getAllNodes().filter(n => n.project === project);

		try {
			// Semantic edges
			const semanticEdges = buildSemanticEdges(allNodes);
			for (const edge of semanticEdges) {
				const srcNode = store.findNodeByQN(project, edge.sourceQN);
				const tgtNode = store.findNodeByQN(project, edge.targetQN);
				if (srcNode && tgtNode) {
					store.insertEdge({
						project,
						sourceId: srcNode.id,
						targetId: tgtNode.id,
						type: 'SEMANTICALLY_RELATED',
						properties: { score: edge.score },
					});
					edgesAdded++;
				}
			}

			this._logService.info('[CodebaseGraph]', `Extended passes (semantic): ${edgesAdded} edges`);
		} catch (err: any) {
			this._logService.debug('[CodebaseGraph]', `Extended passes failed: ${err?.message || err}`);
		}

		return edgesAdded;
	}

	/**
	 * MinHash 代码克隆检测 pass（P2-#7）。基于解析期预计算的函数体签名，
	 * 经 LSH 候选生成 + MinHash 校验，写入 SIMILAR_TO 边。始终运行（非 fast 专属）。
	 *
	 * @param onlyNodeIds 增量模式：仅检测这些节点的克隆关系（新节点 vs 全量），跳过
	 *       全量自配对。不传时走全量检测（首次/手动重建）。旧实现增量时也无参全量
	 *       重扫 12.4w 节点，是单文件保存卡死 renderer 的主因（日志 1787282021811）。
	 */
	private async _runSimilarityPass(onlyNodeIds?: Set<number>): Promise<number> {
		let edgesAdded = 0;
		const store = this._graph.store;
		const project = this._projectName;

		try {
			// 增量模式但本次无任何新/变更节点（如改动的是被跳过的大文件）→ 直接跳过。
			// 旧↔旧的克隆关系全量索引时已生成落盘，此处无需任何工作。
			// Bug（2026-09-03）：旧写法 `onlyNodeIds && onlyNodeIds.size > 0` 让空集**回退
			// 全量版** detectSimilarCode（O(全量²) 配对）——日志实测：新节点 0 仍耗 12954ms，
			// 占增量索引总耗时 13018ms 的 99.5%。
			if (onlyNodeIds && onlyNodeIds.size === 0) {
				this._logService.debug('[CodebaseGraph]', 'Similarity pass: skipped (incremental, 0 new nodes)');
				return 0;
			}
			const allNodes = store.getAllNodes().filter(n => n.project === project);
			// 增量版为 async（内部对全量 LSH 建桶做时间切片，避免独占主线程）
			const similarEdges = onlyNodeIds
				? await detectSimilarCodeIncremental(onlyNodeIds, allNodes, store, 0.7)
				: detectSimilarCode(allNodes, store, 0.7);
			for (const edge of similarEdges) {
				const srcNode = store.findNodeByQN(project, edge.sourceQN);
				const tgtNode = store.findNodeByQN(project, edge.targetQN);
				if (srcNode && tgtNode) {
					store.insertEdge({
						project,
						sourceId: srcNode.id,
						targetId: tgtNode.id,
						type: 'SIMILAR_TO',
						properties: { jaccardEstimate: edge.jaccardEstimate },
					});
					edgesAdded++;
				}
			}
			this._logService.info('[CodebaseGraph]', `Similarity pass: ${edgesAdded} SIMILAR_TO edges`);
		} catch (err: any) {
			this._logService.debug('[CodebaseGraph]', `Similarity pass failed: ${err?.message || err}`);
		}

		return edgesAdded;
	}

	// ─── Graph Data API ────────────────────────────────────────────────────

	getGraphData(): GraphData {
		return this._graph.toJSON();
	}

	getGraphDataDownsampled(maxNodes: number): GraphData {
		return this._graph.toJSONDownsampled(maxNodes);
	}

	hasGraphData(): boolean {
		// 检查所有已注册的 project（_rootProjectMap），不硬编码 _default
		for (const [, proj] of this._rootProjectMap) {
			if (this._graph.store.getNodeCount(proj) > 0) { return true; }
		}
		// 回退：_default 项目 + GraphStore 自身检查（兼容未注册的旧数据）
		return this._graph.hasData();
	}

	getTotalNodeCount(): number {
		return this._graph.nodeCount;
	}

	/**
	 * 指定项目的节点数（见接口注释：用于区分「加载成功但为空」）。
	 * 与 `hasGraphData()` 里 `this._graph.store.getNodeCount(proj)` 同一口径。
	 */
	getProjectNodeCount(project: string): number {
		return this._graph.store.getNodeCount(project);
	}

	/** 见接口注释（标记由 `_loadGraphMergeImpl` 写入 / 清除）。 */
	isLastMergeEmpty(rootPath: string): boolean {
		return this._emptyArtifactRoots.has(this._normalizeRoot(rootPath));
	}

	// ─── Visualization Data (pre-computed layout + colors + sizes) ───────

	/** FNV-1a hash (matches codebase-memory-mcp layout3d.c) */
	private static _fnv1a(str: string): number {
		let h = 0x811c9dc5;
		for (let i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
		}
		return h >>> 0;
	}

	/** Stellar color by connection count (matches codebase-memory-mcp) */
	private static _stellarColor(connections: number): string {
		if (connections >= 50) return '#80a0ff'; // O (Blue Giant)
		if (connections >= 26) return '#c0d0ff'; // B (Blue-White)
		if (connections >= 13) return '#e8e8ff'; // A (White)
		if (connections >= 7) return '#fff0c0';  // F (Yellow-White)
		if (connections >= 4) return '#ffe080';  // G (Yellow/Sun)
		if (connections >= 2) return '#ffa060';  // K (Orange)
		return '#ff6050'; // M (Red Dwarf)
	}

	private static _nodeSize(connections: number): number {
		return 2 + Math.min(connections, 50) * 0.15;
	}

	/**
	 * 获取预计算的可视化数据：top-N 节点 + 环形布局 + 恒星颜色 + 节点大小。
	 * webview 收到后直接渲染，无需计算布局/颜色/大小。
	 */
	getVisualizationData(maxNodes: number): VisualizationData {
		const store = this._graph.store;
		const project = this._projectName;
		const tStart = Date.now();

		// 1. 高效获取 top-N 节点
		let topNodes = store.getTopNodesByDegree(project, maxNodes);
		this._logService.info('[CodebaseGraph]', `getViz [1] getTopNodesByDegree: ${topNodes.length} nodes (${Date.now() - tStart}ms)`);

		// Fallback: if project-specific query returns 0, try without project filter
		if (topNodes.length === 0) {
			this._logService.warn('[CodebaseGraph]', `getVisualizationData: 0 nodes for project="${project}", trying all nodes`);
			const allNodes = store.getAllNodes();
			allNodes.sort((a, b) => ((b.inDegree || 0) + (b.outDegree || 0)) - ((a.inDegree || 0) + (a.outDegree || 0)));
			topNodes = allNodes.slice(0, maxNodes);
			this._logService.info('[CodebaseGraph]', `getViz [1-fallback] sorted+slice: ${topNodes.length} nodes (${Date.now() - tStart}ms)`);
		}

		const keptIds = new Set(topNodes.map(n => n.id));

		// 2. 高效获取这些节点之间的边
		const tEdges = Date.now();
		const storeEdges = store.getEdgesBetweenNodes(keptIds);
		this._logService.info('[CodebaseGraph]', `getViz [2] getEdgesBetweenNodes: ${storeEdges.length} edges (${Date.now() - tEdges}ms)`);

		// 3. 计算环形布局
		const tLayout = Date.now();
		const nodes: VisualizationNode[] = topNodes.map(storeNode => {
			const connections = (storeNode.inDegree || 0) + (storeNode.outDegree || 0);
			const fp = storeNode.filePath || storeNode.qualifiedName || storeNode.name || '';

			// Cluster key = first 3 dir components
			const parts = fp.replace(/\\/g, '/').split('/');
			const clusterKey = parts.slice(0, 3).join('/');

			// Hash → angle + radius (ring layout)
			const h = CodebaseGraphService._fnv1a(clusterKey);
			const angle = ((h & 0xFFFF) / 65535) * Math.PI * 2;
			const radius = 500 + ((h >> 16) & 0xFF) / 255 * 250;

			// Jitter from qualified name hash
			const seed = CodebaseGraphService._fnv1a(storeNode.qualifiedName || fp);
			const jitter = 40;
			const jx = ((seed & 0xFF) / 255 - 0.5) * jitter;
			const jy = (((seed >> 8) & 0xFF) / 255 - 0.5) * jitter;

			// Z from degree (higher degree = closer to center plane)
			const z = -Math.min(connections, 20) * 15;

			// Convert to VisualizationNode (string IDs for webview)
			const strId = this._graph['_revIdMap'].get(storeNode.id) || String(storeNode.id);

			return {
				id: strId,
				name: storeNode.name,
				type: storeNode.label,
				filePath: storeNode.filePath,
				qualifiedName: storeNode.qualifiedName,
				x: radius * Math.cos(angle) + jx,
				y: radius * Math.sin(angle) + jy,
				z,
				size: CodebaseGraphService._nodeSize(connections),
				color: CodebaseGraphService._stellarColor(connections),
				inDegree: storeNode.inDegree || 0,
				outDegree: storeNode.outDegree || 0,
			};
		});
		this._logService.info('[CodebaseGraph]', `getViz [3] layout+nodes: ${nodes.length} (${Date.now() - tLayout}ms)`);

		// 4. 转换边为 GraphEdge 格式（string IDs），限制总数避免 HTML 过大
		const tEdgeConv = Date.now();
		const MAX_EDGES = 100000;
		const allEdges: GraphEdge[] = storeEdges.map(({ edge }) => {
			const srcStr = this._graph['_revIdMap'].get(edge.sourceId) || String(edge.sourceId);
			const tgtStr = this._graph['_revIdMap'].get(edge.targetId) || String(edge.targetId);
			return { source: srcStr, target: tgtStr, type: edge.type };
		});
		// 优先保留 CALLS/IMPORTS/DEFINES，截断 CONTAINS_* 等低价值边
		const EDGE_PRIORITY: Record<string, number> = { CALLS: 0, IMPORTS: 1, DEFINES: 2, DEFINES_METHOD: 3, IMPLEMENTS: 4, INHERITS: 5, HANDLES: 6, USAGE: 7 };
		allEdges.sort((a, b) => (EDGE_PRIORITY[a.type] ?? 99) - (EDGE_PRIORITY[b.type] ?? 99));
		const edges = allEdges.slice(0, MAX_EDGES);
		this._logService.info('[CodebaseGraph]', `getViz [4] edgeConvert+sort: ${edges.length}/${allEdges.length} edges (${Date.now() - tEdgeConv}ms, total ${Date.now() - tStart}ms)`);

		return { nodes, edges, totalNodes: this._graph.nodeCount };
	}

	/**
	 * 分批获取可视化节点（用于增量加载，避免一次性嵌入大量 JSON 到 HTML）
	 * 返回按 degree 降序排列的节点，从 offset 开始取 limit 个
	 */
	getVisualizationNodes(offset: number, limit: number): { nodes: VisualizationNode[]; total: number } {
		const store = this._graph.store;
		const project = this._projectName;
		const total = store.getNodeCount(project);

		// 获取 top-N 节点（按 degree 降序），取 offset..offset+limit 切片
		// getTopNodesByDegree 返回按 degree 排序的数组，我们取 offset 之后的 limit 个
		// 为避免每次重新排序，第一次调用时缓存全量排序结果
		let sortedNodes = this._cachedSortedNodes;
		if (!sortedNodes || sortedNodes.length === 0 || this._cachedSortedProject !== project) {
			sortedNodes = store.getTopNodesByDegree(project, total);
			this._cachedSortedNodes = sortedNodes;
			this._cachedSortedProject = project;
		}

		const batch = sortedNodes.slice(offset, offset + limit);
		const nodes: VisualizationNode[] = batch.map(storeNode => {
			const connections = (storeNode.inDegree || 0) + (storeNode.outDegree || 0);
			const fp = storeNode.filePath || storeNode.qualifiedName || storeNode.name || '';
			const parts = fp.replace(/\\/g, '/').split('/');
			const clusterKey = parts.slice(0, 3).join('/');
			const h = CodebaseGraphService._fnv1a(clusterKey);
			const angle = ((h & 0xFFFF) / 65535) * Math.PI * 2;
			const radius = 500 + ((h >> 16) & 0xFF) / 255 * 250;
			const seed = CodebaseGraphService._fnv1a(storeNode.qualifiedName || fp);
			const jx = ((seed & 0xFF) / 255 - 0.5) * 40;
			const jy = (((seed >> 8) & 0xFF) / 255 - 0.5) * 40;
			const z = -Math.min(connections, 20) * 15;
			const strId = this._graph['_revIdMap'].get(storeNode.id) || String(storeNode.id);
			return {
				id: strId, name: storeNode.name, type: storeNode.label,
				filePath: storeNode.filePath, qualifiedName: storeNode.qualifiedName,
				x: radius * Math.cos(angle) + jx, y: radius * Math.sin(angle) + jy, z,
				size: CodebaseGraphService._nodeSize(connections),
				color: CodebaseGraphService._stellarColor(connections),
				inDegree: storeNode.inDegree || 0, outDegree: storeNode.outDegree || 0,
			};
		});

		return { nodes, total };
	}

	/**
	 * 分批获取边（直接从 store 获取，webview 会过滤掉端点未加载的边）
	 */
	getVisualizationEdges(_nodeIds: Set<string>, offset: number, limit: number): GraphEdge[] {
		// 直接从 store 获取所有边，按 offset/limit 分批返回
		// webview 的 addEdgesBatch 会自动跳过端点不在 nodeMap 中的边
		const allStoreEdges = this._graph.store.getAllEdges();
		const batch: GraphEdge[] = [];

		for (let i = offset; i < Math.min(offset + limit, allStoreEdges.length); i++) {
			const edge = allStoreEdges[i];
			// 尝试从 _revIdMap 获取 string ID，fallback 到 String(numericId)
			const srcStr = this._graph['_revIdMap'].get(edge.sourceId) || String(edge.sourceId);
			const tgtStr = this._graph['_revIdMap'].get(edge.targetId) || String(edge.targetId);
			batch.push({ source: srcStr, target: tgtStr, type: edge.type });
		}

		return batch;
	}

	/** 获取边的总数 */
	getTotalEdgeCount(): number {
		return this._graph.store.getAllEdges().length;
	}

	// ─── Phase 2c Async Overloads (SQLite-backed, for webview incremental loading) ───

	async getVisualizationNodesAsync(offset: number, limit: number): Promise<{ nodes: VisualizationNode[]; total: number }> {
		if (this._sqliteBackendEnabled) {
			return this._sqliteBackend.getVisualizationNodes(offset, limit, this._projectName);
		}
		// 回退到 sync 内存路径
		return this.getVisualizationNodes(offset, limit);
	}

	async getVisualizationEdgesAsync(_nodeIds: Set<string>, offset: number, limit: number): Promise<GraphEdge[]> {
		if (this._sqliteBackendEnabled) {
			return this._sqliteBackend.getVisualizationEdges(offset, limit);
		}
		return this.getVisualizationEdges(_nodeIds, offset, limit);
	}

	async getTotalNodeCountAsync(): Promise<number> {
		if (this._sqliteBackendEnabled) {
			return this._sqliteBackend.getTotalNodeCount(this._projectName);
		}
		return this.getTotalNodeCount();
	}

	async getTotalEdgeCountAsync(): Promise<number> {
		if (this._sqliteBackendEnabled) {
			return this._sqliteBackend.getTotalEdgeCount();
		}
		return this.getTotalEdgeCount();
	}

	// ─── Phase 2d Async Overloads (search / getNode / listProjects / hasData / types) ───

	async searchNodesAsync(pattern: string, nodeType?: string, limit?: number): Promise<GraphNode[]> {
		if (this._sqliteBackendEnabled) {
			return this._sqliteBackend.searchNodes(pattern, nodeType, limit);
		}
		return this.searchNodes(pattern, nodeType);
	}

	async getNodeAsync(id: string): Promise<GraphNode | undefined> {
		if (this._sqliteBackendEnabled) {
			// 通过 GraphStore 的内部 _nodeIdMap 解析 string→numeric id（轻量级映射，非全量节点数据）
			const numericId = (this._graph as any)._nodeIdMap?.get(id) as number | undefined;
			if (numericId !== undefined) {
				return this._sqliteBackend.getNode(numericId);
			}
			// 回退：按 qualifiedName 查找（提取器通常设置 id === qualifiedName）
			return this._sqliteBackend.getNodeByQN(this._projectName, id);
		}
		return this.getNode(id);
	}

	async listProjectsAsync(): Promise<{ name: string; nodeCount: number; edgeCount: number; fileCount: number }[]> {
		if (this._sqliteBackendEnabled) {
			const projs = await this._sqliteBackend.listProjects();
			return projs.map(p => ({ ...p, fileCount: 0 }));
		}
		return this.listProjects();
	}

	/**
	 * 已索引文件清单（2026-07-26，P1b）：search_files target=files 的快路径——
	 * 文件名 glob 直接匹配索引清单（亚秒级），免去全 folder ripgrep 扫描（17.5s）。
	 * SQLite 后端走主进程 DISTINCT SQL；内存路径从 getAllFileNodes 提取。
	 */
	async listIndexedFilePaths(project?: string): Promise<{ filePath: string; project: string }[]> {
		if (this._sqliteBackendEnabled && !this.hasGraphData()) {
			try {
				return await this._sqliteBackend.listIndexedFilePaths(project);
			} catch (err) {
				this._logService.warn('[CodebaseGraph]', `[listIndexedFilePaths] sqlite path failed, fallback to memory: ${err}`);
			}
		}
		if (!this.hasGraphData()) { return []; }
		const seen = new Map<string, string>();
		for (const fn of this._graph.store.getAllFileNodes()) {
			if (fn.filePath && (!project || fn.project === project) && !seen.has(fn.filePath)) {
				seen.set(fn.filePath, fn.project ?? this._projectName);
			}
		}
		return [...seen.entries()].map(([filePath, proj]) => ({ filePath, project: proj }));
	}

	// ─── 按需加载（tryLoadFromSqlite）的失败记忆 ─────────────────────────────
	//
	// 见 `tryLoadFromSqlite` 的注释：该路径是同步重活（几十万节点 + BM25 重建，实测 13~32s），
	// 失败后若不加记忆，**每次用图工具调用都会重跑一遍** ⇒ UI 反复整窗卡死 + 并发工具 60s 超时。
	/** 连续失败次数（成功即清零）。 */
	private _sqliteLoadFailures = 0;
	/** 最近一次失败时刻（用于退避窗口）。 */
	private _sqliteLoadLastFailureAt = 0;
	/** 最近一次失败原因（便于日志/排查，不参与逻辑）。 */
	private _sqliteLoadLastError: string | undefined;
	/** 「已放弃」只记一次日志，避免每次工具调用都刷屏。 */
	private _sqliteLoadGaveUpLogged = false;

	/** 本会话最多尝试几次（含成功前的失败）；超过即快速失败，不再重跑重活。 */
	private static readonly SQLITE_LOAD_MAX_FAILURES = 2;
	/** 失败后的退避窗口：窗口内直接快速失败。 */
	private static readonly SQLITE_LOAD_BACKOFF_MS = 5 * 60_000;

	// ─── 图谱加载竞态守卫（启动 loadGraphMerge 与 LLM 工具调用之间的竞争） ───

	private _graphLoadingCount = 0;
	private _graphLoadingWaiters: (() => void)[] = [];

	/** 由 `codebaseGraphBootstrap` 注入的「按需加载被延迟图谱」回调（见 `registerDeferredGraphLoader`）。 */
	private _deferredGraphLoader: ((reason: string) => Promise<void>) | undefined;
	/** 进行中的延迟加载（去重，见 `ensureDeferredGraphsLoaded`）。 */
	private _deferredGraphLoadPromise: Promise<void> | undefined;

	async whenGraphLoaded(timeoutMs: number = 120000): Promise<void> {
		if (this._graphLoadingCount === 0) { return; }
		await Promise.race([
			new Promise<void>(resolve => {
				const check = () => {
					if (this._graphLoadingCount === 0) { resolve(); }
					else { this._graphLoadingWaiters.push(check); }
				};
				check();
			}),
			new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
		]);
	}

	hasProjectData(rootPath: string): boolean {
		const norm = this._normalizeRoot(rootPath);
		const project = this._rootProjectMap.get(norm) || this._basename(norm) || '_default';
		return this._graph.store.getNodeCount(project) > 0;
	}

	// ── 非主 root 大图的延迟加载（2026-09-15 用户裁决方案 C）──────────────────────

	registerDeferredGraphLoader(loader: (reason: string) => Promise<void>): IDisposable {
		this._deferredGraphLoader = loader;
		return toDisposable(() => {
			// 只清理自己 —— 避免后来者被前一个的 dispose 清掉。
			if (this._deferredGraphLoader === loader) {
				this._deferredGraphLoader = undefined;
			}
		});
	}

	async ensureDeferredGraphsLoaded(reason: string): Promise<void> {
		if (!this._deferredGraphLoader) { return; }
		// 进行中复用同一 promise（与 `_loadingFolders` 同一教训：别重复发起重量级加载）。
		if (this._deferredGraphLoadPromise) { return this._deferredGraphLoadPromise; }
		const loader = this._deferredGraphLoader;
		this._deferredGraphLoadPromise = (async () => {
			try {
				this._logService.info(`[CodebaseGraph] ensureDeferredGraphsLoaded (${reason})`);
				await loader(reason);
			} catch (err) {
				// 失败只 warn：延迟加载是「让检索更完整」的便利，绝不能因此让查询路径失败。
				this._logService.warn('[CodebaseGraph] ensureDeferredGraphsLoaded failed:', err);
			} finally {
				this._deferredGraphLoadPromise = undefined;
			}
		})();
		return this._deferredGraphLoadPromise;
	}

	async hasGraphDataAsync(): Promise<boolean> {
		await this.whenGraphLoaded();
		if (this._sqliteBackendEnabled) {
			// 已确认本 project sqlite 为空 → 直接走内存 store（见 _sqliteEmptyProjects）
			if (this._sqliteEmptyProjects.has(this._projectName)) { return this.hasGraphData(); }
			try {
				const count = await this._sqliteBackend.getTotalNodeCount(this._projectName);
				if (count > 0) { return true; }
				// sqlite 库为空（图从 gzip artifact 加载、本会话未索引同步）→ 回退内存 store
				this._sqliteEmptyProjects.add(this._projectName);
				this._logService.warn('[CodebaseGraph] hasGraphDataAsync: sqlite empty, falling back to in-memory store');
				return this.hasGraphData();
			} catch (err) {
				// sqlite 后端不可用（打包版缺原生模块 / channel 未注册）→ 回退内存 store
				this._logService.warn('[CodebaseGraph] hasGraphDataAsync: sqlite backend failed, falling back to in-memory store:', err);
				return this.hasGraphData();
			}
		}
		return this.hasGraphData();
	}

	async getNodeTypesAsync(project?: string): Promise<Record<string, number>> {
		if (this._sqliteBackendEnabled) {
			return this._sqliteBackend.getNodeTypes(project ?? this._projectName);
		}
		// 未启用时从内存 store 聚合（此方法为 Phase 2d 新增，无既有 sync 版本）
		const store = this._graph.store;
		const nodes = project
			? store.getAllNodes().filter(n => n.project === project)
			: store.getAllNodes();
		const out: Record<string, number> = {};
		for (const n of nodes) {
			const t = n.label || 'unknown';
			out[t] = (out[t] || 0) + 1;
		}
		return out;
	}

	async getEdgeTypesAsync(project?: string): Promise<Record<string, number>> {
		if (this._sqliteBackendEnabled) {
			return this._sqliteBackend.getEdgeTypes(project ?? this._projectName);
		}
		const store = this._graph.store;
		const out: Record<string, number> = {};
		for (const e of store.getAllEdges()) {
			if (!project || e.project === project) {
				out[e.type] = (out[e.type] || 0) + 1;
			}
		}
		return out;
	}

	private _cachedSortedNodes: any[] = [];
	private _cachedSortedProject: string = '';

	searchNodes(pattern: string, nodeType?: string): GraphNode[] {
		const regex = new RegExp(pattern, 'i');
		return this._graph.searchByName(regex, nodeType);
	}

	getEdges(nodeId?: string): GraphEdge[] {
		if (nodeId) {
			return this._graph.getEdgesOf(nodeId);
		}
		return this._graph.getAllEdges();
	}

	getClassHierarchy(qualifiedName: string, direction: 'bases' | 'derived' | 'both' = 'both', maxDepth?: number): IClassHierarchyNode | undefined {
		const store = this._graph.store;
		const project = this._projectName;
		// 支持纯名称反查（QN 是 file::name；先找 class/interface 节点）
		let storeNode = store.findNodeByQN(project, qualifiedName);
		if (!storeNode) {
			// 纯名称 → 从 store 全节点里精确匹配（避免 service 层 id 字符串/数字混用）
			const escaped = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const regex = new RegExp(`^${escaped}$`, 'i');
			for (const n of store.getAllNodes()) {
				if (n.project !== project) { continue; }
				if ((n.label !== 'class' && n.label !== 'interface') && (n.type !== 'class' && n.type !== 'interface')) { continue; }
				if (regex.test(n.name)) { storeNode = n; break; }
			}
		}
		if (!storeNode) { return undefined; }

		const toServiceNode = (n: typeof storeNode): GraphNode => ({
			id: String(n.id),
			name: n.name,
			type: n.type ?? n.label,
			label: n.label,
			filePath: n.filePath,
			qualifiedName: n.qualifiedName,
			inDegree: n.inDegree,
			outDegree: n.outDegree,
			startLine: n.startLine,
			endLine: n.endLine,
			project: n.project,
			properties: n.properties,
		});

		const depth = maxDepth && maxDepth > 0 ? maxDepth : 8;
		const root: IClassHierarchyNode = { node: toServiceNode(storeNode), kind: 'root', bases: [], derived: [] };

		// 沿 INHERITS/IMPLEMENTS 边双向 BFS（图可能有环，visited 按 store id 防环）
		const walkBases = (current: IClassHierarchyNode, visited: Set<number>, d: number): void => {
			if (d >= depth) { return; }
			const curStoreId = Number(current.node.id);
			for (const edge of store.getEdgesByTarget(curStoreId)) {
				if (edge.type !== 'INHERITS' && edge.type !== 'IMPLEMENTS') { continue; }
				const src = store.getNode(edge.sourceId);
				if (!src || visited.has(src.id)) { continue; }
				visited.add(src.id);
				const child: IClassHierarchyNode = { node: toServiceNode(src), kind: edge.type as any, bases: [], derived: [] };
				current.bases.push(child);
				walkBases(child, visited, d + 1);
			}
		};
		const walkDerived = (current: IClassHierarchyNode, visited: Set<number>, d: number): void => {
			if (d >= depth) { return; }
			const curStoreId = Number(current.node.id);
			for (const edge of store.getEdgesBySource(curStoreId)) {
				if (edge.type !== 'INHERITS' && edge.type !== 'IMPLEMENTS') { continue; }
				const tgt = store.getNode(edge.targetId);
				if (!tgt || visited.has(tgt.id)) { continue; }
				visited.add(tgt.id);
				const child: IClassHierarchyNode = { node: toServiceNode(tgt), kind: edge.type as any, bases: [], derived: [] };
				current.derived.push(child);
				walkDerived(child, visited, d + 1);
			}
		};

		if (direction === 'bases' || direction === 'both') { walkBases(root, new Set([Number(root.node.id)]), 0); }
		if (direction === 'derived' || direction === 'both') { walkDerived(root, new Set([Number(root.node.id)]), 0); }
		return root;
	}

	getNodeReferences(qualifiedName: string, edgeTypes?: string[], access?: 'read' | 'write'): { node: GraphNode; edgeType: string; access: 'read' | 'write' }[] | undefined {
		const store = this._graph.store;
		const project = this._projectName;
		// 反查节点（支持 QN 与纯名称，复用 getClassHierarchy 的精确反查策略）
		let storeNode = store.findNodeByQN(project, qualifiedName);
		if (!storeNode) {
			const escaped = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const regex = new RegExp(`^${escaped}$`, 'i');
			for (const n of store.getAllNodes()) {
				if (n.project !== project) { continue; }
				if (regex.test(n.name)) { storeNode = n; break; }
			}
		}
		if (!storeNode) { return undefined; }

		const typeFilter = edgeTypes ? new Set(edgeTypes) : undefined;
		const toServiceNode = (n: typeof storeNode): GraphNode => ({
			id: String(n.id),
			name: n.name,
			type: n.type ?? n.label,
			label: n.label,
			filePath: n.filePath,
			qualifiedName: n.qualifiedName,
			inDegree: n.inDegree,
			outDegree: n.outDegree,
			startLine: n.startLine,
			endLine: n.endLine,
			project: n.project,
			properties: n.properties,
		});

		const refs: { node: GraphNode; edgeType: string; access: 'read' | 'write' }[] = [];
		const seen = new Set<number>();
		for (const edge of store.getEdgesByTarget(storeNode.id)) {
			if (typeFilter && !typeFilter.has(edge.type)) { continue; }
			// 读写过滤：仅对 USAGE 边读取 properties.access；其余边（CALLS/INHERITS/…）恒为 read
			const edgeAccess: 'read' | 'write' = edge.type === 'USAGE'
				? (edge.properties?.access === 'write' ? 'write' : 'read')
				: 'read';
			if (access && edgeAccess !== access) { continue; }
			const src = store.getNode(edge.sourceId);
			if (!src || seen.has(src.id)) { continue; }
			seen.add(src.id);
			refs.push({ node: toServiceNode(src), edgeType: edge.type, access: edgeAccess });
		}
		return refs;
	}

	getNode(id: string): GraphNode | undefined {
		return this._graph.getNode(id) as GraphNode | undefined;
	}

	/** 取某节点的语义信号（含 #7 MinHash 克隆信号，读取 SIMILAR_TO 边）。 */
	getNodeSignals(qualifiedName: string): { name: string; score: number; detail: string }[] | undefined {
		const node = this._graph.store.findNodeByQN(this._projectName, qualifiedName);
		if (!node) { return undefined; }
		return computeAllSignals(node, this._graph.store).map(s => ({
			name: s.signalName,
			score: s.score,
			detail: s.detail,
		}));
	}

	// ─── Advanced Query API ──────────────────────────────────────────────

	executeCypher(query: string, maxRows?: number): { columns: string[]; rows: any[][] } {
		// P2-19: 扩展语法（UNION / 多跳 *n..m / CASE）路由到扩展引擎
		// 多 folder：不传 project → 搜索全部项目（含 S1Game + UE5EA 等）
		if (this._isExtendedCypher(query)) {
			return executeExtendedCypher(this._graph.store, undefined, query);
		}
		if (!this._cypherEngine) {
			this._cypherEngine = new CypherEngine(this._graph.store);
		}
		return this._cypherEngine.execute(query, undefined, maxRows);
	}

	/** 检测是否为 Cypher 扩展语法（基础引擎无法解析，需走 executeExtendedCypher）。 */
	private _isExtendedCypher(query: string): boolean {
		const hasWithClause = /\bWITH\b/i.test(query) && !/\b(?:STARTS|ENDS)\s+WITH\b/i.test(query);
		return /\bUNION\b/i.test(query)
			|| hasWithClause
			|| /\[[\w*]*\*\d+\.\.\d+\]/.test(query);
		// 注意：CASE WHEN 现由基础 CypherEngine 解析（codebaseGraphCypher.ts），不在此路由。
		// WITH 作为独立子句（非 STARTS WITH / ENDS WITH）时才路由到扩展引擎。
	}

	semanticSearch(query: string, limit: number = 20): { node: GraphNode; score: number; signals: Record<string, number> }[] {
		if (!this._semanticSearch) {
			this._semanticSearch = new SemanticSearch(this._graph.store);
			this._semanticSearch.buildIndex();
		}
		const results = this._semanticSearch.search(query, limit);
		return results.map(r => ({
		node: {
			id: String(r.node.id),
			name: r.node.name,
			type: r.node.label,
			label: r.node.label,
			filePath: r.node.filePath,
			qualifiedName: r.node.qualifiedName,
			inDegree: r.node.inDegree,
			outDegree: r.node.outDegree,
		},
			score: r.score,
			signals: r.signals,
		}));
	}

	// ─── Analysis API ─────────────────────────────────────────────────────

	async getArchitecture(): Promise<any> {
		return await analyzeArchitecture(this._graph.store, this._projectName);
	}

	getGraphSchema(): GraphSchema {
		return getSchema(this._graph.store, this._projectName);
	}

	getIndexStatus(): { project: string; exists: boolean; nodeCount: number; edgeCount: number; fileCount: number; coverage?: IIndexCoverageReport } {
		// 多 folder：聚合所有项目（folder）的节点/边/文件计数
		const projects = this._graph.store.listProjects();
		let base: { project: string; exists: boolean; nodeCount: number; edgeCount: number; fileCount: number };
		if (projects.length === 0) {
			base = getIndexStatus(this._graph.store, this._projectName);
		} else if (projects.length === 1) {
			// 单项目：报告实际存在的项目（可能并非 _projectName——例如启动时仅加载了 UE5EA，
			// 而 _projectName 仍是 S1Game；按 _projectName 查会误报 0 触发不必要的重建）
			const p = projects[0];
			base = { project: p.name, exists: p.nodeCount > 0, nodeCount: p.nodeCount, edgeCount: p.edgeCount, fileCount: p.fileCount };
		} else {
			const nodeCount = projects.reduce((s, p) => s + p.nodeCount, 0);
			const edgeCount = projects.reduce((s, p) => s + p.edgeCount, 0);
			const fileCount = projects.reduce((s, p) => s + p.fileCount, 0);
			base = {
				project: projects.map(p => p.name).join(', '),
				exists: nodeCount > 0,
				nodeCount,
				edgeCount,
				fileCount,
			};
		}
		// 附加快照式覆盖率（仅当本次会话已索引过）
		const coverage = this._indexCoverage.size > 0 ? this.getIndexCoverage() : undefined;
		return { ...base, coverage };
	}

	/**
	 * 异步版本：当内存 store 为空（_loadGraphFromSqlite 未执行或失败）时，
	 * 用 SQLite 后端 getTotalNodeCount 获取真实节点数。
	 * 供 index_status 工具 handler 调用（该 handler 是 async）。
	 */
	async getIndexStatusAsync(): Promise<{ project: string; exists: boolean; nodeCount: number; edgeCount: number; fileCount: number; coverage?: IIndexCoverageReport }> {
		// 竞态守卫：启动合并加载未完成前，任何"无数据"结论都不可信
		await this.whenGraphLoaded();
		// 若内存 store 已有数据，直接用同步版本
		const memCount = this._graph.store.getNodeCount();
		if (memCount > 0) { return this.getIndexStatus(); }

		// 内存 store 为空 → 查 SQLite 后端
		if (this._sqliteBackendEnabled) {
			const nodeCount = await this._sqliteBackend.getTotalNodeCount();
			if (nodeCount > 0) {
				const projects = await this._sqliteBackend.listProjects();
				const names = projects.length > 0 ? projects.map(p => p.name).join(', ') : this._projectName;
				const edgeCount = await this._sqliteBackend.getTotalEdgeCount();
				return {
					project: names,
					exists: true,
					nodeCount,
					edgeCount,
					fileCount: 0, // SQLite 后端不直接暴露 fileCount；由内存 store 统计
				};
			}
		}
		// 两者都无数据 → 返回空状态
		return { project: this._projectName, exists: false, nodeCount: 0, edgeCount: 0, fileCount: 0 };
	}

	/**
	 * 索引健康度：把「图是否可用」变成可判定的量化指标（2026-09-09）。
	 *
	 * 背景：图谱曾出现 6017 条基线 vs 1196 节点（每文件 0.2 个节点）——解析大面积失败
	 * 且失败被固化，但 hasGraphData() 仍返回 true、UI 无任何提示，用户只能看到「搜不到」。
	 * 判据：nodesPerFile < 2 视为残缺（正常项目 ≥ 5），另暴露解析失败数、契约违规数。
	 */
	getIndexHealth(): IIndexHealthReport {
		const nodeCount = this._graph.store.getNodeCount();
		const hashCount = this._graph.store.getFileHashCount();
		const nodesPerFile = hashCount > 0 ? nodeCount / hashCount : 0;
		const entries = [...this._indexCoverage.values()];
		let parseFailed = 0;
		for (const e of entries) {
			if (e.status === 'parse_error' || e.status === 'timeout') { parseFailed++; }
		}
		const deficient = nodeCount > 0 && hashCount > 0 && nodesPerFile < 2;
		return {
			nodeCount,
			fileCount: hashCount,
			nodesPerFile: Math.round(nodesPerFile * 100) / 100,
			parseFailedFiles: parseFailed,
			absPathViolations: this._graph.store.getAbsPathViolationCount(),
			deficient,
			message: deficient
				? `图谱残缺：${nodeCount} 节点 / ${hashCount} 文件（每文件 ${nodesPerFile.toFixed(2)} 节点，正常 ≥ 2）— 请重新索引`
				: undefined,
		};
	}

	/** 上次 SQLite 新鲜度校验时刻（节流基准）。 */
	private _lastSqliteFreshnessCheckAt = 0;
	private static readonly SQLITE_FRESHNESS_CHECK_INTERVAL_MS = 60_000;

	/** 解析期内存看门狗的检查间隔（每 N 个文件查一次堆；见 `_parseMemoryWatchdog`）。 */
	private static readonly PARSE_MEM_CHECK_EVERY = 250;

	/**
	 * SQLite 新鲜度校验（2026-09-09，P0-1 第一步）。
	 *
	 * 三份状态源（内存 store / 主进程 SQLite / 磁盘 zst）可独立漂移，旧实现只在
	 * 「SQLite 查到 0 条」时才被动回退内存——**落后但非空的情况完全静默**，查询会持续
	 * 拿到陈旧/残缺结果。这里主动比对两侧节点数，明显落后即告警并后台补同步。
	 *
	 * 节流 60s：getNodeCount 是一次轻量 COUNT，但每查一次都做 IPC 仍不必要。
	 * 触发同步是 fire-and-forget，不阻塞本次查询。
	 *
	 * @returns true = SQLite 可信（本次可查 SQLite）；false = 已确认落后，
	 *   调用方本次应改走内存，避免把陈旧/残缺结果返回给用户（2026-09-09 补）。
	 */
	private async _ensureSqliteFreshness(project: string): Promise<boolean> {
		if (!this._sqliteBackendEnabled || !this.hasGraphData()) { return true; }
		const now = Date.now();
		if (now - this._lastSqliteFreshnessCheckAt < CodebaseGraphService.SQLITE_FRESHNESS_CHECK_INTERVAL_MS) { return true; }
		this._lastSqliteFreshnessCheckAt = now;
		try {
			const sqliteCount = await this._sqliteBackend!.getNodeCount(project);
			// 2026-09-15：两侧都按**同一个 project** 计数。旧实现用 store 的**总数**（全项目），
			// 多 folder / 多工作区残留时该比值毫无意义 —— 用户日志里
			// `sqlite=160857 memory=1119421 (project="S1Game")` 就是这个口径错配的产物。
			const memCount = this._graph.store.getNodeCount(project);
			const lagging = sqliteCount === 0 || (memCount > 1000 && sqliteCount < memCount * 0.5);
			if (lagging) {
				this._logService.warn('[CodebaseGraph]', `[sqlite-freshness] sqlite lags behind memory: sqlite=${sqliteCount} memory=${memCount} (project="${project}") — using in-memory for this query, syncing in background`);
				this._sqliteEmptyProjects.delete(project); // 同步完成后应重新走 SQLite 路径
				// ★ 2026-09-19：改走**统一的后台入口** —— 旧写法直接 fire-and-forget 且**没有守卫**，
				// 会和载入路径的全量同步**并发**对同一项目做 delete+insert ⇒ 互相覆盖 ✗。
				// 现在两处共用「同步中」守卫 + 冷却（见 `_scheduleSqliteCatchUp` → `_catchUpSqlite` ✓）。
				this._scheduleSqliteCatchUp(project, 'freshness-lagging');
				return false; // 本次别查 SQLite：它的数据是陈旧/残缺的
			}
		} catch (err) {
			this._logService.debug('[CodebaseGraph]', `[sqlite-freshness] check failed: ${err}`);
		}
		return true;
	}

	/**
	 * 索引汇总诊断日志（2026-09-09，D6「静默降级链无出口」）。
	 *
	 * 背景：图谱曾出现「6017 文件基线 vs 1196 节点」的残缺状态，但系统完全静默——
	 * 只能靠手工解包 `.codebase-memory/graph.db.zst` 才能判断索引是否真的成功。
	 * 现在每轮索引结束打一行聚合日志：成功/跳过/失败分类（按原因 top3）+ 健康度结论，
	 * 让用户（和排障）从日志直接判成败，不必再解包快照。
	 *
	 * @param scopedRels 增量轮本轮处理的文件（coverage 是累积的，需按本轮范围取子集）。
	 */
	private _logIndexSummary(kind: 'full' | 'incremental', scopedRels?: string[]): void {
		try {
			const all = [...this._indexCoverage.values()];
			const scope = scopedRels ? new Set(scopedRels) : undefined;
			const entries = scope ? all.filter(e => scope.has(e.path)) : all;

			let indexed = 0, skipped = 0, failed = 0;
			const reasonCounts = new Map<string, number>();
			for (const e of entries) {
				if (e.status === 'parse_error' || e.status === 'timeout') {
					failed++;
					const r = e.reason || e.status;
					reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
				} else if (e.status === 'skipped') {
					skipped++;
					const r = (e.reason || 'skipped').split('(')[0].trim();
					reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
				} else {
					indexed++;
				}
			}
			const top = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
				.map(([r, c]) => `${r}×${c}`).join(', ');
			const health = this.getIndexHealth();
			this._logService.info('[CodebaseGraph]',
				`[summary] ${kind}: indexed=${indexed} skipped=${skipped} failed=${failed}` +
				`${top ? ` | top reasons: ${top}` : ''}` +
				` | health: ${health.nodeCount} nodes / ${health.fileCount} files = ${health.nodesPerFile} per file` +
				`${health.deficient ? ` ⚠ DEFICIENT — ${health.message}` : ' ✓ ok'}`);
		} catch (err) {
			this._logService.debug('[CodebaseGraph]', `[summary] failed: ${err}`);
		}
	}

	getIndexCoverage(): IIndexCoverageReport {
		const entries = [...this._indexCoverage.values()];
		const totalFiles = entries.length;
		let indexed = 0, skipped = 0, parseError = 0, timeout = 0, partial = 0;
		const skippedFiles: IFileCoverage[] = [];
		const errorFiles: IFileCoverage[] = [];
		for (const e of entries) {
			switch (e.status) {
				case 'indexed': indexed++; break;
				case 'skipped': skipped++; skippedFiles.push(e); break;
				case 'parse_error': parseError++; errorFiles.push(e); break;
				case 'timeout': timeout++; errorFiles.push(e); break;
				case 'partial': partial++; errorFiles.push(e); break;
			}
		}
		const covered = indexed + partial; // partial 视为部分覆盖
		const coveragePct = totalFiles > 0 ? Math.round((covered / totalFiles) * 1000) / 10 : 100;
		return {
			project: this._projectName,
			totalFiles,
			indexed,
			skipped,
			parseError,
			timeout,
			partial,
			coveragePct,
			skippedFiles,
			errorFiles,
		};
	}

	/**
	 * 构建"漏索引"结构图：Project → Folder → File（仅含 skipped/parse_error/timeout/partial 文件）。
	 * 对标 C 的 query_graph(graph="missed")。
	 */
	getMissedGraph(): { nodes: { id: string; name: string; type: string; kind?: string; detail?: string }[]; edges: { source: string; target: string; type: string }[] } {
		const projectId = `project:${this._projectName}`;
		const nodes: { id: string; name: string; type: string; kind?: string; detail?: string }[] = [
			{ id: projectId, name: this._projectName, type: 'Project' },
		];
		const edges: { source: string; target: string; type: string }[] = [];
		const folderSeen = new Set<string>();

		for (const e of this._indexCoverage.values()) {
			if (e.status === 'indexed') { continue; }
			const parts = e.path.split('/').filter(Boolean);
			const fileName = parts.pop() || e.path;
			const folderPath = parts.join('/');
			const folderId = folderPath ? `folder:${folderPath}` : projectId;

			if (folderPath && !folderSeen.has(folderId)) {
				folderSeen.add(folderId);
				nodes.push({ id: folderId, name: folderPath, type: 'Folder' });
				edges.push({ source: projectId, target: folderId, type: 'CONTAINS' });
			}

			const fileId = `file:${e.path}`;
			nodes.push({ id: fileId, name: fileName, type: 'File', kind: e.status, detail: e.reason });
			edges.push({ source: folderId, target: fileId, type: 'CONTAINS' });
		}
		return { nodes, edges };
	}

	// ─── Trace & Search API ────────────────────────────────────────────────

	tracePath(sourceName: string, targetName: string | undefined, mode: string = 'calls'): any {
		return tracePath(this._graph.store, this._projectName, sourceName, targetName, mode as any);
	}

	// ─── 跨调用共享的文件内容缓存（性能关键） ─────────────────────────────
	// 旧实现每次 searchCode 各自建一个 200 项 LRU，调用结束即丢弃 →
	// 多个 search_code 并发时各自把 6046 个文件从磁盘重读一遍（~18000 次读），IO 打满以致卡死。
	// 改为 service 级共享 LRU：第一次扫描读盘并缓存，后续调用直接命中，几乎零 IO。
	private _contentCache = new Map<string, string>();
	private _contentCacheBytes = 0;
	/**
	 * 内容缓存【字节】预算（默认 256MB，`saros.codebaseGraph.contentCacheMB` 可覆盖）。
	 * 按文件数（旧 6000 项）在大小文件混杂时对内存无约束力——UE5 级项目 6000 个
	 * 大文件即可吃掉数 GB 堆。按字节预算 + LRU 淘汰才对 V8 4GB 硬顶有真实防护。
	 */
	private get _CONTENT_CACHE_BUDGET(): number {
		const mb = this._configurationService.getValue<number | undefined>('saros.codebaseGraph.contentCacheMB');
		return (typeof mb === 'number' && mb > 0 ? mb : 256) * 1024 * 1024;
	}

	private _cacheGet(filePath: string): string | undefined {
		const v = this._contentCache.get(filePath);
		if (v !== undefined) {
			// LRU：命中即刷新到最近端
			this._contentCache.delete(filePath);
			this._contentCache.set(filePath, v);
		}
		return v;
	}

	private _cacheSet(filePath: string, content: string): void {
		const bytes = content.length * 2; // UTF-16 估算
		if (bytes > this._CONTENT_CACHE_BUDGET / 4) { return; } // 单文件超预算 1/4 不缓存
		const existing = this._contentCache.get(filePath);
		if (existing !== undefined) {
			this._contentCacheBytes -= existing.length * 2;
			this._contentCache.delete(filePath);
		}
		// LRU 淘汰直到有足够空间
		while (this._contentCacheBytes + bytes > this._CONTENT_CACHE_BUDGET && this._contentCache.size > 0) {
			const oldest = this._contentCache.keys().next().value;
			if (oldest === undefined) { break; }
			this._contentCacheBytes -= (this._contentCache.get(oldest)?.length ?? 0) * 2;
			this._contentCache.delete(oldest);
		}
		this._contentCache.set(filePath, content);
		this._contentCacheBytes += bytes;
	}

	/**
	 * 有界并发执行器：同一时刻最多 `limit` 个 worker 在跑，避免一次性 Promise.all
	 * 触发数千并发读盘 → 文件句柄耗尽 / IO 调度抖动（3 个 search_code 并发时尤其危险）。
	 */
	private async _runBounded<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
		if (items.length === 0) { return; }
		let idx = 0;
		const runner = async (): Promise<void> => {
			while (idx < items.length) {
				const i = idx++;
				await worker(items[i]);
			}
		};
		const n = Math.min(limit, items.length);
		await Promise.all(Array.from({ length: n }, () => runner()));
	}

	async searchCode(query: string, limit: number = 50, filePattern?: string, useRegex: boolean = false, project?: string): Promise<{ results: any[]; totalMatches: number }> {
		// P2 分流：SQLite 后端启用且内存图已释放（大库）→ 主进程流式 grep。
		// 文件内容不跨 IPC 进 renderer 堆（对齐 C 版外部 grep 常驻零内存语义），
		// 也不会触发 Phase 2f 的全图回载。后端无数据/失败时回落原 renderer 路径。
		if (this._sqliteBackendEnabled && !this.hasGraphData()) {
			try {
				const roots = this._workspaceService.getWorkspace().folders.map(f => f.uri.fsPath);
				const grepResult = await this._sqliteBackend!.grepContent(query, {
					// 2026-07-26（日志 1785078531442 深层根因）：原写死 this._projectName
					// ——多项目图谱（S1Game+UE5EA）下其他项目文件根本不在 grep 范围，
					// graphHits=0 是必然 → 触发 30s+ fallback 白扫。缺省跨全部项目。
					project: project ?? undefined,
					roots,
					// 2026-07-26（日志 1785081279790）：project→root 直拼消除探测 IO；
					// 20s wall-clock 预算——跨项目 ~2-3 万文件清单实测 30s+，到点返回
					// 部分结果（部分覆盖经 coverage 透出给模型）。
					rootByProject: this.getProjectRoots(),
					filePattern,
					limit: Math.min(limit, 200),
					useRegex,
					deadlineMs: 20_000,
				});
			if (grepResult.totalFiles > 0) {
				this._logService.info('[CodebaseGraph]', `[searchCode] main-process grep: ${grepResult.matches.length} match(es), scanned ${grepResult.scannedFiles}/${grepResult.totalFiles} file(s)`);
				return {
					results: grepResult.matches.map(m => ({ filePath: m.filePath, lineNo: m.lineNo, text: m.text, node: undefined, relevanceScore: 0 })),
					totalMatches: grepResult.matches.length,
					// 2026-07-26：deadline 预算到点的部分覆盖透出（工具层据此给模型 hint）
					...(grepResult.scannedFiles < grepResult.totalFiles
						? { coverage: { scanned: grepResult.scannedFiles, total: grepResult.totalFiles } }
						: {}),
				};
			}
			} catch (err) {
				this._logService.warn('[CodebaseGraph]', `[searchCode] main-process grep failed, fallback to renderer path: ${err}`);
			}
		}

		// filePattern: 按文件路径过滤索引文件列表（修复 schema 参数悬空缺陷）
		// 多 folder：跨所有项目收集文件节点（getAllFileNodes 内部兼容 'file'/'File' 大小写及无 file 节点回退）
		const fileNodes = this._graph.store.getAllFileNodes();
		this._logService.info('[CodebaseGraph]', `[searchCode] fileNodes=${fileNodes.length} (all projects), query="${query.substring(0, 80)}", cached=${this._contentCache.size}`);
		// 2026-07-27（日志 1785126183816 根因）：此前 renderer 路径把 filePattern 当【原始
		// 正则】直接 `new RegExp(filePattern)`——但工具层传入的是 glob（pathFilterGlob=
		// `**/Runtime/CoreUObject/…/GarbageCollection.cpp`、`*.cpp` 等）。`new RegExp('**/…')`
		// 抛 "Nothing to repeat" → catch 放行全部 → filePattern/pathFilter 缩放【完全失效】，
		// 即使模型把范围缩到单个 .cpp 也照扫全部 33186 文件 → 每次撞 20s deadline（部分覆盖）
		// → 9-21s/次。_filePatternToRegex 已在 SQLite 路径修复同问题，此处复用（glob→regex
		// + 折叠连续 .*）。转换失败(undefined)才放行全部。filePath 反斜杠(Windows)先归一。
		const _fpRe = filePattern ? this._filePatternToRegex(filePattern) : undefined;
		const filteredFileNodes = (filePattern
			? fileNodes.filter(fn => {
				const fp = (fn.filePath ?? '').replace(/\\/g, '/');
				return _fpRe ? _fpRe.test(fp) : true;
			})
			: fileNodes
		// 2026-07-26：project 作用域过滤（工具层 project 参数透传；缺省跨全部项目）
		).filter(fn => !project || fn.project === project);
		if (filePattern) {
			this._logService.info('[CodebaseGraph]', `[searchCode] filePattern="${filePattern}" → regex=${_fpRe?.source ?? '(invalid→pass-all)'} scoped ${fileNodes.length}→${filteredFileNodes.length} file(s)`);
		}

		// 内容提供器从【共享 service 级 LRU】读取（跨调用复用，避免重复读盘）
		const contentProvider = (filePath: string): string | undefined => this._cacheGet(filePath);

		// 流式模式（P0，对齐 C 版流式 grep 语义）：大库或堆吃紧时每批读→搜→丢弃，
		// 常驻内存不随项目规模增长（V8 4GB 硬顶防护）。
		// 2026-07-27（日志 1785083036802）：缓存策略细化——字节预算（256MB+LRU+
		// 单文件 1/4 上限）已构成真实内存防护，「文件多」不再是绕过缓存的理由：
		// stream 下共享缓存【读命中直接用、读到也回写】（模型迭代查询同一区域时
		// 第二次起大幅加速）；仅【堆吃紧】才完全 bypass（安全阀保留）。
		const STREAM_FILE_THRESHOLD = 8000;
		const heapTight = CodebaseGraphStore.isHeapOverBudget();
		const streamMode = filteredFileNodes.length > STREAM_FILE_THRESHOLD || heapTight;
		const bypassCache = heapTight;
		if (streamMode) {
			this._logService.info('[CodebaseGraph]', `[searchCode] stream mode: files=${filteredFileNodes.length}, heapOverBudget=${heapTight} — ${bypassCache ? 'content cache bypassed (heap tight)' : 'shared cache read/write enabled'}`);
		}

		// 有界并发预读：每批 100 个文件，每批内最多 16 个并发读盘。
		// 已缓存的文件直接跳过 → 第二次/第三次 search_code 几乎零 IO。
		const BATCH_SIZE = 100;
		const READ_CONCURRENCY = 16;
		const allResults: any[] = [];
		let totalMatches = 0;

		// 2026-07-27（日志 1785082099615）：wall-clock 预算——内存图回载后走本路径
		// 时 33186 文件 × 332 批全量读盘实测 29-31s；到点 break 返回部分结果
		// （部分覆盖经 coverage 透出给模型）。
		const deadline = Date.now() + 20_000;
		let scannedFiles = 0;
		// project→root 直拼优先（消除逐文件 ×N folder 的 exists 探测 IO）
		const projectRoots = this.getProjectRoots();

		for (let batchStart = 0; batchStart < filteredFileNodes.length; batchStart += BATCH_SIZE) {
			if (Date.now() >= deadline) { break; }
			const batch = filteredFileNodes.slice(batchStart, batchStart + BATCH_SIZE);
			let batchProvider = contentProvider;
			if (streamMode) {
				// 批内局部缓存：读完即搜（provider 语义）；2026-07-27 起共享缓存
				// 命中直接用、读到的新内容在非堆吃紧时回写共享 LRU（字节预算自保）。
				const local = new Map<string, string>();
				await this._runBounded(batch, READ_CONCURRENCY, async (fn) => {
					if (!fn.filePath) { return; }
					if (!bypassCache) {
						const cached = this._cacheGet(fn.filePath);
						if (cached !== undefined) { local.set(fn.filePath, cached); return; }
					}
					try {
						for (const fileUri of this._searchFileCandidatesWithProject(fn.filePath, fn.project, projectRoots)) {
							if (await this._fileService.exists(fileUri)) {
								const content = (await this._fileService.readFile(fileUri)).value.toString();
								local.set(fn.filePath, content);
								if (!bypassCache) { this._cacheSet(fn.filePath, content); }
								break;
							}
						}
					} catch { /* skip unreadable files */ }
				});
				batchProvider = (fp: string) => local.get(fp);
			} else {
				// 仅对未缓存的文件做有界并发读盘（多 folder：相对路径依次尝试每个根，取首个存在的）
				await this._runBounded(batch, READ_CONCURRENCY, async (fn) => {
					if (!fn.filePath || this._contentCache.has(fn.filePath)) { return; }
					try {
						for (const fileUri of this._searchFileCandidatesWithProject(fn.filePath, fn.project, projectRoots)) {
							if (await this._fileService.exists(fileUri)) {
								const content = (await this._fileService.readFile(fileUri)).value.toString();
								this._cacheSet(fn.filePath, content);
								break;
							}
						}
					} catch { /* skip unreadable files */ }
				});
			}
			scannedFiles += batch.length;

			// 对当前批次执行搜索（同步；graphSearchCode 只会命中 provider 可提供的文件）
			// 空 project → 跨所有 folder/项目搜索（多 folder 覆盖）
			const batchResult = graphSearchCode(
				this._graph.store, '', query, batchProvider, limit, useRegex
			);
			allResults.push(...batchResult.results);
			totalMatches = Math.max(totalMatches, batchResult.totalMatches);

			// grep 截断保护：达到 GREP_MAX_MATCHES 上限则提前终止，避免无谓读盘
			if (allResults.length >= 500) { break; }
		}

		// 全局排序 + 截断
		allResults.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
		return {
			results: allResults.slice(0, limit),
			totalMatches: allResults.length,
			// deadline 到点的部分覆盖透出（工具层据此给模型 hint）
			...(scannedFiles < filteredFileNodes.length
				? { coverage: { scanned: scannedFiles, total: filteredFileNodes.length } }
				: {}),
		};
	}

	/**
	 * 搜索文件候选：project→root 直拼 URI 放最前（一次 exists 即命中），
	 * 其后才是逐 folder 探测候选（2026-07-27，消除逐文件 ×N folder 探测 IO）。
	 */
	private _searchFileCandidatesWithProject(filePath: string, project: string | undefined, projectRoots: Record<string, string>): URI[] {
		const all = this._resolveSearchFileCandidates(filePath);
		const directRoot = project ? projectRoots[project] : undefined;
		if (!directRoot) { return all; }
		const direct = URI.file(directRoot.replace(/[\\/]+$/, '') + '/' + filePath.replace(/\\/g, '/'));
		// 直拼候选排最前；all 中若已含同路径（folder 顺序恰好如此）去重
		const rest = all.filter(u => u.fsPath.replace(/\\/g, '/').toLowerCase() !== direct.fsPath.replace(/\\/g, '/').toLowerCase());
		return [direct, ...rest];
	}

	// ─── P3 API Alignment ─────────────────────────────────────────────────

	searchGraph(params: {
		project?: string;
		query?: string;
		namePattern?: string;
		label?: string;
		filePattern?: string;
		/**
		 * 需要排除的节点类型（**非符号**容器/桩节点，2026-09-15）。
		 * 约定值见 `common/codebaseIndexDefaults.ts` 的 `NON_SYMBOL_NODE_TYPES`。
		 * 语义：**下推到 SQL**（否则 `LIMIT` 已先把符号挤掉，见 `searchNodes` 注释），
		 * 内存回退路径与 renderer 后置过滤再各兜一层。比较大小写不敏感。
		 */
		excludeTypes?: readonly string[];
		/**
		 * 只匹配 `name` 列（**符号名检索**，2026-09-15）。
		 *
		 * 为什么需要：QN = `<相对文件路径>::<符号名>`，不限定字段时搜 `test` 会命中 QN 里的
		 * `…/classifyLLM.test.ts` ⇒ Find Symbol 返回 `MockClassifyLLM`（用户截图报障）。
		 * 语义：下推到 SQL（`nameOnly` 时**跳过 FTS 直接走 `name LIKE`** —— FTS 是词元匹配，
		 * `testHelper` 会被漏掉），内存路径同口径过滤，renderer 再兜一层。
		 */
		nameOnly?: boolean;
		limit?: number;
		offset?: number;
		sortBy?: 'name' | 'inDegree' | 'outDegree' | 'degree';
		sortDesc?: boolean;
		minInDegree?: number;
		maxInDegree?: number;
		minOutDegree?: number;
		maxOutDegree?: number;
		relType?: string;
	}): { nodes: GraphNode[]; total: number; scores?: Record<number, number>; hasMore?: boolean } {
		// 特殊处理：label=file → 用 filePattern 匹配文件路径（而非节点标签）
		const effectiveLabel = params.label === 'file' ? undefined : params.label;
		const effectiveFilePattern = params.label === 'file' ? params.namePattern : (params.filePattern || undefined);

		const result = this._graph.store.search({
			// 多 folder：未显式指定 project 时跨所有 folder/项目搜索（store 在 project 为空时跳过项目过滤）
			project: params.project || undefined,
			query: params.query,
			namePattern: effectiveFilePattern ? undefined : params.namePattern,
			// 符号名检索（2026-09-15）：只匹配 name，不匹配 QN（QN 里含文件路径）
			nameOnly: params.nameOnly,
			label: effectiveLabel,
			filePattern: effectiveFilePattern,
			limit: params.limit,
			offset: params.offset,
			sortBy: params.sortBy,
			sortDesc: params.sortDesc,
			minInDegree: params.minInDegree,
			maxInDegree: params.maxInDegree,
			minOutDegree: params.minOutDegree,
			maxOutDegree: params.maxOutDegree,
			relType: params.relType,
		});
		const graphStore = this._graph;
		let nodes = result.nodes.map((n: any) => graphStore['_nodeToGraphNode'](n)) as GraphNode[];
		let total = result.total;
		// 类型排除（与 SQLite 路径同口径，2026-09-15）：内存回退路径也必须滤掉非符号节点，
		// 否则「sqlite 不可用 / 空库」时 Find Symbol 又变回满屏文件名。
		// ⚠ `store.search` 已按 limit 分页 ⇒ 被排除项在**页外**无法统计，`total` 只能退化为
		// 「本页过滤后的条数」；未传 `excludeTypes` 时保持原 total 语义不变。
		if (params.excludeTypes?.length) {
			const ex = new Set(params.excludeTypes.map(t => t.toLowerCase()));
			nodes = nodes.filter(n => !ex.has((n.type ?? '').toLowerCase()));
			total = nodes.length;
		}
		return {
			nodes,
			total,
			scores: result.scores ? Object.fromEntries(result.scores) : undefined,
			hasMore: result.hasMore,
		};
	}

	/**
	 * glob 文件模式 → 正则（与 CodebaseGraphStore._globToRegex 语义对齐）。
	 * 修复 SQLite 路径原先把 filePattern 当原始正则（new RegExp 直接包 glob）导致
	 * 前导双星号抛异常、过滤被静默跳过的问题；同时折叠连续 dot-star 避免灾难性回溯。
	 * 若 pattern 已是合法正则则原样使用（保持对高级用户的兼容）。
	 */
	private _filePatternToRegex(pattern: string): RegExp | undefined {
		// 已是正则字面量（/.../flags）→ 直接解析
		const lit = /^\/(.+)\/([gimsu]*)$/.exec(pattern);
		if (lit) {
			try { return new RegExp(lit[1], lit[2]); } catch { return undefined; }
		}
		// 先按 glob 转义特殊字符，再把 glob 通配符还原为 regex，最后折叠连续 .*
		const escaped = pattern
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*/g, '.*')
			.replace(/\?/g, '.')
			.replace(/(\.\*)+/g, '.*');
		try { return new RegExp(escaped, 'i'); } catch { return undefined; }
	}

	/**
	 * searchGraph 的 SQLite 后端感知异步版（P0）：
	 * - 后端未启用 → 直接委托同步内存路径（零行为变化）；
	 * - 后端启用 → 文本/名称检索走主进程 FTS5 bm25（LIKE 兜底），候选集在 renderer
	 *   侧做 filePattern/label/排序/分页（每页数百行，代价可忽略）。不回载全图到内存。
	 * 排序近似说明：query 模式沿用 SQLite bm25 顺序（未叠加内存路径的 structural
	 * boosting 加权）；namePattern/LIKE 模式按连接度排序（与 node store SQL 一致）。
	 */
	/**
	 * ★★ 2026-09-20（B：**有检索在飞 ⇒ 推迟 zst 全量落盘**）—— 薄包装，只数「在飞检索数」。
	 *
	 * 真机证据（日志 `vscode-app-1789908435552.log`）：`💾 保存图谱: 96 MB…` 前后检索
	 * `sqlite fetch slow: 2387ms`（共 2503ms）—— 而**空闲库**上同一检索的三条 SQL 全是毫秒级
	 * （LIKE 125–142ms / FTS 内层 2ms / 外层 2ms）⇒ 慢的是**与落盘争用主线程/DB 的等待** ✗✓。
	 * ⇒ 落盘（96MB 序列化 + gzip，与变更集大小无关）**不在检索期间启动**；检索结束后立刻补跑 ✓。
	 *
	 * ⚠ 数据安全：推迟**不越过**既有饥饿上限（见 `_fireSaveOrDefer` 里的 starved 判据）
	 * ⇒ 连续检索流也不会让落盘无限推迟 ✓。
	 */
	async searchGraphAsync(params: Parameters<CodebaseGraphService['_searchGraphAsyncImpl']>[0])
		: Promise<Awaited<ReturnType<CodebaseGraphService['_searchGraphAsyncImpl']>>> {
		this._searchesInFlight++;
		try {
			return await this._searchGraphAsyncImpl(params);
		} finally {
			this._searchesInFlight--;
			if (this._searchesInFlight === 0) { this._flushSavesDeferredBySearch(); }
		}
	}

	private async _searchGraphAsyncImpl(params: {
		project?: string;
		query?: string;
		namePattern?: string;
		label?: string;
		filePattern?: string;
		/**
		 * 需要排除的节点类型（**非符号**容器/桩节点，2026-09-15）。
		 * 约定值见 `common/codebaseIndexDefaults.ts` 的 `NON_SYMBOL_NODE_TYPES`。
		 * 语义：**下推到 SQL**（否则 `LIMIT` 已先把符号挤掉，见 `searchNodes` 注释），
		 * 内存回退路径与 renderer 后置过滤再各兜一层。比较大小写不敏感。
		 */
		excludeTypes?: readonly string[];
		/**
		 * 只匹配 `name` 列（**符号名检索**，2026-09-15）。
		 *
		 * 为什么需要：QN = `<相对文件路径>::<符号名>`，不限定字段时搜 `test` 会命中 QN 里的
		 * `…/classifyLLM.test.ts` ⇒ Find Symbol 返回 `MockClassifyLLM`（用户截图报障）。
		 * 语义：下推到 SQL（`nameOnly` 时**跳过 FTS 直接走 `name LIKE`** —— FTS 是词元匹配，
		 * `testHelper` 会被漏掉），内存路径同口径过滤，renderer 再兜一层。
		 */
		nameOnly?: boolean;
		limit?: number;
		offset?: number;
		sortBy?: 'name' | 'inDegree' | 'outDegree' | 'degree';
		sortDesc?: boolean;
		minInDegree?: number;
		maxInDegree?: number;
		minOutDegree?: number;
		maxOutDegree?: number;
		relType?: string;
	}): Promise<{
		nodes: GraphNode[]; total: number; scores?: Record<number, number>; hasMore?: boolean;
		/**
		 * 「命中全部落在其它项目」时的分布（当前项目 0 命中才置位）。上层据此提示模型
		 * 「该符号只存在于已索引的其它项目 X」，避免收敛后被误读为「符号不存在」。
		 */
		crossProjectOnly?: { project: string; count: number }[];
	}> {
		const _tTotal = Date.now();
		if (!this._sqliteBackendEnabled) {
			// diag：内存同步路径在 renderer 主线程跑全量扫描，是 UI 卡死的嫌疑点，单独计时
			const _t = Date.now();
			const _r = this.searchGraph(params);
			const _ms = Date.now() - _t;
			if (_ms > 200) { this._logService.warn(`[CodebaseGraph] [searchGraphAsync][diag] IN-MEMORY sync path slow: ${_ms}ms needle="${(params.query || params.namePattern || '').slice(0, 40)}" total=${_r.total}`); }
			return _r;
		}
		// ─── SQLite 新鲜度校验（2026-09-09，P0-1「单一事实源」第一步）──────────
		// D1「三源静默漂移」：权威关系倒挂（注释说 zst 权威、查询却走 SQLite），
		// SQLite 落后于内存时旧实现**毫无信号**，只有 candidates=0 才被动回退内存。
		// 这里主动比对两侧节点数：明显落后 → warn + 后台补同步，使漂移可见且自愈，
		// 为最终切换到「SQLite 单一事实源」铺路（有自愈后切换风险大幅下降）。
		// 落后（陈旧/残缺）时本次改走内存——否则会把旧数据当成查询结果返回。
		//
		// 注（P0-1 收尾）：原「空库门控」（_sqliteEmptyProjects.has → 直接走内存）已删除，
		// 由本校验完全覆盖——其判定含 `sqliteCount === 0`（空库即落后），且修复了标记
		// 永久残留的问题（同步成功/落后检测均会清除）。空库场景最多多一次无效 IPC
		// （60s 节流内），换得「标记残留 → 永远查内存」这类状态机缺陷的消失。
		// 项目默认值一律取「当前工作区 folders[0] 对应的项目」——不能用 `_projectName`：
		// 原地切换工作区时并发 merge 会把它钉在别的工作区的项目上（见 _resolveActiveProject 注释）。
		const _wsProject = params.project ?? this._resolveActiveProject();
		if (!await this._ensureSqliteFreshness(_wsProject)) {
			return this.searchGraph(params);
		}
		const limit = params.limit ?? 200;
		const offset = params.offset ?? 0;
		// 候选上限：需覆盖 offset+limit 及后续过滤的损耗
		const candidateCap = Math.max((limit + offset) * 3, 300);
		const needle = (params.query || params.namePattern || '').trim();

		let candidates: GraphNode[];
		const _tFetch = Date.now();
		const _fetchPath = needle ? 'searchNodes' : 'getAllNodes';
		try {
			if (needle) {
				// 文本检索走主进程 FTS5/LIKE（label=file 的语义交给下方 filePattern 过滤）
				const nodeType = params.label && params.label !== 'file' ? params.label : undefined;
				// 2026-09-15：project **下推到 SQL**（第 4 参）。此前不带 project ⇒ 跨全库取前 N 条，
				// 候选池被历史工作区的项目占满（实测 needle="test" 的 231 条全是 S1Game:148 +
				// UE5EA:83，本项目命中不进池），下方 wantProject 收敛后恒为 0（Find Symbol 搜不到东西）。
				// excludeTypes（第 5 参）同理下推：`label='file'` 的桩节点会把符号挤出 LIMIT。
				// nameOnly（第 6 参）：只匹配 name 列 —— 否则 QN 里的文件路径会命中
				// （搜 "test" 返回 `…/classifyLLM.test.ts::MockClassifyLLM`）。
				candidates = await this._sqliteBackend!.searchNodes(needle, nodeType, candidateCap, _wsProject, params.excludeTypes, params.nameOnly);
			} else {
				candidates = await this._sqliteBackend!.getAllNodes(_wsProject, candidateCap);
			}
		} catch (err) {
			// sqlite 后端不可用（打包版缺原生模块等）→ 回退内存图（图已从 gzip 加载时仍可用）
			this._logService.warn('[CodebaseGraph] [searchGraphAsync] sqlite backend failed — falling back to in-memory graph:', err);
			return this.searchGraph(params);
		}
		if (candidates.length === 0 && this.hasGraphData()) {
			// sqlite 空结果但内存有图 → 回退内存图（灾备）。
			// 2026-09-09：不再写「空库」标记（freshness 校验已覆盖该场景：空库 → 落后 →
			// 本次走内存 + 后台同步），避免标记残留导致「同步成功后仍永久查内存」。
			this._logService.info(`[CodebaseGraph] [searchGraphAsync] sqlite returned 0 candidates — falling back to in-memory graph (run index_repository to populate sqlite)`);
			return this.searchGraph(params);
		}
		const _tFetchMs = Date.now() - _tFetch;
		if (_tFetchMs > 500) { this._logService.warn(`[CodebaseGraph] [searchGraphAsync][diag] sqlite fetch slow: ${_tFetchMs}ms needle="${needle.slice(0, 40)}" candidates=${candidates.length} path=${_fetchPath}`); }

		let nodes = candidates;
		const _candCount = candidates.length;

		// ─── project 收敛（2026-08-20，日志 1787221348803）────────────────────────
		// **本方法两条取候选路径此前口径不一致**：
		//   - `getAllNodes(params.project ?? this._projectName, …)` —— 按 project 过滤；
		//   - `searchNodes(needle, nodeType, cap)` —— **签名里根本没有 project**，
		//     于是有 query/namePattern 时（即绝大多数 search_graph 调用）跨【全部已索引
		//     项目】搜索。
		// 实测后果：active workspace 是 sarosis-agents-client，但 sqlite 里还留着
		// S1Game / UE5EA 的节点；模型第 1 轮 `search_graph query="LoadImage"` 拿回
		// candidates=3，**全是 `Engine/Plugins/...` 的 UE 函数**（UE 里 LoadImage 是真
		// 函数所以被索引；本仓的 LoadImage 是 ComfyUI 节点类型【字符串字面量】，代码图
		// 不索引字面量）。模型据此判定图不可用 → 该 turn 之后 65 次全部退回 grep
		// （search_code 66 : search_graph 1）。
		//
		// 修底层 `searchNodes` 需要动 electron-main channel + sqlite store（跨进程，改完
		// 必须完全重启），这里先在 renderer 侧做后置过滤，与 getAllNodes 路径对齐。
		// 保留 `_crossProjectOnly` 供上层给出「该符号只存在于其它项目」的提示——否则
		// 收敛后模型只看到 0 命中，反而更难判断是「不存在」还是「不在本项目」。
		let _crossProjectOnly: { project: string; count: number }[] | undefined;
		if (needle) {
			const wantProject = _wsProject;
			if (wantProject) {
				const inProject = nodes.filter(n => !n.project || n.project === wantProject);
				if (inProject.length !== nodes.length) {
					const others = new Map<string, number>();
					for (const n of nodes) {
						if (n.project && n.project !== wantProject) {
							others.set(n.project, (others.get(n.project) ?? 0) + 1);
						}
					}
					_crossProjectOnly = inProject.length === 0
						? [...others].map(([project, count]) => ({ project, count }))
						: undefined;
					this._logService.info(
						`[CodebaseGraph] [searchGraphAsync] project scope: ${nodes.length} → ${inProject.length} ` +
						`(project="${wantProject}"; dropped from ${[...others].map(([p, c]) => `${p}:${c}`).join(', ')})`,
					);
				}
				nodes = inProject;
			}
		}

		// 类型排除（**兜底**，2026-09-15）：正常已在 SQL 层排除（第 5 参，见 `searchNodes` 注释）。
		// 这里再滤一遍，因为「renderer 已更新、主进程未重启」时旧 main 进程会**静默忽略**该参数
		// （IPC 是位置参数转发）⇒ 只靠 SQL 会让用户以为修复无效（"搜 test 还是满屏文件名"）。
		// 候选 ≤ 数百条，代价可忽略；命中说明 SQL 层没生效，故打 info 便于定位。
		if (params.excludeTypes?.length) {
			const ex = new Set(params.excludeTypes.map(t => t.toLowerCase()));
			const _beforeEx = nodes.length;
			nodes = nodes.filter(n => !ex.has((n.type ?? '').toLowerCase()));
			if (_beforeEx !== nodes.length) {
				this._logService.info(`[CodebaseGraph] [searchGraphAsync] excluded ${_beforeEx - nodes.length} non-symbol node(s) in renderer (types=${params.excludeTypes.join('/')}) — SQL-level exclusion inactive? main process may need a full restart`);
			}
		}

		// 符号名收敛（**兜底**，2026-09-15）：`nameOnly` 正常已在 SQL 层限定 `name` 列（第 6 参）。
		// 这里再滤一遍，同样为兜住「renderer 已更新、主进程未重启」——否则搜 `test` 仍会看到
		// `MockClassifyLLM`（QN 里含 `…/classifyLLM.test.ts`），用户会以为没修好。
		// 判据与 SQL 层一致：`name` 的大小写不敏感**子串**（needle 与 SQL 用的同一个）。
		if (params.nameOnly && needle) {
			const lowerNeedle = needle.toLowerCase();
			const _beforeName = nodes.length;
			nodes = nodes.filter(n => (n.name ?? '').toLowerCase().includes(lowerNeedle));
			if (_beforeName !== nodes.length) {
				this._logService.info(`[CodebaseGraph] [searchGraphAsync] nameOnly filtered ${_beforeName - nodes.length} node(s) matched only via QN/filePath for "${needle}" — SQL-level name restriction inactive? main process may need a full restart`);
			}
		}

		// label 过滤（getAllNodes 路径未按类型过滤时补）
		if (params.label && params.label !== 'file' && !needle) {
			nodes = nodes.filter(n => n.type === params.label);
		}
		const _afterLabel = nodes.length;
		// label=file → 用 namePattern 匹配文件路径（对齐同步路径语义）
		const effectiveFilePattern = params.label === 'file' ? params.namePattern : params.filePattern;
		if (effectiveFilePattern) {
			// glob 语义转换（修复原先当原始正则导致前导 ** 抛异常、过滤失效的问题）
			const re = this._filePatternToRegex(effectiveFilePattern);
			if (re) {
				nodes = nodes.filter(n => n.filePath && re.test(n.filePath));
			}
		}
		const _afterFilePattern = nodes.length;
		// 度数范围过滤（对齐同步路径参数契约）
		if (params.minInDegree !== undefined) { nodes = nodes.filter(n => (n.inDegree ?? 0) >= params.minInDegree!); }
		if (params.maxInDegree !== undefined) { nodes = nodes.filter(n => (n.inDegree ?? 0) <= params.maxInDegree!); }
		if (params.minOutDegree !== undefined) { nodes = nodes.filter(n => (n.outDegree ?? 0) >= params.minOutDegree!); }
		if (params.maxOutDegree !== undefined) { nodes = nodes.filter(n => (n.outDegree ?? 0) <= params.maxOutDegree!); }

		// 排序（未指定时保留后端顺序：FTS5 bm25 或连接度 DESC）
		if (params.sortBy) {
			const desc = params.sortDesc ?? (params.sortBy !== 'name');
			const keyOf = (n: GraphNode): number | string => {
				switch (params.sortBy) {
					case 'name': return String(n.name);
					case 'inDegree': return n.inDegree ?? 0;
					case 'outDegree': return n.outDegree ?? 0;
					default: return (n.inDegree ?? 0) + (n.outDegree ?? 0);
				}
			};
			nodes = [...nodes].sort((a, b) => {
				const ka = keyOf(a); const kb = keyOf(b);
				const cmp = typeof ka === 'string' ? ka.localeCompare(String(kb)) : (ka as number) - (kb as number);
				return desc ? -cmp : cmp;
			});
		}

		const total = nodes.length;
		const _totalMs = Date.now() - _tTotal;
		// [CBSearch] 召回漏斗追踪：候选 → label 过滤 → filePattern 过滤 → 度数过滤 → total（排查"找不到内容"）
		this._logService.info(`[CodebaseGraph] [CBSearch][trace] searchGraphAsync needle="${needle.slice(0, 60)}" label=${params.label ?? '-'} filePattern=${effectiveFilePattern ?? '-'} path=${_fetchPath} cap=${candidateCap} candidates=${_candCount} →label=${_afterLabel} →filePattern=${_afterFilePattern} →total=${total} page=${nodes.slice(offset, offset + limit).length} ${_totalMs}ms`);
		if (_totalMs > 1000) { this._logService.warn(`[CodebaseGraph] [searchGraphAsync][diag] TOTAL slow: ${_totalMs}ms needle="${needle.slice(0, 40)}" total=${total} backend=sqlite`); }
		return { nodes: nodes.slice(offset, offset + limit), total, hasMore: offset + limit < total, crossProjectOnly: _crossProjectOnly };
	}

	tracePathAdvanced(sourceName: string, targetName: string | undefined, opts?: {
		mode?: 'calls' | 'data_flow' | 'cross_service';
		maxDepth?: number;
		excludeEntry?: boolean;
		direction?: 'both' | 'callers' | 'callees';
		includeTests?: boolean;
		edgeTypes?: string[];
	}): any {
		const mode = opts?.mode || 'calls';
		const maxDepth = opts?.maxDepth || 10;
		const direction = opts?.direction || 'callees';
		const includeTests = opts?.includeTests ?? true;
		// 多 folder：不传 project → 搜索全部项目（含 S1Game + UE5EA 等）
		return tracePath(this._graph.store, undefined, sourceName, targetName, mode as any, maxDepth, direction, includeTests, opts?.edgeTypes);
	}

	async getArchitectureAdvanced(dimensions?: string[], project?: string): Promise<any> {
		// 2026-08-09：默认限定当前项目（避免全量分析含 UE5EA 等所有项目导致卡住）；
		// 显式传 project 时跨项目分析。
		const projectName = project || this._projectName;
		const report: any = await analyzeArchitecture(this._graph.store, projectName);

		// 2026-08-17（日志 1786941660317，UI 卡死 ~47s）：detectDeadCodeEnhanced（BFS 用
		// Array.shift() 是 O(n²)）与 computeTwoLevelLOD 在 12.7万节点上同步跑是主线程
		// 秒级阻塞。与 analyzeArchitecture 内部降级阈值一致（>30000 节点），大图跳过
		// 这两个重型附加分析（它们是加分项，非核心架构字段）。
		const isLarge = report.totalNodes > 30_000;
		if (!isLarge) {
			try {
				report.deadCode = detectDeadCodeEnhanced(this._graph.store, this._projectName);
			} catch { /* ignore */ }

			try {
				const layout = computeTwoLevelLOD(this._graph.store, this._projectName, 'overview');
				report.layoutNodes = layout.size;
			} catch { /* ignore */ }
		} else if (report.aspectsSkipped === undefined) {
			// 大图但 aspectsSkipped 未设置（理论上 analyzeArchitecture 已设置，此处兜底防漏）
			report.aspectsSkipped = `large-graph degraded: skipped deadCode/layout (${report.totalNodes} nodes > 30000)`;
		}

		if (!dimensions || dimensions.length === 0) { return report; }
		const filtered: any = {};
		for (const dim of dimensions) {
			if (report[dim] !== undefined) { filtered[dim] = report[dim]; }
		}
		filtered.totalNodes = report.totalNodes;
		filtered.totalEdges = report.totalEdges;
		return filtered;
	}

	async getCodeSnippet(qualifiedName: string, contextLines: number = 3, includeNeighbors: boolean = false): Promise<{ filePath: string; startLine: number; endLine: number; content: string; language: string; neighbors?: { name: string; content: string; startLine: number; endLine: number }[] } | null> {
		// 多 folder：先查当前项目，未命中再跨所有 folder/项目查找；仍 miss 则模糊解析
		// （容忍 LLM 传入的截断/部分符号名，如 PerformReachabilityAnalysis → PerformReachabilityAnalysisPass）
		let node = this._graph.store.findNodeByQN(this._projectName, qualifiedName);
		if (!node) { node = this._graph.store.findNodeByQNAnyProject(qualifiedName); }
		if (!node) { node = this._graph.store.findNodeByQNFuzzy(this._projectName, qualifiedName); }
		// SQLite 后端兜底：内存 store 只加载了当前项目，跨项目符号（如 UE5EA 的 IncrementalPurgeGarbage）
		// 可能在 SQLite 中存在但未被加载到内存 store。
		if (!node && this._sqliteBackendEnabled) {
			const hits = await this._sqliteBackend.searchNodes(qualifiedName, undefined, 5);
			if (hits.length > 0 && hits[0].filePath) {
				// 将 service GraphNode（id:string, label）转为 store GraphNode（id:number, label）
				const hit = hits[0];
				node = {
					id: Number(hit.id) || 0,
					project: hit.project || this._projectName,
					label: hit.label || hit.type || '',
					name: hit.name,
					qualifiedName: hit.qualifiedName || hit.name,
					filePath: hit.filePath,
					startLine: hit.startLine,
					endLine: hit.endLine,
					properties: hit.properties || {},
					inDegree: hit.inDegree ?? 0,
					outDegree: hit.outDegree ?? 0,
				};
			}
		}
		if (!node || !node.filePath) { return null; }

		const startLine = Math.max(1, (node.startLine || 1) - contextLines);
		const endLine = (node.endLine || node.startLine || 1) + contextLines;

		const ext = node.filePath.split('.').pop()?.toLowerCase() || '';
		const langMap: Record<string, string> = {
			ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'javascript',
			py: 'python', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp',
			cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
		};
		const language = langMap[ext] || 'plaintext';

		let content = '';
		let allLines: string[] | undefined;
		let resolvedFsPath: string | undefined;
		try {
			// 逐个候选尝试读取，取第一个存在的（多 folder 工作区：相对路径依次尝试每个根）
			let fileContent: { value: { toString(): string } } | undefined;
			for (const cand of this._resolveSearchFileCandidates(node.filePath)) {
				if (await this._fileService.exists(cand)) {
					fileContent = await this._fileService.readFile(cand);
					resolvedFsPath = cand.fsPath;
					break;
				}
			}
			if (!fileContent) { return null; }
			const fullText = fileContent.value.toString();
			allLines = fullText.split('\n');
			const selected = allLines.slice(startLine - 1, endLine);
			content = selected.map((line, i) => `${startLine + i}\t${line}`).join('\n');
		} catch (err: any) {
			content = `// Failed to read file: ${err?.message || err}`;
		}

		// includeNeighbors: 查找同文件中的前后相邻函数/类
		let neighbors: { name: string; content: string; startLine: number; endLine: number }[] | undefined;
		if (includeNeighbors && allLines) {
			const allNodes = this._graph.store.search({
				project: node.project || this._projectName,
				limit: 20000,
			}).nodes.filter(n => n.filePath === node!.filePath && n.id !== node!.id);

			// 按行号排序
			allNodes.sort((a, b) => (a.startLine || 0) - (b.startLine || 0));

			// 找当前节点之前/之后最近的节点（最多3个）
			const prevNodes = allNodes.filter(n => (n.endLine || n.startLine || 0) < (node.startLine || 0)).slice(-2);
			const nextNodes = allNodes.filter(n => (n.startLine || 0) > (node.endLine || 0)).slice(0, 2);
			const nearbyNodes = [...prevNodes, ...nextNodes];

			neighbors = [];
			for (const n of nearbyNodes) {
				if (!n.startLine || !n.endLine) { continue; }
				const nStart = Math.max(1, n.startLine - contextLines);
				const nEnd = Math.min(allLines!.length, n.endLine + contextLines);
				const nContent = allLines!.slice(nStart - 1, nEnd)
					.map((line, i) => `${nStart + i}\t${line}`).join('\n');
				neighbors.push({
					name: n.name,
					content: nContent,
					startLine: n.startLine,
					endLine: n.endLine,
				});
			}
		}

		return {
			// 返回实际读取命中的绝对路径（多 folder 工作区：相对 filePath 会让
			// 调用方误拼首个 folder 根导致 file_read 失败）
			filePath: resolvedFsPath ?? node.filePath,
			startLine,
			endLine,
			content,
			language,
			neighbors,
		};
	}

	listProjects(): { name: string; nodeCount: number; edgeCount: number; fileCount: number }[] {
		return this._graph.store.listProjects();
	}

	getProjectRoots(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [root, project] of this._rootProjectMap) {
			out[project] = root;
		}
		return out;
	}

	deleteProject(name: string): void {
		this._graph.store.deleteProject(name);
		this._cypherEngine = undefined;
		this._semanticSearch = undefined;
	}

	/**
	 * 把图谱节点的 root 相对 `filePath` 解析为**真实存在**的绝对 URI + 1-based 行号。
	 *
	 * 2026-09-15 新增（用户报「Find Symbol 双击 item 无法跳转」后**统一**）：
	 * 此前 5 处跳转各自手写「project root + 相对路径」拼串，**每一处都会静默失败**——
	 *  ① 只认 `getProjectRoots()[node.project]` **一项**（project 名对不上就直接放弃）；
	 *  ② 把 `node.startLine` 当成「可跳转」的前提，而图谱里**最常见的一类命中没有行号**
	 *     —— `addEdge()` 为 CONTAINS 边实体化的 `label='file'` stub 节点只写
	 *     `filePath`/`qualifiedName`/`name`（搜文件名命中的正是它们）；
	 *  ③ `joinPath` 是 **posix** 语义 ⇒ `filePath` 含 `\` 时会拼出「文件名里带 `\`」的坏 URI。
	 *
	 * 候选顺序（取第一个 `exists()` 的）：
	 *   ① 该节点 project 的直拼 root（多 folder 下同名相对路径优先归它）
	 *   ② 其余**已注册** root（`_rootProjectMap`，覆盖索引根 ≠ 工作区 folder 的情形）
	 *   ③ `_resolveSearchFileCandidates()`（工作区各 folder 探测 + 绝对路径直解）
	 * 全都不存在才返回 undefined（索引陈旧 / 文件已删）。
	 */
	async resolveNodeLocation(node: { name?: string; filePath?: string; project?: string; startLine?: number }, opts?: { quiet?: boolean }): Promise<{ uri: URI; line: number } | undefined> {
		if (!node.filePath) { return undefined; }
		const line = Math.max(1, node.startLine ?? 1);
		const candidates = this._nodeFileCandidates(node.filePath, node.project);
		for (const uri of candidates) {
			try {
				if (await this._fileService.exists(uri)) { return { uri, line }; }
			} catch { /* 该候选不可用 → 试下一个 */ }
		}
		if (!opts?.quiet) {
			this._logService.warn('[CodebaseGraph]', `[resolveNodeLocation] file not found: "${node.filePath}"${node.name ? ` (node="${node.name}")` : ''} project="${node.project ?? '-'}" — tried ${candidates.length} candidate(s); stale index or file deleted?`);
		}
		return undefined;
	}

	/**
	 * `resolveNodeLocation` 的候选 URI 列表（按优先级去重）。
	 * 绝对路径（盘符 / 前导 `/`、`\`）无需拼根，交给 `_resolveSearchFileCandidates` 直解
	 * ——其内部已含「工作区各 folder 依次探测」。
	 */
	private _nodeFileCandidates(filePath: string, project?: string): URI[] {
		const out: URI[] = [];
		const seen = new Set<string>();
		const push = (u: URI) => {
			const k = u.fsPath.replace(/\\/g, '/').toLowerCase();
			if (!seen.has(k)) { seen.add(k); out.push(u); }
		};
		if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(filePath)) {
			// 拼法与 `_searchFileCandidatesWithProject` 一致：去尾分隔符 + 归一为正斜杠
			const rel = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
			const roots = this.getProjectRoots();
			const prefer = project ? roots[project] : undefined;
			if (prefer) { push(URI.file(prefer.replace(/[\\/]+$/, '') + '/' + rel)); }
			for (const r of Object.values(roots)) { push(URI.file(r.replace(/[\\/]+$/, '') + '/' + rel)); }
		}
		for (const u of this._resolveSearchFileCandidates(filePath)) { push(u); }
		return out;
	}

	// ─── Change Detection ─────────────────────────────────────────────────

	async detectChanges(opts?: { since?: string; baseBranch?: string; impactAnalysis?: boolean; scope?: string; depth?: number }): Promise<any> {
		const store = this._graph.store;
		const project = this._projectName;
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return { trackedFiles: 0, changedFiles: [], impactAnalysis: { affectedNodes: 0, affectedEdges: 0 } };
		}
		const rootPath = folders[0].uri.fsPath;

		let changedFiles: { path: string; status: string }[] = [];
		const effectiveRef = opts?.since || opts?.baseBranch;
		try {
			// If a specific reference is provided, diff against it; otherwise use working tree changes
			changedFiles = await this._getGitChangedFilesViaApi(rootPath, effectiveRef);
		} catch (err: any) {
			this._logService.debug('[CodebaseGraph]', `Git API failed: ${err?.message || err}`);
		}

		// Fallback to file-hash comparison if git returned no changes
		if (changedFiles.length === 0 && !effectiveRef) {
			changedFiles = this._getChangedFilesViaHashes(project, rootPath);
		}

		// scope: 仅统计给定目录前缀下的变更文件（对标 C 的 scope 参数）
		const scopeNorm = opts?.scope ? opts.scope.replace(/\\/g, '/').replace(/\/$/, '') : undefined;
		if (scopeNorm) {
			changedFiles = changedFiles.filter(cf => cf.path.replace(/\\/g, '/').startsWith(scopeNorm));
		}

		const affectedNodeIds = new Set<number>();
		const affectedFiles: string[] = [];
		for (const cf of changedFiles) {
			const relPath = cf.path.replace(/\\/g, '/');
			affectedFiles.push(relPath);
			const nodes = store.findNodesByFile(project, relPath);
			for (const n of nodes) { affectedNodeIds.add(n.id); }
		}

		let downstreamCount = 0;
		let affectedEdges = 0;
		// depth: BFS 影响传播的最大跳数（对标 C 的 depth，默认 5）
		const maxImpactDepth = opts?.depth ?? 5;
		if (opts?.impactAnalysis !== false) {
			const visited = new Set<number>();
			const queue: { id: number; depth: number }[] = [];
			for (const id of affectedNodeIds) {
				queue.push({ id, depth: 0 });
				visited.add(id);
			}
			while (queue.length > 0 && visited.size < 500) {
				const { id, depth } = queue.shift()!;
				if (depth >= maxImpactDepth) { continue; }
				const edges = store.getEdgesBySource(id);
				for (const edge of edges) {
					affectedEdges++;
					if (edge.type === 'CALLS' || edge.type === 'IMPORTS' || edge.type === 'USAGE') {
						if (!visited.has(edge.targetId)) {
							visited.add(edge.targetId);
							downstreamCount++;
							queue.push({ id: edge.targetId, depth: depth + 1 });
						}
					}
				}
			}
		}

		let riskLevel = 'Low';
		const riskReasons: string[] = [];
		if (affectedNodeIds.size > 20) { riskLevel = 'High'; riskReasons.push(`${affectedNodeIds.size} affected nodes`); }
		else if (affectedNodeIds.size > 5) { riskLevel = 'Medium'; riskReasons.push(`${affectedNodeIds.size} affected nodes`); }
		if (downstreamCount > 50) { riskLevel = 'Critical'; riskReasons.push(`${downstreamCount} downstream nodes impacted`); }

		return {
			trackedFiles: store.getAllFileHashes(project).length,
			changedFiles: affectedFiles,
			changedCount: changedFiles.length,
			since: opts?.since || opts?.baseBranch || 'HEAD',
			scope: scopeNorm,
			depth: maxImpactDepth,
			affectedNodes: affectedNodeIds.size,
			affectedEdges,
			downstreamImpact: downstreamCount,
			riskLevel,
			riskReasons: riskReasons.length > 0 ? riskReasons : ['No significant risk'],
			impactAnalysis: { affectedNodes: affectedNodeIds.size, affectedEdges, downstreamCount },
		};
	}

	private async _getGitChangedFilesViaApi(rootPath: string, ref?: string): Promise<{ path: string; status: string }[]> {
		try {
			const gitApi: any = await this._commandService.executeCommand('git.api');
			if (gitApi && gitApi.repositories) {
				const repo = gitApi.repositories.find((r: any) => r.rootUri?.fsPath === rootPath) || gitApi.repositories[0];
				if (repo) {
					const changes: { path: string; status: string }[] = [];

					// If a git reference is provided, diff against it; otherwise use working tree + index
					if (ref) {
						try {
							const diff: any[] = await repo.diffBetween(ref, 'HEAD');
							if (diff && Array.isArray(diff)) {
								for (const item of diff) {
									const uriPath = item.uri?.fsPath || item.path || '';
									const relPath = uriPath.replace(rootPath, '').replace(/^[\\/]/, '');
									if (relPath) {
										changes.push({ path: relPath, status: item.status?.toString() || 'M' });
									}
								}
							}
						} catch (diffErr: any) {
							this._logService.debug('[CodebaseGraph]', `Git diff failed, falling back to working tree: ${diffErr?.message || diffErr}`);
						}
					}

					// If no ref was provided OR diff failed, use working tree + index
					if (!ref || changes.length === 0) {
						const state = repo.state;
						if (state?.workingTreeChanges) {
							for (const c of state.workingTreeChanges) {
								if (c.uri) {
									changes.push({
										path: c.uri.fsPath.replace(rootPath, '').replace(/^[\\/]/, ''),
										status: c.status?.toString() || 'M',
									});
								}
							}
						}
						if (state?.indexChanges) {
							for (const c of state.indexChanges) {
								if (c.uri) {
									const relPath = c.uri.fsPath.replace(rootPath, '').replace(/^[\\/]/, '');
									if (!changes.find(x => x.path === relPath)) {
										changes.push({ path: relPath, status: c.status?.toString() || 'M' });
									}
								}
							}
						}
					}
					return changes;
				}
			}
		} catch { /* git extension not available */ }
		return [];
	}

	private _getChangedFilesViaHashes(project: string, _rootPath: string): { path: string; status: string }[] {
		// Fallback: compare stored file hashes against current disk content.
		// Only report files whose hash actually changed (not all tracked files).
		const changes: { path: string; status: string }[] = [];
		try {
			const trackedHashes = this._graph.store.getAllFileHashes(project);
			const folders = this._workspaceService.getWorkspace().folders;
			if (folders.length === 0) { return changes; }
			const rootUri = folders[0].uri;
			void rootUri; // hash fallback 暂未使用，但保留引用以便后续哈希比较实现

			// We can't easily compute SHA-256 of all files synchronously here;
			// hash comparison relies on the index pipeline's stored hashes
			// (updated during incremental re-index). For now, report no changes
			// on hash fallback — the caller should re-index to detect changes.
			// A full comparison would require reading all tracked files, which
			// is expensive for large projects.
			if (trackedHashes.length > 0) {
				// Return minimal info: number of tracked files, but mark 0 changed
				// (the caller receives trackedFiles count separately).
			}
		} catch { /* best effort */ }
		return changes;
	}

	// ─── Trace Ingestion ──────────────────────────────────────────────────

	ingestTraces(otlpJson: string): { spansIngested: number; edgesWritten: number } {
		const ingester = new TraceIngester();
		const spansIngested = ingester.ingest(otlpJson);
		const edgesWritten = ingester.writeToStore(this._graph.store, this._projectName);
		this._logService.info('[CodebaseGraph]', `Trace ingestion: ${spansIngested} spans -> ${edgesWritten} edges`);
		return { spansIngested, edgesWritten };
	}

	// ─── Persistence ──────────────────────────────────────────────────────

	/** Graph artifact path: {rootPath}/.codebase-memory/graph.db.zst */
	static getGraphArtifactPath(rootPath: string): string {
		return URI.joinPath(URI.file(rootPath), '.codebase-memory', 'graph.db.zst').fsPath;
	}

	/** Legacy graph path for backward compatibility: {rootPath}/.sarosworkspace/.codebase-memory/graph.json */
	static getLegacyGraphPath(rootPath: string): string {
		return URI.joinPath(URI.file(rootPath), '.sarosworkspace', '.codebase-memory', 'graph.json').fsPath;
	}

	async getGraphStatus(workspacePath?: string): Promise<IGraphStatus> {
		let wsPath = workspacePath;
		if (!wsPath) {
			const folders = this._workspaceService.getWorkspace().folders;
			if (folders.length === 0) { return { exists: false }; }
			wsPath = folders[0].uri.fsPath;
		}

		// New path: {rootPath}/.codebase-memory/graph.db.zst
		// 也兼容同一目录下旧版本可能写入的 graph.db.gz / graph.json
		const graphDir = URI.joinPath(URI.file(wsPath), '.codebase-memory');
		const candidateUris = [
			URI.joinPath(graphDir, 'graph.db.zst'),
			URI.joinPath(graphDir, 'graph.db.gz'),
			URI.joinPath(graphDir, 'graph.json'),
		];

		for (const artifactUri of candidateUris) {
			try {
				const stat = await this._fileService.stat(artifactUri);
				return {
					exists: true,
					graphPath: artifactUri.fsPath,
					size: stat.size,
					lastModified: new Date(stat.mtime).toISOString(),
					nodeCount: this._graph.nodeCount,
					edgeCount: this._graph.edgeCount,
				};
			} catch {
				// 尝试下一个候选路径
			}
		}

		// Legacy path: {rootPath}/.sarosworkspace/.codebase-memory/graph.json
		const legacyDir = URI.joinPath(URI.file(wsPath), '.sarosworkspace', '.codebase-memory');
		const legacyArtifactUri = URI.joinPath(legacyDir, 'graph.db.gz');
		const legacyJsonUri = URI.joinPath(legacyDir, 'graph.json');

		try {
			const stat = await this._fileService.stat(legacyArtifactUri);
			return { exists: true, graphPath: legacyArtifactUri.fsPath, size: stat.size, lastModified: new Date(stat.mtime).toISOString(), nodeCount: this._graph.nodeCount, edgeCount: this._graph.edgeCount };
		} catch { /* try JSON */ }

		try {
			const stat = await this._fileService.stat(legacyJsonUri);
			return { exists: true, graphPath: legacyJsonUri.fsPath, size: stat.size, lastModified: new Date(stat.mtime).toISOString(), nodeCount: this._graph.nodeCount, edgeCount: this._graph.edgeCount };
		} catch {
			return { exists: false };
		}
	}

	async saveGraph(targetPath: string): Promise<void> {
		const data = this._graph.toJSON();
		const json = JSON.stringify(data);
		await this._fileService.writeFile(URI.file(targetPath), VSBuffer.fromString(json));
		this._logService.info('[CodebaseGraph]', `Graph saved: ${targetPath} (${data.nodes.length} nodes)`);
	}

	// ─── Artifact export/import (P2-#3) ──────────────────────────────
	// Exposes GraphPersistence.exportArtifact/importArtifact on the core service so
	// builtin tools (and external MCP/CLI consumers) can share graphs as portable artifacts.
	async exportArtifact(targetPath: string, opts?: { slim?: boolean }): Promise<{ size: number; nodeCount: number; edgeCount: number }> {
		const persistence = new GraphPersistence(this._fileService, this._logService);
		const result = await persistence.exportArtifact(this._graph.store, targetPath, opts);
		this._logService.info('[CodebaseGraph]', `Artifact exported: ${targetPath} (${result.nodeCount} nodes, ${result.edgeCount} edges, ${result.size} bytes, slim=${opts?.slim ?? true})`);
		return result;
	}

	async importArtifact(sourcePath: string): Promise<boolean> {
		const persistence = new GraphPersistence(this._fileService, this._logService);
		const loaded = await persistence.importArtifact(this._graph.store, sourcePath);
		this._logService.info('[CodebaseGraph]', `Artifact import ${loaded ? 'succeeded' : 'failed'}: ${sourcePath}`);
		return loaded;
	}

	/**
	 * 从已加载的图中自动检测项目名（用于加载 C 版 graph.db.zst 后设置正确的 _projectName）。
	 * C 版索引器存储的项目名可能与 TS 版的 '_default' 不同，导致 findNodesByLabel 查不到节点。
	 */
	private _autoDetectProjectName(): void {
		try {
			const projects = this._graph.store.listProjects();
			if (projects.length > 0) {
				// 选节点数最多的项目
				projects.sort((a, b) => b.nodeCount - a.nodeCount);
				const detected = projects[0].name;
				this._setProjectNameUnlessIndexing(detected);
				this._logService.info('[CodebaseGraph]', `[loadGraph] auto-detected projectName="${detected}" (${projects[0].nodeCount} nodes, ${projects.length} project(s) total)`);
			}
		} catch (err: any) {
			this._logService.warn('[CodebaseGraph]', `[loadGraph] auto-detect projectName failed: ${err?.message || err}`);
		}
	}

	async loadGraph(sourcePath: string): Promise<boolean> {
		const tStart = Date.now();
		// sourcePath can be: graph.db.zst (new), graph.db.gz (old compressed), or graph.json (old plain)
		const compressedPaths = [sourcePath];
		if (sourcePath.endsWith('.json')) {
			compressedPaths.push(
				sourcePath.replace(/\.json$/, '.db.zst'),
				sourcePath.replace(/\.json$/, '.db.gz'),
			);
		} else if (sourcePath.endsWith('.db.gz')) {
			compressedPaths.push(sourcePath.replace(/\.db\.gz$/, '.db.zst'));
		} else if (sourcePath.endsWith('.db.zst')) {
			// Already the new format, try directly
		}

		for (const p of compressedPaths) {
			try {
				this._logService.info('[CodebaseGraph]', `[loadGraph] trying: ${p}`);
				const persistence = new GraphPersistence(this._fileService, this._logService);
				// ★ 2026-09-18：同 `_loadGraphMergeImpl` —— 检索走 FTS5 时跳过内存倒排重建（按需重建）
				const loaded = await persistence.load(this._graph.store, p, { skipBm25: this._sqliteBackendEnabled });
				if (loaded) {
					this._logService.info('[CodebaseGraph]', `[loadGraph] loaded ${p} (${Date.now() - tStart}ms), store nodes=${this._graph.nodeCount}`);
					this._autoDetectProjectName();
					return true;
				}
			} catch (err: any) {
				this._logService.debug('[CodebaseGraph]', `[loadGraph] failed ${p}: ${err?.message || err}`);
			}
		}

		// Fall back to plain JSON
		const jsonPath = sourcePath.replace(/\.(ds|db)\.(gz|zst)$/, '.json');
		try {
			const content = await this._fileService.readFile(URI.file(jsonPath));
			// Yield before heavy JSON.parse to let UI render loading state
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			const data = JSON.parse(content.value.toString()) as GraphData;
			this._logService.info('[CodebaseGraph]', `Loading graph (${data.nodes.length} nodes, ${data.edges.length} edges)...`);
			await this._graph.fromJSONAsync(data, (loaded, total) => {
				if (loaded % 50000 === 0 || loaded === total) {
					this._logService.info('[CodebaseGraph]', `Graph load progress: ${loaded}/${total}`);
				}
			});
			this._logService.info('[CodebaseGraph]', `Graph loaded: ${jsonPath} (${data.nodes.length} nodes)`);
			this._autoDetectProjectName();
			return true;
		} catch (err: any) {
			this._logService.warn('[CodebaseGraph]', `Failed to load graph: ${err?.message || err}`);
			return false;
		}
	}

	/**
	 * 合并加载：把 sourcePath 的图追加到当前内存 store（不清空），用于多 folder 工作区。
	 * 各 folder 的 graph.db.zst 独立持久化，启动时依次合并进同一 store（ID 重映射 + 项目名覆盖）。
	 */
	/**
	 * ★★★ 2026-09-18（P0 性能）**收口**：只有「内存检索是主路径」时才全量重建内存倒排。
	 *
	 * 为什么这条开关可以安全生效（已核实的事实，勿凭感觉推翻）：
	 *   · 自由文本检索（`SearchParams.query`）的**唯一**生产消费者是 `searchGraphAsync`；
	 *     同步 `searchGraph()` **无任何外部调用者**（trace / lsp / cypher / 兄弟节点
	 *     全部只传 `namePattern`（正则）或 `label`（标签索引）⇒ 不经 BM25）；
	 *   · 即使有同步调用，`CodebaseGraphStore.search()` 在标记期间会**降级为子串扫描**
	 *     （见 `_degradedSubstringScores`）⇒ 不会静默返回 0 结果 ✗；
	 *   · `_sqliteBackendEnabled`（默认 true）时检索走主进程 FTS5 ⇒ 内存倒排为**纯灾备**。
	 * ⇒ 与其在**每条载入/索引路径**上无条件付 9s 级全量重建（真机 9137ms / ⛔2393ms），
	 *   不如统一置「按需重建」标记（见 `CodebaseGraphStore._bm25Deferred`）。
	 *
	 * @returns 是否真的执行了重建（`false` = 已置标记、由首次回退内存检索时按需建）
	 */
	private async _rebuildBM25OrDefer(reason: string, onProgress?: (done: number, total: number) => void): Promise<boolean> {
		if (this._sqliteBackendEnabled) {
			this._graph.store.markBM25Deferred();
			this._logService.info('[CodebaseGraph]', `跳过内存 BM25 重建（检索走 FTS5）⇒ 已置「按需重建」标记：${reason}`);
			return false;
		}
		await this._graph.store.rebuildBM25(onProgress, true);
		return true;
	}

	/**
	 * ★★★ 2026-09-18（P1-1）：「**制品解析可跳过**」判据 —— 主进程 SQLite 已有该项目、且**不比制品旧**。
	 *
	 * 动机：载入制品的「解析 JSON」是加载路径上最后一笔整段重活（真机 3 folder ≈ **7320ms**）。
	 * 而本仓每次全量索引/增量补丁都会把图同步进主进程 SQLite（`nodes_fts` 同步维护）⇒
	 * **默认配置下 SQLite 已经持有同一份图** ⇒ 再解析一遍 gzip+JSON 多数时候是白付 ✗。
	 *
	 * 判据（保守，宁可多解析一次也不许用落后数据）：
	 *   · `_sqliteBackendEnabled` 且 SQLite 的**节点数 ≥ `artifact.json` 记录的 node_count**；
	 *   · 拿不到 `artifact.json` / 计数非法 / 任何异常 ⇒ **返回 false**（照旧解析）✓。
	 * 跳过后的数据来源：首次真正用到图时走 `tryLoadFromSqlite()`（主进程分页载入 + 进度 + 失败退避，
	 * 见 `_loadGraphFromSqlite`）✓ —— 不是「不加载」，只是**推迟到需要时**、并换一条更便宜的路。
	 *
	 * @param project 项目名（= folder basename，与 SQLite 的 project 口径一致）
	 * @param graphFilePath 制品路径（用来同目录定位 `artifact.json`）
	 */
	async canSkipArtifactParse(project: string, graphFilePath: string): Promise<boolean> {
		if (!this._sqliteBackendEnabled) { return false; }
		try {
			// artifact.json 与制品同目录（`<root>/.codebase-memory/`），键为 snake_case：node_count / edge_count
			const metaPath = graphFilePath.replace(/graph\.db\.\w+$/, 'artifact.json');
			let artifactNodes = 0;
			try {
				const raw = (await this._fileService.readFile(URI.file(metaPath))).value.toString();
				artifactNodes = Number((JSON.parse(raw) as { node_count?: number })?.node_count) || 0;
			} catch { /* 无 artifact.json（老制品）⇒ 无法证明 SQLite 不落后 ⇒ 保守返回 false */ }
			if (artifactNodes <= 0) { return false; }
			const sqliteNodes = await this._sqliteBackend.getTotalNodeCount(project);
			if (sqliteNodes >= artifactNodes) { return true; }
			this._logService.info('[CodebaseGraph]', `[canSkipArtifactParse] "${project}" 的 SQLite 节点数落后（sqlite=${sqliteNodes} < artifact=${artifactNodes}）⇒ 本次仍解析制品`);
			return false;
		} catch (err: any) {
			// 判据本身出错 ⇒ 保守按「不可跳过」处理（绝不能让跳过路径建立在未知状态上 ✗）
			this._logService.warn('[CodebaseGraph]', `[canSkipArtifactParse] "${project}" 判据失败，按不可跳过处理: ${err?.message || err}`);
			return false;
		}
	}

	async loadGraphMerge(sourcePath: string, projectOverride?: string, rebuildBM25: boolean = true): Promise<boolean> {
		this._graphLoadingCount++;
		try {
			return await this._loadGraphMergeImpl(sourcePath, projectOverride, rebuildBM25);
		} finally {
			this._graphLoadingCount--;
			if (this._graphLoadingCount === 0) {
				const waiters = this._graphLoadingWaiters.splice(0);
				for (const w of waiters) { w(); }
			}
		}
	}

	private async _loadGraphMergeImpl(sourcePath: string, projectOverride?: string, rebuildBM25: boolean = true): Promise<boolean> {
		const tStart = Date.now();
		// 快速路径（2026-09-15）：进入时就已不属于当前工作区 ⇒ 连解析都省掉。
		// 合并大图要 10~40s，而工作区切换只需一秒；没有这道闸，一次「切过去又切回来」
		// 就会把别的工作区的巨图完整读进内存（下面完成处的守卫只能事后丢弃）。
		{
			const idx = sourcePath.lastIndexOf('/.codebase-memory/') >= 0 ? sourcePath.lastIndexOf('/.codebase-memory/')
				: sourcePath.lastIndexOf('\\.codebase-memory\\');
			if (idx > 0 && !this._isRootInCurrentWorkspace(this._normalizeRoot(sourcePath.substring(0, idx)))) {
				this._logService.info('[CodebaseGraph]', `[loadGraphMerge] skipped ${sourcePath} — root is not part of the current workspace`);
				return false;
			}
		}
		const candidates = [sourcePath];
		if (sourcePath.endsWith('.json')) {
			candidates.push(sourcePath.replace(/\.json$/, '.db.zst'), sourcePath.replace(/\.json$/, '.db.gz'));
		} else if (sourcePath.endsWith('.db.gz')) {
			candidates.push(sourcePath.replace(/\.db\.gz$/, '.db.zst'));
		}

		const persistence = new GraphPersistence(this._fileService, this._logService);
		for (const p of candidates) {
			try {
				// 2026-09-15：加载阶段也要让 UI 有状态可显示（解压 + 流式解析 + 路径迁移 = 大图数秒~数十秒）
				const label = this._basename(p);
				this._onDidGraphLoadProgress.fire(`正在读取并解析制品 ${label}（大图需数十秒）`);
				// 方案 ⑥（2026-09-15）：把阶段**内**的百分比也推给 UI —— 大图时一条
				// 「正在读取并解析制品…」要挂几十秒，用户会以为卡死（节流在 persistence 内做）。
				// ★★★ 2026-09-18（P0 性能）：检索由 FTS5 提供时（`_sqliteBackendEnabled` 默认 true），
				// 载入**不再重建内存倒排** —— 它只在灾备回退路径上被用到（真机 `BM25 重建=9137ms` /
				// `⛔主线程阻塞 ≈2393ms`，3 folder 每次加载都付一遍 ✗）。改为置「待按需重建」标记
				// （见 `CodebaseGraphStore._bm25Deferred`）。
				const ftsServesSearch = this._sqliteBackendEnabled;
				const loaded = await persistence.loadMerge(
					this._graph.store, p, projectOverride,
					line => this._onDidGraphLoadProgress.fire(`${label}：${line}`),
					{ skipBm25: ftsServesSearch },
				);
				if (loaded) {
					// force=true：合并加载无脏集，增量模式会空转
				// 2026-09-15：BM25 重建是合并后的第二个重活（全量倒排），也要让 UI 显示出来
				if (rebuildBM25 && ftsServesSearch) {
					// 跳过必须**可见**（否则「这次为什么快」与「检索为什么仍可用」都无从判断）。
					this._logService.info('[CodebaseGraph]', `[loadGraphMerge] 跳过内存 BM25 重建（检索走主进程 FTS5）⇒ 已置「按需重建」标记：仅当回退到内存检索时才构建`);
				}
				if (rebuildBM25 && !ftsServesSearch) {
					// ★ 2026-09-16 诊断：BM25 全量重建是**合并之后的第二个重活**（倒排全量重算），
					// 也是主线程上的同步段之一 ⇒ 打阶段标记（供看门狗事后补报）+ 记耗时。
					wsStage(`graph: 重建 BM25（${this._basename(p)}）`);
					const tBm25 = Date.now();
					this._onDidGraphLoadProgress.fire('正在重建全文索引（BM25）…');
					// 同样要节流：rebuildBM25 每次让出都会回调 ⇒ 按「每 2 万节点一条」推送。
					await this._graph.store.rebuildBM25((done, total) => {
						if (total > 0 && (done % 20000 === 0 || done === total)) {
							this._onDidGraphLoadProgress.fire(`重建全文索引（BM25）：${done}/${total}`);
						}
					}, true);
					this._logService.info('[CodebaseGraph]', `[loadGraphMerge] BM25 重建完成（${Date.now() - tBm25}ms）`);
					// ★★ 2026-09-19：**成对结束阶段**（不加这行，本阶段会一直"当前"到**下次载入** ✗）。
					// 这正是"陈旧阶段名"最典型的形态：一次载入设一次 ⇒ 之后几小时里，
					// 所有主线程阻塞都会被算到「重建 BM25」头上 ✗（外部日志实测同类现象「已持续 1884s」）。
					wsStageEnd();
				}
					// 从文件路径推导 rootPath 并注册到 _rootProjectMap（多 folder 项目名解析）
					const graphDirIdx = p.lastIndexOf('/.codebase-memory/') >= 0 ? p.lastIndexOf('/.codebase-memory/')
						: p.lastIndexOf('\\.codebase-memory\\');
				if (graphDirIdx > 0) {
					const rootPath = this._normalizeRoot(p.substring(0, graphDirIdx));
					const proj = projectOverride || this._basename(rootPath) || '_default';
					// 2026-09-15：合并是异步重活（大图 10~40s）。若期间用户已切走工作区，这份图就
					// 属于「别的窗口内容」——**必须立刻丢弃**：否则它会以「后完成者」身份驻留内存并
					// 污染检索（实测切到 S1Game+UE5EA 后 11s 完成、sarosis 的 21.6s 完成，
					// S1Game 反而成了 store 里最大的项目）。bootstrap 会据此走「制品存在但加载失败」
					// 分支 ⇒ 跳过自动索引（不会误触发全量重建）。
					if (!this._isRootInCurrentWorkspace(rootPath)) {
						try { this.deleteProject(proj); } catch (err: any) {
							this._logService.warn('[CodebaseGraph]', `[loadGraphMerge] discard-cleanup failed for "${proj}": ${err?.message || err}`);
						}
						this._logService.warn('[CodebaseGraph]', `[loadGraphMerge] discarded ${p} as project="${proj}" — root is no longer part of the current workspace (${Date.now() - tStart}ms)`);
						return false;
					}
					// ★★★ 2026-09-16（用户报「PJDB\S1Game 一份 **10KB** 空图永远不重建」）：
					// **解析成功但 0 节点 = 制品是空的**（不是「有图」）⇒ 视为未加载**并留下标记**。
					// 旧实现在这里直接 `return true` 并打印 `merged ..., store nodes=0`（日志实证），
					// 调用方据此 `_readyFolders.add()` ⇒ 该 folder **既没有图、也永远不会重建** ✗
					// （"制品在，却什么都没有"）。标记供 `isLastMergeEmpty()` 读取：调用方要靠它把
					// 「空制品（允许重建）」与「损坏/几十 MB 的巨图（跳过重建）」分开，而不是猜字节数。
					const mergedNodes = this._graph.store.getNodeCount(proj);
					if (mergedNodes === 0) {
						this._emptyArtifactRoots.add(rootPath);
						this._logService.warn('[CodebaseGraph]', `[loadGraphMerge] ${p} parsed OK but yields 0 nodes for project "${proj}" (${Date.now() - tStart}ms) — treating as NOT loaded (empty / garbage artifact).`);
						return false;
					}
					this._emptyArtifactRoots.delete(rootPath);
					this._rootProjectMap.set(rootPath, proj);
					// 2026-09-15 修：原为「首个完成的 merge 胜」⇒ 同一窗口原地切换工作区时
					// （replaceWorkspaceFoldersInMemory，不 reload）并发 merge 会按**完成顺序**
					// 抢注 `_projectName`（实测 S1Game 11s 抢在 sarosis 21.6s 之前），此后所有
					// 以 `_projectName` 为默认项目的查询都指向别的项目。改为以当前工作区为准。
					// 索引进行中则不改写（见 `_setProjectNameUnlessIndexing`）。
					this._setProjectNameUnlessIndexing(this._resolveActiveProject(this._projectName === '_default' ? proj : this._projectName));
					this._logService.info('[CodebaseGraph]', `[loadGraphMerge] merged ${p} as project="${projectOverride ?? '(original)'}" (${Date.now() - tStart}ms), store nodes=${this._graph.nodeCount}`);
					// gzip 加载后若 SQLite 无该 project 数据则同步一次（幂等：listProjects 检查，
					// 避免每次启动全量重建；首次加载才同步，一次性成本）
					if (this._sqliteBackendEnabled && proj !== '_default') {
						try {
							const existingProjects = await this._sqliteBackend.listProjects();
							// ★★★ 2026-09-19（② 加固）：「**存在**」≠「**可用**」—— 旧判据只看名字：
							// 若 SQLite 里该项目存在但节点为 0/残缺（同步半途失败、曾被清空），会被判成
							// 「already has project ⇒ skip sync」✗ ⇒ 之后所有查询都落到 `_ensureSqliteFreshness`
							// 的滞后分支（实机日志 `sqlite returned 0 candidates → falling back` 反复出现，
							// 每次都要靠后台全量同步兜底）。现在：名字存在**且**节点数 > 0 才算可用；
							// 否则照常同步（自愈 ✓），并把「存在但为空」这一异常**写明**在进度与日志里（不静默 ✗）。
							const named = existingProjects.some(pj => pj.name === proj);
							const usableCount = named ? await this._sqliteBackend.getNodeCount(proj) : 0;
							// ★★★ 2026-09-19（第三次收紧：「存在且 >0」**仍不等于可用**）：
							// 实测 `SQLite already has project "sarosis-agents-client" (167810 nodes) — skip sync`，
							// 而制品/内存里是 **180115**（差 1.2 万节点）却因「存在且非空」被跳过 ⇒ **永不追平** ✗✗。
							// 后果是**正确性**问题：检索/查询看到的是**残缺**的图（少 1.2 万节点的符号查不到）✗；
							// 连锁后果：`canSkipArtifactParse` 要求 `sqlite ≥ artifact` ⇒ 恒为 false ⇒
							// 每次载入都要解析 JSON 制品（实测 2.4–4.3s = 「切工作区卡死」的主因段）✗。
							// ⇒ 判据再收紧一档：**落后**（`usableCount < 本次载入的节点数`）即视为不可用 ⇒ 重新同步自愈 ✓。
							const expectedCount = this._graph.store.getNodeCount(proj);
							// ★★ 2026-09-19（实测补充）：**加容差** —— 首次实现是「任何落后都全量重同步」，
							// 结果实机出现「只落后 **170 节点**」也触发了 **82s 全量重同步** ✗✗（日志
							// `is behind (179957 < 180127)`）。小漂移本来就该由 `_runIncrementalIndex` 的
							// 增量补丁按文件收敛 ✓ ⇒ 只对**大**落后自愈：`> max(2000, 2% expected)`。
							// ⚠ 小落后仍**写明日志**（不静默 ✗）—— 否则「检索少几个符号」没人知道。
							const lag = Math.max(0, expectedCount - usableCount);
							const behindTolerance = Math.max(2000, Math.floor(expectedCount * 0.02));
							const behind = usableCount > 0 && lag > behindTolerance;
							if (!named || usableCount === 0 || behind) {
								const why = !named ? '首次加载' : (usableCount === 0 ? '存在但为 0 节点' : `落后 ${lag} 节点（> 容差 ${behindTolerance}）`);
								this._logService.info('[CodebaseGraph]', `SQLite ${!named ? 'missing' : (usableCount === 0 ? 'has EMPTY' : `is behind (${usableCount} < ${expectedCount}, lag ${lag} > 容差 ${behindTolerance})`)} project "${proj}" — 转后台全量同步（**不阻塞载入** ✓）`);
								// ★★★ 2026-09-19：**绝不 await** —— 全量同步实测 82s，await 会把载入拖到 91.6s ✗✗
								// （实机：`loadGraphMerge("sarosis-agents-client") 返回 true，耗时 91648ms`）。
								// 载入只需要内存 store（此时已就绪 ✓）；DB 是**查询侧**资源 ⇒ 交给统一的后台入口
								// （带「同步中」守卫 + 冷却，避免与 freshness / 增量补丁并发覆盖 ✗）。
								this._onDidGraphLoadProgress.fire(`后台把项目 "${proj}" 追平到 SQLite（${why}）…`);
								this._scheduleSqliteCatchUp(proj, why);
							} else {
								this._logService.info('[CodebaseGraph]', `SQLite already has project "${proj}" (${usableCount} nodes${lag > 0 ? `，仅落后 ${lag} 节点（≤ 容差 ${behindTolerance}，交给增量补丁收敛）` : ''}) — skip sync`);
							}
							} catch (err: any) {
							this._logService.warn('[CodebaseGraph]', `SQLite load-sync check failed: ${err?.message || err}`);
						}
					}
				}
				return true;
				}
			} catch (err: any) {
				// warn 级：加载失败会导致调用方判定"无图"并触发全量重建——失败原因必须可见
				this._logService.warn('[CodebaseGraph]', `[loadGraphMerge] failed ${p}: ${err?.message || err}`);
			}
		}
		return false;
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	/**
	 * 解析 searchCode / get_code_snippet 读取文件时的候选 URI 列表。
	 *
	 * 工作区可能包含多个 folder（如 S1Game + UE5EA 两个独立根）。
	 * 旧实现只用 folders[0].uri 拼相对路径，导致 UE5EA 引擎文件（相对路径相对 UE5EA 根）
	 * 被拼到 S1Game 根下 → 路径错误 → _fileService.exists()=false → 永远读不到 → 搜索静默无结果。
	 *
	 * 修复：
	 *  - 绝对路径（Windows 盘符 / *nix 根）→ 直接用 URI.file 解析（单候选）
	 *  - 相对路径 → 依次尝试每个 workspace folder 拼接，调用方取第一个 exists() 的
	 *  - 无 folder → 退回 URI.file
	 */
	private _resolveSearchFileCandidates(filePath: string): URI[] {
		const folderUris = this._workspaceService.getWorkspace().folders.map(f => f.uri);
		return resolveSearchFileCandidates(folderUris, filePath);
	}

	private _getRelativePath(absPath: string): string {
		// 多 folder：遍历所有 workspace folder 做前缀剥离——
		// 旧实现只试 folders[0]，第二 folder 的文件全部退化为绝对路径，
		// 导致 fileHashes 键与 watcher 的 root-relative 键永远不匹配
		// （每轮轮询误报全量 added → 无限增量循环）。比较时统一分隔符并忽略盘符大小写。
		const normAbs = absPath.replace(/\\/g, '/');
		const lowerAbs = normAbs.toLowerCase();
		for (const f of this._workspaceService.getWorkspace().folders) {
			const base = f.uri.fsPath;
			const normBase = base.replace(/\\/g, '/').replace(/\/+$/, '');
			if (lowerAbs.startsWith(normBase.toLowerCase() + '/')) {
				return normAbs.substring(normBase.length + 1);
			}
		}
		return normAbs;
	}

	/**
	 * watcher 变更集的 root-relative 相对路径 → 绝对路径（增量快路径用）。
	 * 防御：rel 本身已是绝对路径（带盘符 / 或 `/` 开头）时原样返回 —— watcher 的
	 * `_getRelPath` 在 rootPath 前缀剥离失败时会退回绝对路径，这里不能二次拼接。
	 */
	private _relToAbs(rootPath: string, rel: string): string {
		const r = rel.replace(/\\/g, '/');
		if (/^[a-zA-Z]:\//.test(r) || r.startsWith('/')) { return r; }
		return URI.joinPath(URI.file(rootPath), r).fsPath;
	}

	override dispose(): void {
		this._disposeWorkers();
		// ★ 2026-09-19（P2-2）：停内存轨迹采样（与 `_indexLockHeartbeat` 同一套清理式，幂等 ✓）
		if (this._memTrajectoryTimer) {
			clearInterval(this._memTrajectoryTimer);
			this._memTrajectoryTimer = undefined;
		}
		// ★ 2026-09-20：清掉「检索让路」的重试定时器（否则 dispose 后仍会触发落盘 ✗）
		for (const t of this._saveRetryTimers.values()) { clearTimeout(t); }
		this._saveRetryTimers.clear();
		this._savesDeferredBySearch.clear();
		// 强制落盘延迟窗口内未完成的保存：否则窗口内的索引结果丢失，
		// 下次启动会加载旧制品（最坏后果是重新索引，但能避免就避免）。
		// dispose 是同步的，落盘是异步——fire-and-forget（进程退出前尽量完成）。
		void this.flushPendingSave().catch(err => {
			this._logService.warn('[CodebaseGraph]', `Flush pending graph save on dispose failed: ${err?.message || err}`);
		});
		super.dispose();
	}
}
