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

const $ = dom.$;

/**
 * Agent Studio Search View - 继承原生 VSCode SearchView
 * 自动基于当前激活的 workspace 查找，无需手动选择
 * 当激活的 workspace 变化时，自动更新搜索范围
 */
export class AgentStudioSearchViewPane extends SearchView {

	private currentWorkspaceInfoContainer!: HTMLElement;
	private currentWorkspaceNameLabel!: HTMLElement;

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

		// Initial update of search scope based on active workspace
		this._updateSearchScopeBasedOnActiveWorkspace();
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
		this.currentWorkspaceNameLabel.textContent = 'No Workspace';
		container.appendChild(this.currentWorkspaceNameLabel);

		// Load initial workspace info
		this._updateCurrentWorkspaceDisplay();
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
				this._updateSearchIncludePattern('');
				this._updateCurrentWorkspaceDisplay();
				return;
			}

			const workspaces = await this.agentStudioService.getWorkspaces();
			const activeWorkspace = workspaces.find((ws: Workspace) => ws.id === activeWorkspaceId);
			
			if (activeWorkspace && activeWorkspace.path) {
				// Set search scope to active workspace path
				this._updateSearchIncludePattern(activeWorkspace.path);
			} else {
				// Active workspace has no path, clear restriction
				this._updateSearchIncludePattern('');
			}

			// Update displayed workspace info
			this._updateCurrentWorkspaceDisplay();
		} catch {
			// Silently fail
		}
	}

	private _updateSearchIncludePattern(pattern: string): void {
		// Access the native search widget's include pattern input via the inherited searchWidget
		// The SearchView has inputPatternIncludes which is a IncludePatternInputWidget
		try {
			// Use the inherited property to set the include pattern
			(this as any).inputPatternIncludes?.setValue(pattern);
			// [Sarosis] 不再强制展开 query details，保持原生紧凑布局（与 VSCode 原生搜索一致）。
			// include pattern 已静默写入，用户需要时可自行点击 "..." 展开查看/修改。
		} catch {
			// Silently fail if internal API changes
		}
	}

	protected override layoutBody(height: number, width: number): void {
		// Account for workspace info container height
		const infoHeight = this.currentWorkspaceInfoContainer?.offsetHeight || 0;
		super.layoutBody(height - infoHeight, width);
	}
}
