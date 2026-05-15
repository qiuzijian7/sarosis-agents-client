/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspaceExplorer.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { Event } from '../../../../../base/common/event.js';
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
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import { WorkbenchCompressibleAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { createFileIconThemableTreeContainerScope } from '../../../../../workbench/contrib/files/browser/views/explorerView.js';
import { ProgressBar } from '../../../../../base/browser/ui/progressbar/progressbar.js';
import { defaultProgressBarStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
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
 */
export class WorkspaceViewPane extends ViewPane {

	private treeContainer!: HTMLElement;
	private tree!: WorkbenchCompressibleAsyncDataTree<IWorkspaceExplorerElement, IWorkspaceExplorerElement, FuzzyScore>;
	private wsProgressBar!: ProgressBar;
	private emptyStateContainer!: HTMLElement;
	private resourceLabels!: ResourceLabels;

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
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
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
			this._register(this.agentStudioService.onDidChangeWorkspace(() => {
				this.logService.info('[WorkspaceViewPane] Workspace changed, reloading tree');
				this._loadWorkspaceRoots();
			}));
		} catch (err) {
			this.logService.warn('[WorkspaceViewPane] Could not subscribe to workspace changes:', err);
		}
	}

	private _createTree(): void {
		this.logService.info('[WorkspaceViewPane] Creating workspace explorer tree');

		// Create ResourceLabels instance for proper file icon theme rendering
		const onDidChangeVisibility: Event<boolean> = this.onDidChangeBodyVisibility;
		this.resourceLabels = this._register(this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility }));

		// Create the renderer that uses ResourceLabels
		const renderer = new WorkspaceExplorerRenderer(this.resourceLabels);

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchCompressibleAsyncDataTree<IWorkspaceExplorerElement, IWorkspaceExplorerElement, FuzzyScore>,
			'WorkspaceExplorer',
			this.treeContainer,
			new WorkspaceExplorerDelegate(),
			// Mark every node as incompressible so the tree renders a proper
			// hierarchical structure — just like VS Code's native Explorer.
			// Without this, the compressible tree merges single-child paths
			// into flat entries like ".sarosisworkspace/employees.json".
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
	}

	private async _loadWorkspaceRoots(): Promise<void> {
		this.logService.info('[WorkspaceViewPane] Loading workspace roots');
		this.wsProgressBar.infinite().show(100);

		try {
			const workspaces: Workspace[] = await this.agentStudioService.getWorkspaces();
			this.logService.info(`[WorkspaceViewPane] Loaded ${workspaces.length} workspaces: ${JSON.stringify(workspaces.map(w => ({ id: w.id, name: w.name, path: w.path })))}`);

			if (workspaces.length === 0) {
				// Show empty state
				this.treeContainer.style.display = 'none';
				this.emptyStateContainer.style.display = 'flex';
				this.wsProgressBar.stop().hide();
				return;
			}

			this.treeContainer.style.display = 'block';
			this.emptyStateContainer.style.display = 'none';

			// Build tree root nodes from ALL workspaces.
			// Workspaces with a local path become real filesystem roots.
			// Workspaces without a path become virtual roots (showing metadata only).
			const workspaceRoots: IWorkspaceExplorerElement[] = [];
			for (const ws of workspaces) {
				if (ws.path) {
					// Real workspace — has a local path, children come from IFileService
					// Validate that the path exists before treating it as a real workspace
					const wsUri = URI.file(ws.path);
					let pathExists = false;
					try {
						const stat = await this.fileService.stat(wsUri);
						pathExists = stat.isDirectory;
						this.logService.info(`[WorkspaceViewPane]   - "${ws.name}" path="${ws.path}" id=${ws.id} exists=${pathExists} isDir=${stat.isDirectory}`);
					} catch (statErr) {
						this.logService.warn(`[WorkspaceViewPane]   - "${ws.name}" path="${ws.path}" id=${ws.id} — path does not exist or cannot be accessed: ${statErr}`);
					}

					if (pathExists) {
						workspaceRoots.push({
							resource: wsUri,
							name: ws.name,
							isDirectory: true,
							isWorkspaceRoot: true,
							workspaceId: ws.id,
						});
					} else {
						// Path doesn't exist — show as virtual workspace with error info
						this.logService.warn(`[WorkspaceViewPane]   - "${ws.name}" path="${ws.path}" does not exist, showing as virtual`);
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
							resource: URI.joinPath(infoUri, 'path-missing'),
							name: localize('pathMissing', "Path not found: {0}", ws.path),
							isDirectory: false,
							isInfoNode: true,
						});
						infoChildren.push({
							resource: URI.joinPath(infoUri, 'created'),
							name: localize('workspaceCreated', "Created: {0}", new Date(ws.createdAt).toLocaleDateString()),
							isDirectory: false,
							isInfoNode: true,
						});
						workspaceRoots.push({
							resource: infoUri,
							name: ws.name,
							isDirectory: true,
							isWorkspaceRoot: true,
							isVirtualWorkspace: true,
							workspaceId: ws.id,
							description: ws.description,
							children: infoChildren,
						});
					}
				} else {
					// Virtual workspace — no local path, show as folder with info children
					this.logService.info(`[WorkspaceViewPane]   - "${ws.name}" (virtual, no path) id=${ws.id}`);
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
					workspaceRoots.push({
						resource: infoUri,
						name: ws.name,
						isDirectory: true,
						isWorkspaceRoot: true,
						isVirtualWorkspace: true,
						workspaceId: ws.id,
						description: ws.description,
						children: infoChildren,
					});
				}
			}

			// After validation, check if we still have any roots
			if (workspaceRoots.length === 0) {
				this.logService.warn('[WorkspaceViewPane] No valid workspace roots found after path validation');
				this.treeContainer.style.display = 'none';
				this.emptyStateContainer.style.display = 'flex';
				this.wsProgressBar.stop().hide();
				return;
			}

			this.logService.info(`[WorkspaceViewPane] Building tree with ${workspaceRoots.length} roots (real + virtual)`);

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

			this.logService.info(`[WorkspaceViewPane] Setting virtual root with ${workspaceRoots.length} workspace children`);
			await this.tree.setInput(virtualRoot);
			this.logService.info('[WorkspaceViewPane] setInput completed for virtual root');

			// Auto-expand each workspace root so users see the file tree immediately
			for (const root of workspaceRoots) {
				try {
					await this.tree.expand(root);
					this.logService.info(`[WorkspaceViewPane] expanded workspace root: ${root.name}`);
				} catch {
					// Expand may fail if directory doesn't exist
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

	override focus(): void {
		super.focus();
		if (this.tree) {
			this.tree.domFocus();
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		if (this.treeContainer) {
			this.treeContainer.style.height = `${height}px`;
			this.treeContainer.style.width = `${width}px`;
		}

		if (this.emptyStateContainer) {
			this.emptyStateContainer.style.height = `${height}px`;
			this.emptyStateContainer.style.width = `${width}px`;
		}

		if (this.tree) {
			this.tree.layout(height, width);
		}
	}

	override dispose(): void {
		super.dispose();
	}
}
