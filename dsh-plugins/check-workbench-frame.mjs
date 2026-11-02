// 工作台宿主外框（`vssaros-workbenches` 的 `Frame`）的**行为级**守卫 —— 浮动工具栏（S2 一体条）。
//
// 为什么要它（2026-11-02，用户连报「工作台中浮动工具栏丢失」）：
//   此前对胶囊的守卫全是**源码字符串**断言（`check-assistant-collapse`：正则匹配 `className: 'vssWbActions'`），
//   只能证明「代码里写了」，证明不了「真渲染出来了」。排查时因此无法回答最基本的一问：
//   **同一份宿主代码，真 React 渲染一个知识库形态的工作台，胶囊到底在不在 DOM 里？**
//   ⇒ 这里用**真 React 18 + jsdom** 装起宿主 `client.js`，走与 chat-surface 页签**同一条**渲染路径
//     （`service.View({ id, active })` ⇒ `Frame`），断言到 DOM。
//
// 能证明的：胶囊在 / 两个按钮在 / 样式已注入 / 描述符默认值不会把它关掉 / `floatingActions:false` 才会关 /
//           组件拿到的 props（customFrame 有 conversation、标准分栏没有）。
// 证明不了的（jsdom 没有布局引擎）：位置、尺寸、被别的元素盖住 —— 那些由运行时自检上报（见宿主的 reportActions）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

// ⚠ 加载顺序是硬约束（见 check-sessions-workbench.mjs 的同名注释）：先挂 jsdom 全局，再动态 import React。
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://127.0.0.1:1/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// 浏览器里 MutationObserver 是全局；宿主代码直接用它 ⇒ 测试沙箱要补上，否则观察器路径根本没被跑到
globalThis.MutationObserver = window.MutationObserver;
globalThis.ResizeObserver = window.ResizeObserver || class { observe() { } unobserve() { } disconnect() { } };
let React; let ReactDOM; let createRoot; let act;
try {
	React = (await import('react')).default;
	ReactDOM = (await import('react-dom')).default;
	({ createRoot } = await import('react-dom/client'));
	// React 18.3 起 `react-dom/test-utils` 的 act 被标为废弃（每次都刷一行警告）⇒ 有 `React.act` 就用它
	act = typeof React.act === 'function' ? React.act : (await import('react-dom/test-utils')).act;
} catch (e) {
	console.log('  ✗ 缺少 react / react-dom（本守卫的隐含依赖，原本靠 hoist 带来）：' + String((e && e.message) || e).split('\n')[0]);
	process.exit(1);
}

const repo = process.cwd();
let problems = 0;
const ok = (n) => console.log('  ✓ ' + n);
const fail = (n, d) => { problems += 1; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); };
const truthy = (n, c, d) => (c ? ok(n) : fail(n, d));
const eq = (n, a, e) => (JSON.stringify(a) === JSON.stringify(e) ? ok(n) : fail(n, '期望 ' + JSON.stringify(e) + '，实际 ' + JSON.stringify(a)));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const h = React.createElement;

console.log('[check-workbench-frame] 宿主外框 · 浮动工具栏（真 React + jsdom）');

const { emptyState } = await import(pathToFileURL(join(repo, 'dsh-plugins/vssaros-workbenches/lib/state.js')).href);

// ── 装载宿主 client.js（真 factory）────────────────────────────────────────────────
const SRC = readFileSync(join(repo, 'dsh-plugins/vssaros-workbenches/lib/client.js'), 'utf8');
let host = null;
{
	const req = (name) => { if (name === 'react') { return React; } if (name === 'react-dom') { return ReactDOM; } throw new Error('unexpected require ' + name); };
	window.__ModuleLoader__ = { load: (m) => { host = m.factory(req); } };
	// 宿主源码里写的是 `window.__ModuleLoader__` / `document` / `globalThis`：按 jsdom 的传进去
	new Function('window', 'document', 'globalThis', SRC)(window, window.document, globalThis);
}
truthy('能装起宿主 client.js（拿到 apply / __Frame）', !!host && typeof host.apply === 'function' && typeof host.__Frame === 'function');
if (!host) { process.exit(1); }

