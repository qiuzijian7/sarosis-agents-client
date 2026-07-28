/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Architecture Analysis — 7 维度代码架构分析。
 *
 * 对标 codebase-memory-mcp 的 get_architecture 工具：
 * 1. 语言统计     — 每种语言的文件数、节点数
 * 2. 包/目录摘要  — 每个顶层目录的统计
 * 3. 入口点       — 零入度函数（非 test、非 private）
 * 4. 路由         — HTTP 端点汇总
 * 5. 热点         — 高入度节点（被依赖最多的代码）
 * 6. 跨包边界     — 跨目录的调用/导入边
 * 7. 分层         — 自动推断 Controller → Service → Repository 层级
 */

import { CodebaseGraphStore, GraphNode, GraphEdge } from './codebaseGraphStore.js';
import { leidenCommunities } from './codebaseGraphLayout.js';

export interface LanguageStat {
	language: string;
	files: number;
	nodes: number;
	loc: number;
}

export interface PackageSummary {
	name: string;
	path: string;
	nodeCount: number;
	edgeCount: number;
	languages: string[];
	entryPoints: number;
}

export interface Hotspot {
	node: GraphNode;
	score: number;  // inDegree + outDegree
}

export interface CrossBoundary {
	source: GraphNode;
	target: GraphNode;
	edge: GraphEdge;
	sourcePackage: string;
	targetPackage: string;
}

export interface LayerAssignment {
	nodeId: number;
	layer: 'controller' | 'service' | 'repository' | 'model' | 'view' | 'util' | 'config' | 'other';
}

export interface Community {
	id: number;
	size: number;
	nodes: number[];
	avg_in_degree: number;
	/** 内部边密度：internal/(internal+boundary), 1.0=完全封闭 */
	cohesion?: number;
	/** 按 inDegree+outDegree 排序的代表性节点名 (top 5)，对齐 C 的 top_nodes */
	top_nodes?: string[];
	/** 顶层包/目录名 */
	packages?: string[];
	/** 社区内边类型 (如 ["CALLS", "IMPORTS"])，对齐 C 的 edge_types */
	edge_types?: string[];
}

export interface ArchitectureReport {
	languages: LanguageStat[];
	packages: PackageSummary[];
	entryPoints: GraphNode[];
	routes: GraphNode[];
	hotspots: Hotspot[];
	crossBoundaries: CrossBoundary[];
	layers: LayerAssignment[];
	communities: Community[];
	/** 大库跳过社区检测时的说明（2026-07-27：Leiden 同步跑 249k 节点是分钟级主线程阻塞） */
	communitiesSkipped?: string;
	services?: any[];
	fileTree?: any;
	totalNodes: number;
	totalEdges: number;
}

const LAYER_PATTERNS: Record<string, { layer: LayerAssignment['layer']; patterns: RegExp[] }> = {
	controller: { layer: 'controller', patterns: [/controller/i, /route/i, /handler/i, /endpoint/i] },
	service: { layer: 'service', patterns: [/service/i, /manager/i, /processor/i, /handler/i] },
	repository: { layer: 'repository', patterns: [/repository/i, /repo/i, /dao/i, /mapper/i, /store/i] },
	model: { layer: 'model', patterns: [/model/i, /entity/i, /dto/i, /vo$/i, /schema/i] },
	view: { layer: 'view', patterns: [/view/i, /component/i, /page/i, /screen/i, /ui/i] },
	util: { layer: 'util', patterns: [/util/i, /helper/i, /common/i, /shared/i, /lib/i] },
	config: { layer: 'config', patterns: [/config/i, /setting/i, /env/i, /constant/i] },
};

