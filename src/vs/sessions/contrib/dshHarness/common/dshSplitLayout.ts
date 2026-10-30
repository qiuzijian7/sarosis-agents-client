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
	/** 该 split 节点自身的矩形（分隔条的长度 = 它在正交方向上的跨度；拖动换算比例也要用）。 */
	readonly node: IDshSplitRect;
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
					node: r,
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
	const keptSizes: number[] = [];
	let changed = false;
	node.children.forEach((child, i) => {
		const next = removeSplitLeaf(child, viewId);
		if (next !== child) { changed = true; }
		if (next) { kept.push(next); keptSizes.push(node.sizes[i] ?? 1); }
	});
	// ⚠ 2026-10-30 单测抓到：旧实现按"子节点个数没变"判没摘到 ⇒ 嵌套子树塌缩（个数不变）时
	//   原样返回 ⇒ **嵌套格子里的那一格关不掉** ✗ ⇒ 改按引用判 ✓。
	if (!changed) { return node; }
	if (kept.length === 0) { return undefined; }
	if (kept.length === 1) { return kept[0]; }                     // 塌缩（只剩一个 ⇒ 不需要 split）
	// 相邻格补位：保留其余格子的比例（不自动均分 ⇒ 用户拖出来的比例不丢）✓
	return { ...node, children: kept, sizes: keptSizes };
}

/**
 * 在目标叶子的某个方向旁边插入一个新叶子（与效果图 `insertBeside` 同款）。
 *
 * ⚠ **同向合并**：目标所在的 split 与插入方向相同（例如左右排里再往右插）⇒ 新叶并为**兄弟**、
 *   **平分目标那一格**（其余格子不动）；不同向才包一层新 split ⇒ "切开一格"不会打乱别的格子 ✓。
 */
function insertSplitLeaf(node: DshSplitNode, targetViewId: string, newLeaf: DshSplitNode, zone: DshDropZone): DshSplitNode | undefined {
	const dir: 'h' | 'v' = zone === 'left' || zone === 'right' ? 'h' : 'v';
	const before = zone === 'left' || zone === 'top';
	if (node.type === 'leaf') {
		if (node.viewId !== targetViewId) { return undefined; }
		return {
			type: 'split',
			dir,
			sizes: [1, 1],
			children: before ? [newLeaf, node] : [node, newLeaf],
		};
	}
	for (let i = 0; i < node.children.length; i++) {
		const child = node.children[i];
		if (child.type === 'leaf' && child.viewId === targetViewId && node.dir === dir) {
			const children = [...node.children];
			const sizes = [...node.sizes];
			const half = (sizes[i] ?? 1) / 2;
			sizes[i] = half;
			const at = before ? i : i + 1;
			children.splice(at, 0, newLeaf);
			sizes.splice(at, 0, half);
			return { ...node, children, sizes };
		}
		const next = insertSplitLeaf(child, targetViewId, newLeaf, zone);
		if (next) {
			const children = [...node.children];
			children[i] = next;
			return { ...node, children };
		}
	}
	return undefined;
}

/** 在目标叶子旁边插入一个**新**叶子（新开一格；目标不存在 ⇒ undefined）。 */
export function insertSplitLeafBeside(tree: DshSplitNode, targetViewId: string, newViewId: string, zone: DshDropZone): DshSplitNode | undefined {
	return insertSplitLeaf(tree, targetViewId, { type: 'leaf', viewId: newViewId }, zone);
}

/** 交换两个叶子的位置（树形与比例都不变）。 */
export function swapSplitLeaves(node: DshSplitNode, a: string, b: string): DshSplitNode {
	if (node.type === 'leaf') {
		return node.viewId === a ? { type: 'leaf', viewId: b } : node.viewId === b ? { type: 'leaf', viewId: a } : node;
	}
	return { ...node, children: node.children.map(c => swapSplitLeaves(c, a, b)) };
}

/**
 * 把某一格停靠到**整列/整行**（菜单「移到最左（整列）」等）：摘掉它，再与其余部分组成新的根。
 * ⚠ 宽度按"1 : 其余格数"分（停靠出来的那一格不会一下子占半边）✓。
 */
