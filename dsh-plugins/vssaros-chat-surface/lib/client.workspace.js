// @vssaros/dsh-chat-surface — **工作区 + worktree 合并入口**（header 左侧上下文位 slot=actions；hero 借官方触发器）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.workspace.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
//
// ── 为什么补这个（2026-10-11，UI 对比评审结论 ①）──────────────────────────────
// VsSaros 原生聊天面板 header 有「工作区 / worktree」两个常驻 chip（`agentChatPanel.header.ts:200-236`），
// 用户随时知道"这个会话跑在哪个仓的哪个 worktree 上"；而 dsh chat-surface 这边**没有任何可见入口**：
// `client.js` 的 `alignWorkspace()` 只是**自动**把页面的工作区选择对齐到"拥有该会话的工作区"
// （`client.js:194-207`），用户既看不到是哪个、也切不了 ⇒ 信息缺口最大的一项。
//
// ── 2026-10-15：两枚合成一个入口（用户拍板方案 C：单 chip + 扁平可搜索列表）──────────
// mockup：`doc/dsh-workspace-worktree-merge-mockup.html`（A/B/C 三稿，C 中选）。
// **能合并的依据（四条一致）**：① 同一个槽位 ✓；② 切换走**同一条命令** `bridge.switchWorktree(path)` ✓
// （连切工作区也是它）；③ 对外语义**同一句**"切换 = 宿主在目标目录接管其专属会话，历史独立" ✓；
// ④ 样式与尺寸同款 ✓。**不合并的只有数据源**：工作区来自 dsh 快照（`workspaces.list`），
// worktree 来自**宿主推送**（`dataset.vssarosWorktrees` + DOM 事件）⇒ 两条判据各自独立、不引入第二套真相 ✓：
//   · 当前工作区 = `sessionIds` 含本会话的那个（`workspaceIdOfSession`，与 `alignWorkspace` 同一判据 ✓）
//   · 当前目录   = 会话快照的 `cwd`（`readCurrentDir`），与推送项的 `path` 做 `samePath` ✓
// 顺带收益：原 `vssaros-workspace-chip` 与官方 `subagent-catalog` 在 `order: -30` 的历史 tie 随之**消失** ✓
// （本入口取 **-27**：官方 -30 与「我们的子代理入口」-25 之间；守卫 `check-chat-surface-chunks.mjs` 的
//  baseline / KNOWN_TIES 已同步 ✓ ⇒ **新 tie 一个都不许引入** ✓）。
//
// ── 2026-10-16：hero 那枚改成"借官方的触发器"（用户拍板方案 A：只留一枚 + 补 add workspace）────
// mockup：`doc/dsh-workspace-entry-single-mockup.html`（A/B/C/D 四稿，A 中选）。
// **问题**：hero（空白会话屏）那一行由官方写死三个位置
// （`dsh-client-ui-conversation/lib/client.js:16256` 的 `heroWorkspaceRow`）：
//   `[官方 WorkspaceChip] → conversation.hero.workspace（官方下拉**浮层**）→ conversation.hero.agentPreset（我们接管）`
// 15 日把 worktree chip 换成"工作区 + worktree 合并入口"之后，hero 里就**并排两枚都在说"工作区"** ✗（用户截图）。
// **能怎么修**：官方那枚 WorkspaceChip 是**写死在 heroWorkspaceRow 里的组件**（不走 slot）⇒ **遮蔽不了**；
// 只有它的浮层走槽 `conversation.hero.workspace`（`kind: single`、scope root ⇒ 可 `priority: -10` 遮蔽 ✓）。
// ⇒ 方案 A：**hero 里仍然只出官方那枚 chip**，我们把自己的合并面板挂到该槽上（遮蔽官方浮层）——
//   视觉一枚 chip、点击后开的是我们的面板（工作区 + worktree + 添加工作区）✓。
//   ⚠ 面板挂在 hero 时**没有自己的容器**（chip 是官方的）⇒ 只能用 `anchorRef.current.getBoundingClientRect()`
//     做 `position: fixed` 定位；header 那枚仍沿用原来的"absolute 挂在 chip 的 relative 容器里" ✓。
//   ⚠ `client.preset.js` 的 hero 装配里那枚 chip **已删除**（`shell.heroWorktreeChip` / `WORKTREE_CHIP_EVENT`
//     这两条"跨 chunk 传组件"的通道随之作废 —— 面板现在由**槽**渲染，不需要谁来传 ✓）。
//
// ── 2026-10-16：hero 与 header 的**点击语义不同**（不是不一致，是各自的权威不同）──────────
//   · header（有会话）：本视图绑的会话是**宿主持有的事实**（`dshViewHost` 的 slot.sessionId，
//     rename 推送 / preset 映射都依赖它）⇒ 页面私自切只会换掉页面的选择、宿主仍指着旧会话 ⇒ 两边分叉 ✗
//     ⇒ 一律 `bridge.switchWorktree(path)`（宿主在目标目录接管其专属会话，历史独立）。
//   · hero（空白会话屏，**没有会话**）：页面侧选中工作区**不会**分叉（分叉的前提是"宿主已持有会话"）⇒
//     沿用**官方语义** `props.onPick(workspaceId)`（选中它、等用户按下发送才开始会话）✓
//     —— 走 `switchWorktree` 会让宿主当场 `session.start` 一个空会话、页面立刻离开 hero，
//     用户失去"先选目录再写第一句话"的体验 ✗。
//     hero 里的 **worktree 行**仍然走 `bridge.switchWorktree(path)`：worktree 不是工作区（`onPick` 只认
//     workspaceId），它的本意就是"在这个目录开始一段会话" ✓（tooltip 里如实写明）。
//
// ── ★ 2026-10-17 **口径变更**（真机报障 + 日志，见 README 5.149）─────────────────────────────
// 用户报"聊天框里仍然切不了工作区"，日志实证：那屏正是 **hero**（`contextHeroEntry:true`），用户在 **4 次**
// 点击里每次 IDE 窗口都切过去了（`08:49:37.686 [AgentStudio] Active workspace changed`，15ms），
// 但按上面的官方语义**不换会话** ⇒ 聊天框**零变化**（`workspaceUiLog:["hero-pick"×4]`、`rebinds:0`）
// ⇒ 用户只能反复点 ✗✗。⇒ **hero 的"工作区行"现在与 header 同口径**（在目标主根 `switchWorktree` 起/接管
// 会话）⇒ 点了**真的切过去**、界面立刻跟着变 ✓；代价是离开 hero 那屏。
// 唯一的保留：**连主根都读不到**时才回落到官方 `onPick`（`if (!path)` 那一支 ✓）。
//
// ── ★★ 2026-10-17 再变更（用户明确要求"两者保持独立"）────────────────────────────────────
// 上面的这一轮**还额外**发了 `bridge.switchWorkspace(ideId)`（让 IDE 窗口原地进该工作区）—— 用户随后指出：
// 聊天框切工作区**不该**把 IDE 的 ActivityBar / 资源管理器那份 folders 一起换掉，两者是两件独立的事。
// ⇒ **已删除那一跳**：现在这里只做"在目标目录起/接管会话"，IDE 窗口工作区**一律不动**
// （`bridge.switchWorkspace` 命令仍留在桥上，只是本面板不再调用）。
// ⚠ 别再用"切窗口"当文案：行尾 / 主命令 / 说明 / tooltip 一律按"开会话"写（承诺窗口变化就是假话 ✗）。
//
// ── add workspace（2026-10-16 补，用户要求"要有 add workspace 功能"）────────────────
// 官方 hero 菜单底部本来就有「添加工作区…」（`hero.workspace` 浮层内的 footer）；合并入口没有 ⇒ 补齐。
// 路径**不新增桥命令**（与官方 `createWorkspace` 同一条链 ✓）：
//   ① `ctx.remote.directoryPicker.pick()` → `{ok:true, value:{path}}`（官方 `pickDirectory()` 走的就是它）
//   ② `ctx.get("workspaces").create({ path })` → 工作区对象
// ⚠ 两个服务都**不进 inject**：Cordis 4 的 inject 是硬依赖，宿主没装目录选择器会让整个插件不 apply ✗
//   （比缺这个功能更糟）⇒ 一律用 `ctx.get(...)` 运行时可选取，取不到就**如实说清**、不假装能加 ✓。
// ⚠ 成功后：hero 里**采纳即选中**（与官方 `adoptDirectory → onPick` 同语义 ✓）；header 里就地列出并提示
//   （**不**自动切 —— 那会让"添加"变成一个会换会话的动作 ✗），用户再决定是否切 ✓。
//
// ── 2026-10-16：**多根工作区**（mockup `doc/dsh-workspace-multiroot-mockup.html`，稿 C）────────
// **病根**：dsh 的工作区模型**只能是单目录**（`WorkspaceCreateRequest = { path }`），宿主上报时把 IDE 侧
// 一个多根工作区的各根**摊平**成 N 条记录 ⇒ 页面只看 `workspaces.list()` 时，"同一个窗口的 3 个根"
// 看起来就是"3 个互不相干的工作区" ✗（用户报的"工作区 UI 不对"的根因之一）。
// **修法（数据侧）**：宿主新增一条推送 `DSH_PAGE_IPC_WORKSPACES`（写 `dataset.vssarosWorkspaces` +
// 派 `vssaros-dsh-workspaces` 事件，与 worktree 逐字同机制 ✓），负载 = IDE 工作区记录（含各根 ✓）。
//   ① 条目来源**仍然是 dsh 快照**（会话归属 / 切换命令都认它 ✓）—— 记录**只用来分组**（见 `buildTree` ✓）；
//      这样"推送没到 / 旧宿主 / 服务未就绪"时输出与从前**逐字相同**（**回落契约** ✓，Header 行为网按它断言 ✓）。
//   ② 多根的组把各根**平铺**出来（稿 C：一次看全，不用折叠 ✓）——根行就是"cwd 取哪个根"的落点：
//      点根行 = `bridge.switchWorktree(根路径)`（宿主在该目录 `session.start` + rebind ✓，与 worktree 同一条命令 ✓）。
//   ③ 组行（工作区）仍可点：多根时目标 = **主根**（想换别的根 ⇒ 点那一行根 ✓，行尾文案如实写明 ✓）。
//   ④ 顶部加「当前会话」栏（`cwd` 写在脸上）—— 多根之后不给它，用户会以为在 A 根、其实跑在 B 根 ✗。
// ★ 拍板 ① 的"粘性根"**不需要另存状态**：dsh 自带"每目录一个专属会话"（宿主 `_sessionIdFor` 按目录派生 id）
//   ⇒ 回到该工作区时，面板会把上次那个根标成「当前会话 cwd」✓（= b 由它天然提供 ✓）。
// ⚠ 本轮**刻意不印"可写：全部 N 个根"**：写根由沙箱策略决定（当前实现 = 会话 cwd **单根**，
//   拍板 ② 的 α「写全部根」还没接入）⇒ 印了就是假话 ✗（本仓纪律：文案必须描述"真正会发生的事" ✓）。
//
// ── 诊断位（宿主自证快照读它们；`dshViewHost.ts` 的 PAGE_SURFACE_REPORT）──────────────
// `state.contextEntry` / `workspaceChip` / `worktreeChip`（入口已挂载）/ `contextEntryHero`（hero 遮蔽注册成功）
// / `contextSwitches`（成功切换次数）/ `contextAdds`（成功添加工作区次数）。
// ★ hero 里的 DOM 标记：`[data-vssaros-context-hero]`（常驻零尺寸 fixed 壳）—— 因为 hero 屏**没有**我们自己的
//   chip（那是官方的），自证只认 `[data-vssaros-context-chip]` 的话，空白会话屏会报"chip 没出来"的假告警 ✗。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.workspace.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		/** 路径取末段（`/a/b/c` 与 `C:\\a\\b` 都要认）；空串/非串返回 null。 */
		function baseName(p) {
			if (typeof p !== "string" || p.trim() === "") { return null; }
			const parts = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
			return parts[parts.length - 1] || null;
		}
		/** 会话所属的工作区 id（快照 items 里第一个 sessionIds 含它的）；取不到 null。 */
		function workspaceIdOfSession(snapshot, sessionId) {
			const items = (snapshot && snapshot.items) || [];
			if (!sessionId || !Array.isArray(items)) { return null; }
			for (const w of items) {
				if (w && Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sessionId) >= 0) {
					return w.workspaceId || null;
				}
			}
			return null;
		}
		/** chip 上显示的名字：`title` → 路径末段 → workspaceId（都不猜别的）。 */
		function workspaceLabel(workspace) {
			if (!workspace) { return null; }
			const title = typeof workspace.title === "string" && workspace.title.trim() ? workspace.title.trim() : null;
			return title || baseName(workspace.path) || workspace.workspaceId || null;
		}

		// ── worktree：数据从哪来 ────────────────────────────────────────────────────
		// 宿主经 `DSH_PAGE_IPC_WORKTREES` 推 `IDshWorktreeOption[]`，preload 写进
		// `documentElement.dataset.vssarosWorktrees` **并派 DOM 事件** —— 页面桥是**单向**的
		// （只有 ping 有返回值）⇒ 宿主侧数据只能推、不能查；写 dataset 是为了"插件晚于推送加载"也能读到。
		const WORKTREE_EVENT = "vssaros-dsh-worktrees";

		/**
		 * hero 壳的 DOM 标记（宿主自证读它；见文件头"诊断位"）。
		 * ★ 为什么需要：hero 屏里我们**不再渲染自己的 chip**（那是官方 WorkspaceChip，见文件头方案 A）⇒
		 *   自证只认 `[data-vssaros-context-chip]` 会把空白会话屏读成"我们的入口没出来" ✗（假告警）。
		 */
		const HERO_MARK_ATTR = "data-vssaros-context-hero";

		/**
		 * 最近一次 `pointerdown`（mousedown，捕获阶段）的落点元素。
		 *
		 * 为什么需要（2026-10-17 真机 bug「点聊天框输入框会弹出工作区下拉框」）：
		 * 官方给 hero 槽的 props 只有 `open`（`pickerOpen` 由 conversation 包持有），**没有来源**。
		 * 而 hero 里同一个 `open` 有两条触发路径：
		 *   ① 点官方 WorkspaceChip → `onClick: setPickerOpen(o => !o)`（我们想认的）；
		 *   ② 输入框 inert 时的 `onRequestWorkspace` → `setPickerOpen(true)`
		 *      （`dsh-client-ui-conversation/lib/client.js:17593-17603`，官方"点输入框选工作区"语义）。
		 * 我们的面板比官方小浮层大得多（540px 主从两栏）⇒ ② 一开就压住会话，用户感受是"乱弹" ✗。
		 * ⇒ 记录落点，让 HeroContextPanel 只在上升沿来自 chip 时才认这次 open ✓（不动官方语义）。
		 * ⚠ 模块作用域只装一台监听（chunk 只安装一次）；守卫的 document stub 有 addEventListener ✓。
		 */
		let lastPointerDownTarget = null;
		if (typeof document !== "undefined" && document.addEventListener) {
			document.addEventListener("mousedown", (e) => { lastPointerDownTarget = (e && e.target) || null; }, true);
		}
		/**
		 * 这次 open 是不是从官方 chip 发起的（纯逻辑 ⇒ 守卫 ⑤ 钉住）。
		 * 点 chip 的**子孙**也算（按钮里常包一层文本节点 ✓）；拿不到锚点/落点 ⇒ 不算（宁可不开，不乱弹 ✓）。
		 */
		function isOpenFromAnchor(anchor, target) {
			if (!anchor || !target) { return false; }
			if (anchor === target) { return true; }
			try { return typeof anchor.contains === "function" && anchor.contains(target); } catch { return false; }
		}

		/** 解析 dataset 里的 worktree JSON；坏数据 ⇒ 空数组（不猜、不显示假条目）。 */
		function parseWorktrees(raw) {
			try {
				const list = raw ? JSON.parse(raw) : [];
				return Array.isArray(list) ? list.filter((w) => w && typeof w.path === "string") : [];
			} catch { return []; }
		}
		/**
		 * 路径比较：统一分隔符 + 去尾斜杠 + 大小写不敏感。
		 * 与宿主 `dshChatInstanceHost._isWorktreeDir` **同口径**（两边不一致会出现"UI 认为已在该 worktree、
		 * 宿主却再切一次"的错位）。
		 */
		function samePath(a, b) {
			if (typeof a !== "string" || typeof b !== "string" || !a || !b) { return false; }
			const norm = (p) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
			return norm(a) === norm(b);
		}
		/** 展示名：git 主工作区 ⇒ "主工作区"；其余用 `name`（分支名/短 hash）→ 路径末段。 */
		function worktreeLabel(w) {
			if (!w) { return null; }
			if (w.isMain === true) { return "主工作区"; }
			return (typeof w.name === "string" && w.name.trim()) || baseName(w.path) || null;
		}
		/**
		 * 读宿主推送（`dataset.vssarosWorktrees`）。
		 *
		 * ⚠ 必须防"没有 DOM"：本 chunk 在单测里跑在 Node（`document` 未定义）—— 不防的话
		 * `document.documentElement` 直接 ReferenceError，整块皮肤连注册都跑不到 ✗（实测踩过）。
		 */
		function readPushedWorktrees() {
			try {
				if (typeof document === "undefined" || !document.documentElement) { return []; }
				return parseWorktrees(document.documentElement.dataset.vssarosWorktrees);
			} catch { return []; }
		}
		/** 搜索用：把一行可搜的文本拼起来（名称 + 路径 + 分支），大小写不敏感由调用方处理 ✓。 */
		function searchText(parts) {
			let out = "";
			for (const p of parts) {
				if (typeof p === "string" && p) { out += p + "\u0000"; }
			}
			return out.toLowerCase();
		}
		/**
		 * IDE **工作区记录**（多根工作区，2026-10-16）—— 宿主推的"一个工作区 + 各根"，
		 * 见 `dshPageBridgeProtocol.ts` 里 `DSH_PAGE_IPC_WORKSPACES` 的长注释 ✓。
		 */
		const WORKSPACE_EVENT = "vssaros-dsh-workspaces";

		/**
		 * 宿主**换绑会话**的那条（`dshViewHost.rebindSession` → preload 派 DOM 事件；`client.js` 收同一个事件
		 * 并把它写进 `state.sessionId`）。
		 *
		 * ★ 2026-10-17 为什么这里也要收一遍（用户报「切工作区后聊天框里的工作区 UI 没刷新」）：
		 *   `client.js` 的 rebind 处理只做**裸字段赋值**（`state.sessionId = sid`）+ `ctx.uiWorkspace.openSession(sid)`，
		 *   它自己**不触发任何 React 重渲** ✗；而本 chunk 的工作区入口读的正是
		 *   `props.sessionId || state.sessionId` ⇒ 只要那一次换绑没让 header 槽重渲，chip 就会继续显示
		 *   **换绑前**那个会话所属的工作区 ✗（症状与用户报的一模一样）。
		 *   ⇒ 自己订阅、拿到事件就逼一次重渲（复用 `useContextData` 里那个 tick ✓）。
		 */
		const REBIND_EVENT = "vssaros-dsh-rebind";

		/**
		 * 解析 dataset 里的 IDE 工作区记录。
		 * 坏数据 / 缺 id / **一个根都没有** ⇒ 丢掉那一条（不猜、不编假根 ✓，与 `parseWorktrees` 同口径）。
		 */
		function parseWorkspaces(raw) {
			try {
				const list = raw ? JSON.parse(raw) : [];
				if (!Array.isArray(list)) { return []; }
				const out = [];
				for (const w of list) {
					if (!w || typeof w !== "object" || typeof w.id !== "string" || !w.id) { continue; }
					const roots = (Array.isArray(w.roots) ? w.roots : [])
						.filter((r) => r && typeof r.path === "string" && r.path)
						.map((r) => ({
							path: r.path,
							name: (typeof r.name === "string" && r.name) ? r.name : (baseName(r.path) || r.path),
							isPrimary: r.isPrimary === true,
						}));
					if (roots.length === 0) { continue; }
					out.push({
						id: w.id,
						name: (typeof w.name === "string" && w.name.trim()) ? w.name.trim() : (baseName(roots[0].path) || roots[0].path),
						roots: roots,
						codeWorkspacePath: (typeof w.codeWorkspacePath === "string" && w.codeWorkspacePath) ? w.codeWorkspacePath : null,
					});
				}
				return out;
			} catch { return []; }
		}

		/** 读宿主推送的 IDE 工作区记录；单测跑在 Node ⇒ 必须防"没有 DOM"（同 `readPushedWorktrees` ✓）。 */
		function readPushedWorkspaces() {
			try {
				if (typeof document === "undefined" || !document.documentElement) { return []; }
				return parseWorkspaces(document.documentElement.dataset.vssarosWorkspaces);
			} catch { return []; }
		}

		/**
		 * 取某个 ref 元素的 rect 投影 —— 交给 `shell.fitMenu(anchor)` 去算"菜单从哪儿开始"。
		 * 拿不到（未挂载 / 单测无 DOM）⇒ `null` ⇒ fitMenu 退回"整页留边"的旧口径 ✓（**不猜 0 坐标**：
		 * 猜 0 会把菜单算成全页高，那正是 2026-10-16 用户报的"底部按钮点不到" ✗）。
		 */
		function anchorRect(ref) {
			try {
				const el = ref && ref.current;
				if (!el || typeof el.getBoundingClientRect !== "function") { return null; }
				const r = el.getBoundingClientRect();
				// ★ 2026-10-19：**必须带 left/right** —— header 那枚菜单已从 `position: absolute`
				//   改成 `position: fixed`（见 headerMenuBox 的注释），fixed 需要绝对坐标；
				//   只给 top/bottom 是当初"absolute 挂在 chip 的 relative 容器里"留下的口径 ✗。
				return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
			} catch { return null; }
		}

		/**
		 * header 那枚工作区菜单的**视口坐标**（2026-10-19；用户报「工作区下拉框弹出 UI 层级错误」）。
		 *
		 * 病根：菜单原先是 `position: absolute; top: 100%; left: 0` 挂在 chip 的 relative 容器里，
		 * 而 `zIndex: 1000` 只能在本**层叠上下文**内比较 —— dsh header 自己就是一个带 z-index 的
		 * 定位容器，页面里的浮层（文档预览 / 侧栏 / 我们的自绘菜单）完全可能压在它上面 ⇒
		 * 菜单被盖住一半、看起来"层级错乱"。hero 那枚早就是 `position: fixed`（挂在 body 语义的
		 * 视口上，不受祖先层叠上下文约束）✓ —— 两处口径必须一致。
		 *
		 * 这里算 {left, top} 并夹在视口内（宽度按 `min(520px, 100vw - 24px)` 估，与样式里的 width 同口径）；
		 * 下方放不下且上方更宽裕就上翻。拿不到 rect（未挂载/单测无 DOM）⇒ 返回空对象，
		 * 退回 CSS 里的默认位置，**不猜 0 坐标** ✓。
		 */
		function headerMenuBox(ref) {
			try {
				const r = anchorRect(ref);
				const vw = typeof window !== "undefined" ? window.innerWidth : 0;
				const vh = typeof window !== "undefined" ? window.innerHeight : 0;
				if (!r || !vw || !vh) { return {}; }
				const panelW = Math.min(520, vw - 24);
				const left = Math.max(8, Math.min(r.left, vw - panelW - 8));
				const below = vh - r.bottom - 16;
				const above = r.top - 16;
				const MAX_H = 360;
				if (below < 200 && above > below) {
					return { left: left, top: Math.max(8, r.top - 4 - Math.min(MAX_H, above)) };
				}
				return { left: left, top: r.bottom + 4 };
			} catch { return {}; }
		}

		/**
		 * 纯逻辑：把**两套数据**（dsh 快照条目 + IDE 工作区记录）+ worktree 列表 + 查询串，
		 * 收敛成面板要渲染的"工作区组 + worktree 行"（模块作用域 ⇒ `__test` 可直接断言 ✓）。
		 *
		 * 为什么必须合并两套：dsh 的工作区模型**只能是单目录**，宿主上报时把 IDE 侧一个多根工作区的各根
		 * **摊平**成 N 条 dsh 记录 ⇒ 只看快照时"同一个窗口的三个根"看起来就是三个互不相干的工作区 ✗
		 * （用户报的"工作区 UI 不对"根因之一）。
		 * 合并规则 —— **记录认领快照条目**，不反过来（快照才是会话归属 / 切换命令的真源 ✓）：
		 *   · 每条记录认领"路径命中它任一根"的快照条目 ⇒ 合成一组，`roots` 用**记录里的各根** ✓；
		 *   · 没被任何记录认领的条目各自成一组（`roots` 只有它自己 ⇒ 与加这条推送之前**逐字相同** ✓）；
		 *   · 记录在快照里**一个成员都没认领到**时仍然出行（IDE 注册过、dsh 那边还没登记 ⇒ 点它照样能起会话 ✓），
		 *     组 key 用 `ide:` 前缀兜底（一看就知道它不在 dsh 侧、hero 里选不了 ✓）。
		 * ⚠ `records` 为空（推送没到 / 旧宿主 / 服务未就绪）⇒ 输出必须与"从来没有这条推送"**逐一相同** ——
		 *   这是回落契约（Header 行为网按它断言的 ✓）。
		 */
		function buildTree(options) {
			const items = (options && options.workspaces) || [];
			const records = (options && options.records) || [];
			const list = (options && options.worktrees) || [];
			const q = options && typeof options.query === "string" ? options.query.trim().toLowerCase() : "";
			const hit = (parts) => !q || searchText(parts).indexOf(q) >= 0;

			const claimed = {};
			const groups = [];
			for (const rec of records) {
				// ⚠ 一条快照条目只能被**一条**记录认领（先到先得）：IDE 里可能有两条记录都含同一个根
				// （2026-10-16 用户截图实况：正常那条 + 一个 `.code-workspace` 记录）⇒ 双双认领会让面板上
				// **两行都标"当前"**、看着像两个重复工作区 ✗。后面的记录仍然出行（它确实注册过 ✓），
				// 只是没有成员 ⇒ key 带 `ide:` 兜底、不参与"当前"判定 ✓。
				const members = items.filter((it) => it && it.workspaceId && !claimed[it.workspaceId]
					&& rec.roots.some((r) => samePath(r.path, it.path)));
				for (const m of members) { claimed[m.workspaceId] = true; }
				const primaryRoot = rec.roots.filter((r) => r.isPrimary)[0] || rec.roots[0];
				// 组 key：优先"主根对应的那条快照"的 workspaceId（= dsh 侧的真 id，hero 的 `onPick` 只认它 ✓），
				// 其次认领到的第一条，都没有才用 `ide:` 兜底 ✓。
				let key = "";
				for (const m of members) {
					if (m && m.workspaceId && samePath(m.path, primaryRoot.path)) { key = m.workspaceId; break; }
				}
				if (!key && members.length) { key = (members[0] && members[0].workspaceId) || ""; }
				groups.push({
					kind: "workspace",
					key: key || ("ide:" + rec.id),
					ids: members.map((m) => (m && m.workspaceId) || "").filter(Boolean),
					label: rec.name,
					path: primaryRoot.path,
					roots: rec.roots,
					multi: rec.roots.length > 1,
					codeWorkspacePath: rec.codeWorkspacePath,
					dshKnown: members.length > 0,
					// IDE 侧工作区 id（`Workspace.id`）：**只用于识别这条来自哪份 IDE 记录**（与 dsh 的
					// workspaceId 不是一回事）。⚠ 2026-10-17 起本面板**不再**拿它调 `switchWorkspace`（不切窗口）
					ideId: rec.id,
					matched: hit([rec.name, primaryRoot.path].concat(rec.roots.map((r) => r.path)).concat(rec.roots.map((r) => r.name))),
				});
			}
			for (const w of items) {
				if (w && w.workspaceId && claimed[w.workspaceId]) { continue; }
				const label = workspaceLabel(w);
				const path = (w && w.path) || null;
				groups.push({
					kind: "workspace",
					key: (w && w.workspaceId) || "",
					ids: (w && w.workspaceId) ? [w.workspaceId] : [],
					label: label || (w && w.workspaceId) || "工作区",
					path: path,
					roots: path ? [{ path: path, name: baseName(path) || path, isPrimary: true }] : [],
					multi: false,
					codeWorkspacePath: null,
					dshKnown: true,
					// 没有 IDE 记录 ⇒ 连"窗口该进哪个工作区"都不知道 ⇒ 如实留空（点了只起会话 ✓）
					ideId: null,
					matched: hit([label, w && w.path, w && w.workspaceId]),
				});
			}
			// worktree 行的**归属根名**：多根之后"feat/x 属于哪个仓"会歧义 ⇒ 一律标注（见 mockup 的共用四条 ③）✓。
			// 列表是**一个仓**产出的（宿主只取第一个拿得到结果的根）⇒ 用列表里 `isMain` 那条去认领归属 ✓。
			const main = list.filter((t) => t && t.isMain === true)[0];
			let owner = null;
			if (main) {
				const rec = records.filter((r) => r.roots.some((x) => samePath(x.path, main.path)))[0];
				owner = rec ? rec.name : (baseName(main.path) || null);
			}
			const worktrees = list.map((t) => {
				const label = worktreeLabel(t);
				return {
					kind: "worktree",
					key: (t && t.path) || "",
					path: (t && t.path) || null,
					label: label || (t && t.path) || "worktree",
					branch: (t && t.branch) || null,
					owner: owner,
					matched: hit([label, t && t.path, t && t.branch, owner]),
				};
			});
			return { groups: groups, worktrees: worktrees };
		}

		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			// 槽位（2026-10-11 方案 B 定稿）：`actions` 是**左侧**那一簇（titleCluster 内），`utilities` 才是右侧。
			// 头部布局 = 上下文在左 / 动作在右 ⇒ 本入口（上下文）占 actions。
			const SLOT = "conversation.session.header.actions";
			/**
			 * hero（空白会话屏）那行的**官方浮层槽** —— 2026-10-16 方案 A：我们用 `priority: -10` 遮蔽它，
			 * 换上自己的合并面板（官方那枚 WorkspaceChip 本身改不了，见文件头）。
			 */
			const HERO_SLOT = "conversation.hero.workspace";
			/** 菜单互斥用 id（见 client.js 的 createMenuCoordinator）。合并后只剩一个入口 ⇒ 一个 id ✓。 */
			const MENU_ID = "vssaros-context-entry";
			const readSnapshot = () => {
				try {
					const workspaces = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
					return workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
				} catch (e) {
					state.workspaceError = String((e && e.message) || e);
					return null;
				}
			};
			/**
			 * 当前会话的 `cwd`（= 它实际跑在哪个目录；与推送项做 `samePath` 判定"当前 worktree"）。
			 * 读 dsh 客户端自带的会话快照，**不引入第二套真相**；取不到返回 null（不猜）。
			 */
			const readCurrentDir = (sid) => {
				try {
					const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
					const snap = sessions && sessions.list ? sessions.list.getSnapshot() : null;
					const row = snap && snap.byId && sid ? snap.byId[sid] : null;
					return row && typeof row.cwd === "string" && row.cwd ? row.cwd : null;
				} catch (e) {
					state.worktreeError = String((e && e.message) || e);
					return null;
				}
			};
			/**
			 * 目录选择器服务（**运行时可选**取，不进 inject —— 理由见文件头）。
			 * 取不到 ⇒ 调用方如实说"宿主没有目录选择器"，**不**退化成"让用户手输路径"（那是另一件事 ✗）。
			 */
			const readDirectoryPicker = () => {
				try {
					return typeof ctx.get === "function" ? ctx.get("remote.directoryPicker") : undefined;
				} catch (e) {
					state.directoryPickerError = String((e && e.message) || e);
					return undefined;
				}
			};
			/** 工作区服务（创建用；列表读的是它的 `list` 快照，见 `readSnapshot`）。 */
			const readWorkspacesService = () => {
				try {
					return typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
				} catch (e) {
					state.workspaceError = String((e && e.message) || e);
					return undefined;
				}
			};

			/**
			 * 两条数据源的订阅（chip 与两个表面的面板共用一份实现）。
			 *
			 * 与官方同一订阅源（`dsh-client-ui-workspace` 也是 `workspaces.list.subscribe`）：
			 * 会话换绑/新建工作区后 chip 跟随更新，不需要轮询 ✓。
			 * ⚠ 必须防"没有 DOM"：单测跑在 Node，`document` 未定义（`readPushedWorktrees` 已防 ✓）。
			 */
			/**
			 * 工作区入口的**诊断位**（宿主自证快照会读它，见 `dshViewHost.ts` 的 `PAGE_SURFACE_REPORT`；
			 * 快照只在**变化时**进 IDE 日志 ⇒ 这里每次刷新都会被记下来 ✓）。
			 *
			 * 为什么要它（2026-10-17 用户报「切工作区后工作区 UI 没刷新」）：这条链有四五跳，出问题时光看界面
			 * 分不清卡在哪 —— 现在一眼能答：
			 *   · `sidFrom` / `sid`：chip 用的是 **props 给的**会话 id 还是 `state.sessionId`（★ props 非空会**遮蔽**
			 *     state ✓ —— 换绑只改 state，所以"props 是旧的"就会永远显示旧工作区 ✗）；
			 *   · `currentId` / `label`：算出来的"当前工作区"与最终文案；
			 *   · `workspaces` / `records` / `worktrees`：三条数据源各到了几条；
			 *   · `rebinds` / `lastRebind`：宿主**真的换绑过**没有（没换绑 ⇒ 问题在宿主那一跳，不在页面 ✓）；
			 *   · `switches` / `lastSwitch*`：切换请求、跳过（已经是当前项）、成功/失败原因。
			 * ⚠ 只记**计数与短字符串**：这份快照每 15 秒随日志走一次，不能变成噪声 ✗。
			 */
			function noteWorkspaceUi(patch) {
				try {
					// ⚠ **不要**在这里塞 `at: Date.now()`：宿主那侧是"自证快照**变了才**写一行日志"✗⇒
					//   一个每帧都变的时间戳会让安静的页面每 15 秒吐一行噪声（正好把真信号淹掉 ✗）。
					//   时间戳只放在**事件**里（`lastRebind.at` / `lastSwitch.at` —— 那才是有意义的时刻 ✓）。
					const prev = state.workspaceUi || {};
					state.workspaceUi = Object.assign({}, prev, patch);
					const ring = state.workspaceUiLog || (state.workspaceUiLog = []);
					if (patch && patch.event) {
						ring.push(String(patch.event));
						if (ring.length > 8) { ring.splice(0, ring.length - 8); }
					}
				} catch { /* 诊断位本身绝不能影响渲染 ✓ */ }
			}

			function useContextData() {
				const [snapshot, setSnapshot] = react.useState(readSnapshot);
				const [pushed, setPushed] = react.useState(readPushedWorktrees);
				// IDE 工作区记录（多根工作区，2026-10-16）：与 worktree 同一条推送通道的**另一条**，
				// 只在"分组"上用（条目本身仍来自 dsh 快照 ✓ —— 见 `buildTree` 的回落契约）。
				const [records, setRecords] = react.useState(readPushedWorkspaces);
				// 会话快照订阅：换绑后重渲染（"当前目录"变了，当前项要跟着动 ✓）。用 tick 而不是改 pushed
				// —— 从前那版调 `setList(readPushedWorktrees())` 只是借"新数组"骗一次重渲染 ✗（语义含糊）。
				const [, setTick] = react.useState(0);
				react.useEffect(() => {
					let sub = null;
					try {
						const workspaces = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
						if (workspaces && workspaces.list && typeof workspaces.list.subscribe === "function") {
							sub = workspaces.list.subscribe(() => setSnapshot(readSnapshot()));
						}
					} catch (e) {
						state.workspaceError = String((e && e.message) || e);
					}
					return () => { try { if (typeof sub === "function") { sub(); } } catch { /* 已释放 */ } };
				}, []);
				react.useEffect(() => {
					if (typeof document === "undefined") { return undefined; }
					const onPush = () => setPushed(readPushedWorktrees());
					document.addEventListener(WORKTREE_EVENT, onPush);
					return () => document.removeEventListener(WORKTREE_EVENT, onPush);
				}, []);
				react.useEffect(() => {
					if (typeof document === "undefined") { return undefined; }
					const onPush = () => setRecords(readPushedWorkspaces());
					document.addEventListener(WORKSPACE_EVENT, onPush);
					return () => document.removeEventListener(WORKSPACE_EVENT, onPush);
				}, []);
				react.useEffect(() => {
					let sub = null;
					try {
						const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
						if (sessions && sessions.list && typeof sessions.list.subscribe === "function") {
							sub = sessions.list.subscribe(() => setTick((n) => n + 1));
						}
					} catch (e) { state.worktreeError = String((e && e.message) || e); }
					return () => { try { if (typeof sub === "function") { sub(); } } catch { /* 已释放 */ } };
				}, []);
				// ★ 会话**换绑**（宿主 rebind）也逼一次重渲 —— 见 `REBIND_EVENT` 的注释：`client.js` 那条处理
				//   只改字段不重渲；而工作区入口的"当前工作区"完全由当前会话决定 ⇒ 漏了这一次，chip 就会停在
				//   换绑前的工作区（用户 2026-10-17 报的正是这个症状）。
				react.useEffect(() => {
					if (typeof document === "undefined") { return undefined; }
					const onRebind = (e) => {
						const sid = e && e.detail && typeof e.detail.sessionId === "string" ? e.detail.sessionId : null;
						const n = (state.workspaceRebinds || 0) + 1;
						state.workspaceRebinds = n;
						noteWorkspaceUi({
							event: "rebind", rebinds: n,
							// `stateSid` = 入口 chunk 那个监听器是否已先跑过（它先注册 ⇒ 正常应等于 sid ✓；
							// 不等就说明页面侧状态与事件不同步，是真机取证时要看的第一个字段）
							lastRebind: { sid: sid, stateSid: state.sessionId || null, at: Date.now() },
						});
						setTick((x) => x + 1);
					};
					document.addEventListener(REBIND_EVENT, onRebind);
					return () => document.removeEventListener(REBIND_EVENT, onRebind);
				}, []);
				return { snapshot, worktrees: pushed, records: records };
			}

			/**
			 * **合并面板本体**（受控，只渲染菜单、不渲染触发器）—— header 用我们自己的 chip 触发，
			 * hero 用**官方那枚 WorkingChip** 触发（我们遮蔽的只是官方浮层 ⇒ hero 里仍只有一枚 chip ✓）。
			 *
			 * 两个表面的差异只有三处，且都**必须**不同（见文件头"点击语义不同"）：
			 *   ① 点击工作区行：header = `bridge.switchWorktree(path)`；hero = `props.onPickWorkspace(id)`
			 *   ② 定位：header = 挂在 chip 的 relative 容器里（absolute）；hero = fixed（锚点来自官方 chip 的 rect）
			 *   ③ 关闭：header = 自己的 open state；hero = 官方 `onClose`（`pickerOpen` 由官方持有）
			 * ⚠ 所有 hooks 都在本函数**最前面**（`if (!open) return null` 之后不许再出现 hook ✗：
			 *   假 react（IDE 侧测试）按调用序存值，条件 hook 会串位 ⇒ 真 React 也不允许 ✓）。
			 */
			function ContextPanel(props) {
				const open = !!(props && props.open);
				const mode = props && props.mode === "hero" ? "hero" : "header";
				const data = (props && props.data) || { snapshot: null, worktrees: [] };
				const sid = props && props.sessionId;
				const menuStyle = (props && props.menuStyle) || {};
				const onRequestClose = (props && props.onRequestClose) || (() => undefined);
				const onPickWorkspace = props && props.onPickWorkspace;
				/**
				 * 取"触发器元素"（懒读 ⇒ 必须传 **getter** 而不是元素：渲染那一刻 ref 还没挂上 ✗）。
				 * 用途：点外关闭时把触发器也算"内部" —— 不然点它先关（mousedown）再开（onClick toggle）
				 * ⇒ 表现为"点 chip 关不掉" ✗。
				 */
				const getAnchorEl = (props && props.getAnchorEl) || (() => null);
				const [query, setQuery] = react.useState("");
				const [note, setNote] = react.useState(null);
				const [busy, setBusy] = react.useState(false);
				/**
				 * 右栏详情跟哪一条（稿 A：主从两栏）。
				 *
				 * 语义：**悬停/键盘移动到某行 ⇒ 右栏换成它的详情**；不点也能先看清"这条有哪些根、
				 * 主根是哪个、我现在在不在它里面" ✓ —— 平铺版做不到这一点（根全堆在列表里 ✗）。
				 * `null` = 还没指过任何行 ⇒ 默认跟**当前**那条（其次第一条），因此"打开就看到我在哪" ✓。
				 * ⚠ 默认值必须是 null（不能初始化成"当前那条"）：`currentGroupKey` 在 hook 之后才算得出来 ✓。
				 */
				const [detailKey, setDetailKey] = react.useState(null);
				const panelRef = react.useRef(null);
				react.useEffect(() => {
					if (!open) { return undefined; }
					if (typeof document === "undefined") { return undefined; }
					const close = (ev) => {
						const t = ev && ev.target;
						if (panelRef.current && t && panelRef.current.contains(t)) { return; }
						// ⚠ 触发器（hero 里是**官方那枚 chip**）也算"内部"：不然点它会先关（mousedown）
						//   再开（官方 onClick toggle）⇒ 表现为"点 chip 关不掉" ✗。
						const anchor = getAnchorEl();
						if (anchor && typeof anchor.contains === "function" && t && anchor.contains(t)) { return; }
						onRequestClose();
					};
					const esc = (ev) => { if (ev && ev.key === "Escape") { onRequestClose(); } };
					document.addEventListener("mousedown", close, true);
					document.addEventListener("keydown", esc, true);
					return () => {
						document.removeEventListener("mousedown", close, true);
						document.removeEventListener("keydown", esc, true);
					};
				}, [open, onRequestClose]);
				// 菜单互斥：打开本菜单前关掉别的（多个菜单叠着时，被视图裁掉的部分同样像"被遮挡"）。
				react.useEffect(() => {
					if (!open || !shell.menus) { return undefined; }
					shell.menus.closeOthers(MENU_ID);
					return shell.menus.register(MENU_ID, onRequestClose);
				}, [open, onRequestClose]);

				if (!open) { return null; }
				const items = (data.snapshot && data.snapshot.items) || [];
				const worktrees = data.worktrees || [];
				// IDE 工作区记录（多根工作区）：**只用来分组**，条目来源仍严格是 dsh 快照 ✓（见 `buildTree`）。
				const records = data.records || [];
				// "当前工作区"的两条判据**不能混用**（合并入口最容易在这里出错 ✗）：
				//   · header：会话归属（`workspaceIdOfSession`）—— 会话是宿主持有的事实 ✓
				//   · hero：官方给的 `selectedId`（`pendingWorkspaceId ?? sessionWorkspace.workspaceId`）——
				//     空白屏**还没有会话**，权威是"页面待定的选择" ✓（用会话归属会永远读到 null ✗）
				const currentId = mode === "hero"
					? ((props && props.selectedWorkspaceId) || null)
					: workspaceIdOfSession(data.snapshot, sid);
				const dir = readCurrentDir(sid);
				/**
				 * ★ 2026-10-17（用户要求"两侧保持独立"）：本面板**不再**切 IDE 的窗口工作区
				 * （`bridge.switchWorkspace` 仍在桥里，只是这里不调）⇒ 行尾/主命令/说明一律按
				 * "在本目录开会话"写，不再出现"切换工作区"这种会承诺窗口变化的说法（假话 ✗）。
				 * 只判本面板真正依赖的那条能力：`switchWorktree`。
				 */
				const canSwitchSession = !!(bridge && typeof bridge.switchWorktree === "function");
				const tree = buildTree({ workspaces: items, records: records, worktrees: worktrees, query: query });
				const shownGroups = tree.groups.filter((r) => r.matched);
				const shownWorktrees = tree.worktrees.filter((r) => r.matched);
				/**
				 * "当前工作区"**只允许一个组**（★ 2026-10-17 真机截图抓到的回归）：
				 * 同一个主根常被**多条记录**认领（4 根那条 + `workspace.json` 那条 + 单根那条 ⇒ 主根都是同一目录），
				 * 按"路径相等"逐行判会把**三行**都标成"当前" ✗✗（用户截图：`sarosis-agents-client · 4 根` 与
				 * `workspace.json · 3 根` 同时带 ✓）。⇒ 先算出**唯一的** `currentGroupKey`，再逐行比 key ✓。
				 *
				 * 选谁（优先级）：
				 *   ① **会话 cwd 命中的组**（header；`dir` = 宿主持有的 `session.start({cwd})` 事实）——
				 *      按**组的各根**比（不是只比主根）：会话跑在非主根上也该把整个工作区标成"当前" ✓；
				 *   ② ①没有 ⇒ 用 **workspaceId 命中**的组 —— header 是 `workspaceIdOfSession`；
				 *      hero（空白屏**还没有会话**⇒ 没有可信 cwd）是官方 `selectedId`；
				 *      `buildTree` 的"一条快照条目只被一条记录认领"保证了这里**至多一个** ✓。
				 *
				 * ★ 2026-10-28（用户报障「左侧工作区 hover 卡片的"当前会话"根，与聊天输入框上方 chip 的
				 *   工作区不一致」）：原来 header **先**看 workspaceId（`items[].sessionIds` 归属），cwd 只作兜底
				 *   ⇒ 而 dsh 那份 `sessionIds` 是**分组记录**，会话换过目录后仍可能挂在旧条目上（真机：会话
				 *   `cwd` = `…\sarosis-agents-client`，条目却挂在 `…\Saros-switch` 下）⇒ 面板标的"当前"和
				 *   chip 下拉里那行 `当前会话 cwd` 指两个不同工作区 ✗。现在 header 侧**cwd 优先**，
				 *   与 chip 的 `readCurrentDir` / 左侧 `client.workspaces.js` 的 `cwd` 口径**完全同一套** ✓。
				 *   hero 侧不变（空白屏没有会话 ⇒ workspaceId 才是权威 ✓）。
				 */
				const currentGroupKey = (() => {
					const byRoot = dir
						? tree.groups.filter((g) => (g.roots || []).some((r) => r && samePath(r.path, dir)))
						: [];
					const byId = tree.groups.filter((g) => (g.ids || []).indexOf(currentId) >= 0);
					const bestByRoot = () => {
						if (!byRoot.length) { return null; }
						const best = byRoot.filter((g) => (g.ids || []).length > 0)[0]
							|| byRoot.slice().sort((a, b) => (b.roots ? b.roots.length : 0) - (a.roots ? a.roots.length : 0))[0];
						return best.key;
					};
					if (mode !== "hero") {
						const keyByRoot = bestByRoot();
						if (keyByRoot) { return keyByRoot; }
					}
					if (byId.length) { return byId[0].key; }
					return mode === "hero" ? bestByRoot() : null;
				})();
				/** 组是不是"当前"：只比上面那个**唯一**的 key ✓。 */
				const isCurrentGroup = (g) => !!currentGroupKey && g.key === currentGroupKey;
				/** 组里哪个根是当前会话的 `cwd`（没有 ⇒ null）—— 多根组的根行靠它标"当前会话 cwd" ✓。 */
				const currentRootOf = (g) => (dir ? (g.roots.filter((r) => samePath(r.path, dir))[0] || null) : null);
				// 搜索框只在条目偏多时出现（少时它是噪声 ✗；mockup ③ 的口径 = >6 ✓）。
				// ⚠ 多根之后**一行工作区会带出若干根行** ⇒ 计数必须把根算进去，
				//   否则会出现"看着 8 行却没有搜索框"✗（阈值是给人看的，不是给组数看的 ✓）。
				const totalRows = tree.groups.reduce((n, g) => n + 1 + (g.multi ? g.roots.length : 0), 0) + tree.worktrees.length;
				const withSearch = totalRows > 6;
				/**
				 * 切到某个目录。两类条目共用：宿主侧就是 `session.start({cwd})` 拿/建该目录的专属会话
				 * 并 rebind 回本视图 ⇒ 页面随后按 rebind 的会话重新渲染 ✓（两边不分叉 ✓）。
				 */
				const switchTo = (row) => {
					// **先关菜单再做事**（与合并前的旧实现一致）：失败/拒绝的提示只在菜单里渲染 ⇒
					// 用户"重新点开菜单"才看得见原因 ✓。⚠ 别顺手改成"不关菜单"—— IDE 侧用例的
					// `reopened()` 正是靠这个顺序读原因的（点了照样 toggle ⇒ 不关就变成"关掉" ✗）。
					onRequestClose();
					setNote(null);
					const path = row && row.path;
					if (!path) {
						// ⚠ hero 的**工作区组行**连主根都读不到时，走不到下面的通用路径（没有目录就无从 `session.start`）
						//   ⇒ 这时才回落到官方 `onPick`（页面侧选中）。这是"官方语义"在本文件里**唯一**的保留点 ✓
						//   （2026-10-17 口径变更后，hero 点工作区**默认是真的切过去**，见下面那段注释 ✓）。
						if (mode === "hero" && row.kind === "workspace" && typeof onPickWorkspace === "function" && row.dshKnown !== false) {
							noteWorkspaceUi({
								event: "hero-pick-only:no-path",
								heroPick: { key: row.key || null, ids: Array.isArray(row.ids) ? row.ids : [], dshKnown: row.dshKnown !== false, ideId: row.ideId || null, kind: row.kind },
								lastSwitch: { kind: row.kind, id: row.key || row.id || null, at: Date.now(), result: "hero-pick-only" },
							});
							try { onPickWorkspace(row.key); } catch (e) { setNote(String((e && e.message) || e)); }
							return;
						}
						// 没有目录就无从 `session.start`（宿主那边 cwd 是必需的）⇒ 说清，不做半截事 ✗
						setNote("这个条目读不到目录（path 为空）⇒ 切不过去");
						return;
					}
					// ⚠ "当前项"的判据不能混用（见上面 `currentId` 的注释）：工作区行按**会话归属的组**
					//   （`row.ids` 含当前工作区 id —— 多根之后组里有好几条快照，只比一个 id 会漏 ✗）、
					//   根行 / worktree 行按 `path` 的 `samePath`。混用会白跑一次 `session.start` ✗（守卫抓到过 ✓）。
					// ⚠ 与 `isCurrentGroup` **同口径**（2026-10-17 起工作区行也认"会话 cwd 兜底"）：
					//   两边判据不一致会出现"面板标着当前、再点它却真切了一次"（白跑一次 session.start ✗）。
					// 工作区行与 `isCurrentGroup` **同一把尺子**（只比唯一的 `currentGroupKey`）——
					// 两边不一致会出现"面板标着当前、再点它却真切一次"（白跑一次 session.start ✗）。
					const isCurrentRow = row.kind === "workspace"
						? (!!currentGroupKey && row.key === currentGroupKey)
						: samePath(path, dir);
					if (isCurrentRow) {
						// 记一笔：这一条最容易被误读成"点了没反应"（其实**已经**在当前项上 ⇒ 什么也不做才是对的 ✓）
						noteWorkspaceUi({
							event: "switch-skip:current",
							// ⚠ `id` 用 `row.id || row.key` 兜底：**组行没有 `id` 字段**（只有 `key`/`ids`）⇒
							//   只记 `row.id` 会永远记成 null，等于没记 ✗（真机日志吃过这个亏，见 README 5.149 ✓）
							lastSwitch: { kind: row.kind, path: path, id: row.id || row.key || null, targetIds: Array.isArray(row.ids) ? row.ids : [], at: Date.now(), result: "skip-current" },
						});
						return;
					}
					/**
					 * 失败要让用户**看得见**：面板在这一刻已经关了（`onRequestClose()` 在上面）⇒ 只写 `note`
					 * 等于"什么都没发生"（用户报的"点了没反应"就是这么来的 ✗）⇒ 再补一条系统通知；
					 * 老桥没有 `notify` 就只留 note ✓（不假装已通知）。
					 * ⚠ 定义必须在**所有分支之前**（hero 那条也要用 ✓）。
					 */
					const fail = (msg) => {
						setNote(msg);
						if (bridge && typeof bridge.notify === "function") {
							try { bridge.notify("attention", msg); } catch { /* 通知失败不影响别的 */ }
						}
					};
					/**
					 * ★ 2026-10-17 **口径变更**（用户报障 + 真机日志，见 README 5.149）：hero 的**工作区行**
					 * 从前只做"IDE 窗口进该工作区 + 官方 `onPick` 选中"、**不换会话** —— 设计理由是保住官方
					 * "先选目录再写第一句话"那屏。但真机实测（`logs/20261017T084908`）用户在 hero 连点 4 次：
					 * IDE 窗口 15ms 就切过去了 ✓，而聊天框**零变化**（`workspaceUiLog:["hero-pick"×4]`、`rebinds:0`）
					 * ⇒ 用户看到的就是"**切不了工作区**" ✗✗（点 4 次就是因为这个）。
					 * ⇒ 现在与 header **同口径**：在它的主根 `session.start` + rebind（即下面那段通用路径，
					 *   不再有 hero 特例）⇒ 点了**真的切过去**、界面立刻跟着变 ✓。
					 * 代价：离开 hero（官方那屏）—— 换来"点了有反应且真的切了" ✓。
					 * ⚠ 只有"连主根都读不到"时才回落到官方 `onPick`（见上面 `if (!path)` 那一支 ✓）。
					 * ⚠ **不切 IDE 窗口工作区**（2026-10-17 用户要求两侧独立，见文件头）：这里只有"换会话"一件事。
					 */
					if (!bridge || typeof bridge.switchWorktree !== "function") {
						setNote("页面桥过旧：不支持切换工作区 / worktree（不会退化成只切页面选择 —— 那会让两边会话不一致）");
						return;
					}
					/**
					 * 记"**这次点击要干什么**"，且**同步**落地（不是等宿主回来才记）——
					 * 真机取证要靠它区分"点了但宿主没回"（结果停在 `sent` ✗）与"宿主回了但页面没重渲"（`rebinds` 不涨 ✗）✓。
					 * ⚠ `id` 用 `row.id || row.key` 兜底：组行没有 `id` 字段（只有 `key`/`ids`）⇒ 只记 `id` 会永远记成 null ✗
					 *   （真机日志吃过这个亏，见 README 5.149 ✓）。
					 */
					const attempt = { kind: row.kind, path: path, id: row.id || row.key || null, targetIds: Array.isArray(row.ids) ? row.ids : [], fromSid: sid || null, fromId: currentId || null };
					/**
					 * ★ 2026-10-17（真机取证后补）：**hero 屏**顺带把**官方选中态**也对齐。
					 *
					 * 为什么必须做：hero 屏上用户能看见的那枚工作区是**官方的**（我们只挂浮层面板，`contextChip:false` ✓），
					 * 而真机日志显示**切完之后屏还在 hero**（`contextHeroEntry:true`）⇒ 那一屏显示什么，全看官方
					 * 选中态有没有跟上。官方自己跟不跟得上没有保证（实测两次自证之间它才变一次）⇒ 只靠它就可能是
					 * "点了没反应/UI 没刷新" ✗✗。这里在**真的切**（窗口 + 会话）之后，再用 dsh 那条 id 把官方选中
					 * 对齐一次 —— 两件事各管一件事、互不冲突 ✓。
					 * ⚠ 只在**有 dsh id** 时调（`onPick` 只认 dsh workspaceId；`ide:` 兜底 key 传过去是编的 ✗）。
					 * ⚠ 失败不影响上面那两件（官方拒绝 ≠ 切换失败）⇒ 吞掉异常、只做诊断 ✓。
					 */
					// ⚠ 只对**工作区行**（`kind === "workspace"`）：worktree 行不是"选工作区"（`onPick` 只认
					//   dsh workspaceId）⇒ 顺手对它调一次是**编**行为（守卫当场抓到过 ✓）。
					if (mode === "hero" && row.kind === "workspace" && typeof onPickWorkspace === "function"
						&& row.dshKnown !== false && row.key && String(row.key).indexOf("ide:") !== 0) {
						try {
							onPickWorkspace(row.key);
							noteWorkspaceUi({ event: "hero-onpick:" + String(row.key).slice(-12) });
						} catch (e) {
							noteWorkspaceUi({ event: "hero-onpick-failed", heroPickError: String((e && e.message) || e) });
						}
					}
					const switchesSoFar = (state.workspaceSwitches || 0) + 1;
					state.workspaceSwitches = switchesSoFar;
					noteWorkspaceUi({ event: "switch:" + String(row.kind), switches: switchesSoFar, lastSwitch: Object.assign({}, attempt, { result: "sent", at: Date.now() }) });

					/** ② 让宿主在目标目录起/接管会话（与 worktree 同一条命令 ✓）。 */
					const switchSession = () => {
						const base = attempt;
						try {
							Promise.resolve(bridge.switchWorktree(path)).then(
								() => {
									state.contextSwitches = (state.contextSwitches || 0) + 1;
									noteWorkspaceUi({ event: "switch-ok", lastSwitch: Object.assign({}, base, { result: "ok", at: Date.now(), rebindsSoFar: state.workspaceRebinds || 0 }) });
								},
								(e) => {
									const msg = String((e && e.message) || e);
									noteWorkspaceUi({ event: "switch-fail", lastSwitchError: msg, lastSwitch: Object.assign({}, base, { result: "failed", at: Date.now() }) });
									fail(msg);
								});
						} catch (e) {
							const msg = String((e && e.message) || e);
							noteWorkspaceUi({ event: "switch-fail", lastSwitchError: msg, lastSwitch: Object.assign({}, base, { result: "threw", at: Date.now() }) });
							fail(msg);
						}
					};
					/**
					 * ★ 2026-10-17 **口径再变更**（用户要求：两侧保持独立）：
					 * 聊天框切工作区**不再**动 IDE 的窗口工作区（ActivityBar / 资源管理器里那份 folders 一律不动）。
					 * 从前这里会先发 `bridge.switchWorkspace(ideId)` 让 IDE 窗口原地进该工作区，再起会话 ——
					 * 结果是"在聊天框里点一下，整窗的文件夹树/ActivityBar 跟着换"，把两个本应独立的东西绑死了 ✗。
					 * ⇒ 现在只有一件事：让宿主在**目标目录**起/接管会话（`switchWorktree(path)`，与 worktree 行同一条命令 ✓）。
					 * ⚠ 桥那侧的 `switchWorkspace` 命令**保留不删**（宿主能力还在、别的入口可能用），只是本面板不再调用。
					 */
					switchSession();
				};
				/**
				 * 添加工作区（用户 2026-10-16 要求的补口）。
				 *
				 * ⚠ 走 `remote.directoryPicker.pick()` 而**不是**官方那个 `directoryFlow` 子槽：
				 *   那个子槽由官方浮层渲染，而我们遮蔽的正是官方浮层 ⇒ 渲染不到它 ✗；
				 *   但底层是**同一个** `DirectoryPickerController` ⇒ 能力等价 ✓（native 插件那条链）。
				 */
				const addWorkspace = () => {
					if (busy) { return; }
					const picker = readDirectoryPicker();
					if (!picker || typeof picker.pick !== "function") {
						setNote("宿主没有目录选择器（remote.directoryPicker 不可用）⇒ 加不了工作区");
						return;
					}
					setBusy(true);
					setNote(null);
					Promise.resolve()
						.then(() => picker.pick())
						.then((res) => {
							if (!res || res.ok !== true) {
								setBusy(false);
								setNote("没有选到目录：" + String((res && res.error && res.error.message) || "已取消"));
								return undefined;
							}
							const value = res.value;
							const path = typeof value === "string" ? value : (value && value.path);
							if (!path) {
								setBusy(false);
								setNote("目录选择器没返回路径 ⇒ 加不了工作区");
								return undefined;
							}
							const workspaces = readWorkspacesService();
							if (!workspaces || typeof workspaces.create !== "function") {
								setBusy(false);
								setNote("workspaces 服务不可用 ⇒ 加不了工作区");
								return undefined;
							}
							return Promise.resolve(workspaces.create({ path })).then((created) => {
								setBusy(false);
								state.contextAdds = (state.contextAdds || 0) + 1;
								if (mode === "hero" && typeof onPickWorkspace === "function") {
									// hero：与官方 `adoptDirectory → onPick` 同语义（采纳即选中 ✓）
									const id = created && (created.workspaceId
										|| (created.workspace && created.workspace.workspaceId));
									if (id) { onPickWorkspace(id); }
									return;
								}
								// header：**不**自动切（那会让"添加"变成一个会换会话的动作 ✗）⇒ 就地提示
								setNote("已添加工作区：" + path + "（在列表里选中它即可切过去）");
							}, (e) => {
								setBusy(false);
								const msg = String((e && e.message) || e);
								state.lastContextAddError = msg;
								setNote("添加失败：" + msg);
							});
						}, (e) => {
							setBusy(false);
							const msg = String((e && e.message) || e);
							state.lastContextAddError = msg;
							setNote("添加失败：" + msg);
						});
				};

				const HEADING = { fontSize: 10.5, letterSpacing: ".03em", color: "var(--dsw-alias-label-secondary, currentColor)", padding: "6px 8px 3px" };
				const SUB = { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 };
				const BADGE = { marginLeft: 6, fontSize: 10, color: "var(--dsw-alias-label-secondary, currentColor)" };
				const EMPTY = { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "4px 8px 6px" };
				const pane = [];
				if (withSearch) {
					pane.push(react.createElement("div", { key: "s", style: { padding: "3px 5px 5px" } },
						react.createElement("input", {
							type: "search", "data-vssaros-context-search": "1", "aria-label": "搜索工作区或 worktree",
							value: query, placeholder: "搜索工作区 / 根 / worktree（名称、路径、分支）",
							onChange: (ev) => setQuery(String((ev.target && ev.target.value) || "")),
							style: {
								width: "100%", boxSizing: "border-box", fontSize: 11.5, padding: "4px 7px", borderRadius: 6,
								border: "1px solid var(--dsw-alias-border-l1, transparent)",
								background: "var(--dsw-alias-bg-layer-2, transparent)",
								color: "var(--dsw-alias-label-primary, currentColor)",
							},
						})));
				}
				// ── 「当前会话」栏（稿 C）──────────────────────────────────────────────
				// 多根之后"这个会话实际跑在哪个根上"必须写在脸上：不给的话用户会以为在 A 根、
				// 其实跑在 B 根（`session.start({cwd})` 一旦定了就定死 ✓）⇒ 表现为"改不动 / 写不进去" ✗。
				// ⚠ **只报事实、不报"可写范围"**：写根由沙箱策略决定（当前实现 = 会话 cwd 单根；
				//   拍板 ② 的 α「写全部根」还没接入）⇒ 在这里印"可写：全部 N 个根"会是**假话** ✗
				//   （本仓纪律：UI 文案必须描述"这次真正会发生的事" ✓）。α 落地后再补那一行 ✓。
				const currentGroup = tree.groups.filter((g) => isCurrentGroup(g))[0] || null;
				if (dir) {
					pane.push(react.createElement("div", {
						key: "cur-h",
						style: Object.assign({ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }, HEADING),
					},
						react.createElement("span", null, "当前会话"),
						currentGroup && currentGroup.multi ? react.createElement("span", {
							style: { fontSize: 10, fontWeight: 400 },
						}, currentGroup.label + " · " + currentGroup.roots.length + " 个根") : null));
					pane.push(react.createElement("div", {
						key: "cur-dir",
						style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "0 8px 6px", wordBreak: "break-all" },
					}, "cwd = " + String(dir)));
					pane.push(react.createElement("div", {
						key: "cur-div",
						style: { height: 1, background: "var(--dsw-alias-border-l1, transparent)", margin: "2px 8px 4px" },
					}));
				}
				/**
				 * 渲染一行（工作区组 / 根 / worktree **共用**）—— 差别只有 data 钩子、缩进与行尾那句话 ✓。
				 * ⚠ `data-vssaros-context-item` 的值是行为网的锚点（`workspace:<id>` / `worktree:<path>` /
				 *   `root:<path>`）⇒ **不许**为了好看改它（IDE 侧用例按前缀取行 ✓）。
				 */
				const rowButton = (spec) => react.createElement("button", {
					key: spec.key,
					type: "button", role: "menuitem",
					"data-vssaros-context-item": spec.attr,
					disabled: busy || spec.disabled === true,
					onClick: () => switchTo(spec.row),
					// 悬停 = 右栏预览这条的详情（稿 A）。只有列表行会传；根行/主命令不传 ⇒ undefined ✓
					onMouseEnter: spec.onHover,
					style: {
						display: "flex", alignItems: "flex-start", gap: 8, width: "100%",
						padding: spec.indent ? "5px 8px" : "6px 8px",
						marginLeft: spec.indent ? 14 : 0,   // 根行缩进：一眼看出"它们属于上面那个工作区" ✓
						border: "none", borderRadius: 7, textAlign: "left",
						cursor: spec.disabled === true ? "default" : "pointer",
						opacity: busy ? 0.6 : 1,
						background: spec.current ? "var(--dsw-alias-bg-layer-2, transparent)" : "transparent",
						color: "var(--dsw-alias-label-primary, currentColor)",
						fontSize: spec.indent ? 11.5 : 12,
					},
				},
					react.createElement("span", {
						style: { flex: "0 0 14px", width: 14, color: spec.current ? "var(--dsw-alias-brand-primary, currentColor)" : "transparent" },
					}, "✓"),
					react.createElement("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 } },
						react.createElement("span", { style: { fontWeight: spec.current ? 600 : 400 } },
							String(spec.label),
							spec.badges ? react.createElement("span", { style: BADGE }, spec.badges) : null),
						spec.sub ? react.createElement("span", { style: SUB }, String(spec.sub)) : null),
					spec.hint ? react.createElement("span", {
						style: { fontSize: 10.5, color: "var(--dsw-alias-label-secondary, currentColor)", whiteSpace: "nowrap", paddingLeft: 6 },
					}, spec.hint) : null);
				/**
				 * ── 稿 A：**主从两栏**（2026-10-17 定稿）─────────────────────────────────────────
				 * 左栏 = 目录清单（一行 ≈ 一个**工作区**／一条 worktree，根不在这一层平铺）；
				 * 右栏 = 选中那条的详情（主根 / 关联根 / 主命令）。
				 *
				 * 为什么改（真机截图 + 日志）：同一个主根被**三条记录**共用、根又全平铺 ⇒ 4 个工作区
				 * 撑成 12+ 行，用户既找不到"我在哪"，也看不出"点哪一行会去哪个目录" ✗。
				 * 两栏后：目录数量 = 行数（稳定），根只在你要看的那条下面出现 ✓。
				 *
				 * ⚠ 行为网的锚点**一个都不许动**：`workspace:<key>` / `root:<path>` / `worktree:<key>`
				 *   —— 只把根行从"全平铺"改成"右栏、且属于选中的那条"（`data-vssaros-context-pane`
				 *   是新增的结构标记，供版式用例断言 "左列表 / 右详情" ✓）。
				 */
				const sections = [
					{ kind: "workspace", title: "工作区", total: tree.groups.length },
					{ kind: "worktree", title: "worktree", total: tree.worktrees.length },
				];
				const listPane = [];
				const detailPane = [];
				for (const section of sections) {
					if (section.total === 0) { continue; }   // 这一组本来就没数据 ⇒ 连标题都不出 ✓
					listPane.push(react.createElement("div", { key: "h-" + section.kind, style: HEADING },
						section.title + "（" + section.total + "）"));
					if (section.kind === "worktree") {
						if (shownWorktrees.length === 0) {
							// ⚠ 与"本仓没有额外的 worktree"分开说：前者是**搜索没命中**、后者是**本来就没有** ✗
							listPane.push(react.createElement("div", { key: "e-worktree", style: EMPTY },
								query ? "没有匹配的 worktree" : "本仓没有额外的 worktree"));
							continue;
						}
						for (const t of shownWorktrees) {
							const isCurrent = samePath(t.path, dir);
							listPane.push(rowButton({
								key: "worktree:" + t.key,
								attr: "worktree:" + t.key,
								row: t,
								current: isCurrent,
								disabled: isCurrent,   // 当前项点了也是幂等 ⇒ 直接禁用（旧行为 ✓）
								label: t.label,
								// 分支 + **归属根名**：多根之后"feat/x 属于哪个仓"会歧义 ⇒ 一律带上 ✓
								badges: (t.branch && t.label !== t.branch ? t.branch + " " : "") + (t.owner ? "[" + t.owner + "] " : ""),
								sub: t.path,
								hint: isCurrent ? "当前" : "切换 →",
							}));
						}
						continue;
					}
					if (shownGroups.length === 0) {
						listPane.push(react.createElement("div", { key: "e-workspace", style: EMPTY }, "没有匹配的工作区"));
						continue;
					}
					for (const g of shownGroups) {
						const isCurrent = isCurrentGroup(g);
						listPane.push(rowButton({
							key: "workspace:" + g.key,
							attr: "workspace:" + g.key,
							row: g,
							current: isCurrent,
							label: g.label,
							// 「N 根」= 多根的**可见徽标**（稿 A 的底线能力 ✓）；
							// `.code-workspace` 身份**只读展示**（拍板 ④-i：这一轮不许拿它去切工作区 ✓）。
							badges: (g.multi ? g.roots.length + " 根 " : "") + (g.codeWorkspacePath ? ".code-workspace " : ""),
							sub: g.path,
							// ⚠ 行尾文案**按能力**写（不许含糊承诺）：本面板只换会话、不动 IDE 工作区
							//   ⇒ 一律写"开会话"（写"切换工作区"就是假话 ✗）。
							hint: isCurrent
								? "当前"
								: (!canSwitchSession
									? "桥不支持"
									: (g.multi ? "以主根开会话 →" : "以此根开会话 →")),
							// 悬停即"预览这条的详情"（不点也不换会话 ⇒ 安全 ✓）；键盘/鼠标都走它
							onHover: () => setDetailKey(g.key),
						}));
					}
				}
				// ── 右栏：选中工作区的详情（根 + 主命令）──────────────────────────────────
				const detailGroup = (() => {
					const byKey = detailKey ? shownGroups.filter((g) => g.key === detailKey)[0] : null;
					if (byKey) { return byKey; }
					// 默认跟**当前**那条（打开面板第一眼就该是"我在哪" ✓），其次第一条 ✓
					return tree.groups.filter((g) => isCurrentGroup(g))[0] || shownGroups[0] || null;
				})();
				if (detailGroup) {
					const g = detailGroup;
					const curRoot = currentRootOf(g);
					const isCurrent = isCurrentGroup(g);
					detailPane.push(react.createElement("div", { key: "d-t", style: { padding: "2px 6px 0" } },
						react.createElement("div", { style: { fontSize: 12.5, fontWeight: 600, wordBreak: "break-all" } }, String(g.label)),
						react.createElement("div", { style: Object.assign({}, SUB, { whiteSpace: "normal", wordBreak: "break-all", maxWidth: "none", marginTop: 2 }) },
							(g.multi ? g.roots.length + " 根 · " : "") + (g.codeWorkspacePath ? ".code-workspace · " : "") + String(g.path))));
					detailPane.push(react.createElement("div", {
						key: "d-k1",
						style: { fontSize: 10, letterSpacing: ".04em", color: "var(--dsw-alias-label-secondary, currentColor)", padding: "8px 6px 2px" },
					}, isCurrent ? "根（当前会话跑在标 ✓ 的那个上）" : "根（点一行 = 在那个目录开会话）"));
					// 各根都作为行渲染（`root:<path>` 锚点不变 ✓）；顺序 = `g.roots`（主根在前 ✓）
					for (const r of g.roots) {
						const isCurRoot = !!curRoot && samePath(r.path, curRoot.path);
						detailPane.push(rowButton({
							key: "root:" + g.key + ":" + r.path,
							attr: "root:" + r.path,
							row: { kind: "root", path: r.path },
							current: isCurRoot,
							disabled: isCurRoot,
							label: r.name,
							badges: r.isPrimary ? "主根 " : "关联根 ",
							sub: r.path,
							hint: isCurRoot ? "当前会话 cwd" : "开会话 →",
						}));
					}
					// 主命令：与"点整行"完全同一件事（`switchTo(g)` ⇒ 只换会话，不动 IDE 工作区 ✓）
					detailPane.push(react.createElement("button", {
						key: "d-go", type: "button",
						"data-vssaros-context-detail-action": "1",
						disabled: busy || isCurrent,
						onClick: () => switchTo(g),
						style: {
							marginTop: 10, width: "100%", padding: "6px 8px", borderRadius: 7,
							border: "1px solid var(--dsw-alias-border-l1, transparent)",
							background: isCurrent ? "transparent" : "var(--dsw-alias-brand-primary, transparent)",
							color: isCurrent ? "var(--dsw-alias-label-secondary, currentColor)" : "#fff",
							fontSize: 11.5, fontWeight: 500, cursor: isCurrent ? "default" : "pointer",
						},
					}, isCurrent ? "✓ 已在这里" : (canSwitchSession ? "以此主根开会话" : "页面桥过旧：切不了")));
				} else {
					detailPane.push(react.createElement("div", { key: "d-e", style: EMPTY },
						query ? "没有匹配的工作区" : "还没有工作区"));
				}
				pane.push(react.createElement("div", {
					key: "panes",
					style: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 6, padding: "2px 2px 0" },
				},
					react.createElement("div", {
						key: "list", "data-vssaros-context-pane": "list",
						style: { flex: "1 1 196px", minWidth: 172, maxWidth: 236, paddingRight: 5, borderRight: "1px solid var(--dsw-alias-border-l1, transparent)" },
					}, ...listPane),
					react.createElement("div", {
						key: "detail", "data-vssaros-context-pane": "detail",
						style: { flex: "1 1 236px", minWidth: 204, paddingLeft: 5 },
					}, ...detailPane)));
				// ── 「＋ 添加工作区…」（2026-10-16 新增；hero 与 header 共用这一行）─────────────
				// 钉在列表底部（与官方 `menu.addWorkspace` 同位置感 ✓）；两组都空时它是**唯一**能做的事 ⇒ 照样出 ✓。
				if (tree.groups.length === 0 && tree.worktrees.length === 0) {
					pane.push(react.createElement("div", {
						key: "empty",
						style: { fontSize: 11.5, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "6px 8px" },
					}, "还没有工作区"));
				}
				pane.push(react.createElement("button", {
					key: "add", type: "button", role: "menuitem",
					"data-vssaros-context-add": "1",
					disabled: busy,
					onClick: () => addWorkspace(),
					title: "打开系统的“选择文件夹”，把该目录加进工作区列表",
					style: {
						display: "flex", alignItems: "flex-start", gap: 8, width: "100%", padding: "6px 8px",
						marginTop: 4, border: "none", borderTop: "1px solid var(--dsw-alias-border-l1, transparent)",
						borderRadius: 7, textAlign: "left", cursor: busy ? "default" : "pointer",
						opacity: busy ? 0.6 : 1, background: "transparent",
						color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 12,
					},
				},
					react.createElement("span", {
						style: { flex: "0 0 14px", width: 14, color: "var(--dsw-alias-brand-primary, currentColor)" },
					}, "＋"),
					react.createElement("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
						react.createElement("span", { style: { fontWeight: 500 } }, busy ? "正在添加…" : "添加工作区…"),
						react.createElement("span", { style: SUB }, "由 dsh 打开系统的“选择文件夹”对话框"))));
				// ★ 语义必须写在脸上：dsh 的会话 cwd 在 session.start 时定死 ⇒ 换目录只能新开会话。
				pane.push(react.createElement("div", {
					key: "note-sem",
					style: { fontSize: 10.5, lineHeight: 1.5, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "5px 8px 6px", borderTop: "1px solid var(--dsw-alias-border-l1, transparent)", marginTop: 4 },
				}, mode === "hero"
					? "选工作区 = 在它的主根开始会话（只换聊天框的会话，IDE 的窗口工作区不动）；选 worktree = 在那个目录开始新会话（历史独立；当前 preset 保留）"
					: "选工作区 / worktree = 在那目录新建或接管会话（只换会话，IDE 的窗口工作区不动；历史独立；当前 preset 保留，但在新会话里重新装配）"));
				if (note) {
					pane.push(react.createElement("div", {
						key: "err", style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "2px 8px 6px" },
					}, note));
				}
				return react.createElement("div", {
					ref: panelRef, role: "menu",
					// 版式/交互锚点：hero 侧的"点外关闭"按它判"点在面板里还是外"（见 HeroContextPanel）。
					"data-vssaros-context-panel": "1",
					style: Object.assign({}, menuStyle),
				}, ...pane);
			}

			/**
			 * **header 那枚**：一枚 chip（方案 C）+ 上面的合并面板（absolute 挂在自己的 relative 容器里）。
			 *
			 * 与前两枚（🗂 工作区 / 🌿 worktree）的差别只有两个：入口合成了一个 ✓、面板多了一个搜索框 ✓；
			 * **判据、语义、命令一律照旧**（见文件头）⇒ 两条数据源各自"空则不显示假名字" ✓，
			 * 但"两组长都空才整体不渲染" ✓（等价合并前两枚各自 `return null` 的效果 ✓）。
			 */
			function ContextEntry(props) {
				const sid = (props && props.sessionId) || state.sessionId;
				const data = useContextData();
				const [open, setOpen] = react.useState(false);
				const rootRef = react.useRef(null);
				const items = (data.snapshot && data.snapshot.items) || [];
				const worktrees = data.worktrees || [];
				// ⚠ 记录也参与"要不要出入口"的判断：**只有 IDE 记录、dsh 那边一条都没登记**时也该出入口
				//   （否则用户在新窗口里点不到任何工作区 —— 那正是多根工作区最容易出现的态 ✓）。
				const records = data.records || [];
				if (items.length === 0 && worktrees.length === 0 && records.length === 0) {
					// 三组都空（服务未就绪 / 推送没到 / 本仓没有 worktree）⇒ 不出入口，不显示假名字 ✓
					return null;
				}
				const currentId = workspaceIdOfSession(data.snapshot, sid);
				const dir = readCurrentDir(sid);
				// ★ 2026-10-28（用户报「chip 上的工作区 ≠ 它自己下拉里的"当前"」）：**会话 cwd 优先**。
				//   `items[].sessionIds` 是 dsh 侧的分组记录，会话换过目录后仍可能挂在旧条目上 ⇒ 只按它取
				//   ⇒ chip 显示的是上一个工作区的名字，而同一枚 chip 展开后按 cwd 标的是另一个 ✗
				//   （真机：chip = Saros-switch，下拉 = sarosis-agents-client 主根）。
				//   现在与下拉（`currentGroupKey` 的 cwd 优先）和左侧栏（`rootOfSession`）**同一判据** ✓。
				const currentWsByDir = dir ? items.filter((w) => w && samePath(w.path, dir))[0] || null : null;
				const currentWs = currentWsByDir || items.filter((w) => w && w.workspaceId === currentId)[0] || null;
				const currentWt = worktrees.filter((w) => samePath(w && w.path, dir))[0] || null;
				// 当前工作区是不是多根（chip 上给一个「N 根」徽标 —— 稿 A 的底线能力 ✓）：
				// 用当前会话的 cwd 去记录里认领那一条（**不是**用 workspaceId —— 那是 dsh 侧的 id ✓）。
				// ★ 2026-10-17 兜底（与面板 `isCurrentGroup` 同一条纪律）：dsh 侧还没登记本会话所在的工作区时
				//   （`currentWs` 为 null），改用**会话 cwd** 去记录里认领 —— 否则多根徽标与名字都会丢 ✗
				//   （真机：切到 IDE-only 工作区后 chip 仍显示旧工作区，就是这里没有 cwd 面 ✓）。
				const currentRec = (currentWs
					? records.filter((r) => r.roots.some((x) => samePath(x.path, (currentWs.path || ""))))[0]
					: (dir ? records.filter((r) => r.roots.some((x) => samePath(x.path, dir)))[0] : null)) || null;
				// 显示名回落链：dsh 那条（title → 路径末段）→ worktree 项 → **会话 cwd 的末段**（真话：
				// 会话就跑在它里面 ✓）→ 泛称"工作区"。原则不变：**不编不存在的名字**，但也不显示旧工作区 ✗。
				const label = workspaceLabel(currentWs) || worktreeLabel(currentWt) || (dir ? baseName(dir) : null) || "工作区";
				// 诊断位（每次渲染刷一次）—— 见 `noteWorkspaceUi` 的注释：用户报"没刷新"时靠它归因到具体哪一跳。
				noteWorkspaceUi({
					sid: sid || null,
					// ★ 这条最能说明问题：`props` 有值就用 props（**遮蔽** state）⇒ 若 props 是换绑前的旧会话，
					//   chip 就会一直显示旧工作区；`state` 落在后面时才用得上 rebind 更新的那个值。
					sidFrom: (props && props.sessionId) ? "props" : (state.sessionId ? "state" : "none"),
					currentId: currentId || null,
					currentLabel: label === null ? null : String(label),
					workspaces: items.length,
					records: records.length,
					worktrees: worktrees.length,
					multiRoot: currentRec && currentRec.roots.length > 1 ? currentRec.roots.length : 0,
					open: open,
				});
				return react.createElement("span", { ref: rootRef, style: { position: "relative", display: "inline-flex" } },
					react.createElement("button", {
						type: "button", "data-vssaros-context-chip": "1",
						"aria-haspopup": "menu", "aria-expanded": open,
						// ⚠ 如实写明代价：切换 = 宿主在目标目录 `session.start` 一个会话（历史独立、
						//   preset 沿用）—— 不写就是让用户以为"只是换个视角" ✗（tooltip 带完整路径 ✓）。
						// 路径回落链同样要有**会话 cwd**（否则 dsh 未登记时 tooltip 里的路径是空的 —— 而
						// "会话到底跑在哪个目录"正是用户最需要看到的那一条 ✓）。
						title: [currentWt && currentWt.path ? currentWt.path : (currentWs && currentWs.path ? currentWs.path : (dir || "")),
							"选工作区 / worktree（会新建或接管会话，历史独立；agent/preset 沿用；**不动 IDE 的窗口工作区**）"].filter(Boolean).join("\n"),
						// ⚠ 只切开关：**不要**在这里清 `note` / `query` ✗ ——
						//   失败提示只在菜单里渲染（与旧 worktree 下拉同口径 ✓），一并清掉会让
						//   "重新点开菜单看原因"看不到原因 ✗（第一版就这么写，被守卫当场抓到 ✓）。
						onClick: () => setOpen(!open),
						style: {
							display: "inline-flex", alignItems: "center", gap: 4, maxWidth: 200,
							padding: "1px 8px", borderRadius: 999, cursor: "pointer",
							border: "1px solid var(--dsw-alias-border-l1, transparent)",
							background: "var(--dsw-alias-bg-layer-1, transparent)",
							color: "var(--dsw-alias-label-secondary, currentColor)",
							fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
						},
					}, react.createElement("span", { style: { opacity: 0.7 } }, "🗂"),
						react.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, String(label)),
						currentRec && currentRec.roots.length > 1 ? react.createElement("span", {
							style: { fontSize: 10, color: "var(--dsw-alias-label-secondary, currentColor)" },
						}, currentRec.roots.length + " 根") : null,
						" ▾"),
					react.createElement(ContextPanel, {
						open: open, mode: "header", data: data, sessionId: sid,
						getAnchorEl: () => rootRef.current,
						onRequestClose: () => setOpen(false),
						// 锚点方向：本簇在 header **左侧** ⇒ 菜单必须**向右**展开（写 `right: 0` 会让菜单
						// 越过视图左边缘、被左侧栏盖住一半 —— 2026-10-11 实测截图为证 ✗）。
						menuStyle: Object.assign({
							// ★ 2026-10-19：**fixed 而不是 absolute**（见 headerMenuBox 注释）——
							//   absolute + zIndex 只在祖先层叠上下文内比较，会被页面浮层压住 ✗。
							position: "fixed", zIndex: 1000,
							...headerMenuBox(rootRef),
							padding: 5, borderRadius: 10,
							// 条目多时不许无限长（没给锚点时这条兜底 ✓；`fitMenu` 有锚点时会算出真上限 ✓）
							maxHeight: 360, overflowY: "auto", minWidth: 300,
							// ★ 稿 A（2026-10-17）：主从两栏需要宽度；窄视口自动收成 `100vw - 24px`
							//   （两栏容器带 `flex-wrap` ⇒ 再窄就落成上下两段，不会溢出 ✓）。
							width: "min(520px, calc(100vw - 24px))", maxWidth: "calc(100vw - 24px)",
							border: "1px solid var(--dsw-alias-border-l1, transparent)",
							// ★★ 2026-10-19（用户报「工作区下拉框弹出 UI 层级错误」）：底色**必须是不透明层**。
							//   `--dsw-alias-bg-layer-*` 是"叠层"语义的主题色，真实主题里**可能是半透明**
							//   （`rgba(...)` 甚至全透明）⇒ 只写 `background: <layer>` 时下面的会话列表会
							//   从面板里透出来，看起来就是"层级错乱 / 两块 UI 叠在一起"✗（与 sticky 组头
							//   那次是同一类病：见 feedback_sticky_overlay_opaque_bg）。
							//   ⇒ 用 `--dsw-alias-bg-base`（页面底色，实心）铺底，layer 色**只当叠加层**✓。
							backgroundColor: "var(--dsw-alias-bg-base, #1e1e1e)",
							backgroundImage: "linear-gradient(var(--dsw-alias-bg-layer-1, transparent), var(--dsw-alias-bg-layer-1, transparent))",
							boxShadow: "0 8px 24px rgba(0,0,0,.35)",
							// ★ 必须把**本 chip 的 rect** 交给 fitMenu：只按"整页 − 72"算 ⇒ 面板下半截
							//   （含「＋ 添加工作区…」）落到视口外，而面板自身又是滚动容器 ⇒ 既看不到也滚不到 ✗
							//   （2026-10-16 用户报障：工作时区一多就点不到下面的按钮）。
						}, shell.fitMenu ? shell.fitMenu(anchorRect(rootRef)) : {}),
					}));
			}

			/**
			 * **hero 那枚（2026-10-16 方案 A）**：我们**不出 chip**，只把合并面板挂到官方浮层槽上 ——
			 * hero 行仍是 `[官方 WorkspaceChip][我们的面板(open 时才出)][我们的 preset chip]` ⇒
			 * 视觉上**只有一枚**工作区入口 ✓（官方那枚改不了，也没必要改：它是唯一可见的触发器 ✓）。
			 *
			 * ⚠ 常驻一个**零尺寸 fixed 壳**并带 `data-vssaros-context-hero`：
			 *   ① 给宿主自证一个"这一屏我们的入口到过"的事实（hero 屏没有我们的 chip，见文件头）；
			 *   ② fixed 空 div 不占流、不影响 hero 布局 ✓。
			 */
			function HeroContextPanel(props) {
				const requested = !!(props && props.open);
				const data = useContextData();
				const anchorRef = props && props.anchorRef;
				const [rect, setRect] = react.useState(null);
				// ── 2026-10-17 真机 bug：「点聊天框输入框会弹出工作区下拉框」──────────────────
				// 官方语义（`dsh-client-ui-conversation/lib/client.js:17593-17603`）：hero 且
				// `chipTitle` 未就绪时输入框是 `inert` 的，**点输入框 = onRequestWorkspace() ⇒
				// setPickerOpen(true)** —— 即"点输入框开选择器"本就是官方入口，不是误触。
				// 我们的面板把官方那个小浮层换成了 540px 主从两栏，一开就压住会话 ⇒ 用户感受是"弹窗乱弹" ✗。
				// 修法（只改表现层，不动官方语义）：**只有从官方 chip 发起的 open 才认**——
				// 记录 pointerdown 落点，open 的上升沿若来自 chip 之外（输入框/任意处）就抑制本次；
				// 面板打开期间点外部 / 按 Esc 也抑制（hero 侧 `onRequestClose` 在官方 props 里**没有对应项**，
				// 调它等于空操作 ⇒ 从前"点了外面关不掉" ✗）。抑制只是本轮不看 `open`，
				// 官方再次点 chip（open 走一次 false→true）后自动恢复 ✓。
				const [suppressed, setSuppressed] = react.useState(false);
				const prevRequested = react.useRef(false);
				react.useEffect(() => {
					if (requested && !prevRequested.current) {
						setSuppressed(!isOpenFromAnchor(anchorRef && anchorRef.current, lastPointerDownTarget));
					}
					if (!requested) { setSuppressed(false); }
					prevRequested.current = requested;
				}, [requested, anchorRef]);
				const open = requested && !suppressed;
				// 打开期间：点外部 / Esc ⇒ 关（见上）。
				react.useEffect(() => {
					if (!open || typeof document === "undefined" || !document.addEventListener) { return undefined; }
					const onDown = (e) => {
						// 面板根由 ContextPanel 打 `data-vssaros-context-panel`（ref 不跨普通函数组件 ✓）
						const panel = document.querySelector("[data-vssaros-context-panel]");
						const anchor = anchorRef && anchorRef.current;
						const t = e && e.target;
						if (panel && t && typeof panel.contains === "function" && panel.contains(t)) { return; }
						if (anchor && t && (anchor === t || (typeof anchor.contains === "function" && anchor.contains(t)))) { return; }
						setSuppressed(true);
					};
					const onKey = (e) => { if (e && (e.key === "Escape" || e.key === "Esc")) { setSuppressed(true); } };
					document.addEventListener("mousedown", onDown, true);
					document.addEventListener("keydown", onKey, true);
					return () => {
						document.removeEventListener("mousedown", onDown, true);
						document.removeEventListener("keydown", onKey, true);
					};
				}, [open, anchorRef]);
				// ★ 2026-10-17 诊断位（hero 那面）：官方给的**选中态**必须记下来 ——
				//   用户报"在聊天框里点了另一个工作区，UI 没反应"时，这一条直接回答关键问题：
				//   **官方 `selectedId` 跟没跟着我们的 `onPick` 走**（没跟 ⇒ 问题在官方槽 / 我们传的 key ✗，
				//   不是"页面没重渲"）✓。真机日志里它出现在 `page surface: {... workspaceUi ...}` 里 ✓。
				noteWorkspaceUi({
					heroMounted: true,
					heroOpen: open,
					heroSelected: (props && props.selectedId) || null,
					heroSessionId: state.sessionId || null,
				});
				// 锚点是**官方 chip 的 DOM**（我们没有自己的容器）⇒ 只能读它的 rect 做 fixed 定位；
				// 读不到（真实环境异常 / 单测无 DOM）⇒ 回落到左上角**照常渲染**（不静默不显示 ✗）。
				react.useEffect(() => {
					if (!open) { return undefined; }
					const read = () => {
						const el = anchorRef && anchorRef.current;
						const r = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
						setRect(r ? { left: r.left, top: r.bottom } : null);
					};
					read();
					if (typeof window !== "undefined" && window.addEventListener) {
						window.addEventListener("resize", read);
						return () => window.removeEventListener("resize", read);
					}
					return undefined;
				}, [open, anchorRef]);
				const left = rect ? Math.round(rect.left) : 12;
				// `rect.top` 存的是**锚点底边**（见上面 `read()`）⇒ 菜单顶边再让开 4px ✓
				const top = rect ? Math.round(rect.top + 4) : 12;
				// ⚠ 锚点矩形同样必须交给 fitMenu（只按整页高算 ⇒ 面板底部落到视口外、滚不到 ✗）。
				// 同时**删掉**从前挂在壳上的 `maxHeight`：壳不是滚动容器 ⇒ 那个上限**一点作用都没有**
				// （子元素照样溢出到视口外，正是用户看到的现象）⇒ 真正的上限交给面板自己（它有 overflowY ✓）。
				const fit = shell.fitMenu ? shell.fitMenu(rect ? { bottom: rect.top } : null) : {};
				const shellStyle = { position: "fixed", left: left, top: top, zIndex: 1000 };
				return react.createElement("div", {
					[HERO_MARK_ATTR]: "1",
					style: shellStyle,
					// ⚠ 面板**常驻挂载**（`open: false` 时由它自己 return null）—— 别写成 `open ? <Panel/> : null`：
					//   那样关闭即卸载 ⇒ 面板内的 `note`（失败原因）/`query` 全丢，"重新点开看原因"就看不到 ✗
					//   （header 那枚是常驻子组件，本来就没这个问题；两处口径必须一致 ✓）。
				}, react.createElement(ContextPanel, {
					open: open, mode: "hero", data: data, sessionId: state.sessionId,
					selectedWorkspaceId: props && props.selectedId,
					getAnchorEl: () => (anchorRef && anchorRef.current) || null,
					// 关闭走官方（`pickerOpen` 由 conversation 包持有 ✓）；`onPick` 也是官方给的 ✓。
					onRequestClose: () => { if (props && typeof props.onClose === "function") { props.onClose(); } },
					onPickWorkspace: (id) => { if (props && typeof props.onPick === "function") { props.onPick(id); } },
					// 尺寸：官方 hero 那枚 chip 在输入框上方居中 ⇒ 面板固定宽（fitMenu 的 maxWidth 是**整页**宽，
					// 直接用会让面板撑满屏 ✗），再夹一次视口底部余量 ✓。
					menuStyle: Object.assign({}, fit, {
						position: "relative", top: 0, left: 0, marginTop: 0,
						// ★ 稿 A（2026-10-17）：主从两栏要宽度；窄视口由 `min()` 兜住，两栏容器带
						//   `flex-wrap` ⇒ 再窄自动落成上下两段（不会横向溢出 ✓）。
						width: "min(540px, calc(100vw - 24px))", minWidth: 300, maxWidth: "min(540px, calc(100vw - 24px))",
						padding: 5, borderRadius: 10,
						border: "1px solid var(--dsw-alias-border-l1, transparent)",
						// 同 header 那枚：layer 色可能是半透明 ⇒ 实心底 + 叠层（见 header 处的长注释）
						backgroundColor: "var(--dsw-alias-bg-base, #1e1e1e)",
						backgroundImage: "linear-gradient(var(--dsw-alias-bg-layer-1, transparent), var(--dsw-alias-bg-layer-1, transparent))",
						boxShadow: "0 8px 24px rgba(0,0,0,.35)",
					}),
				}));
			}

			// ── 注册（**顺序有契约**：header 那枚必须是本 chunk 的**第一条**注册）────────────────
			// 守卫（`check-chat-surface-chunks.mjs`）与 IDE 侧行为网（`dshChatSurfaceHeader/Controls.test.ts`）
			// 都按 `registrations[0]` 取 header 入口 ⇒ 新增的 hero 槽注册必须排在它**后面** ✓。
			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register(
					{ name: SLOT, id: "vssaros-context-entry", order: -27 }, ContextEntry));
				state.contextEntry = true;
				// 旧诊断位（宿主自证快照与老测试读它们）：合并后统一由 `contextEntry` 表达 ✓，
				// 这里保留两个 true 只是"入口已挂载"的兼容写法（不表示仍有两枚 ✓）。
				state.workspaceChip = true;
				state.worktreeChip = true;
			} catch (e) {
				state.error = String((e && e.message) || e);
			}
			// ── hero 的遮蔽注册（方案 A，2026-10-16）──────────────────────────────────────
			// `priority: -10`（负值优先）换掉官方 `WorkspacePickFlow` ⇒ hero 里仍是**官方那枚 chip**，
			// 点开却是我们的面板（工作区 + worktree + 添加工作区）✓。槽是 single ⇒ 同 id 不必写 order ✓。
			try {
				ctx.slots.inject(HERO_SLOT, () => ctx.slots.register(
					{ name: HERO_SLOT, id: "vssaros-context-entry-hero", priority: -10 }, HeroContextPanel));
				state.contextEntryHero = true;
			} catch (e) {
				state.heroEntryError = String((e && e.message) || e);
			}
		}
		exports.install = install;
		// 仅测试用：纯逻辑直接断言（插件装载只读 install，见 dsh client-modules 契约）。
		exports.__test = {
			baseName, workspaceIdOfSession, workspaceLabel, parseWorktrees, samePath, worktreeLabel,
			readPushedWorktrees, searchText, buildTree, WORKTREE_EVENT, HERO_MARK_ATTR,
			// 多根工作区（2026-10-16）：记录解析 + 事件名 —— `buildTree` 的回落契约是这一刀的主要判据 ✓
			parseWorkspaces, readPushedWorkspaces, WORKSPACE_EVENT,
			// 2026-10-17：hero 面板"只认 chip 发起的 open"的来源判定（守卫 ⑤ 钉住）✓
			isOpenFromAnchor,
		};
		return module.exports;
	}
});
