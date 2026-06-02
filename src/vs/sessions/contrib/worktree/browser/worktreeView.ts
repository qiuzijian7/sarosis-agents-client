/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/worktree.css';
import * as dom from '../../../../base/browser/dom.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ICompressibleTreeRenderer } from '../../../../base/browser/ui/tree/objectTree.js';
import { ITreeNode } from '../../../../base/browser/ui/tree/tree.js';
import { ICompressedTreeNode, ICompressedTreeElement } from '../../../../base/browser/ui/tree/compressedObjectTreeModel.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchCompressibleObjectTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { ViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IAccessibleViewInformationService } from '../../../../workbench/services/accessibility/common/accessibleViewInformationService.js';
import { WorktreeItem, WorktreeTreeDataProvider, WorktreeRepoGroup, WorktreeTreeElement, isWorktreeRepoGroup } from './worktreeDataProvider.js';
import { IWorktreeService } from '../common/worktreeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISCMViewService, ISCMRepository } from '../../../../workbench/contrib/scm/common/scm.js';
import { IWorkspaceEditingService } from '../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

const $ = dom.$;

// --- Tree Renderer ---

class WorktreeTreeRenderer implements ICompressibleTreeRenderer<WorktreeItem, void, IWorktreeTemplateData> {
	static readonly TEMPLATE_ID = 'worktreeItem';

	constructor(
		private readonly _isDeleting: (path: string) => boolean,
		private readonly _onDelete: (item: WorktreeItem) => void,
		private readonly _onOpen: (item: WorktreeItem) => void,
	) { }

	get templateId(): string { return WorktreeTreeRenderer.TEMPLATE_ID; }

	renderTemplate(container: HTMLElement): IWorktreeTemplateData {
		const element = dom.append(container, $('.worktree-item'));
		const icon = dom.append(element, $('.worktree-item-icon'));
		const label = dom.append(element, $('.worktree-item-label'));
		const desc = dom.append(element, $('.worktree-item-description'));
		const actions = dom.append(element, $('.worktree-item-actions'));
		return { element, icon, label, desc, actions };
	}

	renderElement(node: ITreeNode<WorktreeItem, void>, _index: number, templateData: IWorktreeTemplateData): void {
		const item = node.element;
		templateData.label.textContent = item.label;
		templateData.desc.textContent = item.description ?? '';

		// Set icon
		const iconClasses = ThemeIcon.asClassNameArray(item.iconPath);
		templateData.icon.className = 'worktree-item-icon ' + iconClasses.join(' ');

		// Visual indicators
		templateData.element.classList.toggle('is-main', item.worktree.isMain);
		templateData.element.classList.toggle('is-detached', item.worktree.detached);
		templateData.element.classList.toggle('is-locked', item.worktree.locked);
		templateData.element.classList.toggle('is-prunable', item.worktree.prunable);

		// Check if this item is being deleted
		const isDeleting = this._isDeleting(item.path);
		templateData.element.classList.toggle('is-deleting', isDeleting);

		// Render actions (open button, remove button for non-main worktrees, spinner when deleting)
		dom.clearNode(templateData.actions);
		if (isDeleting) {
			// Show loading spinner
			const spinner = dom.append(templateData.actions, $('.worktree-item-spinner'));
			spinner.title = localize('worktreeDeleting', 'Deleting...');
		} else {
			// "Open in VS Code" button (available for all worktrees)
			const openBtn = dom.append(templateData.actions, $('a.worktree-item-action'));
			openBtn.setAttribute('role', 'button');
			openBtn.setAttribute('title', localize('worktreeOpenInVSCode', 'Open in VS Code'));
			openBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.emptyWindow));
			openBtn.onclick = (e) => {
				e.stopPropagation();
				this._onOpen(item);
			};
		}

		if (!isDeleting && !item.worktree.isMain) {
			const removeBtn = dom.append(templateData.actions, $('a.worktree-item-action'));
			removeBtn.setAttribute('role', 'button');
			removeBtn.setAttribute('title', localize('worktreeRemove', 'Remove Worktree'));
			removeBtn.textContent = '\u00D7'; // × multiplication sign
			removeBtn.style.setProperty('display', 'flex');
			removeBtn.style.setProperty('align-items', 'center');
			removeBtn.style.setProperty('justify-content', 'center');
			removeBtn.style.setProperty('width', '20px');
			removeBtn.style.setProperty('height', '20px');
			removeBtn.style.setProperty('font-size', '14px');
			removeBtn.style.setProperty('font-weight', 'bold');
			removeBtn.style.setProperty('line-height', '1');
			removeBtn.style.setProperty('cursor', 'pointer');
			removeBtn.style.setProperty('border-radius', '3px');
			removeBtn.style.setProperty('color', 'var(--vscode-icon-foreground)');
			removeBtn.onclick = (e) => {
				e.stopPropagation();
				this._onDelete(item);
			};
		}
	}

	renderCompressedElements(_node: ITreeNode<ICompressedTreeNode<WorktreeItem>, void>, _index: number, _templateData: IWorktreeTemplateData): void {
		// No compression needed for worktree items
	}

	disposeTemplate(_templateData: IWorktreeTemplateData): void {
		// noop
	}
}

