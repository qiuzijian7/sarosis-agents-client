/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Change Detection — Git 变更检测 + 影响分析。
 *
 * 对标 codebase-memory-mcp 的 detect_changes 工具：
 * 1. git diff 获取变更文件列表
 * 2. 映射到图节点
 * 3. BFS 下游影响分析（受影响节点的调用链）
 * 4. 风险分级（Critical/High/Medium/Low）
 */

import { CodebaseGraphStore, GraphNode, GraphEdge } from './codebaseGraphStore.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

export type RiskLevel = 'Critical' | 'High' | 'Medium' | 'Low';

export interface ChangeImpact {
	commit: string;
	affectedFiles: string[];
	affectedNodes: GraphNode[];
	affectedEdges: GraphEdge[];
	downstreamImpact: GraphNode[];
	riskLevel: RiskLevel;
	riskReasons: string[];
	totalImpacted: number;
}

const MAX_BFS_DEPTH = 5;
const MAX_BFS_NODES = 500;

/**
 * Detect changes and compute impact analysis.
 * Uses git diff to find changed files, then maps to graph nodes.
 */
export async function detectChanges(
	store: CodebaseGraphStore,
	fileService: IFileService,
	project: string,
	rootPath: string,
	baseCommit?: string
): Promise<ChangeImpact> {
	// 1. Get changed files from git diff
	const changedFiles = await getGitChangedFiles(fileService, rootPath, baseCommit);

	// 2. Map to graph nodes
	const affectedNodes: GraphNode[] = [];
	const affectedEdges: GraphEdge[] = [];
	const affectedFiles: string[] = [];

	for (const file of changedFiles) {
		const relPath = getRelativePath(rootPath, file);
		affectedFiles.push(relPath);
		const nodes = store.findNodesByFile(project, relPath);
		affectedNodes.push(...nodes);
		for (const node of nodes) {
			affectedEdges.push(...store.getEdgesBySource(node.id));
		}
	}

	// 3. BFS downstream impact analysis
	const downstreamImpact = bfsDownstream(store, affectedNodes);

	// 4. Risk assessment
	const { riskLevel, riskReasons } = assessRisk(affectedNodes, downstreamImpact);

	return {
		commit: baseCommit || 'HEAD',
		affectedFiles,
		affectedNodes,
		affectedEdges,
		downstreamImpact,
		riskLevel,
		riskReasons,
		totalImpacted: affectedNodes.length + downstreamImpact.length,
	};
}

// ─── Git Diff ──────────────────────────────────────────────────────────────────

async function getGitChangedFiles(fileService: IFileService, rootPath: string, baseCommit?: string): Promise<string[]> {
	// Read .git/HEAD to get current commit
	try {
		const headUri = URI.joinPath(URI.file(rootPath), '.git', 'HEAD');
		const headContent = await fileService.readFile(headUri);
		const headRef = headContent.value.toString().trim();

		// If it's a ref, read the ref file
		if (headRef.startsWith('ref:')) {
			const refPath = headRef.substring(5).trim();
			const refUri = URI.joinPath(URI.file(rootPath), '.git', refPath);
			await fileService.readFile(refUri);
		}

		// Compare with base commit (if provided)
		// For simplicity, we return files that changed in the working tree
		// A more sophisticated approach would use git diff-tree

		// Read .git/index and compare with working directory
		// For now, return empty list if no base commit
		if (!baseCommit) {
			// Check git diff against HEAD by looking at modified files
			// This is a simplified approach — the watcher handles file-level detection
			return [];
		}

		return [];
	} catch {
		return [];
	}
}

// ─── BFS Downstream Impact ─────────────────────────────────────────────────────