export async function analyzeArchitecture(store: CodebaseGraphStore, project: string | undefined): Promise<ArchitectureReport> {
	// 多 folder：project 为 undefined 时搜索全部项目（含 S1Game + UE5EA 等）
	const allNodes = project ? store.getAllNodes().filter(n => n.project === project) : store.getAllNodes();
	const allEdges = project ? store.getAllEdges().filter(e => e.project === project) : store.getAllEdges();

	return {
		languages: analyzeLanguages(allNodes),
		packages: await analyzePackages(allNodes, allEdges, project, store),
		entryPoints: findEntryPoints(allNodes),
		routes: allNodes.filter(n => n.label === 'route'),
		hotspots: findHotspots(allNodes),
		crossBoundaries: findCrossBoundaries(allNodes, allEdges, store),
		layers: assignLayers(allNodes),
		// 2026-07-27（日志 1785084338635，app 卡死）：Leiden 社区检测在 249k 节点
		// × ~50 万边上同步跑是分钟级主线程阻塞。规模保护：超阈值跳过（架构报告
		// 的 packages/languages/hotspots/layers 仍有价值，communities 为加分项）。
		communities: allNodes.length > 30_000 ? [] : detectCommunities(allNodes, allEdges),
		...(allNodes.length > 30_000
			? { communitiesSkipped: `community detection skipped: graph too large (${allNodes.length} nodes > 30000) — Leiden would block the main thread for minutes` }
			: {}),
		// P1 additions: services + fileTree
		services: analyzeServices(allNodes, allEdges, store, project),
		fileTree: buildFileTree(allNodes),
		totalNodes: allNodes.length,
		totalEdges: allEdges.length,
	};
}

// ─── Language Statistics ──────────────────────────────────────────────────────

function analyzeLanguages(nodes: GraphNode[]): LanguageStat[] {
	const stats: Map<string, LanguageStat> = new Map();

	for (const node of nodes) {
		if ((node.label === 'file' || node.label === 'File') && node.filePath) {
			const ext = node.filePath.split('.').pop() || 'unknown';
			const lang = getLanguageName(ext);
			const stat = stats.get(lang) || { language: lang, files: 0, nodes: 0, loc: 0 };
			stat.files++;
			stat.loc += (node.endLine || 0) - (node.startLine || 0);
			stats.set(lang, stat);
		} else {
			// Count nodes by their file's language
			if (node.filePath) {
				const ext = node.filePath.split('.').pop() || 'unknown';
				const lang = getLanguageName(ext);
				const stat = stats.get(lang) || { language: lang, files: 0, nodes: 0, loc: 0 };
				stat.nodes++;
				stats.set(lang, stat);
			}
		}
	}

	return Array.from(stats.values()).sort((a, b) => b.files - a.files);
}

function getLanguageName(ext: string): string {
	const map: Record<string, string> = {
		'ts': 'TypeScript', 'tsx': 'TypeScript', 'mts': 'TypeScript', 'cts': 'TypeScript',
		'js': 'JavaScript', 'jsx': 'JavaScript', 'mjs': 'JavaScript',
		'py': 'Python', 'go': 'Go', 'rs': 'Rust', 'java': 'Java',
		'cpp': 'C++', 'cc': 'C++', 'h': 'C++', 'hpp': 'C++',
		'cs': 'C#', 'rb': 'Ruby', 'php': 'PHP',
	};
	return map[ext.toLowerCase()] || ext;
}

// ─── Package Analysis ─────────────────────────────────────────────────────────