/** 一个最小的宿主 ctx：只实现 `apply()` 与渲染真正会碰的那部分。 */
function makeEnv() {
	const panels = new Map();
	const provided = {};
	const savedFetch = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ revision: 0, state: emptyState() }) });
	const ctx = {
		effect: (fn) => fn(),
		slots: { register: (opts, comp) => { if (opts && opts.name === 'main') { panels.set(opts.key, comp); } return () => { }; }, inject: (_n, f) => f() },
		layout: { selectPanel: () => { }, toggleSidebar: () => { } },
		reflect: { provide: (name, svc) => { provided[name] = svc; return () => { }; } },
		sessions: { retain: () => ({ release() { }, ready: Promise.resolve() }) },
		workspaces: {},
		uiWorkspace: { openSession: () => Promise.resolve(), startSession: () => Promise.resolve() },
	};
	host.apply(ctx);
	return { ctx, panels, service: provided.desktopWorkbenches, restore: () => { globalThis.fetch = savedFetch; } };
}

/** 渲染一个节点，返回 { container, unmount }。 */
async function mount(node) {
	const container = window.document.createElement('div');
	window.document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => { root.render(node); await tick(5); });
	return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

const q = (c, s) => c.querySelector(s);

// ── ① 知识库形态：customFrame:true，走 chat-surface 页签的那条路径（service.View）────────────
{
	const env = makeEnv();
	try {
		truthy('① apply 之后宿主服务已提供（desktopWorkbenches）', !!env.service && typeof env.service.register === 'function');
		let received = null;
		const KbLike = (props) => { received = props; return h('div', { id: 'kb-body', 'data-vssaros-assist-collapsed': '0' }, 'kb', props.conversation); };
		env.service.register({ title: '知识库', description: 'd', repository: 'vssaros:kb', icon: 'codicon:book', customFrame: true }, KbLike);
		const m = await mount(h(env.service.View, { id: 'vssaros/kb', active: true }));
		const frame = q(m.container, '[data-vssaros-workbench="vssaros/kb"]');
		truthy('① 渲染出宿主外框（.vssWbFrame）', !!frame && /vssWbFrame/.test(frame.className));
		const caps = m.container.querySelectorAll('[data-vssaros-wb-actions]');
		eq('① 胶囊（浮动工具栏）恰好 1 个，且就在外框里', [caps.length, !!(frame && frame.contains(caps[0]))], [1, true]);
		const cap = caps[0];
		truthy('① 胶囊带「AI 助手」按钮', !!(cap && cap.querySelector('[data-vssaros-wb-assist="vssaros/kb"]')));
		truthy('① 胶囊带「在浏览器打开」按钮', !!(cap && cap.querySelector('[data-vssaros-wb-open-external="vssaros/kb"]')));
		truthy('① 胶囊 className 就是 vssWbActions（CSS 靠它命中）', !!cap && cap.className.split(/\s+/).includes('vssWbActions'));
		truthy('① 胶囊挂载后 mountActions 跑过（data-assist 被同步成 0/1，不是初始 none）',
			!!cap && (cap.getAttribute('data-assist') === '0' || cap.getAttribute('data-assist') === '1'), String(cap && cap.getAttribute('data-assist')));
		truthy('① customFrame ⇒ 组件拿到 conversation 与 active（kb 靠它放右侧对话）', !!received && 'conversation' in received && received.active === true);
		// 样式：胶囊的位置全靠这段 CSS，没注入 ⇒ 胶囊是一块无样式的静态元素（视觉上等于"没有"）
		const style = window.document.getElementById('vssaros-workbenches-style');
		truthy('① 宿主样式已注入 <style id="vssaros-workbenches-style">', !!style);
		const css = style ? style.textContent : '';
		truthy('① 样式里 .vssWbActions 是绝对定位、贴右、垂直居中、置顶',
			/\.vssWbActions\s*\{[^}]*position:absolute;[^}]*right:12px;[^}]*top:50%/.test(css) && /z-index:2147482000/.test(css));
		truthy('① 外框是定位上下文（.vssWbFrame{position:relative}）—— 否则胶囊以更外层为基准飘走',
			/\.vssWbFrame\s*\{[^}]*position:relative/.test(css));
		await m.unmount();
	} finally { env.restore(); }
}

