/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import type { Workspace } from '../common/types.js';
import * as DOM from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';

// ── SVG helper (avoids innerHTML — compliant with Trusted Types CSP) ──

const SVG_NS = 'http://www.w3.org/2000/svg';

function _svgIcon(width: number, height: number, paths: string[], cls?: string): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	if (cls) { svg.setAttribute('class', cls); }
	for (const d of paths) {
		const p = document.createElementNS(SVG_NS, 'path');
		p.setAttribute('stroke-linecap', 'round');
		p.setAttribute('stroke-linejoin', 'round');
		p.setAttribute('stroke-width', '2');
		p.setAttribute('d', d);
		svg.appendChild(p);
	}
	return svg;
}

/**
 * Visual variant of the workspace toolbar.
 *  - `overlay`  : floating bar above the Agent Studio editor group (legacy default).
 *                 Uses a forced dark inline style and shows the agent badge.
 *  - `titlebar` : embedded inside a host title area (e.g. the sidebar titlebar).
 *                 Drops the forced background/border + badge so it inherits the
 *                 surrounding theme, and anchors its dropdown with `fixed`
 *                 positioning so it is not clipped by an `overflow:hidden` host.
 */
export type WorkspaceToolbarVariant = 'overlay' | 'titlebar';

export interface IWorkspaceToolbarOptions {
	/** Visual variant. Defaults to `overlay` for backwards compatibility. */
	readonly variant?: WorkspaceToolbarVariant;
	/** Whether to show the agent-count badge. Defaults to true. */
	readonly showBadge?: boolean;
	/**
	 * Where to insert the toolbar element relative to `parentElement`.
	 *  - `prepend` (default): insert as the first child (overlay legacy behavior).
	 *  - `append`           : append as the last child.
	 */
	readonly insertMode?: 'prepend' | 'append';
}

/**
 * Global Workspace Toolbar — rendered above the Agent Studio editor group tab bar,
 * or embedded inside the sidebar titlebar (see {@link WorkspaceToolbarVariant}).
 * Allows switching workspaces across all Agent Studio panels (Chat, TaskBoard, Canvas).
 *
 * **Important**: The toolbar DOM is created and inserted immediately in the constructor,
 * regardless of whether `IAgentStudioService` is available. The service can be connected
 * later via `connectService()`. This decouples DOM creation from delayed service injection.
 */
export class AgentStudioWorkspaceToolbar extends Disposable {

	private readonly _variant: WorkspaceToolbarVariant;
	private readonly _showBadge: boolean;

	private readonly _element: HTMLElement;

	/** The root DOM element of the toolbar. */
	get element(): HTMLElement { return this._element; }

	private readonly _selectButton: HTMLElement;
	private readonly _dropdownContainer: HTMLElement;
	private readonly _searchInput: HTMLInputElement;
	private readonly _listElement: HTMLElement;
	private readonly _badgeElement: HTMLElement;

	private _workspaces: Workspace[] = [];
	private _activeWorkspaceId: string | undefined;
	private _isDropdownOpen = false;
	private _searchQuery = '';
	private _agentStudioService: IAgentStudioService | undefined;
	private _fileDialogService: IFileDialogService | undefined;
	private _fileService: IFileService | undefined;
	private _selectedFolderUri: URI | undefined;

	private readonly _disposables = this._register(new DisposableStore());

