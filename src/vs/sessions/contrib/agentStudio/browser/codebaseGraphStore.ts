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
}

export interface GraphEdge {
	id: number;
	project: string;
	sourceId: number;
	targetId: number;
	type: string;            // CALLS, IMPORTS, DEFINES, IMPLEMENTS, HTTP_CALLS...
	properties?: Record<string, any>;
}

export interface FileHash {
	project: string;
	relPath: string;
	sha256: string;
	mtimeNs: number;
	size: number;
}

export interface SearchParams {
	project?: string;
	namePattern?: string;     // regex
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
}

export interface SearchResult {
	nodes: GraphNode[];
	total: number;
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

	// Edge storage
	private _edges: Map<number, GraphEdge> = new Map();
	private _nextEdgeId = 1;
	private _edgeDedup: Set<string> = new Set();  // "sourceId:targetId:type" for O(1) dedup

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

	// Layout cache
	private _layout: Map<number, { x: number; y: number; z: number }> = new Map();

	// ─── Node Operations ──────────────────────────────────────────────────

	upsertNode(node: Omit<GraphNode, 'id' | 'inDegree' | 'outDegree'> & { id?: number }): GraphNode {
		const qnKey = `${node.project}:${node.qualifiedName}`;
		const existingId = this._nodesByQN.get(qnKey);

		if (existingId !== undefined) {
			// Update existing node
			const existing = this._nodes.get(existingId)!;
			const updated: GraphNode = {
				...existing,
				...node,
				id: existingId,
				inDegree: existing.inDegree,
				outDegree: existing.outDegree,
			};
			this._nodes.set(existingId, updated);
			// Update BM25 index
			this._bm25.removeDocument(existingId);
			this._bm25.addDocument(existingId, `${node.name} ${node.qualifiedName} ${node.filePath || ''}`);
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

		// Add to BM25 index
		this._bm25.addDocument(id, `${node.name} ${node.qualifiedName} ${node.filePath || ''}`);

		return newNode;
	}

	upsertNodeBatch(nodes: Parameters<typeof this.upsertNode>[0][]): GraphNode[] {
		return nodes.map(n => this.upsertNode(n));
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

	deleteNodesByFile(project: string, filePath: string): void {
		const ids = this._nodesByFile.get(`${project}:${filePath}`) || [];
		for (const id of ids) {
			const node = this._nodes.get(id);
			if (!node) { continue; }
			// Remove from QN index
			this._nodesByQN.delete(`${project}:${node.qualifiedName}`);
			// Remove from BM25
			this._bm25.removeDocument(id);
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
		const dedupKey = `${edge.sourceId}:${edge.targetId}:${edge.type}`;
		if (this._edgeDedup.has(dedupKey)) { return null; }  // Skip duplicate
		this._edgeDedup.add(dedupKey);

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
		this._edgeDedup.delete(`${edge.sourceId}:${edge.targetId}:${edge.type}`);
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

	search(params: SearchParams): SearchResult {
		let candidates: GraphNode[];

		// Label filter
		if (params.label) {
			candidates = this.findNodesByLabel(params.project || '', params.label);
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

		// Exclude labels filter (P1)
		if (params.excludeLabels && params.excludeLabels.length > 0) {
			const excludeSet = new Set(params.excludeLabels);
			candidates = candidates.filter(n => !excludeSet.has(n.label));
		}

		// Name pattern filter
		if (params.namePattern) {
			const flags = params.caseSensitive ? '' : 'i';
			const regex = new RegExp(params.namePattern, flags);
			candidates = candidates.filter(n =>
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

		// Relationship type filter — keep nodes that have edges of the specified type
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

		const total = candidates.length;
		const offset = params.offset || 0;
		const limit = params.limit || 100;
		const nodes = candidates.slice(offset, offset + limit);

		// Include directly connected nodes (P1)
		if (params.includeConnected && nodes.length > 0) {
			const connectedSet = new Set(nodes.map(n => n.id));
			const connectedNodes: GraphNode[] = [];
			for (const node of nodes) {
				// Outgoing edges
				for (const edge of this.getEdgesBySource(node.id)) {
					if (!connectedSet.has(edge.targetId)) {
						const target = this._nodes.get(edge.targetId);
						if (target && target.project === (params.project || target.project)) {
							connectedSet.add(target.id);
							connectedNodes.push(target);
						}
					}
				}
				// Incoming edges
				for (const edge of this.getEdgesByTarget(node.id)) {
					if (!connectedSet.has(edge.sourceId)) {
						const source = this._nodes.get(edge.sourceId);
						if (source && source.project === (params.project || source.project)) {
							connectedSet.add(source.id);
							connectedNodes.push(source);
						}
					}
				}
			}
			nodes.push(...connectedNodes.slice(0, limit * 2)); // cap connected nodes
		}

		return { nodes, total };
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
		this._nodesByQN.clear();
		this._nodesByFile.clear();
		this._nodesByLabel.clear();
		this._outEdges.clear();
		this._inEdges.clear();
		this._fileHashes.clear();
		this._bm25.clear();
		this._layout.clear();
		this._nextNodeId = 1;
		this._nextEdgeId = 1;
	}

	toJSON(): any {
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
			this._edgeDedup.add(`${edge.sourceId}:${edge.targetId}:${edge.type}`);
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
				this._edgeDedup.add(`${edge.sourceId}:${edge.targetId}:${edge.type}`);
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

	// ─── Transaction / Checkpoint / Integrity (对标 SQLite WAL) ──────────

	private _transactionSnapshot: any = undefined;
	private _inTransaction = false;

	/** Begin a transaction — snapshot current state for rollback. */
	beginTransaction(): void {
		if (this._inTransaction) { return; }
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
			.replace(/\?/g, '.');
		return new RegExp(escaped, 'i');
	}
}
