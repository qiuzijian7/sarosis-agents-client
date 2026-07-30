/*---------------------------------------------------------------------------------------------
 *  Sarosis Agents — Mindmap Contour-based Layout Engine
 *
 *  移植自 Mindvas mindmap/layout-engine.ts。
 *  Contour packing 算法：
 *    每棵子树在 y=0 独立布局，返回 Map<depth, {top,bottom}> 轮廓。
 *    packSubtrees 逐个下移子树直到在所有共享 depth 列避开已合并轮廓。
 *    直接子节点块围绕父节点垂直中心整体平移。
 *    左/右分支独立上述流程（x 方向镜像）。
 *
 *  纯函数：输入数据 + 配置 → 输出 Map<nodeId, {x,y}>。
 *  调用方负责应用位置到数据/视口。
 *--------------------------------------------------------------------------------------------*/

import type {
	IMindmapData,
	INodePosition, ILayoutConfig, IDepthExtent, BranchDirection,
} from './mindmapTypes.js';
import { DEFAULT_LAYOUT_CONFIG } from './mindmapTypes.js';
import {
	buildForest, findTreeForNode, getDescendants,
	type TreeNode,
} from './treeModel.js';
import { updateAllEdgeSides } from './edgeSides.js';

// ═══════════════════════════════════════════════════════════════════════════
// 内部类型
// ═══════════════════════════════════════════════════════════════════════════

/** 子树布局结果 */
interface SubtreeInfo {
	positions: Map<string, INodePosition>;
	contour: Map<number, IDepthExtent>;
}

/** 布局输出 */
export interface ILayoutResult {
	/** nodeId → 新位置 */
	positions: Map<string, INodePosition>;
	/** 边侧是否需要更新 */
	edgesChanged: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// LayoutEngine 类
// ═══════════════════════════════════════════════════════════════════════════

export class LayoutEngine {
	constructor(private config: ILayoutConfig = { ...DEFAULT_LAYOUT_CONFIG }) {}

	get horizontalGap(): number { return this.config.horizontalGap; }
	get verticalGap(): number { return this.config.verticalGap; }

	// ── 全量布局 ──────────────────────────────────────────────────────

	/**
	 * 计算整个画布的布局。
	 * 每棵树的左/右分支独立布局，围绕各自树的根节点垂直居中。
	 */
	computeLayout(data: IMindmapData): ILayoutResult {
		const forest = buildForest(data);
		if (forest.length === 0) { return { positions: new Map(), edgesChanged: false }; }

		const positions = new Map<string, INodePosition>();

		for (const root of forest) {
			const rootX = root.node.x;
			const rootY = root.node.y;
			positions.set(root.node.id, { x: rootX, y: rootY });

			const rightChildren = root.children.filter(c => c.direction === 'right');
			const leftChildren = root.children.filter(c => c.direction === 'left');

			this.layoutGroup(rightChildren, 'right', rootX, rootY, root.node.width, root.node.height, positions);
			this.layoutGroup(leftChildren, 'left', rootX, rootY, root.node.width, root.node.height, positions);
		}

		const edgesChanged = updateAllEdgeSides(data);
		return { positions, edgesChanged };
	}

	// ── 局部重排 ──────────────────────────────────────────────────────

