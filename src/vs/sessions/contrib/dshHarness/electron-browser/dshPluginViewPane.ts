/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件页面（`surface=plugin-page`）在 ActivityBar 视图里的承载（方案 6.3 的 page 形态，9.1 的
 * `dshPluginViewPane.ts`）。
 *
 * 与聊天框宿主（`dshChatInstanceHost.ts`）同口径：VsSaros 侧只摆放一个 WebContentsView，
 * 页面本身由插件在自己的 Host 前缀路由上服务（`/x/<module>/`），走同一 partition 的 Cookie 认证。
 * 差别是该宿主是标准 `ViewPane`：矩形来自自身 body（`layoutBody`），可见性同时看
 * `isBodyVisible()` 与占位元素矩形（sessions 侧栏折叠不走 `setVisible`，必须用矩形兜底）。
 *
 * 视图 id 稳定为 `dsh-plugin-w<windowId>-<containerId>`：容器重开后复用同一视图，不重载页面。
 * 路由是 SyncDescriptor 的静态参数（`MODULE_VIEW_HOSTS` 注入），默认值见 13.3 的
 * `view.kind=page` 约定；插件清单的 `view.route` 接上后以清单为准。
 *
 * 注意时序：`ViewPane` 可能在 `super()` 期间就回调 `renderBody`（此时子类字段尚未初始化），
 * 所以 DOM 只在 `renderBody` 里建、服务只在构造末尾或 `renderBody` 之后用 `_wired` 判定接线，
 * 两边各调一次 `_onReadyIfWired()`，用 `_started` 保证只跑一次。
 */

import { getZoomFactor, onDidChangeZoomLevel } from '../../../../base/browser/browser.js';
import { $, append, getWindow } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { localize } from '../../../../nls.js';
import { BrowserOverlayManager } from '../../../../workbench/contrib/browserView/electron-browser/overlayManager.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { DshHarnessSettings } from '../common/dshHarness.js';
import { IDshModulePageState } from '../common/dshModuleContainers.js';
import { IDshHarnessService } from './dshHarnessService.js';
import { DshOverlayFreeze, dshViewPlaceholderCssText } from './dshOverlayFreeze.js';
import { DshStatusBox } from './dshStatusBox.js';

/** 编辑器服务会拦截 HTMLElement.focus；直接调用原型方法，避免焦点被转回工作台。 */
const originalHtmlElementFocus = HTMLElement.prototype.focus;

export class DshPluginViewPane extends ViewPane {

	/** 占位元素（renderBody 创建；因可能先于字段初始化执行，这里不能用带初值的字段）。 */
	private _root!: HTMLElement;
	private _statusBox!: HTMLElement;
	private _status!: DshStatusBox;
	private _overlayManager!: BrowserOverlayManager;

	/** 构造末尾置 true；`renderBody` 早于它执行时由构造末尾补接线。 */
	private _wired = false;
	private _started = false;
	private _starting = false;

