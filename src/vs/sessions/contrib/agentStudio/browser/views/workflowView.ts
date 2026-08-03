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
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { $, clearNode } from '../../../../../base/browser/dom.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { EditorsOrder } from '../../../../../workbench/common/editor.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { IWorkflowStorageService, type IStoredWorkflow } from '../../common/workflowStorage.js';
import { IWorkflowExecutionService } from '../../common/workflowExecutionService.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import type { Agent } from '../../../../common/agentStudioTypes.js';
import { IModelSelectorService } from '../../common/modelSelector.js';
import { AGENT_STUDIO_CHAT_VIEW_ID } from '../../common/constants.js';
import { WorkflowEditorInput } from '../workflowEditorInput.js';
import { WorkflowMarketEditorInput } from '../workflowMarketEditorInput.js';
import { IMarketplaceService } from '../../common/marketplace.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITofAuthService } from '../../common/tofAuth.js';
import { IWorkflowVersionService } from '../../common/workflowVersionTypes.js';
import { WorkflowPublishModal } from '../workflowPublishModal.js';
import { applySavedOrder, CardDragSorter, CardOrderStore, CardPinStore, showCardContextMenu } from './cardItemBehaviors.js';

/**
 * Workflow View - 工作流管理面板 (ActivityBar Sidebar)
 *
 * 功能：
 * - 显示当前工作区 `.sarosworkspace/workflows/` 下所有工作流（文件存储）
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

	/** 排序 + 置顶持久化 + 拖拽排序（共享实现） */
	private _orderStore!: CardOrderStore;
	private _pinStore!: CardPinStore;
	private _dragSorter!: CardDragSorter;
	/** 可升级的 workflow id → 目标版本（来自商城 checkUpgrades） */
	private _upgradeTargets = new Map<string, string>();

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
		@IWorkflowExecutionService private readonly workflowExecutionService: IWorkflowExecutionService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IModelSelectorService private readonly modelSelectorService: IModelSelectorService,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@IStorageService private readonly storageService: IStorageService,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
		@IWorkflowVersionService private readonly workflowVersionService: IWorkflowVersionService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// 工作流文件变化时刷新列表
		this._register(this.workflowStorage.onDidChangeWorkflows(() => {
			void this._reload();
		}));

		// 拖拽排序 + 置顶 + 持久化（与 preset / skill 视图共用实现）
		this._orderStore = new CardOrderStore(this.storageService, 'agentStudio.workflowOrder.v1');
		this._pinStore = new CardPinStore(this.storageService, 'agentStudio.workflowPinned.v1');
		this._dragSorter = new CardDragSorter({
			getContainer: () => this._listContainer,
			getVisibleIds: () => applySavedOrder(this._workflows, this._orderStore.load(), w => w.id, this._pinStore.load()).map(w => w.id),
			onReorder: (ids) => { this._orderStore.save(ids); this._renderList(); },
		});
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

		const installBtn = $('button.workflow-install-btn');
		installBtn.textContent = '⬇ Install';
		installBtn.title = 'Install Workflow from Marketplace';
		installBtn.onclick = () => { void this._openMarketplace(); };
		actionsGroup.appendChild(installBtn);

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
			// 顺带拉取商城升级信息（失败静默，不阻塞列表）
			void this._loadUpgradeInfo().then(() => {
				if (this._workflows.length > 0) { this._renderList(); }
			});
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

	/** 拉取商城升级信息：本地有安装/发布记录的 workflow 才查 */
	private async _loadUpgradeInfo(): Promise<void> {
		this._upgradeTargets.clear();
		try {
			const installed = await this.marketplaceService.getInstalled();
			const local = installed
				.filter(e => e.kind === 'workflow')
				.map(e => ({ kind: 'workflow' as const, storeId: e.storeId, version: e.version }));
			if (local.length === 0) { return; }
			const upgrades = await this.marketplaceService.checkUpgrades(local);
			for (const u of upgrades) {
				this._upgradeTargets.set(u.storeId, u.latest);
			}
		} catch { /* 升级信息获取失败不影响列表 */ }
	}

	/** Open the Workflow Marketplace editor */
	private async _openMarketplace(): Promise<void> {
		const input = WorkflowMarketEditorInput.getInstance();
		await this.editorService.openEditor(input, { pinned: true });
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

		// 持久化排序 + 置顶优先（共享实现）
		const ordered = applySavedOrder(this._workflows, this._orderStore.load(), w => w.id, this._pinStore.load());

		for (const wf of ordered) {
			const item = $('div.workflow-item');
			item.title = wf.description || wf.name;

			// 置顶标记
			const isPinned = this._pinStore.isPinned(wf.id);
			if (isPinned) { item.classList.add('pinned'); }

			// ── Status bar (left vertical accent) ──
			const statusBar = $('div.workflow-status-bar');
			item.appendChild(statusBar);

			// ── Icon ──
			const iconEl = $('div.workflow-icon');
			iconEl.textContent = '🔀';
			item.appendChild(iconEl);

			// ── Body (name + version badge + description) ──
			const body = $('div.workflow-body');

			const titleRow = $('div.workflow-title-row');

			const nameEl = $('span.workflow-item-name');
			nameEl.textContent = wf.name;
			titleRow.appendChild(nameEl);

			// 置顶图标
			if (isPinned) {
				const pinIcon = $('span.workflow-pin-icon');
				pinIcon.textContent = '📌';
				pinIcon.title = '已置顶';
				titleRow.appendChild(pinIcon);
			}

			// 内置标识
			if (wf.source === 'builtin') {
				const builtinBadge = $('span.builtin-badge');
				builtinBadge.textContent = '内置';
				builtinBadge.title = '产品内置工作流';
				titleRow.appendChild(builtinBadge);
			}

			// Version badge
			if (wf.version) {
				const verBadge = $('span.workflow-version-badge');
				verBadge.textContent = `v${wf.version}`;
				verBadge.classList.add('installed');
				titleRow.appendChild(verBadge);
			}
			body.appendChild(titleRow);

			if (wf.description) {
				const descEl = $('div.workflow-item-desc');
				descEl.textContent = wf.description.length > 80
					? wf.description.substring(0, 80) + '...'
					: wf.description;
				body.appendChild(descEl);
			}

			const metaEl = $('div.workflow-item-meta');
			const stepCount = wf.steps?.length ?? 0;
			const parts: string[] = [];
			parts.push(`${stepCount} steps`);
			parts.push(wf.isActive ? 'Active' : 'Inactive');
			metaEl.textContent = parts.join(' · ');
			body.appendChild(metaEl);

			item.appendChild(body);

			// ── Actions (right side)（删除保留，复制移入右键菜单） ──
			const actions = $('div.workflow-actions');

			// Delete button — 内置工作流不可删除
			if (wf.source !== 'builtin') {
				const delBtn = $('button.workflow-btn.delete') as HTMLButtonElement;
				delBtn.textContent = '🗑';
				delBtn.title = `删除 ${wf.name}`;
				delBtn.onclick = (e) => {
					e.stopPropagation();
					void this._handleDelete(wf);
				};
				actions.appendChild(delBtn);
			}

			item.appendChild(actions);

			item.onclick = () => this._openWorkflow(wf);

			// 右键菜单：置顶 / 复制 / 删除 / 升级(按需) / 上传(按需)（共享实现）
			item.oncontextmenu = (e) => {
				e.preventDefault();
				e.stopPropagation();
				const targetVersion = this._upgradeTargets.get(wf.id);
				showCardContextMenu(this.contextMenuService, e, {
					pinned: isPinned,
					onTogglePin: () => { this._pinStore.toggle(wf.id); this._renderList(); },
					onDuplicate: () => { void this._handleDuplicate(wf); },
					upgradeLabel: targetVersion ? `升级到 v${targetVersion}` : undefined,
					onUpgrade: targetVersion ? () => { void this._handleUpgrade(wf, targetVersion); } : undefined,
					onUpload: wf.source !== 'builtin' ? () => { this._handleUpload(wf); } : undefined,
					onDelete: wf.source !== 'builtin' ? () => { void this._handleDelete(wf); } : undefined,
				});
			};

			// 拖拽排序（共享实现，顺序持久化）
			this._dragSorter.attach(item, wf.id);

			this._listContainer.appendChild(item);
		}
	}

	/** 上传工作流到商城（复用发布 Modal） */
	private _handleUpload(wf: IStoredWorkflow): void {
		const modal = new WorkflowPublishModal(
			wf,
			this.marketplaceService,
			this.notificationService,
			this.workflowStorage,
			this.tofAuthService,
			this.workflowVersionService,
		);
		modal.onDidPublish(() => { void this._reload(); });
		modal.show();
	}

	/** 从商城升级工作流（下载最新版覆盖安装） */
	private async _handleUpgrade(wf: IStoredWorkflow, targetVersion: string): Promise<void> {
		try {
			const confirmed = await this.dialogService.confirm({
				message: `升级工作流 "${wf.name}" 到 v${targetVersion}？`,
				primaryButton: '升级',
			});
			if (!confirmed.confirmed) { return; }

			await this.marketplaceService.download(wf.id, targetVersion, 'workflow');
			this.notificationService.info(`已升级到 v${targetVersion}`);
			this._upgradeTargets.delete(wf.id);
			await this._reload();
		} catch (err) {
			this._flashMessage(`升级失败: ${err instanceof Error ? err.message : String(err)}`);
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
		const input = new WorkflowEditorInput(wf);

		// Deduplicate: if an editor with the same workflow is already open,
		// reuse it instead of creating a new input (avoids disposable leak).
		const existingEditors = this.editorService.findEditors(input);
		if (existingEditors.length > 0) {
			// Reveal the existing editor — dispose the newly created input since it won't be used.
			const existing = existingEditors[0];
			void this.editorService.openEditor(existing.editor, { revealIfVisible: true }, existing.groupId);
			input.dispose();
		} else {
			this.editorService.openEditor(input, { pinned: true });
		}

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

		// Slug input (becomes workflow ID: wf-{slug})
		const slugRow = $('div.workflow-form-row');
		const slugLabel = $('label.workflow-form-label');
		slugLabel.textContent = 'Slug';
		slugRow.appendChild(slugLabel);
		// Prefix indicator
		const slugPrefix = $('span.workflow-form-slug-prefix');
		slugPrefix.textContent = 'wf-';
		slugRow.appendChild(slugPrefix);
		const slugInput = $('input.workflow-form-text');
		slugInput.setAttribute('type', 'text');
		slugInput.setAttribute('placeholder', 'my-workflow');
		slugInput.id = 'workflow-create-slug';
		slugInput.style.flex = '1';
		slugRow.appendChild(slugInput);
		form.appendChild(slugRow);

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
		const slugInput = this._root.querySelector('#workflow-create-slug') as HTMLInputElement;
		const descInput = this._root.querySelector('#workflow-create-desc') as HTMLInputElement;

		const name = nameInput?.value?.trim();
		const slug = slugInput?.value?.trim();
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
				slug: slug || undefined,
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

			// 2. Auto-open the new workflow in the editor area (middle column)
			this._openWorkflow(wf);

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

			// 如果该工作流的编辑器已打开，立刻关闭
			for (const { editor, groupId } of this.editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
				if (editor instanceof WorkflowEditorInput && editor.workflow.id === wf.id) {
					await this.editorService.closeEditor({ editor, groupId });
				}
			}

			this._workflows = this._workflows.filter(w => w.id !== wf.id);
			this._renderList();
		} catch (err) {
			this._flashMessage(err instanceof Error ? err.message : 'Failed to delete workflow');
		}
	}

	/**
	 * 复制工作流：创建一个副本（名称加 " (副本)" 后缀），
	 * 复制所有节点图、步骤、描述，但生成新的 id 和 agentId（新 agent 在打开时自动创建）。
	 */
	private async _handleDuplicate(wf: IStoredWorkflow): Promise<void> {
		try {
			const copyName = `${wf.name} (副本)`;
			const copy = await this.workflowStorage.createWorkflow({
				name: copyName,
				description: wf.description,
				steps: wf.steps ? [...wf.steps] : [],
			});

			// 复制节点图和连接（如果有）
			if (wf.nodes || wf.connections) {
				await this.workflowStorage.updateWorkflow(copy.id, {
					nodes: wf.nodes ? wf.nodes.map(n => ({ ...n, data: n.data ? { ...n.data } : undefined })) : undefined,
					connections: wf.connections ? wf.connections.map(c => ({ ...c })) : undefined,
					version: wf.version,
					category: wf.category,
					author: wf.author,
				});
			}

			this._workflows = [copy, ...this._workflows];
			this._renderList();
			this.notificationService.info(`已复制工作流 "${copyName}"`);
		} catch (err) {
			this._flashMessage(err instanceof Error ? err.message : 'Failed to duplicate workflow');
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
	// @ts-expect-error _runWorkflow保留供后续使用（v9移除了Run按钮但保留函数以备将来需要）
	private async _runWorkflow(wf: IStoredWorkflow): Promise<void> {
		try {
			// 使用工作流执行服务来执行工作流
			const executionId = await this.workflowExecutionService.executeWorkflow(wf.id);
			this.notificationService.info(`工作流 "${wf.name}" 已开始执行 (ID: ${executionId})`);
		} catch (err) {
			this.notificationService.error(`执行工作流失败: ${err instanceof Error ? err.message : String(err)}`);
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
			// v9: use the workflow name directly (no suffix) to keep names consistent.
			const agentName = wf.name;
			const systemPrompt = this._buildWorkflowSystemPrompt(wf);

			return await this.agentStudioService.createAgent({
				id: wf.id,
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

		// ── Workflow tool instructions ─────────────────────────────────
		lines.push('## Workflow Tools');
		lines.push('');
		lines.push('Available workflow editing tools:');
		lines.push('- `workflow_list` — List all workflows in the current workspace');
		lines.push('- `workflow_get` — Get the full state of a workflow (nodes, connections, metadata)');
		lines.push('- `workflow_get_schema` — Get available node types and their data schemas');
		lines.push('- `workflow_apply` — Apply a complete workflow definition (replaces all nodes/connections)');
		lines.push('');
		lines.push('Workflow creation/modification process:');
		lines.push(`1. First call \`workflow_get\` with workflow_id="${wf.id}" to see the current state`);
		lines.push('2. Call `workflow_get_schema` if you need to understand available node types');
		lines.push('3. Generate the complete workflow JSON with ALL nodes and connections');
		lines.push('4. Call `workflow_apply` with workflow_id, nodes, connections, and optional name/description');
		lines.push('');
		lines.push('Node types you can create:');
		lines.push('- System: `start`, `end` (every workflow MUST have both)');
		lines.push('- Basic: `prompt`, `agent`, `skill`, `tool`, `task`');
		lines.push('- Control flow: `ifElse`, `switch`, `condition`, `loop`, `parallel`, `askUser`');
		lines.push('- Layout: `group` (visual container, no execution logic)');
		lines.push('');
		lines.push('Guidelines:');
		lines.push('- Every workflow MUST have exactly one `start` and one `end` node');
		lines.push('- Position nodes with horizontal spacing of ~300px and vertical spacing of ~150px');
		lines.push('- Start node typically at {x: 80, y: 250}');
		lines.push('- Each connection requires: `id` (unique), `from` (source node id), `to` (target node id)');
		lines.push('- `workflow_apply` replaces the ENTIRE workflow — always provide ALL nodes and connections');
		lines.push('- Use descriptive labels for nodes so the workflow is readable');
		lines.push('- For branching nodes (ifElse, switch), include the branches array with unique IDs');
		lines.push('- Explain your changes briefly to the user after applying');
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
		lines.push('4. Always include Start and End nodes.');
		lines.push('');
		lines.push('### CRITICAL: Node Format');
		lines.push('Every node MUST use this exact structure with a `data` wrapper for all content fields:');
		lines.push('```');
		lines.push('{');
		lines.push('  "id": "unique-id",          // string, unique in this workflow');
		lines.push('  "type": "agent",            // from schema nodeTypes');
		lines.push('  "position": { "x": 320, "y": 200 },');
		lines.push('  "data": {                    // ALL content fields go inside data');
		lines.push('    "label": "Display Name",');
		lines.push('    "agentId": "coder",');
		lines.push('    "agentConfig": { "providerId": "knot", "modelId": "claude-sonnet-4-20250514" }');
		lines.push('  }');
		lines.push('}');
		lines.push('```');
		lines.push('DO NOT put label/agentId/agentConfig at the top level — they MUST be inside `data`.');
		lines.push('For agent nodes: always include agentConfig.modelId from availableAgents.');
		lines.push('');
		lines.push('### Connection Format');
		lines.push('```');
		lines.push('{ "id": "e1", "from": "start", "to": "dev" }');
		lines.push('{ "id": "e2", "from": "ask", "to": "opt1", "fromPort": "option-0" }  // multi-port nodes');
		lines.push('```');
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
			.workflow-install-btn {
				background: var(--vscode-button-background);
				border: none;
				color: var(--vscode-button-foreground);
				padding: 3px 10px;
				border-radius: 3px;
				cursor: pointer;
				font-size: 11px;
				font-weight: 600;
			}
			.workflow-install-btn:hover {
				background: var(--vscode-button-hoverBackground);
			}
			.workflow-list {
				flex: 1;
				overflow-y: auto;
				padding: 4px 0;
			}
			.workflow-item {
				display: flex;
				align-items: center;
				gap: 10px;
				padding: 8px 12px;
				cursor: pointer;
				border-bottom: 1px solid var(--vscode-panel-border);
				transition: background 0.1s;
				position: relative;
			}
			.workflow-item.pinned {
				background: var(--vscode-list-hoverBackground, rgba(90, 93, 94, 0.15));
			}
			.workflow-pin-icon {
				font-size: 11px;
				opacity: 0.8;
				flex-shrink: 0;
			}
			.workflow-item.dragging {
				opacity: 0.4;
			}
			.workflow-item.drop-before {
				box-shadow: 0 -2px 0 0 var(--vscode-focusBorder, #007fd4);
			}
			.workflow-item.drop-after {
				box-shadow: 0 2px 0 0 var(--vscode-focusBorder, #007fd4);
			}
			.workflow-item:hover {
				background: var(--vscode-list-hoverBackground);
			}
			.workflow-status-bar {
				position: absolute;
				left: 0;
				top: 0;
				bottom: 0;
				width: 3px;
				background: var(--vscode-button-background, #007acc);
				opacity: 0;
				transition: opacity 0.15s;
			}
			.workflow-item:hover .workflow-status-bar {
				opacity: 1;
			}
			.workflow-icon {
				flex-shrink: 0;
				width: 28px;
				height: 28px;
				border-radius: 6px;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 14px;
				background: linear-gradient(135deg, #3498db, #2980b9);
			}
			.workflow-body {
				flex: 1;
				min-width: 0;
				display: flex;
				flex-direction: column;
				gap: 2px;
			}
			.workflow-title-row {
				display: flex;
				align-items: center;
				gap: 6px;
			}
			.workflow-item-name {
				font-weight: 600;
				font-size: 13px;
				color: var(--vscode-foreground);
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			.workflow-version-badge {
				flex-shrink: 0;
				font-size: 10px;
				padding: 1px 5px;
				border-radius: 3px;
				font-weight: 600;
			}
			.workflow-version-badge.installed {
				background: var(--vscode-badge-background, #4d4d4d);
				color: var(--vscode-badge-foreground, #fff);
			}
			.workflow-version-badge.outdated {
				background: var(--vscode-statusBarItem-errorBackground, #c4314b);
				color: var(--vscode-statusBarItem-errorForeground, #fff);
			}
			.workflow-version-badge.remote {
				background: var(--vscode-textLink-foreground, #007acc);
				color: #fff;
			}
			.workflow-actions {
				display: flex;
				gap: 4px;
				flex-shrink: 0;
				opacity: 0;
				transition: opacity 0.15s;
			}
			.workflow-item:hover .workflow-actions {
				opacity: 1;
			}
			.workflow-btn {
				background: transparent;
				border: 1px solid var(--vscode-panel-border);
				color: var(--vscode-foreground);
				padding: 3px 6px;
				border-radius: 3px;
				cursor: pointer;
				font-size: 12px;
				line-height: 1;
			}
			.workflow-btn:hover {
				background: var(--vscode-toolbar-hoverBackground);
			}
			.workflow-btn.delete {
				color: var(--vscode-errorForeground);
			}
			.workflow-btn.delete:hover {
				background: var(--vscode-inputValidation-errorBackground);
				border-color: var(--vscode-errorForeground);
			}
			.workflow-item-desc {
				font-size: 11px;
				color: var(--vscode-descriptionForeground);
				line-height: 1.4;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			.workflow-item-meta {
				font-size: 10px;
				color: var(--vscode-descriptionForeground);
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
			.workflow-form-slug-prefix {
				flex-shrink: 0;
				font-size: 12px;
				font-weight: 600;
				color: var(--vscode-textPreformat-foreground);
				background: var(--vscode-textBlockQuote-background);
				padding: 4px 6px;
				border-radius: 3px;
				border: 1px solid var(--vscode-input-border);
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
