// work item 内核的纯判据单测（loop 与群聊共用这一份判据 ⇒ 这里错了两边一起错）。
//
// 跑法：node dsh-plugins/vssaros-workitem/test/run-workitem-check.mjs
// ⚠ NODE_OPTIONS 里若有 CodeBuddy 的 --require shim，先清掉（否则 node 的 stdout 会被吞）。

import { BUDGET_DEFAULTS, budgetVerdict, pruneEvents } from '../lib/core/budget.js';
import {
	createLedger, markBlocked, markDone, markFailed, markRunning,
	normalizeLedger, recoverOnStart, skipReasonOf, summarizeLedger,
} from '../lib/core/ledger.js';
import { outcomeOf, parseItemMarker, pickItems } from '../lib/core/pick.js';
import { isSystemMessage, notifyPayload, renderNotify } from '../lib/core/systemMessage.js';
import { describeTaskTags, hasTaskTag, normalizeTaskKey, parseTaskTags } from '../lib/core/taskTag.js';

let pass = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
	if (cond) { pass += 1; return; }
	failures.push(`${label}${detail ? `　（${detail}）` : ''}`);
};
const eq = (label, actual, expected) => ok(label, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

const T0 = new Date('2026-10-31T10:00:00Z').getTime();
const policy = { maxAttempts: 2, retryBackoffS: 600, maxItemsPerRound: 2 };

// ── 账本：去重 / 退避 / 恢复 ────────────────────────────────────────────────
{
	const ledger = createLedger();
	eq('空账本不跳过', skipReasonOf(ledger.items['x/1'], policy, T0), null);
	markDone(ledger, 'x/1', { source: 'loop' }, T0);
	eq('done 永不再做', skipReasonOf(ledger.items['x/1'], policy, T0 + 86400_000), 'ledger:done');
	markBlocked(ledger, 'x/2', { reason: '要人决定', source: 'group' }, T0);
	ok('blocked 不自动重试', String(skipReasonOf(ledger.items['x/2'], policy, T0)).startsWith('ledger:blocked'));
	eq('来源字段落账', ledger.items['x/2'].source, 'group');
	markFailed(ledger, 'x/3', { reason: 'x' }, T0);
	eq('第一次失败 attempts=1', ledger.items['x/3'].attempts, 1);
	ok('退避内跳过', String(skipReasonOf(ledger.items['x/3'], policy, T0 + 60_000)).startsWith('backoff'));
	eq('退避到点可重试', skipReasonOf(ledger.items['x/3'], policy, T0 + 11 * 60_000), null);
	markFailed(ledger, 'x/3', { reason: 'y' }, T0 + 11 * 60_000);
	ok('attempts 用尽', String(skipReasonOf(ledger.items['x/3'], policy, T0 + 3600_000)).startsWith('attempts-exhausted'));
	eq('firstSeenAt 不被覆盖', ledger.items['x/3'].firstSeenAt, new Date(T0).toISOString());
	eq('计数汇总', summarizeLedger(ledger), { total: 3, done: 1, failed: 1, blocked: 1, running: 0 });
}
{
	const ledger = createLedger();
	markRunning(ledger, 'x/9', { sessionId: 's1' }, T0);
	eq('恢复列表', recoverOnStart(ledger, T0 + 1000), ['x/9']);
	eq('running 归正为 failed', ledger.items['x/9'].status, 'failed');
	eq('恢复保留 attempts', ledger.items['x/9'].attempts, 1);
	ok('恢复原因可读', ledger.items['x/9'].lastError.includes('interrupted'));
}
{
	const { ledger, warning } = normalizeLedger({ items: { 'x/1': { status: 'running' } } });
	ok('半截条目补齐', ledger.items['x/1'].attempts === 0 && ledger.items['x/1'].source === '');
	ok('版本不符给 warning', warning !== '');
	const broken = normalizeLedger('not-an-object');
	ok('坏账本重置并如实报告', Object.keys(broken.ledger.items).length === 0 && broken.warning.includes('重置'));
}

// ── 挑活（keyOf 由调用方注入 ⇒ loop 与群聊各给各的）──────────────────────
{
	// 群聊形态：key 直接来自 #task 标签
	// 第 5 条有 key 但超出本轮上限 ⇒ 必须如实标 round-cap（无 key 的那条走 no-identity，两者不同源）
	const rows = [{ key: 'bug/1' }, { key: 'bug/2' }, { key: 'bug/3' }, { text: '没有标签' }, { key: 'bug/4' }];
	const ledger = createLedger();
	markDone(ledger, 'bug/1', {}, T0);
	const { picked, excluded, total } = pickItems({ rows, keyOf: r => r.key, ledger, policy, nowMs: T0 });
	eq('候选总数', total, 5);
	eq('本轮上限生效', picked.map(p => p.key), ['bug/2', 'bug/3']);
	ok('done 被排除', excluded.some(e => e.key === 'bug/1' && e.reason === 'ledger:done'));
	ok('超出上限标 round-cap', excluded.some(e => e.reason.startsWith('round-cap')));
	ok('无 key 的行不静默丢弃', excluded.some(e => e.reason.startsWith('no-identity')));
	eq('非数组明确报告', pickItems({ rows: null, keyOf: r => r.key, ledger, policy, nowMs: T0 }).excluded[0].reason, '候选不是数组');
}

// ── 完成契约 ───────────────────────────────────────────────────────────────
eq('解析 done', parseItemMarker('干完了\n[item:done]').status, 'done');
eq('解析 failed 带原因', parseItemMarker('[item:failed:编译不过]').reason, '编译不过');
ok('无标记', !parseItemMarker('没签字').found);
eq('没签字默认算失败', outcomeOf({ finalText: '没签字', stopReason: 'completed' }).status, 'failed');
eq('requireMarker=false 才算成功', outcomeOf({ finalText: '没签字', stopReason: 'completed', completion: { requireMarker: false } }).status, 'done');
eq('超时不算 done', outcomeOf({ finalText: 'x', stopReason: 'timeout' }).status, 'failed');
eq('blocked 透传原因', outcomeOf({ finalText: '[item:blocked:缺日志]', stopReason: 'completed' }).reason, '缺日志');

// ── #task 标签（用户拍板：显式）───────────────────────────────────────────
{
	eq('单标签', parseTaskTags('帮我看下 #task:bug/1234 这个').map(t => t.key), ['bug/1234']);
	eq('多标签保序', parseTaskTags('#task:bug/1 和 #task:bug/2').map(t => t.key), ['bug/1', 'bug/2']);
	eq('中文立即停止', parseTaskTags('#task:1234，帮我看下').map(t => t.key), ['1234']);
	eq('同消息重复去重', parseTaskTags('#task:bug/1 #task:bug/1').length, 1);
	eq('大小写归一', parseTaskTags('#task:Bug-1').map(t => t.key), ['bug-1']);
	eq('空 key 不算活', parseTaskTags('#task: 说明文字').length, 0);
	eq('没标签就没活', hasTaskTag('随便聊两句'), false);
	eq('有标签就有活', hasTaskTag('#task:bug/1'), true);
	eq('标签描述', describeTaskTags('#task:bug/1234 #task:bug/1235'), 'bug/1234、bug/1235');
	eq('归一化函数', normalizeTaskKey('  BUG/1 '), 'bug/1');
	eq('来源默认 group', parseTaskTags('#task:x')[0].source, 'group');
	eq('来源可覆盖', parseTaskTags('#task:x', { source: 'loop' })[0].source, 'loop');
}

// ── 预算（防风暴）─────────────────────────────────────────────────────────
{
	const verdict = budgetVerdict([], T0);
	eq('空事件允许派发', verdict.allowed, true);
	const full = Array.from({ length: BUDGET_DEFAULTS.maxEvents }, (_, i) => T0 - i * 1000);
	const blocked = budgetVerdict(full, T0);
	eq('超上限拒绝', blocked.allowed, false);
	ok('拒绝时给可读原因', blocked.reason.startsWith('budget-exceeded'), blocked.reason);
	ok('给出冷却时长', blocked.retryAfterMs >= 1000);
	// 窗口外的旧事件不再计入
	const stale = Array.from({ length: BUDGET_DEFAULTS.maxEvents }, (_, i) => T0 - (i + 1) * 120_000);
	eq('窗口外事件不计入', budgetVerdict(stale, T0).allowed, true);
	eq('裁剪保留窗内', pruneEvents([T0 - 10_000, T0 - 500_000], T0).length, 1);
}

// ── 回环闸门（系统消息不触发派发）─────────────────────────────────────────
{
	ok('kind=system 算系统消息', isSystemMessage({ kind: 'system' }));
	ok('sender=system 算系统消息', isSystemMessage({ sender: 'system' }));
	ok('source=loop 算系统消息', isSystemMessage({ source: 'loop' }));
	ok('system:true 算系统消息', isSystemMessage({ system: true }));
	ok('人发的消息不算', !isSystemMessage({ sender: 'alice', text: '#task:bug/1' }));
	ok('空对象不算', !isSystemMessage(null));
	const payload = notifyPayload({ loopName: 'tapd-bug-fix', key: 'tapd-bug/1234', status: 'done', text: '已修复并 shelve' });
	ok('通知载荷是系统消息', isSystemMessage(payload));
	ok('通知不带 @（不会被 @ 解析命中）', !renderNotify(payload).includes('@'));
	ok('通知渲染含 loop 名与 key', renderNotify(payload).includes('tapd-bug-fix') && renderNotify(payload).includes('tapd-bug/1234'));
}

const total = pass + failures.length;
if (failures.length) {
	console.error(`[workitem-check] ✗ ${failures.length}/${total} 项失败`);
	for (const failure of failures) { console.error(`  · ${failure}`); }
	process.exit(1);
}
console.log(`[workitem-check] ✓ ${pass}/${total} 项通过`);