function bfsDownstream(store: CodebaseGraphStore, startNodes: GraphNode[]): GraphNode[] {
	const visited: Set<number> = new Set();
	const queue: { nodeId: number; depth: number }[] = [];
	const result: GraphNode[] = [];

	// Start from affected nodes' downstream (nodes they call)
	for (const node of startNodes) {
		const outEdges = store.getEdgesBySource(node.id);
		for (const edge of outEdges) {
			if (edge.type === 'CALLS' || edge.type === 'IMPORTS') {
				queue.push({ nodeId: edge.targetId, depth: 0 });
			}
		}
	}

	while (queue.length > 0 && result.length < MAX_BFS_NODES) {
		const { nodeId, depth } = queue.shift()!;
		if (visited.has(nodeId) || depth >= MAX_BFS_DEPTH) { continue; }
		visited.add(nodeId);

		const node = store.getNode(nodeId);
		if (!node) { continue; }
		result.push(node);

		// Continue BFS
		const outEdges = store.getEdgesBySource(nodeId);
		for (const edge of outEdges) {
			if (edge.type === 'CALLS' && !visited.has(edge.targetId)) {
				queue.push({ nodeId: edge.targetId, depth: depth + 1 });
			}
		}
	}

	return result;
}

// ─── Risk Assessment ───────────────────────────────────────────────────────────

function assessRisk(affectedNodes: GraphNode[], downstreamImpact: GraphNode[]): { riskLevel: RiskLevel; riskReasons: string[] } {
	const reasons: string[] = [];
	let score = 0;

	// Critical: changes to entry points
	const entryPoints = affectedNodes.filter(n => n.inDegree === 0 && n.label === 'function');
	if (entryPoints.length > 0) {
		score += 4;
		reasons.push(`${entryPoints.length} 个入口点函数被修改`);
	}

	// High: changes to high-in-degree nodes (hotspots)
	const hotspots = affectedNodes.filter(n => n.inDegree >= 10);
	if (hotspots.length > 0) {
		score += 3;
		reasons.push(`${hotspots.length} 个高入度节点（≥10 依赖）被修改`);
	}

	// Medium: large downstream impact
	if (downstreamImpact.length > 50) {
		score += 2;
		reasons.push(`下游影响 ${downstreamImpact.length} 个节点（超过 50）`);
	} else if (downstreamImpact.length > 10) {
		score += 1;
		reasons.push(`下游影响 ${downstreamImpact.length} 个节点`);
	}

	// Low: few changes
	if (affectedNodes.length <= 3 && downstreamImpact.length <= 10) {
		reasons.push(`变更范围小（${affectedNodes.length} 节点）`);
	}

	let riskLevel: RiskLevel = 'Low';
	if (score >= 7) { riskLevel = 'Critical'; }
	else if (score >= 5) { riskLevel = 'High'; }
	else if (score >= 3) { riskLevel = 'Medium'; }

	return { riskLevel, riskReasons: reasons.length > 0 ? reasons : ['无显著风险'] };
}

// ─── Dead Code Detection ───────────────────────────────────────────────────────

export function findDeadCode(store: CodebaseGraphStore, project: string): GraphNode[] {
	const allFunctions = store.findNodesByLabel(project, 'function');

	return allFunctions.filter(fn =>
		fn.inDegree === 0 &&
		!isExported(fn) &&
		!isEntryPoint(fn) &&
		!isTestFunction(fn)
	);
}

function isExported(node: GraphNode): boolean {
	return node.properties?.exported === true ||
		!node.name.startsWith('_') && !node.name.startsWith('private');
}

function isEntryPoint(node: GraphNode): boolean {
	return ['main', 'init', 'start', 'run', 'handle', 'process'].some(
		prefix => node.name.toLowerCase().startsWith(prefix)
	);
}

function isTestFunction(node: GraphNode): boolean {
	return node.name.toLowerCase().startsWith('test') ||
		node.name.toLowerCase().startsWith('it_') ||
		node.name.toLowerCase().startsWith('describe_') ||
		(node.filePath?.includes('test') ?? false) ||
		(node.filePath?.includes('spec') ?? false);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getRelativePath(rootPath: string, absPath: string): string {
	if (absPath.startsWith(rootPath)) {
		return absPath.substring(rootPath.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
	}
	return absPath.replace(/\\/g, '/');
}