	/**
	 * 仅重排指定父节点的子节点（及子树）。父节点位置不动。
	 */
	computeChildrenLayout(data: IMindmapData, parentNodeId: string): ILayoutResult {
		const forest = buildForest(data);
		if (forest.length === 0) { return { positions: new Map(), edgesChanged: false }; }

		const parentTreeNode = findTreeForNode(forest, parentNodeId);
		if (!parentTreeNode || parentTreeNode.children.length === 0) {
			return { positions: new Map(), edgesChanged: false };
		}

		const positions = new Map<string, INodePosition>();
		const px = parentTreeNode.node.x;
		const py = parentTreeNode.node.y;
		const pw = parentTreeNode.node.width;
		const ph = parentTreeNode.node.height;

		if (!parentTreeNode.parent) {
			// 根：按左右方向分区
			const rightChildren = parentTreeNode.children.filter(c => c.direction === 'right');
			const leftChildren = parentTreeNode.children.filter(c => c.direction === 'left');
			this.layoutGroup(rightChildren, 'right', px, py, pw, ph, positions);
			this.layoutGroup(leftChildren, 'left', px, py, pw, ph, positions);
		} else {
			// 非根：按实际 x 位置分区
			const parentCx = px + pw / 2;
			const rightChildren = parentTreeNode.children.filter(c => {
				const cx = c.node.x + c.node.width / 2;
				return cx >= parentCx;
			});
			const leftChildren = parentTreeNode.children.filter(c => {
				const cx = c.node.x + c.node.width / 2;
				return cx < parentCx;
			});
			this.layoutGroup(rightChildren, 'right', px, py, pw, ph, positions);
			this.layoutGroup(leftChildren, 'left', px, py, pw, ph, positions);
		}

		const edgesChanged = updateAllEdgeSides(data);
		return { positions, edgesChanged };
	}

	// ── 森林网格布局 ──────────────────────────────────────────────────

	/**
	 * 将组内的多棵树按流式网格排列。
	 * 先对各树内部布局，再按行（≈√N 列目标宽度）打包。
	 * 返回所有节点的新位置 + 组 bounds。
	 */
	computeForestLayout(data: IMindmapData, groupNodeId: string): {
		positions: Map<string, INodePosition>;
		groupBounds: { x: number; y: number; width: number; height: number } | null;
	} {
		const groupNode = data.nodes.find(n => n.id === groupNodeId);
		if (!groupNode) { return { positions: new Map(), groupBounds: null }; }

		// 先各树内部布局
		const forest = buildForest(data);
		const roots = forest.filter(root => {
			const cx = root.node.x + root.node.width / 2;
			const cy = root.node.y + root.node.height / 2;
			return cx >= groupNode.x && cx <= groupNode.x + groupNode.width
				&& cy >= groupNode.y && cy <= groupNode.y + groupNode.height;
		});

		for (const root of roots) {
			this.computeChildrenLayout(data, root.node.id);
		}
		if (roots.length <= 1) {
			return { positions: new Map(), groupBounds: null };
		}

		// 计算每棵树的包围盒
		const treeBboxes = roots.map(root => ({
			root,
			bbox: getTreeBbox(root),
		}));

		// 按位置排序
		treeBboxes.sort((a, b) => {
			const dy = a.root.node.y - b.root.node.y;
			if (Math.abs(dy) > 50) { return dy; }
			return a.root.node.x - b.root.node.x;
		});

		const gap = this.config.horizontalGap * 1.5;
		const vGap = this.config.verticalGap * 3;
		const treeSizes = treeBboxes.map(t => ({
			w: t.bbox.maxX - t.bbox.minX,
			h: t.bbox.maxY - t.bbox.minY,
		}));

		const treesPerRow = Math.ceil(Math.sqrt(roots.length));
		const avgWidth = treeSizes.reduce((sum, s) => sum + s.w, 0) / treeSizes.length;
		const targetWidth = treesPerRow * (avgWidth + gap);

		// 流式分包
		const rows: number[][] = [];
		let currentRow: number[] = [];
		let currentRowWidth = 0;
		for (let i = 0; i < treeBboxes.length; i++) {
			const treeW = treeSizes[i].w + (currentRow.length > 0 ? gap : 0);
			if (currentRow.length > 0 && currentRowWidth + treeW > targetWidth) {
				rows.push(currentRow);
				currentRow = [i];
				currentRowWidth = treeSizes[i].w;
			} else {
				currentRow.push(i);
				currentRowWidth += treeW;
			}
		}
		if (currentRow.length > 0) { rows.push(currentRow); }

		const PADDING = 20;
		const originX = groupNode.x + PADDING;
		const originY = groupNode.y + PADDING;
		let cursorY = originY;

		const positions = new Map<string, INodePosition>();
		let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;

		for (const row of rows) {
			const rowHeight = Math.max(...row.map(i => treeSizes[i].h));
			let cursorX = originX;

			for (const i of row) {
				const t = treeBboxes[i];
				const dx = cursorX - t.bbox.minX;
				const dy = cursorY - t.bbox.minY;

				const allNodes = [t.root, ...getDescendants(t.root)];
				for (const treeNode of allNodes) {
					positions.set(treeNode.node.id, {
						x: treeNode.node.x + dx,
						y: treeNode.node.y + dy,
					});
					gMinX = Math.min(gMinX, treeNode.node.x + dx);
					gMinY = Math.min(gMinY, treeNode.node.y + dy);
					gMaxX = Math.max(gMaxX, treeNode.node.x + dx + treeNode.node.width);
					gMaxY = Math.max(gMaxY, treeNode.node.y + dy + treeNode.node.height);
				}

				cursorX += treeSizes[i].w + gap;
			}

			cursorY += rowHeight + vGap;
		}

		updateAllEdgeSides(data);

		const groupBounds = {
			x: gMinX - PADDING,
			y: gMinY - PADDING,
			width: (gMaxX - gMinX) + PADDING * 2,
			height: (gMaxY - gMinY) + PADDING * 2,
		};

		return { positions, groupBounds };
	}

