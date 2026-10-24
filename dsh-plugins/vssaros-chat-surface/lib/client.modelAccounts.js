// @vssaros/dsh-chat-surface — 设置 → 模型：**VsSaros 账号型 provider**（CodeBuddy）的展示与配置
//
// ── 为什么有这个 chunk（2026-10-22，用户指令「codebuddy provider 改成 dsh 侧实现，在 dsh 窗口版的
//    设置页面中的模型中展示和配置；登录也转移到 dsh 侧」；mockup `doc/dsh-settings-models-providers-mockup.html`，
//    用户确认「同意」= 方案 A'）─────────────────────────────────────────────────────────────
//   CodeBuddy 的登录 / 刷新 / 模型目录 / 路由写入已在 Host 里（`dsh-plugins/vssaros-bridge/lib/codebuddy.js`），
//   HTTP 面 `/x/vssaros-bridge/api/codebuddy/{status,signin,cancel,signout,refresh}`（写操作只认 POST，回执无 token）。
//   本 chunk 只做界面，挂在官方 Models 页**开放的两个扩展位**（官方 slot-contract.d.ts）：
//     ① `settings.models.provider-card`（keyed / root，`entryKey = settingsNs`）—— 注册 `llm-pi-ai` 一次就收到
//        这一家族的全部卡片（含「添加提供商」草稿卡）⇒ **只在 `provider.provider === 'vssaros-codebuddy'` 时出内容**；
//     ② `settings.models.footer`（list / root）——「添加模型提供商」之后：CodeBuddy **不在列表里**时的入口卡片
//        （未登录 / 登录中 / 失效 / 失败 / 无模型：这些状态下 Host 撤掉了路由 ⇒ 列表里根本没有那一行）。
//   方案 A'：CodeBuddy 那一行的官方「自定义」徽标与「编辑 / 删除」**用样式藏掉**（官方编辑器改的模型目录 / 密钥
//   会被 Host 下次同步覆盖、删除等同登出 ⇒ 留着只会误导）。⚠ 依赖官方行头结构 ⇒ 找不到预期结构时**什么都不藏**
//   （自动退回方案 A），绝不误伤别的元素 ✓。
//
// ── 装载：走 client.js 的 ALWAYS_CHUNKS（无桥也装 ⇒ dsh desktop / 全窗 / 浏览器里都有）✓
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.modelAccounts.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const h = react.createElement;

		const SLOT_CARD = "settings.models.provider-card";
		const SLOT_FOOTER = "settings.models.footer";
		/** pi-ai 适配器家族的设置命名空间（CodeBuddy 路由写在 `llm-pi-ai.providers.vssaros-codebuddy`）。 */
		const CARD_KEY = "llm-pi-ai";
		const CODEBUDDY_ROUTE = "vssaros-codebuddy";
		const FOOTER_ID = "vssaros-accounts";
		/** 官方 Models 页没有 footer 条目 ⇒ 任取一个空档；留给以后的账号卡片往前后插 ✓。 */
		const FOOTER_ORDER = 100;
		const API = "/x/vssaros-bridge/api/codebuddy/";
		/** LightAI（2026-10-22）：登录经浏览器插件读会话 cookie，HTTP 面 status/signin/cancel/signout/refresh/test/config。 */
		const LIGHTAI_API = "/x/vssaros-bridge/api/lightai/";
		/** Host 在过期前 5 分钟刷新 token（codebuddy.js 的 REFRESH_BEFORE_MS）⇒ "多久后自动续期"按这个口径算。 */
		const REFRESH_LEAD_MS = 5 * 60 * 1000;

		// ── 纯函数（守卫 check-chat-surface-chunks.mjs 直接断言）────────────────────────────────

		/**
		 * Host 状态 ⇒ 界面状态。
		 *   unknown：还没拿到状态 / 老版本桥插件（没有这个 API）⇒ 两处都不出内容；
		 *   in：已登录且路由已写 ⇒ 列表里有 CodeBuddy 行 ⇒ 账号条挂在那一行里，footer 不出 CodeBuddy 卡；
		 *   其余（out / pending / expired / error / empty / syncing）⇒ 列表里没有那一行 ⇒ 入口在 footer。
		 */
		function cardState(status) {
			if (!status || typeof status !== "object") { return "unknown"; }
			if (status.signingIn) { return "pending"; }
			if (status.signedIn) {
				if (status.routeWritten) { return "in"; }
				if (status.models === 0) { return "empty"; }
				return "syncing";
			}
			const err = typeof status.error === "string" ? status.error : "";
			if (/失效|401|403/.test(err)) { return "expired"; }
			if (err && !/已取消/.test(err)) { return "error"; }
			return "out";
		}

		/** 秒 ⇒ `m:ss`。 */
		function fmtCountdown(ms) {
			const s = Math.max(0, Math.round(ms / 1000));
			return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
		}

		/** 时长 ⇒ "1 小时 52 分" / "8 分钟" / "不到 1 分钟"。 */
		function fmtDuration(ms) {
			if (!(ms > 0)) { return ""; }
			const min = Math.floor(ms / 60000);
			if (min < 1) { return "不到 1 分钟"; }
			if (min < 60) { return min + " 分钟"; }
			const hr = Math.floor(min / 60);
			if (hr < 48) { return hr + " 小时" + (min % 60 ? " " + (min % 60) + " 分" : ""); }
			return Math.floor(hr / 24) + " 天";
		}

		/** 多久之前 ⇒ "刚刚" / "3 分钟前"。 */
		function fmtAgo(at, now) {
			if (!(at > 0)) { return ""; }
			const d = Math.max(0, now - at);
			if (d < 60000) { return "刚刚"; }
			return fmtDuration(d) + "前";
		}

		/** "令牌 xx 后自动续期"那一段；没有 refresh token / 不知道过期时间 ⇒ 不显示（返回 ""）。 */
		function renewText(status, now) {
			if (!status || !status.canRefresh || !(status.expiresAt > 0)) { return ""; }
			const left = status.expiresAt - REFRESH_LEAD_MS - now;
			return left > 60000 ? "令牌 " + fmtDuration(left) + "后自动续期" : "令牌即将自动续期";
		}

		const SOURCE_LABEL = { cli_external_link: "浏览器登录", local_storage: "复用本机 CodeBuddy 登录", "ide-import": "从 IDE 迁移", legacy: "IDE 旧同步" };

		// ── 共享状态（每个 provider 一份；卡片与 footer 共用；只在设置页开着时轮询）──────────────

		/** 外壳 URL 上的 token（Host 的 requestRejection 对所有路径都要凭据；同源 cookie 也带着）。 */
		const authHeaders = () => {
			const headers = { accept: "application/json" };
			try {
				const m = /[?&]token=([^&]+)/.exec((typeof location !== "undefined" && location.search) || "");
				if (m) { headers.authorization = "Bearer " + decodeURIComponent(m[1]); }
			} catch { /* 无 location */ }
			return headers;
		};

		/**
		 * 一份 provider 状态仓：`fetchStatus` 拉、`act` 写（POST，用回执里的状态）、`use` 订阅。
		 * @param {string} api HTTP 面前缀（`/x/vssaros-bridge/api/<provider>/`）
		 * @param {(status: any) => number} pollDelay 下一次轮询间隔（登录中要快、平时慢）
		 */
		function makeStore(api, pollDelay) {
			const st = { status: null, available: true, busy: "", lastFetch: 0, listeners: new Set(), timer: 0, inflight: null };
			const emit = () => { for (const l of Array.from(st.listeners)) { try { l(); } catch { /* 组件已卸载 */ } } };
			function schedule() {
				if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
				if (st.listeners.size === 0 || !st.available) { return; }
				st.timer = setTimeout(() => { void fetchStatus(); }, pollDelay(st.status));
			}
			function fetchStatus() {
				if (st.inflight) { return st.inflight; }
				st.inflight = fetch(api + "status", { headers: authHeaders() })
					.then((r) => {
						// 老版本桥插件没有这个 API ⇒ 404，或前缀路由回 HTML 状态页（200 非 JSON）⇒ 不显示、不再轮询 ✓
						const type = String((r.headers && r.headers.get && r.headers.get("content-type")) || "");
						if (r.status === 404 || !/json/i.test(type)) { st.available = false; return null; }
						return r.json().then((b) => (b && b.ok && b.status) ? b.status : null);
					})
					.then((s) => { if (s) { st.status = s; } st.lastFetch = Date.now(); })
					.catch(() => { /* 网络抖动：保留上次状态 */ })
					.then(() => { st.inflight = null; emit(); schedule(); });
				return st.inflight;
			}
			/** 写操作：POST ⇒ 用回执里的状态 ⇒ 继续轮询。`body` 缺省 = `{}`。 */
			function act(op, body) {
				if (st.busy) { return; }
				st.busy = op;
				emit();
				fetch(api + op, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, authHeaders()), body: JSON.stringify(body || {}) })
					.then((r) => r.json().catch(() => null))
					.then((b) => {
						if (b && b.status) { st.status = b.status; }
						if (b && b.ok === false && b.error) { st.status = Object.assign({}, st.status, { error: String(b.error) }); }
					})
					.catch((e) => { st.status = Object.assign({}, st.status, { error: "请求失败：" + String((e && e.message) || e) }); })
					.then(() => { st.busy = ""; emit(); schedule(); });
			}
			/** 订阅（挂载即拉一次；最后一个订阅者走了就停轮询）。 */
			function use() {
				const [, force] = react.useState(0);
				react.useEffect(() => {
					const l = () => force((n) => n + 1);
					st.listeners.add(l);
					if (!st.status || Date.now() - st.lastFetch > 5000) { void fetchStatus(); } else { schedule(); }
					return () => {
						st.listeners.delete(l);
						if (st.listeners.size === 0 && st.timer) { clearTimeout(st.timer); st.timer = 0; }
					};
				}, []);
				return st;
			}
			return { state: st, fetchStatus, act, use };
		}

		// CodeBuddy：登录中 1.5s 一次（等浏览器那头）；平时 20s 一次（续期 / 目录同步都在 Host 后台做，这里只是看）
		const cb = makeStore(API, (s) => (s && s.signingIn ? 1500 : 20000));
		const store = cb.state;
		const act = cb.act;
		const useAccountStore = cb.use;
		// LightAI：登录中 1.5s；获取模型中 2s；平时 30s
		const la = makeStore(LIGHTAI_API, (s) => (s && s.signingIn ? 1500 : (s && s.refreshing ? 2000 : 30000)));

		/** 每秒重画一次（倒计时用）。 */
		function useTick(on) {
			const [, force] = react.useState(0);
			react.useEffect(() => {
				if (!on) { return undefined; }
				const t = setInterval(() => force((n) => n + 1), 1000);
				return () => clearInterval(t);
			}, [on]);
		}

		// ── 视觉：全部取官方主题变量（浅 / 深色自动跟随）——尺寸照官方 Models 页实测 ─────────────

		const C = {
			fg: "var(--dsw-alias-label-primary, #0f1115)",
			fg2: "var(--dsw-alias-label-secondary, #61666b)",
			fg3: "var(--dsw-alias-label-tertiary, #81858c)",
			line: "var(--dsw-alias-border-l3, rgba(0,0,0,.12))",
			lineSoft: "var(--dsw-alias-border-l2, rgba(0,0,0,.1))",
			card: "var(--dsw-alias-settings-card-fill, #fff)",
			panel: "var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06))",
			btn: "var(--dsw-alias-button-elevated-fill, #fff)",
			pri: "var(--dsw-alias-button-primary-fill, #0f1115)",
			priFg: "var(--dsw-alias-label-primary-inverted, #fff)",
			red: "var(--dsw-alias-state-error-primary, #ec1313)",
			green: "var(--dsw-alias-state-success-primary, #22c55e)",
			amber: "var(--dsw-alias-state-warn-primary, #f59e0b)",
			grey: "var(--dsw-alias-label-tertiary, #b4b8bf)",
		};
		const S = {
			btn: { display: "inline-flex", alignItems: "center", gap: 4, height: 28, padding: "0 10px", borderRadius: 8, border: "1px solid " + C.line, background: C.btn, color: C.fg, font: "inherit", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" },
			sep: { color: C.lineSoft },
			chip: { fontSize: 11.5, border: "1px solid " + C.line, borderRadius: 6, padding: "1px 7px", background: C.btn, color: C.fg, whiteSpace: "nowrap" },
		};
		const btn = (label, onClick, kind, disabled, key) => h("button", {
			key: key || label,
			type: "button",
			disabled: !!disabled,
			onClick,
			style: Object.assign({}, S.btn,
				kind === "primary" ? { background: C.pri, color: C.priFg, borderColor: C.pri } : null,
				kind === "danger" ? { border: "1px solid transparent", background: "transparent", color: C.red } : null,
				disabled ? { opacity: 0.5, cursor: "default" } : null),
		}, label);
		const dot = (color, label) => h("span", { "aria-label": label, title: label, style: { width: 8, height: 8, borderRadius: "50%", background: color, flex: "none", display: "inline-block" } });
		const sep = (k) => h("span", { key: "sep" + k, style: S.sep }, "|");

		// ── ① 卡片里的账号条（只给 CodeBuddy 那一行）────────────────────────────────────────

		/**
		 * 方案 A'：藏掉 CodeBuddy 行头里官方的「自定义」徽标与「编辑 / 删除」。
		 * 官方行结构（0.2.1-rc.1 实测）：`li > div(行头: span(名字, 徽标, 圆点), span(按钮…)) > div[data-slot] > 本组件`。
		 * **只在结构完全吻合时动手**（按钮区里全是 <button>、徽标是名字后面那个**无 aria-label** 的 span）；
		 * 不吻合 ⇒ 什么都不做（= 方案 A）⇒ 官方改版时最坏也只是"按钮还在"，不会藏错东西 ✓。
		 * @returns {() => void} 还原函数
		 */
		function hideOfficialRowControls(anchor) {
			const restore = [];
			try {
				const li = anchor && anchor.closest ? anchor.closest("li") : null;
				const head = li && li.firstElementChild;
				if (!head || head === anchor || head.contains(anchor) || head.children.length !== 2) { return () => { }; }
				const [left, actions] = head.children;
				const buttons = Array.from(actions.children);
				const hideEl = (el) => {
					if (el.dataset.vssarosHidden === "1") { return; }
					const prev = el.style.display;
					el.style.display = "none";
					el.dataset.vssarosHidden = "1";
					restore.push(() => { el.style.display = prev; delete el.dataset.vssarosHidden; });
				};
				if (buttons.length > 0 && buttons.every((b) => b.tagName === "BUTTON")) { hideEl(actions); }
				const badges = Array.from(left.children).slice(1).filter((el) => !el.hasAttribute("aria-label") && (el.textContent || "").trim().length > 0);
				if (badges.length === 1) { hideEl(badges[0]); }
			} catch { /* 结构不认识 ⇒ 不动 */ }
			return () => { for (const r of restore) { try { r(); } catch { /* 节点已卸载 */ } } };
		}

		function CodeBuddyAccountStrip() {
			const s = useAccountStore();
			const ref = react.useRef(null);
			const [showModels, setShowModels] = react.useState(false);
			// 每次渲染都校一遍（官方行头可能因展开 / 重新排序而重建）；卸载时还原 ✓
			// ⚠ **只在账号条真的画出来时**才藏：老版本桥插件（没有 API）/ 状态没拿到 ⇒ 官方按钮必须留着，
			//   否则用户在这一行上什么都操作不了 ✗。
			react.useEffect(() => {
				const el = ref.current;
				return el && el.dataset && el.dataset.vssarosCbAccount === "1" ? hideOfficialRowControls(el) : undefined;
			});
			const st = s.status;
			// 没拿到状态 / 老桥插件 / **已不是登录态**（刚点了登出、官方列表还没刷新掉这一行）⇒ 不画账号条、也不藏官方按钮
			if (!st || !s.available || !st.signedIn) { return h("span", { ref, "data-vssaros-cb-account": "pending", style: { display: "none" } }); }
			const now = Date.now();
			const who = st.name || st.userId || "已登录";
			const parts = [h("span", { key: "who", style: { color: C.fg, fontWeight: 500 } }, "已登录 · " + who)];
			if (st.tenantId) { parts.push(sep(1), h("span", { key: "t" }, "租户 " + st.tenantId)); }
			if (typeof st.models === "number") { parts.push(sep(2), h("span", { key: "m" }, st.models + " 个模型")); }
			const renew = renewText(st, now);
			if (renew) { parts.push(sep(3), h("span", { key: "r" }, renew)); }
			const names = Array.isArray(st.modelNames) && st.modelNames.length ? st.modelNames : (st.modelIds || []);
			const hint = ["来源：" + (SOURCE_LABEL[st.source] || st.source || "未知")];
			if (st.modelsFetchedAt) { hint.push("模型目录 " + fmtAgo(st.modelsFetchedAt, now) + "同步自 " + String(st.endpoint || "").replace(/^https?:\/\//, "")); }
			return h("div", {
				ref,
				"data-vssaros-cb-account": "1",
				style: { background: C.panel, borderRadius: 14, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: C.fg2 },
			},
			h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
				// 左：账号信息（窄时自身换行）；右：按钮组（整体不拆行 ⇒「登出」不会单独掉到下一行）
				h("div", { style: { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
					dot(C.green, "已登录"), ...parts),
				h("div", { style: { flex: "none", display: "flex", alignItems: "center", gap: 4 } },
					btn(s.busy === "refresh" ? "刷新中…" : "刷新模型", () => act("refresh"), null, !!s.busy),
					btn(showModels ? "收起模型 ▴" : "查看模型 ▾", () => setShowModels(!showModels), null, !names.length),
					btn("登出", () => act("signout"), "danger", !!s.busy))),
			showModels && names.length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
				names.map((n, i) => h("span", { key: i, title: (st.modelIds || [])[i] || n, style: S.chip }, n))) : null,
			h("div", { style: { fontSize: 11.5, color: C.fg3 } }, hint.join(" · ")),
			st.error ? h("div", { style: { fontSize: 11.5, color: C.amber } }, st.error) : null);
		}

		/** keyed 槽按家族派发 ⇒ 同家族的其它卡片（Ollama / grnexus / 草稿卡）一律不出内容 ✓。 */
		function ProviderCardExtras(props) {
			const route = props && props.provider && props.provider.provider;
			if (route !== CODEBUDDY_ROUTE) { return null; }
			return h(CodeBuddyAccountStrip, null);
		}

		// ── ② footer：CodeBuddy 不在列表里时的入口卡片 ─────────────────────────────────────

		function CodeBuddyEntryCard(props) {
			const s = props.store;
			const st = s.status || {};
			const state = props.state;
			useTick(state === "pending");
			let dotColor = C.grey, dotLabel = "未登录", actions = [], body;
			const desc = (children, color) => h("div", { style: { fontSize: 12, color: color || C.fg3, lineHeight: 1.6 } }, children);
			if (state === "pending") {
				dotColor = C.amber; dotLabel = "登录中";
				actions = [btn(s.busy === "cancel" ? "取消中…" : "取消", () => act("cancel"), null, !!s.busy)];
				const left = st.signInDeadline ? fmtCountdown(st.signInDeadline - Date.now()) : "";
				body = desc(["已在系统浏览器打开 CodeBuddy 登录页，请在浏览器里完成登录…", left ? "（最长等待 " + left + "）" : ""].join(""));
			} else if (state === "expired") {
				dotColor = C.red; dotLabel = "登录失效";
				actions = [btn("重新登录", () => act("signin"), "primary", !!s.busy)];
				body = desc((st.error || "登录已失效") + "。CodeBuddy 的模型已从列表与选择器中移除，重新登录后自动恢复。", C.red);
			} else if (state === "error") {
				dotColor = C.red; dotLabel = "登录失败";
				actions = [btn("重试", () => act("signin"), "primary", !!s.busy)];
				body = desc(st.error, C.red);
			} else if (state === "empty" || state === "syncing") {
				dotColor = C.amber; dotLabel = state === "empty" ? "已登录·无模型" : "正在同步模型";
				actions = [btn(s.busy === "refresh" ? "获取中…" : "重新获取", () => act("refresh"), null, !!s.busy), btn("登出", () => act("signout"), "danger", !!s.busy)];
				const who = st.name || st.userId || "";
				body = desc(state === "empty"
					? ["已登录" + (who ? " · " + who : "") + "，但平台对该账号没有返回任何对话模型。换有模型权限的账号登录即可。", st.error ? "（" + st.error + "）" : ""].join("")
					: ["已登录" + (who ? " · " + who : "") + "，正在同步模型目录…", st.error ? "（" + st.error + "）" : ""].join(""));
			} else {
				actions = [btn(s.busy === "signin" ? "正在打开…" : "登录", () => act("signin"), "primary", !!s.busy)];
				body = desc("登录腾讯 CodeBuddy 账号后，自动接入账号可用的对话模型（出现在上方列表与输入框的模型选择器里）。本机 CodeBuddy 已登录时直接复用，不再打开浏览器。");
			}
			return h("li", {
				"data-vssaros-cb-entry": state,
				style: { listStyle: "none", background: C.card, border: "1px solid " + C.line, borderRadius: 20, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 },
			},
			h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 28 } },
				h("span", { style: { display: "flex", alignItems: "center", gap: 6 } },
					h("span", { style: { fontWeight: 500, fontSize: 14, color: C.fg } }, "CodeBuddy"),
					h("span", { style: { fontSize: 11, color: C.fg2, border: "1px solid " + C.line, borderRadius: 4, padding: "1px 6px", lineHeight: "16px" } }, "账号"),
					dot(dotColor, dotLabel)),
				h("span", { style: { display: "flex", gap: 4 } }, ...actions)),
			body);
		}

		// ── ③ footer：LightAI 卡片（mockup 的 laCard；它不是对话模型 ⇒ 永远在 footer、不进上方列表）────────

		/**
		 * Host 状态 ⇒ LightAI 卡片状态。
		 *   unknown：没拿到状态 / 老桥插件 ⇒ 不出卡片；pending：登录中；in：已登录（含网络暂时不通的 stale）；
		 *   expired：会话被 LightAI 拒绝；error：上次登录失败（取消不算）；out：未登录。
		 */
		function laState(status) {
			if (!status || typeof status !== "object") { return "unknown"; }
			if (status.signingIn) { return "pending"; }
			if (status.signedIn) { return "in"; }
			if (status.expired) { return "expired"; }
			const err = typeof status.error === "string" ? status.error : "";
			if (err && !/已取消/.test(err)) { return "error"; }
			return "out";
		}
		const LA_KINDS = [["image", "图片"], ["video", "视频"], ["model3d", "3D"], ["audio", "音频"]];
		const LA_VIA = { browser: "浏览器插件登录", "browser-profile": "复用浏览器里的 LightAI 会话", "ide-import": "从 IDE 迁移" };

		/** 「自定义设置」：服务地址 + 计费字段（应用 / 项目来自登录参数，只读）。 */
		function LightAISettings(props) {
			const st = props.status;
			const [draft, setDraft] = react.useState({ floodApiBase: st.floodApiBase || "", userType: st.userType || "", company: st.company || "" });
			const field = (label, key, readonly) => h("label", { key: label, style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, color: C.fg3 } },
				label,
				h("input", {
					value: readonly ? String(readonly) : draft[key],
					readOnly: !!readonly,
					onChange: readonly ? undefined : (e) => setDraft(Object.assign({}, draft, { [key]: e.target.value })),
					style: { height: 30, padding: "0 10px", borderRadius: 8, border: "1px solid " + C.line, background: readonly ? C.panel : C.btn, color: C.fg, font: "inherit", fontSize: 12.5 },
				}));
			const dirty = draft.floodApiBase !== (st.floodApiBase || "") || draft.userType !== (st.userType || "") || draft.company !== (st.company || "");
			return h("div", { "data-vssaros-la-settings": "1", style: { display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 } },
				field("服务地址", "floodApiBase"),
				h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } },
					field("应用 ID（登录参数）", "appId", st.appId || "—"),
					field("项目 ID（登录参数）", "bizId", st.bizId || "—"),
					field("用户类型（计费）", "userType"),
					field("公司（计费）", "company")),
				h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 6 } },
					btn("取消", props.onClose),
					btn(la.state.busy === "config" ? "保存中…" : "保存", () => { la.act("config", draft); props.onClose(); }, "primary", !dirty || !!la.state.busy)));
		}

		function LightAICard() {
			const s = la.use();
			const st = s.status || {};
			const state = laState(s.status);
			const [cap, setCap] = react.useState("");
			const [editing, setEditing] = react.useState(false);
			useTick(state === "pending");
			if (!s.available || state === "unknown") { return null; }
			const desc = (children, color) => h("div", { style: { fontSize: 12, color: color || C.fg3, lineHeight: 1.6 } }, children);
			const busy = !!s.busy;
			let dotColor = C.grey, dotLabel = "未登录", actions = [], body = [];
			const browserNote = !st.browserAvailable
				? "LightAI 登录要用浏览器插件 @vssaros/dsh-browser —— 请先在「内置插件」里启用它。"
				: (st.browserHeadless ? "浏览器插件当前是无头模式（没有可见窗口），无法登录 —— 先关掉它的无头模式。" : "");
			if (state === "pending") {
				dotColor = C.amber; dotLabel = "登录中";
				actions = [btn(s.busy === "cancel" ? "取消中…" : "取消", () => la.act("cancel"), null, busy)];
				const left = st.signInDeadline ? fmtCountdown(st.signInDeadline - Date.now()) : "";
				body.push(desc("已用浏览器插件打开 LightAI 登录页，请在那个浏览器窗口里完成登录，完成后自动读取会话…" + (left ? "（最长等待 " + left + "）" : "")));
			} else if (state === "in") {
				dotColor = st.stale ? C.amber : C.green; dotLabel = st.stale ? "已登录·连接异常" : "已登录";
				actions = [
					btn(st.refreshing || s.busy === "refresh" ? "获取中…" : "获取模型", () => la.act("refresh"), null, busy || !!st.refreshing),
					btn(s.busy === "test" ? "测试中…" : "测试连接", () => la.act("test"), null, busy),
					btn("登出", () => la.act("signout"), "danger", busy),
				];
				const line = [h("span", { key: "who", style: { color: C.fg, fontWeight: 500 } }, st.userId || "已登录")];
				if (st.projectName) { line.push(sep(1), h("span", { key: "p" }, st.projectName)); }
				if (st.appName) { line.push(sep(2), h("span", { key: "a" }, "应用 " + st.appName)); }
				if (st.lastTest) { line.push(sep(3), h("span", { key: "t", style: { color: st.lastTest.ok ? C.green : C.red } }, st.lastTest.message)); }
				body.push(h("div", { key: "line", style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: C.fg2 } }, ...line));
				const models = st.models || {};
				body.push(h("div", { key: "caps", style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
					...LA_KINDS.map(([k, label]) => h("button", {
						key: k, type: "button", "data-vssaros-la-cap": k,
						onClick: () => setCap(cap === k ? "" : k),
						// ⚠ 不能用 `font: inherit` 简写：React 按键序写样式，简写排在 S.chip 的 fontSize 之后 ⇒ 字号被重置成 14px ✗
						style: Object.assign({}, S.chip, { cursor: "pointer", fontFamily: "inherit" }, cap === k ? { background: C.pri, color: C.priFg, borderColor: C.pri } : null),
					}, label + " " + ((models[k] || []).length))),
					h("span", { key: "hint", style: { fontSize: 11.5, color: C.fg3 } }, "点类别查看模型")));
				if (cap && Array.isArray(models[cap])) {
					body.push(h("div", { key: "list", style: { display: "flex", flexWrap: "wrap", gap: 6 } },
						models[cap].map((m) => h("span", {
							key: m.id,
							title: m.routable ? m.id : m.id + "（IDE 生成链路暂不认识这个模型）",
							style: Object.assign({}, S.chip, m.routable ? null : { opacity: 0.55 }),
						}, m.name, h("i", { style: { fontStyle: "normal", color: C.fg3, marginLeft: 6, fontSize: 10.5 } }, m.id)))));
				}
				const hint = [];
				if (st.via) { hint.push("来源：" + (LA_VIA[st.via] || st.via)); }
				hint.push(st.modelsSource === "discovered" && st.modelsFetchedAt ? "模型清单 " + fmtAgo(st.modelsFetchedAt, Date.now()) + "从 LightAI 获取" : "模型清单为默认清单");
				body.push(h("div", { key: "hint", style: { fontSize: 11.5, color: C.fg3 } }, hint.join(" · ")));
				if (st.stale && st.error) { body.push(desc(st.error, C.amber)); }
				if (st.modelsError) { body.push(desc(st.modelsError, C.amber)); }
				body.push(h("button", {
					key: "summ", type: "button", "data-vssaros-la-details": editing ? "open" : "closed",
					onClick: () => setEditing(!editing),
					style: { alignSelf: "flex-start", border: "none", background: "transparent", padding: 0, font: "inherit", fontSize: 12, color: C.fg2, cursor: "pointer" },
				}, (editing ? "▾ " : "▸ ") + "自定义设置"));
				if (editing) { body.push(h(LightAISettings, { key: "settings", status: st, onClose: () => setEditing(false) })); }
			} else {
				const retry = state === "expired" || state === "error";
				dotColor = retry ? C.red : C.grey;
				dotLabel = state === "expired" ? "登录失效" : (state === "error" ? "登录失败" : "未登录");
				actions = [btn(s.busy === "signin" ? "正在打开…" : (state === "expired" ? "重新登录" : (state === "error" ? "重试" : "登录")),
					() => la.act("signin"), "primary", busy || !!browserNote)];
				if (retry) { body.push(desc(st.error || "LightAI 登录已失效", C.red)); }
				body.push(desc("腾讯光子 LightAI 的图片 / 视频 / 3D / 音频生成服务，供生图画布与工作流节点调用；不出现在对话模型选择器。点「登录」会用浏览器插件打开 LightAI 登录页，登录后自动读取会话（浏览器里已登录过时直接复用）。"));
				if (browserNote) { body.push(desc(browserNote, C.amber)); }
			}
			return h("li", {
				"data-vssaros-la-card": state,
				style: { listStyle: "none", background: C.card, border: "1px solid " + C.line, borderRadius: 20, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 },
			},
			h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 28 } },
				h("span", { style: { display: "flex", alignItems: "center", gap: 6 } },
					h("span", { style: { fontWeight: 500, fontSize: 14, color: C.fg } }, "LightAI"),
					h("span", { style: { fontSize: 11, color: C.fg2, border: "1px solid " + C.line, borderRadius: 4, padding: "1px 6px", lineHeight: "16px" } }, "媒体生成"),
					dot(dotColor, dotLabel)),
				h("span", { style: { display: "flex", gap: 4, flex: "none" } }, ...actions)),
			...body);
		}

		function ModelsFooter() {
			const s = useAccountStore();
			const l = la.use();
			const state = cardState(s.status);
			const showCb = s.available && state !== "unknown" && state !== "in";
			const showLa = l.available && laState(l.status) !== "unknown";
			if (!showCb && !showLa) { return null; }
			return h("div", { "data-vssaros-models-footer": "1", style: { marginTop: 18 } },
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 500, color: C.fg3, margin: "0 2px 8px" } },
					"VsSaros 账号服务", h("span", { style: { flex: 1, height: 1, background: C.lineSoft } })),
				h("ul", { style: { margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 } },
					showCb ? h(CodeBuddyEntryCard, { store: s, state }) : null,
					h(LightAICard, null)));
		}

		// ── 注册（不许外抛：一处撞了不连累另一处 —— 同 client.workbenchNav.js 的教训）──────────
		function install(ctx, shell) {
			const state = (shell && shell.state) || {};
			if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") { return; }
			const fail = (tag, e) => {
				state.partErrors = Object.assign({}, state.partErrors, { ["modelAccounts:" + tag]: String((e && e.message) || e) });
				return null;
			};
			const safe = (tag, slot, options, component) => {
				try {
					return ctx.slots.inject(slot, () => {
						try { return ctx.slots.register(options, component); } catch (e) { return fail(tag, e); }
					});
				} catch (e) { return fail(tag, e); }
			};
			safe("card", SLOT_CARD, { name: SLOT_CARD, key: CARD_KEY }, ProviderCardExtras);
			safe("footer", SLOT_FOOTER, { name: SLOT_FOOTER, id: FOOTER_ID, order: FOOTER_ORDER }, ModelsFooter);
			state.modelAccounts = true;
		}

		exports.install = install;
		exports.__test = { cardState, laState, fmtCountdown, fmtDuration, fmtAgo, renewText, hideOfficialRowControls, CARD_KEY, CODEBUDDY_ROUTE, FOOTER_ID, FOOTER_ORDER, API, LIGHTAI_API, LightAICard, ModelsFooter, laStore: la.state };
		return module.exports;
	},
});
