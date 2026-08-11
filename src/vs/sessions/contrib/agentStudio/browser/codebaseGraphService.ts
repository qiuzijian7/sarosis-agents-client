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

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ITreeSitterLibraryService } from '../../../../editor/common/services/treeSitter/treeSitterLibraryService.js';
import { getModuleLocation } from '../../../../workbench/services/treeSitter/browser/treeSitterLibraryService.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { FileAccess } from '../../../../base/common/network.js';
import type { Parser as TreeSitterParser, Language as TreeSitterLanguage } from '@vscode/tree-sitter-wasm';
import { CodebaseGraphStore, resolveSearchFileCandidates } from './codebaseGraphStore.js';
import { CypherEngine } from './codebaseGraphCypher.js';
import { SemanticSearch } from './codebaseGraphSemantic.js';
import { analyzeArchitecture } from './codebaseGraphArchitecture.js';
import { tracePath, getGraphSchema as getSchema, GraphSchema, searchCode as graphSearchCode, getIndexStatus } from './codebaseGraphTrace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { createCodebaseGraphSqliteBackend } from './codebaseGraphStoreProxy.js';
import type { ICodebaseGraphSqliteBackend } from '../common/codebaseGraphStoreChannel.js';
import { LspCrossResolver } from './codebaseGraphLsp.js';
import { extractInherits } from './codebaseGraphQueries.js';
import { INDEX_LOCK_FILENAME, INDEX_LOCK_HEARTBEAT_MS, createIndexLockToken, isIndexLockStale, parseIndexLock, serializeIndexLock } from './codebaseIndexLock.js';
import { buildSemanticEdges, detectSimilarCode, MinHash, MINHASH_PERM } from './codebaseGraphExtendedPasses.js';
import { runMultiLevelLeiden, detectDeadCodeEnhanced, computeTwoLevelLOD, executeExtendedCypher, computeAllSignals } from './codebaseGraphAdvancedAnalysis.js';
import { CrossRepoDiscovery } from './codebaseGraphCrossRepoDiscovery.js';
import { wrapWorkerUrl } from './shared/workerPoolManager.js';
import { GraphPersistence } from './codebaseGraphPersistence.js';
import { scanEnvUrls } from './codebaseGraphEnvScan.js';
import { linkConfigToCode } from './codebaseGraphConfigLink.js';
import { TraceIngester } from './codebaseGraphTraces.js';
import { ICodebaseGraphWatcher, CodebaseGraphWatcher, CodebaseGraphChangeEvent } from './codebaseGraphWatcher.js';
import { CodebaseGraphIncrementalIndexer } from './codebaseGraphIncremental.js';
import { COMMON_EXCLUDE_DIRS, mergeExcludeDirs, parseCbmIgnore, extractExcludeDirNames } from '../common/codebaseIndexDefaults.js';

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
}

/** 单文件索引覆盖率状态（对标 C 的 parse_partial/skipped/not_indexed） */
export type FileCoverageStatus = 'indexed' | 'skipped' | 'parse_error' | 'timeout' | 'partial';

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

	indexWorkspace(rootPath: string, config: IIndexConfig, token?: CancellationToken): Promise<IIndexResult>;
	cancelIndex(): void;
	startWatching(rootPath: string, extraExcludeDirs?: readonly string[], keepDirs?: readonly string[]): void;
	getGraphStatus(workspacePath?: string): Promise<IGraphStatus>;
	saveGraph(targetPath: string): Promise<void>;
	loadGraph(sourcePath: string): Promise<boolean>;
	/**
	 * 合并加载：把 sourcePath 的图【追加】到当前内存 store（不清空），用于多 folder 工作区。
	 * @param projectOverride 覆盖加载数据的项目名（每 folder 唯一，如 "UE5EA"）
	 * @param rebuildBM25 合并完成后是否重建 BM25（多 folder 建议全部合并后仅最后一次重建）
	 */
	loadGraphMerge(sourcePath: string, projectOverride?: string, rebuildBM25?: boolean): Promise<boolean>;

	/**
	 * 等待所有进行中的图谱加载（loadGraphMerge）完成后再返回（带超时保护）。
	 * 修复竞态：启动时 bootstrap 异步合并加载大图谱（18w+ 节点需数十秒），
	 * 期间 LLM 调 index_status/search_graph 会看到"无数据"误判未索引 → 触发全量重建。
	 * 所有"图是否有数据"的判定路径必须先 await 此方法。
	 */
	whenGraphLoaded(timeoutMs?: number): Promise<void>;
	/** 按 rootPath 判断对应 folder 的项目是否已有节点数据（多 folder 逐个守卫用）。 */
	hasProjectData(rootPath: string): boolean;

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
	getMissedGraph(): { nodes: { id: string; name: string; type: string; kind?: string; detail?: string }[]; edges: { source: string; target: string; type: string }[] };

	tracePath(sourceName: string, targetName: string | undefined, mode?: string): any;
	searchCode(query: string, limit?: number, filePattern?: string, useRegex?: boolean, project?: string): Promise<{ results: { filePath: string; lineNo: number; text: string; node?: GraphNode; relevanceScore: number }[]; totalMatches: number; coverage?: { scanned: number; total: number } }>;

	searchGraph(params: {
		project?: string;
		query?: string;
		namePattern?: string;
		label?: string;
		filePattern?: string;
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
		limit?: number;
		offset?: number;
		sortBy?: 'name' | 'inDegree' | 'outDegree' | 'degree';
		sortDesc?: boolean;
		minInDegree?: number;
		maxInDegree?: number;
		minOutDegree?: number;
		maxOutDegree?: number;
		relType?: string;
	}): Promise<{ nodes: GraphNode[]; total: number; scores?: Record<number, number>; hasMore?: boolean }>;

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

	detectChanges(opts?: { since?: string; baseBranch?: string; impactAnalysis?: boolean; scope?: string; depth?: number }): Promise<any>;

	/** Phase 2f：确保内存 store 中有图数据（启用 SQLite 后端时按需从 SQLite 加载） */
	tryLoadFromSqlite(): Promise<boolean>;

	tryLockIndex(): boolean;
	isIndexLocked: boolean;

	ingestTraces(otlpJson: string): { spansIngested: number; edgesWritten: number };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const EXTENSION_TO_WASM_LANG: Record<string, string> = {
	'.ts': 'typescript',
	'.tsx': 'tsx',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.mjs': 'javascript',
	'.py': 'python',
	'.go': 'go',
	'.rs': 'rust',
	'.java': 'java',
	'.rb': 'ruby',
	'.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
	'.cs': 'c-sharp',
	'.php': 'php',
};

const AST_TO_NODE_TYPE: Record<string, string> = {
	'function_declaration': 'function',
	'function_definition': 'function',
	'function_item': 'function',
	'method_definition': 'function',
	'method_declaration': 'function',
	'constructor_declaration': 'function',
	'destructor_declaration': 'function',
	'class_declaration': 'class',
	'class_definition': 'class',
	'class_specifier': 'class',
	'impl_item': 'class',
	'struct_specifier': 'class',
	'interface_declaration': 'interface',
	'type_alias_declaration': 'interface',
	'trait_item': 'interface',
	'protocol_declaration': 'interface',
	'enum_declaration': 'enum',
	'enum_item': 'enum',
	'enum_specifier': 'enum',
	'variable_declarator': 'variable',
	'global_variable_declaration': 'variable',
	'const_item': 'variable',
	'static_item': 'variable',
};

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
 * `search.exclude`/`files.exclude` 配置（见 `_resolveExcludeDirs`）。
 */
