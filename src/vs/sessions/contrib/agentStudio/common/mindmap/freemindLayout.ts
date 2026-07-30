/*---------------------------------------------------------------------------------------------
 *  Sarosis Agents — Mindmap FreeMind Layout Engine
 *
 *  移植自 Mindvas import/freemind-import.ts 中的布局部分。
 *  输入：FreeMind 树形数据（已解析的 XML 节点树）
 *  输出：IMindmapData（Canvas JSON 格式）
 *
 *  支持多根节点、left/right 分支定位、高度估算。
 *  XML 解析在 browser 层（DOMParser），布局计算在此纯逻辑层。
 *--------------------------------------------------------------------------------------------*/

import type { IMindmapData, IMindmapNode, IMindmapEdge } from './mindmapTypes.js';
import { genId } from './idGenerator.js';

// ═══════════════════════════════════════════════════════════════════════════
// FreeMind 节点类型（已解析的树形数据）
// ═══════════════════════════════════════════════════════════════════════════

type Position = 'left' | 'right';

export interface IFreeMindNode {
	text: string;
	position: Position;
	children: IFreeMindNode[];
}

export interface IFreeMindLayoutOptions {
	nodeWidth: number;
	nodeHeight: number;
	maxNodeHeight: number;
	horizontalGap: number;
	verticalGap: number;
}

const DEFAULT_FREEMIND_OPTIONS: IFreeMindLayoutOptions = {
	nodeWidth: 300,
	nodeHeight: 60,
	maxNodeHeight: 300,
	horizontalGap: 80,
	verticalGap: 20,
};

// ═══════════════════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 将 FreeMind 根节点列表转换为 Canvas JSON 数据。
 * @param roots FreeMind 根节点数组（从 XML 解析得到）
 * @param opts 布局选项
 */
