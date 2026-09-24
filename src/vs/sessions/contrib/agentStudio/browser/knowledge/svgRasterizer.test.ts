/*---------------------------------------------------------------------------------------------
 *  SVG 栅格化的**可测部分**（parseSvgSize / clampScale）单元测试 —— 2026-09-23
 *
 *  `svgToPng` 依赖 DOM（Image/canvas）⇒ 只能在真机验证；这里钉住「尺寸推断」这条易错逻辑：
 *  推断错会直接导致导出的 PNG 尺寸荒谬（1×1 或几千像素），在飞书里就是「图糊/图爆」。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/browser/knowledge/svgRasterizer.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { parseSvgSize, clampScale } from './svgRasterizer.js';

suite('SVG 尺寸推断（parseSvgSize）', () => {
	test('width/height 属性优先（容忍 px 后缀）', () => {
		assert.deepStrictEqual(parseSvgSize('<svg width="640" height="480"></svg>'), { width: 640, height: 480 });
		assert.deepStrictEqual(parseSvgSize('<svg width="640px" height="480px"></svg>'), { width: 640, height: 480 });
	});

	test('★ 百分比尺寸必须回退 viewBox（否则会被当成 100 像素）', () => {
		const svg = '<svg width="100%" height="100%" viewBox="0 0 320 200"></svg>';
		assert.deepStrictEqual(parseSvgSize(svg), { width: 320, height: 200 });
	});

	test('缺 width/height ⇒ 用 viewBox 的第 3/4 个数', () => {
		assert.deepStrictEqual(parseSvgSize('<svg viewBox="0 0 512 288"></svg>'), { width: 512, height: 288 });
		// 逗号分隔的 viewBox 同样支持
		assert.deepStrictEqual(parseSvgSize('<svg viewBox="-10,-10,100,50"></svg>'), { width: 100, height: 50 });
	});

	test('无法推断 ⇒ 兜底 800×600（不是 1×1，避免导出成不可见图）', () => {
		assert.deepStrictEqual(parseSvgSize('<svg></svg>'), { width: 800, height: 600 });
		assert.deepStrictEqual(parseSvgSize(''), { width: 800, height: 600 });
		assert.deepStrictEqual(parseSvgSize('<svg viewBox="0 0 0 0"></svg>'), { width: 800, height: 600 });
	});

	test('width 有而 height 缺 ⇒ 只补缺的那个（不整体回退）', () => {
		assert.deepStrictEqual(parseSvgSize('<svg width="400" viewBox="0 0 400 250"></svg>'), { width: 400, height: 250 });
	});
});

suite('栅格化倍率收敛（clampScale）', () => {
	test('常规尺寸：保留期望倍率（默认 2x 更清晰）', () => {
		assert.strictEqual(clampScale({ width: 800, height: 600 }, 2), 2);
	});

	test('★ 超大图：倍率被压到单边 4096 以内（避免画布被拒 / 内存爆）', () => {
		const scale = clampScale({ width: 4000, height: 3000 }, 2);
		assert.strictEqual(scale, 4096 / 4000);
		assert.ok(4000 * scale <= 4096);
	});

	test('倍率下限为 1（不允许缩小到看不清）', () => {
		assert.strictEqual(clampScale({ width: 100, height: 100 }, 0.2), 1);
	});

	test('尺寸非法 ⇒ 回退 1 倍（不抛错、不产生 0 尺寸画布）', () => {
		assert.strictEqual(clampScale({ width: 0, height: 0 }, 2), 1);
	});
});
