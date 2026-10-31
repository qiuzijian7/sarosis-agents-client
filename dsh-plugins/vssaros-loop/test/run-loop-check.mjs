// 纯判据单测：spec 解析 / ledger 去重与恢复 / 挑单与排期 / 完成契约。
//
// 为什么这一层值得单独钉：这四块是"无人值守"的全部正确性来源。它们错了不会报错，
// 只会表现成"同一个 bug 被修了三次"或"一晚上烧空额度"—— 这两种事故都没法靠读日志发现。
// 跑法：node dsh-plugins/vssaros-loop/test/run-loop-check.mjs（NODE_OPTIONS 里若有
// CodeBuddy 的 --require shim，先清掉，否则 node 的 stdout 会被吞）。

// ⚠ 只在本单测里跨插件 import 内核（生产运行期**不行**：profile 里没有跨包解析路径，
//   运行期必须走 cordis 服务 `vssarosWorkItems`，见 lib/workItemRef.js）。
import { createWorkItemService } from '../../vssaros-workitem/lib/index.js';
import { bindWorkItems } from '../lib/workItemRef.js';

bindWorkItems(createWorkItemService());

import { markBlocked, markDone, markFailed, markRunning, normalizeLedger, recoverOnStart, skipReasonOf, summarizeLedger } from '../lib/core/ledger.js';
import { buildItemPrompt, sessionIdOf } from '../lib/runner.js';
import { identityOf, nextDueAtMs, outcomeOf, parseItemMarker, pickItems, quietDelayMs } from '../lib/core/plan.js';
import { DEFAULTS, describeLoop, normalizeLoop, parseClock, parseDuration, parseQuietHours, parseSchedule, quietHoursContains } from '../lib/core/spec.js';
import { HANDOFF_DEFAULTS, parseHandoff, validateHandoff } from '../lib/core/handoff.js';

