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

		/** 本 bot 的 preset 标识（= 内置 agent 的 id；`sessions.create({ agentPreset })` 用它）。 */
		const STUDIO_PRESET = 'saroasis-studio';
		/** 草稿预填文本：让输入框里默认就写着这个 bot（用户口径 2026-10-23）。 */
		const DRAFT_SEED = '@萨罗斯管理平台 ';

		/**
		 * 等对话挂载到新会话后，往 composer 预填 `DRAFT_SEED`。
		 * 为什么轮询：会话是异步挂载的，`uiSession.adapter.current` 不会立刻指向它；
		 * `inputActions` 由会话作用域提供（chat-surface 也是这么读的：`binding.props.inputActions`）。
		 * 最多尝试 ~4.5s，成功/失败都记 `caps.draftSeeded`。
		 */
		/**
		 * ★ 把"当前会话"的 agent preset 设成我们的 bot（2026-10-23 用户报障：hero 里默认没选中）。
		 * 为什么不是建会话时传：hero 那条会话**不是我们建的**（工作台打开时 workbenches 就停靠了一条
		 * 已存在的 blank 会话），所以 `newSession` 包装根本走不到。
		 * 官方 `agentPresets` 的语义正是"**第一轮开始前**选择 preset"⇒ 在 blank 阶段设它是合法的。
		 * 方法名/参数形态没有公开文档，这里逐个试（全是 try/catch，试不出来只记 caps，不影响任何功能）。
		 */
		function applyPresetToCurrent(ctx, sessionId) {
			// ⚠ agentPresets 是 **remote** 服务（chat-surface 的 inject 里就是 `remote.agentPresets`），
			//   直接 ctx.get('agentPresets') 通常拿不到 ⇒ 两个名字都试。
			const candidates = [];
			try { const a = ctx.get && ctx.get('agentPresets'); if (a) { candidates.push(['agentPresets', a]); } } catch { /* ignore */ }
			try { const b = ctx.get && ctx.get('remote.agentPresets'); if (b) { candidates.push(['remote.agentPresets', b]); } } catch { /* ignore */ }
			if (!candidates.length) { diag.caps.presetApi = 'no-service'; return; }
			const names = ['select', 'selectPreset', 'setPreset', 'choose', 'apply'];
			for (const [label, svc] of candidates) {
				if (!svc || typeof svc !== 'object') { continue; }
				for (const name of names) {
					if (typeof svc[name] !== 'function') { continue; }
					try { svc[name](STUDIO_PRESET); diag.caps.presetApi = label + '.' + name + '(id)'; diag.caps.defaults = 'done'; return; } catch (e) { /* 换下一种 */ }
					try { svc[name]({ sessionId, agentPreset: STUDIO_PRESET }); diag.caps.presetApi = label + '.' + name + '(obj)'; diag.caps.defaults = 'done'; return; } catch (e) { /* 换下一种 */ }
				}
			}
			diag.caps.presetApi = 'none(' + candidates.map(c => c[0]).join('|') + ')';
		}

		/** 我们工作台拿到前台后：给停靠会话补 preset + 预填草稿（都只做一次）。 */
		function ensureDefaults(ctx) {
			// ⚠ uiSession 也只能靠**动态 inject** 拿到（`ctx.get` 在未声明该服务的插件里是 undefined
			//   —— 这正是诊断浮标里 `defaults: "no-session"` 的原因：一直读不到会话 id）。
			const ui = globalThis.__vssarosStudioUiSession || (ctx.get && ctx.get('uiSession'));
			let sid = null;
			try {
				const b = ui && ui.adapter && ui.adapter.current ? ui.adapter.current.getSnapshot() : null;
				sid = (b && (b.sessionId || b.id)) || null;
			} catch (e) { note('ensureDefaults/sid', e); }
			// `uiSession.adapter.current` 指的是**主视图**的会话；我们这套是对话停靠（dock），
			// 所以它在这里长期为空。补两个来源：① 停靠点 DOM 上的会话 id；② workbenches 的 dockedSessionOf。
			if (!sid) {
				try {
					const el = document.querySelector('[data-vssaros-wb-docked-session]');
					const v = el && el.getAttribute('data-vssaros-wb-docked-session');
					if (v) { sid = v; diag.caps.sidFrom = 'dom'; }
				} catch { /* ignore */ }
			}
			if (!sid) {
				try {
					const dw = globalThis.__vssarosStudioDw;
					const entry = diag.caps.entryId || null;
					if (dw && typeof dw.dockedSessionOf === 'function' && entry) {
						const v = dw.dockedSessionOf(entry);
						if (v) { sid = v; diag.caps.sidFrom = 'dockedSessionOf'; }
					}
				} catch { /* ignore */ }
			}
			diag.caps.currentSid = sid;

			// ★ 仍然没有会话（hero 空态）⇒ **主动建一条**：走我们包装过的 newSession，
			//   它会给会话带上 agentPreset（这是让"默认选中 bot"真正生效的唯一可靠路径 ——
			//   hero 的懒创建不经过任何我们能插手的代码）。只尝试一次。
			if (!sid && !diag.caps.bootstrap) {
				try {
					const dw = globalThis.__vssarosStudioDw;
					if (dw && typeof dw.newSession === 'function') {
						diag.caps.bootstrap = 'called';
						dw.newSession();
					}
				} catch (e) { note('bootstrap newSession', e); }
			}
			// ★ 顺序是关键（2026-10-23 第二次定位）：
			//   官方 `agentPresets` 的语义是「**第一轮开始前**选择 preset」——**不需要会话 id**。
			//   而 hero 空态（探索未至之境）本来就**还没有会话**（dsh 懒创建）⇒ 原来这里
			//   `if (!sid) return` 把"设 preset"整段挡掉了 ⇒ 永远 no-session、永远不生效。
			//   ⇒ 现在：preset 先设（无会话也设），草稿再等会话。
			if (diag.caps.presetOk !== true) {
				applyPresetToCurrent(ctx, sid);
				const api = String(diag.caps.presetApi || '');
				if (api && api.indexOf('none') !== 0 && api !== 'no-service') { diag.caps.presetOk = true; }
			}
			if (!sid) {
				if (diag.caps.presetOk !== true) { diag.caps.defaults = 'no-session'; }
				return;
			}
			if (diag.caps.defaultsFor === sid + ':' + STUDIO_PRESET) { return; }
			diag.caps.defaultsFor = sid + ':' + STUDIO_PRESET;
			seedDraft(ctx, sid);
		}

		function seedDraft(ctx, sessionId) {
			let tries = 0;
			const attempt = () => {
				tries += 1;
				try {
					const ui = ctx.get && ctx.get('uiSession');
					const binding = ui && ui.adapter && ui.adapter.current ? ui.adapter.current.getSnapshot() : null;
					const current = binding && (binding.sessionId || binding.id);
					const actions = binding && binding.props ? binding.props.inputActions : null;
					if (current === sessionId && actions) {
						if (typeof actions.setDraft === 'function') {
							actions.setDraft(DRAFT_SEED);
							diag.caps.draftSeeded = 'setDraft';
							return;
						}
						if (typeof actions.insertText === 'function' && typeof actions.captureInsertion === 'function') {
							actions.insertText(DRAFT_SEED, actions.captureInsertion());
							diag.caps.draftSeeded = 'insertText';
							return;
						}
						diag.caps.draftSeeded = 'no-api';
						return;
					}
				} catch (e) { note('seedDraft', e); }
				if (tries < 30) { setTimeout(attempt, 150); }
				else { diag.caps.draftSeeded = diag.caps.draftSeeded || 'timeout'; }
			};
			setTimeout(attempt, 120);
		}

		/** 右侧对话栏宽度（与 mockup 一致：560 上限 / 半屏）。 */
		const CONV_WIDTH = 'min(560px, 52vw)';
		const BORDER = '1px solid var(--dsw-alias-border-l1, #e5e7ee)';

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
				if (!CTX) { return undefined; }
				// ★ 不依赖 props.active（它由 workbenches 的 service.active 推，常常滞后/为 false，
				//   这就是"bot 一直没出现"的原因之一）。改成**挂载即轮询**，直到补上为止。
				let tries = 0;
				const timer = setInterval(() => {
					tries += 1;
					try { ensureDefaults(CTX); } catch { /* ignore */ }
					// 诊断浮标：**默认关闭**（定位已完成，不再占用界面）。
					// 需要时在控制台执行 `localStorage.__studioDiag='1'` 再刷新；
					// 关掉后若之前渲染过，顺手把它摘掉。
					try {
						// 默认**显示**（用户 2026-10-24 要求"增加日志定位问题"）；
						// 想隐藏：`localStorage.__studioDiag='0'` 再刷新。
						if (localStorage.getItem('__studioDiag') !== '0') {
							let d = document.getElementById('__studioDiag');
							if (!d) {
								d = document.createElement('div');
								d.id = '__studioDiag';
								d.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;background:rgba(0,0,0,.82);color:#6f6;font:11px/1.45 ui-monospace,Consolas,monospace;padding:6px 8px;border-radius:6px;max-width:460px;white-space:pre-wrap';
								document.body.appendChild(d);
							}
							d.textContent = 'studio caps: ' + JSON.stringify(diag.caps) + '\nerrors: ' + JSON.stringify((diag.errors || []).slice(0, 3));
						} else {
							const old = document.getElementById('__studioDiag');
							if (old) { old.remove(); }
						}
					} catch { /* ignore */ }
					if (tries >= 12 || diag.caps.defaults === 'done') { clearInterval(timer); }
				}, 400);
				return () => clearInterval(timer);
				return () => { if (globalThis.__vssarosStudioActive === active) { globalThis.__vssarosStudioActive = false; } };
			}, [active]);
			const conversation = props && props.conversation ? props.conversation : null;
			const site = react.createElement('iframe', {
				src: '/x/studio/',
				title: '萨罗斯管理平台',
				'data-vssaros-studio-site': '',
				style: { flex: '1 1 auto', width: '100%', height: '100%', border: 0, background: '#fff' },
			});
			const host = react.createElement('div', {
				'data-vssaros-studio-panel': '',
				style: { display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0, height: '100%' },
			}, react.createElement('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex' } }, site));

			if (!conversation) { return host; }

			return react.createElement('div', {
				'data-vssaros-studio-panel': '',
				style: { display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0, height: '100%' },
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
					},
					onDoubleClick: (ev) => {
						const aside = ev.currentTarget.nextElementSibling;
						if (aside) {
							aside.style.width = CONV_WIDTH;
							try { localStorage.removeItem('__vssarosStudioConvW'); } catch { /* ignore */ }
						}
					},
					onMouseDown: (ev) => {
						ev.preventDefault();
						const aside = ev.currentTarget.nextElementSibling;
						if (!aside) { return; }
						const startX = ev.clientX;
						const startW = aside.getBoundingClientRect().width;
						const onMove = (e2) => {
							const next = Math.max(320, Math.min(startW - (e2.clientX - startX), window.innerWidth - 360));
							aside.style.width = next + 'px';
						};
						const onUp = () => {
							document.removeEventListener('mousemove', onMove, true);
							document.removeEventListener('mouseup', onUp, true);
							try { localStorage.setItem('__vssarosStudioConvW', aside.style.width); } catch { /* ignore */ }
						};
						document.addEventListener('mousemove', onMove, true);
						document.addEventListener('mouseup', onUp, true);
					},
				}),
				react.createElement('aside', {
					'data-vssaros-studio-conv': '',
					style: {
						flex: '0 0 auto',
						width: (() => {
							try { return localStorage.getItem('__vssarosStudioConvW') || CONV_WIDTH; } catch { return CONV_WIDTH; }
						})(),
						minWidth: 0, minHeight: 0,
						display: 'flex', flexDirection: 'column',
						borderLeft: BORDER, background: 'var(--dsw-alias-bg-base, #fff)',
					},
				},
					react.createElement('div', {
						style: {
							flex: '0 0 auto', height: '32px', display: 'flex', alignItems: 'center', gap: '6px',
							padding: '0 12px', borderBottom: BORDER, fontSize: '12px', fontWeight: 600,
							color: 'var(--dsw-alias-label-primary, #16181d)',
						},
					}, react.createElement('span', null, '✨ AI 助手'),
						react.createElement('span', { style: { flex: '1 1 auto' } }),
						// ★ 新建会话（2026-10-24 用户要求）：走的是**我们包装过的 newSession**
						//   ⇒ 会话创建时就带 `agentPreset: 'saroasis-studio'`，
						//   这比 hero 空态里"事后 select preset"可靠得多（后者会被宿主静默忽略）。
						react.createElement('button', {
							type: 'button',
							'data-vssaros-studio-new': '',
							// 诊断探针（2026-10-24）：ref 拿到真实 DOM ⇒ 证明按钮真渲染了；
							// 直接绑 addEventListener ⇒ 绕开 React 合成事件与文档委托两条路径。
							ref: (el) => {
								if (!el || el.__vssarosBound) { return; }
								el.__vssarosBound = true;
								diag.caps.btnMounted = (diag.caps.btnMounted || 0) + 1;
								el.addEventListener('click', (ev) => {
									diag.caps.btnClick = (diag.caps.btnClick || 0) + 1;
									ev.preventDefault();
									ev.stopPropagation();
									const dw = globalThis.__vssarosStudioDw;
									if (!dw) { diag.caps.newSessionError = 'no-desktopWorkbenches'; return; }
									(async () => {
										try {
											const owner = dw.ownerId();
											const wsObj = typeof dw.defaultWorkspace === 'function' ? dw.defaultWorkspace() : null;
											const wsId = wsObj && (wsObj.workspaceId || wsObj.id);
											diag.caps.createTry = { owner, wsId };
											if (!wsId) { diag.caps.newSessionError = 'no-workspace'; return; }
											const sid = await createStudioSession(dw, wsId);
											diag.caps.createdSid = sid;
											try { await dw.bindSession(owner, sid); } catch (err) { diag.caps.bindErr = String((err && err.message) || err); }
											try { dw.showSession(sid); } catch (err) { diag.caps.showErr = String((err && err.message) || err); }
										} catch (err) { diag.caps.newSessionError = String((err && err.message) || err); }
									})();
								});
							},
							title: '新建会话（默认 agent：萨罗斯管理平台）',
							style: {
								flex: '0 0 auto', border: '1px solid var(--dsw-alias-border-l2, #dcdfe6)',
								background: 'transparent', color: 'var(--dsw-alias-label-secondary, #5a6270)',
								borderRadius: '6px', fontSize: '11px', lineHeight: '18px', padding: '0 8px', cursor: 'pointer',
								// 诊断（2026-10-24）：btnMounted=1 但 btnClick=0 ⇒ 点击没落到按钮上
								// （被覆盖层挡住 / 祖先 pointer-events:none / z-index 被压）。
								// 这里把按钮从流里抬出来：最高层级 + 强制可点 + 自己也带定位上下文。
								// 2026-10-24：浮层里已经有一个可用的「＋新会话」，header 这个点不着又重叠 ⇒ 直接隐藏
								display: 'none',
								position: 'relative', zIndex: 2147482000, pointerEvents: 'auto',
								minWidth: '64px', textAlign: 'center',
							},
							// ⚠ 不能调 dw.newSession()：它的包装里有 `if (!__vssarosStudioActive) return origNew()`
							//   门槛（props.active 常为 false）⇒ 会走回**不带 preset** 的原实现（这就是
							//   "新建了会话但没有 bot chip"的原因）。这里直接自己建，参数写在明面上。
							onClick: async () => {
								diag.caps.newSessionClicked = (diag.caps.newSessionClicked || 0) + 1;
								const dw = globalThis.__vssarosStudioDw;
								if (!dw) { diag.caps.newSessionError = 'no-desktopWorkbenches'; return; }
								try {
									const owner = dw.ownerId();
									const wsObj = typeof dw.defaultWorkspace === 'function' ? dw.defaultWorkspace() : null;
									const wsId = wsObj && (wsObj.workspaceId || wsObj.id);
									diag.caps.createTry = { owner, wsId };
									if (!wsId) { diag.caps.newSessionError = 'no-workspace'; return; }
									const sid = await createStudioSession(dw, wsId);
									diag.caps.createdSid = sid;
									try { await dw.bindSession(owner, sid); } catch (e) { diag.caps.bindErr = String((e && e.message) || e); }
									try { dw.showSession(sid); } catch (e) { diag.caps.showErr = String((e && e.message) || e); }
								} catch (e) { diag.caps.newSessionError = String((e && e.message) || e); }
							},
						}, '＋ 新会话')),
					react.createElement('div', { style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' } }, conversation),
				));
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

		/**
		 * 建一条带 bot preset 的会话。**不再让一个参数把整个动作打死**：
		 * 候选名逐个试（宿主报 `agent-preset/not-found` 就换下一个），
		 * 全都不行 ⇒ 退化成"不带 preset"的普通会话（最坏情况也能新建，只是 bot 手动选）。
		 */
		async function createStudioSession(dw, workspaceId) {
			const candidates = [STUDIO_PRESET, 'saroasis-platform', '萨罗斯管理平台'];
			for (const preset of candidates) {
				try {
					const sid = await dw.ctx.sessions.create({ workspaceId, agentPreset: preset });
					diag.caps.presetUsed = preset;
					return sid;
				} catch (e) {
					const msg = String((e && e.message) || e);
					if (!/agent-preset\/not-found|unknown agent preset/i.test(msg)) { throw e; }
					diag.caps.presetRejected = (diag.caps.presetRejected || []).concat(preset);
				}
			}
			const sid = await dw.ctx.sessions.create({ workspaceId });
			diag.caps.presetUsed = 'none(降级：不带 preset 建会话)';
			return sid;
		}

		/** 组件里拿不到 ctx，靠这个全局引用（apply 时赋值）。 */
		let CTX = null;

		function apply(ctx) {
			CTX = ctx;
			guardPanel(ctx);

			// ★ 原生事件委托（2026-10-24 用户实测「点＋新会话没反应」）：
			//   React 的 onClick 在这套 customFrame + portal 组合里没触发（浮标连 newSessionClicked 都没有）。
			//   捕获阶段的文档级监听一定先命中 —— 用 data 属性定位按钮，不依赖 React 事件系统。
			// ★ 点击定位探针（2026-10-24）：btnMounted=1 但 btnClick 一直是 0
			//   ⇒ 记录"这一点到底命中了谁"，直接暴露覆盖层/pointer-events 问题。
			document.addEventListener('pointerdown', (e) => {
				try {
					const el = e.target;
					diag.caps.lastDown = (el && el.tagName) + '.' + String((el && el.className) || '').slice(0, 40);
					const top = document.elementFromPoint(e.clientX, e.clientY);
					diag.caps.topAt = top ? (top.tagName + '.' + String(top.className || '').slice(0, 40)) : 'null';
					diag.caps.topIsBtn = !!(top && top.closest && top.closest('[data-vssaros-studio-new]'));
					diag.caps.hitBtn = !!(el && el.closest && el.closest('[data-vssaros-studio-new]'));
				} catch { /* ignore */ }
			}, true);

			// ★★ 2026-10-24 最终修法：header 里那个 React 按钮**点不到**（探针显示
			//   `lastDown/topAt` 命中的是 SPAN，不是我们的 BUTTON —— 容器里有东西压在它上面）。
			//   ⇒ 改用 **body 级原生浮层按钮**：fixed 定位 + 最高 z-index + 原生事件，
			//   只在我们的工作台面板在屏时显示（用 `[data-vssaros-studio-panel]` 判断）。
			try {
				const nb = document.createElement('button');
				nb.type = 'button';
				nb.textContent = '＋ 新会话';
				nb.setAttribute('data-vssaros-studio-neww', '');
				nb.style.cssText = 'position:fixed;z-index:2147483000;right:16px;top:38px;height:24px;padding:0 10px;'
					+ 'border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#dcdfe6);'
					+ 'background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#16181d);'
					+ 'font:11px/22px -apple-system,"Segoe UI",sans-serif;cursor:pointer;display:none';
				nb.addEventListener('click', (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					diag.caps.floatBtnClick = (diag.caps.floatBtnClick || 0) + 1;
					const dw = globalThis.__vssarosStudioDw;
					if (!dw) { diag.caps.newSessionError = 'no-desktopWorkbenches'; return; }
					(async () => {
						try {
							const owner = dw.ownerId();
							const wsObj = typeof dw.defaultWorkspace === 'function' ? dw.defaultWorkspace() : null;
							const wsId = wsObj && (wsObj.workspaceId || wsObj.id);
							diag.caps.createTry = { owner, wsId };
							if (!wsId) { diag.caps.newSessionError = 'no-workspace'; return; }
							const sid = await createStudioSession(dw, wsId);
							diag.caps.createdSid = sid;
							try { await dw.bindSession(owner, sid); } catch (e) { diag.caps.bindErr = String((e && e.message) || e); }
							try { dw.showSession(sid); } catch (e) { diag.caps.showErr = String((e && e.message) || e); }
						} catch (e) { diag.caps.newSessionError = String((e && e.message) || e); }
					})();
				});
				document.body.appendChild(nb);
				setInterval(() => {
					try {
						nb.style.display = document.querySelector('[data-vssaros-studio-panel]') ? 'block' : 'none';
					} catch { /* ignore */ }
				}, 700);
				diag.caps.floatBtn = 'mounted';
			} catch (e) { note('float new-session button', e); }

			// ★ 2026-10-24 兜底：**接管官方的「新会话」入口**（左侧栏那个）。
			//   我们自己的按钮一直被别的东西盖住点不着（浮标 lastDown 永远是 SPAN），
			//   但官方那个按钮是好的 ⇒ 点它时改走"带 agentPreset 建会话"，效果一样。
			document.addEventListener('click', (e) => {
				const btn = e.target && e.target.closest ? e.target.closest('button,a,[role="button"]') : null;
				if (!btn) { return; }
				const txt = String(btn.textContent || '').replace(/\s+/g, '');
				if (txt !== '新会话') { return; }
				if (!document.querySelector('[data-vssaros-studio-panel]')) { return; }   // 只在我们工作台在屏时接管
				e.preventDefault();
				e.stopPropagation();
				diag.caps.officialNewIntercepted = (diag.caps.officialNewIntercepted || 0) + 1;
				const dw = globalThis.__vssarosStudioDw;
				if (!dw) { diag.caps.newSessionError = 'no-desktopWorkbenches'; return; }
				(async () => {
					try {
						const owner = dw.ownerId();
						const wsObj = typeof dw.defaultWorkspace === 'function' ? dw.defaultWorkspace() : null;
						const wsId = wsObj && (wsObj.workspaceId || wsObj.id);
						diag.caps.createTry = { owner, wsId };
						if (!wsId) { diag.caps.newSessionError = 'no-workspace'; return; }
						const sid = await createStudioSession(dw, wsId);
						diag.caps.createdSid = sid;
						try { await dw.bindSession(owner, sid); } catch (err) { diag.caps.bindErr = String((err && err.message) || err); }
						try { dw.showSession(sid); } catch (err) { diag.caps.showErr = String((err && err.message) || err); }
					} catch (err) { diag.caps.newSessionError = String((err && err.message) || err); }
				})();
			}, true);

			let lastNewSessionClick = 0;
			document.addEventListener('click', async (e) => {
				const target = e.target && e.target.closest ? e.target.closest('[data-vssaros-studio-new]') : null;
				if (!target) { return; }
				const now = Date.now();
				if (now - lastNewSessionClick < 800) { return; }   // 防重复（React onClick 若也触发，这里挡掉）
				lastNewSessionClick = now;
				e.preventDefault();
				e.stopPropagation();
				diag.caps.newSessionClicked = (diag.caps.newSessionClicked || 0) + 1;
				const dw = globalThis.__vssarosStudioDw;
				if (!dw) { diag.caps.newSessionError = 'no-desktopWorkbenches'; return; }
				try {
					const owner = dw.ownerId();
					const wsObj = typeof dw.defaultWorkspace === 'function' ? dw.defaultWorkspace() : null;
					const wsId = wsObj && (wsObj.workspaceId || wsObj.id);
					diag.caps.createTry = { owner, wsId };
					if (!wsId) { diag.caps.newSessionError = 'no-workspace'; return; }
					const sid = await createStudioSession(dw, wsId);
					diag.caps.createdSid = sid;
					try { await dw.bindSession(owner, sid); } catch (err) { diag.caps.bindErr = String((err && err.message) || err); }
					try { dw.showSession(sid); } catch (err) { diag.caps.showErr = String((err && err.message) || err); }
				} catch (err) { diag.caps.newSessionError = String((err && err.message) || err); }
			}, true);

			// 会话服务：动态 inject（`ctx.get('uiSession')` 拿不到 ⇒ 之前一直 no-session）
			try {
				ctx.inject(['uiSession'], (scope) => {
					const ui = scope.uiSession || (scope.get && scope.get('uiSession')) || null;
					globalThis.__vssarosStudioUiSession = ui;
					diag.caps.uiSession = !!ui;
					diag.caps.uiSessionHasAdapter = !!(ui && ui.adapter);
				});
			} catch (e) { note('ctx.inject(uiSession)', e); }

			// 预设服务：同样是 remote（名字可能是 remote.agentPresets）
			try {
				ctx.inject(['remote.agentPresets'], (scope) => {
					globalThis.__vssarosStudioPresets = scope['remote.agentPresets'] || (scope.get && scope.get('remote.agentPresets')) || null;
					diag.caps.presetsSvc = !!globalThis.__vssarosStudioPresets;
				});
			} catch (e) { note('ctx.inject(remote.agentPresets)', e); }
			// 注册式工作台：宿主 Frame 会给我们 `props.conversation`（对话停靠点）
			try {
				ctx.inject(['desktopWorkbenches'], (scope) => {
					const dw = scope.desktopWorkbenches || (scope.get && scope.get('desktopWorkbenches'));
					if (!dw || typeof dw.register !== 'function') { note('desktopWorkbenches', new Error('register 不可用')); return; }
					scope.effect(() => dw.register(DESCRIPTOR, StudioPanel), 'vssaros-studio: workbench');
					globalThis.__vssarosStudioDw = dw;
					diag.caps.workbench = true;

					// ★ 默认选中本 bot（2026-10-23 用户要求）：右侧对话的会话要带 agentPreset。
					//   官方 `newSession()` 里是 `sessions.create({ workspaceId })` —— **不传 preset** ⇒
					//   会话按全局默认（标准模式）建，右侧 hero 里自然不是"萨罗斯管理平台"。
					//   这里包一层：仅当我们的工作台在前台时，用它自己的 preset 建会话。
					//   任何一步失败 ⇒ 原样回落官方实现（绝不把"开始对话"弄坏）。
					try {
						if (!dw.newSession.__vssarosStudioGuard) {
							const origNew = dw.newSession.bind(dw);
							const patchedNew = async function (workspaceId) {
								if (!globalThis.__vssarosStudioActive) { return origNew(workspaceId); }
								try {
									const owner = dw.ownerId();
									const wsId = workspaceId || (dw.defaultWorkspace() && dw.defaultWorkspace().workspaceId);
									if (!wsId) { return origNew(workspaceId); }
									const sid = await createStudioSession(dw, wsId);
									try { await dw.bindSession(owner, sid); } catch (e) { note('bindSession', e); }
									try { dw.showSession(sid); } catch (e) { note('showSession', e); }
									diag.caps.defaultPreset = STUDIO_PRESET;
									seedDraft(ctx, sid);   // 输入框里默认写着 @萨罗斯管理平台
									return sid;
								} catch (e) {
									note('newSession(agentPreset)', e);
									diag.caps.defaultPreset = 'fallback(官方默认)';
									return origNew(workspaceId);
								}
							};
							patchedNew.__vssarosStudioGuard = true;
							dw.newSession = patchedNew;
							diag.caps.presetGuard = 'installed';
						}
					} catch (e) { note('wrap newSession', e); }
				});
			} catch (e) { note('ctx.inject(desktopWorkbenches)', e); }
		}

		exports.apply = apply;
		exports.install = apply;
		exports.inject = ['slots'];
		return module.exports;
	},
});
