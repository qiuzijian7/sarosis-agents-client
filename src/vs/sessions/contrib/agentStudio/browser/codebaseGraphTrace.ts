/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Trace Path — 调用路径追踪工具。
 *
 * 对标 codebase-memory-mcp 的 trace_path MCP 工具：
 * - calls 模式：追踪函数调用链（CALLS 边 BFS）
 * - data_flow 模式：追踪数据流（DATA_FLOWS 边）
 * - cross_service 模式：追踪跨服务调用（HTTP_CALLS 边）
 * - 风险分级：每跳根据节点入度/出度评估风险
 */

import { CodebaseGraphStore, GraphNode, GraphEdge } from './codebaseGraphStore.js';

export type TraceMode = 'calls' | 'data_flow' | 'cross_service';

export interface TraceHop {
	node: GraphNode;
	depth: number;
	risk: RiskLevel;
	riskReason: string;
}

export type RiskLevel = 'Critical' | 'High' | 'Medium' | 'Low';

export interface TraceResult {
	found: boolean;
	hops: TraceHop[];
	totalDepth: number;
	sourceNode?: GraphNode;
	targetNode?: GraphNode;
	summary: string;
}

const EDGE_TYPE_MAP: Record<TraceMode, string[]> = {
	calls: ['CALLS'],
	data_flow: ['DATA_FLOWS', 'USAGE'],
	cross_service: ['HTTP_CALLS', 'ASYNC_CALLS'],
};

const MAX_TRACE_DEPTH = 15;
const MAX_TRACE_NODES = 200;

export function tracePath(
	store: CodebaseGraphStore,
	project: string,
	sourceName: string,
	targetName: string | undefined,
	mode: TraceMode = 'calls',
	maxDepth: number = 10,
	direction: 'both' | 'callers' | 'callees' = 'callees',
	includeTests: boolean = true,
): TraceResult {
	const edgeTypes = EDGE_TYPE_MAP[mode] || ['CALLS'];
	const effectiveMaxDepth = Math.min(maxDepth, MAX_TRACE_DEPTH);

	// Find source node
	const sourceNodes = store.search({
		project,
		namePattern: escapeRegex(sourceName),
		limit: 10,
	});

	if (sourceNodes.nodes.length === 0) {
		return { found: false, hops: [], totalDepth: 0, summary: `Source "${sourceName}" not found` };
	}

	const sourceNode = sourceNodes.nodes[0];
	const hops: TraceHop[] = [{ node: sourceNode, depth: 0, risk: 'Low', riskReason: '起点' }];

	// Find target node (if specified)
	let targetNodeId: number | undefined;
	if (targetName) {
		const targetNodes = store.search({
			project,
			namePattern: escapeRegex(targetName),
			limit: 10,
		});
		if (targetNodes.nodes.length > 0) {
			targetNodeId = targetNodes.nodes[0].id;
		}
	}

	// BFS with direction support
	const visited: Set<number> = new Set([sourceNode.id]);
	const queue: { nodeId: number; depth: number }[] = [{ nodeId: sourceNode.id, depth: 0 }];
	let found = false;

	while (queue.length > 0 && hops.length < MAX_TRACE_NODES) {
		const { nodeId, depth } = queue.shift()!;
		if (depth >= effectiveMaxDepth) { continue; }

		// Collect edges based on direction
		const edgesToTraverse: GraphEdge[] = [];
		if (direction === 'callees' || direction === 'both') {
			// Forward: follow outgoing edges (callees)
			edgesToTraverse.push(...store.getEdgesBySource(nodeId));
		}
		if (direction === 'callers' || direction === 'both') {
			// Reverse: follow incoming edges (callers)
			edgesToTraverse.push(...store.getEdgesByTarget(nodeId));
		}

		for (const edge of edgesToTraverse) {
			if (!edgeTypes.includes(edge.type)) { continue; }

			// Determine the "other" node based on direction
			const otherId = direction === 'callers' ? edge.sourceId : edge.targetId;
			if (visited.has(otherId)) { continue; }

			visited.add(otherId);
			const otherNode = store.getNode(otherId);
			if (!otherNode) { continue; }

			// Skip test functions if includeTests is false
			if (!includeTests && otherNode.properties?.isTest) { continue; }

			const risk = assessHopRisk(otherNode, depth);
			hops.push({
				node: otherNode,
				depth: depth + 1,
				risk: risk.level,
				riskReason: risk.reason,
			});

			if (targetNodeId !== undefined && otherId === targetNodeId) {
				found = true;
			}

			queue.push({ nodeId: otherId, depth: depth + 1 });
		}

		if (found && targetNodeId !== undefined) { break; }
	}

	const totalDepth = Math.max(...hops.map(h => h.depth));
	const summary = buildTraceSummary(sourceNode, targetName, found, hops, mode);

	return {
		found: found || targetNodeId === undefined,
		hops,
		totalDepth,
		sourceNode,
		targetNode: targetNodeId !== undefined ? store.getNode(targetNodeId) : undefined,
		summary,
	};
}

// ─── Risk Assessment ─────────────────────────────────────────────────────────

