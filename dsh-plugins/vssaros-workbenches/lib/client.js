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
globalThis.__vssarosWorkbenchBuild = '0.2.39';
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-workbenches',
	factory: (require) => {
		var module = { exports: {} };
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;

		const STATE_URL = '/api/vssaros-workbenches/state';
		/** 服务端现签的「带 token 深链」；外开必须用它（另一个浏览器没有当前 Cookie）。 */
		const LINK_PATH_PREFIX = '/api/vssaros-workbenches/link';
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
			/** 自愈：清掉指向**已失效会话**的绑定/最近会话（否则每次打开工作台都卡在同一条死会话上）。 */
				clearStaleBinding(owner, sessionId) {
				if (!owner || !sessionId) { return; }
				try {
					Promise.resolve(this.commit((state) => {
						if (state.recentSessions && state.recentSessions[owner] === sessionId) { state.recentSessions[owner] = null; }
						if (state.sessionBindings && state.sessionBindings[sessionId] === owner) { delete state.sessionBindings[sessionId]; }
					})).catch(() => { /* 忽略 */ });
				} catch { /* 忽略 */ }
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
				// ⚠ 2026-10-28：这里**不做** sessionExists 前置 —— 新建会话在这一刻往往还没进
				//   sessions.list 快照，前置检查会把它误判成"已不存在"⇒「＋ 新建会话」没反应。
				//   真失效的会话交给停靠区的 retain 判定（失败 ⇒ markDead + 清绑定 ⇒ 回到「开始对话」）。
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

			el.addEventListener('pointerdown', (ev) => {
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

			el.addEventListener('contextmenu', (ev) => {
				ev.preventDefault();
				applyActionsPos(el, null);
				try { localStorage.removeItem(ACTIONS_POS_KEY); } catch (e) { /* ignore */ }
			});

			window.addEventListener('pointermove', (ev) => {
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
			window.addEventListener('pointerup', finish, true);
			window.addEventListener('pointercancel', finish, true);

			// 恢复上次位置（并夹一次，防止窗口变小后越界）
			try {
				const saved = JSON.parse(localStorage.getItem(ACTIONS_POS_KEY) || 'null');
				if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
					applyActionsPos(el, clampActions(el, frameEl, saved));
				}
			} catch (e) { /* ignore */ }
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

			attachActionsDrag(el, frameEl);

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
		}

		/** 工作台 id → 它的 AI 助手 preset（页面形态下兜底开助手会话用）。 */
		const ASSIST_PRESET_BY_WB = {
			'vssaros/studio': 'vssaros-saroasis-studio',
			'vssaros/marketplace': 'vssaros-marketplace-bot',
			'vssaros/media': 'vssaros-media-librarian',
			// ★ 2026-10-28（用户：「知识库的展开 AI 助手点不动，展开后应显示知识库专家」）：
			//   知识库是**页面型**工作台（面板里没有对话列）⇒ 点击只能走外壳兜底开会话；
			//   而兜底要带 preset —— 之前没这一条，传空串 ⇒ `newChat('')` 等于空转 ⇒「点了没反应」。
			//   `knowledge-base-expert` 是内置 agent（名称「知识库专家」）⇒ preset = vssaros- + id。
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

		function assistantPresetOf(workbenchId) {
			return ASSIST_PRESET_BY_WB[String(workbenchId || '')] || '';
		}
		function Frame({ service, entry }) {
			useService(service);
			const props = { service, entry };
			if (entry.customFrame) { props.active = service.active === entry.id; props.conversation = h(ConversationMount, { service, entry }); }
			// ★ 外开链接**不再挂载时预取**：token 属于当前进程，宿主一重启旧链接就 401。
			//   改为每次点击现取（`openWorkbenchInBrowser` 里同步开窗 + 异步导航）。
			return h(HeaderHost, { entry },
				// ★ S2 一体条：AI 助手展开 + 外开 合成一条竖直胶囊，整组可拖。
				//   外壳只渲染一次 ⇒ 所有工作台自动都有；「«」的显隐跟随工作台的助手收起态。
				h('div', {
					className: 'vssWbActions',
					'data-vssaros-wb-actions': entry.id,
					'data-assist': 'none',
					ref: (el) => {
						if (!el) { return; }
						mountActions(el, el.closest('.vssWbFrame') || el.parentElement);
					},
				},
					h('div', { className: 'wbWrap wbWrapAssist' },
						h('button', {
							type: 'button',
							className: 'wbAct wbActAssist',
							'data-vssaros-wb-assist': entry.id,
							title: '展开 AI 助手',
							onClick: (ev) => {
								ev.preventDefault();
								ev.stopPropagation();
								const frameEl = ev.currentTarget.closest('.vssWbFrame');
								if (!frameEl) { return; }
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
										try {
											const host = frameEl.querySelector('[data-vssaros-assist-collapsed]');
											const cur = host && host.getAttribute('data-vssaros-assist-collapsed');
											if (cur === '0' || frameEl.querySelector('[data-vssaros-assist-collapsed="0"]')) { return; }
										} catch (e) { /* 读不到就按未处理走兜底 */ }
										const preset = assistantPresetOf(entry.id);
										let opened = false;
										try {
											const ws = service && service.ctx && service.ctx.uiWorkspace;
											if (ws && typeof ws.startSession === 'function') {
												ws.startSession(undefined, preset ? { agentPreset: preset } : undefined);
												opened = true;
											}
										} catch (e) { opened = false; }
										if (!opened) {
											const bridge = window.vssarosDsh;
											if (bridge && typeof bridge.newChat === 'function' && preset) {
												try { bridge.newChat(preset); } catch (e) { /* 忽略 */ }
											}
										}
									}, 200);
								}
							},
						}, '«'),
						// S4：hover 时在左侧滑出文字（面板右边缘 ⇒ 左侧才有空间）
						h('span', { className: 'wbLabel' }, '展开 AI 助手'),
					),
					h('div', { className: 'wbDivider' }),
					h('div', { className: 'wbWrap wbWrapOpen' },
						h('button', {
							type: 'button',
							className: 'wbAct wbActOpen',
							'data-vssaros-wb-open-external': entry.id,
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
				),
				h(PanelBoundary, { entry }, h(entry.Component, props)));
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
						// 自愈：清掉指向这条失效会话的绑定 ⇒ 下次打开工作台不再卡在它上面
						service.clearStaleBinding(service.active, sessionId);
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
.vssWbFailure { margin:48px auto; max-width:520px; padding:24px; border-radius:12px; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.vssWbFailure h2 { margin:0 0 8px; font-size:16px; }
.vssWbFailure p { margin:0 0 12px; opacity:.8; font-size:13px; line-height:1.6; }
.vssWbFailure pre { margin:0 0 12px; padding:8px; font-size:12px; white-space:pre-wrap; word-break:break-all; background:rgba(127,127,127,.12); border-radius:6px; }
.vssWbFailure button { padding:6px 14px; border-radius:999px; cursor:pointer; }
.vssWbConversation { display:flex; flex-direction:column; gap:10px; padding:16px; border:1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius:10px; font-size:13px; }
.vssWbConversation p { margin:0; opacity:.85; }
.vssWbConversationActions { display:flex; gap:8px; flex-wrap:wrap; }
.vssWbConversationActions button { padding:6px 14px; border-radius:999px; cursor:pointer; border:1px solid var(--dsw-alias-border-l2, #3e3e3e); background: var(--dsw-alias-bg-layer-1, #262626); color: inherit; font: inherit; }
.vssWbConversationError { color: var(--dsw-alias-state-error-primary, #e5484d); }
.vssWbDockHost { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; height:100%; }
.vssWbDockHost > .vssWbConversation { margin:16px; }
.vssWbDock { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; }
.vssWbDock[hidden] { display:none; }
/* ★ 2026-10-26「S2 一体条」：AI 助手展开 + 外开 合成一条竖直胶囊，整组可拖（所有工作台共用一份） */
/* ★ 2026-10-27：与媒体库的浮动区**完全同一套样式**（A 方案 + 边缘高亮）
.   —— vssaros-media 的 .m-fab 与这条 .vssWbActions 的高亮参数必须逐字一致（由
.   dsh-plugins/check-assistant-collapse.mjs 的跨插件一致性断言钉住）✓ */
.vssWbActions { position:absolute; right:12px; top:50%; transform:translateY(-50%); z-index:2147482000; display:flex; flex-direction:column; padding:3px; border-radius:10px; border:1px solid rgba(47,129,247,.55); background:linear-gradient(180deg, rgba(38,38,44,.96), rgba(30,30,35,.96)); box-shadow:0 0 0 1px rgba(47,129,247,.16), 0 0 16px rgba(47,129,247,.30), 0 4px 12px rgba(0,0,0,.45); opacity:.96; cursor:grab; touch-action:none; user-select:none; transition:box-shadow .16s, border-color .16s; }
.vssWbActions:hover { border-color:rgba(47,129,247,.85); box-shadow:0 0 0 1px rgba(47,129,247,.35), 0 0 26px rgba(47,129,247,.45), 0 6px 18px rgba(0,0,0,.5); }
.vssWbActions[data-dragging] { cursor:grabbing; }
.vssWbActions[data-moved] { transform:none; }
.vssWbActions .wbWrap { position:relative; display:flex; }
.vssWbActions .wbAct { width:26px; height:25px; padding:0; display:inline-flex; align-items:center; justify-content:center; border:0; border-radius:7px; background:transparent; color:var(--dsw-alias-label-secondary, #9d9da7); font:13px/1 -apple-system, Segoe UI, sans-serif; cursor:pointer; transition:color .14s, background .14s, box-shadow .14s; }
.vssWbActions .wbAct:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); color:var(--dsw-alias-label-primary, #e6e6ea); }
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
						if (Date.now() - navIntentAt < 2500) {
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
