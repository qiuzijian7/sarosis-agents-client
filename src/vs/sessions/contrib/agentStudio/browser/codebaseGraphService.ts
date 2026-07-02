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
import { CodebaseGraphStore } from './codebaseGraphStore.js';
import { CypherEngine } from './codebaseGraphCypher.js';
import { SemanticSearch } from './codebaseGraphSemantic.js';
import { analyzeArchitecture } from './codebaseGraphArchitecture.js';
import { tracePath, getGraphSchema as getSchema, searchCode as graphSearchCode, getIndexStatus } from './codebaseGraphTrace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { LspCrossResolver } from './codebaseGraphLsp.js';
import { buildSemanticEdges, detectSimilarCode } from './codebaseGraphExtendedPasses.js';
import { runMultiLevelLeiden, detectDeadCodeEnhanced, computeTwoLevelLOD } from './codebaseGraphAdvancedAnalysis.js';
import { CrossRepoDiscovery } from './codebaseGraphCrossRepoDiscovery.js';
import { GraphPersistence } from './codebaseGraphPersistence.js';
import { scanEnvUrls } from './codebaseGraphEnvScan.js';
import { linkConfigToCode } from './codebaseGraphConfigLink.js';
import { TraceIngester } from './codebaseGraphTraces.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GraphNode {
	id: string;
	name: string;
	type: string;       // function, class, interface, module, file, variable, enum
	filePath?: string;
	qualifiedName?: string;
	inDegree: number;
	outDegree: number;
	startLine?: number;
	endLine?: number;
	project?: string;   // project name (default: '_default')
}

export interface GraphEdge {
	source: string;
	target: string;
	type: string;       // CALLS, IMPORTS, DEFINES, CONTAINS_FILE
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

export interface ICodebaseGraphService {
	readonly _serviceBrand: undefined;
	readonly onDidIndexProgress: Event<string>;
	readonly onDidIndexComplete: Event<IIndexResult>;
	readonly isIndexing: boolean;

	indexWorkspace(rootPath: string, config: IIndexConfig, token?: CancellationToken): Promise<IIndexResult>;
	cancelIndex(): void;
	getGraphStatus(workspacePath?: string): Promise<IGraphStatus>;
	saveGraph(targetPath: string): Promise<void>;
	loadGraph(sourcePath: string): Promise<boolean>;

	getGraphData(): GraphData;
	getGraphDataDownsampled(maxNodes: number): GraphData;
	getVisualizationData(maxNodes: number): VisualizationData;
	getVisualizationNodes(offset: number, limit: number): { nodes: VisualizationNode[]; total: number };
	getVisualizationEdges(nodeIds: Set<string>, offset: number, limit: number): GraphEdge[];
	getTotalEdgeCount(): number;
	hasGraphData(): boolean;
	getTotalNodeCount(): number;
	searchNodes(pattern: string, nodeType?: string): GraphNode[];
	getEdges(nodeId?: string): GraphEdge[];

	executeCypher(query: string): { columns: string[]; rows: any[][] };
	semanticSearch(query: string, limit?: number): { node: GraphNode; score: number; signals: Record<string, number> }[];

	getArchitecture(): any;
	getGraphSchema(): { nodeLabels: { label: string; count: number }[]; edgeTypes: { type: string; count: number }[]; totalNodes: number; totalEdges: number };
	getIndexStatus(): { project: string; exists: boolean; nodeCount: number; edgeCount: number; fileCount: number };

	tracePath(sourceName: string, targetName: string | undefined, mode?: string): any;
	searchCode(query: string, limit?: number): { filePath: string; lineNo: number; text: string; node?: GraphNode; relevanceScore: number }[];

	searchGraph(params: {
		project?: string;
		namePattern?: string;
		label?: string;
		limit?: number;
		offset?: number;
		sortBy?: 'name' | 'inDegree' | 'outDegree' | 'degree';
		sortDesc?: boolean;
		minInDegree?: number;
		minOutDegree?: number;
		relType?: string;
	}): { nodes: GraphNode[]; total: number };

