// @vssaros/dsh-chat-surface — 右侧栏「浏览器」页签（2026-11-05，用户要求：不做隔离，只在右侧栏显示浏览器内容）
//
// 形态：右栏页签里放一个**占位矩形**，宿主把集成浏览器的 WebContentsView 贴到这个矩形上。
//   · 页面只交矩形 / http(s) URL / 动作，不读写网页 DOM、不碰 cookie；
//   · 浏览器本体由 VsSaros 宿主持有（`IBrowserViewWorkbenchService`，默认 Global storage）；
//   · 不按 Bot / 会话隔离 —— 所有会话共用同一份浏览器登录态（用户明确不做隔离）。
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
					hint,
					react.createElement("div", {
						ref: hostRef, "data-vssaros-rightbar-browser-slot": "1",
						style: { flex: "1 1 auto", minHeight: 0, margin: "0 8px 8px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))",
							borderRadius: 6, background: "transparent", pointerEvents: "none" },
					}));
			}

			/** 常驻入口：放在 root overlay 层，切会话 / 切工作台都不会消失。 */
			function BrowserEntry() {
				return react.createElement("button", {
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
			}

			// 守卫/诊断用：真组件在 install 里才闭包到 bridge，故这里补引用。
			exports.__test.BrowserPane = BrowserPane;
			exports.__test.BrowserEntry = BrowserEntry;

			// 页签类型：官方 rightbar 用它生成页签标题与「＋」里的入口。
			try {
				const registerType = () => {
					if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === "function") {
						return ctx.sidebarRightTabs.register({ id: TAB_KIND, kind: TAB_KIND, priority: "extension", title: () => "浏览器" });
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

		const iconStyle = { flex: "none", width: 26, height: 26, borderRadius: 6, fontSize: 14, lineHeight: "24px",
			border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
			background: "var(--dsw-alias-bg-module-platform, transparent)",
			color: "var(--dsw-alias-label-primary, inherit)", cursor: "pointer" };

		exports.install = install;
		exports.__test = { TAB_KIND, SLOT_RIGHT_TAB, SLOT_OVERLAY, OVERLAY_ID, OVERLAY_ORDER, BRIDGE_VERSION, normalizeUrl, rectOf, BrowserPane: null, BrowserEntry: null };
		return module.exports;
	},
});