	private _viewId: string | undefined;
	/** 容器页路由（**懒解析**：首次可见时按已激活模块要一次，见 `IDshHarnessService.resolveModulePage`）。 */
	private _route: string | undefined;
	private _pageResolving = false;
	/** 有值时 = 该容器当前没有可加载的页面（状态框显示这段说明，且**不拉 Host**）。 */
	private _noPageNote: HTMLElement | undefined;
	private _rectZero = true;
	/** 上一次真正发给主进程的矩形（取整后）：完全相同就**不再发 IPC**（打断布局回授环）。 */
	private _lastLaidOutRect: { x: number; y: number; width: number; height: number } | undefined;
	/** 同一帧内的 ResizeObserver 回调合并标志（见 ResizeObserver 注册处）。 */
	private _layoutQueued = false;
	private _overlayVisible = false;
	private _viewShown = false;
	/** 「以为显示了」是否已由**主进程的实际状态**背书（见 `_verifyMainVisible`；与聊天宿主同口径）。 */
	private _viewShownConfirmed = false;
	/** `_verifyMainVisible` 去重 + 节流（主进程一时修不好别打转）。 */
	private _verifyingMainVisible = false;
	private _lastVerifyAt = 0;
	/** 上一次"确认它在显示"的时刻（ms）；超过 5s 视为过期 ⇒ 靠心跳重新对账。 */
	private _viewShownConfirmedAt = 0;
	/** 已显示时的心跳：每 5s 与主进程对一次账（主进程被**静默**隐藏时浏览器侧收不到事件）。 */
	private _shownRecheck: ReturnType<typeof setInterval> | undefined;
	/** 隐藏自愈定时器：应显示却隐藏时每秒重算（事件漏网的兜底，与聊天宿主同口径）。 */
	private _hiddenRecheck: ReturnType<typeof setInterval> | undefined;
	/**
	 * 上一次看到的 Host 状态（判"重启跃迁"用）。
	 * 插件页连着具体的 Host 进程（端口 + 令牌）：Host 重启后旧页面必失效，而视图是复用的
	 * ⇒ 不 reload 就一直停在错误页/空白（用户两次报「sideview 不可见」的该类根因）。
	 */
	private _lastHostState: string | undefined;

	/**
	 * 浮层让位时的**冻结帧**（让位前抓一帧贴到占位上，避免那一块变空白/黑）。
	 *
	 * 缘由与口径见 `dshOverlayFreeze.ts` 的文件头（2026-10-15 用户报：hover 活动栏 workspace 图标 ⇒
	 * sideview 内容消失）。**不能**在 renderBody 里建：`ViewPane` 可能在 `super()` 期间就回调
	 * renderBody（那时 `this._dsh` 还没赋值）⇒ 在 `_onReadyIfWired()` 里建 ✓。
	 */
	private _freeze!: DshOverlayFreeze;

	constructor(
		/** 容器 id（SyncDescriptor 静态参数）：决定视图 id、诊断标识，也用来解析**该加载哪一页**。 */
		private readonly _containerId: string,
		options: IViewPaneOptions,
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		// 本类不自己持有：配置读取走基类的 `protected configurationService`（与其它 Pane 同口径）。
		@IConfigurationService configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly _commands: ICommandService,
		@ILogService private readonly _log: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._status = new DshStatusBox(this._dsh, this._commands, this._log);
		this._wired = true;
		this._onReadyIfWired();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.style.position = 'relative';
		this._root = append(container, $('.dsh-plugin-view'));
		this._root.tabIndex = 0;
		// 底色 = 侧栏主题底色：原生视图藏起来时（浮层让位）露的就是这一层 ——
		// 不给底色就是**全黑**（`.part.sidebar` 自身也是 transparent ✗）。抓帧失败/来不及时的兜底也靠它 ✓。
		this._root.style.cssText = dshViewPlaceholderCssText('var(--vscode-sideBar-background)');
		this._statusBox = append(container, $('.dsh-plugin-view-status'));
		this._statusBox.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:var(--vscode-descriptionForeground);background:var(--vscode-sideBar-background);';
		this._onReadyIfWired();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._checkOverlays();
		this._layoutView();
	}

	override focus(): void {
		super.focus();
		if (this._viewId && this._dsh.status.state === 'running') {
			originalHtmlElementFocus.call(this._root);
			void this._dsh.setViewVisible(this._viewId, this._shouldShow, true);
		}
	}

	override dispose(): void {
		this._stopHiddenRecheck();
		this._stopShownRecheck();
		if (this._viewId) {
			void this._dsh.disposeView(this._viewId).catch(() => undefined);
			this._viewId = undefined;
			this._lastLaidOutRect = undefined;
		}
		super.dispose();
	}

	// ─── 接线（renderBody 与构造末尾各调一次，只生效一次）───────────────────────

