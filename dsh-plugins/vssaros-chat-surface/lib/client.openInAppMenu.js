// @vssaros/dsh-chat-surface — 在官方「更多打开方式」下拉里加入 VsSaros（打开 IDE 窗口）
// package-local chunk：由 lib/client.js 的 **ALWAYS_CHUNKS** 无条件装载。
//
// ── 为什么必须单独一个无条件 chunk（2026-11-03 真机定案）────────────────────────
// 第一版把注入器放在 `client.openInApp.js`，结果带官方 chip 的 desktop 窗口**没装载那个 chunk**：
//   · 它在 PART_CHUNKS 里 ⇒ 只有 `surface === "chat"` 且会话绑定那支才装；
//   · desktop 主栏是 `surface === "full"` ⇒ 走 client.js:578 的独立 require 列表（不含它）；
//   · `surface === "workbench"` 更早退。
// 探针实证：有 `.OMoRSG_chevron` 的页面 `stateKeys` 只有 workspacesWide、
//   `performance` 里查不到 `client.openInApp.js` ⇒ 注入器从未安装。
// ⇒ 放进 ALWAYS_CHUNKS（`Promise.all` 在所有 surface 都跑，且早于任何早退分支）✓
//
// ── 为什么只能 DOM 注入（不能改数据源）───────────────────────────────────────
// 官方 `OpenInAppAction`（dsh-client-ui-open-in-app/lib/client.js:376）把 `controller.apps`
// （`/open-in-app/apps` 的 app id 数组）flatMap 成菜单项，且
// `APP_LABEL_KEY[id] === undefined` 的 id 会被**直接过滤掉** ⇒ 往 apps 里塞 vssaros 不显示；
// `APP_LABEL_KEY` / `controller` 都是模块私有；图标走 `/open-in-app/icon/<id>`、点击走
// `controller.launch()` POST `/open-in-app/open`，host 同样不认新 id ⇒ 三条路都封死。
// ⇒ 唯一稳妥落点：菜单（portal）出现后插入一个同结构 menuitem。
//
// 结构（真机 dump；CSS-module 类名是 hash ⇒ 一律从现有项 clone，不写死）：
//   <div role="menu"><div role="presentation"><div class="_itemWrap_…">
//     <button role="menuitem"><span class="_itemIcon_…"><img></span>
//     <span class="_itemLabel_…">…</span></button></div>…</div></div>
// 判据：菜单里必须有 `img[src*="open-in-app/icon/"]` ⇒ 只注入官方 open-in-app 菜单，
//   不会误伤会话 ⋯ / 模型 / 工作区等其它菜单。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.openInAppMenu.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const FLAG = "data-vssaros-open-in-app-vs";

		/** 打开 VsSaros IDE 窗口：宿主桥 focusIde（桥 16，showWindow + focusWindow，绝不新开 IDE）。 */
		function openIde(state) {
			const api = (typeof window !== "undefined" && window.vssarosDsh) || null;
			if (api && typeof api.focusIde === "function") {
				try {
					const p = api.focusIde();
					if (p && typeof p.catch === "function") {
						p.catch((e) => {
							state.openInAppVsSarosError = String((e && e.message) || e);
							try { api.notify && api.notify("warn", "打开 VsSaros IDE 失败：" + state.openInAppVsSarosError); } catch { /* 通知失败不阻塞 */ }
						});
					}
				} catch (e) {
					state.openInAppVsSarosError = String((e && e.message) || e);
					try { api.notify && api.notify("warn", "打开 VsSaros IDE 失败：" + state.openInAppVsSarosError); } catch { /* 通知失败不阻塞 */ }
				}
				return;
			}
			state.openInAppVsSarosError = "focusIde unavailable (bridgeVersion=" + (api && api.bridgeVersion) + ")";
			try { api && api.notify && api.notify("warn", "当前宿主不支持「打开 VsSaros IDE」（需要页面桥 16）"); } catch { /* 通知失败不阻塞 */ }
		}

		function install(ctx, shell) {
			const state = (shell && shell.state) || {};
			const doc = typeof document !== "undefined" ? document : null;
			if (!doc || !doc.body || typeof MutationObserver === "undefined") {
				state.openInAppVsSaros = "no-dom";
				return;
			}
			/**
			 * ★★ 2026-11-03（用户报「下拉框中 VsSaros 的 logo 显示错误，要求和项目保持一致」）：
			 *   之前这里自画了一个**蓝底白 V**，既不是品牌色也不是品牌几何 ✗。
			 *   ⇒ 逐字照抄项目正式 logo：
			 *     `src/vs/sessions/browser/media/sessions-logo-dark.svg`（light 版同内容），
			 *     `client.brand.js` 的 `BrandMark()` 用的也是同一份几何（同源，不另造）：
			 *       viewBox 512 / 白底 #FFFFFF / rx 96 / 描边 #FF5A2E / 两段 A140 弧 + r58 圆。
			 *   host 没有 `open-in-app/icon/vssaros` ⇒ 仍用内联 SVG data URI（避免 404 破图），
			 *   但内容必须与官方 SVG 一致；下方守卫会钉住这些特征值。
			 */
			let iconUrl = "";
			try {
				const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">'
					+ '<rect width="512" height="512" rx="96" fill="#FFFFFF"/>'
					+ '<g fill="none" stroke="#FF5A2E">'
					+ '<g stroke-width="16">'
					+ '<path d="M145.7 169.8 A140 140 0 0 1 366.3 169.8"/>'
					+ '<path d="M366.3 342.2 A140 140 0 0 1 145.7 342.2"/>'
					+ '</g>'
					+ '<circle cx="256" cy="256" r="58" stroke-width="30"/>'
					+ '</g></svg>';
				iconUrl = "data:image/svg+xml;base64," + btoa(svg);
			} catch (e) { iconUrl = ""; }

			/**
			 * ★ 2026-11-03 三次（用户报「移除 dsh 侧聊天框顶部的 VsSaros 按钮」）：
			 *   独立 chip（`data-vssaros-open-ide`）在 0.2.309 已从 client.sessions.js 删除，
			 *   但**旧 chunk 可能仍被浏览器缓存**、或同一个 app 里 dev/prod 版本混跑 ⇒ 顶部还会出现。
			 *   ⇒ 无条件部件里做一次兜底：任何残留的独立按钮一律从 DOM 移除。
			 *   VsSaros 只保留在官方「更多打开方式」下拉里（用户上一轮明确要求）。
			 */
			const removeStandaloneChip = () => {
				try {
					const stale = doc.querySelectorAll('[data-vssaros-open-ide]');
					for (let i = 0; i < stale.length; i++) {
						const n = stale[i];
						if (n.parentNode) { n.parentNode.removeChild(n); }
					}
					if (stale.length) { state.openInAppVsSarosRemovedStale = (state.openInAppVsSarosRemovedStale || 0) + stale.length; }
				} catch (e) { /* 清理失败不影响下拉项 */ }
			};

			/** 找到官方 open-in-app 下拉并插入一项；FLAG 判重（注入本身也会触发 observer）。 */
			const scan = () => {
				removeStandaloneChip();
				let menus = [];
				try { menus = Array.prototype.slice.call(doc.querySelectorAll('[role="menu"]')); } catch (e) { return; }
				for (const menu of menus) {
					let sampleImg = null;
					try { sampleImg = menu.querySelector('img[src*="open-in-app/icon/"]'); } catch (e) { continue; }
					if (!sampleImg) { continue; }
					let viewport = null;
					try { viewport = menu.querySelector('[role="presentation"]'); } catch (e) { continue; }
					if (!viewport) { continue; }
					try { if (viewport.querySelector("[" + FLAG + "]")) { continue; } } catch (e) { continue; }
					let sampleWrap = null;
					try { sampleWrap = viewport.querySelector("div"); } catch (e) { continue; }
					if (!sampleWrap) { continue; }
					let wrap;
					try { wrap = sampleWrap.cloneNode(true); } catch (e) { continue; }
					wrap.setAttribute(FLAG, "1");
					let btn = null;
					try { btn = wrap.querySelector('[role="menuitem"]') || wrap.querySelector("button"); } catch (e) { /* 继续 */ }
					if (!btn) { continue; }
					try {
						const spans = wrap.querySelectorAll("span");
						const label = spans.length ? spans[spans.length - 1] : null;
						if (label) { label.textContent = "VsSaros"; }
					} catch (e) { /* 文本改不了就保留克隆文本 */ }
					try {
						const img = wrap.querySelector("img");
						if (img && iconUrl) { img.setAttribute("src", iconUrl); img.removeAttribute("srcset"); }
					} catch (e) { /* 图标失败不影响这一项 */ }
					try { btn.setAttribute("title", "打开 VsSaros IDE 窗口"); } catch (e) { /* 忽略 */ }
					try { btn.setAttribute("aria-label", "打开 VsSaros IDE 窗口"); } catch (e) { /* 忽略 */ }
					// 捕获阶段拦下点击：不让 React 的菜单委托把它当成官方 app 项处理
					btn.addEventListener("click", (ev) => {
						try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* 合成事件 */ }
						/**
						 * ★★ 2026-11-03 四次（用户报「点下拉里的 VsSaros 后，聊天框顶部 UI 消失」）：
						 *   原来点击后手动 `menu.parentNode.removeChild(menu)` —— 菜单是 **React portal**，
						 *   手动删节点会让 React 下一次 render 去移除一个已不存在的子节点 ⇒ 抛
						 *   `NotFoundError: ... removeChild ...` ⇒ React 卸载整棵子树 ⇒ 头部那排 chip 全没 ✗。
						 *   ⇒ 现在**只派发 Escape**，让官方菜单组件自己 setMenuOpen(false) 并正常卸载；
						 *     绝不碰它管理的 DOM。
						 */
						try { doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (e) { /* 忽略 */ }
						openIde(state);
					}, true);
					try {
						viewport.appendChild(wrap);
						state.openInAppVsSaros = "injected";
					} catch (e) {
						state.openInAppVsSaros = "inject-failed:" + String((e && e.message) || e);
					}
				}
			};

			const mo = new MutationObserver(() => scan());
			try {
				mo.observe(doc.body, { childList: true, subtree: true });
				state.openInAppVsSaros = "installed";
				scan();
				// 生命周期清理（ALWAYS 分支的 ctx.effect 可能缺席 ⇒ 容错）
				try {
					ctx.effect(() => () => { try { mo.disconnect(); } catch (e) { /* 已断开 */ } },
						"vssaros: open-in-app VsSaros menu item");
				} catch (e) { /* 无 ctx.effect 时留在页面生命周期内，不影响功能 */ }
			} catch (e) {
				state.openInAppVsSaros = "observer-failed:" + String((e && e.message) || e);
			}
		}

		exports.install = install;
		return module.exports;
	}
});
