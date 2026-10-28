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
		const MEDIA_PRESET = 'vssaros-media-librarian';
		const COLLAPSE_KEY = 'vssaros.media.convCollapsed';
		const WIDTH_KEY = 'vssaros.media.convWidth';
		const CONV_WIDTH = '380px';
		const WB_ID = 'vssaros/media';

		/**
		 * `remote.agentPresets` 服务的模块级引用。
		 * 为什么放模块级：`MediaPanel` 是注册给宿主的**模块级组件**，拿不到 `apply(ctx)` 的闭包，
		 * 但它需要把当前会话的 agent 纠回「媒体库管家」（见组件里的 useEffect）。
		 */
		let PRESETS = null;

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

		// ★ 2026-10-28（用户：「媒体库工作台中的 AI 助手内，应该显示 媒体库助手 agent」）：
		//   现象是右侧对话列显示「商城助手」。根因：**商城插件也包了 dw.newSession**，而它的守卫是
		//   「已被别人包过就放弃」⇒ 后装的我们永远包不上 ⇒ 新会话沿用别人的 agent preset。
		//   这里两条一起做：
		//     ① 记录「媒体库工作台是否在前台」（外壳 Frame 会给 customFrame 传 props.active）；
		//     ② 前台时把**当前停靠会话**的 agent 纠回「媒体库管家」——这样已经存在的会话也能被修好。
		react.useEffect(() => {
			const active = props && props.active === true;
			globalThis.__vssarosMediaActive = active;
			if (!active) { return undefined; }
			try {
				const dw = globalThis.__vssarosMediaDw;
				const sid = dw && typeof dw.dockedSessionOf === 'function' ? dw.dockedSessionOf(WB_ID) : '';
				if (sid && PRESETS && typeof PRESETS.select === 'function') {
					PRESETS.select(sid, MEDIA_PRESET);
				}
			} catch (e) { /* 纠正失败不影响面板 */ }
			return () => { globalThis.__vssarosMediaActive = false; };
		}, [props && props.active]);

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
			let presets = null;
			try {
				ctx.inject(['remote.agentPresets'], (scope) => {
					presets = scope['remote.agentPresets'] || (scope.get && scope.get('remote.agentPresets')) || null;
					// 面板（MediaPanel）是模块级函数，拿不到这个闭包 ⇒ 放模块级，供「纠回 agent」用
					PRESETS = presets;
				});
			} catch (e) { /* 拿不到就只做面板，不改 preset */ }

			try {
				ctx.inject(['desktopWorkbenches'], (scope) => {
					const dw = scope.desktopWorkbenches || (scope.get && scope.get('desktopWorkbenches'));
					if (!dw || typeof dw.register !== 'function') { return; }
					globalThis.__vssarosMediaDw = dw;
					scope.effect(() => dw.register(DESCRIPTOR, MediaPanel), 'vssaros-media: workbench');

					// ★ 新建会话默认绑「媒体库管家」（用户：agent 要是媒体库助手）。
					//   ⚠ 2026-10-28 真机 bug：**商城插件也包了 `dw.newSession`**，而它的守卫是
					//   「`dw.newSession !== origNewSession` ⇒ 放弃」⇒ 后装的我们**永远包不上**
					//   ⇒ 会话沿用「商城助手」（截图现象）。所以这里**不再判断"是否已被包过"**：
					//   总是把**当时**的 `dw.newSession` 链在后面，并只在**本工作台在前台**时才改 preset
					//   （否则会把别的工作台的会话也带跑）。
					const orig = typeof dw.newSession === 'function' ? dw.newSession : null;
					if (!orig) { return; }
					const patched = function (...args) {
						const out = orig.apply(dw, args);
						try {
							Promise.resolve(out).then((sid) => {
								if (!globalThis.__vssarosMediaActive) { return; }
								if (!sid || !presets || typeof presets.select !== 'function') { return; }
								try { presets.select(sid, MEDIA_PRESET); } catch (e) { /* ignore */ }
							}).catch(() => { /* ignore */ });
						} catch (e) { /* ignore */ }
						return out;
					};
					scope.effect(() => {
						// 链式包：`orig` 可能是别的插件包过的版本 ⇒ 沿用它、只在外层再套一层
						dw.newSession = patched;
						return () => { if (dw.newSession === patched) { dw.newSession = orig; } };
					}, 'vssaros-media: newSession preset');
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