	private _onReadyIfWired(): void {
		if (!this._wired || this._started || !this._root) {
			return;
		}
		this._started = true;
		this._overlayManager = this._register(new BrowserOverlayManager(getWindow(this._root)));
		// 冻结帧：判据与"因浮层让位而隐藏"同源（已恢复显示 / 已不在遮挡 ⇒ 在途那帧作废 ✓）
		this._freeze = new DshOverlayFreeze(this._root, this._dsh, () => !this._overlayVisible || this._viewShown,
			line => this._log.warn(`[dshHarness] ${line}`));
		this._register(this._overlayManager.onDidChangeOverlayState(() => this._checkOverlays()));
		this._register(this.onDidChangeBodyVisibility(() => this._updateVisibility()));
		this._register(onDidChangeZoomLevel(id => {
			if (id === getWindow(this._root).vscodeWindowId) {
				this._layoutView();
			}
		}));
		const win = getWindow(this._root);
		// ⚠ 2026-10-13（用户："切换到其他 activitybar 页签，再切回主页，sideview 显示异常" ——
		//   表现为内容整体**右移**、右侧被**裁掉** ✓）：尺寸变化时**必须同时重算原生视图的 bounds** ✗。
		//   原因链：侧栏切换带**过渡动画** ⇒ `_updateVisibility()` 在"显示意图翻转"那一刻量到的
		//   `getBoundingClientRect()` 是**动画中途**的（偏右、偏宽 ✗）⇒ `_layoutView()` 就按它摆位；
		//   而动画后续的尺寸变化只走 `_updateVisibility()`，那个分支在 `show === this._viewShown` 时
		//   **直接 early-return**（只对账可见性、**不重算矩形** ✗）⇒ 错矩形**永远不会被纠正** ✓✓。
		//   ResizeObserver 在动画期间与结束时都会回调 ⇒ 这里补一次 `_layoutView()` 收敛到最终矩形 ✓
		//   （`_layoutView` 自带"矩形为 0 时按 rAF 重试"的兜底 ✓，所以过渡态不会把视图摆到 0x0 ✗）。
		const resizeObserver = new win.ResizeObserver(() => {
			this._updateVisibility();
			// ★ 2026-10-27：同一帧内的多次回调**合并成一次** `_layoutView`。
			//   过渡动画/拖动分隔条时回调会密集触发，每次都跨进程改 bounds 会把主线程拖住
			//   （与 `_layoutView` 内的"矩形未变就不发 IPC"一起构成两道闸）。
			if (this._layoutQueued) {
				return;
			}
			this._layoutQueued = true;
			win.requestAnimationFrame(() => {
				this._layoutQueued = false;
				this._layoutView();
			});
		});
		resizeObserver.observe(this._root);
		this._register(toDisposable(() => resizeObserver.disconnect()));
		this._register(this._dsh.onDidPageEvent(e => {
			if (e.viewId !== this._viewId) {
				return;
			}
			if (e.kind === 'keydown') {
				// 页面未处理的快捷键交给工作台（与聊天宿主、上游 browserView 同做法）。
				try {
					this.keybindingService.dispatchEvent(new StandardKeyboardEvent(new KeyboardEvent('keydown', e.event)), this._root);
				} catch (err) {
					this._log.error('[dshHarness] plugin page key dispatch failed', err);
				}
			} else if (e.kind === 'focus') {
				originalHtmlElementFocus.call(this._root);
			}
		}));
		this._register(this._dsh.onDidChangeStatus(s => {
			const prev = this._lastHostState;
			this._lastHostState = s.state;
			// ★ 2026-10-19（用户两次报「sideview 不可见 / 聊天框里没有 agent 信息」的真因之一）：
			//   插件页是**同源页面**，它连着的是一个具体的 Host 进程（端口 + 安装令牌）。Host 重启后
			//   旧页面的连接/令牌全失效 ⇒ 页面停在上一轮的错误页（400/401、或一直白着），
			//   而 pane 复用同一视图（`dsh-plugin-w…`），**不重载就一直白**。用户只能重开面板。
			//   ⇒ Host 从"非 running"转回 "running" 时**自动 reload 一次**。
			//   安全性：插件页是纯前端 + 同源 API，重载不会丢服务端状态（页面自己的 selection 之类
			//   由插件从 URL/存储里恢复）；且只在状态跃迁时发生一次，不是轮询。
			if (prev !== undefined && prev !== 'running' && s.state === 'running' && this._viewId) {
				const viewId = this._viewId;
				this._log.info(`[dshHarness] host running again → reload plugin view ${viewId}`);
				void this._dsh.reloadView(viewId).then(() => {
					this._layoutView();
					this._updateVisibility();
				}).catch(err => {
					this._log.warn(`[dshHarness] reload plugin view ${viewId} failed: ${String((err as Error)?.message ?? err)}`);
				});
			}
			// "没有页面"时状态框归 `_renderNoPage()` 所有：别让 Host 状态把它盖掉（那正是用户唯一的线索）
			if (!this._noPageNote) {
				this._status.render(this._statusBox, s);
			}
			this._updateVisibility();
		}));
		this._status.render(this._statusBox, this._dsh.status);
		this._updateVisibility();
	}

