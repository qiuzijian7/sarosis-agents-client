/**
 * 守卫：**群聊聊天框**（agents 工作台中栏 + chat-surface 中栏页签 共用的那一份实现）。
 *
 * 背景（2026-11-02，Bots 工作台重构）：侧栏「Bots」点群聊 ⇒ 中栏页签要显示群聊聊天框。
 *   群没有「群会话」（`groups.js` 只有逐成员的 `memberSessions`），不能 `openSession`；
 *   原先退而求其次是 iframe 套 `/x/agents/group/<id>?embed=1` —— 那是**另一套** DSB 风格页面，
 *   字体 / 输入框 / 主题都和 dsh 聊天框不一致。现在：
 *     · 方案 A：`AgentsPanel` 增加 only 模式（`GroupChatRoot`），中栏页签直接挂它，不画工具栏 / 左右栏；
 *     · 方案 B：群聊聊天框抽成独立 chunk `client.groupChat.js`（`GroupChat` + `Composer`），
 *       工作台与中栏页签**只此一份**。
 *
 * 这里用 jsdom + 真实 React **真渲染**（不是只读源码），防止：
 *   ① 抽取 / 改动后某个标识符悬空 ⇒ 运行时才炸（`node --check` 查不出）；
 *   ② only 模式悄悄把左栏 / 右栏 / 工具栏又画出来 ⇒ 中栏里出现两套 UI；
 *   ③ 群被删后 only 模式回落显示成「第一个群」（发消息发错群）；
 *   ④ 后台保活的群页签继续 3 秒轮询（N 个页签 = N 路请求）；
 *   ⑤ groupChat chunk 没装上时整页崩（应只显示一句说明）。
 *
 * 更重的浏览器回归在 `poc/dsh-p0/scripts/p3-189-workbench-group-chat.mjs`（真 Chrome，65 项）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const React = require('react');
const { JSDOM } = require('jsdom');
const act = React.act;
// ⚠ react-dom 在**加载时**就判定 `canUseDOM`（决定支不支持 input 事件 ⇒ onChange 会不会触发）。
//   必须在 jsdom 的 window/document 挂到 globalThis **之后**再 require，否则受控输入框永远收不到 onChange
//   （2026-11-02 踩过：发送一直是空文本，查了半天才发现是装配顺序）。见下面 `let createRoot`。
let createRoot;

const R = [];
const check = (n, ok, d) => R.push({ n, ok: !!ok, d: d || '' });
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/* ───────── ① 静态：单一实现（agents 面板里不能再长出第二份群聊 UI）───────── */
const LIB = 'dsh-plugins/vssaros-agents/lib/';
const agentsSrc = read(LIB + 'client.agents.js');
const gcSrc = read(LIB + 'client.groupChat.js');
const entrySrc = read(LIB + 'client.js');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/* ⚠ 只看「JS 里用到的类名」：`client.agents.js` 的 CSS 模板里本来就有 `.ag3-gmsg` 这些样式（样式留在那边） */
check('群聊气泡 / @ 候选 / 附件 UI 只在 client.groupChat.js（agents 面板里没有第二份）',
	!/className: '(ag3-gmsg|ag3-atpop|ag3-gup|ag3-gfiles|ag3-gsep)/.test(agentsSrc)
	&& /className: 'ag3-atpop'/.test(gcSrc) && /className: 'ag3-gmsg'/.test(gcSrc), '');
