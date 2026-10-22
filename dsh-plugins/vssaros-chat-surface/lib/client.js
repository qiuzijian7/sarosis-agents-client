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
		// ⚠⚠ **入口指纹**（2026-10-21 真机事故后立的规矩，改 chunk 时**必须**动这里）：
		//   客户端 chunk 的 `?rev=` 只跟**入口本文件**的 mtime/ctime/size 走
		//   （官方 `artifactRevision()` = framedHash("plugin-artifact", [mtime, ctime, size, …])）
		//   ⇒ **只改 `client.*.js` 而不改入口 ⇒ rev 不变 ⇒ 浏览器继续吃缓存里的旧 chunk** ✗✗
		//   （今天就因此丢了侧栏「主页」那一行：18:15 改了 client.workbenchNav.js，没动入口 ⇒
		//    rev 没变 ⇒ 用户窗口里侧栏仍是旧版；22:17 补改入口后才恢复。）
		// ⇒ 规矩：**改任何 `client.*.js` 之后，把下面这个 stamp 改掉**（守卫会查 ⇒ 漏了必红）✓
		const CLIENT_BUILD_STAMP = "2026-10-22/模式chip当前名称不冒充(P0-1)/03+第三方工作台固定到侧栏+空白会话预选Bot(P0-2)/04+固定行启动兜底也同步(重启后固定图标不丢)+2026-10-22/工作流页改左右两档(左列表右画布)+2026-10-22/工作台导航登记商城(主页不显示商城的修复)";
		// 挂到 window 上 ⇒ 真机取证能一眼看出"这个窗口跑的是哪一版"（`window.__vssarosChatSurfaceBuild`）✓
		try { window.__vssarosChatSurfaceBuild = CLIENT_BUILD_STAMP; } catch { /* 极端环境 */ }
		// 注意：**不**把 `workspaces` 加进 inject —— 本仓库实测结论是 Cordis 4 的 inject 数组是
		// 硬依赖（object 形式没有 optional 语义），未就绪会让整个插件不 apply（比缺这个功能更糟）。
		// 工作区服务改在 alignWorkspace 里用 `ctx.get("workspaces")` **运行时可选**取（官方
		// settings-models 取 productAnalytics 用的也是这一手）。
		// 2026-10-17 加 sidebarRight / sidebarRightTabs / layout：工作台导航（client.workbenchNav.js）
		// 把页面开进**右侧栏页签**（openTab）并把中栏弹回会话（selectPanel(null)）用。
		// 都是官方随附服务（dsh-client-ui-sidebar-right / dsh-client-ui-layout）⇒ 硬依赖安全 ✓。
		// ⚠ 2026-10-18 **不要把 `locale` 加进静态 inject**（曾加过，随后真机出现
		//   `renderSlot('root') before any 'root' registration (boot order)` 与
		//   `Failed to fetch (dynamicCordisRunner/inventory)` —— 静态 inject 会改变本插件的
		//   启动时机，若在 root 槽注册前就跑到我们的槽注册，会把客户端 boot 顺序打乱 ✗）。
		//   语言切换改用**惰性获取**：`ctx.get("locale")`（服务已 provide，无需 inject）✓。
		const inject = ["uiWorkspace", "uiSession", "theme", "slots", "remote", "remote.agentPresets", "sessions", "sidebarRight", "sidebarRightTabs", "layout"];
		// 每个换皮部件一个 package-local chunk（见各文件头）。加载/注册失败的部件只影响它自己，
		// 不影响其它部件与聊天本身；失败原因记在 window.__vssarosChatSurface.partErrors。
		// 任务队列（排队消息）：**用 dsh 官方 QueueDock**（`conversation.input.dock` / id `queue` / order 20）。
		// 0.2.44 起不再有我们自己的 `client.queue.js` 提示条——它会与官方那枚重复表达"排队中"（2026-10-12 决策）。
		// ★ 2026-10-21（第二轮）：`client.preset.js` 曾**整块删除**（模式入口交回官方 `AgentPresetSeat`）——
		//   原因：官方那枚切不动（我们那版依赖宿主页面桥 `switchPreset`，无桥环境点了没反应 ✗）。
		// ★ 2026-10-21（第四轮，用户指令「把 agent 定位成 Bot，不要让 agent 作为 preset 呈现」）：**又接回来**，
		//   但换了一副实现 —— 官方 seat 的菜单 = roster 全量（只滤 `broken`）⇒ 22 个内置 agent + 用户 agent
		//   与「标准模式/PTC 模式」并排 ⇒ **官方无法满足"agent 不进模式菜单"** ⇒ 这一格由我们接管：
		//     · 只列**模式**（dsh 自带 4 个 + 我们的 3 个档）⇒ agent 全部剔除 ✓
		//     · 切换走**官方 remote API**（`ctx.remote.agentPresets.select`）⇒ 没有宿主桥也能切 ✓
		//   ⚠ 第五轮：它**不在** PART_CHUNKS 里（那儿有"无桥就整批不装"的早退 ⇒ desktop 里不生效 ✗）
		//   ⇒ 走上面那条**独立装载路径**（ALWAYS 部件）✓ ⇒ 这里不再列它。
		const PART_CHUNKS = ["./client.hero.js", "./client.skin.js", "./client.usage.js", "./client.tools.js", "./client.approval.js", "./client.openInApp.js", "./client.hideBridgePing.js", "./client.settings.js", "./client.sessionLabel.js", "./client.workspace.js", "./client.sessions.js", "./client.agents.js", "./client.persona.js", "./client.fileCards.js", "./client.cardActions.js", "./client.todos.js", "./client.subagents.js", "./client.delegate.js", "./client.welcome.js", "./client.capsule.js", "./client.workbenchNav.js", "./client.workspaces.js", "./client.market.js", "./client.account.js",
		// 侧栏页脚（品牌 + 工作区/会话规模，2026-10-18 差异清单第 ③ 项）：
		// ⚠ 本块注释里**禁止出现 ASCII 双引号**（连正则字面量也不行）：`PART_CHUNKS` 的提取正则
		//   是「引号 + 至少一个非引号字符 + 引号」，chunk 守卫与 dshPluginPackages 测试都用它 ⇒
		//   注释里的一对引号会被当成一条 chunk 条目，报「PART_CHUNKS 里的 必须接线 不存在」
		//   （2026-10-19：我连续两版栽在这，第二次是注释里又写了正则原文 ✗✗）。引用术语一律用中文引号 ✓。
		// 放进 PART_CHUNKS 是为了满足 chunk 守卫的“必须接线”检查；chunk 自身在 install()
		// 里按 `bridge.chatOnly === false`（带官方 chrome）自门控 ⇒ chat-only 视图里空转 ✓。
		"./client.footer.js",
		// 侧栏品牌区换成 VsSaros 的 logo + 标题（2026-10-21 用户要求）。
		// 槽：sidebar.brand.mark / sidebar.brand.name（都是 single，priority -10 顶掉官方那份）。
		"./client.brand.js",
		// 工作流执行进度条（dock，2026-10-20）：消费 Host 的 `/x/workflow/api/run/status`。
		// 没有 running 时组件自己 return null ⇒ dock 不占位 ✓。
		"./client.workflowRun.js"];

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
		 *
		 * ★ 2026-10-16（用户报"下拉框显示不全，工作区一多就点不到下面的按钮"）：**必须知道菜单从哪儿开始**。
		 *   从前只按"整页高 − 72"算 ⇒ 锚点在页面中部时（聊天 header / 输入框那两簇），算出来的高度**大于**
		 *   锚点到视口底部的距离 ⇒ 菜单的下半截（含「＋ 添加工作区…」与底部语义行）落到视口外；而它自己
		 *   又是**滚动容器** ⇒ 那一截**既看不到也滚不到** ✗（用户 4 个工作区 + 各根就顶出去了，截图实证）。
		 *   ⇒ 新增 `anchor`（**触发器 rect 的投影**，一处一处传）：
		 *     · 向下展开（`top:100%`）⇒ 传 `{ bottom }`：可用高 = 视口高 − bottom − 间隙 − 留边 ✓
		 *     · 向上展开（`bottom:100%`）⇒ 传 `{ up:true, top }`：可用高 = top − 间隙 − 留边 ✓
		 *     · 不传（老调用点 / 拿不到 rect）⇒ **保持既有口径**（整页 − 72），行为一字不变 ✓
		 *   ⚠ 向上展开那两个菜单（Agents / 人格）改用"自带确定上限"（见各自文件）：它们在 `fitMenu` **之后**
		 *     再写自己的 `maxHeight` ⇒ 不会被"整页 − 72"顶掉（那 320px 的用意从前正是被它覆盖掉的 ✗）。
		 * @param viewport - `{ width, height }`（传参形式便于单测）。
		 * @param anchor - 可选：`{ bottom }`（向下展开）或 `{ up: true, top }`（向上展开）。
		 * @returns 合并进菜单 style 的片段（`overflow` + 可选 `minWidth/maxWidth/maxHeight`）。
		 */
		function fitMenuSize(viewport, anchor) {
			const w = viewport && viewport.width > 0 ? viewport.width : 0;
			const h = viewport && viewport.height > 0 ? viewport.height : 0;
			const style = { overflowY: "auto", overflowX: "hidden" };
			if (w > 0) {
				const max = Math.min(w, Math.max(96, w - 24));
				style.maxWidth = max + "px";
				style.minWidth = Math.min(MENU_MIN_WIDTH, max) + "px";
			}
			if (h > 0) {
				let limit = h - 72;
				if (anchor) {
					// 间隙 4（菜单与触发器之间那 4~6px 的 margin）+ 边缘留边 12 ✓
					const GAP = 4, EDGE = 12;
					if (anchor.up === true) {
						limit = (typeof anchor.top === "number" ? anchor.top : h) - GAP - EDGE;
					} else if (typeof anchor.bottom === "number") {
						limit = h - anchor.bottom - GAP - EDGE;
					}
				}
				// 夹到视口内（低到 96 就贴着视口走，与 maxWidth 同口径 ✓）
				style.maxHeight = Math.min(h, Math.max(96, limit)) + "px";
			}
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
		/** 宿主或工作台迟迟不到场时，退回 SSR 完整页的等待上限。 */
		const WORKBENCH_SURFACE_FALLBACK_MS = 10000;
		/**
		 * `surface=workbench` 的承载逻辑（见 apply 里的调用点注释）。状态写在 `state.workbench`，供宿主侧
		 * 页面自证与探针读取：`{ route, id, opened, fallback, lastError }`。
		 */
		function installWorkbenchSurface(ctx, bridge, state) {
			const route = String((bridge && bridge.workbenchRoute) || "");
			const m = /^\/x\/([a-z][a-z0-9-]*)\/$/.exec(route);
			const wb = state.workbench = { route: route || null, id: m ? "vssaros/" + m[1] : null, opened: false, fallback: null, lastError: null };
			if (!m) {
				wb.fallback = "bad-route";
				return;
			}
			let svc = null;
			let timer = 0;
			const fallBack = (why) => {
				if (wb.opened || wb.fallback) { return; }
				wb.fallback = why;
				try { window.location.replace(route + "?surface=editor"); } catch (e) { wb.lastError = String((e && e.message) || e); }
			};
			const tryOpen = () => {
				if (wb.opened || wb.fallback || !svc || typeof svc.has !== "function" || !svc.has(wb.id)) { return; }
				try {
					if (svc.open(wb.id)) {
						wb.opened = true;
						clearTimeout(timer);
					}
				} catch (e) {
					wb.lastError = String((e && e.message) || e);
				}
			};
			timer = setTimeout(() => fallBack("timeout"), WORKBENCH_SURFACE_FALLBACK_MS);
			try {
				ctx.inject(["desktopWorkbenches"], (c) => {
					svc = c.desktopWorkbenches;
					tryOpen();
					const off = svc && typeof svc.subscribe === "function" ? svc.subscribe(tryOpen) : null;
					if (typeof c.effect === "function") {
						c.effect(() => () => { if (off) { off(); } });
					}
				});
			} catch (e) {
				wb.lastError = String((e && e.message) || e);
				fallBack("inject-failed");
			}
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
			// ── 调试钩子：把 cordis 上下文挂到 window（2026-10-18）────────────────────────
			// 为什么需要：弹窗多次疑难（roster 恒 0 / openSession 静默失败）只能靠"改代码→重启→看日志"
			// 猜，一轮十几分钟。挂上 ctx 后可以用 CDP **在线**直接调 `sessions.create/openSession/
			// workspace.refresh` 验证哪条 RPC 通、返回值是什么 ⇒ 立刻定位，不用再猜 ✓。
			// 只在本插件自己的页面里存在（同源页面，无安全边界变化）；不写入任何持久存储。
			try { window.__vssarosCtx = ctx; } catch { /* 诊断钩子失败不影响任何功能 */ }

			// ── 输入诊断（2026-10-17 真机「输入框无法输入」，但自证显示 opened=true / disabled=false）──
			// 现在缺的判据只有三样：
			//   ① 键盘事件**有没有到页面**（keys=0 ⇒ 焦点在原生视图之外/窗口没接键盘）；
			//   ② 到了之后**焦点在谁身上**（activeTag/activeCls 不是 TEXTAREA ⇒ 被别的元素抢了焦点）；
			//   ③ 输入框本身允许不允许（disabled / readOnly / contenteditable / pointer-events / 尺寸，宿主侧采）。
			// ⚠ 只**记录**，绝不 preventDefault / 抢焦点 —— 诊断位不许改变被测行为 ✓。
			// 装一次（全局），`apply` 重跑只换引用。
			if (!window.__vssarosInputDiag) {
				const diag = window.__vssarosInputDiag = {
					keys: 0, downs: 0, before: 0, lastKey: null,
					activeTag: null, activeCls: null, hasFocus: null, at: null,
				};
				const snap = (kind, ev) => {
					try {
						diag.at = Date.now();
						if (kind === "keydown") { diag.keys += 1; diag.lastKey = ev && ev.key; }
						else if (kind === "mousedown") { diag.downs += 1; }
						else { diag.before += 1; }
						const a = document.activeElement;
						diag.activeTag = a && a.tagName ? String(a.tagName) : null;
						diag.activeCls = a && a.className ? String(a.className).slice(0, 48) : null;
						diag.hasFocus = typeof document.hasFocus === "function" ? document.hasFocus() : null;
					} catch { /* 诊断位不影响主流程 */ }
				};
				window.addEventListener("keydown", (e) => snap("keydown", e), true);
				window.addEventListener("mousedown", (e) => snap("mousedown", e), true);
				window.addEventListener("beforeinput", (e) => snap("beforeinput", e), true);
				// 页面自身的 focus/blur（窗口级）：与宿主侧 webContents FOCUS/BLUR 对照，
				// 能区分"窗口没焦点"与"视图没焦点"（2026-10-17 第二轮取证 ✓）。
				window.addEventListener("focus", () => { diag.pageFocus = true; diag.pageFocusAt = Date.now(); });
				window.addEventListener("blur", () => { diag.pageFocus = false; diag.pageBlurAt = Date.now(); });
			}
			state.inputDiag = window.__vssarosInputDiag;

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

			// 工作台导航（sidebar.panellist 图标 + main 中栏面板）：chat 形态由下方 PART_CHUNKS
			// 统一装载；**full 形态（弹出窗口）走不到那里** ⇒ 这里单独装。两个分支按 surface
			// 互斥（同一视图 surface 固定），不会双重注册 ✓。chat-only 形态侧栏被 CSS 裁掉，
			// 注册了也不可见（无害空转）；full 形态才是它的舞台（2026-10-17 用户要求）。
			// ★ 2026-10-18：弹窗改成「`surface=chat` + 保留官方 chrome」（chatOnly=0，复刻官方 desktop 布局）
		//   ⇒ 这套「工作台 + 多根工作区侧栏」也要在**带 chrome 的 chat 视图**里装，不能只认 full ✗。
		//   判据用 preload 写的 DOM 事实（`data-vssaros-chat-only`），不猜 CSS ✓。
		const hasOfficialChrome = (() => {
			try {
				if (bridge && bridge.surface === "full") { return true; }
				if (!bridge || bridge.surface !== "chat") { return false; }
				// ★ 首选 **bridge.chatOnly**（preload 在 document-start 就给了，同步可知）；
				//   DOM 标记 `data-vssaros-chat-only` 要等 DOMContentLoaded，而 apply() 往往更早 ⇒
				//   只用 DOM 标记会在真机上偶发判成 chat-only（截图实证：工作区摊平、无「工作台」行 ✗）。
				if (typeof bridge.chatOnly === "boolean") { return bridge.chatOnly === false; }
				return document.documentElement.dataset.vssarosChatOnly === "0";
			} catch { return false; }
		})();
		// ★ 2026-10-18（复刻官方 desktop）：官方侧栏/顶栏的文案由 dsh 自己的 locale 决定，
		//   而 dsh 按 `navigator.languages` 选语言 —— 在 Electron 的 dsh 视图里实测是英文
		//   （`New Session / Plugins / Automation tasks / Workspaces`），与 VsSaros 的中文 UI 不一致。
		//   弹窗（带官方 chrome）里主动切到中文（设置项由 dsh 自己持久化；主窗口聊天框
		//   本来就是 chat-only，看不到这些文案，不会产生割裂）✓。
		if (hasOfficialChrome) {
			try {
				// 惰性取服务（不放进静态 inject，见 inject 处的说明）
				const loc = typeof ctx.get === "function" ? ctx.get("locale") : ctx.locale;
				if (loc && typeof loc.setLocale === 'function') {
					const cur = typeof loc.getLocale === 'function' ? String(loc.getLocale() || '') : '';
					if (!/^zh/i.test(cur)) { loc.setLocale('zh'); }
				}
			} catch { /* locale 服务缺席不影响功能 */ }
			// 右栏默认**展开**一次（与官方 desktop 一致：一进来就是「开始」面板：
			// 工作区文件 / 新建终端 / 浏览器）。官方按 per-session 的存储决定展开态，
			// 新会话默认收起 ⇒ 这里点一次 official 的 expand 按钮；只做一次（用户关掉后
			// 本次会话不再强行打开 ✓，下次重开窗口再由这里展开一次）。
			// ⚠ 2026-10-18 实测两点：① 官方按 per-session 存储决定展开态，新会话默认收起；
			//   ② expand 按钮（`[data-sidebar-right-expand]`）**只在会话打开后**才渲染 ——
			//   早 1.2s 点它是空操作（parity 取证：手动点一次 ⇒ `开始/工作区文件/新建终端` 全 true）
			//   ⇒ 必须**重试**到它出现、点完消失为止 ✓。
			try {
				let tries = 0;
				const expandTimer = window.setInterval(() => {
					tries += 1;
					if (tries > 12) { window.clearInterval(expandTimer); return; }
					try {
						const btn = document.querySelector('[data-sidebar-right-expand]');
						if (!btn) {
							// 按钮不在了：要么已展开成功，要么本会话没有可展开内容 ⇒ 收工
							if (document.querySelector('[data-sidebar-right-session]')) { window.clearInterval(expandTimer); }
							return;
						}
						if (typeof btn.click === 'function') { btn.click(); }
					} catch { /* 忽略 */ }
				}, 1500);
			} catch { /* 忽略 */ }
		}
		// ★ 2026-10-21 真机取证（窗口模式：中间栏没有页签 + 打开的工作台没有页签）：
		//   这里的 require 列表与**下面的 `PART_CHUNKS` 有重叠**（workbenchNav / workspaces /
		//   workspace / footer / brand / market / account 七个都两边有）⇒ 2026-10-18 把弹窗改成
		//   「surface=chat + 保留官方 chrome」后，**两个分支同时命中**（不再是"按 surface 互斥"）
		//   ⇒ 同一 chunk 装载两遍 ⇒ keyed 槽重复注册报错 ⇒ **后续 main 槽的中栏面板注册全被跳过**
		//   ⇒ 工作台页签根本注册不出来 ✗。
		// ⇒ 改法：这个分支**只服务真正的 full 形态**（`surface === "full"`）；chat 形态（窗口模式 /
		//   IDE 聊天框）一律由 `PART_CHUNKS` 装（那七个 chunk 全在 PART_CHUNKS 里 ⇒ 功能不减 ✓）。
		const isFullSurface = !!(bridge && bridge.surface === "full");
		if (isFullSurface) {
			void Promise.resolve()
				.then(() => Promise.all([
					require.async("./client.workbenchNav.js"),
					require.async("./client.workspaces.js"),
						// hero（空白会话屏）的「工作区」下拉在**全窗**里也必须与聊天框同一套 UI
						// （分组 + 多根 + 添加工作区）：2026-10-17 用户截图——“工作区下拉框要求和
						// vssaros dsh 聊天框 UI 中的工作区 UI 一致”。该部件对 shell 的依赖全是
						// state/bridge + 可选的 menus/fitMenu（内部已判空 ✓）⇒ 轻量 shell 可用。
						require.async("./client.workspace.js"),
						// ★ 2026-10-21：页脚（即「回到 IDE」入口）——`surface=full` 形态走不到 PART_CHUNKS
						//   （那段只给 chat 装）⇒ 必须在这里补一次，否则 web 档窗口里没有回 IDE 的路 ✗。
						require.async("./client.footer.js"),
						// 同上：品牌行（logo + 标题）也要在 full 形态生效
						require.async("./client.brand.js"),
						// ★ 2026-10-21：设置页「工作台商城」那一行 —— 同样**只**在 full 形态装得到
						//   （PART_CHUNKS 那段只给 chat 装 ⇒ full 窗口里它压根没被 require ⇒ 设置页没有这行 ✗）。
						require.async("./client.market.js"),
						// ★ 2026-10-21：侧栏底部「账号」行（IDE 账号 + dsh 账号）—— 窗口（full 形态）里才有那一行
						//   ⇒ 与 market/footer 一样必须进这条 full 形态的 require 列表（只进 PART_CHUNKS 就不装 ✗）。
						require.async("./client.account.js"),
					]))
					.then((parts) => {
						for (const part of parts) {
							if (part && typeof part.install === "function") {
								part.install(ctx, { bridge, state });
							}
						}
					})
					.catch((e) => {
						state.partErrors = Object.assign({}, state.partErrors, { "full-surface-parts": String((e && e.message) || e) });
					});
			}

			// ★ 2026-10-21（第五轮，用户指令「agent 定位成 Bot，不要让 agent 作为 preset 呈现」）：
			//   **hero 的模式槽由我们接管**（官方 `AgentPresetSeat` 的菜单 = roster 全量 ⇒ 22 个内置 agent
			//   与「标准模式/PTC 模式」并排 ⇒ 官方满足不了）⇒ 但这一格**必须连无桥环境也装**：
			//   dsh desktop / dsh 全窗**没有** `window.vssarosDsh` 桥 ⇒ 下面的 `if (!bridge …) return;`
			//   会把 PART_CHUNKS 整批挡掉 ⇒ 我们的接管在**用户最初报障的那个环境里根本不生效** ✗✗。
			//   ⇒ 模式选择器走**独立的一条装载路径**（不依赖桥、不依赖会话、不依赖 surface ✓）。
			//   ⚠ 它的数据与切换都走**官方 remote API**（`ctx.remote.agentPresets.list/select`）⇒ 无桥也能用 ✓。
			//   ⚠ 放在 PART_CHUNKS 之外 ⇒ 不会与有桥环境重复安装（两处都装会出现两枚 chip ✗）。
			//   ⚠ 守卫（check-chat-surface-chunks）把本清单与 PART_CHUNKS **并集**当"已接线"清单 ⇒
			//   新增/漏接都能被抓到 ✓（清单写成常量是为了让守卫能逐字比对，不靠正则猜 ✗）。
			// ⚠ `client.botEntry.js`（Bots 入口）**只在没有宿主桥时**注册（它自己 gate）——
			//   有桥时那行由 `client.agents.js` 提供（同名命令会 fail loud ⇒ 绝不能同时注册 ✗）。
			// ★ 2026-10-21：新增 `client.botEntry.js`（无桥环境的 Bot 入口）。
			//   ⚠ **改这里（入口）会让客户端 chunk 的 rev 变化**（rev 只跟入口 client.js 的 mtime/ctime/size 走）
			//   ⇒ 浏览器才会重新取各个 chunk —— **只改 `client.*.js` 而不改入口，浏览器会一直吃旧文件** ✗✗。
			// ★ 2026-10-21（模式菜单）：弹层**位置**修正（无壳兜底不再返回视口坐标 ⇒ 不再飞到右下角 ✗）
			//   + 菜单**分组**（按"差异到底在哪"分：VsSaros 模式 / dsh 原生）⇒ 改的是 `client.preset.js`
			//   ⇒ 这里必须跟着动一下（**rev 只跟入口走** ⇒ 不动入口浏览器就一直吃旧 chunk ✗✗）。
			const ALWAYS_CHUNKS = ["./client.preset.js", "./client.botEntry.js"];
			Promise.all(ALWAYS_CHUNKS.map((p) => require.async(p)))
				.then((parts) => {
					for (const part of parts) {
						if (part && typeof part.install === "function") {
							part.install(ctx, { bridge, state });
						}
					}
				})
				.catch((e) => {
					state.partErrors = Object.assign({}, state.partErrors, { "always-parts": String((e && e.message) || e) });
				});

			// 会话绑定对 chat / full 两种 surface **都生效**（2026-10-17 真机：full 弹窗停在 hero
			// 「Choose workspace to start」——绑定被早退挡在门外 ⇒ 弹窗既不显示跟随的会话，
			// 工作台条目的右侧栏页签也没有会话可挂载 ✗✗）。
			// ⚠ **换皮部件仍只在 chat 装**（见下方"皮肤部件"段前的 return）：full 保持官方整页形态，
			//   只借用绑定这段（openSession 轮询 + alignWorkspace + rebind 监听）✓。
			// ⚠ **不能**再要求 `bridge.sessionId` 非空：新会话首屏（还没选工作区 ⇒ 宿主 `cwdAtBind`
			//   为空 ⇒ 绑定参数里没有会话 id）会因此**一个皮肤部件都不装**，hero 上的官方工作区
			//   浮层就原样露出（2026-10-17 用户截图："与 mockup 不一致" —— 看到的是官方那条
			//   英文扁平根列表，而不是我们主从两栏的面板）。⇒ 空白会话先装"不依赖会话"的部件，
			//   其余等首次重绑（拿到真会话 id）后补装；见 BLANK_SESSION_PARTS。
			// ★ 2026-10-22（doc/workbench-refactor-plan.md §5 步骤 4）：IDE 编辑区的 `surface=workbench` 视图 ——
			//   页面是 dsh 客户端根路径，preload 把模块路由放在 `bridge.workbenchRoute`。这里只做一件事：
			//   等宿主 `desktopWorkbenches` 到场且该工作台已注册 ⇒ `open('vssaros/<module>')` 整页打开；
			//   **不装**会话绑定与任何换皮部件（这个视图不是聊天框）。
			//   ⚠ 宿主 / 工作台 10 秒内没到场（没装、被停用、客户端报错）⇒ 退回 `<route>?surface=editor`
			//     的 SSR 完整页 —— 宁可是旧界面，也不给用户一个空白的 dsh 外壳 ✗。
			if (bridge && bridge.surface === "workbench") {
				installWorkbenchSurface(ctx, bridge, state);
				return;
			}
			if (!bridge || (bridge.surface !== "chat" && bridge.surface !== "full")) {
				return;
			}

			// 新会话首屏（绑定参数里没有会话 id）也必须装的部件：
			//   · `client.workspace.js` —— hero 上官方那条扁平根列表必须被我们的主从两栏面板顶掉
			//   · `client.hero.js` / `client.welcome.js` —— 首屏换皮
			// 其余部件要会话事实（roster / 人格 / 待办…），等首次重绑拿到真会话 id 再补装一次。
			// ★ 2026-10-21 补 `client.footer.js`：桌面窗口的侧栏页脚**就是「回到 IDE」的入口**
			//   （页面桥 `focusIde`）。不放进这里的后果：桌面窗口若没拿到会话 id（例如启动时没开文件夹 ⇒
			//   `_ensurePopoutSessionId` 返回 undefined），PART_CHUNKS 一条都不装 ⇒ 那行页脚不存在
			//   ⇒ **窗口里没有任何回 IDE 的路** ✗（正是本次要修的那件事）。
			//   它自己按 `chatOnly === false` 门控 ⇒ IDE 聊天框里装进来也是空转 ✓。
			// ★ 2026-10-21 再补 `client.brand.js`：品牌行（logo + 标题）在**空白会话屏也在渲染**，
			//   不装它的话"桌面窗口没拿到会话 id"时左上角又回到官方的鱼形标 + deepseek ✗。
			// ★ 2026-10-21 补 `client.workbenchNav.js`：页签条（常驻 overlay 槽）**不依赖会话** ——
		//   它只读 DOM 几何 + 自己的 localStorage ⇒ 首屏还没绑到会话时也该有 ⇒
		//   否则窗口模式首屏（没 sessionId ⇒ 只装 BLANK_SESSION_PARTS）里**整条页签条不存在** ✗。
		const BLANK_SESSION_PARTS = ["./client.workspace.js", "./client.hero.js", "./client.welcome.js", "./client.footer.js", "./client.brand.js", "./client.workbenchNav.js"];
			let restPartsInstalled = !!bridge.sessionId;

			// ── 会话绑定（含方案 5.15 的重绑）─────────────────────────────────
			// openSession 需要客户端把会话载入 roster；轮询到出现会话标记为止。
			// 重绑（切 preset 换专属会话）走同一条轮询：换 currentSessionId 即可，
			// 标记元素按新 id 重新判定。同 id 重发是幂等 no-op（视图重载后宿主会重发）。
			let currentSessionId = bridge.sessionId;
			let idleTicks = 0;
			let lastAlignAt = 0;
			const ALIGN_RETRY_MS = 8000;
			/**
			 * `openWorkspace()` 的**超时**（2026-10-19）：该调用可能永不 settle，而它挂着时
			 * `navState.connecting` 一直有值 ⇒ 连接与导航双双早退 ⇒ 界面永久停在
			 * 「正在打开会话…（已等待 N 秒）」（用户 38 秒截图）。取值与重试节流同量级（8s）。
			 */
			const ALIGN_TIMEOUT_MS = 8000;
			/**
			 * ★★ 2026-10-17（`roster:0 / openRetries:240 / giveUps:1`、页面停在 hero 的真因）：
			 * 官方 `uiWorkspace.openSession()` 内部是 `replaceMain()` ⇒ `layout.beginNavigation()`，
			 * 也就是**一次导航**；而 `openWorkspace()` 的连接会被**后到的导航 abort 掉**
			 * （`openWorkspaceSession()`：`if (navigation.aborted) return;`）⇒ 工作区永远连不上 ⇒
			 * 该工作区的会话永远进不了 roster ⇒ `retain: unknown session` 死循环。
			 * ⇒ 顺序必须是「**先只连、连完再只导航**」，且**连接在飞时一个导航都不许发**。
			 * 闸门跨块共享（本文件的主包轮询 + `client.workbenchNav.js` 的救援都会连工作区；
			 * 各自维护 pending 等于互相 abort —— 这两个块历史上正好各踩过一次 ✗）。
			 */
			const navState = (window.__vssarosNav = window.__vssarosNav || { connecting: null, aligned: null });
			/** 上一次触发 `sessions.refreshList()`（拉会话 roster）的时间，见循环里的注释 ✓ */
			let lastRosterRefreshAt = 0;
			/** 会话列表拉取是否在途（防重入，见循环里的注释 ✓） */
			let rosterRefreshPending = false;
			/** 至少有一次列表拉取**成功返回**（登记闸门要靠它判断"Host 到底有没有这条会话"）。 */
			let rosterListed = false;
			/** 列表拉取失败过（失败时放开 create 兜底，见登记处注释）。 */
			let rosterListFailed = false;
			/** 快速入册（只读本会话投影 + 占位行，见 tick 里的注释）：在途 / 已试过。 */
			let fastListPending = false;
			let fastListDone = false;
			/** 本页的会话是否已用 `sessions.create({sessionId, workspaceId})` 登记进 roster（诊断用）。 */
			let registered = false;
			/** 实际发出过几次 create（诊断；**不再设上限**，见下方策略说明）。 */
			let registerTries = 0;
			// ★ 2026-10-18 重试策略（真机日志定案：冷启动窗口里 2 次额度全部耗尽 ⇒ 之后链路恢复也无人重试）：
			//   · 同一时刻**只有一个 create 在途**（并发重发会互相覆盖/冲突）；
			//   · 在途超过 `REGISTER_REISSUE_MS` 仍无返回 ⇒ 允许再发一次（旧的若迟到成功，roster 里有了就行）；
			//   · 失败（含"返回了但 roster 里仍没有"）⇒ 按退避序列再试，**不设总次数上限**（只要用户还停在 hero，
			//     就一直有下一次）；成功即停。
			let registerPending = false;
			let registerStartedAt = 0;
			let registerNextAt = 0;
			let registerErrors = 0;
			let registerToken = 0;
			const REGISTER_REISSUE_MS = 60000;
			// ★★★ 2026-10-18 真机取证（**本轮最关键的一条**）：弹窗页里连
			//   `fetch('/api/settings/describe')` 都 25s 不返回，而 debugger 通道读本地状态却正常，
			//   且 `loadEventEnd: 0`（load 事件从未触发）。⇒ 不是"业务逻辑卡住"，是**该页到 Host 的连接池
			//   被"永不返回的请求"占满**：我们自己的 create / refresh 超时后**不取消**（Promise 无 abort），
			//   旧请求仍占着 socket；再发新的 ⇒ 第 7 个请求开始全部排队，连 reload 的主文档都排队
			//   （所以"重载也救不回来"）。
			//   ⇒ 必须**熔断**：长请求（create / refresh）全局只允许一个在途；连续 **2 次**超时后**完全停止**
			//   发长请求（`longCallsBroken`），只保留本地轮询与 `openSession`（它们是本地判断 + Host 推送，
			//   不发长请求）。恢复靠用户点「重试」或执行「重启 Host」——状态条会把原因写清楚，不再静默重试。
			let longCallPending = false;
			let longCallStartedAt = 0;
			let longCallTimeouts = 0;
			const LONG_CALL_TIMEOUT_MS_DEFAULT = 45000;
			/** 超时时长；e2e 可经 `__vssarosConnectTuning.longCallTimeoutMs` 缩短，生产不设。 */
			const longCallTimeoutMs = () => {
				try {
					const t = window.__vssarosConnectTuning;
					return t && typeof t.longCallTimeoutMs === "number" ? t.longCallTimeoutMs : LONG_CALL_TIMEOUT_MS_DEFAULT;
				} catch { return LONG_CALL_TIMEOUT_MS_DEFAULT; }
			};
			const LONG_CALL_MAX_TIMEOUTS = 2;
			const longCallsBroken = () => longCallTimeouts >= LONG_CALL_MAX_TIMEOUTS;
			/** 长请求超时（不取消，只记账并熔断）—— 见上面注释。 */
			const noteLongCallTimeout = () => {
				longCallTimeouts += 1;
				state.longCallTimeouts = longCallTimeouts;
				if (longCallsBroken()) {
					state.longCallsBroken = true;
					state.longCallError = "连续 " + longCallTimeouts + " 次超时（连接池已饱和）";
				}
				longCallPending = false;
			};
			/** 长请求成功 ⇒ 熔断计数归零。 */
			const noteLongCallOk = () => {
				longCallTimeouts = 0;
				state.longCallTimeouts = 0;
				state.longCallsBroken = false;
				state.longCallError = null;
				longCallPending = false;
			};
			/**
			 * 任何"服务端有回应"（成功**或**明确拒绝）都说明连接通了 ⇒ 解除熔断、释放闸门。
			 * 迟到的成功同样适用：先前超时时我们只是放弃等待，真请求还在飞，它回来就该恢复 ✓。
			 */
			const maybeLongOk = () => noteLongCallOk();
			const REGISTER_ERROR_BACKOFF_MS = [5000, 15000, 30000, 60000];
			// ★★ 2026-10-19（真机自证：首启卡 46~91 秒、`registerTries:0` / `registerError:null` /
			//   `lastOpenError: sessions.retain: unknown session …`）：
			//   自登记是"让会话秒进 roster"的唯一快路径（一次 create 只要 ~55ms），但失败后退避会走到
			//   **60 秒**一档；而首启本来就要 Host 24s + 连接阶梯 17.7s —— 等真正就绪时正好落在长退避里
			//   ⇒ 看起来"一直打不开"✗。
			//   ⇒ **首启 60 秒内把退避压平到首档（5s）**：宁可多问几次（create 幂等、55ms），也不要错过窗口。
			const registerBackoff = () => {
				const early = Date.now() - bindStartedAt < 60000;
				const idx = early ? 0 : Math.min(Math.max(registerErrors, 1) - 1, REGISTER_ERROR_BACKOFF_MS.length - 1);
				return REGISTER_ERROR_BACKOFF_MS[idx];
			};
			/** 本次绑定开始等待的时刻（状态条的"已等待 N 秒"从这里算；换绑重置）。 */
			let bindStartedAt = Date.now();
			/** roster 里有没有这条会话（`retain` 放行的充要条件之一）。 */
			const rosterHas = (id) => {
				try {
					const l = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
					return !!(l && l.byId && l.byId[id]);
				} catch { return false; }
			};
			/** RPC 通道就绪：`workspaces` 快照非空即说明客户端已与 Host 建立连接。 */
			const rpcReadyEarly = () => {
				try {
					const w = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
					const ws = w && w.list ? w.list.getSnapshot() : null;
					return !!(ws && Array.isArray(ws.items) && ws.items.length > 0);
				} catch { return false; }
			};
			/** 拉取退避（738 条列表本身慢；短周期重发会把上一次作废 ⇒ 必须逐次拉长） */
			const ROSTER_BACKOFF_MS = [8000, 30000, 60000, 120000];
			let rosterBackoffMs = ROSTER_BACKOFF_MS[0];
			let rosterAttempts = 0;
			/** 当前生效的退避：e2e 旋钮 `__vssarosConnectTuning.rosterBackoffMs` 优先（首发前后都生效），生产不设。 */
			const effectiveBackoff = () => {
				try {
					const t = window.__vssarosConnectTuning;
					if (t && typeof t.rosterBackoffMs === "number") { return t.rosterBackoffMs; }
				} catch { /* 忽略 */ }
				return rosterBackoffMs;
			};
			// ★★ 2026-10-20（用户问「载入历史会话为什么这么慢」）：**分段打点**。
			//   主进程的 `page surface` 自证会把 `window.__vssarosChatSurface` 的字段 dump 进日志
			//   ⇒ 这里记下的每个里程碑都会自动出现在 `state.timing` 里，不用再靠猜"6.5 秒花在哪"。
			//   口径：全部相对**页面导航起始**（`performance.now()`）的毫秒数。
			const BOOT_T0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
			const sinceBoot = () => Math.round(((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - BOOT_T0);
			const markTiming = (name) => {
				try {
					if (!state.timing) { state.timing = {}; }
					if (state.timing[name] === undefined) { state.timing[name] = sinceBoot(); }   // 只记首次
				} catch { /* 打点不许影响主流程 */ }
			};
			const mark = () => {
				if (document.body) {
					document.body.dataset.vssarosSessionId = currentSessionId;
				}
				markTiming("opened");
			};
			/**
			 * 连接事件账本（用户消息定位条那次之后新增，2026-10-20）。
			 *
			 * 为什么需要：真机实测「载入历史要 2 秒」时，`ready in 5459ms` / `retry #1…#5` 全是**主进程**
			 * 从页面 console 里抓的二手信息，而真正原因（connection generation 就绪握手）的细节在页面内部。
			 * 这里把关键转折点记成结构化数组（最多 40 条），由主进程 `page surface` 带出 ⇒
			 * 下次不用再靠猜"重试发生在会话就绪之前还是之后"。
			 */
			const connLog = [];
			const pushConnLog = (kind, extra) => {
				try {
					if (connLog.length >= 40) { connLog.shift(); }
					connLog.push(Object.assign({ kind, t: sinceBoot() }, extra || {}));
					state.connLog = connLog;
				} catch { /* 记账不许影响主流程 */ }
			};
			pushConnLog("boot");

			/**
			 * dsh 实时事件连接：记状态变化 + 收到 IDE 的「mux 可用」后跳过剩余退避（2026-10-20）。
			 *
			 * 背景（读 dsh 源码 + 真机日志）：Host 冷启后页面的连接会走 0.5/1/2/4/8 s 退避，约 13 s
			 * 才连上；原因是 mux 路由要等 `appReady` 才注册，比 IDE 判 ready 晚。这段时间里历史能看（走
			 * HTTP RPC），但流式输出 / 运行状态这类实时事件收不到。
			 * IDE 主进程探到路由可用后派发 `vssaros-dsh-mux-ready`；这里如果连接还没连上，就调官方
			 * `connection.reconnect()`（清零计数、跳过退避、立即重连）。已连上就什么都不做。
			 * 全程 try/catch：这条加速坏了也只是退回原来的退避，不影响聊天。
			 */
			try {
				const conn = typeof ctx.get === "function" ? ctx.get("connection") : undefined;
				const snapshot = () => {
					try { return conn && conn.state ? conn.state.getSnapshot() : undefined; } catch { return undefined; }
				};
				if (conn && conn.state && typeof conn.state.subscribe === "function") {
					let last = snapshot();
					pushConnLog("state", { s: String(last) });
					if (last === "connected") { markTiming("connected"); }
					conn.state.subscribe(() => {
						const s = snapshot();
						if (s === last) { return; }
						last = s;
						pushConnLog("state", { s: String(s) });
						if (s === "connected") { markTiming("connected"); }
					});
				}
				const onMuxReady = (detail) => {
					// 同一次通知会经两条路到达（DOM 事件 + window 标记，是同一个对象）⇒ 按对象去重；
					// 以后 Host 再重启会是新对象，照样处理。
					if (!detail || detail === state.lastMuxReady) { return; }
					state.lastMuxReady = detail;
					const s = snapshot();
					pushConnLog("mux-ready", { after: detail && typeof detail.afterReadyMs === "number" ? detail.afterReadyMs : null, s: String(s) });
					if (conn && typeof conn.reconnect === "function" && s !== "connected") {
						state.muxKicks = (state.muxKicks || 0) + 1;
						conn.reconnect();
						pushConnLog("kick", { from: String(s) });
					}
				};
				document.addEventListener("vssaros-dsh-mux-ready", (ev) => onMuxReady(ev && ev.detail));
				// 事件在本插件装好之前就派发过了 ⇒ 补读主进程留下的标记
				if (window.__vssarosMuxReady) { onMuxReady(window.__vssarosMuxReady); }
			} catch { /* 连接加速失败 ⇒ 退回官方退避 */ }
			// ★ 2026-10-19：把**登记失败的真实原因**暴露到 DOM（诊断/取证用）。
			//   状态条只放截断版（一行），完整原文在这里 —— 之前"登记会话失败"没有下文，
			//   用户和排查者都只能猜（本次就是猜不出 conflict / 归属 / 无效 workspaceId 哪一种 ✗）。
			const exposeRegisterError = () => {
				try {
					if (!document.body) { return; }
					const err = state.registerError;
					if (err) {
						document.body.dataset.vssarosRegisterError = String(err).slice(0, 500);
					} else {
						delete document.body.dataset.vssarosRegisterError;
					}
				} catch { /* 诊断位不能影响主流程 */ }
			};
			// ⚠ 2026-10-20：这里原来直接 `mark()` —— 而 `mark()` 的语义是「**会话已到屏**」，
			//   在模块加载瞬间调用会把 `timing.opened` 记成 **0ms**（真机日志一直是 `opened:0`），
			//   让人误以为"会话 0 毫秒就打开了"。这里只记一个真正的启动时刻，别污染 `opened`。
			markTiming("boot");

			// ★★ 2026-10-20（用户：「右侧缺少用户消息定位 UI，官方 dsh 里有」）：
			//   官方那条是 **轮次导航**：`nav` + 每条刻度一个 `button[data-index]`，
			//   `position:absolute; right:12px`、宽约 28px，点击 = 「加载并跳转到第 N 轮」。
			//   实测（同一 Host、只改视口）：1520px 可见 12 个刻度 / 900px 被 dsh 自己 `display:none`
			//   ⇒ 我们的聊天框普遍 600~900px，所以**一直看不见**。
			//   skin 里已有一条 CSS 覆盖（`nav:has(button[data-index])`），但那儿有两个不确定：
			//     ① `:has()` 在某些 Electron 版本不支持；② 可能被更高优先级的官方规则压住。
			//   ⇒ 再加一道**运行时兜底**（不依赖 CSS 选择器能力）：每秒找一次，找到就 inline 强制显示；
			//     并把"找没找到 / 几个刻度 / 多大"记进 `state.rail`（主进程 page surface 会带出来，
			//     下次能一眼分清"没渲染"还是"渲染了但被藏"）。
			/**
			 * 自研「轮次导航」（用户消息定位条）。
			 *
			 * 为什么必须自研：官方那条（`nav[aria-label="轮次导航"]` + `button[data-index]`）在
			 * **IDE 聊天视图的宽度下根本不渲染** —— 真机自证 `rail: { found: false }`，连节点都没有
			 * （不是被 `display:none` 藏起来，那样 CSS/JS 还能救）。而它在 1520px 的独立页面里是存在的
			 * ⇒ 官方按可用宽度决定"渲不渲染"，我们的聊天框普遍 600~900px，永远落在"不渲染"那侧。
			 *
			 * 做法（不碰官方任何东西，纯新增一个浮层）：
			 *   · 挂进 `[data-slot="conversation.view"]`（自带定位上下文），absolute 贴右缘；
			 *   · 锚点用官方已有的 `data-chat-turn`（回退 `data-chat-anchor-key`）—— 每轮一个刻度；
			 *   · 位置按**文档流比例**算（相对滚动容器的 rect），点击 `scrollIntoView` 滚到那一轮；
			 *   · 每 3 秒补一次刻度（新回合进来后自动增加），窗口 resize 也重排；
			 *   · 全程 try/catch：这个浮层坏掉也绝不影响聊天本身。
			 */
			const installLocalRail = (view) => {
				if (state.localRail) {
					return state.localRail;
				}
				// ⚠ 挂到 `document.body` + `position:fixed`，**不动官方 DOM 结构**。
				//   早先想挂进 `[data-slot="conversation.view"]` 并把它改成 relative —— 那会改变
				//   官方 absolute 子元素的定位上下文（可能把右栏/浮层挪位置），风险不可控 ✗。
				const rail = document.createElement("div");
				rail.className = "vs-local-rail";
				rail.title = "轮次导航：点击定位到某一轮";
				rail.style.cssText = "position:fixed;width:12px;z-index:2147483000;pointer-events:none;display:none;";
				const inner = document.createElement("div");
				inner.style.cssText = "position:relative;width:100%;height:100%;";
				rail.appendChild(inner);
				document.body.appendChild(rail);

				const repaint = () => {
					try {
						const scroller = document.querySelector("[data-conversation-scroll]");
						const viewEl = document.querySelector('[data-slot="conversation.view"]');
						if (!scroller || !viewEl || !inner.isConnected) {
							rail.style.display = "none";
							return;
						}
						// fixed 浮层跟随聊天视图的位置（不依赖父级定位上下文）
						const vr = viewEl.getBoundingClientRect();
						if (vr.width < 240 || vr.height < 160) {
							rail.style.display = "none";
							return;
						}
						rail.style.display = "block";
						rail.style.left = Math.round(vr.right - 18) + "px";
						rail.style.top = Math.round(vr.top + 8) + "px";
						rail.style.height = Math.round(vr.height - 16) + "px";
						const seen = {};
						const nodes = [];
						const all = scroller.querySelectorAll("[data-chat-turn],[data-chat-anchor-key]");
						for (const n of all) {
							const k = n.getAttribute("data-chat-turn") || n.getAttribute("data-chat-anchor-key");
							if (!k || seen[k]) {
								continue;
							}
							seen[k] = 1;
							nodes.push(n);
						}
						const scrollTop = scroller.scrollTop || 0;
						const total = scroller.scrollHeight || 1;
						const baseRect = scroller.getBoundingClientRect();
						const h = inner.clientHeight || 1;
						inner.textContent = "";
						nodes.forEach((node, i) => {
							// 相对滚动容器的文档流偏移（比 offsetTop 可靠：不受中间定位祖先影响）
							const relTop = node.getBoundingClientRect().top - baseRect.top + scrollTop;
							const btn = document.createElement("button");
							btn.type = "button";
							btn.title = "第 " + (i + 1) + " 轮";
							btn.style.cssText = "position:absolute;right:0;width:12px;height:3px;padding:0;border:0;"
								+ "border-radius:1px;cursor:pointer;pointer-events:auto;opacity:.45;background:#9a9a9a;";
							btn.style.top = Math.max(0, Math.min(h - 3, Math.round((relTop / total) * h))) + "px";
							btn.addEventListener("click", (e) => {
								e.stopPropagation();
								e.preventDefault();
								node.scrollIntoView({ block: "start", behavior: "smooth" });
							});
							btn.addEventListener("mouseenter", () => { btn.style.opacity = "1"; btn.style.height = "6px"; btn.style.background = "#3794ff"; });
							btn.addEventListener("mouseleave", () => { btn.style.opacity = ".45"; btn.style.height = "3px"; btn.style.background = "#9a9a9a"; });
							inner.appendChild(btn);
						});
						state.rail = { found: false, local: true, marks: nodes.length };
					} catch { /* 浮层自身不许影响主流程 */ }
				};
				const handle = { repaint };
				state.localRail = handle;
				repaint();
				setInterval(repaint, 3000);
				window.addEventListener("resize", repaint);
				return handle;
			};

			const enforceRail = () => {
				try {
					const nav = document.querySelector('[data-slot="conversation.view"] nav')
						|| document.querySelector('nav[aria-label="轮次导航"]');
					if (!nav) {
						state.rail = { found: false, local: !!state.localRail };
						const view = document.querySelector('[data-slot="conversation.view"]');
						if (view) { installLocalRail(view); }
						return;
					}
					if (getComputedStyle(nav).display === "none") {
						nav.style.setProperty("display", "block", "important");
					}
					const r = nav.getBoundingClientRect();
					state.rail = {
						found: true,
						marks: nav.querySelectorAll('button[data-index]').length,
						w: Math.round(r.width),
						h: Math.round(r.height),
					};
				} catch { /* 兜底与诊断都不许影响主流程 */ }
			};
			enforceRail();
			setInterval(enforceRail, 1000);

			// ── 连接状态条（2026-10-18）──────────────────────────────────────────────
			// 为什么要有：真机上会话没打开时页面停在官方 hero，输入框被官方 `inert` 禁用，**界面上没有任何
			// 提示**——用户只能对着一个点不动的输入框猜（"输入框无法输入"的主观体验就是这么来的）。
			// 现在：会话没打开超过 3 秒就在顶部给一条小状态条，写明**正在等什么**与**已等多久**；
			// 超过 60 秒再露出「重试」按钮（立即重置所有退避，马上重来一轮）。会话一打开就移除。
			// 纯 DOM、不依赖 dsh 的槽位（hero 在官方 inert 区域里，插槽不一定渲染）✓。
			// 阈值可被 `window.__vssarosConnectTuning` 覆盖——仅供 e2e 缩短等待，生产不设。
			const STATUS_ID = "vssaros-connect-status";
			const tune = () => (typeof window !== "undefined" && window.__vssarosConnectTuning) || {};
			const removeStatus = () => {
				try { const e = document.getElementById(STATUS_ID); if (e) { e.remove(); } } catch { /* 忽略 */ }
			};
			const retryNow = () => {
				// 重置**所有**退避/节流，让下一个 tick 立刻重来；在途的请求不取消（取消=重蹈互相覆盖的覆辙）。
				registerNextAt = 0; registerErrors = 0;
				if (Date.now() - registerStartedAt > 5000) { registerPending = false; }
				lastRosterRefreshAt = 0; rosterBackoffMs = ROSTER_BACKOFF_MS[0];
				lastAlignAt = 0; navState.aligned = null;
				idleTicks = 0;
				// 手动重试 = 用户明确要求再来一次 ⇒ 解除熔断（否则按钮是死的）
				longCallTimeouts = 0; longCallPending = false;
				state.longCallsBroken = false; state.longCallError = null; state.longCallTimeouts = 0;
				state.manualRetries = (state.manualRetries || 0) + 1;
			};
			const statusText = () => {
				if (!rpcReadyEarly()) {
					// ★ 2026-10-19（真机日志）：Host 冷启实测 **24s**（24 个插件）+ 客户端连接阶梯 **17.7s / 6 次抖动**
					//   ⇒ 前 10~20 秒一定会看到这条。原文案只写"正在连接 Host…"，用户无法判断是"慢"还是"死" ✗
					//   ⇒ 给出**预期时长**；曾经连上过的话说"重新连接"（语义不同，别混）。
					return state.everReady
						? "正在重新连接 Host…"
						: "Host 正在启动（首次约 20–30 秒）";
				}
				// 熔断：连续超时 ⇒ 已停止再发请求（再发只会继续占满连接）。必须写明原因与出路。
				if (longCallsBroken()) { return "与 Host 的连接无响应，已暂停重试——请点「重试」，或执行命令「DSH: 重启 Host」"; }
				// ★ 2026-10-19：`openWorkspace` 超时过 ⇒ 明确说出来（从前只会停在"正在打开会话…"，
				//   用户与排查者都不知道卡在连接工作区这一层 ✗）。
				if (state.alignTimeouts) { return "工作区连接超时，正在重试"; }
				if (state.registerWaitingOwner) { return "等待工作区就绪…"; }
				if (registerPending) { return "正在登记会话…"; }
				if (rosterRefreshPending) { return "正在载入会话列表…"; }
				// ★ 2026-10-19：把**真实原因**说出来（从前只说"失败" ⇒ 用户和排查者都无从下手 ✗）。
				//   本仓纪律：可见文案必须描述真发生的事。错误可能很长 ⇒ 截断到一行能放下的长度，
				//   完整原文仍写进 `body.dataset.vssarosRegisterError`（取证用，见 mark()）。
				if (state.registerError) {
					const why = String(state.registerError).replace(/\s+/g, " ").trim().slice(0, 70);
					return "登记会话失败：" + why + "（稍后自动重试）";
				}
				return "正在打开会话…";
			};
			const renderStatus = () => {
				if (!document.body) { return; }
				exposeRegisterError();   // 每帧把真实原因同步到 dataset（清空时也删掉）
				// ★ 2026-10-19：记住"曾经连上过" —— 用于区分「Host 正在启动」与「重新连接」（文案不同，见 statusText）
				if (rpcReadyEarly()) { state.everReady = true; markTiming("rpc"); }
				const waited = Math.round((Date.now() - bindStartedAt) / 1000);
				const showAfter = typeof tune().showAfterMs === "number" ? tune().showAfterMs : 3000;
				const retryAfter = typeof tune().retryAfterMs === "number" ? tune().retryAfterMs : 60000;
				state.connectWaitedSec = waited;
				if (Date.now() - bindStartedAt < showAfter) { return; }
				let el = document.getElementById(STATUS_ID);
				if (!el) {
					el = document.createElement("div");
					el.id = STATUS_ID;
					el.setAttribute("data-vssaros-connect", "1");
					el.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:10px;padding:6px 14px;border-radius:999px;font:12px/1.4 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:var(--dsw-alias-label-secondary,#d0d0d0);background:var(--dsw-alias-background-elevated,#2a2a2a);border:1px solid var(--dsw-alias-border-default,#3a3a3a);box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap;";
					const dot = document.createElement("span");
					dot.style.cssText = "width:6px;height:6px;border-radius:3px;background:var(--dsw-alias-brand-primary,#297aa0);flex:0 0 auto;";
					const text = document.createElement("span");
					text.setAttribute("data-k", "text");
					const btn = document.createElement("button");
					btn.setAttribute("data-k", "retry");
					btn.type = "button";
					btn.textContent = "重试";
					btn.style.cssText = "display:none;pointer-events:auto;cursor:pointer;padding:2px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-default,#4a4a4a);background:transparent;color:inherit;font:inherit;";
					btn.addEventListener("click", (ev) => { ev.stopPropagation(); retryNow(); });
					el.append(dot, text, btn);
					document.body.appendChild(el);
				}
				const textEl = el.querySelector('[data-k="text"]');
				const btnEl = el.querySelector('[data-k="retry"]');
				if (textEl) { textEl.textContent = statusText() + "（已等待 " + waited + " 秒）"; }
				if (btnEl) { btnEl.style.display = (Date.now() - bindStartedAt) >= retryAfter ? "inline-block" : "none"; }
				state.connectStatus = textEl ? textEl.textContent : null;
			};
			const timer = setInterval(() => {
				const sid = currentSessionId;
				if (!sid) {
					return;
				}
				// ★ 2026-10-17：roster 规模在**每 tick 最开始**就记一次 —— 从前写在"未打开"分支里，
				//   会话一开成功就提前 return ⇒ 自证恒 `rosterSize:null`（e2e 因此误红 ✗）。
				try {
					const l = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
					state.rosterSize = l && l.byId ? Object.keys(l.byId).length : 0;
				} catch { /* 诊断位不能影响主流程 */ }
				// ★ 2026-10-20（量化"载入历史为什么 5.4s"）：每 tick 记一次**用户可感知的里程碑**。
				//   实测 `timing` 只有 `{opened:0, parts:104}` —— 因为 `rpc`/`aligned` 的打点都在"快速路径"
				//   上被跳过（DOM 首帧就有会话节点 ⇒ opened 立刻 true ⇒ 不走 renderStatus/connectFor）✗。
				//   ⇒ 在 tick 里补三个**一定会经过**的点：
				//     · rpc        = RPC 首次可用
				//     · firstTurn  = 第一条消息节点出现（真正的"历史开始渲染"）
				//     · composer   = 输入框出现（用户的"能用"）
				//   `markTiming` 只记首次 ✓
				if (rpcReadyEarly()) { markTiming("rpc"); }
				// ⚠ 2026-10-20 实测：`[data-chat-turn]` 在 **IDE 里的聊天框**没匹配到（真机 timing 只有
				//   parts/composer，firstTurn 从未出现）⇒ 用三个官方钩子任一命中即算"历史开始渲染"：
				//   `data-chat-anchor-key` / `data-chat-flow` 是每条消息/过程组都有的更基础钩子。
				if (document.querySelector('[data-chat-turn]')
					|| document.querySelector('[data-chat-anchor-key]')
					|| document.querySelector('[data-chat-flow]')) {
					markTiming("firstTurn");
				}
				if (document.querySelector('[data-composer-card]')) { markTiming("composer"); }
				const opened = !!document.querySelector('[data-sidebar-right-session="' + sid + '"]');
				if (opened) {
					// ★★ 2026-10-20（用户：「好像是聊天框加载了一个已经被删除的会话」）：
					//   DOM 里有该会话节点 ≠ 会话真的在 dsh 花名册里。实测自证：
					//     opened=true / composer=true 但 lastOpenError = sessions.retain: unknown session …
					//   ⇒ 页面把**残留/恢复的 DOM** 当成了"已打开"，显示的是上一次的内容 ✗。
					//   这里把"DOM 有、roster 无"如实标出来（`staleOpen`），并**清掉**已过期的
					//   `lastOpenError`（成功之后还挂着旧错误，会让人以为一直是坏的 ✗）。
					try {
						const snap = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
						const inRoster = !!(snap && snap.byId && snap.byId[sid]);
						state.staleOpen = !inRoster && state.registered !== true;
					} catch { state.staleOpen = null; }
					if (state.lastOpenError) { state.staleLastOpenError = state.lastOpenError; state.lastOpenError = null; }
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
				state.degraded = false;
				removeStatus();
				return;
			}
			state.opened = false;
			renderStatus();
			idleTicks += 1;
			// 降频线（默认 240 tick = 120s；e2e 可经 `__vssarosConnectTuning.degradeAfterTicks` 缩短，生产不设）
			const degradeAt = typeof tune().degradeAfterTicks === "number" ? tune().degradeAfterTicks : 240;
			// ★ 2026-10-18 **不再放弃**。此处曾是"连续 120 秒开不出来就 `clearInterval` 永久停止"，
			//   真机日志（`giveUps:1`，Host 冷启动期间页面链路不稳）证明这是错的：冷启动窗口一过，
			//   链路早就恢复了，可轮询已经死了 ⇒ 页面从此永远停在 hero，6 分钟后仍如此。
			//   ⇒ 超过 `degradeAt`（默认 240 tick = 120s）改为**降频**（每 60 tick = 30s 做一轮），一直试到成功；
			//   `openGiveUps` 改记"进入降频的次数"（名字沿用以免动自证口径）。
			//   用户点状态条上的「重试」或换绑会把 `idleTicks` 清零回到全速。
			if (idleTicks === degradeAt + 1) {
				state.openGiveUps = (state.openGiveUps || 0) + 1;
				state.degraded = true;
				state.attempts = 0;
			}
			if (idleTicks > degradeAt && idleTicks % 60 !== 0) {
				return;
			}
			state.attempts++;
			try {
					// ★★ 2026-10-17 真机定位（弹窗停在 hero、输入框禁用；自证读数 `openRetries:68 roster:0`）：
					//   官方 `openWorkspace` 是"**后来的导航取代前一个**"语义（navigation 服务
					//   `beginNavigation` 会 abort 上一次）⇒ 本循环每 500ms 调一次，
					//   等于每 500ms 自我取消一次 ⇒ 工作区永远开不完 ⇒ 会话永远进不了 roster ✗✗
					//   （chat 视图没暴露这个 bug，是因为它的会话早就在 roster 里了）。
					//   ⇒ 改成"进行中不重发 + 至少隔 8s 再试"，并**等它完成**再 openSession ✓。
					// ★★ 会话 roster 的**拉取**（2026-10-17 真机最后一环）：`sessions.list` 快照有
					//   `phase: 'pending' | 'ready'`，官方注释原话 —— "pending（还没有成功拉取过 ——
					//   items 为空**不等于**没有会话，而是**什么都没到**）"。拉取靠 `refreshList()`；
					//   官方是**侧栏 WorkspaceBrowser** 在挂载时触发的，而全窗里那个组件被我们替换掉了
					//   ⇒ 全窗页面永远 pending、roster 恒空 ⇒ openSession 恒 "unknown session" ✗✗
					//   ⇒ 这里自己触发（节流 5s，失败不刷屏）。
					const rosterSize = (() => {
						try {
							const l = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
							return l && l.byId ? Object.keys(l.byId).length : 0;
						} catch { return 0; }
					})();
					state.rosterSize = rosterSize;
					// ★★★ 2026-10-18 在线实测给出的最终方案：**不再等全量列表**，先把自己登记进 roster。
					//   事实链（全部真机/源码取证）：
					//   · `sessions.refresh()` 在 757 条会话上**单次 ~22s**（主窗口 chat 页 `refreshMs:22115`），
					//     弹窗是新页面，必须自己再付一次 ⇒ 用户盯着 hero 22 秒 + 我们的重试/重建又把它打断；
					//   · `retain()` 放行条件（`resolveTarget`）= `sessions.has(id)` **或** `summaries` 里有该 id；
					//   · `manager.create({ sessionId })` 契约原文：*on success merge into summaries immediately
					//     (no wait for the next refresh)*，且 `sessionId` 是 "an optional blank Session to reuse"
					//     ——弹窗的会话正是 IDE 刚 `session.start` 的空会话 ⇒ **完美契合** ✓。
					//   ⇒ 对"我要开的这条"直接 `create({ sessionId })`：秒级进 roster、秒级 `openSession`，
					//     全量 `refresh()` 退为后台补全（侧栏标题/其它会话要靠它，但不再阻塞进入会话）。
					//   重试策略见声明处（在途单发 / 60s 未返回可重发 / 失败退避 / 无总次数上限）；
					//   结果全部进自证（registerMs/registerError/registerTries/…）。
					const nowT = Date.now();
					// ★★ 2026-10-20（首屏实测：openSession 白等全量列表 1708ms；1791 条会话）：**快速入册**。
					//   `retain()` 的放行条件只是"summaries 里有这一行"（session-controller `resolveTarget`）。
					//   而 `session/projections({sessionId})` 只读这一条会话（实测 16ms），能拿到 blank / title /
					//   lastPromptAt ⇒ 用官方自己的 `recordMutation({ kind: "placeholder" })` 插一行占位就能立刻打开。
					//   为什么用 placeholder 而不是 upsert：官方 `applyMutation` 规定 placeholder 遇到**已存在**的行
					//   只补缺失的元数据、不覆盖 running/agentAvailable ⇒ 全量列表回来时以它为准，不会被占位行污染 ✓
					//   （列表在途时 mutation 会被缓存并在基线上重放，同一条规则保证安全 ✓）。
					//   只读、不建会话；任何一步不可用（老版本 / 方法缺失 / 投影失败）就回到原路（等全量列表）。
					if (rpcReadyEarly() && !rosterHas(sid) && !fastListPending && !fastListDone) {
						const svc = ctx.sessions;
						const manager = svc && svc.manager;
						let owner = null;
						try {
							const w = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
							const items = (w && w.list ? w.list.getSnapshot().items : null) || [];
							owner = items.find((x) => x && Array.isArray(x.sessionIds) && x.sessionIds.indexOf(sid) >= 0) || null;
						} catch { owner = null; }
						if (owner && svc && typeof svc.refreshProjections === "function"
							&& manager && typeof manager.recordMutation === "function" && typeof manager.projectionValues === "function") {
							fastListPending = true;
							const t0 = Date.now();
							void Promise.resolve(svc.refreshProjections(sid)).then(() => {
								const vals = manager.projectionValues(sid);
								const meta = vals && vals.sessionListMetadata ? vals.sessionListMetadata : null;
								// 投影里什么都没有 ⇒ Host 上很可能没这条会话 ⇒ 别插假行，交给原路（列表 + 必要时 create）
								if (!vals || !meta) { state.fastListSkipped = "no projections"; return; }
								if (!rosterHas(sid)) {
									manager.recordMutation({
										kind: "placeholder",
										summary: {
											sessionId: sid,
											agentAvailable: true,
											running: false,
											blank: meta.blank !== false,
											updatedAt: typeof meta.lastPromptAt === "number" ? meta.lastPromptAt : Date.now(),
											cwd: owner.path,
										},
									});
								}
								state.fastListMs = Date.now() - t0;
								state.fastListed = rosterHas(sid);
								pushConnLog("fast-list", { ms: state.fastListMs, has: state.fastListed });
								if (state.fastListed && currentSessionId === sid) {
									connectFor(sid);
									navigate(sid);
								}
							}).catch((e) => {
								state.fastListError = String((e && e.message) || e);
							}).then(() => {
								fastListPending = false;
								fastListDone = true;   // 每个会话只试一次；失败就走原路
							});
						}
					}
					// ★★ 2026-10-20（真机：每打开一次会话就多出空会话，今天 60 个新会话目录里 52 个是 Host 铸的）：
					//   Host 的 `session.create({sessionId})`（dsh-api-session-controller `claim()`）语义是：
					//     · Host **没有**这条会话 ⇒ 按请求的 id 新建 ✓
					//     · 有、且是空的 ⇒ 复用 ✓
					//     · 有、但**已经开始过回合** ⇒ **另铸一条新会话**，返回新 id ✗
					//   从前这里一连上就 create ⇒ 打开任何有历史的会话都会多造一条空会话，
					//   而且返回的是新 id ⇒ `rosterHas(sid)` 仍为 false ⇒ 还白等一轮退避（实测 openRetries:4、3.5s 才在屏）。
					//   ⇒ **先拉一次列表**（`rosterListed`），列表里有就直接打开，不再 create；
					//     只有列表**确认没有**这条会话时才允许 create（此时 Host 必定按请求的 id 建，不会铸新）。
					//     列表拉取失败时也放开 create（退回旧行为：宁可多一条空会话，也不能打不开）。
					if (rpcReadyEarly() && !rosterHas(sid) && (rosterListed || rosterListFailed) && !longCallsBroken() && !longCallPending
						&& nowT >= registerNextAt
						&& (!registerPending || nowT - registerStartedAt > REGISTER_REISSUE_MS)) {
						try {
							const svc = ctx.sessions;
							// ⚠ **必须带归属信息**：2026-10-18 实测只传 `{ sessionId }` 被 Host 拒绝 ——
							//   `session/conflict: session "…" belongs to "<工作区>", not "C:\Users\<用户>"`
							//   （Host 校验"会话 id ↔ 工作目录"归属，缺省时用进程 cwd 当目标 ⇒ 对不上）。
							//   ⇒ 从 `workspaces` 快照找**拥有这条会话**的工作区，传它的 `workspaceId`。
							let ownerWorkspaceId;
							try {
								const w = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
								const items = (w && w.list ? w.list.getSnapshot().items : null) || [];
								const owner = items.find((x) => x && Array.isArray(x.sessionIds) && x.sessionIds.indexOf(sid) >= 0);
								ownerWorkspaceId = owner ? owner.workspaceId : undefined;
								state.registerOwner = ownerWorkspaceId || null;
							} catch { /* 取不到归属就不传 */ }
							if (!ownerWorkspaceId) {
								// 工作区快照里还没有这条会话（刚 session.start 的会话可能晚到）⇒ 本轮不发，下轮再来
								state.registerWaitingOwner = true;
							} else if (svc && typeof svc.create === "function") {
								state.registerWaitingOwner = false;
								const token = ++registerToken;
								registerPending = true;
								registerStartedAt = nowT;
								longCallPending = true;
								longCallStartedAt = nowT;
								registerTries += 1;
								state.registerTries = registerTries;
								// 超时只记账（真正的请求无法取消）；到期未完 ⇒ 计一次超时并放开闸门，
								// 连续 2 次后 `longCallsBroken()` 让后续**不再发**长请求 ✓
								const regTimer = setTimeout(() => {
									if (registerPending) {
										registerPending = false;
										noteLongCallTimeout();
									}
								}, longCallTimeoutMs());
								void Promise.resolve(svc.create({ sessionId: sid, workspaceId: ownerWorkspaceId })).then((res) => {
									clearTimeout(regTimer);
									state.registerMs = Date.now() - nowT;
									state.registerResult = (() => { try { return JSON.stringify(res).slice(0, 120); } catch { return String(res); } })();
									// Host 返回的 id 与请求的不同 ⇒ 它**另铸了一条空会话**（见登记闸门处的注释）。
									//   新闸门下不该再发生；万一发生，把它记下来，别再静默造垃圾。
									try {
										const got = res && typeof res === "object" ? (res.sessionId || (res.value && res.value.sessionId)) : undefined;
										if (got && got !== sid) {
											state.registerMinted = (state.registerMinted || 0) + 1;
											state.registerMintedId = got;
											pushConnLog("minted", { got: String(got).slice(-12) });
										}
									} catch { /* 诊断失败无所谓 */ }
									if (token === registerToken) { registerPending = false; }
									maybeLongOk();
									if (rosterHas(sid)) {
										registered = true; state.registered = true; state.registerError = null; registerErrors = 0;
									} else if (token === registerToken) {
										// 返回了，但 roster 里仍没有 ⇒ 按失败处理（退避后再来）
										registerErrors += 1;
										registerNextAt = Date.now() + registerBackoff();
									}
								}).catch((e) => {
									clearTimeout(regTimer);
									state.registerMs = Date.now() - nowT;
									state.registerError = String((e && e.message) || e);
									// 明确的拒绝（如 session/conflict）也是"有回应"——说明连接是通的，不算熔断超时
									maybeLongOk();
									if (token === registerToken) {
										registerPending = false;
										registerErrors += 1;
										registerNextAt = Date.now() + registerBackoff();
									}
								});
							} else {
								state.registerError = "ctx.sessions.create 不存在";
								registerNextAt = Number.MAX_SAFE_INTEGER;
							}
						} catch (e) { state.registerError = String((e && e.message) || e); }
					}
					// 拉到之后把退避归零（下一次若又空，从 8s 重新开始 ✓）
					// ⚠ 2026-10-18 修：条件曾是 `rosterSize > 0`——弹窗里 roster 常有**别的**会话（主窗口那条），
					//   于是"非空"恒成立，每个 tick 都把退避重置回 8s、`rosterAttempts` 清零 ⇒ 退避序列永远走不下去
					//   （e2e 里表现为第二次 refresh 发不出去；生产里表现为"永远 8s 一发"）。
					//   正确的“拉到了”= **本会话**已在 roster。
					if (rosterHas(sid) && rosterAttempts > 0) { rosterAttempts = 0; rosterBackoffMs = ROSTER_BACKOFF_MS[0]; }
					// ★★ 2026-10-18（真机：`rosterRefreshing` 恒 true、页面最终卡死）：
					//   ① **连接就绪前不发**：`workspaces` 快照为空 = 客户端 RPC 还没通，
					//      这时发 `sessions.refresh()` 只会进入"发了→超时→再发"的互相取消循环
					//      （738 条列表本身就慢，5s 一发的重试会把上一次不断作废 ✗）。
					//   ② **指数退避**：8s → 20s → 45s → 90s，给单次拉取留够时间。
					const rpcReady = (() => {
						try {
							const w = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
							const ws = w && w.list ? w.list.getSnapshot() : null;
							return !!(ws && Array.isArray(ws.items) && ws.items.length > 0);
						} catch { return false; }
					})();
					if (!rosterHas(sid) && rpcReady && !rosterRefreshPending && !longCallsBroken() && !longCallPending
					&& Date.now() - lastRosterRefreshAt > effectiveBackoff()) {
						lastRosterRefreshAt = Date.now();
						try {
							// ⚠ 服务面上的方法名是 **refresh()**（内部才调 manager.refreshList()）——
							//   2026-10-17 实测：写 `refreshList()` 时 `typeof` 判空直接跳过，
							//   错误字段恒空、roster 恒 0，白查一轮 ✗。两个名字都试，记录用的哪个 ✓。
							const svc = ctx.sessions;
							const fn = svc && (typeof svc.refresh === "function" ? svc.refresh
								: typeof svc.refreshList === "function" ? svc.refreshList : null);
							if (fn) {
								state.rosterRefreshVia = fn === svc.refresh ? "refresh" : "refreshList";
								// ★★ 防重入（2026-10-17 第二轮真机：`rosterVia=refresh` 但 `rosterAfter=null`、
								//   roster 恒 0 ⇒ 拉取**没完成**）。慢拉取（>5s）会被下一次调用覆盖 ⇒
								//   永远等不到结果，和 `openWorkspace` 自我取消是同一类坑 ✗。
								//   ⇒ 进行中不再发；完成后才允许下一次。
								rosterRefreshPending = true;
								state.rosterRefreshing = true;
								longCallPending = true;
								longCallStartedAt = Date.now();
								rosterAttempts += 1;
								rosterBackoffMs = ROSTER_BACKOFF_MS[Math.min(rosterAttempts, ROSTER_BACKOFF_MS.length - 1)];
								state.rosterAttempts = rosterAttempts;
								// ★★ 2026-10-18 两层实测叠加：
								//   ① 健康时 `sessions.refresh()` 在 757 条会话上单次 ~22s（不是挂死）；
								//   ② 连接池被占满时它**永不返回**。所以超时设 45s（>22s 留余量），到期**记账并熔断**，
								//      而不是再发——真请求无法取消，再发只会继续占 socket（见 longCall* 声明处）。
								const settle = () => {
									rosterRefreshPending = false;
									state.rosterRefreshing = false;
								};
								const timer = setTimeout(() => {
									if (rosterRefreshPending) {
										settle();
										state.rosterRefreshTimeouts = (state.rosterRefreshTimeouts || 0) + 1;
										rosterListFailed = true;   // 超时 ⇒ 放开 create 兜底（见登记处注释）
										noteLongCallTimeout();
									}
								}, longCallTimeoutMs());
								const refreshStartedAt = Date.now();
								void Promise.resolve(fn.call(svc)).then(() => {
									const l = svc.list ? svc.list.getSnapshot() : null;
									state.rosterHasList = !!l;
									state.rosterState = l ? l.state : null;
									state.rosterPhase = l ? l.phase : null;
									state.rosterSizeAfterRefresh = l && l.byId ? Object.keys(l.byId).length : null;
									state.rosterRefreshMs = Date.now() - refreshStartedAt;
									rosterListed = true;
									state.rosterListed = true;
									pushConnLog("roster", { ms: state.rosterRefreshMs, has: rosterHas(sid) });
									maybeLongOk();
								}).catch((e) => {
									state.rosterRefreshError = String((e && e.message) || e);
									rosterListFailed = true;
									maybeLongOk();
								}).then(() => {
									clearTimeout(timer);
									settle();
									// ★ 2026-10-20：拉到就**立刻**打开，不等下一个 500ms 节拍（列表里有它 ⇒ openSession 直接成功）。
									//   若列表里仍没有，下一拍的登记闸门会放行 create（此时 Host 必定按请求 id 建，不会铸新）。
									try {
										if (rosterHas(sid) && currentSessionId === sid) {
											connectFor(sid);
											navigate(sid);
										}
									} catch { /* 下一拍还会再来 */ }
								});
							} else {
								state.rosterRefreshError = "no refresh method on ctx.sessions";
							}
						} catch (e) { rosterRefreshPending = false; state.rosterRefreshError = String((e && e.message) || e); }
					}
					// ★ 见 navState 注释：先只连（成功前不导航），连上之后才导航。
					connectFor(sid);
					navigate(sid);
				} catch (e) {
					// `openSession` 在客户端会话 roster 尚未载入该会话时会抛（实测
					// `sessions.retain: unknown session <id>`）——这是**本轮询预期内的瞬时状态**
					// （轮询本身就是为等 roster 就绪而存在），不能写进 state.error：那是"插件出错"
					// 的信号，被它污染后界面自检与 e2e 都会误报。单独记重试次数。
					const msg = String((e && e.message) || e);
					if (/unknown session/i.test(msg)) {
						state.openRetries = (state.openRetries || 0) + 1;
						// 长时间不认这个会话 ⇒ 可能是"连上的其实是别的工作区"（换绑/多根场景）：
						// 每 60 次（约 30s）放开一次对齐闸门，让 connectFor 重连（它自带 8s 节流 ✓）。
						if ((state.openRetries || 0) % 60 === 0) { navState.aligned = null; }
					} else {
						state.error = msg;
						state.lastOpenError = msg;
					}
				}
			}, 500);
			window.addEventListener("pagehide", () => clearInterval(timer));

			/**
			 * 找"拥有该会话的工作区"（= VsSaros 当前工作区），只记账、不导航。
			 *
			 * 历史：这里原本会先 `uiWorkspace.openWorkspace()` 把页面的工作区选择对齐过去
			 * （当时实测选择器会落在别的工作区上）。2026-10-20 读官方源码确认：那个调用会让 Host
			 * **新建一条空会话**（详见函数体里的注释），而且官方的"当前工作区"本来就由选中会话推出 ⇒
			 * 现在只要 openSession(sid)，工作区自然正确。保留本函数是为了不动 connectFor 的闸门结构。
			 */
			const alignWorkspace = (sid) => {
				try {
					const workspaces = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
					const snapshot = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
					const items = (snapshot && snapshot.items) || [];
					const owner = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sid) >= 0);
					if (owner) {
						state.workspace = owner.workspaceId;
						// ★★ 2026-10-20（今天 60 个新会话目录里 52 个是空会话 —— 主要就是这里造的）：
						//   **不再调 `ctx.uiWorkspace.openWorkspace()`**。官方实现（dsh-client-ui-workspace）是
						//     openWorkspaceSession(id) → connectBlank(id, undefined) → sessions.create({ workspaceId })
						//   ⇒ **每调一次就让 Host 新建一条空会话**，再把页面导航过去；随后我们的 openSession
						//   又导航回本会话 —— 那条空会话就永久留在列表里 ✗（复现：调用报错原文
						//   `session create failed: … session/create failed`）。
						//   而"当前工作区"在官方里本来就是**由选中的会话推出来的**（ui-workspace
						//   `startSession`：`workspace.items.find(item => item.sessionIds.includes(current))`；
						//   ui-conversation 同理）⇒ 只要 openSession(sid)，工作区自然就对了，无需先"对齐"。
						//   这里只记下归属并立即放行（仍返回 Promise，保持调用方 connectFor 的闸门语义不变）。
						return Promise.resolve();
					}
				} catch (e) {
					state.workspaceError = String((e && e.message) || e);
				}
				return undefined;
			};

			/**
			 * 连接闸门（**唯一**的发起点）：只在"未连上 + 没有连接在飞 + 过了节流"时发一次
			 * `openWorkspace()`，成功后才把 `navState.aligned` 置真。
			 * ⚠ 一旦 aligned 就不再发连接 —— 重发等于把当前已连好的工作区再导航一次，
			 *   已开着的会话会被打断（官方语义：后来的导航取代前一个）。
			 */
			const connectFor = (sid) => {
				if (navState.connecting || navState.aligned) { return; }
				if (Date.now() - lastAlignAt <= ALIGN_RETRY_MS) { return; }
				lastAlignAt = Date.now();
				const p = alignWorkspace(sid);
				if (!p || typeof p.then !== "function") { return; }
				navState.connecting = p;
				// ★★ 2026-10-19（用户截图「正在打开会话…（已等待 38 秒）」+ 代码路径定位）：
				//   `openWorkspace()` 可能**永不 settle**（Host 侧挂住 / 连接池占满）。
				//   从前 `navState.connecting` 会一直有值 ⇒
				//     · `connectFor()` 每轮早退（不再发连接）
				//     · `navigate()` 也每轮早退（连接在飞时不许导航）
				//   ⇒ 界面永远停在「正在打开会话…」，**没有超时、没有重试、没有熔断** ✗✗
				//   这里加超时：到期清闸门并记账，下一轮自然重发（仍受 ALIGN_RETRY_MS 节流）。
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) { return; }
					settled = true;
					navState.connecting = null;
					state.alignTimeouts = (state.alignTimeouts || 0) + 1;
					state.lastAlignError = "openWorkspace 超时（" + ALIGN_TIMEOUT_MS + "ms 未返回）";
				}, ALIGN_TIMEOUT_MS);
				void Promise.resolve(p).then(
					() => {
						if (settled) { return; }
						settled = true; clearTimeout(timer);
						navState.connecting = null; navState.aligned = true;
						state.alignTimeouts = 0; state.lastAlignError = null;
						markTiming("aligned");   // 工作区对齐完成（此后才允许 openSession）
					},
					() => {
						if (settled) { return; }
						settled = true; clearTimeout(timer);
						navState.connecting = null;
					},
				);
			};

			/**
			 * 导航（选择会话）。**连接在飞时一律不发**：`openSession` 内部是 `beginNavigation()`，
			 * 发一次就会把 `connectFor` 正在进行的连接 abort 掉（roster 永远填不满的根因）。
			 */
			const navigate = (sid) => {
				if (navState.connecting) { return; }
				// ★★ 2026-10-18 真机日志定位：`openSession` 返回 **Promise**，不接住就是
				//   "未处理的拒绝" —— 界面零反应、`openRetries` 也不涨（日志
				//   `attempts=68 / openRetries=0 / lastOpenError=null` 正是这个形态 ✗✗）。
				//   这里补接：`unknown session` 计重试（预期内瞬时态），其它错误记 `lastOpenError`。
				const onRejected = (e) => {
					const msg = String((e && e.message) || e || "");
					if (!msg) { return; }
					// ★★ 2026-10-19（真机日志：`Sidebar Session opening failed: Session reference
					//   "vssaros-chat-…" is released`）：
					//   被 release 的会话直接 `openSession` 必定失败，而从前这里只记 `lastOpenError`
					//   ⇒ **没人重新拿引用、也不重试** ⇒ 界面永久停在「正在打开会话…（已等待 N 秒）」✗
					//   ⇒ 补一次 `sessions.retain(sid)`（拿回引用），下一轮 tick 的 navigate 就能成功。
					//   节流 2s：navigate 每 500ms 一轮，不节流会变成 retain 风暴。
					if (/unknown session/i.test(msg) || /is released/i.test(msg)) {
						state.openRetries = (state.openRetries || 0) + 1;
						state.lastOpenError = msg;
						// ★★ 2026-10-19（`sessions.retain: unknown session` = 会话不在 roster）：
						//   从前这里只记一次数 ⇒ 下一轮仍走 60~120s 的长退避 ⇒ 会话刚被 Host 建好也白等 ✗
						//   ⇒ 立刻把"重拉 roster / 重新自登记"的闸门打开，下一 tick 就重试。
						if (/unknown session/i.test(msg)) {
							rosterBackoffMs = ROSTER_BACKOFF_MS[0];
							rosterAttempts = 0;
							lastRosterRefreshAt = 0;
							registerNextAt = 0;
						}
						if (/is released/i.test(msg)) {
							const nowR = Date.now();
							if (nowR - (state.lastRetainAt || 0) > 2000) {
								state.lastRetainAt = nowR;
								try {
									const svc = ctx.sessions;
									if (svc && typeof svc.retain === "function") {
										state.retainTries = (state.retainTries || 0) + 1;
										void Promise.resolve(svc.retain(sid)).catch(() => undefined);
									}
								} catch { /* 下一轮还会再试 */ }
							}
						}
					} else {
						state.lastOpenError = msg;
					}
				};
				try {
					const r = ctx.uiWorkspace.openSession(sid);
					if (r && typeof r.then === "function") { r.then(undefined, onRejected); }
				} catch (e) { onRejected(e); }
				// ★ 2026-10-20（实测：retry #1 在 nav+1716ms，而 session.start 在 nav+677ms 就完成了
				//   ⇒ 重试跟"会话还没建好"无关）：这里只**记账**，不做闸门 —— 串行化只会让页面白等 696ms ✗。
				// navigate 每 500 ms 跑一轮（直到会话在屏）⇒ 只记前 3 次，别把 40 条的账本挤满、
				// 把更要紧的连接状态（state / mux-ready / kick）挤出去。
				state.openCalls = (state.openCalls || 0) + 1;
				if (state.openCalls <= 3) { pushConnLog("open", { at: Date.now(), sid: sid.slice(-10) }); }
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
				state.degraded = false;
				// 换绑 = 全新的一次等待：登记状态/退避/计时全部归零，并让在途的旧 create 作废（token 递增）
				registerToken += 1; registerPending = false; registerNextAt = 0; registerErrors = 0;
				registered = false; state.registered = false; state.registerError = null; state.registerWaitingOwner = false;
				// ★ 2026-10-20：换绑后要**重新拉一次列表**才允许 create —— 旧列表可能早于新会话，
				//   拿它判"Host 没有这条"会误放行 create（而目标若是已有历史的会话，create 会另铸一条）。
				rosterListed = false; rosterListFailed = false; lastRosterRefreshAt = 0;
				fastListPending = false; fastListDone = false;
				bindStartedAt = Date.now();
				removeStatus();
				mark();
				// 空白会话首屏只装了不依赖会话的部件 ⇒ 首次拿到真会话 id 时把剩下的补齐（一次）。
				// ⚠ 只在 chat 形态补装：full 形态走到这里时 loadParts 尚未定义（TDZ），
				//   且 full 本来也不装换皮部件（2026-10-17 绑定提升后必须守这条 ✗）。
				if (!restPartsInstalled && bridge.surface === "chat") {
					restPartsInstalled = true;
					void loadParts(PART_CHUNKS.filter((f) => BLANK_SESSION_PARTS.indexOf(f) < 0)).then(() => markTiming("parts"));
				}
				try {
					// 换绑 ⇒ 会话可能落在另一个工作区：放开对齐闸门，允许重新连一次
					//（连接在飞时 connectFor 会自己跳过，不会并发把彼此 abort ✓）。
					navState.aligned = null;
					connectFor(sid);
					navigate(sid);
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


			// ── 以下全部只在聊天框 surface 生效：full（官方整页）只借用上面的会话绑定 ──
		// （工作台导航 / 多根工作区侧栏等在 full 形态由**顶部那个 full-only 分支**装载；
		//   两个分支现在**互斥**（chat 走这里、full 走那边）⇒ 同一个 chunk 不会被装两遍 ✓
		//   —— 2026-10-21 真机：重叠过一次 ⇒ keyed 槽重复注册 ⇒ 中栏工作台面板全没注册 ✗）。
		if (bridge.surface !== "chat") {
			return;
		}

		// 皮肤部件：并行取回各自 chunk，再逐个安装。
			// shell.sessionId 是初始绑定（启动参数）；运行期的当前会话读 state.sessionId。
			const shell = {
				bridge, state, sessionId: bridge.sessionId, mark, rebind,
				// 菜单尺寸夹到页面视口（= WebContentsView 矩形）；见 fitMenuSize。
				// ⚠ 传 `anchor`（触发器 rect 的投影）才能按"菜单从哪儿开始"算 —— 只按整页高算的菜单
				//   底部会落到视口外且滚不到 ✗（2026-10-16 用户报障）。拿不到 rect 就不传（退回旧口径 ✓）。
				fitMenu: (anchor) => fitMenuSize(typeof window === "undefined" ? null : { width: window.innerWidth, height: window.innerHeight }, anchor),
				// 菜单互斥协调器；见 createMenuCoordinator。
				menus: createMenuCoordinator(),
			};
			// 部件在 apply 之外异步装载，**apply 必须保持同步**：fiber 的注入服务在 apply 返回后才就绪，
			// 在 apply 里 await 会把整段皮肤卡在非活跃期（实测写成 async apply → ctx.uiWorkspace 等
			// 一律报 "inactive context"，且 apply 的 promise 悬挂会让插件一直不激活）。
			// 装载失败只记 partErrors，不影响聊天本身。
			const loadParts = (files) => Promise.all(files.map((file) => Promise.resolve()
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
			void loadParts(bridge.sessionId ? PART_CHUNKS : BLANK_SESSION_PARTS).then(() => markTiming("parts"));
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		// 仅测试用：菜单视口适配 / 互斥协调器的纯逻辑（插件装载只读 apply/inject/name）。
		exports.__test = { fitMenuSize, createMenuCoordinator };
		return module.exports;
	}
});
