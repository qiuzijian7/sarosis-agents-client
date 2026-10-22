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
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-workbenches',
	factory: (require) => {
		var module = { exports: {} };
		const React = require('react');
		const h = React.createElement;

		const STATE_URL = '/api/vssaros-workbenches/state';
		const PANEL_PREFIX = 'vssaros-wb:';
		const VSSAROS_SCHEME = 'vssaros:';
		const GITHUB_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
		const MODULE_RE = /^[a-z][a-z0-9-]{0,31}$/;

		/** 与 `vssarosPluginManifest.ts` 的 `workbenchIdentityOf` 同口径（小写 owner/repo）。 */
		function identityOf(repository) {
			if (typeof repository !== 'string' || !repository.trim()) { throw new Error('Invalid workbench repository'); }
			const value = repository.trim();
			if (value.startsWith(VSSAROS_SCHEME)) {
				const mod = value.slice(VSSAROS_SCHEME.length);
				if (!MODULE_RE.test(mod)) { throw new Error('Invalid workbench repository: ' + value); }
				return 'vssaros/' + mod;
			}
			const m = GITHUB_RE.exec(value);
			if (!m) { throw new Error('Workbench repository must be https://github.com/<owner>/<repo>: ' + value); }
			return (m[1] + '/' + m[2]).toLowerCase();
		}

		/** 校验逐条照官方 register()（client.js:856-869）；失败一律抛。返回规范化后的条目（不含 Component）。 */
		function normalize(descriptor, Component) {
			if (!descriptor || !descriptor.title || typeof Component !== 'function') { throw new Error('Invalid workbench registration'); }
			const id = identityOf(descriptor.repository);
			if (descriptor.customFrame !== undefined && typeof descriptor.customFrame !== 'boolean') { throw new Error('Invalid custom frame flag'); }
			if (descriptor.headerLayout !== undefined && descriptor.headerLayout !== 'default' && descriptor.headerLayout !== 'compact') { throw new Error('Invalid workbench header layout'); }
			const layout = descriptor.layout || {};
			if (layout.businessSide !== undefined && layout.businessSide !== 'left' && layout.businessSide !== 'right') { throw new Error('Invalid workbench business side'); }
			if (layout.businessWidth !== undefined && (!Number.isFinite(layout.businessWidth) || layout.businessWidth < 0.25 || layout.businessWidth > 0.7)) {
				throw new Error('Workbench business width must be between 0.25 and 0.7');
			}
			return Object.assign({}, descriptor, {
				id,
				panel: PANEL_PREFIX + id,
				customFrame: descriptor.customFrame === true,
				headerLayout: descriptor.headerLayout || 'default',
				layout: { businessSide: layout.businessSide || 'right', businessWidth: layout.businessWidth !== undefined ? layout.businessWidth : 0.36 },
			});
		}

		class Workbenches {
			constructor(ctx) {
				this.ctx = ctx;
				this.providers = new Map();
				this.listeners = new Set();
				this.active = null;
				this.revision = 0;
				this.state = null;
				this.stateError = null;
				this.queue = Promise.resolve();
				this.snapshot = this.buildSnapshot();
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			getSnapshot() { return this.snapshot; }
			buildSnapshot() {
				return Object.freeze({
					active: this.active,
					stateError: this.stateError,
					state: this.state,
					workbenches: [...this.providers.values()].map(e => Object.freeze({
						id: e.id, title: e.title, description: e.description || '', icon: e.icon || '',
						customFrame: e.customFrame, headerLayout: e.headerLayout, layout: e.layout, panel: e.panel,
						added: !!(this.state && this.state.added.includes(e.id)),
					})),
				});
			}
			publish() {
				this.snapshot = this.buildSnapshot();
				for (const l of [...this.listeners]) { try { l(); } catch (e) { console.error('[vssaros-workbenches] listener', e); } }
			}

			register(descriptor, Component) {
				const entry = normalize(descriptor, Component);
				if (this.providers.has(entry.id)) { throw new Error('Duplicate workbench provider: ' + entry.id); }
				entry.Component = Component;
				this.providers.set(entry.id, entry);
				const service = this;
				const Panel = function VssarosWorkbenchPanel() { return h(Frame, { service, entry }); };
				let disposeSlot = null;
				try {
					disposeSlot = this.ctx.slots.register({ name: 'main', key: entry.panel }, Panel);
				} catch (error) {
					this.providers.delete(entry.id);
					throw error;
				}
				this.publish();
				return () => {
					if (this.providers.get(entry.id) !== entry) { return; }
					this.providers.delete(entry.id);
					if (this.active === entry.id) { this.leave(); }
					if (typeof disposeSlot === 'function') { disposeSlot(); }
					this.publish();
				};
			}
			has(id) { return this.providers.has(id); }
			/**
			 * 记为前台工作台（不切面板）：嵌入式承载（`View`，如 chat-surface 的页签条）用它记账，
			 * 与 `open()` 共用"首次打开即登记 added"的语义。
			 */
			activate(id) {
				if (!this.providers.has(id)) { return false; }
				if (this.active !== id) { this.active = id; this.publish(); }
				if (this.state && !this.state.added.includes(id)) { void this.add(id).catch(() => { }); }
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
			leave() {
				if (this.active !== null) {
					this.active = null;
					try { this.ctx.layout.selectPanel(null); } catch { /* 布局服务已卸载 */ }
					this.publish();
				}
			}
			current() { return this.active; }

			async load() {
				try {
					const res = await fetch(STATE_URL, { cache: 'no-store' });
					const data = await res.json();
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
				if (!this.providers.has(id)) { return Promise.reject(new Error('工作台当前不可用。')); }
				return this.commit(state => {
					if (!state.added.includes(id)) { state.added.push(id); }
					if (!state.pinned.includes(id)) { state.pinned.push(id); }
				});
			}
			remove(id) {
				return this.commit(state => {
					state.added = state.added.filter(x => x !== id);
					state.pinned = state.pinned.filter(x => x !== id);
					if (state.active === id) { state.active = null; }
				});
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
		function Frame({ service, entry }) {
			return h(HeaderHost, { entry }, h(PanelBoundary, { entry }, h(entry.Component, { service, entry })));
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
				React.useEffect(() => { if (active) { service.activate(id); } }, [id, active]);
				const entry = service.providers.get(id);
				return entry ? h(Frame, { service, entry }) : null;
			};
		}

		const STYLE_ID = 'vssaros-workbenches-style';
		const CSS = `
.vssWbFrame { position:relative; display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; height:100%; overflow:auto; container-type:inline-size; container-name:vss-workbench; }
.vssWbFailure { margin:48px auto; max-width:520px; padding:24px; border-radius:12px; border:1px solid var(--dsw-alias-border-default, rgba(127,127,127,.3)); }
.vssWbFailure h2 { margin:0 0 8px; font-size:16px; }
.vssWbFailure p { margin:0 0 12px; opacity:.8; font-size:13px; line-height:1.6; }
.vssWbFailure pre { margin:0 0 12px; padding:8px; font-size:12px; white-space:pre-wrap; word-break:break-all; background:rgba(127,127,127,.12); border-radius:6px; }
.vssWbFailure button { padding:6px 14px; border-radius:999px; cursor:pointer; }
`;
		function maintainStyles() {
			if (document.getElementById(STYLE_ID)) { return undefined; }
			const el = document.createElement('style');
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
			return () => el.remove();
		}

		function apply(ctx) {
			const service = new Workbenches(ctx);
			service.View = makeView(service);
			ctx.effect(maintainStyles, 'vssaros-workbenches: styles');
			ctx.effect(() => ctx.reflect.provide('desktopWorkbenches', service), 'vssaros-workbenches: service');
			ctx.effect(() => { void service.load(); return undefined; }, 'vssaros-workbenches: state');
			// 探针钩子（只读快照；不暴露可写方法）
			globalThis.__vssarosWorkbenchesSnapshot = () => service.getSnapshot();
			return undefined;
		}

		module.exports.apply = apply;
		module.exports.inject = ['slots', 'layout'];
		module.exports.identityOf = identityOf;
		module.exports.normalize = normalize;
		return module.exports;
	},
});
