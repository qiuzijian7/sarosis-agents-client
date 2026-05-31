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
import { ICommandService } from '../../../../platform/commands/common/commands.js';
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
import { ViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IAccessibleViewInformationService } from '../../../../workbench/services/accessibility/common/accessibleViewInformationService.js';
import { WorktreeItem, WorktreeTreeDataProvider } from './worktreeDataProvider.js';
import { WorktreeCommands } from '../common/worktreeTypes.js';
import { IWorktreeService } from '../common/worktreeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

const $ = dom.$;

// --- Tree Renderer ---

class WorktreeTreeRenderer implements ICompressibleTreeRenderer<WorktreeItem, void, IWorktreeTemplateData> {
	static readonly TEMPLATE_ID = 'worktreeItem';

	constructor(
		private readonly _isDeleting: (path: string) => boolean,
		private readonly _onDelete: (item: WorktreeItem) => void,
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

		// Render actions (remove button for non-main worktrees, spinner when deleting)
		dom.clearNode(templateData.actions);
		if (isDeleting) {
			// Show loading spinner
			const spinner = dom.append(templateData.actions, $('.worktree-item-spinner'));
			spinner.title = localize('worktreeDeleting', 'Deleting...');
		} else if (!item.worktree.isMain) {
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

// --- Tree Delegate ---

class WorktreeTreeDelegate implements IListVirtualDelegate<WorktreeItem> {
	getHeight(_element: WorktreeItem): number {
		return 22;
	}

	getTemplateId(_element: WorktreeItem): string {
		return WorktreeTreeRenderer.TEMPLATE_ID;
	}
}

// --- View Pane ---

export class WorktreeViewPane extends ViewPane {

	private tree!: WorkbenchCompressibleObjectTree<WorktreeItem, void>;
	private dataProvider!: WorktreeTreeDataProvider;
	private renderer: WorktreeTreeRenderer;

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
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, accessibleViewInformationService);
		this.renderer = new WorktreeTreeRenderer(
			(path) => this._deletingWorktrees.has(path),
			(item) => this.onDeleteWorktree(item),
		);
	}

	override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.dataProvider = this._register(this.instantiationService.createInstance(WorktreeTreeDataProvider));

		// Create form container (hidden by default)
		this._createContainer = dom.append(container, $('.worktree-create-container'));
		this._createContainer.style.display = 'none';
		this._buildCreateForm();

		const treeContainer = dom.append(container, $('.worktree-tree'));
		this.tree = <WorkbenchCompressibleObjectTree<WorktreeItem, void>>this.instantiationService.createInstance(
			WorkbenchCompressibleObjectTree,
			'WorktreeTree',
			treeContainer,
			new WorktreeTreeDelegate(),
			[this.renderer],
			{
				identityProvider: {
					getId: (element: WorktreeItem) => element.id
				},
				horizontalScrolling: false,
				multipleSelectionSupport: false,
				accessibilityProvider: {
					getAriaLabel: (element: WorktreeItem) => localize('worktreeAriaLabel', 'Worktree {0} at {1}', element.label, element.path),
					getWidgetAriaLabel: () => localize('worktreeTreeAriaLabel', 'Worktree List'),
				},
			}
		);

		this._register(this.tree.onDidOpen(e => {
			if (e.element) {
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
		const children = await this.dataProvider.getChildren();
		const treeElements: ICompressedTreeElement<WorktreeItem>[] = children.map(c => ({
			element: c,
		}));
		this.tree.setChildren(null, treeElements);
	}

	override shouldShowWelcome(): boolean {
		return false;
	}

	private async openWorktree(item: WorktreeItem): Promise<void> {
		try {
			await this.commandService.executeCommand(WorktreeCommands.Open, item.path);
		} catch (e) {
			this.notificationService.error(localize('worktreeOpenError', 'Failed to open worktree: {0}', (e as Error).message));
		}
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
