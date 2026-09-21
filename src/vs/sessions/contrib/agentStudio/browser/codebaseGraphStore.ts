/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Enhanced Graph Store — 带多级哈希索引、BM25 全文搜索、文件哈希追踪的内存图存储。
 *
 * 对标 codebase-memory-mcp 的 SQLite + FTS5 方案，但使用纯 TypeScript 实现，
 * 无需外部依赖（sql.js），在 VS Code renderer 中直接运行。
 *
 * 核心改进（相比旧 GraphStore）：
 * 1. 多级索引：by id / by qualified_name / by file_path / by label → O(1) 查找
 * 2. BM25 全文搜索：camelCase/snake_case 感知分词 + 倒排索引
 * 3. 文件哈希：SHA-256 + mtime → 增量索引
 * 4. 边去重：HashSet O(1) 而非线性扫描 O(n)
 * 5. 社区分配：Leiden 社区检测结果存储
 */

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { isAbsoluteGraphPath } from '../common/codebaseIndexDefaults.js';
import { SLICE_CHECK_EVERY, sliceBudgetExceeded, yieldToEventLoop } from '../common/asyncSlice.js';

/**
 * 解析 searchCode / get_code_snippet 读取文件时用的 URI。
 *
 * C 版 graph.db.zst 把节点的 filePath 存成【绝对路径】（如
 * "F:/GR_qiuzijian_main/UE5EA/Engine/Source/Runtime/CoreUObject/GarbageCollection.cpp"）。
 * 若直接 URI.joinPath(rootUri, absolutePath)，URI.joinPath 会把绝对路径当成相对路径
 * 拼接到工作区根之后，生成形如
 * "f:/GR_qiuzijian_main/S1Game/F:/GR_qiuzijian_main/UE5EA/..." 的垃圾路径，
 * 导致 _fileService.exists() 永远返回 false、文件内容永远读不到，search_code 静默返回
 * "no matches found"（即使磁盘上该绝对路径真实存在）。
 *
 * 因此：绝对路径（Windows 盘符 / *nix 根）直接用 URI.file 解析；相对路径才 joinPath(rootUri)。
 */
export function resolveSearchFileUri(rootUri: URI | undefined, filePath: string): URI {
	const isAbsolute = /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('/');
	if (isAbsolute) {
		return URI.file(filePath);
	}
	if (rootUri) {
		return URI.joinPath(rootUri, filePath);
	}
	return URI.file(filePath);
}

/**
 * 解析 searchCode / get_code_snippet 读取文件时的【候选 URI 列表】（多 workspace folder 兼容）。
 *
 * 工作区可能含多个 folder（如 S1Game + UE5EA 两个独立根）。C 版 graph.db.zst 的 filePath：
 *  - 绝对路径（Windows 盘符 / *nix 根）→ 直接用 URI.file 解析（单候选，忽略 folder 列表）
 *  - 相对路径 → 依次拼接每个 workspace folder，调用方取第一个 exists() 的
 *    （UE5EA 引擎文件相对路径相对 UE5EA 根，只有依次尝试各 folder 才能命中）
 *
 * @param rootUris 所有 workspace folder 的根 URI（顺序敏感，folder[0] 优先）
 * @param filePath 图中节点的 filePath
 * @returns 候选 URI 列表（绝对路径为单元素；相对路径为「每个 folder 拼接」的列表）
 */
export function resolveSearchFileCandidates(rootUris: URI[], filePath: string): URI[] {
	const isAbsolute = /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('/');
	if (isAbsolute) {
		return [URI.file(filePath)];
	}
	if (rootUris.length === 0) {
		return [URI.file(filePath)];
	}
	return rootUris.map(r => URI.joinPath(r, filePath));
}


// ─── Memory-safety constants (Phase 0: 对齐 codebase-memory-mcp 的 limits/预算闸) ──
/** 单次 search 最多返回的节点数，防止无界结果撑爆内存（对齐 C 版 max_results） */
export const GRAPH_HARD_RESULT_CAP = 2000;
/** includeConnected / BFS 遍历的最大跳数，防止循环图无界展开（对齐 C 版 CBM_MCP_MAX_DEPTH=15） */
export const GRAPH_MAX_BFS_DEPTH = 15;
/** 超过此节点数时跳过事务整库快照，避免索引期 toJSON 2x 峰值 */
const GRAPH_TX_SNAPSHOT_NODE_THRESHOLD = 50_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GraphNode {
	id: number;
	project: string;
	label: string;           // Function, Class, Method, Module, File, Interface, Route...
	name: string;
	qualifiedName: string;
	filePath?: string;
	startLine?: number;
	endLine?: number;
	properties?: Record<string, any>;
	inDegree: number;
	outDegree: number;
	community?: number;      // Leiden 社区 ID
	type?: string;           // 节点类型别名（与 label 对齐，便于跨模块统一访问）
}

export interface GraphEdge {
	id: number;
	project: string;
	sourceId: number;
	targetId: number;
	type: string;            // CALLS, IMPORTS, DEFINES, IMPLEMENTS, HTTP_CALLS...
	properties?: Record<string, any>;
}

/**
 * `mergeFromJSONAsync` 的合并统计（2026-09-15）。
 *
 * 为什么要把「跳过数」暴露出来：重复节点曾长期**完全静默**——
 * 实测本仓制品 `graph.db.zst` 里 358,887 个节点去重后只有 180,753（**49.6% 冗余**，每条 qn 出现 2 次），
 * 成因是同一制品被重复合并（bootstrap 并发 / 工作区切换），而旧实现无条件 `_nextNodeId++` 追加。
 * 后果链：内存项目节点数翻倍 → `_ensureSqliteFreshness` 恒判「sqlite 落后」（36 万 vs 17.6 万）
 * → 每次查询都触发全量重同步 → 查询与写事务竞争（实测单次检索 2.3s 且候选残缺）。
 * 故合并必须幂等，且**跳过数要能被调用方记进日志**。
 */
export interface IGraphMergeStats {
	/** 实际新增的节点数 */
	nodesAdded: number;
	/** 因 `(project, qualifiedName)` 已存在而**跳过**的节点数（重复合并 / 制品自带重复） */
	nodesSkipped: number;
	edgesAdded: number;
	edgesSkipped: number;
}

export interface FileHash {
	project: string;
	relPath: string;
	sha256: string;
	mtimeNs: number;
	size: number;
	/**
	 * ★★ 2026-09-21：**这是「解析失败后放弃重试」的哈希，不是「成功索引过」的哈希**。
	 *
	 * 为什么必须区分（真机 2026-09-21，安装版 UE 工作区）：
	 * `shouldRecordHashAfterParse` 在 `parse_error`/`timeout` 达 `PARSE_FAIL_RETRY_MAX(3)` 次后
	 * **也会记哈希**（为停止"每轮重报 added"的翻烧饼 ✓）—— 但这些文件**没有任何节点** ✗。
	 * 而健康度判据用 `节点数 / 哈希数 < 2` ⇒ 把"放弃的哈希"当成"成功索引过的文件" ⇒
	 * 大仓出现 `4547 节点 / 95532 哈希` 被判**残缺** ⇒ 触发 **95k 文件全量重索引**（内存暴涨、
	 * 与解析期看门狗 abort 互相打架 ✗✗）。
	 *
	 * 两条语义必须分开（本字段就是分界线）：
	 *   · **增量分类基线**（`hasBaseline` / classifyFiles）⇒ 必须**含** gaveUp（否则每轮重报 added ✗）；
	 *   · **健康度 / 残缺判据** ⇒ 必须**只算**非 gaveUp（否则把放弃当成功 ✗✓）。
	 * 缺省 `undefined` = 成功路径（旧制品无此字段 ⇒ 自动按成功读 ✓ 向后兼容）。
	 */
	gaveUp?: boolean;
}

export interface SearchParams {
	project?: string;
	query?: string;            // (P0) BM25 全文搜索 — 自然语言查询, 驼峰分词感知
	namePattern?: string;     // regex
	/**
	 * 只匹配 `name`（不匹配 `qualifiedName`），2026-09-15。
	 *
	 * 为什么需要：QN 形如 `<相对文件路径>::<符号名>` ⇒ 或匹配会把**文件路径里的词**也算命中
	 * —— Find Symbol 搜 `test` 会返回 `classifyLLM.test.ts::MockClassifyLLM`（用户截图报障）。
	 * 注意这是**符号名检索**的语义（Find Symbol）；`search_graph` 的 `query` 走 BM25 路径不受影响。
	 */
	nameOnly?: boolean;
	qnPattern?: string;       // (P1) qualified name regex
	label?: string;            // node type filter
	excludeLabels?: string[];  // (P1) exclude these node types
	filePattern?: string;     // glob
	minInDegree?: number;
	maxInDegree?: number;
	minOutDegree?: number;
	maxOutDegree?: number;
	relType?: string;
	relDirection?: 'out' | 'in' | 'both';
	sortBy?: 'name' | 'inDegree' | 'outDegree' | 'degree';
	sortDesc?: boolean;
	caseSensitive?: boolean;       // (P1) case-sensitive matching
	includeConnected?: boolean;    // (P1) include directly connected nodes
	limit?: number;
	offset?: number;
	/** BFS / includeConnected 遍历最大跳数（默认 GRAPH_MAX_BFS_DEPTH，防止循环图无界展开） */
	maxDepth?: number;
}

export interface SearchResult {
	nodes: GraphNode[];
	total: number;
	/** 当 query (BM25) 路径时附带 BM25 评分 (nodeId → score) */
	scores?: Map<number, number>;
	/** 当 total > nodes.length 时, 表示还有更多结果可用 offset+limit pagination */
	hasMore?: boolean;
}

// ─── BM25 Full-Text Search ───────────────────────────────────────────────────

/**
 * 轻量级 BM25 搜索引擎。
 * 分词器：camelCase/snake_case 感知（"getUserInfo" → ["get", "user", "info"]）
 */
class BM25Index {
	private _invertedIndex: Map<string, Set<number>> = new Map();  // term → node IDs
	private _docLengths: Map<number, number> = new Map();            // nodeId → token count
	private _avgDocLength = 0;
	private _docCount = 0;
	private readonly _k1 = 1.5;
	private readonly _b = 0.75;

