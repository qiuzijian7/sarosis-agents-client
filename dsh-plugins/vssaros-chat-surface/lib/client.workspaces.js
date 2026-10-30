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
			if (!raw) { return sid; }
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
			 * **删除**一条会话：**先归档（Host 状态）、再删磁盘**。
			 *
			 * ★★ 2026-10-30（用户报「点了删除会话，对应的 item 没消失」）—— 只删磁盘是**没用**的：
			 *   侧栏的会话行来自 **`workspaces.list` 快照的 `items[].sessionIds`**（Host 记的
			 *   "这个工作区有哪些会话"），删掉 `sessions/<cwd>/<sid>/` 与 projcache **不会**改那条记录
			 *   ⇒ 行照旧在，只是标题回落成 id ✗（这正是用户看到的现象）。
			 *   ⇒ 顺序必须是：
			 *       ① `uiWorkspace.archiveSession(sid)` —— 归档集合是 Host **持久化**状态 ⇒ 一落，列表立刻消失、跨窗口/重启一致；
			 *       ② 再删磁盘（真删，不可恢复）。
			 *   ⚠ 归档那步失败就**中止**（尤其 `session-active`：跑着的会话既不删也不停，交给用户）。
			 *   ⚠ 归档成功但删盘失败 ⇒ 如实说"已从列表移除，磁盘数据仍在"，**不许假装删干净** ✗。
			 */
			const deleteSessionForever = (sid, say, done) => {
				const finish = (ok, text, kind) => {
					say(text, kind || (ok ? "note" : "error"));
					if (typeof done === "function") { done(ok); }
				};
				/** ② 删磁盘（只在归档那步成功之后才走）。 */
				const wipe = () => {
					let fetchFn = null;
					try {
						fetchFn = typeof fetch === "function" ? fetch : null;
					} catch { fetchFn = null; }
					if (!fetchFn) { finish(true, "已从列表移除；但当前环境没有 fetch，磁盘数据没删", "error"); return; }
					void Promise.resolve(fetchFn(DELETE_API, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId: sid }),
					})).then((res) => {
						return Promise.resolve(res.json().catch(() => null)).then((body) => ({ res, body }));
					}).then(({ res, body }) => {
						if (!res || !res.ok || !body || body.ok !== true) {
							const why = body && body.error ? body.error : ("HTTP " + (res ? res.status : "?"));
							// 列表已经移除了（归档生效）⇒ 说清"磁盘没删"，别让用户以为删干净了
							finish(true, res && res.status === 404
								? "已从列表移除；宿主没有删除通路（插件版本过旧 / Host 未重启），磁盘数据仍在"
								: ("已从列表移除；但磁盘删除失败：" + why), "error");
							return;
						}
						if (body.found === false) {
							finish(true, "已从列表移除（磁盘上没找到这条的数据；DSH_HOME=" + String(body.home || "?") + "）", "note");
						} else {
							finish(true, "已删除（" + (body.removed || []).length + " 项，不可恢复）", "note");
						}
						// 刷 roster：删完让客户端重新拉一次列表（归档已让列表消失，这里是让 roster 也对上）
						try {
							const svc = typeof ctx.get === "function" ? ctx.get("sessions") : null;
							if (svc && typeof svc.refresh === "function") { void Promise.resolve(svc.refresh()).catch(() => undefined); }
						} catch { /* 刷不动也不影响已删的事实 */ }
					}).catch((e) => {
						finish(true, "已从列表移除；但磁盘删除失败：" + errText(e), "error");
					});
				};
				// ① 归档（Host 状态）：列表立即消失，且跨窗口 / 重启一致
				try {
					const uw = ctx.uiWorkspace;
					if (!uw || typeof uw.archiveSession !== "function") {
						finish(false, "删除失败：宿主不支持归档（uiWorkspace.archiveSession 不可用）⇒ 无法从列表移除");
						return;
					}
					void Promise.resolve(uw.archiveSession(sid)).then(wipe, (e) => {
						if (isActiveRefusal(e)) {
							finish(false, "这条会话正在运行，先停止它再删除（不替你停）");
							return;
						}
						finish(false, "删除失败（先从列表移除这一步没过）：" + errText(e));
					});
				} catch (e) { finish(false, "删除失败：" + errText(e)); }
			};
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
				row: { display: "flex", alignItems: "center", gap: 7, minHeight: 28, padding: "3px 8px", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap", color: "var(--dsw-alias-label-secondary, #a3a3a3)" },
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
				sessMsg: { fontSize: 11, lineHeight: "1.5", padding: "2px 8px 4px", whiteSpace: "normal" },
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
				// ── 状态灯（2026-10-30）──────────────────────────────────────────
				// 载体与 @vssaros/dsh-sessions 稿 A 一致：**2px 竖条**（圆点在高 29px 的行里太碎、
				// 又与「N 个根」徽标抢视线）。颜色口径也照抄：运行中绿 / 等你回答黄 / 空闲灰。
				// ⚠ 宽度**恒定**（三态同宽）：否则灯一亮整行文字横跳 2px ✗（与图钉占位同一条教训）。
				ring: {
					width: 2, height: 15, borderRadius: 1, flex: "0 0 2px",
					margin: "0 1px 0 0", background: "transparent",
				},
				ringRunning: { background: "#3fb950", animation: "vssaros-ws-ring-pulse 1.6s ease-in-out infinite" },
				ringAwaiting: { background: "#d7a521" },
				ringIdle: { background: "rgba(128,128,128,.5)" },				sessMenu: {
					position: "fixed", zIndex: 80, minWidth: 186, padding: 4, borderRadius: 8,
					background: "var(--dsw-alias-bg-layer-2, #262626)",
					border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
					boxShadow: "0 12px 32px rgba(0,0,0,.55)",
					color: "var(--dsw-alias-label-primary, #e6e6e6)",
				},
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

			function Browser(props) {
				const wide = !props || props.wide !== false;
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
				const hoverTimer = react.useRef(null);
				// ── 会话行操作（2026-10-29，用户要求：右键菜单 + 拖拽排序）──
				/** 手动顺序（组键 → id 列表）；localStorage 一读，拖完即写。 */
				const [orderMap, setOrderMap] = react.useState(readOrderMap);
				/** 会话右键菜单：{sid, pinned, x, y}；null = 关闭。 */
				const [sessMenu, setSessMenu] = react.useState(null);
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
				const msgTimer = react.useRef(null);
				// 点外面 ⇒ 关菜单（与官方菜单同口径；不关就会"菜单糊在侧栏上"✗）
				// ★ 2026-10-29：工作区 ＋ 菜单与会话右键菜单**共用**这套关闭逻辑（两套并存会互相残留）。
				react.useEffect(() => {
					if (!menu && !sessMenu && !confirmDel) { return undefined; }
					const onDown = (ev) => {
						try {
							const t = ev.target;
							if (t && t.closest && (
								t.closest("[data-vssaros-ws-menu]")
								|| t.closest("[data-vssaros-sess-menu]")
								// 确认层是**模态**：点它的按钮不该被这里关掉（否则"取消"还没跑就被卸载）
								|| t.closest("[data-vssaros-sess-confirm]")
							)) { return; }
							setMenu(null);
							setSessMenu(null);
							// 点外面 = 取消（危险操作绝不因为点偏了而执行 ✗）
							setConfirmDel(null);
						} catch { setMenu(null); setSessMenu(null); setConfirmDel(null); }
					};
					const onKey = (ev) => {
						if (ev.key === "Escape") { setMenu(null); setSessMenu(null); setConfirmDel(null); }
					};
					document.addEventListener("mousedown", onDown, true);
					document.addEventListener("keydown", onKey, true);
					return () => {
						document.removeEventListener("mousedown", onDown, true);
						document.removeEventListener("keydown", onKey, true);
					};
				}, [menu, sessMenu, confirmDel]);
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
				const rows = react.useMemo(() => buildSidebar({
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
				}), [wsSnap, records, sessSnap, currentId, officialTick, orderMap]);

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

				if (!wide) {
					// 窄轨（rail）形态：与官方一致，一枚图标，点击展开侧栏。
					return react.createElement("button", {
						style: Object.assign({}, S.iconBtn, { fontSize: 16, padding: 6 }),
						title: "Workspaces",
						onClick: () => { try { props.expandSidebar(); } catch { /* 可选 */ } },
					}, "🗀");
				}

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

				// ── 会话行操作（2026-10-29）──────────────────────────────────────────
				/** 就地反馈：6 秒后自动消失（常驻会让人以为状态还在）。 */
				const say = (text, kind) => {
					if (!text) { setSessMsg(null); return; }
					setSessMsg({ kind: kind === "error" ? "error" : "note", text: String(text) });
					if (msgTimer.current) { clearTimeout(msgTimer.current); }
					msgTimer.current = setTimeout(() => setSessMsg(null), 6000);
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
					setRenaming(null);
					const w = typeof window !== "undefined" ? window.innerWidth : 0;
					const h = typeof window !== "undefined" ? window.innerHeight : 0;
					let x = e.clientX || 0;
					let y = e.clientY || 0;
					if (w > 0) { x = Math.max(8, Math.min(x, w - 232)); }
					if (h > 0) { y = Math.max(8, Math.min(y, h - 212)); }
					setSessMenu({ sid: s.id, pinned: s.pinned === true, x, y });
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
				const renderSessionRow = (s, setMsg, setLocal) => {
					const isRenaming = !!(renaming && renaming.sid === s.id);
					const isDragging = !!(drag && drag.sid === s.id);
					const mark = dropAt && dropAt.sid === s.id ? dropAt : null;
					const style = Object.assign({},
						// ★ 会话行的左缩进（2026-10-30，用户连报三次「太靠右 / 还嫌靠右」）：
						//   标题的 x 由**三段**相加，改一段没用 ⇒ 三段都在这段注释里记清楚：
						//     ① 行容器左缘 12px（侧栏 padding）
						//     ② `paddingLeft` 16px（原 30）
						//     ③ 状态灯 2px + 它的 marginRight 1px + flex gap 7px = 10px
						//   ⇒ 标题 = 12 + 16 + 10 = **38px**；工作区分组标题 = 12 + padding 8 + 箭头 10 + gap 7 = **37px**
						//   ⇒ 两者**逐像素齐平**（层级由"分组有 ▼ 箭头、会话有状态灯竖条"表达）。
						//   ★ 第三报的根因不是 paddingLeft：是**行首那个 12px 图钉占位 + 7px gap = 19px**
						//     （当日为"切置顶不横跳"付的代价，却全压在标题起点上，把标题推到 57px ✗）；
						//     现图钉已挪到**行尾**（见下面 kids 的注释）⇒ 这两笔开销没了。
						//   ⚠ 再要更左只能动 ②（< 15 会让状态灯压到分组标题与「N 个根」徽标之间，视觉打架 ✗），
						//     或者把状态灯也挪走 —— 但那样就看不出哪条会话在跑。
						S.row, { paddingLeft: 16, fontSize: 12.5 },
						s.isCurrent ? { background: "var(--dsw-alias-interactive-bg-active, rgba(91,140,255,.15))", color: "var(--dsw-alias-label-primary, #e6e6e6)" } : null,
						s.pinned ? { color: "var(--dsw-alias-label-primary, #e6e6e6)" } : null,
						isDragging ? { opacity: .45 } : null,
						mark && mark.ok ? { boxShadow: (mark.after ? "inset 0 -2px 0 " : "inset 0 2px 0 ") + "var(--dsw-alias-brand-primary, #5b8cff)" } : null,
						mark && !mark.ok ? { outline: "1px dashed #f48771", outlineOffset: "-1px" } : null,
					);
					const kids = [];
					// ★ 状态灯（2026-10-30）：位置在标题**之前**（贴行首缩进处，与 @vssaros/dsh-sessions
					//   的 `.sv-dot` 同位）—— 眼睛扫左边缘就能看出哪条在跑。
					//   `unknown`（读不到任何运行信号）⇒ 占位但**不着色**：不把未知画成空闲 ✗。
					kids.push(react.createElement("span", {
						key: "ring",
						style: s.status === "running" ? Object.assign({}, S.ring, S.ringRunning)
							: s.status === "awaiting" ? Object.assign({}, S.ring, S.ringAwaiting)
								: s.status === "idle" ? Object.assign({}, S.ring, S.ringIdle) : S.ring,
						"data-ws-ring": s.status,
						"aria-hidden": s.status === "unknown" ? "true" : "false",
						title: RING_LABEL[s.status] || "",
					}));
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
						kids.push(react.createElement("span", { key: "lbl", style: S.lbl }, s.title));
						// 稿 1：只有**非主根**的会话才带根名标签 ✓
						if (s.rootName && !s.isPrimaryRoot) {
							kids.push(react.createElement("span", { key: "rt", style: S.rtag }, s.rootName));
						}
						// ★★ 2026-10-30（用户第三次报「还嫌靠右」）：图钉从**行首**挪到**行尾**（时间左边）。
						//   根因是行首那个「图钉占位 12px + gap 7 = 19px」——它当年是为了"切置顶不横跳"，
						//   代价却全压在标题起点上（把标题从 37 推到 56，看起来像多缩进了一级 ✗）。
						//   挪到行尾后：① 标题回到 **37**（与工作区分组标题**逐像素齐平**）；
						//   ② 置顶只改行尾，标题起点不随置顶变化 ⇒ "不横跳"的原目标照样成立 ✓。
						if (s.pinned) {
							kids.push(react.createElement("span", { key: "pin", style: S.pin, "data-pinned": "1", title: "已置顶" }, "📌"));
						}
						kids.push(react.createElement("span", { key: "at", style: S.meta }, timeLabel(s.at)));
					}
					return react.createElement("div", {
						key: s.id,
						"data-session-item": s.id,
						"data-pinned": s.pinned ? "1" : "0",
						// 重命名时禁用拖拽：否则输入框里选字会变成拖行 ✗
						draggable: isRenaming ? "false" : "true",
						style,
						title: s.rootName ? s.rootName + " · " + s.id : s.id,
						onClick: () => { if (!isRenaming) { openSession(s.id, setMsg, setLocal); } },
						onContextMenu: (e) => openSessMenu(s, e),
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

				return react.createElement("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" } },
					react.createElement("div", { style: S.head },
						// 2026-10-18：与官方中文 UI 对齐（此前写死英文 `Workspaces`，弹窗里和
				// 「新会话 / 插件 / 自动化任务」并排显得割裂 ✓）
				react.createElement("span", { style: S.headT }, "工作区"),
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
									react.createElement("div", {
										style: Object.assign({}, S.row, { color: "var(--dsw-alias-label-primary, #e6e6e6)" }),
										onClick: () => setCollapsed(nextCollapsed(collapsed, key)),
										onMouseEnter: (e) => openHover(key, e),
										onMouseLeave: closeHover,
									},
										react.createElement("span", { style: { width: 10, fontSize: 8, color: "var(--dsw-alias-label-tertiary, #737373)", flex: "0 0 auto" } }, isOpen ? "▼" : "▶"),
										react.createElement("span", { style: Object.assign({}, S.lbl, { fontWeight: 600 }) }, row.record.name),
										react.createElement("span", { style: S.badge }, row.record.roots.length + " 个根"),
									),
									isOpen ? renderSessions(row) : null,
								);
							}
							// 回落：未被 IDE 记录认领的 dsh 条目，平铺（与官方形态一致 ✓）
							const key = "flat:" + row.label;
							const isOpen = collapsed[key] !== true;
							return react.createElement("div", { key: row.key || key },
								react.createElement("div", {
									style: Object.assign({}, S.row, { color: "var(--dsw-alias-label-primary, #e6e6e6)" }),
									onClick: () => setCollapsed(nextCollapsed(collapsed, key)),
								},
									react.createElement("span", { style: { width: 10, fontSize: 8, color: "var(--dsw-alias-label-tertiary, #737373)", flex: "0 0 auto" } }, isOpen ? "▼" : "▶"),
									react.createElement("span", { style: Object.assign({}, S.lbl, { fontWeight: 600 }) }, row.label),
								),
								isOpen ? renderSessions(row) : null,
							);
						}),
					),
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
						react.createElement("div", { style: { height: 1, margin: "4px 6px", background: "var(--dsw-alias-border-l1, #3a3a3a)" } }),
						react.createElement("button", {
							type: "button", role: "menuitem", "data-act": "copy", style: S.menuItem,
							onClick: () => menuAction("copy"),
						}, "复制会话 id"),
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
				);
			}

			// 遮蔽官方 WorkspaceBrowser（升序取最低 priority 渲染；同 hero.workspace 的 -10 先例 ✓）。
			try {
				// ★ 状态灯的脉动动效（一次性、幂等；见 ensureRingStyle 的注释）。
				//   ⚠ 必须放在这里而不是 install 顶部：`ensureRingStyle` 是与 `S` 一起声明的
				//   `const`，在本作用域**下方** ⇒ 提前调用会吃掉 TDZ（Cannot access before initialization）。
				ensureRingStyle();
				ctx.slots.inject(SLOT, () => ctx.slots.register(
					{ name: SLOT, id: "vssaros-workspaces", priority: -10 }, Browser));
				state.workspacesReplaced = true;
			} catch (e) {
				state.workspacesError = String((e && e.message) || e);
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
		};
		return module.exports;
	}
});