export function dockSplitLeaf(tree: DshSplitNode, viewId: string, edge: DshDropZone): DshSplitNode | undefined {
	const rest = removeSplitLeaf(tree, viewId);
	if (!rest || rest === tree) { return undefined; }
	const n = splitLeaves(rest).length;
	const me: DshSplitNode = { type: 'leaf', viewId };
	const first = edge === 'left' || edge === 'top';
	return {
		type: 'split',
		dir: edge === 'left' || edge === 'right' ? 'h' : 'v',
		sizes: first ? [1, n] : [n, 1],
		children: first ? [me, rest] : [rest, me],
	};
}

/** 取树里某条路径上的节点（路径无效 ⇒ undefined）。 */
export function splitNodeAt(tree: DshSplitNode, path: readonly number[]): DshSplitNode | undefined {
	let cur: DshSplitNode | undefined = tree;
	for (const i of path) {
		cur = cur && cur.type === 'split' ? cur.children[i] : undefined;
	}
	return cur;
}

function replaceSplitNodeAt(tree: DshSplitNode, path: readonly number[], next: DshSplitNode): DshSplitNode {
	if (path.length === 0) { return next; }
	if (tree.type !== 'split') { return tree; }
	const [head, ...tail] = path;
	const children = [...tree.children];
	children[head] = replaceSplitNodeAt(children[head], tail, next);
	return { ...tree, children };
}

/**
 * **拖分隔条**：按指针位置改那个 split 节点里**相邻两格**的比例（与效果图 / 社区同款夹取）。
 *
 * · 只改 `index` 与 `index+1` 两格（其余格子不动）；
 * · 最小占比 `minF = max(0.04, minPx / 节点长度)`（且不超过两格合计的一半）⇒ 拖到头也不会把某格拖没 ✓。
 * @param pointer  指针沿分隔方向的坐标（与 `nodeRect` 同一坐标系）
 * @param nodeRect 该 split 节点的矩形（`IDshSplitDivider.node`）
 */
export function resizeSplitDivider(tree: DshSplitNode, path: readonly number[], index: number, pointer: number, nodeRect: IDshSplitRect, minPx = 200): DshSplitNode | undefined {
	const node = splitNodeAt(tree, path);
	if (!node || node.type !== 'split' || index < 0 || index >= node.children.length - 1) { return undefined; }
	const len = node.dir === 'h' ? nodeRect.width : nodeRect.height;
	const start = node.dir === 'h' ? nodeRect.x : nodeRect.y;
	if (len <= 0) { return undefined; }
	const total = node.sizes.reduce((a, b) => a + b, 0) || node.children.length;
	const f = node.children.map((_, i) => (node.sizes[i] ?? 1) / total);
	const offA = f.slice(0, index).reduce((a, b) => a + b, 0);
	const pair = f[index] + f[index + 1];
	const minF = Math.min(pair / 2, Math.max(0.04, minPx / len));
	const a = Math.min(pair - minF, Math.max(minF, (pointer - start) / len - offA));
	const sizes = [...f];
	sizes[index] = a;
	sizes[index + 1] = pair - a;
	return replaceSplitNodeAt(tree, path, { ...node, sizes });
}

/** 把某个 split 节点的直接子格均分（双击分隔条）。 */
export function equalizeSplitNodeAt(tree: DshSplitNode, path: readonly number[]): DshSplitNode | undefined {
	const node = splitNodeAt(tree, path);
	if (!node || node.type !== 'split') { return undefined; }
	return replaceSplitNodeAt(tree, path, { ...node, sizes: node.children.map(() => 1) });
}

/** 这一格沿某方向切成两半后，每半是否还够用（不够 ⇒ 拒绝并说明，不切出窄条）。 */
export function canSplitRect(rect: IDshSplitRect, zone: DshDropZone, minWidth = 200, minHeight = 160): boolean {
	return zone === 'left' || zone === 'right' ? rect.width / 2 >= minWidth : rect.height / 2 >= minHeight;
}

/**
 * 「新窗格」切哪一格（与效果图同款）：**最大**的那一格；宽就左右切、高就上下切；
 * 首选方向放不下就换另一个方向；两个方向都放不下 ⇒ undefined（调用方明确告诉用户）✓。
 */
