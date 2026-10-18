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
		const PART_CHUNKS = ["./client.hero.js", "./client.skin.js", "./client.usage.js", "./client.tools.js", "./client.approval.js", "./client.openInApp.js", "./client.hideBridgePing.js", "./client.preset.js", "./client.settings.js", "./client.sessionLabel.js", "./client.workspace.js", "./client.sessions.js", "./client.agents.js", "./client.persona.js", "./client.fileCards.js", "./client.cardActions.js", "./client.todos.js", "./client.subagents.js", "./client.delegate.js", "./client.welcome.js", "./client.capsule.js", "./client.workbenchNav.js", "./client.workspaces.js",
		// 侧栏页脚（品牌 + 工作区/会话规模，2026-10-18 差异清单第 ③ 项）：
		// ⚠ 本块注释里**禁止出现 ASCII 双引号**（连正则字面量也不行）：`PART_CHUNKS` 的提取正则
		//   是「引号 + 至少一个非引号字符 + 引号」，chunk 守卫与 dshPluginPackages 测试都用它 ⇒
		//   注释里的一对引号会被当成一条 chunk 条目，报「PART_CHUNKS 里的 必须接线 不存在」
		//   （2026-10-19：我连续两版栽在这，第二次是注释里又写了正则原文 ✗✗）。引用术语一律用中文引号 ✓。
		// 放进 PART_CHUNKS 是为了满足 chunk 守卫的“必须接线”检查；chunk 自身在 install()
		// 里按 `bridge.chatOnly === false`（带官方 chrome）自门控 ⇒ chat-only 视图里空转 ✓。
		"./client.footer.js"];

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
		if (hasOfficialChrome) {
				void Promise.resolve()
					.then(() => Promise.all([
						require.async("./client.workbenchNav.js"),
						require.async("./client.workspaces.js"),
						// hero（空白会话屏）的「工作区」下拉在**全窗**里也必须与聊天框同一套 UI
						// （分组 + 多根 + 添加工作区）：2026-10-17 用户截图——“工作区下拉框要求和
						// vssaros dsh 聊天框 UI 中的工作区 UI 一致”。该部件对 shell 的依赖全是
						// state/bridge + 可选的 menus/fitMenu（内部已判空 ✓）⇒ 轻量 shell 可用。
						require.async("./client.workspace.js"),
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
			if (!bridge || (bridge.surface !== "chat" && bridge.surface !== "full")) {
				return;
			}

			// 新会话首屏（绑定参数里没有会话 id）也必须装的部件：
			//   · `client.workspace.js` —— hero 上官方那条扁平根列表必须被我们的主从两栏面板顶掉
			//   · `client.hero.js` / `client.welcome.js` —— 首屏换皮
			// 其余部件要会话事实（roster / 人格 / 待办…），等首次重绑拿到真会话 id 再补装一次。
			const BLANK_SESSION_PARTS = ["./client.workspace.js", "./client.hero.js", "./client.welcome.js"];
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
			const registerBackoff = () => REGISTER_ERROR_BACKOFF_MS[Math.min(Math.max(registerErrors, 1) - 1, REGISTER_ERROR_BACKOFF_MS.length - 1)];
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
			const mark = () => {
				if (document.body) {
					document.body.dataset.vssarosSessionId = currentSessionId;
				}
			};
			mark();

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
				if (!rpcReadyEarly()) { return "正在连接 Host…"; }
				// 熔断：连续超时 ⇒ 已停止再发请求（再发只会继续占满连接）。必须写明原因与出路。
				if (longCallsBroken()) { return "与 Host 的连接无响应，已暂停重试——请点「重试」，或执行命令「DSH: 重启 Host」"; }
				if (state.registerWaitingOwner) { return "等待工作区就绪…"; }
				if (registerPending) { return "正在登记会话…"; }
				if (rosterRefreshPending) { return "正在载入会话列表…"; }
				if (state.registerError) { return "登记会话失败，稍后自动重试"; }
				return "正在打开会话…";
			};
			const renderStatus = () => {
				if (!document.body) { return; }
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
					if (rpcReadyEarly() && !rosterHas(sid) && !longCallsBroken() && !longCallPending
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
										noteLongCallTimeout();
									}
								}, longCallTimeoutMs());
								void Promise.resolve(fn.call(svc)).then(() => {
									const l = svc.list ? svc.list.getSnapshot() : null;
									state.rosterHasList = !!l;
									state.rosterState = l ? l.state : null;
									state.rosterPhase = l ? l.phase : null;
									state.rosterSizeAfterRefresh = l && l.byId ? Object.keys(l.byId).length : null;
									maybeLongOk();
								}).catch((e) => {
									state.rosterRefreshError = String((e && e.message) || e);
									maybeLongOk();
								}).then(() => {
									clearTimeout(timer);
									settle();
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
						state.workspace = owner.workspaceId;
						// ⚠ 返回 Promise：调用方要"等它完成"再 openSession，且**不许**每 tick 重发（会自我取消）✓
						return ctx.uiWorkspace.openWorkspace(owner.workspaceId).catch(() => undefined);
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
				void Promise.resolve(p).then(
					() => { navState.connecting = null; navState.aligned = true; },
					() => { navState.connecting = null; },
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
					if (/unknown session/i.test(msg)) {
						state.openRetries = (state.openRetries || 0) + 1;
					} else {
						state.lastOpenError = msg;
					}
				};
				try {
					const r = ctx.uiWorkspace.openSession(sid);
					if (r && typeof r.then === "function") { r.then(undefined, onRejected); }
				} catch (e) { onRejected(e); }
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
				bindStartedAt = Date.now();
				removeStatus();
				mark();
				// 空白会话首屏只装了不依赖会话的部件 ⇒ 首次拿到真会话 id 时把剩下的补齐（一次）。
				// ⚠ 只在 chat 形态补装：full 形态走到这里时 loadParts 尚未定义（TDZ），
				//   且 full 本来也不装换皮部件（2026-10-17 绑定提升后必须守这条 ✗）。
				if (!restPartsInstalled && bridge.surface === "chat") {
					restPartsInstalled = true;
					void loadParts(PART_CHUNKS.filter((f) => BLANK_SESSION_PARTS.indexOf(f) < 0));
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
		// （工作台导航 / 多根工作区侧栏走顶部那个 full 分支装载，不经过这里 ✓）。
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
			void loadParts(bridge.sessionId ? PART_CHUNKS : BLANK_SESSION_PARTS);
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		// 仅测试用：菜单视口适配 / 互斥协调器的纯逻辑（插件装载只读 apply/inject/name）。
		exports.__test = { fitMenuSize, createMenuCoordinator };
		return module.exports;
	}
});