	/**
	 * 这个 pane **能不能**承载页面（可见 + 矩形非零 + 无浮层 + Host 就绪）。
	 *
	 * ⚠ 与 {@link _shouldShow} 分开是必须的：创建视图的分支原先拿 `_shouldShow` 把关，而它又要求
	 * `!!this._viewId` ⇒ **`_viewId` 为空时创建分支永远进不去**（视图永远不会被建 ⇒ `viewId` 永远是
	 * `null`，页面永远停在"正在加载页面…"）。这是"附加"页面断言从来没通过的真因（README 4.81）。
	 */
	private get _canHostPage(): boolean {
		return this.isBodyVisible() && !this._overlayVisible && !this._rectZero
			&& this._dsh.status.state === 'running';
	}

	/** 视图**应当显示**：先"能承载"，再要求视图已建好。 */
	private get _shouldShow(): boolean {
		return this._canHostPage && !!this._viewId;
	}

	private get _windowId(): number {
		return getWindow(this._root).vscodeWindowId;
	}

	/** 页面视图在 VsSaros 侧的稳定 id（容器级：同容器重开复用同一视图）。 */
	private get _viewIdForContainer(): string {
		return `dsh-plugin-w${this._windowId}-${this._containerId}`;
	}

	/**
	 * 要一次"这个容器该加载哪一页"。
	 *
	 * 每次面板可见都可能面临**新的插件组合**（先装 mcp、后装 skills 都算数），所以不缓存结论：
	 * 没解析出页面就一直保持"可重试"，解析出页面就定下来。失败只记日志、下次可见再试。
	 */
	private _resolvePage(): void {
		if (this._route || this._pageResolving || this._noPageNote) {
			return;
		}
		this._pageResolving = true;
		void this._dsh.resolveModulePage(this._containerId).then(state => {
			this._pageResolving = false;
			if (state?.page) {
				this._route = state.page.route;
				this._log.info(`[dshHarness] plugin page ${this._containerId} → ${state.page.route}（${state.page.module} / ${state.page.kind}）`);
				this._updateVisibility();
				return;
			}
			this._renderNoPage(state);
		}, e => {
			this._pageResolving = false;
			this._log.warn(`[dshHarness] 解析容器页面失败（下次可见时重试）：${String((e as Error)?.message ?? e)}`);
		});
	}

