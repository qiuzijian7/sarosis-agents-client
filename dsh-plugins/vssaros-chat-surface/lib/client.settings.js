// @vssaros/dsh-chat-surface — 聊天框设置入口（conversation.session.header.utilities）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.settings.js") 取回本模块的 install()。
//
// 为什么是"并列 chip"而不是"塞进官方 `…`"：
//   官方 `…` 菜单**没有槽位**（由 dsh-client-ui-conversation 自己渲染），无法往里注册条目。
//   而 header 的 actions / utilities 都是 list 槽（官方自己就往 actions 注册并列 chip，
//   例：dsh-client-ui-agent-preset 的 AgentPresetLabel，id="agent-preset"、order=-10）——
//   我们沿用这个官方做法：注册一个齿轮 chip + 自己的菜单，语义等价且不依赖脆弱 DOM 手术。
//
// ⚠ 槽位调整（2026-10-11 方案 B 定稿）：本 chip 从 `actions` 换到 `utilities`。头部布局改为
//   「上下文在左（🗂 工作区占 actions，见 client.workspace.js）+ 动作在右（＋/🕘/⚙ 占 utilities）」。
//   依据是官方 CSS（`dsh-client-ui-conversation/lib/client.js:15811-15827`）：
//   `.titleCluster{flex:1}` 里先是 crumbs（已被皮肤层隐藏）再是 actions，而 `.headerUtilities`
//   靠 `margin-left:20px` + titleCluster 的 flex:1 被推到最右 ⇒ **换槽即换位**（无需 CSS 手术）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.settings.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		// 本地 Agent 引擎徽标：与 vssaros-local-agents/lib/core/badge.js 同形（chunk realm 只允许 require("react")）。
		// check-local-agent-badge.mjs 静态对账三份映射，改一处必须同步改另两处。
		const LOCAL_AGENT_BADGES = { "vssaros-codex-cli": "Codex CLI", "vssaros-claude-code": "Claude Code", "vssaros-opencode": "OpenCode", "vssaros-kimi-cli": "Kimi CLI", "vssaros-hermes-cli": "Hermes Agent", "vssaros-gemini-cli": "Gemini CLI" };
		const localAgentBadgeOf = (text) => {
			const value = String(text == null ? "" : text).trim().toLowerCase();
			if (value.indexOf("vssaros-") !== 0) { return undefined; }
			const route = value.split("/")[0];
			if (Object.prototype.hasOwnProperty.call(LOCAL_AGENT_BADGES, route)) { return LOCAL_AGENT_BADGES[route]; }
			return route.indexOf("vssaros-acp-") === 0 ? "自定义 ACP Agent" : undefined;
		};
		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
				const UTILITIES_SLOT = "conversation.session.header.utilities";
				/** 菜单互斥用 id（见 client.js 的 createMenuCoordinator）。 */
				const MENU_ID = "vssaros-settings";
				// ── 真实可用的设置项（其余不伪造入口）───────────────────────────────
				// 1) 换皮开关：直接禁用/启用我们注入的皮肤样式表（style[data-vssaros-skin]）。
				//    `media="not all"` 是关掉整张表的无损做法（不动其它部件、可瞬时还原）。
				const skinOn = () => {
					const tag = document.querySelector('style[data-vssaros-skin]');
					return !!tag && tag.media !== "not all";
				};
				const setSkin = (on) => {
					const tag = document.querySelector('style[data-vssaros-skin]');
					if (tag) { tag.media = on ? "" : "not all"; }
					state.skinEnabled = on;
				};
				// 2) 用量页脚显示开关：根元素数据属性 + 皮肤层里的一条规则（见 client.skin.js）。
				const usageOn = () => document.documentElement.dataset.vssarosHideUsage !== "1";
				const setUsage = (on) => {
					if (on) { delete document.documentElement.dataset.vssarosHideUsage; }
					else { document.documentElement.dataset.vssarosHideUsage = "1"; }
					state.usageFooterVisible = on;
				};
				// 3) 导出对话：把消息流正文复制成 Markdown（只读 DOM，不碰会话数据）。
				const exportChat = () => {
					const root = document.querySelector("[data-chat-flow]") || document.body;
					const text = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
					if (!text) { return Promise.reject(new Error("没有可导出的内容")); }
					return navigator.clipboard.writeText("# dsh 会话导出\n\n" + text);
				};
				function SettingsChip() {
					const [open, setOpen] = react.useState(false);
					const [tick, setTick] = react.useState(0);
					const [note, setNote] = react.useState(null);
					// 重命名会话（页面侧入口）：行内输入框，避免再依赖宿主 quick input（后者还需探查）。
					const [renaming, setRenaming] = react.useState(false);
					const [draft, setDraft] = react.useState("");
					const [componentsOpen, setComponentsOpen] = react.useState(false);
					const [components, setComponents] = react.useState([]);
					const [componentsError, setComponentsError] = react.useState(null);
					const rootRef = react.useRef(null);
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
					// 菜单互斥（同 client.workspace.js：多菜单叠加时被裁的部分也像"被遮挡"）。
					react.useEffect(() => {
						if (!open || !shell.menus) { return; }
						shell.menus.closeOthers(MENU_ID);
						return shell.menus.register(MENU_ID, () => setOpen(false));
					}, [open]);
					const loadComponents = () => {
						if (!bridge || typeof bridge.componentsStatus !== "function") {
							setComponentsError("当前宿主不支持组件管理（需要页面桥 29+）");
							return Promise.resolve();
						}
						return Promise.resolve(bridge.componentsStatus()).then(
							(list) => { setComponents(Array.isArray(list) ? list : []); setComponentsError(null); },
							(e) => setComponentsError(String((e && e.message) || e)));
					};
					// 打开面板后轮询状态；安装是后台长任务，不能让菜单阻塞等待。
					react.useEffect(() => {
						if (!componentsOpen) { return; }
						let stopped = false;
						const refresh = () => { if (!stopped) { void loadComponents(); } };
						refresh();
						const timer = setInterval(refresh, 1200);
						return () => { stopped = true; clearInterval(timer); };
					}, [componentsOpen]);
					const installComponent = (id, allowElevation) => {
						if (!bridge || typeof bridge.installComponent !== "function") {
							setComponentsError("当前宿主不支持组件安装（需要页面桥 29+）");
							return;
						}
						setComponentsError(null);
						Promise.resolve(bridge.installComponent(id, allowElevation === true)).then(
							(list) => { setComponents(Array.isArray(list) ? list : []); },
							(e) => setComponentsError(String((e && e.message) || e)));
					};
					const componentLabel = (item) => {
						const value = item && item.state;
						if (value === "ready") { return "已安装"; }
						if (value === "bundled") { return "随包可用"; }
						if (value === "installing") { return "安装中"; }
						if (value === "error") { return "安装失败"; }
						if (value === "needs-consent") { return "需要管理员授权"; }
						if (value === "unavailable") { return "服务器不可用"; }
						return "未安装";
					};
					const rerender = () => setTick(tick + 1);
					// 提交重命名：复用 client.sessionLabel.js 暴露的同一份实现
					// （内部调 ctx.sessions.rename + 成功后上报宿主 ⇒ 外层编辑器页签跟随更新）。
					// 不可用时明确提示，失败把原因显示在菜单里——不静默。
					const commit = () => {
						const fn = state.renameSession;
						if (typeof fn !== "function") {
							setRenaming(false); setNote("重命名不可用（rename 部件未装载）"); rerender(); return;
						}
						fn(state.sessionId, draft).then(
							() => { setRenaming(false); setNote("已重命名"); rerender(); },
							(e) => { setNote(String((e && e.message) || e)); rerender(); });
					};
					const ITEM = {
						display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 8px",
						border: "none", borderRadius: 7, cursor: "pointer", textAlign: "left",
						background: "transparent", color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 12,
					};
					const row = (key, label, hint, on, onClick) => react.createElement("button", {
						key, type: "button", role: "menuitem", "data-vssaros-setting": key,
						onClick, style: ITEM,
					},
						react.createElement("span", { style: { flex: "0 0 14px", width: 14, color: on ? "var(--dsw-alias-brand-primary, currentColor)" : "transparent" } }, "✓"),
						react.createElement("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
							react.createElement("span", null, label),
							hint ? react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)" } }, hint) : null));
					// 当前会话的模型选择投影 → 本地 Agent 引擎徽标。读不到就**不画**（不猜、不误标）。
						const engineBadge = (() => {
							try {
								const sid = state && state.sessionId;
								const snap = ctx && ctx.sessions && ctx.sessions.list && ctx.sessions.list.getSnapshot
									? ctx.sessions.list.getSnapshot() : undefined;
								const summary = sid && snap && snap.byId ? snap.byId[sid] : undefined;
								const pv = summary && summary.projectionValues ? summary.projectionValues : {};
								const sel = pv.modelSelection || pv["model-selection"] || {};
								const picked = sel.selected || sel;
								return localAgentBadgeOf(picked.provider) || localAgentBadgeOf(picked.model) || localAgentBadgeOf(pv.model);
							} catch { return undefined; }
						})();
						const children = [
							engineBadge ? react.createElement("span", {
								key: "local-agent-badge", "data-vssaros-local-agent-badge": "1",
								title: "本会话使用本地 Agent 引擎（CLI 自带登录与套餐）",
								style: {
									display: "inline-flex", alignItems: "center", padding: "1px 8px",
									borderRadius: 999, fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
									border: "1px solid var(--dsw-alias-border-l1, transparent)",
									background: "var(--dsw-alias-bg-layer-1, transparent)",
									color: "var(--dsw-alias-label-secondary, currentColor)",
								},
							}, "⌘ " + engineBadge) : null,
						react.createElement("button", {
							key: "chip", type: "button", "data-vssaros-settings-chip": "1",
							"aria-haspopup": "menu", "aria-expanded": open,
							title: "聊天框设置（VsSaros chat-surface）",
							onClick: () => setOpen(!open),
							style: {
								display: "inline-flex", alignItems: "center", gap: 4,
								padding: "1px 8px", borderRadius: 999, cursor: "pointer",
								border: "1px solid var(--dsw-alias-border-l1, transparent)",
								background: "var(--dsw-alias-bg-layer-1, transparent)",
								color: "var(--dsw-alias-label-secondary, currentColor)",
								fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
							},
						}, "⚙ ▾"),
					];
					if (open) {
						children.push(react.createElement("div", {
							key: "menu", role: "menu",
							// 尺寸夹在页面视口内（超出 WebContentsView 矩形会被裁掉 ⇒ 露出后面的编辑器）。
							// ⚠ 还要把**触发器矩形**交给 fitMenu：只按"整页 − 72"算 ⇒ 面板底部落到视口外、
							//   下半截（含底部动作行）**既看不到也滚不到** ✗（2026-10-16 用户报障，见 client.js 的注释）。
							style: Object.assign({
								position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 1000,
								padding: 5, borderRadius: 10,
								border: "1px solid var(--dsw-alias-border-l1, transparent)",
								background: "linear-gradient(var(--dsw-alias-bg-layer-1, transparent), var(--dsw-alias-bg-layer-1, transparent)), var(--dsw-alias-bg-base, #1e1e1e)",
								boxShadow: "0 8px 24px rgba(0,0,0,.35)",
							}, shell.fitMenu ? shell.fitMenu(rootRef.current ? rootRef.current.getBoundingClientRect() : null) : {}),
						},
							react.createElement("div", { style: { fontSize: 10.5, letterSpacing: ".03em", color: "var(--dsw-alias-label-secondary, currentColor)", padding: "6px 8px 3px" } }, "聊天框设置"),
							row("deps", "依赖与组件…", "官方媒体 / 随包 Office / HuggingFace Whisper", false,
								() => { setOpen(false); setComponentsOpen(true); }),
							row("skin", "换皮样式", skinOn() ? "已开启（品牌标/工具卡/皮肤规则）" : "已关闭（回到 dsh 官方外观）", skinOn(),
								() => { setSkin(!skinOn()); rerender(); }),
							row("usage", "用量页脚", usageOn() ? "助手气泡底部显示 耗时/tokens/积分" : "已隐藏", usageOn(),
								() => { setUsage(!usageOn()); rerender(); }),

							react.createElement("div", { key: "sep", style: { height: 1, margin: "5px 4px", background: "var(--dsw-alias-border-l1, transparent)" } }),
							row("export", "导出对话到剪贴板", "把当前消息流正文复制为 Markdown", false,
								() => { exportChat().then(() => { setNote("已复制到剪贴板"); rerender(); }, (e) => { setNote(String((e && e.message) || e)); rerender(); }); }),
							// 重命名会话（页面侧入口，立即可用）：走 client.sessionLabel.js 暴露的同一份 rename,
							// 它内部调 dsh 的 `ctx.sessions.rename` 并把新标题上报宿主 ⇒ 外层编辑器页签跟随更新。
							renaming
								? react.createElement("div", {
									key: "renameInput",
									style: { display: "flex", gap: 6, alignItems: "center", padding: "2px 8px 6px" },
								},
									react.createElement("input", {
										key: "in", autoFocus: true, value: draft, placeholder: "新会话名",
										onChange: (e) => setDraft(e.target.value),
										onKeyDown: (e) => { if (e.key === "Enter") { commit(); } else if (e.key === "Escape") { setRenaming(false); } },
										style: {
											flex: "1 1 auto", minWidth: 0, padding: "4px 6px", borderRadius: 6, fontSize: 12,
											background: "var(--dsw-alias-bg-base, transparent)", color: "inherit",
											border: "1px solid var(--dsw-alias-border-l1, transparent)",
										},
									}),
									react.createElement("button", { key: "ok", type: "button", onClick: commit, style: { ...ITEM, width: "auto" } }, "确定"))
								: row("rename", "重命名会话…", "改的是 dsh 会话标题，外层页签会跟随", false,
									() => { setDraft(state.sessionTitle || ""); setRenaming(true); setNote(null); }),
							// 以下是**尚未接通**的项：如实标注，不做假入口（需要新桥命令才做）。
							// 注：会话重命名已在本菜单内（上方行）；「历史会话 / 新建会话」已提到 header
							// 右侧（client.sessions.js 的两个按钮），不再藏在本菜单里。
							react.createElement("div", {
								key: "todo",
								style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "4px 8px 6px", lineHeight: "16px" },
							}, "Model Providers / 归档：需新增桥命令（页面 → 宿主），待接。"),
							note ? react.createElement("div", {
								key: "note",
								style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "2px 8px 6px" },
							}, note) : null));
					}
					if (componentsOpen) {
						const dependencyRows = components.length ? components : [{
							id: "loading", label: "正在检测组件…", state: "missing", progress: 0,
						}];
						children.push(react.createElement("div", {
							key: "components-overlay",
							role: "presentation",
							onMouseDown: (e) => { if (e.target === e.currentTarget) { setComponentsOpen(false); } },
							style: {
								position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center",
								justifyContent: "center", padding: 16, background: "rgba(15,23,42,.46)",
							},
						},
							react.createElement("div", {
								role: "dialog", "aria-modal": "true", "aria-label": "依赖与组件",
								onMouseDown: (e) => e.stopPropagation(),
								style: {
									width: "min(560px, calc(100vw - 32px))", maxHeight: "min(80vh, 680px)", overflow: "auto",
									borderRadius: 14, padding: 16, background: "var(--dsw-alias-bg-layer-1, #fff)",
									color: "var(--dsw-alias-label-primary, currentColor)",
									border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))",
									boxShadow: "0 20px 60px rgba(0,0,0,.28)",
								},
							},
								react.createElement("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12 } },
									react.createElement("div", null,
										react.createElement("div", { style: { fontSize: 16, fontWeight: 700 } }, "依赖与组件"),
										react.createElement("div", { style: { fontSize: 11.5, lineHeight: 1.5, opacity: .72, marginTop: 3 } }, "媒体走官方包管理器；Office 随安装包分发；本地语音模型从 HuggingFace 官方源下载。安装后仍可在这里重试。")),
									react.createElement("button", {
										type: "button", onClick: () => setComponentsOpen(false),
										"aria-label": "关闭依赖与组件",
										style: { ...ITEM, width: "auto", padding: "4px 8px", border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))", cursor: "pointer" },
									}, "关闭")),
								componentsError ? react.createElement("div", {
									role: "alert",
									style: { fontSize: 11.5, lineHeight: 1.5, marginBottom: 10, padding: "7px 9px", borderRadius: 8, color: "#b91c1c", background: "rgba(239,68,68,.1)" },
								}, componentsError) : null,
								react.createElement("div", { style: { display: "grid", gap: 8 } },
									dependencyRows.map((item) => {
										const stateText = componentLabel(item);
										const installing = item.state === "installing";
										const done = item.state === "ready" || item.state === "bundled";
										const unavailable = item.state === "unavailable";
										const progress = Math.max(0, Math.min(100, Number(item.progress) || 0));
										const size = Number(item.size) > 0 ? `${(Number(item.size) / 1024 / 1024).toFixed(1)} MiB` : "";
										return react.createElement("div", {
											key: item.id, "data-vssaros-component": item.id,
											style: {
												padding: "10px 11px", borderRadius: 10,
												border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))",
												background: "var(--dsw-alias-bg-base, rgba(127,127,127,.04))",
											},
										},
											react.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 } },
												react.createElement("div", { style: { minWidth: 0 } },
													react.createElement("div", { style: { fontSize: 12.5, fontWeight: 650 } }, item.label || item.id),
													react.createElement("div", { style: { fontSize: 10.5, opacity: .72, marginTop: 2 } },
														`${stateText}${size ? ` · ${size}` : ""}${item.version ? ` · ${item.version}` : ""}${item.source ? ` · ${item.source}` : ""}`)),
												react.createElement("button", {
													type: "button", disabled: installing || done || unavailable || item.id === "loading",
													onClick: () => installComponent(item.id, item.state === "needs-consent"),
													style: {
														...ITEM, width: "auto", flex: "0 0 auto", padding: "5px 10px",
														border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))",
														cursor: installing || done || unavailable || item.id === "loading" ? "default" : "pointer",
														opacity: installing || done || unavailable ? .65 : 1,
													},
													}, installing ? "安装中…" : done ? (item.state === "bundled" ? "随包可用" : "已安装") : unavailable ? "源不可用" : item.state === "needs-consent" ? "授权安装" : "安装")),
											installing || item.state === "error" ? react.createElement("div", { style: { marginTop: 8 } },
												react.createElement("div", { style: { height: 4, borderRadius: 999, overflow: "hidden", background: "rgba(127,127,127,.18)" } },
													react.createElement("div", { style: { width: `${progress}%`, height: "100%", background: item.state === "error" ? "#dc2626" : "var(--dsw-alias-brand-primary, #4f46e5)", transition: "width .2s ease" } }))) : null,
											item.error ? react.createElement("div", { role: "alert", style: { marginTop: 5, fontSize: 10.5, lineHeight: 1.45, color: "#b91c1c" } }, item.error) : null);
									})),
								react.createElement("div", { style: { marginTop: 11, fontSize: 10.5, lineHeight: 1.5, opacity: .68 } }, "下载会校验 SHA256 并原子落盘。媒体工具需要重启 dsh Host 才会进入技能 PATH；Office 随包运行时同样需要重启 Host。"))));
					}
					return react.createElement("span", { ref: rootRef, style: { position: "relative", display: "inline-flex" } }, ...children);
				}
				try {
					// order **-2**：右侧动作组里排最后（目标 `[＋][🕘][⚙]`），且小于官方 `session-log-download`
					// 的默认 0 ⇒ 官方那枚 `…` 落到我们右边（用户要求"三个点的按钮移到最右侧"）。
					ctx.slots.inject(UTILITIES_SLOT, () => ctx.slots.register(
						{ name: UTILITIES_SLOT, id: "vssaros-settings", order: -2 }, SettingsChip));
					state.settingsChip = true;
					setSkin(true);
					setUsage(true);
				} catch (e) {
					state.error = String((e && e.message) || e);
				}
		}
		exports.install = install;
		return module.exports;
	}
});