	/** camelCase/snake_case 感知分词 */
	static tokenize(text: string): string[] {
		if (!text) { return []; }
		// Split on: camelCase boundaries, snake_case, kebab-case, non-alphanumeric
		const words = text
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')  // camelCase → "camel Case"
			.replace(/[_\-\.\/\\]/g, ' ')               // snake/kebab/path → space
			.split(/\s+/)
			.filter(w => w.length > 0)
			.map(w => w.toLowerCase());
		return words;
	}

	addDocument(nodeId: number, text: string): void {
		const terms = BM25Index.tokenize(text);
		this._docLengths.set(nodeId, terms.length);
		this._docCount++;
		this._avgDocLength = (this._avgDocLength * (this._docCount - 1) + terms.length) / this._docCount;

		const seen = new Set<string>();
		for (const term of terms) {
			if (seen.has(term)) { continue; }
			seen.add(term);
			if (!this._invertedIndex.has(term)) {
				this._invertedIndex.set(term, new Set());
			}
			this._invertedIndex.get(term)!.add(nodeId);
		}
	}

	removeDocument(nodeId: number): void {
		const length = this._docLengths.get(nodeId);
		if (length === undefined) { return; }
		this._docLengths.delete(nodeId);
		this._docCount = Math.max(0, this._docCount - 1);
		// Remove from inverted index
		for (const [term, ids] of this._invertedIndex) {
			if (ids.delete(nodeId) && ids.size === 0) {
				this._invertedIndex.delete(term);
			}
		}
	}

	search(query: string, limit: number = 50): Map<number, number> {
		const queryTerms = BM25Index.tokenize(query);
		if (queryTerms.length === 0) { return new Map(); }

		const scores: Map<number, number> = new Map();
		const N = this._docCount;

		for (const term of queryTerms) {
			const docIds = this._invertedIndex.get(term);
			if (!docIds || docIds.size === 0) { continue; }

			const df = docIds.size;
			const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

			for (const docId of docIds) {
				const docLen = this._docLengths.get(docId) || 0;
				const tf = 1; // Since we store unique terms, tf = 1 per term per doc
				const norm = 1 - this._b + this._b * (docLen / (this._avgDocLength || 1));
				const score = idf * (tf * (this._k1 + 1)) / (tf + this._k1 * norm);
				scores.set(docId, (scores.get(docId) || 0) + score);
			}
		}

		// Sort by score descending
		const sorted = new Map([...scores.entries()].sort((a, b) => b[1] - a[1]));
		const result = new Map<number, number>();
		let count = 0;
		for (const [id, score] of sorted) {
			if (count >= limit) { break; }
			result.set(id, score);
			count++;
		}
		return result;
	}

	clear(): void {
		this._invertedIndex.clear();
		this._docLengths.clear();
		this._avgDocLength = 0;
		this._docCount = 0;
	}

	toJSON(): any {
		return {
			invertedIndex: Array.from(this._invertedIndex.entries()).map(([k, v]) => [k, Array.from(v)]),
			docLengths: Array.from(this._docLengths.entries()),
			avgDocLength: this._avgDocLength,
			docCount: this._docCount,
		};
	}

	fromJSON(data: any): void {
		this._invertedIndex = new Map(data.invertedIndex.map(([k, v]: [string, number[]]) => [k, new Set(v)]));
		this._docLengths = new Map(data.docLengths);
		this._avgDocLength = data.avgDocLength || 0;
		this._docCount = data.docCount || 0;
	}
}

// ─── Graph Store ─────────────────────────────────────────────────────────────

export class CodebaseGraphStore {
	// Node storage
	private _nodes: Map<number, GraphNode> = new Map();
	private _nextNodeId = 1;

	/**
	 * 分配下一个节点 id（2026-09-09）。
	 * GraphStore._toNumId 原用「自身映射表 size+1」分配——加载恢复后映射表为空
	 * （字符串→数字映射不持久化），而 store 已有 17.5w 节点 → 新节点 id 从 1 开始
	 * **覆盖已有节点** → 后续删除制造悬空 QN 键 → upsertNode 崩溃 + 图数据污染。
	 * 统一从 store 的 _nextNodeId 分配，与持久化恢复的计数器天然衔接。
	 */
	allocNodeId(): number {
		return this._nextNodeId++;
	}

	// Edge storage
	private _edges: Map<number, GraphEdge> = new Map();
	private _nextEdgeId = 1;
	/**
	 * ★★★ 2026-09-18（**堆优化重做**）：**数值键**边去重表。
	 *
	 * 原实现是 `Set<string>`，每条边都要新建一个 `"sourceId:targetId:type"` 字符串 ⇒
	 * 用户堆快照里 **Set 表 ~10MB + 键字符串 ~20MB**（合计约 30MB 纯实现开销 ✗）。
	 * 现改为 `sourceId → Set<targetId * EDGE_TYPE_SPACE + typeId>`：键是数字 ⇒ **零字符串分配** ✓。
	 *
	 * ⚠ 契约不变：`insertEdge` 与 `mergeFromJSONAsync` 必须**同口径**去重
	 * （历史缺陷：merge 直接写 `_edges` 绕过去重 ⇒ 重复合并让边翻倍 ✗）⇒ 两处都走 `_edgeDedupAdd` ✓。
	 */
	private _edgeDedup: Map<number, Set<number>> = new Map();
	/** 边类型 → 数值 id（首次见到时分配；窗口内唯一即可，与持久化无关）。 */
	private _edgeTypeIds: Map<string, number> = new Map();
	/** 数值键的类型空间：`targetId * EDGE_TYPE_SPACE + typeId`（targetId 可达百万 ⇒ 2^40，JS number 精确 ✓）。 */
	private static readonly EDGE_TYPE_SPACE = 1 << 20;

	/** 边类型的数值 id —— 取代「为去重键拼字符串」的分配 ✓。 */
	private _edgeTypeIdOf(type: string): number {
		let id = this._edgeTypeIds.get(type);
		if (id === undefined) { id = this._edgeTypeIds.size; this._edgeTypeIds.set(type, id); }
		return id;
	}

	/** 打包数值键：`sourceId → (targetId, typeId)`。 */
	private _edgeKey(targetId: number, typeId: number): number {
		return targetId * CodebaseGraphStore.EDGE_TYPE_SPACE + typeId;
	}

	/** 去重表查询（`true` = 该边已存在，调用方应跳过）。 */
	private _edgeDedupHas(sourceId: number, targetId: number, type: string): boolean {
		return this._edgeDedup.get(sourceId)?.has(this._edgeKey(targetId, this._edgeTypeIdOf(type))) === true;
	}

	/** 去重表登记（**幂等**；顺带保证 source 子表存在）。 */
	private _edgeDedupAdd(sourceId: number, targetId: number, type: string): void {
		let set = this._edgeDedup.get(sourceId);
		if (!set) { set = new Set<number>(); this._edgeDedup.set(sourceId, set); }
		set.add(this._edgeKey(targetId, this._edgeTypeIdOf(type)));
	}

	/** 去重表移除（删边用）；子表空时一并删掉 source 键，避免无界堆积 ✗。 */
	private _edgeDedupDelete(sourceId: number, targetId: number, type: string): void {
		const set = this._edgeDedup.get(sourceId);
		if (!set) { return; }
		set.delete(this._edgeKey(targetId, this._edgeTypeIdOf(type)));
		if (set.size === 0) { this._edgeDedup.delete(sourceId); }
	}

	// Multi-level indices
	private _nodesByQN: Map<string, number> = new Map();       // project:qualifiedName → nodeId
	private _nodesByFile: Map<string, number[]> = new Map();   // project:filePath → nodeIds[]
	private _nodesByLabel: Map<string, number[]> = new Map();  // project:label → nodeIds[]
	private _outEdges: Map<number, number[]> = new Map();     // nodeId → edgeIds[]
	private _inEdges: Map<number, number[]> = new Map();      // nodeId → edgeIds[]

	// File hashes for incremental indexing
	private _fileHashes: Map<string, FileHash> = new Map();    // project:relPath → FileHash

	// BM25 full-text index
	private _bm25: BM25Index = new BM25Index();
	// 延迟 BM25 索引：批量写入时跳过逐条 addDocument，最后一次性重建
	private _deferBM25 = false;

	/**
	 * ★★★ 2026-09-18（P0 性能）：**BM25 处于「载入时已跳过、待按需构建」状态**。
	 *
	 * 背景（真机实测）：sqlite/FTS5 后端默认启用（`_sqliteBackendEnabled`），检索走
	 * `_sqliteBackend.searchNodes`（FTS5）；内存倒排**只在回退路径**上被用到。但载入制品 /
	 * 从 SQLite 按需载入 / 全量索引收尾时，旧实现**无条件**全量重建内存倒排 ⇒ 真机
	 * `BM25 重建=9137ms`、期间看门狗报 `⛔ 主线程阻塞 ≈2393ms`，且每条路径都付一遍 ✗✗。
	 *
	 * 现在：载入/索引只置本标记；首次真要**自由文本**检索时才按需重建（`_rebuildBM25OrDefer` /
	 * `_ensureInMemoryBm25`），且同步入口在标记期间**降级为子串扫描**（见 `search()`）——
	 * 绝不静默返回空结果 ✗。
	 *
	 * 契约：置位 = 载入/索引路径；`rebuildBM25()` **成功**后清除（异常保留，索引可能只建一半）；
	 * 只用 `namePattern`（正则）/ `label`（标签索引）的检索**不经** BM25 ⇒ 与本标记无关。
	 */
	private _bm25Deferred = false;
	/**
	 * Defer 期间累积的 BM25 脏集：需（重新）建索引的节点 id + 需移除的节点 id。
	 *
	 * 存在意义：增量索引只改了少数文件，旧实现却在 defer 结束后 `clear()` + 遍历
	 * **全图**（12.4w 节点）重建倒排——O(全图) 且是 renderer 冻结的主因之一。
	 * 有了脏集就能只对真正变动的节点做增删改，把 O(全图) 降为 O(变更集)。
	 *
	 * 仅在 _deferBM25===true 期间累积；setDeferBM25(false) 前由 rebuildBM25 消费并清空。
	 * 保守设计：任一环节不确定时调用方可走 rebuildBM25(true) 强制全量。
	 */
	private _bm25DirtyAdded = new Set<number>();
	private _bm25DirtyRemoved = new Set<number>();