export function pickSplitTarget(rects: ReadonlyMap<string, IDshSplitRect>, minWidth = 200, minHeight = 160): { viewId: string; zone: DshDropZone } | undefined {
	let best: string | undefined;
	let area = -1;
	for (const [id, r] of rects) {
		if (r.width * r.height > area) { area = r.width * r.height; best = id; }
	}
	if (!best) { return undefined; }
	const r = rects.get(best)!;
	const pref: DshDropZone = r.width >= r.height * 1.1 ? 'right' : 'bottom';
	const alt: DshDropZone = pref === 'right' ? 'bottom' : 'right';
	if (canSplitRect(r, pref, minWidth, minHeight)) { return { viewId: best, zone: pref }; }
	if (canSplitRect(r, alt, minWidth, minHeight)) { return { viewId: best, zone: alt }; }
	return undefined;
}

/** 拖拽落点（含中央 = 交换）。 */
export type DshDropTarget = DshDropZone | 'center';

/**
 * 与效果图同款的落点判定：边缘带 `max(48, min(w,h)*0.28)` 内 ⇒ 那一侧；**中央 ⇒ 交换**；
 * 不在矩形内 ⇒ undefined。
 */
export function pickDropTarget(target: IDshSplitRect, pointerX: number, pointerY: number): DshDropTarget | undefined {
	if (pointerX < target.x || pointerX > target.x + target.width
		|| pointerY < target.y || pointerY > target.y + target.height) {
		return undefined;
	}
	const e = Math.max(48, Math.min(target.width, target.height) * 0.28);
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
	return 'center';
}

/** 落点提示框的矩形（边缘 = 半格；中央 = 整格）。 */
export function dropHintRect(r: IDshSplitRect, zone: DshDropTarget): IDshSplitRect {
	switch (zone) {
		case 'left': return { x: r.x, y: r.y, width: r.width / 2, height: r.height };
		case 'right': return { x: r.x + r.width / 2, y: r.y, width: r.width / 2, height: r.height };
		case 'top': return { x: r.x, y: r.y, width: r.width, height: r.height / 2 };
		case 'bottom': return { x: r.x, y: r.y + r.height / 2, width: r.width, height: r.height / 2 };
		default: return r;
	}
}

/** 一格的几何：外框（含标题栏）、标题栏、原生视图区。 */
export interface IDshPaneBox {
	readonly box: IDshSplitRect;
	readonly head: IDshSplitRect;
	readonly view: IDshSplitRect;
}

/** 一条分隔条的几何（落在两格之间的缝里 ⇒ DOM 才看得见、点得到）。 */
export interface IDshDividerBar extends IDshSplitDivider {
	readonly bar: IDshSplitRect;
}

/**
 * 把树铺进右侧内容区：每格扣掉右/下缝隙（贴内容区边缘的那一侧不扣），顶部留标题栏；
 * 分隔条正好落在缝里（原生视图盖在 DOM 之上 ⇒ DOM 只有落在缝里/标题栏里才可见可点）✓。
 */
export function computePaneGeometry(tree: DshSplitNode, content: IDshSplitRect, gap: number, headH: number): { panes: Map<string, IDshPaneBox>; dividers: IDshDividerBar[] } {
	const { rects, dividers } = computeSplitLayout(tree, content);
	const panes = new Map<string, IDshPaneBox>();
	const right = content.x + content.width;
	const bottom = content.y + content.height;
	for (const [id, r] of rects) {
		const w = Math.max(1, r.width - (r.x + r.width < right - 1 ? gap : 0));
		const h = Math.max(1, r.height - (r.y + r.height < bottom - 1 ? gap : 0));
		const box = { x: r.x, y: r.y, width: w, height: h };
		const head = { x: r.x, y: r.y, width: w, height: Math.min(headH, h) };
		const view = { x: r.x, y: r.y + head.height, width: w, height: Math.max(1, h - head.height) };
		panes.set(id, { box, head, view });
	}
	const bars = dividers.map(d => ({
		...d,
		bar: d.dir === 'h'
			? { x: d.pos - gap, y: d.node.y, width: gap, height: d.node.height }
			: { x: d.node.x, y: d.pos - gap, width: d.node.width, height: gap },
	}));
	return { panes, dividers: bars };
}

/**
 * **挖洞**：拖动时目标格的原生视图让出落点那一半（落点提示是 DOM，被原生视图盖着就看不见）。
 * 返回视图该缩到的矩形；`center`（交换）⇒ undefined = 整格让出（视图暂时隐藏）。
 */