async function analyzePackages(nodes: GraphNode[], edges: GraphEdge[], project: string | undefined, store: CodebaseGraphStore): Promise<PackageSummary[]> {
	const pkgMap: Map<string, GraphNode[]> = new Map();

	for (const node of nodes) {
		if (!node.filePath) { continue; }
		const pkg = node.filePath.split('/')[0] || '(root)';
		const arr = pkgMap.get(pkg) || [];
		arr.push(node);
		pkgMap.set(pkg, arr);
	}

	// 2026-07-27（日志 1785084338635，app 卡死）：原 edgeCount 计算是
	// O(packages × edges × nodes)——每包 filter 全部边、每边两次 nodes.some，
	// 249k 节点 × ~50 万边 × N 包 ≈ 10^12 级操作（主线程永久阻塞）。
	// 重写为 O(N+E)：nodeId→package 预映射 + 单次边遍历累加（语义等价：
	// 任一端点属于该包的边计入；跨包边两端各计一次，同包边只计一次）。
	const nodePkg = new Map<number, string>();
	for (const node of nodes) {
		if (!node.filePath) { continue; }
		nodePkg.set(node.id, node.filePath.split('/')[0] || '(root)');
	}
	const pkgEdgeCount = new Map<string, number>();
	for (const e of edges) {
		const sp = nodePkg.get(e.sourceId);
		if (sp) { pkgEdgeCount.set(sp, (pkgEdgeCount.get(sp) || 0) + 1); }
		const tp = nodePkg.get(e.targetId);
		if (tp && tp !== sp) { pkgEdgeCount.set(tp, (pkgEdgeCount.get(tp) || 0) + 1); }
	}

	const summaries: PackageSummary[] = [];
	let i = 0;
	for (const [name, pkgNodes] of pkgMap) {
		const languages = new Set<string>();
		let entryPoints = 0;
		for (const node of pkgNodes) {
			if (node.filePath) {
				languages.add(getLanguageName(node.filePath.split('.').pop() || ''));
			}
			if (node.inDegree === 0 && node.label === 'function') { entryPoints++; }
		}
		summaries.push({
			name,
			path: name,
			nodeCount: pkgNodes.length,
			edgeCount: pkgEdgeCount.get(name) ?? 0,
			languages: Array.from(languages),
			entryPoints,
		});
		// Yield to event loop every 100 packages so the abort timer can fire (P2-6)
		if (++i % 100 === 0) {
			await new Promise<void>(r => setTimeout(r, 0));
		}
	}

	return summaries.sort((a, b) => b.nodeCount - a.nodeCount);
}

// ─── Entry Points ──────────────────────────────────────────────────────────────

function findEntryPoints(nodes: GraphNode[]): GraphNode[] {
	return nodes.filter(n =>
		n.inDegree === 0 &&
		n.label === 'function' &&
		!n.filePath?.includes('test') &&
		!n.filePath?.includes('spec') &&
		!n.name.startsWith('_') &&
		!n.name.startsWith('test')
	).slice(0, 100);
}

// ─── Hotspots ──────────────────────────────────────────────────────────────────

function findHotspots(nodes: GraphNode[]): Hotspot[] {
	return nodes
		.map(n => ({ node: n, score: n.inDegree + n.outDegree }))
		.filter(h => h.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 20);
}

// ─── Cross-Package Boundaries ─────────────────────────────────────────────────

function findCrossBoundaries(nodes: GraphNode[], edges: GraphEdge[], store: CodebaseGraphStore): CrossBoundary[] {
	const results: CrossBoundary[] = [];
	const nodeMap = new Map(nodes.map(n => [n.id, n]));

	for (const edge of edges) {
		const source = nodeMap.get(edge.sourceId);
		const target = nodeMap.get(edge.targetId);
		if (!source || !target || !source.filePath || !target.filePath) { continue; }

		const srcPkg = source.filePath.split('/')[0];
		const tgtPkg = target.filePath.split('/')[0];
		if (srcPkg !== tgtPkg) {
			results.push({
				source, target, edge,
				sourcePackage: srcPkg,
				targetPackage: tgtPkg,
			});
		}
		if (results.length >= 200) { break; }  // Limit
	}
	return results;
}

// ─── Layer Assignment ─────────────────────────────────────────────────────────

function assignLayers(nodes: GraphNode[]): LayerAssignment[] {
	const results: LayerAssignment[] = [];

	for (const node of nodes) {
		if (node.label !== 'function' && node.label !== 'class') { continue; }
		const text = `${node.name} ${node.filePath || ''}`;

		let assignedLayer: LayerAssignment['layer'] = 'other';
		for (const [_, info] of Object.entries(LAYER_PATTERNS)) {
			if (info.patterns.some(p => p.test(text))) {
				assignedLayer = info.layer;
				break;
			}
		}
		results.push({ nodeId: node.id, layer: assignedLayer });
	}

	return results;
}

// ─── Community Detection ───────────────────────────────────────────────────────

