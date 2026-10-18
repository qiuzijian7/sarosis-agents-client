// @vssaros/dsh-chat-surface — Agent(preset) 切换 chip（方案 5.15）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.preset.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.preset.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		/**
		 * ⚠ 2026-10-16：本组件**不再**在 hero 里并排渲染"工作区/worktree"入口 ——
		 * 用户报「工作区 UI 重复了（hero 行里两枚都在说工作区）」，拍板方案 A
		 * （mockup `doc/dsh-workspace-entry-single-mockup.html`）：hero 仍只出**官方那枚** WorkspaceChip，
		 * 我们把自己的合并面板挂到 `conversation.hero.workspace` 槽上（`priority: -10` 遮蔽官方浮层）✓。
		 * ⇒ 从前那条"跨 chunk 传组件"的通道（`shell.heroWorktreeChip` + `WORKTREE_CHIP_EVENT`）**已作废**：
		 *   面板由**槽**渲染，不需要谁来传；本文件只剩 preset chip 这一件事 ✓。
		 */
		/**
		 * 安装本部件：注册 slot / 注入样式。ctx = 插件上下文；shell = 入口侧共享状态
		 * （bridge / state / sessionId / mark / rebind）。段内代码与拆分前逐字一致。
		 */
		function install(ctx, shell) {
			const state = shell.state, bridge = shell.bridge, sessionId = shell.sessionId, rebind = shell.rebind;
				// ── Agent（preset）切换 chip（方案 5.15）─────────────────────────
				// **只在 hero 区常驻**（空白会话屏）。2026-10-11 方案 B 评审：会话头部那枚被**移除**
				// （理由与去处见本文件末尾），因为头部只保留「上下文（左）+ 动作（右）」两组。
				// 切换统一走页面桥 switchPreset → 宿主 rebind 到该 preset 的专属会话
				// （各自历史独立，切回可见原对话）；不用 dsh 官方空白热切换（理由见 pick()）。
				/** 菜单互斥用 id（见 client.js 的 createMenuCoordinator）。 */
				const MENU_ID = "vssaros-preset";
				const readSummary = (sid) => {
					try {
						const list = ctx.sessions && ctx.sessions.list;
						const snap = list && list.getSnapshot();
						return sid && snap && snap.byId ? snap.byId[sid] : undefined;
					} catch { return undefined; }
				};
				const presetName = (p) => (p && (p.name || p.id)) || "";
				function PresetChip(props) {
					const sid = props && props.sessionId ? props.sessionId : state.sessionId;
					const [roster, setRoster] = react.useState(null);
					const [openMenu, setOpenMenu] = react.useState(false);
					const [busy, setBusy] = react.useState(false);
					const [err, setErr] = react.useState(null);
					const rootRef = react.useRef(null);
					react.useEffect(() => {
						let dead = false;
						const load = () => {
							if (!ctx.remote || !ctx.remote.agentPresets) {
								state.presetRosterError = "remote.agentPresets unavailable (has remote: " + !!ctx.remote + ")";
								return;
							}
							Promise.resolve(ctx.remote.agentPresets.list()).then((r) => {
								if (dead) { return; }
								if (r && r.ok && r.value && Array.isArray(r.value.presets)) {
									const usable = r.value.presets.filter((p) => p && p.id && !p.broken);
									state.presetRoster = usable.length;
									setRoster(usable);
								} else {
									state.presetRosterError = "list not ok: " + JSON.stringify(r && r.error ? r.error : r).slice(0, 200);
								}
							}).catch((e) => { state.presetRosterError = String((e && e.message) || e); });
						};
						load();
						return () => { dead = true; };
					}, []);
					react.useEffect(() => {
						if (!openMenu) { return; }
						const close = (ev) => {
							if (rootRef.current && ev.target && rootRef.current.contains(ev.target)) { return; }
							setOpenMenu(false);
						};
						const esc = (ev) => { if (ev.key === "Escape") { setOpenMenu(false); } };
						document.addEventListener("mousedown", close, true);
						document.addEventListener("keydown", esc, true);
						return () => {
							document.removeEventListener("mousedown", close, true);
							document.removeEventListener("keydown", esc, true);
						};
					}, [openMenu]);
					// 菜单互斥（同 client.workspace.js：多菜单叠加时被裁的部分也像"被遮挡"）。
					react.useEffect(() => {
						if (!openMenu || !shell.menus) { return; }
						shell.menus.closeOthers(MENU_ID);
						return shell.menus.register(MENU_ID, () => setOpenMenu(false));
					}, [openMenu]);
					// ── 2026-10-16：hero 里的"工作区 / worktree"入口**已不在这里** ─────────────────
					// 用户报「工作区 UI 重复了，使用一个即可，但要有 add workspace」⇒ 方案 A（顶部常量注释）：
					// hero 行的三个位置是官方写死的（`heroWorkspaceRow`）＝ `[官方 WorkspaceChip][hero.workspace 浮层][hero.agentPreset]`，
					// 我们从前在最后那一格里**又**放了一枚"工作区 + worktree"入口 ⇒ 与官方那枚重复 ✗。
					// 现在：hero 仍只有**官方那枚 chip**，面板由 `client.workspace.js` 注册到 `conversation.hero.workspace`
					// （priority -10 遮蔽官方浮层）⇒ 本组件只负责 preset chip ✓，视觉顺序 `[工作区][preset]` ✓。
					if (!roster || roster.length === 0) {
						return null;
					}
					const summary = readSummary(sid);
					const current = (summary && summary.projectionValues && summary.projectionValues.agentPreset)
						|| (roster.find((p) => p.isDefault) || roster[0]).id;
					const currentName = presetName(roster.find((p) => p.id === current)) || current;
					const pick = (id) => {
						setOpenMenu(false);
						if (id === current || busy) { return; }
						// 统一语义（方案 5.15.1）：不论空白与否都经宿主 rebind 到该 preset 的专属会话。
						// 不走 dsh 官方空白热切换（select）——否则 "--ptc" 派生会话会被热改成别的
						// preset，"会话 id 后缀 = preset" 的确定性被打破，"切回基座" 会撞上 Host 的
						// ApiSessionPresetConflict。基座 preset 由宿主解析回无后缀会话（历史保留）。
						if (!bridge || !bridge.switchPreset) {
							setErr("page bridge too old (switchPreset unavailable)");
							state.lastPresetError = "bridge-too-old";
							return;
						}
						setBusy(true);
						setErr(null);
						bridge.switchPreset(id).then(() => {
							setBusy(false);
							state.presetSwitches++;
						}, (e2) => {
							setBusy(false);
							const f = String((e2 && e2.message) || e2);
							setErr(f);
							state.lastPresetError = f;
						});
					};
					const children = [
						// 只剩 preset 一枚（2026-10-16 方案 A：工作区/worktree 入口不再由本组件渲染，见上方注释 ✓）
						react.createElement("button", {
							key: "b",
							type: "button",
							"data-vssaros-preset-chip": "1",
							"aria-haspopup": "menu",
							"aria-expanded": openMenu,
							disabled: busy,
							title: err || "切换 Agent（preset）",
							onClick: () => setOpenMenu(!openMenu),
							style: {
								display: "inline-flex", alignItems: "center", gap: 4,
								padding: "1px 8px", borderRadius: 999, cursor: busy ? "default" : "pointer",
								border: "1px solid " + (err ? "var(--dsw-alias-state-error-primary, #f85149)" : "var(--dsw-alias-border-l1, transparent)"),
								background: "var(--dsw-alias-bg-layer-1, transparent)",
								color: "var(--dsw-alias-label-secondary, currentColor)",
								fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
							},
						}, "⬢ " + (busy ? "切换中…" : currentName) + " ▾"),
					];
					if (openMenu) {
						// ── 与 dsh 官方那个 preset 菜单**保持一致**（2026-10-11 用户要求）──────────────
						// 官方 `AgentPresetSeat` 的 `Menu` 是**纯条目**：名称 + 一行描述，没有分组标题、
						// 没有分隔线、没有自加的动作行（`dsh-client-ui-agent-preset/lib/client.js:491-520`）。
						// 所以这里：① 只列 dsh 自带 preset（VsSaros agent 的入口是 `+` 菜单 → Commands → Agents）；
						// ② 去掉原先的「内置 / 我的 Agent」分组标题与底部"管理 Agent…（VsSaros Agent Studio）"。
						const BUILTIN_PRESET_IDS = ["standard", "ptc", "minimal", "cordis"];
						const isBuiltin = (id) => BUILTIN_PRESET_IDS.indexOf(id) >= 0;
						const builtins = roster.filter((p) => isBuiltin(p.id));
						const itemStyle = (p) => ({
							display: "flex", alignItems: "flex-start", gap: 8,
							width: "100%", padding: "6px 8px", border: "none", borderRadius: 7, cursor: "pointer",
							background: p.id === current ? "var(--dsw-alias-bg-layer-2, transparent)" : "transparent",
							color: "var(--dsw-alias-label-primary, currentColor)",
							fontSize: 12, textAlign: "left",
						});
						const check = (p) => react.createElement("span", {
							key: "c",
							style: { flex: "0 0 14px", width: 14, color: p.id === current ? "var(--dsw-alias-brand-primary, currentColor)" : "transparent" },
						}, "✓");
						const item = (p) => react.createElement("button", {
							key: p.id,
							type: "button",
							role: "menuitem",
							"data-vssaros-preset-item": p.id,
							onClick: () => pick(p.id),
							style: itemStyle(p),
						},
							check(p),
							react.createElement("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
								react.createElement("span", { style: { fontWeight: p.id === current ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, presetName(p)),
								p.description ? react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, String(p.description).slice(0, 48)) : null));
						// 纯条目列表（与官方一致）：无分组标题、无分隔线、无自加动作行。
						const rows = [];
						for (const p of builtins) { rows.push(item(p)); }
						children.push(react.createElement("div", {
							key: "m",
							role: "menu",
							// 尺寸夹在页面视口内（超出 WebContentsView 矩形会被裁掉 ⇒ 露出后面的编辑器）。
							// ⚠ 锚点方向：本 chip 在**输入框左侧**（hero 那枚）⇒ 菜单必须**向右**展开。
							// 写 `right: 0`（上一版）会让菜单从 chip 左边缘**向左**展开、越过聊天视图左边缘被裁，
							// 只剩每个条目的尾巴（2026-10-11 用户截图：`dard` / `imal` / `dis` 其实是
							// standard / minimal / cordis 被裁后的残余）—— 与工作区 chip 那次是同一类错 ✗。
							style: Object.assign({
								position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 1000,
								padding: 5, borderRadius: 10,
								border: "1px solid var(--dsw-alias-border-l1, transparent)",
								background: "var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))",
								boxShadow: "0 8px 24px rgba(0,0,0,.35)",
								// ⚠ 触发器矩形也要交出去（本 chip 在输入框上方、页面中部）：只按"整页 − 72"算
								//   ⇒ 面板底部落到视口外、下半截滚不到 ✗（2026-10-16 用户报障，见 client.js 注释）。
							}, shell.fitMenu ? shell.fitMenu(rootRef.current ? rootRef.current.getBoundingClientRect() : null) : {}),
						}, ...rows));
					}
					// 容器现在只装 preset 一枚（工作区/worktree 入口已交给 `conversation.hero.workspace` 的面板 ✓）；
					// `gap: 6` 保留无副作用（该槽里若日后又并排出现东西，间距已经在位 ✓）。
					return react.createElement("span", { ref: rootRef, style: { position: "relative", display: "inline-flex", alignItems: "center", gap: 6 } }, ...children);
				}
				// ── 会话头部那枚 preset chip：**已按用户要求移除**（2026-10-11 方案 B 定稿）──────────
				// 头部只保留「上下文（左：🗂 工作区）+ 动作（右：＋/🕘/⚙）」两组，preset 切换器不再占位。
				// 当前只剩下面 hero 区这一枚入口（空白会话屏 = 新建对话时）。若以后要"有消息的会话里
				// 也能切 preset"，正确做法是并进 ⚙ 菜单（一个聚合入口），不要把 chip 加回 header。
				//
				// hero 区（空白会话屏无会话头部）：负优先级遮蔽官方 chip —— 官方走空白热切换，
				// 会把基座/派生会话热改成别的 preset，破坏"会话 id 后缀 = preset"的确定性。
				const HERO_PRESET_SLOT = "conversation.hero.agentPreset";
				try {
					ctx.slots.inject(HERO_PRESET_SLOT, () =>
						ctx.slots.register({ name: HERO_PRESET_SLOT, id: "vssaros-preset-chip-hero", priority: -10 }, PresetChip));
					state.presetHero = true;
				} catch (e) {
					state.error = String((e && e.message) || e);
				}
				// ── ③ 官方**只读** preset 标签：**改由 `client.agents.js` 接管渲染**（2026-10-11）──────
				// 需求演变（三次）：遮蔽（"头部别冒出不可点的 standard 文本"）→ 放开（"切 preset 要显示
				// 对应标签"）→ 发现官方标签会把 VsSaros agent 的 `name`（= **agent 名**）也印出来（用户要求
				// 不要），而官方标签没有"哪些 preset 才显示"的开关 ⇒ 改为**接管**并在组件内条件渲染：
				//   `conversation.session.header.actions` / id `agent-preset` / priority -1 的
				//   `PresetHeaderLabel`（在 client.agents.js，与输入框那枚 AgentChip 互补）。
				// 本文件**不再注册该槽位的任何东西**（免得两处抢同一格）。
		}
		exports.install = install;
		return module.exports;
	}
});
