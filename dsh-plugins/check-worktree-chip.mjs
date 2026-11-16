// worktree chip 三处 UI 的**真 DOM 行为守卫**（2026-11-14）
// 跑法：node dsh-plugins/check-worktree-chip.mjs
// 用 jsdom + 真 React 装载 client.worktreeChip.js，覆盖 hero 注入位置、enable/disable、
// 默认新增项、换名、宿主桥缺失时的诚实降级、跨 chunk 状态与 info chip 渲染。
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><html><head></head><body>
<div id="hero"><span id="wsChip">工作区</span><button data-vssaros-mode-seat="1">preset</button></div>
</body></html>`, { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Event = window.Event;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const act = React.act ?? (await import('react-dom/test-utils')).act;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const src = readFileSync(new URL('./vssaros-chat-surface/lib/client.worktreeChip.js', import.meta.url), 'utf8');
let captured = null;
// ⚠ 不能用 Object.assign({}, window)：jsdom 的 addEventListener 在原型上，浅拷贝会丢 ⇒
//   直接挂到真 window 上，把 window 本身作为形参传进去 ✓
window.__ModuleLoader__ = { load: (m) => { captured = m; } };
const sandboxWindow = window;
const requireFn = (spec) => {
	if (spec === 'react') { return React; }
	throw new Error('unexpected require ' + spec);
};
function loadMod() {
	captured = null;
	const module_ = { exports: {} };
	new Function('window', 'document', 'require', 'module', 'exports', src + '\nreturn module.exports;')(
		sandboxWindow, window.document, requireFn, module_, module_.exports);
	return captured.factory(requireFn);
}
const mod = loadMod();

const results = [];
const ck = (name, cond, extra) => { results.push({ name, ok: !!cond, extra: cond ? '' : (extra || '') }); };
const q = (s) => window.document.querySelector(s);
const activeOf = mod.__test.activeWorktreeOf;
ck('缺失 cwd 不显示已选择但未进入的名称', activeOf(null, [], { name: 'planned', path: '/repo/planned' }) === null);
ck('Windows 路径大小写和分隔符归一化', activeOf('G:\\Repo\\WT\\', [{ path: 'g:/repo/wt', name: 'wt-name' }], null)?.name === 'wt-name');
ck('POSIX 路径大小写不同不能匹配', activeOf('/repo/WT', [{ path: '/repo/wt', name: 'other' }], null) === null);
ck('主目录不冒充 worktree', activeOf('/repo', [{ path: '/repo', isMain: true, name: 'main' }], null) === null);
ck('预选路径与 cwd 不同不显示随机名称', activeOf('/repo', [], { name: 'planned', path: '/other' }) === null);

window.document.documentElement.dataset.vssarosWorktrees = JSON.stringify([
	{ path: '/repo/main', name: 'main', branch: 'main', isMain: true },
	{ path: '/repo/wt1', name: 'wt1', branch: 'feature/design' }
]);

const notes = [];
let infoComp = null;
const regs = [];
const sessionListeners = new Set();
let sessionRows = { 's-a': { cwd: '/repo/main' } };
const sessions = { list: {
	getSnapshot: () => ({ byId: sessionRows }),
	subscribe: (fn) => { sessionListeners.add(fn); return () => sessionListeners.delete(fn); },
} };
const ctx = {
	get: (name) => name === 'sessions' ? sessions : undefined,
	slots: {
		inject: (_slot, fn) => fn(),
		register: (opts, comp) => { regs.push({ opts, comp }); if (opts.id === 'vssaros-wt-info-chip') { infoComp = comp; } return opts; },
	},
};
const shell = { state: { sessionId: 's-a' }, bridge: {
	notify: (_kind, text) => notes.push(text),
	switchWorktree: (path) => { shell.bridge.lastSwitch = path; return Promise.resolve(); },
} };
mod.install(ctx, shell);

// ① 注入位置：checkbox 在 preset chip 之前
const hero = q('#hero');
const kids = Array.from(hero.children).map((e) => e.getAttribute('data-vssaros-wt-checkbox') ? 'wt' : (e.getAttribute('data-vssaros-mode-seat') ? 'preset' : 'other'));
ck('hero 顺序 = 工作区 → checkbox → preset', kids.join(',') === 'other,wt,preset', kids.join(','));
const box = q('[data-vssaros-wt-checkbox]');
ck('有 git ⇒ enable', box.getAttribute('aria-disabled') === 'false' && !box.querySelector('input').disabled);

// ② 无 git ⇒ disable
delete window.document.documentElement.dataset.vssarosWorktrees;
window.document.dispatchEvent(new window.Event('vssaros-dsh-worktrees'));
ck('无 git ⇒ disable', box.getAttribute('aria-disabled') === 'true' && box.querySelector('input').disabled);

// ③ 恢复推送 ⇒ 勾选 ⇒ 默认项
window.document.documentElement.dataset.vssarosWorktrees = JSON.stringify([
	{ path: '/repo/main', name: 'main', branch: 'main', isMain: true },
	{ path: '/repo/wt1', name: 'wt1', branch: 'feature/design' }
]);
window.document.dispatchEvent(new window.Event('vssaros-dsh-worktrees'));
const input = box.querySelector('input');
await act(async () => { input.click(); });
const menu = box.querySelector('.vssaros-wt-menu');
const opts = Array.from(menu.querySelectorAll('.vssaros-wt-opt'));
ck('菜单含默认新增项 + 2 常驻项', !menu.hidden && opts.length === 3, 'opts=' + opts.length);
ck('第一项是新增 worktree', opts[0].getAttribute('data-wt-id') === 'new' && opts[0].classList.contains('vssaros-wt-opt-new'));
ck('默认项带「默认」标签与换名按钮', !!opts[0].querySelector('.vssaros-wt-new-tag') && !!opts[0].querySelector('[data-rename]'));
const nameBefore = opts[0].querySelector('small').textContent.split(' · ')[0];
await act(async () => { opts[0].querySelector('[data-rename]').click(); });
const nameAfter = box.querySelector('.vssaros-wt-menu .vssaros-wt-opt-new small').textContent.split(' · ')[0];
ck('换名生成新名字', nameBefore !== nameAfter && /^(feat|fix|refactor|chore)\/[a-z0-9-]+-[0-9a-f]{4}$/.test(nameAfter), nameAfter);

// ④ 缺 createWorktree 桥 ⇒ 明确提示、不写成功状态
await act(async () => { box.querySelector('.vssaros-wt-menu .vssaros-wt-opt-new').click(); });
ck('无 createWorktree 桥 ⇒ 明确 notify', notes.some((n) => n.includes('不支持新建 worktree')), notes.join('|'));
ck('无 createWorktree 桥 ⇒ 不写成功状态', !window.document.documentElement.dataset.vssarosWorktreeChip);

// ⑤ 点常驻项 ⇒ 切目录 + 跨 chunk 状态
await act(async () => { input.click(); box.querySelector('[data-wt-id="wt:/repo/wt1"]').click(); });
const chip = JSON.parse(window.document.documentElement.dataset.vssarosWorktreeChip || 'null');
ck('常驻项切换写入状态', chip && chip.name === 'feature/design' && chip.path === '/repo/wt1', JSON.stringify(chip));
ck('调 bridge.switchWorktree', shell.bridge.lastSwitch === '/repo/wt1');

// ⑥ 真机「hero 输入框不显示 worktree chip」：先在有 ModeSeat 的 hero 下渲染 ⇒ 不出现；
//    再移除 ModeSeat（模拟进入会话页）⇒ MutationObserver 触发后出现，并显示分支名。
const host = window.document.createElement('div');
window.document.body.appendChild(host);
const root = createRoot(host);
await act(async () => { root.render(React.createElement(infoComp)); await tick(20); });
ck('hero 输入框不显示 worktree chip', !host.querySelector('[data-vssaros-wt-info]'));
const seat = q('[data-vssaros-mode-seat="1"]');
if (seat) { seat.remove(); }
await act(async () => { await tick(30); });
ck('仅预选 worktree、cwd 仍在主目录时不冒充已进入', !host.querySelector('[data-vssaros-wt-info]'));
await act(async () => {
	sessionRows['s-a'].cwd = '/repo/wt1';
	for (const fn of sessionListeners) { fn(); }
});
const activeInfo = host.querySelector('[data-vssaros-wt-info]');
ck('会话进入 worktree 后信息 chip 显示实际名称', !!activeInfo && activeInfo.querySelector('.nm').textContent === 'wt1');
ck('信息 chip 为只读且无按钮焦点', !!activeInfo && activeInfo.getAttribute('data-vssaros-wt-readonly') === '1'
	&& !activeInfo.hasAttribute('role') && !activeInfo.hasAttribute('tabindex'));
ck('信息 chip 不再显示硬编码 slides', !!activeInfo && !activeInfo.querySelector('.rt'));
menu.hidden = true;
const switchBefore = shell.bridge.lastSwitch;
if (activeInfo) { await act(async () => { activeInfo.click(); activeInfo.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }); }
ck('点击名称不会打开开关或切换会话', menu.hidden && shell.bridge.lastSwitch === switchBefore);

// checkbox 意图不覆盖已在工作中的会话事实。
await act(async () => { input.click(); });
ck('取消勾选清空预选状态', !window.document.documentElement.dataset.vssarosWorktreeChip);
ck('取消勾选不抹掉当前会话的实际 worktree 名称', host.querySelector('.nm')?.textContent === 'wt1');
await act(async () => {
	sessionRows['s-a'].cwd = '/repo/main';
	for (const fn of sessionListeners) { fn(); }
});
ck('主目录不显示 worktree 开关占位', !host.querySelector('[data-vssaros-wt-info]'));

// 新建成功但 cwd 未切换时不能显示随机名，发送后换绑才展示它。
shell.bridge.createWorktree = async () => ({ path: '/repo/new-worktree' });
await act(async () => { input.click(); box.querySelector('.vssaros-wt-opt-new').click(); await tick(10); });
const createdSelection = JSON.parse(window.document.documentElement.dataset.vssarosWorktreeChip);
ck('创建返回的路径和名字被保存', createdSelection?.path === '/repo/new-worktree' && !!createdSelection.name);
ck('新建目录尚未进入会话时隐藏名称', !host.querySelector('[data-vssaros-wt-info]'));
await act(async () => {
	sessionRows['s-new'] = { cwd: '/repo/new-worktree' };
	window.document.dispatchEvent(new window.CustomEvent('vssaros-dsh-rebind', { detail: { sessionId: 's-new' } }));
});
const newInfo = host.querySelector('[data-vssaros-wt-info]');
ck('发送进入新会话后显示新建 worktree 名称', !!newInfo && newInfo.querySelector('.nm').textContent === createdSelection.name);
ck('新建 worktree 名称仍是只读信息', !!newInfo && !newInfo.hasAttribute('role') && !!newInfo.querySelector('.eph'));
await act(async () => {
	window.document.documentElement.dataset.vssarosWorktrees = JSON.stringify([{ path: '/repo/new-worktree', name: 'actual-host-name', branch: 'feat/different' }]);
	window.document.dispatchEvent(new window.Event('vssaros-dsh-worktrees'));
});
ck('宿主推送到达后显示真实 name 而非分支名', host.querySelector('.nm')?.textContent === 'actual-host-name');
await act(async () => {
	window.document.dispatchEvent(new window.CustomEvent('vssaros-dsh-rebind', { detail: { sessionId: 's-missing' } }));
});
ck('未知会话不沿用上一会话名称', !host.querySelector('[data-vssaros-wt-info]'));
await act(async () => {
	sessionRows['s-missing'] = { cwd: '/repo/new-worktree' };
	for (const fn of sessionListeners) { fn(); }
});
ck('会话快照晚到后刷新只读名称', host.querySelector('.nm')?.textContent === 'actual-host-name');
window.document.documentElement.dataset.vssarosWorktrees = JSON.stringify([
	{ path: '/repo/main', name: 'main', isMain: true }, { path: '/repo/wt1', name: 'wt1' }
]);

// ⑨ ★ 真机「hero 出现两枚 worktree checkbox」回归：apply 重跑会让 install 再执行一次。
//   全局单例必须保证页面上仍只有一枚（并刷新 bridge / 重注册槽，不重复注入 DOM/监听）。
const ATTR = '[' + mod.__test.ROOT_ATTR + ']';
const beforeDup = window.document.querySelectorAll(ATTR).length;
const shell2 = { state: {}, bridge: { notify: () => {} } };
mod.install(ctx, shell2);
await act(async () => { await tick(30); });
const afterDup = window.document.querySelectorAll(ATTR).length;
ck('重复 install 不产生第二枚 checkbox', beforeDup === 1 && afterDup === 1,
	'before=' + beforeDup + ' after=' + afterDup);
ck('重复 install 只刷新引用、不重复初始化', shell2.state.vssarosWtChipReinstalls === 1
	&& !!(window.__vssarosWtChipSingleton && window.__vssarosWtChipSingleton.reinstalls === 1),
	'reinstalls=' + shell2.state.vssarosWtChipReinstalls);
ck('重复 install 后 notify 走新桥', window.__vssarosWtChipSingleton.bridge === shell2.bridge);
const infoRegs = regs.filter((r) => r.opts && r.opts.id === 'vssaros-wt-info-chip');
ck('apply 重跑重新注册槽但复用同一组件', infoRegs.length === 2 && infoRegs[0].comp === infoRegs[1].comp,
	'regs=' + infoRegs.length);

// ⑩ 真机「有会话页缺 worktree chip」回归：会话页只有工作区 chip 锚点、没有 ModeSeat。
//   ⚠ 这里要模拟**新页面/新 loader** ⇒ 清掉全局单例，否则第二个实例会被单例挡住。
window.__vssarosWtChipSingleton = null;
q('#hero').remove();
const headerRow = window.document.createElement('div');
const wsChip = window.document.createElement('button');
wsChip.setAttribute('data-vssaros-context-chip', '1'); wsChip.textContent = '工作区';
headerRow.appendChild(wsChip);
window.document.body.appendChild(headerRow);
const mod2 = loadMod();
mod2.install({ slots: { inject: (_s, fn) => fn(), register: (o) => o } },
	{ state: {}, bridge: { notify: () => {} } });
const hk = Array.from(headerRow.children).map((e) => e.getAttribute('data-vssaros-wt-checkbox') ? 'wt' : 'ws');
ck('会话页顺序 = 工作区 chip → checkbox', hk.join(',') === 'ws,wt', hk.join(','));
ck('会话页 checkbox 的 enable 态', headerRow.querySelector('[data-vssaros-wt-checkbox]')
	&& headerRow.querySelector('[data-vssaros-wt-checkbox]').getAttribute('aria-disabled') === 'false');

await act(async () => { root.unmount(); });
ck('卸载信息 chip 清理会话快照订阅', sessionListeners.size === 0);
const failed = results.filter((r) => !r.ok);
for (const r of results) { console.log((r.ok ? '  OK  ' : '  FAIL') + '  ' + r.name + (r.extra ? ' — ' + r.extra : '')); }
console.log(failed.length ? `\n${failed.length} 项失败` : `\n全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
