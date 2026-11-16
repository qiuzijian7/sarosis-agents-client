// 工作区下拉 A′ 的**真 DOM 行为守卫**（2026-11-14）
// 跑法：node dsh-plugins/check-workspace-aprime.mjs
// 用 jsdom + 真 React 装载 client.workspace.js，覆盖顶部添加、tip 手风琴展开、
// tip 内选当前根（不直接切）、主命令用选中根切会话。
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
	{ url: 'http://localhost/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const act = React.act;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const src = readFileSync(new URL('./vssaros-chat-surface/lib/client.workspace.js', import.meta.url), 'utf8');
let captured = null;
dom.window.__ModuleLoader__ = { load: (m) => { captured = m; } };
const requireFn = (s) => { if (s === 'react') { return React; } throw new Error('unexpected require ' + s); };
const module_ = { exports: {} };
new Function('window', 'document', 'require', 'module', 'exports', src + '\nreturn module.exports;')(
	dom.window, dom.window.document, requireFn, module_, module_.exports);
const mod = captured.factory(requireFn);

const results = [];
const ck = (name, cond, extra) => { results.push({ name, ok: !!cond, extra: cond ? '' : (extra || '') }); };
const q = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];

document.documentElement.dataset.vssarosWorktrees = JSON.stringify([]);
document.documentElement.dataset.vssarosWorkspaces = JSON.stringify([
	{ id: 'ide-1', name: 'proj', roots: [
		{ path: '/repo/main', name: 'main', isPrimary: true },
		{ path: '/repo/pkg-b', name: 'pkg-b', isPrimary: false },
		{ path: '/repo/pkg-c', name: 'pkg-c', isPrimary: false },
	] },
	{ id: 'ide-2', name: 'other', roots: [{ path: '/repo/other', name: 'other', isPrimary: true }] },
]);

const snapshot = { items: [
	{ workspaceId: 'w1', path: '/repo/main', title: 'main', sessionIds: ['s-a'] },
	{ workspaceId: 'w2', path: '/repo/other', title: 'other', sessionIds: [] },
] };
const switches = [];
const regs = [];
// ★ 真机「主根无法点击切换」：让 cwd 可变，才能复现「当前 cwd 正好命中主根」的场景
let currentCwd = '/elsewhere';
const ctx = {
	get: (name) => {
		if (name === 'workspaces') {
			return { list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
				create: () => Promise.resolve(), delete: () => Promise.resolve() };
		}
		if (name === 'sessions') {
			return { list: { getSnapshot: () => ({ byId: { 's-a': { cwd: currentCwd } } }), subscribe: () => () => {} } };
		}
		return undefined;
	},
	uiWorkspace: { openWorkspace: () => Promise.resolve(), pickDirectory: () => Promise.resolve(null) },
	slots: { inject: (_slot, fn) => fn(), register: (spec, comp) => { regs.push({ spec, comp }); return () => {}; } },
};
const shell = {
	state: { sessionId: 's-a' },
	bridge: { switchWorktree: (p) => { switches.push(p); return Promise.resolve(); }, notify: () => {} },
	menus: { closeOthers: () => {}, register: () => () => {} },
	fitMenu: () => ({}),
	heroWorktreeChip: null,
};
mod.install(ctx, shell);
const entry = regs.find((r) => r.spec && r.spec.id === 'vssaros-context-entry');
ck('注册了 header 工作区入口', !!entry && typeof entry.comp === 'function');

const host = document.getElementById('root');
const root = createRoot(host);
await act(async () => { root.render(React.createElement(entry.comp, { sessionId: 's-a' })); await tick(20); });
const chip = q('[data-vssaros-context-chip]');
ck('chip 渲染出来', !!chip);
if (chip) {
	await act(async () => { chip.click(); await tick(30); });
}

