/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 插件页的**编辑区承载**（2026-10-13，用户 D1=A）—— 与侧栏的 `DshPluginViewPane` 是**同一个页面**，
 * 只是承载表面不同：本类创建视图时传 `pageSurface='editor'` ⇒ 主进程给页面 URL 加 `?surface=editor`
 * ⇒ 插件渲染**完整版**（侧栏那份是 `?surface=sideview` 的摘要版 ✓）。
 *
 * ⚠ 三个必须照做的约定（每条都对应一个曾经踩过的坑）：
 *  ① **viewId 带 `-editor` 前缀**：主进程对重复 viewId **静默忽略** ⇒ 与侧栏撞 id 的表现是
 *     "有一边永远空白且不报错" ✗（见 `DshPluginPageEditorInput` 的注释）。
 *  ② **可见性要自己收**：这是 `WebContentsView`，它**浮在 DOM 之上** ⇒ 编辑器切标签/被遮住时必须
 *     `setViewVisible(false)`，否则页面会盖在别的编辑器上 ✗。本类只做"面板可见 + 矩形非零"这一个判据
 *     （重活由 `EditorPane.setVisible → setEditorVisible` 递进来 ✓ —— 这是本仓既有钩子，不必自造一套。
 *     聊天页那套（`DshChatBinding`）另有与主进程对账、心跳、隐藏自愈，是因为它还要处理工作台早期
 *     的视图回收/多 renderer 抢占；插件页没有那条路径，先不做 —— 真机上若出现"卡在 0×0"再补。）
 *  ③ **换输入要回收旧视图**：编辑器 pane 是**按类型复用**的，`setInput` 可能换成**另一个容器**
 *     ⇒ 不 dispose 旧的就会留下一个谁也关不掉的浮层 ✗。
 */

import { $, Dimension, append, getWindow } from '../../../../base/browser/dom.js';
import { getZoomFactor } from '../../../../base/browser/browser.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { DshPluginPageEditorInput } from './dshPluginPageEditorInput.js';
import { IDshHarnessService } from './dshHarnessService.js';

