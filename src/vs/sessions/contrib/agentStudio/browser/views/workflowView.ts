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
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { $, clearNode } from '../../../../../base/browser/dom.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { IWorkflowStorageService, type IStoredWorkflow } from '../../common/workflowStorage.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import type { Employee } from '../../../../common/agentStudioTypes.js';
import { IModelSelectorService } from '../../common/modelSelector.js';
import { AGENT_STUDIO_CHAT_VIEW_ID } from '../../common/constants.js';
import { WorkflowEditorInput } from '../workflowEditorInput.js';
import { BUILTIN_PRESETS, type AgentPreset } from './presetAgentView.js';

const WORKFLOW_PRESET_ID = 'workflow-agent';

/**
 * Workflow View - 工作流管理面板 (ActivityBar Sidebar)
 *
 * 功能：
 * - 显示当前工作区 `.sarosisworkspace/workflows/` 下所有工作流（文件存储）
 * - 创建工作流：默认绑定 "Workflow Agent" 预设
 * - 点击工作流 item 在编辑器区域打开 Workflow EditorPane
 * - 执行工作流：确保对应 Agent 存在 → 选中 → 打开聊天框 → 注入执行指令
 */
export class WorkflowViewPane extends ViewPane {

	private _root!: HTMLElement;
	private _listContainer!: HTMLElement;
	private _headerContainer!: HTMLElement;
	private _workflows: IStoredWorkflow[] = [];
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
		@IViewsService private readonly viewsService: IViewsService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkflowStorageService private readonly workflowStorage: IWorkflowStorageService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IModelSelectorService private readonly modelSelectorService: IModelSelectorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// 工作流文件变化时刷新列表
		this._register(this.workflowStorage.onDidChangeWorkflows(() => {
			void this._reload();
		}));
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
			this._workflows = await this.workflowStorage.listWorkflows();
			if (this._workflows.length === 0) {
				this._renderEmpty('No workflows yet. Click "+ Create" to add one.');
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
		clearNode(this._listContainer);
		const loading = $('div.workflow-loading');
		loading.textContent = 'Loading...';
		this._listContainer.appendChild(loading);
	}

	private _renderEmpty(message: string): void {
		clearNode(this._listContainer);
		const empty = $('div.workflow-empty');
		empty.textContent = message;
		this._listContainer.appendChild(empty);
	}

	private _renderList(): void {
		clearNode(this._listContainer);

		for (const wf of this._workflows) {
			const item = $('div.workflow-item');
			item.title = wf.description || wf.name;

			// ── Main row: name + run button ──
			const topRow = $('div.workflow-item-top');

			const nameEl = $('div.workflow-item-name');
			nameEl.textContent = wf.name;
			topRow.appendChild(nameEl);

			const runBtn = $('button.workflow-run-btn');
			runBtn.textContent = '▶ Run';
			runBtn.title = 'Execute this workflow in the agent chat';
			runBtn.onclick = (e) => {
				e.stopPropagation();
				void this._runWorkflow(wf);
			};
			topRow.appendChild(runBtn);

			item.appendChild(topRow);

			if (wf.description) {
				const descEl = $('div.workflow-item-desc');
				descEl.textContent = wf.description.length > 80
					? wf.description.substring(0, 80) + '...'
					: wf.description;
				item.appendChild(descEl);
			}

			const metaEl = $('div.workflow-item-meta');
			const stepCount = wf.steps?.length ?? 0;
			const parts: string[] = [];
			parts.push('Workflow Agent');
			parts.push(`${stepCount} steps`);
			parts.push(wf.isActive ? 'Active' : 'Inactive');
			metaEl.textContent = parts.join(' · ');
			item.appendChild(metaEl);

			item.onclick = () => this._openWorkflow(wf);
			this._listContainer.appendChild(item);
		}
	}

	/**
	 * 打开工作流编辑器 + 同步在右侧聊天框显示对应 workflow agent 的聊天内容。
	 *
	 * 执行流程：
	 * 1. 打开 WorkflowEditorPane（文本编辑器区域）
	 * 2. 确保 workflow agent（Employee）存在
	 * 3. 选中该 agent（modelSelectorService）
	 * 4. 打开右侧 ClawChat 视图 — 聊天框切换到该 agent
	 */
	private _openWorkflow(wf: IStoredWorkflow): void {
		// 1. Open the editor
		const input = new WorkflowEditorInput(wf);
		this.editorService.openEditor(input, { pinned: true });

		// 2-4. Select the corresponding agent and open the chat view (no prompt sent)
		void this._selectWorkflowAgentInChat(wf);
	}