// ① 添加置顶 + 首屏无 tip
const top = q('[data-vssaros-context-top]');
ck('顶部工具行存在', !!top);
ck('＋ 添加工作区 置顶', !!top && !!top.querySelector('[data-vssaros-context-add-top]'));
ck('tip 默认全收起', qa('[data-vssaros-wt-tip]').length === 0);
ck('首屏无常驻「当前会话」栏', !/当前会话/.test(q('[data-vssaros-context-panel]')?.textContent || ''));

// ② 点工作区行 ⇒ 展开 tip（手风琴）
const wsRow = qa('[data-vssaros-context-item="workspace:ide-1"], [data-vssaros-context-item^="workspace:"]')[0];
ck('有工作区行', !!wsRow, qa('[data-vssaros-context-item]').map((e) => e.getAttribute('data-vssaros-context-item')).join('|'));
if (wsRow) {
	await act(async () => { wsRow.click(); await tick(30); });
}
const tips = qa('[data-vssaros-wt-tip]');
ck('点行展开 tip', tips.length === 1, 'tips=' + tips.length);
const tip = tips[0];
if (tip) {
	const rootRows = qa('[data-vssaros-wt-tip] [data-vssaros-context-item^="root:"]');
	ck('tip 内有根行', rootRows.length >= 2, 'rows=' + rootRows.length);
	ck('tip 头说明多根', /多根/.test(tip.textContent));
	ck('tip 内有主命令', !!tip.querySelector('[data-vssaros-context-detail-action]'));
	ck('说明默认折叠', !!tip.querySelector('details[data-vssaros-scope-info]'));
	const go = tip.querySelector('[data-vssaros-context-detail-action]');
	ck('主命令可点', !!go && !go.disabled);
	// ③ ★ 真机「切换按钮无法点击」（连报三轮）：「切换」必须是**独立真实 button**，
	//    不是 hint 文本；点它要直接切到该根，不依赖外层行冒泡。
	const target = rootRows.find((r) => r.getAttribute('data-vssaros-context-item') === 'root:/repo/pkg-c') || rootRows[rootRows.length - 1];
	const switchBtn = target.querySelector('[data-vssaros-wt-tip-switch]');
	ck('「切换」是独立 button 元素', !!switchBtn && switchBtn.tagName === 'BUTTON',
		switchBtn ? switchBtn.tagName : 'none');
	ck('「切换」按钮未被禁用', !!switchBtn && !switchBtn.disabled,
		switchBtn ? 'disabled=' + switchBtn.disabled : 'no button');
	ck('按钮文案是「切换」', !!switchBtn && /切换/.test(switchBtn.textContent || ''),
		(switchBtn?.textContent || '').slice(0, 40));
	if (switchBtn) { await act(async () => { switchBtn.click(); await tick(30); }); }
	ck('点「切换」按钮直接调桥', switches.length === 1 && switches[0] === '/repo/pkg-c',
		'switches=' + switches.join('|'));
	ck('点击后面板仍在且给出即时反馈',
		// 「…」是同步 setNote 的标记；异步 .then 里那句用「；宿主完成后…」，不能混用
		!!q('[data-vssaros-context-panel]') && /新建会话…/.test(q('[data-vssaros-context-panel]').textContent || ''),
		(q('[data-vssaros-context-panel]')?.textContent || '').slice(-90));
	const btnAfter = qa('[data-vssaros-wt-tip-switch]').find((b) => b.getAttribute('data-vssaros-wt-tip-state') === 'requested');
	ck('按钮自身立即显示「已请求…」', !!btnAfter && /已请求/.test(btnAfter.textContent || ''),
		btnAfter ? (btnAfter.textContent || '') : 'no requested button');
	ck('面板可滚动（末尾反馈不被截断）',
		q('[data-vssaros-context-panel]')?.style.overflowY === 'auto'
		&& !!q('[data-vssaros-context-panel]')?.style.maxHeight,
		'overflowY=' + q('[data-vssaros-context-panel]')?.style.overflowY);
}