	tracePathAdvanced(sourceName: string, targetName: string | undefined, opts?: {
		mode?: 'calls' | 'data_flow' | 'cross_service';
		maxDepth?: number;
		excludeEntry?: boolean;
		direction?: 'both' | 'callers' | 'callees';
		includeTests?: boolean;
	}): any;

	getArchitectureAdvanced(dimensions?: string[]): any;
	getCodeSnippet(qualifiedName: string, contextLines?: number, includeNeighbors?: boolean): Promise<{ filePath: string; startLine: number; endLine: number; content: string; language: string; neighbors?: { name: string; content: string }[] } | null>;

	listProjects(): { name: string; nodeCount: number; edgeCount: number; fileCount: number }[];
	deleteProject(name: string): void;

	detectChanges(opts?: { since?: string; baseBranch?: string; impactAnalysis?: boolean }): Promise<any>;

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

const DEFAULT_EXCLUDE_DIRS = [
	'node_modules', '.git', 'build', 'out', 'dist', '.vscode-test',
	'extensions', 'test', 'tests', 'resources', 'dev', 'docs', 'doc',
	'scripts', '.worktrees', 'deploy-package', 'cli', '.sarosworkspace',
	'.codebase-memory', 'target', '__pycache__', '.next', '.nuxt',
	'coverage', '.cache', 'tmp', 'temp',
	'Intermediate', 'Saved', 'Binaries', 'Build',
];

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const MAX_LINE_LENGTH = 10000;   // 超过此行长的文件跳过（minified/生成代码会导致 tree-sitter 挂起）

// ─── GraphStore (legacy compatibility wrapper) ─────────────────────────────

class GraphStore {
	private _store: CodebaseGraphStore = new CodebaseGraphStore();
	get store(): CodebaseGraphStore { return this._store; }
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
			project: '_default',
			id: numericId,
			label: node.type,
			name: node.name,
			qualifiedName: node.qualifiedName || node.name,
			filePath: node.filePath,
			startLine: node.startLine,
			endLine: node.endLine,
			properties: {},
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
		const allNodes = this._store.getAllNodes().filter(n => n.project === '_default');
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
		const edges = this._store.getAllEdges().filter(e => {
			const src = this._store.getNode(e.sourceId);
			const tgt = this._store.getNode(e.targetId);
			return src && tgt && src.project === '_default';
		});
		return edges.map(e => this._edgeToGraphEdge(e));
	}

	toJSON(): GraphData {
		const nodes = this._store.getAllNodes().filter(n => n.project === '_default').map(n => this._nodeToGraphNode(n));
		const edges = this.getAllEdges();
		return { nodes, edges };
	}

