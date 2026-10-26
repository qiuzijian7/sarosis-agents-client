// @vssaros/dsh-marketplace — workbench chunk（注册式工作台 + 对话停靠）
//
// ── 为什么单独一个文件，而不是复用 lib/client.js ────────────────────────────
//   `lib/client.js` 是**自托管 SSR 页**的脚本（由路由 `/x/marketplace/client.js` 发出去，
//   页面里 `<script>` 顺序加载 UMD React）⇒ **不在 dsh 的 chunk 装载器里**，
//   拿不到 `require('react')`，也拿不到 `ctx` ✗
//   本文件才是 chunk（`window.__ModuleLoader__.load`），由 dsh 按 `package.json` 的
//   `dsh.client` 自动加载 ⇒ 能 `require('react')`、能 `ctx.inject(...)`。
//
// ── 形态：左 = 现有商城页（iframe），右 = 官方对话（props.conversation）──────
//   参考 `vssaros-studio/lib/client.js`（2026-10-23 那次调研的结论）：
//   官方真正支持的"页面内真聊天"是 **定制外框工作台（customFrame）+ 对话停靠** ——
//   宿主 `vssaros-workbenches` 的 Frame 在 `customFrame: true` 时给组件传
//   `props.conversation`（内部 = `data-vssaros-wb-dock` 挂载点 + "开始对话"按钮）。
//
//   ⚠ **不要**自己拿 iframe 指向 dsh 根做浮层：会出现两套助手，且那份客户端
//     拿不到当前会话上下文（studio 已经因为这个删过一次实现）。
//
// ── 不做的事（明确边界）──────────────────────────────────────────────
//   ① 不在这里调模型 —— 模型能力在官方 chat-surface 里，本文件只负责**摆位置**
//   ② 不重画商城 —— 左侧就是现有的 `/x/marketplace/`，一行不改
//   ③ 不抢 `newSession` 的 preset（商城没有专属 agent preset）

