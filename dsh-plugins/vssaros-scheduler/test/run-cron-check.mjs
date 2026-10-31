// 自建调度的纯判据单测（cron / 时区 / 任务模型 / 触发推进 / work item key）。
// ⚠ 与既有的 `run-scheduler-check.mjs`（chunk 契约 + legacy 迁移）分开：那个测搬运，这个测引擎。
//
// 跑法：node dsh-plugins/vssaros-scheduler/test/run-cron-check.mjs

import { describeRule, nextRunAtMs, parseCron } from '../lib/core/cron.js';
import { isDue, markFired, nextRunAtMs as taskNext, normalizeTask, workItemKeyOf } from '../lib/core/task.js';

let pass = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
	if (cond) { pass += 1; return; }
	failures.push(`${label}${detail ? `　（${detail}）` : ''}`);
};
const eq = (label, actual, expected) => ok(label, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
const throws = (label, fn, needle = '') => {
	try {
		fn();
		failures.push(`${label}　（没有抛错）`);
	} catch (error) {
		const text = String(error?.message ?? error);
		ok(label, !needle || text.includes(needle), `错误信息应含「${needle}」，实际 ${text}`);
	}
};

// ── cron 解析 ────────────────────────────────────────────────────────────
{
	eq('五字段解析', parseCron('0 9 * * *').hours, [9]);
	eq('分钟步长', parseCron('*/15 * * * *').minutes, [0, 15, 30, 45]);
	eq('星期范围', parseCron('0 9 * * 1-5').daysOfWeek, [1, 2, 3, 4, 5]);
	eq('枚举去重升序', parseCron('0 9,9,17 * * *').hours, [9, 17]);
	throws('字段数不对要报错', () => parseCron('0 9 * *'), '5 个字段');
	throws('拒 L 扩展语法', () => parseCron('0 9 L * *'), '不支持');
	throws('越界要报错', () => parseCron('0 25 * * *'), '越界');
}

// ── nextRunAt（UTC，便于断言）────────────────────────────────────────────
{
	const from = Date.UTC(2026, 10, 1, 0, 0);          // 2026-11-01T00:00Z
	eq('daily 下一个 09:00', nextRunAtMs({ kind: 'daily', atMinute: 9 * 60 }, from, 'UTC'), Date.UTC(2026, 10, 1, 9, 0));
	eq('已过则推到明天', nextRunAtMs({ kind: 'daily', atMinute: 9 * 60 }, Date.UTC(2026, 10, 1, 10, 0), 'UTC'), Date.UTC(2026, 10, 2, 9, 0));
	eq('cron 0 9 * * *', nextRunAtMs({ kind: 'cron', expression: '0 9 * * *' }, from, 'UTC'), Date.UTC(2026, 10, 1, 9, 0));
	eq('cron */30', nextRunAtMs({ kind: 'cron', expression: '*/30 * * * *' }, Date.UTC(2026, 10, 1, 0, 10), 'UTC'), Date.UTC(2026, 10, 1, 0, 30));
	// 2026-11-01 是周日（dow=0）⇒ 1-5 的下一次是周一 11-02
	eq('工作日约束', nextRunAtMs({ kind: 'cron', expression: '0 9 * * 1-5' }, from, 'UTC'), Date.UTC(2026, 10, 2, 9, 0));
	eq('weekly 指定星期', nextRunAtMs({ kind: 'weekly', atMinute: 8 * 60, weekdays: [3] }, from, 'UTC'), Date.UTC(2026, 10, 4, 8, 0));
	// ★ 日与周都受限 ⇒ **并集**：`0 9 15 * 1` = 15 日或周一 ⇒ 从 11-01 起下一个是 11-02（周一），
	//   而不是等到 11-15（且交集实现会要求"15 日且周一"，直接算错）。
	eq('日与周都受限取并集', nextRunAtMs({ kind: 'cron', expression: '0 9 15 * 1' }, from, 'UTC'), Date.UTC(2026, 10, 2, 9, 0));
}

// ── 时区（关键：别自己算偏移）────────────────────────────────────────────
{
	const from = Date.UTC(2026, 10, 1, 0, 0);          // 上海 08:00
	eq('Asia/Shanghai 09:00 = UTC 01:00', nextRunAtMs({ kind: 'cron', expression: '0 9 * * *' }, from, 'Asia/Shanghai'), Date.UTC(2026, 10, 1, 1, 0));
	// ★ 2026-11-01 是纽约夏令时**结束日**（本地 02:00 回拨）⇒ 当天 09:00 已属 EST（UTC-5）
	//   ⇒ 正确值是 14:00Z 而不是 13:00Z。这条断言专门钉住"固定偏移会算错"的那类 bug。
	eq('America/New_York 跨夏令时切换日', nextRunAtMs({ kind: 'daily', atMinute: 9 * 60 }, from, 'America/New_York'), Date.UTC(2026, 10, 1, 14, 0));
	// 切换日前一天仍是 EDT（UTC-4）⇒ 13:00Z
	eq('America/New_York 切换前一天是 EDT', nextRunAtMs({ kind: 'daily', atMinute: 9 * 60 }, Date.UTC(2026, 9, 31, 0, 0), 'America/New_York'), Date.UTC(2026, 9, 31, 13, 0));
}

// ── every / at / after ───────────────────────────────────────────────────
{
	const anchor = Date.UTC(2026, 10, 1, 0, 0);
	eq('every 4h', nextRunAtMs({ kind: 'every', everySeconds: 4 * 3600, anchorMs: anchor }, anchor, 'UTC'), anchor + 4 * 3600_000);
	eq('every 从锚点推进不漂移', nextRunAtMs({ kind: 'every', everySeconds: 3600, anchorMs: anchor }, anchor + 90 * 60_000, 'UTC'), anchor + 2 * 3600_000);
	throws('every 下限 60s', () => nextRunAtMs({ kind: 'every', everySeconds: 30, anchorMs: anchor }, anchor, 'UTC'), '≥60');
	eq('at 定点', nextRunAtMs({ kind: 'at', at: { date: '2026-11-01', time: '09:00' } }, anchor, 'UTC'), Date.UTC(2026, 10, 1, 9, 0));
	eq('at 已过 ⇒ Infinity', nextRunAtMs({ kind: 'at', at: { date: '2026-10-31', time: '09:00' } }, anchor, 'UTC'), Infinity);
	eq('after 相对', nextRunAtMs({ kind: 'after', afterSeconds: 600, anchorMs: anchor }, anchor, 'UTC'), anchor + 600_000);
	eq('after 已过 ⇒ Infinity', nextRunAtMs({ kind: 'after', afterSeconds: 60, anchorMs: anchor }, anchor + 120_000, 'UTC'), Infinity);
	throws('at 格式不对', () => nextRunAtMs({ kind: 'at', at: { date: 'x', time: 'y' } }, anchor, 'UTC'), 'YYYY-MM-DD');
}

// ── 任务模型 ─────────────────────────────────────────────────────────────
{
	const base = { id: 't-1', title: '每日总结', kind: 'prompt', prompt: '总结', sessionId: 's-1', rule: { kind: 'daily', atMinute: 9 * 60, timeZone: 'UTC' }, createdAtMs: Date.UTC(2026, 10, 1, 0, 0) };
	const task = normalizeTask(base, { nowMs: base.createdAtMs, timeZone: 'UTC' });
	eq('归一化默认 active', task.status, 'active');
	eq('算出 next', task.next.target, Date.UTC(2026, 10, 1, 9, 0));
	eq('prompt 型默认不去重', task.workItem.dedupe, 'off');

	throws('缺 id', () => normalizeTask({ ...base, id: '' }), 'id');
	throws('未知 kind', () => normalizeTask({ ...base, kind: 'nope' }), 'kind');
	throws('prompt 缺 prompt', () => normalizeTask({ ...base, prompt: '' }), 'prompt');
	throws('loop 缺 loopName', () => normalizeTask({ ...base, kind: 'loop', loopName: '' }), 'loopName');
	throws('rule 非法', () => normalizeTask({ ...base, rule: { kind: 'cron', expression: 'bad' } }), 'rule');
	throws('every 下限', () => normalizeTask({ ...base, rule: { kind: 'every', everySeconds: 10 } }), 'everySeconds');

	const loopTask = normalizeTask({ id: 't-2', kind: 'loop', loopName: 'tapd-bug-fix', rule: { kind: 'cron', expression: '0 */4 * * 1-5', timeZone: 'Asia/Shanghai' }, createdAtMs: Date.UTC(2026, 10, 1, 0, 0) }, { nowMs: Date.UTC(2026, 10, 1, 0, 0) });
	eq('loop 型默认按天去重', loopTask.workItem.dedupe, 'per-day');
	eq('loop 型 key 模板', loopTask.workItem.keyTemplate, 'sched-t-2-{date}');
}

// ── 触发推进 ─────────────────────────────────────────────────────────────
{
	const daily = normalizeTask({ id: 't-3', kind: 'loop', loopName: 'demo', rule: { kind: 'daily', atMinute: 9 * 60, timeZone: 'UTC' }, createdAtMs: Date.UTC(2026, 10, 1, 0, 0) }, { nowMs: Date.UTC(2026, 10, 1, 0, 0) });
	ok('未到点不算 due', !isDue(daily, Date.UTC(2026, 10, 1, 8, 0)));
	ok('到点算 due', isDue(daily, Date.UTC(2026, 10, 1, 9, 0)));
	ok('paused 不算 due', !isDue({ ...daily, status: 'paused' }, Date.UTC(2026, 10, 1, 9, 0)));

	const fired = markFired(daily, { atMs: Date.UTC(2026, 10, 1, 9, 0), ok: true });
	eq('seq 递增', fired.lastRun.seq, 1);
	eq('下一次是明天', fired.next.target, Date.UTC(2026, 10, 2, 9, 0));
	eq('重复规则保持 active', fired.status, 'active');

	const failed = markFired(daily, { atMs: Date.UTC(2026, 10, 1, 9, 0), ok: false, error: 'boom' });
	eq('失败也记 lastRun', failed.lastRun.ok, false);
	eq('失败也推进下一次（退避由 work item 层管）', failed.next.target, Date.UTC(2026, 10, 2, 9, 0));

	const once = normalizeTask({ id: 't-4', kind: 'prompt', prompt: 'x', sessionId: 's', rule: { kind: 'at', at: { date: '2026-11-01', time: '09:00' }, timeZone: 'UTC' }, createdAtMs: Date.UTC(2026, 10, 1, 0, 0) }, { nowMs: Date.UTC(2026, 10, 1, 0, 0) });
	eq('一次性跑完即 ended', markFired(once, { atMs: Date.UTC(2026, 10, 1, 9, 0) }).status, 'ended');
}

// ── work item key（时区相关）─────────────────────────────────────────────
{
	const task = normalizeTask({ id: 't-5', kind: 'loop', loopName: 'demo', rule: { kind: 'daily', atMinute: 0, timeZone: 'Asia/Shanghai' }, workItem: { dedupe: 'per-day', keyTemplate: 'sched-{id}-{date}' }, createdAtMs: 0 }, { nowMs: 0 });
	// UTC 2026-11-01T16:00Z = 上海 2026-11-02 00:00 ⇒ 日期必须按上海算
	eq('日期按任务时区算', workItemKeyOf(task, { atMs: Date.UTC(2026, 10, 1, 16, 0) }), 'sched-t-5-2026-11-02');
	eq('seq 占位符', workItemKeyOf({ ...task, workItem: { ...task.workItem, keyTemplate: 'sched-{id}-{seq}' }, lastRun: { seq: 3 } }), 'sched-t-5-4');
}

// ── 描述 ─────────────────────────────────────────────────────────────────
eq('描述 daily', describeRule({ kind: 'daily', atMinute: 9 * 60 }), '每天 09:00');
eq('描述 cron', describeRule({ kind: 'cron', expression: '0 9 * * 1-5' }), 'cron 0 9 * * 1-5');
eq('描述 every', describeRule({ kind: 'every', everySeconds: 3600 }), '每 60 分钟');
eq('task 层再导出 nextRunAtMs', typeof taskNext, 'function');

const total = pass + failures.length;
if (failures.length) {
	console.error(`[cron-check] ✗ ${failures.length}/${total} 项失败`);
	for (const failure of failures) { console.error(`  · ${failure}`); }
	process.exit(1);
}
console.log(`[cron-check] ✓ ${pass}/${total} 项通过`);
