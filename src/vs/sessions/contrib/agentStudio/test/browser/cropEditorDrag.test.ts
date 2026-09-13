/*---------------------------------------------------------------------------------------------
 *  Unit tests for cropEditor — 交互式裁剪的纯逻辑（命中测试 / 拖拽 / 边界 clamp）。
 *
 *  ★ 回归守卫（2026-09-11）：`dragCrop('move')` 曾只把位置 clamp 到 [0,1]，再用
 *    `Math.min(start.w, 1 - newX)` 反推宽高 → 拖到右/下边缘时框被「挤扁」（尺寸缩小）
 *    而不是停住，松手后实际裁剪区域与用户看到的不一致。
 *    现为「位置 clamp 到 [0, 1-w] / [0, 1-h]，尺寸恒定」（对齐 MiniImageEditor 的框内拖动）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	dragCrop,
	dragNewCrop,
	hitTestCrop,
	normToPx,
	pxToNorm,
	type CropRectNorm,
} from '../../webview/src/features/workflowEditor/comfyHost/cropEditor.js';

const box = (x: number, y: number, w: number, h: number): CropRectNorm => ({ x, y, w, h });
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

suite('cropEditor / dragCrop(move)', () => {

	test('★ 跟随指针：向上/向左拖 → 框向上/向左（方向不反向）', () => {
		const start = box(0.4, 0.4, 0.2, 0.2);
		const up = dragCrop('move', start, 0.5, 0.5, 0.5, 0.45);      // 指针上移 0.05
		assert.ok(near(up.y, 0.35), `向上拖应 y-0.05，实得 ${up.y}`);
		assert.ok(near(up.x, 0.4), `x 不应变，实得 ${up.x}`);
		const left = dragCrop('move', start, 0.5, 0.5, 0.45, 0.5);    // 指针左移 0.05
		assert.ok(near(left.x, 0.35), `向左拖应 x-0.05，实得 ${left.x}`);
	});

	test('★ 回归：拖出右下 → 位置停在 1-w / 1-h，尺寸不变（此前被挤扁）', () => {
		const start = box(0.4, 0.4, 0.3, 0.2);
		const r = dragCrop('move', start, 0.5, 0.5, 2.0, 2.0);        // 远远拖出右下
		assert.strictEqual(r.w, start.w, '宽度必须恒定');
		assert.strictEqual(r.h, start.h, '高度必须恒定');
		assert.ok(near(r.x, 0.7), `x 应停在 1-w=0.7，实得 ${r.x}`);
		assert.ok(near(r.y, 0.8), `y 应停在 1-h=0.8，实得 ${r.y}`);
	});

	test('★ 回归：拖出左上 → 位置停在 0/0，尺寸不变', () => {
		const start = box(0.2, 0.3, 0.3, 0.2);
		const r = dragCrop('move', start, 0.5, 0.5, -3, -3);
		assert.strictEqual(r.w, start.w);
		assert.strictEqual(r.h, start.h);
		assert.strictEqual(r.x, 0);
		assert.strictEqual(r.y, 0);
	});

	test('任意位移下尺寸恒定（含边界与越界）', () => {
		const start = box(0.3, 0.3, 0.4, 0.25);
		const targets: Array<[number, number]> = [[0.31, 0.32], [0.9, 0.9], [0, 0], [0.5, 0.5], [1.5, -1.5]];
		for (const [nx, ny] of targets) {
			const r = dragCrop('move', start, 0.3, 0.3, nx, ny);
			assert.strictEqual(r.w, start.w, `w 恒定（target ${nx},${ny}）`);
			assert.strictEqual(r.h, start.h, `h 恒定（target ${nx},${ny}）`);
			assert.ok(r.x >= 0 && r.x + r.w <= 1 + 1e-9, `x 在界内（实得 ${r.x}）`);
			assert.ok(r.y >= 0 && r.y + r.h <= 1 + 1e-9, `y 在界内（实得 ${r.y}）`);
		}
	});

	test('满幅框（w=h=1）移动不产生位移（无可用空间）', () => {
		const start = box(0, 0, 1, 1);
		const r = dragCrop('move', start, 0.5, 0.5, 0.9, 0.1);
		assert.deepStrictEqual(r, start);
	});
});

suite('cropEditor / dragCrop(resize)', () => {

	test('四角：对角锚点保持不动', () => {
		const start = box(0.3, 0.3, 0.4, 0.4);
		// [handle, 期望锚点(与手柄相对的角)]
		const cases: Array<['tl' | 'tr' | 'bl' | 'br', number, number]> = [
			['tl', start.x + start.w, start.y + start.h],
			['tr', start.x, start.y + start.h],
			['bl', start.x + start.w, start.y],
			['br', start.x, start.y],
		];
		for (const [handle, ax, ay] of cases) {
			const r = dragCrop(handle, start, 0.5, 0.5, 0.42, 0.44);
			const anchor: [number, number] =
				handle === 'tl' ? [r.x + r.w, r.y + r.h]
					: handle === 'tr' ? [r.x, r.y + r.h]
						: handle === 'bl' ? [r.x + r.w, r.y]
							: [r.x, r.y];
			assert.ok(near(anchor[0], ax), `${handle} 锚点 x 应 ${ax}，实得 ${anchor[0]}`);
			assert.ok(near(anchor[1], ay), `${handle} 锚点 y 应 ${ay}，实得 ${anchor[1]}`);
		}
	});

	test('上边手柄：向上拖 → 上边界上移、下边界不动', () => {
		const start = box(0.3, 0.3, 0.4, 0.4);
		// 按在上边界中点 (0.5, 0.3) → 上移到 (0.5, 0.2)：位移 -0.1 作用于上边界
		const r = dragCrop('t', start, 0.5, 0.3, 0.5, 0.2);
		assert.ok(near(r.y, 0.2), `上边界应到 0.2，实得 ${r.y}`);
		assert.ok(near(r.y + r.h, start.y + start.h), '下边界应不动');
	});

	test('右边手柄：向右拖 → 宽度增大、左边界不动', () => {
		const start = box(0.3, 0.3, 0.4, 0.4);
		const r = dragCrop('r', start, 0.7, 0.5, 0.8, 0.5);
		assert.ok(near(r.x, start.x), '左边界应不动');
		assert.ok(near(r.w, 0.5), `宽度应 0.5，实得 ${r.w}`);
	});
});

suite('cropEditor / dragCrop(resize) 越过对边守卫', () => {
	// start 的 right = 0.7、bottom = 0.7
	const start = box(0.3, 0.3, 0.4, 0.4);

	test('★ 回归：上边被拖到下边之下 → 停在下边-0.02，不翻面跳到锚点另一侧', () => {
		const r = dragCrop('t', start, 0.5, 0.3, 0.5, 0.9);
		assert.ok(near(r.y + r.h, start.y + start.h), `下边界应保持 0.7，实得 ${r.y + r.h}`);
		assert.ok(near(r.h, 0.02), `高度应停在最小值 0.02，实得 ${r.h}`);
	});

	test('★ 回归：左边被拖到右边之右 → 停在右边-0.02，不翻面', () => {
		const r = dragCrop('l', start, 0.3, 0.5, 0.9, 0.5);
		assert.ok(near(r.x + r.w, start.x + start.w), `右边界应保持 0.7，实得 ${r.x + r.w}`);
		assert.ok(near(r.w, 0.02), `宽度应停在最小值 0.02，实得 ${r.w}`);
	});

	test('★ 回归：左上角被拖到右下之外 → 两条边都停在锚点侧', () => {
		const r = dragCrop('tl', start, 0.3, 0.3, 0.95, 0.95);
		assert.ok(near(r.x + r.w, 0.7), `右边界 0.7，实得 ${r.x + r.w}`);
		assert.ok(near(r.y + r.h, 0.7), `下边界 0.7，实得 ${r.y + r.h}`);
	});

	test('正常范围内 resize 不受守卫影响', () => {
		const r = dragCrop('t', start, 0.5, 0.3, 0.5, 0.45);
		assert.ok(near(r.y, 0.45), `y 应 0.45，实得 ${r.y}`);
		assert.ok(near(r.y + r.h, 0.7), '下边界应不动');
	});
});

suite('cropEditor / dragNewCrop + hitTest + 单位换算', () => {

	test('★ 向上/向左拖选 → 宽高仍为正，左上角取较小值', () => {
		const r = dragNewCrop(0.6, 0.6, 0.2, 0.3);
		assert.ok(near(r.x, 0.2), `x=${r.x}`);
		assert.ok(near(r.y, 0.3), `y=${r.y}`);
		assert.ok(near(r.w, 0.4), `w=${r.w}`);
		assert.ok(near(r.h, 0.3), `h=${r.h}`);
	});

	test('hitTestCrop：四角 / 边中点 / 内部 / 外部', () => {
		const n = box(0.2, 0.2, 0.6, 0.6);
		assert.strictEqual(hitTestCrop(n, 0.2, 0.2, 0.05), 'tl');
		assert.strictEqual(hitTestCrop(n, 0.8, 0.8, 0.05), 'br');
		assert.strictEqual(hitTestCrop(n, 0.5, 0.2, 0.05), 't');
		assert.strictEqual(hitTestCrop(n, 0.5, 0.5, 0.05), 'move');
		assert.strictEqual(hitTestCrop(n, 0.05, 0.05, 0.05), null);
	});

	test('pxToNorm / normToPx 往返一致', () => {
		const n = pxToNorm({ x: 100, y: 50, width: 200, height: 100 }, 1000, 500);
		assert.deepStrictEqual(n, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
		assert.deepStrictEqual(normToPx(n, 1000, 500), { x: 100, y: 50, width: 200, height: 100 });
	});
});
