// @vssaros/dsh-chat-surface — 侧栏「主页」入口 + 工作台启动器（2026-10-17 稿 C 起，多轮演进）
// package-local chunk（契约同 client.sessions.js）：主包用 require.async 取回 install()。
//
// ── 形态（★ 2026-10-21 终稿：一行「🏠 主页」，左键开页、右键启动器）───────────────
// 侧栏只有**一行**属于我们（紧接「新会话」，order -10）：
//   · 「🏠 主页」 → **左键固定打开主页**（用户："工作台改名为主页，点击后要求显示 主页内容"）；
//   · **右键**那一行 → 启动器（11 格切换 + 排序 ✎，拖拽 / ↑↓，localStorage 持久化）。
// ⚠ 曾有第二行「<当前工作台>」（order -9）：它必然也显示「主页」⇒ 两行一模一样，
//   用户 2026-10-21 明确要求删掉 ✓（"移除当前的主页按钮"）。
// 侧栏按钮的点击归官方（会把中栏切到同 id 的 main 面板，拦不了也不拦）⇒
// 我们的 main 面板是**中转**：挂载时开对应页 + `ctx.layout.selectPanel(null)` 弹回会话，
// 聊天框不被占用 ✓。
//   · 条目落点 = **右侧栏页签**（sidebar.right.pane.tab，iframe 载 /x/<module>/）——
//     不占中栏 ✓（2026-10-17 用户要求）。服务缺失 / 无会话开签失败 ⇒ bridge.notify 明示 ✗ 不静默。
//
// ── 无会话在屏的修复（2026-10-17 真机：点条目右栏没内容）─────────────────────
// 官方 sidebarRight.openTab 作用于"屏幕上的会话"，无会话 ⇒ fails loudly（service.d.ts 原话）。
// 病根在**主包**：会话绑定曾被 `surface !== "chat"` 早退挡住 ⇒ full 弹窗停在 hero
// 「Choose workspace to start」（用户截图实证）⇒ openTab 无的放矢 ✗。
// 修法在主包（client.js）：绑定提升到 chat/full 都生效（openSession 轮询 + alignWorkspace）。
// 本 chunk 不再自己轮询，只在**点击那一刻**读 DOM 事实（[data-sidebar-right-session]，与主包
// 同口径 ✓）：没就绪就 notify 明示"会话还在打开中"（主包轮询正在重试，稍等再点即可）✓。
//
// ── 官方机制（dsh-cordis-client-runner CLIENT_SLOT_API 实证）────────────────
// · sidebar.panellist（list / root）：官方 plugins=0 / schedules=10；我们**一行**取 -10
//   （紧接「新会话」，见 ENTRY_ORDER），品牌区那枚「回到 IDE」在 sidebar.brand.name（不占本槽）✓。
// · main（keyed / root）：key 与图标 id 同值（vssaros-workbench）⇒ 点图标中栏选中它（中转）。
// · sidebar.right.pane.tab（keyed / session）：页签体按 tab kind 派发；类型先经
//   `ctx.sidebarRightTabs.register({id,kind,priority,title})` 登记（schedule 同款 ✓）。
// · ⚠ 主窗口聊天框是 chat-only 形态，侧栏整列被 CSS 裁掉 ⇒ 本入口**只在全窗**可见；
//   chat 形态注册是无害空转 ✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.workbenchNav.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		/**
		 * `codicon:xxx` → emoji（2026-10-22 加）。
		 *
		 * 为什么需要：注册表里 `icon` 按清单规范写的是 **标识符**（`codicon:home` 这种），但 dsh 前端
		 * **没有 codicon 字体/CSS**（查过运行时：零 codicon 样式），而启动器/商城的图标体系整体是
		 * emoji（内置 `DEFAULT_ITEMS` 全是 🏠💬🤖…）⇒ 把 `codicon:*` 直接丢给 UI 只会得到兜底 🧩
		 * （以前那行是 `icon.length <= 4 ? icon : "🧩"`，按"图标一定是 emoji"的假设写的 ✗）。
		 *
		 * ⚠ 这份表在 `client.workbenchNav.js` 与 `client.market.js` 里**各存一份**（两个 chunk 之间不能
		 *   同步 require），由守卫 `check-workbench-catalog.mjs` 比对两处**逐字一致** + 校验每个已注册
		 *   工作台的图标都在表里（新增工作台用了没登记的 codicon ⇒ 守卫红，而不是悄悄显示 🧩）。
		 */
		const WB_ICON_EMOJI = {
			"codicon:home": "🏠", "codicon:book": "📚", "codicon:database": "🧠",
			"codicon:robot": "🤖", "codicon:organization": "🤖", "codicon:tasklist": "🗂️",
			"codicon:checklist": "🗂️", "codicon:list-tree": "🔀", "codicon:type-hierarchy": "🕸️",
			"codicon:clock": "⏰", "codicon:graph": "📊", "codicon:pulse": "💓",
			"codicon:search": "🔍", "codicon:settings": "⚙️", "codicon:gear": "⚙️",
			"codicon:extensions": "🧩", "codicon:package": "🧩", "codicon:cloud": "☁️",
			"codicon:comment-discussion": "💬", "codicon:terminal": "⌨️",
		};
		/** 图标 → 可渲染的 emoji：映射表优先；本来就是短符号/emoji ⇒ 原样；其余兜底 🧩。 */
		function wbIconEmoji(icon) {
			const raw = String(icon == null ? "" : icon).trim();
			if (!raw) { return "🧩"; }
			if (WB_ICON_EMOJI[raw]) { return WB_ICON_EMOJI[raw]; }
			if (raw.indexOf("codicon:") !== 0 && Array.from(raw).length <= 4) { return raw; }
			return "🧩";
		}

		const SLOT_NAV = "sidebar.panellist";
		const SLOT_MAIN = "main";
		const SLOT_RIGHT_TAB = "sidebar.right.pane.tab";
		/**
		 * 根级**常驻覆盖层**（`kind: list, scope: root`，由 layout 外壳每帧渲染）。
		 *
		 * 用它放页签条：中栏是 **keyed** 槽（对话 / 我们的面板轮流占），页签条若长在面板里，
		 * 一切回对话就跟着消失 ✗（2026-10-21 用户报的正是这个）。
		 */
		const SLOT_OVERLAY = "shell.overlay";
		/** 页签条高度（给中栏让位的 padding-top 与自身 height 用同一个值 ✓）。 */
		const STRIP_H = 32;
		const ENTRY_ID = "vssaros-workbench";
		/**
		 * ★ 2026-10-21（用户：「左侧栏布局要求和 dsh-desktop 项目一致」）：
		 *   入口从 **20**（在插件 / 自动化任务之后）提到 **-10** ⇒ 紧接「新会话」、在官方
		 *   plugins=0 / schedules=10 之前 —— 与 dsh-desktop 的 `sidebar.quickSwitcher` 同一位置。
		 * ★ 同日第二轮（用户：「工作台改名为主页…移除当前的主页按钮」）：只剩**一行**「🏠 主页」，
		 *   原先并排的 `-9「当前名」` 那行已删（那行必然也显示「主页」⇒ 两行一模一样 ✗）。
		 */
		const ENTRY_ORDER = -10;
		const LS_KEY = "vssaros.wbNav.order";
		/** 当前工作台（只在两个载体之间同步用；读不到就回落第一个条目 ✓）。 */
		const LS_CURRENT = "vssaros.wbNav.current";

		/** 工作台条目（默认顺序；route 以各插件 cordis.patch.yml 的自托管路由为准）。 */
		const DEFAULT_ITEMS = [
			{ id: "vssaros-wb-dashboard", name: "主页", ico: "🏠", route: "/x/dashboard/" },
			{ id: "vssaros-wb-sessions", name: "会话", ico: "💬", route: "/x/sessions/" },
			// ★ 稿 C（2026-10-21 用户拍板）：会话磁贴矩阵 = dsh desktop 的「多会话窗口」形态
			//   （一眼看到一批会话的状态，点一块换到那条会话）。与「会话」条目同源路由，只是 view 不同 ✓
			{ id: "vssaros-wb-session-tiles", name: "会话磁贴", ico: "🧲", route: "/x/sessions/?view=tiles" },
			{ id: "vssaros-wb-agents", name: "Bots", ico: "🤖", route: "/x/agents/" },
			{ id: "vssaros-wb-kanban", name: "看板", ico: "🗂️", route: "/x/kanban/" },
			{ id: "vssaros-wb-workflow", name: "工作流", ico: "🔀", route: "/x/workflow/" },
			{ id: "vssaros-wb-kb", name: "知识库", ico: "📚", route: "/x/kb/" },
			{ id: "vssaros-wb-memory", name: "记忆库", ico: "🧠", route: "/x/memory/" },
			{ id: "vssaros-wb-codebase", name: "代码库", ico: "🕸️", route: "/x/codebase/" },
			{ id: "vssaros-wb-media", name: "媒体库", ico: "🖼️", route: "/x/media/" },
			{ id: "vssaros-wb-imagegen", name: "生图", ico: "🎨", route: "/x/imagegen/" },
			{ id: "vssaros-wb-skills", name: "工具", ico: "🧰", route: "/x/skills/" },
			// ★ 2026-10-24（用户：「移除自动化任务 item，将自动化任务包装成一个 自动化任务工作台」）：
			//   侧栏那条官方「自动化任务」面板被隐藏（见下面 HIDDEN_LABELS）⇒ 能力全部收到这个工作台里
			//   ⇒ 名字也跟着改成「自动化任务」（与工作台标题、插槽描述符三处同值）。
			{ id: "vssaros-wb-scheduler", name: "自动化任务", ico: "🕒", route: "/x/scheduler/" },
			// ★ 2026-10-22（修 bug：主页没有「商城」卡片）：自营商城工作台。
			//   这份 DEFAULT_ITEMS 同时是 **route 白名单**（`itemByRoute()` 只认这里的 route）⇒
			//   不登记 ⇒ 从主页/侧栏点「打开」会被静默拒掉（"点了没反应"）✗ ⇒ 必须登记 ✓。
			{ id: "vssaros-wb-marketplace", name: "商城", ico: "🛒", route: "/x/marketplace/" },
			// ★ 2026-10-23：萨罗斯管理平台工作台（`@vssaros/dsh-studio`）。
			//   这份表同时是 **route 白名单** ⇒ 不登记 ⇒ 从主页/侧栏点「打开」被静默拒掉。
			//   ⚠ 与 `vssaros-dashboard/lib/catalog.js` 的 `WORKBENCH_MODULES` 必须两处同时登记。
			{ id: "vssaros-wb-studio", name: "萨罗斯平台", ico: "◱", route: "/x/studio/" },
			// ★ 2026-10-24：小红书笔记（创作型工作台样板，`@vssaros/dsh-xhs-note`）。
			//   这份表同时是 **route 白名单** ⇒ 不登记 ⇒ 从主页/侧栏点「打开」会被静默拒掉（"点了没反应"）。
			//   ⚠ 与 `vssaros-dashboard/lib/catalog.js` 的 `WORKBENCH_MODULES` 必须两处同时登记。
			{ id: "vssaros-wb-xhs-note", name: "小红书笔记", ico: "💬", route: "/x/xhs-note/" },
			// ★ 2026-10-22（用户：「多 TUI 应该设计为一个工作台，在主页中显示 item」）：
			//   并行 TUI 工作台（`@vssaros/dsh-parallel`，页面 `/x/parallel/` 是稿 A 网格）。
			//   ⚠ 与 `vssaros-dashboard/lib/catalog.js` 的 `WORKBENCH_MODULES` **必须两处同时登记**
			//   （这份同时是 route 白名单 ⇒ 漏了 = 主页卡片在、点「打开」被静默拒掉）✗
			{ id: "vssaros-wb-parallel", name: "并行工作台", ico: "🖥️", route: "/x/parallel/" },
			];
		// ★ 暴露给同插件的其它 chunk（`client.market.js` 的「已安装」要用它）：
		//   本机内置的工作台**不是市场条目**（市场的目录里只有别人上架的工作台），
		//   但它们属于「本机已装」那一格 ⇒ 商城界面得知道它们存在。
		//   两个 chunk 不能互相 import（各自独立装载）⇒ 只能经 window 共享（同源同页 ✓）。
		window.__vssarosWorkbenchItems = DEFAULT_ITEMS;

		function loadOrder() {
			try {
				const raw = window.localStorage && window.localStorage.getItem(LS_KEY);
				const saved = raw ? JSON.parse(raw) : null;
				if (!Array.isArray(saved)) { return DEFAULT_ITEMS.slice(); }
				const byId = new Map(DEFAULT_ITEMS.map((i) => [i.id, i]));
				const out = saved.map((id) => byId.get(id)).filter(Boolean);
				for (const it of DEFAULT_ITEMS) { if (out.indexOf(it) < 0) { out.push(it); } } // 新条目补尾
				return out;
			} catch { return DEFAULT_ITEMS.slice(); }
		}
		function saveOrder(items) {
			try { window.localStorage && window.localStorage.setItem(LS_KEY, JSON.stringify(items.map((i) => i.id))); } catch { /* 私有模式等：不存也能用 */ }
		}
		/** 当前工作台 id（读不到/过期 ⇒ undefined，由调用方回落第一项）。 */
		function loadCurrent() {
			try {
				const raw = window.localStorage && window.localStorage.getItem(LS_CURRENT);
				return typeof raw === "string" && raw ? raw : undefined;
			} catch { return undefined; }
		}
		function saveCurrent(id) {
			try { window.localStorage && window.localStorage.setItem(LS_CURRENT, String(id || "")); } catch { /* 不存也能用 */ }
		}

		/** 主页在 DEFAULT_ITEMS 里的 id（「工作台」那行固定开它）。 */
		const DASHBOARD_ID = "vssaros-wb-dashboard";

		/**
		 * 页签换序的**纯逻辑**（2026-10-23 拖拽排序）。放在模块级（不在 `install()` 里）是为了
		 * 能被 `__test` 直接调用 ⇒ 守卫可以真跑换序断言，而不是只比源码字符串 ✓。
		 *
		 * `slot` = 插入位（0 … list.length，含义是"插在第 slot 个之前"）。先摘后插 ⇒ 右侧插入位要减一。
		 * 返回**同一个引用** = "没变"（调用方据此跳过写盘 / 重画）；否则返回新数组（**不改入参**）。
		 */
		function reorderTabs(list, id, slot) {
			const arr = Array.isArray(list) ? list : [];
			const from = arr.findIndex((t) => t && t.id === id);
			if (from < 0) { return arr; }
			if (typeof slot !== "number" || Number.isNaN(slot)) { return arr; }
			const to = slot > from ? slot - 1 : slot;
			const clamped = Math.max(0, Math.min(arr.length - 1, to));
			if (clamped === from) { return arr; }
			const next = arr.slice();
			const moved = next.splice(from, 1)[0];
			next.splice(clamped, 0, moved);
			return next;
		}

		/**
		 * 「🗂 工作台」那行**固定开哪一条**：主页（2026-10-21 用户："点击工作台要求直接打开 主页的 page"）。
		 *
		 * 为什么不继续弹启动器：那条路径要**两次点击**（行 → 网格 → 条目），而"工作台"这个名字
		 * 在用户心里的预期就是那一页首页。用户在启动器里**删/排掉**主页时回落到第一项 ✓
		 * （纯逻辑，守卫 ⑥ 一起钉住）。
		 */
		function pickDashboardItem(items) {
			const list = Array.isArray(items) ? items : [];
			for (const it of list) {
				if (it && it.id === DASHBOARD_ID) { return it; }
			}
			return list[0] || DEFAULT_ITEMS[0];
		}

		/**
		 * 从会话快照里挑**最近更新**的一条（兜底进会话用；纯逻辑 ⇒ 守卫 ⑥ 钉住）。
		 *
		 * 口径：`updatedAt` 优先、回落 `createdAt`（都缺 ⇒ 0，仍可被选中：宁可开一条旧的也别停在 hero）；
		 * 归档的一律不选（进了也只会看到"已归档"空屏 ✓）。时间相同按 id 兜底排序，结果稳定。
		 */
		function pickLatestSessionId(byId, archivedIds) {
			const archived = Array.isArray(archivedIds) ? archivedIds : [];
			let best = null;
			for (const id of Object.keys(byId || {})) {
				if (archived.indexOf(id) >= 0) { continue; }
				const s = (byId || {})[id] || {};
				const at = (typeof s.updatedAt === "number" && s.updatedAt) || (typeof s.createdAt === "number" && s.createdAt) || 0;
				if (!best || at > best.at || (at === best.at && id < best.id)) { best = { id, at }; }
			}
			return best ? best.id : null;
		}

		function install(ctx, shell) {
			// ★ 幂等（2026-10-21 真机取证）：同一个 chunk 可能被**装载两次** ——
			//   `client.js` 的 `PART_CHUNKS`（chat 形态）与 `hasOfficialChrome` 分支都 require 了它；
			//   2026-10-18 把弹窗改成「surface=chat + 保留官方 chrome」⇒ 两者**不再互斥** ⇒
			//   本 chunk 的 install 跑了两遍 ⇒ 第二遍重复注册 keyed 槽
			//   （`sidebar.right.pane.tab`）⇒ 官方直接抛
			//   「already has an entry for key …」⇒ **后面 main 槽的中栏面板注册全被跳过**
			//   ⇒ 打开工作台没有页签、中栏也没有工作台面板 ✗（真机症状：keyed 槽冲突 + 页签条整条不显示）。
			// ⇒ 用**全局标记**挡住第二次（同一插件的 ctx 相同 ⇒ 幂等安全 ✓）。
			//   （另有一层防线：`client.js` 两个装载分支已改成互斥。）
			if (window.__vssarosWorkbenchNavInstalled) { return; }
			window.__vssarosWorkbenchNavInstalled = true;
			const bridge = shell && shell.bridge;
			const state = (shell && shell.state) || {};

			// ★★ 2026-10-24（用户：「移除插件 item」）：把侧栏那行「插件」藏掉。
			//   官方 `dsh-client-ui-plugin-manager` 是**无条件**往 `sidebar.panellist` 注册
			//   `{ id: 'plugins', order: 0 }` 的（源码里没有任何配置开关）⇒ 只能在 DOM 层处理。
			//   ⚠ 只藏**侧栏那一颗 button**：页面本身、`pluginNavigation` 命令、设置里的入口都保留
			//     （用户要的是"侧栏别出现这一项"，不是把能力删掉 ✗）。
			//   判据用 `aria-label`（官方行是 `<button aria-label="插件">`，中英两种都认）；
			//   侧栏每次切面板都会重渲染 ⇒ 必须 **MutationObserver + 节流**重贴，否则一次 hide 就被覆盖。
			(() => {
				// ★ 2026-10-24（用户：「移除自动化任务 item」）：官方 `dsh-client-ui-schedule` 拿
				//   `sidebar.panellist`（id=schedules / order=10）注册了「自动化任务」那一行，同样**没有配置开关**
				//   ⇒ 一起在 DOM 层隐藏。能力没丢：它被收进了 `@vssaros/dsh-scheduler` 的**自动化任务工作台**
				//   （页签条里的「自动化任务」，DEFAULT_ITEMS 已登记 ⇒ route 白名单也认 ✓）。
				//   以后再有"官方行不该露脸"的，往这张表里加 label 即可（判据只看侧栏里的 button[aria-label]）。
				const HIDDEN_LABELS = ["插件", "Plugins", "自动化任务", "定时任务", "Scheduled tasks", "Automated tasks"];
				let lastRun = 0;
				let queued = 0;
				const apply = () => {
					queued = 0;
					try {
						const scope = document.querySelector("[data-sidebar-left]") || document.body;
						if (!scope) { return; }
						const rows = scope.querySelectorAll("button[aria-label]");
						for (let i = 0; i < rows.length; i++) {
							const btn = rows[i];
							const label = String(btn.getAttribute("aria-label") || "").trim();
							if (HIDDEN_LABELS.indexOf(label) < 0) { continue; }
							if (btn.getAttribute("data-vssaros-hidden") === "1") { continue; }
							btn.setAttribute("data-vssaros-hidden", "1");
							btn.style.display = "none";
							state.pluginsRowHidden = true;
						}
					} catch (e) { noteFail("nav:隐藏插件行", e); }
				};
				/** 节流到 ~200ms：侧栏 DOM 变动很频繁，不节流的 querySelectorAll 会拖慢输入 ✓ */
				const schedule = () => {
					const now = Date.now();
					if (queued) { return; }
					const wait = Math.max(0, 200 - (now - lastRun));
					queued = setTimeout(() => { lastRun = Date.now(); apply(); }, wait);
				};
				apply();
				try {
					if (typeof MutationObserver === "function") {
						const target = document.querySelector("[data-sidebar-left]") || document.body;
						if (target) { new MutationObserver(schedule).observe(target, { childList: true, subtree: true }); }
					}
				} catch (e) { noteFail("nav:隐藏插件行(观察)", e); }
				// 首屏兜底：React 还没画出来时那一次 apply 会空跑 ✓
				setTimeout(apply, 400);
				setTimeout(apply, 1500);
			})();

			let items = loadOrder();
			/** 最后打开过的工作台（只写不读：侧栏那行「当前名」已删，留着供以后用；读不到也没影响 ✓）。 */
			let currentId = loadCurrent();

			// ── 注册**不许外抛**（2026-10-21 真机「主页丢失」根因）────────────────────
			// 官方对「同 key / 同 id 重复注册」**直接抛**（真机实测原文）：
			//   keyed slot "sidebar.right.pane.tab" already has an entry for key "…" (registered by …)
			//   list  slot "sidebar.panellist"   already has an entry with id  "…" (registered by …)
			// ⇒ 之前只要**任意一处**注册撞了，那个异常就会从 install() 里一路抛出去 ⇒
			//   **后面所有注册全被跳过**（含侧栏「主页」那一行）⇒ 而幂等标记在注册**之前**
			//   就置上了 ⇒ 之后无论再装载几次都一律早退 ⇒ 「主页」行在整个页面生命周期里
			//   **永远补不回来**（真机症状：侧栏只剩 插件 / 自动化任务，🏠主页 不见了）✗✗。
			// ⇒ 三条修法（缺一不可）：
			//   ① 每处注册都走 `safeRegister` / `safeInject` ⇒ 撞了就记一笔，**绝不外抛** ✓；
			//   ② 「主页」行**第一个注册** ⇒ 后面再怎么出事都带不走它 ✓；
			//   ③ 没注册上时由定时兜底**再试一次** ⇒ 竞态类丢失也能自愈 ✓。
			const REG = window.__vssarosWorkbenchNavReg || (window.__vssarosWorkbenchNavReg = {});
			/** 记一笔失败（不外抛）：真机取证用（`window.__vssarosWorkbenchNavErrors`）。 */
			function noteFail(tag, err) {
				const msg = String((err && err.message) || err);
				try {
					const arr = window.__vssarosWorkbenchNavErrors || (window.__vssarosWorkbenchNavErrors = []);
					if (arr.length < 20) { arr.push(tag + ": " + msg); }
				} catch { /* window 不可写 */ }
				try { console.warn("[vssaros] 工作台导航注册失败（" + tag + "）：" + msg); } catch { /* 无 console */ }
				return null;
			}
			/** 注册一个槽条目：**绝不外抛** ⇒ install 不会中途夭折 ✓。 */
			function safeRegister(tag, options, component) {
				try {
					return ctx.slots.register(options, component);
				} catch (e) {
					return noteFail(tag, e);
				}
			}
			/** inject 也包一层：官方在槽已就绪时**同步**执行回调 ⇒ 回调里的异常会外抛 ✗。 */
			function safeInject(tag, slotName, fn) {
				try {
					return ctx.slots.inject(slotName, fn);
				} catch (e) {
					return noteFail(tag, e);
				}
			}

			// ── 固定行（侧栏「固定」的工作台）的状态：**必须排在下面那次 inject 之前** ──
			// ⚠ 官方 `inject` 回调在槽已就绪时**立刻同步**执行 ⇒ 回调里用到的 const/let 必须在场
			//   （否则 TDZ ReferenceError ⇒ 整个 install 炸 ✗）⇒ 这三行因此上移到这里 ✓。
			const LS_PINNED = "vssaros.wb.pinned";
			/** 固定行的 order 起点：官方 plugins=0 / schedules=10 ⇒ 11 起 ⇒ 正好落在「自动化任务」下方 ✓。 */
			const PINNED_ORDER_BASE = 11;
			const pinnedDisposers = new Map();   // route → { nav, main }
			/**
			 * 工作台宿主（`desktopWorkbenches`）。★ 2026-10-22 上移到这里：固定行同步（下面第一次 inject 里就会跑）
			 * 要用它解析第三方工作台（`wb:<身份>`）⇒ 声明必须先于那次 inject（否则 TDZ）。
			 */
			let wbService = null;

			// ── 侧栏「主页」那一行：**第一个注册**（2026-10-21）─────────────────────────
			// 为什么必须排第一：这是用户**唯一看得见**的入口 ⇒ 后面任何一处注册抛错都不能带走它 ✓
			//   （旧顺序它在最后 ⇒ 一处撞 key 就整行消失 ✗ —— 就是用户报的「主页丢失」）。
			// ⚠ 官方 list 槽的硬要求：必须写 id + order（不写 ⇒ 顺序无保证，守卫会报红）✓。
			safeInject("nav:主页行", SLOT_NAV, () => {
				const reg = safeRegister(
					"nav:主页行",
					{ name: SLOT_NAV, id: ENTRY_ID, order: ENTRY_ORDER, label: "主页" },
					EntryIcon,
				);
				if (reg) { REG.nav = true; }
				// 固定行顺手同步（官方不允许多余 inject：守卫按 inject 记注册项 ⇒ 只能并在这一个里 ✓）。
				try { syncPinnedRows(); } catch (e) { noteFail("nav:固定行", e); }
				return reg;
			});

			// 兜底：万一这一行没落地（竞态 / 槽当时还没就绪）⇒ 稍后再试一次（safeRegister ⇒ 撞了忽略）✓
			// ★ 2026-10-22（用户报障「重启 app 后左侧栏里固定的工作台图标消失」）：**这条兜底路径也必须
			//   同步固定行** —— 原来只有第一次 inject 的回调里调了 `syncPinnedRows()` ⇒ 第一次 inject 抛了
			//   （`safeInject` 记一笔就返回）时，固定行**永远不会被注册** ⇒ 清单还在、图标不在这 ✗。
			//   （`syncPinnedRows` 幂等：已注册的跳过、清单里没有的收掉 ⇒ 多调一次无害 ✓。）
			try {
				window.setTimeout(() => {
					if (REG.nav) { return; }
					safeInject("nav:主页行(重试)", SLOT_NAV, () => {
						const reg = safeRegister(
							"nav:主页行(重试)",
							{ name: SLOT_NAV, id: ENTRY_ID, order: ENTRY_ORDER, label: "主页" },
							EntryIcon,
						);
						if (reg) { REG.nav = true; }
						// 槽就绪时（inject 回调里）再同步一次 ⇒ 上面那次可能早于槽就绪而注册失败 ✗
						try { syncPinnedRows(); } catch (e) { noteFail("nav:固定行(重试)", e); }
						return reg;
					});
					try { syncPinnedRows(); } catch (e) { noteFail("nav:固定行(重试)", e); }
				}, 1500);
			} catch { /* 无 setTimeout */ }

			/** 「🗂 工作台」那行**固定开什么**：主页（见 `pickDashboardItem`）。 */
			function dashboardItem() {
				return pickDashboardItem(items);
			}

			// ── 会话就绪判定：点击那一刻读 DOM 事实（主包负责把会话打开，见文件头）─────────
			const sid = bridge && typeof bridge.sessionId === "string" && bridge.sessionId ? bridge.sessionId : null;
			function sessionOnScreen() {
				try {
					return !!(sid && document && typeof document.querySelector === "function"
						&& document.querySelector('[data-sidebar-right-session="' + sid + '"]'));
				} catch { return false; }
			}
			/**
			 * **任意**会话在屏就算"可用"。
			 *
			 * 为什么必须区分（2026-10-17 自查出的真 bug）：救援打开的是**另一条**会话，
			 * 而 `sessionOnScreen()` 只认绑定的那个 sid ⇒ 救援成功后它仍为 false ⇒
			 * 循环会一直重试到 90 秒、再误报一条"失败"诊断条 ✗✗。
			 * 官方右栏/页签只需要"屏幕上有一条会话"（`sidebarRight` 是 per-session 的）✓。
			 */
			function anySessionOnScreen() {
				try {
					return !!(document && typeof document.querySelector === "function"
						&& document.querySelector("[data-sidebar-right-session]"));
				} catch { return false; }
			}
			/**
			 * 中栏现在是不是**我们自己的工作台面板**（主页 / 工作台页签）？
			 *
			 * ★★ 2026-10-23（用户报「主页显示过程中，page 突然被切换成了聊天输入框」）：
			 *   下面的"自动进最近会话"救援是**按 DOM 判断**"有没有会话在屏"的；中栏被我们的面板占着时，
			 *   聊天 DOM 天然不在 ⇒ 救援判定"没会话" ⇒ `uiWorkspace.openSession()` ⇒
			 *   官方 `replaceMain(…, 'reveal')` 里那句 `selectPanel(null)` ⇒ **把主页换回聊天** ✗✗。
			 *   所以救援 / 抢焦点这一类**必须先排除"用户正在看我们的面板"**。
			 *   用面板自己的根标记（只在被显示时才挂载）⇒ 等价于"中栏是我们的键"，不碰官方未公开接口 ✓。
			 */
			function workbenchPanelActive() {
				try {
					return !!(document && typeof document.querySelector === "function"
						&& (document.querySelector("[data-vssaros-wb-tabs]") || document.querySelector("[data-vssaros-wb-full]")));
				} catch { return false; }
			}

			// ── 停在 hero（无会话在屏）时的兜底：**自动进最近一个会话**（2026-10-17 真机三条反馈的同一真因）─
			// 「缺右栏伸缩按钮」「点工作台条目右栏没内容」「输入框不能打字」都发生在 **hero**（无会话）：
			// 右栏页签（sidebarRight.openTab）与官方伸缩按钮（conversation.session.header.corner）
			// 都是 **session 作用域** —— hero 下结构上就没有可挂载的位置 ✗。
			// 从非聊天上下文弹出的全窗（bridge.sessionId 为空）因此必然坏在这一层 ⇒ 这里静默兜底：
			// 轮询会话快照，挑**最近更新**的一条，对齐工作区后 openSession（与聊天主包同顺序 ✓）。
			// 一旦成功就不再干预（用户之后自己切换会话不受影响 ✓）。
			// ★ 2026-10-17 二次真机（「输入框无法输入信息」）：**有绑定值也兜**。
			//   官方 hero 输入框在 `inert` 时是禁用的（`dsh-client-ui-conversation/lib/client.js:17587`：
			//   `inert = sessionId === undefined || (hero && chipTitle === undefined)`）⇒ 用户看到的
			//   "不能打字"永远是"没进会话"的症状。而 `bridge.sessionId` 非空**不代表那个会话开得出来**
			//   （Host 侧已不存在 / roster 不认）——主包轮询 120s 后放弃，界面就停死在禁用的 hero ✗。
			//   ⇒ 两种态都兜：无绑定 ⇒ 立刻救；有绑定但 15s 还没在屏 ⇒ 也救（挑最近更新的会话）。
			if (typeof window.setInterval === "function" && typeof document !== "undefined") {
				const startedAt = Date.now();
				const WAIT_FOR_BOUND_MS = 15000;   // 有绑定值时先给主包这些时间（正常几百 ms 就开出来 ✓）
				const RESCUE_GIVE_UP_MS = 90000;
				let lastAttemptAt = 0;
				let announced = false;
				let gaveUp = false;
				/** `sessions.create` 兜底已试次数（上限 2：别把会话列表刷出一堆空会话 ✗） */
				let createAttempts = 0;
				// ★ 2026-10-17：连接闸门**必与主包共享**（`client.js` 的 connectFor/navigate 用同一个
				//   `window.__vssarosNav`）。各自维护 pending ⇒ 两边交替 openWorkspace 互相 abort，
				//   roster 永远空、openSession 永远 "unknown session"（真机 `roster:0 / giveUps:1` ✗）。
				const navState = (window.__vssarosNav = window.__vssarosNav || { connecting: null, aligned: null });
				const timer = window.setInterval(() => {
					// ★ 停止条件是"**任意**会话在屏"（救援开的是另一条；见 anySessionOnScreen 的注释 ✓）
					if (anySessionOnScreen()) {
						window.clearInterval(timer);
						if (state.rescue) { state.rescue.done = true; }
						return;
					}
					// ★★ 2026-10-23：中栏是**我们自己的工作台面板**（主页 / 工作台页签）⇒ **不救**。
					//   否则 openSession 会把中栏换回聊天（官方 replaceMain('reveal') ⇒ selectPanel(null)）
					//   ⇒ 用户看到"主页显示到一半突然变成聊天输入框" ✗。等他回到会话页，下一轮照常救 ✓
					if (workbenchPanelActive()) {
						if (state.rescue) { state.rescue.skipped = "workbench-panel"; }
						return;
					}
					const waited = Date.now() - startedAt;
					if (sid && waited < WAIT_FOR_BOUND_MS) { return; }
					if (waited > RESCUE_GIVE_UP_MS) {
						// ★ 2026-10-17 第二轮真机：roster 可能**晚到**（拉取被下一次覆盖 / 慢）⇒
						//   从前这里直接 clearInterval，晚到的数据再没人消费，界面永久停在 hero ✗。
						//   ⇒ 诊断条只亮一次，重试降频到 30s **继续尝试**（自愈）。
						if (!gaveUp) { gaveUp = true; showRescueFailure(); }
						if (Date.now() - lastAttemptAt < 30000) { return; }
					}
					if (Date.now() - lastAttemptAt < 3000) { return; }   // 打开尝试节流（成功与否看下一轮 anySessionOnScreen ✓）
					lastAttemptAt = Date.now();
					try {
						const snap = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
						const byId = (snap && snap.byId) || {};
						const archived = (snap && snap.archivedSessionIds) || [];
						const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
						const wsSnap = ws && ws.list ? ws.list.getSnapshot() : null;
						const wsItems = ((wsSnap && wsSnap.items) || []).filter((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.length > 0);
						// ★★ 2026-10-17 真机自证给出的真因：**全窗页面的 `ctx.sessions.list` roster 恒为 0**
						//   （chat 视图里 opened=true，同一 Host；见主进程日志的 page surface 快照）。
						//   而 roster 只装"已 retain"的会话 ⇒ 只从 roster 挑候选＝永远挑不到 ✗✗。
						//   候选必须从 **workspaces 快照**（它带 sessionIds，且与页面侧栏同源 ✓）里取：
						//   ① 优先"绑定 sid 所在的条目"；② 否则取会话数最多的条目；③ 再取它的最后一个会话。
						//   顺序也必须是 **openWorkspace → openSession**：前者才会把该工作区的会话载入 roster ✓。
						let owner = sid ? wsItems.filter((w) => w.sessionIds.indexOf(sid) >= 0)[0] : null;
						if (!owner && wsItems.length > 0) {
							owner = wsItems.slice().sort((a, b) => b.sessionIds.length - a.sessionIds.length)[0];
						}
						const bestId = (sid && (!owner || owner.sessionIds.indexOf(sid) >= 0) ? sid : null)
							|| (owner ? owner.sessionIds[owner.sessionIds.length - 1] : null)
							|| pickLatestSessionId(byId, archived);
						// ★ 页面自证（宿主日志会打出来）：救援每次尝试都留证 —— 这是"为什么没进会话"的唯一线索 ✓
						state.rescue = {
							at: Date.now(),
							boundSid: sid || null,
							picked: bestId || null,
							roster: Object.keys(byId).length,
							workspaces: wsItems.length,
							owner: owner ? owner.workspaceId : null,
							waitedMs: waited,
						};
						if (!bestId) {
							state.rescue.error = "既没有 workspaces 条目也没有 roster";
							return;
						}
						if (typeof document !== "undefined" && document.body) {
							document.body.dataset.vssarosAutoEnter = "tried:" + bestId;
						}
						const open = () => {
							// 连接在飞时**不发导航**（openSession 会 beginNavigation ⇒ abort 连接 ✗）
							if (navState.connecting) { return; }
							/**
							 * 失败处理 + **roster 空时的建会话兜底**。
							 *
							 * ★★ 2026-10-18 真机日志定位：`uiWorkspace.openSession()` 返回的是
							 * **Promise**，而我们从没接过它 ⇒ `sessions.retain: unknown session` 的
							 * reject 变成"未处理的 Promise 拒绝" ⇒ 界面零反应、`rescue.error` 也是空
							 * （日志里 `attempts=68 / openRetries=0 / lastOpenError=null` 正是这个形态 ✗✗）。
							 * 而同一份日志还证明：`openWorkspace` **能成功**（无 openWorkspaceError）、
							 * `workspaces` 快照有 4 条 —— 只有 `sessions.refresh()` 永不返回（4 次超时、
							 * roster 恒 0）⇒ **会话 catalog 这条路在这个页面就是死的**，
							 * 必须改走能通的 RPC：`sessions.create({ workspaceId })` 直接建一条会话再打开 ✓。
							 */
							const onRejected = (err) => {
								const msg = String((err && err.message) || err || "");
								if (!msg) { return; }
								if (state.rescue) { state.rescue.openSessionError = msg; }
								if (/unknown session/i.test(msg)) { createAndOpen(); return; }
								if (!announced) { announced = true; notify("warn", "打开会话失败：" + msg); }
							};
							const createAndOpen = () => {
								const svc = ctx.sessions;
								if (createAttempts >= 2 || !svc || typeof svc.create !== "function") { return; }
								const workspaceId = owner && owner.workspaceId;
								if (!workspaceId) { return; }
								createAttempts += 1;
								if (state.rescue) { state.rescue.createAttempts = createAttempts; }
								void Promise.resolve(svc.create({ workspaceId })).then((res) => {
									const id = typeof res === "string" ? res
										: (res && (res.sessionId || res.id || (res.session && res.session.id))) || null;
									if (state.rescue) { state.rescue.created = id; }
									if (!id) { return; }
									if (typeof document !== "undefined" && document.body) {
										document.body.dataset.vssarosAutoEnter = "created:" + id;
									}
									// 新会话必然在 roster 里（create 的返回值就是 retained 的 id）⇒ 直接开
									void Promise.resolve(ctx.uiWorkspace.openSession(id)).catch((e) => {
										if (state.rescue) { state.rescue.openCreatedError = String((e && e.message) || e); }
									});
								}).catch((e) => {
									if (state.rescue) { state.rescue.createError = String((e && e.message) || e); }
								});
							};
							try {
								const r = ctx.uiWorkspace.openSession(bestId);
								if (r && typeof r.then === "function") {
									r.then(() => { if (state.rescue) { state.rescue.openAccepted = true; } }, onRejected);
								}
							} catch (e) { onRejected(e); }
						};
						// ★ 2026-10-20：不再先 `openWorkspace(owner)` —— 官方实现是
						//   `connectBlank(id, undefined) → sessions.create({ workspaceId })`，**每次都新建空会话**
						//   （这条救援每 3s 一轮，卡住时能刷出一串空会话 ✗）。工作区由选中会话推出，直接 open 即可；
						//   真打不开（unknown session）时才由 createAndOpen 兜底建一条（最多 2 次，有上限 ✓）。
						if (!navState.connecting) {
							open();
						}
						if (!announced) {
							announced = true;
							notify("info", sid ? "会话打开超时，已切换到最近一次会话" : "弹窗未绑定会话，已进入最近一次会话");
						}
					} catch (e) {
						state.rescue = { at: Date.now(), error: "rescue threw: " + String((e && e.message) || e) };
					}
				}, 1000);
			}

			/**
			 * 救援失败的**可见诊断条**（仅在全窗 hero 卡死时出现）。
			 *
			 * 为什么要有：用户报障只能给截图，而"没进会话"可能坏在四个不同环节
			 * （视图无 sessionId / preload 没给 / roster 不认该会话 / Host 侧已删除），
			 * 单看界面全是同一张 hero ⇒ 必须把判据摆到脸上 ✓。
			 * `state` 里的 `opened/attempts/openRetries/lastOpenError` 由主包维护（同一 shell.state）。
			 */
			function showRescueFailure() {
				try {
					if (typeof document === "undefined" || !document.body) { return; }
					if (document.querySelector("[data-vssaros-rescue]")) { return; }
					const st = state || {};
					const lines = [
						"弹窗未能进入会话（处于 hero：输入框被官方 inert 禁用）",
						"view sessionId = " + (sid || "(空)"),
						"session on screen = " + (anySessionOnScreen() ? "yes" : "no"),
						"attempts=" + (st.attempts ?? 0) + " openRetries=" + (st.openRetries ?? 0) + " giveUps=" + (st.openGiveUps ?? 0),
						"lastOpenError = " + (st.lastOpenError || st.lastError || st.error || "(无)"),
						"autoEnter = " + ((document.body && document.body.dataset.vssarosAutoEnter) || "(未触发)"),
					];
					const box = document.createElement("div");
					box.setAttribute("data-vssaros-rescue", "1");
					box.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9999;max-width:min(560px,calc(100vw - 24px));padding:10px 12px;border-radius:10px;background:rgba(170,52,52,.94);color:#fff;font:12px/1.6 Consolas,monospace;white-space:pre-wrap;box-shadow:0 8px 24px rgba(0,0,0,.4)";
					box.textContent = lines.join("\n");
					document.body.appendChild(box);
				} catch { /* 诊断条本身绝不能影响别的 ✓ */ }
			}

			// ── 表面参数（同一页两种载体）─────────────────────────────────────────────────
			// ⚠ 与 IDE 侧同口径：宿主注入 `?surface=sideview|editor`（dshPluginPage.ts:65-110），
			//   我们自持的页面据此分版（kb：sideview=目录 / editor=正文；dashboard：sideview=摘要）。
			//   不支持该参数的页面**会忽略它**（照旧渲染完整页）⇒ 无副作用 ✓。
			function withSurface(route, surface) {
				const r = String(route || "/");
				return r + (r.indexOf("?") >= 0 ? "&" : "?") + "surface=" + surface;
			}

			// ── 页面本体（右侧栏页签体；keyed slot，key = tab kind = 条目 id）───────────
			// ⚠ 右栏 = **侧栏版**（?surface=sideview）：窄容器里只放摘要/目录，主视图交给中栏 ✓
			//   （与 IDE 的「sideview 摘要 + editorpane 完整页」同构 ✓）。
			function PageBody(it) {
				return function WbPageBody() {
					return react.createElement("iframe", {
						src: withSurface(it.route, "sideview"), title: it.name,
						style: { display: "block", flex: "1 1 auto", minHeight: 0, height: "100%", border: 0, width: "100%", background: "transparent" },
					});
				};
			}
			for (const it of DEFAULT_ITEMS) {
				// ⚠ 这是 **session 作用域**的 keyed 槽（`sidebar.right.pane.tab`）⇒ 最容易被撞 key ⇒
				//   官方会抛「already has an entry for key …」⇒ 必须走 safeInject/safeRegister（不许外抛）✓
				//   （旧写法是裸调用：一旦这里抛了，**后面所有注册（含「主页」行）全被跳过** ✗）。
				safeInject("rightTab:" + it.id, SLOT_RIGHT_TAB, () => safeRegister(
					"rightTab:" + it.id, { name: SLOT_RIGHT_TAB, key: it.id }, PageBody(it)));
				// 页签类型登记（schedule 同款通路；effect 包裹 ⇒ 服务缺失时只影响这条，不拖垮 install ✓）。
				try {
					ctx.effect(() => ctx.sidebarRightTabs.register({
						id: it.id, kind: it.id, priority: "extension", title: () => it.name,
					}), "vssaros-wb:" + it.id);
				} catch (e) { noteFail("tabType:" + it.id, e); }
			}

			/** 打开一个工作台条目：优先右侧栏页签；未就绪/失败 ⇒ notify 明示（不静默 ✗）。 */
			function openItem(it, opts) {
				// `skipRight`：只记“最后打开的工作台”、**不开右栏**
				//   （2026-10-21 提速：右栏那份目录页**按需**才开 —— 页面没有 sideview 变体时
				//    白渲染一份重量级完整页 ⇒ 主页那种慢一半 ✗）
				const skipRight = !!(opts && opts.skipRight);
				// 记一下"最后打开的工作台"（2026-10-21 起侧栏不再有「当前名」那一行，纯粹留作下次
				// 启动器里做排序/记忆用；读不到也不影响任何行为 ✓）。
				currentId = it.id;
				saveCurrent(it.id);
				if (skipRight) { return; }
				const openRight = () => {
					if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === "function") {
						try {
							ctx.sidebarRight.openTab(it.id);
							return true;
						} catch (e) {
							notify("warn", it.name + " 打开失败：" + String((e && e.message) || e));
							return false;
						}
					}
					return false;
				};
				if (anySessionOnScreen()) { if (openRight()) { return; } }
				// ★ 2026-10-21 真机（「点主页没反应」）：dsh 窗口里**右栏默认收起** ⇒
				//   `[data-sidebar-right-session]` 不在 DOM ⇒ 旧判据直接放弃 ⇒ 用户看到"点了没反应" ✗。
				//   修法：先把右栏**撑开**（官方那个 expand 按钮）再开页签；撑不开才如实提示 ✓。
				//   （中栏那一份由 PageOpenPanel 自己渲染 ⇒ 即使右栏开不了，中栏也有内容可看 ✓）
				try {
					const expand = document.querySelector("[data-sidebar-right-expand]");
					if (expand && typeof expand.click === "function") {
						expand.click();
						window.setTimeout(() => { if (!openRight()) { notify("warn", it.name + " 的侧栏页签开不了（当前窗口没有可挂载的会话）"); } }, 180);
						return;
					}
				} catch { /* 老宿主没有那个按钮 ⇒ 下面兜底 */ }
				if (!openRight()) {
					notify("warn", "当前窗口没有会话，" + it.name + " 的侧栏页签无处挂载；请先从会话入口进一段会话");
				}
			}
			function notify(kind, text) {
				if (bridge && typeof bridge.notify === "function") {
					try { bridge.notify(kind, text); } catch { /* 通知失败不影响别的 */ }
				}
			}

			// ── 中栏面板 = **中转**：挂载即打开对应页面 + 弹回会话（不占用聊天框 ✓）────────────
			// ★ 2026-10-21（用户两连击，同一处病根）：
			//   ①「点击工作台要求直接打开主页的 page」⇒ `ENTRY_ID` 那行**固定开主页**，不再弹启动器；
			//   ②「点击知识库按钮错误的弹出了工作台 menu」⇒ 原先第二行（`CURRENT_ID`，显示当前工作台名）
			//      和 ① 共用同一个 `LauncherPanel`（挂载即 `openLauncher()`）⇒ 点「知识库」弹出的是
			//      工作台网格 ✗。那一行**已按用户要求整行删除**（它会永远显示成「主页」）⇒ 现在只有
			//      一条路径：开主页 ✓。启动器（11 格切换 + 排序）改挂**右键** ⇒ 能力不丢 ✓。
			// ── 中栏面板 = **完整页**（editorpane 等价）───────────────────────────────
			// ★ 2026-10-21（用户：「点击主页没有显示 主页 editorpane 和 sidebar page」）：
			//   dsh 窗口里点「主页」现在要**同时**给出两个载体（同 IDE 的「sideview 摘要 + editorpane 完整页」）：
			//     · 中栏 = 完整页（iframe `?surface=editor`）—— 取代聊天区（顶部有「← 返回会话」可回 ✓）
			//     · 右栏 = 侧栏版（iframe `?surface=sideview`）—— 由 openItem 开页签 ✓
			//   ⚠ 这与 2026-10-17「工作台页面开在右栏、不占中栏」的口径**相反** ⇒ 以后者为准（用户最新明确要求）✓
			function PageOpenPanel(pick) {
				return function WbPageOpenPanel() {
					react.useEffect(() => {
						try {
							openItem(pick());
						} catch (e) {
							notify("warn", "打开失败：" + String((e && e.message) || e));
						}
					}, []);
					let it = null;
					try { it = pick(); } catch { /* 取名失败只影响标题 */ }
					const name = (it && it.name) || "工作台";
					return react.createElement("div", {
						style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
						"data-vssaros-wb-full": "1",
					},
						react.createElement("div", {
							style: {
								flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "5px 10px",
								borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
								fontSize: 12,
							},
						},
							react.createElement("button", {
								type: "button",
								style: {
									border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))", background: "transparent",
									color: "inherit", borderRadius: 6, padding: "3px 9px", cursor: "pointer", fontSize: 12,
								},
								"data-vssaros-wb-back": "1",
								onClick: () => {
									try {
										if (ctx.layout && typeof ctx.layout.selectPanel === "function") {
											ctx.layout.selectPanel(null);   // null = 回到 Conversation ✓
										}
									} catch { /* 回不去就留在本页（下面的内容仍可用） */ }
								},
							}, "← 返回会话"),
							react.createElement("span", { style: { opacity: .85 } }, name),
							react.createElement("span", { style: { opacity: .5, fontSize: 11 } }, "完整页（editorpane）"),
						),
						react.createElement("iframe", {
							src: withSurface((it && it.route) || "/", "editor"), title: name,
							style: { display: "block", flex: "1 1 auto", minHeight: 0, height: "100%", border: 0, width: "100%", background: "transparent" },
						}),
					);
				};
			}
			// ── 中栏 = **带页签的工作台面板**（2026-10-21 用户：「desktop 中，打开的工作台，中间栏中，
			//    要有独立的页签」）──────────────────────────────────────────────────────
			//   · 每个打开过的工作台在中间栏顶部有**自己的页签**（可切换 / 可关闭 ✓）
			//   · 第一个页签恒是「💬 会话」⇒ 点它回聊天（selectPanel(null)）✓
			//   · 打开集合持久化（localStorage）⇒ 重开窗口还在 ✓
			//   ⚠ dsh 的 `main` 槽是**单选**（selectPanel 只能显示一个面板）⇒ 页签条由**我们自己**画在
			//     面板内部（官方没有这个页签槽）✓；IDE 侧不需要（那边有原生编辑器页签 ✓）。
			const LS_TABS = "vssaros.wb.tabs";
			const LS_TAB_ACTIVE = "vssaros.wb.tabs.active";
			const TAB_CHANGE_EVENT = "vssaros-wb-tabs-change";
			function loadTabs() {
				try {
					const raw = window.localStorage && window.localStorage.getItem(LS_TABS);
					const arr = raw ? JSON.parse(raw) : [];
					return Array.isArray(arr) ? arr.filter(t => t && t.id && (t.route || t.wbId)) : [];
				} catch { return []; }
			}
			function saveTabs(list) {
				try { window.localStorage && window.localStorage.setItem(LS_TABS, JSON.stringify(list)); } catch { /* 私密模式 */ }
			}
			function loadActiveTab() {
				try { const v = window.localStorage && window.localStorage.getItem(LS_TAB_ACTIVE); return typeof v === "string" ? v : ""; } catch { return ""; }
			}
			function saveActiveTab(id) {
				try { window.localStorage && window.localStorage.setItem(LS_TAB_ACTIVE, String(id || "")); } catch { /* 私密模式 */ }
			}
			let openTabs = loadTabs();
			let activeTabId = loadActiveTab();
			// ── 提速三件（2026-10-21 用户：「主页 page 开启太慢了」）──────────────────────
			//   ① loadedTabs：**已打开过的页签**（iframe 一旦加载就**保活**，切页签只切 display ⇒
			//      第二次打开**零网络请求、零重渲染** ✓；没打开过的**不预载** ⇒ 首次只加载一份 ✓）。
			//   ② catalogTabs：探测到**真的有目录版**（?surface=sideview）的工作台 ⇒ 才可以开右栏 ✓。
			//   ③ noCatalogTabs：探测到**没有**目录版的工作台 ⇒ **不开右栏**（否则白渲染一份完整页 ✗）。
			const loadedTabs = new Set();
			/** 刚由 `openRegisteredWorkbench` 激活、还没被面板挂载确认过的动态页签 id（见 makeTabPanel 的挂载 effect）。 */
			let pendingDynamicOpen = "";
			/**
			 * 刚由**用户显式请求**切到的页签 id（页签条点击 / `ensureTab` 调用方）。
			 *
			 * ★★ 2026-10-24 修复（用户报：「首次点击其他页签时，会默认切中 主页 页签」）：
			 *   中栏面板（`makeTabPanel`）是**第一次被 `selectPanel(ENTRY_ID)` 显示时才挂载**的，
			 *   而那一下显示几乎总是"用户刚点了某个页签"造成的 —— 点击里已经写好
			 *   `activeTabId = t.id`，可挂载 effect 又跑 `ensureTab(pick())`（`pick` 恒是主页）
			 *   ⇒ `activeTabId` 被改回主页 ⇒ 用户第一次点的那一下**被吃掉**（第二次才正常，
			 *   因为面板已在屏、effect 不再执行 —— 正好是"只有首次"的现象）✗。
			 *   ⇒ 用一个"意图标记"区分两种挂载：
			 *     · 有人显式要求切某页（本标记非空）⇒ **不要覆盖**，尊重它 ✓；
			 *     · 侧栏「🏠 主页」那行：宿主直接 `selectPanel(ENTRY_ID)`，**不经过** `ensureTab`
			 *       ⇒ 标记为空 ⇒ 仍按 `pick()` 开主页 ✓（原有行为一字不变）。
			 */
			let pendingTabOpen = "";
			// ── ★ 2026-10-22（工作台重构 P1，方案 A，doc/workbench-refactor-plan.md §6.2）─────────
			//   已迁成 React 的工作台（向宿主 `desktopWorkbenches` 注册过的）在页签里**直接渲染**
			//   宿主的 `View`，不再开 iframe；页签条、保活、持久化一概不变。没迁的照旧走 iframe ✓。
			//   宿主可能晚于本 chunk 加载 ⇒ 可选注入；它到场 / 有新注册时发同一个页签刷新事件。
			//   对应规则：路由必须是**不带查询串**的 `/x/<module>/`（`?view=tiles` 这类变体仍走 iframe）。
			const wbIdOf = (t) => {
				// ★ 2026-10-22：第三方 / 动态注册的工作台没有路由 ⇒ 页签直接带 `wbId`（宿主身份 owner/repo）
				if (t && typeof t.wbId === "string" && t.wbId) { return t.wbId; }
				const m = /^\/x\/([a-z][a-z0-9-]*)\/$/.exec(String((t && t.route) || "")); return m ? "vssaros/" + m[1] : "";
			};
			const wbFor = (t) => {
				const id = wbIdOf(t);
				return id && wbService && typeof wbService.has === "function" && typeof wbService.View === "function" && wbService.has(id) ? id : "";
			};
			try {
				if (typeof ctx.inject === "function") {
					ctx.inject(["desktopWorkbenches"], (c) => {
						const svc = c.desktopWorkbenches;
						const fire = () => { try { window.dispatchEvent(new Event(TAB_CHANGE_EVENT)); } catch { /* 无 window */ } };
						// 第三方工作台注册得比宿主晚 ⇒ 每次宿主变化都补一次固定行（只补缺的，已有的不动）
						const syncPinned = () => { try { syncPinnedRows(); } catch (e) { noteFail("nav:固定行(宿主)", e); } };
						wbService = svc;
						fire();
						syncPinned();
						const off = svc && typeof svc.subscribe === "function" ? svc.subscribe(fire) : null;
						const offPinned = svc && typeof svc.subscribe === "function" ? svc.subscribe(syncPinned) : null;
						if (typeof c.effect === "function") {
							c.effect(() => () => { if (off) { off(); } if (offPinned) { offPinned(); } if (wbService === svc) { wbService = null; } fire(); });
						}
					});
				}
			} catch (e) { noteFail("inject:desktopWorkbenches", e); }
			const catalogTabs = new Set();
			const noCatalogTabs = new Set();
			/** 页签集合变了 ⇒ 通知已挂载的面板重画（状态在模块级 ⇒ React 不知道 ⇒ 自己发事件 ✓）。 */
			function bumpTabs() {
				try { window.dispatchEvent(new CustomEvent(TAB_CHANGE_EVENT)); } catch { /* 老宿主没有 CustomEvent ⇒ 顶多多画一次 */ }
			}
			/** 打开（并激活）一个工作台的页签 ✓ */
			function ensureTab(it) {
				if (!it || !it.id) { return null; }
				if (!openTabs.filter(t => t.id === it.id)[0]) {
					openTabs = openTabs.concat([Object.assign({ id: it.id, name: it.name, ico: it.ico, route: it.route }, it.wbId ? { wbId: it.wbId } : {})]);
					saveTabs(openTabs);
				}
				activeTabId = it.id;
				saveActiveTab(activeTabId);
				// ★ 2026-10-24：这是**显式**切页（启动器 / 主页卡片「打开」/ 第三方工作台）
				//   ⇒ 记意图，避免随后挂载的中栏面板再把活动页签抢回「主页」（详见 pendingTabOpen 注释）。
				pendingTabOpen = it.id;
				bumpTabs();
				return it;
			}
			/**
			 * ★ 2026-10-22：打开一个**已注册进工作台宿主**的工作台（第三方 / 从市场装的）。
			 * 页签 id = `wb:<身份>`，内容 = 宿主 View；挂在「主页」那个中栏面板里（页签条与保活同一套）。
			 * 返回 false = 宿主里没有它（未装 / 未重启 / 被停用）——调用方据此回落。
			 */
			function openRegisteredWorkbench(id) {
				const wbId = String(id || "").toLowerCase();
				if (!wbId || !wbService || typeof wbService.has !== "function" || !wbService.has(wbId)) { return false; }
				const snap = typeof wbService.getSnapshot === "function" ? wbService.getSnapshot() : null;
				const info = snap && Array.isArray(snap.workbenches) ? snap.workbenches.filter(w => w.id === wbId)[0] : null;
				const it = { id: "wb:" + wbId, wbId, name: (info && info.title) || wbId, ico: wbIconEmoji(info && info.icon), route: "" };
				ensureTab(it);
				pendingDynamicOpen = it.id;
				try { if (ctx.layout && typeof ctx.layout.selectPanel === "function") { ctx.layout.selectPanel(ENTRY_ID); } }
				catch (e) { notify("warn", "打开失败：" + String((e && e.message) || e)); return false; }
				return true;
			}
			try { window.__vssarosOpenWorkbench = openRegisteredWorkbench; } catch { /* window 不可写 */ }
			/** 宿主里已注册、且不是内置模块的工作台（启动器里列出来；身份 = owner/repo）。 */
			function registeredExtras() {
				const snap = wbService && typeof wbService.getSnapshot === "function" ? wbService.getSnapshot() : null;
				return snap && Array.isArray(snap.workbenches) ? snap.workbenches.filter(w => w && w.id && !String(w.id).startsWith("vssaros/")) : [];
			}
			function closeTab(id) {
				openTabs = openTabs.filter(t => t.id !== id);
				saveTabs(openTabs);
				if (activeTabId === id) {
					activeTabId = openTabs.length ? openTabs[openTabs.length - 1].id : "";
					saveActiveTab(activeTabId);
				}
				bumpTabs();
			}
			/** 统一入口：开一个工作台（页签 + 中栏 + 右栏 catalog）✓ */
			function openWorkbenchTab(it) {
				if (!it) { return; }
				ensureTab(it);
				try {
					if (ctx.layout && typeof ctx.layout.selectPanel === "function") {
						ctx.layout.selectPanel(ENTRY_ID);
					}
				} catch (e) { notify("warn", "打开失败：" + String((e && e.message) || e)); }
				// ⚠ 不在这里开右栏：页面**没有**目录版时那是一份纯浪费的重页面（主页慢一半的元凶）✓
				//   ⇒ 右栏由 iframe 的 onLoad 探测决定（probeCatalog ✓）。
				try { openItem(it, { skipRight: true }); } catch { /* 记当前项失败也不影响中栏 ✓ */ }
			}

			/**
			 * 探测这个页面**有没有目录版**：iframe 与页面**同源** ⇒ 能读它的 body 标记 ✓。
			 *   · body 带 data-vssaros-surface（= 它认 ?surface= 分版）⇒ 才有目录版 ⇒ 开右栏 ✓
			 *   · 不带 ⇒ 它**没有**目录版 ⇒ **不开右栏**（否则右栏那份是同一页的完整副本 ⇒
			 *     主页/会话这种重页面会**白渲染两遍** ⇒ 慢一半 ✗ —— 2026-10-21 真机报障）✓
			 */
			function probeCatalog(t, ev) {
				try {
					const doc = ev && ev.target && ev.target.contentDocument;
					const body = doc && doc.body;
					const surface = body ? String(body.getAttribute("data-vssaros-surface") || "") : "";
					if (!surface) { noCatalogTabs.add(t.id); return; }
					catalogTabs.add(t.id);
					try { openItem(t); } catch { /* 右栏开不了不影响中栏 ✓ */ }
				} catch { /* 读不到（未加载完/跨源）⇒ 不开右栏 ✓ */ }
			}

			/**
			 * 常驻页签条（2026-10-21 用户报「点击会话后，页签都消失了」）。
			 *
			 * 病根：页签条原来长在**中栏面板**里，而「💬 会话」那一页是官方的**对话面板**
			 * （`main` 的 `conversation` 条目）⇒ 点它走 `selectPanel(null)` ⇒ 我们的面板被卸载
			 * ⇒ 页签条跟着消失 ✗。
			 * 修法：页签条挂到根级**常驻**槽 `shell.overlay`（`kind: list, scope: root`，layout 外壳
			 * 每帧都会渲染），自己按**中栏列的矩形**定位（`[data-rightbar-col]` 的**前一个兄弟** = 中栏），
			 * 并给中栏加 `padding-top: STRIP_H` 让出高度 ⇒ 对话 / 工作台怎么切它都在 ✓。
			 * ⚠ 面板里**不再**画第二条（同屏两条页签条 ✗）—— 守卫按"锚点只出现一次"钉住 ✓。
			 */
			function TabStrip() {
				const [ver, setVer] = react.useState(0);
				const hostRef = react.useRef(null);
				const geo = react.useRef({ ok: false, left: 0, top: 0, width: 0 });

				// 页签集合 / 活动页签变化 ⇒ 重画（状态在模块级，React 不知道 ⇒ 自己发事件 ✓）
				react.useEffect(() => {
					const rerender = () => setVer((v) => v + 1);
					window.addEventListener(TAB_CHANGE_EVENT, rerender);
					return () => window.removeEventListener(TAB_CHANGE_EVENT, rerender);
				}, []);

				// ★ 2026-10-23：中栏被**别处**切走（点会话 / 官方 `replaceMain` / 任何 selectPanel）时，
				//   页签条必须跟着把高亮还给「会话」—— 否则用户看到"主页 高亮着、内容却是聊天" ✗。
				//   ⚠ 只对齐**显示**，不改 `activeTabId`（用户再点那个页签仍会 selectPanel 回来 ✓）。
				//   面板在不在屏用它的根标记判断（只有被显示时才挂载）。
				react.useEffect(() => {
					if (typeof window.setInterval !== "function") { return; }
					let last = workbenchPanelActive();
					const t = window.setInterval(() => {
						const now = workbenchPanelActive();
						if (now === last) { return; }
						last = now;
						setVer((v) => v + 1);
					}, 400);
					return () => window.clearInterval(t);
				}, []);

				// 量中栏列：overlay 层铺满整帧 ⇒ 用**相对**坐标；侧栏拖拽/折叠、窗口缩放都重算 ✓
				react.useEffect(() => {
					let raf = 0;
					let ro = null;
					let disposed = false;
					/**
					 * 找「overlay 层」与「中栏列」。
					 *
					 * ★ 2026-10-21 真机取证（窗口模式页签整条不显示，根因就在这里）：
					 *   官方 DOM 实际是 **三层**：
					 *     <div class="…overlayLayer" data-shell-overlay="true">   ← overlay 层（铺满整帧）
					 *       <div data-slot="shell.overlay" style="display:contents">  ← 槽容器（**无盒**）
					 *         <div data-vssaros-wb-tabstrip>                    ← 我们的组件
					 *   而旧实现用 `el.parentElement` 当 overlay 层 ⇒ 拿到的是**槽容器**
					 *   （`display:contents` ⇒ `getBoundingClientRect()` 恒为 0×0），
					 *   再 `host.parentElement` 当帧容器 ⇒ 拿到的是 **overlay 层**
					 *   ⇒ 在里面 `querySelector("[data-rightbar-col]")` **必然为 null**
					 *   （右栏不在 overlay 层里）⇒ 定位失败 ⇒ `display:none` ⇒ **整条页签条消失** ✗。
					 *
					 * 修法：**不靠父子链猜层级** ——
					 *   ① overlay 层用 `closest("[data-shell-overlay]")` 找（跨过无盒的槽容器 ✓）；
					 *   ② 中栏列用**全局**查右栏 + 它的**前一个兄弟**（官方 grid：leading / center /
					 *      rightbar / bottom / overlay / side ⇒ 中栏正是右栏的前一个兄弟 ✓）；
					 *   ③ 前者找不到时回退：在帧容器里挑**最宽**的那一列（排除右栏/底部/overlay/侧栏）。
					 */
					const locate = () => {
						const el = hostRef.current;
						if (!el) { return null; }
						// ① overlay 层（跨过 display:contents 的槽容器）
						const host = (typeof el.closest === "function" ? el.closest("[data-shell-overlay]") : null)
							|| document.querySelector("[data-shell-overlay]");
						if (!host) { return null; }
						// ② 中栏列 = 右栏的前一个兄弟（全局查：右栏不在 overlay 层里）
						const rightbar = document.querySelector("[data-rightbar-col]");
						let center = rightbar ? rightbar.previousElementSibling : null;
						if (!center) {
							// ③ 回退：帧容器里挑最宽的一列（排除右栏 / 底部 / overlay / 侧栏）
							const frame = host.parentElement;
							if (frame && frame.children) {
								let best = null;
								let bestW = 0;
								for (const child of frame.children) {
									if (!child || typeof child.hasAttribute !== "function") { continue; }
									if (child.hasAttribute("data-rightbar-col") || child.hasAttribute("data-shell-bottom")
										|| child.hasAttribute("data-shell-overlay") || child.hasAttribute("data-side")) { continue; }
									const w = child.getBoundingClientRect().width;
									if (w > bestW) { bestW = w; best = child; }
								}
								center = best;
							}
						}
						return center ? { host, center } : null;
					};
					const measure = () => {
						if (disposed) { return; }
						const hit = locate();
						if (!hit) {
							// 诊断：dsh 升级后若 DOM 结构变了，页签条会**整条不显示**（`display: none`）——
							// 那时靠这个标记 + 日志才查得出来（否则现象只是"页签没了" ✗）。
							state.wbStrip = { ok: false, reason: "center column / overlay host not found" };
							return;
						}
						const hostRect = hit.host.getBoundingClientRect();
						const r = hit.center.getBoundingClientRect();
						geo.current = {
							ok: r.width > 0,
							left: Math.round(r.left - hostRect.left),
							top: Math.round(r.top - hostRect.top),
							width: Math.round(r.width),
						};
						// 让位：页签条是常驻覆盖层，不给中栏留 padding 就会盖住对话/工作台的顶部 ✗
						hit.center.style.paddingTop = STRIP_H + "px";
						state.wbStrip = { ok: geo.current.ok, left: geo.current.left, top: geo.current.top, width: geo.current.width };
						setVer((v) => v + 1);
					};
					measure();
					try {
						if (typeof ResizeObserver === "function") {
							const hit = locate();
							if (hit) {
								ro = new ResizeObserver(() => {
									if (raf) { return; }
									raf = requestAnimationFrame(() => { raf = 0; measure(); });
								});
								ro.observe(hit.center);
							}
						}
					} catch { /* 没有 ResizeObserver ⇒ 只靠 window resize ✓ */ }
					window.addEventListener("resize", measure);
					return () => {
						disposed = true;
						window.removeEventListener("resize", measure);
						if (raf) { try { cancelAnimationFrame(raf); } catch { /* 已取消 */ } }
						try { if (ro) { ro.disconnect(); } } catch { /* 已断开 */ }
						const hit = locate();
						if (hit) { hit.center.style.paddingTop = ""; }   // 卸载时把让位还回去 ✓
					};
				}, []);

				const g = geo.current;
				// ── 页签拖拽排序（2026-10-23 用户：「要求页签支持拖拽排序」）──────────────────
				//   为什么用 **pointer 事件**而不是 HTML5 `draggable`：
				//     · 原生 drag 在 overlay 层里拖影会跟着整条 DOM 一起闪，且 drop 目标常常落在子节点上；
				//     · pointer 事件能自己算"插到第几个位置"，还能**保留点击语义**（没移动就是点击 ✓）。
				//   ⚠ 两条必须守住的：①「会话」是固定第一格，不参与排序（回聊天是出口，别被拖走 ✗）；
				//     ② 拖动过之后紧跟着的那次 click **必须丢掉**，否则松手瞬间会切页签 ✗。
				const DRAG_STEP = 4;                              // 超过这个位移才算"在拖"，否则当点击
				const dragRef = react.useRef(null);               // { id, index, startX, moved, slot }
				const dragMovedRef = react.useRef(false);         // 供 click 闸门读（state 更新晚一拍）
				const [dragView, setDragView] = react.useState(null);
				/** 指针落在第几个"插入位"（0…openTabs.length）。只看页签右半边归属下一个 ⇒ 手感与文件管理器一致。 */
				const slotAt = (clientX) => {
					try {
						const el = hostRef.current;
						if (!el) { return openTabs.length; }
						const nodes = el.querySelectorAll("[data-vssaros-wb-tab]");
						// nodes[0] 恒是「会话」⇒ 从 1 开始映射 openTabs[i-1]
						for (let i = 1; i < nodes.length; i++) {
							const r = nodes[i].getBoundingClientRect();
							if (clientX < r.left + r.width / 2) { return i - 1; }
						}
						return openTabs.length;
					} catch { return openTabs.length; }
				};
				/** 把某个页签挪到插入位 `slot`（0…length）。换序语义在 `reorderTabs`（纯函数，有单测）。 */
				const moveTabTo = (id, slot) => {
					const next = reorderTabs(openTabs, id, slot);
					if (next === openTabs) { return; }             // 位置没变 ⇒ 不写盘、不重画
					openTabs = next;
					saveTabs(openTabs);                            // ★ 持久化：重开窗口顺序还在
					bumpTabs();                                    // 让页签条 + 中栏面板都重画
				};
				react.useEffect(() => {
					const onMove = (e) => {
						const d = dragRef.current;
						if (!d) { return; }
						const moved = d.moved || Math.abs(e.clientX - d.startX) > DRAG_STEP;
						if (!moved) { return; }
						d.moved = true;
						dragMovedRef.current = true;
						d.slot = slotAt(e.clientX);
						setDragView({ id: d.id, index: d.index, slot: d.slot, moved: true });
					};
					const onUp = () => {
						const d = dragRef.current;
						dragRef.current = null;
						setDragView(null);
						if (d && d.moved && typeof d.slot === "number") {
							moveTabTo(d.id, d.slot);
						}
						// 拖动过 ⇒ 紧跟的 click 要被丢掉（下一帧再复位，确保 click 先被吞掉）
						if (d && d.moved) {
							window.setTimeout(() => { dragMovedRef.current = false; }, 0);
						}
					};
					window.addEventListener("pointermove", onMove);
					window.addEventListener("pointerup", onUp);
					window.addEventListener("pointercancel", onUp);
					return () => {
						window.removeEventListener("pointermove", onMove);
						window.removeEventListener("pointerup", onUp);
						window.removeEventListener("pointercancel", onUp);
					};
				}, []);
				/** 开始拖一个页签（只有按下左键、且没按在 ✕ 上才进来）。 */
				const beginDrag = (e, id, index) => {
					try {
						if (e.button !== 0) { return; }
						dragRef.current = { id, index, startX: e.clientX, moved: false, slot: index };
						dragMovedRef.current = false;
					} catch { /* 老宿主没有 button ⇒ 不拖 ✓ */ }
				};
				const tabBase = {
					display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", cursor: "pointer",
					// 拖拽时别顺手把页签文字选中（否则拖完是一屏蓝，像坏了 ✗）
					userSelect: "none",
					fontSize: 12, whiteSpace: "nowrap", borderRadius: "6px 6px 0 0", border: "1px solid transparent",
					background: "transparent", color: "var(--dsw-alias-label-secondary, #a3a3a3)",
				};
				const tabOn = Object.assign({}, tabBase, {
					color: "var(--dsw-alias-label-primary, #e6e6e6)",
					background: "var(--dsw-alias-bg-module-platform, #1b1c1f)",
				});
				// 面板不在屏（= 中栏正显示会话）⇒「会话」高亮；否则按 activeTabId 判断 ✓
				const panelOn = workbenchPanelActive();
				const chatOn = !panelOn || !openTabs.some((t) => t.id === activeTabId);
				const tabs = [];
				tabs.push(react.createElement("div", {
					key: "__chat", style: chatOn ? tabOn : tabBase, "data-vssaros-wb-tab": "chat",
					onClick: () => {
						// 高亮要跟着走：`activeTabId` 清空后 `chatOn` 才为真（否则点回会话后
						// 原来那个工作台页签仍然高亮，看起来像没切过去 ✗）
						activeTabId = ""; saveActiveTab("");
						try { ctx.layout.selectPanel(null); } catch { /* 回不去就留着 ✓ */ }
						bumpTabs();
					},
				}, react.createElement("span", null, "💬"), react.createElement("span", null, "会话")));
				/** 插入位指示条（拖拽时显示在两个页签之间）。 */
				const marker = (k) => react.createElement("span", {
					key: "wb-mk-" + k, "data-vssaros-wb-marker": "1",
					style: {
						flex: "none", width: 2, height: 16, margin: "0 1px", borderRadius: 1,
						background: "var(--dsw-alias-brand-primary, #4a8cff)",
					},
				});
				openTabs.forEach((t, i) => {
					if (dragView && dragView.slot === i) { tabs.push(marker(i)); }
					const dragging = !!(dragView && dragView.id === t.id);
					tabs.push(react.createElement("div", {
						key: t.id,
						style: Object.assign({}, panelOn && activeTabId === t.id ? tabOn : tabBase,
							dragging ? { opacity: .55, cursor: "grabbing" } : null),
						"data-vssaros-wb-tab": t.id,
						// 提示里带上"可拖拽"：否则用户不知道这个条能排序
						title: (t.route ? t.route + " · " : "") + "拖拽可排序",
						// ★ 拖拽起点（只按下、还没动 ⇒ 后面仍是普通点击 ✓）
						onPointerDown: (e) => beginDrag(e, t.id, i),
						onClick: () => {
							// ★ 刚刚拖动过 ⇒ 这次 click 是松手的余波，丢掉（否则会切页签 ✗）
							if (dragMovedRef.current) { dragMovedRef.current = false; return; }
							activeTabId = t.id; saveActiveTab(activeTabId);
							// ★★ 2026-10-24：先记意图再 selectPanel —— 下面这一句会让中栏面板**首次挂载**，
							//   而它的挂载 effect 默认会 `ensureTab(主页)`；没有这个标记就会被覆盖回去
							//   （用户报的「首次点击其他页签，却切中主页」）✗。
							pendingTabOpen = t.id;
							try { ctx.layout.selectPanel(ENTRY_ID); } catch { /* 留在此面板也够 ✓ */ }
							// 右栏跟随：只有**有目录版**的工作台才切右栏（没有就别白开一份完整页 ✓）
							try { openItem(t, { skipRight: !catalogTabs.has(t.id) }); } catch { /* 右栏失败不阻塞切页 ✓ */ }
							bumpTabs();
						},
					},
						react.createElement("span", null, t.ico || "▫"),
						react.createElement("span", null, t.name),
						react.createElement("span", {
							style: { opacity: .55, marginLeft: 2, padding: "0 2px" },
							"data-vssaros-wb-tab-close": t.id,
							// ✕ 上按下不该起拖（否则想关页签会把条拖歪 ✗）
							onPointerDown: (e) => { try { e.stopPropagation(); } catch { /* 老宿主没有 stopPropagation */ } },
							onClick: (e) => {
								try { e.stopPropagation(); } catch { /* 老宿主没有 stopPropagation */ }
								closeTab(t.id);
								if (!openTabs.length) { try { ctx.layout.selectPanel(null); } catch { /* 留着也行 */ } }
							},
						}, "✕")));
				});
				// 拖到最右（插入位 = 末尾）时也要有指示
				if (dragView && dragView.slot >= openTabs.length) { tabs.push(marker("end")); }
				const shell = {
					position: "absolute",
					left: g.ok ? g.left : 0,
					top: g.ok ? g.top : 0,
					width: g.ok ? g.width : 0,
					height: STRIP_H,
					display: g.ok ? "flex" : "none",
					alignItems: "center", gap: 2, padding: "0 8px", boxSizing: "border-box",
					// overlay 层本身不吃指针（`pointer-events: none` 之类）⇒ 自己这一段必须能点 ✓
					pointerEvents: "auto", overflowX: "auto", zIndex: 5,
					borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
					background: "var(--dsw-alias-bg-layer-1, #262626)",
				};
				return react.createElement("div", {
					ref: hostRef, style: shell, "data-vssaros-wb-tabstrip": "1",
				}, tabs);
			}

			/** 中栏面板：**只画当前页签的内容**（页签条在常驻的 `TabStrip`，不在这里 ✓）。 */
			function makeTabPanel(pick) {
				return function WbTabPanel() {
					const [ver, setVer] = react.useState(0);
					react.useEffect(() => {
						const h = () => setVer(v => v + 1);
						window.addEventListener(TAB_CHANGE_EVENT, h);
						return () => window.removeEventListener(TAB_CHANGE_EVENT, h);
					}, []);
					react.useEffect(() => {
						// 挂载即：把「这个入口对应的工作台」变成活动页签（没开过就补一个）✓
						// ⚠ 2026-10-22：刚由 `openRegisteredWorkbench` 激活的动态页签（`wb:` 前缀）不要被
						//   「主页」面板的挂载抢回去（那是同一个中栏面板，打开它会先触发这里）。
						if (String(activeTabId || "").indexOf("wb:") === 0 && pendingDynamicOpen === activeTabId) { pendingDynamicOpen = ""; setVer(v => v + 1); return; }
						// ★★ 2026-10-24 修复（「首次点击其他页签却切中主页」）：有显式切页意图 ⇒ 尊重它。
						//   消费掉标记（无论命中与否）⇒ 陈旧值不会在**下次**挂载时误伤其它路径 ✓。
						const wantTab = pendingTabOpen;
						pendingTabOpen = "";
						if (wantTab && wantTab === activeTabId) { setVer(v => v + 1); return; }
						let it = null;
						try { it = pick(); } catch { /* 取不到就保持原样 ✓ */ }
						if (it) { ensureTab(it); }
						// 第三方工作台没有右栏目录页（内容是宿主 View）⇒ 只记"最后打开"，不开右栏
						if (it) { try { openItem(it, it.wbId ? { skipRight: true } : undefined); } catch { /* 右栏失败不阻塞 ✓ */ } }
						setVer(v => v + 1);
					}, []);
					let active = openTabs.filter(t => t.id === activeTabId)[0] || null;
					if (!active) {
						// 首次挂载（页签集合还是空的）⇒ **先用入口对应的工作台顶上** ⇒ 首屏不空白 ✓
						//   （挂载 effect 随后会把它正式记成一个页签 ✓）
						try { active = pick(); } catch { /* 取不到就留空态 ✓ */ }
					}
					return react.createElement("div", {
						style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
						"data-vssaros-wb-tabs": "1",
					},
						// ★ 提速：已打开过的页签**保活**（只切 display ⇒ 不重载）✓；没打开过的**不预载** ✓
						(() => {
							if (active) { loadedTabs.add(active.id); }
							const frames = openTabs.map((t) => {
								if (!loadedTabs.has(t.id)) { return null; }
								const on = t.id === activeTabId;
								const wbId = wbFor(t);
								if (wbId) {
									return react.createElement("div", {
										key: t.id, "data-vssaros-wb-embed": wbId,
										style: on
											? { display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, height: "100%", width: "100%" }
											: { display: "none" },
									}, react.createElement(wbService.View, { id: wbId, active: on }));
								}
								if (!t.route) {
									// 动态工作台的页签，但宿主里（暂时）没有它：宿主还没到 / 已卸载 / 等重启 ⇒ 说清楚，不开空 iframe
									return react.createElement("div", {
										key: t.id, "data-vssaros-wb-missing": t.wbId || t.id,
										style: on
											? { flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, opacity: .7, padding: 24, textAlign: "center" }
											: { display: "none" },
									}, "「" + (t.name || t.wbId) + "」当前不可用：它可能还在加载、已被卸载，或安装后还没重启 Harness。");
								}
								return react.createElement("iframe", {
									key: t.id, src: withSurface(t.route, "editor"), title: t.name,
									style: on
										? { display: "block", flex: "1 1 auto", minHeight: 0, height: "100%", border: 0, width: "100%", background: "transparent" }
										: { display: "none", width: "0", height: "0", border: 0 },
									onLoad: (ev) => { probeCatalog(t, ev); },
								});
							});
							if (!active) {
								return react.createElement("div", {
									style: { flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, opacity: .6 },
								}, "从「主页」里选一个工作台打开（它会在这里留一个页签）");
							}
							return frames;
						})()
					);
				};
			}

			// 页签条 → **根级常驻槽**（不在任何 main 面板里 ⇒ 切到对话也不消失 ✓）
			// `order` 是 list 槽的硬要求（不写 ⇒ 顺序无保证，守卫会报红）；它是覆盖层里唯一一条，
			// 取值只要稳定即可 ✓
			safeInject("overlay:页签条", SLOT_OVERLAY, () => safeRegister(
				"overlay:页签条", { name: SLOT_OVERLAY, id: "vssaros-wb-tabstrip", order: 100 }, TabStrip));


			// 侧栏「主页」那一行 ⇒ 页签面板（挂载即激活「主页」页签 ✓）
			safeInject("main:主页", SLOT_MAIN, () => safeRegister(
				"main:主页", { name: SLOT_MAIN, key: ENTRY_ID }, makeTabPanel(dashboardItem)));
			// 每个条目一个入口（主页「打开」/ 固定行 / 启动器 都走它）⇒ 打开即一个独立页签 ✓
			for (const it of DEFAULT_ITEMS) {
				const key = "vssaros-wb-" + it.id;
				safeInject("main:" + key, SLOT_MAIN, () => safeRegister(
					"main:" + key, { name: SLOT_MAIN, key: key }, makeTabPanel(() => it)));
			}

			// ── 侧栏单行入口（list 槽；label 由官方侧栏投影）─────────────────────────
			/**
			 * 右键这两行 = 打开**启动器**（11 格切换 + 排序层）。
			 *
			 * 为什么放在右键：左键已被"直接开页"占用（用户 2026-10-21 要求），而切换/排序这些
			 * 低频操作仍然需要入口 —— 右键既不影响左键语义，也不给侧栏加控件 ✓。
			 */
			function openLauncherFromMenu(e) {
				try { e.preventDefault(); e.stopPropagation(); } catch { /* 老宿主没有事件对象方法 */ }
				const rect = (e && e.currentTarget && typeof e.currentTarget.getBoundingClientRect === "function")
					? e.currentTarget.getBoundingClientRect() : undefined;
				openLauncher(rect);
			}

			function EntryIcon(props) {
				const size = props && typeof props.size === "number" ? props.size : 16;
				return react.createElement("span", {
					title: "主页（左键：打开主页 · 右键：切换/排序）",
					onContextMenu: openLauncherFromMenu,
					style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, fontSize: Math.round(size * 0.8), lineHeight: 1 },
				}, "🏠");
			}

			// ── 「固定」的工作台：dsh 窗口侧栏也长出一行（官方「自动化任务」=10 的**下方** ⇒ 11+）──
			// ★ 2026-10-21（用户：「固定到活动栏 改名成 固定，增加功能，当选择固定时，在自动化任务下方
			//   增加 icon，同时，活动栏中，增加icon」）：
			//   ① IDE **活动栏**那一份：主页卡片点「固定」经页面桥 setWorkbenchPinned ⇒ IDE 侧完成 ✓（不在本文件）；
			//   ② **dsh 窗口侧栏**这一份（就是本文件）：主页页在 dsh 窗口里是**同源 iframe** ⇒ 它 postMessage
			//      过来 ⇒ 我们把该工作台注册成一行（icon + 名字）⇒ 排在官方 schedules=10 **下方** ✓。
			//   ⚠ 状态存 **dsh 侧 localStorage**（`vssaros.wb.pinned`）⇒ 窗口重启后仍在 ✓；
			//   ⚠ 与 IDE 活动栏的 pin 状态是**两份**（各自持久化）⇒ 在 IDE 里取消固定不会自动反映到这里
			//      （要严格一致得让 IDE 推一份清单过来 —— 另一刀，先如实说明 ✓）。
			// ⚠ 状态三件套（`LS_PINNED` / `PINNED_ORDER_BASE` / `pinnedDisposers`）已**上移**到
			//   install() 开头（那边注释写清了为什么必须先于任何 inject 到位 ✓）———
			//   原因：侧栏「主页」那一行的 inject 现在是**第一个**注册，而 inject 回调会**同步**
			//   同步固定行 ⇒ 这三行必须已经在场（否则 TDZ ReferenceError ⇒ 整个 install 炸 ✗）。
			function readPinned() {
				try {
					const raw = window.localStorage && window.localStorage.getItem(LS_PINNED);
					const arr = raw ? JSON.parse(raw) : [];
					return Array.isArray(arr) ? arr.map(String) : [];
				} catch { return []; }
			}
			function writePinned(list) {
				try { window.localStorage && window.localStorage.setItem(LS_PINNED, JSON.stringify(list)); } catch { /* 私密模式 */ }
			}
			/**
			 * route → 条目（items = DEFAULT_ITEMS 按用户排序后的那份，带 route ✓）。
			 * ★ 2026-10-22：`wb:<身份>` = 第三方工作台（主页卡片的 route 就是这个）⇒ 从宿主注册表取名字与图标，
			 *   条目没有 route、带 `wbId`（页签内容由宿主 View 渲染）。宿主里没有它（未就绪 / 已卸载）⇒ null。
			 */
			function itemByRoute(route) {
				const r = String(route || "");
				if (r.indexOf("wb:") === 0) {
					const wbId = r.slice(3).toLowerCase();
					if (!wbId || !wbService || typeof wbService.has !== "function" || !wbService.has(wbId)) { return null; }
					const snap = typeof wbService.getSnapshot === "function" ? wbService.getSnapshot() : null;
					const info = snap && Array.isArray(snap.workbenches) ? snap.workbenches.filter(w => w.id === wbId)[0] : null;
					return { id: "wb:" + wbId, wbId, name: (info && info.title) || wbId, ico: wbIconEmoji(info && info.icon), route: "" };
				}
				return items.filter(it => it && it.route === r)[0] || null;
			}
			function unpin(route) {
				writePinned(readPinned().filter(r => r !== route));
				syncPinnedRows();
				const it = itemByRoute(route);
				notify("info", "已从侧栏移除：" + ((it && it.name) || route));
			}
			function syncPinnedRows() {
				const list = readPinned();
				// ① 先收掉不再固定的
				Array.from(pinnedDisposers.keys()).forEach((route) => {
					if (list.indexOf(route) >= 0) { return; }
					const d = pinnedDisposers.get(route);
					pinnedDisposers.delete(route);
					try { if (d && typeof d.nav === "function") { d.nav(); } } catch { /* 已注销 */ }
					try { if (d && typeof d.main === "function") { d.main(); } } catch { /* 已注销 */ }
				});
				// ② 再把还固定的按顺序注册（order 11+ ⇒ 官方「自动化任务」=10 的下面 ✓）
				list.forEach((route, index) => {
					if (pinnedDisposers.has(route)) { return; }
					const it = itemByRoute(route);
					if (!it) { return; }               // 认不出的 route（别的模块 / 第三方还没注册）⇒ 不长行 ✓
					// 第三方的 id 带 `:` 和 `/`（`wb:owner/repo`）⇒ 槽 key 只留安全字符
					const id = "vssaros-wb-pinned-" + String(it.id).replace(/[^A-Za-z0-9_-]/g, "-");
					const navDispose = safeRegister(
						"nav:固定行:" + id,
						{ name: SLOT_NAV, id: id, order: PINNED_ORDER_BASE + index, label: it.name },
						function PinnedIcon(props) {
							const size = props && typeof props.size === "number" ? props.size : 16;
							return react.createElement("span", {
								title: it.name + "（右键：取消固定）",
								onContextMenu: (e) => {
									try { e.preventDefault(); e.stopPropagation(); } catch { /* 老宿主没有事件对象方法 */ }
									unpin(route);
								},
								style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, fontSize: Math.round(size * 0.8), lineHeight: 1 },
							}, it.ico);
						},
					);
					// 官方点击 = selectPanel(id) ⇒ 必须有同 key 的中栏面板接着（否则"点了没反应"✗）
					const mainDispose = safeRegister("main:固定行:" + id, { name: SLOT_MAIN, key: id }, makeTabPanel(() => it));
					pinnedDisposers.set(route, { nav: navDispose, main: mainDispose });
				});
			}
			// 清单被**别处**改了（主页卡片在 IDE 编辑区里点固定 / 别的窗口）⇒ 同源 storage 事件 ⇒ 同步侧栏行 ✓
			//   （自己写自己不会收到 storage 事件 ⇒ 不会自激 ✓）
			if (typeof window.addEventListener === "function") {
				window.addEventListener("storage", (ev) => {
					if (!ev || ev.key !== LS_PINNED) { return; }
					syncPinnedRows();
				});
			}
			// 主页（dsh 窗口里是同源 iframe）点「固定」⇒ postMessage 过来 ⇒ 这里长出那一行 ✓
			if (typeof window.addEventListener === "function") {
				window.addEventListener("message", (ev) => {
					const data = ev && ev.data;
					if (!data || !data.type) { return; }
					// 「打开」：在本窗口开对应工作台（中栏 core + 右栏 catalog）✓
					if (data.type === "vssaros-wb-open" && data.route) {
						const it = itemByRoute(String(data.route));
						if (!it) { notify("warn", "工作台路由不认：" + String(data.route)); return; }
						// ★ 页签式承载：开一个**独立页签**（中栏）+ 右栏 catalog ✓
						openWorkbenchTab(it);
						return;
					}
					if (data.type !== "vssaros-wb-pin" || !data.route) { return; }
					const route = String(data.route);
					const list = readPinned().filter(r => r !== route);
					if (data.pinned !== false) { list.push(route); }
					writePinned(list);
					syncPinnedRows();
				});
			}

			// ★ 2026-10-21（用户："移除当前的主页按钮"）：原来还并排一行「当前工作台」（显示当前那个
			//   工作台的名字、点它开那一页）。第一行改名「主页」并固定开主页之后，第二行必然显示成
			//   「主页」⇒ 两行一模一样 ✗。整行删掉：侧栏只剩一行「🏠 主页」，切换/排序仍在右键 ✓。
			// ⚠ 侧栏「主页」那一行的注册**已上移**到 install() 开头（第一个注册）———
			//   原因：官方对重复注册**直接抛** ⇒ 旧顺序（它在最后）下一处撞 key 就整行消失 ✗
			//   （用户报的「主页丢失」）；上移 + `safeRegister` 之后它不再受后面任何一处影响 ✓。

			// ── 启动器弹层（纯 DOM；chunk 只能 require react ⇒ 弹层不走 react-dom portal）──
			let launcherEl = null;
			let editing = false;
			function closeLauncher() {
				if (launcherEl) { try { launcherEl.remove(); } catch { /* 已被移除 */ } launcherEl = null; }
				editing = false;
				document.removeEventListener("mousedown", onLauncherOutside, true);
			}
			function onLauncherOutside(e) {
				if (launcherEl && !launcherEl.contains(e.target)) { closeLauncher(); }
			}
			function moveItem(idx, dir) {
				const j = idx + dir;
				if (j < 0 || j >= items.length) { return; }
				const t = items[idx]; items[idx] = items[j]; items[j] = t;
				saveOrder(items);
				renderLauncherBody();
			}
			function el(tag, text, css) {
				const n = document.createElement(tag);
				if (text !== undefined) { n.textContent = text; }
				if (css) { n.style.cssText = css; }
				return n;
			}
			function renderLauncherBody() {
				if (!launcherEl) { return; }
				const body = launcherEl.querySelector("[data-wb-body]");
				if (!body) { return; }
				body.innerHTML = "";
				if (!editing) {
					const grid = el("div");
					grid.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:6px;";
					for (const it of items) {
						const cell = el("div");
						cell.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 2px;border-radius:8px;cursor:pointer;font-size:17px;";
						cell.onmouseenter = () => { cell.style.background = "rgba(128,128,128,.14)"; };
						cell.onmouseleave = () => { cell.style.background = ""; };
						cell.appendChild(el("span", it.ico));
						cell.appendChild(el("span", it.name, "font-size:10.5px;opacity:.85;"));
						cell.addEventListener("click", () => { closeLauncher(); openItem(it); });
						grid.appendChild(cell);
					}
					// ★ 2026-10-22：宿主里已注册的第三方工作台（从市场装的 / 本地装的）—— 不进排序，排在内置之后
					for (const w of registeredExtras()) {
						const cell = el("div");
						cell.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 2px;border-radius:8px;cursor:pointer;font-size:17px;";
						cell.setAttribute("data-vssaros-launcher-wb", w.id);
						cell.title = (w.title || w.id) + "（" + w.id + "）";
						cell.onmouseenter = () => { cell.style.background = "rgba(128,128,128,.14)"; };
						cell.onmouseleave = () => { cell.style.background = ""; };
						cell.appendChild(el("span", wbIconEmoji(w.icon)));
						cell.appendChild(el("span", w.title || w.id, "font-size:10.5px;opacity:.85;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"));
						cell.addEventListener("click", () => { closeLauncher(); if (!openRegisteredWorkbench(w.id)) { notify("warn", (w.title || w.id) + " 当前不可用"); } });
						grid.appendChild(cell);
					}
					body.appendChild(grid);
					return;
				}
				// 编辑态：行式列表（拖拽 + ↑↓）
				for (let idx = 0; idx < items.length; idx++) {
					const it = items[idx];
					const row = el("div", undefined, "display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:5px;cursor:grab;");
					row.draggable = true;
					row.appendChild(el("span", it.ico));
					row.appendChild(el("span", it.name, "flex:1 1 auto;font-size:12px;"));
					const up = el("button", "↑", "width:20px;height:20px;border-radius:4px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;cursor:pointer;font-size:11px;line-height:1;");
					const down = el("button", "↓", up.style.cssText);
					up.disabled = idx === 0; down.disabled = idx === items.length - 1;
					if (up.disabled) { up.style.cssText += "opacity:.3;cursor:default;"; }
					if (down.disabled) { down.style.cssText += "opacity:.3;cursor:default;"; }
					up.addEventListener("click", (e) => { e.stopPropagation(); moveItem(idx, -1); });
					down.addEventListener("click", (e) => { e.stopPropagation(); moveItem(idx, +1); });
					row.addEventListener("dragstart", (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(idx)); });
					row.addEventListener("dragover", (e) => { e.preventDefault(); });
					row.addEventListener("drop", (e) => {
						e.preventDefault();
						const from = Number(e.dataTransfer.getData("text/plain"));
						if (!isFinite(from) || from === idx) { return; }
						const moved = items.splice(from, 1)[0];
						items.splice(idx, 0, moved);
						saveOrder(items);
						renderLauncherBody();
					});
					row.appendChild(up); row.appendChild(down);
					body.appendChild(row);
				}
			}
			/**
			 * 打开启动器（切换/排序层）。
			 *
			 * `anchor` = 触发它的那个行的 `getBoundingClientRect()`（右键时传）⇒ 面板贴在那行右边；
			 * 不传则退回历史固定位（244,150）。两种都必须**夹进视口**：本页面跑在 WebContentsView 里，
			 * 超出视图矩形的部分会被裁掉（真实事故：面板下半截落到视口外且滚不到 ✗）。
			 */
			function openLauncher(anchor) {
				closeLauncher();
				const box = el("div", undefined,
					"position:fixed;z-index:1000;width:250px;padding:10px;border-radius:10px;"
					+ "background:var(--dsw-alias-bg-layer-2,#232323);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));"
					+ "box-shadow:0 10px 28px rgba(0,0,0,.5);color:var(--dsw-alias-label-primary,inherit);");
				const head = el("div", undefined, "display:flex;align-items:center;padding:0 2px 8px;font-size:11px;opacity:.75;");
				head.appendChild(el("b", "工作台", "flex:1 1 auto;font-weight:600;"));
				const editBtn = el("button", "✎ 排序", "border:none;background:none;color:var(--dsw-alias-brand-primary,#4d7cfe);font-size:11px;cursor:pointer;");
				editBtn.addEventListener("click", () => {
					editing = !editing;
					editBtn.textContent = editing ? "完成" : "✎ 排序";
					foot.style.display = editing ? "" : "none";
					renderLauncherBody();
				});
				head.appendChild(editBtn);
				const bodyEl = el("div");
				bodyEl.setAttribute("data-wb-body", "1");
				const foot = el("div", undefined, "display:none;padding:8px 2px 0;font-size:11px;");
				const reset = el("button", "恢复默认顺序", "border:none;background:none;color:var(--dsw-alias-brand-primary,#4d7cfe);font-size:11px;cursor:pointer;");
				reset.addEventListener("click", () => { items = DEFAULT_ITEMS.slice(); saveOrder(items); renderLauncherBody(); });
				foot.appendChild(reset);
				box.appendChild(head); box.appendChild(bodyEl); box.appendChild(foot);
				// 锚在侧栏行右侧（右键给了矩形就用它）；两轴都夹进视口（超矩形会被裁 ✗）
				const w = window.innerWidth || 0, h = window.innerHeight || 0;
				let x = 244, y = 150;
				if (anchor && typeof anchor.right === "number" && typeof anchor.top === "number") {
					x = Math.round(anchor.right + 8);
					y = Math.round(anchor.top);
				}
				if (w > 0) { x = Math.max(8, Math.min(x, w - 270)); }
				if (h > 0) { y = Math.max(8, Math.min(y, h - 360)); }
				box.style.left = x + "px"; box.style.top = y + "px";
				document.body.appendChild(box);
				launcherEl = box;
				renderLauncherBody();
				document.addEventListener("mousedown", onLauncherOutside, true);
			}
		}

		exports.install = install;
		// 仅测试用：兜底进会话时"挑哪一条"（纯逻辑 ⇒ 守卫 ⑥ 钉住）
		exports.__test = { pickLatestSessionId, pickDashboardItem, DASHBOARD_ID, reorderTabs };
		return module.exports;
	}
});
