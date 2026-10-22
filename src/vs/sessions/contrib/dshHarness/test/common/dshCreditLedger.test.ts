/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 积分「会话账本」（2026-10-20）：Host 侧归属 + 会话日志 + 投影，取代"广播 + 页面按时间窗猜"。
 *
 * 旧链路的根本缺陷：计费代理不知道响应属于哪个会话 ⇒ 页面只能按时间窗 + 模型名猜 ⇒
 * 两个会话同时用同一模型就算错 / 算重；样本只在内存 ⇒ 重启即丢。
 * 新链路：Host 的 `llm/stream` 知道每次调用的 (会话, provider, model, 起止) ⇒ 精确归属 ⇒
 * `appendPluginRecord` 写进会话日志 ⇒ 投影 `vssaros-credit` 自动推给页面。
 *
 * 三段：
 *  ① 直接加载 `dsh-plugins/vssaros-bridge/lib/credit.js`，驱动真实的匹配与投影逻辑；
 *  ② 页面侧 `ledgerEntryFor` 读投影视图；
 *  ③ 源码契约：各段接线在位（桥分发 / llm/stream / 投影注册 / 主进程转发 / 页面读投影）。
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { DshBridgeMethod } from '../../common/dshBridgeProtocol.js';
// @ts-ignore —— 插件是纯 JS（ESM），esbuild 打包测试时一并转成 CJS
import * as credit from '../../../../../../../dsh-plugins/vssaros-bridge/lib/credit.js';

const c = credit as any;

