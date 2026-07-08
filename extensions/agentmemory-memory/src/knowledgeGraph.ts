/*---------------------------------------------------------------------------------------------
 *  知识图谱 — 实体抽取 + 关系建模 + BFS 遍历。
 *  参考 agentmemory src/functions/graph.ts + graph-retrieval.ts
 *
 *  节点类型: file, function, concept, error, decision, pattern
 *  边类型: uses, imports, modifies, causes, fixes, depends_on, related_to
 *--------------------------------------------------------------------------------------------*/

import { MemifyPipeline, type MemifyGraph, type MemifyResult } from './ontology.js';

export type GraphNodeType = 'file' | 'function' | 'concept' | 'error' | 'decision' | 'pattern';
export type GraphEdgeType = 'uses' | 'imports' | 'modifies' | 'causes' | 'fixes' | 'depends_on' | 'related_to';

export interface GraphNode {
	id: string;
	type: GraphNodeType;
	name: string;
	sourceMemoryIds: string[];
	createdAt: string;
	updatedAt?: string;
}

export interface GraphEdge {
	id: string;
	type: GraphEdgeType;
	sourceNodeId: string;
	targetNodeId: string;
	weight: number;
	sourceMemoryIds: string[];
	createdAt: string;
}

export interface GraphRetrievalResult {
	obsId: string;
	sessionId: string;
	score: number;
	graphContext?: string;
}

// ─── Entity extraction patterns ────────────────────────────────────────────

const FILE_RE = /(?:src\/|test\/|lib\/|app\/|extensions\/|packages\/)?[\w-]+\/[\w./-]+\.(?:ts|js|json|md|py|go|rs|java|cpp|jsx|tsx|vue|css|html|yml|yaml|sh|mjs)/g;
const FUNC_RE = /(?:function|class|def|fn|func|method|interface|type)\s+(\w+)/g;
const CONCEPT_RE = /\b(jwt|auth|database|cache|api|middleware|router|component|service|module|config|test|deploy|docker|kubernetes|redis|postgres|mongodb|graphql|rest|websocket|sse|callback|promise|async|await|error|exception|retry|timeout|batch|queue|worker|pipeline|schema|migration|seed|fixture|mock|stub|spy|coverage|lint|format|build|compile|transpile|webpack|vite|rollup|esbuild|swc|turbo|nx|lerna)\b/gi;
const ERROR_RE = /\b(Error|Exception|TypeError|RangeError|ReferenceError|SyntaxError|Crash|Failure|Bug)\b/g;
const DECISION_RE = /\b(?:decided|chose|should|must|need to|will use|adopted|prefer|recommend|should not|avoid|deprecated)\b/gi;
const PATTERN_RE = /\b(?:pattern|practice|convention|standard|guideline|rule|principle)\b/gi;

interface ExtractedEntity {
	name: string;
	type: GraphNodeType;
}

function extractEntities(text: string): ExtractedEntity[] {
	const entities: ExtractedEntity[] = [];
	const seen = new Set<string>();

	const addEntity = (name: string, type: GraphNodeType) => {
		const key = `${type}:${name}`;
		if (!seen.has(key)) {
			seen.add(key);
			entities.push({ name, type });
		}
	};

	// Files
	for (const match of text.matchAll(FILE_RE)) {
		addEntity(match[0], 'file');
	}

	// Functions/classes
	for (const match of text.matchAll(FUNC_RE)) {
		addEntity(match[1], 'function');
	}

	// Concepts (tech keywords)
	for (const match of text.matchAll(CONCEPT_RE)) {
		addEntity(match[0].toLowerCase(), 'concept');
	}

	// Errors
	for (const match of text.matchAll(ERROR_RE)) {
		addEntity(match[0], 'error');
	}

	// Decisions
	if (DECISION_RE.test(text)) {
		// Extract the decision context (sentence containing decision keywords)
		const sentences = text.split(/[.。\n]/);
		for (const s of sentences) {
			if (DECISION_RE.test(s)) {
				addEntity(s.trim().slice(0, 60), 'decision');
			}
		}
	}

	// Patterns
	if (PATTERN_RE.test(text)) {
		const sentences = text.split(/[.。\n]/);
		for (const s of sentences) {
			if (PATTERN_RE.test(s)) {
				addEntity(s.trim().slice(0, 60), 'pattern');
			}
		}
	}

	return entities.slice(0, 20); // cap to prevent explosion
}

