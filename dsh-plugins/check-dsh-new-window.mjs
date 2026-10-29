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

check('★ 3 栏上限 + 比例持久化（别无限开栏、也别每次都重置比例）', () => {
	const src = stripComments(read(FULL_WINDOW));
	assert.ok(/MAX_DESKTOP_PANES = 3/.test(src), '必须有 3 栏上限（每栏是一整个客户端页面 ⇒ 成本线性增长）✗');
	assert.ok(/SPLIT_RATIO_STORAGE_KEY/.test(src) && /_persistSplitRatio\(\)/.test(src),
		'分屏比例必须持久化（下次开窗沿用用户拖出来的比例）✗');
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

check('★ hero（空会话屏）必须也有「新窗格」入口（会话动作组在 blank 时整组不渲染）', () => {
	const src = stripComments(read(BRAND));
	assert.ok(/data-vssaros-split-entry/.test(src), 'hero 入口必须有稳定锚点 ✗');
	assert.ok(/api\.splitChatPane\(\)/.test(src), 'hero 入口必须调 bridge.splitChatPane ✗');
	assert.ok(/isBlankChatPage/.test(src), '必须按"页面是否仍停在 hero"决定显示 ✗');
	assert.ok(/data-sidebar-right-session/.test(src), 'blank 判据必须认"会话真的在渲染"的标记（认错 ⇒ 有会话时也显示 ⇒ 与会话动作组那枚重复 ✗）');
	// ⚠ hero 态只装 BLANK_SESSION_PARTS ⇒ 入口必须落在**那些** chunk 里，否则 hero 时根本没有它
	const clientSrc = stripComments(read(path.join(PLUGIN, 'lib', 'client.js')));
	const blankParts = /const BLANK_SESSION_PARTS = \[([\s\S]*?)\];/.exec(clientSrc);
	assert.ok(blankParts && blankParts[1].includes('./client.brand.js'),
		'client.brand.js 必须在 BLANK_SESSION_PARTS 里（hero 态才装得到入口）✗');
});

check('★ 拖拽堆叠：布局必须走**树**，且必须有抓手带 + 四向落点 + 兜底菜单（A+C）', () => {
	const src = stripComments(read(FULL_WINDOW));
	assert.ok(/computeSplitLayout\(/.test(src), '布局必须走树的纯函数（几何在 common 里，有单测）✗');
	assert.ok(/moveSplitLeaf\(/.test(src), '拖拽落点必须调 moveSplitLeaf 重排树 ✗');
	assert.ok(/pickDropZone\(/.test(src), '必须按几何判四向落点 ✗');
	assert.ok(/DESKTOP_PANE_GRAB_H/.test(src), '必须有抓手带高度（原生视图盖住 DOM ⇒ 抓手只能落在栏顶空隙）✗');
	assert.ok(/data-vssaros-pane-grab/.test(src), '抓手带必须有稳定锚点 ✗');
	assert.ok(/_showPaneMenu/.test(src), '必须有右键兜底菜单（不能只靠拖拽）✗');
	assert.ok(/_closePane/.test(src), '菜单里要能关掉某一栏 ✗');
	// ⚠⚠ 负对照（2026-10-29 真机日志踩过）：aux（子）窗口的 JS 上下文**禁止** createElement
	//   ⇒ 抓手带 / 分隔条 / 预览框 / 菜单**全都建不出来**（表现为"分屏能开、但拖不动"）✗✗
	//   ⇒ 往 aux 里插的 DOM 元素**一律用主窗口 document 建** ⇒ 这条不许回退。
	assert.ok(!/ownerDocument\.createElement/.test(src), '不许用 container.ownerDocument.createElement（aux 子窗口禁 createElement ⇒ 抓手建不出来 ⇒ 拖不动）✗');
	assert.ok(/_createInMainWindow/.test(src), '必须统一走 _createInMainWindow（主窗口 document）✗');
	// ⚠ 负对照二（2026-10-29 真机）：aux 容器的 DOM 层默认 **pointer-events:none**（工作台层不可交互）
	//   ⇒ 抓手带/分隔条**必须显式**写 pointer-events:auto，否则"建得出来、看得见，却收不到 mousedown"
	//   ⇒ 表现为"分屏能开、但拖不动"✗✗（自绘标题条一直写着这一句 ⇒ 照抄它）。
	// ⚠ 断言别钉"紧邻形态"（中间隔了多少个属性不该管）⇒ 用 `[^'"]*` 而不是 `[^;]*`（后者跨不过分号）
	assert.ok(/cursor:grab[^'"]*pointer-events:auto/.test(src), '抓手带必须显式 pointer-events:auto（否则收不到 mousedown ⇒ 拖不动）✗');
	assert.ok(/cursor:col-resize[^'"]*pointer-events:auto/.test(src), '分隔条必须显式 pointer-events:auto（否则拖比例也不动）✗');
	// ⚠ 树的纯函数必须在 common 里（可单测）⇒ 不能把几何写回渲染侧
	const layoutSrc = stripComments(read(path.join(ROOT, 'src/vs/sessions/contrib/dshHarness/common/dshSplitLayout.ts')));
	assert.ok(/export function computeSplitLayout/.test(layoutSrc), 'common/dshSplitLayout.ts 必须导出 computeSplitLayout ✗');
	assert.ok(/export function moveSplitLeaf/.test(layoutSrc), 'common/dshSplitLayout.ts 必须导出 moveSplitLeaf ✗');
});

check('★ 栏操作菜单（C 方案）：页面「⋯」菜单 + 桥 paneAction（拖拽在 aux DOM 层做不到）', () => {
	const sessions = stripComments(read(SESSIONS));
	assert.ok(/data-vssaros-pane-menu/.test(sessions), '页面必须有「⋯」栏菜单入口 ✗');
	assert.ok(/api\.paneAction\(/.test(sessions), '菜单项必须调 bridge.paneAction ✗');
	for (const action of ['moveLeft', 'moveRight', 'moveTop', 'moveBottom', 'close']) {
		assert.ok(sessions.includes('"' + action + '"'), `菜单必须提供 ${action} ✗`);
	}
	const protocol = stripComments(read(PROTOCOL));
	assert.ok(/readonly method: 'paneAction'/.test(protocol), '协议必须声明 paneAction ✗');
	assert.ok(/case 'paneAction':/.test(protocol), '校验器必须有 case（漏了会被静默丢弃 ✗）');
	const preload = read(PRELOAD);
	assert.ok(/paneAction:\s*\(action[^)]*\)\s*=>\s*invoke\(\{\s*method:\s*'paneAction'/.test(preload),
		'preload 必须暴露 paneAction ✗');
	const host = stripComments(read(HOST));
	assert.ok(/case 'paneAction':/.test(host), '宿主必须有 case（漏了 = 点了没反应 ✗）');
	assert.ok(/paneDshChatPane\(viewId, command\.action\)/.test(host), '宿主必须按 viewId 交给"栏动作"✗');
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