let pass = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
	if (cond) {
		pass += 1;
		return;
	}
	failures.push(`${label}${detail ? `　（${detail}）` : ''}`);
};
const eq = (label, actual, expected) => ok(label, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
const throws = (label, fn, matcher) => {
	try {
		fn();
		ok(label, false, '没有抛错');
	} catch (error) {
		ok(label, matcher.test(String(error.message)), String(error.message));
	}
};

// ── spec：duration / clock / schedule ────────────────────────────────────────
eq('duration 30s', parseDuration('30s'), 30);
eq('duration 15m', parseDuration('15m'), 900);
eq('duration 4h', parseDuration('4h'), 14400);
eq('duration 30d', parseDuration('30d'), 2592000);
eq('duration 裸数字按秒', parseDuration('300'), 300);
eq('duration 小数截断', parseDuration('1.5h'), 5400);
throws('duration 非法抛错且报 key', () => parseDuration('abc', 'itemTimeout'), /^itemTimeout: expected a duration/);

eq('clock 02:20', parseClock('02:20'), 140);
throws('clock 越界', () => parseClock('24:00'), /not a valid time/);

eq('schedule every 5m', parseSchedule('every 5m').intervalS, 300);
eq('schedule every 5m 的 text', parseSchedule('every 5m').text, 'every 300s');
throws('schedule 低于地板必须拒绝（不夹紧）', () => parseSchedule('every 1s'), /below the 120s minimum/);
eq('schedule daily 09:30 规范化', parseSchedule('daily 9:30').text, 'daily 09:30');
eq('schedule 空串=manual', parseSchedule('').kind, 'manual');
eq('schedule manual', parseSchedule('manual').kind, 'manual');

const quiet = parseQuietHours('23:00-06:00');
ok('安静时段 23:00-06:00 覆盖 23:30', quietHoursContains(quiet, 23 * 60 + 30));
ok('安静时段 23:00-06:00 覆盖 01:00', quietHoursContains(quiet, 60));
ok('安静时段 23:00-06:00 不覆盖 12:00', !quietHoursContains(quiet, 12 * 60));
eq('安静时段关闭', parseQuietHours('off').active, false);

// ── normalizeLoop：默认值 / 越界 / warnings ─────────────────────────────────
{
	const { spec, warnings } = normalizeLoop('google-digest', { schedule: 'every 5m', work: { prompt: '搜索并总结' }, harvest: { command: 'node harvest.mjs' }, roundCostCeiling: 2 });
	eq('loop 默认 maxItemsPerRound 收紧到 3', spec.maxItemsPerRound, 3);
	eq('loop 默认 itemTimeout 45m', spec.itemTimeoutS, 2700);
	eq('loop 默认 onAsk=block', spec.onAsk, 'block');
	eq('loop identityFields 默认 id', spec.harvest.identityFields, ['id']);
	ok('配置齐全时不产生 warning', warnings.length === 0, warnings.join(' / '));
}
{
	const { warnings } = normalizeLoop('bare', {});
	ok('缺 harvest.command 有 warning', warnings.some(w => w.includes('harvest.command')));
	ok('缺 prompt 有 warning', warnings.some(w => w.includes('work.prompt')));
	ok('manual 有 warning', warnings.some(w => w.includes('manual')));
	ok('成本上限关闭有 warning', warnings.some(w => w.includes('roundCostCeiling')));
}
throws('maxItemsPerRound 越硬上限被拒绝', () => normalizeLoop('x', { maxItemsPerRound: 999 }), /maxItemsPerRound: 999 is out of range/);
throws('itemTurnCap 越硬上限被拒绝', () => normalizeLoop('x', { itemTurnCap: 501 }), /itemTurnCap: 501 is out of range/);
throws('onAsk 非法值被拒绝', () => normalizeLoop('x', { onAsk: 'ignore' }), /onAsk: expected one of/);
throws('loop.json 不是对象被拒绝', () => normalizeLoop('x', []), /expected an object/);
eq('默认值快照未被 normalizeLoop 改写', DEFAULTS.maxItemsPerRound, 3);

// ── ledger：去重 / 退避 / 恢复 ──────────────────────────────────────────────
const spec = normalizeLoop('t', { maxAttempts: 2, retryBackoff: '10m' }).spec;
const T0 = new Date('2026-10-30T10:00:00Z').getTime();
{
	const ledger = { version: 1, items: {} };
	eq('空账本不跳过', skipReasonOf(ledger.items['t/1'], spec, T0), null);
	markDone(ledger, 't/1', {}, T0);
	eq('done 永不再跑', skipReasonOf(ledger.items['t/1'], spec, T0 + 86400_000), 'ledger:done');
	markBlocked(ledger, 't/2', { reason: '要人决定' }, T0);
	ok('blocked 不会被自动重试', String(skipReasonOf(ledger.items['t/2'], spec, T0)).startsWith('ledger:blocked'));
	markFailed(ledger, 't/3', { reason: 'x' }, T0);
	eq('第一次失败 attempts=1', ledger.items['t/3'].attempts, 1);
	ok('退避内跳过', String(skipReasonOf(ledger.items['t/3'], spec, T0 + 60_000)).startsWith('backoff'));
	eq('退避到点可重跑', skipReasonOf(ledger.items['t/3'], spec, T0 + 11 * 60_000), null);
	markFailed(ledger, 't/3', { reason: 'y' }, T0 + 11 * 60_000);
	ok('attempts 用尽后不再跑', String(skipReasonOf(ledger.items['t/3'], spec, T0 + 3600_000)).startsWith('attempts-exhausted'));
	eq('firstSeenAt 不被后续状态覆盖', ledger.items['t/3'].firstSeenAt, new Date(T0).toISOString());
}
{
	const ledger = { version: 1, items: {} };
	markRunning(ledger, 't/9', { sessionId: 'loop:t:abc' }, T0);
	const recovered = recoverOnStart(ledger, T0 + 1000);
	eq('恢复列表含残留 running', recovered, ['t/9']);
	eq('running 归正为 failed', ledger.items['t/9'].status, 'failed');
	eq('恢复时 attempts 累加（不洗白）', ledger.items['t/9'].attempts, 1);
	ok('恢复原因可读', ledger.items['t/9'].lastError.includes('interrupted'));
	eq('计数汇总', summarizeLedger(ledger), { total: 1, done: 0, failed: 1, blocked: 0, running: 0 });
}
{
	const { ledger, warning } = normalizeLedger({ items: { 't/1': { status: 'running' } } });
	ok('半截条目被补齐字段', ledger.items['t/1'].attempts === 0 && ledger.items['t/1'].sessionId === '');
	ok('版本不符会给出 warning', warning !== '');
	const broken = normalizeLedger('not-an-object');
	ok('坏账本重置为空并如实报告', Object.keys(broken.ledger.items).length === 0 && broken.warning.includes('重置'));
}

// ── plan：identity / 挑单 / 排期 ───────────────────────────────────────────
{
	const s = normalizeLoop('tapd', { harvest: { command: 'x' }, work: { prompt: 'y' }, identityFields: ['bugId', 'gameid'] }).spec;
	eq('identity 多字段拼 key', identityOf(s, { bugId: 123, gameid: 'g1' }).key, 'tapd/123/g1');
	ok('identity 缺字段明确报错', !!identityOf(s, { bugId: 123 }).error);
	eq('identity 默认用 id', identityOf(normalizeLoop('a', {}).spec, { id: 'x9' }).key, 'a/x9');
}
{
	const s = normalizeLoop('p', { maxItemsPerRound: 2, maxAttempts: 2, work: { prompt: 'z' } }).spec;
	const ledger = { version: 1, items: {} };
	markDone(ledger, 'p/a', {}, T0);
	const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { notId: 1 }];
	const { picked, excluded, total } = pickItems({ spec: s, rows, ledger, nowMs: T0 });
	eq('候选总数', total, 5);
	eq('每轮上限生效', picked.map(x => x.key), ['p/b', 'p/c']);
	ok('done 的被排除并给出原因', excluded.some(e => e.key === 'p/a' && e.reason === 'ledger:done'));
	ok('超出上限的如实标 round-cap', excluded.some(e => e.key === 'p/d' && e.reason.startsWith('round-cap')));
	ok('无 identity 的行不静默丢弃', excluded.some(e => e.reason.startsWith('no-identity')));
	eq('harvest 非数组时明确报告', pickItems({ spec: s, rows: null, ledger, nowMs: T0 }).excluded[0].reason, 'harvest 返回的不是数组');
}
{
	const every = normalizeLoop('e', { schedule: 'every 30m', work: { prompt: 'p' } }).spec;
	eq('every 从未跑过 ⇒ 立刻到期', nextDueAtMs(every, {}, T0), T0);
	eq('every 从上次开始时间起算', nextDueAtMs(every, { lastRoundStartedAt: new Date(T0).toISOString() }, T0 + 60_000), T0 + 1800_000);
	const manual = normalizeLoop('m', {}).spec;
	eq('manual 永不到期', nextDueAtMs(manual, {}, T0), Infinity);
	// daily：用本地时间构造，避免测试本身依赖时区（CI 与开发机时区可以不同）。
	const midnight = new Date(2026, 9, 30, 0, 0, 0, 0).getTime();
	const daily = normalizeLoop('d', { schedule: 'daily 09:00', work: { prompt: 'p' } }).spec;
	eq('daily 今天还没到 ⇒ 今天 09:00', nextDueAtMs(daily, {}, midnight + 8 * 3600_000), midnight + 9 * 3600_000);
	eq('daily 今天已过且从未跑过 ⇒ 明天（不补跑）', nextDueAtMs(daily, {}, midnight + 10 * 3600_000), midnight + 33 * 3600_000);
	eq('daily 今天已跑过 ⇒ 明天', nextDueAtMs(daily, { lastRoundStartedAt: new Date(midnight + 9 * 3600_000 + 60_000).toISOString() }, midnight + 10 * 3600_000), midnight + 33 * 3600_000);
	const quietSpec = normalizeLoop('q', { quietHours: '23:00-06:00', work: { prompt: 'p' } }).spec;
	ok('安静时段内返回正数等待', quietDelayMs(quietSpec, new Date(2026, 9, 30, 23, 30).getTime()) > 0);
	eq('安静时段外不等待', quietDelayMs(quietSpec, new Date(2026, 9, 30, 12, 0).getTime()), 0);
}