// ④ ★ 真机「主根无法点击切换」回归：cwd 正好命中主根时（hero 常残留上一条会话的 cwd），
//    主根不许被判成「当前项」禁用、也不许被 isCurrentRow 静默跳过。
currentCwd = '/repo/main';
switches.length = 0;
await act(async () => { root.render(React.createElement(entry.comp, { sessionId: 's-a' })); await tick(30); });
if (!q('[data-vssaros-context-panel]')) {
	const chip2 = q('[data-vssaros-context-chip]');
	if (chip2) { await act(async () => { chip2.click(); await tick(30); }); }
}
// 工作区行是 toggle：按实际 tip 状态点，且每次重新查节点（React 重渲会替换 DOM）
const clickWs = async () => {
	const r = qa('[data-vssaros-context-item^="workspace:"]')[0];
	if (r) { await act(async () => { r.click(); await tick(30); }); }
};
if (!q('[data-vssaros-wt-tip]')) { await clickWs(); }
if (!q('[data-vssaros-wt-tip]')) { await clickWs(); }
const tip3 = q('[data-vssaros-wt-tip]');
ck('cwd 命中主根时 tip 头以真实 cwd 为准', !!tip3 && /当前根：main/.test(tip3.textContent || ''),
	(tip3?.textContent || '').slice(0, 80) + ' | panel=' + !!q('[data-vssaros-context-panel]')
	+ ' chip=' + !!q('[data-vssaros-context-chip]')
	+ ' ws=' + qa('[data-vssaros-context-item^="workspace:"]').length
	+ ' tips=' + qa('[data-vssaros-wt-tip]').length);
const mainRow = qa('[data-vssaros-wt-tip] [data-vssaros-context-item="root:/repo/main"]')[0];
ck('cwd 命中主根时主根行存在', !!mainRow);
if (mainRow) {
	const mainBtn = mainRow.querySelector('[data-vssaros-wt-tip-switch]');
	ck('主根也有独立的「切换」按钮', !!mainBtn && mainBtn.tagName === 'BUTTON',
		mainBtn ? mainBtn.tagName : 'none');
	ck('主根按钮未被禁用', !!mainBtn && !mainBtn.disabled,
		mainBtn ? 'disabled=' + mainBtn.disabled : 'no button');
	ck('主根按钮写明可新建', !!mainBtn && /当前 · 新建|切换/.test(mainBtn.textContent || ''),
		(mainBtn?.textContent || '').slice(0, 40));
	if (mainBtn) { await act(async () => { mainBtn.click(); await tick(30); }); }
	ck('点主根按钮真的切到 /repo/main', switches.indexOf('/repo/main') >= 0,
		'switches=' + switches.join('|'));
}

// ⑤ ★ 2026-11-16 真机「卡在已请求」回归：宿主桥直接 reject 时，按钮不许永远停在「已请求…」
shell.bridge.switchWorktree = (p) => { switches.push(p); return Promise.reject(new Error('boom')); };
const retryBtn = qa('[data-vssaros-wt-tip] [data-vssaros-wt-tip-switch]')
	.find((b) => b.getAttribute('data-vssaros-wt-tip-state') === 'requested');
if (retryBtn) { await act(async () => { retryBtn.click(); await tick(30); }); }
ck('桥失败后按钮复位为「失败 · 重试」', !!retryBtn
	&& retryBtn.getAttribute('data-vssaros-wt-tip-state') === 'failed'
	&& /失败 · 重试/.test(retryBtn.textContent || ''),
	retryBtn ? (retryBtn.getAttribute('data-vssaros-wt-tip-state') + ' / ' + (retryBtn.textContent || '')) : 'no requested button');

await act(async () => { root.unmount(); await tick(10); });
const failed = results.filter((r) => !r.ok);
for (const r of results) { console.log((r.ok ? '  OK  ' : '  FAIL') + '  ' + r.name + (r.extra ? ' — ' + r.extra : '')); }
console.log(failed.length ? `\n${failed.length} 项失败` : `\n全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