check('composer 只有一个实现（agents 的 composer 是对 GC.Composer 的薄包装，不再自己画输入框）',
	!/className: 'ag3-comp-ta'/.test(agentsSrc) && /className: 'ag3-comp-ta'/.test(gcSrc) && /h\(GC\.Composer,/.test(agentsSrc), '');
{
	// ⚠ 用去掉注释的源码比顺序：注释里也会出现 bindGroupChat / client.groupChat.js 字样
	const e = strip(entrySrc);
	const iLoad = e.indexOf("require.async('./client.groupChat.js')");
	const iBind = e.indexOf('part.bindGroupChat(gc)');
	const iInst = e.indexOf('part.install(ctx)');
	check('入口先装 groupChat 再 bindGroupChat 再 install（顺序错了面板首帧就没有群聊）',
		iLoad >= 0 && iBind > iLoad && iInst > iBind, `load=${iLoad} bind=${iBind} install=${iInst}`);
}
check('groupChat 装载失败被隔离（吞掉并记 groupChatFailed，不带走整个工作台）',
	/groupChatFailed/.test(entrySrc), '');
check('展开按钮只在 only 模式给（工作台里群设置仍是页内二级页，不出现第二个入口）',
	/onToggleDrawer: onlyGroup \? \(\) => toggleGDrawer\(\) : undefined/.test(agentsSrc)
	&& /props\.onToggleDrawer\s*\?/.test(gcSrc), '');
check('包清单 files 含 client.groupChat.js（否则装上缺文件 ⇒ import 失败）',
	JSON.parse(read('dsh-plugins/vssaros-agents/package.json')).files.includes('lib/client.groupChat.js'), '');

/* ───────── ② 动态：jsdom 真渲染 ───────── */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const w = dom.window;
globalThis.window = w; globalThis.document = w.document;
globalThis.localStorage = w.localStorage; globalThis.Event = w.Event; globalThis.CustomEvent = w.CustomEvent;
globalThis.HTMLElement = w.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
w.requestAnimationFrame = globalThis.requestAnimationFrame;
({ createRoot } = require('react-dom/client'));   // ← 必须在上面的全局就绪之后

/* 异步 setState（fetch 回来）发生在 act 之外会刷一屏 React 警告；断言不依赖它，噪音压掉 */
{
	const origErr = console.error;
	console.error = (...a) => { if (/not wrapped in act/.test(String(a[0]))) { return; } origErr(...a); };
}

/* 拦 setInterval：只记录 3000ms 的（群轮询），用「现存个数」断言轮询是否暂停（不用干等 3 秒） */
const realSI = globalThis.setInterval; const realCI = globalThis.clearInterval;
const livePolls = new Set();
globalThis.setInterval = (fn, ms, ...a) => { const id = realSI(fn, ms, ...a); if (ms === 3000) { livePolls.add(id); } return id; };
globalThis.clearInterval = (id) => { livePolls.delete(id); return realCI(id); };

const GROUPS = { groups: [
	{ id: 'g1', name: '测试群', mode: 'open', members: ['coder', 'writer'], transcript: [
		{ id: 'm1', at: 1000, role: 'user', text: '你好 @Coder', name: '用户' },
		{ id: 'm2', at: 2000, role: 'member', agentId: 'coder', name: 'Coder', text: '收到',
			},
		{ id: 'm3', at: 3000, role: 'user', text: '带投递的一条', deliveries: [
			{ id: 'd1', agentId: 'coder', name: 'Coder', state: 'replied', at: 3000 },
			{ id: 'd2', agentId: 'writer', name: 'Writer', state: 'dispatched', at: Date.now() },
		] },
	] },
	{ id: 'g2', name: '另一个群', mode: 'open', members: ['writer'], transcript: [] },
], maxMembers: 100 };
const HOME = { agents: [
	{ id: 'coder', name: 'Coder', presetId: 'vssaros-coder', registered: true, description: '', role: '' },
	{ id: 'writer', name: 'Writer', presetId: 'vssaros-writer', registered: true, description: '', role: '' },
], home: {}, roster: ['vssaros-coder', 'vssaros-writer'], summary: {}, errors: [] };
const posts = [];
let failMessages = false;
globalThis.fetch = async (url, opts) => {
	const u = String(url); const method = (opts && opts.method) || 'GET';
	if (method === 'POST') {
		let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* 非 JSON（上传） */ }
		posts.push({ url: u, body });
		if (failMessages && body.action === 'message') { return { ok: false, status: 500, json: async () => ({ ok: false, error: '模拟发送失败' }) }; }
		return { ok: true, status: 200, json: async () => ({ ok: true }) };
	}
	const body = u.includes('/groups') ? GROUPS : (u.includes('/home') ? HOME : {});
	return { ok: true, status: 200, json: async () => body };
};