	// ── 核心：分组布局 ────────────────────────────────────────────────

	/**
	 * 对同侧子节点组执行 contour packing：
	 * 每个子树独立在 y=0 布局 → packSubtrees 紧凑排布 → 围绕父节点垂直中心平移。
	 */
	private layoutGroup(
		children: TreeNode[],
		direction: BranchDirection,
		rootX: number, rootY: number, rootW: number, rootH: number,
		positions: Map<string, INodePosition>,
	): void {
		if (children.length === 0) { return; }

		const rootCenterY = rootY + rootH / 2;

		// 每个子树在 y=0 独立布局
		const subtrees: SubtreeInfo[] = [];
		for (const child of children) {
			const childW = child.node.width || this.config.nodeWidth;
			const childX = direction === 'right'
				? rootX + rootW + this.config.horizontalGap
				: rootX - childW - this.config.horizontalGap;

			const tempPositions = new Map<string, INodePosition>();
			const contour = this.layoutSubtree(child, childX, 0, 0, direction, tempPositions);
			subtrees.push({ positions: tempPositions, contour });
		}

		// Contour packing 紧凑排布
		const { yOffsets } = packSubtrees(subtrees, this.config.verticalGap);

		// 直接子节点块围绕父节点垂直中心平移
		const lastIdx = children.length - 1;
		const lastChildH = children[lastIdx].node.height || this.config.nodeHeight;
		const blockTop = yOffsets[0];
		const blockBottom = yOffsets[lastIdx] + lastChildH;
		const globalShift = rootCenterY - (blockTop + blockBottom) / 2;

		// 合并到最终 positions
		for (let i = 0; i < subtrees.length; i++) {
			const yShift = yOffsets[i] + globalShift;
			for (const [id, pos] of subtrees[i].positions) {
				positions.set(id, { x: pos.x, y: pos.y + yShift });
			}
		}
	}

	// ── 递归子树布局 ──────────────────────────────────────────────────

