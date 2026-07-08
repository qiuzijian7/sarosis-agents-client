/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	formatAttachmentHyperlink,
	formatAttachmentsHyperlinks,
	extractAttachmentIds,
	stripAttachmentHyperlinks,
	ATTACHMENT_LINK_SCHEME,
} from '../../../browser/agentChat/attachmentLink.js';
import type { IChatAttachment } from '../../../browser/agentChat/agentChatTypes.js';
import { buildUserContentParts } from '../agentDriverService.js';
import { MessageFormatConverter } from '../common/adapters/messageFormatConverter.js';
import type { IChatMessage, IChatContentPart } from '../common/providers.js';
import type { IChatAttachmentSend } from '../../../../common/agentStudioService.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makeImageAttachment(overrides: Partial<IChatAttachment> = {}): IChatAttachment {
	return {
		id: 'att-img-1',
		type: 'image',
		name: 'screenshot.png',
		mimeType: 'image/png',
		data: PNG_BASE64,
		size: PNG_BASE64.length,
		...overrides,
	};
}

function makeFileAttachment(overrides: Partial<IChatAttachment> = {}): IChatAttachment {
	return {
		id: 'att-file-1',
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

suite('Chat input attachments → hyperlink embedding in input box', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ── 1. 单附件超链接格式化 ──────────────────────────────────────────────

	test('图片附件 → 生成 image 超链接（带 📷 图标与 scheme://id）', () => {
		const link = formatAttachmentHyperlink(makeImageAttachment());
		assert.strictEqual(link, `[📷 screenshot.png](${ATTACHMENT_LINK_SCHEME}://att-img-1)`);
	});

	test('文本文件附件 → 生成 file 超链接（带 📄 图标与 scheme://id）', () => {
		const link = formatAttachmentHyperlink(makeFileAttachment());
		assert.strictEqual(link, `[📄 notes.txt](${ATTACHMENT_LINK_SCHEME}://att-file-1)`);
	});

	test('多附件 → 用空格拼接为可嵌入输入框的超链接串', () => {
		const joined = formatAttachmentsHyperlinks([makeImageAttachment(), makeFileAttachment()]);
		assert.strictEqual(
			joined,
			`[📷 screenshot.png](${ATTACHMENT_LINK_SCHEME}://att-img-1) [📄 notes.txt](${ATTACHMENT_LINK_SCHEME}://att-file-1)`,
		);
	});

	// ── 2. 从输入框文本中反查附件 id ───────────────────────────────────────

	test('extractAttachmentIds 从输入框文本提取嵌套的超链接附件 id（按顺序）', () => {
		const text = `请分析 [📄 notes.txt](${ATTACHMENT_LINK_SCHEME}://att-file-1) 和 [📷 screenshot.png](${ATTACHMENT_LINK_SCHEME}://att-img-1) 这两份材料`;
		const ids = extractAttachmentIds(text);
		assert.deepStrictEqual(ids, ['att-file-1', 'att-img-1']);
	});

	test('无超链接文本 → extractAttachmentIds 返回空数组', () => {
		assert.deepStrictEqual(extractAttachmentIds('普通文本没有附件'), []);
		assert.deepStrictEqual(extractAttachmentIds(''), []);
	});

	// ── 3. 发送前去除超链接占位符（真实数据走 attachments 通道）────────────

	test('stripAttachmentHyperlinks 仅移除附件超链接，保留用户其他文本', () => {
		const text = `请分析 [📄 notes.txt](${ATTACHMENT_LINK_SCHEME}://att-file-1) 谢谢`;
		assert.strictEqual(stripAttachmentHyperlinks(text), '请分析 谢谢');
	});

	test('只有超链接、无其他文本 → strip 后为空字符串（附件数据由 attachments 承载）', () => {
		const text = `[📷 screenshot.png](${ATTACHMENT_LINK_SCHEME}://att-img-1)`;
		assert.strictEqual(stripAttachmentHyperlinks(text), '');
	});

	test('普通 markdown 链接（非附件 scheme）应被保留，不被误删', () => {
		const text = `参考 [文档](https://example.com/doc) 和 [📄 notes.txt](${ATTACHMENT_LINK_SCHEME}://att-file-1)`;
		const stripped = stripAttachmentHyperlinks(text);
		assert.ok(stripped.includes('[文档](https://example.com/doc)'), '普通链接应保留');
		assert.ok(!stripped.includes(ATTACHMENT_LINK_SCHEME), '附件链接应被去除');
	});

	// ── 4. 端到端：输入框超链接 → 去除 → 正确发送给 LLM ───────────────────

	test('端到端：输入框含图片超链接 + 文本，去除超链接后图片真实数据仍经 contentParts 送达 LLM（OpenAI image_url）', () => {
		// 模拟用户在输入框里看到的文本（附件以超链接嵌入）
		const inputText = `这是什么？ [📷 screenshot.png](${ATTACHMENT_LINK_SCHEME}://att-img-1)`;
		const attachments: IChatAttachmentSend[] = [makeImageAttachment()];

		// 发送前去除超链接占位符（_handleSendMessage 的行为）
		const cleanText = stripAttachmentHyperlinks(inputText);
		assert.strictEqual(cleanText, '这是什么？');

		// 结构化的 attachments 仍然携带真实数据，构建多模态 contentParts
		const parts = buildUserContentParts(cleanText, attachments);
		assert.ok(parts, '应生成 contentParts');
		const imgPart = parts!.find(p => p.type === 'image');
		assert.ok(imgPart, '应保留 image 块');
		assert.strictEqual((imgPart as any).data, PNG_BASE64, '图片真实 base64 应保留');

		// 最终经 MessageFormatConverter 转为 LLM 多模态格式
		const msgs = MessageFormatConverter.toOpenAI([userMessageWithParts(parts)]);
		const content = (msgs[0] as any).content;
		const imageBlock = content.find((b: any) => b.type === 'image_url');
		assert.ok(imageBlock, '应包含 image_url 块');
		assert.strictEqual(imageBlock.image_url.url, `data:image/png;base64,${PNG_BASE64}`);
	});

	test('端到端：输入框含文本文件超链接 + 文本，去除后文件内容仍内联进 LLM 文本块', () => {
		const inputText = `看这个文件 [📄 notes.txt](${ATTACHMENT_LINK_SCHEME}://att-file-1)`;
		const attachments: IChatAttachmentSend[] = [makeFileAttachment()];

		const cleanText = stripAttachmentHyperlinks(inputText);
		assert.strictEqual(cleanText, '看这个文件');

		const parts = buildUserContentParts(cleanText, attachments);
		assert.ok(parts);
		const textPart = (parts![0] as { type: 'text'; text: string }).text;
		assert.ok(textPart.startsWith('看这个文件'), '用户文本应保留');
		assert.ok(textPart.includes('hello from attachment'), '文件真实内容应内联（非占位文本）');
	});

	test('端到端：图片 + 文本文件混合超链接，去除后两者数据都正确送达 LLM', () => {
		const inputText =
			`分析 [📄 notes.txt](${ATTACHMENT_LINK_SCHEME}://att-file-1) 和 [📷 screenshot.png](${ATTACHMENT_LINK_SCHEME}://att-img-1)`;
		const attachments: IChatAttachmentSend[] = [makeFileAttachment(), makeImageAttachment()];

		const cleanText = stripAttachmentHyperlinks(inputText);
		assert.strictEqual(cleanText, '分析 和');

		const parts = buildUserContentParts(cleanText, attachments);
		assert.ok(parts);
		assert.ok(parts!.some(p => p.type === 'image'), '图片块应存在');
		assert.ok((parts![0] as any).text.includes('hello from attachment'), '文件内容应内联');

		// Anthropic 格式验证图片真实数据
		const { messages } = MessageFormatConverter.toAnthropic([userMessageWithParts(parts)]);
		const imageBlock = (messages[0] as any).content.find((b: any) => b.type === 'image');
		assert.ok(imageBlock, 'Anthropic 应包含 image 块');
		assert.strictEqual(imageBlock.source.data, PNG_BASE64);
	});
});