interface IWorktreeTemplateData {
	readonly element: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly desc: HTMLElement;
	readonly actions: HTMLElement;
}

// --- Repo Group Renderer (parent node when multiple related repos exist) ---

class WorktreeRepoGroupRenderer implements ICompressibleTreeRenderer<WorktreeRepoGroup, void, IWorktreeGroupTemplateData> {
	static readonly TEMPLATE_ID = 'worktreeRepoGroup';

	get templateId(): string { return WorktreeRepoGroupRenderer.TEMPLATE_ID; }

	renderTemplate(container: HTMLElement): IWorktreeGroupTemplateData {
		const element = dom.append(container, $('.worktree-repo-group'));
		const icon = dom.append(element, $('.worktree-repo-group-icon'));
		const label = dom.append(element, $('.worktree-repo-group-label'));
		const count = dom.append(element, $('.worktree-repo-group-count'));
		return { element, icon, label, count };
	}

	renderElement(node: ITreeNode<WorktreeRepoGroup, void>, _index: number, templateData: IWorktreeGroupTemplateData): void {
		const group = node.element;
		templateData.label.textContent = group.label;
		templateData.count.textContent = String(group.worktrees.length);
		templateData.icon.className = 'worktree-repo-group-icon ' + ThemeIcon.asClassNameArray(Codicon.repo).join(' ');
	}

	renderCompressedElements(_node: ITreeNode<ICompressedTreeNode<WorktreeRepoGroup>, void>, _index: number, _templateData: IWorktreeGroupTemplateData): void {
		// No compression for group nodes
	}

	disposeTemplate(_templateData: IWorktreeGroupTemplateData): void {
		// noop
	}
}

interface IWorktreeGroupTemplateData {
	readonly element: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly count: HTMLElement;
}

// --- Tree Delegate ---

class WorktreeTreeDelegate implements IListVirtualDelegate<WorktreeTreeElement> {
	getHeight(_element: WorktreeTreeElement): number {
		return 22;
	}

	getTemplateId(element: WorktreeTreeElement): string {
		return isWorktreeRepoGroup(element)
			? WorktreeRepoGroupRenderer.TEMPLATE_ID
			: WorktreeTreeRenderer.TEMPLATE_ID;
	}
}

// --- View Pane ---

export class WorktreeViewPane extends ViewPane {

	private tree!: WorkbenchCompressibleObjectTree<WorktreeTreeElement, void>;
	private dataProvider!: WorktreeTreeDataProvider;
	private renderer: WorktreeTreeRenderer;
	private groupRenderer: WorktreeRepoGroupRenderer;

	// Create worktree form elements
	private _createContainer!: HTMLElement;
	private _createInput!: HTMLInputElement;
	private _createBranchSelect!: HTMLSelectElement;
	private _createBranchInput!: HTMLInputElement;
	private _createNewBranchBtn!: HTMLButtonElement;
	private _isCreatingBranch!: boolean;
	private _createConfirmBtn!: HTMLButtonElement;
	private _createCancelBtn!: HTMLButtonElement;

