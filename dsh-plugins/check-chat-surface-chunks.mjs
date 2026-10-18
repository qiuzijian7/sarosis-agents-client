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
const KEYED_SLOTS = new Set(['main', 'sidebar.right.pane.tab']);

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
	'conversation.chat.turnTail', 'conversation.composer']);
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
	}
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
