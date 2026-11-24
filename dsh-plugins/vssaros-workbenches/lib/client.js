// ★ 2026-10-27 修复共享层 CSS 被反引号截断（0.2.21）—— 触碰入口使产物 revision 更新
// ★ 2026-10-27 工作台标题统一（共享层：工具条标题规格（--wb-f-title / .wb-toolbar h1））—— 触碰入口使产物 revision 更新
// @vssaros/dsh-workbenches — 工作台宿主（客户端半）。
//
// 提供客户端服务 `desktopWorkbenches`（与 dsh-desktop 官方宿主**同名同形**，见 doc/workbench-refactor-plan.md §4.1）。
// 业务插件的写法与官方工作台一字不差：
//
//   ctx.effect(() => ctx.desktopWorkbenches.register({ title, repository, customFrame, headerLayout, layout }, Panel))
//
// 照搬官方（`dsh-desktop-workbenches/client.js`，MIT，见 THIRD_PARTY.md）的部分：
//   · `register()` 的校验（852-883）：校验失败一律**抛异常**（"必须"项不满足 = 不登记，不降级）；
//     同一身份重复注册抛错；返回值即注销函数；
//   · `PanelBoundary` / `PanelFailure` 错误边界（2186-2197）：业务组件抛错 ⇒ 显示失败卡，不白屏；
//   · `HeaderHost` 的 compact 顶栏校验（2210-2233）：文档内必须**唯一**的 `[data-dsh-workbench-toolbar]`，
//     否则回退默认布局并 warn 一次；`data-dsh-compact-toolbar/-valid` 只由宿主设置。
//
// 与官方不同的部分（原版 0.2.1-rc.1 没有官方依赖的补丁接缝，见方案 §2 F4）：
//   · 承载 = 每个工作台一个 `main` keyed 面板（`vssaros-wb:<身份>`），`open()` 即 `layout.selectPanel(key)`；
//     官方的 `desktop.workbench.frame`（中栏外框 + 会话 portal）在原版里不存在 ⇒ 暂不支持把会话嵌进业务页；
//   · 身份：除 `https://github.com/<owner>/<repo>` 外，接受内置保留身份 `vssaros:<module>` → `vssaros/<module>`
//     （"只许 @vssaros/* 用"由清单解析器 `vssarosPluginManifest.ts` 在安装面钉住，客户端拿不到调用方包名）；
//   · 标准分栏（customFrame=false）P1 暂按整页渲染（右栏承载在 P2 做，方案 §4.3）。
// 构建标记：在页面 console 里输入 __vssarosWorkbenchBuild 即可知道窗口加载的是哪个版本
// ⚠ bump package.json 版本时必须同步本行 —— check-assistant-collapse.mjs 会判红（2026-11-10 收口）。
// 0.3.70（2026-11-21）：图钉已固定态加 is-pinned 可见样式 + 对勾图标，点击同步切换。
globalThis.__vssarosWorkbenchBuild = '0.3.70';
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-workbenches',
	factory: (require) => {
		var module = { exports: {} };
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;
		const InlineAssistantContext = React.createContext(null);

		const STATE_URL = '/api/vssaros-workbenches/state';
		/** 服务端现签的「带 token 深链」；外开必须用它（另一个浏览器没有当前 Cookie）。 */
		const LINK_PATH_PREFIX = '/api/vssaros-workbenches/link';
		const PANEL_PREFIX = 'vssaros-wb:';
		const VSSAROS_SCHEME = 'vssaros:';
		const LOCAL_SCHEME = 'local:';
		const GITHUB_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
		const MODULE_RE = /^[a-z][a-z0-9-]{0,31}$/;
		/** npm 包名（官方本地身份用 `local:<包名>`，scoped 包为 `local:@scope/name`）。 */
		const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
		/** 工作台子页的稳定 id：小写开头，避免用显示标题/数组序号当主键。 */
		const PAGE_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;
		const CATALOG_STATES = new Set(['active', 'alias', 'deprecated', 'offline', 'retired', 'hidden', 'disabled']);
		function catalogKey(workbenchId, pageId) { return workbenchId + '/' + pageId; }
		function catalogPageStateOf(page, fallback) {
			const explicit = typeof page.state === 'string' && page.state.trim()
				? page.state.trim()
				: (fallback && typeof fallback.state === 'string' && fallback.state.trim() ? fallback.state.trim() : '');
			if (CATALOG_STATES.has(explicit)) { return explicit; }
			if (page.retired || (fallback && fallback.retired)) { return 'retired'; }
			if (page.hidden || (fallback && fallback.hidden)) { return 'hidden'; }
			if (page.enabled === false || (fallback && fallback.enabled === false)) { return 'disabled'; }
			if (page.availability && page.availability !== 'ready') { return page.availability; }
			return 'active';
		}
		function canonicalIdOf(page, fallback, workbenchId) {
			const explicit = typeof page.canonicalId === 'string' && page.canonicalId.trim()
				? page.canonicalId.trim()
				: (fallback && typeof fallback.canonicalId === 'string' && fallback.canonicalId.trim() ? fallback.canonicalId.trim() : '');
			return explicit || workbenchId;
		}
		function aliasesOf(page, fallback) {
			const raw = Array.isArray(page.aliases) ? page.aliases
				: (fallback && Array.isArray(fallback.aliases) ? fallback.aliases : []);
			return Object.freeze([...new Set(raw.filter(value => typeof value === 'string' && value.trim())
				.map(value => value.trim()))]);
		}
		function replacedByOf(page, fallback) {
			const value = typeof page.replacedBy === 'string' ? page.replacedBy
				: (fallback && typeof fallback.replacedBy === 'string' ? fallback.replacedBy : '');
			return value.trim();
		}
		function catalogVisibilityOf(page, fallback, state, route, key) {
			const custom = page.visibility && typeof page.visibility === 'object' ? page.visibility
				: (fallback && fallback.visibility && typeof fallback.visibility === 'object' ? fallback.visibility : null);
			const bool = (value, defaultValue) => typeof value === 'boolean' ? value : defaultValue;
			const ready = state === 'active';
			return Object.freeze({
				start: bool(custom && custom.start, ready),
				launcher: bool(custom && custom.launcher, ready),
				nativeTab: bool(custom && custom.nativeTab, true),
				routeWhitelist: bool(custom && custom.routeWhitelist, !!route),
				deepLink: bool(custom && custom.deepLink, !!route || !!key),
			});
		}
		/** P1 统一目录条目：快照只暴露可序列化字段，Component 留在内部 renderer Map。 */
		function normalizeCatalogPage(page, workbenchId, fallback) {
			if (!page || typeof page !== 'object') { throw new Error('Invalid workbench page descriptor'); }
			const pageId = typeof page.id === 'string' ? page.id.trim() : '';
			if (!PAGE_ID_RE.test(pageId)) { throw new Error('Invalid workbench page id: ' + pageId); }
			const title = typeof page.title === 'string' && page.title.trim() ? page.title.trim() : fallback.title;
			if (!title) { throw new Error('Invalid workbench page title'); }
			const description = typeof page.description === 'string' ? page.description : fallback.description;
			const icon = typeof page.icon === 'string' ? page.icon : fallback.icon;
			const sourcePackage = typeof page.sourcePackage === 'string' ? page.sourcePackage : fallback.sourcePackage;
			const route = typeof page.route === 'string' ? page.route.trim() : '';
			const explicitComponent = typeof page.component === 'function' ? page.component
				: (typeof page.Component === 'function' ? page.Component : null);
			const Component = explicitComponent || (route ? null : fallback.Component);
			const kind = typeof Component === 'function' ? 'component' : (route ? 'route' : 'external');
			const hidden = page.hidden === true || fallback.hidden === true;
			const retired = page.retired === true || fallback.retired === true;
			const enabled = page.enabled !== false && fallback.enabled !== false;
			const availability = retired ? 'retired' : hidden ? 'hidden' : enabled ? 'ready' : 'disabled';
			const state = catalogPageStateOf({ ...page, hidden, retired, enabled, availability }, fallback);
			const sourceKind = typeof page.sourceKind === 'string' && page.sourceKind ? page.sourceKind : fallback.sourceKind;
			const key = catalogKey(workbenchId, pageId);
			const canonicalId = canonicalIdOf(page, fallback, workbenchId);
			const canonicalKey = canonicalId + '/' + pageId;
			const visibility = catalogVisibilityOf(page, fallback, state, route, key);
			return Object.freeze({
				key, workbenchId, pageId, title, description: description || '', icon: icon || '',
				sourcePackage: sourcePackage || '', sourceKind: sourceKind || '', kind, route,
				hidden, retired, enabled, availability, state,
				canonicalId, canonicalKey, visibility, aliases: aliasesOf(page, fallback), replacedBy: replacedByOf(page, fallback),
				renderHandle: kind === 'route' ? 'route:' + route : 'component:' + key,
				Component,
			});
		}
		function catalogPageSnapshot(page) {
			return Object.freeze({
				key: page.key, workbenchId: page.workbenchId, pageId: page.pageId,
				title: page.title, description: page.description, icon: page.icon,
				sourcePackage: page.sourcePackage, sourceKind: page.sourceKind, kind: page.kind, route: page.route,
				hidden: page.hidden, retired: page.retired, enabled: page.enabled,
				availability: page.availability, state: page.state,
				canonicalId: page.canonicalId, canonicalKey: page.canonicalKey,
				visibility: page.visibility, aliases: page.aliases, replacedBy: page.replacedBy,
				renderHandle: page.renderHandle,
			});
		}
		/** FNV-1a 32-bit：给 Better Sidebar 的 tab type 生成稳定、短且无歧义的后缀。 */
		function stableHash8(text) {
			let hash = 0x811c9dc5;
			for (let i = 0; i < text.length; i += 1) {
				hash ^= text.charCodeAt(i);
				hash = Math.imul(hash, 0x01000193) >>> 0;
			}
			return hash.toString(16).padStart(8, '0');
		}
		/** v6 开始页：每张工作台 item 的稳定 DOM 锚点与常显拖拽锚点身份。 */
		function homeWorkbenchCardIdOf(key) {
			return 'vssaros-home-workbench-' + stableHash8(String(key || ''));
		}
		function homeWorkbenchAnchorIdOf(key) {
			return 'vssaros-home-workbench-anchor-' + stableHash8(String(key || ''));
		}
		function sidebarTabTypeOf(page) {
			const safe = String(page.pageId).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40) || 'page';
			return 'vssaros-wb:' + safe + ':' + stableHash8(page.key);
		}
		/** `ctx.inject(['betterSidebar'])` 的回调参数可能是 scoped ctx，也可能直接挂属性。 */
		function optionalService(scope, name) {
			if (!scope) { return null; }
			if (typeof scope.get === 'function') {
				try { const got = scope.get(name); if (got) { return got; } } catch { /* 未声明的服务会抛 */ }
			}
			try { return scope[name] || null; } catch { return null; }
		}
		let sidebarLayoutV1Enabled = true;
		let activeSidebarAdapter = null;
		globalThis.__vssarosSidebarLayoutV1 = true;
		function setSidebarLayoutV1(enabled) {
			sidebarLayoutV1Enabled = enabled !== false;
			globalThis.__vssarosSidebarLayoutV1 = sidebarLayoutV1Enabled;
			if (activeSidebarAdapter && typeof activeSidebarAdapter.setEnabled === 'function') {
				activeSidebarAdapter.setEnabled(sidebarLayoutV1Enabled);
			}
		}
		globalThis.__vssarosSetSidebarLayoutV1 = setSidebarLayoutV1;
		/** P3 默认开启；Host config / 跨 chunk 全局显式 false 优先回退旧布局。 */
		function readSidebarLayoutV1Config(ctx) {
			try {
				const direct = ctx && typeof ctx.config === 'function' ? ctx.config() : (ctx && ctx.config);
				if (direct && direct.sidebarLayoutV1 === false) { return false; }
				if (direct && direct.sidebarLayoutV1 === true) { return true; }
				const config = ctx && ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.options && ctx.fiber.entry.options.config;
				if (config && config.sidebarLayoutV1 === false) { return false; }
				if (config && config.sidebarLayoutV1 === true) { return true; }
			} catch { /* 老宿主没有 fiber/config */ }
			return globalThis.__vssarosSidebarLayoutV1 !== false;
		}
		function sidebarGuideReleased(betterSidebar) {
			try {
				const snapshot = betterSidebar && typeof betterSidebar.getSnapshot === 'function' ? betterSidebar.getSnapshot() : null;
				return !!(snapshot && snapshot.prefs && snapshot.prefs.guideTakeover === false);
			} catch { return false; }
		}
		function disposerOf(value) {
			if (typeof value === 'function') { return value; }
			if (value && typeof value.dispose === 'function') { return () => value.dispose(); }
			return null;
		}
		const HOME_WB_ORDER_FIELD = 'homeWorkbenchOrder';
		const HOME_TOOL_ORDER_FIELD = 'homeToolOrder';
		/** 统一排序字段：所有开始页 item（工作台 + 工具）共用一份顺序。 */
		const HOME_ITEM_ORDER_FIELD = 'homeItemOrder';
		const HOME_IMAGE_TAB_TYPE = 'vssaros:image-reference';
		const CREATE_PLUGIN_PROMPT = '创建一个带右侧栏入口的 DSH 插件。';
		/** 「浏览更多插件」的目标身份：目录真源里商城页的 canonicalId，也是注册式商城工作台 id。 */
		const MARKET_WORKBENCH_ID = 'vssaros/marketplace';
		/**
		 * 开始页「锚点」= 把 item 固定到左侧栏（2026-11-21）。
		 * 左侧栏是官方 DOM（[data-sidebar-left]），没有可用的 keyed 内容槽 ⇒ 同源 DOM 注入 +
		 * localStorage 持久化 + MutationObserver 重贴（与 chat-surface 隐藏官方行同一套自愈手法）。
		 * 点击卡片锚点切换；点击左侧栏里的 item 打开右栏页签；右键取消固定。
		 */
		const HOME_ANCHOR_STORAGE_KEY = 'vssaros.home.anchors';
		const HOME_ANCHOR_BOX_ID = 'vssaros-home-anchor-list';
		let homeAnchorMemory = [];
		let homeAnchorStoreDisabled = false;
		/**
		 * localStorage 在 Electron WebContentsView 里可能 setItem 抛 SecurityError。
		 * 一旦失败就**永久禁用**：否则写进内存、读却仍走 localStorage(null) ⇒ 状态当场丢失，
		 * 表现为「点 anchor 没反应」。读写必须同源。
		 */
		function homeAnchorStorage() {
			if (homeAnchorStoreDisabled) { return null; }
			try { return typeof localStorage !== 'undefined' ? localStorage : null; }
			catch { homeAnchorStoreDisabled = true; return null; }
		}
		function readHomeAnchors() {
			const store = homeAnchorStorage();
			let raw = null;
			if (store) {
				try { raw = store.getItem(HOME_ANCHOR_STORAGE_KEY); }
				catch { homeAnchorStoreDisabled = true; return homeAnchorMemory.slice(); }
			} else { return homeAnchorMemory.slice(); }
			let list = [];
			try { list = JSON.parse(raw || '[]'); } catch { list = []; }
			if (!Array.isArray(list)) { return []; }
			return list.filter(item => item && typeof item.key === 'string' && item.key.length < 200)
				.slice(0, 24).map(item => ({
					key: item.key,
					title: String(item.title || item.key).slice(0, 80),
					description: String(item.description || '').slice(0, 120),
					icon: String(item.icon || '').slice(0, 40),
					kind: String(item.kind || 'workbench'),
				}));
		}
		function writeHomeAnchors(list) {
			homeAnchorMemory = list.slice();
			const store = homeAnchorStorage();
			if (!store) { return; }
			try { store.setItem(HOME_ANCHOR_STORAGE_KEY, JSON.stringify(list)); }
			catch { homeAnchorStoreDisabled = true; }
		}
		function homeAnchorDescriptor(item) {
			return {
				key: String(item.key || item.itemKey || ''), title: String(item.title || ''),
				description: String(item.description || ''), icon: String(item.icon || ''),
				kind: String(item.kind || 'workbench'),
			};
		}
		function isHomeAnchored(key) { return readHomeAnchors().some(entry => entry.key === key); }
		function toggleHomeAnchor(item) {
			const descriptor = homeAnchorDescriptor(item);
			if (!descriptor.key) { return false; }
			const list = readHomeAnchors();
			const at = list.findIndex(entry => entry.key === descriptor.key);
			if (at >= 0) { list.splice(at, 1); }
			else { list.push(descriptor); }
			writeHomeAnchors(list);
			try { renderHomeAnchors(); } catch { /* 侧栏 DOM 未就绪时由 bridge 定时重贴兜底 */ }
			return at < 0;
		}
		/** 左侧栏容器不能只认 [data-sidebar-left]（真机可能不在该子树）；找不到就挂 body 浮层。 */
		function homeAnchorHost() {
			const width = (typeof window !== 'undefined' && window.innerWidth) || 1200;
			// 官方侧栏真实根是 [data-slot="sidebar"]（preload-dshView 的 CHAT_ONLY_CSS 用同一钩子）。
			for (const selector of ['[data-slot="sidebar"]', '[data-sidebar-left]', '[data-sidebar]', 'aside[data-sidebar]', '.sidebar-left']) {
				try {
					const el = document.querySelector(selector);
					if (!el || typeof el.appendChild !== 'function') { continue; }
					// 官方钩子 `display:contents` ⇒ rect 为 0，但子树就是真实左栏；无条件信任它。
					if (selector === '[data-slot="sidebar"]') { return el; }
					// 其它候选只认真正位于左半屏、有尺寸的容器；否则宁可用 body 浮层。
					const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
					if (rect && (rect.width === 0 || rect.height === 0 || rect.left > width * 0.5)) { continue; }
					return el;
				} catch { /* 选择器 / 几何 API 不受支持 */ }
			}
			return document.body && typeof document.body.appendChild === 'function' ? document.body : null;
		}
		/**
		 * 锚点列表必须落在左栏上部（官方三行原来的位置），而不是 append 到
		 * `[data-slot="sidebar"]`（display:contents）末尾 —— 那会把列表塞到整个侧栏内容之后，
		 * 左栏外层又是 overflow:hidden，用户点图钉后看不见新 item，误判「点击无反应」。
		 */
		function homeAnchorSlot(host, floating) {
			if (floating) { return { parent: host, before: null }; }
			try {
				// 「新会话」按钮之后 = 官方三行原来的位置；插到左栏根的普通 flex 流里（y≈104）一定可见。
				// 不能插到 scrollArea 的 nav 之后：实测那个容器会把普通流子元素推到
				// overflow:hidden 的底部（y=733），用户点图钉后根本看不见新 item。
				const newSession = Array.from(host.querySelectorAll('button'))
					.find(b => /新会话|New session|新建会话/i.test(String(b.textContent || '')));
				if (newSession && newSession.parentNode && typeof newSession.parentNode.insertBefore === 'function') {
					return { parent: newSession.parentNode, before: newSession.nextSibling };
				}
				const inner = host.firstElementChild || host;
				if (inner && typeof inner.insertBefore === 'function') {
					return { parent: inner, before: inner.firstChild || null };
				}
			} catch { /* 老宿主没有 querySelector */ }
			return { parent: host, before: host.firstChild || null };
		}
		function renderHomeAnchors() {
			if (typeof document === 'undefined' || typeof document.querySelector !== 'function'
				|| typeof document.createElement !== 'function') { return; }
			const host = homeAnchorHost();
			if (!host) { return; }
			const floating = host === document.body;
			const slot = homeAnchorSlot(host, floating);
			const stored = readHomeAnchors();
			// anchor surface：只在 registry 里明确查到且已下线时才隐藏；查不到的（刚固定 / 未就绪）一律保留。
			const registry = globalThis.__vssarosHomeItemRegistry;
			const list = registry && typeof registry.get === 'function'
				? stored.filter(entry => {
					const item = registry.get(entry.key);
					return !item || selectHomeItems([item], 'anchor').length === 1;
				})
				: stored;
			const signature = JSON.stringify(list);
			let box = typeof document.getElementById === 'function' ? document.getElementById(HOME_ANCHOR_BOX_ID) : null;
			// official.nextSibling 可能就是 box 自己（已插好）⇒ 避免 insertBefore(box, box) 抛错。
			const before = slot.before === box ? (box && box.nextSibling) : slot.before;
			// React 重渲染会重建侧栏子节点；清单没变且位置正确 ⇒ 不重绘（否则自激 MutationObserver）。
			const inPlace = box && box.parentNode === slot.parent && box.nextSibling === before;
			if (!box) {
				box = document.createElement('div');
				box.id = HOME_ANCHOR_BOX_ID;
				box.setAttribute('data-vssaros-home-anchors', '1');
			}
			// 容器可能在「body 浮层 ↔ 左栏内嵌」之间迁移：每次都要同步样式。
			// 否则旧 box 会一直带着 position:fixed;bottom:8px 钉在窗口左下角（实测 y=733），
			// 即使 DOM 已插到左栏上部，视觉上仍看不到点图钉后新增的 item。
			// 找不到真实左栏容器时才用固定浮层兜底。
			box.style.cssText = floating
				? 'position:fixed;left:8px;bottom:8px;z-index:80;max-width:220px;display:flex;flex-direction:column;gap:4px;padding:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#1f1f1f);box-shadow:0 6px 20px rgba(0,0,0,.25);'
				: 'display:flex;flex:0 0 auto;flex-direction:column;gap:4px;padding:6px 8px 8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));';
			if (inPlace && box.getAttribute('data-vssaros-anchor-signature') === signature) {
				box.style.display = list.length ? 'flex' : 'none';
				return;
			}
			// insertBefore 会自动把 box 从旧父节点摘下，不会留下重复的空容器。
			slot.parent.insertBefore(box, before);
			box.setAttribute('data-vssaros-anchor-signature', signature);
			const children = [];
			if (list.length) {
				const caption = document.createElement('div');
				caption.textContent = '锚点';
				caption.style.cssText = 'font-size:10px;color:var(--dsw-alias-label-tertiary,#888);padding:2px 6px;';
				children.push(caption);
			}
			for (const item of list) {
				const button = document.createElement('button');
				button.type = 'button';
				button.setAttribute('data-vssaros-home-anchor-item', item.key);
				button.setAttribute('aria-label', '打开 ' + item.title);
				button.title = item.title + '（右键：取消固定）';
				button.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;';
				const ico = document.createElement('span');
				// 存储里的 icon 是 SVG 形状名（book/brain…），直接当文本会显示成「book知识库」。
				ico.textContent = '◈';
				ico.style.cssText = 'width:16px;text-align:center;flex:0 0 auto;';
				const text = document.createElement('span');
				text.textContent = item.title;
				text.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
				button.appendChild(ico);
				button.appendChild(text);
				button.addEventListener('click', () => {
					const open = globalThis.__vssarosOpenHomeAnchor;
					// left-anchor：从左侧栏打开时走统一降级策略（V1 关闭/右栏未就绪 ⇒ 注册式工作台本体）。
					if (typeof open === 'function') { open(item.key, 'left-anchor'); }
				});
				button.addEventListener('contextmenu', ev => {
					try { ev.preventDefault(); } catch { /* 老宿主没有事件对象方法 */ }
					toggleHomeAnchor({ itemKey: item.key, title: item.title, description: item.description, icon: item.icon, kind: item.kind });
				});
				children.push(button);
			}
			if (typeof box.replaceChildren === 'function') { box.replaceChildren(...children); }
			else { box.textContent = ''; for (const child of children) { box.appendChild(child); } }
			box.style.display = list.length ? 'flex' : 'none';
		}
		/**
		 * 左栏 item 由 anchor 决定 ⇒ 官方三行必须在宿主侧兜底隐藏。
		 * chat-surface 侧也有一份，但它的 install 幂等标记在「Host 重启但 window 未重建」时
		 * 会挡住重新执行；workbenches 入口每次页面加载都会跑，这里补一道双保险。
		 */
		function hideOfficialSidebarRowsForAnchors() {
			if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') { return; }
			const labels = ['插件', 'Plugins', '自动化任务', 'Automation tasks', 'Automated tasks', '更多', 'More'];
			try {
				if (typeof document.getElementById === 'function' && !document.getElementById('vssaros-hidden-left-rows')
					&& typeof document.createElement === 'function') {
					const style = document.createElement('style');
					style.id = 'vssaros-hidden-left-rows';
					style.textContent = labels.map(label => '[data-slot="sidebar"] button[aria-label="' + label + '"]').join(',')
						+ '{display:none!important}';
					const host = document.head || document.documentElement || document.body;
					if (host && typeof host.appendChild === 'function') { host.appendChild(style); }
				}
			} catch { /* 样式注入失败不影响行隐藏 */ }
			try {
				const buttons = document.querySelectorAll('button[aria-label]');
				for (let i = 0; i < buttons.length; i += 1) {
					const btn = buttons[i];
					const label = String(btn.getAttribute('aria-label') || '').trim();
					if (labels.indexOf(label) < 0 || btn.getAttribute('data-vssaros-hidden') === '1') { continue; }
					btn.setAttribute('data-vssaros-hidden', '1');
					btn.style.display = 'none';
				}
			} catch { /* DOM 未就绪时由 observer / 兜底定时器补 */ }
		}
		let homeAnchorObserverInstalled = false;
		function ensureHomeAnchorObserver() {
			if (homeAnchorObserverInstalled || typeof MutationObserver !== 'function') { return; }
			try {
				let queued = 0;
				const target = homeAnchorHost() || document.body;
				if (target) {
					new MutationObserver(() => {
						if (queued) { return; }
						queued = setTimeout(() => {
						queued = 0;
						hideOfficialSidebarRowsForAnchors();
						renderHomeAnchors();
					}, 200);
					}).observe(target, { childList: true, subtree: true });
					homeAnchorObserverInstalled = true;
				}
			} catch { /* 观察失败不影响开始页 */ }
		}
		function installHomeAnchorBridge() {
			if (typeof window === 'undefined' || typeof document === 'undefined' || typeof document.querySelector !== 'function') { return; }
			hideOfficialSidebarRowsForAnchors();
			renderHomeAnchors();
			// 幂等只用于 storage 监听；渲染与 observer 每次都重试，避免首帧 DOM 未就绪后永久失效。
			if (!globalThis.__vssarosHomeAnchorBridgeInstalled) {
				globalThis.__vssarosHomeAnchorBridgeInstalled = true;
				try {
					window.addEventListener('storage', ev => { if (!ev || ev.key === HOME_ANCHOR_STORAGE_KEY) { renderHomeAnchors(); } });
				} catch { /* 老宿主 */ }
			}
			ensureHomeAnchorObserver();
			const repaint = () => { hideOfficialSidebarRowsForAnchors(); renderHomeAnchors(); };
			setTimeout(repaint, 400);
			setTimeout(repaint, 1500);
		}
		const INSTALL_STATUS_URL = '/api/vssaros-workbenches/install-status';
		const INSTALL_STATUS_POLL_MS = 30000;
		/**
		 * 单一目录真源由 `dsh-plugins/workbench-directory.mjs` 生成到下方区块。
		 * hidden/offline/retired 生成下线视图；active route 行直接进统一目录。
		 * 禁止在本文件手改业务条目，改完真源需跑 `generate-workbench-directory.mjs`。
		 */
		/* @generated-workbench-directory:start workbenches-client hash=bef767c4eff1 */
		const HIDDEN_VISIBILITY = Object.freeze({ start: false, launcher: false, nativeTab: true, routeWhitelist: true, deepLink: true });
		const OFFLINE_VISIBILITY = Object.freeze({ start: false, launcher: false, nativeTab: false, routeWhitelist: true, deepLink: true });
		const RETIRED_VISIBILITY = Object.freeze({ start: false, launcher: false, nativeTab: false, routeWhitelist: false, deepLink: false });
		const ACTIVE_VISIBILITY = Object.freeze({ start: true, launcher: true, nativeTab: true, routeWhitelist: true, deepLink: true });
		const ROUTE_VISIBILITY = Object.freeze({ start: false, launcher: false, nativeTab: false, routeWhitelist: true, deepLink: true });
		const WORKBENCH_MANIFEST = Object.freeze([
			Object.freeze({ key: "vssaros/marketplace/default", workbenchId: "vssaros/marketplace", pageId: "default", canonicalId: "vssaros/marketplace", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-marketplace"]), replacedBy: "legacy:/x/marketplace//vssaros-wb-marketplace", route: "/x/marketplace/", title: "商城工作台", description: "注册式商城工作台（开始页隐藏）", icon: "🛒", sourceKind: "registered", sourcePackage: "vssaros-marketplace", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 1, directoryOrder: 1, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "商城工作台", navIcon: "🛒", navHidden: true, navOffline: false, navComp: "", dashboardName: "商城工作台", dashboardDesc: "注册式商城工作台（开始页隐藏）", dashboardIcon: "🛒", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "商城工作台", toolsDesc: "注册式商城工作台（开始页隐藏）", toolsProvider: "vssaros-marketplace", toolsOffline: false }),
			Object.freeze({ key: "vssaros/sessions/default", workbenchId: "vssaros/sessions", pageId: "default", canonicalId: "vssaros/sessions", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-sessions"]), replacedBy: "", route: "/x/sessions/", title: "历史会话", description: "注册式历史会话（开始页隐藏）", icon: "🕘", sourceKind: "registered", sourcePackage: "vssaros-sessions", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 2, directoryOrder: 2, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "历史会话", navIcon: "🕘", navHidden: true, navOffline: false, navComp: "", dashboardName: "历史会话", dashboardDesc: "注册式历史会话（开始页隐藏）", dashboardIcon: "🕘", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "历史会话", toolsDesc: "注册式历史会话（开始页隐藏）", toolsProvider: "vssaros-sessions", toolsOffline: false }),
			Object.freeze({ key: "vssaros/workflow/default", workbenchId: "vssaros/workflow", pageId: "default", canonicalId: "vssaros/workflow", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-workflow"]), replacedBy: "", route: "/x/workflow/", title: "Workflow", description: "注册式工作流（开始页隐藏）", icon: "⚙", sourceKind: "registered", sourcePackage: "vssaros-workflow", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 3, directoryOrder: 3, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "Workflow", navIcon: "⚙", navHidden: true, navOffline: false, navComp: "", dashboardName: "Workflow", dashboardDesc: "注册式工作流（开始页隐藏）", dashboardIcon: "⚙", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "Workflow", toolsDesc: "注册式工作流（开始页隐藏）", toolsProvider: "vssaros-workflow", toolsOffline: false }),
			Object.freeze({ key: "vssaros/kanban/default", workbenchId: "vssaros/kanban", pageId: "default", canonicalId: "vssaros/kanban", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-kanban"]), replacedBy: "", route: "/x/kanban/", title: "Tasks", description: "注册式看板（开始页隐藏）", icon: "🗂", sourceKind: "registered", sourcePackage: "vssaros-kanban", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 4, directoryOrder: 4, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "Tasks", navIcon: "🗂", navHidden: true, navOffline: false, navComp: "", dashboardName: "Tasks", dashboardDesc: "注册式看板（开始页隐藏）", dashboardIcon: "🗂", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "Tasks", toolsDesc: "注册式看板（开始页隐藏）", toolsProvider: "vssaros-kanban", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/sessions//vssaros-wb-sessions", workbenchId: "legacy:/x/sessions/", pageId: "vssaros-wb-sessions", canonicalId: "vssaros/sessions", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-sessions", "/x/sessions/"]), replacedBy: "", route: "/x/sessions/", title: "会话", description: "旧 route 会话入口", icon: "💬", sourceKind: "legacy", sourcePackage: "vssaros-sessions", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 5, directoryOrder: 5, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-sessions", navName: "会话", navIcon: "💬", navHidden: true, navOffline: false, navComp: "", dashboardName: "会话", dashboardDesc: "旧 route 会话入口", dashboardIcon: "💬", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "会话", toolsDesc: "旧 route 会话入口", toolsProvider: "vssaros-sessions", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/sessions/?view=tiles/vssaros-wb-session-tiles", workbenchId: "legacy:/x/sessions/?view=tiles", pageId: "vssaros-wb-session-tiles", canonicalId: "vssaros/sessions", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-session-tiles", "/x/sessions/?view=tiles"]), replacedBy: "", route: "/x/sessions/?view=tiles", title: "会话磁贴", description: "旧会话磁贴视图", icon: "🧲", sourceKind: "legacy", sourcePackage: "vssaros-sessions", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 6, directoryOrder: 6, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-session-tiles", navName: "会话磁贴", navIcon: "🧲", navHidden: true, navOffline: false, navComp: "", dashboardName: "会话磁贴", dashboardDesc: "旧会话磁贴视图", dashboardIcon: "🧲", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "会话磁贴", toolsDesc: "旧会话磁贴视图", toolsProvider: "vssaros-sessions", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/media//vssaros-wb-media", workbenchId: "legacy:/x/media/", pageId: "vssaros-wb-media", canonicalId: "vssaros/media", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-media", "/x/media/"]), replacedBy: "vssaros/media/default", route: "/x/media/", title: "媒体库", description: "旧 route 媒体库入口", icon: "🖼️", sourceKind: "legacy", sourcePackage: "vssaros-media", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 7, directoryOrder: 7, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-media", navName: "媒体库", navIcon: "🖼️", navHidden: true, navOffline: false, navComp: "", dashboardName: "媒体库", dashboardDesc: "旧 route 媒体库入口", dashboardIcon: "🖼️", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "媒体库", toolsDesc: "旧 route 媒体库入口", toolsProvider: "vssaros-media", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/codebase//vssaros-wb-codebase", workbenchId: "legacy:/x/codebase/", pageId: "vssaros-wb-codebase", canonicalId: "vssaros/codebase", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-codebase", "/x/codebase/"]), replacedBy: "vssaros/codebase/default", route: "/x/codebase/", title: "代码库", description: "旧 route 代码库入口", icon: "🕸️", sourceKind: "legacy", sourcePackage: "vssaros-codebase", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 8, directoryOrder: 8, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-codebase", navName: "代码库", navIcon: "🕸️", navHidden: true, navOffline: false, navComp: "", dashboardName: "代码库", dashboardDesc: "旧 route 代码库入口", dashboardIcon: "🕸️", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "代码库", toolsDesc: "旧 route 代码库入口", toolsProvider: "vssaros-codebase", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/workflow//vssaros-wb-workflow", workbenchId: "legacy:/x/workflow/", pageId: "vssaros-wb-workflow", canonicalId: "vssaros/workflow", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-workflow", "/x/workflow/"]), replacedBy: "vssaros/workflow/default", route: "/x/workflow/", title: "工作流", description: "旧 route 工作流入口", icon: "🔀", sourceKind: "legacy", sourcePackage: "vssaros-workflow", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 9, directoryOrder: 9, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-workflow", navName: "工作流", navIcon: "🔀", navHidden: true, navOffline: false, navComp: "", dashboardName: "工作流", dashboardDesc: "旧 route 工作流入口", dashboardIcon: "🔀", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "工作流", toolsDesc: "旧 route 工作流入口", toolsProvider: "vssaros-workflow", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/kanban//vssaros-wb-kanban", workbenchId: "legacy:/x/kanban/", pageId: "vssaros-wb-kanban", canonicalId: "vssaros/kanban", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-kanban", "/x/kanban/"]), replacedBy: "vssaros/kanban/default", route: "/x/kanban/", title: "看板", description: "旧 route 看板入口", icon: "🗂️", sourceKind: "legacy", sourcePackage: "vssaros-kanban", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 10, directoryOrder: 10, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-kanban", navName: "看板", navIcon: "🗂️", navHidden: true, navOffline: false, navComp: "", dashboardName: "看板", dashboardDesc: "旧 route 看板入口", dashboardIcon: "🗂️", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "看板", toolsDesc: "旧 route 看板入口", toolsProvider: "vssaros-kanban", toolsOffline: false }),
			Object.freeze({ key: "offline:/x/kanban/", workbenchId: "offline:/x/kanban/", pageId: "default", canonicalId: "vssaros/kanban", state: "offline", visibility: OFFLINE_VISIBILITY, aliases: Object.freeze(["vssaros-wb-kanban", "/x/kanban/"]), replacedBy: "vssaros/kanban/default", route: "/x/kanban/", title: "看板", description: "临时下线，仅保 route", icon: "🗂️", sourceKind: "legacy", sourcePackage: "vssaros-kanban", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: false, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 11, directoryOrder: 11, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "看板", navIcon: "🗂️", navHidden: false, navOffline: true, navComp: "", dashboardName: "看板", dashboardDesc: "临时下线，仅保 route", dashboardIcon: "🗂️", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "看板", toolsDesc: "临时下线，仅保 route", toolsProvider: "vssaros-kanban", toolsOffline: true }),
			Object.freeze({ key: "offline:/x/workflow/", workbenchId: "offline:/x/workflow/", pageId: "default", canonicalId: "vssaros/workflow", state: "offline", visibility: OFFLINE_VISIBILITY, aliases: Object.freeze(["vssaros-wb-workflow", "/x/workflow/"]), replacedBy: "vssaros/workflow/default", route: "/x/workflow/", title: "工作流", description: "临时下线，仅保 route", icon: "🔀", sourceKind: "legacy", sourcePackage: "vssaros-workflow", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: false, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 12, directoryOrder: 12, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "工作流", navIcon: "🔀", navHidden: false, navOffline: true, navComp: "", dashboardName: "工作流", dashboardDesc: "临时下线，仅保 route", dashboardIcon: "🔀", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "工作流", toolsDesc: "临时下线，仅保 route", toolsProvider: "vssaros-workflow", toolsOffline: true }),
			Object.freeze({ key: "offline:/x/imagegen/", workbenchId: "offline:/x/imagegen/", pageId: "default", canonicalId: "vssaros/imagegen", state: "offline", visibility: OFFLINE_VISIBILITY, aliases: Object.freeze(["vssaros-wb-imagegen", "/x/imagegen/"]), replacedBy: "", route: "/x/imagegen/", title: "生图", description: "临时下线，仅保 route", icon: "🎨", sourceKind: "legacy", sourcePackage: "vssaros-imagegen", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: false, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 13, directoryOrder: 13, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "生图", navIcon: "🎨", navHidden: false, navOffline: true, navComp: "", dashboardName: "生图", dashboardDesc: "临时下线，仅保 route", dashboardIcon: "🎨", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "生图", toolsDesc: "临时下线，仅保 route", toolsProvider: "vssaros-imagegen", toolsOffline: true }),
			Object.freeze({ key: "offline:/x/skills/", workbenchId: "offline:/x/skills/", pageId: "default", canonicalId: "vssaros/skills", state: "offline", visibility: OFFLINE_VISIBILITY, aliases: Object.freeze(["vssaros-wb-skills", "/x/skills/"]), replacedBy: "", route: "/x/skills/", title: "工具", description: "临时下线，仅保 route", icon: "🧰", sourceKind: "legacy", sourcePackage: "vssaros-skills", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: false, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 14, directoryOrder: 14, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "工具", navIcon: "🧰", navHidden: false, navOffline: true, navComp: "", dashboardName: "工具", dashboardDesc: "临时下线，仅保 route", dashboardIcon: "🧰", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "工具", toolsDesc: "临时下线，仅保 route", toolsProvider: "vssaros-skills", toolsOffline: true }),
			Object.freeze({ key: "vssaros/loop/default", workbenchId: "vssaros/loop", pageId: "default", canonicalId: "vssaros/loop", state: "retired", visibility: RETIRED_VISIBILITY, aliases: Object.freeze(["vssaros-wb-loop"]), replacedBy: "", route: "", title: "循环任务", description: "可逆下线", icon: "🔁", sourceKind: "registered", sourcePackage: "vssaros-loop", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: false, deepLink: false, start: false, launcher: false, nativeTab: false, manifestOrder: 15, directoryOrder: 15, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "循环任务", navIcon: "🔁", navHidden: false, navOffline: false, navComp: "", dashboardName: "循环任务", dashboardDesc: "可逆下线", dashboardIcon: "🔁", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "循环任务", toolsDesc: "可逆下线", toolsProvider: "vssaros-loop", toolsOffline: false }),
			Object.freeze({ key: "manifest:/x/kb//vssaros-wb-kb", workbenchId: "manifest:/x/kb/", pageId: "vssaros-wb-kb", canonicalId: "vssaros/kb", state: "active", visibility: ACTIVE_VISIBILITY, aliases: Object.freeze(["legacy:/x/kb//vssaros-wb-kb", "vssaros-wb-kb", "/x/kb/"]), replacedBy: "", route: "/x/kb/", title: "知识库", description: "知识库索引与检索", icon: "📚", sourceKind: "manifest", sourcePackage: "vssaros-kb", component: "", manifest: true, nav: true, dashboard: true, tools: true, installed: true, fixed: true, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: true, launcher: true, nativeTab: true, manifestOrder: 16, directoryOrder: 16, navOrder: 6, dashboardOrder: 3, toolsOrder: 3, installedOrder: 6, fixedOrder: 6, navId: "vssaros-wb-kb", navName: "知识库", navIcon: "📚", navHidden: false, navOffline: false, navComp: "", dashboardName: "知识库", dashboardDesc: "知识库索引与检索", dashboardIcon: "📚", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "知识库", toolsDesc: "知识库索引与检索", toolsProvider: "vssaros-kb", toolsOffline: false }),
			Object.freeze({ key: "manifest:/x/memory//vssaros-wb-memory-tab", workbenchId: "manifest:/x/memory/", pageId: "vssaros-wb-memory-tab", canonicalId: "vssaros/memory", state: "active", visibility: ACTIVE_VISIBILITY, aliases: Object.freeze(["legacy:/x/memory//vssaros-wb-memory-tab", "vssaros-wb-memory-tab", "memory", "/x/memory/"]), replacedBy: "", route: "/x/memory/", title: "记忆", description: "分层记忆 / 待确认建议 / 工作区作用域", icon: "🧠", sourceKind: "manifest", sourcePackage: "vssaros-memory", component: "memory", manifest: true, nav: true, dashboard: true, tools: false, installed: true, fixed: true, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: true, launcher: true, nativeTab: true, manifestOrder: 17, directoryOrder: 17, navOrder: 7, dashboardOrder: 4, toolsOrder: 999, installedOrder: 7, fixedOrder: 7, navId: "vssaros-wb-memory-tab", navName: "记忆", navIcon: "🧠", navHidden: false, navOffline: false, navComp: "memory", dashboardName: "记忆", dashboardDesc: "分层记忆 / 待确认建议 / 工作区作用域（会话页记忆 Tab 同源）", dashboardIcon: "🧠", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "记忆", toolsDesc: "分层记忆 / 待确认建议 / 工作区作用域", toolsProvider: "vssaros-memory", toolsOffline: false }),
			Object.freeze({ key: "manifest:/x/marketplace//vssaros-wb-marketplace", workbenchId: "manifest:/x/marketplace/", pageId: "vssaros-wb-marketplace", canonicalId: "vssaros/marketplace", state: "active", visibility: ACTIVE_VISIBILITY, aliases: Object.freeze(["legacy:/x/marketplace//vssaros-wb-marketplace", "vssaros-wb-marketplace", "/x/marketplace/"]), replacedBy: "", route: "/x/marketplace/", title: "商城", description: "Agent / Skill / 工作台 / 工作流的安装与发布", icon: "🛒", sourceKind: "manifest", sourcePackage: "vssaros-marketplace", component: "", manifest: true, nav: true, dashboard: true, tools: true, installed: true, fixed: true, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: true, launcher: true, nativeTab: true, manifestOrder: 18, directoryOrder: 18, navOrder: 13, dashboardOrder: 10, toolsOrder: 11, installedOrder: 13, fixedOrder: 13, navId: "vssaros-wb-marketplace", navName: "商城", navIcon: "🛒", navHidden: false, navOffline: false, navComp: "", dashboardName: "商城", dashboardDesc: "Agent / Skill / 工作台 / 工作流的安装与发布", dashboardIcon: "🛒", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "商城", toolsDesc: "技能 / 工作台 / 工作流的安装与发布", toolsProvider: "vssaros-marketplace", toolsOffline: false }),
			Object.freeze({ key: "vssaros/kb/default", workbenchId: "vssaros/kb", pageId: "default", canonicalId: "vssaros/kb", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-kb"]), replacedBy: "", route: "/x/kb/", title: "知识库", description: "注册式知识库（开始页隐藏）", icon: "📚", sourceKind: "registered", sourcePackage: "vssaros-kb", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 19, directoryOrder: 19, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "知识库", navIcon: "📚", navHidden: true, navOffline: false, navComp: "", dashboardName: "知识库", dashboardDesc: "注册式知识库（开始页隐藏）", dashboardIcon: "📚", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "知识库", toolsDesc: "注册式知识库（开始页隐藏）", toolsProvider: "vssaros-kb", toolsOffline: false }),
			Object.freeze({ key: "vssaros/studio/default", workbenchId: "vssaros/studio", pageId: "default", canonicalId: "vssaros/studio", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze([]), replacedBy: "", route: "", title: "萨罗斯管理平台", description: "已下线（开始页隐藏）", icon: "🌐", sourceKind: "registered", sourcePackage: "@vssaros/dsh-studio", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: false, deepLink: false, start: false, launcher: false, nativeTab: false, manifestOrder: 20, directoryOrder: 20, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "萨罗斯管理平台", navIcon: "🌐", navHidden: true, navOffline: false, navComp: "", dashboardName: "萨罗斯管理平台", dashboardDesc: "已下线（开始页隐藏）", dashboardIcon: "🌐", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "萨罗斯管理平台", toolsDesc: "已下线（开始页隐藏）", toolsProvider: "@vssaros/dsh-studio", toolsOffline: false }),
		]);
		const WORK_DIRECTORY_ROWS = Object.freeze([
			Object.freeze({ key: "vssaros/marketplace/default", workbenchId: "vssaros/marketplace", pageId: "default", canonicalId: "vssaros/marketplace", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-marketplace"]), replacedBy: "legacy:/x/marketplace//vssaros-wb-marketplace", route: "/x/marketplace/", title: "商城工作台", description: "注册式商城工作台（开始页隐藏）", icon: "🛒", sourceKind: "registered", sourcePackage: "vssaros-marketplace", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 1, directoryOrder: 1, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "商城工作台", navIcon: "🛒", navHidden: true, navOffline: false, navComp: "", dashboardName: "商城工作台", dashboardDesc: "注册式商城工作台（开始页隐藏）", dashboardIcon: "🛒", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "商城工作台", toolsDesc: "注册式商城工作台（开始页隐藏）", toolsProvider: "vssaros-marketplace", toolsOffline: false }),
			Object.freeze({ key: "vssaros/sessions/default", workbenchId: "vssaros/sessions", pageId: "default", canonicalId: "vssaros/sessions", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-sessions"]), replacedBy: "", route: "/x/sessions/", title: "历史会话", description: "注册式历史会话（开始页隐藏）", icon: "🕘", sourceKind: "registered", sourcePackage: "vssaros-sessions", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 2, directoryOrder: 2, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "历史会话", navIcon: "🕘", navHidden: true, navOffline: false, navComp: "", dashboardName: "历史会话", dashboardDesc: "注册式历史会话（开始页隐藏）", dashboardIcon: "🕘", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "历史会话", toolsDesc: "注册式历史会话（开始页隐藏）", toolsProvider: "vssaros-sessions", toolsOffline: false }),
			Object.freeze({ key: "vssaros/workflow/default", workbenchId: "vssaros/workflow", pageId: "default", canonicalId: "vssaros/workflow", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-workflow"]), replacedBy: "", route: "/x/workflow/", title: "Workflow", description: "注册式工作流（开始页隐藏）", icon: "⚙", sourceKind: "registered", sourcePackage: "vssaros-workflow", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 3, directoryOrder: 3, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "Workflow", navIcon: "⚙", navHidden: true, navOffline: false, navComp: "", dashboardName: "Workflow", dashboardDesc: "注册式工作流（开始页隐藏）", dashboardIcon: "⚙", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "Workflow", toolsDesc: "注册式工作流（开始页隐藏）", toolsProvider: "vssaros-workflow", toolsOffline: false }),
			Object.freeze({ key: "vssaros/kanban/default", workbenchId: "vssaros/kanban", pageId: "default", canonicalId: "vssaros/kanban", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-kanban"]), replacedBy: "", route: "/x/kanban/", title: "Tasks", description: "注册式看板（开始页隐藏）", icon: "🗂", sourceKind: "registered", sourcePackage: "vssaros-kanban", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 4, directoryOrder: 4, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "Tasks", navIcon: "🗂", navHidden: true, navOffline: false, navComp: "", dashboardName: "Tasks", dashboardDesc: "注册式看板（开始页隐藏）", dashboardIcon: "🗂", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "Tasks", toolsDesc: "注册式看板（开始页隐藏）", toolsProvider: "vssaros-kanban", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/sessions//vssaros-wb-sessions", workbenchId: "legacy:/x/sessions/", pageId: "vssaros-wb-sessions", canonicalId: "vssaros/sessions", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-sessions", "/x/sessions/"]), replacedBy: "", route: "/x/sessions/", title: "会话", description: "旧 route 会话入口", icon: "💬", sourceKind: "legacy", sourcePackage: "vssaros-sessions", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 5, directoryOrder: 5, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-sessions", navName: "会话", navIcon: "💬", navHidden: true, navOffline: false, navComp: "", dashboardName: "会话", dashboardDesc: "旧 route 会话入口", dashboardIcon: "💬", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "会话", toolsDesc: "旧 route 会话入口", toolsProvider: "vssaros-sessions", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/sessions/?view=tiles/vssaros-wb-session-tiles", workbenchId: "legacy:/x/sessions/?view=tiles", pageId: "vssaros-wb-session-tiles", canonicalId: "vssaros/sessions", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-session-tiles", "/x/sessions/?view=tiles"]), replacedBy: "", route: "/x/sessions/?view=tiles", title: "会话磁贴", description: "旧会话磁贴视图", icon: "🧲", sourceKind: "legacy", sourcePackage: "vssaros-sessions", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 6, directoryOrder: 6, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-session-tiles", navName: "会话磁贴", navIcon: "🧲", navHidden: true, navOffline: false, navComp: "", dashboardName: "会话磁贴", dashboardDesc: "旧会话磁贴视图", dashboardIcon: "🧲", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "会话磁贴", toolsDesc: "旧会话磁贴视图", toolsProvider: "vssaros-sessions", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/media//vssaros-wb-media", workbenchId: "legacy:/x/media/", pageId: "vssaros-wb-media", canonicalId: "vssaros/media", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-media", "/x/media/"]), replacedBy: "vssaros/media/default", route: "/x/media/", title: "媒体库", description: "旧 route 媒体库入口", icon: "🖼️", sourceKind: "legacy", sourcePackage: "vssaros-media", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 7, directoryOrder: 7, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-media", navName: "媒体库", navIcon: "🖼️", navHidden: true, navOffline: false, navComp: "", dashboardName: "媒体库", dashboardDesc: "旧 route 媒体库入口", dashboardIcon: "🖼️", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "媒体库", toolsDesc: "旧 route 媒体库入口", toolsProvider: "vssaros-media", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/codebase//vssaros-wb-codebase", workbenchId: "legacy:/x/codebase/", pageId: "vssaros-wb-codebase", canonicalId: "vssaros/codebase", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-codebase", "/x/codebase/"]), replacedBy: "vssaros/codebase/default", route: "/x/codebase/", title: "代码库", description: "旧 route 代码库入口", icon: "🕸️", sourceKind: "legacy", sourcePackage: "vssaros-codebase", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 8, directoryOrder: 8, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-codebase", navName: "代码库", navIcon: "🕸️", navHidden: true, navOffline: false, navComp: "", dashboardName: "代码库", dashboardDesc: "旧 route 代码库入口", dashboardIcon: "🕸️", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "代码库", toolsDesc: "旧 route 代码库入口", toolsProvider: "vssaros-codebase", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/workflow//vssaros-wb-workflow", workbenchId: "legacy:/x/workflow/", pageId: "vssaros-wb-workflow", canonicalId: "vssaros/workflow", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-workflow", "/x/workflow/"]), replacedBy: "vssaros/workflow/default", route: "/x/workflow/", title: "工作流", description: "旧 route 工作流入口", icon: "🔀", sourceKind: "legacy", sourcePackage: "vssaros-workflow", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 9, directoryOrder: 9, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-workflow", navName: "工作流", navIcon: "🔀", navHidden: true, navOffline: false, navComp: "", dashboardName: "工作流", dashboardDesc: "旧 route 工作流入口", dashboardIcon: "🔀", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "工作流", toolsDesc: "旧 route 工作流入口", toolsProvider: "vssaros-workflow", toolsOffline: false }),
			Object.freeze({ key: "legacy:/x/kanban//vssaros-wb-kanban", workbenchId: "legacy:/x/kanban/", pageId: "vssaros-wb-kanban", canonicalId: "vssaros/kanban", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-kanban", "/x/kanban/"]), replacedBy: "vssaros/kanban/default", route: "/x/kanban/", title: "看板", description: "旧 route 看板入口", icon: "🗂️", sourceKind: "legacy", sourcePackage: "vssaros-kanban", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 10, directoryOrder: 10, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-kanban", navName: "看板", navIcon: "🗂️", navHidden: true, navOffline: false, navComp: "", dashboardName: "看板", dashboardDesc: "旧 route 看板入口", dashboardIcon: "🗂️", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "看板", toolsDesc: "旧 route 看板入口", toolsProvider: "vssaros-kanban", toolsOffline: false }),
			Object.freeze({ key: "offline:/x/kanban/", workbenchId: "offline:/x/kanban/", pageId: "default", canonicalId: "vssaros/kanban", state: "offline", visibility: OFFLINE_VISIBILITY, aliases: Object.freeze(["vssaros-wb-kanban", "/x/kanban/"]), replacedBy: "vssaros/kanban/default", route: "/x/kanban/", title: "看板", description: "临时下线，仅保 route", icon: "🗂️", sourceKind: "legacy", sourcePackage: "vssaros-kanban", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: false, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 11, directoryOrder: 11, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "看板", navIcon: "🗂️", navHidden: false, navOffline: true, navComp: "", dashboardName: "看板", dashboardDesc: "临时下线，仅保 route", dashboardIcon: "🗂️", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "看板", toolsDesc: "临时下线，仅保 route", toolsProvider: "vssaros-kanban", toolsOffline: true }),
			Object.freeze({ key: "offline:/x/workflow/", workbenchId: "offline:/x/workflow/", pageId: "default", canonicalId: "vssaros/workflow", state: "offline", visibility: OFFLINE_VISIBILITY, aliases: Object.freeze(["vssaros-wb-workflow", "/x/workflow/"]), replacedBy: "vssaros/workflow/default", route: "/x/workflow/", title: "工作流", description: "临时下线，仅保 route", icon: "🔀", sourceKind: "legacy", sourcePackage: "vssaros-workflow", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: false, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 12, directoryOrder: 12, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "工作流", navIcon: "🔀", navHidden: false, navOffline: true, navComp: "", dashboardName: "工作流", dashboardDesc: "临时下线，仅保 route", dashboardIcon: "🔀", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "工作流", toolsDesc: "临时下线，仅保 route", toolsProvider: "vssaros-workflow", toolsOffline: true }),
			Object.freeze({ key: "offline:/x/imagegen/", workbenchId: "offline:/x/imagegen/", pageId: "default", canonicalId: "vssaros/imagegen", state: "offline", visibility: OFFLINE_VISIBILITY, aliases: Object.freeze(["vssaros-wb-imagegen", "/x/imagegen/"]), replacedBy: "", route: "/x/imagegen/", title: "生图", description: "临时下线，仅保 route", icon: "🎨", sourceKind: "legacy", sourcePackage: "vssaros-imagegen", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: false, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 13, directoryOrder: 13, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "生图", navIcon: "🎨", navHidden: false, navOffline: true, navComp: "", dashboardName: "生图", dashboardDesc: "临时下线，仅保 route", dashboardIcon: "🎨", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "生图", toolsDesc: "临时下线，仅保 route", toolsProvider: "vssaros-imagegen", toolsOffline: true }),
			Object.freeze({ key: "offline:/x/skills/", workbenchId: "offline:/x/skills/", pageId: "default", canonicalId: "vssaros/skills", state: "offline", visibility: OFFLINE_VISIBILITY, aliases: Object.freeze(["vssaros-wb-skills", "/x/skills/"]), replacedBy: "", route: "/x/skills/", title: "工具", description: "临时下线，仅保 route", icon: "🧰", sourceKind: "legacy", sourcePackage: "vssaros-skills", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: false, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 14, directoryOrder: 14, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "工具", navIcon: "🧰", navHidden: false, navOffline: true, navComp: "", dashboardName: "工具", dashboardDesc: "临时下线，仅保 route", dashboardIcon: "🧰", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "工具", toolsDesc: "临时下线，仅保 route", toolsProvider: "vssaros-skills", toolsOffline: true }),
			Object.freeze({ key: "vssaros/loop/default", workbenchId: "vssaros/loop", pageId: "default", canonicalId: "vssaros/loop", state: "retired", visibility: RETIRED_VISIBILITY, aliases: Object.freeze(["vssaros-wb-loop"]), replacedBy: "", route: "", title: "循环任务", description: "可逆下线", icon: "🔁", sourceKind: "registered", sourcePackage: "vssaros-loop", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: false, deepLink: false, start: false, launcher: false, nativeTab: false, manifestOrder: 15, directoryOrder: 15, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "循环任务", navIcon: "🔁", navHidden: false, navOffline: false, navComp: "", dashboardName: "循环任务", dashboardDesc: "可逆下线", dashboardIcon: "🔁", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "循环任务", toolsDesc: "可逆下线", toolsProvider: "vssaros-loop", toolsOffline: false }),
			Object.freeze({ key: "manifest:/x/kb//vssaros-wb-kb", workbenchId: "manifest:/x/kb/", pageId: "vssaros-wb-kb", canonicalId: "vssaros/kb", state: "active", visibility: ACTIVE_VISIBILITY, aliases: Object.freeze(["legacy:/x/kb//vssaros-wb-kb", "vssaros-wb-kb", "/x/kb/"]), replacedBy: "", route: "/x/kb/", title: "知识库", description: "知识库索引与检索", icon: "📚", sourceKind: "manifest", sourcePackage: "vssaros-kb", component: "", manifest: true, nav: true, dashboard: true, tools: true, installed: true, fixed: true, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: true, launcher: true, nativeTab: true, manifestOrder: 16, directoryOrder: 16, navOrder: 6, dashboardOrder: 3, toolsOrder: 3, installedOrder: 6, fixedOrder: 6, navId: "vssaros-wb-kb", navName: "知识库", navIcon: "📚", navHidden: false, navOffline: false, navComp: "", dashboardName: "知识库", dashboardDesc: "知识库索引与检索", dashboardIcon: "📚", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "知识库", toolsDesc: "知识库索引与检索", toolsProvider: "vssaros-kb", toolsOffline: false }),
			Object.freeze({ key: "manifest:/x/memory//vssaros-wb-memory-tab", workbenchId: "manifest:/x/memory/", pageId: "vssaros-wb-memory-tab", canonicalId: "vssaros/memory", state: "active", visibility: ACTIVE_VISIBILITY, aliases: Object.freeze(["legacy:/x/memory//vssaros-wb-memory-tab", "vssaros-wb-memory-tab", "memory", "/x/memory/"]), replacedBy: "", route: "/x/memory/", title: "记忆", description: "分层记忆 / 待确认建议 / 工作区作用域", icon: "🧠", sourceKind: "manifest", sourcePackage: "vssaros-memory", component: "memory", manifest: true, nav: true, dashboard: true, tools: false, installed: true, fixed: true, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: true, launcher: true, nativeTab: true, manifestOrder: 17, directoryOrder: 17, navOrder: 7, dashboardOrder: 4, toolsOrder: 999, installedOrder: 7, fixedOrder: 7, navId: "vssaros-wb-memory-tab", navName: "记忆", navIcon: "🧠", navHidden: false, navOffline: false, navComp: "memory", dashboardName: "记忆", dashboardDesc: "分层记忆 / 待确认建议 / 工作区作用域（会话页记忆 Tab 同源）", dashboardIcon: "🧠", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "记忆", toolsDesc: "分层记忆 / 待确认建议 / 工作区作用域", toolsProvider: "vssaros-memory", toolsOffline: false }),
			Object.freeze({ key: "manifest:/x/marketplace//vssaros-wb-marketplace", workbenchId: "manifest:/x/marketplace/", pageId: "vssaros-wb-marketplace", canonicalId: "vssaros/marketplace", state: "active", visibility: ACTIVE_VISIBILITY, aliases: Object.freeze(["legacy:/x/marketplace//vssaros-wb-marketplace", "vssaros-wb-marketplace", "/x/marketplace/"]), replacedBy: "", route: "/x/marketplace/", title: "商城", description: "Agent / Skill / 工作台 / 工作流的安装与发布", icon: "🛒", sourceKind: "manifest", sourcePackage: "vssaros-marketplace", component: "", manifest: true, nav: true, dashboard: true, tools: true, installed: true, fixed: true, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: true, launcher: true, nativeTab: true, manifestOrder: 18, directoryOrder: 18, navOrder: 13, dashboardOrder: 10, toolsOrder: 11, installedOrder: 13, fixedOrder: 13, navId: "vssaros-wb-marketplace", navName: "商城", navIcon: "🛒", navHidden: false, navOffline: false, navComp: "", dashboardName: "商城", dashboardDesc: "Agent / Skill / 工作台 / 工作流的安装与发布", dashboardIcon: "🛒", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "商城", toolsDesc: "技能 / 工作台 / 工作流的安装与发布", toolsProvider: "vssaros-marketplace", toolsOffline: false }),
			Object.freeze({ key: "vssaros/kb/default", workbenchId: "vssaros/kb", pageId: "default", canonicalId: "vssaros/kb", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze(["vssaros-wb-kb"]), replacedBy: "", route: "/x/kb/", title: "知识库", description: "注册式知识库（开始页隐藏）", icon: "📚", sourceKind: "registered", sourcePackage: "vssaros-kb", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: true, manifestOrder: 19, directoryOrder: 19, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "知识库", navIcon: "📚", navHidden: true, navOffline: false, navComp: "", dashboardName: "知识库", dashboardDesc: "注册式知识库（开始页隐藏）", dashboardIcon: "📚", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "知识库", toolsDesc: "注册式知识库（开始页隐藏）", toolsProvider: "vssaros-kb", toolsOffline: false }),
			Object.freeze({ key: "vssaros/studio/default", workbenchId: "vssaros/studio", pageId: "default", canonicalId: "vssaros/studio", state: "hidden", visibility: HIDDEN_VISIBILITY, aliases: Object.freeze([]), replacedBy: "", route: "", title: "萨罗斯管理平台", description: "已下线（开始页隐藏）", icon: "🌐", sourceKind: "registered", sourcePackage: "@vssaros/dsh-studio", component: "", manifest: true, nav: false, dashboard: false, tools: false, installed: false, fixed: false, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: false, deepLink: false, start: false, launcher: false, nativeTab: false, manifestOrder: 20, directoryOrder: 20, navOrder: 999, dashboardOrder: 999, toolsOrder: 999, installedOrder: 999, fixedOrder: 999, navId: "default", navName: "萨罗斯管理平台", navIcon: "🌐", navHidden: true, navOffline: false, navComp: "", dashboardName: "萨罗斯管理平台", dashboardDesc: "已下线（开始页隐藏）", dashboardIcon: "🌐", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "萨罗斯管理平台", toolsDesc: "已下线（开始页隐藏）", toolsProvider: "@vssaros/dsh-studio", toolsOffline: false }),
			Object.freeze({ key: "directory:/x/dashboard//vssaros-wb-dashboard", workbenchId: "directory:/x/dashboard/", pageId: "vssaros-wb-dashboard", canonicalId: "vssaros/dashboard", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["legacy:/x/dashboard//vssaros-wb-dashboard", "vssaros-wb-dashboard", "/x/dashboard/"]), replacedBy: "", route: "/x/dashboard/", title: "主页", description: "会话遥测 / 用量与编排", icon: "🏠", sourceKind: "directory", sourcePackage: "vssaros-dashboard", component: "", manifest: false, nav: true, dashboard: true, tools: true, installed: true, fixed: true, hidden: false, offline: false, alwaysPinned: true, routeWhitelist: true, deepLink: true, start: false, launcher: true, nativeTab: false, manifestOrder: 999, directoryOrder: 101, navOrder: 1, dashboardOrder: 1, toolsOrder: 1, installedOrder: 1, fixedOrder: 1, navId: "vssaros-wb-dashboard", navName: "主页", navIcon: "🏠", navHidden: false, navOffline: false, navComp: "", dashboardName: "主页", dashboardDesc: "会话遥测 / 用量与编排", dashboardIcon: "🏠", dashboardOffline: false, dashboardAlwaysPinned: true, toolsName: "主页", toolsDesc: "会话遥测 / 用量与编排", toolsProvider: "vssaros-dashboard", toolsOffline: false }),
			Object.freeze({ key: "directory:/x/sessions//vssaros-wb-sessions", workbenchId: "directory:/x/sessions/", pageId: "vssaros-wb-sessions", canonicalId: "vssaros/sessions", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["legacy:/x/sessions//vssaros-wb-sessions", "vssaros-wb-sessions", "/x/sessions/"]), replacedBy: "", route: "/x/sessions/", title: "会话", description: "会话分组 / 人格标记 / 指示灯", icon: "💬", sourceKind: "directory", sourcePackage: "vssaros-sessions", component: "", manifest: false, nav: true, dashboard: true, tools: true, installed: true, fixed: true, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: true, nativeTab: false, manifestOrder: 999, directoryOrder: 102, navOrder: 2, dashboardOrder: 11, toolsOrder: 5, installedOrder: 2, fixedOrder: 2, navId: "vssaros-wb-sessions", navName: "会话", navIcon: "💬", navHidden: false, navOffline: false, navComp: "", dashboardName: "历史会话", dashboardDesc: "会话分组 / 人格标记 / 指示灯", dashboardIcon: "🕘", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "历史会话", toolsDesc: "会话分组 / 人格标记 / 指示灯", toolsProvider: "vssaros-sessions", toolsOffline: false }),
			Object.freeze({ key: "directory:/x/sessions/?view=tiles/vssaros-wb-session-tiles", workbenchId: "directory:/x/sessions/?view=tiles", pageId: "vssaros-wb-session-tiles", canonicalId: "vssaros/sessions", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["legacy:/x/sessions/?view=tiles/vssaros-wb-session-tiles", "vssaros-wb-session-tiles", "/x/sessions/?view=tiles"]), replacedBy: "", route: "/x/sessions/?view=tiles", title: "会话磁贴", description: "会话磁贴矩阵", icon: "🧲", sourceKind: "directory", sourcePackage: "vssaros-sessions", component: "", manifest: false, nav: true, dashboard: false, tools: false, installed: true, fixed: true, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: true, nativeTab: false, manifestOrder: 999, directoryOrder: 103, navOrder: 3, dashboardOrder: 999, toolsOrder: 999, installedOrder: 3, fixedOrder: 3, navId: "vssaros-wb-session-tiles", navName: "会话磁贴", navIcon: "🧲", navHidden: false, navOffline: false, navComp: "", dashboardName: "会话磁贴", dashboardDesc: "会话磁贴矩阵", dashboardIcon: "🧲", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "会话磁贴", toolsDesc: "会话磁贴矩阵", toolsProvider: "vssaros-sessions", toolsOffline: false }),
			Object.freeze({ key: "directory:/x/kanban//vssaros-wb-kanban", workbenchId: "directory:/x/kanban/", pageId: "vssaros-wb-kanban", canonicalId: "vssaros/kanban", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["legacy:/x/kanban//vssaros-wb-kanban", "vssaros-wb-kanban", "/x/kanban/"]), replacedBy: "", route: "/x/kanban/", title: "看板", description: "看板存储与卡片工具", icon: "🗂️", sourceKind: "directory", sourcePackage: "vssaros-kanban", component: "", manifest: false, nav: true, dashboard: true, tools: true, installed: true, fixed: true, hidden: true, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 999, directoryOrder: 104, navOrder: 4, dashboardOrder: 2, toolsOrder: 2, installedOrder: 4, fixedOrder: 4, navId: "vssaros-wb-kanban", navName: "看板", navIcon: "🗂️", navHidden: true, navOffline: true, navComp: "", dashboardName: "看板", dashboardDesc: "看板存储与卡片工具", dashboardIcon: "🗂", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "看板", toolsDesc: "看板存储与卡片工具", toolsProvider: "vssaros-kanban", toolsOffline: true }),
			Object.freeze({ key: "directory:/x/workflow//vssaros-wb-workflow", workbenchId: "directory:/x/workflow/", pageId: "vssaros-wb-workflow", canonicalId: "vssaros/workflow", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["legacy:/x/workflow//vssaros-wb-workflow", "vssaros-wb-workflow", "/x/workflow/"]), replacedBy: "", route: "/x/workflow/", title: "工作流", description: "工作流引擎与画布", icon: "🔀", sourceKind: "directory", sourcePackage: "vssaros-workflow", component: "", manifest: false, nav: true, dashboard: true, tools: true, installed: true, fixed: true, hidden: true, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 999, directoryOrder: 105, navOrder: 5, dashboardOrder: 9, toolsOrder: 9, installedOrder: 5, fixedOrder: 5, navId: "vssaros-wb-workflow", navName: "工作流", navIcon: "🔀", navHidden: true, navOffline: true, navComp: "", dashboardName: "流程", dashboardDesc: "工作流引擎与画布", dashboardIcon: "⚙", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "流程", toolsDesc: "工作流引擎与画布", toolsProvider: "vssaros-workflow", toolsOffline: true }),
			Object.freeze({ key: "directory:/x/codebase//vssaros-wb-codebase", workbenchId: "directory:/x/codebase/", pageId: "vssaros-wb-codebase", canonicalId: "vssaros/codebase", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["legacy:/x/codebase//vssaros-wb-codebase", "vssaros-wb-codebase", "/x/codebase/"]), replacedBy: "", route: "/x/codebase/", title: "代码库", description: "代码图谱与符号检索", icon: "🕸️", sourceKind: "directory", sourcePackage: "vssaros-codebase", component: "", manifest: false, nav: true, dashboard: true, tools: true, installed: true, fixed: true, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: true, nativeTab: false, manifestOrder: 999, directoryOrder: 106, navOrder: 8, dashboardOrder: 5, toolsOrder: 4, installedOrder: 8, fixedOrder: 8, navId: "vssaros-wb-codebase", navName: "代码库", navIcon: "🕸️", navHidden: false, navOffline: false, navComp: "", dashboardName: "代码库", dashboardDesc: "代码图谱与符号检索", dashboardIcon: "🕸", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "代码库", toolsDesc: "代码图谱与符号检索", toolsProvider: "vssaros-codebase", toolsOffline: false }),
			Object.freeze({ key: "directory:/x/media//vssaros-wb-media", workbenchId: "directory:/x/media/", pageId: "vssaros-wb-media", canonicalId: "vssaros/media", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["legacy:/x/media//vssaros-wb-media", "vssaros-wb-media", "/x/media/"]), replacedBy: "", route: "/x/media/", title: "媒体库", description: "只读 media.db 页面", icon: "🖼️", sourceKind: "directory", sourcePackage: "vssaros-media", component: "", manifest: false, nav: true, dashboard: true, tools: true, installed: true, fixed: true, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: true, nativeTab: false, manifestOrder: 999, directoryOrder: 107, navOrder: 9, dashboardOrder: 6, toolsOrder: 6, installedOrder: 9, fixedOrder: 9, navId: "vssaros-wb-media", navName: "媒体库", navIcon: "🖼️", navHidden: false, navOffline: false, navComp: "", dashboardName: "媒体库", dashboardDesc: "只读 media.db 页面", dashboardIcon: "🎬", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "媒体库", toolsDesc: "只读 media.db 页面", toolsProvider: "vssaros-media", toolsOffline: false }),
			Object.freeze({ key: "directory:/x/imagegen//vssaros-wb-imagegen", workbenchId: "directory:/x/imagegen/", pageId: "vssaros-wb-imagegen", canonicalId: "vssaros/imagegen", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["legacy:/x/imagegen//vssaros-wb-imagegen", "vssaros-wb-imagegen", "/x/imagegen/"]), replacedBy: "", route: "/x/imagegen/", title: "生图", description: "生图工作台 / 最近出图画廊", icon: "🎨", sourceKind: "directory", sourcePackage: "vssaros-imagegen", component: "", manifest: false, nav: true, dashboard: true, tools: false, installed: true, fixed: true, hidden: true, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 999, directoryOrder: 108, navOrder: 10, dashboardOrder: 7, toolsOrder: 999, installedOrder: 10, fixedOrder: 10, navId: "vssaros-wb-imagegen", navName: "生图", navIcon: "🎨", navHidden: true, navOffline: true, navComp: "", dashboardName: "生图", dashboardDesc: "生图工作台 / 最近出图画廊", dashboardIcon: "🎨", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "生图", toolsDesc: "生图工作台 / 最近出图画廊", toolsProvider: "vssaros-imagegen", toolsOffline: true }),
			Object.freeze({ key: "directory:/x/skills//vssaros-wb-skills", workbenchId: "directory:/x/skills/", pageId: "vssaros-wb-skills", canonicalId: "vssaros/skills", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["legacy:/x/skills//vssaros-wb-skills", "vssaros-wb-skills", "/x/skills/"]), replacedBy: "", route: "/x/skills/", title: "工具", description: "技能、工具、mcp、agent、工作流、工作台", icon: "🧰", sourceKind: "directory", sourcePackage: "vssaros-skills", component: "", manifest: false, nav: true, dashboard: true, tools: true, installed: true, fixed: true, hidden: true, offline: true, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 999, directoryOrder: 109, navOrder: 11, dashboardOrder: 8, toolsOrder: 7, installedOrder: 11, fixedOrder: 11, navId: "vssaros-wb-skills", navName: "工具", navIcon: "🧰", navHidden: true, navOffline: true, navComp: "", dashboardName: "工具", dashboardDesc: "技能、工具、mcp、agent、工作流、工作台", dashboardIcon: "🧩", dashboardOffline: true, dashboardAlwaysPinned: false, toolsName: "工具", toolsDesc: "技能 / 连接器 / 工作流 / Agent（本页）", toolsProvider: "vssaros-skills", toolsOffline: true }),
			Object.freeze({ key: "directory:/x/scheduler//vssaros-wb-scheduler", workbenchId: "directory:/x/scheduler/", pageId: "vssaros-wb-scheduler", canonicalId: "vssaros/scheduler", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["legacy:/x/scheduler//vssaros-wb-scheduler", "vssaros-wb-scheduler", "/x/scheduler/"]), replacedBy: "", route: "/x/scheduler/", title: "自动化任务", description: "按计划自动运行 Agent；原生任务页（搜索 / 筛选 / 详情 / 投递历史）", icon: "🕒", sourceKind: "directory", sourcePackage: "vssaros-scheduler", component: "", manifest: false, nav: true, dashboard: true, tools: false, installed: true, fixed: true, hidden: true, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 999, directoryOrder: 110, navOrder: 12, dashboardOrder: 12, toolsOrder: 999, installedOrder: 12, fixedOrder: 12, navId: "vssaros-wb-scheduler", navName: "自动化任务", navIcon: "🕒", navHidden: true, navOffline: false, navComp: "", dashboardName: "自动化任务", dashboardDesc: "按计划自动运行 Agent；原生任务页（搜索 / 筛选 / 详情 / 投递历史）", dashboardIcon: "⏰", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "自动化任务", toolsDesc: "按计划自动运行 Agent；原生任务页（搜索 / 筛选 / 详情 / 投递历史）", toolsProvider: "vssaros-scheduler", toolsOffline: false }),
			Object.freeze({ key: "directory:/x/mcp//vssaros-wb-mcp", workbenchId: "directory:/x/mcp/", pageId: "vssaros-wb-mcp", canonicalId: "vssaros/mcp", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["/x/mcp/"]), replacedBy: "", route: "/x/mcp/", title: "MCP", description: "MCP 服务器与工具", icon: "🔌", sourceKind: "directory", sourcePackage: "vssaros-mcp", component: "", manifest: false, nav: false, dashboard: false, tools: true, installed: false, fixed: false, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 999, directoryOrder: 111, navOrder: 999, dashboardOrder: 999, toolsOrder: 8, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-mcp", navName: "MCP", navIcon: "🔌", navHidden: false, navOffline: false, navComp: "", dashboardName: "MCP", dashboardDesc: "MCP 服务器与工具", dashboardIcon: "🔌", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "MCP", toolsDesc: "MCP 服务器与工具", toolsProvider: "vssaros-mcp", toolsOffline: false }),
			Object.freeze({ key: "directory:/x/agents//vssaros-wb-agents", workbenchId: "directory:/x/agents/", pageId: "vssaros-wb-agents", canonicalId: "vssaros/agents", state: "active", visibility: ROUTE_VISIBILITY, aliases: Object.freeze(["/x/agents/"]), replacedBy: "", route: "/x/agents/", title: "Agent", description: ".agent.md → dsh preset", icon: "🤖", sourceKind: "directory", sourcePackage: "vssaros-agents", component: "", manifest: false, nav: false, dashboard: false, tools: true, installed: false, fixed: false, hidden: false, offline: false, alwaysPinned: false, routeWhitelist: true, deepLink: true, start: false, launcher: false, nativeTab: false, manifestOrder: 999, directoryOrder: 112, navOrder: 999, dashboardOrder: 999, toolsOrder: 10, installedOrder: 999, fixedOrder: 999, navId: "vssaros-wb-agents", navName: "Agent", navIcon: "🤖", navHidden: false, navOffline: false, navComp: "", dashboardName: "Agent", dashboardDesc: ".agent.md → dsh preset", dashboardIcon: "🤖", dashboardOffline: false, dashboardAlwaysPinned: false, toolsName: "Agent", toolsDesc: ".agent.md → dsh preset", toolsProvider: "vssaros-agents", toolsOffline: false }),
		]);
/* @generated-workbench-directory:end workbenches-client */

		const hiddenRows = WORKBENCH_MANIFEST.filter(row => row.state === 'hidden');
		const HOME_HIDDEN_PAGE_KEYS = new Set(hiddenRows.map(row => row.key));
		const HOME_HIDDEN_WORKBENCH_IDS = new Set(hiddenRows.map(row => row.workbenchId));
		const RETIRED_WORKBENCH_IDS = WORKBENCH_MANIFEST.filter(row => row.state === 'retired').map(row => row.workbenchId);
		const OFFLINE_WORKBENCH_ROUTES = WORKBENCH_MANIFEST.filter(row => row.state === 'offline').map(row => row.route);
		function workbenchManifest() { return WORKBENCH_MANIFEST; }
		function manifestViewsOf() {
			return Object.freeze({
				hiddenPageKeys: Object.freeze([...HOME_HIDDEN_PAGE_KEYS]),
				hiddenWorkbenchIds: Object.freeze([...HOME_HIDDEN_WORKBENCH_IDS]),
				retiredWorkbenchIds: Object.freeze([...RETIRED_WORKBENCH_IDS]),
				offlineRoutes: Object.freeze([...OFFLINE_WORKBENCH_ROUTES]),
			});
		}
		/** 阶段 3：给其它 chunk 的统一策略视图；全部为只读 key/route 数组。 */
		function catalogPolicyProbeOf(pages) {
			const list = Array.isArray(pages) ? pages : [];
			return Object.freeze({
				startPages: Object.freeze(selectStartPages(list).map(page => page.key)),
				launcherPages: Object.freeze(selectLauncherPages(list).map(page => page.key)),
				nativeTabPages: Object.freeze(selectNativeTabPages(list).map(page => page.key)),
				routeWhitelist: Object.freeze(selectRouteWhitelist(list).map(page => page.route)),
				hiddenWorkbenchIds: Object.freeze([...HOME_HIDDEN_WORKBENCH_IDS]),
				retiredWorkbenchIds: Object.freeze([...RETIRED_WORKBENCH_IDS]),
				offlineRoutes: Object.freeze([...OFFLINE_WORKBENCH_ROUTES]),
			});
		}
		/** 单一目录生成的全量 entries 视图：静态投影 + 运行时 registerPage() 页，供跨包订阅。 */
		function catalogEntriesOf(pages) {
			const entries = WORK_DIRECTORY_ROWS.filter(row => row.nav && row.route)
				.sort((a, b) => a.navOrder - b.navOrder)
				.map(row => Object.freeze({
					key: row.key, id: row.navId, name: row.navName, ico: row.navIcon, route: row.route,
					hidden: !!row.navHidden, offline: !!row.navOffline, comp: row.navComp || '', package: row.sourcePackage || '',
					workbenchId: row.workbenchId, pageId: row.pageId, canonicalId: row.canonicalId,
					sourceKind: row.sourceKind, state: row.state, visibility: row.visibility,
					aliases: Object.freeze([...row.aliases]), replacedBy: row.replacedBy,
				}));
			const seen = new Set(entries.map(entry => entry.route));
			for (const page of Array.isArray(pages) ? pages : []) {
				if (!page || typeof page !== 'object') { continue; }
				const route = String(page.route || '');
				if (!route || seen.has(route)) { continue; }
				seen.add(route);
				entries.push(Object.freeze({
					key: String(page.key || ''), id: String(page.pageId || page.key || ''),
					name: String(page.title || page.key || ''), ico: String(page.icon || ''), route,
					hidden: page.hidden === true, offline: page.state === 'offline',
					comp: page.kind === 'component' ? String(page.pageId || '') : '', package: String(page.sourcePackage || ''),
					workbenchId: String(page.workbenchId || ''), pageId: String(page.pageId || ''),
					canonicalId: String(page.canonicalId || ''), sourceKind: String(page.sourceKind || ''),
					state: String(page.state || ''), visibility: page.visibility || ROUTE_VISIBILITY,
					aliases: Object.freeze([...(Array.isArray(page.aliases) ? page.aliases : [])]),
					replacedBy: String(page.replacedBy || ''),
				}));
			}
			return Object.freeze(entries);
		}
		/** 硬退役后只有 retired / pending 两态；不再根据旧全局数组判定。 */
		function legacyBridgeModeOf(scope) {
			const policyReady = !!(scope && typeof scope.__vssarosWorkbenchPolicy === 'function');
			const entriesReady = !!(scope && typeof scope.__vssarosWorkbenchCatalogEntries === 'function');
			return policyReady && entriesReady ? 'retired' : 'pending';
		}
		function catalogPolicyViewOf(page) {
			const source = page || {};
			const key = String(source.key || '');
			const canonicalId = String(source.canonicalId || source.workbenchId || '');
			const canonicalKey = canonicalId + '/' + String(source.pageId || 'default');
			const state = typeof source.state === 'string' && source.state.trim()
				? source.state.trim() : catalogPageStateOf(source);
			const route = String(source.route || '');
			const visibility = source.visibility
				? source.visibility : catalogVisibilityOf(source, null, state, route, key);
			return Object.freeze({ key, canonicalId, canonicalKey, state, route, visibility });
		}
		/** 阶段 1：开始页投影。行为与旧 visibleHomePagesOf 一致，额外尊重显式 state/visibility。 */
		function selectStartPages(pages) {
			const seen = new Set();
			return (Array.isArray(pages) ? pages : []).filter(page => {
				if (!page || !page.enabled || page.hidden || page.retired) { return false; }
				if (page.availability && page.availability !== 'ready') { return false; }
				const view = catalogPolicyViewOf(page);
				if (view.state !== 'active' || view.visibility.start === false) { return false; }
				const workbenchId = String(page.workbenchId || '');
				if (!view.key || HOME_HIDDEN_PAGE_KEYS.has(view.key) || HOME_HIDDEN_WORKBENCH_IDS.has(workbenchId)) { return false; }
				if (seen.has(view.key)) { return false; }
				seen.add(view.key);
				return true;
			});
		}
		function visibleHomePagesOf(pages) { return selectStartPages(pages); }
		/** 阶段 1：native tab 投影。默认保持旧适配器行为；显式 visibility.nativeTab=false 才排除。 */
		function selectNativeTabPages(pages) {
			return (Array.isArray(pages) ? pages : []).filter(page => {
				if (!page) { return false; }
				const view = catalogPolicyViewOf(page);
				return !!view.key && view.visibility.nativeTab !== false;
			});
		}
		function selectLauncherPages(pages) {
			return (Array.isArray(pages) ? pages : []).filter(page => {
				if (!page) { return false; }
				const view = catalogPolicyViewOf(page);
				return view.state === 'active' && view.visibility.launcher !== false;
			});
		}
		function selectRouteWhitelist(pages) {
			const seen = new Set();
			return (Array.isArray(pages) ? pages : []).filter(page => {
				const route = String(page && page.route || '');
				if (!route || seen.has(route)) { return false; }
				seen.add(route);
				return true;
			});
		}
		function resolveLegacyTabKey(tab, pages) {
			if (!tab || typeof tab !== 'object') { return ''; }
			const id = String(tab.id || ''), route = String(tab.route || '');
			const wbId = String(tab.wbId || ''), comp = String(tab.comp || '');
			const candidates = Array.isArray(pages) ? pages : [];
			const aliasMatches = alias => alias === id || alias === route || alias === wbId || alias === comp;
			const page = candidates.find(candidate => candidate && (
				candidate.key === id || candidate.pageId === id
				|| (route && candidate.route === route)
				|| (wbId && candidate.workbenchId === wbId)
				|| (comp && candidate.pageId === comp)
				|| (Array.isArray(candidate.aliases) && candidate.aliases.some(alias => aliasMatches(String(alias))))
			));
			if (!page) { return ''; }
			const replacedBy = String(page.replacedBy || '');
			const target = replacedBy && candidates.find(candidate => candidate
				&& (candidate.key === replacedBy || candidate.canonicalKey === replacedBy || candidate.canonicalId === replacedBy));
			return target ? String(target.key || '') : String(page.key || '');
		}
		function catalogDiagnosticsOf(pages) {
			return Object.freeze((Array.isArray(pages) ? pages : []).map(page => {
				const view = catalogPolicyViewOf(page || {});
				return Object.freeze({
					key: view.key, canonicalId: view.canonicalId, canonicalKey: view.canonicalKey,
					title: String(page.title || ''), workbenchId: String(page.workbenchId || ''),
					pageId: String(page.pageId || ''), sourceKind: String(page.sourceKind || ''),
					sourcePackage: String(page.sourcePackage || ''), kind: String(page.kind || ''),
					route: view.route, state: view.state, availability: String(page.availability || ''),
					visibility: view.visibility,
					aliases: Object.freeze([...(Array.isArray(page.aliases) ? page.aliases : [])]),
					replacedBy: String(page.replacedBy || ''),
				});
			}));
		}
		/** 同一 canonicalId + pageId 只允许一个 active 可见项；alias/deprecated/offline 不算冲突。 */
		function canonicalConflictsOf(pages) {
			const active = new Map();
			const conflicts = [];
			for (const page of Array.isArray(pages) ? pages : []) {
				if (!page) { continue; }
				const view = catalogPolicyViewOf(page);
				if (view.state !== 'active') { continue; }
				if (!view.visibility.start && !view.visibility.launcher && !view.visibility.nativeTab) { continue; }
				const previous = active.get(view.canonicalKey);
				if (previous) {
					conflicts.push(Object.freeze({
						canonicalId: view.canonicalId, canonicalKey: view.canonicalKey,
						keys: Object.freeze([previous, view.key]),
					}));
				} else {
					active.set(view.canonicalKey, view.key);
				}
			}
			return Object.freeze(conflicts);
		}
		/** `install-status` 的 pending 形状归一化；老 Host 404 / 脏数据一律当作「没有」。 */
		function pendingInstallsOf(body) {
			const rows = body && Array.isArray(body.pending) ? body.pending : [];
			return rows.filter(row => row && typeof row.name === 'string' && row.name.trim())
				.slice(0, 10)
				.map(row => ({
					name: row.name.trim(),
					version: typeof row.version === 'string' ? row.version.trim() : '',
				}));
		}
		let imageReferenceSidebar = null;
		let disposeImageReferenceTab = null;
		let keyboardDrag = null;
		let pointerDrag = null;
		let suppressHomeOpenUntil = 0;
		let htmlDragKey = '';
		function validOrderKey(value) { return typeof value === 'string' && value.length > 0 && value.length <= 200; }
		function normalizeHomeOrder(saved, available) {
			const order = Array.isArray(saved) ? [...new Set(saved.filter(validOrderKey))].slice(0, 2000) : [];
			for (const id of available) { if (!order.includes(id)) { order.push(id); } }
			return order.slice(0, 2000);
		}
		function moveHomeOrder(order, id, targetId) {
			if (id === targetId || !order.includes(id) || !order.includes(targetId)) { return [...order]; }
			const next = order.filter(x => x !== id);
			next.splice(next.indexOf(targetId), 0, id);
			return next;
		}
		/** 统一线性图标：不依赖外部 icon 包，也不使用 emoji。 */
		const GUIDE_ICON_SHAPES = {
			search: () => [h('circle', { key: 'c', cx: 10, cy: 10, r: 6 }), h('path', { key: 'p', d: 'm15 15 5 5' })],
			folder: () => [h('path', { key: 'p', d: 'M3 7V5h7l2 2h9v13H3V7Zm0 3h18' })],
			git: () => [h('circle', { key: 'a', cx: 6, cy: 5, r: 2 }), h('circle', { key: 'b', cx: 18, cy: 6, r: 2 }), h('circle', { key: 'c', cx: 6, cy: 19, r: 2 }), h('path', { key: 'p', d: 'M6 7v10m12-9c0 6-12 2-12 7' })],
			terminal: () => [h('path', { key: 'p', d: 'm4 6 6 6-6 6m9 0h7' })],
			globe: () => [h('circle', { key: 'c', cx: 12, cy: 12, r: 9 }), h('ellipse', { key: 'e', cx: 12, cy: 12, rx: 4, ry: 9 }), h('path', { key: 'p', d: 'M3 12h18' })],
			bot: () => [h('rect', { key: 'r', x: 3, y: 7, width: 18, height: 13, rx: 3 }), h('path', { key: 'p', d: 'M12 3v4m-5 6h1m8 0h1m-9 4h8' })],
			chat: () => [h('path', { key: 'p', d: 'M3 4h18v13H8l-5 4V4Zm4 5h10m-10 4h6' })],
			book: () => [h('path', { key: 'p', d: 'M12 6C7 3 3 5 3 5v15s5-2 9 0c4-2 9 0 9 0V5s-4-2-9 1v14' })],
			brain: () => [h('path', { key: 'p', d: 'M12 4c-5-4-9 2-6 5-5 1-3 7 0 7-1 5 6 6 6 1V4Zm0 0c5-4 9 2 6 5 5 1 3 7 0 7 1 5-6 6-6 1M6 9l3 2m9-2-3 2M6 16l3-2m9 2-3-2' })],
			code: () => [h('path', { key: 'p', d: 'm7 5-6 7 6 7m10-14 6 7-6 7m-3-16-4 18' })],
			media: () => [h('rect', { key: 'r', x: 3, y: 4, width: 18, height: 16, rx: 2 }), h('path', { key: 'p', d: 'm9 8 7 4-7 4Z' })],
			shop: () => [h('path', { key: 'p', d: 'M4 8h16l-1 13H5L4 8Zm4 0V6a4 4 0 0 1 8 0v2' })],
			clock: () => [h('circle', { key: 'c', cx: 12, cy: 12, r: 9 }), h('path', { key: 'p', d: 'M12 6v6l4 2' })],
			grid: () => [h('rect', { key: 'a', x: 3, y: 3, width: 7, height: 7, rx: 1 }), h('rect', { key: 'b', x: 14, y: 3, width: 7, height: 7, rx: 1 }), h('rect', { key: 'c', x: 3, y: 14, width: 7, height: 7, rx: 1 }), h('rect', { key: 'd', x: 14, y: 14, width: 7, height: 7, rx: 1 })],
			file: () => [h('path', { key: 'p', d: 'M5 2h9l5 5v15H5V2Zm9 0v6h5M8 13h8m-8 4h5' })],
			home: () => [h('path', { key: 'p', d: 'm3 10 9-7 9 7v10h-6v-7H9v7H3Z' })],
			plus: () => [h('path', { key: 'p', d: 'M12 5v14M5 12h14' })],
			chevron: () => [h('path', { key: 'p', d: 'm6 9 6 6 6-6' })],
			more: () => [h('circle', { key: 'a', cx: 4, cy: 12, r: 1 }), h('circle', { key: 'b', cx: 12, cy: 12, r: 1 }), h('circle', { key: 'c', cx: 20, cy: 12, r: 1 })],
			plugin: () => [h('path', { key: 'p', d: 'M4 4h5V2a3 3 0 0 1 6 0v2h5v5h2a3 3 0 0 1 0 6h-2v5h-5v-2a3 3 0 0 0-6 0v2H4v-5H2a3 3 0 0 1 0-6h2Z' })],
			settings: () => [h('path', { key: 'p', d: 'm8 3-1 3-3 1 1 4-1 3 3 1 1 5h7l1-5 4-1-1-3 1-4-4-1-1-3H8Z' }), h('circle', { key: 'c', cx: 12, cy: 11, r: 3 })],
			grip: () => [h('circle', { key: 'a', cx: 8, cy: 5, r: 1 }), h('circle', { key: 'b', cx: 16, cy: 5, r: 1 }), h('circle', { key: 'c', cx: 8, cy: 12, r: 1 }), h('circle', { key: 'd', cx: 16, cy: 12, r: 1 }), h('circle', { key: 'e', cx: 8, cy: 19, r: 1 }), h('circle', { key: 'f', cx: 16, cy: 19, r: 1 })],
			pin: () => [h('path', { key: 'p', d: 'M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Zm3 11v7' })],
			check: () => [h('path', { key: 'p', d: 'M4 12l5 5L20 6' })],
			arrow: () => [h('path', { key: 'p', d: 'M12 19V5m-6 6 6-6 6 6' })],
			x: () => [h('path', { key: 'p', d: 'm6 6 12 12M6 18 18 6' })],
		};
		function guideIcon(name, extraClass) {
			const shape = GUIDE_ICON_SHAPES[name] || GUIDE_ICON_SHAPES.grid;
			return h('svg', {
				className: 'vssaros-home-icon' + (extraClass ? ' ' + extraClass : ''),
				viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false',
				fill: 'none', stroke: 'currentColor', strokeWidth: 1.65,
				strokeLinecap: 'round', strokeLinejoin: 'round',
			}, shape());
		}
		/**
		 * 一份关键字规则（不是按 id 的名单）：工作台目录行与 Better Sidebar tab 共用图标推断。
		 * 注册方 descriptor 自带字符串 icon 时优先用；vendored builtins 的 icon 是 React 组件，
		 * 无法直接映射到本仓 SVG 名 ⇒ 按 id/title 关键字推断，新增工具无需改任何名单。
		 */
		function guideIconOf(source) {
			const raw = typeof (source && source.icon) === 'string' ? source.icon.trim() : '';
			if (GUIDE_ICON_SHAPES[raw]) { return raw; }
			const hay = [source && source.id, source && source.pageId, source && source.title,
				source && source.workbenchId, source && source.route]
				.filter(Boolean).join(' ').toLowerCase();
			if (/kb|知识/.test(hay)) { return 'book'; }
			if (/memory|记忆/.test(hay)) { return 'brain'; }
			if (/file|folder|explorer|文件|工作区/.test(hay)) { return 'folder'; }
			if (/git|change|变更|审查/.test(hay)) { return 'git'; }
			if (/terminal|shell|终端/.test(hay)) { return 'terminal'; }
			if (/browser|globe|网页|浏览器/.test(hay)) { return 'globe'; }
			if (/sidechat|chat|对话/.test(hay)) { return 'chat'; }
			if (/code|代码/.test(hay)) { return 'code'; }
			if (/media|媒体|image|图片/.test(hay)) { return 'media'; }
			if (/market|商城/.test(hay)) { return 'shop'; }
			if (/session|history|历史|scheduler|自动化/.test(hay)) { return 'clock'; }
			if (/superagent|agent|bot|subagent|任务|团队/.test(hay)) { return 'bot'; }
			return 'grid';
		}
		function iconNameOf(page) { return guideIconOf(page); }
		function sourceLabelOf(page) {
			const labels = { registered: '注册式', legacy: '内置清单', external: '外部插件', route: '路由式', component: '组件式' };
			const kind = labels[page.sourceKind] || (page.kind === 'route' ? '路由式' : page.kind === 'component' ? '组件式' : '注册式');
			return (page.sourcePackage ? page.sourcePackage + ' · ' : '内置 · ') + kind;
		}
		function isNewPage(page) {
			return page.pageId !== 'default' && ['registered', 'external'].includes(page.sourceKind);
		}
		/** 单个 TabDescriptor → 工具视图：标题/描述全部来自注册方，图标走共用关键字规则。 */
		function toolViewOf(descriptor) {
			const title = typeof descriptor.title === 'function' ? descriptor.title()
				: String(descriptor.title || descriptor.id);
			const description = typeof descriptor.description === 'function'
				? descriptor.description() : String(descriptor.description || '');
			return Object.freeze({
				id: descriptor.id, kind: 'tool', title, description,
				icon: guideIconOf({ id: descriptor.id, title, icon: descriptor.icon }),
			});
		}
		/** 兼容旧调用方（守卫/测试钉住）：仍按 hidden/bottomOnly/宿主自注册前缀过滤。 */
		function toolEntriesOf(betterSidebar) {
			const tabs = betterSidebar && typeof betterSidebar.getTabs === 'function' ? betterSidebar.getTabs() : [];
			return tabs.filter(descriptor => descriptor && typeof descriptor.id === 'string'
				&& descriptor.hidden !== true && descriptor.bottomOnly !== true && !isHostOwnedTab(descriptor))
				.map(toolViewOf);
		}
		/**
		 * 统一开始页 item 注册层（2026-11-21 架构收口）。
		 * 工作台页（catalog）与 Better Sidebar tab 是「来源不同、形状相同」的 item：
		 * 两个 adapter 归一成 HomeItem，registry 统一身份、可见性、去热与查表；渲染层不再拼前缀。
		 */
		const HOME_ITEM_KIND_CATALOG = 'workbench';
		const HOME_ITEM_KIND_TAB = 'tool';
		const HOME_ITEM_SOURCE_CATALOG = 'catalog';
		const HOME_ITEM_SOURCE_TABS = 'betterSidebar';
		const HOME_ITEM_OWNER = 'vssaros-workbenches';
		/** catalogKey 自带 workbenchId/pageId 命名空间；tab id 需要显式 tool: 前缀。 */
		function homeItemKey(kind, id) {
			return kind === HOME_ITEM_KIND_TAB ? 'tool:' + String(id) : String(id);
		}
		/** 宿主自己注册的承载 tab（catalog adapter / 图片资源）不是开始页工具。 */
		function isHostOwnedTab(descriptor) {
			if (!descriptor) { return true; }
			const id = String(descriptor.id || '');
			return descriptor.vssarosOwner === HOME_ITEM_OWNER
				|| id.startsWith('vssaros-wb:') || id === HOME_IMAGE_TAB_TYPE;
		}
		function homeItemVisibility(start, nativeTab, launcher) {
			return Object.freeze({ start, nativeTab, launcher, anchor: start });
		}
		function homeItemOfCatalogPage(page) {
			const start = selectStartPages([page]).length === 1;
			const nativeTab = selectNativeTabPages([page]).length === 1;
			const launcher = selectLauncherPages([page]).length === 1;
			const key = homeItemKey(HOME_ITEM_KIND_CATALOG, page.key);
			return Object.freeze({
				key, itemKey: key, kind: HOME_ITEM_KIND_CATALOG,
				title: String(page.title || page.key), description: String(page.description || '工作台页面'),
				icon: iconNameOf(page), source: sourceLabelOf(page),
				availability: start || nativeTab || launcher ? 'ready' : 'hidden',
				visibility: homeItemVisibility(start, nativeTab, launcher),
				origin: Object.freeze({ registry: HOME_ITEM_SOURCE_CATALOG, descriptorId: String(page.key) }),
				aliases: Object.freeze([...(Array.isArray(page.aliases) ? page.aliases : [])]),
				replacedBy: String(page.replacedBy || ''),
				catalogKey: String(page.key), tabId: '', workbenchId: String(page.workbenchId || ''),
				page, tool: null,
			});
		}
		function homeItemOfTabDescriptor(descriptor) {
			const tool = toolViewOf(descriptor);
			const enabled = descriptor.hidden !== true && descriptor.bottomOnly !== true;
			const key = homeItemKey(HOME_ITEM_KIND_TAB, tool.id);
			return Object.freeze({
				key, itemKey: key, kind: HOME_ITEM_KIND_TAB,
				title: tool.title, description: tool.description, icon: tool.icon,
				source: descriptor.source || '工具',
				availability: enabled ? 'ready' : 'hidden',
				visibility: homeItemVisibility(enabled, enabled, enabled),
				origin: Object.freeze({ registry: HOME_ITEM_SOURCE_TABS, descriptorId: tool.id }),
				aliases: Object.freeze([]), replacedBy: '',
				catalogKey: '', tabId: tool.id, workbenchId: '',
				page: null, tool: Object.freeze(tool),
			});
		}
		/** 一个投影函数：surface = start | nativeTab | launcher | anchor。 */
		function selectHomeItems(items, surface = 'start') {
			const field = ({ start: 'start', nativeTab: 'nativeTab', launcher: 'launcher', anchor: 'anchor' })[surface] || 'start';
			return (Array.isArray(items) ? items : []).filter(item => item
				&& item.availability === 'ready' && item.visibility && item.visibility[field] !== false);
		}
		/**
		 * HomeItemRegistry：两个来源合成一张冻结表，缓存 + 细粒度失效；
		 * get(key) 供左侧栏锚点与统一打开入口使用，不再依赖渲染闭包里的 items。
		 */
		function createHomeItemRegistry(service, betterSidebar) {
			let cached = null;
			const sources = () => {
				const snap = service && typeof service.getCatalogSnapshot === 'function'
					? service.getCatalogSnapshot() : null;
				const pages = snap && Array.isArray(snap.pages) ? snap.pages : [];
				const tabs = betterSidebar && typeof betterSidebar.getTabs === 'function' ? betterSidebar.getTabs() : [];
				// catalog 快照每次 publish 都是新对象 ⇒ 用引用判变化；tab 注册表用轻量字段戳判变化。
				// 这样即使组件还没跑 useEffect 订阅、或 adapter 单独 sync，也不会读到过期表。
				const tabsStamp = tabs.map(descriptor => descriptor && [
					descriptor.id, descriptor.hidden === true, descriptor.bottomOnly === true,
					descriptor.vssarosOwner || '', typeof descriptor.title === 'function' ? '' : descriptor.title,
				].join(':')).join('|');
				return { snap, pages, tabs, tabsStamp };
			};
			const build = ({ pages, tabs }) => {
				const byKey = new Map();
				for (const page of pages) {
					if (!page || typeof page.key !== 'string') { continue; }
					const item = homeItemOfCatalogPage(page);
					if (!byKey.has(item.key)) { byKey.set(item.key, item); }
				}
				for (const descriptor of tabs) {
					if (!descriptor || typeof descriptor.id !== 'string' || isHostOwnedTab(descriptor)) { continue; }
					const item = homeItemOfTabDescriptor(descriptor);
					if (!byKey.has(item.key)) { byKey.set(item.key, item); }
				}
				return { items: Object.freeze([...byKey.values()]), byKey };
			};
			const ensure = () => {
				const src = sources();
				if (!cached || cached.snap !== src.snap || cached.tabsStamp !== src.tabsStamp) {
					cached = Object.freeze({ ...build(src), snap: src.snap, tabsStamp: src.tabsStamp });
				}
				return cached;
			};
			return Object.freeze({
				snapshot() { return ensure().items; },
				get(key) { return ensure().byKey.get(key) || null; },
				invalidate() { cached = null; return ensure().items; },
				subscribe(listener) {
					const notify = () => { cached = null; if (typeof listener === 'function') { listener(); } };
					const offs = [];
					try { if (service && typeof service.subscribeCatalog === 'function') { offs.push(service.subscribeCatalog(notify)); } } catch { /* 已释放 */ }
					try { if (betterSidebar && typeof betterSidebar.subscribe === 'function') { offs.push(betterSidebar.subscribe(notify)); } } catch { /* 已释放 */ }
					return () => { for (const off of offs) { try { if (typeof off === 'function') { off(); } } catch { /* 已释放 */ } } };
				},
			});
		}
		let homeItemRegistryOwner = null;
		function getHomeItemRegistry(service, betterSidebar) {
			if (homeItemRegistryOwner && homeItemRegistryOwner.service === service
				&& homeItemRegistryOwner.betterSidebar === betterSidebar) { return homeItemRegistryOwner.registry; }
			const registry = createHomeItemRegistry(service, betterSidebar);
			homeItemRegistryOwner = { service, betterSidebar, registry };
			return registry;
		}
		/** 双排序字段 → 单 homeItemOrder 的惰性迁移：不改旧 state.json，写回时合并。 */
		function migrateHomeItemOrder(saved, availableKeys) {
			const keys = Array.isArray(availableKeys) ? availableKeys : [];
			if (Array.isArray(saved && saved.homeItemOrder) && saved.homeItemOrder.length) {
				return normalizeHomeOrder(saved.homeItemOrder, keys);
			}
			const source = saved || {};
			const legacy = [
				...(Array.isArray(source[HOME_WB_ORDER_FIELD]) ? source[HOME_WB_ORDER_FIELD] : []),
				...(Array.isArray(source[HOME_TOOL_ORDER_FIELD])
					? source[HOME_TOOL_ORDER_FIELD].map(id => homeItemKey(HOME_ITEM_KIND_TAB, id)) : []),
			];
			return normalizeHomeOrder(legacy, keys);
		}
		/** P4 基础：识别 `@image:name` 标记；不猜附件 id、不读任意本地路径。 */
		function parseImageToken(text) {
			const match = /@image:([^\s]+)/.exec(String(text || ''));
			return match ? Object.freeze({ raw: match[0], name: match[1] }) : null;
		}
		const LEGACY_TABS_KEY = 'vssaros.wb.tabs';
		const LEGACY_TABS_MIGRATED_KEY = 'vssaros.wb.tabs.migrated.v1';
		const IMAGE_VERSIONS_ROUTE = 'x/imagegen/api/versions';
		/** P5：旧中栏页签 → 新目录主键；解析 aliases/replacedBy，只认能映射到的条目。 */
		function legacyTabKeysOf(tabs, pages) {
			const keys = [];
			for (const tab of Array.isArray(tabs) ? tabs : []) {
				const key = resolveLegacyTabKey(tab, pages);
				if (key && !keys.includes(key)) { keys.push(key); }
			}
			return keys;
		}
		/** P4：`@image:name` 只经同源 Host 图片账本解析，不接受任意文件路径。 */
		function imageVersionsUrl(name, base) {
			return new URL(IMAGE_VERSIONS_ROUTE + '?attachment=' + encodeURIComponent(String(name || '')), base).href;
		}
		function pickImageVersion(payload, name) {
			if (!payload || payload.ok !== true || !Array.isArray(payload.versions) || !payload.versions.length) { return null; }
			const versions = payload.versions;
			const current = versions.find(item => item && item.id === payload.current) || versions[versions.length - 1];
			if (!current) { return null; }
			return Object.freeze({
				name: String(name || ''),
				title: String(current.prompt || name || '图片资源'),
				url: typeof current.url === 'string' ? current.url : '',
				attachment: current.attachment && typeof current.attachment === 'object' ? current.attachment : null,
			});
		}
		async function resolveImageToken(name) {
			const token = String(name || '').trim();
			if (!token || typeof fetch !== 'function') { return null; }
			let base = '';
			try {
				base = (typeof document !== 'undefined' && document.baseURI)
					|| (globalThis.location && globalThis.location.href) || '';
			} catch { base = ''; }
			if (!base) { return null; }
			try {
				const res = await fetch(imageVersionsUrl(token, base), { cache: 'no-store' });
				const data = await res.json();
				return res.ok ? pickImageVersion(data, token) : null;
			} catch (error) {
				console.warn('[vssaros-workbenches] 解析 @image 资源失败：' + String(error && error.message || error));
				return null;
			}
		}
		function saveHomeOrder(service, field, order, setNotice) {
			if (!service || typeof service.commit !== 'function') {
				setNotice('工作台状态未加载，顺序未保存。'); return;
			}
			service.commit(state => { state[field] = [...order]; })
				.then(() => setNotice('顺序已保存。'))
				.catch(error => setNotice('保存失败：' + String(error && error.message || error) + '（已重新加载，不覆盖其他窗口的顺序）'));
		}
		function ImageReferenceView(props) {
			const tab = (props && props.tab) || {};
			const meta = tab.meta || {};
			const [url, setUrl] = React.useState(typeof meta.url === 'string' ? meta.url : '');
			const [error, setError] = React.useState(typeof meta.error === 'string' ? meta.error : '');
			React.useEffect(() => {
				if (url || error) { return undefined; }
				const loader = globalThis.__vssarosLoadImage;
				if (typeof loader !== 'function' || !meta.attachment) {
					setError('没有会话授权的图片加载器或图片地址，无法展示该资源。');
					return undefined;
				}
				let alive = true;
				Promise.resolve().then(() => loader(meta.attachment))
					.then(value => { if (alive) { if (value) { setUrl(String(value)); } else { setError('图片附件没有返回可用地址。'); } } })
					.catch(e => { if (alive) { setError('图片资源加载失败：' + String(e && e.message || e)); } });
				return () => { alive = false; };
			}, [url, error]);
			if (error) {
				return h('div', { 'data-vssaros-image-reference': 'error', style: { padding: '16px', color: 'var(--dsw-alias-label-secondary)' } }, error);
			}
			if (!url) {
				return h('div', { 'data-vssaros-image-reference': 'loading', style: { padding: '16px', color: 'var(--dsw-alias-label-secondary)' } }, '正在解析图片资源…');
			}
			return h('img', {
				'data-vssaros-image-reference': 'ready', src: url,
				alt: String(meta.title || meta.name || '图片资源'),
				style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
			});
		}
		function openImageReference(ref) {
			const parsed = typeof ref === 'string' ? parseImageToken(ref) : (ref && typeof ref === 'object' ? ref : null);
			if (!sidebarLayoutV1Enabled || !parsed || !imageReferenceSidebar
				|| typeof imageReferenceSidebar.openTab !== 'function') { return false; }
			let session;
			try { session = imageReferenceSidebar.getSnapshot && imageReferenceSidebar.getSnapshot().sessionId; }
			catch { session = undefined; }
			if (!session) { console.warn('[vssaros-workbenches] 没有活动会话，图片资源未打开。'); return false; }
			const doOpen = payload => {
				try {
					imageReferenceSidebar.openTab({
						type: HOME_IMAGE_TAB_TYPE,
						meta: {
							name: String(payload.name || payload.raw || ''),
							title: String(payload.title || payload.name || '图片资源'),
							url: typeof payload.url === 'string' ? payload.url : '',
							attachment: payload.attachment || null,
							error: typeof payload.error === 'string' ? payload.error : '',
						},
					});
					return true;
				} catch (error) {
					console.warn('[vssaros-workbenches] 打开图片资源失败：' + String(error && error.message || error));
					return false;
				}
			};
			if (parsed.url || parsed.attachment || parsed.error) { return doOpen(parsed); }
			const tokenName = String(parsed.name || '').trim();
			let base = '';
			try {
				base = (typeof document !== 'undefined' && document.baseURI)
					|| (globalThis.location && globalThis.location.href) || '';
			} catch { base = ''; }
			if (tokenName && base && typeof fetch === 'function') {
				resolveImageToken(tokenName).then(resolved => {
					if (resolved) { doOpen(resolved); return; }
					doOpen({ ...parsed, error: '找不到 @image:' + tokenName + ' 对应的图片附件。' });
				}).catch(error => {
					doOpen({ ...parsed, error: '图片附件解析失败：' + String(error && error.message || error) });
				});
				return true;
			}
			return doOpen({ ...parsed, error: '没有会话授权的图片加载器或图片地址，无法展示该资源。' });
		}
		function registerImageReferenceTab(betterSidebar) {
			if (!betterSidebar || typeof betterSidebar.registerTab !== 'function') { return () => { }; }
			if (disposeImageReferenceTab) { disposeImageReferenceTab(); }
			let disposed = false;
			const dispose = betterSidebar.registerTab({
				id: HOME_IMAGE_TAB_TYPE, vssarosOwner: HOME_ITEM_OWNER, title: '图片资源', hidden: true,
				available: () => false,
				component: ImageReferenceView,
				createTab: () => {
					const id = 'vssaros-image-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
					return { tab: { id, type: HOME_IMAGE_TAB_TYPE, title: '图片资源', meta: {} } };
				},
			});
			imageReferenceSidebar = betterSidebar;
			disposeImageReferenceTab = () => {
				if (disposed) { return; }
				disposed = true;
				if (typeof dispose === 'function') { dispose(); }
				if (imageReferenceSidebar === betterSidebar) { imageReferenceSidebar = null; }
				disposeImageReferenceTab = null;
				delete globalThis.__vssarosOpenImageReference;
				delete globalThis.__vssarosParseImageToken;
				delete globalThis.__vssarosResolveImageToken;
			};
			globalThis.__vssarosOpenImageReference = openImageReference;
			globalThis.__vssarosParseImageToken = parseImageToken;
			globalThis.__vssarosResolveImageToken = resolveImageToken;
			return disposeImageReferenceTab;
		}
		function beginWorkbenchPointerDrag(ev, key, onTarget, onDrop) {
			if (typeof document === 'undefined' || typeof document.addEventListener !== 'function'
				|| typeof document.elementFromPoint !== 'function') { return; }
			if (ev.pointerType && ev.pointerType !== 'touch' && ev.pointerType !== 'pen') { return; }
			ev.preventDefault();
			const startX = ev.clientX, startY = ev.clientY;
			const state = { key, pointerId: ev.pointerId, moved: false, target: null };
			const source = typeof document.querySelector === 'function'
				? document.querySelector('[data-vssaros-home-workbench="' + key + '"]') : null;
			const rect = source && typeof source.getBoundingClientRect === 'function' ? source.getBoundingClientRect() : null;
			const scroller = source && typeof source.closest === 'function'
				? (source.closest('[role=tabpanel]') || source.closest('.vssaros-home')) : null;
			let ghost = null;
			const makeGhost = () => {
				if (!source || typeof source.cloneNode !== 'function' || !document.body
					|| typeof document.body.appendChild !== 'function') { return; }
				ghost = source.cloneNode(true);
				if (ghost.removeAttribute) { ghost.removeAttribute('data-vssaros-home-workbench'); }
				if (ghost.setAttribute) { ghost.setAttribute('data-vssaros-home-drag-preview', '1'); }
				if (ghost.classList && ghost.classList.add) { ghost.classList.add('vssaros-home-drag-preview'); }
				else { ghost.className = String(ghost.className || '') + ' vssaros-home-drag-preview'; }
				if (ghost.style) {
					ghost.style.position = 'fixed';
					ghost.style.zIndex = '90';
					ghost.style.pointerEvents = 'none';
					ghost.style.opacity = '.95';
					ghost.style.transform = 'rotate(-2deg)';
					ghost.style.margin = '0';
					if (rect) { ghost.style.width = rect.width + 'px'; ghost.style.height = rect.height + 'px'; }
				}
				document.body.appendChild(ghost);
				if (source.classList && source.classList.add) { source.classList.add('is-dragging'); }
			};
			const positionGhost = e => {
				if (!ghost || !ghost.style) { return; }
				const width = rect ? rect.width : 160, height = rect ? rect.height : 84;
				ghost.style.left = Math.max(0, e.clientX - width / 2) + 'px';
				ghost.style.top = Math.max(0, e.clientY - height / 2) + 'px';
			};
			const autoScroll = e => {
				if (!scroller || typeof scroller.getBoundingClientRect !== 'function') { return; }
				const box = scroller.getBoundingClientRect();
				if (e.clientY < box.top + 24) { scroller.scrollTop -= 12; }
				else if (e.clientY > box.bottom - 24) { scroller.scrollTop += 12; }
			};
			const removeGhost = () => {
				if (source && source.classList && source.classList.remove) { source.classList.remove('is-dragging'); }
				if (!ghost) { return; }
				if (typeof ghost.remove === 'function') { ghost.remove(); }
				else if (ghost.parentNode && ghost.parentNode.removeChild) { ghost.parentNode.removeChild(ghost); }
				ghost = null;
			};
			const cleanup = () => {
				if (typeof document.removeEventListener === 'function') {
					document.removeEventListener('pointermove', move);
					document.removeEventListener('pointerup', up);
					document.removeEventListener('pointercancel', cancel);
				}
				removeGhost();
				pointerDrag = null;
			};
			const move = e => {
				if (e.pointerId !== state.pointerId) { return; }
				if (!state.moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) { return; }
				if (!state.moved) { makeGhost(); }
				state.moved = true;
				positionGhost(e);
				autoScroll(e);
				const node = document.elementFromPoint(e.clientX, e.clientY);
				const card = node && typeof node.closest === 'function'
					? node.closest('[data-vssaros-home-workbench]') : null;
				state.target = card && card.dataset ? card.dataset.vssarosHomeWorkbench : null;
				onTarget(state.target);
			};
			const up = e => {
				if (e.pointerId !== state.pointerId) { return; }
				cleanup();
				if (state.moved) { suppressHomeOpenUntil = Date.now() + 400; }
				if (state.moved && state.target && state.target !== key) { onDrop(state.target); }
				else { onTarget(''); }
			};
			const cancel = () => { cleanup(); onTarget(''); };
			pointerDrag = { cancel };
			document.addEventListener('pointermove', move);
			document.addEventListener('pointerup', up);
			document.addEventListener('pointercancel', cancel);
		}
		/** 自家右侧「开始」页：搜索 + 统一工作台 item 目录；无分类页签、常用工具分组、欢迎或统计。 */
		function makeVsSarosHomeGuide(service, ctx, betterSidebar) {
			return function VsSarosHomeGuide() {
				const [, forceRevision] = React.useState(0);
				const [query, setQuery] = React.useState('');
				const [menuOpen, setMenuOpen] = React.useState(false);
				const [menuPos, setMenuPos] = React.useState({ left: 0, top: 0, width: 216, ready: false });
				const [notice, setNotice] = React.useState('');
				const [toolOrderDraft, setToolOrderDraft] = React.useState(null);
				const [keyboardDraft, setKeyboardDraft] = React.useState(null);
				const [keyboardKey, setKeyboardKey] = React.useState('');
				const [dragOverKey, setDragOverKey] = React.useState('');
				const [restartPending, setRestartPending] = React.useState([]);
				React.useEffect(() => {
					const offCatalog = service.subscribeCatalog(() => forceRevision(n => n + 1));
					const offState = service.subscribe(() => forceRevision(n => n + 1));
					const offTabs = betterSidebar && typeof betterSidebar.subscribe === 'function'
						? betterSidebar.subscribe(() => forceRevision(n => n + 1)) : () => { };
					return () => { offCatalog(); offState(); offTabs(); };
				}, []);
				/** 已安装但当前 Host 未加载的包：短轮询现有 install-status，不改动 Host，也不写回用户设置。 */
				React.useEffect(() => {
					if (typeof fetch !== 'function') { return undefined; }
					let alive = true;
					let inFlight = false;
					let timer = null;
					const refresh = () => {
						if (!alive || inFlight) { return; }
						inFlight = true;
						try {
							Promise.resolve(fetch(INSTALL_STATUS_URL, { cache: 'no-store' }))
								.then(res => res && res.ok ? res.json() : null)
								.then(body => {
									inFlight = false;
									if (alive) { setRestartPending(pendingInstallsOf(body)); }
								})
								.catch(() => {
									inFlight = false;
									if (alive) { setRestartPending([]); }
								});
						} catch {
							inFlight = false;
							if (alive) { setRestartPending([]); }
						}
					};
					const onFocus = () => refresh();
					const onVisibility = () => {
						if (typeof document === 'undefined' || document.visibilityState !== 'hidden') { refresh(); }
					};
					refresh();
					if (typeof globalThis !== 'undefined' && typeof globalThis.setInterval === 'function') {
						timer = globalThis.setInterval(refresh, INSTALL_STATUS_POLL_MS);
					}
					if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
						window.addEventListener('focus', onFocus);
					}
					if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
						document.addEventListener('visibilitychange', onVisibility);
					}
					return () => {
						alive = false;
						if (timer != null && typeof globalThis !== 'undefined' && typeof globalThis.clearInterval === 'function') {
							globalThis.clearInterval(timer);
						}
						if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
							window.removeEventListener('focus', onFocus);
						}
						if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
							document.removeEventListener('visibilitychange', onVisibility);
						}
					};
				}, []);
				React.useEffect(() => {
					if (!menuOpen || typeof document === 'undefined' || typeof document.querySelector !== 'function') { return; }
					const positionMenu = () => {
						const trigger = document.querySelector('[data-vssaros-more-trigger]');
						const menu = document.querySelector('[data-vssaros-more-menu]');
						if (!trigger || !menu || typeof trigger.getBoundingClientRect !== 'function'
							|| typeof menu.getBoundingClientRect !== 'function') { return; }
						const viewportW = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1024;
						const viewportH = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 768;
						const t = trigger.getBoundingClientRect();
						if (t.bottom <= 0 || t.top >= viewportH) { closeMenu(); return; }
						const width = Math.max(180, Math.min(216, viewportW - 24));
						const height = menu.getBoundingClientRect().height || 132;
						const left = Math.max(12, Math.min(t.right - width, viewportW - width - 12));
						const below = t.bottom + 6;
						const top = Math.max(12, Math.min(
							below + height <= viewportH - 36 ? below : t.top - height - 6,
							viewportH - height - 12,
						));
						setMenuPos({ left, top, width, ready: true });
					};
					positionMenu();
					const first = document.querySelector('[data-vssaros-more-menu] [role=menuitem]');
					if (first && typeof first.focus === 'function') { first.focus({ preventScroll: true }); }
					const onKey = ev => {
						if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); closeMenu(true); }
					};
					const onOutside = ev => {
						const target = ev.target;
						if (target && typeof target.closest === 'function'
							&& target.closest('[data-vssaros-more-menu], [data-vssaros-more-trigger]')) { return; }
						closeMenu();
					};
					const onScroll = () => positionMenu();
					const onBlur = () => closeMenu();
					if (typeof document.addEventListener === 'function') {
						document.addEventListener('keydown', onKey, true);
						document.addEventListener('pointerdown', onOutside, true);
						document.addEventListener('click', onOutside, true);
						document.addEventListener('scroll', onScroll, true);
					}
					if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
						window.addEventListener('resize', onScroll);
						window.addEventListener('blur', onBlur);
					}
					return () => {
						if (typeof document.removeEventListener === 'function') {
							document.removeEventListener('keydown', onKey, true);
							document.removeEventListener('pointerdown', onOutside, true);
							document.removeEventListener('click', onOutside, true);
							document.removeEventListener('scroll', onScroll, true);
						}
						if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
							window.removeEventListener('resize', onScroll);
							window.removeEventListener('blur', onBlur);
						}
					};
				}, [menuOpen]);
				// 单一 registry：catalog 页 + Better Sidebar tab 都在这里归一成 HomeItem。
				const registry = getHomeItemRegistry(service, betterSidebar);
				globalThis.__vssarosHomeItemRegistry = registry;
				React.useEffect(() => registry.subscribe(() => forceRevision(n => n + 1)), []);
				const saved = service.state || {};
				const allItems = registry.snapshot();
				const items = selectHomeItems(allItems, 'start');
				const itemKeys = items.map(item => item.key);
				// 统一排序：homeItemOrder 单字段，旧 homeWorkbenchOrder/homeToolOrder 惰性合并。
				const homeOrder = migrateHomeItemOrder(saved, itemKeys);
				const activeToolOrder = toolOrderDraft || homeOrder;
				const activeWbOrder = keyboardDraft || homeOrder;
				const rank = order => {
					const map = new Map(order.map((id, index) => [id, index]));
					return (a, b) => (map.get(a) ?? 0) - (map.get(b) ?? 0);
				};
				const orderedItems = [...items].sort((a, b) => rank(activeToolOrder)(a.key, b.key));
				const needle = String(query || '').trim().toLowerCase();
				const matches = item => !needle || (item.title + ' ' + item.description).toLowerCase().includes(needle);
				const shownItems = orderedItems.filter(matches);
				const closeMenu = (restoreFocus = false) => {
					setMenuOpen(false);
					setMenuPos(prev => ({ ...prev, ready: false }));
					if (restoreFocus && typeof document !== 'undefined' && typeof document.querySelector === 'function') {
						const trigger = document.querySelector('[data-vssaros-more-trigger]');
						if (trigger && typeof trigger.focus === 'function') { trigger.focus({ preventScroll: true }); }
					}
				};
				const tryOpenCatalogPage = key => {
					if (Date.now() < suppressHomeOpenUntil) { return true; }
					const open = globalThis.__vssarosOpenWorkbenchCatalogPage;
					return typeof open === 'function' && open(key) === true;
				};
				const openCatalogPage = key => {
					if (!tryOpenCatalogPage(key)) {
						setNotice('当前没有活动会话或右栏目录未就绪，工作台未打开。');
					}
				};
				const openTool = id => {
					let session;
					try {
						session = betterSidebar && typeof betterSidebar.getSnapshot === 'function'
							? betterSidebar.getSnapshot().sessionId : undefined;
					} catch { session = undefined; }
					if (!session || !betterSidebar || typeof betterSidebar.openTab !== 'function') {
						setNotice('当前没有活动会话或右栏工具服务不可用，工具未打开。'); return;
					}
					try { betterSidebar.openTab({ type: id }); }
					catch (e) { setNotice('打开工具失败：' + String(e && e.message || e)); }
				};
				/** 一个打开入口：按 origin.registry 分派承载策略；V1 关闭时统一回落注册式工作台本体。 */
				const openHomeItem = (item, surface = 'right-tab') => {
					if (!item) { setNotice('开始页条目不存在或已下线。'); return; }
					if (item.origin.registry === HOME_ITEM_SOURCE_TABS) { openTool(item.tabId); return; }
					// left-anchor 与 right-tab 必须同链路：从左侧栏点锚点也要打开右栏 catalog tab。
					// 之前 surface !== 'right-tab' 会强制降级到注册式工作台本体，用户看到「点了没反应」。
					if (!sidebarLayoutV1Enabled) {
						try {
							if (item.workbenchId && service && typeof service.open === 'function'
								&& service.open(item.workbenchId)) { return; }
						} catch { /* 继续走右栏目录链路 */ }
					}
					openCatalogPage(item.catalogKey);
				};
				// 左侧栏锚点查 registry，不再依赖渲染闭包里的 items。
				globalThis.__vssarosOpenHomeAnchor = (key, surface) => openHomeItem(registry.get(key), surface);
				globalThis.__vssarosToggleHomeAnchor = item => toggleHomeAnchor(item);
				try { installHomeAnchorBridge(); } catch { /* 左侧栏未就绪时由后续重贴兜底 */ }
				/** 统一持久化：所有 item 的顺序都写 homeItemOrder。 */
				const persistHomeOrder = (order, save) => {
					if (!save) { setNotice('顺序调整中，确认后保存。'); forceRevision(n => n + 1); return; }
					saveHomeOrder(service, HOME_ITEM_ORDER_FIELD, order, setNotice);
				};
				const persistWbOrder = (order, save) => persistHomeOrder(order, save);
				const persistToolOrder = draft => {
					persistHomeOrder(draft, true);
					setToolOrderDraft(null);
				};
				const browsePlugins = () => {
					closeMenu();
					// 「浏览更多插件」= 直达商城工作台：优先打开目录里的 active 商城页（右栏「商城」tab），
					// 目录/右栏未就绪时回落注册式商城工作台本体；不再打开宿主插件目录。
					const market = registry.snapshot().find(item => item.kind === HOME_ITEM_KIND_CATALOG
						&& item.page && item.page.canonicalId === MARKET_WORKBENCH_ID);
					if (market && tryOpenCatalogPage(market.catalogKey)) { return; }
					try {
						if (service && typeof service.open === 'function' && service.open(MARKET_WORKBENCH_ID)) { return; }
					} catch (e) { setNotice('打开商城工作台失败：' + String(e && e.message || e)); return; }
					setNotice('商城工作台未就绪，请稍后重试。');
				};
				const createPlugin = () => {
					closeMenu();
					let workspace = null;
					try { workspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null; } catch { /* 未声明 */ }
					if (!workspace || typeof workspace.startSession !== 'function') {
						setNotice('当前宿主没有 uiWorkspace.startSession，创建入口不可用。'); return;
					}
					try {
						workspace.startSession(undefined, {
							agentPreset: 'cordis', prompt: CREATE_PLUGIN_PROMPT, whenDraftExists: 'append',
						});
					} catch (e) { setNotice('进入创造模式失败：' + String(e && e.message || e)); }
				};
				const startToolOrdering = () => {
					closeMenu(); setQuery('');
					setToolOrderDraft(normalizeHomeOrder(homeOrder, itemKeys));
					setKeyboardDraft(null); setKeyboardKey('');
					setNotice('调整顺序：使用上移/下移，完成后保存。');
				};
				const moveToolDraft = (key, direction) => {
					const current = toolOrderDraft || homeOrder;
					const at = current.indexOf(key), target = current[at + direction];
					if (!target) { return; }
					setToolOrderDraft(moveHomeOrder(current, key, target));
					setNotice('顺序草稿已更新，完成才保存。');
				};
				const onWorkbenchKeyDown = (ev, key) => {
					if (![' ', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) { return; }
					ev.preventDefault(); ev.stopPropagation();
					const current = keyboardDraft || homeOrder;
					if (!keyboardDraft) {
						if (ev.key === ' ' || ev.key === 'Enter') {
							setKeyboardDraft([...current]); setKeyboardKey(key);
							setNotice('已拿起工作台卡片：方向键移动，Enter 保存，Esc 取消。');
							forceRevision(n => n + 1);
						}
						return;
					}
					if (ev.key === 'Escape') {
						setKeyboardDraft(null); setKeyboardKey(''); setNotice('已取消排序，原顺序保留。');
						forceRevision(n => n + 1); return;
					}
					if (ev.key === ' ' || ev.key === 'Enter') {
						persistWbOrder(keyboardDraft, true);
						setKeyboardDraft(null); setKeyboardKey(''); return;
					}
					const at = current.indexOf(keyboardKey);
					const delta = ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1
						: ev.key === 'ArrowUp' ? -2 : 2;
					const target = current[at + delta];
					if (target && target !== keyboardKey) {
						setKeyboardDraft(moveHomeOrder(current, keyboardKey, target));
						setNotice('顺序调整中，按 Enter 保存或 Esc 取消。');
						forceRevision(n => n + 1);
					}
				};
				const onWorkbenchDrop = (from, to) => {
					// 统一网格：工作台与工具 item 都是合法落点，顺序写同一份 homeItemOrder。
					if (!from || from === to) { setDragOverKey(''); return; }
					persistHomeOrder(moveHomeOrder(activeWbOrder, from, to), true);
					setDragOverKey('');
				};
				/** 统一 item 卡片：工作台页 / 工具 / 自动化任务共用，右上角锚点既可拖拽排序也可点击固定到左侧栏。 */
				const itemCard = item => {
					const isKeyboard = keyboardDraft && keyboardKey === item.itemKey;
					const isDrop = dragOverKey === item.itemKey;
					const isWorkbench = item.kind === 'workbench';
					const cardId = homeWorkbenchCardIdOf(item.itemKey);
					const anchorId = homeWorkbenchAnchorIdOf(item.itemKey);
					const anchored = isHomeAnchored(item.itemKey);
					const className = 'vssaros-home-workbench-card'
						+ (isKeyboard ? ' is-keyboard-dragging' : '') + (isDrop ? ' is-drop-target' : '')
						+ (anchored ? ' is-anchored' : '');
					const dragProps = isWorkbench ? {
						draggable: !needle,
						onDragStart: ev => { htmlDragKey = item.itemKey; if (ev.dataTransfer) { ev.dataTransfer.setData('text/plain', item.itemKey); } },
						onDragOver: ev => { ev.preventDefault(); setDragOverKey(item.itemKey); },
						onDrop: ev => {
							ev.preventDefault();
							onWorkbenchDrop(htmlDragKey || (ev.dataTransfer && ev.dataTransfer.getData('text/plain')), item.itemKey);
							htmlDragKey = '';
						},
						onDragEnd: () => { htmlDragKey = ''; setDragOverKey(''); },
						onPointerDown: ev => beginWorkbenchPointerDrag(ev, item.itemKey, setDragOverKey, target => onWorkbenchDrop(item.itemKey, target)),
						onKeyDown: ev => onWorkbenchKeyDown(ev, item.itemKey),
					} : { draggable: false };
					const doAnchorToggle = () => {
						const added = toggleHomeAnchor(item);
						// React 重渲染是异步的：先同步改图钉/卡片 DOM，用户点完立刻看得到状态变化。
						try {
							if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
								const card = document.getElementById(homeWorkbenchCardIdOf(item.itemKey));
								if (card && card.classList && typeof card.classList.toggle === 'function') {
									card.classList.toggle('is-anchored', added);
								}
								const pin = document.getElementById(homeWorkbenchAnchorIdOf(item.itemKey));
								if (pin) {
									pin.setAttribute('aria-pressed', added ? 'true' : 'false');
									pin.setAttribute('aria-label', (added ? '从左侧栏移除 ' : '固定到左侧栏 ') + item.title);
									pin.title = added ? '已固定在左侧栏，点击取消' : '点击固定到左侧栏，Enter / 空格同样可用';
									// 视觉状态不能只靠 aria-pressed（主题里品牌色与默认色可能相同）：
									// 同步切 is-pinned 类 + 图标 path，点击瞬间就看得见。
									if (pin.classList && typeof pin.classList.toggle === 'function') {
										pin.classList.toggle('is-pinned', added);
									}
									const path = pin.querySelector && pin.querySelector('svg path');
									if (path) {
										path.setAttribute('d', added ? 'M4 12l5 5L20 6'
											: 'M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Zm3 11v7');
									}
								}
							}
						} catch { /* DOM 未就绪时由 React 重渲染兜底 */ }
						setNotice(added ? '已固定到左侧栏：' + item.title : '已从左侧栏移除：' + item.title);
						forceRevision(n => n + 1);
					};
					return h('div', {
						className, id: cardId,
						'data-vssaros-home-workbench': item.itemKey,
						...(item.kind === 'tool' ? { 'data-vssaros-home-tool': item.tool.id } : {}),
						'data-vssaros-home-anchor-card': anchorId,
						'data-vssaros-home-drop-target': isDrop ? '1' : undefined,
					},
						h('button', {
							type: 'button', className: 'vssaros-home-workbench-open',
							'data-vssaros-home-open': item.itemKey, 'aria-label': '打开 ' + item.title,
							onClick: () => openHomeItem(item),
						},
							h('header', null,
								guideIcon(item.icon || 'grid'),
								h('strong', null, item.title),
								isWorkbench && isNewPage(item.page) ? h('span', { className: 'vssaros-home-new-badge' }, '新') : null),
							h('p', null, item.description || (isWorkbench ? '工作台页面' : '工具')),
							h('div', { className: 'vssaros-home-source' }, item.source)),
						h('div', { className: 'vssaros-home-card-actions' },
							h('button', {
								type: 'button', className: 'vssaros-home-anchor-button vssaros-home-anchor' + (anchored ? ' is-pinned' : ''),
								id: anchorId,
								'data-vssaros-home-anchor': item.itemKey,
								'data-vssaros-home-anchor-action': '1',
								'aria-roledescription': '固定锚点',
								'aria-label': (anchored ? '从左侧栏移除 ' : '固定到左侧栏 ') + item.title,
								'aria-pressed': anchored ? 'true' : 'false',
								title: anchored ? '已固定在左侧栏，点击取消' : '点击固定到左侧栏，Enter / 空格同样可用',
								// 不再按 ev.detail 过滤：键盘/触屏/合成 click 的 detail 可能为 0，
								// 早退会让真机「点了没反应」。键盘 Enter / 空格由浏览器派发原生 click，无需重复绑定。
								onClick: () => {
									if (Date.now() < suppressHomeOpenUntil) { return; }
									doAnchorToggle();
								},
								}, guideIcon(anchored ? 'check' : 'pin')),
							h('button', {
								type: 'button', className: 'vssaros-home-drag-handle',
								'data-vssaros-home-drag': item.itemKey,
								'aria-roledescription': '拖拽锚点',
								'aria-label': '拖动 ' + item.title + ' 调整顺序',
								'aria-describedby': 'vssaros-home-drag-help',
								title: '拖拽排序；空格拿起，方向键移动，Enter 放下，Esc 取消',
								disabled: !!needle,
								...dragProps,
							}, guideIcon('grip'))),
						toolOrderDraft && item.kind === 'tool'
							? h('span', { className: 'vssaros-home-item-order-controls' },
								h('button', {
									type: 'button', className: 'vssaros-home-icon-button',
									'data-vssaros-tool-move': item.key, 'data-direction': '-1',
									'aria-label': '上移 ' + item.title,
									onClick: () => moveToolDraft(item.key, -1),
								}, guideIcon('arrow')),
								h('button', {
									type: 'button', className: 'vssaros-home-icon-button',
									'data-vssaros-tool-move': item.key, 'data-direction': '1',
									'aria-label': '下移 ' + item.title,
									onClick: () => moveToolDraft(item.key, 1),
								}, guideIcon('arrow', 'down')))
							: null);
				};
				const menu = menuOpen ? h('div', {
					id: 'vssaros-home-tools-menu', className: 'vssaros-home-menu',
					'data-vssaros-more-menu': '1', role: 'menu', 'aria-label': '更多工具操作',
					style: {
						position: 'fixed', left: menuPos.left, top: menuPos.top, width: menuPos.width,
						visibility: menuPos.ready ? 'visible' : 'hidden', zIndex: 80,
						maxHeight: 'calc(100dvh - 24px)', overflow: 'auto',
					},
					onKeyDown: ev => {
						if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(true); return; }
						if (!['ArrowDown', 'ArrowUp'].includes(ev.key)) { return; }
						const buttons = ev.currentTarget && typeof ev.currentTarget.querySelectorAll === 'function'
							? [...ev.currentTarget.querySelectorAll('[role=menuitem]')] : [];
						if (!buttons.length) { return; }
						const active = typeof document !== 'undefined' ? document.activeElement : null;
						const at = buttons.indexOf(active);
						const next = ev.key === 'ArrowDown' ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
						if (buttons[next]) { ev.preventDefault(); buttons[next].focus(); }
					},
					onBlur: ev => {
						const current = ev.currentTarget;
						if (current && typeof current.contains === 'function' && !current.contains(ev.relatedTarget)) { closeMenu(); }
					},
				},
					h('button', {
						type: 'button', role: 'menuitem', 'data-vssaros-browse-plugins': '1', onClick: browsePlugins,
					}, guideIcon('plugin'), h('span', null, '浏览更多插件')),
					h('button', {
						type: 'button', role: 'menuitem', 'data-vssaros-create-plugin': '1', onClick: createPlugin,
					}, guideIcon('plus'), h('span', null, '创建你的插件')),
					h('div', { className: 'vssaros-home-menu-separator', role: 'separator' }),
					h('button', {
						type: 'button', role: 'menuitem', 'data-vssaros-order-tools': '1', onClick: startToolOrdering,
					}, guideIcon('settings'), h('span', null, '调整顺序'))) : null;
				const toolFooter = toolOrderDraft
					? h('div', { className: 'vssaros-home-tool-order-actions' },
						h('span', { className: 'vssaros-home-small' }, '使用箭头调整位置'),
						h('button', {
							type: 'button', className: 'vssaros-home-button', 'data-vssaros-cancel-tool-order': '1',
							onClick: () => { setToolOrderDraft(null); setNotice('已取消调整，原顺序保留。'); },
						}, '取消'),
						h('button', {
							type: 'button', className: 'vssaros-home-button', 'data-vssaros-save-tool-order': '1',
							onClick: () => persistToolOrder(toolOrderDraft),
						}, '完成'))
					: null;
				const sectionActions = h('div', { className: 'vssaros-home-section-actions' },
					h('div', { className: 'vssaros-home-more-wrap' },
						h('button', {
							type: 'button', className: 'vssaros-home-more-card',
							'data-vssaros-more-trigger': '1', 'aria-label': '更多工具操作',
							'aria-haspopup': 'menu', 'aria-expanded': menuOpen ? 'true' : 'false',
							'aria-controls': 'vssaros-home-tools-menu',
							onClick: () => { if (pointerDrag) { pointerDrag.cancel(); } setMenuOpen(!menuOpen); },
						}, guideIcon('more'), h('b', null, '更多'), guideIcon('chevron', 'vssaros-home-chevron')),
						menu));
				const workbenchSection = h('div', { className: 'vssaros-home-workbench-section' },
					h('div', { className: 'vssaros-home-section-head' },
						h('h2', null, '工作台'),
						h('span', { className: 'vssaros-home-pill' }, '目录自动发现'),
						h('span', { className: 'vssaros-home-small' }, items.length + ' 个条目'),
						sectionActions),
					h('p', { className: 'vssaros-home-drag-help', id: 'vssaros-home-drag-help' },
						'拖动卡片右上角锚点，调整任意行列位置；点击图钉按钮固定到左侧栏，再次点击取消。'),
					h('div', { className: 'vssaros-home-workbench-grid vssaros-home-tool-grid' }, shownItems.map(itemCard)),
					toolFooter,
					h('p', { className: 'vssaros-home-keyboard-help' },
						'键盘：聚焦拖动手柄按空格拿起，方向键移动，Enter 放下，Esc 取消；聚焦图钉按钮按 Enter 固定。搜索时暂不可排序。'));
				const emptyState = !shownItems.length
					? h('div', { className: 'vssaros-home-empty' }, '没有匹配结果',
						h('br'), h('span', { className: 'vssaros-home-small' }, '换个关键词试试。'))
					: null;
				return h('section', {
					className: 'vssaros-home', 'data-vssaros-guide-root': '1',
					'data-vssaros-home-view': 'workbenches', 'data-vssaros-surface': 'workbench',
					'aria-label': '开始主页',
				},
					h('label', { className: 'vssaros-home-search' },
						guideIcon('search'),
						h('input', {
							'aria-label': '搜索工作台或工具', placeholder: '搜索工作台、工具或页面…', value: query,
							onChange: e => {
								setQuery(e && e.target ? e.target.value : '');
								setToolOrderDraft(null); setKeyboardDraft(null); setKeyboardKey('');
							},
						}),
						h('span', { className: 'vssaros-home-small' }, '/')),
					restartPending.length ? h('div', {
						className: 'vssaros-home-install-notice', role: 'status', 'aria-live': 'polite',
						'data-vssaros-restart-pending': String(restartPending.length),
					}, restartPending.map(item => '「' + item.name + (item.version ? ' ' + item.version : '') + '」').join('、')
						+ '已安装，重启 Harness 后出现') : null,
					workbenchSection, emptyState,
					notice ? h('div', { className: 'vssaros-home-notice', role: 'status', 'aria-live': 'polite' }, notice) : null);
			};
		}
		/**
		 * P3 开启即注册 VsSaros 唯一主页链。`sidebar.right.tab.guide` 是 chain 槽，按 priority
		 * 升序选举；shipped `NativeGuide` 默认 priority 0，这里用 -10 稳定胜出，不再依赖 live
		 * `guideTakeover:false` 是否生效，也不写回用户设置。
		 */
		function installVsSarosHomeGuide(ctx, service, betterSidebar) {
			if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') { return null; }
			let disposeRegistration = null;
			const HomeGuide = makeVsSarosHomeGuide(service, ctx, betterSidebar);
			try {
				const disposeInjection = ctx.slots.inject('sidebar.right.tab.guide', () => {
					disposeRegistration = ctx.slots.register({
						name: 'sidebar.right.tab.guide',
						priority: -10,
						select: () => ({}),
						inject: sessionId => ({ sessionId, service, betterSidebar, ctx }),
					}, HomeGuide);
					return disposeRegistration;
				});
				const a = disposerOf(disposeInjection);
				const b = disposerOf(disposeRegistration);
				globalThis.__vssarosHomeGuideOwner = 'vssaros-workbenches';
				return () => {
					if (a) { a(); }
					if (b && b !== a) { b(); }
					if (globalThis.__vssarosHomeGuideOwner === 'vssaros-workbenches') {
						delete globalThis.__vssarosHomeGuideOwner;
					}
				};
			} catch (error) {
				console.warn('[vssaros-workbenches] 自家开始页注册失败：' + String(error && error.message || error));
				return null;
			}
		}
		/** P2 右栏业务视图：不套 Frame、不渲染 ConversationMount，中栏主会话保持唯一。 */
		function makeSidebarWorkbenchView(service, page) {
			const fallback = page;
			return function VssarosSidebarWorkbenchView(props) {
				const safeProps = props || {};
				const [, forceRevision] = React.useState(service.getCatalogSnapshot().revision);
				React.useEffect(() => service.subscribeCatalog(() => forceRevision(service.getCatalogSnapshot().revision)), []);
				const key = String((safeProps.tab && safeProps.tab.meta && safeProps.tab.meta.catalogKey)
					|| (safeProps.tab && safeProps.tab.path) || fallback.key);
				const live = service.getCatalogSnapshot().pages.find(item => item.key === key) || fallback;
				if (live.retired || !live.enabled) {
					return h('div', { 'data-vssaros-wb-sidebar-page': key }, '工作台已停用或卸载');
				}
				const renderer = service.getCatalogRenderer(key);
				if (typeof renderer === 'function') {
					const entry = {
						id: live.workbenchId, title: live.title, description: live.description, icon: live.icon,
						resourcePackage: live.sourcePackage, sourceKind: live.sourceKind,
						panel: 'vssaros-wb:' + live.workbenchId, customFrame: false,
						headerLayout: 'default', floatingActions: false, splitConversation: false,
						layout: { businessSide: 'right', businessWidth: 0.36 },
					};
					return h('div', { 'data-vssaros-wb-sidebar-page': key, 'data-vssaros-surface': 'workbench' },
						h(renderer, {
							ctx: safeProps.ctx, service, entry, page: live, tab: safeProps.tab,
							scope: safeProps.scope, visible: safeProps.visible === true,
							instanceId: safeProps.tab && safeProps.tab.meta && safeProps.tab.meta.instanceId,
						}));
				}
				if (live.route) {
					const src = live.route + (live.route.includes('?') ? '&' : '?') + 'surface=sidebar';
					return h('div', { 'data-vssaros-wb-sidebar-page': key, 'data-vssaros-surface': 'workbench' },
						h('iframe', {
							src, title: live.title, loading: 'lazy',
							'data-vssaros-wb-sidebar-route': key,
							style: { width: '100%', height: '100%', border: '0' },
						}));
				}
				return h('div', { 'data-vssaros-wb-sidebar-page': key }, '此工作台没有可用的右侧承载');
			};
		}
		/**
		 * P2：把统一目录 diff 成 Better Sidebar 的 tab descriptors。默认由
		 * `globalThis.__vssarosSetSidebarLayoutV1(true)` 激活，P3 完成 guide 接管后再打开；
		 * 关闭时不注册任何 native type，避免与当前中栏 TabStrip / 默认 guide 争抢。
		 */
		function installSidebarWorkbenchAdapter(ctx, service, betterSidebar) {
			const noop = { sync() { }, openPage() { return false; }, setEnabled() { }, dispose() { } };
			if (!betterSidebar || typeof betterSidebar.registerTab !== 'function') { return noop; }
			if (activeSidebarAdapter && typeof activeSidebarAdapter.dispose === 'function') { activeSidebarAdapter.dispose(); }
			const registrations = new Map();
			let disposed = false;
			let instanceSerial = 0;
			const signatureOf = page => JSON.stringify([
				sidebarLayoutV1Enabled, page.title, page.description, page.hidden, page.retired,
				page.enabled, page.availability, page.state, page.canonicalId, page.canonicalKey,
				page.visibility, page.aliases, page.replacedBy,
				page.kind, page.route, page.renderHandle,
			]);
			const sync = () => {
				if (disposed) { return; }
				// 统一投影：nativeTab surface 与开始页共用同一张 HomeItem 表；工具 item 无 page ⇒ 过滤掉。
				const pages = sidebarLayoutV1Enabled
					? selectHomeItems(getHomeItemRegistry(service, betterSidebar).snapshot(), 'nativeTab')
						.filter(item => item.page).map(item => item.page) : [];
				const live = new Set(pages.map(page => page.key));
				for (const [key, record] of [...registrations]) {
					if (!live.has(key)) {
						try { record.dispose(); } catch (e) { console.warn('[vssaros-workbenches] 注销右栏 tab 失败：' + String(e && e.message || e)); }
						registrations.delete(key);
					}
				}
				if (!sidebarLayoutV1Enabled) { return; }
				pages.forEach((page, index) => {
					const signature = signatureOf(page);
					const previous = registrations.get(page.key);
					if (previous && previous.signature === signature) { return; }
					if (previous) { try { previous.dispose(); } catch { /* 已失效的旧注册 */ } }
					const typeId = sidebarTabTypeOf(page);
					const hidden = page.hidden || page.retired || !page.enabled || page.availability !== 'ready';
					const descriptor = {
						id: typeId,
						// 标记宿主自注册承载 tab：统一 HomeItemRegistry 按 origin 排除，不再靠字符串前缀猜。
						vssarosOwner: HOME_ITEM_OWNER,
						title: page.title,
						description: page.description || page.title,
						order: 200 + index,
						hidden,
						available: () => !hidden && sidebarLayoutV1Enabled,
						component: makeSidebarWorkbenchView(service, page),
						createTab: () => {
							instanceSerial += 1;
							const instanceId = 'vssaros-wb-instance-' + instanceSerial + '-' + stableHash8(page.key);
							return {
								tab: {
									id: instanceId, type: typeId, title: page.title,
									meta: {
										catalogKey: page.key, workbenchId: page.workbenchId,
										pageId: page.pageId, instanceId,
									},
								},
							};
						},
					};
					try {
						const dispose = betterSidebar.registerTab(descriptor);
						registrations.set(page.key, { signature, typeId, dispose: typeof dispose === 'function' ? dispose : () => { } });
					} catch (error) {
						console.warn('[vssaros-workbenches] 注册右栏 tab 失败：' + String(error && error.message || error));
					}
				});
			};
			const openPage = (key, scope) => {
				if (disposed || !sidebarLayoutV1Enabled || typeof betterSidebar.openTab !== 'function') { return false; }
				const record = registrations.get(key);
				if (!record) { return false; }
				try {
					betterSidebar.openTab({ type: record.typeId, meta: { catalogKey: key } }, scope);
					return true;
				} catch (error) {
					console.warn('[vssaros-workbenches] 打开右栏工作台失败：' + String(error && error.message || error));
					return false;
				}
			};
			const adapter = {
				sync,
				openPage,
				setEnabled(enabled) { sidebarLayoutV1Enabled = enabled === true; sync(); },
				dispose() {
					if (disposed) { return; }
					disposed = true;
					try { unsubscribe(); } catch { /* 订阅可能已被父 ctx 回收 */ }
					for (const record of registrations.values()) {
						try { record.dispose(); } catch { /* HMR 时服务可能已卸载 */ }
					}
					registrations.clear();
					if (activeSidebarAdapter === adapter) {
						activeSidebarAdapter = null;
						delete globalThis.__vssarosOpenWorkbenchCatalogPage;
					}
				},
			};
			const unsubscribe = service.subscribeCatalog(sync);
			activeSidebarAdapter = adapter;
			globalThis.__vssarosOpenWorkbenchCatalogPage = (key, scope) => adapter.openPage(key, scope);
			sync();
			return adapter;
		}
		/**
		 * P3：把「Host 开关 + 自家主页链已注册 + P2 右栏目录」串成一条所有权链。
		 * live `guideTakeover` 只作诊断：VsSaros 主页通过 chain 的负 priority 接管 shipped guide，
		 * 不再因为用户 live 设置或覆盖层时序把整个新布局短路；也不写回用户设置。
		 */
		function installSidebarLayoutOwnership(ctx, service, betterSidebar) {
			if (!betterSidebar || typeof betterSidebar.registerTab !== 'function') { return () => { }; }
			const adapter = installSidebarWorkbenchAdapter(ctx, service, betterSidebar);
			const disposeImage = registerImageReferenceTab(betterSidebar);
			let disposeGuide = null;
			let overrideLogged = false;
			const syncOwnership = () => {
				const configured = readSidebarLayoutV1Config(ctx);
				const released = sidebarGuideReleased(betterSidebar);
				if (!configured || released) { overrideLogged = false; }
				if (configured && !released && !overrideLogged) {
					overrideLogged = true;
					console.info('[vssaros-workbenches] dsh-better-sidebar 的 live guideTakeover 仍为 true；VsSaros 主页以 priority -10 接管开始页，不写回用户设置。');
				}
				if (configured) {
					if (!disposeGuide) { disposeGuide = installVsSarosHomeGuide(ctx, service, betterSidebar); }
					void service.migrateLegacyTabs();
				} else if (disposeGuide) {
					disposeGuide();
					disposeGuide = null;
				}
				setSidebarLayoutV1(configured && !!disposeGuide);
			};
			const unsubscribeState = typeof betterSidebar.subscribeState === 'function'
				? betterSidebar.subscribeState(syncOwnership) : () => { };
			syncOwnership();
			return () => {
				try { unsubscribeState(); } catch { /* 父 ctx 可能已回收订阅 */ }
				if (disposeGuide) { disposeGuide(); disposeGuide = null; }
				adapter.dispose();
				disposeImage();
				setSidebarLayoutV1(false);
			};
		}

		/**
		 * ★ 2026-11-13（用户：「移除 dsh 侧，工作台中的 循环任务 item」）：**工作台列表下线名单**（唯一真源）。
		 *
		 * 口径沿用 11-04「看板/流程/生图 暂时下线」与 11-10「移除 工具 item」：只收 **UI 入口**，
		 * 插件本体 / 工作台页面 / Host 路由 / Agent 工具 / 伴生安装 **一律保留** ⇒ 恢复只需清空本数组。
		 *
		 * 为什么按**身份 id** 而不是 route：`vssaros/loop` 是**注册式**工作台（`view.kind='none'`），
		 * 没有 `/x/loop/` 页面路由 ⇒ 套不上 dashboard/catalog.js 那份 route 驱动的
		 * `OFFLINE_WORKBENCH_ROUTES`；硬造一个 `/x/loop/` 白名单项只会得到一个「点了 404」的假入口。
		 *
		 * 为什么放在**宿主快照出口**：主页工作台卡片的 `registeredCardItems()` 与启动器的
		 * `registeredExtras()` 都只读 `getSnapshot().workbenches` ⇒ 一处过滤，两处 item 同时消失，
		 * 不会「主页没了、启动器还在」。⚠ 只从**列表**里摘掉：`providers` 仍保留注册，
		 * `open(id)` / `has(id)` / 深链 / 工具照旧可用 ⇒ 页面本体没有被删。
		 *
		 * 守卫 `dsh-plugins/check-workbench-catalog.mjs` ⑧ 盯着这条链路（含反向突变）。
		 * 阶段 2：`RETIRED_WORKBENCH_IDS` 已由文件顶部 `WORKBENCH_MANIFEST` 统一生成，此处不再重复声明。
		 */
		/* RETIRED_WORKBENCH_IDS / WORKBENCH_MANIFEST：见文件顶部统一目录清单。 */

		/**
		 * 与 `vssarosPluginManifest.ts` 的 `workbenchIdentityOf` 同口径（小写 owner/repo）。
		 *
		 * 2026-11-02 对齐 dsh-desktop：本地开发的工作台**不再强制**填 `repository`。
		 * 身份优先级（与官方 §2 身份表一致）：
		 *   ① `repository: 'https://github.com/<owner>/<repo>'` ⇒ `owner/repo`
		 *   ② `repository: 'vssaros:<module>'`                  ⇒ `vssaros/<module>`（本仓内置保留命名空间）
		 *   ③ 省略 repository ⇒ `local:<npm 包名>`：
		 *        · 显式 `package` 字段（工作台作者写真实包名，最稳）
		 *        · 否则用调用方客户端包名（`ctx.fiber.entry.options.name`，官方同款取法）
		 * 三者都拿不到 ⇒ 仍然抛（没有稳定身份就无法做会话归属，不能猜）。
		 */
		function identityOf(repository, packageName) {
			const value = typeof repository === 'string' ? repository.trim() : '';
			if (value) {
				if (value.startsWith(LOCAL_SCHEME)) {
					// 显式写 `local:<pkg>` 也接受（便于测试与手工登记）
					const name = value.slice(LOCAL_SCHEME.length);
					if (!PACKAGE_RE.test(name)) { throw new Error('Invalid workbench local identity: ' + value); }
					return LOCAL_SCHEME + name;
				}
				if (value.startsWith(VSSAROS_SCHEME)) {
					const mod = value.slice(VSSAROS_SCHEME.length);
					if (!MODULE_RE.test(mod)) { throw new Error('Invalid workbench repository: ' + value); }
					return 'vssaros/' + mod;
				}
				const m = GITHUB_RE.exec(value);
				if (!m) { throw new Error('Workbench repository must be https://github.com/<owner>/<repo> or vssaros:<module>: ' + value); }
				return (m[1] + '/' + m[2]).toLowerCase();
			}
			const name = typeof packageName === 'string' ? packageName.trim().toLowerCase() : '';
			if (!name || !PACKAGE_RE.test(name)) {
				throw new Error('Workbench registration needs a repository (https://github.com/<owner>/<repo> or vssaros:<module>) or a package name for a local identity');
			}
			return LOCAL_SCHEME + name;
		}

		/** 校验逐条照官方 register()（client.js:856-869）；失败一律抛。返回规范化条目，内部 pages 持有 renderer，快照不暴露它。 */
		function normalize(descriptor, Component, packageName) {
			if (!descriptor || !descriptor.title || typeof Component !== 'function') { throw new Error('Invalid workbench registration'); }
			const id = identityOf(descriptor.repository, descriptor.package || packageName);
			if (descriptor.customFrame !== undefined && typeof descriptor.customFrame !== 'boolean') { throw new Error('Invalid custom frame flag'); }
			if (descriptor.headerLayout !== undefined && descriptor.headerLayout !== 'default' && descriptor.headerLayout !== 'compact') { throw new Error('Invalid workbench header layout'); }
			if (descriptor.sessionNavigation !== undefined && descriptor.sessionNavigation !== 'native' && descriptor.sessionNavigation !== 'dock') { throw new Error('Invalid workbench session navigation'); }
			const layout = descriptor.layout || {};
			if (layout.businessSide !== undefined && layout.businessSide !== 'left' && layout.businessSide !== 'right') { throw new Error('Invalid workbench business side'); }
			if (layout.businessWidth !== undefined && (!Number.isFinite(layout.businessWidth) || layout.businessWidth < 0.25 || layout.businessWidth > 0.7)) {
				throw new Error('Workbench business width must be between 0.25 and 0.7');
			}
			const sourcePackage = descriptor.package || packageName || '';
			const pageFallback = {
				title: descriptor.title,
				description: typeof descriptor.description === 'string' ? descriptor.description : '',
				icon: typeof descriptor.icon === 'string' ? descriptor.icon : '',
				sourcePackage,
				sourceKind: 'registered',
				Component,
				hidden: descriptor.hidden === true,
				retired: RETIRED_WORKBENCH_IDS.includes(id),
				enabled: descriptor.enabled !== false,
			};
			const declaredPages = Array.isArray(descriptor.pages) ? descriptor.pages : [];
			const pages = declaredPages.map(page => normalizeCatalogPage(page, id, pageFallback));
			if (!pages.some(page => page.pageId === 'default')) {
				pages.unshift(normalizeCatalogPage({
					id: 'default', title: descriptor.title, description: pageFallback.description,
					icon: pageFallback.icon, component: Component, sourceKind: 'registered',
				}, id, pageFallback));
			}
			const seenPageIds = new Set();
			for (const page of pages) {
				if (seenPageIds.has(page.pageId)) { throw new Error('Duplicate workbench page id: ' + page.pageId); }
				seenPageIds.add(page.pageId);
			}
			return Object.assign({}, descriptor, {
				id,
				resourcePackage: sourcePackage,
				panel: PANEL_PREFIX + id,
				customFrame: descriptor.customFrame === true,
				headerLayout: descriptor.headerLayout || 'default',
				// 助手浮动工具栏始终由宿主提供；旧标志仅控制外部浏览器入口。
				floatingActions: descriptor.floatingActions !== false,
				// ★ 2026-11-02（对齐 dsh-desktop §4.1 标准分栏）：未声明 customFrame 的工作台
				//   默认由宿主渲染「左对话 / 右业务」分栏，会话停靠在左栏（不再切走工作台）。
				//   `splitConversation: false` 可退回旧行为（点会话即切到原生会话页）——
				//   给"业务面板必须占满整页、不接受常驻会话区"的老工作台留逃生门。
				splitConversation: descriptor.customFrame === true ? false : descriptor.splitConversation !== false,
				layout: { businessSide: layout.businessSide || 'right', businessWidth: layout.businessWidth !== undefined ? layout.businessWidth : 0.36 },
				pages,
			});
		}

		class Workbenches {
			constructor(ctx) {
				this.ctx = ctx;
				this.providers = new Map();
				this.pageFrames = [];
				this.assistantCollapsed = new Map();
				this.listeners = new Set();
				this.active = null;
				this.navigation = 0;
				this.disposed = false;
				this.workspaceSelections = new Map();
				try {
					const saved = JSON.parse(window.sessionStorage.getItem('vssaros.workbench.workspaces') || '{}');
					for (const [owner, workspaceId] of Object.entries(saved)) {
						if (typeof workspaceId === 'string') { this.workspaceSelections.set(owner, workspaceId); }
					}
				} catch { /* Session storage can be unavailable. */ }
				this.revision = 0;
				this.state = null;
				this.stateError = null;
				this.queue = Promise.resolve();
				/** 会话停靠（整页工作台）：页面里的停靠点 / 本次指定的停靠会话 / 打不开的会话。 */
				this.docks = [];
				/** 标准分栏工作台的左栏停靠点（宿主自己渲染，id → DOM）。 */
				this.splitDocks = new Map();
				this.docked = new Map();
				this.dead = new Set();
				this.dockError = null;
				/**
				 * 注册失败记录（2026-11-02，对齐 dsh-desktop 的 `registrationFailures`）。
				 *
				 * 为什么要有：`register()` 校验不过就抛，调用方是插件的 `ctx.effect(...)` ⇒ 异常进了控制台，
				 * **界面上什么都没有**。用户看到的是「装了，重启了，启动器里还是没有」——
				 * 这是"装了没出现"的头号原因，而他手上没有任何线索。
				 * 记下来并在启动器里显示包名 + 阶段 + 原因，用户和 Agent 才有下一步。
				 *
				 * key = 来源标识（包名 / 身份），同一个来源后来注册成功就删掉（不留过期结论）。
				 */
				this.registrationFailures = new Map();
				/**
				 * P1 统一目录（2026-11-19）：注册式 / 路由式 / 组件式工作台都汇到 `catalogPages`。
				 * 快照只给可序列化字段；React Component 或自定义 renderer 放在 `catalogRenderers`，
				 * 避免把组件塞进快照导致 HMR / 结构化订阅出错。
				 */
				this.catalogPages = new Map();
				this.catalogRenderers = new Map();
				this.catalogListeners = new Set();
				this.catalogRevision = 0;
				/** 阶段 4：manifest active route 行登记后的注销函数。 */
				this.manifestCatalogDisposers = new Map();
				/** P5：旧中栏页签存档只读一次，写入 state.json 的 homeWorkbenchOrder 后不重复迁移。 */
				this.legacyTabsMigrated = false;
				this.legacyTabsMigrating = false;
				/** 已经套过默认 agent 的「工作台|会话」（每条只套一次，见 applyDefaultPreset）。 */
				this.presetApplied = new Set();
				/** 工作台 id → 已确认**真实存在**的 preset id（见 readyPreset；只缓存命中，不缓存"没有"）。 */
				this.presetResolved = new Map();
				/** 已经告警过"候选都不存在"的工作台（每个只报一次）。 */
				this.presetMissingWarned = new Set();
				/**
				 * 等 preset 注册好的轮询参数。为什么要等：vssaros-agents 启动只注册少量 preset，
				 * 其余 ~15s 后才补齐（lazy 注册）；这段时间里用自定义 preset 建会话 / select 都是 Unknown。
				 * 30s 覆盖 lazy 窗口 + 余量；测试里会调短。
				 */
				this.presetPollMs = 1000;
				this.presetWaitMs = 30000;
				/** 已经诊断过的停靠会话（见 diagnoseDock；每条只报一次，不刷屏）。 */
				this.dockedDiag = new Set();
				/** 已经自动换过会话的工作台（见 healDock；每个只救一次，防循环）。 */
				this.dockHealed = new Set();
				/** `remote.agentPresets` 服务（apply 里可选注入；没有就不套默认 agent，其它功能照常）。 */
				this.agentPresets = null;
				this.snapshot = this.buildSnapshot();
				this.catalogSnapshot = this.buildCatalogSnapshot();
				}
				subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			getSnapshot() { return this.snapshot; }
			/** P1：目录单独订阅，注册/注销/启停变化不要求消费方轮询。 */
			subscribeCatalog(listener) {
				this.catalogListeners.add(listener);
				return () => this.catalogListeners.delete(listener);
			}
			getCatalogSnapshot() { return this.catalogSnapshot; }
			getCatalogRenderer(key) { return this.catalogRenderers.get(key) || null; }
			buildCatalogSnapshot() {
				return Object.freeze({
					revision: this.catalogRevision,
					pages: Object.freeze([...this.catalogPages.values()].map(catalogPageSnapshot)),
				});
			}
			publishCatalog() {
				this.catalogSnapshot = this.buildCatalogSnapshot();
				const conflicts = canonicalConflictsOf(this.catalogSnapshot.pages);
				if (conflicts.length) {
					console.warn('[vssaros-workbenches] 目录存在 active canonical 冲突：' + JSON.stringify(conflicts));
				}
				/* 跨 chunk 不轮询：目录变化用事件通知消费方；无 CustomEvent 的测试桩静默跳过。 */
				if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function'
					&& typeof window.CustomEvent === 'function') {
					try {
						window.dispatchEvent(new window.CustomEvent('vssaros-wb-catalog-change', {
							detail: { revision: this.catalogRevision },
						}));
					} catch { /* 测试桩或宿主不允许事件时忽略 */ }
				}
				for (const l of [...this.catalogListeners]) {
					try { l(); } catch (e) { console.error('[vssaros-workbenches] catalog listener', e); }
				}
				// P5：新布局启用后，目录一到齐就尝试把旧中栏页签顺序读旧写新（只跑一次）。
				if (sidebarLayoutV1Enabled && this.catalogSnapshot.pages.length
					&& !this.legacyTabsMigrated && !this.legacyTabsMigrating) {
					void this.migrateLegacyTabs();
				}
			}
			/** P5：旧 `vssaros.wb.tabs` → `state.homeWorkbenchOrder`，不改旧存档、不复活下线项。 */
			async migrateLegacyTabs() {
				if (this.disposed || this.legacyTabsMigrated || this.legacyTabsMigrating || !sidebarLayoutV1Enabled) { return false; }
				if (!this.state || !this.getCatalogSnapshot().pages.length) { return false; }
				this.legacyTabsMigrating = true;
				try {
					const storage = typeof window !== 'undefined' ? window.localStorage : null;
					if (!storage) { this.legacyTabsMigrated = true; return false; }
					if (storage.getItem(LEGACY_TABS_MIGRATED_KEY)) { this.legacyTabsMigrated = true; return false; }
					if (Array.isArray(this.state.homeWorkbenchOrder) && this.state.homeWorkbenchOrder.length) {
						this.legacyTabsMigrated = true;
						storage.setItem(LEGACY_TABS_MIGRATED_KEY, '1');
						return false;
					}
					let tabs = [];
					try { tabs = JSON.parse(storage.getItem(LEGACY_TABS_KEY) || '[]'); } catch { tabs = []; }
					const pages = this.getCatalogSnapshot().pages;
					const keys = legacyTabKeysOf(tabs, pages);
					if (!keys.length) {
						this.legacyTabsMigrated = true;
						storage.setItem(LEGACY_TABS_MIGRATED_KEY, '1');
						return false;
					}
					await this.commit(state => {
						const order = normalizeHomeOrder(keys, pages.map(page => page.key));
						state.homeWorkbenchOrder = order;
						state.homeItemOrder = order;   // 统一排序字段同步落地，旧存档仍可读
					});
					this.legacyTabsMigrated = true;
					storage.setItem(LEGACY_TABS_MIGRATED_KEY, '1');
					return true;
				} catch (error) {
					console.warn('[vssaros-workbenches] 旧页签顺序迁移失败：' + String(error && error.message || error));
					return false;
				} finally {
					this.legacyTabsMigrating = false;
				}
			}
			/**
			 * 登记一个非 `register()` 形态的可导航工作台页（SSR route / 组件式）。
			 * 它不占 `providers`、不注册 `main` 面板，只进入统一目录，供 P2 右栏适配器和主页读取。
			 */
			registerPage(descriptor, renderer) {
				if (!descriptor || typeof descriptor !== 'object') { throw new Error('Invalid workbench page registration'); }
				const workbenchId = typeof descriptor.workbenchId === 'string' && descriptor.workbenchId.trim()
					? descriptor.workbenchId.trim()
					: identityOf(descriptor.repository, descriptor.package);
				const pageId = typeof descriptor.pageId === 'string' && descriptor.pageId.trim() ? descriptor.pageId.trim() : 'default';
				const sourcePackage = descriptor.package || '';
				const pageFallback = {
					title: descriptor.title || '未命名工作台',
					description: typeof descriptor.description === 'string' ? descriptor.description : '',
					icon: typeof descriptor.icon === 'string' ? descriptor.icon : '',
					sourcePackage,
					sourceKind: descriptor.sourceKind || 'external',
					Component: typeof renderer === 'function' ? renderer : null,
					hidden: descriptor.hidden === true,
					retired: descriptor.retired === true,
					enabled: descriptor.enabled !== false,
				};
				const page = normalizeCatalogPage({
					...descriptor,
					id: pageId,
					component: renderer,
					sourcePackage,
				}, workbenchId, pageFallback);
				if (this.catalogPages.has(page.key)) { throw new Error('Duplicate workbench catalog page: ' + page.key); }
				this.catalogPages.set(page.key, page);
				if (typeof renderer === 'function') { this.catalogRenderers.set(page.key, renderer); }
				this.catalogRevision += 1;
				this.publish();
				return () => {
					if (this.catalogPages.get(page.key) !== page) { return; }
					this.catalogPages.delete(page.key);
					this.catalogRenderers.delete(page.key);
					this.catalogRevision += 1;
					this.publish();
				};
			}
			/**
			 * 阶段 4 硬退役：manifest 中的 active route 行直接进统一目录，
			 * 不再读取旧全局清单、轮询或监听 tabs-change。
			 * `component` 行优先复用 `__vssarosPageComponents` 里的组件 renderer。
			 */
			registerManifestPages() {
				const components = globalThis.__vssarosPageComponents && typeof globalThis.__vssarosPageComponents === 'object'
					? globalThis.__vssarosPageComponents : {};
				let changed = false;
				for (const row of WORKBENCH_MANIFEST) {
					if (!row || row.state !== 'active' || row.sourceKind !== 'manifest' || !row.route) { continue; }
					if (this.catalogPages.has(row.key) || this.manifestCatalogDisposers.has(row.key)) { continue; }
					const renderer = row.component && typeof components[row.component] === 'function'
						? components[row.component] : null;
					const descriptor = {
						workbenchId: row.workbenchId, pageId: row.pageId, title: row.title,
						description: row.description || '', icon: row.icon || '', route: row.route,
						hidden: false, retired: false, enabled: true,
						sourceKind: row.sourceKind || 'manifest', sourcePackage: row.sourcePackage || '', package: row.sourcePackage || '',
						canonicalId: row.canonicalId, state: row.state, visibility: row.visibility,
						aliases: [...row.aliases], replacedBy: row.replacedBy,
						component: renderer,
					};
					try {
						this.manifestCatalogDisposers.set(row.key, this.registerPage(descriptor, renderer));
						changed = true;
					} catch (error) {
						console.warn('[vssaros-workbenches] manifest 目录项登记失败：' + String(error && error.message || error));
					}
				}
				globalThis.__vssarosWorkbenchManifestPagesRegistered = true;
				return changed;
			}
			buildSnapshot() {
				return Object.freeze({
					active: this.active,
					stateError: this.stateError,
					state: this.state,
					selectedWorkspaceId: this.workspaceSelections.get(this.active) || null,
					// ★ 2026-11-13：列表出口按下线名单过滤（只摘 UI item，不动 providers ⇒ 页面本体/深链仍在）。
					workbenches: [...this.providers.values()]
						.filter(e => !RETIRED_WORKBENCH_IDS.includes(e.id))
						.map(e => Object.freeze({
							id: e.id, title: e.title, description: e.description || '', icon: e.icon || '',
							customFrame: e.customFrame, headerLayout: e.headerLayout, layout: e.layout, panel: e.panel,
							splitConversation: e.splitConversation === true,
							added: !!(this.state && this.state.added.includes(e.id)),
						})),
					// 注册失败（见 constructor 的注释）：界面据此告诉用户"为什么没出现"，而不是静默。
					registrationFailures: this.registrationFailures.size
						? [...this.registrationFailures.values()].map(f => Object.freeze({ ...f }))
						: [],
				});
			}

			/**
			 * 记一条注册失败并刷新快照（调用方据此在界面上显示）。
			 * @param source 来源标识：调用方包名 > 描述符的 package/repository > '(未知来源)'
			 * @param stage  'identity'（身份/校验不过）| 'slot'（面板挂载失败）| 'duplicate'（身份重复）
			 * @param error  原始错误（保留 message，不吞栈）
			 */
			recordRegistrationFailure(source, stage, error) {
				const key = String(source || '(未知来源)');
				this.registrationFailures.set(key, {
					source: key,
					stage,
					message: String((error && error.message) || error || '未知错误'),
					at: new Date().toISOString(),
				});
				this.publish();
			}
			/** 注册成功时清掉同一来源的旧失败（否则用户会一直看到一个已经不成立的结论）。 */
			clearRegistrationFailure(source) {
				if (!this.registrationFailures.has(source)) { return; }
				this.registrationFailures.delete(source);
				this.publish();
			}
			publish() {
				this.snapshot = this.buildSnapshot();
				this.publishCatalog();
				for (const l of [...this.listeners]) { try { l(); } catch (e) { console.error('[vssaros-workbenches] listener', e); } }
			}

			register(descriptor, Component) {
				// 本地身份的回退来源：调用方客户端包名（官方同款取法 `ctx.fiber.entry.options.name`）。
				// 拿不到不影响带 repository 的工作台；只有省略 repository 时才必须有它。
				let caller;
				try {
					const name = this.ctx && this.ctx.fiber && this.ctx.fiber.entry && this.ctx.fiber.entry.options
						? this.ctx.fiber.entry.options.name : undefined;
					if (typeof name === 'string' && name.trim()) { caller = name.trim(); }
				} catch (e) { caller = undefined; }
				/**
				 * 界面上的来源标识：优先**调用方包名**（用户装的就是它，报出来的才是他认识的名字），
				 * 其次描述符里写的 `package` / `repository`，最后给一个明确的"未知来源"。
				 * ⚠ 身份（entry.id）可能因为校验失败而算不出来 ⇒ 这里**不能**依赖它。
				 */
				const sourceLabel = caller
					|| (typeof descriptor?.package === 'string' && descriptor.package.trim())
					|| (typeof descriptor?.repository === 'string' && descriptor.repository.trim())
					|| '(未知来源)';
				let entry;
				try {
					entry = normalize(descriptor, Component, caller);
					if (this.providers.has(entry.id)) { throw new Error('Duplicate workbench provider: ' + entry.id); }
					for (const page of entry.pages) {
						if (this.catalogPages.has(page.key)) { throw new Error('Duplicate workbench catalog page: ' + page.key); }
					}
				} catch (error) {
					// 记录（含阶段与原因）后**原样抛**：调用方的 ctx.effect 仍要看到失败，
					// 我们不能把"注册失败"变成"静默跳过"（那样插件会以为自己注册成功了）。
					const duplicate = /^Duplicate workbench provider/.test(String(error && error.message));
					this.recordRegistrationFailure(sourceLabel, duplicate ? 'duplicate' : 'identity', error);
					throw error;
				}
				entry.Component = Component;
				this.providers.set(entry.id, entry);
				const service = this;
				const Panel = function VssarosWorkbenchPanel() {
					React.useEffect(() => { service.activate(entry.id); return () => service.deactivate(entry.id); }, []);
					return h(Frame, { service, entry });
				};
				let disposeSlot = null;
				try {
					disposeSlot = this.ctx.slots.register({ name: 'main', key: entry.panel }, Panel);
				} catch (error) {
					this.providers.delete(entry.id);
					this.recordRegistrationFailure(sourceLabel, 'slot', error);
					throw error;
				}
				// P1：register() 的所有页面（默认页 + 可选声明子页）进入统一目录；
				// renderer 只放内部 Map，catalog 快照不含 React Component。
				entry.catalogKeys = entry.pages.map(page => page.key);
				for (const page of entry.pages) {
					this.catalogPages.set(page.key, page);
					if (typeof page.Component === 'function') { this.catalogRenderers.set(page.key, page.Component); }
				}
				this.catalogRevision += 1;
				// 同一个来源这次成功了 ⇒ 清掉它之前的失败记录（不留过期结论）
				this.clearRegistrationFailure(sourceLabel);
				this.publish();
				return () => {
					if (this.providers.get(entry.id) !== entry) { return; }
					this.providers.delete(entry.id);
					for (const key of entry.catalogKeys) {
						this.catalogPages.delete(key);
						this.catalogRenderers.delete(key);
					}
					this.catalogRevision += 1;
					if (this.active === entry.id) { this.leave(); }
					if (typeof disposeSlot === 'function') { disposeSlot(); }
					this.publish();
				};
			}
			has(id) { return this.providers.has(id); }
			entryOf(id) { return this.providers.get(id) || [...this.pageFrames].reverse().find(entry => entry.id === id); }
			available(id) { return !!this.entryOf(id); }
			registerPageFrame(entry) {
				this.pageFrames.push(entry);
				this.publish();
				return () => {
					const index = this.pageFrames.indexOf(entry);
					if (index >= 0) { this.pageFrames.splice(index, 1); }
					if (!this.available(entry.id)) { this.deactivate(entry.id); }
					this.publish();
				};
			}

			// ── 会话接口（2026-10-22，与官方宿主同名同语义；client.js:884-1243）────────────────
			// 归属写 `sessionBindings`（不可改不可删）。显示位置分两种：
			//   · **整页工作台（customFrame）**：对话**嵌在工作台自己的页面里**（组件拿到的 `conversation` 节点）——
			//     ★ 真机报障「点 AI 协助后自动关闭了小红书工作台」：原先这里一律切到原生对话（selectPanel(null)），
			//     工作台被换走。现在走"会话停靠"：宿主在根覆盖层登记一个声明了 session 作用域子槽的条目
			//     （与官方右栏子会话聊天 `dsh-client-ui-subagent` 同一机制：SessionProvider + conversation.content），
			//     用 portal 把对话渲染进工作台的 `conversation` 节点 ⇒ 工作台不离开；
			//   · **标准分栏**：rc.1 的宿主还没有分栏外框 ⇒ 仍切到原生对话（旧行为）。
			/** 调用方的工作台身份：只认**前台**那个（第三方 API 都是在自己的组件里调的，前台 = 自己）。 */
			ownerId() {
				const id = this.active;
				if (!id || !this.available(id)) { throw new Error('请先打开可用的工作台。'); }
				return id;
			}
			isActive() { return this.active !== null && this.available(this.active); }
			/**
			 * 这个工作台的对话**怎么显示**（2026-11-02 对齐 dsh-desktop §4.1）：
			 *   · `inline` —— customFrame：对话嵌在工作台自己页面里（`props.conversation`）；
			 *   · `split`  —— 标准分栏（未声明 customFrame 的默认）：宿主渲染左对话 / 右业务；
			 *   · `detach` —— `splitConversation: false`：点会话就切到原生会话页（旧行为，逃生门）。
			 */
			conversationMode(id) {
				const entry = id ? this.entryOf(id) : null;
				if (!entry) { return 'detach'; }
				if (this.docks.some(dock => dock.id === id && dock.fallback)) { return 'inline'; }
				if (entry.customFrame) { return 'inline'; }
				return entry.splitConversation === false ? 'detach' : 'split';
			}
			/** 对话是否停靠在宿主/工作台里（inline 或 split 都算；detach 不算）。 */
			docksConversation(id) { return this.conversationMode(id) !== 'detach'; }
			/** 工作台停靠显示的会话：本次会话里指定的 ⇒ 否则持久化的最近会话；必须归属它、且没被判死。 */
			dockedSessionOf(id) {
				if (!id || !this.state) { return null; }
				const sid = this.docked.get(id) || this.state.recentSessions[id] || null;
				if (!sid || this.dead.has(sid) || this.state.sessionBindings[sid] !== id) { return null; }
				return sid;
			}
			/**
			 * 标准分栏左栏显示的会话：优先停靠/最近会话；
			 * 否则"当前主视图会话**且归属本工作台**"（用户在工作台模式下新开会话时，宿主直接把它放进左栏）。
			 * ⚠ 不属于本工作台的会话**绝不**抢到分栏里（那会把用户的普通会话藏起来）。
			 */
			splitSessionOf(id) {
				const docked = this.dockedSessionOf(id);
				if (docked) { return docked; }
				if (!id || !this.state) { return null; }
				const sid = this.currentSession();
				if (!sid || this.dead.has(sid) || this.state.sessionBindings[sid] !== id) { return null; }
				return sid;
			}
			/** 工作台页面里的停靠点（`conversation` 节点挂载时登记；后登记的优先）。返回注销函数。 */
			registerDock(id, element, fallback = false) {
				const record = { id, element, fallback };
				this.docks.push(record);
				this.publish();
				return () => {
					const i = this.docks.indexOf(record);
					if (i >= 0) { this.docks.splice(i, 1); this.publish(); }
				};
			}
			/** 标准分栏左栏的停靠点（宿主 Frame 里渲染；一个工作台同时只有一个）。返回注销函数。 */
			registerSplitDock(id, element) {
				const previous = this.splitDocks.get(id);
				if (previous === element) { return () => { }; }
				this.splitDocks.set(id, element);
				this.publish();
				return () => {
					if (previous) { this.splitDocks.set(id, previous); }
					else if (this.splitDocks.get(id) === element) { this.splitDocks.delete(id); }
					this.publish();
				};
			}
			/** 覆盖层该往哪儿渲染对话：前台工作台的停靠点 + 它的会话（任一缺失 ⇒ null）。 */
			dockTarget() {
				const id = this.active;
				if (!id) { return null; }
				const mode = this.conversationMode(id);
				if (mode === 'detach') { return null; }
				const docks = [...this.docks].reverse();
				const element = mode === 'inline'
					? (docks.find(d => d.id === id && !d.fallback) || docks.find(d => d.id === id))?.element
					: this.splitDocks.get(id);
				const sessionId = mode === 'inline' ? this.dockedSessionOf(id) : this.splitSessionOf(id);
				return element && sessionId ? { id, element, sessionId, mode } : null;
			}
			/** 停靠会话打不开（已删除 / 归档 / 加载失败）⇒ 本次运行不再尝试，页面回到"开始对话"。 */
			markDead(sessionId, error) {
				if (!sessionId || this.dead.has(sessionId)) { return; }
				this.dead.add(sessionId);
				this.dockError = String(error && error.message || error || '对话打不开');
				console.warn('[vssaros-workbenches] 停靠会话打不开：' + sessionId, error);
				this.publish();
				}
				/**
				* 会话是否**还存在**（被删/归档 ⇒ `sessions.retain` 会抛 `unknown session`）。
				* ★ 2026-10-28 真机：侧栏里那条失效会话点了以后 `retain` 抛错 ⇒ 对话列永远停在"开始对话"
				*   ⇒ 看起来就是"点会话没反应"。所以停靠之前必须先验活。
				* ⚠ 读不到快照时**保守当它存在**（宁可 retain 抛错，也不要误杀正常会话）。
				*/
				sessionExists(sessionId) {
				if (!sessionId) { return false; }
				try {
					const list = this.ctx.sessions.list.getSnapshot();
					if (list && list.byId && list.byId[sessionId]) { return true; }
					return false;
				} catch { return true; }
				}
				/**
			 * 这个会话**能不能被 retain**。
			 * ★ 2026-10-28 真机（两轮）：先用"blank 且没被任何视图持有"来**猜**，结果把**刚新建的会话**
			 *   也判成不可用（新建的会话此刻就是 blank 且 retainedBy 为空）⇒ 自己新建的会话反而 dock 不上 ✗
			 *   ⇒ 改成**直接试**：`ctx.sessions.retain(sid)` 成功即可用（立刻 release 掉，保持计数平衡），
			 *     抛异常（unknown session）才判定不可用。
			 *   （dsh 自己的口径是 retain 抛不抛，不是我们猜的字段。）
			 */
			sessionRetainable(sessionId) {
				if (!sessionId) { return false; }
				let ref = null;
				try {
					ref = this.ctx.sessions.retain(sessionId);
				} catch (e) {
					console.warn('[vssaros-workbenches] 会话无法 retain：' + sessionId + '（' + String((e && e.message) || e) + '）');
					return false;
				}
				try { if (ref && typeof ref.release === 'function') { ref.release(); } } catch (e) { /* 忽略 */ }
				return true;
			}
			/** 清理失效的最近会话指针，保留不可变的历史归属。 */
			clearStaleBinding(owner, sessionId) {
				if (!owner || !sessionId) { return Promise.resolve(); }
				if (this.docked.get(owner) === sessionId) { this.docked.delete(owner); }
				return this.commit(state => {
					if (state.recentSessions[owner] === sessionId) { delete state.recentSessions[owner]; }
				}).catch(error => {
					console.warn('[vssaros-workbenches] 清理最近会话失败（' + owner + '）：' + String(error && error.message || error));
				});
			}
			/** 当前会话：整页工作台 ⇒ 它停靠的会话；否则主视图里的会话（官方判据：retainedBy.mainView > 0）。 */
			currentSession() {
				if (this.docksConversation(this.active)) {
					const docked = this.dockedSessionOf(this.active);
					if (docked) { return docked; }
				}
				try {
					const { byId } = this.ctx.sessions.list.getSnapshot();
					return Object.keys(byId || {}).find(id => ((byId[id] && byId[id].retainedBy && byId[id].retainedBy.mainView) || 0) > 0);
				} catch { return undefined; }
			}
			ownsSession(sessionId) {
				const id = this.active;
				return !!(id && sessionId && this.state && this.state.sessionBindings[sessionId] === id);
			}
			/**
			 * 默认工作区（给新会话挑根目录）。顺序很重要：
			 *
			 * ① **前台主视图会话所在的工作区** —— 用户此刻正在这个项目里工作，助手就该在这里开会话；
			 * ② 本工作台最近一次会话所在的工作区（保持连续性）；
			 * ③ 列表第一个（兜底）。
			 *
			 * ★ 2026-11-02（用户：「商城聊天框中，工作区显示的名字与工作区根目录不一致」）：
			 *   之前只有 ②③。②在有历史绑定时会指向**很久以前**那个项目（实测商城助手开在
			 *   `Saros-agents-pocket`，而用户当前工作区是 `sarosis-agents-client`）⇒ 对话栏 chip 显示
			 *   Saros-agents-pocket、而界面别处写的是当前会话 cwd=…\sarosis-agents-client，看起来"名字对不上目录"。
			 *   现在优先跟随用户当前工作区 —— 这也符合直觉：助手默认在你正在做的事里。
			 */
			/** 左栏会话按工作台归属派生，普通会话模式不混入工作台历史。 */
			sessionVisible(sessionId, owner = this.active) {
				if (!this.state) { return true; }
				const binding = this.state.sessionBindings[sessionId];
				return owner ? binding === owner : !binding;
			}
			workspaceVisible(workspaceId, owner = this.active) {
				return !owner || !(this.state && this.state.hiddenWorkspaces[owner] || []).includes(workspaceId);
			}
			visibleWorkspaces(owner = this.active) {
				try { return this.ctx.workspaces.list.getSnapshot().items.filter(w => this.workspaceVisible(w.workspaceId, owner)); }
				catch { return []; }
			}
			workspaceFor(sessionId) {
				try {
					return this.ctx.workspaces.list.getSnapshot().items.find(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId)) || null;
				} catch { return null; }
			}
			selectWorkspace(owner, workspaceId) {
				if (!this.available(owner) || !this.visibleWorkspaces(owner).some(w => w.workspaceId === workspaceId)) {
					throw new Error('这个工作区当前不可用，请重新选择。');
				}
				this.workspaceSelections.set(owner, workspaceId);
				try { window.sessionStorage.setItem('vssaros.workbench.workspaces', JSON.stringify(Object.fromEntries(this.workspaceSelections))); }
				catch { /* Session storage can be unavailable. */ }
				this.publish();
			}
			hideWorkspace(workspaceId, owner = this.active) { return this.hideWorkspaces([workspaceId], owner); }
			async hideWorkspaces(workspaceIds, owner = this.active) {
				if (!owner) { return false; }
				if (!this.available(owner)) { throw new Error('工作台当前不可用。'); }
				const available = this.ctx.workspaces.list.getSnapshot().items;
				if (!workspaceIds.length || !workspaceIds.every(id => available.some(w => w.workspaceId === id))) { throw new Error('工作区当前不可用。'); }
				await this.commit(state => {
					if (!state.added.includes(owner)) { throw new Error('请先打开工作台。'); }
					state.hiddenWorkspaces[owner] = [...new Set([...(state.hiddenWorkspaces[owner] || []), ...workspaceIds])];
				});
				return true;
			}
			async showWorkspace(workspaceId, owner = this.active) {
				if (!owner || !this.available(owner)) { throw new Error('工作台当前不可用。'); }
				if (this.workspaceVisible(workspaceId, owner)) { return; }
				await this.commit(state => {
					state.hiddenWorkspaces[owner] = (state.hiddenWorkspaces[owner] || []).filter(id => id !== workspaceId);
				});
			}
			defaultWorkspace(owner = this.active) {
				const items = this.visibleWorkspaces(owner);
				if (!items.length) { return null; }
				const selected = items.find(w => w.workspaceId === this.workspaceSelections.get(owner));
				if (selected) { return selected; }
				const bySession = sessionId => sessionId ? items.find(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId)) : null;
				let main;
				try {
					const { byId } = this.ctx.sessions.list.getSnapshot();
					main = Object.keys(byId || {}).find(id => (((byId[id] || {}).retainedBy || {}).mainView || 0) > 0);
				} catch { main = undefined; }
				return bySession(main) || bySession(owner && this.state && this.state.recentSessions[owner]) || items[0];
			}
			/** 把某条会话停靠到该工作台并广播（内部用；调用方已确认归属） */
			dockTo(id, sessionId) {
				this.docked.set(id, sessionId);
				this.dead.delete(sessionId);
				this.dockError = null;
				this.publish();
			}
			/**
			 * 显示一条会话：整页工作台就**停靠在它自己页面里**（不离开工作台）。
			 *
			 * ★★ 2026-10-24 真机报障「bot 工作台里切换工作区 ⇒ 自动跳到了会话页面」：
			 *   旧实现只认"会话已归属本工作台"（`sessionBindings[sid] === id`），否则一律
			 *   `uiWorkspace.openSession + layout.selectPanel(null)` ⇒ **工作台被换走** ✗。
			 *   但"在工作台里切工作区/切会话"得到的会话，通常是**未归属**的新会话
			 *   （归属是宿主给"工作台自己新建的会话"打的标记）⇒ 必走 fallback ⇒ 必被踢出去。
			 *   与 2026-10-22 小红书那次同一个根因（见上方 `docksConversation` 的注释）。
			 *
			 * ⇒ 现在的口径（前台是整页工作台时）：
			 *   · 已归属本工作台  ⇒ 直接停靠
			 *   · **未归属任何工作台 ⇒ 自动绑定到本工作台再停靠**（用户是在这个工作台里点的，意图明确）
			 *   · 已归属别的工作台 ⇒ 如实报错（`dockError`），**不**把用户踢出工作台
			 *   · 标准分栏（split）⇒ 同样停靠（进左栏），不再切走 —— 2026-11-02 对齐官方 §4.1
			 *   · `splitConversation: false` ⇒ 保持旧行为（切原生对话）
			 */
			showSession(sessionId, id = this.active, ticket = ++this.navigation) {
				if (this.disposed || id !== this.active || ticket !== this.navigation) { return; }
				// ⚠ 2026-10-28：这里**不做** sessionExists 前置 —— 新建会话在这一刻往往还没进
				//   sessions.list 快照，前置检查会把它误判成"已不存在"⇒「＋ 新建会话」没反应。
				//   真失效的会话交给停靠区的 retain 判定（失败 ⇒ markDead + 清绑定 ⇒ 回到「开始对话」）。
				if (this.docksConversation(id) && this.state) {
					const owner = this.state.sessionBindings[sessionId];
					if (owner === id) { this.dockTo(id, sessionId); return; }
					if (!owner) {
						// 自动绑定：抢不到（并发下被别人先绑）⇒ 报错但**不**跳出
						Promise.resolve(this.bindSession(id, sessionId, () => this.navigationCurrent(id, ticket), true))
							.then(() => { if (this.navigationCurrent(id, ticket)) { this.dockTo(id, sessionId); } })
							.catch(e => {
								if (this.navigationCurrent(id, ticket)) { this.dockError = String(e && e.message || e || '会话绑定失败'); this.publish(); }
							});
						return;
					}
					this.dockError = '这个会话属于另一个工作台（' + owner + '），不能在这里显示。';
					this.publish();
					return;
				}
				this.ctx.uiWorkspace.openSession(sessionId);
				try { this.ctx.layout.selectPanel(null); } catch { /* 布局服务已卸载 */ }
			}
			async bindSession(owner, sessionId, remember = () => true, requireAdded = false) {
				await this.commit(state => {
					if (requireAdded && (!this.available(owner) || !state.added.includes(owner))) { return; }
					const prev = state.sessionBindings[sessionId];
					// ⚠ 归属**不能改**：服务端 `validateState` 会拒（"不能改变或删除已有会话的工作台归属"）。
					//   每个工作台都建**自己的**会话（见 createOwnSession），根本不需要共用别人的。
					if (prev && prev !== owner) { throw new Error('此会话已属于另一个工作台，不能重新绑定。'); }
					if (!state.added.includes(owner)) { state.added.push(owner); }
					state.sessionBindings[sessionId] = owner;
					if (remember()) { state.recentSessions[owner] = sessionId; }
				});
			}
			/** Batch ownership registration for backend-created sessions; never moves navigation or the recent conversation. */
			async bindSessions(owner, sessionIds) {
				await this.queue;
				if (!this.state) { await this.load(); }
				if (this.disposed || this.active !== owner || !this.available(owner) || !this.state?.added.includes(owner)) { return; }
				const ids = [...new Set(sessionIds)];
				if (!ids.some(id => this.state.sessionBindings[id] !== owner)) { return; }
				await this.commit(state => {
					if (this.active !== owner || !this.available(owner) || !state.added.includes(owner)) { return; }
					for (const id of ids) {
						const previous = state.sessionBindings[id];
						if (previous && previous !== owner) { throw new Error('此会话已属于另一个工作台，不能重新绑定。'); }
						state.sessionBindings[id] = owner;
					}
				});
			}
			/** 兼容旧入口；异步流程只使用发起时确定的工作台身份。 */
			async newSession(workspaceId) { return this.newSessionFor(this.ownerId(), workspaceId); }
			navigationCurrent(owner, ticket) {
				return !this.disposed && this.active === owner && this.navigation === ticket && this.available(owner);
			}
			async newSessionFor(owner, workspaceId) {
				if (!this.available(owner) || this.active !== owner) { throw new Error('请先打开可用的工作台。'); }
				const workspace = workspaceId || this.defaultWorkspace(owner)?.workspaceId;
				if (!workspace) { return this.newWorkspaceSessionFor(owner); }
				this.selectWorkspace(owner, workspace);
				const ticket = ++this.navigation;
				const preset = await this.readyPreset(owner);
				if (!this.navigationCurrent(owner, ticket)) { return undefined; }
				const sessionId = await this.createOwnSession(workspace, preset);
				if (this.disposed || !this.available(owner)) { return sessionId; }
				await this.bindSession(owner, sessionId, () => this.navigationCurrent(owner, ticket), true);
				if (preset) { this.presetApplied.add(owner + '|' + sessionId); }
				if (!this.navigationCurrent(owner, ticket)) { return sessionId; }
				this.showSession(sessionId, owner, ticket);
				if (!preset) { this.applyDefaultPreset(owner, sessionId); }
				return sessionId;
			}
			/** 内嵌助手切区不换绑主视图，也不修改已有会话 cwd。 */
			switchWorkspaceForAssistant(owner, workspaceId) {
				return this.newSessionFor(owner, workspaceId);
			}
			async openSessionFor(owner, sessionId) {
				if (this.active !== owner || !this.available(owner) || this.state?.sessionBindings[sessionId] !== owner) {
					throw new Error('会话不属于当前工作台。');
				}
				const ticket = ++this.navigation;
				await this.bindSession(owner, sessionId, () => this.navigationCurrent(owner, ticket), true);
				if (this.navigationCurrent(owner, ticket)) {
					if (this.entryOf(owner).sessionNavigation === 'native') { this.ctx.uiWorkspace.openSession(sessionId); }
					else { this.showSession(sessionId, owner, ticket); }
				}
				return sessionId;
			}
			/**
			 * 给一个工作台建一条**它自己的**新会话（不复用任何现成会话）。
			 *
			 * ★ 2026-11-02 根治（用户：「不同工作台中聊天框的 agent 使用不当，多轮修复始终反复出错」）：
			 *   之前走 `uiWorkspace.connectBlank(ws, { agentPreset })`。它带第二个参数时会**复用工作区里现成的
			 *   空会话**（`createInWorkspace` 找 blank + cwd 相同 + 未归档的那条）⇒ 同一工作区里的多个工作台
			 *   **必然拿到同一条会话** ⇒ agent 是会话属性，后写者赢（知识库显示「商城助手」就是这么来的）；
			 *   而复用到的那条已归属别家，又逼出了"借用"这种共享显示（已删）。
			 *   官方「全新会话」的写法就是 `connectBlank(ws)` 不带参数 = `sessions.create({ workspaceId })`；
			 *   宿主侧 `session.create` 只在显式传 `sessionId` 时才复用，并且**建完一定 `workspace.attachSession`**
			 *   ⇒ 新会话一定登记进工作区（输入框可用的前提），也一定是独占的。
			 * preset 被拒（理论上不会：调用方只传 list() 里存在的）⇒ 退回不带 preset，不能因此建不出会话。
			 */
			async createOwnSession(workspace, preset) {
				if (preset) {
					try { return await this.ctx.sessions.create({ workspaceId: workspace, agentPreset: preset }); }
					catch (error) {
						console.warn('[vssaros-workbenches] 带 agentPreset 建会话失败，退回默认：' + preset + '（' + String((error && error.message) || error) + '）');
					}
				}
				return this.ctx.sessions.create({ workspaceId: workspace });
			}
			/**
			 * 诊断：这条停靠会话**能不能正常输入**（每条只报一次）。
			 *
			 * 判据来自官方 conversation：hero 空态下，会话必须能反查到工作区（`workspace.sessionIds`），
			 * 否则输入框渲染成「选择一个工作区开始」且 `inert`（不可输入）。
			 * 所以「输入不了」= 这条会话没进任何工作区。首次发现时先让 sessions 重读一次快照
			 * （新会话可能还没进客户端索引），仍查不到才告警 —— 告警里带够定位用的数字。
			 */
			diagnoseDock(owner, sessionId) {
				if (!sessionId || this.dockedDiag.has(sessionId)) { return; }
				this.dockedDiag.add(sessionId);
				const read = () => {
					const snapshot = this.ctx.workspaces && this.ctx.workspaces.list ? this.ctx.workspaces.list.getSnapshot() : null;
					const items = (snapshot && snapshot.items) || [];
					let summary;
					try { summary = this.ctx.sessions.list.getSnapshot().byId[sessionId]; } catch { summary = undefined; }
					return { snapshot, items, summary, mapped: items.find(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId)) };
				};
				const report = (state, refreshed) => {
					if (state.mapped) { return; }
					console.warn('[vssaros-workbenches] 停靠会话不属于任何工作区 ⇒ 空态下输入框会退化成「选择一个工作区开始」（不可输入）：'
						+ sessionId + ' cwd=' + String(state.summary && state.summary.cwd || '(无)')
						+ ' blank=' + String(state.summary && state.summary.blank)
						+ ' 工作区phase=' + String(state.snapshot && state.snapshot.phase)
						+ ' 工作区数=' + state.items.length
						+ ' 刷新过=' + String(refreshed));
					this.healDock(owner, state.summary);
				};
				const first = read();
				if (first.mapped || !first.summary) { return; }
				// 新会话可能还没进客户端索引 ⇒ 重读一次再判定（不重试，避免抖动）
				Promise.resolve()
					.then(() => (typeof this.ctx.sessions.refresh === 'function' ? this.ctx.sessions.refresh() : undefined))
					.then(() => report(read(), true))
					.catch(() => report(first, false));
			}
			/**
			 * 自愈：工作台 `owner` 停靠的是一条**没被任何工作区收录的空会话** ⇒ 给它建一条**自己的**新会话换上。
			 *
			 * 为什么要有：工作区记录被重建过（实测 `sarosis-agents-client` 的 createdAt 晚于那批会话）时，
			 * 老会话的登记随之丢失，而工作台打开时停靠的正是 `recentSessions` 里那条 ⇒ 每次打开都是禁用输入框。
			 * 只救**空会话**（有内容时 `hero=false`，输入本来就是正常的）；每个工作台只救一次（防循环）；
			 * 没有可用工作区时**不救**（那会弹原生选目录对话框，比"输入不了"更吓人）。
			 * ⚠ `owner` 由调用方传入（就是停靠这条会话的那个工作台），**不读** `this.active` ——
			 *   多页签同时挂载时前台不一定是它，读错了就会把新会话建给别的工作台。
			 */
			healDock(owner, summary) {
				if (!owner || !this.available(owner)) { return; }
				if (!summary || summary.blank !== true) { return; }
				if (this.dockHealed.has(owner)) { return; }
				const workspace = this.defaultWorkspace(owner);
				if (!workspace || !workspace.workspaceId) { return; }
				const stillCurrent = () => !this.disposed && this.available(owner) && this.state?.added.includes(owner)
					&& this.dockedSessionOf(owner) === summary.id;
				if (!stillCurrent()) { return; }
				this.dockHealed.add(owner);
				console.warn('[vssaros-workbenches] 停靠的是一条没被工作区收录的空会话，给它换一条自己的新会话：'
					+ String(summary.id || '') + ' @ ' + owner);
				Promise.resolve()
					.then(async () => {
						const preset = await this.readyPreset(owner);
						if (!stillCurrent()) { return; }
						const sessionId = await this.createOwnSession(workspace.workspaceId, preset);
						if (!sessionId || sessionId === summary.id || !stillCurrent()) { return; }
						await this.bindSession(owner, sessionId, stillCurrent, true);
						if (preset) { this.presetApplied.add(owner + '|' + sessionId); }
						if (this.state?.sessionBindings[sessionId] !== owner || this.disposed || !this.available(owner)) { return; }
						const current = this.dockedSessionOf(owner);
						if (current !== summary.id && current !== sessionId) { return; }
						this.dockTo(owner, sessionId);
						if (!preset) { this.applyDefaultPreset(owner, sessionId); }
					})
					.catch((error) => console.warn('[vssaros-workbenches] 自动换新会话失败（' + owner + '）：' + String((error && error.message) || error)));
			}
			/**
			 * 这个工作台的 AI 助手默认 agent（preset id）。描述符的 `assistantPreset` 优先（第三方工作台自己声明），
			 * 其次内置表；都没有 ⇒ 空串（不强行指定，沿用宿主默认）。
			 */
			presetOf(id) {
				return this.presetCandidatesOf(id)[0] || '';
			}
			/**
			 * 候选 preset id（按优先级）：描述符自己声明的 `assistantPreset` > 内置表。
			 * 允许数组是通用兜底机制；2026-11-09 起知识库收敛为单值 `vssaros-knowledge-base-expert`
			 * （内置 agent 是真源，数据根的 kb-expert 已移除，存量会话由隐藏别名接管）。
			 * 绝不猜：只认 agentPresets.list() 里真实存在的 id（select 失败返回 {ok:false} 而非抛）。
			 */
			presetCandidatesOf(id) {
				const entry = id ? this.entryOf(id) : null;
				const own = entry && typeof entry.assistantPreset === 'string' ? entry.assistantPreset.trim() : '';
				const table = ASSIST_PRESET_BY_WB[String(id || '')];
				const list = [own].concat(Array.isArray(table) ? table : (table ? [table] : []));
				return [...new Set(list.filter(Boolean))];
			}
			/**
			 * 候选里**真实存在**的那个 preset（以 `agentPresets.list()` 为准）；不存在 ⇒ 空串。
			 *
			 * ★ 2026-11-02 根治的两条铁律：
			 *   ① **绝不猜**：列表读不到 / 候选都不在 ⇒ 返回空串（用宿主默认）。以前"读不到就退回第一个候选碰运气"，
			 *      而给会话 select 一个本机不存在的 id 会把会话**弄坏**——之后 resume 直接报
			 *      `Unknown agent preset: vssaros-knowledge-base-expert`（真机日志）。
			 *   ② **等它注册**：vssaros-agents 是 lazy 注册（启动只注册几个，其余 ~15s 后补齐），开机那十几秒里
			 *      自定义 preset 都还不在列表里。`waitMs > 0` 时每 `presetPollMs` 重读一次直到出现或超时。
			 * 只缓存**命中**（不缓存"没有"）：没有的那次可能只是还没注册好。
			 */
			async readyPreset(id, { waitMs = 0 } = {}) {
				const entry = this.entryOf(id);
				if (entry && !entry.assistantPreset && !String(id).startsWith('vssaros/') && (entry.resourcePackage || String(id).startsWith('local:'))) {
					try {
						const response = await fetch('/api/vssaros-workbenches/plugin-resources', { cache: 'no-store' });
						if (response.ok) {
							const body = await response.json();
							const info = (body.packages || []).find(row => row.packageName === entry.resourcePackage || 'local:' + row.packageName === id);
							if (info && info.defaultPreset) { entry.assistantPreset = info.defaultPreset; }
						}
					} catch { /* 资源服务未就绪时使用宿主默认，不猜 Bot id */ }
				}
				const candidates = this.presetCandidatesOf(id);
				if (candidates.length === 0) { return ''; }
				if (this.presetResolved.has(id)) { return this.presetResolved.get(id); }
				const started = Date.now();
				for (;;) {
					const roster = await this.presetRoster();
					const hit = roster ? candidates.find(c => roster.has(c)) : '';
					if (hit) { this.presetResolved.set(id, hit); return hit; }
					if (Date.now() - started >= waitMs) {
						if (roster && waitMs > 0 && !this.presetMissingWarned.has(id)) {
							this.presetMissingWarned.add(id);
							console.warn('[vssaros-workbenches] 没有找到 ' + id + ' 的默认 agent（等了 ' + Math.round(waitMs / 1000) + 's，候选都不在 agentPresets 列表里）：' + candidates.join(' / '));
						}
						return '';
					}
					await new Promise(resolve => setTimeout(resolve, this.presetPollMs));
				}
			}
			/** 当前已注册的 preset id 集合；服务缺席 / 调用失败 ⇒ null（调用方据此"不猜"）。 */
			async presetRoster() {
				const svc = this.agentPresets;
				if (!svc || typeof svc.list !== 'function') { return null; }
				try {
					const result = await svc.list();
					// ⚠ 官方失败返回 `{ ok:false }` 而不是抛 ⇒ 必须看 ok
					const rows = result && result.ok && result.value && Array.isArray(result.value.presets) ? result.value.presets : null;
					return rows ? new Set(rows.map(row => (row && typeof row === 'object' ? row.id : row))) : null;
				} catch { return null; }
			}
			/** 工作台 `owner` 的对话栏里**此刻显示**的会话（整页工作台 = 停靠的；标准分栏 = 左栏的）。 */
			sessionShownIn(owner) {
				return this.conversationMode(owner) === 'split' ? this.splitSessionOf(owner) : this.dockedSessionOf(owner);
			}
			/**
			 * 给工作台 `owner` 对话栏里那条**还没开聊**的会话套上它的默认 agent（hero 空态那条可能不是带 preset 建的：
			 * 历史会话、或开机 lazy 窗口里只能先不带 preset 建）。
			 *
			 * ★ 2026-11-02 根治：这是全仓**唯一**会事后改 agent 的地方（各工作台插件里的 select / 包 newSession /
			 *   劫持「新会话」按钮已全部删除）。以前 5 个写入者都对**全局当前会话**下手，多页签同时挂载时互相改对方的。
			 *
			 * 铁律：
			 *   · 只改**这个工作台自己显示**的那条（等待期间换了会话 / 换了归属 ⇒ 放弃）；
			 *   · 只改 **blank**（还没发过话）—— 绝不改进行中的对话；
			 *   · 每条只套**一次**；等待期间 agent 被人改过（用户在 chip 里手动选了）⇒ 尊重，放弃；
			 *   · 只用 list() 里**真实存在**的 id（见 readyPreset），被拒必须看 `ok` 并告警。
			 */
			applyDefaultPreset(owner, sessionId) {
				if (!owner || !sessionId || (this.presetCandidatesOf(owner).length === 0 && !String(owner).startsWith('local:') && !this.entryOf(owner)?.resourcePackage)) { return; }
				const key = owner + '|' + sessionId;
				if (this.presetApplied.has(key)) { return; }
				this.presetApplied.add(key);
				const summaryOf = () => { try { return this.ctx.sessions.list.getSnapshot().byId[sessionId]; } catch { return undefined; } };
				const presetNow = () => { const s = summaryOf(); return s && s.projectionValues ? s.projectionValues.agentPreset : undefined; };
				const stillOurs = () => this.sessionShownIn(owner) === sessionId && !!this.state && this.state.sessionBindings[sessionId] === owner;
				(async () => {
					// 会话摘要可能比停靠晚到几百毫秒；**先等摘要再记初值**（否则"摘要晚到"会被误判成"有人改过 agent"）
					let summary = summaryOf();
					for (let i = 0; !summary && i < 10; i += 1) {
						await new Promise(resolve => setTimeout(resolve, 300));
						summary = summaryOf();
					}
					if (!summary || summary.blank !== true) { return; }
					const before = presetNow();
					const preset = await this.readyPreset(owner, { waitMs: this.presetWaitMs });
					if (!preset) { return; }
					summary = summaryOf();
					if (!summary || summary.blank !== true) { return; }
					if (!stillOurs()) { return; }
					const current = presetNow();
					if (current === preset) { return; }
					if (current !== before) { return; }   // 等待期间被改过（多半是用户手动选的）⇒ 尊重
					const svc = this.agentPresets;
					if (!svc || typeof svc.select !== 'function') { return; }
					const result = await svc.select(sessionId, preset);
					if (result && result.ok === false) {
						const why = (result.error && (result.error.message || result.error.code)) || '未知原因';
						console.warn('[vssaros-workbenches] 套用默认 agent 被拒：' + preset + ' @ ' + sessionId + '（' + why + '）');
					}
				})().catch((error) => console.warn('[vssaros-workbenches] 套用默认 agent 失败（' + owner + '）：' + String((error && error.message) || error)));
			}
			/** 目录选择过期或取消时不创建工作区或会话。 */
			async newWorkspaceSession() { return this.newWorkspaceSessionFor(this.ownerId()); }
			async newWorkspaceSessionFor(owner) {
				if (!this.available(owner) || this.active !== owner) { throw new Error('请先打开可用的工作台。'); }
				const ticket = ++this.navigation;
				const path = await this.ctx.uiWorkspace.pickDirectory();
				if (!path || !this.navigationCurrent(owner, ticket)) { return undefined; }
				const workspace = await this.ctx.workspaces.create({ path });
				if (!this.navigationCurrent(owner, ticket)) { return undefined; }
				await this.showWorkspace(workspace.workspaceId, owner);
				if (!this.navigationCurrent(owner, ticket)) { return undefined; }
				return this.newSessionFor(owner, workspace.workspaceId);
			}
			/**
			 * 确保有一条归属本工作台的会话（官方 1167-1208）：给了已存在的 sessionId ⇒ 校验归属后复用；
			 * 否则按业务文件夹建工作区 + 新会话。`folder` 必填（官方同样拒绝静默选目录）。
			 */
			async ensureSession({ folder, sessionId: saved } = {}) {
				const owner = this.ownerId();
				const ticket = ++this.navigation;
				let byId = {};
				try { if (typeof this.ctx.sessions.refresh === 'function') { await this.ctx.sessions.refresh(); } byId = this.ctx.sessions.list.getSnapshot().byId || {}; } catch { byId = {}; }
				if (!this.navigationCurrent(owner, ticket)) { return undefined; }
				if (saved && byId[saved]) {
					const prev = this.state && this.state.sessionBindings[saved];
					if (prev && prev !== owner) { throw new Error('此会话已属于另一个工作台，不能重新绑定。'); }
					await this.bindSession(owner, saved, () => this.navigationCurrent(owner, ticket), true);
					if (this.navigationCurrent(owner, ticket)) { this.showSession(saved, owner, ticket); }
					return saved;
				}
				if (typeof folder !== 'string' || !folder.trim()) { throw new Error('创建会话需要业务项目文件夹。'); }
				const workspace = await this.ctx.workspaces.create({ path: folder });
				if (!this.navigationCurrent(owner, ticket)) { return undefined; }
				await this.showWorkspace(workspace.workspaceId, owner);
				if (!this.navigationCurrent(owner, ticket)) { return undefined; }
				return this.newSessionFor(owner, workspace.workspaceId);
			}
			/**
			 * 记为前台工作台（不切面板）：嵌入式承载（`View`，如 chat-surface 的页签条）用它记账，
			 * 与 `open()` 共用"首次打开即登记 added"的语义。
			 */
			activate(id) {
				if (!this.available(id)) { return false; }
				if (this.active !== id) { ++this.navigation; this.active = id; this.dockError = null; this.publish(); }
				if (this.state && !this.state.added.includes(id)) {
					void this.add(id).catch(error => console.warn('[vssaros-workbenches] 添加工作台失败：' + String(error && error.message || error)));
				}
				return true;
			}
			/** 打开工作台：业务面板立即可用，不依赖会话（官方 §5）。返回 true = 已打开。 */
			open(id) {
				const entry = this.providers.get(id);
				if (!entry) { return false; }
				this.ctx.layout.selectPanel(entry.panel);
				this.activate(id);
				return true;
			}
			home(id) { return this.open(id); }
			deactivate(owner = this.active) {
				if (this.active === null || this.active !== owner) { return false; }
				++this.navigation;
				this.active = null;
				this.dockError = null;
				this.publish();
				return true;
			}
			leave() {
				if (this.deactivate()) { try { this.ctx.layout.selectPanel(null); } catch { /* 布局服务已卸载 */ } }
			}
			current() { return this.active; }

			async load() {
				try {
					const res = await fetch(STATE_URL, { cache: 'no-store' });
					const data = await res.json();
					if (this.disposed) { return; }
					if (!res.ok) { throw new Error(data && data.error || 'HTTP ' + res.status); }
					this.revision = data.revision;
					this.state = data.state;
					this.stateError = null;
				} catch (error) {
					this.stateError = String(error && error.message || error);
				}
				this.publish();
			}
			/** 带 revision 写入；409 ⇒ 重新加载一次再报错（不自动重放，避免覆盖别处的更新）。 */
			commit(mutate) {
				const task = this.queue.then(async () => {
					if (this.disposed) { throw new Error('工作台服务已卸载。'); }
					if (!this.state) { throw new Error(this.stateError || '工作台状态未加载'); }
					const next = JSON.parse(JSON.stringify(this.state));
					mutate(next);
					const res = await fetch(STATE_URL + '/write', {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ revision: this.revision, state: next }),
					});
					const data = await res.json();
					if (!res.ok) {
						if (res.status === 409) { await this.load(); }
						throw new Error(data && data.error || 'HTTP ' + res.status);
					}
					this.revision = data.revision;
					this.state = data.state;
					this.publish();
					return data;
				});
				this.queue = task.catch(() => { });
				return task;
			}
			add(id) {
				if (!this.available(id)) { return Promise.reject(new Error('工作台当前不可用。')); }
				return this.commit(state => {
					if (!state.added.includes(id)) { state.added.push(id); }
					if (!state.pinned.includes(id)) { state.pinned.push(id); }
				});
			}
			remove(id) {
				if (this.active === id) { ++this.navigation; }
				return this.commit(state => {
					state.added = state.added.filter(x => x !== id);
					state.pinned = state.pinned.filter(x => x !== id);
					if (state.active === id) { state.active = null; }
				}).then(result => { if (this.active === id) { this.leave(); } return result; });
			}
			dispose() {
				this.disposed = true;
				++this.navigation;
				/* 先发布一次空目录：HMR/卸载时订阅者据此撤掉开始页卡片与 native tab，再清监听器。 */
				this.catalogPages.clear();
				this.catalogRenderers.clear();
				this.catalogRevision += 1;
				this.publishCatalog();
				this.listeners.clear();
				this.catalogListeners.clear();
				for (const disposeManifest of this.manifestCatalogDisposers.values()) {
					try { disposeManifest(); } catch { /* HMR 时旧条目可能已回收 */ }
				}
				this.manifestCatalogDisposers.clear();
				if (typeof globalThis !== 'undefined') { delete globalThis.__vssarosWorkbenchManifestPagesRegistered; }
				this.pageFrames = [];
				this.assistantCollapsed.clear();
				this.docks = [];
				this.splitDocks.clear();
			}
		}

		// ── 渲染 ───────────────────────────────────────────────────────────────
		class PanelBoundary extends React.Component {
			constructor(props) { super(props); this.state = { error: null, attempt: 0 }; }
			static getDerivedStateFromError(error) { return { error }; }
			componentDidCatch(error) { console.error('[vssaros-workbenches] 工作台渲染失败：' + this.props.entry.id, error); }
			render() {
				if (this.state.error) {
					return h(PanelFailure, { entry: this.props.entry, error: this.state.error, onRetry: () => this.setState(s => ({ error: null, attempt: s.attempt + 1 })) });
				}
				return h(React.Fragment, { key: this.state.attempt }, this.props.children);
			}
		}
		function PanelFailure({ entry, error, onRetry }) {
			return h('section', { className: 'vssWbFailure', role: 'alert', 'data-vssaros-workbench-failure': entry.id },
				h('h2', null, '工作台加载失败'),
				h('p', null, '「' + entry.title + '」渲染时出错。可以重试；若仍失败，请重启 dsh 或联系工作台作者。'),
				h('pre', null, String(error && error.message || error)),
				h('button', { type: 'button', onClick: onRetry }, '重试'));
		}
		function HeaderHost({ entry, children }) {
			const root = React.useRef(null);
			React.useLayoutEffect(() => {
				const node = root.current;
				const eligible = entry.headerLayout === 'compact' && (entry.customFrame === true || entry.layout.businessSide === 'left');
				if (!node || !eligible) { return undefined; }
				let marked = null;
				let warned = false;
				const update = () => {
					const candidates = node.querySelectorAll('[data-dsh-workbench-toolbar]');
					const toolbar = candidates.length === 1 ? candidates[0] : null;
					if (candidates.length !== 1 && !warned) { console.warn('[vssaros-workbenches] compact layout needs exactly one data-dsh-workbench-toolbar; using default layout'); warned = true; }
					if (toolbar === marked) { return; }
					if (marked) { marked.removeAttribute('data-dsh-compact-toolbar'); }
					marked = toolbar;
					if (toolbar) { toolbar.setAttribute('data-dsh-compact-toolbar', ''); node.setAttribute('data-dsh-compact-valid', 'true'); }
					else { node.removeAttribute('data-dsh-compact-valid'); }
				};
				update();
				const observer = new MutationObserver(update);
				observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-dsh-workbench-toolbar'] });
				return () => { observer.disconnect(); if (marked) { marked.removeAttribute('data-dsh-compact-toolbar'); } node.removeAttribute('data-dsh-compact-valid'); };
			}, [entry.headerLayout, entry.customFrame, entry.layout.businessSide]);
			return h('div', {
				ref: root, className: 'vssWbFrame', 'data-vssaros-workbench': entry.id,
				'data-header-layout': entry.headerLayout, 'data-custom-frame': String(entry.customFrame),
			}, children);
		}
		/** 订阅宿主（工作台停靠状态变化时重画）。 */
		function useService(service) {
			const [, bump] = React.useState(0);
			React.useEffect(() => service.subscribe(() => bump(v => v + 1)), [service]);
			return service;
		}
		/**
		 * customFrame 工作台拿到的 `conversation` 节点 = **对话停靠点**（2026-10-22）。
		 * 结构：外层由 React 管；里面一个**空的** `div[data-vssaros-wb-dock]` 作为 portal 目标（React 从不往里渲染子节点，
		 * 内容由根覆盖层 `ConversationDock` portal 进来）。还没有会话 ⇒ 显示「开始对话」。
		 */
		function ConversationMount({ service, entry, fallback = false }) {
			useService(service);
			const claim = React.useContext(InlineAssistantContext);
			React.useLayoutEffect(() => claim ? claim() : undefined, [claim]);
			const [element, setElement] = React.useState(null);
			React.useEffect(() => (element ? service.registerDock(entry.id, element, fallback) : undefined), [service, element, entry.id, fallback]);
			const docked = service.dockedSessionOf(entry.id);
			const collapsed = !fallback && service.assistantCollapsed.get(entry.id) === true;
			return h('div', { className: 'vssWbDockHost', 'data-vssaros-wb-conversation': entry.id,
				id: fallback ? undefined : 'vssaros-assistant-' + entry.id, hidden: collapsed,
				'data-vssaros-assist-collapsed': fallback ? undefined : collapsed ? '1' : '0' },
				h(NewSessionButton, { service, entry }),
				docked ? null : h(ConversationStart, { service, entry }),
				h('div', { ref: setElement, className: 'vssWbDock', 'data-vssaros-wb-dock': entry.id, hidden: !docked }));
		}
		/**
		 * AI 助手栏**右上角**的「＋ 新会话」（2026-11-02，用户：「所有工作台 AI 助手侧边栏右上角加 +新会话，左上角不要收起按钮」）。
		 *
		 * 为什么在宿主做、不在每个工作台各画一个：商城 / 萨罗斯各自画过一套（还各带一个左上角「» 收起」），
		 * 其余工作台一个都没有 ⇒ 口径不一、位置不一、并行改一处漏一处。宿主的对话栏（ConversationMount /
		 * SplitConversationPane）是所有工作台共用的 ⇒ 放这里，**一份实现、所有工作台都有**。
		 * 收起 / 展开仍由右侧中部的浮动工具栏（« »）负责 —— 对话栏里不再放第二个收起入口。
		 *
		 * 会话由 `service.newSession()` 建：带该工作台的默认 agent（见 presetOf）、归属本工作台、直接停靠进这一栏。
		 */
		function NewSessionButton({ service, entry }) {
			const [busy, setBusy] = React.useState(false);
			const preset = service.presetOf(entry.id);
			return h('button', {
				type: 'button', className: 'vssWbNewSession', 'data-vssaros-wb-new-session': entry.id, disabled: busy,
				title: preset ? '新建一个对话（默认 agent 已选好）' : '新建一个对话',
				onClick: (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					// 按钮所在的工作台就是用户眼前的这个 ⇒ 先把它记为前台（newSession 认的是前台工作台）
					if (service.active !== entry.id) { service.activate(entry.id); }
					setBusy(true);
					Promise.resolve().then(() => service.newSessionFor(entry.id))
						.catch(error => {
							if (service.active === entry.id) {
								service.dockError = String(error && error.message || error || '新建会话失败');
								service.publish();
							}
						})
						.finally(() => setBusy(false));
				},
			}, '＋ 新会话');
		}
		/** 停靠点里的"开始对话"（默认工作区新建；没有工作区 ⇒ 让用户选文件夹）。 */
		function ConversationStart({ service, entry }) {
			useService(service);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState('');
			const [, refresh] = React.useState(0);
			React.useEffect(() => service.ctx.workspaces.list?.subscribe?.(() => refresh(v => v + 1)), [service]);
			const owner = entry.id;
			const workspaces = service.visibleWorkspaces(owner);
			const chosen = service.defaultWorkspace(owner);
			const hidden = (service.state?.hiddenWorkspaces[owner] || []);
			let all = [];
			try { all = service.ctx.workspaces.list.getSnapshot().items; } catch { /* Workspace list is not ready. */ }
			const disabled = busy || !service.state || service.active !== owner;
			const run = fn => {
				setBusy(true); setError('');
				Promise.resolve().then(fn).catch(e => setError(String(e && e.message || e))).finally(() => setBusy(false));
			};
			const selectorId = 'vssaros-wb-workspace-' + owner;
			return h('div', { className: 'vssWbConversation', 'data-vssaros-wb-conversation-start': owner },
				h('p', null, '业务面板可先使用。需要 AI 协助时，选择项目目录开始对话；只关联到这个工作台。'),
				service.dockError ? h('p', { className: 'vssWbConversationError', role: 'alert' }, '上一段对话打不开：' + service.dockError) : null,
				chosen ? h('label', { htmlFor: selectorId }, '使用已有工作区',
					h('select', {
						id: selectorId, className: 'vssWbWorkspaceSelect', 'data-vssaros-wb-workspace-picker': owner,
						value: chosen.workspaceId, disabled,
						onChange: event => service.selectWorkspace(owner, event.target.value),
					}, ...workspaces.map(w => h('option', { key: w.workspaceId, value: w.workspaceId }, w.title || w.path || w.workspaceId))),
					h('small', { className: 'vssWbWorkspacePath' }, chosen.path)) : h('p', null, '尚无可用工作区，请选择项目文件夹。'),
				h('div', { className: 'vssWbConversationActions' },
					chosen ? h('button', { type: 'button', disabled, onClick: () => run(() => service.newSessionFor(owner, chosen.workspaceId)) }, busy ? '正在打开…' : '开始对话') : null,
					h('button', { type: 'button', disabled, onClick: () => run(() => service.newWorkspaceSessionFor(owner)) }, '新建工作区并开始对话…')),
				hidden.length ? h('details', null, h('summary', null, '已隐藏的工作区'),
					...all.filter(w => hidden.includes(w.workspaceId)).map(w => h('button', {
						key: w.workspaceId, type: 'button', disabled, onClick: () => run(() => service.showWorkspace(w.workspaceId, owner)),
					}, '重新显示 · ' + (w.title || w.path)))) : null,
				error ? h('p', { className: 'vssWbConversationError', role: 'alert' }, error) : null);
		}
		/**
		 * 标准分栏的**左栏**（2026-11-02）：宿主自己渲染，里面一个空 div 作为 portal 目标。
		 * 与整页工作台的 `ConversationMount` 同一套语义：还没有归属会话 ⇒ 显示「开始对话」，
		 * 有 ⇒ 由根覆盖层把官方对话 portal 进来（`data-vssaros-wb-split-dock` 只是锚点，内容不归 React 管）。
		 */
		function SplitConversationPane({ service, entry }) {
			useService(service);
			const [element, setElement] = React.useState(null);
			React.useEffect(() => (element ? service.registerSplitDock(entry.id, element) : undefined), [element, entry.id]);
			const docked = service.splitSessionOf(entry.id);
			const collapsed = service.assistantCollapsed.get(entry.id) === true;
			return h('div', { className: 'vssWbSplitConversation', 'data-vssaros-wb-split-conversation': entry.id,
				id: 'vssaros-assistant-' + entry.id, 'aria-label': 'AI 助手', hidden: collapsed,
				'data-vssaros-assist-collapsed': collapsed ? '1' : '0' },
				h(NewSessionButton, { service, entry }),
				docked ? null : h(ConversationStart, { service, entry }),
				h('div', { ref: setElement, className: 'vssWbDock', 'data-vssaros-wb-split-dock': entry.id, hidden: !docked }));
		}
		/**
		 * 拼「外开」深链：dsh web 地址 + 工作台（用 **hash** 传 —— Host 的 302 会丢掉 query，但保留 hash）。
		 * token 从当前 webview 的 query 抄过来；没有就不带（浏览器里可能已有登录态）。
		 */
		function buildWorkbenchDeepLink(origin, pathname, search, workbenchId) {
			const base = String(origin || '') + (pathname && pathname !== '/' ? pathname : '/');
			let token = '';
			try { token = new URLSearchParams(String(search || '')).get('token') || ''; } catch (e) { token = ''; }
			// ★ `alone=1`：外开只显示工作台 —— 进入后自动收起 dsh 左侧会话栏（见下方深链消费）。
			return base + (token ? '?token=' + encodeURIComponent(token) : '')
				+ '#wb=' + encodeURIComponent(workbenchId) + '&alone=1';
		}

		/** 当前 URL 是不是「外开」打开的（hash/query 里带 `alone=1`）。 */
		function isAloneDeepLink(search, hash) {
			const read = (raw) => {
				try { return new URLSearchParams(String(raw || '').replace(/^#/, '')).get('alone'); } catch (e) { return null; }
			};
			return read(hash) === '1' || read(search) === '1';
		}

		/**
		 * 从 URL 里读出"要打开哪个工作台"。
		 * 优先级：**hash**（外开链接）> query（手工调试）> localStorage（承载页写过的一次性标记）。
		 */
		function parseDeepLinkWorkbench(search, hash, pending) {
			const pick = (raw) => {
				try { return String(new URLSearchParams(String(raw || '').replace(/^#/, '')).get('wb') || '').trim(); } catch (e) { return ''; }
			};
			const want = pick(hash) || pick(search) || String(pending || '').trim();
			return want ? want.replace(/^vssaros:/, 'vssaros/') : '';
		}

		/**
		 * 向服务端要「带 token 的工作台深链」（服务端用 `connection.authenticatedUrl` 现签）。
		 * ★ 外开是另一个浏览器、没有当前 Cookie ⇒ 不带 token 会 401/白屏（真机 bug）。
		 */
		async function requestWorkbenchLink(workbenchId) {
			try {
				// 带上浏览器自己的 origin：服务端那个 ctx 上没有 webServer.port，
				// 自己猜 origin 会拼出 127.0.0.1:undefined（真机 500）。
				const origin = (() => { try { return window.location.origin; } catch (e) { return ''; } })();
				const url = `${LINK_PATH_PREFIX}?wb=${encodeURIComponent(workbenchId)}&origin=${encodeURIComponent(origin)}`;
				const res = await fetch(url, { credentials: 'same-origin' });
				if (!res.ok) {
					try {
						const bad = await res.json();
						window.__vssarosWbLinkError = bad;
					} catch (e) { /* ignore */ }
					return '';
				}
				const json = await res.json();
				return String((json && json.url) || '');
			} catch (e) {
				try { window.__vssarosWbLinkError = String((e && e.message) || e); } catch (e2) { /* ignore */ }
				return '';
			}
		}

		/**
		 * 在系统浏览器里打开当前工作台；返回是否成功唤起（被拦截 ⇒ false）。
		 * ⚠ 必须**同步**调用 window.open（点击手势内），否则会被弹窗拦截 ⇒ 先开空白窗、再异步导航。
		 */
		/**
		 * 在系统浏览器里打开当前工作台。
		 *
		 * ⚠ 2026-10-26 两次真机教训：
		 *   ① 链接里的 token 是**当前进程**的 —— 宿主重启后旧链接必然 401
		 *      （报 `dsh web authentication required`）⇒ **每次点击都要现取**，不能挂载时缓存一次；
		 *   ② 但 `await` 之后再 `window.open` 会被弹窗拦截
		 *      ⇒ 先**同步**开一个空白窗口占位，拿到链接后再导航。
		 */
		function openWorkbenchInBrowser(workbenchId, onResult) {
			let win = null;
			try { win = window.open('', '_blank'); } catch (e) { win = null; }

			const go = (url) => {
				if (win && !win.closed) {
					try { win.opener = null; } catch (e) { /* ignore */ }
					try { win.location.href = url; return true; } catch (e) { /* 回落到再开一个 */ }
				}
				try { return !!window.open(url, '_blank', 'noopener'); } catch (e) { return false; }
			};

			requestWorkbenchLink(workbenchId).then((fresh) => {
				let url = String(fresh || '');
				if (!url) {
					try {
						const loc = window.location;
						url = buildWorkbenchDeepLink(loc.origin, loc.pathname, loc.search, workbenchId);
					} catch (e) { url = ''; }
				}
				// 服务端给的链接可能不带 alone（服务端老版本），这里补齐：外开一律"只显示工作台"
				if (url && url.indexOf('#wb=') >= 0 && url.indexOf('alone=') < 0) { url += '&alone=1'; }
				// 可观测：真机排查时读 window.__vssarosWbOpenExternal 就知道拼出了什么
				try { window.__vssarosWbOpenExternal = url; } catch (e) { /* ignore */ }
				const ok = url ? go(url) : false;
				if (!ok) { try { if (win && !win.closed) { win.close(); } } catch (e) { /* ignore */ } }
				if (typeof onResult === 'function') { try { onResult(ok, url); } catch (e) { /* ignore */ } }
			});
			return true;
		}

		/** S2 一体条的位置（相对工作台面板左上角）；没拖过就回默认「右边缘垂直居中」。 */
		const ACTIONS_POS_KEY = '__vssarosWbActionsPos';
		/** 宿主 header 高度：落点不得高于它，否则会压住「已加载 / 外部打开」那一行。 */
		const ACTIONS_SAFE_TOP = 30;
		/** 贴右留白（px）：用户要求「只能在最右侧上下移动」⇒ x 固定 = maxL - 12，与默认态一致。 */
		const ACTIONS_RIGHT_GAP = 12;

		/** 把位置夹回面板内，并抬到安全区以下（组高变化后也用它修正）。 */
		function clampActions(el, frameEl, pos) {
			const fr = frameEl.getBoundingClientRect();
			const br = el.getBoundingClientRect();
			const maxL = Math.max(0, fr.width - br.width);
			const maxT = Math.max(0, fr.height - br.height);
			// ★ 2026-10-28（用户：「浮动工具栏仅可以在 app 最右侧上下移动」）：
			//   口径收窄为「贴右边缘、只允许上下」—— x 恒定夹到最右，y 仍受安全区与面板高度限制。
			return {
				x: Math.max(0, maxL - ACTIONS_RIGHT_GAP),
				y: Math.round(Math.min(Math.max(ACTIONS_SAFE_TOP, pos.y), maxT)),
			};
		}

		function applyActionsPos(el, pos) {
			el.__vssPos = pos || null;
			if (!pos) {
				el.style.left = ''; el.style.top = '';
				el.style.right = '12px'; el.style.transform = 'translateY(-50%)';
				el.removeAttribute('data-moved');
				return;
			}
			el.style.left = pos.x + 'px';
			el.style.top = pos.y + 'px';
			el.style.right = 'auto';
			el.style.transform = 'none';
			el.setAttribute('data-moved', '');
		}

		/**
		 * 整组拖拽（S2 一体条）。
		 * · 位移 <3px 视为**点击** ⇒ 不拦 click，按钮各自的 onClick 照常生效
		 * · 真拖过之后吞掉紧随的那一次 click，否则"松手即展开"
		 * · 落点夹在面板内，且不高于 header 安全区
		 * · 右键复位；位置写 localStorage
		 */
		function attachActionsDrag(el, frameEl) {
			let drag = null;
			const disposers = [];
			const listen = (target, name, listener, capture) => {
				target.addEventListener(name, listener, capture);
				disposers.push(() => target.removeEventListener(name, listener, capture));
			};

			listen(el, 'pointerdown', (ev) => {
				if (ev.button !== 0 && ev.pointerType === 'mouse') { return; }
				const fr = frameEl.getBoundingClientRect();
				const br = el.getBoundingClientRect();
				drag = {
					frame: fr, br,
					startX: ev.clientX, startY: ev.clientY,
					baseLeft: br.left - fr.left, baseTop: br.top - fr.top,
					moved: false, latest: null, pointerId: ev.pointerId,
				};
			});

			listen(el, 'contextmenu', (ev) => {
				ev.preventDefault();
				applyActionsPos(el, null);
				try { localStorage.removeItem(ACTIONS_POS_KEY); } catch (e) { /* ignore */ }
			});

			listen(window, 'pointermove', (ev) => {
				if (!drag || ev.pointerId !== drag.pointerId) { return; }
				if (!el.isConnected) { drag = null; return; }
				const dx = ev.clientX - drag.startX;
				const dy = ev.clientY - drag.startY;
				if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) { return; }
				if (!drag.moved) {
					drag.moved = true;
					el.setAttribute('data-dragging', '');
					try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
				}
				const maxL = Math.max(0, drag.frame.width - drag.br.width);
				const maxT = Math.max(0, drag.frame.height - drag.br.height);
				drag.latest = {
					// 只允许上下：x 永远贴最右（用户：仅可在 app 最右侧上下移动）
					x: Math.max(0, maxL - ACTIONS_RIGHT_GAP),
					y: Math.round(Math.min(Math.max(ACTIONS_SAFE_TOP, drag.baseTop + dy), maxT)),
				};
				applyActionsPos(el, drag.latest);
			}, true);

			const finish = () => {
				if (!drag) { return; }
				const moved = drag.moved;
				const latest = drag.latest;
				drag = null;
				if (!moved) { return; }
				el.removeAttribute('data-dragging');
				const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
				el.addEventListener('click', swallow, true);
				setTimeout(() => el.removeEventListener('click', swallow, true), 0);
				if (latest) {
					try { localStorage.setItem(ACTIONS_POS_KEY, JSON.stringify(latest)); } catch (e) { /* ignore */ }
				}
				// 位置变了 ⇒ 标签方向可能也要翻（贴左边就改到右侧）
				if (el.__vssSyncLabel) { el.__vssSyncLabel(); }
			};
			listen(window, 'pointerup', finish, true);
			listen(window, 'pointercancel', finish, true);
			return () => { drag = null; disposers.forEach(dispose => dispose()); };
		}

		/**
		 * 恢复上次拖拽位置，并在**尺寸变化后重新夹一次**（2026-11-02 用户报「知识库 工作台未显示浮动工具栏」）。
		 *
		 * 两个坑（合起来会让胶囊永久飘到可见区外，表现就是"工具栏没了"）：
		 *   ① 存的是**绝对像素**（`{x,y}`，全局一个 key，所有工作台共用）⇒ 换个窗口尺寸 / 换台机器 /
		 *      分栏宽度变了，原来那个 x 就在面板外；而这里以前**只在挂载时夹一次**，之后再没人管。
		 *   ② 挂载时页签可能还没激活（`display:none`）⇒ `getBoundingClientRect()` 全 0 ⇒ 夹出来的
		 *      `x = maxL - 12` 基于错误尺寸，等于把胶囊钉在错的位置。
		 * ⇒ 现在：尺寸为 0 时**等到有尺寸再恢复**；任何尺寸变化都重新夹（也是"拖过之后窗口变小"的兜底）。
		 */
		/** 已挂载的胶囊（复位逃生门用：位置飘到看不见的地方时能一键拉回，不必开 DevTools 清 localStorage）。 */
		const mountedActions = new Set();
		/**
		 * 复位**全部**工作台的浮动条位置（回默认「右边缘垂直居中」）。
		 * 用户侧入口：控制台 `__vssarosResetWorkbenchActions()`，或对胶囊右键（单个）。
		 */
		function resetAllActions() {
			try { localStorage.removeItem(ACTIONS_POS_KEY); } catch { /* ignore */ }
			for (const el of mountedActions) { if (el && el.isConnected) { applyActionsPos(el, null); } }
			return mountedActions.size;
		}

		try { window.__vssarosResetWorkbenchActions = resetAllActions; } catch { /* 无 window（测试沙箱）*/ }

		/** 一个元素的简短描述：`div.cls1.cls2#id[data-x]`（日志里认得出是谁）。 */
		function describeEl(node) {
			try {
				if (!node || !node.tagName) { return String(node); }
				const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
				const data = node.getAttributeNames ? node.getAttributeNames().filter(n => n.startsWith('data-')).slice(0, 2).join(',') : '';
				return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (cls ? '.' + cls : '') + (data ? '[' + data + ']' : '');
			} catch { return '?'; }
		}
		const rectText = (r) => Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);

		/** 每个工作台、每次页面加载只自检一次（见 diagnoseActions）。 */
		const diagnosedActions = new Set();
		/** 自检结果也留一份在 window 上（`__vssarosWbActionsDiag`），控制台能直接读。 */
		const diagnosisLog = [];
		try { window.__vssarosWbActionsDiag = diagnosisLog; } catch { /* 无 window */ }

		/**
		 * 运行时自检：胶囊**已经在 DOM 里**，但用户看不到它——只可能是下面四种之一，而这四种 jsdom 都测不了
		 * （没有布局引擎），只能在真实浏览器里量：
		 *   ① 尺寸为 0 / 被样式隐藏   ② 落在外框之外（位置存档 / 外框比可见区大）
		 *   ③ 被别的元素盖住          ④ 被某个祖先的 overflow 裁掉
		 * 量到什么就写什么（console.warn ⇒ dshHarness 会把它镜像进 main.log，用户不必开控制台）。
		 * ⚠ 只在**真的出了问题**时说"异常"；没问题也报一行"正常 + 几何"，这样"没有这行日志"就等价于"根本没挂载"。
		 */
		function diagnoseActions(el, frameEl, reason) {
			try {
				const id = el.getAttribute('data-vssaros-wb-actions') || '?';
				if (diagnosedActions.has(id)) { return; }
				diagnosedActions.add(id);
				const r = el.getBoundingClientRect();
				const fr = frameEl.getBoundingClientRect();
				const cs = window.getComputedStyle(el);
				const issues = [];
				if (reason) { issues.push(reason); }
				if (r.width === 0 || r.height === 0) { issues.push('胶囊尺寸为 0'); }
				if (cs.display === 'none' || cs.visibility === 'hidden' || (cs.opacity !== '' && Number(cs.opacity) === 0)) {
					issues.push('被样式隐藏(display=' + cs.display + ' visibility=' + cs.visibility + ' opacity=' + cs.opacity + ')');
				}
				const vw = window.innerWidth; const vh = window.innerHeight;
				if (r.width > 0 && (r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh)) { issues.push('整体在窗口可见区之外'); }
				else if (r.width > 0 && fr.width > 0 && (r.left < fr.left - 1 || r.right > fr.right + 1 || r.top < fr.top - 1 || r.bottom > fr.bottom + 1)) { issues.push('落在外框之外'); }
				// 被谁盖住：取胶囊中心点最上层的元素
				let covered = '';
				const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
				if (r.width > 0 && cx >= 0 && cy >= 0 && cx <= vw && cy <= vh && typeof window.document.elementFromPoint === 'function') {
					const topEl = window.document.elementFromPoint(cx, cy);
					if (topEl && topEl !== el && !el.contains(topEl)) { covered = describeEl(topEl); issues.push('中心点被 ' + covered + ' 盖住'); }
				}
				// 被哪个祖先裁掉：祖先 overflow 非 visible 且它的矩形没把胶囊完整包住
				const clippers = [];
				for (let p = el.parentElement, n = 0; p && p !== window.document.body && n < 12; p = p.parentElement, n += 1) {
					const pcs = window.getComputedStyle(p);
					if ((pcs.overflowX !== 'visible' || pcs.overflowY !== 'visible') && r.width > 0) {
						const pr = p.getBoundingClientRect();
						if (r.left < pr.left - 1 || r.right > pr.right + 1 || r.top < pr.top - 1 || r.bottom > pr.bottom + 1) { clippers.push(describeEl(p) + '(' + rectText(pr) + ')'); }
					}
				}
				if (clippers.length) { issues.push('被祖先裁剪：' + clippers.slice(0, 2).join(' / ')); }
				const fcs = window.getComputedStyle(frameEl);
				const record = {
					wb: id, ok: issues.length === 0, issues, at: new Date().toISOString(),
					capsule: rectText(r), frame: rectText(fr), viewport: vw + 'x' + vh,
					capsuleStyle: 'pos=' + cs.position + ' z=' + cs.zIndex + ' right=' + cs.right + ' top=' + cs.top,
					frameStyle: 'pos=' + fcs.position + ' overflow=' + fcs.overflowX + '/' + fcs.overflowY,
					frameCount: window.document.querySelectorAll('.vssWbFrame').length,
					capsuleCount: window.document.querySelectorAll('[data-vssaros-wb-actions]').length,
					saved: (() => { try { return localStorage.getItem(ACTIONS_POS_KEY) || ''; } catch { return '(读不到)'; } })(),
				};
				diagnosisLog.push(record);
				console.warn('[vssaros-workbenches] 浮动工具栏自检 ' + id + '：' + (record.ok ? '正常' : '异常 ⇒ ' + issues.join('；'))
					+ ' | 胶囊 ' + record.capsule + ' | 外框 ' + record.frame + ' | 窗口 ' + record.viewport + ' | ' + record.capsuleStyle
					+ ' | ' + record.frameStyle + ' | 外框数=' + record.frameCount + ' 胶囊数=' + record.capsuleCount + ' | 存档=' + (record.saved || '无'));
			} catch (error) {
				try { console.warn('[vssaros-workbenches] 浮动工具栏自检本身出错：' + String((error && error.message) || error)); } catch { /* 无 console */ }
			}
		}

		function restoreActionsPos(el, frameEl) {
			mountedActions.add(el);
			let restored = false;
			let diagnoseTimer;
			const tryRestore = () => {
				if (restored || !el.isConnected) { return; }
				const fr = frameEl.getBoundingClientRect();
				if (fr.width <= 0 || fr.height <= 0) { return; }   // 还没显示 ⇒ 现在量不到，等下一次
				restored = true;
				try {
					const saved = JSON.parse(localStorage.getItem(ACTIONS_POS_KEY) || 'null');
					if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
						applyActionsPos(el, clampActions(el, frameEl, saved));
					}
				} catch { /* localStorage 不可用 ⇒ 用默认位置 */ }
				// 外框第一次有尺寸 ⇒ 等布局稳定（0.8s）再量一次
				diagnoseTimer = setTimeout(() => diagnoseActions(el, frameEl, ''), 800);
			};
			tryRestore();
			// 兜底：6 秒后外框还是没尺寸 ⇒ 它一直是隐藏的（页签没显示 / display:none），照样上报一次
			const fallbackTimer = setTimeout(() => { if (!restored) { diagnoseActions(el, frameEl, '外框 6 秒内始终没有尺寸（隐藏 / 未显示）'); } }, 6000);
			try {
				// 面板出现 / 窗口缩放 / 分栏比例变化都会触发 ⇒ 既补"挂载时还没显示"，也补"拖过之后尺寸变了"
				const ro = new ResizeObserver(() => {
					tryRestore();
					if (el.__vssPos && el.isConnected) { applyActionsPos(el, clampActions(el, frameEl, el.__vssPos)); }
				});
				ro.observe(frameEl);
				el.__vssActionsResize = ro;
			} catch { /* 老运行时没有 ResizeObserver ⇒ 至少还有挂载时那一次 */ }
			return () => {
				clearTimeout(diagnoseTimer); clearTimeout(fallbackTimer);
				el.__vssActionsResize?.disconnect();
				mountedActions.delete(el);
			};
		}

		/**
		 * 统一挂载 S2 一体条：拖拽 + 跟随工作台的「助手栏收起态」。
		 *
		 * 联动约定（工作台侧只写一个属性，不必知道外壳长什么样）：
		 *   · 工作台在**面板根**上写 `data-vssaros-assist-collapsed="1|0"`
		 *   · 点「«」时外壳在 frame 上派发 `vssaros:assist-expand` 事件，工作台监听后展开
		 */
		function mountActions(el, frameEl) {
			if (!el || !frameEl || el.__vssMounted) { return; }
			el.__vssMounted = true;

			// 标签方向：贴着面板左边缘时翻到右侧，否则往左伸（面板右边缘那侧才有空间）
			const syncLabelSide = () => {
				try {
					const r = el.getBoundingClientRect();
					const fr = frameEl.getBoundingClientRect();
					el.setAttribute('data-label', (r.left - fr.left) < 110 ? 'right' : 'left');
				} catch (e) { /* ignore */ }
			};
			el.__vssSyncLabel = syncLabelSide;
			el.addEventListener('pointerenter', syncLabelSide);
			syncLabelSide();

			const disposeDrag = attachActionsDrag(el, frameEl);
			const disposePosition = restoreActionsPos(el, frameEl);

			const syncAssist = () => {
				const host = frameEl.querySelector('[data-vssaros-assist-collapsed]');
				/* 三态（2026-10-26 用户要求「展开后按钮变成 收缩/外开」）：
				   · none     —— 这个工作台没有 AI 助手栏 ⇒ 只显示「外开」
				   · 1（收起） —— 显示「« 展开」
				   · 0（展开） —— 显示「» 收起」（不再是消失） */
				// ★ 2026-10-28（用户：「知识库中的浮动工具栏中，缺少 ai 助手」）：
				//   以前没有 `[data-vssaros-assist-collapsed]`（页面型工作台 / 知识库）⇒ 状态 `none`
				//   ⇒ CSS 把「AI 助手」按钮整组隐藏 ⇒ 那条浮动条只剩「在浏览器打开」。
				//   现在**一律显示**：没有页内对话列时按「收起」态显示（点它走外壳兜底：开会话/开聊天页）。
				const state = !host ? '1' : (host.getAttribute('data-vssaros-assist-collapsed') === '1' ? '1' : '0');
				el.setAttribute('data-assist', state);
				// 同一个按钮两副面孔：图标 / title / hover 文案一起换
				const btn = el.querySelector('.wbActAssist');
				if (btn) {
					const text = state === '1' ? '展开 AI 助手' : '收起 AI 助手';
					const icon = state === '1' ? '«' : '»';
					if (btn.textContent !== icon) { btn.textContent = icon; }
					if (btn.title !== text) { btn.title = text; }
					btn.setAttribute('aria-label', text);
					btn.setAttribute('aria-expanded', String(state === '0'));
					const label = btn.parentElement ? btn.parentElement.querySelector('.wbLabel') : null;
					if (label && label.textContent !== text) { label.textContent = text; }
				}
				// 展开态整组变矮 ⇒ 位置可能越界，重新夹一次
				if (el.__vssPos) { applyActionsPos(el, clampActions(el, frameEl, el.__vssPos)); }
			};
			try {
				const mo = new MutationObserver(syncAssist);
				mo.observe(frameEl, {
					childList: true, subtree: true, attributes: true,
					attributeFilter: ['data-vssaros-assist-collapsed'],
				});
				el.__vssAssistObserver = mo;
			} catch (e) { /* ignore */ }
			syncAssist();
			return () => {
				disposeDrag(); disposePosition();
				el.__vssAssistObserver?.disconnect();
				el.removeEventListener('pointerenter', syncLabelSide);
				el.__vssMounted = false;
				delete el.__vssSyncLabel;
			};
		}

		/**
		 * 工作台 id → 它的 AI 助手默认 agent（preset id；可给候选数组）。
		 * ★ 2026-11-02 根治：这是**全仓唯一**的「工作台 → agent」对应表，也只有宿主据它改 agent。
		 *   各工作台插件**不许**再自带 preset 常量去 select（守卫 check-assistant-collapse 扫全仓）。
		 *   第三方工作台在描述符里写 `assistantPreset` 即可（优先于本表）。
		 */
		const ASSIST_PRESET_BY_WB = {
			// ★ 2026-11-11（用户要求「移除萨罗斯管理工作台」）：`vssaros/studio` → `vssaros-saroasis-studio`
			//   随工作台与配套 bot 一并下线；GR 程序员 bot 不绑工作台，在 Bots 里直接选。
			'vssaros/marketplace': 'vssaros-marketplace-bot',
			'vssaros/media': 'vssaros-media-librarian',
			// ★ 2026-10-28（用户：「知识库的展开 AI 助手点不动，展开后应显示知识库专家」）：
			//   知识库是**页面型**工作台（面板里没有对话列）⇒ 点击只能走外壳兜底开会话；
			//   而兜底要带 preset —— 之前没这一条，传空串 ⇒ `newChat('')` 等于空转 ⇒「点了没反应」。
			//   `knowledge-base-expert` 是内置 agent（名称「知识库专家」）⇒ preset = vssaros- + id。
			// ★ 2026-11-09：收敛为单 agent —— 只用内置 `knowledge-base-expert`（名称「知识库专家」）。
			//   数据根的 `kb-expert` 移除；按用户决策不做存量会话兼容层，旧会话头里的
			//   `vssaros-kb-expert` 不再有对应 preset，resume 会失败（已知取舍）。
			'vssaros/kb': 'vssaros-knowledge-base-expert',
		};
		/**
		 * 「用户主动导航」的时间戳（毫秒）。
		 * ★ 2026-10-28（用户：「点工作区左侧会话 item 时，要求切换到会话页进行展示」）：
		 *   侧栏点会话 = `uiWorkspace.openSession()`；侧栏「新建会话」= `uiWorkspace.startSession()`。
		 *   两者都应**放行** `selectPanel(null)` ⇒ 中栏切到**会话页**（离开工作台）。
		 *   而工作台内部切会话/切工作区不走这两个入口 ⇒ 仍然拦下来停靠。
		 *   用时间窗（不是布尔量）是因为 startSession 是**异步**的：`replaceMain` 在其 Promise 之后才发生。
		 */
		let navIntentAt = 0;
		function markUserNav() { navIntentAt = Date.now(); }
		/**
		 * ★★ 2026-11-02（用户三次报「点会话页签后仍然空白」）：**页面级**导航意图。
		 *   真机现场：新会话已建好并 openSession，但守卫仍把它「停靠到工作台对话列」×3 ⇒
		 *   `navIntentAt` 根本没刷新 —— 每个插件拿到的 `ctx.uiWorkspace` 是**各自的 cordis 代理**
		 *   （探针：两次 get 不是同一对象、包装标记读不到），我们对 openSession 的包装**拦不到
		 *   其它插件发出的调用**。⇒ 再认一个页面级信号 `window.__vssarosUserNavAt`
		 *   （chat-surface 在用户主动打开/新建会话前写入），两者取最近的那个。
		 */
		function lastUserNavAt() {
			let g = 0;
			try { g = Number(window.__vssarosUserNavAt) || 0; } catch (e) { g = 0; }
			return Math.max(navIntentAt, g);
		}

		/** 首次打开标记（本地记一次）：只用来决定文案要不要写「首次加载会慢一些」。 */
		const FIRST_OPEN_KEY = 'vssaros.wbSeen.v1.';
		function markWorkbenchSeen(id) { try { localStorage.setItem(FIRST_OPEN_KEY + id, String(Date.now())); } catch { /* 隐私模式 */ } }
		function isFirstOpenOf(id) { try { return !localStorage.getItem(FIRST_OPEN_KEY + id); } catch { return false; } }

		/**
		 * 大型工作台**第一次打开时的加载态**（方案 D：极简呼吸点）。
		 *
		 * 为什么需要：商城 / 知识库 / 媒体库这类工作台的客户端 chunk 很大，首次打开要等
		 * 「下载 chunk → 注册 → React 挂载 → 首屏」，这段时间外框里是一片空白，看起来像卡死。
		 *
		 * 判据（刻意选最简的）：内容容器里出现**第一个真实子节点**就算好了 ——
		 * 这段要挡的正是"组件还没挂上"的空白期；挂上之后的数据加载由各工作台自己显示。
		 * 不做尺寸判断：`getBoundingClientRect` 在隐藏页签下全是 0，会误判成"一直没加载"。
		 *
		 * 两个细节：① 最短显示 120ms（不然缓存命中时只闪一下，比不显示更难受）；
		 * ② 淡出 180ms 后再卸载，避免"突然消失"的突兀感。
		 */
		function PanelLoadingGate({ entry, children }) {
			const contentRef = React.useRef(null);
			const [phase, setPhase] = React.useState('on');   // on → out（淡出中）→ off（已卸载）
			const firstRef = React.useRef(null);
			if (firstRef.current === null) { firstRef.current = isFirstOpenOf(entry.id); }
			React.useEffect(() => {
				const host = contentRef.current;
				if (!host) { return undefined; }
				const startedAt = Date.now();
				let finished = false;
				let observer = null;
				let poll = null;
				let minTimer = null;
				let fadeTimer = null;
				const finish = () => {
					if (finished) { return; }
					finished = true;
					if (observer) { observer.disconnect(); }
					if (poll) { clearInterval(poll); }
					markWorkbenchSeen(entry.id);
					const wait = Math.max(0, 120 - (Date.now() - startedAt));
					minTimer = setTimeout(() => {
						setPhase('out');
						fadeTimer = setTimeout(() => setPhase('off'), 180);
					}, wait);
				};
				const ready = () => host.children.length > 0;
				if (ready()) { finish(); }
				else {
					observer = new MutationObserver(() => { if (ready()) { finish(); } });
					observer.observe(host, { childList: true });
					// 兜底轮询：某些工作台先挂一个空壳再塞内容，MutationObserver 只看 childList 会漏
					poll = setInterval(() => { if (ready()) { finish(); } }, 120);
				}
				return () => {
					if (observer) { observer.disconnect(); }
					if (poll) { clearInterval(poll); }
					if (minTimer) { clearTimeout(minTimer); }
					if (fadeTimer) { clearTimeout(fadeTimer); }
				};
			}, [entry.id]);
			return h('div', { className: 'vssWbPanelBody', 'data-vssaros-wb-panel-body': entry.id },
				h('div', { ref: contentRef, className: 'vssWbPanelContent', 'data-vssaros-wb-panel-content': entry.id }, children),
				phase === 'off' ? null : h('div', {
					className: 'vssWbLoading' + (phase === 'out' ? ' is-out' : ''),
					'data-vssaros-wb-loading': entry.id, role: 'status', 'aria-busy': 'true',
					// 关键布局内联兜底：即便样式表没生效（旧标签 / 注入失败），也不能退化成挤在左上角的裸文字
					style: {
						position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 6,
						display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
						gap: '14px', background: 'var(--dsw-alias-bg-base, #1b1b1f)',
						opacity: phase === 'out' ? 0 : 1, transition: 'opacity .18s ease',
					},
				},
					h('div', { className: 'vssWbLoadingPulse' }),
					h('div', { className: 'vssWbLoadingLine' }),
					h('div', { className: 'vssWbLoadingCap' }, '正在加载 · ' + entry.title),
					firstRef.current ? h('div', { className: 'vssWbLoadingHint' }, '首次加载会慢一些，之后会快很多') : null));
		}
		function Frame({ service, entry }) {
			useService(service);
			const [inlineMounts, setInlineMounts] = React.useState(0);
			const [ready, setReady] = React.useState(false);
			const claim = React.useCallback(() => {
				setInlineMounts(count => count + 1);
				return () => setInlineMounts(count => count - 1);
			}, []);
			React.useLayoutEffect(() => { setReady(true); }, []);
			const hasFallback = ready && inlineMounts === 0;
			const collapsed = service.assistantCollapsed.get(entry.id) === true;
			const actionsRef = React.useRef(null);
			React.useEffect(() => {
				const element = actionsRef.current;
				return element ? mountActions(element, element.closest('.vssWbFrame') || element.parentElement) : undefined;
			}, [entry.id]);
			const props = { service, entry };
			if (entry.customFrame) { props.active = service.active === entry.id; props.conversation = h(ConversationMount, { service, entry }); }
			// ★ 外开链接**不再挂载时预取**：token 属于当前进程，宿主一重启旧链接就 401。
			//   改为每次点击现取（`openWorkbenchInBrowser` 里同步开窗 + 异步导航）。
			const actions = [h('div', {
					className: 'vssWbActions',
					'data-vssaros-wb-actions': entry.id,
					'data-assist': '1',
					role: 'toolbar', 'aria-label': 'AI 助手工具栏', 'aria-orientation': 'vertical',
					ref: actionsRef,
				},
					h('div', { className: 'wbWrap wbWrapAssist' },
						h('button', {
							type: 'button',
							className: 'wbAct wbActAssist',
							'data-vssaros-wb-assist': entry.id,
							'aria-label': '展开 AI 助手', 'aria-expanded': false,
							'aria-controls': 'vssaros-assistant-' + entry.id,
							title: '展开 AI 助手',
							onClick: (ev) => {
								ev.preventDefault();
								ev.stopPropagation();
								const frameEl = ev.currentTarget.closest('.vssWbFrame');
								if (!frameEl) { return; }
								const assistant = frameEl.querySelector('[data-vssaros-assist-collapsed]');
								if (frameEl.querySelector('[data-vssaros-wb-hosted-assistant], [data-vssaros-wb-split-conversation]')
									|| assistant?.hasAttribute('data-vssaros-wb-conversation')) {
									service.assistantCollapsed.set(entry.id, !collapsed); service.publish(); return;
								}
								const navigation = service.navigation;
								/* ★ 一个按钮两种动作（2026-10-26 用户要求）：
								   已收起 ⇒ 派发 `assist-expand`；已展开 ⇒ 派发 `assist-collapse`。
								   状态取外壳自己维护的 `data-assist`（syncAssist 同步的，比再查 DOM 稳）。
								   ⚠ 事件必须派发到**面板根**：CustomEvent 只向上冒泡，在 frame 上派发
								   到不了子节点，而工作台是在面板根/ window 上监听的（踩过）。 */
								const holder = ev.currentTarget.closest('[data-vssaros-wb-actions]');
								const collapsedNow = holder && holder.getAttribute('data-assist') === '1';
								const type = collapsedNow ? 'vssaros:assist-expand' : 'vssaros:assist-collapse';
								const target = frameEl.querySelector('[data-vssaros-assist-collapsed]') || frameEl;
								target.dispatchEvent(new CustomEvent(type, {
									bubbles: true,
									// ⚠ 不能用 `el`：那是上面 ref 回调的形参，在 onClick 作用域里未定义，
									//   一读就抛 ReferenceError ⇒ 事件根本没派发（2026-10-26 真机：点了没反应）。
									detail: { workbench: entry.id },
								}));
								/* ★ 2026-10-27（用户：「点展开 AI 助手，右侧没出现聊天框」）：
								   有些入口是**页面**（媒体库/商城/萨罗斯 作为 dashboard 目录里的 module page 打开），
								   页面里**没有对话停靠点**（自托管页拿不到宿主的 props.conversation）⇒ 事件没人接 ⇒ 点了没反应。
								   ⇒ 派发后**同步看一眼**页面有没有把折叠属性改成 0（接住了就是它处理的）：
								     · 接住了（customFrame 工作台 / 媒体库页面）⇒ 什么都不做；
								     · 没接住 ⇒ **外壳兜底**：请 IDE 侧开一个助手会话（该工作台自己的 preset）。
								   ⚠ 这里用的是同步检查：接住的一方都会**同步**改属性（媒体库页面 handler 的第一句就是 setAssistCollapsed(false)）。 */
								const after = target.getAttribute && target.getAttribute('data-vssaros-assist-collapsed');
								// ★ 2026-10-28（知识库「点展开没反应」第三层）：页面用 React state 更新属性 ⇒
								//   **同步读到的还是旧值**，外壳会误判"没人接"⇒ 直接开会话跳走（把工作台顶掉）。
								//   ⇒ 展开时**延迟复查**：等一帧后再看属性；已有展开的面板也算接住了。
								const willFallback = type === 'vssaros:assist-expand' && after !== '0';
								if (willFallback) {
									setTimeout(() => {
										if (!service.navigationCurrent(entry.id, navigation) || !frameEl.isConnected) { return; }
										try {
											const host = frameEl.querySelector('[data-vssaros-assist-collapsed]');
											const cur = host && host.getAttribute('data-vssaros-assist-collapsed');
											if (cur === '0' || frameEl.querySelector('[data-vssaros-assist-collapsed="0"]')) { return; }
										} catch (e) { /* 读不到就按未处理走兜底 */ }
										const startAssist = (preset) => {
											try {
												const ws = service && service.ctx && service.ctx.uiWorkspace;
												if (ws && typeof ws.startSession === 'function') {
													ws.startSession(undefined, preset ? { agentPreset: preset } : undefined);
													return true;
												}
											} catch (e) { /* 走下一条 */ }
											const bridge = window.vssarosDsh;
											if (bridge && typeof bridge.newChat === 'function' && preset) {
												try { bridge.newChat(preset); return true; } catch (e) { /* 忽略 */ }
											}
											return false;
										};
										// preset 只用 agentPresets.list() 里真实存在的（不存在的 id 会把会话弄坏）
										Promise.resolve(service.readyPreset(entry.id))
											.catch(() => '')
											.then(preset => { if (service.navigationCurrent(entry.id, navigation) && frameEl.isConnected) { startAssist(preset); } });
									}, 200);
								}
							},
						}, '«'),
						// S4：hover 时在左侧滑出文字（面板右边缘 ⇒ 左侧才有空间）
						h('span', { className: 'wbLabel' }, '展开 AI 助手'),
					),
					entry.floatingActions === false ? null : h('div', { className: 'wbDivider' }),
					entry.floatingActions === false ? null : h('div', { className: 'wbWrap wbWrapOpen' },
						h('button', {
							type: 'button',
							className: 'wbAct wbActOpen',
							'data-vssaros-wb-open-external': entry.id,
							'aria-label': '在浏览器中打开工作台',
							title: '在浏览器中打开这个工作台（含右侧 AI 助手；被拦截时按钮会变橙，再点一次即可）',
							onClick: (ev) => {
								ev.preventDefault();
								ev.stopPropagation();
								const btn = ev.currentTarget;
								// 结果异步回来（要先现取带 token 的链接），拿到再更新按钮状态
								openWorkbenchInBrowser(entry.id, (ok) => {
									try { btn.dataset.state = ok ? 'opened' : 'blocked'; } catch (e) { /* ignore */ }
								});
							},
						}, '↗'),
						h('span', { className: 'wbLabel' }, '在浏览器打开'),
					),
				)];
			// ★ 2026-11-02：标准分栏（未声明 customFrame 的默认）。
			//   宿主自己给「左对话 / 右业务」，对话由根覆盖层 portal 进左栏停靠点 ⇒
			//   与整页工作台共用同一套停靠机制（retain / 归属校验 / 自愈全部复用）。
			if (service.conversationMode(entry.id) === 'split') {
				const width = Number(entry.layout && entry.layout.businessWidth);
				return h(HeaderHost, { entry }, ...actions,
					h(PanelLoadingGate, { entry },
						h('div', {
							className: 'vssWbSplit', 'data-vssaros-wb-split': entry.id,
							'data-assist-collapsed': collapsed ? '1' : '0',
							'data-business-side': (entry.layout && entry.layout.businessSide) || 'right',
							style: { '--vssaros-wb-business-width': ((Number.isFinite(width) ? width : 0.36) * 100) + '%' },
						},
							h(SplitConversationPane, { service, entry }),
							h('div', { className: 'vssWbSplitBusiness' }, h(PanelBoundary, { entry }, h(entry.Component, props))))));
			}
			return h(HeaderHost, { entry }, ...actions,
				h('div', { className: 'vssWbHostedLayout', 'data-vssaros-wb-hosted-layout': entry.id },
					h('div', { className: 'vssWbHostedBusiness' },
						h(InlineAssistantContext.Provider, { value: claim },
							h(PanelLoadingGate, { entry }, h(PanelBoundary, { entry }, h(entry.Component, props))))),
					hasFallback ? h('aside', {
						className: 'vssWbHostedAssistant', 'data-vssaros-wb-hosted-assistant': entry.id,
						'aria-label': 'AI 助手', 'data-collapsed': collapsed ? '1' : '0',
						'data-vssaros-assist-collapsed': collapsed ? '1' : '0',
					},
						h('div', { id: 'vssaros-assistant-' + entry.id, className: 'vssWbHostedContent', hidden: collapsed },
							h(ConversationMount, { service, entry, fallback: true }))) : null));
		}

		// ── 会话停靠：根覆盖层条目（声明 session 作用域子槽）+ 子槽里的对话面板 ─────────────────
		// 与官方右栏子会话聊天同一机制（`dsh-client-ui-subagent`：SidebarChatTab / ConversationSlotPanel）：
		// 只有**声明了 session 作用域子槽的条目**才拿得到 `SessionProvider` 与 `renderSlot`；覆盖层在根布局里常驻
		// ⇒ 把对话 portal 进前台工作台的停靠点。会话引用用 `sessions.retain(id, { source: 'workbench' })` 持有，
		// 换会话 / 停靠点消失时释放（不碰主视图的 `mainView` 引用 ⇒ 原生对话页不受影响）。
		const DOCK_SLOT = 'vssaros.workbench.conversation';
		function makeConversationDock(service) {
			return function VssarosWorkbenchConversationDock({ SessionProvider, renderSlot }) {
				useService(service);
				const target = service.dockTarget();
				const sessionId = target ? target.sessionId : null;
				const [reference, setReference] = React.useState(null);
				React.useEffect(() => {
					if (!sessionId) { setReference(null); return undefined; }
					let ref = null;
					let canceled = false;
					const owner = target.id;
					const failed = error => {
						if (canceled) { return; }
						service.markDead(sessionId, error);
						void service.clearStaleBinding(owner, sessionId);
					};
					try {
						ref = service.ctx.sessions.retain(sessionId, { source: 'workbench' });
					} catch (error) { failed(error); return undefined; }
					setReference({ sessionId, ref });
					if (ref && ref.ready && typeof ref.ready.then === 'function') { ref.ready.then(undefined, failed); }
					return () => { canceled = true; setReference(null); try { ref.release(); } catch { /* 已释放 */ } };
				}, [sessionId]);
				// ★ 2026-11-02：停靠的会话若还没开聊（hero 空态），套上**这个工作台**的默认 agent。
				//   目标只有一个：覆盖层此刻正在渲染的 `target.id` 的 `target.sessionId`（不碰全局当前会话）。
				//   等摘要 / 等 preset 注册都在 applyDefaultPreset 内部做，这里调一次即可（它自己保证每条只套一次）。
				const presetOwner = target ? target.id : null;
				React.useEffect(() => {
					if (!sessionId || !presetOwner) { return; }
					// 诊断「这条会话能不能输入」（不属于任何工作区 ⇒ 输入框会被禁用）
					service.diagnoseDock(presetOwner, sessionId);
					service.applyDefaultPreset(presetOwner, sessionId);
				}, [sessionId, presetOwner]);
				if (!target || !reference || reference.sessionId !== sessionId || typeof SessionProvider !== 'function' || typeof renderSlot !== 'function') { return null; }
				return ReactDOM.createPortal(
					h(SessionProvider, { session: reference.ref }, renderSlot(DOCK_SLOT, {})),
					target.element,
					sessionId);
			};
		}
		/** 固定选 Chat 视图（照官方 FixedChatConversationView）。 */
		function FixedChatView(props) { return props.renderSlot('conversation.session', { view: 'chat' }); }
		/** 子槽里的对话内容（照官方 ConversationSlotPanel：同一个 `conversation.content` 工厂，embedded 变体）。 */
		function DockedConversation({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
			const session = useSession(value => value);
			const conversation = useConversation(value => value);
			const active = conversation.activeTargets.size > 0 || !session.blank && !session.awaitingFirstTurn || session.running;
			const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank';
			const summaryBlank = useSessions(state => state.byId[sessionId] && state.byId[sessionId].blank);
			const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true;
			const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true);
			return h('div', { className: 'vssWbDockedConversation', 'data-vssaros-wb-docked-session': sessionId },
				renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero }, { slots: { views: FixedChatView } }));
		}
		/**
		 * 嵌入式承载：在**别人的面板**里渲染一个已注册的工作台（同一套外框 / 错误边界 / 顶栏校验）。
		 * 用于 chat-surface 的常驻页签条（方案 A：页签条保留，工作台嵌在其下，替代 iframe）。
		 * `active=true` 时记为前台工作台（`activate`，首次即登记 added）；未注册 ⇒ 渲染 null（调用方自行兜底）。
		 */
		function makeView(service) {
			return function VssarosWorkbenchView({ id, active }) {
				const [, bump] = React.useState(0);
				React.useEffect(() => service.subscribe(() => bump(v => v + 1)), []);
				React.useEffect(() => {
					if (!active) { return undefined; }
					service.activate(id);
					return () => service.deactivate(id);
				}, [id, active]);
				const entry = service.providers.get(id);
				return entry ? h(Frame, { service, entry }) : null;
			};
		}

		function makePageView(service) {
			return function WorkbenchPageView({ id, title, active, children }) {
				useService(service);
				const content = React.useRef(children);
				content.current = children;
				const entry = React.useMemo(() => {
					const Component = () => content.current;
					const repository = String(id).startsWith('vssaros/') ? 'vssaros:' + id.slice(8)
						: String(id).startsWith('local:') ? id : 'https://github.com/' + id;
					return { ...normalize({ title: title || id, repository, customFrame: true, floatingActions: false }, Component), Component };
				}, [id, title]);
				React.useLayoutEffect(() => service.registerPageFrame(entry), [entry]);
				React.useEffect(() => {
					if (!active) { return undefined; }
					service.activate(id);
					return () => service.deactivate(id);
				}, [id, active, !!service.state]);
				return h(Frame, { service, entry });
			};
		}

		const STYLE_ID = 'vssaros-workbenches-style';
		const CSS = `
.vssWbFrame { position:relative; display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; height:100%; overflow:auto; container-type:inline-size; container-name:vss-workbench; }
.vssWbHostedLayout { display:flex; flex:1; width:100%; min-width:0; min-height:0; overflow:hidden; }
.vssWbHostedBusiness { display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; overflow:hidden; }
.vssWbHostedAssistant { display:flex; flex-direction:column; flex:0 0 clamp(280px, 36%, 440px); min-width:0; min-height:0; border-left:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base); }
.vssWbHostedAssistant[data-collapsed="1"] { flex-basis:0; border-left:0; overflow:hidden; }
.vssWbHostedContent { display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; overflow:auto; }
.vssWbHostedContent[hidden] { display:none; }
@container vss-workbench (max-width:600px) { .vssWbHostedAssistant:not([data-collapsed="1"]) { flex-basis:52%; } }
.vssWbFailure { margin:48px auto; max-width:520px; padding:24px; border-radius:12px; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.vssWbFailure h2 { margin:0 0 8px; font-size:16px; }
.vssWbFailure p { margin:0 0 12px; opacity:.8; font-size:13px; line-height:1.6; }
.vssWbFailure pre { margin:0 0 12px; padding:8px; font-size:12px; white-space:pre-wrap; word-break:break-all; background:rgba(127,127,127,.12); border-radius:6px; }
.vssWbFailure button { padding:6px 14px; border-radius:999px; cursor:pointer; }
.vssWbConversation { display:flex; flex-direction:column; gap:10px; padding:16px; border:1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius:10px; font-size:13px; }
.vssWbConversation p { margin:0; opacity:.85; }
.vssWbConversationActions { display:flex; gap:8px; flex-wrap:wrap; }
.vssWbConversationActions button { padding:6px 14px; border-radius:999px; cursor:pointer; border:1px solid var(--dsw-alias-border-l2, #3e3e3e); background: var(--dsw-alias-bg-layer-1, #262626); color: inherit; font: inherit; }
.vssWbWorkspaceSelect { display:block; width:100%; min-width:0; margin-top:8px; padding:8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2, #3e3e3e); background:var(--dsw-alias-bg-layer-1, #262626); color:var(--dsw-alias-label-primary, #e6e6ea); font:inherit; }
.vssWbWorkspacePath { display:block; margin-top:6px; overflow-wrap:anywhere; color:var(--dsw-alias-label-secondary, currentColor); }
.vssWbWorkspaceSelect:focus-visible, .vssWbConversation button:focus-visible { outline:2px solid var(--dsw-alias-label-primary, currentColor); outline-offset:2px; }
.vssWbConversationError { color: var(--dsw-alias-state-error-primary, #e5484d); }
.vssWbDockHost { position:relative; display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; height:100%; }
/* AI 助手栏右上角「＋ 新会话」：所有工作台共用一份（2026-11-02）。z-index 低于浮动工具栏，但高于对话内容。 */
.vssWbNewSession { position:absolute; z-index:2147481000; right:10px; top:5px; height:22px; padding:0 10px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); background:var(--dsw-alias-bg-layer-1, #25252a); color:var(--dsw-alias-label-primary, #e6e6ea); font:11px/20px -apple-system, Segoe UI, sans-serif; cursor:pointer; pointer-events:auto; }
.vssWbNewSession:hover:not([disabled]) { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); }
.vssWbNewSession[disabled] { opacity:.6; cursor:default; }
.vssWbDockHost > .vssWbConversation { margin:16px; }
.vssWbDock { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; }
/* 工作台加载态（方案 D 极简呼吸点）：盖在内容之上，z-index 低于浮动胶囊（它 2147482000）。 */
.vssWbPanelBody { position:relative; display:flex; flex:1 1 auto; min-height:0; min-width:0; }
/* ⚠ 必须**纵向** flex：原来是 .vssWbFrame（column）直接当父级，宽高都靠 stretch 铺满；
   中间插一层如果用了横向 flex，子面板的宽度就变成"内容宽度"⇒ 记忆库被压成一条窄栏、文字竖排（2026-11-02 真机）。 */
.vssWbPanelContent { display:flex; flex-direction:column; flex:1 1 auto; min-height:0; min-width:0; }
.vssWbPanelContent > * { flex:1 1 auto; min-width:0; min-height:0; }
/* ★ 2026-11-19 右侧栏工作台 tab：根必须有确定高度，否则 .wb/iframe 的 100% 在 auto 父级上失效，
   只剩工具条高度，被 .paneContent 的 overflow:hidden 裁成截图里的「内容被截断」。
   与 client.workbenchNav.js 的中栏修复同口径：flex:1 1 auto + height:100% + min-height:0 双保险。 */
[data-vssaros-wb-sidebar-page] { display:flex; flex-direction:column; flex:1 1 auto; min-width:0; min-height:0; width:100%; height:100%; overflow:hidden; }
[data-vssaros-wb-sidebar-page] > * { flex:1 1 auto; min-width:0; min-height:0; }
[data-vssaros-wb-sidebar-page] > iframe { display:block; flex:1 1 auto; width:100%; height:100%; min-height:0; border:0; }
.vssWbLoading { position:absolute; inset:0; z-index:6; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;
  background:var(--dsw-alias-bg-base, #1b1b1f); opacity:1; transition:opacity .18s ease; }
.vssWbLoading.is-out { opacity:0; pointer-events:none; }
.vssWbLoadingPulse { width:34px; height:34px; border-radius:9px; background:rgba(79,140,255,.22); border:1px solid rgba(79,140,255,.5); animation:vssWbPulse 1.7s ease-in-out infinite; }
.vssWbLoadingLine { width:120px; height:1px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.22),transparent); }
.vssWbLoadingCap { font-size:11px; letter-spacing:.4px; color:var(--dsw-alias-label-tertiary, rgba(230,230,234,.45)); }
.vssWbLoadingHint { font-size:10.5px; color:var(--dsw-alias-label-caption, rgba(230,230,234,.30)); }
@keyframes vssWbPulse { 0%,100% { opacity:.55; transform:scale(.985); } 50% { opacity:1; transform:scale(1); } }
.vssWbDock[hidden], .vssWbDockHost[hidden] { display:none; }
/* ★ 2026-11-02 标准分栏：左对话 / 右业务（业务宽度走 --vssaros-wb-business-width，0.25–0.7）。
   窄容器（<720px）自动叠成上下：先业务、后对话，避免把业务面板压成一条缝。 */
.vssWbSplit { display:flex; flex:1; min-height:0; min-width:0; flex-direction:row; }
.vssWbSplit[data-business-side="left"] { flex-direction:row-reverse; }
.vssWbSplitConversation { position:relative; display:flex; flex-direction:column; flex:1 1 auto; min-width:0; min-height:0; border-right:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
.vssWbSplitBusiness { display:flex; flex-direction:column; flex:0 0 var(--vssaros-wb-business-width, 36%); min-width:0; min-height:0; }
.vssWbSplitConversation[hidden] { display:none; }
.vssWbSplit[data-assist-collapsed="1"] .vssWbSplitBusiness { flex:1 1 auto; }
/* ★ 2026-11-02：业务在左（row-reverse）时，对话列视觉上跑到**右边** ⇒ 它原来的 border-right 会落到
   窗口最右边缘（看着像少了一条分栏线）⇒ 改画在对话列的**左**边（业务与对话之间）。 */
.vssWbSplit[data-business-side="left"] .vssWbSplitConversation {
  border-right:0; border-left:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18));
}
.vssWbSplitConversation > .vssWbConversation { margin:16px; }
@container vss-workbench (max-width: 720px) {
  .vssWbSplit, .vssWbSplit[data-business-side="left"] { flex-direction:column; }
  .vssWbSplitConversation,
  /* 业务在左时上面那条 border-left 在竖向堆叠下要清掉（否则竖排时左边多一条线） */
  .vssWbSplit[data-business-side="left"] .vssWbSplitConversation { border-right:0; border-left:0; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); min-height:240px; }
  .vssWbSplitBusiness { flex:1 1 auto; }
}
/* ★ 2026-10-26「S2 一体条」：AI 助手展开 + 外开 合成一条竖直胶囊，整组可拖（所有工作台共用一份） */
/* ★ 2026-10-27：与媒体库的浮动区**完全同一套样式**（A 方案 + 边缘高亮）
.   —— vssaros-media 的 .m-fab 与这条 .vssWbActions 的高亮参数必须逐字一致（由
.   dsh-plugins/check-assistant-collapse.mjs 的跨插件一致性断言钉住）✓ */
.vssWbActions { position:absolute; right:12px; top:50%; transform:translateY(-50%); z-index:2147482000; display:flex; flex-direction:column; padding:3px; border-radius:10px; border:1px solid rgba(47,129,247,.55); background:var(--dsw-alias-bg-layer-1, #25252a) linear-gradient(180deg, rgba(38,38,44,.96), rgba(30,30,35,.96)); box-shadow:0 0 0 1px rgba(47,129,247,.16), 0 0 16px rgba(47,129,247,.30), 0 4px 12px rgba(0,0,0,.45); opacity:.96; cursor:grab; touch-action:none; user-select:none; transition:box-shadow .16s, border-color .16s; }
.vssWbActions:hover { border-color:rgba(47,129,247,.85); box-shadow:0 0 0 1px rgba(47,129,247,.35), 0 0 26px rgba(47,129,247,.45), 0 6px 18px rgba(0,0,0,.5); }
.vssWbActions[data-dragging] { cursor:grabbing; }
.vssWbActions[data-moved] { transform:none; }
.vssWbActions .wbWrap { position:relative; display:flex; }
.vssWbActions .wbAct { width:26px; height:25px; padding:0; display:inline-flex; align-items:center; justify-content:center; border:0; border-radius:7px; background:transparent; color:var(--dsw-alias-label-secondary, #9d9da7); font:13px/1 -apple-system, Segoe UI, sans-serif; cursor:pointer; transition:color .14s, background .14s, box-shadow .14s; }
.vssWbActions .wbAct:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); color:var(--dsw-alias-label-primary, #e6e6ea); }
.vssWbActions .wbAct:focus-visible { outline:2px solid var(--dsw-alias-label-primary, currentColor); outline-offset:2px; }
.vssWbActions .wbWrap:focus-within .wbLabel { opacity:1; transform:translateY(-50%) translateX(0); }
.vssWbActions .wbActAssist { color:#6cb0ff; }
.vssWbActions .wbActAssist:hover { color:#a8d2ff; box-shadow:0 0 12px rgba(47,129,247,.55) inset; }
.vssWbActions .wbDivider { height:1px; margin:1px 3px; background:linear-gradient(90deg, transparent, rgba(47,129,247,.75), transparent); }
.vssWbActions[data-assist="none"] .wbDivider, .vssWbActions[data-assist="none"] .wbWrapAssist { display:none; }
.vssWbActions .wbAct[data-state="blocked"] { color:var(--dsw-alias-state-warn-primary, #d29922); }
.vssWbActions .wbLabel { position:absolute; right:34px; top:50%; transform:translateY(-50%) translateX(4px); white-space:nowrap; font:10px/1.6 -apple-system, Segoe UI, sans-serif; color:var(--dsw-alias-label-primary, #e6e6ea); background:var(--dsw-alias-bg-layer-1, #25252a); border:1px solid rgba(47,129,247,.45); border-radius:6px; padding:1px 7px; box-shadow:0 0 12px rgba(47,129,247,.30), 0 1px 4px rgba(0,0,0,.35); opacity:0; pointer-events:none; transition:opacity .14s, transform .14s; }
.vssWbActions .wbWrap:hover .wbLabel { opacity:1; transform:translateY(-50%) translateX(0); }
.vssWbActions[data-label="right"] .wbLabel { right:auto; left:34px; transform:translateY(-50%) translateX(-4px); }
.vssWbActions[data-label="right"] .wbWrap:hover .wbLabel { transform:translateY(-50%) translateX(0); }
.vssWbDockedConversation { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; height:100%; }
/* P3 右侧「开始」页：按 dsh-sidebar-layout.html?v=6 的视觉契约实现。只使用主题令牌，不写死表面色。 */
.vssaros-home { display:block; flex:1 1 auto; width:100%; height:100%; min-width:0; max-width:100%; min-height:0; box-sizing:border-box; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain; scrollbar-width:thin; padding:27px 24px 20px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); container-type:inline-size; font:13px/1.6 -apple-system, BlinkMacSystemFont, Segoe UI, Microsoft YaHei, sans-serif; }
.vssaros-home, .vssaros-home * { box-sizing:border-box; }
.vssaros-home button, .vssaros-home input { font:inherit; color:inherit; }
.vssaros-home button { cursor:pointer; border:0; background:none; }
.vssaros-home button:disabled { cursor:not-allowed; opacity:.5; }
.vssaros-home :focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.vssaros-home-icon { width:18px; height:18px; flex-shrink:0; fill:none; stroke:currentColor; stroke-width:1.65; stroke-linecap:round; stroke-linejoin:round; }
.vssaros-home-small { font-size:11px; color:var(--dsw-alias-label-tertiary); }
.vssaros-home-search { display:flex; align-items:center; gap:7px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l2); border-radius:9px; padding:8px 10px; margin-bottom:14px; }
.vssaros-home-search:focus-within { border-color:var(--dsw-alias-brand-primary); }
.vssaros-home-search svg { width:15px; height:15px; color:var(--dsw-alias-label-tertiary); }
.vssaros-home-search input { width:100%; min-width:0; border:0; background:none; outline:none; font-size:12px; }
.vssaros-home-section-head { display:flex; align-items:center; gap:6px; margin:19px 0 10px; }
.vssaros-home-section-head h2 { font-size:12px; font-weight:600; margin:0; }
.vssaros-home-section-head .vssaros-home-small { margin-left:auto; white-space:nowrap; }
.vssaros-home-pill { display:inline-flex; align-items:center; padding:2px 7px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; font-size:10px; color:var(--dsw-alias-label-secondary); }
.vssaros-home-section-actions { margin-left:auto; display:flex; align-items:center; gap:6px; position:relative; }
.vssaros-home-section-actions .vssaros-home-more-wrap { position:relative; }
.vssaros-home-section-actions .vssaros-home-more-card { width:auto; min-height:28px; border-style:solid; padding:4px 9px; }
.vssaros-home-workbench-card.is-anchored { border-color:var(--dsw-alias-brand-primary); }
.vssaros-home-workbench-card.is-anchored .vssaros-home-anchor { color:var(--dsw-alias-brand-primary); }
.vssaros-home-item-order-controls { position:absolute; right:6px; bottom:6px; display:flex; gap:2px; z-index:2; }
.vssaros-home-tool-grid, .vssaros-home-workbench-grid { display:grid; gap:9px; min-width:0; max-width:100%; }
.vssaros-home-tool-grid { grid-template-columns:minmax(0,1fr); }
.vssaros-home-workbench-grid { grid-template-columns:repeat(2,minmax(0,1fr)); min-width:0; max-width:100%; }
.vssaros-home-more-wrap { grid-column:1/-1; position:relative; }
.vssaros-home-more-card { grid-column:1/-1; display:flex; align-items:center; gap:8px; min-height:40px; width:100%; border:1px dashed var(--dsw-alias-border-l2); border-radius:9px; background:var(--dsw-alias-bg-layer-1); padding:7px 12px; }
.vssaros-home-more-card svg { width:16px; height:16px; color:var(--dsw-alias-label-secondary); }
.vssaros-home-more-card b { font-weight:500; font-size:11px; }
.vssaros-home-more-card[aria-expanded="true"] { border-color:var(--dsw-alias-label-tertiary); background:var(--dsw-alias-bg-layer-2); }
.vssaros-home-chevron { margin-left:auto; width:13px; height:13px; transition:transform .15s; }
.vssaros-home-more-card[aria-expanded="true"] .vssaros-home-chevron { transform:rotate(180deg); }
.vssaros-home-menu { padding:5px; border:1px solid var(--dsw-alias-border-l3); border-radius:10px; background:var(--dsw-alias-bg-layer-3); font-size:12px; }
.vssaros-home-menu button { display:flex; align-items:center; gap:9px; min-height:37px; text-align:left; width:100%; padding:8px 10px; border-radius:6px; white-space:nowrap; }
.vssaros-home-menu button:hover, .vssaros-home-menu button:focus-visible { background:var(--dsw-alias-bg-layer-2); }
.vssaros-home-menu svg { width:15px; height:15px; color:var(--dsw-alias-label-secondary); }
.vssaros-home-menu-separator { height:1px; background:var(--dsw-alias-border-l3); margin:4px 7px; }
.vssaros-home-workbench-card { position:relative; min-width:0; max-width:100%; min-height:84px; border:1px solid var(--dsw-alias-border-l2); border-radius:11px; background:var(--dsw-alias-bg-layer-1); overflow:visible; scroll-margin-top:16px; transition:background .16s,border-color .16s; }
.vssaros-home-workbench-card:hover:not(:disabled) { border-color:var(--dsw-alias-border-l3); }
.vssaros-home-workbench-card:target { border-color:var(--dsw-alias-brand-primary); box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.vssaros-home-workbench-card:target .vssaros-home-anchor { color:var(--dsw-alias-brand-primary); }
.vssaros-home-workbench-card.is-dragging { opacity:.35; }
.vssaros-home-workbench-card.is-drop-target { box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary); }
.vssaros-home-workbench-card.is-keyboard-dragging { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.vssaros-home-workbench-open { display:block; width:100%; height:100%; min-height:100px; text-align:left; padding:13px 12px 11px; border:0; border-radius:10px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }
.vssaros-home-workbench-open header { display:flex; align-items:center; gap:7px; margin-bottom:5px; padding-right:64px; }
.vssaros-home-workbench-open header svg { width:15px; height:15px; color:var(--dsw-alias-label-secondary); }
.vssaros-home-workbench-open header strong { font-size:12px; font-weight:500; min-width:0; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; }
.vssaros-home-workbench-open p { margin:0; color:var(--dsw-alias-label-secondary); font-size:10px; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; }
.vssaros-home-new-badge { margin-left:auto; font-size:9px; color:var(--dsw-alias-state-success-primary); }
.vssaros-home-workbench-open .vssaros-home-new-badge { position:absolute; right:13px; bottom:10px; }
.vssaros-home-source { color:var(--dsw-alias-label-tertiary); font-size:9px; margin-top:5px; padding-right:20px; white-space:nowrap; text-overflow:ellipsis; overflow:hidden; }
.vssaros-home-card-actions { position:absolute; right:4px; top:4px; display:flex; align-items:center; gap:4px; z-index:2; }
.vssaros-home-anchor-button { display:grid; place-items:center; width:28px; height:28px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; color:var(--dsw-alias-label-tertiary); background:var(--dsw-alias-bg-layer-1); cursor:pointer; }
.vssaros-home-anchor-button svg { width:15px; height:15px; }
.vssaros-home-anchor-button:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-label-tertiary); }
.vssaros-home-anchor-button[aria-pressed="true"] { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
/* 已固定态不能只靠 aria-pressed 的颜色（主题里品牌色可能与默认色相同）：加背景 + 内描边 + 对勾图标。 */
.vssaros-home-card-actions .vssaros-home-anchor-button.is-pinned { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-3); box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.vssaros-home-card-actions .vssaros-home-anchor-button.is-pinned svg { stroke-width:2.2; }
.vssaros-home-drag-handle { position:absolute; right:4px; top:4px; display:grid; place-items:center; width:32px; height:32px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; color:var(--dsw-alias-label-tertiary); background:var(--dsw-alias-bg-layer-1); cursor:grab; touch-action:none; }
.vssaros-home-card-actions .vssaros-home-drag-handle { position:static; width:28px; height:28px; }
.vssaros-home-anchor { z-index:1; }
.vssaros-home-drag-handle svg { width:15px; height:15px; }
.vssaros-home-drag-handle:active { cursor:grabbing; }
.vssaros-home-drag-handle:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.vssaros-home-drag-preview { border:1px solid var(--dsw-alias-border-l3); border-radius:11px; background:var(--dsw-alias-bg-layer-2); }
.vssaros-home-drag-preview [data-vssaros-home-drag] { display:none; }
.vssaros-home-drag-help, .vssaros-home-keyboard-help { font-size:10px; color:var(--dsw-alias-label-tertiary); margin:0 0 10px; }
.vssaros-home-keyboard-help { margin-top:10px; }
.vssaros-home-icon-button { display:grid; place-items:center; width:27px; height:30px; border:1px solid var(--dsw-alias-border-l3); border-radius:7px; background:var(--dsw-alias-bg-layer-1); }
.vssaros-home-icon-button svg { width:13px; height:13px; }
.vssaros-home-icon.down { transform:rotate(180deg); }
.vssaros-home-tool-order-actions { grid-column:1/-1; display:flex; align-items:center; gap:6px; padding:7px 0; }
.vssaros-home-tool-order-actions .vssaros-home-small { flex:1; }
.vssaros-home-button { font-size:11px; padding:5px 9px; border:1px solid var(--dsw-alias-border-l3); border-radius:8px; }
.vssaros-home-button:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.vssaros-home-empty { padding:25px; text-align:center; color:var(--dsw-alias-label-secondary); }
.vssaros-home-notice { font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:10px; }
.vssaros-home-install-notice { margin:0 0 14px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l3); border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.6; overflow-wrap:anywhere; }
@container (min-width:376px) { .vssaros-home-tool-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@container (max-width:375px) { .vssaros-home { padding:22px 16px; } .vssaros-home-workbench-grid { grid-template-columns:1fr; } }
@media(pointer:coarse) { .vssaros-home-menu button { min-height:44px; } .vssaros-home-card-actions .vssaros-home-drag-handle, .vssaros-home-anchor-button { width:38px; height:38px; } .vssaros-home-workbench-open header { padding-right:84px; } }
@media(prefers-reduced-motion:reduce) { .vssaros-home * { transition:none!important; } }
`;
		/**
		 * 注入样式（幂等 + **会更新**）。
		 *
		 * ★ 2026-11-02（用户：「加载态未生效」）：原来见到同 id 的 `<style>` 就 `return`。
		 *   一旦文档里已经存在这个标签（上一版 chunk 注入的 / 页面没整页刷新只换了模块），
		 *   新版本新增的规则**永远写不进去** ⇒ 新加的元素完全没有样式：
		 *   加载态于是退化成普通流里的裸文字，挤在左上角（真机截图就是这样）。
		 * ⇒ 现在存在就更新内容，保证"代码换了 → 样式一定跟着换"。
		 */
		function maintainStyles() {
			let el = document.getElementById(STYLE_ID);
			const created = !el;
			if (!el) {
				el = document.createElement('style');
				el.id = STYLE_ID;
				document.head.appendChild(el);
			}
			if (el.textContent !== CSS) { el.textContent = CSS; }
			return () => { if (created) { el.remove(); } };
		}

		function apply(ctx) {
			// 左栏由 anchor 决定：模块加载即安装桥与三行隐藏，不依赖 guide 挂载或 inject 回调。
			try { installHomeAnchorBridge(); } catch { /* 后续兜底 */ }
			try {
				setTimeout(installHomeAnchorBridge, 400);
				setTimeout(installHomeAnchorBridge, 1500);
			} catch { /* 老宿主 */ }
			const service = new Workbenches(ctx);
			service.View = makeView(service);
			service.PageView = makePageView(service);
			ctx.effect(maintainStyles, 'vssaros-workbenches: styles');
			// ★ 2026-11-02：默认 agent 要用 `remote.agentPresets.select`（官方：`select(sessionId, presetId)`）。
			//   ⚠ 必须 `ctx.inject`：未声明 inject 的包里 `ctx.get` 返回 undefined（kb / studio 都踩过）。
			//   服务缺席 ⇒ 只是不套默认 agent，工作台其它功能不受影响，所以**不放进 module.exports.inject**（那会变成硬依赖）。
			try {
				if (typeof ctx.inject === 'function') {
					ctx.inject(['remote.agentPresets'], (scope) => {
						service.agentPresets = (scope && (scope['remote.agentPresets'] || (typeof scope.get === 'function' ? scope.get('remote.agentPresets') : null))) || null;
					});
				}
			} catch (error) { console.warn('[vssaros-workbenches] 注入 remote.agentPresets 失败（不套默认 agent）：' + String((error && error.message) || error)); }
			ctx.effect(() => ctx.reflect.provide('desktopWorkbenches', service), 'vssaros-workbenches: service');
			// 单一目录探针：策略、entries、订阅都在 manifest 注册 effect 之前就绪。
			globalThis.__vssarosWorkbenchPolicy = () => catalogPolicyProbeOf(service.getCatalogSnapshot().pages);
			globalThis.__vssarosWorkbenchCatalogEntries = () => catalogEntriesOf(service.getCatalogSnapshot().pages);
			globalThis.__vssarosWorkbenchCatalogSubscribe = listener => service.subscribeCatalog(listener);
			globalThis.__vssarosWorkbenchLegacyBridgeMode = () => legacyBridgeModeOf(globalThis);
			// 阶段 4 硬退役：manifest active route 行直接进统一目录；不再读取旧全局清单、轮询或监听 tabs-change。
			ctx.effect(() => {
				if (!ctx.fiber || !ctx.fiber.entry) { return undefined; }
				service.registerManifestPages();
				return () => { delete globalThis.__vssarosWorkbenchManifestPagesRegistered; };
			}, 'vssaros-workbenches: manifest catalog');
			// P2/P3：软等待 `betterSidebar`，不放进 module.exports.inject（独立 dsh 组合没装插件也能启动）。
			try {
				if (typeof ctx.inject === 'function') {
					ctx.inject(['betterSidebar'], (scoped) => {
						const sidebar = optionalService(scoped, 'betterSidebar');
						if (!sidebar) { return; }
						// 左栏 item 完全由 anchor 决定 ⇒ registry / 打开桥 / DOM 桥不能依赖「开始」页是否挂载。
						const registry = getHomeItemRegistry(service, sidebar);
						globalThis.__vssarosHomeItemRegistry = registry;
						if (typeof globalThis.__vssarosOpenHomeAnchor !== 'function') {
							globalThis.__vssarosOpenHomeAnchor = key => {
								const item = registry.get(key);
								if (!item) { return; }
								if (item.origin.registry === HOME_ITEM_SOURCE_TABS && typeof sidebar.openTab === 'function') {
									sidebar.openTab({ type: item.tabId }); return;
								}
								const open = globalThis.__vssarosOpenWorkbenchCatalogPage;
								if (typeof open === 'function' && open(item.catalogKey) === true) { return; }
								if (item.workbenchId && typeof service.open === 'function') { service.open(item.workbenchId); }
							};
						}
						try { installHomeAnchorBridge(); } catch { /* DOM 未就绪时由后续重贴兜底 */ }
						return installSidebarLayoutOwnership(ctx, service, sidebar);
					});
				}
			} catch (error) {
				console.warn('[vssaros-workbenches] 注入 betterSidebar 失败（右栏目录/新主页不启用）：' + String((error && error.message) || error));
			}

			/* ★ 2026-10-26 深链：`?wb=vssaros/agents`（也接受 `vssaros:agents`）⇒ 注册后自动打开该工作台。
			   为什么加：IDE 的 **Bots 页签目前承载的是插件 SSR 页**（`/x/agents/`，内容是旧的），
			   而 React 工作台只存在于 dsh 客户端里。有了深链，宿主/用户可以用 URL 直接打开它，
			   不必等 IDE 侧的 surface 改造（那需要重编译 + 管理员权限安装）。
			   ⚠ 只在**带参数**时生效；各工作台注册有先后 ⇒ 轮询等待，最多 12s 后放弃（不打扰正常使用）。 */
			ctx.effect(() => {
				let want = '';
				/* ⚠ 2026-10-26 实测：**不能只读 query** —— Host 会把 `/?token=…` 302 到 `/`，
				   query 在首个脚本执行前就没了。所以两路都读：
				     ① `?wb=`（手工调试用，若哪天不再重定向就仍然有效）
				     ② `localStorage['vssaros.wb.pending']`（承载页写的一次性标记，重定向带不走）
				   读到 localStorage 的那份后**立即删除**，避免下次普通打开也被切走。 */
				let pendingRaw = '';
				try {
					const pending = window.localStorage.getItem('vssaros.wb.pending');
					if (pending) {
						pendingRaw = String(pending).trim();
						window.localStorage.removeItem('vssaros.wb.pending');
					}
				} catch (e) { /* 隐私模式读不到就算了 */ }
				// ★ 2026-10-26：新增 hash 通道（`#wb=vssaros/studio`）—— 「外开」按钮用它，
				//   因为 Host 的 302 会丢掉 query，但 hash 会被浏览器保留。
				want = parseDeepLinkWorkbench(window.location.search, window.location.hash, pendingRaw);
				if (!want) { return undefined; }
				// ★「外开只显示工作台」：链接带 `alone=1` ⇒ 打开工作台后收起 dsh 左侧会话栏。
				const alone = isAloneDeepLink(window.location.search, window.location.hash);
				/* 可观测状态：真机排查时读 `window.__vssarosWbDeepLink` 就能知道
				   "深链跑没跑 / 试了几次 / open() 抛了什么"，不必靠猜。 */
				const dbg = { want, tries: 0, opened: false, lastErr: '', providers: [] };
				window.__vssarosWbDeepLink = dbg;
				let tries = 0;
				const timer = setInterval(() => {
					tries += 1;
					dbg.tries = tries;
					try {
						dbg.providers = Array.from(service.providers ? service.providers.keys() : []);
					} catch (e) { /* ignore */ }
					let opened = false;
					try {
						opened = service.open(want) === true;
					} catch (e) {
						dbg.lastErr = String((e && e.message) || e);
						opened = false;
					}
					if (opened) {
						dbg.opened = true;
						clearInterval(timer);
						/* 外开：收起左侧会话栏，只留工作台（+ 右侧 AI 助手）。
						   `toggleSidebar()` 是唯一能把 `layoutInfo.sidebar` 置 0 的入口
						   （`setSidebar` 会被 clamp 到 264）；store 初始值固定 280，
						   所以新开的窗口 toggle 一次必定变成 0（收成 56px 图标栏）。 */
						if (alone) {
							try {
								/* ⚠ 窄屏（<1024）时 `toggleSidebar` 只切 `narrowExpanded`，
								   不动 `layoutInfo.sidebar` ⇒ 侧栏不会收起（窄屏本来就自动收成图标栏）。
								   记下宽度，避免排查时把"没生效"误判成"调用失败"。 */
								dbg.viewportWidth = window.innerWidth;
								dbg.narrow = window.innerWidth < 1024;
								ctx.layout.toggleSidebar();
								dbg.sidebarCollapsed = true;
							} catch (e) {
								dbg.sidebarError = String((e && e.message) || e);
							}
						}
						return;
					}
					if (tries >= 60) {
						clearInterval(timer);
						console.warn('[vssaros-workbenches] 深链没打开（这个工作台可能没注册）：' + want
							+ ' 已注册=[' + dbg.providers.join(',') + ']' + (dbg.lastErr ? ' 错误=' + dbg.lastErr : ''));
					}
				}, 200);
				return () => clearInterval(timer);
			}, 'vssaros-workbenches: deep link (?wb=)');

			/* ★★ 2026-10-24 真机报障（用户第 2 次报）「bot 工作台里切换工作区 ⇒ 整个工作台被换成会话页」。
			   根因在 dsh 自己的客户端包里（不是我们的代码）：
			     `dsh-client-ui-workspace/lib/client.js` 的 `replaceMain(target, signal, panel, …)` 末尾
			     `if (panel === 'reveal') this.ctx.layout.selectPanel(null)`  ⇒ 直接把前台面板置空。
			   工作台里的官方对话（`props.conversation`）点"切换工作区"就是走这条路 ⇒
			   **它不经过本服务的 `showSession()`**，所以上一轮改 showSession 三分支拦不住 ✗。

			   ⇒ 只能在 `layout.selectPanel` 上拦。口径**刻意收窄**：
			     · 只拦 `panel === null`（切到别的面板不拦）
			     · 只在前台确实是"整页工作台（customFrame）"时拦
			     · `leave()` 会先把 `active` 置 null 再调 ⇒ **自动放行**（用户主动关工作台不受影响）
			   拦下来时打 warn：真机上如果要区分"谁在关面板"，看这条日志。 */
			ctx.effect(() => {
				const layout = ctx.layout;
				if (!layout || typeof layout.selectPanel !== 'function') { return undefined; }
				if (layout.selectPanel.__vssarosGuarded) { return undefined; }
				const original = layout.selectPanel.bind(layout);
				/**
				 * ⚠ 2026-10-28（用户：「打开工作台后，点工作区里的会话 item 没反应」——媒体库、商城都报过）：
				 *   根因就在这个拦截器**只拦不接**：
				 *   `dsh-client-ui-workspace` 的 `openSession()` → `replaceMain(target, …, 'reveal')` 会
				 *   ① `selection.set({ sessionId })`（会话**已经换选了**）② 末尾 `layout.selectPanel(null)`。
				 *   我们拦住 ② ⇒ 中栏保持工作台（正确），但**没人把新选中的会话停靠进对话列**
				 *   ⇒ 用户看到的就是"点了没反应"。
				 *   ⇒ 拦下来时必须补一步：`service.showSession(刚选中的会话)`（它内部会校验归属/自动绑定，
				 *     归属别的工作台时只写 `dockError`，不会把用户踢出去 ✓）。
				 */
				const currentMainSessionId = () => {
					// ① 最可靠：`replaceMain()` 在调 `selectPanel(null)` 的**前一行**刚把 mainReference 换成目标会话
					//   （新建会话此刻还没进 sessions.list 快照，只有这里有它）。
					try {
						const ref = ctx.uiWorkspace && ctx.uiWorkspace.mainReference;
						const sid = ref && ref.sessionId;
						if (typeof sid === 'string' && sid) { return sid; }
					} catch (e) { /* 读不到就换下一种 */ }
					try {
						const snap = ctx.uiWorkspace && ctx.uiWorkspace.selection && ctx.uiWorkspace.selection.getSnapshot
							? ctx.uiWorkspace.selection.getSnapshot() : null;
						const sid = snap && snap.sessionId;
						if (typeof sid === 'string' && sid) { return sid; }
					} catch (e) { /* 读不到就换下一种 */ }
					try {
						const byId = ctx.sessions.list.getSnapshot().byId || {};
						const hit = Object.values(byId).find((s) => s && s.retainedBy && (s.retainedBy.mainView || 0) > 0);
						return hit ? hit.id : undefined;
					} catch (e) { return undefined; }
				};
				/**
				 * ★★ 2026-11-03（用户报「切到知识库/商城页签，再切回会话页签 ⇒ 中栏空白」）：
				 *   工作台**页签栏**切回「会话」时只调 `selectPanel(null)`，**不换会话**；
				 *   而工作台内部"切会话/切工作区"走 `replaceMain` ⇒ 会先把 main 换成新会话。
				 *   ⇒ 用「main 会话是否变化」区分这两种意图，补上 `navIntentAt` 覆盖不到的入口
				 *   （页签栏在 iframe/外壳里，跨插件的 openSession 包装与页面级信号都打不到 ✗）。
				 *   初始化为安装守卫那一刻的 main ⇒ 打开工作台后 main 未变 ⇒ 切回会话页签判为"只切面板" ✓
				 */
				let lastMainSidAtPanelCall = currentMainSessionId() || '';
				const guarded = (panel) => {
					try {
						/**
						 * ★ 2026-10-28（用户：「点工作区左侧会话 item 时，**要求切换到会话页进行展示**」）：
						 *   **侧栏导航必须放行** —— 让 dsh 走原生 `replaceMain` ⇒ 中栏切到**会话页**。
						 *   只有"工作台**内部**的切会话/切工作区"（不经过 openSession/startSession 的那条）
						 *   才拦下来停靠进工作台对话列（那是 2026-10-24 报障的要求：别把用户踢出工作台）。
						 *   判据：`navIntentAt` 由被包的 openSession / startSession 打时间戳，
						 *   2.5s 内视为"用户主动导航"（startSession 是异步的，所以用时间窗而不是布尔量）。
						 */
						if (Date.now() - lastUserNavAt() < 2500) {
							// ★ 2026-10-28（用户：「点会话 item 没切过去，手动点会话页又是空白」）：
							//   只放行 `selectPanel(null)` 还不够 —— 前台工作台如果正在**停靠对话**
							//   （`shell.overlay` 把 `conversation` portal 进工作台的 dock），
							//   主面板就没有对话可渲染 ⇒ 会话页**空白**。
							//   ⇒ 用户主动导航时先 `leave()`：把 active 置空（覆盖层停止 portal）+ 回会话面板。
							try {
								if (service.active && service.docksConversation(service.active)) { service.leave(); }
							} catch (e) { /* 停靠停止失败不影响导航 */ }
							return original(panel);
						}
						if (panel === null && service.active && service.docksConversation(service.active)) {
							const sid = currentMainSessionId();
							// ★ 2026-11-03：main 没变 ⇒ 只是"切回会话页签"，不是工作台内部换会话
							//   ⇒ 退出工作台并放行，让中栏重新渲染会话（否则面板停在工作台、embed 全隐藏 ⇒ 白框 ✗）
							const onlyPanelSwitch = !!sid && sid === lastMainSidAtPanelCall;
							lastMainSidAtPanelCall = sid || lastMainSidAtPanelCall;
							/**
							 * ★ 2026-11-03 二次修正：真机复现「知识库 → 商城 → 切回会话」仍被拦截。
							 *   原因：工作台 open() 期间会新建/切换自己的会话 ⇒ main 已变 ⇒
							 *   `onlyPanelSwitch` 不成立（拿 main 当基准不可靠 ✗）。
							 *   改用**调用栈**：工作台内部"切会话/切工作区"必经官方
							 *   `replaceMain()`（内部末尾才 `selectPanel(null)`）；而页签栏/侧栏切回会话
							 *   是**直接**调 `selectPanel(null)` ⇒ 栈里没有这些帧。
							 *   ⇒ 非 replaceMain 的 `selectPanel(null)` 一律视为"用户要回会话页" ⇒ 放行。
							 */
							const stack = String((new Error()).stack || '');
							const fromReplaceMain = /replaceMain|openSession|startSession|connectBlank/.test(stack);
							if (onlyPanelSwitch || !fromReplaceMain) {
								try { service.leave(); } catch (e) { /* 退出失败不阻断放行 */ }
								console.info('[vssaros-workbenches] 切回会话面板（非 replaceMain）⇒ 放行 selectPanel(null)');
								return original(panel);
							}
							// ⚠ 2026-10-28：**不要**在这里用 sessionExists（查 sessions.list）做前置 ——
							//   侧栏「＋ 新建会话」走 startSession → connectBlank → replaceMain，新会话此刻
							//   **还没进列表快照** ⇒ 会被误判"已不存在" ⇒ 新建会话"没反应"。
							//   真失效的会话由停靠区自己的 retain 判定（失败 ⇒ markDead ⇒ 回到「开始对话」）。
							if (sid) {
								console.warn('[vssaros-workbenches] 已拦截 selectPanel(null)：前台整页工作台 = ' + service.active
									+ '；把会话 ' + sid + ' 停靠到工作台对话列');
								try { service.showSession(sid); } catch (e) {
									console.warn('[vssaros-workbenches] 停靠会话失败：' + String((e && e.message) || e));
								}
								// ★ 2026-10-28（用户：「点左侧栏顶部的新建会话，没有任何反应」）：
								//   如果右侧对话列当时是**收起**状态，新会话会停靠进一个看不见的列
								//   ⇒ 用户依然"看不到任何变化"。⇒ 有会话进来就**自动展开**（派发外壳的展开事件）。
								try {
									const collapsedEl = document.querySelector('[data-vssaros-assist-collapsed="1"]');
									if (collapsedEl) {
										collapsedEl.dispatchEvent(new CustomEvent('vssaros:assist-expand', {
											bubbles: true,
											detail: { workbench: service.active },
										}));
									}
								} catch (e) { /* 展开失败不影响停靠 */ }
								return;   // 保住工作台 + 会话落到对话列
							}
							// 读不到目标会话 ⇒ 放行（别把界面卡死）
							console.warn('[vssaros-workbenches] 拦截 selectPanel(null) 时读不到目标会话 ⇒ 放行');
							return original(panel);
						}
					} catch (e) { /* 判断失败就放行，别把布局搞死 */ }
					return original(panel);
				};
				guarded.__vssarosGuarded = true;
				try {
					layout.selectPanel = guarded;
				} catch (e) {
					// 只读代理 ⇒ 装不上。**明确说出来**，别让守卫假装生效。
					console.warn('[vssaros-workbenches] layout.selectPanel 不可写，守卫未安装：' + String((e && e.message) || e));
					return undefined;
				}
				return () => { try { layout.selectPanel = original; } catch (e) { /* 卸载时尽力还原 */ } };
			}, 'vssaros-workbenches: layout guard');			// ★ 2026-10-28：会话**能否被 retain** 的前置校验 —— 必须在调用原 openSession **之前**做：
			//   `sessions.retain` 抛错会中断整条链路（我们的 selectPanel 守卫根本没机会执行），
			//   表现就是"点侧栏会话没反应"。失效（已删除 / 空白草稿且没人持有）⇒ 不调用原函数（不抛），
			//   改为明确提示 + 自愈（清掉指向它的绑定）。
			ctx.effect(() => {
				const ws = ctx.uiWorkspace;
				if (!ws || typeof ws.openSession !== 'function' || ws.openSession.__vssarosWbOpenGuard) { return undefined; }
				const originalOpen = ws.openSession.bind(ws);
				const patchedOpen = function (target) {
					// ★ 用户点侧栏会话 ⇒ 视为"主动导航" ⇒ selectPanel 守卫放行 ⇒ 切到会话页
					markUserNav();
					/**
					 * ★★ 2026-11-02（用户报「点会话页签后中栏是空白」）：
					 *   只打时间戳**不够** —— 调用方的布局更新（如侧栏切页签）可能**先**触发一次
					 *   `selectPanel(null)`，那一刻 `navIntentAt` 还是旧的 ⇒ 守卫把会话**停靠进工作台
					 *   对话列** ⇒ 主面板没有对话可渲染 ⇒ 用户看到一块空白（真机日志：
					 *   `已拦截 selectPanel(null)：前台整页工作台 = vssaros/kb`）。
					 *   ⇒ 用户主动打开会话的**当刻**就 `leave()`（清 active ⇒ 覆盖层停止 portal + 回会话面板），
					 *     不再依赖后面那次 `selectPanel` 的先后顺序 ✓
					 */
					try {
						if (service.active && service.docksConversation(service.active)) { service.leave(); }
					} catch (e) { /* 停止停靠失败不影响打开会话 */ }
					/**
					 * ★★ 2026-11-02 二次（用户报「仍然白框」）：
					 *   `service.leave()` 只清 `active`（覆盖层停止 portal），**面板本身还停在整页工作台上**
					 *   —— `selectPanel` 已经被之前那次拦截切到工作台了。不主动切回来，主面板就没有会话可画，
					 *   仍是白框 ✗。
					 *   ⇒ 这里再请求一次 `selectPanel(null)`：此刻 `navIntentAt` 刚刷新 ⇒ 守卫走"放行"分支 ✓
					 */
					try {
						const l = ctx.layout;
						if (l && typeof l.selectPanel === 'function') { l.selectPanel(null); }
					} catch (e) { /* 切回失败不影响打开会话 */ }
					const sid = typeof target === 'string' ? target : (target && target.sessionId) || '';
					// ★ 不预判「能不能打开」—— 让 dsh 自己判断，它抛我们接住：
					//   空白草稿 / 已删除的会话在 replaceMain 里会抛 unknown session，
					//   异常一旦逃出去，整条链路（选中 → 停靠 → 显示）全断 ⇒ 界面看着「点了没反应」。
					try {
						return originalOpen(target);
					} catch (e) {
						console.warn('[vssaros-workbenches] 打开会话失败：' + sid + '（' + String((e && e.message) || e) + '）');
						service.markDead(sid, '这条会话已失效（空白草稿或已被删除），打不开');
						service.clearStaleBinding(service.active, sid);
						return undefined;   // 吞掉异常 ⇒ 界面不卡死，用户看到明确提示
					}
				};
				patchedOpen.__vssarosWbOpenGuard = true;
				try { ws.openSession = patchedOpen; }
				catch (e) {
					console.warn('[vssaros-workbenches] uiWorkspace.openSession 不可写，守卫未安装：' + String((e && e.message) || e));
					return undefined;
				}
				return () => { try { ws.openSession = originalOpen; } catch (e) { /* 卸载时尽力还原 */ } };
			}, 'vssaros-workbenches: openSession guard');

			// ★ 2026-10-28（用户：「点工作区左侧会话 item 时，要求切换到会话页进行展示」）：
			//   侧栏「新建会话」走的是 `startSession`（**不经过** openSession）⇒ 也标记成"用户导航"，
			//   selectPanel 守卫才会放行 ⇒ 新会话在**会话页**里打开。
			ctx.effect(() => {
				const ws = ctx.uiWorkspace;
				if (!ws || typeof ws.startSession !== 'function' || ws.startSession.__vssarosWbStartGuard) { return undefined; }
				const originalStart = ws.startSession.bind(ws);
				const patchedStart = function () {
					markUserNav();
					return originalStart.apply(null, arguments);
				};
				patchedStart.__vssarosWbStartGuard = true;
				try { ws.startSession = patchedStart; }
				catch (e) {
					console.warn('[vssaros-workbenches] uiWorkspace.startSession 不可写，导航标记未安装：' + String((e && e.message) || e));
					return undefined;
				}
				return () => { try { ws.startSession = originalStart; } catch (e) { /* 卸载时尽力还原 */ } };
			}, 'vssaros-workbenches: startSession nav');

			ctx.effect(() => { void service.load(); return () => service.dispose(); }, 'vssaros-workbenches: state');
			// 会话停靠（整页工作台的 AI 对话显示在工作台自己页面里，不切走）：根覆盖层条目声明 session 子槽，
			// 子槽里放对话面板。覆盖层由根布局常驻渲染 ⇒ 不论工作台开在页签里还是整页面板里都能停靠。
			ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay', id: 'vssaros-workbench-conversation-dock', order: 110,
				children: { [DOCK_SLOT]: { kind: 'single', scope: 'session' } },
			}, makeConversationDock(service))), 'vssaros-workbenches: conversation dock');
			ctx.effect(() => ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({ name: DOCK_SLOT }, DockedConversation)), 'vssaros-workbenches: docked conversation');
			// ★ 2026-10-22（工作台 UI 统一，方案稿 §6.19）：**共享样式表**只在这里注入一次
			//   ⇒ 7 个自有工作台都用 `wb-*` 原语，不各自复制 CSS（改一处七处生效）；
			//   颜色全走 `--dsw-alias-*` 令牌（`body` / `body[data-ds-dark-theme]` 两套值都有 ⇒ 明暗自动跟随）。
			//   ⚠ 装载器只认 `client.*.js` 形状的子块；装不上（老运行时没有 require.async）不影响工作台本体
			//     —— 各包都留了「宿主缺席降级样式」✓。
			//   ⚠ 改过 `client.ui.js`（子块）之后**要再动一下这个入口**（守卫查 mtime）+ **升版本**（否则吃旧字节）。
			try {
				if (typeof require.async === 'function') {
					require.async('./client.ui.js')
						.then(part => { if (part && typeof part.install === 'function') { part.install(); } })
						.catch(e => { console.warn('[vssaros-workbenches] UI 共享层装载失败：' + String(e && e.message || e)); });
				}
			} catch (e) {
				console.warn('[vssaros-workbenches] UI 共享层装载失败：' + String(e && e.message || e));
			}
			// 探针钩子（只读快照；不暴露可写方法）
			globalThis.__vssarosWorkbenchesSnapshot = () => service.getSnapshot();
			ctx.effect(() => {
				globalThis.__vssarosWorkbenchCatalog = () => service.getCatalogSnapshot();
				globalThis.__vssarosWorkbenchCatalogDiagnostics = () => catalogDiagnosticsOf(service.getCatalogSnapshot().pages);
				globalThis.__vssarosWorkbenchCatalogConflicts = () => canonicalConflictsOf(service.getCatalogSnapshot().pages);
				globalThis.__vssarosWorkbenchManifest = () => WORKBENCH_MANIFEST;
				globalThis.__vssarosWorkbenchManifestViews = () => manifestViewsOf();
				return () => {
					delete globalThis.__vssarosWorkbenchCatalog;
					delete globalThis.__vssarosWorkbenchCatalogDiagnostics;
					delete globalThis.__vssarosWorkbenchCatalogConflicts;
					delete globalThis.__vssarosWorkbenchManifest;
					delete globalThis.__vssarosWorkbenchManifestViews;
					delete globalThis.__vssarosWorkbenchPolicy;
					delete globalThis.__vssarosWorkbenchCatalogEntries;
					delete globalThis.__vssarosWorkbenchCatalogSubscribe;
					delete globalThis.__vssarosWorkbenchLegacyBridgeMode;
					delete globalThis.__vssarosWorkbenchManifestPagesRegistered;
				};
			}, 'vssaros-workbenches: catalog probe');
			return undefined;
		}

		module.exports.apply = apply;
		module.exports.inject = ['slots', 'layout', 'sessions', 'workspaces', 'uiWorkspace'];
		module.exports.identityOf = identityOf;
		module.exports.normalize = normalize;
		module.exports.catalogKey = catalogKey;
		module.exports.normalizeCatalogPage = normalizeCatalogPage;
		module.exports.sidebarTabTypeOf = sidebarTabTypeOf;
		module.exports.__installSidebarWorkbenchAdapter = installSidebarWorkbenchAdapter;
		module.exports.readSidebarLayoutV1Config = readSidebarLayoutV1Config;
		module.exports.sidebarGuideReleased = sidebarGuideReleased;
		module.exports.makeVsSarosHomeGuide = makeVsSarosHomeGuide;
		module.exports.__installVsSarosHomeGuide = installVsSarosHomeGuide;
		module.exports.__installSidebarLayoutOwnership = installSidebarLayoutOwnership;
		module.exports.normalizeHomeOrder = normalizeHomeOrder;
		module.exports.moveHomeOrder = moveHomeOrder;
		module.exports.toolEntriesOf = toolEntriesOf;
		module.exports.toolViewOf = toolViewOf;
		module.exports.homeItemKey = homeItemKey;
		module.exports.isHostOwnedTab = isHostOwnedTab;
		module.exports.homeItemOfCatalogPage = homeItemOfCatalogPage;
		module.exports.homeItemOfTabDescriptor = homeItemOfTabDescriptor;
		module.exports.selectHomeItems = selectHomeItems;
		module.exports.createHomeItemRegistry = createHomeItemRegistry;
		module.exports.migrateHomeItemOrder = migrateHomeItemOrder;
		module.exports.parseImageToken = parseImageToken;
		module.exports.pendingInstallsOf = pendingInstallsOf;
		module.exports.selectStartPages = selectStartPages;
		module.exports.selectNativeTabPages = selectNativeTabPages;
		module.exports.selectLauncherPages = selectLauncherPages;
		module.exports.selectRouteWhitelist = selectRouteWhitelist;
		module.exports.resolveLegacyTabKey = resolveLegacyTabKey;
		module.exports.catalogDiagnosticsOf = catalogDiagnosticsOf;
		module.exports.canonicalConflictsOf = canonicalConflictsOf;
		module.exports.workbenchManifest = workbenchManifest;
		module.exports.manifestViewsOf = manifestViewsOf;
		module.exports.catalogPolicyProbeOf = catalogPolicyProbeOf;
		module.exports.catalogEntriesOf = catalogEntriesOf;
		module.exports.legacyBridgeModeOf = legacyBridgeModeOf;
		module.exports.__registerManifestPages = service => service.registerManifestPages();
		module.exports.visibleHomePagesOf = visibleHomePagesOf;
		module.exports.homeWorkbenchCardIdOf = homeWorkbenchCardIdOf;
		module.exports.homeWorkbenchAnchorIdOf = homeWorkbenchAnchorIdOf;
		module.exports.legacyTabKeysOf = legacyTabKeysOf;
		module.exports.imageVersionsUrl = imageVersionsUrl;
		module.exports.pickImageVersion = pickImageVersion;
		module.exports.__registerImageReferenceTab = registerImageReferenceTab;
		module.exports.__openImageReference = openImageReference;
		module.exports.__setSidebarLayoutV1 = setSidebarLayoutV1;
		module.exports.__sidebarLayoutV1Enabled = () => sidebarLayoutV1Enabled;
		module.exports.__openSidebarWorkbenchPage = (key, scope) => activeSidebarAdapter ? activeSidebarAdapter.openPage(key, scope) : false;
		module.exports.__testSetGlobal = (name, value) => { globalThis[name] = value; };
		module.exports.__testDeleteGlobal = name => { delete globalThis[name]; };
		module.exports.__testGetGlobal = name => globalThis[name];
		module.exports.__testReadHomeAnchors = readHomeAnchors;
		module.exports.__testToggleHomeAnchor = toggleHomeAnchor;
		module.exports.__testWriteHomeAnchors = writeHomeAnchors;
		module.exports.__Frame = Frame;
		return module.exports;
	},
});