	// Deleting state tracking
	private readonly _deletingWorktrees = new Set<string>();

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
		@IAccessibleViewInformationService accessibleViewInformationService: IAccessibleViewInformationService,
		@IWorktreeService private readonly _worktreeService: IWorktreeService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ISCMViewService private readonly _scmViewService: ISCMViewService,
		@IWorkspaceEditingService private readonly _workspaceEditingService: IWorkspaceEditingService,
		@ICommandService private readonly _commandService: ICommandService,
		) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, accessibleViewInformationService);
		this.renderer = new WorktreeTreeRenderer(
			(path) => this._deletingWorktrees.has(path),
			(item) => this.onDeleteWorktree(item),
			(item) => this.openWorktreeInNewWindow(item),
		);
		this.groupRenderer = new WorktreeRepoGroupRenderer();
	}

	override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// Ensure container uses flex layout so tree fills remaining space
		container.style.display = 'flex';
		container.style.flexDirection = 'column';

		this.dataProvider = this._register(this.instantiationService.createInstance(WorktreeTreeDataProvider));

		// Create form container (hidden by default)
		this._createContainer = dom.append(container, $('.worktree-create-container'));
		this._createContainer.style.display = 'none';
		this._buildCreateForm();

		const treeContainer = dom.append(container, $('.worktree-tree'));
		// Ensure tree container fills remaining flex space
		treeContainer.style.flex = '1';
		treeContainer.style.minHeight = '0';
		this.tree = <WorkbenchCompressibleObjectTree<WorktreeTreeElement, void>>this.instantiationService.createInstance(
			WorkbenchCompressibleObjectTree,
			'WorktreeTree',
			treeContainer,
			new WorktreeTreeDelegate(),
			[this.renderer, this.groupRenderer],
			{
				identityProvider: {
					getId: (element: WorktreeTreeElement) => element.id
				},
				horizontalScrolling: false,
				multipleSelectionSupport: false,
				compressionEnabled: false,
				accessibilityProvider: {
					getAriaLabel: (element: WorktreeTreeElement) => isWorktreeRepoGroup(element)
						? localize('worktreeRepoAriaLabel', 'Repository {0}', element.label)
						: localize('worktreeAriaLabel', 'Worktree {0} at {1}', element.label, element.path),
					getWidgetAriaLabel: () => localize('worktreeTreeAriaLabel', 'Worktree List'),
				},
			}
		);

		this._register(this.tree.onDidOpen(e => {
			if (e.element && !isWorktreeRepoGroup(e.element)) {
				this.openWorktree(e.element);
			}
		}));

		this._register(this.dataProvider.onDidChangeTreeData(() => {
			this.updateTree();
		}));

		// Set initial empty state
		this.tree.setChildren(null, []);

		// Initial refresh
		this.dataProvider.refresh();
	}

	private _buildCreateForm(): void {
		// Name row
		const nameRow = dom.append(this._createContainer, $('.worktree-create-row'));
		const nameLabel = dom.append(nameRow, $('label.worktree-create-label'));
		nameLabel.textContent = localize('worktreeCreateName', 'Name:');
		nameLabel.style.cssText = 'white-space: nowrap;';
		this._createInput = dom.append(nameRow, $('input.worktree-create-input')) as HTMLInputElement;
		this._createInput.type = 'text';
		this._createInput.placeholder = localize('worktreeCreateNamePlaceholder', 'worktree name');

		// Branch row
		const branchRow = dom.append(this._createContainer, $('.worktree-create-row'));
		const branchLabel = dom.append(branchRow, $('label.worktree-create-label'));
		branchLabel.textContent = localize('worktreeCreateBranch', 'Branch:');
		branchLabel.style.cssText = 'white-space: nowrap;';

		// Dropdown: existing branches
		this._createBranchSelect = dom.append(branchRow, $('select.worktree-create-select')) as HTMLSelectElement;
		this._createBranchSelect.style.flex = '1';
		this._createBranchSelect.addEventListener('change', () => {
			if (this._createBranchSelect.value === '__new__') {
				this._createBranchInput.style.display = '';
				this._createBranchInput.focus();
				this._isCreatingBranch = true;
			} else {
				this._createBranchInput.style.display = 'none';
				this._isCreatingBranch = false;
			}
		});

		// Inline input: new branch name (hidden by default)
		this._createBranchInput = dom.append(branchRow, $('input.worktree-create-input')) as HTMLInputElement;
		this._createBranchInput.type = 'text';
		this._createBranchInput.style.display = 'none';
		this._createBranchInput.placeholder = localize('worktreeCreateNewBranchPlaceholder', 'new branch name');

		// "New Branch" button
		this._createNewBranchBtn = dom.append(branchRow, $('button.worktree-create-btn')) as HTMLButtonElement;
		this._createNewBranchBtn.textContent = localize('worktreeCreateNewBranchBtn', '+ New');
		this._createNewBranchBtn.onclick = () => {
			this._createBranchSelect.value = '__new__';
			this._createBranchInput.style.display = '';
			this._createBranchInput.focus();
			this._isCreatingBranch = true;
		};

		// Buttons row
		const btnRow = dom.append(this._createContainer, $('.worktree-create-row'));
		this._createConfirmBtn = dom.append(btnRow, $('button.worktree-create-btn')) as HTMLButtonElement;
		this._createConfirmBtn.textContent = localize('worktreeCreateConfirm', 'Create');
		this._createConfirmBtn.onclick = () => this._confirmCreate();

		this._createCancelBtn = dom.append(btnRow, $('button.worktree-create-btn')) as HTMLButtonElement;
		this._createCancelBtn.textContent = localize('worktreeCreateCancel', 'Cancel');
		this._createCancelBtn.onclick = () => {
			this._createContainer.style.display = 'none';
		};
	}

	/** Show the inline create-worktree input box */
	async showCreateInput(): Promise<void> {
		this._createContainer.style.display = 'block';
		this._createInput.value = '';
		this._createBranchInput.value = '';
		// Populate branch dropdown (defaults to "create new branch")
		await this._populateBranchDropdown();
		this._createInput.focus();
	}

	private async _populateBranchDropdown(): Promise<void> {
		dom.clearNode(this._createBranchSelect);
		// Default empty option
		const defaultOpt = dom.append(this._createBranchSelect, $('option')) as HTMLOptionElement;
		defaultOpt.value = '';
		defaultOpt.label = localize('worktreeSelectBranchPlaceholder', '(select a branch or create new)');

		try {
			let repoRoot = await this._worktreeService.getRepositoryRoot();
			if (!repoRoot) {
				const folders = this._workspaceContextService.getWorkspace().folders;
				if (folders && folders.length > 0) {
					repoRoot = folders[0].uri.fsPath;
				}
			}
			if (repoRoot) {
				const branches = await this._worktreeService.listGitBranches(repoRoot);
				for (const branch of branches) {
					const opt = dom.append(this._createBranchSelect, $('option')) as HTMLOptionElement;
					opt.value = branch;
					opt.label = branch;
				}
			}
		} catch (e) {
			console.warn('[WorktreeView] _populateBranchDropdown error:', e);
		}
		// "Create new branch" option (default selection)
		const newOpt = dom.append(this._createBranchSelect, $('option')) as HTMLOptionElement;
		newOpt.value = '__new__';
		newOpt.label = localize('worktreeCreateNewBranchOption', '+ Create new branch...');
		this._createBranchSelect.value = '__new__';
		this._createBranchInput.style.display = '';
		this._isCreatingBranch = true;
	}

	private async _confirmCreate(): Promise<void> {
		const name = this._createInput.value.trim();
		if (!name) {
			this.notificationService.warn(localize('worktreeCreateEmptyName', 'Please enter a worktree name.'));
			return;
		}

		let branch: string | undefined;
		if (this._isCreatingBranch) {
			branch = this._createBranchInput.value.trim();
			if (!branch) {
				this.notificationService.warn(localize('worktreeCreateEmptyBranch', 'Please enter a branch name.'));
				return;
			}
		} else {
			branch = this._createBranchSelect.value || undefined;
		}

		this._createConfirmBtn.disabled = true;
		this._createConfirmBtn.textContent = localize('worktreeCreating', 'Creating...');

		try {
			const info = await this._worktreeService.makeWorktreeInfo({ name, branch });
			await this._worktreeService.createFromInfo(info);
			this._createContainer.style.display = 'none';
			await this.dataProvider.refresh();
		} catch (e) {
			this.notificationService.error(localize('worktreeCreateError', 'Failed to create worktree: {0}', (e as Error).message));
		} finally {
			this._createConfirmBtn.disabled = false;
			this._createConfirmBtn.textContent = localize('worktreeCreateConfirm', 'Create');
		}
	}

	private async updateTree(): Promise<void> {
		const groups = await this.dataProvider.getGroups();
		let treeElements: ICompressedTreeElement<WorktreeTreeElement>[];

		if (groups.length <= 1) {
			// Single repository (or none) — render a flat list of worktrees.
			const children = groups.length === 1 ? groups[0].worktrees : [];
			treeElements = children.map(c => ({ element: c }));
		} else {
			// Multiple related repositories — render a grouped two-level tree.
			treeElements = groups.map(group => ({
				element: group,
				collapsible: true,
				collapsed: false,
				children: group.worktrees.map(w => ({ element: w })),
			}));
		}

		this.tree.setChildren(null, treeElements);
	}

	override shouldShowWelcome(): boolean {
		return false;
	}

	private async openWorktree(item: WorktreeItem): Promise<void> {
		try {
			const worktreeUri = URI.file(item.path);

			// First, try to find an already-registered SCM repository for this worktree path.
			// If found, just focus the SCM view on it (changes/graph already point at it).
			const repository = this._scmViewService.repositories.find((r: ISCMRepository) =>
				r.provider.rootUri?.toString() === worktreeUri.toString()
			);

			if (repository) {
				this._scmViewService.focus(repository);
				return;
			}

			// The worktree is not the current workspace folder. Instead of opening a new
			// window, switch the active workspace folder to this worktree directory.
			// The Git extension re-discovers the repository for the new folder, which
			// automatically refreshes the Changes and Graph views in place.
			const currentFolders = this._workspaceContextService.getWorkspace().folders;
			const folderName = basename(worktreeUri) || item.label;
			const folderData = { uri: worktreeUri, name: folderName };

			if (currentFolders.length === 0) {
				await this._workspaceEditingService.addFolders([folderData], true);
			} else {
				// Replace the primary folder (index 0) with the worktree folder.
				await this._workspaceEditingService.updateFolders(0, currentFolders.length, [folderData], true);
			}

			// After the folder switch, try to focus the SCM repository for the new path
			// once it has been registered by the Git extension.
			this._focusRepositoryWhenReady(worktreeUri);
		} catch (e) {
			this.notificationService.error(localize('worktreeOpenError', 'Failed to switch to worktree: {0}', (e as Error).message));
		}
	}

	/**
	 * Open the worktree directory in a new VS Code window. Triggered by the
	 * dedicated "Open in VS Code" action button on each worktree item.
	 */
	private async openWorktreeInNewWindow(item: WorktreeItem): Promise<void> {
		try {
			const worktreeUri = URI.file(item.path);
			await this._commandService.executeCommand('vscode.openFolder', worktreeUri, { forceNewWindow: true });
		} catch (e) {
			this.notificationService.error(localize('worktreeOpenWindowError', 'Failed to open worktree in VS Code: {0}', (e as Error).message));
		}
	}

	/**
	 * Focus the SCM repository matching the given worktree URI. Because the Git
	 * extension registers repositories asynchronously after a workspace folder
	 * change, we retry for a short period until the repository appears.
	 */
	private _focusRepositoryWhenReady(worktreeUri: URI, attempt: number = 0): void {
		const repository = this._scmViewService.repositories.find((r: ISCMRepository) =>
			r.provider.rootUri?.toString() === worktreeUri.toString()
		);
		if (repository) {
			this._scmViewService.focus(repository);
			return;
		}
		// Give up after ~5 seconds (10 attempts * 500ms)
		if (attempt >= 10) {
			return;
		}
		const handle = setTimeout(() => this._focusRepositoryWhenReady(worktreeUri, attempt + 1), 500);
		this._register({ dispose: () => clearTimeout(handle) });
	}

	/** Handle worktree deletion with loading spinner */
	private async onDeleteWorktree(item: WorktreeItem): Promise<void> {
		const path = item.path;
		// Mark as deleting to show spinner
		this._deletingWorktrees.add(path);
		try {
			// Refresh tree to show spinner
			await this.dataProvider.refresh();
			// Execute deletion
			await this._worktreeService.removeWorktree(path);
			this.notificationService.info(localize('worktreeDeleted', 'Deleted worktree: {0}', item.label));
		} catch (e) {
			this.notificationService.error(localize('worktreeDeleteError', 'Failed to delete worktree: {0}', (e as Error).message));
		} finally {
			// Clear deleting state
			this._deletingWorktrees.delete(path);
			// Refresh tree to remove spinner
			await this.dataProvider.refresh();
		}
	}

	override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree.layout(height, width);
	}
}
