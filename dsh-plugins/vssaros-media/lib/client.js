// @vssaros/dsh-media — workbench chunk（注册式工作台 + 右侧对话列）
//
// 为什么需要这个文件（2026-10-28 用户：「媒体库点展开 AI 助手，右侧没有弹出 AI 聊天框，且 agent 要是媒体库助手」）：
//   媒体库原来只是**页面**（/x/media/，由 dashboard 目录打开）⇒ 页面里没有对话停靠点
//   （自托管页拿不到宿主的 props.conversation）⇒ 右侧**没有可展开的助手列**，只能靠
//   postMessage 求父窗口代开 —— 那条路依赖父窗口有没有人监听，不可靠。
//   ⇒ 按萨罗斯平台 / 商城同一套做法：注册 **customFrame 工作台**，宿主会注入
//     props.conversation ⇒ 右侧就是真正内嵌的 AI 对话列，agent 绑「媒体库管家」。
//
// 边界（照抄 vssaros-marketplace/lib/workbench.js 的结论）：
//   ① 不在这里调模型（模型能力在官方 chat-surface 里，本文件只负责摆位置）
//   ② 不重画媒体库（左侧就是现有的 /x/media/，一行不改）
//   ③ 展开/收起按钮与拖拽**收归外壳**（vssaros-workbenches 的 S2 一体条）⇒ 本文件只写属性 + 听事件

