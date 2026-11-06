// 右侧栏内嵌浏览器：行为守卫（2026-11-05，用户要求「不做隔离，只在右侧栏显示浏览器内容」）。
//
// 真加载 client.rightbarBrowser.js + 真 React/jsdom 挂页签体，断言：
//   ① 页签类型 / keyed 页签体 / 常驻入口三处注册；
//   ② 页签体 mount 上报占位矩形，ResizeObserver 跟 bounds，navigate 只发 http(s) URL，卸载发 unmount；
//   ③ URL 归一化拒绝非 http(s) 协议；
//   ④ 点常驻入口 ⇒ 展开右栏并打开浏览器页签。
//
// 跑法：node dsh-plugins/check-rightbar-browser.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let React; let createRoot; let act;
try {
	React = (await import('react')).default;
	({ createRoot } = await import('react-dom/client'));
	act = React.act ?? (await import('react-dom/test-utils')).act;
} catch (e) {
	console.log('  ✗ 缺少 react / react-dom / jsdom：' + String((e && e.message) || e).split('\n')[0]);
	process.exit(1);
}

const repo = process.cwd();
const problems = [];
const ok = (name) => console.log('  ✓ ' + name);
const fail = (msg) => { problems.push(String(msg)); console.log('  ✗ ' + String(msg)); };
const eq = (name, actual, expected) => {
	const a = JSON.stringify(actual); const e = JSON.stringify(expected);
	if (a === e) { ok(name); } else { fail(name + '：期望 ' + e + '，实际 ' + a); }
};
const truthy = (name, cond, detail) => { if (cond) { ok(name); } else { fail(name + (detail ? '：' + detail : '')); } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ── 假宿主桥 ────────────────────────────────────────────────────────────────────
const calls = [];
const bridge = {
	bridgeVersion: 26,
	surface: 'chat',
	chatOnly: false,
	viewId: 'dsh-chat-w1-test',
	rightbarBrowser: (action, options) => { calls.push({ action, options }); return Promise.resolve(true); },
};
Object.defineProperty(window, 'vssarosDsh', { value: bridge, configurable: true, writable: true });
globalThis.ResizeObserver = class {
	constructor(fn) { this.fn = fn; }
	observe() { this.fn([]); }
	disconnect() { }
};
window.ResizeObserver = globalThis.ResizeObserver;
window.HTMLElement.prototype.getBoundingClientRect = function () {
	return { left: 12, top: 34, right: 312, bottom: 434, width: 300, height: 400, x: 12, y: 34, toJSON: () => ({}) };
};
const expand = window.document.createElement('button');
expand.setAttribute('data-sidebar-right-expand', '1');
let expandClicks = 0;
expand.click = () => { expandClicks += 1; };
window.document.body.appendChild(expand);

// ── 真装载 chunk ────────────────────────────────────────────────────────────────
let chunk = null;
window.__ModuleLoader__ = { load: (m) => { chunk = m; } };
const fakeRequire = (name) => { if (name === 'react') { return React; } throw new Error('unexpected require: ' + name); };
new Function('window', 'require', readFileSync(path.join(repo, 'dsh-plugins', 'vssaros-chat-surface', 'lib', 'client.rightbarBrowser.js'), 'utf8'))(window, fakeRequire);
truthy('chunk 调用 __ModuleLoader__.load', !!chunk && typeof chunk.factory === 'function');
const part = chunk.factory(fakeRequire);
const test = part.__test;

eq('页签常量', [test.TAB_KIND, test.SLOT_RIGHT_TAB, test.SLOT_OVERLAY, test.OVERLAY_ID, test.OVERLAY_ORDER, test.BRIDGE_VERSION],
	['vssaros-rightbar-browser', 'sidebar.right.pane.tab', 'shell.overlay', 'vssaros-rightbar-browser-open', 103, 26]);
eq('URL 归一化：完整 https / 裸域名 / 拒绝危险协议',
	[test.normalizeUrl('https://example.com/a'), test.normalizeUrl('example.com'), test.normalizeUrl('javascript:alert(1)'), test.normalizeUrl('file:///etc/passwd')],
	['https://example.com/a', 'https://example.com/', '', '']);
eq('rectOf 只取非负整数矩形', test.rectOf({ getBoundingClientRect: () => ({ left: -5, top: 7.4, width: 100.6, height: 20 }) }),
	{ x: 0, y: 7, width: 101, height: 20 });

// ── 假 ctx：真调 install ────────────────────────────────────────────────────────
const registrations = [];
const tabTypes = [];
const opened = [];
const ctx = {
	slots: {
		inject: (_name, fn) => fn(),
		register: (options, component) => { registrations.push({ options, component }); return () => undefined; },
	},
	sidebarRightTabs: { register: (entry) => { tabTypes.push(entry); return () => undefined; } },
	sidebarRight: { openTab: (id) => { opened.push(id); } },
	effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : undefined; },
};
const state = {};
part.install(ctx, { bridge, state });
eq('页签类型已登记（id/kind/title）', tabTypes.map(t => [t.id, t.kind, t.priority, t.title()]),
	[['vssaros-rightbar-browser', 'vssaros-rightbar-browser', 'extension', '浏览器']]);
