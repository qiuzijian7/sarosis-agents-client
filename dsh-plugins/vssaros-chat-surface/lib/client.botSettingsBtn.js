// @vssaros/dsh-chat-surface — 聊天框右上角「Bot 设置」按钮（2026-11-02，Bots 工作台重构第 2 步）
//
// 槽：`conversation.session.header.utilities`（右侧动作组，官方 `[＋][🕘][⚙]` 那一排）。
//   order **-1** ⇒ 落在我们自己的聊天框设置（`vssaros-settings`，-2）与官方 `…`（0）之间。
//   ⚠ 官方「打开/收起右侧栏」在 `conversation.session.header.corner`（更右一格）⇒ 本按钮**不会**压住它。
//
// 可见性：只在**当前会话跑的是我们的 agent** 时出现（`vssaros-<id>`，且不是 4 个模式 preset）——
//   与 `client.capsule.js` / `client.agents.js` 的判据一致（三处同口径，别各写一套）✓。
//
// 点击语义（用户 2026-11-02 拍板 Q4-A = **开关**）：
//   · 右侧栏没收起、也不在设置页 ⇒ 撑开并选中「Bot 设置」页签；
//   · 已经在设置页 ⇒ 收起整根右侧栏（点官方 toggle）；
//   · 其余 ⇒ 撑开 + 选中设置页。
//
// ── 跨 chunk 契约（与 `@vssaros/dsh-agents` 的 client.botSettings.js 逐字一致）──
//   `window.__vssarosBotSettings = { id, name }` + `dispatchEvent(new CustomEvent("vssaros-bot-settings-target"))`
//   两个 chunk 同页同 JS 上下文但不能互相 require ⇒ 全局 + 事件是唯一零协议通道。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.botSettingsBtn.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "conversation.session.header.utilities";
		const ENTRY_ID = "vssaros-bot-settings-btn";
		/** 与 agents 插件的页签 id 逐字一致（守卫比对两处字面量）。 */
		const TAB_ID = "vssaros-bot-settings";
		const TARGET_GLOBAL = "__vssarosBotSettings";
		const TARGET_EVENT = "vssaros-bot-settings-target";
		const VSSAROS_PREFIX = "vssaros-";
		const MODE_PRESETS = ["standard", "ptc", "minimal", "cordis"];
		const PANEL_SELECTOR = "[data-vssaros-bot-settings]";

		/** 跑的是不是**我们的 agent**（判据与 client.capsule.js 同口径）。 */
		function isAgentPreset(presetId) {
			const id = String(presetId || "");
			return id.startsWith(VSSAROS_PREFIX) && MODE_PRESETS.indexOf(id.slice(VSSAROS_PREFIX.length)) < 0;
		}

		function install(ctx, shell) {
			const state = (shell && shell.state) || {};
			const bridge = shell && shell.bridge;
			const say = (text) => { try { if (bridge && bridge.notify) { bridge.notify("attention", text); } } catch { /* 通知失败不阻塞 */ } };
			const readSummary = (sid) => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					const snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
					return sid && snap && snap.byId ? snap.byId[sid] : undefined;
				} catch { return undefined; }
			};
			const subscribeSessions = (fn) => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					return list && typeof list.subscribe === "function" ? list.subscribe(fn) : undefined;
				} catch { return undefined; }
			};

			/** 撑开官方右侧栏并选中「Bot 设置」页签；已在设置页 ⇒ 收起（Q4-A 的开关语义）。 */
			const openBotSettings = (agentId) => {
				try {
					window[TARGET_GLOBAL] = { id: String(agentId), name: String(agentId) };
					window.dispatchEvent(new CustomEvent(TARGET_EVENT));
				} catch (e) { say("写不进设置目标：" + String((e && e.message) || e)); }

				// ① 已经在设置页 ⇒ 再点 = 收起整根右栏（用官方 toggle，别自己动布局 ✓）
				const panel = document.querySelector(PANEL_SELECTOR);
				if (panel) {
					const toggle = document.querySelector("[data-sidebar-right-toggle]");
					if (toggle && typeof toggle.click === "function") { toggle.click(); return; }
				}
				// ② 否则：撑开（收起态才有 expand 按钮）→ 开页签
				const openTab = () => {
					try {
						if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === "function") {
							ctx.sidebarRight.openTab(TAB_ID);
							state.vssarosBotSettingsOpened = (state.vssarosBotSettingsOpened || 0) + 1;
							return;
						}
					} catch (e) { say("打开 Bot 设置失败：" + String((e && e.message) || e)); return; }
					say("当前窗口没有可挂载的会话，右侧栏打不开设置页");
				};
				const expand = document.querySelector("[data-sidebar-right-expand]");
				if (expand && typeof expand.click === "function") {
					expand.click();
					window.setTimeout(openTab, 180);
				} else {
					openTab();
				}
			};

			function BotSettingsButton(props) {
				const sid = (props && props.sessionId) || state.sessionId;
				const [, force] = react.useState(0);
				react.useEffect(() => subscribeSessions(() => force((n) => n + 1)), []);
				const summary = readSummary(sid);
				const presetId = summary && summary.projectionValues && summary.projectionValues.agentPreset;
				if (!sid || !isAgentPreset(presetId)) { return null; }
				const agentId = String(presetId).slice(VSSAROS_PREFIX.length);
				return react.createElement("button", {
					type: "button",
					"data-vssaros-bot-settings-btn": agentId,
					"aria-label": "Bot 设置",
					title: "Bot 设置（在右侧栏打开）：" + agentId,
					onClick: () => openBotSettings(agentId),
					style: {
						display: "inline-flex", alignItems: "center", gap: 4,
						padding: "1px 8px", borderRadius: 999, cursor: "pointer",
						border: "1px solid var(--dsw-alias-border-l1, transparent)",
						background: "var(--dsw-alias-bg-layer-1, transparent)",
						color: "var(--dsw-alias-label-secondary, currentColor)",
						fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
					},
				}, "Bot ⚙");
			}

			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: -1 }, BotSettingsButton));
				state.vssarosBotSettingsBtn = true;
			} catch (e) {
				state.vssarosBotSettingsBtnError = String((e && e.message) || e);
				try { console.warn("[vssaros] Bot 设置按钮挂载失败：" + state.vssarosBotSettingsBtnError); } catch { /* 无 console */ }
			}
		}

		exports.install = install;
		// 仅测试用：判据 / 契约常量（守卫直接断言）
		exports.__test = { isAgentPreset, TAB_ID, SLOT, ENTRY_ID, TARGET_GLOBAL, TARGET_EVENT };
		return module.exports;
	}
});
