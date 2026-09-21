/*---------------------------------------------------------------------------------------------
 *  会话只读跟随器（P1-5 收尾，2026-09-21）回归测试。
 *
 *  被测对象补的洞：多开实例里**只读侧不会活更新** ✗（对端写入要等手动重开才可见 ✓）。
 *  做法 = 用 P1-5 的游标协议轮询 ✓ + 有新事件才回调 ✓（⇒ 天然不产生"轮询闪烁" ✓）。
 *
 *  本文件钉住四条**抗脆弱设计** ✓（它们才是跟随器好不好用的关键 ✗）：
 *    ① 链式 setTimeout 而非 setInterval ⇒ 慢读**绝不叠加** ✗（setInterval 会堆在途请求 ✗）；
 *    ② 读失败**不退出** ✓（退避重试，成功即复位）—— 跟随器死于一次 IO 抖动是最糟的失败模式 ✗；
 *    ③ dispose 幂等 + 停止后不再触碰 reader ✓；
 *    ④ 只投递**增量** ✓（reset 走 `onReset` ✓；重复轮询不重复投递 ✗）。
 *
 *  用真实计时器 + **限期等待** ✓（不用固定 sleep ✗ ⇒ 不 flaky ✓）。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { SessionFollower } from '../../browser/sessionFollower.js';

import type { IReadSessionEventsResult, ISessionEvent, ISessionEventCursor } from '../../common/sessionEventStream.js';
import type { ChatMessage } from '../../common/types.js';

function msg(id: string): ChatMessage {
	return { id, role: 'assistant', content: `c-${id}`, timestamp: '' } as ChatMessage;
}

/** 假 reader：脚本化返回队列；可施加延迟 / 抛错 / 记录并发度 ✓。 */
class FakeReader {
	readonly calls: ISessionEventCursor[] = [];
	active = 0;
	maxActive = 0;
	private _queue: (IReadSessionEventsResult | Error)[] = [];
	constructor(private readonly _delayMs = 0) { }

	push(result: IReadSessionEventsResult | Error): void { this._queue.push(result); }

	async readSessionEvents(_agentId: string, _sessionId: string, cursor?: ISessionEventCursor): Promise<IReadSessionEventsResult> {
		this.calls.push(cursor ?? { seq: 0 });
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			if (this._delayMs > 0) { await new Promise(r => setTimeout(r, this._delayMs)); }
			const next = this._queue.shift();
			if (!next) { return { events: [], cursor: cursor ?? { seq: 0 }, tornLines: 0, totalLines: 0 }; }
			if (next instanceof Error) { throw next; }
			return next;
		} finally {
			this.active--;
		}
	}
}

const events = (list: ISessionEvent[], seq: number): IReadSessionEventsResult => ({ events: list, cursor: { seq }, tornLines: 0, totalLines: seq });

async function waitFor(predicate: () => boolean, deadlineMs: number, what: string): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < deadlineMs) {
		if (predicate()) { return; }
		await new Promise(r => setTimeout(r, 10));
	}
	assert.ok(predicate(), `等待超时（${deadlineMs}ms）：${what}`);
}

function makeFollower(reader: FakeReader, pollMs = 30) {
	const seen: ISessionEvent[] = [];
	const resets: number[] = [];
	const warns: string[] = [];
	const follower = new SessionFollower({
		reader, agentId: 'a1', sessionId: 's1', pollMs,
		onEvent: e => seen.push(e),
		onReset: () => resets.push(Date.now()),
		logService: { warn: m => warns.push(m) },
	});
	return { follower, seen, resets, warns };
}

