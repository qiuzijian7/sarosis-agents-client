/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「需要你操作」通知条的纯逻辑（2026-09-12 用户需求）：
 * 聊天框工作流卡片里需要用户交互的卡要高亮 + 右下角弹通知条。
 *
 * 这里覆盖**最容易出错的两点**：
 *  1. 四类交互的 selector 必须与 agentChat.css 的 `.pending` 选择器一致（否则
 *     「去选择」定位不到卡 ✗）；
 *  2. 各类型「已完成」的取值**不同**（answered / submitted / skipped / cancelled /
 *     expired）—— 判定必须写成「等于 pending」，否则漏一种就会把已处理的卡当成
 *     待办、通知条永不消失 ✗✗。
 */
import assert from 'assert';
import {
	collectPendingInteractions,
	pendingInteractionsSignature,
	pendingNoticeDesc,
	pendingNoticeTitle,
} from '../../../../browser/agentChat/agentChatPanel.pendingNotice.js';

/** 构造一条「含待交互卡」的消息（默认全部 pending）。 */
function msg(over: {
	collectVariables?: Record<string, { id: string; status: string }>;
	askUsers?: Array<{ id: string; status: string }>;
	pickerSelects?: Array<{ id: string; status: string }>;
	nodeInteractions?: Array<{ id: string; status: string; title?: string }>;
} = {}): Parameters<typeof collectPendingInteractions>[0][number] {
	return over;
}

suite('collectPendingInteractions（工作流待交互项收集）', () => {

	test('无消息 / 无待办 → 空', () => {
		assert.deepStrictEqual(collectPendingInteractions([]), []);
		assert.deepStrictEqual(collectPendingInteractions([msg()]), []);
	});

	test('★ 四类 pending 全部收集，且 selector 与 CSS 的 .pending 选择器一致', () => {
		const out = collectPendingInteractions([msg({
			collectVariables: { cv1: { id: 'cv1', status: 'pending' } },
			askUsers: [{ id: 'e1:n1', status: 'pending' }],
			pickerSelects: [{ id: 'e1:n2', status: 'pending' }],
			nodeInteractions: [{ id: 'e1:n3', status: 'pending', title: '静态表情包' }],
		})]);
		assert.strictEqual(out.length, 4);
		assert.deepStrictEqual(out.map(p => p.id), ['cv:cv1', 'ask:e1:n1', 'pick:e1:n2', 'ni:e1:n3']);
		assert.deepStrictEqual(out.map(p => p.selector), [
			'.collect-vars-card.pending',
			'.askuser-card.pending',
			'.picker-card.pending',
			'.ni-card.pending',
		]);
		assert.ok(out[3].label.includes('静态表情包'), out[3].label);
	});

	test('★★ 各类型的「已完成」状态一律不计入（否则通知条永不消失）', () => {
		// AskUser：answered / cancelled / expired；Picker：answered / cancelled；
		// NodeInteraction：submitted / skipped；CollectVars：submitted / skipped。
		const out = collectPendingInteractions([msg({
			collectVariables: {
				a: { id: 'a', status: 'submitted' },
				b: { id: 'b', status: 'skipped' },
			},
			askUsers: [
				{ id: 'a1', status: 'answered' },
				{ id: 'a2', status: 'cancelled' },
				{ id: 'a3', status: 'expired' },
			],
			pickerSelects: [
				{ id: 'p1', status: 'answered' },
				{ id: 'p2', status: 'cancelled' },
			],
			nodeInteractions: [
				{ id: 'n1', status: 'submitted' },
				{ id: 'n2', status: 'skipped' },
			],
		})]);
		assert.deepStrictEqual(out, []);
	});

	test('跨多条消息收集（历史 + 实时）', () => {
		const out = collectPendingInteractions([
			msg({ askUsers: [{ id: 'old', status: 'answered' }] }),
			msg({ pickerSelects: [{ id: 'e2:n1', status: 'pending' }] }),
			msg({ nodeInteractions: [{ id: 'e2:n2', status: 'pending' }] }),
		]);
		assert.deepStrictEqual(out.map(p => p.id), ['pick:e2:n1', 'ni:e2:n2']);
	});

	test('NodeInteraction 缺 title 时标签有兜底（不出现 undefined）', () => {
		const out = collectPendingInteractions([msg({ nodeInteractions: [{ id: 'e:n', status: 'pending' }] })]);
		assert.ok(!out[0].label.includes('undefined'), out[0].label);
	});
});

suite('待办签名 / 文案', () => {

	const mk = (id: string, label = 'L'): { id: string; label: string; selector: string } => ({ id, label, selector: '.x' });

	test('★ 同一集合（顺序不同）→ 同一签名（避免无谓重建通知条）', () => {
		assert.strictEqual(
			pendingInteractionsSignature([mk('a'), mk('b')]),
			pendingInteractionsSignature([mk('b'), mk('a')]),
		);
	});

	test('集合变化 → 签名变化（新待办要重新弹出）', () => {
		assert.notStrictEqual(
			pendingInteractionsSignature([mk('a')]),
			pendingInteractionsSignature([mk('a'), mk('b')]),
		);
	});

	test('标题带项数；描述去重同类标签', () => {
		assert.strictEqual(pendingNoticeTitle(3), '工作流暂停，需要你操作（3 项）');
		assert.strictEqual(
			pendingNoticeDesc([mk('a', '选择图像'), mk('b', '选择图像'), mk('c', '回答问题')]),
			'选择图像 · 回答问题',
		);
	});
});
