/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-globals */

/**
 * dsh 视图的 preload（sandbox + contextIsolation）：向页面暴露 `window.vssarosDsh`（页面桥 v1），
 * 并把页面未处理的工作台快捷键转发给 VsSaros（做法同上游 preload-browserView）。
 *
 * 独立脚本：不能有 import / export（构建按非打包的 CJS 脚本产出），常量需与
 * `common/dshPageBridgeProtocol.ts` 保持一致（单测会比对）。
 */
(function () {

	const { contextBridge, ipcRenderer } = require('electron');

	const INVOKE = 'vssaros:dsh:page';
	const KEYDOWN = 'vssaros:dsh:keydown';
	const SURFACE_ARG = '--vssaros-dsh-surface=';
	const CHAT_ONLY_ARG = '--vssaros-dsh-chat-only=';
	const SESSION_ARG = '--vssaros-dsh-session=';
	const VIEW_ARG = '--vssaros-dsh-view=';

	const surfaceArg = process.argv.find(a => a.startsWith(SURFACE_ARG));
	const surface = surfaceArg ? surfaceArg.slice(SURFACE_ARG.length) : 'full';
	const chatOnlyArg = process.argv.find(a => a.startsWith(CHAT_ONLY_ARG));
	const chatOnly = chatOnlyArg ? chatOnlyArg.slice(CHAT_ONLY_ARG.length) !== '0' : false;
	// 本视图绑定的 dsh 会话 id（chatId → vssaros-chat-<chatId>，方案 7.x）；前端插件据此切会话。
	const sessionArg = process.argv.find(a => a.startsWith(SESSION_ARG));
	const sessionId = sessionArg ? sessionArg.slice(SESSION_ARG.length) : '';
	// 本视图在 VsSaros 侧的 viewId（surface=plugin-page 的插件页面用它自识别与打日志；
	// 路由由页面 location.pathname 决定，不重复传）。
	const viewArg = process.argv.find(a => a.startsWith(VIEW_ARG));
	const viewId = viewArg ? viewArg.slice(VIEW_ARG.length) : '';

	// 方案 5.13：聊天框里只保留聊天 UI —— 隐藏 dsh 的侧边栏（含品牌行、会话列表）与右侧栏
	// （轨迹 / 任务 / 交付物）。不做停用插件：实测停用会让客户端 boot 因服务缺失而失败。
	// 同内容常量在 common/dshPageBridgeProtocol.ts（单测比对）。
	const CHAT_ONLY_CSS = '[data-slot="sidebar"], [data-slot="rightbar"], [data-rightbar-col="true"] { display: none !important; }\ndiv:has(> [data-shell-overlay]) { grid-template-columns: 0 minmax(0, 1fr) 0 !important; }\n[data-sidebar-right-expand] { display: none !important; }';

	if (surface === 'chat' && chatOnly) {
		const style = document.createElement('style');
		style.textContent = CHAT_ONLY_CSS;
		let observer: MutationObserver | null = null;
		const attach = (): boolean => {
			if (!style.isConnected && document.head) {
				document.head.appendChild(style);
			}
			if (style.isConnected && observer) {
				observer.disconnect();
				observer = null;
			}
			return style.isConnected;
		};
		if (!attach()) {
			document.addEventListener('DOMContentLoaded', () => { attach(); }, { once: true });
			// 页面可能在 DOMContentLoaded 之前就把首屏画出来：结构一变就再试一次，避免闪一下整页。
			observer = new MutationObserver(() => attach());
			observer.observe(document.documentElement ?? document, { childList: true, subtree: true });
		}
	}

	// Ctrl/Cmd 组合中属于原生编辑的，留给页面处理（与上游一致）。
	const nativeCtrlCmd = {
		mac: { always: new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'backspace', 'delete']), noShift: new Set(['a', 'c', 'v', 'x', 'z']), withShift: new Set(['v', 'z']) },
		nonMac: { always: new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'home', 'end', 'backspace', 'delete']), noShift: new Set(['a', 'c', 'v', 'x', 'z', 'y']), withShift: new Set(['v', 'z']) },
	};

	window.addEventListener('keydown', event => {
		// eslint-disable-next-line no-restricted-syntax
		if (!(event instanceof KeyboardEvent) || !event.isTrusted || event.defaultPrevented) {
			return;
		}
		const nonEditing = event.key === 'Escape' || /^F\d+$/.test(event.key);
		if (!(event.ctrlKey || event.altKey || event.metaKey) && !nonEditing) {
			return;
		}
		if (event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta') {
			return;
		}
		const isMac = navigator.platform.indexOf('Mac') >= 0;
		if (event.altKey && !event.ctrlKey && !event.metaKey && (isMac || /^Numpad\d+$/.test(event.code))) {
			return;
		}
		const ctrlCmd = isMac ? event.metaKey : event.ctrlKey;
		if (ctrlCmd && !event.altKey) {
			const key = event.key.toLowerCase();
			const sets = nativeCtrlCmd[isMac ? 'mac' : 'nonMac'];
			if (sets.always.has(key) || sets[event.shiftKey ? 'withShift' : 'noShift'].has(key)) {
				return;
			}
		}
		// Escape 常被页面用于关闭弹层：页面没处理时才转发，且不阻止默认行为。
		if (event.key !== 'Escape') {
			event.preventDefault();
			event.stopPropagation();
		}
		ipcRenderer.send(KEYDOWN, {
			key: event.key, keyCode: event.keyCode, code: event.code,
			ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, repeat: event.repeat,
		});
	}, true);

	const invoke = (payload: object) => ipcRenderer.invoke(INVOKE, payload);

	const api = {
		// ⚠ 与 `common/dshPageBridgeProtocol.ts` 的 `DSH_PAGE_BRIDGE_VERSION` **必须同值**
		//   （`test/common/dshPageBridge.test.ts` 拿那个常量对账这里的字面量，只改一边必红 ✓）。
		bridgeVersion: 10,
		surface,
		sessionId: sessionId || null,
		// plugin-page 页面用它识别"我是哪个视图"（诊断 / 上报），与 location.pathname（路由）互补。
		viewId: viewId || null,
		// 把**当前插件页**在编辑区打开（2026-10-13，桥 2 → 3）：侧栏版是"摘要 + 入口"，完整版由编辑区
		// 承载，而**页面自己开不了编辑器** ⇒ 交宿主；宿主按模块页表**白名单**核对 route ✓。
		openModulePage: (route: string) => invoke({ method: 'openModulePage', route }),
		// 「工作台」组件的两个**单向动作**（2026-10-13）：只发"设成 true"的命令 —— dsh 侧读不到 IDE 的
		// pin / 显隐状态，所以没有"切换"语义可用 ✓（见协议里那两条命令的注释）。
		setWorkbenchPinned: (route: string, pinned: boolean) => invoke({ method: 'setWorkbenchPinned', route, pinned }),
		setWorkbenchHidden: (route: string, hidden: boolean) => invoke({ method: 'setWorkbenchHidden', route, hidden }),
		ping: () => invoke({ method: 'ping' }),
		openFile: (path: string, range?: { startLine?: number; endLine?: number }) => invoke({ method: 'openFile', path, startLine: range?.startLine, endLine: range?.endLine }),
		// 内存态 markdown（计划审阅等）→ IDE 编辑器区的 untitled 页（2026-10-15：dsh 开在它的右侧栏，
		//   我们壳没有侧栏 ⇒ 改投编辑器 ✓）。只带文本、不碰盘 ✓ —— 与页面桥"只收低风险界面命令"同口径 ✓。
		openMarkdown: (text: string, title?: string) => invoke({ method: 'openMarkdown', text, title }),
		reveal: (path: string) => invoke({ method: 'reveal', path }),
		// 工作台页 → **聊天草稿**（桥 4 → 5）：把一条引用推进当前活动的 dsh 聊天框。
		// ⚠ 与上面 `openFile`/`reveal` 不同：那些是"在本窗口打开"，这条是"投给另一个视图"，
		//   而且目标视图由**宿主**决定（插件页拿不到会话身份 ⇒ 页面无从自报，见协议注释）。
		//   没有活动聊天框时宿主会明确提示，不静默丢弃 ✓（页面无需自己兜底）。
		insertChatReference: (path: string, range?: { startLine?: number; endLine?: number }) => invoke({
			method: 'insertChatReference',
			path,
			startLine: range?.startLine,
			endLine: range?.endLine,
		}),
		// 在 VsSaros 集成终端里打开一个终端，并把命令**填进去（不执行**，用户自己按回车）：
		// 工具卡里"跑过的命令"要能一键重现（2026-10-13 用户要求）。**不做 runInTerminal** ——
		// 页面桥只允许低风险界面命令，替用户执行命令属于执行类能力 ✗（见协议里 openTerminal 的注释）。
		// 「看改动」：打开该文件的**未提交改动** diff（HEAD ↔ 工作区）—— 旧内容只有 git 知道，
		// 工作台拿不到扩展宿主 API ⇒ 走扩展命令（见协议注释 ✓）；没有未提交改动时宿主回退成直接打开文件 ✓
		showUncommittedDiff: (path: string) => invoke({ method: 'showUncommittedDiff', path }),
		openTerminal: (options?: { cwd?: string; command?: string }) => invoke({
			method: 'openTerminal',
			...(options && typeof options.cwd === 'string' ? { cwd: options.cwd } : {}),
			...(options && typeof options.command === 'string' ? { command: options.command } : {}),
		}),
		notify: (kind: string, text: string) => invoke({ method: 'notify', kind, text }),
		// 方案 5.15：已有会话切 preset = 换到该 preset 的专属会话（宿主派生 id + startSession +
		// rebind 回推）。空白会话由 chat-surface 直接走 dsh 官方 select，不经过这里。
		switchPreset: (presetId: string) => invoke({ method: 'switchPreset', presetId }),
		// 切到指定 dsh 会话（chat-surface 的「历史会话」菜单）；宿主校验并走既有 rebind 通路。
		openSession: (sessionId: string, agentPreset?: string) => invoke({ method: 'openSession', sessionId, agentPreset }),
		// 新建一个聊天页签（header 的「新建会话」/ Commands 的「Preset」行）：页面无法创建编辑器 ⇒
		// 由宿主执行官方命令。`agentPreset` 可选：带上则新页签直接绑该 preset 的专属会话
		// （chat-surface 的「切换 preset = 新建一个会话」就靠它）。
		newChat: (agentPreset?: string) => invoke({ method: 'newChat', agentPreset }),
		// **本页签内**新建会话（header 的「＋ 新建会话」）：宿主派生新 id → `session.start` → rebind 回推。
		// 与 `newChat`（新开页签）的区别只有落点。页面侧据此把"再来一段新对话"做成一步 ✓
		newSession: () => invoke({ method: 'newSession' }),
		// 把**当前会话**切到另一个 worktree（header 的 worktree 下拉；方案 C）：
		// 宿主派生带 `--wt-` 段的会话 id → `session.start({cwd})` → rebind 回推。
		// ⚠ 语义是"新开会话"（历史独立），preset 沿用当前值 —— UI 要如实写明（见协议注释）。
		switchWorktree: (path: string) => invoke({ method: 'switchWorktree', path }),
		// 打开 Agent 商城（输入框 Agents 面板的底部动作）：商城是编辑器页，页面自己开不了 ⇒ 交宿主。
		openAgentMarket: () => invoke({ method: 'openAgentMarket' }),
		// 打开原生 Agent 列表（花名册的宿主等价入口）；宿主找不到该视图时会回落资源管理页。
		openAgentRoster: () => invoke({ method: 'openAgentRoster' }),
		// 打开**技能商城**（桥 `8 → 9`，2026-10-15；dsh 集成页 `/x/skills/` 的置顶主入口按钮）：
		// 与 `openAgentMarket` 同源 —— 商城是 VsSaros 的编辑器页，**页面自己开不了** ⇒ 交宿主；
		// 宿主只把它转成 `agentStudio.openSkillMarket` 命令 ✓（不在宿主里 new EditorInput ✓）。
		openSkillMarket: () => invoke({ method: 'openSkillMarket' }),
		// 打开**某个资源条目的设置**（桥 `9 → 10`，2026-10-15）：「工具」页（`/x/skills/`，原集成页）里
		// **技能行 / MCP 行**的齿轮。`kind='skill'` ⇒ 资源管理详情页（改 SKILL.md / 启停 / 卸载）；
		// `kind='mcp'` ⇒ 真源文件 `<数据根>/mcp.json`（⚠ 不用 IDE 的 MCP 管理页：那份读的是
		// `{root}/mcp/<slug>/config.json`，**另一条通道** ⇒ 会"点了设置看到另一个列表" ✗）。
		// 与 `openAgentSettings` 同源：**页面开不了编辑器** ⇒ 交宿主；宿主只是把 IDE 自己的界面显示出来 ✓。
		openResourceSettings: (kind: string, id: string) => invoke({ method: 'openResourceSettings', kind, id }),
		// 打开**某个 bot 的 Agent 设置**编辑器页（桥 `5 → 6`；dsh 的 Agents 页 `/x/agents` 行内「设置」）。
		// agentId = `.agent.md` 的目录名（与 VsSaros `Agent.id` 同值，页面上就是行上的 id）；name 仅作显示回退。
		// 与 `openModulePage` 同理：**页面开不了编辑器** ⇒ 交宿主；宿主只负责把 IDE 自己的设置界面显示出来 ✓。
		openAgentSettings: (agentId: string, name?: string) => invoke({ method: 'openAgentSettings', agentId, name }),
		// 打开知识库设置 / 关系图谱（桥 `6 → 7`，2026-10-15）：与上面 `openAgentSettings` 同源 ——
		// **页面开不了中间栏编辑器** ⇒ 交宿主；两条都只是"把 IDE 自己的界面显示出来" ✓（不含写能力 ✓）。
		// ⚠ 宿主侧**不自己 new EditorInput** ✗：设置面板的 host 与图谱数据都来自知识库视图 ⇒
		//   它只把这两条转成 `agentStudio.kb.openSettings` / `.openGraph` 命令 ✓（单一实现 ✓）。
		openKbSettings: () => invoke({ method: 'openKbSettings' }),
		openKbGraph: () => invoke({ method: 'openKbGraph' }),
		// 知识库**增删**（桥 `7 → 8`，2026-10-15；用户要求"下拉框要有增删" ✓）——与上面两条同源：
		// 页面开不了系统选择器、也写不了 IDE storage ✗ ⇒ 交宿主；宿主只转成 IDE 自己的命令 ✓。
		// ⚠ 这两条**会改数据**（改清单 / 删库目录）⇒ 真源那两步各自带的**原生对话框**就是闸 ✓：
		//   `kbAddVault` 无参（选哪个目录由用户在原生对话框里定 ✓）、`kbRemoveVault` 只传库 id ✓
		//   （权威校验在宿主：必须命中 IDE 清单里的库 ⇒ 页面无法借它删任意路径 ✓）。
		kbAddVault: () => invoke({ method: 'kbAddVault' }),
		kbRemoveVault: (vaultId: string) => invoke({ method: 'kbRemoveVault', vaultId }),
		// 会话标题上报（外层页签）：chat-surface 在页面侧读到 dsh 会话标题后调用；
		// `title: null` = 暂无标题（宿主回落原标签文案）。只传展示文本，不传会话内容。
		sessionTitle: (title: string | null) => invoke({ method: 'sessionTitle', sessionId: sessionId || null, title }),
		// 本会话人格上报（历史会话 sideview 的标记）：`personaId: null` = 跟随 Agent 自带人设；
		// `applicable: false` = 本 preset 无人设段（切了也没有可观测变化）。会话 id 同样由 preload 注入。
		sessionPersona: (personaId: string | null, name?: string | null, applicable?: boolean) => invoke({ method: 'sessionPersona', sessionId: sessionId || null, personaId, name: name ?? undefined, applicable }),
	};

	try {
		contextBridge.exposeInMainWorld('vssarosDsh', api);

	// 主题同步（方案 5.13.2 P2）：工作台推 dsh token 覆盖层。preload 与页面是隔离世界但共享 DOM ——
	// 数据存 documentElement.dataset（插件晚于推送加载也能读到），事件经 DOM 派发给已加载的插件。
	const THEME_CH = 'vssaros:dsh:theme';
	const THEME_EVENT = 'vssaros-dsh-theme';
	ipcRenderer.on(THEME_CH, (_e: unknown, tokens: unknown) => {
		if (typeof tokens !== 'object' || tokens === null) {
			return;
		}
		if (document.documentElement) {
			document.documentElement.dataset.vssarosTheme = JSON.stringify(tokens);
		}
		document.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: tokens }));
	});

	// worktree 列表推送（同上机制：宿主侧 git 事实，页面桥单向 ⇒ 只能推）。
	// 插件晚于推送加载也能读到 ⇒ 同时写 documentElement.dataset。
	const WORKTREES_CH = 'vssaros:dsh:worktrees';
	const WORKTREES_EVENT = 'vssaros-dsh-worktrees';
	ipcRenderer.on(WORKTREES_CH, (_e: unknown, list: unknown) => {
		if (!Array.isArray(list)) {
			return;
		}
		if (document.documentElement) {
			document.documentElement.dataset.vssarosWorktrees = JSON.stringify(list);
		}
		document.dispatchEvent(new CustomEvent(WORKTREES_EVENT, { detail: list }));
	});

	// 插入文件引用（方案 5.5 onInsertReference）：工作台 → 页面插件（chat-surface 客户端
	// 用 inputActions.captureInsertion + insertText 落到草稿）。主进程侧已校验负载形状。
	const INSERT_CH = 'vssaros:dsh:insert';
	const INSERT_EVENT = 'vssaros-dsh-insert';
	ipcRenderer.on(INSERT_CH, (_e: unknown, reference: unknown) => {
		if (typeof reference !== 'object' || reference === null) {
			return;
		}
		// 诊断计数：区分"IPC 没到 preload"与"DOM 事件没到插件"（探针断言用）。
		if (document.documentElement) {
			document.documentElement.dataset.vssarosInsertIpc = String((Number(document.documentElement.dataset.vssarosInsertIpc ?? '0') || 0) + 1);
		}
		document.dispatchEvent(new CustomEvent(INSERT_EVENT, { detail: reference }));
	});

	// 重绑会话（方案 5.15）：视图创建后启动参数不可变，换绑走运行时消息；chat-surface 监听
	// DOM 事件后 openSession 新会话。负载形状主进程已校验，这里只透传字符串字段。
	const REBIND_CH = 'vssaros:dsh:rebind';
	const REBIND_EVENT = 'vssaros-dsh-rebind';
	ipcRenderer.on(REBIND_CH, (_e: unknown, payload: unknown) => {
		if (typeof payload !== 'object' || payload === null || typeof (payload as { sessionId?: unknown }).sessionId !== 'string') {
			return;
		}
		document.dispatchEvent(new CustomEvent(REBIND_EVENT, { detail: { sessionId: (payload as { sessionId: string }).sessionId } }));
	});

	// 会话重命名（外层页签 → 页面）：宿主在编辑器标签上发起、弹框拿到新标题后经这条推下来；
	// preload 只透传字符串字段，chat-surface 调 dsh 的 ctx.sessions.rename 并派 vssaros-dsh-renamed 回执。
	const RENAME_CH = 'vssaros:dsh:rename';
	const RENAME_EVENT = 'vssaros-dsh-rename';
	ipcRenderer.on(RENAME_CH, (_e: unknown, payload: unknown) => {
		if (typeof payload !== 'object' || payload === null || typeof (payload as { title?: unknown }).title !== 'string') {
			return;
		}
		document.dispatchEvent(new CustomEvent(RENAME_EVENT, { detail: { title: (payload as { title: string }).title } }));
	});

	// 计费样本（主进程的计费探针代理 → 页面）：chat-surface 的回合页脚按回合时间窗归属后渲染「积分」chip。
	// 负载形状主进程已构造（route/model/credit/status/at），这里只校验必备字段并透传（不做任何解释）。
	const CREDIT_CH = 'vssaros:dsh:credit';
	const CREDIT_EVENT = 'vssaros-dsh-credit';
	ipcRenderer.on(CREDIT_CH, (_e: unknown, payload: unknown) => {
		if (typeof payload !== 'object' || payload === null) {
			return;
		}
		const p = payload as { route?: unknown; at?: unknown };
		if (typeof p.route !== 'string' || typeof p.at !== 'number') {
			return;
		}
		document.dispatchEvent(new CustomEvent(CREDIT_EVENT, { detail: payload }));
	});
	} catch (error) {
		console.error(error);
	}
}());
