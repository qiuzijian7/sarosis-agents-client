/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildUserContentParts } from '../agentDriverService.js';
import { MessageFormatConverter } from '../common/adapters/messageFormatConverter.js';
import type { IChatMessage, IChatContentPart } from '../common/providers.js';
import type { IChatAttachmentSend } from '../../../../common/agentStudioService.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makeImageAttachment(overrides: Partial<IChatAttachmentSend> = {}): IChatAttachmentSend {
	return {
		id: 'att-img',
		type: 'image',
		name: 'screenshot.png',
		mimeType: 'image/png',
		data: PNG_BASE64,
		size: PNG_BASE64.length,
		...overrides,
	};
}

function makeFileAttachment(overrides: Partial<IChatAttachmentSend> = {}): IChatAttachmentSend {
	return {
		id: 'att-file',
		type: 'file',
		name: 'notes.txt',
		mimeType: 'text/plain',
		data: 'hello from attachment',
		size: 22,
		...overrides,
	};
}

function userMessageWithParts(parts: IChatContentPart[] | undefined): IChatMessage {
	return { role: 'user', content: 'look at this', contentParts: parts };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

suite('Chat input attachments → LLM (multimodal correctness)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ── 1. buildUserContentParts 基础行为 ──────────────────────────────────

	test('纯文本消息（无附件）返回 undefined，由 content 字段承载（向后兼容）', () => {
		assert.strictEqual(buildUserContentParts('hello'), undefined);
		assert.strictEqual(buildUserContentParts('hello', []), undefined);
		assert.strictEqual(buildUserContentParts(''), undefined);
	});

	test('仅文本消息 + 附件为空数组 → undefined', () => {
		assert.strictEqual(buildUserContentParts('analyze this', undefined), undefined);
	});

	test('图片附件 → 生成 image contentPart（携带 base64 data + mimeType）', () => {
		const parts = buildUserContentParts('describe', [makeImageAttachment()]);
		assert.ok(parts, '应返回 contentParts');
		assert.strictEqual(parts!.length, 2, 'text 块 + image 块');
		assert.deepStrictEqual(parts![0], { type: 'text', text: 'describe' });
		const img = parts![1];
		assert.strictEqual(img.type, 'image');
		assert.strictEqual((img as any).data, PNG_BASE64, '图片真实 base64 数据应被保留');
		assert.strictEqual((img as any).mimeType, 'image/png', 'mimeType 应被保留');
	});

	test('文本文件附件 → 以文本块形式内联到消息', () => {
		const parts = buildUserContentParts('see file', [makeFileAttachment()]);
		assert.ok(parts);
		assert.strictEqual(parts!.length, 1, '文本与文件上下文合并到同一 text 块');
		const text = (parts![0] as { type: 'text'; text: string }).text;
		assert.ok(text.startsWith('see file'), '原始文本应保留');
		assert.ok(text.includes('--- File: notes.txt ---'), '应包含文件标记');
		assert.ok(text.includes('hello from attachment'), '文件真实内容应被内联');
		assert.ok(text.includes('--- End of notes.txt ---'), '应包含文件结束标记');
	});

	test('二进制文件附件 → data 为 base64 时也内联（改进：不再只是占位文本）', () => {
		const parts = buildUserContentParts('', [makeFileAttachment({
			name: 'data.bin',
			mimeType: 'application/octet-stream',
			data: 'YWJjMTIz', // base64
		})]);
		assert.ok(parts);
		const text = (parts![0] as { type: 'text'; text: string }).text;
		assert.ok(text.includes('YWJjMTIz'), '二进制文件 base64 应被内联而非 [binary file] 占位');
	});

	test('图片 + 文本文件混合 → 正确生成 image 块 + 文本上下文', () => {
		const parts = buildUserContentParts('both', [makeImageAttachment(), makeFileAttachment()]);
		assert.ok(parts);
		const imagePart = parts!.find(p => p.type === 'image');
		assert.ok(imagePart, '应存在 image 块');
		assert.strictEqual((imagePart as any).data, PNG_BASE64);
		const textPart = parts![0] as { type: 'text'; text: string };
		assert.ok(textPart.text.includes('hello from attachment'), '文件上下文应存在');
	});

	test('type=image 但 mimeType 非 image/* → 不视为图片（走文件分支）', () => {
		const parts = buildUserContentParts('x', [makeImageAttachment({ mimeType: 'text/plain' })]);
		assert.ok(parts);
		assert.strictEqual(parts!.some(p => p.type === 'image'), false, '不应生成 image 块');
		assert.ok((parts![0] as any).text.includes('screenshot.png'), '应作为文本文件上下文处理');
	});

	// ── 2. MessageFormatConverter 多模态转换（真实送达 LLM 的格式）───────────

	test('OpenAI：image contentPart → image_url 块（data:image/png;base64,...）', () => {
		const parts = buildUserContentParts('what is this', [makeImageAttachment()]);
		const msgs = MessageFormatConverter.toOpenAI([userMessageWithParts(parts)]);
		const content = (msgs[0] as any).content;
		assert.ok(Array.isArray(content), 'content 应为多模态块数组');
		const imageBlock = content.find((b: any) => b.type === 'image_url');
		assert.ok(imageBlock, '应包含 image_url 块');
		assert.strictEqual(
			imageBlock.image_url.url,
			`data:image/png;base64,${PNG_BASE64}`,
			'图片应以 data URL 形式携带 base64 数据',
		);
		assert.strictEqual(imageBlock.image_url.detail, 'auto');
	});

	test('Anthropic：image contentPart → base64 source 块', () => {
		const parts = buildUserContentParts('describe', [makeImageAttachment()]);
		const { messages } = MessageFormatConverter.toAnthropic([userMessageWithParts(parts)]);
		const content = (messages[0] as any).content;
		assert.ok(Array.isArray(content));
		const imageBlock = content.find((b: any) => b.type === 'image');
		assert.ok(imageBlock, '应包含 image 块');
		assert.strictEqual(imageBlock.source.type, 'base64');
		assert.strictEqual(imageBlock.source.media_type, 'image/png');
		assert.strictEqual(imageBlock.source.data, PNG_BASE64);
	});

	test('Gemini：image contentPart → inline_data 块', () => {
		const parts = buildUserContentParts('look', [makeImageAttachment()]);
		const { contents } = MessageFormatConverter.toGemini([userMessageWithParts(parts)]);
		const partsOut = (contents[0] as any).parts;
		assert.ok(Array.isArray(partsOut));
		const imagePart = partsOut.find((p: any) => p.inline_data);
		assert.ok(imagePart, '应包含 inline_data 块');
		assert.strictEqual(imagePart.inline_data.mime_type, 'image/png');
		assert.strictEqual(imagePart.inline_data.data, PNG_BASE64);
	});

	test('无 contentParts 的纯文本消息 → content 为字符串（向后兼容）', () => {
		const msgs = MessageFormatConverter.toOpenAI([userMessageWithParts(undefined)]);
		assert.strictEqual(typeof (msgs[0] as any).content, 'string');
		assert.strictEqual((msgs[0] as any).content, 'look at this');
	});

	// ── 3. 端到端：图片附件 → 三个主流 LLM 提供商格式均携带真实数据 ──────────

	test('端到端：同一图片附件在 OpenAI/Anthropic/Gemini 三格式中均保留 base64 真实数据', () => {
		const parts = buildUserContentParts('用户上传了图片', [makeImageAttachment()]);
		assert.ok(parts, 'buildUserContentParts 应生成 contentParts');

		const openai = MessageFormatConverter.toOpenAI([userMessageWithParts(parts)]);
		const anthropic = MessageFormatConverter.toAnthropic([userMessageWithParts(parts)]);
		const gemini = MessageFormatConverter.toGemini([userMessageWithParts(parts)]);

		const oUrl = ((openai[0] as any).content.find((b: any) => b.type === 'image_url')).image_url.url;
		const aData = ((anthropic.messages[0] as any).content.find((b: any) => b.type === 'image')).source.data;
		const gData = ((gemini.contents[0] as any).parts.find((p: any) => p.inline_data)).inline_data.data;

		assert.strictEqual(oUrl, `data:image/png;base64,${PNG_BASE64}`);
		assert.strictEqual(aData, PNG_BASE64);
		assert.strictEqual(gData, PNG_BASE64);
	});
});
