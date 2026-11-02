// 历史会话**工作台**（注册式 React，`client.history.js`）的行为级守卫。
//
// 为什么是行为级（承载收口最怕的就是「装了、点开是空白」）：
//   · 源码字符串断言只能证明「写了」，证明不了「渲染得出来 / 点得动 / 请求带对参数」；
//   · 这里用**真 React 18 + jsdom** 把 chunk 的 factory 装起来，真 `register`、真挂载、真点击，
//     断言到 DOM、请求参数和对宿主服务的调用上。
//   · `fetch` / `ctx`（uiWorkspace / sessions / desktopWorkbenches）是打桩的 —— 它们是**宿主的**行为，
//     本守卫只管**这个插件**对它们的用法是否正确。
//
// 覆盖：注册（描述符与清单一致）/ 分组渲染 / 搜索 / 状态筛选 / 范围与分组参数真的带到请求 /
//       点一行 ⇒ `uiWorkspace.openSession` / 瞬时错误 retain + 重试 / 失败就地可见 / 读取失败可重试 / 空态。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

// ⚠⚠ 加载顺序是硬约束（2026-11-02 实测踩到，浪费了一轮）：
//   必须**先**把 jsdom 的 window/document 挂到 globalThis，**再动态 import** React / react-dom。
//   静态 `import React` 会被 ESM 提升到最前面 ⇒ React DOM 在没有 DOM 的环境里初始化 ⇒
//   事件系统没挂好 ⇒ 受控 <input> 的 `onChange` **一次都不触发**（<select> 却正常，最迷惑的一点）。
//   症状是「搜索框打字没效果」，看起来像组件 bug，其实是测试环境。
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// ⚠ `react` / `react-dom` 不在本仓 package.json 的依赖里（靠别的包 hoist 带来）—— 隐含依赖。
//   哪天 hoist 变了，这里要**说清楚原因**，而不是甩一段 ERR_MODULE_NOT_FOUND 栈让人以为是组件坏了。
let React; let createRoot; let act;
try {
	React = (await import('react')).default;
	({ createRoot } = await import('react-dom/client'));
	({ act } = await import('react-dom/test-utils'));
} catch (e) {
	console.log('  ✗ 缺少 react / react-dom（本守卫的隐含依赖，原本靠 hoist 带来）：' + String((e && e.message) || e).split('\n')[0]);
	console.log('    处置：把 react、react-dom 加进 devDependencies，或确认 hoist 没变。这不是组件的问题。');
	process.exit(1);
}