// ── ② 标准分栏（不写 customFrame 的默认）也有胶囊，且没有 conversation prop ────────────────────
{
	const env = makeEnv();
	try {
		let received = null;
		const Plain = (props) => { received = props; return h('div', null, 'plain'); };
		env.service.register({ title: '普通', repository: 'vssaros:plain' }, Plain);
		const m = await mount(h(env.service.View, { id: 'vssaros/plain', active: false }));
		eq('② 标准分栏：胶囊 1 个', m.container.querySelectorAll('[data-vssaros-wb-actions]').length, 1);
		truthy('② 标准分栏：宿主自己渲染左右分栏（.vssWbSplit）', !!q(m.container, '.vssWbSplit'));
		truthy('② 标准分栏：组件没有 conversation prop（对话由宿主放在左栏）', !!received && !('conversation' in received));
		await m.unmount();
	} finally { env.restore(); }
}

// ── ③ 只有显式 floatingActions:false 才关；默认值与其它字段都不能把它关掉 ─────────────────────
{
	const env = makeEnv();
	try {
		const C = () => h('div', null, 'x');
		env.service.register({ title: '关', repository: 'vssaros:off', floatingActions: false }, C);
		const off = await mount(h(env.service.View, { id: 'vssaros/off', active: false }));
		eq('③ floatingActions:false ⇒ 没有胶囊（scheduler / loop 就是这样关的）', off.container.querySelectorAll('[data-vssaros-wb-actions]').length, 0);
		await off.unmount();
		// 各种"看起来无关"的写法都不应误关：undefined / true / 缺省 / 非布尔真值
		for (const [label, extra] of [['缺省', {}], ['undefined', { floatingActions: undefined }], ['true', { floatingActions: true }], ['字符串 "false"（非布尔）', { floatingActions: 'false' }], ['0', { floatingActions: 0 }]]) {
			const id = 'x' + label.length + Math.abs([...label].reduce((a, c) => a + c.charCodeAt(0), 0));
			env.service.register({ title: label, repository: 'vssaros:' + id.toLowerCase().replace(/[^a-z0-9]/g, '') + 'z', ...extra }, C);
			const wbId = 'vssaros/' + id.toLowerCase().replace(/[^a-z0-9]/g, '') + 'z';
			const m = await mount(h(env.service.View, { id: wbId, active: false }));
			eq('③ floatingActions ' + label + ' ⇒ 仍有胶囊（只有严格 === false 才关）', m.container.querySelectorAll('[data-vssaros-wb-actions]').length, 1);
			await m.unmount();
		}
	} finally { env.restore(); }
}

// ── ④ 经 slots 注册的 main 面板（IDE 里点图标走的那条）也有胶囊 ────────────────────────────────
{
	const env = makeEnv();
	try {
		env.service.register({ title: '面板', repository: 'vssaros:panel', customFrame: true }, () => h('div', null, 'p'));
		const Panel = env.panels.get('vssaros-wb:vssaros/panel');
		truthy('④ main 面板已按 key 注册（vssaros-wb:<身份>）', typeof Panel === 'function');
		if (Panel) {
			const m = await mount(h(Panel));
			eq('④ 经 main 面板渲染 ⇒ 胶囊 1 个', m.container.querySelectorAll('[data-vssaros-wb-actions]').length, 1);
			await m.unmount();
		}
	} finally { env.restore(); }
}

