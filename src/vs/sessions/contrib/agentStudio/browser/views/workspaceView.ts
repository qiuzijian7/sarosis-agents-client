/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspaceExplorer.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { IAction, toAction, Separator } from '../../../../../base/common/actions.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import Severity from '../../../../../base/common/severity.js';
import { basename, dirname, joinPath } from '../../../../../base/common/resources.js';
import { IActionViewItem } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { BaseActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IDropdownMenuActionViewItemOptions } from '../../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IFileService, FileChangesEvent } from '../../../../../platform/files/common/files.js';
import { IWorkingCopyFileService } from '../../../../../workbench/services/workingCopy/common/workingCopyFileService.js';
import { IEditableData } from '../../../../../workbench/common/views.js';
import { IFileDialogService, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { KbImportController } from '../kbImportController.js';
import type { IKbVault } from './knowledgeBase/kbTypes.js';
import { IIndexConfig, IndexMode, ICodebaseMemoryMcpService } from '../codebaseMemoryMcpService.js';
import { WorkbenchCompressibleAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { createFileIconThemableTreeContainerScope } from '../../../../../workbench/contrib/files/browser/views/explorerView.js';
import { ProgressBar } from '../../../../../base/browser/ui/progressbar/progressbar.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { defaultProgressBarStyles, defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { ResourceLabels } from '../../../../../workbench/browser/labels.js';
import { IEditorService, SIDE_GROUP } from '../../../../../workbench/services/editor/common/editorService.js';
import { GroupsOrder, IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import type { Workspace } from '../../common/types.js';
import {
	IWorkspaceExplorerElement,
	WorkspaceExplorerDelegate,
	WorkspaceExplorerDataSource,
	WorkspaceExplorerRenderer,
	WorkspaceExplorerFilter,
	WorkspaceExplorerSorter,
} from './workspaceExplorerViewer.js';

/**
 * Command id of the placeholder action that hosts the workspace selector
 * dropdown in the view's title bar. The action itself is a no-op; its sole
 * purpose is to give the title bar a slot we can fill with a custom
 * {@link WorkspaceSelectorActionViewItem} via `createActionViewItem`.
 */
export const WORKSPACE_SELECTOR_ACTION_ID = 'agentStudio.workspace.selector';

/**
 * Command ids of native file commands reused by the workspace explorer
 * context menu. These are defined as plain string literals here (rather than
 * importing from `workbench/contrib/files`) to keep the sessions layer free of
 * hard dependencies on contrib internals. The native commands resolve their
 * target via `getResourceForCommand` / `getMultiSelectedResources`, both of
 * which accept a `URI` as the first command argument, so passing
 * `element.resource` works the same as a native explorer invocation.
 */
const OPEN_TO_SIDE_COMMAND_ID = 'explorer.openToSide';
const OPEN_WITH_EXPLORER_COMMAND_ID = 'explorer.openWith';
const REVEAL_IN_OS_COMMAND_ID = 'revealFileInOS';
const OPEN_IN_INTEGRATED_TERMINAL_COMMAND_ID = 'openInIntegratedTerminal';
const COPY_PATH_COMMAND_ID = 'copyFilePath';
const COPY_RELATIVE_PATH_COMMAND_ID = 'copyRelativeFilePath';

/**
 * Title-bar action view item that renders a workspace selector to the left of
 * the "+" (add related folder) button. It shows the active workspace name as a
 * button; clicking it opens a dropdown panel anchored directly **below** the
 * button. The panel has a search box on top and a list of workspaces, each
 * rendered as two lines (name over path), with the search box filtering on both
 * name and path. Picking a workspace emits {@link onDidSelectWorkspace}; the
 * owning view forwards that to `setActiveWorkspace` — the single source of truth
 * that re-syncs the sandbox, SCM folders, the tree, and the canvas.
 */
class WorkspaceSelectorActionViewItem extends BaseActionViewItem {
	private buttonEl!: HTMLElement;
	private labelEl!: HTMLElement;
	private workspaces: Workspace[] = [];
	private activeId: string | undefined;

	private readonly _onDidSelectWorkspace = this._register(new Emitter<Workspace>());
	readonly onDidSelectWorkspace = this._onDidSelectWorkspace.event;

	constructor(action: IAction, private readonly contextViewService: IContextViewService) {
		super(null, action);
	}

	/** Update the backing workspaces and refresh the button label. */
	setWorkspaces(workspaces: Workspace[], activeId: string | undefined): void {
		this.workspaces = workspaces;
		this.activeId = activeId;
		this._updateLabel();
	}

	private _updateLabel(): void {
		if (!this.labelEl) {
			return;
		}
		const active = this.activeId ? this.workspaces.find(w => w.id === this.activeId) : undefined;
		const fallback = this.workspaces[0];
		const ws = active ?? fallback;
		this.labelEl.textContent = ws ? ws.name : localize('workspaceSelectorEmpty', "无工作区");
		this.buttonEl?.classList.toggle('disabled', this.workspaces.length === 0);
		if (ws) {
			this.buttonEl.title = ws.path ? `${ws.name}\n${ws.path}` : ws.name;
		} else {
			this.buttonEl.title = localize('workspaceSelectorEmpty', "无工作区");
		}
	}

	/**
	 * Open a dropdown panel anchored below the button. The panel renders a
	 * search box and a filterable list of workspaces (name on top, path below).
	 */
	private _openPicker(): void {
		if (this.workspaces.length === 0) {
			return;
		}
		this.buttonEl.classList.add('expanded');

		this.contextViewService.showContextView({
			getAnchor: () => this.buttonEl,
			anchorAlignment: AnchorAlignment.LEFT,
			anchorPosition: AnchorPosition.BELOW,
			render: (container: HTMLElement) => this._renderPanel(container),
			onHide: () => this.buttonEl.classList.remove('expanded'),
		});
	}

	/**
	 * Render the dropdown panel content (search box + workspace list) into the
	 * context-view container and wire up filtering/selection/keyboard nav.
	 */
	private _renderPanel(container: HTMLElement): DisposableStore {
		const store = new DisposableStore();

		const panel = DOM.append(container, DOM.$('.workspace-selector-panel'));

		// ─── Search box ──────────────────────────────────────────────
		const searchWrap = DOM.append(panel, DOM.$('.workspace-selector-search'));
		const searchIcon = DOM.append(searchWrap, DOM.$('span.workspace-selector-search-icon'));
		searchIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.search));
		const input = DOM.append(searchWrap, DOM.$('input.workspace-selector-search-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = localize('workspaceSelectorPlaceholder', "搜索工作区（名称或路径）");
		input.spellcheck = false;

		// ─── List ────────────────────────────────────────────────────
		const listEl = DOM.append(panel, DOM.$('.workspace-selector-list'));

		// State for keyboard navigation: index into the *currently visible* rows.
		let visibleWorkspaces: Workspace[] = [];
		let focusedIndex = -1;
		const rowEls: HTMLElement[] = [];

		const commit = (ws: Workspace | undefined) => {
			if (ws) {
				this._onDidSelectWorkspace.fire(ws);
			}
			this.contextViewService.hideContextView();
		};

		const updateFocusHighlight = () => {
			rowEls.forEach((el, i) => el.classList.toggle('focused', i === focusedIndex));
			if (focusedIndex >= 0 && rowEls[focusedIndex]) {
				rowEls[focusedIndex].scrollIntoView({ block: 'nearest' });
			}
		};

		const renderList = (filter: string) => {
			listEl.replaceChildren();
			rowEls.length = 0;
			const needle = filter.trim().toLowerCase();
			visibleWorkspaces = this.workspaces.filter(ws => {
				if (!needle) {
					return true;
				}
				return ws.name.toLowerCase().includes(needle)
					|| (ws.path || '').toLowerCase().includes(needle);
			});

			if (visibleWorkspaces.length === 0) {
				DOM.append(listEl, DOM.$('.workspace-selector-empty')).textContent =
					localize('workspaceSelectorNoMatch', "未找到匹配的工作区");
				focusedIndex = -1;
				return;
			}

			visibleWorkspaces.forEach((ws, i) => {
				const row = DOM.append(listEl, DOM.$('.workspace-selector-row'));
				if (ws.id === this.activeId) {
					row.classList.add('active');
				}

				const iconEl = DOM.append(row, DOM.$('span.workspace-selector-row-icon'));
				iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.folder));

				const textEl = DOM.append(row, DOM.$('.workspace-selector-row-text'));
				const nameEl = DOM.append(textEl, DOM.$('.workspace-selector-row-name'));
				nameEl.textContent = ws.name;
				if (ws.path) {
					const pathEl = DOM.append(textEl, DOM.$('.workspace-selector-row-path'));
					pathEl.textContent = ws.path;
					pathEl.title = ws.path;
				}

				if (ws.id === this.activeId) {
					const checkEl = DOM.append(row, DOM.$('span.workspace-selector-row-check'));
					checkEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
				}

				store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, e => {
					DOM.EventHelper.stop(e, true);
					commit(ws);
				}));
				store.add(DOM.addDisposableListener(row, DOM.EventType.MOUSE_OVER, () => {
					focusedIndex = i;
					updateFocusHighlight();
				}));

				rowEls.push(row);
			});

			// Default focus: the active workspace, else the first row.
			const activeIdx = visibleWorkspaces.findIndex(w => w.id === this.activeId);
			focusedIndex = activeIdx >= 0 ? activeIdx : 0;
			updateFocusHighlight();
		};

		store.add(DOM.addDisposableListener(input, DOM.EventType.INPUT, () => renderList(input.value)));
		store.add(DOM.addDisposableListener(input, DOM.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.DownArrow)) {
				DOM.EventHelper.stop(e, true);
				if (visibleWorkspaces.length > 0) {
					focusedIndex = (focusedIndex + 1) % visibleWorkspaces.length;
					updateFocusHighlight();
				}
			} else if (event.equals(KeyCode.UpArrow)) {
				DOM.EventHelper.stop(e, true);
				if (visibleWorkspaces.length > 0) {
					focusedIndex = (focusedIndex - 1 + visibleWorkspaces.length) % visibleWorkspaces.length;
					updateFocusHighlight();
				}
			} else if (event.equals(KeyCode.Enter)) {
				DOM.EventHelper.stop(e, true);
				commit(visibleWorkspaces[focusedIndex]);
			} else if (event.equals(KeyCode.Escape)) {
				DOM.EventHelper.stop(e, true);
				this.contextViewService.hideContextView();
			}
		}));

		renderList('');

		// ─── Dismiss on outside interaction ──────────────────────────
		// The base ContextView only auto-closes on a capture-phase click that
		// lands on its host container. That misses clicks on the editor canvas
		// (a webview iframe), other windows, or focus loss. Register our own
		// global listeners so any interaction outside the panel/button closes
		// the dropdown. Defer registration to the next tick so the click that
		// opened the panel doesn't immediately dismiss it.
		const targetWindow = DOM.getWindow(this.buttonEl);
		const isInside = (target: EventTarget | null): boolean =>
			target instanceof Node && (DOM.isAncestor(target, panel) || DOM.isAncestor(target, this.buttonEl));

		setTimeout(() => {
			input.focus();

			// Pointer down anywhere outside the panel/button → close.
			store.add(DOM.addDisposableListener(targetWindow, DOM.EventType.MOUSE_DOWN, e => {
				if (!isInside(e.target)) {
					this.contextViewService.hideContextView();
				}
			}, true));
			store.add(DOM.addDisposableListener(targetWindow, DOM.EventType.POINTER_DOWN, e => {
				if (!isInside(e.target)) {
					this.contextViewService.hideContextView();
				}
			}, true));
			// Focus moving into another window/iframe (e.g. clicking the webview
			// canvas) won't surface as a mousedown here → close on window blur.
			store.add(DOM.addDisposableListener(targetWindow, DOM.EventType.BLUR, () => {
				this.contextViewService.hideContextView();
			}));
		}, 0);

		return store;
	}

	override render(container: HTMLElement): void {
		container.classList.add('workspace-selector-action-item');

		this.buttonEl = DOM.append(container, DOM.$('a.workspace-selector-button'));
		this.buttonEl.setAttribute('role', 'button');
		this.buttonEl.setAttribute('tabindex', '0');
		this.buttonEl.setAttribute('aria-label', localize('workspaceSelectorAria', "切换工作区"));

		const iconEl = DOM.append(this.buttonEl, DOM.$('span.workspace-selector-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.layers));

		this.labelEl = DOM.append(this.buttonEl, DOM.$('span.workspace-selector-label'));

		const chevronEl = DOM.append(this.buttonEl, DOM.$('span.workspace-selector-chevron'));
		chevronEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));

		this._register(DOM.addDisposableListener(this.buttonEl, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			this._openPicker();
		}));
		this._register(DOM.addDisposableListener(this.buttonEl, DOM.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space) || event.equals(KeyCode.DownArrow)) {
				DOM.EventHelper.stop(e, true);
				this._openPicker();
			}
		}));

		this._updateLabel();
	}

	override setFocusable(): void {
		// Title-bar widget — keep it out of the roving tabindex chain.
	}

	override focus(): void {
		this.buttonEl?.focus();
	}

	override blur(): void {
		this.buttonEl?.blur();
	}
}