function read(rel: string): string {
	const abs = join(process.cwd(), rel);
	assert.ok(existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return readFileSync(abs, 'utf8');
}

/** 可控时钟 + 记录 append 调用的账本。 */
function ledger(opts: { turns?: Record<string, number | null | undefined>; appendOk?: boolean } = {}) {
	let t = 1_000_000;
	const appended: Array<{ sessionId: string; data: any }> = [];
	const logs: string[] = [];
	const l = c.createCreditLedger({
		now: () => t,
		turnOf: (id: string) => (opts.turns && id in opts.turns ? opts.turns[id] : 1),
		append: (sessionId: string, data: any) => {
			appended.push({ sessionId, data });
			return opts.appendOk !== false;
		},
		log: (line: string) => logs.push(line),
	});
	return { l, appended, logs, advance: (ms: number) => { t += ms; }, now: () => t };
}

/** 把一串事件 fold 进投影，返回最终状态。 */
function fold(events: any[]) {
	const p = c.creditProjection();
	let s = p.init();
	for (const e of events) { s = p.apply(s, e); }
	return { state: s, view: p.wire.view(s), p };
}
const rec = (data: any, seq = 0) => ({ type: c.CREDIT_RECORD_TYPE, ignorable: true, seq, data });

suite('积分会话账本（Host 侧归属 + 投影）', () => {

	suite('① 匹配：样本 → (会话, 回合)', () => {
		test('★ 两个会话并发、模型不同 ⇒ 各归各的（旧链路这里会两边都算）', () => {
			const { l, appended, now } = ledger({ turns: { A: 3, B: 7 } });
			const a = l.beginCall({ sessionId: 'A', provider: 'vssaros-codebuddy', model: 'deepseek-v4-flash' });
			const b = l.beginCall({ sessionId: 'B', provider: 'vssaros-codebuddy', model: 'hy4-preview' });
			a.end(); b.end();
			const ra = l.recordSample({ route: 'vssaros-codebuddy', model: 'deepseek-v4-flash-ioa', credit: 0.15, at: now() });
			const rb = l.recordSample({ route: 'vssaros-codebuddy', model: 'hy4-preview-ioa', credit: 2, at: now() });
			assert.deepStrictEqual([ra.sessionId, ra.turn, ra.ambiguous], ['A', 3, false]);
			assert.deepStrictEqual([rb.sessionId, rb.turn, rb.ambiguous], ['B', 7, false]);
			assert.deepStrictEqual(appended.map(x => [x.sessionId, x.data.turn, x.data.credit]), [['A', 3, 0.15], ['B', 7, 2]]);
		});

		test('同模型并发 ⇒ 每次调用只配一个样本（先配没配过的），并如实标 ambiguous', () => {
			const { l, advance, now } = ledger({ turns: { A: 1, B: 1 } });
			const a = l.beginCall({ sessionId: 'A', provider: 'r', model: 'm' });
			const b = l.beginCall({ sessionId: 'B', provider: 'r', model: 'm' });
			advance(100); a.end();
			const r1 = l.recordSample({ route: 'r', model: 'm', credit: 1, at: now() });
			advance(400); b.end();
			const r2 = l.recordSample({ route: 'r', model: 'm', credit: 2, at: now() });
			assert.strictEqual(r1.sessionId, 'A', '离结束最近的是 A');
			assert.strictEqual(r2.sessionId, 'B', 'A 已配过样本 ⇒ 第二个样本归 B，而不是又算给 A');
			assert.strictEqual(r1.ambiguous, true, '同一时刻两个会话都可能 ⇒ 如实标出来');
		});

		test('样本先到、调用还没结束（流还在读尾巴）⇒ 仍能归属', () => {
			const { l, now } = ledger();
			const h = l.beginCall({ sessionId: 'S', provider: 'r', model: 'm' });
			const r = l.recordSample({ route: 'r', model: 'm', credit: 1, at: now() });
			assert.strictEqual(r.matched, true);
			h.end();
		});

		test('★ 样本晚于调用结束 1~4s 才到（桥排队 / 代理读尾巴）⇒ 仍归属；超过 5s 余量才不认', () => {
			// 2026-10-20：pi-ai 读完即断开，Host 的 llm/stream 结束几乎与代理记样本同时；
			// 但样本要经 主进程 → 桥 才到账本，偶有几百 ms 到几秒的延迟。
			const { l, appended, advance, now } = ledger({ turns: { S: 4 } });
			l.beginCall({ sessionId: 'S', provider: 'vssaros-codebuddy', model: 'deepseek-v4-flash-ioa' }).end();
			const endAt = now();
			advance(3_000);
			const r = l.recordSample({ route: 'vssaros-codebuddy', model: 'deepseek-v4-flash-ioa', credit: 0.15, at: endAt + 400 });
			assert.deepStrictEqual([r.matched, r.sessionId, r.turn], [true, 'S', 4]);
			assert.strictEqual(appended[0].data.credit, 0.15);
			const late = l.recordSample({ route: 'vssaros-codebuddy', model: 'deepseek-v4-flash-ioa', credit: 9, at: endAt + 6_000 });
			assert.strictEqual(late.matched, false, '超出余量：宁可不记，也不记错');
		});

		test('route 不同 / 模型不同族 / 时间远在区间外 ⇒ 不归属（宁可不记，也不记错）', () => {
			const { l, advance, now } = ledger();
			const h = l.beginCall({ sessionId: 'S', provider: 'vssaros-codebuddy', model: 'deepseek-v4' });
			h.end();
			assert.strictEqual(l.recordSample({ route: 'vssaros-ollama', model: 'deepseek-v4', at: now() }).matched, false);
			assert.strictEqual(l.recordSample({ route: 'vssaros-codebuddy', model: 'other-model', at: now() }).matched, false);
			advance(60_000);
			assert.strictEqual(l.recordSample({ route: 'vssaros-codebuddy', model: 'deepseek-v4', at: now() }).matched, false);
		});

		test('没有 sessionId 的调用（手工一次性调用）不记账', () => {
			const { l } = ledger();
			assert.strictEqual(l.beginCall({ provider: 'r', model: 'm' }), undefined);
		});

		test('匹配不上先挂起；对应调用后来结束时补上（不丢）', () => {
			const { l, appended, now } = ledger();
			// 样本的时间点落在一次"还没开始记账"的调用里是不可能的；这里模拟"样本 at 早于记录到的 start 很多"
			// 之后来了一个能覆盖它的调用（极端排队）——挂起的样本在 end() 时重试。
			const r = l.recordSample({ route: 'r', model: 'm', credit: 1, at: now() + 500 });
			assert.deepStrictEqual([r.matched, r.pending], [false, true]);
			const h = l.beginCall({ sessionId: 'S', provider: 'r', model: 'm' });
			h.end();
			assert.strictEqual(appended.length, 1, 'end() 时重试挂起样本');
		});

		test('写不进会话日志（Host 过旧 / 会话已不活跃）⇒ matched 但 appended=false', () => {
			const { l, now } = ledger({ appendOk: false });
			l.beginCall({ sessionId: 'S', provider: 'r', model: 'm' }).end();
			const r = l.recordSample({ route: 'r', model: 'm', credit: 1, at: now() });
			assert.deepStrictEqual([r.matched, r.appended], [true, false]);
		});

		test('回合外的调用（turnOf=null）⇒ 记录里 turn:null；读不到回合（undefined）⇒ 记录里不写 turn', () => {
			const { l, appended, now } = ledger({ turns: { OUT: null, UNK: undefined } });
			l.beginCall({ sessionId: 'OUT', provider: 'r', model: 'a', purpose: 'session-title' }).end();
			l.recordSample({ route: 'r', model: 'a', at: now() });
			l.beginCall({ sessionId: 'UNK', provider: 'r', model: 'b' }).end();
			l.recordSample({ route: 'r', model: 'b', at: now() });
			assert.strictEqual(appended[0].data.turn, null);
			assert.strictEqual(appended[0].data.purpose, 'session-title');
			assert.ok(!('turn' in appended[1].data), '读不到 ⇒ 不写字段（投影回落 lastTurn）');
		});

		test('脏样本直接拒（一个 NaN 就能把整轮积分算成 null）', () => {
			const { l } = ledger();
			assert.strictEqual(l.recordSample({ route: 'r', at: NaN }).matched, false);
			assert.strictEqual(l.recordSample({ at: 1 }).matched, false);
			assert.strictEqual(l.recordSample(null).matched, false);
		});
	});

	suite('② 投影：会话日志 → 每回合积分', () => {
		test('按记录里的 turn 汇总；多条累加且无浮点尾巴', () => {
			const { view } = fold([
				{ type: 'turn/start', seq: 0, data: { turn: 1 } },
				rec({ turn: 1, credit: 0.15 }, 1),
				rec({ turn: 1, credit: 0.15 }, 2),
				{ type: 'turn/start', seq: 3, data: { turn: 2 } },
				rec({ turn: 2, credit: 1.5 }, 4),
			]);
			assert.deepStrictEqual(view.byTurn, { 1: { credit: 0.3, responses: 2 }, 2: { credit: 1.5, responses: 1 } });
		});

		test('记录没带 turn ⇒ 归最近一次 turn/start；turn:null ⇒ 记 outside（不污染任何回合）', () => {
			const { view } = fold([
				{ type: 'turn/start', seq: 0, data: { turn: 4 } },
				rec({ credit: 1 }, 1),
				rec({ turn: null, credit: 9 }, 2),
			]);
			assert.deepStrictEqual(view.byTurn, { 4: { credit: 1, responses: 1 } });
			assert.deepStrictEqual(view.outside, { credit: 9, responses: 1 });
		});

		test('响应都没带 credit ⇒ credit 保持 null（页面显示「—」而不是「0」）', () => {
			const { view } = fold([rec({ turn: 1 }), rec({ turn: 1 })]);
			assert.deepStrictEqual(view.byTurn, { 1: { credit: null, responses: 2 } });
		});

		test('只认官方插件记录：同名但没有 ignorable 的事件不算；无关事件返回同一引用', () => {
			const p = c.creditProjection();
			const s0 = p.init();
			assert.strictEqual(p.apply(s0, { type: c.CREDIT_RECORD_TYPE, seq: 0, data: { turn: 1, credit: 5 } }), s0);
			assert.strictEqual(p.apply(s0, { type: 'assistant/message', seq: 0, data: {} }), s0, 'dsh 靠 Object.is 抑制下游发布');
		});

		test('投影 key / 记录类型是官方语法；带 wire（否则页面拿不到）', () => {
			const p = c.creditProjection();
			assert.strictEqual(p.key, 'vssaros-credit');
			assert.match(c.CREDIT_RECORD_TYPE, /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u);
			assert.ok(p.wire && typeof p.wire.view === 'function' && typeof p.wire.viewSchema.parse === 'function');
			assert.ok(Number.isSafeInteger(p.stateVersion) && p.stateVersion >= 0);
		});

		test('observeStream：流读完 / 读到一半被取消，都会 end()（否则调用永远"未结束"）', async () => {
			let ended = 0;
			const handle = { end: () => { ended++; } };
			async function* inner() { yield 1; yield 2; yield 3; }
			for await (const _ of c.observeStream(inner(), handle)) { /* 读完 */ }
			const it = c.observeStream(inner(), handle)[Symbol.asyncIterator]();
			await it.next();
			await it.return(undefined);
			assert.strictEqual(ended, 2);
		});
	});

	suite('③ 接线契约', () => {
		const BRIDGE = 'dsh-plugins/vssaros-bridge/lib/index.js';
		const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
		const USAGE = 'dsh-plugins/vssaros-chat-surface/lib/client.usage.js';

		test('桥：分发 credit.record、监听 llm/stream、注册投影、从 Host 入口取 appendPluginRecord', () => {
			const src = read(BRIDGE);
			assert.strictEqual(DshBridgeMethod.CreditRecord, 'credit.record');
			assert.match(src, /case 'credit\.record':/);
			assert.match(src, /ctx\.on\('llm\/stream'/, '必须挂在根 ctx 上（收得到全部会话的调用）');
			assert.match(src, /sessionProjections\.register\(creditProjection\(\)\)/);
			assert.match(src, /createRequire\(entry\)\.resolve\('@deepseek-ai\/dsh-session'\)/,
				'只能从运行中的 Host 入口解析（拿到同一模块实例）—— 不能静态 import');
			assert.doesNotMatch(src, /^import .* from '@deepseek-ai\//m, '仍然不许静态 import @deepseek-ai/*');
			assert.doesNotMatch(src, /session\.append\(\s*CREDIT_RECORD_TYPE/, '绝不能用 session.append 写自定义类型（重载时整条会话打不开）');
		});

		test('桥打包清单包含 credit.js（否则装到 profile 里就缺文件）', () => {
			const pkg = JSON.parse(read('dsh-plugins/vssaros-bridge/package.json'));
			assert.ok(pkg.files.includes('lib/credit.js'));
		});

		test('主进程：样本转给 Host（新链路），旧广播保留作兜底', () => {
			const src = read(CHANNEL);
			assert.match(src, /DshBridgeMethod\.CreditRecord/);
			assert.match(src, /this\._views\.pushCredit\(payload\)/);
		});

		test('页面：优先读投影，key 与 Host 侧字面一致', () => {
			const src = read(USAGE);
			assert.match(src, /props\.useProjection\(CREDIT_PROJECTION_KEY\)/);
			assert.match(src, /const CREDIT_PROJECTION_KEY = "vssaros-credit";/);
			assert.strictEqual(c.CREDIT_PROJECTION_KEY, 'vssaros-credit');
			assert.match(src, /ledgerEntry \? ledgerEntry\.credit :/, '账本有该回合时必须用账本值（不能再被时间窗估算覆盖）');
		});
	});
});