const DEFAULT_EXCLUDE_DIRS = COMMON_EXCLUDE_DIRS;

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const MAX_LINE_LENGTH = 10000;   // 超过此行长的文件跳过（minified/生成代码会导致 tree-sitter 挂起）

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

	addNode(node: GraphNode): void {
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

		// 批量重建 BM25 索引
		this._store.setDeferBM25(false);
		await this._store.rebuildBM25();
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
			const newId = this._nodeIdMap.size + 1;
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
	private _projectName = '_default';
	/** 多 folder：归一化 rootPath → 项目名，供增量索引/监听/保存按 folder 解析正确的 project。 */
	private _rootProjectMap = new Map<string, string>();
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

	// ─── MinHash Clone Detection (P2-#7) ──────────────────────────────────
	private _minHasher: MinHash | undefined;
	private readonly _codeTokenCap = 900; // 单函数代码 token 上限（控制签名计算成本）

	// 索引覆盖率：逐文件记录 status（对标 C 的 parse_partial/skipped/not_indexed）
	private _indexCoverage: Map<string, IFileCoverage> = new Map();

	// ─── Worker Pool (parallel tree-sitter parsing) ────────────────────
	private _parserWorkers: Worker[] = [];
	private _workerInitPromise: Promise<boolean> | undefined;
	// Worker 崩溃自愈：保存池创建参数，崩溃时重建替补（对齐 C 版监督子进程语义——
	// browser Worker 有独立堆，崩溃仅影响自身，主线程重建即可）。
	private _workerUrl: string | undefined;
	private _workerTsWasm: Uint8Array | undefined;
	private _workerLangWasms: Record<string, Uint8Array> | undefined;

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
	) {
		super();

		// Phase 2 接线：经主进程代理的 SQLite 后端（默认不启用；见 `_sqliteBackendEnabled`）。
		// renderer sandbox 不能加载原生模块，SQLite 宿主在 main 进程，这里只是透明代理。
		this._sqliteBackend = createCodebaseGraphSqliteBackend(this._mainProcessService);

		// 文件监听 → 增量重索引（P2-#8）。事件仅在 startWatching() 调用 start() 后产生。
		this._register(this._graphWatcher.onDidChange(e =>
			void this._onWatcherChange(e).catch(err =>
				this._logService.error('[CodebaseGraph]', 'Watcher change handler failed:', err))));
	}

	/**
	 * Phase 2 接线：经主进程代理的 SQLite 后端。
	 * 当前仅用于「文件哈希双写 + 作为后续读路径切换的落点」，默认不启用，避免改变 live 行为。
	 * 启用：`"saros.codebaseGraph.sqliteBackend": true`（实验性，根治 V8 4GB 的开关之一）。
	 */
	private readonly _sqliteBackend: ICodebaseGraphSqliteBackend;

	/**
	 * 主进程 SQLite 后端是否启用：**默认开启**。
	 * 仅显式设置 `saros.codebaseGraph.sqliteBackend=false` 才会关闭；
	 * 未配置或显式 true 均启用（搜索/查询走 FTS5 索引，避免内存全量扫描）。
	 */
	private get _sqliteBackendEnabled(): boolean {
		return this._configurationService.getValue<boolean | undefined>('saros.codebaseGraph.sqliteBackend') !== false;
	}

	/** 把内存 store 的文件哈希同步到主进程 SQLite（fire-and-forget，失败静默）。 */
	private _syncFileHashToSqlite(project: string, relPath: string, sha256: string, mtimeNs: number, size: number): void {
		if (!this._sqliteBackendEnabled) { return; }
		this._sqliteBackend.setFileHash(`${project}:${relPath}`, { project, relPath, sha256, mtimeNs, size })
			.catch(err => this._logService.warn('[CodebaseGraph]', 'sqlite fileHash sync failed:', err));
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

		// 幂等同步：内存 id 空间是会话级序号，跨会话重插会撞 UNIQUE(project, qualified_name)
		// （旧 id 空间残留，upsert 冲突目标仅 id 主键）——先按项目清除旧数据再写入。
		// keepFileHashes：保留增量索引哈希，否则下次启动全量重解析。
		await this._sqliteBackend.deleteProject(project, { keepFileHashes: true });

		const BATCH = 5000;
		const tStart = Date.now();

		// ── 节点 ──
		for (let i = 0; i < nodes.length; i += BATCH) {
			const chunk = nodes.slice(i, i + BATCH);
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
			if ((i + BATCH) % 50000 === 0 || i + BATCH >= nodes.length) {
				const done = Math.min(i + BATCH, nodes.length);
				this._logService.info('[CodebaseGraph]', `SQLite sync nodes: ${done}/${nodes.length}`);
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
			const edgePayloads = chunk.map(e => ({
				source: String(e.sourceId),
				target: String(e.targetId),
				type: e.type,
				sourceId: e.sourceId,
				targetId: e.targetId,
				properties: e.properties,
			}));
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

		// 重建 FTS5
		await this._sqliteBackend.rebuildFTS();
		// 重建后 WAL checkpoint（TRUNCATE）压缩 WAL——否则大同步后 WAL 达数百 MB，读查询要合并 WAL 显著变慢
		await this._sqliteBackend.checkpoint();

		const dur = Date.now() - tStart;
		this._logService.info('[CodebaseGraph]', `SQLite sync done: ${nodes.length} nodes + ${edges.length} edges in ${dur}ms`);

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
		const changedSet = new Set(changedRels);
		const tStart = Date.now();
		try {
			// 1. 删除变更文件的旧节点/边/FTS（sqlite 侧，含其他文件指向变更节点的边）
			for (const rel of changedRels) {
				await this._sqliteBackend.deleteNodesByFile(project, rel);
			}
			// 2. 收集变更文件的内存节点（显式 id = 内存 id，与 sqlite id 保持一致）
			const nodes: GraphNode[] = [];
			const changedNodeIds = new Set<number>();
			for (const n of store.getAllNodes()) {
				if (n.project === project && n.filePath && changedSet.has(n.filePath)) {
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
		} catch (err) {
			this._logService.warn('[CodebaseGraph]', 'SQLite incremental patch failed (sqlite may lag until next full sync):', err);
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
	private async _loadGraphFromSqlite(): Promise<boolean> {
		if (!this._sqliteBackendEnabled) { return false; }
		const store = this._graph.store;
		const project = this._projectName;

		if (store.getNodeCount(project) > 0) { return true; }

		const tStart = Date.now();
		// 多 folder 支持：加载全部项目节点（不再限制当前项目）。
		// 使 query_graph / trace_path / get_architecture 等内存工具也能跨项目工作。
		const allProjects = await this._sqliteBackend.listProjects();
		const projectsToLoad = allProjects.length > 0 ? allProjects.map(p => p.name) : [project];
		const allNodes: GraphNode[] = [];
		for (const p of projectsToLoad) {
			const nodes = await this._sqliteBackend.getAllNodes(p);
			allNodes.push(...nodes);
		}
		const nodes = allNodes;
		if (nodes.length === 0) { return false; }

		store.setDeferBM25(true);

		// 还原节点（SQLite rowid → 内存 store id，保持一致）
		let maxId = 0;
		for (const node of nodes) {
			const id = Number(node.id);
			if (id > maxId) { maxId = id; }
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
		}
		// 更新 _nextNodeId 避免后续自动分配冲突
		(store as any)._nextNodeId = maxId + 1;

		// 还原边（SQLite source/target 已是整数 id，与节点一致）
		// 多 folder：同样加载全部项目的边
		for (const p of projectsToLoad) {
			const edges = await this._sqliteBackend.getAllEdges(p);
			for (const e of edges) {
				store.insertEdge({
					project: p,
					sourceId: Number(e.source),
					targetId: Number(e.target),
					type: e.type,
					properties: e.properties || {},
				});
			}
		}

		store.setDeferBM25(false);
		await store.rebuildBM25();

		const dur = Date.now() - tStart;
		this._logService.info('[CodebaseGraph]', `_loadGraphFromSqlite: ${nodes.length} nodes + edges loaded (${projectsToLoad.length} projects) in ${dur}ms`);
		return true;
	}

	/**
	 * Phase 2f 公开入口：确保内存 store 中有图数据可用。
	 * 当 `_sqliteBackendEnabled` 时从 SQLite 按需加载；否则检查原有内存 store。
	 */
	async tryLoadFromSqlite(): Promise<boolean> {
		if (!this._sqliteBackendEnabled) {
			return this._graph.nodeCount > 0;
		}
		return this._loadGraphFromSqlite();
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
	private async _ensureWorkerPool(): Promise<boolean> {
		if (this._workerInitPromise) { return this._workerInitPromise; }
		this._workerInitPromise = this._initWorkerPool();
		return this._workerInitPromise;
	}

	private async _initWorkerPool(): Promise<boolean> {
		try {
			// 1. 读取 tree-sitter.js (AMD 模块)
			const wasmDir = getModuleLocation(this._environmentService);
			const tsJsUri = FileAccess.asFileUri(`${wasmDir}/tree-sitter.js`);
			const tsJsContent = (await this._fileService.readFile(tsJsUri)).value.toString();

			// 2. 读取 tree-sitter.wasm (运行时 WASM)
			const tsWasmUri = FileAccess.asFileUri(`${wasmDir}/tree-sitter.wasm`);
			const tsWasmBytes = new Uint8Array((await this._fileService.readFile(tsWasmUri)).value.buffer);

			// 3. 读取各语言的 WASM 文件
			const langWasms: Record<string, Uint8Array> = {};
			const langs = [...new Set(Object.values(EXTENSION_TO_WASM_LANG))];
			for (const lang of langs) {
				try {
					const uri = FileAccess.asFileUri(`${wasmDir}/tree-sitter-${lang}.wasm`);
					langWasms[lang] = new Uint8Array((await this._fileService.readFile(uri)).value.buffer);
				} catch { /* skip unavailable */ }
			}
			this._logService.info('[CodebaseGraph]', `Worker pool: loaded tree-sitter.js (${tsJsContent.length}B), runtime WASM (${tsWasmBytes.length}B), ${Object.keys(langWasms).length} langs`);

			// 4. 构建 Worker 代码 (AMD shim + tree-sitter.js + 解析逻辑)
			const workerCode = this._buildWorkerCode(tsJsContent);
			const blob = new Blob([workerCode], { type: 'application/javascript' });
			const rawUrl = URL.createObjectURL(blob);
			const workerUrl = wrapWorkerUrl(rawUrl);  // CSP TrustedScriptURL 包装

			// 保存重建参数（Worker 崩溃自愈用）。WASM 原始 buffer 未被 transfer——
			// 每次 init 前都 slice() 出独立副本转移，原件可反复用于重建。
			this._workerUrl = workerUrl;
			this._workerTsWasm = tsWasmBytes;
			this._workerLangWasms = langWasms;

			// 5. 创建 Worker 池
			const poolSize = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
			const initPromises: Promise<Worker | null>[] = [];
			for (let i = 0; i < poolSize; i++) {
				initPromises.push(this._createAndInitWorker(workerUrl, tsWasmBytes, langWasms));
			}
			const workers = await Promise.all(initPromises);
			this._parserWorkers = workers.filter((w): w is Worker => w !== null);

			if (this._parserWorkers.length === 0) {
				this._logService.warn('[CodebaseGraph]', 'Worker pool: all workers failed to init, fallback to main thread');
				return false;
			}
			for (const w of this._parserWorkers) { this._attachWorkerSelfHealing(w); }
			this._logService.info('[CodebaseGraph]', `Worker pool ready: ${this._parserWorkers.length}/${poolSize} workers`);
			return true;
		} catch (err: any) {
			this._logService.warn('[CodebaseGraph]', `Worker pool init failed: ${err?.message || err}, fallback to main thread`);
			return false;
		}
	}

	private _createAndInitWorker(url: string, tsWasmBytes: Uint8Array, langWasms: Record<string, Uint8Array>): Promise<Worker | null> {
		return new Promise((resolve) => {
			let worker: Worker;
			try {
				worker = new Worker(url);
			} catch (err: any) {
				this._logService.warn('[CodebaseGraph]', `Worker creation failed: ${err?.message || err}`);
				resolve(null);
				return;
			}
			const timeout = setTimeout(() => { worker.terminate(); this._logService.warn('[CodebaseGraph]', 'Worker init timeout (15s) — worker script may have failed during evaluation'); resolve(null); }, 15000);
			// init 阶段的脚本级错误（如模块求值抛错）经 error 事件暴露，必须记录否则只能盲猜失败原因
			const errHandler = (e: ErrorEvent) => {
				this._logService.warn('[CodebaseGraph]', `Worker init script error: ${e.message || 'unknown'} @ ${e.filename || '?'}:${e.lineno || '?'}`);
			};
			worker.addEventListener('error', errHandler);
			const initHandler = (e: MessageEvent) => {
				const data = e.data;
				if (data.type === 'init-done') {
					clearTimeout(timeout);
					worker.removeEventListener('message', initHandler);
					worker.removeEventListener('error', errHandler);
					resolve(worker);
				} else if (data.type === 'init-error') {
					clearTimeout(timeout);
					worker.removeEventListener('error', errHandler);
					this._logService.warn('[CodebaseGraph]', `Worker init-error: ${data.error || 'unknown'}`);
					worker.terminate();
					resolve(null);
				} else if (data.type === 'log') {
					this._logService.warn('[CodebaseGraph]', `Worker: ${data.message}`);
				}
			};
			worker.addEventListener('message', initHandler);
			// 复制并 transfer WASM buffers (每个 worker 需要独立副本)
			const tsWasmCopy = tsWasmBytes.slice().buffer;
			const langWasmsCopy: Record<string, ArrayBuffer> = {};
			const transferList: ArrayBuffer[] = [tsWasmCopy];
			for (const [k, v] of Object.entries(langWasms)) {
				const copy = v.slice().buffer;
				langWasmsCopy[k] = copy;
				transferList.push(copy);
			}
			worker.postMessage({ type: 'init', tsWasm: tsWasmCopy, langWasms: langWasmsCopy }, transferList);
		});
	}

	/**
	 * Worker 崩溃自愈：browser Worker 有独立堆，WASM OOM/语法崩溃只会杀死自身。
	 * 监听 error 事件 → 从池中摘除并异步重建替补（对齐 C 版 index_supervisor 语义）。
	 * 在途 parse 由其 15s 超时兜底（该文件跳过，下轮索引重试，类似 C 的毒文件 quarantine）。
	 */
	private _attachWorkerSelfHealing(worker: Worker): void {
		worker.addEventListener('error', (e: ErrorEvent) => {
			this._logService.warn('[CodebaseGraph]', `Worker crashed (${e.message ?? 'unknown'}), respawning replacement…`);
			const idx = this._parserWorkers.indexOf(worker);
			if (idx >= 0) { this._parserWorkers.splice(idx, 1); }
			try { worker.terminate(); } catch { /* ignore */ }
			if (!this._workerUrl || !this._workerTsWasm || !this._workerLangWasms) { return; }
			this._createAndInitWorker(this._workerUrl, this._workerTsWasm, this._workerLangWasms).then(replacement => {
				if (replacement) {
					this._attachWorkerSelfHealing(replacement);
					this._parserWorkers.push(replacement);
					this._logService.info('[CodebaseGraph]', `Worker pool healed: ${this._parserWorkers.length} worker(s)`);
				} else {
					this._logService.warn('[CodebaseGraph]', `Worker respawn failed, pool now ${this._parserWorkers.length} worker(s)`);
				}
			});
		});
	}

	/**
	 * 构建 Worker 代码：AMD shim + tree-sitter.js 内联 + AST 遍历逻辑。
	 */
	private _buildWorkerCode(tsJsContent: string): string {
		return `
// === AMD Loader Shim (捕获 @vscode/tree-sitter-wasm 的 define 调用) ===
let _tsModule;
self.define = function(deps, factory) {
  if (typeof deps === 'function') { _tsModule = deps(); }
  else if (Array.isArray(deps) && typeof factory === 'function') {
    const mockDeps = deps.map(function(d) {
      if (d === 'exports') return (_tsModule = {});
      if (d === 'require') return function() { return undefined; };
      return undefined;
    });
    const result = factory.apply(null, mockDeps);
    _tsModule = result || _tsModule;
  } else { _tsModule = deps; }
};
self.define.amd = true;
// CommonJS shim (某些 UMD 模块会检查 module.exports)
self.module = { exports: {} };
self.exports = self.module.exports;
// document stub：tree-sitter.js 模块求值时立即调用 getCurrentScriptUrl()（算 _scriptName/scriptDirectory）。
// Worker 中无 document/__filename → 抛 'Unable to determine script URL'，整个 blob 脚本求值中止、onmessage 从未注册
// → 全部 worker init 超时失败、回退主线程解析（数万文件卡死 UI）。
// scriptDirectory 对本 worker 无意义（运行时 WASM 经 locateFile blob URL 加载），stub 使其温和返回 undefined。
self.document = { currentScript: null };

// === Tree-sitter.js (AMD module, inlined) ===
${tsJsContent}

// === Fallback: 如果 AMD shim 未捕获模块，尝试从全局/CommonJS 获取 ===
if (!_tsModule) {
  if (self.module && self.module.exports && self.module.exports.Parser) {
    _tsModule = self.module.exports;
  } else if (typeof self.TreeSitter !== 'undefined') {
    _tsModule = self.TreeSitter;
  }
}

// === Worker Logic ===
let Parser = null, Language = null, languages = {}, initDone = false;

const AST_TO_NODE_TYPE = ${JSON.stringify(AST_TO_NODE_TYPE)};

async function doInit(tsWasm, langWasms) {
  const TS = _tsModule;
  if (!TS || !TS.Parser) throw new Error('TreeSitter module not loaded (AMD shim failed, _tsModule=' + (TS ? Object.keys(TS) : 'null') + ')');
  // 运行时 WASM：字节已由 postMessage 传入，直接喂 wasmBinary 给 Emscripten——
  // 严禁走 fetch(blob:)：blob worker 继承文档 CSP（connect-src 无 blob:），fetch 必被拦截。
  try {
    await TS.Parser.init({ locateFile: function() { return 'tree-sitter.wasm'; }, wasmBinary: tsWasm });
  } catch (e) {
    throw new Error('TS.Parser.init failed: ' + (e && e.message ? e.message : String(e)) + ' (tsWasmBytes=' + tsWasm.byteLength + ')');
  }
  Parser = TS.Parser;
  Language = TS.Language;
  // 加载语言 WASM。注意：Language.load 仅认 Uint8Array；transfer 到 worker 的是 ArrayBuffer，
  // 直接传会误入 fetch 分支（CSP 拦截）——必须 new Uint8Array 包装。
  let langLoaded = 0;
  const failedLangs = [];
  for (const langName in langWasms) {
    try { languages[langName] = await Language.load(new Uint8Array(langWasms[langName])); langLoaded++; }
    catch(e) { failedLangs.push(langName + '(' + (e && e.message ? e.message : String(e)).substring(0, 80) + ')'); }
  }
  if (failedLangs.length > 0) {
    self.postMessage({ type: 'log', level: 'warn', message: 'lang wasm load failed: ' + failedLangs.join(', ') });
  }
  if (langLoaded === 0 && Object.keys(langWasms).length > 0) {
    throw new Error('No language WASM loaded (0/' + Object.keys(langWasms).length + ')');
  }
  initDone = true;
}

// 递归提取 AST 节点名称 — 支持 C/C++ 深层标识符
// C++ tree-sitter 中标识符通常不在直接子节点：
//   function_definition → declarator:function_declarator → declarator:field_identifier
//   class_specifier     → name:type_identifier
var IDENTIFIER_TYPES = {
  identifier: true, field_identifier: true, type_identifier: true,
  namespace_identifier: true, template_name: true, destructor_name: true
};
// C/C++ 函数名提取：沿 declarator 链取真正函数名（返回类型 type_identifier 在 DFS 中会先命中，
// 如 inline TArray X::ConvertToArray() 会被误取名 "TArray"，须优先走 declarator）
var _isDeclaratorWrapper = function (t) {
  return t === 'function_declarator' || t === 'pointer_declarator' ||
    t === 'reference_declarator' || t === 'parenthesized_declarator' || t === 'init_declarator';
};
function _extractDeclaratorName(node, source) {
  var n = node;
  for (var i = 0; i < 12; i++) {
    var decl = n.childForFieldName ? n.childForFieldName('declarator') : undefined;
    if (!decl) {
      // reference_declarator 等的 function_declarator 无 declarator 字段，从 children 找
      var cs = n.children || [];
      for (var k = 0; k < cs.length; k++) { if (_isDeclaratorWrapper(cs[k].type)) { decl = cs[k]; break; } }
    }
    if (!decl) break;
    n = decl;
    if (_isDeclaratorWrapper(n.type)) { continue; }
    break;
  }
  // qualified_identifier 的 name 可能嵌套（ns::deep::method → deep::method），循环取最内层
  while (n.type === 'qualified_identifier') {
    var nm = n.childForFieldName ? n.childForFieldName('name') : undefined;
    if (!nm || typeof nm.startIndex !== 'number') break;
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
function extractName(node, source) {
  if (node.type === 'function_definition' || node.type === 'function_declaration' || node.type === 'function_declarator') {
    var fnName = _extractDeclaratorName(node, source);
    if (fnName !== undefined) return fnName;
  }
  function recurse(n) {
    if (IDENTIFIER_TYPES[n.type]) return source.substring(n.startIndex, n.endIndex);
    if (n.type === 'name') return source.substring(n.startIndex, n.endIndex);
    var children = n.children || [];
    for (var i = 0; i < children.length; i++) {
      var r = recurse(children[i]);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  return recurse(node);
}

// 分支/循环节点类型（用于复杂度计算）
var BRANCH_NODE_TYPES = {
  if_statement:1, else_clause:1, for_statement:1, while_statement:1,
  do_statement:1, switch_statement:1, case_statement:1, catch_clause:1,
  conditional_expression:1, ternary_expression:1
};
var LOOP_NODE_TYPES = { for_statement:1, while_statement:1, do_statement:1 };

function computeComplexity(node) {
  var cyclomatic = 0, maxLoopDepth = 0;
  function traverse(n, depth) {
    if (BRANCH_NODE_TYPES[n.type]) cyclomatic++;
    if (LOOP_NODE_TYPES[n.type]) { depth++; if (depth > maxLoopDepth) maxLoopDepth = depth; }
    var children = n.children || [];
    for (var i = 0; i < children.length; i++) traverse(children[i], depth);
  }
  traverse(node, 0);
  return { cyclomatic: cyclomatic, maxLoopDepth: maxLoopDepth };
}

function _extractCalleeName(node, source) {
  var fnNode = node.childForFieldName ? node.childForFieldName('function') : undefined;
  if (fnNode) {
    var name = extractName(fnNode, source);
    if (name) return name;
    if (fnNode.type === 'member_expression') {
      var prop = fnNode.childForFieldName ? fnNode.childForFieldName('property') : undefined;
      if (prop) return source.substring(prop.startIndex, prop.endIndex);
    }
    return undefined;
  }
  return undefined;
}

// 过程内高阶热路径分析（#9 过程间传播的基础；worker 内联版）
function _analyzeIntra(node, source, fnName) {
  var ITERATOR_APIS = { forEach:1, map:1, filter:1, reduce:1, reduceRight:1, find:1, findIndex:1, some:1, every:1, flatMap:1, each:1, collect:1, eachChild:1, walk:1, iterate:1 };
  var ALLOC_APIS = { new:1, alloc:1, allocate:1, create:1, make:1, build:1, malloc:1, construct:1, clone:1 };
  var r = { linearScanInLoop:false, allocInLoop:false, recursionInLoop:false, unguardedRecursion:false };
  var isRecursive = false;
  function visit(n, loopDepth, underGuard) {
    if (n.type === 'call_expression' || n.type === 'call' || n.type === 'method_invocation' || n.type === 'invocation_expression') {
      var callee = _extractCalleeName(n, source);
      if (callee) {
        if (callee === fnName) {
          isRecursive = true;
          if (loopDepth > 0) r.recursionInLoop = true;
          if (!underGuard) r.unguardedRecursion = true;
        }
        if (loopDepth > 0) {
          if (ITERATOR_APIS[callee]) r.linearScanInLoop = true;
          if (ALLOC_APIS[callee]) r.allocInLoop = true;
        }
      }
    }
    if (loopDepth > 0 && n.type === 'new_expression') r.allocInLoop = true;
    var isGuard = (n.type === 'if_statement' || n.type === 'conditional_expression' || n.type === 'ternary_expression' || n.type === 'switch_statement' || n.type === 'when_clause' || n.type === 'match_arm' || n.type === 'else_clause');
    var nextLoop = LOOP_NODE_TYPES[n.type] ? loopDepth + 1 : loopDepth;
    var nextGuard = underGuard || isGuard;
    if (n.children) { for (var i = 0; i < n.children.length; i++) visit(n.children[i], nextLoop, nextGuard); }
  }
  visit(node, 0, false);
  if (!isRecursive) r.unguardedRecursion = false;
  return r;
}

// 继承/接口实现提取（worker 内联版，无法 import 外部模块，逻辑与 codebaseGraphQueries.extractInherits 对齐）：
// C++ base_class_clause / TS-Java heritage(extends_clause|implements_clause) / Python superclasses / Ruby superclass
function _extractInheritNames(node, source) {
  var result = { inherits: [], implements: [] };
  function collectInto(n, out) {
    var children = n.children || [];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'constant') {
        out.push(source.substring(c.startIndex, c.endIndex));
      }
      collectInto(c, out);
    }
  }
  if (node.childForFieldName) {
    var heritage = node.childForFieldName('heritage');
    if (heritage) {
      var hc = heritage.children || [];
      for (var j = 0; j < hc.length; j++) {
        if (hc[j].type === 'extends_clause') { collectInto(hc[j], result.inherits); }
        else if (hc[j].type === 'implements_clause') { collectInto(hc[j], result.implements); }
        else { collectInto(hc[j], result.inherits); }
      }
    }
    var f = node.childForFieldName('superclasses'); if (f) collectInto(f, result.inherits);
    f = node.childForFieldName('base_class_clause'); if (f) collectInto(f, result.inherits);
    f = node.childForFieldName('superclass'); if (f) collectInto(f, result.inherits);
  }
  return result;
}

// USAGE 提取（读写区分，worker 内联版，与主线程 _isUsageNode/_collectUsageEdges 对齐）
function _isUsageNode(t) {
  return t === 'assignment_expression' || t === 'assignment' ||
    t === 'augmented_assignment_expression' || t === 'compound_assignment_expression' ||
    t === 'type_annotation' || t === 'type_identifier' || t === 'type_hint' ||
    t === 'new_expression' || t === 'object_creation_expression';
}
function _collectUsageEdges(node, source, currentFn, edges) {
  var add = function (name, access) {
    if (name && name.length > 0 && name !== 'this') {
      edges.push({ source: currentFn, target: 'usage:' + name, type: 'USAGE', properties: { access: access } });
    }
  };
  if (node.type === 'assignment_expression' || node.type === 'assignment' ||
    node.type === 'augmented_assignment_expression' || node.type === 'compound_assignment_expression') {
    var left = node.childForFieldName ? (node.childForFieldName('left') || node.childForFieldName('target')) : undefined;
    if (left) {
      if (left.type === 'identifier' || left.type === 'field_identifier') {
        add(source.substring(left.startIndex, left.endIndex), 'write');
      } else if (left.childForFieldName) {
        var prop = left.childForFieldName('property') || left.childForFieldName('field');
        if (prop && (prop.type === 'property_identifier' || prop.type === 'identifier')) {
          add(source.substring(prop.startIndex, prop.endIndex), 'write');
        }
      }
    }
    return;
  }
  if (node.type === 'type_annotation' || node.type === 'type_hint') {
    var ch = node.children || [];
    for (var i = 0; i < ch.length; i++) {
      if (ch[i].type === 'type_identifier' || ch[i].type === 'identifier') {
        add(source.substring(ch[i].startIndex, ch[i].endIndex), 'read');
      }
    }
    return;
  }
  if (node.type === 'type_identifier') {
    add(source.substring(node.startIndex, node.endIndex), 'read');
    return;
  }
  if (node.type === 'new_expression' || node.type === 'object_creation_expression') {
    var ctor = node.childForFieldName ? (node.childForFieldName('constructor') || node.childForFieldName('type') || node.childForFieldName('class')) : undefined;
    if (ctor) {
      add(source.substring(ctor.startIndex, ctor.endIndex), 'read');
    }
  }
}

function walkAST(node, source, filePath, nodes, edges, currentFn, loopDepth) {
  if (loopDepth === undefined) loopDepth = 0;
  const nodeType = AST_TO_NODE_TYPE[node.type];
  let myFn = currentFn;
  // Call sites → CALLS edge (virtual target, resolved later in _matchCallsToDefinitions)
  if (currentFn && (node.type === 'call_expression' || node.type === 'call' || node.type === 'method_invocation' || node.type === 'invocation_expression')) {
    const callee = _extractCalleeName(node, source);
    if (callee) {
      edges.push({ source: currentFn, target: 'call:' + callee, type: 'CALLS', properties: { loopDepth: loopDepth } });
    }
  }
  // Usage sites → USAGE edge (read/write, resolved later in _matchUsageEdgesToDefinitions)
  if (currentFn && _isUsageNode(node.type)) {
    _collectUsageEdges(node, source, currentFn, edges);
  }
  if (nodeType) {
    const name = extractName(node, source);
    if (name) {
      const qualifiedName = filePath + '::' + name;
      const startLine = node.startPosition ? node.startPosition.row + 1 : undefined;
      const endLine = node.endPosition ? node.endPosition.row + 1 : undefined;
      var cx = computeComplexity(node);
      var intra = (nodeType === 'function' || nodeType === 'method') ? _analyzeIntra(node, source, name) : undefined;
      var hasMetrics = cx.cyclomatic > 0 || cx.maxLoopDepth > 0;
      var props = (hasMetrics || intra) ? {} : undefined;
      if (hasMetrics) { props.cyclomatic = cx.cyclomatic; props.loop_depth = cx.maxLoopDepth; }
      if (intra) {
        props.linear_scan_in_loop = intra.linearScanInLoop ? 1 : 0;
        props.alloc_in_loop = intra.allocInLoop ? 1 : 0;
        props.recursion_in_loop = intra.recursionInLoop ? 1 : 0;
        props.unguarded_recursion = intra.unguardedRecursion ? 1 : 0;
      }
      nodes.push({ id: qualifiedName, name: name, type: nodeType, filePath: filePath, qualifiedName: qualifiedName, inDegree: 0, outDegree: 0, startLine: startLine, endLine: endLine, properties: props });
      edges.push({ source: filePath, target: qualifiedName, type: 'CONTAINS' });
      // 继承/接口实现边（虚拟目标 inherits:/implements:<baseName>，索引后由 _matchInheritsToDefinitions 解析）
      if (nodeType === 'class' || nodeType === 'interface') {
        var bases = _extractInheritNames(node, source);
        for (var bi = 0; bi < bases.inherits.length; bi++) {
          edges.push({ source: qualifiedName, target: 'inherits:' + bases.inherits[bi], type: 'INHERITS' });
        }
        for (var ii = 0; ii < bases.implements.length; ii++) {
          edges.push({ source: qualifiedName, target: 'implements:' + bases.implements[ii], type: 'IMPLEMENTS' });
        }
      }
      myFn = qualifiedName;
    }
  }
  const nextLoopDepth = LOOP_NODE_TYPES[node.type] ? loopDepth + 1 : loopDepth;
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      walkAST(node.children[i], source, filePath, nodes, edges, myFn, nextLoopDepth);
    }
  }
}

// Worker 级 parser 缓存（对齐 C 版 get_thread_parser）：按语言复用 Parser 实例，
// 避免大仓库每文件一次 new Parser() + setLanguage（数万次 WASM 语言绑定开销）。
const parserCache = {};

self.onmessage = async function(e) {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      await doInit(msg.tsWasm, msg.langWasms);
      self.postMessage({ type: 'init-done', langCount: Object.keys(languages).length });
    } catch(err) {
      self.postMessage({ type: 'init-error', error: err.message || String(err) });
    }
  } else if (msg.type === 'parse') {
    try {
      const lang = languages[msg.langName];
      if (!lang) { self.postMessage({ type: 'parse-result', id: msg.id, nodes: [], edges: [] }); return; }
      let parser = parserCache[msg.langName];
      if (!parser) { parser = new Parser(); parser.setLanguage(lang); parserCache[msg.langName] = parser; }
      const tree = parser.parse(msg.source);
      const nodes = [], edges = [];
      // 必须释放 tree（WASM 线性内存），否则数千文件后 ts_malloc_default abort
      if (tree) { try { walkAST(tree.rootNode, msg.source, msg.filePath, nodes, edges); } finally { tree.delete(); } }
      self.postMessage({ type: 'parse-result', id: msg.id, nodes: nodes, edges: edges });
    } catch(err) {
      self.postMessage({ type: 'parse-result', id: msg.id, nodes: [], edges: [], error: err.message || String(err) });
    }
  }
};
`;
	}

	/**
	 * 通过 Worker 解析单个文件（带 15 秒超时，防止 tree-sitter 挂起导致死锁）
	 */
	private _parseViaWorker(worker: Worker, id: number, source: string, langName: string, filePath: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; status: FileCoverageStatus; reason?: string }> {
		return new Promise((resolve) => {
			let resolved = false;
			const handler = (e: MessageEvent) => {
				if (e.data.type === 'parse-result' && e.data.id === id) {
					if (resolved) { return; }
					resolved = true;
					clearTimeout(timeout);
					worker.removeEventListener('message', handler);
					const nodes: GraphNode[] = e.data.nodes || [];
					const edges: GraphEdge[] = e.data.edges || [];
					const err: string | undefined = e.data.error;
					// 解析出错但有部分节点 → partial；全空 → parse_error；正常 → indexed
					const status: FileCoverageStatus = err
						? (nodes.length > 0 ? 'partial' : 'parse_error')
						: 'indexed';
					resolve({ nodes, edges, status, reason: err });
				}
			};
			worker.addEventListener('message', handler);

			// 15 秒超时：某些文件（如生成的代码、超长行）可能导致 tree-sitter 挂起
			const timeout = setTimeout(() => {
				if (resolved) { return; }
				resolved = true;
				worker.removeEventListener('message', handler);
				this._logService.warn('[CodebaseGraph]', `⏱ Worker parse timeout (15s), skipping: ${filePath}`);
				resolve({ nodes: [], edges: [], status: 'timeout', reason: 'worker parse timeout 15s' }); // 跳过该文件，继续处理下一个
			}, 15000);

			worker.postMessage({ type: 'parse', id, source, langName, filePath });
		});
	}

	private _disposeWorkers(): void {
		for (const w of this._parserWorkers) { w.terminate(); }
		this._parserWorkers = [];
		this._workerInitPromise = undefined;
		// 清理自愈参数（dispose 后若再崩溃不应重建）
		this._workerUrl = undefined;
		this._workerTsWasm = undefined;
		this._workerLangWasms = undefined;
	}

	// ─── Main Index Method ──────────────────────────────────────────────

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
			return { success: false, message: '索引正在进行中，请稍候...' };
		}

		this._isIndexing = true;
		this._indexCts = cts;

		let releaseLock: () => void;
		try {
			releaseLock = await this._lockIndex(rootPath);
		} catch (lockErr) {
			this._isIndexing = false;
			return { success: false, message: lockErr instanceof Error ? lockErr.message : '索引已被锁定，请稍候...' };
		}

		try {
		this._onDidIndexProgress.fire('▶ 开始索引工作区...');
		// 多 folder：projectName 优先（每 folder 唯一），回退 subPath，再回退 basename，最后 '_default'。
		this._projectName = config.projectName || config.subPath || this._basename(rootPath) || '_default';
		this._rootProjectMap.set(this._normalizeRoot(rootPath), this._projectName);
		// P0 修复：解析产出的节点/边必须打上真实项目名，否则 post-passes 与按项目保存全部落空
		this._graph.setActiveProject(this._projectName);
		this._indexCoverage = new Map(); // 重置逐文件覆盖率记录


		// 1. Scan files
		// 全量索引前刷新缓存：用户可能刚改过 .cbmignore / 刚添加 .uproject
		this._invalidateExcludeCache(rootPath);
		const excludeDirs = await this._resolveExcludeDirs(rootPath, config.excludeDirs);
		// 记录本次全量索引的生效范围，供 watcher/增量索引用同一口径（防幻影变更）
		this._watchScopeCache.set(this._normalizeRoot(rootPath), { excludeDirs, keepDirs: config.keepDirs ? [...config.keepDirs] : undefined });
		this._onDidIndexProgress.fire('📁 扫描文件...');
		const files = await this._scanFiles(rootPath, excludeDirs, config.subPath, cts.token, config.keepDirs);
			const filesScanned = files.length;
			this._onDidIndexProgress.fire(`📁 找到 ${filesScanned} 个源文件`);

			if (cts.token.isCancellationRequested) {
				return { success: false, message: '索引已取消', duration: 0 };
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

			const filePath = files[idx];
			const relPath = this._getRelativePath(filePath);
			const ext = this._getExtension(filePath);
			const langName = EXTENSION_TO_WASM_LANG[ext];
			// 跳过文件也必须记录哈希——否则 watcher 每轮轮询都会把它们报为 "added"，
			// 形成永不收敛的脏集（配合增量→重启 watcher→再触发 的循环，即每 30s 一次空增量）
			if (!langName) { this._recordCoverage(relPath, 'skipped', `unsupported extension .${ext}`); await this._recordFileHash(this._projectName, relPath, filePath); continue; }

			// 主线程读取文件内容 (async I/O)
			let source: string;
			try {
				const content = await this._fileService.readFile(URI.file(filePath));
				source = content.value.toString();
			} catch { this._recordCoverage(relPath, 'skipped', 'read failed'); await this._recordFileHash(this._projectName, relPath, filePath); continue; }
				if (source.length > MAX_FILE_SIZE) { this._recordCoverage(relPath, 'skipped', `file too large (${source.length} > ${MAX_FILE_SIZE})`); continue; }
				// 跳过超长行文件（minified/生成代码会导致 tree-sitter 挂起）
				if (source.indexOf('\n', 0) === -1 && source.length > 50000) { this._recordCoverage(relPath, 'skipped', 'single-line file > 50KB (minified?)'); continue; } // 单行超 50K
				// 快速检测最长行（只检查前 100 行，避免开销）
				let maxLineLen = 0;
				const lines = source.split('\n');
				const checkLines = Math.min(lines.length, 100);
				for (let li = 0; li < checkLines; li++) { if (lines[li].length > maxLineLen) { maxLineLen = lines[li].length; } }
				if (maxLineLen > MAX_LINE_LENGTH) { this._recordCoverage(relPath, 'skipped', `line too long (${maxLineLen} > ${MAX_LINE_LENGTH})`); continue; }

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

				// 记录文件哈希（mtime+size），供增量重索引分类使用
				await this._recordFileHash(this._projectName, relPath, filePath);

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
			// 记录文件哈希（mtime+size），供增量重索引分类使用
			await this._recordFileHash(this._projectName, relPath, filePath);
			if (i > 0 && i % YIELD_INTERVAL === 0) {
					await new Promise<void>(resolve => setTimeout(resolve, 0));
				}
			}
		}

		// 解析完成，释放 Worker 池
		this._disposeWorkers();

		// 批量重建 BM25 索引
		this._graph.store.setDeferBM25(false);
		this._onDidIndexProgress.fire(`📝 构建 BM25 索引 (${nodesExtracted} 节点)...`);
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		// 时间切片重建（async，内部每 5000 节点 yield，避免大图冻结 UI）
		await this._graph.store.rebuildBM25((done, total) => {
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
			const similarEdges = this._runSimilarityPass();
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
				this._lspResolver.buildDefIndex(this._graph.store, this._projectName);
			}

			// 6. Community detection (Leiden) — always run (used by get_architecture)
			this._onDidIndexProgress.fire('🏘️ 社区检测 (Leiden)...');
			try {
				const leidenResult = await runMultiLevelLeiden(this._graph.store, this._projectName, 1.0, 5);
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
						n.project === this._projectName && n.filePath && (
							n.filePath.endsWith('.env') || n.filePath.endsWith('.yaml') ||
							n.filePath.endsWith('.yml') || n.filePath.endsWith('.toml') ||
							n.filePath.endsWith('package.json') || n.filePath.endsWith('go.mod')
						)
					);
					const configPaths = [...new Set(configFileNodes.map(n => n.filePath!).filter(Boolean))];
					const configLinks = linkConfigToCode(this._graph.store, this._projectName, configPaths);
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
			await this._saveGraph(rootPath, this._projectName);

			// Phase 2b：将完整图数据同步到主进程 SQLite（默认开启；仅显式 false 关闭）。
			// 所有模式（含 fast）都全量同步——保证 sqlite 库始终有最新完整图数据，搜索走 FTS5；
			// 增量变更走 _syncIncrementalToSqlite 补丁（见 _runIncrementalIndex）。
			// 同步成功后不再释放内存 store（同步路径 hasGraphData()/searchGraph 依赖它）。
		if (this._sqliteBackendEnabled) {
			this._onDidIndexProgress.fire('💾 同步到 SQLite 后端...');
			try {
				await this._syncGraphToSqlite();
			} catch (err) {
				this._logService.error('[CodebaseGraph]', 'SQLite sync failed:', err);
			}
		}

			const duration = Math.round((Date.now() - startTime) / 1000);
			const result: IIndexResult = {
				success: true,
				message: `索引完成: ${filesScanned} 文件, ${nodesExtracted} 节点, ${edgesExtracted} 边`,
				duration,
				stats: { filesScanned, nodesExtracted, edgesExtracted },
			};
			this._onDidIndexProgress.fire(`✓ ${result.message} (${duration}s)`);
			this._onDidIndexComplete.fire(result);
			return result;

		} catch (err: any) {
			const duration = Math.round((Date.now() - startTime) / 1000);
			const msg = cts.token.isCancellationRequested
				? `索引已取消 (${duration}s)`
				: `索引失败: ${err.message || String(err)}`;
			const result: IIndexResult = { success: false, message: msg, duration };
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
		void this._resolveExcludeDirs(rootPath, extraExcludeDirs).then(excludeDirs => {
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
			await this._runIncrementalIndex(rootPath);
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
	 */
	private async _runIncrementalIndex(rootPath: string, token?: CancellationToken): Promise<IIndexResult> {
		if (!rootPath) { return { success: false, message: '未指定监听根路径' }; }
		if (this._isIndexing) {
			return { success: false, message: '索引正在进行中，跳过增量索引' };
		}

		const cts = new CancellationTokenSource(token);
		const startTime = Date.now();
		this._isIndexing = true;
		this._indexCts = cts;

		let releaseLock: () => void;
		try {
			releaseLock = await this._lockIndex(rootPath);
		} catch (lockErr) {
			this._isIndexing = false;
			return { success: false, message: lockErr instanceof Error ? lockErr.message : '索引已被锁定，跳过增量索引' };
		}

		try {
			// 多 folder：按 root 解析对应项目名（回退到当前 _projectName）
			const project = this._rootProjectMap.get(this._normalizeRoot(rootPath)) || this._projectName;
			// P0 修复：增量重解析的节点/边同样按真实项目名写入
			this._graph.setActiveProject(project);
			this._onDidIndexProgress.fire('⚡ 增量索引：扫描变更文件...');

			// 复用 watcher/全量索引已生效的索引范围（用户 excludeDirs + keepDirs）——
			// 旧实现空调用 _resolveExcludeDirs(rootPath)（零 extra、无 keepDirs），与全量索引口径不一致，
			// 导致基线 fileHashes 与增量扫描集错配：watcher 报幻影 deleted → 增量又报 added（翻烧饼循环）。
			const cachedScope = this._watchScopeCache.get(this._normalizeRoot(rootPath));
			const incExcludeDirs = cachedScope?.excludeDirs ?? await this._resolveExcludeDirs(rootPath);
			const absFiles = await this._scanFiles(rootPath, incExcludeDirs, undefined, cts.token, cachedScope?.keepDirs);
			const relToAbs = new Map<string, string>();
			for (const abs of absFiles) { relToAbs.set(this._getRelativePath(abs), abs); }

			const classification = await this._getIncrementalIndexer().classifyFiles(
				project, absFiles, (abs) => this._getRelativePath(abs));
			this._onDidIndexProgress.fire(`⚡ 增量分类: +${classification.added.length} ~${classification.modified.length} -${classification.deleted.length} =${classification.unchanged.length}`);

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
				};
				this._onDidIndexComplete.fire(noChangeResult);
				return noChangeResult;
			}

			// 1. 删除被删/被改文件的旧节点与边
			for (const rel of [...classification.deleted, ...classification.modified]) {
				this._graph.deleteByFile(rel);
				this._graph.store.deleteFileHash(project, rel);
			}

			// 2. 重新解析新增/被改文件
			let nodesExtracted = 0;
			let edgesExtracted = 0;
			this._graph.store.setDeferBM25(true);
			const toParseRel = [...classification.added, ...classification.modified];
			for (let i = 0; i < toParseRel.length; i++) {
				if (cts.token.isCancellationRequested) { break; }
				const rel = toParseRel[i];
				const abs = relToAbs.get(rel);
				if (!abs) { continue; }
				try {
					const result = await this._parseFile(abs, cts.token);
					for (const n of result.nodes) { this._graph.addNode(n); nodesExtracted++; }
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
					// 更新文件哈希（仅 mtime+size，避免 SHA-256 开销）
					try {
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
					} catch { /* 忽略哈希更新失败 */ }
				} catch (err: any) {
					this._logService.debug('[CodebaseGraph]', `Incremental parse failed ${abs}: ${err?.message || err}`);
				}
				if (i > 0 && i % 50 === 0) { await new Promise<void>(r => setTimeout(r, 0)); }
			}
			this._graph.store.setDeferBM25(false);
			await this._graph.store.rebuildBM25();
			this._graph.store.checkpoint();

			// 增量克隆检测（基于重解析节点的预计算签名，insertEdge 按端点去重，天然幂等）
			const similarEdges = this._runSimilarityPass();

			// 增量继承边匹配（暂存的 inherits:/implements: 虚拟边 → 真实 INHERITS/IMPLEMENTS 边）
			const matchedInherits = await this._matchInheritsToDefinitions();
			edgesExtracted += matchedInherits;

			// 增量使用边匹配（暂存的 usage: 虚拟边 → 真实 USAGE 边，带 access 读写）
			const matchedUsage = await this._matchUsageEdgesToDefinitions();
			edgesExtracted += matchedUsage;

			await this._saveGraph(rootPath, project);

			// Phase 2b 增量补丁：仅同步变更文件到 sqlite（不触发全量重建）
			if (this._sqliteBackendEnabled) {
				this._onDidIndexProgress.fire('💾 SQLite 增量补丁...');
				await this._syncIncrementalToSqlite(project, [...classification.deleted, ...classification.modified, ...classification.added]);
			}

			const duration = Math.round((Date.now() - startTime) / 1000);
			const message = `增量索引完成: +${classification.added.length} ~${classification.modified.length} -${classification.deleted.length} (${nodesExtracted} 节点, ${edgesExtracted} 边, ${similarEdges} 克隆边, ${duration}s)`;
			this._onDidIndexProgress.fire(`✓ ${message}`);
			const result: IIndexResult = {
				success: true,
				message,
				duration,
				stats: { filesScanned: absFiles.length, nodesExtracted, edgesExtracted },
			};
			this._onDidIndexComplete.fire(result);
			return result;
		} catch (err: any) {
			const msg = `增量索引失败: ${err?.message || String(err)}`;
			this._onDidIndexProgress.fire(`✗ ${msg}`);
			return { success: false, message: msg, duration: 0 };
		} finally {
			this._isIndexing = false;
			this._indexCts?.dispose();
			this._indexCts = undefined;
			releaseLock();
		}
	}

	/**
	 * 持久化图谱到 {rootPath}/.codebase-memory/graph.db.zst（全量与增量共用）。
	 * 多 folder：project 提供时仅保存该 folder 的子图，避免把其它 folder 的节点写进本 folder 的制品。
	 */
	private async _saveGraph(rootPath: string, project?: string): Promise<void> {
		const graphDir = URI.joinPath(URI.file(rootPath), '.codebase-memory');
		try {
			await this._fileService.createFolder(graphDir);
			const artifactFile = URI.joinPath(graphDir, 'graph.db.zst');
			try {
			const persistence = new GraphPersistence(this._fileService, this._logService);
			let lastLoggedMB = 0;
			await persistence.save(this._graph.store, artifactFile.fsPath, project, undefined, (writtenMB) => {
				// 每 32MB 报一次保存进度（避免大图谱保存期间 UI 看似假死）
				if (writtenMB - lastLoggedMB >= 32) {
					lastLoggedMB = writtenMB;
					this._onDidIndexProgress.fire(`💾 保存图谱: ${writtenMB.toFixed(0)} MB...`);
				}
			});
			const savedCount = project ? this._graph.store.getNodeCount(project) : this._graph.nodeCount;
			// 防御性告警：项目计数为 0 但 store 非空 → 节点项目标记与保存项目不一致（曾致无限重建循环）
			const totalCount = this._graph.store.getNodeCount();
			if (savedCount === 0 && totalCount > 0) {
				this._logService.warn('[CodebaseGraph]', `Graph save sanity check FAILED: 0 nodes for project=${project} but store holds ${totalCount} total nodes — node project-tag mismatch, saved artifact will be EMPTY`);
			}
			this._logService.info('[CodebaseGraph]', `Graph saved: ${artifactFile.fsPath} (project=${project ?? 'all'}, ${savedCount} nodes)`);
			} catch (err: any) {
				// best-effort 不等于静默：保存失败（如大图谱序列化 OOM）必须可见，否则启动加载不到图会莫名全量重建
				this._logService.warn('[CodebaseGraph]', `Graph save failed: ${artifactFile.fsPath}: ${err?.message || err}`);
			}
		} catch (err: any) {
			this._logService.warn('[CodebaseGraph]', `Failed to save graph: ${err?.message || err}`);
		}
	}


	// ─── Exclude Dirs Resolution (P1/P3/P4) ──────────────────────────────────

	/** .cbmignore 解析缓存：归一化 root → 目录名列表 */
	private readonly _cbmIgnoreCache = new Map<string, string[]>();

	/**
	 * 读取 code-workspace 的 `search.exclude` / `files.exclude` 配置，提取目录名。
	 * UE / 游戏引擎等特异性排除由用户在 code-workspace 中显式配置，索引器不再探测 `*.uproject`。
	 */
	private _readWorkspaceExcludes(rootPath: string): string[] {
		const resource = URI.file(rootPath);
		const searchExclude = this._configurationService.getValue<Record<string, boolean | { when?: string }>>('search.exclude', { resource });
		const filesExclude = this._configurationService.getValue<Record<string, boolean | { when?: string }>>('files.exclude', { resource });
		return mergeExcludeDirs(extractExcludeDirNames(searchExclude), extractExcludeDirNames(filesExclude));
	}

	/** 读取并解析 `<root>/.cbmignore`（P4：此前只写不读）。不存在时返回空列表。 */
	private async _readCbmIgnore(rootPath: string): Promise<string[]> {
		const key = this._normalizeRoot(rootPath);
		const cached = this._cbmIgnoreCache.get(key);
		if (cached !== undefined) { return cached; }
		let dirs: string[] = [];
		try {
			const content = await this._fileService.readFile(URI.joinPath(URI.file(rootPath), '.cbmignore'));
			dirs = parseCbmIgnore(content.value.toString());
		} catch {
			// 文件不存在是常态，不记日志
		}
		this._cbmIgnoreCache.set(key, dirs);
		return dirs;
	}

	/**
	 * 解析某个 root 的最终排除目录集合：
	 * 通用默认 + code-workspace 的 `search.exclude`/`files.exclude` + `.cbmignore` + 调用方额外指定。
	 */
	private async _resolveExcludeDirs(rootPath: string, extra?: readonly string[]): Promise<Set<string>> {
		const cbmIgnore = await this._readCbmIgnore(rootPath);
		const wsExcludes = this._readWorkspaceExcludes(rootPath);
		const merged = mergeExcludeDirs(
			DEFAULT_EXCLUDE_DIRS,
			wsExcludes,
			cbmIgnore,
			extra,
		);
		if (wsExcludes.length || cbmIgnore.length) {
			this._logService.info('[CodebaseGraph]', `[exclude] ${rootPath}: workspace=${wsExcludes.length} items, cbmignore=${cbmIgnore.length} items, total=${merged.length}`);
		}
		return new Set(merged);
	}

	/** 使排除目录相关缓存失效（配置变更 / 重新索引时调用）。 */
	private _invalidateExcludeCache(rootPath: string): void {
		const key = this._normalizeRoot(rootPath);
		this._cbmIgnoreCache.delete(key);
	}

	// ─── File Scanning ───────────────────────────────────────────────────────

	private _scanFileCount = 0; // 扫描累计计数（用于进度频率控制）
	private _scanRootPath = ''; // 扫描根路径（用于计算相对路径判断 keepDirs）

	private async _scanFiles(rootPath: string, excludeDirs: Set<string>, subPath: string | undefined, token: CancellationToken, keepDirs?: string[]): Promise<string[]> {
		const scanPath = subPath
			? URI.joinPath(URI.file(rootPath), subPath).fsPath
			: rootPath;
		const results: string[] = [];
		this._scanFileCount = 0;
		this._scanRootPath = scanPath.replace(/\\/g, '/');
		// 构建 keepDirs 匹配集合（大小写不敏感，标准化为 / 分隔）
		const keepSet = new Set<string>();
		if (keepDirs) {
			for (const k of keepDirs) {
				keepSet.add(k.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase());
			}
		}
		this._logService.info('[CodebaseGraph]', `[scan] start: ${scanPath}, excludeDirs=${[...excludeDirs].join(',')}, keepDirs=${[...keepSet].join(',')}`);
		this._onDidIndexProgress.fire(`📁 扫描目录: ${scanPath}`);
		await this._scanDir(URI.file(scanPath), excludeDirs, results, token, 0, keepSet);
		this._logService.info('[CodebaseGraph]', `[scan] done: ${results.length} files`);
		this._onDidIndexProgress.fire(`📁 扫描完成: 找到 ${results.length} 个源文件`);
		return results;
	}

	// 大小写不敏感的排除目录集合
	private _excludeLowerCache: Set<string> | undefined;
	private _excludeLowerKey: string = '';
	private _isExcluded(name: string, excludeDirs: Set<string>): boolean {
		if (excludeDirs.has(name)) { return true; }
		// 构建大小写不敏感集合（缓存，避免每次重建）
		const key = [...excludeDirs].sort().join(',');
		if (this._excludeLowerKey !== key) {
			this._excludeLowerCache = new Set([...excludeDirs].map(d => d.toLowerCase()));
			this._excludeLowerKey = key;
		}
		return this._excludeLowerCache?.has(name.toLowerCase()) ?? false;
	}

	private async _scanDir(dirUri: URI, excludeDirs: Set<string>, results: string[], token: CancellationToken, depth: number, keepSet: Set<string>): Promise<void> {
		if (token.isCancellationRequested) { return; }
		if (depth > 30) { return; }

		let stat;
		try {
			stat = await this._fileService.resolve(dirUri);
		} catch {
			return;
		}

		if (!stat.children) { return; }

		let dirCount = 0, fileCount = 0;
		for (const child of stat.children) {
			if (token.isCancellationRequested) { return; }
			if (child.name.startsWith('.') && child.name !== '.' && child.name !== '..') {
				continue;
			}
			// 检查排除规则 + keepDirs 例外
			if (this._isExcluded(child.name, excludeDirs)) {
				// 如果是目录，检查是否在 keepDirs 中（通过相对路径匹配）
				if (child.isDirectory && keepSet.size > 0) {
					const childPath = child.resource.fsPath.replace(/\\/g, '/');
					const relPath = this._scanRootPath && childPath.startsWith(this._scanRootPath)
						? childPath.substring(this._scanRootPath.length).replace(/^\/+/, '')
						: child.name;
					// 检查 relPath 或其父路径是否匹配 keepSet 中的任一条目
					const relPathLower = relPath.toLowerCase();
					let shouldKeep = false;
					for (const keep of keepSet) {
						// 精确匹配或 keep 是 relPath 的子路径前缀
						if (relPathLower === keep || relPathLower.startsWith(keep + '/') || keep.startsWith(relPathLower + '/')) {
							shouldKeep = true;
							break;
						}
					}
				if (shouldKeep) {
					// 该被排除目录是"通向 keep 的祖先"（keep 是其子孙）→ 只沿 keep 路径下钻，
					// 禁止全量遍历祖先（防止 Content 等巨型目录因 keep 命中而卡死/海量扫描）
					const isKeepAncestor = [...keepSet].some(k => k.startsWith(relPathLower + '/'));
					if (isKeepAncestor) {
						this._logService.info('[CodebaseGraph]', `[scan] keep-path descend through excluded ancestor: ${relPath}`);
						await this._scanKeepPath(child.resource, relPathLower, excludeDirs, results, token, keepSet, depth + 1);
						continue;
					}
					this._logService.info('[CodebaseGraph]', `[scan] keeping excluded dir: ${relPath}`);
					// 继续扫描此目录（keep 精确命中）
				} else {
					continue;
				}
				} else {
					continue;
				}
			}
			if (child.isDirectory) {
				dirCount++;
				await this._scanDir(child.resource, excludeDirs, results, token, depth + 1, keepSet);
			} else if (child.isFile) {
				fileCount++;
				const ext = this._getExtension(child.name);
				if (ext && EXTENSION_TO_WASM_LANG[ext]) {
					results.push(child.resource.fsPath);
					this._scanFileCount++;
					// 每 500 个文件 fire 一次进度（降低日志噪声）
					if (this._scanFileCount % 500 === 0) {
						const dirName = dirUri.fsPath.split(/[\\/]/).pop() || '';
						this._onDidIndexProgress.fire(`📁 扫描中: ${results.length} 文件 (${dirName})`);
					}
				}
			}
		}

		// 根目录和深层目录都记录日志（降级为 debug，避免刷屏）
		if (depth <= 2 || dirCount > 5) {
			const dirName = dirUri.fsPath.split(/[\\/]/).pop() || dirUri.fsPath;
			this._logService.debug('[CodebaseGraph]', `[scan] depth=${depth} dir=${dirName} dirs=${dirCount} files=${fileCount} total=${results.length}`);
		}
	}

	private _getExtension(fileName: string): string {
		const idx = fileName.lastIndexOf('.');
		return idx >= 0 ? fileName.substring(idx).toLowerCase() : '';
	}

	/**
	 * 沿 keep 路径逐级下钻（每级只进入通向 keep 的下一段），直到某目录本身是 keep 精确命中时，
	 * 再对该目录执行完整 _scanDir。用于"被排除祖先仅因 keep 保留"的场景：
	 * 例如 keep=content/script 时，只遍历 Content/Script 分支，跳过 Content/Art、Content/Audio 等。
	 * relPathLower 为 dirUri 相对扫描根的路径（小写 / 分隔）。
	 */
	private async _scanKeepPath(dirUri: URI, relPathLower: string, excludeDirs: Set<string>, results: string[], token: CancellationToken, keepSet: Set<string>, depth: number): Promise<void> {
		// 提取 dirUri 下所有"通向 keep"的下一段目录名
		const nextSegs = new Set<string>();
		let exactKeep = false;
		for (const keep of keepSet) {
			if (keep === relPathLower) { exactKeep = true; }
			else if (keep.startsWith(relPathLower + '/')) {
				nextSegs.add(keep.slice(relPathLower.length + 1).split('/')[0]);
			}
		}
		// 当前目录本身就是 keep 精确目录 → 整目录全扫（含其全部子树）
		if (exactKeep) {
			this._logService.info('[CodebaseGraph]', `[scan] keep-path reached keep dir: ${relPathLower}`);
			await this._scanDir(dirUri, excludeDirs, results, token, depth, keepSet);
			return;
		}
		// 否则只沿下一段目录下钻（不遍历祖先的其他内容）
		for (const seg of nextSegs) {
			if (token.isCancellationRequested) { return; }
			const childUri = URI.joinPath(dirUri, seg);
			const stat = await this._fileService.stat(childUri).catch(() => undefined);
			if (stat?.isDirectory) {
				this._logService.info('[CodebaseGraph]', `[scan] keep-path descend: ${relPathLower}/${seg}`);
				await this._scanKeepPath(childUri, `${relPathLower}/${seg}`, excludeDirs, results, token, keepSet, depth + 1);
			}
		}
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
	 */
	private _runSimilarityPass(): number {
		let edgesAdded = 0;
		const store = this._graph.store;
		const project = this._projectName;

		try {
			const allNodes = store.getAllNodes().filter(n => n.project === project);
			const similarEdges = detectSimilarCode(allNodes, store, 0.7);
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

	// ─── 图谱加载竞态守卫（启动 loadGraphMerge 与 LLM 工具调用之间的竞争） ───

	private _graphLoadingCount = 0;
	private _graphLoadingWaiters: (() => void)[] = [];

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

	async hasGraphDataAsync(): Promise<boolean> {
		await this.whenGraphLoaded();
		if (this._sqliteBackendEnabled) {
			try {
				const count = await this._sqliteBackend.getTotalNodeCount(this._projectName);
				if (count > 0) { return true; }
				// sqlite 库为空（图从 gzip artifact 加载、本会话未索引同步）→ 回退内存 store
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
		return {
			nodes: result.nodes.map((n: any) => graphStore['_nodeToGraphNode'](n)),
			total: result.total,
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
	async searchGraphAsync(params: {
		project?: string;
		query?: string;
		namePattern?: string;
		label?: string;
		filePattern?: string;
		limit?: number;
		offset?: number;
		sortBy?: 'name' | 'inDegree' | 'outDegree' | 'degree';
		sortDesc?: boolean;
		minInDegree?: number;
		maxInDegree?: number;
		minOutDegree?: number;
		maxOutDegree?: number;
		relType?: string;
	}): Promise<{ nodes: GraphNode[]; total: number; scores?: Record<number, number>; hasMore?: boolean }> {
		const _tTotal = Date.now();
		if (!this._sqliteBackendEnabled) {
			// diag：内存同步路径在 renderer 主线程跑全量扫描，是 UI 卡死的嫌疑点，单独计时
			const _t = Date.now();
			const _r = this.searchGraph(params);
			const _ms = Date.now() - _t;
			if (_ms > 200) { this._logService.warn(`[CodebaseGraph] [searchGraphAsync][diag] IN-MEMORY sync path slow: ${_ms}ms needle="${(params.query || params.namePattern || '').slice(0, 40)}" total=${_r.total}`); }
			return _r;
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
				candidates = await this._sqliteBackend!.searchNodes(needle, nodeType, candidateCap);
			} else {
				candidates = await this._sqliteBackend!.getAllNodes(params.project ?? this._projectName, candidateCap);
			}
		} catch (err) {
			// sqlite 后端不可用（打包版缺原生模块等）→ 回退内存图（图已从 gzip 加载时仍可用）
			this._logService.warn('[CodebaseGraph] [searchGraphAsync] sqlite backend failed — falling back to in-memory graph:', err);
			return this.searchGraph(params);
		}
		if (candidates.length === 0 && this.hasGraphData()) {
			// sqlite 库为空（图从 gzip 加载、本会话未同步）→ 回退内存图
			this._logService.info('[CodebaseGraph] [searchGraphAsync] sqlite empty — falling back to in-memory graph');
			return this.searchGraph(params);
		}
		const _tFetchMs = Date.now() - _tFetch;
		if (_tFetchMs > 500) { this._logService.warn(`[CodebaseGraph] [searchGraphAsync][diag] sqlite fetch slow: ${_tFetchMs}ms needle="${needle.slice(0, 40)}" candidates=${candidates.length} path=${_fetchPath}`); }

		let nodes = candidates;
		const _candCount = candidates.length;
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
		return { nodes: nodes.slice(offset, offset + limit), total, hasMore: offset + limit < total };
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

		try {
			report.deadCode = detectDeadCodeEnhanced(this._graph.store, this._projectName);
		} catch { /* ignore */ }

		try {
			const layout = computeTwoLevelLOD(this._graph.store, this._projectName, 'overview');
			report.layoutNodes = layout.size;
		} catch { /* ignore */ }

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
				this._projectName = detected;
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
				const loaded = await persistence.load(this._graph.store, p);
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
		const candidates = [sourcePath];
		if (sourcePath.endsWith('.json')) {
			candidates.push(sourcePath.replace(/\.json$/, '.db.zst'), sourcePath.replace(/\.json$/, '.db.gz'));
		} else if (sourcePath.endsWith('.db.gz')) {
			candidates.push(sourcePath.replace(/\.db\.gz$/, '.db.zst'));
		}

		const persistence = new GraphPersistence(this._fileService, this._logService);
		for (const p of candidates) {
			try {
				const loaded = await persistence.loadMerge(this._graph.store, p, projectOverride);
				if (loaded) {
					if (rebuildBM25) { await this._graph.store.rebuildBM25(); }
					// 从文件路径推导 rootPath 并注册到 _rootProjectMap（多 folder 项目名解析）
					const graphDirIdx = p.lastIndexOf('/.codebase-memory/') >= 0 ? p.lastIndexOf('/.codebase-memory/')
						: p.lastIndexOf('\\.codebase-memory\\');
				if (graphDirIdx > 0) {
					const rootPath = this._normalizeRoot(p.substring(0, graphDirIdx));
					const proj = projectOverride || this._basename(rootPath) || '_default';
					this._rootProjectMap.set(rootPath, proj);
					if (this._projectName === '_default') {
						this._projectName = proj;  // 首个加载的 project 改为默认
					}
					this._logService.info('[CodebaseGraph]', `[loadGraphMerge] merged ${p} as project="${projectOverride ?? '(original)'}" (${Date.now() - tStart}ms), store nodes=${this._graph.nodeCount}`);
					// gzip 加载后若 SQLite 无该 project 数据则同步一次（幂等：listProjects 检查，
					// 避免每次启动全量重建；首次加载才同步，一次性成本）
					if (this._sqliteBackendEnabled && proj !== '_default') {
						try {
							const existingProjects = await this._sqliteBackend.listProjects();
							if (!existingProjects.some(pj => pj.name === proj)) {
								this._logService.info('[CodebaseGraph]', `SQLite missing project "${proj}" — syncing loaded graph...`);
								await this._syncGraphToSqlite(proj);
							} else {
								this._logService.info('[CodebaseGraph]', `SQLite already has project "${proj}" — skip sync`);
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

	override dispose(): void {
		this._disposeWorkers();
		super.dispose();
	}
}