// ── ⑤ 运行时自检（diagnoseActions）：jsdom 没有布局引擎 ⇒ 打桩 getBoundingClientRect / elementFromPoint ──
// 它存在的原因：胶囊在 DOM 里却"看不到"（在面板外 / 尺寸 0 / 被盖住 / 被祖先裁掉）只能在真实浏览器里量；
// 用户机器上量到什么，就通过 console.warn 镜像进 main.log。⇒ 这条自检**自己**不能坏，否则排查又回到猜。
{
	const env = makeEnv();
	const proto = window.HTMLElement.prototype;
	const origRect = proto.getBoundingClientRect;
	const origWarn = console.warn;
	const origEfp = window.document.elementFromPoint;
	let capsuleRect = { left: 756, top: 271, width: 32, height: 58 };
	const mk = (r) => ({ left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top });
	proto.getBoundingClientRect = function () {
		if (this.classList && this.classList.contains('vssWbFrame')) { return mk({ left: 0, top: 0, width: 800, height: 600 }); }
		if (this.hasAttribute && this.hasAttribute('data-vssaros-wb-actions')) { return mk(capsuleRect); }
		return mk({ left: 0, top: 0, width: 0, height: 0 });
	};
	const warns = [];
	console.warn = (...a) => { warns.push(a.join(' ')); };
	const registered = new Set();
	const probe = async (id, { rect, cover } = {}) => {
		capsuleRect = rect || { left: 756, top: 271, width: 32, height: 58 };
		window.document.elementFromPoint = cover === undefined ? () => window.document.querySelector('[data-vssaros-wb-actions="' + id + '"]') : () => cover;
		warns.length = 0;
		// 同一个身份只能注册一次（宿主的重复注册保护）⇒ 再次探测同一个工作台时只重新挂载，不重新注册
		if (!registered.has(id)) {
			registered.add(id);
			env.service.register({ title: id, repository: 'vssaros:' + id.split('/')[1], customFrame: true }, () => h('div', null, 'x'));
		}
		const m = await mount(h(env.service.View, { id, active: false }));
		await act(async () => { await tick(1100); });
		const line = warns.find(w => w.includes('浮动工具栏自检 ' + id)) || '';
		await m.unmount();
		return line;
	};
	try {
		const normal = await probe('vssaros/diagok');
		truthy('⑤ 正常：胶囊在外框内且没被盖住 ⇒ 上报「正常」并带上几何', /自检 vssaros\/diagok：正常/.test(normal) && /胶囊 756,271 32x58/.test(normal) && /外框 0,0 800x600/.test(normal), normal.slice(0, 200));
		const outside = await probe('vssaros/diagout', { rect: { left: 2400, top: 271, width: 32, height: 58 } });
		truthy('⑤ 落在外框外（位置存档 / 外框比可见区大）⇒ 上报异常', /异常/.test(outside) && /(落在外框之外|整体在窗口可见区之外)/.test(outside), outside.slice(0, 200));
		const zero = await probe('vssaros/diagzero', { rect: { left: 0, top: 0, width: 0, height: 0 } });
		truthy('⑤ 胶囊尺寸为 0 ⇒ 上报异常', /异常/.test(zero) && /尺寸为 0/.test(zero), zero.slice(0, 200));
		const cover = window.document.createElement('section'); cover.className = 'someOverlay';
		const covered = await probe('vssaros/diagcover', { cover });
		truthy('⑤ 中心点被别的元素盖住 ⇒ 上报异常，并点名是谁', /异常/.test(covered) && /被 section\.someOverlay 盖住/.test(covered), covered.slice(0, 200));
		const again = await probe('vssaros/diagok');
		truthy('⑤ 同一个工作台每次页面加载只上报一次（不刷屏）', again === '', again.slice(0, 120));
		truthy('⑤ 结果也留在 window.__vssarosWbActionsDiag（控制台可读）', Array.isArray(window.__vssarosWbActionsDiag) && window.__vssarosWbActionsDiag.length === 4, String(window.__vssarosWbActionsDiag && window.__vssarosWbActionsDiag.length));
	} finally {
		proto.getBoundingClientRect = origRect; console.warn = origWarn; window.document.elementFromPoint = origEfp; env.restore();
	}
}

