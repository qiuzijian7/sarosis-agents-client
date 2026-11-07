// @vssaros/dsh-chat-surface — 右侧栏「浏览器」页签（2026-11-05，用户要求：不做隔离，只在右侧栏显示浏览器内容）
//
// 形态：右栏页签里放一个**占位矩形**，宿主把集成浏览器的 WebContentsView 贴到这个矩形上。
//   · 页面只交矩形 / http(s) URL / 动作，不读写网页 DOM、不碰 cookie；
//   · 浏览器本体由 VsSaros 宿主持有（`IBrowserViewWorkbenchService`，默认 Global storage）；
//   · 不按 Bot / 会话隔离 —— 所有会话共用同一份浏览器登录态（用户明确不做隔离）。
//   · 2026-11-07：页签顶上的「浏览器助手」区 —— bot 的交接卡（接管 / 我完成了 / 停止）与本站时限授权
//     （1 小时 / 今天 / 7 天）。数据来自 vssaros-browser 插件的同源路由 `/x/vssaros-browser/api/*`
//     （Host 登录 cookie；没装那个插件 ⇒ 路由 404 ⇒ 这一区不显示）。这里只读写交接卡与授权，仍不碰网页 DOM / cookie。
//   · 2026-11-07（组合方案，参考 DS Bot）：bot 用的浏览器视图在右栏没开时由主进程**隐藏地**建好（同一个视图），页面
//     **不会**被自动弹出；有交接（登录 / 验证码 / 扫码）时，常驻 🌐 入口旁出一条提示，人点「接管」才展开右栏浏览器。
//
// 为什么不是 iframe：X-Frame-Options / CSP frame-ancestors 会让大多数站点空白，OAuth 登录页也进不来；
// 为什么不是 simple-browser：它只能占编辑器列，进不了 dsh 页面自己画的 `[data-slot="rightbar"]`。
//
// 槽：
//   · `sidebar.right.pane.tab`（keyed/session，key = TAB_KIND）—— 页签体；
//   · `sidebarRightTabs.register` —— 页签类型；
//   · `shell.overlay`（list/root）—— 常驻「🌐」入口，点了展开右栏并打开浏览器页签。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.rightbarBrowser.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const TAB_KIND = "vssaros-rightbar-browser";
		const SLOT_RIGHT_TAB = "sidebar.right.pane.tab";
		const SLOT_OVERLAY = "shell.overlay";
		const OVERLAY_ID = "vssaros-rightbar-browser-open";
		const OVERLAY_ORDER = 103; // 100 页签条 / 101 hero 新窗格 / 102 更新行 ⇒ 103 空档
		const BRIDGE_VERSION = 26;

		/** 地址栏文本 → 无凭据的 http(s) URL；不合法返回空串（页面不自己拼 iframe src）。 */
		function normalizeUrl(value) {
			const text = String(value == null ? "" : value).trim();
			if (!text) { return ""; }
			if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
				try {
					const url = new URL(text);
					return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : "";
				} catch { return ""; }
			}
			if (/^(about|javascript|data|file|blob|chrome|devtools|view-source):/i.test(text)) { return ""; }
			try {
				const url = new URL("https://" + text);
				return url.hostname && (url.hostname.indexOf(".") >= 0 || url.hostname === "localhost") ? url.href : "";
			} catch { return ""; }
		}

		/** 占位元素相对本视图视口的矩形（宿主会叠加视图 bounds）。 */
		function rectOf(el) {
			if (!el || typeof el.getBoundingClientRect !== "function") { return { x: 0, y: 0, width: 0, height: 0 }; }
			const r = el.getBoundingClientRect();
			return {
				x: Math.max(0, Math.round(r.left)),
				y: Math.max(0, Math.round(r.top)),
				width: Math.max(0, Math.round(r.width)),
				height: Math.max(0, Math.round(r.height)),
			};
		}

		const API = "/x/vssaros-browser/api";
		const POLL_MS = 3000;
		/** 常驻入口查交接卡的间隔；插件路由不在（404 / 断网）时退到 1 分钟一次。 */
		const ENTRY_POLL_MS = 4000;
		const ENTRY_IDLE_MS = 60000;
		const DURATIONS = [["hour", "1 小时"], ["today", "今天"], ["week", "7 天"]];

		/** 地址的主机名（小写）；不是 http(s) ⇒ 空串。 */
		function hostOf(url) {
			try { const u = new URL(String(url || "")); return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : ""; } catch { return ""; }
		}
		/** 授权条目是否覆盖主机（与插件 core/grants.js 的 hostMatches 同义）。 */
		function grantCovers(pattern, host) {
			if (!pattern || !host) { return false; }
			return pattern.indexOf("*.") === 0 ? host.slice(-(pattern.length - 1)) === pattern.slice(1) : host === pattern;
		}
		/** 到期时间的人话（今天 HH:mm / M月D日 HH:mm）。 */
		function untilText(iso) {
			const d = new Date(iso);
			if (isNaN(d.getTime())) { return ""; }
			const pad = (n) => (n < 10 ? "0" : "") + n;
			const time = pad(d.getHours()) + ":" + pad(d.getMinutes());
			return d.toDateString() === new Date().toDateString() ? "今天 " + time : (d.getMonth() + 1) + "月" + d.getDate() + "日 " + time;
		}
		function api(path, body) {
			if (typeof fetch !== "function") { return Promise.reject(new Error("no fetch")); }
			const init = body === undefined ? { credentials: "same-origin" } : {
				method: "POST", credentials: "same-origin", body: JSON.stringify(body),
				headers: { "content-type": "application/json", "x-vssaros-browser": "1" },
			};
			return Promise.resolve(fetch(API + path, init)).then((r) => (r && r.ok ? r.json() : Promise.reject(new Error("HTTP " + (r && r.status)))));
		}

		function install(ctx, shell) {
			const state = (shell && shell.state) || {};
			const bridge = (shell && shell.bridge) || (typeof window !== "undefined" ? window.vssarosDsh : null);
			const canUse = !!(bridge && typeof bridge.rightbarBrowser === "function" && Number(bridge.bridgeVersion || 0) >= BRIDGE_VERSION);
			state.vssarosRightbarBrowser = canUse;
			if (!canUse) {
				state.vssarosRightbarBrowserError = "页面桥版本低于 " + BRIDGE_VERSION + "（需要重启更新后的 VsSaros）";
			}
			/** 单向命令：桥只回 true；失败也不该让页签白屏 ⇒ 吞掉，界面自己给提示。 */
			const send = (action, options) => {
				if (!canUse) { return Promise.resolve(false); }
				try {
					return Promise.resolve(bridge.rightbarBrowser(action, options)).then(() => true, () => false);
				} catch { return Promise.resolve(false); }
			};
			const noteFail = (tag, err) => {
				try { console.warn("[vssaros] 右栏浏览器注册失败（" + tag + "）：" + String((err && err.message) || err)); } catch { /* 无 console */ }
				return null;
			};
			const safeInject = (tag, name, fn) => {
				try { return ctx.slots.inject(name, fn); } catch (e) { return noteFail(tag, e); }
			};
			const safeRegister = (tag, options, component) => {
				try { return ctx.slots.register(options, component); } catch (e) { return noteFail(tag, e); }
			};

			/** 展开官方右栏后打开本页签（与工作台导航同一条通路）。 */
			const openBrowserTab = () => {
				try {
					const open = () => {
						if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === "function") {
							ctx.sidebarRight.openTab(TAB_KIND);
						}
					};
					const expand = typeof document !== "undefined" ? document.querySelector("[data-sidebar-right-expand]") : null;
					if (expand && typeof expand.click === "function") {
						expand.click();
						window.setTimeout(open, 180);
					} else { open(); }
				} catch (e) { noteFail("openTab", e); }
			};

			/** 页签顶上的助手区：交接卡 + 本站授权条。插件路由不在 ⇒ 不渲染。 */
			function BrowserAssistant(props) {
				const [data, setData] = react.useState(null);
				const [busy, setBusy] = react.useState("");
				const refresh = react.useCallback(() => api("/state").then((d) => setData(d), () => setData(null)), []);
				react.useEffect(() => {
					let alive = true;
					const tick = () => { if (alive) { void refresh(); } };
					tick();
					const timer = window.setInterval(tick, POLL_MS);
					return () => { alive = false; window.clearInterval(timer); };
				}, [refresh]);
				if (!data) { return null; }
				const run = (key, path, body) => { setBusy(key); void api(path, body).then(refresh, refresh).then(() => setBusy("")); };
				const cards = (data.handoffs || []).filter((c) => c.open);
				const host = hostOf(data.page) || hostOf(props.fallbackUrl);
				const grants = (data.grants || []).filter((g) => grantCovers(g.host, host));
				const small = { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #81858c)" };
				const box = { margin: "0 8px 6px", padding: "6px 8px", borderRadius: 6, fontSize: 12,
					border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))", background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))" };
				const btn = (key, label, onClick, primary) => react.createElement("button", { key, type: "button", disabled: !!busy, onClick,
					"data-vssaros-rightbar-browser-action": key,
					style: Object.assign({}, chipStyle, primary ? { borderColor: "var(--dsw-alias-brand-primary, #3964fe)", color: "var(--dsw-alias-brand-primary, #3964fe)" } : {}) }, label);
				const cardEls = cards.map((c) => react.createElement("div", { key: c.id, style: box, "data-vssaros-rightbar-browser-handoff": c.state },
					react.createElement("div", { style: { marginBottom: 4 } }, (c.kind === "login" ? "🔑 " : "🤝 ") + "需要你来：" + c.reason),
					c.state === "stopped" ? react.createElement("div", { style: small }, "已叫停，等 bot 确认") : react.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
						c.state === "pending" ? btn("takeover:" + c.id, "接管", () => run("takeover:" + c.id, "/handoffs/act", { id: c.id, action: "takeover" })) : react.createElement("span", { key: "t", style: small }, "你在操作中 · "),
						btn("done:" + c.id, "我完成了", () => run("done:" + c.id, "/handoffs/act", { id: c.id, action: "done" }), true),
						btn("stop:" + c.id, "停止", () => run("stop:" + c.id, "/handoffs/act", { id: c.id, action: "stop" })))));
				const grantEl = host ? react.createElement("div", { style: Object.assign({}, small, { padding: "0 8px 6px", display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }), "data-vssaros-rightbar-browser-grants": host },
					grants.length
						? grants.map((g) => react.createElement("span", { key: g.id, style: { display: "inline-flex", gap: 4, alignItems: "center" } },
							"bot 在 " + g.host + " 上点击 / 输入 / 导航免问到 " + untilText(g.until),
							btn("revoke:" + g.id, "撤销", () => run("revoke:" + g.id, "/grants/revoke", { id: g.id }))))
						: [react.createElement("span", { key: "l" }, "让 bot 在 " + host + " 上点击 / 输入 / 导航不再逐次问：")].concat(
							DURATIONS.map((d) => btn("grant:" + d[0], d[1], () => run("grant:" + d[0], "/grants", { host, duration: d[0] }))))) : null;
				if (!cardEls.length && !grantEl) { return null; }
				return react.createElement("div", { "data-vssaros-rightbar-browser-assistant": "1", style: { flex: "none" } }, cardEls, grantEl);
			}

			function BrowserPane() {
				const [draft, setDraft] = react.useState("");
				const [current, setCurrent] = react.useState("");
				const [error, setError] = react.useState("");
				const hostRef = react.useRef(null);
				react.useEffect(() => {
					const el = hostRef.current;
					if (!el) { return undefined; }
					let alive = true;
					const report = (action) => {
						if (!alive) { return; }
						const options = { rect: rectOf(el) };
						if (action === "mount" && current) { options.url = current; }
						void send(action, options);
					};
					report("mount");
					let ro = null;
					if (typeof ResizeObserver !== "undefined") {
						ro = new ResizeObserver(() => report("bounds"));
						ro.observe(el);
					}
					const onResize = () => report("bounds");
					window.addEventListener("resize", onResize);
					return () => {
						alive = false;
						if (ro) { ro.disconnect(); }
						window.removeEventListener("resize", onResize);
						void send("unmount");
					};
				}, [current]);
				const go = (event) => {
					event.preventDefault();
					const url = normalizeUrl(draft);
					if (!url) { setError("请输入 http 或 https 网址"); return; }
					setError("");
					setDraft(url);
					setCurrent(url);
					void send("navigate", { url });
				};
				const bar = react.createElement("form", { onSubmit: go, style: { display: "flex", gap: 4, padding: "6px 8px", flex: "none" }, "data-vssaros-rightbar-browser-bar": "1" },
					react.createElement("button", { type: "button", title: "后退", onClick: () => void send("back"), style: iconStyle }, "‹"),
					react.createElement("button", { type: "button", title: "前进", onClick: () => void send("forward"), style: iconStyle }, "›"),
					react.createElement("button", { type: "button", title: "刷新", onClick: () => void send("reload"), style: iconStyle }, "⟳"),
					react.createElement("input", {
						type: "text", value: draft, placeholder: "输入网址，回车打开", spellCheck: false,
						"data-vssaros-rightbar-browser-url": "1",
						onChange: (e) => setDraft(e.target.value),
						style: { flex: "1 1 auto", minWidth: 0, height: 26, padding: "0 8px", borderRadius: 6,
							border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
							background: "var(--dsw-alias-bg-module-platform, transparent)",
							color: "var(--dsw-alias-label-primary, inherit)", fontSize: 12 },
					}));
				const hint = react.createElement("div", { style: { padding: "0 8px 6px", fontSize: 11, color: "var(--dsw-alias-label-tertiary, #81858c)" } },
					canUse ? (error || (current ? "网页由内嵌浏览器显示（所有会话共用同一份登录态）" : "在这里打开网页，右侧栏就会显示网页内容")) : state.vssarosRightbarBrowserError);
				return react.createElement("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }, "data-vssaros-rightbar-browser": TAB_KIND },
					bar,
					react.createElement(BrowserAssistant, { fallbackUrl: current }),
					hint,
					react.createElement("div", {
						ref: hostRef, "data-vssaros-rightbar-browser-slot": "1",
						style: { flex: "1 1 auto", minHeight: 0, margin: "0 8px 8px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))",
							borderRadius: 6, background: "transparent", pointerEvents: "none" },
					}));
			}

			/**
			 * 常驻入口：放在 root overlay 层，切会话 / 切工作台都不会消失。
			 * ★ 2026-11-07：有没结束的交接卡时，旁边出一条提示「bot 需要你：…」+「接管」——
			 *   点了才展开右栏浏览器（人决定什么时候看，bot 不弹界面；对齐 DS Bot 的 Take over → openBrowser）。
			 */
			function BrowserEntry() {
				const [cards, setCards] = react.useState([]);
				const [busy, setBusy] = react.useState(false);
				react.useEffect(() => {
					let alive = true;
					let timer = 0;
					const tick = () => {
						let delay = ENTRY_POLL_MS;
						void api("/state").then((d) => {
							if (alive) { setCards(((d && d.handoffs) || []).filter((c) => c.open && c.state !== "stopped")); }
						}, () => {
							delay = ENTRY_IDLE_MS;
							if (alive) { setCards([]); }
						}).then(() => { if (alive) { timer = window.setTimeout(tick, delay); } });
					};
					tick();
					return () => { alive = false; window.clearTimeout(timer); };
				}, []);
				const card = cards[0];
				const takeover = () => {
					if (!card) { openBrowserTab(); return; }
					setBusy(true);
					const act = card.state === "pending" ? api("/handoffs/act", { id: card.id, action: "takeover" }) : Promise.resolve();
					void act.then(() => undefined, () => undefined).then(() => { setBusy(false); openBrowserTab(); });
				};
				const button = react.createElement("button", {
					type: "button", title: "在右侧栏打开浏览器", "aria-label": "在右侧栏打开浏览器",
					"data-vssaros-rightbar-browser-open": "1", onClick: openBrowserTab,
					style: {
						position: "fixed", right: 12, bottom: 92, zIndex: 80, pointerEvents: "auto",
						width: 30, height: 30, borderRadius: 8, fontSize: 15, lineHeight: "28px", textAlign: "center",
						border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
						background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))",
						color: "var(--dsw-alias-label-primary, inherit)", cursor: "pointer",
					},
				}, "🌐");
				if (!card) { return button; }
				const bubble = react.createElement("div", {
					role: "status", "data-vssaros-rightbar-browser-handoff-hint": card.state,
					style: {
						position: "fixed", right: 50, bottom: 88, zIndex: 80, pointerEvents: "auto", maxWidth: 300,
						display: "flex", gap: 6, alignItems: "center", padding: "6px 8px", borderRadius: 8, fontSize: 12,
						border: "1px solid var(--dsw-alias-brand-primary, #3964fe)",
						background: "var(--dsw-alias-bg-layer-2, rgba(240,242,255,.96))",
						color: "var(--dsw-alias-label-primary, inherit)", boxShadow: "0 2px 8px rgba(0,0,0,.12)",
					},
				},
					react.createElement("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: card.reason },
						(card.kind === "login" ? "🔑 " : "🤝 ") + "bot 需要你：" + card.reason + (cards.length > 1 ? "（等 " + cards.length + " 件）" : "")),
					react.createElement("button", { type: "button", disabled: busy, onClick: takeover, "data-vssaros-rightbar-browser-handoff-takeover": card.id,
						style: Object.assign({}, chipStyle, { borderColor: "var(--dsw-alias-brand-primary, #3964fe)", color: "var(--dsw-alias-brand-primary, #3964fe)" }) },
						card.state === "taken" ? "打开" : "接管"));
				return react.createElement(react.Fragment, null, bubble, button);
			}

			// 守卫/诊断用：真组件在 install 里才闭包到 bridge，故这里补引用。
			exports.__test.BrowserPane = BrowserPane;
			exports.__test.BrowserEntry = BrowserEntry;
			exports.__test.BrowserAssistant = BrowserAssistant;

			// 页签类型：官方 rightbar 用它生成页签标题与「＋」里的入口。
			try {
				const registerType = () => {
					if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === "function") {
						// ★ 2026-11-07：带 `guide` ⇒ 右栏「开始」页上出现「浏览器」入口（官方：Omit to stay off it）。
						//   order 30：排在官方「工作区文件」(10) / 「新建终端」之后；没有快捷键 ⇒ 不给 commandId。
						return ctx.sidebarRightTabs.register({ id: TAB_KIND, kind: TAB_KIND, priority: "extension", title: () => "浏览器",
							guide: [{ id: "browser", order: 30, title: () => GUIDE_TITLE, description: () => GUIDE_DESCRIPTION, icon: GuideIcon }] });
					}
					return undefined;
				};
				if (typeof ctx.effect === "function") {
					ctx.effect(() => {
						const dispose = registerType();
						return typeof dispose === "function" ? dispose : undefined;
					}, "vssaros-rightbar-browser:type");
				} else { registerType(); }
			} catch (e) { noteFail("tabType", e); }

			// 页签体（keyed/session；key 必须等于 tab kind）。
			safeInject("rightTab:浏览器", SLOT_RIGHT_TAB, () => safeRegister(
				"rightTab:浏览器", { name: SLOT_RIGHT_TAB, key: TAB_KIND }, BrowserPane));
			// 常驻入口（list/root；带 id + order，避开 100/101/102）。
			safeInject("overlay:右栏浏览器", SLOT_OVERLAY, () => safeRegister(
				"overlay:右栏浏览器", { name: SLOT_OVERLAY, id: OVERLAY_ID, order: OVERLAY_ORDER }, BrowserEntry));
		}

		const chipStyle = { flex: "none", height: 22, padding: "0 8px", borderRadius: 11, fontSize: 11, cursor: "pointer",
			border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))", background: "transparent",
			color: "var(--dsw-alias-label-primary, inherit)" };
		const GUIDE_TITLE = "浏览器";
		const GUIDE_DESCRIPTION = "在右侧栏打开网页，bot 操作的就是这一页";
		/** 「开始」页入口的图标（地球；描边跟随文字颜色）。 */
		function GuideIcon(props) {
			const size = (props && props.size) || 16;
			return react.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6,
				strokeLinecap: "round", strokeLinejoin: "round", className: props && props.className, "aria-hidden": "true" },
				react.createElement("circle", { cx: 12, cy: 12, r: 9 }),
				react.createElement("path", { d: "M3 12h18" }),
				react.createElement("path", { d: "M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" }));
		}
		const iconStyle = { flex: "none", width: 26, height: 26, borderRadius: 6, fontSize: 14, lineHeight: "24px",
			border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
			background: "var(--dsw-alias-bg-module-platform, transparent)",
			color: "var(--dsw-alias-label-primary, inherit)", cursor: "pointer" };

		exports.install = install;
		exports.__test = { TAB_KIND, SLOT_RIGHT_TAB, SLOT_OVERLAY, OVERLAY_ID, OVERLAY_ORDER, BRIDGE_VERSION, GUIDE_TITLE, GUIDE_DESCRIPTION, normalizeUrl, rectOf, hostOf, grantCovers, untilText, API, BrowserPane: null, BrowserEntry: null, BrowserAssistant: null };
		return module.exports;
	},
});
