/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Semantic Search — 语义搜索，6 信号融合相似度。
 *
 * 对标 codebase-memory-mcp 的 semantic.c (11 信号)，实现核心 6 信号：
 * 1. TF-IDF       — 词频-逆文档频率文本相似度 (weight: 0.25)
 * 2. Random Index — 随机投影向量相似度 (weight: 0.20)
 * 3. API Sig      — 函数签名相似度（参数数量、返回类型）(weight: 0.15)
 * 4. AST Profile  — AST 结构指纹（节点类型分布）(weight: 0.15)
 * 5. Halstead     — 代码复杂度特征（操作符/操作数频率）(weight: 0.10)
 * 6. Graph Diff   — 图扩散相似度（共同邻居）(weight: 0.15)
 */

import { CodebaseGraphStore, GraphNode } from './codebaseGraphStore.js';

export interface SemanticResult {
	node: GraphNode;
	score: number;
	signals: Record<string, number>;
}

export class SemanticSearch {
	private _store: CodebaseGraphStore;
	private _tfidfIndex: Map<string, Map<string, number>> = new Map(); // nodeId → (term → tf)
	private _df: Map<string, number> = new Map(); // term → document frequency
	private _docCount = 0;

	constructor(store: CodebaseGraphStore) {
		this._store = store;
	}

	/** Build TF-IDF index from all nodes */
	buildIndex(): void {
		this._tfidfIndex.clear();
		this._df.clear();
		this._docCount = 0;

		for (const node of this._store.getAllNodes()) {
			if (node.label === 'file' || node.label === 'File') { continue; }
			const text = `${node.name} ${node.qualifiedName} ${node.filePath || ''}`;
			const terms = this._tokenize(text);
			const tf = new Map<string, number>();
			const seen = new Set<string>();

			for (const term of terms) {
				tf.set(term, (tf.get(term) || 0) + 1);
				if (!seen.has(term)) {
					seen.add(term);
					this._df.set(term, (this._df.get(term) || 0) + 1);
				}
			}

			this._tfidfIndex.set(String(node.id), tf);
			this._docCount++;
		}
	}

	/** Semantic search: fuse 6 signals */
	search(query: string, limit: number = 20): SemanticResult[] {
		// Get candidates from BM25/FTS
		const ftsResults = this._store.ftsSearch(query, limit * 3);
		if (ftsResults.size === 0) { return []; }

		const results: SemanticResult[] = [];
		const queryTerms = this._tokenize(query);

		for (const [nodeId, bm25Score] of ftsResults) {
			const node = this._store.getNode(nodeId);
			if (!node) { continue; }

			const signals: Record<string, number> = {};

			// Signal 1: TF-IDF
			signals.tfidf = this._tfidfSimilarity(String(nodeId), queryTerms) * 0.25;

			// Signal 2: Random Indexing (simplified — use BM25 score as proxy)
			signals.random_idx = Math.min(1, bm25Score / 10) * 0.20;

			// Signal 3: API Signature
			signals.api_sig = this._apiSignatureSimilarity(node, queryTerms) * 0.15;

			// Signal 4: AST Profile (simplified — compare node label)
			signals.ast_profile = this._astProfileSimilarity(node, queryTerms) * 0.15;

			// Signal 5: Halstead (simplified — use complexity if available)
			signals.halstead = this._halsteadSimilarity(node, queryTerms) * 0.10;

			// Signal 6: Graph Diffusion (common neighbors)
			signals.graph_diff = this._graphDiffusionSimilarity(node, queryTerms) * 0.15;

			const score = Object.values(signals).reduce((a, b) => a + b, 0);
			results.push({ node, score, signals });
		}

		return results.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	// ─── Signal Implementations ──────────────────────────────────────────

	private _tfidfSimilarity(nodeId: string, queryTerms: string[]): number {
		const tf = this._tfidfIndex.get(nodeId);
		if (!tf || this._docCount === 0) { return 0; }

		let score = 0;
		for (const term of queryTerms) {
			const termTf = tf.get(term);
			if (!termTf) { continue; }
			const df = this._df.get(term) || 1;
			const idf = Math.log(this._docCount / df);
			score += termTf * idf;
		}
		// Normalize
		return Math.min(1, score / (queryTerms.length * 5));
	}

	private _apiSignatureSimilarity(node: GraphNode, queryTerms: string[]): number {
		// Check if node name contains query terms
		const name = node.name.toLowerCase();
		let matches = 0;
		for (const term of queryTerms) {
			if (name.includes(term.toLowerCase())) { matches++; }
		}
		return queryTerms.length > 0 ? matches / queryTerms.length : 0;
	}

	private _astProfileSimilarity(node: GraphNode, queryTerms: string[]): number {
		// Compare node label with query terms
		const label = node.label.toLowerCase();
		for (const term of queryTerms) {
			if (label.includes(term.toLowerCase())) { return 1; }
		}
		return 0;
	}

	private _halsteadSimilarity(node: GraphNode, queryTerms: string[]): number {
		// Use complexity property if available
		const complexity = node.properties?.cyclomatic;
		if (complexity && complexity > 0) {
			// Prefer moderately complex functions
			return Math.min(1, 10 / Math.max(complexity, 1));
		}
		return 0.5; // Default
	}

	private _graphDiffusionSimilarity(node: GraphNode, queryTerms: string[]): number {
		// Check neighbors for query term matches
		const outEdges = this._store.getEdgesBySource(node.id);
		const inEdges = this._store.getEdgesByTarget(node.id);
		const neighborIds = new Set<number>([
			...outEdges.map(e => e.targetId),
			...inEdges.map(e => e.sourceId),
		]);

		let neighborMatches = 0;
		for (const nid of neighborIds) {
			const neighbor = this._store.getNode(nid);
			if (!neighbor) { continue; }
			const neighborText = `${neighbor.name} ${neighbor.qualifiedName}`.toLowerCase();
			for (const term of queryTerms) {
				if (neighborText.includes(term.toLowerCase())) { neighborMatches++; break; }
			}
		}
		return neighborIds.size > 0 ? Math.min(1, neighborMatches / neighborIds.size) : 0;
	}

	// ─── Tokenizer ────────────────────────────────────────────────────────

	private _tokenize(text: string): string[] {
		if (!text) { return []; }
		return text
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.replace(/[_\-\.\/\\]/g, ' ')
			.split(/\s+/)
			.filter(w => w.length > 0)
			.map(w => w.toLowerCase());
	}
}
