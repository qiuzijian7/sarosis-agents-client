/*---------------------------------------------------------------------------------------------
 *  Unit tests for 迷你图像编辑器 AI 工具纯逻辑层（miniEditorAi.ts）。
 *
 *  覆盖：prompt 构造（消除/重绘/扩图）、imagegen 响应解析、扩图尺寸计划。
 *  canvas 合成函数（composeMarkedImage 等）依赖浏览器 DOM，不在 node 单测范围。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	buildErasePrompt,
	buildInpaintPrompt,
	buildOutpaintPrompt,
	extractFirstImageDataUrl,
	planOutpaint,
	MARK_COLOR,
	GEN_MAX_SIDE,
	REMBG_DEFAULT_URL,
} from '../../webview/src/features/workflowEditor/miniEditorAi.js';

suite('miniEditorAi', () => {

	test('常量：品红标记色 / 尺寸上限 / rembg 地址', () => {
		assert.strictEqual(MARK_COLOR, '#ff00ff');
		assert.strictEqual(GEN_MAX_SIDE, 1536);
		assert.strictEqual(REMBG_DEFAULT_URL, 'http://127.0.0.1:7000');
	});

	test('AI消除 prompt：无需输入，声明品红仅为标记', () => {
		const p = buildErasePrompt();
		assert.ok(p.includes('移除'), '必须包含移除指令');
		assert.ok(p.includes('填补'), '必须包含填补指令');
		assert.ok(p.includes('#FF00FF'), '必须声明标记色');
		assert.ok(p.includes('绝对不能出现品红色'), '必须禁止品红出现在结果中');
	});

	test('局部重绘 prompt：用户描述嵌入 + 空描述兜底', () => {
		const p = buildInpaintPrompt('给人物戴上红色帽子');
		assert.ok(p.includes('给人物戴上红色帽子'));
		assert.ok(p.includes('完全不变'));
		const empty = buildInpaintPrompt('   ');
		assert.ok(empty.includes('与周围画面风格一致的内容'), '空描述必须兜底');
	});

	test('扩图 prompt：延展背景 + 保持原图不变', () => {
		const p = buildOutpaintPrompt();
		assert.ok(p.includes('扩展') || p.includes('向外'));
		assert.ok(p.includes('完全不变'));
	});

	test('extractFirstImageDataUrl：b64 → dataURL', () => {
		const url = extractFirstImageDataUrl({ images: [{ b64: 'QUJD' }] });
		assert.strictEqual(url, 'data:image/png;base64,QUJD');
	});

	test('extractFirstImageDataUrl：url 透传（host 已内联场景的兜底）', () => {
		const url = extractFirstImageDataUrl({ images: [{ url: 'data:image/png;base64,WFla' }] });
		assert.strictEqual(url, 'data:image/png;base64,WFla');
	});

	test('extractFirstImageDataUrl：空结果/缺数据必须抛错（不留白屏）', () => {
		assert.throws(() => extractFirstImageDataUrl({ images: [] }), /为空/);
		assert.throws(() => extractFirstImageDataUrl({ images: [{}] }), /缺少/);
		assert.throws(() => extractFirstImageDataUrl({}), /为空/);
	});

	test('planOutpaint：四边等比扩展 + 居中偏移', () => {
		const p = planOutpaint(400, 300, 0.25);
		assert.strictEqual(p.width, 600);
		assert.strictEqual(p.height, 450);
		assert.strictEqual(p.dx, 100);
		assert.strictEqual(p.dy, 75);
	});

	test('planOutpaint：0 比例 = 原尺寸无偏移；超限钳制', () => {
		const zero = planOutpaint(400, 300, 0);
		assert.deepStrictEqual([zero.width, zero.height, zero.dx, zero.dy], [400, 300, 0, 0]);
		const clamped = planOutpaint(400, 300, 5);   // ratio > 1 → 钳到 1（三倍）
		assert.strictEqual(clamped.width, 1200);
		// 4096 上限
		const cap = planOutpaint(3000, 2000, 0.5);
		assert.ok(cap.width <= 4096 && cap.height <= 4096);
	});
});
