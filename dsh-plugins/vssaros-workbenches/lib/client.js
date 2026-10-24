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
		const ReactDOM = require('react-dom');
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
				/** 会话停靠（整页工作台）：页面里的停靠点 / 本次指定的停靠会话 / 打不开的会话。 */
				this.docks = [];
				this.docked = new Map();
				this.dead = new Set();
				this.dockError = null;
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
				if (!id || !this.providers.has(id)) { throw new Error('请先打开可用的工作台。'); }
				return id;
			}
			isActive() { return this.active !== null && this.providers.has(this.active); }
			/** 这个工作台的对话停靠在自己页面里（整页工作台）。 */
			docksConversation(id) {
				const entry = id ? this.providers.get(id) : null;
				return !!(entry && entry.customFrame);
			}
			/** 工作台停靠显示的会话：本次会话里指定的 ⇒ 否则持久化的最近会话；必须归属它、且没被判死。 */
			dockedSessionOf(id) {
				if (!id || !this.state) { return null; }
				const sid = this.docked.get(id) || this.state.recentSessions[id] || null;
				if (!sid || this.dead.has(sid) || this.state.sessionBindings[sid] !== id) { return null; }
				return sid;
			}
			/** 工作台页面里的停靠点（`conversation` 节点挂载时登记；后登记的优先）。返回注销函数。 */
			registerDock(id, element) {
				const record = { id, element };
				this.docks.push(record);
				this.publish();
				return () => {
					const i = this.docks.indexOf(record);
					if (i >= 0) { this.docks.splice(i, 1); this.publish(); }
				};
			}
			/** 覆盖层该往哪儿渲染对话：前台工作台的最新停靠点 + 它的停靠会话（任一缺失 ⇒ null）。 */
			dockTarget() {
				const id = this.active;
				if (!id || !this.docksConversation(id)) { return null; }
				const dock = [...this.docks].reverse().find(d => d.id === id);
				const sessionId = this.dockedSessionOf(id);
				return dock && sessionId ? { id, element: dock.element, sessionId } : null;
			}
			/** 停靠会话打不开（已删除 / 归档 / 加载失败）⇒ 本次运行不再尝试，页面回到"开始对话"。 */
			markDead(sessionId, error) {
				if (!sessionId || this.dead.has(sessionId)) { return; }
				this.dead.add(sessionId);
				this.dockError = String(error && error.message || error || '对话打不开');
				console.warn('[vssaros-workbenches] 停靠会话打不开：' + sessionId, error);
				this.publish();
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
			/** 默认工作区：最近一次绑给本工作台的会话所在工作区 ⇒ 否则第一个工作区。 */
			defaultWorkspace() {
				let items = [];
				try { items = this.ctx.workspaces.list.getSnapshot().items || []; } catch { items = []; }
				const id = this.active;
				const recent = id && this.state ? this.state.recentSessions[id] : null;
				const hit = recent ? items.find(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(recent)) : null;
				return hit || items[0] || null;
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
			 *   · 前台不是整页工作台（标准分栏）⇒ 保持旧行为（切原生对话）
			 */
			showSession(sessionId) {
				const id = this.active;
				if (this.docksConversation(id) && this.state) {
					const owner = this.state.sessionBindings[sessionId];
					if (owner === id) { this.dockTo(id, sessionId); return; }
					if (!owner) {
						// 自动绑定：抢不到（并发下被别人先绑）⇒ 报错但**不**跳出
						Promise.resolve(this.bindSession(id, sessionId))
							.then(() => this.dockTo(id, sessionId))
							.catch((e) => { this.dockError = String((e && e.message) || e || '会话绑定失败'); this.publish(); });
						return;
					}
					this.dockError = '这个会话属于另一个工作台（' + owner + '），不能在这里显示。';
					this.publish();
					return;
				}
				this.ctx.uiWorkspace.openSession(sessionId);
				try { this.ctx.layout.selectPanel(null); } catch { /* 布局服务已卸载 */ }
			}
			async bindSession(owner, sessionId) {
				await this.commit(state => {
					const prev = state.sessionBindings[sessionId];
					if (prev && prev !== owner) { throw new Error('此会话已属于另一个工作台，不能重新绑定。'); }
					if (!state.added.includes(owner)) { state.added.push(owner); }
					state.sessionBindings[sessionId] = owner;
					state.recentSessions[owner] = sessionId;
				});
			}
			/** 在工作区里新建一条归属本工作台的会话，并切到对话。 */
			async newSession(workspaceId) {
				const owner = this.ownerId();
				const workspace = workspaceId || (this.defaultWorkspace() && this.defaultWorkspace().workspaceId);
				if (!workspace) { return this.newWorkspaceSession(); }
				const sessionId = await this.ctx.sessions.create({ workspaceId: workspace });
				await this.bindSession(owner, sessionId);
				this.showSession(sessionId);
				return sessionId;
			}
			/** 让用户选一个文件夹 ⇒ 建工作区 ⇒ 新会话（用户取消 ⇒ undefined）。 */
			async newWorkspaceSession() {
				this.ownerId();
				const path = await this.ctx.uiWorkspace.pickDirectory();
				if (!path) { return undefined; }
				const workspace = await this.ctx.workspaces.create({ path });
				return this.newSession(workspace.workspaceId);
			}
			/**
			 * 确保有一条归属本工作台的会话（官方 1167-1208）：给了已存在的 sessionId ⇒ 校验归属后复用；
			 * 否则按业务文件夹建工作区 + 新会话。`folder` 必填（官方同样拒绝静默选目录）。
			 */
			async ensureSession({ folder, sessionId: saved } = {}) {
				const owner = this.ownerId();
				let byId = {};
				try { if (typeof this.ctx.sessions.refresh === 'function') { await this.ctx.sessions.refresh(); } byId = this.ctx.sessions.list.getSnapshot().byId || {}; } catch { byId = {}; }
				if (saved && byId[saved]) {
					const prev = this.state && this.state.sessionBindings[saved];
					if (prev && prev !== owner) { throw new Error('此会话已属于另一个工作台，不能重新绑定。'); }
					await this.bindSession(owner, saved);
					this.showSession(saved);
					return saved;
				}
				if (typeof folder !== 'string' || !folder.trim()) { throw new Error('创建会话需要业务项目文件夹。'); }
				const workspace = await this.ctx.workspaces.create({ path: folder });
				return this.newSession(workspace.workspaceId);
			}
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
		function ConversationMount({ service, entry }) {
			useService(service);
			const [element, setElement] = React.useState(null);
			React.useEffect(() => (element ? service.registerDock(entry.id, element) : undefined), [element, entry.id]);
			const docked = service.dockedSessionOf(entry.id);
			return h('div', { className: 'vssWbDockHost', 'data-vssaros-wb-conversation': entry.id },
				docked ? null : h(ConversationStart, { service }),
				h('div', { ref: setElement, className: 'vssWbDock', 'data-vssaros-wb-dock': entry.id, hidden: !docked }));
		}
		/** 停靠点里的"开始对话"（默认工作区新建；没有工作区 ⇒ 让用户选文件夹）。 */
		function ConversationStart({ service }) {
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState('');
			const run = (fn) => { setBusy(true); setError(''); Promise.resolve().then(fn).catch(e => setError(String(e && e.message || e))).finally(() => setBusy(false)); };
			const lastError = service.dockError;
			return h('div', { className: 'vssWbConversation', 'data-vssaros-wb-conversation-start': '' },
				h('p', null, '需要 AI 协助时，开始一段对话；会话会关联到这个工作台，并显示在这里。'),
				lastError ? h('p', { className: 'vssWbConversationError', role: 'alert' }, '上一段对话打不开：' + lastError) : null,
				h('div', { className: 'vssWbConversationActions' },
					h('button', { type: 'button', disabled: busy, onClick: () => run(() => service.newSession()) }, busy ? '正在打开…' : '开始对话'),
					h('button', { type: 'button', disabled: busy, onClick: () => run(() => service.newWorkspaceSession()) }, '选择文件夹…')),
				error ? h('p', { className: 'vssWbConversationError', role: 'alert' }, error) : null);
		}
		function Frame({ service, entry }) {
			useService(service);
			const props = { service, entry };
			if (entry.customFrame) { props.active = service.active === entry.id; props.conversation = h(ConversationMount, { service, entry }); }
			return h(HeaderHost, { entry }, h(PanelBoundary, { entry }, h(entry.Component, props)));
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
					try {
						ref = service.ctx.sessions.retain(sessionId, { source: 'workbench' });
					} catch (error) {
						service.markDead(sessionId, error);
						return undefined;
					}
					setReference({ sessionId, ref });
					if (ref && ref.ready && typeof ref.ready.then === 'function') {
						ref.ready.then(undefined, error => service.markDead(sessionId, error));
					}
					return () => { setReference(null); try { ref.release(); } catch { /* 已释放 */ } };
				}, [sessionId]);
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
.vssWbConversation { display:flex; flex-direction:column; gap:10px; padding:16px; border:1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius:10px; font-size:13px; }
.vssWbConversation p { margin:0; opacity:.85; }
.vssWbConversationActions { display:flex; gap:8px; flex-wrap:wrap; }
.vssWbConversationActions button { padding:6px 14px; border-radius:999px; cursor:pointer; border:1px solid var(--dsw-alias-border-l2, #3e3e3e); background: var(--dsw-alias-bg-layer-1, #262626); color: inherit; font: inherit; }
.vssWbConversationError { color: var(--dsw-alias-state-danger-primary, #e5484d); }
.vssWbDockHost { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; height:100%; }
.vssWbDockHost > .vssWbConversation { margin:16px; }
.vssWbDock { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; }
.vssWbDock[hidden] { display:none; }
.vssWbDockedConversation { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; height:100%; }
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
			return undefined;
		}

		module.exports.apply = apply;
		module.exports.inject = ['slots', 'layout', 'sessions', 'workspaces', 'uiWorkspace'];
		module.exports.identityOf = identityOf;
		module.exports.normalize = normalize;
		module.exports.__Frame = Frame;
		return module.exports;
	},
});