const repo = process.cwd();
const problems = [];
const ok = (name) => console.log('  ✓ ' + name);
const fail = (msg) => { problems.push(String(msg)); console.log('  ✗ ' + String(msg)); };
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
const eq = (name, actual, expected) => {
	const a = JSON.stringify(actual); const e = JSON.stringify(expected);
	if (a === e) { ok(name); } else { fail(name + '：期望 ' + e + '，实际 ' + a); }
};
const truthy = (name, cond, detail) => { if (cond) { ok(name); } else { fail(name + (detail ? '：' + detail : '')); } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const CHUNK = 'dsh-plugins/vssaros-sessions/lib/client.history.js';
const ENTRY = 'dsh-plugins/vssaros-sessions/lib/client.js';
const pkg = JSON.parse(read('dsh-plugins/vssaros-sessions/package.json'));

// ── ① 清单 / 入口 / 描述符一致（装出去才不会缺文件、不会不加载）─────────────────────
{
	const files = Array.isArray(pkg.files) ? pkg.files : [];
	truthy('① files 含入口与子块（漏了 ⇒ 装上去没有这个文件）', files.includes('lib/client.js') && files.includes('lib/client.history.js'));
	truthy('① exports["./client"] 指向入口', pkg.exports && pkg.exports['./client'] === './lib/client.js');
	truthy('① dsh.client.inject 点名宿主包（保证加载顺序，否则 desktopWorkbenches 还没就绪）',
		Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@vssaros/dsh-workbenches'));
	truthy('① 入口用 require.async 装载子块，且装不上不抛（回落 iframe 页面）',
		/require\.async\('\.\/client\.history\.js'\)/.test(read(ENTRY)) && /workbenchFailed/.test(read(ENTRY)));
}

// ── 装载 chunk（真 factory）──────────────────────────────────────────────────────────
// （jsdom 与 React 已在文件顶部按正确顺序准备好）
const loadChunk = () => {
	let captured = null;
	const host = window;
	host.__ModuleLoader__ = { load: m => { captured = m; } };
	const fakeRequire = (name) => { if (name === 'react') { return React; } throw new Error('unexpected require: ' + name); };
	new Function('window', 'require', read(CHUNK))(host, fakeRequire);
	if (!captured) { throw new Error('chunk 没有调用 __ModuleLoader__.load'); }
	return captured.factory(fakeRequire);
};

// ── ② 注册：描述符与清单一致；没有 desktopWorkbenches 时不抛 ──────────────────────────
const mod = loadChunk();
{
	const registered = [];
	const effects = [];
	const ctx = {
		effect: (fn) => { effects.push(fn); const r = fn(); return r; },
		inject: (deps, cb) => { if (deps.includes('desktopWorkbenches')) { cb({ effect: (fn) => fn(), desktopWorkbenches: { register: (d, c) => { registered.push({ d, c }); return () => { }; } } }); } },
	};
	mod.install(ctx);
	eq('② 注册了一个工作台', registered.length, 1);
	const d = registered[0]?.d ?? {};
	const wb = pkg.vssaros.workbench;
	eq('② 描述符与清单 vssaros.workbench 逐项一致（title/description/icon/repository/customFrame）',
		[d.title, d.description, d.icon, d.repository, d.customFrame], [wb.title, wb.description, wb.icon, wb.repository, wb.customFrame]);
	truthy('② 注册的是函数组件（宿主据此渲染）', typeof registered[0]?.c === 'function');
	// 宿主服务缺席：只是「工作台不出现」，不能抛
	let threw = null;
	try { mod.install({ effect: (fn) => fn(), inject: () => { } }); } catch (e) { threw = e; }
	truthy('② 没有 desktopWorkbenches 服务时 install 不抛（页面版照旧可用）', threw === null, String(threw));
}

// ── 数据与宿主打桩 ───────────────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 10, 2, 8, 0, 0);
const session = (id, o = {}) => ({ id, title: o.title ?? '会话 ' + id, cwd: o.cwd ?? 'G:/w/proj1', preset: o.preset ?? 'default', status: o.status ?? 'idle', active: o.status === 'running' || o.status === 'awaiting', createdAt: NOW - (o.ageMin ?? 5) * 60000, persona: o.persona, blank: false, pendingQuestions: 0 });
const idle = (n, cwd) => Array.from({ length: n }, (_, i) => session('idle-' + cwd.slice(-1) + '-' + i, { cwd, ageMin: 10 + i }));
const PAYLOAD = (extra = {}) => ({
	dir: '/x', missing: '', truncated: false, remaining: 0, errors: [], live: true, presetNames: {},
	now: NOW, groupBy: 'workspace',
	groups: [
		{ key: 'G:/w/proj1', title: 'w/proj1', path: 'G:/w/proj1', roots: [], ungrouped: false,
			sessions: [session('run-1', { status: 'running', title: '正在跑的任务' }), session('ask-1', { status: 'awaiting', title: '等你回答的' }), ...idle(7, 'G:/w/proj1')] },
		{ key: 'G:/w/proj2', title: 'w/proj2', path: 'G:/w/proj2', roots: [], ungrouped: false, sessions: [session('p2-a', { cwd: 'G:/w/proj2', title: '第二个项目的会话', persona: '架构师', preset: 'arch' })] },
	],
	...extra,
});

async function boot({ payload = PAYLOAD(), apiStatus = 200, openImpl, live = { now: NOW, sessions: [] }, bareCtx = false } = {}) {
	const requests = [];
	const opened = [];
	const retained = [];
	let openCalls = 0;
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const u = String(url);
		requests.push(u);
		if (u.includes('/api/live')) { return { ok: true, status: 200, json: async () => live }; }
		if (u.includes('/api/sessions')) {
			const body = typeof payload === 'function' ? payload(u) : payload;
			return { ok: apiStatus === 200, status: apiStatus, json: async () => (apiStatus === 200 ? body : { error: 'boom' }) };
		}
		return { ok: false, status: 404, json: async () => ({}) };
	};
	const ctx = bareCtx ? { sessions: { retain: () => Promise.resolve() } } : {
		uiWorkspace: { openSession: (sid) => { openCalls++; opened.push(sid); return openImpl ? openImpl(sid, openCalls) : Promise.resolve(); } },
		sessions: { retain: (sid) => { retained.push(sid); return Promise.resolve(); } },
	};
	// 取组件：**一次** install、绑定打桩的 ctx（组件里的 ctx 是 install 闭包绑定的，不是 props 传的）
	let Component = null;
	mod.install({
		...ctx,
		effect: (fn) => fn(),
		inject: (deps, cb) => { if (deps.includes('desktopWorkbenches')) { cb({ effect: (fn) => fn(), desktopWorkbenches: { register: (_d, c) => { Component = c; return () => { }; } } }); } },
	});
	const container = window.document.getElementById('root');
	container.innerHTML = '';
	const root = createRoot(container);
	await act(async () => { root.render(React.createElement(Component)); await tick(20); });
	return {
		container, requests, opened, retained, root,
		q: (sel) => container.querySelector(sel),
		qa: (sel) => [...container.querySelectorAll(sel)],
		settle: async (ms = 20) => { await act(async () => { await tick(ms); }); },
		click: async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick(10); }); },
		change: async (el, value) => {
			await act(async () => {
				const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
				Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
				el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
				await tick(30);
			});
		},
		restore: async () => { await act(async () => { root.unmount(); }); globalThis.fetch = realFetch; },
	};
}

