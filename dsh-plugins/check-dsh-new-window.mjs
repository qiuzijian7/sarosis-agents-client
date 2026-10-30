/*---------------------------------------------------------------------------------------------
 *  桌面窗口多开：页面里那枚「+ 新窗口」按钮的守卫（2026-10-29）。
 *
 *  需求（用户原话）："dsh 桌面客户端（chat-surface 页）能否支持多开聊天页面 / 像 codex 一样同时开多个窗口"。
 *  ⇒ 落地 = 桥命令 `openDesktopWindow`（协议 / 校验 / preload / 宿主 四段）+ 页面按钮（品牌行右侧）。
 *
 *  这条守卫是**行为级**的：把 `client.brand.js` 真装进假 loader + 假 react，渲染 `BrandName()`，
 *  找到那枚按钮并**真的点它** ⇒ 断言它打到 `window.vssarosDsh.openDesktopWindow`；
 *  再把宿主换成"没有这条命令"的旧宿主 ⇒ 断言它**明说**（notify warn）而不是静默。
 *
 *  为什么必须行为级：只查源码里"出现过 openDesktopWindow"会被"函数改名 / 调用形态变了"骗过
 *  （本仓踩过：只钉 `indexOf('focusIde')` ⇒ 改名成 focusIdeX 照样绿 ✗）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'dsh-plugins', 'vssaros-chat-surface');
const SESSIONS = path.join(PLUGIN, 'lib', 'client.sessions.js');
const BRAND = path.join(PLUGIN, 'lib', 'client.brand.js');
const SLOT = 'conversation.session.header.utilities';
const ENTRY_ID = 'vssaros-new-window';
const ENTRY_ORDER = -4;
const PROTOCOL = path.join(ROOT, 'src/vs/sessions/contrib/dshHarness/common/dshPageBridgeProtocol.ts');
const PRELOAD = path.join(ROOT, 'src/vs/sessions/contrib/dshHarness/electron-browser/preload-dshView.ts');
const HOST = path.join(ROOT, 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts');
const FULL_WINDOW = path.join(ROOT, 'src/vs/sessions/contrib/dshHarness/electron-browser/dshFullWindowContribution.ts');
const VIEW_HOST = path.join(ROOT, 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts');
const SERVICE = path.join(ROOT, 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts');

const read = (p) => fs.readFileSync(p, 'utf8');
/** 去掉注释再断言代码（注释里也写着这些关键词 ⇒ 不去掉会假绿 ✗）。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 极简假 react：够渲染出树、能拿到 props（含 onClick）。 */
function fakeReact() {
	return {
		createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
		useState: (v) => [v, () => { }],
	};
}

