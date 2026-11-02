// @vssaros/dsh-studio — client half
//
// ── 形态（2026-10-23 决定：走"注册式工作台 + 对话停靠"，不再碰右侧栏）──────────────
//   调研结论：`sidebar.right` 在本窗口的 chat-only 形态里被整条裁掉（点了没反应/卡在打开中），
//   且它的 pane 上限是 2、只作用于"在屏会话" ⇒ 这条路根本走不通 ✗
//   官方真正支持的"页面内真聊天"是：**定制外框工作台（customFrame）+ 对话停靠**
//   —— 宿主 `vssaros-workbenches` 的 Frame 会给组件传 `props.conversation`
//      （内部 = `data-vssaros-wb-dock` 挂载点 + "开始对话"按钮），
//      覆盖层再用 `SessionProvider + conversation.content(variant:'embedded')` portal 进去，
//      所以右侧那格是**官方 chat-surface 本体**（含新会话 hero：选工作区/模式，发第一句才建会话）。
//
// ── 本文件做什么 ──────────────────────────────────────────────────────────────
//   注册一个"注册式工作台"：左侧 iframe 承载站点页面（`/x/studio/`，仍是原来那份 SSR 页），
//   右侧渲染 `props.conversation` ⇒ AI 助手对话。
//
// ⚠ 加载契约：`__ModuleLoader__.load({ id, factory })`；入口**禁止** `chunk:`；也**不能**直接 ESM export。
'use strict';
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-studio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const diag = (globalThis.__vssarosStudio = globalThis.__vssarosStudio || { errors: [], caps: {} });
		const note = (tag, err) => {
			const msg = String((err && err.message) || err);
			if (diag.errors.length < 20) { diag.errors.push(tag + ': ' + msg); }
			try { console.warn('[vssaros-studio] ' + tag + ' 失败：' + msg); } catch { /* 无 console */ }
			return null;
		};

		// ★ 2026-11-02 根治：这里原有「萨罗斯自己设 bot preset + 预填 `@萨罗斯管理平台 ` + 没会话就主动建一条」
		//   的整套逻辑（STUDIO_PRESET / applyPresetToCurrent / ensureDefaults / seedDraft），**已删除**。
		//   它对**全局当前会话**下手，并与另外 4 个写入者互相覆盖 ⇒ agent 反复串台。
		//   现在默认 agent **只由宿主 vssaros-workbenches 设**（对照表 'vssaros/studio' → vssaros-saroasis-studio）。

		/** 右侧对话栏宽度（与 mockup 一致：560 上限 / 半屏）。 */
		const CONV_WIDTH = 'min(560px, 52vw)';
		const BORDER = '1px solid var(--dsw-alias-border-l1, #e5e7ee)';
		/**
		 * 「AI 助手栏」伸缩 —— **与商城工作台（vssaros-marketplace/lib/workbench.js）同一套实现**。
		 * 改动这套行为时必须同步所有工作台，否则用户会看到两种手感（守卫 `check-assistant-collapse.mjs` 兜底）。
		 *
		 * 约定：
		 *  - 收起 = aside `display:none`（**不卸载**，否则会话状态 / 滚动位置 / 流式回复全丢）
		 *  - 收起后不再收成窄条（30px 里塞竖排字会被拆成两列，实测很难看）
		 *  - 收起 / 展开都走右侧中部的**浮动工具栏**（宿主统一渲染）；对话栏左上角**不再**有「» 收起」（2026-11-02 用户要求）
		 *  - 拖拽条在收起时隐藏（此时宽度由 state 决定，拖了会被渲染覆盖）
		 */
		const CONV_MIN = 320;
		const CONV_COLLAPSE_KEY = '__vssarosStudioConvCollapsed';

		/**
		 * 工作台面板：左 = 站点（iframe），右 = 官方对话（`props.conversation`）。
		 * `props.conversation` 由 workbenches 的 Frame 在 `customFrame: true` 时注入；
		 * 未注入（清单没声明 / 宿主较旧）⇒ 右侧不渲染，站点照旧铺满。
		 */
		function StudioPanel(props) {
			// ★ 记录"我们的工作台是否在前台"：官方 hero 里切工作区 / 新建会话走的是**导航语义**
			//   （`uiWorkspace.openSession` → `layout.selectPanel(null)`），会把中栏切到会话页
			//   ⇒ 用户看到"换个工作区就跳到会话页"。本标记供下面的 panel 守卫判断是否该拦。
			const active = !!(props && props.active);
			if (props && props.entry && props.entry.id) { diag.caps.entryId = props.entry.id; }
			react.useEffect(() => {
				globalThis.__vssarosStudioActive = active;
				return () => { if (globalThis.__vssarosStudioActive === active) { globalThis.__vssarosStudioActive = false; } };
			}, [active]);
			const conversation = props && props.conversation ? props.conversation : null;
			// ★ 伸缩状态（与商城工作台一致：React state + localStorage 持久化）
			const collapsedState = react.useState(() => {
				try { return localStorage.getItem(CONV_COLLAPSE_KEY) === '1'; } catch { return false; }
			});
			const collapsed = collapsedState[0];
			const setCollapsed = (next) => {
				collapsedState[1](next);
				try { localStorage.setItem(CONV_COLLAPSE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
				diag.caps.convCollapsed = next;
			};
			// ★ 2026-10-26「S2 一体条」：展开按钮与拖拽已收归外壳（vssaros-workbenches）统一渲染，
			//   本工作台只负责两件事：
			//     ① 在面板根上写 `data-vssaros-assist-collapsed`（外壳据此切换「« 展开 / » 收起」）
			//     ② 收到外壳派发的 expand / collapse 就跟着开合
			//   ⚠ 监听必须挂在 **window** 上：CustomEvent 只向上冒泡，外壳在面板根/帧上派发，
			//     挂在更深的子节点上收不到（2026-10-26 真机 bug：点「«」没反应）。
			react.useEffect(() => {
				const onToggle = (ev) => {
					const target = ev && ev.detail && ev.detail.workbench;
					if (target && target !== 'vssaros/studio') { return; }
					const open = ev.type === 'vssaros:assist-expand';
					collapsedState[1](!open);
					try { localStorage.setItem(CONV_COLLAPSE_KEY, open ? '0' : '1'); } catch { /* ignore */ }
				};
				window.addEventListener('vssaros:assist-expand', onToggle);
				window.addEventListener('vssaros:assist-collapse', onToggle);
				return () => {
					window.removeEventListener('vssaros:assist-expand', onToggle);
					window.removeEventListener('vssaros:assist-collapse', onToggle);
				};
			}, []);
			const site = react.createElement('iframe', {
				src: '/x/studio/',
				title: '萨罗斯管理平台',
				'data-vssaros-studio-site': '',
				// 底色（2026-11-02）：原来写死 #fff ⇒ 深色外观下页面画出第一帧前会白闪一下 ✗
				style: { flex: '1 1 auto', width: '100%', height: '100%', border: 0, background: 'var(--dsw-alias-bg-base, #fff)' },
			});
			const host = react.createElement('div', {
				'data-vssaros-studio-panel': '',
				style: { display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0, height: '100%' },
			}, react.createElement('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex' } }, site));

			if (!conversation) { return host; }

			return react.createElement('div', {
				'data-vssaros-studio-panel': '',
				// 外壳（vssaros-workbenches 的 S2 一体条）据此决定「«」显隐：1 = 助手栏已收起
				'data-vssaros-assist-collapsed': collapsed ? '1' : '0',
				style: {
					display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0, height: '100%',
					position: 'relative',
				},
			},
				react.createElement('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex' } }, site),
				// ★ 拖动条（2026-10-24 用户要求「AI 助手和网站页之间能左右拖动」）
				//   纯 DOM 操作改 aside 宽度（不引入 state ⇒ 不触发重渲染、不打断对话）；
				//   松手后写 localStorage，下次打开还是这个宽度。
				react.createElement('div', {
					'data-vssaros-studio-split': '',
					title: '左右拖动调节宽度（双击复位）',
					style: {
						flex: '0 0 auto', width: '6px', cursor: 'col-resize',
						background: 'transparent', position: 'relative', zIndex: 5,
						// 收起时藏起拖拽条：此时宽度由 state 控制，拖了会被渲染覆盖（表现成"拖不动"）
						display: collapsed ? 'none' : undefined,
					},
					onDoubleClick: (ev) => {
						const aside = ev.currentTarget.nextElementSibling;
						if (aside) {
							// 双击复位：宽度回默认；若正收起着，顺带展开（否则复位看不见效果）
							try { localStorage.removeItem('__vssarosStudioConvW'); } catch { /* ignore */ }
							aside.style.width = CONV_WIDTH;
							if (collapsed) { setCollapsed(false); }
						}
					},
					onMouseDown: (ev) => {
						ev.preventDefault();
						const splitter = ev.currentTarget;
						const aside = splitter.nextElementSibling;
						if (!aside) { return; }
						const siteWrap = splitter.previousElementSibling;

						// ★ 2026-10-25 修「拖到一半丢了」：拖拽条左边就是 iframe，
						//   鼠标一进 iframe，父文档就收不到 mousemove/mouseup（iframe 是独立文档）⇒ 拖拽中断。
						//   ⇒ 拖动期间把 iframe 的 pointer-events 关掉，松手再恢复。
						const frames = siteWrap ? Array.prototype.slice.call(siteWrap.querySelectorAll('iframe')) : [];
						frames.forEach((f) => { f.style.pointerEvents = 'none'; });
						const prevUserSelect = document.body.style.userSelect;
						document.body.style.userSelect = 'none';
						document.body.style.cursor = 'col-resize';

						const startX = ev.clientX;
						const startW = aside.getBoundingClientRect().width;

						const onMove = (e2) => {
							const next = Math.max(320, Math.min(startW - (e2.clientX - startX), window.innerWidth - 360));
							aside.style.width = next + 'px';
						};
						const onUp = () => {
							document.removeEventListener('mousemove', onMove, true);
							document.removeEventListener('mouseup', onUp, true);
							window.removeEventListener('blur', onUp, true);
							frames.forEach((f) => { f.style.pointerEvents = ''; });
							document.body.style.userSelect = prevUserSelect;
							document.body.style.cursor = '';
							try { localStorage.setItem('__vssarosStudioConvW', aside.style.width); } catch { /* ignore */ }
						};

						document.addEventListener('mousemove', onMove, true);
						document.addEventListener('mouseup', onUp, true);
						// 窗口失焦（Alt+Tab / 拖出窗口）也要收尾，否则 iframe 一直不可点
						window.addEventListener('blur', onUp, true);
					},
				}),
				react.createElement('aside', {
					'data-vssaros-studio-conv': '',
					style: {
						flex: '0 0 auto',
						position: 'relative',   // 让内部 absolute 的按钮以本面板为定位基准
						// ★ 收起 = 整个对话栏隐藏（不卸载；也不收成窄条 —— 窄条里塞竖排字会被拆成两列）
						display: collapsed ? 'none' : 'flex',
						width: (() => {
							try { return localStorage.getItem('__vssarosStudioConvW') || CONV_WIDTH; } catch { return CONV_WIDTH; }
						})(),
						minWidth: CONV_MIN + 'px',
						maxWidth: '70%',
						height: '100%',
						minHeight: 0,
						flexDirection: 'column',
						overflow: 'hidden',
						borderLeft: BORDER, background: 'var(--dsw-alias-bg-base, #fff)',
					},
				},
					// （左上角不再放收起按钮：收起 / 展开统一走右侧浮动工具栏。2026-11-02）
					react.createElement('div', {
						style: {
							flex: '0 0 auto', height: '32px', display: 'flex', alignItems: 'center', gap: '6px',
							// 左侧不再有「» 收起」，不用留位；右侧给宿主的「＋ 新会话」留位（约 80px）
							padding: '0 92px 0 12px', borderBottom: BORDER, fontSize: '12px', fontWeight: 600,
							color: 'var(--dsw-alias-label-primary, #16181d)',
						},
					}, react.createElement('span', null, '✨ AI 助手')),
					// 官方对话本体：收起时只藏不卸载（否则会话状态 / 滚动位置 / 流式回复全丢）
					react.createElement('div', {
						style: {
							flex: '1 1 auto', minHeight: 0, overflow: 'auto',
							display: collapsed ? 'none' : 'flex', flexDirection: 'column',
						},
					}, conversation),
				),
			);
		}

		const DESCRIPTOR = {
			title: '萨罗斯管理平台',
			description: '承载 Saroasis Studio System 前端；右侧内嵌 AI 助手对话（官方 chat-surface）。',
			repository: 'vssaros:studio',
			icon: 'codicon:globe',
			customFrame: true,
		};

		/**
		 * 修 bug（2026-10-23 用户报障）：**在工作台里切工作区 ⇒ 中栏跳到会话页**。
		 * 根因：官方 hero 的"切工作区/新建会话"走导航语义 —— `uiWorkspace.openSession(...)`
		 * 内部会 `layout.selectPanel(null)` 把中栏切回原生对话；而我们的对话是**嵌入式**
		 * （`props.conversation` 在右侧），根本不需要切面板。
		 * 做法：给 `layout.selectPanel` 包一层 —— **仅当我们工作台在前台、且目标是把面板清空**
		 * （null / undefined / ''）时，拦下这一次（记数到 `__vssarosStudio.caps.panelBlocked`）。
		 * 其它情况一律原样透传；幂等，不重复包。
		 */
		function guardPanel(ctx) {
			try {
				ctx.inject(['layout', 'uiWorkspace'], (scope) => {
					const layout = scope.layout || (scope.get && scope.get('layout'));
					if (!layout || typeof layout.selectPanel !== 'function') { note('layout.selectPanel', new Error('不可用')); return; }
					if (layout.selectPanel.__vssarosStudioGuard) { return; }
					const orig = layout.selectPanel.bind(layout);
					const patched = function (key) {
						if (!globalThis.__vssarosStudioActive) { return orig(key); }
						if (key === null || key === undefined || key === '') {
							diag.caps.panelBlocked = (diag.caps.panelBlocked || 0) + 1;
							return undefined;   // 保持当前面板 = 我们的工作台
						}
						return orig(key);
					};
					patched.__vssarosStudioGuard = true;
					layout.selectPanel = patched;
					diag.caps.panelGuard = 'installed';

					// 第二层兜底：官方 hero 也可能直接走 `uiWorkspace.openSession()`（不经 selectPanel）。
					// 不拦它（拦了会导致会话绑定不上），而是**调用后把我们的面板拉回来**。
					const ws = scope.uiWorkspace || (scope.get && scope.get('uiWorkspace'));
					if (ws && typeof ws.openSession === 'function' && !ws.openSession.__vssarosStudioGuard) {
						const origOpen = ws.openSession.bind(ws);
						const patchedOpen = function (id) {
							const result = origOpen.apply(null, arguments);
							if (globalThis.__vssarosStudioActive) {
								const back = () => {
									try { layout.selectPanel('vssaros-wb-studio'); } catch { /* 忽略：面板名可能不同 */ }
								};
								setTimeout(back, 0);
								setTimeout(back, 200);
								diag.caps.panelRestored = (diag.caps.panelRestored || 0) + 1;
							}
							return result;
						};
						patchedOpen.__vssarosStudioGuard = true;
						ws.openSession = patchedOpen;
						diag.caps.openSessionGuard = 'installed';
					}
				});
			} catch (e) { note('guardPanel', e); }
		}


		// ★ 2026-11-02：「＋ 新会话」改由宿主对话栏统一提供（vssaros-workbenches 的 NewSessionButton），本工作台不再自画。

		function apply(ctx) {
			guardPanel(ctx);

			// ★ 2026-11-02 根治：这里原有 ① 文档级点击探针 ② **劫持官方左侧「新会话」按钮**改成建萨罗斯会话
			//   ③ 自画「＋新会话」的点击委托 ④ inject uiSession / remote.agentPresets —— **全部删除**。
			//   ② 尤其危险：只要萨罗斯面板「看起来在屏」，用户点官方「新会话」就被改道（还会误伤别的工作台）。
			// 注册式工作台：宿主 Frame 会给我们 `props.conversation`（对话停靠点）
			try {
				ctx.inject(['desktopWorkbenches'], (scope) => {
					const dw = scope.desktopWorkbenches || (scope.get && scope.get('desktopWorkbenches'));
					if (!dw || typeof dw.register !== 'function') { note('desktopWorkbenches', new Error('register 不可用')); return; }
					scope.effect(() => dw.register(DESCRIPTOR, StudioPanel), 'vssaros-studio: workbench');
					globalThis.__vssarosStudioDw = dw;
					diag.caps.workbench = true;

					// （2026-11-02：不再包 dw.newSession —— 新会话的默认 agent 由宿主 newSession 自己带）
				});
			} catch (e) { note('ctx.inject(desktopWorkbenches)', e); }
		}

		exports.apply = apply;
		exports.install = apply;
		exports.inject = ['slots'];
		return module.exports;
	},
});
