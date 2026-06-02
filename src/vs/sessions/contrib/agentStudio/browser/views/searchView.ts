/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { IViewPaneOptions } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ISearchViewModelWorkbenchService } from '../../../../../workbench/contrib/search/browser/searchTreeModel/searchViewModelWorkbenchService.js';
import { IReplaceService } from '../../../../../workbench/contrib/search/browser/replace.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { IPreferencesService } from '../../../../../workbench/services/preferences/common/preferences.js';
import { ISearchHistoryService } from '../../../../../workbench/contrib/search/common/searchHistoryService.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { INotebookService } from '../../../../../workbench/contrib/notebook/common/notebookService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { SearchView } from '../../../../../workbench/contrib/search/browser/searchView.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import type { Workspace } from '../../../../common/agentStudioTypes.js';
import { IAction, Separator, toAction } from '../../../../../base/common/actions.js';

const $ = dom.$;

/** Worktree entry returned by IAgentStudioService.getWorktrees */
interface IWorktreeEntry {
	path: string;
	branch: string;
}

/**
 * Agent Studio Search View - 继承原生 VSCode SearchView
 * 自动基于当前激活的 workspace 查找，无需手动选择
 * 当激活的 workspace 变化时，自动更新搜索范围
 */
export class AgentStudioSearchViewPane extends SearchView {

	private currentWorkspaceInfoContainer!: HTMLElement;
	private currentWorkspaceNameLabel!: HTMLElement;

	/** Worktree dropdown trigger button (shows current selected worktree branch). */
	private worktreeDropdownButton!: HTMLElement;
	private worktreeDropdownLabel!: HTMLElement;

	/** Absolute path of the workspace's main repo root (used as "main" entry / reset target). */
	private workspaceRootPath: string | undefined;
	/** Absolute path of the currently selected worktree (undefined = main repo). */
	private selectedWorktreePath: string | undefined;

	constructor(
		options: IViewPaneOptions,
		@IFileService fileService: IFileService,
		@IEditorService editorService: IEditorService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IProgressService progressService: IProgressService,
		@INotificationService notificationService: INotificationService,
		@IDialogService dialogService: IDialogService,
		@ICommandService commandService: ICommandService,
		@IContextViewService contextViewService: IContextViewService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@ISearchViewModelWorkbenchService searchViewModelWorkbenchService: ISearchViewModelWorkbenchService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IReplaceService replaceService: IReplaceService,
		@ITextFileService textFileService: ITextFileService,
		@IPreferencesService preferencesService: IPreferencesService,
		@IThemeService themeService: IThemeService,
		@ISearchHistoryService searchHistoryService: ISearchHistoryService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IStorageService storageService: IStorageService,
		@IOpenerService openerService: IOpenerService,
		@IHoverService hoverService: IHoverService,
		@INotebookService notebookService: INotebookService,
		@ILogService logService: ILogService,
		@IAccessibilitySignalService accessibilitySignalService: IAccessibilitySignalService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
	) {
		super(
			options,
			fileService,
			editorService,
			codeEditorService,
			progressService,
			notificationService,
			dialogService,
			commandService,
			contextViewService,
			instantiationService,
			viewDescriptorService,
			configurationService,
			contextService,
			searchViewModelWorkbenchService,
			contextKeyService,
			replaceService,
			textFileService,
			preferencesService,
			themeService,
			searchHistoryService,
			contextMenuService,
			accessibilityService,
			keybindingService,
			storageService,
			openerService,
			hoverService,
			notebookService,
			logService,
			accessibilitySignalService,
			telemetryService,
		);

		// 监听激活的 workspace 变化，自动更新搜索范围
		this._register(this.agentStudioService.onDidChangeActiveWorkspace(() => {
			// 切换 workspace 时，重置 worktree 选择为主仓库
			this.selectedWorktreePath = undefined;
			this._updateSearchScopeBasedOnActiveWorkspace();
		}));

		// 监听 workspace 列表变化，更新显示的 workspace 名称
		this._register(this.agentStudioService.onDidChangeWorkspace(() => {
			this._updateCurrentWorkspaceDisplay();
		}));
	}