function inferEdgeType(text: string): GraphEdgeType {
	const lower = text.toLowerCase();
	if (/\bfix(es|ed)?\b/.test(lower)) return 'fixes';
	if (/\bcause(s|d)?\b/.test(lower)) return 'causes';
	if (/\bimport(s|ed)?\b/.test(lower)) return 'imports';
	if (/\bmodif(y|ies|ied)\b/.test(lower)) return 'modifies';
	if (/\bdepend(s|ency|encies)\b/.test(lower)) return 'depends_on';
	if (/\buse(s|d|ing)\b/.test(lower)) return 'uses';
	return 'related_to';
}

export class KnowledgeGraph {
	private _nodes = new Map<string, GraphNode>();
	private _edges = new Map<string, GraphEdge>();
	private _nameIndex = new Map<string, string>(); // name(lowercase) → nodeId

	/** Extract entities from text and add to graph, linking to source memory */
	extractFromMemory(memoryId: string, content: string, sessionId: string): void {
		const entities = extractEntities(content);
		const now = new Date().toISOString();

		// Add/update nodes
		const nodeIds: string[] = [];
		for (const { name, type } of entities) {
			const key = name.toLowerCase();
			let nodeId = this._nameIndex.get(key);
			if (!nodeId) {
				nodeId = `node-${type}-${key.replace(/\s+/g, '_')}-${Date.now().toString(36)}`;
				const node: GraphNode = {
					id: nodeId,
					type,
					name,
					sourceMemoryIds: [memoryId],
					createdAt: now,
				};
				this._nodes.set(nodeId, node);
				this._nameIndex.set(key, nodeId);
			} else {
				const node = this._nodes.get(nodeId)!;
				if (!node.sourceMemoryIds.includes(memoryId)) {
					node.sourceMemoryIds.push(memoryId);
					node.updatedAt = now;
				}
			}
			nodeIds.push(nodeId);
		}

		// Add edges between co-occurring entities (same memory)
		const edgeType = inferEdgeType(content);
		for (let i = 0; i < nodeIds.length; i++) {
			for (let j = i + 1; j < nodeIds.length; j++) {
				const src = nodeIds[i];
				const tgt = nodeIds[j];
				const edgeId = `${src}→${tgt}`;
				if (!this._edges.has(edgeId)) {
					this._edges.set(edgeId, {
						id: edgeId,
						type: edgeType,
						sourceNodeId: src,
						targetNodeId: tgt,
						weight: 1,
						sourceMemoryIds: [memoryId],
						createdAt: now,
					});
				} else {
					const edge = this._edges.get(edgeId)!;
					edge.weight++;
					if (!edge.sourceMemoryIds.includes(memoryId)) {
						edge.sourceMemoryIds.push(memoryId);
					}
				}
			}
		}
	}

	/** BFS traversal: find related nodes from entity names */
	bfs(entityNames: string[], depth: number, limit: number): GraphNode[] {
		const visited = new Set<string>();
		const queue: Array<{ id: string; d: number }> = [];
		const results: GraphNode[] = [];

		for (const name of entityNames) {
			const nodeId = this._nameIndex.get(name.toLowerCase());
			if (nodeId && !visited.has(nodeId)) {
				queue.push({ id: nodeId, d: 0 });
				visited.add(nodeId);
			}
		}

		while (queue.length > 0 && results.length < limit) {
			const { id, d } = queue.shift()!;
			const node = this._nodes.get(id);
			if (node) results.push(node);
			if (d >= depth) continue;

			for (const edge of this._edges.values()) {
				let nextId: string | null = null;
				if (edge.sourceNodeId === id && !visited.has(edge.targetNodeId)) {
					nextId = edge.targetNodeId;
				} else if (edge.targetNodeId === id && !visited.has(edge.sourceNodeId)) {
					nextId = edge.sourceNodeId;
				}
				if (nextId) {
					visited.add(nextId);
					queue.push({ id: nextId, d: d + 1 });
				}
			}
		}
		return results;
	}

