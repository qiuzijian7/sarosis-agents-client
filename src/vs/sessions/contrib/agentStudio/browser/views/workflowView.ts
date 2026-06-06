/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import { $ } from '../../../../../base/browser/dom.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { ICrewTeamService, type ICrew, type IWorkflow } from '../../common/crewTeam.js';
import { WorkflowEditorInput } from '../workflowEditorInput.js';

/**
 * Workflow View - 工作流管理面板 (ActivityBar Sidebar)
 *
 * 功能：
 * - 显示当前 active workspace 下所有 Crew 的工作流列表
 * - 支持刷新
 * - 点击工作流 item 在编辑器区域打开 Workflow EditorPane
 * - 空状态提示
 */
export class WorkflowViewPane extends ViewPane {

	private _root!: HTMLElement;
	private _listContainer!: HTMLElement;
	private _headerContainer!: HTMLElement;
	private _workflows: IWorkflow[] = [];
	private _crews: ICrew[] = [];
	private _loading = false;
	private _creating = false;

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
		@IEditorService private readonly editorService: IEditorService,
		@ICrewTeamService private readonly crewTeamService: ICrewTeamService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._root = $('div.workflow-view-root');
		container.appendChild(this._root);

		// ─── Inject scoped styles ──────────────────────────────────
		const styleEl = document.createElement('style');
		styleEl.textContent = this._getScopedCSS();
		this._root.appendChild(styleEl);

		// ─── Header with action buttons ─────────────────────────
		this._headerContainer = $('div.workflow-header');
		const title = $('h3.workflow-title');
		title.textContent = 'Workflows';
		this._headerContainer.appendChild(title);

		const actionsGroup = $('div.workflow-header-actions');

		const createBtn = $('button.workflow-create-btn');
		createBtn.textContent = '+ Create';
		createBtn.title = 'Create a new Workflow';
		createBtn.onclick = () => { void this._showCreateForm(); };
		actionsGroup.appendChild(createBtn);

		const refreshBtn = $('button.workflow-refresh-btn');
		refreshBtn.textContent = '↻ Refresh';
		refreshBtn.title = 'Refresh Workflow list';
		refreshBtn.onclick = () => { void this._reload(); };
		actionsGroup.appendChild(refreshBtn);

		this._headerContainer.appendChild(actionsGroup);
		this._root.appendChild(this._headerContainer);

		// ─── List container ───────────────────────────────────────
		this._listContainer = $('div.workflow-list');
		this._root.appendChild(this._listContainer);

