// @vssaros/dsh-chat-surface — 聊天框顶部「Agent 胶囊」（slot: conversation.session.header.actions，id `vssaros-bot-capsule`，order -28）
// package-local chunk（契约同 client.preset.js）：主包 lib/client.js 用 require.async 取回本模块的 install()。
//
// ── 为什么加这一枚（2026-10-17，Agents「Bot 模式」待定项 ① = 用户拍板「甲 · 只读导航胶囊」，
//    mockup doc/agents-botmode-decisions.html）──
// 参考 DeepSeekBot 顶部居中的 bot 胶囊，但**只读**：不报「在这里切 Agent」（切换 = 换会话，
// 已有 hero PresetChip / 输入框 AgentChip 两个入口，第三份语义会混淆）。它的价值是**导航**：
// 去这个 Agent 的主页 / 设置 / 开新会话回看欢迎卡 —— 不用先回 Agents 页找。
//
// ── 与 2026-10-11 旧口径的关系（改这个文件前先读）──────────────────────────────
// 旧口径「头部不显示 Agent 名」针对的是**官方 preset 标签**（它对任何 preset 都冒名字、且不可点）⇒
// client.agents.js 用 CSS 把它藏掉。本胶囊是我们**自绘的、知道自己报的是谁**的导航入口，用户已拍板要它；
// 名字归属仍不重复：人格由输入框 AgentChip 报，模式由官方标签报 ✓。
// 可见性 = 当前会话跑的是**我们的 agent**（与 client.agents.js 的 applyMarker 同一判据：vssaros- 前缀、
// 非模式 preset）；空会话时 header.actions 整组不渲染（此时由欢迎卡代劳）✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.capsule.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "conversation.session.header.actions";
		const ENTRY_ID = "vssaros-bot-capsule";
		// 官方 subagent-catalog=-30、我们 context-entry=-27 ⇒ -28 是空档（升序 = 从左到右）
		const ENTRY_ORDER = -28;
		const MENU_ID = "vssaros-bot-capsule";
		const API = "/x/agents/api/agents";
		const FOCUS_KEY = "vssaros.agents.focus";
		const ROSTER_TTL_MS = 30000;
		const VSSAROS_PREFIX = "vssaros-";
		const MODE_PRESETS = ["standard", "ptc", "minimal", "cordis"];

		/** 跑的是不是**我们的 agent**（判据与 client.agents.js 同口径）。 */
		function isAgentPreset(presetId) {
			const id = String(presetId || "");
			return id.startsWith(VSSAROS_PREFIX) && MODE_PRESETS.indexOf(id.slice(VSSAROS_PREFIX.length)) < 0;
		}

		/**
	 * 把弹层的**视口位置**夹进视口（纯函数 ⇒ 可单测 ✓；模块作用域，两个 chunk 同一口径 ✓）。
	 *
	 * ★ 2026-10-28（用户报障「点 preset/胶囊 chip，弹出框 UI 位置错误」）：
	 *   胶囊 chip 在 header **左侧** ⇒ 菜单若"右对齐 chip 右缘"（`right: 0`）就会整体
	 *   **越出视图左边缘** ⇒ 被裁掉一半（截图里就是"只看得见右半截、字被切掉"）✗。
	 *   ⇒ 统一口径：**先按倾向对齐，再左右都夹进视口**（放不下就往另一边收）✓。
	 *
	 * @param anchor 触发器矩形（视口坐标）：{left, right, bottom}
	 * @param size 菜单尺寸：{w, h}
	 * @param viewport：{vw, vh}
	 * @param align 倾向：'right' = 菜单右缘贴 chip 右缘；'left' = 左缘贴 chip 左缘
	 */
	function fitMenuBox(anchor, size, viewport, align) {
		const vw = viewport && viewport.vw ? viewport.vw : 0;
		const vh = viewport && viewport.vh ? viewport.vh : 0;
		const w = size && size.w ? size.w : 0;
		const h = size && size.h ? size.h : 0;
		// 量不到锚点/视口 ⇒ 交出零值由调用方回落（**不猜**位置 ✗）
		if (!anchor || !vw) { return { left: 0, top: 0 }; }
		let left = align === "left" ? anchor.left : anchor.right - w;
		if (left < 8) { left = 8; }                                   // 不越左缘
		if (left + w > vw - 8) { left = Math.max(8, vw - 8 - w); }    // 不越右缘
		let top = anchor.bottom + 4;
		if (vh && top + h > vh - 8) { top = Math.max(8, vh - 8 - h); } // 下方不够就往上收
		return { left: Math.round(left), top: Math.round(top) };
	}

	function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			let rosterCache = null;
			const authToken = () => {
				try {
					if (shell && typeof shell.token === "string" && shell.token) { return shell.token; }
					if (typeof location === "undefined" || !location.search) { return ""; }
					return new URLSearchParams(location.search).get("token") || "";
				} catch { return ""; }
			};
			const fetchImpl = () => (shell && typeof shell.fetch === "function" ? shell.fetch : (typeof fetch === "function" ? fetch : null));
			/** 与 client.welcome.js 同一取法（30s 缓存、先带 token 再不带、404 留痕）。 */
			const loadAgents = () => {
				const now = Date.now();
				if (rosterCache && now - rosterCache.at < ROSTER_TTL_MS) { return rosterCache.promise; }
				const impl = fetchImpl();
				if (!impl) { return Promise.resolve({ ok: false, why: "fetch unavailable" }); }
				const attempt = (withToken) => {
					const token = withToken ? authToken() : "";
					return Promise.resolve()
						.then(() => impl(API + (token ? "?token=" + encodeURIComponent(token) : ""), { credentials: "same-origin" }))
						.then((r) => {
							if (r && r.status === 404) { return { ok: false, missing: true }; }
							if (!r || r.ok === false) { return { ok: false, why: "HTTP " + ((r && r.status) || "?") }; }
							return r.json().then((j) => ({ ok: true, agents: Array.isArray(j && j.agents) ? j.agents : [] }));
						}, (e) => ({ ok: false, why: String((e && e.message) || e) }));
				};
				const promise = attempt(true).then((a) => (a.ok || a.missing ? a : attempt(false)));
				rosterCache = { at: now, promise };
				promise.then((r) => { if (r.missing) { state.capsuleApiMissing = "HTTP 404（agents 插件过旧或没装，无 " + API + "）"; } else if (!r.ok) { rosterCache = null; } });
				return promise;
			};
			const readSummary = (sid) => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					const snap = list && list.getSnapshot();
					return sid && snap && snap.byId ? snap.byId[sid] : undefined;
				} catch { return undefined; }
			};
			const subscribeSessions = (fn) => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					return list && typeof list.subscribe === "function" ? list.subscribe(fn) : undefined;
				} catch { return undefined; }
			};
			const say = (text) => { try { if (bridge && bridge.notify) { bridge.notify("attention", text); } } catch { /* 通知失败不阻塞 */ } };
			const handoffHome = (agentId) => {
				try { if (typeof localStorage !== "undefined") { localStorage.setItem(FOCUS_KEY, "home:" + agentId + "|" + Date.now()); } } catch { /* 存不了也照样打开 */ }
				if (!bridge || typeof bridge.openModulePage !== "function") { say("当前宿主不支持从聊天框打开 Agents 页（需要桥版本 3+）"); return; }
				Promise.resolve(bridge.openModulePage("/x/agents/")).catch((e) => say("打开 Agents 页失败：" + String((e && e.message) || e)));
			};

			function BotCapsule(props) {
				const sid = (props && props.sessionId) || state.sessionId;
				const [, force] = react.useState(0);
				const [roster, setRoster] = react.useState(null);
				const [open, setOpen] = react.useState(false);
				const rootRef = react.useRef(null);
				// ★ 2026-10-28（用户报障「点 preset/胶囊 chip，弹出框 UI 位置错误」）：
				//   菜单原来用 `right: 0`（右对齐 chip 右缘 ⇒ 向**左**展开）⇒ 胶囊 chip 在 header **左侧**
				//   ⇒ 菜单整体越出视图左边缘 ⇒ **被裁掉一半**（截图里就是"只看得见右半截、字被切掉"）✗。
				//   ⇒ 改成：打开后量一次菜单**真实尺寸**，把位置**夹进视口**（左右都不许越界）✓。
				//   ⚠ 位置是**相对 chip 容器**（容器 position: relative）的偏移 ⇒ 不用 fixed
				//     （fixed 在有 transform 的祖先下会变成相对那个祖先 ⇒ 视口坐标全错 ✗）。
				const menuRef = react.useRef(null);
				const [box, setBox] = react.useState(null); // {left, top} 相对 chip 容器
				react.useEffect(() => subscribeSessions(() => force((n) => n + 1)), []);
				const summary = readSummary(sid);
				const presetId = summary && summary.projectionValues && summary.projectionValues.agentPreset;
				const show = !!sid && isAgentPreset(presetId);
				react.useEffect(() => {
					if (!show) { return undefined; }
					let dead = false;
					loadAgents().then((r) => { if (!dead && r.ok) { setRoster(r.agents); } });
					return () => { dead = true; };
				}, [show, presetId]);
				react.useEffect(() => {
					if (!open) { return; }
					const close = (ev) => { if (rootRef.current && ev.target && rootRef.current.contains(ev.target)) { return; } setOpen(false); };
					const esc = (ev) => { if (ev.key === "Escape") { setOpen(false); } };
					document.addEventListener("mousedown", close, true);
					document.addEventListener("keydown", esc, true);
					return () => {
						document.removeEventListener("mousedown", close, true);
						document.removeEventListener("keydown", esc, true);
					};
				}, [open]);
				react.useEffect(() => {
					if (!open || !shell.menus) { return; }
					shell.menus.closeOthers(MENU_ID);
					return shell.menus.register(MENU_ID, () => setOpen(false));
				}, [open]);
				// ★ 2026-10-28：把菜单**夹进视口**（量自己的真实尺寸 ⇒ 不用猜宽度）。
				//   默认仍"贴着 chip 右缘"（右对齐，符合它在 header 左边的观感）⇒
				//   越左缘就贴左、越右缘就往左收 ⇒ **任何宽度下都不会被裁** ✓。
				react.useEffect(() => {
					if (!open) { setBox(null); return undefined; }
					const place = () => {
						try {
							const chip = rootRef.current; const menu = menuRef.current;
							if (!chip || !menu || typeof chip.getBoundingClientRect !== "function") { return; }
							const cr = chip.getBoundingClientRect();
							const mr = typeof menu.getBoundingClientRect === "function" ? menu.getBoundingClientRect() : null;
							const vw = typeof window !== "undefined" ? window.innerWidth : 0;
							const vh = typeof window !== "undefined" ? window.innerHeight : 0;
							const mw = mr && mr.width ? mr.width : 220;
							const mh = mr && mr.height ? mr.height : 140;
							// ★ 夹进视口（纯函数口径，与 client.preset.js 同一份逻辑 ✓）
							//   ⇒ 坐标是**视口坐标**（配 position: fixed 用）⇒ 不再减容器偏移 ✓
							const pos = fitMenuBox({ left: cr.left, right: cr.right, bottom: cr.bottom }, { w: mw, h: mh }, { vw, vh }, "right");
							setBox({ left: pos.left, top: pos.top });
						} catch { /* 量不到就保持默认位置（不静默不显示 ✗） */ }
					};
					place();
					// 菜单内容/宽度可能在下一帧才稳定 ⇒ 量两次（第二帧拿到真实宽度）✓
					const t = window.setTimeout(place, 60);
					if (typeof window.addEventListener === "function") {
						window.addEventListener("resize", place);
						return () => {
							window.clearTimeout(t);
							window.removeEventListener("resize", place);
						};
					}
					return () => { window.clearTimeout(t); };
				}, [open]);
				if (!show) { return null; }
				const agent = (roster || []).find((a) => a && a.presetId === presetId) || null;
				// 名字：agents API 的名字 → preset id 去前缀（API 404 时的兜底；这就是 capsuleApiMissing 的可见后果 ✓）
				const name = agent ? String(agent.name || agent.id) : presetId.slice(VSSAROS_PREFIX.length);
				const icon = agent && agent.icon ? String(agent.icon) : name.slice(0, 1);
				const color = agent && agent.color ? String(agent.color) : "#3b5bdb";
				const e = react.createElement;
				const menuItem = (key, label, hint, onClick, disabled) => e("button", {
					key, type: "button", role: "menuitem", disabled: !!disabled, "data-vssaros-capsule-act": key,
					onClick,
					style: {
						display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, width: "100%",
						padding: "5px 8px", border: "none", borderRadius: 7, cursor: disabled ? "default" : "pointer",
						background: "transparent", color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 12, textAlign: "left",
						opacity: disabled ? 0.45 : 1,
					},
				},
					e("span", null, label),
					hint ? e("span", { style: { fontSize: 10.5, color: "var(--dsw-alias-label-secondary, currentColor)" } }, hint) : null);
				const children = [
					e("button", {
						key: "cap", type: "button", "data-vssaros-bot-capsule": presetId,
						"aria-haspopup": "menu", "aria-expanded": open,
						title: "当前会话的专属 Agent：" + name + "（点开：主页 / 设置 / 新会话）",
						onClick: () => setOpen(!open),
						style: {
							display: "inline-flex", alignItems: "center", gap: 5,
							padding: "1px 8px 1px 3px", borderRadius: 999, cursor: "pointer",
							border: "1px solid var(--dsw-alias-brand-primary, #3e5a8f)",
							background: "var(--dsw-alias-bg-layer-2, transparent)",
							color: "var(--dsw-alias-label-primary, currentColor)",
							fontSize: 11, fontWeight: 600, lineHeight: "18px", whiteSpace: "nowrap",
						},
					},
						e("span", { style: { width: 15, height: 15, borderRadius: 5, background: color, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9 } }, icon),
						name),
				];
				if (open) {
					children.push(e("div", {
						key: "menu", role: "menu",
						ref: menuRef,
						// ★ 2026-10-28：位置由上面的「夹进视口」效果算好（`box`，**视口坐标**）⇒
						//   **不再用 `right: 0`**（那会让菜单越出视图左边缘、被裁一半 ✗）。
						// ⚠ **`position: fixed` 而不是 absolute**（与 client.workspace.js 的工作区菜单同口径）：
						//   absolute + zIndex 只在**祖先层叠上下文**内比较 ⇒ dsh header 自己就是带 z-index 的
						//   定位容器，页面浮层（页签条 / 工作台页）可能压在它上面 ⇒ 菜单被盖住一半、
						//   看起来就是"层级错误"✗（2026-10-19 工作区菜单踩过同一个坑 ✓）。
						//   量不到之前的首帧用 chip 右缘下方的落点（不猜、也不闪到别处）✓。
						style: Object.assign({
							position: "fixed",
							left: box ? box.left : 0,
							top: box ? box.top : "100%",
							right: "auto",
							marginTop: box ? 0 : 4,
							zIndex: 1000,
							padding: 5, borderRadius: 10, minWidth: 190,
							border: "1px solid var(--dsw-alias-border-l1, transparent)",
							background: "linear-gradient(var(--dsw-alias-bg-layer-1, transparent), var(--dsw-alias-bg-layer-1, transparent)), var(--dsw-alias-bg-base, #1e1e1e)",
							boxShadow: "0 8px 24px rgba(0,0,0,.35)",
						}, shell.fitMenu ? shell.fitMenu(rootRef.current ? rootRef.current.getBoundingClientRect() : null) : {}),
					},
						menuItem("home", "🏠 Agent 主页", "会话 / 收件箱 / 记忆 / 定时（编辑区）", () => { setOpen(false); agent ? handoffHome(agent.id) : say("agents 插件不可用，拿不到这个 Agent 的 id"); }, false),
						menuItem("settings", "⚙ Agent 设置", "改模型、人格、工具", () => {
							setOpen(false);
							if (!agent) { say("agents 插件不可用，拿不到这个 Agent 的 id"); return; }
							if (!bridge || typeof bridge.openAgentSettings !== "function") { say("当前宿主不支持从这里打开 Agent 设置（需要桥版本 6+）"); return; }
							Promise.resolve(bridge.openAgentSettings(agent.id, agent.name)).catch((err) => say("打开 Agent 设置失败：" + String((err && err.message) || err)));
						}, false),
						menuItem("newchat", "↻ 开新会话", "回看欢迎卡；这条会话的历史保留", () => {
							setOpen(false);
							if (!bridge || typeof bridge.newChat !== "function") { say("当前宿主不支持新开会话（需要桥版本 5+）"); return; }
							Promise.resolve(bridge.newChat(presetId)).catch((err) => say("新开会话失败：" + String((err && err.message) || err)));
						}, false)));
				}
				return e("span", { ref: rootRef, style: { position: "relative", display: "inline-flex", alignItems: "center" } }, ...children);
			}

			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER }, BotCapsule));
				state.vssarosBotCapsule = true;
			} catch (err) {
				state.vssarosBotCapsuleError = String((err && err.message) || err);
				say("Agent 胶囊挂载失败（slot " + SLOT + "）：" + state.vssarosBotCapsuleError);
			}
		}

		exports.install = install;
		// 仅测试用：纯逻辑
		exports.__test = { isAgentPreset, ENTRY_ID, ENTRY_ORDER, SLOT, MENU_ID, fitMenuBox };
		return module.exports;
	}
});
