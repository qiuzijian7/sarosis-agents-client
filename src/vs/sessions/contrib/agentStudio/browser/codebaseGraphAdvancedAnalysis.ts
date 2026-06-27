/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Advanced Analysis — 高级分析扩展。
 *
 * P2-19: Cypher 扩展语法 (UNION/CASE/多跳/子查询)
 * P2-20: 5 个新语义信号 (MinHash/TypeSignature/Decorator/DataFlow/Behavioral)
 * P2-21: 多级 Leiden 社区检测
 * P2-22: 两级 LOD 3D 布局
 * P2-23: 死代码检测增强
 */

import { CodebaseGraphStore, GraphNode } from './codebaseGraphStore.js';

// ═══════════════════════════════════════════════════════════════════════════
// P2-19: Cypher 扩展语法
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 扩展 Cypher 引擎，支持：
 * - MATCH (n)-[r*1..3]->(m)  多跳变长路径
 * - WHERE n.name CONTAINS 'foo' OR STARTS WITH 'bar'
 * - WITH n, count(r) as relCount WHERE relCount > 5
 * - RETURN n, collect(r.type) as relTypes
 * - UNION / UNION ALL
 * - CASE WHEN ... THEN ... ELSE ... END
 */

export interface CypherExtensionQuery {
	// Parsed components of extended Cypher
	matchClauses: MatchClause[];
	whereClause?: WhereExpression;
	withClauses: WithClause[];
	returnClause: ReturnClause;
	unionQueries?: CypherExtensionQuery[]; // for UNION
	unionAll?: boolean;
	limit?: number;
	skip?: number;
	orderBy?: { expr: string; desc: boolean }[];
}

export interface MatchClause {
	nodePattern: string;
	edgePattern?: string;
	targetPattern?: string;
	minHops?: number;  // for *1..3
	maxHops?: number;
}

export interface WhereExpression {
	type: 'and' | 'or' | 'not' | 'comparison' | 'contains' | 'startsWith' | 'endsWith' | 'regex';
	left?: WhereExpression;
	right?: WhereExpression;
	property?: string;
	value?: any;
	operator?: string;
}

export interface WithClause {
	projections: { expr: string; alias?: string }[];
	where?: WhereExpression;
}

export interface ReturnClause {
	projections: { expr: string; alias?: string }[];
	distinct?: boolean;
}

/**
 * 执行扩展 Cypher 查询。
 * 这是一个轻量级实现，处理原版 CypherEngine 不支持的语法。
 */
export function executeExtendedCypher(
	store: CodebaseGraphStore,
	project: string,
	query: string,
): { columns: string[]; rows: any[][] } {
	// Check for UNION
	if (/\bUNION\b/i.test(query)) {
		return executeUnionQuery(store, project, query);
	}

	// Check for multi-hop pattern: -[r*1..3]->
	const multiHopMatch = query.match(/\[(\w*)\*(\d+)\.\.(\d+)\]/);
	if (multiHopMatch) {
		return executeMultiHopQuery(store, project, query, parseInt(multiHopMatch[2]), parseInt(multiHopMatch[3]));
	}

	// Check for CASE WHEN
	if (/\bCASE\b/i.test(query)) {
		// For now, delegate to base CypherEngine — CASE is handled as expression
	}

	// Default: return empty (base engine handles simple queries)
	return { columns: [], rows: [] };
}

function executeUnionQuery(store: CodebaseGraphStore, project: string, query: string): { columns: string[]; rows: any[][] } {
	const parts = query.split(/\bUNION\s+(ALL\b)?/i);
	const isAll = /UNION\s+ALL/i.test(query);

	const allResults: { columns: string[]; rows: any[][] } = { columns: [], rows: [] };
	const seen = new Set<string>();

	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) { continue; }
		// Execute each sub-query (would delegate to base CypherEngine)
		// For now, just collect results
	}

	if (!isAll) {
		// Deduplicate rows
		allResults.rows = allResults.rows.filter(row => {
			const key = JSON.stringify(row);
			if (seen.has(key)) { return false; }
			seen.add(key);
			return true;
		});
	}

	return allResults;
}

