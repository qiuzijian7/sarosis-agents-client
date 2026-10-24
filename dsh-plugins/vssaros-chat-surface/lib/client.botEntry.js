// @vssaros/dsh-chat-surface — **Bot 入口**（「+」菜单 → Bots）
//
// ── 为什么单独一个 chunk（2026-10-21，用户指令「把 agent 定位成一个 Bot（PersonaBot）」）──
//   ① 定位：**agent 在 dsh 内部仍以 preset 形式存在**（技术必需），但**用户可见的身份是 Bot**
//      （对标 DeepSeekBot 的 PersonaBot：bot 是"谁"，preset 是"怎么干"）⇒
//      · 模式入口（`client.preset.js`）**只列模式**，agent 一个都不进 ✓
//      · agent 从这里进 ⇒ 名字、搜索、空态文案一律叫 Bot ✓
//   ② **无桥环境**（dsh desktop / dsh 全窗）：`client.agents.js` 住在 PART_CHUNKS 里，而那儿有
//      "无桥就整批不装"的早退 ⇒ 桌面端**连 Bots 入口都没有** ✗（模式里没有 agent 了，用户也选不到 Bot）。
//      ⇒ 本 chunk 走**独立装载路径**（client.js 的 ALWAYS_CHUNKS）⇒ 无桥也装 ✓。
//   ③ 与 `client.agents.js` 的那一行**互斥**：有桥时那行已注册（同名会 fail loud）⇒ 本 chunk
//      **只在没有宿主桥时**注册 ⇒ 两边永远只出现一行 "Bots" ✓。
//
// ── 切换人格走**我们自己的 HTTP API**（不是宿主桥）⇒ 无桥也能用 ─────────────
//   `POST /x/agents/api/persona`（agents 插件的页面路由）⇒ 只换人格、当前会话继续 ✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.botEntry.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		/** dsh 自带 4 个模式（不是 Bot）—— 与 client.preset.js 的模式白名单互补：这里取**其余**当 Bot。 */
		const MODE_IDS = new Set(["standard", "ptc", "minimal", "cordis", "vssaros-standard", "vssaros-ptc", "vssaros-full"]);
		/** 「+」菜单里的行名（带前缀，避免与官方命令重名 ⇒ 官方文档：重名会 fail loud）。 */
		const ROW_NAME = "vssaros-bots";
		/** 人格路由（agents 插件的页面路由；与 client.agents.js 同一条）。 */
		const PERSONA_ROUTE = "/x/agents/api/persona";
		/** 预选生效时的重试（新会话刚建出来时 agents 侧可能还没登记它 ⇒ 400「会话不在运行」）。 */
		const APPLY_RETRIES = 6;
		const APPLY_RETRY_MS = 1500;

		/**
		 * ★ P0-2（2026-10-22）：Bot 入口的**可见反馈**。
		 * 无桥环境没有 `bridge.notify`、dsh 也没有官方 toast 服务 ⇒ 用一个两个 chunk **共享**的小 store
		 *   （挂在同一个 `state` 上：client.js 给每个 ALWAYS 部件传的是**同一个** state 对象）⇒
		 *   本 chunk 写、`client.preset.js` 的模式 chip 旁边读出来显示 ✓。
		 * 值形如 `{ kind: "staged" | "done" | "error", text }`；谁先装谁建，后装的复用 ✓。
		 */
		const botNoticeStore = (state) => {
			if (state.vssarosBotNotice) { return state.vssarosBotNotice; }
			let value = null;
			const listeners = new Set();
			const store = {
				get: () => value,
				set: (v) => {
					value = v;
					for (const l of [...listeners]) { try { l(); } catch { /* 单个订阅者出错不连坐 */ } }
				},
				subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
			};
			state.vssarosBotNotice = store;
			return store;
		};

		/** 这类失败值得重试（会话刚建出来、agents 侧还没登记）。 */
		const retryable = (text) => /不在运行|not running/i.test(String(text || ""));

		function install(ctx, shell) {
			const state = (shell && shell.state) || {};
			// 有宿主桥 ⇒ `client.agents.js` 已经注册了那一行（同名会 fail loud）⇒ 这里不重复注册 ✓。
			if (shell && shell.bridge) { state.botEntrySkipped = "bridge-present"; return; }
			// ★ 服务取法必须与 `client.agents.js` 一致：`ctx.get("commandUi")` + `register`
			//   （⚠ 不是 `ctx.commandUi.registerSource` —— 那样拿不到服务 ⇒ 整行静默不注册 ✗）。
			const commandUi = typeof ctx.get === "function" ? ctx.get("commandUi") : undefined;
			if (!commandUi || typeof commandUi.register !== "function") { return; }

			/** 外壳 URL 上的 token（Host 的 requestRejection 对所有路径都要凭据）。 */
			const authToken = () => {
				try {
					if (shell && typeof shell.token === "string" && shell.token) { return shell.token; }
					if (typeof location === "undefined" || !location.search) { return ""; }
					return new URLSearchParams(location.search).get("token") || "";
				} catch { return ""; }
			};

			/** 当前会话 id（官方 SessionListState.current；session-controller/src/client/sessions/service.ts:74）。 */
			const currentSessionId = () => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					const snap = list && list.getSnapshot();
					return snap && typeof snap.current === "string" && snap.current ? snap.current : "";
				} catch { return ""; }
			};
			const subscribeSessions = (fn) => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					if (list && typeof list.subscribe === "function") { return list.subscribe(fn); }
				} catch { /* 订阅不上 ⇒ 预选只能等下一次手动选择 */ }
				return () => undefined;
			};

			const notice = botNoticeStore(state);

			/**
			 * POST 人格切换；与 `client.agents.js` 的 postPersona **同一口径**：token 放 query、
			 * `credentials: same-origin`、失败时**读正文**当原因（这条路由把拒绝原因写在 400 正文里）。
			 * @returns Promise<null | string> —— null 成功；字符串 = 带原因的错误。
			 */
			const postPersona = (sid, presetId) => {
				if (typeof fetch !== "function") { return Promise.resolve("fetch unavailable"); }
				const params = new URLSearchParams();
				const token = authToken();
				if (token) { params.set("token", token); }
				const url = PERSONA_ROUTE + (params.toString() ? "?" + params.toString() : "");
				return Promise.resolve()
					.then(() => fetch(url, {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json", accept: "application/json" },
						body: JSON.stringify(personaRequest(sid, presetId)),
					}))
					.then((r) => {
						state.botEntrySwitch = { status: r && r.status, presetId };
						if (r && r.ok) { return null; }
						return Promise.resolve(r && typeof r.text === "function" ? r.text() : "").then(
							(t) => "HTTP " + ((r && r.status) || "?") + (String(t || "").trim() ? "：" + String(t).trim().replace(/\s+/g, " ").slice(0, 200) : ""),
							() => "HTTP " + ((r && r.status) || "?"));
					}, (e) => String((e && e.message) || e));
			};

			/** 对某个会话应用 Bot（失败且属"会话刚建出来"时按间隔重试）。 */
			const applyTo = (sid, presetId, label, attempt) => {
				return postPersona(sid, presetId).then((err) => {
					if (!err) {
						state.botEntryError = undefined;
						notice.set({ kind: "done", text: "已切换为 Bot · " + label + "（当前会话继续）" });
						return;
					}
					if (retryable(err) && attempt < APPLY_RETRIES) {
						return new Promise((res) => setTimeout(res, APPLY_RETRY_MS)).then(() => applyTo(sid, presetId, label, attempt + 1));
					}
					state.botEntryError = err;
					notice.set({ kind: "error", text: "切换 Bot 失败：" + err });
				});
			};

			/**
			 * ★ P0-2：空白会话（还没有会话 id）里选 Bot ⇒ **先预选**，等第一条消息建出会话后自动应用
			 *   （官方 seat 的 stage/apply 同语义）。旧实现直接 POST 空 sessionId ⇒ 宿主 400「需要 sessionId」，
			 *   错误只写进 state ⇒ 用户**毫无反馈** ✗✗。
			 */
			let staged = null;
			let unsubscribe = null;
			const stage = (presetId, label) => {
				staged = { presetId, label };
				state.botStaged = presetId;
				notice.set({ kind: "staged", text: "已预选 Bot · " + label + "：发出第一条消息后生效" });
				if (unsubscribe) { return; }
				unsubscribe = subscribeSessions(() => {
					const sid = currentSessionId();
					if (!sid || !staged) { return; }
					const pick = staged;
					staged = null;
					state.botStaged = undefined;
					if (unsubscribe) { const u = unsubscribe; unsubscribe = null; try { u(); } catch { /* 已释放 */ } }
					void applyTo(sid, pick.presetId, pick.label, 0);
				});
			};

			/** 切人格的请求体（只换人格、当前会话继续）。 */
			const personaRequest = (sid, presetId) => ({ sessionId: String(sid || ""), presetId: String(presetId || "") });

			/** 花名册（官方 remote，同 client.agents.js）⇒ 取**非模式**的那些 = Bot。 */
			const loadBots = () => {
				try {
					const remote = ctx.remote;
					if (!remote || !remote.agentPresets) { return Promise.resolve([]); }
					return Promise.resolve(remote.agentPresets.list()).then((r) => {
						if (r && r.ok && r.value && Array.isArray(r.value.presets)) {
							return r.value.presets.filter((p) => p && !MODE_IDS.has(String(p.id)));
						}
						return [];
					}).catch(() => []);
				} catch { return Promise.resolve([]); }
			};

			const AgentsIcon = (props) => react.createElement("span", { "data-vssaros-bots-icon": "1", ...props });

			commandUi.register({
				name: ROW_NAME,
				label: () => "Bots",
				description: () => "选择 Bot（PersonaBot）：只换人格，当前会话继续",
				icon: AgentsIcon,
				available: () => true,
				ui: {
					kind: "popupSelect",
					searchMode: "substring",
					searchLabels: () => ({
						placeholder: "搜索 Bot",
						empty: "没有可用的 Bot",
						noResults: "没有匹配的 Bot",
					}),
					options: () => loadBots().then((bots) => bots.map((b) => ({
						id: String(b.id),
						label: String((b && (b.name || b.id)) || ""),
						...(b && b.description ? { detail: String(b.description).slice(0, 80) } : {}),
						...(b && b.broken === true ? { detail: "该 Bot 加载失败（preset 未就绪）" } : {}),
					}))),
					onSelect: (opt, args) => {
						const presetId = opt && opt.id;
						if (!presetId) { return; }
						const label = String((opt && opt.label) || presetId);
						const sid = (args && args.sessionId) || currentSessionId();
						// 无会话 ⇒ 预选（发出第一条消息后自动生效）；有会话 ⇒ 立即切换 ✓
						if (!sid) { stage(presetId, label); return; }
						staged = null;
						state.botStaged = undefined;
						void applyTo(sid, presetId, label, 0);
					},
				},
			});
			state.botEntry = true;
		}
		exports.install = install;
		exports.__test = { MODE_IDS, ROW_NAME, PERSONA_ROUTE, botNoticeStore, retryable, personaRequest: (sid, presetId) => ({ sessionId: String(sid || ""), presetId: String(presetId || "") }) };
		return module.exports;
	}
});
