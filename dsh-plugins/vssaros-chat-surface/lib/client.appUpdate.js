// @vssaros/dsh-chat-surface — **App 更新卡片**（2026-11-05，复刻 dsh-desktop）
//
// ── 复刻来源 ─────────────────────────────────────────────────────────────────
//   `G:\CustomWorkspaces\AIProjects\dsh-desktop\src\preload\desktop-update-ui.ts`
//   （mount 61-81 / render 121-280 / styles 529-608 / 主题 663-708）。
//   卡片结构、色值、文案、按钮、定位、a11y 全部对齐；只把「Electron preload」换成
//  「dsh 在页 chunk」，把版本号/桥命令换成本项目的。
//
// ── 为什么不复用 client.upgrade.js ───────────────────────────────────────────
//   那个 chunk 管的是**随包插件 / 商城资产 / dsh 运行时**的多行清单（左下胶囊 + 396px 面板）。
//   应用本体更新是另一条 8 相状态机，混进同一面板会「一行红字说完全部」。
//   本 chunk 只管应用本体；旧 chunk 里「应用（IDE）」段与 EditorPane 的一键升级按钮同批下线。
//
// ── 数据 ────────────────────────────────────────────────────────────────────
//   `document.documentElement.dataset.vssarosUpgrade` 的全量快照里 `app` 段
//   （`IDshUpgradeAppState`，2026-11-05 扩了 phase/percent/releaseNotes/...）。
//   事件 `vssaros-dsh-upgrade` 到达即重画；首帧按 `'snapshot'` 处理 ⇒ **历史快照不重放弹窗**。
//
// ── 隔离 ────────────────────────────────────────────────────────────────────
//   closed ShadowRoot 挂 documentElement（body 之外，不受宿主 CSS 污染）。
//   ⚠ 代价：alias 令牌不继承 ⇒ 必须像官方一样把解析后的计算色复制到 host（见 syncTheme）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.appUpdate.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const ROOT_ID = "vssaros-app-update-root";
		const EVENT = "vssaros-dsh-upgrade";
		/** 官方 desktop-update-ui.ts:49-59 同款：只复制这 9 个语义令牌。 */
		const THEME_PROPERTIES = [
			"--dsw-alias-label-primary",
			"--dsw-alias-label-secondary",
			"--dsw-alias-label-primary-inverted",
			"--dsw-alias-bg-layer-1",
			"--dsw-alias-bg-layer-2",
			"--dsw-alias-border-l2",
			"--dsw-alias-button-primary-fill",
			"--dsw-alias-button-primary-hover",
			"--dsw-alias-interactive-bg-hover"
		];
		const AUTO_VISIBLE = ["available", "downloading", "downloaded"];
		const MANUAL_ONLY = ["checking", "up-to-date", "error", "unsupported"];

		/** 对齐 dshPageBridgeProtocol.ts 的 8 相值域（信任边界已在主进程校验过，这里再兜一层）。 */
		const PHASES = ["idle", "checking", "available", "downloading", "downloaded", "up-to-date", "error", "unsupported"];

		function bridge() {
			try { return (typeof window !== "undefined" && window.vssarosDsh) || null; } catch { return null; }
		}
		function esc(s) {
			return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		}

		/** dataset 快照 → 卡片状态。坏数据一律当「没数据」，不要半截 UI。 */
		function readState() {
			try {
				const raw = document.documentElement && document.documentElement.dataset
					? document.documentElement.dataset.vssarosUpgrade : null;
				if (!raw) { return null; }
				const s = JSON.parse(raw);
				const app = s && typeof s === "object" && s.app && typeof s.app === "object" ? s.app : null;
				if (!app || typeof app.current !== "string") { return null; }
				const phase = PHASES.indexOf(app.phase) >= 0 ? app.phase : "idle";
				return {
					phase: phase,
					currentVersion: app.current,
					availableVersion: typeof app.availableVersion === "string" ? app.availableVersion
						: (app.action === "upgrade" && typeof app.remote === "string" ? app.remote : undefined),
					percent: typeof app.percent === "number" && isFinite(app.percent) ? app.percent : undefined,
					message: typeof app.error === "string" ? app.error : undefined,
					manual: app.manual === true,
					presentationId: typeof app.presentationId === "number" ? app.presentationId : undefined,
					releaseNotes: typeof app.releaseNotes === "string" ? app.releaseNotes : undefined,
					skippedVersion: typeof app.skippedVersion === "string" ? app.skippedVersion : undefined
				};
			} catch { return null; }
		}

		/** 对齐 appUpdateView.ts::shouldShowAppUpdate（两边口径必须一致）。 */
		function shouldShow(status, detailOpen) {
			if (!status) { return false; }
			if (AUTO_VISIBLE.indexOf(status.phase) >= 0) { return true; }
			return status.manual && MANUAL_ONLY.indexOf(status.phase) >= 0;
		}
		function isDismissed(status, dismissedVersion, dismissedPhase) {
			if (!status) { return true; }
			if (status.availableVersion) { return status.availableVersion === dismissedVersion; }
			return status.phase === dismissedPhase;
		}
		function headline(status) {
			const v = status.availableVersion ? "v" + status.availableVersion : "";
			switch (status.phase) {
				case "checking": return { title: "正在检查更新", desc: "当前 v" + status.currentVersion };
				case "available": return { title: "检测到新版本 " + v, desc: v + " 已发布，同意后开始下载。" };
				case "downloading": return {
					title: "正在下载更新",
					desc: status.percent === undefined ? v + " · 正在下载…" : v + " · " + Math.round(status.percent) + "%"
				};
				case "downloaded": return { title: "更新已就绪", desc: v + " 将在重启后生效。" };
				case "up-to-date": return { title: "已是最新版本", desc: "当前 v" + status.currentVersion };
				case "unsupported": return { title: "此版本不支持自动更新", desc: "请手动下载安装包覆盖安装。" };
				case "error": return { title: "更新失败", desc: status.message || "无法检查或下载更新。" };
				default: return { title: "", desc: "" };
			}
		}

		// ── 模块级状态（一个页面只有一份）─────────────────────────────────────
		let host = null, shadow = null, content = null;
		let currentStatus = null, detailOpen = false, previousFocus = null;
		let dismissedVersion = null, dismissedPhase = null, dismissedPresentationId = undefined;
		let accepting = false, installing = false;
		let themeObserver = null;

		function ensureStyles() {
			if (!shadow || shadow.querySelector("style")) { return; }
			const style = document.createElement("style");
			style.textContent = STYLES;
			shadow.appendChild(style);
		}

		function mount() {
			if (typeof document === "undefined" || !document.documentElement) { return false; }
			if (document.getElementById(ROOT_ID)) { return false; }
			try {
				host = document.createElement("div");
				host.id = ROOT_ID;
				host.style.cssText = [
					"position:fixed", "pointer-events:none", "z-index:2147483646", "display:none",
					"width:min(520px,calc(100vw - 40px))",
					"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
				].join(";");
				shadow = host.attachShadow({ mode: "closed" });
				content = document.createElement("div");
				ensureStyles();
				shadow.appendChild(content);
				document.documentElement.appendChild(host);
				return true;
			} catch { host = null; shadow = null; content = null; return false; }
		}

		/**
		 * host 挂在 documentElement（body 之外）⇒ alias 令牌不继承。
		 * 用隐藏 span 解析 body 上的计算色后复制到 host；官方 desktop-update-ui.ts:663-694 同款。
		 * 本项目两套主题归属（IDE 内嵌 / dsh 自主窗口）在这里自动统一：读的都是**页面实际生效**的值。
		 */
		function syncTheme() {
			if (!host) { return; }
			const body = document.body;
			const view = document.defaultView;
			if (!body || !view) { return; }
			const dark = body.hasAttribute("data-ds-dark-theme");
			const computed = view.getComputedStyle(body);
			let probe = null;
			try {
				probe = document.createElement("span");
				probe.setAttribute("aria-hidden", "true");
				probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
				body.appendChild(probe);
				host.dataset.dshTheme = dark ? "dark" : "light";
				host.style.setProperty("color-scheme", dark ? "dark" : "light");
				for (const property of THEME_PROPERTIES) {
					const specified = String(computed.getPropertyValue(property) || "").trim();
					if (!specified) { host.style.removeProperty(property); continue; }
					probe.style.setProperty("background-color", "var(" + property + ")");
					const resolved = String(view.getComputedStyle(probe).backgroundColor || "").trim();
					host.style.setProperty(property, resolved && resolved.indexOf("var(") !== 0 ? resolved : specified);
				}
			} catch { /* 主题复制失败只影响观感，不影响功能 */ }
			finally { if (probe && probe.parentNode) { probe.parentNode.removeChild(probe); } }
		}

		function watchTheme() {
			try {
				if (themeObserver) { themeObserver.disconnect(); }
				themeObserver = null;
				syncTheme();
				const Observer = document.defaultView && document.defaultView.MutationObserver;
				if (!Observer || !document.body) { return; }
				themeObserver = new Observer(() => syncTheme());
				themeObserver.observe(document.body, {
					attributes: true, attributeFilter: ["data-ds-dark-theme", "class", "style"]
				});
			} catch { /* 没有 MutationObserver：首次同步已够用 */ }
		}

		function button(label, cls, onClick, disabled) {
			const b = document.createElement("button");
			b.type = "button";
			b.className = cls;
			b.textContent = label;
			if (disabled) { b.disabled = true; }
			b.addEventListener("click", onClick);
			return b;
		}
		function call(fn) {
			try { const r = fn(); if (r && typeof r.catch === "function") { r.catch(() => undefined); } } catch { /* 下一轮状态会纠正 */ }
		}

		/** 一次「呈现」的身份：新请求重置忽略，历史快照不重开弹窗。 */
		function applyStatus(status, delivery) {
			if (!status) { return; }
			if (delivery === "event" && !status.manual && status.phase === "checking") { detailOpen = false; }
			const isNewManual = delivery === "event" && status.manual
				&& (!currentStatus || (status.presentationId !== undefined
					? status.presentationId !== currentStatus.presentationId
					: status.phase === "checking" && currentStatus.phase !== "checking"));
			if (isNewManual) {
				dismissedVersion = null; dismissedPhase = null; dismissedPresentationId = undefined;
				detailOpen = true;
			}
			// 进行中的活跃失败必须可见（即使进度卡被忽略过）；历史错误保持安静。
			const failedActive = delivery === "event" && status.phase === "error"
				&& (accepting || installing || (currentStatus && ["downloading", "downloaded"].indexOf(currentStatus.phase) >= 0));
			if (failedActive) {
				dismissedVersion = null; dismissedPhase = null; dismissedPresentationId = undefined;
				detailOpen = true;
			}
			if (status.phase === "idle") { detailOpen = false; }
			currentStatus = status;
			if (host) { host.dataset.updatePhase = status.phase; }
			if (status.phase === "error") { installing = false; }
			if (["error", "downloading", "downloaded", "up-to-date"].indexOf(status.phase) >= 0) { accepting = false; }
			// 宿主持久化的忽略版本：只抑制同一版本，新版仍会问。
			if (status.skippedVersion && status.availableVersion === status.skippedVersion) {
				dismissedVersion = status.skippedVersion;
			}
			render();
		}

		function dismissCurrent() {
			const s = currentStatus;
			if (!s) { return; }
			dismissedVersion = s.availableVersion || null;
			dismissedPhase = s.availableVersion ? null : s.phase;
			dismissedPresentationId = s.presentationId;
			detailOpen = false;
			render();
		}

		function render() {
			if (!host || !content || !currentStatus) { return; }
			const s = currentStatus;
			const visible = shouldShow(s, detailOpen)
				|| (detailOpen && (s.phase === "error" || s.phase === "available"));
			const suppressed = s.manual && s.presentationId !== undefined && s.presentationId === dismissedPresentationId;
			if (!visible || suppressed || isDismissed(s, dismissedVersion, dismissedPhase)) {
				host.style.display = "none";
				while (content.firstChild) { content.removeChild(content.firstChild); }
				return;
			}
			const centered = detailOpen;
			host.style.display = "block";
			host.style.left = centered ? "50%" : "auto";
			host.style.top = centered ? "50%" : "auto";
			host.style.right = centered ? "auto" : "20px";
			host.style.bottom = centered ? "auto" : "20px";
			host.style.transform = centered ? "translate(-50%, -50%)" : "none";
			host.style.width = centered ? "min(340px,calc(100vw - 40px))" : "min(520px,calc(100vw - 40px))";

			const card = document.createElement("aside");
			card.className = "au-card" + (centered ? " centered" : " notification");
			card.setAttribute("role", centered ? "dialog" : "status");
			if (centered) { card.setAttribute("aria-modal", "false"); }
			card.setAttribute("aria-live", "polite");
			card.setAttribute("aria-label", "VsSaros 更新");

			const row = document.createElement("div");
			row.className = "au-row";
			const icon = document.createElement("span");
			icon.className = "au-icon";
			icon.setAttribute("aria-hidden", "true");
			icon.innerHTML = ICON_SVG;
			row.appendChild(icon);

			const body = document.createElement("div");
			body.className = "au-body";
			const h = headline(s);
			const title = document.createElement("p");
			title.className = "au-title";
			title.textContent = h.title;
			if (s.phase === "checking") {
				const sp = document.createElement("span");
				sp.className = "au-spinner";
				title.appendChild(sp);
			}
			body.appendChild(title);
			const desc = document.createElement("p");
			desc.className = "au-desc";
			desc.textContent = s.phase === "error" && s.message ? s.message : h.desc;
			body.appendChild(desc);

			const b = bridge();
			if (!centered && s.phase === "available") {
				body.appendChild(button("查看详情", "au-btn au-btn-link", () => { detailOpen = true; render(); }));
			}
			if (centered && s.phase === "available") {
				const label = document.createElement("p");
				label.className = "au-notes-label";
				label.textContent = "更新日志";
				const notes = document.createElement("div");
				notes.className = "au-notes";
				notes.tabIndex = 0;
				notes.setAttribute("role", "region");
				notes.setAttribute("aria-label", "更新日志");
				// ★ 纯文本：更新日志来自更新源（不可信），绝不 innerHTML。
				notes.textContent = s.releaseNotes || "此版本暂无更新日志。";
				body.appendChild(label);
				body.appendChild(notes);
			}
			if (s.phase === "downloading") {
				const progress = document.createElement("div");
				progress.className = "au-progress";
				progress.setAttribute("role", "progressbar");
				progress.setAttribute("aria-valuemin", "0");
				progress.setAttribute("aria-valuemax", "100");
				if (s.percent !== undefined) {
					progress.setAttribute("aria-valuenow", String(Math.round(s.percent)));
					const value = document.createElement("div");
					value.className = "au-progress-value";
					value.style.width = s.percent + "%";
					progress.appendChild(value);
				} else {
					progress.className = "au-progress indeterminate";
				}
				body.appendChild(progress);
			}

			const actions = document.createElement("div");
			actions.className = "au-actions";
			const addSkip = () => {
				if (!centered && s.phase !== "up-to-date" && s.phase !== "unsupported"
					&& s.phase !== "error" && s.phase !== "checking") {
					actions.appendChild(button("忽略", "au-btn au-btn-quiet", () => {
						call(() => b && b.appUpdateSkip(s.availableVersion || s.currentVersion));
						dismissCurrent();
					}));
				}
			};
			if (s.phase === "available") {
				addSkip();
				actions.appendChild(button("更新", "au-btn au-btn-primary", () => {
					if (!b) { return; }
					accepting = true;
					call(() => b.upgradeApp());
				}, accepting));
			} else if (s.phase === "downloading") {
				addSkip();
			} else if (s.phase === "downloaded") {
				addSkip();
				actions.appendChild(button(installing ? "正在重启…" : "重新启动并安装", "au-btn au-btn-primary", () => {
					if (!b) { return; }
					installing = true;
					call(() => b.appUpdateInstall());
				}, installing));
			} else if (centered && ["up-to-date", "error", "unsupported"].indexOf(s.phase) >= 0) {
				if (s.phase === "error") {
					actions.appendChild(button("重试", "au-btn au-btn-primary confirm", () => {
						call(() => b && b.appUpdateCheck());
					}));
				}
				actions.appendChild(button("确定", "au-btn au-btn-primary confirm", dismissCurrent));
			}
			if (centered) { body.appendChild(actions); } else { row.appendChild(actions); }
			row.appendChild(body);
			card.appendChild(row);
			if (centered && s.availableVersion) {
				const ver = document.createElement("p");
				ver.className = "au-version";
				ver.textContent = "当前版本 v" + s.currentVersion;
				card.appendChild(ver);
			}

			const hadFocus = shadow && shadow.activeElement && shadow.activeElement.className;
			while (content.firstChild) { content.removeChild(content.firstChild); }
			content.appendChild(card);
			if (hadFocus) {
				const match = Array.prototype.find.call(card.querySelectorAll("button"), n => n.className === hadFocus);
				if (match) { match.focus(); }
			} else if (centered) {
				previousFocus = document.activeElement;
				card.tabIndex = -1;
				const first = card.querySelector("button");
				(first || card).focus();
			}
			syncTheme();
		}

		function onOutsidePointer(e) {
			if (!host || host.style.display === "none" || !detailOpen) { return; }
			const path = e.composedPath ? e.composedPath() : [];
			if (path.indexOf(host) >= 0) { return; }
			dismissCurrent();
		}
		function onKeydown(e) {
			if (e.key === "Escape" && detailOpen) { dismissCurrent(); }
		}
		function onUpgradeEvent() { applyStatus(readState(), "event"); }
		function onUnload() {
			try {
				if (themeObserver) { themeObserver.disconnect(); }
				if (typeof document !== "undefined") {
					document.removeEventListener(EVENT, onUpgradeEvent);
					document.removeEventListener("keydown", onKeydown);
				}
				if (typeof window !== "undefined") { window.removeEventListener("pointerdown", onOutsidePointer); }
			} catch { /* 卸载期清理失败无需上报 */ }
		}

		const ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.6 3.4 7v10L12 21.4 20.6 17V7L12 2.6Zm0 2.2 6.3 3.2-6.3 3.3-6.3-3.3L12 4.8Zm-7 5.5 6 3.1v5.5l-6-3.1v-5.5Zm8 8.6v-5.5l6-3.1v5.5l-6 3.1Z"/></svg>';

		/** 样式 1:1 抽自 desktop-update-ui.ts:529-608（语义色全走 --dsw-alias-* + 浅色兜底）。 */
		const STYLES = [
			":host { color-scheme: light; }",
			"* { box-sizing: border-box; }",
			".au-card { pointer-events:auto; width:100%; color:var(--dsw-alias-label-primary,#202124);",
			"  background:var(--dsw-alias-bg-layer-1,#fff); border:1px solid var(--dsw-alias-border-l2,#e5e7eb);",
			"  border-radius:16px; padding:20px; box-shadow:0 8px 24px rgba(0,0,0,.12);",
			"  max-height:calc(100vh - 48px); overflow:auto; overflow-wrap:anywhere; }",
			".au-card.notification { padding:16px; }",
			".au-row { display:flex; gap:12px; align-items:center; }",
			".au-card.centered .au-row { display:block; }",
			".au-icon { display:inline-flex; width:44px; height:44px; padding:6px; flex:none;",
			"  background:var(--dsw-alias-button-primary-fill,#000);",
			"  color:var(--dsw-alias-label-primary-inverted,#fff); border-radius:11px; }",
			".au-card.centered .au-icon { width:56px; height:56px; border-radius:12px; margin-bottom:12px; }",
			".au-icon svg { width:100%; height:100%; }",
			".au-body { min-width:0; flex:1; }",
			".au-title { margin:0 0 5px; font-size:14px; line-height:20px; font-weight:600; }",
			".au-card.centered .au-title { margin:12px 0 8px; font-size:18px; line-height:26px; }",
			".au-desc, .au-version, .au-notes-label, .au-notes { margin:0; font-size:12px; line-height:20px;",
			"  color:var(--dsw-alias-label-secondary,#666b73); }",
			".au-card.centered .au-desc { font-size:13px; }",
			".au-notes-label { margin-top:18px; }",
			".au-notes { max-height:min(280px,35vh); overflow:auto; white-space:pre-wrap;",
			"  scrollbar-width:thin; overscroll-behavior:contain; }",
			".au-notes:focus-visible { outline:2px solid var(--dsw-alias-label-secondary,#888d96); outline-offset:3px; }",
			".au-progress { height:5px; background:var(--dsw-alias-bg-layer-2,#e5e7eb);",
			"  border-radius:4px; overflow:hidden; margin:12px 0 0; }",
			".au-progress-value { height:100%; background:var(--dsw-alias-button-primary-fill,#000); }",
			".au-progress.indeterminate { background:linear-gradient(90deg,",
			"  var(--dsw-alias-bg-layer-2,#e5e7eb) 0%, var(--dsw-alias-button-primary-fill,#000) 50%,",
			"  var(--dsw-alias-bg-layer-2,#e5e7eb) 100%); background-size:200% 100%; animation:au-ind 1.2s linear infinite; }",
			"@keyframes au-ind { from { background-position:200% 0; } to { background-position:-200% 0; } }",
			".au-spinner { display:inline-block; width:10px; height:10px; margin-left:6px;",
			"  border:2px solid currentColor; border-top-color:transparent; border-radius:50%;",
			"  animation:au-spin .75s linear infinite; vertical-align:middle; }",
			"@keyframes au-spin { to { transform:rotate(360deg); } }",
			"button { appearance:none; border:0; font:inherit; cursor:pointer; border-radius:6px; min-height:32px; }",
			"button:focus-visible { outline:2px solid var(--dsw-alias-label-primary,#202124); outline-offset:2px; }",
			"button:disabled { cursor:default; opacity:.55; }",
			".au-actions { display:flex; gap:8px; margin-top:14px; align-items:center; }",
			".au-card.notification .au-actions { margin:0 0 0 auto; flex:none; }",
			".au-btn { font-size:12.5px; padding:6px 12px; }",
			".au-btn-primary { background:var(--dsw-alias-button-primary-fill,#000);",
			"  color:var(--dsw-alias-label-primary-inverted,#fff); }",
			".au-btn-primary:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover,#34363b); }",
			".au-btn-quiet { background:transparent; color:var(--dsw-alias-label-secondary,#666b73); padding:4px 8px; }",
			".au-btn-quiet:hover { background:var(--dsw-alias-interactive-bg-hover,#f0f2f5); }",
			".au-btn-link { background:transparent; color:var(--dsw-alias-label-primary,#202124);",
			"  padding-left:0; font-size:12px; text-decoration:underline; text-underline-offset:3px; }",
			".au-btn.confirm { width:100%; }",
			".au-version { text-align:center; font-size:11px; margin:12px 0 0; }",
			":host([data-dsh-theme='dark']) .au-card { background:var(--dsw-alias-bg-layer-1,#1f2023);",
			"  color:var(--dsw-alias-label-primary,#f3f4f6); border-color:var(--dsw-alias-border-l2,#41434a); }",
			":host([data-dsh-theme='dark']) :is(.au-desc,.au-version,.au-notes,.au-notes-label,.au-btn-quiet) {",
			"  color:var(--dsw-alias-label-secondary,#a9adb5); }",
			":host([data-dsh-theme='dark']) .au-btn-primary { background:var(--dsw-alias-button-primary-fill,#f9fafb);",
			"  color:var(--dsw-alias-label-primary-inverted,#191b1f); }",
			":host([data-dsh-theme='dark']) .au-btn-primary:hover:not(:disabled) {",
			"  background:var(--dsw-alias-button-primary-hover,#e6e8eb); }",
			":host([data-dsh-theme='dark']) .au-btn-quiet:hover { background:rgba(255,255,255,.12); }",
			":host([data-dsh-theme='dark']) .au-btn-link { color:var(--dsw-alias-label-primary,#f3f4f6); }",
			":host([data-dsh-theme='dark']) .au-progress { background:var(--dsw-alias-bg-layer-2,#34363b); }",
			":host([data-dsh-theme='dark']) .au-progress-value { background:var(--dsw-alias-button-primary-fill,#f9fafb); }",
			/* 官方 desktop-update-ui.ts:583 的窄容器兜底：按钮换行，正文不再被压成逐字换行 */
			"@media (max-width:440px) { .au-card.notification .au-row { flex-wrap:wrap; }",
			"  .au-card.notification .au-body { flex:1 1 calc(100% - 56px); }",
			"  .au-card.notification .au-actions { margin:10px 0 0 auto; } }",
			"@media (prefers-reduced-motion:reduce) { .au-spinner,.au-progress.indeterminate { animation:none; } }"
		].join("\n");

		return {
			install(ctx) {
				try {
					// ★ 全应用只保留一份：桌面窗口右侧的独立分屏格只是聊天框（2026-10-31 真机事故：
					//   分窗口时右下角多出一个更新 UI）。判据沿用 client.upgrade.js。
					const vid = String((window.vssarosDsh && window.vssarosDsh.viewId) || "");
					if (vid.indexOf("dsh-desk-split-") === 0) { return; }
					if (!mount()) { return; }
					document.addEventListener(EVENT, onUpgradeEvent);
					document.addEventListener("keydown", onKeydown);
					window.addEventListener("pointerdown", onOutsidePointer, true);
					window.addEventListener("unload", onUnload, { once: true });
					watchTheme();
					// 首帧按快照处理：renderer / Host 重启后读到的是历史状态，**不许重放手动弹窗**。
					applyStatus(readState(), "snapshot");
				} catch { /* 装不上就不出现入口，聊天本体不受影响 */ }
			},
			__test: { readState, shouldShow, isDismissed, headline, THEME_PROPERTIES }
		};
	},
});
