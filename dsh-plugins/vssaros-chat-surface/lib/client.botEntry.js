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
					const m = /[?&]token=([^&]+)/.exec((typeof location !== "undefined" && location.search) || "");
					return m ? decodeURIComponent(m[1]) : "";
				} catch { return ""; }
			};

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

			/** 切人格的请求体（只换人格、当前会话继续）。 */
			const personaRequest = (sid, presetId) => ({ sessionId: String(sid || ""), presetId: String(presetId || "") });

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
						const sid = args && args.sessionId;
						const presetId = opt && opt.id;
						if (!presetId) { return; }
						const url = "/x/agents/api/persona";
						const headers = { "content-type": "application/json", accept: "application/json" };
						const token = authToken();
						if (token) { headers.authorization = "Bearer " + token; }
						fetch(url, {
							method: "POST",
							headers,
							body: JSON.stringify(personaRequest(sid, presetId)),
						}).then((r) => {
							state.botEntrySwitch = { status: r.status, presetId };
							if (!r.ok) { state.botEntryError = "HTTP " + r.status; }
						}).catch((e) => { state.botEntryError = String((e && e.message) || e); });
					},
				},
			});
			state.botEntry = true;
		}
		exports.install = install;
		exports.__test = { MODE_IDS, ROW_NAME, personaRequest: (sid, presetId) => ({ sessionId: String(sid || ""), presetId: String(presetId || "") }) };
		return module.exports;
	}
});
