/*---------------------------------------------------------------------------------------------
 *  Sarosis Agents — Mindmap Edge Side Computation
 *
 *  移植自 Mindvas canvas/edge-updater.ts。
 *  dominant-axis 启发式：两节点中心水平偏移决定连接侧。
 *  去掉了 Canvas 运行时依赖（直接操作数据）。
 *--------------------------------------------------------------------------------------------*/

import type { IMindmapData, IMindmapNode, IMindmapEdge } from './mindmapTypes.js';

type NodeSide = 'top' | 'right' | 'bottom' | 'left';

// ═══════════════════════════════════════════════════════════════════════════
// 边侧计算
// ═══════════════════════════════════════════════════════════════════════════

export interface IEdgeSides {
	fromSide: NodeSide;
	toSide: NodeSide;
}

/**
 * 计算边的连接侧。
 * 水平偏移 ≥ 0 → from=right, to=left；否则 from=left, to=right。
 * 思维导图边始终水平连接。
 */
export function computeEdgeSides(fromNode: IMindmapNode, toNode: IMindmapNode): IEdgeSides {
	const fromCx = fromNode.x + fromNode.width / 2;
	const toCx = toNode.x + toNode.width / 2;

	if (toCx >= fromCx) {
		return { fromSide: 'right', toSide: 'left' };
	} else {
		return { fromSide: 'left', toSide: 'right' };
	}
}

/**
 * 更新 data 中所有边的连接侧，返回是否发生了变更。
 * 对齐 Mindvas updateAllEdgeSides，但操作纯数据。
 */
export function updateAllEdgeSides(data: IMindmapData): boolean {
	let changed = false;
	const nodeMap = buildNodeMap(data.nodes);

	for (const edge of data.edges) {
		const fromNode = nodeMap.get(edge.fromNode);
		const toNode = nodeMap.get(edge.toNode);
		if (!fromNode || !toNode) { continue; }

		const { fromSide, toSide } = computeEdgeSides(fromNode, toNode);

		if (edge.fromSide !== fromSide || edge.toSide !== toSide) {
			edge.fromSide = fromSide;
			edge.toSide = toSide;
			changed = true;
		}
	}

	return changed;
}

/**
 * 创建思维导图边（fromNode → toNode，自动计算连接侧）。
 * 返回新的边对象。
 */
export function createMindmapEdge(
	id: string,
	fromNodeId: string,
	toNodeId: string,
	nodes: IMindmapNode[],
	color?: string,
	label?: string,
): IMindmapEdge {
	const nodeMap = buildNodeMap(nodes);
	const fromNode = nodeMap.get(fromNodeId);
	const toNode = nodeMap.get(toNodeId);
	const { fromSide, toSide } = fromNode && toNode
		? computeEdgeSides(fromNode, toNode)
		: { fromSide: 'right' as const, toSide: 'left' as const };

	return {
		id,
		fromNode: fromNodeId,
		fromSide,
		toNode: toNodeId,
		toSide,
		fromEnd: 'none',
		toEnd: 'arrow',
		...(color ? { color } : {}),
		...(label ? { label } : {}),
	};
}

function buildNodeMap(nodes: IMindmapNode[]): Map<string, IMindmapNode> {
	const map = new Map<string, IMindmapNode>();
	for (const n of nodes) {
		map.set(n.id, n);
	}
	return map;
}
