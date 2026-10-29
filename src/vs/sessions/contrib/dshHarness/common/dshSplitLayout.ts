/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **桌面窗口分屏的布局树**（2026-10-29）。
 *
 * 为什么要有树：横排的"等分列"表达不了「左右 + 上下」混合、2×2、L 形 ⇒ 拖拽堆叠需要一棵
 * 递归的 h/v 树（社区 split-workspace 就是这么做的）。
 *
 * ⚠ **我们与社区的差别**：社区的 pane 是**同页里的一段 DOM**（有外壳 ⇒ 能放抓手、能画预览框）；
 *   我们的 pane 是**原生 WebContentsView**（盖在 DOM 之上）⇒ 抓手只能靠"每栏顶部留一条 DOM 带"
 *   （见 `dshFullWindowContribution.ts` 的 `DESKTOP_PANE_GRAB_H`）⇒ **抓手是渲染侧的事**，
 *   本文件只管**几何与重排**（纯函数 ⇒ 可单测 ✓）。
 *
 * 纯函数约定：
 *   · `dir: 'h'` = 水平排列（左右分栏）；`'v'` = 垂直排列（上下分栏）；
 *   · `sizes` 是各 child 的**权重**（不必和为 1，布局时按比例归一）；
 *   · 叶子 = 一个 pane（`viewId` 即那个原生视图）。
 */
export type DshSplitNode =
	| { readonly type: 'leaf'; readonly viewId: string }
	| { readonly type: 'split'; readonly dir: 'h' | 'v'; readonly sizes: readonly number[]; readonly children: readonly DshSplitNode[] };

export interface IDshSplitRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** 一条分隔线（对应一个 split 节点的一处缝隙）。 */
export interface IDshSplitDivider {
	/** `'h'` = 竖直分隔线（左右两栏之间）；`'v'` = 水平分隔线（上下两栏之间）。 */
	readonly dir: 'h' | 'v';
	/** 分隔线的**中心线**位置（沿 dir 的正交轴）。 */
	readonly pos: number;
	/** 该分隔线属于树里哪个 split 节点的第几条（拖动它就改那个节点的 sizes[index]）。 */
	readonly path: readonly number[];
	readonly index: number;
}

export interface IDshSplitLayout {
	readonly rects: ReadonlyMap<string, IDshSplitRect>;
	readonly dividers: readonly IDshSplitDivider[];
}

/** 拖拽落点：目标栏的四个方向。 */
export type DshDropZone = 'left' | 'right' | 'top' | 'bottom';

/** 树里有多少个叶子（= 多少栏）。 */
export function splitLeafCount(node: DshSplitNode): number {
	if (node.type === 'leaf') { return 1; }
	return node.children.reduce((sum, c) => sum + splitLeafCount(c), 0);
}

/** 列出树里所有叶子（从左到右 / 从上到下的顺序）。 */
export function splitLeaves(node: DshSplitNode): string[] {
	if (node.type === 'leaf') { return [node.viewId]; }
	return node.children.flatMap(splitLeaves);
}

/** 找到某个叶子（找不到返回 undefined）。 */
export function findSplitLeaf(node: DshSplitNode, viewId: string): { node: DshSplitNode; viewId: string } | undefined {
	if (node.type === 'leaf') { return node.viewId === viewId ? { node, viewId } : undefined; }
	for (const child of node.children) {
		const hit = findSplitLeaf(child, viewId);
		if (hit) { return hit; }
	}
	return undefined;
}

/**
 * 算布局：每个叶子的矩形 + 每条分隔线的位置。
 *
 * ⚠ **不含缝隙**：缝隙（gap）是**渲染侧**从每栏里扣掉的（原生视图之间要留缝给 DOM 分隔条）⇒
 *   本函数只管"比例分配"这一件事，保持纯几何、可单测 ✓。
 */
