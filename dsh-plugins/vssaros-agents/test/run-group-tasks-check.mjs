// 群聊「活（work item）」接线的纯判据单测（2026-10-31）。
// ⚠ 只在本单测里跨插件 import 内核工厂（运行期走 cordis 服务 `vssarosWorkItems`）。
//
// 最关键的一条断言是第 1 条：**没有 `#task` 标签的消息必须照旧派发** —— 这条接线是增量的，
// 不能改变任何现有群聊的行为。
//
// 跑法：node dsh-plugins/vssaros-agents/test/run-group-tasks-check.mjs

import { createWorkItemService } from '../../vssaros-workitem/lib/index.js';
import { bindWorkItems } from '../lib/workItemRef.js';

bindWorkItems(createWorkItemService());

import {
	DEFAULT_POLICY, emptyTasks, holdInflight, inflightOf, noteDispatch,
	planGroupDispatch, releaseInflight, settleGroupReply, settleIntoLedger,
} from '../lib/groupTasks.js';

let pass = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
	if (cond) { pass += 1; return; }
	failures.push(`${label}${detail ? `　（${detail}）` : ''}`);
};
const eq = (label, actual, expected) => ok(label, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

const T0 = new Date('2026-10-31T12:00:00Z').getTime();

// 1) ★ 现状不变：没有 #task ⇒ 照旧派发
{
	const gate = planGroupDispatch({ text: '大家看下这个问题', message: { sender: 'alice' }, tasks: emptyTasks(), policy: DEFAULT_POLICY, nowMs: T0 });
	eq('无标签 ⇒ 正常派发', gate.dispatch, true);
	eq('无标签 ⇒ 不产生活', gate.keys, []);
	eq('无标签 ⇒ 无原因', gate.reason, '');
}

// 2) 回环闸门：loop 通知（系统消息）不派发
{
	const gate = planGroupDispatch({ text: '已修复 #task:bug/1', message: { kind: 'system', source: 'loop' }, tasks: emptyTasks(), policy: DEFAULT_POLICY, nowMs: T0 });
	eq('系统消息 ⇒ 不派发', gate.dispatch, false);
	ok('系统消息给出原因', gate.reason.includes('system-message'), gate.reason);
}

// 3) 有标签且账本空 ⇒ 派发并带走这些活
{
	const tasks = emptyTasks();
	const gate = planGroupDispatch({ text: '看下 #task:bug/1', message: { sender: 'alice' }, tasks, policy: DEFAULT_POLICY, nowMs: T0 });
	eq('有标签 ⇒ 派发', gate.dispatch, true);
	eq('带走的活', gate.keys, ['bug/1']);
	noteDispatch(tasks, { keys: gate.keys, nowMs: T0 });
	eq('派发后进入 running', tasks.ledger.items['bug/1'].status, 'running');
	eq('派发事件已记', tasks.events.length, 1);
	eq('来源标记 group', tasks.ledger.items['bug/1'].source, 'group');
}

// 4) 做过的活不再派（这是"对齐 loop"的核心）
{
	const tasks = emptyTasks();
	const first = planGroupDispatch({ text: '看下 #task:bug/2', message: { sender: 'alice' }, tasks, policy: DEFAULT_POLICY, nowMs: T0 });
	noteDispatch(tasks, { keys: first.keys, nowMs: T0 });
	settleIntoLedger(tasks, { keys: first.keys, status: 'done', nowMs: T0 + 1000 });
	const again = planGroupDispatch({ text: '再看下 #task:bug/2', message: { sender: 'alice' }, tasks, policy: DEFAULT_POLICY, nowMs: T0 + 2000 });
	eq('done 的活不再派', again.dispatch, false);
	ok('原因点名 ledger:done', again.reason.includes('ledger:done'), again.reason);
}

// 5) 风暴预算
{
	const tasks = emptyTasks();
	tasks.events = Array.from({ length: 20 }, (_, i) => T0 - i * 1000);
	const gate = planGroupDispatch({ text: '#task:bug/3', message: { sender: 'alice' }, tasks, policy: DEFAULT_POLICY, nowMs: T0 });
	eq('超预算 ⇒ 不派发', gate.dispatch, false);
	ok('原因点名 budget', gate.reason.includes('budget-exceeded'), gate.reason);
}

// 6) 完成契约（缺标记 ⇒ failed，与 loop 同一条）
{
	const done = settleGroupReply({ keys: ['bug/4'], finalText: '修好了\n[item:done]' });
	eq('有 done 标记 ⇒ done', done.status, 'done');
	const blocked = settleGroupReply({ keys: ['bug/5'], finalText: '[item:blocked:缺日志]' });
	eq('blocked 带原因', blocked.reason, '缺日志');
	const missing = settleGroupReply({ keys: ['bug/6'], finalText: '我觉得修好了' });
	eq('没签字 ⇒ failed', missing.status, 'failed');
	ok('没签字给出原因', missing.reason.includes('missing'), missing.reason);
}

// 7) inflight（会话 → 正在跑的活，回收时按 sessionId 结算）
{
	const tasks = emptyTasks();
	holdInflight(tasks, 'sess-1', ['bug/7', 'bug/8']);
	eq('inflight 可读', inflightOf(tasks, 'sess-1'), ['bug/7', 'bug/8']);
	eq('别的会话没有', inflightOf(tasks, 'sess-2'), []);
	releaseInflight(tasks, 'sess-1');
	eq('结算后放掉', inflightOf(tasks, 'sess-1'), []);
}

const total = pass + failures.length;
if (failures.length) {
	console.error(`[group-tasks-check] ✗ ${failures.length}/${total} 项失败`);
	for (const failure of failures) { console.error(`  · ${failure}`); }
	process.exit(1);
}
console.log(`[group-tasks-check] ✓ ${pass}/${total} 项通过`);