export function freemindToCanvas(
	roots: IFreeMindNode[],
	opts: Partial<IFreeMindLayoutOptions> = {},
): IMindmapData | null {
	if (roots.length === 0) { return null; }

	const options: IFreeMindLayoutOptions = { ...DEFAULT_FREEMIND_OPTIONS, ...opts };
	const nodes: IMindmapNode[] = [];
	const edges: IMindmapEdge[] = [];

	let currentY = 0;
	const treeGap = options.verticalGap * 4;

	for (const root of roots) {
		const height = layoutTree(root, 0, currentY, options, nodes, edges);
		currentY += height + treeGap;
	}

	return { nodes, edges, mindmap: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 布局单棵树
// ═══════════════════════════════════════════════════════════════════════════

function layoutTree(
	root: IFreeMindNode,
	startX: number,
	startY: number,
	opts: IFreeMindLayoutOptions,
	nodes: IMindmapNode[],
	edges: IMindmapEdge[],
): number {
	const rootH = estimateNodeHeight(root.text, opts.nodeWidth, opts.nodeHeight, opts.maxNodeHeight);
	const rootId = genId();

	nodes.push({
		id: rootId,
		type: 'text',
		x: startX,
		y: startY,
		width: opts.nodeWidth,
		height: rootH,
		text: root.text,
	});

	if (root.children.length === 0) { return rootH; }

	// 按 position 分区
	const rightChildren = root.children.filter(c => c.position === 'right');
	const leftChildren = root.children.filter(c => c.position === 'left');

	const rootCy = startY + rootH / 2;

	layoutSide(rootId, rightChildren, 'right', startX, rootCy, opts, nodes, edges);
	layoutSide(rootId, leftChildren, 'left', startX, rootCy, opts, nodes, edges);

	const rightH = groupHeight(rightChildren, opts);
	const leftH = groupHeight(leftChildren, opts);
	return Math.max(rootH, rightH, leftH);
}

// ═══════════════════════════════════════════════════════════════════════════
// 单侧子节点布局
// ═══════════════════════════════════════════════════════════════════════════

function layoutSide(
	parentId: string,
	children: IFreeMindNode[],
	side: Position,
	parentX: number,
	parentCy: number,
	opts: IFreeMindLayoutOptions,
	nodes: IMindmapNode[],
	edges: IMindmapEdge[],
): void {
	if (children.length === 0) { return; }

	const totalH = groupHeight(children, opts);
	let childY = parentCy - totalH / 2;

	const fromSide = side === 'right' ? 'right' : 'left';
	const toSide = side === 'right' ? 'left' : 'right';
	const childX = side === 'right'
		? parentX + opts.nodeWidth + opts.horizontalGap
		: parentX - opts.nodeWidth - opts.horizontalGap;

	for (const child of children) {
		const childH = subtreeHeight(child, opts);
		const childNodeY = childY + childH / 2 - estimateNodeHeight(child.text, opts.nodeWidth, opts.nodeHeight, opts.maxNodeHeight) / 2;
		const childId = layoutBranch(child, childX, childNodeY, side, opts, nodes, edges);

		edges.push({
			id: genId(),
			fromNode: parentId,
			fromSide,
			fromEnd: 'none',
			toNode: childId,
			toSide,
			toEnd: 'arrow',
		});

		childY += childH + opts.verticalGap;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// 递归分支布局
// ═══════════════════════════════════════════════════════════════════════════

function layoutBranch(
	node: IFreeMindNode,
	x: number,
	y: number,
	side: Position,
	opts: IFreeMindLayoutOptions,
	nodes: IMindmapNode[],
	edges: IMindmapEdge[],
): string {
	const h = estimateNodeHeight(node.text, opts.nodeWidth, opts.nodeHeight, opts.maxNodeHeight);
	const id = genId();

	nodes.push({
		id,
		type: 'text',
		x,
		y,
		width: opts.nodeWidth,
		height: h,
		text: node.text,
	});

	if (node.children.length === 0) { return id; }

	const fromSide = side === 'right' ? 'right' : 'left';
	const toSide = side === 'right' ? 'left' : 'right';
	const childX = side === 'right'
		? x + opts.nodeWidth + opts.horizontalGap
		: x - opts.nodeWidth - opts.horizontalGap;

	const totalH = groupHeight(node.children, opts);
	let childY = y + h / 2 - totalH / 2;

	for (const child of node.children) {
		const childH = subtreeHeight(child, opts);
		const childNodeY = childY + childH / 2 - estimateNodeHeight(child.text, opts.nodeWidth, opts.nodeHeight, opts.maxNodeHeight) / 2;
		const childId = layoutBranch(child, childX, childNodeY, side, opts, nodes, edges);

		edges.push({
			id: genId(),
			fromNode: id,
			fromSide,
			fromEnd: 'none',
			toNode: childId,
			toSide,
			toEnd: 'arrow',
		});

		childY += childH + opts.verticalGap;
	}

	return id;
}

// ═══════════════════════════════════════════════════════════════════════════
// 高度估算 / 测量辅助
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 根据文本内容估算节点高度。
 * 对齐 Mindvas estimateNodeHeight：~8px/字符宽 × ~22px 行高 × ~20px 内边距。
 */
export function estimateNodeHeight(
	text: string,
	nodeWidth: number,
	minHeight: number,
	maxHeight: number,
): number {
	const AVG_CHAR_WIDTH = 8;
	const LINE_HEIGHT = 22;
	const PADDING = 20;

	const charsPerLine = Math.max(1, Math.floor((nodeWidth - PADDING) / AVG_CHAR_WIDTH));
	const paragraphs = text.split('\n');
	let totalLines = 0;

	for (const para of paragraphs) {
		if (para.length === 0) {
			totalLines += 1;
		} else {
			totalLines += Math.ceil(para.length / charsPerLine);
		}
	}

	const estimated = totalLines * LINE_HEIGHT + PADDING;
	return Math.min(Math.max(estimated, minHeight), maxHeight);
}

function subtreeHeight(node: IFreeMindNode, opts: IFreeMindLayoutOptions): number {
	if (node.children.length === 0) {
		return estimateNodeHeight(node.text, opts.nodeWidth, opts.nodeHeight, opts.maxNodeHeight);
	}

	let total = 0;
	for (let i = 0; i < node.children.length; i++) {
		if (i > 0) { total += opts.verticalGap; }
		total += subtreeHeight(node.children[i], opts);
	}
	return Math.max(
		estimateNodeHeight(node.text, opts.nodeWidth, opts.nodeHeight, opts.maxNodeHeight),
		total,
	);
}

function groupHeight(children: IFreeMindNode[], opts: IFreeMindLayoutOptions): number {
	if (children.length === 0) { return 0; }
	let total = 0;
	for (let i = 0; i < children.length; i++) {
		if (i > 0) { total += opts.verticalGap; }
		total += subtreeHeight(children[i], opts);
	}
	return total;
}