export class DshPluginPageEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.dshPluginPage';

	private _root: HTMLElement | undefined;
	private _viewId: string | undefined;
	private _containerId: string | undefined;
	/** 子路由（如 `/x/kb/graph`）；`undefined` = 模块主页。★ 2026-10-19：与 `_containerId` 一起判缓存 ——
	 *  同容器的两个子页面（知识库主页 / 关系图谱）必须能各自重建视图，否则切 tab 会串 ✗。 */
	private _route: string | undefined;
	/** 面板级可见性（来自 `setEditorVisible`）—— 与"矩形非零"一起决定视图显示与否 ✓ */
	private _paneVisible = true;
	/** 上一次看到的 Host 状态（判"重启跃迁"用；见 `createEditor` 里的 reload 注释）。 */
	private _lastHostState: string | undefined;
	/** Host 状态订阅只接一次（`createEditor` 可能被复用调用）。 */
	private _statusWired = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		@ILogService private readonly _log: ILogService,
	) {
		super(DshPluginPageEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		// ⚠ 2026-10-13（用户："主页的 editorpane 没有页签"）：**宿主必须自己建定位上下文** ——
		//   下面 root 是 `position: absolute; inset: 0` 的浮层，而原生视图是按它的 `getBoundingClientRect()`
		//   摆位的 ⇒ 如果 `parent` 没有定位，`inset: 0` 会落到**更上层**的定位祖先
		//   （`.monaco-workbench .part.editor { position: relative }`）⇒ rect 覆盖到**整个编辑区 part，
		//   含 `.title` 页签栏** ⇒ 原生 WebContentsView 把页签栏**盖住**，表现就是"没有页签" ✗。
		//   （`.editor-instance` / `.editor-container` 全仓 CSS 里都没有 position ⇒ 必须在这里补 ✓。）
		//   照抄本站另外两处正确实现：`dshPluginViewPane`（侧栏插件页）、`dshChatInstanceHost`（聊天宿主）。
		parent.style.position = 'relative';
		const root = append(parent, $('.dsh-plugin-page-editor'));
		// 视图是绝对定位的浮层 ⇒ 容器铺满、且**不能**有 padding/滚动（滚动会与浮层错位 ✗）
		root.style.cssText = 'position: absolute; inset: 0; overflow: hidden;';
		this._root = root;
		// ★ 2026-10-19（与 `dshPluginViewPane` 同一类根因）：插件页连着**具体的 Host 进程**（端口 + 令牌）。
		//   Host 重启后旧页面的连接全部失效 ⇒ 页面停在错误页/空白，而视图被复用（`dsh-plugin-editor-w…`）
		//   ⇒ 用户看到的"页面打不开 / 空白"会一直持续到手动关掉重开。这里在 Host 回到 running 时自动 reload。
		if (!this._statusWired) {
			this._statusWired = true;
			this._register(this._dsh.onDidChangeStatus(s => {
				const prev = this._lastHostState;
				this._lastHostState = s.state;
				if (prev !== undefined && prev !== 'running' && s.state === 'running' && this._viewId) {
					const viewId = this._viewId;
					this._log.info(`[dshHarness] host running again → reload editor plugin page ${viewId}`);
					void this._dsh.reloadView(viewId).then(() => this._layoutView()).catch(err => {
						this._log.warn(`[dshHarness] reload editor plugin page ${viewId} failed: ${String((err as Error)?.message ?? err)}`);
					});
				}
			}));
		}
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input instanceof DshPluginPageEditorInput) {
			// ★ 2026-10-19：带上子路由（`/x/kb/graph` 这类）—— 只传 containerId 会打开模块主页 ✗
			await this._ensureView(input.containerId, input.route);
		}
	}

	override layout(_dimension: Dimension): void {
		this._layoutView();
	}

	protected override setEditorVisible(visible: boolean): void {
		this._paneVisible = visible;
		this._updateVisibility();
	}

	override dispose(): void {
		this._disposeView();
		super.dispose();
	}

	// ── 视图生命周期 ────────────────────────────────────────────────────────────

	private get _windowId(): number | undefined {
		return this._root ? getWindow(this._root).vscodeWindowId : undefined;
	}

	private _viewIdFor(containerId: string, windowId: number, subRoute?: string): string {
		// ⚠ 多 `-editor`：与侧栏的 `dsh-plugin-w<win>-<containerId>` 必须不同（撞 id 会被静默忽略 ✗）
		// ⚠ 子路由也要进 id：同容器两个子页面（知识库主页 / 关系图谱）各需一个视图 ✓
		const suffix = subRoute ? '-' + subRoute.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') : '';
		return `dsh-plugin-editor-w${windowId}-${containerId}${suffix}`;
	}

	/**
	 * 按容器（或**显式子路由**）建视图（换容器/换路由时先回收旧的 ✓）。
	 * @param routeOverride 显式子路由（如 `/x/kb/graph`）——给了就直接用它，**不去猜模块主页** ✓
	 */
	private async _ensureView(containerId: string, routeOverride?: string): Promise<void> {
		if (this._containerId === containerId && this._route === routeOverride && this._viewId) {
			return;
		}
		this._disposeView();
		this._containerId = containerId;
		this._route = routeOverride;
		const windowId = this._windowId;
		if (windowId === undefined) {
			return;
		}
		let route: string | undefined = routeOverride;
		// ★ 2026-10-22（doc/workbench-refactor-plan.md §5 步骤 4）：模块主页若已迁成 React 工作台
		//   ⇒ 开 'workbench' 视图（加载 dsh 客户端、整页打开该工作台）；显式子路由（如 /x/kb/graph）仍走 SSR 页。
		//   代价实测 ≈ +64MB / 个已开编辑区（方案 §2 F3），所以只给迁移过的模块用。
		let workbench = false;
		if (!route) {
			try {
				const state = await this._dsh.resolveModulePage(containerId);
				route = state?.page?.route;
				workbench = state?.page?.workbenchClient === true;
			} catch (e) {
				this._log.warn(`[dshHarness] 解析模块页失败 ${containerId}：${String((e as Error)?.message ?? e)}`);
			}
		}
		if (!route) {
			// 没有可显示的页面（模块没装 / 还在计划中）：给一句说明，而不是让用户对着空白猜 ✗
			this._renderNote(`这个模块暂时没有可显示的页面（${containerId}）。请到插件中心确认它已安装并启用。`);
			return;
		}
		const viewId = this._viewIdFor(containerId, windowId, routeOverride);
		this._viewId = viewId;
		this._renderNote('');
		try {
			await this._dsh.createView(viewId, windowId, workbench ? 'workbench' : 'plugin-page', undefined, route, 'editor');
			this._root?.setAttribute('data-dsh-page-view', viewId);
			this._root?.setAttribute('data-dsh-page-surface', workbench ? 'workbench' : 'plugin-page');
			this._layoutView();
		} catch (e) {
			this._viewId = undefined;
			this._log.error(`[dshHarness] 建编辑区插件页视图失败 ${containerId}：${String((e as Error)?.message ?? e)}`);
			this._renderNote(`页面打不开：${String((e as Error)?.message ?? e)}`);
		}
	}

	/** 把浮层摆到本 pane 的矩形上（宽度/高度为 0 时直接隐藏，别留一个 0×0 的浮层 ✓）。 */
	private _layoutView(): void {
		const root = this._root;
		const viewId = this._viewId;
		const windowId = this._windowId;
		if (!root || !viewId || windowId === undefined) {
			return;
		}
		const rect = root.getBoundingClientRect();
		if (rect.width < 1 || rect.height < 1) {
			this._dsh.setViewVisible(viewId, false);
			return;
		}
		this._dsh.layoutView(viewId, {
			windowId, x: rect.left, y: rect.top, width: rect.width, height: rect.height,
			zoomFactor: getZoomFactor(getWindow(root)),
		});
		this._updateVisibility();
	}

	private _updateVisibility(): void {
		const viewId = this._viewId;
		const root = this._root;
		if (!viewId || !root) {
			return;
		}
		const rect = root.getBoundingClientRect();
		this._dsh.setViewVisible(viewId, this._paneVisible && rect.width >= 1 && rect.height >= 1);
	}

	private _disposeView(): void {
		if (this._viewId) {
			void this._dsh.disposeView(this._viewId);
			this._viewId = undefined;
		}
	}

	/** 面板内的说明文字（没有页面 / 建视图失败时）—— 同 `DshPluginViewPane._renderNoPage` 的口径：**明说** ✓ */
	private _renderNote(text: string): void {
		const root = this._root;
		if (!root) {
			return;
		}
		root.querySelector('.dsh-plugin-page-note')?.remove();
		if (!text) {
			return;
		}
		const note = append(root, $('.dsh-plugin-page-note'));
		note.textContent = text;
		note.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:24px; text-align:center; color: var(--vscode-descriptionForeground, #999);';
	}
}
