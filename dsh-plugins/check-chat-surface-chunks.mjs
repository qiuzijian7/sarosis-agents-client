/*---------------------------------------------------------------------------------------------
 *  vssaros-chat-surface 的 **chunk 级守卫**（2026-10-14 新增）。
 *
 *  为什么需要它：这个插件是"一个换皮点一个 lib/client.*.js"，靠主包 `lib/client.js` 的
 *  `PART_CHUNKS` 数组在**运行时** `require.async` 装载 —— 而**没有任何东西**保证：
 *    ① 新写的 chunk 被接进 `PART_CHUNKS`（忘了接线 ⇒ 文件静静躺在包里，功能永不生效 ✗）；
 *    ② chunk 的 `slots.register({name,id,order})` 与**官方**或**我们别的 chunk** 撞 id / tie order
 *       （同 id 会顶掉、同 order 顺序无保证 ⇒ 表现为"界面少了一个东西"，且不报错 ✗）；
 *    ③ 纯逻辑（进度文案 / 时长文案）没坏。
 *  这三类失败都不会让构建失败、也不会在控制台留明显错误 ⇒ 必须用守卫钉住。
 *
 *  做法（**行为断言**，不是正则猜源码 ✗）：用假 `window.__ModuleLoader__` + 假 `react`/`document`
 *  **真装载**每个 chunk，拿到它的 `install(ctx, shell)`，再用假 ctx 真调一次 ⇒ 直接从
 *  `slots.register` 的**入参**上读 (name,id,order) ✓（源码里怎么写的变量名都无所谓 ✓）。
 *
 *  运行（仓库根）：node dsh-plugins/check-chat-surface-chunks.mjs   （或 npm run check:dsh-plugins）
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
// ★ 2026-10-21：入口指纹守卫要读 git 的工作区改动面（execFileSync）⇒ 必须显式导入 ✓
//   （这条 import 曾在并发回退里被摘掉 ⇒ 守卫静默跳过自己 ⇒ 必须钉住 import 本身 ✗）。
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PLUGIN_DIR = path.join(HERE, 'vssaros-chat-surface');
const LIB = path.join(PLUGIN_DIR, 'lib');

/** 官方占位（真源：官方包里 registration 原文，行号写在这里，便于 dsh 升级后复核）。 */
const OFFICIAL_ENTRIES = [
	// dsh-client-ui-conversation/lib/client.js:17752-17759（todo）/ 15677-15695（queue）
	{ slot: 'conversation.input.dock', id: 'todo', order: 0, owner: '官方 TodoPanel' },
	{ slot: 'conversation.input.dock', id: 'queue', order: 20, owner: '官方 QueueDock' },
	// ⚠ 2026-10-14 补登：官方 **goal** 也在这一槽，order 正是 **10**（`dsh-client-ui-goal/lib/client.js:557-561`）。
	//   我们原先的 `vssaros-todo` 也取 10 ⇒ **真 tie** ✗，而本表漏了 goal ⇒ 守卫当时**报不出来** ✓。
	//   先挪到空档 **5**（不与三者 tie）；★ 2026-11-13 用户选方案 C 又挪到 **-1**（欢迎卡 -5 与
//   官方 todo=0 之间）⇒ 定位按钮排到任务卡之前，官方 TodoPanel 成为最后一个可见 dock 条目、贴输入框。
//   契约由下方 client.todos.js 的 ENTRY_ORDER 断言钉住（不许退回 >= 0）。
	//   ★ 教训：这份表是**守卫唯一的官方面**，漏一条就等于给那条留了个静默 tie 的口子 ✗ ⇒ 官方新增/改动
	//     槽位后要拿权威清单（`dsh-cordis-client-runner/lib/client.js:2363+` 的 `CLIENT_SLOT_API`）复核。
	{ slot: 'conversation.input.dock', id: 'goal', order: 10, owner: '官方 GoalDock' },
	// dsh-client-ui-subagent/lib/client.js:968-974 / dsh-client-ui-jobs/lib/client.js:610-621
	{ slot: 'conversation.session.header.actions', id: 'subagent-catalog', order: -30, owner: '官方子代理目录' },
	{ slot: 'conversation.session.header.actions', id: 'job-list', order: 20, owner: '官方 jobs 名单' },
	// 2026-10-17 新增（工作台导航 client.workbenchNav.js 的同槽官方占用者）：
	// dsh-client-ui-plugin-manager/lib/client.js:4239-4246（plugins, order 0）/
	// dsh-client-ui-schedule/lib/client.js:7484-7491（schedules, order 10）。
	// 我们的条目从 order 20 起、步长 2，重排序时整组平移 ⇒ 永不撞这两条 ✓。
	{ slot: 'sidebar.panellist', id: 'plugins', order: 0, owner: '官方 Plugins 面板入口' },
	{ slot: 'sidebar.panellist', id: 'schedules', order: 10, owner: '官方 Automation tasks 入口' },
	// 2026-11-02 新增（会话区视图页签 client.conversationViews.js 的同槽官方占用者）：
	// dsh-client-ui-chat/lib/client.js:13222-13233（chat, order 0）/
	// dsh-client-ui-trajectory/lib/client.js:8205-8238（trajectory, order 10）。
	// 我们的四条从 order 20 起、步长 10 ⇒ 落在轨迹右侧，永不与这两条 tie ✓。
	{ slot: 'conversation.view', id: 'chat', order: 0, owner: '官方对话视图' },
	{ slot: 'conversation.view', id: 'trajectory', order: 10, owner: '官方轨迹视图（developerTools 开启时才显示）' },
];

/**
 * 我们**已经存在**的占位（新增条目允许与它们共存，但**不允许**去动它们）。
 *
 * ★ 2026-10-15：`vssaros-workspace-chip`（-30）+ `vssaros-worktree-chip`（-20）**已合并**为
 *   单枚 `vssaros-context-entry`（-27，方案 C：单 chip + 可搜索面板）⇒ 官方 `subagent-catalog`
 *   在 -30 的**历史 tie 随之消失**（原登记见下方 KNOWN_TIES 的注释 ✓）。
 *   ⚠ 新入口刻意取 **-27**：官方 -30 与我们的 `vssaros-subagents`（-25）之间 —— 取 -25 会与它真 tie ✗
 *     （第一版就取了 -25，本守卫当场报出来 ✓）。
 */
const OUR_BASELINE = [
	{ slot: 'conversation.session.header.actions', id: 'vssaros-context-entry', order: -27 },
	{ slot: 'conversation.session.header.actions', id: 'vssaros-subagents', order: -25 },
	{ slot: 'conversation.session.header.actions', id: 'agent-preset', order: -10 },
	// ⚠ 2026-10-16 新增的 `vssaros-delegate`（conversation.input.dock, order 15）**刻意不进本表**：
	//   进基线 = 跳过"与官方撞 id/tie order"检查 ⇒ 官方日后在 15 加条目就静默 tie（goal=10 那次正是
	//   这种漏检 ✗）。保持"新条目"身份 ⇒ 每次跑守卫都对它做全量对账 ✓。
];

/**
 * **多条目槽**：同一槽里会并存多个条目 ⇒ 必须有 `id`（不然互相顶掉）且 `order` 要避开 tie。
 *
 * 反例（**单条目槽**，只我们一家占）：`conversation.composer`、`conversation.chat.turnTail`、
 * `conversation.hero.*` —— 这些槽只注册一个组件，`id`/`order` 没有意义 ⇒ 不该拿这条规则去要求它们 ✗
 * （守卫第一版就是这么误报的：把 5 处单条目槽的省略写法判成了问题 ✗）。
 */
const MULTI_ENTRY_SLOTS = new Set([
	'conversation.input.dock',
	'conversation.session.header.actions',
	'conversation.session.header.utilities',
	'conversation.input.left',
	'conversation.input.overlay',
	// 官方已有 10 枚条目（toast / 对话框 / 快捷键参考…，CLIENT_SLOT_API 4856-4866）⇒ 必须带 id，且不许撞官方 id ✓
	'shell.overlay',
	// 2026-10-17 新增：侧栏全局面板图标（官方 plugins=0 / schedules=10 已登记进 OFFICIAL_ENTRIES ✓）
	'sidebar.panellist',
	// 2026-10-22：设置 → 模型页尾（list/root；官方自己不往里放 ⇒ 但别的插件可能放 ⇒ 必须有 id + order）
	'settings.models.footer',
	// 2026-11-02：会话区视图页签（list/session；官方 chat=0 / trajectory=10 已登记进 OFFICIAL_ENTRIES ✓）
	'conversation.view',
]);

/**
 * **已登记的 order tie**（历史遗留，允许存在；守卫不对它们报警，但新条目不许再加进这些 (slot, order)）。
 *
 * 为什么要登记而不是"顺手修"：这些 tie 是线上正在跑的形态，改 order 等于改显示顺序 ⇒ 属于
 * 视觉变更，要单独走一次评审 ✗（本脚本只负责"不许再增加" ✓）。
 */
/**
 * **keyed 槽**：条目身份是 `key` 而不是 `id`（官方文档："the entry renders where the owner
 * dispatches this exact key"）⇒ 撞 **key** 才是互相顶掉；`id`/`order` 对它们无意义。
 * 2026-10-17：工作台导航往 `main` 注册了 11 枚 keyed 面板，守卫第一版把它们按 id=undefined
 * 两两判重 ⇒ 55 条假阳性 ✗。
 * 同日第二刀：`sidebar.right.pane.tab`（右侧栏页签体，key = tab kind）同规律 ✓。
 */
const KEYED_SLOTS = new Set(['main', 'sidebar.right.pane.tab',
	// 2026-10-22：设置 → 模型的卡片扩展位（keyed/root，entryKey = settingsNs；client.modelAccounts.js 注册 llm-pi-ai）
	'settings.models.provider-card']);

const KNOWN_TIES = [
	// ★ 2026-10-15 已消解：`vssaros-workspace-chip` 与官方 `subagent-catalog` 曾在 -30 tie；
	//   两枚 chip 合并为 `vssaros-context-entry`（-27）后该 tie 不复存在 ⇒ 这条登记**已删除** ✓
	//   （登记项不许留"已不存在"的僵尸：它会让守卫以为那里仍允许 tie ✗）。

	// 两个 utilities 条目都没写 order（默认 0）⇒ 相对顺序无保证
	{ slot: 'conversation.session.header.utilities', order: undefined, ids: ['vssaros-ping', 'open-in-app'], why: '历史遗留：两条都没写 order（默认 0）' },
];

const problems = [];
const notes = [];

/** 极简 react 替身：守卫只跑**装载期**（不渲染）⇒ 只要不抛、形状够用即可 ✓。 */
const fakeReact = {
	useState: (init) => [typeof init === 'function' ? init() : init, () => { }],
	useEffect: () => { },
	useMemo: (fn) => (typeof fn === 'function' ? fn() : undefined),
	useRef: (init) => ({ current: init === undefined ? null : init }),
	createElement: (type, props, ...children) => ({ type, props, children }),
	Fragment: Symbol('Fragment'),
};

function makeElementStub() {
	const node = {
		style: {}, dataset: {}, childElementCount: 0, children: [], textContent: "",
		parentElement: null, scrollHeight: 0, clientHeight: 0,
		classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
		setAttribute() { }, getAttribute() { return null; }, hasAttribute() { return false; },
		removeAttribute() { }, appendChild() { }, removeChild() { }, remove() { },
		addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
		scrollIntoView() { }, contains() { return false; }, closest() { return null; },
		querySelector() { return null; }, querySelectorAll() { return []; },
		insertBefore() { }, setAttributeNS() { }, getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
	};
	return node;
}
function makeDocumentStub() {
	const doc = makeElementStub();
	doc.createElement = () => makeElementStub();
	doc.createTextNode = () => makeElementStub();
	doc.head = makeElementStub();
	doc.body = makeElementStub();
	doc.documentElement = makeElementStub();
	return doc;
}
function makeWindowStub(doc) {
	return {
		document: doc,
		innerWidth: 1440, innerHeight: 900,
		// 旧布局静态契约仍要逐条验证；新布局默认开启另在 ⑥-b 后单独断言零中栏页签。
		__vssarosSidebarLayoutV1: false,
		addEventListener() { }, removeEventListener() { }, dispatchEvent() { return true; },
		setTimeout: (fn) => 0, clearTimeout() { }, getComputedStyle: () => ({ overflowY: 'visible' }),
		location: { href: 'file:///check' },
	};
}

/** 真装载一个 chunk，返回它的 exports（含 install / __test）。 */
function loadChunk(fileName, documentStub, windowStub) {
	const abs = path.join(LIB, fileName);
	const src = fs.readFileSync(abs, 'utf8');
	let captured = null;
	const sandboxWindow = Object.assign({}, windowStub, {
		__ModuleLoader__: { load: (mod) => { captured = mod; } },
	});
	const requireFn = (spec) => {
		if (spec === 'react') { return fakeReact; }
		if (['client.sessionRow.js', 'client.conversationHeader.js'].includes(fileName) && spec === 'react/jsx-runtime') { return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement }; }
		if (['client.sessionRow.js', 'client.conversationHeader.js'].includes(fileName) && spec === '@deepseek-ai/dsh-client-ui-primitives') { return {}; }
		throw new Error('未登记的共享模块 ' + spec);
	};
	// 用 Function 构造：把 window/document 作为**形参**传入（chunk 源码里用的是裸 `document` ✓）
	const factoryFn = new Function('window', 'document', 'require', 'module', 'exports', src + '\nreturn module.exports;');
	const module_ = { exports: {} };
	factoryFn(sandboxWindow, documentStub, requireFn, module_, module_.exports);
	if (!captured) { throw new Error(`${fileName}: 没有调用 window.__ModuleLoader__.load(...)`); }
	if (captured.chunk !== fileName) {
		throw new Error(`${fileName}: load({chunk}) 写成了 ${JSON.stringify(captured.chunk)}（必须等于文件名 —— 装载器按它做模块 id）`);
	}
	const exports_ = captured.factory(requireFn);
	if (typeof exports_.install !== 'function') { throw new Error(`${fileName}: 没有导出 install(ctx, shell)`); }
	return { exports: exports_ };
}

/** 用假 ctx 真跑一次 install，从 slots.register 的入参上读注册参数（源码写法无关 ✓）。 */
function captureRegistration(chunkExports, shell) {
	const registered = [];
	const ctx = {
		slots: {
			inject: (name, fn) => { registered.push({ slot: name, entry: fn() }); return { dispose() { } }; },
			register: (entry) => ({ entry, dispose() { } }),
		},
		effect: (fn) => { try { const d = fn(); if (typeof d === 'function') { d(); } } catch { /* 可选服务 */ } },
		get: () => undefined,
		plugin: () => { },
	};
	chunkExports.install(ctx, shell);
	return registered;
}

function makeShell() {
	const state = {};
	const notifications = [];
	return {
		state,
		notifications,
		shell: {
			bridge: {
				notify: (kind, msg) => notifications.push({ kind, msg }),
				openSession: () => Promise.resolve(),
				sessionId: 'sess-check',
			},
			state,
			sessionId: 'sess-check',
			mark: () => { },
			rebind: () => { },
			fitMenu: () => { },
			menus: { closeOthers: () => { }, register: () => () => { } },
		},
	};
}

// ── ⓪ 语法守卫：主包 + 每个 chunk 都必须能被 JS 引擎**编译**（2026-10-18）──────────────────────
// 为什么：此前守卫只读 client.js 的**源码文本**找 PART_CHUNKS，从不解析它——一次手滑留下的残留
// 标识符（`id\t\t\tidleTicks = 0;`）能让整个主包语法错误，守卫照样"通过"，直到手动 `node --check` 才发现。
// 主包是整个换皮的入口，它坏了 = 弹窗/聊天框的所有定制一个都不加载，必须在守卫里就红。
{
	const targets = ['client.js', ...fs.readdirSync(LIB).filter(f => /^client\..+\.js$/.test(f)).sort()];
	for (const f of targets) {
		try {
			// 与 chunk 加载同款的 Function 编译（只编译不执行）
			new Function('window', 'document', 'require', 'module', 'exports', fs.readFileSync(path.join(LIB, f), 'utf8'));
		} catch (e) {
			problems.push(`${f} 语法错误（编译失败）: ${String((e && e.message) || e)}`);
		}
	}
	notes.push(`语法编译检查 ${targets.length} 个文件`);
}

// ── ⓪-b 独立 bundle 的 CSS Modules 不许生成互相污染的短类名 ──────────────────
// esbuild 的 minifyIdentifiers/minify:true 会把两个独立 CSS Module 同时压成 .a/.b/.e；
// header 的 `.e{position:absolute}` 会让官方会话行脱离文档流，表现为展开后会话与下一工作区重叠。
{
	const generatedCss = (fileName) => {
		const doc = makeDocumentStub();
		const style = makeElementStub();
		let css = '';
		Object.defineProperty(style, 'textContent', { get: () => css, set: value => { css = String(value); } });
		doc.createElement = () => style;
		doc.head.appendChild = () => {};
		loadChunk(fileName, doc, makeWindowStub(doc));
		return css;
	};
	const localClasses = css => new Set([...css.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '').matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map(match => match[1]));
	const bundles = [
		['client.sessionRow.js', generatedCss('client.sessionRow.js')],
		['client.conversationHeader.js', generatedCss('client.conversationHeader.js')],
	].map(([file, css]) => [file, localClasses(css)]);
	const [rows, header] = bundles.map(([, classes]) => classes);
	const overlap = [...rows].filter(name => header.has(name));
	if (overlap.length) { problems.push(`会话行与页头 CSS 类名碰撞：${overlap.slice(0, 10).join(', ')}（会让会话行脱流重叠）✗`); }
	for (const [file, classes] of bundles) {
		const short = [...classes].filter(name => name.length <= 1);
		if (short.length) { problems.push(`${file} 生成了跨 bundle 易碰撞的短 CSS 类名：${short.join(', ')} ✗`); }
	}
	for (const script of ['build-session-row.mjs', 'build-conversation-header.mjs']) {
		const src = fs.readFileSync(path.join(PLUGIN_DIR, 'scripts', script), 'utf8');
		for (const [needle, why] of [
			[/minify:\s*false/, '必须关闭整体 minify'],
			[/minifyWhitespace:\s*true/, '必须压缩空白'],
			[/minifySyntax:\s*true/, '必须压缩语法'],
			[/minifyIdentifiers:\s*false/, '禁止压缩 CSS Modules 局部类名'],
		]) {
			if (!needle.test(src)) { problems.push(`scripts/${script}: ${why}，否则会重新生成短类名导致侧栏重叠 ✗`); }
		}
	}
	notes.push('会话行 / 页头 CSS Modules：命名空间隔离与构建配置断言通过');
}

// ── ① 接线守卫：磁盘上每个 client.*.js 都必须在 PART_CHUNKS 里（反之也要在） ────────────────
const clientSrc = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
const arrMatch = /const PART_CHUNKS = \[([\s\S]*?)\];/.exec(clientSrc);
if (!arrMatch) {
	problems.push('client.js 里找不到 PART_CHUNKS 数组（守卫采集面失效 ⇒ 必须同步改这里）');
} else {
	const wired = [...arrMatch[1].matchAll(/"\.\/([^"]+)"/g)].map(m => m[1]);
	// ⚠ 2026-10-21 第五轮：**独立装载路径**的部件（`ALWAYS_CHUNKS`）同样算"已接线" ——
	//   它们不走 PART_CHUNKS（那儿有"无桥就整批不装"的早退 ⇒ dsh desktop 里不生效 ✗）
	//   ⇒ 接线清单 = PART_CHUNKS ∪ ALWAYS_CHUNKS（两个清单都要能逐字比对 ⇒ 写成常量 ✓）。
	const alwaysMatch = /const ALWAYS_CHUNKS = \[([\s\S]*?)\];/.exec(clientSrc);
	if (!alwaysMatch) {
		problems.push('client.js 里找不到 ALWAYS_CHUNKS 数组（独立装载路径的部件清单 ⇒ 守卫采集面失效 ✗）');
	} else {
		for (const m of alwaysMatch[1].matchAll(/"\.\/([^"]+)"/g)) {
			if (!wired.includes(m[1])) { wired.push(m[1]); }
		}
	}
	const onDisk = fs.readdirSync(LIB).filter(f => /^client\..+\.js$/.test(f)).sort();
	const missing = onDisk.filter(f => !wired.includes(f));
	const ghost = wired.filter(f => !onDisk.includes(f));
	if (missing.length) { problems.push(`这些 chunk **没接线**（文件在包里但永远不会被装载 ⇒ 功能静静失效）: ${missing.join(', ')}`); }
	if (ghost.length) { problems.push(`PART_CHUNKS 里指向了不存在的文件: ${ghost.join(', ')}`); }
	notes.push(`接线的 chunk ${wired.length} 个 / 磁盘上 ${onDisk.length} 个`);
}

// ── ② 装载 + install（真行为） + 注册参数收集 ───────────────────────────────────────────
const ourEntries = [];
for (const file of fs.readdirSync(LIB).filter(f => /^client\..+\.js$/.test(f)).sort()) {
	const doc = makeDocumentStub();
	const win = makeWindowStub(doc);
	let loaded;
	try {
		loaded = loadChunk(file, doc, win);
	} catch (e) {
		problems.push(`${file}: 装载失败 — ${String((e && e.message) || e)}`);
		continue;
	}
	const { shell } = makeShell();
	let regs = [];
	try {
		regs = captureRegistration(loaded.exports, shell);
	} catch (e) {
		problems.push(`${file}: install() 抛错 — ${String((e && e.message) || e)}`);
		continue;
	}
	for (const r of regs) {
		const entry = (r.entry && r.entry.entry) ? r.entry.entry : r.entry;
		const name = (entry && entry.name) || r.slot;
		const id = entry && entry.id;
		const key = entry && entry.key;
		const order = entry && entry.order;
		if (MULTI_ENTRY_SLOTS.has(name)) {
			// 多条目槽：必须显式（不然 id 撞了会顶掉、order 撞了顺序无保证，且都不报错 ✗）
			// ⚠ 例外：已登记的**历史遗留**写法（见 KNOWN_TIES）只记一行说明，不当问题 —— 修它等于改
			//   显示顺序 ⇒ 视觉变更，要单独评审，本脚本只负责"不许再增加" ✓
			const legacy = KNOWN_TIES.some(t => t.slot === name && t.order === order && t.ids.includes(id));
			if (!id) { problems.push(`${file}: 注册到多条目槽 ${name} 却没写 id（与官方/其它条目并存必须有 id ✗）`); }
			if (typeof order !== 'number' && !legacy) { problems.push(`${file}: 注册到多条目槽 ${name} 却没写 order（顺序无保证 ✗）`); }
			if (legacy && typeof order !== 'number') { notes.push(`${file}: ${name} 的 order 省略属**已登记**的历史遗留（见 KNOWN_TIES ✓）`); }
		} else if (!KEYED_SLOTS.has(name)) {
			// 单条目槽：省略是正常的 ✓（只记一行说明，不当问题）；keyed 槽的身份是 key，id/order 本就无意义
			if (!id || typeof order !== 'number') { notes.push(`${file}: 单条目槽 ${name} 省略了 ${!id ? 'id' : ''}${(!id && typeof order !== 'number') ? ' + ' : ''}${typeof order !== 'number' ? 'order' : ''}（该槽只我们一家占，正常 ✓）`); }
		}
		ourEntries.push({ file, slot: name, id, key, order });
	}
	const t = loaded.exports.__test;
	if (file === 'client.todos.js') {
		try {
			const check = (ok, reason) => { if (!ok) { problems.push(`${file}: ${reason}`); } };
			// ★ 2026-11-13（用户选方案 C）：定位入口必须排在官方 TodoPanel(order 0) **之前**，
			//   否则又会独占一行插在任务卡与输入框之间、撑出截图里那条空白带。
			check(t.ENTRY_ORDER > -5 && t.ENTRY_ORDER < 0,
				'order 必须落在欢迎卡(-5) 与官方 TodoPanel(0) 之间（方案 C：任务卡贴输入框）');
			check(t.ENTRY_ID === 'vssaros-todo' && t.SLOT === 'conversation.input.dock',
				'任务定位入口的槽 / id 不许变');
			const pending = { content: 'pending task', status: 'pending' };
			const active = { content: 'active task', status: 'in_progress' };
			const done = { content: 'done task', status: 'completed' };
			check(t.currentTodo([pending, active, done]) === active, '当前任务必须优先进行中');
			check(t.currentTodo([done, pending]) === pending, '无进行中时定位待处理任务');
			for (const list of [null, undefined, [], [done], [{ content: '', status: 'in_progress' }]]) {
				check(t.TodosDock({ useProjection: () => list }) === null, '未知/空/全完成任务不得显示重复入口');
			}
			const list = [pending, active, done];
			const before = JSON.stringify(list);
			const tree = t.TodosDock({ useProjection: () => list });
			const nodes = [];
			const walk = node => { if (!node || typeof node !== 'object') { return; } nodes.push(node); for (const child of node.children || []) { walk(child); } };
			walk(tree);
			const buttons = nodes.filter(node => node.type === 'button');
			check(buttons.length === 1 && buttons[0].props.type === 'button' && buttons[0].children[0] === '定位当前任务', '应仅显示原生定位按钮');
			check(!nodes.some(node => ['ul', 'li', 'i'].includes(node.type)), '不可再次渲染清单或进度条');
			check(JSON.stringify(list) === before, 'UI 不可修改任务投影');
			const history = { childElementCount: 0, textContent: active.content, closest: () => null };
			const dock = { childElementCount: 0, textContent: active.content, closest: () => ({}) };
			const root = { querySelectorAll: () => [history, dock] };
			check(t.locateByText(root, active.content) === history, '历史定位不得命中 composer/当前任务dock');
			check(t.locateByText({ querySelectorAll: () => [dock] }, active.content) === null, '只有dock命中时必须报定位失败');
			check(t.locateByText(null, active.content) === null, '不能回退全页面定位');
			const anchor = { closest: selector => selector === '[data-conversation-scroll]' ? root : null };
			check(t.historyScope(anchor) === root && t.historyScope(null) === null, '定位范围须来自按钮所属会话');
		} catch (error) { problems.push(`${file}: 任务去重回归失败 — ${error.message}`); }
	}
	if (t && typeof t.progressLabel === 'function') {
		const got = t.progressLabel(2, 5);
		if (!/2/.test(got) || !/5/.test(got)) { problems.push(`${file}: progressLabel 坏了（"${got}"）`); }
	}
	if (t && typeof t.durationLabel === 'function') {
		const a = t.durationLabel({ settledMs: 65_000 });
		if (a !== '1 分 05 秒') { problems.push(`${file}: durationLabel(65000ms) 期望 "1 分 05 秒"，实际 "${a}"`); }
		if (t.durationLabel(null) !== null) { problems.push(`${file}: durationLabel(null) 必须是 null（没有时长就不许编造 ✗）`); }
	}
}

const isBaseline = (e) => OUR_BASELINE.some(b => b.slot === e.slot && b.id === e.id);
const baselineIds = new Set(OUR_BASELINE.map(b => b.id));
const isNew = (e) => !baselineIds.has(e.id);

/** 这条 (slot, order, id) 是否属于**已登记**的 tie ⇒ 不报警（见 KNOWN_TIES 的说明 ✓）。 */
const isKnownTie = (slot, order, id) => KNOWN_TIES.some(t => t.slot === slot && t.order === order && t.ids.includes(id));
const tieMatters = (e) => MULTI_ENTRY_SLOTS.has(e.slot) && !isKnownTie(e.slot, e.order, e.id);

// 与**官方**撞 id / tie order —— 只对**新条目**报警（既有 tie 已登记，见 OUR_BASELINE 注释 ✓）
for (const ours of ourEntries.filter(isNew)) {
	for (const off of OFFICIAL_ENTRIES) {
		if (off.slot !== ours.slot) { continue; }
		if (off.id === ours.id) { problems.push(`${ours.file}: id "${ours.id}" 与官方 ${off.owner} 撞名 ⇒ 会互相顶掉 ✗`); }
		else if (off.order === ours.order && tieMatters(ours)) {
			problems.push(`${ours.file}: order ${ours.order} 与官方 ${off.owner} tie ⇒ 顺序无保证，请取空档 ✗`);
		}
	}
}
// 我们**自己之间**撞 id / tie order（同槽）；keyed 槽的身份是 key（见 KEYED_SLOTS）
for (let i = 0; i < ourEntries.length; i++) {
	for (let j = i + 1; j < ourEntries.length; j++) {
		const a = ourEntries[i], b = ourEntries[j];
		if (a.slot !== b.slot) { continue; }
		if (KEYED_SLOTS.has(a.slot)) {
			if (a.key && a.key === b.key) { problems.push(`key "${a.key}" 在 keyed 槽 ${a.slot} 里被重复注册（${a.file} / ${b.file}）⇒ 互相顶掉 ✗`); }
			continue;
		}
		if (a.id === b.id) { problems.push(`id "${a.id}" 被两个 chunk 重复注册（${a.file} / ${b.file}）✗`); continue; }
		if (a.order === b.order && (isNew(a) || isNew(b)) && !(isBaseline(a) && isBaseline(b)) && tieMatters(a) && tieMatters(b)) {
			problems.push(`order ${a.order} 在槽 ${a.slot} 里 tie（${a.id} / ${b.id}）⇒ 顺序无保证 ✗`);
		}
	}
}
// 未登记槽位（多半是 slot 名拼错 ⇒ 静默不显示 ✗）
// ⚠ 2026-10-16 新增 `conversation.hero.workspace`：hero（空白会话屏）那行的**官方浮层槽** ——
//   我们以 `priority: -10` **遮蔽**官方的 WorkspacePickFlow，换上自己的合并面板（方案 A，
//   mockup `doc/dsh-workspace-entry-single-mockup.html`；官方那枚 WorkspaceChip 本身写死在
//   `heroWorkspaceRow` 里、走不了 slot ⇒ 只能换它的浮层 ✓）。槽是 single ⇒ 同 id 不必写 order ✓。
const knownSlots = new Set([...OFFICIAL_ENTRIES.map(o => o.slot), 'conversation.input.left', 'conversation.input.overlay',
	'conversation.session.header.utilities', 'conversation.hero.brand.mark', 'conversation.hero.agentPreset',
	'conversation.hero.workspace',
	// `tool.call.toolview`：官方工具卡（dsh-client-ui-tool，按 key=工具名 匹配）；2026-11-05 群会话的 group_relay 回复卡
	'tool.call.toolview',
	// `shell.overlay`：官方"整框浮层"（list / root，默认点击穿透；条目要 pointerEvents:auto）。
	// 曾用于窗口伙伴 client.companion.js（2026-10-17 应用户要求移除）；槽登记保留，留给以后的浮层部件 ✓
	'shell.overlay',
	// 2026-10-17 新增：工作台导航（client.workbenchNav.js）—— 侧栏图标槽 + 中栏 keyed 面板槽
	// （main 是 keyed/root，中央面板按侧栏条目 id 派发；我们的 key 带 vssaros-wb- 前缀 ✓）。
	// 同日第二刀：页面改开进**右侧栏页签**（sidebar.right.pane.tab，keyed/session，key=tab kind），
	// main 面板只做中转（openTab + selectPanel(null) 弹回会话，不占用聊天框 ✓）。
	'sidebar.panellist', 'main', 'sidebar.right.pane.tab',
	// 同日第三刀：多根工作区「单条目 + hover 详情卡」（client.workspaces.js）遮蔽官方整区
	// （single/root 槽，priority: -10 升序取最低 ⇒ 与 hero.workspace 遮蔽同一先例 ✓）。
	'sidebar.workspaces',
	'conversation.chat.turnTail', 'conversation.composer',
	// 2026-10-21：回合用量实时那一行（client.usage.js）挂在 composer 下方的常驻槽 ⇒ 补登记 ✓
	'conversation.composer.dock',
	// 2026-10-22：设置 → 模型页的两个官方扩展位（client.modelAccounts.js）
	'settings.models.provider-card', 'settings.models.footer',
	// 2026-10-27：设置弹窗左侧导航的分区槽（client.market.js 的「工作台商城」、
	// client.channel.js 的「渠道」）+ 分区自己的内容子槽。
	// ⚠ 这两个槽由 dsh 官方 `ui-settings` 声明（`settings.section` 及其 children），
	//   不是我们新造的槽；登记在此只是让 note 不再重复提示。
	'settings.section', 'settings.vssaros.channel.item',
	'vssaros.workspaces.session.row.action', 'vssaros.workspaces.session.row.leading',
	'vssaros.workspaces.session.row.trailing', 'vssaros.workspaces.session.row.hover',
	// `settings.launcher`：左下角账号行的官方槽（client.account.js 一直在用，之前没登记）
	'settings.launcher']);
for (const o of ourEntries) {
	if (!knownSlots.has(o.slot)) { notes.push(`${o.file}: 注册到未登记槽 ${o.slot}（若是新槽，请把槽名补进本脚本的 knownSlots ✗）`); }
}

// ── ③ 包清单：version 存在 + files 通配覆盖 chunk（历史上漏 files ⇒ 整站 404 出过事故） ──────
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
if (!pkg.version) { problems.push('package.json 缺 version（安装判据是"版本相等就跳过" ⇒ 不改版本新内容不会被装上 ✗）'); }
if (!Array.isArray(pkg.files) || !pkg.files.some(f => String(f).includes('client.*.js'))) {
	problems.push('package.json 的 files 必须包含通配 "lib/client.*.js"（否则新 chunk 不进包 ⇒ 插件加载即失败 ✗）');
}

// ── ④ 内容约定（2026-10-15 加）：fileCards 的两条关键行为（丢了 = 死按钮回来 / 冲突回来 ✗） ──
//   背景一：dsh 里所有"开侧栏"都汇到 sidebarRight.openResource（dsh-client-ui-chat:12426 ✓），
//     我们的壳没有侧栏 ⇒ 工具卡文件名链接/交付卡预览/计划审阅全是死按钮 ✗ ⇒ fileCards 在服务层包一层，
//     file 地址改投桥 openFile ✓（路径在 React 闭包里，DOM 拿不到 ⇒ 服务层是唯一总闸 ✓）。
//   背景二：fileCards 的 document 级捕获曾把变更卡**行**也吃掉（openFile）⇒ cardActions 的行级
//     showUncommittedDiff 被遮蔽、从未生效 ✗ ⇒ 行（li 里的按钮）必须放行 ✓。
{
	const fc = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'client.fileCards.js'), 'utf8');
	if (!fc.includes('wrapSidebarRight') || !fc.includes('openResource')) {
		problems.push('client.fileCards.js 缺 sidebarRight.openResource 中枢包裹 ⇒ 工具卡文件名链接/交付卡预览回到死按钮 ✗（2026-10-15 调研实证）');
	}
	if (!fc.includes('button.closest("li")')) {
		problems.push('client.fileCards.js 缺"行放行"（button.closest("li") ⇒ return）⇒ 又把 cardActions 的行级 diff 通道遮蔽 ✗（2026-10-15 实测冲突）');
	}
	// 第二刀（同日）：计划审阅（markdown 随 params 带 ✓）→ openMarkdown；子代理侧栏 → bridge.openSession
	if (!fc.includes('dsh-resource://plan-review/') || !fc.includes('openMarkdown')) {
		problems.push('client.fileCards.js 缺计划审阅的 openMarkdown 分支 ⇒ 计划预览回到死按钮 ✗（2026-10-15 第二刀）');
	}
	if (!fc.includes('dsh-resource://subagentchat/session/') || !fc.includes('bridge.openSession')) {
		problems.push('client.fileCards.js 缺子代理侧栏的 openSession 分支 ⇒ "在侧栏打开子会话"回到死按钮 ✗（2026-10-15 第二刀）');
	}
	// 第三刀（同日）：裸计划卡「打开计划」—— 内容不在地址里 ⇒ remote.follow 会话快照自取 ✓
	if (!fc.includes('openPlainPlan') || !fc.includes('exit_plan_mode')) {
		problems.push('client.fileCards.js 缺裸计划卡的自取分支（openPlainPlan / exit_plan_mode）⇒ 「打开计划」回到死按钮 ✗（2026-10-15 第三刀）');
	}
}

// ── ④-b desktop / IDE 交互分流（2026-10-30 用户要求：「desktop 用 dsh 原生交互、IDE 用 IDE 交互」）──
//   背景：desktop 窗口**也有** window.vssarosDsh（同一份 preload，只是 chatOnly=0），而它自带官方右栏
//   ⇒ 「有桥 ⇒ 接管」是错判据；正确判据只有入口算出的 `shell.ide`（chatOnly===1）。
//   漏接管的后果：desktop 里点工具卡路径会跳到 IDE 编辑器、点交付卡被改成"打开第一个文件"、
//   子代理目录多一条非原生入口 —— 全都不是 dsh 原生交互 ✗。
{
	const entry = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'client.js'), 'utf8');
	if (!entry.includes('const isIdeChatView') || !entry.includes('ide: isIdeChatView')) {
		problems.push('client.js 缺 desktop/IDE 分流判据（`isIdeChatView` + `shell.ide`）⇒ 各接管部件无从判断，desktop 窗口里又会把交互改道 IDE ✗（2026-10-30）');
	}
	// 每个部件都必须：① 在 install 开头 `if (!shell.ide)` 早退；② 早退时留一枚可见诊断字段（不静默 ✗）
	const NEED_DESKTOP_EARLY_EXIT = [
		['client.tools.js', 'openFileRouteSkipped', '文件链接（工具卡路径 / @引用 / markdown 链接）'],
		['client.fileCards.js', 'fileCardsSkipped', '交付卡 + 计划预览 + 子代理侧栏'],
		['client.cardActions.js', 'cardActionsSkipped', '「定位 / 看改动」/「在终端打开」注入按钮'],
		['client.openInApp.js', 'hideOpenInAppSkipped', '官方 open-in-app 的遮蔽'],
		['client.subagents.js', 'vssarosSubagentsEntrySkipped', '子智能体 header 入口'],
	];
	for (const [file, marker, what] of NEED_DESKTOP_EARLY_EXIT) {
		const src = fs.readFileSync(path.join(LIB, file), 'utf8');
		if (!src.includes('if (!shell.ide)') || !src.includes(marker)) {
			problems.push(`${file} 缺 desktop 早退（\`if (!shell.ide)\` + 诊断字段 ${marker}）⇒ desktop 窗口里「${what}」仍走 IDE 通道 ✗（2026-10-30）`);
		}
	}
	// `changes-review`（官方右栏「本轮改动」）必须放行给官方 —— 右栏在 IDE / desktop 两种形态下都保留
	const fcDesktop = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'client.fileCards.js'), 'utf8');
	if (!fcDesktop.includes('dsh-resource://changes-review/') || !fcDesktop.includes('return orig(address, options)')) {
		problems.push('client.fileCards.js 没有放行 `dsh-resource://changes-review/**` ⇒ 交付卡「本轮改动」只能弹提示，右栏永远打不开 ✗（2026-10-30）');
	}
	// 交付卡的**卡头**必须放行给官方 `openReview`（右栏本轮改动）：
	//   旧写法 `firstRowPathOf(...)` + `stopPropagation` 会把 onClick 吃掉 ⇒ 服务层放行分支永远走不到 ✗。
	if (!fcDesktop.includes('state.fileCardHeadersPassed')) {
		problems.push('client.fileCards.js 的交付卡卡头没有放行（缺 `fileCardHeadersPassed` 计数）⇒ 点卡头还是"打开第一个文件"，右栏「本轮改动」打不开 ✗（2026-10-30）');
	}
	if (fcDesktop.includes('firstRowPathOf(target.closest(CARD_SELECTOR))')) {
		problems.push('client.fileCards.js 又把交付卡卡头改回"打开第一个文件"了（`firstRowPathOf(...)`）⇒ 官方 openReview 被 stopPropagation 吃掉 ✗（2026-10-30）');
	}
}

// ── ④-c 分屏入口属于常驻会话页头，不再由导航浮层测量定位 ──────────────────
{
	const nav = fs.readFileSync(path.join(LIB, 'client.workbenchNav.js'), 'utf8');
	const sessions = fs.readFileSync(path.join(LIB, 'client.sessions.js'), 'utf8');
	const header = fs.readFileSync(path.join(LIB, 'client.conversationHeader.js'), 'utf8');
	if (/HeroSplitChip|data-vssaros-hero-split/.test(nav)) { problems.push('导航层不许保留 Hero 分屏浮层'); }
	if (/data-vssaros-new-window/.test(sessions)) { problems.push('会话 utilities 不许重复注册分屏入口'); }
	if (!header.includes('data-vssaros-conversation-header-actions') || !header.includes('vssaros.conversation.header.actions')) {
		problems.push('缺少常驻页头分屏动作区');
	}
	const always = (/const ALWAYS_CHUNKS = \[([\s\S]*?)\];/.exec(clientSrc) || [])[1] || '';
	const parts = (/const PART_CHUNKS = \[([\s\S]*?)\];/.exec(clientSrc) || [])[1] || '';
	if (!always.includes('./client.conversationHeader.js') || parts.includes('./client.conversationHeader.js')) {
		problems.push('常驻页头必须只走 ALWAYS_CHUNKS，覆盖空会话首屏且不重复加载');
	}
}

// ── ⑤ 多根工作区侧栏的分组收敛（client.workspaces.js 的 buildSidebar；2026-10-17）──────
// 钉的是**回落契约**与「非主根才标根名」这两条用户可见行为；改坏了守卫必须红。
{
	const src = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
	const doc = makeDocumentStub();
	const win = makeWindowStub(doc);
	let loaded = null;
	try {
		loaded = loadChunk('client.workspaces.js', doc, win);
	} catch (e) {
		problems.push(`client.workspaces.js: 装载失败 — ${String((e && e.message) || e)}`);
	}
	const t = loaded && loaded.exports.__test;
	if (!t || typeof t.buildSidebar !== 'function') {
		problems.push('client.workspaces.js: 缺 __test.buildSidebar（分组收敛必须可单测 ✗）');
	} else {
		const items = [
			{ workspaceId: 'w1', path: 'G:/WS/client', sessionIds: ['s1', 's2'] },
			{ workspaceId: 'w2', path: 'G:/WS/market', sessionIds: ['s3'] },
			{ workspaceId: 'w3', path: 'G:/other/standalone', sessionIds: ['s4'] },
		];
		const records = [{
			id: 'ide-1', name: 'Saros',
			roots: [
				{ path: 'G:/WS/client', name: 'client', isPrimary: true },
				{ path: 'G:/WS/market', name: 'market', isPrimary: false },
			],
		}];
		const sessionsById = {
			s1: { title: 'A', updatedAt: 300 }, s2: { title: 'B', updatedAt: 200 },
			s3: { title: 'C', updatedAt: 100 }, s4: { title: 'D', updatedAt: 50 },
		};
		const rows = t.buildSidebar({ workspaces: items, records, sessionsById, archivedIds: [], currentSessionId: 's1' });
		const group = rows.find((r) => r.kind === 'group');
		const flat = rows.filter((r) => r.kind === 'flat');
		if (!group) { problems.push('buildSidebar: 多根记录没合成组（应只有一行工作区条目）✗'); }
		else {
			if (group.sessions.length !== 3) { problems.push(`buildSidebar: 组内会话数应为 3，实际 ${group.sessions.length} ✗`); }
			if (group.sessions.map((s) => s.id).join(',') !== 's1,s2,s3') { problems.push('buildSidebar: 组内会话应按 updatedAt 倒序（s1,s2,s3）✗'); }
			const s1 = group.sessions.find((s) => s.id === 's1');
			const s3 = group.sessions.find((s) => s.id === 's3');
			if (!s1 || !s1.isCurrent) { problems.push('buildSidebar: 当前会话标记丢了 ✗'); }
			if (!s1 || s1.isPrimaryRoot !== true || s1.rootName !== null) { problems.push('buildSidebar: 主根会话不应带根名（稿 1 降噪口径）✗'); }
			if (!s3 || s3.isPrimaryRoot !== false || s3.rootName !== 'market') { problems.push('buildSidebar: 非主根会话应带根名 "market" ✗'); }
		}
		if (flat.length !== 1 || flat[0].label !== 'standalone') {
			problems.push('buildSidebar: 未被认领的快照条目应平铺成单行（回落契约）✗');
		}
		// 回落契约：没有 IDE 记录 ⇒ 全部平铺（与加推送之前逐字相同）
		const noRec = t.buildSidebar({ workspaces: items, records: [], sessionsById, archivedIds: [], currentSessionId: null });
		if (noRec.some((r) => r.kind === 'group') || noRec.length !== 3) {
			problems.push('buildSidebar: 无记录时必须全部平铺（回落契约被破坏 ✗）');
		}
		notes.push('client.workspaces.js: buildSidebar 分组/回落契约断言通过');
		// ── ⑤-a0 侧栏 Bots 页签的「最近会话」选取（2026-11-02，Bots 工作台重构）─────────────
		// 口径：点 bot 优先打开 `home[agentId].sessions[0].id`（宿主按 lastActiveAt 倒序给的前 6 条），
		//   没有会话才新建 —— 选错会"每次点 bot 都多一条空会话"✗。
		if (typeof t.latestSessionIdOf !== 'function' || typeof t.fetchBotsData !== 'function') {
			problems.push('client.workspaces.js: 缺 __test.latestSessionIdOf / fetchBotsData ⇒ Bots 页签取数不可单测 ✗');
		} else {
			if (t.latestSessionIdOf({ a: { sessions: [{ id: 's9' }, { id: 's8' }] } }, 'a') !== 's9') {
				problems.push('latestSessionIdOf: 应取 home[agent].sessions[0].id（最近一条）✗');
			}
			if (t.latestSessionIdOf({ a: { sessions: [] } }, 'a') !== '' || t.latestSessionIdOf(null, 'x') !== '') {
				problems.push('latestSessionIdOf: 没有会话 / 读不到数据时必须返回空串（调用方据此新建）✗');
			}
			// ★ 2026-11-02（用户截图：点 bot 后输入框灰着「选择一个工作区开始」）：
			//   无工作区的 bot 会话在官方 hero 里**禁用输入框** ⇒ 复用时排除「确知无 cwd」的，新建时必带 cwd。
			const H = { a: { sessions: [{ id: 'nocwd' }, { id: 'ok' }] } };
			if (t.latestSessionIdOf(H, 'a', (s) => s !== 'nocwd') !== 'ok') {
				problems.push('latestSessionIdOf: 传了 usable 谓词就必须跳过被否决的会话（无工作区的会话会让输入框灰掉）✗');
			}
			if (t.latestSessionIdOf({ a: { sessions: [{ id: 'nocwd' }] } }, 'a', () => false) !== '') {
				problems.push('latestSessionIdOf: 全部不可用时必须返回空串（调用方据此新建，而不是硬开一条灰输入框的）✗');
			}
			if (typeof t.pickBotWorkspaceId !== 'function' || typeof t.isRegisteredSession !== 'function') {
				problems.push('client.workspaces.js: 缺 __test.pickBotWorkspaceId / isRegisteredSession（新建 bot 会话的工作区登记必须可单测）✗');
			} else {
				// ★ 2026-11-02 真根因：官方 hero `inert = hero && chipTitle === undefined`，chipTitle 来自
				//   「工作区账本里含该会话」。只传 cwd 建的会话不在账本 ⇒ 输入框灰。必须传 **workspaceId**。
				const SNAP = { items: [
					{ workspaceId: 'w1', path: 'G:/a', sessionIds: ['s1'] },
					{ workspaceId: 'w2', path: 'G:/b', sessionIds: ['s2'] },
					{ workspaceId: '', path: 'G:/c', sessionIds: ['s3'] },
				] };
				if (t.pickBotWorkspaceId('s2', SNAP) !== 'w2') {
					problems.push('pickBotWorkspaceId: 应取**当前会话所在**工作区（w2），而不是第一个 ✗');
				}
				if (t.pickBotWorkspaceId('nope', SNAP) !== 'w1' || t.pickBotWorkspaceId(null, SNAP) !== 'w1') {
					problems.push('pickBotWorkspaceId: 当前会话不在账本 / 没有当前会话 ⇒ 取第一个有 workspaceId 的 ✗');
				}
				if (t.pickBotWorkspaceId('s3', SNAP) !== 'w1') {
					problems.push('pickBotWorkspaceId: workspaceId 为空的条目不能被选中（会 400）✗');
				}
				if (t.pickBotWorkspaceId('x', { items: [] }) !== '' || t.pickBotWorkspaceId('x', null) !== '') {
					problems.push('pickBotWorkspaceId: 没有任何工作区必须返回空串（调用方提示"先添加工作区"，不盲建）✗');
				}
				if (t.isRegisteredSession('s1', SNAP) !== true || t.isRegisteredSession('ghost', SNAP) !== false || t.isRegisteredSession('s1', null) !== false) {
					problems.push('isRegisteredSession: 在账本里才算已登记；没登记的会话官方 hero 会禁用输入框 ✗');
				}
			}
			const wsSrcForBots = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'dsh-plugins', 'vssaros-chat-surface', 'lib', 'client.workspaces.js'), 'utf8');
			if (!/JSON\.stringify\(\{ agentPreset: presetId, workspaceId: wsId \}\)/.test(wsSrcForBots)) {
				problems.push('client.workspaces.js: 点 bot 新建会话没传 workspaceId（只传 cwd 不会登记进工作区账本 ⇒ 灰色输入框）✗');
			}
			if (/JSON\.stringify\(\{ agentPreset: presetId, cwd/.test(wsSrcForBots)) {
				problems.push('client.workspaces.js: 点 bot 新建会话又退回传 cwd（那是错方向：不登记账本）✗');
			}
			if (!wsSrcForBots.includes('const usable = (s0) => isRegisteredSession(s0, wsSnap)')
				|| !wsSrcForBots.includes('const freshSid = freshBotSessions.get(id) || ""')) {
				problems.push('client.workspaces.js: 复用「最近会话」前没查是否已登记进工作区（老的未登记会话会让输入框灰掉）✗');
			}
			// 新建成功后必须重拉名册：否则再点同一个 bot 又建一条（名册里还没有它）⇒ 会话越点越多
			if (!/setBotsMsg\(null\);[\s\S]{0,400}?\n\s*reloadBots\(\);\s*openSession\(String\(nextSid\)/.test(wsSrcForBots)) {
				problems.push('client.workspaces.js: 点 bot 新建会话成功后没 reloadBots() ⇒ 再点同一个 bot 会重复新建 ✗');
			}
			const agentsIdx = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'dsh-plugins', 'vssaros-agents', 'lib', 'index.js'), 'utf8');
			if (!/const wantWs = typeof body\.workspaceId === 'string' && body\.workspaceId \? body\.workspaceId : undefined/.test(agentsIdx)
				|| !/\{ workspaceId: wantWs \}/.test(agentsIdx)) {
				problems.push('vssaros-agents/lib/index.js: POST /api/session 没从请求体读 workspaceId 并透传给 session.create（chat-surface 传了也白传）✗');
			}
			if (!/workspaceId: wantWs\s*\}\s*\n?\s*: \{ cwd:/.test(agentsIdx)) {
				problems.push('vssaros-agents/lib/index.js: workspaceId 与 cwd 必须互斥（官方 session.create 同时给会 400）✗');
			}
			notes.push('client.workspaces.js + agents/index.js: Bots 页签点 bot ⇒ 复用须已登记工作区 / 新建传 workspaceId（互斥 cwd）断言通过');
		}
		// ── ⑤-a1 Bot 行右键菜单（2026-11-12：复刻 DS Bot + 显式 New part，10 项 / 3 分隔线 / flags / 动作调度）──
		{
			const need = ['botMenuItems', 'botMenuAction', 'toggleBotFlag', 'sortBotsWithFlags', 'readBotFlags', 'BOT_FLAGS_KEY'];
			const missing = need.filter((k) => typeof t[k] === 'undefined');
			if (missing.length) {
				problems.push('client.workspaces.js: __test 缺 ' + missing.join(' / ') + ' ⇒ Bot 右键菜单不可单测 ✗');
			} else {
				const bot = { id: 'b1', name: 'Bot 一' };
				const items = t.botMenuItems(bot, {}, false);
				const acts = items.filter((x) => !x.sep).map((x) => x.act);
				const want = ['pin', 'unread', 'rename', 'edit', 'duplicate', 'copySession', 'newSession', 'hide', 'delete'];
				if (acts.join(',') !== want.join(',')) {
					problems.push('botMenuItems: 动作顺序与 DS Bot 不一致（应 ' + want.join(' / ') + '，实得 ' + acts.join(' / ') + '）✗');
				}
				const seps = items.filter((x) => x.sep).length;
				if (seps !== 3) { problems.push('botMenuItems: 必须有 3 条分组分隔线（实得 ' + seps + '）✗'); }
				const labels = items.filter((x) => !x.sep).map((x) => x.label);
				for (const label of ['置顶', '标为未读', '重命名 Bot', '编辑 Bot', '复制一份', '复制对话 ID', '新建会话', '从侧栏隐藏', '删除']) {
					if (labels.indexOf(label) < 0) { problems.push('botMenuItems: 缺菜单项「' + label + '」✗'); }
				}
				// ★ 2026-11-09 用户要求移除「设为主 Bot」：反向断言，防复活
				if (acts.indexOf('main') >= 0 || labels.some((x) => String(x).indexOf('主 Bot') >= 0)) {
					problems.push('botMenuItems: 「设为主 Bot」已移除，不许复活 ✗');
				}
				if (items.filter((x) => x.danger).map((x) => x.act).join(',') !== 'delete') {
					problems.push('botMenuItems: 只有「删除」能是 danger（红色）✗');
				}
				const toggled = t.botMenuItems(bot, { pinned: true, hidden: true }, true);
				const toggledLabels = toggled.filter((x) => !x.sep).map((x) => x.label);
				for (const label of ['取消置顶', '标为已读', '取消隐藏']) {
					if (toggledLabels.indexOf(label) < 0) { problems.push('botMenuItems: 状态改变后缺反向文案「' + label + '」✗'); }
				}
				// 旧 localStorage 里残留的 main 键必须被读掉（自愈，不复活排序权重）
				const legacy = t.readBotFlags({ getItem: () => JSON.stringify({ b1: { main: true, pinned: true } }) });
				if (legacy.b1 && 'main' in legacy.b1) { problems.push('readBotFlags: 旧数据里的 main 键没有被清掉 ✗'); }
				const sorted = t.sortBotsWithFlags([{ id: 'a' }, { id: 'p' }, { id: 'm' }], { p: { pinned: true }, m: { main: true } });
				if (sorted.map((x) => x.id).join(',') !== 'p,a,m') {
					problems.push('sortBotsWithFlags: 置顶 > 其余；main 权重已移除（不许再影响顺序）✗');
				}
				const badFlags = t.readBotFlags({ getItem: () => '{not json' });
				if (Object.keys(badFlags).length) { problems.push('readBotFlags: 坏 JSON 必须回落空对象（不能崩 UI）✗'); }
				// 动作调度：每个 act 必须打到正确的依赖，不许静默
				const calls = [];
				const deps = {
					post: (b) => { calls.push('post:' + b.action); return Promise.resolve({}); },
					getDraft: (id) => { calls.push('getDraft:' + id); return Promise.resolve({ name: 'Bot 一', persona: 'p' }); },
					newId: () => 'b1-copy', copy: (s) => calls.push('copy:' + s),
					say: () => calls.push('say'), reload: () => calls.push('reload'),
					startRename: () => calls.push('rename'), openConfig: () => calls.push('edit'),
					confirmDelete: () => calls.push('delete'),
					setFlag: (id, k, on, ex) => calls.push('flag:' + k + ':' + !!on + ':' + !!ex),
					setUnread: (id, on) => calls.push('unread:' + !!on), sessionIdOf: () => 's1',
					newSession: (b) => calls.push('newSession:' + b.id),
				};
				t.botMenuAction('pin', bot, {}, false, deps);
				t.botMenuAction('unread', bot, {}, false, deps);
				t.botMenuAction('rename', bot, {}, false, deps);
				t.botMenuAction('edit', bot, {}, false, deps);
				t.botMenuAction('copySession', bot, {}, false, deps);
				t.botMenuAction('hide', bot, {}, false, deps);
				t.botMenuAction('delete', bot, {}, false, deps);
				t.botMenuAction('duplicate', bot, {}, false, deps);
				t.botMenuAction('newSession', bot, {}, false, deps);
				for (const hit of ['flag:pinned:true:false', 'unread:true', 'rename', 'edit',
					'copy:s1', 'flag:hidden:true:false', 'delete', 'getDraft:b1', 'newSession:b1']) {
					if (calls.indexOf(hit) < 0) { problems.push('botMenuAction: 「' + hit + '」没有被调度（点了没反应）✗'); }
				}
				notes.push('client.workspaces.js: Bot 行右键菜单 10 项 / 3 分隔 / flags / 排序 / 动作调度断言通过');
			}
		}
		// ── ⑤-a2 「当前工作区 / 当前根」统一按**会话 cwd** 判（2026-10-28 用户报障）──────────
		// 真机现场：会话 cwd = `…\sarosis-agents-client`（主根），而 dsh 快照的 `sessionIds` 仍把它列在
		//   `…\Saros-switch` 条目的名下 ⇒ 侧栏 hover 卡片按条目 path 标"当前会话"、chip 下拉按 cwd 标
		//   ⇒ 同一屏出现两个"当前" ✗。
		// 口径：`sessions.byId[sid].cwd`（宿主持有、`session.start({cwd})` 落定即定死）**第一权威**，
		//   `items[].sessionIds`（分组记录，会话换过目录后可能仍挂旧条目）只兜底。
		if (typeof t.rootOfSession !== 'function') {
			problems.push('client.workspaces.js: 缺 __test.rootOfSession（"当前会话在哪个根"必须可单测 ✗）');
		} else {
			const roots = [
				{ path: 'G:/WS/client', name: 'client', isPrimary: true },
				{ path: 'G:/WS/switch', name: 'switch', isPrimary: false },
			];
			const fallback = roots[1];
			const byCwdHit = t.rootOfSession({ s1: { cwd: 'G:\\WS\\client' } }, roots, 's1', fallback);
			if (!byCwdHit || byCwdHit.name !== 'client') {
				problems.push('rootOfSession: 会话 cwd 命中某根时必须返回该根（不能继续用条目的根 ✗）');
			}
			if (t.rootOfSession({ s1: {} }, roots, 's1', fallback) !== fallback) {
				problems.push('rootOfSession: 拿不到 cwd 时必须回落条目对应的根（回落契约 ✗）');
			}
			const crossRoot = t.buildSidebar({
				workspaces: [
					{ workspaceId: 'w1', path: 'G:/WS/client', sessionIds: [] },
					{ workspaceId: 'w2', path: 'G:/WS/switch', sessionIds: ['s9'] },
				],
				records: [{ id: 'ide-1', name: 'Saros', roots }],
				sessionsById: { s9: { title: 'X', updatedAt: 100, cwd: 'G:/WS/client' } },
				archivedIds: [],
				currentSessionId: 's9',
			});
			const cg = crossRoot.find((r) => r.kind === 'group');
			const s9 = cg ? cg.sessions.find((s) => s.id === 's9') : null;
			if (!s9 || s9.isPrimaryRoot !== true || s9.rootName !== null) {
				problems.push('buildSidebar: 会话根标签必须按**会话 cwd** 判（现场：cwd 在主根、快照仍挂在另一个根 ⇒ 会标错根 ✗）');
			}
			notes.push('client.workspaces.js: 会话根标签/当前根按 cwd 优先（sessionIds 兜底）断言通过');
		}
		{
			const wsSrc = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
			if (!/currentRootPath\s*=\s*currentRow[\s\S]{0,80}cwd/.test(wsSrc)) {
				problems.push('client.workspaces.js: 详情卡的"当前会话"根必须先用会话 cwd（只按 dsh 条目 path ⇒ 与 chip 不一致 ✗）');
			}
			const cwSrc = fs.readFileSync(path.join(LIB, 'client.workspace.js'), 'utf8');
			if (!cwSrc.includes('currentWsByDir')) {
				problems.push('client.workspace.js: chip 名称必须先用会话 cwd 认领条目（否则与 chip 下拉里的"当前会话 cwd"不一致 ✗）');
			}
			if (!/const byRoot = dir[\s\S]{0,240}roots/.test(cwSrc)) {
				problems.push('client.workspace.js: 下拉面板的"当前组"必须按会话 cwd 优先、且按组的各根比较 ✗');
			}
		}
		// ── ⑤-b 空会话过滤（2026-10-26 用户报障「工作区下有大量空会话」）────────────────
		// 病根：dsh 客户端每次启动都会在「最近用的工作区」里建一条**空会话**
		//   （官方 restoreSelection → connectWorkspace → connectBlank → sessions.create，
		//   id 形如 session-<uuid>、无任何消息、标题只能回落到 id）⇒ 侧栏被空壳刷屏。
		//   官方侧栏自己也是按 `!row.blank` 过滤的 ⇒ 我们同口径（当前会话例外）。
		{
			const blankRows = t.buildSidebar({
				workspaces: [{ workspaceId: 'w1', path: 'G:/WS/client', sessionIds: ['b1', 's1', 'b2'] }],
				records: [{ id: 'ide-1', name: 'Saros', roots: [{ path: 'G:/WS/client', name: 'client', isPrimary: true }] }],
				sessionsById: {
					s1: { title: 'A', updatedAt: 300 },
					b1: { blank: true, updatedAt: 250 },
					b2: { blank: true, updatedAt: 200 },
				},
				archivedIds: [],
				currentSessionId: 'b1',
			});
			const bg = blankRows.find((r) => r.kind === 'group');
			const ids = bg ? bg.sessions.map((s) => s.id) : [];
			if (ids.indexOf('b2') >= 0) { problems.push('buildSidebar: 空会话（blank）必须隐藏（用户报「工作区下大量空会话」）✗'); }
			if (ids.indexOf('s1') < 0) { problems.push('buildSidebar: 有内容的会话必须照常显示 ✗'); }
			if (ids.indexOf('b1') < 0) { problems.push('buildSidebar: 当前会话即使是空壳也必须显示 ✗'); }
			if (!bg || bg.hiddenBlanks !== 1) { problems.push(`buildSidebar: 隐藏的空会话数应被计数为 1，实际 ${bg ? bg.hiddenBlanks : '(无)'} ✗（不计数=装作没有）`); }
			notes.push('client.workspaces.js: 空会话过滤（blank 位 + 当前会话例外 + 计数）断言通过');
		}
		// 用户要求：左侧栏工作区下方不再显示「已隐藏 N 条空会话」；过滤与 row.hiddenBlanks 仍保留。
		{
			const wsCode = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8')
				.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			if (/hiddenBlanks\s*>\s*0\s*\?\s*react\.createElement\(/.test(wsCode)
				|| /["']已隐藏\s*["']\s*\+/.test(wsCode)
				|| /const\s+hiddenBlanks\s*=\s*rows\.reduce/.test(wsCode)) {
				problems.push('client.workspaces.js: 工作区下方不许再显示「已隐藏 N 条空会话」（过滤与各组计数仍需保留）✗');
			}
			notes.push('client.workspaces.js: 已隐藏空会话提示移除，过滤与计数数据仍保留');
		}
			// ── ⑤-b2 删除会话后本地摘行（★★ 2026-11-13 真机「删掉列表里另一条会话，行没消失」）──
			// 病根：行来自 `workspaces.list` 的 `items[].sessionIds`；Host 的 delete-session 只删磁盘
			//   （日志目录 + 投影缓存），**不碰 `storages/workspace.json` 账本** ⇒ 快照里 sid 还在。
			//   前端 `detach()` 依赖 `ctx.get("workspaces").get(wid).detachSession`，但该方法只存在于
			//   **Host 侧** `dsh-workspace` 实体（页面侧 client 包里 0 命中）⇒ 恒 false；归档兜底也常失败
			//   ⇒ 旧代码落到「但这条仍留在列表里（宿主既无 detachSession 也无法归档）」✗。
			// 修法：删盘成功后把 sid 记进 localStorage，`buildSidebar` 两条分支都过滤 ⇒ 不依赖宿主 API ✓
			{
			const delSrc = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
			const need = [
				['SESSION_DELETED_KEY', '缺已删除会话的本地持久化键（重启后行会"复活" ✗）'],
				['markSessionDeleted', '缺 markSessionDeleted（删盘成功后没记下 sid ✗）'],
				['setDeletedIds((prev) => markSessionDeleted(prev, cur.sid))', '确认删除的 done 回调没接本地摘行 ✗'],
			];
			// ★ 必须与 `buildSidebar({...})` 同一块：只查 "deletedIds," 会被 state 声明骗过（实测假绿）。
			//   依赖数组漏掉 deletedIds ⇒ 首帧之后 setState 也不重算 ⇒ 行仍不消失（实测假绿）。
			const useMemoAt = delSrc.indexOf('const rows = react.useMemo(() => {');
			if (useMemoAt < 0) { problems.push('⑤-b2 找不到会话行的 useMemo ✗'); }
			else {
				const memo = delSrc.slice(useMemoAt, useMemoAt + 2200);
				if (!/\bdeletedIds,/.test(memo)) { problems.push('⑤-b2 buildSidebar 没收到 deletedIds（过滤不生效 ✗）'); }
				if (!/\[[^\]]*\bdeletedIds\b[^\]]*\]/.test(memo)) {
					problems.push('⑤-b2 useMemo 依赖漏掉 deletedIds（setState 后不重算 ⇒ 行仍不消失 ✗）');
				}
			}
			// state 初始化必须读盘（否则每次重载都从头开始、已删行复活）
			if (!/react\.useState\(\(\) => readDeletedSessions\(\)\)/.test(delSrc)) {
				problems.push('⑤-b2 deletedIds 的 useState 没从 localStorage 初始化 ✗');
			}
			for (const [needle, why] of need) {
				if (!delSrc.includes(needle)) { problems.push('⑤-b2 ' + why); }
			}
			// ⚠ 必须剥注释：本次修复的注释里**引用了旧文案**，直接查字符串会被骗成假红。
			const delCode = delSrc.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
			if (/但这条仍留在列表里/.test(delCode)) {
				problems.push('⑤-b2 兜底文案还在说「仍留在列表里」（本地摘行已保证行消失）✗');
			}
			// ① 纯函数：幂等 / 白名单 / 落盘（chunk 用的是裸 `localStorage` ⇒ 注入内存 stub）
			if (typeof t.markSessionDeleted !== 'function' || typeof t.readDeletedSessions !== 'function') {
				problems.push('⑤-b2 __test 缺 markSessionDeleted / readDeletedSessions（纯逻辑不可单测）✗');
			} else {
				const store = new Map();
				const prevLs = globalThis.localStorage;
				globalThis.localStorage = {
					getItem: (k) => (store.has(k) ? store.get(k) : null),
					setItem: (k, v) => { store.set(k, String(v)); },
					removeItem: (k) => { store.delete(k); },
				};
				try {
					const sid = 'session-11111111-1111-4111-8111-111111111111';
					const a = t.markSessionDeleted([], sid);
					if (a.length !== 1 || a[0] !== sid) { problems.push('⑤-b2 markSessionDeleted 没追加 sid ✗'); }
					const b = t.markSessionDeleted(a, sid);
					if (b !== a) { problems.push('⑤-b2 markSessionDeleted 必须幂等（重复删同一条不该产生新数组）✗'); }
					const bad = t.markSessionDeleted(a, '../etc/passwd');
					if (bad !== a) { problems.push('⑤-b2 markSessionDeleted 必须拒绝畸形 sid（与 Host 侧 SESSION_ID_RE 同形）✗'); }
					const persisted = t.readDeletedSessions();
					if (persisted.indexOf(sid) < 0) { problems.push('⑤-b2 markSessionDeleted 没落 localStorage（重载后行会复活）✗'); }
					t.saveDeletedSessions([]);
				} finally {
					if (prevLs === undefined) { delete globalThis.localStorage; } else { globalThis.localStorage = prevLs; }
				}
			}
			// ② 行为：group 与 flat 两条分支都必须过滤
			const delRows = t.buildSidebar({
				workspaces: [
					{ workspaceId: 'w1', path: 'G:/WS/client', sessionIds: ['z1', 'z2'] },
					{ workspaceId: 'w2', path: 'G:/WS/other', sessionIds: ['z3', 'z4'] },
				],
				records: [{ id: 'ide-1', name: 'Saros', roots: [{ path: 'G:/WS/client', name: 'client', isPrimary: true }] }],
				sessionsById: { z1: { title: 'A', updatedAt: 4 }, z2: { title: 'B', updatedAt: 3 }, z3: { title: 'C', updatedAt: 2 }, z4: { title: 'D', updatedAt: 1 } },
				archivedIds: [], currentSessionId: null,
				deletedIds: ['z1', 'z4'],
			});
			const delIds = delRows.flatMap((r) => (r.sessions || []).map((s) => s.id));
			if (delIds.indexOf('z1') >= 0) { problems.push('⑤-b2 buildSidebar group 分支没过滤已删除会话 z1 ✗'); }
			if (delIds.indexOf('z4') >= 0) { problems.push('⑤-b2 buildSidebar flat 分支没过滤已删除会话 z4 ✗'); }
			if (delIds.indexOf('z2') < 0 || delIds.indexOf('z3') < 0) { problems.push('⑤-b2 过滤已删除会话时把正常会话也弄丢了 ✗'); }
			// ③ 删除失败不许隐藏（磁盘数据还在，行仍应可见）
			const noDel = delSrc.indexOf('deleteSessionForever(cur.sid, say, (ok) =>');
			if (noDel < 0 || !/if \(!ok \|\| !cur\) \{ return; \}/.test(delSrc.slice(noDel, noDel + 260))) {
				problems.push('⑤-b2 done 回调必须在 ok=false 时不隐藏（删盘失败却把行藏起来 ✗）');
			}
			notes.push('⑤-b2 删除会话本地摘行：纯逻辑幂等/白名单/落盘 + group&flat 两分支过滤 + 失败不隐藏，断言通过');
			}
			// ── ⑤-c ＋ 按钮（2026-10-26 用户报障「窗口模式点了没反应」）────────────────────
		// 三处**各自都能静默失败**的坑（任一回归 ⇒ 用户只看到"点了没反应"）：
		//   ① 读未声明的 `ctx.remote.directoryPicker`（官方声明了它，我们没声明 ⇒ 读不到）
		//      ⇒ 必须走**已声明**的 `ctx.uiWorkspace` 的 pickDirectory。
		//   ② 读 `res.value.path`（官方 pickDirectory 返回的是**路径字符串**）⇒ 恒 undefined。
		//   ③ 失败只写从不渲染的 state.addWorkspaceError ⇒ 100% 静默（窗口模式没有宿主桥，
		//      连 bridge.notify 都是空转）⇒ 必须**就地渲染**。
		{
			// 只扫**代码**（注释里可以引用旧写法来解释病根，不该把守卫带红）✓
			const code = String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			const must = [
				['const uw = ctx.uiWorkspace;', '＋按钮必须走**已声明**的 uiWorkspace 服务（const uw = ctx.uiWorkspace;）'],
				['uw.pickDirectory(', '＋按钮必须调 uiWorkspace.pickDirectory（官方同一条链）'],
				['ctx.get("workspaces")', 'workspaces 服务必须运行时取（ctx.get）'],
				['setWsMsg', '＋按钮的结果必须进 React state（否则不重渲染=看不见）'],
				['添加工作区失败', '失败文案必须出现在页面上（不许只写 state）'],
				// ★ 2026-10-26：从 .code-workspace 导入多根工作区（页面 → 桥 → IDE）
				['importCodeWorkspace', '必须提供「从 .code-workspace 导入」这个动作'],
				['bridge.importCodeWorkspace', '导入必须走宿主桥（页面读不了文件、也没有文件选择器）'],
				['data-vssaros-ws-menu', '＋ 菜单必须有标记（点外面要能关掉它 ⇒ 靠这个选择器）'],
			];
			for (const [needle, why] of must) {
				if (code.indexOf(needle) < 0) { problems.push(`client.workspaces.js: 缺「${needle}」—— ${why} ✗`); }
			}
			const banned = [
				['ctx.remote.directoryPicker', '不能读未声明的 remote.directoryPicker（恒读不到 ⇒ 点了没反应）'],
				['.value.path', '不能读 res.value.path（官方返回的是路径字符串 ⇒ 恒 undefined）'],
			];
			for (const [needle, why] of banned) {
				if (code.indexOf(needle) >= 0) { problems.push(`client.workspaces.js: 出现「${needle}」—— ${why} ✗`); }
			}
			notes.push('client.workspaces.js: ＋按钮（取法 / 返回形状 / 失败可见）断言通过');
		}
		{
			for (const name of ['normalizeWorkspaceView', 'projectWorkspaceRows', 'deriveWorkspaceSearch', 'adoptWorkspace']) {
				if (typeof t[name] !== 'function') { problems.push(`工作区工具栏缺少可测逻辑：${name}`); }
			}
			if (typeof t.deriveWorkspaceSearch === 'function') {
				const sample = [{ kind: 'flat', label: 'Project', key: 'ws:a', sessions: [
					{ id: 'a', title: 'Needle', at: 2, groupKey: 'ws:a' }, { id: 'b', title: 'Other', at: 1, groupKey: 'ws:a' }, { id: 'blank', blank: true },
				] }];
				const found = t.deriveWorkspaceSearch(sample, 'needle', { items: [{ sessionId: 'b', snippet: 'body' }, { sessionId: 'b' }, { sessionId: 'blank' }] });
				if (JSON.stringify(found.items.map(row => [row.id, row.snippet || ''])) !== JSON.stringify([['a', ''], ['b', 'body']])) {
					problems.push('工作区搜索必须合并本地和正文结果、去重、保留首个摘要并排除空会话');
				}
				const flat = t.projectWorkspaceRows(sample, { groupBy: 'flat', orderBy: 'updated' }, {});
				if (flat.length !== 1 || flat[0].sessions[0].groupKey !== 'ws:a') { problems.push('单列表不能改变会话工作区归属'); }
			}
			for (const marker of ['data-vssaros-view-menu', 'data-vssaros-view-choice', 'data-vssaros-retry-workspace', 'controller.abort()', 'closeSearch()', 'WORKSPACE_VIEW_KEY']) {
				if (!src.includes(marker)) { problems.push(`工作区工具栏缺少交互契约：${marker}`); }
			}
			if (/withSearch\s*\?\s*react\.createElement/.test(src)) { problems.push('工作区搜索入口不能受行数阈值限制'); }
			notes.push('工作区工具栏：视图独立存储 / 搜索合并与摘要去重 / 添加导航重试守卫通过');
		}
		// ── ⑤-d 页脚口径必须与侧栏一致（2026-10-26）────────────────────────────────────
		// 侧栏隐藏了空会话 ⇒ 页脚若还报"1931 条会话" ⇒ 屏幕上同时出现两个互相矛盾的数字 ✗。
		{
			const fSrc = fs.readFileSync(path.join(LIB, 'client.footer.js'), 'utf8');
			const fCode = String(fSrc).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			for (const [needle, why] of [
				['blank === true', '页脚必须按 blank 位把空会话剔出计数'],
				['空会话已隐藏', '页脚必须如实写出被隐藏的空会话条数'],
			]) {
				if (fCode.indexOf(needle) < 0) { problems.push(`client.footer.js: 缺「${needle}」—— ${why} ✗`); }
			}
			notes.push('client.footer.js: 页脚口径（剔空会话 + 如实披露）断言通过');
		}
		// ── ⑤-e 会话 item 高亮必须跟"当前会话"走（2026-10-28 用户报障）──────────────
		// 病根：高亮只看 `bridge.sessionId` —— 那是**宿主绑给这个视图的会话**（基本不变），
		//   而点 item 走的是官方 `uiWorkspace.openSession(sid)` ⇒ 官方当前会话变了、宿主绑定没变
		//   ⇒ 高亮永远钉在原来那条 ✗。
		// ⇒ 口径：`pickCurrentSessionId`（纯函数）按 官方 selection > 我们刚点的 > 宿主绑定 取，
		//   且只有**在册**的候选才配当"当前"（官方 selection 是按 origin 持久化的 ⇒ 可能是别的窗口的）。
		{
			const t2 = loaded && loaded.exports.__test;
			if (!t2 || typeof t2.pickCurrentSessionId !== 'function') {
				problems.push('client.workspaces.js: 缺 __test.pickCurrentSessionId（高亮口径必须可单测 ✗）');
			} else {
				const known = { a: true, b: true };
				// ① 官方当前在册 ⇒ 选它（**即便宿主绑定也在且不同** —— 这正是本次 bug 的核心期望）
				const p1 = t2.pickCurrentSessionId({ official: 'b', local: 'a', bridged: 'a', known });
				if (p1 !== 'b') { problems.push(`pickCurrentSessionId: 官方当前会话在册时应选它，实际 ${p1} ✗（高亮就会不跟着切换）`); }
				// ② 官方当前**不在册**（别的窗口留下的）⇒ 退回我们刚点的那条
				const p2 = t2.pickCurrentSessionId({ official: 'zz', local: 'a', bridged: 'b', known });
				if (p2 !== 'a') { problems.push(`pickCurrentSessionId: 官方当前不在册时应退回 local，实际 ${p2} ✗`); }
				// ③ 没有官方当前 ⇒ 用我们刚点的
				const p3 = t2.pickCurrentSessionId({ official: null, local: 'a', bridged: 'b', known });
				if (p3 !== 'a') { problems.push(`pickCurrentSessionId: 没有官方当前时应选 local，实际 ${p3} ✗`); }
				// ④ local 也不在册 ⇒ 退回宿主绑定
				const p4 = t2.pickCurrentSessionId({ official: null, local: 'zz', bridged: 'b', known });
				if (p4 !== 'b') { problems.push(`pickCurrentSessionId: local 不在册时应退回宿主绑定，实际 ${p4} ✗`); }
				// ⑤ 全空 ⇒ null（不编一个假 id）
				const p5 = t2.pickCurrentSessionId({});
				if (p5 !== null) { problems.push(`pickCurrentSessionId: 全空时应为 null，实际 ${p5} ✗`); }
				notes.push('client.workspaces.js: 高亮口径（官方 selection > 乐观 > 宿主绑定 + 在册过滤）断言通过');
			}
			// 静态面：必须**读官方 selection 并订阅它**（读到新值却不重渲染 ⇒ 高亮照样不动 ✗）
			const code2 = String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			for (const [needle, why] of [
				['uiWorkspace.selection', '必须读官方的当前会话（官方自己记在 selection store 里）'],
				['sel.subscribe', '必须订阅官方 selection（否则读到新值也不会重渲染 ⇒ 高亮不动）'],
				['pickCurrentSessionId(', '高亮必须走统一口径函数（不许各处自己算）'],
			]) {
				if (code2.indexOf(needle) < 0) { problems.push(`client.workspaces.js: 缺「${needle}」—— ${why} ✗`); }
			}
		}
		// ── ⑤-g 弹层必须**夹进视口**（2026-10-28 用户报障「点 preset chip，弹出框 UI 位置错误」）──
		// 病根（两处同一族）：
		//   ① capsule 菜单用 `right: 0`（右对齐 chip 右缘 ⇒ 向**左**展开）⇒ 胶囊 chip 在 header **左侧**
		//      ⇒ 菜单整体越出视图左边缘 ⇒ **被裁掉一半**（截图里就是"只看得见右半截、字被切掉"）✗；
		//   ② preset/模式菜单只写 `left: 0`（贴 chip 左缘向右展开）⇒ **没夹视口** ⇒ chip 靠右时越出右缘 ✗。
		// ⇒ 统一口径：纯函数 `fitMenuBox(anchor, size, viewport, align)`（两个 chunk 同一份逻辑）
		//   —— 先按倾向对齐，再**左右都夹进视口**（放不下往另一边收）✓。
		{
			const cases = [
				{
					file: 'client.capsule.js',
					align: 'right',
					// 胶囊 chip 在 header 左侧（left 10 / right 110），菜单宽 220 ⇒ 旧算法会算出 -110（越左缘）✗
					anchor: { left: 10, right: 110, bottom: 40 },
					size: { w: 220, h: 100 },
					viewport: { vw: 620, vh: 800 },
					expectLeft: 8,
					why: 'chip 靠左 + 右对齐 ⇒ 菜单左缘必须夹到 8（不许越出视图左边缘）',
				},
				{
					file: 'client.preset.js',
					align: 'left',
					// 模式 chip 靠右（left 500 / right 560），菜单宽 300，视口 620 ⇒ 500+300=800 > 612 ⇒ 越右缘 ✗
					anchor: { left: 500, right: 560, bottom: 40 },
					size: { w: 300, h: 200 },
					viewport: { vw: 620, vh: 800 },
					expectLeft: 312,
					why: 'chip 靠右 + 左对齐 ⇒ 菜单左缘必须往左收到视口内（620-8-300）',
				},
			];
			for (const c of cases) {
				const loaded = loadChunk(c.file, makeDocumentStub(), makeWindowStub(makeDocumentStub()));
				const tt = loaded && loaded.exports.__test;
				if (!tt || typeof tt.fitMenuBox !== 'function') {
					problems.push(`${c.file}: 缺 __test.fitMenuBox（弹层夹视口的口径必须可单测 ✗）`);
					continue;
				}
				const got = tt.fitMenuBox(c.anchor, c.size, c.viewport, c.align);
				if (!got || got.left !== c.expectLeft) {
					problems.push(`${c.file}: fitMenuBox 期望 left=${c.expectLeft}，实际 ${got && got.left} —— ${c.why} ✗`);
				}
				// 下方不够 ⇒ 往上收（不落到视口外）
				const bottom = tt.fitMenuBox({ left: 10, right: 110, bottom: 780 }, { w: 200, h: 100 }, { vw: 620, vh: 800 }, 'right');
				if (!bottom || bottom.top !== 692) {
					problems.push(`${c.file}: fitMenuBox 下方放不下时应上收到 top=692，实际 ${bottom && bottom.top} ✗`);
				}
				// 量不到锚点/视口 ⇒ 交零值让调用方回落（不猜位置）
				const none = tt.fitMenuBox(null, { w: 200, h: 100 }, { vw: 620, vh: 800 }, 'right');
				if (!none || none.left !== 0 || none.top !== 0) {
					problems.push(`${c.file}: fitMenuBox 量不到锚点时应返回 {left:0,top:0}（不猜位置），实际 ${JSON.stringify(none)} ✗`);
				}
			}
			// 静态面：菜单不许再写 `right: 0`（那是被裁的元凶）⇒ 位置必须走夹视口的计算
			for (const f of ['client.capsule.js', 'client.preset.js']) {
				const code = String(fs.readFileSync(path.join(LIB, f), 'utf8'))
					.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
				if (/right:\s*0\b/.test(code)) {
					problems.push(`${f}: 菜单不许再用 \`right: 0\` 定位（越出视口 ⇒ 被裁一半，2026-10-28 用户报障）✗`);
				}
				if (code.indexOf('fitMenuBox(') < 0) {
					problems.push(`${f}: 菜单位置必须走 fitMenuBox（统一夹视口口径）✗`);
				}
				// ⚠ 层级：`absolute` + zIndex 只在**祖先层叠上下文**内比较 ⇒ dsh header/composer 自己
				//   就是带 z-index 的定位容器 ⇒ 页签条 / 工作台页可能压在菜单上面 ⇒ "层级错误"✗
				//   （工作区菜单 2026-10-19 已踩过 ⇒ 改 fixed）。两个菜单都必须 fixed ✓。
				if (!/position:\s*"fixed"/.test(code)) {
					problems.push(`${f}: 菜单必须是 \`position: fixed\`（absolute 的 zIndex 只在祖先层叠上下文内比较 ⇒ 会被页签条/浮层压住 ⇒ 层级错误 ✗）`);
				}
			}
			notes.push('client.capsule.js / client.preset.js: 弹层夹视口（左右都不越界 + 下方不够上收）断言通过');
			}
			// ── ⑤-h 模式菜单：位置不许被 fitMenu 的旧坐标覆盖（2026-11-19 用户报障「模式下拉框 UI 位置错误」）──
			// 病根：`client.preset.js` 走 ALWAYS_CHUNKS ⇒ `install(ctx, {bridge,state})` 没有 shell.fitMenu
			// ⇒ 走无壳兜底，而兜底返回旧 absolute 口径 `{ left: 0, maxHeight }`，写在 Object.assign 最后
			// ⇒ 覆盖 `position: fixed` 菜单的视口坐标 box.left ⇒ 菜单钉在视口最左缘（截图：菜单跑到 chip
			//   左边、盖住会话列表），top 却仍在 chip 下方 ⇒ 看起来就是"整体错位"✗✗。
			{
			const src = String(fs.readFileSync(path.join(LIB, 'client.preset.js'), 'utf8'));
			const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			// ⚠ 只查 **fitMenu 定义**这一片：`fitMenuBox` 量不到锚点时合法地返回 `{left:0,top:0}`
			//   （那是给调用方的"不猜位置"信号）⇒ 全文件正则会误伤 ✗。
			const fitCode = code.slice(code.indexOf('const fitMenu ='), code.indexOf('const loadRoster'));
			if (!fitCode || fitCode.indexOf('const fitMenu =') !== 0) {
				problems.push('client.preset.js: 找不到 fitMenu 定义片段（守卫会空跑）✗');
			} else {
				if (/left\s*:/.test(fitCode)) {
					problems.push('client.preset.js: 无壳 fitMenu 兜底不许再返回 `left: 0`（旧 absolute 口径 ⇒ 覆盖 fixed 视口坐标，2026-11-19 用户报障）✗');
				}
				if (!/maxHeight/.test(fitCode)) {
					problems.push('client.preset.js: 无壳 fitMenu 兜底仍须给 maxHeight（菜单过高要能滚）✗');
				}
			}
			if (code.indexOf('menuPositionStyle(box') < 0) {
				problems.push('client.preset.js: 菜单样式必须由 menuPositionStyle(box, …) 最后写位置（不许被 fitMenu 覆盖）✗');
			}
			const loaded = loadChunk('client.preset.js', makeDocumentStub(), makeWindowStub(makeDocumentStub()));
			const t = loaded && loaded.exports.__test;
			if (!t || typeof t.menuPositionStyle !== 'function') {
				problems.push('client.preset.js: 缺 __test.menuPositionStyle（位置合并口径必须可单测 ✗）');
			} else {
				// fit 里故意带上旧口径的 left:0 / top:0 与 right/bottom ⇒ 全部不许盖掉 box 的视口坐标
				const merged = t.menuPositionStyle({ left: 400, top: 120 }, { left: 0, top: 0, right: 8, bottom: 8, maxHeight: 360, overflowY: 'auto' });
				if (merged.left !== 400 || merged.top !== 120 || merged.marginTop !== 0 || merged.visibility !== 'visible') {
					problems.push(`client.preset.js: 位置必须取 box 的视口坐标（left=400/top=120 且可见），实际 ${JSON.stringify(merged)} ✗`);
				}
				if (merged.maxHeight !== 360 || merged.overflowY !== 'auto') {
					problems.push('client.preset.js: fitMenu 的尺寸/溢出必须保留（只剥位置字段）✗');
				}
				if ('right' in merged || 'bottom' in merged) {
					problems.push('client.preset.js: fitMenu 里的 right/bottom 必须剥掉（不许与 fixed 的 left/top 打架）✗');
				}
				const first = t.menuPositionStyle(null, { maxHeight: 360 });
				if (first.visibility !== 'hidden' || first.left !== 0 || first.top !== 0) {
					problems.push(`client.preset.js: 还没量到坐标时首帧必须隐藏（不许用 top:"100%" 闪到视口底部），实际 ${JSON.stringify(first)} ✗`);
				}
			}
			notes.push('client.preset.js: 菜单位置由 box 拍板（fitMenu 只给尺寸 / 首帧不闪）断言通过');
			}
			// ── ⑤-f 启动时**不得**自动展开右栏（2026-10-28 用户报障）──────────────────────
		// 病根：入口（client.js）里有一段"启动时自动点官方 expand 按钮"的逻辑（2026-10-18 加的，
		//   目的是复刻官方 desktop"一进来右栏就是「开始」面板"）⇒ 官方 settle rule 在"空栏被展开"
		//   那一刻才播种「开始」页 ⇒ 我们一自动展开，右栏里就凭空多一个「开始」页 ✗；而且展开态
		//   会被官方**按 session 持久化** ⇒ **每次启动都自动展开** ✗✗。
		// ⇒ 需求：启动时右栏**默认不展开** ⇒ 入口里不许再有"自动点 expand"的代码。
		// ⚠ 但 `client.workbenchNav.js` 里那处 expand **必须留着**：那是用户点了「主页/工作台」
		//   入口之后的动作（用户主动要求看那个页面），不是启动时自动做的 ⇒ 一起删掉就是功能回退 ✗。
		{
			const stripC = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			const entryCode = stripC(fs.readFileSync(path.join(LIB, 'client.js'), 'utf8'));
			if (entryCode.indexOf('data-sidebar-right-expand') >= 0) {
				problems.push('client.js（入口）: 不许在启动时点官方 expand 按钮自动展开右栏 ——'
					+ ' 官方右栏默认就是收起态，「开始」页是"空栏被展开"时才播种的；'
					+ ' 自动展开还会被按 session 持久化 ⇒ 每次启动都自动展开（2026-10-28 用户报障）✗');
			}
			const navCode = stripC(fs.readFileSync(path.join(LIB, 'client.workbenchNav.js'), 'utf8'));
			if (navCode.indexOf('data-sidebar-right-expand') < 0) {
				problems.push('client.workbenchNav.js: 丢了「用户点了主页/工作台入口后撑开右栏」那处 expand ——'
					+ ' 那不是启动时自动做的，是用户主动要求的（删了就是功能回退 ✗）');
			}
			notes.push('client.js / client.workbenchNav.js: 右栏展开时机（启动不自动展开 + 用户点入口仍撑开）断言通过');
		}
		// ── client.workspace.js：hero 面板「只认 chip 发起的 open」（2026-10-17 真机 bug）──────
		// 病根：官方 hero 的 `open` 有两条来源（chip 点击 / 输入框 inert 的 onRequestWorkspace），
		// props 不带来源 ⇒ 我们的 540px 面板被"点输入框"打开、压住会话 ✗。判定抽成 isOpenFromAnchor。
		const wsSrc = fs.readFileSync(path.join(LIB, 'client.workspace.js'), 'utf8');
		const wsDoc = makeDocumentStub();
		const wsWin = makeWindowStub(wsDoc);
		let wsLoaded = null;
		try {
			wsLoaded = loadChunk('client.workspace.js', wsDoc, wsWin);
		} catch (e) {
			problems.push(`client.workspace.js: 装载失败 — ${String((e && e.message) || e)}`);
		}
		const wt = wsLoaded && wsLoaded.exports.__test;
		if (!wt || typeof wt.isOpenFromAnchor !== 'function') {
			problems.push('client.workspace.js: 缺 __test.isOpenFromAnchor（hero 面板来源判定必须可单测 ✗）');
		} else {
			const anchor = { contains: (t) => t === 'child' || t === 'deep' };
			if (wt.isOpenFromAnchor(anchor, anchor) !== true) { problems.push('isOpenFromAnchor: 点在 chip 本身应为 true ✗'); }
			if (wt.isOpenFromAnchor(anchor, 'child') !== true) { problems.push('isOpenFromAnchor: 点在 chip 子孙应为 true ✗'); }
			if (wt.isOpenFromAnchor(anchor, 'composer') !== false) { problems.push('isOpenFromAnchor: 点输入框（非 chip）必须为 false —— 这正是"点输入框弹出下拉框"那处 ✗'); }
			if (wt.isOpenFromAnchor(anchor, null) !== false) { problems.push('isOpenFromAnchor: 没有落点应为 false（宁可不开，不乱弹）✗'); }
			if (wt.isOpenFromAnchor(null, 'composer') !== false) { problems.push('isOpenFromAnchor: 没有锚点应为 false ✗'); }
			notes.push('client.workspace.js: hero 面板 open 来源判定断言通过');
			}
			// ── ⑤-l P0-A/B 状态驱动根集作用域条（2026-11-10）──────────────────────────────
			//  两条硬规矩：① 单根 ⇒ 一行不加（旧界面逐字不变）；② **不谎报可写范围**
			//  （沙箱档位只在 Host 侧，页面读不到 ⇒ 印"可写：全部 N 个根"必随档位变假 ✗）。
			{
			const scopeOf = wt && wt.workspaceScopeOf;
			if (typeof scopeOf !== 'function') {
				problems.push('client.workspace.js: 缺 __test.workspaceScopeOf（作用域条必须状态驱动、可单测 ✗）');
			} else {
				const one = { roots: [{ path: 'G:/WS/app', name: 'app', isPrimary: true }] };
				const s1 = scopeOf(one, 'G:/WS/app');
				if (s1.multi !== false || s1.lines.length !== 0 || s1.limits.length !== 0) {
					problems.push('workspaceScopeOf: 单根必须 multi=false 且 lines/limits 都为空（旧界面逐字不变 ✗）');
				}
				if (scopeOf(null, null).lines.length !== 0) {
					problems.push('workspaceScopeOf: 没有当前组 ⇒ 不注入任何文案 ✗');
				}
				const five = { roots: [
					{ path: 'G:/WS/app', name: 'frontend', isPrimary: true },
					{ path: 'G:/WS/lib', name: 'backend' },
					{ path: 'G:/WS/docs', name: 'contracts' },
				] };
				const s5 = scopeOf(five, 'G:/WS/lib');
				if (s5.multi !== true || s5.count !== 3 || s5.primaryName !== 'frontend' || s5.cwd !== 'G:/WS/lib') {
					problems.push('workspaceScopeOf: 多根 ⇒ 根数/主根名/会话 cwd 必须来自状态 ✗');
				}
				const lines = s5.lines.join('\n');
				if (!lines.includes('根集作用域') || !lines.includes('3 个根') || !lines.includes('主根 frontend') || !lines.includes('绝对路径')) {
					problems.push('workspaceScopeOf: 作用域行必须报根数 / 主根 / 跨根绝对路径 ✗');
				}
				if (!lines.includes('写权限由沙箱策略决定')) {
					problems.push('workspaceScopeOf: 必须如实写"写权限由沙箱策略决定"（不猜档位 ✓）✗');
				}
				// ★ 负对照：任何"可写：全部 N 个根"式的断言都不许出现（会随档位变假 ✗）
				if (/可写[：:]?\s*全部|可写全部/.test(lines) || lines.includes('可写范围：全部')) {
					problems.push('workspaceScopeOf: 不许宣称"可写：全部 N 个根" —— 页面读不到沙箱档位 ✗');
				}
				if (s5.limits.length !== 4) {
					problems.push(`workspaceScopeOf: 多根受限清单应有 4 条，实际 ${s5.limits.length} ✗`);
				}
				const limitText = s5.limits.join('\n');
				for (const key of ['相对路径', 'session.start', '只对新会话生效', 'VCS / HEAD']) {
					if (!limitText.includes(key)) {
						problems.push(`workspaceScopeOf: 受限清单缺"${key}"（只列本仓真实口径 ✓）✗`);
					}
				}
				// ★ 负对照：Cline 的 .clinerules / Checkpoints 不是本仓能力，照搬就是假话 ✗
				if (/\.clinerules|Checkpoints|禁用.*影子/.test(limitText)) {
					problems.push('workspaceScopeOf: 受限清单不许照搬 Cline 的 rules/Checkpoints（本仓没有这套口径 ✗）');
				}
				notes.push('client.workspace.js: P0-A/B 状态驱动作用域条 + 本仓受限清单 + 不谎报可写范围 断言通过');
			}
			// 静态接线 + stale 注释必须消失
			const wsCode = fs.readFileSync(path.join(LIB, 'client.workspace.js'), 'utf8');
			if (!wsCode.includes('data-vssaros-scope-line') || !wsCode.includes('data-vssaros-scope-limits')) {
				problems.push('client.workspace.js: 作用域条 / 折叠清单必须带 data 钩子（守卫与真机自证靠它 ✗）');
			}
			if (!/workspaceScopeOf\(currentGroup, dir\)/.test(wsCode)) {
				problems.push('client.workspace.js: 渲染必须调 workspaceScopeOf(currentGroup, dir)（状态驱动，不许写死文案 ✗）');
			}
			if (wsCode.includes('α「写全部根」还没接入') || wsCode.includes('只报事实、不报')) {
				problems.push('client.workspace.js: 2026-10-16 的"写全部根还没接入/单根"注释已 stale，必须删 ✗');
			}
			const wsCards = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
			// ★ 2026-11-10 用户裁决：工作区 item hover 不弹 tip ⇒ hover 卡尾的指引随之退役。
			//   P0-B 的清单真源仍在 client.workspace.js 的「当前会话」栏（上面已断言 data 钩子）。
			if (wsCards.includes('data-vssaros-hover-scope-hint')) {
				problems.push('client.workspaces.js: hover 卡已删除，不该残留卡尾指引（死文案 ✗）');
			}
			if (wsCards.includes('写权限由沙箱策略决定')) {
				problems.push('client.workspaces.js: hover 卡不许复制第二份受限清单（会与作用域条口径分裂 ✗）');
			}
			notes.push('client.workspace.js / client.workspaces.js: P0-B 单一真源 + 无残留 hover 指引 + stale 注释清理 断言通过');
			}
			// ── ⑤-m 根列表（chip 下拉）+ P1-D 统一切换反馈（2026-11-10）────────────────
			//  ★ 2026-11-10 **用户裁决**：推翻 11-02「行上不加徽标、只放 hover 卡」与 P1-C 的
			//    `<details>` 常驻列表 ⇒ 改为工作区 item 行上「N 个根 ▾」**可点 chip** + 内联下拉。
			//  两条硬规矩：① chip 与下拉必须共用同一份 workspaceRootListOf（不新增真源）；
			//  ② 切换文案只报本面板知道的事实，不许谎报"窗口已切换 / 根集已变化"。
			{
			// P1-C：纯函数行为
			const rootsOf = t && t.workspaceRootListOf;
			if (typeof rootsOf !== 'function') {
				problems.push('client.workspaces.js: 缺 __test.workspaceRootListOf（常驻根列表必须可单测 ✗）');
			} else {
				const one = { roots: [{ path: 'G:/WS/app', name: 'app', isPrimary: true }] };
				const r1 = rootsOf(one, 'G:/WS/app');
				if (r1.multi !== false || r1.items.length !== 0) {
					problems.push('workspaceRootListOf: 单根必须不渲染（旧侧栏逐字不变 ✗）');
				}
				if (rootsOf(null, null).multi !== false) {
					problems.push('workspaceRootListOf: 没有记录 ⇒ 不渲染 ✗');
				}
				const rec = { roots: [
					{ path: 'G:/WS/app', name: 'frontend', isPrimary: true },
					{ path: 'G:/WS/lib', name: 'backend' },
					{ path: 'G:/WS/docs', name: 'contracts' },
				] };
				const r3 = rootsOf(rec, 'G:/WS/lib');
				if (r3.multi !== true || r3.count !== 3) {
					problems.push('workspaceRootListOf: 多根根数必须来自状态 ✗');
				}
				if (!r3.items[0].isPrimary || r3.items[1].isCurrent !== true || r3.items[2].isCurrent !== false) {
					problems.push('workspaceRootListOf: 主根 / 当前会话根必须按 cwd 判（与 hover 卡同源 ✗）');
				}
				if (r3.items[2].name !== 'contracts' || r3.items[2].path !== 'G:/WS/docs') {
					problems.push('workspaceRootListOf: 根名 / 路径必须来自 record.roots ✗');
				}
				// Windows 反斜杠 + 尾斜杠归一（samePath 同口径）
				const rWin = rootsOf(rec, 'g:\\ws\\LIB\\');
				if (rWin.items[1].isCurrent !== true) {
					problems.push('workspaceRootListOf: 当前根比较须与 samePath 同口径（大小写/分隔符/尾斜杠 ✗）');
				}
				notes.push('client.workspaces.js: P1-C 根集视图（单根零渲染 / 主根 / cwd 判当前 / 同源）断言通过');
				}
				// 下拉状态机：行为断言（同时只展开一条 / 再点收起 / 畸形 key 不炸）
				const nextOpen = t && t.nextRootsOpenKey;
				if (typeof nextOpen !== 'function') {
				problems.push('client.workspaces.js: 缺 __test.nextRootsOpenKey（chip 下拉状态机必须可单测 ✗）');
				} else {
				if (nextOpen(null, 'a') !== 'a') { problems.push('nextRootsOpenKey: 首次点击必须展开该条 ✗'); }
				if (nextOpen('a', 'a') !== null) { problems.push('nextRootsOpenKey: 再点同一条必须收起 ✗'); }
				if (nextOpen('a', 'b') !== 'b') { problems.push('nextRootsOpenKey: 点另一条必须切换（同时只开一条 ✗）'); }
				notes.push('工作区 item chip：下拉状态机（展开 / 收起 / 互斥）断言通过');
				}
				// 静态接线（用户 11-10 裁决）：chip 必须真的挂在工作区行上，点击内联下拉
			const wsCardsCode = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
			if (!wsCardsCode.includes('"data-vssaros-ws-roots-chip": key')) {
				problems.push('client.workspaces.js: 工作区 item 必须有「N 个根」chip（用户 11-10 裁决 ✗）');
			}
			if (!wsCardsCode.includes('data-vssaros-ws-roots') || !wsCardsCode.includes('rootsDropped')) {
				problems.push('client.workspaces.js: chip 点击必须下拉出多根内容（受控展开态 ✗）');
			}
			if (!wsCardsCode.includes('workspaceRootListOf(row.record, currentRootPath)')) {
				problems.push('client.workspaces.js: chip / 下拉 / hover 卡必须复用同一份 roots + currentRootPath（不新增真源 ✗）');
			}
			// ★ 单一真源：剥注释后恰好 2 处 = 函数定义 + 唯一调用点。
			//   多一处就意味着又复制了一份根集读取（chip / 下拉 / hover 卡口径会分裂 ✗）。
			const codeNoComments = wsCardsCode.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			const viewCalls = (codeNoComments.match(/workspaceRootListOf\(/g) || []).length;
			if (viewCalls !== 2) {
				problems.push(`client.workspaces.js: 根集只许「1 个定义 + 1 个调用」，实际 ${viewCalls} 处 ✗`);
			}
			// 键盘 / 冒泡 / 窄窗口：chip 是原生 button、带 aria、且必须拦住行 onClick（否则顺手折叠组 ✗）
			for (const [needle, why] of [
				['"aria-expanded": rootsDropped', 'chip 必须带 aria-expanded（键盘可达 ✓）'],
				['"aria-controls": "vssaros-ws-roots-" + key', 'chip 必须 aria-controls 指向下拉'],
				['flex: "none", whiteSpace: "nowrap"', 'chip 必须 flex:none（窄侧栏不裁剪 ✓）'],
				['setRootsOpenKey(nextRootsOpenKey(rootsOpenKey, key))', 'chip 必须走可单测的纯状态机（可开可收 ✗）'],
			]) {
				if (!wsCardsCode.includes(needle)) { problems.push(`client.workspaces.js: ${why} ✗`); }
			}
			// ⚠ stopPropagation 是通用写法（其它菜单按钮也用）⇒ 必须**限定在 chip 按钮块内**，
			//   否则删掉 chip 那一处仍会绿（反向突变实证 ✗）。
			const chipStart = wsCardsCode.indexOf('"data-vssaros-ws-roots-chip"');
			const chipBlock = chipStart >= 0 ? wsCardsCode.slice(chipStart, chipStart + 1400) : '';
			if (!chipBlock.includes('e.stopPropagation()')) {
				problems.push('client.workspaces.js: chip 的 onClick 必须 stopPropagation（否则顺手折叠工作区组 ✗）');
			}
			if (!/rootsView\.multi \? react\.createElement\("button"/.test(wsCardsCode)) {
				problems.push('client.workspaces.js: chip 只能在多根时渲染（单根旧界面逐字不变 ✗）');
			}
			// ⚠ 剥掉注释再判：说明演进史的注释里会提到 `<details>` 字样，不能算残留代码 ✗
			const wsCodeNoComments = wsCardsCode.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			if (/react\.createElement\("details"/.test(wsCodeNoComments)) {
				problems.push('client.workspaces.js: 旧 <details> 常驻根列表已被 chip 下拉取代，不该残留 ✗');
			}
			// ★ 2026-11-10 用户裁决：工作区 item hover **不弹 tip** ⇒ 整条链路必须真的删干净
			for (const [needle, why] of [
				['function HoverCard(', 'HoverCard 组件不该残留（会变成死代码 ✗）'],
				['react.createElement(HoverCard', '不许渲染工作区 hover 卡 ✗'],
				['const [hover, setHover]', '工作区 hover state 不该残留 ✗'],
				['openHover(', '工作区行不许有 hover 触发函数 ✗'],
				['closeHover(', 'closeHover 调用点不该残留 ✗'],
				['hoverTimer', '工作区 hover timer 不该残留（注释除外 ✗）'],
			]) {
				if (wsCodeNoComments.includes(needle)) { problems.push(`client.workspaces.js: ${why}`); }
			}
			// 行容器上不许再挂 onMouseEnter/onMouseLeave 的 hover 触发（官方行只保留 CSS 高亮）
			const projRowStart = wsCodeNoComments.indexOf('className: "vssaros-ws-project"');
			const projRow = projRowStart >= 0 ? wsCodeNoComments.slice(projRowStart, projRowStart + 900) : '';
			if (/onMouseEnter:\s*\(e\)\s*=>\s*openHover/.test(projRow) || /onMouseLeave:\s*closeHover/.test(projRow)) {
				problems.push('client.workspaces.js: 工作区行不许挂 hover 触发（用户裁决：不弹 tip ✗）');
			}
			// 会话行 hover 卡必须仍在（官方同款，别误删）
			if (!wsCodeNoComments.includes('data-vssaros-sess-hover') || !wsCodeNoComments.includes('openSessHover')) {
				problems.push('client.workspaces.js: 会话行官方 hover 卡必须保留（本刀只删工作区 tip ✗）');
			}
			notes.push('工作区 item chip：多根展示 / 点击下拉 / 单一真源 / 键盘可达 / 单根零注入 / 无 hover tip 断言通过');

			// P1-D：纯函数行为
			const feedbackOf = wt && wt.switchFeedbackOf;
			if (typeof feedbackOf !== 'function') {
				problems.push('client.workspace.js: 缺 __test.switchFeedbackOf（切换反馈必须统一且可单测 ✗）');
			} else {
				const ok = feedbackOf({ ok: true, targetPath: 'G:/WS/lib', targetName: 'backend', fromCwd: 'G:/WS/app' });
				// ★ 方案 A：单向桥 resolve 只代表「请求已转发」⇒ 必须写「已请求」，不许谎报已完成 ✗
				if (!ok.includes('已请求在 backend 新建会话') || !ok.includes('原会话仍在 app')) {
					problems.push('switchFeedbackOf: 成功文案必须写「已请求」+ 报目标根 / 原会话根 ✗');
				}
				if (!ok.includes('只对新会话生效')) {
					problems.push('switchFeedbackOf: 必须写明"根集若有变化只对新会话生效" ✓✗');
				}
				if (/已在 .* 开新会话|切换成功|已完成切换/.test(ok)) {
					problems.push('switchFeedbackOf: 不许谎报「已开新会话」（渲染侧成败传不回页面 ✗）');
				}
				const bad = feedbackOf({ ok: false, targetPath: 'G:/WS/lib', fromCwd: 'G:/WS/app', error: '宿主拒绝' });
				if (!bad.includes('切换失败') || !bad.includes('宿主拒绝') || !bad.includes('会话未改动')) {
					problems.push('switchFeedbackOf: 失败文案必须含原因 + 明确会话未改动 ✗');
				}
				// ★ 负对照：客户端不知道 Host 侧根集快照、也不切 IDE 窗口 ⇒ 不许谎报
				for (const s of [ok, bad]) {
					if (/窗口已切换|根集已变化|IDE 窗口已|已切换到新根集/.test(s)) {
						problems.push('switchFeedbackOf: 不许谎报"窗口已切换 / 根集已变化"（页面读不到这些事实 ✗）');
					}
				}
				notes.push('client.workspace.js: P1-D 统一切换反馈（成功/失败 + 不谎报窗口/根集）断言通过');
			}
			// P1-D：静态接线 —— 三条分支都走统一文案；失败通道不许弱化
			const wsEntryCode = fs.readFileSync(path.join(LIB, 'client.workspace.js'), 'utf8');
			if (!/setNote\(feedback\(\{ ok: true \}\)\)/.test(wsEntryCode)) {
				problems.push('client.workspace.js: 切换成功也要写 note（否则只有诊断日志、用户看不到 ✗）');
			}
			const failUses = (wsEntryCode.match(/fail\(feedback\(\{ ok: false/g) || []).length;
			if (failUses !== 2) {
				problems.push(`client.workspace.js: 失败两条分支（reject/throw）都要走统一文案，实际 ${failUses} 处 ✗`);
			}
			if (!/bridge\.notify\("attention", msg\)/.test(wsEntryCode)) {
				problems.push('client.workspace.js: 失败必须仍走既有 bridge.notify("attention") 当场可见（不许弱化 ✗）');
			}
			notes.push('client.workspace.js / client.workspaces.js: P1-C/D 静态接线（常驻 details / 三分支统一 / 失败可见）断言通过');
		}
		// ── ⑤-p 方案 A：hero 根行只读 + 宿主黑洞修复 + 不谎报（2026-11-10）──────────
		//  用户报「hero 工作区 chip 下拉里点开会话没反应」。三条硬规矩：
		//   ① hero 根行只读（官方 onPick 只认 workspaceId ⇒ 不画「选为当前根」假动作）；
		//   ② 宿主 not ready 早退必须**抛错**（否则 _notifySwitchFailure 永不触发 ⇒ 静默黑洞）；
		//   ③ 页面成功文案不许谎报「已开新会话」（单向桥 resolve 只代表请求已转发）。
		{
			const rowPolicy = wt && wt.rootRowPolicyOf;
			const actionPolicy = wt && wt.detailActionPolicyOf;
			if (typeof rowPolicy !== 'function' || typeof actionPolicy !== 'function') {
				problems.push('client.workspace.js: 缺 __test.rootRowPolicyOf / detailActionPolicyOf（分屏策略必须可单测 ✗）');
			} else {
				const heroPrimary = rowPolicy('hero', { isPrimary: true, isCurrent: false }, true);
				const heroOther = rowPolicy('hero', { isPrimary: false, isCurrent: false }, true);
				// ★ hero 所有根行一律禁用（连主根也不给「可点」假象）
				if (heroPrimary.disabled !== true || heroOther.disabled !== true) {
					problems.push('rootRowPolicyOf: hero 根行必须全部只读（没有待发 cwd 通道 ✗）');
				}
				if (heroPrimary.hint.includes('开会话') || heroOther.hint.includes('开会话')) {
					problems.push('rootRowPolicyOf: hero 行尾不许再写「开会话 →」（5 个误导按钮的来源 ✗）');
				}
				// ★ header：当前根禁用；其它根可点且文案明确「新建会话」
				const hCur = rowPolicy('header', { isPrimary: true, isCurrent: true }, true);
				const hOther = rowPolicy('header', { isPrimary: false, isCurrent: false }, true);
				if (hCur.disabled !== true || hOther.disabled !== false || !hOther.hint.includes('新建会话')) {
					problems.push('rootRowPolicyOf: header 当前根禁用、其它根可点且文案必须是「新建会话」✗');
				}
				const hNoBridge = rowPolicy('header', { isPrimary: false, isCurrent: false }, false);
				if (hNoBridge.disabled !== true) {
					problems.push('rootRowPolicyOf: 页面桥不支持时必须禁用（不画点了没反应的按钮 ✗）');
				}
				// ★ 主命令：hero 隐藏（无动作可落地）；header 当前项禁用
				if (actionPolicy('hero', false, true).hidden !== true || actionPolicy('hero', true, true).hidden !== true) {
					problems.push('detailActionPolicyOf: hero 必须不出主命令按钮 ✗');
				}
				const aHeader = actionPolicy('header', false, true);
				if (aHeader.hidden !== false || aHeader.disabled !== false || !aHeader.label.includes('当前会话保持不变')) {
					problems.push('detailActionPolicyOf: header 主命令必须可见并写明「当前会话保持不变」✗');
				}
				if (actionPolicy('header', true, true).disabled !== true) {
					problems.push('detailActionPolicyOf: header 当前项主命令必须禁用 ✗');
				}
				notes.push('方案 A：分屏策略（hero 全只读 / header 当前根禁用 / 桥缺失禁用 / 主命令显隐）断言通过');
			}
			const wsEntry2 = fs.readFileSync(path.join(LIB, 'client.workspace.js'), 'utf8');
			// 接线：根行 / 主命令都走纯函数；switchTo 要有 hero 根行的防御闸
			if (!wsEntry2.includes('rootRowPolicyOf(mode,') || !wsEntry2.includes('detailActionPolicyOf(mode, isCurrent, canSwitchSession)')) {
				problems.push('client.workspace.js: 渲染必须调用分屏策略纯函数（不许写死文案 ✗）');
			}
			if (!/mode === "hero" && row && row\.kind === "root"/.test(wsEntry2)) {
				problems.push('client.workspace.js: switchTo 必须拦住 hero 根行（绕过 disabled 直接调 onClick 也不许造空会话 ✗）');
			}
			if (wsEntry2.includes('"开会话 →"') || wsEntry2.includes('"以此主根开会话"')) {
				problems.push('client.workspace.js: 旧的「开会话」文案必须清干净（统一为「新建会话」✗）');
			}
			// ★ 宿主黑洞：TS 侧 not ready 早退必须抛错（这是「点了没反应」的根因）
			const hostTs = fs.readFileSync(path.join(HERE, '..', 'src', 'vs', 'sessions', 'contrib',
				'dshHarness', 'electron-browser', 'dshChatInstanceHost.ts'), 'utf8');
			const hostBlock = hostTs.slice(hostTs.indexOf('private async _doSwitchWorktree'), hostTs.indexOf('private async _doSwitchWorktree') + 1400);
			if (!/not ready/.test(hostBlock) || !/throw new Error\(reason\)/.test(hostBlock)) {
				problems.push('dshChatInstanceHost.ts: not ready 早退必须抛错，否则 _notifySwitchFailure 永不触发（静默黑洞 ✗）');
			}
			// 幂等早退仍应 return（不是失败，不该弹通知）
			if (!hostTs.includes('已在该目录的会话上（幂等，无动作')) {
				problems.push('dshChatInstanceHost.ts: 幂等早退必须保留 return（不能被当成失败弹通知 ✗）');
			}
			// ★ 2026-11-14 真机第 6 轮「点切换显示已请求、界面零变化」：页面侧链路已通，
			//   剩下的是宿主三条静默路径 + 已知 preset 真因。逐条钉住，防止被回退。
			for (const [needle, why] of [
				['private _switchStartedAt = 0;', '必须记录切换开始时刻（否则 single-flight 卡死检测不了）'],
				['Date.now() - this._switchStartedAt > 6_000', 'single-flight 卡死阈值必须 ≤6s（20s 会让用户白等，与 preset 切换共用会互相顶掉）'],
				['force unlock', '强制解锁必须留日志'],
				['已在 ${worktreePath} 的会话上，无需切换', '幂等早退必须给用户可见说明（页面桥单向，页面看不到）'],
				['agentPreset: undefined', 'startSession 因 preset 无效失败时必须用 base preset 重试一次'],
				['已切换到 ${worktreePath}', '切换成功必须有可见回执（宿主跑没跑到这一步要能自证）'],
			['switchWorktree 分段耗时 startSession=', '必须有分段计时日志（否则「切换很慢」无从定位）'],
			['(tTotal / 1000).toFixed(1)', '成功通知必须带总耗时（用户能直接报出秒数）'],
			['private _pendingSwitch: string | undefined;', 'single-flight 忙时必须排队保留最后一次点击（不许丢弃）'],
			['this._pendingSwitch = worktreePath;', '忙时必须把本次点击的目录写进排队位（否则排队是空的、补跑永不触发）'],
			['补跑排队请求', '当前切换结束后必须自动补跑排队请求，不并发覆盖'],
			['this._pendingSwitch = undefined;', '卡死解锁/补跑后必须清掉排队态，避免重复切换'],
			]) {
				if (!hostTs.includes(needle)) { problems.push('dshChatInstanceHost.ts: ' + why + ' ✗'); }
			}
			notes.push('方案 A：宿主可见失败出口 / 幂等早退保留 / single-flight 解锁 / preset 重试 / 成功回执 / 旧文案清理 断言通过');
		}
		// ── ⑤-n P1-E 术语统一（2026-11-10）────────────────────────────────────────
			//  ★ 三层术语各管一件事，不许互相污染：
			//    ① 用户可见中文 = 「N 个根」「主根」「关联根」（rootCountLabel 是唯一读口）；
			//    ② 模型提示词 = 英文 primary / additional（foundation/workspacePrompt.js，守卫 A4 按英文钉住）；
			//    ③ 协议字段 = isPrimary / roots / relatedRoots（dshBridgeProtocol.ts，改名会断 IDE↔Host）。
			{
			const labelOf = (m) => m && m.rootCountLabel;
			const a = labelOf(t), b = labelOf(wt);
			if (typeof a !== 'function' || typeof b !== 'function') {
				problems.push('P1-E: 两个 chunk 都必须导出 __test.rootCountLabel（术语真源可单测 ✗）');
			} else {
				for (const [fn, name] of [[a, 'client.workspaces.js'], [b, 'client.workspace.js']]) {
					if (fn(3) !== '3 个根') { problems.push(`${name}: rootCountLabel(3) 必须是"3 个根"（不许"3 根" ✗）`); }
					if (fn(0) !== '0 个根') { problems.push(`${name}: rootCountLabel(0) 必须稳定输出 ✗`); }
					if (fn(undefined) !== '0 个根' || fn(-2) !== '0 个根' || fn(2.7) !== '2 个根') {
						problems.push(`${name}: 畸形/负数/小数输入必须收敛，不许出现 NaN / 负根数 ✗`);
					}
				}
				if (a(5) !== b(5)) { problems.push('P1-E: 两份同形副本行为不一致 ✗'); }
				notes.push('P1-E: rootCountLabel 行为（3 个根 / 畸形收敛 / 两份行为一致）断言通过');
			}
			// 逐字同形对账：把两个函数体抠出来比（本仓惯例：跨 chunk 不能 import ⇒ 同形各存一份 ✓）
			const bodyOf = (src) => {
				const m = src.match(/function rootCountLabel\(n\) \{[\s\S]*?\n\t\t\}/);
				return m ? m[0].replace(/\r/g, '') : null;
			};
			const srcWs = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
			const srcCw = fs.readFileSync(path.join(LIB, 'client.workspace.js'), 'utf8');
			const bodyA = bodyOf(srcWs), bodyB = bodyOf(srcCw);
			if (!bodyA || !bodyB || bodyA !== bodyB) {
				problems.push('P1-E: 两个 chunk 的 rootCountLabel 必须**逐字同形**（同形各存一份，守卫对账 ✗）');
			}
			// 用户可见文案里不许再裸拼「N 根」/「N 个根」字面量（函数体内那一处除外）
			for (const [src, name] of [[srcWs, 'client.workspaces.js'], [srcCw, 'client.workspace.js']]) {
				const code = String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
				const withoutFn = code.replace(/function rootCountLabel\(n\) \{[\s\S]*?\n\t\t\}/, '');
				if (/\+\s*"\s*根|\+\s*"\s*个根|\+\s*'(\s*)根|\+\s*'(\s*)个根/.test(withoutFn)) {
					problems.push(`${name}: 用户可见文案不许再裸拼"N 根"/"N 个根"，一律走 rootCountLabel() ✗`);
				}
			}
			// 三层隔离：模型提示词保持英文、协议字段保持 isPrimary、UI 不出现 primary/additional 标签
			const promptSrc = fs.readFileSync(path.join(HERE, 'vssaros-foundation', 'lib', 'workspacePrompt.js'), 'utf8');
			if (!/\(r\.isPrimary \? 'primary' : 'additional'\)/.test(promptSrc)) {
				problems.push('P1-E: 模型提示词必须保持英文 primary/additional（给 LLM 的结构化文本，不许中文化 ✗）');
			}
			if (/\? '主根' : '关联根'/.test(promptSrc)) {
				problems.push('P1-E: 模型提示词里不许塞中文「主根/关联根」（三层术语串味 ✗）');
			}
			const protocolSrc = fs.readFileSync(path.join(HERE, '..', 'src', 'vs', 'sessions', 'contrib',
				'dshHarness', 'common', 'dshBridgeProtocol.ts'), 'utf8');
			if (!protocolSrc.includes('isPrimary')) {
				problems.push('P1-E: 协议字段必须保持 isPrimary（改名会断 IDE↔Host ✗）');
			}
			for (const [src, name] of [[srcWs, 'client.workspaces.js'], [srcCw, 'client.workspace.js']]) {
				const code = String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
				if (/"\s*primary\s*"|"\s*additional\s*"/.test(code)) {
					problems.push(`${name}: 用户可见文案不许用英文 primary/additional 当标签（三层术语串味 ✗）`);
				}
			}
			notes.push('P1-E: 三层术语隔离（UI 中文 / 模型英文 / 协议字段）+ 同形对账 + 零裸拼 断言通过');
			}
			// ── ⑤-o P2-F 动作边界 / hover 延迟真源 / 主题色（2026-11-10）────────────────
		//  ★ 三项都不能"补成假动作"：
		//    ① 工作区重命名 / 删除 IDE 记录：页面桥单向只读，chunk 没有写回通道；
		//    ② 独立设置 cwd：session.start({cwd}) 定死，换根 = 在目标根开新会话；
		//    ③ hover 350/800 是官方对齐的刻意差异 ⇒ 统一的是**配置真源**，不合并数值。
		{
			const srcWs2 = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
			const srcCw2 = fs.readFileSync(path.join(LIB, 'client.workspace.js'), 'utf8');
			const codeWs = srcWs2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			const codeCw = srcCw2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

			// ① hover 延迟：★ 2026-11-10 用户裁决后工作区 hover tip 已删除，只剩**会话行**一处
			const delayOf = t && t.hoverDelayOf;
			if (typeof delayOf !== 'function') {
				problems.push('P2-F: 缺 __test.hoverDelayOf（hover 延迟必须有可单测的配置真源 ✗）');
			} else {
				if (delayOf('session') !== 800) {
					problems.push('P2-F: 会话行必须 800ms（官方 openDelayMs=800；太快会划过一路弹卡 ✗）');
				}
				if (delayOf('unknown') !== 800 || delayOf(undefined) !== 800) {
					problems.push('P2-F: 未知 kind 必须稳定回落到会话延迟（不吐 undefined ✗）');
				}
				if (Object.prototype.hasOwnProperty.call(t.HOVER_DELAYS || {}, 'workspace')) {
					problems.push('P2-F: 工作区 hover 已停用，不该再留 350ms 死配置 ✗');
				}
			}
			if (!t || !t.HOVER_DELAYS || !Object.isFrozen(t.HOVER_DELAYS)) {
				problems.push('P2-F: HOVER_DELAYS 必须是冻结的配置表（运行期不许被改 ✗）');
			}
			if (!codeWs.includes('hoverDelayOf("session")')) {
				problems.push('P2-F: 会话行 hover 的 setTimeout 必须走 hoverDelayOf()（不许直接引用旧常量 ✗）');
			}
			// ⚠ 不能用裸 `HOVER_DELAY_MS`：它是 `SESS_HOVER_DELAY_MS` 的子串 ⇒ 会误报 ✗
			if (codeWs.includes('hoverDelayOf("workspace")') || /const\s+HOVER_DELAY_MS\s*=/.test(codeWs)) {
				problems.push('P2-F: 工作区 hover 已停用，不该残留其延迟调用/常量 ✗');
			}
			if (/\},\s*SESS_HOVER_DELAY_MS\)/.test(codeWs)) {
				problems.push('P2-F: 会话 hover setTimeout 不许直接引用命名常量 ✗');
			}
			// 另有 350ms 是「会话内设置页签激活兜底」的重试，**不是 hover** ⇒ 本刀刻意不动。
			// 钉住它的特征文案与数值，防止后续有人把它误当成"第二套 hover 延迟"改掉 ✗。
			if (!/会话内设置页签没落到 Bot 分段/.test(srcWs2)
				|| !/botsSay\("会话内设置页签没落到 Bot 分段[\s\S]{0,120}?\}, 350\)/.test(codeWs)) {
				problems.push('P2-F: 非 hover 的 350ms 设置页签兜底不该被改动（别误当成 hover 延迟 ✗）');
			}
			notes.push('P2-F: hover 延迟配置真源（350/800 刻意不同 / 冻结 / 两处调用点统一）断言通过');

			// ② 主题色：HoverCard 已删除，只剩 chip 下拉里「● 当前会话」的字色
			const styleConst = t && t.CUR_ROOT_STYLE;
			if (!styleConst || !styleConst.color) {
				problems.push('P2-F: 缺 __test.CUR_ROOT_STYLE.color（● 当前会话 字色可单测 ✗）');
			} else {
				for (const [key, value] of Object.entries(styleConst)) {
					if (!String(value).includes('var(--dsw-alias-')) {
						problems.push(`P2-F: CUR_ROOT_STYLE.${key} 必须用 --dsw-alias-* 主题令牌（明暗都跟随 ✗）`);
					}
				}
				if ('background' in styleConst || 'outline' in styleConst) {
					problems.push('P2-F: HoverCard 已删除，不该再留无调用点的底色/描边配置 ✗');
				}
			}
			// 剥掉常量定义后，chip 下拉里不许再残留裸绿色字面量（兜底常量本身允许）
			const withoutStyle = codeWs.replace(/const CUR_ROOT_STYLE[\s\S]*?\}\);/, '');
			if (/rgba\(\s*67\s*,\s*184\s*,\s*96|#43b860/.test(withoutStyle)) {
				problems.push('P2-F: chip 下拉里不许再有裸绿色字面量，一律走 CUR_ROOT_STYLE ✗');
			}
			if (!codeWs.includes('CUR_ROOT_STYLE.color')) {
				problems.push('P2-F: chip 下拉的「● 当前会话」必须真的引用 CUR_ROOT_STYLE.color ✗');
			}
			notes.push('P2-F: chip 下拉字色收敛到主题令牌（无死配置）断言通过');

			// ③ 动作边界：单根零注入 / 多根三条 / 不承诺假动作 / 接线渲染
			const actionsOf = wt && wt.workspaceActionNotes;
			if (typeof actionsOf !== 'function') {
				problems.push('P2-F: 缺 __test.workspaceActionNotes（动作边界必须状态驱动、可单测 ✗）');
			} else {
				if (actionsOf(false).length !== 0 || actionsOf(undefined).length !== 0) {
					problems.push('P2-F: 单根必须零注入（旧界面逐字不变 ✗）');
				}
				const acts = actionsOf(true);
				if (acts.length !== 3) {
					problems.push(`P2-F: 多根动作边界应有 3 条，实际 ${acts.length} ✗`);
				}
				const joined = acts.join('\n');
				for (const key of ['IDE 侧栏', '只摘 dsh 侧登记', '不能独立设置 cwd']) {
					if (!joined.includes(key)) {
						problems.push(`P2-F: 动作边界必须说清"${key}"（不藏起来 ✓）✗`);
					}
				}
				// ★ 负对照：不许把做不到的事写成可点的入口（会变成"点了没反应"的假动作 ✗）
				if (/点击这里重命名|可直接设置|在这里删除 IDE|本页可改名/.test(joined)) {
					problems.push('P2-F: 动作边界不许承诺 dsh 侧做不到的入口（假动作 ✗）');
				}
			}
			if (!codeCw.includes('workspaceActionNotes(multi)') || !codeCw.includes('data-vssaros-scope-actions')) {
				problems.push('P2-F: 动作边界必须状态驱动并真的渲染（默认折叠 details ✗）');
			}
			// stale 注释必须消失：removeWorkspace 早在 11-02 就实现了
			if (srcWs2.includes('删除工作区要走宿主改 IDE 记录，另议')) {
				problems.push('P2-F: 「删除工作区…另议」注释已 stale（removeWorkspace 已实现），必须删 ✗');
			}
			notes.push('P2-F: 动作边界说明（单根零注入 / 多根三条 / 无假动作 / stale 注释清理）断言通过');
		}
		// 折叠切换的**绝对期望值**（2026-10-17 真机 bug：约定写反 ⇒ 点了无法收缩；
		// 相对比较型断言（两次不同）恒真 ⇒ 必须钉死每一步的值 ✓）。
		if (typeof t.nextCollapsed !== 'function') {
			problems.push('client.workspaces.js: 缺 __test.nextCollapsed（折叠约定必须可单测 ✗）');
		} else {
			const once = t.nextCollapsed({}, 'k');
			const twice = t.nextCollapsed(once, 'k');
			const explicitOpen = t.nextCollapsed({ k: false }, 'k');
			if (once.k !== true) { problems.push('nextCollapsed: 展开态点击应得到 true（折叠）✗ —— 这正是"点了无法收缩"的那处约定 ✗'); }
			if (twice.k !== false) { problems.push('nextCollapsed: 折叠态再点应回到 false（展开）✗'); }
			if (explicitOpen.k !== true) { problems.push('nextCollapsed: 显式展开（false）点击应得到 true（折叠）✗'); }
		}
		// ── ⑤-h 会话行操作：右键菜单（置顶/重命名/复制 id/归档）+ 组内拖拽排序（2026-10-29 用户要求）──
		// 用户原话：「工作区中的会话 item 支持右键弹出 menu，包含 重命名、置顶；会话 item 可拖拽移动位置」。
		// 四条操作都**只走官方服务**（自造状态 ⇒ 跨窗口不一致 / 与官方 UI 打架 ✗）。两个最容易回归的点各一条：
		//   ① 置顶必须**恒在组首**（官方 reconcileManualOrder 同口径）—— 否则"置顶"看起来没生效 ✗；
		//   ② 拖拽必须**只组内 + 不跨置顶区** —— 跨组=改会话 cwd（官方也不支持），跨区会让①失真 ✗。
		{
			const need = ['toIdSet', 'normalizeOrderMap', 'sortBySavedOrder', 'orderGroupSessions', 'moveWithin', 'canDrop'];
			for (const fn of need) {
				if (typeof t[fn] !== 'function') { problems.push(`client.workspaces.js: 缺 __test.${fn}（会话行操作必须可单测 ✗）`); }
			}
			if (need.every((fn) => typeof t[fn] === 'function')) {
				const mk = (id, at) => ({ id, at: at || 0 });
				// ① 置顶恒在组首（pinned 之间保持既有相对顺序）
				const ordered = t.orderGroupSessions(
					[mk('n1', 300), mk('p1', 200), mk('n2', 100), mk('p2', 50)],
					{ pinned: ['p2', 'p1'] },
				).map((s) => s.id);
				if (ordered.join(',') !== 'p1,p2,n1,n2') {
					problems.push(`orderGroupSessions: 置顶必须恒在组首且保持相对顺序，期望 p1,p2,n1,n2，实际 ${ordered.join(',')} ✗`);
				}
				// ② 手动序生效；保存表里没有的按**原相对顺序**追加（不重新按时间排）
				const bySaved = t.sortBySavedOrder([mk('a'), mk('b'), mk('c')], ['c', 'a']).map((s) => s.id);
				if (bySaved.join(',') !== 'c,a,b') { problems.push(`sortBySavedOrder: 期望 c,a,b，实际 ${bySaved.join(',')} ✗`); }
				// ③ 拖到目标之后 / 之前；源不在表里 ⇒ null（不许写坏顺序）
				const after = t.moveWithin([mk('a'), mk('b'), mk('c')], 'a', 'c', true);
				if (!after || after.join(',') !== 'b,c,a') { problems.push(`moveWithin(a→c 之后): 期望 b,c,a，实际 ${after && after.join(',')} ✗`); }
				const before = t.moveWithin([mk('a'), mk('b'), mk('c')], 'c', 'a', false);
				if (!before || before.join(',') !== 'c,a,b') { problems.push(`moveWithin(c→a 之前): 期望 c,a,b，实际 ${before && before.join(',')} ✗`); }
				if (t.moveWithin([mk('a')], 'zz', 'a', true) !== null) { problems.push('moveWithin: 源不在表里必须返回 null（否则顺序表会被写坏）✗'); }
				// ④ 拖放判定：同组同区才允许
				const gk = 'rec:1';
				if (t.canDrop({ sid: 'a', groupKey: gk, pinned: false }, { sid: 'b', groupKey: gk, pinned: false }) !== true) {
					problems.push('canDrop: 同组普通项之间必须允许 ✗');
				}
				if (t.canDrop({ sid: 'a', groupKey: gk, pinned: false }, { sid: 'b', groupKey: 'rec:2', pinned: false }) !== false) {
					problems.push('canDrop: 跨组必须禁止（跨组 = 改会话 cwd，官方也不支持）✗');
				}
				if (t.canDrop({ sid: 'a', groupKey: gk, pinned: true }, { sid: 'b', groupKey: gk, pinned: false }) !== false) {
					problems.push('canDrop: 置顶项与普通项之间必须禁止（否则"置顶恒在组首"失真）✗');
				}
				if (t.canDrop({ sid: 'a', groupKey: gk, pinned: false }, { sid: 'a', groupKey: gk, pinned: false }) !== false) {
					problems.push('canDrop: 拖到自己身上必须禁止 ✗');
				}
				// ⑤ buildSidebar 必须把 pinned 位与手动顺序带进渲染模型（两处渲染共用同一个模型）
				const rowsP = t.buildSidebar({
					workspaces: [{ workspaceId: 'w1', path: 'G:/WS/client', sessionIds: ['s1', 's2', 's3'] }],
					records: [],
					sessionsById: {
						s1: { title: 'A', updatedAt: 300 }, s2: { title: 'B', updatedAt: 200 }, s3: { title: 'C', updatedAt: 100 },
					},
					archivedIds: [],
					currentSessionId: null,
					pinnedIds: ['s3'],
					orderMap: { 'ws:w1': ['s3', 's2', 's1'] },
				});
				const flatRow = rowsP.filter((r) => r.kind === 'flat')[0];
				const got = flatRow ? flatRow.sessions.map((s) => s.id + (s.pinned ? '*' : '')) : [];
				if (got.join(',') !== 's3*,s2,s1') {
					problems.push(`buildSidebar: 置顶 + 手动序未生效，期望 s3*,s2,s1，实际 ${got.join(',')} ✗`);
				}
				notes.push('client.workspaces.js: 会话行操作（置顶恒在组首 / 手动序 / 组内拖放）断言通过');
			}
			// 静态面：四条操作必须调用**官方服务**（自造状态 ⇒ 跨窗口不一致 / 与官方 UI 打架 ✗）
			const code3 = String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			for (const [needle, why] of [
				['uw.pinSession', '置顶必须走官方 uiWorkspace.pinSession（Host 状态 ⇒ 跨窗口一致）'],
				['uw.unpinSession', '取消置顶必须走官方 uiWorkspace.unpinSession'],
				['session.rename(', '重命名必须走官方 binding.session.rename（与官方侧栏同一跳）'],
				['uw.archiveSession', '归档必须走官方 uiWorkspace.archiveSession'],
				['"data-vssaros-sess-menu"', '会话右键菜单必须有稳定 DOM 锚点（"点外面/Esc 关闭"也靠它）'],
				['acceptDrop: compatible, dragging:', '会话行必须接入拖放兼容性与拖拽状态'],
				['SESSION_ORDER_KEY', '手动顺序必须落盘（刷新后要能读回来）'],
			]) {
				if (code3.indexOf(needle) < 0) { problems.push(`client.workspaces.js: 缺「${needle}」—— ${why} ✗`); }
			}
		}
		// ── ⑤-i 归档必须真生效 + 新增「删除会话」（2026-10-30 用户报障「归档点了没反应」）──────
		// ① 归档的**集合来源**：官方 `archiveSession` 只写 `workspaces.list.archivedSessionIds`，
		//    而 `sessions.list` 快照里**根本没有这个字段**（官方 session-controller 里 0 命中）
		//    ⇒ 从前读 sessions 快照 ⇒ 恒空 ⇒ 归档后行仍在列表 ⇒ 用户看到"点了没反应" ✗。
		// ② 「删除」≠「归档」：dsh 官方**没有删除 API**（只有 archive）⇒ 真删只能由宿主删磁盘，
		//    所以这条是**写操作**：二次确认 + id 白名单 + 落点校验，三样缺一不可。
		{
			const idxWs = src.indexOf('(wsSnap && wsSnap.archivedSessionIds)');
			const idxSs = src.indexOf('(sessSnap && sessSnap.archivedSessionIds)');
			if (idxWs < 0) {
				problems.push('client.workspaces.js: 归档集合必须读 `workspaces.list.archivedSessionIds` —— sessions 快照里没有这个字段（读了恒空 ⇒ 归档后行不消失）✗');
			} else if (idxSs >= 0 && idxSs < idxWs) {
				problems.push('client.workspaces.js: 归档集合必须**以 workspaces 快照为主**、sessions 快照兜底（顺序反了 = 仍读那个不存在的字段）✗');
			}
			for (const [needle, why] of [
				['"data-act": "delete"', '右键菜单必须有「删除会话」项（2026-10-30 用户要求）'],
				['"data-vssaros-sess-confirm"', '删除必须二次确认（真删不可恢复；确认层要有稳定锚点）'],
				['/x/chat-surface/api/delete-session', '删除必须走宿主通路（页面是浏览器上下文，碰不到磁盘）'],
				['svc.refresh', '删完必须刷新 roster —— 否则"删了还在列表里"= 又一个点了没反应 ✗'],
				// ★★ 2026-11-02（用户要求「删除升级」）：**不再"先归档再删盘"** ——
				//   归档是**用户可见状态**（会出现在官方「已归档」筛选里），而我们只是要这一行消失。
				//   新顺序 = 删磁盘 → `workspaces.get(id).detachSession(sid)` 摘账本（幂等、不动日志）。
				//   ⇒ 旧的 `.then(wipe` 链路改为**反向断言**（见下面的负对照）。
			]) {
				if (String(src).indexOf(needle) < 0) { problems.push(`client.workspaces.js: 缺「${needle}」—— ${why} ✗`); }
			}
			for (const [needle, why] of [
				// ⚠ 钉**调用形态**而不是裸标识符：注释与 `typeof … !== "function"` 里都有这个词，
				//   用裸词会让"逻辑被删掉"仍然通过（本次反向突变已实证 ✗）。
				// ⚠ 必须钉**完整语句**：注释里也有一句 `workspaces.get(wsId).detachSession(sid)`，
				//   用 `.detachSession(sid)` 这种片段匹配会被注释兜住 ⇒ 逻辑删掉仍绿（实证 ✗）。
				['Promise.resolve(entity.detachSession(sid))', '删除必须**真的调用** detachSession 摘账本（删盘只删数据、不改 items[].sessionIds）'],
			]) {
				if (String(src).indexOf(needle) < 0) { problems.push(`client.workspaces.js: 缺「${needle}」—— ${why} ✗`); }
			}
			// ★ 负对照：旧链路（归档 → 删盘）不许回来
			if (String(src).indexOf('.then(wipe') >= 0) {
				problems.push('client.workspaces.js: 删除又改回「先归档再删盘」了（`.then(wipe`）⇒ 会把会话塞进「已归档」列表 ✗（2026-11-02）');
			}
			// host 半边：必须**真删**，且边界钉死
			let hostSrc = '';
			try { hostSrc = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8'); } catch { hostSrc = ''; }
			if (!hostSrc) {
				problems.push('lib/index.js（host 半边）: 读不到 —— 删除通路必须落在宿主侧 ✗');
			} else {
				for (const [needle, why] of [
					['/x/chat-surface', 'host 半边必须注册删除路由'],
					// ⚠ 钉**使用点**而不是常量名：只钉 `SESSION_ID_RE` 的话，删掉校验、留下定义 = 假绿（实测踩过）
					['if (!SESSION_ID_RE.test(sessionId))', '会话 id 必须真的走白名单正则校验（防 `..` / 绝对路径穿越）'],
					['if (!insideOf(sessionsRoot, target))', '每条待删路径都要校验落点（`insideOf` 必须真的被用于判断，不是只定义）'],
					['await rm(target, { recursive: true, force: true })', '必须真删目录（归档只是从列表移除，数据还在）'],
					['requestRejection', '写路由必须过 connection 的鉴权围栏'],
					["inject(['webServer', 'connection']", 'webServer/connection 只能**可选**注入（静态 inject 会让 headless profile 永久 pending）'],
				]) {
					if (hostSrc.indexOf(needle) < 0) { problems.push(`lib/index.js（host 半边）: 缺「${needle}」—— ${why} ✗`); }
				}
			}
			notes.push('client.workspaces.js / lib/index.js: 归档取 workspaces 快照 + 删除（二次确认 + 宿主白名单删盘）断言通过');
		}
		// ── ⑤-j 会话太多时只加载一部分（2026-10-30 用户要求「要求能够加载一部分」）──────────────
		// 单个工作区能挂**上百条**会话（`items[].sessionIds` 是 Host 记的全量成员）⇒ 全渲染一屏几百个 DOM 节点。
		// 口径：默认 `SESSION_PAGE_SIZE` 条 + 「展开其余 N 条」（每次 +20，全展开后「收起」）；
		//   搜索命中**不截断**；**当前会话永远可见**（否则点开一条老会话，列表里却看不到它高亮在哪 ✗）。
		{
			if (typeof t.visibleSessions !== 'function') {
				problems.push('client.workspaces.js: 缺 __test.visibleSessions（分页配额必须可单测 ✗）');
			} else if (typeof t.SESSION_PAGE_SIZE !== 'number' || t.SESSION_PAGE_SIZE < 5) {
				problems.push(`client.workspaces.js: SESSION_PAGE_SIZE 不合理（实际 ${t.SESSION_PAGE_SIZE}）✗`);
			} else {
				const mk = (id, cur) => ({ id, isCurrent: cur === true });
				const all = [mk('a'), mk('b'), mk('c'), mk('d')];
				if (t.visibleSessions(all, 2).map((s) => s.id).join(',') !== 'a,b') {
					problems.push('visibleSessions: 配额应取前 N 条（a,b）✗');
				}
				const withCur = t.visibleSessions([mk('a'), mk('b'), mk('c', true)], 2).map((s) => s.id).join(',');
				if (withCur !== 'a,b,c') {
					problems.push(`visibleSessions: **当前会话**必须强制可见（期望 a,b,c，实际 ${withCur}）✗ —— 否则点开老会话后看不到它`);
				}
				if (t.visibleSessions(all, 99).length !== 4) {
					problems.push('visibleSessions: 配额 >= 总数时应全给 ✗');
				}
				if (t.visibleSessions(all, 0).map((s) => s.id).join(',') !== 'a,b,c,d') {
					problems.push('visibleSessions: 配额 <= 0 当「不限制」（别把列表清空）✗');
				}
				if (t.visibleSessions(null, 3).length !== 0) {
					problems.push('visibleSessions: 空输入应返回空数组 ✗');
				}
			}
			const code4 = String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			for (const [needle, why] of [
				['"data-vssaros-more-sessions"', '「展开其余」按钮要有稳定锚点（自动化/守卫都靠它）'],
				['展开其余 ', '分组底部必须写出"还有多少条没展开"（不许静默截断 ✗）'],
				['const searching = !!q;', '搜索命中必须**不截断**（搜到就该看见）'],
			]) {
				if (code4.indexOf(needle) < 0) { problems.push(`client.workspaces.js: 缺「${needle}」—— ${why} ✗`); }
			}
			notes.push('client.workspaces.js: 会话分页（默认条数 + 展开其余 + 当前会话必可见 + 搜索不截断）断言通过');
		}
		// ── ⑤-k 对齐官方「空会话怎么隐藏」（2026-10-30 分析官方 dsh 后补）──────────────────────
		// 官方 `sessionVisible`（dsh-client-ui-workspace/lib/client.js:958-974）三条硬规则：
		//   ① `origin === "subagent"` ⇒ 永不列出；② `blank && id !== current` ⇒ 隐藏；③ 归档三态。
		//   而它的 `current` = `mainSessionId()` = **`retainedBy.mainView > 0` 的那条**（不是 selection store）。
		// 我们从前：没有 ①、current 用 selection（可能是别的窗口/上次运行的残留）⇒ 两处口径会打架。
		{
			if (typeof t.mainViewSessionId !== 'function') {
				problems.push('client.workspaces.js: 缺 __test.mainViewSessionId（"当前会话"必须用官方 retention 判据 ✗）');
			} else {
				const mvid = t.mainViewSessionId({
					a: { retainedBy: {} },
					b: { retainedBy: { mainView: 1, sidebarView: 2 } },
					c: { retainedBy: { sidebarView: 1 } },
				});
				if (mvid !== 'b') { problems.push(`mainViewSessionId: 应取 retainedBy.mainView>0 的那条（期望 b，实际 ${mvid}）✗`); }
				if (t.mainViewSessionId({ a: { retainedBy: {} } }) !== null) {
					problems.push('mainViewSessionId: 没有 mainView retain 时必须返回 null（别瞎猜）✗');
				}
				// 优先级：mainView > official（selection 可能是别的窗口的残留）
				const won = t.pickCurrentSessionId({ mainView: 'b', official: 'a', local: 'a', known: { a: true, b: true } });
				if (won !== 'b') { problems.push(`pickCurrentSessionId: mainView 必须压过 official（期望 b，实际 ${won}）✗`); }
				const fallback = t.pickCurrentSessionId({ mainView: 'zz', official: 'a', known: { a: true, b: true } });
				if (fallback !== 'a') { problems.push(`pickCurrentSessionId: mainView 不在册时应回落 official（期望 a，实际 ${fallback}）✗`); }
			}
			// 子代理会话：不列出、也**不**算进"已隐藏空会话"
			const rowsSub = t.buildSidebar({
				workspaces: [{ workspaceId: 'w1', path: 'G:/WS/client', sessionIds: ['s1', 'sub', 'b1'] }],
				records: [],
				sessionsById: {
					s1: { title: 'A', updatedAt: 300 },
					sub: { title: '子代理', origin: 'subagent', updatedAt: 200 },
					b1: { title: '', blank: true, updatedAt: 100 },
				},
				archivedIds: [],
				currentSessionId: null,
			});
			const flatSub = rowsSub.filter((r) => r.kind === 'flat')[0];
			const ids = flatSub ? flatSub.sessions.map((s) => s.id) : [];
			if (ids.indexOf('sub') >= 0) {
				problems.push('buildSidebar: 子代理会话（origin=subagent）必须永不列出（官方 sessionVisible 第一条）✗');
			}
			if (flatSub && flatSub.hiddenBlanks !== 1) {
				problems.push(`buildSidebar: 子代理不该算进「已隐藏空会话」（期望 1 = 只有 b1，实际 ${flatSub && flatSub.hiddenBlanks}）✗`);
			}
			// 空会话例外：current 是空会话时必须留下（官方 `blank && id !== current` 的反映）
			const rowsCur = t.buildSidebar({
				workspaces: [{ workspaceId: 'w1', path: 'G:/WS/client', sessionIds: ['b1', 'b2'] }],
				records: [],
				sessionsById: { b1: { title: '', blank: true }, b2: { title: '', blank: true } },
				archivedIds: [],
				currentSessionId: 'b2',
			});
			const flatCur = rowsCur.filter((r) => r.kind === 'flat')[0];
			const curIds = flatCur ? flatCur.sessions.map((s) => s.id) : [];
			if (curIds.join(',') !== 'b2' || (flatCur && flatCur.hiddenBlanks !== 1)) {
				problems.push(`buildSidebar: 空会话只保留 current 那条（期望列表 b2 / 隐藏 1，实际 ${curIds.join(',')} / ${flatCur && flatCur.hiddenBlanks}）✗`);
			}
			const code5 = String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			for (const [needle, why] of [
				['s.origin === "subagent"', '子代理标记必须来自官方 `origin` 字段（别自己猜父会话）'],
				['if (s.isSubagent) { continue; }', '子代理过滤必须**真的**出现在两个渲染分支里'],
				['retainedBy.mainView', '"当前会话"必须读官方 retention（`retainedBy.mainView`）'],
			]) {
				if (code5.indexOf(needle) < 0) { problems.push(`client.workspaces.js: 缺「${needle}」—— ${why} ✗`); }
			}
			if ((code5.match(/if \(s\.isSubagent\) \{ continue; \}/g) || []).length < 2) {
				problems.push('client.workspaces.js: `isSubagent` 过滤必须在**两个**渲染分支（分组 + 平铺）都有 ✗');
			}
			notes.push('client.workspaces.js: 对齐官方空会话口径（subagent 永不列 / current=mainView retain / blank 只留 current）断言通过');
		}

		// ── ⑤-i 会话行**状态灯**（2026-10-30 用户报障：「工作区内的会话 item 缺少状态灯 UI」）──
		// 用户可见行为：一眼看出哪条会话在跑 / 哪条在等你回答。钉三件事：
		//   ① 四态判据与 @vssaros/dsh-sessions 的 `statusOf` **同口径**（不自造第二套）；
		//   ② `awaiting` **优先于** `running`（否则"该你回答了"会被收尾 delta 盖掉 ✗）；
		//   ③ 三个信号都读不到 ⇒ `unknown`，**不画成空闲**（未知 ≠ 已知不忙 ✗）。
		if (t && typeof t.sessionStatusOf === 'function') {
			const cases = [
				[{ turnRunning: true }, 'running', 'turn 在跑 ⇒ running'],
				[{ turnRunning: true, retrying: true }, 'running', '重试也算 running'],
				[{ llmRetry: { retry: 2 } }, 'running', 'llmRetry.retry>0 也算 running'],
				[{ turnRunning: false, pendingQuestions: 1 }, 'awaiting', '有待回答 ⇒ awaiting'],
				[{ turnRunning: true, pendingQuestions: 2 }, 'awaiting', 'awaiting 必须**优先于** running'],
				[{ userQuestions: { count: 3 } }, 'awaiting', '官方单元名 userQuestions 也要认'],
				[{ turnRunning: false }, 'idle', 'turn 明确停了 ⇒ idle'],
				[{ pendingQuestions: 0, turnRunning: false }, 'idle', '已知 0 待回答 + 没跑 ⇒ idle'],
				[{}, 'unknown', '三个信号都读不到 ⇒ unknown（不许假装空闲 ✗）'],
				[{ title: 'x' }, 'unknown', '缺状态字段的 roster 行 ⇒ unknown'],
			];
			for (const [input, want, why] of cases) {
				const got = t.sessionStatusOf(input);
				if (got !== want) { problems.push(`sessionStatusOf(${JSON.stringify(input)}): 期望 ${want}，实际 ${got} —— ${why} ✗`); }
			}
			if (!t.RING_LABEL || !t.RING_LABEL.running || !t.RING_LABEL.awaiting || !t.RING_LABEL.idle) {
				problems.push('client.workspaces.js: RING_LABEL 必须给 running/awaiting/idle 三态的 hover 文案 ✗');
			}
			// 兜底单元名：pendingQuestions 缺席时回落到官方的 userQuestions
			if (t.pendingQuestionsOf({ userQuestions: { count: 4 } }) !== 4) {
				problems.push('pendingQuestionsOf: 必须认 {count} 形状（与 @vssaros/dsh-sessions 同口径）✗');
			}
			if (t.pendingQuestionsOf({}) !== undefined) {
				problems.push('pendingQuestionsOf: 单元缺席必须返回 undefined（未知），不许编 0 ✗');
			}
			// buildSidebar 必须把 status 带进渲染模型（两处渲染共用同一个模型）
			const rowsS = t.buildSidebar({
				workspaces: [{ workspaceId: 'w1', path: 'G:/WS/client', sessionIds: ['r1', 'a1', 'i1', 'u1'] }],
				records: [],
				sessionsById: {
					r1: { title: 'R', updatedAt: 400, turnRunning: true },
					a1: { title: 'A', updatedAt: 300, pendingQuestions: 1 },
					i1: { title: 'I', updatedAt: 200, turnRunning: false },
					u1: { title: 'U', updatedAt: 100 },
				},
				archivedIds: [], currentSessionId: null,
			});
			const flatS = rowsS.filter((r) => r.kind === 'flat')[0];
			const gotS = flatS ? flatS.sessions.map((s) => s.id + ':' + s.status) : [];
			if (gotS.join(',') !== 'r1:running,a1:awaiting,i1:idle,u1:unknown') {
				problems.push(`buildSidebar: 状态灯未带进渲染模型，期望 r1:running,a1:awaiting,i1:idle,u1:unknown，实际 ${gotS.join(',')} ✗`);
			}
			notes.push('client.workspaces.js: 会话行状态灯（四态 / awaiting 优先 / 未知不画成空闲）断言通过');
		} else {
			problems.push('client.workspaces.js: 缺 __test.sessionStatusOf（状态灯口径必须可单测 ✗）');
		}
		// 静态面：行里必须真的画出那盏灯，且脉动样式表必须注入
		const ringSrc = String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		for (const [needle, why] of [
			['statuses: officialStatuses, slotProps: rowSlotProps', '会话行必须使用官方状态快照'],
			['S.ringRunning', '运行态必须着绿'],
			['S.ringAwaiting', '等待态必须着黄'],
			['vssaros-ws-ring-pulse', '运行态脉动动效必须存在（样式表注入）'],
			['prefers-reduced-motion', '脉动必须尊重 reduced-motion（关动效但保留绿色）'],
			['ensureRingStyle()', 'install 里必须注入一次样式表（否则 @keyframes 不存在 ⇒ 不脉动）'],
		]) {
			if (ringSrc.indexOf(needle) < 0) { problems.push(`client.workspaces.js: 缺「${needle}」—— ${why} ✗`); }
		}
	}
}

// ── ⑤-l 会话行：UI 复刻 dsh-desktop + 未读 + 删除升级（2026-11-02 用户要求）─────────────
// 三条一起钉：
//   ① **删除**不再"先归档再删盘"（归档是用户可见状态，会污染「已归档」列表）；新顺序 =
//      删盘 → `workspaces.get(id).detachSession(sid)`（摘账本、幂等、不动会话日志）。
//   ② **未读**：模块级集合 + 事件驱动 + 打开即已读（对齐 dsh-desktop 的 `view.markSessionRead`）。
//   ③ **UI 对齐**：圆点状态灯 / 未读点 / 未读加粗 / 双击就地重命名 / 时间戳 hover 给绝对时间。
{
	const ws = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
	// ⚠ 自己装载一次：⑤ 块里的 `t` 不在本作用域（插在块外 ⇒ 直接用会 `t is not defined` ✗）。
	const wsDoc = makeDocumentStub();
	const wsLoaded = loadChunk('client.workspaces.js', wsDoc, makeWindowStub(wsDoc));
	const tw = wsLoaded && wsLoaded.exports.__test;
	try {
		execFileSync(process.execPath, [path.join(LIB, '../scripts/build-session-row.mjs'), '--check'], { stdio: 'pipe', windowsHide: true });
	} catch (error) {
		problems.push('官方会话行构建产物未同步：' + String(error.message));
	}
	const need = [
		['Promise.resolve(entity.detachSession(sid))', '删除必须**真的调用** detachSession 摘账本（不再靠归档让行消失）'],
		['markSessionRead(s.id)', '打开会话必须即时标记已读'],
		['id: "session.vssaros.unread", target: "session", order: 250', '手动未读必须接入官方菜单贡献'],
		['id: "session.vssaros.delete", target: "session", order: 700', '删除必须接入官方菜单贡献'],
		['react.createElement(OfficialSessionRow, {', '会话行必须真正使用官方组件适配层'],
		['statuses: officialStatuses, slotProps: rowSlotProps', '官方会话行必须收到状态及 renderer 提供的槽位 props'],
		['onRenameRequest: (sid, title) => setRenaming({ sid, draft: title })', '官方双击重命名必须保留本地就地改名回调'],
		// 工作区行按官方 `.projectRow`：folder 图标 + hover 换三角箭头
		// ⚠ 必须钉 **JSX 挂载点**：这些类名在 `ensureRowStyle()` 的 CSS 字符串里也出现 ⇒
		//   裸词断言把元素删掉仍然绿（本次反向突变实证 ✗）。
		['className: "vssaros-ws-project"', '工作区行必须走官方的 `.projectRow` 样式（34px / folder 图标 / hover 换箭头）'],
		['className: "vssaros-ws-slot2 vssaros-ws-folder"', '工作区行必须有文件夹图标（官方默认图标、hover 才换箭头）'],
		['className: "vssaros-ws-slot2 vssaros-ws-chevron"', '工作区行必须有展开箭头（hover 才出现）'],
		// 官方图标的**实现特征**（2026-11-02：手画 fill path 会把文件夹渲染成方块 ✗）
		['stroke: "currentColor", strokeWidth: 1', '文件夹图标必须用官方描边版（fill:none + 1px stroke），不能用实心 path'],
		['M3.63501 7.66614H12.3647', '文件夹图标必须是官方 `FolderCloseArtwork` 的 path（含中间那条横线）'],
		['M5.5 4.5C5.5 4.40714', '展开箭头必须是官方 `IconTriangleRightFillArtwork` 的 path'],
		// ⚠ 钉完整键值：`data-vssaros-ws-row-actions-x` 也含裸词 ⇒ 会假绿（本次又踩一次 ✗）
		['"data-vssaros-ws-row-actions": key', '工作区行必须有 hover 才出现的 ⋯ 动作（官方 `.rowActions`）'],
		// ★ 2026-11-02（用户要求）：工作区行 hover 还要有 **+**（在此工作区新建会话）
		['"data-vssaros-ws-row-new-session": key', '工作区行必须有 hover 才出现的「+ 新建会话」'],
		['const newSessionInWorkspace = (record, label) => {', '「+」必须真的新建会话（入参是工作区条目，需要 workspaceId）'],
		['const primaryPathOf = (rec) => {', '新建会话必须能取到工作区的主根路径（roots[0].path → record.path）'],
		['const plusIcon = () => react.createElement("svg"', '「+」必须是描边 SVG 图标（文字加号在 14px 下基线会歪）'],
		// ⚠ 钉完整句子：只写 `sessions.create 不可用` 时，后面接 `X` 仍含原串 ⇒ 假绿（本次踩过 ✗）
		['当前宿主不支持新建会话（sessions.create 不可用）', '宿主不支持时必须明确报错（不静默）'],
		// ★ 2026-11-02 真机：「宿主没返回 sessionId」——`sessions.create` 有两层实现，
		//   `SessionsManager.create` 直接返回**字符串**，只认对象就会误判。
		['typeof res === "string"', '新建会话必须兼容字符串返回（SessionsManager.create）'],
		['宿主返回：', '失败时必须带出宿主实际返回的形状（只报"没返回"无法定位）'],
		// ★★ 2026-11-02 真机「点 + 后聊天框无法交互」：`create({cwd})` 只定目录、**不建立工作区归属**
		//   ⇒ hero 认为没有工作区 ⇒ 输入框灰。必须优先走官方
		//   `uiWorkspace.openWorkspaceSession(workspaceId)`（connectBlank + replaceMain，且会复用 blank）。
		['uiWorkspace.openWorkspaceSession', '新建会话必须优先走官方 openWorkspaceSession（cwd 版不建立工作区归属，输入框会是灰的）'],
		// ★★ 2026-11-14 真机（工作区 item 的「+」报 `Cannot read properties of undefined (reading 'agentPreset')`）：
		//   0.2.2-rc.2 的 `openWorkspaceSession(workspaceId, beforeOpen, reuse)` **没有默认值**，
		//   `connectBlank(workspaceId, reuse)` 里直接读 `reuse.agentPreset` ⇒ 只传一个参数必炸。
		//   ⚠ 钉**完整调用形态**：上面那条 `uiWorkspace.openWorkspaceSession` 只靠注释就满足（假绿）。
		['const openWsSession = (id) => uw.openWorkspaceSession(id, undefined, {});',
			'⑤-l openWorkspaceSession 必须显式传第三参数 `{}`（否则 reuse.agentPreset 读 undefined ⇒ 点「+」报错）'],
		['const workspaceIdOf = (rec) => {', '必须能取到 workspaceId（官方入口的入参）'],
		// ★ 真机报错 `unknown workspace sarosis-agents-client-hcshv`：多根工作区行的 `record` 是
		//   **IDE 记录**（`rec.id`），不是 dsh 的 workspaceId ⇒ 必须按主根路径反查 items。
		['samePath(it.path, p)', '多根工作区行的 workspaceId 必须按主根路径反查（rec.id 是 IDE 记录 id，dsh 不认）'],
		// ★ 真机（`VsSaros_S1Game`，2 根 0 会话）：dsh 里没有这个工作区 ⇒ 必须先登记再开会话
		['workspace-registered', '取不到 workspaceId 时必须先 workspaces.create({path}) 登记（回落 create({cwd}) 会造出输入框灰的会话）'],
		['const newId = created && (created.workspaceId', '登记后必须从返回里取 workspaceId（created.workspaceId / created.workspace.workspaceId）'],
		// ★ 2026-11-02 用户要求「初始安装启动时默认显示一个工作区」：
		//   官方 `workspaces.initializeDefault()` 就是这条能力的唯一出口（目录固定、Host 幂等）。
		['const ensureDefaultWorkspace = (() => {', '首次启动必须尝试初始化默认工作区'],
		['snap.phase !== "ready"', '默认工作区必须等快照 ready 再判断（pending 时 items 恒空 ⇒ 会误判）'],
		// ★ 第二轮修正（用户报「缺少默认工作区」）：官方 initializeDefault 在已有工作区的机器上
		//   返回 undefined ⇒ 必须自己 ensure；幂等靠**路径**判断（删了下次再补）。
		['const exists = items.some((it) => it && samePath(it.path, dir));', '默认工作区必须按路径幂等（已有同路径就跳过）'],
		['const DEFAULT_WS_API = "/x/chat-surface/api/default-workspace";', '默认工作区目录必须由宿主准备（页面建不了目录）'],
		['wsLog("default-workspace"', '默认工作区必须记日志（start / ok / fail，含 workspaceId）'],
		// ★ 2026-11-02 用户要求：工作区 ⋯ 菜单要有「移除工作区」（官方 workspaces.delete，只摘登记）
		['const removeWorkspace = (key) => {', '工作区 ⋯ 菜单必须有「移除工作区」实现'],
		// ★ 真机：「找不到这个工作区（列表可能已刷新）」—— 折叠键（record.id / flat:<label>）
		//   与 `rows[].key`（rec:<id> / ws:<wsId>）**永不相同** ⇒ 必须按 kind 分别匹配。
		['r.kind === "group" && r.record && r.record.id === key', '移除工作区必须按 kind 匹配折叠键（不能拿它和 rows[].key 比相等）'],
		// ★ 2026-11-02 用户报「显示已移除工作区，但是没刷新」：
		//   多根行由 **IDE 记录**驱动，`workspaces.delete` 只摘 dsh 登记 ⇒ 行仍在 ⇒ 必须本地隐藏。
		['const [wsRemoved, setWsRemoved] = react.useState(', '移除工作区后必须能从列表隐藏（IDE 记录还在，只摘登记行不会消失）'],
		['wsRemoved.indexOf(r.record.id) >= 0', '渲染时必须按 wsRemoved 过滤掉已移除的行'],
		// ★ 2026-11-02 二次：隐藏必须**乐观**（点下去立刻消失），不能等 `svc.delete()` 返回 ⇒ 否则有可感延迟
		['// 回滚：删除失败 ⇒ 把行放回来，别让用户以为"删掉了"', '移除失败必须回滚（放进去了又不删掉会是假的已移除）'],
		// ★ 2026-11-02 三次（用户报「删除的工作区重启后又显示出来」）：
		//   隐藏集合必须**持久化**（IDE 记录还在 ⇒ 否则重启后行会复活），并给恢复入口。
		['const WS_REMOVED_KEY = "vssaros.ws.removed.v1";', '已移除的工作区必须持久化（否则重启后 IDE 记录又把行渲染出来）'],
		['react.useState(() => readRemovedWs())', '启动时必须从 localStorage 读回已移除集合'],
		['saveRemovedWs(wsRemoved)', '集合变化必须落盘'],
		['"data-act": "restore-ws"', '必须有「恢复已移除的工作区」入口（否则用户只能清缓存）'],
		// ★ 2026-11-02（用户报「工作区文本下方会显示日志文本，不合理」）：
		//   操作反馈必须是**浮层 toast**（不占布局），不能是列表里的一行文本。
		['position: "fixed", zIndex: 96, left: "50%", bottom: 18', '操作反馈必须是 fixed toast（不许插在列表里占位置）'],
		['pointerEvents: "none", textAlign: "center"', 'toast 必须指针穿透（不能挡住底下的点击）'],
		['"data-act": "remove-ws"', '工作区 ⋯ 菜单必须有「移除工作区」这一项'],
		// ⚠ 不做"再点一次确认"：真机实测菜单第一次点击后不重渲染（confirmRemove 写进去但文本不变）
		//   ⇒ 反而像"点了没反应"。`workspaces.delete` 只摘登记、可逆，直接执行更符合预期。
		['}, activeWorkbench ? \'从当前工作台隐藏\' : "移除工作区")', '普通模式移除登记，工作台模式仅隐藏本工作台目录'],
		['workspaces.delete 不可用', '宿主不支持时必须明确报错（不静默）'],
		['wsLog("new-session"', '新建会话必须记一条日志（走了哪条路径、wsId、dir）'],
		// ★ 2026-11-02 真机实测：新建出来的会话输入框是**可用**的（CDP focus + insertText 能打进字），
		//   但 `replaceMain` 不会自动把焦点给 composer ⇒ 用户直接打字落在空白处 ⇒ 看起来"无法交互"。
		['const focusComposer = (tries) => {', '新建会话后必须主动 focus composer（并重试，composer 是异步挂载的）'],
		// ⚠ 真机：`.then` 里的 focus 会被随后的重渲染抢走 ⇒ 还要一个**不依赖 promise** 的短时守护
		['const watchComposerFocus = (left) => {', '必须有独立的焦点守护（6s 内只在焦点是 body 时抢回 composer）'],
		['watchComposerFocus(24);', '点「+」当刻就要开始盯焦点（不能等 promise）'],
		['new-session-ok', '新建成功必须记一条结果日志（便于区分"没触发"与"触发了但没打开"）'],
		['"data-vssaros-ws-row-menu": "1"', '工作区 ⋯ 菜单必须有稳定锚点'],
		['"vssaros.workspaces.session.row.trailing": { kind: "list", scope: "root", inline: true }', '行尾必须拥有独立根槽，不能与官方声明冲突'],
		['props.renderSlot(SESSION_ROW_SLOTS[name] || name, owner, options)', '官方行渲染必须转译到本地合法拥有的行槽'],
		['mirrorSessionRowSlots(ctx.slots', '官方行扩展必须按声明生命周期镜像，不能静默丢失'],
		['"data-row-key": "workspace:"', '工作区行必须带官方锚点 `data-row-key="workspace:<key>"`'],
		// ★ 2026-11-02：遮蔽优先级必须与官方（默认 0）/ 其它插件（-10）**错开**。
		//   同档时退化成"谁先注册谁赢" ⇒ desktop 全窗里实测出现过官方 WorkspaceBrowser 仍渲染 ✗。
		['priority: -1000', '遮蔽 sidebar.workspaces 的 priority 必须显著低于官方默认（0）与第三方（-10），取 -1000'],
		// ★ 2026-11-02 用户要求「增加日志定位问题」：这条链是排查"页签/工作区行不见了"的唯一凭据。
		//   静态守卫钉住它，防止后续重构顺手把诊断删掉（删了就又只能靠猜 ✗）。
		['const WS_LOG_PREFIX = "[vssaros-ws]";', '诊断日志前缀必须存在（控制台按它过滤）'],
		['wsLog("install",', 'install 必须记一条（是否装、槽能力、chatOnly、url）'],
		['wsLog("register-call",', 'register 调用前必须记一条（含 priority）'],
		['wsLog("register-done",', 'register 返回后必须记一条（含返回类型，识别"静默失败"）'],
		['wsLog("render-rail",', 'rail 分支必须记一条（区分"注册失败"与"侧栏一直收起"）'],
		['"slot-mismatch"', '700ms 槽自检必须能报 slot-mismatch（槽里是别人的 UI）'],
		['const scheduleSlotSelfCheck =', '必须有槽自检（注册没抛错 ≠ 真的渲染进槽）'],
		['"data-act": "copy-diag"', '工作区 ⋯ 菜单必须有「复制诊断信息」'],
		// ★ 2026-11-02 用户拍板「治本：把标题写回 dsh」
		['const FIRST_PROMPT_API = "/x/chat-surface/api/first-prompt";', '客户端必须走 host 的只读 first-prompt 路由'],
		['const backfillTitles = () => {', '必须有补标题的实现（读首条用户消息 → 官方 rename）'],
		['"data-act": "backfill-titles"', '工作区 ⋯ 菜单必须有「补全会话标题」'],
		// ★ 2026-11-02 用户要求「Bots 页签下增加搜索按钮和 + 按钮，通会话页签的 UI 样式和布局」
		['"data-vssaros-bots-search": "1"', 'Bots 页签头必须有 🔍 搜索按钮（与会话页签同款）'],
		['"data-vssaros-bots-add": "1"', 'Bots 页签头必须有 ＋ 按钮（与会话页签同款）'],
		['"data-vssaros-bots-menu": "1"', 'Bots 的 ＋ 必须有菜单（且带稳定锚点，供"点外面关闭"排除）'],
		['const q = botsQuery.trim().toLowerCase();', 'Bots 搜索必须真的过滤列表（只放输入框不算）'],
		['"data-vssaros-bots-search-input": "1"', 'Bots 搜索框必须有锚点（便于自动化/诊断）'],
		// ★ 2026-11-02（用户要求「＋ 表示新建 bot 或群聊」）：
		['"data-act": "new-bot"', 'Bots 的 ＋ 菜单必须有「新建 Bot…」（走 agents 的 create API）'],
		['"data-vssaros-bots-new": f.kind', '新建表单必须有锚点，并带 kind（bot / group 两套字段）'],
		['const submitBotsNew = () => {', '新建必须真的有提交实现'],
		['const AGENTS_API_AGENTS = "/x/agents/api/agents";', '新建 Bot 必须走 agents 官方的 create 接口'],
		// ★ 2026-11-09 创建 Bot 链路质量修复：权威校验 / 失败可见 / 欢迎卡交接
		['const validateRemote = () => postJson(AGENTS_API_AGENTS, { action: "validate", draft })',
			'提交前必须打 host 的 validate（前端正则只是即时提示，不是权威判据）'],
		['.then((v) => (v && Array.isArray(v.errors) ? v : null))',
			'validate 的回包要判空；接口不可用（老 host 404）时降级放行，不许堵死新建'],
		['if (res.registered === false) {',
			'create 回包必须读 registered（同步失败却提示「已新建」= 假成功）'],
		['res.syncError || "同步 preset 失败"', 'preset 未注册时必须把 host 给的原因显示出来'],
		['const emptyBotDraft = () => ({', '新建表单初始草稿必须单一真源（＋ 菜单与欢迎卡交接共用）'],
		['window.addEventListener("vssaros:open-bots", onOpenBots)',
			'必须接住欢迎卡的 Bots 交接事件（旧 /x/agents/ 是 404）'],
		['detail.handled = true;', '交接事件必须回填 handled（否则派发方无法判断是否有人接住）'],
		// ★ 2026-11-09 用户报障「Bots 页签 bot item 右键没反应」⇒ 复刻 DS Bot 的右键菜单
		['function botMenuItems(', 'Bot 行右键菜单必须有纯函数定义（守卫按 act/label 逐项断言）'],
		['const botMenuIcon = (kind) =>', 'Bot 菜单必须有线性图标（与截图同款「图标 + 文字」）'],
		['setBotMenu({ id, x, y });', 'Bot 行必须绑 onContextMenu 并夹视口定位（右键没反应的修复点）'],
		['"data-vssaros-bot-menu": botMenu.id', 'Bot 菜单必须有稳定 data 锚点，供「点外面关闭」排除'],
		['"data-vssaros-bot-confirm": botDel.id', '删除 Bot 必须有二次确认层（危险操作不能点偏就执行）'],
		['vssaros:open-bot-config', '「编辑 Bot」必须派跨 chunk 事件，让设置页把分段落到 Bot'],
		['action: "delete", id: cur.id', '删除必须真调 host 的 delete 接口（不是只从列表移除）'],
		['BOT_FLAGS_KEY, readBotFlags, saveBotFlags', '菜单 flags 必须落 localStorage 且导出可单测'],
		['setBotMenu(null); setBotDel(null); setBotRename(null);', '点外面 / Esc 必须同时关掉 Bot 菜单、删除确认与就地改名'],
		['t.closest("[data-vssaros-bot-menu]")', 'Bot 菜单必须加进「点外面关闭」白名单（否则点菜单项先被卸载）'],
		['"data-act": "bot-" + it.act', 'Bot 菜单项必须带稳定 data-act 锚点，且走 onMouseDown 而非 onClick'],
		['if (!handled) { fire(); }', '「编辑 Bot」必须在设置页挂载后补派一次事件（事件早于监听 ⇒ handled 恒 false）'],
		// ★ 2026-11-10 纠偏：官方右栏页签是主承载面；中栏独立页只是 openTab 抛错时的兜底
		['const BOT_CONFIG_PAGE_COMP = "vssaros-bot-config";', '「编辑 Bot」必须有中栏独立页组件常量（右栏不可用时的兜底）'],
		['comp: BOT_CONFIG_PAGE_COMP, props: { agentId: id, name, tabId }',
			'「编辑 Bot」的**回落**中栏独立页必须按 agentId 渲染（右栏不可用时的兜底，不依赖会话）'],
		['(j && j.draft) || {}', 'GET ?id= 回的是 {ok, draft} 双层结构 ⇒ 重命名 / 复制必须取 .draft'],
		// ★ 2026-11-02 二次（用户：弹出的 UI 框太简陋）—— 表单必须有这些结构件
		['"data-vssaros-bots-modes": "1"', '群聊表单必须有唤醒策略分段（all/mentions/digest/silent）'],
		['"data-vssaros-bots-member-query": "1"', '群聊表单成员必须可搜索'],
		['"data-act": "members-all"', '群聊表单必须有「全选」'],
		['"data-act": "members-none"', '群聊表单必须有「清空」'],
		['"data-vssaros-bots-preview": "1"', '表单必须有实时预览（输入即反映）'],
		['"data-act": "new-close"', '表单头部必须有关闭按钮'],
		['BOT_ICON_PRESETS.map', 'Bot 表单必须有图标选择'],
		['"data-vssaros-bots-id-ok"', 'Bot 表单的 id 必须有实时校验状态（✓ 可用 / ✗ 原因）'],
		// ★ 2026-11-02 二次（用户报「看不清哪个被选中了」）：选中态必须**双重编码**
		//   （亮底 + 品牌色下划线 + 白字），且必须走 CSS（`data-on`），否则 hover 无法参与。
		['className: "vssaros-ws-tab"', '页签按钮必须挂 `.vssaros-ws-tab`（选中态靠 CSS 的 data-on）'],
		['"data-on": view === k ? "1" : "0"', '页签必须有 data-on 选中标记（内联 style 表达不了 hover）'],
		// ⚠ 源码里属性选择器是 `\"1\"`（JS 字符串转义）⇒ 断言不能含引号，否则永远匹配不上（本次踩过 ✗）
		['.vssaros-ws-tab[data-on=', '选中页签必须有 data-on 样式规则'],
		['background:var(--dsw-alias-interactive-bg-active,#414346)', '选中页签必须有明显亮底（bg-layer-3 只差 16/255，真机看不清）'],
		['inset 0 -2px 0 var(--dsw-alias-brand-primary', '选中页签必须有品牌色下划线（不依赖色觉的第二重编码）'],
		// ★ 2026-11-12：切页签 = 纯视图切换，**不许隐式新建会话**（用户报「切换 bot 会莫名新建工作区」）。
		//   显式「+ 新建会话」按钮仍走 startNewSessionFromTab 自建链（官方 startSession 有导航竞态）。
		['create({ workspaceId: wsId })', '显式新建会话必须走 create({workspaceId})（必须带 workspaceId 才会进工作区账本）'],
		['const startNewSessionFromTab = () => {', '必须有独立的显式新建实现（不能依赖 startSession 的竞态）'],
		// ★ 2026-11-13：页签条那枚常驻「+ 新建会话」已按用户要求移除 ⇒ 改由下面循环后的
		//   **负断言**钉死「不许再加回来」（原来这里是正向断言，删按钮后会误报）。
		// ★ 2026-11-02：整页工作台在前台时，workbenches 守卫只认「用户导航」信号才放行；
		//   跨插件方法包装拦不到我们的调用 ⇒ 必须写页面级时间戳
		['window.__vssarosUserNavAt = Date.now()', '主动打开/新建会话前必须写页面级导航信号（否则被整页工作台停靠 ⇒ 中栏空白）'],
		// ⚠ 负对照：`font: "inherit"` 是**简写**，会把 `font-weight` 重置成 400，
		//   而内联优先级高于注入 CSS ⇒ 选中态 600 永远不生效（2026-11-02 真机实测 ✗）。
		['fontFamily: "inherit", fontSize: 12', '页签按钮必须逐项写字体（简写 font 会吃掉 font-weight:600）'],
		// 槽内部探测（single 槽按 priority 去重，同档会抛错；`lowest renders`）
		['wsLog("slots-api",', '必须 dump slots 服务的 API 面（判断能否直接查条目表）'],
		['state.workspacesSlotsDump', '必须尝试导出槽内部条目（dump 槽里到底有几个注册者、谁排第一）'],
		['wsLog("slots-entries",', '必须 dump 槽的 entries（id / priority / registrant，判定我们是否排第一）'],
		// ★ 2026-11-02 用户报「读取名册太慢了」：名册是慢接口 ⇒ 必须缓存优先 + 超时，
		//   否则切到 Bots 页签就是长时间「正在读取名册…」白屏。
		['const BOTS_CACHE_KEY = "vssaros.ws.bots.v1";', 'Bots 名册必须有本地缓存（慢接口不能每次都等网络）'],
		['const BOTS_TIMEOUT_MS = 8000;', 'Bots 名册请求必须有超时（否则永远停在"正在读取"）'],
		['Promise.race([fetchBotsData(), timeout])', '名册请求必须真的套上超时（只定义常量不算）'],
		['saveBotsCache(d);', '名册成功后必须落缓存（下次进页签秒开）'],
		['const cached = readBotsCache();', '进 Bots 页签必须先读缓存（先给能看的，再纠正）'],
		// ★★★ 2026-11-02 **React #310 根因**：rail 形态的提前 return 曾在 hooks 中间
		//   ⇒ 侧栏收起/展开切换时 hook 数量变化 ⇒ React 抛 #310 ⇒ 官方 renderer 打
		//   `slot entry crashed in 'sidebar.workspaces'` 并**回退渲染官方 WorkspaceBrowser**。
		//   必须：① 早期只落 `railOnly` 标记；② 真正的 return 在所有 hooks 之后。
		['const railOnly = !wide;', 'rail 形态必须只落标记（不许在 hooks 中间提前 return）'],
		['if (railOnly) {', 'rail 的提前 return 必须放在所有 hooks 之后'],
		// ★ 2026-11-02 用户报「左侧栏又看不到会话/Bots 页签」：根因是页面还跑着部署前的 chunk
		//   （页面不会自动跟随插件更新）。⇒ 必须有用户可控的「重载界面」入口（不自动 reload，
		//   会打断正在跑的对话 ✗），并在标题上暴露当前界面版本便于自证。
		['"data-act": "reload-ui"', '工作区 ⋯ 菜单必须有「重载界面」（插件更新后页面不会自动刷新）'],
		['window.location.reload()', '「重载界面」必须真的 reload（不是只关菜单）'],
		['界面版本：', '「工作区」标题必须暴露界面版本（排查"旧 chunk"时的第一手证据）'],
	];
	// ★ 2026-11-12 切 bot 不重复建会话（页签零副作用 + 并发合并 + 本地兜底，含反向突变）
	{
		// ⚠ 先剥注释：注释里会提到旧实现的函数名，裸 includes 会假红（本次踩过）
		const switchBodyOf = (src) => {
			const i = src.indexOf('const switchView = (v) => {');
			if (i < 0) { return ''; }
			return src.slice(i, i + 500).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		};
		const noSideEffect = (src) => !switchBodyOf(src).includes('startNewSessionFromTab()');
		const hasDedupe = (src) => src.includes('const freshBotSessions = new Map()')
			&& src.includes('const pendingBotOpens = new Map()')
			&& src.includes('const freshSid = freshBotSessions.get(id) || ""')
			&& src.includes('pendingBotOpens.set(id, settled)');
		if (!noSideEffect(ws)) { problems.push('switchView 切到「会话」页签仍在隐式新建会话 ✗'); }
		if (!hasDedupe(ws)) { problems.push('openBot 缺并发合并 / 本地会话兜底 ⇒ 快速切换会重复新建 ✗'); }
		const reverted = ws.replace('const switchView = (v) => {', 'const switchView = (v) => { if (next === "sessions") { startNewSessionFromTab(); }');
		if (noSideEffect(reverted)) { problems.push('反向突变失效：切页签隐式新建的判据抓不到 ✗'); }
		const noDedupe = ws.replace('const freshSid = freshBotSessions.get(id) || ""', 'const freshSid = ""');
		if (hasDedupe(noDedupe)) { problems.push('反向突变失效：本地会话兜底判据抓不到 ✗'); }
		// ★ 2026-11-12：两个 Map 必须在 install 作用域。放在 Browser（组件函数）里会每次渲染重建
		//   ⇒ 真组件交互实测「连点 8 次建 8 条」；静态断言抓不到，这里按位置关系钉死。
		const mapsInInstall = (src) => {
			const i = src.indexOf('function install(ctx, shell) {');
			const m = src.indexOf('const freshBotSessions = new Map()');
			const p = src.indexOf('const pendingBotOpens = new Map()');
			const b = src.indexOf('function Browser(props) {');
			return i >= 0 && m > i && p > i && (b < 0 || (m < b && p < b));
		};
		if (!mapsInInstall(ws)) { problems.push('freshBotSessions / pendingBotOpens 必须定义在 install 作用域（放进 Browser 会随渲染重建 ⇒ 重复建会话）✗'); }
		const movedToBrowser = ws
			// ⚠ 用正则删定义：仓库可能是 CRLF，写死 '\n' 的 replace 匹配不到 ⇒ 反向突变假绿
			.replace(/const freshBotSessions = new Map\(\);/, '')
			.replace(/const pendingBotOpens = new Map\(\);/, '')
			.replace('function Browser(props) {', 'function Browser(props) {\n\t\t\t\tconst freshBotSessions = new Map();\n\t\t\t\tconst pendingBotOpens = new Map();');
		if (mapsInInstall(movedToBrowser)) { problems.push('反向突变失效：Map 作用域判据抓不到 ✗'); }
		// ★ 2026-11-12 P2：切换 bot 零创建 / 新建只能是显式动作
		const hasForceNew = (src) => src.includes('const openBot = (a, opts) => {')
			&& src.includes('const forceNew = !!(opts && opts.forceNew)')
			&& src.includes('const sid = forceNew ? "" : (freshSid || latestSessionIdOf(bots.home, id, usable))')
			&& src.includes('newSession: (bot) => { openBot(bot, { forceNew: true }); return undefined; }');
		if (!hasForceNew(ws)) { problems.push('P2 缺显式 New part：切换 bot 必须零创建，只有右键「新建会话」能走 create ✗'); }
		const writesWorkbenchOwnership = src => /\bsessionBindings\s*(?:\[[^\]]+\])?\s*(?:=(?!=|>)|\|\|=|\?\?=)|delete\s+[^;\n]*\bsessionBindings/.test(src);
		if (writesWorkbenchOwnership(ws)) { problems.push('侧栏只能读取工作台归属，不许在 UI 中双写 sessionBindings ✗'); }
		if (!writesWorkbenchOwnership('state.sessionBindings[id] = owner;') || writesWorkbenchOwnership('state.sessionBindings[id] === owner')) {
			problems.push('工作台归属写入守卫必须区分读取与赋值 ✗');
		}
		const noForce = ws.replace('const forceNew = !!(opts && opts.forceNew)', 'const forceNew = false');
		if (hasForceNew(noForce)) { problems.push('反向突变失效：显式 New part 判据抓不到 ✗'); }
		// ★ 版本线登记：这两个能力来自 dsh 0.2.2-alpha.x 的 ui-workspace 补丁，
		//   官方 0.1.3-alpha.2 的 UiWorkspace 只有 connectWorkspace/startSession/...。
		//   升级宿主版本时必须逐一核对，别把 patch API 当官方契约。
		const HOST_PATCH_APIS = ['uiWorkspace.openSession', 'openWorkspaceSession'];
		if (!HOST_PATCH_APIS.every((a) => ws.includes(a))) {
			problems.push('client.workspaces.js: 依赖的宿主补丁能力清单变了 ⇒ 升级前核对 ui-workspace patch ✗');
		}
		const noPatch = ws.split('uiWorkspace.openSession').join('uiWorkspace.startSession');
		if (HOST_PATCH_APIS.every((a) => noPatch.includes(a))) {
			problems.push('反向突变失效：宿主补丁能力判据抓不到 ✗');
		}
	}
	// 负对照：旧的手画 folder path 不许回来（它在 14px 下就是一团/方块 ✗）
	if (ws.includes('M1.6 3.6A1.6 1.6 0 0 1 3.2 2h2.9')) {
		problems.push('client.workspaces.js: 文件夹图标又变回手画 `fill` path 了 ⇒ 会渲染成方块 ✗（2026-11-02）');
	}
	// ★ 标题口径（2026-11-02 用户截图：整列 `session-2ce24dae-…`）：
	//   官方 `sessionTitle` 没标题就返回空、`displayTitle` 回落「未命名」；**从不显示内部 id**。
	if (!ws.includes('return "未命名"')) {
		problems.push('client.workspaces.js: titleOf 必须回落「未命名」（官方 displayTitle 口径）✗（2026-11-02）');
	}
	if (/if \(!raw\) \{ return sid; \}/.test(ws)) {
		problems.push('client.workspaces.js: titleOf 又回落成会话 id 了 ⇒ 侧栏会整列 `session-xxxx` ✗（2026-11-02）');
	}
	// ★ 负对照：rail 的提前 return 不许再回到 hooks 中间（React #310 会让整棵子树被卸载 ⇒ 官方 UI 回退）
	//   ⚠ 只钉带大括号的代码形态；注释里引用旧写法（不带大括号）不会误伤。
	if (ws.indexOf("if (!wide) {") >= 0) {
		problems.push('client.workspaces.js: rail 又写成 hooks 中间的 `if (!wide) { … return }` 了 ⇒ React #310 + 官方 UI 回退 ✗（2026-11-02）');
	}
	// ★ host 半边：补标题的数据源（**只读**）+ 多帧解压 + 注入过滤
	{
		let hostSrc2 = '';
		try { hostSrc2 = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8'); } catch { hostSrc2 = ''; }
		for (const [needle, why] of [
			['/api/first-prompt', 'host 必须提供只读的 first-prompt 路由（补标题的唯一数据源）'],
			['/api/default-workspace', 'host 必须提供默认工作区目录准备路由（mkdir，幂等）'],
			["join(home, 'VsSaros')", '默认工作区目录必须落在 DSH_HOME 下（不污染用户文档目录）'],
			['async function firstUserPromptOf', '必须有"取首条真实用户消息"的实现'],
			['decompressZstdFrames', '会话日志是**多帧** zstd ⇒ 必须拆帧解压（只解第一帧只能拿到 header ✗）'],
			["d.source.kind !== 'user'", '必须过滤注入内容（只认 `source.kind === user` 的真人输入）'],
			['ZSTD_MAGIC', '拆帧必须有 zstd magic（否则长会话读不到内容）'],
		]) {
			if (hostSrc2.indexOf(needle) < 0) { problems.push(`lib/index.js（host 半边）: 缺「${needle}」—— ${why} ✗（2026-11-02）`); }
		}
	}
	// ★ 2026-11-02（用户报「点新窗格没反应」）：宿主失败只发 **IDE 通知**（桌面模式下 IDE 主窗口隐藏
	//   ⇒ 看不见），桥又不回传 ok ⇒ 页面必须自己给"正在分屏 / 没出现的可能原因"的可见反馈。
	// ★ 2026-11-03（用户报「切到知识库/商城页签再切回会话页签 ⇒ 中栏空白」）：
	//   工作台页签栏切回会话只调 `selectPanel(null)` 且不换 main，跨插件信号打不到
	//   ⇒ 守卫必须能按「main 会话是否变化」把它判成"只切面板"并放行。
	{
		let wbSrc = '';
		try { wbSrc = fs.readFileSync(path.join(PLUGIN_DIR, '..', 'vssaros-workbenches', 'lib', 'client.js'), 'utf8'); } catch { wbSrc = ''; }
		for (const [needle, why] of [
			['let lastMainSidAtPanelCall', 'selectPanel 守卫必须记住上次 main 会话（区分切面板 vs 换会话）'],
			['const onlyPanelSwitch = !!sid && sid === lastMainSidAtPanelCall', 'main 未变的 selectPanel(null) 必须放行（否则切回会话页签白框）'],
			['const fromReplaceMain = /replaceMain|openSession|startSession|connectBlank/.test(stack)', '必须按调用栈区分「工作台内部换会话」与「切回会话页签」'],
		]) {
			if (wbSrc.indexOf(needle) < 0) { problems.push(`vssaros-workbenches/lib/client.js: 缺「${needle}」—— ${why} ✗（2026-11-03）`); }
		}
	}
	{
		let sessSrc = '';
		try { sessSrc = fs.readFileSync(path.join(LIB, 'client.sessions.js'), 'utf8'); } catch { sessSrc = ''; }
		const splitDoc = makeDocumentStub();
		const splitWin = makeWindowStub(splitDoc);
		const splitState = {};
		const splitNotes = [];
		splitWin.__vssarosChatSurface = splitState;
		splitWin.vssarosDsh = {
			splitChatPane: () => ({ then: (_ok, fail) => fail(new Error('split guard failure')) }),
			notify: (level, message) => splitNotes.push({ level, message }),
		};
		try {
			const loaded = loadChunk('client.conversationHeader.js', splitDoc, splitWin);
			loaded.exports.NewWindowChip().props.onClick();
			if (splitState.newWindowEntry !== 'failed' || splitState.newWindowEntryError !== 'split guard failure' || splitNotes[0]?.level !== 'warn') {
				problems.push('常驻页头分屏失败必须保存诊断并通知用户');
			}
			if (!fs.readFileSync(path.join(LIB, 'client.conversationHeader.js'), 'utf8').includes('[vssaros-ws] splitChatPane failed:')) {
				problems.push('常驻页头分屏失败必须保留 console.warn 诊断');
			}
		} catch (error) { problems.push('常驻页头分屏失败检查异常：' + error.message); }
		// ★ 2026-11-03 二次（用户要求「在下拉框中显示 VsSaros，而不是独立按钮」）：
		//   负对照 —— 独立 chip 不许再回来
		if (sessSrc.includes('data-vssaros-open-ide')) {
			problems.push('client.sessions.js: 独立「VsSaros」chip 又回来了 ⇒ 用户明确要求在官方下拉里显示 ✗（2026-11-03）');
		}
	}
	// ★ 2026-11-03：VsSaros 必须是官方「更多打开方式」下拉里的一项（DOM 注入，见该 chunk 头注释）
	//   ⚠ 必须在独立 chunk + ALWAYS_CHUNKS 接线：PART_CHUNKS 只覆盖 surface=chat，
	//      desktop 主栏（full）根本不装 ⇒ 真机第一版就是这样「完全没生效」✗
	{
		let menuSrc = '';
		try { menuSrc = fs.readFileSync(path.join(LIB, 'client.openInAppMenu.js'), 'utf8'); } catch { menuSrc = ''; }
		for (const [needle, why] of [
			['img[src*="open-in-app/icon/"]', '注入判据必须只认官方 open-in-app 菜单（别误伤其它菜单）'],
			['sampleWrap.cloneNode(true)', '菜单项必须从现有项 clone（CSS-module 类名是 hash，写死会失效）'],
			['typeof api.focusIde === "function"', 'VsSaros 菜单项必须走宿主桥 focusIde（不能页面自己开窗）'],
			['new MutationObserver(() => scan())', '菜单是异步 portal ⇒ 必须用 MutationObserver 才能挂上'],
			// ★ 2026-11-03 三次：独立 VsSaros 按钮必须消失（旧 chunk 缓存也可能残留 ⇒ DOM 兜底清理）
			['removeStandaloneChip()', '无条件部件必须清理残留的独立 VsSaros 按钮（只允许在下拉里出现）'],
			['data-vssaros-open-ide', '清理判据必须认准独立 chip 的锚点'],
			['new KeyboardEvent("keydown", { key: "Escape", bubbles: true })', '点击 VsSaros 后必须只派发 Escape 让官方菜单自己卸载'],
			// ★ 2026-11-03：logo 必须与项目正式 SVG 一致（sessions-logo-dark.svg / client.brand.js BrandMark）
			['viewBox="0 0 512 512" width="512" height="512"', 'VsSaros 图标必须用正式 512 viewBox（不许再自画 16×16 蓝底 V）'],
			['rx="96" fill="#FFFFFF"', '必须白底 + rx96 圆角（品牌规范）'],
			['stroke="#FF5A2E"', '必须用品牌橙 #FF5A2E 描边'],
			['A140 140 0 0 1 366.3 169.8', '必须保留上弧几何'],
			['cx="256" cy="256" r="58" stroke-width="30"', '必须保留中心圆几何'],
		]) {
			if (menuSrc.indexOf(needle) < 0) { problems.push(`client.openInAppMenu.js: 缺「${needle}」—— ${why} ✗（2026-11-03）`); }
		}
		// ★ 负对照：菜单是 React portal ⇒ 手动 removeChild 会让 React 抛错并卸载整块头部 UI
		if (/menu\.parentNode\s*&&\s*menu\.parentNode\.removeChild\(menu\)/.test(menuSrc)) {
			problems.push('client.openInAppMenu.js: 又出现手动删除菜单 DOM ⇒ React 抛 removeChild 错误、顶部 UI 全消失 ✗（2026-11-03）');
		}
		let entrySrc = '';
		try { entrySrc = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8'); } catch { entrySrc = ''; }
		if (!/ALWAYS_CHUNKS\s*=\s*\[[^\]]*client\.openInAppMenu\.js/.test(entrySrc)) {
			problems.push('client.js: openInAppMenu 必须接进 ALWAYS_CHUNKS（放 PART_CHUNKS 在 desktop 主栏不装载）✗（2026-11-03）');
		}
	}
	// ★ 2026-11-11（右上角「VsSaros」按钮反复出现）永久守卫 ─────────────────────────────
	//   真源 = vssaros-bridge/lib/client.js 的 P0 自检按钮；兜底 = client.hideBridgePing.js 同 id 遮蔽。
	//   历史失效点：兜底挂在 PART_CHUNKS ⇒ desktop 主栏（surface=full，client.js 早退）不装载 ⇒ 按钮露出。
	//   判据全部走**行为**（真装载 + 真调 apply/install），注释里写什么也骗不过去 ✓。
	{
		let bridgeSrc = '';
		try { bridgeSrc = fs.readFileSync(path.join(HERE, 'vssaros-bridge', 'lib', 'client.js'), 'utf8'); } catch { bridgeSrc = ''; }
		if (!bridgeSrc) {
			problems.push('右上角 VsSaros 按钮守卫：读不到 vssaros-bridge/lib/client.js ⇒ 守卫会空跑 ✗（2026-11-11）');
		}
		// ① 真源：apply(ctx) 一次都不许碰 slots.inject（碰了就会在会话头部画按钮）
		let injectCalls = 0;
		let probe = null;
		try {
			let captured = null;
			const stubWindow = {
				__ModuleLoader__: { load: (mod) => { captured = mod; } },
				vssarosDsh: { surface: 'full', ping: () => 'pong' },
			};
			const requireFn = (spec) => {
				if (spec !== 'react') { throw new Error('bridge client half 只许 require react，实际 ' + spec); }
				return fakeReact;
			};
			new Function('window', 'require', bridgeSrc)(stubWindow, requireFn);
			if (!captured || typeof captured.factory !== 'function') { throw new Error('没有调用 __ModuleLoader__.load'); }
			const mod = captured.factory(requireFn);
			if (typeof mod.apply !== 'function') { throw new Error('没有导出 apply'); }
			mod.apply({
				slots: {
					inject: () => { injectCalls++; return { dispose() { } }; },
					register: () => ({ dispose() { } }),
				},
			});
			probe = stubWindow.__vssarosBridgeClient;
		} catch (e) {
			problems.push(`右上角 VsSaros 按钮守卫：真装载 bridge client half 失败（${String((e && e.message) || e)}）✗（2026-11-11）`);
		}
		if (injectCalls > 0) {
			problems.push(`vssaros-bridge/lib/client.js: 又注册了 ${injectCalls} 个 slot 条目 ⇒ 右上角 P0 自检按钮会回来 ✗（2026-11-11）`);
		}
		// 探针自证：channelProbe.ts 依赖这个对象，删了就是另一类回归
		if (!probe || probe.loaded !== true || probe.surface !== 'full') {
			problems.push('vssaros-bridge/lib/client.js: 页面桥探针 window.__vssarosBridgeClient 被删/形状变了 ✗（2026-11-11）');
		}
		// ② 兜底：真装载遮蔽 chunk，断言同 id / 负 priority / 渲染 null / 幂等
		const cells = [];
		try {
			const doc = makeDocumentStub();
			const win = makeWindowStub(doc);
			const { exports: hideExports } = loadChunk('client.hideBridgePing.js', doc, win);
			const ctx = {
				slots: {
					inject: (slot, fn) => { cells.push({ slot, reg: fn() }); return { dispose() { } }; },
					register: (opts, comp) => ({ entry: opts, render: comp, dispose() { } }),
				},
			};
			const shell = { state: {}, bridge: {} };
			hideExports.install(ctx, shell);
			hideExports.install(ctx, shell);   // 无条件装载 ⇒ 第二次必须 no-op
		} catch (e) {
			problems.push(`右上角 VsSaros 按钮守卫：真装载 client.hideBridgePing.js 失败（${String((e && e.message) || e)}）✗（2026-11-11）`);
		}
		if (cells.length !== 1) {
			problems.push(`client.hideBridgePing.js: 遮蔽必须只注册 1 次（幂等），实际 ${cells.length} 次 ✗（2026-11-11）`);
		}
		const ping = cells.find((c) => c.slot === 'conversation.session.header.utilities'
			&& c.reg && c.reg.entry && c.reg.entry.id === 'vssaros-ping');
		if (!ping) {
			problems.push('client.hideBridgePing.js: 没有在 header.utilities 遮蔽 vssaros-ping ⇒ 旧版 bridge 会露出按钮 ✗（2026-11-11）');
		} else {
			if (!(ping.reg.entry.priority < 0)) {
				problems.push('client.hideBridgePing.js: 遮蔽 priority 必须 < 0（旧版按钮默认 0 ⇒ 才胜出）✗（2026-11-11）');
			}
			if (typeof ping.reg.render !== 'function' || ping.reg.render() !== null) {
				problems.push('client.hideBridgePing.js: 遮蔽组件必须渲染 null（不能只换文案）✗（2026-11-11）');
			}
		}
		// ③ 接线：兜底只在 ALWAYS_CHUNKS（跨 surface），不许再挪回 PART_CHUNKS
		let entry = '';
		try { entry = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8'); } catch { entry = ''; }
		const partArr = (/const PART_CHUNKS = \[([\s\S]*?)\];/.exec(entry) || [])[1] || '';
		const alwaysArr = (/const ALWAYS_CHUNKS = \[([\s\S]*?)\];/.exec(entry) || [])[1] || '';
		if (!alwaysArr.includes('"./client.hideBridgePing.js"')) {
			problems.push('client.js: 遮蔽 chunk 必须接进 ALWAYS_CHUNKS（放 PART_CHUNKS 在 desktop 主栏不装载 ⇒ 按钮露出）✗（2026-11-11）');
		}
		if (partArr.includes('"./client.hideBridgePing.js"')) {
			problems.push('client.js: 遮蔽 chunk 不许留在 PART_CHUNKS（两份清单都装 ⇒ 同 id 重复注册抛错）✗（2026-11-11）');
		}
		if (!problems.some((p) => p.includes('2026-11-11'))) {
			notes.push('右上角 VsSaros 按钮：真源 0 个 slot 注册 + 兜底 null 遮蔽（负 priority / 幂等）+ 只走 ALWAYS_CHUNKS，行为断言通过');
		}
	}
	// ★ 用户：一个 Bot 可能对应多个会话 ⇒ Bot 聊天框右上角要「聊天历史」（下拉可切该 Bot 的历史会话）
	//   判据：① 按 Bot 过滤的纯逻辑（多个 Bot 共用一个 preset 时靠身份记录分开）；
	//         ② 新旧两枚历史按钮互斥（Bot 会话只显示新按钮，非 Bot 会话仍显示全局旧按钮）；
	//         ③ 新 chunk 只走 ALWAYS_CHUNKS（PART 在 full 形态不装载 ⇒ desktop 主栏会没有历史入口）；
	//         ④ 切换必须带 cwd 经宿主桥（页面不许自己切，否则与宿主 slot.sessionId 分叉）。
	{
		const BOT_FILE = 'client.botHistory.js';
		const BOT_ENTRY_ID = 'vssaros-bot-history';
		const bad = (msg) => problems.push('Bot 聊天历史：' + msg + ' ✗');
		let botSrc = '';
		let sessSrc2 = '';
		let entrySrc3 = '';
		try { botSrc = fs.readFileSync(path.join(LIB, BOT_FILE), 'utf8'); } catch { botSrc = ''; }
		try { sessSrc2 = fs.readFileSync(path.join(LIB, 'client.sessions.js'), 'utf8'); } catch { sessSrc2 = ''; }
		try { entrySrc3 = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8'); } catch { entrySrc3 = ''; }
		if (!botSrc || !sessSrc2 || !entrySrc3) { bad('源码读不齐 ⇒ 守卫会空跑'); }

		/** 假 react 树里找属性锚点（createElement 的 children 可能是嵌套数组）。 */
		const hasAttr = (node, attr) => {
			if (!node || typeof node !== 'object') { return false; }
			if (node.props && Object.prototype.hasOwnProperty.call(node.props, attr)) { return true; }
			const kids = node.children;
			if (Array.isArray(kids)) {
				for (const k of kids) { if (hasAttr(k, attr)) { return true; } }
			} else if (kids) { return hasAttr(kids, attr); }
			return false;
		};
		/** 真装载 chunk → 真调 install → 拿到指定 id 的组件并渲染一次。 */
		const renderChip = (file, id, snapshot, sid) => {
			const doc = makeDocumentStub();
			const win = makeWindowStub(doc);
			const ex = loadChunk(file, doc, win).exports;
			const cells = [];
			const ctx = {
				slots: {
					inject: (slot, fn) => { cells.push({ slot: slot, cell: fn() }); return { dispose() { } }; },
					register: (opts, comp) => ({ entry: opts, comp: comp, dispose() { } }),
				},
				sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => undefined } },
				get: () => undefined,
			};
			ex.install(ctx, { bridge: { surface: 'full', openSession: () => Promise.resolve() }, state: {} });
			const hit = cells.find((c) => c.cell && c.cell.entry && c.cell.entry.id === id);
			if (!hit) { throw new Error(file + ' 没注册 ' + id); }
			return { ex: ex, tree: hit.cell.comp({ sessionId: sid }), opts: hit.cell.entry };
		};

		// 同一份快照：s1/s2 属于 Coder，s3 共用 preset 但属于 Writer，s4 无身份记录，s5 别的 preset，s6 标准模式
		const SNAP = {
			byId: {
				s1: { title: '当前', cwd: '/repo', projectionValues: { agentPreset: 'vssaros-coder', 'vssaros-bot': { botId: 'Coder', presetId: 'vssaros-coder' } }, updatedAt: 500 },
				s2: { title: 'Coder 的旧会话', projectionValues: { agentPreset: 'vssaros-coder', 'vssaros-bot': { botId: 'Coder', presetId: 'vssaros-coder' } }, updatedAt: 400 },
				s3: { title: 'Writer 的会话', projectionValues: { agentPreset: 'vssaros-coder', 'vssaros-bot': { botId: 'Writer', presetId: 'vssaros-coder' } }, updatedAt: 300 },
				s4: { title: '无记录同 preset', projectionValues: { agentPreset: 'vssaros-coder' }, updatedAt: 200 },
				s5: { title: '别的 Bot', projectionValues: { agentPreset: 'vssaros-writer' }, updatedAt: 100 },
				s6: { title: '标准模式', projectionValues: { agentPreset: 'standard' }, updatedAt: 90 },
			},
			archivedSessionIds: [],
		};
		try {
			const r = renderChip(BOT_FILE, BOT_ENTRY_ID, SNAP, 's1');
			if (r.opts.name !== 'conversation.session.header.utilities' || r.opts.order !== -1 || r.opts.id !== BOT_ENTRY_ID) {
				bad('新按钮的 slot/id/order 不对（order 必须 -1：官方 -10/-5/0、我们 -4/-3/-2 都占用）');
			}
			if (!hasAttr(r.tree, 'data-vssaros-bot-history')) { bad('Bot 会话没有渲染出「聊天历史」按钮'); }
			const t = r.ex.__test || {};
			if (typeof t.historyRows !== 'function' || typeof t.botKeyOf !== 'function' || typeof t.fitMenuBox !== 'function') {
				bad('缺少可断言的纯逻辑导出（守卫会空跑）');
			} else {
				const one = t.historyRows(SNAP, 's1', 50);
				if (one.scopedKey !== 'id:Coder' || one.rows.map((x) => x.id).join(',') !== 's1,s2') {
					bad('Bot 会话必须只列同 Bot 的历史会话（身份记录优先，且按时间倒序）');
				}
				const two = t.historyRows(SNAP, 's4', 50);
				if (two.rows.map((x) => x.id).join(',') !== 's4') { bad('无身份记录时按 preset 归属，不能把有记录的 Bot 会话混进来'); }
				const three = t.historyRows(SNAP, 's6', 50);
				if (three.scopedKey !== null || three.rows.length !== 6) { bad('非 Bot 会话必须回退成全局历史（已有能力不许减）'); }
				if (one.rows[0].cwd !== '/repo') { bad('菜单行必须保留 cwd（切历史会话时宿主靠它把会话拉活）'); }
				const clamp = t.fitMenuBox({ left: 10, right: 30, bottom: 280 }, { w: 320, h: 160 }, { vw: 200, vh: 300 });
				if (clamp.left !== 8 || clamp.top !== 132) { bad('菜单必须夹进视口（下方不够要上收）'); }
			}
			// ② 互斥：Bot 会话只有新按钮 / 非 Bot 会话只有旧按钮
			const oldOnBot = renderChip('client.sessions.js', 'vssaros-sessions', SNAP, 's1');
			if (oldOnBot.tree !== null) { bad('Bot 会话里旧的全局「历史会话」按钮必须让位（否则右上角两枚重复）'); }
			const newOnOther = renderChip(BOT_FILE, BOT_ENTRY_ID, SNAP, 's6');
			if (newOnOther.tree !== null) { bad('非 Bot 会话不该显示 Bot 聊天历史按钮'); }
			const oldOnOther = renderChip('client.sessions.js', 'vssaros-sessions', SNAP, 's6');
			if (!hasAttr(oldOnOther.tree, 'data-vssaros-history-chip')) { bad('非 Bot 会话的全局历史按钮被误删'); }
		} catch (e) {
			bad('真装载 / 真渲染失败（' + String((e && e.message) || e) + '）');
		}
		// ③ 接线：只走 ALWAYS_CHUNKS（并集守卫已覆盖"文件在包里但没接线"）
		const partArr2 = (/const PART_CHUNKS = \[([\s\S]*?)\];/.exec(entrySrc3) || [])[1] || '';
		const alwaysArr2 = (/const ALWAYS_CHUNKS = \[([\s\S]*?)\];/.exec(entrySrc3) || [])[1] || '';
		if (!alwaysArr2.includes('"./' + BOT_FILE + '"')) { bad('必须接进 ALWAYS_CHUNKS（PART_CHUNKS 在 full 形态不装载）'); }
		if (partArr2.includes('"./' + BOT_FILE + '"')) { bad('不许同时留在 PART_CHUNKS（同 id 重复注册会抛错）'); }
		if (!sessSrc2.includes('if (botSession) { return null; }')) { bad('client.sessions.js 缺少 Bot 会话让位判据'); }
		if (sessSrc2.indexOf('bridge.openSession(row.id, row.preset || undefined)') < 0) {
			bad('非 Bot 会话的全局历史菜单切换通路被删（已有能力不许减）');
		}
		// ④ 切换通路：带 cwd 的宿主桥调用（注释里写的是省略形态，不会让断言假绿）
		if (botSrc.indexOf('bridge.openSession(row.id, row.preset || undefined, row.cwd || undefined)') < 0) {
			bad('切换必须走 bridge.openSession(id, preset, cwd)，不许页面自己切');
		}
		// 随包清单：漏 files = 装上去没有这个文件 ⇒ 按钮永远不出现
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
			if (!Array.isArray(pkg.files) || pkg.files.indexOf('lib/' + BOT_FILE) < 0) { bad('package.json 的 files 漏了 lib/' + BOT_FILE); }
		} catch (e) { bad('package.json 读不到 / 不是合法 JSON'); }
		if (!problems.some((p) => p.startsWith('Bot 聊天历史：'))) {
			notes.push('Bot 聊天历史：按 Bot 过滤（含共用 preset）/ 新旧按钮互斥 / 只走 ALWAYS_CHUNKS / 带 cwd 走宿主桥，行为断言通过');
		}
	}
	for (const [needle, why] of need) {
		if (ws.indexOf(needle) < 0) { problems.push(`client.workspaces.js: 缺「${needle}」—— ${why} ✗（2026-11-02）`); }
	}
	// ★★ 2026-11-14：两处新建会话调用都必须走 `openWsSession` 封装，不许再裸调官方入口
	//   （裸调 = 第三参数 undefined = `reuse.agentPreset` 抛错）。⚠ 剥注释：注释里会引用旧调用形态。
	{
		const code = ws.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
			.filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
		const bare = [...code.matchAll(/uw\.openWorkspaceSession\(([^)]*)\)/g)]
			.map((m) => m[1].trim()).filter((args) => !/^id, undefined, \{\}$/.test(args));
		if (bare.length) {
			problems.push('⑤-l 还有裸调 uw.openWorkspaceSession(' + bare.join(' / ') + ') ⇒ 缺第三参数 `{}` ⇒ 点「+」报 agentPreset ✗');
		}
		const wrapped = (code.match(/openWsSession\(/g) || []).length;
		if (wrapped < 2) { // 2 处调用：登记后新建 / 已有 workspaceId（定义是 `openWsSession =`，不含括号）
			problems.push('⑤-l 新建会话的两条路径没有都走 openWsSession 封装（登记后新建 / 已有 workspaceId）✗');
		}
	}
	// ★ 2026-11-13（用户要求「移除 dsh 侧 bots 页签右侧的 + 按钮」）：
	//   tabBar 原先 `.concat([...])` 无条件追加 `data-vssaros-sidebar-new-session` 的
	//   「+ 新建会话」按钮（不受 view 门控 ⇒ 选中「会话」时也在，还用 marginLeft:auto 挤窄两个页签）。
	//   ⇒ 负断言钉死「不许再加回来」。只扫 tabBar 的**代码行**（说明注释里提到旧锚点不算数）。
	{
		const at = ws.indexOf('const tabBar = react.createElement("div"');
		const end = ws.indexOf('// 「会话」页签', at);
		const tabBarCode = at >= 0 && end > at
			? ws.slice(at, end).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
			: '';
		if (!tabBarCode) { problems.push('页签条「+」移除守卫：定位不到 tabBar 源码 ⇒ 守卫会空跑 ✗（2026-11-13）'); }
		if (/data-vssaros-sidebar-new-session|\.concat\(/.test(tabBarCode)) {
			problems.push('client.workspaces.js: tabBar 不许再渲染/追加「+ 新建会话」按钮（2026-11-13 用户要求移除）✗');
		}
	}
	// 负对照：旧链路（归档 → 删盘）不许回来
	if (/archiveSession\(sid\)\)\s*\.then\(wipe/.test(ws)) {
		problems.push('client.workspaces.js: 删除又改回「先归档再删盘」了 ⇒ 会污染「已归档」列表 ✗（2026-11-02）');
	}
	// 纯逻辑：未读集合增删 / 切换
	if (typeof tw.toggleUnread !== 'function') {
		problems.push('client.workspaces.js: 缺 __testw.toggleUnread（未读集合增删必须可单测 ✗）');
	} else {
		const j = (v) => JSON.stringify(v);
		if (j(tw.toggleUnread([], 'a')) !== j(['a'])) { problems.push('toggleUnread: 空集 + 标未读 ⇒ 应得 ["a"] ✗'); }
		if (j(tw.toggleUnread(['a'], 'a', false)) !== j([])) { problems.push('toggleUnread: 标已读 ⇒ 应移除 ✗'); }
		if (j(tw.toggleUnread(['a'], 'a', true)) !== j(['a'])) { problems.push('toggleUnread: 重复标未读必须幂等 ✗'); }
		if (j(tw.toggleUnread(['a', 'b'], 'a')) !== j(['b'])) { problems.push('toggleUnread: 省略 on = 切换（有则删）✗'); }
	}
	if (typeof tw.absTimeLabel !== 'function') {
		problems.push('client.workspaces.js: 缺 __testw.absTimeLabel ✗');
	} else if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(tw.absTimeLabel(Date.now()))) {
		problems.push('absTimeLabel: 格式必须是 YYYY-MM-DD HH:mm ✗');
	}
	// ★ 2026-11-02：新建 Bot / 群聊的校验（纯函数，必须与 host 同口径）
	if (typeof tw.validateBotDraft !== 'function') {
		problems.push('client.workspaces.js: 缺 __test.validateBotDraft ✗');
	} else {
		if (!tw.validateBotDraft({ name: 'x', id: 'Bad ID!' }, []).length) { problems.push('validateBotDraft: 非法 id 必须报错 ✗'); }
		if (!tw.validateBotDraft({ name: '', id: 'ok-id' }, []).length) { problems.push('validateBotDraft: 空名称必须报错 ✗'); }
		if (!tw.validateBotDraft({ name: 'x', id: 'ok-id' }, ['ok-id']).some((s) => s.indexOf('已被占用') >= 0)) {
			problems.push('validateBotDraft: id 重名必须报错（host 会 409，前端先拦）✗');
		}
		if (tw.validateBotDraft({ name: 'x', id: 'ok-id' }, []).length) { problems.push('validateBotDraft: 合法输入不该报错 ✗'); }
	}
	if (typeof tw.validateGroupDraft !== 'function') {
		problems.push('client.workspaces.js: 缺 __test.validateGroupDraft ✗');
	} else {
		if (!tw.validateGroupDraft({ name: 'g', members: [] }).length) { problems.push('validateGroupDraft: 没勾成员必须报错 ✗'); }
		if (!tw.validateGroupDraft({ name: '', members: ['a', 'b'] }).length) { problems.push('validateGroupDraft: 空群名必须报错 ✗'); }
		if (!tw.validateGroupDraft({ name: 'g', members: ['a'] }).length) { problems.push('validateGroupDraft: 少于2个不同成员必须报错 ✗'); }
		if (tw.validateGroupDraft({ name: 'g', members: ['a', 'b'] }).length) { problems.push('validateGroupDraft: 合法输入不该报错 ✗'); }
	}
	if (!problems.length) { notes.push('client.workspaces.js: 会话行 UI 复刻（圆点 / 双击改名 / 绝对时间）+ 未读 + 删除走 detachSession 断言通过'); }
}

// ── ⑥ 兜底进会话的"挑哪一条"（client.workbenchNav.js 的 pickLatestSessionId；2026-10-17）──
// 病根链：弹窗停在 hero（无会话在屏）⇒ 输入框 inert 不能打字 / 右栏按钮缺失 / 条目无处挂载。
// 救援 = 挑最近更新的会话打开 ⇒ "挑错"会直接让用户进到一条不相干的旧会话，必须钉住口径 ✓。
{
	const doc = makeDocumentStub();
	const win = makeWindowStub(doc);
	let loaded = null;
	try {
		loaded = loadChunk('client.workbenchNav.js', doc, win);
	} catch (e) {
		problems.push(`client.workbenchNav.js: 装载失败 — ${String((e && e.message) || e)}`);
	}
	const t = loaded && loaded.exports.__test;
	if (!t || typeof t.pickLatestSessionId !== 'function') {
		problems.push('client.workbenchNav.js: 缺 __test.pickLatestSessionId（兜底进会话的选条逻辑必须可单测 ✗）');
	} else {
		const byId = { a: { updatedAt: 100 }, b: { updatedAt: 300 }, c: { createdAt: 200 }, d: { updatedAt: 300 } };
		if (t.pickLatestSessionId(byId, []) !== 'b') { problems.push('pickLatestSessionId: 应取 updatedAt 最大（同值按 id 升序 ⇒ b）✗'); }
		if (t.pickLatestSessionId(byId, ['b']) !== 'd') { problems.push('pickLatestSessionId: 归档的必须跳过（b 归档 ⇒ d）✗'); }
		if (t.pickLatestSessionId({ c: { createdAt: 200 } }, []) !== 'c') { problems.push('pickLatestSessionId: 缺 updatedAt 时回落 createdAt ✗'); }
		if (t.pickLatestSessionId({ x: {} }, []) !== 'x') { problems.push('pickLatestSessionId: 都没时间戳也要选一条（宁可旧会话也别停在 hero）✗'); }
		if (t.pickLatestSessionId({}, []) !== null) { problems.push('pickLatestSessionId: 空快照应回 null ✗'); }
		notes.push('client.workbenchNav.js: pickLatestSessionId 选条口径断言通过');
	}
}

// ── ⑥-b 「主页」行的布局契约 + 页签条落位（2026-10-21 用户指令「工作台改名为主页 / 移除当前的主页按钮」）──
// 侧栏**只应有一行**：文案「主页」、id=vssaros-workbench、order=-10（官方 plugins=0 / schedules=10 **之前**）。
// 这三条是**布局契约**，被人顺手改回 20 时界面会静默退回旧序（不报错、只是位置不对）⇒ 必须钉住 ✓。
// ⚠ 2026-10-21：并发工作线曾把本守卫脚本一起回退到旧版（连带 0.2.192 期的专项断言一起没了）⇒
//   这几条是**重建**的（照着插件当前实现逐条核对过）✓。
{
	const doc = makeDocumentStub();
	const win = makeWindowStub(doc);
	let loaded = null;
	try { loaded = loadChunk('client.workbenchNav.js', doc, win); } catch (e) {
		problems.push(`client.workbenchNav.js: 装载失败 — ${String((e && e.message) || e)}`);
	}
	if (loaded) {
		const { shell } = makeShell();
		let regs = [];
		try { regs = captureRegistration(loaded.exports, shell); } catch (e) {
			problems.push(`client.workbenchNav.js: install() 抛错 — ${String((e && e.message) || e)} ✗`);
		}
		const flat = regs.map((r) => {
			const e = (r.entry && r.entry.entry) ? r.entry.entry : r.entry;
			return { slot: (e && e.name) || r.slot, id: e && e.id, key: e && e.key, order: e && e.order, label: e && e.label };
		});
		const navRows = flat.filter((r) => r.slot === 'sidebar.panellist');
		if (navRows.length !== 1) {
			problems.push(`client.workbenchNav.js: 侧栏应只剩**一行**入口（实际 ${navRows.length} 行：${navRows.map((r) => `${r.id}@${r.order}`).join(', ')}）—— 「当前工作台」那行必须删掉（用户："移除当前的主页按钮"）✗`);
		}
		const row = navRows[0];
		if (!row || row.id !== 'vssaros-workbench' || row.order !== -10) {
			problems.push(`client.workbenchNav.js: 那一行应为 id=vssaros-workbench order=-10（官方 plugins=0 之前）；实际 ${JSON.stringify(row || null)} ✗`);
		}
		if (row && row.label !== '主页') {
			problems.push(`client.workbenchNav.js: 那一行的文案必须是「主页」（用户："工作台改名为主页"；实际 ${JSON.stringify(row.label)}）✗`);
		}
		if (!flat.some((r) => r.slot === 'main' && r.key === 'vssaros-workbench')) {
			problems.push('client.workbenchNav.js: 「主页」那行没有对应 main 面板（key=vssaros-workbench，官方点击 = selectPanel(id)）⇒ 点了没反应 ✗');
		}
		// 页签条必须落在**常驻**槽 shell.overlay（放进 main 面板 ⇒ 点「会话」后页签全消失 ✗）
		if (!flat.some((r) => r.slot === 'shell.overlay' && r.id === 'vssaros-wb-tabstrip')) {
			problems.push('client.workbenchNav.js: 页签条必须注册到常驻槽 shell.overlay（id=vssaros-wb-tabstrip）—— 放在 main 面板里会和对话面板一起被卸载 ⇒ 点「会话」后页签全部消失 ✗');
		}
		const srcAll = fs.readFileSync(path.join(LIB, 'client.workbenchNav.js'), 'utf8');
		const anchors = (srcAll.match(/"data-vssaros-wb-tabstrip"/g) || []).length;
		if (anchors !== 1) {
			problems.push(`client.workbenchNav.js: 页签条锚点应只出现 1 次（实际 ${anchors} 次）—— 重复画会看到两条 ✗`);
		}
		// ★ 2026-10-22（工作台重构 P1 方案 A）：已注册进宿主 `desktopWorkbenches` 的工作台在页签里
		//   直接渲染宿主 View（不开 iframe）；宿主可能晚到 ⇒ 必须是可选注入 + 订阅刷新。三处任何一处没了 ⇒
		//   要么静默退回 iframe（迁了等于白迁），要么宿主晚到时永远看不到新界面。
		for (const [label, re] of [
			['可选注入宿主服务 desktopWorkbenches', /ctx\.inject\(\["desktopWorkbenches"\]/],
			['宿主有新注册时刷新页签', /svc\.subscribe\(fire\)/],
			['页签内渲染宿主 View（替代 iframe）', /createElement\(wbService\.View, \{ id: wbId, active: on \}\)/],
			['只认不带查询串的 /x/<module>/（变体仍走 iframe）', /\/\^\\\/x\\\/\(\[a-z\]\[a-z0-9-\]\*\)\\\/\$\//],
		]) {
			if (!re.test(srcAll)) {
				problems.push(`client.workbenchNav.js: 缺少「${label}」⇒ React 工作台不会出现在页签里`);
			}
		}
		// ★ 2026-10-22（§5 步骤 4）：IDE 编辑区 `surface=workbench` 视图的入口分支（在主包 client.js 里）。
		//   分支没了 ⇒ 页面落到"非 chat/full 一律 return" ⇒ 编辑区是一个空白的 dsh 外壳 ✗；
		//   退回没了 ⇒ 宿主没装时同样空白（而不是回到 SSR 完整页）✗。
		{
			const entrySrc = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
			const branch = entrySrc.indexOf('bridge.surface === "workbench"');
			const gate = entrySrc.indexOf('bridge.surface !== "chat" && bridge.surface !== "full"');
			for (const [label, ok] of [
				['workbench 分支在"非 chat/full 一律 return"之前', branch >= 0 && gate >= 0 && branch < gate],
				['宿主 / 工作台不到场 ⇒ 退回 SSR 完整页', /window\.location\.replace\(route \+ "\?surface=editor"\)/.test(entrySrc)],
				['按模块路由打开 vssaros/<module>', /svc\.open\(wb\.id\)/.test(entrySrc) && /"vssaros\/" \+ m\[1\]/.test(entrySrc)],
			]) {
				if (!ok) {
					problems.push(`client.js: 缺少「${label}」⇒ IDE 编辑区的 React 工作台视图会是空白`);
				}
			}
		}
		// 点「主页」必须**开主页那一页**（按 id 找，不受排序影响）⇒ 纯函数可单测 ✓
		const t = loaded.exports.__test;
		if (!t || typeof t.pickDashboardItem !== 'function') {
			problems.push('client.workbenchNav.js: 缺 __test.pickDashboardItem（「主页」行开哪一页必须可单测 ✗）');
		} else {
			const picked = t.pickDashboardItem([
				{ id: 'vssaros-wb-sessions', name: '会话' },
				{ id: 'vssaros-wb-dashboard', name: '主页' },
				{ id: 'vssaros-wb-kb', name: '知识库' },
			]);
			if (!picked || picked.id !== 'vssaros-wb-dashboard') {
				problems.push(`pickDashboardItem: 必须按 id 找到主页（不论排序位置）；实际 ${JSON.stringify(picked)} ✗`);
			}
			const noDash = t.pickDashboardItem([{ id: 'vssaros-wb-kb', name: '知识库' }]);
			if (!noDash || noDash.id !== 'vssaros-wb-kb') {
				problems.push('pickDashboardItem: 主页被删掉时应回落第一项（不能返回 undefined ⇒ 点了没反应）✗');
			}
			if (!t.pickDashboardItem([])) { problems.push('pickDashboardItem: 空列表也要给一个条目（不能 undefined）✗'); }
		}
		notes.push('client.workbenchNav.js: 侧栏单行「主页」（order -10）+ 中转面板 + 页签条落 shell.overlay 断言通过');
	}
}

// ⑥-b′ P3 默认布局：中间栏顶部不再有页签、左侧不再有主页行、main 不再注册旧工作台面板。
{
	const doc = makeDocumentStub();
	const win = makeWindowStub(doc);
	win.__vssarosSidebarLayoutV1 = true;
	let loaded = null;
	try { loaded = loadChunk('client.workbenchNav.js', doc, win); }
	catch (e) { problems.push(`client.workbenchNav.js: P3 默认布局装载失败 — ${String((e && e.message) || e)} ✗`); }
	if (loaded) {
		let regs = [];
		try { regs = captureRegistration(loaded.exports, makeShell().shell); }
		catch (e) { problems.push(`client.workbenchNav.js: P3 默认布局 install() 抛错 — ${String((e && e.message) || e)} ✗`); }
		const flat = regs.map((r) => {
			const e = (r.entry && r.entry.entry) ? r.entry.entry : r.entry;
			return { slot: (e && e.name) || r.slot, id: e && e.id, key: e && e.key };
		});
		if (flat.some(r => r.slot === 'shell.overlay' && r.id === 'vssaros-wb-tabstrip')) {
			problems.push('client.workbenchNav.js: P3 默认布局仍注册中栏页签条 ✗');
		}
		if (flat.some(r => r.slot === 'main' && r.key === 'vssaros-workbench')) {
			problems.push('client.workbenchNav.js: P3 默认布局仍注册旧「主页」main 面板 ✗');
		}
		if (flat.some(r => r.slot === 'sidebar.panellist' && r.id === 'vssaros-workbench')) {
			problems.push('client.workbenchNav.js: P3 默认布局仍注册左侧「主页」行 ✗');
		}
		notes.push('client.workbenchNav.js: P3 默认布局零中栏页签 / 零旧主页行 / 零旧 main 面板断言通过');
	}
}

// ── ⑥-c 侧栏「主页」行必须**每次点击**都激活主页页签（2026-11-11 真机报障）─────────────
// 用户原话：「点击 左侧栏的主页按钮，无法切换到 对应 主页页签 页面」。
// 真因：那行的点击归官方 selectPanel，而「激活主页页签」原先**只**挂在 main 面板
//       useEffect([]) 的**首次挂载**副作用上 ⇒ 中栏面板已在屏（用户正停在别的工作台页签）时
//       selectPanel 幂等、effect 不重跑 ⇒ 静默无反应（CDP 复现：在「知识库」页签里点主页行，
//       localStorage 的活动页签仍是 vssaros-wb-kb）。
// ⇒ 必须做**行为**断言：真装载 chunk → 真跑 install → 派发假 click → 断言活动页签真的变了。
//   ⚠ ⑥-b 只钉「有 main 面板 / pickDashboardItem 纯函数」，对这类运行时幂等缺陷全程绿 ✗
//     （又是「markup 存在 ≠ 交互可达」那一族 ⇒ 这一条不能省）。
{
	const before6c = problems.length;
	const doc = makeDocumentStub();
	// 起始状态刻意停在**别的工作台页签**：正是真机复现的那个前置条件
	const store = new Map([['vssaros.wb.tabs.active', 'vssaros-wb-kb']]);
	const clickCapture = [];
	doc.addEventListener = (type, fn, capture) => {
		if (type === 'click' && capture === true) { clickCapture.push(fn); }
	};
	const win = makeWindowStub(doc);
	win.localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	let loaded = null;
	try { loaded = loadChunk('client.workbenchNav.js', doc, win); }
	catch (e) {
		problems.push(`⑥-c client.workbenchNav.js: 装载失败 — ${String((e && e.message) || e)} ✗`);
	}
	if (loaded) {
		const { shell, state } = makeShell();
		try { captureRegistration(loaded.exports, shell); }
		catch (e) {
			problems.push(`⑥-c client.workbenchNav.js: install() 抛错 — ${String((e && e.message) || e)} ✗`);
		}
		if (!clickCapture.length) {
			problems.push('⑥-c client.workbenchNav.js: 侧栏「主页」行缺 document 捕获阶段的 click 监听 ⇒ 中栏面板已在屏时点击不会切到主页页签（2026-11-11 报障）✗');
		} else {
			// 负对照：点别处（含别处同名按钮）不许改活动页签
			clickCapture.forEach((fn) => fn({ button: 0, target: { closest: () => null } }));
			if (store.get('vssaros.wb.tabs.active') !== 'vssaros-wb-kb') {
				problems.push('⑥-c client.workbenchNav.js: 点别处也改了活动页签（捕获监听判据过宽）✗');
			}
			// 正对照：点我们那一行（带稳定锚点的官方侧栏按钮）
			const fakeBtn = { querySelector: (s) => (s === '[data-vssaros-home-entry]' ? {} : null) };
			const fakeTarget = { closest: (s) => (s === 'button[aria-label="主页"]' ? fakeBtn : null) };
			clickCapture.forEach((fn) => fn({ button: 0, target: fakeTarget }));
			if (store.get('vssaros.wb.tabs.active') !== 'vssaros-wb-dashboard') {
				problems.push(`⑥-c client.workbenchNav.js: 点了侧栏「主页」行，活动页签仍是 ${JSON.stringify(store.get('vssaros.wb.tabs.active'))}（应为 vssaros-wb-dashboard）⇒ "点了没反应" 回归 ✗`);
			}
			if (!state.homeEntryClicks) {
				problems.push('⑥-c client.workbenchNav.js: 激活函数没有真正跑到（守卫判据或接线失效）✗');
			}
		}
		// 稳定锚点是捕获监听**认行**的唯一依据 ⇒ 只在 stub 里造按钮会绕过它，必须另钉源码形状
		const srcHome = fs.readFileSync(path.join(LIB, 'client.workbenchNav.js'), 'utf8');
		if (!srcHome.includes('"data-vssaros-home-entry": "1"')) {
			problems.push('⑥-c client.workbenchNav.js: 「主页」行图标缺稳定锚点 data-vssaros-home-entry ⇒ 真机捕获监听永远认不出这一行（守卫假绿）✗');
		}
		if (problems.length === before6c) {
			notes.push('⑥-c 侧栏「主页」行：每次点击都显式激活主页页签（行为断言 + 稳定锚点）');
		}
	}
}

// ── ⑭「主页」行不许被别的注册连累（2026-10-21 真机「主页丢失」）────────────────────────────
// 真机原文（官方槽服务）：官方对**重复注册**直接抛 ——
//   keyed slot "sidebar.right.pane.tab" already has an entry for key "…" (registered by …)
//   list  slot "sidebar.panellist"   already has an entry with id  "…" (registered by …)
// 而旧写法是**裸** `ctx.slots.register(...)` ⇒ 任意一处撞了 ⇒ 那个异常从 install() 一路抛出 ⇒
//   **后面的注册全被跳过**（含侧栏「主页」那一行）⇒ 又因为幂等标记在注册**之前**就置上了 ⇒
//   之后任何一次再装载都被早退挡住 ⇒ 「主页」行在整个页面生命周期里**永远补不回来**
//   （真机症状：侧栏只剩 插件 / 自动化任务，🏠主页 不见了）✗✗。
// ⇒ 这条守卫用**官方口径的假 ctx**（同 key / 同 id 重复注册就抛）复现那个现场，钉三条：
//   ① install 本身不许抛（每处注册都必须被包住）；
//   ② 撞了 key 之后，侧栏「主页」那一行**仍必须注册得上**；
//   ③ 「主页」行必须**第一个**注册（不许排在最后当替死鬼）。
{
	/** 官方口径的假 ctx：同 key / 同 id 重复注册 ⇒ 抛（与真机原文同形 ✓）。 */
	const makeStrictCtx = (preOccupied) => {
		const occupied = new Map();
		for (const [slot, ids] of Object.entries(preOccupied || {})) { occupied.set(slot, new Set(ids)); }
		const registered = [];
		const ctx = {
			slots: {
				inject: (name, fn) => { const e = fn(); registered.push({ slot: name, entry: e }); return { dispose() { } }; },
				register: (options) => {
					const slot = options && options.name;
					const isList = !!(options && options.id !== undefined);
					const ident = isList ? options.id : (options && options.key);
					let set = occupied.get(slot);
					if (!set) { set = new Set(); occupied.set(slot, set); }
					if (ident !== undefined && set.has(ident)) {
						throw new Error(`${isList ? 'list' : 'keyed'} slot "${slot}" already has an entry ${isList ? 'with id' : 'for key'} "${ident}" at priority 0 (registered by vssaros-chat-surface-client)`);
					}
					if (ident !== undefined) { set.add(ident); }
					return { entry: options, dispose() { } };
				},
			},
			effect: (fn) => { try { const d = fn(); if (typeof d === 'function') { d(); } } catch { /* 可选服务 */ } },
			get: () => undefined,
			plugin: () => { },
		};
		return { ctx, registered };
	};
	const flattenRegs = (regs) => regs.map((r) => {
		const e = (r.entry && r.entry.entry) ? r.entry.entry : r.entry;
		return { slot: (e && e.name) || r.slot, id: e && e.id, key: e && e.key, order: e && e.order, label: e && e.label };
	});
	const doc = makeDocumentStub();
	const win = makeWindowStub(doc);
	let loaded = null;
	try { loaded = loadChunk('client.workbenchNav.js', doc, win); } catch (e) {
		problems.push(`client.workbenchNav.js: 装载失败 — ${String((e && e.message) || e)}`);
	}
	if (loaded) {
		// 现场：`sidebar.right.pane.tab` 的某个 key **已被占**（官方会抛）⇒ 主页行仍必须注册得上。
		const { ctx, registered } = makeStrictCtx({ 'sidebar.right.pane.tab': ['vssaros-wb-dashboard'] });
		const { shell } = makeShell();
		try {
			loaded.exports.install(ctx, shell);
		} catch (e) {
			problems.push(`client.workbenchNav.js: 某处注册撞 key 时 install() 整个抛错（${String((e && e.message) || e)}）⇒ **后面的注册全被跳过** ⇒ 侧栏「主页」那行会消失（用户报「主页丢失」）✗`);
		}
		const regs = flattenRegs(registered);
		const nav = regs.find((r) => r.slot === 'sidebar.panellist' && r.id === 'vssaros-workbench');
		if (!nav) {
			problems.push('client.workbenchNav.js: 某处注册撞 key 时，侧栏「主页」那行**没注册上** ⇒ 用户侧栏少一行（2026-10-21 真机「主页丢失」）✗');
		} else if (nav.order !== -10) {
			problems.push(`client.workbenchNav.js: 侧栏「主页」那行的 order 应为 -10（实际 ${nav.order}）✗`);
		}
		// ③ 「主页」行必须**第一个**注册（排在后面就可能被前面某一处抛错带走 ✗）。
		const first = regs[0];
		if (!first || first.slot !== 'sidebar.panellist' || first.id !== 'vssaros-workbench') {
			problems.push(`client.workbenchNav.js: 侧栏「主页」那行必须是**第一个**注册的槽条目（实际第一个是 ${first ? first.slot + '/' + (first.id || first.key) : '（无）'}）—— 排在后面就可能被前面某一处抛错带走 ✗`);
		}
		notes.push('client.workbenchNav.js: 重复注册不许带走「主页」行（官方口径假 ctx）断言通过');
	}
}

// ── ⑮ 入口指纹：改了 chunk **必须**动入口（rev 只跟入口走）──────────────────────────────
// 官方 `artifactRevision()` = framedHash("plugin-artifact", [入口的 mtime/ctime/size, …])
// ⇒ 客户端 chunk 的 `?rev=` **只跟入口 `lib/client.js` 走** ⇒ **只改 `client.*.js` 而不改入口**
//   ⇒ rev 不变 ⇒ 浏览器继续吃缓存里的**旧 chunk** ⇒ 用户看到的是**旧界面**（2026-10-21 真机：
//   侧栏「主页」那一行就是这么丢的 —— 18:15 改了 client.workbenchNav.js、没动入口；22:17 补改入口后才恢复）✗✗。
// ⇒ 判据：**工作区里改了任何 chunk**（git diff + 未跟踪新文件）⇒ 该插件的入口 `lib/client.js`
//   **必须在其后被改过**（改了 CLIENT_BUILD_STAMP 那行注释即可）⇒ 漏了必红。
{
	const repoRootG = path.resolve(import.meta.dirname, '..');
	let gitWhy = '';
	const gitOut = (args) => {
		try {
			return execFileSync('git', args, { cwd: repoRootG, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).split('\n').map((s) => s.trim()).filter(Boolean);
		} catch (e) {
			// ⚠ git 可能**非零退出**（并发写索引 / CRLF 警告 / dubious ownership 等）⇒
			//   退出码非 0 不等于"没有输出" ⇒ 仍取 stdout（只有真的没有输出才算不可用）✓
			const out = e && e.stdout ? String(e.stdout) : '';
			if (out.trim()) { return out.split('\n').map((s) => s.trim()).filter(Boolean); }
			gitWhy = String((e && e.message) || e).slice(0, 160);
			return null;
		}
	};
	const tracked = gitOut(['diff', '--name-only', 'HEAD', '--', 'dsh-plugins']);
	const untracked = gitOut(['ls-files', '--others', '--exclude-standard', '--', 'dsh-plugins']);
	if (tracked === null || untracked === null) {
		notes.push('入口指纹守卫：git 不可用 ⇒ 跳过（拿不到工作区改动面）' + (gitWhy ? '（' + gitWhy + '）' : ''));
	} else {
		const touched = [...tracked, ...untracked].map((p) => p.replace(/\\/g, '/'));
		const pluginsDir = path.join(repoRootG, 'dsh-plugins');
		const pluginDirs = fs.existsSync(pluginsDir)
			? fs.readdirSync(pluginsDir, { withFileTypes: true })
				.filter((e) => e.isDirectory() && fs.existsSync(path.join(pluginsDir, e.name, 'lib', 'client.js')))
				.map((e) => e.name)
			: [];
		let checked = 0;
		// ⚠ 判据要**管时序**，不只是"动过没动过"：rev 只认**入口自己的 mtime/ctime/size** ⇒
		//   「先改了 chunk、过了两小时才动入口」⇒ 中间那段时间装出来的包 rev 不变 ⇒ 浏览器吃旧片 ✗
		//   （2026-10-21 真机：18:15 改 chunk、22:17 才动入口 ⇒ 那 4 小时里装出来的窗口全是旧界面）。
		const TOLERANCE_MS = 2000;
		// ★ 2026-10-28：**CI 里必须跳过这段**。判据用的是文件系统 mtime，而 git 不保存 mtime ——
		//   CI 全新 checkout 后所有文件的 mtime 都等于检出时间（相差毫秒级）⇒ 这条"谁先谁后"
		//   既可能假红也可能假绿，毫无意义。它的价值是**本地开发的即时提醒**（改完 chunk 记得动入口）。
		const skipMtime = process.env['CI'] === 'true' || process.argv.includes('--skip-mtime');
		for (const dir of pluginDirs) {
			if (skipMtime) { continue; }
			const base = 'dsh-plugins/' + dir + '/lib/';
			const chunkFiles = touched.filter((p) => p.startsWith(base) && /^client\..+\.js$/.test(p.slice(base.length)));
			if (!chunkFiles.length) { continue; }
			checked += 1;
			let entryMtime = 0;
			try { entryMtime = fs.statSync(path.join(repoRootG, base, 'client.js')).mtimeMs; } catch { /* 读不到 */ }
			let newestChunk = 0; let newestName = '';
			for (const p of chunkFiles) {
				let m = 0;
				try { m = fs.statSync(path.join(repoRootG, p)).mtimeMs; } catch { /* 读不到 */ }
				if (m > newestChunk) { newestChunk = m; newestName = p.split('/').pop(); }
			}
			if (entryMtime + TOLERANCE_MS < newestChunk) {
				problems.push(`${dir}: 入口 lib/client.js 的 mtime 比改过的 chunk（${newestName}）**旧** ⇒ 客户端 chunk 的 ?rev 不会随这次改动变化 ⇒ 浏览器会一直吃缓存里的旧 chunk ⇒ 用户看到旧界面（2026-10-21 真机：「主页」那行就是这样丢的）✗ —— 请在改完 chunk 之后再动一下入口（改 CLIENT_BUILD_STAMP 那行注释即可）`);
			}
		}
		notes.push(skipMtime
			? '入口 mtime 守卫：CI 环境跳过（git 不保存 mtime，检出后的先后顺序无意义 —— 本地跑会检查）'
			: `入口指纹守卫：${checked} 个插件有改过的 chunk（入口必须在其后动过）`);
	}
}

// ── ⑯ 设置 → 模型：CodeBuddy 账号界面（client.modelAccounts.js，2026-10-22，用户确认方案 A'）─────────────
// 钉四条：① 两个官方扩展位都注册了（卡片 keyed=llm-pi-ai / 页尾 list 带 id+order）；
//   ② Host 状态 ⇒ 界面状态的映射（哪种状态入口在页尾、哪种在行内）——映射错了 = 用户找不到登录入口 ✗；
//   ③ A'：结构吻合时藏掉官方「自定义」徽标与「编辑/删除」，**卸载时还原**；
//   ④ 结构不吻合时**什么都不藏**（自动退回方案 A，绝不误伤别的元素）。
{
	const doc = makeDocumentStub();
	const win = makeWindowStub(doc);
	let loaded = null;
	try { loaded = loadChunk('client.modelAccounts.js', doc, win); } catch (e) {
		problems.push(`client.modelAccounts.js: 装载失败 — ${String((e && e.message) || e)}`);
	}
	if (loaded) {
		const { shell } = makeShell();
		const regs = captureRegistration(loaded.exports, shell).map((r) => {
			const e = (r.entry && r.entry.entry) ? r.entry.entry : r.entry;
			return { slot: (e && e.name) || r.slot, id: e && e.id, key: e && e.key, order: e && e.order };
		});
		if (!regs.some((r) => r.slot === 'settings.models.provider-card' && r.key === 'llm-pi-ai')) {
			problems.push('client.modelAccounts.js: 没在 settings.models.provider-card 上以 key=llm-pi-ai 注册（CodeBuddy 行里不会出现账号条 ✗）');
		}
		if (!regs.some((r) => r.slot === 'settings.models.footer' && r.id === 'vssaros-accounts' && typeof r.order === 'number')) {
			problems.push('client.modelAccounts.js: 没在 settings.models.footer 上注册（带 id+order）⇒ 未登录时找不到 CodeBuddy 登录入口 ✗');
		}
		const t = loaded.exports.__test;
		const cases = [
			[null, 'unknown'],
			[{ signedIn: false, signingIn: true }, 'pending'],
			[{ signedIn: true, routeWritten: true, models: 34 }, 'in'],
			[{ signedIn: true, routeWritten: false, models: 0 }, 'empty'],
			[{ signedIn: true, routeWritten: false, models: null }, 'syncing'],
			[{ signedIn: false, error: 'CodeBuddy 登录已失效（目录接口 HTTP 401），请重新登录' }, 'expired'],
			[{ signedIn: false, error: '请求超时（30s）' }, 'error'],
			[{ signedIn: false, error: '已取消登录' }, 'out'],
			[{ signedIn: false }, 'out'],
		];
		for (const [st, want] of cases) {
			const got = t.cardState(st);
			if (got !== want) { problems.push(`modelAccounts.cardState(${JSON.stringify(st)}) 应为 ${want}，实际 ${got} ✗`); }
		}
		if (t.fmtCountdown(288_000) !== '4:48' || t.fmtCountdown(-5) !== '0:00') { problems.push('modelAccounts.fmtCountdown 格式不对 ✗'); }
		const now = 1_000_000_000_000;
		if (t.renewText({ canRefresh: false, expiresAt: now + 7200_000 }, now) !== '') { problems.push('modelAccounts.renewText：没有 refresh token 时不该承诺"自动续期" ✗'); }
		if (!/1 小时 55 分后自动续期/.test(t.renewText({ canRefresh: true, expiresAt: now + 7200_000 }, now))) { problems.push('modelAccounts.renewText：续期时间应按"过期前 5 分钟"口径算 ✗'); }

		// ③④ A' 隐藏：用极简 DOM 复刻官方行结构 li > head(left(name, badge, dot), actions(btn, btn)) + slot > anchor
		const mk = (tag, text, attrs) => {
			const el = { tagName: tag, textContent: text || '', style: {}, dataset: {}, children: [], parent: null, attrs: Object.assign({}, attrs) };
			el.hasAttribute = (n) => Object.prototype.hasOwnProperty.call(el.attrs, n);
			el.append = (...cs) => { for (const c of cs) { c.parent = el; el.children.push(c); } return el; };
			el.contains = (x) => { for (let p = x; p; p = p.parent) { if (p === el) { return true; } } return false; };
			el.closest = (sel) => { for (let p = el; p; p = p.parent) { if (p.tagName.toLowerCase() === sel) { return p; } } return null; };
			Object.defineProperty(el, 'firstElementChild', { get: () => el.children[0] || null });
			return el;
		};
		const build = (actionTags) => {
			const name = mk('SPAN', 'CodeBuddy'), badge = mk('SPAN', '自定义'), dotEl = mk('SPAN', '', { 'aria-label': 'API 密钥已配置' });
			const left = mk('SPAN').append(name, badge, dotEl);
			const actions = mk('SPAN').append(...actionTags.map((tg) => mk(tg, tg === 'BUTTON' ? '编辑' : 'x')));
			const head = mk('DIV').append(left, actions);
			const anchor = mk('DIV');
			const li = mk('LI').append(head, mk('DIV').append(anchor));
			return { li, badge, actions, name, dotEl, anchor };
		};
		const ok1 = build(['BUTTON', 'BUTTON']);
		const restore = t.hideOfficialRowControls(ok1.anchor);
		if (ok1.actions.style.display !== 'none' || ok1.badge.style.display !== 'none') {
			problems.push('modelAccounts A\'：结构吻合时应藏掉官方「编辑/删除」与「自定义」徽标 ✗');
		}
		if (ok1.name.style.display === 'none' || ok1.dotEl.style.display === 'none') {
			problems.push('modelAccounts A\'：误藏了名字 / 状态圆点 ✗');
		}
		restore();
		if (ok1.actions.style.display === 'none' || ok1.badge.style.display === 'none') {
			problems.push('modelAccounts A\'：卸载后没有还原官方按钮 ✗');
		}
		const odd2 = build(['BUTTON', 'DIV']);
		t.hideOfficialRowControls(odd2.anchor);
		if (odd2.actions.style.display === 'none') {
			problems.push('modelAccounts A\'：按钮区里混着非按钮元素（官方改版）时不该隐藏 ⇒ 必须自动退回方案 A ✗');
		}
		const src = fs.readFileSync(path.join(LIB, 'client.modelAccounts.js'), 'utf8');
		if (!/vssarosCbAccount === "1" \? hideOfficialRowControls/.test(src)) {
			problems.push('modelAccounts A\'：必须只在账号条真的画出来时才藏官方按钮（老版本桥插件没有 API 时，官方按钮是唯一的操作入口）✗');
		}
		notes.push('client.modelAccounts.js: 两个扩展位注册 / 状态映射 / A\' 隐藏与还原 / 结构不符退回 A 断言通过');
	}
}

// ── ⑰ 模式槽守卫（client.preset.js；2026-10-21 立、2026-10-22 补回 + P0-1）─────────────────────
// ⚠ 2026-10-22 发现：这一段**曾经写过、后来整段丢了**（HEAD 与工作区都没有，疑似并发会话覆盖）⇒ 补回。
// 口径（用户指令「agent 定位成 Bot，不要让 agent 作为 preset 呈现」+「收敛成 4 个模式」）：
//   ① 模式菜单**只有 4 项**：vssaros-standard / vssaros-ptc / minimal / cordis（agent 一个都不许进）；
//   ② 必须注册到 `conversation.hero.agentPreset`（否则官方 seat 仍会把 agent 列进来）；
//   ③ 切换走官方 `ctx.remote.agentPresets.select`，**不得**回到宿主桥 `bridge.switchPreset`
//      （无桥环境 = dsh desktop / 全窗 ⇒ 点了没反应 ✗）；
//   ④ ★ P0-1：当前会话不在菜单里时，chip **不得冒充菜单第一项**（旧实现回落 modes[0] ⇒ Bot 会话显示成
//      「极简模式」✗）⇒ resolveCurrent 按种类给出真实名称（绝对期望值，不是相对比较）。
{
	const doc = makeDocumentStub();
	const win = makeWindowStub(doc);
	let loaded = null;
	try { loaded = loadChunk('client.preset.js', doc, win); } catch (e) {
		problems.push(`client.preset.js: 装载失败 — ${String((e && e.message) || e)}`);
	}
	if (loaded) {
		const t = loaded.exports.__test;
		if (!t || typeof t.modesOf !== 'function' || typeof t.resolveCurrent !== 'function') {
			problems.push('client.preset.js: 缺 __test.modesOf / __test.resolveCurrent（模式过滤与当前名称必须可单测 ✗）');
		} else {
			const roster = [
				{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal', order: 3 }, { id: 'cordis', order: 4 },
				{ id: 'vssaros-standard', name: '标准模式（VsSaros）', order: 100, isDefault: true },
				{ id: 'vssaros-ptc', name: 'PTC 模式（VsSaros）', order: 101 },
				{ id: 'vssaros-full', name: '标准档 · 全工具（VsSaros）', order: 102 },
				{ id: 'vssaros-code-architect', name: 'Code Architect' },
				{ id: 'vssaros-coder', name: 'Coder' },
				{ id: 'some-user-agent', name: '用户自建 Agent' },
			];
			// ① 只列 4 个模式（★ 反向突变点：过滤改成全放行 ⇒ 这里必红）
			const kept = t.modesOf(roster).map((p) => String(p.id)).sort();
			const expected = ['cordis', 'minimal', 'vssaros-ptc', 'vssaros-standard'];
			if (JSON.stringify(kept) !== JSON.stringify(expected)) {
				problems.push(`client.preset.js: 模式菜单应恰好是 ${expected.join('/')}，实际 ${kept.join('/')} ✗（agent/Bot 不许以 preset 呈现；官方 standard/ptc 与退役的 vssaros-full 不进菜单）`);
			}
			// ④ P0-1：当前名称（绝对期望值）
			const modes = t.modesOf(roster);
			const cases = [
				['vssaros-code-architect', 'bot', 'Bot · Code Architect'],
				['standard', 'legacy', '标准模式（dsh 原生）'],
				['vssaros-full', 'legacy', '标准档 · 全工具（VsSaros）'],
				['minimal', 'mode', '极简模式'],
				['vssaros-ptc', 'mode', 'PTC 模式（VsSaros）'],
				['', 'mode', '标准模式（VsSaros）'],
				['ghost-preset', 'unknown', 'ghost-preset'],
			];
			for (const [cur, kind, label] of cases) {
				const r = t.resolveCurrent(roster, cur, modes);
				if (!r || r.kind !== kind || r.label !== label) {
					problems.push(`client.preset.js: resolveCurrent(${JSON.stringify(cur)}) 应为 {${kind}, ${label}}，实际 ${JSON.stringify(r)} ✗（旧 bug：Bot 会话 chip 显示成「极简模式」）`);
				}
			}
		}
		// ③ 切换通道
		const src = fs.readFileSync(path.join(LIB, 'client.preset.js'), 'utf8');
		if (!/remote\.agentPresets\.select\(/.test(src)) {
			problems.push('client.preset.js: 切换必须走官方 ctx.remote.agentPresets.select（无桥环境也能切）✗');
		}
		if (/bridge\.switchPreset/.test(src)) {
			problems.push('client.preset.js: 不得回到宿主桥 bridge.switchPreset（dsh desktop / 全窗没有桥 ⇒ 点了没反应）✗');
		}
		// ② 注册槽
		try {
			const regs = captureRegistration(loaded.exports, makeShell().shell);
			const hit = regs.some((r) => {
				const spec = r && r.entry && r.entry.entry ? r.entry.entry : (r && r.entry);
				return r.slot === 'conversation.hero.agentPreset' || (spec && spec.name === 'conversation.hero.agentPreset');
			});
			if (!hit) { problems.push('client.preset.js: 必须注册到 conversation.hero.agentPreset（否则官方 seat 仍会把 agent 列进模式菜单）✗'); }
		} catch (e) {
			problems.push(`client.preset.js: install() 抛错 — ${String((e && e.message) || e)}`);
		}
		notes.push('模式槽守卫：恰好 4 个模式 / 当前名称不冒充（7 例）/ 切换走官方 remote / 注册到 hero 槽');
	}
}

// ── ⑱ Bot 入口：空白会话先预选、会话出现后才生效（client.botEntry.js；2026-10-22 P0-2）──────────────
// 旧 bug：空白会话里选 Bot ⇒ 直接 POST 空 sessionId ⇒ 宿主 400「需要 sessionId」⇒ 错误只写进 state，
//   用户**毫无反馈** ✗✗。钉三条行为（假 ctx + 假 fetch 真跑，不是读源码）：
//   ① 无会话时选 Bot ⇒ **不发请求**，共享 store 变成 staged（模式 chip 旁会显示「已预选…」）；
//   ② 会话出现（SessionListState.current 有值）⇒ 才 POST，且 sessionId 就是那个会话；
//   ③ 宿主拒绝 ⇒ store 变成 error，**带上正文里的原因**（不是只有 HTTP 400）。
{
	const doc = makeDocumentStub();
	const win = makeWindowStub(doc);
	let loaded = null;
	try { loaded = loadChunk('client.botEntry.js', doc, win); } catch (e) {
		problems.push(`client.botEntry.js: 装载失败 — ${String((e && e.message) || e)}`);
	}
	if (loaded) {
		const t = loaded.exports.__test || {};
		if (typeof t.retryable !== 'function' || typeof t.botNoticeStore !== 'function') {
			problems.push('client.botEntry.js: 缺 __test.retryable / __test.botNoticeStore ✗');
		} else {
			if (t.retryable('HTTP 400：会话不在运行，无法热切换：s1') !== true) { problems.push('botEntry.retryable：「会话不在运行」应判为可重试 ✗'); }
			if (t.retryable('HTTP 400：未知 preset：x') !== false) { problems.push('botEntry.retryable：「未知 preset」不应重试 ✗'); }
		}
		const st = {};
		let snap = { current: undefined, byId: {} };
		const subs = new Set();
		let registered = null;
		const calls = [];
		const ctx = {
			get: (name) => (name === 'commandUi' ? { register: (c) => { registered = c; return { dispose() { } }; } } : undefined),
			remote: { agentPresets: { list: () => Promise.resolve({ ok: true, value: { presets: [{ id: 'vssaros-coder', name: 'Coder' }] } }) } },
			sessions: { list: { getSnapshot: () => snap, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } } },
		};
		const realFetch = globalThis.fetch;
		let respond = () => ({ ok: true, status: 200, text: () => Promise.resolve('') });
		globalThis.fetch = (url, init) => { calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }); return Promise.resolve(respond()); };
		const flush = () => new Promise((r) => setTimeout(r, 30));
		try {
			loaded.exports.install(ctx, { state: st });
			if (!registered || typeof registered.ui?.onSelect !== 'function') {
				problems.push('client.botEntry.js: 无桥时没有注册 Bots 行（commandUi.register）✗');
			} else {
				// ① 无会话 ⇒ 预选、不发请求
				registered.ui.onSelect({ id: 'vssaros-coder', label: 'Coder' }, {});
				await flush();
				const n1 = st.vssarosBotNotice && st.vssarosBotNotice.get();
				if (calls.length !== 0) { problems.push(`client.botEntry.js: 无会话时不该发请求（旧 bug：POST 空 sessionId ⇒ 400 且无反馈），实际发了 ${calls.length} 次 ✗`); }
				if (!n1 || n1.kind !== 'staged' || !/Coder/.test(n1.text)) { problems.push(`client.botEntry.js: 无会话时应显示「已预选 Bot · Coder」，实际 ${JSON.stringify(n1)} ✗`); }
				// ② 会话出现 ⇒ 才 POST，sessionId 对
				snap = { current: 'sess-new', byId: {} };
				for (const fn of [...subs]) { fn(); }
				await flush();
				if (calls.length !== 1 || !calls[0].body || calls[0].body.sessionId !== 'sess-new' || calls[0].body.presetId !== 'vssaros-coder') {
					problems.push(`client.botEntry.js: 会话出现后应 POST 一次 {sessionId: sess-new, presetId: vssaros-coder}，实际 ${JSON.stringify(calls)} ✗`);
				}
				const n2 = st.vssarosBotNotice && st.vssarosBotNotice.get();
				if (!n2 || n2.kind !== 'done') { problems.push(`client.botEntry.js: 生效后应显示「已切换」，实际 ${JSON.stringify(n2)} ✗`); }
				// ③ 宿主拒绝 ⇒ error + 正文原因
				respond = () => ({ ok: false, status: 400, text: () => Promise.resolve('未知 preset：vssaros-ghost') });
				registered.ui.onSelect({ id: 'vssaros-ghost', label: 'Ghost' }, { sessionId: 'sess-new' });
				await flush();
				const n3 = st.vssarosBotNotice && st.vssarosBotNotice.get();
				if (!n3 || n3.kind !== 'error' || !/未知 preset/.test(n3.text)) { problems.push(`client.botEntry.js: 宿主拒绝时应显示带原因的错误，实际 ${JSON.stringify(n3)} ✗`); }
			}
		} catch (e) {
			problems.push(`client.botEntry.js: 行为断言抛错 — ${String((e && e.message) || e)}`);
		} finally {
			globalThis.fetch = realFetch;
		}
		notes.push('Bot 入口：空白会话先预选 / 会话出现后才 POST / 拒绝时带正文原因 —— 行为断言通过');
	}
}

// ── ⑫ 中栏是我们的工作台面板时，**不许**抢用户的导航（2026-10-23 真机报障）──────────────
//   用户原话：「主页显示过程中，page 突然被切换成了聊天输入框」。
//   机理：两处"救援/自动进会话"的判据都是"聊天 DOM 不在 = 会话没打开"，而**中栏被我们的面板占着**时
//   聊天 DOM 天然不在 ⇒ 救援调用 uiWorkspace.openSession ⇒ 官方 replaceMain(…,'reveal') 里的
//   selectPanel(null) ⇒ 把主页换回聊天 ✗。
//   ⚠ 这类断言必须钉**绝对形态**（顺序 / 完整表达式），相对比较会被"两处都删掉"骗过。
{
	// 本节自带读取（本守卫没有全局 read/stripComments 助手 ⇒ 别引用不存在的东西 ✗）
	const readSrc = (rel) => fs.readFileSync(path.join(LIB, rel), 'utf8');
	const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const clientSrc = strip(readSrc('client.js'));
	// ① 主包轮询的闸门必须把"中栏是我们的面板"算进去（与 onOtherRoute 同一行）
	const gate = 'if (onOtherRoute() || workbenchPanelActive() || !looksBlankPage()) {';
	if (!clientSrc.includes(gate)) {
		problems.push('client.js: "不抢用户导航"那道闸门没有把 workbenchPanelActive() 算进去 ⇒ 中栏显示主页时仍会被救援切回聊天 ✗');
	}
	// ② 判据本体：必须查我们面板自己的两个根标记
	const declAt = clientSrc.indexOf('const workbenchPanelActive = () => {');
	if (declAt < 0) {
		problems.push('client.js: 找不到 workbenchPanelActive（判据没了 ⇒ 上面的闸门恒 false ✗）');
	} else {
		const body = clientSrc.slice(declAt, declAt + 400);
		if (!body.includes('[data-vssaros-wb-tabs]') || !body.includes('[data-vssaros-wb-full]')) {
			problems.push('client.js: workbenchPanelActive 必须查 [data-vssaros-wb-tabs] 与 [data-vssaros-wb-full]（两个面板根标记都要 ✓）');
		}
	}

	const wbSrc = strip(readSrc('client.workbenchNav.js'));
	// ③ 救援 tick 里，workbenchPanelActive() 必须**先于** openSession（顺序断言）
	const tickAt = wbSrc.indexOf('const timer = window.setInterval(() => {');
	if (tickAt < 0) {
		problems.push('client.workbenchNav.js: 找不到救援 tick（自动进会话的定时器）✗');
	} else {
		const iGuard = wbSrc.indexOf('workbenchPanelActive()', tickAt);
		const iOpen = wbSrc.indexOf('ctx.uiWorkspace.openSession(', tickAt);
		if (iGuard < 0) {
			problems.push('client.workbenchNav.js: 救援 tick 没有排除"中栏是我们的面板" ⇒ 会把主页换回聊天 ✗');
		} else if (iOpen >= 0 && iGuard > iOpen) {
			problems.push('client.workbenchNav.js: workbenchPanelActive() 排在 openSession 之后（等于没拦 ✗）');
		}
	}
	// ④ 页签高亮必须跟"面板在不在屏"对齐（否则页签会说谎：主页高亮着、内容是聊天）
	if (!wbSrc.includes('const panelOn = workbenchPanelActive();')) {
		problems.push('client.workbenchNav.js: 页签条没有取 panelOn（面板被切走后「主页」仍高亮 ✗）');
	}
	if (!wbSrc.includes('const chatOn = !panelOn || !openTabs.some((t) => t.id === activeTabId);')) {
		problems.push('client.workbenchNav.js: chatOn 必须同时看 panelOn（只按 activeTabId 判断 ⇒ 页签说谎 ✗）');
	}
	// ⚠ 2026-10-23 拖拽排序把这一行改成了 `Object.assign({}, <高亮 ? tabOn : tabBase>, <拖拽态>)` ⇒
	//   断言只钉**判据本身**（`panelOn && activeTabId === t.id ? tabOn : tabBase`），别再钉整行原文 ✗
	if (!wbSrc.includes('panelOn && activeTabId === t.id ? tabOn : tabBase')) {
		problems.push('client.workbenchNav.js: 页签高亮必须等于 "面板在屏 && 是活动页签"（否则面板被切走后仍亮 ✗）');
	}
	// ⑤ 负对照：旧写法不许复活（它正是被修掉的那个 bug）
	if (wbSrc.includes('const chatOn = !openTabs.some((t) => t.id === activeTabId);')) {
		problems.push('client.workbenchNav.js: 旧写法 `chatOn = !openTabs.some(...)` 又回来了（不看面板是否在屏 ✗）');
	}
	if (!problems.some((p) => /workbenchPanelActive|chatOn|panelOn|救援 tick/.test(p))) {
		notes.push('中栏面板不被抢：主包轮询 + 救援 tick 都排除"我们的面板在屏"，页签高亮按面板真实状态对齐');
	}
}

// ── ⑬ 页签条支持拖拽排序（2026-10-23 用户："要求页签支持拖拽排序"）──────────────
//   要点：① 用 pointer 事件（不用 HTML5 draggable）；② 拖完要**持久化顺序**（否则重开窗口又乱）；
//   ③ 「会话」是固定出口，不许被拖走；④ 拖动后紧跟的那次 click 必须丢掉（否则松手就切页签 ✗）。
{
	const readSrc = (rel) => fs.readFileSync(path.join(LIB, rel), 'utf8');
	const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const wb = strip(readSrc('client.workbenchNav.js'));

	// ① pointer 三件套
	for (const [label, needle] of [
		['拖拽起点 onPointerDown', 'onPointerDown: (e) => beginDrag(e, t.id, i)'],
		['移动监听 pointermove', 'window.addEventListener("pointermove", onMove)'],
		['松手监听 pointerup', 'window.addEventListener("pointerup", onUp)'],
	]) {
		if (!wb.includes(needle)) {
			problems.push(`client.workbenchNav.js: 缺少${label} ⇒ 页签拖不动 ✗`);
		}
	}

	// ② 换序必须真换 + 持久化（两个都在同一个函数里）
	const mAt = wb.indexOf('const moveTabTo = (id, slot) => {');
	if (mAt < 0) {
		problems.push('client.workbenchNav.js: 找不到 moveTabTo（拖拽结果无处落地 ✗）');
	} else {
		const body = wb.slice(mAt, mAt + 900);
		// ⚠ 2026-10-23：换序语义已抽到纯函数 `reorderTabs`（行为级断言在 `check-dsh-tab-drag.mjs`）
		//   ⇒ 这里只钉"接线"：moveTabTo 必须调它，别再内联一份 splice 实现（两份迟早漂移 ✗）。
		if (!body.includes('reorderTabs(openTabs, id, slot)')) {
			problems.push('client.workbenchNav.js: moveTabTo 必须走 reorderTabs（换序只允许一处实现 ✗）');
		}
		if (!body.includes('saveTabs(openTabs)')) {
			problems.push('client.workbenchNav.js: 换序后必须 saveTabs(openTabs)（否则重开窗口顺序又乱 ✗）');
		}
		if (!body.includes('bumpTabs()')) {
			problems.push('client.workbenchNav.js: 换序后必须 bumpTabs()（否则条上不重画 ✗）');
		}
	}

	// ③ 拖动过后的 click 必须被吞掉
	if (!wb.includes('if (dragMovedRef.current) { dragMovedRef.current = false; return; }')) {
		problems.push('client.workbenchNav.js: 页签 onClick 没有"刚拖过就丢掉"的闸门 ⇒ 松手会顺势切页签 ✗');
	}

	// ④ 负对照：「会话」那格（`"data-vssaros-wb-tab": "chat"`）不许挂拖拽起点
	const chatAt = wb.indexOf('"data-vssaros-wb-tab": "chat"');
	if (chatAt < 0) {
		problems.push('client.workbenchNav.js: 找不到「会话」那一格（守卫无法确认它没被拖拽化）✗');
	} else if (wb.slice(chatAt, chatAt + 400).includes('onPointerDown')) {
		problems.push('client.workbenchNav.js: 「会话」那格挂了 onPointerDown ⇒ 回聊天的出口会被拖走 ✗');
	}

	// ⑤ ✕ 上按下不许起拖（否则想关页签会把条拖歪）
	if (!wb.includes('onPointerDown: (e) => { try { e.stopPropagation(); }')) {
		problems.push('client.workbenchNav.js: 关闭按钮没挡 pointerdown ⇒ 点 ✕ 也会进入拖拽 ✗');
	}

	if (!problems.some((p) => /拖拽|moveTabTo|dragMovedRef|会话」那格|pointerdown/.test(p))) {
		notes.push('页签拖拽排序：pointer 事件换序 + saveTabs 持久化 + 「会话」不可拖 + 松手不误切');
	}
}

// ── ⑦ 「首次点页签却被主页覆盖」回归守卫（2026-10-24）──────────────────────────
// 用户报障：「当首次点击其他页签时，会默认切中 主页 页签」。
// 根因：中栏面板（makeTabPanel）**首次挂载**时无条件 `ensureTab(pick())`（pick 恒为主页），
//       而"首次挂载"恰恰是用户第一次点页签触发的 ⇒ 刚点的那一项被改回主页 ✗。
// 修法：用 `pendingTabOpen` 意图标记区分"用户显式切页"与"宿主开面板"。
// 这四条任何一条被删都会让 bug 复活，且**不会有任何报错**（页签静默跳回主页）⇒ 必须钉死。
{
	// 自带读文件 + 去注释（`strip` / `readSrc` 是别的函数里的局部量，这里不能用 ✓）
	const wbSrc = fs.readFileSync(new URL('./vssaros-chat-surface/lib/client.workbenchNav.js', import.meta.url), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
	const before = problems.length;

	// ① 意图标记必须存在
	if (!wbSrc.includes('let pendingTabOpen = "";')) {
		problems.push('client.workbenchNav.js: 缺 pendingTabOpen 意图标记 ⇒ 首次点页签会被主页覆盖（2026-10-24 报障）✗');
	}

	// ② 页签点击：必须**先**写标记，再 selectPanel（selectPanel 才会触发首次挂载）
	const clickAt = wbSrc.indexOf('"data-vssaros-wb-tab": t.id,');
	if (clickAt < 0) {
		problems.push('client.workbenchNav.js: 找不到工作台页签的 onClick 区域（守卫无法确认意图标记 ✗）');
	} else {
		const clickBody = wbSrc.slice(clickAt, clickAt + 1400);
		const markAt = clickBody.indexOf('pendingTabOpen = t.id;');
		const selAt = clickBody.indexOf('ctx.layout.selectPanel(ENTRY_ID)');
		if (markAt < 0) {
			problems.push('client.workbenchNav.js: 页签 onClick 没写 pendingTabOpen ⇒ 首次点击仍会被主页覆盖 ✗');
		} else if (selAt > 0 && markAt > selAt) {
			problems.push('client.workbenchNav.js: pendingTabOpen 必须写在 selectPanel **之前**（写在后面时挂载 effect 已经跑完 ✗）');
		}
	}

	// ③ ensureTab（启动器 / 主页卡片「打开」）也要记意图
	// ⚠ 切到**下一个函数定义**为止，不要用固定字符窗口：
	//   ensureTab 后来加了「组件页签 comp/props」那一大段 ⇒ `pendingTabOpen = it.id` 被顶出 600 字符
	//   ⇒ 守卫在代码**正确**时报假红（2026-11-02 实际踩到 ✗）。
	const ensureAt = wbSrc.indexOf('function ensureTab(it)');
	if (ensureAt < 0) {
		problems.push('client.workbenchNav.js: 找不到 ensureTab（守卫锚点失效 ✗）');
	} else {
		const ensureEnd = wbSrc.indexOf('function openRegisteredWorkbench', ensureAt);
		const ensureBody = wbSrc.slice(ensureAt, ensureEnd > ensureAt ? ensureEnd : ensureAt + 2000);
		if (!ensureBody.includes('pendingTabOpen = it.id;')) {
			problems.push('client.workbenchNav.js: ensureTab 没写 pendingTabOpen ⇒ 从主页卡片「打开」也会被弹回主页 ✗');
		}
	}

	// ④ 挂载 effect：必须先消费标记并**提前 return**，且早于 ensureTab(pick())
	const effAt = wbSrc.indexOf('const wantTab = pendingTabOpen;');
	if (effAt < 0) {
		problems.push('client.workbenchNav.js: 挂载 effect 没有消费 pendingTabOpen ⇒ 首次点页签又被拉回主页 ✗');
	} else {
		const effBody = wbSrc.slice(effAt, effAt + 400);
		if (!effBody.includes('pendingTabOpen = "";')) {
			problems.push('client.workbenchNav.js: 消费后必须清空 pendingTabOpen（陈旧值会在下次挂载误伤 ✗）');
		}
		if (!/if \(wantTab && wantTab === activeTabId\) \{ setVer\(v => v \+ 1\); return; \}/.test(effBody)) {
			problems.push('client.workbenchNav.js: 命中意图时必须 return（不许继续走到 ensureTab(主页) ✗）');
		}
		const ensureCallAt = wbSrc.indexOf('ensureTab(it);', effAt);
		if (ensureCallAt < 0) {
			problems.push('client.workbenchNav.js: 挂载 effect 里找不到 ensureTab(it)（原有"首次进主页"行为不能丢 ✗）');
		} else if (ensureCallAt < effAt) {
			problems.push('client.workbenchNav.js: 意图判定必须早于 ensureTab(it)（否则覆盖已经发生 ✗）');
		}
	}

	// ⑤ 负对照：只允许 5 处赋值
	//    声明 / ensureTab / 页签点击 / 消费清空 / **openWorkbenchTab（2026-11-02 新增）**
	//    ⚠ 最后一处是「开任意页签」必须的：否则中栏面板首次挂载的 effect 会
	//      `ensureTab(pick())` 把刚打开的页签抢回 dashboard（用户看到白页 ✗）
	const assigns = (wbSrc.match(/pendingTabOpen = /g) || []).length;
	if (assigns !== 5) {
		problems.push(`client.workbenchNav.js: pendingTabOpen 应恰好 5 处赋值（声明/ensureTab/页签点击/消费清空/openWorkbenchTab），实际 ${assigns} 处 ✗`);
	}

	if (problems.length === before) {
		notes.push('页签首次点击不被主页覆盖：意图标记 + 消费顺序 + 侧栏「主页」路径不受影响');
	}
}

// ── ⑭ 账号行必须在**所有** surface 生效（2026-10-24 真机：插件页里左下角是官方账号行）──────
//   用户报障原话：「左下角的 tof 登录按钮为什么会触发官方的登录，是 profile 错了么」。
//   真机日志把链路钉死了：点下去弹的是 `https://platform.deepseek.com/dsh/authorize?…`
//   （dsh 官方 DeepSeek 账号，URL 只由运行时包 `dsh-deepseek-account-platform` 构造），
//   而同期**没有任何** `signInIde` / `tof` 调用 ⇒ 那颗不是我们画的。
//   根因两层，缺一不可：
//     ① `client.account.js` 只在 PART_CHUNKS（有 sessionId）与 full 分支里 require ⇒
//        插件页（`/x/skills/?surface=editor`，无 sessionId ⇒ BLANK_SESSION_PARTS）**压根没装载**；
//     ② chunk 里又有 `chrome` 判据（只认 full / chat+!chatOnly）⇒ 就算装上也 return。
//   ⇒ 判据必须"除纯聊天框以外都装"，且装载走 ALWAYS_CHUNKS（无条件）。
{
	const readSrc = (rel) => fs.readFileSync(path.join(LIB, rel), 'utf8');
	const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const entry = strip(readSrc('client.js'));
	const acct = strip(readSrc('client.account.js'));

	// ① 无条件装载
	const alwaysAt = entry.indexOf('const ALWAYS_CHUNKS = [');
	if (alwaysAt < 0) {
		problems.push('client.js: 找不到 ALWAYS_CHUNKS（账号行无处无条件装载）✗');
	} else {
		const line = entry.slice(alwaysAt, entry.indexOf('];', alwaysAt));
		if (!line.includes('"./client.account.js"')) {
			problems.push('client.js: `client.account.js` 必须在 ALWAYS_CHUNKS 里（否则插件页不装 ⇒ 左下角是官方账号行，点登录走 DeepSeek ✗）');
		}
	}

	// ② 不许再出现在"有 sessionId 才装"的清单里（单一装载路径，避免双注册）
	const partAt = entry.indexOf('const PART_CHUNKS = [');
	if (partAt > 0) {
		const part = entry.slice(partAt, entry.indexOf('];', partAt));
		if (part.includes('"./client.account.js"')) {
			problems.push('client.js: `client.account.js` 不许留在 PART_CHUNKS（它已进 ALWAYS ⇒ 再留一处就是双装载 ✗）');
		}
	}

	// ③ chrome 判据：除纯聊天框以外都要装
	if (!acct.includes('const chrome = bridge.surface !== "chat" || bridge.chatOnly === false;')) {
		problems.push('client.account.js: chrome 判据必须是"除 surface=chat && chatOnly 以外都装"（只认 full ⇒ 插件页不装 ⇒ 官方账号行接管 ✗）');
	}
	// 负对照：旧的"只认 full"写法不许复活
	if (/const chrome = bridge\.surface === "full" \|\| \(bridge\.surface === "chat" && bridge\.chatOnly === false\);/.test(acct)) {
		problems.push('client.account.js: 旧判据（只认 full / chat）又回来了 ⇒ 插件页又会被排除 ✗');
	}

	if (!problems.some((p) => /ALWAYS_CHUNKS|client\.account|chrome 判据|官方账号行/.test(p))) {
		notes.push('账号行：ALWAYS_CHUNKS 无条件装载 + chrome 判据覆盖插件页（左下角不再出现官方 DeepSeek 入口）');
	}
}

// ── ⑮ 侧栏「插件」行必须被藏掉，但**只藏行**（2026-10-24 用户："移除插件 item"）──────────
//   官方 `dsh-client-ui-plugin-manager` 无条件往 `sidebar.panellist` 注册 `{ id:'plugins', order:0 }`，
//   源码里没有任何配置开关 ⇒ 只能 DOM 层隐藏；而且侧栏每次切面板都会重渲染 ⇒ 必须观察 + 重贴。
//   ⚠ 只许 `display:none` 那一颗 button：页面 / `pluginNavigation` / 设置入口都要留着（删能力 ✗）。
{
	const readSrc = (rel) => fs.readFileSync(path.join(LIB, rel), 'utf8');
	const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const nav = strip(readSrc('client.workbenchNav.js'));

	// ⚠ 断言只钉"必须包含哪几个标签"，不钉整行原文 —— 这张表是会长的
	//   （2026-10-24 起除了「插件」还要藏官方「自动化任务」⇒ 钉死整行会天天假红 ✗）
	const hiddenAt = nav.indexOf('const HIDDEN_LABELS = [');
	if (hiddenAt < 0) {
		problems.push('client.workbenchNav.js: 缺少"要藏哪几行"的白名单（HIDDEN_LABELS）✗');
	} else {
		const hiddenLine = nav.slice(hiddenAt, nav.indexOf('];', hiddenAt));
		for (const label of ['插件', '自动化任务']) {
			if (!hiddenLine.includes(`"${label}"`)) {
				problems.push(`client.workbenchNav.js: 白名单必须含「${label}」（否则侧栏那一行又露出来了 ✗）`);
			}
		}
	}
	if (!/btn\.style\.display = "none"/.test(nav)) {
		problems.push('client.workbenchNav.js: 藏行必须是 display:none 那一颗 button ✗');
	}
	if (!/querySelectorAll\("button\[aria-label\]"\)/.test(nav)) {
		problems.push('client.workbenchNav.js: 必须按 aria-label 在侧栏里找行（别用全局文本匹配，会误伤正文 ✗）');
	}
	if (!/new MutationObserver\(schedule\)/.test(nav)) {
		problems.push('client.workbenchNav.js: 必须有 MutationObserver 重贴（侧栏重渲染会把 display:none 覆盖掉 ✗）');
	}
	if (!/Math\.max\(0, 200 - \(now - lastRun\)\)/.test(nav)) {
		problems.push('client.workbenchNav.js: 重贴必须节流（侧栏 DOM 变动频繁，不节流会拖慢输入 ✗）');
	}
	// 负对照：不许把行**删掉**（节点被 React 重建 / 会打乱 key，用 display:none 才稳）
	if (/aria-label[\s\S]{0,120}\.remove\(\)/.test(nav)) {
		problems.push('client.workbenchNav.js: 不许 remove() 那一行（React 会重建、易打乱兄弟节点；用 display:none ✗）');
	}

	// ⑥ 隐藏了官方「自动化任务」行 ⇒ 必须**有人**承接能力；但承接者从 2026-11-03 起换人了：
	//   插件清单（`vssaros-scheduler` 的 `vssaros.workbench`）自己注册了同名工作台 + 图标
	//   ⇒ chat-surface 这条老入口必须 `hidden: true`（否则两个「自动化任务」入口会开出两个 IDE 页签，
	//     用户报过："为什么会有两个自动化任务页签"）。
	//   ⚠ 条目本身**不能删**：它同时是 route 白名单（`itemByRoute()`）与"已注册工作台"的去重判据。
	const schedulerItem = /\{ id: "vssaros-wb-scheduler", name: "([^"]+)", ico: "[^"]*", route: "\/x\/scheduler\/"(, hidden: true)? \}/.exec(nav);
	if (!schedulerItem) {
		problems.push('client.workbenchNav.js: DEFAULT_ITEMS 缺 vssaros-wb-scheduler（route 白名单 + 已注册工作台去重都靠它 ✗）');
	} else if (schedulerItem[1] !== '自动化任务') {
		problems.push(`client.workbenchNav.js: 页签名必须是「自动化任务」（实际「${schedulerItem[1]}」）—— 与工作台标题/清单三处同值 ✗`);
	} else if (!schedulerItem[2]) {
		problems.push('client.workbenchNav.js: vssaros-wb-scheduler 必须 hidden: true（入口已由插件清单 vssaros.workbench 提供；留着 = 两个入口、两个同名页签 ✗）');
	}

	if (!problems.some((p) => /HIDDEN_LABELS|display:none|aria-label|MutationObserver|节流|remove\(\)|vssaros-wb-scheduler/.test(p))) {
		notes.push('侧栏：隐藏官方「插件」「自动化任务」行（display:none + MutationObserver 节流重贴；只藏行、不删能力；自动化任务由工作台承接）');
	}
}

// ── ⑦ 设置分区壳必须用 `renderSlot` 渲染子槽（2026-10-27 真机事故）──────────────
//
// `client.channel.js` 第一版把分区内容写成 `props.children` ⇒ **导航项在、内容全空**
// （用户截图：「设置 → 渠道」点开是白板）。dsh 的 slots 不会把子槽当 children 传进来，
// 必须显式 `props.renderSlot(<子槽>, {})` —— 当时唯一的可参照实现是 `client.market.js`
// 的 `WorkbenchSection`，我没有逐字对齐就写了自己的版本，于是踩了这个坑。
//
// 判据：凡是声明了 `children: { <槽>: ... }` 的分区，其组件体必须调用 `renderSlot(`。
{
	for (const f of fs.readdirSync(LIB)) {
		if (!/^client\..*\.js$/.test(f)) { continue; }
		const src = fs.readFileSync(path.join(LIB, f), 'utf8');
		// 声明了子槽？（⚠ 不能写成 `children:\s*\{[^}]*\}\s*,` —— children 里还有一层嵌套花括号，
		//   `[^}]*` 会在内层 `}` 处停住 ⇒ 永远判不出"声明了子槽" ⇒ 这条守卫空转）
		const declaresChild = /children\s*:\s*\{/.test(src);
		if (!declaresChild) { continue; }
		const delegatesOfficialRow = f === 'client.workspaces.js' && /slotProps:\s*props/.test(src)
			&& /renderSlot\s*\(/.test(fs.readFileSync(path.join(LIB, '../src/sessionRow.js'), 'utf8'));
		if (!/renderSlot\s*\(/.test(src) && !delegatesOfficialRow) {
			problems.push(`${f}: 声明了 settings.section 的 children 但没有调用 \`props.renderSlot(...)\` `
				+ '⇒ 设置页里会出现"导航项在、内容空白"（2026-10-27 真机踩过；参照 client.market.js 的 WorkbenchSection）');
		}
	}
}

// ── ⑯ 空白会话屏也必须装「多根工作区侧栏」（2026-10-27 真机）──────────────────
//   用户截图：窗口模式下侧栏工作区是**官方平铺列表**（Saros-switch / vssaros-homepage / …），
//   没有我们的「一行 + N 个根」多根条目。同一时刻 `page surface` 自证 `sessionId=null`
//   ⇒ 页面停在空白会话屏 ⇒ 只装 BLANK_SESSION_PARTS ⇒ 这支 chunk 压根没 require ✗。
//   `client.workspaces.js` 只注册 `sidebar.workspaces`（priority -10）+ 读 workspaces/sessions
//   快照，**完全不依赖会话**；而"没有会话"恰恰是用户最需要先看到工作区列表去选一个的时刻 ⇒
//   必须在 BLANK_SESSION_PARTS 里。
{
	const readSrc = (rel) => fs.readFileSync(path.join(LIB, rel), 'utf8');
	const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const entry = strip(readSrc('client.js'));
	const wsChunk = strip(readSrc('client.workspaces.js'));

	const blankAt = entry.indexOf('const BLANK_SESSION_PARTS = [');
	if (blankAt < 0) {
		problems.push('client.js: 找不到 BLANK_SESSION_PARTS（空白会话屏装哪些部件无处判定）✗');
	} else {
		const blank = entry.slice(blankAt, entry.indexOf('];', blankAt));
		if (!blank.includes('"./client.workspaces.js"')) {
			problems.push('client.js: `client.workspaces.js` 必须在 BLANK_SESSION_PARTS 里'
				+ '（否则没绑到会话时侧栏退回官方平铺列表 ⇒ 多根工作区看不到，2026-10-27 真机 ✗）');
		}
	}

	// 它凭什么是"不依赖会话"的：必须只遮蔽 sidebar.workspaces，且 install 里不读 sessionId 做门控
	if (!/ctx\.slots\.inject\(SLOT,/.test(wsChunk) || !/priority: -10/.test(wsChunk)) {
		problems.push('client.workspaces.js: 必须 inject + register 到 sidebar.workspaces（priority -10 遮蔽官方）✗');
	}
	if (/bridge\.sessionId\s*\)\s*\{?\s*return/.test(wsChunk)) {
		problems.push('client.workspaces.js: 不许用 bridge.sessionId 做早退（它本来就该在没有会话时也渲染 ✗）');
	}

	if (!problems.some((p) => /BLANK_SESSION_PARTS|client\.workspaces/.test(p))) {
		notes.push('空白会话屏也装多根工作区侧栏（侧栏不再退回官方平铺列表）');
	}
}

// ── ⑯-b 空白会话屏也必须装「会话视图 chunk」（2026-11-10 真机）────────────────────
//   用户截图：hero 下点 Bots→编辑 Bot ⇒ 右栏没有设置页签，中栏却多出「Bot 配置 · X」并报
//   「当前不可用：可能还在加载、已被卸载，或安装后还没重启 Harness」。两个症状是**同一个根因**：
//   `client.conversationViews.js` 不在 BLANK_SESSION_PARTS ⇒ hero（bridge.sessionId 为空）
//   入口只走 BLANK_SESSION_PARTS ⇒ 这个 chunk 连 require.async 都没发生 ⇒
//     (a) factory 顶层 `__vssarosPageComponents[BOT_CONFIG_PAGE_COMP]` 没登记 ⇒ 中栏按 comp 查表失败；
//     (b) install() 里 installRightBotSettings / installRightRoomSettings 没跑 ⇒
//         window.__vssarosOpenRightBotSettings 不存在 ⇒ 菜单回落中栏独立页。
//   rebind() 用 PART_CHUNKS.filter(f => BLANK_SESSION_PARTS.indexOf(f) < 0) 去重 ⇒ 不会重复 install。
{
	const readSrc = (rel) => fs.readFileSync(path.join(LIB, rel), 'utf8');
	const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const entry = strip(readSrc('client.js'));
	const cvSrc = strip(readSrc('client.conversationViews.js'));
	const blankAt = entry.indexOf('const BLANK_SESSION_PARTS = [');
	const blank = blankAt >= 0 ? entry.slice(blankAt, entry.indexOf('];', blankAt)) : '';
	if (!/bridge\.sessionId\s*\?\s*PART_CHUNKS\s*:\s*BLANK_SESSION_PARTS/.test(entry)) {
		problems.push('client.js: 找不到 hero 装载分流（sessionId 为空 ⇒ BLANK_SESSION_PARTS）✗');
	}
	if (!blank.includes('"./client.conversationViews.js"')) {
		problems.push('client.js: `client.conversationViews.js` 必须在 BLANK_SESSION_PARTS 里'
			+ '（否则 hero 下右栏 Bot/群设置 API 与中栏组件登记全部缺席 ⇒ 编辑 Bot 只开出「当前不可用」页签，2026-11-10 真机 ✗）');
	}
	// 该 chunk 一装载就要同时恢复两个承载面，不许只修一半
	if (!/__vssarosPageComponents\[BOT_CONFIG_PAGE_COMP\] = BotConfigPage/.test(cvSrc)) {
		problems.push('client.conversationViews.js: factory 顶层必须登记中栏 Bot 配置组件 ✗');
	}
	if (!/w\.__vssarosOpenRightBotSettings = openRight/.test(cvSrc)
		|| !/installRightBotSettings\(ctx\)/.test(cvSrc) || !/installRightRoomSettings\(ctx\)/.test(cvSrc)) {
		problems.push('client.conversationViews.js: install() 必须挂右栏 Bot/群设置 open API ✗');
	}
}

// ── ⑰ 页签面板不许出现"整片空白"（2026-10-28 用户报「会话窗口显示空」）────────────
//   现场：点页签后中栏纯黑。实测（CDP 驱动 WebContentsView）页面其实**加载完成、内容都在**
//   （skills 页 innerText 15986 字符）⇒ 空白是**尺寸**问题：面板根节点靠 `height:100%` 继承
//   父高度，而官方 `main` 槽的 keyed 面板外层不保证是确定高度 ⇒ 根 0 高 ⇒ iframe 全 0 高。
//   ⇒ 根节点必须"双保险"（flex 拉伸 + height:100%），并带兜底 + 诊断锚点（下次复现能取证）。
{
	const readSrc = (rel) => fs.readFileSync(path.join(LIB, rel), 'utf8');
	const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const nav = strip(readSrc('client.workbenchNav.js'));

	// ⚠ 用**属性写法**当锚点：文件里另有 `querySelector('[data-vssaros-wb-tabs]')`（探针），
	//   用裸名会切错位置（第一版就这么假红 ✗）。
	const panelAt = nav.indexOf('"data-vssaros-wb-tabs": "1"');
	if (panelAt < 0) {
		problems.push('client.workbenchNav.js: 找不到页签面板根节点（data-vssaros-wb-tabs）✗');
	} else {
		// 取根节点那段 style（往前 600 字符内应包含 style 定义）
		const around = nav.slice(Math.max(0, panelAt - 600), panelAt);
		if (!/flex:\s*"1 1 auto"/.test(around)) {
			problems.push('client.workbenchNav.js: 页签面板根节点必须带 `flex:"1 1 auto"`'
				+ '（只给 height:100% ⇒ 父级没有确定高度时整片空白，2026-10-28 真机 ✗）');
		}
		if (!/height:\s*"100%"/.test(around)) {
			problems.push('client.workbenchNav.js: 页签面板根节点必须保留 `height:"100%"`（父级非 flex 时靠它 ✓）');
		}
		if (!/minHeight:\s*0/.test(around)) {
			problems.push('client.workbenchNav.js: 页签面板根节点必须 `minHeight:0`（否则 flex 子项被内容撑破/算 0 ✗）');
		}
	}

	// 兜底：量到高度异常 ⇒ 给最小高度 + 留诊断（不许只静默）
	if (!/__vssarosWbPanelDiag/.test(nav)) {
		problems.push('client.workbenchNav.js: 必须有面板高度诊断（`window.__vssarosWbPanelDiag`）'
			+ '⇒ 下次报"空白"时才能一键取证，不用再靠猜 ✗');
	}
	if (!/rect\.height < 40/.test(nav) || !/minHeight = "240px"/.test(nav)) {
		problems.push('client.workbenchNav.js: 高度异常（<40px）必须有最小高度兜底（否则用户看到纯空白 ✗）');
	}
	if (!/getBoundingClientRect\(\)/.test(nav)) {
		problems.push('client.workbenchNav.js: 兜底必须真的量一次尺寸（凭空设最小高度是瞎猜 ✗）');
	}

	if (!problems.some((p) => /页签面板|__vssarosWbPanelDiag|最小高度/.test(p))) {
		notes.push('页签面板尺寸兜底（flex + height:100% 双保险；异常时最小高度 + 诊断锚点）');
	}
}

// ── ⑱ 侧栏点会话：失败必须重试 + 就地可见（2026-10-28 用户报「点会话没打开」）──────
//   现场：桌面窗口里点工作区下的会话行，界面毫无变化。原代码只调一次 `openSession`，
//   失败时 `notify(warn)` —— 而窗口模式**没有宿主桥**（bridge.notify 空转）⇒ 100% 静默 ✗。
//   而 `unknown session` / `is released` 是**预期内瞬时态**（主包 navigate 对这两种会 retain +
//   轮询重试），侧栏这条一次性路径从不重试 ⇒ 第一次撞上就永久打不开。
{
	const readSrc = (rel) => fs.readFileSync(path.join(LIB, rel), 'utf8');
	const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const ws = strip(readSrc('client.workspaces.js'));

	// ⚠ 定位用**前缀**（不许钉死整个参数表）：2026-10-28 高亮修复给 openSession 加了第三个参数
	//   （setCurrent = 乐观高亮回调）⇒ 原来的整串字面量会突然找不到 ⇒ 守卫假红 ✗。
	const at = ws.indexOf('const openSession = (sid, setMsg');
	if (at < 0) {
		problems.push('client.workspaces.js: 找不到 `openSession(sid, setMsg…)`（点会话的入口）✗');
	} else {
		const body = ws.slice(at, ws.indexOf('const makeSayer = ', at));
		if (!/RETRY_DELAYS/.test(body) || !/setTimeout\(attemptOpen/.test(body)) {
			problems.push('client.workspaces.js: 打开会话失败必须**退避重试**'
				+ '（unknown session / is released 是瞬时态，一次失败就放弃 = 永久打不开，2026-10-28 真机 ✗）');
		}
		if (!/retain\(sid\)/.test(body)) {
			problems.push('client.workspaces.js: 重试前必须 `sessions.retain(sid)` 拿回引用（会话被 release 时 openSession 必失败 ✗）');
		}
		if (!/say\(/.test(body) || !/setMsg\(text \?/.test(body)) {
			problems.push('client.workspaces.js: 失败必须**就地渲染**（窗口模式没有宿主桥 ⇒ 只 notify 等于静默 ✗）');
		}
		// ★ 2026-10-28（高亮不同步）：点会话必须**乐观高亮**（官方导航要几百毫秒才落地），
		//   而且真打不开时要**撤回**（否则会一直亮着一条没打开的会话 ✗）。
		if (!/setCurrent\(sid\)/.test(body)) {
			problems.push('client.workspaces.js: 点会话必须**乐观高亮**（setCurrent(sid)）—— 否则官方导航落地前高亮不动 ✗');
		}
		if (!/setCurrent\(null\)/.test(body)) {
			problems.push('client.workspaces.js: 打不开必须**撤回乐观高亮**（setCurrent(null)）—— 否则会亮着一条没打开的会话 ✗');
		}
		if (!/unknown session\|is released\|not found\|no such/.test(body)) {
			problems.push('client.workspaces.js: 必须只对**瞬时**错误重试（无脑重试会把真错误也拖成 3 次 ✗）');
		}
	}

	// 两个渲染分支（分组 / 平铺）都必须经**同一个** `renderSessions(row)`（分页也收口在那里）。
	// ★ 2026-10-30：分页统一后 `renderSessionRow` 只该有**一处**调用（在 `renderSessions` 里）——
	//   两处各写一份必然漂（一侧有分页、另一侧没有）。
	const listCalls = ws.match(/isOpen \? renderSessions\(row\) : null/g) || [];
	const rowCalls = ws.match(/renderSessionRow\(s, setWsMsg, setLocalCurrent\)/g) || [];
	if (listCalls.length < 2) {
		problems.push(`client.workspaces.js: 两个渲染分支都要经 \`renderSessions(row)\`（实际 ${listCalls.length} 处）✗`);
	}
	if (rowCalls.length !== 1) {
		problems.push(`client.workspaces.js: \`renderSessionRow\` 只允许在 \`renderSessions\` 里调一次（实际 ${rowCalls.length} 处）—— 两处各写一份会漂 ✗`);
	}
	{
		const at = ws.indexOf('const renderSessionRow = ');
		// ⚠ 切到**下一个函数**为止，不要用固定字符窗口：行渲染会随 UI 迭代变长，
		//   固定 4000 字符会在改动后把 `openSession(...)` 切出窗口 ⇒ 假红（2026-11-02 踩过 ✗）。
		const endAt = at < 0 ? -1 : ws.indexOf('const renderSessions = ', at);
		const rowBody = at < 0 ? '' : ws.slice(at, endAt > at ? endAt : at + 8000);
		if (at < 0) {
			problems.push('client.workspaces.js: 缺 `renderSessionRow`（两处会话行必须共用同一个渲染实现 ✗）');
		} else if (!/openSession\(s\.id, setMsg, setLocal\)/.test(rowBody)) {
			problems.push('client.workspaces.js: 会话行 onClick 必须传就地提示通道（`openSession(s.id, setMsg, setLocal)`；不传就还是静默 ✗）');
		}
	}

	if (!problems.some((p) => /openSession|打开会话|session\.retain/.test(p))) {
		notes.push('点会话：瞬时错误 retain + 退避重试，失败就地可见（窗口模式不再静默）');
	}
}

// ── ⑲ blank 判据不许把 hero 的输入框当成"已有会话"（2026-10-28）──────────────
//   现场自证：`attempts=0 / opened=false / heroVisible=true / composer=true` ⇒ 主包轮询
//   每轮都在 `!looksBlankPage()` 处早退，**navigate 一次都没发** ⇒ 会话永远停在 hero，
//   侧栏点会话也只走一次性 openSession。根因就是 blank 判据里含 `[data-composer-card]`，
//   而 hero 本身就有输入框 ⇒ 恒判"非空白"。
{
	const readSrc = (rel) => fs.readFileSync(path.join(LIB, rel), 'utf8');
	const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const entry = strip(readSrc('client.js'));
	const at = entry.indexOf('const looksBlankPage = () => {');
	if (at < 0) {
		problems.push('client.js: 找不到 `looksBlankPage`（救援轮询的"要不要抢"判据）✗');
	} else {
		const body = entry.slice(at, entry.indexOf('};', at));
		if (/data-composer-card/.test(body)) {
			problems.push('client.js: `looksBlankPage` 不许含 `[data-composer-card]`'
				+ '（hero 本身有输入框 ⇒ 恒判"非空白" ⇒ 轮询永不发起，2026-10-28 真机 attempts=0 ✗）');
		}
		for (const marker of ['data-sidebar-right-session', 'data-chat-flow', 'data-chat-anchor-key']) {
			if (!body.includes(marker)) {
				problems.push(`client.js: \`looksBlankPage\` 必须包含「${marker}」（会话真的在渲染的证据）✗`);
			}
		}
	}

	if (!problems.some((p) => /looksBlankPage|composer-card/.test(p))) {
		notes.push('blank 判据只认"会话在渲染"（hero 的输入框不再让轮询瘫痪）');
	}
}

// ── ⑧ 渠道页的平台判据必须来自服务端定义（2026-10-28）───────────────────────────
//   事故：绑定页把平台列表写死成 loopback + feishu ⇒ telegram / discord / 企业微信选不到；
//   渠道页把「传输方式 / 有没有启动入站」按 key 硬编码 ⇒ discord 那行没有传输说明、
//   企业微信（被动回调）多出一个必然 400 的「启动入站」，状态永远「未启动」。
//   ⇒ 两条约束：传输文案只读 `def.inboundLabel`，启停按钮只由 `startableOf(def)` 决定。
{
	const chSrc = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'client.channel.js'), 'utf8');
	if (!/def\.inboundMode === "callback"/.test(chSrc)) {
		problems.push('client.channel.js 没按 def.inboundMode 处理「被动回调」⇒ 企业微信会显示「未启动」并给出必然 400 的「启动入站」✗');
	}
	if (!/function startableOf\(def\)/.test(chSrc) || !/startableOf\(def\) && ch\.configured/.test(chSrc)) {
		problems.push('client.channel.js 的启停按钮没走 startableOf(def) ⇒ 又在按 key 硬编码，再加渠道就会错位 ✗');
	}
	if (!/def\.inboundLabel/.test(chSrc)) {
		problems.push('client.channel.js 的传输方式没读 def.inboundLabel ⇒ 新渠道那行的工具栏没有传输说明 ✗');
	}
	/* ★ 2026-11-09（用户报「渠道 → 绑定 → 去 Bots 配置 ⇒ 白屏」）：Bots 的 SSR 工作台已下线，
	   整页导航过去只会拿到 404。交接必须走 vssaros:open-bots 事件 + handled 兜底指引。
	   ⚠ 别把 API 前缀 /x/agents/api/* 一起禁掉：它仍由 agents 插件提供。 */
	if (/window\.location\.(assign|replace)\(|window\.location\.href\s*=/.test(chSrc) || /BOTS_ROUTE/.test(chSrc)) {
		problems.push('client.channel.js: 「去 Bots 配置」不能再整页导航到已下线的 Bots 工作台（404 白屏），改走 vssaros:open-bots ✗');
	}
	/* ⚠ 断言要钉**调用形态**（`setBotsHint(detail.handled`），只搜 `detail.handled` 会被注释命中
	   ⇒ 反向突变（把判断改掉）时守卫假绿。 */
	if (!/new window\.CustomEvent\("vssaros:open-bots"/.test(chSrc) || !/setBotsHint\(detail\.handled/.test(chSrc)) {
		problems.push('client.channel.js: 「去 Bots 配置」必须派发 vssaros:open-bots 并按 handled 给就地兜底指引（不静默）✗');
	}
	if (!/"data-vssaros-channel-open-bots"/.test(chSrc)) {
		problems.push('client.channel.js: 「去 Bots 配置」按钮缺锚点 data-vssaros-channel-open-bots ✗');
	}
	/* ★ 2026-11-09（用户报「点保存没反馈，输入的 App ID / Secret 没地方看」）：
	   ① channels[] 是 describePlatforms() 的掩码视图 ⇒ 非 secret 字段在 fields 对象里；
	      旧 UI 读兼容视图的 appIdMasked ⇒ 恒空 ⇒ 配好了也看不到。
	   ② 保存结果必须在**凭据卡内**就地渲染（全局 ok/error 在页面最底部 = 看着没反应）。
	   ③ secret 明文永不回传，只报「已配置」。
	   ⚠ 断言钉代码形态（注释里也讲过这些名字 ⇒ 别用宽泛的 includes）。 */
	if (/ch\.appIdMasked/.test(chSrc)) {
		problems.push('client.channel.js: 不能读 ch.appIdMasked（channels[] 里没这个字段 ⇒ App ID 永远显示为空）✗');
	}
	if (!/function credsSummaryOf\(view, defFields\)/.test(chSrc) || !/String\(fields\[f\.key\] \|\| ""\)/.test(chSrc)) {
		problems.push('client.channel.js: 凭据回显必须读 describePlatforms 的 fields 掩码视图 ✗');
	}
	if (!/onResult\(\{ ok: true, view: j \}\)/.test(chSrc) || !/"data-vssaros-channel-creds-result": fb\.status/.test(chSrc)) {
		problems.push('client.channel.js: 保存凭据必须把 POST 回包转成**凭据卡内**的就地反馈（不能只在页面底部）✗');
	}
	if (!/"data-vssaros-channel-creds-current": "1"/.test(chSrc) || !/"data-vssaros-feishu-app-result": appFeedback\.status/.test(chSrc)) {
		problems.push('client.channel.js: 缺「当前生效值」或额外飞书应用的就地反馈锚点 ✗');
	}
	if (!/明文不回显/.test(chSrc)) {
		problems.push('client.channel.js: 必须写明 Secret 只报「已配置」、明文不回显 ✗');
	}
	if (!problems.some((p) => /inboundMode|startableOf/.test(p))) {
		notes.push('渠道页：传输方式/可启停判据读 imPlatforms 的 inboundMode/inboundLabel（不按 key 硬编码）');
	}
	if (!problems.some((p) => /client\.channel\.js.*(open-bots|404 白屏)/.test(p))) {
		notes.push('渠道页「去 Bots 配置」走 vssaros:open-bots 交接（旧 SSR 页是 404 白屏）');
	}
	if (!problems.some((p) => /client\.channel\.js.*(creds|就地反馈|appIdMasked|明文)/.test(p))) {
		notes.push('渠道页凭据：保存就地反馈 + 掩码值回显（Secret 只报已配置，不回明文）');
	}
	/* ★ 2026-11-09：设置弹窗「渠道」页签整体下线，能力迁到 Bot 设置页的「飞书配置」卡。
	   文件仍留在 ALWAYS_CHUNKS（删清单会拖垮同批 9 个 chunk），但绝不能再注册分区。 */
	if (/ctx\.slots\.inject\(SLOT_SECTION/.test(chSrc)) {
		problems.push('client.channel.js: 「渠道」页签已下线，不许再注册 settings.section 分区 ✗');
	}
}

// ── ⑳ 消息底部「导入知识库」按钮：用**真实 DOM 锚点**（2026-10-29 真机）────────────────
// 起因：原先用 [class*="copyButton"] 找官方复制钮 —— 那是**终端块**的类名；
//   消息底栏实测是 <button class="xzv4MW_action" aria-label="复制">，行内还有
//   <span class="xzv4MW_endInfo">用量 … tok</span> ⇒ 老选择器命中 0 个 ⇒ 按钮**从未出现**。
{
	try {
		const src = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'dsh-plugins', 'vssaros-chat-surface', 'lib', 'client.msgImport.js'), 'utf8');
		// ★ 2026-10-29（用户要求：导入落盘在 库/raw）：落点 + 请求体都要钉住。
		//   （真机踩过：按行替换时把 body 那行覆盖成了注释 ⇒ POST 变成无参 ⇒ 导入静默失败）
		if (!/dir: ["']库\/raw["']/.test(src)) {
			problems.push('client.msgImport.js: 导入落点不是 库/raw（应为 库/raw）');
		}
		// 只看真正的 `dir:` 参数（注释里提到「笔记/导入」不算 ⇒ 否则误伤）
		if (/dir:\s*["']笔记\/导入/.test(src)) {
			problems.push('client.msgImport.js: 还在落「笔记/导入」');
		}
		// ★ 2026-10-29（用户要求：统一命名 对话导入-<时间戳>.md）
		if (!/const title = '对话导入-' \+ stamp/.test(src)) {
			problems.push('client.msgImport.js: 导入文件名不是「对话导入-<时间戳>」');
		}
		if (!src.includes('function stampOf(')) {
			problems.push('client.msgImport.js: 缺 stampOf（时间戳生成）');
		}
		// 取文必须用 textContent：innerText 在**隐藏视图**里恒为空 ⇒ 按钮不注入 / 导入为空
		if (/innerText/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))) {
			problems.push('client.msgImport.js: 代码里还在用 innerText（隐藏视图里恒为空 ⇒ 取文会失败）');
		}
		if (!src.includes('body: JSON.stringify({ vaultId:')) {
			problems.push('client.msgImport.js: 请求体那行不见了（body 行被改坏 ⇒ POST 无参）');
		}
		if (!src.includes('button[aria-label="复制"]')) {
			problems.push('client.msgImport.js: 没有用真实底栏锚点（button[aria-label="复制"]）⇒ 按钮永远注入不到');
		}
		if (!src.includes('endInfo')) {
			problems.push('client.msgImport.js: 缺少 endInfo 判据（消息底栏标志）⇒ 会误注入到非底栏的行');
		}
		if (/querySelectorAll\('\[class\*=\"copyButton\"\]'\)/.test(src)) {
			problems.push('client.msgImport.js: 还在用 copyButton 选择器（那是终端块的类名，消息底栏没有）');
		}
	} catch (e) {
		problems.push('client.msgImport.js: 读不到源文件 — ' + String((e && e.message) || e));
	}
}
// ── ㉑ 侧栏「会话 / Bots」页签（2026-11-02；★ 2026-11-03 群聊与 Bots 工作台下线后收敛）──────
// 现在只剩：侧栏「会话 / Bots」两个页签 + Bots 页签列 bot 名册（点 bot ⇒ 中栏开它的会话）。
// 已下线、必须保持消失的东西（反向断言，复活即红）：右上角 Bot ⚙ / 右侧栏 Bot 设置面板 /
//   点群聊开中栏群页签（openGroup / agents.groupChat / ?embed=1 群路由）。
{
	try {
		const root = path.resolve(import.meta.dirname, '..');
		const libDir = path.join(root, 'dsh-plugins', 'vssaros-chat-surface', 'lib');
		const ws = fs.readFileSync(path.join(libDir, 'client.workspaces.js'), 'utf8');
		const cv = fs.readFileSync(path.join(libDir, 'client.conversationViews.js'), 'utf8');
		/* ★ 2026-11-10（用户决定）：飞书应用选择并入 Channel 绑定卡，独立「飞书配置」卡移除。
		   ⚠ 反向断言钉住「已移除」，防止有人把那张卡加回来。 */
		if (/function FeishuConfigCard\(props\)/.test(cv) || /data-vssaros-feishucfg/.test(cv)
			|| /react\.createElement\(FeishuConfigCard,/.test(cv)) {
			problems.push('client.conversationViews.js: 独立「飞书配置」卡已移除，应用选择并入 Channel 绑定卡 ✗');
		}
		if (!/Array\.isArray\(data\.feishuApps\)/.test(cv) || !/select\("appId", form\.appId, appOptions\)/.test(cv)
			|| !/"data-vssaros-botbind-add-app": "1"/.test(cv)
			|| !/const createBody = \(appIdOverride\)/.test(cv) || !/await addApp\(\)/.test(cv)) {
			problems.push('client.conversationViews.js: Channel 绑定卡缺飞书应用选择 / 新增应用与创建绑定一步衔接 ✗');
		}
		/* ★ 2026-11-10 真机「选了添加新应用后点创建绑定没反应」：不许再静默禁用创建按钮。
		   ⚠ 断言钉**定义行本身**：只搜 `createDisabled || (...)` 抓不到旧写法（旧代码还没这个变量，
		     __new__ 直接写在 disabled 表达式里 ⇒ 反向突变假绿，已吃过一次亏）。 */
		const createDisabledExpr = /const createDisabled = ([^;]*);/.exec(cv)?.[1] ?? '';
		if (!createDisabledExpr || createDisabledExpr.includes('__new__')
			|| !/disabled: createDisabled/.test(cv) || !/title: createDisabled \?/.test(cv)) {
			problems.push('client.conversationViews.js: 「创建绑定」在选了添加新应用时不能静默禁用，禁用态也要有可见原因 ✗');
		}
		if (!/这是当前默认应用/.test(cv)) {
			problems.push('client.conversationViews.js: 新增应用要预检默认应用（否则用户填完才吃到 409）✗');
		}
		/* ★ 2026-11-11（用户要求）：下拉首项统一叫「默认应用」，不再使用废弃的内置应用名。 */
		if (!/label: "默认应用"/.test(cv) || /默认飞书应用（跟随全局凭据）/.test(cv)) {
			problems.push('client.conversationViews.js: 默认飞书应用应显示为「默认应用」，旧文案不许复活 ✗');
		}
		/* ★ 2026-11-10 用户报「Bots 页签 bot / 群行选中态不明显」：
		   bot 行原来完全没有选中态；群行只有被主题吞掉的一层 bg-layer-2 浅底。
		   ⇒ 两者统一走注入 CSS 的双重编码（亮底 + 2px 品牌竖条 + 亮边 + 600 字重），
		     hover 只用弱底；判据层 isRoomSelected / data-vssaros-room-selected 一字不动。 */
		for (const [needle, why] of [
			['className: "vssaros-ws-bots-row"', 'bot / 群行必须挂同款选中态类（内联 style 表达不了 hover）'],
			['.vssaros-ws-bots-row[data-selected=', '必须有 data-selected 的选中态 CSS 规则'],
			['inset 2px 0 0 var(--dsw-alias-brand-primary', '选中行必须有 2px 品牌色左竖条（不依赖色觉的第二重编码）'],
			['data-vssaros-bot-selected', 'bot 行必须有显式选中标记（原来完全没有）'],
			['function isBotSelected(', 'bot 选中态必须有纯判据（守卫可单测）'],
			['SELECTED_BOT_KEY', 'bot 选中态必须持久化'],
			['setSelectedBot(id)', '点 bot 必须写入选中态'],
			['aria-selected', '选中行必须对读屏可见'],
		]) {
			if (!ws.includes(needle)) { problems.push(`client.workspaces.js: Bots 选中态缺「${needle}」—— ${why} ✗`); }
		}
		if (/isCur \? \{ background: "var\(--dsw-alias-bg-layer-2/.test(ws)) {
			problems.push('client.workspaces.js: 群行旧的 bg-layer-2 浅底选中态不许复活（真机看不清）✗');
		}
		/* ★ 2026-11-10：Bots 页签里「有 IM 连接」的 bot item 要显示 icon。
		   判据必须来自 binding 级真源（/x/agents/api/bindings），不是猜 bot 字段；
		   图标必须内联（chunk realm 只允许 require("react")，跨 chunk 不能 import）。 */
		for (const [needle, why] of [
			['const AGENTS_API_BINDINGS = "/x/agents/api/bindings"', 'IM 连接判据要拉 binding 真源'],
			['function imBadgeOf(', '必须按 bot 聚合启用中的绑定（纯函数，守卫可断言）'],
			['imBadges: imBadges', '取数结果要带进 bots 状态'],
			['"data-vssaros-bot-im": "1"', 'bot 行必须有稳定的图标锚点'],
			['const BOT_IM_ICON_PATH', '气泡图标必须内联描边 SVG'],
		]) {
			if (!ws.includes(needle)) { problems.push(`client.workspaces.js: Bots 行 IM 图标缺「${needle}」—— ${why} ✗`); }
		}
		/* ★ 2026-11-10：群设置里增加 Channel 绑定（复用同一张卡，目标类型 group）。
		   ⚠ 后端 normalizeBinding 已放开 targetKind，这里必须显式带 group，
		     否则建出来的仍是 bot 绑定 = 群设置里的假入口。 */
		for (const [needle, why] of [
			['const targetKind = String(props.targetKind || "agent")', '绑定卡必须支持 group 目标'],
			['action: "create", targetKind: targetKind', '新建绑定要显式带目标类型'],
			['"data-vssaros-bind-kind": targetKind', '卡要有目标类型锚点'],
			['targetKind: "group", targetId: roomId', '群设置面板必须挂上群绑定卡'],
		]) {
			if (!cv.includes(needle)) { problems.push(`client.conversationViews.js: 群设置 Channel 绑定缺「${needle}」—— ${why} ✗`); }
		}
		/* ★ 2026-11-10 用户选方案 A：说明收进 ⓘ tip、绑定 item 紧凑双行、新建表单折叠。
		   ⚠ 反向断言钉住「长说明平铺 / 超长 placeholder / 单行塞全部信息」不许复活。 */
		for (const [needle, why] of [
			['data-vssaros-botbind-help', '标题旁必须有 ⓘ 说明 tip'],
			['data-vssaros-botbind-tip', '字段说明必须有短 ⓘ tip'],
			['data-vssaros-botbind-row-top', '绑定 item 行 1（身份 / 状态 / 操作）'],
			['data-vssaros-botbind-row-meta', '绑定 item 行 2（chat_id / 标签）'],
			['data-vssaros-botbind-new-toggle', '新建绑定必须默认折叠'],
			['role: "tooltip"', 'tip 富卡必须有 role=tooltip（键盘 / 读屏可达）'],
		]) {
			if (!cv.includes(needle)) { problems.push(`client.conversationViews.js: 方案 A 缺 ${needle}（${why}）✗`); }
		}
		if (cv.includes('把 IM 会话绑定到这个 Bot。只有人能创建/修改/删除绑定；入站白名单留空')) {
			problems.push('client.conversationViews.js: Channel 说明整段平铺已下线，必须收进 ⓘ tip ✗');
		}
		if (cv.includes('入站白名单（逗号分隔 userId；留空 = 拒绝所有入站')) {
			problems.push('client.conversationViews.js: 超长 placeholder 不许再承载文档（改短标签 + ⓘ tip）✗');
		}
		if (/\+ String\(b\.chatId \|\| ""\) \+ " · "/.test(cv)) {
			problems.push('client.conversationViews.js: 绑定 item 不许再把所有信息拼在一行 ✗');
		}
		/* ★ 2026-11-10 用户要求「已经绑定的 item 可展开编辑」：
		   update 是局部更新 ⇒ 只发 action/id + 允许改的字段；改完 reload() 走 GET（POST 返回值含未掩码密钥）。 */
		for (const [needle, why] of [
			['data-vssaros-botbind-edit-toggle', '已绑定 item 必须有展开编辑入口'],
			['data-vssaros-botbind-edit', '展开后的编辑面板必须有稳定锚点'],
			['setExpandedId', '同一时刻只展开一条绑定'],
			// ⚠ 钉调用形态：`data-vssaros-botbind-<key>` 是运行时拼出来的，源码里没有这个字面量
			['input("edit-chatId", ed.chatId', '编辑表单字段必须用 edit-* 锚点，与新建表单区分（否则「默认折叠」断言误判）'],
			['const editPatch = {', '编辑保存必须构造 bindings 的局部 update patch'],
		]) {
			if (!cv.includes(needle)) { problems.push(`client.conversationViews.js: 已绑定 item 编辑缺「${needle}」—— ${why} ✗`); }
		}
		if (/input\("chatId", editDraft/.test(cv)) {
			problems.push('client.conversationViews.js: 编辑表单不许复用新建表单的 chatId 锚点 ✗');
		}
		if (!ws.includes('data-vssaros-sidebar-tabs')) {
			problems.push('client.workspaces.js: 缺侧栏页签锚点 data-vssaros-sidebar-tabs ⇒ 找不到「会话 / Bots」页签');
		}
		if (!/\.map\(\(k\) =>/.test(ws) || !/\["sessions", "bots"\]/.test(ws)) {
			problems.push('client.workspaces.js: 页签不是 会话 / Bots 两个（改动会让侧栏少一页）');
		}
		if (fs.existsSync(path.join(libDir, 'client.botSettingsBtn.js'))) {
			problems.push('client.botSettingsBtn.js: 右上角 Bot ⚙ 已下线（bot 配置统一进会话「设置」页签），文件不该存在 ✗');
		}
		if (fs.existsSync(path.join(root, 'dsh-plugins', 'vssaros-agents', 'lib', 'client.botSettings.js'))) {
			problems.push('vssaros-agents/lib/client.botSettings.js: 右侧栏 Bot 设置面板已下线 ✗');
		}
		if (/openGroup|agents\.groupChat|\/x\/agents\/group\//.test(ws)) {
			problems.push('client.workspaces.js: 群聊入口（openGroup / agents.groupChat / 群页路由）已下线，不该留着 ✗');
		}
		// 设置页签（2026-11-03 用户要求：bot 配置进会话页签、放整排最右端、并入记忆设置）
		if (!/const ORDERS = \{ memory: 20, skills: 30, todo: 40, settings: 60 \};/.test(cv)) {
			problems.push('client.conversationViews.js: 「设置」页签必须 order 60（整排最右端），且不再有独立的记忆设置页签 ✗');
		}
		if (!/label: "设置"/.test(cv) || /label: "记忆设置"/.test(cv)) {
			problems.push('client.conversationViews.js: 页签文案必须是「设置」（记忆设置已并入）✗');
		}
		if (!/function BotConfigCard\(/.test(cv) || !/data-vssaros-botcfg/.test(cv)) {
			problems.push('client.conversationViews.js: 缺 Bot 配置卡（BotConfigCard / data-vssaros-botcfg）⇒ bot 配置又没地方改了 ✗');
		}
		if (!/action: "update"[\s\S]{0,120}id: agentId/.test(cv)) {
			problems.push('client.conversationViews.js: Bot 配置卡必须走 POST /x/agents/api/agents {action:"update", id} ✗');
		}
		// ★ 2026-11-09：host 回 registered:false 时不能无条件提示「已保存」
		if (!/res\.registered === false/.test(cv)) {
			problems.push('client.conversationViews.js: Bot 配置保存必须读 registered（未注册还提示「已保存」= 假成功）✗');
		}
		// ★ 2026-11-10 纠偏：中栏独立页是**回落兜底**，不再是 hero 的主承载面。
		//   真机 hero 下官方右栏「开始」页签就在 `sidebar.right.pane.tab` 里 ⇒ 该槽可用。
		if (!/function BotConfigPage\(/.test(cv)
			|| !/w\.__vssarosPageComponents\[BOT_CONFIG_PAGE_COMP\] = BotConfigPage;/.test(cv)) {
			problems.push('client.conversationViews.js: 缺 Bot 配置独立页组件/注册 ⇒ 官方右栏不可用时没有兜底 ✗');
		}
		if (!/react\.createElement\(BotConfigCard, \{ key: agentId, agentId/.test(cv)) {
			problems.push('client.conversationViews.js: Bot 配置独立页必须按 agentId 直接渲染 BotConfigCard（不依赖 sessionId）✗');
		}
		// ★ 2026-11-10 群设置 UI 复刻 DS Bot（440px 遮罩弹层 / 四档唤醒 / 头像 / 加入需确认 / 清空 / 解散）
		if (!/const WAKE_MODE_OPTIONS = \[/.test(cv) || !/data-vssaros-room-wake/.test(cv)) {
			problems.push('client.conversationViews.js: 群设置弹层必须有四档唤醒策略卡片（all/mentions/digest/silent）✗');
		}
		for (const needle of ['D.mask', 'D.dlg', 'data-vssaros-room-approval', 'data-vssaros-room-avatar',
			'data-vssaros-room-wake-count', 'data-vssaros-room-wake-interval',
			'"data-act": "room-clear"', '"data-act": "room-delete"',
			// ★ 2026-11-10：右栏页签体必须内联（embedded），只有中栏独立页继续用遮罩弹层
			'dialog: !embedded', 'embedded: true', 'width: "100%", maxWidth: "100%"']) {
			if (!cv.includes(needle)) { problems.push(`client.conversationViews.js: 群设置缺结构件 ${needle} ✗`); }
		}
		// 反向：右栏页签体不许再写死 dialog:true（否则又变成盖住整个窗口的遮罩弹层）
		{
			const at = cv.indexOf('function RightRoomSettingsPane()');
			const end = at >= 0 ? cv.indexOf('function installRightRoomSettings(', at) : -1;
			const body = at >= 0 && end > at ? cv.slice(at, end) : '';
			if (!/embedded: true/.test(body) || /dialog: true/.test(body)) {
				problems.push('client.conversationViews.js: RightRoomSettingsPane 必须传 embedded:true 且不铺遮罩弹层 ✗');
			}
		}
		if (!/data-vssaros-room-avatar-img/.test(ws)) {
			problems.push('client.workspaces.js: 侧栏群行必须优先渲染群设置里上传的头像 ✗');
		}
		// ★ 2026-11-10 用户：hero 下「群设置 / Bot 设置」都要是右栏里单独一个带 ✕ 的页签。
		//   官方两段式：sidebarRightTabs.register（类型）+ sidebar.right.pane.tab keyed body + openTab；
		//   官方 strip 自带 ✕，「开始」guide 永不关 ⇒ 天然并列。两个设置各用一个 kind 互不覆盖。
		for (const needle of ['ROOM_SETTINGS_RIGHT_KIND', 'BOT_SETTINGS_RIGHT_KIND',
			'RightRoomSettingsPane', 'RightBotSettingsPane', 'installRightBotSettings']) {
			if (!cv.includes(needle)) { problems.push(`client.conversationViews.js: 缺官方右栏页签结构件 ${needle} ✗`); }
		}
		if (!/ctx\.slots\.inject\(BOT_SETTINGS_RIGHT_SLOT/.test(cv)) {
			problems.push('client.conversationViews.js: Bot 设置必须注册到官方 sidebar.right.pane.tab keyed 槽 ✗');
		}
		if (!/w\.__vssarosOpenRightBotSettings = openRight/.test(cv)) {
			problems.push('client.conversationViews.js: Bot 设置右栏必须暴露跨 chunk 的 open/close API ✗');
		}
		if (!/data-vssaros-right-bot-settings-close/.test(cv)) {
			problems.push('client.conversationViews.js: 右栏 Bot 设置页签必须有页内 ✕ 关闭 ✗');
		}
		// 反向断言：不许退回覆盖式浮层、也不许用 mounted 预判（会盖住 strip / 误杀 hero）
		if (/id: RIGHT_BOT_DOCK_ID, order: RIGHT_BOT_DOCK_ORDER/.test(cv)) {
			problems.push('client.conversationViews.js: 不许再注册 shell.overlay 覆盖式 Bot 设置浮层（会盖住官方 strip）✗');
		}
		// ⚠ 只匹配**代码形态**（`const mounted = sr.mounted`），不要用裸 `mounted.getSnapshot()`：
		//   纠偏说明的注释里也写了这个词，裸匹配会误报。
		if (/const mounted = sr\.mounted/.test(cv)) {
			problems.push('client.conversationViews.js: 不许用 mounted.getSnapshot() 预判右栏可用性（会误杀 hero 的 blank session）✗');
		}
		{
			const at = ws.indexOf('const openBotConfig = (bot) =>');
			const end = at >= 0 ? ws.indexOf('const botDeps = {', at) : -1;
			const body = at >= 0 && end > at ? ws.slice(at, end) : '';
			const rightAt = body.indexOf('__vssarosOpenRightBotSettings');
			const pageAt = body.indexOf('__vssarosOpenPageTab');
			if (rightAt < 0 || pageAt < 0 || rightAt > pageAt) {
				problems.push('client.workspaces.js: 「编辑 Bot」必须先试官方右栏页签、再回落中栏独立页 ✗');
			}
		}
		// ★ 2026-11-09：左栏右键「编辑 Bot」要能直达 Bot 配置卡（分段落到 bot，且回填 handled）
		if (!/window\.addEventListener\("vssaros:open-bot-config", onOpenBotConfig\)/.test(cv)
			|| !/setScope\("bot"\)/.test(cv) || !/d\.handled = true/.test(cv)) {
			problems.push('client.conversationViews.js: 必须监听 vssaros:open-bot-config → setScope("bot") + 回填 handled（否则「编辑 Bot」点了只开设置页却看不到 Bot 配置）✗');
		}
		// ★ 2026-11-03（用户要求「只显示已注册的 bots」）：未注册那段不许回来 ——
		//   注册失败的 bot 点了也开不了会话（session.create 报未知 preset），列出来只是噪音。
		if (/botsSection\(\s*"未注册"/.test(ws)) {
			problems.push('client.workspaces.js: Bots 页签只显示已注册的 bot（「未注册」段不许回来）✗');
		}
		if (!/hiddenUnregistered/.test(ws)) {
			problems.push('client.workspaces.js: 未注册的 bot 要保留一句计数说明（hiddenUnregistered），不许静默消失 ✗');
		}
		/* ★ 2026-11-03（用户报「切换不同人格时没有显示欢迎页」）：欢迎页必须认**会话内人格**
		   （`vssaros-persona` 投影）—— 切人格不改 agentPreset，只看 preset 会让模式 preset 里的
		   人格切换变成空 hero。判据：effectiveAgentOf + show 走 who.source。 */
		{
			const wl = fs.readFileSync(path.join(libDir, 'client.welcome.js'), 'utf8');
			if (!/function effectiveAgentOf\(/.test(wl) || !/pv\["vssaros-persona"\]/.test(wl)) {
				problems.push('client.welcome.js: 欢迎页必须认会话内人格（vssaros-persona 投影）⇒ 否则模式 preset 里切人格是空 hero ✗');
			}
			if (!/who\.source !== "none"/.test(wl)) {
				problems.push('client.welcome.js: 是否显示要走 effectiveAgentOf 的统一结论（who.source），不许只看 preset ✗');
			}
			if (!/pickAgent\(roster, presetId, who\.agentId\)/.test(wl)) {
				problems.push('client.welcome.js: 名册匹配要带上人格 agentId（否则切人格后卡片还是原 bot 的）✗');
			}
			/* ★ 2026-11-09：/x/agents/ 的 SSR 工作台已下线（404），欢迎卡三个交接按钮
			   曾「写无读端的 localStorage 焦点键 + openModulePage」⇒ 点了静默无反应。 */
			if (wl.includes('openModulePage("/x/agents/")')) {
				problems.push('client.welcome.js: 不能再调 openModulePage("/x/agents/")（已 404），交接改走 vssaros:open-bots ✗');
			}
			if (!/new window\.CustomEvent\("vssaros:open-bots"/.test(wl) || !/detail\.handled/.test(wl)) {
				problems.push('client.welcome.js: 交接必须派发 vssaros:open-bots 并按 handled 给兜底指引（不静默）✗');
			}
		}
		/* ★ 2026-11-09：胶囊的「Agent 主页」与欢迎卡同源，旧链路同样指向已下线的 404 页
		   （2026-10-29 真机症状是「点 Agent 主页 ⇒ 弹出黑框」）。 */
		{
			const cap = fs.readFileSync(path.join(libDir, 'client.capsule.js'), 'utf8');
			if (cap.includes('openModulePage("/x/agents/")')) {
				problems.push('client.capsule.js: 不能再调 openModulePage("/x/agents/")（已 404），交接改走 vssaros:open-bots ✗');
			}
			if (!/new window\.CustomEvent\("vssaros:open-bots"/.test(cap) || !/detail\.handled/.test(cap)) {
				problems.push('client.capsule.js: 「Agent 主页」必须派发 vssaros:open-bots 并按 handled 给兜底指引 ✗');
			}
		}
		if (!problems.some((p) => /sidebar-tabs|botSettingsBtn|botSettings\.js|设置/.test(p))) {
			notes.push('侧栏「会话 / Bots」页签 + 会话视图「设置」页签（bot 配置进页签、记忆设置并入；Bot ⚙ 已删）');
		}
	} catch (e) {
		problems.push('侧栏页签 / 设置页签守卫读不到源文件：' + String((e && e.message) || e));
	}
}

// ── 结果 ────────────────────────────────────────────────────────────────
console.log('[chat-surface chunks] 我们注册的条目：');
for (const o of ourEntries) {
	console.log(`  · ${o.slot}  id=${o.id}  order=${o.order}   (${o.file})${isBaseline(o) ? '  [既有]' : ''}`);
}
// ★ 2026-11-14：notes 的打印**移到文件末尾**（下面还有很多断言块会 push notes，
//   原先在这里就打印完 ⇒ 后半段的「断言通过」提示永远看不到，守卫自证失效）。
// ★ 2026-11-11 用户选方案 B：「会话 / Bots」页签右上角悬浮角标
//   判据：① 计数纯函数行为（执行态 / 群影子会话排除 / 群轮次按 room 去重 / 未读分区）；
//         ② 角标 DOM + 注入 CSS（含窄轨降级 / reduced-motion）；
//         ③ 数据刷新链路（全局进度监听 + 快照订阅，不新增轮询）；
//         ④ 页签 overflow 必须 visible（hidden 会裁掉角标）＋ 入口 STAMP 已更新。
{
	const wsSrc = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
	const entrySrc4 = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
	const wsDoc4 = makeDocumentStub();
	const wsTest = loadChunk('client.workspaces.js', wsDoc4, makeWindowStub(wsDoc4)).exports.__test || {};
	const bad = (m) => problems.push('方案B页签角标：' + m + ' ✗');
	if (typeof wsTest.tabBadgeCounts !== 'function' || typeof wsTest.badgeNumOf !== 'function') {
		bad('缺 __test.tabBadgeCounts / badgeNumOf（守卫会空跑）');
	} else {
		const f = wsTest.tabBadgeCounts, num = wsTest.badgeNumOf;
		if (num(0) !== '' || num(3) !== '3' || num(10) !== '9+' || num(108) !== '9+') {
			bad('badgeNumOf 零值隐藏 / 9+ 溢出不对');
		}
		const snap = { byId: {
			's-a': { turnRunning: true },
			's-b': { turnBoundary: { running: true } },
			's-c': { pendingQuestions: 1 },
			's-d': { turnRunning: false },
			's-room': { turnRunning: true, projectionValues: { 'vssaros-room': { roomId: 'r1' } } },
		} };
		const active = [
			{ roomId: 'r1', status: 'replying', done: false },
			{ roomId: 'r1', status: 'sent', done: false },
			{ roomId: 'r2', status: 'done', done: true, busy: ['Coder'] },
			{ roomId: 'r3', status: 'done', done: true, busy: [] },
		];
		const c = f(snap, ['s-a', 's-c', 'r1', 'r9'], active);
		if (c.sessions.run !== 3) { bad('会话执行数必须数 running/awaiting 且排除群影子会话'); }
		if (c.bots.run !== 2) { bad('群执行数必须按 roomId 去重，后台 busy 也算执行中'); }
		if (c.sessions.unread !== 2 || c.bots.unread !== 2) { bad('未读集合必须按会话/群分区'); }
		const empty = f(null, [], []);
		if (empty.sessions.run || empty.sessions.unread || empty.bots.run || empty.bots.unread) { bad('空数据必须全 0'); }
	}
	for (const [needle, why] of [
		['"data-vssaros-tab-badge": kind', '角标必须有稳定 DOM 锚点'],
		['"data-vssaros-tab-badges": k', '两枚角标必须共用一个容器'],
		['.vssaros-ws-tab{position:relative', '角标必须相对页签按钮定位'],
		['.vssaros-ws-tab-badges{position:absolute', '角标容器必须越出页签上沿'],
		['overflow: "visible"', 'S.tabBtn 的 overflow 必须放开（hidden 会裁掉角标）'],
		['window.addEventListener(GROUP_PROGRESS_EVENT, onProgress)', '必须监听全局进度广播（不受 view 门控）'],
		['list.subscribe(() => forceBadgeTick', '必须订阅会话快照变化（running 数实时）'],
		['"data-vssaros-tab-narrow": state.workspacesWide', '窄轨态要有降级标记'],
		['@media(prefers-reduced-motion:reduce)', '角标扩散环必须尊重 reduced-motion'],
		['vssaros-ws-tab-badge-run', '执行中与未查看必须是不同形态（不只靠颜色）'],
	]) {
		if (!wsSrc.includes(needle)) { bad('缺「' + needle + '」—— ' + why); }
	}
	// ★ 2026-11-11 真机「tip UI 全黑」：`--dsw-alias-brand-primary` 在 dsh 调色板里是
	//   **主前景色**（浅色 = neutral-bluish-1000 = rgb(15,17,21) 近黑），不是品牌蓝；
	//   `--dsw-alias-label-primary` 同色 ⇒ 拿它当底色+数字色 = 黑底黑字；
	//   `--dsw-alias-warning-primary` 调色板里根本不存在 ⇒ var 无效时背景透明。
	//   ⇒ 只扫注入的 CSS 声明行（`+ "..."`），注释里提到这些名字不算数。
	const badgeCss = wsSrc.split('\n')
		.filter(l => l.trim().startsWith('+ "') && l.includes('vssaros-ws-tab-badge'))
		.join('\n');
	if (!badgeCss) { bad('找不到注入的角标 CSS 声明行 ⇒ 色值守卫会空跑'); }
	for (const [needle, why] of [
		['--dsw-alias-brand-primary-new-colorprimary-new-color', '执行中角标必须用调色板里的真品牌蓝'],
		['--dsw-alias-state-warn-primary', '未查看角标必须用调色板里存在的警示色'],
		['color:#ffffff', '彩色实底上的数字必须固定白字（跟 label-primary 会黑底黑字）'],
		['background-color:#4176e6;background-color:var(', '品牌底色必须先写固定色再写 var（变量无效时不退化成透明/黑）'],
		['background-color:#e2a03f;background-color:var(', '警示底色同样要双层降级'],
	]) {
		if (!badgeCss.includes(needle)) { bad('CSS ' + why); }
	}
	if (/--dsw-alias-warning-primary|--dsw-alias-label-primary|var\(--dsw-alias-brand-primary[,)]/.test(badgeCss)) {
		bad('角标 CSS 里还有会导致「全黑」的错误变量（brand-primary 是主前景色 / warning-primary 不存在）');
	}
	if (/font-size:0/.test(badgeCss)) { bad('窄轨态不许 font-size:0（数字藏掉就只剩一个黑点）'); }
	if (!entrySrc4.includes('方案B页签角标')) { bad('入口 CLIENT_BUILD_STAMP 未更新（chunk rev 不会变）'); }
	if (!problems.some((p) => p.startsWith('方案B页签角标：'))) {
		notes.push('方案 B 页签角标：计数纯函数 / 角标 DOM + CSS（真品牌蓝+警示色/固定白字/双层降级/数字常显）/ 全局进度监听 + 快照订阅，行为断言通过');
	}
}

// ★ 2026-11-14（真机：飞书入站会话不在工作区账本 ⇒ 角标「1 个正在执行」但列表找不到）
//   角标与列表必须共用同一份可见会话集合：tabBadgeCounts 的第 4 参来自 visibleSessionIdsOf(rows)，
//   rows 由 buildSidebar 产出。这里用真 buildSidebar 做端到端断言，不只测纯函数。
{
	const bad = (m) => problems.push('角标/列表一致性：' + m + ' ✗');
	const srcC = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
	const docC = makeDocumentStub();
	const t = loadChunk('client.workspaces.js', docC, makeWindowStub(docC)).exports.__test || {};
	if (typeof t.visibleSessionIdsOf !== 'function') {
		bad('缺 __test.visibleSessionIdsOf（守卫会空跑）');
	} else {
		const r = t.visibleSessionIdsOf([
			{ key: 'ws:a', sessions: [{ id: 's1' }, { id: 's2' }] },
			{ key: 'ws:b', sessions: [{ id: 's3' }] },
			{ key: 'ws:c', sessions: [] },
			null,
		]);
		if (!(r instanceof Set) || r.size !== 3 || !r.has('s1') || !r.has('s2') || !r.has('s3')) {
			bad('visibleSessionIdsOf 没把各行会话收敛成 id 集合（含空行容错）');
		}
		if (t.visibleSessionIdsOf(null).size !== 0) { bad('空 rows 必须得到空集合'); }
	}
	if (typeof t.tabBadgeCounts !== 'function' || typeof t.buildSidebar !== 'function') {
		bad('缺 __test.tabBadgeCounts / buildSidebar');
	} else {
		// ① 向后兼容：不传第 4 参 ⇒ 仍是全量口径（旧断言不回归）
		const snap = { byId: { s1: { turnRunning: true }, s2: { turnRunning: false }, orphan: { turnRunning: true } } };
		if (t.tabBadgeCounts(snap, [], []).sessions.run !== 2) { bad('不传 visibleIds 时必须保持全量口径'); }
		// ② 传了集合 ⇒ 只数集合内的
		const vis = t.visibleSessionIdsOf([{ sessions: [{ id: 's1' }, { id: 's2' }] }]);
		const c = t.tabBadgeCounts(snap, ['s1', 'orphan'], [], vis);
		if (c.sessions.run !== 1) { bad('visibleIds 外的 running 会话仍被计入 ⇒ 角标/列表不一致'); }
		if (c.sessions.unread !== 1) { bad('visibleIds 外的未读会话仍被计入会话角标'); }
		// ③ 真 buildSidebar：orphan 没挂任何 workspace.sessionIds ⇒ 列表无此行，角标必须 0
		const rowsC = t.buildSidebar({
			workspaces: [{ workspaceId: 'w1', path: 'C:/ws', sessionIds: ['s1', 's2'] }],
			records: [], sessionsById: snap.byId, currentSessionId: 's1', archivedIds: [],
			pinnedIds: [], orderMap: {}, deletedIds: [],
		});
		const idsC = t.visibleSessionIdsOf(rowsC);
		if (idsC.has('orphan')) { bad('buildSidebar 居然把未挂账本的会话列出来了（前提变了）'); }
		const c2 = t.tabBadgeCounts(snap, [], [], idsC);
		if (c2.sessions.run !== 1) { bad('★ 真链路：孤儿 running 会话仍让角标 +1'); }
	}
	// ④ 调用点必须把同一份 rows 传下去（不能改成读快照全量）
	if (!/tabBadgeCounts\(readSessSnapshot\(\), unreadIds, badgeActivity, visibleSessionIdsOf\(rows\)\)/.test(srcC)) {
		bad('调用点没把 visibleSessionIdsOf(rows) 传给 tabBadgeCounts');
	}
	// ⑤ 反向突变自证
	const brokenC = srcC.replace(
		'tabBadgeCounts(readSessSnapshot(), unreadIds, badgeActivity, visibleSessionIdsOf(rows))',
		'tabBadgeCounts(readSessSnapshot(), unreadIds, badgeActivity)');
	if (brokenC === srcC || /visibleSessionIdsOf\(rows\)\)/.test(brokenC)) {
		bad('反向突变脚本失效（判据无鉴别力）');
	}
	if (!problems.some((p) => p.startsWith('角标/列表一致性：'))) {
		notes.push('角标/列表一致性：真 buildSidebar 端到端 + 可见集合纯函数 + 向后兼容 + 调用点 + 反向突变');
	}
}

// ★ 2026-11-13（用户要求）：工作区右键 + 三类行键盘导航 + 删除确认层 Enter
//   判据：① nextKeyIndex 纯函数边界行为；② 结构件逐字 + 数量（右键 2 处 / Bots 行 2 处 / 确认层 3 处）；
//         ③ 真行为由 check-bots-rooms.mjs 的真 React 渲染覆盖（这里是静态防回归）。
{
	const bad = (m) => problems.push('侧栏键盘/右键：' + m + ' ✗');
	const srcK = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
	const docK = makeDocumentStub();
	const tK = loadChunk('client.workspaces.js', docK, makeWindowStub(docK)).exports.__test || {};
	if (typeof tK.nextKeyIndex !== 'function') { bad('缺 __test.nextKeyIndex（守卫会空跑）'); }
	else {
		const ids = ['a', 'b', 'c'];
		if (tK.nextKeyIndex(ids, 'a', 'ArrowDown') !== 1) { bad('↓ 必须到下一条'); }
		if (tK.nextKeyIndex(ids, 'c', 'ArrowDown') !== 2) { bad('↓ 到底不越界'); }
		if (tK.nextKeyIndex(ids, 'a', 'ArrowUp') !== 0) { bad('↑ 到顶不越界'); }
		if (tK.nextKeyIndex(ids, 'x', 'ArrowDown') !== 0) { bad('当前不在列表 ⇒ 从第一条开始'); }
		if (tK.nextKeyIndex([], 'a', 'ArrowDown') !== -1) { bad('空列表 ⇒ -1'); }
	}
	for (const [n, why] of [
		['const keyRowProps = (scope, id, open, del) => {', '必须有三类行共用的键盘 helper'],
		['const confirmKeyProps = (onConfirm) => {', '必须有三个确认层共用的 Enter helper'],
		['keyProps: keyRowProps("sessions", s.id,', '会话行适配层必须接键盘导航'],
		['...confirmKeyProps(confirmSessionDelete)', '会话删除确认必须支持 Enter'],
		['...confirmKeyProps(deleteRoom)', '群删除确认必须支持 Enter'],
		['...confirmKeyProps(deleteBot)', 'Bot 删除确认必须支持 Enter'],
		['tabIndex: -1, autoFocus: true', '确认层必须自动聚焦（Enter 才落得上）'],
		['window.addEventListener("keydown", onKeyNav, true)', '键盘必须挂 window capture（焦点被抢/宿主吞键仍生效）'],
		['keyActionsRef.current[scope + ":" + String(id)] = { open, del };', '行必须把 open/del 注册进 ref 供全局监听调用'],
		['confirmActionRef.current = onConfirm;', '确认层必须把确认动作注册进 ref'],
		['[contenteditable="true"]', '必须排除 composer / 输入框，不抢用户打字'],
		['k === "ArrowUp" || k === "ArrowDown"', '必须有 ↑↓ 判据'],
		['k === "Delete" || k === "Backspace"', '必须有 Delete 判据'],
		['if (k === "Enter")', '必须有 Enter 判据'],
		['tabIndex: 0', '行必须可聚焦（点击即选中）'],
		['"data-key-focus":', '行必须有高亮锚点'],
		['.vssaros-ws-row[data-key-focus=', '高亮必须有注入 CSS'],
		['onContextMenu: (e) => openWsMenu(key, e,', '工作区行必须绑右键菜单'],
	]) { if (!srcK.includes(n)) { bad('缺「' + n + '」—— ' + why); } }
	// ★ 2026-11-13 真机回归：旧实现把 onKeyDown 绑在行上，官方 replaceMain 重渲染把焦点
	//   抢回 body 就彻底失效。钉死「不许退回到行级 onKeyDown」。
	const kbAt = srcK.indexOf('const keyRowProps = (scope, id, open, del) => {');
	const kbEnd = srcK.indexOf('// 点外面 ⇒ 关菜单', kbAt);
	const kbBody = kbAt >= 0 && kbEnd > kbAt ? srcK.slice(kbAt, kbEnd) : '';
	if (!kbBody) { bad('定位不到键盘 helper 源码窗口 ⇒ 负断言会空跑'); }
	if (/onKeyDown:/.test(kbBody)) { bad('键盘处理不许再绑回行级 / 确认层 onKeyDown（真机焦点会被重渲染抢走）'); }
	const ctxN = (srcK.match(/onContextMenu: \(e\) => openWsMenu\(key, e,/g) || []).length;
	if (ctxN !== 2) { bad('工作区行右键必须恰好 2 处（group + flat），实际 ' + ctxN); }
	const botN = (srcK.match(/\.\.\.keyRowProps\("bots", id,/g) || []).length;
	if (botN !== 2) { bad('Bot/群行键盘必须恰好 2 处，实际 ' + botN); }
	const confN = (srcK.match(/\.\.\.confirmKeyProps\(/g) || []).length;
	if (confN !== 3) { bad('删除确认层 Enter 必须恰好 3 处（会话/群/Bot），实际 ' + confN); }
	if (!problems.some((p) => p.startsWith('侧栏键盘/右键：'))) {
		notes.push('侧栏键盘/右键：工作区两处右键 + 会话/Bot/群行 ↑↓/Enter/Delete + 三个删除确认层 Enter，断言通过');
	}
}

// ★ 2026-11-14（用户确认「执行」）：hero worktree checkbox / 输入框信息 chip / 会话行标志
//   判据：① 命名与 enable 纯函数行为；② 跨 chunk 状态契约 + 三处 DOM 锚点；
//         ③ 真跑 install ⇒ 槽注册参数 + checkbox 插到 preset chip **之前**；
//         ④ 显式桥能力探测（不许假装新建成功）；⑤ hero 态接线（BLANK_SESSION_PARTS）。
{
	const bad = (m) => problems.push('worktreeChip：' + m + ' ✗');
	const wtSrc = fs.readFileSync(path.join(LIB, 'client.worktreeChip.js'), 'utf8');
	const wsSrc5 = fs.readFileSync(path.join(LIB, 'client.workspaces.js'), 'utf8');
	const entrySrc5 = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
	const docW = makeDocumentStub();
	const winW = makeWindowStub(docW);
	const wtTest = loadChunk('client.worktreeChip.js', docW, winW).exports.__test || {};

	if (typeof wtTest.makeWorktreeName !== 'function' || typeof wtTest.buildOptions !== 'function') {
		bad('缺 __test.makeWorktreeName / buildOptions（守卫会空跑）');
	} else {
		const NAME_RE = /^(feat|fix|refactor|chore)\/[a-z0-9-]+-[0-9a-f]{4}$/;
		for (let i = 0; i < 12; i++) {
			if (!NAME_RE.test(wtTest.makeWorktreeName())) { bad('临时分支名必须符合 <type>/<kebab-slug>-<4hex> 行业惯例'); break; }
		}
		const opts = wtTest.buildOptions([{ path: '/repo/wt', name: 'wt', branch: 'fix/a' }], 'feat/temp-1234');
		if (opts.length !== 2 || !opts[0].isNew || !opts[0].ephemeral || opts[0].name !== 'feat/temp-1234') {
			bad('下拉第一项必须是默认「新增 worktree」且为临时项');
		}
		if (opts[1].isNew || opts[1].name !== 'fix/a') { bad('常驻项必须来自宿主推送且用分支名'); }
		if (wtTest.isGitEnabled([]) !== false || wtTest.isGitEnabled([{ path: '/x' }]) !== true) {
			bad('enable 判据必须按宿主推送列表是否为空');
		}
		if (wtTest.parseWorktreeOptions('{bad').length !== 0 || wtTest.parseWorktreeOptions('[{"path":"/a"},{"x":1}]').length !== 1) {
			bad('坏数据要退化成空数组、无 path 的条目要过滤');
		}
		if (wtTest.optionLabel({ isMain: true, path: '/repo' }) !== '主工作区') { bad('主工作区文案'); }
		if (wtTest.parseChip('{bad') !== null) { bad('跨 chunk 状态坏数据要退化成 null'); }
	}
	// 静态契约
	for (const [needle, why] of [
		['[data-vssaros-mode-seat="1"]', 'checkbox 必须锚在 preset chip（ModeSeat）上，才能落在工作区 chip 右侧'],
		['[data-vssaros-context-chip="1"]', '有会话页没有 ModeSeat ⇒ 必须另有工作区 chip 锚点，否则会话页永不出 checkbox'],
		['anchor.nextSibling', 'header 态 checkbox 必须插在工作区 chip 之后'],
		['insertBefore(el, anchor)', 'checkbox 必须插到 preset chip 之前'],
		['activeWorktreeOf(cwd, pushedOptions(), readChip())', '信息 chip 必须按当前会话 cwd 核对 worktree 名称'],
		['data-vssaros-wt-readonly', '信息 chip 必须是只读状态，不是开关入口'],
		['if (!active) { return null; }', '未进入 worktree 时不许显示开关占位'],
		['sessions.list.subscribe(on)', '发送后会话快照到达必须刷新实际名称'],
		['vssaros-dsh-rebind', '换绑会话后必须读取新的会话目录'],
		['const isHeroView = () => {', 'hero 判据必须有独立纯函数（用官方 ModeSeat 锚点）'],
		['if (hero) { return null; }', 'hero 空白会话屏的输入框必须不渲染 worktree chip'],
		['window.MutationObserver', '视图切换（hero → 会话页）必须响应式重判，不能只在挂载时读一次'],
		['setHero((prev) => (prev === v ? prev : v))', '视图判据不变时要 bail out，避免 observer 频繁重渲染'],
		['vssaros-wt-chip', '跨 chunk 必须有状态事件'],
		['vssarosWorktreeChip', '跨 chunk 必须有 dataset 状态键'],
		['data-vssaros-wt-checkbox', 'checkbox 必须有稳定 DOM 锚点'],
		['data-vssaros-wt-info', '输入框信息 chip 必须有稳定 DOM 锚点'],
		['data-vssaros-wt-chip-style', '样式必须幂等注入'],
		['bridge.createWorktree', '新建必须显式探测宿主能力'],
		['bridge.removeWorktree', '临时 worktree 删除必须显式探测宿主能力'],
		['不支持新建 worktree', '宿主缺 createWorktree 时必须明确提示，不许假装成功'],
		['--dsw-alias-brand-primary-new-colorprimary-new-color', '色值必须用真品牌蓝（brand-primary 是主前景色会全黑）'],
		['vssaros-dsh-worktrees', 'enable 态必须跟随宿主 worktree 推送刷新'],
		// ★ 2026-11-14 真机「hero 两枚重复 checkbox」：apply 重跑会再 install 一次
		['__vssarosWtChipSingleton', '必须有全局单例标记（apply 重跑 ⇒ loadParts 无条件再 install）'],
		['window[singletonKey]', '单例标记必须落在 window 上（跨 factory 重执行才有效）'],
		['inst.reinstalls = (inst.reinstalls || 0) + 1;', '重复 install 必须只刷新引用并计数，不重复初始化'],
		['state.vssarosWtChipReinstalls = inst.reinstalls;', '重复 install 次数必须可诊断'],
		['infoComp: InfoChip', '单例必须保存 InfoChip 供 apply 重建后重新注册槽'],
		['const b = (inst && inst.bridge) || bridge;', 'notify 必须走单例里刷新的 bridge，不发到旧桥'],
	]) {
		if (!wtSrc.includes(needle)) { bad('缺「' + needle + '」—— ' + why); }
	}
	const infoAt = wtSrc.indexOf('function InfoChip(props)');
	const infoEnd = wtSrc.indexOf('ctx.slots.inject', infoAt);
	const infoBody = infoAt >= 0 && infoEnd > infoAt ? wtSrc.slice(infoAt, infoEnd) : '';
	if (!infoBody || /role: "button"|tabIndex:|onClick:|onKeyDown:|"slides"/.test(infoBody)
		|| wtSrc.includes('vssaros-wt-chip-open')) {
		bad('输入框信息 chip 必须只读，不许回退成 worktree 开关或显示硬编码工作区名');
	}
	// 负断言：单例分支必须在**任何 DOM 注入 / 监听注册之前**提前 return，
	// 否则「只靠闭包级 hostEl 判重」的老问题会回来。
	const instAt = wtSrc.indexOf('if (typeof window !== "undefined" && window[singletonKey]) {');
	const hostAt = wtSrc.indexOf('let hostEl = null;');
	if (instAt < 0 || hostAt < 0 || instAt > hostAt) {
		bad('全局单例去重必须早于 hostEl 等闭包状态声明（否则第二个实例仍会注入第二枚 checkbox）');
	}
	if (/var\(--dsw-alias-brand-primary[,)]|--dsw-alias-warning-primary/.test(wtSrc)) {
		bad('不许用会致全黑的主前景色变量或不存在的 warning-primary');
	}
	if (!entrySrc5.includes('"./client.worktreeChip.js"')) { bad('新 chunk 没接进 PART_CHUNKS'); }
	const blank5 = (entrySrc5.match(/const BLANK_SESSION_PARTS = \[([\s\S]*?)\];/) || [])[1] || '';
	if (!blank5.includes('"./client.worktreeChip.js"')) { bad('新 chunk 没进 BLANK_SESSION_PARTS ⇒ hero 空白屏不会装载'); }
	if (!wsSrc5.includes('readWtChipBadge')) { bad('client.workspaces.js 没消费跨 chunk 状态（会话行标志会不出现）'); }
	if (!wsSrc5.includes('data-vssaros-wt-row-badge') || !wsSrc5.includes('vssaros-ws-wt-badge')) {
		bad('client.workspaces.js 必须渲染带稳定锚点的会话行 worktree 标志');
	}
	if (!wsSrc5.includes('vssaros-wt-chip')) { bad('client.workspaces.js 必须订阅跨 chunk 状态事件才能重画会话行'); }

	// 真跑 install：槽注册 + DOM 注入位置
	try {
		const regs = [];
		const anchor = makeElementStub();
		const parent = makeElementStub();
		const inserted = [];
		anchor.parentElement = parent;
		parent.insertBefore = (el, ref) => { inserted.push({ el: el, ref: ref }); };
		const docI = makeDocumentStub();
		docI.querySelector = (sel) => sel === '[data-vssaros-mode-seat="1"]' ? anchor : null;
		docI.documentElement.dataset.vssarosWorktrees = JSON.stringify([{ path: '/repo/wt', name: 'wt' }]);
		const winI = makeWindowStub(docI);
		const mod = loadChunk('client.worktreeChip.js', docI, winI).exports;
		const ctx = { slots: {
			inject: (_slot, fn) => fn(),
			register: (opts, comp) => { regs.push({ opts: opts, comp: comp }); return opts; },
		} };
		mod.install(ctx, { state: {}, bridge: { notify: () => {} } });
		const reg = regs.find(r => r.opts && r.opts.id === 'vssaros-wt-info-chip');
		if (!reg || reg.opts.name !== 'conversation.input.left' || reg.opts.order !== 1 || typeof reg.comp !== 'function') {
			bad('信息 chip 必须注册到 conversation.input.left、order 1（AgentChip 是 0，不许 tie）');
		}
		if (inserted.length !== 1 || inserted[0].ref !== anchor) {
			bad('hero checkbox 必须恰好注入一次、且插在 preset chip 之前');
		}
	} catch (e) { bad('真跑 install 抛异常：' + String((e && e.message) || e)); }

	// ★ 2026-11-14 真机回归：「有会话页两处缺 worktree chip」——会话页没有 ModeSeat，
	//   只有工作区 chip 锚点 ⇒ 必须照样注入 checkbox，且插在它**之后**（nextSibling）。
	try {
		const hAnchor = makeElementStub();
		const hParent = makeElementStub();
		const hInserted = [];
		hAnchor.parentElement = hParent;
		hAnchor.nextSibling = null;
		hParent.insertBefore = (el, ref) => { hInserted.push({ el: el, ref: ref }); };
		const docH = makeDocumentStub();
		docH.querySelector = (sel) => sel === '[data-vssaros-context-chip="1"]' ? hAnchor : null;
		docH.documentElement.dataset.vssarosWorktrees = JSON.stringify([{ path: '/repo/wt', name: 'wt' }]);
		const modH = loadChunk('client.worktreeChip.js', docH, makeWindowStub(docH)).exports;
		modH.install({ slots: { inject: (_s, fn) => fn(), register: (o) => o } },
			{ state: {}, bridge: { notify: () => {} } });
		if (hInserted.length !== 1 || hInserted[0].ref !== null) {
			bad('会话页 checkbox 必须恰好注入一次、且插在工作区 chip 之后（nextSibling）');
		}
	} catch (e) { bad('会话页 install 行为断言异常：' + String((e && e.message) || e)); }

	// 跨 chunk 状态读取（client.workspaces.js）
	try {
		const docR = makeDocumentStub();
		docR.documentElement.dataset.vssarosWorktreeChip = JSON.stringify({ name: 'feat/temp-1234', path: '/w', ephemeral: true });
		const t5 = loadChunk('client.workspaces.js', docR, makeWindowStub(docR)).exports.__test || {};
		const got = typeof t5.readWtChipBadge === 'function' ? t5.readWtChipBadge() : null;
		if (!got || got.name !== 'feat/temp-1234' || got.ephemeral !== true) { bad('会话行标志读不到跨 chunk 的临时 worktree 状态'); }
	} catch (e) { bad('readWtChipBadge 行为断言异常：' + String((e && e.message) || e)); }

	if (!problems.some((p) => p.startsWith('worktreeChip：'))) {
		notes.push('worktreeChip：命名/enable 纯函数 + 跨 chunk 状态 + 三处 DOM 锚点 + 真 install 注入位置 + 显式桥探测 + hero 接线，断言通过');
	}
}

// ★ 2026-11-14：工作区下拉框 **A′**（用户确认「执行」）
//   顶部「搜索 + ＋ 添加工作区」；点工作区行内嵌展开多根 tip；tip 内选当前根，主命令才真切会话。
//   判据：① 结构件逐字；② 负断言禁止退回常驻当前会话栏 / 底部添加 / 长语义行 / worktree UI。
{
	const bad = (m) => problems.push('工作区下拉A′：' + m + ' ✗');
	const s = fs.readFileSync(path.join(LIB, 'client.workspace.js'), 'utf8');
	// 只扫 ContextPanel + ContextEntry 的**代码行**（注释里提到 worktree 不算数）
	const at = s.indexOf('function ContextPanel(props)');
	const end = s.indexOf('function HeroContextPanel(props)', at);
	const body = at >= 0 && end > at
		? s.slice(at, end).split('\n')
			.filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
			.join('\n')
		: '';
	if (!body) { bad('定位不到 ContextPanel 源码窗口 ⇒ 守卫会空跑'); }
	for (const [n, why] of [
		['placeholder: "搜索工作区或根"', '搜索框措辞不许带回 worktree'],
		['"data-vssaros-context-top": "1"', '必须有顶部工具行'],
		['"data-vssaros-context-add-top": "1"', '「＋ 添加工作区」必须置顶'],
		['"＋ 添加工作区"', '顶部按钮必须有可见文案'],
		['const [expandedKey, setExpandedKey]', '必须有 tip 展开状态'],
		['const [chosenRoot, setChosenRoot]', '必须有 tip 内选中根状态'],
		['onClick: spec.onToggle ? spec.onToggle', '行必须区分「展开/选根」与「切换会话」'],
		['setExpandedKey((prev) => (prev === g.key ? null : g.key))', '点工作区行必须手风琴展开 tip'],
		['"data-vssaros-wt-tip": g.key', 'tip 必须有稳定 DOM 锚点'],
		['"多根 · 点「切换」在该根新建会话"', 'tip 头必须准确说明「切换」的真实行为（不许假入口）'],
		['"单根 · 无需切换"', '单根工作区要有对应 tip 文案'],
		['setChosenRoot((prev) => Object.assign', 'tip 内点根行必须记住选中的根'],
		['bridge.switchWorktree(r.path)', '「切换」按钮必须直接调桥（不许走会先关面板的 switchTo）'],
		['setNote("已请求在 " + r.name + " 新建会话…")', '点击必须在面板内即时反馈，不许静默'],
		['event: "tip-switch-request"', '每次点击都要留诊断，区分"点了但宿主没回"'],
		['width: "calc(100% - 14px)"', '根行不许 100%+marginLeft 把按钮顶出命中区'],
		['canSwitchSession ? "切换" : "桥不支持"', '桥缺失时按钮文案必须如实，不许显示假「切换」'],
		['const [switchingPath, setSwitchingPath]', '必须有按钮级反馈状态（不能只藏在面板末尾的 note）'],
		['setSwitchingPath(r.path);', '点击后必须把状态写到按钮自身'],
		['data-vssaros-wt-tip-state', '按钮必须暴露可断言的请求状态'],
		['"已请求…"', '按钮点击后必须立即显示已请求'],
		['const [switchStatus, setSwitchStatus]', '切换必须有状态机（只有单一 requested 态 ⇒ 失败/超时会永远卡住）'],
		['tip-switch-timeout', '宿主未响应必须留诊断事件'],
		['"未响应 · 重试"', '超时后按钮必须复位成可点重试入口，不许永远卡在「已请求…」'],
		['"失败 · 重试"', '桥调用失败后按钮必须复位成可点重试入口'],
		['clearTimeout(switchTimerRef.current)', '面板卸载 / 重发时必须清掉未响应定时器'],
		['maxHeight: "min(70vh, 620px)", overflowY: "auto"', '面板必须可滚动，末尾反馈不许被视口截断'],
		['onClick: () => switchTo({ kind: "root", path: chosen, userInitiated: true })', '主命令必须拿选中的根去切'],
		['row.userInitiated !== true', 'hero 根行只读闸必须对用户主动切换放行'],
		['const doSwitch = () => {', 'tip 根行必须有统一的切换动作'],
		['data-vssaros-wt-tip-switch', '「切换」必须是独立可点的 button（不能只是 hint 文本）'],
		['type: "button", "data-vssaros-wt-tip-switch": "1",', '「切换」按钮必须是真正的 button 元素'],
		['disabled: !canSwitchSession,', '「切换」按钮只在桥不支持时禁用'],
		['[data-vssaros-wt-tip-switch], [data-vssaros-context-panel]', 'hero 的 capture mousedown 必须放行切换按钮，不许在 click 前抑制面板'],
		['const realCwd = isCurrentGroup(g) && dir ? dir : null;', '「当前根」必须以真实 cwd 为准，不许被本地选中态覆盖'],
		['row.userInitiated === true ? false : samePath(path, dir)', '主动点「切换」必须跳过当前项幂等短路'],
		['"data-vssaros-context-detail-action": "1"', '主命令锚点必须在 tip 里保留'],
		['title: action.label', '主命令「当前会话保持不变」的完整语义必须放 tooltip'],
		['"在此根新建会话" : action.label', '主命令按钮必须显示短文案'],
		['"data-vssaros-scope-info": "1"', '说明必须收进默认折叠的 ⓘ'],
		['"ⓘ 说明"', 'ⓘ 必须有可见文案'],
		['"data-vssaros-scope-line"', 'scope 锚点必须保留（守卫与真机自证靠它）'],
		['"data-vssaros-scope-limits"', '受限清单锚点必须保留'],
		['"data-vssaros-scope-actions"', '动作边界锚点必须保留'],
		['"data-vssaros-context-panes-layout": "single"', '列表必须单列'],
		['flexDirection: "column"', '单列布局必须是纵向 flex'],
		['"data-vssaros-context-pane": "list"', 'list 锚点必须保留（IDE 侧用例按它取行）'],
		['"data-vssaros-context-pane": "detail"', 'detail 锚点必须保留（IDE 侧用例按它取节点）'],
		['"↑↓ 选择 · ↵ 展开 / 切换当前根 · Esc 关闭"', '底部只留一行键位提示'],
	]) { if (!s.includes(n)) { bad('缺「' + n + '」—— ' + why); } }
	// 负断言：旧结构不许回来
	if (/kind: "worktree"|"worktree:" \+ t\.key|没有匹配的 worktree|本仓没有额外的 worktree|tree\.worktrees\.length|shownWorktrees/.test(body)) {
		bad('下拉面板不许再渲染 worktree 分组 / 行 / 空态，也不许把 worktree 算进搜索阈值');
	}
	if (body.includes('"当前会话"')) { bad('常驻「当前会话」栏不许回来（A′ 首屏只有工具行 + 列表）'); }
	if (body.includes('detailPane.push')) { bad('常驻右栏详情不许回来（根区/主命令已搬进 tip）'); }
	// ★ 真机「tip 里『切换』点不动」：hero 的 policy.disabled 会把整行禁用 ⇒ 假入口，不许回来
	if (/disabled:\s*[^\n]*\|\|\s*policy\.disabled/.test(body)) {
		bad('tip 根行不许再用 hero 只读的 policy.disabled 禁用（主命令在 hero 隐藏 ⇒ 两步式断链）');
	}
	if (s.includes('"添加工作区…"') || s.includes('"切换 = 在该目录新建会话（历史独立；当前会话保持不变）"')) {
		bad('底部添加按钮 / 长语义行不许回来（添加已置顶、语义已收进 tip）');
	}
	if (/placeholder: "搜索工作区 \/ 根 \/ worktree|"选工作区 \/ worktree|不支持切换工作区 \/ worktree/.test(s)) {
		bad('面板 / chip 的旧 worktree 措辞未清干净');
	}
	if (!problems.some((p) => p.startsWith('工作区下拉A′：'))) {
		notes.push('工作区下拉A′：添加置顶 / 点行展开 tip / tip 内选当前根 / 主命令切会话 / 说明折叠 / 双 pane 锚点，断言通过');
	}
}

// P4：聊天正文 @image token chip —— 只装饰 TEXT_NODE，不碰官方 toolview / openResource。
{
	const chip = fs.readFileSync(path.join(LIB, 'client.imageTokens.js'), 'utf8');
	const entry = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
	const partArr = (/const PART_CHUNKS = \[([\s\S]*?)\];/.exec(entry) || [])[1] || '';
	if (!partArr.includes('"./client.imageTokens.js"')) {
		problems.push('P4：client.imageTokens.js 未接进 PART_CHUNKS ✗');
	}
	if (!/CLIENT_BUILD_STAMP[^\n]*client\.imageTokens\.js/.test(entry)) {
		problems.push('P4：入口 STAMP 未记录 client.imageTokens.js ✗');
	}
	for (const [re, why] of [
		[/data-vssaros-image-token/, 'chip 标记'],
		[/__vssarosOpenImageReference/, '点击必须调右侧图片资源入口'],
		[/function splitImageTokenText\(/, '纯函数 splitImageTokenText'],
		[/createTreeWalker/, 'TreeWalker'],
		[/SHOW_TEXT/, 'SHOW_TEXT 文本节点过滤'],
		[/data-chat-flow-kind="tool-call"/, '排除官方 tool-call 子树'],
	]) {
		if (!re.test(chip)) { problems.push('P4：缺 ' + why + ' ✗'); }
	}
	if (/\.innerHTML\s*=|innerHTML\s*=/.test(chip)) { problems.push('P4：不许 HTML 字符串注入（会碰官方 React 树）✗'); }
	if (/openResource|toolview/.test(chip)) { problems.push('P4：不许碰官方 toolview / openResource ✗'); }
}

for (const n of notes) { console.log('  · ' + n); }
if (problems.length) {
	console.error('\n✗ 发现 ' + problems.length + ' 处问题：');
	for (const p of problems) { console.error('  - ' + p); }
	process.exit(1);
}
console.log('\n✓ chat-surface chunk 守卫通过（装载 / 接线 / 注册参数 / 纯逻辑 / 包清单）');