	/**
	 * 构建 BM25 索引文本（对齐 C 版 FTS5 索引范围：name + qn + filePath + signature + docstring + ...）
	 * 扩展索引使 search_graph 能匹配函数签名中的参数名、返回类型等，而非仅匹配节点名。
	 */
	private _buildBM25Text(node: GraphNode): string {
		const parts: string[] = [node.name, node.qualifiedName];
		if (node.filePath) { parts.push(node.filePath); }
		if (node.properties) {
			// 索引常见属性字段（对齐 C 版 FTS5 索引列）
			const propKeys = ['signature', 'docstring', 'returnType', 'paramTypes', 'return_type', 'param_types', 'doc'];
			for (const key of propKeys) {
				const val = node.properties[key];
				if (typeof val === 'string' && val.length > 0) { parts.push(val); }
				else if (Array.isArray(val)) { parts.push(val.join(' ')); }
			}
		}
		return parts.join(' ');
	}


	// Layout cache
	private _layout: Map<number, { x: number; y: number; z: number }> = new Map();

	// ─── Node Operations ──────────────────────────────────────────────────

	/**
	 * filePath 契约违规集合（写入了绝对路径而非项目相对路径）。
	 * 见 isAbsoluteGraphPath——生产写入路径已修，此处仅做运行时检测供健康度暴露，防回归。
	 */
	private _absPathViolations = new Set<string>();

	/** 契约违规数量（绝对路径 filePath 的不同取值个数）。 */
	getAbsPathViolationCount(): number {
		return this._absPathViolations.size;
	}

	/** 契约违规样本（最多 n 条，供日志/诊断展示）。 */
	getAbsPathViolationSample(n: number = 5): string[] {
		return [...this._absPathViolations].slice(0, n);
	}

	/** QN 悬空键自愈计数（_nodesByQN 命中但节点不存在——索引不一致的信号）。 */
	private _qnDanglingHealed = 0;
	getQnDanglingHealedCount(): number {
		return this._qnDanglingHealed;
	}

	upsertNode(node: Omit<GraphNode, 'id' | 'inDegree' | 'outDegree'> & { id?: number }): GraphNode {
		if (node.filePath && isAbsoluteGraphPath(node.filePath)) {
			this._absPathViolations.add(node.filePath);
		}
		const qnKey = `${node.project}:${node.qualifiedName}`;
		const existingId = this._nodesByQN.get(qnKey);
		// ★ 防御自愈（2026-09-09，用户堆栈实锤崩溃点）：_nodesByQN 命中但 _nodes 无对应
		// 节点（索引不一致，如 id 分配冲突覆盖后又被删除）→ 旧代码 `this._nodes.get(existingId)!`
		// 非空断言直接崩（`existing.inDegree`）。改为按新建处理：键将被下方 Create 分支的
		// set 覆盖，自愈一致；计数暴露供健康度监测不一致频率。
		const existing = existingId !== undefined ? this._nodes.get(existingId) : undefined;
		if (existingId !== undefined && !existing) {
			this._qnDanglingHealed++;
			this._nodesByQN.delete(qnKey);
		}

		if (existing) {
			// Update existing node（existingId 已由上方守卫确保非 undefined 且节点存在）
			const updated: GraphNode = {
				...existing,
				...node,
				id: existingId!,
				inDegree: existing.inDegree,
				outDegree: existing.outDegree,
			};
			this._nodes.set(existingId!, updated);
			// Update BM25 index (skip if deferred — defer 期间只记脏集，结束由 rebuildBM25 增量处理)
			if (!this._deferBM25) {
				this._bm25.removeDocument(existingId!);
				this._bm25.addDocument(existingId!, this._buildBM25Text(updated));
			} else {
				this._bm25DirtyAdded.add(existingId!);
				this._bm25DirtyRemoved.delete(existingId!);
			}
			return updated;
		}

		// Create new node
		const id = node.id ?? this._nextNodeId++;
		const newNode: GraphNode = {
			...node,
			id,
			inDegree: 0,
			outDegree: 0,
		};
		this._nodes.set(id, newNode);
		this._nodesByQN.set(qnKey, id);

		// Update file index
		if (node.filePath) {
			const fileKey = `${node.project}:${node.filePath}`;
			const arr = this._nodesByFile.get(fileKey) || [];
			arr.push(id);
			this._nodesByFile.set(fileKey, arr);
		}

		// Update label index
		const labelKey = `${node.project}:${node.label}`;
		const labelArr = this._nodesByLabel.get(labelKey) || [];
		labelArr.push(id);
		this._nodesByLabel.set(labelKey, labelArr);

		// Add to BM25 index (skip if deferred — will be rebuilt in batch later)
		if (!this._deferBM25) {
			this._bm25.addDocument(id, this._buildBM25Text(newNode));
		} else {
			this._bm25DirtyAdded.add(id);
			this._bm25DirtyRemoved.delete(id);
		}

		return newNode;
	}

	upsertNodeBatch(nodes: Parameters<typeof this.upsertNode>[0][]): GraphNode[] {
		return nodes.map(n => this.upsertNode(n));
	}

	/**
	 * 开启/关闭 BM25 延迟模式：批量写入时跳过逐条索引更新，最后 rebuildBM25() 一次性构建。
	 *
	 * 开启时清空脏集，确保本轮只累积「开启之后」的变更——defer 开启前的写入已直接落到
	 * BM25（未记脏），若不清空会把上一轮残留的脏 id 混入本轮，导致重复/错误处理。
	 */
	setDeferBM25(defer: boolean): void {
		if (defer && !this._deferBM25) {
			this._bm25DirtyAdded.clear();
			this._bm25DirtyRemoved.clear();
		}
		this._deferBM25 = defer;
	}

	/** 见 `_bm25Deferred` 字段注释：标记「载入/索引时跳过全量重建 ⇒ 自由文本检索前需按需重建」。 */
	markBM25Deferred(): void {
		this._bm25Deferred = true;
	}

	/** 见 `_bm25Deferred` 字段注释。 */
	get isBM25Deferred(): boolean {
		return this._bm25Deferred;
	}

	/**
	 * ★ 2026-09-18（P0 性能）：`_bm25` 处于「待按需重建」时，`search({query})` 的**降级打分** ——
	 * 子串扫描 name/qualifiedName，按命中强度给分（不阻塞、不建索引）。
	 *
	 * 为什么必须降级而不是返回空：同步 `search()` 一旦静默 0 结果，调用方无法区分「真没有」
	 * 与「索引还没建」✗（本仓已多次栽在这类静默失效上）。生产侧自由文本检索实际都走
	 * `CodebaseGraphService.searchGraphAsync` 的 FTS5 路径，本降级只服务同步兜底调用。
	 */
	private _degradedSubstringScores(query: string, limit: number): Map<number, number> {
		const q = query.toLowerCase();
		const scores = new Map<number, number>();
		if (!q) { return scores; }
		for (const n of this._nodes.values()) {
			const name = (n.name || '').toLowerCase();
			const qn = (n.qualifiedName || '').toLowerCase();
			let s = 0;
			if (name === q) { s = 100; } else if (name.startsWith(q)) { s = 50; } else if (name.includes(q)) { s = 20; }
			if (qn.includes(q)) { s += 5; }
			if (s > 0) { scores.set(n.id, s); }
		}
		if (scores.size <= limit) { return scores; }
		// 与 BM25 路径的 oversample 口径一致：只留得分最高的 limit 条
		return new Map([...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit));
	}

	/**
	 * 批量重建 / 增量刷新 BM25 索引（在 setDeferBM25(true) ... 写入 ... 之后调用）。
	 *
	 * **增量模式（默认，force=false）**：只处理 defer 期间累积的脏集（_bm25DirtyAdded /
	 * _bm25DirtyRemoved），复杂度 O(变更集) 而非 O(全图)。
	 * 背景：增量索引只改了少数文件，旧实现却 `clear()` + 遍历全图（12.4w 节点）重建，
	 * 是 renderer 冻结的主因之一（2026-08-27）。
	 *
	 * **全量模式（force=true）**：清空后遍历全图重建。用于加载制品（fromJSON）等
	 * 本就没有脏集、或索引可能整体失效的场景。
	 *
	 * 两种模式都带时间切片（YIELD_EVERY）。直接迭代 Map.values() 而非 Array.from
	 * 全量副本，降低大图内存峰值。
	 */
	async rebuildBM25(onProgress?: (done: number, total: number) => void, force: boolean = false): Promise<void> {
		// ★ 2026-09-18（P0 性能）：**公开壳 + 私有实现** —— 本体有 3 处出口（增量空转 / 增量完成 /
		// 全量完成）⇒ 用一处 try/catch 统一收口「建成即解除待按需重建标记」，避免逐出口补漏 ✗。
		try {
			await this._rebuildBM25Impl(onProgress, force);
			// 仅在**成功**时解除（见 `_bm25Deferred`）；异常时索引可能只建了一半，仍视为「待建」。
			this._bm25Deferred = false;
		} catch (err) {
			throw err;
		}
	}

