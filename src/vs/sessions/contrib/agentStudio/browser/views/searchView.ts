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

const $ = dom.$;

/**
 * Agent Studio Search View - 继承原生 VSCode SearchView
 * 在原生搜索功能之上添加 workspace 选择器，支持选择搜索范围：
 * - 所有 workspaces
 * - 指定某个 workspace
 */
export class AgentStudioSearchViewPane extends SearchView {

	private workspaceSelectorContainer!: HTMLElement;
	private workspaceSelect!: HTMLSelectElement;
	private selectedWorkspaceId: string = 'all';

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
	}

	protected override renderBody(parent: HTMLElement): void {
		// Render workspace selector above native search
		this.workspaceSelectorContainer = dom.append(parent, $('.agent-studio-workspace-selector'));
		this._renderWorkspaceSelector();

		// Render native search view below
		super.renderBody(parent);
	}

	private _renderWorkspaceSelector(): void {
		const container = this.workspaceSelectorContainer;
		container.style.padding = '8px 12px';
		container.style.borderBottom = '1px solid var(--vscode-panel-border)';
		container.style.display = 'flex';
		container.style.alignItems = 'center';
		container.style.gap = '8px';

		// Label
		const label = $('span.workspace-selector-label');
		label.textContent = 'Workspace:';
		label.style.fontSize = '12px';
		label.style.color = 'var(--vscode-descriptionForeground)';
		label.style.whiteSpace = 'nowrap';
		container.appendChild(label);

		// Select dropdown
		this.workspaceSelect = document.createElement('select');
		this.workspaceSelect.className = 'agent-studio-workspace-select';
		this.workspaceSelect.style.flex = '1';
		this.workspaceSelect.style.padding = '3px 6px';
		this.workspaceSelect.style.fontSize = '12px';
		this.workspaceSelect.style.backgroundColor = 'var(--vscode-dropdown-background)';
		this.workspaceSelect.style.color = 'var(--vscode-dropdown-foreground)';
		this.workspaceSelect.style.border = '1px solid var(--vscode-dropdown-border)';
		this.workspaceSelect.style.borderRadius = '2px';
		this.workspaceSelect.style.outline = 'none';

		// Default option
		const allOption = document.createElement('option');
		allOption.value = 'all';
		allOption.textContent = 'All Workspaces';
		this.workspaceSelect.appendChild(allOption);

		this.workspaceSelect.addEventListener('change', () => {
			this.selectedWorkspaceId = this.workspaceSelect.value;
			this._onWorkspaceSelectionChanged();
		});
		container.appendChild(this.workspaceSelect);

		// Load workspaces
		this._loadWorkspaceOptions();

		// Subscribe to workspace changes
		this._register(this.agentStudioService.onDidChangeWorkspace(() => this._loadWorkspaceOptions()));
	}

	private async _loadWorkspaceOptions(): Promise<void> {
		try {
			const workspaces = await this.agentStudioService.getWorkspaces();

			// Clear all options except "All Workspaces"
			while (this.workspaceSelect.options.length > 1) {
				this.workspaceSelect.remove(1);
			}

			// Add workspace options
			for (const ws of workspaces) {
				const option = document.createElement('option');
				option.value = ws.id;
				option.textContent = ws.name;
				this.workspaceSelect.appendChild(option);
			}

			// Restore selection
			if (this.selectedWorkspaceId !== 'all') {
				const exists = workspaces.some(ws => ws.id === this.selectedWorkspaceId);
				if (!exists) {
					this.selectedWorkspaceId = 'all';
				}
				this.workspaceSelect.value = this.selectedWorkspaceId;
			}
		} catch {
			// Silently fail - keep "All Workspaces" as only option
		}
	}

	private _onWorkspaceSelectionChanged(): void {
		// When workspace selection changes, update the search scope
		// The "include files" pattern can be updated to limit search to the selected workspace's folder
		if (this.selectedWorkspaceId === 'all') {
			// Clear any workspace-specific folder restriction
			this._updateSearchIncludePattern('');
		} else {
			// Get workspace folder path and set it as include pattern
			this._applyWorkspaceFolder(this.selectedWorkspaceId);
		}
	}

	private async _applyWorkspaceFolder(workspaceId: string): Promise<void> {
		try {
			const workspaces = await this.agentStudioService.getWorkspaces();
			const ws = workspaces.find(w => w.id === workspaceId);
			if (ws && ws.path) {
				this._updateSearchIncludePattern(ws.path);
			}
		} catch {
			// Silently fail
		}
	}

	private _updateSearchIncludePattern(pattern: string): void {
		// Access the native search widget's include pattern input via the inherited searchWidget
		// The SearchView has inputPatternIncludes which is a IncludePatternInputWidget
		try {
			// Use the inherited method to set the include pattern
			(this as any).inputPatternIncludes?.setValue(pattern);
			// Expand query details to show include/exclude filters
			if (pattern) {
				(this as any).toggleQueryDetails?.(true);
			}
		} catch {
			// Silently fail if internal API changes
		}
	}

	protected override layoutBody(height: number, width: number): void {
		// Account for workspace selector height
		const selectorHeight = this.workspaceSelectorContainer?.offsetHeight || 0;
		super.layoutBody(height - selectorHeight, width);
	}
}