// ③ 渲染：分组 / 状态 / 折叠
{
	const env = await boot();
	try {
		eq('③ 两个分组', env.qa('[data-sessions-group]').map(g => g.getAttribute('data-sessions-group')), ['G:/w/proj1', 'G:/w/proj2']);
		const g1 = env.q('[data-sessions-group="G:/w/proj1"]');
		const rows1 = [...g1.querySelectorAll('[data-sessions-row]')];
		// 2 个活跃始终可见 + 5 个空闲（IDLE_LIMIT）= 7；9 个会话里藏了 2 个
		eq('③ 组内：活跃的始终可见，空闲的默认只露 5 个（共 7 行）', rows1.length, 7);
		eq('③ 活跃的排在前（服务端顺序保持）', rows1.slice(0, 2).map(r => r.getAttribute('data-session-id')), ['run-1', 'ask-1']);
		eq('③ 状态写在行上（探针只认 data-*）', rows1.slice(0, 2).map(r => r.getAttribute('data-session-status')), ['running', 'awaiting']);
		truthy('③ 运行中 / 等你回答 有状态徽标；空闲没有', !!rows1[0].querySelector('[data-sessions-status="running"]') && !!rows1[1].querySelector('[data-sessions-status="awaiting"]') && !rows1[2].querySelector('[data-sessions-status]'));
		truthy('③ 组头写出数量与进行中数', /9 个/.test(g1.querySelector('.wb-group-hd').textContent) && /2 个进行中/.test(g1.querySelector('.wb-group-hd').textContent), g1.querySelector('.wb-group-hd').textContent);
		const more = g1.querySelector('[data-sessions-more]');
		truthy('③ 有「展开其余 2 个」', !!more && /展开其余 2 个/.test(more.textContent), more ? more.textContent : '(没有按钮)');
		await env.click(more);
		eq('③ 点「展开其余」后全部 9 行都在', env.q('[data-sessions-group="G:/w/proj1"]').querySelectorAll('[data-sessions-row]').length, 9);
		truthy('③ 人格徽标', /人格：架构师/.test(env.q('[data-sessions-group="G:/w/proj2"]').textContent));
		const root = env.q('[data-vssaros-surface="workbench"]');
		truthy('③ 根节点带 data-vssaros-surface="workbench"（守卫 S8）+ 页面锚点', !!root && root.getAttribute('data-vssaros-page') === 'sessions' && root.getAttribute('data-sessions-total') === '10');
		eq('③ 恰好 1 个工具条锚点（宿主据此吸顶）', env.qa('[data-dsh-workbench-toolbar]').length, 1);
		eq('③ 零 iframe（承载收口的目的）', env.qa('iframe').length, 0);
	} finally { await env.restore(); }
}

