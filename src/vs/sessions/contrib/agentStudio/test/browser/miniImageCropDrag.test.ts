/*---------------------------------------------------------------------------------------------
 *  Unit tests for miniImageCropDrag — MiniImageEditor 裁剪框拖拽的纯数学。
 *
 *  ★ 回归守卫（2026-09-11）：用户报「裁剪方块**向上**拖拽时方块**向下**移动」。
 *    该语义此前内联在 67KB 组件里、零测试覆盖 —— 只能靠读代码断言「代码是对的」。
 *    本文件把三条不变量钉死：
 *      ① 方向：位移**跟随指针**（+dx/+dy），不是视图平移的减号语义
 *      ② 边界：整体移动位置 clamp 到 [0,1-w]/[0,1-h] → 尺寸恒定（不「挤扁」）
 *      ③ 手柄：四角缩放对角固定、不越过对角（min 2%）
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	moveCropBy,
	resizeCropByCorner,
	resizeCropKeepTopLeft,
	CROP_MIN_SIDE,
	CROP_MIN_WH,
	type CellCropRect,
} from '../../webview/src/features/workflowEditor/miniImageCropDrag.js';

const box = (x: number, y: number, w: number, h: number): CellCropRect => ({ x, y, w, h });
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

suite('miniImageCropDrag / 整体移动（moveCropBy）', () => {

	test('★ 方向：向上拖 → 框向上（y 减小）；向左拖 → 框向左（x 减小）', () => {
		const start = box(0.4, 0.4, 0.2, 0.2);
		// 指针上移 0.05 → 框上移 0.05（跟随鼠标，不是反向）
		const up = moveCropBy(start, 0, -0.05);
		assert.ok(near(up.y, 0.35), `向上拖应 y=0.35（跟随指针），实得 ${up.y}`);
		assert.ok(near(up.x, 0.4), 'x 不应变');
		// 指针左移 0.05 → 框左移 0.05
		const left = moveCropBy(start, -0.05, 0);
		assert.ok(near(left.x, 0.35), `向左拖应 x=0.35，实得 ${left.x}`);
		// 向下/向右同理（正号）
		assert.ok(near(moveCropBy(start, 0, 0.05).y, 0.45));
		assert.ok(near(moveCropBy(start, 0.05, 0).x, 0.45));
	});

	test('★ 边界：拖出右下 → 位置停在 1-w / 1-h，尺寸恒定（不被挤扁）', () => {
		const start = box(0.4, 0.4, 0.3, 0.2);
		const r = moveCropBy(start, 1.5, 1.5);
		assert.strictEqual(r.w, start.w, '宽度必须恒定');
		assert.strictEqual(r.h, start.h, '高度必须恒定');
		assert.ok(near(r.x, 0.7), `x 应停在 1-w=0.7，实得 ${r.x}`);
		assert.ok(near(r.y, 0.8), `y 应停在 1-h=0.8，实得 ${r.y}`);
	});

	test('★ 边界：拖出左上 → 停在 0/0，尺寸恒定', () => {
		const start = box(0.2, 0.3, 0.3, 0.2);
		const r = moveCropBy(start, -3, -3);
		assert.strictEqual(r.w, start.w);
		assert.strictEqual(r.h, start.h);
		assert.strictEqual(r.x, 0);
		assert.strictEqual(r.y, 0);
	});

	test('满幅框（w=h=1）无可用空间 → 不动', () => {
		const start = box(0, 0, 1, 1);
		assert.deepStrictEqual(moveCropBy(start, 0.5, -0.5), start);
	});

	test('方向键微调同语义：ArrowUp = dy 负 → 框上移', () => {
		const start = box(0.5, 0.5, 0.2, 0.2);
		const step = 1 / 1000;                       // 1 整图像素 / 图宽 1000
		const r = moveCropBy(start, 0, -step);
		assert.ok(r.y < start.y, 'ArrowUp 必须让框上移');
		assert.ok(near(r.y, 0.5 - step));
	});
});

suite('miniImageCropDrag / 四角手柄（resizeCropByCorner）', () => {

	const start = box(0.3, 0.3, 0.4, 0.4);   // right=0.7, bottom=0.7

	test('★ 对角固定：被拖角跟随光标，对角不动', () => {
		const n = { x: 0.42, y: 0.44 };
		const cases: Array<['nw' | 'ne' | 'sw' | 'se', number, number]> = [
			['nw', start.x + start.w, start.y + start.h],
			['ne', start.x, start.y + start.h],
			['sw', start.x + start.w, start.y],
			['se', start.x, start.y],
		];
		for (const [corner, ax, ay] of cases) {
			const r = resizeCropByCorner(corner, start, n);
			const anchor: [number, number] =
				corner === 'nw' ? [r.x + r.w, r.y + r.h]
					: corner === 'ne' ? [r.x, r.y + r.h]
						: corner === 'sw' ? [r.x + r.w, r.y]
							: [r.x, r.y];
			assert.ok(near(anchor[0], ax), `${corner} 锚点 x 应 ${ax}，实得 ${anchor[0]}`);
			assert.ok(near(anchor[1], ay), `${corner} 锚点 y 应 ${ay}，实得 ${anchor[1]}`);
		}
	});

	test('★ 被拖角跟随光标：nw 向上拖 → 上边界上移', () => {
		const r = resizeCropByCorner('nw', start, { x: 0.2, y: 0.2 });
		assert.ok(near(r.x, 0.2) && near(r.y, 0.2), `被拖角应到 (0.2,0.2)，实得 (${r.x},${r.y})`);
		assert.ok(near(r.x + r.w, 0.7) && near(r.y + r.h, 0.7), '对角应保持 (0.7,0.7)');
	});

	test('★ 不越过对角：nw 拖到右下之外 → 宽高停在最小边（不翻转）', () => {
		const r = resizeCropByCorner('nw', start, { x: 0.95, y: 0.95 });
		assert.ok(near(r.w, CROP_MIN_SIDE), `w 应停在 ${CROP_MIN_SIDE}，实得 ${r.w}`);
		assert.ok(near(r.h, CROP_MIN_SIDE), `h 应停在 ${CROP_MIN_SIDE}，实得 ${r.h}`);
		assert.ok(near(r.x + r.w, 0.7), `右边界应保持 0.7，实得 ${r.x + r.w}`);
		assert.ok(near(r.y + r.h, 0.7), `下边界应保持 0.7，实得 ${r.y + r.h}`);
	});

	test('se 拖出图界 → 右边/下边 clamp 到 1', () => {
		const r = resizeCropByCorner('se', start, { x: 5, y: 5 });
		assert.ok(near(r.x + r.w, 1) && near(r.y + r.h, 1), `应贴到 (1,1)，实得 (${r.x + r.w},${r.y + r.h})`);
		assert.ok(near(r.x, start.x) && near(r.y, start.y), '对角（左上）应不动');
	});
});

suite('miniImageCropDrag / Shift 缩放（resizeCropKeepTopLeft）', () => {

	test('左上角固定，宽高随位移', () => {
		const start = box(0.3, 0.3, 0.4, 0.4);
		const grow = resizeCropKeepTopLeft(start, 0.1, 0.05);
		assert.ok(near(grow.x, 0.3) && near(grow.y, 0.3), '左上角必须固定');
		assert.ok(near(grow.w, 0.5) && near(grow.h, 0.45), `宽高应 0.5/0.45，实得 ${grow.w}/${grow.h}`);
	});

	test('缩到最小 5% 与贴边 clamp（不越界）', () => {
		const start = box(0.3, 0.3, 0.4, 0.4);
		const shrink = resizeCropKeepTopLeft(start, -5, -5);
		assert.ok(near(shrink.w, CROP_MIN_WH) && near(shrink.h, CROP_MIN_WH), '应停在最小宽高');
		const huge = resizeCropKeepTopLeft(start, 5, 5);
		assert.ok(near(huge.w, 0.7) && near(huge.h, 0.7), `应贴到 1-x / 1-y = 0.7，实得 ${huge.w}/${huge.h}`);
	});
});
