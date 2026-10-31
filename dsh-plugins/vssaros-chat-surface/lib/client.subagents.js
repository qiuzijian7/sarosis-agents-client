// @vssaros/dsh-chat-surface — 头部「子智能体」入口（slot: conversation.session.header.actions，
// id `vssaros-subagents`，order -25）
// package-local chunk（契约同 client.sessions.js）：主包用 require.async 取回 install()。
//
// ── 为什么加这一枚（2026-10-14 用户要求；调研见 doc/subagent-todo-solution-plan.md §5 P0-2）──
// 官方那枚下拉（`dsh-client-ui-subagent:968-974`，id `subagent-catalog`、order -30）**保持原样** ✓ ——
// 它的"行点击 = 切会话"在我们的形态下**是好用的** ✓。问题只在它的**行内第二个动作**：
// "在右侧栏打开子会话聊天"（`ctx.sidebarRight.openResource`，`:953-958`），而 chat-only 形态把右栏整个
// 隐藏了（`dshPageBridgeProtocol.ts` 的 DSH_CHAT_ONLY_CSS）⇒ 用户点了**没有任何反应** ✗。
// 本 chunk 不重做那份目录，只补一个**落点正确**的入口：把子会话切到**本聊天框**里。
//
// ── 两条硬约束 ────────────────────────────────────────────────────────────
// ① **切会话必须经宿主**：`bridge.openSession(childId)`。页面侧**禁止**自己调
//    `ctx.uiWorkspace.openSession` —— 本视图绑定的会话 id 是**宿主持有的事实**（rename 推送、
//    preset 映射都依赖它），页面侧私切会让两边分叉（见 client.sessions.js:11-17 的既有约定 ✓）。
//    宿主较旧（无该方法）⇒ 用 `bridge.notify` **明确说出来** ✓，不许点了没反应 ✗。
// ② **数据只读自官方投影**：`props.useSessions(s => s.projectionsBySession)` 与
//    `props.useSessionStatus`（都是槽作用域标准 props，**不是** require 得到的模块 ✗）。
//    字段以 owner 的 schema 为准：`subagentCatalog` 元素 = `{id, createdAt, mode, label?}`
//    （`dsh-subagent/lib/types/projection-types.d.ts:8-11,67`）；**`running` 不在投影里**，
//    只能从状态通道取（官方 subagent `client.js:362` 同款：`statuses.get(id)?.running ?? summaries[id]?.running`）。
//    每条子会话的**耗时**在它自己的 `subagentTiming` 投影里（同上投影族 ✓）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.subagents.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "conversation.session.header.actions";
		const ENTRY_ID = "vssaros-subagents";
		/**
		 * 同一槽里已有的占位（别撞）：
		 *   官方 `subagent-catalog` = **-30**、`job-list` = **20**；
		 *   我们自己 `vssaros-workspace-chip` = **-30**（⚠ 已与官方 tie）、`vssaros-worktree-chip` = -20、
		 *   兜底的 `agent-preset` = -10 ⇒ 取空档 **-25**：紧跟官方子代理目录之后 ✓
		 */
		const ENTRY_ORDER = -25;
		const MENU_ID = "vssaros-subagents";

		/** 极简时长文案（没有 timing 就返回 null ⇒ 调用方不显示这一段 ✓，不要编造 0 秒 ✗）。 */
		function durationLabel(timing) {
			if (!timing || typeof timing !== "object") { return null; }
			let ms = typeof timing.settledMs === "number" ? timing.settledMs : null;
			const active = timing.active;
			if (ms === null && active && typeof active.since === "number") {
				ms = Date.now() - active.since;   // 运行中：从现在往回算（与官方"活动时长"同口径 ✓）
			}
			if (ms === null || !isFinite(ms) || ms < 0) { return null; }
			const s = Math.round(ms / 1000);
			if (s < 60) { return s + " 秒"; }
			const m = Math.floor(s / 60);
			return m + " 分 " + String(s % 60).padStart(2, "0") + " 秒";
		}

		const CSS = {
			chip: {
				display: "inline-flex", alignItems: "center", gap: 4,
				padding: "1px 8px", borderRadius: 999, cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l1, transparent)",
				background: "var(--dsw-alias-bg-layer-1, transparent)",
				color: "var(--dsw-alias-label-secondary, currentColor)",
				fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
			},
			dot: { width: 6, height: 6, borderRadius: "50%", background: "var(--dsw-alias-brand-primary, #3b82f6)" },
			dotIdle: { width: 6, height: 6, borderRadius: "50%", background: "rgba(255,255,255,.35)" },
			caret: { fontSize: 9, opacity: 0.7 },
			pop: {
				position: "absolute", zIndex: 40, top: 26, left: 0, minWidth: 300, maxWidth: 380,
				padding: 6, borderRadius: 6, background: "#1c1c1c",
				border: "1px solid var(--dsw-alias-border-l2, #3c3c3c)",
				boxShadow: "0 8px 24px rgba(0,0,0,.5)",
			},
			popTitle: { margin: "4px 6px 6px", fontSize: 11, opacity: 0.7 },
			row: { display: "flex", alignItems: "center", gap: 7, padding: "5px 6px", borderRadius: 4, cursor: "pointer" },
			main: { flex: "1 1 auto", minWidth: 0 },
			name: { fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			meta: { fontSize: 10, opacity: 0.65, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			pill: { fontSize: 9.5, padding: "0 6px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #3c3c3c)", opacity: 0.8, flex: "0 0 auto" },
			note: { padding: "6px 6px 2px", fontSize: 10.5, opacity: 0.6, lineHeight: 1.5 },
		};

		/**
		 * 头部入口：`● N 个子智能体` + 弹出层（每行 = 一个子会话）。
		 *
		 * 没有子智能体时**返回 null**（不占位置、不显示 `0` ✓ —— 头部空间宝贵，且 `0` 是噪音 ✗）。
		 */
		function SubagentsEntry(props) {
			const state = props && props.__vssarosState;
			const bridge = props && props.__vssarosBridge;
			const useSessions = props && props.useSessions;
			const useSessionStatus = props && props.useSessionStatus;
			const shellMenus = props && props.__vssarosMenus;
			const sid = (props && props.sessionId) || (state && state.sessionId) || null;
			const [open, setOpen] = react.useState(false);
			const rootRef = react.useRef(null);
			// 全局订阅：projectionsBySession 与 byId 都在同一份 list 快照里 ⇒ 一个 hook 就够 ✓
			let snap = null;
			try {
				snap = typeof useSessions === "function" ? useSessions((s) => s) : null;
			} catch (e) {
				if (state) { state.subagentsReadError = String((e && e.message) || e); }
			}
			let statuses = null;
			try {
				statuses = typeof useSessionStatus === "function" ? useSessionStatus((v) => v) : null;
			} catch { /* 状态通道拿不到就按"未知"渲染，不编造 running ✗ */ }
			let entries = [];
			try {
				if (snap && sid) {
					const proj = (snap.projectionsBySession && snap.projectionsBySession[sid]) || null;
					const values = (proj && proj.values) || null;
					const catalog = values && values.subagentCatalog;
					if (Array.isArray(catalog)) { entries = catalog; }
				}
			} catch { entries = []; }
			react.useEffect(() => {
				if (!open) { return; }
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
			// 菜单互斥（同 client.sessions.js:108-113：多菜单叠加时被裁的部分也像"被遮挡"）
			react.useEffect(() => {
				if (!open || !shellMenus) { return; }
				shellMenus.closeOthers(MENU_ID);
				return shellMenus.register(MENU_ID, () => setOpen(false));
			}, [open]);
			react.useEffect(() => {
				if (state) { state.subagentsEntries = entries.length; }
			}, [entries.length]);
			if (!entries.length) { return null; }

			const isRunning = (id) => {
				try {
					const v = statuses && typeof statuses.get === "function" ? statuses.get(id) : null;
					if (v && typeof v.running === "boolean") { return v.running; }
					const sum = snap && snap.byId && snap.byId[id];
					return !!(sum && sum.running === true);
				} catch { return false; }
			};
			const timingOf = (id) => {
				try {
					const proj = snap && snap.projectionsBySession && snap.projectionsBySession[id];
					return (proj && proj.values && proj.values.subagentTiming) || null;
				} catch { return null; }
			};
			const runningCount = entries.filter((e) => isRunning(e && e.id)).length;

			/**
			 * 主动作：把本聊天框**切到**该子会话（经宿主 ✓）。
			 * 宿主较旧/失败 ⇒ 明确通知（这与官方"开右栏"那条点了没反应的区别就在这一行 ✗→✓）。
			 */
			const switchTo = (childId, label) => {
				setOpen(false);
				try {
					if (bridge && typeof bridge.openSession === "function") {
						Promise.resolve(bridge.openSession(childId)).catch((err) => {
							if (state) { state.subagentSwitchError = String((err && err.message) || err); }
							try { bridge.notify("attention", "切换子智能体会话失败：" + ((err && err.message) || err)); } catch { /* 无妨 */ }
						});
						if (state) { state.subagentSwitches = (state.subagentSwitches || 0) + 1; state.lastSubagentSwitched = label || childId; }
						return;
					}
				} catch (e) {
					if (state) { state.subagentSwitchError = String((e && e.message) || e); }
				}
				if (state) { state.subagentSwitchErrors = (state.subagentSwitchErrors || 0) + 1; }
				try {
					if (bridge && bridge.notify) {
						bridge.notify("attention", "宿主较旧（无 openSession）⇒ 无法切换子智能体会话：" + (label || childId));
					}
				} catch { /* 无妨 */ }
			};

			const rows = entries.map((entry, i) => {
				const id = String((entry && entry.id) || "");
				const label = (entry && typeof entry.label === "string" && entry.label.trim()) ? entry.label.trim() : id.slice(0, 8);
				const mode = entry && entry.mode;
				const running = isRunning(id);
				const dur = durationLabel(timingOf(id));
				const metaParts = [];
				if (running) { metaParts.push("运行中"); } else { metaParts.push("已完成"); }
				if (dur) { metaParts.push(dur); }
				return react.createElement("div", {
					key: "sa" + i,
					style: CSS.row,
					title: "点击切到该子智能体的会话",
					onClick: () => switchTo(id, label),
					onMouseEnter: (e) => { try { e.currentTarget.style.background = "rgba(255,255,255,.06)"; } catch { /* 无妨 */ } },
					onMouseLeave: (e) => { try { e.currentTarget.style.background = "transparent"; } catch { /* 无妨 */ } },
				},
					react.createElement("span", { style: running ? CSS.dot : CSS.dotIdle }),
					react.createElement("div", { style: CSS.main },
						react.createElement("div", { style: CSS.name }, label),
						react.createElement("div", { style: CSS.meta }, metaParts.join(" · ")),
					),
					mode === "one-shot"
						? react.createElement("span", { style: CSS.pill }, "一次性")
						: mode === "continuable"
							? react.createElement("span", { style: CSS.pill }, "可继续")
							: null,
					react.createElement("span", { style: CSS.pill }, "切会话"),
				);
			});

			return react.createElement("div", { ref: rootRef, style: { position: "relative" }, "data-vssaros-subagents": "1" },
				react.createElement("div", {
					style: CSS.chip,
					title: "子智能体：" + entries.length + " 个" + (runningCount ? "（" + runningCount + " 运行中）" : ""),
					onClick: () => setOpen(!open),
				},
					react.createElement("span", { style: runningCount ? CSS.dot : CSS.dotIdle }),
					react.createElement("span", null, entries.length + " 个子智能体"),
					react.createElement("span", { style: CSS.caret }, open ? "▲" : "▼"),
				),
				open ? react.createElement("div", { style: CSS.pop },
					react.createElement("div", { style: CSS.popTitle }, "子智能体（点击切到它的会话）"),
					rows,
					react.createElement("div", { style: CSS.note },
						"官方那枚下拉里的「在右侧栏打开」在本形态下点了没反应（右栏被聊天框形态隐藏）⇒ 这里换成切会话。"),
				) : null,
			);
		}

		/**
		 * @param {any} ctx  插件上下文（cordis）
		 * @param {any} shell 主包传下来的外壳：{bridge,state,sessionId,mark,rebind,fitMenu,menus}
		 */
		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			// ★★ 2026-10-30（用户要求「desktop 用 dsh 原生交互、IDE 用 IDE 交互」）：
			//   这枚入口存在的全部理由是"右栏被 chat-only 裁掉 ⇒ 官方行内『在右侧栏打开』是死按钮"。
			//   desktop 窗口**右栏在** ⇒ 官方那枚下拉（`subagent-catalog`，行点击切会话 + 行内动作开右栏）
			//   本来就是完整的原生交互，不需要我们再补一枚（补了反而多一条非原生入口 ✗）。
			//   判据由入口算好放 `shell.ide`（单一真相，见 client.js 的 isIdeChatView）。
			if (!shell.ide) {
				state.vssarosSubagentsEntry = false;
				state.vssarosSubagentsEntrySkipped = "desktop 窗口（chatOnly=0）：保留官方子代理目录的原生交互";
				return;
			}
			const Wrapped = (props) => react.createElement(SubagentsEntry, Object.assign({}, props, {
				__vssarosState: state,
				__vssarosBridge: bridge,
				__vssarosMenus: shell.menus,
			}));
			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register(
					{ name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER }, Wrapped));
				state.vssarosSubagentsEntry = true;
			} catch (e) {
				state.vssarosSubagentsEntryError = String((e && e.message) || e);
				if (bridge && bridge.notify) {
					bridge.notify("attention", "子智能体入口挂载失败（slot " + SLOT + "）：" + state.vssarosSubagentsEntryError);
				}
			}
		}

		exports.install = install;
		// 仅测试用：纯逻辑（时长文案 / 注册参数）
		exports.__test = { durationLabel, ENTRY_ID, ENTRY_ORDER, SLOT };
		return module.exports;
	}
});