	/**
	 * 容器里**没有可显示的页面**时：如实说明"这一页由谁提供、现在什么状态"，而不是让用户对着 404 猜。
	 * 这是共容器最容易踩的坑（只装了同容器里的另一个模块时，声明的那条路由属于没装的插件）。
	 */
	private _renderNoPage(state: IDshModulePageState | undefined): void {
		if (!this._statusBox) {
			return;
		}
		this._statusBox.textContent = '';
		const title = append(this._statusBox, $('div'));
		title.textContent = localize('dshHarness.page.none', "这个面板当前没有页面");
		const detail = append(this._statusBox, $('div'));
		detail.style.cssText = 'max-width:420px;line-height:1.5;';
		const modules = state?.modules ?? [];
		detail.textContent = modules.length
			? localize('dshHarness.page.noneDetail',
				"它由多个模块共用：{0}。都没有提供页面（未安装 / 已停用）。装上其中任一个后重开本面板即可。",
				modules.map(m => `${m.module}${m.active ? '（已激活，无页面）' : '（未安装或已停用）'}${m.route ? ` → ${m.route}` : ''}`).join('、'))
			: localize('dshHarness.page.noneUnknown', "无法确定这个容器由哪些模块提供（聚合表里没有它）。");
		this._noPageNote = detail;
		this._statusBox.style.display = 'flex';
	}

	/**
	 * 懒启动：视图首次在场时才拉起 Host（方案 6.4"点击时再懒启动"）。
	 * 总开关关掉时不起任何进程，只显示状态框。
	 */
	private _ensureStarted(): void {
		if (this._starting || this._dsh.status.state === 'running') {
			return;
		}
		if (this.configurationService.getValue<boolean>(DshHarnessSettings.Enabled) === false) {
			return;
		}
		if (!this._route) {
			// 没有页面就别拉 Host：进程不该为一个不存在的页面起来（说明由 `_renderNoPage()` 给）
			return;
		}
		this._starting = true;
		this._log.info(`[dshHarness] plugin page ${this._containerId} → ${this._route}`);
		void this._dsh.ensureStarted()
			.catch(e => this._log.error('[dshHarness] plugin page: start failed', e))
			.finally(() => this._starting = false);
	}

