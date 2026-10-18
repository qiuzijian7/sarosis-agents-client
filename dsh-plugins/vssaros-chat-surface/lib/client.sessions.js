// @vssaros/dsh-chat-surface — header 右侧「新建会话 + 历史会话」（conversation.session.header.utilities）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.sessions.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
//
// ── 为什么补这两个入口（2026-10-11，UI 对比评审结论 ②）────────────────────────
// VsSaros 原生聊天面板 header 有「新建会话 / 聊天历史」图标（`agentChatPanel.header.ts:284-326`），
// 而 dsh chat-surface 这边：官方会话列表 + 设置都在**被 chat-only CSS 隐藏的左栏**里
// （`dshPageBridgeProtocol.ts` 的 DSH_CHAT_ONLY_CSS），面板内只剩我们自绘的 ⚙ 菜单 —— 入口深一层。
// 这里把两件事提到 header 右侧，与 ⚙ 并列。
//
// ── 两条通路都必须经宿主（不能页面侧自己切）──────────────────────────────────
// 本视图绑定的会话 id 是**宿主持有的事实**（`dshViewHost` 的 slot.sessionId，rename 推送与 preset
// 映射都依赖它）。页面侧私自 `uiWorkspace.openSession/startSession` 会让两边分叉，所以：
//   · 历史会话：页面只上报要切的 id（`bridge.openSession`）→ 宿主走**既有 rebind 通路**下发
//     → 页面沿用 `vssaros-dsh-rebind` 处理（对齐工作区 + openSession），与 preset 切换完全同源；
//   · 新建会话：VsSaros 语义是"新开一个对话页签"（原生 `_onNewSession` 同义）⇒ 请宿主执行官方命令
//     `agentStudio.newChatInEditor`（`bridge.newChat`）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.sessions.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const HISTORY_LIMIT = 20;

		/**
		 * 会话列表 → 菜单行（最多 `limit` 条）。
		 *
		 * 排序：有 `updatedAt/createdAt` 就按时间倒序（时间相同按 id 稳定），**全都没有时间戳**时保留
		 * 快照自身的键序（不强加一个假的顺序）。
		 * 标题回落口径与 `client.sessionLabel.js` 一致：`title` → （无）→ 由调用方显示 id 片段。
		 */
		function sessionRows(snapshot, currentSessionId, limit) {
			const byId = (snapshot && snapshot.byId) || {};
			const archived = Array.isArray(snapshot && snapshot.archivedSessionIds) ? snapshot.archivedSessionIds : [];
			const rows = [];
			for (const id of Object.keys(byId)) {
				const s = byId[id] || {};
				const projection = s.projectionValues || {};
				rows.push({
					id,
					title: typeof s.title === "string" && s.title.trim() ? s.title.trim() : null,
					preset: typeof projection.agentPreset === "string" ? projection.agentPreset : null,
					at: (typeof s.updatedAt === "number" && s.updatedAt) || (typeof s.createdAt === "number" && s.createdAt) || 0,
					archived: archived.indexOf(id) >= 0,
					isCurrent: id === currentSessionId,
				});
			}
			if (rows.some((r) => r.at > 0)) {
				rows.sort((a, b) => (b.at - a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			}
			return rows.slice(0, typeof limit === "number" ? limit : HISTORY_LIMIT);
		}
		/**
		 * 会话所属工作区 id（与 `client.workspace.js` 同判据；两个 chunk 并行装载，故各自持一份小实现）。
		 * 这里只用于"新建会话落在当前工作区"这一件事。
		 */
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

		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			// 槽位（2026-10-11 方案 B 定稿）：右侧 utilities —— 与 ⚙ 同组，目标 `[＋][🕘][⚙]`。
			const SLOT = "conversation.session.header.utilities";
			/** 菜单互斥用 id（见 client.js 的 createMenuCoordinator）。 */
			const MENU_ID = "vssaros-sessions";
			const readSessions = () => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					return list ? list.getSnapshot() : null;
				} catch (e) {
					state.sessionListError = String((e && e.message) || e);
					return null;
				}
			};
			function SessionsChip(props) {
				const sid = (props && props.sessionId) || state.sessionId;
				const [open, setOpen] = react.useState(false);
				const [note, setNote] = react.useState(null);
				const [rows, setRows] = react.useState([]);
				const rootRef = react.useRef(null);
				react.useEffect(() => {
					if (!open) { return; }
					setRows(sessionRows(readSessions(), sid, HISTORY_LIMIT));
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
				}, [open, sid]);
				// 菜单互斥（同 client.workspace.js：多菜单叠加时被裁的部分也像"被遮挡"）。
				react.useEffect(() => {
					if (!open || !shell.menus) { return; }
					shell.menus.closeOthers(MENU_ID);
					return shell.menus.register(MENU_ID, () => setOpen(false));
				}, [open]);
				const BTN = {
					display: "inline-flex", alignItems: "center", gap: 4,
					padding: "1px 8px", borderRadius: 999, cursor: "pointer",
					border: "1px solid var(--dsw-alias-border-l1, transparent)",
					background: "var(--dsw-alias-bg-layer-1, transparent)",
					color: "var(--dsw-alias-label-secondary, currentColor)",
					fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
				};
				/**
				 * 「＋ 新建会话」= **本页签内**再来一段新对话（2026-10-12 用户要求）。
				 *
				 * 语义修订史（别再来回改，先读这段）：原先这里是"新开一个对话页签"
				 * （`bridge.newChat` → 官方 `agentStudio.newChatInEditor`），但用户的口径是
				 * **页签内的 ＋ 就该在本页签里继续**（新开 group 页签是**顶部**那个 ＋ 的事）
				 * ⇒ 改调 `bridge.newSession`：宿主派生 `--new-<nonce>` 的新会话 id → `session.start`
				 * → rebind 回本视图（历史独立，preset/cwd 沿用）。
				 * 宿主较旧（无该方法）时**回落**到原来的"新开页签"，并如实说明为什么不一致 ✓。
				 */
				const newSession = () => {
					if (!bridge) { setNote("页面桥不可用"); return; }
					const call = typeof bridge.newSession === "function"
						? () => bridge.newSession()
						: (typeof bridge.newChat === "function"
							? () => bridge.newChat()          // 回落：旧宿主只有"新开页签"
							: null);
					if (!call) { setNote("页面桥过旧（newSession / newChat 都不可用）"); return; }
					const fellBack = typeof bridge.newSession !== "function";
					try {
						Promise.resolve(call()).then(
							() => {
								state.newSessions = (state.newSessions || 0) + 1;
								if (fellBack) { setNote("宿主较旧：这次是新开了页签（升级后会改为本页签内新建）"); }
							},
							(e) => { setNote(String((e && e.message) || e)); });
					} catch (e) {
						setNote(String((e && e.message) || e));
					}
				};
				const openSession = (row) => {
					setOpen(false);
					if (!row || row.isCurrent) { return; }
					if (!bridge || typeof bridge.openSession !== "function") {
						setNote("页面桥过旧（openSession 不可用）");
						return;
					}
					try {
						// 宿主据此 rebind（工作区对齐 + 打开会话都由页面侧 rebind 处理复用原有逻辑）。
						Promise.resolve(bridge.openSession(row.id, row.preset || undefined)).then(
							() => { state.sessionOpens = (state.sessionOpens || 0) + 1; },
							(e) => { setNote(String((e && e.message) || e)); });
					} catch (e) {
						setNote(String((e && e.message) || e));
					}
				};
				const children = [
					react.createElement("button", {
						// 两个标记并存：`new-chat` 是老标记（自动化/测试可能在用），`new-session` 是新语义 ✓
						key: "new", type: "button",
						"data-vssaros-new-chat": "1", "data-vssaros-new-session": "1",
						title: "新建会话（本页签内，历史独立；新开页签请用顶部 ＋）",
						onClick: newSession, style: BTN,
					}, "＋"),
					react.createElement("button", {
						key: "hist", type: "button", "data-vssaros-history-chip": "1",
						"aria-haspopup": "menu", "aria-expanded": open,
						title: "历史会话（本机 dsh 会话）",
						onClick: () => setOpen(!open), style: BTN,
					}, "🕘 ▾"),
				];
				if (open) {
					const HEADING = { fontSize: 10.5, letterSpacing: ".03em", color: "var(--dsw-alias-label-secondary, currentColor)", padding: "6px 8px 3px" };
					const menuRows = [react.createElement("div", { key: "h", style: HEADING }, "历史会话")];
					if (rows.length === 0) {
						menuRows.push(react.createElement("div", {
							key: "empty", style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "2px 8px 6px" },
						}, "读不到会话列表（快照未就绪）"));
					}
					for (const r of rows) {
						menuRows.push(react.createElement("button", {
							key: r.id, type: "button", role: "menuitem", "data-vssaros-session-item": r.id,
							onClick: () => openSession(r),
							style: {
								display: "flex", alignItems: "flex-start", gap: 8, width: "100%", padding: "6px 8px",
								border: "none", borderRadius: 7, cursor: "pointer", textAlign: "left",
								background: r.isCurrent ? "var(--dsw-alias-bg-layer-2, transparent)" : "transparent",
								color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 12,
							},
						},
							react.createElement("span", {
								style: { flex: "0 0 14px", width: 14, color: r.isCurrent ? "var(--dsw-alias-brand-primary, currentColor)" : "transparent" },
							}, "✓"),
							react.createElement("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
								react.createElement("span", {
									style: { fontWeight: r.isCurrent ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 },
								}, r.title || r.id),
								react.createElement("span", {
									style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)" },
								}, [r.preset, r.archived ? "已归档" : null, r.isCurrent ? "当前" : null].filter(Boolean).join(" · ") || r.id))));
					}
					if (note) {
						menuRows.push(react.createElement("div", {
							key: "note", style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "2px 8px 6px" },
						}, note));
					}
					children.push(react.createElement("div", {
						key: "m", role: "menu",
						// 尺寸夹在页面视口内（超出 WebContentsView 矩形会被裁掉 ⇒ 露出后面的编辑器）。
						// ⚠ 还要把**触发器矩形**交给 fitMenu：只按"整页 − 72"算 ⇒ 面板底部落到视口外、
						//   下半截（含底部动作行）**既看不到也滚不到** ✗（2026-10-16 用户报障，见 client.js 的注释）。
						style: Object.assign({
							position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 1000,
							padding: 5, borderRadius: 10,
							border: "1px solid var(--dsw-alias-border-l1, transparent)",
							background: "var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))",
							boxShadow: "0 8px 24px rgba(0,0,0,.35)",
						}, shell.fitMenu ? shell.fitMenu(rootRef.current ? rootRef.current.getBoundingClientRect() : null) : {}),
					}, ...menuRows));
				}
				return react.createElement("span", { ref: rootRef, style: { position: "relative", display: "inline-flex", gap: 6 } }, ...children);
			}
			try {
				// order **-3**（与 ⚙ 的 -2 同组，目标 `[＋][🕘][⚙]`）：官方 `session-log-download`
				// （会话日志导出，那枚 `…`）注册时**没传 order** ⇒ 默认 0 ⇒ 我们取负值才会排在它左边，
				// 让它落到右侧最外（用户要求"三个点的按钮移到最右侧"）。官方 order 见
				// `dsh-session-log-export/lib/client.js:291`；同槽另有 `open-in-app`(-10，我们已遮蔽)、
				// `schedule-catalog`(-5，日程，未启用时不出现)。
				ctx.slots.inject(SLOT, () => ctx.slots.register(
					{ name: SLOT, id: "vssaros-sessions", order: -3 }, SessionsChip));
				state.sessionsChip = true;
			} catch (e) {
				state.error = String((e && e.message) || e);
			}
		}
		exports.install = install;
		// 仅测试用：纯逻辑直接断言（插件装载只读 install，见 dsh client-modules 契约）。
		exports.__test = { sessionRows, workspaceIdOfSession, HISTORY_LIMIT };
		return module.exports;
	}
});