	private async _rebuildBM25Impl(onProgress?: (done: number, total: number) => void, force: boolean = false): Promise<void> {
		// ★ 2026-09-15：让出策略从**固定每 1000 节点**（更早是 5000）改为**按时间预算**
		// （`SLICE_BUDGET_MS` = 8ms，见 `common/asyncSlice.ts`）。
		//
		// 为什么固定条数不够：单节点建索引是微秒级，但单次连续占用会随「节点文本长度 /
		// 机器快慢」浮动 —— 大节点（长签名、长 filePath）或慢机器下 1000 个也能累到几十毫秒
		// ⇒ 用户看到的是可感知的抽搐式卡顿。时间预算则自动适配。
		let sliceStart = performance.now();

		// ── 增量模式：只处理脏集 ──
		if (!force) {
			const added = [...this._bm25DirtyAdded];
			const removed = [...this._bm25DirtyRemoved];
			this._bm25DirtyAdded.clear();
			this._bm25DirtyRemoved.clear();

			if (added.length === 0 && removed.length === 0) {
				// 无变更：直接返回，避免无谓的全图遍历（零变更增量索引会走到这里）
				if (onProgress) { onProgress(0, 0); }
				return;
			}

			// 先删后加：同一 id 既在 removed 又在 added 时，保证最终状态为「已加」
			// （脏集累积时已做互斥清理，此处为双保险）
			let done = 0;
			for (const id of removed) {
				if (this._bm25DirtyAdded.has(id)) { continue; }
				this._bm25.removeDocument(id);
				if ((++done % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
					if (onProgress) { onProgress(done, removed.length + added.length); }
					await yieldToEventLoop();
					sliceStart = performance.now();
				}
			}
			sliceStart = performance.now();
			for (const id of added) {
				const n = this._nodes.get(id);
				if (!n) { continue; } // 节点在 defer 期间又被删掉了
				this._bm25.removeDocument(id); // 幂等：先清旧文档再重新加入（更新场景）
				this._bm25.addDocument(id, this._buildBM25Text(n));
				if ((++done % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
					if (onProgress) { onProgress(done, removed.length + added.length); }
					await yieldToEventLoop();
					sliceStart = performance.now();
				}
			}
			if (onProgress) { onProgress(done, removed.length + added.length); }
			return;
		}

		// ── 全量模式 ──
		this._bm25DirtyAdded.clear();
		this._bm25DirtyRemoved.clear();
		this._bm25.clear();
		const total = this._nodes.size;
		let done = 0;
		sliceStart = performance.now();
		for (const n of this._nodes.values()) {
			this._bm25.addDocument(n.id, this._buildBM25Text(n));
			if ((++done % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
				if (onProgress) { onProgress(done, total); }
				await yieldToEventLoop();
				sliceStart = performance.now();
			}
		}
		if (onProgress) { onProgress(total, total); }
	}

	getNode(id: number): GraphNode | undefined {
		return this._nodes.get(id);
	}

	findNodeByQN(project: string, qualifiedName: string): GraphNode | undefined {
		const id = this._nodesByQN.get(`${project}:${qualifiedName}`);
		return id !== undefined ? this._nodes.get(id) : undefined;
	}

	findNodesByFile(project: string, filePath: string): GraphNode[] {
		const ids = this._nodesByFile.get(`${project}:${filePath}`) || [];
		return ids.map(id => this._nodes.get(id)!).filter(Boolean);
	}

	findNodesByLabel(project: string, label: string): GraphNode[] {
		const ids = this._nodesByLabel.get(`${project}:${label}`) || [];
		return ids.map(id => this._nodes.get(id)!).filter(Boolean);
	}

	/**
	 * 获取文件节点（多 folder 感知）。project 提供时限定单项目，否则遍历所有项目。
	 * 兼容标签大小写（'file'/'File'）；无 file 标签节点时回退到所有含 filePath 的节点（按 project:filePath 去重）。
	 */
	getAllFileNodes(project?: string): GraphNode[] {
		const collect = (p: string): GraphNode[] => {
			let n = this.findNodesByLabel(p, 'file');
			if (n.length === 0) { n = this.findNodesByLabel(p, 'File'); }
			return n;
		};
		let nodes: GraphNode[] = [];
		if (project) {
			nodes = collect(project);
		} else {
			// ⚠⚠ **不能**写 `nodes.push(...collect(p.name))`：`collect` 返回该项目**全部
			// file 节点**（每文件一个，大仓实测可达数万）⇒ 展开成函数实参必然抛
			// `Maximum call stack size exceeded`（同 `codebaseGraphService._loadGraphFromSqlite`
			// 里那处 78 万节点的同类事故，2026-09-16）。
			for (const p of this.listProjects()) {
				for (const n of collect(p.name)) { nodes.push(n); }
			}
		}
		if (nodes.length === 0) {
			const seen = new Set<string>();
			for (const n of this._nodes.values()) {
				if (!n.filePath) { continue; }
				if (project && n.project !== project) { continue; }
				const key = `${n.project}:${n.filePath}`;
				if (seen.has(key)) { continue; }
				seen.add(key);
				nodes.push(n);
			}
		}
		return nodes;
	}

	/** 跨项目按 qualifiedName 查找节点（多 folder：qn 可能属于任一 folder 项目）。 */
	findNodeByQNAnyProject(qualifiedName: string): GraphNode | undefined {
		for (const p of this.listProjects()) {
			const n = this.findNodeByQN(p.name, qualifiedName);
			if (n) { return n; }
		}
		return undefined;
	}

	/**
	 * 模糊按 qualifiedName 查找节点（多 folder 感知）。容忍 LLM 传入的截断/部分符号名：
	 * 精确匹配 miss 时，依次尝试 前缀（QN 以 query 开头，如 PerformReachabilityAnalysis →
	 * PerformReachabilityAnalysisPass）、后缀（QN 以 query 结尾，如 ProcessAsync → GC::ProcessAsync）、
	 * 末段 leaf 前后缀、子串。大小写不敏感。优先指定项目，否则跨所有项目取最高分。
	 * query 过短（<4 字符）时直接返回 undefined，避免退化匹配。
	 */
	findNodeByQNFuzzy(projectName: string | undefined, qualifiedName: string): GraphNode | undefined {
		const q = qualifiedName.trim();
		if (q.length < 4) { return undefined; }
		const ql = q.toLowerCase();
		const scoreOf = (qn: string): number => {
			const qnl = qn.toLowerCase();
			if (qnl === ql) { return 100; }
			if (qnl.startsWith(ql)) { return 80; }
			if (qnl.endsWith(ql)) { return 70; }
			const leaf = qn.split(/::/).pop() || qn;
			const leafl = leaf.toLowerCase();
			if (leafl.startsWith(ql) || leafl.endsWith(ql)) { return 60; }
			if (qnl.includes(ql)) { return 40; }
			return -1;
		};
		const scan = (onlyProj?: string): GraphNode | undefined => {
			let best: GraphNode | undefined;
			let bestScore = -1;
			for (const [key, id] of this._nodesByQN) {
				const ci = key.indexOf(':');
				const proj = ci >= 0 ? key.slice(0, ci) : '';
				if (onlyProj && proj !== onlyProj) { continue; }
				const qn = ci >= 0 ? key.slice(ci + 1) : key;
				const s = scoreOf(qn);
				if (s > bestScore) { bestScore = s; best = this._nodes.get(id); }
			}
			return bestScore > 0 ? best : undefined;
		};
		if (projectName) {
			const hit = scan(projectName);
			if (hit) { return hit; }
		}
		return scan(undefined);
	}

	deleteNodesByFile(project: string, filePath: string): void {
		const ids = this._nodesByFile.get(`${project}:${filePath}`) || [];
		for (const id of ids) {
			const node = this._nodes.get(id);
			if (!node) { continue; }
			// Remove from QN index
			this._nodesByQN.delete(`${project}:${node.qualifiedName}`);
			// Remove from BM25（defer 期间只记脏集，避免全量重建时漏删）
			if (!this._deferBM25) {
				this._bm25.removeDocument(id);
			} else {
				this._bm25DirtyRemoved.add(id);
				this._bm25DirtyAdded.delete(id);
			}
			// Remove edges
			this._deleteEdgesOfNode(id);
			// Remove node
			this._nodes.delete(id);
		}
		this._nodesByFile.delete(`${project}:${filePath}`);
	}

	private _deleteEdgesOfNode(nodeId: number): void {
		// Delete outgoing edges
		const outIds = this._outEdges.get(nodeId) || [];
		for (const eid of outIds) { this._deleteEdge(eid); }
		// Delete incoming edges
		const inIds = this._inEdges.get(nodeId) || [];
		for (const eid of inIds) { this._deleteEdge(eid); }
		this._outEdges.delete(nodeId);
		this._inEdges.delete(nodeId);
	}

	// ─── Edge Operations ───────────────────────────────────────────────────

	insertEdge(edge: Omit<GraphEdge, 'id'> & { id?: number }): GraphEdge | null {
		if (this._edgeDedupHas(edge.sourceId, edge.targetId, edge.type)) { return null; }  // Skip duplicate
		this._edgeDedupAdd(edge.sourceId, edge.targetId, edge.type);

		const id = edge.id ?? this._nextEdgeId++;
		const newEdge: GraphEdge = { ...edge, id };
		this._edges.set(id, newEdge);

		// Update indices
		const outArr = this._outEdges.get(edge.sourceId) || [];
		outArr.push(id);
		this._outEdges.set(edge.sourceId, outArr);

		const inArr = this._inEdges.get(edge.targetId) || [];
		inArr.push(id);
		this._inEdges.set(edge.targetId, inArr);

		// Update degrees
		const src = this._nodes.get(edge.sourceId);
		if (src) { src.outDegree++; }
		const tgt = this._nodes.get(edge.targetId);
		if (tgt) { tgt.inDegree++; }

		return newEdge;
	}

	insertEdgeBatch(edges: Parameters<typeof this.insertEdge>[0][]): GraphEdge[] {
		const result: GraphEdge[] = [];
		for (const e of edges) {
			const r = this.insertEdge(e);
			if (r) { result.push(r); }
		}
		return result;
	}

	private _deleteEdge(edgeId: number): void {
		const edge = this._edges.get(edgeId);
		if (!edge) { return; }
		this._edgeDedupDelete(edge.sourceId, edge.targetId, edge.type);
		this._edges.delete(edgeId);

		// Update degree
		const src = this._nodes.get(edge.sourceId);
		if (src && src.outDegree > 0) { src.outDegree--; }
		const tgt = this._nodes.get(edge.targetId);
		if (tgt && tgt.inDegree > 0) { tgt.inDegree--; }
	}

	getEdgesBySource(nodeId: number): GraphEdge[] {
		const ids = this._outEdges.get(nodeId) || [];
		return ids.map(id => this._edges.get(id)!).filter(Boolean);
	}

	getEdgesByTarget(nodeId: number): GraphEdge[] {
		const ids = this._inEdges.get(nodeId) || [];
		return ids.map(id => this._edges.get(id)!).filter(Boolean);
	}

	getEdgesByType(project: string, type: string): GraphEdge[] {
		const result: GraphEdge[] = [];
		for (const edge of this._edges.values()) {
			if (edge.project === project && edge.type === type) {
				result.push(edge);
			}
		}
		return result;
	}

	// ─── Search ────────────────────────────────────────────────────────────

	/**
	 * BM25 结构加权重排（对齐 codebase-memory-mcp C 实现）。
	 * 噪声标签（File/Folder/Module/Variable）默认从 BM25 结果中排除，
	 * Function/Method/Route 节点获得额外评分加成。
	 */
	private static readonly BM25_BOOST: Record<string, number> = {
		'function': 10, 'method': 10, 'route': 8,
		'class': 5, 'interface': 5, 'struct': 5,
	};
	private static readonly BM25_NOISE_LABELS = new Set([
		'file', 'folder', 'module', 'variable', 'package',
	]);

	search(params: SearchParams): SearchResult {
		let candidates: GraphNode[];
		let scores: Map<number, number> | undefined;

		// ── BM25 全文搜索路径 (P0) ──────────────────────────────────────
		if (params.query && params.query.trim()) {
			const limit = params.limit ?? 200;
			// 如有 filePattern，多抽样以补偿后过滤损失
			const oversample = params.filePattern ? limit * 10 : limit * 3;
			// ★ 2026-09-18（P0 性能）：倒排可能处于「载入时跳过、待按需构建」状态（见 `_bm25Deferred`）
			// ⇒ 本同步入口**降级为子串扫描**，绝不静默返回空结果（理由见 `_degradedSubstringScores`）。
			const bm25Scores = this._bm25Deferred
				? this._degradedSubstringScores(params.query.trim(), oversample)
				: this._bm25.search(params.query.trim(), oversample);

			// filePattern regex (如已提供)
			let fileRegex: RegExp | undefined;
			if (params.filePattern) {
				fileRegex = this._globToRegex(params.filePattern);
			}

			// 结构加权重排 + 噪声标签过滤
			const boosted = new Map<number, number>();
			for (const [nodeId, bm25Score] of bm25Scores) {
				const node = this._nodes.get(nodeId);
				if (!node) { continue; }
				// 噪声标签过滤
				const nodeType = node.type ?? node.label;
				if (nodeType && CodebaseGraphStore.BM25_NOISE_LABELS.has(nodeType.toLowerCase())) { continue; }
				// 项目过滤
				if (params.project && node.project !== params.project) { continue; }
				// label 过滤
				if (params.label) {
					// 兼容：node.type 或 node.label，大小写不敏感（C 版用 'Function'，LLM 传 'function'）
					const nodeType = (node.type || node.label || '').toLowerCase();
					if (nodeType !== params.label.toLowerCase()) { continue; }
				}
				// filePattern 过滤
				if (fileRegex && node.filePath && !fileRegex.test(node.filePath)) { continue; }
				// 结构 boosting
				const typeKey = node.type?.toLowerCase() || '';
				const boost = CodebaseGraphStore.BM25_BOOST[typeKey] || 0;
				boosted.set(nodeId, bm25Score + boost);
			}

			// 按评分排序
			const sortedIds = [...boosted.entries()]
				.sort((a, b) => b[1] - a[1]);

			candidates = [];
			for (const [nodeId] of sortedIds) {
				const node = this._nodes.get(nodeId);
				if (node) { candidates.push(node); }
			}

			// Brand filter — degree / relType 仍需应用
			candidates = this._applyFilterChain(candidates, params, /* skipName */ true);

			const total = candidates.length;
			const offset = params.offset || 0;
		const paged = candidates.slice(offset, offset + Math.min(params.limit || 200, GRAPH_HARD_RESULT_CAP));

		// 收集评分
			scores = new Map();
			for (const node of paged) {
				if (boosted.has(node.id)) { scores.set(node.id, boosted.get(node.id)!); }
			}

			return { nodes: paged, total, scores, hasMore: offset + paged.length < total };
		}

		// ── Regex / label 搜索路径 (原有逻辑) ────────────────────────────
		if (params.label) {
			if (params.project) {
				candidates = this.findNodesByLabel(params.project, params.label);
			} else {
				// 多 folder：未指定项目时跨所有项目按标签匹配（大小写不敏感，兼容 C 版 'File'/TS 'file'）
				const ll = params.label.toLowerCase();
				candidates = [];
				for (const node of this._nodes.values()) {
					const nt = (node.type || node.label || '').toLowerCase();
					if (nt === ll) { candidates.push(node); }
				}
			}
		} else if (params.filePattern) {
			const regex = this._globToRegex(params.filePattern);
			candidates = [];
			for (const node of this._nodes.values()) {
				if (node.filePath && regex.test(node.filePath)) {
					candidates.push(node);
				}
			}
		} else {
			candidates = Array.from(this._nodes.values());
		}

		// Project filter
		if (params.project) {
			candidates = candidates.filter(n => n.project === params.project);
		}

		candidates = this._applyFilterChain(candidates, params, /* skipName */ false);

		const total = candidates.length;
		const offset = params.offset || 0;
		const paged = candidates.slice(offset, offset + Math.min(params.limit || 100, GRAPH_HARD_RESULT_CAP));

		// Include directly connected nodes (P1) — 有界 BFS，防止循环图无界展开（对齐 C 版 max_depth）
		if (params.includeConnected && paged.length > 0) {
			const maxDepth = Math.min(params.maxDepth ?? GRAPH_MAX_BFS_DEPTH, GRAPH_MAX_BFS_DEPTH);
			const connectedSet = new Set(paged.map(n => n.id));
			const connectedNodes: GraphNode[] = [];
			let frontier: GraphNode[] = [...paged];
			for (let depth = 0; depth < maxDepth && connectedNodes.length < GRAPH_HARD_RESULT_CAP; depth++) {
				const nextFrontier: GraphNode[] = [];
				for (const node of frontier) {
					const consider = (nid: number): void => {
						if (connectedSet.has(nid)) { return; }
						const n = this._nodes.get(nid);
						if (!n || (params.project && n.project !== params.project)) { return; }
						connectedSet.add(nid);
						connectedNodes.push(n);
						nextFrontier.push(n);
					};
					for (const edge of this.getEdgesBySource(node.id)) { consider(edge.targetId); }
					for (const edge of this.getEdgesByTarget(node.id)) { consider(edge.sourceId); }
					if (connectedNodes.length >= GRAPH_HARD_RESULT_CAP) { break; }
				}
				frontier = nextFrontier;
				if (frontier.length === 0) { break; }
			}
			paged.push(...connectedNodes.slice(0, GRAPH_HARD_RESULT_CAP));
		}

		return { nodes: paged, total, hasMore: offset + paged.length < total };
	}

	/** 统一的过滤链（degree / relType / namePattern / qnPattern / excludeLabels / sort） */
	private _applyFilterChain(candidates: GraphNode[], params: SearchParams, skipName: boolean): GraphNode[] {
		// Exclude labels filter (P1)
		if (params.excludeLabels && params.excludeLabels.length > 0) {
			const excludeSet = new Set(params.excludeLabels);
			candidates = candidates.filter(n => !excludeSet.has(n.label));
		}

		// Name pattern filter (skip if BM25 already handled relevance)
		if (!skipName && params.namePattern) {
			const flags = params.caseSensitive ? '' : 'i';
			const regex = new RegExp(params.namePattern, flags);
			// nameOnly（2026-09-15）：**只**匹配符号名 —— 否则 QN 里的文件路径会命中
			// （QN = `<相对路径>::<符号名>`，搜 "test" 会返回 `…/classifyLLM.test.ts::MockClassifyLLM`）。
			candidates = params.nameOnly
				? candidates.filter(n => regex.test(n.name))
				: candidates.filter(n =>
					regex.test(n.name) || (n.qualifiedName && regex.test(n.qualifiedName))
				);
		}

		// Qualified name pattern filter (P1)
		if (params.qnPattern) {
			const flags = params.caseSensitive ? '' : 'i';
			const regex = new RegExp(params.qnPattern, flags);
			candidates = candidates.filter(n => n.qualifiedName && regex.test(n.qualifiedName));
		}

		// Degree filters
		if (params.minInDegree !== undefined) {
			candidates = candidates.filter(n => n.inDegree >= params.minInDegree!);
		}
		if (params.maxInDegree !== undefined) {
			candidates = candidates.filter(n => n.inDegree <= params.maxInDegree!);
		}
		if (params.minOutDegree !== undefined) {
			candidates = candidates.filter(n => n.outDegree >= params.minOutDegree!);
		}
		if (params.maxOutDegree !== undefined) {
			candidates = candidates.filter(n => n.outDegree <= params.maxOutDegree!);
		}

		// Relationship type filter
		if (params.relType) {
			const dir = params.relDirection || 'both';
			candidates = candidates.filter(n => {
				if (dir === 'out' || dir === 'both') {
					const outEdges = this.getEdgesBySource(n.id);
					if (outEdges.some(e => e.type === params.relType)) { return true; }
				}
				if (dir === 'in' || dir === 'both') {
					const inEdges = this.getEdgesByTarget(n.id);
					if (inEdges.some(e => e.type === params.relType)) { return true; }
				}
				return false;
			});
		}

		// Sort
		if (params.sortBy) {
			candidates.sort((a, b) => {
				let cmp = 0;
				if (params.sortBy === 'name') { cmp = a.name.localeCompare(b.name); }
				else if (params.sortBy === 'inDegree') { cmp = a.inDegree - b.inDegree; }
				else if (params.sortBy === 'outDegree') { cmp = a.outDegree - b.outDegree; }
				else if (params.sortBy === 'degree') { cmp = (a.inDegree + a.outDegree) - (b.inDegree + b.outDegree); }
				return params.sortDesc ? -cmp : cmp;
			});
		}

		return candidates;
	}

	ftsSearch(query: string, limit: number = 50): Map<number, number> {
		return this._bm25.search(query, limit);
	}

	// ─── File Hash Operations ─────────────────────────────────────────────

	upsertFileHash(hash: FileHash): void {
		this._fileHashes.set(`${hash.project}:${hash.relPath}`, hash);
	}

	getFileHash(project: string, relPath: string): FileHash | undefined {
		return this._fileHashes.get(`${project}:${relPath}`);
	}

	/**
	 * 基线规模（零拷贝）：为 0 说明**该项目**从未完成全量索引
	 * （增量快路径不可信，见 `_runIncrementalIndex` 的空基线守卫）。
	 *
	 * ★★ 2026-09-21：**支持按项目**（原实现恒为全库总数 ✗）——
	 * 判据必须是「本项目的基线」，否则多项目（同一 store 里并存 UE 9.5 万 + 本仓）
	 * 会互相污染：某个大而残缺的项目会把**健康项目**也拉进「残缺」判定 ✗✗。
	 */
	getFileHashCount(project?: string): number {
		if (!project) { return this._fileHashes.size; }
		let count = 0;
		for (const h of this._fileHashes.values()) {
			if (h.project === project) { count++; }
		}
		return count;
	}

	/**
	 * ★★ 2026-09-21：「**放弃重试**」的哈希条数（`gaveUp === true`）—— 它们**不是**成功索引过的文件。
	 *
	 * 用途：健康度/残缺判据要拿 `getFileHashCount() - getGaveUpFileHashCount()` 当分母，
	 * 否则「解析失败被固化」会被当成「成功索引过 ⇒ 每文件节点太少 ⇒ 残缺」✗✓（真机 UE 95k 实证）。
	 * ⚠ 与之相对，**增量分类基线必须用总数**（含 gaveUp）—— 否则那些文件每轮都被重报 added ✗。
	 */
	getGaveUpFileHashCount(project?: string): number {
		let count = 0;
		for (const h of this._fileHashes.values()) {
			if (h.gaveUp !== true) { continue; }
			if (project && h.project !== project) { continue; }
			count++;
		}
		return count;
	}

	/** 成功索引过的哈希条数（= 总数 − 放弃数）——**健康度判据的唯一合法分母** ✓。 */
	getOkFileHashCount(project?: string): number {
		return this.getFileHashCount(project) - this.getGaveUpFileHashCount(project);
	}

	/**
	 * 清文件哈希基线（残缺图强制全量重建用：无哈希 → classifyFiles 全判 added）。
	 *
	 * ★★ 2026-09-21：**支持按项目**（原实现清全库 ✗）—— 只清「被判残缺的那个项目」，
	 * 否则一个坏项目会让**所有**项目（含健康项目）付一次全量重索引 ✗✗✗。
	 */
	clearFileHashes(project?: string): void {
		if (!project) { this._fileHashes.clear(); return; }
		for (const key of [...this._fileHashes.keys()]) {
			if (this._fileHashes.get(key)?.project === project) { this._fileHashes.delete(key); }
		}
	}

	/**
	 * ★★ 2026-09-21：**分批**清哈希 —— 超大仓的残缺修复用（见 `_runIncrementalIndex` 的 deficient 分支）。
	 *
	 * 为什么不能一次清光：清光 ⇒ classifyFiles 把**全部**文件判 added ⇒ 95k 文件一次全量解析 ⇒
	 * 解析结果堆在渲染进程 ⇒ 撞解析期硬堆上限被中止（真机 UE：heap 每 30s +~1GB ✗✗）
	 * ⇒ 「崩溃/中止 → 残缺制品 → 下次又全量」不收敛 ✗。
	 *
	 * 只清 `limit` 个（**Map 插入顺序** ⇒ 确定性 ✓）：被清的文件本轮被重解析、重解析后哈希**追加到末尾**
	 * ⇒ 下一轮「取前 N 个」自然轮到**下一批** ⇒ 整集合**轮转覆盖** ⇒ 每轮内存有界、进度可累积 ⇒ 能收敛 ✓✓。
	 *
	 * @returns 实际清掉的条数（项目无哈希 / `limit <= 0` ⇒ 0）
	 */
	clearFileHashesBounded(project: string, limit: number): number {
		if (!project || limit <= 0) { return 0; }
		let cleared = 0;
		for (const key of [...this._fileHashes.keys()]) {
			if (cleared >= limit) { break; }
			if (this._fileHashes.get(key)?.project !== project) { continue; }
			this._fileHashes.delete(key);
			cleared++;
		}
		return cleared;
	}

	deleteFileHash(project: string, relPath: string): void {
		this._fileHashes.delete(`${project}:${relPath}`);
	}

	getAllFileHashes(project: string): FileHash[] {
		const result: FileHash[] = [];
		for (const hash of this._fileHashes.values()) {
			if (hash.project === project) { result.push(hash); }
		}
		return result;
	}

	/** Compute SHA-256 hash of a file */
	static async computeHash(fileService: IFileService, uri: URI): Promise<{ sha256: string; mtimeNs: number; size: number }> {
		const content = await fileService.readFile(uri);
		const data = content.value.buffer;
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const sha256 = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
		const stat = await fileService.stat(uri);
		return { sha256, mtimeNs: stat.mtime * 1_000_000, size: stat.size };
	}

	// ─── Layout Cache ──────────────────────────────────────────────────────

	saveLayout(nodeId: number, x: number, y: number, z: number): void {
		this._layout.set(nodeId, { x, y, z });
	}

	loadLayout(nodeId: number): { x: number; y: number; z: number } | undefined {
		return this._layout.get(nodeId);
	}

	loadAllLayout(): Map<number, { x: number; y: number; z: number }> {
		return new Map(this._layout);
	}

	// ─── Statistics ────────────────────────────────────────────────────────

	getAllNodes(): GraphNode[] {
		return Array.from(this._nodes.values());
	}

	/**
	 * 增量迭代节点（不构建全量数组，供流式持久化避免 2x 峰值）。
	 * 对齐 codebase-memory-mcp 的 dump 分片：调用方逐条 JSON.stringify 后即释放。
	 */
	iterateNodes(project?: string): IterableIterator<GraphNode> {
		if (!project) { return this._nodes.values(); }
		const result: GraphNode[] = [];
		for (const n of this._nodes.values()) {
			if (n.project === project) { result.push(n); }
		}
		return result[Symbol.iterator]();
	}

	/** 增量迭代边（语义同 iterateNodes）。 */
	iterateEdges(project?: string): IterableIterator<GraphEdge> {
		if (!project) { return this._edges.values(); }
		const result: GraphEdge[] = [];
		for (const e of this._edges.values()) {
			if (e.project === project) { result.push(e); }
		}
		return result[Symbol.iterator]();
	}

	/**
	 * 高效获取 top-N 节点（按 degree 排序），直接迭代 Map，不创建全量数组。
	 * 比 getAllNodes().filter().sort().slice() 更高效。
	 */
	getTopNodesByDegree(project: string, maxNodes: number): GraphNode[] {
		const nodes: GraphNode[] = [];
		for (const node of this._nodes.values()) {
			if (node.project === project) {
				nodes.push(node);
			}
		}
		nodes.sort((a, b) => ((b.inDegree || 0) + (b.outDegree || 0)) - ((a.inDegree || 0) + (a.outDegree || 0)));
		return nodes.slice(0, maxNodes);
	}

	/**
	 * 高效获取指定节点集之间的边，直接迭代 Map，不创建全量边数组。
	 */
	getEdgesBetweenNodes(nodeIds: Set<number>): { edge: GraphEdge; sourceId: number; targetId: number }[] {
		const result: { edge: GraphEdge; sourceId: number; targetId: number }[] = [];
		for (const edge of this._edges.values()) {
			if (nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId)) {
				result.push({ edge, sourceId: edge.sourceId, targetId: edge.targetId });
			}
		}
		return result;
	}

	getAllEdges(): GraphEdge[] {
		return Array.from(this._edges.values());
	}

	getNodeCount(project?: string): number {
		if (!project) { return this._nodes.size; }
		let count = 0;
		for (const node of this._nodes.values()) {
			if (node.project === project) { count++; }
		}
		return count;
	}

	getEdgeCount(project?: string): number {
		if (!project) { return this._edges.size; }
		let count = 0;
		for (const edge of this._edges.values()) {
			if (edge.project === project) { count++; }
		}
		return count;
	}

	getNodeTypes(project: string): Map<string, number> {
		const counts = new Map<string, number>();
		for (const node of this._nodes.values()) {
			if (node.project !== project) { continue; }
			counts.set(node.label, (counts.get(node.label) || 0) + 1);
		}
		return counts;
	}

	getEdgeTypes(project: string): Map<string, number> {
		const counts = new Map<string, number>();
		for (const edge of this._edges.values()) {
			if (edge.project !== project) { continue; }
			counts.set(edge.type, (counts.get(edge.type) || 0) + 1);
		}
		return counts;
	}

	// ─── Community ─────────────────────────────────────────────────────────

	setCommunity(nodeId: number, communityId: number): void {
		const node = this._nodes.get(nodeId);
		if (node) { node.community = communityId; }
	}

	getCommunities(project: string): Map<number, number[]> {
		const communities = new Map<number, number[]>();
		for (const node of this._nodes.values()) {
			if (node.project !== project || node.community === undefined) { continue; }
			const arr = communities.get(node.community) || [];
			arr.push(node.id);
			communities.set(node.community, arr);
		}
		return communities;
	}

	// ─── Clear & Persist ──────────────────────────────────────────────────

	clear(): void {
		this._nodes.clear();
		this._edges.clear();
		this._edgeDedup.clear();
		this._edgeTypeIds.clear();   // ★ 数值键重做：类型 id 也随之复位（否则跨 clear 无界增长 ✗）
		this._nodesByQN.clear();
		this._nodesByFile.clear();
		this._nodesByLabel.clear();
		this._outEdges.clear();
		this._inEdges.clear();
		this._fileHashes.clear();
		this._bm25.clear();
		// 必须一并清空 BM25 脏集：节点 id 从 1 重新分配，残留的旧 id 会在后续
		// 增量 rebuild 时命中「同 id 但已是另一个节点」的文档，造成索引错乱。
		this._bm25DirtyAdded.clear();
		this._bm25DirtyRemoved.clear();
		this._layout.clear();
		this._nextNodeId = 1;
		this._nextEdgeId = 1;
	}

	/**
	 * 真实 V8 堆水位看门狗（对齐 codebase-memory-mcp 的 cbm_mem_budget）。
	 * renderer / Worker 均可用；无 performance.memory 时返回 false（不拦截）。
	 * 用于在索引/加载重路径前判断是否接近 4GB 上限，提前拒绝而非静默 OOM。
	 */
	static readonly HEAP_BUDGET_BYTES = 3 * 1024 * 1024 * 1024; // 3GB（低于 V8 4GB 硬上限）
	static isHeapOverBudget(extraBytes = 0): boolean {
		const mem = (globalThis as any)?.performance?.memory;
		if (!mem || typeof mem.usedJSHeapSize !== 'number') { return false; }
		return mem.usedJSHeapSize + extraBytes > CodebaseGraphStore.HEAP_BUDGET_BYTES;
	}

	/**
	 * 序列化图数据。
	 * @param project 若提供，仅序列化该项目的 nodes/edges/fileHashes/layout（多 folder：每个 folder 独立持久化）。
	 *   由于 BM25 以全局 node-id 建索引，project 范围导出时省略 bm25，加载方需在合并后 rebuildBM25()。
	 */
	toJSON(project?: string): any {
		if (!project) {
			return {
				nodes: Array.from(this._nodes.values()),
				edges: Array.from(this._edges.values()),
				fileHashes: Array.from(this._fileHashes.values()),
				bm25: this._bm25.toJSON(),
				layout: Array.from(this._layout.entries()),
				nextNodeId: this._nextNodeId,
				nextEdgeId: this._nextEdgeId,
			};
		}
		const nodes = Array.from(this._nodes.values()).filter(n => n.project === project);
		const nodeIds = new Set(nodes.map(n => n.id));
		const edges = Array.from(this._edges.values()).filter(e => e.project === project);
		const fileHashes = Array.from(this._fileHashes.values()).filter(h => h.project === project);
		const layout = Array.from(this._layout.entries()).filter(([id]) => nodeIds.has(id));
		return {
			nodes,
			edges,
			fileHashes,
			bm25: undefined,
			layout,
			nextNodeId: this._nextNodeId,
			nextEdgeId: this._nextEdgeId,
		};
	}

	/**
	 * 仅取持久化所需的轻量元数据（fileHashes / bm25 / layout / nextId），
	 * 【不构建 nodes/edges 全量数组】，供流式 save 使用，避免 toJSON 的 2x 峰值。
	 * project 提供时省略 bm25（与 toJSON 约定一致，合并后需 rebuildBM25）。
	 */
	getMeta(project?: string): { fileHashes: FileHash[]; bm25: any; layout: [number, { x: number; y: number; z: number }][]; nextNodeId: number; nextEdgeId: number } {
		const fileHashes = project
			? this.getAllFileHashes(project)
			: Array.from(this._fileHashes.values());
		const layout = Array.from(this._layout.entries()) as [number, { x: number; y: number; z: number }][];
		const bm25 = project ? undefined : this._bm25.toJSON();
		return { fileHashes, bm25, layout, nextNodeId: this._nextNodeId, nextEdgeId: this._nextEdgeId };
	}

	fromJSON(data: any): void {
		this.clear();
		this._nextNodeId = data.nextNodeId || 1;
		this._nextEdgeId = data.nextEdgeId || 1;

		// Restore nodes
		for (const node of data.nodes || []) {
			this._nodes.set(node.id, node);
			this._nodesByQN.set(`${node.project}:${node.qualifiedName}`, node.id);
			if (node.filePath) {
				const key = `${node.project}:${node.filePath}`;
				const arr = this._nodesByFile.get(key) || [];
				arr.push(node.id);
				this._nodesByFile.set(key, arr);
			}
			const labelKey = `${node.project}:${node.label}`;
			const labelArr = this._nodesByLabel.get(labelKey) || [];
			labelArr.push(node.id);
			this._nodesByLabel.set(labelKey, labelArr);
		}

		// Restore edges
		for (const edge of data.edges || []) {
			this._edges.set(edge.id, edge);
			this._edgeDedupAdd(edge.sourceId, edge.targetId, edge.type);
			const outArr = this._outEdges.get(edge.sourceId) || [];
			outArr.push(edge.id);
			this._outEdges.set(edge.sourceId, outArr);
			const inArr = this._inEdges.get(edge.targetId) || [];
			inArr.push(edge.id);
			this._inEdges.set(edge.targetId, inArr);
		}

		// Restore file hashes
		for (const hash of data.fileHashes || []) {
			this._fileHashes.set(`${hash.project}:${hash.relPath}`, hash);
		}

		// Restore BM25
		if (data.bm25) { this._bm25.fromJSON(data.bm25); }

		// Restore layout
		if (data.layout) {
			for (const [id, pos] of data.layout) {
				this._layout.set(id, pos);
			}
		}
	}

	/**
	 * 异步分批加载：每 BATCH_SIZE 项后 yield 到 UI 线程，避免主线程冻结。
	 * 功能与 fromJSON() 完全一致，仅添加了 yield 点。
	 */
	async fromJSONAsync(data: any, onProgress?: (loaded: number, total: number) => void): Promise<void> {
		this.clear();
		this._nextNodeId = data.nextNodeId || 1;
		this._nextEdgeId = data.nextEdgeId || 1;

		const BATCH_SIZE = 8000;
		const nodes = data.nodes || [];
		const totalItems = nodes.length + (data.edges || []).length;

		// Restore nodes (batched)
		for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
			const end = Math.min(i + BATCH_SIZE, nodes.length);
			for (let j = i; j < end; j++) {
				const node = nodes[j];
				this._nodes.set(node.id, node);
				this._nodesByQN.set(`${node.project}:${node.qualifiedName}`, node.id);
				if (node.filePath) {
					const key = `${node.project}:${node.filePath}`;
					const arr = this._nodesByFile.get(key) || [];
					arr.push(node.id);
					this._nodesByFile.set(key, arr);
				}
				const labelKey = `${node.project}:${node.label}`;
				const labelArr = this._nodesByLabel.get(labelKey) || [];
				labelArr.push(node.id);
				this._nodesByLabel.set(labelKey, labelArr);
			}
			if (onProgress) { onProgress(end, totalItems); }
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}

		// Restore edges (batched)
		const edges = data.edges || [];
		for (let i = 0; i < edges.length; i += BATCH_SIZE) {
			const end = Math.min(i + BATCH_SIZE, edges.length);
			for (let j = i; j < end; j++) {
				const edge = edges[j];
				this._edges.set(edge.id, edge);
				this._edgeDedupAdd(edge.sourceId, edge.targetId, edge.type);
				const outArr = this._outEdges.get(edge.sourceId) || [];
				outArr.push(edge.id);
				this._outEdges.set(edge.sourceId, outArr);
				const inArr = this._inEdges.get(edge.targetId) || [];
				inArr.push(edge.id);
				this._inEdges.set(edge.targetId, inArr);
			}
			if (onProgress) { onProgress(nodes.length + end, totalItems); }
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}

		// Restore file hashes
		for (const hash of data.fileHashes || []) {
			this._fileHashes.set(`${hash.project}:${hash.relPath}`, hash);
		}

		// Restore BM25
		if (data.bm25) { this._bm25.fromJSON(data.bm25); }

		// Restore layout
		if (data.layout) {
			for (const [id, pos] of data.layout) {
				this._layout.set(id, pos);
			}
		}
	}

	/**
	 * 合并加载：把 data 追加到当前 store（不 clear），对 node/edge ID 做重映射以避免与已有数据冲突。
	 * 用于多 folder 工作区：每个 folder 的图独立持久化，启动时依次合并进同一内存 store。
	 * @param data 反序列化的图数据
	 * @param projectOverride 若提供，覆盖所有 node/edge/fileHash 的 project 字段（区分不同 folder）
	 * 注意：BM25 不在此恢复（node-id 已重映射），调用方须在合并全部 folder 后统一 rebuildBM25()。
	 *
	 * **幂等（2026-09-15 修，见 IGraphMergeStats 注释）**：同 `(project, qualifiedName)` 已存在的
	 * 节点**复用既有 id 并跳过新增**（边因此仍指向既有节点，不产生悬空）；重复边由 `_edgeDedup` 拦下。
	 */
	async mergeFromJSONAsync(data: any, projectOverride?: string, onProgress?: (loaded: number, total: number) => void): Promise<IGraphMergeStats> {
		const BATCH_SIZE = 8000;
		const nodes = data.nodes || [];
		const edges = data.edges || [];
		const totalItems = nodes.length + edges.length;
		const stats: IGraphMergeStats = { nodesAdded: 0, nodesSkipped: 0, edgesAdded: 0, edgesSkipped: 0 };

		// 旧 id → 新 id 重映射表
		const idMap = new Map<number, number>();

		// Restore nodes (batched, remapped)
		//
		// ★ 2026-09-15：让出策略从「每 BATCH_SIZE（8000）项之后一次」改为**按时间预算**
		// （`SLICE_BUDGET_MS` = 8ms，见 `common/asyncSlice.ts`）。原因：固定 8000 项在
		// 大图（节点带长 filePath / 签名）或慢机器下，**单批连续占用可达 50~150ms**
		// ⇒ 用户观感是「切换工作区时整窗一顿一顿」（实测 UE5EA 87.6 万节点）。
		// 批边界保留（用于 onProgress 粒度），但让出发生在批**内**。
		let sliceStart = performance.now();
		for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
			const end = Math.min(i + BATCH_SIZE, nodes.length);
			for (let j = i; j < end; j++) {
				const src = nodes[j];
				const project = projectOverride ?? src.project;
				// 幂等闸门：同 (project, qn) 已存在 ⇒ 复用其 id、跳过新增（qn 为空时不做判定，
				// 否则多条空 qn 会被误判成重复）。
				const qn = src.qualifiedName;
				const existingId = qn ? this._nodesByQN.get(`${project}:${qn}`) : undefined;
				if (existingId !== undefined) {
					idMap.set(src.id, existingId);
					stats.nodesSkipped++;
					continue;
				}
				const newId = this._nextNodeId++;
				idMap.set(src.id, newId);
				const node: GraphNode = { ...src, id: newId, project };
				this._nodes.set(newId, node);
				this._nodesByQN.set(`${project}:${node.qualifiedName}`, newId);
				if (node.filePath) {
					const key = `${project}:${node.filePath}`;
					const arr = this._nodesByFile.get(key) || [];
					arr.push(newId);
					this._nodesByFile.set(key, arr);
				}
				const labelKey = `${project}:${node.label}`;
				const labelArr = this._nodesByLabel.get(labelKey) || [];
				labelArr.push(newId);
				this._nodesByLabel.set(labelKey, labelArr);
				stats.nodesAdded++;
				if ((j % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
					await yieldToEventLoop();
					sliceStart = performance.now();
				}
			}
			if (onProgress) { onProgress(end, totalItems); }
		}

		// Restore edges (batched, remapped source/target；跳过悬空边与重复边)
		// 同上：批内按时间预算让出（重置基准，避免沿用上一段的残留时间戳）。
		sliceStart = performance.now();
		for (let i = 0; i < edges.length; i += BATCH_SIZE) {
			const end = Math.min(i + BATCH_SIZE, edges.length);
			for (let j = i; j < end; j++) {
				const src = edges[j];
				const newSource = idMap.get(src.sourceId);
				const newTarget = idMap.get(src.targetId);
				if (newSource === undefined || newTarget === undefined) { continue; }
				// 与 insertEdge 同口径去重（旧实现直接写 `_edges` 绕过它 ⇒ 重复合并会让边翻倍）
				// ★ 2026-09-18 数值键重做后仍必须走**同一对 helper**（否则两条路径口径会再次分叉 ✗）
				if (this._edgeDedupHas(newSource, newTarget, src.type)) { stats.edgesSkipped++; continue; }
				this._edgeDedupAdd(newSource, newTarget, src.type);
				const newId = this._nextEdgeId++;
				const project = projectOverride ?? src.project;
				const edge: GraphEdge = { ...src, id: newId, sourceId: newSource, targetId: newTarget, project };
				this._edges.set(newId, edge);
				const outArr = this._outEdges.get(newSource) || [];
				outArr.push(newId);
				this._outEdges.set(newSource, outArr);
				const inArr = this._inEdges.get(newTarget) || [];
				inArr.push(newId);
				this._inEdges.set(newTarget, inArr);
				stats.edgesAdded++;
				if ((j % SLICE_CHECK_EVERY) === 0 && sliceBudgetExceeded(sliceStart)) {
					await yieldToEventLoop();
					sliceStart = performance.now();
				}
			}
			if (onProgress) { onProgress(nodes.length + end, totalItems); }
		}

		// Restore file hashes (project override)
		for (const hash of data.fileHashes || []) {
			const project = projectOverride ?? hash.project;
			this._fileHashes.set(`${project}:${hash.relPath}`, { ...hash, project });
		}

		// Restore layout (remap ids)
		if (data.layout) {
			for (const [oldId, pos] of data.layout) {
				const newId = idMap.get(oldId);
				if (newId !== undefined) { this._layout.set(newId, pos); }
			}
		}
		return stats;
	}

	// ─── Transaction / Checkpoint / Integrity (对标 SQLite WAL) ──────────

	private _transactionSnapshot: any = undefined;
	private _inTransaction = false;

	/** Begin a transaction — snapshot current state for rollback. */
	beginTransaction(): void {
		if (this._inTransaction) { return; }
		// 大图跳过整库快照：索引期避免 toJSON 2x 峰值（对齐 Phase 0 内存闸）。
		// 代价：超大图事务出错时不回滚（索引失败可重建），用内存安全换正确性边界。
		if (this._nodes.size > GRAPH_TX_SNAPSHOT_NODE_THRESHOLD) {
			this._transactionSnapshot = null;
			this._inTransaction = true;
			return;
		}
		this._transactionSnapshot = this.toJSON();
		this._inTransaction = true;
	}

	/** Commit transaction — discard snapshot. */
	commitTransaction(): void {
		this._transactionSnapshot = undefined;
		this._inTransaction = false;
	}

	/** Rollback transaction — restore from snapshot. */
	rollbackTransaction(): void {
		// 大图快照被跳过时无法回滚（见 beginTransaction），此处静默 no-op 以避免崩溃。
		if (this._transactionSnapshot) {
			this.fromJSON(this._transactionSnapshot);
			this._transactionSnapshot = undefined;
			this._inTransaction = false;
		}
	}

	get inTransaction(): boolean { return this._inTransaction; }

	/** Checkpoint — flush in-memory state to persistent storage. (对标 WAL checkpoint) */
	checkpoint(): void {
		// In-memory store: checkpoint is a no-op.
		// Persistence is handled by GraphPersistence.exportArtifact().
	}

	/** Integrity check — verify internal consistency. (对标 PRAGMA integrity_check) */
	checkIntegrity(): { ok: boolean; errors: string[] } {
		const errors: string[] = [];

		// Check node indices
		for (const [id, node] of this._nodes) {
			if (node.id !== id) {
				errors.push(`Node id mismatch: map key ${id} vs node.id ${node.id}`);
			}
			const qnKey = `${node.project}:${node.qualifiedName}`;
			if (this._nodesByQN.get(qnKey) !== id) {
				errors.push(`QN index mismatch for node ${id}: ${qnKey}`);
			}
		}

		// Check edge indices
		for (const [id, edge] of this._edges) {
			if (edge.id !== id) {
				errors.push(`Edge id mismatch: map key ${id} vs edge.id ${edge.id}`);
			}
			if (!this._nodes.has(edge.sourceId)) {
				errors.push(`Edge ${id} references missing source node ${edge.sourceId}`);
			}
			if (!this._nodes.has(edge.targetId)) {
				errors.push(`Edge ${id} references missing target node ${edge.targetId}`);
			}
		}

		// Check degree consistency
		for (const [id, node] of this._nodes) {
			const outCount = (this._outEdges.get(id) || []).length;
			const inCount = (this._inEdges.get(id) || []).length;
			if (node.outDegree !== outCount) {
				errors.push(`Node ${id} outDegree mismatch: ${node.outDegree} vs ${outCount}`);
			}
			if (node.inDegree !== inCount) {
				errors.push(`Node ${id} inDegree mismatch: ${node.inDegree} vs ${inCount}`);
			}
		}

		return { ok: errors.length === 0, errors };
	}

	/** Dump store to binary buffer. (对标 SQLite export) */
	dump(): Uint8Array {
		const json = JSON.stringify(this.toJSON());
		return new TextEncoder().encode(json);
	}

	/** Restore store from binary buffer. (对标 SQLite import) */
	restore(data: Uint8Array): void {
		const json = JSON.parse(new TextDecoder().decode(data));
		this.fromJSON(json);
	}

	/** Batch upsert with transaction — for parallel pipeline dump. */
	batchUpsert(nodes: Parameters<typeof this.upsertNode>[0][], edges: Parameters<typeof this.insertEdge>[0][]): { nodes: GraphNode[]; edges: GraphEdge[] } {
		this.beginTransaction();
		try {
			const upsertedNodes = this.upsertNodeBatch(nodes);
			const insertedEdges = this.insertEdgeBatch(edges);
			this.commitTransaction();
			return { nodes: upsertedNodes, edges: insertedEdges };
		} catch (err) {
			this.rollbackTransaction();
			throw err;
		}
	}

	/** Delete all data for a project. */
	deleteProject(project: string): void {
		this.beginTransaction();
		try {
			// Delete nodes
			const nodeIdsToDelete: number[] = [];
			for (const [id, node] of this._nodes) {
				if (node.project === project) {
					nodeIdsToDelete.push(id);
				}
			}
			for (const id of nodeIdsToDelete) {
				const node = this._nodes.get(id);
				if (node) {
					this._nodesByQN.delete(`${project}:${node.qualifiedName}`);
					if (node.filePath) {
						this._nodesByFile.delete(`${project}:${node.filePath}`);
					}
					this._bm25.removeDocument(id);
					this._deleteEdgesOfNode(id);
					this._nodes.delete(id);
				}
			}
			// Delete edges
			const edgeIdsToDelete: number[] = [];
			for (const [id, edge] of this._edges) {
				if (edge.project === project) {
					edgeIdsToDelete.push(id);
				}
			}
			for (const id of edgeIdsToDelete) {
				this._deleteEdge(id);
			}
			// Delete file hashes
			const hashKeysToDelete: string[] = [];
			for (const key of this._fileHashes.keys()) {
				if (key.startsWith(`${project}:`)) {
					hashKeysToDelete.push(key);
				}
			}
			for (const key of hashKeysToDelete) {
				this._fileHashes.delete(key);
			}
			this.commitTransaction();
		} catch (err) {
			this.rollbackTransaction();
			throw err;
		}
	}

	/** List all projects in the store. */
	listProjects(): { name: string; nodeCount: number; edgeCount: number; fileCount: number }[] {
		const projects = new Map<string, { nodeCount: number; edgeCount: number; fileCount: number }>();
		for (const node of this._nodes.values()) {
			const p = projects.get(node.project) || { nodeCount: 0, edgeCount: 0, fileCount: 0 };
			p.nodeCount++;
			projects.set(node.project, p);
		}
		for (const edge of this._edges.values()) {
			const p = projects.get(edge.project);
			if (p) { p.edgeCount++; }
		}
		for (const hash of this._fileHashes.values()) {
			const p = projects.get(hash.project);
			if (p) { p.fileCount++; }
		}
		return Array.from(projects.entries()).map(([name, counts]) => ({ name, ...counts }));
	}

	// ─── Helpers ──────────────────────────────────────────────────────────

	private _globToRegex(glob: string): RegExp {
		const escaped = glob
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*/g, '.*')
			.replace(/\?/g, '.')
			// 折叠连续 `.*`（glob '**' 会被转成 '.*.*'）为单个 `.*`——连续的 `.*` 前缀
			// 会在每个不匹配字符串上触发 O(n²) 灾难性回溯（正则引擎枚举所有切分点），
			// 大图谱（9w+ 节点）上 filePattern 全表扫描因此从毫秒级膨胀到数十秒、卡死 UI。
			.replace(/(\.\*)+/g, '.*');
		return new RegExp(escaped, 'i');
	}
}