/** 与入口 lib/client.js 同序装载（groupChat → agents → bind） */
const loadMods = (bind) => {
	let captured = null;
	w.__ModuleLoader__ = { load: (m) => { captured = m; } };
	const req = (n) => { if (n === 'react') { return React; } throw new Error('require ' + n); };
	new Function('window', 'require', gcSrc)(w, null);
	const gc = captured.factory(req);
	new Function('window', 'require', agentsSrc)(w, null);
	const agents = captured.factory(req);
	if (bind) { agents.bindGroupChat(gc); }
	return { gc, agents };
};

const settle = async (ms = 80) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const q = (s) => document.querySelector(s);
const qa = (s) => document.querySelectorAll(s);
const setNative = (el, value, caret) => {
	const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set;
	setter.call(el, value);
	try { el.setSelectionRange(caret == null ? value.length : caret, caret == null ? value.length : caret); } catch { /* jsdom 够用 */ }
};

try {
	const { gc, agents } = loadMods(true);
	const root = createRoot(document.getElementById('root'));
	const render = async (el) => { await act(async () => { root.render(el); }); await settle(120); };
	const GCR = (props) => React.createElement(agents.GroupChatRoot, props);

	await render(GCR({ gid: 'g1', active: true }));
	check('only 模式渲染出群聊中栏（data-ag-mid="group"）', !!q('[data-ag-mid="group"]'), document.body.innerHTML.slice(0, 200));
	check('only 模式不画工具栏 / 页签 / 左栏 / 右栏（否则中栏里出现两套 UI）',
		!q('[data-dsh-workbench-toolbar]') && !q('.ag3-tabs') && !q('.ag3-l') && !q('.ag3-r'), '');
	check('surface 标记 group-chat 且带群 id', !!q('[data-vssaros-surface="group-chat"][data-ag-group-only="g1"]'), '');
	check('头部：群名 / 成员数 / 三个按钮（新建会话 · 邀请成员 · 群设置）',
		(q('[data-ag-file-name]') || {}).textContent === '测试群'
		&& !!q('[data-ag-act="group-newsession"]') && !!q('[data-ag-act="group-invite"]') && !!q('[data-ag-act="group-settings"]'), '');
	check('三条消息渲染出来', (q('[data-ag-midlist="group"]') || { getAttribute: () => '' }).getAttribute('data-ag-gcount') === '3', '');
	check('气泡（.ag3-gmsg）而不是纯文本两行', qa('.ag3-gmsg').length === 3, 'n=' + qa('.ag3-gmsg').length);
	check('群头部显示投递状态「已回 1/2 · 等 1」', (q('[data-ag-delivery]') || {}).getAttribute && q('[data-ag-delivery]').getAttribute('data-ag-delivery') === '已回 1/2 · 等 1',
		q('[data-ag-delivery]') ? q('[data-ag-delivery]').getAttribute('data-ag-delivery') : '(无)');
	check('消息里的 @Coder 渲染成高亮 token（.ag3-gat）', qa('.ag3-gat').length >= 1, '');

	/* 发送：输入 → 点发送 ⇒ 真的 POST action:message（不是跳页） */
	{
		const ta = q('[data-ag-composer-input="group-send"]');
		await act(async () => { setNative(ta, '你好世界'); ta.dispatchEvent(new w.Event('input', { bubbles: true })); });
		await act(async () => { q('[data-ag-act="group-send"]').click(); });
		await settle();
		const sent = posts.filter((p) => p.body && p.body.action === 'message');
		check('点发送 ⇒ POST action:message（含群 id 与文本）', sent.length === 1 && sent[0].body.id === 'g1' && sent[0].body.text === '你好世界', JSON.stringify(sent[0] && sent[0].body));
		check('发送后输入框清空', (q('[data-ag-composer-input="group-send"]') || {}).value === '', '');
	}

	/* 失败 ⇒ 失败气泡 + 重试；重试不会越点越多 */
	{
		failMessages = true;
		const ta = q('[data-ag-composer-input="group-send"]');
		await act(async () => { setNative(ta, '会失败的一条'); ta.dispatchEvent(new w.Event('input', { bubbles: true })); });
		await act(async () => { q('[data-ag-act="group-send"]').click(); });
		await settle();
		check('发送失败 ⇒ 失败气泡 + 「重试」按钮', qa('.ag3-gmsg.is-fail').length === 1 && !!q('[data-ag-act="group-retry"]'), 'fail=' + qa('.ag3-gmsg.is-fail').length);
		failMessages = false;
		const before = posts.filter((p) => p.body && p.body.action === 'message').length;
		await act(async () => { q('[data-ag-act="group-retry"]').click(); });
		await settle();
		const after = posts.filter((p) => p.body && p.body.action === 'message').length;
		check('点重试 ⇒ 再发一次且失败气泡消失（队列里不会越点越多）', after === before + 1 && qa('.ag3-gmsg.is-fail').length === 0, `before=${before} after=${after}`);
	}

	/* `@` 候选：输入 @ ⇒ 浮层（@所有人 + 成员） */
	{
		const ta = q('[data-ag-composer-input="group-send"]');
		await act(async () => { setNative(ta, 'hi @', 4); ta.dispatchEvent(new w.Event('input', { bubbles: true })); });
		const pop = q('[data-ag-atpop]');
		check('敲 @ ⇒ 弹出候选浮层，含 @所有人 + 2 个成员（共 3 项）', !!pop && pop.getAttribute('data-ag-atpop') === '3', pop ? pop.getAttribute('data-ag-atpop') : '(无浮层)');
	}

	/* ★ 展开右侧栏（2026-11-02，用户：群聊 UI 右上角缺展开按钮；点设置应在展开栏里显示独立页签）
	   官方右栏按会话存在、此处无会话 ⇒ 面板自带。默认收起；▤ 展开；群设置 / 邀请成员 也展开。 */
	check('头部右上角有「展开右侧栏」按钮，默认收起（aria-expanded=false，无展开栏）',
		!!q('[data-ag-act="group-drawer-toggle"]') && q('[data-ag-act="group-drawer-toggle"]').getAttribute('aria-expanded') === 'false' && !q('[data-ag-drawer]'), '');
	check('展开按钮是头部**最右**一个（在「群设置」之后）', (() => {
		const btns = [...qa('.ag3-mhd button')];
		return btns[btns.length - 1] && btns[btns.length - 1].getAttribute('data-ag-act') === 'group-drawer-toggle';
	})(), '');
	await act(async () => { q('[data-ag-act="group-drawer-toggle"]').click(); });
	await settle();
	check('点 ▤ ⇒ 展开右侧栏，栏里有独立页签「⚙ 群设置」，内容是群设置表单',
		!!q('[data-ag-drawer="g1"]') && !!q('[data-ag-drawer] [data-ag-drawer-tab="group-settings"]') && !!q('[data-ag-drawer] [data-ag-gset="g1"]'), document.body.innerHTML.slice(0, 160));
	check('展开后**聊天仍在**（群设置不再整块顶掉聊天）', !!q('[data-ag-mid="group"]') && !!q('[data-ag-composer-input="group-send"]'), '');
	check('栏内的群设置没有「← 返回」（关页签 = 收起）', !q('[data-ag-drawer] [data-ag-act="group-set-back"]'), '');
	check('按钮状态同步：aria-expanded=true', q('[data-ag-act="group-drawer-toggle"]').getAttribute('aria-expanded') === 'true', '');
	await act(async () => { q('[data-ag-act="group-drawer-toggle"]').click(); });
	await settle();
	check('再点 ▤ ⇒ 收起', !q('[data-ag-drawer]') && !!q('[data-ag-mid="group"]'), '');
	await act(async () => { q('[data-ag-act="group-settings"]').click(); });
	await settle();
	check('点「群设置」按钮 ⇒ 同样展开栏并显示「群设置」页签', !!q('[data-ag-drawer] [data-ag-gset="g1"]'), '');
	await act(async () => { q('[data-ag-act="group-drawer-close"]').click(); });
	await settle();
	check('点页签 ✕ ⇒ 收起整根栏（栏里只剩它）', !q('[data-ag-drawer]'), '');
	await act(async () => { q('[data-ag-act="group-invite"]').click(); });
	await settle();
	check('点「邀请成员」⇒ 同样展开', !!q('[data-ag-drawer] [data-ag-gset="g1"]'), '');
	await act(async () => { q('[data-ag-act="group-drawer-collapse"]').click(); });
	await settle();
	check('点栏头 » ⇒ 收起', !q('[data-ag-drawer]'), '');

	/* 换群 / 不存在的群（严格匹配，不回落 groups[0]） */
	/* 栏开着时换群 ⇒ 必须收起（表单里还是上一个群的值，留着会改错群） */
	await act(async () => { q('[data-ag-act="group-drawer-toggle"]').click(); });
	await settle();
	check('（换群前）栏已展开', !!q('[data-ag-drawer="g1"]'), '');
	await render(GCR({ gid: 'g2', active: true }));
	check('栏开着时换群 ⇒ 栏收起（不会拿上一个群的表单改这个群）', !q('[data-ag-drawer]'), '');
	check('换 gid ⇒ 跟着换群（头部是「另一个群」）', (q('[data-ag-file-name]') || {}).textContent === '另一个群', (q('[data-ag-file-name]') || {}).textContent);
	await render(GCR({ gid: 'nope', active: true }));
	check('不存在的群 ⇒ 说明「不存在了」，且不回落成第一个群', !!q('[data-ag-group-state="missing"]') && !q('[data-ag-mid="group"]'), '');

	/* 后台保活不轮询 */
	await render(GCR({ gid: 'g1', active: false }));
	check('active=false ⇒ 群轮询暂停（没有存活的 3 秒 interval）', livePolls.size === 0, 'live=' + livePolls.size);
	await render(GCR({ gid: 'g1', active: true }));
	check('active=true ⇒ 群轮询恢复（恰好 1 个 interval）', livePolls.size === 1, 'live=' + livePolls.size);

	/* 注册表（chat-surface 中栏页签按这个键取组件） */
	agents.install({ effect: (fn) => { fn(); }, inject: () => { } });
	check('install 登记 window.__vssarosPageComponents["agents.groupChat"]（中栏页签据此渲染）',
		typeof w.__vssarosPageComponents?.['agents.groupChat'] === 'function', '');

	root.unmount();

	/* ⑤ groupChat 没装上：只显示说明，不崩 */
	{
		const { agents: bare } = loadMods(false);
		const root2 = createRoot(document.getElementById('root'));
		let threw = '';
		try {
			await act(async () => { root2.render(React.createElement(bare.GroupChatRoot, { gid: 'g1', active: true })); });
			await settle(120);
		} catch (e) { threw = String((e && e.message) || e); }
		check('groupChat 未绑定 ⇒ 不崩，显示「群聊组件还没加载」', !threw && !!q('[data-ag-groupchat-missing]'), threw || document.body.innerHTML.slice(0, 160));
		root2.unmount();
	}
} catch (e) {
	check('验证过程未抛异常', false, String((e && e.stack) || e).slice(0, 300));
}

let bad = 0;
for (const r of R) {
	console.log((r.ok ? '  ok   ' : '  FAIL ') + r.n + (r.ok || !r.d ? '' : '  — ' + r.d));
	if (!r.ok) { bad++; }
}
console.log('\n' + (R.length - bad) + '/' + R.length + ' passed');
process.exit(bad ? 1 : 0);