/** 在假 window 里装载 chunk，返回它的 exports。 */
function loadBrandChunk(win) {
	let exports = null;
	win.__ModuleLoader__ = {
		load: (spec) => {
			// ⚠ chunk 内部自己建了 `module` ⇒ **必须取 factory 的返回值**，
			//   在外面另建一个 `m.exports` 只会拿到空对象（本仓踩过：守卫"没导出 __test"✗）。
			const moduleExports = spec.factory((name) => {
				if (name === 'react') { return fakeReact(); }
				throw new Error(`unexpected require: ${name}`);
			});
			exports = moduleExports;
			return moduleExports;
		},
	};
	const sandbox = {
		window: win,
		document: { title: '' },
		console, Promise, Object, Array, Math, String, Number, Boolean, Error, JSON,
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(read(SESSIONS), sandbox, { filename: SESSIONS });
	assert.ok(exports && typeof exports.install === 'function', 'chunk 必须导出 install ✗');
	return exports;
}

/** 假 ctx：跑 install 并捕获它注册进 slots 的条目。 */
function installAndCapture(win, bridge) {
	const mod = loadBrandChunk(win);
	const captured = [];
	const ctx = {
		slots: {
			inject: (slot, fn) => { fn(); },
			register: (opts, comp) => { captured.push({ opts, comp }); return { id: opts.id }; },
		},
	};
	const shell = { state: {}, bridge: bridge || { surface: 'chat', chatOnly: false } };
	mod.install(ctx, shell);
	return { captured, shell };
}

/** 深搜树，找第一个满足 pred 的节点。 */
function findNode(node, pred) {
	if (!node || typeof node !== 'object') { return null; }
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findNode(child, pred);
			if (hit) { return hit; }
		}
		return null;
	}
	if (pred(node)) { return node; }
	return findNode(node.children, pred);
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('页面：必须注册进会话动作组那一排（slot / id / order 三者都要对）', () => {
	const { captured } = installAndCapture({});
	const entry = captured.find(c => c.opts && c.opts.id === ENTRY_ID);
	assert.ok(entry, `必须注册 id ${ENTRY_ID}（实际注册了 ${captured.map(c => c.opts && c.opts.id).join(',') || '(空)'}）✗`);
	assert.strictEqual(entry.opts.name, SLOT, `槽必须是 ${SLOT} ✗`);
	assert.strictEqual(entry.opts.order, ENTRY_ORDER,
		`order 必须是 ${ENTRY_ORDER}（官方 schedule-catalog=-5 / session-log-download=0，我们自己 -3/-2 ⇒ 撞了会 tie ✗）`);
	assert.ok(entry.comp, '必须给组件 ✗');
});

check('页面：只装在带官方 chrome 的视图（IDE 里的纯聊天框不装）', () => {
	const chatOnly = installAndCapture({}, { surface: 'chat', chatOnly: true });
	assert.ok(!chatOnly.captured.some(c => c.opts && c.opts.id === ENTRY_ID),
		'chatOnly=true（IDE 聊天框）不许注册这一枚 ✗');
	const desktop = installAndCapture({}, { surface: 'chat', chatOnly: false });
	assert.ok(desktop.captured.some(c => c.opts && c.opts.id === ENTRY_ID),
		'桌面窗口（chatOnly=false）必须注册 ✗');
});

check('页面：点它必须真的打到 bridge 的 splitChatPane（同窗口内分屏，不是弹独立窗口）', () => {
	let called = 0;
	const win = {
		vssarosDsh: { bridgeVersion: 23, splitChatPane: () => { called++; return Promise.resolve(true); } },
	};
	const { captured } = installAndCapture(win);
	const entry = captured.find(c => c.opts && c.opts.id === ENTRY_ID);
	assert.ok(entry, '必须注册那一枚 ✗');
	const tree = entry.comp({});
	const btn = findNode(tree, (n) => n.props && n.props['data-vssaros-new-window']);
	assert.ok(btn, '渲染树里必须有那枚按钮 ✗');
	assert.strictEqual(typeof btn.props.onClick, 'function', '按钮必须有 onClick ✗');
	btn.props.onClick();
	assert.strictEqual(called, 1, '点击必须调用 bridge.splitChatPane（只调 1 次）✗');
});

check('页面：旧宿主（没有这条命令）必须**明说**（notify warn），不许静默', () => {
	const notes = [];
	const win = {
		vssarosDsh: { bridgeVersion: 21, notify: (level, msg) => { notes.push([level, msg]); } },
	};
	const { captured } = installAndCapture(win);
	const entry = captured.find(c => c.opts && c.opts.id === ENTRY_ID);
	assert.ok(entry, '必须注册那一枚 ✗');
	const tree = entry.comp({});
	const btn = findNode(tree, (n) => n.props && n.props['data-vssaros-new-window']);
	btn.props.onClick();
	assert.strictEqual(notes.length, 1, '旧宿主必须 notify 一次说明不支持（0 次 = 点了没反应 ✗）');
	assert.strictEqual(notes[0][0], 'warn', '级别必须是 warn ✗');
	assert.ok(/不支持/.test(String(notes[0][1])), '文案必须说清不支持 ✗');
});