/**
 * Workspace View - 工作区资源管理器
 *
 * 参考 VSCode 原生资源管理器布局，以树形结构显示
 * 右侧 agent-studio 编辑区中所有 workspace 创建的工作区目录。
 *
 * 功能：
 *  - 树形展示所有 workspace 的文件目录结构
 *  - 每个 workspace 作为一个根节点显示
 *  - 支持展开/折叠目录、文件图标主题（通过 ResourceLabels）
 *  - 点击文件在编辑器中打开
 *  - 无 workspace 时显示空状态提示
 *  - 标题栏 "+" 按钮左侧提供工作区选择下拉框
 */
export class WorkspaceViewPane extends ViewPane {

	private treeContainer!: HTMLElement;
	private tree!: WorkbenchCompressibleAsyncDataTree<IWorkspaceExplorerElement, IWorkspaceExplorerElement, FuzzyScore>;
	private wsProgressBar!: ProgressBar;
	private emptyStateContainer!: HTMLElement;
	private resourceLabels!: ResourceLabels;

	/** Title-bar workspace selector dropdown (rendered left of the "+" button). */
	private workspaceSelectorItem: WorkspaceSelectorActionViewItem | undefined;
	/** Workspaces backing the selector, in display order (index-aligned with the SelectBox). */
	private selectorWorkspaces: Workspace[] = [];

	/**
	 * The element currently being renamed inline, and its editing state. When
	 * set, the tree renderer swaps that row's label for an InputBox. We key by
	 * resource string so identity survives tree node re-creation across reloads.
	 */
	private editableElementResource: string | undefined;
	private editableData: IEditableData | undefined;

	/**
	 * Filesystem watchers for the currently displayed real workspace roots.
	 * Recreated on every {@link _loadWorkspaceRoots} so they always track the
	 * active workspace's home + related folders. Cleared on dispose with the view.
	 */
	private readonly _fsWatchers = this._register(new DisposableStore());
	/**
	 * The real (scheme === 'file') root elements currently rendered, used to
	 * scope on-disk change events back to a specific subtree to refresh.
	 */
	private _watchedRoots: IWorkspaceExplorerElement[] = [];
	/** Roots accumulated between debounce ticks, refreshed together on the next tick. */
	private readonly _pendingRefreshRoots = new Set<IWorkspaceExplorerElement>();
	/** Debounce handle coalescing a burst of filesystem events into a single refresh. */
	private _fsRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** v27: wall-clock timestamp of the last successful refresh, used to throttle
	 *  the debounce window so a burst of file events can't drive a busy loop. */
	private _lastFsRefreshAt = 0;
	/**
	 * v28: reentrancy guard for {@link _flushPendingRefresh}. Without it, every
	 * `fileService.resolve()` call inside `getChildren` emits its own
	 * `onDidFilesChange` event — which immediately re-schedules a refresh that
	 * will call resolve again, ad infinitum. While a refresh is in flight we
	 * drop new events (they'll be picked up by the next debounce tick when the
	 * in-flight refresh completes) instead of enqueuing another refresh.
	 */
	private _isRefreshing = false;