	protected override renderBody(parent: HTMLElement): void {
		// Render current workspace info above native search
		this.currentWorkspaceInfoContainer = dom.append(parent, $('.agent-studio-workspace-info'));
		this._renderCurrentWorkspaceInfo();

		// Render native search view below
		super.renderBody(parent);

		// [Sarosis] 隐藏原生的 "files to include / files to exclude" 过滤区（含 "..." 切换按钮）。
		// 搜索范围已自动限定为当前激活 workspace 的路径（通过 include pattern 静默写入），
		// 不需要再向用户暴露这两个过滤输入框。
		this._hideQueryDetails();

		// Initial update of search scope based on active workspace
		this._updateSearchScopeBasedOnActiveWorkspace();
	}

	private _hideQueryDetails(): void {
		try {
			// 原生 SearchView 在 createSearchWidgets() 中创建了 `.query-details` 容器（private 字段），
			// 包含 toggle 按钮 + `.file-types.includes` + `.file-types.excludes`。整体隐藏即可。
			const queryDetails = (this as any).queryDetails as HTMLElement | undefined;
			if (queryDetails) {
				queryDetails.style.display = 'none';
			}
		} catch {
			// Silently fail if internal API changes
		}
	}

	private _renderCurrentWorkspaceInfo(): void {
		const container = this.currentWorkspaceInfoContainer;
		// [Sarosis] 紧凑单行布局，参考原生搜索页面，尽量减少垂直占用
		container.style.display = 'flex';
		container.style.alignItems = 'center';
		container.style.gap = '4px';
		container.style.padding = '2px 12px 4px';
		container.style.fontSize = '11px';
		container.style.lineHeight = '16px';
		container.style.color = 'var(--vscode-descriptionForeground)';
		container.style.overflow = 'hidden';
		container.style.whiteSpace = 'nowrap';

		// Folder icon (codicon)
		const icon = $('span.codicon.codicon-folder');
		icon.style.fontSize = '13px';
		icon.style.flexShrink = '0';
		icon.style.opacity = '0.85';
		container.appendChild(icon);

		// Workspace name label (单行，省略号截断)
		this.currentWorkspaceNameLabel = $('span.agent-studio-workspace-name');
		this.currentWorkspaceNameLabel.style.overflow = 'hidden';
		this.currentWorkspaceNameLabel.style.textOverflow = 'ellipsis';
		this.currentWorkspaceNameLabel.style.whiteSpace = 'nowrap';
		this.currentWorkspaceNameLabel.style.color = 'var(--vscode-foreground)';
		this.currentWorkspaceNameLabel.style.flexShrink = '0';
		this.currentWorkspaceNameLabel.textContent = 'No Workspace';
		container.appendChild(this.currentWorkspaceNameLabel);

		// [Sarosis] Worktree 下拉选择器（工作区名称右侧）
		// 允许用户选择不同的 worktree 路径进行搜索（含主仓库）。
		this._renderWorktreeDropdown(container);

		// Load initial workspace info
		this._updateCurrentWorkspaceDisplay();
	}