	/**
	 * Open the ClawChat view with the workflow agent selected, but do NOT send any message.
	 */
	private async _selectWorkflowAgentInChat(wf: IStoredWorkflow): Promise<void> {
		try {
			const employee = await this._ensureWorkflowAgent(wf);
			if (!employee) { return; }

			// Persist agentId binding (first time)
			if (wf.agentId !== employee.id) {
				try {
					await this.workflowStorage.updateWorkflow(wf.id, { agentId: employee.id });
				} catch { /* non-fatal */ }
			}

			// Select the agent and open the chat view (no prompt) — use webview-based Agent Chat (right sidebar)
			this.modelSelectorService.setSelectedAgentId(employee.id);
			await this.viewsService.openView(AGENT_STUDIO_CHAT_VIEW_ID, true);
		} catch {
			// Silently fail — the editor is already open
		}
	}

	// ─── Create Workflow ────────────────────────────────────────

	private _buildCreateForm(): HTMLElement {
		const form = $('div.workflow-create-form');

		// Agent (preset) — fixed to Workflow Agent, shown read-only
		const agentRow = $('div.workflow-form-row');
		const agentLabel = $('label.workflow-form-label');
		agentLabel.textContent = 'Agent';
		agentRow.appendChild(agentLabel);
		const agentValue = $('div.workflow-form-static');
		const preset = this._getWorkflowPreset();
		agentValue.textContent = preset ? `${preset.icon} ${preset.name}` : 'Workflow Agent';
		agentRow.appendChild(agentValue);
		form.appendChild(agentRow);

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
	 * Dynamic insertion avoids stale-element bugs when renderBody runs again.
	 */
	private _insertCreateForm(form: HTMLElement): void {
		const existing = this._root.querySelector('.workflow-create-form');
		if (existing) {
			existing.remove();
		}
		if (this._headerContainer?.nextSibling) {
			this._root.insertBefore(form, this._headerContainer.nextSibling);
		} else {
			this._root.appendChild(form);
		}
	}

	private async _showCreateForm(): Promise<void> {
		if (this._creating) { return; }
		this._creating = true;

		const form = this._buildCreateForm();
		this._insertCreateForm(form);

		// Focus name input
		const nameInput = this._root.querySelector('#workflow-create-name') as HTMLInputElement;
		nameInput?.focus();
	}

	private _hideCreateForm(): void {
		const existing = this._root.querySelector('.workflow-create-form');
		if (existing) {
			existing.remove();
		}
		this._creating = false;
	}

	private async _handleCreate(): Promise<void> {
		const nameInput = this._root.querySelector('#workflow-create-name') as HTMLInputElement;
		const descInput = this._root.querySelector('#workflow-create-desc') as HTMLInputElement;

		const name = nameInput?.value?.trim();
		const description = descInput?.value?.trim();

		if (!name) {
			this._flashMessage('Please enter a name');
			return;
		}

		try {
			const wf = await this.workflowStorage.createWorkflow({
				name,
				description: description || '',
				presetId: WORKFLOW_PRESET_ID,
				steps: [],
			});
			this._hideCreateForm();

			// NOTE: createWorkflow 内部已经 fire onDidChangeWorkflows，会触发
			// _reload()。但该 _reload() 是 async 的，且与下面可能发生竞态：
			//   事件 handler 设 _loading=true 后，本方法的 _reload() 会被跳过。
			//
			// 为幂等起见，这里不依赖事件链，直接把返回的 workflow 插入
			// 本地状态并 render，确保列表立即显示。
			this._workflows = [wf, ...this._workflows];
			this._renderList();
		} catch (err) {
			this._flashMessage(err instanceof Error ? err.message : 'Failed to create workflow');
		}
	}

	private _flashMessage(message: string): void {
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

	// ─── Execute Workflow ───────────────────────────────────────

	private _getWorkflowPreset(): AgentPreset | undefined {
		return BUILTIN_PRESETS.find(p => p.id === WORKFLOW_PRESET_ID);
	}

	/**
	 * 执行工作流：
	 * 1. 确保该工作流对应的 Agent（Employee）存在；不存在则按预设部署
	 * 2. 选中该 Agent
	 * 3. 打开聊天框（Claw Chat View）
	 * 4. 将工作流执行指令注入聊天框并发送，所有内容在聊天框中显示
	 */
	private async _runWorkflow(wf: IStoredWorkflow): Promise<void> {
		try {
			// 1. 确保 Agent 存在
			const employee = await this._ensureWorkflowAgent(wf);
			if (!employee) {
				this.notificationService.error('Failed to prepare the Workflow Agent. Please make sure a workspace is selected.');
				return;
			}

			// 持久化 agentId 绑定（首次执行后记录）
			if (wf.agentId !== employee.id) {
				try {
					await this.workflowStorage.updateWorkflow(wf.id, { agentId: employee.id });
				} catch { /* non-fatal */ }
			}

			// 2. 选中该 Agent
			this.modelSelectorService.setSelectedAgentId(employee.id);

			// 3. 打开聊天框
			await this.viewsService.openView(AGENT_STUDIO_CHAT_VIEW_ID, true);

			// 4. 注入执行指令（Claw Chat 已移除，手动粘贴提示词）
			const prompt = this._buildExecutionPrompt(wf);
			this.notificationService.info('Workflow prompt is ready. Please paste it into the chat manually:\n\n' + prompt);
		} catch (err) {
			this.notificationService.error(`Failed to run workflow: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * 确保工作流对应的 Agent 存在。
	 * - 优先用 wf.agentId 查已部署 Employee
	 * - 否则在当前工作区查找同名/同 presetId 的 Employee
	 * - 都没有则按 workflow-agent 预设新建一个
	 */
	private async _ensureWorkflowAgent(wf: IStoredWorkflow): Promise<Employee | undefined> {
		// (a) 已记录 agentId
		if (wf.agentId) {
			const existing = await this.agentStudioService.getEmployee(wf.agentId);
			if (existing) { return existing; }
		}

		const workspaceId = this.agentStudioService.getActiveWorkspaceId()
			?? wf.workspaceId;

		// (b) 工作区内查找已部署的 workflow-agent
		const employees = await this.agentStudioService.getEmployees(workspaceId);
		const matched = employees.find(e => e.presetId === WORKFLOW_PRESET_ID);
		if (matched) { return matched; }

		// (c) 按预设部署一个新的
		const preset = this._getWorkflowPreset();
		if (!preset) { return undefined; }

		const employeeData: Partial<Employee> = {
			name: preset.name,
			role: preset.role,
			presetId: preset.id,
			model: preset.model,
			customPrompt: preset.systemPrompt,
			skills: [...preset.skills],
			tools: preset.tools ? [...preset.tools] : undefined,
			visibility: preset.visibility,
			bootstrapTemplates: preset.bootstrapTemplates,
			temperature: preset.temperature,
			workspaceId,
		};
		return await this.agentStudioService.createEmployee(employeeData);
	}

	/**
	 * 构造工作流执行指令文本。
	 */
	private _buildExecutionPrompt(wf: IStoredWorkflow): string {
		const lines: string[] = [];
		lines.push(`# Execute Workflow: ${wf.name}`);
		lines.push('');
		if (wf.description) {
			lines.push(wf.description);
			lines.push('');
		}

		if (wf.steps && wf.steps.length > 0) {
			lines.push('## Steps');
			wf.steps.forEach((step, i) => {
				lines.push(`${i + 1}. **${step.name}** (${step.type})`);
				if (step.executorId) { lines.push(`   - Executor: ${step.executorId}`); }
				if (step.type === 'condition' && step.condition) { lines.push(`   - Condition: ${step.condition}`); }
				if (step.type === 'loop' && step.loopConfig) { lines.push(`   - Loop over: ${step.loopConfig.items} as ${step.loopConfig.itemVariable}`); }
				if (step.type === 'parallel' && step.parallelSteps) { lines.push(`   - Parallel: ${step.parallelSteps.join(', ')}`); }
			});
			lines.push('');
			lines.push('Please execute these steps in order, narrating your progress, and summarize at the end.');
		} else {
			lines.push('This workflow has no steps defined yet. Ask me what steps to add, or proceed based on the name and description above.');
		}

		return lines.join('\n');
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
			.workflow-item-top {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
			}
			.workflow-item-name {
				font-weight: 600;
				font-size: 13px;
				margin-bottom: 2px;
				color: var(--vscode-foreground);
				flex: 1;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			.workflow-run-btn {
				flex-shrink: 0;
				background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
				border: none;
				color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
				padding: 2px 8px;
				border-radius: 3px;
				cursor: pointer;
				font-size: 10px;
				font-weight: 600;
			}
			.workflow-run-btn:hover {
				background: var(--vscode-button-hoverBackground);
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
			.workflow-form-static {
				flex: 1;
				font-size: 12px;
				color: var(--vscode-foreground);
				padding: 4px 0;
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