	/**
	 * Creates the toolbar DOM and inserts it as the first child of `parentElement`.
	 * The toolbar is fully functional visually from this point, but workspace data
	 * won't load until `connectService()` is called.
	 */
	constructor(
		parentElement: HTMLElement,
		options?: IWorkspaceToolbarOptions,
	) {
		super();

		this._variant = options?.variant ?? 'overlay';
		this._showBadge = options?.showBadge ?? (this._variant === 'overlay');
		const isTitlebar = this._variant === 'titlebar';

		// Create the toolbar element
		this._element = document.createElement('div');
		this._element.className = 'agent-studio-workspace-toolbar' + (isTitlebar ? ' astb-variant-titlebar' : '');
		if (isTitlebar) {
			// Titlebar variant: inherit the host theme. Keep layout-only inline
			// styles (no forced colors / borders) so it blends into the sidebar
			// title area. The dropdown anchors with `fixed` (see _openDropdown).
			this._element.style.cssText = [
				'display:flex',
				'align-items:center',
				'flex:1 1 auto',
				'min-width:0',
				'height:100%',
				'box-sizing:border-box',
				'position:relative',
			].join(';');
		} else {
			// [DEBUG] Inline style to force visibility regardless of CSS
			this._element.style.cssText = [
				'display:flex',
				'align-items:center',
				'justify-content:space-between',
				'height:32px',
				'min-height:32px',
				'padding:0 8px',
				'background:#1f2937',
				'border-bottom:1px solid #374151',
				'box-sizing:border-box',
				'flex-shrink:0',
				'position:relative',
				'z-index:10',
				'color:#e5e7eb',
				'font-size:12px',
			].join(';');
		}
		console.log('[AgentStudioWorkspaceToolbar] constructor called, variant:', this._variant, 'parent:', parentElement);

		// Left section: icon + select button + agent count badge
		const leftSection = document.createElement('div');
		leftSection.className = 'astb-left';

		// Building icon (pure DOM — no innerHTML)
		const icon = document.createElement('div');
		icon.className = 'astb-icon';
		icon.appendChild(_svgIcon(14, 14, [
			'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
		]));
		leftSection.appendChild(icon);

		// Workspace select button (pure DOM — no innerHTML)
		this._selectButton = document.createElement('button');
		this._selectButton.className = 'astb-select-btn';
		const selectLabel = document.createElement('span');
		selectLabel.className = 'astb-select-label';
		selectLabel.textContent = '选择工作区...';
		this._selectButton.appendChild(selectLabel);
		this._selectButton.appendChild(_svgIcon(12, 12, ['M19 9l-7 7-7-7'], 'astb-chevron'));
		this._selectButton.addEventListener('click', () => this._toggleDropdown());
		leftSection.appendChild(this._selectButton);

		// Badge (pure DOM — no innerHTML). Hidden in titlebar variant to save space.
		this._badgeElement = document.createElement('div');
		this._badgeElement.className = 'astb-badge';
		this._badgeElement.appendChild(_svgIcon(12, 12, [
			'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
		]));
		const badgeCount = document.createElement('span');
		badgeCount.className = 'astb-badge-count';
		badgeCount.textContent = '0';
		this._badgeElement.appendChild(badgeCount);
		if (this._showBadge) {
			leftSection.appendChild(this._badgeElement);
		}

		this._element.appendChild(leftSection);

		// Dropdown (positioned absolutely below the toolbar)
		this._dropdownContainer = document.createElement('div');
		this._dropdownContainer.className = 'astb-dropdown hidden';

		// Search input at the top of the dropdown
		const searchWrapper = document.createElement('div');
		searchWrapper.className = 'astb-dropdown-search';
		this._searchInput = document.createElement('input');
		this._searchInput.type = 'text';
		this._searchInput.className = 'astb-search-input';
		this._searchInput.placeholder = '搜索工作区...';
		this._searchInput.addEventListener('input', () => {
			this._searchQuery = this._searchInput.value;
			this._renderDropdownList();
		});
		this._searchInput.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				this._closeDropdown();
			}
		});
		const searchIcon = _svgIcon(14, 14, [
			'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
		]);
		searchIcon.setAttribute('class', 'astb-search-icon');
		searchWrapper.appendChild(searchIcon);
		searchWrapper.appendChild(this._searchInput);
		this._dropdownContainer.appendChild(searchWrapper);

		this._listElement = document.createElement('div');
		this._listElement.className = 'astb-dropdown-list';
		this._dropdownContainer.appendChild(this._listElement);

		// Create workspace button at the bottom of dropdown (pure DOM — no innerHTML)
		const createBtn = document.createElement('div');
		createBtn.className = 'astb-dropdown-create';
		createBtn.appendChild(_svgIcon(12, 12, ['M12 4v16m8-8H4']));
		const createBtnLabel = document.createElement('span');
		createBtnLabel.textContent = '创建新工作区';
		createBtn.appendChild(createBtnLabel);
		createBtn.addEventListener('click', () => this._showCreateInput());
		this._dropdownContainer.appendChild(createBtn);

		this._element.appendChild(this._dropdownContainer);

		// Insert toolbar relative to the parent element.
		//  - overlay  (default): as the first child (floats above the tab bar)
		//  - titlebar : as the last child unless caller asks otherwise, so it
		//               sits after the title label inside the host title area.
		const insertMode = options?.insertMode ?? (isTitlebar ? 'append' : 'prepend');
		if (insertMode === 'prepend' && parentElement.firstChild) {
			parentElement.insertBefore(this._element, parentElement.firstChild);
		} else {
			parentElement.appendChild(this._element);
		}
		console.log('[AgentStudioWorkspaceToolbar] inserted into DOM, parent.children:',
			parentElement.children.length, 'parent class:', parentElement.className);

		// Close dropdown on outside click
		this._disposables.add(DOM.addDisposableListener(document, 'mousedown', (e: MouseEvent) => {
			if (this._isDropdownOpen && !this._element.contains(e.target as Node) && !this._dropdownContainer.contains(e.target as Node)) {
				this._closeDropdown();
			}
		}));
	}

	/**
	 * Connect the toolbar to the `IAgentStudioService`.
	 * Can be called at any time after construction (including much later).
	 */
	connectService(service: IAgentStudioService): void {
		this._agentStudioService = service;

		// Listen for workspace data changes (create/update/delete)
		this._disposables.add(this._agentStudioService.onDidChangeWorkspace(() => {
			this._loadWorkspaces();
		}));

		// Listen for active workspace switches from other UI surfaces (e.g.,
		// workspace view pane, overlay toolbar, or programmatic calls to
		// setActiveWorkspace). Syncs the highlighted item and button label.
		if (this._agentStudioService.onDidChangeActiveWorkspace) {
			this._disposables.add(this._agentStudioService.onDidChangeActiveWorkspace((newId) => {
				if (newId !== this._activeWorkspaceId) {
					this._activeWorkspaceId = newId;
					this._updateUI();
					// Re-render dropdown list if it's open (to update active highlight)
					if (this._isDropdownOpen) {
						this._renderDropdownList();
					}
				}
			}));
		}

		// Initial load
		this._loadWorkspaces();
	}

	/**
	 * Connect the file dialog service for folder browsing.
	 * Can be called at any time after construction.
	 */
	connectFileDialogService(service: IFileDialogService): void {
		this._fileDialogService = service;
	}

	/**
	 * Connect the file service for empty-directory validation on workspace creation.
	 * Can be called at any time after construction.
	 */
	connectFileService(service: IFileService): void {
		this._fileService = service;
	}

	private async _loadWorkspaces(): Promise<void> {
		if (!this._agentStudioService) {
			return; // Service not connected yet
		}
		try {
			this._workspaces = await this._agentStudioService.getWorkspaces();

			// Auto-select workspace if none selected
			if (!this._activeWorkspaceId && this._workspaces.length > 0) {
				// 1. 尝试从缓存恢复上次活跃的工作区
				let restoredId: string | undefined;
				try {
					const cachedId = await this._agentStudioService.getLastActiveWorkspaceId();
					if (cachedId && this._workspaces.some(w => w.id === cachedId)) {
						restoredId = cachedId;
					}
				} catch {
					// 读取缓存失败，使用默认行为
				}

				// 2. 如果缓存无效，回退到第一个工作区
				this._activeWorkspaceId = restoredId ?? this._workspaces[0].id;

				// Fire event so webviews know + drive service-level linkage
				this._switchWorkspace(this._activeWorkspaceId);
			}

			this._updateUI();
		} catch (err) {
			// Silently handle - workspaces might not be ready yet
		}
	}

	private _updateUI(): void {
		const current = this._workspaces.find(w => w.id === this._activeWorkspaceId);
		const label = this._selectButton.querySelector('.astb-select-label');
		if (label) {
			label.textContent = current?.name ?? '选择工作区...';
		}

		// Update agent count badge
		const countEl = this._badgeElement.querySelector('.astb-badge-count');
		if (countEl) {
			const agentCount = current?.agents?.length ?? 0;
			countEl.textContent = String(agentCount);
		}

		// Update worktree status indicator
		let worktreeBadge = this._element.querySelector('.astb-worktree-badge') as HTMLElement | null;
		if (current?.worktreePath && current.worktreeStatus !== 'none') {
			if (!worktreeBadge) {
				worktreeBadge = document.createElement('div');
				worktreeBadge.className = 'astb-worktree-badge';
				worktreeBadge.style.cssText = [
					'display:inline-flex',
					'align-items:center',
					'gap:3px',
					'padding:2px 8px',
					'border-radius:6px',
					'font-size:10px',
					'margin-left:8px',
					'white-space:nowrap',
					'overflow:hidden',
					'text-overflow:ellipsis',
					'max-width:200px',
				].join(';');
				// Insert after the badge element
				const leftSection = this._element.querySelector('.astb-left');
				leftSection?.appendChild(worktreeBadge);
			}

			const statusIcon = current.worktreeStatus === 'ready' ? '🌿' :
				current.worktreeStatus === 'pending' ? '⏳' :
				current.worktreeStatus === 'failed' ? '❌' : '📁';

			const borderColor = current.worktreeStatus === 'ready' ? 'rgba(55, 148, 255, 0.25)' :
				current.worktreeStatus === 'pending' ? 'rgba(204, 167, 0, 0.3)' :
				current.worktreeStatus === 'failed' ? 'rgba(241, 76, 76, 0.25)' : 'transparent';

			const bgColor = current.worktreeStatus === 'ready' ? 'rgba(55, 148, 255, 0.08)' :
				current.worktreeStatus === 'pending' ? 'rgba(204, 167, 0, 0.08)' :
				current.worktreeStatus === 'failed' ? 'rgba(241, 76, 76, 0.08)' : 'transparent';

			const textColor = current.worktreeStatus === 'ready' ? '#3794ff' :
				current.worktreeStatus === 'pending' ? '#cca700' :
				current.worktreeStatus === 'failed' ? '#f14c4c' : '#e5e7eb';

			worktreeBadge.textContent = `${statusIcon} ${current.worktreeBranch || current.worktreePath.split(/[/\\]/).pop() || ''}`;
			worktreeBadge.title = current.worktreePath;
			worktreeBadge.style.borderColor = borderColor;
			worktreeBadge.style.backgroundColor = bgColor;
			worktreeBadge.style.color = textColor;
			worktreeBadge.style.border = `1px solid ${borderColor}`;
		} else if (worktreeBadge) {
			worktreeBadge.remove();
		}

		// Update dropdown list if open
		if (this._isDropdownOpen) {
			this._renderDropdownList();
		}
	}

	private _toggleDropdown(): void {
		if (this._isDropdownOpen) {
			this._closeDropdown();
		} else {
			this._openDropdown();
		}
	}

	private _openDropdown(): void {
		this._isDropdownOpen = true;
		this._dropdownContainer.classList.remove('hidden');
		this._selectButton.querySelector('.astb-chevron')?.classList.add('rotate');

		// Reset search state
		this._searchQuery = '';
		this._searchInput.value = '';

		// Titlebar variant: the sidebar part clips overflow, so an absolutely
		// positioned dropdown would be cut off. Pin it with `fixed` coordinates
		// anchored to the select button instead, and keep it in sync while open.
		if (this._variant === 'titlebar') {
			this._positionFixedDropdown();
			this._disposables.add(DOM.addDisposableListener(DOM.getWindow(this._element), 'resize', () => {
				if (this._isDropdownOpen) {
					this._positionFixedDropdown();
				}
			}));
		}

		this._renderDropdownList();

		// Focus search input for immediate typing
		setTimeout(() => this._searchInput.focus(), 0);
	}

	/** Pin the dropdown below the select button using fixed coordinates. */
	private _positionFixedDropdown(): void {
		const rect = this._selectButton.getBoundingClientRect();
		this._dropdownContainer.style.position = 'fixed';
		this._dropdownContainer.style.top = `${Math.round(rect.bottom + 4)}px`;
		this._dropdownContainer.style.left = `${Math.round(rect.left)}px`;
		this._dropdownContainer.style.minWidth = `${Math.max(220, Math.round(rect.width))}px`;
		this._dropdownContainer.style.zIndex = '2000';
	}

	private _closeDropdown(): void {
		this._isDropdownOpen = false;
		this._dropdownContainer.classList.add('hidden');
		this._selectButton.querySelector('.astb-chevron')?.classList.remove('rotate');

		// Remove any create input if present
		const createInput = this._dropdownContainer.querySelector('.astb-dropdown-create-input');
		if (createInput) {
			createInput.remove();
		}
	}

	private _renderDropdownList(): void {
		DOM.clearNode(this._listElement);

		// Filter workspaces by search query
		const query = this._searchQuery.toLowerCase().trim();
		const filtered = query
			? this._workspaces.filter(ws =>
				ws.name.toLowerCase().includes(query) ||
				(ws.path && ws.path.toLowerCase().includes(query)))
			: this._workspaces;

		for (const ws of filtered) {
			const item = document.createElement('div');
			item.className = `astb-dropdown-item${ws.id === this._activeWorkspaceId ? ' active' : ''}`;

			const textContainer = document.createElement('div');
			textContainer.className = 'astb-dropdown-item-text';

			const nameSpan = document.createElement('span');
			nameSpan.className = 'astb-dropdown-item-name';
			nameSpan.textContent = ws.name;
			textContainer.appendChild(nameSpan);

			// Show folder path if available
			if (ws.path) {
				const pathSpan = document.createElement('span');
				pathSpan.className = 'astb-dropdown-item-path';
				pathSpan.textContent = ws.path;
				pathSpan.title = ws.path;
				textContainer.appendChild(pathSpan);
			}

			item.appendChild(textContainer);

			// Right side: check icon (active) + delete button
			const actionsContainer = document.createElement('div');
			actionsContainer.className = 'astb-dropdown-item-actions';

			if (ws.id === this._activeWorkspaceId) {
				actionsContainer.appendChild(_svgIcon(14, 14, ['M5 13l4 4L19 7']));
			}

			// Delete button
			const deleteBtn = document.createElement('button');
			deleteBtn.className = 'astb-dropdown-item-delete';
			deleteBtn.title = '删除工作区';
			deleteBtn.appendChild(_svgIcon(12, 12, ['M6 18L18 6M6 6l12 12']));
			deleteBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this._confirmDeleteWorkspace(ws);
			});
			actionsContainer.appendChild(deleteBtn);

			item.appendChild(actionsContainer);

			item.addEventListener('click', () => {
				this._activeWorkspaceId = ws.id;
				this._switchWorkspace(ws.id);
				this._closeDropdown();
				this._updateUI();
			});
			this._listElement.appendChild(item);
		}

		if (filtered.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'astb-dropdown-empty';
			empty.textContent = query ? '没有匹配的工作区' : '暂无工作区';
			this._listElement.appendChild(empty);
		}
	}

	/**
	 * Confirm and delete a workspace.
	 */
	private async _confirmDeleteWorkspace(ws: Workspace): Promise<void> {
		const confirmed = window.confirm(`确定要删除工作区「${ws.name}」吗？此操作不可撤销。`);
		if (!confirmed) {
			return;
		}

		if (!this._agentStudioService) {
			console.error('[AgentStudioWorkspaceToolbar] Cannot delete: service not connected');
			return;
		}

		try {
			await this._agentStudioService.deleteWorkspace(ws.id);

			// If we deleted the active workspace, switch to another one
			if (ws.id === this._activeWorkspaceId) {
				const remaining = this._workspaces.filter(w => w.id !== ws.id);
				if (remaining.length > 0) {
					this._activeWorkspaceId = remaining[0].id;
					await this._switchWorkspace(remaining[0].id);
				} else {
					this._activeWorkspaceId = undefined;
				}
			}

			await this._loadWorkspaces();
		} catch (err) {
			console.error('[AgentStudioWorkspaceToolbar] Failed to delete workspace:', err);
		}
	}

	private _showCreateInput(): void {
		// Remove existing create input if any
		const existing = this._dropdownContainer.querySelector('.astb-dropdown-create-input');
		if (existing) {
			existing.remove();
			return;
		}

		// Reset selected folder
		this._selectedFolderUri = undefined;

		// ── Outer wrapper ──
		const createInputWrapper = document.createElement('div');
		createInputWrapper.className = 'astb-dropdown-create-input';

		// ── Row 1: name input + folder browse + confirm + cancel ──
		const inputRow = document.createElement('div');
		inputRow.className = 'astb-create-input-row';

		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = '输入工作区名称...';
		input.className = 'astb-create-input';
		input.maxLength = 50;

		// Folder browse button
		const browseBtn = document.createElement('button');
		browseBtn.className = 'astb-create-browse';
		browseBtn.title = '选择工作区文件夹';
		browseBtn.appendChild(_svgIcon(14, 14, [
			'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
		]));
		browseBtn.addEventListener('click', () => this._browseForFolder(folderPathLabel, input));

		const confirmBtn = document.createElement('button');
		confirmBtn.className = 'astb-create-confirm';
		confirmBtn.appendChild(_svgIcon(14, 14, ['M5 13l4 4L19 7']));
		confirmBtn.addEventListener('click', () => this._submitCreate(input.value));

		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'astb-create-cancel';
		cancelBtn.appendChild(_svgIcon(14, 14, ['M6 18L18 6M6 6l12 12']));
		cancelBtn.addEventListener('click', () => {
			this._selectedFolderUri = undefined;
			createInputWrapper.remove();
		});

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				this._submitCreate(input.value);
			} else if (e.key === 'Escape') {
				this._selectedFolderUri = undefined;
				createInputWrapper.remove();
			}
		});

		inputRow.appendChild(input);
		inputRow.appendChild(browseBtn);
		inputRow.appendChild(confirmBtn);
		inputRow.appendChild(cancelBtn);

		// ── Row 2: selected folder path display ──
		const folderPathLabel = document.createElement('div');
		folderPathLabel.className = 'astb-create-folder-path';
		folderPathLabel.textContent = '请选择工作区主目录（建议为空文件夹）';

		createInputWrapper.appendChild(inputRow);
		createInputWrapper.appendChild(folderPathLabel);

		// Insert before the "create" button
		const createBtnEl = this._dropdownContainer.querySelector('.astb-dropdown-create');
		if (createBtnEl) {
			this._dropdownContainer.insertBefore(createInputWrapper, createBtnEl);
		} else {
			this._dropdownContainer.appendChild(createInputWrapper);
		}

		input.focus();
	}

	/**
	 * Opens the native folder picker dialog and updates the path label.
	 * Also auto-fills the name input with the folder name if the input is empty.
	 */
	private async _browseForFolder(pathLabel: HTMLElement, nameInput?: HTMLInputElement): Promise<void> {
		if (!this._fileDialogService) {
			console.warn('[AgentStudioWorkspaceToolbar] IFileDialogService not connected');
			return;
		}

		const result = await this._fileDialogService.showOpenDialog({
			title: '选择工作区文件夹',
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
		});

		if (result && result.length > 0) {
			this._selectedFolderUri = result[0];
			const displayPath = result[0].fsPath || result[0].path;
			pathLabel.textContent = displayPath;
			pathLabel.title = displayPath;
			pathLabel.classList.add('has-folder');

			// Auto-fill name input with folder name if it's empty
			if (nameInput && !nameInput.value.trim()) {
				const segments = displayPath.split(/[/\\]/).filter(Boolean);
				const folderName = segments[segments.length - 1] || '';
				if (folderName) {
					nameInput.value = folderName;
				}
			}
		}
	}

	private async _submitCreate(name: string): Promise<void> {
		let trimmed = name.trim();

		// If no name but a folder is selected, derive name from folder path
		if (!trimmed && this._selectedFolderUri) {
			const fsPath = this._selectedFolderUri.fsPath || this._selectedFolderUri.path;
			// Extract last segment as workspace name (handles both / and \ separators)
			const segments = fsPath.split(/[/\\]/).filter(Boolean);
			trimmed = segments[segments.length - 1] || '';
		}

		if (!trimmed) {
			console.warn('[AgentStudioWorkspaceToolbar] _submitCreate: name is empty after trim');
			this._showCreateError('请输入工作区名称');
			return;
		}
		if (!this._agentStudioService) {
			console.error('[AgentStudioWorkspaceToolbar] _submitCreate: agentStudioService is not connected!');
			return;
		}

		// ① 主目录必填
		if (!this._selectedFolderUri) {
			this._showCreateError('请选择工作区主目录（必须为文件夹）');
			return;
		}

		// ② 校验为空目录（非空时弹确认）
		const isEmpty = await this._checkFolderEmpty(this._selectedFolderUri);
		if (!isEmpty) {
			const confirmed = window.confirm(
				'所选主目录非空，工作区元数据（.sarosisworkspace）将写入其中，可能与已有文件混合。\n\n建议选择一个空文件夹。是否仍要继续？'
			);
			if (!confirmed) {
				return;
			}
		}

		console.log('[AgentStudioWorkspaceToolbar] _submitCreate: creating workspace...', { name: trimmed, path: this._selectedFolderUri?.fsPath });

		try {
			const createData: Partial<Workspace> = {
				name: trimmed,
				path: this._selectedFolderUri.fsPath || this._selectedFolderUri.path,
				relatedFolders: [],
			};
			const newWorkspace = await this._agentStudioService.createWorkspace(createData);
			console.log('[AgentStudioWorkspaceToolbar] _submitCreate: workspace created', newWorkspace);
			this._activeWorkspaceId = newWorkspace.id;
			this._selectedFolderUri = undefined;
			// Route through the service so sandbox/SCM/tree/canvas all switch together.
			await this._switchWorkspace(newWorkspace.id);
			this._closeDropdown();
			await this._loadWorkspaces();
		} catch (err) {
			console.error('[AgentStudioWorkspaceToolbar] _submitCreate: FAILED', err);
			this._showCreateError('创建工作区失败，请查看控制台日志');
		}
	}

	/** Check whether a directory is empty (non-existent counts as empty). */
	private async _checkFolderEmpty(uri: URI): Promise<boolean> {
		if (!this._fileService) {
			return true; // Cannot validate without file service — don't block.
		}
		try {
			const stat = await this._fileService.resolve(uri);
			if (!stat.isDirectory) {
				return false;
			}
			return !stat.children || stat.children.length === 0;
		} catch {
			return true; // Doesn't exist → treat as creatable/empty.
		}
	}

	/** Show an inline error message inside the create-input wrapper. */
	private _showCreateError(message: string): void {
		const wrapper = this._dropdownContainer.querySelector('.astb-dropdown-create-input');
		if (!wrapper) {
			console.warn('[AgentStudioWorkspaceToolbar]', message);
			return;
		}
		let errEl = wrapper.querySelector('.astb-create-error') as HTMLElement | null;
		if (!errEl) {
			errEl = document.createElement('div');
			errEl.className = 'astb-create-error';
			errEl.style.cssText = 'color:#f87171;font-size:11px;margin-top:4px;';
			wrapper.appendChild(errEl);
		}
		errEl.textContent = message;
	}

	/**
	 * Switch the active workspace through the service (unified linkage path).
	 * Drives sandbox roots, SCM folder sync, ActivityBar tree, and canvas switch.
	 *
	 * setActiveWorkspace is the single source of truth: on success it fires the
	 * internal Emitter AND dispatches the `agent-studio:active-workspace-changed`
	 * DOM event itself, so WebView canvases switch too. We therefore only fall
	 * back to a manual DOM dispatch when the service is unavailable or throws —
	 * dispatching unconditionally would double-fire `workspace.activeChanged`.
	 */
	private async _switchWorkspace(id: string): Promise<void> {
		if (this._agentStudioService?.setActiveWorkspace) {
			try {
				await this._agentStudioService.setActiveWorkspace(id);
				return; // service already dispatched the DOM event
			} catch (err) {
				console.warn('[AgentStudioWorkspaceToolbar] setActiveWorkspace failed, falling back to DOM event', err);
				this._fireWorkspaceChanged(id);
				return;
			}
		}
		// Service unavailable — legacy fallback.
		this._fireWorkspaceChanged(id);
	}

	private _fireWorkspaceChanged(id: string): void {
		// The agentStudioService.onDidChangeWorkspace event is already fired
		// when workspace data changes. For switching the "active" workspace,
		// we need a way to communicate to webviews. We'll use a custom DOM event
		// that the workbench can subscribe to.
		// However, the service's onDidChangeWorkspace already fires for create/update/delete.
		// For a pure "switch" (no data change), we dispatch a custom event.
		const event = new CustomEvent('agent-studio:active-workspace-changed', {
			detail: { workspaceId: id }
		});
		document.dispatchEvent(event);
	}

	/**
	 * Get the currently active workspace ID (for external consumption).
	 */
	get activeWorkspaceId(): string | undefined {
		return this._activeWorkspaceId;
	}

	override dispose(): void {
		this._element.remove();
		super.dispose();
	}
}