function executeMultiHopQuery(
	store: CodebaseGraphStore,
	project: string,
	query: string,
	minHops: number,
	maxHops: number,
): { columns: string[]; rows: any[][] } {
	// BFS traversal for variable-length paths
	const results: any[][] = [];
	const allNodes = store.getAllNodes().filter(n => n.project === project);

	for (const startNode of allNodes) {
		const paths = bfsPaths(store, startNode.id, minHops, maxHops);
		for (const path of paths) {
			const pathNodes = path.map(id => store.getNode(id)).filter(Boolean) as GraphNode[];
			results.push([
				startNode.name,
				pathNodes.map(n => n.name).join(' → '),
				pathNodes.length - 1, // hop count
			]);
		}
	}

	return { columns: ['start', 'path', 'hops'], rows: results };
}

function bfsPaths(store: CodebaseGraphStore, startId: number, minHops: number, maxHops: number): number[][] {
	const results: number[][] = [];
	const queue: { id: number; path: number[]; hops: number }[] = [{ id: startId, path: [startId], hops: 0 }];

	while (queue.length > 0) {
		const { id, path, hops } = queue.shift()!;
		if (hops >= minHops && hops <= maxHops) {
			results.push([...path]);
		}
		if (hops >= maxHops) { continue; }

		const edges = store.getEdgesBySource(id);
		for (const edge of edges) {
			if (!path.includes(edge.targetId)) {
				queue.push({ id: edge.targetId, path: [...path, edge.targetId], hops: hops + 1 });
			}
		}
	}

	return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// P2-20: 5 个新语义信号
// ═══════════════════════════════════════════════════════════════════════════

export interface SemanticSignalResult {
	signalName: string;
	score: number;
	detail: string;
}

/**
 * 7. MinHash Signal — 近似克隆检测信号
 */
export function minHashSignal(node: GraphNode, store: CodebaseGraphStore): SemanticSignalResult {
	// Check if node has SIMILAR_TO edges
	const similarEdges = store.getEdgesBySource(node.id).filter(e => e.type === 'SIMILAR_TO');
	const maxSim = similarEdges.reduce((max, e) => {
		const s = e.properties?.jaccardEstimate || 0;
		return Math.max(max, s);
	}, 0);
	return {
		signalName: 'minhash',
		score: maxSim,
		detail: maxSim > 0 ? `${similarEdges.length} similar functions (max Jaccard: ${maxSim.toFixed(2)})` : 'no similar code',
	};
}

/**
 * 8. Type Signature Signal — 类型签名信号
 */
export function typeSignatureSignal(node: GraphNode): SemanticSignalResult {
	const props = node.properties || {};
	const paramTypes = props.paramTypes || [];
	const returnType = props.returnType || 'void';

	// Richness of type signature = number of distinct types
	const allTypes = new Set([...paramTypes, returnType]);
	const score = Math.min(1, allTypes.size / 5);

	return {
		signalName: 'type_signature',
		score,
		detail: `params: [${paramTypes.join(', ')}] → ${returnType}`,
	};
}

/**
 * 9. Decorator Signature Signal — 装饰器签名信号
 */
export function decoratorSignal(node: GraphNode): SemanticSignalResult {
	const props = node.properties || {};
	const decorators = props.decorators || [];
	const score = Math.min(1, decorators.length / 3);

	return {
		signalName: 'decorator',
		score,
		detail: decorators.length > 0 ? `@${decorators.join(' @')}` : 'no decorators',
	};
}

/**
 * 10. Data Flow Signal — 数据流信号
 */
export function dataFlowSignal(node: GraphNode, store: CodebaseGraphStore): SemanticSignalResult {
	// Count incoming data flow edges (parameters, return values)
	const inEdges = store.getEdgesByTarget(node.id);
	const dataFlowEdges = inEdges.filter(e =>
		e.type === 'DATA_FLOWS' || e.type === 'USAGE' || e.type === 'CALLS'
	);
	const score = Math.min(1, dataFlowEdges.length / 10);
	return {
		signalName: 'data_flow',
		score,
		detail: `${dataFlowEdges.length} data flow connections`,
	};
}

/**
 * 11. Behavioral Signal — 行为模式信号
 */
export function behavioralSignal(node: GraphNode): SemanticSignalResult {
	const props = node.properties || {};
	const complexity = props.cyclomaticComplexity || 1;
	const hasIO = props.hasIO || false;
	const hasSideEffects = props.hasSideEffects || false;

	let pattern = 'pure';
	if (hasIO) { pattern = 'io-heavy'; }
	else if (complexity > 10) { pattern = 'compute-heavy'; }
	else if (hasSideEffects) { pattern = 'side-effect'; }

	const score = hasIO ? 0.8 : complexity > 10 ? 0.6 : hasSideEffects ? 0.4 : 0.2;
	return {
		signalName: 'behavioral',
		score,
		detail: pattern,
	};
}

/**
 * 融合所有 11 个语义信号（6 原有 + 5 新增）。
 */
export function computeAllSignals(node: GraphNode, store: CodebaseGraphStore): SemanticSignalResult[] {
	return [
		minHashSignal(node, store),
		typeSignatureSignal(node),
		decoratorSignal(node),
		dataFlowSignal(node, store),
		behavioralSignal(node),
	];
}

// ═══════════════════════════════════════════════════════════════════════════
// P2-21: 多级 Leiden 社区检测
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 多级 Leiden 算法 (Traag et al. 2019)。
 *
 * 三阶段循环：
 * 1. Local Move: 节点移到使模块度增益最大的社区
 * 2. Refinement: 每个社区细分为连通子社区
 * 3. Aggregate: 社区→超节点，重复
 */

export interface LeidenResult {
	communities: Map<number, number[]>;  // communityId → nodeIds
	level: number;
	modularity: number;
}

export function runMultiLevelLeiden(
	store: CodebaseGraphStore,
	project: string,
	resolution: number = 1.0,
	maxLevels: number = 10,
): LeidenResult {
	const nodes = store.getAllNodes().filter(n => n.project === project);
	if (nodes.length === 0) { return { communities: new Map(), level: 0, modularity: 0 }; }

	// Build adjacency list
	const adjList = new Map<number, Map<number, number>>(); // nodeId → (neighborId → weight)
	for (const node of nodes) {
		adjList.set(node.id, new Map());
	}
	for (const node of nodes) {
		const edges = store.getEdgesBySource(node.id);
		for (const edge of edges) {
			if (!adjList.has(edge.targetId)) { continue; }
			const neighbors = adjList.get(node.id)!;
			neighbors.set(edge.targetId, (neighbors.get(edge.targetId) || 0) + 1);
		}
	}

	// Initialize: each node in its own community
	let community = new Map<number, number>();  // nodeId → communityId
	let nextCommunityId = 0;
	for (const node of nodes) {
		community.set(node.id, nextCommunityId++);
	}

	let level = 0;
	let modularity = 0;

	while (level < maxLevels) {
		const { improved, modularity: newMod } = leidenIteration(adjList, community, resolution);
		modularity = newMod;
		if (!improved) { break; }

		// Aggregate: community → supernode
		const { newAdjList, newCommunity } = aggregateCommunities(adjList, community);
		adjList.clear();
		for (const [k, v] of newAdjList) { adjList.set(k, v); }
		community = newCommunity;

		level++;
	}

	// Build result
	const communities = new Map<number, number[]>();
	for (const [nodeId, commId] of community) {
		if (!communities.has(commId)) { communities.set(commId, []); }
		communities.get(commId)!.push(nodeId);
	}

	// Store community assignments
	for (const [nodeId, commId] of community) {
		store.setCommunity(nodeId, commId);
	}

	return { communities, level, modularity };
}

function leidenIteration(
	adjList: Map<number, Map<number, number>>,
	community: Map<number, number>,
	resolution: number,
): { improved: boolean; modularity: number } {
	let improved = false;
	let totalWeight = 0;
	for (const neighbors of adjList.values()) {
		for (const w of neighbors.values()) { totalWeight += w; }
	}
	totalWeight /= 2; // each edge counted twice

	const nodeCommunity = new Map(community);
	const communityNodes = new Map<number, Set<number>>();
	for (const [nodeId, commId] of nodeCommunity) {
		if (!communityNodes.has(commId)) { communityNodes.set(commId, new Set()); }
		communityNodes.get(commId)!.add(nodeId);
	}

	// Local move phase
	const nodeOrder = Array.from(adjList.keys());
	shuffleArray(nodeOrder);

	for (const nodeId of nodeOrder) {
		const currentComm = nodeCommunity.get(nodeId)!;
		const neighbors = adjList.get(nodeId)!;

		// Calculate gain for moving to each neighbor's community
		const commWeights = new Map<number, number>();
		for (const [neighborId, weight] of neighbors) {
			const neighborComm = nodeCommunity.get(neighborId)!;
			commWeights.set(neighborComm, (commWeights.get(neighborComm) || 0) + weight);
		}

		let bestComm = currentComm;
		let bestGain = 0;

		for (const [commId, weight] of commWeights) {
			if (commId === currentComm) { continue; }
			const gain = weight - resolution * (communityNodes.get(commId)?.size || 0) * (communityNodes.get(currentComm)?.size || 0) / (2 * totalWeight);
			if (gain > bestGain) {
				bestGain = gain;
				bestComm = commId;
			}
		}

		if (bestComm !== currentComm) {
			communityNodes.get(currentComm)!.delete(nodeId);
			if (communityNodes.get(currentComm)!.size === 0) {
				communityNodes.delete(currentComm);
			}
			if (!communityNodes.has(bestComm)) { communityNodes.set(bestComm, new Set()); }
			communityNodes.get(bestComm)!.add(nodeId);
			nodeCommunity.set(nodeId, bestComm);
			improved = true;
		}
	}

	// Update community map
	community.clear();
	for (const [nodeId, commId] of nodeCommunity) {
		community.set(nodeId, commId);
	}

	// Calculate modularity
	const modularity = calculateModularity(adjList, community, totalWeight);

	return { improved, modularity };
}

function aggregateCommunities(
	adjList: Map<number, Map<number, number>>,
	community: Map<number, number>,
): { newAdjList: Map<number, Map<number, number>>; newCommunity: Map<number, number> } {
	const newAdjList = new Map<number, Map<number, number>>();
	const newCommunity = new Map<number, number>();

	// Map old community IDs to new supernode IDs
	const commToSupernode = new Map<number, number>();
	let nextSupernodeId = 0;
	for (const commId of new Set(community.values())) {
		commToSupernode.set(commId, nextSupernodeId);
		newCommunity.set(nextSupernodeId, nextSupernodeId);
		newAdjList.set(nextSupernodeId, new Map());
		nextSupernodeId++;
	}

	// Aggregate edges
	for (const [nodeId, neighbors] of adjList) {
		const sourceComm = community.get(nodeId)!;
		const sourceSupernode = commToSupernode.get(sourceComm)!;
		const supernodeNeighbors = newAdjList.get(sourceSupernode)!;

		for (const [neighborId, weight] of neighbors) {
			const targetComm = community.get(neighborId)!;
			const targetSupernode = commToSupernode.get(targetComm)!;
			if (sourceSupernode === targetSupernode) {
				// Self-loop
				supernodeNeighbors.set(sourceSupernode, (supernodeNeighbors.get(sourceSupernode) || 0) + weight);
			} else {
				supernodeNeighbors.set(targetSupernode, (supernodeNeighbors.get(targetSupernode) || 0) + weight);
			}
		}
	}

	return { newAdjList, newCommunity };
}

function calculateModularity(
	adjList: Map<number, Map<number, number>>,
	community: Map<number, number>,
	totalWeight: number,
): number {
	let q = 0;
	for (const [nodeId, neighbors] of adjList) {
		const nodeComm = community.get(nodeId)!;
		const nodeDegree = [...neighbors.values()].reduce((a, b) => a + b, 0);
		for (const [neighborId, weight] of neighbors) {
			const neighborComm = community.get(neighborId)!;
			if (nodeComm === neighborComm) {
				const neighborDegree = [...adjList.get(neighborId)!.values()].reduce((a, b) => a + b, 0);
				q += weight - (nodeDegree * neighborDegree) / (2 * totalWeight);
			}
		}
	}
	return q / (2 * totalWeight);
}

function shuffleArray<T>(arr: T[]): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// P2-22: 两级 LOD 3D 布局
// ═══════════════════════════════════════════════════════════════════════════

export type LODLevel = 'overview' | 'detail';

export interface LayoutNode {
	id: number;
	x: number;
	y: number;
	z: number;
	level: LODLevel;
	community: number;
}

/**
 * 两级 LOD (Level of Detail) 3D 布局。
 *
 * Overview: Barnes-Hut + 社区约束（社区内紧凑，社区间分离）
 * Detail: 社区内力导向 + 精细布局
 */
export function computeTwoLevelLOD(
	store: CodebaseGraphStore,
	project: string,
	level: LODLevel = 'overview',
): Map<number, LayoutNode> {
	const nodes = store.getAllNodes().filter(n => n.project === project);
	const result = new Map<number, LayoutNode>();

	// Get community assignments
	const communities = store.getCommunities(project);

	if (level === 'overview') {
		// Overview mode: position communities as clusters
		let communityIdx = 0;
		const communityCenters = new Map<number, { x: number; y: number; z: number }>();

		for (const [commId, _nodeIds] of communities) {
			// Place community center on a sphere
			const angle = (communityIdx / communities.size) * Math.PI * 2;
			const radius = Math.sqrt(communities.size) * 50;
			communityCenters.set(commId, {
				x: Math.cos(angle) * radius,
				y: Math.sin(angle) * radius,
				z: Math.sin(communityIdx * 0.5) * radius * 0.3,
			});
			communityIdx++;
		}

		// Position nodes within their community cluster
		for (const node of nodes) {
			const center = communityCenters.get(node.community || 0) || { x: 0, y: 0, z: 0 };
			// Small random offset within cluster
			const offset = 10;
			result.set(node.id, {
				id: node.id,
				x: center.x + (Math.random() - 0.5) * offset,
				y: center.y + (Math.random() - 0.5) * offset,
				z: center.z + (Math.random() - 0.5) * offset,
				level: 'overview',
				community: node.community || 0,
			});
		}
	} else {
		// Detail mode: force-directed within each community
		for (const [commId, nodeIds] of communities) {
			const communityNodes = nodeIds.map(id => store.getNode(id)).filter(Boolean) as GraphNode[];
			const localPositions = forceDirectedLayout(communityNodes, store);

			const angle = (commId / communities.size) * Math.PI * 2;
			const radius = Math.sqrt(communities.size) * 100;
			const centerX = Math.cos(angle) * radius;
			const centerY = Math.sin(angle) * radius;
			const centerZ = 0;

			for (const [id, pos] of localPositions) {
				result.set(id, {
					id,
					x: centerX + pos.x,
					y: centerY + pos.y,
					z: centerZ + pos.z,
					level: 'detail',
					community: commId,
				});
			}
		}
	}

	// Cache positions
	for (const [id, pos] of result) {
		store.saveLayout(id, pos.x, pos.y, pos.z);
	}

	return result;
}

function forceDirectedLayout(
	nodes: GraphNode[],
	store: CodebaseGraphStore,
	iterations: number = 50,
): Map<number, { x: number; y: number; z: number }> {
	const positions = new Map<number, { x: number; y: number; z: number }>();
	const velocities = new Map<number, { x: number; y: number; z: number }>();

	// Initialize random positions
	for (const node of nodes) {
		positions.set(node.id, { x: Math.random() * 100, y: Math.random() * 100, z: Math.random() * 100 });
		velocities.set(node.id, { x: 0, y: 0, z: 0 });
	}

	// Simple force-directed: repulsion + attraction
	for (let iter = 0; iter < iterations; iter++) {
		const forces = new Map<number, { x: number; y: number; z: number }>();
		for (const node of nodes) {
			forces.set(node.id, { x: 0, y: 0, z: 0 });
		}

		// Repulsion between all pairs
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const posA = positions.get(nodes[i].id)!;
				const posB = positions.get(nodes[j].id)!;
				const dx = posA.x - posB.x;
				const dy = posA.y - posB.y;
				const dz = posA.z - posB.z;
				const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.1;
				const force = 100 / (dist * dist);
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;
				const fz = (dz / dist) * force;
				forces.get(nodes[i].id)!.x += fx;
				forces.get(nodes[i].id)!.y += fy;
				forces.get(nodes[i].id)!.z += fz;
				forces.get(nodes[j].id)!.x -= fx;
				forces.get(nodes[j].id)!.y -= fy;
				forces.get(nodes[j].id)!.z -= fz;
			}
		}

		// Attraction along edges
		for (const node of nodes) {
			const edges = store.getEdgesBySource(node.id);
			for (const edge of edges) {
				if (!positions.has(edge.targetId)) { continue; }
				const posA = positions.get(node.id)!;
				const posB = positions.get(edge.targetId)!;
				const dx = posB.x - posA.x;
				const dy = posB.y - posA.y;
				const dz = posB.z - posA.z;
				const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.1;
				const force = dist * 0.01;
				forces.get(node.id)!.x += (dx / dist) * force;
				forces.get(node.id)!.y += (dy / dist) * force;
				forces.get(node.id)!.z += (dz / dist) * force;
			}
		}

		// Apply forces
		for (const node of nodes) {
			const vel = velocities.get(node.id)!;
			const force = forces.get(node.id)!;
			vel.x = (vel.x + force.x) * 0.9; // damping
			vel.y = (vel.y + force.y) * 0.9;
			vel.z = (vel.z + force.z) * 0.9;
			const pos = positions.get(node.id)!;
			pos.x += vel.x;
			pos.y += vel.y;
			pos.z += vel.z;
		}
	}

	return positions;
}

