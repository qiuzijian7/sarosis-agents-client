/*---------------------------------------------------------------------------------------------
 *  Saros Agents — Mindmap Node Operations
 *
 *  移植自 Mindvas mindmap/node-operations.ts。
 *  节点操作：增（子/兄）、删（重连孤儿子节点）、翻转分支、平衡布局切换。
 *
 *  均为纯函数：输入数据 + 参数 → 返回突变后的新数据和新增节点 ID。
 *  布局计算由调用方负责（layoutEngine.computeChildrenLayout）。
 *--------------------------------------------------------------------------------------------*/

import type { IMindmapData, IMindmapNode, IMindmapEdge, BranchDirection, INodeOpsConfig } from './mindmapTypes.js';
import { genId } from './idGenerator.js';
import {
	buildForest, findTreeForNode,
	countChildrenPerSide, collectDescendantNodes,
	getDirectChildNodes, getParentNode, detectDirection,
} from './treeModel.js';
import { createMindmapEdge } from './edgeSides.js';

// ═══════════════════════════════════════════════════════════════════════════
// 节点操作结果
// ═══════════════════════════════════════════════════════════════════════════

export interface INodeOperationResult {
	/** 修改后的数据（浅拷贝，nodes/edges 是新数组） */
	data: IMindmapData;
	/** 新建节点 ID（addChild / addSibling 时返回） */
	newNodeId?: string;
	/** 聚焦节点 ID（删除后聚焦父节点） */
	focusNodeId?: string;
	/** 需要重排的父节点 ID（调用方应执行 layoutChildren） */
	relayoutParentId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 创建节点 / 边（辅助）
// ═══════════════════════════════════════════════════════════════════════════

function createTextNode(
	x: number, y: number,
	width: number, height: number,
	text: string = '',
	color?: string,
): IMindmapNode {
	return {
		id: genId(),
		type: 'text',
		x, y, width, height,
		text,
		...(color ? { color } : {}),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// 添加子节点
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 为指定父节点添加子节点。
 * 根父节点：选子节点较少的一侧（持平选右）。
 * 非根父节点：继承分支方向。
 */
export function addChild(
	data: IMindmapData,
	parentNodeId: string,
	config: INodeOpsConfig,
	initialText: string = '',
): INodeOperationResult | null {
	const parentNode = data.nodes.find(n => n.id === parentNodeId);
	if (!parentNode) { return null; }

	const forest = buildForest(cloneData(data));
	const parentTreeNode = findTreeForNode(forest, parentNodeId);
	const isRoot = parentTreeNode && !parentTreeNode.parent;

	// 确定新子节点的方向
	let direction: BranchDirection;
	if (isRoot && parentTreeNode) {
		const counts = countChildrenPerSide(parentTreeNode);
		direction = counts.left < counts.right ? 'left' : 'right';
	} else {
		direction = detectDirection(parentNode, data);
	}

	const existingChildren = getDirectChildNodes(parentNodeId, data);

	// 计算 x 位置
	let x: number;
	if (direction === 'right') {
		x = parentNode.x + parentNode.width + config.horizontalGap;
	} else {
		x = parentNode.x - config.nodeWidth - config.horizontalGap;
	}

	// 计算 y 位置：同侧最后一个子节点下方，或父节点垂直居中对齐
	let y: number;
	const sameSideChildren = existingChildren.filter(c => {
		const childCx = c.x + c.width / 2;
		const parentCx = parentNode.x + parentNode.width / 2;
		return direction === 'right' ? childCx > parentCx : childCx < parentCx;
	});

	if (sameSideChildren.length > 0) {
		const lastChild = sameSideChildren[sameSideChildren.length - 1];
		y = lastChild.y + lastChild.height + config.verticalGap;
	} else {
		y = parentNode.y + (parentNode.height - config.nodeHeight) / 2;
	}

	// 创建新节点和边
	const newNode = createTextNode(
		x, y, config.nodeWidth, config.nodeHeight,
		initialText,
		parentNode.color,
	);
	const edge = createMindmapEdge(genId(), parentNodeId, newNode.id, data.nodes, parentNode.color);

	const newNodes = [...data.nodes, newNode];
	const newEdges = [...data.edges, edge];

	return {
		data: { ...data, nodes: newNodes, edges: newEdges },
		newNodeId: newNode.id,
		relayoutParentId: parentNodeId,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// 添加兄弟节点
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 在当前节点下方添加兄弟节点。
 * 根节点不能加兄弟 → 改为 addChild。
 */
export function addSibling(
	data: IMindmapData,
	currentNodeId: string,
	config: INodeOpsConfig,
	initialText: string = '',
): INodeOperationResult | null {
	const currentNode = data.nodes.find(n => n.id === currentNodeId);
	if (!currentNode) { return null; }

	const parent = getParentNode(currentNodeId, data);
	if (!parent) {
		// 根节点 — 改为加子
		return addChild(data, currentNodeId, config, initialText);
	}

	const x = currentNode.x;
	const y = currentNode.y + currentNode.height + config.verticalGap;

	const newNode = createTextNode(
		x, y, config.nodeWidth, config.nodeHeight,
		initialText,
		currentNode.color,
	);
	const edge = createMindmapEdge(genId(), parent.id, newNode.id, data.nodes, currentNode.color);

	const newNodes = [...data.nodes, newNode];
	const newEdges = [...data.edges, edge];

	return {
		data: { ...data, nodes: newNodes, edges: newEdges },
		newNodeId: newNode.id,
		relayoutParentId: parent.id,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// 删除节点并聚焦父节点
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 删除节点。孤儿子节点重连到父节点。
 * 不删除根节点。
 */
export function deleteAndFocusParent(
	data: IMindmapData,
	currentNodeId: string,
): INodeOperationResult | null {
	const currentNode = data.nodes.find(n => n.id === currentNodeId);
	if (!currentNode) { return null; }

	const parent = getParentNode(currentNodeId, data);
	if (!parent) { return null; } // 不删除根

	// 收集孤儿子节点
	const orphans = getDirectChildNodes(currentNodeId, data);

	// 删除节点的边（入边 + 出边）
	let newEdges = data.edges.filter(e =>
		e.fromNode !== currentNodeId && e.toNode !== currentNodeId
	);

	// 孤儿子节点重连到父
	const newEdgeRecords: IMindmapEdge[] = [];
	for (const orphan of orphans) {
		newEdgeRecords.push(createMindmapEdge(genId(), parent.id, orphan.id, data.nodes));
	}
	newEdges = [...newEdges, ...newEdgeRecords];

	// 删除节点
	const newNodes = data.nodes.filter(n => n.id !== currentNodeId);

	return {
		data: { ...data, nodes: newNodes, edges: newEdges },
		focusNodeId: parent.id,
		relayoutParentId: parent.id,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// 翻转分支到对侧
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 将节点及其所有后代绕父节点中心 X 镜像翻转。
 * 原地修改 data（浅拷贝确保不可变语义）。
 */
export function flipBranch(
	data: IMindmapData,
	nodeId: string,
): INodeOperationResult | null {
	const node = data.nodes.find(n => n.id === nodeId);
	if (!node) { return null; }

	const parent = getParentNode(nodeId, data);
	if (!parent) { return null; } // 根不能翻

	const parentCx = parent.x + parent.width / 2;

	// BFS 收集本分支所有节点
	const allNodes = [node, ...collectDescendantNodes(nodeId, data)];

	// 以浅拷贝保持不可变性
	const newNodes = data.nodes.map(n => {
		const found = allNodes.find(a => a.id === n.id);
		if (!found) { return n; }
		return {
			...n,
			x: 2 * parentCx - n.x - n.width,
		};
	});

	return {
		data: { ...data, nodes: newNodes },
		relayoutParentId: parent.id,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// 平衡布局切换
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 切换平衡布局。
 * 全部在一侧 → 奇数位分布到对侧。
 * 已分布两侧 → 全部镜像回右侧。
 */
export function toggleBalancedLayout(
	data: IMindmapData,
	parentNodeId: string,
): INodeOperationResult | null {
	const parentNode = data.nodes.find(n => n.id === parentNodeId);
	if (!parentNode) { return null; }

	const children = getDirectChildNodes(parentNodeId, data);
	if (children.length < 2) { return null; }

	const nodeCx = parentNode.x + parentNode.width / 2;

	// 检查是否全部在一侧
	let allRight = true;
	let allLeft = true;
	for (const child of children) {
		const childCx = child.x + child.width / 2;
		if (childCx >= nodeCx) { allLeft = false; }
		else { allRight = false; }
	}
	const allOneSide = allRight || allLeft;

	// 写回新的 x 值
	const newNodes = data.nodes.map(n => {
		const child = children.find(c => c.id === n.id);
		if (!child) { return n; }

		if (allOneSide) {
			// 均衡：奇数位镜像到对侧
			const sorted = [...children].sort((a, b) => a.y - b.y);
			const idx = sorted.findIndex(c => c.id === n.id);
			if (idx >= 0 && idx % 2 === 1) {
				const mirrorX = nodeCx - (n.x + n.width / 2 - nodeCx) - n.width / 2;
				return { ...n, x: mirrorX };
			}
			return n;
		} else {
			// 全部回右侧
			const childCx = n.x + n.width / 2;
			if (childCx < nodeCx) {
				const mirrorX = nodeCx + (nodeCx - childCx) - n.width / 2;
				return { ...n, x: mirrorX };
			}
			return n;
		}
	});

	return {
		data: { ...data, nodes: newNodes },
		relayoutParentId: parentNodeId,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════════════════

function cloneData(data: IMindmapData): IMindmapData {
	return {
		nodes: data.nodes.map(n => ({ ...n })),
		edges: data.edges.map(e => ({ ...e })),
		mindmap: data.mindmap,
	};
}