	/** 知识库导入控制器（入口+抽取）。供工作区文件右键「导入知识库」使用。 */
	private readonly _kbImport: KbImportController;


	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IWorkingCopyFileService private readonly workingCopyFileService: IWorkingCopyFileService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@IStorageService private readonly storageService: IStorageService,
		@ICodebaseMemoryMcpService private readonly _cbmService: ICodebaseMemoryMcpService,
		@INativeEnvironmentService private readonly _envService: INativeEnvironmentService,
		@IViewsService private readonly _viewsService: IViewsService,
		@IRequestService private readonly _requestService: IRequestService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._kbImport = new KbImportController(
			configurationService, this.logService, this.fileService, this._envService,
			this.storageService, this.agentStudioService, this._viewsService, this.editorService,
			this.notificationService, this._requestService,
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.logService.info('[WorkspaceViewPane] renderBody called');

		container.classList.add('workspace-explorer-view');

		// ─── Tree Container ───────────────────────────────────────────
		this.treeContainer = DOM.append(container, DOM.$('.workspace-explorer-tree-container'));

		// Enable file icon theme
		this._register(createFileIconThemableTreeContainerScope(this.treeContainer, this.themeService));

		// ─── Progress Bar ─────────────────────────────────────────────
		const progressContainer = DOM.append(container, DOM.$('.workspace-explorer-progress'));
		this.wsProgressBar = this._register(new ProgressBar(progressContainer, defaultProgressBarStyles));
		this.wsProgressBar.stop().hide();

		// ─── Empty State ──────────────────────────────────────────────
		this.emptyStateContainer = DOM.append(container, DOM.$('.workspace-explorer-empty-state'));
		this.emptyStateContainer.style.display = 'none';
		const emptyIcon = DOM.append(this.emptyStateContainer, DOM.$('.workspace-explorer-empty-icon'));
		emptyIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folderOpened));
		const emptyMessage = DOM.append(this.emptyStateContainer, DOM.$('.workspace-explorer-empty-message'));
		emptyMessage.textContent = localize('noWorkspaces', "No workspaces created yet.");
		const emptyHint = DOM.append(this.emptyStateContainer, DOM.$('.workspace-explorer-empty-hint'));
		emptyHint.textContent = localize('noWorkspacesHint', "Create a workspace in the editor to see its files here.");

		// ─── Create Tree ──────────────────────────────────────────────
		this._createTree();

		// ─── Load Data ────────────────────────────────────────────────
		this._loadWorkspaceRoots().catch(err => {
			this.logService.error('[WorkspaceViewPane] Failed to load workspace roots in renderBody:', err);
			// Ensure empty state is visible even if loading fails
			this.treeContainer.style.display = 'none';
			this.emptyStateContainer.style.display = 'flex';
		});

		// ─── Subscribe to changes ─────────────────────────────────────
		try {
			// Reload when any workspace data mutates (rename, related-folder add/remove, etc.)
			this._register(this.agentStudioService.onDidChangeWorkspace(() => {
				this.logService.info('[WorkspaceViewPane] Workspace changed, reloading tree');
				this._loadWorkspaceRoots();
			}));
			// Reload when the *active* workspace switches — the tree only ever
			// shows the active workspace's roots, so this is the primary trigger.
			this._register(this.agentStudioService.onDidChangeActiveWorkspace((id: string | undefined) => {
				this.logService.info(`[WorkspaceViewPane] Active workspace changed to ${id}, reloading tree`);
				this._loadWorkspaceRoots();
			}));
		} catch (err) {
			this.logService.warn('[WorkspaceViewPane] Could not subscribe to workspace changes:', err);
		}

		// ─── Subscribe to on-disk file changes ────────────────────────
		// Native VS Code Explorer refreshes via IFileService.onDidFilesChange.
		// We do the same so that files created/deleted directly on disk (e.g.
		// by an AI tool writing test13.txt) show up without a manual reload.
		// The actual recursive watch() registrations on each root are (re)made
		// in _loadWorkspaceRoots; this listener just reacts to their events.
		try {
			this._register(this.fileService.onDidFilesChange(e => this._onDidFilesChange(e)));
		} catch (err) {
			this.logService.warn('[WorkspaceViewPane] Could not subscribe to file changes:', err);
		}

		// ─── Codebase Memory 索引进度 → 树节点 ⏳ 指示器 ────────────
		try {
			let indexingPath: string | undefined;
			this._register(this._cbmService.onDidIndexProgress((line: string) => {
				// 解析 "▶ 开始索引代码库: /path/to/workspace" → 提取路径
				const match = line.match(/▶\s*开始索引代码库:\s*(.+)/);
				if (match) {
					indexingPath = match[1].trim();
					this._updateIndexingFlags(indexingPath, true);
				}
			}));
			this._register(this._cbmService.onDidIndexComplete(() => {
				if (indexingPath) {
					this._updateIndexingFlags(indexingPath, false);
					indexingPath = undefined;
				}
				// 兜底：清除所有可能残留的 indexing 标记
				this._clearAllIndexingFlags();
			}));
		} catch (err) {
			this.logService.warn('[WorkspaceViewPane] Could not subscribe to indexing events:', err);
		}
	}

	/**
	 * Override the title-bar action factory so the placeholder selector command
	 * renders as a workspace dropdown (left of the "+" button) instead of a
	 * normal icon button. Switching delegates to `setActiveWorkspace`, the
	 * single source of truth for sandbox roots, SCM sync, tree, and canvas.
	 */
	override createActionViewItem(action: IAction, options?: IDropdownMenuActionViewItemOptions): IActionViewItem | undefined {
		if (action.id === WORKSPACE_SELECTOR_ACTION_ID) {
			const item = this._register(new WorkspaceSelectorActionViewItem(action, this.contextViewService));
			this.workspaceSelectorItem = item;
			this._register(item.onDidSelectWorkspace(async (ws) => {
				if (ws.id === this.agentStudioService.getActiveWorkspaceId()) {
					return; // Already active — nothing to do.
				}
				this.logService.info(`[WorkspaceViewPane] Selector switching active workspace to "${ws.name}" (${ws.id})`);
				try {
					await this.agentStudioService.setActiveWorkspace(ws.id);
				} catch (err) {
					this.logService.error('[WorkspaceViewPane] setActiveWorkspace from selector failed:', err);
					this.notificationService.error(localize('switchWorkspaceError', "切换工作区失败: {0}", (err as Error)?.message ?? String(err)));
				}
			}));
			// Populate immediately with the latest known workspaces.
			item.setWorkspaces(this.selectorWorkspaces, this.agentStudioService.getActiveWorkspaceId());
			return item;
		}
		return super.createActionViewItem(action, options);
	}

	/**
	 * Refresh the selector options from the given workspaces and highlight the
	 * active one. Called whenever workspace data or the active selection changes.
	 */
	private _refreshWorkspaceSelector(workspaces: Workspace[], activeId: string | undefined): void {
		this.selectorWorkspaces = workspaces;
		this.workspaceSelectorItem?.setWorkspaces(workspaces, activeId);
	}

	private _createTree(): void {
		this.logService.info('[WorkspaceViewPane] Creating workspace explorer tree');

		// Create ResourceLabels instance for proper file icon theme rendering
		const onDidChangeVisibility: Event<boolean> = this.onDidChangeBodyVisibility;
		this.resourceLabels = this._register(this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility }));

		// Create the renderer that uses ResourceLabels. The third argument wires
		// the inline "+" button (rendered on each workspace root row) to the
		// add-related-folder flow, targeting the clicked workspace. The 4th–6th
		// arguments enable inline rename (InputBox in-row, VS Code style).
		const renderer = new WorkspaceExplorerRenderer(
			this.resourceLabels,
			(workspaceId) => {
				this.showAddRelatedFolder(workspaceId).catch(err => {
					this.logService.error('[WorkspaceViewPane] Inline add-related-folder failed:', err);
				});
			},
			(element) => this._getEditableData(element),
			this.contextViewService,
			this.contextMenuService,
		);

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchCompressibleAsyncDataTree<IWorkspaceExplorerElement, IWorkspaceExplorerElement, FuzzyScore>,
			'WorkspaceExplorer',
			this.treeContainer,
			new WorkspaceExplorerDelegate(),
			// Mark every node as incompressible so the tree renders a proper
			// hierarchical structure — just like VS Code's native Explorer.
			// Without this, the compressible tree merges single-child paths
			// into flat entries like ".sarosworkspace/agents.json".
			{ isIncompressible: () => true },
			[renderer],
			this.instantiationService.createInstance(WorkspaceExplorerDataSource),
			{
				accessibilityProvider: {
					getAriaLabel: (element: IWorkspaceExplorerElement) => {
						if (element.isWorkspaceRoot) {
							return localize('workspaceRoot', "{0} (workspace)", element.name);
						}
						return element.name;
					},
					getWidgetAriaLabel: () => localize('workspaceExplorerTree', "Workspace Explorer"),
				},
				identityProvider: {
					getId: (element: IWorkspaceExplorerElement) => element.resource.toString(),
				},
				filter: new WorkspaceExplorerFilter(),
				sorter: new WorkspaceExplorerSorter(),
				expandOnlyOnTwistieClick: false,
				collapseByDefault: (e: IWorkspaceExplorerElement) => !e.isWorkspaceRoot && !e.isVirtualWorkspace,
				paddingBottom: WorkspaceExplorerDelegate.ITEM_HEIGHT,
			}
		));

		// ─── Handle file open on click/double-click ──────────────────
		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (!element) {
				return;
			}

			// Don't open directories, only files
			if (element.isDirectory) {
				return;
			}

			// Skip info nodes — they are read-only label items, not real files
			if (element.isInfoNode) {
				return;
			}

			this.logService.info(`[WorkspaceViewPane] Opening file: ${element.resource.toString()}`);

			// Open the file in the center editor area (first/leftmost editor group).
			// Agent Studio uses a two-column layout:
			//   Left: Sidebar (workspace tree, etc.)
			//   Right: Editor Area (Agent Studio panels like Canvas/Chat/TaskBoard)
			// We need to open files in the first editor group (center) so they don't
			// try to open inside the locked Agent Studio panel group.
			const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1
				? SIDE_GROUP   // Only one group — open to the side (creates a new group)
				: groups[0];   // Use the first (leftmost) group — the center editor area

			this.editorService.openEditor({
				resource: element.resource,
				options: {
					preserveFocus: e.editorOptions.preserveFocus,
					pinned: e.editorOptions.pinned,
				}
			}, targetGroup);
		}));

		this.logService.info('[WorkspaceViewPane] Tree created with file open handler');

		// ─── Context menu: file/folder actions ───────────────────────
		this._register(this.tree.onContextMenu(e => {
			const element = e.element;
			if (!element || element.isInfoNode || element.isEmptyPlaceholder) {
				return;
			}
			// Virtual workspace nodes have no real filesystem resource.
			if (element.isVirtualWorkspace || element.resource.scheme !== 'file') {
				return;
			}
			this.contextMenuService.showContextMenu({
				getAnchor: () => e.anchor,
				getActions: () => this._getContextMenuActions(element),
			});
		}));

		// ─── F2: rename the focused element ──────────────────────────
		this._register(this.tree.onKeyDown(e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.F2)) {
				const focused = this.tree.getFocus();
				const element = focused && focused.length > 0 ? focused[0] : undefined;
				if (element && this._canRename(element)) {
					DOM.EventHelper.stop(e, true);
					this._startRename(element);
				}
			}
		}));
	}

	/**
	 * Build the right-click context menu for a file/folder element. Mirrors the
	 * native Explorer context menu (open to side / open with / reveal in OS /
	 * open in integrated terminal / reveal in explorer view / copy path / copy
	 * relative path / rename / delete), but deliberately EXCLUDES the
	 * "Add to CodeBuddy chat" entry per product requirement.
	 *
	 * The reused native commands all resolve their target via
	 * `getResourceForCommand` / `getMultiSelectedResources`, which accept a URI
	 * as the first command argument — so we can drive them directly with
	 * `element.resource` even though this tree is not the native explorer list.
	 */
	private _getContextMenuActions(element: IWorkspaceExplorerElement): IAction[] {
		const resource = element.resource;
		const isFile = !element.isDirectory;
		const isCodeWorkspace = isFile && resource.path.toLowerCase().endsWith('.code-workspace');
		const actions: IAction[] = [];

		// ─── .code-workspace 导入知识库（链接文件夹到库）──────────────
		if (isCodeWorkspace) {
			actions.push(toAction({
				id: 'agentStudio.workspace.importCodeWorkspaceToKb',
				label: localize('importToKb', "📚 导入到知识库"),
				run: () => this._importCodeWorkspaceToKb(resource),
			}));
			actions.push(new Separator());
		}

		// ─── 文件「导入到知识库」（入口落盘到库 + 抽取构建笔记）────────
		if (isFile && !isCodeWorkspace) {
			actions.push(toAction({
				id: 'agentStudio.workspace.importFileToKb',
				label: localize('importFileToKb', "📚 导入到知识库"),
				run: () => this._importFileToKb(resource),
			}));
			actions.push(new Separator());
		}

		// ─── Group 1: open ───────────────────────────────────────────
		if (isFile) {
			actions.push(toAction({
				id: 'agentStudio.workspace.openToSide',
				label: localize('openToSide', "在侧边打开"),
				run: () => this._runCommand(OPEN_TO_SIDE_COMMAND_ID, resource),
			}));
			actions.push(toAction({
				id: 'agentStudio.workspace.openWith',
				label: localize('openWith', "打开方式..."),
				run: () => this._runCommand(OPEN_WITH_EXPLORER_COMMAND_ID, resource),
			}));
		}

		// ─── Group 2: reveal / terminal ──────────────────────────────
		actions.push(new Separator());
		actions.push(toAction({
			id: 'agentStudio.workspace.revealInOS',
			label: isMacintosh
				? localize('revealInMac', "在访达中显示")
				: isWindows
					? localize('revealInWindows', "在文件资源管理器中显示")
					: localize('revealInLinux', "在文件管理器中显示"),
			run: () => this._runCommand(REVEAL_IN_OS_COMMAND_ID, resource),
		}));
		actions.push(toAction({
			id: 'agentStudio.workspace.openInIntegratedTerminal',
			label: localize('openInIntegratedTerminal', "在集成终端中打开"),
			run: () => this._runCommand(OPEN_IN_INTEGRATED_TERMINAL_COMMAND_ID, resource),
		}));

		// ─── Group 3: clipboard / path ───────────────────────────────
		actions.push(new Separator());
		actions.push(toAction({
			id: 'agentStudio.workspace.copyPath',
			label: localize('copyPath', "复制路径"),
			run: () => this._runCommand(COPY_PATH_COMMAND_ID, resource),
		}));
		actions.push(toAction({
			id: 'agentStudio.workspace.copyRelativePath',
			label: localize('copyRelativePath', "复制相对路径"),
			run: () => this._runCommand(COPY_RELATIVE_PATH_COMMAND_ID, resource),
		}));

		// ─── Group 4: rename / delete ────────────────────────────────
		actions.push(new Separator());
		if (this._canRename(element)) {
			actions.push(toAction({
				id: 'agentStudio.workspace.rename',
				label: localize('renameFile', "重命名"),
				run: () => this._startRename(element),
			}));
		}
		// Related-folder roots get a dedicated "remove association" action.
		// This only detaches the folder from the workspace metadata — it never
		// touches files on disk (unlike the regular delete below).
		if (element.isWorkspaceRoot && element.isRelatedFolder) {
			actions.push(toAction({
				id: 'agentStudio.workspace.removeRelatedFolder',
				label: localize('removeRelatedFolder', "移除关联仓库"),
				run: () => this._removeRelatedFolder(element),
			}));
		}
		// Allow deleting real files/dirs but not workspace roots (those are
		// detached via the workspace/related-folder management flow).
		if (!element.isWorkspaceRoot) {
			actions.push(toAction({
				id: 'agentStudio.workspace.delete',
				label: localize('deleteFile', "删除"),
				run: () => this._deleteElement(element),
			}));
		}

		return actions;
	}

	/**
	 * Execute a reused native command with the element's resource as argument,
	 * logging (but not throwing on) failures so a single missing command can't
	 * break the whole menu.
	 */
	private async _runCommand(commandId: string, resource: URI): Promise<void> {
		try {
			await this.commandService.executeCommand(commandId, resource);
		} catch (err) {
			this.logService.error(`[WorkspaceViewPane] Command "${commandId}" failed:`, err);
			this.notificationService.error(localize('commandFailed', "操作失败: {0}", (err as Error)?.message ?? String(err)));
		}
	}

	/**
	 * Delete a file/folder after explicit confirmation, moving it to the OS
	 * trash when supported (falling back to permanent delete otherwise), then
	 * refresh the parent folder so the entry disappears.
	 */
	private async _deleteElement(element: IWorkspaceExplorerElement): Promise<void> {
		const resource = element.resource;
		const useTrash = this.configurationService.getValue<boolean>('files.enableTrash') !== false;

		const confirmed = await this.dialogService.confirm({
			type: 'warning',
			message: useTrash
				? localize('confirmMoveTrash', "确定要将 \"{0}\" 移到回收站吗？", element.name)
				: localize('confirmDelete', "确定要永久删除 \"{0}\" 吗？", element.name),
			detail: useTrash
				? localize('confirmMoveTrashDetail', "你可以从回收站还原此项。")
				: localize('confirmDeleteDetail', "此操作不可撤销。"),
			primaryButton: useTrash
				? localize('moveToTrashButton', "移到回收站")
				: localize('deleteButton', "删除"),
		});
		if (!confirmed.confirmed) {
			return;
		}

		try {
			await this.workingCopyFileService.delete(
				[{ resource, useTrash, recursive: true }],
				CancellationToken.None,
			);
			this.logService.info(`[WorkspaceViewPane] Deleted "${resource.toString()}" (trash=${useTrash})`);
			await this._refreshParentOf(element);
		} catch (err) {
			this.logService.error('[WorkspaceViewPane] Delete failed:', err);
			this.notificationService.error(localize('deleteError', "删除失败: {0}", (err as Error)?.message ?? String(err)));
		}
	}

	/**
	 * Detach a related folder (an additional code repository) from its
	 * workspace after explicit confirmation. This only edits workspace
	 * metadata via {@link IAgentStudioService.removeRelatedFolder}; the folder
	 * and its files on disk are left untouched.
	 */

	/**
	 * 解析 .code-workspace 文件，将其中所有工作区目录关联入库。
	 * 已在库中的目录自动跳过（去重）。
	 */
	private async _importCodeWorkspaceToKb(uri: URI): Promise<void> {
		try {
			const content = await this.fileService.readFile(uri);
			const text = content.value.toString();
			const parsed = JSON.parse(text);

			const folders: { path: string; name?: string }[] = parsed.folders;
			if (!Array.isArray(folders) || folders.length === 0) {
				this.notificationService.warn('.code-workspace 文件中没有 folders 配置');
				return;
			}

			// 读取当前活动 Vault 的 linkedFolders
			const STORAGE_VAULTS = 'agentStudio.kb.vaults';
			const STORAGE_ACTIVE = 'agentStudio.kb.active';
			const raw = this.storageService.get(STORAGE_VAULTS, StorageScope.APPLICATION);
			const vaults: IKbVault[] = raw ? JSON.parse(raw) : [];
			const activeId = this.storageService.get(STORAGE_ACTIVE, StorageScope.APPLICATION);
			const activeVault = vaults.find(v => v.id === activeId && !v.closed) ?? vaults.find(v => !v.closed);

			if (!activeVault) {
				this.notificationService.warn('请先在知识库视图中创建或激活一个 Vault');
				return;
			}

			// 提取 codebase-memory 配置
			const cbmConfig = (parsed['codebase-memory'])
				|| (parsed.settings && parsed.settings['codebase-memory']);
			if (cbmConfig && typeof cbmConfig === 'object') {
				const indexConfig: IIndexConfig = {
					mode: (cbmConfig.mode || 'fast') as IndexMode,
					excludeDirs: Array.isArray(cbmConfig.excludeDirs) ? cbmConfig.excludeDirs : [],
					keepDirs: Array.isArray(cbmConfig.keepDirs) ? cbmConfig.keepDirs : [],
					subPath: typeof cbmConfig.subPath === 'string' ? cbmConfig.subPath : undefined,
				};
				this._cbmService.setIndexConfig(indexConfig);
				this.logService.info(`[WorkspaceView] code-workspace import: saved CBM config (mode=${indexConfig.mode})`);
			}

			// 解析每个 folder 路径
			const wsDir = URI.joinPath(uri, '..').fsPath;
			const existingSet = new Set(activeVault.linkedFolders ?? []);
			let linkedCount = 0;
			let skippedCount = 0;

			for (const f of folders) {
				if (!f.path || typeof f.path !== 'string') { continue; }
				const isAbs = /^[A-Za-z]:[\\/]/.test(f.path) || f.path.startsWith('/');
				const folderPath = isAbs
					? URI.file(f.path).fsPath
					: URI.joinPath(URI.file(wsDir), f.path).fsPath;

				if (!existingSet.has(folderPath)) {
					existingSet.add(folderPath);
					linkedCount++;
				} else {
					skippedCount++;
				}
			}

			if (linkedCount === 0 && skippedCount > 0) {
				this.notificationService.info(`工作区目录已全部关联，无需重复导入（${skippedCount} 个目录）`);
				return;
			}

			// 持久化
			activeVault.linkedFolders = [...existingSet];
			this.storageService.store(STORAGE_VAULTS, JSON.stringify(vaults), StorageScope.APPLICATION, StorageTarget.MACHINE);

			const msg = linkedCount > 0
				? `已从 .code-workspace 关联 ${linkedCount} 个工作区目录到知识库${skippedCount > 0 ? `（${skippedCount} 个已存在跳过）` : ''}`
				: '工作区目录已全部关联';
			this.notificationService.info(msg);
		} catch (err) {
			const msg = String((err as any)?.message ?? err);
			this.notificationService.error(`导入 .code-workspace 失败：${msg}`);
		}
	}

	/**
	 * 工作区文件右键「导入到知识库」：读取文件内容 → 入口(落盘到库) + 抽取(构建笔记)。
	 * 与聊天框 write_file 卡片的「导入知识库」按钮共用同一份 KbImportController 管线。
	 */
	private async _importFileToKb(resource: URI): Promise<void> {
		try {
			if (!(await this.fileService.exists(resource))) {
				this.notificationService.warn(`文件不存在：${resource.fsPath}`);
				return;
			}
			const text = (await this.fileService.readFile(resource)).value.toString();
			const ok = await this._kbImport.importContentAndBuild(text, null, undefined, resource);
			if (ok) {
				this.notificationService.info(`已将「${basename(resource)}」导入知识库（入口+抽取）`);
			} else {
				this.notificationService.warn(`导入「${basename(resource)}」到知识库失败`);
			}
		} catch (err) {
			const msg = String((err as any)?.message ?? err);
			this.notificationService.error(`导入文件到知识库失败：${msg}`);
		}
	}

	/**
	 * Set/clear the `isIndexing` flag on root tree elements whose resource path
	 * matches the given workspace path.  Triggers a lightweight tree refresh via
	 * `rerender` so the ⏳ CSS class takes effect without losing expansion state.
	 */
	private _updateIndexingFlags(workspacePath: string, indexing: boolean): void {
		if (!this._workspaceRoots) { return; }
		const normalizedWs = this._normalizeFsPath(workspacePath);
		let changed = false;
		for (const root of this._workspaceRoots) {
			if (root.isInfoNode || root.isEmptyPlaceholder) { continue; }
			const rootPath = this._normalizeFsPath(root.resource.fsPath);
			// root 路径在 workspace 索引路径内 → 设置 isIndexing
			const isMatch = rootPath === normalizedWs
				|| rootPath.startsWith(normalizedWs + '/')
				|| normalizedWs.startsWith(rootPath + '/');
			if (isMatch && root.isIndexing !== indexing) {
				root.isIndexing = indexing;
				changed = true;
			}
		}
		if (changed && this.tree) {
			this.tree.rerender();
		}
	}

	/** 清除所有根元素的 isIndexing 标记（兜底）。 */
	private _clearAllIndexingFlags(): void {
		if (!this._workspaceRoots) { return; }
		let changed = false;
		for (const root of this._workspaceRoots) {
			if (root.isIndexing) {
				root.isIndexing = false;
				changed = true;
			}
		}
		if (changed && this.tree) {
			this.tree.rerender();
		}
	}

	private _normalizeFsPath(p: string): string {
		return p.replace(/\\/g, '/').replace(/\/$/, '');
	}

	/** 当前渲染的工作区根节点引用（_loadWorkspaceRoots 中赋值）。 */
	private _workspaceRoots: IWorkspaceExplorerElement[] | undefined;

	/**
	 * Detach a previously related folder from the workspace.  Only removes
	 * metadata via {@link IAgentStudioService.removeRelatedFolder}; the folder
	 * and its files on disk are left untouched.
	 */
	private async _removeRelatedFolder(element: IWorkspaceExplorerElement): Promise<void> {
		const workspaceId = element.workspaceId;
		if (!workspaceId) {
			this.logService.warn('[WorkspaceViewPane] removeRelatedFolder: element has no workspaceId');
			return;
		}
		const folderPath = element.resource.fsPath;

		const confirmed = await this.dialogService.confirm({
			type: 'warning',
			message: localize('confirmRemoveRelated', "确定要移除关联仓库 \"{0}\" 吗？", element.name),
			detail: localize('confirmRemoveRelatedDetail', "此操作仅解除该目录与工作区的关联，不会删除磁盘上的文件。"),
			primaryButton: localize('removeRelatedButton', "移除"),
		});
		if (!confirmed.confirmed) {
			return;
		}

		try {
			await this.agentStudioService.removeRelatedFolder(workspaceId, folderPath);
			this.logService.info(`[WorkspaceViewPane] Removed related folder "${folderPath}" from workspace ${workspaceId}`);
			this.notificationService.info(localize('removeRelatedDone', "已移除关联仓库: {0}", element.name));
			// onDidChangeActiveWorkspace will trigger a reload, but refresh
			// explicitly to be safe.
			await this._loadWorkspaceRoots();
		} catch (err) {
			this.logService.error('[WorkspaceViewPane] removeRelatedFolder failed:', err);
			this.notificationService.error(localize('removeRelatedError', "移除关联仓库失败: {0}", (err as Error)?.message ?? String(err)));
		}
	}

	/**
	 * Whether an element supports inline rename. We allow real files and
	 * directories inside a workspace, but exclude workspace roots (renaming a
	 * root would mean renaming the linked folder on disk, which belongs to the
	 * workspace/related-folder management flow), info/placeholder nodes, and
	 * virtual entries with no real filesystem resource.
	 */
	private _canRename(element: IWorkspaceExplorerElement): boolean {
		if (element.isWorkspaceRoot || element.isVirtualWorkspace) {
			return false;
		}
		if (element.isInfoNode || element.isEmptyPlaceholder) {
			return false;
		}
		return element.resource.scheme === 'file';
	}

	/**
	 * Returns the active rename editing state for an element, matched by
	 * resource. Consumed by the tree renderer to decide whether to draw an
	 * inline InputBox for that row.
	 */
	private _getEditableData(element: IWorkspaceExplorerElement): IEditableData | undefined {
		if (this.editableData && this.editableElementResource === element.resource.toString()) {
			return this.editableData;
		}
		return undefined;
	}

	/**
	 * Begin an inline rename of the given element: install the editing state,
	 * rerender the row (so the renderer swaps in an InputBox), and on finish
	 * perform the on-disk move via {@link IWorkingCopyFileService} (which also
	 * relocates any open editors and dirty working copies).
	 */
	private _startRename(element: IWorkspaceExplorerElement): void {
		const oldName = element.name;
		const parent = dirname(element.resource);

		this.editableElementResource = element.resource.toString();
		this.editableData = {
			startingValue: oldName,
			validationMessage: (value: string) => this._validateName(value, oldName),
			onFinish: async (value: string, success: boolean) => {
				// Tear down editing state first so the row re-renders as a label.
				this.editableData = undefined;
				this.editableElementResource = undefined;
				try {
					this.tree.rerender(element);
				} catch { /* element may already be gone */ }

				const newName = value.trim();
				if (!success || !newName || newName === oldName) {
					return;
				}

				const target = joinPath(parent, newName);
				try {
					await this.workingCopyFileService.move(
						[{ file: { source: element.resource, target } }],
						CancellationToken.None,
					);
					this.logService.info(`[WorkspaceViewPane] Renamed "${oldName}" → "${newName}"`);
					// Refresh the parent folder so the renamed entry re-sorts in place.
					await this._refreshParentOf(element);
				} catch (err) {
					this.logService.error('[WorkspaceViewPane] Rename failed:', err);
					this.notificationService.error(localize('renameError', "重命名失败: {0}", (err as Error)?.message ?? String(err)));
				}
			},
		};

		// Rerender so the renderer picks up the new editable state for this row.
		try {
			this.tree.rerender(element);
		} catch (err) {
			this.logService.warn('[WorkspaceViewPane] Failed to rerender for rename:', err);
		}
	}

	/**
	 * Validate a candidate file name. Mirrors the basic checks VS Code's
	 * Explorer applies: non-empty, no path separators, no leading/trailing
	 * whitespace or dots, and not colliding with a sibling (other than itself).
	 */
	private _validateName(value: string, originalName: string): { content: string; severity: Severity } | null {
		const trimmed = value;
		if (!trimmed) {
			return { content: localize('emptyName', "名称不能为空。"), severity: Severity.Error };
		}
		if (/[\\/]/.test(trimmed)) {
			return { content: localize('slashName', "名称不能包含路径分隔符 (/ 或 \\)。"), severity: Severity.Error };
		}
		if (trimmed !== trimmed.trim()) {
			return { content: localize('whitespaceName', "名称首尾不能包含空格。"), severity: Severity.Error };
		}
		if (/^\.+$/.test(trimmed)) {
			return { content: localize('dotName', "名称无效。"), severity: Severity.Error };
		}
		// Same name (case included) → no-op, allow Enter to simply cancel.
		if (trimmed === originalName) {
			return null;
		}
		return null;
	}

	/**
	 * Reload the children of the renamed/deleted element's parent so the new
	 * name and sort order appear. v28: switched from a full reload (which
	 * tore down the entire tree, recreated watchers and expanded every root
	 * again — overkill for a single rename/delete) to a local
	 * `tree.updateChildren` on the parent node. This preserves expansion
	 * state across the rest of the tree and is what the native Explorer
	 * does.
	 *
	 * If the parent is the workspace root itself, that root is a workspace
	 * root element whose children are fetched on demand — so we refresh it
	 * directly. If the parent isn't in the visible tree yet (e.g. some
	 * intermediate folder is collapsed), fall back to refreshing the
	 * nearest ancestor that IS in the tree so the cascade re-renders when
	 * the user expands it.
	 */
	private async _refreshParentOf(element: IWorkspaceExplorerElement): Promise<void> {
		if (!this.tree) {
			return;
		}

		const parentUri = dirname(element.resource);
		// Walk from `parentUri` upward until we find a node that's already in
		// the visible tree, then refresh it. Most cases land on the first
		// iteration (the immediate parent is visible).
		const visited: URI[] = [];
		let cursor: URI | undefined = parentUri;
		let targetNode: IWorkspaceExplorerElement | undefined;
		while (cursor) {
			visited.push(cursor);
			// Look up the matching workspace-explorer element by resource.
			// We compare against watched roots first (cheapest), then walk
			// up the path looking for a known element.
			const rootMatch = this._watchedRoots.find(r => r.resource.toString() === cursor!.toString());
			if (rootMatch && this.tree.hasNode(rootMatch)) {
				targetNode = rootMatch;
				break;
			}
			// Step up one level — parent of a parent.
			cursor = dirname(cursor);
		}

		if (!targetNode) {
			// Nothing in the tree maps to this path — fall back to a full
			// reload (rare; only happens if the element lives outside any
			// currently-watched root).
			this.logService.warn('[WorkspaceViewPane] _refreshParentOf: no tree node for parent, falling back to full reload');
			await this._loadWorkspaceRoots();
			return;
		}

		try {
			await this.tree.updateChildren(targetNode, /* recursive */ false, /* rerender */ true);
			this.logService.info(`[WorkspaceViewPane] _refreshParentOf: refreshed subtree of "${targetNode.name}" after mutation`);
		} catch (err) {
			this.logService.warn(`[WorkspaceViewPane] _refreshParentOf failed for "${targetNode.name}":`, err);
		}
	}

	/**
	 * (Re)install recursive filesystem watchers for the given real workspace
	 * roots. Clears any previous watchers first so we never leak handles or
	 * watch a stale workspace's directories. Only real (scheme === 'file')
	 * roots are watched — virtual roots have no backing directory.
	 */
	private _installRootWatchers(roots: IWorkspaceExplorerElement[]): void {
		// Drop previous watchers and pending work for the old root set.
		this._fsWatchers.clear();
		this._pendingRefreshRoots.clear();
		if (this._fsRefreshTimer !== undefined) {
			clearTimeout(this._fsRefreshTimer);
			this._fsRefreshTimer = undefined;
		}
		// v28: reset the reentrancy guard so a leftover `true` from an
		// interrupted refresh doesn't permanently block file-watcher events
		// after the root set is rebuilt.
		this._isRefreshing = false;

		const realRoots = roots.filter(r => !r.isVirtualWorkspace && r.resource.scheme === 'file');
		this._watchedRoots = realRoots;

		for (const root of realRoots) {
			try {
				// Recursive watch so nested creates/deletes (any depth) surface.
				// v28: explicitly exclude high-noise directories that the native
				// Explorer also skips via `files.watcherExclude` defaults.
				// Without these, every `npm install` / `git fetch` /
				// editor temp-save floods onDidFilesChange, which fans into a
				// busy-loop where each refresh's fileService.resolve() emits
				// its own event that triggers another refresh. The patterns
				// are absolute globs matching at any depth inside the root.
				const excludes: string[] = [
					'**/.git/**',
					'**/node_modules/**',
					'**/.svn/**',
					'**/.hg/**',
					'**/CVS/**',
					'**/.DS_Store',
					'**/Thumbs.db',
					// VS Code's own tmp folder (in case any tool writes there).
					'**/.vscode/**/.tmp/**',
				];
				this._fsWatchers.add(this.fileService.watch(root.resource, { recursive: true, excludes }));
			} catch (err) {
				this.logService.warn(`[WorkspaceViewPane] Failed to watch root "${root.resource.toString()}":`, err);
			}
		}
	}

	/**
	 * React to on-disk file changes. Determine which watched root subtrees are
	 * affected and schedule a debounced, scoped refresh of just those subtrees
	 * (preserving expansion/selection state, like the native Explorer).
	 *
	 * v28 reentrancy guard: if a refresh is already in flight (or queued), we
	 * still update `_pendingRefreshRoots` so the next debounce tick covers
	 * any newly-arrived changes, but we do NOT schedule an additional refresh
	 * alongside the one that's already running. Without this guard, a refresh
	 * can fan out into itself because `fileService.resolve()` emits its own
	 * `onDidFilesChange` event, which would otherwise schedule another
	 * refresh on every nested resolution → busy loop. The flag is cleared at
	 * the end of `_flushPendingRefresh` so the next event starts a fresh
	 * cycle.
	 */
	private _onDidFilesChange(e: FileChangesEvent): void {
		if (this._watchedRoots.length === 0) {
			return;
		}

		let matched = false;
		for (const root of this._watchedRoots) {
			// affects() matches the root itself or any descendant change.
			if (e.affects(root.resource)) {
				this._pendingRefreshRoots.add(root);
				matched = true;
			}
		}
		if (!matched) {
			return;
		}

		// v28: if a refresh is already running, don't pile on — the next
		// debounce tick will pick up the latest `_pendingRefreshRoots` once
		// the in-flight refresh finishes. This is the core anti-self-excite
		// guard that breaks the busy loop.
		if (this._isRefreshing) {
			return;
		}

		// v27: throttle (not just debounce) the file-change refresh. The
		// 300ms debounce alone was insufficient — when an AI tool runs a
		// command that touches many files (or a parent render loop fires
		// file events indirectly via the fileService), the watcher emits
		// events faster than the tree can resolve children, causing a
		// busy-loop where `updateChildren` is invoked ~once per second and
		// floods the log. Coalesce all events within a 2s window into a
		// single refresh. The user-visible cost is at most a 2s lag
		// before new files appear, which is acceptable for a workspace
		// explorer. Also rate-limit to at most one refresh per 1500ms
		// even if events keep arriving (the "throttle" half).
		const now = Date.now();
		const timeSinceLastRefresh = now - this._lastFsRefreshAt;
		const fsRefreshCooldownMs = 1500;
		if (this._fsRefreshTimer !== undefined) {
			clearTimeout(this._fsRefreshTimer);
		}
		if (timeSinceLastRefresh >= fsRefreshCooldownMs) {
			// Outside the cooldown — fire as soon as the debounce window closes
			this._fsRefreshTimer = setTimeout(() => {
				this._fsRefreshTimer = undefined;
				this._lastFsRefreshAt = Date.now();
				void this._flushPendingRefresh();
			}, 300);
		} else {
			// Inside the cooldown — defer to the end of the cooldown window
			const deferMs = fsRefreshCooldownMs - timeSinceLastRefresh;
			this._fsRefreshTimer = setTimeout(() => {
				this._fsRefreshTimer = undefined;
				this._lastFsRefreshAt = Date.now();
				void this._flushPendingRefresh();
			}, deferMs);
		}
	}

	/**
	 * Refresh the subtrees accumulated since the last debounce tick. Uses
	 * updateChildren(root, recursive, rerender) which re-resolves children via
	 * the data source while preserving the tree's expansion and selection
	 * state — so a newly created file simply appears in place.
	 *
	 * v28 reentrancy: the `_isRefreshing` flag is set on entry and cleared in
	 * `finally`, so any `onDidFilesChange` events emitted by the in-flight
	 * `fileService.resolve()` call (which the underlying watcher broadcasts
	 * synchronously per resolved directory) are absorbed by `_onDidFilesChange`
	 * without scheduling a parallel refresh. The events still mutate
	 * `_pendingRefreshRoots`, so the next tick after this completes will
	 * re-refresh the right subtrees if needed.
	 */
	private async _flushPendingRefresh(): Promise<void> {
		if (!this.tree) {
			return;
		}
		if (this._isRefreshing) {
			// Defensive: should be unreachable because _onDidFilesChange guards
			// against this, but keep the check so a stray caller can't break
			// the invariant.
			return;
		}
		this._isRefreshing = true;
		try {
			const roots = Array.from(this._pendingRefreshRoots);
			this._pendingRefreshRoots.clear();

			for (const root of roots) {
				// The node may have been removed by a concurrent reload — guard it.
				if (!this.tree.hasNode(root)) {
					continue;
				}
				try {
					await this.tree.updateChildren(root, /* recursive */ true, /* rerender */ false);
					this.logService.trace(`[WorkspaceViewPane] Refreshed subtree after fs change: ${root.name}`);
				} catch (err) {
					this.logService.warn(`[WorkspaceViewPane] Failed to refresh subtree "${root.name}" after fs change:`, err);
				}
			}
		} finally {
			this._isRefreshing = false;
		}
	}

	private async _loadWorkspaceRoots(): Promise<void> {
		this.logService.info('[WorkspaceViewPane] Loading workspace roots');
		this.wsProgressBar.infinite().show(100);

		try {
			const workspaces: Workspace[] = await this.agentStudioService.getWorkspaces();
			this.logService.info(`[WorkspaceViewPane] Loaded ${workspaces.length} workspaces`);

			// Refresh the selector dropdown with the latest workspace list.
			this._refreshWorkspaceSelector(workspaces, this.agentStudioService.getActiveWorkspaceId());

			if (workspaces.length === 0) {
				// Show empty state
				this.treeContainer.style.display = 'none';
				this.emptyStateContainer.style.display = 'flex';
				this.wsProgressBar.stop().hide();
				return;
			}

			// ─── Resolve the ACTIVE workspace ─────────────────────────
			// The tree only ever renders ONE workspace — the active one.
			// Fall back to the first workspace when no active id is set yet.
			const activeId = this.agentStudioService.getActiveWorkspaceId();
			const activeWs = (activeId ? workspaces.find(w => w.id === activeId) : undefined) ?? workspaces[0];
			this.logService.info(`[WorkspaceViewPane] Active workspace: "${activeWs.name}" id=${activeWs.id} path=${activeWs.path} relatedFolders=${(activeWs.relatedFolders ?? []).length}`);

			this.treeContainer.style.display = 'block';
			this.emptyStateContainer.style.display = 'none';

			// Resolve files.exclude patterns for this workspace:
			// 1. Use stored ws.filesExclude if available
			// 2. Otherwise, scan the workspace path directory for .code-workspace
			//    files and read settings.files.exclude from them
			const excludePatterns = await this._resolveExcludePatterns(activeWs);
			if (excludePatterns && excludePatterns.length > 0) {
				this.logService.info(`[WorkspaceViewPane] Exclude patterns: ${excludePatterns.join(', ')}`);
			}

			// Build root nodes for the active workspace:
			//   1. The workspace's primary home directory (`path`)
			//   2. Each related folder (linked code repository)
			const workspaceRoots: IWorkspaceExplorerElement[] = [];

			// ── 1. Primary home directory root ──
			if (activeWs.path) {
				const homeRoot = await this._buildRealOrVirtualRoot(activeWs, activeWs.path, activeWs.name, false, false, excludePatterns);
				workspaceRoots.push(homeRoot);
			} else {
				// No home directory — render as a virtual workspace root
				workspaceRoots.push(this._buildVirtualRoot(activeWs));
			}

			// ── 2. Related folder roots (linked repositories) ──
			for (const rf of activeWs.relatedFolders ?? []) {
				if (!rf?.path) {
					continue;
				}
				const rfName = rf.name || this._basename(rf.path);
				const rfRoot = await this._buildRealOrVirtualRoot(activeWs, rf.path, rfName, true, !!rf.isGitRepo, excludePatterns);
				workspaceRoots.push(rfRoot);
			}

			if (workspaceRoots.length === 0) {
				this.logService.warn('[WorkspaceViewPane] No valid workspace roots found');
				this.treeContainer.style.display = 'none';
				this.emptyStateContainer.style.display = 'flex';
				this._workspaceRoots = undefined;
				this.wsProgressBar.stop().hide();
				return;
			}

			this.logService.info(`[WorkspaceViewPane] Building tree with ${workspaceRoots.length} roots for active workspace`);
			// 保存根节点引用供索引进度指示器使用
			this._workspaceRoots = workspaceRoots;

			// Always use a hidden virtual root as tree input.
			// The tree's input node itself is never rendered by AsyncDataTree,
			// so workspace root nodes become the first visible layer — just
			// like VS Code's native Explorer shows workspace folder names.
			const virtualRoot: IWorkspaceExplorerElement = {
				resource: URI.from({ scheme: 'agent-studio-workspace', authority: 'root', path: '/' }),
				name: 'Workspaces',
				isDirectory: true,
				children: workspaceRoots,
			};

			await this.tree.setInput(virtualRoot);
			this.logService.info('[WorkspaceViewPane] setInput completed for virtual root');

			// (Re)install recursive filesystem watchers for the real roots so
			// on-disk changes (file create/delete by AI tools, terminal, etc.)
			// trigger an automatic tree refresh.
			this._installRootWatchers(workspaceRoots);

			// Auto-expand each workspace root so users see the file tree immediately
			for (const root of workspaceRoots) {
				try {
					await this.tree.expand(root);
					this.logService.info(`[WorkspaceViewPane] expanded workspace root: ${root.name}`);
				} catch {
					this.logService.warn(`[WorkspaceViewPane] Failed to expand workspace root: ${root.name}`);
				}
			}
		} catch (err) {
			this.logService.error('[WorkspaceViewPane] Error loading workspace roots:', err);
			this.treeContainer.style.display = 'none';
			this.emptyStateContainer.style.display = 'flex';
			const emptyMessage = this.emptyStateContainer.querySelector('.workspace-explorer-empty-message');
			if (emptyMessage) {
				emptyMessage.textContent = localize('workspaceLoadError', "Failed to load workspaces.");
			}
		} finally {
			this.wsProgressBar.stop().hide();
		}
	}

	/**
	 * Resolve files.exclude patterns for a workspace:
	 * 1. Use stored ws.filesExclude if available
	 * 2. Otherwise, scan the workspace path directory for .code-workspace
	 *    files and read settings.files.exclude from ALL of them (merged).
	 * Returns an array of glob pattern strings (only enabled entries).
	 */
	private async _resolveExcludePatterns(ws: Workspace): Promise<string[] | undefined> {
		// 1. Use stored filesExclude on the workspace object
		if (ws.filesExclude) {
			const patterns = Object.entries(ws.filesExclude)
				.filter(([, v]) => v === true)
				.map(([k]) => k);
			if (patterns.length > 0) {
				this.logService.info(`[WorkspaceViewPane] Exclude patterns from stored filesExclude: ${patterns.join(', ')}`);
				return patterns;
			}
		}

		// 2. Scan workspace path directory for .code-workspace files
		if (!ws.path) { return undefined; }
		try {
			const dirUri = URI.file(ws.path);
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children || stat.children.length === 0) {
				this.logService.info(`[WorkspaceViewPane] _resolveExcludePatterns: no children in "${ws.path}"`);
				return undefined;
			}

			// Find ALL .code-workspace files in the directory
			const wsFiles = stat.children.filter(c =>
				!c.isDirectory && c.name.toLowerCase().endsWith('.code-workspace')
			);
			if (wsFiles.length === 0) {
				this.logService.info(`[WorkspaceViewPane] _resolveExcludePatterns: no .code-workspace files in "${ws.path}"`);
				return undefined;
			}

			this.logService.info(`[WorkspaceViewPane] _resolveExcludePatterns: found ${wsFiles.length} .code-workspace file(s): ${wsFiles.map(f => f.name).join(', ')}`);

			// Read ALL .code-workspace files and merge their files.exclude settings
			const mergedExclude: Record<string, boolean> = {};
			for (const wsFile of wsFiles) {
				try {
					const content = await this.fileService.readFile(wsFile.resource);
					const parsed = JSON.parse(content.value.toString());
					const filesExclude: Record<string, boolean> | undefined = parsed?.settings?.['files.exclude'];
					if (filesExclude) {
						this.logService.info(`[WorkspaceViewPane] _resolveExcludePatterns: "${wsFile.name}" has files.exclude: ${JSON.stringify(filesExclude)}`);
						Object.assign(mergedExclude, filesExclude);
					}
				} catch { /* read/parse failed for this file — skip */ }
			}

			const patterns = Object.entries(mergedExclude)
				.filter(([, v]) => v === true)
				.map(([k]) => k);

			if (patterns.length === 0) {
				this.logService.info(`[WorkspaceViewPane] _resolveExcludePatterns: no enabled files.exclude patterns found`);
				return undefined;
			}

			// Persist to the workspace so subsequent loads don't need to re-read
			try {
				await this.agentStudioService.updateWorkspace(ws.id, { filesExclude: mergedExclude });
			} catch { /* non-fatal */ }

			return patterns;
		} catch (err) {
			this.logService.warn(`[WorkspaceViewPane] _resolveExcludePatterns failed:`, err);
			return undefined;
		}
	}

	/**
	 * Build a root tree node for a directory path. If the path exists as a
	 * directory the node becomes a real filesystem root (children resolved
	 * lazily via IFileService); otherwise it falls back to a virtual root
	 * showing a "path missing" info child.
	 */
	private async _buildRealOrVirtualRoot(ws: Workspace, path: string, name: string, isRelatedFolder: boolean, isGitRepo: boolean, excludePatterns?: string[]): Promise<IWorkspaceExplorerElement> {
		const uri = URI.file(path);

		let pathExists = false;
		try {
			const stat = await this.fileService.stat(uri);
			pathExists = stat.isDirectory;
		} catch (statErr) {
			this.logService.warn(`[WorkspaceViewPane] path="${path}" does not exist or cannot be accessed: ${statErr}`);
		}

		if (pathExists) {
			return {
				resource: uri,
				name,
				isDirectory: true,
				isWorkspaceRoot: true,
				workspaceId: ws.id,
				isRelatedFolder,
				isGitRepo,
				excludePatterns,
			};
		}

		// Path missing — render a virtual root with an error info child
		const infoUri = URI.from({ scheme: 'agent-studio-workspace', authority: `${ws.id}:${name}`, path: '/' });
		const infoChildren: IWorkspaceExplorerElement[] = [{
			resource: URI.joinPath(infoUri, 'path-missing'),
			name: localize('pathMissing', "Path not found: {0}", path),
			isDirectory: false,
			isInfoNode: true,
		}];
		return {
			resource: infoUri,
			name,
			isDirectory: true,
			isWorkspaceRoot: true,
			isVirtualWorkspace: true,
			workspaceId: ws.id,
			isRelatedFolder,
			isGitRepo,
			excludePatterns,
			children: infoChildren,
		};
	}

	/**
	 * Build a virtual root node for a workspace with no home directory,
	 * showing metadata (description, created date) as info children.
	 */
	private _buildVirtualRoot(ws: Workspace): IWorkspaceExplorerElement {
		const infoUri = URI.from({ scheme: 'agent-studio-workspace', authority: ws.id, path: '/' });
		const infoChildren: IWorkspaceExplorerElement[] = [];
		if (ws.description) {
			infoChildren.push({
				resource: URI.joinPath(infoUri, 'description'),
				name: ws.description,
				isDirectory: false,
				isInfoNode: true,
			});
		}
		infoChildren.push({
			resource: URI.joinPath(infoUri, 'created'),
			name: localize('workspaceCreated', "Created: {0}", new Date(ws.createdAt).toLocaleDateString()),
			isDirectory: false,
			isInfoNode: true,
		});
		infoChildren.push({
			resource: URI.joinPath(infoUri, 'no-folder'),
			name: localize('noFolderLinked', "No folder linked"),
			isDirectory: false,
			isInfoNode: true,
		});
		return {
			resource: infoUri,
			name: ws.name,
			isDirectory: true,
			isWorkspaceRoot: true,
			isVirtualWorkspace: true,
			workspaceId: ws.id,
			description: ws.description,
			children: infoChildren,
		};
	}

	/** Extract the last path segment from a filesystem path (cross-platform). */
	private _basename(path: string): string {
		const normalized = path.replace(/[\\/]+$/, '');
		const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
		return idx >= 0 ? normalized.slice(idx + 1) : normalized;
	}

	/**
	 * Create a brand-new workspace. Bound to the "+" button in the view title
	 * bar (see CREATE_WORKSPACE_COMMAND_ID). This is distinct from
	 * {@link showAddRelatedFolder}, which links an extra code repository into
	 * an *existing* workspace — that action remains available via the inline
	 * "+" button on each workspace-root row.
	 *
	 * Flow: open a custom create dialog (name + path fields, the path field
	 * has a "Browse..." button driving the OS folder picker) → on confirm,
	 * create the workspace → switch the active workspace so sandbox/SCM/tree/
	 * canvas all follow. Mirrors the toolbar's `_submitCreate` semantics.
	 */
	async showCreateWorkspace(): Promise<void> {
		const result = await this._promptCreateWorkspace();
		if (!result) {
			return; // Cancelled.
		}
		const { name, homeUri } = result;

		// The chosen directory may be empty OR already contain files (e.g. an
		// existing code repository the user wants to adopt as the home dir).
		// Both are allowed — we only surface an informational confirm so the
		// user knows workspace metadata (.sarosworkspace) will be written
		// alongside any existing content. This is NOT a hard requirement.
		try {
			const stat = await this.fileService.resolve(homeUri);
			const nonEmpty = stat.isDirectory && !!stat.children && stat.children.length > 0;
			if (nonEmpty) {
				const confirmed = await this.dialogService.confirm({
					type: 'info',
					message: localize('createWorkspaceNonEmpty', "所选文件夹已包含文件"),
					detail: localize('createWorkspaceNonEmptyDetail', "工作区元数据（.sarosworkspace）将写入该文件夹，与已有文件共存（不会删除或修改它们）。空文件夹和非空文件夹都可以作为工作区主目录。是否继续？"),
					primaryButton: localize('createWorkspaceContinue', "继续"),
				});
				if (!confirmed.confirmed) {
					return;
				}
			}
		} catch {
			// Non-existent / unresolvable dir counts as empty — proceed.
		}

		// Create the workspace and switch to it.
		try {
			const newWorkspace = await this.agentStudioService.createWorkspace({
				name,
				path: homeUri.fsPath || homeUri.path,
				relatedFolders: [],
			});
			this.logService.info(`[WorkspaceViewPane] Created workspace "${newWorkspace.name}" (${newWorkspace.id})`);
			await this.agentStudioService.setActiveWorkspace(newWorkspace.id);
			this.notificationService.info(localize('createWorkspaceDone', "已创建工作区: {0}", newWorkspace.name));
			await this._loadWorkspaceRoots();
		} catch (err) {
			this.logService.error('[WorkspaceViewPane] createWorkspace failed:', err);
			this.notificationService.error(localize('createWorkspaceError', "创建工作区失败: {0}", (err as Error)?.message ?? String(err)));
		}
	}

	/**
	 * Show a custom modal dialog to collect the new workspace's name and home
	 * path. The path field is read-only-ish (still editable by typing) and is
	 * primarily driven by a "浏览..." button that opens the OS folder picker.
	 * Picking a folder auto-fills the name field when it is still empty.
	 *
	 * Resolves with `{ name, homeUri }` on confirm, or `undefined` if the user
	 * cancels (Esc / overlay click / cancel button).
	 */
	private _promptCreateWorkspace(): Promise<{ name: string; homeUri: URI } | undefined> {
		return new Promise(resolve => {
			const disposables = new DisposableStore();
			let settled = false;
			let selectedUri: URI | undefined;

			const finish = (value: { name: string; homeUri: URI } | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				overlay.remove();
				disposables.dispose();
				resolve(value);
			};

			// ─── Overlay + dialog shell ──────────────────────────────────
			const overlay = DOM.append(this.element, DOM.$('.workspace-create-overlay'));
			const dialog = DOM.append(overlay, DOM.$('.workspace-create-dialog'));

			const titleEl = DOM.append(dialog, DOM.$('.workspace-create-title'));
			titleEl.textContent = localize('createWorkspaceTitle', "创建工作区");

			// ─── Name field ──────────────────────────────────────────────
			const nameField = DOM.append(dialog, DOM.$('.workspace-create-field'));
			const nameLabel = DOM.append(nameField, DOM.$('label.workspace-create-label'));
			nameLabel.textContent = localize('createWorkspaceNameLabel', "名称");
			const nameInput = DOM.append(nameField, DOM.$('input.workspace-create-input')) as HTMLInputElement;
			nameInput.type = 'text';
			nameInput.placeholder = localize('createWorkspaceNamePlaceholder', "输入工作区名称");
			nameInput.spellcheck = false;

			// ─── Path field (input + browse button) ──────────────────────
			const pathField = DOM.append(dialog, DOM.$('.workspace-create-field'));
			const pathLabel = DOM.append(pathField, DOM.$('label.workspace-create-label'));
			pathLabel.textContent = localize('createWorkspacePathLabel', "路径");
			const pathRow = DOM.append(pathField, DOM.$('.workspace-create-path-row'));
			const pathInput = DOM.append(pathRow, DOM.$('input.workspace-create-input.workspace-create-path-input')) as HTMLInputElement;
			pathInput.type = 'text';
			pathInput.placeholder = localize('createWorkspacePathPlaceholder', "选择或输入工作区主目录");
			pathInput.spellcheck = false;

			const browseButton = disposables.add(new Button(pathRow, {
				...defaultButtonStyles,
				title: localize('createWorkspaceBrowse', "浏览..."),
			}));
			browseButton.label = localize('createWorkspaceBrowse', "浏览...");
			browseButton.element.classList.add('workspace-create-browse');

			// ─── Error / hint line ───────────────────────────────────────
			const errorEl = DOM.append(dialog, DOM.$('.workspace-create-error'));
			errorEl.style.visibility = 'hidden';
			errorEl.textContent = ' ';

			// ─── Footer buttons ──────────────────────────────────────────
			const footer = DOM.append(dialog, DOM.$('.workspace-create-footer'));
			const cancelButton = disposables.add(new Button(footer, {
				...defaultButtonStyles,
				secondary: true,
			}));
			cancelButton.label = localize('createWorkspaceCancel', "取消");
			const createButton = disposables.add(new Button(footer, {
				...defaultButtonStyles,
			}));
			createButton.label = localize('createWorkspaceConfirm', "创建");
			// Disabled by default: a workspace cannot be created without a name
			// AND a (non-empty) folder path.
			createButton.enabled = false;

			// ─── Behaviour ───────────────────────────────────────────────
			const showError = (msg: string) => {
				errorEl.textContent = msg;
				errorEl.style.visibility = 'visible';
			};
			const clearError = () => {
				errorEl.style.visibility = 'hidden';
			};
			// The "创建" button stays disabled until BOTH a name and a folder
			// path are present — enforcing that the workspace home directory
			// can never be empty.
			const updateValidity = () => {
				const hasName = nameInput.value.trim().length > 0;
				const hasPath = pathInput.value.trim().length > 0;
				createButton.enabled = hasName && hasPath;
			};

			disposables.add(browseButton.onDidClick(async () => {
				const picked = await this.fileDialogService.showOpenDialog({
					title: localize('createWorkspaceFolderTitle', "选择工作区主目录（空文件夹或已有代码库均可）"),
					canSelectFolders: true,
					canSelectFiles: false,
					canSelectMany: false,
				});
				if (picked && picked.length > 0) {
					selectedUri = picked[0];
					pathInput.value = selectedUri.fsPath || selectedUri.path;
					clearError();
					// Auto-fill name from folder name when name is still empty.
					if (!nameInput.value.trim()) {
						nameInput.value = basename(selectedUri);
					}
					updateValidity();
					nameInput.focus();
				}
			}));

			// If the user types a path manually, drop the cached picked URI so
			// the typed value wins (resolved to a file URI on submit).
			disposables.add(DOM.addDisposableListener(pathInput, 'input', () => {
				selectedUri = undefined;
				clearError();
				updateValidity();
			}));
			disposables.add(DOM.addDisposableListener(nameInput, 'input', () => {
				clearError();
				updateValidity();
			}));

			const submit = () => {
				const name = nameInput.value.trim();
				const pathText = pathInput.value.trim();
				if (!name) {
					showError(localize('createWorkspaceNameRequired', "工作区名称不能为空"));
					nameInput.focus();
					return;
				}
				if (!pathText) {
					showError(localize('createWorkspacePathRequired', "文件夹路径不能为空，请选择或输入工作区主目录"));
					pathInput.focus();
					return;
				}
				// Prefer the URI from the folder picker; otherwise build one
				// from the manually typed filesystem path.
				const homeUri = selectedUri ?? URI.file(pathText);
				finish({ name, homeUri });
			};

			disposables.add(createButton.onDidClick(() => submit()));
			disposables.add(cancelButton.onDidClick(() => finish(undefined)));

			// Keyboard: Enter submits, Esc cancels.
			disposables.add(DOM.addDisposableListener(dialog, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
				const event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.Enter)) {
					event.preventDefault();
					submit();
				} else if (event.equals(KeyCode.Escape)) {
					event.preventDefault();
					finish(undefined);
				}
			}));
			// Click outside the dialog (on the overlay) cancels.
			disposables.add(DOM.addDisposableListener(overlay, DOM.EventType.MOUSE_DOWN, (e: MouseEvent) => {
				if (e.target === overlay) {
					finish(undefined);
				}
			}));

			nameInput.focus();
		});
	}

	/**
	 * Prompt the user to pick a folder and link it as a *related folder*
	 * (an additional code repository) of a workspace.
	 *
	 * @param targetWorkspaceId When provided (e.g. from the inline "+" on a
	 * specific workspace root row), the folder is linked to that workspace.
	 * Otherwise it falls back to the currently active workspace.
	 */
	async showAddRelatedFolder(targetWorkspaceId?: string): Promise<void> {
		// Resolve the target workspace: explicit id first, then active, then first.
		let targetWs: Workspace | undefined;
		try {
			const workspaces = await this.agentStudioService.getWorkspaces();
			if (workspaces.length === 0) {
				this.notificationService.warn(localize('addRelatedNoWorkspace', "请先创建一个工作区，再添加关联仓库。"));
				return;
			}
			if (targetWorkspaceId) {
				targetWs = workspaces.find(w => w.id === targetWorkspaceId);
			}
			if (!targetWs) {
				const activeId = this.agentStudioService.getActiveWorkspaceId();
				targetWs = (activeId ? workspaces.find(w => w.id === activeId) : undefined) ?? workspaces[0];
			}
		} catch (err) {
			this.logService.error('[WorkspaceViewPane] Failed to resolve target workspace for addRelatedFolder:', err);
			return;
		}
		if (!targetWs) {
			return;
		}

		// Pick a folder
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('addRelatedFolderTitle', "选择要关联的代码仓库目录"),
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
		});
		if (!picked || picked.length === 0) {
			return;
		}
		const folderUri = picked[0];
		const folderPath = folderUri.fsPath;

		// Guard against duplicates and against linking the workspace's own home dir
		if (targetWs.path && this._samePath(targetWs.path, folderPath)) {
			this.notificationService.warn(localize('addRelatedIsHome', "该目录已是工作区主目录，无需重复添加。"));
			return;
		}
		if ((targetWs.relatedFolders ?? []).some(rf => this._samePath(rf.path, folderPath))) {
			this.notificationService.info(localize('addRelatedDuplicate', "该目录已关联到当前工作区。"));
			return;
		}

		try {
			await this.agentStudioService.addRelatedFolder(targetWs.id, folderPath);
			this.notificationService.info(localize('addRelatedDone', "已关联仓库: {0}", this._basename(folderPath)));
			// onDidChangeWorkspace will trigger _loadWorkspaceRoots automatically,
			// but reload explicitly to be safe.
			await this._loadWorkspaceRoots();
		} catch (err) {
			this.logService.error('[WorkspaceViewPane] addRelatedFolder failed:', err);
			this.notificationService.error(localize('addRelatedError', "关联仓库失败: {0}", (err as Error)?.message ?? String(err)));
		}
	}

	/** Case-insensitive path equality with trailing-separator normalization. */
	private _samePath(a: string, b: string): boolean {
		const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
		return norm(a) === norm(b);
	}

	override focus(): void {
		super.focus();
		if (this.tree) {
			this.tree.domFocus();
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		// NOTE: Do NOT hard-set container widths via inline styles here.
		// The visible content width is governed by the sidebar CSS grid (the
		// icon strip occupies a separate 48px column), and SidebarPart.layout
		// already subtracts the icon-strip width before propagating `width` down
		// this chain. The containers use `width: 100%` in CSS to fill the
		// content column; setting an explicit pixel width would re-introduce the
		// horizontal overflow this view used to exhibit. Mirror native
		// explorerView.layoutBody: only size the tree.
		if (this.tree) {
			this.tree.layout(height, width);
		}
	}

	override dispose(): void {
		if (this._fsRefreshTimer !== undefined) {
			clearTimeout(this._fsRefreshTimer);
			this._fsRefreshTimer = undefined;
		}
		super.dispose();
	}
}
