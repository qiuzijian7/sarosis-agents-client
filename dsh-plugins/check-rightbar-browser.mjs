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
// 2026-11-07（用户截图：右栏「开始」页没有浏览器）：官方「开始」页只列带 `guide` 的页签类型
eq('「开始」页入口（guide）', tabTypes.map(t => (t.guide || []).map(g => [g.id, g.order, g.title(), typeof g.description, typeof g.icon])),
	[[['browser', 30, '浏览器', 'function', 'function']]]);
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

// ── ⑤ 单一实例（2026-11-07，P0）：右栏显示的那一页 = browser 工具操作的那一页 ──────────────────────
// 静态守卫（反向钉住两条「不许」）：工具在右栏模式下**不得另开页 / 另开 profile**；右栏**不得 per-Bot 分区**。
// 行为由 src/vs/sessions/contrib/dshHarness/test/common/dshRightbarBrowser.test.ts 守（真 WebSocket 假中转）。
{
	const src = rel => readFileSync(path.join(repo, rel), 'utf8');
	const policy = src('src/vs/sessions/contrib/dshHarness/common/dshRightbarCdp.ts');
	const setOf = name => (new RegExp(`export const ${name}[^=]*= new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(policy)?.[1] ?? '');
	const allowed = setOf('RIGHTBAR_BROWSER_METHODS') + setOf('RIGHTBAR_PAGE_METHODS');
	truthy('⑤ 中转白名单读得到（两张表都非空）', setOf('RIGHTBAR_BROWSER_METHODS').includes('Target.getTargets') && setOf('RIGHTBAR_PAGE_METHODS').includes('Runtime.evaluate'));
	for (const banned of ['Target.createTarget', 'Target.closeTarget', 'Browser.close', 'Target.createBrowserContext', 'Target.disposeBrowserContext', 'Target.setAutoAttach']) {
		truthy(`⑤ 中转白名单不含 ${banned}（不另开看不见的页 / 不关人的视图 / 不碰浏览器）`, !allowed.includes(`'${banned}'`));
	}
	const relay = src('src/vs/sessions/contrib/dshHarness/electron-main/dshRightbarCdpRelay.ts');
	truthy('⑤ 中转只听本机 + token 握手', relay.includes(`host: '127.0.0.1'`) && relay.includes('rightbarTokenMatches(info.req.url, this._token)') && relay.includes("randomBytes(24)"));
	truthy('⑤ 中转逐条过策略（rightbarCdpRefusal）', relay.includes('rightbarCdpRefusal(request.method, request.params, request.sessionId)'));
	truthy('⑤ 中转只暴露右栏的视图（RIGHTBAR_VIEW_ID_PREFIX）', relay.includes('info.id.startsWith(RIGHTBAR_VIEW_ID_PREFIX)'));
	const app = src('src/vs/code/electron-main/app.ts');
	truthy('⑤ 主进程构造并启动中转', /new DshRightbarCdpRelay\(/.test(app) && app.includes('dshRightbarCdpRelay.start()'));
	const plugin = src('dsh-plugins/vssaros-browser/lib/core/rightbar.js');
	truthy('⑤ 插件右栏模式不建页、不关页、不碰 profile', !/'Target\.createTarget'|'Target\.closeTarget'|user-data-dir|profileDir/.test(plugin));
	truthy('⑤ 插件右栏模式下会话结束不回收任何页（ownedTargetsOf → []）', /ownedTargetsOf\(\) \{ return \[\]; \}/.test(plugin));
	const fileName = /RIGHTBAR_CDP_FILE = '([^']+)'/;
	eq('⑤ 发现文件名两侧一致', fileName.exec(plugin)?.[1], fileName.exec(policy)?.[1]);
	const host = src('dsh-plugins/vssaros-browser/lib/core/host.js').replace(/\r\n/g, '\n');
	const connection = host.slice(host.indexOf('async _connection() {'), host.indexOf('\n\t}\n', host.indexOf('async _connection() {')));
	truthy('⑤ 插件连接时先试右栏（没有页就请中转建）、再走 Chrome', connection.includes('this._tryRightbar({ create: true })') && connection.indexOf('this._tryRightbar({ create: true })') < connection.indexOf('connectPreferredEndpoint('));
	// 2026-11-07（组合方案）：只读的 status / 可用性重探只看不建；建视图只经中转自有命令，Target.createTarget 照旧拒
	const probeBody = host.slice(host.indexOf('async probe() {'), host.indexOf('\n\t}\n', host.indexOf('async probe() {')));
	truthy('⑦ status / 重探只看不建（peek，不带 create）', probeBody.includes('this._tryRightbar({ peek: true })') && !probeBody.includes('create: true'));
	eq('⑦ 建视图命令两侧同名', /RIGHTBAR_ENSURE_PAGE_METHOD = '([^']+)'/.exec(plugin)?.[1], /RIGHTBAR_ENSURE_PAGE_METHOD = '([^']+)'/.exec(policy)?.[1]);
	truthy('⑦ 中转只在右栏一页都没有时才建（共享 id、Global 登录态）', relay.includes('if (targets.size === 0) {') && relay.includes('getOrCreateBrowserView(RIGHTBAR_SHARED_VIEW_ID, { owner: { mainWindowId }, scope: BrowserViewStorageScope.Global })'));
	truthy('⑤ 右栏开着时登录不切有头 Chrome', /async ensureHeaded\(\) \{[\s\S]{0,200}if \(this\.usingRightbar\) \{ return; \}/.test(host));
	const contribution = src('src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts');
	const at = contribution.indexOf('getOrCreateLazy(RIGHTBAR_SHARED_VIEW_ID)');
	truthy('⑤ 右栏是一条共享视图（固定 id，与中转建的是同一条；不按 Bot / 会话）', at > 0 && /RIGHTBAR_SHARED_VIEW_ID = `\$\{RIGHTBAR_VIEW_ID_PREFIX\}shared`/.test(policy));
	truthy('⑤ 右栏不得 per-Bot 分区（不传 partition / 不按 Bot 拼 id）', at > 0 && !/partition|botId|bot\.id/.test(contribution.slice(Math.max(0, at - 1500), at + 400)));
}

// ── ⑥ 助手区（2026-11-07）：交接卡 + 本站时限授权 —— 假 fetch + 真 React 渲染 ─────────────────────────────
{
	eq('⑥ 主机名归一 / 授权覆盖', [test.hostOf('https://WWW.Example.com/a'), test.hostOf('file:///c:/x'), test.grantCovers('*.example.com', 'a.example.com'),
		test.grantCovers('*.example.com', 'example.com'), test.grantCovers('example.com', 'example.com')], ['www.example.com', '', true, false, true]);
	const requests = [];
	let state = { page: 'https://shop.example.com/cart', grants: [], handoffs: [
		{ id: 'H1', reason: '扫码登录', url: 'https://shop.example.com/login', kind: 'login', state: 'pending', open: true },
		{ id: 'H0', reason: '旧的', kind: 'handoff', state: 'done', open: false }] };
	const fakeFetch = async (url, init) => {
		requests.push({ url, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, credentials: init && init.credentials, body: init && init.body ? JSON.parse(init.body) : undefined });
		if (init && init.method === 'POST' && url.endsWith('/grants')) {
			const body = JSON.parse(init.body);
			state = { ...state, grants: [{ id: 'G1', host: body.host, ops: ['click'], until: new Date(Date.now() + 3600e3).toISOString() }] };
		}
		if (init && init.method === 'POST' && url.endsWith('/handoffs/act')) { state = { ...state, handoffs: [] }; }
		return { ok: true, status: 200, json: async () => state };
	};
	const savedFetch = globalThis.fetch;
	globalThis.fetch = fakeFetch; window.fetch = fakeFetch;
	try {
		const assistHost = window.document.createElement('div');
		window.document.body.appendChild(assistHost);
		const root3 = createRoot(assistHost);
		await act(async () => { root3.render(React.createElement(test.BrowserAssistant, { fallbackUrl: '' })); await tick(30); });
		truthy('⑥ 读状态走同源相对路径 + 带 cookie', requests[0]?.url === '/x/vssaros-browser/api/state' && requests[0]?.credentials === 'same-origin', JSON.stringify(requests[0]));
		truthy('⑥ 只显示未结束的交接卡', assistHost.querySelectorAll('[data-vssaros-rightbar-browser-handoff]').length === 1 && assistHost.textContent.includes('扫码登录') && !assistHost.textContent.includes('旧的'));
		truthy('⑥ 授权条用的是右栏当前页（模型导航过去的那一页）的站点', assistHost.querySelector('[data-vssaros-rightbar-browser-grants]')?.getAttribute('data-vssaros-rightbar-browser-grants') === 'shop.example.com');
		await act(async () => { assistHost.querySelector('[data-vssaros-rightbar-browser-action="grant:today"]').click(); await tick(30); });
		const grant = requests.find(r => r.method === 'POST' && r.url.endsWith('/grants'));
		eq('⑥ 点「今天」⇒ POST 本站 + today，带写操作的两个头', grant && { body: grant.body, ct: grant.headers['content-type'], mark: grant.headers['x-vssaros-browser'] },
			{ body: { host: 'shop.example.com', duration: 'today' }, ct: 'application/json', mark: '1' });
		truthy('⑥ 授权后显示「免问到…」与撤销', assistHost.textContent.includes('免问到') && !!assistHost.querySelector('[data-vssaros-rightbar-browser-action="revoke:G1"]'));
		await act(async () => { assistHost.querySelector('[data-vssaros-rightbar-browser-action="done:H1"]').click(); await tick(30); });
		eq('⑥ 点「我完成了」⇒ POST handoffs/act', requests.find(r => r.url.endsWith('/handoffs/act'))?.body, { id: 'H1', action: 'done' });
		await act(async () => { root3.unmount(); });
		// 插件没装（路由 404）⇒ 不渲染任何东西
		globalThis.fetch = window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
		const none = window.document.createElement('div');
		window.document.body.appendChild(none);
		const root4 = createRoot(none);
		await act(async () => { root4.render(React.createElement(test.BrowserAssistant, { fallbackUrl: 'https://a.com/' })); await tick(30); });
		truthy('⑥ 插件路由不在 ⇒ 助手区不渲染', none.innerHTML === '', none.innerHTML.slice(0, 120));
		await act(async () => { root4.unmount(); });
	} finally {
		globalThis.fetch = savedFetch; window.fetch = savedFetch;
	}
}

// ── ⑦ 组合方案（2026-11-07）：🌐 入口旁的交接提示 —— 人点「接管」才展开右栏（bot 不弹界面）────────────────
{
	const requests = [];
	let state = { handoffs: [] };
	const savedFetch = globalThis.fetch;
	const fake = async (url, init) => {
		requests.push({ url, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : undefined });
		if (init && init.method === 'POST' && url.endsWith('/handoffs/act')) { state = { handoffs: [{ ...state.handoffs[0], state: 'taken' }] }; }
		return { ok: true, status: 200, json: async () => state };
	};
	globalThis.fetch = fake; window.fetch = fake;
	try {
		expandClicks = 0; opened.length = 0;
		const host7 = window.document.createElement('div');
		window.document.body.appendChild(host7);
		const root7 = createRoot(host7);
		await act(async () => { root7.render(React.createElement(overlay.component)); await tick(30); });
		truthy('⑦ 没有交接 ⇒ 只有 🌐 按钮，不弹提示、不自动打开', !host7.querySelector('[data-vssaros-rightbar-browser-handoff-hint]') && !!host7.querySelector('[data-vssaros-rightbar-browser-open]') && opened.length === 0);
		await act(async () => { root7.unmount(); });
		state = { handoffs: [{ id: 'H9', reason: '扫码登录', kind: 'login', state: 'pending', open: true }, { id: 'H8', reason: '旧', state: 'done', open: false }] };
		const host8 = window.document.createElement('div');
		window.document.body.appendChild(host8);
		const root8 = createRoot(host8);
		await act(async () => { root8.render(React.createElement(overlay.component)); await tick(30); });
		const hint = host8.querySelector('[data-vssaros-rightbar-browser-handoff-hint]');
		truthy('⑦ 有没结束的交接 ⇒ 入口旁出提示（只显示未结束的）', !!hint && hint.textContent.includes('扫码登录') && !hint.textContent.includes('旧'));
		truthy('⑦ 出提示也不自动打开右栏', opened.length === 0 && expandClicks === 0);
		await act(async () => { host8.querySelector('[data-vssaros-rightbar-browser-handoff-takeover="H9"]').click(); await tick(260); });
		eq('⑦ 点「接管」⇒ POST takeover，再展开右栏 + 打开浏览器页签', [requests.find(r => r.method === 'POST')?.body, expandClicks, opened],
			[{ id: 'H9', action: 'takeover' }, 1, [test.TAB_KIND]]);
		await act(async () => { root8.unmount(); });
	} finally {
		globalThis.fetch = savedFetch; window.fetch = savedFetch;
	}
}

if (problems.length) {
	console.log(`\n✗ check-rightbar-browser：${problems.length} 项失败`);
	process.exit(1);
}
console.log('\n✓ check-rightbar-browser：右侧栏浏览器页签（注册 / 矩形 / 导航 / 卸载 / 入口）+ 单一实例（中转白名单 / 不建页 / 不分区）+ 助手区（交接卡 / 时限授权）+ 按需建视图 / 入口接管 全部通过');
process.exit(0);

function join(...parts) { return parts.join('/'); }
