// @vssaros/dsh-chat-surface — 侧栏页脚（品牌 + 规模摘要）
//
// 为什么有这个 chunk（2026-10-18，用户对比官方 desktop 的差异清单第 ③ 项）：
//   官方侧栏底部有「账号 + 版本」一行，我们这版只渲染出官方的「更多」按钮 ⇒ 视觉上少一块。
//   官方那行属于 `sidebar.settings` / `sidebar.footer.action` 家族的**账号插件**（需要账号与更新服务），
//   我们没有那些数据源 ⇒ **不伪造用户名/版本**，改为展示**真实可算**的东西：
//     「VsSaros · N 个工作区 · M 条会话」
//   数据：工作区 = IDE 推来的 `data-vssaros-workspaces` 记录（与多根侧栏同源）；
//        会话   = `ctx.sessions.list` 快照条数（roster，随订阅实时刷新）。
//   只注册到官方 `sidebar.footer.action` 列表槽（root 作用域，官方会在宽/窄两种形态下渲染 ✓）。
//
// 纪律：本 chunk **只在带官方 chrome 的视图**（`bridge.chatOnly === false` 或 surface=full）注册，
//   主窗口的 chat-only 聊天框里不出现（那里没有官方侧栏，注册了也看不见）✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.footer.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "sidebar.footer.action";
		const WORKSPACE_EVENT = "vssaros-dsh-workspaces";

		/** IDE 推来的工作区记录（与多根侧栏同源；解析失败一律当空，不抛 ✓）。 */
		function readRecords() {
			try {
				const raw = document.documentElement.dataset.vssarosWorkspaces;
				if (!raw) { return []; }
				const list = JSON.parse(raw);
				return Array.isArray(list) ? list : [];
			} catch { return []; }
		}

		function install(ctx, shell) {
			const bridge = (shell && shell.bridge) || {};
			const state = (shell && shell.state) || {};
			// 只给"带官方 chrome"的视图装（chat-only 的聊天框里没有官方侧栏）
			const chrome = bridge.surface === "full"
				|| (bridge.surface === "chat" && bridge.chatOnly === false);
			if (!chrome) { return; }

			const S = {
				row: {
					display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 8px",
					color: "var(--dsw-alias-label-tertiary, #737373)", fontSize: 11.5,
					whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
				},
				dot: { width: 6, height: 6, borderRadius: 3, background: "var(--dsw-alias-brand-primary, #297aa0)", flex: "0 0 auto" },
			};

			function Brand() {
				const [, setTick] = react.useState(0);
				react.useEffect(() => {
					let sub = null;
					try {
						const ss = ctx.sessions && ctx.sessions.list;
						if (ss && typeof ss.subscribe === "function") {
							// 会话条数变化时刷新（节流到 1s，避免高频重渲染）
							let last = 0;
							sub = ss.subscribe(() => {
								const now = Date.now();
								if (now - last < 1000) { return; }
								last = now;
								setTick((n) => n + 1);
							});
						}
					} catch { /* 订阅失败只影响刷新频率 */ }
					const onPush = () => setTick((n) => n + 1);
					document.addEventListener(WORKSPACE_EVENT, onPush);
					return () => {
						try { if (typeof sub === "function") { sub(); } } catch { /* 已释放 */ }
						document.removeEventListener(WORKSPACE_EVENT, onPush);
					};
				}, []);

				let sessions = 0;
				try {
					const snap = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
					sessions = snap && snap.byId ? Object.keys(snap.byId).length : 0;
				} catch { /* 快照不可读 ⇒ 0 */ }
				const workspaces = readRecords().length;
				state.footer = { workspaces, sessions };

				const text = "VsSaros · " + workspaces + " 个工作区 · " + sessions + " 条会话";
				return react.createElement("div", { style: S.row, title: text, "data-vssaros-footer": "1" },
					react.createElement("span", { style: S.dot }),
					react.createElement("span", null, text),
				);
			}

			state.footerInstalled = true;
			try {
				// ⚠ **list 槽要求 `id`**（不是 `key`）：报错原文
				//   `list slot "sidebar.footer.action" requires options.id`（2026-10-18 实测）。
				// ⚠ 自证必须写在 **inject 回调里**：写在回调外只证明"调用没抛"，而真正要回答的是
				//   "该槽到底有没有提供 / 有没有渲染" —— 2026-10-18 实测：回调**从未触发**
				//   （`footerRegistered` 一度恒 true 属误报 ✗，本行修正为槽出现时才置真）。
				// ⚠ **第二个参数必须是组件函数 `Brand`，不是元素 `createElement(Brand)`**：
				//   2026-10-18 真机 console：`slot entry crashed in 'sidebar.footer.action':
				//   Minified React error #130`（= 渲染了一个 object 而不是组件类型）。
				//   上一版我据"inject 回调没触发"断言"该槽本构建不渲染"——**结论错了**：槽其实渲染了，
				//   只是随即崩了（console 报错是铁证）；同文件族 `client.workspaces.js` 注册
				//   `sidebar.workspaces` 传的就是组件函数 `Browser` ✓。
				ctx.slots.inject(SLOT, () => {
					state.footerRegistered = true;
					return ctx.slots.register({ name: SLOT, id: "vssaros-brand" }, Brand);
				});
			} catch (e) {
				state.footerError = String((e && e.message) || e);
			}
		}

		exports.install = install;
		return module.exports;
	}
});