// ④ 搜索 / 状态筛选
{
	const env = await boot();
	try {
		await env.change(env.q('[data-sessions-search]'), '第二个');
		eq('④ 搜索只剩命中的行', env.qa('[data-sessions-row]').map(r => r.getAttribute('data-session-id')), ['p2-a']);
		eq('④ 搜索时没命中的组整个消失', env.qa('[data-sessions-group]').length, 1);
		await env.change(env.q('[data-sessions-search]'), 'arch');
		eq('④ 搜索认 preset', env.qa('[data-sessions-row]').map(r => r.getAttribute('data-session-id')), ['p2-a']);
		await env.change(env.q('[data-sessions-search]'), '架构师');
		eq('④ 搜索认人格', env.qa('[data-sessions-row]').map(r => r.getAttribute('data-session-id')), ['p2-a']);
		await env.change(env.q('[data-sessions-search]'), 'p2-a');
		eq('④ 搜索认 id', env.qa('[data-sessions-row]').length, 1);
		await env.change(env.q('[data-sessions-search]'), 'zzz-没有这个');
		truthy('④ 搜不到 ⇒ 明说「没有匹配」（不是空白）', !!env.q('[data-sessions-nomatch]'));
		await env.change(env.q('[data-sessions-search]'), '正在跑');
		eq('④ 搜索命中单条', env.qa('[data-sessions-row]').length, 1);
		// ★ 这条才真正咬「搜索时不折叠」：折叠只在**同一组空闲会话 > 5**时才发生，
		//   上面那些只命中 1 行的搜索触发不了折叠 ⇒ 反向突变（去掉 `if (query)` 那行）时守卫仍全绿，是个真缺口。
		//   搜 `idle`：命中 proj1 的 7 个空闲会话（默认只露 5 个）⇒ 搜索态必须全部露出、且不再有「展开其余」。
		await env.change(env.q('[data-sessions-search]'), 'idle');
		eq('④ 搜索命中 7 个空闲会话 ⇒ 全部可见（搜索时不折叠，用户在找东西）', env.qa('[data-sessions-row]').length, 7);
		truthy('④ 搜索态没有「展开其余」按钮（不折叠就不需要）', !env.q('[data-sessions-more]'));
		await env.change(env.q('[data-sessions-search]'), '');
		truthy('④ 清掉搜索后又回到折叠（只露 5 个空闲）', env.q('[data-sessions-more]') !== null);
		await env.click(env.q('[data-sessions-status-filter="running"]'));
		eq('④ 状态筛选「运行中」', env.qa('[data-sessions-row]').map(r => r.getAttribute('data-session-id')), ['run-1']);
		await env.click(env.q('[data-sessions-status-filter="awaiting"]'));
		eq('④ 状态筛选「等你回答」', env.qa('[data-sessions-row]').map(r => r.getAttribute('data-session-id')), ['ask-1']);
		await env.click(env.q('[data-sessions-status-filter="all"]'));
		truthy('④ 回到「全部」', env.qa('[data-sessions-row]').length > 2);
	} finally { await env.restore(); }
}

// ⑤ 范围 / 分组参数真的带到请求里（回归：以前 API 不认 scope ⇒ 「仅当前工作区」静默无效）
{
	const env = await boot();
	try {
		const first = env.requests.find(u => u.includes('/api/sessions')) ?? '';
		truthy('⑤ 首次请求带默认参数 groupBy=workspace&scope=all', /groupBy=workspace/.test(first) && /scope=all/.test(first), first);
		await env.change(env.q('[data-sessions-scope]'), 'current');
		truthy('⑤ 选「仅当前工作区」⇒ 重新请求且带 scope=current', env.requests.some(u => /scope=current/.test(u)), env.requests.join(' | '));
		await env.change(env.q('[data-sessions-groupby]'), 'bot');
		truthy('⑤ 选「按 Bot」⇒ 重新请求且带 groupBy=bot', env.requests.some(u => /groupBy=bot/.test(u)), env.requests.join(' | '));
	} finally { await env.restore(); }
}

