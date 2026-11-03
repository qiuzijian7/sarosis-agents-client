// 聊天里「已创建自动化任务」卡片（lib/client.scheduleCard.js）的纯逻辑单测。
// 跑法：node dsh-plugins/vssaros-chat-surface/test/run-schedulecard-check.mjs
//
// 为什么用 vm 而不是 import：这个文件是 dsh client-modules 契约的 **chunk**
// （`window.__ModuleLoader__.load({ id, chunk, factory })`），没有 ESM 导出。
// 用假 window 装上它，再取 `factory(require)` 的 exports —— 与浏览器里同一份代码路径。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const F = path.join(ROOT, 'lib', 'client.scheduleCard.js');
const code = fs.readFileSync(F, 'utf8');

let registered = null;
const sandbox = {
	window: {
		__ModuleLoader__: { load: (def) => { registered = def; } },
		addEventListener() {},
		removeEventListener() {},
		__vssarosSchedulerFocus: (id) => { sandbox.__focused = id; return true; },
	},
	require: (name) => {
		if (name === 'react') { return { createElement: () => null }; }
		throw new Error('unexpected require: ' + name);
	},
	console,
	exports: {},
};
sandbox.__focused = '';
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const pass = [];
const fail = [];
const ok = (label, cond, detail) => { (cond ? pass : fail).push(label + (cond || !detail ? '' : '  — ' + detail)); };

ok('chunk 已注册', !!registered && registered.chunk === 'client.scheduleCard.js', String(registered && registered.chunk));
const mod = registered ? registered.factory(sandbox.require) : null;
ok('导出 install', !!mod && typeof mod.install === 'function');
const t = mod && mod.__test;
ok('导出 __test', !!t);

if (t) {
	// ── 结果文本解析 ─────────────────────────────────────────────────────
	ok('textOf 认 {text}', t.textOf({ content: [{ text: '{"id":"t-abc123"}' }] }) === '{"id":"t-abc123"}');
	ok('textOf 认 {type:text,value}', t.textOf({ content: [{ type: 'text', value: 'hello' }] }) === 'hello');
	ok('textOf 跳过脏数据', t.textOf({ content: [null, 42, { text: 'x' }] }) === 'x');

	const j = t.taskOfText('{"id":"t-1a2b3c","title":"每日日报","ruleText":"每天 09:00"}');
	ok('JSON 结果取到 id+title+ruleText',
		j && j.id === 't-1a2b3c' && j.title === '每日日报' && j.ruleText === '每天 09:00', JSON.stringify(j));
	const r = t.taskOfText('已创建 "t-9f8e7d" 成功');
	ok('非 JSON 用 t-xxx 正则兜底', r && r.id === 't-9f8e7d', JSON.stringify(r));
	ok('没有任务 id ⇒ null', t.taskOfText('done') === null && t.taskOfText('') === null);

	// ── 本轮筛选 ────────────────────────────────────────────────────────
	const mkNodes = (list) => ({ values: () => list.values() });
	const node = (root) => ({ kind: 'tool-call', data: { root } });
	const result = (name, callTime, text) => ({ kind: 'tool-result', name, callTime, content: [{ text }] });
	const turn = { start: { time: 1000 }, end: { time: 2000 } };

	const snapOk = {
		nodes: mkNodes([
			node(result('schedule_create', 1500, '{"id":"t-aaa111","title":"A","ruleText":"每天 09:00"}')),
			node(result('schedule_create', 1600, '{"id":"t-bbb222","title":"B"}')),
			node(result('bash', 1700, '{"id":"t-zzz999"}')),
			node(result('schedule_create', 500, '{"id":"t-old777"}')),
			node({ kind: 'start', name: 'schedule_create' }),
		]),
	};
	const got = t.tasksOfTurn(snapOk, turn);
	ok('只取本轮的两个 schedule_create 结算结果（排除别的工具/上一轮/pending）',
		got && got.length === 2 && got[0].id === 't-aaa111' && got[1].id === 't-bbb222', JSON.stringify(got));

	const dup = t.tasksOfTurn({
		nodes: mkNodes([
			node(result('schedule_create', 1500, '{"id":"t-same1"}')),
			node(result('schedule_create', 1600, '{"id":"t-same1"}')),
		]),
	}, turn);
	ok('同一任务重复出现只留一条', dup && dup.length === 1, JSON.stringify(dup));
	ok('没有 start 时间 ⇒ 不渲染（不猜轮次）', t.tasksOfTurn(snapOk, {}) === null);
	ok('没有节点 ⇒ null', t.tasksOfTurn({}, turn) === null);
	ok('没有创建任务 ⇒ null（不占位）', t.tasksOfTurn({ nodes: mkNodes([node(result('bash', 1500, 'x'))]) }, turn) === null);
}

// ── 注册契约（与官方 ScheduleTurnCard 同槽）──────────────────────────────
{
	let reg = null;
	const ctx = {
		slots: {
			inject(slot, fn) { sandbox.__slot = slot; return fn(); },
			register(def, Comp) { reg = { def, Comp }; return () => {}; },
		},
	};
	try { mod.install(ctx, {}); } catch (e) { fail.push('install 抛错：' + String((e && e.message) || e)); }
	ok('注入 conversation.chat.turnTail', sandbox.__slot === 'conversation.chat.turnTail', String(sandbox.__slot));
	ok('注册 id = vssaros-schedule-created', !!reg && reg.def.id === 'vssaros-schedule-created', JSON.stringify(reg && reg.def));
	ok('order = 20（官方 ScheduleTurnCard 同值，排在用量页脚之上）', !!reg && reg.def.order === 20, String(reg && reg.def.order));
}

console.log(pass.map((x) => '  ok   ' + x).join('\n'));
if (fail.length) {
	console.log(fail.map((x) => '  FAIL ' + x).join('\n'));
	console.log(`\n[scheduleCard] ✗ ${fail.length}/${pass.length + fail.length} 项失败`);
	process.exit(1);
}
console.log(`\n[scheduleCard] ✓ ${pass.length}/${pass.length} 项通过`);
