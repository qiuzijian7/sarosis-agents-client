// @vssaros/dsh-chat-surface — 侧栏底部「账号」入口 + 账号菜单（2026-10-21）
//
// ── 形态（用户给的参照布局）─────────────────────────────────────────────────
//   左下角一枚「头像 + 名字 + ⌄」；点它 ⇒ 弹层：
//     ⚙ 设置            Ctrl + ,
//     ✈ 意见反馈
//     ↩ 退出登录        （未登录时是「→ 登录」）
//     ─────────────
//     [头像] 名字       （= 账号 chip，与参照图一致）
//
// ── 为什么自绘弹层 ──────────────────────────────────────────────────────────
//   chunk 只能 `require("react")`（**没有** react-dom ⇒ 不能 portal）⇒ 与
//   `client.workbenchNav.js` 的启动器同一套做法：纯 DOM + `position: fixed` + 点外部关闭
//   + **两轴夹进视口**（本页面跑在 WebContentsView 里，超出视图矩形的部分会被裁掉，滚不到 ✗）。
//
// ── 账号口径（2026-10-21，用户："仅保留一个 ide登录账号入口"）─────────────────
//   只显示 **IDE 账号**（TOF/OA）：状态由 IDE **推**来（preload 写 `dataset.vssarosAuth` + 派 DOM 事件
//   `vssaros-dsh-auth`）⇒ 页面只读不算、不缓存 ⇒ 窗口与 IDE 天生一致 ✓。
//   登录/登出**都交给 IDE**（页面桥 `signInIde` / `signOutIde`）；菜单里的「设置 / 意见反馈」
//   也是请 IDE 打开它自己的界面（`openSettings` / `openFeedback`，桥 17 → 18）✓。
//   ⚠ 曾经并存第二行「dsh 自己的 DeepSeek 账号」（`ctx.remote.account.*`）—— 用户要求只留一个入口 ⇒ 已删。
//
// ── 窗口模式点「登录」不切模式（2026-10-21）──────────────────────────────────
//   用户原话："窗口模式下，点击登录会切换到 ide 模式，要求不切换，在当前模式下，直接登录"。
//   · 根因在**宿主**：页面桥 `signInIde` 落进了"要 IDE 出界面"的名单 ⇒ 宿主把被收起的 IDE 主窗口
//     拉回前台 ⇒ 看起来像"切了模式"。已在宿主把 `signInIde`/`signOutIde` 登记成
//     "不需要 IDE 主窗口露面"（`DSH_PAGE_COMMANDS_WITHOUT_IDE_UI`）⇒ 登录原地完成 ✓。
//   · 页面侧职责：登录要等**系统浏览器**回调（几十秒）⇒ 触发按钮当场显示「登录中…」
//     （`pendingAction` + 200s 兜底复位），免得用户以为"点了没反应" ✓；
//     成功与否由 IDE **推**回来的登录态决定（页面不猜）✓。
//
// ── 槽位 ────────────────────────────────────────────────────────────────────
//   官方账号启动器注册在 `settings.launcher`（single）⇒ 我们用 `priority: -10` **顶掉**它、
//   自己画这一枚（顶替单槽的先例：`client.brand.js` 顶 `sidebar.brand.mark/name` ✓）。
//   ⚠ 本 chunk 只在**带官方 chrome 的视图**装（chat-only 聊天框里没有侧栏 ⇒ 没这枚 ✓）。
//
// ── 2026-10-22：企业身份归 dsh 侧（用户："登录也转移到 dsh 侧实现，ide 侧仅读取状态"）──────────
//   状态与登录 / 登出改走**桥插件的 HTTP 面** `/x/vssaros-bridge/api/tof/*`（Host 自己开浏览器、存票）⇒
//   **不经 IDE** ⇒ 独立桌面窗口（没有 IDE 宿主桥）也能登录 ✓。回执没有票据（页面永远拿不到票）✓。
//   老版本桥插件（没有这个 API，回 404）⇒ 自动退回原来的"IDE 推状态 + 页面桥 signInIde"✓。
//   IDE 推来的 `vssaros-dsh-auth` 事件仍然听着 ⇒ 当作"重读一次"的信号（IDE 侧登录也会反映到这里）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.account.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "settings.launcher";
		/** preload 派发的 DOM 事件名（与协议里的 `DSH_PAGE_AUTH_EVENT` 同值 —— 页面不能 import ⇒ 守卫对账 ✓）。 */
		const AUTH_EVENT = "vssaros-dsh-auth";

		/**
		 * `install()` 里定义的触发组件（**只给守卫 ⑪ 用**）。
		 *
		 * 组件在 install 作用域（要用 `ctx`），而 `exports.__test` 在工厂作用域 ⇒ 直接引用会
		 * `AccountEntry is not defined`（`client.hero.js` 踩过同一个坑 ✗）。做法：install 里赋值，
		 * `__test.AccountEntry` 转调 ⇒ 守卫必须先跑一次 install 再渲染 ✓。
		 */
		let AccountEntryRef = null;
		/**
		 * 槽的 **ownerProps**（最后一次渲染收到的）：`settings.launcher` 槽的官方契约
		 * `SettingsLauncherOwnerProps` 里带 `openSettings: () => void`（"Open the settings panel."）
		 * ⇒ 那是 **dsh 官方设置弹窗**的开关（用户 2026-10-21 明确要这套 UI）✓。
		 * 我们把自己的入口注册在同一个槽上 ⇒ 同样能拿到它 ⇒ 直接调，不用绕道 IDE 设置 ✗。
		 */
		let ownerProps = null;

		function bridgeApi() {
			return (typeof window !== "undefined" && window.vssarosDsh) || {};
		}
		function notify(kind, text) {
			const api = bridgeApi();
			try { if (typeof api.notify === "function") { api.notify(kind, text); } } catch { /* 通知失败不影响别的 */ }
		}

		/**
		 * IDE 账号状态（宿主推来的事实；读不到就当"未登录"，不猜 ✓）。
		 */
		function readIdeAuth() {
			const empty = { signedIn: false, loginName: "", staffId: "", team: "", error: "" };
			try {
				const el = document.documentElement;
				const raw = el && el.dataset ? el.dataset.vssarosAuth : "";
				if (!raw) { return empty; }
				const p = JSON.parse(raw);
				return {
					signedIn: p && p.signedIn === true,
					loginName: String((p && p.loginName) || ""),
					staffId: String((p && p.staffId) || ""),
					team: String((p && p.team) || ""),
					// ★ 失败原因（2026-10-21）：页面桥是**单向**的 ⇒ 失败只能靠宿主推回来才看得见
					//   （否则用户只看到"未登录"，真实原因只落 IDE 日志 ⇒ 干等超时兜底 ✗）。
					error: String((p && p.error) || ""),
				};
			} catch { return empty; }
		}

		/** 账号 chip / 触发按钮上显示的名字。 */
		function displayName(auth) {
			if (!auth || !auth.signedIn) { return "未登录"; }
			return auth.loginName || auth.staffId || "企业账号";
		}

		// ── dsh 侧企业身份（HTTP 面）──────────────────────────────────────────────
		const TOF_API = "/x/vssaros-bridge/api/tof/";
		/** available: null = 还没探过；true = 有 HTTP 面；false = 老桥插件（退回 IDE 推送）。 */
		const tofHttp = { available: null, status: null, inflight: null, pollTimer: null };
		const tofListeners = new Set();
		const emitTof = () => { for (const fn of Array.from(tofListeners)) { try { fn(); } catch { /* 组件已卸载 */ } } };

		/** 外壳 URL 上的 token（Host 的 requestRejection 对所有路径都要凭据；同源 cookie 也带着）。 */
		function authHeaders(extra) {
			const headers = Object.assign({ accept: "application/json" }, extra || {});
			try {
				const m = /[?&]token=([^&]+)/.exec((typeof location !== "undefined" && location.search) || "");
				if (m) { headers.authorization = "Bearer " + decodeURIComponent(m[1]); }
			} catch { /* 无 location */ }
			return headers;
		}

		/** HTTP 状态 ⇒ 与 `readIdeAuth()` 同形（页面其它地方不必关心来源）。 */
		function fromTofStatus(st) {
			if (!st || typeof st !== "object") { return null; }
			return {
				signedIn: st.signedIn === true,
				loginName: String(st.loginName || ""),
				staffId: String(st.staffId || ""),
				team: String(st.team || ""),
				expired: st.expired === true,
				signingIn: st.signingIn === true,
				error: st.expired === true ? "" : String(st.error || ""),
			};
		}

		function fetchTofStatus() {
			if (tofHttp.available === false) { return Promise.resolve(null); }
			if (tofHttp.inflight) { return tofHttp.inflight; }
			tofHttp.inflight = fetch(TOF_API + "status", { headers: authHeaders() })
				.then((r) => {
					// 老桥插件：没有这个 API ⇒ 要么 404，要么前缀路由回它的 HTML 状态页（200 但不是 JSON）
					//   ⇒ 两种都当"没有 HTTP 面"⇒ 退回 IDE 推送 + 页面桥，且不再反复探 ✓
					const type = String((r.headers && r.headers.get && r.headers.get("content-type")) || "");
					if (r.status === 404 || !/json/i.test(type)) { tofHttp.available = false; return null; }
					return r.json().then((b) => (b && b.ok && b.status) ? b.status : null);
				})
				.then((st) => { if (st) { tofHttp.available = true; tofHttp.status = st; } return st; })
				.catch(() => null)
				.then((st) => { tofHttp.inflight = null; emitTof(); return st; });
			return tofHttp.inflight;
		}

		/** 登录中：每 1.5s 看一次，直到 Host 说"不在登录了"（成功 / 失败 / 取消 / 超时）。 */
		function pollWhileSigningIn() {
			if (tofHttp.pollTimer) { clearTimeout(tofHttp.pollTimer); tofHttp.pollTimer = null; }
			tofHttp.pollTimer = setTimeout(() => {
				tofHttp.pollTimer = null;
				fetchTofStatus().then((st) => {
					if (st && st.signingIn) { pollWhileSigningIn(); return; }
					setPendingAction("");
					if (st && !st.signedIn && st.error && !/已取消/.test(st.error)) { notify("warn", "登录未完成：" + st.error); }
				});
			}, 1500);
		}

		/** 经 HTTP 面登录 / 登出；返回 false = 没有 HTTP 面（调用方退回页面桥）。 */
		function tofHttpAction(action) {
			if (tofHttp.available !== true) { return false; }
			const op = action === "signInIde" ? "signin" : "signout";
			setPendingAction(action);
			fetch(TOF_API + op, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: "{}" })
				.then((r) => r.json().catch(() => null))
				.then((b) => {
					if (b && b.status) { tofHttp.status = b.status; emitTof(); }
					if (!b || b.ok !== true) {
						setPendingAction("");
						notify("warn", (op === "signin" ? "登录" : "登出") + "失败：" + String((b && b.error) || "未知错误"));
						return;
					}
					if (op === "signin") { pollWhileSigningIn(); } else { setPendingAction(""); }
				})
				.catch((e) => { setPendingAction(""); notify("warn", "操作失败：" + String((e && e.message) || e)); });
			return true;
		}

		/** 当前账号状态：有 HTTP 面就以 dsh 侧为准；否则用 IDE 推来的（老桥插件）。 */
		function readAuth() {
			const fromHttp = tofHttp.available === true ? fromTofStatus(tofHttp.status) : null;
			return fromHttp || readIdeAuth();
		}

		/**
		 * 「登录中 / 登出中」状态（模块级 + 订阅）。
		 *
		 * 为什么需要：TOF 登录要等**系统浏览器**里完成回调（几十秒量级），而窗口里这段时间本来毫无动静
		 *   ⇒ 不给反馈，用户只会以为"点了没反应"（本仓高频缺陷形态）⇒ 触发按钮当场变成「登录中…」。
		 * ★ 2026-10-21（用户："窗口模式下，点击登录会切换到 ide 模式，要求不切换，在当前模式下，直接登录"）：
		 *   登录现在**原地**完成（宿主不再把 IDE 主窗口拉到前台）⇒ 窗口内必须看得见"正在登录" ✓。
		 * ⚠ 成功与否**不由这里判断**：登录态是 IDE **推**来的（`AUTH_EVENT`）⇒ 推到了就算完 ✓。
		 */
		let pendingAction = "";
		let pendingTimer = null;
		const pendingListeners = new Set();
		function setPendingAction(v) {
			pendingAction = v;
			if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
			if (v) {
				// 兜底：用户可能直接在浏览器里关掉页面 ⇒ 登录永远不会回调 ⇒ 不能一直显示"登录中"
				//   （用户可见文案会变假）。TOF 侧超时是 180s ⇒ 这里给 200s 自动复位
				//   （此时仍未登录 ⇒ 复位后的文案仍然是真的 ✓）。
				pendingTimer = setTimeout(() => { pendingTimer = null; setPendingAction(""); }, 200000);
			}
			for (const fn of pendingListeners) { try { fn(v); } catch { /* 单个监听器坏了不许影响别人 */ } }
		}
		function getPendingAction() { return pendingAction; }

		/**
		 * 菜单项清单（**纯逻辑** ⇒ 守卫 ⑪ 直接断言；DOM 与之一一对应，不另写一份）。
		 *
		 * 三项固定顺序（与用户给的参照图一致：设置 / 意见反馈 / 退出登录）；
		 * 最后一项按登录态选：已登录 ⇒ 退出登录（`signOutIde`）；未登录 ⇒ 登录（`signInIde`）。
		 */
		function menuItems(auth) {
			const signedIn = !!(auth && auth.signedIn);
			return [
				// `dshSettings` = 打开 **dsh 官方设置弹窗**（槽 ownerProps 提供的 openSettings），
				//   不是 IDE 设置（用户 2026-10-21："打开的设置，应该是 dsh 侧的设置UI"）✓
				{ id: "settings", ico: "⚙", label: "设置", hint: "Ctrl + ,", action: "dshSettings" },
				{ id: "feedback", ico: "✈", label: "意见反馈", hint: "", action: "openFeedback" },
				signedIn
					? { id: "signout", ico: "↩", label: "退出登录", hint: "", action: "signOutIde" }
					: { id: "signin", ico: "→", label: "登录", hint: "", action: "signInIde" },
			];
		}

		/**
		 * 打开 **dsh 官方设置弹窗**（账号与余额 / 通用设置 / 模型 / 内置插件 / Agent 预设 那套 UI）。
		 *
		 * 走的是 `settings.launcher` 槽 **ownerProps** 里的 `openSettings`（官方槽契约
		 * `SettingsLauncherOwnerProps`："Open the settings panel."）—— 官方账号菜单的「设置」也是它 ✓。
		 * ⚠ 旧宿主没有这个 ownerProp ⇒ 回落页面桥 `openSettings`（打开 IDE 设置），并**明说**，
		 *   不许"点了没反应"✗。
		 */
		function openDshSettings() {
			if (ownerProps && typeof ownerProps.openSettings === "function") {
				try { ownerProps.openSettings(); return; } catch { /* 落到桥兜底 ✓ */ }
			}
			runMenuAction("openSettings");
		}

		/**
		 * 执行一个菜单动作（全部经页面桥交给 IDE/宿主）。
		 *
		 * ⚠ 旧宿主（桥 < 16/18）没有对应方法时必须**明说**，不许"点了没反应"✗
		 *   （本仓高频缺陷形态；`数据-*` 锚点也让守卫/e2e 能定位）。
		 */
		function runMenuAction(action) {
			if (action === "dshSettings") { openDshSettings(); return; }
			// ★ 2026-10-22：登录 / 登出优先走 dsh 侧 HTTP 面（不经 IDE）；老桥插件才退回页面桥
			if ((action === "signInIde" || action === "signOutIde") && tofHttpAction(action)) { return; }
			const api = bridgeApi();
			const missing = {
				openSettings: "当前宿主不支持「打开设置」（需要页面桥 18）",
				openFeedback: "当前宿主不支持「意见反馈」（需要页面桥 18）",
				signInIde: "当前宿主不支持从窗口登录（需要页面桥 17）",
				signOutIde: "当前宿主不支持从窗口登出（需要页面桥 17）",
			};
			if (typeof api[action] !== "function") {
				notify("warn", missing[action] || ("当前宿主不支持 " + action));
				return;
			}
			// 账号动作：先亮"进行中"，失败/宿主回绝就撤掉（不然文案会一直卡在"登录中" ✗）
			const isAuth = action === "signInIde" || action === "signOutIde";
			if (isAuth) { setPendingAction(action); }
			try {
				const p = api[action]();
				if (p && typeof p.catch === "function") {
					p.catch(() => { if (isAuth) { setPendingAction(""); } });
				}
			} catch (e) {
				if (isAuth) { setPendingAction(""); }
				notify("warn", "操作失败：" + String((e && e.message) || e));
			}
		}

		// ── 弹层（纯 DOM）──────────────────────────────────────────────────────
		let menuEl = null;

		function closeAccountMenu() {
			if (menuEl) {
				try { menuEl.remove(); } catch { /* 已被移除 */ }
				menuEl = null;
			}
			document.removeEventListener("mousedown", onMenuOutside, true);
			document.removeEventListener("keydown", onMenuKeydown, true);
		}
		function onMenuOutside(e) {
			if (menuEl && !menuEl.contains(e.target)) { closeAccountMenu(); }
		}
		function onMenuKeydown(e) {
			if (e && e.key === "Escape") { closeAccountMenu(); }
		}
		function el(tag, text, css, attrs) {
			const node = document.createElement(tag);
			if (text !== undefined && text !== null) { node.textContent = String(text); }
			if (css) { node.style.cssText = css; }
			if (attrs) { for (const k of Object.keys(attrs)) { node.setAttribute(k, attrs[k]); } }
			return node;
		}

		/**
		 * 打开账号菜单。`anchor` = 触发按钮的 `getBoundingClientRect()`（弹层贴在它**上方**，
		 * 与参照图一致：菜单在账号 chip 之上）。
		 */
		function openAccountMenu(anchor) {
			closeAccountMenu();
			const auth = readAuth();
			const box = el("div", undefined,
				"position:fixed;z-index:1000;min-width:180px;padding:6px;border-radius:10px;"
				+ "background:var(--dsw-alias-bg-layer-2,#232323);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));"
				+ "box-shadow:0 10px 28px rgba(0,0,0,.45);color:var(--dsw-alias-label-primary,inherit);font-size:12.5px;",
				{ "data-vssaros-account-menu": "1", role: "menu" });

			for (const it of menuItems(auth)) {
				const row = el("div", undefined,
					"display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border-radius:6px;cursor:pointer;",
					{ "data-vssaros-account-item": it.id, role: "menuitem" });
				row.appendChild(el("span", it.ico, "flex:0 0 auto;width:14px;text-align:center;opacity:.85;"));
				row.appendChild(el("span", it.label, "flex:1 1 auto;white-space:nowrap;"));
				if (it.hint) { row.appendChild(el("span", it.hint, "flex:0 0 auto;opacity:.5;font-size:11px;")); }
				row.addEventListener("mouseenter", () => { row.style.background = "var(--dsw-alias-bg-layer-3, rgba(128,128,128,.18))"; });
				row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
				row.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
				row.addEventListener("click", (e) => {
					try { e.preventDefault(); e.stopPropagation(); } catch { /* 老宿主 */ }
					closeAccountMenu();
					runMenuAction(it.action);
				});
				box.appendChild(row);
			}

			// ⚠ 弹层里**不再**重复画一个账号 chip：参照图里最下面那块（头像 + 名字）就是**触发按钮本身**
			//   （菜单浮在它上方）。重复画会变成"两个账号行"，用户上一轮刚要求过"只留一个入口" ✗。

			// 贴触发按钮**上方**；两轴夹进视口（超出视图矩形会被裁 ✗）
			const w = window.innerWidth || 0, h = window.innerHeight || 0;
			let x = anchor && typeof anchor.left === "number" ? Math.round(anchor.left) : 12;
			let y = anchor && typeof anchor.top === "number" ? Math.round(anchor.top) : h - 80;
			if (w > 0) { x = Math.max(8, Math.min(x, w - 200)); }
			box.style.left = x + "px";
			box.style.bottom = ""; // 先挂上去量高度，再决定 top（避免超出上边界）
			document.body.appendChild(box);
			const bh = box.offsetHeight || 0;
			const top = Math.max(8, y - bh - 6);
			box.style.top = top + "px";
			menuEl = box;
			document.addEventListener("mousedown", onMenuOutside, true);
			document.addEventListener("keydown", onMenuKeydown, true);
		}

		function AccountEntry(props) {
			// 记下槽的 ownerProps（`openSettings` = dsh 官方设置弹窗的开关）⇒ 弹层里的「设置」用得到 ✓
			ownerProps = props || null;
			const [auth, setAuth] = react.useState(readAuth);
			const [hover, setHover] = react.useState(false);
			// 「登录中 / 登出中」（点菜单项后亮起来；登录态推来或超时后复位）
			const [pending, setPending] = react.useState(getPendingAction);
			// 登录态来源：dsh 侧 HTTP 面（挂载即拉、窗口回到前台再拉）+ IDE 推来的事件（当作"重读"信号）✓
			react.useEffect(() => {
				const onTof = () => setAuth(readAuth());
				tofListeners.add(onTof);
				void fetchTofStatus();
				const onAuth = () => {
					// 老桥插件：IDE 推来即真相；有 HTTP 面：IDE 推来 ⇒ 去 dsh 重读一次
					if (tofHttp.available === true) { void fetchTofStatus(); } else { setAuth(readAuth()); }
					if (!tofHttp.pollTimer) { setPendingAction(""); }
				};
				const onFocus = () => { void fetchTofStatus(); };
				document.addEventListener(AUTH_EVENT, onAuth);
				window.addEventListener("focus", onFocus);
				return () => {
					tofListeners.delete(onTof);
					document.removeEventListener(AUTH_EVENT, onAuth);
					window.removeEventListener("focus", onFocus);
				};
			}, []);
			// 订阅"进行中"状态（模块级状态 ⇒ 组件用订阅拿，卸载时退订 ✓）
			react.useEffect(() => {
				const on = (v) => setPending(v);
				pendingListeners.add(on);
				return () => { pendingListeners.delete(on); };
			}, []);
			const name = displayName(auth);
			// ⚠ 文案要跟着状态走：登录中不能还显示"未登录"（用户会以为没点上）✓；登录完成后由推来的状态接管 ✓
			const label = pending === "signInIde" ? "登录中（请在浏览器里完成）"
				: pending === "signOutIde" ? "登出中…"
					: auth.expired ? "⚠ 登录已失效（请重新登录）"
						: auth.error ? "⚠ 登录失败：" + auth.error
							: (auth.signedIn ? name + (auth.team ? " · " + auth.team : "") : "未登录（企业账号）");
			return react.createElement("button", {
				type: "button",
				// ⚠ 稳定锚点（不随 hover / 登录态变）：守卫 ⑪ 与 e2e 都按它找
				"data-vssaros-account-trigger": "1",
				// 参照图里最下面那块「头像 + 名字」就是这一枚（菜单浮在它上方）⇒ chip 锚点挂在这里 ✓
				"data-vssaros-account-chip": auth.signedIn ? "1" : "0",
				"data-vssaros-account-signed-in": auth.signedIn ? "1" : "0",
				// ★ 失败原因也要看得见（2026-10-21）：页面桥单向 ⇒ 失败只能靠宿主推回来 ⇒
				//   显示在 chip 文案 + title 上 ⇒ 不再让用户干等超时兜底 ✓。
				//   ⚠ title 里同时说清**真实登录态**（失败 ≠ 已登出，两件事 ✓）。
				title: (pending
					? (pending === "signInIde" ? "正在登录（请在系统浏览器里完成）" : "正在登出…")
					: (auth.expired ? "企业身份已失效，点击后选「登录」重新登录"
						: auth.error ? "登录失败：" + auth.error + (auth.signedIn ? "（当前仍是已登录状态）" : "")
							: (auth.signedIn ? name : "未登录（企业账号）"))) + " —— 点击打开账号菜单",
				onClick: (e) => {
					try {
						const rect = e && e.currentTarget && typeof e.currentTarget.getBoundingClientRect === "function"
							? e.currentTarget.getBoundingClientRect() : undefined;
						openAccountMenu(rect);
					} catch { /* 老宿主没有事件对象方法 */ }
				},
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				style: {
					display: "flex", alignItems: "center", gap: 8, height: 32, width: "100%", padding: "0 8px",
					boxSizing: "border-box", border: "none", borderRadius: 8, textAlign: "left",
					fontFamily: "inherit", fontSize: 12, cursor: "pointer",
					color: "var(--dsw-alias-label-primary, inherit)",
					background: hover ? "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.22))" : "transparent",
				},
			},
				react.createElement("span", {
					style: {
						flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center",
						width: 20, height: 20, borderRadius: "50%", fontSize: 11, lineHeight: 1,
						background: "var(--dsw-alias-bg-elevated, rgba(255,255,255,.10))",
					},
				}, "👤"),
				react.createElement("span", {
					style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
				}, label),
			);
		}

		function install(ctx, shell) {
			const bridge = (shell && shell.bridge) || {};
			const state = (shell && shell.state) || {};
			/**
			 * 只在**带官方 chrome（有侧栏）**的页面接管账号行。
			 *
			 * ★★ 2026-10-24（用户报「左下角的 tof 登录按钮为什么会触发官方的登录，是 profile 错了么」）：
			 *   原来判据是 `surface === "full" || (chat && !chatOnly)` ⇒ **插件页（`surface=plugin-page`，
			 *   例如工具页 `/x/skills/?surface=editor`）被排除** ⇒ 我们那颗 TOF 账号行根本没装
			 *   ⇒ 左下角显示的是**官方账号入口**，点它就走 dsh 官方 DeepSeek 授权（真机日志：
			 *   `登录/外链弹窗 ⇒ 交给系统浏览器：https://platform.deepseek.com/dsh/authorize?…`，
			 *   而同期没有任何 `signInIde` / `tof` 调用 ✗✗）。
			 *   现在改成"**除纯聊天框以外都装**"：full / plugin-page / workbench / sessions / 默认都算 chrome，
			 *   只有 `surface=chat && chatOnly=true`（IDE 编辑器里那格裸聊天框）不装 ✓。
			 */
			const chrome = bridge.surface !== "chat" || bridge.chatOnly === false;
			if (!chrome) { return; }
			if (state.accountInstalled) { return; }

			AccountEntryRef = AccountEntry;
			// ⚠ `settings.launcher` 是 **single** 槽 ⇒ 用 priority -10 顶掉官方账号启动器（先例同 brand ✓）
			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register(
					{ name: SLOT, id: "vssaros-account", priority: -10 },
					AccountEntry,
				));
				state.accountRowRegistered = true;
			} catch (e) {
				state.accountRowError = String((e && e.message) || e);
			}
			state.accountInstalled = true;
		}

		exports.install = install;
		// 仅测试用：守卫 ⑪ **先跑 install**（拿 chrome 上下文）再渲染/断言 ✓
		exports.__test = {
			AUTH_EVENT, SLOT, TOF_API,
			menuItems, runMenuAction, displayName, openDshSettings,
			setPendingAction, getPendingAction, fromTofStatus, readAuth, tofHttp, fetchTofStatus,
			AccountEntry: (props) => (typeof AccountEntryRef === "function" ? AccountEntryRef(props) : null),
		};
		return module.exports;
	},
});