// ⑥ 点一行 ⇒ 打开会话（走宿主 uiWorkspace.openSession）
{
	const env = await boot();
	try {
		await env.click(env.q('[data-session-id="run-1"]'));
		eq('⑥ 点一行 ⇒ uiWorkspace.openSession(该会话 id)', env.opened, ['run-1']);
		truthy('⑥ 点击后立刻有受理反馈（行高亮）', env.q('[data-session-id="run-1"]').className.includes('is-selected'));
		await env.settle(50);
		truthy('⑥ 打开成功后不残留提示', !env.q('[data-sessions-msg]'));
	} finally { await env.restore(); }
}

// ⑦ 瞬时错误：先 retain 再退避重试，最终成功；彻底失败 ⇒ 就地可见（桌面窗口没有宿主桥，不能只 notify）
{
	const env = await boot({ openImpl: (sid, n) => (n < 2 ? Promise.reject(new Error('sessions.retain: unknown session')) : Promise.resolve()) });
	try {
		await env.click(env.q('[data-session-id="run-1"]'));
		await env.settle(50);
		truthy('⑦ 会话还没就绪 ⇒ 就地提示「正在打开会话…」', /正在打开会话/.test(env.q('[data-sessions-msg]')?.textContent ?? ''), env.q('[data-sessions-msg]')?.textContent ?? '(没有提示)');
		eq('⑦ 瞬时错误 ⇒ 先 retain 拿回引用', env.retained, ['run-1']);
		await env.settle(450);   // 第一次退避 300ms
		eq('⑦ 退避后重试了第二次', env.opened, ['run-1', 'run-1']);
		truthy('⑦ 重试成功后提示被清掉', !env.q('[data-sessions-msg]'), env.q('[data-sessions-msg]')?.textContent ?? '');
	} finally { await env.restore(); }
}
{
	const env = await boot({ openImpl: () => Promise.reject(new Error('permission denied')) });
	try {
		await env.click(env.q('[data-session-id="run-1"]'));
		await env.settle(50);
		const m = env.q('[data-sessions-msg="error"]');
		truthy('⑦ 非瞬时错误 ⇒ 立刻就地显示失败原因（不重试、不静默）', !!m && /打开会话失败：permission denied/.test(m.textContent), m ? m.textContent : '(没有提示)');
		eq('⑦ 非瞬时错误不重试', env.opened.length, 1);
	} finally { await env.restore(); }
}
{
	// 宿主没有会话打开能力 ⇒ 说清楚，而不是点了没反应。
	// 用 boot 的 `bareCtx` 选项（没有 uiWorkspace），不要手写第二套 root（会和 boot 的 root 抢同一个容器）。
	const env = await boot({ bareCtx: true });
	try {
		await env.click(env.q('[data-session-id="run-1"]'));
		await env.settle(30);
		const m = env.q('[data-sessions-msg="error"]');
		truthy('⑦ 宿主没有 uiWorkspace ⇒ 就地说清楚（不是点了没反应）', !!m && /宿主没有会话打开能力/.test(m.textContent), m ? m.textContent : '(没有提示)');
	} finally { await env.restore(); }
}