		// ─── Initial load ─────────────────────────────────────────
		void this._reload();
	}

	private async _reload(): Promise<void> {
		if (this._loading) { return; }
		this._loading = true;
		this._renderLoading();

		try {
			// Gather workflows from all crews
			const allWorkflows: IWorkflow[] = [];
			const crews = await this.crewTeamService.listCrews();
			for (const crew of crews) {
				const workflows = await this.crewTeamService.listWorkflows(crew.id);
				for (const wf of workflows) {
					allWorkflows.push({ ...wf, _crewName: crew.name } as IWorkflow & { _crewName: string });
				}
			}

			this._workflows = allWorkflows;
			if (allWorkflows.length === 0) {
				this._renderEmpty('No workflows found');
			} else {
				this._renderList();
			}
		} catch (err) {
			this._workflows = [];
			this._renderEmpty('Failed to load workflows');
		} finally {
			this._loading = false;
		}
	}

	private _renderLoading(): void {
		this._listContainer.innerHTML = '';
		const loading = $('div.workflow-loading');
		loading.textContent = 'Loading...';
		this._listContainer.appendChild(loading);
	}

	private _renderEmpty(message: string): void {
		this._listContainer.innerHTML = '';
		const empty = $('div.workflow-empty');
		empty.textContent = message;
		this._listContainer.appendChild(empty);
	}

	private _renderList(): void {
		this._listContainer.innerHTML = '';

		for (const wf of this._workflows) {
			const item = $('div.workflow-item');
			item.title = wf.description || wf.name;

			const nameEl = $('div.workflow-item-name');
			nameEl.textContent = wf.name;
			item.appendChild(nameEl);

			if (wf.description) {
				const descEl = $('div.workflow-item-desc');
				descEl.textContent = wf.description.length > 80
					? wf.description.substring(0, 80) + '...'
					: wf.description;
				item.appendChild(descEl);
			}

			const metaEl = $('div.workflow-item-meta');
			const stepCount = wf.steps?.length ?? 0;
			const crewName = (wf as any)._crewName;
			const parts: string[] = [];
			if (crewName) { parts.push(crewName); }
			parts.push(`${stepCount} steps`);
			parts.push(wf.isActive ? 'Active' : 'Inactive');
			metaEl.textContent = parts.join(' · ');
			item.appendChild(metaEl);

			item.onclick = () => this._openWorkflow(wf);
			this._listContainer.appendChild(item);
		}
	}

	private _openWorkflow(wf: IWorkflow): void {
		const input = new WorkflowEditorInput(wf);
		this.editorService.openEditor(input, { pinned: true });
	}

	// ─── Create Workflow ────────────────────────────────────────

	private _buildCreateForm(): HTMLElement {
		const form = $('div.workflow-create-form');

		// Crew selector
		const crewRow = $('div.workflow-form-row');
		const crewLabel = $('label.workflow-form-label');
		crewLabel.textContent = 'Crew';
		crewRow.appendChild(crewLabel);
		const crewSelect = $('select.workflow-form-select') as HTMLSelectElement;
		crewSelect.id = 'workflow-create-crew';
		// Populate crew options
		if (this._crews.length === 0) {
			const opt = document.createElement('option');
			opt.textContent = 'No Crews available';
			opt.disabled = true;
			crewSelect.appendChild(opt);
		} else {
			for (const crew of this._crews) {
				const opt = document.createElement('option');
				opt.value = crew.id;
				opt.textContent = crew.name;
				crewSelect.appendChild(opt);
			}
		}
		crewRow.appendChild(crewSelect);
		form.appendChild(crewRow);

		// Name input
		const nameRow = $('div.workflow-form-row');
		const nameLabel = $('label.workflow-form-label');
		nameLabel.textContent = 'Name';
		nameRow.appendChild(nameLabel);
		const nameInput = $('input.workflow-form-text');
		nameInput.setAttribute('type', 'text');
		nameInput.setAttribute('placeholder', 'My Workflow');
		nameInput.id = 'workflow-create-name';
		nameRow.appendChild(nameInput);
		form.appendChild(nameRow);

		// Description input
		const descRow = $('div.workflow-form-row');
		const descLabel = $('label.workflow-form-label');
		descLabel.textContent = 'Description';
		descRow.appendChild(descLabel);
		const descInput = $('input.workflow-form-text');
		descInput.setAttribute('type', 'text');
		descInput.setAttribute('placeholder', 'Optional description');
		descInput.id = 'workflow-create-desc';
		descRow.appendChild(descInput);
		form.appendChild(descRow);

		// Buttons row
		const btnsRow = $('div.workflow-form-buttons');
		const submitBtn = $('button.workflow-form-submit');
		submitBtn.textContent = 'Create';
		submitBtn.onclick = (e) => { e.stopPropagation(); void this._handleCreate(); };
		btnsRow.appendChild(submitBtn);

		const cancelBtn = $('button.workflow-form-cancel');
		cancelBtn.textContent = 'Cancel';
		cancelBtn.onclick = (e) => { e.stopPropagation(); this._hideCreateForm(); };
		btnsRow.appendChild(cancelBtn);
		form.appendChild(btnsRow);

		return form;
	}

	/**
	 * Insert the create form into the DOM right after the header.
	 * Uses dynamic insertion (not pre-built + toggle) to avoid
	 * stale-element bugs when renderBody is called multiple times.
	 */
	private _insertCreateForm(form: HTMLElement): void {
		// Remove any existing create form first
		const existing = this._root.querySelector('.workflow-create-form');
		if (existing) {
			existing.remove();
		}
		// Insert after header, before list
		if (this._headerContainer?.nextSibling) {
			this._root.insertBefore(form, this._headerContainer.nextSibling);
		} else {
			this._root.appendChild(form);
		}
	}

	private async _showCreateForm(): Promise<void> {
		if (this._creating) { return; }
		this._creating = true;

		// Load crews for the selector
		this._crews = [];
		try {
			this._crews = await this.crewTeamService.listCrews();
		} catch { /* ignore — selector will be empty */ }

		// Build and insert form dynamically into current DOM root
		const form = this._buildCreateForm();
		this._insertCreateForm(form);
	}

	private _hideCreateForm(): void {
		const existing = this._root.querySelector('.workflow-create-form');
		if (existing) {
			existing.remove();
		}
		this._creating = false;
	}

	private async _handleCreate(): Promise<void> {
		const crewSelect = this._root.querySelector('#workflow-create-crew') as HTMLSelectElement;
		const nameInput = this._root.querySelector('#workflow-create-name') as HTMLInputElement;
		const descInput = this._root.querySelector('#workflow-create-desc') as HTMLInputElement;

		const crewId = crewSelect?.value;
		const name = nameInput?.value?.trim();
		const description = descInput?.value?.trim();

		if (!crewId) {
			this._flashMessage('Please select a Crew');
			return;
		}
		if (!name) {
			this._flashMessage('Please enter a name');
			return;
		}

		try {
			await this.crewTeamService.defineWorkflow(crewId, name, description || '', []);
			this._hideCreateForm();
			await this._reload();
		} catch (err) {
			this._flashMessage('Failed to create workflow');
		}
	}

	private _flashMessage(message: string): void {
		// Find or create a flash message element
		let flash = this._root.querySelector('.workflow-flash-msg') as HTMLElement;
		if (!flash) {
			flash = $('div.workflow-flash-msg');
			this._headerContainer?.after(flash);
		}
		flash.textContent = message;
		flash.classList.add('visible');
		setTimeout(() => {
			flash.classList.remove('visible');
		}, 2500);
	}

	private _getScopedCSS(): string {
		return /* css */`
			.workflow-view-root {
				display: flex;
				flex-direction: column;
				height: 100%;
				overflow: hidden;
				font-size: 13px;
				color: var(--vscode-foreground);
			}
			.workflow-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				padding: 8px 12px;
				border-bottom: 1px solid var(--vscode-panel-border);
				flex-shrink: 0;
			}
			.workflow-title {
				margin: 0;
				font-size: 12px;
				font-weight: 600;
				text-transform: uppercase;
				color: var(--vscode-descriptionForeground);
			}
			.workflow-header-actions {
				display: flex;
				gap: 6px;
				align-items: center;
			}
			.workflow-create-btn {
				background: var(--vscode-button-background);
				border: none;
				color: var(--vscode-button-foreground);
				padding: 3px 10px;
				border-radius: 3px;
				cursor: pointer;
				font-size: 11px;
				font-weight: 600;
			}
			.workflow-create-btn:hover {
				background: var(--vscode-button-hoverBackground);
			}
			.workflow-refresh-btn {
				background: none;
				border: 1px solid var(--vscode-panel-border);
				color: var(--vscode-foreground);
				padding: 2px 8px;
				border-radius: 3px;
				cursor: pointer;
				font-size: 11px;
			}
			.workflow-refresh-btn:hover {
				background: var(--vscode-toolbar-hoverBackground);
			}
			.workflow-list {
				flex: 1;
				overflow-y: auto;
				padding: 4px 0;
			}
			.workflow-item {
				padding: 8px 12px;
				cursor: pointer;
				border-bottom: 1px solid var(--vscode-panel-border);
				transition: background 0.1s;
			}
			.workflow-item:hover {
				background: var(--vscode-list-hoverBackground);
			}
			.workflow-item-name {
				font-weight: 600;
				font-size: 13px;
				margin-bottom: 2px;
				color: var(--vscode-foreground);
			}
			.workflow-item-desc {
				font-size: 11px;
				color: var(--vscode-descriptionForeground);
				margin-bottom: 4px;
				line-height: 1.4;
			}
			.workflow-item-meta {
				font-size: 10px;
				color: var(--vscode-badge-foreground);
			}
			.workflow-empty,
			.workflow-loading {
				padding: 20px 12px;
				text-align: center;
				color: var(--vscode-descriptionForeground);
				font-size: 12px;
			}

			/* Create form — inserted dynamically, removed on cancel/submit */
			.workflow-create-form {
				padding: 12px;
				border-bottom: 1px solid var(--vscode-panel-border);
				background: var(--vscode-textBlockQuote-background);
			}
			.workflow-form-row {
				display: flex;
				align-items: center;
				gap: 8px;
				margin-bottom: 8px;
			}
			.workflow-form-label {
				flex-shrink: 0;
				width: 70px;
				font-size: 11px;
				font-weight: 600;
				color: var(--vscode-descriptionForeground);
				text-align: right;
			}
			.workflow-form-select,
			.workflow-form-text {
				flex: 1;
				padding: 4px 6px;
				font-size: 12px;
				border: 1px solid var(--vscode-input-border);
				background: var(--vscode-input-background);
				color: var(--vscode-input-foreground);
				border-radius: 3px;
			}
			.workflow-form-buttons {
				display: flex;
				gap: 6px;
				justify-content: flex-end;
				margin-top: 8px;
			}
			.workflow-form-submit {
				background: var(--vscode-button-background);
				border: none;
				color: var(--vscode-button-foreground);
				padding: 4px 14px;
				border-radius: 3px;
				cursor: pointer;
				font-size: 11px;
				font-weight: 600;
			}
			.workflow-form-submit:hover {
				background: var(--vscode-button-hoverBackground);
			}
			.workflow-form-cancel {
				background: none;
				border: 1px solid var(--vscode-panel-border);
				color: var(--vscode-foreground);
				padding: 4px 14px;
				border-radius: 3px;
				cursor: pointer;
				font-size: 11px;
			}
			.workflow-form-cancel:hover {
				background: var(--vscode-toolbar-hoverBackground);
			}

			/* Flash message */
			.workflow-flash-msg {
				display: none;
				padding: 6px 12px;
				font-size: 11px;
				text-align: center;
				color: var(--vscode-inputValidation-warningForeground);
				background: var(--vscode-inputValidation-warningBackground);
				border-bottom: 1px solid var(--vscode-inputValidation-warningBorder);
				transition: opacity 0.3s;
			}
			.workflow-flash-msg.visible {
				display: block;
			}
		`;
	}
}