// ── 完成契约 ───────────────────────────────────────────────────────────────
eq('解析 done', parseItemMarker('干完了\n[item:done]').status, 'done');
eq('解析 failed 带原因', parseItemMarker('[item:failed:编译不过]').reason, '编译不过');
ok('没有标记', !parseItemMarker('没有签字').found);
eq('没签字默认算失败（假绿防线）', outcomeOf({ finalText: '没有签字', stopReason: 'completed' }).status, 'failed');
eq('requireMarker=false 才允许算成功', outcomeOf({ finalText: '没有签字', stopReason: 'completed', completion: { requireMarker: false } }).status, 'done');
eq('超时即使有 done 也不认（stopReason 优先于标记前的失败判定）', outcomeOf({ finalText: 'x', stopReason: 'timeout' }).status, 'failed');
eq('blocked 透传原因', outcomeOf({ finalText: '[item:blocked:缺日志]', stopReason: 'completed' }).reason, '缺日志');

// ── prompt 与会话 id ───────────────────────────────────────────────────────
{
	const s = normalizeLoop('w', { work: { prompt: '修 {bug}', taskHeader: '单号 {bug}' }, onAsk: 'assume' }).spec;
	const prompt = buildItemPrompt(s, { bug: '123' }, 'w/123');
	ok('prompt 含 work.prompt', prompt.includes('修 123'));
	ok('prompt 含 taskHeader 变量替换', prompt.includes('单号 123'));
	ok('prompt 带完成契约', prompt.includes('[item:done]'));
	ok('onAsk=assume 时明确告诉模型自己假设', prompt.includes('没人会回答'));
	ok('会话 id 稳定', sessionIdOf('w', 'w/123') === sessionIdOf('w', 'w/123'));
	ok('不同 key 不同会话', sessionIdOf('w', 'w/123') !== sessionIdOf('w', 'w/124'));
	ok('会话 id 短且带 loop 名', sessionIdOf('w', 'w/123').length <= 32 && sessionIdOf('w', 'w/123').startsWith('loop:w:'));
}

