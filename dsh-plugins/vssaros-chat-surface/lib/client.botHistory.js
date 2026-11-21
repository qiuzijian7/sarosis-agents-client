// @vssaros/dsh-chat-surface — Bot 聊天框右上角的「聊天历史」（conversation.session.header.utilities）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.botHistory.js") 取回本模块的 install()。
//
// ── 为什么单独一个 ALWAYS chunk（2026-11-11，用户：一个 Bot 可能对应多个会话）─────────
// ① 需求：Bot 聊天框右上角要有一枚「聊天历史」，下拉里**只列当前 Bot 的历史会话**并可切换。
//    旧的 `client.sessions.js` 那枚「🕘 历史会话」是**全局最近 20 条**（跨 Bot / 跨模式混在一起），
//    且按 preset 只当文本展示 ⇒ 找不到"这个 Bot 之前聊过的会话" ✗。
// ② 为什么不能只改旧 chunk：`client.sessions.js` 在 PART_CHUNKS，而 client.js 的皮肤部件段
//    对 `surface !== "chat"` 直接早退 ⇒ **desktop 主栏（surface=full）一枚 PART chunk 都不装**
//    ⇒ 旧历史按钮在用户截图那个窗口里根本不存在（与 2026-11-11 修 VsSaros 按钮同一个坑）。
//    ⇒ 本 chunk 必须走 ALWAYS_CHUNKS（无条件、跨 surface）。
// ③ 不许出现两枚历史按钮：本按钮**只在 Bot 会话**渲染，`client.sessions.js` 的 SessionsChip
//    在 Bot 会话渲染 null ⇒ 任意 surface 下恰好一枚（非 Bot 会话仍是全局「历史会话」）✓。
//
// ── 归属判据 ────────────────────────────────────────────────────────────────────
// 会话 → Bot 用逐字副本 `sessionBotOf`（真源 vssaros-agents/lib/core/botIdentity.js）：
//   · 有 `vssaros-bot` 身份记录且 presetId 与当前一致 ⇒ 按记录的 botId 归属；
//   · 没有记录 ⇒ 按会话 preset 归属（`vssaros-<agent>` 且非模式 preset 才算 Bot）。
// 与 Host `rowAgentKeyOf` 同语义（多个 Bot 共用一个 preset 时靠身份记录分开）；这里不引 slugify，
// 只用 `id:` / `preset:` 前缀做**页面内两两比较**，不对外暴露 key 字符串。
//
// ── 切换通路 ────────────────────────────────────────────────────────────────────
// 与旧历史菜单同源：`bridge.openSession(id, preset, cwd)` → 宿主 rebind → `vssaros-dsh-rebind`
// → 主包 rebind() → `ctx.uiWorkspace.openSession(sid)`。页面绝不自己切（会与宿主 slot.sessionId 分叉）。
// ★ 带 cwd 是必要的：历史会话可能不在 Host live 集合，preload 的 openSession 注释明说宿主靠它
//   `session.start` 把会话拉活；快照没有 cwd 时传 undefined，行为与旧菜单一致 ✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.botHistory.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "conversation.session.header.utilities";
		const ENTRY_ID = "vssaros-bot-history";
		/** order -1：官方 -10 / -5 / 0、我们 -4 / -3 / -2 ⇒ 唯一空档，落在右上角那一排最右 ✓。 */
		const ENTRY_ORDER = -1;
		const MENU_ID = "vssaros-bot-history";
		const VSSAROS_PREFIX = "vssaros-";
		/** Bot 会话最多列 50 条（菜单自带 maxHeight + 滚动；全局旧菜单仍是 20 条）。 */
		const HISTORY_LIMIT = 50;

		/* vssaros:bot-identity v1 —— 逐字副本，真源 vssaros-agents/lib/core/botIdentity.js（守卫 dsh-plugins/check-bot-identity.mjs） */
		const BOT_MODE_PRESET_IDS = ["standard","ptc","minimal","cordis","vssaros-standard","vssaros-ptc"];
		/** 是不是"可能属于某个 bot"的 preset（vssaros- 前缀且不是模式 preset）。 */
		function isBotPresetId(presetId) {
			const id = String(presetId || "").trim();
			return id.indexOf("vssaros-") === 0 && id.length > 8 && BOT_MODE_PRESET_IDS.indexOf(id) < 0;
		}
		/** 会话属于哪个 bot：身份记录（presetId 与当前一致才采信）> 按 preset 推断（botId=null，调用方用花名册反查）。 */
		function sessionBotOf(projectionValues) {
			const pv = projectionValues || {};
			const presetId = String(pv.agentPreset || "").trim();
			if (!isBotPresetId(presetId)) { return { isBot: false, botId: null, presetId: presetId, source: "none" }; }
			const rec = pv["vssaros-bot"];
			const recBot = rec && typeof rec.botId === "string" ? rec.botId.trim() : "";
			if (recBot && String(rec.presetId || "").trim() === presetId) {
				return { isBot: true, botId: recBot, presetId: presetId, source: "record" };
			}
			return { isBot: true, botId: null, presetId: presetId, source: "preset" };
		}
		/* /vssaros:bot-identity */

		/** 会话归属键（null = 不是 Bot 会话）。只用于同一份快照内两两比较，不跨系统使用。 */
		function botKeyOf(projectionValues) {
			const bot = sessionBotOf(projectionValues);
			if (!bot.isBot) { return null; }
			return bot.botId ? "id:" + bot.botId : "preset:" + bot.presetId;
		}

		/**
		 * 会话快照 → 菜单行。
		 * 当前会话是 Bot ⇒ 只保留同 key 的会话；不是 Bot ⇒ 全局最近若干条（与旧菜单同口径）。
		 * 排序：有 updatedAt/createdAt 按时间倒序（同时间按 id 稳定），全无时间戳时保留快照键序。
		 */
		function historyRows(snapshot, currentSessionId, limit) {
			const byId = (snapshot && snapshot.byId) || {};
			const archived = Array.isArray(snapshot && snapshot.archivedSessionIds) ? snapshot.archivedSessionIds : [];
			const current = byId[currentSessionId] || {};
			const scopedKey = botKeyOf(current.projectionValues || {});
			const rows = [];
			for (const id of Object.keys(byId)) {
				const s = byId[id] || {};
				const pv = s.projectionValues || {};
				if (scopedKey && botKeyOf(pv) !== scopedKey) { continue; }
				rows.push({
					id: id,
					title: typeof s.title === "string" && s.title.trim() ? s.title.trim() : null,
					preset: typeof pv.agentPreset === "string" ? pv.agentPreset : null,
					cwd: typeof s.cwd === "string" && s.cwd.trim() ? s.cwd.trim() : null,
					at: (typeof s.updatedAt === "number" && s.updatedAt) || (typeof s.createdAt === "number" && s.createdAt) || 0,
					archived: archived.indexOf(id) >= 0,
					isCurrent: id === currentSessionId,
				});
			}
			if (rows.some((r) => r.at > 0)) {
				rows.sort((a, b) => (b.at - a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			}
			return { rows: rows.slice(0, typeof limit === "number" ? limit : HISTORY_LIMIT), scopedKey: scopedKey };
		}

		/**
		 * 把菜单夹进视口（纯函数 ⇒ 可单测）。与 `client.capsule.js` 的 fitMenuBox 同口径：
		 * 右缘贴触发器右缘，越左缘就贴左、越右缘往左收；下方不够就上收。
		 * 量不到锚点/视口一律交零值由调用方回落（不猜坐标 ✗）。
		 */
		function fitMenuBox(anchor, size, viewport) {
			const vw = viewport && viewport.vw ? viewport.vw : 0;
			const vh = viewport && viewport.vh ? viewport.vh : 0;
			const w = size && size.w ? size.w : 0;
			const h = size && size.h ? size.h : 0;
			if (!anchor || !vw) { return { left: 0, top: 0 }; }
			let left = anchor.right - w;
			if (left < 8) { left = 8; }
			if (left + w > vw - 8) { left = Math.max(8, vw - 8 - w); }
			let top = anchor.bottom + 4;
			if (vh && top + h > vh - 8) { top = Math.max(8, vh - 8 - h); }
			return { left: Math.round(left), top: Math.round(top) };
		}

		function install(ctx, shell) {
			const state = (shell && shell.state) || {};
			const bridge = (shell && shell.bridge) || null;
			const readSessions = () => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					return list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
				} catch (e) {
					state.botHistoryListError = String((e && e.message) || e);
					return null;
				}
			};
			const readSummary = (sid) => {
				const snap = readSessions();
				return sid && snap && snap.byId ? snap.byId[sid] : undefined;
			};
			/** 会话快照会变（换绑 / 新会话 / 标题）⇒ 订阅后强制重渲染，别让 Bot 判定停在首帧 ✗。 */
			const subscribeSessions = (fn) => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					return list && typeof list.subscribe === "function" ? list.subscribe(fn) : undefined;
				} catch { return undefined; }
			};

			function BotHistoryChip(props) {
				const sid = (props && props.sessionId) || state.sessionId;
				const [, force] = react.useState(0);
				const [open, setOpen] = react.useState(false);
				const [note, setNote] = react.useState(null);
				const [box, setBox] = react.useState(null);
				const rootRef = react.useRef(null);
				const menuRef = react.useRef(null);
				react.useEffect(() => subscribeSessions(() => force((n) => n + 1)), []);
				const summary = readSummary(sid);
				const bot = sessionBotOf(summary && summary.projectionValues);
				const show = !!sid && bot.isBot;
				const data = open ? historyRows(readSessions(), sid, HISTORY_LIMIT) : null;
				const botLabel = bot.botId || String(bot.presetId || "").slice(VSSAROS_PREFIX.length) || "Bot";

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
				// shell.menus 只在 PART 路径有；ALWAYS 路径没有 ⇒ 判空（互斥退化成"点外面/Esc 关闭"）。
				react.useEffect(() => {
					if (!open || !shell.menus) { return; }
					shell.menus.closeOthers(MENU_ID);
					return shell.menus.register(MENU_ID, () => setOpen(false));
				}, [open]);
				// 打开后量一次真实尺寸把菜单夹进视口（首帧用 absolute 兜底，量到即切 fixed）。
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
							const mw = mr && mr.width ? mr.width : 320;
							const mh = mr && mr.height ? mr.height : 160;
							setBox(fitMenuBox({ left: cr.left, right: cr.right, bottom: cr.bottom }, { w: mw, h: mh }, { vw: vw, vh: vh }));
						} catch { /* 量不到就用默认位置，不静默不显示 */ }
					};
					place();
					const t = typeof window !== "undefined" && window.setTimeout ? window.setTimeout(place, 60) : 0;
					return () => { try { if (t && window.clearTimeout) { window.clearTimeout(t); } } catch { /* 忽略 */ } };
				}, [open]);

				/** 失败时**保留菜单**并把原因写在里面（关掉菜单再说 = 用户只看到"点了没反应"✗）。 */
				const openSession = (row) => {
					if (!row || row.isCurrent) { setOpen(false); return; }
					if (!bridge || typeof bridge.openSession !== "function") {
						setNote("页面桥过旧（openSession 不可用）");
						return;
					}
					try {
						Promise.resolve(bridge.openSession(row.id, row.preset || undefined, row.cwd || undefined)).then(
							() => { setOpen(false); state.botHistoryOpens = (state.botHistoryOpens || 0) + 1; },
							(e) => { setNote(String((e && e.message) || e)); });
					} catch (e) {
						setNote(String((e && e.message) || e));
					}
				};

				if (!show) { return null; }
				const BTN = {
					display: "inline-flex", alignItems: "center", gap: 4,
					padding: "1px 8px", borderRadius: 999, cursor: "pointer",
					border: "1px solid var(--dsw-alias-border-l1, transparent)",
					background: "var(--dsw-alias-bg-layer-1, transparent)",
					color: "var(--dsw-alias-label-secondary, currentColor)",
					fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
				};
				const children = [react.createElement("button", {
					key: "hist", type: "button", "data-vssaros-bot-history": "1",
					"aria-haspopup": "menu", "aria-expanded": open,
					title: "聊天历史（当前 Bot 的会话）",
					onClick: () => { setNote(null); setOpen(!open); }, style: BTN,
				}, "🕘 聊天历史 ▾")];
				if (open) {
					const HEADING = { fontSize: 10.5, letterSpacing: ".03em", color: "var(--dsw-alias-label-secondary, currentColor)", padding: "6px 8px 3px" };
					const menuRows = [react.createElement("div", { key: "h", style: HEADING }, "聊天历史 · " + botLabel)];
					const rows = data ? data.rows : [];
					if (rows.length === 0) {
						menuRows.push(react.createElement("div", {
							key: "empty", style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "2px 8px 6px" },
						}, "这个 Bot 还没有其它历史会话（或会话列表未就绪）"));
					}
					for (const r of rows) {
						menuRows.push(react.createElement("button", {
							key: r.id, type: "button", role: "menuitem", "data-vssaros-bot-history-item": r.id,
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
								}, [r.archived ? "已归档" : null, r.isCurrent ? "当前" : null].filter(Boolean).join(" · ") || r.id))));
					}
					if (note) {
						menuRows.push(react.createElement("div", {
							key: "note", style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", padding: "2px 8px 6px" },
						}, note));
					}
					children.push(react.createElement("div", {
						key: "m", role: "menu", ref: menuRef,
						style: Object.assign({
							position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 1000,
							padding: 5, borderRadius: 10, minWidth: 280, maxHeight: 360, overflowY: "auto",
							border: "1px solid var(--dsw-alias-border-l1, transparent)",
							background: "linear-gradient(var(--dsw-alias-bg-layer-1, transparent), var(--dsw-alias-bg-layer-1, transparent)), var(--dsw-alias-bg-base, #1e1e1e)",
							boxShadow: "0 8px 24px rgba(0,0,0,.35)",
						}, box ? { position: "fixed", left: box.left, top: box.top, right: "auto", marginTop: 0 } : {}),
					}, ...menuRows));
				}
				return react.createElement("span", { ref: rootRef, style: { position: "relative", display: "inline-flex" } }, ...children);
			}

			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register(
					{ name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER }, BotHistoryChip));
				state.botHistoryChip = true;
			} catch (e) {
				state.botHistoryError = String((e && e.message) || e);
			}
		}

		exports.install = install;
		// 仅测试用：纯逻辑直接断言（插件装载只读 install，见 dsh client-modules 契约）。
		exports.__test = { botKeyOf, historyRows, fitMenuBox, sessionBotOf, HISTORY_LIMIT, SLOT, ENTRY_ID, ENTRY_ORDER };
		return module.exports;
	}
});