function assessHopRisk(node: GraphNode, depth: number): { level: RiskLevel; reason: string } {
	let score = 0;
	const reasons: string[] = [];

	// High in-degree = critical dependency
	if (node.inDegree >= 20) {
		score += 4;
		reasons.push(`高入度 ${node.inDegree}`);
	} else if (node.inDegree >= 10) {
		score += 2;
		reasons.push(`中入度 ${node.inDegree}`);
	}

	// High out-degree = complex logic
	if (node.outDegree >= 15) {
		score += 2;
		reasons.push(`高出度 ${node.outDegree}`);
	}

	// Deep chain = harder to trace
	if (depth >= 8) {
		score += 1;
		reasons.push(`深层调用 ${depth} 级`);
	}

	// Entry point = high impact
	if (node.inDegree === 0 && node.label === 'function') {
		score += 2;
		reasons.push('入口点函数');
	}

	let level: RiskLevel = 'Low';
	if (score >= 6) { level = 'Critical'; }
	else if (score >= 4) { level = 'High'; }
	else if (score >= 2) { level = 'Medium'; }

	return { level, reason: reasons.join('; ') || '正常' };
}

// ─── Summary ────────────────────────────────────────────────────────────────

function buildTraceSummary(
	source: GraphNode,
	targetName: string | undefined,
	found: boolean,
	hops: TraceHop[],
	mode: TraceMode
): string {
	const modeDesc = {
		calls: '调用链',
		data_flow: '数据流',
		cross_service: '跨服务调用',
	}[mode];

	if (targetName) {
		if (found) {
			const pathStr = hops.map(h => h.node.name).join(' → ');
			return `${modeDesc}: ${pathStr}`;
		}
		return `${modeDesc}: 从 ${source.name} 未找到到 ${targetName} 的路径`;
	}

	return `${modeDesc}: 从 ${source.name} 追踪到 ${hops.length - 1} 个下游节点 (深度 ${Math.max(...hops.map(h => h.depth))})`;
}

// ─── Get Code Snippet ─────────────────────────────────────────────────────────

export interface CodeSnippet {
	filePath: string;
	startLine: number;
	endLine: number;
	lines: { lineNo: number; text: string }[];
}

/**
 * Get a code snippet from a file with line numbers.
 * 对标 get_code_snippet MCP 工具。
 */
export function getCodeSnippet(
	fileContent: string,
	startLine: number,
	endLine: number,
	contextLines: number = 3
): CodeSnippet {
	const allLines = fileContent.split('\n');
	const start = Math.max(0, startLine - 1 - contextLines);
	const end = Math.min(allLines.length, endLine + contextLines);
	const lines: { lineNo: number; text: string }[] = [];

	for (let i = start; i < end; i++) {
		lines.push({ lineNo: i + 1, text: allLines[i] || '' });
	}

	return {
		filePath: '',
		startLine: start + 1,
		endLine: end,
		lines,
	};
}

// ─── Get Graph Schema ────────────────────────────────────────────────────────

export interface GraphSchema {
	nodeLabels: { label: string; count: number }[];
	edgeTypes: { type: string; count: number }[];
	totalNodes: number;
	totalEdges: number;
}

/**
 * Get the graph schema (node labels + edge types).
 * 对标 get_graph_schema MCP 工具。
 */
export function getGraphSchema(store: CodebaseGraphStore, project: string): GraphSchema {
	const nodeLabels = Array.from(store.getNodeTypes(project).entries())
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count);

	const edgeTypes = Array.from(store.getEdgeTypes(project).entries())
		.map(([type, count]) => ({ type, count }))
		.sort((a, b) => b.count - a.count);

	return {
		nodeLabels,
		edgeTypes,
		totalNodes: store.getNodeCount(project),
		totalEdges: store.getEdgeCount(project),
	};
}

// ─── Search Code (graph-augmented grep) ───────────────────────────────────────

export interface CodeSearchResult {
	filePath: string;
	lineNo: number;
	text: string;
	node?: GraphNode;
	relevanceScore: number;
}

/**
 * Graph-augmented code search.
 * 对标 search_code MCP 工具 — grep + 按图结构重要性排序。
 */
export function searchCode(
	store: CodebaseGraphStore,
	project: string,
	query: string,
	fileContentProvider: (filePath: string) => string | undefined,
	limit: number = 50
): CodeSearchResult[] {
	const results: CodeSearchResult[] = [];
	const regex = new RegExp(escapeRegex(query), 'i');

	// Get all file nodes
	const fileNodes = store.findNodesByLabel(project, 'file');

	for (const fileNode of fileNodes) {
		if (!fileNode.filePath) { continue; }
		const content = fileContentProvider(fileNode.filePath);
		if (!content) { continue; }

		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			if (regex.test(lines[i])) {
				// Find enclosing definition node
				const defNodes = store.findNodesByFile(project, fileNode.filePath);
				const enclosing = defNodes.find(n =>
					n.startLine !== undefined && n.endLine !== undefined &&
					n.startLine <= i + 1 && n.endLine >= i + 1
				);

				// Relevance score: in-degree of enclosing definition
				const score = enclosing ? enclosing.inDegree + 1 : 1;

				results.push({
					filePath: fileNode.filePath,
					lineNo: i + 1,
					text: lines[i].trim(),
					node: enclosing,
					relevanceScore: score,
				});
			}
		}
	}

	return results
		.sort((a, b) => b.relevanceScore - a.relevanceScore)
		.slice(0, limit);
}

// ─── Index Status ─────────────────────────────────────────────────────────────

export interface IndexStatus {
	project: string;
	exists: boolean;
	nodeCount: number;
	edgeCount: number;
	fileCount: number;
	lastModified?: string;
}

/**
 * Get project index status.
 * 对标 index_status MCP 工具。
 */
export function getIndexStatus(store: CodebaseGraphStore, project: string): IndexStatus {
	const nodeCount = store.getNodeCount(project);
	const fileHashes = store.getAllFileHashes(project);

	return {
		project,
		exists: nodeCount > 0,
		nodeCount,
		edgeCount: store.getEdgeCount(project),
		fileCount: fileHashes.length,
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