window.__ModuleLoader__.load({
	id: '@vssaros/dsh-media',
	factory: (require) => {
		const module = { exports: {} };
		const react = require('react');

		const SITE_PATH = '/x/media/';
		const COLLAPSE_KEY = 'vssaros.media.convCollapsed';
		const WIDTH_KEY = 'vssaros.media.convWidth';
		const CONV_WIDTH = '380px';
		const WB_ID = 'vssaros/media';


		function savedWidth() {
			try {
				const v = localStorage.getItem(WIDTH_KEY);
				if (v && /^[0-9]+px$/.test(v)) { return v; }
			} catch (e) { /* ignore */ }
			return CONV_WIDTH;
		}

		/**
		 * 媒体库工作台面板：左 = 现有 /x/media/ 页面（iframe），右 = 官方对话（props.conversation）。
		 *
		 * 与外壳的契约（见 dsh-plugins/check-assistant-collapse.mjs）：
		 *   · 面板根写 data-vssaros-assist-collapsed（1 = 已收起）⇒ 外壳据此切换 « / »
		 *   · 监听 window 上的 vssaros:assist-expand / collapse（CustomEvent 只向上冒泡，挂子节点收不到）
		 */
		function MediaPanel(props) {
			const conversation = props && props.conversation ? props.conversation : null;
			const collapsedState = react.useState(() => {
				try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { return false; }
			});
			const collapsed = collapsedState[0];
			react.useEffect(() => {
				const onToggle = (ev) => {
					const target = ev && ev.detail && ev.detail.workbench;
					if (target && target !== WB_ID) { return; }
					const open = ev.type === 'vssaros:assist-expand';
					collapsedState[1](!open);
					try { localStorage.setItem(COLLAPSE_KEY, open ? '0' : '1'); } catch (e) { /* ignore */ }
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
				title: '媒体库',
				'data-vssaros-media-site': '',
				style: { flex: '1 1 auto', width: '100%', height: '100%', border: 0, background: 'transparent' },
			});
			const siteWrap = react.createElement('div', { style: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex' } }, site);

			const rootStyle = { display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0, height: '100%', position: 'relative' };

			// 没有对话停靠点（宿主太旧）⇒ 整页就是媒体库，页面路由照常工作 ✓
			if (!conversation) {
				return react.createElement('div', {
					'data-vssaros-media-panel': '',
					'data-vssaros-assist-collapsed': '1',
					style: rootStyle,
				}, siteWrap);
			}

			// 拖动实现（挂 mousedown；拖动期间关掉 iframe 的 pointer-events，否则鼠标进 iframe 就收不到事件）
			const startDrag = (ev) => {
				ev.preventDefault();
				const el = ev.currentTarget;
				const aside = el.nextElementSibling;
				const left = el.previousElementSibling;
				if (!aside) { return; }
				const frames = left ? Array.prototype.slice.call(left.querySelectorAll('iframe')) : [];
				frames.forEach((f) => { f.style.pointerEvents = 'none'; });
				const startX = ev.clientX;
				const startW = aside.getBoundingClientRect().width;
				const onMove = (e) => {
					const w = Math.max(260, Math.min(720, startW + (startX - e.clientX)));
					aside.style.width = w + 'px';
				};
				const onUp = () => {
					frames.forEach((f) => { f.style.pointerEvents = ''; });
					document.removeEventListener('mousemove', onMove);
					document.removeEventListener('mouseup', onUp);
					try { localStorage.setItem(WIDTH_KEY, aside.style.width); } catch (e) { /* ignore */ }
				};
				document.addEventListener('mousemove', onMove);
				document.addEventListener('mouseup', onUp);
			};
			// 拖动条：纯 DOM 改 aside 宽度（不进 state ⇒ 不重渲染、不打断对话）
			const splitter = react.createElement('div', {
				'data-vssaros-media-split': '',
				title: '左右拖动调节宽度（双击复位）',
				onMouseDown: startDrag,
				style: {
					flex: '0 0 auto', width: '6px', cursor: 'col-resize',
					background: 'transparent', position: 'relative', zIndex: 5,
					display: collapsed ? 'none' : undefined,
				},
				onDoubleClick: (ev) => {
					const aside = ev.currentTarget.nextElementSibling;
					if (aside) { aside.style.width = CONV_WIDTH; try { localStorage.removeItem(WIDTH_KEY); } catch (e) { /* ignore */ } }
				},
			});

			const aside = react.createElement('aside', {
				'data-vssaros-media-conv': '',
				style: {
					flex: '0 0 auto', width: savedWidth(), minWidth: 0, minHeight: 0,
					display: collapsed ? 'none' : 'flex', flexDirection: 'column',
					borderLeft: '1px solid rgba(128,128,128,.22)',
				},
			}, conversation);

			return react.createElement('div', {
				'data-vssaros-media-panel': '',
				// 外壳据此决定「« 展开 / » 收起」
				'data-vssaros-assist-collapsed': collapsed ? '1' : '0',
				style: rootStyle,
			}, siteWrap, splitter, aside);
		}

		const DESCRIPTOR = {
			title: '媒体库',
			description: '媒体资产库；右侧内嵌 AI 助手对话（官方 chat-surface），默认 agent = 媒体库管家。',
			// vssaros: scheme ⇒ id 归一成 vssaros/media
			repository: 'vssaros:media',
			icon: 'codicon:file-media',
			// ★ 只有它为 true，宿主才会注入 props.conversation
			customFrame: true,
			layout: { businessSide: 'left' },
		};

		function apply(ctx) {
			try {
				ctx.inject(['desktopWorkbenches'], (scope) => {
					const dw = scope.desktopWorkbenches || (scope.get && scope.get('desktopWorkbenches'));
					if (!dw || typeof dw.register !== 'function') { return; }
					scope.effect(() => dw.register(DESCRIPTOR, MediaPanel), 'vssaros-media: workbench');
					// ★ 2026-11-02 根治：不再包 dw.newSession、不再在面板里 select 媒体库管家 ——
					//   默认 agent **只由宿主 vssaros-workbenches 设**（对照表 'vssaros/media' → vssaros-media-librarian），
					//   且只改媒体库自己停靠的那条会话。媒体库 agent 文件仍由 Host 侧 lib/mediaAgent.js 写入（与之同 id）。
				});
			} catch (e) {
				console.error('[vssaros-media] 注册工作台失败（页面仍可用）', e);
			}

			// ⚠ 2026-10-28：这里**不再**给 `layout.selectPanel` / `uiWorkspace.openSession` 打补丁。
			//   之前加过一层「前台时 selectPanel(null) 直接 return」的"防御层"，结果它装在外壳
			//   （vssaros-workbenches）那道守卫的**外面**，把 null **吞掉不往下传** ⇒ 外壳
			//   "拦下后把会话停靠进对话列"那一步永远执行不到 ⇒ 点会话 / 新建会话都"没反应"。
			//   ⇒ 面板守卫**只由外壳负责一处**；业务插件碰这两个函数只会互相架空。
		}

		module.exports = { apply, install: apply };
		module.exports.inject = ['slots'];
		return module.exports;
	},
});
