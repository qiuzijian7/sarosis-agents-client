/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ★★★ 用户气泡动作按钮（编辑 / 复制 / 回撤）的**挂载门控**回归（2026-09-19）。
 *
 * 用户实测：发送一条**只有代码片段**（无文本 ✓）的消息后，气泡 hover 时**没有**
 * 编辑 / 复制等按钮 ✗。
 *
 * 根因（messages.ts）：`_addMessageActionButtons(bubble, msg)` 此前挂在
 * `if (isUser && msg.content) { … }` 分支**内部** ✗ ⇒ 纯片段 / 纯图片消息
 * （`msg.content` 为空、只有 `msg.attachments` ✓）**永远走不到**那个分支 ⇒ 按钮缺失 ✗。
 *
 * 修法：把挂载**移出门控** —— 「有文本**或**有附件」就挂 ✓。
 * 本文件是**源码结构**断言（messages.ts 深度依赖 DOM，用 jsdom 全量驱动成本过高 ✓）：
 * 锁住「按钮调用不再被 `msg.content` 门控」这条不变量 ✓。
 */

const REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.messages.ts';

const readSrc = (): string => {
	const abs = path.join(process.cwd(), REL);
	assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
};

/** 去掉块注释 ⇒ 只对活代码断言 ✓（注释里会刻意保留旧写法作为教训 ✓）。 */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

suite('用户气泡动作按钮：不被 msg.content 门控（2026-09-19）', () => {

	test('★★★ 必须存在「有文本或有附件就挂」的门控（纯片段气泡也要有按钮 ✓）', () => {
		const src = readSrc();
		assert.ok(
			src.includes('if (isUser && (msg.content || (msg.attachments && msg.attachments.length > 0)))'),
			'缺少「文本或附件」门控 ⇒ 纯片段/纯图片气泡又会没有 编辑/复制 按钮 ✗',
		);
	});

	test('★★★ 旧门控分支内不得再挂按钮（`if (isUser && msg.content)` 块内无 _addMessageActionButtons ✗）', () => {
		const src = stripComments(readSrc());
		const gateIdx = src.indexOf('if (isUser && msg.content) {');
		assert.ok(gateIdx > 0, '定位不到 user 内容分支（结构变了？）');
		// 取该分支到下一个 `else if` 之间的文本
		const nextElse = src.indexOf('} else if', gateIdx);
		assert.ok(nextElse > gateIdx, '定位不到分支结束（结构变了？）');
		const block = src.slice(gateIdx, nextElse);
		assert.ok(
			!block.includes('_addMessageActionButtons'),
			'动作按钮又回到了「有文本」门控内 ⇒ 纯附件气泡的按钮会再次消失 ✗',
		);
	});

	test('★★ 按钮挂载点恰好两处（用户一处 + assistant 回撤一处 ✓）—— 防重复挂载/漏挂', () => {
		const src = stripComments(readSrc());
		const count = src.split('this._addMessageActionButtons(bubble, msg)').length - 1;
		assert.strictEqual(count, 2,
			`_addMessageActionButtons(bubble, msg) 应恰好 2 处（用户 + assistant），实际 ${count} ✗`);
	});
});