// ── ⑥ 加载态（方案 D：极简呼吸点）：慢组件先显示加载态，挂上后淡出卸载 ──────────────────────
// 用户报「大型工作台第一次打开时加载比较慢」——这层要挡的是"组件还没挂上"的空白期。
{
	const env = makeEnv();
	try {
		// 慢组件：首帧返回 null（模拟 chunk 还没到），220ms 后才渲染内容
		const Slow = () => {
			const [ready, setReady] = React.useState(false);
			React.useEffect(() => { const t = setTimeout(() => setReady(true), 220); return () => clearTimeout(t); }, []);
			return ready ? h('div', { 'data-slow-ready': '' }, '内容') : null;
		};
		env.service.register({ title: '商城工作台', repository: 'vssaros:marketplace', customFrame: true }, () => h(Slow, null));
		const m = await mount(h(env.service.View, { id: 'vssaros/marketplace', active: true }));
		const gate = q(m.container, '[data-vssaros-wb-loading]');
		truthy('⑥ 组件还没挂上时显示加载态', !!gate);
		truthy('⑥ 加载态带工作台名（用户知道在等哪个）', !!gate && /正在加载 · 商城工作台/.test(gate.textContent || ''), gate && (gate.textContent || '').slice(0, 60));
		// ⚠ 只断言"CSS 文本里有这条规则"不够：整段 CSS 若有语法问题，规则会被浏览器丢弃，
		//   元素退化成普通流里的文字（真机就是这样：文字挤在左上角）。必须看**计算样式**。
		const gatePos = gate ? window.getComputedStyle(gate).position : '';
		truthy('⑥ 加载态样式真的生效（position:absolute，不是挤在左上角的裸文字）', gatePos === 'absolute', 'position=' + gatePos);
		// 真机事故：文档里已有同 id 的旧 <style> 时旧实现直接 return ⇒ 新规则写不进去 ⇒ 裸文字。
		// 所以布局必须**内联兜底**，不依赖样式表。
		truthy('⑥ 关键布局有内联兜底（样式表失效也不会退化成裸文字）',
			!!gate && /position:\s*absolute/.test(gate.getAttribute('style') || ''), gate && (gate.getAttribute('style') || '').slice(0, 60));
		// ★ 真机事故：包装层一开始是**横向** flex ⇒ 子面板宽度变成"内容宽度"，记忆库被压成一条窄栏、文字竖排。
		//   旧外框（.vssWbFrame）是纵向 flex ⇒ 宽度靠 stretch 铺满，包装层必须保持一致。
		const cssText = [...window.document.querySelectorAll('style')].map(s => s.textContent || '').join('');
		truthy('⑥ 包装层是**纵向** flex（否则子面板按内容宽度收缩，出现窄栏 + 竖排字）',
			/\.vssWbPanelContent \{ display:flex; flex-direction:column;/.test(cssText)
			&& /\.vssWbPanelContent > \* \{ flex:1 1 auto; min-width:0; min-height:0; \}/.test(cssText));
		const css = [...window.document.querySelectorAll('style')].map(s => s.textContent || '').join('');
		truthy('⑥ 加载态层级低于浮动胶囊（不挡「AI 助手 / 外开」）',
			/\.vssWbLoading \{ position:absolute; inset:0; z-index:6;/.test(css) && /\.vssWbActions \{[^}]*z-index:2147482000/.test(css));
		// ★ 关键：内容还没挂上时**不能**提前消失（否则慢工作台又露出空白，等于白做）
		await act(async () => { await tick(150); });
		const g2 = q(m.container, '[data-vssaros-wb-loading]');
		// ⚠ 要连"没在淡出"一起断言：只查存在的话，"120ms 就开始淡出"这种错也照样绿（反向突变抓到的）
		truthy('⑥ 内容还没挂上时加载态不消失、也不开始淡出（不会提前露出空白）',
			!q(m.container, '[data-slow-ready]') && !!g2 && !/is-out/.test(g2.className || ''), g2 ? g2.className : '(已卸载)');
		// 分两段等：慢组件的 setState 在 act 结束时才 flush，一次长等会把它和淡出挤在一起
		await act(async () => { await tick(300); });
		await act(async () => { await tick(600); });
		truthy('⑥ 内容出现后加载态被卸载', !q(m.container, '[data-vssaros-wb-loading]'));
		truthy('⑥ 内容确实渲染出来了', !!q(m.container, '[data-slow-ready]'));
		await m.unmount();
		// 缓存命中（瞬间挂上）也要显示最短 120ms，避免"闪一下"
		env.service.register({ title: '看板', repository: 'vssaros:kanban', customFrame: true }, () => h('div', null, 'x'));
		const m2 = await mount(h(env.service.View, { id: 'vssaros/kanban', active: true }));
		truthy('⑥ 瞬间挂上的也要显示最短 120ms（不闪）', !!q(m2.container, '[data-vssaros-wb-loading]'));
		await act(async () => { await tick(500); });
		truthy('⑥ 之后照样淡出并卸载', !q(m2.container, '[data-vssaros-wb-loading]'));
		await m2.unmount();
	} finally { env.restore(); }
}

console.log(problems ? `\n[check-workbench-frame] ✗ ${problems} 项不通过` : '\n[check-workbench-frame] ✓ 通过');
process.exit(problems ? 1 : 0);