const pane = registrations.find(r => r.options && r.options.name === test.SLOT_RIGHT_TAB);
truthy('右栏页签体注册在 keyed 槽且 key = tab kind', !!pane && pane.options.key === test.TAB_KIND);
const overlay = registrations.find(r => r.options && r.options.id === test.OVERLAY_ID);
truthy('常驻入口注册在 shell.overlay（带 id/order）', !!overlay && overlay.options.name === test.SLOT_OVERLAY && overlay.options.order === 103);
truthy('桥可用被记进诊断状态', state.vssarosRightbarBrowser === true);

// ── 真渲染页签体：mount / bounds / navigate / unmount ───────────────────────────
calls.length = 0;
const container = window.document.getElementById('root');
const root = createRoot(container);
await act(async () => { root.render(React.createElement(pane.component)); await tick(20); });
const mount = calls.find(c => c.action === 'mount');
truthy('页签体挂载 ⇒ 上报 mount + 占位矩形', !!mount && mount.options.rect.width === 300 && mount.options.rect.height === 400, JSON.stringify(calls));
truthy('ResizeObserver ⇒ 上报 bounds', calls.some(c => c.action === 'bounds' && c.options.rect.width === 300));

const input = container.querySelector('[data-vssaros-rightbar-browser-url]');
truthy('地址栏渲染出来', !!input);
await act(async () => {
	Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'example.com/a');
	input.dispatchEvent(new window.Event('input', { bubbles: true }));
	await tick(10);
});
await act(async () => {
	container.querySelector('[data-vssaros-rightbar-browser-bar]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
	await tick(20);
});
const nav = calls.find(c => c.action === 'navigate');
truthy('回车导航 ⇒ 只发归一化后的 https URL', !!nav && nav.options.url === 'https://example.com/a', JSON.stringify(calls));
truthy('导航后页签体重新 mount（带当前 URL）', calls.filter(c => c.action === 'mount').some(c => c.options.url === 'https://example.com/a'));
await act(async () => { root.unmount(); await tick(10); });
truthy('页签体卸载 ⇒ 上报 unmount', calls.some(c => c.action === 'unmount'));

// ── 常驻入口点击 ────────────────────────────────────────────────────────────────
const overlayHost = window.document.createElement('div');
window.document.body.appendChild(overlayHost);
const root2 = createRoot(overlayHost);
await act(async () => { root2.render(React.createElement(overlay.component)); await tick(10); });
const button = window.document.querySelector('[data-vssaros-rightbar-browser-open]');
truthy('常驻入口按钮渲染出来', !!button);
await act(async () => { button.click(); await tick(220); });
eq('点入口 ⇒ 展开右栏 + 打开浏览器页签', [expandClicks, opened], [1, [test.TAB_KIND]]);
await act(async () => { root2.unmount(); });

if (problems.length) {
	console.log(`\n✗ check-rightbar-browser：${problems.length} 项失败`);
	process.exit(1);
}
console.log('\n✓ check-rightbar-browser：右侧栏浏览器页签（注册 / 矩形 / 导航 / 卸载 / 入口）全部通过');
process.exit(0);

function join(...parts) { return parts.join('/'); }