function detectCommunities(nodes: GraphNode[], edges: GraphEdge[]): Community[] {
	const nodeIds = nodes.map(n => n.id);
	const layoutEdges = edges.map(e => ({ source: e.sourceId, target: e.targetId }));

	const assignments = leidenCommunities(nodeIds, layoutEdges);

	// Build community summaries
	const commMap: Map<number, number[]> = new Map();
	for (const [nodeId, commId] of assignments) {
		const arr = commMap.get(commId) || [];
		arr.push(nodeId);
		commMap.set(commId, arr);
	}

	const nodeMap = new Map(nodes.map(n => [n.id, n]));

	// 预计算边所属社区（加速 cohesion 计算）
	const nodeCommunities = new Map(assignments);
	const internalEdges = new Map<number, number>();   // commId → internal edge count
	const boundaryEdges = new Map<number, number>();   // commId → boundary edge count
	const commEdgeTypes = new Map<number, Set<string>>(); // commId → edge types

	for (const edge of edges) {
		const srcComm = nodeCommunities.get(edge.sourceId);
		const tgtComm = nodeCommunities.get(edge.targetId);
		if (srcComm === undefined || tgtComm === undefined) { continue; }

		if (srcComm === tgtComm) {
			internalEdges.set(srcComm, (internalEdges.get(srcComm) || 0) + 1);
		} else {
			boundaryEdges.set(srcComm, (boundaryEdges.get(srcComm) || 0) + 1);
			boundaryEdges.set(tgtComm, (boundaryEdges.get(tgtComm) || 0) + 1);
		}
		// 记录边类型
		if (!commEdgeTypes.has(srcComm)) { commEdgeTypes.set(srcComm, new Set()); }
		if (!commEdgeTypes.has(tgtComm)) { commEdgeTypes.set(tgtComm, new Set()); }
		commEdgeTypes.get(srcComm)!.add(edge.type);
		commEdgeTypes.get(tgtComm)!.add(edge.type);
	}

	const communities: Community[] = [];
	for (const [commId, memberIds] of commMap) {
		// 跳过单例社区
		if (memberIds.length < 2) { continue; }

		const commNodes = memberIds.map(id => nodeMap.get(id)).filter(Boolean) as GraphNode[];
		const avg_in_degree = commNodes.reduce((s, n) => s + n.inDegree, 0) / (commNodes.length || 1);

		// Cohesion: 内部边 / (内部边 + 边界边)
		const internal = internalEdges.get(commId) || 0;
		const boundary = boundaryEdges.get(commId) || 0;
		const cohesion = internal + boundary > 0 ? internal / (internal + boundary) : 0;

		// Top nodes: 按 inDegree+outDegree 排序前 5
		const topNodes = commNodes
			.sort((a, b) => (b.inDegree + b.outDegree) - (a.inDegree + a.outDegree))
			.slice(0, 5)
			.map(n => n.name);

		// Packages: 从 qualifiedName 提取顶层目录名
		const pkgSet = new Set<string>();
		for (const n of commNodes) {
			if (n.filePath) {
				const pkg = n.filePath.split(/[\\/]/)[0] || n.filePath.split('/')[0];
				if (pkg && pkg !== '.') { pkgSet.add(pkg); }
			}
		}
		const packages = [...pkgSet].slice(0, 5);

		// Edge types
		const types = commEdgeTypes.get(commId);
		const edgeTypes = types ? [...types] : [];

		communities.push({
			id: commId, size: commNodes.length, nodes: memberIds,
			avg_in_degree, cohesion, top_nodes: topNodes, packages, edge_types: edgeTypes,
		});
	}

	return communities.sort((a, b) => b.size - a.size).slice(0, 12); // 同 C 版 top 12
}

// ─── Service Analysis (P1) ───────────────────────────────────────────────────

interface ServiceInfo {
	name: string;
	type: 'http' | 'grpc' | 'graphql' | 'async' | 'unknown';
	operations: { name: string; nodeId: number }[];
	dependencies: number[];  // nodeIds of called services
	dependents: number[];    // nodeIds of callers
}