export function holeViewRect(g: IDshPaneBox, zone: DshDropTarget): IDshSplitRect | undefined {
	const v = g.view;
	const mid = g.box.y + g.box.height / 2;
	switch (zone) {
		case 'left': return { x: v.x + v.width / 2, y: v.y, width: v.width / 2, height: v.height };
		case 'right': return { x: v.x, y: v.y, width: v.width / 2, height: v.height };
		case 'top': return { x: v.x, y: Math.max(v.y, mid), width: v.width, height: Math.max(1, v.y + v.height - Math.max(v.y, mid)) };
		case 'bottom': return { x: v.x, y: v.y, width: v.width, height: Math.max(1, mid - v.y) };
		default: return undefined;
	}
}

/**
 * 主栏宽度 ⇒ 比例（拖主栏分隔条用；`computeMainColumnWidth` 的反函数）。
 * 结果落在 [1/3, 2/3]（与菜单三档同一刻度）✓。
 */
export function ratioForMainWidth(areaWidth: number, mainWidth: number, minMain = 720, minPane = 320): number {
	const w = Math.max(1, Math.round(areaWidth));
	const lo = Math.min(minMain, Math.round(w * 0.75));
	const hi = Math.max(lo, w - minPane);
	if (hi <= lo) { return 0.5; }
	const t = Math.min(1, Math.max(0, (mainWidth - lo) / (hi - lo)));
	return 1 / 3 + t / 3;
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

/**
 * **主栏（全高左列）宽度**（两段式布局；2026-10-30 抽成纯函数 ⇒ 可单测）。
 *
 * 约束：主栏是带官方三栏布局的完整客户端 ⇒ 至少 `minMain`（太窄会侧栏折叠 + 中栏黑屏）；
 *   右侧内容区至少 `minPane`。可用区间 `[lo, hi]`：`lo = min(minMain, 0.75w)`，`hi = max(lo, w - minPane)`。
 *
 * ⚠ 比例不再"直接乘宽度"（旧实现 `ratio × w` 被下限夹住 ⇒ 1280 宽时 1/3 与 1/2 **都是 720**，
 *   菜单两项效果一样 ✗）⇒ 改为把 `ratio` 映射到**可用区间**里：1/3 ⇒ lo、1/2 ⇒ 中点、2/3 ⇒ hi
 *   ⇒ 三档永远可区分（只要区间宽度 > 0）✓。区间外的历史值（如拖出来的 0.42）按线性夹取。
 */
export function computeMainColumnWidth(areaWidth: number, ratio: number, hasContent: boolean, minMain = 720, minPane = 320): number {
	const w = Math.max(1, Math.round(areaWidth));
	if (!hasContent) { return w; }
	const lo = Math.min(minMain, Math.round(w * 0.75));
	const hi = Math.max(lo, w - minPane);
	const t = Math.min(1, Math.max(0, (ratio - 1 / 3) / (2 / 3 - 1 / 3)));
	return Math.round(lo + (hi - lo) * t);
}

/** 一个视图在窗口里的实际矩形（来自主进程 `getBounds()`）。 */
export interface IDshPaneBounds {
	readonly viewId: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * **原生 bounds 健全性判定**（自测 / 守卫共用；纯函数）：返回问题列表，空 = 健康。
 *
 * 判的正是真机出过的三类坏布局：① 视图**互相重叠**（主栏被当成内容叶子搬到右边那次）；
 * ② 视图**跑出窗口**；③ 视图**宽/高塌成很小**（被挤成黑条）。
 */
export function checkPaneBounds(panes: readonly IDshPaneBounds[], area: IDshSplitRect, minSize = 120): string[] {
	const problems: string[] = [];
	const tol = 2;
	for (const p of panes) {
		if (p.width < minSize || p.height < minSize) {
			problems.push(`${p.viewId} 太小（${Math.round(p.width)}x${Math.round(p.height)}）`);
		}
		if (p.x < area.x - tol || p.y < area.y - tol
			|| p.x + p.width > area.x + area.width + tol || p.y + p.height > area.y + area.height + tol) {
			problems.push(`${p.viewId} 跑出窗口（x${Math.round(p.x)} y${Math.round(p.y)} w${Math.round(p.width)} h${Math.round(p.height)}）`);
		}
	}
	for (let i = 0; i < panes.length; i++) {
		for (let j = i + 1; j < panes.length; j++) {
			const a = panes[i];
			const b = panes[j];
			const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
			const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
			if (ox > tol && oy > tol) {
				problems.push(`${a.viewId} 与 ${b.viewId} 重叠（${Math.round(ox)}x${Math.round(oy)}）`);
			}
		}
	}
	return problems;
} 