	/**
	 * 递归布局节点及其后代。返回轮廓（depth → 垂直范围）。
	 */
	private layoutSubtree(
		node: TreeNode,
		nodeX: number, nodeY: number,
		depth: number,
		direction: BranchDirection,
		positions: Map<string, INodePosition>,
	): Map<number, IDepthExtent> {
		const nodeH = node.node.height || this.config.nodeHeight;
		const nodeW = node.node.width || this.config.nodeWidth;

		positions.set(node.node.id, { x: nodeX, y: nodeY });

		const contour: Map<number, IDepthExtent> = new Map();
		contour.set(depth, { top: nodeY, bottom: nodeY + nodeH });

		if (node.children.length === 0) { return contour; }

		// 子节点各自在 y=0 独立布局
		const childSubtrees: SubtreeInfo[] = [];
		for (const child of node.children) {
			const childW = child.node.width || this.config.nodeWidth;
			const childX = direction === 'right'
				? nodeX + nodeW + this.config.horizontalGap
				: nodeX - childW - this.config.horizontalGap;

			const tempPositions = new Map<string, INodePosition>();
			const childContour = this.layoutSubtree(child, childX, 0, depth + 1, direction, tempPositions);
			childSubtrees.push({ positions: tempPositions, contour: childContour });
		}

		// Pack + 围绕当前 node 垂直居中
		const { yOffsets, combinedContour } = packSubtrees(childSubtrees, this.config.verticalGap);

		const lastIdx = node.children.length - 1;
		const lastChildH = node.children[lastIdx].node.height || this.config.nodeHeight;
		const blockTop = yOffsets[0];
		const blockBottom = yOffsets[lastIdx] + lastChildH;
		const centerShift = (nodeY + nodeH / 2) - (blockTop + blockBottom) / 2;

		// 应用偏移、合并子位置
		for (let i = 0; i < childSubtrees.length; i++) {
			const yShift = yOffsets[i] + centerShift;
			for (const [id, pos] of childSubtrees[i].positions) {
				positions.set(id, { x: pos.x, y: pos.y + yShift });
			}
		}

		// 合并平移后的子轮廓
		for (const [d, ext] of combinedContour) {
			const shifted = { top: ext.top + centerShift, bottom: ext.bottom + centerShift };
			const existing = contour.get(d);
			if (existing) {
				if (shifted.top < existing.top) { existing.top = shifted.top; }
				if (shifted.bottom > existing.bottom) { existing.bottom = shifted.bottom; }
			} else {
				contour.set(d, { ...shifted });
			}
		}

		return contour;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Contour packing（纯函数）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 使用轮廓比较紧凑垂直排列子树。
 * 第一棵子树在 y=0；后续每棵下移刚好避开合并轮廓的垂直间隙。
 */
function packSubtrees(
	subtrees: SubtreeInfo[],
	verticalGap: number,
): { yOffsets: number[]; combinedContour: Map<number, IDepthExtent> } {
	if (subtrees.length === 0) {
		return { yOffsets: [], combinedContour: new Map() };
	}

	const yOffsets: number[] = [0];

	// 克隆第一棵子树轮廓为合并基准
	const combinedContour: Map<number, IDepthExtent> = new Map();
	for (const [d, ext] of subtrees[0].contour) {
		combinedContour.set(d, { top: ext.top, bottom: ext.bottom });
	}

	for (let i = 1; i < subtrees.length; i++) {
		const sub = subtrees[i];

		// 找到最小 Y 偏移使这棵子树避开所有共享 depth 的合并轮廓
		let shift = 0;
		for (const [d, ext] of sub.contour) {
			const prev = combinedContour.get(d);
			if (prev !== undefined) {
				const needed = prev.bottom + verticalGap - ext.top;
				if (needed > shift) { shift = needed; }
			}
		}

		yOffsets.push(shift);

		// 合并平移后轮廓
		for (const [d, ext] of sub.contour) {
			const shifted = { top: ext.top + shift, bottom: ext.bottom + shift };
			const existing = combinedContour.get(d);
			if (existing) {
				if (shifted.top < existing.top) { existing.top = shifted.top; }
				if (shifted.bottom > existing.bottom) { existing.bottom = shifted.bottom; }
			} else {
				combinedContour.set(d, { ...shifted });
			}
		}
	}

	return { yOffsets, combinedContour };
}

// ═══════════════════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════════════════

function getTreeBbox(root: TreeNode): { minX: number; minY: number; maxX: number; maxY: number } {
	const allNodes = [root, ...getDescendants(root)];
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const treeNode of allNodes) {
		const n = treeNode.node;
		minX = Math.min(minX, n.x);
		minY = Math.min(minY, n.y);
		maxX = Math.max(maxX, n.x + n.width);
		maxY = Math.max(maxY, n.y + n.height);
	}
	return { minX, minY, maxX, maxY };
}
