// @vssaros/dsh-chat-surface — 侧栏 Workspaces 区：多根工作区「单条目 + hover 详情卡」
//（稿 1，2026-10-17 用户拍板；mockup doc/dsh-multiroot-single-item-mockup.html，
// 效果图 doc/mockup-images/single-item-1.png；4 稿对比 doc/dsh-sidebar-multiroot-variants-mockup.html）
// package-local chunk（契约同 client.sessions.js）：主包用 require.async 取回 install()。
//
// ── 为什么替换官方整区（sidebar.workspaces，single/root）────────────────────
// dsh 的工作区模型只能单目录，宿主上报时把 IDE 多根工作区的各根**摊平**成 N 条记录
// ⇒ 官方 WorkspaceBrowser 里同一工作区出现 N 次（真机截图实证：UE5EA×2 / S1Game×2）✗。
// 修法 = 用 `priority: -10` 遮蔽官方占用者（升序取最低者渲染，同 hero.workspace 先例 ✓），
// 换成本组件：
//   · 多根工作区只显示**一行**（名字 + 「N 个根」徽标），会话直接挂在条目下、按时间排序；
//   · hover 条目弹**详情卡**：每个根的完整路径 / 是否主根 / 会话数，当前会话 cwd 所在根标绿框；
//   · 会话行的根标注按稿 1：**只有非主根**的会话才带根名小标签（VS Code「仅多根才加前缀」的
//     降噪口径 ✓）；
//   · 没被任何 IDE 记录认领的 dsh 条目保持**平铺**（回落契约，与 client.workspace.js 的
//     buildTree 同口径 ✓）；
//   · 搜索框（条目多时）、＋添加工作区（官方同一条链：uiWorkspace.pickDirectory + workspaces.create ✓）。
// ⚠ chat-only 形态侧栏整列被 CSS 裁掉 ⇒ 本区只在全窗可见；chat 形态注册是无害空转 ✓。
//
// ── 会话行操作（2026-10-29 用户要求；此前"官方菜单本版不带"的代价在此补齐）─────────────
// 需求：工作区里的**会话 item** 支持右键菜单（重命名 / 置顶，另加 复制会话 id / 归档）+ 拖拽移动位置。
// 四条都**只走官方服务**，不自造状态：
//   · 置顶 = `uiWorkspace.pinSession / unpinSession`（**Host 状态** ⇒ 跨窗口一致），
//     回读 `workspaces.list.pinnedSessionIds`；渲染口径对齐官方 `reconcileManualOrder`：
//     **pinned 恒在组首**，其余按 手动序 → 时间序（置顶不是"分区"，pinned 之间仍保持相对顺序 ✓）。
//   · 重命名 = `sessions.using(sid, {source:'workspaceOperation'}).binding.session.rename(title)`
//     （官方侧栏同一跳）。交互 = **就地输入**（Enter 保存 / Esc 取消 / 失焦取消；与 @vssaros/dsh-sessions 页同形态）。
//   · 复制会话 id = 剪贴板（http 下 `navigator.clipboard` 可能不存在 ⇒ 一律带 execCommand 降级）。
//   · 归档 = `uiWorkspace.archiveSession`。**不擅自 stopActivity**：正在跑的会话会被 Host 拒绝，
//     官方是弹二次确认，我们**如实说明**（由用户先停）—— 替用户停掉跑着的会话是不可接受的副作用 ✗。
// 拖拽 = **组内**排序（跨组 = 改会话 cwd，官方也不支持 ⇒ 显示禁止态）；置顶区与普通区**互不跨越**
// （否则"置顶恒在组首"失真）。顺序落 localStorage `vssaros.chatSurface.sessionOrder.v1`：
//   页面同 origin ⇒ 多窗口共享；**不用**官方 view store 存顺序 —— 它只暴露 write set（`setSessionOrder`），
//   读不回来（刷新后自己写的顺序也读不到）⇒ 自存自读更可靠。
// ⚠ 窗口模式（desktop）**没有宿主桥** ⇒ 每个操作的成败都必须**就地**渲染（`sessMsg`），不能只靠 notify ✗。
//
// ── 2026-10-26（用户报障：「窗口模式下工作区的 ＋ 点了没反应」+「工作区下有大量空会话」）──
// ① ＋按钮原来**三重静默失败**（窗口模式尤其致命）：
//    a) 取选择器用 `ctx.remote.directoryPicker` —— 官方 client-ui-workspace 的 inject 里
//       **声明了** "remote" + "remote.directoryPicker"，我们**只声明了** "remote" ⇒ 这个名字
//       不是我们的服务（动态 client 门面读不到）⇒ picker 恒 undefined ⇒ 直接早退。
//       ⇒ 改走**已声明**的 `ctx.uiWorkspace.pickDirectory()`（官方同一份能力；本仓
//         vssaros-workbenches 早就在用这条 ✓）。
//    b) 老代码读 `res.value.path`，而 `pickDirectory()` 返回的是**路径字符串**
//       （原生 picker 的 value 就是 path）⇒ 恒 undefined ⇒ 选完目录也什么都不做。
//    c) 失败只写 `state.addWorkspaceError`，而**它从来没被渲染过**（全仓只有赋值）⇒
//       100% 静默；且窗口模式**没有宿主桥**（`window.vssarosDsh` 不存在）⇒ 连
//       `bridge.notify` 也是空转 ⇒ 用户只看到"点了没反应"。⇒ 现在错误**就地渲染**。
// ② 空会话：官方 roster 的每条会话带 `blank` 位（dsh-api-session-controller/types/list.js），
//    官方侧栏同样按 `!row.blank` 过滤 ⇒ 我们照做（当前会话例外）⇒ 列表不再被空会话刷屏。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.workspaces.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "sidebar.workspaces";
		const WORKSPACE_EVENT = "vssaros-dsh-workspaces";
		const HOVER_DELAY_MS = 350;
		/**
		 * 会话行 hover 卡片的延迟（2026-11-02，对齐官方 `SessionNodeItem` 的
		 * `HoverCard openDelayMs={800}`）。
		 * ⚠ 与工作区的 350ms 刻意不同：会话行是**高频划过**的列表，350ms 会一路弹卡；
		 *   官方取 800ms 就是"停一下才给详情"的意思。
		 */
		const SESS_HOVER_DELAY_MS = 800;

		// ── 纯逻辑（__test 可直接断言）────────────────────────────────────────
		function samePath(a, b) {
			if (!a || !b) { return false; }
			const n = (p) => String(p).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
			return n(a) === n(b);
		}
		function baseName(p) {
			const s = String(p || "").replace(/[\\/]+$/, "");
			const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
			return i >= 0 ? s.slice(i + 1) : s;
		}
		/** 与 client.workspace.js 的 parseWorkspaces 同形（chunk 间不共享代码，各持一份小实现 ✓）。 */
		function parseRecords(raw) {
			let list = null;
			try { list = raw ? JSON.parse(raw) : null; } catch { return []; }
			if (!Array.isArray(list)) { return []; }
			const out = [];
			for (const w of list) {
				if (!w || typeof w !== "object" || typeof w.id !== "string" || !w.id) { continue; }
				const roots = (Array.isArray(w.roots) ? w.roots : [])
					.filter((r) => r && typeof r.path === "string" && r.path)
					.map((r) => ({
						path: r.path,
						name: (typeof r.name === "string" && r.name.trim()) ? r.name.trim() : baseName(r.path),
						isPrimary: r.isPrimary === true,
					}));
				if (roots.length === 0) { continue; }
				out.push({
					id: w.id,
					name: (typeof w.name === "string" && w.name.trim()) ? w.name.trim() : (baseName(roots[0].path) || roots[0].path),
					roots,
					codeWorkspacePath: (typeof w.codeWorkspacePath === "string" && w.codeWorkspacePath) ? w.codeWorkspacePath : null,
				});
			}
			return out;
		}
		function readRecords() {
			try {
				if (typeof document === "undefined" || !document.documentElement) { return []; }
				return parseRecords(document.documentElement.dataset.vssarosWorkspaces);
			} catch { return []; }
		}
		/**
		 * 折叠状态切换（2026-10-17 真机 bug 的修复）。
		 *
		 * 约定：`collapsed[key] === true` 才算折叠（undefined / false 都是展开）。
		 * ★ 第一版写的是 `set(key, !isOpen)`：`isOpen = collapsed[key] !== true` ⇒ 展开态点击
		 *   写入 **false**（= 显式展开），永远写不进 true ⇒ **点了无法收缩** ✗（真机实证）。
		 *   正确写法是"把当前 isOpen 存进去"（展开 ⇒ true 折叠；折叠 ⇒ false 展开）。
		 *   相对比较型断言救不了这种 bug（两次取值恒相反）⇒ 守卫 ⑤ 钉**绝对期望值** ✓。
		 */
		function nextCollapsed(collapsed, key) {
			const cur = collapsed && collapsed[key] === true;
			return Object.assign({}, collapsed, { [key]: !cur });
		}
		function timeLabel(at) {
			if (!at) { return ""; }
			const s = Math.max(0, Math.round((Date.now() - at) / 1000));
			if (s < 60) { return "刚刚"; }
			const m = Math.floor(s / 60);
			if (m < 60) { return m + " 分钟"; }
			const h = Math.floor(m / 60);
			if (h < 24) { return h + " 小时"; }
			return Math.floor(h / 24) + " 天";
		}

		// ══════════ 侧栏「会话 / Bots」页签（2026-11-02，Bots 工作台重构）══════════
		//
		// 用户要求（2026-11-02）：「左侧栏里『工作区』那块改成 **会话 / Bots** 两个页签；
		//   会话 = 现在的工作区内容；Bots = bot 列表 + 群聊列表；点 bot ⇒ 中栏就是 dsh 聊天框」。
		//
		// 为什么落在本 chunk：`sidebar.workspaces` 这个槽由本 chunk **独占**（priority -10 遮蔽官方
		//   WorkspaceBrowser）⇒ 页签只能长在这块里。另开一列会吃掉 250px 里本就紧张的行宽 ✗。
		//
		// 数据面**只走 agents 插件的同源 HTTP**（与 chat-surface 的 Bots 选择器同一条）：
		//   · `/x/agents/api/home`  → agents[]（含 presetId / registered）+ home[agentId].sessions[0..n]
		//     （**最近会话带 id** ⇒ 点 bot 能直接打开它，不必每次新建一条空会话 ✓）
		//   · 没有会话时：`POST /api/session { agentPreset }` 新建，再 `openSession`
		// ⚠ 任何失败都**就地渲染**（窗口模式没有宿主桥 ⇒ notify 是空转，与 ＋ 菜单同一口径）。
		const SIDEBAR_VIEW_KEY = "vssaros.chatSurface.sidebarView.v1";
		const AGENTS_API_HOME = "/x/agents/api/home";
		const AGENTS_API_SESSION = "/x/agents/api/session";
		/** ★ 2026-11-05 多 bot 群聊（vssaros-agents lib/rooms.js）：列表 / 置顶 / 隐藏 / 改名 / 删群。 */
		const AGENTS_API_ROOMS = "/x/agents/api/rooms";
		/** 全局「群执行中」浮层与 Bots 页签实时刷新用的增量取数（2026-11-05，对齐 DS Bot roomProgress / state）。 */
		const AGENTS_API_ROOMS_ACTIVE = AGENTS_API_ROOMS + "?active=1";
		/** P1：浮层轮询发现群列表变了就发这个事件，Bots 页签立刻合并，不必等下一次 2s 轮询。 */
		const ROOMS_CHANGED_EVENT = "vssaros-rooms-changed";
		/** 只读 MemberDock 的事件源：全局浮层把同一份 `?active=1` 进度广播给 composer dock。 */
		const GROUP_PROGRESS_EVENT = "vssaros-group-progress";
		/** composer dock 可见时通知全局浮层让位：打开群/成员会话后不再在右栏叠一张「已发到…」tip。 */
		const GROUP_DOCK_VISIBILITY_EVENT = "vssaros-group-composer-dock-visibility";
		/**
		 * ★ 2026-11-06（用户要求）：页面自己已经展示群进度时，在根节点上声明这个属性，全局「已发到…」tip 就不显示。
		 *   SuperAgent 工作台用它（它的对话卡片和执行页已有群运行）。只是不画 tip；轮询与 `vssaros-group-progress` 广播照旧。
		 */
		const GROUP_TIP_OFF_ATTR = "data-vssaros-group-tip";
		/**
		 * 当前有没有**看得见的**页面声明了 `data-vssaros-group-tip="off"`（纯函数，`visible` 可注入）。
		 * 工作台切走时外壳可能只是把它藏起来而不卸载 ⇒ 必须看可见性，不能只看节点在不在。
		 */
		function groupTipSuppressed(doc, visible) {
			try {
				const isVisible = visible || ((el) => !!el.isConnected && typeof el.getClientRects === "function" && el.getClientRects().length > 0);
				const marks = doc && typeof doc.querySelectorAll === "function" ? doc.querySelectorAll("[" + GROUP_TIP_OFF_ATTR + "='off']") : [];
				for (const el of Array.from(marks)) { if (isVisible(el)) { return true; } }
			} catch { /* 读不到 DOM ⇒ 照常显示 */ }
			return false;
		}
		/**
		 * 读一条会话的**首条真实用户消息**（host 侧只读路由；2026-11-02）。
		 * 用途：把「未命名」补成可读标题 —— dsh 自己没有自动标题能力，`title` 只来自
		 * `session/title` 事件，所以只能由我们读日志 + 调官方 `session.rename` 写回。
		 */
		const FIRST_PROMPT_API = "/x/chat-surface/api/first-prompt";
		/**
		 * agents 插件的两个**写**接口（2026-11-02 用户要求「＋ 表示新建 bot 或群聊」）：
		 *   · `POST /x/agents/api/agents { action:'create', draft }`  —— `draft` 见 agents 的 `core/create.js`：
		 *     `name`（必填）、`id`（必填，`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`）、`role`、`description`、`icon`…
		 *     ⚠ id 必须英文/数字（`suggestIdFromName` 对纯中文返回空）⇒ 表单里给一个可编辑的 id 输入框；
		 *   · `POST /x/agents/api/groups { action:'create', name, members[] }` —— members 至少 1 个且必须真实存在。
		 */
		const AGENTS_API_AGENTS = "/x/agents/api/agents";
		/**
		 * 让宿主准备「默认工作区」目录（`<DSH_HOME>/VsSaros`，只 mkdir、不写文件 ⇒ 幂等）。
		 * 为什么需要它：官方 `workspaces.initializeDefault()` 只在**一个工作区都没有**时生效
		 * （有工作区时实测返回 `undefined`），而 `workspaces.create({ path })` 又要"已存在的绝对路径"。
		 */
		const DEFAULT_WS_API = "/x/chat-surface/api/default-workspace";

		function readSidebarView() {
			try {
				const v = typeof localStorage !== "undefined" ? localStorage.getItem(SIDEBAR_VIEW_KEY) : null;
				return v === "bots" ? "bots" : "sessions";
			} catch { return "sessions"; }
		}
		function writeSidebarView(v) {
			try {
				if (typeof localStorage !== "undefined") {
					localStorage.setItem(SIDEBAR_VIEW_KEY, v === "bots" ? "bots" : "sessions");
				}
			} catch { /* 存不了只影响下次启动的默认页签 */ }
		}
		/**
		 * bot 行的「最近一条会话 id」（没有 ⇒ 空串 ⇒ 点击时新建）。
		 * **纯函数**：`__test` 直接断言（数据形状来自 `buildHomeData`，见 agents 插件 lib/home.js）。
		 */
		function latestSessionIdOf(home, agentId, usable) {
			const row = (home && home[agentId]) || {};
			const list = Array.isArray(row.sessions) ? row.sessions : [];
			// `usable(sid)`（可选）：返回 false ⇒ 跳过这条。用来排除**确知没有工作区**的会话
			// （官方 hero 会对它显示「选择一个工作区开始」并禁用输入框 —— 2026-11-02 用户截图「bot 聊天框无法输入」）。
			const hit = list.filter((s) => s && typeof s.id === "string" && s.id
				&& (typeof usable !== "function" || usable(s.id) !== false))[0];
			return hit ? hit.id : "";
		}
		/**
		 * 新建 bot 会话该登记进哪个工作区 ⇒ 返回 **dsh 的 workspaceId**（不是路径）。
		 *
		 * ★ 2026-11-02 两次修正（用户反复报「bot 聊天框无法输入」）：
		 *   第一版传 `cwd`，**方向错了**：官方 `session.create` 只给 cwd ⇒ 会话有目录但**不登记进工作区账本**；
		 *   而 hero 的输入框判据是 `inert = hero && chipTitle === undefined`，`chipTitle` 来自「账本里含该会话」的
		 *   工作区标题（账本就绪后不再用 cwd 兜底）⇒ 不在账本 ⇒ 灰输入框 + 工作区选择器写着「选择工作区」。
		 *   传 `workspaceId` ⇒ 官方建完会 `workspace.attachSession(sid)` ⇒ 登记 ✓（与 `cwd` 互斥，不能同时给）。
		 * 选取：**当前会话所在工作区**优先（用户眼前的），否则快照第一个有 workspaceId 的；都没有 ⇒ 空串
		 * （调用方提示"先添加工作区"，不盲建 ✗）。纯函数：`__test` 直接断言。
		 */
		function pickBotWorkspaceId(currentSessionId, wsSnap) {
			const items = (wsSnap && Array.isArray(wsSnap.items)) ? wsSnap.items : [];
			const usable = items.filter((it) => it && typeof it.workspaceId === "string" && it.workspaceId);
			if (currentSessionId) {
				const own = usable.filter((it) => Array.isArray(it.sessionIds) && it.sessionIds.indexOf(currentSessionId) >= 0)[0];
				if (own) { return own.workspaceId; }
			}
			return usable[0] ? usable[0].workspaceId : "";
		}
		/** 该会话是否已**登记进某个工作区账本**（没登记 ⇒ 官方 hero 会禁用输入框）。 */
		function isRegisteredSession(sid, wsSnap) {
			const items = (wsSnap && Array.isArray(wsSnap.items)) ? wsSnap.items : [];
			return items.some((it) => it && Array.isArray(it.sessionIds) && it.sessionIds.indexOf(sid) >= 0);
		}
		// ── Bots 名册的**缓存优先 + 超时**（2026-11-02 用户报「读取名册太慢了」）───────────────
		//
		// 现场：切到 Bots 页签后一直停在「正在读取名册…」。`/x/agents/api/home` 是慢接口
		//   （host 侧要汇总每个 agent 的最近会话，本机 284 条会话时明显偏慢）⇒ 在它返回之前
		//   整块是白屏，用户只能干等。
		//
		// 口径（与侧栏其它数据一致：**先给能看的，再纠正**）：
		//   · 上次结果落 localStorage ⇒ 进页签**立刻渲染**（标「缓存」），后台静默刷新；
		//   · 请求加 8s 超时 ⇒ 永不无限期停在 loading；超时后**保留缓存内容**并说明原因；
		//   · 缓存只存展示所需字段（agents/home/groups/at），不放任何敏感物。
		/**
		 * 「已从列表移除的工作区」持久化键（2026-11-02 用户报「删除的工作区重启后又显示出来」）。
		 *
		 * 为什么必须落盘：`workspaces.delete` 只摘 dsh 登记，**IDE 记录仍在** ⇒ 行还是会被
		 *   `buildSidebar` 的 group 分支渲染出来。只把 record.id 记在内存里的话，重启/重载就丢
		 *   ⇒ 行"复活" ✗。落 localStorage 才能真的持续隐藏；同时给一个「恢复已移除的工作区」入口，
		 *   否则用户永远找不回（只能清缓存）。
		 */
		const WS_REMOVED_KEY = "vssaros.ws.removed.v1";
		function readRemovedWs() {
			try {
				if (typeof localStorage === "undefined") { return []; }
				const raw = localStorage.getItem(WS_REMOVED_KEY);
				if (!raw) { return []; }
				const a = JSON.parse(raw);
				return Array.isArray(a) ? a.filter((x) => typeof x === "string" && x) : [];
			} catch { return []; }
		}
		function saveRemovedWs(list) {
			try {
				if (typeof localStorage === "undefined") { return; }
				localStorage.setItem(WS_REMOVED_KEY, JSON.stringify(Array.isArray(list) ? list : []));
			} catch { /* 存不下只影响下次启动仍会显示 */ }
		}
		const BOTS_CACHE_KEY = "vssaros.ws.bots.v1";
		const BOTS_TIMEOUT_MS = 8000;
		function readBotsCache() {
			try {
				if (typeof localStorage === "undefined") { return null; }
				const raw = localStorage.getItem(BOTS_CACHE_KEY);
				if (!raw) { return null; }
				const o = JSON.parse(raw);
				if (!o || !Array.isArray(o.agents)) { return null; }
				return {
					agents: o.agents,
					home: (o.home && typeof o.home === "object") ? o.home : {},
					rooms: Array.isArray(o.rooms) ? o.rooms : [],
					at: typeof o.at === "number" ? o.at : 0,
				};
			} catch { return null; }
		}
		function saveBotsCache(d) {
			try {
				if (typeof localStorage === "undefined") { return; }
				localStorage.setItem(BOTS_CACHE_KEY, JSON.stringify({
					agents: (d && d.agents) || [],
					home: (d && d.home) || {},
					rooms: (d && d.rooms) || [],
					at: Date.now(),
				}));
			} catch { /* 存不下只影响下次启动的首屏速度 */ }
		}
		/**
		 * 拉名册 + 群聊（★ 2026-11-05 群聊回归：`/api/rooms`，读不到不影响名册）。**纯取数**，供 `__test` 注入 fetch。
		 * （2026-11-03 下线的是旧群聊 `/api/groups`；新群聊是另一套，见 vssaros-agents lib/rooms.js。）
		 */
		function fetchBotsData(fetchImpl) {
			const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
			if (!f) { return Promise.resolve({ ok: false, error: "当前环境没有 fetch" }); }
			const getJson = (url) => Promise.resolve(f(url, { headers: { accept: "application/json" } }))
				.then((r) => (r && r.ok ? r.json() : Promise.reject(new Error("HTTP " + (r && r.status)))));
			const rooms = getJson(AGENTS_API_ROOMS).then(
				(j) => ({ rooms: Array.isArray(j && j.rooms) ? j.rooms : [], roomsError: "" }),
				(e) => ({ rooms: [], roomsError: String((e && e.message) || e) }));
			return Promise.all([getJson(AGENTS_API_HOME), rooms]).then(([home, r]) => ({
				ok: true,
				agents: Array.isArray(home && home.agents) ? home.agents : [],
				home: (home && home.home) || {},
				root: (home && home.root) || "",
				rooms: r.rooms,
				roomsError: r.roomsError,
				// ★ 2026-11-03：lazy 补齐还没结束 ⇒ 这份快照里"未注册"会虚高（启动时只注册了首批）。
				//   页签据此自动重拉一次，而不是把早期快照当成最终事实（用户报「为什么这么多未注册」）。
				presetsPending: home && home.presetsPending === true,
			})).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
		}
		/** 只拉群列表（Bots 页签开着时轮询 ⇒ 群执行后 preview / updatedAt 会自己变）。纯取数。 */
		function fetchRoomsOnly(fetchImpl) {
			const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
			if (!f) { return Promise.resolve({ ok: false, error: "当前环境没有 fetch", rooms: [] }); }
			return Promise.resolve(f(AGENTS_API_ROOMS, { headers: { accept: "application/json" } }))
				.then((r) => (r && r.ok ? r.json() : Promise.reject(new Error("HTTP " + (r && r.status)))))
				.then((j) => ({ ok: true, rooms: Array.isArray(j && j.rooms) ? j.rooms : [] }))
				.catch((e) => ({ ok: false, error: String((e && e.message) || e), rooms: [] }));
		}
		/** 只拉正在跑 / 刚跑完的群轮次（全局浮层轮询）。纯取数。 */
		function fetchRoomActivity(fetchImpl) {
			const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
			if (!f) { return Promise.resolve({ ok: false, error: "当前环境没有 fetch", active: [] }); }
			return Promise.resolve(f(AGENTS_API_ROOMS_ACTIVE, { headers: { accept: "application/json" } }))
				.then((r) => (r && r.ok ? r.json() : Promise.reject(new Error("HTTP " + (r && r.status)))))
				.then((j) => ({ ok: true, active: Array.isArray(j && j.active) ? j.active : [] }))
				.catch((e) => ({ ok: false, error: String((e && e.message) || e), active: [] }));
		}
		/** 群列表的可见指纹；变了才发 P1 事件，避免每 1s 都让 Bots 页签重渲染。纯函数。 */
		function roomsSignature(rooms) {
			return (Array.isArray(rooms) ? rooms : []).map((r) => [r && r.id, r && r.name, r && r.updatedAt, r && r.preview,
				r && r.pinned ? 1 : 0, r && r.hidden ? 1 : 0].join(":")).join("|");
		}
		/**
		 * ★ 2026-11-06 群执行跨插件契约（与 vssaros-agents core/rooms.js 的 ROUND_SCHEMA 同值）。
		 * 服务端已算好 `status/statusLabel`；下面的 `groupRoundStatus` 是**逐字副本**，只给旧数据（无 status）兜底。
		 * check-bots-rooms.mjs 用同一张用例表钉 agents / 本文件 / conversationViews / superagent 四处一致。
		 */
		const GROUP_ACTIVITY_SCHEMA = 1;
		const GROUP_ROUND_LABELS = { sent: "已发到群", replying: "正在回答", done: "已完成", cut: "已中断", failed: "执行失败" };
		function groupRoundStatus(round) {
			const r = round && typeof round === "object" ? round : {};
			if (GROUP_ROUND_LABELS[r.status]) { return r.status; }
			const events = Array.isArray(r.events) ? r.events : [];
			if (r.interrupted || r.phase === "cut" || events.some((event) => event && event.kind === "cut")) { return "cut"; }
			if (!r.done) {
				const speaking = Array.isArray(r.speaking) ? r.speaking.length : 0;
				return speaking > 0 ? "replying" : "sent";
			}
			return r.error ? "failed" : "done";
		}
		/** 归一化 `?active=1` 列表：丢掉坏项、补 status/statusLabel、数组字段兜底。纯函数。 */
		function normalizeGroupActivity(list) {
			return (Array.isArray(list) ? list : []).filter((item) => item && typeof item === "object" && item.roomId)
				.map((item) => {
					const status = groupRoundStatus(item);
					const asks = Array.isArray(item.asks) ? item.asks.filter((a) => a && a.id) : [];
					const busy = Array.isArray(item.busy) ? item.busy.map(String).filter(Boolean) : undefined;
					return Object.assign({}, item, busy ? { busy } : null, {
						// 状态机不变；这一轮做完了但有选择卡等人答 ⇒ 不能说「已完成」（与 rooms.js roundOutput 同口径）
						schema: Number(item.schema) || GROUP_ACTIVITY_SCHEMA, status, asks,
						statusLabel: status === "done" && asks.length ? "等你选择" : status === "done" && busy && busy.length ? "后台干活中" : GROUP_ROUND_LABELS[status],
						replies: Array.isArray(item.replies) ? item.replies : [], events: Array.isArray(item.events) ? item.events : [],
						speaking: Array.isArray(item.speaking) ? item.speaking : [], passed: Array.isArray(item.passed) ? item.passed : [],
						failed: Array.isArray(item.failed) ? item.failed : [],
					});
				});
		}
		/**
		 * 活动指纹：内容没变就不广播、不 setState。运行中的轮次额外带一个 5s 时间桶，
		 * 让「用时」类文案至多 5s 刷新一次，而不是每秒驱动所有订阅方重渲染。纯函数。
		 */
		function activitySignature(list, at) {
			const bucket = Math.floor(Number(at || 0) / 5000);
			return (Array.isArray(list) ? list : []).map((item) => [item.callId, item.roomId, item.status, item.roomName,
				(item.replies || []).length, (item.events || []).length, (item.speaking || []).join(","),
				(item.failed || []).length, (item.passed || []).length, item.finishedAt || 0,
				// ★ 2026-11-06：待审批变化（新请求 / 被批 / 超时撤回）也要广播，成员栏的「允许 / 拒绝」才跟得上
				(Array.isArray(item.approvals) ? item.approvals : []).map((a) => a && a.id).join(","),
				// ★ 2026-11-07：选择卡出现 / 被答掉也要广播，输入框上方的卡才跟得上
				(Array.isArray(item.asks) ? item.asks : []).map((a) => a && a.id).join(","),
				// ★ 2026-11-07：后台成员干完（离开 busy）也要广播，群行 / 成员行才会从「后台干活」变回去
				(Array.isArray(item.busy) ? item.busy : []).join(","),
				item.status === "sent" || item.status === "replying" ? bucket : ""].join(":")).join("|");
		}
		/**
		 * ★ 2026-11-05：把 `?active=1` 的群轮次聚合成左侧 bot item 的 DS Bot 状态。
		 * 状态词表对齐 DeepSeek-Bot `mark.js`：thinking/working/searching/sending/orbit/waiting/alert/done/idle。
		 * `speaking[] / passed[] / events[].name` 只有名字，用 roomView.members 或 bots 名册把 name 映射回 id。
		 * 纯函数，便于守卫直接断言；没有活动 ⇒ idle，老 DOM 形状完全不变。
		 */
		function botStateOf(active, agent, rooms) {
			const id = String((agent && agent.id) || "");
			const name = String((agent && agent.name) || id);
			const key = (value) => String(value || "").trim().toLowerCase();
			const roomList = Array.isArray(rooms) ? rooms : [];
			const rounds = Array.isArray(active) ? active : [];
			const roomOf = (round) => roomList.find((r) => r && (r.id === round.roomId || r.sessionId === round.roomId));
			const memberIdOfName = (round, value) => {
				const room = roomOf(round);
				const hit = room && Array.isArray(room.members) ? room.members.find((m) => m && key(m.name) === key(value)) : null;
				return hit ? String(hit.id) : "";
			};
			const isAgent = (round, botId, who) => {
				if (botId && String(botId) === id) { return true; }
				if (who && (key(who) === key(name) || key(who) === key(id))) { return true; }
				return !!who && memberIdOfName(round, who) === id;
			};
			const stateFromText = (text) => {
				const value = String(text || "");
				if (/搜索|查找|读取|浏览|检索|read|search|fetch|grep|glob|list/i.test(value)) { return "searching"; }
				if (/发送|转交|派发|post|message|create|submit/i.test(value)) { return "sending"; }
				return "working";
			};
			const result = (round, state, short, eventKind) => ({
				state, label: (round.roomName ? round.roomName + " · " : "") + String(short || ""),
				roomId: String(round.roomId || ""), roomName: String(round.roomName || ""), eventKind: String(eventKind || ""),
			});
			for (const round of rounds) {
				if (!round || typeof round !== "object") { continue; }
				const room = roomOf(round);
				const member = room && Array.isArray(room.members) ? room.members.find((m) => m && String(m.id) === id) : null;
				// ★ 2026-11-07：它提了问、在等用户选（比这一轮别的状态都新）
				const myAsk = (Array.isArray(round.asks) ? round.asks : []).find((a) => a && String(a.botId) === id);
				if (myAsk) { return result(round, "waiting", "等你选择 · " + ((myAsk.questions || []).length || 1) + " 个问题", "ask"); }
				// ★ 2026-11-07：服务端实时给出谁还在后台干活（`busy`）。在里面 ⇒ 干活中；有这个字段却不在里面 ⇒ 它已经干完了，
				//   不能再按这一轮那条「这一轮先不等它」事件显示成在干活
				const busy = Array.isArray(round.busy) ? round.busy : null;
				if (busy && busy.some((who) => isAgent(round, "", who))) { return result(round, "working", "在后台干活…", "background"); }
				const failed = Array.isArray(round.failed) ? round.failed : [];
				for (const item of failed) {
					if (item && isAgent(round, item.botId, item.name)) { return result(round, "alert", item.reason || "没能回答", "failed"); }
				}
				const events = Array.isArray(round.events) ? round.events : [];
				for (const event of events) {
					if (!event || !isAgent(round, "", event.name)) { continue; }
					const kind = String(event.kind || "");
					if (["failed", "missed", "cut"].includes(kind)) { return result(round, "alert", event.text || "需要你处理", kind); }
					if (kind === "paused") { return result(round, "waiting", event.text || "群聊本轮暂停", kind); }
				}
				const speaking = Array.isArray(round.speaking) ? round.speaking : [];
				if (speaking.some((who) => isAgent(round, "", who))) { return result(round, "thinking", "正在输入…", "speaking"); }
				const replies = Array.isArray(round.replies) ? round.replies : [];
				for (const reply of replies) {
					if (reply && !reply.kind && isAgent(round, reply.botId, reply.name)) { return result(round, "done", "已回复 · " + Math.max(1, Math.round(Number(reply.ms || 0) / 1000)) + "s", "reply"); }
				}
				const passed = Array.isArray(round.passed) ? round.passed : [];
				if (passed.some((who) => isAgent(round, "", who))) { return result(round, "done", "没有补充", "passed"); }
				for (const event of events) {
					if (!event || !isAgent(round, "", event.name)) { continue; }
					const kind = String(event.kind || "");
					if (kind === "working" && busy && /先不等它/.test(String(event.text || ""))) { continue; }
					if (kind === "working") { return result(round, stateFromText(event.text), event.text || "在做了…", kind); }
					if (kind === "resumed") { return result(round, "orbit", event.text || "群内待命…", kind); }
				}
				if (groupRoundStatus(round) === "cut" && member) { return result(round, "alert", "本轮被中断", "cut"); }
				if (round.error && member) { return result(round, "alert", round.error, "error"); }
				if (!round.done && member) { return result(round, "orbit", "群内待命…", "orbit"); }
				if (round.done && member) { return result(round, "done", "本轮完成", "done"); }
			}
			return { state: "idle", label: "", roomId: "", roomName: "", eventKind: "" };
		}
		/**
		 * ★ 2026-11-07（用户报「群聊的 item 没有实时更新状态」）：群行原来只画 `room.preview`（群里最后一条消息），
		 *   成员行都在动、群行却停在「用户：…」。这里把同一份 `?active=1` 轮次聚合成群这一行的状态，词表与 `botStateOf` 同。
		 *   优先级：等人批准 > 等人选择 > 正在回答 > 已发到群 > 中断 / 失败 > 成员还在后台干活 > 本轮完成。
		 *   没有这个群的轮次 ⇒ idle（行上照旧显示 preview）。纯函数，check-bots-rooms.mjs 直接断言。
		 */
		function roomStateOf(active, room) {
			const id = String((room && room.id) || "");
			const sid = String((room && room.sessionId) || id);
			const idle = { state: "idle", label: "", status: "", callId: "" };
			if (!id) { return idle; }
			const rounds = (Array.isArray(active) ? active : []).filter((r) => r && (String(r.roomId) === id || String(r.roomId) === sid));
			if (!rounds.length) { return idle; }
			const startedAt = (r) => Number(r.startedAt || 0);
			const byNewest = (a, b) => startedAt(b) - startedAt(a);
			const round = rounds.filter((r) => !r.done).sort(byNewest)[0] || rounds.slice().sort(byNewest)[0];
			const status = groupRoundStatus(round);
			const out = (state, label) => ({ state, label, status, callId: String(round.callId || "") });
			const approvals = (Array.isArray(round.approvals) ? round.approvals : []).filter(Boolean);
			if (approvals.length) {
				const first = approvals[0];
				return out("waiting", "等你批准：" + String(first.name || "成员") + (first.tool ? " 的 " + String(first.tool) : "")
					+ (approvals.length > 1 ? "（共 " + approvals.length + " 项）" : ""));
			}
			const asks = (Array.isArray(round.asks) ? round.asks : []).filter(Boolean);
			if (asks.length) {
				const total = asks.reduce((n, a) => n + ((a.questions || []).length || 1), 0);
				return out("waiting", "等你选择：" + String(asks[0].name || "成员") + (asks.length > 1 ? " 等 " + asks.length + " 位" : " 的 " + total + " 个问题"));
			}
			const events = (Array.isArray(round.events) ? round.events : []).filter(Boolean);
			if (status === "replying") {
				const speaking = Array.isArray(round.speaking) ? round.speaking : [];
				return out("thinking", speaking.length ? speaking.join("、") + " 正在输入…" : "正在回答…");
			}
			if (status === "sent") {
				const working = events.filter((e) => e.kind === "working" && e.text);
				return out("working", working.length ? String(working[working.length - 1].text) : "已发到群，等成员开始…");
			}
			if (status === "cut") { return out("alert", "本轮被中断"); }
			if (status === "failed") { return out("alert", "执行失败" + (round.error ? "：" + String(round.error) : "")); }
			// 这一轮结束了，但放行到后台的成员还没交结果（rooms.js 放行时发的那条 working 事件）
			const replies = (Array.isArray(round.replies) ? round.replies : []).filter((r) => r && !r.kind);
			// 服务端给了实时的 `busy` 就以它为准（干完的不再算）；老数据才从「这一轮先不等它」事件推
			const background = Array.isArray(round.busy) ? round.busy.map(String).filter(Boolean)
				: events.filter((e) => e.kind === "working" && e.name && /先不等它/.test(String(e.text || "")))
					.map((e) => String(e.name)).filter((name, i, all) => all.indexOf(name) === i && !replies.some((r) => r.name === name));
			if (background.length) { return out("working", background.join("、") + " 还在后台干活"); }
			return out("done", "本轮完成 · " + replies.length + " 条回复");
		}
		/**
		 * ★ 2026-11-07：新出现的选择卡要亮哪些群的未读点。人正看着那个群（输入框上方已经有卡）就不亮；每张卡只亮一次。
		 * @param seen 见过的卡 id（Set，就地更新）；纯函数便于守卫断言。
		 */
		function askUnreadTargets(list, seen, docked) {
			const open = Array.isArray(docked) ? docked.map(String) : [];
			const out = [];
			for (const item of Array.isArray(list) ? list : []) {
				for (const ask of Array.isArray(item && item.asks) ? item.asks : []) {
					if (!ask || !ask.id || seen.has(ask.id)) { continue; }
					seen.add(ask.id);
					const roomId = String(item.roomId || "");
					if (roomId && !open.includes(roomId) && !out.includes(roomId)) { out.push(roomId); }
				}
			}
			return out;
		}
		/**
		 * ★ 2026-11-06（用户报「正在执行任务的 bot，点击其 item，没有打开对应的对话窗口」）：
		 *   bot 在群里有活动（`botStateOf` 非 idle）时，点它该打开它**在那个群里的会话**（它正在干活的那条），
		 *   而不是它最近一条私聊。成员会话 id 来自 `/api/rooms` 的 `members[].sessionId`（agents 0.2.350+）；
		 *   这个群里它还没有会话（或老版本 agents 不给）⇒ 打开群会话本身。idle ⇒ 空串（走原来的「最近一条私聊」）。
		 * 纯函数：`__test` / check-bots-rooms.mjs 直接断言。
		 */
		function botOpenTargetOf(bs, agent, rooms) {
			if (!bs || bs.state === "idle" || !bs.roomId) { return ""; }
			const id = String((agent && agent.id) || "");
			const room = (Array.isArray(rooms) ? rooms : []).find((r) => r && (r.id === bs.roomId || r.sessionId === bs.roomId));
			if (!room) { return String(bs.roomId); }
			// 它在等用户选：要答的卡在群里，打开群（不是它自己那条会话）
			if (bs.eventKind === "ask") { return String(room.sessionId || room.id || bs.roomId); }
			const member = Array.isArray(room.members) ? room.members.find((m) => m && String(m.id) === id) : null;
			return String((member && member.sessionId) || room.sessionId || room.id || bs.roomId);
		}
		// ── 新建 Bot / 群聊：校验与预设（2026-11-02「弹出的 UI 框要完善」）──────────────
		//
		// 规则**与 host 同源**（不是自己另立一套）：
		//   · Bot：`name` 必填；`id` 必须过 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（agents `core/create.js` 的
		//     `AGENT_ID_RE`），且不能与既有目录重名（host 会 409，这里先拦）；
		// 都做成**纯函数** ⇒ `__test` 与守卫可以直接断言，不必真去写盘 ✓
		function validateBotDraft(draft, existingIds) {
			const errs = [];
			const name = String((draft && draft.name) || "").trim();
			const id = String((draft && draft.id) || "").trim();
			if (!name) { errs.push("名称不能为空"); }
			if (!id) { errs.push("id 不能为空"); }
			else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) { errs.push("id 只能用 字母/数字/._-，且以字母或数字开头"); }
			else if (Array.isArray(existingIds) && existingIds.indexOf(id) >= 0) { errs.push("id 已被占用：" + id); }
			return errs;
		}
		/** 新建 Bot 的图标预设（agents 侧默认就是 `lucide:bot`；也允许 emoji）。 */
		const BOT_ICON_PRESETS = ["lucide:bot", "🧭", "🛠️", "📚", "🧪", "🎨", "📊"];
		/**
		 * ★ 2026-11-03：群聊下线后这两个只剩"表单分支的形状"（`openBotsNew` 只会传 `'bot'`，
		 *   群聊那一支不可达）。留着是为了不把 `submitBotsNew` / 表单里的一堆引用拆断；
		 *   等设置页签那轮一起清（`__test` 仍在导出它们，守卫按存在性断言）。
		 */
		function validateGroupDraft(draft) {
			const errs = [];
			if (!String((draft && draft.name) || "").trim()) { errs.push("群名不能为空"); }
			const members = (draft && Array.isArray(draft.members)) ? draft.members : [];
			if (!members.length) { errs.push("至少要勾一个成员"); }
			return errs;
		}
		const GROUP_MODE_OPTIONS = [
			{ id: "all", label: "全员派发", hint: "每条消息都发给所有成员" },
			{ id: "mentions", label: "仅 @ 派发", hint: "只有被 @ 的成员回应（默认）" },
			{ id: "digest", label: "汇总派发", hint: "攒够条数或超时后合并成一批" },
			{ id: "silent", label: "静默收件", hint: "只收不发，不触发回应" },
		];

		// ── 未读标记（2026-11-02 用户要求「补未读」；对齐 dsh-desktop 的本地 unreadSessionIds）──
		//
		// 口径：**纯本地**。dsh 侧没有"未读"这个远端状态（官方 alpha.3 只有
		// `completionUnread`——那是"agent 完成了一次运行"，语义不同且只挂在状态点上）。
		//   · 存储：localStorage `vssaros.ws.unread`（字符串数组；坏数据当空）；
		//   · 置未读：右键「标为未读」（回头看用）；清未读：**打开这条会话就清**
		//     （与 dsh-desktop 的 `view.markSessionRead` 同一时机）；
		//   · 展示：状态灯后一枚小点 + 标题加粗（官方行未读也是 600 字重 ✓）。
		const UNREAD_KEY = "vssaros.ws.unread";
		function loadUnread() {
			try {
				if (typeof localStorage === "undefined") { return []; }
				const raw = localStorage.getItem(UNREAD_KEY);
				const arr = raw ? JSON.parse(raw) : [];
				return Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x) : [];
			} catch { return []; }
		}
		function saveUnread(ids) {
			try {
				if (typeof localStorage !== "undefined") { localStorage.setItem(UNREAD_KEY, JSON.stringify(ids || [])); }
			} catch { /* 落盘失败只影响下次启动 */ }
		}
		/** 未读集合的增删（**纯逻辑**，`__test` 直接断言）。`on` 省略 = 切换。 */
		function toggleUnread(ids, sid, on) {
			const list = Array.isArray(ids) ? ids : [];
			const has = list.indexOf(sid) >= 0;
			if (on === undefined) { return has ? list.filter((x) => x !== sid) : list.concat([sid]); }
			if (on) { return has ? list : list.concat([sid]); }
			return has ? list.filter((x) => x !== sid) : list;
		}

		// ── 多 bot 群聊（★ 2026-11-05，用户要求：主管建群后 Bots 页签出现群聊行，同 DeepSeek-Bot）──────────
		//   群 = 一条专属会话（群 id 就是会话 id）+ 成员名单，数据在 vssaros-agents（lib/rooms.js）。
		//   · 群行：点开 = 中栏打开群会话；右键 7 项（置顶 / 标为未读 / 群设置 / 重命名群聊 / 复制对话 ID /
		//     从侧栏隐藏 / 删除群聊），分组与文案对齐 DS Bot 的 room 菜单（client/context-menu.js）。
		//   · 群会话与成员影子会话**不进「会话」页签**（会话摘要的 `vssaros-room` 投影）：它们只属于群。
		/* vssaros:room v1 —— 逐字副本，真源 vssaros-agents/lib/core/rooms.js 的 ROOM_PROJECTION_KEY */
		const ROOM_PROJECTION_KEY = "vssaros-room";
		/* /vssaros:room */
		/** 会话视图「设置」页签的 id（client.conversationViews.js 的 IDS.settings）——「群设置」要直接落到它。 */
		const SETTINGS_VIEW_ID = "vssaros-bot-settings";
		/** 会话摘要上的群标记（群会话 role=room / 成员影子会话 role=member）；不是 ⇒ null。 */
		function roomMarkOf(summary) {
			const pv = summary && summary.projectionValues;
			const mark = pv && pv[ROOM_PROJECTION_KEY];
			return mark && typeof mark.roomId === "string" && mark.roomId ? mark : null;
		}
		/**
		 * Bots 页签要显示的群：隐藏的不显示（**当前打开的那个除外**，与 DS Bot `hidden && !active` 同口径）；
		 * 搜索按群名与成员名；置顶在前，其余按最近活动倒序。纯函数。
		 */
		function visibleRooms(rooms, currentId, query) {
			const q = String(query || "").trim().toLowerCase();
			const hit = (v) => !q || String(v || "").toLowerCase().indexOf(q) >= 0;
			return (Array.isArray(rooms) ? rooms : [])
				.filter((r) => r && r.id && (r.hidden !== true || r.id === currentId))
				.filter((r) => hit(r.name) || (Array.isArray(r.members) ? r.members : []).some((m) => hit(m && m.name)))
				.sort((a, b) => (Number(b.pinned === true) - Number(a.pinned === true)) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
		}
		/**
		 * 群行右键菜单（4 组 7 项，组间分隔线；DS Bot room 菜单同序）。纯函数 ⇒ 守卫逐项断言。
		 * @returns `[{ act, label, danger? } | { sep: true }]`
		 */
		function roomMenuItems(room, unread) {
			return [
				{ act: "pin", label: room && room.pinned ? "取消置顶" : "置顶" },
				{ act: "unread", label: unread ? "标为已读" : "标为未读" },
				{ sep: true },
				{ act: "settings", label: "群设置" },
				{ act: "rename", label: "重命名群聊" },
				{ sep: true },
				{ act: "copy", label: "复制对话 ID" },
				{ sep: true },
				{ act: "hide", label: "从侧栏隐藏" },
				{ act: "delete", label: "删除群聊", danger: true },
			];
		}
		/**
		 * 群行菜单的动作（纯调度：副作用全部经 `deps` 注入 ⇒ `__test` 用假 deps 断言每一项打到哪）。
		 * @param deps `{ post(body) → Promise, open(sid), openSettings(sid), setUnread(sid, on), copy(text), startRename(room),
		 *              confirmDelete(room), reload(), say(text, kind) }`
		 */
		function roomMenuAction(act, room, unread, deps) {
			const id = room && room.id;
			if (!id) { return undefined; }
			const after = (text) => () => { deps.reload(); if (text) { deps.say(text, "note"); } };
			const failed = (what) => (e) => deps.say(what + "失败：" + String((e && e.message) || e), "error");
			if (act === "pin") { return deps.post({ action: "flags", id, pinned: !room.pinned }).then(after(room.pinned ? "已取消置顶" : "已置顶"), failed("置顶")); }
			if (act === "unread") { deps.setUnread(id, !unread); deps.say(!unread ? "已标为未读（打开这个群自动清除）" : "已标为已读", "note"); return undefined; }
			if (act === "settings") { return deps.openSettings(id); }
			if (act === "rename") { return deps.startRename(room); }
			if (act === "copy") { return deps.copy(id); }
			if (act === "hide") {
				return deps.post({ action: "flags", id, hidden: true })
					.then(after("已从侧栏隐藏「" + (room.name || id) + "」（群设置里可以重新显示）"), failed("隐藏"));
			}
			if (act === "delete") { return deps.confirmDelete(room); }
			return undefined;
		}
		/** 群头像：成员名首字（最多 2 个）。 */
		function roomInitials(room) {
			const ms = room && Array.isArray(room.members) ? room.members : [];
			const s = ms.slice(0, 2).map((m) => String((m && m.name) || (m && m.id) || "?").slice(0, 1)).join("");
			return s || "群";
		}
		/**
		 * 让某条会话下次打开时直接落在 `view` 页签：官方会话视图的选择存在 localStorage
		 * `dsh.conversation.<sid>`（`{ draft, view, viewRequest }`，dsh-client-ui-conversation `createConversationStore`）。
		 * 只改 `view`，草稿原样保留。纯函数（storage 注入）。
		 */
		function presetConversationView(storage, sid, view) {
			if (!storage || !sid || !view) { return false; }
			try {
				const key = "dsh.conversation." + sid;
				let cur = {};
				try { cur = JSON.parse(storage.getItem(key) || "{}") || {}; } catch { cur = {}; }
				storage.setItem(key, JSON.stringify(Object.assign({ draft: "", viewRequest: null }, cur, { view })));
				return true;
			} catch { return false; }
		}
		/**
		 * 绝对时间（行 hover 用）。与 `timeLabel` 分工：
		 * 行内仍显示"多久前"（扫视友好），hover 才给"几点几分"（官方行也是这个分工 ✓）。
		 */
		function absTimeLabel(at) {
			if (!at) { return ""; }
			try {
				const d = new Date(at);
				const p2 = (n) => (n < 10 ? "0" : "") + n;
				return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
			} catch { return ""; }
		}

		/**
		 * 收敛成渲染模型（模块作用域 ⇒ __test 直接断言；回落契约见文件头）。
		 * 返回 [{ kind: "group", record, sessions: [{id,title,at,rootName,isPrimaryRoot,isCurrent}] }
		 *        | { kind: "flat", item, sessions: [...] }]。
		 * 会话归属：dsh 快照条目的 sessionIds（分组记录）；条目按路径被记录认领 ⇒ 该条目的会话
		 * 都算这一组的；会话的根标签 = **会话自己的 `cwd`** 命中记录的哪个根（见 `rootOfSession`）。
		 */
		/**
		 * 会话真正跑在哪个根上 —— **先认会话自己的 `cwd`**，取不到才回落 dsh 条目对应的根。
		 *
		 * ★ 2026-10-28（用户报障「左侧工作区 hover 卡片的"当前会话"根，与聊天输入框上方 chip 的
		 *   工作区不一致」）：真机现场 = 会话 `cwd` 是 `…\sarosis-agents-client`（主根），而 dsh 快照里
		 *   它仍被列在 `…\Saros-switch` 那条条目的 `sessionIds` 里 ⇒ 侧栏按条目 path 标根 ⇒ 标成
		 *   Saros-switch，chip 的下拉按 cwd 标 ⇒ 标成主根 ⇒ 同一屏两个"当前" ✗。
		 *
		 * 两个事实的权威性不同：
		 *   · `sessions.byId[sid].cwd` = **宿主持有的事实**（`session.start({cwd})` 一落就定死，
		 *     会话真正读写就在那里）⇒ 第一权威 ✓；
		 *   · `items[].sessionIds` = dsh 侧的**分组记录**（会话换过目录后仍可能挂在旧条目上）⇒ 兜底 ✓。
		 * 取不到 cwd（旧快照 / 会话不在 roster）时**不猜**，用条目 path 推出根（改动前逐字相同的回落 ✓）。
		 */
		function rootOfSession(byId, roots, sid, fallback) {
			const s = (byId && byId[sid]) || {};
			const cwd = typeof s.cwd === "string" && s.cwd ? s.cwd : null;
			if (!cwd) { return fallback; }
			const hit = (roots || []).filter((r) => r && samePath(r.path, cwd))[0];
			return hit || fallback;
		}
		/**
		 * 会话显示标题（2026-10-21，用户：左栏要像 dsh-desktop ⇒ 不许整列 `session-xxxx`）。
		 *
		 * 真机症状：`s.title` 在本部署里**普遍为空**（标题插件没产出）⇒ 原实现直接回落 `sid`，
		 * 于是每行都是 `session-1eaede4-…`。这里按「有就用、没有就取摘要」的顺序找：
		 *   ① `title` ② `summary.displayTitle`（官方会话头用的就是它）
		 *   ③ `firstUserMessage` / `preview` / `lastMessage` ④ 最后才回落 id（宁可难看也不编造 ✓）
		 * 上限 48 字：侧栏只有 ~244px，再长也会被 CSS 省略号吞掉，先截断省一次布局 ✓。
		 */
		function titleOf(s, sid) {
			const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
			const summary = (s && s.summary) || {};
			const raw = pick(s && s.title) || pick(summary.displayTitle)
				|| pick(s && s.firstUserMessage) || pick(s && s.firstUserMessageText)
				|| pick(s && s.preview) || pick(s && s.lastMessage);
			// ★★ 2026-11-02 修（用户截图：整列 `session-2ce24dae-…`）：
			//   官方口径是 `sessionTitle(session) = session.title?.trim() ?? ""` +
			//   `displayTitle = node.title || t("session.untitled")` ⇒ **没标题就显示「未命名」**，
			//   从来不会把 id 当标题。我们原来最后回落 `sid` ⇒ 本部署里标题普遍为空时
			//   整列都是 uuid（比官方难看一个量级 ✗）。
			//   ⇒ 改成官方口径：**回落「未命名」**（不编造标题，也不再暴露内部 id）。
			//   ⚠ id 仍可在 hover 卡片 / 行尾 tooltip 里看到，不必占用标题位。
			if (!raw) { return "未命名"; }
			const flat = raw.replace(/[\r\n\t]+/g, " ").trim();
			return flat.length > 48 ? flat.slice(0, 48) + "…" : flat;
		}

		// ── 会话行状态灯（2026-10-30 用户报障：「工作区内的会话 item 缺少状态灯 UI」）──────────
		//
		// 为什么要有：侧栏里**同时在跑**的会话可以有五六个，而这一列只有标题 + 时间 ——
		// 哪个在跑、哪个在等你审批，**一眼看不出来**（官方侧栏与 @vssaros/dsh-sessions 页都有这盏灯 ✓）。
		//
		// 口径**逐字沿用** `@vssaros/dsh-sessions` 的 `statusOf`（`lib/core/sessionList.js:336-363`），
		// 那是本仓已经真机跑通的那一份，不自造第二套：
		//   · awaiting（黄）**优先于** running（绿）—— 否则"该你回答了"会被紧接着的收尾 delta 盖掉；
		//   · running = 回合在跑 **或** 正在重试（LLM）；
		//   · 其余 idle（灰）。
		// ⚠ 三个信号都可能**读不到**（老服务 / 会话不在 roster）⇒ 那一律**不画灯**，
		//   不把"未知"画成"空闲"（`idle` 是**已知不忙**，与"不知道"是两件事 ✗）。
		//
		// 数据从哪来（两条路，都不依赖槽作用域 props —— 本 chunk 注册在 `sidebar.workspaces`，
		// 拿不到 conversation 槽那套 `useSessionStatus`）：
		//   ① roster 行的投影字段（`turnRunning` / `retrying` / `pendingQuestions`
		//     = `turnBoundary` / `llmRetry` / `userQuestions` 三个单元的归一化结果）；
		//   ② 兜底：等价单元名（`s.running` / `s.turn.running`），读不到不算数。
		const QUESTIONS_KEYS = ["pendingQuestions", "userQuestions"];

		/** 待回答/待审批条数；**返回 undefined = 未知**（与"已知是 0"严格分开）。 */
		function pendingQuestionsOf(s) {
			if (!s || typeof s !== "object") { return undefined; }
			const shaped = (v) => {
				if (typeof v === "number" && isFinite(v)) { return Math.max(0, Math.trunc(v)); }
				if (Array.isArray(v)) { return v.length; }
				if (v && typeof v === "object") {
					for (const k of ["count", "pending", "items", "questions"]) {
						const inner = v[k];
						if (typeof inner === "number" && isFinite(inner)) { return Math.max(0, Math.trunc(inner)); }
						if (Array.isArray(inner)) { return inner.length; }
					}
				}
				return undefined;
			};
			for (const key of QUESTIONS_KEYS) {
				const got = shaped(s[key]);
				if (got !== undefined) { return got; }
			}
			return undefined;
		}

		/**
		 * 会话行的状态：`'awaiting' | 'running' | 'idle' | 'unknown'`（纯函数 ⇒ __test 直接断言）。
		 * `unknown` 由**调用方**决定怎么画（我们不画灯）；这里只负责"读不到就是读不到"。
		 */
		function sessionStatusOf(s) {
			if (!s || typeof s !== "object") { return "unknown"; }
			const awaiting = pendingQuestionsOf(s);
			if (typeof awaiting === "number" && awaiting > 0) { return "awaiting"; }
			const turn = s.turnBoundary && typeof s.turnBoundary === "object" ? s.turnBoundary : null;
			const retry = s.llmRetry && typeof s.llmRetry === "object" ? s.llmRetry : null;
			let running;
			if (typeof s.turnRunning === "boolean") { running = s.turnRunning; }
			else if (turn && typeof turn.running === "boolean") { running = turn.running; }
			else if (typeof s.running === "boolean") { running = s.running; }
			let retrying;
			if (typeof s.retrying === "boolean") { retrying = s.retrying; }
			else if (retry && typeof retry.retry === "number") { retrying = retry.retry > 0; }
			if (running === undefined && retrying === undefined) {
				// 三个运行信号一个都读不到，但**确实**问到了待回答条数（= 0）⇒ 那是"已知空闲"✓
				return awaiting === 0 ? "idle" : "unknown";
			}
			if (running === true || retrying === true) { return "running"; }
			return "idle";
		}

		/** 状态灯的 hover 文案（与 @vssaros/dsh-sessions 的 `RING_LABEL` 同一套话术）。 */
		const RING_LABEL = { running: "Agent 正在执行", awaiting: "等待你回答 / 审批", idle: "空闲" };

		/**
		 * 选"当前会话"（高亮用）—— 纯函数（可单测 ✓）。
		 *
		 * ★ 2026-10-28（用户报障「左侧工作区中，切换会话 item，item 的高亮没有同步切换」）：
		 *   高亮原来**只看 `bridge.sessionId`** —— 那是**宿主绑给这个视图的会话**（一个窗口里
		 *   基本不变），而用户点列表里的 item 走的是官方 `uiWorkspace.openSession(sid)`
		 *   ⇒ **官方当前会话变了、宿主绑定没变** ⇒ 高亮永远钉在原来那条 ✗。
		 *   ⇒ 现在三个来源按优先级取：
		 *     ① official = 官方 selection store（`dsh.sessions.current` —— 官方自己记"当前会话"的地方）；
		 *     ② local    = 我们刚点的那条（**乐观高亮**：官方导航要几百毫秒才落地，先让用户看到反应 ✓）；
		 *     ③ bridged  = 宿主绑定的会话（兜底：官方还没初始化时用这个）。
		 *   ⚠ 只有**在册**的候选才配当"当前"：官方那条 selection 是**按 origin 持久化**的 ⇒
		 *     可能是**别的窗口**留下的会话 ⇒ 拿它高亮本窗口的列表就是假高亮 ✗ ⇒ 用 known 过滤 ✓。
		 */
		/**
		 * 官方口径的"当前会话"：**被主视图 retain 的那条**（`retainedBy.mainView > 0`）。
		 *
		 * 抄的是官方 `dsh-client-ui-workspace/lib/client.js` 的 `mainSessionId(list)`：
		 *   `Object.values(list.byId).find((s) => (s.retainedBy.mainView ?? 0) > 0)?.id`
		 * ★ 与"按 origin 持久化的 selection"不是一回事：selection 可能是**上一次运行 / 别的窗口**留下的，
		 *   而 mainView 是**本页面此刻真的渲染着**哪条 ⇒ 判"当前"必须用它（官方空会话例外也用它）。
		 */
		function mainViewSessionId(byId) {
			const map = byId || {};
			for (const id of Object.keys(map)) {
				const row = map[id];
				const n = row && row.retainedBy ? row.retainedBy.mainView : 0;
				if (typeof n === "number" && n > 0) { return id; }
			}
			return null;
		}

		function pickCurrentSessionId(opts) {
			const o = opts || {};
			// ★ 2026-10-30（对齐官方空会话口径）：新增 mainView 来源，且**优先级最高**。
			//   理由：官方 `sessionVisible` 的例外条件是 `session.id !== current`，而它的 current 就是
			//   mainView retain 的那条 ⇒ 我们也用同一判据，否则会出现"官方认为当前的那条空会话被我们藏掉"
			//   或"我们以为当前的那条其实只是别的窗口的 selection 残留"（两处口径打架 ✗）。
			const mainView = o.mainView || null;
			const official = o.official || null;
			const local = o.local || null;
			const bridged = o.bridged || null;
			const known = o.known || null;
			const has = (id) => {
				if (!id) { return false; }
				if (!known) { return true; }
				if (typeof known.has === "function") { return known.has(id); }
				return !!known[id];
			};
			if (has(mainView)) { return mainView; }
			if (has(official)) { return official; }
			// 乐观高亮排在这里（不是第一）：它只覆盖"mainView/official 都还没有"的启动瞬间；
			// 排太高会在用户从页签/官方 UI 切会话后**一直亮着旧的那条**（local 没有别的清除点 ✗）。
			if (has(local)) { return local; }
			if (has(bridged)) { return bridged; }
			// 都不在册 ⇒ 仍交出第一个有值的（上层据此"不高亮"而不是"高亮错的那条" ✓）
			return mainView || official || local || bridged || null;
		}

		// ── 会话行操作（2026-10-29）：置顶 / 手动顺序 / 拖放判定（纯逻辑 ⇒ __test 直接断言）──

		/** 手动顺序落盘键（localStorage；页面同 origin ⇒ 多窗口共享）。 */
		const SESSION_ORDER_KEY = "vssaros.chatSurface.sessionOrder.v1";

		/** 把 pinnedIds（数组 / Set / 空）收敛成 Set（只收非空字符串）。 */
		function toIdSet(ids) {
			const set = new Set();
			if (Array.isArray(ids)) {
				for (const v of ids) { if (typeof v === "string" && v) { set.add(v); } }
			} else if (ids && typeof ids.forEach === "function" && typeof ids.has === "function") {
				ids.forEach((v) => { if (typeof v === "string" && v) { set.add(v); } });
			}
			return set;
		}

		/**
		 * 解析顺序表（JSON 字符串或已解析对象）—— **坏数据一律当空**，绝不把坏结构带进渲染。
		 * 只认 `{ [groupKey]: string[] }`，逐项去空去重。
		 */
		function normalizeOrderMap(raw) {
			let obj = raw;
			if (typeof raw === "string") {
				try { obj = JSON.parse(raw); } catch { return {}; }
			}
			if (!obj || typeof obj !== "object" || Array.isArray(obj)) { return {}; }
			const out = {};
			for (const key of Object.keys(obj)) {
				const list = obj[key];
				if (!Array.isArray(list)) { continue; }
				const clean = [];
				for (const v of list) {
					if (typeof v === "string" && v && clean.indexOf(v) < 0) { clean.push(v); }
				}
				if (clean.length > 0) { out[key] = clean; }
			}
			return out;
		}

		/** 按保存顺序重排；保存表里没有的**保持原相对顺序**追加在后面（不重新按时间排 ✗）。 */
		function sortBySavedOrder(list, saved) {
			if (!Array.isArray(saved) || saved.length === 0) { return list.slice(); }
			const rank = Object.create(null);
			for (let i = 0; i < saved.length; i++) { rank[saved[i]] = i; }
			const known = [];
			const rest = [];
			for (const s of list) {
				if (Object.prototype.hasOwnProperty.call(rank, s.id)) { known.push(s); } else { rest.push(s); }
			}
			known.sort((a, b) => rank[a.id] - rank[b.id]);
			return known.concat(rest);
		}

		/**
		 * 组内最终顺序 = **置顶稳定前置** ⊕ 手动序（官方 `reconcileManualOrder` 同口径）。
		 * ★ 置顶不是"分区"：pinned 之间、其余之间各自保持既有相对顺序 ✓。
		 */
		function orderGroupSessions(list, opts) {
			const o = opts || {};
			const pins = toIdSet(o.pinned);
			const ordered = sortBySavedOrder(list, o.saved);
			const pinRows = [];
			const rest = [];
			for (const s of ordered) {
				(pins.has(s.id) ? pinRows : rest).push(s);
			}
			return pinRows.concat(rest);
		}

		/**
		 * 每组默认渲染多少条会话（2026-10-30 用户要求「会话太多时要能只加载一部分」）。
		 *
		 * 为什么要有：本机实测单个工作区能挂 **上百条**会话（`items[].sessionIds` 是 Host 记的全量成员），
		 * 全渲染 ⇒ 一屏几百个 DOM 节点 + 每次快照变化全量重排（侧栏滚动明显发涩）。
		 * 20 条 ≈ 一屏半，够用；「展开其余 N 条」每次再放 20。
		 */
		const SESSION_PAGE_SIZE = 20;

		/**
		 * 按配额取要渲染的会话 —— **当前会话永远可见**（哪怕它排在配额之外）。
		 *
		 * 口径来源：@vssaros/dsh-sessions 页的「5 条配额 + 展开其余」（`computeGroupWindow`），
		 * 那边还要求"运行中/等待中不占配额且始终显示"；侧栏没有四态过滤，这里只保证**当前会话**不被折叠隐藏
		 * （否则用户点开一条老会话，列表里却看不到它高亮在哪 ✗）。
		 */
		function visibleSessions(list, quota) {
			const all = Array.isArray(list) ? list : [];
			const q = Number.isFinite(quota) && quota > 0 ? Math.floor(quota) : 0;
			// 配额缺失 / <= 0 ⇒ 当"不限制"（宁可多渲染，也不能把列表清空 ✗）
			if (q === 0 || q >= all.length) { return all.slice(); }
			const out = all.slice(0, q);
			for (const s of all) {
				if (s && s.isCurrent && out.indexOf(s) < 0) { out.push(s); }
			}
			return out;
		}

		/**
		 * 把 `sid` 挪到 `targetSid` 之前/之后 —— 返回**新 id 顺序数组**（不动入参）。
		 * 任一方不在表里 / 同一个 ⇒ null（调用方据此不写顺序，避免把顺序表写坏）。
		 */
		function moveWithin(list, sid, targetSid, after) {
			const ids = list.map((s) => s.id);
			if (ids.indexOf(sid) < 0 || ids.indexOf(targetSid) < 0 || sid === targetSid) { return null; }
			const next = ids.slice();
			next.splice(ids.indexOf(sid), 1);
			const at = next.indexOf(targetSid);
			if (at < 0) { return null; }
			next.splice(after ? at + 1 : at, 0, sid);
			return next;
		}

		/**
		 * 拖放是否允许：**同组 + 同置顶区**。
		 * 跨组 = 改会话 cwd（官方也不支持）；跨置顶区 = 会让"置顶恒在组首"失真 ⇒ 都拒绝并显示禁止态。
		 */
		function canDrop(src, dst) {
			if (!src || !dst) { return false; }
			if (src.sid === dst.sid) { return false; }
			if (src.groupKey !== dst.groupKey) { return false; }
			return !!src.pinned === !!dst.pinned;
		}

		function buildSidebar(options) {
			const items = (options && options.workspaces) || [];
			const records = (options && options.records) || [];
			const byId = (options && options.sessionsById) || {};
			const archived = (options && options.archivedIds) || [];
			const currentId = (options && options.currentSessionId) || null;
			// ★ 2026-10-29：置顶（Host 状态）与手动顺序（本地）
			const pins = toIdSet(options && options.pinnedIds);
			const orderMap = (options && options.orderMap) || {};
			const claimed = {};
			const rows = [];
			const mkSess = (sid, rootName, isPrimaryRoot, groupKey) => {
				const s = byId[sid] || {};
				return {
					id: sid,
					// 组键（"rec:<记录 id>" / "ws:<工作区 id>"）—— 手动顺序与拖放判定都按它分片
					groupKey: groupKey || "",
					// ★ 置顶（Host 状态的 pinnedSessionIds）：渲染口径 = 恒在组首（见 orderGroupSessions）
					pinned: pins.has(sid),
					// 标题：title → summary.displayTitle → 首条消息摘要 → id（见 titleOf 的注释）
					title: titleOf(s, sid),
					at: (typeof s.updatedAt === "number" && s.updatedAt) || (typeof s.createdAt === "number" && s.createdAt) || 0,
					rootName: rootName || null,
					isPrimaryRoot: isPrimaryRoot !== false,
					isCurrent: sid === currentId,
					// ★ 状态灯（2026-10-30）：「跑着 / 等你回答 / 空闲 / 读不到」四态
					//   （`unknown` ⇒ 渲染侧不画灯，见 sessionStatusOf 的注释）
					status: sessionStatusOf(s),
					archived: archived.indexOf(sid) >= 0,
					// ★ 空会话（官方 roster 的 `blank` 位）。
					//   官方 `sessionVisible`（dsh-client-ui-workspace/client.js:958）：
					//     `if (session.blank && session.id !== current) return false;` ⇒ 只留"当前"那条 ✓ 我们同口径。
					blank: s.blank === true,
					// ★ 子代理会话（2026-10-30 对齐官方）：`sessionVisible` 第一条就是
					//   `if (session.origin === "subagent") return false;` —— **永不列出**，
					//   也不计入"已隐藏空会话"（它不是空会话，是另一种东西）。
					isSubagent: s.origin === "subagent",
					// ★ 2026-11-05：群会话与成员影子会话只属于群（Bots 页签的群行）⇒ 不进「会话」页签
					isRoom: !!roomMarkOf(s),
				};
			};
			const sortSess = (list) => list.some((s) => s.at > 0)
				? list.sort((s1, s2) => (s2.at - s1.at) || (s1.id < s2.id ? -1 : 1))
				: list;
			for (const rec of records) {
				// ★ 2026-10-29：组键用**记录 id**（多根工作区可能摊平出多个 dsh 条目 ⇒ 不能用 workspaceId 当键）
				const groupKey = "rec:" + rec.id;
				const members = items.filter((it) => it && it.workspaceId && !claimed[it.workspaceId]
					&& rec.roots.some((r) => samePath(r.path, it.path)));
				for (const m of members) { claimed[m.workspaceId] = true; }
				const sessions = [];
				let hiddenBlanks = 0;
				for (const m of members) {
					// 回落值 = 该条目 path 对应的根；真正用哪个根由 `rootOfSession` 按会话 cwd 定（★ 2026-10-28）
					const fallbackRoot = rec.roots.filter((r) => samePath(r.path, m.path))[0];
					for (const sid of (Array.isArray(m.sessionIds) ? m.sessionIds : [])) {
						const root = rootOfSession(byId, rec.roots, sid, fallbackRoot);
						// 稿 1 降噪：只有**非主根**会话才带根名标签（守卫 ⑤ 钉住 ✓）
						const s = mkSess(sid, root && !root.isPrimary ? root.name : null, root ? root.isPrimary : true, groupKey);
						// ★ 子代理会话永不列出（官方 `sessionVisible` 第一条）；**不算**进"已隐藏空会话"
						if (s.isSubagent) { continue; }
						// ★ 2026-11-05 群会话 / 成员影子会话只在 Bots 页签的群行里，同样不算"已隐藏"
						if (s.isRoom) { continue; }
						if (s.archived) { continue; }
						// ★ 空会话不显示（2026-10-26 用户报「工作区下有大量空会话」）：
						//   这些会话一条消息都没有、标题只能回落到 id ⇒ 在列表里是纯噪音
						//   （本机实测 1931 条会话里 1813 条是这种空壳）⇒ 隐藏并**计数**
						//   （诚实披露，不装作没有）。★ 当前会话永远显示（哪怕它是空的）。
						if (s.blank && !s.isCurrent) { hiddenBlanks += 1; continue; }
						sessions.push(s);
					}
				}
				// ★ 2026-10-29：顺序 = 置顶前置 ⊕ 手动序（orderGroupSessions），基础序仍是时间倒序 ✓
				rows.push({
					kind: "group",
					key: groupKey,
					record: rec,
					sessions: orderGroupSessions(sortSess(sessions), { saved: orderMap[groupKey], pinned: pins }),
					hiddenBlanks,
				});
			}
			for (const it of items) {
				if (!it || !it.workspaceId || claimed[it.workspaceId]) { continue; }
				const groupKey = "ws:" + it.workspaceId;
				const sessions = [];
				let hiddenBlanks = 0;
				for (const sid of (Array.isArray(it.sessionIds) ? it.sessionIds : [])) {
					const s = mkSess(sid, null, true, groupKey);
					if (s.isSubagent) { continue; }
					if (s.isRoom) { continue; }
					if (s.archived) { continue; }
					if (s.blank && !s.isCurrent) { hiddenBlanks += 1; continue; }
					sessions.push(s);
				}
				rows.push({
					kind: "flat",
					key: groupKey,
					workspaceId: it.workspaceId,
					label: (typeof it.name === "string" && it.name.trim()) ? it.name.trim() : (baseName(it.path) || it.workspaceId),
					path: it.path || null,
					sessions: orderGroupSessions(sortSess(sessions), { saved: orderMap[groupKey], pinned: pins }),
					hiddenBlanks,
				});
			}
			return rows;
		}

		function install(ctx, shell) {
			const bridge = shell && shell.bridge;
			const state = shell && shell.state ? shell.state : {};

			// ── 诊断日志（2026-11-02 用户要求「增加日志定位问题」）────────────────────────────
			//   现场：desktop 全窗（`chatOnly=0`）里出现过「`sidebar.workspaces` 槽里渲染的是官方
			//   WorkspaceBrowser」，而同一个 app 的 IDE 聊天框里是我们自己的（页签 + 4 个多根分组）。
			//   静态守卫只能钉代码形态，这种"注册没生效 / 被别人的占位者赢了"必须在**运行时**留时间线。
			//
			//   事件链（都带毫秒时间戳，末尾 80 条留存在 `state.workspacesLog`）：
			//     install → register-call → register-done / register-threw → render(render-rail)
			//     → slot-ok / slot-mismatch（700ms 后自检槽里到底是谁）
			//
			//   ⚠ 渲染埋点只取第 1/2/3 次 + 每 50 次 ⇒ 不刷屏、也没有性能顾虑；
			//   ⚠ 任何日志失败都被吞掉（诊断绝不能反过来影响功能）。
			const WS_LOG_PREFIX = "[vssaros-ws]";
			const wsLog = (kind, data) => {
				try {
					const rec = Object.assign({ t: Date.now(), kind }, data || {});
					state.workspacesLog = (state.workspacesLog || []).concat([rec]).slice(-80);
					const bad = kind === "error" || kind === "slot-mismatch" || kind === "register-threw";
					const emit = bad ? (console.warn || console.log) : (console.info || console.log);
					if (typeof emit === "function") { emit.call(console, WS_LOG_PREFIX, kind, rec); }
				} catch { /* 诊断失败不影响功能 */ }
			};

			const readWsSnapshot = () => {
				try {
					const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
					return ws && ws.list ? ws.list.getSnapshot() : null;
				} catch (e) { state.workspaceError = String((e && e.message) || e); return null; }
			};
			const readSessSnapshot = () => {
				try {
					const ss = ctx.sessions && ctx.sessions.list;
					return ss ? ss.getSnapshot() : null;
				} catch (e) { state.sessionListError = String((e && e.message) || e); return null; }
			};
			/**
			 * 打开一个会话（2026-10-17 真机：**点 session item 没反应**）。
			 *
			 * 病根：hero / 冷启动时客户端 roster 尚未载入该会话，直接 `openSession` 会抛
			 * `sessions.retain: unknown session`（chat 主包的同款注释已记过），而我们把它
			 * 吞进 `state.error` ⇒ 界面上**完全没反应** ✗。
			 * 修法：① 先按 workspaces 快照找到会话的归属工作区，`openWorkspace`（它会把会话
			 * 载入 roster —— 与 chat 主包 `alignWorkspace` 同一顺序 ✓）再 `openSession`；
			 * ② 任何失败都经 bridge.notify **说出来**（不许静默 ✗）。
			 */
			const notify = (kind, text) => {
				try { if (bridge && typeof bridge.notify === "function") { bridge.notify(kind, text); } } catch { /* 通知失败不影响别的 */ }
			};
			/**
			 * 读**官方**的"当前会话"（2026-10-28：高亮不同步的根因）。
			 *
			 * 官方 `UiWorkspaceService` 里有个持久化的 selection store（`dsh.sessions.current`），
			 * 官方自己用它记"当前打开的是哪条会话"（`replaceMain` / `openSession` 都会写它）。
			 * ⚠ 那个字段在官方源码里是**私有**的（TS private，运行期不存在）⇒ 读不到就**如实返回 null**
			 *   （上层会退回"我们刚点的那条"与宿主绑定）⇒ 官方哪天改了名，我们只是不高亮，不会崩 ✓。
			 */
			const readOfficialCurrent = () => {
				try {
					const uw = ctx.uiWorkspace;
					const sel = uw && uw.selection;
					if (sel && typeof sel.getSnapshot === "function") {
						const snap = sel.getSnapshot() || {};
						if (typeof snap.sessionId === "string" && snap.sessionId) { return snap.sessionId; }
					}
				} catch { /* 官方字段不存在/改名 ⇒ 回落 */ }
				return null;
			};
			/**
			 * 点侧栏里的会话 ⇒ 打开它。
			 *
			 * ★★ 2026-10-28（用户报「左侧工作区中，点击会话 item，没有打开对应会话」）：
			 *   原来这里**只调一次** `openSession`，失败就一句 `notify(warn)` —— 而桌面窗口
			 *   **没有宿主桥**（`bridge.notify` 空转）⇒ 用户看到的就是"点了完全没反应"✗✗。
			 *   而 `unknown session` / `is released` 是**预期内的瞬时态**（会话还没进 roster、
			 *   引用被回收），主包的 `navigate()` 对这两种错误会 retain + 轮询重试，
			 *   侧栏这条一次性路径从来不重试 ⇒ 只要第一次撞上就永久打不开。
			 *   ⇒ 现在：① 瞬时错误先 `sessions.retain` 再退避重试（最稳，与主包同口径）；
			 *            ② 每次失败**就地渲染**一行（`setMsg`，与「＋添加工作区」同一套可见性）；
			 *            ③ 成功则清掉那行，不残留噪声。
			 *
			 * @param setMsg 区内的就地提示回调（`{kind,text} | null`）；窗口模式唯一可见的反馈通道。
			 * @param setCurrent 乐观高亮回调（点哪条先亮哪条；打不开就撤回 ⇒ 不会高亮一条没打开的会话）。
			 */
			const openSession = (sid, setMsg, setCurrent) => {
				const RETRY_DELAYS = [300, 900, 2000];
				const say = (text, kind) => {
					state.openSessionError = kind === "error" ? text : null;
					try { if (typeof setMsg === "function") { setMsg(text ? { kind: kind || "note", text: text } : null); } } catch { /* 渲染失败不影响打开 */ }
				};
				// ★ 2026-10-28（高亮不同步）：**乐观高亮** —— 官方导航要几百毫秒才落地，
				//   先把点的那条点亮（用户点哪条哪条立刻有反应）⇒ 官方 selection 落地后由它接管 ✓。
				try { if (typeof setCurrent === "function") { setCurrent(sid); } } catch { /* 渲染失败不影响打开 */ }
				let attempt = 0;
				const transient = (msg) => /unknown session|is released|not found|no such/i.test(msg);
				const attemptOpen = () => {
					attempt++;
					const onRejected = (e) => {
						const msg = String((e && e.message) || e || "未知错误");
						state.lastOpenError = msg;
						state.openSessionTries = attempt;
						if (transient(msg) && attempt <= RETRY_DELAYS.length) {
							// 会话不在 roster / 引用被释放 ⇒ 先 retain 拿回引用，再退避重试（同主包口径）
							try {
								const svc = ctx.sessions;
								if (svc && typeof svc.retain === "function") { void Promise.resolve(svc.retain(sid)).catch(() => undefined); }
							} catch { /* 下一跳还会再试 */ }
							say("正在打开会话…（第 " + (attempt + 1) + " 次，会话还没就绪）", "note");
							try { window.setTimeout(attemptOpen, RETRY_DELAYS[attempt - 1]); } catch { /* 没有 setTimeout */ }
							return;
						}
						say("打开会话失败：" + msg, "error");
						notify("warn", "打开会话失败：" + msg);
						// ★ 2026-10-28：真的打不开 ⇒ 撤回乐观高亮（否则会一直亮着一条**没打开**的会话 ✗）
						try { if (typeof setCurrent === "function") { setCurrent(null); } } catch { /* 忽略 */ }
					};
					try {
						// 侧栏点会话 = 用户主动导航（整页工作台在前台时也要切到会话页）
						try { window.__vssarosUserNavAt = Date.now(); } catch { /* 无 window */ }
						const r = ctx.uiWorkspace.openSession(sid);
						if (r && typeof r.then === "function") {
							r.then(() => { state.lastOpenError = null; say(null); }, onRejected);
						} else {
							say(null);
						}
					} catch (e) { onRejected(e); }
				};
				try {
					const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
					const snap = ws && ws.list ? ws.list.getSnapshot() : null;
					const owner = ((snap && snap.items) || []).filter((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sid) >= 0)[0];
					// ★ 2026-10-20：不再先 `openWorkspace(owner)` —— 官方实现会 `sessions.create({ workspaceId })`
					//   **新建一条空会话**再导航过去（见 client.js alignWorkspace 的注释）。
					//   工作区由选中会话推出，直接 openSession 即可。`owner` 只用于诊断。
					state.lastOpenOwner = owner ? owner.workspaceId : null;
					attemptOpen();
				} catch (e) {
					const msg = String((e && e.message) || e);
					say("打开会话失败：" + msg, "error");
					notify("warn", "打开会话失败：" + msg);
				}
			};
			// ── 会话行操作（2026-10-29 用户要求：右键菜单 置顶/重命名/复制 id/归档 + 组内拖拽）──
			/**
			 * 四条操作**只走官方服务**（不自造状态），成败都经 `say(text, kind)` **就地**渲染。
			 *
			 * ⚠ 窗口模式没有宿主桥 ⇒ `notify` 是空转 ⇒ 只写 state 就是静默失败（与 ＋ 按钮同款教训）✗。
			 */
			const errText = (e) => String((e && e.message) || e || "未知错误");
			/**
			 * 页面级「用户主动导航」信号（2026-11-02，配合 vssaros-workbenches 的 selectPanel 守卫）。
			 * 前台开着整页工作台时，守卫会把新打开的会话「停靠进工作台对话列」⇒ 中栏空白；
			 * 只有在 2.5s 内看到用户导航信号才放行。跨插件的方法包装拦不到我们的调用
			 * （各插件的 ctx.uiWorkspace 是不同代理）⇒ 用 window 上的时间戳共享。
			 */
			const markUserNavGlobal = () => {
				try { window.__vssarosUserNavAt = Date.now(); } catch { /* 无 window */ }
			};
			/**
			 * 归档是否被 Host 以「会话还在跑」拒绝（官方 `WorkspaceArchiveError` + `workspace/session-active`）。
			 * 官方遇到它弹二次确认（可顺带 stopActivity）；我们**不擅自停掉用户正在跑的会话** ⇒ 只如实说明。
			 */
			const isActiveRefusal = (e) => {
				try {
					const code = e && e.rpcError && e.rpcError.code;
					// 只有 RPC 明确说"会话还活着"才算数（官方 `workspace/session-active`）
					if (typeof code === "string" && code) { return code.indexOf("session-active") >= 0; }
					// 没有 rpcError.code（老宿主 / 打包后类身份丢失）⇒ 用**文案**兜底。
					// ⚠ 别按 `name === "WorkspaceArchiveError"` 一刀切：官方对**所有**归档失败都用这个类，
					//   那样会把"权限/网络/未知"也谎报成"正在运行"（用户看到的提示是假的 ✗）。
					return /session-active|still running|正在运行/i.test(String((e && e.message) || ""));
				} catch { return false; }
			};
			/** 置顶 / 取消置顶（Host 状态；成功后 workspaces 快照会变 ⇒ useData 的订阅自动重渲染）。 */
			const setPinned = (sid, on, say) => {
				try {
					const uw = ctx.uiWorkspace;
					const fn = on ? (uw && uw.pinSession) : (uw && uw.unpinSession);
					if (typeof fn !== "function") {
						say("当前宿主不支持置顶（uiWorkspace.pinSession 不可用）", "error");
						return;
					}
					void Promise.resolve(fn.call(uw, sid)).then(
						() => { say(on ? "已置顶（排在所属工作区最前）" : "已取消置顶", "note"); },
						(e) => { say((on ? "置顶失败：" : "取消置顶失败：") + errText(e), "error"); },
					);
				} catch (e) { say("置顶失败：" + errText(e), "error"); }
			};
			/**
			 * 重命名（官方侧栏同一跳：`sessions.using(...).binding.session.rename(title)`）。
			 * @param done 成功回调（调用方据此收起就地输入框）
			 */
			const renameSession = (sid, title, say, done) => {
				const next = String(title || "").trim();
				if (!next) { say("标题不能为空", "error"); return; }
				try {
					const svc = typeof ctx.get === "function" ? ctx.get("sessions") : null;
					if (!svc || typeof svc.using !== "function") {
						say("当前宿主不支持重命名（sessions.using 不可用）", "error");
						return;
					}
					void Promise.resolve(svc.using(sid, { source: "workspaceOperation" }, (ref) => {
						const session = ref && ref.binding && ref.binding.session;
						if (!session || typeof session.rename !== "function") {
							throw new Error("会话引用没有 rename（宿主版本过旧）");
						}
						return session.rename(next);
					})).then(
						() => { say(null); if (typeof done === "function") { done(); } },
						(e) => { say("重命名失败：" + errText(e), "error"); },
					);
				} catch (e) { say("重命名失败：" + errText(e), "error"); }
			};
			/** 剪贴板降级（http 下 navigator.clipboard 可能不存在；execCommand 仍可用）。 */
			const legacyCopy = (text) => {
				try {
					const ta = document.createElement("textarea");
					ta.value = text;
					ta.setAttribute("readonly", "1");
					ta.style.position = "fixed";
					ta.style.left = "-9999px";
					document.body.appendChild(ta);
					ta.select();
					const ok = document.execCommand("copy");
					document.body.removeChild(ta);
					return ok === true;
				} catch { return false; }
			};
			const copySessionId = (sid, say) => {
				const ok = () => say("已复制会话 id：" + sid, "note");
				const fail = () => say("复制失败（宿主拒绝了剪贴板写入）", "error");
				try {
					const nav = typeof navigator !== "undefined" ? navigator : null;
					if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
						void Promise.resolve(nav.clipboard.writeText(sid)).then(ok, () => { legacyCopy(sid) ? ok() : fail(); });
						return;
					}
				} catch { /* 落到降级 */ }
				legacyCopy(sid) ? ok() : fail();
			};
			/** 归档（从列表消失；运行中的会话会被 Host 拒绝 ⇒ 如实说明，不替用户停）。 */
			const archiveSession = (sid, say) => {
				try {
					const uw = ctx.uiWorkspace;
					if (!uw || typeof uw.archiveSession !== "function") {
						say("当前宿主不支持归档（uiWorkspace.archiveSession 不可用）", "error");
						return;
					}
					void Promise.resolve(uw.archiveSession(sid)).then(
						() => { say("已归档（列表里移除；官方「已归档」筛选可找回）", "note"); },
						(e) => {
							if (isActiveRefusal(e)) {
								say("这条会话正在运行，先停止它再归档（不替你停）", "error");
								return;
							}
							say("归档失败：" + errText(e), "error");
						},
					);
				} catch (e) { say("归档失败：" + errText(e), "error"); }
			};
			/** 删除接口路径（host 半边 `lib/index.js` 提供；同源 POST）。 */
			const DELETE_API = "/x/chat-surface/api/delete-session";
			/**
			 * **删除**一条会话（2026-11-02 升级；对齐 dsh-desktop 的 `uiWorkspace.deleteSession`）。
			 *
			 * 旧实现 = 「先归档再删盘」，两个毛病：
			 *   ① 归档是**用户可见状态**（官方「已归档」筛选里会出现），而我们只想让这一行消失 ⇒ 污染归档；
			 *   ② 归档会被 `session-active` 拒绝 ⇒ 跑着的会话连删都进不去。
			 *
			 * 背景（2026-10-30 用户报「点了删除，item 没消失」）：行来自 `workspaces.list` 快照的
			 * `items[].sessionIds`（Host 记的账本），只删磁盘不会改它。alpha.3 给了正确的工具：
			 * `workspaces.get(wsId).detachSession(sid)` —— Workspace 实体方法，**幂等、只摘账本、
			 * 不动会话日志** ✓。
			 *
			 * 新顺序：
			 *   ① 删磁盘（不可恢复 ⇒ **先做**：失败了就什么都不动，别演成成功 ✗）；
			 *   ② `detachSession` 摘记录 ⇒ 行消失，且**不污染归档集合**；
			 *   ③ detach 不可用（老宿主）⇒ **回落归档**（保证"行一定消失"，与旧行为等价）。
			 */
			const deleteSessionForever = (sid, say, done) => {
				const finish = (ok, text, kind) => {
					say(text, kind || (ok ? "note" : "error"));
					if (typeof done === "function") { done(ok); }
				};
				/** sid 所属的 dsh 工作区（detach 需要 workspaceId）。 */
				const ownerWorkspaceId = () => {
					try {
						const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : null;
						const snap = ws && ws.list ? ws.list.getSnapshot() : null;
						const hit = ((snap && snap.items) || []).filter((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sid) >= 0)[0];
						return hit && hit.workspaceId ? hit.workspaceId : null;
					} catch { return null; }
				};
				/** ② 摘记录 ⇒ Promise<true> 表示已摘掉。 */
				const detach = () => {
					try {
						const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : null;
						const wid = ownerWorkspaceId();
						const entity = ws && wid && typeof ws.get === "function" ? ws.get(wid) : null;
						if (!entity || typeof entity.detachSession !== "function") { return Promise.resolve(false); }
						return Promise.resolve(entity.detachSession(sid)).then(() => true, () => false);
					} catch { return Promise.resolve(false); }
				};
				/** ③ 老宿主兜底：归档（旧路径，只保证"行消失"）。 */
				const archiveFallback = () => {
					try {
						const uw = ctx.uiWorkspace;
						if (!uw || typeof uw.archiveSession !== "function") { return Promise.resolve(false); }
						return Promise.resolve(uw.archiveSession(sid)).then(() => true, () => false);
					} catch { return Promise.resolve(false); }
				};
				const refreshRoster = () => {
					try {
						const svc = typeof ctx.get === "function" ? ctx.get("sessions") : null;
						if (svc && typeof svc.refresh === "function") { void Promise.resolve(svc.refresh()).catch(() => undefined); }
					} catch { /* 刷不动不影响已删 */ }
				};
				/** ① 删磁盘。 */
				const wipe = () => {
					let fetchFn = null;
					try { fetchFn = typeof fetch === "function" ? fetch : null; } catch { fetchFn = null; }
					if (!fetchFn) { finish(false, "删除失败：当前环境没有 fetch（磁盘没删、列表也没动）", "error"); return; }
					void Promise.resolve(fetchFn(DELETE_API, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId: sid }),
					})).then((res) => {
						return Promise.resolve(res.json().catch(() => null)).then((body) => ({ res, body }));
					}).then(({ res, body }) => {
						if (!res || !res.ok || !body || body.ok !== true) {
							const why = body && body.error ? body.error : ("HTTP " + (res ? res.status : "?"));
							finish(false, res && res.status === 404
								? "删除失败：宿主没有删除通路（插件版本过旧 / Host 未重启）"
								: ("删除失败（磁盘没删）：" + why), "error");
							return;
						}
						const found = body.found !== false;
						const removed = (body.removed || []).length;
						void detach().then((detached) => {
							if (detached) {
								finish(true, found ? "已删除（" + removed + " 项，不可恢复）" : "已从列表移除（磁盘上没找到这条的数据）", "note");
								refreshRoster();
								return;
							}
							void archiveFallback().then((archived) => {
								finish(true,
									(found ? "已删除磁盘数据" : "磁盘上没有这条的数据")
									+ (archived
										? "；已从列表移除（宿主没有 detachSession，用归档兜底）"
										: "；但这条仍留在列表里（宿主既无 detachSession 也无法归档）"),
									archived ? "note" : "error");
								refreshRoster();
							});
						});
					}).catch((e) => {
						finish(false, "删除失败（磁盘没删）：" + errText(e), "error");
					});
				};
				wipe();
			};
			// ── 未读：模块级 + 事件驱动（2026-11-02 用户要求「补未读」）────────────────────
			//   行渲染 `renderSessionRow` 在 Browser 闭包里，但**模块级**更省事：
			//   改集合 ⇒ 落盘 + 广播 ⇒ 挂载中的 Browser 重画（不必把 setter 一路传进去）。
			//   ⚠ 只在**真正变化**时广播（否则每次点击都重画整个列表）。
			let unreadIds = loadUnread();
			const UNREAD_EVENT = "vssaros-ws-unread";
			const setSessionUnread = (sid, on) => {
				if (!sid) { return; }
				const next = toggleUnread(unreadIds, sid, on);
				if (next.length === unreadIds.length && next.every((x, i) => x === unreadIds[i])) { return; }
				unreadIds = next;
				saveUnread(next);
				try { window.dispatchEvent(new Event(UNREAD_EVENT)); } catch { /* 无 window ⇒ 下次渲染才看到 */ }
			};
			/** 标记已读（打开会话时调；与 dsh-desktop 的 `view.markSessionRead` 同一时机）。 */
			const markSessionRead = (sid) => setSessionUnread(sid, false);

			/** 读手动顺序（localStorage）。坏数据 / 无 localStorage ⇒ 空表（侧栏照常工作）。 */
			const readOrderMap = () => {
				try {
					if (typeof localStorage === "undefined") { return {}; }
					return normalizeOrderMap(localStorage.getItem(SESSION_ORDER_KEY));
				} catch { return {}; }
			};
			/** 写手动顺序：先更新 React state（立即重排），再落盘；落盘失败只影响下次启动。 */
			const persistOrderMap = (next, setOrderMap) => {
				try { if (typeof setOrderMap === "function") { setOrderMap(next); } } catch { /* 渲染层异常不影响落盘 */ }
				try {
					if (typeof localStorage !== "undefined") {
						localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(next));
					}
				} catch { /* 落盘失败只影响下次启动 */ }
			};

			/**
			 * ＋ 菜单的两个动作共用的"说清楚"通道（**就地渲染**，不只靠 notify）。
			 *
			 * ★ 窗口模式（desktop）里**没有宿主桥** ⇒ `bridge.notify` 是空转 ⇒ 失败若只写
			 *   `state.*` 就是 100% 静默（用户看到的就是"点了没反应"）✗ ⇒ 必须在区里渲染一行 ✓。
			 */
			const makeSayer = (setMsg) => (text, kind) => {
				const isErr = kind === "error";
				state.addWorkspaceError = isErr ? text : null;
				state.addWorkspaceNote = isErr ? null : text;
				try { if (setMsg) { setMsg({ kind: isErr ? "error" : "note", text: String(text) }); } } catch { /* 渲染失败不影响别的 */ }
				notify(isErr ? "warn" : "info", text);
			};
			// ＋ 添加工作区：官方同一条链（uiWorkspace.pickDirectory → workspaces.create）✓
			// 两个服务都不进 inject（硬依赖教训 ✓），读不到就**如实说清**、不静默。
			//
			// ★ 2026-10-26（窗口模式点了没反应）—— 原来这条链有**三处**各自能静默失败：
			//   ① `ctx.remote.directoryPicker`：官方 client-ui-workspace 的 inject 里声明了
			//      "remote" **和** "remote.directoryPicker"，我们只声明了 "remote" ⇒ 后者不是
			//      我们的服务（动态 client 门面读不到）⇒ picker 恒 undefined ⇒ 直接早退。
			//      ⇒ 改用**已声明**的 `ctx.uiWorkspace.pickDirectory()`（官方同一份能力；
			//        本仓 vssaros-workbenches 早就在用这条 ✓）。
			//   ② 返回形状：`pickDirectory()` 返回的是**路径字符串**（原生 picker 的 value 就是
			//      path），老代码读 `res.value.path` ⇒ 恒 undefined ⇒ 选完也什么都不做。
			//   ③ 失败只写 `state.addWorkspaceError`，而它**从来没被渲染** ⇒ 100% 静默；
			//      且窗口模式没有宿主桥（`window.vssarosDsh` 不存在）⇒ `bridge.notify` 也是空转。
			//      ⇒ 现在错误**就地渲染**在区里（见 Browser 的 wsMsg），成功也写一行。
			const addWorkspace = (setMsg) => {
				const say = makeSayer(setMsg);
				try {
					const uw = ctx.uiWorkspace;
					const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
					if (!uw || typeof uw.pickDirectory !== "function") {
						say("添加工作区失败：宿主没有目录选择器（uiWorkspace.pickDirectory 不可用）", "error");
						return;
					}
					if (!ws || typeof ws.create !== "function") {
						say("添加工作区失败：workspaces 服务不可用", "error");
						return;
					}
					void Promise.resolve(uw.pickDirectory()).then((picked) => {
						// 取消 = 用户主动关闭 ⇒ 不算错误，但也**要说清**（否则像"点了没反应"）。
						if (typeof picked !== "string" || !picked) {
							say("已取消选择目录（未添加工作区）", "note");
							return undefined;
						}
						return Promise.resolve(ws.create({ path: picked })).then(() => {
							say("已添加工作区：" + picked, "note");
						});
					}).catch((e) => {
						say("添加工作区失败：" + String((e && e.message) || e), "error");
					});
				} catch (e) {
					say("添加工作区失败：" + String((e && e.message) || e), "error");
				}
			};

			/**
			 * 从 `.code-workspace` 文件**导入多根工作区**（2026-10-26，用户要求）。
			 *
			 * 为什么必须请 IDE 侧做：页面是浏览器上下文 ⇒ ① 读不了文件；② 没有**文件**选择器
			 *   （dsh 只有目录选择器）⇒ 选文件、解析 `folders[]`、落一条多根记录、把各根注册进 dsh，
			 *   全都要 IDE 侧的能力 ⇒ 走页面桥的 `importCodeWorkspace`（宿主转成 IDE 命令
			 *   `agentStudio.workspace.importCodeWorkspace`）。
			 *
			 * ⚠ 页面桥是**单向**的（只回 true）⇒ 这里拿不到"导入成功/失败" ⇒
			 *   ① 成功时只说"已请求导入，导入完成后会出现在下面"（真正成功由 IDE 通知 + 列表刷新体现）；
			 *   ② **没有桥**（官方 dsh desktop）⇒ 明确说清，不静默 ✗。
			 */
			const importCodeWorkspace = (setMsg) => {
				const say = makeSayer(setMsg);
				if (!bridge || typeof bridge.importCodeWorkspace !== "function") {
					say("当前环境不支持导入（这一版没有宿主桥，无法选 .code-workspace 文件）", "error");
					return;
				}
				try {
					void Promise.resolve(bridge.importCodeWorkspace()).then(() => {
						say("已请 IDE 侧选一个 .code-workspace 文件；导入完成后它会作为一个「N 个根」的工作区出现在下面", "note");
					}).catch((e) => {
						say("导入请求失败：" + String((e && e.message) || e), "error");
					});
				} catch (e) {
					say("导入请求失败：" + String((e && e.message) || e), "error");
				}
			};

			function useData() {
				const [wsSnap, setWsSnap] = react.useState(readWsSnapshot);
				const [, setTick] = react.useState(0);
				const [records, setRecords] = react.useState(readRecords);
				react.useEffect(() => {
					let sub = null;
					try {
						const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
						if (ws && ws.list && typeof ws.list.subscribe === "function") {
							sub = ws.list.subscribe(() => setWsSnap(readWsSnapshot()));
						}
					} catch (e) { state.workspaceError = String((e && e.message) || e); }
					return () => { try { if (typeof sub === "function") { sub(); } } catch { /* 已释放 */ } };
				}, []);
				react.useEffect(() => {
					let sub = null;
					try {
						const ss = ctx.sessions && ctx.sessions.list;
						if (ss && typeof ss.subscribe === "function") {
							sub = ss.subscribe(() => setTick((n) => n + 1));
						}
					} catch (e) { state.sessionListError = String((e && e.message) || e); }
					return () => { try { if (typeof sub === "function") { sub(); } } catch { /* 已释放 */ } };
				}, []);
				// ★ 会话 roster 的**拉取**（2026-10-17 真机）：`sessions.list` 的 `phase` 默认 `pending`
				//   （官方注释："items 为空不等于没有会话，而是**什么都没到**"），拉取由官方侧栏
				//   WorkspaceBrowser 触发 —— 而**本组件就是替换它的那个** ⇒ 必须自己触发，
				//   否则 roster 恒空：会话标题只能回落到 id、`openSession` 恒 unknown session ✗✗。
				react.useEffect(() => {
					try {
						// ⚠ 服务面方法名是 `refresh()`（不是 refreshList —— 后者只在 manager 上，
						//   2026-10-17 实测写错名字时被 typeof 判空静默跳过 ✓）。
						const svc = ctx.sessions;
						const fn = svc && (typeof svc.refresh === "function" ? svc.refresh
							: typeof svc.refreshList === "function" ? svc.refreshList : null);
						if (fn) {
							state.rosterRefreshVia = fn === svc.refresh ? "refresh" : "refreshList";
							void Promise.resolve(fn.call(svc)).catch((e) => {
								state.rosterRefreshError = String((e && e.message) || e);
							});
						}
					} catch (e) { state.rosterRefreshError = String((e && e.message) || e); }
				}, []);
				react.useEffect(() => {
					if (typeof document === "undefined") { return undefined; }
					const onPush = () => setRecords(readRecords());
					document.addEventListener(WORKSPACE_EVENT, onPush);
					return () => document.removeEventListener(WORKSPACE_EVENT, onPush);
				}, []);
				return { wsSnap, records };
			}

			// ── 样式（dsh alias token + 硬兜底 ✓）────────────────────────────────
			const S = {
				head: { display: "flex", alignItems: "center", gap: 10, height: 30, padding: "0 4px 0 8px", marginTop: 8, color: "var(--dsw-alias-label-secondary, #a3a3a3)", flex: "0 0 auto" },
				headT: { flex: "1 1 auto", fontSize: 12.5 },
				iconBtn: { background: "none", border: "none", color: "inherit", cursor: "pointer", padding: "2px 4px", borderRadius: 4, fontSize: 12, lineHeight: 1 },
				list: { flex: "1 1 auto", minHeight: 0, overflowY: "auto" },
				// ★ 2026-11-02（对齐官方 `Rows.module.css` 的 `.projectRow`）：
				//   分组行 **34px**、`gap:6`、`padding:0 8px` —— 官方 projectRow 34 / sessionRow 32，
				//   分组比会话略高；原来我们 28/29 两者几乎等高，层级只靠箭头区分，显得平 ✗。
				row: { display: "flex", alignItems: "center", gap: 6, height: 34, padding: "0 8px", borderRadius: "var(--dsw-radius-md, 6px)", cursor: "pointer", whiteSpace: "nowrap", color: "var(--dsw-alias-label-secondary, #a3a3a3)" },
				lbl: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
				// 时间戳降为 10px（2026-10-21 对齐 dsh-desktop：它是次要信息，别跟标题抢视线）
				meta: { fontSize: 10, color: "var(--dsw-alias-label-tertiary, #737373)", flex: "0 0 auto", opacity: .9 },
				badge: { fontSize: 10, lineHeight: "15px", padding: "0 6px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #383838)", color: "var(--dsw-alias-label-tertiary, #737373)", flex: "0 0 auto" },
				rtag: { fontSize: 10, lineHeight: "15px", padding: "0 6px", borderRadius: 4, border: "1px solid var(--dsw-alias-border-l2, #383838)", color: "var(--dsw-alias-label-tertiary, #737373)", flex: "0 0 auto", maxWidth: 74, overflow: "hidden", textOverflow: "ellipsis" },
				card: {
					position: "fixed", zIndex: 60, width: 380, padding: "12px 12px 10px", borderRadius: 12,
					background: "var(--dsw-alias-bg-layer-2, #262626)", border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
					boxShadow: "0 16px 40px rgba(0,0,0,.6)", color: "var(--dsw-alias-label-primary, #e6e6e6)",
				},
				search: { width: "100%", margin: "2px 0 6px", padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #383838)", background: "var(--dsw-alias-bg-layer-1, #262626)", color: "inherit", fontSize: 12, outline: "none" },
				// ＋ 菜单里的条目（两个动作：加单目录 / 导入多根）
				menuItem: {
					display: "block", width: "100%", textAlign: "left", background: "none", border: "none",
					color: "inherit", cursor: "pointer", fontSize: 12, lineHeight: "1.4",
					padding: "6px 8px", borderRadius: 6,
				},
				// ── 会话行（2026-10-29）：置顶图钉 / 就地重命名 / 操作反馈 ──
				// ★ 2026-10-30：图钉已挪到**行尾**（时间左边）且**只在意置顶时渲染** ——
				//   不再需要固定 12px 占位（那个占位正是把标题推右 19px 的元凶）。
				pin: {
					flex: "0 0 auto", fontSize: 10, lineHeight: "16px",
					color: "var(--dsw-alias-brand-primary, #5b8cff)", opacity: .95,
				},
				rename: {
					flex: "1 1 auto", minWidth: 0, font: "inherit", fontSize: 12.5, lineHeight: "17px",
					color: "var(--dsw-alias-label-primary, #e6e6e6)",
					background: "var(--dsw-alias-bg-layer-1, #1a1a1a)",
					border: "1px solid var(--dsw-alias-brand-primary, #5b8cff)",
					borderRadius: 4, padding: "0 4px", outline: "none",
				},
				// ★★ 2026-11-02（用户报「工作区文本下方会显示日志文本，不合理」）：
				//   原来这是一行**行内**文本，插在列表上方 ⇒ ①把列表往下挤；②长文案一直留在那儿像日志。
				//   改成**浮层 toast**：`position:fixed` 贴底居中、不参与布局、指针穿透（不挡点击），
				//   配合 `say()` 的 6s 自动消失 ⇒ 只在需要时瞥一眼，不会常驻。
				sessMsg: {
					position: "fixed", zIndex: 96, left: "50%", bottom: 18, transform: "translateX(-50%)",
					maxWidth: "min(420px, calc(100vw - 32px))",
					padding: "6px 12px", borderRadius: 8,
					fontSize: 11.5, lineHeight: "1.5", whiteSpace: "normal",
					background: "var(--dsw-alias-bg-layer-2, #262626)",
					border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
					boxShadow: "0 10px 28px rgba(0,0,0,.45)",
					color: "var(--dsw-alias-label-secondary, #cfd3d6)",
					pointerEvents: "none", textAlign: "center",
				},
				// 删除确认层的按钮（危险操作 ⇒ 红色主按钮；与 dsh 官方 Modal 的按钮尺寸对齐）
				confirmBtn: {
					height: 28, padding: "0 14px", borderRadius: 6, fontSize: 12, cursor: "pointer",
					border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
					background: "var(--dsw-alias-bg-layer-1, #2a2a2a)",
					color: "var(--dsw-alias-label-primary, #e6e6e6)",
				},
				confirmDanger: { background: "#b3302c", borderColor: "#c9403a", color: "#fff", fontWeight: 600 },
				// 「展开其余 N 条」/「收起」：与会话行同一套字号，缩进略浅（它是**操作**，不是会话）
				moreRow: {
					display: "block", width: "100%", textAlign: "left", padding: "2px 8px 3px 26px",
					background: "none", border: "none", borderRadius: 6, cursor: "pointer",
					color: "var(--dsw-alias-label-tertiary, #737373)", fontSize: 11.5,
				},
				// ── 状态点 / 未读点（2026-11-02，用户要求「UI 样式复刻 dsh-desktop」）────────────
				// 视觉语言对齐官方行（`SessionStatusDots` / `StateDot`）：leading 位放**小圆点**，
				// 不再用原来的 2px 竖条 —— 否则和官方会话行并排就是两种语言。
				// ⚠ 尺寸恒定（8px 圆点 + 固定 flex 占位）：开关灯/未读点标题不横跳（与图钉同一条教训）。
				ring: {
					width: 8, height: 8, borderRadius: "50%", flex: "0 0 8px",
					margin: "0 1px 0 0", background: "transparent", boxSizing: "border-box",
				},
				ringRunning: { background: "#3fb950", animation: "vssaros-ws-ring-pulse 1.6s ease-in-out infinite" },
				ringAwaiting: { background: "#d7a521" },
				ringIdle: { background: "rgba(128,128,128,.5)" },
				// 未读点：官方用 `StateDot{state:'done'}`；这里取品牌蓝 ——
				// 「状态」回答"在跑没跑"，「未读」回答"看过没"，两件事不用同一种颜色。
				unreadDot: {
					width: 6, height: 6, borderRadius: "50%", flex: "0 0 6px",
					margin: "0 2px 0 0", background: "var(--dsw-alias-brand-primary, #5b8cff)",
				},
				// ── 会话行 hover 卡片（2026-11-02）：内容数值抄官方 `SessionHoverContent` ──
				//   标题 14/20 允许换行、时间 12/16、状态行 12/20 + 8px 点线间距（`Rows.module.css`）。
				sessHoverCard: {
					position: "fixed", zIndex: 85, width: 300, maxWidth: "calc(100vw - 16px)",
					padding: "10px 12px", borderRadius: 8,
					display: "flex", flexDirection: "column", gap: 8,
					background: "var(--dsw-alias-bg-layer-2, #262626)",
					border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
					boxShadow: "0 16px 40px rgba(0,0,0,.55)",
					color: "var(--dsw-alias-label-primary, #e6e6e6)",
				},
				sessHoverTitle: { fontSize: 14, lineHeight: "20px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #fff)", overflowWrap: "break-word" },
				sessHoverTime: { fontSize: 12, lineHeight: "16px", color: "var(--dsw-alias-label-secondary, #cfd3d6)" },
				sessHoverPath: { fontSize: 12, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary, #adb2b8)", wordBreak: "break-all" },
				sessHoverStatus: { fontSize: 12, lineHeight: "20px", color: "var(--dsw-alias-label-tertiary, #adb2b8)", display: "flex", alignItems: "center", gap: 8 },
				sessHoverCopy: {
					alignSelf: "flex-start", marginTop: 2, padding: "2px 8px", borderRadius: 6,
					fontSize: 11, lineHeight: "16px", cursor: "pointer", color: "inherit",
					background: "var(--dsw-alias-bg-layer-1, #2a2a2a)",
					border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
				},
				sessMenu: {
					position: "fixed", zIndex: 80, minWidth: 186, padding: 4, borderRadius: 8,
					background: "var(--dsw-alias-bg-layer-2, #262626)",
					border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
					boxShadow: "0 12px 32px rgba(0,0,0,.55)",
					color: "var(--dsw-alias-label-primary, #e6e6e6)",
				},
				// ── 「会话 / Bots」页签（2026-11-02，Bots 工作台重构）──────────────
				// 分段控件（用户 2026-11-02 拍板 A）：与右栏页签同一套视觉语言。
				//
				// ★★ 2026-11-02 二次（用户报「现在看不清哪个被选中了」）：
				//   原来选中态是 `bg-layer-1(#2f2f2f)`、容器是 `bg-layer-2(#242424)` —— 只差 11/255，
				//   在深色主题里几乎不可辨 ✗。现在改成**双重编码**：
				//     ① 底色：容器更暗（`#1b1b1b`）、选中更亮（`#3d3d3d`）⇒ 明度差 ~34；
				//     ② 位置：选中项底部一条 **2px 品牌色**（`inset 0 -2px 0`）—— 不依赖色觉；
				//     ③ 文字：选中纯白 600 字重 / 未选中 `#8a8a8a`（差 ~115）。
				//   ⚠ 颜色/字重交给注入的 CSS（`.vssaros-ws-tab[data-on="1"]`），因为还要 `:hover`；
				//     内联 style 只留布局尺寸（内联会盖掉 CSS ⇒ 颜色一旦内联就没法再 hover ✗）。
				tabBar: {
					display: "flex", gap: 2, flex: "0 0 auto", padding: 2, margin: "6px 8px 0",
					borderRadius: 8, border: "1px solid var(--dsw-alias-border-l1, #383838)",
					background: "var(--dsw-alias-bg-layer-1, #1b1b1b)",
				},
				tabBtn: {
					flex: "1 1 0", minWidth: 0, height: 26, padding: "0 8px", border: "none", borderRadius: 6,
					// ⚠ 不要写 `font: "inherit"` —— 那是**简写**，会连 `font-weight` 一起重置成 400，
					//   而内联优先级高于注入的 CSS ⇒ 选中态的 `font-weight:600` 永远不生效
					//   （2026-11-02 真机实测：computed weight 一直是 400 ✗）。拆成逐项写。
					fontFamily: "inherit", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
					overflow: "hidden", textOverflow: "ellipsis",
				},
				// 保留一份兜底（CSS 没注进去时也不至于全透明）；正常情况由 CSS 覆盖
				tabBtnOn: {
					background: "var(--dsw-alias-bg-layer-3, #3d3d3d)",
					color: "var(--dsw-alias-label-primary, #ffffff)", fontWeight: 600,
				},
				botsPane: { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" },
				botsHint: { padding: "4px 10px 6px", fontSize: 11, lineHeight: "1.55", color: "var(--dsw-alias-label-tertiary, #737373)", whiteSpace: "normal" },
				// ── 「新建 Bot / 新建群聊」表单（2026-11-02；fixed 浮层，侧栏太窄放不下）──
				botsForm: {
					position: "fixed", zIndex: 86, width: 300, maxWidth: "calc(100vw - 16px)",
					left: "50%", top: 72, transform: "translateX(-50%)",
					padding: 12, borderRadius: 10, display: "flex", flexDirection: "column", gap: 6,
					background: "var(--dsw-alias-bg-layer-2, #262626)",
					border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
					boxShadow: "0 20px 48px rgba(0,0,0,.6)",
					color: "var(--dsw-alias-label-primary, #e6e6e6)",
				},
				botsFormTitle: { fontSize: 13, fontWeight: 600, marginBottom: 2 },
				botsFormLabel: { fontSize: 10.5, lineHeight: "16px", marginTop: 2, color: "var(--dsw-alias-label-tertiary, #737373)" },
				botsFormInput: {
					height: 26, padding: "0 8px", borderRadius: 6,
					border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
					background: "var(--dsw-alias-bg-layer-1, #1f1f1f)", color: "inherit",
					// ⚠ 不用 `font` 简写（会连 font-weight/line-height 一起重置；本仓踩过）
					fontFamily: "inherit", fontSize: 12, outline: "none",
				},
				botsFormMembers: {
					maxHeight: 168, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1,
					padding: 4, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
				},
				botsFormMemRow: {
					display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer",
					padding: "2px 4px", borderRadius: 4, color: "var(--dsw-alias-label-secondary, #cfd3d6)",
				},
				botsFormRow: { display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4 },
				botsFormBtn: {
					height: 26, padding: "0 12px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 12,
					border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
					background: "var(--dsw-alias-bg-layer-1, #1f1f1f)", color: "inherit",
				},
				botsFormBtnPrimary: {
					border: "1px solid var(--dsw-alias-brand-primary, #0e639c)",
					background: "var(--dsw-alias-brand-primary, #0e639c)", color: "#fff", fontWeight: 600,
				},
				botsFormErr: { fontSize: 11, lineHeight: "1.5", color: "#f48771", whiteSpace: "normal" },
				// ── 表单的**结构件**（2026-11-02「弹出的 UI 框要完善」）──────────────
				botsFormHead: {
					display: "flex", alignItems: "center", gap: 8, paddingBottom: 8,
					borderBottom: "1px solid var(--dsw-alias-border-l1, #3a3a3a)", flex: "0 0 auto",
				},
				botsFormHeadT: { fontSize: 13, fontWeight: 600, flex: "1 1 auto" },
				botsFormClose: {
					width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center",
					border: "none", background: "transparent", color: "var(--dsw-alias-label-tertiary, #8a8a8a)",
					borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 13, lineHeight: 1,
				},
				botsFormBody: {
					display: "flex", flexDirection: "column", gap: 8,
					maxHeight: "min(64vh, 460px)", overflowY: "auto", paddingRight: 2,
				},
				botsFormField: { display: "flex", flexDirection: "column", gap: 3 },
				botsFormFieldHead: { display: "flex", alignItems: "baseline", gap: 6 },
				botsFormCounter: {
					marginLeft: "auto", fontSize: 10, lineHeight: "14px",
					color: "var(--dsw-alias-label-tertiary, #737373)", fontVariantNumeric: "tabular-nums",
				},
				botsFormOk: { fontSize: 10.5, lineHeight: "16px", color: "#3fb950" },
				botsFormBad: { fontSize: 10.5, lineHeight: "16px", color: "#f48771" },
				botsFormTip: {
					fontSize: 10.5, lineHeight: "15px", color: "var(--dsw-alias-label-tertiary, #737373)", whiteSpace: "normal",
				},
				botsFormIcons: { display: "flex", flexWrap: "wrap", gap: 4 },
				botsFormIconBtn: {
					width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center",
					borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 13, lineHeight: 1,
					border: "1px solid var(--dsw-alias-border-l1, #3a3a3a)",
					background: "var(--dsw-alias-bg-layer-1, #1f1f1f)", color: "inherit",
				},
				botsFormIconOn: {
					border: "1px solid var(--dsw-alias-brand-primary, #0e639c)",
					boxShadow: "inset 0 0 0 1px var(--dsw-alias-brand-primary, #0e639c)",
				},
				botsFormModeRow: { display: "flex", gap: 3, flexWrap: "wrap" },
				botsFormModeBtn: {
					flex: "1 1 0", minWidth: 58, height: 24, borderRadius: 6, cursor: "pointer",
					fontFamily: "inherit", fontSize: 11, padding: "0 6px", whiteSpace: "nowrap",
					border: "1px solid var(--dsw-alias-border-l1, #3a3a3a)",
					background: "var(--dsw-alias-bg-layer-1, #1f1f1f)",
					color: "var(--dsw-alias-label-tertiary, #8a8a8a)",
				},
				botsFormModeOn: {
					border: "1px solid var(--dsw-alias-brand-primary, #0e639c)",
					background: "var(--dsw-alias-brand-primary, #0e639c)", color: "#fff", fontWeight: 600,
				},
				botsFormPreview: {
					display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 8,
					border: "1px dashed var(--dsw-alias-border-l2, #3e3e3e)",
					background: "var(--dsw-alias-bg-layer-1, #1f1f1f)",
				},
				botsFormPreviewAv: {
					width: 26, height: 26, borderRadius: 8, flex: "0 0 26px", display: "flex",
					alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#fff",
					background: "var(--dsw-alias-brand-primary, #0e639c)",
				},
				botsFormPreviewMain: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
				botsFormPreviewName: { fontSize: 12.5, lineHeight: "18px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
				botsFormPreviewMeta: { fontSize: 10.5, lineHeight: "15px", color: "var(--dsw-alias-label-tertiary, #737373)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
				botsFormMemAv: {
					width: 16, height: 16, borderRadius: 5, flex: "0 0 16px", display: "inline-flex",
					alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#fff",
					background: "var(--dsw-alias-bg-layer-3, #3d3d3d)",
				},
				botsFormTools: { display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" },
				botsFormMini: {
					height: 20, padding: "0 7px", borderRadius: 5, cursor: "pointer", fontFamily: "inherit",
					fontSize: 10.5, border: "1px solid var(--dsw-alias-border-l1, #3a3a3a)",
					background: "var(--dsw-alias-bg-layer-1, #1f1f1f)", color: "var(--dsw-alias-label-secondary, #cfd3d6)",
				},
				botsSec: { display: "flex", alignItems: "center", gap: 6, padding: "8px 10px 2px", fontSize: 10.5, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dsw-alias-label-tertiary, #737373)" },
				botsSecCt: { marginLeft: "auto" },
				botRow: { display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap" },
				botAv: { width: 22, height: 22, borderRadius: 7, flex: "0 0 22px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff", background: "var(--dsw-alias-brand-primary, #4d7cfe)" },
				botMain: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 0 },
				botL1: { display: "flex", alignItems: "center", gap: 5, minWidth: 0, fontSize: 12.5, color: "var(--dsw-alias-label-primary, #e6e6e6)" },
				botName: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
				botPill: { fontSize: 9.5, lineHeight: "14px", padding: "0 5px", borderRadius: 4, flex: "0 0 auto", border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)", color: "var(--dsw-alias-label-tertiary, #737373)" },
				botL2: { fontSize: 10.5, color: "var(--dsw-alias-label-tertiary, #737373)", overflow: "hidden", textOverflow: "ellipsis" },
				/** DS Bot 对标的 bot item 状态：静态彩点 + 第二行 shimmer；头像姿态动画由样式表给。 */
				botStateDot: { width: 7, height: 7, borderRadius: 999, flex: "0 0 7px", marginLeft: 4, boxShadow: "0 0 0 1px var(--dsw-alias-border-l2, transparent)" },
				botStateText: { fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			};

			/**
			 * 状态灯的**脉动**动效只能靠样式表给（React 内联 style 没有 @keyframes）。
			 * 一次性注入 + 幂等（`data-*` 标记）：重复 install / 多窗口热更都不会叠出 N 份 ✗。
			 * ⚠ 尊重 `prefers-reduced-motion`：关掉动效但**保留绿色** —— 颜色本身就是"在跑"的静态事实 ✓。
			 */
			const ensureRingStyle = () => {
				try {
					if (typeof document === "undefined" || !document.head) { return; }
					if (document.head.querySelector("[data-vssaros-ws-ring-style]")) { return; }
					const st = document.createElement("style");
					st.setAttribute("data-vssaros-ws-ring-style", "1");
					st.textContent = "@keyframes vssaros-ws-ring-pulse{0%,100%{opacity:1}50%{opacity:.35}}"
						+ "@media (prefers-reduced-motion: reduce){[data-ws-ring='running']{animation:none !important;opacity:1 !important}}";
					document.head.appendChild(st);
				} catch { /* 没有 head（非 DOM 环境 / __test）⇒ 静默跳过，灯照样有颜色 ✓ */ }
			};

			/**
			 * ★ 2026-11-05：Bots 行对标 DS Bot 的动画集合（见 DeepSeek-Bot `client/styles.js:60-102,1063-1075`）。
			 * 头像姿态：thinking=ponder、working=bob、searching=seek、sending=dash、orbit/waiting=sway、
			 * alert=hop、done=squash 回弹；第二行用 shimmer 扫光；彩点只有 .13s 入场，不做 pulse/ring。
			 * 一次性注入 + 幂等；`prefers-reduced-motion` 关动画但保留状态文字/彩点。
			 */
			const ensureBotStateStyle = () => {
				try {
					if (typeof document === "undefined" || !document.head) { return; }
					if (document.head.querySelector("[data-vssaros-bot-state-style]")) { return; }
					const st = document.createElement("style");
					st.setAttribute("data-vssaros-bot-state-style", "1");
					st.textContent = [
						"@keyframes vssaros-bot-bob{0%,100%{transform:translateY(0) rotate(0)}30%{transform:translateY(-4%) rotate(-5deg)}65%{transform:translateY(0) rotate(4deg)}}",
						"@keyframes vssaros-bot-ponder{0%,100%{transform:translateY(0) rotate(4deg)}50%{transform:translateY(-3%) rotate(7deg)}}",
						"@keyframes vssaros-bot-seek{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-5%) rotate(-1deg)}}",
						"@keyframes vssaros-bot-dash{0%,100%{transform:translateX(0) rotate(0)}35%{transform:translateX(9%) rotate(7deg)}55%{transform:translateX(-2%) rotate(-3deg)}}",
						"@keyframes vssaros-bot-sway{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(10deg)}}",
						"@keyframes vssaros-bot-hop{0%,55%,100%{transform:translateY(0) scale(1,1)}20%{transform:translateY(-14%) scale(.96,1.05)}40%{transform:translateY(0) scale(1.06,.94)}}",
						"@keyframes vssaros-bot-done{0%{transform:none}13.3%{transform:scale(1.12,.88)}25.6%{transform:scale(.93,1.09)}37.8%{transform:scale(1.04,.97)}51.1%,100%{transform:none}}",
						"@keyframes vssaros-bot-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}",
						"@keyframes vssaros-bot-dot-in{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}",
						"[data-vssaros-bot-state='thinking'] [data-vssaros-bot-avatar]{animation:vssaros-bot-ponder 2.2s ease-in-out infinite}",
						"[data-vssaros-bot-state='working'] [data-vssaros-bot-avatar]{animation:vssaros-bot-bob 1.6s ease-in-out infinite}",
						"[data-vssaros-bot-state='searching'] [data-vssaros-bot-avatar]{animation:vssaros-bot-seek 1s ease-in-out infinite}",
						"[data-vssaros-bot-state='sending'] [data-vssaros-bot-avatar]{animation:vssaros-bot-dash 1.1s cubic-bezier(.4,0,.2,1) infinite}",
						"[data-vssaros-bot-state='orbit'] [data-vssaros-bot-avatar],[data-vssaros-bot-state='waiting'] [data-vssaros-bot-avatar]{animation:vssaros-bot-sway 2.6s ease-in-out infinite}",
						"[data-vssaros-bot-state='alert'] [data-vssaros-bot-avatar]{animation:vssaros-bot-hop 1.3s cubic-bezier(.3,.7,.4,1) 2}",
						"[data-vssaros-bot-state='done'] [data-vssaros-bot-avatar]{animation:vssaros-bot-done 1.8s linear 1}",
						"[data-vssaros-bot-dot]{animation:vssaros-bot-dot-in .13s cubic-bezier(.22,1,.36,1)}",
						"[data-vssaros-bot-state-label]{color:transparent;-webkit-text-fill-color:transparent;background:linear-gradient(90deg,var(--dsw-alias-label-tertiary) 0%,var(--dsw-alias-label-tertiary) 25%,var(--dsw-alias-label-primary) 60%,var(--dsw-alias-label-tertiary) 75%,var(--dsw-alias-label-tertiary) 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;animation:vssaros-bot-shimmer 2.2s steps(60) infinite}",
						"@media (prefers-reduced-motion:reduce){[data-vssaros-bot-state] [data-vssaros-bot-avatar],[data-vssaros-bot-dot],[data-vssaros-bot-state-label]{animation:none !important}[data-vssaros-bot-state-label]{background:none;color:var(--dsw-alias-label-secondary);-webkit-text-fill-color:currentColor}}",
					].join("");
					document.head.appendChild(st);
				} catch { /* 没有 head ⇒ 状态文字/彩点仍由内联样式保证可见 */ }
			};

			/**
			 * 会话行的**布局/交互样式**（2026-11-02，用户要求「复刻 dsh 官方原生的 item UI」）。
			 *
			 * 数值**逐条抄官方** `@deepseek-ai/dsh-client-ui-workspace` 的 `Rows.module.css`（`YDXeBa_*`）：
			 *   · 行：`height:32px; gap:0; padding:0 8px; border-radius:var(--dsw-radius-md)`；
			 *     悬停 / 选中 / 菜单打开 = `background: var(--dsw-alias-interactive-bg-hover)`；
			 *   · leading 格：`16px × 20px`（官方 `.slot`），里面只放**一个**标记（状态点 / 未读点）；
			 *   · 标题：`14px / 20px`、`margin:0 6px 0 4px`、`flex:1`、溢出省略；
			 *     悬停时 `text-overflow:clip`（官方同款，配合右侧行尾动作让出空间）；
			 *   · 时间：`10px / 16px`、`label-tertiary`，**悬停时隐藏**（让位给 ⋯）；
			 *   · 图钉：`16×20`、`margin-left:6px`、`label-caption`，**悬停时也隐藏**；
			 *   · 行尾动作：默认 `display:none`，**悬停 / 菜单打开才出现**（官方 `.rowActions`）。
			 * ⚠ 这些是"悬停才变"的规则，React 内联 style 表达不了（没有 :hover）⇒ 必须走样式表；
			 *   用 `data-*` 标记做幂等（与 `ensureRingStyle` 同一套约定）。
			 */
			const ensureRowStyle = () => {
				try {
					if (typeof document === "undefined" || !document.head) { return; }
					if (document.head.querySelector("[data-vssaros-ws-row-style]")) { return; }
					const st = document.createElement("style");
					st.setAttribute("data-vssaros-ws-row-style", "1");
					st.textContent = ""
						+ ".vssaros-ws-row{height:32px;gap:0;padding:0 8px;border-radius:var(--dsw-radius-md,6px);"
						+ "display:flex;align-items:center;cursor:pointer;user-select:none;"
						+ "color:var(--dsw-alias-label-primary,#e6e6e6)}"
						+ ".vssaros-ws-row:hover,.vssaros-ws-row[data-current=\"1\"],.vssaros-ws-row[data-menu-open=\"1\"]"
						+ "{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}"
						+ ".vssaros-ws-slot{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;"
						+ "justify-content:center;color:var(--dsw-alias-label-tertiary,#737373)}"
						+ ".vssaros-ws-title{flex:1;min-width:0;font-size:14px;line-height:20px;margin:0 6px 0 4px;"
						+ "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
						+ "@media (hover:hover){.vssaros-ws-row:hover .vssaros-ws-title{text-overflow:clip}}"
						// ── 标题溢出：官方 `Rows.module.css` 的**两端淡出**（12px）──
						//   `.title[data-scrolled]{mask-image:linear-gradient(90deg,#0000,#000 12px)}`
						//   `.title[data-clipped]{mask-image:linear-gradient(270deg,#0000,#000 12px)}`
						//   两者都有时左右各淡 12px ⇒ 一眼看出"还有内容"，比纯省略号更像官方 ✓
						+ ".vssaros-ws-title[data-scrolled]{mask-image:linear-gradient(90deg,#0000,#000 12px)}"
						+ ".vssaros-ws-title[data-clipped]{mask-image:linear-gradient(270deg,#0000,#000 12px)}"
						+ ".vssaros-ws-title[data-scrolled][data-clipped]"
						+ "{mask-image:linear-gradient(90deg,#0000,#000 12px calc(100% - 12px),#0000)}"
						// 悬停时允许横向滚动（官方是 JS 跑马灯；我们用"淡出 + 原生滚动"，
						// 不引定时器 —— 滚动条按 WebKit/Firefox 两套都藏掉）
						+ "@media (hover:hover){.vssaros-ws-row:hover .vssaros-ws-title{overflow-x:auto;scrollbar-width:none}}"
						+ ".vssaros-ws-title::-webkit-scrollbar{display:none}"
						+ ".vssaros-ws-time{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary,#737373)}"
						+ ".vssaros-ws-pin{width:16px;height:20px;flex:none;margin-left:6px;display:inline-flex;"
						+ "align-items:center;justify-content:center;color:var(--dsw-alias-label-caption,#8a8a8a)}"
						+ ".vssaros-ws-actions{flex:none;display:none;align-items:center;gap:15px}"
						+ ".vssaros-ws-row:hover .vssaros-ws-actions,.vssaros-ws-row[data-menu-open=\"1\"] .vssaros-ws-actions"
						+ "{display:inline-flex}"
						+ ".vssaros-ws-row:hover .vssaros-ws-time,.vssaros-ws-row[data-menu-open=\"1\"] .vssaros-ws-time,"
						+ ".vssaros-ws-row:hover .vssaros-ws-pin,.vssaros-ws-row[data-menu-open=\"1\"] .vssaros-ws-pin{display:none}"
						+ ".vssaros-ws-icon{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;"
						+ "justify-content:center;padding:0;border:none;background:0 0;border-radius:var(--dsw-radius-xs,4px);"
						+ "cursor:pointer;color:var(--dsw-alias-label-tertiary,#737373)}"
						+ ".vssaros-ws-icon:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}"
						// ── 工作区行（官方 `.projectRow`）：默认**文件夹图标**，hover 才换成三角箭头 ──
						//   官方 CSS 原文：`.projectRow .chevron{display:none}` +
						//   `.projectRow:hover .chevron{display:inline-flex}` + `.projectRow:hover .folder{display:none}`
						+ ".vssaros-ws-project{height:34px;gap:0;padding:0 8px;border-radius:var(--dsw-radius-md,6px);"
						+ "display:flex;align-items:center;cursor:pointer;user-select:none;"
						+ "color:var(--dsw-alias-label-primary,#e6e6e6)}"
						+ ".vssaros-ws-project:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}"
						+ ".vssaros-ws-slot2{width:16px;height:20px;flex:none;display:inline-flex;"
						+ "align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#737373)}"
						+ ".vssaros-ws-project .vssaros-ws-chevron{display:none}"
						+ ".vssaros-ws-project:hover .vssaros-ws-chevron{display:inline-flex}"
						+ ".vssaros-ws-project:hover .vssaros-ws-folder{display:none}"
						+ ".vssaros-ws-projtitle{flex:1;min-width:0;font-size:14px;line-height:20px;"
						+ "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
						// ── 「会话 / Bots」页签（2026-11-02 二次：用户报「看不清哪个被选中」）──
						//   未选中：透明 + 三级字；hover：二级字 + 微底；
						//   选中：`bg-layer-3` 亮底 + 纯白 600 + **底部 2px 品牌色**（不依赖色觉的双重编码）。
						//   ⚠ 选中规则写在 hover **之后**（且特异性更高）⇒ 悬停在选中项上不会被 hover 覆盖 ✓。
						+ ".vssaros-ws-tab{background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);"
						+ "transition:background .12s,color .12s,box-shadow .12s}"
						+ ".vssaros-ws-tab:hover{color:var(--dsw-alias-label-secondary,#cfd3d6);"
						+ "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}"
						// ⚠ 底色用 `interactive-bg-active` 而不是 `bg-layer-3`：真机测过后者在本主题下是
						//   `#353638`、容器是 `#252526` ⇒ 只差 16/255，用户仍然"看不清"✗。
						//   active 档更亮，且再叠一圈 1px 亮边把轮廓画出来。
						+ ".vssaros-ws-tab[data-on=\"1\"]{background:var(--dsw-alias-interactive-bg-active,#414346);"
						+ "color:var(--dsw-alias-label-primary,#ffffff);font-weight:600;"
						+ "box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary,#0e639c),"
						+ "inset 0 0 0 1px rgba(255,255,255,.12)}"
						// 官方 `.projectRow .rowActions{height:20px}` + 同样"悬停才出现"
						// ★ 2026-11-02：工作区行现在有 **两个** 动作（+ 新建会话 / ⋯ 菜单）⇒ 间距从
						//   会话行继承来的 15px 收到 6px（15px 是"单个 ⋯ 与时间之间"的留白，两个图标挨着时太散 ✗）；
						//   并补 `:focus-within`，让键盘 Tab 进按钮时也保持可见（官方同行为）。
						+ ".vssaros-ws-project .vssaros-ws-actions{display:none;gap:6px}"
						+ ".vssaros-ws-project:hover .vssaros-ws-actions,"
						+ ".vssaros-ws-project:focus-within .vssaros-ws-actions{display:inline-flex}";
					document.head.appendChild(st);
				} catch { /* 无 head（__test / 非 DOM）⇒ 静默跳过，行仍可用（只是没有悬停效果） */ }
			};

			/** hover 详情卡（fixed 定位到条目右侧；夹进视口——WebContentsView 外会被裁 ✗）。 */
			function HoverCard(props) {
				const rec = props.record;
				const sessionsPerRoot = rec.roots.map((rt, i) => props.sessions.filter((s) => (s.rootName || rt.name) === rt.name && (rt.isPrimary ? !s.rootName || s.rootName === rt.name : true)).length);
				return react.createElement("div", { style: Object.assign({}, S.card, { left: props.x, top: props.y }) },
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						react.createElement("b", { style: { fontSize: 14 } }, rec.name),
						react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #737373)" } }, "多根工作区 · " + rec.roots.length + " 个根"),
					),
					rec.codeWorkspacePath ? react.createElement("div", { style: { fontFamily: "Consolas, monospace", fontSize: 11, color: "var(--dsw-alias-label-tertiary, #737373)", margin: "3px 0 8px" } }, rec.codeWorkspacePath) : null,
					rec.roots.map((rt, i) => {
						const cur = rt.path && props.currentRootPath && samePath(rt.path, props.currentRootPath);
						return react.createElement("div", {
							key: rt.path, style: {
								display: "grid", gridTemplateColumns: "1fr auto", gap: "2px 8px", padding: "7px 8px", borderRadius: 8, marginTop: 2,
								background: cur ? "rgba(67,184,96,.08)" : "transparent", outline: cur ? "1px solid rgba(67,184,96,.35)" : "none",
							},
						},
							react.createElement("span", { style: { fontWeight: 600, display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
								rt.name,
								rt.isPrimary ? react.createElement("span", { style: { fontSize: 10, fontWeight: 400, color: "var(--dsw-alias-label-tertiary, #737373)", border: "1px solid var(--dsw-alias-border-l2, #383838)", borderRadius: 4, padding: "0 4px", lineHeight: "14px" } }, "主根") : null,
								cur ? react.createElement("span", { style: { fontSize: 10.5, fontWeight: 400, color: "#43b860" } }, "● 当前会话") : null,
							),
							react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #737373)" } }, sessionsPerRoot[i] + " 个会话"),
							react.createElement("span", { style: { gridColumn: "1 / 3", fontFamily: "Consolas, monospace", fontSize: 11, color: "var(--dsw-alias-label-secondary, #a3a3a3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, rt.path),
						);
					}),
					react.createElement("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l1, #353535)", marginTop: 8, paddingTop: 8, fontSize: 11, color: "var(--dsw-alias-label-tertiary, #737373)" } },
						"新建会话默认在主根；切根用聊天输入框下方的工作区入口"),
				);
			}

			/**
			 * ★ 2026-11-05：群执行中的全局浮层（对标 DS Bot 的 GroupEvent / MemberDock / roomProgress）。
			 * 用户不必先打开群会话才看到「已发到群 / 谁在回答 / 完成了」；点群名直接打开那条群会话。
			 * 同时轮询群列表：发现变化就发 `vssaros-rooms-changed`，P1 的 Bots 页签立刻合并，不等 2s 定时器。
			 * 前台 1s、后台 3s；没有活动 ⇒ 不占位。
			 */
			function GroupActivityDock() {
				const [active, setActive] = react.useState(() => {
					try { return typeof window !== "undefined" && Array.isArray(window.__vssarosGroupProgress) ? normalizeGroupActivity(window.__vssarosGroupProgress) : []; }
					catch { return []; }
				});
				/** 已打开群/成员会话时，composer dock 会广播可见性；这些 roomId 不再在右栏叠一张 tip。 */
				const [dockedRooms, setDockedRooms] = react.useState(() => {
					try { return typeof window !== "undefined" && Array.isArray(window.__vssarosGroupComposerDocks) ? window.__vssarosGroupComposerDocks.map(String) : []; }
					catch { return []; }
				});
				/** 前台页面声明了不要这张 tip（SuperAgent 工作台）。切页面不会发事件 ⇒ 低成本定时看一眼。 */
				const [tipOff, setTipOff] = react.useState(() => typeof document !== "undefined" && groupTipSuppressed(document));
				react.useEffect(() => {
					if (typeof document === "undefined") { return undefined; }
					const check = () => { setTipOff(groupTipSuppressed(document)); };
					check();
					const timer = setInterval(check, 400);
					return () => { clearInterval(timer); };
				}, []);
				react.useEffect(() => {
					const win = typeof window !== "undefined" ? window : null;
					if (!win || typeof win.addEventListener !== "function") { return undefined; }
					const onVisibility = (ev) => {
						const detail = ev && ev.detail ? ev.detail : {};
						const roomId = String(detail.roomId || "");
						if (!roomId) { return; }
						setDockedRooms((prev) => {
							const next = new Set(prev.map(String));
							if (detail.visible) { next.add(roomId); } else { next.delete(roomId); }
							return [...next];
						});
					};
					const onProgress = (ev) => {
						const detail = ev && ev.detail ? ev.detail : {};
						if (Array.isArray(detail.active)) { setActive(normalizeGroupActivity(detail.active)); }
					};
					win.addEventListener(GROUP_DOCK_VISIBILITY_EVENT, onVisibility);
					win.addEventListener(GROUP_PROGRESS_EVENT, onProgress);
					return () => {
						try {
							win.removeEventListener(GROUP_DOCK_VISIBILITY_EVENT, onVisibility);
							win.removeEventListener(GROUP_PROGRESS_EVENT, onProgress);
						} catch { /* 已释放 */ }
					};
				}, []);
				react.useEffect(() => {
					let alive = true;
					let timer = null;
					let lastSig = null;
					let lastActivitySig = null;
					// ★ 同一 window 只留一个轮询器（chunk 热重载 / 重复挂载时后来者接管，前者自动停）。
					const token = {};
					const win = typeof window !== "undefined" ? window : null;
					if (win) { win.__vssarosGroupActivityPoller = token; }
					const owner = () => !win || win.__vssarosGroupActivityPoller === token;
					const poll = () => {
						if (!owner()) { return; }
						void Promise.all([fetchRoomActivity(), fetchRoomsOnly()]).then(([a, r]) => {
							if (!alive || !owner()) { return; }
							const list = normalizeGroupActivity(a && Array.isArray(a.active) ? a.active : []);
							const activitySig = activitySignature(list, Date.now());
							// ★ 内容没变 ⇒ 不 setState、不广播（原来每秒全量广播驱动 4 个 React 子树重渲染）
							if (activitySig !== lastActivitySig) {
								lastActivitySig = activitySig;
								setActive(list);
								if (win) {
									try {
										const seq = (Number(win.__vssarosGroupProgressSeq) || 0) + 1;
										win.__vssarosGroupProgressSeq = seq;
										win.__vssarosGroupProgress = list;
										// ★ 2026-11-07：有选择卡等人答 ⇒ 群行亮未读（这里是唯一一直在跑的轮询）
										win.__vssarosGroupAskSeen = win.__vssarosGroupAskSeen || new Set();
										for (const roomId of askUnreadTargets(list, win.__vssarosGroupAskSeen, win.__vssarosGroupComposerDocks)) { setSessionUnread(roomId, true); }
										const Ctor = win.CustomEvent || (typeof CustomEvent !== "undefined" ? CustomEvent : null);
										if (Ctor) { win.dispatchEvent(new Ctor(GROUP_PROGRESS_EVENT, { detail: { schema: GROUP_ACTIVITY_SCHEMA, seq, active: list } })); }
									} catch { /* MemberDock 拿不到事件时也不影响浮层 */ }
								}
							}
							if (r && r.ok) {
								const sig = roomsSignature(r.rooms);
								if (lastSig !== null && sig !== lastSig && win) {
									try {
										const Ctor = win.CustomEvent || (typeof CustomEvent !== "undefined" ? CustomEvent : null);
										if (Ctor) { win.dispatchEvent(new Ctor(ROOMS_CHANGED_EVENT, { detail: { schema: GROUP_ACTIVITY_SCHEMA, rooms: r.rooms || [] } })); }
									} catch { /* 事件不可用 ⇒ 2s 轮询兜底 */ }
								}
								lastSig = sig;
							}
						}).finally(() => {
							if (!alive || !owner()) { return; }
							const hidden = typeof document !== "undefined" && document.hidden;
							timer = setTimeout(poll, hidden ? 3000 : 1000);
						});
					};
					poll();
					return () => {
						alive = false;
						if (timer) { clearTimeout(timer); }
						if (win && win.__vssarosGroupActivityPoller === token) { win.__vssarosGroupActivityPoller = null; }
					};
				}, []);
				const shown = active.filter((item) => !dockedRooms.includes(String((item && item.roomId) || "")));
				if (!shown.length || tipOff) { return null; }
				const open = (id) => {
					try {
						const uw = ctx.uiWorkspace;
						if (uw && typeof uw.openSession === "function") { uw.openSession(String(id)); }
					} catch { /* 打开失败也保留浮层信息 */ }
				};
				const elapsed = (item) => Math.max(0, Math.round((((item && (item.finishedAt || Date.now())) || Date.now()) - (item?.startedAt || Date.now())) / 1000));
				const statusColor = (status) => status === "failed" || status === "cut" ? "var(--dsw-alias-state-error-primary, #f14c4c)"
					: status === "done" ? "var(--dsw-alias-state-success-primary, #4ac26b)" : "var(--dsw-alias-state-warn-primary, #e2a03f)";
				return react.createElement("section", {
					"data-vssaros-group-activity": "1", "aria-label": "群聊执行状态",
					style: {
						position: "fixed", right: 12, bottom: 132, zIndex: 84, pointerEvents: "auto",
						width: 340, maxWidth: "calc(100vw - 24px)", maxHeight: 260, overflow: "auto",
						display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px",
						borderRadius: 10, border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
						background: "var(--dsw-alias-bg-layer-2, rgba(32,32,32,.96))",
						color: "var(--dsw-alias-label-primary, inherit)",
						boxShadow: "0 18px 46px rgba(0,0,0,.45)", fontSize: 12,
					},
				}, shown.slice(0, 3).map((item) => {
					const speaking = Array.isArray(item.speaking) ? item.speaking : [];
					const replies = (Array.isArray(item.replies) ? item.replies : []).filter((r) => !r || !r.kind);
					const events = Array.isArray(item.events) ? item.events : [];
					const failed = Array.isArray(item.failed) ? item.failed : [];
					const last = replies.length ? replies[replies.length - 1] : null;
					const lastEvent = events.length ? events[events.length - 1] : null;
					const roundStatus = groupRoundStatus(item);
					const status = item.statusLabel || GROUP_ROUND_LABELS[roundStatus];
					const asks = Array.isArray(item.asks) ? item.asks : [];
					return react.createElement("div", {
						key: item.callId || item.roomId, "data-vssaros-group-activity-room": String(item.roomId || ""),
						"data-vssaros-group-activity-asks": String(asks.length),
						"data-vssaros-group-activity-state": item.done ? "done" : "running",
						"data-vssaros-group-activity-round-status": roundStatus,
						style: { display: "flex", flexDirection: "column", gap: 4 },
					},
						react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
							react.createElement("span", { style: { fontWeight: 600, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
								"已发到「" + String(item.roomName || item.roomId || "群聊") + "」"),
							react.createElement("span", { "data-vssaros-group-activity-status": "1", style: { fontSize: 11, color: asks.length || (Array.isArray(item.busy) && item.busy.length) ? statusColor("waiting") : statusColor(roundStatus) } }, status),
							react.createElement("button", {
								type: "button", "data-act": "open-room", style: {
									flex: "none", borderRadius: 6, padding: "2px 7px", cursor: "pointer", fontSize: 11,
									border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
									background: "transparent", color: "inherit",
								}, onClick: () => open(item.roomId),
							}, asks.length ? "去选择" : "打开群聊")),
						react.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" } },
							(speaking.length ? speaking.join("、") + " 正在输入… · " : "") + replies.length + " 条回复 · 用时 " + elapsed(item) + "s"
							+ (failed.length ? " · " + failed.length + " 位成员没能回答" : "")
							+ (lastEvent && lastEvent.text ? " · " + String(lastEvent.text).slice(0, 40) : "")
							+ (item.error ? " · " + String(item.error).slice(0, 80) : "")),
						asks.length ? react.createElement("div", { "data-vssaros-group-activity-ask": "1", style: { fontSize: 11, color: statusColor("waiting") } },
							asks.map((a) => String((a && a.name) || "成员") + " 提了 " + (((a && a.questions) || []).length || 1) + " 个问题").join("；")) : null,
						last ? react.createElement("div", { style: { fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
							String(last.name || "") + "：" + String(last.text || "").slice(0, 80)) : null);
				}));
			}

			function Browser(props) {
				const wide = !props || props.wide !== false;
				// ★ 2026-11-02（诊断）：desktop 窗口里观察到「槽里只有官方 WorkspaceBrowser」——
				//   靠这几个计数/日志就能分清是"没渲染进槽"（tick 恒 0）还是"渲染成 rail 分支"（wide=false）。
				try {
					const tick = (state.workspacesRenderTick || 0) + 1;
					state.workspacesRenderTick = tick;
					state.workspacesWide = wide;
					if (tick <= 3) { wsLog("render", { tick, wide, tickNote: "tick 恒 0 ⇒ 本组件从未被调用（注册没落槽）" }); }
				} catch { /* 诊断失败不影响渲染 */ }
				const { wsSnap, records } = useData();
				const [query, setQuery] = react.useState("");
				const [searchOn, setSearchOn] = react.useState(false);
				const [collapsed, setCollapsed] = react.useState({});
				const [hover, setHover] = react.useState(null); // {key, x, y}
				// ★ 2026-10-26：＋按钮的成败**必须看得见**（窗口模式没有宿主桥 ⇒ notify 是空转）
				const [wsMsg, setWsMsg] = react.useState(null); // {kind:'error'|'note', text}
				// ＋ 菜单（两个动作：加单目录 / 从 .code-workspace 导入多根）；null = 关闭
				const [menu, setMenu] = react.useState(null); // {x, y}
				// ★ 2026-10-28（高亮不同步）：`localCurrent` = 我们刚点的会话（乐观高亮）；
				//   `officialTick` = 官方 selection 变化的计数（**读到新值也得重渲染**，否则高亮不动 ✗）。
				const [localCurrent, setLocalCurrent] = react.useState(null);
				const [officialTick, setOfficialTick] = react.useState(0);
				// ★ 2026-11-02（未读）：集合在模块级（行渲染是模块级函数），变更靠事件通知本组件重画。
				//   ⚠ 只在真正变化时广播（见 setSessionUnread），所以这里不需要节流。
				const [, forceUnread] = react.useState(0);
				react.useEffect(() => {
					if (typeof window === "undefined") { return undefined; }
					const onUnread = () => forceUnread((n) => n + 1);
					window.addEventListener(UNREAD_EVENT, onUnread);
					return () => window.removeEventListener(UNREAD_EVENT, onUnread);
				}, []);
				const hoverTimer = react.useRef(null);
				// ── 会话行 hover 卡片（2026-11-02，对齐官方 `SessionNodeItem` 的 HoverCard）──
				/** `{sid, x, y}`；null = 不显示。与工作区的 `hover` 分开：两者语义/延迟/内容都不同。 */
				const [sessHover, setSessHover] = react.useState(null);
				const sessHoverTimer = react.useRef(null);
				// ── 会话行操作（2026-10-29，用户要求：右键菜单 + 拖拽排序）──
				/** 手动顺序（组键 → id 列表）；localStorage 一读，拖完即写。 */
				const [orderMap, setOrderMap] = react.useState(readOrderMap);
				/** 会话右键菜单：{sid, pinned, x, y}；null = 关闭。 */
				const [sessMenu, setSessMenu] = react.useState(null);
				/**
				 * 工作区行尾 ⋯ 菜单：`{key, x, y}`；null = 关闭。
				 * ★ 2026-11-02（对齐官方 `.projectRow` 的 `rowActions`）：官方工作区行 hover 时右侧出现 ⋯，
				 *   点开是工作区级动作（官方含「删除工作区」danger）。我们这里只做**不破坏数据**的三项
				 *   （折叠/展开、全部折叠、全部展开）—— 删除工作区要走宿主改 IDE 记录，另议。
				 */
				const [wsMenu, setWsMenu] = react.useState(null);
				/** 就地重命名：{sid, draft}；null = 不在重命名。 */
				const [renaming, setRenaming] = react.useState(null);
				/** 会话操作的**就地反馈**（窗口模式没有宿主桥 ⇒ 这是唯一可见通道）。 */
				const [sessMsg, setSessMsg] = react.useState(null); // {kind, text}
				/** 删除确认层：{sid, title}；null = 不在确认。**真删不可恢复** ⇒ 必须二次确认。 */
				const [confirmDel, setConfirmDel] = react.useState(null);
				/** 每组「展开其余」的额外条数：`{ [groupKey]: n }`（默认 0 = 只渲染 SESSION_PAGE_SIZE 条）。 */
				const [extraShown, setExtraShown] = react.useState({});
				/** 正在拖的会话：{sid, groupKey, pinned}。 */
				const [drag, setDrag] = react.useState(null);
				/** 当前落点：{sid, after, ok}（ok=false ⇒ 显示禁止态）。 */
				const [dropAt, setDropAt] = react.useState(null);
				// ── 「会话 / Bots」页签（2026-11-02）──────────────────────────────
				/** 当前页签：'sessions'（工作区，现状）| 'bots'（bot 名册 + 群聊）。 */
				const [view, setViewState] = react.useState(readSidebarView);
				/** Bots 数据：{status:'idle'|'loading'|'ready'|'error', agents, home, groups, error}。 */
				const [bots, setBots] = react.useState({ status: "idle", agents: [], home: {}, groups: [], error: "" });
				/** `vssaros-group-progress` 广播的 `?active=1` 轮次；bot item 据此显示 DS Bot 状态动画。 */
				const [groupActivity, setGroupActivity] = react.useState([]);
				/** Bots 页签里的就地反馈（无宿主桥时这是唯一可见通道） */
				const [botsMsg, setBotsMsg] = react.useState(null); // {kind:'error'|'note', text}
				// ★★ 2026-11-02（用户要求「Bots 页签下增加搜索按钮和 + 按钮，通会话页签的 UI 样式和布局」）：
				//   · `botsSearchOn/botsQuery` —— 与会话页签同一套交互（🔍 切换输入框、就地过滤）；
				//   · `botsMenu` —— ＋ 菜单（fixed 定位，与会话页签的 ＋ 菜单同形态）。
				//   ⚠ 必须声明在 `railOnly` 提前 return **之前**（否则 rail/展开切换会改 hook 数量 ⇒ React #310）。
				const [botsSearchOn, setBotsSearchOn] = react.useState(false);
				const [botsQuery, setBotsQuery] = react.useState("");
				const [botsMenu, setBotsMenu] = react.useState(null); // {x, y}
				// ★ 2026-11-05 群行：右键菜单 `{id, x, y, unread}` / 就地改名 `{id, draft}` / 删除确认 `{id, name}`（同样在 railOnly 之前声明）
				const [roomMenu, setRoomMenu] = react.useState(null);
				const [roomRename, setRoomRename] = react.useState(null);
				const [roomDel, setRoomDel] = react.useState(null);
				/**
				 * 「新建 Bot / 新建群聊」小表单（null = 关闭）。
				 * `{ kind:'bot'|'group', name, id, role, members[], busy, error }`
				 * 为什么不跳去 agents 工作台：`＋` 的原意是"就地新建"，跳页会把用户从侧栏上下文里拽走。
				 */
				const [botsNew, setBotsNew] = react.useState(null);
				/**
				 * **本次会话内**已移除的工作区（IDE 记录 id 集合）。
				 *
				 * ★ 2026-11-02（用户报「显示已移除工作区，但是没刷新」）：
				 *   多根工作区行是**IDE 记录**驱动的（`buildSidebar` 的 group 分支），
				 *   而 `workspaces.delete` 只摘 dsh 登记 ⇒ 行仍在（变成 0 会话），看起来"没生效" ✗。
				 *   这里加一层**本地隐藏**：移除成功后把 record.id 记下来并从列表过滤掉。
				 *   ⚠ 只存在内存（不落 localStorage）⇒ **重载界面即恢复**，不需要额外的"撤销"入口；
				 *     要彻底移除请到 IDE 里删掉该工作区（提示文案里已写明）。
				 */
				// ★ 初始化就从 localStorage 读 —— 重启后仍记得「哪些被移除了」
				const [wsRemoved, setWsRemoved] = react.useState(() => readRemovedWs());
				// 任何变化都落盘（幂等；React 双调也不会写坏）
				react.useEffect(() => { saveRemovedWs(wsRemoved); }, [wsRemoved]);
				const msgTimer = react.useRef(null);
				// 点外面 ⇒ 关菜单（与官方菜单同口径；不关就会"菜单糊在侧栏上"✗）
				// ★ 2026-10-29：工作区 ＋ 菜单与会话右键菜单**共用**这套关闭逻辑（两套并存会互相残留）。
				react.useEffect(() => {
					if (!menu && !sessMenu && !confirmDel && !wsMenu && !botsMenu && !roomMenu && !roomDel) { return undefined; }
					const onDown = (ev) => {
						try {
							const t = ev.target;
							if (t && t.closest && (
								t.closest("[data-vssaros-ws-menu]")
								|| t.closest("[data-vssaros-ws-row-menu]")
								// ★ 2026-11-02：Bots 页签的 ＋ 菜单（与会话页签共用这套"点外面/Esc 关闭"）
								|| t.closest("[data-vssaros-bots-menu]")
								|| t.closest("[data-vssaros-sess-menu]")
								// ★ 2026-11-05：群行右键菜单与删群确认层
								|| t.closest("[data-vssaros-room-menu]")
								|| t.closest("[data-vssaros-room-confirm]")
								// 确认层是**模态**：点它的按钮不该被这里关掉（否则"取消"还没跑就被卸载）
								|| t.closest("[data-vssaros-sess-confirm]")
							)) { return; }
							setMenu(null);
							setSessMenu(null);
							// ★ 2026-11-02：工作区行 ⋯ 菜单（wsMenu）此前**漏关**了 —— 点外面它不会消失，
							//   会和其它菜单一起残留（本次顺手补上）；Bots 的 ＋ 菜单同理。
							setWsMenu(null);
							setBotsMenu(null);
							setRoomMenu(null);
							// 点外面 = 取消（危险操作绝不因为点偏了而执行 ✗）
							setConfirmDel(null);
							setRoomDel(null);
						} catch { setMenu(null); setSessMenu(null); setWsMenu(null); setBotsMenu(null); setConfirmDel(null); setRoomMenu(null); setRoomDel(null); }
					};
					const onKey = (ev) => {
						if (ev.key === "Escape") { setMenu(null); setSessMenu(null); setWsMenu(null); setBotsMenu(null); setConfirmDel(null); setRoomMenu(null); setRoomDel(null); }
					};
					document.addEventListener("mousedown", onDown, true);
					document.addEventListener("keydown", onKey, true);
					return () => {
						document.removeEventListener("mousedown", onDown, true);
						document.removeEventListener("keydown", onKey, true);
					};
				}, [menu, sessMenu, confirmDel, wsMenu, botsMenu, roomMenu, roomDel]);
				// ★ 2026-10-28：订阅官方 selection（当前会话）—— 官方导航一变就重渲染 ⇒ 高亮跟着动 ✓。
				//   官方那个字段是私有的 ⇒ 读不到就退化成"乐观高亮 + 宿主绑定"（不会崩 ✓）。
				react.useEffect(() => {
					let sub = null;
					try {
						const sel = ctx.uiWorkspace && ctx.uiWorkspace.selection;
						if (sel && typeof sel.subscribe === "function") {
							sub = sel.subscribe(() => setOfficialTick((n) => n + 1));
						}
					} catch { /* 官方字段改名了 ⇒ 靠乐观高亮顶着 */ }
					return () => { try { if (typeof sub === "function") { sub(); } } catch { /* 已释放 */ } };
				}, []);

				const sessSnap = readSessSnapshot();
				// ★ 2026-10-28（高亮不同步）：当前会话有三个来源，优先级见 pickCurrentSessionId 的注释。
				//   ① official = 官方 selection（官方自己记的"当前会话"）—— 用户点 item 后它会变 ✓
				//   ② local    = 我们刚点的那条（乐观高亮：官方导航落地前就先动 ✓）
				//   ③ bridged  = 宿主绑定的会话（兜底）
				const bridgedCurrent = bridge && bridge.sessionId ? bridge.sessionId : null;
				const knownIds = {};
				for (const it of (wsSnap && wsSnap.items) || []) {
					if (it && Array.isArray(it.sessionIds)) {
						for (const sid of it.sessionIds) { knownIds[sid] = true; }
					}
				}
				for (const sid of Object.keys((sessSnap && sessSnap.byId) || {})) { knownIds[sid] = true; }
				// ★ 2026-10-30：加上官方口径的 current（`retainedBy.mainView > 0`）—— 空会话的例外条件要用它
				const mainViewId = mainViewSessionId(sessSnap && sessSnap.byId);
				const currentId = pickCurrentSessionId({
					mainView: mainViewId,
					official: readOfficialCurrent(),
					local: localCurrent,
					bridged: bridgedCurrent,
					known: knownIds,
				});
				const rows = react.useMemo(() => {
					const all = buildSidebar({
					workspaces: (wsSnap && wsSnap.items) || [],
					records,
					sessionsById: (sessSnap && sessSnap.byId) || {},
					// ★★ 2026-10-30（用户报「右键菜单里归档不起作用，点了没反应」）：
					//   归档集合的**权威来源是 workspaces 快照**（`workspaces.list.archivedSessionIds`）——
					//   官方 `archiveSession` 只往那里加，而 `sessions.list` 快照**根本没有这个字段**
					//   （官方 `dsh-api-session-controller/lib/client.js` 里 `archivedSessionIds` 0 命中）。
					//   从前只读 sessions 快照 ⇒ 恒空 ⇒ 归档后行仍在列表 ⇒ 看起来"点了没反应" ✗。
					archivedIds: (wsSnap && wsSnap.archivedSessionIds) || (sessSnap && sessSnap.archivedSessionIds) || [],
					currentSessionId: currentId,
					// ★ 2026-10-29：置顶（Host 快照）+ 手动顺序（本地）
					pinnedIds: (wsSnap && wsSnap.pinnedSessionIds) || [],
					orderMap,
					});
					// ★ 本地隐藏刚移除过的工作区行（IDE 记录还在，dsh 登记已摘 ⇒ 否则行会留着但变成 0 会话）
					if (!wsRemoved.length) { return all; }
					return all.filter((r) => !(r && r.kind === "group" && r.record && wsRemoved.indexOf(r.record.id) >= 0));
				}, [wsSnap, records, sessSnap, currentId, officialTick, orderMap, wsRemoved]);

				// 当前会话 cwd 所在根的路径（详情卡绿框 + 会话根标签用）。
				// ★ 2026-10-28（用户报「hover 卡片的"当前会话"根 ≠ 输入框 chip 的工作区」）：
				//   **先认会话自己的 `cwd`**（宿主持有的事实），dsh 条目的 `sessionIds` 只是分组记录
				//   （会话换过目录后仍可能挂在旧条目上 ⇒ 原来只按条目反查，会把"当前会话"标到错的根 ✗）。
				//   与 `client.workspace.js` 的 chip / 下拉（`readCurrentDir` + `currentRootOf`）**同一判据** ✓。
				const currentRow = currentId && sessSnap && sessSnap.byId ? sessSnap.byId[currentId] : null;
				let currentRootPath = currentRow && typeof currentRow.cwd === "string" && currentRow.cwd ? currentRow.cwd : null;
				if (!currentRootPath) {
					// 回落：拿不到 cwd（旧快照 / 会话不在 roster）⇒ 仍按 dsh 条目反查（改动前逐字相同的回落 ✓）
					for (const it of (wsSnap && wsSnap.items) || []) {
						if (it && Array.isArray(it.sessionIds) && currentId && it.sessionIds.indexOf(currentId) >= 0) {
							currentRootPath = it.path || null;
							break;
						}
					}
				}

				const q = query.trim().toLowerCase();
				const matchRow = (row) => !q
					|| (row.kind === "group" ? row.record.name : row.label).toLowerCase().indexOf(q) >= 0
					|| row.sessions.some((s) => s.title.toLowerCase().indexOf(q) >= 0);
				const shown = rows.filter(matchRow);
				const totalRows = rows.reduce((n, r2) => n + 1 + r2.sessions.length, 0);
				const withSearch = totalRows > 8;
				// ★ 被隐藏的空会话总数（所有工作区，含折叠的）—— 诚实披露，不装作没有。
				const hiddenBlanks = rows.reduce((n, r2) => n + (r2.hiddenBlanks || 0), 0);

				// ⚠⚠⚠ 2026-11-02 **真凶修复**：这里原来直接 `if (!wide) return <button/>`，
				//   而本组件**后面还有 hooks**（`react.useState` / `react.useEffect` 一直到 bots 那段）
				//   ⇒ 侧栏在 rail(`wide=false`) 与展开(`wide=true`) 之间切换时，**两次渲染的 hook 数量不同**
				//   ⇒ React 抛 `Minified React error #310`（Rendered more hooks than during the previous render）
				//   ⇒ 官方 slot renderer 打印 `slot entry crashed in 'sidebar.workspaces'`，把我们的条目卸掉
				//   ⇒ **回退去渲染官方 WorkspaceBrowser**。
				//   这正是"IDE 聊天框正常、desktop 全窗时好时坏"的根因：IDE 那侧 `wide` 恒为 true
				//   ⇒ hook 数量稳定 ⇒ 从不崩溃；desktop 侧栏一收起/展开就切换 hook 数量 ⇒ 崩。
				//   ⇒ 现在这里只落一个标记，真正的提前 return 放在**所有 hooks 之后**（见末尾 `railOnly` 分支）。
				const railOnly = !wide;

				const openHover = (key, e) => {
					const rect = e.currentTarget.getBoundingClientRect();
					if (hoverTimer.current) { clearTimeout(hoverTimer.current); }
					hoverTimer.current = setTimeout(() => {
						const w = typeof window !== "undefined" ? window.innerWidth : 0;
						const h = typeof window !== "undefined" ? window.innerHeight : 0;
						let x = rect.right + 10;
						let y = rect.top - 6;
						if (w > 0) { x = Math.max(8, Math.min(x, w - 396)); }
						if (h > 0) { y = Math.max(8, Math.min(y, h - 320)); }
						setHover({ key, x, y });
					}, HOVER_DELAY_MS);
				};
				const closeHover = () => {
					if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
					setHover(null);
				};
				/**
				 * 工作区行尾 ⋯（官方 `.rowActions`）：定位并打开工作区级菜单。
				 * ⚠ 必须 `stopPropagation`：工作区行的 onClick 是**折叠/展开**，不拦就会顺手把组折起来 ✗。
				 */
				const openWsMenu = (key, e, label) => {
					try { e.preventDefault(); e.stopPropagation(); } catch { /* 合成事件 */ }
					closeHover();
					const w = typeof window !== "undefined" ? window.innerWidth : 0;
					const h = typeof window !== "undefined" ? window.innerHeight : 0;
					let x = (e && e.clientX ? e.clientX : 16) + 2;
					let y = (e && e.clientY ? e.clientY : 16) + 2;
					if (w > 0) { x = Math.max(8, Math.min(x, w - 236)); }
					if (h > 0) { y = Math.max(8, Math.min(y, h - 150)); }
					// `label` 只用于菜单标题显示（`key` 是折叠键，可能是 IDE 记录 id，直接显示很丑）
					setWsMenu({ key, label: String(label || ""), x, y });
				};
				/**
				 * 移除一个工作区（2026-11-02 用户要求：⋯ 菜单里要有「移除工作区」）。
				 *
				 * 走官方 `workspaces.delete(workspaceId)` —— 注释原文
				 *   "Remove one Workspace registration while retaining files and Sessions."
				 * ⇒ **只摘登记**，会话与磁盘文件都保留（可随时再加回来）✓ 安全可逆。
				 *
				 * ⚠ 与「删会话」不同：这里**不碰任何文件**，所以不需要删盘那套兜底。
				 * ⚠ 多根工作区的 `key` 是 `rec:<IDE 记录 id>`，要先用 `workspaceIdOf` 反查 dsh 的
				 *   workspaceId；flat 行直接用自带的 `row.workspaceId`。
				 */
				const removeWorkspace = (key) => {
					// ⚠⚠ 这里收到的 `key` 是**折叠键**（渲染时 `const key = row.record.id` /
					//   `"flat:" + row.label`），而 `rows[].key` 是**分组键**（`rec:<id>` / `ws:<wsId>`）
					//   ⇒ 两者永不相同。真机报「找不到这个工作区（列表可能已刷新）」就是这个原因 ✗。
					//   ⇒ 按 kind 分别用对应字段匹配（不要留"看起来通用"的相等判断）。
					const row = rows.filter((r) => r && r.kind === "group" && r.record && r.record.id === key)[0]
						|| rows.filter((r) => r && r.kind === "flat" && key === ("flat:" + r.label))[0];
					if (!row) { say("找不到这个工作区（列表可能已刷新）", "error"); return; }
					const wsId = row.kind === "flat" ? String(row.workspaceId || "") : workspaceIdOf(row.record);
					const name = row.kind === "flat" ? row.label : (row.record && row.record.name) || key;
					if (!wsId) {
						// dsh 侧本来就没登记（比如之前已摘过），但 **IDE 记录还在** ⇒ 用户想要的
						// 其实是"让这行消失" ⇒ 直接从列表隐藏（重载可恢复）。
						if (row.kind === "group" && row.record && row.record.id) {
							const rid = row.record.id;
							setWsRemoved((prev) => (prev.indexOf(rid) >= 0 ? prev : prev.concat([rid])));
							say("已隐藏「" + name + "」", "note");
						} else {
							say("「" + name + "」还没在 dsh 侧登记过，无需移除", "note");
						}
						return;
					}
					let svc = null;
					try { svc = typeof ctx.get === "function" ? ctx.get("workspaces") : null; } catch { svc = null; }
					if (!svc || typeof svc.delete !== "function") {
						say("当前宿主不支持移除工作区（workspaces.delete 不可用）", "error");
						return;
					}
					// ★★ 2026-11-02 二次（用户报「点了没有立即清除，延迟一段时间才刷新 UI」）：
					//   原来是**等 `svc.delete()` 返回后**才隐藏 ⇒ 延迟 = 一次宿主往返 ✗。
					//   改成**乐观隐藏**：点下去立刻从列表消失，删除失败再回滚（并报错）。
					const rid = (row.kind === "group" && row.record && row.record.id) ? row.record.id : "";
					if (rid) {
						setWsRemoved((prev) => (prev.indexOf(rid) >= 0 ? prev : prev.concat([rid])));
					}
					say("正在移除工作区「" + name + "」…", "note");
					void Promise.resolve(svc.delete(wsId)).then(
						() => {
							try { wsLog("workspace-removed", { wsId, name }); } catch { /* 诊断 */ }
							say("已移除「" + name + "」（会话与文件保留）", "note");
						},
						(e) => {
							// 回滚：删除失败 ⇒ 把行放回来，别让用户以为"删掉了"
							if (rid) { setWsRemoved((prev) => prev.filter((x) => x !== rid)); }
							say("移除工作区失败：" + errText(e), "error");
						},
					);
				};
				/** 所有分组键（折叠/展开"全部"用）。 */
				const allGroupKeys = () => {
					const out = [];
					for (const r of rows) {
						out.push(r.kind === "group" ? r.record.id : ("flat:" + r.label));
					}
					return out;
				};
				/**
				 * 会话行 hover 卡片（**官方同款**：`openDelayMs=800`、`disabled = menuOpen || drag`）。
				 *
				 * 位置贴行**右侧**（侧栏里行很窄，贴右更不容易盖住标题）；夹进视口避免被
				 * WebContentsView 边缘裁掉（与工作区卡片同一条教训）。
				 * ⚠ 不进 `onMouseEnter` 立刻 setState：划过几十行不该弹几十张卡。
				 */
				const openSessHover = (s, e) => {
					if (sessMenu || drag) { return; }   // 官方 `disabled={menuOpen || drag.active}`
					let rect = null;
					try { rect = e.currentTarget.getBoundingClientRect(); } catch { rect = null; }
					if (sessHoverTimer.current) { clearTimeout(sessHoverTimer.current); }
					sessHoverTimer.current = setTimeout(() => {
						const w = typeof window !== "undefined" ? window.innerWidth : 0;
						const h = typeof window !== "undefined" ? window.innerHeight : 0;
						let x = rect ? rect.right + 8 : 16;
						let y = rect ? rect.top - 4 : 16;
						if (w > 0) { x = Math.max(8, Math.min(x, w - 328)); }
						if (h > 0) { y = Math.max(8, Math.min(y, h - 220)); }
						setSessHover({ sid: s.id, x, y });
					}, SESS_HOVER_DELAY_MS);
				};
				const closeSessHover = () => {
					if (sessHoverTimer.current) { clearTimeout(sessHoverTimer.current); sessHoverTimer.current = null; }
					setSessHover(null);
				};
				/**
				 * 一键诊断文本（2026-11-02 用户要求「增加日志定位问题」）。
				 *
				 * 用户报「页签 / 工作区行不见了」时，只需 `⋯ → 复制诊断信息`，发过来就能定位：
				 *   · `replaced/error` —— install 跑没跑、有没有抛；
				 *   · `slotInfo/slotCheck/firstClass` —— 注册有没有落到槽、槽里现在是谁；
				 *   · `renderTick/wide/rail` —— 组件被调用过几次、是不是一直 rail；
				 *   · `log` —— install → register → render → 槽自检 的时间线。
				 */
				const diagText = () => {
					try {
						const slot = document.querySelector('[data-slot="sidebar.workspaces"]');
						const first = slot && slot.firstElementChild ? String(slot.firstElementChild.className || "") : "";
						return JSON.stringify({
							build: String((typeof window !== "undefined" && window.__vssarosChatSurfaceBuild) || "").slice(-140),
							url: typeof location !== "undefined" ? String(location.href).slice(0, 140) : "",
							chatOnly: (() => { try { return !!(typeof window !== "undefined" && window.vssarosDsh && window.vssarosDsh.chatOnly); } catch { return "?"; } })(),
							replaced: state.workspacesReplaced === true,
							error: state.workspacesError || null,
							slotInfo: state.workspacesSlotInfo || null,
							slotCheck: state.workspacesSlotCheck || null,
							slotsApi: state.workspacesSlotsApi || null,
							slotsEntries: state.workspacesSlotEntries || null,
							slotsDump: state.workspacesSlotsDump || null,
							renderTick: state.workspacesRenderTick === undefined ? null : state.workspacesRenderTick,
							wide: state.workspacesWide === undefined ? null : state.workspacesWide,
							rail: state.workspacesRailLog || 0,
							ourRows: document.querySelectorAll(".vssaros-ws-project").length,
							ourTitles: document.querySelectorAll(".vssaros-ws-title").length,
							tabBar: !!document.querySelector("[data-vssaros-sidebar-tabs]"),
							firstClass: first.slice(0, 100),
							log: (state.workspacesLog || []).slice(-24),
						}, null, 1);
					} catch (e) {
						return "诊断失败：" + String((e && e.message) || e);
					}
				};
				/**
				 * **把「未命名」补成可读标题**（2026-11-02 用户拍板「治本：把标题写回 dsh」）。
				 *
				 * 为什么能做：dsh 的标题只来自 `session/title` 事件（`rename`），而它**没有**任何自动标题
				 *   能力（`autoTitle`/`generateTitle` 全仓 0 命中，文案就是「未命名」）。会话日志里
				 *   `user/message` 事件带着真人输入（`source.kind === 'user'`）⇒ 取首条即可当标题。
				 *
				 * 链路（**只读 host + 官方写**，权限与一致性都交回官方）：
				 *   `GET /x/chat-surface/api/first-prompt?sessionId=…` → 拿到首条用户文本
				 *   → `renameSession()`（内部 `sessions.using(...).rename()` ⇒ 写 `session/title` 事件）
				 *   ⇒ 侧栏、**官方会话头**、搜索结果全都跟着有标题 ✓
				 *
				 * 口径：串行 + 每条间隔 60ms（不把 host 打满）；只处理**非 blank、非子代理、标题仍是「未命名」**
				 *   的会话；失败不中断（计数后继续）；全程就地报进度。
				 */
				const backfillTitles = () => {
					const ids = [];
					for (const r of rows) {
						for (const s of r.sessions || []) {
							if (!s || s.blank || s.isSubagent) { continue; }
							if (s.title !== "未命名") { continue; }
							if (ids.indexOf(s.id) < 0) { ids.push(s.id); }
						}
					}
					if (!ids.length) {
						say("没有需要补标题的会话（都已有标题，或都是空会话）", "note");
						return;
					}
					say("开始补标题：共 " + ids.length + " 条（读首条用户消息 → 写回 dsh）…", "note");
					let done = 0;
					let ok = 0;
					let fail = 0;
					// renameSession 成功时会 `say(null)` 清提示 ⇒ 传一个静默 say，进度由本函数自己报
					const quiet = () => undefined;
					const step = (i) => {
						if (i >= ids.length) {
							say("补标题完成：成功 " + ok + " 条" + (fail ? "，跳过/失败 " + fail + " 条" : "") + "（已写回 dsh，官方侧栏也会显示）", "note");
							return;
						}
						const sid = ids[i];
						let p;
						try {
							p = Promise.resolve(fetch(FIRST_PROMPT_API + "?sessionId=" + encodeURIComponent(sid), { headers: { accept: "application/json" } }))
								.then((r) => (r && r.ok ? r.json() : Promise.reject(new Error("HTTP " + (r && r.status)))));
						} catch (e) { p = Promise.reject(e); }
						void p.then(
							(d) => {
								const title = d && d.ok && d.found && typeof d.title === "string" ? d.title.trim() : "";
								if (!title) { fail++; } else { ok++; renameSession(sid, title, quiet, () => undefined); }
								done++;
								if (done % 3 === 0 || done === ids.length) { say("补标题 " + done + "/" + ids.length + "（成功 " + ok + "）…", "note"); }
								try { window.setTimeout(() => step(i + 1), 60); } catch { step(i + 1); }
							},
							() => {
								fail++;
								done++;
								try { window.setTimeout(() => step(i + 1), 60); } catch { step(i + 1); }
							},
						);
					};
					step(0);
				};
				/** 复制任意文本（hover 卡片的「复制标题」；clipboard 不可用时回落 execCommand）。 */
				const copyPlain = (text, say, okLabel) => {
					const val = String(text || "");
					if (!val) { return; }
					const ok = () => say(okLabel || ("已复制：" + val), "note");
					try {
						const nav = typeof navigator !== "undefined" ? navigator : null;
						if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
							void Promise.resolve(nav.clipboard.writeText(val)).then(ok, () => { legacyCopy(val) ? ok() : say("复制失败（宿主拒绝了剪贴板写入）", "error"); });
							return;
						}
					} catch { /* 落到降级 */ }
					legacyCopy(val) ? ok() : say("复制失败（宿主拒绝了剪贴板写入）", "error");
				};

				// ── 会话行操作（2026-10-29）──────────────────────────────────────────
				/** 就地反馈：6 秒后自动消失（常驻会让人以为状态还在）。 */
				const say = (text, kind) => {
					if (!text) { setSessMsg(null); return; }
					setSessMsg({ kind: kind === "error" ? "error" : "note", text: String(text) });
					if (msgTimer.current) { clearTimeout(msgTimer.current); }
					msgTimer.current = setTimeout(() => setSessMsg(null), 6000);
				};
				/**
				 * 在指定工作区根目录下**新建一个会话**（2026-11-02 用户要求：工作区行 hover 要有 `+`）。
				 *
				 * 走官方能力 `ctx.sessions.create({ cwd })`（与 `client.js` 登记会话那条同一 API），
				 * 宿主会按 cwd 归属到对应工作区；拿到返回的 `sessionId` 后立刻 `openSession` 打开。
				 *
				 * ⚠ 不传 `sessionId`（让宿主铸新的），也不先 `openWorkspace()` —— 后者会额外造一条空会话
				 *   （`client.js` 里对齐工作区那段注释踩过：一次点击留下一条空会话 ✗）。
				 * ⚠ 没有 cwd（极少数没有根路径的条目）⇒ 明确拒绝，不造一条"没有工作区"的会话
				 *   （那种会话在 hero 里输入框是灰的）。
				 */
				const newSessionInWorkspace = (record, label) => {
					const dir = primaryPathOf(record);
					const wsId = workspaceIdOf(record);
					markUserNavGlobal();
					// 点下去就开始盯焦点（不依赖任何 promise —— 真机上 `.then` 里的 focus 会被重渲染抢走）
					watchComposerFocus(24);
					// ★★ 2026-11-02 修（用户报「点 + 后聊天框无法交互」）：**必须走官方的
					//   `uiWorkspace.openWorkspaceSession(workspaceId)`**，而不是自己
					//   `sessions.create({ cwd })` + `openSession`。
					//
					//   官方实现（`dsh-client-ui-workspace/lib/client.js:1476`）：
					//     openWorkspaceSession(workspaceId) → connectBlank(workspaceId)   // sessions.create({ workspaceId })
					//                                      → replaceMain(sessionId, …, "reveal")
					//   两点差别是致命的：
					//     ① `create({ workspaceId })` 会把会话**挂进工作区的 sessionIds**；
					//        我们传 `cwd` 只定目录，**不建立归属** ⇒ hero 认为"没有工作区"
					//        ⇒ 输入框灰着、写着「描述你想要构建的内容…」无法输入 ✗（真机复现）；
					//     ② `connectBlank` 还会复用已有的 blank 会话，不会每次点 + 都新增一条空会话
					//        （真机「已隐藏 N 条空会话」的 N 一直在涨就是这个原因）。
					//
					//   ⇒ 官方路径优先；拿不到 workspaceId 或宿主没这个 API 时才回落到 `create({ cwd })`。
					try {
						const uw = ctx.uiWorkspace;
						const hasApi = !!(uw && typeof uw.openWorkspaceSession === "function");
						// ⚠ 有官方入口但取不到 workspaceId ⇒ **先把它登记进 dsh**，再开会话。
						//
						//   真机（`VsSaros_S1Game`，2 个根、两边都是 0 会话）：dsh 的 `workspaces.list` 里
						//   压根没有这个工作区的条目 —— 它是 **IDE 侧**的工作区，dsh 没打开过 ⇒ 没有 workspaceId。
						//   这时只有两条路：
						//     ① 回落到 `sessions.create({cwd})` ⇒ 有目录但**不在账本里** ⇒ 输入框灰 ✗（已踩）；
						//     ② **先登记**（`workspaces.create({ path })`，官方"添加工作区"同一条链），
						//        拿到 workspaceId 再 `openWorkspaceSession` ⇒ 会话有归属、输入框可用 ✓。
						//   选 ②：用户点「+ 新建会话」的意图本来就包含"让我能在这个工作区里说话"。
						if (hasApi && !wsId) {
							const wsSvc = (typeof ctx.get === "function") ? ctx.get("workspaces") : null;
							if (!wsSvc || typeof wsSvc.create !== "function") {
								say("这个工作区还没在 dsh 侧登记，且宿主不支持登记（workspaces.create 不可用）", "error");
								return;
							}
							if (!dir) {
								say("这个工作区没有可用的根路径，无法登记", "error");
								return;
							}
							say("正在把「" + (label || dir) + "」登记到 dsh…", "note");
							void Promise.resolve(wsSvc.create({ path: dir })).then((created) => {
								const newId = created && (created.workspaceId
									|| (created.workspace && created.workspace.workspaceId));
								if (!newId) { throw new Error("登记工作区后仍拿不到 workspaceId"); }
								try { wsLog("workspace-registered", { newId: String(newId), dir }); } catch { /* 诊断 */ }
								return Promise.resolve(uw.openWorkspaceSession(String(newId))).then(() => {
									try { wsLog("new-session-ok", { wsId: String(newId), via: "register-then-open" }); } catch { /* 诊断 */ }
								});
							}).then(
								() => { say(null); focusComposer(); watchComposerFocus(16); },
								(e) => {
									try { wsLog("new-session-fail", { dir, message: String((e && e.message) || e) }); } catch { /* 诊断 */ }
									say("新建会话失败：" + errText(e), "error");
								},
							);
							return;
						}
						if (wsId && hasApi) {
							say("正在「" + (label || wsId) + "」下新建会话…", "note");
							try { wsLog("new-session", { via: "uiWorkspace.openWorkspaceSession", wsId, dir }); } catch { /* 诊断 */ }
							void Promise.resolve(uw.openWorkspaceSession(wsId)).then(
								() => {
									say(null);
									try { wsLog("new-session-ok", { wsId }); } catch { /* 诊断 */ }
									focusComposer();
									watchComposerFocus(16);
								},
								(e) => {
									try { wsLog("new-session-fail", { wsId, message: String((e && e.message) || e) }); } catch { /* 诊断 */ }
									say("新建会话失败：" + errText(e), "error");
								},
							);
							return;
						}
					} catch (e) {
						say("新建会话失败：" + errText(e), "error");
						return;
					}
					// ── 回落：没有 workspaceId（平铺条目）或宿主没有官方入口 ──
					if (!dir) { say("这个工作区没有根路径，无法新建会话", "error"); return; }
					let svc = null;
					try { svc = typeof ctx.get === "function" ? ctx.get("sessions") : null; } catch { svc = null; }
					if (!svc || typeof svc.create !== "function") {
						say("当前宿主不支持新建会话（sessions.create 不可用）", "error");
						return;
					}
					say("正在「" + (label || dir) + "」下新建会话…", "note");
					try { wsLog("new-session", { via: "sessions.create({cwd}) + openSession（回落）", wsId, dir }); } catch { /* 诊断 */ }
					let p;
					try { p = Promise.resolve(svc.create({ cwd: dir })); } catch (e) {
						say("新建会话失败：" + errText(e), "error");
						return;
					}
					void p.then((res) => {
						// ★★ 2026-11-02 修（用户报「宿主没返回 sessionId」）：`sessions.create` 有**两层实现**，
						//   返回形态不同 ——
						//     · `ClientSessions.create`（`dsh-api-session-controller/lib/client.js:3321`）
						//       返回 `{ ok, value: { sessionId } }`；
						//     · `SessionsManager.create`（同文件 `:3972`）
						//       **直接返回 sessionId 字符串**（失败则抛错）。
						//   `ctx.get("sessions")` 在不同宿主版本/装配下可能给到任一个 ⇒ 只认对象就会把
						//   "字符串 sessionId" 当成"没返回"（真机就是这么失败的 ✗）。这里两种都接。
						const got = (() => {
							if (typeof res === "string") { return res; }
							if (!res || typeof res !== "object") { return undefined; }
							if (typeof res.sessionId === "string" && res.sessionId) { return res.sessionId; }
							const v = res.value;
							if (typeof v === "string" && v) { return v; }
							if (v && typeof v === "object" && typeof v.sessionId === "string" && v.sessionId) { return v.sessionId; }
							if (res.session && typeof res.session.sessionId === "string" && res.session.sessionId) { return res.session.sessionId; }
							return undefined;
						})();
						if (!got) {
							// 把**实际形状**带出来：下次一眼看出宿主给的是什么（而不是只有一句"没返回"✗）
							let shape = "";
							try { shape = "（宿主返回：" + String(JSON.stringify(res)).slice(0, 140) + "）"; } catch { shape = ""; }
							throw new Error("宿主没返回 sessionId" + shape);
						}
						say(null);
						try { markSessionRead(String(got)); } catch { /* 本地未读表，失败不影响打开 */ }
						openSession(String(got), say, (sid) => setLocalCurrent(sid));
						// 打开是异步的（官方导航要几百毫秒）⇒ focus 自己会重试到 composer 出现
						focusComposer();
					}).catch((e) => say("新建会话失败：" + errText(e), "error"));
				};
				/** 取一个工作区条目的"主根路径"（新建会话用）：优先 roots[0].path，其次 record.path。 */
				const primaryPathOf = (rec) => {
					try {
						const roots = (rec && Array.isArray(rec.roots)) ? rec.roots : [];
						const primary = roots.filter((r) => r && r.isPrimary)[0] || roots[0] || null;
						const p1 = primary && (primary.path || primary.rootPath || primary.fsPath);
						if (typeof p1 === "string" && p1.trim()) { return p1.trim(); }
						const p2 = rec && (rec.path || rec.cwd);
						if (typeof p2 === "string" && p2.trim()) { return p2.trim(); }
					} catch { /* 结构不认识就返回空 */ }
					return "";
				};
				/**
				 * 把焦点交给 composer（2026-11-02 用户报「点 + 后聊天框无法交互」）。
				 *
				 * 真机实测（CDP focus + `Input.insertText`）：新建出来的会话**输入框是可用的**
				 * （`pointerEvents:auto` / `opacity:1` / 无 disabled 祖先，能聚焦、能打进去），
				 * 但 `openWorkspaceSession` 的 `replaceMain` **不会**自动把焦点放进 composer ⇒
				 * 用户点完 `+` 直接打字时按键落在页面空白处，看起来就是"聊天框不能交互" ✗。
				 * ⇒ 新建成功后主动 focus，并**重试几次**（composer 是异步挂载的）。
				 */
				const focusComposer = (tries) => {
					const n = typeof tries === "number" ? tries : 0;
					let ok = false;
					try {
						const el = document.querySelector('[contenteditable="true"]');
						if (el && typeof el.focus === "function") {
							el.focus();
							ok = document.activeElement === el;
						}
					} catch { ok = false; }
					if (ok) { try { wsLog("focus-composer", { tries: n, ok: true }); } catch { /* 诊断 */ } return; }
					// ⚠ 必须**持续校验**：真机第一版"找到元素就 focus 一次然后 return"被后续
					//   `replaceMain` 的重渲染把焦点抢回 body（`activeTag: BODY`）⇒ 等于没做 ✗。
					if (n < 12 && typeof window !== "undefined") {
						window.setTimeout(() => focusComposer(n + 1), 200);
					} else {
						try { wsLog("focus-composer", { tries: n, ok: false }); } catch { /* 诊断 */ }
					}
				};
				/**
				 * **焦点守护**（2026-11-02 真机：点 `+` 后 composer 是可用的，但焦点停在 `BODY`）。
				 *
				 * 为什么不靠 `openWorkspaceSession().then(...)`：那个 promise 内部还要 `replaceMain`，
				 * 真机上 `.then` 里的 focus 会被随后的重渲染抢走（实测 `activeElement` 仍是 BODY ✗）。
				 * ⇒ 点下去就开一个**短时守护**（6 秒 / 每 250ms），只在
				 *   「composer 存在 && 当前焦点是 body」时才抢 —— 用户主动点了别处就立刻让位。
				 */
				const watchComposerFocus = (left) => {
					const n = typeof left === "number" ? left : 0;
					try {
						const el = document.querySelector('[contenteditable="true"]');
						const active = typeof document !== "undefined" ? document.activeElement : null;
						if (el && (active === null || active === document.body) && typeof el.focus === "function") {
							el.focus();
							try { wsLog("focus-composer", { left: n, ok: document.activeElement === el }); } catch { /* 诊断 */ }
						}
					} catch { /* 焦点失败不影响会话本身 */ }
					if (n > 0 && typeof window !== "undefined") {
						window.setTimeout(() => watchComposerFocus(n - 1), 250);
					}
				};
				/**
				 * 取一条工作区条目的 **workspaceId**（官方 `openWorkspaceSession` 的入参就是它）。
				 * dsh 的 `workspaces.list` 条目字段是 `workspaceId`；我们 `buildSidebar` 归一成 `id`
				 * ⇒ 两个都认，取不到就返回空串（调用方会回落到 cwd 那条路径）。
				 */
				const workspaceIdOf = (rec) => {
					try {
						// ① flat 行（`buildSidebar` 的回落分支）自带 `workspaceId`
						if (rec && typeof rec.workspaceId === "string" && rec.workspaceId) { return rec.workspaceId.trim(); }
						// ② ⚠⚠ 多根工作区行（group）的 `record` 是 **IDE 记录**，`rec.id` 形如
						//   `sarosis-agents-client-hcshv` —— 那**不是** dsh 的 workspaceId！
						//   真机报错：`uiWorkspace.connectWorkspace: unknown workspace sarosis-agents-client-hcshv`
						//   （`connectBlank` 是按 `workspaceId` 精确匹配的，查不到直接抛 ✗）。
						//   ⇒ 必须回到 `workspaces.list` 的 items 里，按**主根路径**反查真正的 workspaceId。
						const items = (wsSnap && Array.isArray(wsSnap.items)) ? wsSnap.items : [];
						const roots = (rec && Array.isArray(rec.roots)) ? rec.roots : [];
						// ⚠⚠ 必须是**遍历所有根**，不能只认 `isPrimary`：
						//   真机（5 个根的工作区 `sarosis-agents-client`）里主根并不在 dsh 的 items 里
						//   ⇒ 只查主根就一直返回空 ⇒ 报「还没在 dsh 侧登记」✗。
						//   而 `buildSidebar` 认领 members 用的是 `roots.some(r => samePath(r.path, it.path))`
						//   （**任意一个根**匹配即可）⇒ 这里与它同口径才能拿到同一批条目 ✓。
						const pathOfRoot = (r) => {
							if (!r) { return ""; }
							const v = r.path || r.rootPath || r.fsPath;
							return typeof v === "string" ? v : "";
						};
						// 主根优先（同一工作区多个根都有条目时，优先主根那条）
						const ordered = roots.filter((r) => r && r.isPrimary).concat(roots.filter((r) => !r || !r.isPrimary));
						for (const r of ordered) {
							const p = pathOfRoot(r);
							if (!p) { continue; }
							const hit = items.filter((it) => it && it.workspaceId && samePath(it.path, p))[0];
							if (hit) { return String(hit.workspaceId); }
						}
						// ③ 最后兜底：`rec.id` 若恰好等于某个 item 的 workspaceId（单根场景偶尔成立）
						const byId = items.filter((it) => it && it.workspaceId === rec.id)[0];
						if (byId) { return String(byId.workspaceId); }
						// ④ 都没匹配上 ⇒ 记一条诊断（两边路径都打出来，下次不用再猜为什么对不上）
						try {
							wsLog("workspace-id-miss", {
								recId: String((rec && rec.id) || ""),
								roots: roots.map(pathOfRoot).filter(Boolean).slice(0, 6),
								items: items.map((it) => it && it.path).filter(Boolean).slice(0, 6),
							});
						} catch { /* 诊断 */ }
						return "";
					} catch { return ""; }
				};
				/** 按 sid 找渲染模型（菜单标题 / 置顶态都要它）。 */
				const findSession = (sid) => {
					for (const r2 of rows) {
						for (const s of r2.sessions) { if (s.id === sid) { return s; } }
					}
					return null;
				};
				/** 右键：fixed 定位并**夹进视口**（侧栏 overflow 会裁掉 absolute 弹层 ✗）。 */
				const openSessMenu = (s, e) => {
					try { e.preventDefault(); e.stopPropagation(); } catch { /* 合成事件 */ }
					// 官方 `HoverCard disabled={menuOpen}`：菜单一开就收起 hover 卡（两张浮层叠着很脏 ✗）
					closeSessHover();
					setRenaming(null);
					const w = typeof window !== "undefined" ? window.innerWidth : 0;
					const h = typeof window !== "undefined" ? window.innerHeight : 0;
					let x = e.clientX || 0;
					let y = e.clientY || 0;
					if (w > 0) { x = Math.max(8, Math.min(x, w - 232)); }
					// 2026-11-02：多了「标为未读」「分叉」两项 ⇒ 视口裁剪的预留高度跟着放大
					if (h > 0) { y = Math.max(8, Math.min(y, h - 268)); }
					setSessMenu({ sid: s.id, pinned: s.pinned === true, unread: unreadIds.indexOf(s.id) >= 0, x, y });
				};
				const startRename = (s) => { setSessMenu(null); setRenaming({ sid: s.id, draft: s.title }); };
				const commitRename = () => {
					if (!renaming) { return; }
					renameSession(renaming.sid, renaming.draft, say, () => setRenaming(null));
				};
				const menuAction = (act) => {
					const cur = sessMenu;
					const s = cur ? findSession(cur.sid) : null;
					setSessMenu(null);
					if (!cur) { return; }
					if (act === "pin") { setPinned(cur.sid, !cur.pinned, say); return; }
					if (act === "rename") { if (s) { startRename(s); } else { setRenaming({ sid: cur.sid, draft: cur.sid }); } return; }
					if (act === "copy") { copySessionId(cur.sid, say); return; }
					// ★ 2026-11-02（用户要求「补未读」）：纯本地标记，切换后立刻重画（事件驱动）。
					if (act === "unread") {
						setSessionUnread(cur.sid, !cur.unread);
						say(!cur.unread ? "已标为未读（下次打开这条会话自动清除）" : "已标为已读", "note");
						return;
					}
					// ★ 2026-11-02（用户要求「降维护成本」）：补上官方 `ForkSessionMenuItem` 那项，
					//   减少"官方有、我们没"的差异；能力缺失就如实说，不静默。
					if (act === "fork") {
						try {
							const uw = ctx.uiWorkspace;
							if (!uw || typeof uw.forkSession !== "function") {
								say("当前宿主不支持分叉（uiWorkspace.forkSession 不可用）", "error");
								return;
							}
							void Promise.resolve(uw.forkSession(cur.sid)).then(
								() => { say("已分叉出一条新会话", "note"); },
								(e) => { say("分叉失败：" + errText(e), "error"); },
							);
						} catch (e) { say("分叉失败：" + errText(e), "error"); }
						return;
					}
					if (act === "archive") { archiveSession(cur.sid, say); return; }
					if (act === "delete") {
						// ⚠ 当前会话不许删：删掉之后页面会指着一条不存在的会话（要删先切走）
						if (cur.sid === currentId) {
							say("这是当前打开的会话，先切到别的会话再删除", "error");
							return;
						}
						setConfirmDel({ sid: cur.sid, title: (s && s.title) || cur.sid });
					}
				};
				// —— 拖拽（组内；置顶区与普通区互不跨越）——
				const onDragStartOf = (s) => (e) => {
					setSessMenu(null);
					// 官方 `HoverCard disabled={drag.active}`：拖起来就收起（否则卡片跟着鼠标飘 ✗）
					closeSessHover();
					setDrag({ sid: s.id, groupKey: s.groupKey, pinned: s.pinned === true });
					try { e.dataTransfer.setData("text/plain", s.id); e.dataTransfer.effectAllowed = "move"; } catch { /* 某些环境没有 dataTransfer */ }
				};
				const onDragOverOf = (s) => (e) => {
					if (!drag) { return; }
					e.preventDefault();
					const ok = canDrop(drag, { sid: s.id, groupKey: s.groupKey, pinned: s.pinned === true });
					if (!ok) {
						try { e.dataTransfer.dropEffect = "none"; } catch { /* 忽略 */ }
						if (!dropAt || dropAt.sid !== s.id || dropAt.ok !== false) { setDropAt({ sid: s.id, after: false, ok: false }); }
						return;
					}
					let after = false;
					try {
						const box = e.currentTarget.getBoundingClientRect();
						after = (e.clientY - box.top) > box.height / 2;
					} catch { after = false; }
					try { e.dataTransfer.dropEffect = "move"; } catch { /* 忽略 */ }
					// ⚠ dragover 每秒几十次：值没变就不 setState（否则整列每帧重渲染 ⇒ 卡顿）
					if (!dropAt || dropAt.sid !== s.id || dropAt.after !== after || dropAt.ok !== true) {
						setDropAt({ sid: s.id, after, ok: true });
					}
				};
				const onDropOf = (s) => (e) => {
					e.preventDefault();
					const src = drag;
					const at = dropAt;
					setDrag(null);
					setDropAt(null);
					if (!src || !at || !at.ok) { return; }
					// dragover 里判过一次，这里再判（React 状态可能滞后一帧）
					if (!canDrop(src, { sid: s.id, groupKey: s.groupKey, pinned: s.pinned === true })) { return; }
					const row = rows.filter((r2) => r2.key === src.groupKey)[0];
					if (!row) { return; }
					const nextIds = moveWithin(row.sessions, src.sid, s.id, at.after);
					if (!nextIds) { return; }
					persistOrderMap(Object.assign({}, orderMap, { [src.groupKey]: nextIds }), setOrderMap);
				};
				/**
				 * 一行会话（组内 / 平铺共用 —— 两处渲染必须同一个实现，否则口径会漂）。
				 * 元素形态：状态灯 → 标题（或就地输入框）→ 根标签（仅非主根）→ 图钉（仅置顶）→ 时间。
				 * ⚠ 图钉在**行尾**（2026-10-30）：行首放它会白占 12px + gap 7，标题被推右 19px。
				 */
				/**
				 * 工作区行的两个图标 —— **逐字抄官方** `@deepseek-ai/dsh-client-ui-primitives`：
				 *   · `FolderCloseArtwork`：`viewBox 0 0 16 16`、`fill:none` + **1px stroke** + 中间一条横线；
				 *   · `IconTriangleRightFillArtwork`：实心三角，展开时整体 `rotate(90deg)`。
				 *
				 * ⚠⚠ 别再用"手画 path + fill"（2026-11-02 用户截图：文件夹渲染成一个**空心方块** ✗）：
				 *   官方 folder 是**描边**图形，用 fill 画会变成一团实心色块/糊成方块。
				 */
				const folderIcon = () => react.createElement("svg", {
					width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
					stroke: "currentColor", strokeWidth: 1, "aria-hidden": "true",
				},
					react.createElement("path", { d: "M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" }),
					react.createElement("path", { d: "M3.63501 7.66614H12.3647" }));
				/**
				 * 工作区行 hover 时的「+」（在此工作区新建会话）。
				 * 用 **stroke 描边**的加号（与 folder 图标同一视觉语言），不要 emoji/text "+"
				 * —— 文字加号在 14px 下基线会歪、和 ⋯ 也不成对。
				 */
				const plusIcon = () => react.createElement("svg", {
					width: 14, height: 14, viewBox: "0 0 16 16", fill: "none",
					stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round",
					"aria-hidden": "true", style: { display: "block" },
				},
				react.createElement("path", { d: "M8 3.2v9.6M3.2 8h9.6" }));

				const chevronIcon = (open) => react.createElement("svg", {
					width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
					style: { transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" },
				}, react.createElement("path", {
					fill: "currentColor",
					d: "M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z",
				}));

				const renderSessionRow = (s, setMsg, setLocal) => {
					const isRenaming = !!(renaming && renaming.sid === s.id);
					const isDragging = !!(drag && drag.sid === s.id);
					const mark = dropAt && dropAt.sid === s.id ? dropAt : null;
					// ★★ 2026-11-02（用户要求「复刻 dsh 官方原生的 item UI」）：
					//   尺寸 / 间距 / 悬停规则**全部交给** `ensureRowStyle()` 注入的 `.vssaros-ws-row`
					//   （数值逐条抄官方 `Rows.module.css`）⇒ 这里只留**逐行不同**的部分：
					//   拖拽半透明、插入线、不可放提示。
					//   ⚠ 不要再往这里加 height/padding/fontSize —— 内联样式会盖掉类，官方数值就失效了 ✗。
					const style = Object.assign({},
						isDragging ? { opacity: .45 } : null,
						mark && mark.ok ? { boxShadow: (mark.after ? "inset 0 -2px 0 " : "inset 0 2px 0 ") + "var(--dsw-alias-state-business-primary, #5b8cff)" } : null,
						mark && !mark.ok ? { outline: "1px dashed #f48771", outlineOffset: "-1px" } : null,
					);
					const kids = [];
					const isUnread = unreadIds.indexOf(s.id) >= 0;
					// ★★ leading 格（官方 `.slot` = **16×20**，只放**一个**标记）：
					//   ① 非 idle 状态 ⇒ 状态点（官方 `showStatus = primaryStatus.state !== "idle"`；
					//      我们额外把 `unknown` 也归入"不画"—— 不把未知画成空闲 ✗）；
					//   ② 否则未读 ⇒ 未读点（dsh-desktop 那层语义，官方没有这一层）；
					//   ③ 否则留空（官方 idle 时渲染 `sidebar.session.row.leading` 槽；我们无槽 ⇒ 空）。
					const showStatus = s.status === "running" || s.status === "awaiting";
					kids.push(react.createElement("span", { key: "slot", className: "vssaros-ws-slot" },
						showStatus
							? react.createElement("span", {
								key: "ring",
								style: Object.assign({}, S.ring, s.status === "running" ? S.ringRunning : S.ringAwaiting),
								"data-ws-ring": s.status,
								title: RING_LABEL[s.status] || "",
							})
							: isUnread
								? react.createElement("span", {
									key: "unread",
									style: S.unreadDot,
									"data-ws-unread": "1",
									title: "未读",
									"aria-label": "未读",
								})
								: null));
					if (isRenaming) {
						kids.push(react.createElement("input", {
							key: "ren",
							style: S.rename,
							value: renaming.draft,
							autoFocus: true,
							"aria-label": "会话标题",
							onClick: (e) => e.stopPropagation(),
							onFocus: (e) => { try { e.currentTarget.select(); } catch { /* 忽略 */ } },
							onChange: (e) => setRenaming({ sid: s.id, draft: e.target.value }),
							onKeyDown: (e) => {
								if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commitRename(); }
								else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
							},
							// 失焦 = 取消（与 vssaros-sessions 页同口径：不偷偷提交）
							onBlur: () => setRenaming(null),
						}));
					} else {
						// ★★ 2026-11-02（复刻官方行）：标题 = `.vssaros-ws-title`
						//   （14px/20px + ellipsis + `margin:0 6px 0 4px`，数值在注入的 CSS 里）；
						//   未读加粗、双击就地重命名（官方 `onDoubleClick → onRenameRequest`）都保留。
						kids.push(react.createElement("span", {
							key: "lbl",
							className: "vssaros-ws-title",
							style: isUnread ? { fontWeight: 600 } : null,
							// ★ 2026-11-02：官方 `useTitleMarquee` 只在**溢出**时给两端淡出（`data-clipped`），
							//   我们按需在悬停时量一次（`scrollWidth > clientWidth`），不常驻定时器 ✓。
							onMouseEnter: (e) => {
								try {
									const el = e.currentTarget;
									if (el.scrollWidth > el.clientWidth + 1) { el.setAttribute("data-clipped", "1"); }
								} catch { /* 量不到就不淡出 */ }
							},
							onMouseLeave: (e) => {
								try {
									const el = e.currentTarget;
									el.removeAttribute("data-clipped");
									el.scrollLeft = 0;
								} catch { /* 忽略 */ }
							},
							onDoubleClick: (e) => {
								try { e.stopPropagation(); } catch { /* 无事件对象也能进 */ }
								setRenaming({ sid: s.id, draft: s.title });
							},
						}, s.title));
						// 稿 1：只有**非主根**的会话才带根名标签 ✓（多根模型的补充，官方没有）
						if (s.rootName && !s.isPrimaryRoot) {
							kids.push(react.createElement("span", { key: "rt", style: S.rtag }, s.rootName));
						}
						// 时间（官方顺序 title → time → pin → actions；悬停时由 CSS 隐藏，让位给 ⋯）：
						kids.push(react.createElement("span", {
							key: "at",
							className: "vssaros-ws-time",
							title: absTimeLabel(s.at) ? ("创建于 " + absTimeLabel(s.at)) : "",
						}, timeLabel(s.at)));
						// 图钉（官方 `.pinIndicator` = 16×20 + **SVG 图标** + 悬停隐藏）：
						//   原来用 📌 emoji —— 14px 下比官方矢量图标重一档，改成同款 pin 形状。
						if (s.pinned) {
							kids.push(react.createElement("span", {
								key: "pin", className: "vssaros-ws-pin", "data-pinned": "1",
								title: "已置顶", "aria-label": "已置顶", role: "img",
							}, react.createElement("svg", { width: 14, height: 14, viewBox: "0 0 16 16", "aria-hidden": "true", style: { display: "block" } },
								react.createElement("path", {
									fill: "currentColor",
									d: "M9.7 1.4a.9.9 0 0 1 1.3 0l3.6 3.6a.9.9 0 0 1-.6 1.5l-1.7.2-2.9 2.9.2 2.2a.7.7 0 0 1-1.2.6L6 11.2l-2.7 2.7-1.2-1.2L4.8 10 2.2 7.4a.7.7 0 0 1 .6-1.2l2.2.2 2.9-2.9.2-1.7a.9.9 0 0 1 .6-.6Z",
								}))));
						}
						// 行尾 ⋯（**官方主入口**：`.rowActions` 默认隐藏、悬停 / 菜单打开才出现）：
						//   右键菜单**保留**（我们原有的入口，官方没有）—— 两个入口开同一个菜单。
						kids.push(react.createElement("span", { key: "acts", className: "vssaros-ws-actions" },
							react.createElement("button", {
								type: "button",
								className: "vssaros-ws-icon",
								title: "会话操作",
								"aria-label": "会话操作（" + s.title + "）",
								"aria-haspopup": "true",
								onClick: (e) => {
									try { e.stopPropagation(); } catch { /* 忽略 */ }
									openSessMenu(s, e);
								},
							}, "⋯")));
					}
					return react.createElement("div", {
						key: s.id,
						// 官方行的稳定锚点（`data-row-key="session:<id>"`）—— 对自动化/调试有用
						"data-row-key": "session:" + s.id,
						"data-session-item": s.id,
						"data-pinned": s.pinned ? "1" : "0",
						// ★ 2026-11-02（复刻官方行）：`selected` / `menuOpen` 两个视觉态 ——
						//   官方是 CSS 类，我们用 `data-*` 让注入的样式表命中（React 内联表达不了 :hover）。
						"data-current": s.isCurrent ? "1" : undefined,
						"data-menu-open": (sessMenu && sessMenu.sid === s.id) ? "1" : undefined,
						className: "vssaros-ws-row",
						role: "treeitem",
						"aria-selected": s.isCurrent === true,
						// 重命名时禁用拖拽：否则输入框里选字会变成拖行 ✗
						draggable: isRenaming ? "false" : "true",
						style,
						// ★ 2026-11-02：**去掉行上的原生 `title`** —— 官方行也没有（它靠 HoverCard）；
						//   留着会和我们的 hover 卡片形成"两个浮层"（浏览器原生 tooltip 也 800ms 后弹）。
						//   会话 id 改在 hover 卡片里给（信息不丢，且不占标题位）。
						// ★ 2026-11-02：**打开即已读**（与 dsh-desktop 的 `view.markSessionRead` 同一时机，
						//   也是官方 `openSession` 里的第一步）—— 不放在打开成功的回调里：那时用户已经看到了。
						onClick: () => { if (!isRenaming) { markSessionRead(s.id); openSession(s.id, setMsg, setLocal); } },
						onContextMenu: (e) => openSessMenu(s, e),
						// ★ 2026-11-02：hover 卡片（官方 `HoverCard openDelayMs=800`；菜单开着/拖拽中不弹）
						onMouseEnter: (e) => openSessHover(s, e),
						onMouseLeave: closeSessHover,
						onDragStart: isRenaming ? undefined : onDragStartOf(s),
						onDragOver: onDragOverOf(s),
						onDragLeave: () => { if (dropAt && dropAt.sid === s.id) { setDropAt(null); } },
						onDrop: onDropOf(s),
						onDragEnd: () => { setDrag(null); setDropAt(null); },
					}, ...kids);
				};

				/**
				 * 一组的会话列表（**含分页**）—— 组内 / 平铺共用（口径不漂）。
				 *
				 * 2026-10-30 用户要求「会话太多时只加载一部分」：默认 `SESSION_PAGE_SIZE` 条，
				 * 底部一行「展开其余 N 条」（每次再放 20；全展开后变「收起」）。
				 * ⚠ 搜索命中**不截断**（"搜到就该看见"；这时候条数已被筛选收敛，不存在刷屏问题）。
				 * ⚠ 当前会话永远在可见集合里（见 `visibleSessions`），否则用户点开老会话后看不到它高亮在哪 ✗。
				 */
				const renderSessions = (row) => {
					const all = Array.isArray(row.sessions) ? row.sessions : [];
					const key = row.key || (row.record ? row.record.id : row.label);
					const extra = extraShown[key] || 0;
					const searching = !!q;
					const list = searching ? all : visibleSessions(all, SESSION_PAGE_SIZE + extra);
					const rest = all.length - list.length;
					const nodes = list.map((s) => renderSessionRow(s, setWsMsg, setLocalCurrent));
					if (searching) { return nodes; }
					if (rest > 0) {
						nodes.push(react.createElement("button", {
							key: "more", type: "button", "data-vssaros-more-sessions": key, style: S.moreRow,
							title: "只加载了一部分，展开后继续渲染",
							onClick: () => setExtraShown(Object.assign({}, extraShown, { [key]: extra + SESSION_PAGE_SIZE })),
						}, "展开其余 " + rest + " 条"));
					} else if (extra > 0) {
						nodes.push(react.createElement("button", {
							key: "less", type: "button", "data-vssaros-more-sessions": key, style: S.moreRow,
							title: "收回到默认条数（不改变顺序）",
							onClick: () => setExtraShown(Object.assign({}, extraShown, { [key]: 0 })),
						}, "收起"));
					}
					return nodes;
				};

				/* ══════════ 「会话 / Bots」页签（2026-11-02）══════════ */
				/**
				 * 开一条新会话（点「会话」页签 = 等同「新会话」按钮）。
				 *
				 * ★★ 2026-11-02 三次修正（用户报「点会话页签没有新建会话，只显示聊天框」）：
				 *   第一版直接调官方 `uiWorkspace.startSession()`，真机日志显示**调用确实发生了**
				 *   （`{kind:"new-session", via:"switchView→startSession", entering:true}`）但 `main`
				 *   会话没变 —— 因为官方实现里有：
				 *     `const navigation = AbortSignal.any([ctx.layout.beginNavigation(), lifetime.signal]);
				 *      sessionId = await connectBlank(wsId);
				 *      if (navigation.aborted) { return; }        ← 期间有别的导航 ⇒ 静默放弃`
				 *   `beginNavigation()` 每次调用都会中止上一次 ⇒ 与页面其它切换逻辑同帧竞争时**永远可能空转**，
				 *   而且**不报错**（用户只看到"还是原来那个聊天框"）。
				 *
				 *   ⇒ 现在改成我们**自己这条已验证可行的链**（与工作区 `+` 新建会话同一套）：
				 *     `sessions.create({ workspaceId })`（**带 workspaceId** ⇒ 会挂进工作区账本，
				 *     hero 输入框才是可用的）→ `uiWorkspace.openSession(sid)` → 焦点交给 composer。
				 *   目标工作区用现成的纯函数 `pickBotWorkspaceId`（当前会话所属 → 第一个有会话的）。
				 */
				const startNewSessionFromTab = () => {
					markUserNavGlobal();
					let wsId = "";
					try {
						const wsSvc = typeof ctx.get === "function" ? ctx.get("workspaces") : null;
						const snap = wsSvc && wsSvc.list && typeof wsSvc.list.getSnapshot === "function" ? wsSvc.list.getSnapshot() : null;
						wsId = pickBotWorkspaceId(currentId, snap);
					} catch { wsId = ""; }
					if (!wsId) {
						try { wsLog("new-session", { via: "tab", skipped: "没有可用工作区" }); } catch { /* 诊断 */ }
						say("没有可用的工作区，无法新建会话 —— 先添加一个工作区", "error");
						return;
					}
					let svc = null;
					try { svc = typeof ctx.get === "function" ? ctx.get("sessions") : null; } catch { svc = null; }
					if (!svc || typeof svc.create !== "function") {
						say("当前宿主不支持新建会话（sessions.create 不可用）", "error");
						return;
					}
					try { wsLog("new-session", { via: "tab", wsId }); } catch { /* 诊断 */ }
					void Promise.resolve(svc.create({ workspaceId: wsId })).then((res) => {
						const got = typeof res === "string" ? res
							: (res && typeof res === "object"
								? (res.sessionId || (res.value && (typeof res.value === "string" ? res.value : res.value.sessionId)))
								: undefined);
						if (!got) { throw new Error("宿主没返回 sessionId"); }
						try { markSessionRead(String(got)); } catch { /* 本地未读表 */ }
						try {
							const uw = ctx.uiWorkspace;
							// create 可能耗时 ⇒ 打开前再刷新一次信号（workbenches 的放行窗口是 2.5s）
							markUserNavGlobal();
							if (uw && typeof uw.openSession === "function") { uw.openSession(String(got)); }
						} catch (e) {
							say("新建会话失败：" + errText(e), "error");
							return;
						}
						focusComposer();
					}).catch((e) => say("新建会话失败：" + errText(e), "error"));
				};
				const switchView = (v) => {
					const next = v === "bots" ? "bots" : "sessions";
					setViewState(next);
					writeSidebarView(next);
					setBotsMsg(null);
					// 只在切到「会话」时开新会话（切 Bots 不该开）；失败不打断切页签
					if (next === "sessions") { startNewSessionFromTab(); }
				};
				/**
				 * 重新拉名册 + 群聊（进 Bots 页签时自动拉一次；⟳ 手动再拉）。
				 *
				 * ★ 2026-11-02（用户报「读取名册太慢了」）：**缓存优先** —— 先用上次结果铺满列表
				 *   （`stale: true` ⇒ 标题旁标「缓存」），再后台刷新；请求 8s 超时，超时也**不白屏**
				 *   （保留缓存 + 说明原因）。改之前是"loading 挂到接口返回为止"，慢接口 = 长时间空白。
				 */
				const reloadBots = () => {
					const cached = readBotsCache();
					setBots((b) => {
						const hasRows = (b.agents || []).length > 0;
						// 已有内容（上次已拉到 / 刚读的缓存）⇒ 只切 loading，绝不清空列表
						if (hasRows) { return Object.assign({}, b, { status: "loading" }); }
						if (cached && cached.agents.length) {
							return { status: "loading", agents: cached.agents, home: cached.home, groups: cached.groups, rooms: cached.rooms, error: "", stale: true, cachedAt: cached.at };
						}
						return Object.assign({}, b, { status: "loading" });
					});
					const timeout = new Promise((_, rej) => {
						try {
							window.setTimeout(() => rej(new Error("读取超时（" + Math.round(BOTS_TIMEOUT_MS / 1000) + "s 未返回）")), BOTS_TIMEOUT_MS);
						} catch { /* 无 window ⇒ 不设超时 */ }
					});
					void Promise.race([fetchBotsData(), timeout]).then((d) => {
						if (d && d.ok) {
							saveBotsCache(d);
							setBots({
								status: "ready", agents: d.agents, home: d.home, groups: d.groups, error: "",
								// ★ 2026-11-05 群聊（读不到群只影响群行，名册照常；原因放在 roomsError 里如实说）
								rooms: d.rooms || [], roomsError: d.roomsError || "",
								// ★ 2026-11-03：preset 还在分批注册 ⇒ 这份快照的「未注册」会虚高（下面自动重拉）
								presetsPending: d.presetsPending === true,
								fetchedAt: Date.now(),
							});
						} else {
							setBots((b) => ((b.agents || []).length
								? Object.assign({}, b, { status: "ready", stale: true, error: String((d && d.error) || "读取失败") })
								: { status: "error", agents: [], home: {}, groups: [], error: String((d && d.error) || "读取失败") }));
						}
					}).catch((e) => {
						const why = String((e && e.message) || e);
						setBots((b) => ((b.agents || []).length
							? Object.assign({}, b, { status: "ready", stale: true, error: why })
							: { status: "error", agents: [], home: {}, groups: [], error: why }));
					});
				};
				react.useEffect(() => {
					if (view !== "bots" || bots.status !== "idle") { return; }
					reloadBots();
				}, [view, bots.status]);
				/* ★ 2026-11-03（用户报「Bots 页签里为什么这么多未注册」）：
				   根因 = lazy 两阶段注册 —— 启动时只注册首批（可委派 + 最近会话用过的，通常 4~5 个），
				   其余 15s 后才补齐。这个页签原来**只在第一次进入时拉一次**，于是把早期快照一直挂在屏上，
				   「未注册 N 个」看起来像坏了。后端 `/api/home` 现在会回 `presetsPending`：
				   还在补齐就每 3s 重拉一次（上限 40 次 ≈ 2 分钟），补齐后自然停下；
				   同时把状态写进提示条（`data-vssaros-bots-pending`），不让人以为没注册成功。 */
				react.useEffect(() => {
					if (view !== "bots" || bots.status !== "ready" || bots.presetsPending !== true) { return undefined; }
					const timer = window.setTimeout(() => { reloadBots(); }, 3000);
					return () => { try { window.clearTimeout(timer); } catch { /* 忽略 */ } };
				}, [view, bots.status, bots.presetsPending, bots.fetchedAt]);
				/**
				 * ★ 2026-11-05 P1 + bot item 状态：群执行时 Bots 页签不能停在旧快照。
				 *   ① `vssaros-rooms-changed` 合并群行；② `vssaros-group-progress` 复用全局浮层的
				 *      `?active=1` 轮询，给 bot item 上 DS Bot 状态动画；③ 2s 群列表轮询只作兜底。
				 *   这两个事件都由 GroupActivityDock 发，不另开一条轮询。
				 */
				react.useEffect(() => {
					if (view !== "bots") { return undefined; }
					let alive = true;
					const applyRooms = (rooms) => {
						if (!alive) { return; }
						setBots((b) => (b.status === "ready" ? Object.assign({}, b, { rooms: Array.isArray(rooms) ? rooms : [], roomsError: "" }) : b));
					};
					const applyActivity = (active) => { if (alive) { setGroupActivity(normalizeGroupActivity(active)); } };
					const poll = () => { void fetchRoomsOnly().then((d) => { if (d && d.ok) { applyRooms(d.rooms); } }); };
					const win = typeof window !== "undefined" ? window : null;
					const onChanged = (ev) => applyRooms(ev && ev.detail ? ev.detail.rooms : []);
					const onProgress = (ev) => applyActivity(ev && ev.detail ? ev.detail.active : []);
					if (win && typeof win.addEventListener === "function") {
						win.addEventListener(ROOMS_CHANGED_EVENT, onChanged);
						win.addEventListener(GROUP_PROGRESS_EVENT, onProgress);
					}
					try { if (win && Array.isArray(win.__vssarosGroupProgress)) { applyActivity(win.__vssarosGroupProgress); } } catch { /* 没有全局缓存就等下一次事件 */ }
					poll();
					const timer = setInterval(poll, 2000);
					return () => {
						alive = false;
						clearInterval(timer);
						if (win && typeof win.removeEventListener === "function") {
							win.removeEventListener(ROOMS_CHANGED_EVENT, onChanged);
							win.removeEventListener(GROUP_PROGRESS_EVENT, onProgress);
						}
					};
				}, [view]);
				// ★★ 这是**最后一个 hook**。rail（窄轨）形态的提前 return 必须放在它之后 ——
				//   React 规则：每次渲染的 hook 数量与顺序必须完全一致，否则抛 error #310 并卸载整棵子树
				//   （2026-11-02 真机根因，详见上面 `railOnly` 处的长注释）。
				if (railOnly) {
					try {
						if ((state.workspacesRailLog || 0) < 3) {
							state.workspacesRailLog = (state.workspacesRailLog || 0) + 1;
							wsLog("render-rail", { count: state.workspacesRailLog });
						}
					} catch { /* 忽略 */ }
					return react.createElement("button", {
						style: Object.assign({}, S.iconBtn, { fontSize: 16, padding: 6 }),
						title: "Workspaces",
						onClick: () => { try { props.expandSidebar(); } catch { /* 可选 */ } },
					}, "🗀");
				}
				/**
				 * 点 bot ⇒ **中栏打开它最近一条会话**（`home[agentId].sessions[0].id` 是宿主给的现成事实）。
				 * 一条会话都没有时：`POST /api/session { agentPreset }` 新建一条绑该 preset 的会话再打开。
				 * ⚠ 不用「切人格」那条路（那只换提示词、不换会话）—— 用户要的是"点 bot 就是和它聊"。
				 */
				const openBot = (a) => {
					const id = String((a && a.id) || "");
					if (!id) { return; }
					setBotsMsg(null);
					// ★ 2026-11-06：正在群里干活的 bot ⇒ 打开它在那个群里的会话（没有就打开群会话），见 botOpenTargetOf。
					const busySid = botOpenTargetOf(botStateOf(groupActivity, a, bots.rooms || []), a, bots.rooms || []);
					if (busySid) { markSessionRead(busySid); openSession(busySid, setBotsMsg); return; }
					/* ★ 2026-11-02（用户第二次报「bot 聊天框无法输入」，截图：工作区选择器里 cwd 有、但输入框仍灰）：
					   真根因在官方 hero：`inert = hero && chipTitle === undefined`，chipTitle 来自**工作区账本里含该会话**
					   的工作区标题。只传 cwd 建出来的会话**不在账本里** ⇒ 灰输入框（上一版的 cwd 修法方向错了）。
					     ① 复用「最近会话」前先查它**是否已登记进某个工作区**（`workspaces.list.items[].sessionIds`）；
					        没登记的跳过（≈ 以前不带工作区建的老会话）；
					     ② 新建时传 **workspaceId**（不是 cwd；官方建完会 attachSession 登记）。 */
					const usable = (s0) => isRegisteredSession(s0, wsSnap);
					const sid = latestSessionIdOf(bots.home, id, usable);
					if (sid) { markSessionRead(sid); openSession(sid, setBotsMsg); return; }
					const presetId = String((a && a.presetId) || ("vssaros-" + id));
					const name = String((a && a.name) || id);
					const wsId = pickBotWorkspaceId(currentId, wsSnap);
					if (!wsId) {
						setBotsMsg({ kind: "error", text: "还没有任何工作区 —— 先在「会话」页签里点 + 添加一个工作区，再开「" + name + "」的会话。" });
						return;
					}
					setBotsMsg({ kind: "note", text: "正在为「" + name + "」新建会话…" });
					let p;
					try {
						p = fetch(AGENTS_API_SESSION, {
							method: "POST", headers: { "content-type": "application/json" },
							body: JSON.stringify({ agentPreset: presetId, workspaceId: wsId }),
						}).then((r) => r.json().then((j) => ({ ok: r.ok && (!j || j.ok !== false), j: j || {} })));
					} catch (e) {
						setBotsMsg({ kind: "error", text: "新建会话失败：" + String((e && e.message) || e) });
						return;
					}
					void p.then((r) => {
						const nextSid = r && r.j && r.j.sessionId;
						if (!r.ok || !nextSid) { throw new Error((r.j && r.j.error) || "宿主没返回 sessionId"); }
						markSessionRead(nextSid);
						setBotsMsg(null);
						// ★ 新会话已登记进账本，但 `bots.home` 还是点之前拉的 ⇒ 不刷新的话，再点同一个 bot
						//   会因「名册里没有它」又新建一条（越点越多）。先把名册重拉，下一次点击就能复用这条。
						reloadBots();
						openSession(String(nextSid), setBotsMsg);
					}).catch((e) => setBotsMsg({ kind: "error", text: "新建会话失败：" + String((e && e.message) || e) }));
				};
				/** POST JSON（agents 的写接口用；非 2xx 时抛出宿主给的 error 文案，不吞）。 */
				const postJson = (url, body) => {
					let p;
					try {
						p = Promise.resolve(fetch(url, {
							method: "POST",
							headers: { "content-type": "application/json", accept: "application/json" },
							body: JSON.stringify(body || {}),
						}));
					} catch (e) { return Promise.reject(e); }
					return p.then((r) => Promise.resolve(r.json().catch(() => null)).then((j) => {
						if (!r || !r.ok) { throw new Error((j && j.error) || ("HTTP " + (r && r.status))); }
						return j;
					}));
				};
				/** 名称 → 建议 id（与 agents `suggestIdFromName` 同规则：非 `[a-z0-9._-]` 折成 `-`；纯中文 ⇒ 空）。 */
				const slugOfName = (name) => String(name || "").toLowerCase()
					.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
				/** 打开「新建 Bot / 新建群聊」表单。 */
				const openBotsNew = (kind) => {
					// ★ 顺序要紧（2026-11-02 真机：只关菜单、表单不弹）：
					//   先设表单，再关菜单 —— 反过来时，`setBotsMenu(null)` 会让菜单容器卸载，
					//   而菜单项是在 **mousedown（capture）** 里调的，卸载发生在同一批更新里，
					//   实测出现过"表单 state 已写入、但 DOM 没跟上"的诡异状态。
					//   另外这里**不改** `botsMsg`（它属于"操作反馈"，与打开表单无关）。
					setBotsNew({
						kind,
						name: "", id: "", role: "", description: "",
						icon: BOT_ICON_PRESETS[0],
						
						busy: false, error: "",
					});
					setBotsMenu(null);
					setBotsMsg(null);
				};
				/**
				 * 提交新建（Bot / 群聊）。
				 * ⚠ 两个接口的**必填项不同**：Bot 要 `name` + `id`（英文，纯中文名 slug 为空 ⇒ 让用户手填）；
				 *   群聊要 `name` + **至少一个真实存在的成员**（host 侧会校验 id 集合）。
				 * ⚠ 失败一律就地显示（`botsNew.error`），不假装成功、不静默。
				 */
				const submitBotsNew = () => {
					const cur = botsNew;
					if (!cur || cur.busy) { return; }
					const name = String(cur.name || "").trim();
					// 既有 id（"重名"预校验；host 侧还会再查一次并 409）
					const existingIds = (bots.agents || []).map((a) => String((a && a.id) || "")).filter(Boolean);
					if (cur.kind === "bot") {
						const id = String(cur.id || "").trim() || slugOfName(name);
						const errs = validateBotDraft({ name, id }, existingIds);
						if (errs.length) { setBotsNew(Object.assign({}, cur, { error: errs.join("；") })); return; }
						const next = Object.assign({}, cur, { busy: true, error: "" });
						setBotsNew(next);
						void postJson(AGENTS_API_AGENTS, {
							action: "create",
							draft: {
								name,
								id,
								role: String(cur.role || "").trim(),
								description: String(cur.description || "").trim(),
								icon: String(cur.icon || "").trim() || BOT_ICON_PRESETS[0],
							},
						}).then(
							() => {
								setBotsNew(null);
								setBotsMsg({ kind: "note", text: "已新建 Bot「" + name + "」（" + id + "）—— 名册刷新中…" });
								reloadBots();
							},
							(e) => setBotsNew((b) => Object.assign({}, b || next, { busy: false, error: "新建失败：" + String((e && e.message) || e) })),
						);
						return;
					}
				};
				// ── 群行（★ 2026-11-05 多 bot 群聊；数据 = /x/agents/api/rooms，纯逻辑见上面 roomMenuItems / roomMenuAction）──
				const botsSay = (text, kind) => setBotsMsg(text ? { kind: kind || "note", text } : null);
				/** 点群 ⇒ 中栏打开群会话（群 id 就是会话 id）；打开即清未读。 */
				const openRoom = (room) => {
					if (!room || !room.id) { return; }
					markSessionRead(room.id);
					openSession(String(room.id), setBotsMsg);
				};
				/** 群设置 ⇒ 打开群会话并直接落在「设置」页签（群名 / 公告 / 谁来回答 / 成员）。 */
				const openRoomSettings = (sid) => {
					try { presetConversationView(typeof localStorage !== "undefined" ? localStorage : null, sid, SETTINGS_VIEW_ID); } catch { /* 选不中就停在对话页 */ }
					markSessionRead(sid);
					openSession(String(sid), setBotsMsg);
					// 会话视图已挂着（之前打开过）⇒ 本地存储改了它也不读 ⇒ 再经官方 binding 选一次页签
					try {
						window.setTimeout(() => {
							try {
								const uc = ctx.uiConversation;
								const binding = uc && typeof uc.binding === "function" ? uc.binding(sid) : null;
								if (binding && typeof binding.activate === "function") { binding.activate(SETTINGS_VIEW_ID); }
							} catch { /* 没有这个能力 ⇒ 停在对话页，用户自己点「设置」 */ }
						}, 400);
					} catch { /* 无 window */ }
				};
				const roomDeps = {
					post: (body) => postJson(AGENTS_API_ROOMS, body),
					open: (sid) => openRoom({ id: sid }),
					openSettings: openRoomSettings,
					setUnread: (sid, on) => setSessionUnread(sid, on),
					copy: (text) => copyPlain(text, botsSay, "已复制对话 ID：" + text),
					startRename: (room) => setRoomRename({ id: room.id, draft: room.named === false ? "" : String(room.name || "") }),
					confirmDelete: (room) => setRoomDel({ id: room.id, name: String(room.name || room.id) }),
					reload: () => reloadBots(),
					say: botsSay,
				};
				const runRoomAct = (act) => {
					const cur = roomMenu;
					setRoomMenu(null);
					if (!cur) { return; }
					const room = (bots.rooms || []).filter((r) => r && r.id === cur.id)[0] || { id: cur.id };
					void Promise.resolve(roomMenuAction(act, room, cur.unread, roomDeps)).catch(() => undefined);
				};
				const commitRoomRename = () => {
					const cur = roomRename;
					setRoomRename(null);
					if (!cur) { return; }
					void postJson(AGENTS_API_ROOMS, { action: "update", id: cur.id, name: String(cur.draft || "").trim() }).then(
						(j) => { reloadBots(); botsSay("已改名为「" + String((j && j.room && j.room.name) || cur.draft) + "」", "note"); },
						(e) => botsSay("重命名失败：" + errText(e), "error"),
					);
				};
				const deleteRoom = () => {
					const cur = roomDel;
					setRoomDel(null);
					if (!cur) { return; }
					void postJson(AGENTS_API_ROOMS, { action: "delete", id: cur.id }).then(
						() => { setSessionUnread(cur.id, false); reloadBots(); botsSay("已删除群聊「" + cur.name + "」（群会话已归档，可在「已归档」里找回）", "note"); },
						(e) => botsSay("删除失败：" + errText(e), "error"),
					);
				};
				const roomRow = (room) => {
					const id = String(room.id);
					const name = String(room.name || id);
					const members = Array.isArray(room.members) ? room.members : [];
					const unread = unreadIds.indexOf(id) >= 0;
					const isCur = id === currentId;
					const renamingThis = !!(roomRename && roomRename.id === id);
					const rs = roomStateOf(groupActivity, room);
					const roomActive = rs.state !== "idle";
					const roomDot = rs.state === "alert" ? "var(--dsw-alias-state-error-primary, currentColor)"
						: rs.state === "waiting" ? "var(--dsw-alias-state-warn-primary, currentColor)"
							: "var(--dsw-alias-state-success-primary, currentColor)";
					const tip = name + "\n" + members.map((m) => String((m && m.name) || (m && m.id) || "")).join("、")
						+ (room.notice ? "\n公告：" + String(room.notice).slice(0, 120) : "")
						+ (roomActive ? "\n" + rs.label : "") + "\n点击 ⇒ 在中栏打开群聊；右键 ⇒ 更多";
					return react.createElement("div", {
						key: "room:" + id, "data-vssaros-room": id, "data-vssaros-room-pinned": room.pinned ? "1" : "0",
						// 复用成员行的姿态 / shimmer / 彩点样式（选择器只看这几个属性）
						"data-vssaros-bot-state": rs.state, "data-vssaros-room-round-status": rs.status,
						"aria-label": name + (roomActive ? " · " + rs.label : ""),
						style: Object.assign({}, S.botRow, isCur ? { background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.16))" } : null), title: tip,
						onClick: () => { if (!renamingThis) { openRoom(room); } },
						onContextMenu: (e) => {
							try { e.preventDefault(); e.stopPropagation(); } catch { /* 合成事件 */ }
							const w = typeof window !== "undefined" ? window.innerWidth : 0;
							const h = typeof window !== "undefined" ? window.innerHeight : 0;
							let x = e.clientX || 0;
							let y = e.clientY || 0;
							if (w > 0) { x = Math.max(8, Math.min(x, w - 200)); }
							if (h > 0) { y = Math.max(8, Math.min(y, h - 300)); }
							setRoomMenu({ id, x, y, unread });
						},
					},
						react.createElement("span", { "data-vssaros-bot-avatar": rs.state, style: Object.assign({}, S.botAv, { background: "var(--dsw-alias-brand-primary, #4d7cfe)", fontSize: 10 }) }, roomInitials(room)),
						react.createElement("span", { style: S.botMain },
							renamingThis ? react.createElement("input", {
								style: S.rename, value: roomRename.draft, autoFocus: true, placeholder: "留空 = 按成员命名",
								"data-vssaros-room-rename": id,
								onClick: (e) => { try { e.stopPropagation(); } catch { /* 忽略 */ } },
								onChange: (e) => setRoomRename({ id, draft: e.target.value }),
								onKeyDown: (e) => {
									if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commitRoomRename(); }
									else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRoomRename(null); }
								},
								onBlur: () => setRoomRename(null),
							}) : react.createElement("span", { style: S.botL1 },
								react.createElement("span", { style: Object.assign({}, S.botName, unread ? { fontWeight: 600 } : null) }, name),
								react.createElement("span", { style: S.botPill }, "群"),
								room.pinned ? react.createElement("span", { style: S.botPill, title: "已置顶" }, "置顶") : null,
								room.hidden ? react.createElement("span", { style: S.botPill, title: "已从侧栏隐藏（打开着所以还显示）" }, "隐藏") : null,
								unread ? react.createElement("span", { style: S.unreadDot, "data-vssaros-room-unread": "1" }) : null),
							roomActive
								? react.createElement("span", { "data-vssaros-bot-state-label": "1", "data-vssaros-room-state-label": "1", style: S.botStateText, title: rs.label }, rs.label)
								: react.createElement("span", { style: S.botL2 }, room.preview ? String(room.preview) : (members.length + " 位成员"))),
						roomActive ? react.createElement("span", { "data-vssaros-bot-dot": "1", "aria-hidden": "true", style: Object.assign({}, S.botStateDot, { background: roomDot }) }) : null);
				};
				const botsSection = (label, count, rows) => (count > 0 ? react.createElement(react.Fragment, null,
					react.createElement("div", { key: "sec:" + label, style: S.botsSec }, label, react.createElement("span", { style: S.botsSecCt }, String(count))),
					rows) : null);
				const botRow = (a) => {
					const id = String((a && a.id) || "");
					const name = String((a && a.name) || id);
					const reg = a && a.registered !== false;
					const total = (bots.home && bots.home[id] && typeof bots.home[id].sessionsTotal === "number")
						? bots.home[id].sessionsTotal : 0;
					const bs = botStateOf(groupActivity, a, bots.rooms || []);
					const activeState = bs.state !== "idle";
					const idleLine = (reg ? "" : "花名册里没有它的 preset · ") + (total ? total + " 会话" : "还没有会话");
					const dotColor = bs.state === "alert" ? "var(--dsw-alias-state-error-primary, currentColor)"
						: (bs.state === "waiting" || bs.state === "orbit") ? "var(--dsw-alias-state-warn-primary, currentColor)"
							: "var(--dsw-alias-state-success-primary, currentColor)";
					const tip = name + (a && a.role ? " · " + a.role : "") + "\n" + String((a && a.description) || "")
						+ "\n点击 ⇒ 在中栏打开" + (activeState ? "它在「" + (bs.roomName || "群") + "」里的会话" : total ? "它最近一条会话" : "一条新会话")
						+ (activeState ? "\n" + bs.state + "：" + bs.label : "");
					return react.createElement("div", {
						key: "bot:" + id, "data-vssaros-bot": id, "data-vssaros-bot-state": bs.state,
						"data-vssaros-bot-room": bs.roomId, "data-vssaros-bot-event": bs.eventKind,
						"data-vssaros-bot-label": bs.label, style: S.botRow, title: tip,
						"aria-label": name + (activeState ? " · " + bs.label : ""),
						onClick: () => openBot(a),
					},
						react.createElement("span", { "data-vssaros-bot-avatar": bs.state, style: Object.assign({}, S.botAv, { background: String((a && a.color) || "") || "var(--dsw-alias-brand-primary, #4d7cfe)" }) }, name.slice(0, 1)),
						react.createElement("span", { style: S.botMain },
							react.createElement("span", { style: S.botL1 },
								react.createElement("span", { style: S.botName }, name),
								a && a.role ? react.createElement("span", { style: S.botPill }, String(a.role)) : null,
								reg ? null : react.createElement("span", { style: Object.assign({}, S.botPill, { color: "var(--dsw-alias-state-warn-primary, #e0a43a)" }) }, "未注册")),
							activeState
								? react.createElement("span", { "data-vssaros-bot-state-label": "1", style: S.botStateText, title: bs.label }, bs.label)
								: react.createElement("span", { style: S.botL2 }, idleLine)),
						activeState ? react.createElement("span", { "data-vssaros-bot-dot": "1", "aria-hidden": "true", style: Object.assign({}, S.botStateDot, { background: dotColor }) }) : null);
				};
				const botsPane = () => {
					const list = bots.agents || [];
					// ★ 2026-11-03（用户要求「只显示已注册的 bots」）：未注册的**不再渲染**。
					//   为什么可以省：preset 没注册成功的 bot 点了也开不了会话（`session.create` 会报未知 preset），
					//   列出来只是噪音；启动早期的"未注册"更是分批注册的正常中间态（见上面 presetsPending）。
					//   仍然保留计数口径：`hiddenUnregistered` 只用于"有 N 个没显示"的一句说明。
					const regAll = list.filter((a) => a && a.registered !== false);
					const hiddenUnregistered = list.filter((a) => a && a.registered === false).length;
					const loading = bots.status === "loading";
					const ready = bots.status === "ready";
					// ★ 2026-11-02（用户要求「Bots 页签下增加搜索按钮和 + 按钮，通会话页签的 UI」）：
					//   搜索口径与会话页签一致 —— 名称 / id / role / 描述。
					// ★ 2026-11-03：群聊下线 ⇒ 名册只剩 bot。
					const q = botsQuery.trim().toLowerCase();
					const hit = (v) => !q || String(v || "").toLowerCase().indexOf(q) >= 0;
					const reg = regAll.filter((a) => hit(a && a.name) || hit(a && a.id) || hit(a && a.role) || hit(a && a.description));
					// ★ 2026-11-05 群聊：置顶在前、隐藏的不显示（当前打开的除外）；搜索按群名与成员名
					const roomsShown = visibleRooms(bots.rooms, currentId, botsQuery);
					const searching = q.length > 0;
					const shownCount = reg.length + roomsShown.length;
					// ★ 诊断（2026-11-02）：点「新建 Bot」后表单没出现 —— 先分清是 **state 没变**
					//   还是 **渲染块被跳过**。只在非 null 时打，正常使用不会刷屏。
					if (botsNew) {
						try { wsLog("bots-form-render", { kind: botsNew.kind, hasTitle: !!S.botsFormHeadT }); } catch { /* 忽略 */ }
					}
					return react.createElement("div", { style: S.botsPane, "data-vssaros-bots-pane": String(list.length) },
						react.createElement("div", { style: S.head },
							react.createElement("span", { style: S.headT }, "Bots"),
							// 有缓存就先标出来（正在后台刷新）—— 用户不至于以为这就是最新
							bots.stale && list.length ? react.createElement("span", {
								style: { fontSize: 10, flex: "0 0 auto", marginRight: 4, color: "var(--dsw-alias-label-tertiary, #737373)" },
								title: bots.cachedAt ? ("上次读到：" + new Date(bots.cachedAt).toLocaleTimeString("zh-CN")) : "正在后台刷新",
							}, "缓存") : null,
							// 🔍 搜索（与会话页签**同款按钮、同款位置**）
							react.createElement("button", {
								type: "button", style: S.iconBtn, title: "搜索 Bot / 群聊", "aria-label": "搜索 Bot / 群聊",
								"aria-pressed": botsSearchOn ? "true" : "false",
								"data-vssaros-bots-search": "1",
								onClick: () => setBotsSearchOn(!botsSearchOn),
							}, "🔍"),
							// ⟳ 刷新：＋ 菜单只放「新建」（用户 2026-11-02 明确要求），
							//   刷新是常用操作 ⇒ 作为**独立图标**留在头部，不占菜单。
							react.createElement("button", {
								type: "button", style: S.iconBtn, title: loading ? "正在读取…" : "重新读取名册 / 群聊",
								"aria-label": "刷新 Bots", "data-vssaros-bots-refresh": "1", disabled: loading,
								onClick: () => reloadBots(),
							}, loading ? "…" : "⟳"),
							// ＋（与会话页签**同款位置/形态**：点击开一个 fixed 菜单）
							//   ⚠ 用 ASCII "+"（全角「＋」在某些渲染环境没有字形 ⇒ 显示成豆腐块）
							react.createElement("button", {
								type: "button",
								style: Object.assign({}, S.iconBtn, { fontSize: 14, fontWeight: 600, minWidth: 18, textAlign: "center" }),
								title: "新建 / 更多…", "aria-label": "新建 / 更多", "aria-haspopup": "true",
								"data-vssaros-bots-add": "1",
								onClick: (e) => {
									try { e.preventDefault(); e.stopPropagation(); } catch { /* 合成事件 */ }
									let x = 16;
									let y = 16;
									try {
										const r = e.currentTarget.getBoundingClientRect();
										x = r.right - 220;
										y = r.bottom + 2;
									} catch { /* 拿不到 rect 就用左上角 */ }
									const w = typeof window !== "undefined" ? window.innerWidth : 0;
									const h = typeof window !== "undefined" ? window.innerHeight : 0;
									if (w > 0) { x = Math.max(8, Math.min(x, w - 236)); }
									if (h > 0) { y = Math.max(8, Math.min(y, h - 300)); }
									setBotsMenu({ x, y });
								},
							}, "+")),
						botsSearchOn ? react.createElement("input", {
							style: S.search, placeholder: "搜索 Bot / 群聊…", value: botsQuery,
							"aria-label": "搜索 Bot / 群聊", "data-vssaros-bots-search-input": "1",
							onChange: (e) => setBotsQuery(e.target.value),
						}) : null,
						botsMsg ? react.createElement("div", {
							style: Object.assign({}, S.sessMsg, {
								color: botsMsg.kind === "error" ? "#f48771" : "var(--dsw-alias-label-tertiary, #737373)",
							}),
						}, botsMsg.text) : null,
						bots.status === "error" ? react.createElement("div", { style: S.botsHint },
							"读不到 Bots（" + bots.error + "）—— agents 插件没装、或 Host 没起来。点 ＋ → 刷新名册 重试。") : null,
						// ★ 慢接口的兜底说明（2026-11-02）：有缓存内容时**不整块报错**，
						//   只在顶部说一句"显示的是上次结果"（列表照常可点）。
						bots.stale && list.length && bots.error ? react.createElement("div", { style: S.botsHint },
							"显示上次结果（" + bots.error + "）—— 点 ＋ → 刷新名册 重试。") : null,
						bots.status === "idle" || (loading && !list.length) ? react.createElement("div", { style: S.botsHint }, "正在读取名册…") : null,
						ready && !list.length ? react.createElement("div", { style: S.botsHint },
							"还没有 bot（每个子目录需要一个带 name 的 .agent.md）。") : null,
						// ★ 2026-11-03：preset 分批注册期间说明一下（此时"少几个 bot"是正常中间态，不是名册丢了）
						bots.presetsPending === true ? react.createElement("div", {
							"data-vssaros-bots-pending": "1",
							style: S.botsHint,
						}, "dsh 正在分批注册 preset（启动时先注册首批，其余十几秒后补齐）—— 还没注册好的 bot 暂不显示，本页每 3 秒自动刷新。") : null,
						// 搜索无结果时说清楚（否则看起来像"名册空了"✗）
						searching && shownCount === 0 ? react.createElement("div", { style: S.botsHint },
							"没有匹配「" + botsQuery.trim() + "」的 Bot 或群聊。") : null,
						// ★ 2026-11-03（用户要求「只显示已注册的 bots」）：未注册的整段不再渲染，
						//   只留一句计数（可点 ⟳ 重试；preset 注册成功后它们会自己出现在上面）。
						!searching && hiddenUnregistered > 0 && bots.presetsPending !== true ? react.createElement("div", {
							"data-vssaros-bots-hidden": String(hiddenUnregistered),
							style: S.botsHint,
						}, "另有 " + hiddenUnregistered + " 个 bot 的 preset 未注册（点了也开不了会话）⇒ 已隐藏。改了 .agent.md 或刚启动时可点 ＋ → 刷新名册 重试。") : null,
						react.createElement("div", { style: S.list, "data-vssaros-rooms": String(roomsShown.length) },
							botsSection("群聊", roomsShown.length, roomsShown.map(roomRow)),
							botsSection("已注册", reg.length, reg.map(botRow))),
						bots.roomsError && !(bots.rooms || []).length ? react.createElement("div", { style: S.botsHint, "data-vssaros-rooms-error": "1" },
							"读不到群聊（" + bots.roomsError + "）—— 需要 @vssaros/dsh-agents 0.2.325+。") : null,
						// ★ 2026-11-05 群行右键菜单（4 组 7 项，见 roomMenuItems）。⚠ 用 onMouseDown（理由同 ＋ 菜单）
						roomMenu ? react.createElement("div", {
							"data-vssaros-room-menu": roomMenu.id,
							role: "menu",
							style: Object.assign({}, S.sessMenu, { left: roomMenu.x, top: roomMenu.y, minWidth: 170 }),
						}, roomMenuItems((bots.rooms || []).filter((r) => r && r.id === roomMenu.id)[0] || {}, roomMenu.unread).map((it, i) => (it.sep
							? react.createElement("div", { key: "sep" + i, style: { height: 1, margin: "4px 6px", background: "var(--dsw-alias-border-l1, #3a3a3a)" } })
							: react.createElement("button", {
								key: it.act, type: "button", role: "menuitem", "data-act": "room-" + it.act,
								style: Object.assign({}, S.menuItem, it.danger ? { color: "#f48771" } : null),
								onMouseDown: (e) => { try { e.preventDefault(); } catch { /* 忽略 */ } runRoomAct(it.act); },
							}, it.label)))) : null,
						roomDel ? react.createElement("div", {
							"data-vssaros-room-confirm": roomDel.id,
							style: {
								position: "fixed", left: "50%", top: "38%", transform: "translate(-50%, -50%)",
								zIndex: 90, width: 320, padding: "14px 14px 12px", borderRadius: 12,
								background: "var(--dsw-alias-bg-layer-2, #262626)",
								border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
								boxShadow: "0 24px 60px rgba(0,0,0,.65)",
								color: "var(--dsw-alias-label-primary, #e6e6e6)",
							},
						},
							react.createElement("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, "删除群聊「" + roomDel.name + "」？"),
							react.createElement("div", { style: { fontSize: 11.5, lineHeight: "1.65", color: "var(--dsw-alias-label-tertiary, #737373)", marginBottom: 12 } },
								"群会话和成员在群里的会话会被归档（「已归档」里还能找回），群从侧栏移除。"),
							react.createElement("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
								react.createElement("button", { type: "button", style: S.menuItem, "data-act": "room-delete-cancel", onClick: () => setRoomDel(null) }, "取消"),
								react.createElement("button", {
									type: "button", "data-act": "room-delete-confirm", onClick: deleteRoom,
									style: Object.assign({}, S.menuItem, { color: "#f48771", fontWeight: 600 }),
								}, "删除"))) : null,
						// ＋ 菜单（fixed；与会话页签的 ＋ 菜单同形态）
						botsMenu ? react.createElement("div", {
							"data-vssaros-bots-menu": "1",
							style: Object.assign({}, S.sessMenu, { left: botsMenu.x, top: botsMenu.y, maxHeight: 320, overflowY: "auto" }),
						},
							// ★★ 2026-11-02（用户要求「＋ 表示新建 bot 或群聊」）：这两项才是 ＋ 的主语义。
							// ⚠⚠ 必须用 `onMouseDown` 而不是 `onClick`：
							//   全局"点外面关菜单"监听的是 **document 的 mousedown（capture）**，
							//   它在元素之前执行 ⇒ 先把 `botsMenu` 置 null ⇒ React 卸载这个按钮
							//   ⇒ 随后的 click 落在已卸载节点上 ⇒ **onClick 根本不触发**
							//   （2026-11-02 真机：点「新建 Bot…」只关了菜单、表单没弹，就是这个）。
							react.createElement("button", {
								type: "button", role: "menuitem", "data-act": "new-bot", style: S.menuItem,
								title: "新建一个 Bot（会在 agents 数据根下写 <id>/.agent.md 并立刻同步进花名册）",
								onMouseDown: (e) => {
									try { e.preventDefault(); } catch { /* 忽略 */ }
									// ⚠ 延后一批：全局"点外面关菜单"监听的是 document 的 mousedown(capture)，
									//   它和这里在同一批更新里（菜单卸载 + 表单挂载）实测出现过
									//   "state 已写入、DOM 没跟上"（fiber 里 botsNew={kind:'bot'} 但页面上没有表单）。
									//   拆成两个批次后互不干扰。
									try { window.setTimeout(() => openBotsNew("bot"), 0); } catch { openBotsNew("bot"); }
								},
							}, "新建 Bot…")) : null,
						// ★ 2026-11-02：「新建 Bot / 新建群聊」表单（＋ 的主语义）
						botsNew ? (() => {
							const f = botsNew;
							const isBot = f.kind === "bot";
							const existingIds = (bots.agents || []).map((a) => String((a && a.id) || "")).filter(Boolean);
							const idValue = String(f.id || "").trim() || slugOfName(f.name);
							const idErrs = validateBotDraft({ name: f.name, id: idValue }, existingIds);
							const idOk = isBot && !!String(f.name || "").trim() && !!idValue && idErrs.length === 0;
							const modeOpt = GROUP_MODE_OPTIONS.filter((m) => m.id === (f.mode || "mentions"))[0] || GROUP_MODE_OPTIONS[1];
							const memberPool = (regAll.length ? regAll : list);
							const mq = String(f.memberQuery || "").trim().toLowerCase();
							const memberShown = mq ? memberPool.filter((a) => String(a.name || a.id).toLowerCase().indexOf(mq) >= 0) : memberPool;
							const picked = f.members || [];
							/** 一行「label + 计数 + input」（三个文本字段共用，避免抄三遍）。 */
							const field = (label, max, key, placeholder) => react.createElement("div", { style: S.botsFormField },
								react.createElement("div", { style: S.botsFormFieldHead },
									react.createElement("span", { style: S.botsFormLabel }, label),
									max ? react.createElement("span", { style: S.botsFormCounter }, String(f[key] || "").length + "/" + max) : null),
								react.createElement("input", {
									// ⚠ 键是动态的 ⇒ 必须用**计算属性**（`"a" + key: 1` 是语法错误）
									["data-vssaros-bots-new-" + key]: "1",
									autoFocus: key === "name",
									maxLength: max || undefined,
									style: S.botsFormInput,
									value: f[key] || "",
									placeholder,
									onChange: (e) => setBotsNew(Object.assign({}, f, { [key]: e.target.value, error: "" })),
									onKeyDown: (e) => { if (e.key === "Enter") { submitBotsNew(); } if (e.key === "Escape") { setBotsNew(null); } },
								}));
							return react.createElement("div", {
								"data-vssaros-bots-new": f.kind,
								style: Object.assign({}, S.botsForm, { maxHeight: "min(76vh, 600px)" }),
								// 点面板内部不该被"点外面关菜单"那套逻辑牵连（面板本来就不自动关闭）
								onMouseDown: (e) => { try { e.stopPropagation(); } catch { /* 忽略 */ } },
							},
								react.createElement("div", { style: S.botsFormHead },
									react.createElement("span", { style: S.botsFormHeadT }, isBot ? "新建 Bot" : "新建群聊"),
									react.createElement("button", {
										type: "button", style: S.botsFormClose, title: "关闭（Esc）", "aria-label": "关闭",
										"data-act": "new-close", onClick: () => setBotsNew(null),
									}, "✕")),
								react.createElement("div", { style: S.botsFormBody },
									field("名称 *", 80, "name", isBot ? "例如 代码审阅员" : "例如 需求评审群"),
									isBot ? react.createElement(react.Fragment, null,
										react.createElement("div", { style: S.botsFormField },
											react.createElement("div", { style: S.botsFormFieldHead },
												react.createElement("span", { style: S.botsFormLabel }, "id *（英文目录名）"),
												idOk
													? react.createElement("span", { style: S.botsFormOk, "data-vssaros-bots-id-ok": "1" }, "✓ 可用")
													: react.createElement("span", { style: S.botsFormBad, "data-vssaros-bots-id-bad": "1" },
														idValue ? (idErrs[0] || "").replace(/^id /, "") : "留空则从名称生成")),
											react.createElement("input", {
												style: S.botsFormInput, value: f.id || "", maxLength: 64,
												placeholder: slugOfName(f.name) || "code-reviewer",
												"data-vssaros-bots-new-id": "1",
												onChange: (e) => setBotsNew(Object.assign({}, f, { id: e.target.value, error: "" })),
												onKeyDown: (e) => { if (e.key === "Enter") { submitBotsNew(); } if (e.key === "Escape") { setBotsNew(null); } },
											})),
										field("角色", 40, "role", "例如 代码审阅"),
										field("描述", 200, "description", "一句话说明它擅长什么"),
										react.createElement("div", { style: S.botsFormField },
											react.createElement("span", { style: S.botsFormLabel }, "图标"),
											react.createElement("div", { style: S.botsFormIcons, "data-vssaros-bots-icons": "1" },
												BOT_ICON_PRESETS.map((ic) => react.createElement("button", {
													key: "ic:" + ic, type: "button", title: ic,
													"data-act": "icon:" + ic,
													style: Object.assign({}, S.botsFormIconBtn, (f.icon || BOT_ICON_PRESETS[0]) === ic ? S.botsFormIconOn : null),
													onClick: () => setBotsNew(Object.assign({}, f, { icon: ic })),
												}, /^lucide:/.test(ic) ? "🤖" : ic)))))
									: react.createElement(react.Fragment, null,
										react.createElement("div", { style: S.botsFormField },
											react.createElement("span", { style: S.botsFormLabel }, "唤醒策略"),
											react.createElement("div", { style: S.botsFormModeRow, "data-vssaros-bots-modes": "1" },
												GROUP_MODE_OPTIONS.map((m) => react.createElement("button", {
													key: "mode:" + m.id, type: "button", title: m.hint,
													"data-act": "mode:" + m.id,
													style: Object.assign({}, S.botsFormModeBtn, (f.mode || "mentions") === m.id ? S.botsFormModeOn : null),
													onClick: () => setBotsNew(Object.assign({}, f, { mode: m.id })),
												}, m.label))),
											react.createElement("div", { style: S.botsFormTip }, modeOpt.hint)),
										react.createElement("div", { style: S.botsFormField },
											react.createElement("div", { style: S.botsFormFieldHead },
												react.createElement("span", { style: S.botsFormLabel }, "成员 *（已选 " + picked.length + "）"),
												react.createElement("span", { style: S.botsFormTools },
													react.createElement("button", {
														type: "button", style: S.botsFormMini, "data-act": "members-all",
														onClick: () => setBotsNew(Object.assign({}, f, { members: memberPool.map((a) => a.id) })),
													}, "全选"),
													react.createElement("button", {
														type: "button", style: S.botsFormMini, "data-act": "members-none",
														onClick: () => setBotsNew(Object.assign({}, f, { members: [] })),
													}, "清空"))),
											react.createElement("input", {
												style: S.botsFormInput, value: f.memberQuery || "", placeholder: "搜索成员…",
												"data-vssaros-bots-member-query": "1",
												onChange: (e) => setBotsNew(Object.assign({}, f, { memberQuery: e.target.value })),
											}),
											react.createElement("div", { style: S.botsFormMembers, "data-vssaros-bots-new-members": "1" },
												memberShown.length === 0
													? react.createElement("div", { style: S.botsFormTip }, "没有匹配的成员")
													: memberShown.map((a) => {
														const on = picked.indexOf(a.id) >= 0;
														return react.createElement("label", { key: "mem:" + a.id, style: S.botsFormMemRow },
															react.createElement("input", {
																type: "checkbox", checked: on,
																"data-vssaros-bots-new-member": a.id,
																onChange: () => setBotsNew((b) => {
																	const cur2 = b || f;
																	const mem = (cur2.members || []).slice();
																	const at = mem.indexOf(a.id);
																	if (at >= 0) { mem.splice(at, 1); } else { mem.push(a.id); }
																	return Object.assign({}, cur2, { members: mem, error: "" });
																}),
															}),
															react.createElement("span", {
																style: Object.assign({}, S.botsFormMemAv, { background: a.color || "var(--dsw-alias-bg-layer-3, #3d3d3d)" }),
															}, String(a.name || a.id).slice(0, 1)),
															react.createElement("span", null, a.name || a.id));
													})))),
									// ── 预览（两套都显示；用户输入时立刻反映，像真的卡片）──
									react.createElement("div", { style: S.botsFormPreview, "data-vssaros-bots-preview": "1" },
										react.createElement("span", { style: S.botsFormPreviewAv },
											isBot ? (/^lucide:/.test(f.icon || "") ? "🤖" : (f.icon || "🤖")) : "👥"),
										react.createElement("span", { style: S.botsFormPreviewMain },
											react.createElement("span", { style: S.botsFormPreviewName },
												String(f.name || "").trim() || (isBot ? "未命名 Bot" : "未命名群聊")),
											react.createElement("span", { style: S.botsFormPreviewMeta },
												isBot
													? ([String(f.role || "").trim(), String(f.description || "").trim()].filter(Boolean).join(" · ") || idValue || "—")
													: (picked.length + " 成员 · " + modeOpt.label))))),
									f.error ? react.createElement("div", { style: S.botsFormErr, "data-vssaros-bots-new-error": "1" }, f.error) : null),
								react.createElement("div", {
									style: Object.assign({}, S.botsFormRow, { paddingTop: 8, borderTop: "1px solid var(--dsw-alias-border-l1, #3a3a3a)" }),
								},
									react.createElement("button", {
										type: "button", style: S.botsFormBtn, "data-act": "new-cancel",
										onClick: () => setBotsNew(null),
									}, "取消"),
									react.createElement("button", {
										type: "button", "data-act": "new-submit", disabled: f.busy === true,
										style: Object.assign({}, S.botsFormBtn, S.botsFormBtnPrimary, f.busy ? { opacity: .7 } : null),
										onClick: () => submitBotsNew(),
									}, f.busy ? "创建中…" : (isBot ? "创建 Bot" : "创建群聊")));
						})() : null);
				};
				const tabBar = react.createElement("div", { style: S.tabBar, role: "tablist", "data-vssaros-sidebar-tabs": "1" },
					["sessions", "bots"].map((k) => react.createElement("button", {
						key: k, type: "button", role: "tab", "data-vssaros-sidebar-tab": k,
						"aria-selected": view === k ? "true" : "false",
						// ★ 2026-11-02 二次：选中态交给 CSS（`[data-on="1"]`）—— 需要 :hover 参与，
						//   内联 style 表达不了；这里只保留尺寸。
						className: "vssaros-ws-tab",
						"data-on": view === k ? "1" : "0",
						style: S.tabBtn,
						title: k === "sessions" ? "工作区与会话（现状不变）" : "Bot 名册与群聊",
						onClick: () => switchView(k),
					}, k === "sessions" ? "会话" : "Bots")));

				// 「会话」页签 = **原来的整块内容**（工作区头 + 会话树 + 各种菜单），一个字没改。
				const sessionsPane = react.createElement("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" } },
					react.createElement("div", { style: S.head },
						// 2026-10-18：与官方中文 UI 对齐（此前写死英文 `Workspaces`，弹窗里和
				// 「新会话 / 插件 / 自动化任务」并排显得割裂 ✓）
				// ★ 2026-11-02：标题 hover 显示当前界面版本尾段 —— 排查"看不到新功能"时，
				//   第一件事就是确认这个窗口跑的是不是旧 chunk（本次 bug 就是这么定位的）。
				react.createElement("span", {
					style: S.headT,
					title: (function () {
						try { return "界面版本：" + String(window.__vssarosChatSurfaceBuild || "(未知)").slice(-30); } catch { return ""; }
					})(),
				}, "工作区"),
						withSearch ? react.createElement("button", { style: S.iconBtn, title: "搜索工作区 / 会话", "aria-label": "搜索工作区 / 会话", onClick: () => setSearchOn(!searchOn) }, "🔍") : null,
						// ★ 用 ASCII "+"：原来的全角「＋」(U+FF0B) 在某些渲染环境**没有字形**
						//   ⇒ 界面上是一个豆腐块（用户截图里那个方框就是它）⇒ 点了像"没反应" ✓
						// ★ 2026-10-26：它现在是一个**菜单**（两个动作：加单目录 / 从 .code-workspace 导入多根）。
						react.createElement("button", {
							style: Object.assign({}, S.iconBtn, { fontSize: 14, fontWeight: 600, minWidth: 18, textAlign: "center" }),
							title: "添加工作区…", "aria-label": "添加工作区", "aria-haspopup": "true",
							onClick: (e) => {
								try {
									const rect = e.currentTarget.getBoundingClientRect();
									// fixed 定位（不用 absolute）：侧栏列可能有 overflow ⇒ 绝对定位会被裁掉 ✗
									const w = typeof window !== "undefined" ? window.innerWidth : 0;
									const h = typeof window !== "undefined" ? window.innerHeight : 0;
									let x = rect.left - 180;
									let y = rect.bottom + 4;
									if (w > 0) { x = Math.max(8, Math.min(x, w - 220)); }
									if (h > 0) { y = Math.max(8, Math.min(y, h - 90)); }
									setMenu({ x, y });
								} catch { setMenu(null); }
							},
						}, "+"),
					),
					// ＋ 菜单本体（fixed 定位 ⇒ 不被侧栏的 overflow 裁掉 ✓）
					menu ? react.createElement("div", {
						"data-vssaros-ws-menu": "1",
						style: {
							position: "fixed", left: menu.x, top: menu.y, zIndex: 70, minWidth: 210, padding: "4px",
							borderRadius: 8, background: "var(--dsw-alias-bg-layer-2, #262626)",
							border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
							boxShadow: "0 12px 32px rgba(0,0,0,.5)", color: "var(--dsw-alias-label-primary, #e6e6e6)",
						},
					},
						react.createElement("button", {
							style: S.menuItem,
							onClick: () => { setMenu(null); addWorkspace(setWsMsg); },
						}, "添加工作区（单个目录）"),
						react.createElement("button", {
							style: S.menuItem,
							title: bridge && typeof bridge.importCodeWorkspace === "function" ? "" : "当前环境没有宿主桥，无法选 .code-workspace 文件",
							onClick: () => { setMenu(null); importCodeWorkspace(setWsMsg); },
						}, "从 .code-workspace 导入（多根）"),
					) : null,
					// ★ 2026-10-26：＋ 的成败**就地可见**（窗口模式没有宿主桥 ⇒ notify 是空转）
					wsMsg ? react.createElement("div", {
						style: {
							fontSize: 11, lineHeight: "1.5", padding: "2px 8px 4px", whiteSpace: "normal",
							color: wsMsg.kind === "error" ? "#f48771" : "var(--dsw-alias-label-tertiary, #737373)",
						},
					}, wsMsg.text) : null,
					// 空会话已隐藏 ⇒ 说清数量（不装作没有）
					hiddenBlanks > 0 ? react.createElement("div", {
						style: { fontSize: 10.5, padding: "0 8px 3px", color: "var(--dsw-alias-label-tertiary, #737373)" },
					}, "已隐藏 " + hiddenBlanks + " 条空会话") : null,
					// ★ 2026-10-29：会话行操作的**就地反馈**（窗口模式没有宿主桥 ⇒ 唯一可见通道）
					sessMsg ? react.createElement("div", {
						style: Object.assign({}, S.sessMsg, {
							color: sessMsg.kind === "error" ? "#f48771" : "var(--dsw-alias-label-tertiary, #737373)",
						}),
					}, sessMsg.text) : null,
					searchOn && withSearch ? react.createElement("input", {
						style: S.search, placeholder: "搜索工作区 / 会话…", value: query,
						onChange: (e) => setQuery(e.target.value),
					}) : null,
					react.createElement("div", { style: S.list },
						shown.length === 0 ? react.createElement("div", { style: { padding: "10px 8px", fontSize: 12, color: "var(--dsw-alias-label-tertiary, #737373)" } }, "暂无工作区") : null,
						shown.map((row) => {
							if (row.kind === "group") {
								// ⚠ 折叠键仍是 **record.id**（历史持久化键，改了用户折叠态全丢 ✗）；React key 用 row.key
								const key = row.record.id;
								const isOpen = collapsed[key] !== true;
								return react.createElement("div", { key: row.key || ("rec:" + key) },
									// ★ 2026-11-02（对齐官方 `.projectRow`）：默认 **folder 图标**、hover 换**三角箭头**
									//   （官方 CSS：`.projectRow .chevron{display:none}` + `:hover .chevron{inline-flex}` +
									//   `:hover .folder{display:none}`）；「N 个根」徽标移到 hover 卡片里（官方行没有徽标 ✗）。
									react.createElement("div", {
										className: "vssaros-ws-project",
										role: "treeitem",
										"aria-expanded": isOpen,
										// 官方锚点（`data-row-key="workspace:<key>"`）
										"data-row-key": "workspace:" + key,
										onClick: () => setCollapsed(nextCollapsed(collapsed, key)),
										onMouseEnter: (e) => openHover(key, e),
										onMouseLeave: closeHover,
									},
										react.createElement("span", { className: "vssaros-ws-slot2 vssaros-ws-folder", "aria-hidden": "true" }, folderIcon()),
										react.createElement("span", { className: "vssaros-ws-slot2 vssaros-ws-chevron", "aria-hidden": "true" }, chevronIcon(isOpen)),
										react.createElement("span", { className: "vssaros-ws-projtitle" }, row.record.name),
										// 官方 `.rowActions`：默认隐藏，hover 才出现（CSS 控制）
										react.createElement("span", { className: "vssaros-ws-actions" },
											// ★ 2026-11-02（用户要求）：hover 时在 ⋯ 左边给一个 **+** —— 在此工作区新建会话
											react.createElement("button", {
												type: "button", className: "vssaros-ws-icon", title: "在此工作区新建会话",
												"aria-label": "在此工作区新建会话（" + row.record.name + "）",
												"data-vssaros-ws-row-new-session": key,
												onClick: (e) => {
													try { e.preventDefault(); e.stopPropagation(); } catch { /* 合成事件 */ }
													closeHover();
													newSessionInWorkspace(row.record, row.record.name);
													},
													}, plusIcon()),
											react.createElement("button", {
												type: "button", className: "vssaros-ws-icon", title: "工作区操作",
												"aria-label": "工作区操作（" + row.record.name + "）", "aria-haspopup": "true",
												"data-vssaros-ws-row-actions": key,
												onClick: (e) => openWsMenu(key, e, row.record.name),
											}, "⋯")),
									),
									isOpen ? renderSessions(row) : null,
								);
							}
							// 回落：未被 IDE 记录认领的 dsh 条目，平铺（与官方形态一致 ✓）
							const key = "flat:" + row.label;
							const isOpen = collapsed[key] !== true;
							return react.createElement("div", { key: row.key || key },
								// 回落分支（未被 IDE 记录认领的 dsh 条目）同样按官方 `.projectRow` 画
								react.createElement("div", {
									className: "vssaros-ws-project",
									role: "treeitem",
									"aria-expanded": isOpen,
									"data-row-key": "workspace:" + key,
									onClick: () => setCollapsed(nextCollapsed(collapsed, key)),
								},
									react.createElement("span", { className: "vssaros-ws-slot2 vssaros-ws-folder", "aria-hidden": "true" }, folderIcon()),
									react.createElement("span", { className: "vssaros-ws-slot2 vssaros-ws-chevron", "aria-hidden": "true" }, chevronIcon(isOpen)),
									react.createElement("span", { className: "vssaros-ws-projtitle" }, row.label),
									react.createElement("span", { className: "vssaros-ws-actions" },
										// 回落行同样给「+」（路径取 `row.path`，没有就明确提示，不猜）
										react.createElement("button", {
											type: "button", className: "vssaros-ws-icon", title: "在此工作区新建会话",
											"aria-label": "在此工作区新建会话（" + row.label + "）",
											"data-vssaros-ws-row-new-session": key,
											onClick: (e) => {
												try { e.preventDefault(); e.stopPropagation(); } catch { /* 合成事件 */ }
												closeHover();
												newSessionInWorkspace(row, row.label);
											},
										}, plusIcon()),
										react.createElement("button", {
											type: "button", className: "vssaros-ws-icon", title: "工作区操作",
											"aria-label": "工作区操作（" + row.label + "）", "aria-haspopup": "true",
											"data-vssaros-ws-row-actions": key,
											onClick: (e) => openWsMenu(key, e, row.label),
										}, "⋯")),
								),
								isOpen ? renderSessions(row) : null,
							);
						}),
					),
					// ★ 2026-11-02：工作区行 ⋯ 菜单（官方 `.rowActions` 那枚；只做不破坏数据的三项）
					wsMenu ? react.createElement("div", {
						"data-vssaros-ws-row-menu": "1",
						style: Object.assign({}, S.sessMenu, { left: wsMenu.x, top: wsMenu.y }),
					},
						react.createElement("div", {
							style: { padding: "3px 9px 5px", fontSize: 10.5, color: "var(--dsw-alias-label-tertiary, #737373)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 },
						}, wsMenu.label || wsMenu.key),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "toggle", style: S.menuItem,
							onClick: () => { const k = wsMenu.key; setWsMenu(null); setCollapsed(nextCollapsed(collapsed, k)); },
						}, "折叠 / 展开"),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "collapse-all", style: S.menuItem,
							onClick: () => {
								const next = {};
								for (const k of allGroupKeys()) { next[k] = true; }
								setWsMenu(null); setCollapsed(next);
							},
						}, "全部折叠"),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "expand-all", style: S.menuItem,
							onClick: () => { setWsMenu(null); setCollapsed({}); },
						}, "全部展开"),
						// ★ 2026-11-02（用户要求）：移除工作区 —— 走官方 `workspaces.delete`
						//   （注释原文 "Remove one Workspace registration while retaining files and Sessions"
						//    ⇒ **只摘登记**，会话与磁盘文件都保留，重新添加即恢复 ⇒ 可逆）。
						//
						//   ⚠ 不放"再点一次确认"的两步态：真机实测第一次点击后菜单**没重渲染**
						//   （`confirmRemove` 写进去了但文本不变），会造成"点了没反应"。既然操作可逆、
						//   且提示里会说明"会话与文件都保留"，直接执行 + 事后说明更符合预期。
						react.createElement("div", { style: { height: 1, margin: "4px 6px", background: "var(--dsw-alias-border-l1, #3a3a3a)" } }),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "remove-ws",
							style: S.menuItem,
							title: "从 dsh 移除这个工作区（只摘登记；会话与磁盘文件都保留，可随时再加回来）",
							onClick: () => {
								const k = wsMenu.key;
								setWsMenu(null);
								removeWorkspace(k);
							},
						}, "移除工作区"),
						// 恢复入口：隐藏是**持久**的（localStorage），没有这个入口用户只能清缓存才找得回
						wsRemoved.length ? react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "restore-ws", style: S.menuItem,
							title: "把所有「已移除」的工作区重新显示出来",
							onClick: () => {
								const n = wsRemoved.length;
								setWsMenu(null);
								setWsRemoved([]);
								say("已恢复显示 " + n + " 个被移除的工作区", "note");
							},
						}, "恢复已移除的工作区（" + wsRemoved.length + "）") : null,
						// ★★ 2026-11-02（用户报「左侧栏又看不到会话/Bots 页签了」）：
						//   根因**不是**代码 —— 是那个窗口还跑着部署前的 chunk（页面不会自动跟随插件更新，
						//   `?rev` 变了但已加载的页面不会自己重载）。真机复现：同一个 app 里 IDE 那侧有页签、
						//   desktop 窗口没有；CDP `Page.reload` 之后立刻出现 ✓。
						//   ⇒ 给一个**用户可控**的重载入口（不自动 reload：会打断正在跑的对话 ✗）。
						react.createElement("div", { style: { height: 1, margin: "4px 6px", background: "var(--dsw-alias-border-l1, #3a3a3a)" } }),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "backfill-titles", style: S.menuItem,
							title: "把标题仍是「未命名」的会话，按首条用户消息补上标题（写回 dsh，官方侧栏也会显示）",
							onClick: () => { setWsMenu(null); backfillTitles(); },
						}, "补全会话标题"),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "copy-diag", style: S.menuItem,
							title: "复制当前侧栏的诊断信息（版本 / 注册状态 / 槽里是谁 / 事件链）",
							onClick: () => { setWsMenu(null); copyPlain(diagText(), say, "已复制诊断信息（直接发出来即可）"); },
						}, "复制诊断信息"),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "reload-ui", style: S.menuItem,
							title: "插件更新后页面不会自动刷新，点这里重载界面",
							onClick: () => { setWsMenu(null); try { window.location.reload(); } catch { /* 无 window */ } },
						}, "重载界面"),
					) : null,
					// ★ 2026-10-29：会话右键菜单（fixed + 已夹进视口；与 ＋ 菜单共用"点外面 / Esc 关闭"）
					sessMenu ? react.createElement("div", {
						"data-vssaros-sess-menu": "1",
						style: Object.assign({}, S.sessMenu, { left: sessMenu.x, top: sessMenu.y }),
					},
						react.createElement("div", {
							style: { padding: "3px 9px 5px", fontSize: 10.5, color: "var(--dsw-alias-label-tertiary, #737373)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 },
						}, (findSession(sessMenu.sid) || {}).title || sessMenu.sid),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "pin", style: S.menuItem,
							onClick: () => menuAction("pin"),
						}, sessMenu.pinned ? "取消置顶" : "置顶"),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "rename", style: S.menuItem,
							onClick: () => menuAction("rename"),
						}, "重命名"),
						// ★ 2026-11-02：未读标记（官方行没有菜单项可切，靠本地集合）——
						//   它在「重命名」之后、"复制/归档"之前：属于"对这条会话本身"的一组动作 ✓
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "unread", style: S.menuItem,
							onClick: () => menuAction("unread"),
						}, sessMenu.unread ? "标为已读" : "标为未读"),
						react.createElement("div", { style: { height: 1, margin: "4px 6px", background: "var(--dsw-alias-border-l1, #3a3a3a)" } }),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "copy", style: S.menuItem,
							onClick: () => menuAction("copy"),
						}, "复制会话 id"),
						// ★ 2026-11-02（降维护）：对齐官方 `ForkSessionMenuItem` 的那一项。
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "fork", style: S.menuItem,
							onClick: () => menuAction("fork"),
						}, "分叉出一条新会话"),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "archive", style: S.menuItem,
							onClick: () => menuAction("archive"),
						}, "归档"),
						// ★ 2026-10-30（用户要求「menu 中增加删除按钮」）：归档 ≠ 删除 ——
						//   归档只是从列表移除（数据仍在、可找回），删除是真删磁盘（不可恢复）⇒ 两者并列。
						react.createElement("div", { style: { height: 1, margin: "4px 6px", background: "var(--dsw-alias-border-l1, #3a3a3a)" } }),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "delete", style: Object.assign({}, S.menuItem, { color: "#f48771" }),
							onClick: () => menuAction("delete"),
						}, "删除会话…"),
					) : null,
					// ★ 2026-10-30：删除的**二次确认**层（真删不可恢复；归档那条不弹）
					confirmDel ? react.createElement("div", {
						"data-vssaros-sess-confirm": "1",
						style: {
							position: "fixed", left: "50%", top: "38%", transform: "translate(-50%, -50%)",
							zIndex: 90, width: 344, padding: "14px 14px 12px", borderRadius: 12,
							background: "var(--dsw-alias-bg-layer-2, #262626)",
							border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
							boxShadow: "0 24px 60px rgba(0,0,0,.65)",
							color: "var(--dsw-alias-label-primary, #e6e6e6)",
						},
					},
						react.createElement("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, "删除这条会话？"),
						react.createElement("div", {
							style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #a3a3a3)", marginBottom: 8, wordBreak: "break-all" },
						}, confirmDel.title),
						react.createElement("div", {
							style: { fontSize: 11.5, lineHeight: "1.65", color: "var(--dsw-alias-label-tertiary, #737373)", marginBottom: 12 },
						},
							"会永久删除这条会话的本地数据（对话记录 + 列表缓存），不可恢复。",
							react.createElement("br"),
							"只想让它从列表消失、数据留着 ⇒ 用「归档」。",
						),
						react.createElement("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
							react.createElement("button", {
								type: "button", "data-act": "cancel", style: S.confirmBtn,
								onClick: () => setConfirmDel(null),
							}, "取消"),
							react.createElement("button", {
								type: "button", "data-act": "confirm", style: Object.assign({}, S.confirmBtn, S.confirmDanger),
								onClick: () => {
									const cur = confirmDel;
									setConfirmDel(null);
									deleteSessionForever(cur.sid, say);
								},
							}, "删除"),
						),
					) : null,
					hover && (() => {
						const row = rows.filter((r2) => r2.kind === "group" && r2.record.id === hover.key)[0];
						return row ? react.createElement(HoverCard, { record: row.record, sessions: row.sessions, currentRootPath, x: hover.x, y: hover.y }) : null;
					})(),
					// ★ 2026-11-02（补上官方 `SessionNodeItem` 的最后一块交互）：**会话行 hover 卡片**。
					//   官方内容 = 完整标题（14/20 可换行）+ 相对时间（12/16）+ 每条状态（12/20 + 点），
					//   并支持"复制标题"（`copyText/copyLabel/copiedLabel`）。这里额外给了根名与绝对时间。
					//   ⚠ 卡片自己也要 onMouseEnter/Leave：它贴着行，鼠标一移过去就会被行的 leave 关掉 ✗。
					sessHover && (() => {
						const cur = findSession(sessHover.sid);
						if (!cur) { return null; }
						const dot = cur.status === "running" ? Object.assign({}, S.ring, S.ringRunning)
							: cur.status === "awaiting" ? Object.assign({}, S.ring, S.ringAwaiting)
								: cur.status === "idle" ? Object.assign({}, S.ring, S.ringIdle) : S.ring;
						return react.createElement("div", {
							"data-vssaros-sess-hover": "1",
							role: "tooltip",
							style: Object.assign({}, S.sessHoverCard, { left: sessHover.x, top: sessHover.y }),
							onMouseEnter: () => { if (sessHoverTimer.current) { clearTimeout(sessHoverTimer.current); sessHoverTimer.current = null; } },
							onMouseLeave: closeSessHover,
						},
							react.createElement("div", { style: S.sessHoverTitle }, cur.title),
							react.createElement("div", { style: S.sessHoverTime },
								timeLabel(cur.at) + (absTimeLabel(cur.at) ? " · 创建于 " + absTimeLabel(cur.at) : "")),
							cur.rootName ? react.createElement("div", { style: S.sessHoverPath }, "根：" + cur.rootName) : null,
							// 会话 id 从行上的原生 title 搬到这里（行 title 会与卡片形成两个浮层 ✗）
							react.createElement("div", { style: Object.assign({}, S.sessHoverPath, { opacity: .8 }) }, cur.id),
							react.createElement("div", { style: S.sessHoverStatus },
								react.createElement("span", { style: dot, "aria-hidden": "true" }),
								react.createElement("span", null, RING_LABEL[cur.status] || "状态未知")),
							cur.pinned ? react.createElement("div", { style: S.sessHoverStatus }, "📌 已置顶") : null,
							react.createElement("button", {
								type: "button", "data-act": "copy-title", style: S.sessHoverCopy, title: "复制标题",
								onClick: (e) => {
									try { e.stopPropagation(); } catch { /* 忽略 */ }
									copyPlain(cur.title, say, "已复制标题");
								},
							}, "复制标题"));
					})(),
				);
				// 外层：页签条常驻，两个页签**互斥渲染**（在 Bots 页签时不渲染工作区树 ⇒ 不白跑）。
				return react.createElement("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" } },
					tabBar,
					view === "bots" ? botsPane() : sessionsPane);
			}

			// 遮蔽官方 WorkspaceBrowser（升序取最低 priority 渲染；同 hero.workspace 的 -10 先例 ✓）。
			try {
				// ★ 状态灯的脉动动效（一次性、幂等；见 ensureRingStyle 的注释）。
				//   ⚠ 必须放在这里而不是 install 顶部：`ensureRingStyle` 是与 `S` 一起声明的
				//   `const`，在本作用域**下方** ⇒ 提前调用会吃掉 TDZ（Cannot access before initialization）。
				ensureRingStyle();
				// ★ 2026-11-05：Bots 行的 DS Bot 状态动画（同样必须在 S 之后调，避免 TDZ）。
				ensureBotStateStyle();
				// ★ 2026-11-02：会话行的官方数值（32px 行 / 14px 标题 / 悬停才出行尾动作…）
				//   ⚠ 同样必须在 `S` 之后调（TDZ），放在这里与 ensureRingStyle 并列 ✓
				ensureRowStyle();
				// ── 默认工作区（2026-11-02 用户要求「初始安装启动时应该默认显示一个工作区」）──────
				//
				// ★★ 第二轮修正（用户报「当前工作区中，缺少 默认工作区」）：
				//   第一版只在 `items.length === 0` 时调官方 `workspaces.initializeDefault()`——
				//   但官方语义是"**首次使用**"：机器上已有任何工作区时它直接返回 `undefined`（实测），
				//   所以已有工作区的机器永远等不到这个默认工作区 ✗。
				//
				//   现在改成**自己确保**（幂等，按路径判断）：
				//     ① 宿主 `POST /api/default-workspace` ⇒ `mkdir -p <DSH_HOME>/VsSaros` 并返回该路径
				//        （`workspaces.create` 只接受已存在的绝对路径，而页面建不了目录）；
				//     ② `workspaces.create({ path })`（官方"添加工作区"同一条链）；
				//     ③ **已有同路径的工作区就跳过** ⇒ 用户删掉它后下次启动会重新补上，不会重复添加。
				//
				//   仍只发起一次（`tried`），且必须等快照 `ready`（pending 时判断会误判）。
				const ensureDefaultWorkspace = (() => {
					let tried = false;
					return () => {
						if (tried) { return; }
						try {
							const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : null;
							if (!ws || typeof ws.create !== "function") { return; }
							const snap = ws.list && typeof ws.list.getSnapshot === "function" ? ws.list.getSnapshot() : null;
							if (!snap || snap.phase !== "ready") { return; }
							tried = true;
							try { wsLog("default-workspace", { phase: "start" }); } catch { /* 诊断 */ }
							let p;
							try {
								p = Promise.resolve(fetch(DEFAULT_WS_API, {
									method: "POST",
									headers: { accept: "application/json" },
								})).then((r) => Promise.resolve(r.json().catch(() => null)).then((j) => {
									if (!r.ok || !j || j.ok !== true || typeof j.path !== "string" || !j.path) {
										throw new Error((j && j.error) || ("HTTP " + r.status));
									}
									return j.path;
								}));
							} catch (e) { p = Promise.reject(e); }
							void p.then((dir) => {
								// 已有同路径的工作区 ⇒ 什么都不做（幂等；也是"用户删了再补"的判据）
								const items = (ws.list.getSnapshot() || {}).items || [];
								const exists = items.some((it) => it && samePath(it.path, dir));
								if (exists) {
									try { wsLog("default-workspace", { phase: "exists", path: dir }); } catch { /* 诊断 */ }
									return undefined;
								}
								return Promise.resolve(ws.create({ path: dir })).then((created) => {
									const id = created && (created.workspaceId
										|| (created.workspace && created.workspace.workspaceId));
									try {
										wsLog("default-workspace", { phase: "created", path: dir, id: id ? String(id) : null });
									} catch { /* 诊断 */ }
								});
							}).catch((e) => {
								try { wsLog("default-workspace", { phase: "fail", message: String((e && e.message) || e) }); } catch { /* 诊断 */ }
							});
						} catch { /* 默认工作区失败不影响任何其它功能 */ }
					};
				})();
				try {
					ctx.effect(() => {
						ensureDefaultWorkspace();
						const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : null;
						const off = (ws && ws.list && typeof ws.list.subscribe === "function")
							? ws.list.subscribe(() => ensureDefaultWorkspace())
							: null;
						return () => { try { if (typeof off === "function") { off(); } } catch { /* 已释放 */ } };
					}, "vssaros-chat-surface: default workspace");
				} catch { /* 没有 effect（测试桩）⇒ 上面已经试过一次 */ }
				// ★ 诊断（2026-11-02）：把"槽能力 / 注册是否真的成功"记下来 —— desktop 窗口里
				//   官方 UI 照旧渲染时，先看这三项就能判断是 inject 没生效还是 register 被忽略。
				/**
				 * 700ms 后自检：`sidebar.workspaces` 槽里**到底是谁**。
				 * 这一步是本次定位的关键 —— "注册没抛错"与"真的渲染进槽"是两件事 ✗。
				 */
				/**
				 * dump 槽内部条目表（`SlotCore.records`：`Map<name, {spec, entries}>`）。
				 * 条目 = `{ options: { id, priority, registrant, order } }` ⇒ 一眼看出
				 * "槽里有几个注册者、谁排第一、我们到底在不在里面"。
				 *
				 * ⚠⚠ **必须在注册之后调用**：第一版把这段放在 `register` 之前 ⇒ dump 出来只有官方
				 *   那一条（priority 0），看起来像"我们没注册" —— 纯粹是取样时机错 ✗（已踩）。
				 */
				const dumpSlotEntries = () => {
					try {
						const slots = ctx.slots || {};
						const core = slots._core;
						if (core && core.records && typeof core.records.get === "function") {
							const rec = core.records.get(SLOT);
							state.workspacesSlotEntries = rec && Array.isArray(rec.entries)
								? {
									kind: rec.spec && rec.spec.kind,
									count: rec.entries.length,
									list: rec.entries.map((e) => ({
										id: (e.options && e.options.id) || "",
										priority: e.options && e.options.priority !== undefined ? e.options.priority : 0,
										registrant: (e.options && e.options.registrant) || "",
										order: e.options && e.options.order !== undefined ? e.options.order : null,
									})),
								}
								: { kind: rec && rec.spec && rec.spec.kind, count: 0, list: [], note: "records 里没有该槽" };
						} else {
							state.workspacesSlotEntries = { count: -1, note: "拿不到 _core.records" };
						}
					} catch (e) {
						state.workspacesSlotEntries = { count: -1, note: "读条目表失败：" + String((e && e.message) || e) };
					}
					wsLog("slots-entries", state.workspacesSlotEntries || {});
				};
				const scheduleSlotSelfCheck = () => {
					try {
						if (typeof window === "undefined" || typeof document === "undefined") { return; }
						window.setTimeout(() => {
							try {
								const slot = document.querySelector('[data-slot="sidebar.workspaces"]');
								const first = slot && slot.firstElementChild ? String(slot.firstElementChild.className || "") : "";
								const info = {
									hasSlot: !!slot,
									firstClass: first.slice(0, 100),
									ourTabBar: !!document.querySelector("[data-vssaros-sidebar-tabs]"),
									ourRows: document.querySelectorAll(".vssaros-ws-project").length,
									officialRows: document.querySelectorAll('[class*="projectRow"]').length,
									renderTick: state.workspacesRenderTick === undefined ? null : state.workspacesRenderTick,
									wide: state.workspacesWide === undefined ? null : state.workspacesWide,
								};
								state.workspacesSlotCheck = info;
								// 注册已完成 ⇒ 这时 dump 条目表才有第二个注册者（第一版取样过早，只看到官方）
								dumpSlotEntries();
								// 槽里没我们的东西（连 tabBar 都没有）⇒ 就是"被别的占位者赢了 / 注册没落槽"
								wsLog((info.ourTabBar || info.ourRows > 0) ? "slot-ok" : "slot-mismatch", info);
							} catch (e) {
								wsLog("error", { where: "slot-check", message: String((e && e.message) || e) });
							}
						}, 700);
					} catch { /* 忽略 */ }
				};
				try {
					state.workspacesSlotInfo = {
						hasSlots: !!(ctx.slots && typeof ctx.slots.register === "function"),
						hasInject: !!(ctx.slots && typeof ctx.slots.inject === "function"),
						slotName: SLOT,
						url: (typeof location !== "undefined" ? String(location.href).slice(0, 120) : ""),
						chatOnly: (() => { try { return !!(bridge && bridge.chatOnly); } catch { return "?"; } })(),
					};
				} catch { /* 诊断失败不影响注册 */ }
				wsLog("install", state.workspacesSlotInfo || {});
				// ★★ 2026-11-02（关键探测）：dump slots 服务的 **API 面**，并尝试常见查询方法。
				//   官方规则（`dsh-client-ui-slots/lib/index.js:168-173`）：
				//     · single 槽按 priority 去重，同一 priority 重复注册**直接抛错**；
				//     · 提示语原文 `register at a different priority to shadow it (lowest renders)`
				//       ⇒ **priority 小的渲染**。
				//   我们以 -1000 注册成功（无 register-threw）、官方是 0 ⇒ 理论该赢，
				//   但 desktop 全窗里 DOM 仍是官方 `bhn1Oq_root` ⇒ 只能把槽内部**条目表**导出来看。
				//   ⚠ 这一步只读、不改变任何注册行为（探测失败就只是少一条诊断）。
				try {
					const slots = ctx.slots || {};
					const proto = Object.getPrototypeOf(slots) || {};
					state.workspacesSlotsApi = {
						own: Object.keys(slots).slice(0, 40),
						proto: Object.getOwnPropertyNames(proto).slice(0, 60),
					};
					for (const m of ["entriesOf", "entries", "snapshot", "list", "describe", "debug", "records"]) {
						if (typeof slots[m] !== "function") { continue; }
						try {
							const got = slots[m](SLOT);
							state.workspacesSlotsDump = state.workspacesSlotsDump || {};
							state.workspacesSlotsDump[m] = String(JSON.stringify(got)).slice(0, 900);
						} catch (e) {
							state.workspacesSlotsDump = state.workspacesSlotsDump || {};
							state.workspacesSlotsDump[m] = "threw: " + String((e && e.message) || e).slice(0, 160);
						}
					}
					wsLog("slots-api", state.workspacesSlotsApi);
					wsLog("slots-dump", { dump: state.workspacesSlotsDump || null });
				} catch (e) {
					wsLog("error", { where: "slots-probe", message: String((e && e.message) || e) });
				}
				// ⚠⚠ 2026-11-02：priority 从 -10 放宽到 **-1000**。
				//   slots 的排序是**升序取最前**（`dsh-client-ui-slots/lib/index.js:221`：
				//   `(a,b) => (a.options.priority ?? 0) - (b.options.priority ?? 0)`）⇒ 越小越优先。
				//   官方 `sidebar.workspaces` 注册时**不写 priority**（= 0），`dsh-client-ui-subagent`
				//   用的是 -10 ⇒ 我们与"另一个遮蔽者"同档时会退化成"谁先注册谁赢"，
				//   在 desktop 全窗（`chatOnly=0`）里实测出现过"官方 WorkspaceBrowser 仍然渲染"的现象
				//   （`ourRows:0` 而 `projectRow` 有 6 条）。取 -1000 与所有官方/第三方错开。
				ctx.slots.inject(SLOT, () => {
					wsLog("register-call", { name: SLOT, id: "vssaros-workspaces", priority: -1000 });
					let ret;
					try {
						ret = ctx.slots.register({ name: SLOT, id: "vssaros-workspaces", priority: -1000 }, Browser);
					} catch (e) {
						wsLog("register-threw", { message: String((e && e.message) || e) });
						throw e;
					}
					wsLog("register-done", { retType: typeof ret, retNull: ret === null || ret === undefined });
					return ret;
				});
				state.workspacesReplaced = true;
				wsLog("inject-done", { note: "inject 回调未触发说明槽定义没被声明/或 inject 被略过" });
				scheduleSlotSelfCheck();
				// ★ 2026-11-05：群执行浮层挂 root overlay（order 104，避开页签条 100 / hero 101 / 更新 102 / 右栏浏览器 103）
				try {
					ctx.slots.inject("shell.overlay", () => ctx.slots.register(
						{ name: "shell.overlay", id: "vssaros-group-activity", order: 104 }, GroupActivityDock));
					state.vssarosGroupActivity = true;
				} catch (e) {
					state.vssarosGroupActivityError = String((e && e.message) || e);
				}
			} catch (e) {
				state.workspacesError = String((e && e.message) || e);
				wsLog("error", { where: "install", message: state.workspacesError });
			}
		}

		exports.install = install;
		// 仅测试用：分组收敛 / 路径比较 / 时间文案的纯逻辑（插件装载只读 install）。
		exports.__test = {
			samePath, baseName, parseRecords, timeLabel, buildSidebar, rootOfSession, nextCollapsed, pickCurrentSessionId,
			// ★ 2026-10-30 对齐官方空会话口径：当前会话 = mainView retain 的那条（守卫 ⑤-k 直接断言）
			mainViewSessionId,
			// ★ 2026-10-30 会话行状态灯：四态判据 / 待回答条数（守卫真机断言，两处口径不许漂）
			sessionStatusOf, pendingQuestionsOf, RING_LABEL,
			// ★ 2026-10-29 会话行操作：置顶 / 手动顺序 / 拖放判定（守卫 check-chat-surface-chunks ⑤-f 直接断言）
			SESSION_ORDER_KEY, toIdSet, normalizeOrderMap, sortBySavedOrder, orderGroupSessions, moveWithin, canDrop,
			// ★ 2026-10-30 分页：默认条数 + 配额取条（守卫 ⑤-j 直接断言）
			SESSION_PAGE_SIZE, visibleSessions,
			// ★ 2026-11-02 未读：集合增删 / 绝对时间文案（守卫直接断言）
			toggleUnread, absTimeLabel, UNREAD_KEY,
			// ★ 2026-11-02 新建 Bot / 群聊：校验与预设（守卫直接断言）
			validateBotDraft, validateGroupDraft, BOT_ICON_PRESETS, GROUP_MODE_OPTIONS,
			// ★ 2026-11-02 侧栏「会话 / Bots」页签：默认页签 / 最近会话选取 / 取数（守卫直接断言）
			SIDEBAR_VIEW_KEY, readSidebarView, latestSessionIdOf, fetchBotsData, pickBotWorkspaceId, isRegisteredSession,
			// ★ 2026-11-05 多 bot 群聊：群行识别 / 可见与排序 / 右键菜单 7 项 / 菜单动作调度 / 「群设置」直达设置页签
			AGENTS_API_ROOMS, ROOM_PROJECTION_KEY, SETTINGS_VIEW_ID, roomMarkOf, visibleRooms, roomMenuItems, roomMenuAction, roomInitials, presetConversationView,
			// ★ 2026-11-05：@群执行后的实时反馈（全局浮层 + Bots 页签自动刷新）
			AGENTS_API_ROOMS_ACTIVE, ROOMS_CHANGED_EVENT, GROUP_PROGRESS_EVENT, GROUP_DOCK_VISIBILITY_EVENT, roomsSignature, botStateOf, roomStateOf, askUnreadTargets, botOpenTargetOf, fetchRoomsOnly, fetchRoomActivity,
			GROUP_ACTIVITY_SCHEMA, GROUP_ROUND_LABELS, groupRoundStatus, normalizeGroupActivity, activitySignature,
			// ★ 2026-11-06 前台页面声明不要「已发到…」tip（SuperAgent 工作台）
			GROUP_TIP_OFF_ATTR, groupTipSuppressed,
		};
		return module.exports;
	}
});
