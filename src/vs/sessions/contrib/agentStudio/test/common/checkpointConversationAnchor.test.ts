/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	earliestCheckpointTime,
	findConversationKeepIndex,
} from '../../common/checkpointConversationAnchor.js';

const BASE = 1_700_000_000_000;
/** 相对 BASE 的第 n 秒（ISO 字符串，与 ChatMessage.timestamp 同形）。 */
const T = (n: number) => new Date(BASE + n * 1000).toISOString();
/** 构造消息列表。 */
const msgs = (...isoTimes: string[]) => isoTimes.map(t => ({ timestamp: t }));

suite('checkpointConversationAnchor — 只回退对话的锚点计算（2026-09-12，P1-1）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── findConversationKeepIndex ───────────────────────────────────────────

	test('★ 全部消息早于锚点 → 保留最后一条', () => {
		assert.strictEqual(findConversationKeepIndex(msgs(T(0), T(1), T(2)), BASE + 10_000), 2);
	});

	test('★ 部分消息早于锚点 → 保留最后一条早于锚点的', () => {
		// 锚点 = T(3)；T(4)/T(5) 晚于锚点（本轮产生的消息）→ 保留到下标 2
		assert.strictEqual(findConversationKeepIndex(msgs(T(0), T(1), T(2), T(4), T(5)), BASE + 3_000), 2);
	});

	test('★ 没有任何消息早于锚点 → -1（调用方应拒绝截断，绝不误清空会话）', () => {
		assert.strictEqual(findConversationKeepIndex(msgs(T(1), T(2)), BASE), -1);
	});

	test('空历史 → -1', () => {
		assert.strictEqual(findConversationKeepIndex([], BASE), -1);
	});

	test('★ 时间戳非法 → 停止扫描（保守：不把未知消息判为可保留）', () => {
		assert.strictEqual(findConversationKeepIndex(msgs(T(0), 'not-a-date', T(1)), BASE + 10_000), 0);
	});

	test('★ 恰好等于锚点时间 → 不算「早于」（判定用 < 而非 <=）', () => {
		assert.strictEqual(findConversationKeepIndex(msgs(T(0), T(1), T(2)), BASE + 1_000), 0);
	});

	// ─── earliestCheckpointTime ──────────────────────────────────────────────

	test('★ 取最早的非 ghost 检查点（ghost 不参与）', () => {
		assert.strictEqual(earliestCheckpointTime([
			{ createdAt: 300, isGhost: false },
			{ createdAt: 100, isGhost: false },
			{ createdAt: 50, isGhost: true },
		]), 100);
	});

	test('全部 ghost / 空列表 → undefined（调用方应放弃操作）', () => {
		assert.strictEqual(earliestCheckpointTime([]), undefined);
		assert.strictEqual(earliestCheckpointTime([{ createdAt: 1, isGhost: true }]), undefined);
	});
});