window.__ModuleLoader__.load({
	id: '@vssaros/dsh-marketplace',
	factory: (require) => {
		const module = { exports: {} };
		const react = require('react');

		const SITE_PATH = '/x/marketplace/';
		/**
		 * 商城专用 agent 的 preset id（★ 2026-10-26 用户：「新建会话时使用专门的商城 agent」）。
		 *
		 * ⚠ 规则是 `vssaros-` + slugify(agentId)，**不是** agent id 本身
		 *   （`vssaros-agents/lib/core/agents.js` 的 `presetIdOf`）。
		 *   agent 文件由 Host 侧 `lib/marketAgent.js` 写到 `<数据根>/agents/marketplace-bot/`，
		 *   ⇒ 这里必须写 `vssaros-marketplace-bot`。少前缀会被 `agent-preset/not-found` 拒。
		 */
		const MARKET_PRESET = 'vssaros-marketplace-bot';
		/** 输入框预填（`@商城助手 `）：让用户一眼看到「这个会话是谁」。 */
		const DRAFT_SEED = '@商城助手 ';

		/**
		 * 把**当前会话**的 agent preset 设成商城助手。
		 *
		 * 官方 `agentPresets` 的语义是「**第一轮开始前**选择 preset」⇒ blank 阶段设它合法。
		 * 方法名/参数形态没有公开文档（`select` / `selectPreset` / `setPreset` / `choose` / `apply`
		 * 逐个试，全是 try/catch）—— studio 已经用同一套摸出来了，这里照抄。
		 *
		 * @returns {boolean} 是否设成功
		 */
		/**
		 * `apply` 里通过 `ctx.inject` 捕获到的 `agentPresets` 服务对象。
		 *
		 * ⚠ 为什么不能只靠 `ctx.get('agentPresets')`：**在未声明 inject 的插件里 `ctx.get` 返回 undefined**
		 *   （studio 的注释原话："`uiSession` 也只能靠**动态 inject** 拿到"）。
		 *   ⇒ 之前 `tryApplyPreset` 十有八九一直是 `no-service`，静默失败 ✗
		 */
		let PRESET_API = null;
		/** 诊断（浏览器控制台可见）：`__vssarosMarketPreset`）。 */
		const presetDiag = { api: 'init', calls: [], ok: false, error: '' };

		/**
		 * 当前**停靠会话**的 id（hero 空态时可能是 null —— 那正是要轮询的原因）。
		 *
		 * 三个来源（照 studio 的顺序，逐个兜底）：
		 * ① `uiSession.adapter.current`（**也要 inject 才拿得到**，`ctx.get` 拿不到）
		 * ② 停靠点 DOM 上的 `data-vssaros-wb-docked-session`
		 * ③ `dw.dockedSessionOf(entryId)`
		 */
		function currentSessionId(ctx) {
			try {
				const ui = globalThis.__vssarosMarketUiSession || (ctx.get && ctx.get('uiSession'));
				const b = ui && ui.adapter && ui.adapter.current ? ui.adapter.current.getSnapshot() : null;
				const sid = b && (b.sessionId || b.id);
				if (sid) { return sid; }
			} catch { /* 下一条 */ }
			try {
				const el = document.querySelector('[data-vssaros-wb-docked-session]');
				const v = el && el.getAttribute('data-vssaros-wb-docked-session');
				if (v) { return v; }
			} catch { /* 下一条 */ }
			try {
				const dw = globalThis.__vssarosMarketDw;
				const entry = presetDiag.entryId;
				if (dw && typeof dw.dockedSessionOf === 'function' && entry) {
					const v = dw.dockedSessionOf(entry);
					if (v) { return v; }
				}
			} catch { /* ignore */ }
			return null;
		}

		function tryApplyPreset(ctx) {
			const sessionId = currentSessionId(ctx);
			presetDiag.sessionId = sessionId || null;
			const candidates = [];
			if (PRESET_API) { candidates.push(['injected', PRESET_API]); }
			try { const a = ctx.get && ctx.get('agentPresets'); if (a) { candidates.push(['agentPresets', a]); } } catch { /* ignore */ }
			try { const b = ctx.get && ctx.get('remote.agentPresets'); if (b) { candidates.push(['remote.agentPresets', b]); } } catch { /* ignore */ }
			if (!candidates.length) {
				presetDiag.api = 'no-service';
				globalThis.__vssarosMarketPreset = presetDiag;
				return false;
			}

			for (const [label, svc] of candidates) {
				if (!svc || typeof svc !== 'object') { continue; }
				for (const name of ['select', 'selectPreset', 'setPreset', 'choose', 'apply']) {
					if (typeof svc[name] !== 'function') { continue; }
					// ★★ **两个位置参数** `select(sessionId, presetId)` —— 这才是官方形态
					//   （`vssaros-chat-surface/lib/client.preset.js:254`：
					//     `ctx.remote.agentPresets.select(sid, id)`，与官方 seat 内部同一条）
					//   ⚠ 之前只试「单参」和「对象」两种 ⇒ 都不对，所以一直静默失败 ✗
					if (sessionId) {
						try {
							svc[name](sessionId, MARKET_PRESET);
							presetDiag.api = `${label}.${name}(sid,id)`;
							presetDiag.ok = true;
							globalThis.__vssarosMarketPreset = presetDiag;
							return true;
						} catch (e0) { presetDiag.calls.push(`${label}.${name}(sid,id): ${String(e0 && e0.message || e0).slice(0, 60)}`); }
					}
					try {
						svc[name](MARKET_PRESET);
						presetDiag.api = `${label}.${name}(id)`;
						presetDiag.ok = true;
						globalThis.__vssarosMarketPreset = presetDiag;
						return true;
					} catch (e1) { presetDiag.calls.push(`${label}.${name}(id): ${String(e1 && e1.message || e1).slice(0, 60)}`); }
					try {
						// ★ 带上 sessionId（studio 的做法）：部分实现要求"给哪个会话设"
						svc[name]({ ...(sessionId ? { sessionId } : {}), agentPreset: MARKET_PRESET });
						presetDiag.api = `${label}.${name}(obj${sessionId ? '+sid' : ''})`;
						presetDiag.ok = true;
						globalThis.__vssarosMarketPreset = presetDiag;
						return true;
					} catch (e2) { presetDiag.calls.push(`${label}.${name}(obj): ${String(e2 && e2.message || e2).slice(0, 60)}`); }
				}
			}
			presetDiag.api = `none(${candidates.map(c => c[0]).join('|')})`;
			globalThis.__vssarosMarketPreset = presetDiag;
			return false;
		}

		/**
		 * 给输入框预填 `DRAFT_SEED`（只在目标会话就是当前会话时）。
		 *
		 * 会话是异步挂载的 ⇒ 轮询最多 ~5s；失败就算了（预填只是锦上添花，
		 * 绝不能因此报错或反复重试打日志）。
		 */
		function seedDraft(ctx) {
			let tries = 0;
			const timer = setInterval(() => {
				tries += 1;
				try {
					const ui = ctx.get && ctx.get('uiSession');
					const binding = ui && ui.adapter && ui.adapter.current ? ui.adapter.current.getSnapshot() : null;
					const actions = binding && binding.props ? binding.props.inputActions : null;
					if (actions && typeof actions.setDraft === 'function') {
						clearInterval(timer);
						actions.setDraft(DRAFT_SEED);
						return;
					}
				} catch { /* 继续等 */ }
				if (tries > 10) { clearInterval(timer); }
			}, 500);
		}

		/**
		 * 商城工作台**在前台**时调用：设 preset + 预填。
		 *
		 * ⚠ 为什么必须"前台才做"：`agentPresets` 是**全局的当前会话选择**，
		 *   如果商城插件在别的页面也去设，就会把用户在其它工作台选的 agent 抢走 ✗
		 *   ⇒ 触发点只有两个：① 本面板挂载 ② 用户点「+ 新会话」（都说明商城在前台）。
		 */
		/**
		 * 把「＋ 新会话」挂进 **aside 内部**（★ 2026-10-26 用户报「没有这个按钮」）。
		 *
		 * 为什么挂 aside 而不是 body：body 上的 fixed 按钮是**全窗级**的，只能靠定时器判断
		 * "面板在不在屏"来显隐 ⇒ 切走工作台必然残留/误显（studio 踩过并改掉的做法）。
		 * 挂进 aside ⇒ **生命周期与面板绑定**，卸载即消失，不需要任何轮询 ✓
		 *
		 * 为什么用原生 DOM 而不是 React 元素：studio 实测这套 `customFrame` + portal 组合里
		 * React 的 onClick 不触发（浮标连点击事件都收不到）⇒ 原生 `addEventListener` 才稳。
		 */
		function mountNewButton(container) {
			if (!container || container.__vssarosMarketNewMounted) { return; }
			container.__vssarosMarketNewMounted = true;
			try {
				container.querySelectorAll('[data-vssaros-market-neww]').forEach((el) => el.remove());
			} catch { /* ignore */ }

			const nb = document.createElement('button');
			nb.type = 'button';
			nb.textContent = '＋ 新会话';
			nb.setAttribute('data-vssaros-market-neww', '');
			nb.title = '新建一个对话（agent 自动选中「商城助手」）';
			// absolute 相对 aside（aside 已设 position:relative）⇒ 停在对话栏右上角
			nb.style.cssText = 'position:absolute;z-index:2147483000;right:10px;top:5px;height:22px;padding:0 10px;'
				+ 'border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#dcdfe6);'
				+ 'background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#16181d);'
				+ 'font:11px/20px -apple-system,"Segoe UI",sans-serif;cursor:pointer;pointer-events:auto';
			nb.addEventListener('click', (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				const dw = globalThis.__vssarosMarketDw;
				if (!dw || typeof dw.newSession !== 'function') { return; }
				// 走宿主自己的 newSession（我们已经在 apply 里包过它：会给新会话设商城 preset）
				try { dw.newSession(); } catch { /* 失败不抛给用户 */ }
			});
			container.appendChild(nb);
		}

		function ensureMarketDefaults(ctx) {
			if (tryApplyPreset(ctx)) { seedDraft(ctx); }
		}
		/** 对话栏默认宽度 / 最小宽度（与 studio 同口径，用户肌肉记忆一致）。 */
		const CONV_WIDTH = '440px';
		const CONV_MIN = 320;
		const STORE_KEY = '__vssarosMarketConvW';
		/**
		 * 折叠状态持久化（关掉工作台再打开还是收起的）。
		 *
		 * ★ 2026-10-26 定稿：收起 = 对话栏**整体隐藏**（`display:none`，DOM 保留），
		 *   展开入口放**面板右上角**「« AI 助手」。不再保留"30px 窄条 + 竖排字"的方案
		 *   —— 真机截图里窄条会把字拆成两列，很难看。所有工作台同一套做法
		 *   （守卫：`dsh-plugins/check-assistant-collapse.mjs`）。
		 */
		const COLLAPSE_KEY = '__vssarosMarketCollapsed';

		const DESCRIPTOR = {
			title: '商城工作台',
			description: 'VsSaros 商城；右侧内嵌 AI 助手对话（官方 chat-surface），可让 Agent 帮你查找与发布资源。',
			// `vssaros:` scheme ⇒ id 归一成 `vssaros/marketplace`
			repository: 'vssaros:marketplace',
			icon: 'codicon:extensions',
			// ★ 只有它为 true，宿主才会注入 `props.conversation`
			customFrame: true,
			layout: { businessSide: 'left' },
		};

		/** 对话栏宽度（持久化；读不到就用默认）。 */
		function savedConvWidth() {
			try {
				const v = localStorage.getItem(STORE_KEY);
				if (v && /^\d+px$/.test(v)) { return v; }
			} catch { /* 隐私模式等 */ }
			return CONV_WIDTH;
		}

		/**
		 * 工作台面板：左 = 商城页（iframe），右 = 官方对话。
		 *
		 * `props.conversation` 由 workbenches 的 Frame 在 `customFrame: true` 时注入；
		 * 没注入（宿主较旧 / 清单没声明）⇒ 右侧不渲染，商城照旧铺满（**优雅降级，不报错**）。
		 */
		function MarketPanel(props) {
			const conversation = props && props.conversation ? props.conversation : null;

			// ★ 伸缩状态（★ 2026-10-26 用户：「AI 助手栏增加伸缩按钮」）
			//   持久化：关掉工作台再打开还是上次那个状态（收起的人不想每次重新收）
			const collapsedState = react.useState(() => {
				try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
			});
			const collapsed = collapsedState[0];
			const setCollapsed = (next) => {
				collapsedState[1](next);
				try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
			};
			// ★ 2026-10-26「S2 一体条」：展开按钮与拖拽已收归外壳（vssaros-workbenches）统一渲染，
			//   本工作台只负责两件事：
			//     ① 在面板根上写 `data-vssaros-assist-collapsed`（外壳据此切换「« 展开 / » 收起」）
			//     ② 收到外壳派发的 expand / collapse 就跟着开合
			//   ⚠ 监听必须挂在 **window** 上：CustomEvent 只向上冒泡，挂在子节点上收不到
			//     （2026-10-26 真机 bug：点「«」没反应）。
			react.useEffect(() => {
				const onToggle = (ev) => {
					const target = ev && ev.detail && ev.detail.workbench;
					if (target && target !== 'vssaros/marketplace') { return; }
					const open = ev.type === 'vssaros:assist-expand';
					collapsedState[1](!open);
					try { localStorage.setItem(COLLAPSE_KEY, open ? '0' : '1'); } catch { /* ignore */ }
				};
				window.addEventListener('vssaros:assist-expand', onToggle);
				window.addEventListener('vssaros:assist-collapse', onToggle);
				return () => {
					window.removeEventListener('vssaros:assist-expand', onToggle);
					window.removeEventListener('vssaros:assist-collapse', onToggle);
				};
			}, []);

			const site = react.createElement('iframe', {
				src: SITE_PATH,
				title: 'VsSaros 商城',
				'data-vssaros-market-site': '',
				style: { flex: '1 1 auto', width: '100%', height: '100%', border: 0, background: 'transparent' },
			});

			const siteWrap = react.createElement(
				'div',
				{ style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex' } },
				site,
			);

			// 没有对话停靠点 ⇒ 整页就是商城（与旧行为一致）
			if (!conversation) {
				return react.createElement('div', {
					'data-vssaros-market-panel': '',
					style: { display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0, height: '100%' },
				}, siteWrap);
			}

			/**
			 * 拖动条。纯 DOM 操作改 aside 宽度（不引入 state ⇒ 不重渲染、不打断对话）。
			 *
			 * ⚠ 拖动期间必须把 iframe 的 `pointer-events` 关掉：iframe 是**独立文档**，
			 *   鼠标一进去父文档就收不到 mousemove/mouseup ⇒ 拖到一半中断（studio 踩过）。
			 */
			const splitter = react.createElement('div', {
				'data-vssaros-market-split': '',
				title: '左右拖动调节宽度（双击复位）',
				style: {
					flex: '0 0 auto', width: '6px', cursor: 'col-resize',
					background: 'transparent', position: 'relative', zIndex: 5,
					// ⚠ 折叠时**藏起拖拽条**：此时宽度由 state 控制，拖了会被 React 覆盖回去，
					//   表现成"拖不动"（比看不见更困惑）⇒ 干脆不显示 ✗
					display: collapsed ? 'none' : undefined,
				},
				onDoubleClick: (ev) => {
					const aside = ev.currentTarget.nextElementSibling;
					if (aside) {
						aside.style.width = CONV_WIDTH;
						try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
					}
				},
				onMouseDown: (ev) => {
					ev.preventDefault();
					const el = ev.currentTarget;
					const aside = el.nextElementSibling;
					const left = el.previousElementSibling;
					if (!aside) { return; }

					const frames = left ? Array.prototype.slice.call(left.querySelectorAll('iframe')) : [];
					frames.forEach((f) => { f.style.pointerEvents = 'none'; });
					const prevSelect = document.body.style.userSelect;
					const prevCursor = document.body.style.cursor;
					document.body.style.userSelect = 'none';
					document.body.style.cursor = 'col-resize';

					const startX = ev.clientX;
					const startW = aside.getBoundingClientRect().width;

					const onMove = (e2) => {
						const next = Math.max(CONV_MIN, Math.min(startW - (e2.clientX - startX), window.innerWidth - 360));
						aside.style.width = next + 'px';
					};
					const onUp = () => {
						document.removeEventListener('mousemove', onMove, true);
						document.removeEventListener('mouseup', onUp, true);
						// 窗口失焦（Alt+Tab / 拖出窗口）也要收尾，否则 iframe 一直不可点
						window.removeEventListener('blur', onUp, true);
						frames.forEach((f) => { f.style.pointerEvents = ''; });
						document.body.style.userSelect = prevSelect;
						document.body.style.cursor = prevCursor;
						try { localStorage.setItem(STORE_KEY, aside.style.width); } catch { /* ignore */ }
					};

					document.addEventListener('mousemove', onMove, true);
					document.addEventListener('mouseup', onUp, true);
					window.addEventListener('blur', onUp, true);
				},
			});

			const aside = react.createElement(
				'aside',
				{
					'data-vssaros-market-conv': '',
					// ★ 把「＋ 新会话」挂进对话栏（生命周期与面板绑定）
					//   ⚠ 折叠时**不要**挂（窄条里放不下，而且 newSession 也没意义）
					ref: (el) => { if (el && !collapsed) { mountNewButton(el); } },
					style: {
						flex: '0 0 auto',
						position: 'relative',
						// ★ 收起时**整个对话栏隐藏**（用户：收起后右上角留一个按钮即可）
						//   ⚠ 不是收成窄条 —— 30px 里塞竖排文字会被拆成两列，很难看（实测截图）
						//   ⚠ 也不能卸载：会话状态 / 滚动位置 / 正在流式的回复都会丢 ✗
						//   ⇒ `display: none`（DOM 还在，只是不占位、不可见）
						display: collapsed ? 'none' : 'flex',
						width: savedConvWidth(),
						minWidth: CONV_MIN + 'px',
						maxWidth: '70%',
						height: '100%',
						minHeight: 0,
						flexDirection: 'column',
						overflow: 'hidden',
						borderLeft: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22))',
					},
				},
				// ── 收起按钮（★ 只出现在**展开态**；折叠态的展开按钮在面板层，见下）──
				react.createElement('button', {
					type: 'button',
					'data-vssaros-market-collapse': collapsed ? 'collapsed' : 'expanded',
					title: '收起 AI 助手',
					onClick: (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						setCollapsed(true);
					},
					style: {
						position: 'absolute', zIndex: 2147483000, left: '8px', top: '5px',
						height: '22px', padding: '0 8px', borderRadius: '6px',
						border: '1px solid var(--dsw-alias-border-l2,#dcdfe6)',
						background: 'var(--dsw-alias-bg-layer-1,#fff)',
						color: 'var(--dsw-alias-label-secondary, #6b7280)',
						font: '11px/20px -apple-system,"Segoe UI",sans-serif',
						cursor: 'pointer', pointerEvents: 'auto',
					},
				}, '» 收起'),
				// 官方对话本体（会话 / hero / 输入框全在里面）
				// ⚠ 折叠时**不卸载**（否则会话状态、滚动位置、正在流式的回复全丢 ✗），只藏起来
				react.createElement('div', {
					style: {
						flex: '1 1 auto', minHeight: 0, overflow: 'auto',
						display: collapsed ? 'none' : 'flex', flexDirection: 'column',
					},
				}, conversation),
			);

			return react.createElement(
				'div',
				{
					'data-vssaros-market-panel': '',
					// 外壳（vssaros-workbenches 的 S2 一体条）据此决定「«」显隐：1 = 助手栏已收起
					'data-vssaros-assist-collapsed': collapsed ? '1' : '0',
					style: {
						display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0, height: '100%',
						position: 'relative',
					},
				},
				siteWrap,
				splitter,
				aside,
			);
		}

		function apply(ctx) {
			// ★ 用 `ctx.inject` 捕获 `agentPresets`（★ 2026-10-26 用户报「聊天框没显示商城助手」）
			//   ⚠ **不能只靠 `ctx.get`**：在未声明 inject 的插件里它返回 undefined
			//     （studio 自己注释里写过这条：`uiSession` 也只能靠动态 inject 拿到）
			//     ⇒ 之前 `tryApplyPreset` 大概率一直 `no-service`，**静默失败** ✗
			//   两个名字都试（它可能是 remote 服务，也可能挂在根上）
			// 会话服务：同样只能靠动态 inject（`ctx.get('uiSession')` 拿不到）
			try {
				ctx.inject(['uiSession'], (scope) => {
					globalThis.__vssarosMarketUiSession = scope.uiSession || (scope.get && scope.get('uiSession')) || null;
				});
			} catch { /* 老宿主没有该服务 ⇒ currentSessionId 会退回 DOM / dockedSessionOf */ }

			for (const key of ['agentPresets', 'remote.agentPresets']) {
				try {
					ctx.inject([key], (scope) => {
						const svc = (scope.agentPresets && scope.agentPresets)
							|| (scope['remote.agentPresets'] && scope['remote.agentPresets'])
							|| (scope.get && scope.get(key))
							|| null;
						if (svc && !PRESET_API) {
							PRESET_API = svc;
							presetDiag.api = `injected(${key})`;
							globalThis.__vssarosMarketPreset = presetDiag;
							// 服务一到就试一次（面板可能已经在前台了，别等下一次挂载）
							try { ensureMarketDefaults(ctx); } catch { /* ignore */ }
						}
					});
				} catch { /* 该服务名不存在 ⇒ 试下一个 */ }
			}

			/**
			 * 包一层：面板**挂载时**说明商城在前台 ⇒ 顺手把当前会话的 agent 设成商城助手。
			 *
			 * ⚠ 不能无条件包（见 `ensureMarketDefaults` 的注释）：`agentPresets` 是全局的
			 *   当前会话选择，在别的页面设会把用户选的 agent 抢走。
			 */
			function MarketPanelWithDefaults(props) {
				react.useEffect(() => {
					// ★★ **必须轮询**（★ 2026-10-26 对照 studio 找到的关键差异）
					//   hero 空态时**会话还没建出来** ⇒ `agentPresets.select` 无处可设，
					//   或者服务本身还在异步就绪 ⇒ 只试一次几乎必然失败（studio 也是踩过才改成轮询）。
					//   studio：`setInterval` 400ms、最多 12 次（≈4.8s）。
					if (props && props.entry && props.entry.id) { presetDiag.entryId = props.entry.id; }
					let tries = 0;
					const timer = setInterval(() => {
						tries += 1;
						try { ensureMarketDefaults(ctx); } catch { /* ignore */ }
						if (presetDiag.ok === true || tries >= 12) { clearInterval(timer); }
					}, 400);
					// 立刻先试一次（服务可能早就绪了，不必等 400ms）
					try { ensureMarketDefaults(ctx); } catch { /* ignore */ }
					return () => clearInterval(timer);
				}, []);
				return react.createElement(MarketPanel, props);
			}

			// 注册式工作台：宿主 Frame 会给我们 `props.conversation`（对话停靠点）。
			// ⚠ 宿主较旧（没有 desktopWorkbenches）⇒ 直接跳过，页面路由照常工作 ✓
			try {
				ctx.inject(['desktopWorkbenches'], (scope) => {
					const dw = scope.desktopWorkbenches || (scope.get && scope.get('desktopWorkbenches'));
					if (!dw || typeof dw.register !== 'function') { return; }
					// 组件是模块级函数、拿不到闭包 ⇒ 用全局引用给「＋ 新会话」按钮用
					globalThis.__vssarosMarketDw = dw;
					scope.effect(() => dw.register(DESCRIPTOR, MarketPanelWithDefaults), 'vssaros-marketplace: workbench');

					// ★ 用户点「+ 新会话」⇒ 新会话默认选中商城助手。
					//   为什么要包：`newSession()` 自己不传 preset（宿主不认得我们的 bot），
					//   而 hero 的懒创建不经过任何我们能插手的代码 ⇒ 这是唯一可靠路径。
					//   ⚠ 必须还原（dispose 时把原函数放回去），否则卸载后还挂着我们的钩子。
					const origNewSession = typeof dw.newSession === 'function' ? dw.newSession : null;
					if (!origNewSession) { return; }
					const patched = function (...args) {
						const out = origNewSession.apply(dw, args);
						// 会话是异步建的 ⇒ 稍等再设（`ensureMarketDefaults` 内部会再等输入框就绪）
						setTimeout(() => { try { ensureMarketDefaults(ctx); } catch { /* ignore */ } }, 350);
						return out;
					};
					scope.effect(() => {
						// 只在没被别的插件包过时挂上去（避免覆盖别人的钩子）
						if (dw.newSession !== origNewSession) { return; }
						dw.newSession = patched;
						return () => { if (dw.newSession === patched) { dw.newSession = origNewSession; } };
					}, 'vssaros-marketplace: newSession preset');
				});
			} catch (e) {
				console.error('[vssaros-marketplace] 注册工作台失败（页面仍可用）', e);
			}
		}

		module.exports = { apply, install: apply };
		module.exports.inject = ['slots'];
		return module.exports;
	},
});