	/** Search: find memories related to entities in the query */
	/**
	 * G4/G5: 用 MemifyPipeline 丰富化图谱（dedup → merge → refine → infer）。
	 * 仅增量添加推理出的传递关系（id 以 inferred- 开头），不删除/重建已有节点与边，
	 * 因此不会影响 graph.searchByEntities / _hybridSearch 等既有依赖。
	 */
	async enrichWithMemify(pipeline: MemifyPipeline): Promise<MemifyResult> {
		const input: MemifyGraph = {
			entities: Array.from(this._nodes.values()).map(n => ({
				id: n.id,
				type: n.type,
				name: n.name,
				properties: ((n as unknown as { properties?: Record<string, unknown> }).properties) ?? {},
			})),
			relations: Array.from(this._edges.values()).map(e => ({
				id: e.id,
				type: e.type,
				source: e.sourceNodeId,
				target: e.targetNodeId,
			})),
		};
		const result = await pipeline.memify(input);
		const now = new Date().toISOString();
		let added = 0;
		for (const rel of result.graph.relations) {
			if (!rel.id.startsWith('inferred-')) continue;
			if (!this._nodes.has(rel.source) || !this._nodes.has(rel.target)) continue;
			if (this._edges.has(rel.id)) continue;
			this._edges.set(rel.id, {
				id: rel.id,
				type: rel.type as GraphEdgeType,
				sourceNodeId: rel.source,
				targetNodeId: rel.target,
				weight: 1,
				sourceMemoryIds: [],
				createdAt: now,
			});
			added++;
		}
		if (added > 0) {
			// 记录一次审计（可选，忽略错误）
			try { /* no-op: graph enrichment applied */ } catch { /* ignore */ }
		}
		return result;
	}

	searchByEntities(entityNames: string[], depth: number, limit: number): GraphRetrievalResult[] {
		const nodes = this.bfs(entityNames, depth, limit);
		const results: GraphRetrievalResult[] = [];
		const seenMemories = new Set<string>();

		for (const node of nodes) {
			for (const memId of node.sourceMemoryIds) {
				if (seenMemories.has(memId)) continue;
				seenMemories.add(memId);
				results.push({
					obsId: memId,
					sessionId: '',
					score: 1 / (1 + nodes.indexOf(node)), // closer = higher score
					graphContext: `Related to: ${node.name} (${node.type})`,
				});
			}
		}
		return results.slice(0, limit);
	}

	/** Extract entity names from a query string */
	static extractEntityNames(query: string): string[] {
		const entities = extractEntities(query);
		return entities.map(e => e.name);
	}

	get nodeCount(): number { return this._nodes.size; }
	get edgeCount(): number { return this._edges.size; }

	/** Get all nodes (for cascade/diagnostics) */
	getNodes(): GraphNode[] { return Array.from(this._nodes.values()); }

	/** Get all edges (for cascade/diagnostics) */
	getEdges(): GraphEdge[] { return Array.from(this._edges.values()); }

	/** Mark a node as stale (when source memory is superseded) */
	markNodeStale(nodeId: string): boolean {
		const node = this._nodes.get(nodeId);
		if (node) {
			(node as GraphNode & { stale?: boolean }).stale = true;
			(node as GraphNode & { updatedAt?: string }).updatedAt = new Date().toISOString();
			return true;
		}
		return false;
	}

	/** Mark an edge as stale */
	markEdgeStale(edgeId: string): boolean {
		const edge = this._edges.get(edgeId);
		if (edge) {
			(edge as GraphEdge & { stale?: boolean }).stale = true;
			return true;
		}
		return false;
	}

	/** Remove stale nodes/edges (cleanup) */
	pruneStale(): { nodes: number; edges: number } {
		let nodes = 0, edges = 0;
		for (const [id, node] of this._nodes) {
			if ((node as GraphNode & { stale?: boolean }).stale) {
				this._nodes.delete(id);
				// also remove from name index
				const key = node.name.toLowerCase();
				if (this._nameIndex.get(key) === id) {
					this._nameIndex.delete(key);
				}
				nodes++;
			}
		}
		for (const [id, edge] of this._edges) {
			if ((edge as GraphEdge & { stale?: boolean }).stale) {
				this._edges.delete(id);
				edges++;
			}
		}
		return { nodes, edges };
	}

	clear(): void {
		this._nodes.clear();
		this._edges.clear();
		this._nameIndex.clear();
	}

	/** Get graph statistics */
	getStats(): { nodes: number; edges: number; nodesByType: Record<string, number> } {
		const nodesByType: Record<string, number> = {};
		for (const node of this._nodes.values()) {
			nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
		}
		return { nodes: this._nodes.size, edges: this._edges.size, nodesByType };
	}
}