// ⑧ 读取失败 / 空 / 实时
{
	const env = await boot({ apiStatus: 500 });
	try {
		const err = env.q('[data-sessions-error]');
		truthy('⑧ 读取失败 ⇒ 明说失败原因 + 有「重试」按钮（不是空白）', !!err && /读取失败/.test(err.textContent) && !!err.querySelector('button'), err ? err.textContent : '(没有错误提示)');
	} finally { await env.restore(); }
}
{
	const env = await boot({ payload: PAYLOAD({ groups: [] }) });
	try {
		truthy('⑧ 一个会话都没有 ⇒ 空态文案（不是空白）', !!env.q('[data-sessions-empty]'));
	} finally { await env.restore(); }
}
{
	// 实时：服务端说 idle-1-0 现在在跑 ⇒ 行上的状态要跟着变（初始渲染时它是空闲）
	const liveBody = { now: NOW, sessions: [{ id: 'run-1', live: true, status: 'idle', title: '改过名了' }, { id: 'idle-1-0', live: true, status: 'running', title: '会话 idle-1-0' }] };
	const env = await boot({ live: liveBody });
	try {
		await env.settle(2200);
		eq('⑧ 实时：空闲会话开始运行 ⇒ 行状态变成 running', env.q('[data-session-id="idle-1-0"]')?.getAttribute('data-session-status'), 'running');
		eq('⑧ 实时：正在跑的会话结束 ⇒ 行状态变成 idle', env.q('[data-session-id="run-1"]')?.getAttribute('data-session-status'), 'idle');
		truthy('⑧ 实时：标题也跟着更新', /改过名了/.test(env.q('[data-session-id="run-1"]')?.textContent ?? ''));
		truthy('⑧ 实时只查页面上已经在显示的 id（不重扫磁盘）', env.requests.some(u => /\/api\/live\?ids=/.test(u)));
	} finally { await env.restore(); }
}

// ⑨ 旧页入口没丢（写操作仍在页面版里）
{
	const env = await boot();
	try {
		const a = env.q('[data-sessions-legacy]');
		truthy('⑨ 「在页面中打开」入口在（固定 / 清空 / 重命名 / 磁贴还在旧页）', !!a && a.getAttribute('href') === '/x/sessions/');
	} finally { await env.restore(); }
}

// ⑩ 路由切换的边界（读真实的导航代码）：切换是**自动**的 —— `wbFor()` 见到 `/x/sessions/` 且宿主里
//    已注册 `vssaros/sessions` 就直接渲染宿主 View，不需要改 DEFAULT_ITEMS。这有两个会**静默**坏掉的假设：
//    ① 「会话磁贴」(`/x/sessions/?view=tiles`) 必须**不**被切到新组件（新组件没有磁贴视图）⇒ 正则必须拒绝带查询串的路由；
//    ② 回落路径必须在：没注册 ⇒ 仍走 iframe（不留死页签）。
{
	const nav = read('dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js');
	const m = /const wbIdOf = \(t\) => \{[\s\S]*?const m = (\/\^[^\n]*?\$\/)\.exec\(/.exec(nav);
	truthy('⑩ 能从导航代码里取到 `/x/<m>/ → vssaros/<m>` 的识别正则（取不到 ⇒ 下面的边界断言会空跑）', !!m);
	if (m) {
		// 用导航代码里的**真实正则**，不是我抄一份
		const re = new Function('return ' + m[1])();
		eq('⑩ `/x/sessions/` ⇒ 会被识别成 vssaros/sessions（自动切到新组件）', re.exec('/x/sessions/')?.[1], 'sessions');
		eq('⑩ `/x/sessions/?view=tiles`（会话磁贴）**不**被识别 ⇒ 仍走 iframe（新组件没有磁贴视图）', re.exec('/x/sessions/?view=tiles'), null);
		eq('⑩ `/x/sessions/?groupBy=bot` 同样不被识别', re.exec('/x/sessions/?groupBy=bot'), null);
	}
	truthy('⑩ 没注册时回落 iframe（`wbFor` 空 ⇒ 走 route 的 iframe，不留死页签）',
		/const wbId = wbFor\(t\);\s*if \(wbId\) \{/.test(nav) && /return react\.createElement\("iframe", \{\s*key: t\.id, src: withSurface\(t\.route/.test(nav));
	const items = (() => {
		const a = nav.indexOf('const DEFAULT_ITEMS = ['); const b = nav.indexOf('\n\t\t];', a);
		return nav.slice(a, b < 0 ? undefined : b);
	})();
	truthy('⑩ DEFAULT_ITEMS 仍保留 `/x/sessions/` 与 `/x/sessions/?view=tiles` 两条（route 白名单：删了 ⇒ 点「打开」被静默拒掉）',
		/route: "\/x\/sessions\/"/.test(items) && /route: "\/x\/sessions\/\?view=tiles"/.test(items));
}

console.log(problems.length === 0 ? '\n[check-sessions-workbench] ✓ 全部通过' : `\n[check-sessions-workbench] ${problems.length} 项未通过`);
process.exit(problems.length === 0 ? 0 : 1);
