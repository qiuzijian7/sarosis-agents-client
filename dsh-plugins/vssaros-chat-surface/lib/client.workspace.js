// @vssaros/dsh-chat-surface — **工作区 + worktree 合并入口**（header 左侧上下文位，slot=actions）
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
// ── 切换必须经宿主（2026-10-14 修）────────────────────────────────────────────
// 本 chip 原来是页面**自己**调 `ctx.uiWorkspace.openWorkspace(id)` —— 那**正是**协议注释里
// `switchWorktree` 明写"不能这么干"的那条 ✗：本视图绑的会话是**宿主持有的事实**
// （`dshViewHost` 的 slot.sessionId，rename 推送 / preset 映射都依赖它），页面私自切只会换掉页面
// 的选择（dsh 的 `openWorkspace` 还会连带换选中的会话），而宿主仍指着旧会话 ⇒ 两边分叉 ✗。
// 现在与 worktree 下拉**共用一条命令** `bridge.switchWorktree(path)`：工作区切换在宿主侧就是
// "换目录 ⇒ 新会话（preset 沿用、每目录一段历史、切回来幂等接管）"，而 `_doSwitchWorktree` 对
// **任意**"非本窗口主工作区"的目录都成立（`_isWorktreeDir` 只判这一件事 ✓）⇒ 不必新增命令、
// 也不必动协议版本 ✓（新增一条同义命令只会多出一个会各自漂移的入口 ✗）。
// ⚠ 旧宿主（桥里没有 `switchWorktree`）**如实拒绝**，**不**回落到"只切页面选择" —— 那等于明知
//   会分叉还照做 ✗。
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
		 * "本入口组件已就绪"（`client.preset.js` 里的同名常量必须一致 ✓）。
		 * 用途：hero 区那枚只能挂在 `conversation.hero.agentPreset`（我们已接管的那枚）**内部**，
		 * 组件本体由本文件提供 ⇒ 两个 chunk 并行装载，谁先到都靠这个事件补一次渲染 ✓。
		 */
		const WORKTREE_CHIP_EVENT = "vssaros-dsh-worktreechip";

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
		 * 纯逻辑：把两组数据 + 查询串收敛成面板要渲染的行（模块作用域 ⇒ `__test` 可直接断言 ✓）。
		 *
		 * 为什么必须是纯函数：合并入口最容易出的错都在这一层（分组错、过滤错、"空"与"没有"混淆 ✗），
		 * 而它们**不需要 React** 就能钉住 ✓（仓里既有口径：判据/纯逻辑用夹具测，装配才交给真装载 ✓）。
		 * ⚠ `null`（服务未就绪 / 推送没到）与 `[]`（确实没有）必须区分开：本函数只按**拿到的数据**出行 ✓，
		 *   "两组都空 ⇒ 不渲染入口"由调用方判（`items.length === 0 && list.length === 0` ✓）。
		 */
		function buildRows(options) {
			const items = (options && options.workspaces) || [];
			const list = (options && options.worktrees) || [];
			const q = options && typeof options.query === "string" ? options.query.trim().toLowerCase() : "";
			const hit = (parts) => !q || searchText(parts).indexOf(q) >= 0;
			const rows = [];
			for (const w of items) {
				const label = workspaceLabel(w);
				rows.push({
					kind: "workspace",
					key: (w && w.workspaceId) || "",
					path: (w && w.path) || null,
					label: label || (w && w.workspaceId) || "工作区",
					branch: null,
					matched: hit([label, w && w.path, w && w.workspaceId]),
				});
			}
			for (const t of list) {
				const label = worktreeLabel(t);
				rows.push({
					kind: "worktree",
					key: (t && t.path) || "",
					path: (t && t.path) || null,
					label: label || (t && t.path) || "worktree",
					branch: (t && t.branch) || null,
					matched: hit([label, t && t.path, t && t.branch]),
				});
			}
			return rows;
		}

		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			// 槽位（2026-10-11 方案 B 定稿）：`actions` 是**左侧**那一簇（titleCluster 内），`utilities` 才是右侧。
			// 头部布局 = 上下文在左 / 动作在右 ⇒ 本入口（上下文）占 actions。
			const SLOT = "conversation.session.header.actions";
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

			/** 纯逻辑（模块作用域，见上方 `buildRows`）：本处只调用，不重复定义 ✓。 */

			/**
			 * **合并入口**（方案 C）：一枚 chip + 一个"扁平可搜索列表"面板。
			 *
			 * 与前两枚（🗂 工作区 / 🌿 worktree）的差别只有两个：入口合成了一个 ✓、面板多了一个搜索框 ✓；
			 * **判据、语义、命令一律照旧**（见文件头）⇒ 两条数据源各自"空则不显示假名字" ✓，
			 * 但"两组长都空才整体不渲染" ✓（等价合并前两枚各自 `return null` 的效果 ✓）。
			 */
			function ContextEntry(props) {
				const sid = (props && props.sessionId) || state.sessionId;
				const [snapshot, setSnapshot] = react.useState(readSnapshot);
				const [pushed, setPushed] = react.useState(readPushedWorktrees);
				const [tick, setTick] = react.useState(0);
				const [open, setOpen] = react.useState(false);
				const [query, setQuery] = react.useState("");
				const [note, setNote] = react.useState(null);
				const rootRef = react.useRef(null);
				// 与官方同一订阅源（`dsh-client-ui-workspace` 也是 `workspaces.list.subscribe`）：
				// 会话换绑/新建工作区后 chip 跟随更新，不需要轮询。
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
				// 宿主推送（新建/删除/prune/切分支都会重推）⇒ 刷新列表。无 DOM（单测）时跳过，不炸。
				react.useEffect(() => {
					if (typeof document === "undefined") { return undefined; }
					const onPush = () => setPushed(readPushedWorktrees());
					document.addEventListener(WORKTREE_EVENT, onPush);
					return () => document.removeEventListener(WORKTREE_EVENT, onPush);
				}, []);
				// 会话快照订阅：换绑后重渲染（"当前目录"变了，当前项要跟着动 ✓）。用 tick 而不是改 pushed
				// —— 从前那版调 `setList(readPushedWorktrees())` 只是借"新数组"骗一次重渲染 ✗（语义含糊）。
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
				react.useEffect(() => {
					if (!open) { return undefined; }
					const close = (ev) => {
						if (rootRef.current && ev.target && rootRef.current.contains(ev.target)) { return; }
						setOpen(false);
					};
					const esc = (ev) => { if (ev.key === "Escape") { setOpen(false); } };
					document.addEventListener("mousedown", close, true);
					document.addEventListener("keydown", esc, true);
					return () => {
						document.removeEventListener("mousedown", close, true);
						document.removeEventListener("keydown", esc, true);
					};
				}, [open]);
				// 菜单互斥：打开本菜单前关掉别的（多个菜单叠着时，被视图裁掉的部分同样像"被遮挡"）。
				react.useEffect(() => {
					if (!open || !shell.menus) { return; }
					shell.menus.closeOthers(MENU_ID);
					return shell.menus.register(MENU_ID, () => setOpen(false));
				}, [open]);

				const items = (snapshot && snapshot.items) || [];
				const worktrees = pushed;
				if (items.length === 0 && worktrees.length === 0) {
					// 两组长都空（服务未就绪 / 推送没到 / 本仓没有 worktree）⇒ 不出入口，不显示假名字 ✓
					return null;
				}
				const currentId = workspaceIdOfSession(snapshot, sid);
				const dir = readCurrentDir(sid);
				const currentWs = items.filter((w) => w && w.workspaceId === currentId)[0] || null;
				const currentWt = worktrees.filter((w) => samePath(w && w.path, dir))[0] || null;
				const label = workspaceLabel(currentWs) || worktreeLabel(currentWt) || "工作区";
				const rows = buildRows({ workspaces: items, worktrees: worktrees, query: query });
				const shown = rows.filter((r) => r.matched);
				const total = rows.length;
				// 搜索框只在条目偏多时出现（少时它是噪声 ✗；mockup ③ 的口径 = >6 ✓）。
				const withSearch = total > 6;
				/**
				 * 切到某个目录。两类条目共用：宿主侧就是 `session.start({cwd})` 拿/建该目录的专属会话
				 * 并 rebind 回本视图 ⇒ 页面随后按 rebind 的会话重新渲染 ✓（两边不分叉 ✓）。
				 */
				const switchTo = (row) => {
					setOpen(false);
					setNote(null);
					const path = row && row.path;
					if (!path) {
						// 没有目录就无从 `session.start`（宿主那边 cwd 是必需的）⇒ 说清，不做半截事 ✗
						setNote("这个条目读不到目录（path 为空）⇒ 切不过去");
						return;
					}
					// "当前项"的两条判据**不能混用**（合并入口最容易在这里出错 ✗）：
					//   · 工作区行 = 会话归属（`workspaceIdOfSession`）⇒ 按 **workspaceId** 判 ✓
					//   · worktree 行 = 会话 cwd ⇒ 按 **path** 的 `samePath` 判 ✓
					// 混用会怎样：读不到会话 cwd 时（`dir == null`）把"当前工作区"也当成要切的门标 ⇒
					// 白跑一次 `session.start` ✗（守卫「点当前工作区 ⇒ 无动作」当场抓到过 ✓）。
					const isCurrentRow = row.kind === "workspace"
						? (row.key && row.key === currentId) === true
						: samePath(path, dir);
					if (isCurrentRow) { return; }   // 已经在这里 ⇒ 什么也不做（幂等 ✓）
					if (!bridge || typeof bridge.switchWorktree !== "function") {
						setNote("页面桥过旧：不支持切换工作区 / worktree（不会退化成只切页面选择 —— 那会让两边会话不一致）");
						return;
					}
					try {
						Promise.resolve(bridge.switchWorktree(path)).then(
							() => { state.contextSwitches = (state.contextSwitches || 0) + 1; },
							(e) => { setNote(String((e && e.message) || e)); });
					} catch (e) { setNote(String((e && e.message) || e)); }
				};
				const children = [
					react.createElement("button", {
						key: "chip", type: "button", "data-vssaros-context-chip": "1",
						"aria-haspopup": "menu", "aria-expanded": open,
						// ⚠ 如实写明代价：切换 = 宿主在目标目录 `session.start` 一个会话（历史独立、
						//   preset 沿用）—— 不写就是让用户以为"只是换个视角" ✗（tooltip 带完整路径 ✓）。
						title: [currentWt && currentWt.path ? currentWt.path : (currentWs && currentWs.path ? currentWs.path : ""),
							"切换工作区 / worktree（会新建会话，历史独立；agent/preset 沿用）"].filter(Boolean).join("\n"),
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
						" ▾"),
				];
				if (open) {
					const HEADING = { fontSize: 10.5, letterSpacing: ".03em", color: "var(--dsw-alias-label-secondary, currentColor)", padding: "6px 8px 3px" };
					const SUB = { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 };
					const pane = [];
					if (withSearch) {
						pane.push(react.createElement("div", { key: "s", style: { padding: "3px 5px 5px" } },
							react.createElement("input", {
								type: "search", "data-vssaros-context-search": "1", "aria-label": "搜索工作区或 worktree",
								value: query, placeholder: "搜索工作区 / worktree（名称、路径、分支）",
								onChange: (ev) => setQuery(String((ev.target && ev.target.value) || "")),
								style: {
									width: "100%", boxSizing: "border-box", fontSize: 11.5, padding: "4px 7px", borderRadius: 6,
									border: "1px solid var(--dsw-alias-border-l1, transparent)",
									background: "var(--dsw-alias-bg-layer-2, transparent)",
									color: "var(--dsw-alias-label-primary, currentColor)",
								},
							})));
					}
					// 分组：工作区（dsh 快照）/ worktree（宿主推送）——两组各自带计数，一眼看清"哪一层有几项" ✓
					const groups = [
						{ kind: "workspace", title: "工作区", total: items.length },
						{ kind: "worktree", title: "worktree", total: worktrees.length },
					];
					for (const g of groups) {
						if (g.total === 0) { continue; }   // 这一组本来就没数据 ⇒ 连标题都不出 ✓
						pane.push(react.createElement("div", { key: "h-" + g.kind, style: HEADING },
							g.title + "（" + g.total + "）"));
						const mine = shown.filter((r) => r.kind === g.kind);
						if (mine.length === 0) {
							pane.push(react.createElement("div", {
								key: "e-" + g.kind,
								style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "4px 8px 6px" },
							}, "没有匹配的" + g.title));
							continue;
						}
						for (const r of mine) {
							const isCurrent = r.kind === "workspace" ? (r.key === currentId) : samePath(r.path, dir);
							pane.push(react.createElement("button", {
								key: r.kind + ":" + r.key,
								type: "button", role: "menuitem",
								"data-vssaros-context-item": r.kind + ":" + r.key,
								disabled: isCurrent && r.kind === "worktree",
								onClick: () => switchTo(r),
								style: {
									display: "flex", alignItems: "flex-start", gap: 8, width: "100%", padding: "6px 8px",
									border: "none", borderRadius: 7, textAlign: "left",
									cursor: isCurrent && r.kind === "worktree" ? "default" : "pointer",
									background: isCurrent ? "var(--dsw-alias-bg-layer-2, transparent)" : "transparent",
									color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 12,
								},
							},
								react.createElement("span", {
									style: { flex: "0 0 14px", width: 14, color: isCurrent ? "var(--dsw-alias-brand-primary, currentColor)" : "transparent" },
								}, "✓"),
								react.createElement("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
									react.createElement("span", { style: { fontWeight: isCurrent ? 600 : 400 } },
										String(r.label),
										r.branch ? react.createElement("span", {
											style: { marginLeft: 6, fontSize: 10.5, color: "var(--dsw-alias-label-secondary, currentColor)" },
										}, String(r.branch)) : null),
									r.path ? react.createElement("span", { style: SUB }, String(r.path)) : null)));
						}
					}
					// ★ 语义必须写在脸上：dsh 的会话 cwd 在 session.start 时定死 ⇒ 换目录只能新开会话。
					pane.push(react.createElement("div", {
						key: "note-sem",
						style: { fontSize: 10.5, lineHeight: 1.5, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "5px 8px 6px", borderTop: "1px solid var(--dsw-alias-border-l1, transparent)", marginTop: 4 },
					}, "切换工作区 / worktree = 新建会话（历史独立；当前 preset 保留，但在新会话里重新装配）"));
					if (note) {
						pane.push(react.createElement("div", {
							key: "err", style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "2px 8px 6px" },
						}, note));
					}
					children.push(react.createElement("div", {
						key: "m", role: "menu",
						style: Object.assign({
							// 锚点方向：本簇在 header **左侧** ⇒ 菜单必须**向右**展开。
							// 写 `right: 0` 会让菜单向左越过视图左边缘，被左侧栏盖住一半（2026-10-11 实测截图为证 ✗）。
							position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 1000,
							padding: 5, borderRadius: 10,
							// 条目多时不许无限长（真实实现由 fitMenu 夹进视口 ✓；这里再给一条内部滚动兜底 ✓）
							maxHeight: 360, overflowY: "auto", minWidth: 300,
							border: "1px solid var(--dsw-alias-border-l1, transparent)",
							background: "var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))",
							boxShadow: "0 8px 24px rgba(0,0,0,.35)",
						}, shell.fitMenu ? shell.fitMenu() : {}),
					}, ...pane));
				}
				return react.createElement("span", { ref: rootRef, style: { position: "relative", display: "inline-flex" } }, ...children);
			}
			// ── 把组件交给 hero 那枚（`client.preset.js`）───────────────────────────────
			// hero 区要"工作区右侧出现 worktree"，而 `conversation.hero.workspace` 是 **single** 槽
			// （官方工作区选择器独占 ⇒ 加不了兄弟 ✗），唯一落点是紧邻其右、**已被我们接管**的
			// `conversation.hero.agentPreset` 槽内部 ⇒ 组件本体从这里传过去，不复制第二份实现 ✓
			// （切的语义/校验全在宿主一处，UI 也只该一份 ✓）。
			// ⚠ 变量名沿用 `heroWorktreeChip`（`client.preset.js` 读的就是它 ⇒ 那边**不用改** ✓）；
			//   它现在指的已是**合并入口**（在 hero 里同样能切工作区，正是"一个入口"的本意 ✓）。
			// 并行装载 ⇒ 先挂载的那枚要能"后到"，故再派一个 DOM 事件让已挂载实例重渲染一次 ✓。
			shell.heroWorktreeChip = ContextEntry;
			try {
				if (typeof document !== "undefined" && typeof document.dispatchEvent === "function" && typeof Event === "function") {
					document.dispatchEvent(new Event(WORKTREE_CHIP_EVENT));
				}
			} catch { /* 没有 DOM（单测）就当没人听 ✓ */ }
			// ── 本簇（actions）的**顺序契约**（2026-10-12/2026-10-15）────────────────────
			// list 槽按 `priority` 升序、再按 `order` 升序渲染，**升序 = 从左到右** ✓。
			// 官方 preset 标签（`agent-preset`）注册在 `order: -10`，而它的 order **我们改不了**
			// —— 同 id 改 order 就是接管/遮蔽，官方组件连同它的 hover 提示会一起消失 ✗（2026-10-12 刚把渲染交回官方）。
			// ⇒ 只能让自己排到它**左边**。合并前是 -30（工作区）/ -20（worktree）两枚，而 -30 与官方
			// `subagent-catalog`（官方子代理目录，也是 -30）**真 tie** ✗（守卫 KNOWN_TIES 里登记过）。
			// 合并后只剩一枚 ⇒ 取 **-27**（官方 -30 与**我们的**子代理入口 -25 之间）⇒ **顺手消掉那条历史 tie** ✓
			// ⚠ 别取 -25：那正是 `vssaros-subagents` 的 order ⇒ 真 tie（守卫当场抓到过 ✗）。
			// （守卫的 KNOWN_TIES / OUR_BASELINE 已同步 ✓）。
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
		}
		exports.install = install;
		// 仅测试用：纯逻辑直接断言（插件装载只读 install，见 dsh client-modules 契约）。
		exports.__test = {
			baseName, workspaceIdOfSession, workspaceLabel, parseWorktrees, samePath, worktreeLabel,
			readPushedWorktrees, searchText, buildRows, WORKTREE_EVENT,
		};
		return module.exports;
	}
});
