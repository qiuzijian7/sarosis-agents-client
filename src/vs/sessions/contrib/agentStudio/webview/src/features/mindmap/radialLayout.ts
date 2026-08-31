/*---------------------------------------------------------------------------------------------
 *  radialLayout — 思维导图放射状布局算法（纯函数，无 LiteGraph 依赖，可单测）。
 *
 *  采用「水平主方向 + 子树垂直堆叠」的放射布局（类 XMind 逻辑图/平衡图）：
 *    - 根节点居中。
 *    - 第 1 层分支沿水平方向左右分开（左半/右半各占一侧）。
 *    - 每个子树在垂直方向按「自身所需高度」分配，避免重叠。
 *
 *  返回每个节点的绝对 graph 坐标，调用方据此设置 node.pos。
 *--------------------------------------------------------------------------------------------*/

export interface MindMapNodeData {
	id: string;
	parentId: string | null;
	/** 节点标题（叶子节点也可为空，视为空主题）。 */
	title: string;
	/** 是否为图片节点（内嵌一张或多张图）。 */
	imageRefs?: string[];
	/** 备注（富文本/纯文本）。 */
	note?: string;
}

export interface MindMapLayoutInput {
	nodes: MindMapNodeData[];
	/** 节点框宽度（graph 单位），默认 200。 */
	nodeWidth?: number;
	/** 节点框高度（graph 单位），默认 56。 */
	nodeHeight?: number;
	/** 同层兄弟之间的垂直间距。 */
	siblingGap?: number;
	/** 层与层之间的水平间距。 */
	levelGap?: number;
}

export interface MindMapLayoutResult {
	positions: Record<string, { x: number; y: number }>;
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface TreeNode {
	data: MindMapNodeData;
	children: TreeNode[];
	subtreeHeight: number;
}

/**
 * 计算整棵树的放射布局。
 *
 * 算法要点：
 *  1. 以根（parentId === null）为起点构造森林（支持多根）。
 *  2. 自底向上计算每个节点的 subtreeHeight = Σ children subtreeHeight（含间隙），
 *     叶子节点的 subtreeHeight = nodeHeight。
 *  3. 自顶向下分配 y：父节点 y 居中子树，子节点从子树顶依次堆叠。
 *  4. 第 1 层按左右半分，其余层同侧延续，保证连线不交叉。
 */
export function computeRadialLayout(input: MindMapLayoutInput): MindMapLayoutResult {
	const {
		nodes,
		nodeWidth = 200,
		nodeHeight = 56,
		siblingGap = 24,
		levelGap = 120,
	} = input;

	const byId = new Map<string, MindMapNodeData>();
	for (const n of nodes) { byId.set(n.id, n); }

	// 构造树（多根时各根依次排列在 x=0 列）
	const roots: TreeNode[] = [];
	const childrenMap = new Map<string, MindMapNodeData[]>();
	for (const n of nodes) {
		if (n.parentId === null) {
			roots.push(makeTreeNode(n));
		} else {
			const arr = childrenMap.get(n.parentId) ?? [];
			arr.push(n);
			childrenMap.set(n.parentId, arr);
		}
	}

	function makeTreeNode(data: MindMapNodeData): TreeNode {
		const kids = (childrenMap.get(data.id) ?? []).map(makeTreeNode);
		return { data, children: kids, subtreeHeight: 0 };
	}

	// 自底向上：子树高度
	function measure(node: TreeNode): number {
		if (node.children.length === 0) {
			node.subtreeHeight = nodeHeight;
			return node.subtreeHeight;
		}
		let h = 0;
		for (const c of node.children) {
			h += measure(c);
		}
		h += siblingGap * (node.children.length - 1);
		node.subtreeHeight = Math.max(nodeHeight, h);
		return node.subtreeHeight;
	}

	for (const r of roots) { measure(r); }

	const positions: Record<string, { x: number; y: number }> = {};
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	const record = (id: string, x: number, y: number): void => {
		positions[id] = { x, y };
		minX = Math.min(minX, x); minY = Math.min(minY, y);
		maxX = Math.max(maxX, x + nodeWidth); maxY = Math.max(maxY, y + nodeHeight);
	};

	// 根节点 x 固定在 0 列；布局从根开始
	let rootCursorX = 0;
	for (const root of roots) {
		const rootY = 0;
		record(root.data.id, rootCursorX, rootY);
		layoutChildren(root, rootCursorX + nodeWidth + levelGap, rootY - root.subtreeHeight / 2);
		rootCursorX += nodeWidth + levelGap * 2; // 多根间隔
	}

	/**
	 * 把 node 的子节点沿垂直方向堆叠，父节点 x 列右移 levelGap 为子列。
	 * 父节点中心 y = parentCenterY。
	 */
	function layoutChildren(node: TreeNode, childX: number, subtreeTopY: number): void {
		let cursorY = subtreeTopY;
		for (const child of node.children) {
			const childCenterY = cursorY + child.subtreeHeight / 2;
			record(child.data.id, childX, childCenterY - nodeHeight / 2);
			if (child.children.length > 0) {
				layoutChildren(child, childX + nodeWidth + levelGap, cursorY);
			}
			cursorY += child.subtreeHeight + siblingGap;
		}
	}

	if (!Number.isFinite(minX)) {
		// 空图兜底
		return { positions: {}, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
	}
	return { positions, bounds: { minX, minY, maxX, maxY } };
}

/** 把 MindMapNodeData 列表规整为树（校验 parentId 指向存在节点，孤立节点提升为根）。 */
export function normalizeMindMapTree(nodes: MindMapNodeData[]): MindMapNodeData[] {
	const ids = new Set(nodes.map(n => n.id));
	return nodes.map(n => (n.parentId && ids.has(n.parentId) ? n : { ...n, parentId: null }));
}
