/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { extractImageGenResultUrls } from './imageGenResultUrls.js';

const TOOLCARDS_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.toolCards.ts';
const IMAGEGEN_REL = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/imageGenTools.ts';
const BASE_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.base.ts';

suite('imageGenResultUrls — image_generate 结果图片 URL 提取（2026-09-25 断点④修复 ✓）', () => {

	test('data URL ✓', () => {
		const urls = extractImageGenResultUrls('图：data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
		assert.deepStrictEqual(urls, ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==']);
	});

	test('https 带扩展名 ✓（旧行为保留 ✓）', () => {
		const urls = extractImageGenResultUrls('- https://cdn.x.com/a/b.png');
		assert.deepStrictEqual(urls, ['https://cdn.x.com/a/b.png']);
	});

	test('★★★ 断点④：签名 URL / 无扩展名 ⇒ 也要匹配 ✗✓（旧正则要求扩展名 ⇒ 图不显示 ✗）', () => {
		const urls = extractImageGenResultUrls(
			'图片引用：\n  - https://cdn.x.com/images/abc?sig=9f8e&exp=123\n  - https://o.ai/gen/7f3d',
		);
		assert.deepStrictEqual(urls, ['https://cdn.x.com/images/abc?sig=9f8e&exp=123', 'https://o.ai/gen/7f3d']);
	});

	test('saros-media:// 短引用**不匹配**（它是 data: 的源，不是 http ✓ 误吞会重复渲染 ✗）', () => {
		const urls = extractImageGenResultUrls('- saros-media://abc123');
		assert.deepStrictEqual(urls, []);
	});

	test('URL 尾部的中文句读不得被吞（真实结果文本有 `）。` ✗✓）', () => {
		const urls = extractImageGenResultUrls('（见 https://cdn.x.com/a.png）。下一句');
		assert.deepStrictEqual(urls, ['https://cdn.x.com/a.png']);
	});

	test('去重 ✓ + 顺序保持 ✓', () => {
		const urls = extractImageGenResultUrls('https://x.com/1.png https://x.com/2.png https://x.com/1.png');
		assert.deepStrictEqual(urls, ['https://x.com/1.png', 'https://x.com/2.png']);
	});

	test('空/无图 ⇒ 空数组 ✓（交回默认文本渲染 ✓）', () => {
		assert.deepStrictEqual(extractImageGenResultUrls(''), []);
		assert.deepStrictEqual(extractImageGenResultUrls('已生成 0 张图片。'), []);
	});

	suite('★★ 接线断言（防回退 ✗✓）', () => {
		test('工具卡必须走纯模块提取（不再内联正则 ✗）', () => {
			const src = readFileSync(TOOLCARDS_REL, 'utf8');
			assert.ok(src.includes("from './imageGenResultUrls.js'"), 'toolCards 必须引用纯模块 ✓');
			assert.ok(src.includes('extractImageGenResultUrls('), '_createImageGenResultCard 必须调用纯函数 ✓');
			const fnIdx = src.indexOf('_createImageGenResultCard(');
			const body = src.slice(fnIdx, fnIdx + 1500);
			assert.ok(!body.includes('\\.(?:png|jpe?g'), '旧的「要求扩展名」正则必须移除 ✗✓');
		});

		test('★★★ 断点③：落盘失败的兜底必须在文案里说清（否则「已生成」却不见图 ✗✓）', () => {
			const src = readFileSync(IMAGEGEN_REL, 'utf8');
			assert.ok(src.includes('媒体库存储失败'),
				'兜底文本必须说明「媒体库存储失败…聊天框无法显示」✗✓（内联图会被 splitToolResultImages 剥离发给模型 ✓ UI 不可见 ⇒ 必须明说 ✓）');
		});

		test('F3：image_generate 必须有专属标题 ✓', () => {
			const src = readFileSync(BASE_REL, 'utf8');
			assert.ok(/image_generate:\s*\{\s*done:/.test(src),
				'TOOL_BUILTIN_TITLES 必须有 image_generate 条目 ✗✓（否则走通用回退「调用了 image_generate」✗）');
		});
	});
});
