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
	computeSplitLayout,
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
});
 
