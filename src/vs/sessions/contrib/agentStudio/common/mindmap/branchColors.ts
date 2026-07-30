/*---------------------------------------------------------------------------------------------
 *  Sarosis Agents — Mindmap Branch Colors
 *
 *  移植自 Mindvas mindmap/branch-colors.ts。
 *  为顶层分支分配调色板颜色，逐级级联到后代节点和边。
 *--------------------------------------------------------------------------------------------*/

import type { IMindmapData } from './mindmapTypes.js';
import type { TreeNode } from './treeModel.js';
import { buildForest } from './treeModel.js';

// ═══════════════════════════════════════════════════════════════════════════
// 调色板
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 默认调色板（对应 Obsidian canvas color 系统 "1"-"6"）。
 * 渲染层应将这些值映射为实际 CSS 颜色。
 */
const DEFAULT_PALETTE: string[] = ['1', '2', '3', '4', '5', '6'];

// ═══════════════════════════════════════════════════════════════════════════
// 着色
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 为所有顶层分支分配颜色（就地修改 data）。
 * 每棵树的 depth-1 子节点按调色板轮换，颜色级联到后代和入边。
 * @returns 发生了变更的节点 ID 集合
 */
export function applyBranchColors(data: IMindmapData, palette?: string[]): Set<string> {
	const colors = palette ?? DEFAULT_PALETTE;
	const forest = buildForest(data);
	if (forest.length === 0) { return new Set(); }

	const changed = new Set<string>();

	for (const root of forest) {
		root.children.forEach((child, index) => {
			const color = colors[index % colors.length];
			colorBranch(data, child, color, changed);
		});
	}

	return changed;
}

/**
 * 为单个分支着色：node + 后代 + 入边。
 */
function colorBranch(
	data: IMindmapData,
	treeNode: TreeNode,
	color: string,
	changed: Set<string>,
): void {
	// 节点本身
	if (treeNode.node.color !== color) {
		treeNode.node.color = color;
		changed.add(treeNode.node.id);
	}

	// 入边
	const incomingEdge = data.edges.find(e => e.toNode === treeNode.node.id);
	if (incomingEdge && incomingEdge.color !== color) {
		incomingEdge.color = color;
		changed.add('edge:' + incomingEdge.id);
	}

	// 递归后代
	for (const child of treeNode.children) {
		colorBranch(data, child, color, changed);
	}
}

/**
 * 清除所有节点和边的颜色（就地修改）。
 */
export function clearAllColors(data: IMindmapData): void {
	for (const node of data.nodes) {
		node.color = undefined;
	}
	for (const edge of data.edges) {
		edge.color = undefined;
	}
}
