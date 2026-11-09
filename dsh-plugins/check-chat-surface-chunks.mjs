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
	//   已把 ours 挪到空档 **5**（官方 todo=0 / goal=10 / queue=20 ⇒ 5 是唯一与三者都不撞的靠前空档 ✓）。
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
		// ⚠ 本项目 chunk **只允许** require("react")（其他说明符不在 dsh 的 boot graph 里 ⇒ 运行时会抛）
		throw new Error('chunk 只能 require("react")，但这里 require 了 ' + spec);
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

// ── ④-c hero「新增窗口」入口必须**事件驱动**（2026-10-31 用户报「切到知识库后过一会才消失」）──
//   这颗按钮画在根帧 overlay（`inset: 0`）上 ⇒ 面板怎么切它都**不会被卸载**，可见性只能自己判断。
//   若只用「量几何」（会话容器 rect / 中栏 iframe 尺寸）+ 800ms 轮询 ⇒ 切页后最长 800ms 的残影，
//   且 iframe 首次加载时尺寸量不出来会更久 ✗（官方那枚「打开右侧边栏」能同帧消失，是因为它挂在
//   会被切走的树里、由 store 状态驱动）。
//   ⇒ 必须：① 先用 `workbenchPanelActive()`（面板根标记，**存在即算**，不等布局）做快速否；
//          ② 订阅 `TAB_CHANGE_EVENT`（与 TabStrip 同一范式）⇒ 切页**同帧**重判；
//          ③ 轮询只作兜底且不低于 400ms 的密度。
{
	const nav = fs.readFileSync(path.join(LIB, 'client.workbenchNav.js'), 'utf8');
	const at = nav.indexOf('function HeroSplitChip(');
	const nextFn = nav.indexOf('function TabStrip(', at);
	if (at < 0 || nextFn < at) {
		problems.push('client.workbenchNav.js 找不到 HeroSplitChip 的函数体 ✗（2026-10-31）');
	} else {
		const fn = nav.slice(at, nextFn);
		// ⚠ 必须匹配**代码形态**（`if (workbenchPanelActive())`）而不是裸函数名：
		//   注释里也会提到它 ⇒ `fn.includes('workbenchPanelActive()')` 在逻辑被删掉后
		//   仍然成立 ⇒ 断言形同虚设（第一版就这么失效过：突变后守卫照样绿 ✗）。
		if (!/if\s*\(\s*workbenchPanelActive\(\)\s*\)/.test(fn)) {
			problems.push('hero「新增窗口」没有用 `workbenchPanelActive()` 做快速否 ⇒ 切到工作台页只能靠"量几何"推断，会残影 800ms+ ✗（2026-10-31）');
		}
		if (!/addEventListener\(\s*TAB_CHANGE_EVENT/.test(fn)) {
			problems.push('hero「新增窗口」没有订阅 `TAB_CHANGE_EVENT` ⇒ 切页只能等下一次轮询才隐藏 ✗（2026-10-31）');
		}
		// ⚠ 反向：`activeTabId` 只在 closeTab 清空，点「💬 会话」走 selectPanel(null) 不清它
		//   ⇒ 拿它判"在工作台页"会**永久隐藏**这颗按钮 ✗✗（比残影更糟）。
		if (fn.includes('activeTabId')) {
			problems.push('hero「新增窗口」不许用 `activeTabId` 判工作台页（切回会话不清空它 ⇒ 入口永不显示 ✗）（2026-10-31）');
		}
		if (/setInterval\(\s*read,\s*(?:[5-9]\d\d|[1-9]\d{3,})/.test(fn)) {
			problems.push('hero「新增窗口」的兜底轮询超过 400ms ⇒ 官方绕过页签直接 selectPanel 时仍会有明显残影 ✗（2026-10-31）');
		}
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
			if (!/const usable = \(s0\) => isRegisteredSession\(s0, wsSnap\)/.test(wsSrcForBots)) {
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
		// ── ⑤-a1 Bot 行右键菜单（2026-11-09：复刻 DS Bot，9 项 / 3 分隔线 / flags / 动作调度）──
		{
			const need = ['botMenuItems', 'botMenuAction', 'toggleBotFlag', 'sortBotsWithFlags', 'readBotFlags', 'BOT_FLAGS_KEY'];
			const missing = need.filter((k) => typeof t[k] === 'undefined');
			if (missing.length) {
				problems.push('client.workspaces.js: __test 缺 ' + missing.join(' / ') + ' ⇒ Bot 右键菜单不可单测 ✗');
			} else {
				const bot = { id: 'b1', name: 'Bot 一' };
				const items = t.botMenuItems(bot, {}, false);
				const acts = items.filter((x) => !x.sep).map((x) => x.act);
				const want = ['pin', 'unread', 'rename', 'edit', 'duplicate', 'copySession', 'hide', 'delete'];
				if (acts.join(',') !== want.join(',')) {
					problems.push('botMenuItems: 动作顺序与 DS Bot 不一致（应 ' + want.join(' / ') + '，实得 ' + acts.join(' / ') + '）✗');
				}
				const seps = items.filter((x) => x.sep).length;
				if (seps !== 3) { problems.push('botMenuItems: 必须有 3 条分组分隔线（实得 ' + seps + '）✗'); }
				const labels = items.filter((x) => !x.sep).map((x) => x.label);
				for (const label of ['置顶', '标为未读', '重命名 Bot', '编辑 Bot', '复制一份', '复制对话 ID', '从侧栏隐藏', '删除']) {
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
				};
				t.botMenuAction('pin', bot, {}, false, deps);
				t.botMenuAction('unread', bot, {}, false, deps);
				t.botMenuAction('rename', bot, {}, false, deps);
				t.botMenuAction('edit', bot, {}, false, deps);
				t.botMenuAction('copySession', bot, {}, false, deps);
				t.botMenuAction('hide', bot, {}, false, deps);
				t.botMenuAction('delete', bot, {}, false, deps);
				t.botMenuAction('duplicate', bot, {}, false, deps);
				for (const hit of ['flag:pinned:true:false', 'unread:true', 'rename', 'edit',
					'copy:s1', 'flag:hidden:true:false', 'delete', 'getDraft:b1']) {
					if (calls.indexOf(hit) < 0) { problems.push('botMenuAction: 「' + hit + '」没有被调度（点了没反应）✗'); }
				}
				notes.push('client.workspaces.js: Bot 行右键菜单 9 项 / 3 分隔 / flags / 排序 / 动作调度断言通过');
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
				['draggable:', '会话行必须可拖拽'],
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
			['"data-ws-ring"', '会话行必须有状态灯的稳定 DOM 锚点（真机探针也靠它）'],
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
	const need = [
		['Promise.resolve(entity.detachSession(sid))', '删除必须**真的调用** detachSession 摘账本（不再靠归档让行消失）'],
		// ⚠ 钉完整键值（`"data-ws-unread": "1"`）而不是裸词：`data-ws-unread-x` 也含裸词 ⇒ 会假绿 ✗
		['"data-ws-unread": "1"', '行上必须有未读点（对齐官方 StateDot）'],
		['markSessionRead(s.id)', '打开会话必须即时标记已读'],
		['"data-act": "unread"', '右键菜单必须有「标为未读 / 标为已读」'],
		['"data-act": "fork"', '右键菜单必须有「分叉」（对齐官方 ForkSessionMenuItem）'],
		['onDoubleClick', '标题必须支持双击就地重命名（对齐官方行）'],
		['absTimeLabel', '时间戳 hover 必须给绝对时间'],
		['borderRadius: "50%"', '状态灯必须是圆点（对齐官方视觉，不是 2px 竖条）'],
		// ★ 2026-11-02（用户要求「复刻官方原生 item UI」）：以下钉**官方 Rows.module.css 的数值**
		//   与结构 —— 这些是"样式被顺手改回内联"时最容易静默失真的地方（内联会盖掉类 ✗）。
		// ⚠ 用**完整片段**而不是裸词/裸值：`vssaros-ws-row` 在文件里出现 15 次、`height:32px` 2 次
		//   ⇒ 裸词断言在逻辑被改掉后仍然通过（本次反向突变连踩两次 ✗）。
		['.vssaros-ws-row{height:32px;gap:0;padding:0 8px', '会话行必须走注入的官方数值（32px 行高 / gap 0 / padding 0 8px）'],
		['className: "vssaros-ws-row"', '会话行必须真的挂上 `.vssaros-ws-row`（否则 32px/悬停规则全不生效）'],
		['font-size:14px', '标题必须 14px / 20px（官方 `.title`）'],
		['.vssaros-ws-slot{width:16px;height:20px', 'leading 必须是官方 16×20 格（`.slot`）'],
		['vssaros-ws-time', '时间必须是官方 `.time`（10px/16px，悬停隐藏）'],
		['vssaros-ws-actions', '行尾必须有官方 `.rowActions`（⋯ 按钮，悬停才出现）'],
		['const showStatus =', '状态点必须按官方 `showStatus` 口径（idle 不画）'],
		// 官方 `SessionNodeItem` 的 hover 卡片（2026-11-02 补）
		['SESS_HOVER_DELAY_MS = 800', '会话行 hover 卡片必须 800ms 延迟（官方 openDelayMs=800；太快会划过一路弹卡）'],
		['"data-vssaros-sess-hover": "1"', '会话 hover 卡片必须有稳定锚点'],
		['"data-act": "copy-title"', '会话 hover 卡片必须有「复制标题」（官方 copyText/copyLabel）'],
		// ⚠ 钉**挂载点**而不是裸函数名：`openSessHover` 的定义本身就在文件里 ⇒ 裸词断言删掉挂载也绿 ✗
		['onMouseEnter: (e) => openSessHover(s, e)', '会话行必须真的挂上 hover 卡片入口（只定义不挂载 = 永远不弹）'],
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
		['}, "移除工作区")', '「移除工作区」文案必须直白（不带省略号，表示点了就执行）'],
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
		// 标题溢出（2026-11-02 补齐官方 `useTitleMarquee` 的视觉契约）
		// ⚠ 必须钉**完整声明**：`…{mask-image-x` 里仍含 `…{mask-image` ⇒ 截断式断言会假绿（本次踩过 ✗）
		['.vssaros-ws-title[data-scrolled]{mask-image:linear-gradient(90deg,#0000,#000 12px)}', '标题溢出必须有官方同款左端淡出（`data-scrolled`）'],
		['.vssaros-ws-title[data-clipped]{mask-image:linear-gradient(270deg,#0000,#000 12px)}', '标题溢出必须有官方同款右端淡出（`data-clipped`）'],
		['scrollWidth > el.clientWidth', '溢出必须真的量宽度再淡出（不能无条件淡出）'],
		// 官方行的稳定锚点
		['"data-row-key": "session:"', '会话行必须带官方锚点 `data-row-key="session:<id>"`'],
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
		// ★ 2026-11-09 hero 报障：右栏设置页签是 session 槽，hero 下结构上不渲染
		['const BOT_CONFIG_PAGE_COMP = "vssaros-bot-config";', 'hero 下「编辑 Bot」必须有中栏独立页组件常量'],
		['comp: BOT_CONFIG_PAGE_COMP, props: { agentId: id, name, tabId }',
			'「编辑 Bot」必须优先按 agentId 开中栏独立页（不依赖 session 槽 / 不需要会话）'],
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
		// ★ 2026-11-02 用户要求「点会话页签 = 开新会话（同新会话按钮）」
		//   必须复用官方 `uiWorkspace.startSession()`（自造 blank 会漏掉"挂进工作区账本"⇒ 输入框灰 ✗）
		// ★ 2026-11-02 三次：`startSession()` 内部 `if (navigation.aborted) return;` 会静默空转
		//   （真机日志：entering 有、main 不变 ⇒ 用户只看到"还是原来那个聊天框"）⇒ 改走自建链
		['create({ workspaceId: wsId })', '「会话」页签必须走 create({workspaceId})（必须带 workspaceId 才会进工作区账本）'],
		['const startNewSessionFromTab = () => {', '「会话」页签必须有独立的新建实现（不能依赖 startSession 的竞态）'],
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
		// 宿主失败只发 IDE 通知（桌面模式下不可见）⇒ `splitPane` 至少要把错误留痕
		for (const [needle, why] of [
			['[vssaros-ws] splitChatPane failed:', '「新窗格」失败必须 console.warn（不许静默吞掉）'],
			['st.newWindowEntryError = why;', '「新窗格」失败必须写进 state（供「复制诊断信息」查）'],
		]) {
			if (sessSrc.indexOf(needle) < 0) { problems.push(`client.sessions.js: 缺「${needle}」—— ${why} ✗（2026-11-02）`); }
		}
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
	for (const [needle, why] of need) {
		if (ws.indexOf(needle) < 0) { problems.push(`client.workspaces.js: 缺「${needle}」—— ${why} ✗（2026-11-02）`); }
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
		if (!tw.validateGroupDraft({ name: '', members: ['a'] }).length) { problems.push('validateGroupDraft: 空群名必须报错 ✗'); }
		if (tw.validateGroupDraft({ name: 'g', members: ['a'] }).length) { problems.push('validateGroupDraft: 合法输入不该报错 ✗'); }
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
		// 声明了子槽就必须有 renderSlot 调用（否则内容区必空）
		if (!/renderSlot\s*\(/.test(src)) {
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
		/* ★ 2026-11-09：渠道页签下线后，飞书配置必须落在 Bot 设置页且下拉读全局应用池。 */
		if (!/function FeishuConfigCard\(props\)/.test(cv) || !/data-vssaros-feishucfg-pick/.test(cv)
			|| !/action: "set-bot-app"/.test(cv) || !/data\.feishuApps/.test(cv)) {
			problems.push('client.conversationViews.js: 缺 Bot 设置页「飞书配置」卡（全局应用下拉 + set-bot-app）✗');
		}
		if (!/react\.createElement\(FeishuConfigCard,/.test(cv)) {
			problems.push('client.conversationViews.js: 「飞书配置」卡没挂到 BotConfigCard ✗');
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
		// ★ 2026-11-09 hero 报障：右栏设置页签是 session 槽 ⇒ hero 下必须有中栏独立页承载面
		if (!/function BotConfigPage\(/.test(cv)
			|| !/w\.__vssarosPageComponents\[BOT_CONFIG_PAGE_COMP\] = BotConfigPage;/.test(cv)) {
			problems.push('client.conversationViews.js: 缺 Bot 配置独立页组件/注册 ⇒ hero 下「编辑 Bot」没有承载面 ✗');
		}
		if (!/react\.createElement\(BotConfigCard, \{ key: agentId, agentId/.test(cv)) {
			problems.push('client.conversationViews.js: Bot 配置独立页必须按 agentId 直接渲染 BotConfigCard（不依赖 sessionId）✗');
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
for (const n of notes) { console.log('  · ' + n); }
if (problems.length) {
	console.error('\n✗ 发现 ' + problems.length + ' 处问题：');
	for (const p of problems) { console.error('  - ' + p); }
	process.exit(1);
}
console.log('\n✓ chat-surface chunk 守卫通过（装载 / 接线 / 注册参数 / 纯逻辑 / 包清单）');
