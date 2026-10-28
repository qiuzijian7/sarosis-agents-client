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
	const WORKBENCH_ARG = '--vssaros-dsh-workbench=';

	const surfaceArg = process.argv.find(a => a.startsWith(SURFACE_ARG));
	const surface = surfaceArg ? surfaceArg.slice(SURFACE_ARG.length) : 'full';
	const chatOnlyArg = process.argv.find(a => a.startsWith(CHAT_ONLY_ARG));
	const chatOnly = chatOnlyArg ? chatOnlyArg.slice(CHAT_ONLY_ARG.length) !== '0' : false;
	// 2026-10-18：把 chatOnly 暴露成 DOM 事实 —— 页面侧 chunk（是否装载工作台/多根侧栏）与
	// e2e（断言"官方整套 chrome 在不在"）都要判它，别再靠猜 CSS 有没有被插进去 ✓。
	try {
		const mark = () => { try { document.documentElement.dataset.vssarosChatOnly = chatOnly ? '1' : '0'; } catch { /* 文档还没就绪 */ } };
		if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', mark, { once: true }); } else { mark(); }
	} catch { /* 诊断位不影响任何功能 */ }
	// 本视图绑定的 dsh 会话 id（chatId → vssaros-chat-<chatId>，方案 7.x）；前端插件据此切会话。
	const sessionArg = process.argv.find(a => a.startsWith(SESSION_ARG));
	const sessionId = sessionArg ? sessionArg.slice(SESSION_ARG.length) : '';
	// 本视图在 VsSaros 侧的 viewId（surface=plugin-page 的插件页面用它自识别与打日志；
	// 路由由页面 location.pathname 决定，不重复传）。
	const viewArg = process.argv.find(a => a.startsWith(VIEW_ARG));
	const viewId = viewArg ? viewArg.slice(VIEW_ARG.length) : '';
	// 2026-10-22：`surface=workbench` 的模块路由（`/x/<module>/`）。只认这一种形状；其余一律当没给 ✓
	const workbenchArg = surface === 'workbench' ? process.argv.find(a => a.startsWith(WORKBENCH_ARG)) : undefined;
	const workbenchRouteRaw = workbenchArg ? workbenchArg.slice(WORKBENCH_ARG.length) : '';
	const workbenchRoute = /^\/x\/[a-z][a-z0-9-]*\/$/.test(workbenchRouteRaw) ? workbenchRouteRaw : '';

	// 方案 5.13：聊天框里只保留聊天 UI —— **只隐藏左侧栏**（品牌行 + 会话列表）。
	// ★ 2026-10-19（用户报「右侧缺少用户消息定位 UI」）：**右侧栏不再隐藏** —— 轨迹（含交互式
	//   时间概览 = 用户消息定位）就在右栏里；右栏折叠时宽度为 0，默认不占地方，点"展开右栏"才出来。
	// 不做停用插件：实测停用会让客户端 boot 因服务缺失而失败。
	// 同内容常量在 common/dshPageBridgeProtocol.ts（单测比对）。
	const CHAT_ONLY_CSS = '[data-slot="sidebar"] { display: none !important; }\ndiv:has(> [data-shell-overlay]) { grid-template-columns: 0 minmax(0, 1fr) auto !important; }';

	// `surface=workbench`（编辑区承载 React 工作台）同样只要主内容区：隐藏 dsh 左侧栏，工作台整页占满 ✓
	if ((surface === 'chat' && chatOnly) || surface === 'workbench') {
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
		// ★ 2026-10-19：`11 → 12`（新增 `kbFeishuSync` —— 知识库页「同步飞书」真的开始同步）。
		// ★ 2026-10-19：`12 → 13`（`openSession` 增加可选 `cwd` —— 宿主先 session.start 接管历史会话）。
		// ★ 2026-10-19：`13 → 14`（新增 `renameSession` —— 会话历史插件页右键重命名）。
		// ★ 2026-10-19：`14 → 15`（新增 `openMediaGallery` —— dsh 媒体库页置顶按钮开原生媒体库）。
		// ★ 2026-10-21：`15 → 16`（新增 `focusIde` —— 桌面窗口侧栏底部「IDE」入口回到 IDE 主窗口）。
		// ★ 2026-10-21：`16 → 17`（新增 `signInIde` / `signOutIde` —— 窗口里的登录接管 IDE 账号）。
		// ★ 2026-10-21：`17 → 18`（新增 `openSettings` / `openFeedback` —— 左下角账号菜单的两条菜单项）。
		// ★ 2026-10-23：`18 → 19`（新增 `upgradeRefresh` / `upgradeBundled` / `upgradeApp` —— desktop 窗口的「更新」入口）。
		// ★ 2026-10-26：`19 → 20`（新增 `importCodeWorkspace` —— 从 .code-workspace 导入多根工作区）。
		bridgeVersion: 21,
		surface,
		// ★ 2026-10-18：`chatOnly` 也放进 bridge（**同步可知**）。
		//   为什么不能只靠 `data-vssaros-chat-only`：那个 DOM 标记要等 DOMContentLoaded 才写，
		//   而插件 `apply()` 在 bundle 执行时就会跑 —— 早于标记 ⇒ 页面侧判不出"带官方 chrome"，
		//   工作台/多根侧栏 chunk 不装载 ⇒ 真机截图里工作区回到官方摊平态（UE5EA×2）、
		//   也没有「🗂 工作台」行 ✗。bridge 字段在 document-start 就有，判据必须用它 ✓。
		chatOnly,
		sessionId: sessionId || null,
		// plugin-page 页面用它识别"我是哪个视图"（诊断 / 上报），与 location.pathname（路由）互补。
		viewId: viewId || null,
		// `surface=workbench` 要打开的模块路由（`/x/<module>/`）；其他 surface 为 null。
		workbenchRoute: workbenchRoute || null,
		// 把**当前插件页**在编辑区打开（2026-10-13，桥 2 → 3）：侧栏版是"摘要 + 入口"，完整版由编辑区
		// 承载，而**页面自己开不了编辑器** ⇒ 交宿主；宿主按模块页表**白名单**核对 route ✓。
		openModulePage: (route: string) => invoke({ method: 'openModulePage', route }),
		// 「工作台」组件的两个**单向动作**（2026-10-13）：只发"设成 true"的命令 —— dsh 侧读不到 IDE 的
		// pin / 显隐状态，所以没有"切换"语义可用 ✓（见协议里那两条命令的注释）。
		setWorkbenchPinned: (route: string, pinned: boolean) => invoke({ method: 'setWorkbenchPinned', route, pinned }),
		setWorkbenchHidden: (route: string, hidden: boolean) => invoke({ method: 'setWorkbenchHidden', route, hidden }),
		ping: () => invoke({ method: 'ping' }),
		// ★ 2026-10-21（用户：「窗口中，登录功能，接入 ide 侧的登录，两侧的登录状态要求同步」）：
		//   dsh 窗口里的登录/登出**不自己登录**，而是请 IDE 走它那套账号流程（TOF/OA）⇒ 两侧同一份登录态 ✓。
		//   ⚠ 无参（页面不能指定"登录成谁"）✓；⚠ 桥只回 true ⇒ 登录结果由 IDE **推**回来（见下面的 auth 通道）✓。
		signInIde: () => invoke({ method: 'signInIde' }),
		signOutIde: () => invoke({ method: 'signOutIde' }),
		// ★ 2026-10-21（桥 `17 → 18`）：左下角账号菜单里的「⚙ 设置 / ✈ 意见反馈」。
		//   设置是"请 IDE 打开设置编辑器"（页面开不了）；
		//   反馈是"请宿主用系统浏览器打开飞书问卷"（2026-10-26 改为问卷，不再开 IDE 的 issue reporter）。
		//   ⚠ 两者都**无参** —— 页面不能传 URL（否则等于给了页面一个任意开窗能力 ✗）。
		openSettings: () => invoke({ method: 'openSettings' }),
		openFeedback: () => invoke({ method: 'openFeedback' }),
		// ★ 2026-10-23（桥 `18 → 19`）：desktop 窗口的「更新」入口。
		//   三条都是**单向**命令（只回 true）—— 状态由宿主经 `vssaros:dsh:upgrade` **推**回来，
		//   页面读 `document.documentElement.dataset.vssarosUpgrade` 或监听 `vssaros-dsh-upgrade` ✓。
		upgradeRefresh: () => invoke({ method: 'upgradeRefresh' }),
		upgradeBundled: (name: string) => invoke({ method: 'upgradeBundled', name }),
		upgradeApp: () => invoke({ method: 'upgradeApp' }),
		// 升级一件商城资产（技能 / MCP / 智能体 / 工作流 / 工作台）：`(kind, slug)`
		upgradeAsset: (kind: string, slug: string) => invoke({ method: 'upgradeAsset', kind, slug }),
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
		// 切到指定 dsh 会话（chat-surface 的「历史会话」菜单 / 会话历史插件页双击）；
		// 宿主校验并走既有 rebind 通路。`cwd` 可选：宿主据此先 `session.start` 把**历史会话拉活**
		// （否则不在 Host live 集合里的会话换绑后也打不开，见协议里 openSession 的注释）。
		openSession: (sessionId: string, agentPreset?: string, cwd?: string) => invoke({
			method: 'openSession',
			sessionId,
			...(agentPreset === undefined ? {} : { agentPreset }),
			...(cwd === undefined ? {} : { cwd }),
		}),
		// 新建一个聊天页签（header 的「新建会话」/ Commands 的「Preset」行）：页面无法创建编辑器 ⇒
		// 由宿主执行官方命令。`agentPreset` 可选：带上则新页签直接绑该 preset 的专属会话
		// （chat-surface 的「切换 preset = 新建一个会话」就靠它）。
		newChat: (agentPreset?: string) => invoke({ method: 'newChat', agentPreset }),
		// 重命名一条 dsh 会话（会话历史插件页右键；桥 14）：改名只能由**聊天页**做
		// （`ctx.sessions.rename` 在客户端）⇒ 宿主转交；没有聊天框绑着它时先绑（含 session.start 接管）。
		renameSession: (sessionId: string, title: string, opts?: { agentPreset?: string; cwd?: string }) => invoke({
			method: 'renameSession',
			sessionId,
			title,
			...(opts && typeof opts.agentPreset === 'string' ? { agentPreset: opts.agentPreset } : {}),
			...(opts && typeof opts.cwd === 'string' ? { cwd: opts.cwd } : {}),
		}),
		// **本页签内**新建会话（header 的「＋ 新建会话」）：宿主派生新 id → `session.start` → rebind 回推。
		// 与 `newChat`（新开页签）的区别只有落点。页面侧据此把"再来一段新对话"做成一步 ✓
		newSession: () => invoke({ method: 'newSession' }),
		// 把**当前会话**切到另一个 worktree（header 的 worktree 下拉；方案 C）：
		// 宿主派生带 `--wt-` 段的会话 id → `session.start({cwd})` → rebind 回推。
		// ⚠ 语义是"新开会话"（历史独立），preset 沿用当前值 —— UI 要如实写明（见协议注释）。
		switchWorktree: (path: string) => invoke({ method: 'switchWorktree', path }),
		// 让 **IDE 窗口原地进**某个工作区（桥 `10 → 11`，2026-10-16）：参数是 **IDE 侧** `Workspace.id`
		// （不是 dsh 的 workspaceId ✗）。与 `switchWorktree` 分工：这条只负责"窗口换工作区（多根一起进、
		// 不重载）"，会话仍由 `switchWorktree(根路径)` 起 ⇒ 两条各管一件事 ✓（见协议里的注释）。
		switchWorkspace: (workspaceId: string) => invoke({ method: 'switchWorkspace', workspaceId }),
		// 请 **IDE 侧**导入一个 `.code-workspace` 文件（桥 `19 → 20`，2026-10-26）：
		// 页面读不了文件、也没有文件选择器 ⇒ 只能请 IDE 做（选文件 → 解析 folders → 落一条多根
		// 工作区记录 → 各根注册进 dsh）。**只导入，不切窗口** ✓（页面桥是单向的 ⇒ 结果由 IDE 通知
		// + 工作区记录推送体现）。
		importCodeWorkspace: () => invoke({ method: 'importCodeWorkspace' }),
		// 打开 Agent 商城（输入框 Agents 面板的底部动作）：商城是编辑器页，页面自己开不了 ⇒ 交宿主。
		openAgentMarket: () => invoke({ method: 'openAgentMarket' }),
		// 打开原生 Agent 列表（花名册的宿主等价入口）；宿主找不到该视图时会回落资源管理页。
		openAgentRoster: () => invoke({ method: 'openAgentRoster' }),
		// 打开**技能商城**（桥 `8 → 9`，2026-10-15；dsh 集成页 `/x/skills/` 的置顶主入口按钮）：
		// 与 `openAgentMarket` 同源 —— 商城是 VsSaros 的编辑器页，**页面自己开不了** ⇒ 交宿主；
		// 宿主只把它转成 `agentStudio.openSkillMarket` 命令 ✓（不在宿主里 new EditorInput ✓）。
		openSkillMarket: () => invoke({ method: 'openSkillMarket' }),
		// 打开 **VsSaros 的媒体库**（桥 `14 → 15`，2026-10-19）：dsh 媒体库页 `/x/media/` 的置顶按钮。
		// 与 `openSkillMarket` 同源 —— 媒体库是原生 `EditorPane`（`MediaGalleryEditorInput`），
		// 页面（WebContentsView）创建不了编辑器 ⇒ 交宿主转成 `agentStudio.openMediaGallery` 命令 ✓。
		// ⚠ 它**取代**了原先的 `openModulePage('/x/media/')`：那条开的是 dsh 自己的文本列表页（没有缩略图）。
		openMediaGallery: () => invoke({ method: 'openMediaGallery' }),
		// 回到 **VsSaros IDE 主窗口**（桥 `15 → 16`，2026-10-21）：dsh 桌面窗口侧栏底部那行品牌/规模摘要
		// 就是它的入口（用户要求"窗口版中增加 IDE 入口可以进入 VsSaros 界面"）。
		// 页面拿不到窗口级 API（`window.focus()` 只能激活自己所在的窗口 ✗）⇒ 只能交宿主 `focusWindow` ✓。
		focusIde: () => invoke({ method: 'focusIde' }),
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
	/*
	 * ★ 2026-10-28：原生**文件夹选择器**（返回绝对路径；取消 ⇒ 空串）。
	 *   为什么不是普通页面能力：Electron 32+ 移除了 `File.path`，
	 *   页面里的 `<input type="file" webkitdirectory>` 只能给出相对路径
	 *   ⇒ 无法作为知识库 vault 的绝对目录。
	 *   走**专用通道**（不经页面命令白名单）：它需要返回一个字符串路径。
	 */
	pickFolder: () => ipcRenderer.invoke('vssaros:dsh:pick-folder'),
	// 方案 C2（桥 `20 → 21`）：一次点击 = 中栏会话 + 右栏设置（左右并排由宿主布局）
	openBot: (agentId: string, name?: string) => invoke({ method: 'openBot', agentId, name }),
		// 打开知识库设置 / 关系图谱（桥 `6 → 7`，2026-10-15）：与上面 `openAgentSettings` 同源 ——
		// **页面开不了中间栏编辑器** ⇒ 交宿主；两条都只是"把 IDE 自己的界面显示出来" ✓（不含写能力 ✓）。
		// ⚠ 宿主侧**不自己 new EditorInput** ✗：设置面板的 host 与图谱数据都来自知识库视图 ⇒
		//   它只把这两条转成 `agentStudio.kb.openSettings` / `.openGraph` 命令 ✓（单一实现 ✓）。
		openKbSettings: () => invoke({ method: 'openKbSettings' }),
		openKbGraph: () => invoke({ method: 'openKbGraph' }),
		// ★ 2026-10-19：**同步飞书**（桥 `11 → 12` 新增的命令）。
		//   ⚠⚠ 当时只改了「协议 + validate case + 宿主 handler」，**漏了这里** ⇒
		//   `window.vssarosDsh.kbFeishuSync` 根本不存在 ⇒ 页面只能走"旧宿主"兜底分支，
		//   用户看到的就是「当前宿主不支持一键同步（需要页面桥 12）」✗（真机报的这个）。
		//   教训：桥命令有**四处**要同步 —— 协议类型 / validatePageCommand 的 case /
		//   **preload 的 api 暴露** / 宿主 handler。全族守卫原先只查前两者（本轮已补第三个）。
		kbFeishuSync: () => invoke({ method: 'kbFeishuSync' }),
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

	// IDE **工作区记录**（多根工作区；2026-10-16）：与 worktree 同机制（宿主侧事实 + 单向桥 ⇒ 只能推）。
	// 页面拿它把 dsh 那边被**摊平**的 N 条记录合成"一个工作区 + 各根"（见协议里的长注释 ✓）。
	// ⚠ 推送缺席（旧宿主）时页面必须**回落**成"一条记录一行" ⇒ 这里不做任何兜底数据 ✓。
	const WORKSPACES_CH = 'vssaros:dsh:workspaces';
	const WORKSPACES_EVENT = 'vssaros-dsh-workspaces';
	ipcRenderer.on(WORKSPACES_CH, (_e: unknown, list: unknown) => {
		if (!Array.isArray(list)) {
			return;
		}
		if (document.documentElement) {
			document.documentElement.dataset.vssarosWorkspaces = JSON.stringify(list);
		}
		document.dispatchEvent(new CustomEvent(WORKSPACES_EVENT, { detail: list }));
	});

	// **IDE 登录态**（TOF/OA）推给页面（2026-10-21）：机制与上面那条逐字同款（dataset + DOM 事件）✓。
	// ⚠ 只推**展示投影**（signedIn / 登录名 / 工号 / 团队）—— 票据绝不下发到页面 ✓。
	// ⚠ 页面据此显示"与 IDE 同一份登录态"；页面点登录/登出走 `signInIde` / `signOutIde`（上面那两条）✓。
	const AUTH_CH = 'vssaros:dsh:auth';
	const AUTH_EVENT = 'vssaros-dsh-auth';
	ipcRenderer.on(AUTH_CH, (_e: unknown, payload: unknown) => {
		if (typeof payload !== 'object' || payload === null) {
			return;
		}
		const p = payload as Record<string, unknown>;
		if (typeof p.signedIn !== 'boolean') {
			return;
		}
		const info = {
			signedIn: p.signedIn,
			loginName: typeof p.loginName === 'string' ? p.loginName : '',
			staffId: typeof p.staffId === 'string' ? p.staffId : '',
			team: typeof p.team === 'string' ? p.team : '',
			// ★ 登录/登出**失败原因**（2026-10-21）：页面桥单向 ⇒ 失败必须靠这条推送才可见 ✓
			//   （只给一句人话；空串 ⇒ 不带这个键 ⇒ 页面不显示空错误条 ✓）。
			...(typeof p.error === 'string' && p.error ? { error: p.error.slice(0, 200) } : {}),
		};
		if (document.documentElement) {
			document.documentElement.dataset.vssarosAuth = JSON.stringify(info);
		}
		document.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: info }));
	});

	// **升级状态**推给页面（2026-10-23，桥 `18 → 19`）：机制与上面那条逐字同款（dataset + DOM 事件）✓。
	// 载荷已在主进程经 `validateUpgradeState` 校验过形状；这里再按"能不能安全序列化"兜一层。
	const UPGRADE_CH = 'vssaros:dsh:upgrade';
	const UPGRADE_EVENT = 'vssaros-dsh-upgrade';
	ipcRenderer.on(UPGRADE_CH, (_e: unknown, payload: unknown) => {
		if (typeof payload !== 'object' || payload === null) {
			return;
		}
		try {
			if (document.documentElement) {
				document.documentElement.dataset.vssarosUpgrade = JSON.stringify(payload);
			}
			document.dispatchEvent(new CustomEvent(UPGRADE_EVENT, { detail: payload }));
		} catch { /* 序列化失败不影响页面其它功能 */ }
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

		// ★ 2026-10-19：改名的**回执**（页面 → 工作台）—— 与上面那条互为反向。
		//   页面（`client.sessionLabel.js`）改完派 `vssaros-dsh-renamed`：成功带 `title`、失败带 `error`。
		//   ⇒ preload 把它上送主进程，主进程 fire `kind:'renamed'` 的页面事件 ⇒ 调用方（会话侧栏）
		//     才知道这次**到底改成了没有**（桥的 invoke 没有语义返回值，不能拿来当回执 ✗）。
		//   ⚠ 只透传字符串字段；`sessionId` 必填（否则调用方无从对回是哪条会话）。
		const RENAMED_CH = 'vssaros:dsh:renamed';
		const RENAMED_EVENT = 'vssaros-dsh-renamed';
		document.addEventListener(RENAMED_EVENT, (e: unknown) => {
		const d = (e as CustomEvent<unknown>).detail;
		if (typeof d !== 'object' || d === null) {
			return;
		}
		const p = d as { sessionId?: unknown; title?: unknown; error?: unknown };
		if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) {
			return;
		}
		ipcRenderer.send(RENAMED_CH, {
			sessionId: p.sessionId,
			...(typeof p.title === 'string' ? { title: p.title.slice(0, 500) } : {}),
			...(typeof p.error === 'string' ? { error: p.error.slice(0, 500) } : {}),
		});
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
