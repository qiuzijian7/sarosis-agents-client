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
import type { Agent } from '../../../../common/agentStudioTypes.js';
import { IModelSelectorService } from '../../common/modelSelector.js';
import { AGENT_STUDIO_CHAT_VIEW_ID } from '../../common/constants.js';
import { WorkflowEditorInput } from '../workflowEditorInput.js';

/**
 * Workflow View - 工作流管理面板 (ActivityBar Sidebar)
 *
 * 功能：
 * - 显示当前工作区 `.sarosisworkspace/workflows/` 下所有工作流（文件存储）
 * - 创建工作流：自动创建专属 Agent（每个 workflow 独立 agent）
 * - 点击工作流 item：打开编辑器 + 右侧聊天框切换到该 workflow 的 agent
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

			const delBtn = $('button.workflow-del-btn');
			delBtn.textContent = '×';
			delBtn.title = 'Delete this workflow';
			delBtn.onclick = (e) => {
				e.stopPropagation();
				void this._handleDelete(wf);
			};
			topRow.appendChild(delBtn);

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
			parts.push(`${wf.name} · workflow`);
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
	 * 2. 确保 workflow agent 存在
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
			const agent = await this._ensureWorkflowAgent(wf);
			if (!agent) { return; }

			// Persist agentId binding (first time)
			if (wf.agentId !== agent.id) {
				try {
					await this.workflowStorage.updateWorkflow(wf.id, { agentId: agent.id });
				} catch { /* non-fatal */ }
			}

			// Select the agent and open the chat view (no prompt) — use webview-based Agent Chat (right sidebar)
			this.modelSelectorService.setSelectedAgentId(agent.id);
			this.agentStudioService.fireSelectAgent(agent.id);
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
		agentValue.textContent = '🤖 Auto-created per workflow';
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
			// 1. Create the workflow (no steps initially)
			const wf = await this.workflowStorage.createWorkflow({
				name,
				description: description || '',
				steps: [],
			});

			// 2. Create a dedicated agent for this workflow
			let agentCreated = false;
			try {
				const agent = await this._createWorkflowAgent(wf);
				if (agent) {
					wf.agentId = agent.id;
					await this.workflowStorage.updateWorkflow(wf.id, { agentId: agent.id });
					agentCreated = true;
				}
			} catch (agentErr) {
				this.notificationService.warn(
					`Workflow created but agent creation failed: ${agentErr instanceof Error ? agentErr.message : String(agentErr)}`
				);
			}

			this._hideCreateForm();
			this._workflows = [wf, ...this._workflows];
			this._renderList();

			// 3. Auto-select the new agent and open the right-side chat panel
			if (agentCreated && wf.agentId) {
				void this._selectWorkflowAgentInChat(wf);
			}
		} catch (err) {
			this._flashMessage(err instanceof Error ? err.message : 'Failed to create workflow');
		}
	}

	private async _handleDelete(wf: IStoredWorkflow): Promise<void> {
		try {
			await this.workflowStorage.deleteWorkflow(wf.id);
			this._workflows = this._workflows.filter(w => w.id !== wf.id);
			this._renderList();
		} catch (err) {
			this._flashMessage(err instanceof Error ? err.message : 'Failed to delete workflow');
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

	/**
	 * 执行工作流：
	 * 1. 确保该工作流对应的 Agent 存在；不存在则按预设部署
	 * 2. 选中该 Agent
	 * 3. 打开聊天框（Claw Chat View）
	 * 4. 将工作流执行指令注入聊天框并发送，所有内容在聊天框中显示
	 */
	private async _runWorkflow(wf: IStoredWorkflow): Promise<void> {
		try {
			// 1. 确保 Agent 存在
			const agent = await this._ensureWorkflowAgent(wf);
			if (!agent) {
				this.notificationService.error('Failed to prepare the Workflow Agent. Please make sure a workspace is selected.');
				return;
			}

			// 持久化 agentId 绑定（首次执行后记录）
			if (wf.agentId !== agent.id) {
				try {
					await this.workflowStorage.updateWorkflow(wf.id, { agentId: agent.id });
				} catch { /* non-fatal */ }
			}

			// 2. 选中该 Agent
			this.modelSelectorService.setSelectedAgentId(agent.id);
			this.agentStudioService.fireSelectAgent(agent.id);

			// 3. 打开聊天框
			await this.viewsService.openView(AGENT_STUDIO_CHAT_VIEW_ID, true);

			// 4. 注入执行指令 → chat panel 自动发送并开始 agent loop
			const prompt = this._buildExecutionPrompt(wf);
			this.agentStudioService.requestInjectPrompt(agent.id, prompt);
		} catch (err) {
			this.notificationService.error(`Failed to run workflow: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Ensure a dedicated agent exists for this workflow.
	 * Each workflow has its OWN agent — no more sharing 'workflow-agent'.
	 * - If wf.agentId exists and the agent is found, return it.
	 * - Otherwise, create a new dedicated agent and bind it.
	 */
	private async _ensureWorkflowAgent(wf: IStoredWorkflow): Promise<Agent | undefined> {
		// (a) Fast path: agentId already recorded
		if (wf.agentId) {
			const existing = await this.agentStudioService.getAgent(wf.agentId);
			if (existing) { return existing; }
			// agentId is stale — fall through to create a new one
		}

		// (b) Create a new dedicated agent for this workflow
		const agent = await this._createWorkflowAgent(wf);
		if (agent) {
			try {
				await this.workflowStorage.updateWorkflow(wf.id, { agentId: agent.id });
				wf.agentId = agent.id;
			} catch { /* non-fatal */ }
		}
		return agent;
	}

	/**
	 * Create a dedicated agent for a workflow.
	 * Each workflow gets its own agent with a system prompt built from the workflow definition.
	 */
	private async _createWorkflowAgent(wf: IStoredWorkflow): Promise<Agent | undefined> {
		try {
			const agentName = `${wf.name} · workflow`;
			const systemPrompt = this._buildWorkflowSystemPrompt(wf);

			return await this.agentStudioService.createAgent({
				name: agentName,
				role: 'Workflow Manager',
				description: `Manages and executes workflow: ${wf.name}`,
				model: 'claude-sonnet-4-20250514',
				systemPrompt,
				skills: ['workflow-execution'],
				tools: [
					'read_file', 'list_dir', 'search_files', 'grep_search',
					'write_to_file', 'replace_in_file', 'terminal', 'use_skill',
					'workflow_get', 'workflow_get_schema', 'workflow_apply', 'workflow_list',
				],
				source: 'custom',
				category: 'workflow',
				icon: '🔀',
			});
		} catch (err) {
			this.notificationService.error(
				`Failed to create agent for workflow "${wf.name}": ${err instanceof Error ? err.message : String(err)}`
			);
			return undefined;
		}
	}

	/**
	 * Build a system prompt for a workflow agent from the workflow definition.
	 */
	private _buildWorkflowSystemPrompt(wf: IStoredWorkflow): string {
		const lines: string[] = [];
		lines.push(`You manage workflow "${wf.name}" (id: \`${wf.id}\`).`);
		lines.push('');
		lines.push('You are responsible for both executing AND editing this workflow graph.');
		lines.push('Users may ask you to add, remove, or modify nodes. You have full control.');
		lines.push('');

		if (wf.description) {
			lines.push('## Workflow Description');
			lines.push(wf.description);
			lines.push('');
		}

		const nodes = wf.nodes;
		if (nodes && nodes.length > 0) {
			const userNodes = nodes.filter(n => n.type !== 'start' && n.type !== 'end' && n.type !== 'group');
			if (userNodes.length > 0) {
				lines.push('## Current Workflow Graph');
				userNodes.forEach((n, i) => {
					const label = (n.data?.label as string) || n.name || `Node ${i + 1}`;
					lines.push(`- **${label}** (${n.type})`);
				});
				lines.push('');
			}
		}

		lines.push('## Available Node Types');
		lines.push('You can add any of these node types to the workflow:');
		lines.push('- `prompt`: A text prompt template with {{variable}} substitution');
		lines.push('- `agent`: Execute a specific agent with model configuration');
		lines.push('- `skill`: Execute a named skill');
		lines.push('- `tool`: Execute a tool with parameters');
		lines.push('- `task`: A single task with an optional executor');
		lines.push('- `ifElse`: Binary conditional branch (True/False)');
		lines.push('- `switch`: Multi-way branch (2-N cases with a default)');
		lines.push('- `condition`: Branch based on a condition expression (legacy)');
		lines.push('- `loop`: Repeat over items with configurable variable');
		lines.push('- `parallel`: Run multiple branches simultaneously');
		lines.push('- `askUser`: Ask the user a question and branch based on selection');
		lines.push('- `group`: Visual grouping container (layout only, not executable)');
		lines.push('');

		lines.push('## Workflow Tools');
		lines.push('Use these tools to read and modify the workflow:');
		lines.push('- `workflow_get`: Read the current workflow graph (nodes + connections)');
		lines.push('- `workflow_get_schema`: Get the JSON schema for ALL node types AND the list of available agents with their IDs');
		lines.push('- `workflow_apply`: Apply changes (add/remove/modify nodes and connections)');
		lines.push('- `workflow_list`: List all workflows in this workspace');
		lines.push('');

		lines.push('## Agent Node Rules (CRITICAL)');
		lines.push('When adding `agent` type nodes, you MUST populate both `agentId` AND `agentConfig`:');
		lines.push('1. ALWAYS call `workflow_get_schema` first — it returns the `availableAgents` list with exact IDs and their models.');
		lines.push('2. Set `agentId` to one of the ids from availableAgents exactly.');
		lines.push('3. Set `agentConfig.modelId` to the agent\'s model (e.g., "claude-sonnet-4-20250514").');
		lines.push('4. Set `agentConfig.providerId` to the appropriate provider if known, otherwise omit it.');
		lines.push('5. If the user asks for an agent that does not exist, tell them to create it first.');
		lines.push('6. Example: { "agentId": "coder", "agentConfig": { "modelId": "claude-sonnet-4-20250514" } }');
		lines.push('');

		lines.push('## Editing Rules');
		lines.push('1. When asked to modify the workflow, first use `workflow_get` to see current state.');
		lines.push('2. Then use `workflow_get_schema` to get valid agent IDs and node type schemas.');
		lines.push('3. Build the complete nodes+connections array and apply via `workflow_apply`.');
		lines.push('4. Always include Start and End nodes. Every node must have: id, type, label, position {x,y}.');
		lines.push('5. For new nodes, place them at reasonable positions near related nodes.');
		lines.push('6. Include a `change_description` summarizing what you changed.');
		lines.push('7. After applying, the workflow editor updates automatically.');
		lines.push('');
		lines.push('## Connection Port Rules (CRITICAL for branch nodes)');
		lines.push('Multi-port nodes (ifElse, switch, condition, askUser) have MULTIPLE output handles.');
		lines.push('Each connection FROM these nodes MUST include `fromPort` to specify which branch:');
		lines.push('- `ifElse` / `condition`: `fromPort` = "branch-0" (True) or "branch-1" (False)');
		lines.push('- `switch`: `fromPort` = "branch-0", "branch-1", "branch-2", ... (one per branch)');
		lines.push('- `askUser`: `fromPort` = "option-0", "option-1", ... (one per option)');
		lines.push('Example for ifElse: { "id": "e1", "from": "if-node", "to": "task-true", "fromPort": "branch-0" }');
		lines.push('Example for askUser: { "id": "e1", "from": "ask-node", "to": "opt1-node", "fromPort": "option-0" }');
		lines.push('Single-port nodes (start, end, task, prompt, agent, skill, tool, loop, parallel) do NOT need fromPort.');
		lines.push('');

		lines.push('## Execution Rules (when asked to run the workflow)');
		lines.push('1. Execute steps following the workflow connections in topological order.');
		lines.push('2. For branch nodes (ifElse/switch/condition/askUser), evaluate and follow the matching branch.');
		lines.push('3. For parallel nodes, run all branches simultaneously.');
		lines.push('4. For loop nodes, iterate over each item.');
		lines.push('5. Narrate your progress and summarize results when done.');
		lines.push('6. If any step is unclear, ask for clarification.');

		return lines.join('\n');
	}

	/**
	 * 构造工作流执行指令文本。
	 * Supports both legacy steps and graph-based nodes.
	 */
	private _buildExecutionPrompt(wf: IStoredWorkflow): string {
		const lines: string[] = [];
		lines.push(`# Execute Workflow: ${wf.name}`);
		lines.push('');
		if (wf.description) {
			lines.push(wf.description);
			lines.push('');
		}

		// Prefer graph-based nodes over legacy steps
		const hasGraphNodes = wf.nodes && wf.nodes.length > 1; // >1 because start+end = 2 minimum
		if (hasGraphNodes) {
			return this._buildGraphExecutionPrompt(wf, lines);
		}

		// Legacy step-based
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

	/**
	 * Build execution prompt from graph nodes + connections.
	 * Performs topological traversal from Start → ... → End.
	 */
	private _buildGraphExecutionPrompt(wf: IStoredWorkflow, lines: string[]): string {
		const nodes = wf.nodes!;
		const connections = wf.connections ?? [];

		// Build adjacency for traversal
		const adj = new Map<string, string[]>();    // nodeId → [targetId, ...]
		const incoming = new Map<string, number>();
		for (const c of connections) {
			const list = adj.get(c.from) ?? [];
			list.push(c.to);
			adj.set(c.from, list);
			incoming.set(c.to, (incoming.get(c.to) ?? 0) + 1);
		}

		// Find start node(s) — nodes with no incoming edges
		const startNodes = nodes.filter(n =>
			n.type !== 'group' && (incoming.get(n.id) ?? 0) === 0
		);
		const visited = new Set<string>();
		const ordered: typeof nodes = [];

		// BFS in-degree traversal for topological order
		for (const sn of startNodes) {
			if (visited.has(sn.id)) { continue; }
			const queue = [sn.id];
			while (queue.length > 0) {
				const current = queue.shift()!;
				if (visited.has(current)) { continue; }
				visited.add(current);
				const node = nodes.find(n => n.id === current);
				if (node) { ordered.push(node); }
				for (const next of adj.get(current) ?? []) {
					if (!visited.has(next)) {
						queue.push(next);
					}
				}
			}
		}

		// Filter out start/end/group from description (they're structural)
		const userNodes = ordered.filter(n => n.type !== 'start' && n.type !== 'end' && n.type !== 'group');

		if (userNodes.length === 0) {
			lines.push('This workflow has no executable nodes defined yet.');
			lines.push('Add nodes in the workflow editor and try again.');
			return lines.join('\n');
		}

		lines.push('## Workflow Nodes');
		lines.push('');
		let stepNum = 0;
		for (const node of userNodes) {
			stepNum++;
			const data = node.data || {};
			const label = (data.label as string) || node.name || node.id;

			switch (node.type) {
				case 'prompt':
					lines.push(`${stepNum}. 💬 **${label}** (Prompt)`);
					if (data.prompt) {
						const preview = (data.prompt as string).length > 120
							? (data.prompt as string).substring(0, 120) + '...'
							: data.prompt as string;
						lines.push(`   _${preview}_`);
					}
					break;
				case 'agent':
					lines.push(`${stepNum}. 🤖 **${label}** (Agent)`);
					if (data.agentId) { lines.push(`   - Agent: ${data.agentId}`); }
					if ((data.agentConfig as { model?: string })?.model) {
						lines.push(`   - Model: ${(data.agentConfig as { model?: string }).model}`);
					}
					break;
				case 'skill':
					lines.push(`${stepNum}. ⚡ **${label}** (Skill)`);
					if (data.skillName) { lines.push(`   - Skill: ${data.skillName}`); }
					break;
				case 'tool':
					lines.push(`${stepNum}. 🔧 **${label}** (Tool)`);
					if (data.toolName) { lines.push(`   - Tool: ${data.toolName}`); }
					if (data.toolParams && Object.keys(data.toolParams as Record<string, string>).length > 0) {
						const params = data.toolParams as Record<string, string>;
						const paramStr = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(', ');
						lines.push(`   - Params: ${paramStr}`);
					}
					break;
				case 'task':
					lines.push(`${stepNum}. 📋 **${label}** (Task)`);
					if (data.executorId) { lines.push(`   - Executor: ${data.executorId}`); }
					if (data.taskId) { lines.push(`   - Task ID: ${data.taskId}`); }
					break;
				case 'ifElse':
					lines.push(`${stepNum}. ↔️ **${label}** (If/Else - Binary branch)`);
					if (data.evaluationTarget) { lines.push(`   - Evaluate: ${data.evaluationTarget}`); }
					if (data.branches) {
						for (const b of data.branches as Array<{ label: string; condition: string }>) {
							lines.push(`   - ${b.label}: ${b.condition || '(no condition)'}`);
						}
					}
					break;
				case 'switch':
					lines.push(`${stepNum}. 🔀 **${label}** (Switch - Multi-way branch)`);
					if (data.evaluationTarget) { lines.push(`   - Evaluate: ${data.evaluationTarget}`); }
					if (data.branches) {
						for (const b of data.branches as Array<{ label: string; condition: string }>) {
							lines.push(`   - ${b.label}: ${b.condition || '(default)'}`);
						}
					}
					break;
				case 'condition':
					lines.push(`${stepNum}. 🔀 **${label}** (Condition)`);
					if (data.condition) { lines.push(`   - Condition: ${data.condition}`); }
					if (data.branches) {
						for (const b of data.branches as Array<{ label: string; condition: string }>) {
							lines.push(`   - ${b.label}: ${b.condition || ''}`);
						}
					}
					break;
				case 'loop':
					lines.push(`${stepNum}. 🔄 **${label}** (Loop)`);
					if (data.loopConfig) {
						const lc = data.loopConfig as { items: string; itemVariable: string; maxIterations?: number };
						lines.push(`   - Over: ${lc.items || '(not set)'}`);
						lines.push(`   - Var: ${lc.itemVariable || 'item'}`);
						if (lc.maxIterations) { lines.push(`   - Max iterations: ${lc.maxIterations}`); }
					}
					break;
				case 'parallel':
					lines.push(`${stepNum}. ⇉ **${label}** (Parallel)`);
					if (data.parallelSteps && (data.parallelSteps as string[]).length > 0) {
						lines.push(`   - Branches: ${(data.parallelSteps as string[]).join(', ')}`);
					}
					break;
				case 'askUser':
					lines.push(`${stepNum}. ❓ **${label}** (Ask User)`);
					if (data.questionText) { lines.push(`   - Question: ${(data.questionText as string).substring(0, 100)}`); }
					if (data.options) {
						const opts = data.options as Array<{ label: string }>;
						lines.push(`   - Options: ${opts.map(o => o.label).join(' | ')}`);
					}
					if (data.multiSelect) { lines.push('   - Mode: Multi-select'); }
					break;
				default:
					lines.push(`${stepNum}. **${label}** (${node.type})`);
					break;
			}
			lines.push('');
		}

		lines.push('Please execute this workflow following the connections between nodes.');
		lines.push('For branch nodes (If/Else, Switch, Condition, Ask User), evaluate the condition');
		lines.push('and follow the matching branch. For parallel nodes, run branches simultaneously.');
		lines.push('For loops, iterate over each item. Narrate your progress and summarize at the end.');

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
			.workflow-del-btn {
				flex-shrink: 0;
				background: transparent;
				border: 1px solid var(--vscode-panel-border);
				color: var(--vscode-errorForeground);
				padding: 1px 6px;
				border-radius: 3px;
				cursor: pointer;
				font-size: 12px;
				font-weight: 700;
				line-height: 1;
				opacity: 0;
				transition: opacity 0.15s;
			}
			.workflow-item:hover .workflow-del-btn {
				opacity: 1;
			}
			.workflow-del-btn:hover {
				background: var(--vscode-inputValidation-errorBackground);
				border-color: var(--vscode-errorForeground);
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