function analyzeServices(nodes: GraphNode[], edges: GraphEdge[], store: CodebaseGraphStore, project: string | undefined): ServiceInfo[] {
	const services: ServiceInfo[] = [];

	// Find service nodes (Route handlers, gRPC services, GraphQL resolvers)
	const serviceNodes = nodes.filter(n =>
		n.label === 'route' || n.label === 'service' ||
		n.properties?.serviceName ||
		n.properties?.isService === true
	);

	// Also detect service-like patterns from function names
	const servicePatterns = /^(handle|process|serve|dispatch|execute|get|post|put|delete|patch|query|mutate|subscribe|publish)/i;
	const serviceLikeFunctions = nodes.filter(n =>
		(n.label === 'function' || n.label === 'method') &&
		servicePatterns.test(n.name) &&
		n.inDegree > 0
	);

	// Group by file/module
	const serviceMap: Map<string, GraphNode[]> = new Map();
	for (const node of [...serviceNodes, ...serviceLikeFunctions]) {
		const module = (node.filePath || '').split('/').slice(0, -1).join('/') || '(root)';
		if (!serviceMap.has(module)) { serviceMap.set(module, []); }
		serviceMap.get(module)!.push(node);
	}

	for (const [module, serviceNodes] of serviceMap) {
		const serviceName = module.split('/').pop() || module;
		let serviceType: ServiceInfo['type'] = 'unknown';

		// Detect service type from nodes
		if (serviceNodes.some(n => n.properties?.type === 'grpc' || n.properties?.serviceName)) {
			serviceType = 'grpc';
		} else if (serviceNodes.some(n => n.properties?.type === 'graphql')) {
			serviceType = 'graphql';
		} else if (serviceNodes.some(n => n.label === 'route' || n.properties?.method)) {
			serviceType = 'http';
		} else if (serviceNodes.some(n => n.properties?.type === 'async')) {
			serviceType = 'async';
		}

		// Find dependencies (what this service calls)
		const dependencies = new Set<number>();
		const dependents = new Set<number>();
		for (const node of serviceNodes) {
			for (const edge of store.getEdgesBySource(node.id)) {
				if (edge.type === 'CALLS' || edge.type === 'HTTP_CALLS' || edge.type === 'GRPC_CALLS') {
					dependencies.add(edge.targetId);
				}
			}
			for (const edge of store.getEdgesByTarget(node.id)) {
				if (edge.type === 'CALLS' || edge.type === 'HTTP_CALLS') {
					dependents.add(edge.sourceId);
				}
			}
		}

		services.push({
			name: serviceName,
			type: serviceType,
			operations: serviceNodes.map(n => ({ name: n.name, nodeId: n.id })),
			dependencies: Array.from(dependencies),
			dependents: Array.from(dependents),
		});
	}

	return services;
}

// ─── File Tree (P1) ──────────────────────────────────────────────────────────

interface FileTreeNode {
	name: string;
	path: string;
	type: 'file' | 'directory';
	nodeCount: number;
	children?: FileTreeNode[];
}

function buildFileTree(nodes: GraphNode[]): FileTreeNode {
	const root: FileTreeNode = { name: '(root)', path: '', type: 'directory', nodeCount: 0, children: [] };

	// Group nodes by file path
	const fileNodeCounts: Map<string, number> = new Map();
	for (const node of nodes) {
		if (node.filePath) {
			fileNodeCounts.set(node.filePath, (fileNodeCounts.get(node.filePath) || 0) + 1);
		}
	}

	// Build tree from file paths
	for (const [filePath, count] of fileNodeCounts) {
		const parts = filePath.split('/');
		let current = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isFile = i === parts.length - 1;
			const path = parts.slice(0, i + 1).join('/');

			if (!current.children) { current.children = []; }
			let child = current.children.find(c => c.name === part && c.type === (isFile ? 'file' : 'directory'));

			if (!child) {
				child = {
					name: part,
					path,
					type: isFile ? 'file' : 'directory',
					nodeCount: isFile ? count : 0,
					children: isFile ? undefined : [],
				};
				current.children.push(child);
			}
			current = child;
		}
	}

	// Aggregate counts up the tree
	function aggregateCounts(node: FileTreeNode): number {
		if (node.type === 'file') { return node.nodeCount; }
		let total = 0;
		for (const child of node.children || []) {
			total += aggregateCounts(child);
		}
		node.nodeCount = total;
		return total;
	}
	aggregateCounts(root);

	return root;
}
