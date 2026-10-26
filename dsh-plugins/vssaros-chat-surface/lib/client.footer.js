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
// ★ 「回到 IDE」入口的归属变更（2026-10-21，两轮）：
//   第一轮本 chunk 注册过 `sidebar.panellist` 行（id `vssaros-ide`，order 12）+ 中栏中转面板；
//   第二轮用户要求"回到 ide 按钮移动到 logo 右侧" ⇒ 整段搬去 `client.brand.js`（品牌行 = logo 右侧），
//   **本 chunk 从此只画页脚那行信息文本**，不再注册 panellist / main 槽 ✓。
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
			// 幂等：本 chunk 现在有**两条装载路径** —— `PART_CHUNKS`（chat 形态）与主包
			// 「带官方 chrome」那段单独 `require.async`（full 形态 / 2026-10-21 为「回到 IDE」入口补的）。
			// 两段在 chat+chrome 的桌面窗口里会**都**走到 ⇒ 不加这行就会同 id 注册两次
			// （`sidebar.footer.action` 是 list 槽，同 id 会互相顶掉/报错）✗。
			if (state.footerInstalled) { return; }

			const S = {
				// 2026-10-21（对齐 dsh-desktop）：页脚统计是**次要信息** ⇒ 11.5px/24 降到 10.5px/20，
				// 并把透明度压一档；主入口（工作台 / 回到 IDE / 插件）才是行按钮 ✓。
				row: {
					display: "flex", alignItems: "center", gap: 6, height: 20, padding: "0 8px",
					color: "var(--dsw-alias-label-tertiary, #737373)", fontSize: 10.5, opacity: .92,
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
				let blanks = 0;
				try {
					const snap = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
					const byId = snap && snap.byId ? snap.byId : null;
					if (byId) {
						const ids = Object.keys(byId);
						sessions = ids.length;
						// ★ 2026-10-26：侧栏已隐藏**空会话**（官方 roster 的 blank 位）⇒ 页脚口径
						//   必须跟着走，否则"118 条会话"和"1931 条会话"两个数字同时出现在屏幕上 ✗。
						//   空会话的条数**如实写出来**（不装作没有）✓。
						blanks = ids.filter((id) => byId[id] && byId[id].blank === true).length;
						sessions -= blanks;
					}
				} catch { /* 快照不可读 ⇒ 0 */ }
				const workspaces = readRecords().length;
				state.footer = { workspaces, sessions, blanks };

				const text = "VsSaros · " + workspaces + " 个工作区 · " + sessions + " 条会话"
					+ (blanks > 0 ? "（另有 " + blanks + " 条空会话已隐藏）" : "");
				// ⚠ 这一行是**信息**（别再做成"可点的灰字"：用户看不出能点 ✗）。
				//   「回到 IDE」按钮现在挂在品牌行右侧（`client.brand.js` 的 BrandName）✓。
				return react.createElement("div", { style: S.row, title: text, "data-vssaros-footer": "1" },
					react.createElement("span", { style: S.dot }),
					react.createElement("span", null, text),
				);
			}

			// ★ 2026-10-21（用户："回到 ide 按钮移动到 logo 右侧"）：这里原来注册的
			//   `sidebar.panellist` 行「🖥 回到 IDE」（+ 中栏中转面板）**已整段搬走**，
			//   现在只由 `client.brand.js` 的 `BrandName`（品牌行 = logo 右侧）渲染那枚按钮 ✓。
			//   所以本 chunk 只剩**信息行**：不再注册任何 panellist / main 槽。
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