// ── 结构化 handoff（2026-10-31，对照官方 @deepseek-ai/dsh-tool-ralph）──────────
// 钉三件事：① 抽得出字段；② 状态语义（done 要 evidence、blocked 要 blocker、不能互相留字段）；
// ③ **超长判失败而不是截断**，且默认不强制（没配置的 loop 与从前逐字一致）。
{
	const good = parseHandoff('正文\n--- handoff ---\nsummary: 修好了\nevidence: 单测通过\nnext: \nblocker: \n--- /handoff ---');
	ok('handoff 抽得出字段', good.found && good.fields.summary === '修好了' && good.fields.evidence === '单测通过');
	ok('done + evidence ⇒ 合格', validateHandoff(good, { status: 'done' }).ok, JSON.stringify(validateHandoff(good, { status: 'done' }).errors));
	ok('没交 handoff ⇒ 不合格', !validateHandoff(parseHandoff('没有'), { status: 'done' }).ok);
	ok('done 缺 evidence ⇒ 不合格', !validateHandoff(parseHandoff('--- handoff ---\nsummary: 好了\n--- /handoff ---'), { status: 'done' }).ok);
	ok('done 却留了 blocker ⇒ 不合格', !validateHandoff(parseHandoff('--- handoff ---\nsummary: 好了\nevidence: e\nblocker: 其实没好\n--- /handoff ---'), { status: 'done' }).ok);
	ok('blocked 有 blocker ⇒ 合格', validateHandoff(parseHandoff('--- handoff ---\nsummary: 卡住\nevidence: 缺日志\nblocker: 缺日志\n--- /handoff ---'), { status: 'blocked' }).ok);
	ok('blocked 缺 blocker ⇒ 不合格', !validateHandoff(parseHandoff('--- handoff ---\nsummary: 卡住\nevidence: x\n--- /handoff ---'), { status: 'blocked' }).ok);
	ok('超长 ⇒ 不合格（不截断）', !validateHandoff(parseHandoff(`--- handoff ---\nsummary: ${'x'.repeat(200)}\nevidence: y\n--- /handoff ---`), { status: 'done', maxChars: 64 }).ok);
	ok('默认上限对齐官方 16384', HANDOFF_DEFAULTS.maxChars === 16384);
	ok('spec 默认不强制', normalizeLoop('h2', {}).spec.handoff.require === false);
	ok('spec 默认上限 16384', normalizeLoop('h2', {}).spec.handoff.maxChars === 16384);
	const required = normalizeLoop('h', { handoff: { require: true } }).spec;
	ok('开了 require 才写进 prompt', buildItemPrompt(required, {}, 'h/1').includes('--- handoff ---'));
	ok('未开 require 不写进 prompt（增量式：与从前逐字一致）', !buildItemPrompt(normalizeLoop('h3', {}).spec, {}, 'h3/1').includes('handoff'));
	ok('prompt 声明"标记是自述，不是独立验收"', buildItemPrompt(normalizeLoop('h4', {}).spec, {}, 'h4/1').includes('不是独立验收'));
	ok('describeLoop 标出自述', describeLoop(required).handoff.selfReported === true);
}

// ── 结果 ───────────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
	console.error(`[loop-check] ✗ ${failures.length}/${total} 项失败`);
	for (const failure of failures) {
		console.error(`  · ${failure}`);
	}
	process.exit(1);
}
console.log(`[loop-check] ✓ ${pass}/${total} 项通过`);