check('桥：协议声明 + 校验 case + 名单（不许把 IDE 主窗口拉出来）', () => {
	const src = stripComments(read(PROTOCOL));
	assert.ok(/readonly method: 'splitChatPane'/.test(src), '协议必须声明 splitChatPane ✗');
	assert.ok(/case 'splitChatPane':/.test(src), '校验器必须有 case（漏了会静默丢弃 ✗）');
	// ⚠ 必须真在「不需要 IDE 界面」名单里：在桌面模式点它却冒出 IDE 窗口 = 用户明确否决过的行为 ✗
	const listAt = src.indexOf('DSH_PAGE_COMMANDS_WITHOUT_IDE_UI');
	assert.ok(listAt > 0, '找不到名单常量 ✗');
	const list = src.slice(listAt, listAt + 2000);
	assert.ok(/'splitChatPane'/.test(list), '必须登记进 DSH_PAGE_COMMANDS_WITHOUT_IDE_UI ✗');
});

check('桥：preload 必须暴露该方法，且 bridgeVersion 与协议常量一致', () => {
	const preload = read(PRELOAD);
	const protocol = read(PROTOCOL);
	assert.ok(/splitChatPane:\s*\(\)\s*=>\s*invoke\(\{\s*method:\s*'splitChatPane'\s*\}\)/.test(preload),
		'preload 必须暴露 splitChatPane（调用形态要钉住，防改名假绿）✗');
	const vPre = /bridgeVersion:\s*(\d+)/.exec(preload);
	const vProto = /DSH_PAGE_BRIDGE_VERSION\s*=\s*(\d+)/.exec(protocol);
	assert.ok(vPre && vProto, '两边都要能读到版本号 ✗');
	assert.strictEqual(vPre[1], vProto[1],
		`preload 的 bridgeVersion（${vPre[1]}）与协议的 DSH_PAGE_BRIDGE_VERSION（${vProto[1]}）必须同值 ✗`);
});

check('宿主：必须有 case 且走 splitDshChatPane（按发起请求的视图定位窗口）', () => {
	const src = stripComments(read(HOST));
	assert.ok(/case 'splitChatPane':/.test(src), '宿主必须有 case（漏了 = 点了没反应 ✗）');
	assert.ok(/splitDshChatPane\(viewId\)/.test(src), '必须按 viewId 定位是哪扇窗口（不按 viewId 就不知道该分屏谁）✗');
});