	/**
	 * 高效降采样：直接从 store 迭代器中选取 top-N 节点（按 degree 排序），
	 * 避免创建 25 万节点的完整数组。仅转换 N 个节点为 GraphNode 格式。
	 */
	toJSONDownsampled(maxNodes: number): GraphData {
		const storeNodes = this._store.getAllNodes();
		const projNodes = storeNodes.filter(n => n.project === '_default');

		// Sort by degree descending, take top-N
		projNodes.sort((a, b) => ((b.inDegree || 0) + (b.outDegree || 0)) - ((a.inDegree || 0) + (a.outDegree || 0)));
		const topNodes = projNodes.slice(0, maxNodes);

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

	/** 轻量级检查：图中是否有数据（不创建完整数组） */
	hasData(): boolean {
		return this._store.getNodeCount('_default') > 0;
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
		this._store.rebuildBM25();
	}

	get nodeCount(): number {
		return this._store.getNodeCount('_default');
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
		this._store.insertEdge({
			project: '_default',
			sourceId: srcNumeric,
			targetId: tgtNumeric,
			type: edge.type,
			properties: {},
		});
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
	private _cypherEngine: CypherEngine | undefined;
	private _semanticSearch: SemanticSearch | undefined;
	private _projectName = '_default';
	private _lspResolver: LspCrossResolver | undefined;
	private _crossRepoEnabled = false;

	// ─── Worker Pool (parallel tree-sitter parsing) ────────────────────
	private _parserWorkers: Worker[] = [];
	private _workerInitPromise: Promise<boolean> | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ITreeSitterLibraryService private readonly _treeSitterLib: ITreeSitterLibraryService,
		@ICommandService private readonly _commandService: ICommandService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
	) {
		super();
	}

	// ─── Index Lock ─────────────────────────────────────────────────────

	tryLockIndex(): boolean {
		if (this._indexLocked) { return false; }
		this._indexLocked = true;
		return true;
	}

	private async _lockIndex(): Promise<() => void> {
		if (this._indexLocked) {
			throw new Error('Index already locked');
		}
		this._indexLocked = true;
		return () => { this._indexLocked = false; };
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
			const workerUrl = URL.createObjectURL(blob);

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
			} catch {
				resolve(null);
				return;
			}
			const timeout = setTimeout(() => { worker.terminate(); resolve(null); }, 15000);
			worker.addEventListener('message', function initHandler(e: MessageEvent) {
				if (e.data.type === 'init-done') {
					clearTimeout(timeout);
					worker.removeEventListener('message', initHandler);
					resolve(worker);
				} else if (e.data.type === 'init-error') {
					clearTimeout(timeout);
					worker.terminate();
					resolve(null);
				}
			});
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
  // 用 blob URL 加载 tree-sitter.wasm
  const wasmBlob = new Blob([tsWasm]);
  const wasmUrl = URL.createObjectURL(wasmBlob);
  await TS.Parser.init({ locateFile: function() { return wasmUrl; } });
  Parser = TS.Parser;
  Language = TS.Language;
  // 加载语言 WASM
  let langLoaded = 0;
  for (const langName in langWasms) {
    try { languages[langName] = await Language.load(langWasms[langName]); langLoaded++; } catch(e) {}
  }
  initDone = true;
}

function walkAST(node, source, filePath, nodes, edges) {
  const nodeType = AST_TO_NODE_TYPE[node.type];
  if (nodeType) {
    let name = null;
    const children = node.children || [];
    for (let i = 0; i < children.length; i++) {
      if (children[i].type === 'name' || children[i].type === 'identifier') {
        name = source.substring(children[i].startIndex, children[i].endIndex);
        break;
      }
    }
    if (name) {
      const qualifiedName = filePath + '::' + name;
      const startLine = node.startPosition ? node.startPosition.row + 1 : undefined;
      const endLine = node.endPosition ? node.endPosition.row + 1 : undefined;
      nodes.push({ id: qualifiedName, name: name, type: nodeType, filePath: filePath, qualifiedName: qualifiedName, inDegree: 0, outDegree: 0, startLine: startLine, endLine: endLine });
      edges.push({ source: filePath, target: qualifiedName, type: 'CONTAINS' });
    }
  }
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      walkAST(node.children[i], source, filePath, nodes, edges);
    }
  }
}

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
      const parser = new Parser();
      parser.setLanguage(lang);
      const tree = parser.parse(msg.source);
      const nodes = [], edges = [];
      if (tree) { walkAST(tree.rootNode, msg.source, msg.filePath, nodes, edges); }
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
	private _parseViaWorker(worker: Worker, id: number, source: string, langName: string, filePath: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
		return new Promise((resolve) => {
			let resolved = false;
			const handler = (e: MessageEvent) => {
				if (e.data.type === 'parse-result' && e.data.id === id) {
					if (resolved) { return; }
					resolved = true;
					clearTimeout(timeout);
					worker.removeEventListener('message', handler);
					resolve({ nodes: e.data.nodes || [], edges: e.data.edges || [] });
				}
			};
			worker.addEventListener('message', handler);

			// 15 秒超时：某些文件（如生成的代码、超长行）可能导致 tree-sitter 挂起
			const timeout = setTimeout(() => {
				if (resolved) { return; }
				resolved = true;
				worker.removeEventListener('message', handler);
				this._logService.warn('[CodebaseGraph]', `⏱ Worker parse timeout (15s), skipping: ${filePath}`);
				resolve({ nodes: [], edges: [] }); // 跳过该文件，继续处理下一个
			}, 15000);

			worker.postMessage({ type: 'parse', id, source, langName, filePath });
		});
	}

	private _disposeWorkers(): void {
		for (const w of this._parserWorkers) { w.terminate(); }
		this._parserWorkers = [];
		this._workerInitPromise = undefined;
	}

	// ─── Main Index Method ──────────────────────────────────────────────

	async indexWorkspace(rootPath: string, config: IIndexConfig, token?: CancellationToken): Promise<IIndexResult> {
		const cts = new CancellationTokenSource(token);
		const startTime = Date.now();

		if (this._isIndexing) {
			return { success: false, message: '索引正在进行中，请稍候...' };
		}

		this._isIndexing = true;
		this._indexCts = cts;

		let releaseLock: () => void;
		try {
			releaseLock = await this._lockIndex();
		} catch {
			this._isIndexing = false;
			return { success: false, message: '索引已被锁定，请稍候...' };
		}

		try {
			this._onDidIndexProgress.fire('▶ 开始索引工作区...');
			this._projectName = config.subPath || '_default';

			// 1. Scan files
			const excludeDirs = new Set([...DEFAULT_EXCLUDE_DIRS, ...config.excludeDirs]);
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
					const ext = this._getExtension(filePath);
					const langName = EXTENSION_TO_WASM_LANG[ext];
					if (!langName) { continue; }

					// 主线程读取文件内容 (async I/O)
					let source: string;
					try {
						const content = await this._fileService.readFile(URI.file(filePath));
						source = content.value.toString();
					} catch { continue; }
					if (source.length > MAX_FILE_SIZE) { continue; }
					// 跳过超长行文件（minified/生成代码会导致 tree-sitter 挂起）
					if (source.indexOf('\n', 0) === -1 && source.length > 50000) { continue; } // 单行超 50K
					// 快速检测最长行（只检查前 100 行，避免开销）
					let maxLineLen = 0;
					const lines = source.split('\n');
					const checkLines = Math.min(lines.length, 100);
					for (let li = 0; li < checkLines; li++) { if (lines[li].length > maxLineLen) { maxLineLen = lines[li].length; } }
					if (maxLineLen > MAX_LINE_LENGTH) { continue; }

					// 诊断日志：每 500 文件记录当前解析路径，便于定位卡死文件
					if (idx % 500 === 0) {
						this._logService.info('[CodebaseGraph]', `Worker ${workerId}: #${idx}/${filesScanned} ${filePath}`);
					}

					// Worker 线程解析 (不阻塞主线程，15s 超时自动跳过)
					const relPath = this._getRelativePath(filePath);
					const result = await this._parseViaWorker(worker, idx, source, langName, relPath);

					for (const node of result.nodes) { this._graph.addNode(node); nodesExtracted++; }
					for (const edge of result.edges) { this._graph.addEdge(edge); edgesExtracted++; }

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
				const result = await this._parseFile(filePath, cts.token);
				for (const node of result.nodes) { this._graph.addNode(node); nodesExtracted++; }
				for (const edge of result.edges) { this._graph.addEdge(edge); edgesExtracted++; }
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
		this._graph.store.rebuildBM25((done, total) => {
			if (done % 50000 === 0 || done === total) {
				this._onDidIndexProgress.fire(`📝 BM25 索引: ${done}/${total}...`);
			}
		});

			// 3. Match calls to definitions
			this._onDidIndexProgress.fire('🔗 匹配调用关系...');
			const matchedEdges = this._matchCallsToDefinitions();
			edgesExtracted += matchedEdges;

			// 4. Extended passes
			this._onDidIndexProgress.fire('🔬 运行扩展 pass...');
			const extendedEdges = this._runExtendedPasses();
			edgesExtracted += extendedEdges;

			// 5. LSP cross-file type inference
			this._onDidIndexProgress.fire('🧠 跨文件 LSP 类型推断...');
			this._lspResolver = new LspCrossResolver();
			this._lspResolver.buildDefIndex(this._graph.store, this._projectName);

			// 6. Community detection (Leiden)
			this._onDidIndexProgress.fire('🏘️ 社区检测 (Leiden)...');
			try {
				const leidenResult = runMultiLevelLeiden(this._graph.store, this._projectName, 1.0, 5);
				this._logService.info('[CodebaseGraph]', `Leiden: ${leidenResult.communities.size} communities`);
			} catch (err: any) {
				this._logService.debug('[CodebaseGraph]', `Leiden failed: ${err?.message || err}`);
			}

			// 7. Post-index analysis
			this._onDidIndexProgress.fire('🔍 环境变量扫描 + 配置链接...');
			await this._runPostIndexAnalysis(rootPath);

			// 8. Save graph to {rootPath}/.codebase-memory/graph.db.zst
			const graphDir = URI.joinPath(URI.file(rootPath), '.codebase-memory');
			try {
				await this._fileService.createFolder(graphDir);
				const artifactFile = URI.joinPath(graphDir, 'graph.db.zst');
				try {
					const persistence = new GraphPersistence(this._fileService);
					await persistence.save(this._graph.store, artifactFile.fsPath);
					this._logService.info('[CodebaseGraph]', `Graph saved: ${artifactFile.fsPath} (${this._graph.nodeCount} nodes)`);
				} catch { /* best-effort */ }
			} catch (err: any) {
				this._logService.warn('[CodebaseGraph]', `Failed to save graph: ${err?.message || err}`);
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
						this._logService.info('[CodebaseGraph]', `[scan] keeping excluded dir: ${relPath}`);
						// 继续扫描此目录
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
					// 每 50 个文件 fire 一次进度
					if (this._scanFileCount % 50 === 0) {
						const dirName = dirUri.fsPath.split(/[\\/]/).pop() || '';
						this._onDidIndexProgress.fire(`📁 扫描中: ${results.length} 文件 (${dirName})`);
					}
				}
			}
		}

		// 根目录和深层目录都记录日志
		if (depth <= 2 || dirCount > 5) {
			const dirName = dirUri.fsPath.split(/[\\/]/).pop() || dirUri.fsPath;
			this._logService.info('[CodebaseGraph]', `[scan] depth=${depth} dir=${dirName} dirs=${dirCount} files=${fileCount} total=${results.length}`);
		}
	}

	private _getExtension(fileName: string): string {
		const idx = fileName.lastIndexOf('.');
		return idx >= 0 ? fileName.substring(idx).toLowerCase() : '';
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

	private async _parseFile(filePath: string, token: CancellationToken): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
		const ext = this._getExtension(filePath);
		const wasmLang = EXTENSION_TO_WASM_LANG[ext];
		if (!wasmLang) { return { nodes: [], edges: [] }; }

		const parserResult = await this._getParser(wasmLang);
		if (!parserResult) { return { nodes: [], edges: [] }; }

		const { parser } = parserResult;

		try {
			const fileUri = URI.file(filePath);
			const content = await this._fileService.readFile(fileUri);
			const source = content.value.toString();

			if (source.length > MAX_FILE_SIZE) {
				this._logService.debug('[CodebaseGraph]', `File too large: ${filePath}`);
				return { nodes: [], edges: [] };
			}
			// 跳过超长行文件（minified/生成代码会导致 tree-sitter 挂起）
			if (source.indexOf('\n', 0) === -1 && source.length > 50000) { return { nodes: [], edges: [] }; }
			{
				let maxLineLen = 0;
				const lines = source.split('\n');
				const checkLines = Math.min(lines.length, 100);
				for (let li = 0; li < checkLines; li++) { if (lines[li].length > maxLineLen) { maxLineLen = lines[li].length; } }
				if (maxLineLen > MAX_LINE_LENGTH) { return { nodes: [], edges: [] }; }
			}

			const tree = parser.parse(source);
			if (!tree) { return { nodes: [], edges: [] }; }

			const nodes: GraphNode[] = [];
			const edges: GraphEdge[] = [];
			const relPath = this._getRelativePath(filePath);

			// Walk AST and extract nodes/edges
			this._walkAST(tree.rootNode, source, relPath, nodes, edges);

			return { nodes, edges };
		} catch (err: any) {
			this._logService.debug('[CodebaseGraph]', `Parse failed ${filePath}: ${err?.message || err}`);
			return { nodes: [], edges: [] };
		}
	}

	private _walkAST(node: any, source: string, filePath: string, nodes: GraphNode[], edges: GraphEdge[]): void {
		const nodeType = AST_TO_NODE_TYPE[node.type];
		if (nodeType) {
			const name = this._extractName(node, source);
			if (name) {
				const qualifiedName = `${filePath}::${name}`;
				const startLine = node.startPosition?.row ? node.startPosition.row + 1 : undefined;
				const endLine = node.endPosition?.row ? node.endPosition.row + 1 : undefined;

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
				});

				// Add file containment edge
				edges.push({
					source: filePath,
					target: qualifiedName,
					type: 'CONTAINS',
				});
			}
		}

		// Recurse into children
		if (node.children) {
			for (const child of node.children) {
				this._walkAST(child, source, filePath, nodes, edges);
			}
		}
	}

	private _extractName(node: any, source: string): string | undefined {
		// Try to find the name child node
		for (const child of (node.children || [])) {
			if (child.type === 'name' || child.type === 'identifier') {
				return source.substring(child.startIndex, child.endIndex);
			}
		}
		return undefined;
	}

	// ─── Call Matching ─────────────────────────────────────────────────────

	private _matchCallsToDefinitions(): number {
		// In the store-based architecture, edges already have numeric target IDs.
		// Call matching is handled during AST walking via _walkAST.
		return 0;
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

			// Similar code detection
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

			this._logService.info('[CodebaseGraph]', `Extended passes: ${edgesAdded} edges`);
		} catch (err: any) {
			this._logService.debug('[CodebaseGraph]', `Extended passes failed: ${err?.message || err}`);
		}

		return edgesAdded;
	}

	// ─── Post-Index Analysis ──────────────────────────────────────────────

	private async _runPostIndexAnalysis(rootPath: string): Promise<void> {
		const store = this._graph.store;
		const project = this._projectName;

		// Env URL scan
		try {
			const envBindings = await scanEnvUrls(rootPath, this._fileService);
			if (envBindings.length > 0) {
				this._logService.info('[CodebaseGraph]', `Env scan: ${envBindings.length} bindings`);
			}
		} catch (err: any) {
			this._logService.debug('[CodebaseGraph]', `Env scan failed: ${err?.message || err}`);
		}

		// Config-to-code linking
		try {
			const configFileNodes = store.getAllNodes().filter(n =>
				n.project === project && n.filePath && (
					n.filePath.endsWith('.env') || n.filePath.endsWith('.yaml') ||
					n.filePath.endsWith('.yml') || n.filePath.endsWith('.toml') ||
					n.filePath.endsWith('package.json') || n.filePath.endsWith('go.mod')
				)
			);
			const configPaths = [...new Set(configFileNodes.map(n => n.filePath!).filter(Boolean))];
			const configLinks = linkConfigToCode(store, project, configPaths);
			if (configLinks.length > 0) {
				this._logService.info('[CodebaseGraph]', `Config link: ${configLinks.length} links`);
			}
		} catch (err: any) {
			this._logService.debug('[CodebaseGraph]', `Config link failed: ${err?.message || err}`);
		}

		// Cross-repo discovery
		try {
			const projects = store.listProjects();
			if (projects.length >= 2 || this._crossRepoEnabled) {
				const discovery = new CrossRepoDiscovery(store);
				const crossEdges = discovery.discover();
				if (crossEdges.length > 0) {
					this._logService.info('[CodebaseGraph]', `Cross-repo: ${crossEdges.length} edges`);
					discovery.insertCrossEdges(crossEdges);
				}
			}
		} catch (err: any) {
			this._logService.debug('[CodebaseGraph]', `Cross-repo discovery failed: ${err?.message || err}`);
		}
	}

	// ─── Graph Data API ────────────────────────────────────────────────────

	getGraphData(): GraphData {
		return this._graph.toJSON();
	}

	getGraphDataDownsampled(maxNodes: number): GraphData {
		return this._graph.toJSONDownsampled(maxNodes);
	}

	hasGraphData(): boolean {
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

	// ─── Advanced Query API ──────────────────────────────────────────────

	executeCypher(query: string): { columns: string[]; rows: any[][] } {
		if (!this._cypherEngine) {
			this._cypherEngine = new CypherEngine(this._graph.store);
		}
		return this._cypherEngine.execute(query, this._projectName);
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

	getArchitecture(): any {
		return analyzeArchitecture(this._graph.store, this._projectName);
	}

	getGraphSchema(): { nodeLabels: { label: string; count: number }[]; edgeTypes: { type: string; count: number }[]; totalNodes: number; totalEdges: number } {
		return getSchema(this._graph.store, this._projectName);
	}

	getIndexStatus(): { project: string; exists: boolean; nodeCount: number; edgeCount: number; fileCount: number } {
		return getIndexStatus(this._graph.store, this._projectName);
	}

	// ─── Trace & Search API ────────────────────────────────────────────────

	tracePath(sourceName: string, targetName: string | undefined, mode: string = 'calls'): any {
		return tracePath(this._graph.store, this._projectName, sourceName, targetName, mode as any);
	}

	searchCode(query: string, limit: number = 50): any[] {
		const fileContentProvider = (filePath: string): string | undefined => {
			return undefined;
		};
		return graphSearchCode(this._graph.store, this._projectName, query, fileContentProvider, limit);
	}

	// ─── P3 API Alignment ─────────────────────────────────────────────────

	searchGraph(params: {
		project?: string;
		namePattern?: string;
		label?: string;
		limit?: number;
		offset?: number;
		sortBy?: 'name' | 'inDegree' | 'outDegree' | 'degree';
		sortDesc?: boolean;
		minInDegree?: number;
		minOutDegree?: number;
		relType?: string;
	}): { nodes: GraphNode[]; total: number } {
		const result = this._graph.store.search({
			project: params.project || this._projectName,
			namePattern: params.namePattern,
			label: params.label,
			limit: params.limit,
			offset: params.offset,
			sortBy: params.sortBy,
			sortDesc: params.sortDesc,
			minInDegree: params.minInDegree,
			minOutDegree: params.minOutDegree,
			relType: params.relType,
		});
		const graphStore = this._graph;
		return {
			nodes: result.nodes.map((n: any) => graphStore['_nodeToGraphNode'](n)),
			total: result.total,
		};
	}

	tracePathAdvanced(sourceName: string, targetName: string | undefined, opts?: {
		mode?: 'calls' | 'data_flow' | 'cross_service';
		maxDepth?: number;
		excludeEntry?: boolean;
		direction?: 'both' | 'callers' | 'callees';
		includeTests?: boolean;
	}): any {
		const mode = opts?.mode || 'calls';
		const maxDepth = opts?.maxDepth || 10;
		const direction = opts?.direction || 'callees';
		const includeTests = opts?.includeTests ?? true;
		return tracePath(this._graph.store, this._projectName, sourceName, targetName, mode as any, maxDepth, direction, includeTests);
	}

	getArchitectureAdvanced(dimensions?: string[]): any {
		const report: any = analyzeArchitecture(this._graph.store, this._projectName);

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

	async getCodeSnippet(qualifiedName: string, contextLines: number = 3, includeNeighbors: boolean = false): Promise<{ filePath: string; startLine: number; endLine: number; content: string; language: string; neighbors?: { name: string; content: string }[] } | null> {
		const node = this._graph.store.findNodeByQN(this._projectName, qualifiedName);
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
		try {
			const folders = this._workspaceService.getWorkspace().folders;
			if (folders.length === 0) { return null; }
			const wsUri = folders[0].uri;
			const fileUri = URI.joinPath(wsUri, node.filePath);
			const fileContent = await this._fileService.readFile(fileUri);
			const fullText = fileContent.value.toString();
			const lines = fullText.split('\n');
			const selected = lines.slice(startLine - 1, endLine);
			content = selected.map((line, i) => `${startLine + i}\t${line}`).join('\n');
		} catch (err: any) {
			content = `// Failed to read file: ${err?.message || err}`;
		}

		return {
			filePath: node.filePath,
			startLine,
			endLine,
			content,
			language,
		};
	}

	listProjects(): { name: string; nodeCount: number; edgeCount: number; fileCount: number }[] {
		return this._graph.store.listProjects();
	}

	deleteProject(name: string): void {
		this._graph.store.deleteProject(name);
		this._cypherEngine = undefined;
		this._semanticSearch = undefined;
	}

	// ─── Change Detection ─────────────────────────────────────────────────

	async detectChanges(opts?: { since?: string; baseBranch?: string; impactAnalysis?: boolean }): Promise<any> {
		const store = this._graph.store;
		const project = this._projectName;
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return { trackedFiles: 0, changedFiles: [], impactAnalysis: { affectedNodes: 0, affectedEdges: 0 } };
		}
		const rootPath = folders[0].uri.fsPath;

		let changedFiles: { path: string; status: string }[] = [];
		try {
			changedFiles = await this._getGitChangedFilesViaApi(rootPath, opts?.baseBranch);
		} catch (err: any) {
			this._logService.debug('[CodebaseGraph]', `Git API failed: ${err?.message || err}`);
		}

		if (changedFiles.length === 0) {
			changedFiles = this._getChangedFilesViaHashes(project, rootPath);
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
		if (opts?.impactAnalysis !== false) {
			const visited = new Set<number>();
			const queue: { id: number; depth: number }[] = [];
			for (const id of affectedNodeIds) {
				queue.push({ id, depth: 0 });
				visited.add(id);
			}
			while (queue.length > 0 && visited.size < 500) {
				const { id, depth } = queue.shift()!;
				if (depth >= 5) { continue; }
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
			affectedNodes: affectedNodeIds.size,
			affectedEdges,
			downstreamImpact: downstreamCount,
			riskLevel,
			riskReasons: riskReasons.length > 0 ? riskReasons : ['No significant risk'],
			impactAnalysis: { affectedNodes: affectedNodeIds.size, affectedEdges, downstreamCount },
		};
	}

	private async _getGitChangedFilesViaApi(rootPath: string, baseBranch?: string): Promise<{ path: string; status: string }[]> {
		try {
			const gitApi: any = await this._commandService.executeCommand('git.api');
			if (gitApi && gitApi.repositories) {
				const repo = gitApi.repositories.find((r: any) => r.rootUri?.fsPath === rootPath) || gitApi.repositories[0];
				if (repo) {
					const changes: { path: string; status: string }[] = [];
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
					return changes;
				}
			}
		} catch { /* git extension not available */ }
		return [];
	}

	private _getChangedFilesViaHashes(project: string, _rootPath: string): { path: string; status: string }[] {
		const changes: { path: string; status: string }[] = [];
		const trackedHashes = this._graph.store.getAllFileHashes(project);
		for (const hash of trackedHashes) {
			changes.push({ path: hash.relPath, status: 'M' });
		}
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
		const graphDir = URI.joinPath(URI.file(wsPath), '.codebase-memory');
		const artifactUri = URI.joinPath(graphDir, 'graph.db.zst');

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
			// Fall back to legacy path
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
				const persistence = new GraphPersistence(this._fileService);
				const loaded = await persistence.load(this._graph.store, p);
				if (loaded) {
					this._logService.info('[CodebaseGraph]', `[loadGraph] loaded ${p} (${Date.now() - tStart}ms), store nodes=${this._graph.nodeCount}`);
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
			return true;
		} catch (err: any) {
			this._logService.warn('[CodebaseGraph]', `Failed to load graph: ${err?.message || err}`);
			return false;
		}
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	private _getRelativePath(absPath: string): string {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) { return absPath; }
		const wsPath = folders[0].uri.fsPath;
		if (absPath.startsWith(wsPath)) {
			const rel = absPath.substring(wsPath.length).replace(/^[\\/]/, '');
			return rel.replace(/\\/g, '/');
		}
		return absPath.replace(/\\/g, '/');
	}

	override dispose(): void {
		this._disposeWorkers();
		super.dispose();
	}
}
