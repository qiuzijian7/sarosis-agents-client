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
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { ViewPane, IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IAccessibleViewInformationService } from '../../../../workbench/services/accessibility/common/accessibleViewInformationService.js';
import { WorktreeItem, WorktreeTreeDataProvider, WorktreeRepoGroup, WorktreeTreeElement, isWorktreeRepoGroup } from './worktreeDataProvider.js';
import { IWorktreeService } from '../common/worktreeService.js';
import { slugify } from './worktreeService.js';
import { IWorktreeCheckpointService } from '../common/worktreeCheckpointService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISCMViewService, ISCMRepository } from '../../../../workbench/contrib/scm/common/scm.js';
import { IGitService } from '../../../../workbench/contrib/git/common/gitService.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';

const $ = dom.$;

// --- Tree Renderer ---

class WorktreeTreeRenderer implements ICompressibleTreeRenderer<WorktreeItem, void, IWorktreeTemplateData> {
	static readonly TEMPLATE_ID = 'worktreeItem';

	constructor(
		private readonly _isDeleting: (path: string) => boolean,
		private readonly _onDelete: (item: WorktreeItem) => void,
		private readonly _onOpen: (item: WorktreeItem) => void,
		private readonly _onCreateCheckpoint: (item: WorktreeItem) => void,
		private readonly _onDebug: (item: WorktreeItem, e: MouseEvent) => void,
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

		// 右键 worktree item → 「调试」菜单（oncontextmenu 赋值覆盖，避免重复注册）
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

		// "Debug" button (compile worktree out/ and launch a VsSaros instance).
		// 2026-08-17: 调试入口从「右键菜单」改为「actions 栏图标按钮」（与打开/检查点/删除一致）；
		// 与 Source Control 视图「调试按钮」入口一致，main 也可调。
		const debugBtn = dom.append(templateData.actions, $('a.worktree-item-action'));
		debugBtn.setAttribute('role', 'button');
		debugBtn.setAttribute('title', localize('worktreeDebug', '调试 (compile worktree out/ and launch a VsSaros instance)'));
		debugBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.debugStart));
		debugBtn.onclick = (e) => {
			e.stopPropagation();
			this._onDebug(item, e);
		};
	}

		if (!isDeleting && !item.worktree.isMain) {
			// Checkpoint button
			const checkpointBtn = dom.append(templateData.actions, $('a.worktree-item-action'));
			checkpointBtn.setAttribute('role', 'button');
			checkpointBtn.setAttribute('title', localize('worktreeCreateCheckpoint', 'Create Checkpoint'));
			checkpointBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.save));
			checkpointBtn.onclick = (e) => {
				e.stopPropagation();
				this._onCreateCheckpoint(item);
			};

			// Remove button
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
	private _createBranchField!: HTMLElement;      // wraps label + select (existing-branch mode)
	private _createPreviewBranch!: HTMLSpanElement;
	private _createPreviewPath!: HTMLSpanElement;
	private _createConfirmBtn!: HTMLButtonElement;
	private _createCancelBtn!: HTMLButtonElement;
	private _segNewBtn!: HTMLButtonElement;
	private _segExistingBtn!: HTMLButtonElement;
	private _useExisting = false;

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
		@IWorktreeCheckpointService private readonly _checkpointService: IWorktreeCheckpointService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ISCMViewService private readonly _scmViewService: ISCMViewService,
		@IGitService private readonly _gitService: IGitService,
		@ICommandService private readonly _commandService: ICommandService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, accessibleViewInformationService);
		this.renderer = new WorktreeTreeRenderer(
			(path) => this._deletingWorktrees.has(path),
			(item) => this.onDeleteWorktree(item),
			(item) => this.openWorktreeInNewWindow(item),
			(item) => this._onCreateCheckpoint(item),
			(item, e) => this._debugWorktree(item, e),
		);
		this.groupRenderer = new WorktreeRepoGroupRenderer();
	}

	protected override renderBody(container: HTMLElement): void {
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
		// Name field
		const nameField = dom.append(this._createContainer, $('.worktree-create-field'));
		const nameLabel = dom.append(nameField, $('label.worktree-create-field-label'));
		nameLabel.textContent = localize('worktreeCreateName', 'Name');
		this._createInput = dom.append(nameField, $('input.worktree-create-input')) as HTMLInputElement;
		this._createInput.type = 'text';
		this._createInput.placeholder = localize('worktreeCreateNamePlaceholder', 'worktree name');
		this._createInput.addEventListener('input', () => this._updateCreatePreview());
		this._createInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				this._confirmCreate();
			} else if (e.key === 'Escape') {
				this._createContainer.style.display = 'none';
			}
		});

		// Branch source segmented control (replaces the old "Use existing branch" checkbox)
		const segField = dom.append(this._createContainer, $('.worktree-create-field'));
		const segLabel = dom.append(segField, $('label.worktree-create-field-label'));
		segLabel.textContent = localize('worktreeCreateBranchSource', 'Branch source');
		const seg = dom.append(segField, $('.worktree-create-segmented'));
		this._segNewBtn = dom.append(seg, $('button.worktree-create-segment.worktree-create-segment-active')) as HTMLButtonElement;
		this._segNewBtn.textContent = localize('worktreeCreateNewBranch', 'Create new branch');
		this._segNewBtn.onclick = () => this._setMode(false);
		this._segExistingBtn = dom.append(seg, $('button.worktree-create-segment')) as HTMLButtonElement;
		this._segExistingBtn.textContent = localize('worktreeCreateUseExisting', 'Use existing branch');
		this._segExistingBtn.onclick = () => this._setMode(true);

		// Existing branch selector (only visible in "existing" mode)
		this._createBranchField = dom.append(this._createContainer, $('.worktree-create-field'));
		this._createBranchField.style.display = 'none';
		const branchLabel = dom.append(this._createBranchField, $('label.worktree-create-field-label'));
		branchLabel.textContent = localize('worktreeCreateBranch', 'Branch');
		this._createBranchSelect = dom.append(this._createBranchField, $('select.worktree-create-select')) as HTMLSelectElement;
		this._createBranchSelect.addEventListener('change', () => this._updateCreatePreview());

		// Live preview card (branch + path rows)
		const preview = dom.append(this._createContainer, $('.worktree-create-preview'));
		const branchRow = dom.append(preview, $('.worktree-create-preview-row'));
		const branchKey = dom.append(branchRow, $('span.worktree-create-preview-key'));
		branchKey.textContent = localize('worktreeCreateBranchLabel', 'Branch');
		this._createPreviewBranch = dom.append(branchRow, $('span.worktree-create-preview-value')) as HTMLSpanElement;
		const pathRow = dom.append(preview, $('.worktree-create-preview-row'));
		const pathKey = dom.append(pathRow, $('span.worktree-create-preview-key'));
		pathKey.textContent = localize('worktreeCreatePathLabel', 'Path');
		this._createPreviewPath = dom.append(pathRow, $('span.worktree-create-preview-value')) as HTMLSpanElement;

		// Buttons row
		const btnRow = dom.append(this._createContainer, $('.worktree-create-actions'));
		this._createConfirmBtn = dom.append(btnRow, $('button.worktree-create-btn.worktree-create-btn-primary')) as HTMLButtonElement;
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
		this._setMode(false);
		// Resolve repo root (for the existing-branch dropdown) and populate it
		try {
			let repoRoot = await this._worktreeService.getRepositoryRoot();
			if (!repoRoot) {
				const folders = this._workspaceContextService.getWorkspace().folders;
				if (folders && folders.length > 0) {
					repoRoot = folders[0].uri.fsPath;
				}
			}
			await this._populateBranchDropdown(repoRoot);
		} catch (e) {
			console.warn('[WorktreeView] showCreateInput error:', e);
		}
		this._updateCreatePreview();
		this._createInput.focus();
	}

	private async _populateBranchDropdown(repoRoot: string | undefined): Promise<void> {
		dom.clearNode(this._createBranchSelect);
		try {
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
	}

	/** Live preview: branch is auto-derived from the name (branch = <slug>, no prefix). */
	private _updateCreatePreview(): void {
		const name = this._createInput.value.trim();
		const slug = name ? slugify(name) : '';
		if (this._useExisting) {
			this._setPreviewValue(this._createPreviewBranch, this._createBranchSelect.value);
		} else {
			this._setPreviewValue(this._createPreviewBranch, slug);
		}
		this._setPreviewValue(this._createPreviewPath, slug ? `.worktrees/${slug}` : '');
	}

	private _setPreviewValue(el: HTMLSpanElement, text: string): void {
		el.textContent = text || '—';
		el.classList.toggle('worktree-create-preview-value-empty', !text);
	}

	private _setMode(useExisting: boolean): void {
		this._useExisting = useExisting;
		this._segNewBtn.classList.toggle('worktree-create-segment-active', !useExisting);
		this._segExistingBtn.classList.toggle('worktree-create-segment-active', useExisting);
		this._createBranchField.style.display = useExisting ? '' : 'none';
		this._updateCreatePreview();
	}

	private async _confirmCreate(): Promise<void> {
		const name = this._createInput.value.trim();
		if (!name) {
			this.notificationService.warn(localize('worktreeCreateEmptyName', 'Please enter a worktree name.'));
			return;
		}

		let branch: string | undefined;
		if (this._useExisting) {
			branch = this._createBranchSelect.value || undefined;
			if (!branch) {
				this.notificationService.warn(localize('worktreeCreateSelectBranch', 'Please select an existing branch.'));
				return;
			}
		} else {
			// New-branch mode: pass the slug explicitly so makeWorktreeInfo uses it
			// as-is (override its `worktree/<name>` default fallback).
			const slug = slugify(name);
			if (!slug) {
				this.notificationService.warn(localize('worktreeCreateNameInvalid', 'Please enter a valid name.'));
				return;
			}
			branch = slug;
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
		console.log('[WT-DIAG][view] openWorktree FIRED. item.path=', item?.path, 'item.label=', item?.label, 'item.worktree.branch=', item?.worktree?.branch, 'serviceInstanceId=', (this._worktreeService as any)._diagId);
		try {
			const worktreeUri = URI.file(item.path);

			// Drive the sessions' custom Changes view (ChangesViewPane) via the
			// shared worktree-selection channel. This only has an effect when that
			// view is actually instantiated/visible; it is a no-op otherwise (the
			// view is lazy). Harmless to set unconditionally.
			this._worktreeService.setSelectedWorktree({ path: item.path, branch: item.worktree.branch });

			// THE key step (root cause of all prior failures): a linked worktree's
			// git repository is NOT registered in the SCM system unless something
			// explicitly opens it. The Git extension only auto-scans workspace
			// folders, and the worktree dir (<repoRoot>/.worktrees/<name>) is not a
			// workspace folder — so scmViewService.repositories only ever contained
			// the main repo, and focus() had no target. We must proactively register
			// the worktree repo via gitService.openRepository(), which makes the Git
			// extension's Model.openRepository() create a dedicated SCM provider for
			// this worktree root. Both the standard Changes (Source Control) view and
			// the Graph (SCMHistoryViewPane) read scmViewService, so once registered +
			// focused, BOTH switch to this worktree's branch.
			//
			// Trust the worktree root first, otherwise Model.openRepository() stalls
			// on requestResourceTrust and never registers the provider.
			try {
				if (!this._workspaceTrustManagementService.getTrustedUris().some(u => u.toString() === worktreeUri.toString())) {
					await this._workspaceTrustManagementService.setUrisTrust([worktreeUri], true);
				}
			} catch (err) {
				console.warn('[WorktreeView] Failed to mark worktree root as trusted:', err);
			}

			// First, see if it is already registered (e.g. the main worktree, or a
			// previously-opened one). If so, just focus it.
			let repository = this._findScmRepository(worktreeUri, /* silent */ true);
			if (!repository) {
				// Not registered yet — ask the Git extension to open/register it.
				console.log('[WT-DIAG][view] worktree repo not registered, calling gitService.openRepository for', worktreeUri.toString());
				await this._gitService.openRepository(worktreeUri);
				// Registration is asynchronous (the extension fires onDidOpenRepository
				// after status()). Poll a few times for it to appear in scmViewService.
				repository = await this._waitForScmRepository(worktreeUri);
			}

			if (repository) {
				// Narrow the visible repositories to JUST this worktree's repo BEFORE
				// focusing it. focus() has a visibility guard (scmViewService.focus:
				// `if (repository && !this.isVisible(repository)) return;`) so focusing
				// alone is a no-op when the repo is hidden. This drives BOTH the
				// standard Changes view and the Graph view to this worktree's branch.
				this._scmViewService.visibleRepositories = [repository];
				this._scmViewService.focus(repository);
				console.log('[WT-DIAG][view] focused SCM repository for worktree', worktreeUri.toString());
			} else {
				console.warn('[WorktreeView] Worktree repository did not register in time:', worktreeUri.toString(), '— Changes/Graph cannot switch.');
			}
		} catch (e) {
			this.notificationService.error(localize('worktreeOpenError', 'Failed to switch to worktree: {0}', (e as Error).message));
		}
	}

	/**
	 * Poll scmViewService for the worktree's SCM repository to appear after
	 * gitService.openRepository() was called. Registration is async (the Git
	 * extension fires onDidOpenRepository only after Repository.status()
	 * resolves), so we retry for up to ~5 seconds.
	 */
	private async _waitForScmRepository(worktreeUri: URI): Promise<ISCMRepository | undefined> {
		for (let attempt = 0; attempt < 25; attempt++) {
			const repo = this._findScmRepository(worktreeUri, /* silent */ true);
			if (repo) {
				return repo;
			}
			await new Promise<void>(resolve => setTimeout(resolve, 200));
		}
		this._findScmRepository(worktreeUri, /* silent */ false); // log the give-up diagnostic once
		return undefined;
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
	 * 触发该 worktree 的「调试」入口：打开集成终端面板，在其中执行编译命令并启动
	 * 独立 VsSaros 实例（或 dev server）。编译过程实时显示在终端里。
	 * 2026-08-17: actions 栏图标按钮点击 → 直接调用本方法（之前右键菜单链路已删除）。
	 * 同日: 改为 main 进程解析 build/launch 命令 → renderer 在集成终端执行。
	 */
	private async _debugWorktree(item: WorktreeItem, _e: MouseEvent): Promise<void> {
		console.log('[WT-DIAG][debug] _debugWorktree called for', item.path);
		// 1. 解析调试计划（检测项目类型 + 生成编译/启动命令，不做实际执行）
		let plan;
		try {
			plan = await this._worktreeService.resolveDebugPlan(item.path);
			console.log('[WT-DIAG][debug] resolveDebugPlan ->', JSON.stringify(plan));
		} catch (err) {
			console.error('[WT-DIAG][debug] resolveDebugPlan threw:', err);
			this.notificationService.error(localize('worktreeDebugFailed', '启动 worktree 调试失败: {0}', (err as Error).message));
			return;
		}
		if (!plan.success) {
			this.notificationService.error(localize('worktreeDebugFailed', '启动 worktree 调试失败: {0}', plan.stderr ?? 'unknown error'));
			return;
		}

		const commands = [plan.buildCommand, plan.launchCommand].filter((c): c is string => !!c);
		if (commands.length === 0) {
			this.notificationService.warn(localize('worktreeDebugNoCommand', '未找到 worktree [{0}] 的编译/启动命令', item.label));
			return;
		}

		// 2. 打开集成终端并执行命令（编译过程实时可见）
		try {
			console.log('[WT-DIAG][debug] creating terminal (cwd =', item.path + ')');
			const terminal = await this._terminalService.createAndFocusTerminal({
				cwd: item.path,
			});
			console.log('[WT-DIAG][debug] terminal created');
			// createAndFocusTerminal 只 setActiveInstance + focusWhenReady，不会打开 panel；
			// 必须显式 revealActiveTerminal() 才能打开 terminal panel（内部 showPanel → openView）。
			await this._terminalService.revealActiveTerminal();
			console.log('[WT-DIAG][debug] terminal panel revealed');
			await terminal.rename(localize('worktreeDebugTerminalName', 'worktree: {0}', plan.label ?? item.label));

			// 3. 按 shell 类型组装命令：PowerShell 5.1 不支持 `&&`（仅 PowerShell 7+），
			// 需用 `; if ($?) { ... }` 保留短路语义；引号路径的 exe 需 `&` 调用操作符。
			// 同时注入启动所需环境变量（如 vscode-fork 的 VSCODE_DEV=1）。
			const shellExe = terminal.shellLaunchConfig?.executable;
			const envPrefix = this._buildEnvPrefix(plan.env, shellExe);
			const command = envPrefix + this._joinCommandsForShell(commands, shellExe);
			console.log('[WT-DIAG][debug] shell =', shellExe, 'command =', command);
			await terminal.sendText(command, true);
			console.log('[WT-DIAG][debug] command sent to terminal');
		} catch (err) {
			console.error('[WT-DIAG][debug] terminal step threw:', err);
			this.notificationService.error(localize('worktreeDebugFailed', '启动 worktree 调试失败: {0}', (err as Error).message));
		}
	}

	/** 按 shell 类型把多条命令串成一条（PowerShell 5.1 不支持 &&，需 if($?) 短路）。 */
	private _joinCommandsForShell(commands: string[], shellExecutable: string | undefined): string {
		if (commands.length === 1) { return commands[0]; }
		const isPowerShell = !!shellExecutable && /(powershell|pwsh)\.exe$/i.test(shellExecutable);
		if (isPowerShell) {
			const [build, ...rest] = commands;
			const launch = rest.join(' && ');
			// PowerShell 中引号包裹的 exe 路径是字符串字面量，需 `&` 调用操作符才能执行
			const launchCmd = launch.startsWith('"') ? `& ${launch}` : launch;
			return `${build}; if ($?) { ${launchCmd} }`;
		}
		return commands.join(' && ');
	}

	/**
	 * 生成在终端里设置环境变量的前缀命令（按 shell 类型适配）。
	 * - PowerShell: `$env:KEY='VAL'; $env:KEY2='VAL2'; `
	 * - cmd:        `set "KEY=VAL" && set "KEY2=VAL2" && `
	 * - bash/sh:    `export KEY='VAL'; export KEY2='VAL2'; `
	 */
	private _buildEnvPrefix(env: Record<string, string> | undefined, shellExecutable: string | undefined): string {
		if (!env) { return ''; }
		const entries = Object.entries(env);
		if (entries.length === 0) { return ''; }
		const lower = (shellExecutable ?? '').toLowerCase();
		if (/(powershell|pwsh)\.exe$/.test(lower)) {
			return entries.map(([k, v]) => `$env:${k}='${v}'`).join('; ') + '; ';
		}
		if (/cmd\.exe$/.test(lower)) {
			return entries.map(([k, v]) => `set "${k}=${v}"`).join(' && ') + ' && ';
		}
		return entries.map(([k, v]) => `export ${k}='${v}'`).join('; ') + '; ';
	}

	/**
	 * Find the SCM repository whose root matches the given worktree URI.
	 *
	 * NOTE: we must NOT compare with `rootUri.toString() === worktreeUri.toString()`.
	 * On Windows the Git extension may register the repository root with a
	 * different drive-letter casing (e.g. `g:/...` vs `G:/...`) or a trailing
	 * slash than the `URI.file(item.path)` we build here, so a strict string
	 * compare silently fails and Changes/Graph never switch branches.
	 * `extUriBiasedIgnorePathCase.isEqual` performs a platform-aware comparison
	 * (case-insensitive on Windows/macOS for `file://` URIs), which fixes the
	 * regression introduced when worktrees moved under
	 * `<repoRoot>/.worktrees/<name>` (nested inside the main work tree).
	 */
	private _findScmRepository(worktreeUri: URI, silent: boolean = false): ISCMRepository | undefined {
		const match = this._scmViewService.repositories.find((r: ISCMRepository) =>
			!!r.provider.rootUri && extUriBiasedIgnorePathCase.isEqual(r.provider.rootUri, worktreeUri)
		);
		if (!match && !silent) {
			// Diagnostic: helps distinguish "registered but path mismatch" from
			// "not registered yet" when troubleshooting branch-switch failures.
			console.warn(
				'[WorktreeView] No SCM repository matched worktree',
				worktreeUri.toString(),
				'— known repo roots:',
				this._scmViewService.repositories.map(r => r.provider.rootUri?.toString())
			);
		}
		return match;
	}

	/** Handle checkpoint creation */
	private async _onCreateCheckpoint(item: WorktreeItem): Promise<void> {
		try {
			this.notificationService.info(localize('worktreeCreatingCheckpoint', 'Creating checkpoint for {0}...', item.label));

			// Use the worktree path as session ID for now
			// TODO: integrate with actual session lifecycle
			const sessionId = item.path;

			// Create baseline checkpoint
			const ref = await this._checkpointService.createBaselineCheckpoint(sessionId, item.path);
			if (ref) {
				this.notificationService.info(localize('worktreeCheckpointCreated', 'Checkpoint created: {0}', ref));
			} else {
				this.notificationService.error(localize('worktreeCheckpointFailed', 'Failed to create checkpoint'));
			}
		} catch (e) {
			this.notificationService.error(localize('worktreeCheckpointError', 'Error creating checkpoint: {0}', (e as Error).message));
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

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree.layout(height, width);
	}
}
