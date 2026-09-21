/*---------------------------------------------------------------------------------------------
 *  会话事件流（游标协议，P1-5，2026-09-21）回归测试。
 *
 *  背景：P0-1 把会话历史变成「追加日志 + 快照」✓，但日志只是读取侧内部实现 ——
 *  没有进度（游标 ✓）、无法跨进程跟上、也无法按批次断言增量 ✗。
 *  本模块把日志抽象成**可游标消费的事件流** ✓（`message` / `reset`），
 *  第一个真实消费者 = `npm run session:tail`（headless 跟随 ✓）。
 *
 *  下面钉住的正是三个最容易做错的语义 ✗：
 *    ① 只增量（重复读同一区间不得重复投递）；
 *    ② 压缩安全（日志被"快照+屏障+删除"重写后**行号从头开始** ⇒ 老游标必须触发 reset，
 *       否则消费方会静默停在旧游标上、**永远读不到新内容** ✗✓）；
 *    ③ 半行不越游标（末尾截断的半行若被"消费掉"，补全后那条消息就永久丢了 ✗✓）。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import {
	readSessionEvents,
	foldSessionEvents,
} from '../../common/sessionEventStream.js';
import {
	serializeSessionLogAppends,
	serializeSessionLogBarrier,
	upsertMessageById,
} from '../../common/sessionHistoryLog.js';

import type { ChatMessage } from '../../common/types.js';

function m(id: string, content = 'x'): ChatMessage {
	return { id, role: 'assistant', content, agentSessionId: 'sess-1', timestamp: '' } as ChatMessage;
}

suite('会话事件流（游标协议，P1-5）', () => {

	test('★ 基本：从头读 ⇒ 全是 message 事件，游标落到最后一行', () => {
		const text = serializeSessionLogAppends([m('a'), m('b')]);
		const r = readSessionEvents(text);
		assert.deepStrictEqual(r.events.map(e => [e.seq, e.kind]), [[1, 'message'], [2, 'message']]);
		assert.strictEqual(r.cursor.seq, 2);
		assert.strictEqual(r.tornLines, 0);
	});

	test('★★★ 只增量：带游标读 ⇒ 只返回之后的事件（不重复投递）', () => {
		const text = serializeSessionLogAppends([m('a'), m('b'), m('c')]);
		const first = readSessionEvents(text);
		assert.strictEqual(first.events.length, 3);

		// 用户游标"读到第 2 行" ⇒ 只应拿到第 3 行 ✓
		const second = readSessionEvents(text, { seq: 2 });
		assert.deepStrictEqual(second.events.map(e => e.msg?.id), ['c']);

		// 无新增 ⇒ 空事件 + 游标不动 ✓（幂等：重复读不产生重复 ✓）
		const third = readSessionEvents(text, { seq: first.cursor.seq });
		assert.deepStrictEqual(third.events, []);
		assert.strictEqual(third.cursor.seq, first.cursor.seq);
	});

	test('★ 幂等：同一份文本 + 同一游标 ⇒ 结果完全相同（可安全重试 ✓）', () => {
		const text = serializeSessionLogAppends([m('a'), m('b')]);
		const r1 = readSessionEvents(text, { seq: 0 });
		const r2 = readSessionEvents(text, { seq: 0 });
		assert.deepStrictEqual(r2, r1);
	});

	test('★★ 屏障 ⇒ reset 事件（消费方据此重载快照 ✓）', () => {
		const text =
			serializeSessionLogAppends([m('a')]) +
			serializeSessionLogBarrier() +
			serializeSessionLogAppends([m('b')]);
		const r = readSessionEvents(text);
		assert.deepStrictEqual(r.events.map(e => e.kind), ['message', 'reset', 'message']);
		assert.strictEqual(r.events[1].reason, 'barrier');
	});

	test('★★★ 压缩安全：日志被重写（行数 < 游标）⇒ 必须发 reset，否则永远读不到新内容 ✗', () => {
		// 消费方在"旧日志"上已读到第 8 行 ✓
		const staleCursor = { seq: 8 };
		// 之后发生压缩：快照 + 屏障 + 删除 ⇒ 新日志只有 1 行（行号从 1 重新开始 ✗）
		const compactedText = serializeSessionLogAppends([m('new')]);
		const r = readSessionEvents(compactedText, staleCursor);
		assert.strictEqual(r.events[0].kind, 'reset', '行号重置必须被识别（否则静默停在旧游标 ✗✓）');
		assert.strictEqual(r.events[0].reason, 'log-rewritten');
		assert.deepStrictEqual(
			r.events.filter(e => e.kind === 'message').map(e => e.msg?.id), ['new'],
			'重置后应从头重读 ✓',
		);
	});

	test('★★★ 半行不越游标：末尾截断行补全后仍能读到（否则那条消息永久丢 ✗）', () => {
		const complete = serializeSessionLogAppends([m('a')]);
		const half = '{"op":"a","msg":{"id":"b","content":"半';
		const r1 = readSessionEvents(complete + half);
		assert.deepStrictEqual(r1.events.map(e => e.msg?.id), ['a'], '半行不得投递 ✓');
		assert.strictEqual(r1.tornLines, 1);
		assert.strictEqual(r1.cursor.seq, 1, '★ 游标必须停在半行**之前** ✓（关键 ✗）');

		// 半行被补全（同一次追加重试 / 后续写完 ✓）⇒ 用**同一个游标**必须能拿到 b ✓
		const r2 = readSessionEvents(complete + serializeSessionLogAppends([m('b')]), r1.cursor);
		assert.deepStrictEqual(r2.events.map(e => e.msg?.id), ['b']);
	});

	test('缺 id 的条目：不投递但推进游标（避免每次重读都卡在它上面 ✗）', () => {
		const text = '{"op":"a","msg":{"content":"no id"}}\n' + serializeSessionLogAppends([m('ok')]);
		const r = readSessionEvents(text);
		assert.deepStrictEqual(r.events.map(e => e.msg?.id), ['ok']);
		assert.strictEqual(r.cursor.seq, 2);
	});

	test('未知 op / 空日志：不炸且游标语义正确 ✓', () => {
		assert.deepStrictEqual(readSessionEvents('').events, []);
		assert.strictEqual(readSessionEvents('').cursor.seq, 0);
		const weird = '{"op":"future"}\n{"op":"a","msg":{"id":"z"}}';
		const r = readSessionEvents(weird);
		assert.deepStrictEqual(r.events.map(e => e.msg?.id), ['z']);
	});

	test('★ foldSessionEvents：reset 清空 + message 按 id 归并（消费方免于自行维护状态 ✓）', () => {
		const events = [
			{ seq: 1, kind: 'message' as const, msg: m('a', 'v1') },
			{ seq: 2, kind: 'message' as const, msg: m('b') },
			{ seq: 3, kind: 'reset' as const, reason: 'barrier' as const },
			{ seq: 4, kind: 'message' as const, msg: m('c') },
		];
		const out = foldSessionEvents([m('old')], events, upsertMessageById);
		assert.deepStrictEqual(out.map(x => x.id), ['c'], '屏障后清空 ⇒ 只剩屏障之后的增量 ✓');
	});
});
