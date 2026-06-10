/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspaceView.css';
import * as DOM from '../../../../base/browser/dom.js';
import { WorkbenchCompressibleAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { localize } from '../../../../nls.js';
import { createFileIconThemableTreeContainerScope } from '../../../../workbench/contrib/files/browser/views/explorerView.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { isSingleFolderWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

// Import tree components from workspaceViewer
import { WorkspaceDelegate, WorkspaceDataSource, WorkspaceRenderer, WorkspaceFilter, WorkspaceSorter, IWorkspaceTreeElement } from './workspaceViewer.js';

//#endregion

//#region Workspace View Pane

export const WORKSPACE_VIEW_ID = 'workbench.view.workspace';

export class WorkspaceViewPane extends ViewPane {
	private treeContainer!: HTMLElement;
	private tree!: WorkbenchCompressibleAsyncDataTree<IWorkspaceTreeElement, IWorkspaceTreeElement, any>;
	private workspaceProgressBar!: ProgressBar;
	private emptyStateContainer!: HTMLElement;
	private workspaceRoots: IWorkspaceTreeElement[] = [];

	constructor(
		options: IViewPaneOptions,
		@IInstantiationService protected override readonly instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ILogService private readonly logService: ILogService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.logService.info('[WorkspaceViewPane] renderBody called');

		// Add class to container
		container.classList.add('workspace-view-body');

		// Create tree container
		this.treeContainer = DOM.append(container, DOM.$('.workspace-tree-container'));

		// Enable file icons
		this._register(createFileIconThemableTreeContainerScope(this.treeContainer, this.themeService));

		// Create progress bar
		const progressContainer = DOM.append(container, DOM.$('.workspace-progress'));
		this.workspaceProgressBar = this._register(new ProgressBar(progressContainer, defaultProgressBarStyles));
		this.workspaceProgressBar.stop().hide();

		// Create empty state container
		this.emptyStateContainer = DOM.append(container, DOM.$('.workspace-empty-state'));
		this.emptyStateContainer.style.display = 'none';
		const emptyIcon = DOM.append(this.emptyStateContainer, DOM.$('.workspace-empty-icon'));
		emptyIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folderOpened));
		const emptyMessage = DOM.append(this.emptyStateContainer, DOM.$('.workspace-empty-message'));
		emptyMessage.textContent = localize('workspaceEmpty', "You have not yet opened a folder.");

		// Create the tree
		this.createTree();

		// Load workspace roots
		this.loadWorkspaceRoots();

		// Listen for workspace folder changes
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this.logService.info('[WorkspaceViewPane] Workspace folders changed');
			this.loadWorkspaceRoots();
		}));
	}

	private createTree(): void {
		this.logService.info('[WorkspaceViewPane] Creating tree');
		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchCompressibleAsyncDataTree<IWorkspaceTreeElement, IWorkspaceTreeElement, any>,
			'WorkspaceTree',
			this.treeContainer,
			new WorkspaceDelegate(),
			{ isIncompressible: (_element: IWorkspaceTreeElement) => true },
			[new WorkspaceRenderer()],
			this.instantiationService.createInstance(WorkspaceDataSource),
			{
				accessibilityProvider: {
					getAriaLabel: (element: IWorkspaceTreeElement) => element.name,
					getWidgetAriaLabel: () => localize('workspaceTree', "Workspace"),
				},
				identityProvider: {
					getId: (element: IWorkspaceTreeElement) => element.resource.toString(),
				},
				filter: new WorkspaceFilter(),
				sorter: new WorkspaceSorter(),
				expandOnlyOnTwistieClick: false,
			}
		));
		this.logService.info('[WorkspaceViewPane] Tree created');
	}

	private async loadWorkspaceRoots(): Promise<void> {
		let folders: { uri: URI; name: string }[] = this.workspaceContextService.getWorkspace().folders;
		this.logService.info(`[WorkspaceViewPane] loadWorkspaceRoots: ${folders.length} folders found`);
		folders.forEach((f, i) => this.logService.info(`[WorkspaceViewPane]   folder[${i}]: ${f.name} -> ${f.uri.toString()}`));

		// Fallback: if no workspace folders, try to resolve from startup arguments
		if (folders.length === 0) {
			const startupFolder = this.resolveStartupFolder();
			if (startupFolder) {
				folders = [startupFolder];
				this.logService.info(`[WorkspaceViewPane] Fallback to startup folder: ${startupFolder.uri.toString()}`);
			}
		}

		if (folders.length === 0) {
			// No workspace folders - show empty state
			this.treeContainer.style.display = 'none';
			this.emptyStateContainer.style.display = 'flex';
			this.logService.info('[WorkspaceViewPane] No folders - showing empty state');
			return;
		}

		this.treeContainer.style.display = 'block';
		this.emptyStateContainer.style.display = 'none';

		if (folders.length === 1) {
			// Single root - show folder contents directly
			const root: IWorkspaceTreeElement = {
				resource: folders[0].uri,
				name: folders[0].name,
				isDirectory: true,
			};
			this.logService.info(`[WorkspaceViewPane] Setting single root input: ${root.name}`);
			await this.tree.setInput(root);
			// Auto-expand the root to show its children
			const expanded = await this.tree.expand(root);
			this.logService.info(`[WorkspaceViewPane] Root expanded: ${expanded}`);
		} else {
			// Multiple roots - create a virtual root containing all workspace folders
			this.workspaceRoots = folders.map(folder => ({
				resource: folder.uri,
				name: folder.name,
				isDirectory: true,
			}));

			const virtualRoot: IWorkspaceTreeElement = {
				resource: folders[0].uri,
				name: 'Workspace',
				isDirectory: true,
				children: this.workspaceRoots,
			};
			this.logService.info(`[WorkspaceViewPane] Setting virtual root with ${this.workspaceRoots.length} children`);
			await this.tree.setInput(virtualRoot);
			// Auto-expand the virtual root to show workspace folders
			const expanded = await this.tree.expand(virtualRoot);
			this.logService.info(`[WorkspaceViewPane] Virtual root expanded: ${expanded}`);
		}
	}

	private resolveStartupFolder(): { uri: URI; name: string } | undefined {
		try {
			const env = this.environmentService as any;
			const configuration = env.configuration;
			if (configuration) {
				// Try to get folder from window configuration (single folder workspace)
				const workspace = configuration.workspace;
				if (isSingleFolderWorkspaceIdentifier(workspace)) {
					return {
						uri: workspace.uri,
						name: basename(workspace.uri),
					};
				}
				// Try folder-uri from CLI args
				const folderUris: string[] | undefined = configuration['folder-uri'];
				if (folderUris && folderUris.length > 0) {
					const uri = URI.parse(folderUris[0]);
					return { uri, name: basename(uri) };
				}
				// Try positional args
				const args: string[] | undefined = configuration._;
				if (args && args.length > 0) {
					const folderPath = args.find(a => a && !a.startsWith('-'));
					if (folderPath) {
						const uri = URI.file(folderPath);
						return { uri, name: basename(uri) };
					}
				}
			}
		} catch (err) {
			this.logService.warn('[WorkspaceViewPane] Failed to resolve startup folder', err);
		}
		return undefined;
	}

	override focus(): void {
		super.focus();
		if (this.tree) {
			this.tree.domFocus();
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		// Do not hard-set container width: the sidebar CSS grid + SidebarPart.layout
		// already account for the icon-strip column, and `.workspace-tree-container`
		// uses `width: 100%`. An explicit pixel width re-introduces horizontal overflow.
		if (this.treeContainer) {
			this.treeContainer.style.height = `${height}px`;
		}

		if (this.tree) {
			this.tree.layout(height, width);
		}
	}

	override dispose(): void {
		super.dispose();
	}
}

//#endregion