	private _renderWorktreeDropdown(container: HTMLElement): void {
		// 下拉触发按钮：分支图标 + 当前选中的 worktree 名 + 下拉箭头
		const button = $('a.agent-studio-worktree-dropdown');
		button.setAttribute('role', 'button');
		button.tabIndex = 0;
		button.style.display = 'flex';
		button.style.alignItems = 'center';
		button.style.gap = '3px';
		button.style.marginLeft = '4px';
		button.style.padding = '0 6px';
		button.style.height = '18px';
		button.style.lineHeight = '18px';
		button.style.borderRadius = '4px';
		button.style.cursor = 'pointer';
		button.style.flexShrink = '0';
		button.style.maxWidth = '160px';
		button.style.overflow = 'hidden';
		button.style.color = 'var(--vscode-foreground)';
		button.style.backgroundColor = 'var(--vscode-badge-background)';
		button.title = '选择 worktree 进行搜索';

		// Branch icon (codicon)
		const branchIcon = $('span.codicon.codicon-git-branch');
		branchIcon.style.fontSize = '12px';
		branchIcon.style.flexShrink = '0';
		button.appendChild(branchIcon);

		// Label (当前选中的 worktree 名)
		this.worktreeDropdownLabel = $('span.agent-studio-worktree-label');
		this.worktreeDropdownLabel.style.overflow = 'hidden';
		this.worktreeDropdownLabel.style.textOverflow = 'ellipsis';
		this.worktreeDropdownLabel.style.whiteSpace = 'nowrap';
		this.worktreeDropdownLabel.textContent = '主仓库';
		button.appendChild(this.worktreeDropdownLabel);

		// Dropdown arrow (codicon)
		const arrow = $('span.codicon.codicon-chevron-down');
		arrow.style.fontSize = '12px';
		arrow.style.flexShrink = '0';
		arrow.style.opacity = '0.8';
		button.appendChild(arrow);

		this.worktreeDropdownButton = button;
		container.appendChild(button);

		// 点击 / 回车 打开下拉菜单
		this._register(dom.addDisposableListener(button, dom.EventType.CLICK, (e) => {
			dom.EventHelper.stop(e, true);
			this._showWorktreeDropdown();
		}));
		this._register(dom.addDisposableListener(button, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				dom.EventHelper.stop(e, true);
				this._showWorktreeDropdown();
			}
		}));
	}

	private async _showWorktreeDropdown(): Promise<void> {
		const activeWorkspaceId = this.agentStudioService.getActiveWorkspaceId();
		if (!activeWorkspaceId) {
			return;
		}

		let worktrees: IWorktreeEntry[] = [];
		try {
			worktrees = await this.agentStudioService.getWorktrees(activeWorkspaceId);
		} catch {
			worktrees = [];
		}

		const actions: IAction[] = [];

		// "主仓库" 入口：搜索范围 = workspace 根路径
		const isMainSelected = !this.selectedWorktreePath;
		actions.push(toAction({
			id: 'worktree.main',
			label: '主仓库',
			checked: isMainSelected,
			run: () => this._selectWorktree(undefined),
		}));

		// 过滤掉与主仓库路径相同的 worktree（避免重复），其余作为可选项
		const normalize = (p: string) => p.replace(/[/\\]+$/, '').toLowerCase();
		const rootNorm = this.workspaceRootPath ? normalize(this.workspaceRootPath) : undefined;
		const otherWorktrees = worktrees.filter(wt => !rootNorm || normalize(wt.path) !== rootNorm);

		if (otherWorktrees.length > 0) {
			actions.push(new Separator());
			for (const wt of otherWorktrees) {
				const checked = !!this.selectedWorktreePath && normalize(this.selectedWorktreePath) === normalize(wt.path);
				actions.push(toAction({
					id: `worktree.${wt.path}`,
					label: wt.branch || wt.path.split(/[/\\]/).pop() || wt.path,
					tooltip: wt.path,
					checked,
					run: () => this._selectWorktree(wt.path),
				}));
			}
		}

		this.contextMenuService.showContextMenu({
			getAnchor: () => this.worktreeDropdownButton,
			getActions: () => actions,
		});
	}

	private _selectWorktree(path: string | undefined): void {
		this.selectedWorktreePath = path;
		// 重新基于激活 workspace 计算搜索范围：
		// - 选中具体 worktree → 限定到该 worktree 单一路径
		// - 选中「主仓库」(path===undefined) → 恢复为所有关联代码仓库根目录
		this._updateSearchScopeBasedOnActiveWorkspace();
		this._updateWorktreeLabel();
	}

	private _updateWorktreeLabel(): void {
		if (!this.worktreeDropdownLabel) {
			return;
		}
		if (!this.selectedWorktreePath) {
			this.worktreeDropdownLabel.textContent = '主仓库';
			this.worktreeDropdownButton.title = '主仓库（当前搜索范围）';
			return;
		}
		const name = this.selectedWorktreePath.split(/[/\\]/).pop() || this.selectedWorktreePath;
		this.worktreeDropdownLabel.textContent = name;
		this.worktreeDropdownButton.title = this.selectedWorktreePath;
	}

	private async _updateCurrentWorkspaceDisplay(): Promise<void> {
		try {
			const activeWorkspaceId = this.agentStudioService.getActiveWorkspaceId();
			if (!activeWorkspaceId) {
				this.currentWorkspaceNameLabel.textContent = 'No Workspace';
				this.currentWorkspaceInfoContainer.title = '';
				return;
			}

			const workspaces = await this.agentStudioService.getWorkspaces();
			const activeWorkspace = workspaces.find((ws: Workspace) => ws.id === activeWorkspaceId);

			if (activeWorkspace) {
				this.currentWorkspaceNameLabel.textContent = activeWorkspace.name;
				// 完整路径作为 tooltip，避免单独占用一行
				this.currentWorkspaceInfoContainer.title = activeWorkspace.path || activeWorkspace.name;
			} else {
				this.currentWorkspaceNameLabel.textContent = 'Unknown Workspace';
				this.currentWorkspaceInfoContainer.title = '';
			}
		} catch {
			// Silently fail
		}
	}

	private async _updateSearchScopeBasedOnActiveWorkspace(): Promise<void> {
		try {
			const activeWorkspaceId = this.agentStudioService.getActiveWorkspaceId();

			if (!activeWorkspaceId) {
				// No active workspace, clear search scope restriction
				this.workspaceRootPath = undefined;
				this.selectedWorktreePath = undefined;
				this._updateSearchIncludePaths([]);
				this._updateCurrentWorkspaceDisplay();
				this._updateWorktreeLabel();
				return;
			}

			const workspaces = await this.agentStudioService.getWorkspaces();
			const activeWorkspace = workspaces.find((ws: Workspace) => ws.id === activeWorkspaceId);

			// 真实代码仓库根目录集合（用于搜索范围）：
			// 注意：workspace.path 是 home / 元数据目录（存放 .sarosisworkspace、worktrees 等），
			// **不含代码**；真正的代码仓库在 relatedFolders[]（见 WorkspaceViewPane 文件树渲染逻辑）。
			// 因此搜索范围必须用 relatedFolders 的路径，否则会搜到空的 home 目录 → 0 结果。
			const repoPaths = this._collectWorkspaceRepoPaths(activeWorkspace);

			// 记录首个仓库根路径，作为「主仓库」搜索范围 / worktree 列表过滤基准
			this.workspaceRootPath = repoPaths[0];

			if (this.selectedWorktreePath) {
				// 用户选定了某个 worktree：搜索范围 = 该 worktree 单一路径
				this._updateSearchIncludePaths([this.selectedWorktreePath]);
			} else {
				// 主仓库（默认）：搜索范围 = 所有关联代码仓库根目录
				this._updateSearchIncludePaths(repoPaths);
			}

			// Update displayed workspace info & worktree label
			this._updateCurrentWorkspaceDisplay();
			this._updateWorktreeLabel();
		} catch {
			// Silently fail
		}
	}

	/**
	 * 收集 workspace 的真实代码仓库根路径集合，用于限定搜索范围。
	 * 优先 relatedFolders（真实代码仓库）；为兼容遗留无 relatedFolders 的 workspace，
	 * 回退到 workspace.path。返回去重后的绝对路径数组（保留原始大小写与分隔符）。
	 */
	private _collectWorkspaceRepoPaths(ws: Workspace | undefined): string[] {
		if (!ws) {
			return [];
		}
		const paths: string[] = [];
		const seen = new Set<string>();
		const add = (p: string | undefined) => {
			if (!p) {
				return;
			}
			const key = this._toGlobPath(p).toLowerCase();
			if (!seen.has(key)) {
				seen.add(key);
				paths.push(p);
			}
		};
		// 1. 关联代码仓库（核心：真正含代码的目录）
		for (const rf of ws.relatedFolders ?? []) {
			add(rf?.path);
		}
		// 2. 遗留兼容：无 relatedFolders 时回退到 home 目录
		if (paths.length === 0) {
			add(ws.path);
		}
		return paths;
	}

	private _updateSearchIncludePaths(paths: string[]): void {
		// [Sarosis] 关键修复（v3）：把「真实代码仓库根路径集合」以正斜杠绝对路径写入 include pattern。
		//
		// 完整根因（前两版修复均未命中真凶）：
		//   sessions 窗口的 agentStudio Workspace 有两类根目录：
		//     - workspace.path  → home / 元数据目录（.sarosisworkspace、worktrees 等），**不含代码**
		//     - relatedFolders[] → 真正的代码仓库（git root，含 AGENTS.md 等源码）
		//   之前的代码错误地把 workspace.path（空的 home 目录）写入 include pattern，
		//   导致搜索范围落在不含代码的目录 → 搜索已存在内容也 0 结果（与现象完全吻合）。
		//
		// 修复：改用 relatedFolders 的路径（见 _collectWorkspaceRepoPaths）。
		//
		// 实现要点（依据 queryBuilder.commonQuery）：
		//   include pattern 含绝对路径时走 usingSearchPaths 分支，直接用这些绝对路径构建搜索根，
		//   不依赖可能为空 / 不一致的 getWorkspace().folders。多个路径用逗号分隔（原生支持）。
		//   必须把 Windows 反斜杠转正斜杠——原始 `\` 在 glob 链
		//   （splitGlobFromPath / normalizeGlobPattern）中是转义字符，会破坏路径解析。
		try {
			const includeWidget = (this as any).inputPatternIncludes;
			if (!includeWidget) {
				return;
			}

			// 反斜杠转正斜杠 + 去尾斜杠，保留原始大小写（供 ripgrep 精确匹配），过滤空值并去重
			const globPaths = Array.from(new Set(
				paths.map(p => this._toGlobPath(p)).filter(p => p.length > 0)
			));

			// 原生 include 输入框用逗号分隔多个 search path
			includeWidget.setValue(globPaths.join(', '));

			// include pattern 变更后，若搜索框已有内容，主动重新触发查询，使新范围立即生效。
			this._retriggerSearchIfActive();
		} catch {
			// Silently fail if internal API changes
		}
	}

	/**
	 * 若当前搜索框已有查询内容，则用新的搜索范围重新触发查询。
	 * 直接复用原生 triggerQueryChange（protected），避免范围切换后旧结果残留 / 不刷新。
	 */
	private _retriggerSearchIfActive(): void {
		try {
			const widget = (this as any).searchWidget;
			const value: string | undefined = widget?.searchInput?.getValue?.();
			if (value && value.length > 0) {
				(this as any).triggerQueryChange?.({ preserveFocus: true, delay: 0 });
			}
		} catch {
			// Silently fail if internal API changes
		}
	}

	/**
	 * 将文件系统路径转为 glob 可用的形式：反斜杠转正斜杠 + 去除尾部斜杠。保留原始大小写。
	 */
	private _toGlobPath(p: string | undefined): string {
		if (!p) {
			return '';
		}
		return p.replace(/\\/g, '/').replace(/\/+$/, '');
	}

	protected override layoutBody(height: number, width: number): void {
		// Account for workspace info container height
		const infoHeight = this.currentWorkspaceInfoContainer?.offsetHeight || 0;
		super.layoutBody(height - infoHeight, width);
	}
}