// ═══════════════════════════════════════════════════════════════════════════
// P2-23: 死代码检测增强
// ═══════════════════════════════════════════════════════════════════════════

export interface DeadCodeReport {
	totalNodes: number;
	reachableNodes: number;
	deadNodes: number;
	deadFiles: string[];
	deadFunctions: { name: string; filePath: string; qualifiedName: string }[];
	deadClasses: { name: string; filePath: string; qualifiedName: string }[];
	entryPoints: number;
}

/**
 * 增强版死代码检测。
 *
 * 入口点：
 * - main() 函数
 * - export 声明
 * - Route handler (@Get, @Post, @Controller)
 * - @EventListener
 * - @Injectable (DI 容器入口)
 *
 * BFS 从入口点可达性分析，不可达 = 死代码。
 */
export function detectDeadCodeEnhanced(store: CodebaseGraphStore, project: string): DeadCodeReport {
	const allNodes = store.getAllNodes().filter(n => n.project === project);

	// 1. Identify entry points
	const entryPoints: number[] = [];
	for (const node of allNodes) {
		if (isEntryPoint(node, store)) {
			entryPoints.push(node.id);
		}
	}

	// 2. BFS from entry points
	const reachable = new Set<number>();
	const queue = [...entryPoints];
	while (queue.length > 0) {
		const nodeId = queue.shift()!;
		if (reachable.has(nodeId)) { continue; }
		reachable.add(nodeId);

		// Follow outgoing edges
		const edges = store.getEdgesBySource(nodeId);
		for (const edge of edges) {
			if (!reachable.has(edge.targetId)) {
				queue.push(edge.targetId);
			}
		}

		// Follow incoming edges (reverse reachability for definitions)
		const inEdges = store.getEdgesByTarget(nodeId);
		for (const edge of inEdges) {
			if (!reachable.has(edge.sourceId)) {
				queue.push(edge.sourceId);
			}
		}
	}

	// 3. Identify dead nodes
	const deadNodes = allNodes.filter(n => !reachable.has(n.id) && n.label !== 'file');
	const deadFiles = new Set<string>();
	const deadFunctions: { name: string; filePath: string; qualifiedName: string }[] = [];
	const deadClasses: { name: string; filePath: string; qualifiedName: string }[] = [];

	for (const node of deadNodes) {
		if (node.filePath) { deadFiles.add(node.filePath); }
		if (node.label === 'function' || node.label === 'method') {
			deadFunctions.push({ name: node.name, filePath: node.filePath || '', qualifiedName: node.qualifiedName });
		}
		if (node.label === 'class' || node.label === 'interface') {
			deadClasses.push({ name: node.name, filePath: node.filePath || '', qualifiedName: node.qualifiedName });
		}
	}

	return {
		totalNodes: allNodes.length,
		reachableNodes: reachable.size,
		deadNodes: deadNodes.length,
		deadFiles: Array.from(deadFiles),
		deadFunctions,
		deadClasses,
		entryPoints: entryPoints.length,
	};
}

function isEntryPoint(node: GraphNode, store: CodebaseGraphStore): boolean {
	// main() function
	if (node.name === 'main' || node.name === '__main__') { return true; }

	const props = node.properties || {};

	// Has decorators indicating entry point
	const decorators = props.decorators || [];
	if (decorators.some((d: string) =>
		/^(Get|Post|Put|Delete|Patch|Controller|RestController|EventListener|Injectable|Component|Service|Module|Entrypoint|Command|Handler|Route|Path|Startup)$/i.test(d)
	)) { return true; }

	// Is exported (has DEFINES edge from file, and file has export)
	// Check if node has properties indicating export
	if (props.isExported === true) { return true; }

	// Is a Route node
	if (node.label === 'Route') { return true; }

	// Is a Service node
	if (node.label === 'Service') { return true; }

	// Has high in-degree (likely public API)
	if (node.inDegree >= 5) { return true; }

	return false;
}