export function computeSplitLayout(node: DshSplitNode, rect: IDshSplitRect): IDshSplitLayout {
	const rects = new Map<string, IDshSplitRect>();
	const dividers: IDshSplitDivider[] = [];

	const walk = (n: DshSplitNode, r: IDshSplitRect, path: readonly number[]): void => {
		if (n.type === 'leaf') {
			rects.set(n.viewId, r);
			return;
		}
		const total = n.sizes.reduce((a, b) => a + b, 0) || n.children.length;
		let offset = 0;
		n.children.forEach((child, i) => {
			const frac = total > 0 ? (n.sizes[i] ?? 0) / total : 1 / n.children.length;
			const size = n.dir === 'h' ? r.width * frac : r.height * frac;
			const childRect: IDshSplitRect = n.dir === 'h'
				? { x: r.x + offset, y: r.y, width: size, height: r.height }
				: { x: r.x, y: r.y + offset, width: r.width, height: size };
			walk(child, childRect, [...path, i]);
			offset += size;
			// 第 i 个 child 之后 ⇒ 一条分隔线（最后一个没有）
			if (i < n.children.length - 1) {
				dividers.push({
					dir: n.dir,
					pos: n.dir === 'h' ? r.x + offset : r.y + offset,
					path,
					index: i,
				});
			}
		});
	};

	walk(node, rect, []);
	return { rects, dividers };
}

/** 把某个 split 节点的所有 size 归一为等分（拖拽落点后用 ⇒ 视觉整齐）。 */
export function equalizeSplitSizes(node: DshSplitNode): DshSplitNode {
	if (node.type === 'leaf') { return node; }
	const children = node.children.map(equalizeSplitSizes);
	return { ...node, children, sizes: children.map(() => 1) };
}

/** 从树里摘掉某个叶子（找不到返回 undefined ⇒ 调用方保持原树）。 */
export function removeSplitLeaf(node: DshSplitNode, viewId: string): DshSplitNode | undefined {
	if (node.type === 'leaf') {
		return node.viewId === viewId ? undefined : node;
	}
	const kept: DshSplitNode[] = [];
	for (const child of node.children) {
		const next = removeSplitLeaf(child, viewId);
		if (next) { kept.push(next); }
	}
	if (kept.length === node.children.length) { return node; }   // 没摘到 ⇒ 原样返回
	if (kept.length === 0) { return undefined; }
	if (kept.length === 1) { return kept[0]; }                     // 塌缩（只剩一个 ⇒ 不需要 split）
	return { ...node, children: kept, sizes: kept.map(() => 1) };
}

/** 在目标叶子的某个方向旁边插入一个新叶子（社区的 before/after 语义）。 */
function insertSplitLeaf(node: DshSplitNode, targetViewId: string, newLeaf: DshSplitNode, zone: DshDropZone): DshSplitNode | undefined {
	if (node.type === 'leaf') {
		if (node.viewId !== targetViewId) { return undefined; }
		const dir: 'h' | 'v' = zone === 'left' || zone === 'right' ? 'h' : 'v';
		const before = zone === 'left' || zone === 'top';
		return {
			type: 'split',
			dir,
			sizes: [1, 1],
			children: before ? [newLeaf, node] : [node, newLeaf],
		};
	}
	let changed = false;
	const children = node.children.map(child => {
		const next = insertSplitLeaf(child, targetViewId, newLeaf, zone);
		if (next) { changed = true; return next; }
		return child;
	});
	return changed ? { ...node, children } : undefined;
}

/**
 * 把 `leafViewId` 这一栏**拖到** `targetViewId` 那一栏的某个方向旁边。
 *
 * ⚠ 语义与社区一致：先把被拖的叶子**摘掉**，再在目标旁边插入 ⇒ 树结构按"落点"重排 ✓。
 * ⚠ 目标必须是一个**叶子**（拖到"某栏旁边"而不是"某块区域"）⇒ 找不到目标就返回 undefined（保持原树）✓。
 */
export function moveSplitLeaf(tree: DshSplitNode, leafViewId: string, targetViewId: string, zone: DshDropZone): DshSplitNode | undefined {
	if (leafViewId === targetViewId) { return undefined; }
	const without = removeSplitLeaf(tree, leafViewId);
	if (!without) { return undefined; }
	return insertSplitLeaf(without, targetViewId, { type: 'leaf', viewId: leafViewId }, zone);
}

