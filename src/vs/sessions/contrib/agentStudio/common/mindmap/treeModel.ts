/*---------------------------------------------------------------------------------------------
 *  Saros Agents — Mindmap Tree Model
 *
 *  从扁平 nodes+edges 构建森林（多棵树）。
 *  移植自 Mindvas mindmap/tree-model.ts，去掉 Obsidian Canvas 运行时依赖。
 *--------------------------------------------------------------------------------------------*/

import type { IMindmapData, IMindmapNode, IMindmapEdge, BranchDirection } from './mindmapTypes.js';

// ═══════════════════════════════════════════════════════════════════════════
// 树节点
// ═══════════════════════════════════════════════════════════════════════════

export interface TreeNode {
	node: IMindmapNode;
	parent: TreeNode | null;
	children: TreeNode[];
	depth: number;
	/** 同胞序号（按 y 位置升序） */
	siblingIndex: number;
	/** 分支方向：null 表示根，非 null 表示继承的分支方向 */
	direction: BranchDirection | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 森林构建
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从扁平数据构建森林。
 * 无入边节点为树根。跳过 group 类型节点。
 * 多根按子树大小降序排列。
 */
export function buildForest(data: IMindmapData, includeGroups = false): TreeNode[] {
	const nodeMap = new Map<string, TreeNode>();
	const childIds = new Set<string>();

	// 找出所有是边目标的节点（有父）
	for (const edge of data.edges) {
		childIds.add(edge.toNode);
	}

	// 收集 group 节点 ID
	const groupIds = new Set<string>();
	for (const node of data.nodes) {
		if (node.type === 'group') {
			groupIds.add(node.id);
		}
	}

	// 为非 group 节点创建 TreeNode（直接引用原 node 对象以支持位置写回）
	for (const node of data.nodes) {
		if (groupIds.has(node.id)) { continue; }
		nodeMap.set(node.id, {
			node,
			parent: null,
			children: [],
			depth: 0,
			siblingIndex: 0,
			direction: null,
		});
	}

	// 从边建父子关系
	for (const edge of data.edges) {
		const parentTree = nodeMap.get(edge.fromNode);
		const childTree = nodeMap.get(edge.toNode);
		if (parentTree && childTree) {
			// 折叠节点（expanded===false）不展开其子节点：其后代不进入森林，
			// 因此不参与布局、导航与大纲，仅节点本身保持可见。
			if (parentTree.node.expanded === false) {
				continue;
			}
			childTree.parent = parentTree;
			parentTree.children.push(childTree);
		}
	}

	// Children 按 y 排序 → 分配 siblingIndex
	for (const treeNode of nodeMap.values()) {
		treeNode.children.sort((a, b) => a.node.y - b.node.y);
		treeNode.children.forEach((child, i) => { child.siblingIndex = i; });
	}

	// 收集所有根（无入边节点）
	const roots: TreeNode[] = [];
	for (const node of data.nodes) {
		if (!childIds.has(node.id)) {
			const treeNode = nodeMap.get(node.id);
			if (treeNode) {
				setDepths(treeNode, 0);
				assignDirections(treeNode);
				roots.push(treeNode);
			}
		}
	}

	// 按子树大小降序
	roots.sort((a, b) => countReachable(b) - countReachable(a));

	return roots;
}

// ═══════════════════════════════════════════════════════════════════════════
// 查询
// ═══════════════════════════════════════════════════════════════════════════

/** 在森林中按 nodeId 查找 TreeNode */
export function findTreeForNode(forest: TreeNode[], nodeId: string): TreeNode | null {
	for (const root of forest) {
		const found = findTreeNode(root, nodeId);
		if (found) { return found; }
	}
	return null;
}

/** 获取节点所有后代 */
export function getDescendants(node: TreeNode): TreeNode[] {
	const result: TreeNode[] = [];
	for (const child of node.children) {
		result.push(child);
		result.push(...getDescendants(child));
	}
	return result;
}

/** 下一个同胞 */
export function getNextSibling(node: TreeNode): TreeNode | null {
	if (!node.parent) { return null; }
	const siblings = node.parent.children;
	const idx = siblings.indexOf(node);
	return idx < siblings.length - 1 ? siblings[idx + 1] : null;
}

/** 上一个同胞 */
export function getPrevSibling(node: TreeNode): TreeNode | null {
	if (!node.parent) { return null; }
	const siblings = node.parent.children;
	const idx = siblings.indexOf(node);
	return idx > 0 ? siblings[idx - 1] : null;
}

/** 统计根的直接子节点在左右两侧的分布 */
export function countChildrenPerSide(root: TreeNode): { left: number; right: number } {
	let left = 0;
	let right = 0;
	for (const child of root.children) {
		if (child.direction === 'left') { left++; } else { right++; }
	}
	return { left, right };
}

// ═══════════════════════════════════════════════════════════════════════════
// 内部辅助
// ═══════════════════════════════════════════════════════════════════════════

function countReachable(node: TreeNode): number {
	let count = 1;
	for (const child of node.children) {
		count += countReachable(child);
	}
	return count;
}

/**
 * 返回某分组（group）所包含的成员节点 id 列表。
 * 采用「几何包含」规则：成员节点中心点落在分组矩形 (x, y, width, height) 内，
 * 与 layoutEngine.computeForestLayout 的包围盒判定一致。
 * 用于分组可视化（计算包围盒）与框选命中判定。
 */
export function getGroupMemberIds(data: IMindmapData, groupId: string): string[] {
	const group = data.nodes.find(n => n.id === groupId);
	if (!group) { return []; }
	const gx = group.x ?? 0;
	const gy = group.y ?? 0;
	const gw = group.width ?? 0;
	const gh = group.height ?? 0;
	if (gw <= 0 || gh <= 0) { return []; }
	const result: string[] = [];
	for (const n of data.nodes) {
		if (n.id === groupId || n.type === 'group') { continue; }
		const cx = (n.x ?? 0) + (n.width ?? 0) / 2;
		const cy = (n.y ?? 0) + (n.height ?? 0) / 2;
		if (cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh) {
			result.push(n.id);
		}
	}
	return result;
}

function setDepths(node: TreeNode, depth: number): void {
	node.depth = depth;
	for (const child of node.children) {
		setDepths(child, depth + 1);
	}
}

function findTreeNode(root: TreeNode, nodeId: string): TreeNode | null {
	if (root.node.id === nodeId) { return root; }
	for (const child of root.children) {
		const found = findTreeNode(child, nodeId);
		if (found) { return found; }
	}
	return null;
}

/**
 * 推断分支方向。
 * depth-1 子节点：按子中心 x ≥ 根中心 x 判 right/left。
 * 更深层子节点：继承分支方向。
 */
function assignDirections(root: TreeNode): void {
	const rootCx = root.node.x + root.node.width / 2;

	for (const child of root.children) {
		const childCx = child.node.x + child.node.width / 2;
		child.direction = childCx >= rootCx ? 'right' : 'left';
		propagateDirection(child, child.direction);
	}
}

function propagateDirection(node: TreeNode, dir: BranchDirection): void {
	for (const child of node.children) {
		child.direction = dir;
		propagateDirection(child, dir);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// 检测方向（运行期，不依赖 assignDirections）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 检测节点的实际分支方向。
 * 如果节点有子节点，用子节点位置判断。
 * 否则，用自身相对父节点的位置判断。
 */
export function detectDirection(node: IMindmapNode, data: IMindmapData): BranchDirection {
	const nodeCx = node.x + node.width / 2;

	// 如果有子节点，方向匹配子节点的实际位置
	const children = getDirectChildNodes(node.id, data);
	if (children.length > 0) {
		const firstChildCx = children[0].x + children[0].width / 2;
		return firstChildCx < nodeCx ? 'left' : 'right';
	}

	// 无子节点——从父节点判断自己在父节点的哪一侧
	const parent = getParentNode(node.id, data);
	if (parent) {
		const parentCx = parent.x + parent.width / 2;
		return nodeCx < parentCx ? 'left' : 'right';
	}

	return 'right';
}

// ═══════════════════════════════════════════════════════════════════════════
// 数据层查父子关系（无 TreeNode 时使用）
// ═══════════════════════════════════════════════════════════════════════════

/** 获取直接父节点 */
export function getParentNode(nodeId: string, data: IMindmapData): IMindmapNode | null {
	const incoming = data.edges.find(e => e.toNode === nodeId);
	if (!incoming) { return null; }
	return data.nodes.find(n => n.id === incoming.fromNode) ?? null;
}

/** 获取直接子节点（按 y 升序） */
export function getDirectChildNodes(parentId: string, data: IMindmapData): IMindmapNode[] {
	const outgoing = data.edges.filter(e => e.fromNode === parentId);
	const children = outgoing
		.map(e => data.nodes.find(n => n.id === e.toNode))
		.filter((n): n is IMindmapNode => n !== undefined);
	children.sort((a, b) => a.y - b.y);
	return children;
}

/** 获取同胞节点 */
export function getSiblingNodes(nodeId: string, data: IMindmapData): IMindmapNode[] {
	const parent = getParentNode(nodeId, data);
	if (!parent) { return []; }
	return getDirectChildNodes(parent.id, data).filter(n => n.id !== nodeId);
}

/** 获取出边 */
export function getOutgoingEdges(fromNodeId: string, data: IMindmapData): IMindmapEdge[] {
	return data.edges.filter(e => e.fromNode === fromNodeId);
}

/** 获取节点所有后代（BFS），返回节点对象 */
export function collectDescendantNodes(rootNodeId: string, data: IMindmapData): IMindmapNode[] {
	const result: IMindmapNode[] = [];
	const visited = new Set<string>([rootNodeId]);
	const queue = [rootNodeId];
	while (queue.length > 0) {
		const id = queue.shift()!;
		for (const edge of getOutgoingEdges(id, data)) {
			const childId = edge.toNode;
			if (!visited.has(childId)) {
				visited.add(childId);
				const childNode = data.nodes.find(n => n.id === childId);
				if (childNode) {
					result.push(childNode);
					queue.push(childId);
				}
			}
		}
	}
	return result;
}

/**
 * 计算当前应可见的节点集合：从根（无父节点）出发，遇到 expanded===false 的节点则停止深入其后代。
 * 折叠节点本身仍可见，但其后代被隐藏（不渲染、不绘制其边）。
 */
export function getVisibleNodeIds(data: IMindmapData): Set<string> {
	const parentOf = new Map<string, string>();
	for (const edge of data.edges) {
		parentOf.set(edge.toNode, edge.fromNode);
	}
	const visible = new Set<string>();
	const roots = data.nodes.filter(n => !parentOf.has(n.id));
	const stack = roots.map(r => r.id);
	while (stack.length) {
		const id = stack.pop()!;
		visible.add(id);
		const node = data.nodes.find(n => n.id === id);
		if (node && node.expanded === false) {
			continue;
		}
		for (const edge of data.edges) {
			if (edge.fromNode === id) {
				stack.push(edge.toNode);
			}
		}
	}
	return visible;
}
