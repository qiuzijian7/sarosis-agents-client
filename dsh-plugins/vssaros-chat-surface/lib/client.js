// @vssaros/dsh-chat-surface — client half (hand-written dsh client module).
// Binds the chat surface to the session VsSaros created for this chat tab:
// the VsSaros preload exposes window.vssarosDsh { surface, sessionId }（页面桥 v1 +
// --vssaros-dsh-session= 启动参数）；会话绑定只对 surface=chat 的页面生效。
//
// dsh web 没有会话深链（无 /session/<id> 路由）：切会话只能调 ctx.uiWorkspace.openSession(target)。
// "已打开"用 DOM 事实判定：会话打开后右栏会话面板带 [data-sidebar-right-session="<id>"]
// （该元素被 VsSaros 的裁剪样式隐藏，但仍在 DOM 里）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const name = "vssaros-chat-surface-client";
		// 注意：**不**把 `workspaces` 加进 inject —— 本仓库实测结论是 Cordis 4 的 inject 数组是
		// 硬依赖（object 形式没有 optional 语义），未就绪会让整个插件不 apply（比缺这个功能更糟）。
		// 工作区服务改在 alignWorkspace 里用 `ctx.get("workspaces")` **运行时可选**取（官方
		// settings-models 取 productAnalytics 用的也是这一手）。
		const inject = ["uiWorkspace", "uiSession", "theme", "slots", "remote", "remote.agentPresets", "sessions"];
		// 每个换皮部件一个 package-local chunk（见各文件头）。加载/注册失败的部件只影响它自己，
		// 不影响其它部件与聊天本身；失败原因记在 window.__vssarosChatSurface.partErrors。
		// 任务队列（排队消息）：**用 dsh 官方 QueueDock**（`conversation.input.dock` / id `queue` / order 20）。
		// 0.2.44 起不再有我们自己的 `client.queue.js` 提示条——它会与官方那枚重复表达"排队中"（2026-10-12 决策）。
		const PART_CHUNKS = ["./client.hero.js", "./client.skin.js", "./client.usage.js", "./client.tools.js", "./client.approval.js", "./client.openInApp.js", "./client.hideBridgePing.js", "./client.preset.js", "./client.settings.js", "./client.sessionLabel.js", "./client.workspace.js", "./client.sessions.js", "./client.agents.js", "./client.persona.js", "./client.fileCards.js", "./client.cardActions.js", "./client.todos.js", "./client.subagents.js"];

		/** 菜单最小宽度（px）——见 fitMenuSize 里 minWidth 的说明。 */
		const MENU_MIN_WIDTH = 220;

		/**
		 * 把自绘菜单的尺寸夹在**页面视口**内。
		 *
		 * 为什么必须：dsh 页面跑在 `WebContentsView` 里，**超出视图矩形的 DOM 会被裁掉**——被裁的部分露出
		 * 后面的编辑器/工作台 DOM，用户看到的就是"下拉框被文本编辑器遮挡"（2026-10-11 实测截图）。
		 * 页面视口 `window.innerWidth/innerHeight` 正是视图矩形，所以夹到它即可，不需要任何桥数据。
		 *
		 * 取值：先按"留边"算（宽 −24、高 −72），再**同时不超过视口**（聊天框被拖得很窄时，宁可贴着
		 * 视口边缘也不溢出；不能低于 96 时以视口为准）。
		 *
		 * `minWidth`（2026-10-11 新增）：菜单是"绝对定位 + 宽自适应"，它的**包含块是我们那枚 chip**
		 * （`position:relative; display:inline-flex`，宽约 30–60px），而菜单条目普遍写 `width:100%`
		 * ⇒ 收缩到适配算出的可用宽只有几十像素，实测把「聊天框设置」菜单挤成**每行 1–2 个字**
		 * （截图：换皮样式/已开启…）。给下限即可恢复；下限本身也夹在 maxWidth 内，窄框不会溢出。
		 * @param viewport - `{ width, height }`（传参形式便于单测）。
		 * @returns 合并进菜单 style 的片段（`overflow` + 可选 `minWidth/maxWidth/maxHeight`）。
		 */
		function fitMenuSize(viewport) {
			const w = viewport && viewport.width > 0 ? viewport.width : 0;
			const h = viewport && viewport.height > 0 ? viewport.height : 0;
			const style = { overflowY: "auto", overflowX: "hidden" };
			if (w > 0) {
				const max = Math.min(w, Math.max(96, w - 24));
				style.maxWidth = max + "px";
				style.minWidth = Math.min(MENU_MIN_WIDTH, max) + "px";
			}
			if (h > 0) { style.maxHeight = Math.min(h, Math.max(96, h - 72)) + "px"; }
			return style;
		}
		/**
		 * 菜单互斥协调器：同一时刻只允许一个自绘菜单打开。
		 *
		 * 多个菜单叠在一起时，被视图矩形裁掉的部分同样会露出后面的编辑器 ⇒ 看起来像"被遮挡"；
		 * 而且叠着也没法用。用法：打开前 `closeOthers(id)`，打开期间 `register(id, () => setOpen(false))`
		 * （关闭时 `register(id, null)` 注销——React 里用 effect 的 cleanup 最省事）。
		 */
		function createMenuCoordinator() {
			const closers = new Map();
			return {
				closeOthers(id) {
					for (const [key, close] of closers) {
						if (key === id) { continue; }
						try { close(); } catch { /* 单个菜单关不掉不影响其它 */ }
					}
				},
				register(id, close) {
					if (typeof close === "function") { closers.set(id, close); return () => closers.delete(id); }
					closers.delete(id);
					return () => undefined;
				},
				/** 诊断/单测：当前登记为"打开着"的菜单数。 */
				openedCount() { return closers.size; },
			};
		}
		function apply(ctx) {
			const bridge = window.vssarosDsh;
			const state = window.__vssarosChatSurface = {
				loaded: true,
				surface: bridge && bridge.surface ? bridge.surface : null,
				sessionId: bridge && bridge.sessionId ? bridge.sessionId : null,
				opened: false,
				attempts: 0,
				// `error` = **当前**是否坏着（成功打开会话时清空 ✓）；历史留 `lastError` / `lastOpenError`。
				// 2026-10-12 实测教训：从前成功后不清 ⇒ 白屏诊断里报的是**陈旧错误**，
				// 把"其实已经恢复"也读成"还坏着" ✗。
				error: null,
				lastError: null,
				lastOpenError: null,
				/** 会话连续 120 秒打不开、轮询主动放弃的次数（>0 说明"这一轮彻底没打开"）。 */
				openGiveUps: 0,
				themeTokens: 0,
				inserted: 0,
				insertDropped: 0,
				lastInsert: null,
				rebinds: 0,
				presetSwitches: 0,
				lastPresetError: null,
			};
			// ── 页面侧 JS 错误采集（诊断用，2026-10-12）─────────────────────────────
			// 为什么必须采：用户报"聊天框过一会儿 UI 消失"，而 IDE 日志里**只有我们自己的诊断**、
			// 看不到**应用本身**抛了什么 ⇒ 上一轮只能拿 `surface.error`（"inactive context"）推测，
			// 无法回答"应用为什么整个不渲染"（实测 `bodyText:""`、`bodyChildren:3`）✗。
			// 把 window.onerror / unhandledrejection 收进一个**全局**环形缓冲，由宿主侧白屏诊断
			// （`PAGE_BLANK_DIAGNOSTIC`）随诊断一起抓回日志 ⇒ 下次"应用为什么死"有原文可查 ✓。
			// 放全局而不进 state：`apply` 可能因 cordis 上下文重建而重跑，监听只该装一次；
			// 采集器写全局、读的永远是最新缓冲 ✓。
			if (!window.__vssarosJsErrors) {
				const buf = window.__vssarosJsErrors = [];
				const push = (msg, src) => {
					try {
						buf.push({
							t: Date.now(),
							src: String(src || "").slice(0, 60),
							msg: String(msg || "").replace(/\s+/g, " ").slice(0, 200),
						});
						if (buf.length > 5) { buf.shift(); }
					} catch { /* 采集失败绝不影响页面 */ }
				};
				window.addEventListener("error", (e) => push((e && (e.message || (e.error && e.error.message))) || "error", (e && e.filename) || ""));
				window.addEventListener("unhandledrejection", (e) => {
					const reason = e && e.reason;
					push((reason && (reason.message || reason)) || "unhandledrejection", "promise");
				});
			}
			// 主题同步（方案 5.13.2 P2）：VsSaros 把当前主题映射成 dsh token 覆盖层推过来，
			// 经 theme 服务的 overrideTokens 叠到活动调色板上（dsh 官方扩展点；浅/深两形态同值）。
			const THEME_EVENT = "vssaros-dsh-theme";
			const applyTheme = (tokens) => {
				if (!tokens || typeof tokens !== "object") {
					return;
				}
				try {
					ctx.theme.overrideTokens("vssaros", tokens);
					state.themeTokens = Object.keys(tokens).length;
				} catch (e) {
					state.error = String((e && e.message) || e);
				}
			};
			try {
				const stashed = document.documentElement && document.documentElement.dataset.vssarosTheme;
				if (stashed) {
					applyTheme(JSON.parse(stashed));
				}
			} catch { /* stash 损坏就等下一次推送 */ }
			document.addEventListener(THEME_EVENT, (e) => applyTheme(e.detail));

			// 插入文件引用（方案 5.5 onInsertReference）：inputActions 由 conversation 包经
			// ctx.uiSession.provide 注入到会话作用域绑定 —— 经 adapter.current 直接读当前绑定即可拿到。
			// 优先结构化 chip：会话作用域绑定带 ctx（ScopedStandardSourceBinding），
			// 在那里 emit 'slash/input-insert-reference'（bail 事件，输入机认领即返回 true）；
			// 未认领（输入机未挂载等）回退纯文本 @<path> —— chip 的序列化形态就是 @<path>
			// （dsh-client-ui-reference 的 codec: serialize = ref），发送语义一致。
			const INSERT_EVENT = "vssaros-dsh-insert";
			const buildMention = (d) => "@" + String(d.path).replace(/\\/g, "/");
			const lineSuffix = (d) => d.startLine ? "#L" + d.startLine + (d.endLine && d.endLine !== d.startLine ? "-L" + d.endLine : "") : "";
			document.addEventListener(INSERT_EVENT, (e) => {
				state.insertEvents = (state.insertEvents || 0) + 1;
				const d = e && e.detail;
				if (!d || typeof d.path !== "string") {
					state.insertDropped++;
					return;
				}
				try {
					const binding = ctx.uiSession && ctx.uiSession.adapter && ctx.uiSession.adapter.current
						? ctx.uiSession.adapter.current.getSnapshot() : null;
					const actions = binding && binding.props ? binding.props.inputActions : null;
					const inputHook = binding && binding.hooks ? binding.hooks.input : null;
					const draft = inputHook ? ((inputHook.getSnapshot() || {}).draft || "") : "";
					if (!actions) {
						state.insertDropped++;
						return;
					}
					const mention = buildMention(d);
					const suffix = lineSuffix(d);
					const label = mention.slice(mention.lastIndexOf("/") + 1);
					// 结构化 chip（文件引用源是 dsh-client-ui-reference 注册的 "reference" codec）。
					let chip = false;
					if (binding.ctx) {
						try {
							chip = binding.ctx.emit("slash/input-insert-reference", {
								reference: { source: "reference", ref: mention, label, appearance: "file", clipboardText: mention + suffix },
								span: actions.captureInsertion(),
							}) === true;
						} catch { /* 事件契约变了就当没认领，走文本兜底 */ }
					}
					if (chip && suffix) {
						// chip 后补行号纯文本（draftRev 已变，重新取 span）。
						actions.insertText(suffix + " ", actions.captureInsertion());
					}
					if (!chip) {
						const span = actions.captureInsertion();
						const before = span && span.start > 0 ? draft.charAt(span.start - 1) : "";
						const text = (before && !/\s/.test(before) ? " " : "") + mention + suffix + " ";
						if (!actions.insertText(text, span)) {
							state.insertDropped++;
							return;
						}
					}
					state.inserted++;
					state.lastInsert = (chip ? "[chip]" : "") + mention + suffix;
				} catch (err) {
					state.error = String((err && err.message) || err);
				}
			});

			// 以下全部只在聊天框 surface 生效：官方整页（surface=full）必须保持官方形态。
			if (!bridge || bridge.surface !== "chat" || !bridge.sessionId) {
				return;
			}

			// ── 会话绑定（含方案 5.15 的重绑）─────────────────────────────────
			// openSession 需要客户端把会话载入 roster；轮询到出现会话标记为止。
			// 重绑（切 preset 换专属会话）走同一条轮询：换 currentSessionId 即可，
			// 标记元素按新 id 重新判定。同 id 重发是幂等 no-op（视图重载后宿主会重发）。
			let currentSessionId = bridge.sessionId;
			let idleTicks = 0;
			const mark = () => {
				if (document.body) {
					document.body.dataset.vssarosSessionId = currentSessionId;
				}
			};
			mark();
			const timer = setInterval(() => {
				const sid = currentSessionId;
				if (!sid) {
					return;
				}
				const opened = !!document.querySelector('[data-sidebar-right-session="' + sid + '"]');
				if (opened) {
					if (!state.opened || state.sessionId !== sid) {
						state.opened = true;
						state.sessionId = sid;
						mark();
						document.body.dataset.vssarosOpened = "true";
					}
					// 打开成功 ⇒ 清掉"当前错误"（历史留 `lastError`）：从前成功后不清，
					// 白屏诊断里就会报陈旧的 "inactive context"，把已恢复读成还坏着 ✗。
					if (state.error) { state.lastError = state.error; state.error = null; }
					idleTicks = 0;
					return;
				}
				state.opened = false;
				state.attempts++;
				if (++idleTicks > 240) {
					// 连续 120 秒开不出来就停（Host 侧会话可能被删）；下一次重绑会重置计数。
					// 记一次"放弃"：这是"这一轮彻底没把会话打开"的**唯一**计数信号（`attempts` 会被清零）。
					state.openGiveUps = (state.openGiveUps || 0) + 1;
					idleTicks = 0;
					state.attempts = 0;
					clearInterval(timer);
					return;
				}
				try {
					alignWorkspace(sid);
					ctx.uiWorkspace.openSession(sid);
				} catch (e) {
					// `openSession` 在客户端会话 roster 尚未载入该会话时会抛（实测
					// `sessions.retain: unknown session <id>`）——这是**本轮询预期内的瞬时状态**
					// （轮询本身就是为等 roster 就绪而存在），不能写进 state.error：那是"插件出错"
					// 的信号，被它污染后界面自检与 e2e 都会误报。单独记重试次数。
					const msg = String((e && e.message) || e);
					if (/unknown session/i.test(msg)) {
						state.openRetries = (state.openRetries || 0) + 1;
					} else {
						state.error = msg;
						state.lastOpenError = msg;
					}
				}
			}, 500);
			window.addEventListener("pagehide", () => clearInterval(timer));

			/**
			 * 把页面的**工作区选择**对齐到"拥有该会话的工作区"（= VsSaros 当前工作区）。
			 *
			 * 为什么需要：dsh web 的工作区选择默认值与我们打开的工作区无关（实测选择器会落在
			 * 别的工作区/空白上，用户得手点一次）。而 Host 侧 `session.start` 已经用 `cwd`
			 * 建好工作区并 `attachSession`（bridge 插件），所以 **sessionIds 含本会话的那个工作区
			 * 就是当前工作区** —— 不需要把 cwd 从主进程透传进页面。
			 *
			 * 顺序：`uiWorkspace.openWorkspace()` 会连带切换选中的会话（官方工作区选择器就是这么
			 * 用的，第二个参数用于保草稿），所以必须在 `openSession(sid)` **之前**调；随后的
			 * openSession 再把选中会话定回本会话。
			 */
			const alignWorkspace = (sid) => {
				try {
					const workspaces = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
					const snapshot = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
					const items = (snapshot && snapshot.items) || [];
					const owner = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sid) >= 0);
					if (owner) {
						ctx.uiWorkspace.openWorkspace(owner.workspaceId).catch(() => undefined);
						state.workspace = owner.workspaceId;
					}
				} catch (e) {
					state.workspaceError = String((e && e.message) || e);
				}
			};

			// 重绑事件（宿主 → preload → DOM）：切到另一个 preset 的专属会话。
			const rebind = (sid) => {
				if (!sid || (sid === currentSessionId && state.opened)) {
					return;
				}
				currentSessionId = sid;
				state.sessionId = sid;
				state.rebinds++;
				idleTicks = 0;
				mark();
				try {
					alignWorkspace(sid);
					ctx.uiWorkspace.openSession(sid);
				} catch (err) {
					const msg = String((err && err.message) || err);
					// 同上：roster 未就绪的瞬时失败不算插件错误。
					if (/unknown session/i.test(msg)) {
						state.openRetries = (state.openRetries || 0) + 1;
					} else {
						state.error = msg;
					}
				}
			};
			document.addEventListener("vssaros-dsh-rebind", (e) => {
				const sid = e && e.detail && typeof e.detail.sessionId === "string" ? e.detail.sessionId : null;
				rebind(sid);
			});


			// 皮肤部件：并行取回各自 chunk，再逐个安装。
			// shell.sessionId 是初始绑定（启动参数）；运行期的当前会话读 state.sessionId。
			const shell = {
				bridge, state, sessionId: bridge.sessionId, mark, rebind,
				// 菜单尺寸夹到页面视口（= WebContentsView 矩形）；见 fitMenuSize。
				fitMenu: () => fitMenuSize(typeof window === "undefined" ? null : { width: window.innerWidth, height: window.innerHeight }),
				// 菜单互斥协调器；见 createMenuCoordinator。
				menus: createMenuCoordinator(),
			};
			// 部件在 apply 之外异步装载，**apply 必须保持同步**：fiber 的注入服务在 apply 返回后才就绪，
			// 在 apply 里 await 会把整段皮肤卡在非活跃期（实测写成 async apply → ctx.uiWorkspace 等
			// 一律报 "inactive context"，且 apply 的 promise 悬挂会让插件一直不激活）。
			// 装载失败只记 partErrors，不影响聊天本身。
			void Promise.all(PART_CHUNKS.map((file) => Promise.resolve()
				.then(() => require.async(file))
				.catch((e) => {
					state.partErrors = Object.assign({}, state.partErrors, { [file]: String((e && e.message) || e) });
					return null;
				})))
				.then((parts) => {
					for (const part of parts) {
						if (part && typeof part.install === "function") {
							try {
								part.install(ctx, shell);
							} catch (e) {
								state.error = String((e && e.message) || e);
							}
						}
					}
				});
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		// 仅测试用：菜单视口适配 / 互斥协调器的纯逻辑（插件装载只读 apply/inject/name）。
		exports.__test = { fitMenuSize, createMenuCoordinator };
		return module.exports;
	}
});
