/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * sessionShadowComparator（B2 读侧对拍器）的行为钉：
 *   1. 全同流 ⇒ ok（长度一致、无 diff）；
 *   2. 分叉 ⇒ 报第一个分叉点（位置 + 两侧条目）；
 *   3. 结构时间线只认 call/result/reminder —— 模型文本差异不构成 diff；
 *   4. 护栏提醒注入点参与比对（system-reminder 出现在哪条结果里）；
 *   5. 坏行/非消息行容差（跳过不误报）。
 */
import assert from 'assert';
import {
	compareShadowJsonl,
	compareTimelines,
	extractTimeline,
	parseShadowJsonl,
} from '../../browser/sessionShadowComparator.js';

/** 造一条 checkpoint 事件（影子日志形状）。 */
function ev(messages: unknown[]): Record<string, unknown> {
	return { seq: 0, ts: 'x', sessionId: 's', kind: 'turn-checkpoint', from: 0, to: messages.length, messages };
}

function assistantCall(id: string, name: string, args: Record<string, unknown>): unknown {
	return { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] };
}

function toolResult(name: string, text: string, ok = true): unknown {
	return { role: 'tool', toolName: name, content: [{ type: 'text', text }], isError: !ok };
}

function toJsonl(events: Record<string, unknown>[]): string {
	return events.map(e => JSON.stringify(e)).join('\n');
}

suite('sessionShadowComparator（B2 读侧对拍）', () => {

	test('全同流 ⇒ ok', () => {
		const a = toJsonl([ev([assistantCall('c1', 'file_read', { path: '/x' }), toolResult('file_read', 'hello')])]);
		const b = toJsonl([ev([assistantCall('c2', 'file_read', { path: '/x' }), toolResult('file_read', 'DIFFERENT TEXT')])]);
		const report = compareShadowJsonl('t', a, b);
		assert.ok(report.ok, `应一致（工具 id 与结果文本差异不构成 diff）：${report.summary}`);
	});

	test('参数不同 ⇒ call 的 argsHash 分叉', () => {
		const a = toJsonl([ev([assistantCall('c1', 'file_read', { path: '/x' })])]);
		const b = toJsonl([ev([assistantCall('c1', 'file_read', { path: '/y' })])]);
		const report = compareShadowJsonl('t', a, b);
		assert.ok(!report.ok);
		assert.strictEqual(report.diffs[0]!.divergence?.index, 0);
		assert.strictEqual(report.diffs[0]!.divergence?.expected?.kind, 'call');
	});

	test('提醒注入点参与比对：一侧有 no-progress 提醒 ⇒ 分叉在 reminder 位', () => {
		const withReminder = toJsonl([ev([
			assistantCall('c1', 'file_read', { path: '/x' }),
			toolResult('file_read', 'same\n<system-reminder>identical result, no progress</system-reminder>'),
			assistantCall('c2', 'file_read', { path: '/x' }),
		])]);
		const without = toJsonl([ev([
			assistantCall('c1', 'file_read', { path: '/x' }),
			toolResult('file_read', 'same'),
			assistantCall('c2', 'file_read', { path: '/x' }),
		])]);
		const report = compareShadowJsonl('t', withReminder, without);
		assert.ok(!report.ok, '一侧注入提醒另一侧没有 ⇒ 必须分叉');
		assert.strictEqual(report.diffs[0]!.divergence?.expected?.kind, 'reminder');
		assert.strictEqual(report.diffs[0]!.divergence?.expected?.detail, 'no-progress');
	});

	test('结果成败翻转 ⇒ result 分叉且 detail 标出 ok/fail', () => {
		const a = toJsonl([ev([toolResult('terminal', 'out', true)])]);
		const b = toJsonl([ev([toolResult('terminal', 'ENOENT', false)])]);
		const report = compareShadowJsonl('t', a, b);
		assert.ok(!report.ok);
		assert.strictEqual(report.diffs[0]!.divergence?.expected?.detail, 'ok');
		assert.strictEqual(report.diffs[0]!.divergence?.actual?.detail, 'fail');
	});

	test('长度不一 ⇒ 分叉在越界位（一侧 (end)）', () => {
		const a = toJsonl([ev([assistantCall('c1', 'file_read', {}), toolResult('file_read', 'x')])]);
		const b = toJsonl([ev([assistantCall('c1', 'file_read', {})])]);
		const report = compareShadowJsonl('t', a, b);
		assert.ok(!report.ok);
		assert.strictEqual(report.diffs[0]!.divergence?.index, 1);
		assert.strictEqual(report.diffs[0]!.divergence?.actual, undefined);
	});

	test('坏行容差 + 纯文本 assistant 消息不产生条目', () => {
		const parsed = parseShadowJsonl('{"seq":1,"messages":[]}\nNOT-JSON\n' + JSON.stringify(ev([{ role: 'assistant', content: [{ type: 'text', text: 'just prose' }] }])));
		assert.strictEqual(parsed.skipped, 1);
		const timeline = extractTimeline(parsed.events);
		assert.strictEqual(timeline.length, 0, '纯文本消息不进结构时间线');
	});

	test('compareTimelines 全同 ⇒ summary 含 OK 与条数', () => {
		const t = [{ kind: 'call' as const, name: 'x', detail: 'h' }, { kind: 'result' as const, name: 'x', detail: 'ok' }];
		const report = compareTimelines('m', t, t);
		assert.ok(report.ok);
		assert.ok(report.summary.includes('OK') && report.summary.includes('2'));
	});
});
