/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { adaptPersistedChatMessage } from './agentChatTypes.js';

/**
 * ★★★ 用户消息附件的**持久化往返**回归（2026-09-19，用户实测）。
 *
 * 现象：发送带**代码片段**的消息时气泡有「📝 代码片段」pill ✓，**重启后** pill 消失 ✗。
 *
 * 根因（三处断点，缺一不可）：
 *   ① `ChatMessage`（落盘格式）**没有** `attachments` 字段 ✗；
 *   ② `agentChatService.sendMessage` 持久化用户消息时**不带** `options.attachments` ✗；
 *   ③ `adaptPersistedChatMessage`（历史 → UI）**不回灌** attachments ✗。
 * 外加 ④ `IChatAttachmentSend` 类型没声明 `kind` ⇒ 持久化层不知道该保留它 ✗。
 *
 * 持久化规则：**图片不存**（base64 吹大会话文件 ✗，且没 data 恢复出来也是坏 pill ✗）；
 * 只存文本类附件（片段/日志/文件引用 ✓，含 `kind` ⇒ 恢复后仍是「代码片段」pill ✓）。
 */

const SNIPPET = {
	id: 'att-1',
	type: 'file' as const,
	name: 'code-snippet.txt',
	mimeType: 'text/plain',
	data: 'const a = 1;',
	size: 12,
	isPasted: true,
	kind: 'snippet' as const,
};

suite('附件持久化往返（2026-09-19：重启后片段 pill 不丢）', () => {

	test('★★★ 适配器必须回灌 attachments，且 kind 存活（否则 pill 退化成文件名 ✗）', () => {
		const uiMsg = adaptPersistedChatMessage({
			id: 'm1', role: 'user', content: '', timestamp: new Date().toISOString(),
			attachments: [SNIPPET],
		});
		assert.ok(uiMsg, 'user 消息必须能适配 ✓');
		assert.ok(Array.isArray(uiMsg!.attachments) && uiMsg!.attachments.length === 1, 'attachments 必须回灌 ✗');
		const att = uiMsg!.attachments![0] as any;
		assert.strictEqual(att.kind, 'snippet', 'kind 丢失 ⇒ pill 显示成 code-snippet.txt ✗');
		assert.strictEqual(att.data, 'const a = 1;', '片段内容不能丢 ✓（这是底线 ✓）');
	});

	test('★★ 旧会话（无 attachments 字段）⇒ undefined，不炸（向后兼容 ✓）', () => {
		const uiMsg = adaptPersistedChatMessage({
			id: 'm2', role: 'user', content: '你好', timestamp: new Date().toISOString(),
		});
		assert.ok(uiMsg);
		assert.strictEqual(uiMsg!.attachments, undefined, '无附件字段的旧数据 ⇒ undefined（不是 []、不报错 ✓）');
	});

	test('★★★ 落盘侧：service 必须持久化 attachments 且过滤图片（图片 base64 会吹大会话文件 ✗）', () => {
		const abs = path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts');
		const src = fs.readFileSync(abs, 'utf8');
		assert.ok(src.includes("options.attachments?.filter(a => a.type !== 'image')"),
			'sendMessage 必须以「过滤图片」的方式持久化附件 ✗（图片不落盘是刻意的 ✓）');
		assert.ok(src.includes('attachments: persistableAttachments'),
			'用户消息落盘必须带上 persistableAttachments ✗');
	});

	test('★★ 传输类型必须声明 kind（否则持久化层不知道该保留它 ✗）', () => {
		const abs = path.join(process.cwd(), 'src/vs/sessions/common/agentStudioService.ts');
		const src = fs.readFileSync(abs, 'utf8');
		assert.ok(src.includes("readonly kind?: 'snippet' | 'log';"),
			'IChatAttachmentSend 必须声明 kind（snippet/log ✓）');
	});
});
