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
		function install(ctx, shell) {
			const state = shell.state;
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
					const children = [
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
							style: Object.assign({
								position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 1000,
								padding: 5, borderRadius: 10,
								border: "1px solid var(--dsw-alias-border-l1, transparent)",
								background: "var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))",
								boxShadow: "0 8px 24px rgba(0,0,0,.35)",
							}, shell.fitMenu ? shell.fitMenu() : {}),
						},
							react.createElement("div", { style: { fontSize: 10.5, letterSpacing: ".03em", color: "var(--dsw-alias-label-secondary, currentColor)", padding: "6px 8px 3px" } }, "聊天框设置"),
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