/**
 * 按目标视图的四个方向判定落点（几何）。
 *
 * ⚠ 判据：指针相对目标矩形**中心**偏哪边 ⇒ 哪边（社区是"边缘带"，这里用中线，命中面积更大、更好用）✓。
 * @param edge 保留参数：将来要"只在边缘带内才算落点"时用（当前实现只要指针在目标矩形内就按中线判方向）。
 */
export function pickDropZone(target: IDshSplitRect, pointerX: number, pointerY: number, edge = 48): DshDropZone | undefined {
	if (pointerX < target.x || pointerX > target.x + target.width
		|| pointerY < target.y || pointerY > target.y + target.height) {
		return undefined;   // 不在目标矩形内 ⇒ 没有落点
	}
	// ★ 复刻 split-workspace 的 `zoneFor`（client.js:8197-8212）：边缘带 `edge = max(48, min(w,h)*0.28)`
	//   （中线法在窄栏里边缘带会溢出到邻居 ⇒ 这个公式每栏独立、可预期 ✓）；角落先到先得、对边互斥。
	//   中心（不在任何边缘带）⇒ 与社区一致：内部拖放退化为"插到目标右侧" ✓。
	const e = edge > 0 ? edge : Math.max(48, Math.min(target.width, target.height) * 0.28);
	const dx = pointerX - target.x;
	const dy = pointerY - target.y;
	const atLeft = dx < e;
	const atRight = dx > target.width - e;
	const atTop = dy < e;
	const atBottom = dy > target.height - e;
	if (atLeft && !atRight) { return 'left'; }
	if (atRight && !atLeft) { return 'right'; }
	if (atTop && !atBottom) { return 'top'; }
	if (atBottom && !atTop) { return 'bottom'; }
	return 'right';
}

/**
 * **自动分格**（复刻 split-workspace 的 `autoLayoutMode` + `settleAuto`，client.js:2307-2345/2488）：
 * 按现有叶子的**顺序**重建一棵等分树。
 *
 * · 1 栏 = 叶；2 栏：`aspect ≥ 1.05`（宽 ≥ 高×1.05）⇒ 左右，否则上下；
 * · 3 栏 = **L 形**（根 v[0.5,0.5]，上孩子 = h(a,b)，下 = c）；
 * · 4 栏 = 2×2；≥5 栏：`cols = max(2, ceil(√n))`、`rows = ceil(n/cols)`，行优先（末行可能单叶）。
 *
 * ⚠ 触发纪律（社区踩坑注释 client.js:2509-2514）：**只在加栏/关栏后调用**；
 *   手动移动（moveSplitLeaf）之后**绝不**重排 —— 用户指了方向就保留手工布局 ✓。
 */
export function buildArrangedTree(leafIds: readonly string[], aspect = 1.2): DshSplitNode {
	const leaf = (id: string): DshSplitNode => ({ type: 'leaf', viewId: id });
	const n = leafIds.length;
	if (n === 0) { throw new Error('buildArrangedTree: 空叶子列表'); }
	if (n === 1) { return leaf(leafIds[0]); }
	if (n === 2) {
		const kids: DshSplitNode[] = [leaf(leafIds[0]), leaf(leafIds[1])];
		return aspect >= 1.05
			? { type: 'split', dir: 'h', sizes: [1, 1], children: kids }
			: { type: 'split', dir: 'v', sizes: [1, 1], children: kids };
	}
	if (n === 3) {
		// L 形：上二下一（社区 client.js:2320-2328 同款）
		return {
			type: 'split', dir: 'v', sizes: [1, 1],
			children: [
				{ type: 'split', dir: 'h', sizes: [1, 1], children: [leaf(leafIds[0]), leaf(leafIds[1])] },
				leaf(leafIds[2]),
			],
		};
	}
	const cols = n === 4 ? 2 : Math.max(2, Math.ceil(Math.sqrt(n)));
	const rows = Math.ceil(n / cols);
	const rowNodes: DshSplitNode[] = [];
	for (let r = 0; r < rows; r++) {
		const row = leafIds.slice(r * cols, (r + 1) * cols);
		rowNodes.push(row.length === 1
			? leaf(row[0])
			: { type: 'split', dir: 'h', sizes: row.map(() => 1), children: row.map(leaf) });
	}
	return { type: 'split', dir: 'v', sizes: rowNodes.map(() => 1), children: rowNodes };
} 
