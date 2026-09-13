/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具结果图像项处理（`common/toolResultImages`）单元测试。
 *
 * 覆盖 2026-09-13 追踪出的缺口：工具能返回 `{type:'image'}`，但回灌路径把它
 * `JSON.stringify` 成文本并**按 10 万字符截断** → base64 损坏且模型看到的不是图。
 * 修法是把图像项**剥离**出来、改走 `role:'user'` 的 `contentParts`。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/common/toolResultImages.test.ts
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	splitToolResultImages, buildToolImageMessage, toolImageOmittedNote,
} from '../../common/toolResultImages.js';

/** 短 base64（真实图片会很长，这里只要形态正确）。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==';

suite('toolResultImages — 工具结果里的图像项', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ── splitToolResultImages ───────────────────────────────────────────

	test('★ 分离出图像项，其余项**顺序不变**', () => {
		const { text, images } = splitToolResultImages([
			{ type: 'text', text: 'before' },
			{ type: 'image', data: PNG_B64, mimeType: 'image/png' },
			{ type: 'text', text: 'after' },
		]);
		assert.strictEqual(images.length, 1);
		assert.strictEqual(images[0].data, PNG_B64);
		assert.strictEqual(images[0].mimeType, 'image/png');
		assert.deepStrictEqual(text, [
			{ type: 'text', text: 'before' },
			{ type: 'text', text: 'after' },
		], '非图像项必须原样保留且顺序不变');
	});

	test('★★ 关键：图像项**不再进入**被截断的 JSON 文本（本次修复的核心）', () => {
		const huge = 'A'.repeat(200_000); // 远超 MAX_TOOL_RESULT_CHARS(100K)
		const { text, images } = splitToolResultImages([
			{ type: 'text', text: 'ok' },
			{ type: 'image', data: huge, mimeType: 'image/png' },
		]);
		assert.strictEqual(images.length, 1);
		// 剥离后剩下的文本里不得再出现那段 base64 —— 否则它会被截断损坏后塞进上下文
		assert.ok(!JSON.stringify(text).includes('AAAA'), 'base64 不得残留在文本里');
	});

	test('★ 控制组：非数组内容原样返回（字符串 / undefined / 对象）', () => {
		for (const v of ['plain text', undefined, null, { some: 'object' }]) {
			const r = splitToolResultImages(v);
			assert.strictEqual(r.text, v, '非数组内容必须原样返回');
			assert.deepStrictEqual(r.images, []);
		}
	});

	test('★ 控制组：纯文本结果零影响（绝大多数工具走这条）', () => {
		const content = [{ type: 'text', text: 'hello' }, { type: 'resource', text: 'x', mimeType: 'text/plain' }];
		const { text, images } = splitToolResultImages(content);
		assert.deepStrictEqual(text, content, '无图像项时内容必须逐字不变');
		assert.strictEqual(images.length, 0);
	});

	test('★★ 引用形态（URI 而非 base64）的图像项**保留在文本里**，不静默丢弃', () => {
		// MCP 允许 `type:'image'` 携带 URI 引用；那种无法作为图像块发出 ——
		// 宁可让模型看到 URI，也不要静默丢掉（本项目对「静默削弱」的一贯态度）。
		const { text, images } = splitToolResultImages([
			{ type: 'image', data: 'saros-media://asset-1', mimeType: 'image/png' },
			{ type: 'image', data: 'https://example.com/a.png', mimeType: 'image/png' },
			{ type: 'image', data: '', mimeType: 'image/png' },
		]);
		assert.strictEqual(images.length, 0, 'URI / 空 data 不作为图像块发送');
		assert.strictEqual((text as unknown[]).length, 3, '它们必须留在文本里');
	});

	test('★ 多张图 / 未知 MIME 处理正确', () => {
		const { images } = splitToolResultImages([
			{ type: 'image', data: PNG_B64, mimeType: 'image/jpeg' },
			{ type: 'image', data: PNG_B64, mimeType: 'application/octet-stream' },
			{ type: 'image', data: PNG_B64 }, // 无 mimeType
		]);
		assert.strictEqual(images.length, 3);
		assert.strictEqual(images[0].mimeType, 'image/jpeg');
		assert.strictEqual(images[1].mimeType, 'application/octet-stream');
		assert.strictEqual(images[2].mimeType, 'image/png', '缺省按 png');
	});

	// ── buildToolImageMessage ───────────────────────────────────────────

	test('★★ 组装成 `role: user` 消息（唯一可移植的位置）', () => {
		const msg = buildToolImageMessage([{ data: PNG_B64, mimeType: 'image/png' }], 'vision_analyze')!;
		assert.strictEqual(msg.role, 'user', '必须是 user —— tool 分支只读字符串，挂图不生效');
		assert.ok(Array.isArray(msg.contentParts) && msg.contentParts.length === 2);
		assert.strictEqual(msg.contentParts![0].type, 'text');
		const img = msg.contentParts![1];
		assert.strictEqual(img.type, 'image');
		assert.strictEqual((img as { data: string }).data, PNG_B64, '必须是纯 base64（不含 data: 前缀）');
		assert.ok(msg.content.includes('vision_analyze'), '说明文本应含工具名（模型要知道图从哪来）');
	});

	test('★★ MIME 收敛到 `ChatImageMimeType` 允许的集合', () => {
		const cases: Array<[string, string]> = [
			['image/jpeg', 'image/jpeg'],
			['image/jpg', 'image/jpeg'],
			['image/webp', 'image/webp'],
			['image/gif', 'image/gif'],
			['image/bmp', 'image/png'],           // 不在白名单 → 收敛
			['image/tiff', 'image/png'],
			['', 'image/png'],
		];
		for (const [input, expected] of cases) {
			const msg = buildToolImageMessage([{ data: PNG_B64, mimeType: input }], 't')!;
			const img = msg.contentParts![1] as { mimeType: string };
			assert.strictEqual(img.mimeType, expected, `mime ${input} → ${expected}`);
		}
	});

	test('★ 控制组：无图像 → undefined（调用方据此零成本跳过）', () => {
		assert.strictEqual(buildToolImageMessage([], 't'), undefined);
	});

	test('★ 多图：一张说明 + N 个图像块，顺序稳定', () => {
		const msg = buildToolImageMessage(
			[{ data: 'AAA', mimeType: 'image/png' }, { data: 'BBB', mimeType: 'image/png' }],
			'image_generate',
		)!;
		assert.strictEqual(msg.contentParts!.length, 3);
		assert.deepStrictEqual(
			msg.contentParts!.map(p => p.type),
			['text', 'image', 'image'],
		);
	});

	// ── toolImageOmittedNote ────────────────────────────────────────────

	test('★★ 不支持图片时的说明必须**说清原因 + 给出两条出路**', () => {
		const note = toolImageOmittedNote('mcp:foo', 1);
		assert.ok(note.includes('mcp:foo'), '要说明是哪个工具');
		assert.ok(/does not declare image input support/.test(note), '要说清为什么没附上');
		assert.ok(note.includes('vision_analyze'), '要给可执行出路（文本答案工具）');
		// 复数形态不出现语法错误
		assert.ok(toolImageOmittedNote('t', 2).includes('they are NOT attached'));
		assert.ok(toolImageOmittedNote('t', 1).includes('it is NOT attached'));
	});
});
