/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **分屏布局树**（拖拽堆叠的几何内核）的单测（2026-10-29）。
 *
 * 为什么必须单测：拖拽重排是**纯函数**（树进树出）⇒ 一旦算错，界面就是"栏重叠/消失/错位"，
 *   而且很难靠肉眼归因（渲染侧还有原生视图摆位）⇒ 把几何与重排全部钉在这里 ✓。
 */
import assert from 'assert';
import {
	buildArrangedTree,
	canSplitRect,
	checkPaneBounds,
	computeMainColumnWidth,
	computePaneGeometry,
	computeSplitLayout,
	dockSplitLeaf,
	dropHintRect,
	equalizeSplitNodeAt,
	holeViewRect,
	insertSplitLeafBeside,
	pickDropTarget,
	pickSplitTarget,
	ratioForMainWidth,
	resizeSplitDivider,
	swapSplitLeaves,
	findSplitLeaf,
	moveSplitLeaf,
	pickDropZone,
	removeSplitLeaf,
	splitLeafCount,
	splitLeaves,
	type DshSplitNode,
} from '../../common/dshSplitLayout.js';

const R = { x: 0, y: 0, width: 1000, height: 600 };
const leaf = (viewId: string): DshSplitNode => ({ type: 'leaf', viewId });
const split = (dir: 'h' | 'v', sizes: number[], children: DshSplitNode[]): DshSplitNode => ({ type: 'split', dir, sizes, children });