suite('会话只读跟随器（P1-5 收尾）', () => {

	test('★★★ 只投递增量：message 走 onEvent、reset 走 onReset，且游标只前进（不重复投递 ✗）', async () => {
		const reader = new FakeReader();
		reader.push(events([{ seq: 1, kind: 'message', msg: msg('m1') }], 1));
		reader.push(events([{ seq: 2, kind: 'message', msg: msg('m2') }, { seq: 3, kind: 'reset', reason: 'barrier' }], 3));
		const { follower, seen, resets } = makeFollower(reader);
		follower.start();
		try {
			await waitFor(() => seen.length >= 2 && resets.length >= 1, 3000, '两次轮询的事件都应被投递 ✓');
			assert.deepStrictEqual(seen.map(e => e.msg?.id), ['m1', 'm2']);
			assert.strictEqual(resets.length, 1, 'reset 只走 onReset ✓');
			assert.strictEqual(follower.cursor.seq, 3, '游标必须前进到最新 ✓');
			// 之后的轮询必须带上已前进的游标 ✓（否则重复投递 ✗）
			await waitFor(() => reader.calls.length >= 3, 3000, '应继续轮询 ✓');
			assert.ok(reader.calls.slice(1).every(c => c.seq >= 1), `后续轮询必须带前进后的游标 ✗：${JSON.stringify(reader.calls)}`);
			assert.strictEqual(seen.length, 2, '无新事件时**不得**重复回调 ✗');
		} finally { follower.dispose(); }
	});

	test('★★★ 慢读**绝不叠加**（链式 setTimeout ⇒ 在途读恒 ≤ 1）', async () => {
		// 读耗时 60ms，轮询 20ms：若用 setInterval 会并发堆叠 ⇒ maxActive > 1 ✗✓
		const reader = new FakeReader(60);
		const { follower } = makeFollower(reader, 20);
		follower.start();
		try {
			await waitFor(() => reader.calls.length >= 3, 3000, '慢读也应持续推进 ✓');
			assert.strictEqual(reader.maxActive, 1, `并发读必须 ≤ 1（实际 ${reader.maxActive} ✗）`);
		} finally { follower.dispose(); }
	});

	test('★★★ 读失败**不退出**：退避重试，恢复后照常投递（跟随器死于 IO 抖动是最糟失败模式 ✗）', async () => {
		const reader = new FakeReader();
		reader.push(new Error('boom-1'));
		reader.push(new Error('boom-2'));
		reader.push(events([{ seq: 1, kind: 'message', msg: msg('ok') }], 1));
		const { follower, seen, warns } = makeFollower(reader, 15);
		follower.start();
		try {
			await waitFor(() => seen.length >= 1, 4000, '失败两次后必须仍能恢复并投递 ✓');
			assert.ok(warns.length >= 2, `每次失败都应有告警（实际 ${warns.length} ✗）`);
			assert.ok(follower.running, '失败不得让它退出 ✗');
		} finally { follower.dispose(); }
	});

	test('★★ dispose 幂等 + 停止后不再触碰 reader', async () => {
		const reader = new FakeReader();
		reader.push(events([{ seq: 1, kind: 'message', msg: msg('m1') }], 1));
		const { follower, seen } = makeFollower(reader, 15);
		follower.start();
		await waitFor(() => seen.length >= 1, 3000, '先正常跟随一次 ✓');
		follower.dispose();
		follower.dispose(); // 幂等 ✓（pane 可能重复 stop/dispose ✓）
		const callsAfterDispose = reader.calls.length;
		await new Promise(r => setTimeout(r, 120));
		assert.strictEqual(reader.calls.length, callsAfterDispose, 'dispose 后不得再读（否则就是泄漏的轮询器 ✗✓）');
		assert.strictEqual(follower.running, false);
	});

	test('★ stop/start 语义：stop 后可再 start，running 如实反映', async () => {
		const reader = new FakeReader();
		const { follower, seen } = makeFollower(reader, 15);
		assert.strictEqual(follower.running, false, '未 start 时 running=false ✓');
		follower.start();
		assert.strictEqual(follower.running, true);
		reader.push(events([{ seq: 1, kind: 'message', msg: msg('m1') }], 1));
		await waitFor(() => seen.length >= 1, 3000, 'start 后应开始读 ✓');
		follower.stop();
		assert.strictEqual(follower.running, false);
		const callsAfterStop = reader.calls.length;
		await new Promise(r => setTimeout(r, 120));
		assert.strictEqual(reader.calls.length, callsAfterStop, 'stop 后不得继续读 ✗');
		follower.dispose();
	});
});

// ─── pane 接线防脱（UI 钩子没有单测 ⇒ 至少钉住"钩子 / 门控 / 释放"三件事 ✓）──────────
//
// 这三条都对应**真实会发生的退化** ✗：
//   · 漏一个 `_syncReadOnlyFollower()` 调用点 ⇒ 某条路径下要么永不跟随、要么轮询器泄漏 ✗；
//   · 去掉只读门控 ⇒ 正常单窗口也开始轮询磁盘（无谓 IO ✗✓）；
//   · 丢掉 `_register(follower)` ⇒ pane 关闭后轮询器继续跑（泄漏 ✗）。
suite('只读跟随的 pane 接线（防脱）', () => {

	const PANE_REL = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';
	const paneSrc = (): string => {
		const abs = path.join(process.cwd(), PANE_REL);
		assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};

	test('★★★ 三个只读态落点都必须对齐跟随器（两个 early-return + 末尾 ✓）', () => {
		const calls = paneSrc().split('this._syncReadOnlyFollower();').length - 1;
		assert.ok(calls >= 3, `调用点不足（实际 ${calls}，期望 ≥3 ✗）—— 漏掉的路径正是"永不跟随/泄漏轮询器"的来源 ✗`);
	});

	test('★★★ 启动必须由**只读态**门控（否则正常单窗口也轮询磁盘 ✗）', () => {
		assert.ok(/const shouldFollow = this\._sessionReadOnly && !!agentId && !!sessionId;/.test(paneSrc()),
			'启动条件必须包含 `this._sessionReadOnly` ✓（风险面收窄到双开场景 ✓）');
	});

	test('★★ 跟随器必须登记到 pane 生命周期（否则 pane 关闭后轮询器泄漏 ✗）', () => {
		assert.ok(paneSrc().includes('this._register(follower)'),
			'必须 `_register(follower)` ✓（dispose 幂等由 SessionFollower 保证 ✓）');
	});

	test('★ 重载必须**合并**（流式期不能堆一串 getHistory ✗）', () => {
		assert.ok(paneSrc().includes('_followerReloadInFlight'),
			'必须有在途合并标志 ✓');
	});
});
