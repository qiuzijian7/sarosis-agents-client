// 调度引擎的纯逻辑单测（假时钟 + 临时数据根，不碰真实数据根）。
//
// 跑法：node dsh-plugins/vssaros-scheduler/test/run-engine-check.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createScheduleEngine, shouldProvideSchedule } from '../lib/engine.js';
import { bindFoundation } from '../lib/foundationRef.js';
import { readTasks } from '../lib/store.js';

let pass = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
	if (cond) { pass += 1; return; }
	failures.push(`${label}${detail ? `　（${detail}）` : ''}`);
};
const eq = (label, actual, expected) => ok(label, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

// store.js 的数据根来自 foundation ⇒ 单测里绑一个假的，指向可切换的临时目录。
// ★ 每个用例块都必须 `reset()`：引擎是**读盘**的，共用一个目录会让历史/任务跨块累积
//   （第一轮跑出来"历史记 1 条实际 2"就是这么来的）。
let tmp = mkdtempSync(join(tmpdir(), 'sched-'));
bindFoundation({ dataRootOf: () => tmp });

const DAY = 86_400_000;
const base = Date.UTC(2026, 10, 1, 0, 0);       // 2026-11-01T00:00Z
let nowMs = base;

/** 每个用例块开头调用：清空任务库 + 时钟回到基准点。 */
function reset() {
	rmSync(tmp, { recursive: true, force: true });
	tmp = mkdtempSync(join(tmpdir(), 'sched-'));
	nowMs = base;
}

function newEngine(extra = {}) {
	return createScheduleEngine({
		config: {},
		log: () => undefined,
		now: () => nowMs,
		setIntervalFn: () => 1,                  // 假定时器：不真跑，测试用 _tick 手动推进
		clearIntervalFn: () => undefined,
		...extra,
	});
}

const mkTask = (id, patch = {}) => ({
	id,
	kind: 'loop',
	loopName: 'demo',
	rule: { kind: 'daily', atMinute: 9 * 60, timeZone: 'UTC' },
	createdAtMs: base,
	...patch,
});

// ── 基本 CRUD ────────────────────────────────────────────────────────────
{
	reset();
	const engine = newEngine();
	const task = engine.create(mkTask('t1'));
	eq('create 后 status', task.status, 'active');
	eq('create 算出 next（当天 09:00Z）', task.next.target, base + 9 * 3600_000);
	ok('get 能取到', engine.get('t1')?.id === 't1');
	ok('list 有 1 条', engine.list().length === 1);
	ok('重名 id 报错', (() => { try { engine.create(mkTask('t1')); return false; } catch { return true; } })());
	ok('catalog 有 1 条', engine.catalog().length === 1);
	ok('remove 生效', engine.remove('t1') === true && engine.list().length === 0);
}

// ── 到点触发 + 事件 + seq ────────────────────────────────────────────────
{
	reset();
	const engine = newEngine();
	engine.create(mkTask('t2'));
	const events = [];
	const dispose = engine.onFire(e => events.push(e));
	engine.start();                              // catchUp（next 在未来 ⇒ 不动）
	eq('未到点不触发', events.length, 0);

	nowMs = base + 9 * 3600_000;                 // 推进到 09:00Z
	engine._tick();
	eq('到点触发一次', events.length, 1);
	eq('事件带 seq', events[0]?.seq, 1);
	eq('事件带 workItemKey', events[0]?.workItemKey, 'sched-t2-2026-11-01');
	eq('next 推到明天', engine.get('t2').next.target, base + DAY + 9 * 3600_000);
	eq('lastRun 记下时刻', engine.get('t2').lastRun.at, nowMs);

	// 同一时刻再 tick 不应重复触发（next 已推进）
	engine._tick();
	eq('同一时刻不重复触发', events.length, 1);

	dispose();
	nowMs = base + DAY + 9 * 3600_000;
	engine._tick();
	eq('dispose 后不再收到事件', events.length, 1);
	eq('但任务照样推进', engine.get('t2').lastRun.seq, 2);
}

// ── 监听者抛错不影响引擎 ─────────────────────────────────────────────────
{
	reset();
	const engine = newEngine();
	engine.create(mkTask('t3'));
	const seen = [];
	engine.onFire(() => { throw new Error('boom'); });
	engine.onFire(e => seen.push(e.taskId));
	engine.start();
	nowMs = base + 9 * 3600_000;
	engine._tick();
	eq('第一个监听者抛错后第二个仍收到', seen, ['t3']);
	eq('任务状态照常推进', engine.get('t3').lastRun.seq, 1);
}

// ── 不补跑（关机三天后重启）─────────────────────────────────────────────
{
	reset();
	const engine = newEngine();
	engine.create(mkTask('t4'));
	const events = [];
	engine.onFire(e => events.push(e));
	// 模拟：Host 停了 3 天，任务 next 还停在"3 天前的 09:00"
	const store = engine._store();
	store.tasks[0].next.target = base + 9 * 3600_000;
	nowMs = base + 3 * DAY + 10 * 3600_000;
	engine._catchUp(nowMs);
	ok('追赶不触发（不补跑）', events.length === 0, `触发了 ${events.length} 次`);
	ok('追赶把 next 推到未来', engine.get('t4').next.target > nowMs);
	eq('追赶后仍未记 lastRun', engine.get('t4').lastRun.seq, 0);
}

// ── 落盘先于派发（模拟"派发时进程死了"）──────────────────────────────────
{
	reset();
	const engine = newEngine();
	engine.create(mkTask('t7'));
	// 监听者抛错 ≈ 派发阶段崩了
	engine.onFire(() => { throw new Error('进程死在派发里'); });
	engine.start();
	nowMs = base + 9 * 3600_000;
	engine._tick();
	const onDisk = readTasks({}).tasks.tasks.find(t => t?.id === 't7');
	ok('派发崩溃后盘上仍记着 seq（不会重复投）', Number(onDisk?.lastRun?.seq ?? 0) === 1, `盘上 seq=${onDisk?.lastRun?.seq}`);
	ok('盘上 next 也已推进', Number(onDisk?.next?.target ?? 0) > nowMs);
}

// ── 一次性任务 ───────────────────────────────────────────────────────────
{
	reset();
	const engine = newEngine();
	engine.create({ id: 't5', kind: 'prompt', prompt: 'hi', sessionId: 's1', rule: { kind: 'at', at: { date: '2026-11-01', time: '09:00' }, timeZone: 'UTC' }, createdAtMs: base });
	nowMs = base + 9 * 3600_000;
	ok('fireNow 成功', engine.fireNow('t5') === true);
	eq('一次性跑完即 ended', engine.get('t5').status, 'ended');
	eq('历史记 1 条', engine.history({ limit: 10 }).length, 1);
	eq('历史按任务过滤', engine.history({ id: 't5', limit: 10 }).length, 1);
	eq('别的任务历史为 0', engine.history({ id: 'nope', limit: 10 }).length, 0);
}

// ── 落盘（重启后仍在）───────────────────────────────────────────────────
{
	reset();
	const engine = newEngine();
	engine.create(mkTask('t6'));
	engine.fireNow('t6');
	const reloaded = readTasks({});
	eq('重新读盘仍有该任务', reloaded.tasks.tasks.length >= 1, true);
	ok('盘上带 history', Array.isArray(reloaded.tasks.history));
}

// ── 撞键保护 ─────────────────────────────────────────────────────────────
{
	eq('组合里没有 schedule ⇒ 可以占用', shouldProvideSchedule({ get: () => null, schedule: undefined }).ok, true);
	eq('组合里已有 schedule ⇒ 不占用', shouldProvideSchedule({ get: () => ({}), schedule: undefined }).ok, false);
	eq('ctx.schedule 直接挂着也算占用', shouldProvideSchedule({ schedule: { create() {} } }).ok, false);
	eq('ctx.get 抛错（探针假 ctx）⇒ 视为没人占', shouldProvideSchedule({ get: () => { throw new Error('no service'); } }).ok, true);
}

rmSync(tmp, { recursive: true, force: true });

const total = pass + failures.length;
if (failures.length) {
	console.error(`[engine-check] ✗ ${failures.length}/${total} 项失败`);
	for (const failure of failures) { console.error(`  · ${failure}`); }
	process.exit(1);
}
console.log(`[engine-check] ✓ ${pass}/${total} 项通过`);
