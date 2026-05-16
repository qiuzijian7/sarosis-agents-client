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
 * Global Workspace Toolbar — rendered above the Agent Studio editor group tab bar.
 * Allows switching workspaces across all Agent Studio panels (Chat, TaskBoard, Canvas).
 *
 * **Important**: The toolbar DOM is created and inserted immediately in the constructor,
 * regardless of whether `IAgentStudioService` is available. The service can be connected
 * later via `connectService()`. This decouples DOM creation from delayed service injection.
 */
export class AgentStudioWorkspaceToolbar extends Disposable {

	private readonly _element: HTMLElement;

	/** The root DOM element of the toolbar. */
	get element(): HTMLElement { return this._element; }

	private readonly _selectButton: HTMLElement;
	private readonly _dropdownContainer: HTMLElement;
	private readonly _listElement: HTMLElement;
	private readonly _badgeElement: HTMLElement;

	private _workspaces: Workspace[] = [];
	private _activeWorkspaceId: string | undefined;
	private _isDropdownOpen = false;
	private _agentStudioService: IAgentStudioService | undefined;
	private _fileDialogService: IFileDialogService | undefined;
	private _selectedFolderUri: URI | undefined;

	private readonly _disposables = this._register(new DisposableStore());

	/**
	 * Creates the toolbar DOM and inserts it as the first child of `parentElement`.
	 * The toolbar is fully functional visually from this point, but workspace data
	 * won't load until `connectService()` is called.
	 */
	constructor(
		parentElement: HTMLElement,
	) {
		super();

		// Create the toolbar element
		this._element = document.createElement('div');
		this._element.className = 'agent-studio-workspace-toolbar';
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
		console.log('[AgentStudioWorkspaceToolbar] constructor called, parent:', parentElement);

		// Left section: icon + select button + employee count badge
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

		// Badge (pure DOM — no innerHTML)
		this._badgeElement = document.createElement('div');
		this._badgeElement.className = 'astb-badge';
		this._badgeElement.appendChild(_svgIcon(12, 12, [
			'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
		]));
		const badgeCount = document.createElement('span');
		badgeCount.className = 'astb-badge-count';
		badgeCount.textContent = '0';
		this._badgeElement.appendChild(badgeCount);
		leftSection.appendChild(this._badgeElement);

		this._element.appendChild(leftSection);

		// Dropdown (positioned absolutely below the toolbar)
		this._dropdownContainer = document.createElement('div');
		this._dropdownContainer.className = 'astb-dropdown hidden';

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

		// Insert toolbar as the first child of the parent element (above the tab bar)
		if (parentElement.firstChild) {
			parentElement.insertBefore(this._element, parentElement.firstChild);
		} else {
			parentElement.appendChild(this._element);
		}
		console.log('[AgentStudioWorkspaceToolbar] inserted into DOM, parent.children:',
			parentElement.children.length, 'parent class:', parentElement.className);

		// Close dropdown on outside click
		this._disposables.add(DOM.addDisposableListener(document, 'mousedown', (e: MouseEvent) => {
			if (this._isDropdownOpen && !this._element.contains(e.target as Node)) {
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

		// Listen for workspace changes from service
		this._disposables.add(this._agentStudioService.onDidChangeWorkspace(() => {
			this._loadWorkspaces();
		}));

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

	private async _loadWorkspaces(): Promise<void> {
		if (!this._agentStudioService) {
			return; // Service not connected yet
		}
		try {
			this._workspaces = await this._agentStudioService.getWorkspaces();

			// Auto-select first workspace if none selected
			if (!this._activeWorkspaceId && this._workspaces.length > 0) {
				this._activeWorkspaceId = this._workspaces[0].id;
				// Fire event so webviews know
				this._fireWorkspaceChanged(this._activeWorkspaceId);
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

		// Update employee count badge
		const countEl = this._badgeElement.querySelector('.astb-badge-count');
		if (countEl) {
			const employeeCount = current?.employees?.length ?? 0;
			countEl.textContent = String(employeeCount);
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
		this._renderDropdownList();
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

		for (const ws of this._workspaces) {
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

			if (ws.id === this._activeWorkspaceId) {
				const checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
				checkSvg.setAttribute('viewBox', '0 0 24 24');
				checkSvg.setAttribute('fill', 'none');
				checkSvg.setAttribute('stroke', 'currentColor');
				checkSvg.setAttribute('width', '14');
				checkSvg.setAttribute('height', '14');
				const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				path.setAttribute('stroke-linecap', 'round');
				path.setAttribute('stroke-linejoin', 'round');
				path.setAttribute('stroke-width', '2');
				path.setAttribute('d', 'M5 13l4 4L19 7');
				checkSvg.appendChild(path);
				item.appendChild(checkSvg);
			}

			item.addEventListener('click', () => {
				this._activeWorkspaceId = ws.id;
				this._fireWorkspaceChanged(ws.id);
				this._closeDropdown();
				this._updateUI();
			});
			this._listElement.appendChild(item);
		}

		if (this._workspaces.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'astb-dropdown-empty';
			empty.textContent = '暂无工作区';
			this._listElement.appendChild(empty);
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
		folderPathLabel.textContent = '未选择文件夹（可选）';

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
			return;
		}
		if (!this._agentStudioService) {
			console.error('[AgentStudioWorkspaceToolbar] _submitCreate: agentStudioService is not connected!');
			return;
		}

		console.log('[AgentStudioWorkspaceToolbar] _submitCreate: creating workspace...', { name: trimmed, path: this._selectedFolderUri?.fsPath });

		try {
			const createData: Partial<Workspace> = { name: trimmed };
			if (this._selectedFolderUri) {
				createData.path = this._selectedFolderUri.fsPath || this._selectedFolderUri.path;
			}
			const newWorkspace = await this._agentStudioService.createWorkspace(createData);
			console.log('[AgentStudioWorkspaceToolbar] _submitCreate: workspace created', newWorkspace);
			this._activeWorkspaceId = newWorkspace.id;
			this._selectedFolderUri = undefined;
			this._fireWorkspaceChanged(newWorkspace.id);
			this._closeDropdown();
			await this._loadWorkspaces();
		} catch (err) {
			console.error('[AgentStudioWorkspaceToolbar] _submitCreate: FAILED', err);
		}
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
