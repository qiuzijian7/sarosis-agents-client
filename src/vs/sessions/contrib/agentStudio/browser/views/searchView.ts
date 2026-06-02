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

	/** Saved reference to IWorkspaceContextService for comparing target path against active VSCode workspace folders. */
	private wsContextService!: IWorkspaceContextService;

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

		// 保存 contextService 引用，供 include pattern 计算时比较目标路径与当前 VSCode workspace folder
		this.wsContextService = contextService;

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
		// 更新搜索范围到选中的 worktree（或主仓库）
		const target = path || this.workspaceRootPath || '';
		this._updateSearchIncludePattern(target);
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
				this._updateSearchIncludePattern('');
				this._updateCurrentWorkspaceDisplay();
				this._updateWorktreeLabel();
				return;
			}

			const workspaces = await this.agentStudioService.getWorkspaces();
			const activeWorkspace = workspaces.find((ws: Workspace) => ws.id === activeWorkspaceId);

			// 记录 workspace 根路径（作为「主仓库」搜索范围 / worktree 列表过滤基准）
			this.workspaceRootPath = activeWorkspace?.path;

			// 搜索范围：优先用当前选中的 worktree 路径，否则用 workspace 根路径
			const target = this.selectedWorktreePath || activeWorkspace?.path;
			if (target) {
				this._updateSearchIncludePattern(target);
			} else {
				this._updateSearchIncludePattern('');
			}

			// Update displayed workspace info & worktree label
			this._updateCurrentWorkspaceDisplay();
			this._updateWorktreeLabel();
		} catch {
			// Silently fail
		}
	}

	private _updateSearchIncludePattern(pattern: string): void {
		// [Sarosis] 关键修复：对齐 VSCode 原生「在文件夹中查找」逻辑。
		//
		// 背景：sessions 窗口中，VSCode 搜索的真实根目录由 active session 注入的 workspace folder
		// 决定（见 WorkspaceFolderManagementContribution，通过 addFolders/updateFolders 注入，
		// 且就是当前激活 workspace 的 repo/worktree）。搜索本来就被限定在这个 folder 内。
		//
		// 之前的 bug：无条件把原始 Windows 绝对路径（含反斜杠 `\`）写入 include pattern。
		//   1. 当目标 == 当前 VSCode workspace folder（主仓库常态）时，绝对路径 include 触发
		//      queryBuilder 的 usingSearchPaths 分支，改变搜索行为；且原始反斜杠在 glob 处理链
		//      （splitGlobAware/splitGlobFromPath）中是非标准输入，导致 glob 不匹配 → 搜索无结果。
		//   2. VSCode 原生 resolveResourcesForSearchIncludes 在目标 == 根 folder 时返回空（即不写
		//      include，依赖 folder 自然限定范围），与我们的做法相反。
		//
		// 修复策略：
		//   - 若目标路径为空，或目标等于当前 VSCode workspace folder（主仓库），则清空 include
		//     pattern，依赖 active session folder 自然限定搜索范围（与原生一致）。
		//   - 仅当目标是 folder 之外的路径（如独立 worktree 目录）时，才写入绝对路径 include，
		//     并将反斜杠规范化为正斜杠（glob 标准），避免转义问题。
		try {
			const includeWidget = (this as any).inputPatternIncludes;
			if (!includeWidget) {
				return;
			}

			// 写入用：仅反斜杠转正斜杠 + 去尾斜杠，保留原始大小写（供 ripgrep 使用）
			const targetForWrite = this._toGlobPath(pattern);

			// 目标为空 → 清空 include，搜索整个 active session folder
			if (!targetForWrite) {
				includeWidget.setValue('');
				return;
			}

			// 比较用：大小写不敏感（Windows 盘符）
			const targetForCompare = this._normalizeForCompare(targetForWrite);

			// 比较目标路径与当前 VSCode workspace folders：若目标就是（或等于）某个根 folder，
			// 则清空 include，让搜索自然覆盖整个 folder（与 VSCode 原生行为一致）。
			const folders = this.wsContextService.getWorkspace().folders;
			const targetMatchesRoot = folders.some(folder => {
				const folderPath = this._normalizeForCompare(this._toGlobPath(folder.uri.fsPath));
				return folderPath === targetForCompare;
			});

			if (targetMatchesRoot) {
				// 主仓库 / 目标即根 folder：不写 include，依赖 folder 限定范围
				includeWidget.setValue('');
				return;
			}

			// 目标在根 folder 之外（独立 worktree 路径）：写入正斜杠规范化的绝对路径（保留大小写）
			includeWidget.setValue(targetForWrite);
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

	/**
	 * 路径比较规范化：Windows 盘符路径转小写（文件系统大小写不敏感），用于判断目标是否等于根 folder。
	 */
	private _normalizeForCompare(globPath: string): string {
		if (/^[a-zA-Z]:\//.test(globPath)) {
			return globPath.toLowerCase();
		}
		return globPath;
	}

	protected override layoutBody(height: number, width: number): void {
		// Account for workspace info container height
		const infoHeight = this.currentWorkspaceInfoContainer?.offsetHeight || 0;
		super.layoutBody(height - infoHeight, width);
	}
}
