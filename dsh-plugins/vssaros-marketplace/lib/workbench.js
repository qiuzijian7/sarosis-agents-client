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
		// ★ 2026-11-02 根治：这里原有「商城自己设商城助手 + 预填 `@商城助手 `」的整套逻辑（MARKET_PRESET /
		//   tryApplyPreset / seedDraft / ensureMarketDefaults），**已删除**。它对**全局当前会话**下手、还包了
		//   `dw.newSession`，与知识库 / 媒体库 / 萨罗斯 / 宿主一共 5 个写入者互相覆盖 ⇒ agent 反复串台。
		//   现在默认 agent **只由宿主 vssaros-workbenches 设**（对照表 'vssaros/marketplace' → vssaros-marketplace-bot），
		//   且只改商城自己停靠的那条会话。商城 agent 文件仍由 Host 侧 lib/marketAgent.js 写入（与之同 id）。
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
			// （2026-11-02：左上角「» 收起」已删，开合只经下面的外壳事件 ⇒ 不再需要独立的 setCollapsed）
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
				// （左上角不再放收起按钮：收起 / 展开统一走右侧浮动工具栏。2026-11-02）
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

			// 注册式工作台：宿主 Frame 会给我们 `props.conversation`（对话停靠点）。
			// ⚠ 宿主较旧（没有 desktopWorkbenches）⇒ 直接跳过，页面路由照常工作 ✓
			try {
				ctx.inject(['desktopWorkbenches'], (scope) => {
					const dw = scope.desktopWorkbenches || (scope.get && scope.get('desktopWorkbenches'));
					if (!dw || typeof dw.register !== 'function') { return; }
					scope.effect(() => dw.register(DESCRIPTOR, MarketPanel), 'vssaros-marketplace: workbench');
					// （2026-11-02：不再包 dw.newSession —— 新会话的默认 agent 由宿主 newSession 自己带）
				});
			} catch (e) {
				console.error('[vssaros-marketplace] 注册工作台失败（页面仍可用）', e);
			}

			// ⚠ 2026-10-28：这里**不再**给 `layout.selectPanel` / `uiWorkspace.openSession` 打补丁。
			//   之前照搬过一层「前台时 selectPanel(null) 直接 return」，结果它装在外壳
			//   （vssaros-workbenches）那道守卫的**外面**，把 null **吞掉不往下传** ⇒ 外壳
			//   "拦下后把会话停靠进对话列"那一步永远执行不到 ⇒ 点会话 / 「＋ 新建会话」都"没反应"。
			//   ⇒ 面板守卫**只由外壳负责一处**；业务插件碰这两个函数只会互相架空。
			}

		module.exports = { apply, install: apply };
		module.exports.inject = ['slots'];
		return module.exports;
	},
});
