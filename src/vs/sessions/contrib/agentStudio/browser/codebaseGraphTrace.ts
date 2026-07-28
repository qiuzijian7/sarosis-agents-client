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
	project: string | undefined,
	sourceName: string,
	targetName: string | undefined,
	mode: TraceMode = 'calls',
	maxDepth: number = 10,
	direction: 'both' | 'callers' | 'callees' = 'callees',
	includeTests: boolean = true,
	edgeTypesOverride?: string[],
): TraceResult {
	const edgeTypes = (edgeTypesOverride && edgeTypesOverride.length > 0)
		? edgeTypesOverride
		: (EDGE_TYPE_MAP[mode] || ['CALLS']);
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

/** 单个属性的聚合统计（对齐 C 版 get_graph_schema 的 attributes 字段）。 */
export interface AttributeStat {
	name: string;
	count: number;        // 拥有该属性的节点/边数
	types: string[];      // 观测到的 JS typeof 取值（去重、排序）
}

export interface NodeLabelSchema {
	label: string;
	count: number;
	properties: AttributeStat[];   // 按 count 降序，对齐 C 的 attributes
}

export interface EdgeTypeSchema {
	type: string;
	count: number;
	properties: AttributeStat[];
}

export interface GraphSchema {
	nodeLabels: NodeLabelSchema[];    // 兼容旧 {label,count}（含 properties）
	edgeTypes: EdgeTypeSchema[];      // 兼容旧 {type,count}（含 properties）
	totalNodes: number;
	totalEdges: number;
}

/**
 * 聚合一组 properties 记录，得到每个属性名出现的次数与类型分布。
 * props[i] 可能为 undefined（节点无 properties 字段）。
 */
function _aggregateAttributeStats(props: (Record<string, any> | undefined)[]): AttributeStat[] {
	const stats = new Map<string, { count: number; types: Set<string> }>();
	for (const p of props) {
		if (!p) { continue; }
		for (const [k, v] of Object.entries(p)) {
			const entry = stats.get(k) ?? { count: 0, types: new Set<string>() };
			entry.count++;
			entry.types.add(v === null ? 'null' : typeof v);
			stats.set(k, entry);
		}
	}
	return Array.from(stats.entries())
		.map(([name, { count, types }]) => ({ name, count, types: Array.from(types).sort() }))
		.sort((a, b) => b.count - a.count);
}

/**
 * Get the graph schema (node labels + edge types + 每个类型的属性 schema).
 * 对标 get_graph_schema MCP 工具 — 现补齐 attributes 字段统计（P2-#5）。
 */
export function getGraphSchema(store: CodebaseGraphStore, project: string): GraphSchema {
	const nodes = store.getAllNodes().filter(n => n.project === project);
	const edges = store.getAllEdges().filter(e => e.project === project);

	const nodesByLabel = new Map<string, (Record<string, any> | undefined)[]>();
	const nodeTotalByLabel = new Map<string, number>();
	for (const n of nodes) {
		nodeTotalByLabel.set(n.label, (nodeTotalByLabel.get(n.label) ?? 0) + 1);
		const bucket = nodesByLabel.get(n.label) ?? [];
		bucket.push(n.properties);
		nodesByLabel.set(n.label, bucket);
	}

	const nodeLabels: NodeLabelSchema[] = Array.from(nodeTotalByLabel.entries())
		.map(([label, count]) => ({
			label,
			count,
			properties: _aggregateAttributeStats(nodesByLabel.get(label) ?? []),
		}))
		.sort((a, b) => b.count - a.count);

	const edgesByType = new Map<string, (Record<string, any> | undefined)[]>();
	const edgeTotalByType = new Map<string, number>();
	for (const e of edges) {
		edgeTotalByType.set(e.type, (edgeTotalByType.get(e.type) ?? 0) + 1);
		const bucket = edgesByType.get(e.type) ?? [];
		bucket.push(e.properties);
		edgesByType.set(e.type, bucket);
	}

	const edgeTypes: EdgeTypeSchema[] = Array.from(edgeTotalByType.entries())
		.map(([type, count]) => ({
			type,
			count,
			properties: _aggregateAttributeStats(edgesByType.get(type) ?? []),
		}))
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
	isFileIndexed: boolean;  // 文件是否有图节点（defNodes.length > 0）
}

/**
 * Graph-augmented code search.
 * 对标 search_code MCP 工具 — grep + 按图结构重要性排序。
 *
 * 性能优化（对齐 C 版 mcp.c）：
 * - GREP_MAX_MATCHES=500 截断保护，防止超大项目搜索爆炸
 * - per-file defNodes 缓存，避免同一文件多次 findNodesByFile 调用
 * - 多因子排名：label 加权（Function/Method +10, Route +15, Class +5）+
 *   vendored 惩罚（-50）、test 惩罚（-5）+ inDegree
 */
const GREP_MAX_MATCHES = 500;

/** 多因子排名评分（对齐 C 版 compute_search_score） */
function computeSearchScore(node: any, filePath: string): number {
	let score = 0;
	// label 类型加权
	const label = (node?.label || node?.type || '').toLowerCase();
	if (label === 'function' || label === 'method') { score += 10; }
	else if (label === 'route' || label === 'endpoint') { score += 15; }
	else if (label === 'class' || label === 'interface') { score += 5; }
	// vendored 惩罚（node_modules / vendor / third_party / .vendor）
	const fp = filePath.toLowerCase();
	if (fp.includes('node_modules') || fp.includes('/vendor/') || fp.includes('/third_party/') || fp.includes('/.vendor/')) {
		score -= 50;
	}
	// test 惩罚（test/spec/__tests__）
	if (fp.includes('/test/') || fp.includes('/tests/') || fp.includes('/__tests__/') || fp.includes('.test.') || fp.includes('.spec.') || fp.includes('_test.')) {
		score -= 5;
	}
	// inDegree 加权
	score += node?.inDegree ?? 0;
	return score;
}

export function searchCode(
	store: CodebaseGraphStore,
	project: string,
	query: string,
	fileContentProvider: (filePath: string) => string | undefined,
	limit: number = 50,
	useRegex: boolean = false
): { results: CodeSearchResult[]; totalMatches: number } {
	const results: CodeSearchResult[] = [];
	// useRegex=true: 把 query 当正则；否则转义为字面量（对标 C 的 regex 显式开关）。
	// 非法正则回退到字面量匹配，避免抛错。
	// 安全说明：query 仅用于 new RegExp 构造，不涉及 shell 执行，无命令注入风险。
	let regex: RegExp;
	try {
		regex = new RegExp(useRegex ? query : escapeRegex(query), 'i');
	} catch {
		regex = new RegExp(escapeRegex(query), 'i');
	}

	// Get all file nodes（多 folder：project 为空时跨所有项目；getAllFileNodes 内部兼容
	// 'file'/'File' 大小写及无 file 节点回退到含 filePath 节点去重）
	const fileNodes = store.getAllFileNodes(project || undefined);
	// per-file defNodes 缓存：避免同一文件多个匹配行重复调用 findNodesByFile（O(1) 哈希查找）
	const defNodesCache = new Map<string, any[]>();

	outer: for (const fileNode of fileNodes) {
		if (!fileNode.filePath) { continue; }
		const content = fileContentProvider(fileNode.filePath);
		if (!content) { continue; }

		// 廉价预过滤：字面量查询若完全不出现在文件中，直接跳过逐行正则（大幅降低 CPU）。
		// useRegex=true 时无法做安全的子串预判，跳过快路径。
		if (!useRegex) {
			const needle = query.toLowerCase();
			if (content.toLowerCase().indexOf(needle) === -1) { continue; }
		}

		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			if (regex.test(lines[i])) {
				// 懒加载 defNodes 缓存（多 folder：用文件节点自身的 project 查同文件定义节点）
				const cacheKey = `${fileNode.project}:${fileNode.filePath}`;
				let defNodes = defNodesCache.get(cacheKey);
				if (defNodes === undefined) {
					defNodes = store.findNodesByFile(fileNode.project || project, fileNode.filePath);
					defNodesCache.set(cacheKey, defNodes);
				}
				const enclosing = defNodes.find(n =>
					n.startLine !== undefined && n.endLine !== undefined &&
					n.startLine <= i + 1 && n.endLine >= i + 1
				);

				// 多因子排名（对齐 C 版 compute_search_score）
				const score = enclosing ? computeSearchScore(enclosing, fileNode.filePath) : 1;

				results.push({
					filePath: fileNode.filePath,
					lineNo: i + 1,
					text: lines[i].trim(),
					node: enclosing,
					relevanceScore: score,
					isFileIndexed: defNodes.length > 0,
				});

				// grep 级截断保护（对齐 C 版 GREP_MAX_MATCHES=500）
				if (results.length >= GREP_MAX_MATCHES) { break outer; }
			}
		}
	}

	const sorted = results.sort((a, b) => b.relevanceScore - a.relevanceScore);
	return { results: sorted.slice(0, limit), totalMatches: sorted.length };
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
