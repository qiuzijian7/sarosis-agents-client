// @vssaros/dsh-chat-surface — 聊天框「Agent 欢迎卡」（slot: conversation.input.dock，id `vssaros-bot-welcome`，order -5）
// package-local chunk（契约同 client.delegate.js）：主包 lib/client.js 用 require.async 取回本模块的 install()。
//
// ── 为什么加这一枚（2026-10-16，Agents「Bot 模式」方案 A 第 3 步；mockup doc/agents-botmode-mockup.html）──
// 参考 DeepSeekBot 的私聊首屏：和某个 agent 开一段**新会话**时，先看到它是谁、能帮什么、从哪开始。
//
// ── 硬约束（改这个文件前先读）─────────────────────────────────────────────
// ① **只在「空会话 + 跑的是我们的 agent」时出现**：input.dock 有消息时也会渲染 ⇒ 组件自己判 `blank`；
//    模式 preset（vssaros-standard/ptc/minimal/cordis）与 dsh 自带 preset 不出卡（判据与 client.agents.js 的
//    `sourceOf`/`isModePreset` 同口径 ✓）。
// ② **数据只读自 agents 插件**：GET /x/agents/api/agents 按 `presetId` 精确匹配（**不**自己去前缀反推 id ——
//    presetIdOf 做过 slugify ✓）。API 不在（老版本 ⇒ 404）⇒ 退回 remote.agentPresets 的 name/description，
//    原因留痕 state.welcomeApiMissing（不伪装成"没有 agent" ✗）。
// ③ **凭据两次尝试**：先带 ?token= 再不带（同 client.agents.js 的 personaUrl 口径 ✓）。
// ④ **按钮都是"交接"不是"自己做"**：Agent 主页 / 探索记忆 / 新建 Agent = 写同源 localStorage 焦点交接
//    （vssaros.agents.focus，值 = 前缀:参数|时间戳）+ 桥 openModulePage('/x/agents/')；模型行 = 桥 openAgentSettings。
//    桥缺方法 ⇒ bridge.notify 说出来，不静默 ✗。
// ⑤ order 取 **-5**：官方 todo=0 / goal=10 / queue=20，我们 vssaros-todo=5 / vssaros-delegate=15 ⇒ -5 不 tie，
//    且排在最前（欢迎卡应当在任务清单之上）✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.welcome.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "conversation.input.dock";
		const ENTRY_ID = "vssaros-bot-welcome";
		const ENTRY_ORDER = -5;
		const API = "/x/agents/api/agents";
		const FOCUS_KEY = "vssaros.agents.focus";
		const ROSTER_TTL_MS = 30000;
		const VSSAROS_PREFIX = "vssaros-";
		const MODE_PRESETS = ["standard", "ptc", "minimal", "cordis"];

		/** 跑的是不是**我们的 agent**（不是模式 preset、不是 dsh 自带 preset）。 */
		function isAgentPreset(presetId) {
			const id = String(presetId || "");
			return id.startsWith(VSSAROS_PREFIX) && MODE_PRESETS.indexOf(id.slice(VSSAROS_PREFIX.length)) < 0;
		}
		/** 名册里按 presetId 精确匹配（约束 ②）。 */
		function pickAgent(agents, presetId) {
			if (!Array.isArray(agents) || !presetId) { return null; }
			return agents.find((a) => a && a.presetId === presetId) || null;
		}
		/** 建议问题：目前是**固定**三条（.agent.md 还没有建议字段；不按名字瞎编 ✗）。 */
		const SUGGESTIONS = [
			"介绍一下你能帮我做什么",
			"帮我规划今天的工作",
			"看看我当前的工作区，有什么你能帮上忙的",
		];
		/**
		 * **按 preset 定制的建议**（★ 2026-10-26 用户：「帮我重构商城助手的提示词」）。
		 *
		 * 为什么需要：默认三条是通用话术，挂到专门 agent 上会答非所问
		 *   （商城助手的卡片里写着"帮我规划今天的工作"，用户一看就知道不是给它写的 ✗）。
		 *
		 * ⚠ 过渡方案：`.agent.md` 将来若支持 `suggestions:` 字段，应改成读 agent 自己的；
		 *   这里只留「内置 agent 的专属话术」。新增时**必须紧扣它真实能做的事**，不写愿景。
		 */
		const SUGGESTIONS_BY_PRESET = {
			"vssaros-marketplace-bot": [
				"帮我找一个能自动操作浏览器的小工具",
				"把一个 GitHub 项目发布到商城",
				"商城里有哪些工作台？怎么装",
			],
		};
		/**
		 * 取建议（**三级兜底**）：
		 *   ① **agent 自带的** `suggestions:`（`.agent.md` 里写的，最准 —— 2026-10-26 新增）
		 *   ② `SUGGESTIONS_BY_PRESET`（内置 agent 的专属话术，历史硬编码）
		 *   ③ `SUGGESTIONS`（通用三条）
		 */
		function suggestionsOf(presetId, own) {
			if (Array.isArray(own) && own.length) { return own; }
			const mapped = SUGGESTIONS_BY_PRESET[String(presetId || "")];
			return Array.isArray(mapped) && mapped.length ? mapped : SUGGESTIONS;
		}
		/** 焦点交接的值（与 agents 插件 sideview.js 同格式：前缀:参数|时间戳）。 */
		function handoffValue(prefix, arg, now) {
			return prefix + ":" + String(arg || "") + "|" + String(now);
		}
		/** 卡片要显示的字段（纯函数：API 行或 remote preset 行 → 统一形状）。 */
		function cardModel(agent, fallbackPreset) {
			if (agent) {
				return {
					id: String(agent.id || ""),
					name: String(agent.name || agent.id || ""),
					icon: String(agent.icon || String(agent.name || "?").slice(0, 1)),
					color: String(agent.color || "#3b5bdb"),
					role: agent.role ? String(agent.role) : "",
					description: agent.description ? String(agent.description) : "",
					skills: Array.isArray(agent.skills) ? agent.skills.map(String) : [],
					// ★ 2026-10-26：`.agent.md` 的 `suggestions:`（API 可能给数组，也可能是逗号串）
					suggestions: Array.isArray(agent.suggestions)
						? agent.suggestions.map(String).filter(Boolean)
						: (typeof agent.suggestions === "string" && agent.suggestions.trim()
							? agent.suggestions.split(",").map((x) => String(x).trim()).filter(Boolean)
							: []),
					model: agent.model ? String(agent.model) : "",
					full: true,
				};
			}
			if (fallbackPreset) {
				const name = String(fallbackPreset.name || fallbackPreset.id || "");
				return { id: "", name, icon: name.slice(0, 1) || "?", color: "#3b5bdb", role: "", description: fallbackPreset.description ? String(fallbackPreset.description) : "", skills: [], model: "", full: false };
			}
			return null;
		}

		/** 像素横幅：按名字作种子生成（与 mockup 同一算法；3:1）。 */
		function seeded(str) {
			let h = 2166136261;
			for (const ch of String(str || "")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
			return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
		}
		function drawBanner(cv, name) {
			const g = cv && cv.getContext ? cv.getContext("2d") : null;
			if (!g) { return; }
			const W = cv.width, H = cv.height, rnd = seeded(name);
			const hue = Math.floor(rnd() * 360);
			for (let y = 0; y < H; y++) { g.fillStyle = "hsl(" + ((hue + 180) % 360) + " 55% " + (72 - y * 0.6) + "%)"; g.fillRect(0, y, W, 1); }
			g.fillStyle = "#ffffff";
			for (let i = 0; i < 4; i++) { const x = Math.floor(rnd() * W), y = Math.floor(rnd() * 10) + 2, w = 8 + Math.floor(rnd() * 10); g.fillRect(x, y, w, 2); g.fillRect(x + 2, y - 2, Math.max(1, w - 4), 2); }
			const base = 22;
			for (let x = 0; x < W; x++) { const hh = base + Math.round(Math.sin((x + rnd() * 3) / 9) * 2); g.fillStyle = "hsl(" + ((hue + 100) % 360) + " 40% 42%)"; g.fillRect(x, hh, 1, H - hh); }
			for (let i = 0; i < 6; i++) {
				const x = Math.floor(rnd() * (W - 6)), y = base - 6 + Math.floor(rnd() * 3);
				g.fillStyle = "#6b4a2b"; g.fillRect(x + 2, y + 4, 2, 4);
				g.fillStyle = "hsl(" + ((hue + 330) % 360) + " 65% 75%)"; g.fillRect(x, y, 6, 4); g.fillRect(x + 1, y - 1, 4, 1);
			}
		}

		const CSS = {
			// ⚠ `flexShrink: 0` 是**真机必需**（2026-10-17 页面级 CDP 实测）：卡片的祖先是
			// `.composerStack`（flex column，高度由官方按内容算出的定值，实测折叠时 274px）⇒
			// 卡片默认 `flex: 0 1 auto` 会被**压扁**（内容 44px → 实测 14.5px，只剩一条缝，
			// 名字和「展开」都看不全 —— 用户截图报障现场 ✗）。加上之后折叠 46px / 展开 392px，
			// 父容器自己长高（274→306 / 620），不裁剪。
			wrap: { flexShrink: 0, margin: "2px 10px 8px", borderRadius: 12, overflow: "hidden", border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))", background: "var(--dsw-alias-bg-layer-1, transparent)" },
			banner: { display: "block", width: "100%", height: 52, imageRendering: "pixelated" },
			body: { padding: "0 12px 10px", position: "relative" },
			avatar: { width: 44, height: 44, borderRadius: 11, marginTop: -24, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: "#fff", border: "3px solid var(--dsw-alias-bg-layer-1, #1e1e1e)", boxSizing: "content-box" },
			// 方案 C：折叠态的头行（小头像 + 名字/角色 + 展开按钮）；展开态沿用原来的大头像 + 横幅
			head: { display: "flex", alignItems: "center", gap: 8 },
			avatarSmall: { width: 26, height: 26, borderRadius: 8, marginTop: 8, fontSize: 14, border: "none" },
			hidden: { display: "none" },
			toggle: { flex: "none", marginLeft: "auto", fontSize: 11, lineHeight: "18px", padding: "1px 8px", borderRadius: 7, border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.4))", background: "transparent", color: "var(--dsw-alias-label-secondary, currentColor)", cursor: "pointer" },
			nameRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5, marginTop: 4, flex: "1 1 auto", minWidth: 0 },
			name: { fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-primary, currentColor)" },
			chip: { fontSize: 10, lineHeight: "16px", padding: "0 7px", borderRadius: 9, border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.4))", color: "var(--dsw-alias-label-secondary, currentColor)", whiteSpace: "nowrap" },
			chipRole: { color: "#c586c0", borderColor: "rgba(197,134,192,.45)" },
			chipBrand: { color: "var(--dsw-alias-brand-primary, #3794ff)", borderColor: "rgba(55,148,255,.45)" },
			greet: { marginTop: 7, fontWeight: 600, fontSize: 12.5, color: "var(--dsw-alias-label-primary, currentColor)" },
			desc: { marginTop: 3, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary, currentColor)", overflowWrap: "anywhere" },
			skills: { marginTop: 5, display: "flex", flexWrap: "wrap", gap: 4 },
			sugg: { marginTop: 9, border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))", borderRadius: 9, overflow: "hidden" },
			suggItem: { display: "block", width: "100%", textAlign: "left", padding: "6px 10px", border: "none", borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))", background: "transparent", color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 12, cursor: "pointer" },
			modelRow: { marginTop: 8, display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "5px 10px", borderRadius: 9, border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))", background: "transparent", color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 11.5, cursor: "pointer", textAlign: "left" },
			modelSub: { color: "var(--dsw-alias-label-secondary, currentColor)", marginLeft: "auto", whiteSpace: "nowrap" },
			acts: { marginTop: 9, display: "flex", flexWrap: "wrap", gap: 6 },
			btn: { fontSize: 11.5, padding: "3px 11px", borderRadius: 6, cursor: "pointer", border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.4))", background: "transparent", color: "var(--dsw-alias-label-primary, currentColor)" },
			btnPrimary: { background: "var(--dsw-alias-brand-primary, #3794ff)", borderColor: "var(--dsw-alias-brand-primary, #3794ff)", color: "#fff" },
			foot: { marginTop: 8, fontSize: 10, color: "var(--dsw-alias-label-secondary, currentColor)", opacity: 0.75 },
		};

		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			// 名册缓存（模块内、按页面）：GET 很重（每次都会同步 preset + 读实况）⇒ 30s 内复用，不轮询 ✓
			let rosterCache = null;
			const authToken = () => {
				try {
					if (shell && typeof shell.token === "string" && shell.token) { return shell.token; }
					if (typeof location === "undefined" || !location.search) { return ""; }
					return new URLSearchParams(location.search).get("token") || "";
				} catch { return ""; }
			};
			const fetchImpl = () => (shell && typeof shell.fetch === "function" ? shell.fetch : (typeof fetch === "function" ? fetch : null));
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
							if (r && r.status === 404) { return { ok: false, missing: true, why: "HTTP 404" }; }
							if (!r || r.ok === false) { return { ok: false, why: "HTTP " + ((r && r.status) || "?") }; }
							return r.json().then((j) => ({ ok: true, agents: Array.isArray(j && j.agents) ? j.agents : [] }));
						}, (e) => ({ ok: false, why: String((e && e.message) || e) }));
				};
				const promise = attempt(true).then((a) => (a.ok || a.missing ? a : attempt(false)));
				rosterCache = { at: now, promise };
				promise.then((r) => {
					if (r.missing) { state.welcomeApiMissing = "HTTP 404（agents 插件过旧或没装，无 " + API + "）"; }
					else if (!r.ok) { state.welcomeApiError = r.why; rosterCache = null; }
				});
				return promise;
			};
			const loadFallbackPresets = () => {
				if (!ctx.remote || !ctx.remote.agentPresets || typeof ctx.remote.agentPresets.list !== "function") { return Promise.resolve([]); }
				return Promise.resolve(ctx.remote.agentPresets.list()).then((r) => (r && r.ok && r.value && Array.isArray(r.value.presets) ? r.value.presets : []), () => []);
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
			const handoff = (prefix, arg) => {
				try { if (typeof localStorage !== "undefined") { localStorage.setItem(FOCUS_KEY, handoffValue(prefix, arg, Date.now())); } } catch { /* 存不了也照样打开页面 */ }
				if (!bridge || typeof bridge.openModulePage !== "function") { say("当前宿主不支持从聊天框打开 Agents 页（需要桥版本 3+）"); return; }
				Promise.resolve(bridge.openModulePage("/x/agents/")).catch((e) => say("打开 Agents 页失败：" + String((e && e.message) || e)));
			};

			function Banner(props) {
				const ref = react.useRef(null);
				react.useEffect(() => { if (ref.current) { drawBanner(ref.current, props.name); } }, [props.name]);
				return react.createElement("canvas", { ref, width: 96, height: 32, style: CSS.banner, "data-vssaros-welcome-banner": "1" });
			}

			function WelcomeCard(props) {
				const sid = (props && props.sessionId) || state.sessionId;
				const [, force] = react.useState(0);
				const [roster, setRoster] = react.useState(null);
				const [fallback, setFallback] = react.useState(null);
				// 方案 C（2026-10-17 用户拍板）：默认**折叠成一行**（小头像 + 名字 + 角色 chip + 「展开 ⌄」）。
				// 为什么不要"限高滚动"：卡片在 hero 里与输入框相邻，内部滚动条会和触控板滚动抢手势；
				// 为什么折叠态仍把内容留在 DOM（`display:none`）：探针/自证按属性查节点（p3-112 的
				// suggest/model/act 断言），折叠只是视觉收起，不是"没渲染" ✓。
				const [open, setOpen] = react.useState(false);
				react.useEffect(() => subscribeSessions(() => force((n) => n + 1)), []);
				const summary = readSummary(sid);
				const session = props && props.session;
				const blank = session && typeof session.blank === "boolean" ? session.blank : !!(summary && summary.blank);
				const presetId = summary && summary.projectionValues && summary.projectionValues.agentPreset;
				const show = !!sid && blank && isAgentPreset(presetId);
				react.useEffect(() => {
					if (!show) { return undefined; }
					let dead = false;
					loadAgents().then((r) => {
						if (dead) { return; }
						if (r.ok) { setRoster(r.agents); return; }
						loadFallbackPresets().then((list) => { if (!dead) { setFallback(list); } });
					});
					return () => { dead = true; };
				}, [show, presetId]);
				if (!show) { return null; }
				const model = cardModel(pickAgent(roster, presetId), (fallback || []).find((p) => p && p.id === presetId));
				if (!model) { return null; }
				state.welcomeShown = presetId;
				const inputActions = props && props.inputActions;
				const ask = (text) => {
					if (!inputActions || typeof inputActions.setDraft !== "function") { say("聊天框没有提供输入接口（inputActions），请直接在输入框里提问"); return; }
					inputActions.setDraft(text);
					if (typeof inputActions.submit === "function") { inputActions.submit(); }
				};
				const openSettings = () => {
					if (!model.id) { say("没拿到这个 Agent 的 id（agents 插件没装或过旧），无法打开设置"); return; }
					if (!bridge || typeof bridge.openAgentSettings !== "function") { say("当前宿主不支持从这里打开 Agent 设置（需要桥版本 6+）"); return; }
					Promise.resolve(bridge.openAgentSettings(model.id, model.name)).catch((e) => say("打开 Agent 设置失败：" + String((e && e.message) || e)));
				};
				const e = react.createElement;
				const chip = (key, text, extra) => e("span", { key, style: Object.assign({}, CSS.chip, extra || {}) }, text);
				// 方案 C：折叠态 = 一行头（小头像 + 名字/角色 chip + 「展开 ⌄」）；
				// 展开态 = 横幅 + 问候 + 简介 + 技能 + 建议问 + 模型 + 入口 + 脚注。
				const toggle = e("button", {
					key: "tg", type: "button",
					"data-vssaros-welcome-toggle": open ? "collapse" : "expand",
					title: open ? "收起欢迎卡" : "展开完整介绍（建议问 / 模型 / 入口）",
					onClick: () => setOpen((v) => !v),
					style: CSS.toggle,
				}, open ? "收起 ⌃" : "展开 ⌄");
				const header = e("div", { key: "hd", style: CSS.head },
					e("span", {
						style: Object.assign({}, CSS.avatar, open ? {} : CSS.avatarSmall, { background: model.color }),
						"data-vssaros-welcome-avatar": "1",
					}, model.icon),
					e("div", { style: CSS.nameRow },
						e("span", { style: CSS.name }, model.name),
						chip("brand", "专属 Agent", CSS.chipBrand),
						model.role ? chip("role", model.role, CSS.chipRole) : null),
					toggle);
				return e("div", {
					style: CSS.wrap,
					"data-vssaros-welcome": model.id || presetId,
					"data-vssaros-welcome-open": open ? "1" : "0",
				},
					e("div", { key: "bn", style: open ? undefined : CSS.hidden }, e(Banner, { name: model.name })),
					e("div", { style: CSS.body },
						header,
						e("div", { key: "ct", style: open ? undefined : CSS.hidden },
							e("div", { style: CSS.greet }, "你好，我是 " + model.name),
							e("div", { style: CSS.desc }, model.description || "我是你的专属 Agent。挑一个问题开始，或者直接在下面的输入框里说你要做什么。"),
							model.skills.length ? e("div", { style: CSS.skills }, model.skills.slice(0, 6).map((s) => chip("s-" + s, "skill: " + s))) : null,
							e("div", { style: CSS.sugg, "data-vssaros-welcome-suggestions": "1" },
								// ⚠ 用**外层 `presetId`**（`cardModel` 的返回里没有 presetId —— 它只装展示字段）
			(suggestionsOf(presetId, model && model.suggestions).map((text, i) => e("button", {
									key: "q" + i, type: "button", style: Object.assign({}, CSS.suggItem, i === SUGGESTIONS.length - 1 ? { borderBottom: "none" } : {}),
									"data-vssaros-welcome-ask": String(i), onClick: () => ask(text),
								}, text)))),
							e("button", { type: "button", style: CSS.modelRow, onClick: openSettings, title: "打开这个 Agent 的设置（改模型、人设、工具）", "data-vssaros-welcome-model": "1" },
								e("span", null, "🧠"),
								e("span", null, "模型"),
								e("span", { style: CSS.modelSub }, (model.model || "跟随默认") + " ›")),
							e("div", { style: CSS.acts },
								model.id ? e("button", { key: "home", type: "button", style: Object.assign({}, CSS.btn, CSS.btnPrimary), onClick: () => handoff("home", model.id), "data-vssaros-welcome-act": "home" }, "Agent 主页") : null,
								model.id ? e("button", { key: "mem", type: "button", style: CSS.btn, onClick: () => handoff("memory", model.id), "data-vssaros-welcome-act": "memory" }, "探索记忆") : null,
								e("button", { key: "new", type: "button", style: CSS.btn, onClick: () => handoff("create", "blank"), "data-vssaros-welcome-act": "create" }, "新建 Agent")),
							e("div", { style: CSS.foot }, model.full
								? "欢迎卡 · 名字、简介、角色、技能都来自它的 .agent.md"
								: "欢迎卡 · agents 插件不可用，只显示 preset 名称"))));
			}

			const Wrapped = (props) => react.createElement(WelcomeCard, props);
			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER }, Wrapped));
				state.vssarosWelcome = true;
			} catch (err) {
				state.vssarosWelcomeError = String((err && err.message) || err);
				say("Agent 欢迎卡挂载失败（slot " + SLOT + "）：" + state.vssarosWelcomeError);
			}
		}

		exports.install = install;
		// 仅测试用：纯逻辑
		exports.__test = { isAgentPreset, pickAgent, cardModel, handoffValue, SUGGESTIONS, SUGGESTIONS_BY_PRESET, suggestionsOf, ENTRY_ID, ENTRY_ORDER, SLOT, seeded };
		return module.exports;
	}
});
