// @vssaros/dsh-chat-surface — 侧栏「工作台」单入口启动器（稿 C，2026-10-17 用户拍板；
// 4 稿对比 mockup doc/dsh-workbench-layout-mockup.html；前一版=每条目一行 panellist，
// 11 行把 Workspaces 区挤没 ⇒ 废弃，改单入口 + 弹层网格）。
// package-local chunk（契约同 client.sessions.js）：主包用 require.async 取回 install()。
//
// ── 形态 ────────────────────────────────────────────────────────────────
// 侧栏 Plugins / Automation tasks 下方只有**一行**「🗂 工作台 ⑪」：
//   · 点击 → 弹出 4 列网格启动器（图标+名字），选哪个开哪个；排序编辑（✎）在弹层里
//     （拖拽 / ↑↓，localStorage 持久化，恢复默认）。
//   · 侧栏按钮的点击归官方（会把中栏切到同 id 的 main 面板，拦不了也不拦）⇒
//     我们的 main 面板是**中转**：挂载时开弹层 + `ctx.layout.selectPanel(null)` 弹回会话，
//     聊天框不被占用 ✓。
//   · 条目落点 = **右侧栏页签**（sidebar.right.pane.tab，iframe 载 /x/<module>/）——
//     不占中栏 ✓（2026-10-17 用户要求）。服务缺失 / 无会话开签失败 ⇒ bridge.notify 明示 ✗ 不静默。
//
// ── 无会话在屏的修复（2026-10-17 真机：点条目右栏没内容）─────────────────────
// 官方 sidebarRight.openTab 作用于"屏幕上的会话"，无会话 ⇒ fails loudly（service.d.ts 原话）。
// 病根在**主包**：会话绑定曾被 `surface !== "chat"` 早退挡住 ⇒ full 弹窗停在 hero
// 「Choose workspace to start」（用户截图实证）⇒ openTab 无的放矢 ✗。
// 修法在主包（client.js）：绑定提升到 chat/full 都生效（openSession 轮询 + alignWorkspace）。
// 本 chunk 不再自己轮询，只在**点击那一刻**读 DOM 事实（[data-sidebar-right-session]，与主包
// 同口径 ✓）：没就绪就 notify 明示"会话还在打开中"（主包轮询正在重试，稍等再点即可）✓。
//
// ── 官方机制（dsh-cordis-client-runner CLIENT_SLOT_API 实证）────────────────
// · sidebar.panellist（list / root）：官方 plugins=0 / schedules=10；我们单行取 order 20 ✓。
// · main（keyed / root）：key 与图标 id 同值（vssaros-workbench）⇒ 点图标中栏选中它（中转）。
// · sidebar.right.pane.tab（keyed / session）：页签体按 tab kind 派发；类型先经
//   `ctx.sidebarRightTabs.register({id,kind,priority,title})` 登记（schedule 同款 ✓）。
// · ⚠ 主窗口聊天框是 chat-only 形态，侧栏整列被 CSS 裁掉 ⇒ 本入口**只在全窗**可见；
//   chat 形态注册是无害空转 ✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.workbenchNav.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT_NAV = "sidebar.panellist";
		const SLOT_MAIN = "main";
		const SLOT_RIGHT_TAB = "sidebar.right.pane.tab";
		const ENTRY_ID = "vssaros-workbench";
		/** 官方：plugins=0 / schedules=10（见文件头）⇒ 单行取 20，永不撞 ✓。 */
		const ENTRY_ORDER = 20;
		const LS_KEY = "vssaros.wbNav.order";

		/** 工作台条目（默认顺序；route 以各插件 cordis.patch.yml 的自托管路由为准）。 */
		const DEFAULT_ITEMS = [
			{ id: "vssaros-wb-dashboard", name: "主页", ico: "🏠", route: "/x/dashboard/" },
			{ id: "vssaros-wb-sessions", name: "会话", ico: "💬", route: "/x/sessions/" },
			{ id: "vssaros-wb-agents", name: "Agents", ico: "🤖", route: "/x/agents/" },
			{ id: "vssaros-wb-kanban", name: "看板", ico: "🗂️", route: "/x/kanban/" },
			{ id: "vssaros-wb-workflow", name: "工作流", ico: "🔀", route: "/x/workflow/" },
			{ id: "vssaros-wb-kb", name: "知识库", ico: "📚", route: "/x/kb/" },
			{ id: "vssaros-wb-memory", name: "记忆库", ico: "🧠", route: "/x/memory/" },
			{ id: "vssaros-wb-codebase", name: "代码库", ico: "🕸️", route: "/x/codebase/" },
			{ id: "vssaros-wb-media", name: "媒体库", ico: "🖼️", route: "/x/media/" },
			{ id: "vssaros-wb-skills", name: "工具", ico: "🧰", route: "/x/skills/" },
			{ id: "vssaros-wb-scheduler", name: "定时任务", ico: "⏰", route: "/x/scheduler/" },
		];

		function loadOrder() {
			try {
				const raw = window.localStorage && window.localStorage.getItem(LS_KEY);
				const saved = raw ? JSON.parse(raw) : null;
				if (!Array.isArray(saved)) { return DEFAULT_ITEMS.slice(); }
				const byId = new Map(DEFAULT_ITEMS.map((i) => [i.id, i]));
				const out = saved.map((id) => byId.get(id)).filter(Boolean);
				for (const it of DEFAULT_ITEMS) { if (out.indexOf(it) < 0) { out.push(it); } } // 新条目补尾
				return out;
			} catch { return DEFAULT_ITEMS.slice(); }
		}
		function saveOrder(items) {
			try { window.localStorage && window.localStorage.setItem(LS_KEY, JSON.stringify(items.map((i) => i.id))); } catch { /* 私有模式等：不存也能用 */ }
		}

		/**
		 * 从会话快照里挑**最近更新**的一条（兜底进会话用；纯逻辑 ⇒ 守卫 ⑥ 钉住）。
		 *
		 * 口径：`updatedAt` 优先、回落 `createdAt`（都缺 ⇒ 0，仍可被选中：宁可开一条旧的也别停在 hero）；
		 * 归档的一律不选（进了也只会看到"已归档"空屏 ✓）。时间相同按 id 兜底排序，结果稳定。
		 */
		function pickLatestSessionId(byId, archivedIds) {
			const archived = Array.isArray(archivedIds) ? archivedIds : [];
			let best = null;
			for (const id of Object.keys(byId || {})) {
				if (archived.indexOf(id) >= 0) { continue; }
				const s = (byId || {})[id] || {};
				const at = (typeof s.updatedAt === "number" && s.updatedAt) || (typeof s.createdAt === "number" && s.createdAt) || 0;
				if (!best || at > best.at || (at === best.at && id < best.id)) { best = { id, at }; }
			}
			return best ? best.id : null;
		}

		function install(ctx, shell) {
			const bridge = shell && shell.bridge;
			const state = (shell && shell.state) || {};
			let items = loadOrder();

			// ── 会话就绪判定：点击那一刻读 DOM 事实（主包负责把会话打开，见文件头）─────────
			const sid = bridge && typeof bridge.sessionId === "string" && bridge.sessionId ? bridge.sessionId : null;
			function sessionOnScreen() {
				try {
					return !!(sid && document && typeof document.querySelector === "function"
						&& document.querySelector('[data-sidebar-right-session="' + sid + '"]'));
				} catch { return false; }
			}
			/**
			 * **任意**会话在屏就算"可用"。
			 *
			 * 为什么必须区分（2026-10-17 自查出的真 bug）：救援打开的是**另一条**会话，
			 * 而 `sessionOnScreen()` 只认绑定的那个 sid ⇒ 救援成功后它仍为 false ⇒
			 * 循环会一直重试到 90 秒、再误报一条"失败"诊断条 ✗✗。
			 * 官方右栏/页签只需要"屏幕上有一条会话"（`sidebarRight` 是 per-session 的）✓。
			 */
			function anySessionOnScreen() {
				try {
					return !!(document && typeof document.querySelector === "function"
						&& document.querySelector("[data-sidebar-right-session]"));
				} catch { return false; }
			}

			// ── 停在 hero（无会话在屏）时的兜底：**自动进最近一个会话**（2026-10-17 真机三条反馈的同一真因）─
			// 「缺右栏伸缩按钮」「点工作台条目右栏没内容」「输入框不能打字」都发生在 **hero**（无会话）：
			// 右栏页签（sidebarRight.openTab）与官方伸缩按钮（conversation.session.header.corner）
			// 都是 **session 作用域** —— hero 下结构上就没有可挂载的位置 ✗。
			// 从非聊天上下文弹出的全窗（bridge.sessionId 为空）因此必然坏在这一层 ⇒ 这里静默兜底：
			// 轮询会话快照，挑**最近更新**的一条，对齐工作区后 openSession（与聊天主包同顺序 ✓）。
			// 一旦成功就不再干预（用户之后自己切换会话不受影响 ✓）。
			// ★ 2026-10-17 二次真机（「输入框无法输入信息」）：**有绑定值也兜**。
			//   官方 hero 输入框在 `inert` 时是禁用的（`dsh-client-ui-conversation/lib/client.js:17587`：
			//   `inert = sessionId === undefined || (hero && chipTitle === undefined)`）⇒ 用户看到的
			//   "不能打字"永远是"没进会话"的症状。而 `bridge.sessionId` 非空**不代表那个会话开得出来**
			//   （Host 侧已不存在 / roster 不认）——主包轮询 120s 后放弃，界面就停死在禁用的 hero ✗。
			//   ⇒ 两种态都兜：无绑定 ⇒ 立刻救；有绑定但 15s 还没在屏 ⇒ 也救（挑最近更新的会话）。
			if (typeof window.setInterval === "function" && typeof document !== "undefined") {
				const startedAt = Date.now();
				const WAIT_FOR_BOUND_MS = 15000;   // 有绑定值时先给主包这些时间（正常几百 ms 就开出来 ✓）
				const RESCUE_GIVE_UP_MS = 90000;
				let lastAttemptAt = 0;
				let announced = false;
				let gaveUp = false;
				let lastRescueWorkspaceAt = 0;
				/** `sessions.create` 兜底已试次数（上限 2：别把会话列表刷出一堆空会话 ✗） */
				let createAttempts = 0;
				// ★ 2026-10-17：连接闸门**必与主包共享**（`client.js` 的 connectFor/navigate 用同一个
				//   `window.__vssarosNav`）。各自维护 pending ⇒ 两边交替 openWorkspace 互相 abort，
				//   roster 永远空、openSession 永远 "unknown session"（真机 `roster:0 / giveUps:1` ✗）。
				const navState = (window.__vssarosNav = window.__vssarosNav || { connecting: null, aligned: null });
				const timer = window.setInterval(() => {
					// ★ 停止条件是"**任意**会话在屏"（救援开的是另一条；见 anySessionOnScreen 的注释 ✓）
					if (anySessionOnScreen()) {
						window.clearInterval(timer);
						if (state.rescue) { state.rescue.done = true; }
						return;
					}
					const waited = Date.now() - startedAt;
					if (sid && waited < WAIT_FOR_BOUND_MS) { return; }
					if (waited > RESCUE_GIVE_UP_MS) {
						// ★ 2026-10-17 第二轮真机：roster 可能**晚到**（拉取被下一次覆盖 / 慢）⇒
						//   从前这里直接 clearInterval，晚到的数据再没人消费，界面永久停在 hero ✗。
						//   ⇒ 诊断条只亮一次，重试降频到 30s **继续尝试**（自愈）。
						if (!gaveUp) { gaveUp = true; showRescueFailure(); }
						if (Date.now() - lastAttemptAt < 30000) { return; }
					}
					if (Date.now() - lastAttemptAt < 3000) { return; }   // 打开尝试节流（成功与否看下一轮 anySessionOnScreen ✓）
					lastAttemptAt = Date.now();
					try {
						const snap = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
						const byId = (snap && snap.byId) || {};
						const archived = (snap && snap.archivedSessionIds) || [];
						const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
						const wsSnap = ws && ws.list ? ws.list.getSnapshot() : null;
						const wsItems = ((wsSnap && wsSnap.items) || []).filter((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.length > 0);
						// ★★ 2026-10-17 真机自证给出的真因：**全窗页面的 `ctx.sessions.list` roster 恒为 0**
						//   （chat 视图里 opened=true，同一 Host；见主进程日志的 page surface 快照）。
						//   而 roster 只装"已 retain"的会话 ⇒ 只从 roster 挑候选＝永远挑不到 ✗✗。
						//   候选必须从 **workspaces 快照**（它带 sessionIds，且与页面侧栏同源 ✓）里取：
						//   ① 优先"绑定 sid 所在的条目"；② 否则取会话数最多的条目；③ 再取它的最后一个会话。
						//   顺序也必须是 **openWorkspace → openSession**：前者才会把该工作区的会话载入 roster ✓。
						let owner = sid ? wsItems.filter((w) => w.sessionIds.indexOf(sid) >= 0)[0] : null;
						if (!owner && wsItems.length > 0) {
							owner = wsItems.slice().sort((a, b) => b.sessionIds.length - a.sessionIds.length)[0];
						}
						const bestId = (sid && (!owner || owner.sessionIds.indexOf(sid) >= 0) ? sid : null)
							|| (owner ? owner.sessionIds[owner.sessionIds.length - 1] : null)
							|| pickLatestSessionId(byId, archived);
						// ★ 页面自证（宿主日志会打出来）：救援每次尝试都留证 —— 这是"为什么没进会话"的唯一线索 ✓
						state.rescue = {
							at: Date.now(),
							boundSid: sid || null,
							picked: bestId || null,
							roster: Object.keys(byId).length,
							workspaces: wsItems.length,
							owner: owner ? owner.workspaceId : null,
							waitedMs: waited,
						};
						if (!bestId) {
							state.rescue.error = "既没有 workspaces 条目也没有 roster";
							return;
						}
						if (typeof document !== "undefined" && document.body) {
							document.body.dataset.vssarosAutoEnter = "tried:" + bestId;
						}
						const open = () => {
							// 连接在飞时**不发导航**（openSession 会 beginNavigation ⇒ abort 连接 ✗）
							if (navState.connecting) { return; }
							/**
							 * 失败处理 + **roster 空时的建会话兜底**。
							 *
							 * ★★ 2026-10-18 真机日志定位：`uiWorkspace.openSession()` 返回的是
							 * **Promise**，而我们从没接过它 ⇒ `sessions.retain: unknown session` 的
							 * reject 变成"未处理的 Promise 拒绝" ⇒ 界面零反应、`rescue.error` 也是空
							 * （日志里 `attempts=68 / openRetries=0 / lastOpenError=null` 正是这个形态 ✗✗）。
							 * 而同一份日志还证明：`openWorkspace` **能成功**（无 openWorkspaceError）、
							 * `workspaces` 快照有 4 条 —— 只有 `sessions.refresh()` 永不返回（4 次超时、
							 * roster 恒 0）⇒ **会话 catalog 这条路在这个页面就是死的**，
							 * 必须改走能通的 RPC：`sessions.create({ workspaceId })` 直接建一条会话再打开 ✓。
							 */
							const onRejected = (err) => {
								const msg = String((err && err.message) || err || "");
								if (!msg) { return; }
								if (state.rescue) { state.rescue.openSessionError = msg; }
								if (/unknown session/i.test(msg)) { createAndOpen(); return; }
								if (!announced) { announced = true; notify("warn", "打开会话失败：" + msg); }
							};
							const createAndOpen = () => {
								const svc = ctx.sessions;
								if (createAttempts >= 2 || !svc || typeof svc.create !== "function") { return; }
								const workspaceId = owner && owner.workspaceId;
								if (!workspaceId) { return; }
								createAttempts += 1;
								if (state.rescue) { state.rescue.createAttempts = createAttempts; }
								void Promise.resolve(svc.create({ workspaceId })).then((res) => {
									const id = typeof res === "string" ? res
										: (res && (res.sessionId || res.id || (res.session && res.session.id))) || null;
									if (state.rescue) { state.rescue.created = id; }
									if (!id) { return; }
									if (typeof document !== "undefined" && document.body) {
										document.body.dataset.vssarosAutoEnter = "created:" + id;
									}
									// 新会话必然在 roster 里（create 的返回值就是 retained 的 id）⇒ 直接开
									void Promise.resolve(ctx.uiWorkspace.openSession(id)).catch((e) => {
										if (state.rescue) { state.rescue.openCreatedError = String((e && e.message) || e); }
									});
								}).catch((e) => {
									if (state.rescue) { state.rescue.createError = String((e && e.message) || e); }
								});
							};
							try {
								const r = ctx.uiWorkspace.openSession(bestId);
								if (r && typeof r.then === "function") {
									r.then(() => { if (state.rescue) { state.rescue.openAccepted = true; } }, onRejected);
								}
							} catch (e) { onRejected(e); }
						};
						// 连接同样走共享闸门：没有在飞、且还没连上时才发；成功后交回 open() 导航。
						const nowMs = Date.now();
						const canOpenWorkspace = owner && ctx.uiWorkspace && typeof ctx.uiWorkspace.openWorkspace === "function"
							&& !navState.connecting && !navState.aligned && (nowMs - lastRescueWorkspaceAt > 8000);
						if (canOpenWorkspace) {
							lastRescueWorkspaceAt = nowMs;
							const connecting = Promise.resolve(ctx.uiWorkspace.openWorkspace(owner.workspaceId));
							navState.connecting = connecting;
							void connecting.then(
								() => { navState.connecting = null; navState.aligned = true; open(); },
								(e) => {
									navState.connecting = null;
									if (state.rescue) { state.rescue.openWorkspaceError = String((e && e.message) || e); }
									open();
								},
							);
						} else if (!navState.connecting) {
							open();
						}
						if (!announced) {
							announced = true;
							notify("info", sid ? "会话打开超时，已切换到最近一次会话" : "弹窗未绑定会话，已进入最近一次会话");
						}
					} catch (e) {
						state.rescue = { at: Date.now(), error: "rescue threw: " + String((e && e.message) || e) };
					}
				}, 1000);
			}

			/**
			 * 救援失败的**可见诊断条**（仅在全窗 hero 卡死时出现）。
			 *
			 * 为什么要有：用户报障只能给截图，而"没进会话"可能坏在四个不同环节
			 * （视图无 sessionId / preload 没给 / roster 不认该会话 / Host 侧已删除），
			 * 单看界面全是同一张 hero ⇒ 必须把判据摆到脸上 ✓。
			 * `state` 里的 `opened/attempts/openRetries/lastOpenError` 由主包维护（同一 shell.state）。
			 */
			function showRescueFailure() {
				try {
					if (typeof document === "undefined" || !document.body) { return; }
					if (document.querySelector("[data-vssaros-rescue]")) { return; }
					const st = state || {};
					const lines = [
						"弹窗未能进入会话（处于 hero：输入框被官方 inert 禁用）",
						"view sessionId = " + (sid || "(空)"),
						"session on screen = " + (anySessionOnScreen() ? "yes" : "no"),
						"attempts=" + (st.attempts ?? 0) + " openRetries=" + (st.openRetries ?? 0) + " giveUps=" + (st.openGiveUps ?? 0),
						"lastOpenError = " + (st.lastOpenError || st.lastError || st.error || "(无)"),
						"autoEnter = " + ((document.body && document.body.dataset.vssarosAutoEnter) || "(未触发)"),
					];
					const box = document.createElement("div");
					box.setAttribute("data-vssaros-rescue", "1");
					box.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9999;max-width:min(560px,calc(100vw - 24px));padding:10px 12px;border-radius:10px;background:rgba(170,52,52,.94);color:#fff;font:12px/1.6 Consolas,monospace;white-space:pre-wrap;box-shadow:0 8px 24px rgba(0,0,0,.4)";
					box.textContent = lines.join("\n");
					document.body.appendChild(box);
				} catch { /* 诊断条本身绝不能影响别的 ✓ */ }
			}

			// ── 页面本体（右侧栏页签体；keyed slot，key = tab kind = 条目 id）───────────
			function PageBody(it) {
				return function WbPageBody() {
					return react.createElement("iframe", {
						src: it.route, title: it.name,
						style: { display: "block", flex: "1 1 auto", minHeight: 0, height: "100%", border: 0, width: "100%", background: "transparent" },
					});
				};
			}
			for (const it of DEFAULT_ITEMS) {
				ctx.slots.inject(SLOT_RIGHT_TAB, () => ctx.slots.register({ name: SLOT_RIGHT_TAB, key: it.id }, PageBody(it)));
				// 页签类型登记（schedule 同款通路；effect 包裹 ⇒ 服务缺失时只影响这条，不拖垮 install ✓）。
				ctx.effect(() => ctx.sidebarRightTabs.register({
					id: it.id, kind: it.id, priority: "extension", title: () => it.name,
				}), "vssaros-wb:" + it.id);
			}

			/** 打开一个工作台条目：优先右侧栏页签；未就绪/失败 ⇒ notify 明示（不静默 ✗）。 */
			function openItem(it) {
				if (anySessionOnScreen() && ctx.sidebarRight && typeof ctx.sidebarRight.openTab === "function") {
					try {
						ctx.sidebarRight.openTab(it.id);
						return;
					} catch (e) {
						notify("warn", it.name + " 打开失败：" + String((e && e.message) || e));
						return;
					}
				}
				if (sid && !sessionOnScreen()) {
					notify("info", "会话还在打开中，请稍候再点（" + it.name + "）");
					return;
				}
				notify("warn", "当前窗口没有会话，" + it.name + " 的侧栏页签无处挂载；请先从会话入口进一段会话");
			}
			function notify(kind, text) {
				if (bridge && typeof bridge.notify === "function") {
					try { bridge.notify(kind, text); } catch { /* 通知失败不影响别的 */ }
				}
			}

			// ── 中栏面板 = **中转**：挂载即开弹层 + 弹回会话（不占用聊天框 ✓）────────────
			function LauncherPanel() {
				react.useEffect(() => {
					openLauncher();
					try {
						if (ctx.layout && typeof ctx.layout.selectPanel === "function") {
							ctx.layout.selectPanel(null);   // null = 回到 Conversation（官方 API 语义 ✓）
						}
					} catch { /* 弹回失败就留在本面板：下方占位文案如实说明 ✓ */ }
				}, []);
				return react.createElement("div", {
					style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", fontSize: 12, opacity: .6 },
				}, "🗂 工作台：请在左侧弹层里选择条目");
			}
			ctx.slots.inject(SLOT_MAIN, () => ctx.slots.register({ name: SLOT_MAIN, key: ENTRY_ID }, LauncherPanel));

			// ── 侧栏单行入口（list 槽；label 由官方侧栏投影）─────────────────────────
			function EntryIcon(props) {
				const size = props && typeof props.size === "number" ? props.size : 16;
				return react.createElement("span", {
					title: "工作台",
					style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, fontSize: Math.round(size * 0.8), lineHeight: 1 },
				}, "🗂");
			}
			ctx.slots.inject(SLOT_NAV, () => ctx.slots.register(
				{ name: SLOT_NAV, id: ENTRY_ID, order: ENTRY_ORDER, label: "工作台" },
				EntryIcon,
			));

			// ── 启动器弹层（纯 DOM；chunk 只能 require react ⇒ 弹层不走 react-dom portal）──
			let launcherEl = null;
			let editing = false;
			function closeLauncher() {
				if (launcherEl) { try { launcherEl.remove(); } catch { /* 已被移除 */ } launcherEl = null; }
				editing = false;
				document.removeEventListener("mousedown", onLauncherOutside, true);
			}
			function onLauncherOutside(e) {
				if (launcherEl && !launcherEl.contains(e.target)) { closeLauncher(); }
			}
			function moveItem(idx, dir) {
				const j = idx + dir;
				if (j < 0 || j >= items.length) { return; }
				const t = items[idx]; items[idx] = items[j]; items[j] = t;
				saveOrder(items);
				renderLauncherBody();
			}
			function el(tag, text, css) {
				const n = document.createElement(tag);
				if (text !== undefined) { n.textContent = text; }
				if (css) { n.style.cssText = css; }
				return n;
			}
			function renderLauncherBody() {
				if (!launcherEl) { return; }
				const body = launcherEl.querySelector("[data-wb-body]");
				if (!body) { return; }
				body.innerHTML = "";
				if (!editing) {
					const grid = el("div");
					grid.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:6px;";
					for (const it of items) {
						const cell = el("div");
						cell.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 2px;border-radius:8px;cursor:pointer;font-size:17px;";
						cell.onmouseenter = () => { cell.style.background = "rgba(128,128,128,.14)"; };
						cell.onmouseleave = () => { cell.style.background = ""; };
						cell.appendChild(el("span", it.ico));
						cell.appendChild(el("span", it.name, "font-size:10.5px;opacity:.85;"));
						cell.addEventListener("click", () => { closeLauncher(); openItem(it); });
						grid.appendChild(cell);
					}
					body.appendChild(grid);
					return;
				}
				// 编辑态：行式列表（拖拽 + ↑↓）
				for (let idx = 0; idx < items.length; idx++) {
					const it = items[idx];
					const row = el("div", undefined, "display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:5px;cursor:grab;");
					row.draggable = true;
					row.appendChild(el("span", it.ico));
					row.appendChild(el("span", it.name, "flex:1 1 auto;font-size:12px;"));
					const up = el("button", "↑", "width:20px;height:20px;border-radius:4px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;cursor:pointer;font-size:11px;line-height:1;");
					const down = el("button", "↓", up.style.cssText);
					up.disabled = idx === 0; down.disabled = idx === items.length - 1;
					if (up.disabled) { up.style.cssText += "opacity:.3;cursor:default;"; }
					if (down.disabled) { down.style.cssText += "opacity:.3;cursor:default;"; }
					up.addEventListener("click", (e) => { e.stopPropagation(); moveItem(idx, -1); });
					down.addEventListener("click", (e) => { e.stopPropagation(); moveItem(idx, +1); });
					row.addEventListener("dragstart", (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(idx)); });
					row.addEventListener("dragover", (e) => { e.preventDefault(); });
					row.addEventListener("drop", (e) => {
						e.preventDefault();
						const from = Number(e.dataTransfer.getData("text/plain"));
						if (!isFinite(from) || from === idx) { return; }
						const moved = items.splice(from, 1)[0];
						items.splice(idx, 0, moved);
						saveOrder(items);
						renderLauncherBody();
					});
					row.appendChild(up); row.appendChild(down);
					body.appendChild(row);
				}
			}
			function openLauncher() {
				closeLauncher();
				const box = el("div", undefined,
					"position:fixed;z-index:1000;width:250px;padding:10px;border-radius:10px;"
					+ "background:var(--dsw-alias-bg-layer-2,#232323);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));"
					+ "box-shadow:0 10px 28px rgba(0,0,0,.5);color:var(--dsw-alias-label-primary,inherit);");
				const head = el("div", undefined, "display:flex;align-items:center;padding:0 2px 8px;font-size:11px;opacity:.75;");
				head.appendChild(el("b", "工作台", "flex:1 1 auto;font-weight:600;"));
				const editBtn = el("button", "✎ 排序", "border:none;background:none;color:var(--dsw-alias-brand-primary,#4d7cfe);font-size:11px;cursor:pointer;");
				editBtn.addEventListener("click", () => {
					editing = !editing;
					editBtn.textContent = editing ? "完成" : "✎ 排序";
					foot.style.display = editing ? "" : "none";
					renderLauncherBody();
				});
				head.appendChild(editBtn);
				const bodyEl = el("div");
				bodyEl.setAttribute("data-wb-body", "1");
				const foot = el("div", undefined, "display:none;padding:8px 2px 0;font-size:11px;");
				const reset = el("button", "恢复默认顺序", "border:none;background:none;color:var(--dsw-alias-brand-primary,#4d7cfe);font-size:11px;cursor:pointer;");
				reset.addEventListener("click", () => { items = DEFAULT_ITEMS.slice(); saveOrder(items); renderLauncherBody(); });
				foot.appendChild(reset);
				box.appendChild(head); box.appendChild(bodyEl); box.appendChild(foot);
				// 锚在侧栏行右侧；夹进视口（本页面跑在 WebContentsView 里，超矩形会被裁 ✗）
				const w = window.innerWidth || 0, h = window.innerHeight || 0;
				let x = 244, y = 150;
				if (w > 0) { x = Math.max(8, Math.min(x, w - 270)); }
				if (h > 0) { y = Math.max(8, Math.min(y, h - 360)); }
				box.style.left = x + "px"; box.style.top = y + "px";
				document.body.appendChild(box);
				launcherEl = box;
				renderLauncherBody();
				document.addEventListener("mousedown", onLauncherOutside, true);
			}
		}

		exports.install = install;
		// 仅测试用：兜底进会话时"挑哪一条"（纯逻辑 ⇒ 守卫 ⑥ 钉住）
		exports.__test = { pickLatestSessionId };
		return module.exports;
	}
});