check('★ 渲染侧：必须真的排成**两栏**（两个视图 + 两条 bounds + 独立会话 + 独立分区）', () => {
	const src = stripComments(read(FULL_WINDOW));
	assert.ok(/_ensureSplitPane\(/.test(src), '必须实现 _ensureSplitPane（页面桥的落点）✗');
	assert.ok(/splitViewId/.test(src), '必须把右栏视图记进 _desktopWindows（否则关窗不回收、也没法重排）✗');
	// ⚠ 两个 layoutView 调用（左右各一）⇒ 少一个就有一栏不摆
	const layoutCalls = (src.match(/this\._dsh\.layoutView\(/g) || []).length;
	assert.ok(layoutCalls >= 2, `必须给两个视图各排一次 bounds（现在 ${layoutCalls} 次）✗`);
	assert.ok(/DESKTOP_SPLIT_GAP/.test(src), '必须留出缝隙（原生视图盖在 DOM 之上 ⇒ 分隔条只能落在缝里）✗');
	// 右栏视图 = chat-only（不重复官方侧栏）+ 独立分区（不抢那 6 条连接）
	assert.ok(/createView\(splitViewId,[^)]*'chat'[^)]*undefined,\s*undefined,\s*true,\s*true\)/.test(src),
		'右栏视图必须 chatOnly=true + isolatedPool=true（否则重复官方侧栏 / 与左栏抢连接）✗');
	// 会话必须与左栏错开（否则两栏同一条对话）
	assert.ok(/dshChatNewSessionId\('full-popout',\s*suffix\s*\?/.test(src),
		'会话 id 必须带分栏后缀（两栏同一条会话 = 两边显示同一条对话 ✗）');
});

check('★ 自愈：右栏必须被巡检（视图没了 / 长期无响应 ⇒ 收掉右栏回到单栏）', () => {
	const src = stripComments(read(FULL_WINDOW));
	assert.ok(/_checkSplitPane\(/.test(src), '必须实现右栏存活巡检 ✗');
	assert.ok(/_dropSplitPane\(/.test(src), '必须实现"收掉右栏"的自愈动作 ✗');
	assert.ok(/this\._dsh\.listViews\(\)/.test(src), '巡检必须用 listViews 确认视图还在（否则右栏被回收了没人知道）✗');
	assert.ok(/waitViewSelector\(splitViewId,\s*'\[data-composer-card\]',\s*200\)/.test(src),
		'探测 composer 必须给 200ms 超时（给 0 会**立即超时**返回 false ⇒ 误杀刚建好的右栏 ✗）');
	assert.ok(/sawComposer/.test(src), '必须记住"曾经出现过 composer"（否则加载期被当成坏了 ✗）');
});

check('★ 聚焦路由：focus 事件必须带 surface，且只有聊天视图能占"活动聊天"位', () => {
	const host = stripComments(read(VIEW_HOST));
	assert.ok(/kind:\s*'focus',\s*surface:\s*slot\.surface/.test(host),
		'主进程 fire focus 事件必须带 surface（渲染侧据此判断能不能占活动聊天位）✗');
	const svc = stripComments(read(SERVICE));
	assert.ok(/e\.kind === 'focus' && e\.surface === 'chat'/.test(svc),
		'渲染侧必须只在 chat 视图获得焦点时占活动聊天位（插件页不许占 ✗）');
	assert.ok(/this\._activeChatViewId = e\.viewId/.test(svc),
		'必须把活动聊天位指向获得焦点的那个视图（分屏时 Add File to Chat 才落对栏 ✗）');
});

check('★ 格子上限 + 比例持久化（别无限开格、也别每次都重置比例）', () => {
	const src = stripComments(read(FULL_WINDOW));
	assert.ok(/MAX_DESKTOP_SPLIT_PANES = 6/.test(src), '右侧必须封顶 6 格（与效果图一致；每格是一整个客户端页面 ⇒ 成本线性增长）✗');
	assert.ok(/SPLIT_RATIO_STORAGE_KEY/.test(src) && /_persistSplitRatio\(\)/.test(src),
		'主栏比例必须持久化（下次开窗沿用用户拖出来的比例）✗');
	// ⚠ 比例必须存 IDE storage：各栏是**不同分区**的页面 ⇒ localStorage 互不可见 ⇒ 放页面里右栏读不到 ✗
	assert.ok(/IStorageService/.test(src), '比例必须走 IDE storage（跨分区共享）✗');
});

check('★ 聚焦校准：必须定期用 focused 快照校准"活动聊天位"（blur 不 fire）', () => {
	const host = stripComments(read(VIEW_HOST));
	assert.ok(/focused:\s*s\.view\.webContents\.isFocused\(\)/.test(host), '主进程 describe 必须给 focused 快照 ✗');
	assert.ok(/viewSurface:\s*s\.surface/.test(host), '主进程 describe 必须给视图类型（surface 是"页面摆哪"、viewSurface 才是"什么类型"）✗');
	const svc = stripComments(read(SERVICE));
	assert.ok(/_calibrateActiveChatView/.test(svc), '渲染侧必须有校准方法 ✗');
	assert.ok(/v\.focused && v\.viewSurface === 'chat'/.test(svc), '校准只认"聚焦的聊天视图"（插件页不许占位）✗');
});

check('★ hero（空会话屏）右上角必须有「新增窗口」入口，且只在主栏、只在 hero 显示', () => {
	const nav = stripComments(read(path.join(PLUGIN, 'lib', 'client.workbenchNav.js')));
	assert.ok(/data-vssaros-hero-split/.test(nav), 'hero 入口必须有稳定锚点 ✗');
	assert.ok(/api\.splitChatPane\(\)/.test(nav), 'hero 入口必须调 bridge.splitChatPane ✗');
	// ⚠ 判据必须是官方的 **phase**：`data-content-phase="hero"`。
	//   为什么不能用"有没有 data-conversation-session"：桌面窗口开局就绑一条**空会话** ⇒
	//   属性存在、但界面仍是 hero（官方 `hero = sessionId===void 0 || (blank && …)`）✗
	assert.ok(/data-content-phase/.test(nav) && /=== "hero"/.test(nav),
		'hero 判据必须是 [data-conversation-content] 的 data-content-phase === "hero" ✗');
	assert.ok(!/hasAttribute\("data-conversation-session"\)/.test(nav),
		'不许再用"没有 data-conversation-session"判 hero（空会话首屏会判错 ⇒ 入口永不显示 ✗）');
	// ⚠ 不许压住官方「打开侧边栏」（2026-10-30 用户截图：右上角按钮被挡）
	assert.ok(/data-sidebar-right-expand/.test(nav) && /data-sidebar-right-toggle/.test(nav),
		'入口必须贴到官方「打开侧边栏」按钮左边（否则会盖住它 ✗）');
	// ⚠ 只在 HeroSplitChip 函数体（到下一个 function 定义为止）内做负对照（本文件别处合法地用了那些标记）
	const heroAt = nav.indexOf('function HeroSplitChip(');
	const nextFn = nav.indexOf('function TabStrip(', heroAt);
	assert.ok(heroAt > 0 && nextFn > heroAt, '找不到 HeroSplitChip 的函数体 ✗');
	const heroFn = nav.slice(heroAt, nextFn);
	assert.ok(!/data-sidebar-right-session/.test(heroFn), '不许再用旧的三个标记判 hero（在 hero 上也不成立 ✗）');
	// 只在主栏注册：右侧独立格子不该出现「新增窗口」
	assert.ok(/if \(!isDeskSplitPane\)[\s\S]{0,900}overlay:hero新窗格/.test(nav), 'hero 入口只许装在主栏（右侧格子不装）✗');
	// 品牌行不许再有第二枚（两处入口 = 重复）
	assert.ok(!/data-vssaros-split-entry/.test(stripComments(read(BRAND))), '品牌行不许再有 hero 分屏入口（已搬到右上角）✗');
	// ⚠ hero 态只装 BLANK_SESSION_PARTS ⇒ 入口必须落在**那些** chunk 里，否则 hero 时根本没有它
	const clientSrc = stripComments(read(path.join(PLUGIN, 'lib', 'client.js')));
	const blankParts = /const BLANK_SESSION_PARTS = \[([\s\S]*?)\];/.exec(clientSrc);
	assert.ok(blankParts && blankParts[1].includes('./client.workbenchNav.js'),
		'client.workbenchNav.js 必须在 BLANK_SESSION_PARTS 里（hero 态才装得到入口）✗');
});

const CHROME = path.join(ROOT, 'src/vs/sessions/contrib/dshHarness/electron-browser/dshDesktopSplitChrome.ts');

check('★ 多格外壳（按效果图）：每格标题栏 + 拖动 + 拆分/最大化/✕ + 分隔条 + 主栏分隔条 + 撤销 + 原生菜单', () => {
	const src = stripComments(read(CHROME));
	for (const act of ['split-right', 'split-down', 'max', 'close']) {
		assert.ok(src.includes(`btn('${act}'`), `标题栏必须有「${act}」按钮 ✗`);
	}
	assert.ok(/data-vssaros-pane-head/.test(src), '标题栏必须有稳定锚点 ✗');
	assert.ok(/_startDrag\(/.test(src) && /pickDropTarget\(/.test(src), '拖标题栏必须按边缘带/中央判落点 ✗');
	assert.ok(/actions\.hole\(/.test(src), '落点提示必须"挖洞"（DOM 提示框被原生视图盖着就看不见）✗');
	assert.ok(/key === 'Escape'|e\.key === 'Escape'/.test(src), '拖动中必须能 Esc 取消 ✗');
	assert.ok(/主栏固定在左侧，不能放这里/.test(src), '拖到主栏必须拒绝并说明 ✗');
	assert.ok(/resizeDivider\(/.test(src) && /resizeMain\(/.test(src), '格间分隔条与主栏分隔条都必须可拖 ✗');
	assert.ok(/data-vssaros-undo/.test(src), '关闭后必须能撤销 ✗');
	assert.ok(/popup\(this\._actions\.menuItems/.test(src), '右键菜单必须用原生菜单（DOM 菜单会被原生视图盖住）✗');
	// ⚠⚠ 两条硬规矩（2026-10-29 真机连踩两次 ⇒ 不许回退）：
	//   ① aux（子）窗口的 JS 上下文**禁止** createElement ⇒ 一律用主窗口 document 建；
	//   ② aux 的 DOM 层默认 **pointer-events:none** ⇒ 可交互元素必须显式 pointer-events:auto。
	assert.ok(!/ownerDocument\.createElement/.test(src) && !/ownerDocument\.createElement/.test(stripComments(read(FULL_WINDOW))),
		'不许用 ownerDocument.createElement（aux 子窗口禁 createElement ⇒ 元素建不出来）✗');
	assert.ok(/mainWindow\.document\.createElement/.test(src), '必须用主窗口 document 建元素 ✗');
	assert.ok(/cursor:grab[^'"]*pointer-events:auto/.test(src), '标题栏必须显式 pointer-events:auto（否则收不到 mousedown ⇒ 拖不动）✗');
	assert.ok(/cursor:col-resize[^'"]*pointer-events:auto|pointer-events:auto[^'"]*cursor:col-resize/.test(src), '分隔条必须显式 pointer-events:auto ✗');
	assert.ok(/cursor:pointer;pointer-events:auto/.test(src), '标题栏按钮必须显式 pointer-events:auto ✗');
});

check('★ 宿主：两段式布局 + 格子几何 + 软关闭可撤销 + 不自动重排 + 自测走 DOM 输入路径', () => {
	const src = stripComments(read(FULL_WINDOW));
	assert.ok(/computePaneGeometry\(/.test(src), '格子几何必须走纯函数（缝隙/标题栏/分隔条位置有单测）✗');
	assert.ok(/DESKTOP_MAIN_MIN_W = 720/.test(src), '主栏最小宽必须是 720（dsh 三栏布局在 520 就把中栏挤成黑屏 ✗）');
	assert.ok(/computeMainColumnWidth\([^)]*DESKTOP_MAIN_MIN_W/.test(src), '主栏布局必须走 computeMainColumnWidth 并传下限 ✗');
	assert.ok(/holeViewRect\(/.test(src), '拖动时必须挖洞（目标格让出落点那一半）✗');
	assert.ok(/DESKTOP_CLOSE_GRACE_MS/.test(src) && /_undo\(/.test(src), '关闭必须是软关闭 + 可撤销（会话不删）✗');
	assert.ok(/pickSplitTarget\(/.test(src), '「新窗格」必须切开最大的一格（放不下就明说）✗');
	assert.ok(!/buildArrangedTree\(splitLeaves\(entry\.tree\), this\._contentAspect\(entry\.windowId\)\)/.test(src),
		'加格子后不许自动重排（手动布局不能被覆盖；「自动排列」只能手动触发）✗');
	assert.ok(/_dropSplitPane\(windowId, splitViewId,/.test(src), '自愈必须收掉**出问题的那一格**（旧实现收最后一格 ⇒ 误杀）✗');
	assert.ok(/elementFromPoint\(/.test(src) && /reachable\(/.test(src), '自测必须验证"点得到"（命中测试 + 不被原生视图盖住）✗');
	assert.ok(/fire\(dom\.win, 'mousemove'/.test(src), '自测必须走真实 DOM 输入路径（不许只调内部函数）✗');
	const layoutSrc = stripComments(read(path.join(ROOT, 'src/vs/sessions/contrib/dshHarness/common/dshSplitLayout.ts')));
	for (const fn of ['computeSplitLayout', 'moveSplitLeaf', 'insertSplitLeafBeside', 'resizeSplitDivider', 'pickDropTarget', 'computePaneGeometry']) {
		assert.ok(new RegExp(`export function ${fn}`).test(layoutSrc), `common/dshSplitLayout.ts 必须导出 ${fn} ✗`);
	}
});

check('★ 页面：会话动作组里**不许有**「布局 ▾」（用户要求移除）；右侧格子页面也不装格子按钮', () => {
	const sessions = stripComments(read(SESSIONS));
	// ⚠ 2026-10-30（用户："dsh 聊天框中，移除顶部的布局按钮"）：
	//   分屏/比例/排列/关闭全部这些**已经在宿主标题栏与右键菜单里** ⇒ 顶部那枚是多余的、还挤占动作组 ✗
	assert.ok(!/data-vssaros-pane-menu/.test(sessions), '会话动作组里不许再有「布局 ▾」（已按用户要求移除）✗');
	assert.ok(!/vssaros-pane-menu/.test(sessions), '不许再注册 vssaros-pane-menu ✗');
	assert.ok(!/api\.paneAction\(/.test(sessions), '页面不许再调 bridge.paneAction（菜单已移除）✗');
	assert.ok(!/data-vssaros-pane-grip/.test(sessions), '页面里的「⇔」把手必须去掉（拖动在宿主标题栏）✗');
	assert.ok(!/dsh-desk-split-/.test(sessions), '右侧格子页面里不许再装格子按钮（两套入口会打架）✗');
	// 「新窗格」那枚仍在（用户没让删，且它是主栏唯一的加栏入口）
	assert.ok(/data-vssaros-new-window/.test(sessions), '「新窗格」入口必须保留 ✗');
	// ★ 2026-10-30（用户）：独立格子不显示会话页签条（主栏照旧显示）
	const nav = stripComments(read(path.join(PLUGIN, 'lib', 'client.workbenchNav.js')));
	assert.ok(/indexOf\("dsh-desk-split-"\) === 0/.test(nav) && /if \(!isDeskSplitPane\)[\s\S]{0,200}vssaros-wb-tabstrip/.test(nav),
		'桌面独立格子不许注册页签条（只有主栏才有）✗');
	const protocol = stripComments(read(PROTOCOL));
	assert.ok(/readonly method: 'paneAction'/.test(protocol), '协议必须声明 paneAction ✗');
	assert.ok(/case 'paneAction':/.test(protocol), '校验器必须有 case（漏了会被静默丢弃 ✗）');
	for (const action of ['arrange', 'equalize', 'closeAll']) {
		assert.ok(protocol.includes(`action !== '${action}'`), `校验器白名单必须放行 ${action}（否则页面点了被静默丢弃 ✗）`);
	}
	const preload = read(PRELOAD);
	assert.ok(/paneAction:\s*\(action[^)]*\)\s*=>\s*invoke\(\{\s*method:\s*'paneAction'/.test(preload),
		'preload 必须暴露 paneAction ✗');
	const host = stripComments(read(HOST));
	assert.ok(/case 'paneAction':/.test(host), '宿主必须有 case（漏了 = 点了没反应 ✗）');
	assert.ok(/paneDshChatPane\(viewId, command\.action\)/.test(host), '宿主必须按 viewId 交给"格子动作"✗');
});

let failed = 0;
for (const [name, fn] of checks) {
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}\n    ${err && err.message ? err.message : err}`);
	}
}
console.log(`[check-dsh-new-window] ${checks.length - failed} / ${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
