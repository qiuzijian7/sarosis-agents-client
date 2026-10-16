// @vssaros/dsh-chat-surface — 会话标题：读出 + 接受重命名（供 VsSaros 外层页签使用）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.sessionLabel.js") 取回本模块的 install()。
//
// 口径（用户已确认 (b)）：**会话名显示在外层 VsSaros 编辑器标签上**，并可重命名。
// 本 chunk 负责**页面侧那一半**，且刻意**不动**页↔宿主协议（该协议正被另一条改动流重构）：
//   读：ctx.sessions.list.getSnapshot().byId[sid].title
//       （service.d.ts:19 `title?: string` —— *Latest durable log-backed title*；
//        :20 说明人性化标签的回落顺序是 title → project basename → session id）
//   写：ctx.sessions.rename(sessionId, title)（manager.d.ts:189；错误码 session/title-invalid）
//   交付给宿主：写进 DOM 事实（`document.documentElement.dataset.vssarosSessionTitle`），
//   并监听 `vssaros-dsh-rename`（宿主/preload 下发）→ 改完再派发 `vssaros-dsh-renamed` 回执。
//   ⇒ 宿主侧只需两件小事：① 标签文案取该 dataset；② 双击标签时派发 rename 事件（见交接说明）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.sessionLabel.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			const currentSid = () => state.sessionId || (bridge && bridge.sessionId) || null;
			state.sessionTitle = null;
			/** 读会话标题（取不到返回 null；不猜、不伪造）。 */
			function readTitle(sid) {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					const snap = list && list.getSnapshot();
					const summary = sid && snap && snap.byId ? snap.byId[sid] : undefined;
					const t = summary && typeof summary.title === "string" ? summary.title : null;
					return t && t.trim() ? t.trim() : null;
				} catch (e) {
					state.sessionTitleError = String((e && e.message) || e);
					return null;
				}
			}
			/** 把标题写进 DOM 事实：VsSaros 侧读它来更新编辑器标签文案。 */
			function publish(sid) {
				const t = readTitle(sid);
				state.sessionTitle = t;
				if (t) { document.documentElement.dataset.vssarosSessionTitle = t; }
				else { delete document.documentElement.dataset.vssarosSessionTitle; }
				// 上报宿主（preload 桥 `sessionTitle`）：宿主据此更新 VsSaros 编辑器标签文案。
				// 只在**变化时**上报（publish 会被轮询调用多次）；老桥没这个方法就静默跳过，
				// dataset 仍作为兜底事实存在（与 theme 同步同机制）。
				if (t !== state.sessionTitleReported) {
					state.sessionTitleReported = t;
					try {
						if (bridge && typeof bridge.sessionTitle === "function") { bridge.sessionTitle(t); }
					} catch (e) {
						state.sessionTitleError = String((e && e.message) || e);
					}
				}
				return t;
			}
			/** 重命名：走 dsh 官方 API；成功后重新发布标题并派发回执。 */
			function rename(sid, title) {
				const next = typeof title === "string" ? title.trim() : "";
				if (!sid || !next) { return Promise.reject(new Error("rename: sessionId/title required")); }
				const svc = ctx.sessions;
				const call = svc && typeof svc.rename === "function"
					? () => svc.rename(sid, next)
					: null;
				if (!call) { return Promise.reject(new Error("rename: ctx.sessions.rename unavailable")); }
				return Promise.resolve(call()).then((r) => {
					if (r && r.ok === false) { throw new Error("rename rejected: " + JSON.stringify(r.error || {}).slice(0, 160)); }
					const applied = publish(sid) || next;
					state.sessionRenames = (state.sessionRenames || 0) + 1;
					document.dispatchEvent(new CustomEvent("vssaros-dsh-renamed", { detail: { sessionId: sid, title: applied } }));
					return applied;
				}, (e) => {
					state.sessionRenameError = String((e && e.message) || e);
					document.dispatchEvent(new CustomEvent("vssaros-dsh-renamed", { detail: { sessionId: sid, error: state.sessionRenameError } }));
					throw e;
				});
			}
			// 暴露给其它 chunk 复用（client.settings.js 的「重命名会话」行）：
			// 同一份实现，避免两处 rename 逻辑漂移；外层页签靠 publish() 上报的标题跟随更新。
			state.renameSession = rename;

			// 宿主/preload 下发重命名请求（与既有 vssaros-dsh-rebind / theme 事件同机制）。
			document.addEventListener("vssaros-dsh-rename", (e) => {
				const d = (e && e.detail) || {};
				rename(d.sessionId || currentSid(), d.title).catch(() => undefined);
			});
			// 首次发布 + 会话切换/重绑后重发（标题是宿主投影的，可能晚到 ⇒ 轮询几次兜住）。
			const publishSoon = () => {
				publish(currentSid());
				let n = 0;
				const timer = setInterval(() => {
					if (publish(currentSid()) || ++n >= 8) { clearInterval(timer); }
				}, 500);
				window.addEventListener("pagehide", () => clearInterval(timer));
			};
			publishSoon();
			document.addEventListener("vssaros-dsh-rebind", () => publishSoon());
			state.sessionLabel = true;
		}
		exports.install = install;
		return module.exports;
	}
});
