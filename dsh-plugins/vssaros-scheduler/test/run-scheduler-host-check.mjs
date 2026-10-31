// @vssaros/dsh-scheduler — Host 半边的**端到端**自检（用假 ctx 真跑 `apply()`）。
//   跑法：node dsh-plugins/vssaros-scheduler/test/run-scheduler-host-check.mjs
//
// ★ 为什么必须有这一层（2026-10-31 真机事故的代价）：
//   工作台空白 / 取数 400 这类故障，**静态断言与纯函数单测都测不出来** —— 它们只发生在
//   `apply()` 的真实执行顺序里。当时连撞三个真 bug，全靠"假 ctx 真跑一遍"才定位到：
//     ① `let engineInstalled` 写在 `ctx.inject` 调用**之后** ⇒ 回调同步执行时命中 TDZ
//        ⇒ apply 中断 ⇒ **页面路由压根没注册** ⇒ 所有 `/x/scheduler/api/*` 都是 400；
//     ② `ctx.logger(name)` 返回**对象**（`{info,warn,error}`）不是函数 ⇒ 旧代码 `log(line)` 一调就炸；
//     ③ `engine` 声明在 apply 内 ⇒ 模块级路由函数读不到 ⇒ 页面永远"引擎未就绪"。
//   ⇒ 这一层断言的是"装得上并且真的能用"，不是"代码长这样"。
//
// ⚠ 跨插件 import 只在单测里允许（生产运行期必须走 cordis 服务，见 lib/workItemRef.js）。

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const tmp = mkdtempSync(join(tmpdir(), 'sched-host-'));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
	if (cond) { pass += 1; return; }
	failures.push(`${name}${detail ? `　（${detail}）` : ''}`);
};

const routes = [];
const provided = {};
const tools = [];
const thrown = [];
const foundation = { dataRootOf: () => tmp };

const ctx = {
	tools: { register: (def) => { tools.push(def.name); return () => { }; }, get: () => undefined },
	webServer: { register: (r) => { routes.push(r); return () => { }; }, port: 7000, host: '127.0.0.1' },
	connection: { requestRejection: () => 0, authenticatedUrl: u => u },
	effect: (fn) => { try { return fn(); } catch (e) { thrown.push('effect: ' + e.message); return undefined; } },
	// ★ 同步执行回调：正是"服务已就绪"的形态 —— TDZ 那类 bug 只有这样才能复现。
	inject: (deps, cb) => {
		for (const d of deps) {
			if (d === 'vssarosFoundation') { continue; }
			if (!ctx[d]) { thrown.push(`inject 缺服务: ${d}`); return; }
		}
		try { cb(ctx); } catch (e) { thrown.push(`inject(${deps.join(',')}) 抛错: ${e.message}`); }
	},
	provide: (name, value) => { provided[name] = value; },
	get: (name) => (name === 'vssarosFoundation' ? foundation : provided[name]),
	vssarosFoundation: foundation,
	logger: () => ({ info: () => { }, warn: (m) => thrown.push('warn: ' + m), error: (m) => thrown.push('error: ' + m) }),
};

const mod = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href);
ok('静态 inject 声明 tools（否则 ctx.tools 直读会抛 ⇒ 插件激活失败）',
	Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject));

try {
	mod.apply(ctx, {});
} catch (e) {
	failures.push(`apply() 抛错：${e.message}`);
}

ok('apply() 不抛（含同步 inject 回调）', thrown.length === 0, thrown.join(' | '));
ok('提供 schedule 服务', !!provided.schedule);
for (const name of ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete', 'schedule_history']) {
	ok(`注册工具 ${name}`, tools.includes(name));
}
const route = routes.find(r => r.path === '/x/scheduler');
ok('注册 /x/scheduler 前缀路由', !!route && route.kind === 'prefix', routes.map(r => r.kind + ':' + r.path).join(','));

/** 真调一次 handler（不是看代码）。 */
async function call(method, url, body) {
	const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b ?? ''; } };
	const req = { method, url, headers: {}, on: () => req, destroy() { } };
	await route.handler(req, res);
	if (body !== undefined) {
		// 触发 data/end 事件（handler 用 readBody 收）
	}
	return res;
}

if (route) {
	const list = await call('GET', '/x/scheduler/api/list');
	ok('GET /api/list ⇒ 200', list.code === 200, String(list.code));
	ok('引擎在路由里可见（available:true —— 模块级 engine 真的被赋值）',
		/available":true/.test(list.body), list.body.slice(0, 120));

	// 建一条任务 ⇒ 落盘（端到端：路由 → 引擎 → tasks.json）
	const createBody = JSON.stringify({
		title: '端到端任务',
		kind: 'loop',
		loopName: 'demo',
		rule: { kind: 'every', everySeconds: 3600, timeZone: 'UTC' },
	});
	const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b ?? ''; } };
	const req = {
		method: 'POST', url: '/x/scheduler/api/create', headers: {},
		on: (ev, fn) => {
			if (ev === 'data') { setTimeout(() => fn(Buffer.from(createBody)), 0); }
			if (ev === 'end') { setTimeout(fn, 5); }
			return req;
		},
		destroy() { },
	};
	await route.handler(req, res);
	ok('POST /api/create ⇒ 200', res.code === 200, `${res.code} ${res.body.slice(0, 120)}`);
	let onDisk = null;
	try { onDisk = JSON.parse(readFileSync(join(tmp, 'scheduler', 'tasks.json'), 'utf8')); } catch { /* 下面断言 */ }
	ok('任务真的落到 <数据根>/scheduler/tasks.json', !!onDisk && (onDisk.tasks?.length ?? 0) === 1,
		onDisk ? JSON.stringify(onDisk.tasks?.map(t => t.id)) : '文件不存在');
	ok('落盘的任务带自建 rule 形状', onDisk?.tasks?.[0]?.rule?.kind === 'every', JSON.stringify(onDisk?.tasks?.[0]?.rule));
}

const total = pass + failures.length;
if (failures.length) {
	console.error(`[scheduler-host] ✗ ${failures.length}/${total} 项失败`);
	for (const f of failures) { console.error(`  · ${f}`); }
	process.exit(1);
}
console.log(`[scheduler-host] ✓ ${pass}/${total} 项通过`);
// apply 里 engine.start() 会 setInterval（真 ticker）⇒ 必须显式退出
process.exit(0);