	/**
	 * 把原生视图摆到 `_root` 的矩形上。
	 *
	 * ★ 2026-10-27（用户报：切到 agents 侧栏就卡死）：
	 *   ResizeObserver 每帧回调 → `layoutView`（跨进程 IPC）→ 主进程改视图 bounds
	 *   → 侧栏 splitview 重新布局 → 观察器再次回调 … 只要两侧对"最终尺寸"有一点不一致，
	 *   就会形成**布局回授环**，表现为主窗口 `detected unresponsive`。
	 *   两道闸：
	 *     ① 幂等：矩形与上次**完全相同**就不发 IPC（消除"无变化的重排"）；
	 *     ② 合并：同一帧内的多次回调只发一次（rAF 收敛），避免抖动放大。
	 */
	private _layoutView(retries = 2): void {
		if (!this._viewId) {
			return;
		}
		const win = getWindow(this._root);
		const rect = this._root.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			if (retries > 0 && this.isBodyVisible()) {
				win.requestAnimationFrame(() => this._layoutView(retries - 1));
			}
			return;
		}
		const next = {
			x: Math.round(rect.left),
			y: Math.round(rect.top),
			width: Math.round(rect.width),
			height: Math.round(rect.height),
		};
		const prev = this._lastLaidOutRect;
		if (prev && prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height) {
			return;   // ① 尺寸没变：不发 IPC（这是打断回授环的关键一步）
		}
		this._lastLaidOutRect = next;
		void this._dsh.layoutView(this._viewId, {
			windowId: this._windowId,
			...next,
			zoomFactor: getZoomFactor(win),
		});
	}

	/** 命令面板等浮层压住侧栏时临时隐藏原生视图（遮挡标志无条件重算，事件只做快速响应）。 */
	private _checkOverlays(): void {
		if (!this._overlayManager) {
			return;
		}
		const overlapping = this._overlayManager.getOverlappingOverlays(this._root).length > 0;
		if (overlapping !== this._overlayVisible) {
			this._overlayVisible = overlapping;
			this._updateVisibility();
		}
	}

	private _updateVisibility(): void {
		if (!this._started) {
			return;
		}
		const rect = this._root.getBoundingClientRect();
		this._rectZero = rect.width === 0 || rect.height === 0;
		this._overlayVisible = this._overlayManager.getOverlappingOverlays(this._root).length > 0;
		const running = this._dsh.status.state === 'running';
		// 路由懒解析（按**已激活**模块现算）：没解析出来就什么也不做（避免按容器声明的第一个模块 404）
		this._resolvePage();
		// 懒启动（方案 6.4"点击时再懒启动"）：页面真的在屏幕上（矩形非零）时才拉起 Host，
		// 只登记图标不拉进程。
		if (!running && !this._rectZero) {
			this._ensureStarted();
		}
		// ⚠ 这里用 `_canHostPage`（**不含** `_viewId`）——用 `_shouldShow` 会与"要有 `_viewId`"互为前提 ⇒
		// 视图永远建不出来（README 4.81 的循环门槛）。
		if (this._canHostPage && !this._viewId && this._route) {
			const viewId = this._viewIdForContainer;
			this._viewId = viewId;
			// ★ 换了视图 id（Host 重启后会重建）⇒ 必须清掉"上次摆位"的记录，
			//   否则矩形恰好没变时幂等闸会跳过**首次** `layoutView` ⇒ 新原生视图停在 0x0（白屏）。
			this._lastLaidOutRect = undefined;
			// ⚠ 第 5 参是 route、第 6 参是**承载表面**（2026-10-13）：侧栏传 `sideview` ⇒ 插件渲染摘要版
			//   （完整页反过来由编辑区承载时传 `editor`）✓
			void this._dsh.createView(viewId, this._windowId, 'plugin-page', undefined, this._route, 'sideview')
				.then(() => {
					this._root.dataset.viewId = viewId;
					this._layoutView();
					this._updateVisibility();
				}, e => {
					// 创建失败（如路由非法、主进程拒绝）时释放 id，下一次可见时重试。
					this._log.error('[dshHarness] plugin page: createView failed', e);
					this._viewId = undefined;
				});
		}
		// 状态框在"宿主未就绪或视图还没建好"时可见（含缺 Node / 缺 dsh 的一键准备按钮）。
		this._statusBox.style.display = running && this._viewId ? 'none' : 'flex';
		const d = this._root.dataset;
		d.containerId = this._containerId;
		d.route = this._route ?? '';
		d.hostState = this._dsh.status.state;
		d.shown = String(this._shouldShow);
		d.rectZero = String(this._rectZero);
		d.overlay = String(this._overlayVisible);
		const show = this._shouldShow;
		// 这一次隐藏是不是"因浮层让位"：是的话，让位与抓帧必须**合成一次调用**（主进程内先抓后藏）——
		// 拆开会让两条 IPC 赛跑、抓到离屏空帧（见 `dshOverlayFreeze.ts` / `captureAndHide` 的注释）。
		// 只用 `_overlayVisible` 触发（矩形为 0 的那些隐藏原因不需要贴图：那块本来就不该有画面 ✓）。
		const freezeHide = !show && this._overlayVisible && this._viewShown;
		if (show) {
			this._freeze.clear();
		}
		if (!this._viewId || show === this._viewShown) {
			// 同上：本地"以为显示了"必须与主进程对账（主进程可能被单独置为隐藏 ⇒ 不确认就永久 0x0）。
			this._verifyMainVisible(show);
			this._armHiddenRecheck(show);
			this._armShownRecheck(show);
			return;
		}
		this._viewShown = show;
		this._viewShownConfirmed = false;      // 刚下的结论还没被主进程背书
		if (show) {
			this._layoutView();
			void this._dsh.setViewVisible(this._viewId, true);
		} else if (freezeHide) {
			// 让位 + 贴帧（`hideAndFreeze` 自己会把视图藏起来 ⇒ **不要**再发 setViewVisible(false)）
			this._freeze.hideAndFreeze(this._viewId);
		} else {
			void this._dsh.setViewVisible(this._viewId, false);
		}
		this._verifyMainVisible(show);
		this._armHiddenRecheck(show);
		this._armShownRecheck(show);
	}

	/**
	 * 与主进程**对账**：本地 `_viewShown` 只是**意图**，主进程的 `nativeVisible`（Electron 真相）才是事实。
	 * 只在"该显示、以为已显示、但尚未背书"时问一次；确认后不再问（健康路径零额外开销）。不一致就作废
	 * 缓存让 `_updateVisibility()` 重放。1s 节流，避免不一致时变成 IPC 紧循环。
	 */
	private _verifyMainVisible(show: boolean): void {
		if (!show || !this._viewId || this._verifyingMainVisible || this._isShownConfirmed()) {
			return;
		}
		const now = Date.now();
		if (now - this._lastVerifyAt < 1_000) {
			return;
		}
		this._lastVerifyAt = now;
		const viewId = this._viewId;
		this._verifyingMainVisible = true;
		void this._dsh.listViews().then(views => {
			this._verifyingMainVisible = false;
			if (this._viewId !== viewId) {
				return;      // 期间换了视图：结论作废
			}
			const info = views.find(v => v.viewId === viewId);
			if (info?.nativeVisible) {
				this._viewShownConfirmed = true;
				this._viewShownConfirmedAt = Date.now();
			} else {
				this._viewShown = false;
				this._viewShownConfirmed = false;
				this._viewShownConfirmedAt = 0;
				this._updateVisibility();
			}
		}, () => {
			this._verifyingMainVisible = false;      // 查询失败不动结论，等下一次
		});
	}

	/** 最近 5s 内确认过"主进程真的在显示它"（确认会过期 ⇒ 靠心跳复查）。 */
	private _isShownConfirmed(): boolean {
		return this._viewShownConfirmed && Date.now() - this._viewShownConfirmedAt < 5_000;
	}

	/** 已显示时的心跳：只要"该显示"，就每 5s 与主进程对一次账（静默隐藏的唯一兜底）。 */
	private _armShownRecheck(show: boolean): void {
		const need = show && !!this._viewId && this.isBodyVisible();
		if (need && this._shownRecheck === undefined) {
			this._shownRecheck = setInterval(() => this._verifyMainVisible(true), 5_000);
		} else if (!need && this._shownRecheck !== undefined) {
			clearInterval(this._shownRecheck);
			this._shownRecheck = undefined;
		}
	}

	/**
	 * 需要持续复算的两种情形，恢复即停：
	 *   ① 该显示却没显示（遮挡事件漏网 / 零宽后无 resize ⇒ 自愈）；
	 *   ② 该显示、以为已显示，但**尚未与主进程对过账**（见 `_verifyMainVisible`）。
	 */
	private _armHiddenRecheck(show: boolean): void {
		const need = !!this._viewId && this.isBodyVisible() && (!show || !this._isShownConfirmed());
		if (need && this._hiddenRecheck === undefined) {
			this._hiddenRecheck = setInterval(() => this._updateVisibility(), 1_000);
		} else if (!need) {
			this._stopHiddenRecheck();
		}
	}

	private _stopHiddenRecheck(): void {
		if (this._hiddenRecheck !== undefined) {
			clearInterval(this._hiddenRecheck);
			this._hiddenRecheck = undefined;
		}
	}

	private _stopShownRecheck(): void {
		if (this._shownRecheck !== undefined) {
			clearInterval(this._shownRecheck);
			this._shownRecheck = undefined;
		}
	}
}