suite('dshHarness / 分屏布局树（拖拽堆叠的几何内核）', () => {

	test('两栏：各占一半，中间一条分隔线', () => {
		const tree = split('h', [1, 1], [leaf('a'), leaf('b')]);
		const { rects, dividers } = computeSplitLayout(tree, R);
		assert.strictEqual(rects.get('a')!.width, 500);
		assert.strictEqual(rects.get('b')!.x, 500);
		assert.strictEqual(rects.get('b')!.width, 500);
		assert.strictEqual(dividers.length, 1);
		assert.strictEqual(dividers[0].dir, 'h');
		assert.strictEqual(dividers[0].pos, 500);
	});

	test('权重：3:1 ⇒ 按比例分配', () => {
		const tree = split('h', [3, 1], [leaf('a'), leaf('b')]);
		const { rects } = computeSplitLayout(tree, R);
		assert.strictEqual(rects.get('a')!.width, 750);
		assert.strictEqual(rects.get('b')!.width, 250);
	});

	test('嵌套：左栏上下两格 + 右栏一格（混合 h/v）', () => {
		const tree = split('h', [1, 1], [
			split('v', [1, 1], [leaf('a'), leaf('b')]),
			leaf('c'),
		]);
		const { rects, dividers } = computeSplitLayout(tree, R);
		assert.strictEqual(rects.get('a')!.width, 500);
		assert.strictEqual(rects.get('a')!.height, 300);
		assert.strictEqual(rects.get('b')!.y, 300);
		assert.strictEqual(rects.get('c')!.x, 500);
		assert.strictEqual(rects.get('c')!.width, 500);
		// 两条分隔线：一条竖直（左右之间）、一条水平（左栏内部上下之间）✓
		assert.strictEqual(dividers.length, 2);
		assert.ok(dividers.some(d => d.dir === 'h' && d.pos === 500));
		assert.ok(dividers.some(d => d.dir === 'v' && d.pos === 300));
	});

	test('叶子计数与顺序', () => {
		const tree = split('h', [1, 1], [leaf('a'), split('v', [1, 1], [leaf('b'), leaf('c')])]);
		assert.strictEqual(splitLeafCount(tree), 3);
		assert.deepStrictEqual(splitLeaves(tree), ['a', 'b', 'c']);
		assert.ok(findSplitLeaf(tree, 'b'));
		assert.strictEqual(findSplitLeaf(tree, 'zz'), undefined);
	});

	test('拖拽：把 a 拖到 b 右边 ⇒ 变成 [b, a]', () => {
		const tree = split('h', [1, 1], [leaf('a'), leaf('b')]);
		const moved = moveSplitLeaf(tree, 'a', 'b', 'right')!;
		assert.ok(moved, '必须能移动 ✗');
		assert.deepStrictEqual(splitLeaves(moved), ['b', 'a']);
		const { rects } = computeSplitLayout(moved, R);
		assert.strictEqual(rects.get('b')!.x, 0);
		assert.strictEqual(rects.get('a')!.x, 500);
	});

	test('拖拽：拖到左边 ⇒ [a, b]；拖到上下 ⇒ 变成纵向分栏', () => {
		const tree = split('h', [1, 1], [leaf('a'), leaf('b')]);
		const left = moveSplitLeaf(tree, 'b', 'a', 'left')!;
		assert.deepStrictEqual(splitLeaves(left), ['b', 'a']);
		const top = moveSplitLeaf(tree, 'a', 'b', 'top')!;
		assert.deepStrictEqual(splitLeaves(top), ['a', 'b']);
		const { rects } = computeSplitLayout(top, R);
		assert.strictEqual(rects.get('a')!.height, 300, '纵向分栏 ⇒ 上下各半 ✗');
		assert.strictEqual(rects.get('b')!.y, 300);
	});

	test('拖拽无效的情况：拖到自己 / 拖到不存在的栏 ⇒ 返回 undefined（保持原树）', () => {
		const tree = split('h', [1, 1], [leaf('a'), leaf('b')]);
		assert.strictEqual(moveSplitLeaf(tree, 'a', 'a', 'left'), undefined);
		assert.strictEqual(moveSplitLeaf(tree, 'a', 'zz', 'left'), undefined);
	});

	test('摘除：两栏摘掉一栏 ⇒ 塌缩成单栏', () => {
		const tree = split('h', [1, 1], [leaf('a'), leaf('b')]);
		const left = removeSplitLeaf(tree, 'b')!;
		assert.strictEqual(left.type, 'leaf');
		assert.strictEqual(left.viewId, 'a');
	});

	test('落点判定：指针在目标中心四周 ⇒ 四向', () => {
		const target = { x: 100, y: 100, width: 200, height: 200 };
		assert.strictEqual(pickDropZone(target, 120, 200), 'left');
		assert.strictEqual(pickDropZone(target, 280, 200), 'right');
		assert.strictEqual(pickDropZone(target, 200, 120), 'top');
		assert.strictEqual(pickDropZone(target, 200, 280), 'bottom');
		// 指针不在目标矩形内 ⇒ 没有落点 ✓
		assert.strictEqual(pickDropZone(target, 50, 50), undefined);
	});

	test('★ 主栏宽度：三档比例必须可区分（旧实现 1280 宽时 1/3 与 1/2 都被夹成 720 ✗）', () => {
		const a = computeMainColumnWidth(1280, 1 / 3, true);
		const b = computeMainColumnWidth(1280, 1 / 2, true);
		const c = computeMainColumnWidth(1280, 2 / 3, true);
		assert.ok(a < b && b < c, `必须单调且互不相同（${a} / ${b} / ${c}）`);
		assert.ok(a >= 720, '下限 720（dsh 三栏布局太窄会黑屏）');
		assert.ok(1280 - c >= 320, '右侧内容区至少 320');
	});

	test('主栏宽度：没有右栏 ⇒ 铺满；窗口太窄 ⇒ 下限退到 75%，不把右栏挤没', () => {
		assert.strictEqual(computeMainColumnWidth(1280, 0.5, false), 1280);
		const narrow = computeMainColumnWidth(800, 0.5, true);
		assert.ok(narrow <= 600, `窄窗口主栏不能吃掉全部（${narrow}）`);
	});

	test('★ bounds 判定：抓得住"重叠 / 跑出窗口 / 塌成窄条"三类真机坏布局', () => {
		const area = { x: 0, y: 29, width: 1280, height: 782 };
		const ok = checkPaneBounds([
			{ viewId: 'main', x: 0, y: 29, width: 720, height: 782 },
			{ viewId: 'r1', x: 728, y: 39, width: 552, height: 772 },
		], area);
		assert.deepStrictEqual(ok, []);
		// 主栏被当成内容叶子搬到右边那次：两个视图摞在一起
		const overlap = checkPaneBounds([
			{ viewId: 'main', x: 0, y: 29, width: 720, height: 782 },
			{ viewId: 'r1', x: 600, y: 29, width: 680, height: 782 },
		], area);
		assert.ok(overlap.some(p => p.includes('重叠')));
		const out = checkPaneBounds([{ viewId: 'r1', x: 1200, y: 29, width: 552, height: 782 }], area);
		assert.ok(out.some(p => p.includes('跑出窗口')));
		const tiny = checkPaneBounds([{ viewId: 'main', x: 0, y: 29, width: 50, height: 782 }], area);
		assert.ok(tiny.some(p => p.includes('太小')));
	});

	test('自动分格：2=左右 / 3=L 形 / 4=2×2', () => {
		assert.strictEqual(buildArrangedTree(['a', 'b']).type, 'split');
		const three = buildArrangedTree(['a', 'b', 'c']);
		assert.deepStrictEqual(splitLeaves(three), ['a', 'b', 'c']);
		assert.ok(three.type === 'split' && three.dir === 'v', '3 栏 = 上二下一');
		const four = buildArrangedTree(['a', 'b', 'c', 'd']);
		assert.ok(four.type === 'split' && four.children.length === 2, '4 栏 = 两行');
	});

	test('★ 切开一格：同向并为兄弟、只平分目标那一格（其余格子不动）', () => {
		const tree = split('h', [1, 1], [leaf('a'), leaf('b')]);
		const next = insertSplitLeafBeside(tree, 'b', 'c', 'right')!;
		assert.ok(next.type === 'split' && next.dir === 'h' && next.children.length === 3, '同向必须并为兄弟，不许再包一层 ✗');
		const { rects } = computeSplitLayout(next, R);
		assert.strictEqual(rects.get('a')!.width, 500, 'a 不许被动 ✗');
		assert.strictEqual(rects.get('b')!.width, 250);
		assert.strictEqual(rects.get('c')!.width, 250);
		const down = insertSplitLeafBeside(tree, 'a', 'c', 'bottom')!;
		assert.deepStrictEqual(splitLeaves(down), ['a', 'c', 'b']);
		assert.strictEqual(computeSplitLayout(down, R).rects.get('c')!.y, 300);
	});

	test('交换 / 停靠整列', () => {
		const tree = split('h', [1, 1], [leaf('a'), split('v', [1, 1], [leaf('b'), leaf('c')])]);
		assert.deepStrictEqual(splitLeaves(swapSplitLeaves(tree, 'a', 'c')), ['c', 'b', 'a']);
		const docked = dockSplitLeaf(tree, 'c', 'left')!;
		assert.deepStrictEqual(splitLeaves(docked), ['c', 'a', 'b']);
		const r = computeSplitLayout(docked, R).rects.get('c')!;
		assert.strictEqual(r.height, 600, '整列 = 全高 ✗');
		assert.ok(r.width < 500, '停靠出来的那一格不该一下子占半边 ✗');
		assert.strictEqual(dockSplitLeaf(leaf('a'), 'a', 'left'), undefined, '只有一格 ⇒ 不可停靠');
	});

	test('★ 拖分隔条：只改相邻两格、夹取最小宽、双击均分', () => {
		const tree = split('h', [1, 1, 1], [leaf('a'), leaf('b'), leaf('c')]);
		const { dividers } = computeSplitLayout(tree, R);
		const d0 = dividers[0];
		const moved = resizeSplitDivider(tree, d0.path, d0.index, 200, d0.node, 100)!;
		const rects = computeSplitLayout(moved, R).rects;
		assert.ok(Math.abs(rects.get('a')!.width - 200) < 1);
		assert.ok(Math.abs(rects.get('c')!.width - 1000 / 3) < 1, '第三格不许被动 ✗');
		const clamped = computeSplitLayout(resizeSplitDivider(tree, d0.path, d0.index, -5000, d0.node, 200)!, R).rects;
		assert.ok(clamped.get('a')!.width >= 199, '拖到头也不能小于最小宽 ✗');
		const eq = computeSplitLayout(equalizeSplitNodeAt(moved, d0.path)!, R).rects;
		assert.ok(Math.abs(eq.get('a')!.width - 1000 / 3) < 1);
	});

	test('★ 新窗格切哪一格：最大的那格；放不下就换方向；都放不下 ⇒ 拒绝', () => {
		const rects = new Map([['a', { x: 0, y: 0, width: 500, height: 800 }], ['b', { x: 500, y: 0, width: 300, height: 400 }]]);
		assert.deepStrictEqual(pickSplitTarget(rects), { viewId: 'a', zone: 'bottom' }, '高 ⇒ 上下切');
		const wide = new Map([['a', { x: 0, y: 0, width: 900, height: 300 }]]);
		assert.deepStrictEqual(pickSplitTarget(wide), { viewId: 'a', zone: 'right' });
		const tiny = new Map([['a', { x: 0, y: 0, width: 300, height: 250 }]]);
		assert.strictEqual(pickSplitTarget(tiny), undefined, '切出来每半都不够用 ⇒ 必须拒绝 ✗');
		assert.ok(!canSplitRect({ x: 0, y: 0, width: 390, height: 900 }, 'right'));
	});

	test('落点：边缘 = 那一侧、中央 = 交换；提示框 = 半格 / 整格', () => {
		const t = { x: 0, y: 0, width: 400, height: 400 };
		assert.strictEqual(pickDropTarget(t, 10, 200), 'left');
		assert.strictEqual(pickDropTarget(t, 200, 390), 'bottom');
		assert.strictEqual(pickDropTarget(t, 200, 200), 'center');
		assert.strictEqual(pickDropTarget(t, 500, 200), undefined);
		assert.deepStrictEqual(dropHintRect(t, 'right'), { x: 200, y: 0, width: 200, height: 400 });
		assert.deepStrictEqual(dropHintRect(t, 'center'), t);
	});

	test('★ 格子几何：缝隙只扣内侧、分隔条正好落在缝里、标题栏在顶部', () => {
		const content = { x: 100, y: 30, width: 600, height: 600 };
		const tree = split('h', [1, 1], [leaf('a'), split('v', [1, 1], [leaf('b'), leaf('c')])]);
		const { panes, dividers } = computePaneGeometry(tree, content, 6, 32);
		const a = panes.get('a')!;
		const b = panes.get('b')!;
		const c = panes.get('c')!;
		assert.strictEqual(a.box.width, 294, '左格扣右缝 ✗');
		assert.strictEqual(a.box.height, 600, '贴底的不扣下缝 ✗');
		assert.strictEqual(b.box.height, 294, '上格扣下缝 ✗');
		assert.strictEqual(c.box.width, 300, '贴右的不扣右缝 ✗');
		assert.strictEqual(a.view.y, 62, '原生视图在标题栏下面 ✗');
		const h = dividers.find(d => d.dir === 'h')!;
		assert.deepStrictEqual(h.bar, { x: 394, y: 30, width: 6, height: 600 });
		const v = dividers.find(d => d.dir === 'v')!;
		assert.deepStrictEqual(v.bar, { x: 400, y: 324, width: 300, height: 6 }, '上下分隔条只跨它那个节点的宽度 ✗');
		const views = [...panes.entries()].map(([viewId, p]) => ({ viewId, ...p.view }));
		assert.deepStrictEqual(checkPaneBounds(views, content, 100), [], '原生视图之间不许重叠 ✗');
	});

	test('挖洞：目标格的原生视图让出落点那一半，中央 = 整格让出', () => {
		const g = { box: { x: 0, y: 0, width: 400, height: 400 }, head: { x: 0, y: 0, width: 400, height: 32 }, view: { x: 0, y: 32, width: 400, height: 368 } };
		assert.deepStrictEqual(holeViewRect(g, 'left'), { x: 200, y: 32, width: 200, height: 368 });
		assert.deepStrictEqual(holeViewRect(g, 'top'), { x: 0, y: 200, width: 400, height: 200 });
		assert.deepStrictEqual(holeViewRect(g, 'bottom'), { x: 0, y: 32, width: 400, height: 168 });
		assert.strictEqual(holeViewRect(g, 'center'), undefined);
	});

	test('主栏宽 ⇄ 比例 互为反函数', () => {
		for (const ratio of [1 / 3, 0.5, 2 / 3]) {
			const w = computeMainColumnWidth(1280, ratio, true);
			assert.ok(Math.abs(ratioForMainWidth(1280, w) - ratio) < 0.01);
		}
		assert.ok(Math.abs(ratioForMainWidth(1280, 0) - 1 / 3) < 1e-9, '拖到最左 = 下限 ✗');
	});
});
 
