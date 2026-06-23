/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatBarPart.css';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { PANEL_ACTIVE_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_DRAG_AND_DROP_BORDER, PANEL_INACTIVE_TITLE_FOREGROUND, SIDE_BAR_TITLE_BORDER } from '../../../workbench/common/theme.js';
import { agentsPanelBackground, agentsPanelBorder, agentsPanelForeground, agentsBadgeBackground, agentsBadgeForeground } from '../../common/theme.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../workbench/common/views.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { LayoutPriority } from '../../../base/browser/ui/splitview/splitview.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../workbench/browser/parts/paneCompositePart.js';
import { Part } from '../../../workbench/browser/part.js';
import { ActionsOrientation } from '../../../base/browser/ui/actionbar/actionbar.js';
import { IPaneCompositeBarOptions } from '../../../workbench/browser/parts/paneCompositeBar.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { Extensions } from '../../../workbench/browser/panecomposite.js';
import { Menus } from '../menus.js';
import { ActiveChatBarContext, ChatBarFocusContext } from '../../common/contextkeys.js';
import { ChatCompositeBar } from './chatCompositeBar.js';
import { prepend } from '../../../base/browser/dom.js';
// @ts-ignore - TypeScript cannot find type declarations for .ts files imported with .js extension
import { AgentChatPanel } from '../agentChat/agentChatPanel.js';
import { AgentSettingsEditorInput } from '../../contrib/agentStudio/browser/agentSettingsEditorInput.js';
import { IAgentStudioService, IAgentChatService } from '../../common/agentStudioService.js';
import { IWorktreeService } from '../../contrib/worktree/common/worktreeService.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IModelSelectorService } from '../../contrib/agentStudio/common/modelSelector.js';
import { ICheckpointService } from '../../contrib/agentStudio/common/checkpointService.js';
import { ISkillRegistry } from '../../contrib/agentStudio/common/skills.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { autorun } from '../../../base/common/observable.js';
import type { AgentStatus as AgentChatAgentStatus, ChatMode, StreamPhase, IAgentChatMessage, IAgentSessionMeta, IWorktreeItem, IProviderInfo as IPanelProviderInfo, IModelInfo as IPanelModelInfo, ICheckpointInfo, IContextUsage, ILiveWorkflowExecution, ILiveWorkflowSubAgent, ILiveWorkflowEvent, ILiveCollectVariable } from '../agentChat/agentChatTypes.js';
import { uniqueMsgId, adaptPersistedChatMessage } from '../agentChat/agentChatTypes.js';

export class ChatBarPart extends AbstractPaneCompositePart { // TODO: should not be a AbstractPaneCompositePart but instead a custom Part with a CompositeBar

	static readonly activeViewSettingsKey = 'workbench.chatbar.activepanelid';
	static readonly pinnedViewsKey = 'workbench.chatbar.pinnedPanels';
	static readonly placeholderViewContainersKey = 'workbench.chatbar.placeholderPanels';
	static readonly viewContainersWorkspaceStateKey = 'workbench.chatbar.viewContainersWorkspaceState';

	override readonly minimumWidth: number = 300;
	override get maximumWidth(): number {
		// 限制最大宽度为当前窗口大小的 1/2
		return Math.max(300, this.layoutService.mainContainerDimension.width * 0.5);
	}
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	override get snap(): boolean { return false; }

	/** Visual margin values for the card-like appearance */
	static readonly MARGIN_TOP = 10;
	static readonly MARGIN_LEFT = 10;
	static readonly MARGIN_RIGHT = 10;
	static readonly MARGIN_BOTTOM = 0;

	/** Border width on the card (1px each side) */
	static readonly BORDER_WIDTH = 1;

	/** Height of the session composite bar when visible */
	private static readonly SESSION_BAR_HEIGHT = 35;

	private _sessionCompositeBar: ChatCompositeBar | undefined;
	private _agentChatPanel: AgentChatPanel | undefined;
	private _defaultAgentSelected = false;
	private _currentAgentId: string | undefined;
	private _currentSessionId: string | undefined;
	private _currentChatMode: ChatMode = 'craft';
	private _currentMaxContextTokens: number | undefined;

	protected _lastLayout: { readonly width: number; readonly height: number; readonly top: number; readonly left: number } | undefined;

	get preferredHeight(): number | undefined {
		return this.layoutService.mainContainerDimension.height * 0.4;
	}

	readonly priority = LayoutPriority.High;

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IMenuService menuService: IMenuService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
		@IAgentChatService private readonly _chatService: IAgentChatService,
		@IWorktreeService private readonly _worktreeService: IWorktreeService,
		@ICommandService private readonly _commandService: ICommandService,
		@IModelSelectorService private readonly _modelSelector: IModelSelectorService,
		@ICheckpointService private readonly _checkpointService: ICheckpointService,
		@ILogService private readonly _logService: ILogService,
		@ISkillRegistry private readonly _skillRegistry: ISkillRegistry,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
	) {
		super(
			Parts.CHATBAR_PART,
			{
				hasTitle: false,
				trailingSeparator: true,
				borderWidth: () => 0,
			},
			ChatBarPart.activeViewSettingsKey,
			ActiveChatBarContext.bindTo(contextKeyService),
			ChatBarFocusContext.bindTo(contextKeyService),
			'chatbar',
			'chatbar',
			undefined,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.ChatBar,
			Extensions.ChatBar,
			Menus.ChatBarTitle,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
		);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		this._logService.info(`[ChatBarPart] create: starting initialization`);

		// Create the session composite bar and prepend it before the content area
		this._sessionCompositeBar = this._register(this.instantiationService.createInstance(ChatCompositeBar));
		prepend(parent, this._sessionCompositeBar.element);

		// Create the agent chat panel and append after the session composite bar
		this._agentChatPanel = this._register(new AgentChatPanel({
			onSendMessage: (text: string, explicitSkillIds?: string[]) => {
				void this._handleSendMessage(text, explicitSkillIds);
			},
			onCancelExecution: () => {
				if (this._currentAgentId) {
					this._chatService.cancelStream(this._currentAgentId, this._currentSessionId);
				}
			},
			onToggleCollapse: () => {
				// Reserved for future layout toggle
			},
			onSelectAgent: (agentId: string) => {
				this._selectAndLoadAgent(agentId);
			},
			onSelectWorktree: (worktree: { path: string; branch: string }) => {
				this._worktreeService.setSelectedWorktree(worktree.path ? { path: worktree.path, branch: worktree.branch } : undefined);
			},
			onScrollToMessage: (_messageId: string) => {
				// Panel handles smooth-scroll internally; reserved for tracing.
			},
			onNewSession: () => {
				void this._createAgentSession();
			},
			onOpenSession: (sessionId: string) => {
				void this._openAgentSession(sessionId);
			},
			onRenameSession: (sessionId: string, newName: string) => {
				void this._renameAgentSession(sessionId, newName);
			},
			onDeleteSession: (sessionId: string) => {
				void this._deleteAgentSession(sessionId);
			},
		onOpenSettings: async () => {
			// Open agent settings page (refer to AgentChat.tsx settings button)
			if (!this._currentAgentId) {
				console.warn('[ChatBarPart] onOpenSettings: no agent selected');
				return;
			}
			try {
				const agent = await this._agentStudioService.getAgent(this._currentAgentId);
				if (!agent) {
					console.warn(`[ChatBarPart] onOpenSettings: agent ${this._currentAgentId} not found`);
					return;
				}
				const input = new AgentSettingsEditorInput(agent.id, agent.name);
				const groups = this._editorGroupsService.getGroups(0); // GroupsOrder.CREATION_TIME = 0
				const targetGroup = groups.length <= 1 ? 0 : groups[0]; // SIDE_GROUP = 0, but we want the first group
				await this._editorService.openEditor(input, { pinned: true }, targetGroup);
			} catch (err) {
				console.error('[ChatBarPart] onOpenSettings failed:', err);
			}
		},
			onChangeMode: (mode: ChatMode) => {
				this._currentChatMode = mode;
			},
			onSelectProvider: (providerId: string) => {
				const cur = this._modelSelector.getSelection();
				// Picking a provider keeps the modelId if compatible; otherwise the
				// model dropdown will be opened next by the panel. We just persist
				// providerId; the model list refresh handles model resolution.
				this._modelSelector.setSelection({
					providerId,
					modelId: cur?.modelId ?? '',
					agentId: cur?.agentId,
				});
			},
			onSelectModel: (modelId: string) => {
				const cur = this._modelSelector.getSelection();
				if (!cur) {
					return;
				}
				this._modelSelector.setSelection({
					providerId: cur.providerId,
					modelId,
					agentId: cur.agentId,
				});
			},
			onCheckpointAction: (action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string }) => {
				void this._handleCheckpointAction(action, payload);
			},
			onConfirmationAction: (_confirmationId: string, _buttonId: string) => {
				// Confirmation response dispatched to IAgentChatService (reserved)
			},
			onEditMessage: (messageId: string, newText: string) => {
				void this._handleEditMessage(messageId, newText);
			},
			onListSkills: () => {
				return this._skillRegistry.getSkills().map(s => ({
					id: s.id,
					name: s.name ?? s.id,
					description: (s as any).description ?? '',
				}));
			},
			// New callbacks for missing features
			onAskUserSubmit: (askUserId: string, executionId: string, nodeId: string, selection: string | string[]) => {
				// Send ask_user_submit delta to host
				void this._chatService.submitAskUser?.(this._currentAgentId ?? '', this._currentSessionId ?? '', executionId, nodeId, selection);
			},
			onQuestionClick: (_question: any) => {
				// Send the question as a user message
				const q = _question as any;
				if (q.label) {
					void this._handleSendMessage(q.label);
				}
			},
			onReferenceClick: (_ref: any) => {
				// Open the reference (file/url)
				const ref = _ref as any;
				if (ref.uri) {
					void this._commandService.executeCommand('vscode.open', ref.uri);
				}
			},
			onTipAction: (_tipId: string, _actionId: string) => {
				// Tip action callback - reserved
			},
			onTipDismiss: (_tipId: string) => {
				// Tip dismiss - just update message to remove tip
				// (no host call needed, tip is client-side)
			},
			onApplyCode: (_code: string, _language: string, _filePath?: string) => {
				// Apply code to file - delegate to host service
				void this._chatService.applyCode?.(this._currentAgentId ?? '', this._currentSessionId ?? '', _code, _language, _filePath);
			},
			onOpenFile: (_filePath: string) => {
				// Open file in editor
				void this._commandService.executeCommand('vscode.open', _filePath);
			},
		}));
		parent.appendChild(this._agentChatPanel.element);

		// Load available agents for the agent dropdown
		this._loadAvailableAgents();

		// Load worktrees on startup and observe changes
		void this._loadWorktrees();
		this._register(this._worktreeService.onDidChangeWorktrees(() => {
			void this._loadWorktrees();
		}));
		// Observe selectedWorktree changes (autorun fires once + on every change)
		this._register(autorun(reader => {
			const sel = this._worktreeService.selectedWorktree.read(reader);
			this._agentChatPanel?.setSelectedWorktree(sel?.path ?? '');
		}));

		// Observe agent session list changes for the active agent
		this._register(this._chatService.onDidChangeAgentSessions(({ agentId }) => {
			if (agentId === this._currentAgentId) {
				void this._loadAgentSessions(agentId);
			}
		}));

		// Workflow / TaskBoard → Chat prompt injection bridge
		// When a workflow is executed or a task board card triggers "Send to Chat",
		// this handler injects the generated prompt into the native chat composer
		// and optionally auto-sends it.
		this._register(this._agentStudioService.onDidRequestInjectPrompt(({ agentId, message }) => {
			// Only respond when this panel is showing the target agent,
			// matching the webview controller's guard logic.
			if (!this._currentAgentId || this._currentAgentId !== agentId) {
				return;
			}
			// Inject the prompt text into the textarea and auto-send
			if (this._agentChatPanel) {
				this._agentChatPanel.injectPrompt(message);
			}
		}));

		// Model selector wiring
		void this._refreshModelSelector();
		this._register(this._modelSelector.onDidChangeSelection(() => {
			void this._refreshModelSelector();
		}));
		this._register(this._modelSelector.onDidChangeAvailableModels(() => {
			void this._refreshModelSelector();
		}));

		// Checkpoint wiring — push the latest checkpoint into the panel when one is created
		this._register(this._checkpointService.onDidCreateCheckpoint((cp) => {
			if (cp.agentId === this._currentAgentId && cp.sessionId === this._currentSessionId) {
				void this._refreshCheckpointBar();
			}
		}));

		// Listen for agent selection from agentStudio webview
		this._register(this._agentStudioService.onDidSelectAgent(async (agentId) => {
			if (!agentId) {
				this._agentChatPanel?.setAgent(null);
				return;
			}
			await this._selectAndLoadAgent(agentId);
		}));

		// Relayout when session bar visibility changes
		this._register(this._sessionCompositeBar.onDidChangeVisibility(() => {
			if (this._lastLayout) {
				this.layout(this._lastLayout.width, this._lastLayout.height, this._lastLayout.top, this._lastLayout.left);
			}
		}));
	}

	private async _selectAndLoadAgent(agentId: string): Promise<void> {
		try {
			this._logService.info(`[ChatBarPart] _selectAndLoadAgent: agentId="${agentId}"`);
			const emp = await this._agentStudioService.getAgent(agentId);
			if (!emp) {
				this._logService.warn(`[ChatBarPart] _selectAndLoadAgent: agent not found for id="${agentId}"`);
				return;
			}
			if (!this._agentChatPanel) {
				this._logService.warn(`[ChatBarPart] _selectAndLoadAgent: _agentChatPanel is undefined`);
				return;
			}
			this._currentAgentId = emp.id;
			this._logService.info(`[ChatBarPart] _selectAndLoadAgent: setAgent -> id="${emp.id}", name="${emp.name}"`);

			this._agentChatPanel.setAgent({
				id: emp.id,
				name: emp.name,
				role: emp.role,
				avatarUrl: emp.avatar,
				icon: emp.icon,
				status: (emp.status ?? 'idle') as AgentChatAgentStatus,
				isPM: emp.id === 'pm' || emp.role?.toLowerCase().includes('project manager'),
				customPrompt: emp.systemPrompt,
				model: emp.model,
				provider: undefined,
				agentType: ((emp as any).agentType ?? (emp.id === 'pm' ? 'planner' : 'general')) as 'general' | 'planner' | string,
			});

			// Load chat history of the active session (or root default) for this agent
			try {
				const activeSession = await (this._chatService as any).getOrCreateActiveSession?.(emp.id);
				this._currentSessionId = activeSession?.id;
				const history = await this._chatService.getHistory(emp.id, this._currentSessionId);
				this._agentChatPanel.setMessages(history.map(m => this._adaptChatMessage(m)).filter((m): m is IAgentChatMessage => !!m));
			} catch {
				this._agentChatPanel.setMessages([]);
				this._currentSessionId = undefined;
			}

			// Load agent session list (for history overlay)
			void this._loadAgentSessions(emp.id);

			// Register active session for checkpoint scoping & refresh checkpoint bar
			if (this._currentSessionId) {
				try {
					this._checkpointService.setActiveSession(emp.id, this._currentSessionId);
				} catch { /* ignore */ }
			}
			void this._refreshCheckpointBar();
		} catch (err) {
			this._logService.error(`[ChatBarPart] _selectAndLoadAgent: failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
		}
	}

	private async _loadAvailableAgents(): Promise<void> {
		try {
			const agents = await this._agentStudioService.getAgents();
			this._logService.info(
				`[ChatBarPart] _loadAvailableAgents: fetched ${agents?.length ?? 0} agents — ` +
				`ids=[${(agents ?? []).map(a => a.id).join(', ')}]`
			);
			// [ICON-DEBUG] Log icon state of agents returned by getAgents().
			this._logService.info(
				`[ICON-DEBUG][chatBarPart._loadAvailableAgents] icons=` +
				JSON.stringify((agents ?? []).map(a => ({ id: a.id, name: a.name, avatar: (a as any).avatar ? '(set)' : undefined, icon: a.icon })))
			);
			if (this._agentChatPanel && agents) {
				this._agentChatPanel.setAvailableAgents(
					agents.map(emp => ({
						id: emp.id,
						name: emp.name,
						role: emp.role,
						avatarUrl: emp.avatar,
						icon: emp.icon,
						status: (emp.status ?? 'idle') as AgentChatAgentStatus,
						isPM: emp.id === 'pm' || emp.role?.toLowerCase().includes('project manager'),
						customPrompt: emp.systemPrompt,
						model: emp.model,
						provider: undefined,
						agentType: ((emp as any).agentType ?? (emp.id === 'pm' ? 'planner' : 'general')) as 'general' | 'planner' | string,
					}))
				);

				// 默认选中 claw agent（多级 fallback）：
				//   1. id / presetId 完全等于 'saros-claw' / 'claw'
				//   2. id / presetId / name / role 不区分大小写包含 'claw'
				//   3. 上面都没匹配到 → 列表第一个 agent
				if (!this._defaultAgentSelected && agents.length > 0) {
					const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '');
					const matchExact = (a: any) => a.id === 'saros-claw' || a.id === 'claw' || (a as any).presetId === 'claw' || (a as any).presetId === 'saros-claw';
					const matchFuzzy = (a: any) => lower(a.id).includes('claw') || lower((a as any).presetId).includes('claw') || lower(a.name).includes('claw') || lower(a.role).includes('claw');
					const target = agents.find(matchExact) ?? agents.find(matchFuzzy) ?? agents[0];
					if (target) {
						this._defaultAgentSelected = true;
						this._logService.info(`[ChatBarPart] _loadAvailableAgents: defaulting to agent "${target.id}" (${target.name})`);
						await this._selectAndLoadAgent(target.id);
					} else {
						this._logService.warn(`[ChatBarPart] _loadAvailableAgents: no matching agent found in list of ${agents.length}`);
					}
				} else if (this._defaultAgentSelected) {
					this._logService.info(`[ChatBarPart] _loadAvailableAgents: skip — _defaultAgentSelected already true`);
				} else {
					this._logService.warn(`[ChatBarPart] _loadAvailableAgents: agents list is empty`);
				}
			} else {
				this._logService.warn(
					`[ChatBarPart] _loadAvailableAgents: skip — panel=${!!this._agentChatPanel}, agents=${!!agents}`
				);
			}
		} catch (err) {
			this._logService.error(`[ChatBarPart] _loadAvailableAgents: failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
		}
	}

	// ---------- worktree wiring ----------

	private async _loadWorktrees(): Promise<void> {
		if (!this._agentChatPanel) {
			return;
		}
		try {
			const repoRoot = await this._worktreeService.getRepositoryRoot();
			if (!repoRoot) {
				this._agentChatPanel.setWorktrees([]);
				return;
			}
			const details = await this._worktreeService.listWorktrees(repoRoot);
			const items: IWorktreeItem[] = details.map(d => ({
				path: d.path,
				branch: d.isBranch ? d.name : (d.detached ? `(detached @ ${d.hash.slice(0, 7)})` : d.name),
			}));
			this._agentChatPanel.setWorktrees(items);
		} catch {
			this._agentChatPanel.setWorktrees([]);
		}
	}

	// ---------- agent session list wiring ----------

	private async _loadAgentSessions(agentId: string): Promise<void> {
		if (!this._agentChatPanel) {
			return;
		}
		try {
			const sessions = await this._chatService.listAgentSessions(agentId);
			if (Array.isArray(sessions)) {
				const metas: IAgentSessionMeta[] = sessions.map((s: any) => ({
					id: s.id,
					name: s.name ?? '未命名会话',
					createdAt: s.createdAt ?? new Date().toISOString(),
					updatedAt: s.updatedAt ?? s.createdAt ?? new Date().toISOString(),
					messageCount: s.messageCount ?? 0,
				}));
				this._agentChatPanel.setAgentSessions(metas);
			} else {
				this._agentChatPanel.setAgentSessions([]);
			}
		} catch {
			this._agentChatPanel.setAgentSessions([]);
		}
	}

	private async _createAgentSession(): Promise<void> {
		if (!this._currentAgentId || !this._agentChatPanel) {
			return;
		}
		try {
			const meta = await this._chatService.createAgentSession(this._currentAgentId, '新对话');
			this._currentSessionId = meta.id;
			this._agentChatPanel.setMessages([]);
			this._agentChatPanel.setCheckpoint(null);
			try {
				this._checkpointService.setActiveSession(this._currentAgentId, meta.id);
			} catch { /* ignore */ }
			void this._loadAgentSessions(this._currentAgentId);
		} catch {
			// ignore
		}
	}

	private async _openAgentSession(sessionId: string): Promise<void> {
		if (!this._currentAgentId || !this._agentChatPanel) {
			return;
		}
		try {
			this._currentSessionId = sessionId;
			const history = await this._chatService.getHistory(this._currentAgentId, sessionId);
			this._agentChatPanel.setMessages(history.map(m => this._adaptChatMessage(m)).filter((m): m is IAgentChatMessage => !!m));
			try {
				this._checkpointService.setActiveSession(this._currentAgentId, sessionId);
			} catch { /* ignore */ }
			void this._refreshCheckpointBar();
		} catch {
			this._agentChatPanel.setMessages([]);
		}
	}

	private async _renameAgentSession(sessionId: string, newName: string): Promise<void> {
		if (!this._currentAgentId) {
			return;
		}
		try {
			await this._chatService.renameAgentSession(this._currentAgentId, sessionId, newName);
			void this._loadAgentSessions(this._currentAgentId);
		} catch {
			// ignore
		}
	}

	private async _deleteAgentSession(sessionId: string): Promise<void> {
		if (!this._currentAgentId) {
			return;
		}
		try {
			await this._chatService.deleteAgentSession(this._currentAgentId, sessionId);
			if (this._currentSessionId === sessionId) {
				this._currentSessionId = undefined;
				this._agentChatPanel?.setMessages([]);
			}
			void this._loadAgentSessions(this._currentAgentId);
		} catch {
			// ignore
		}
	}

	// ---------- send message + streaming bridge ----------

	/**
	 * Handles an inline user-message edit (edit → truncate → regenerate).
	 *
	 * The panel has already removed the edited message and everything after it
	 * from the in-memory view. Here we truncate the *persisted* history to drop
	 * the edited user message (and everything after), then re-send the new text
	 * through the normal send flow so a fresh user message + assistant reply are
	 * produced and persisted.
	 */
	private async _handleEditMessage(messageId: string, newText: string): Promise<void> {
		if (!this._currentAgentId) {
			return;
		}
		const agentId = this._currentAgentId;
		const sessionId = this._currentSessionId;
		try {
			const history = await this._chatService.getHistory(agentId, sessionId);
			const idx = history.findIndex(m => m.id === messageId);
			if (idx <= 0) {
				// Edited message is the first message → clear the whole history.
				await this._chatService.clearHistory(agentId, sessionId);
			} else {
				// Keep everything before the edited user message.
				await this._chatService.deleteMessagesAfter(agentId, sessionId, history[idx - 1].id);
			}
		} catch (err) {
			console.error('[ChatBarPart] _handleEditMessage: truncate failed:', err);
			return;
		}
		// Re-send the edited text through the normal flow.
		await this._handleSendMessage(newText);
	}

	private async _handleSendMessage(text: string, explicitSkillIdsFromChips?: string[]): Promise<void> {
		if (!this._currentAgentId || !this._agentChatPanel) {
			return;
		}
		const trimmed = (text ?? '').trim();
		if (!trimmed) {
			return;
		}

		const panel = this._agentChatPanel;
		const agentId = this._currentAgentId;

		// Session id convergence: ensure a concrete session id before sending so
		// the stream is never persisted into the agent-only "noSession bucket"
		// (historical cross-talk root cause). `_currentSessionId`,
		// `AgentSessionMeta.id`, the checkpoint session and the provider session
		// all refer to this same logical session.
		if (!this._currentSessionId) {
			try {
				const active = await this._chatService.getOrCreateActiveSession(agentId);
				this._currentSessionId = active.id;
				try {
					this._checkpointService.setActiveSession(agentId, active.id);
				} catch { /* ignore */ }
			} catch (err) {
				console.error('[ChatBarPart] _handleSendMessage: ensure session failed:', err);
			}
		}


		// Extract /skill commands as explicitSkillIds
		const slashSkills: string[] = [];
		const slashRegex = /\/(\w+)\b/g;
		let slashMatch: RegExpExecArray | null;
		while ((slashMatch = slashRegex.exec(trimmed)) !== null) {
			const skillId = slashMatch[1];
			// Validate against registered skills (case-insensitive)
			const skill = this._skillRegistry.getSkills().find(
				s => s.id.toLowerCase() === skillId.toLowerCase(),
			);
			if (skill) { slashSkills.push(skill.id); }
		}

		// Merge explicitSkillIds from skill chips (panel) with slash skills from text
		const allExplicitSkillIds = [...(explicitSkillIdsFromChips || []), ...slashSkills];
		const uniqueSkillIds = [...new Set(allExplicitSkillIds)]; // deduplicate

		// Collect attachments from panel
		const attachments = panel.getAttachments()
			.map(a => ({
				id: a.id,
				type: a.type,
				name: a.name,
				mimeType: a.mimeType,
				data: a.data,
				size: a.size,
				isPasted: a.isPasted,
			}));

		// Optimistically append the user message
		const userMsg: IAgentChatMessage = {
			id: uniqueMsgId(),
			role: 'user',
			content: trimmed,
			timestamp: Date.now(),
			attachments: [...attachments],
		};
		panel.addMessage(userMsg);
		panel.clearAttachments();

		// Create a streaming assistant placeholder
		const assistantId = uniqueMsgId();
		const assistantMsg: IAgentChatMessage = {
			id: assistantId,
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			isStreaming: true,
			streamPhase: 'llm_streaming',
		};
		panel.addMessage(assistantMsg);
		panel.setSending(true);

		const selectedWorktreePath = this._worktreeService.selectedWorktree.get()?.path;

		try {
			await this._chatService.sendMessage(
				agentId,
				trimmed,
				{
					chatMode: this._currentChatMode,
					agentSessionId: this._currentSessionId,
					worktreePath: selectedWorktreePath,
					attachments: attachments.length > 0 ? attachments as any : undefined,
					explicitSkillIds: uniqueSkillIds.length > 0 ? uniqueSkillIds : undefined,
				},
				(delta) => {
					switch (delta.type) {
				case 'phase_change': {
					// Track phase transitions (thinking → text → tool → done)
					const newPhase: StreamPhase = (delta.phase as StreamPhase) ?? 'llm_streaming';
					assistantMsg.streamPhase = newPhase;
					assistantMsg.currentStep = delta.phase as string;
					panel.setStreamPhase(newPhase);
					panel.updateMessage(assistantId, {
						streamPhase: newPhase,
						currentStep: delta.phase as string,
						isThinking: newPhase === 'llm_streaming',
					});
					break;
				}
				case 'text': {
					const next = (delta.fullText !== undefined)
						? delta.fullText
						: (assistantMsg.content + (delta.content ?? ''));
					assistantMsg.content = next;
					assistantMsg.streamPhase = 'llm_streaming';
					panel.setStreamPhase('llm_streaming');
					panel.updateMessage(assistantId, {
						content: next,
						isStreaming: true,
						isThinking: false,
						streamPhase: 'llm_streaming',
						currentStep: 'llm_streaming',
					});
					break;
				}
						case 'thinking': {
							const next = (delta.fullThinking !== undefined)
								? delta.fullThinking
								: ((assistantMsg.thinking ?? '') + (delta.content ?? ''));
							assistantMsg.thinking = next;
							panel.updateMessage(assistantId, {
								thinking: next,
								isThinking: true,
								currentStep: 'thinking',
							});
							break;
						}
				case 'tool_start': {
					const calls = (assistantMsg.toolCalls ?? []).slice();
					calls.push({
						id: delta.toolCallId ?? `tc-${calls.length}`,
						name: delta.toolName ?? 'tool',
						args: delta.content,
						status: 'running',
						displayName: delta.displayName,
						renderType: delta.renderType,
						textPosition: delta.textPosition ?? (assistantMsg.content?.length ?? 0),
					});
					assistantMsg.toolCalls = calls;
					assistantMsg.streamPhase = 'tool_executing';
					panel.setStreamPhase('tool_executing');
					panel.updateMessage(assistantId, {
						toolCalls: calls,
						streamPhase: 'tool_executing',
						currentStep: 'execute_tool',
						isThinking: false,
					});
					break;
				}
						case 'tool_args': {
							// Append args for the current running tool call
							const calls = (assistantMsg.toolCalls ?? []).map(c =>
								c.id === delta.toolCallId
									? { ...c, args: (c.args ?? '') + (delta.content ?? '') }
									: c
							);
							assistantMsg.toolCalls = calls;
							panel.updateMessage(assistantId, { toolCalls: calls });
							break;
						}
						case 'tool_progress': {
							const calls = (assistantMsg.toolCalls ?? []).map(c =>
								c.id === delta.toolCallId
									? { ...c, args: delta.content ? `${c.args ?? ''}\n${delta.content}` : c.args }
									: c
							);
							assistantMsg.toolCalls = calls;
							panel.updateMessage(assistantId, { toolCalls: calls });
							break;
						}
						case 'tool_end':
						case 'tool_result': {
							const calls = (assistantMsg.toolCalls ?? []).map(c =>
								c.id === delta.toolCallId
									? {
										...c,
										status: 'completed' as const,
										result: delta.content ?? c.result,
										displayName: delta.displayName ?? c.displayName,
										renderType: delta.renderType ?? c.renderType,
									}
									: c
							);
							assistantMsg.toolCalls = calls;
							panel.updateMessage(assistantId, { toolCalls: calls });
							break;
						}
						case 'usage': {
							if (delta.usage) {
								const input = delta.usage.inputTokens ?? 0;
								const output = delta.usage.outputTokens ?? 0;
								const total = input + output;
								assistantMsg.tokenUsage = { input, output, total };
								panel.updateMessage(assistantId, { tokenUsage: assistantMsg.tokenUsage });

								const limit = this._currentMaxContextTokens ?? 0;
								if (limit > 0) {
									// 参考React：使用 setStreamUsage 传递原始 usage 数据
									panel.setStreamUsage({
										input: delta.usage.inputTokens ?? 0,
										output: delta.usage.outputTokens ?? 0,
										seen: true,
									});
								}
							}
							break;
						}
				case 'context_compacted': {
					assistantMsg.streamPhase = 'compressing';
					panel.setStreamPhase('compressing');
					panel.updateMessage(assistantId, { streamPhase: 'compressing' });
					const compacted = delta.compactedInputTokens ?? 0;
					if (compacted > 0) {
						panel.setCompactedBaseline(compacted);
					}
					const limit = this._currentMaxContextTokens ?? 0;
					if (limit > 0 && compacted > 0) {
						const ratio = Math.max(0, Math.min(1, compacted / limit));
						panel.setContextUsage({
							used: compacted,
							limit,
							ratio,
							percent: ratio * 100,
						} satisfies IContextUsage);
					}
					break;
				}
						case 'sub_agent_start': {
							const subs = (assistantMsg.subAgents ?? []).slice();
							subs.push({
								id: delta.subAgentId ?? `sa-${subs.length}`,
								type: (delta.subAgentType as any) ?? 'general',
								task: delta.subAgentTask ?? '',
								status: 'pending',
								groupId: delta.subAgentGroupId,
							});
							assistantMsg.subAgents = subs;
							panel.updateMessage(assistantId, { subAgents: subs });
							break;
						}
						case 'sub_agent_progress': {
							const subs = (assistantMsg.subAgents ?? []).map(s =>
								s.id === delta.subAgentId
									? { ...s, status: (delta.subAgentStatus as any) ?? s.status, progress: delta.subAgentProgress ?? s.progress, output: delta.subAgentOutput ?? s.output, error: delta.subAgentError ?? s.error }
									: s
							);
							assistantMsg.subAgents = subs;
							panel.updateMessage(assistantId, { subAgents: subs });
							break;
						}
						case 'sub_agent_end': {
							const subs = (assistantMsg.subAgents ?? []).map(s =>
								s.id === delta.subAgentId
									? { ...s, status: 'done' as const, output: delta.subAgentOutput ?? s.output }
									: s
							);
							assistantMsg.subAgents = subs;
							panel.updateMessage(assistantId, { subAgents: subs });
							break;
						}
						case 'confirmation': {
							if (delta.confirmationData) {
								assistantMsg.confirmation = {
									id: delta.confirmationData.id,
									title: delta.confirmationData.title,
									message: delta.confirmationData.message,
									detail: delta.confirmationData.detail,
									status: delta.confirmationData.status,
									buttons: delta.confirmationData.buttons.map(b => ({ id: b.id, label: b.label, primary: b.primary, danger: b.danger })),
								};
								panel.updateMessage(assistantId, { confirmation: assistantMsg.confirmation });
							}
							break;
						}
				case 'done': {
					assistantMsg.streamPhase = 'idle';
					panel.setStreamPhase('idle');
					panel.updateMessage(assistantId, { isStreaming: false, isThinking: false, streamPhase: 'idle' });
					break;
				}
				case 'error': {
					assistantMsg.streamPhase = 'error';
					panel.setStreamPhase('error');
					const errObj = typeof delta.content === 'object' ? delta.content : undefined;
					const errMsg = typeof delta.content === 'string' ? delta.content : (errObj as any)?.message ?? '执行失败';
					assistantMsg.metadata = { ...assistantMsg.metadata, streamError: {
						message: errMsg,
						level: ((delta as any).level as string) || 'error',
						retryable: (delta as any).retryable !== false,
						isRateLimited: !!(delta as any).isRateLimited,
					}};
					panel.updateMessage(assistantId, {
						isStreaming: false,
						isThinking: false,
						streamPhase: 'error',
						content: (assistantMsg.content || '') + `\n\n⚠ ${errMsg}`,
						metadata: assistantMsg.metadata,
					});
					break;
				}
				case 'content_replace': {
					assistantMsg.content = delta.content ?? assistantMsg.content;
					panel.updateMessage(assistantId, { content: assistantMsg.content });
					break;
				}
				case 'discard_prior_text': {
					assistantMsg.thinking = '';
					panel.updateMessage(assistantId, { thinking: '', isThinking: false });
					break;
				}
				case 'tool_approval_request': {
					const calls = (assistantMsg.toolCalls ?? []).map(c =>
						c.id === delta.toolCallId
							? { ...c, status: 'approval_required' as any, securityLevel: delta.securityLevel }
							: c
					);
					assistantMsg.toolCalls = calls;
					assistantMsg.streamPhase = 'awaiting_approval';
					panel.setStreamPhase('awaiting_approval');

					// Create confirmation object for terminal/tools that need approval
					const toolName = delta.toolName || '';
					const isTerminal = toolName.toLowerCase().includes('terminal') || toolName.toLowerCase().includes('exec') || toolName.toLowerCase().includes('shell');
					const confirmation: any = {
						id: delta.toolCallId || `cf-${Date.now()}`,
						title: isTerminal ? '执行终端命令' : (delta.confirmationData?.title || '确认操作'),
						message: isTerminal ? (delta.toolArgs || '执行命令...') : (delta.confirmationData?.message || ''),
						status: 'pending',
						securityLevel: delta.securityLevel || 'cautious',
						buttons: delta.confirmationData?.buttons || [
							{ id: 'allow_once', label: '执行', primary: true },
							{ id: 'reject', label: '取消', danger: true },
						],
						autoConfirmOptions: delta.confirmationData?.autoConfirmOptions || [
							{ id: 'allow_session', label: '在此会话中允许' },
							{ id: 'allow_workspace', label: '在工作区中允许' },
							{ id: 'allow_always', label: '始终允许' },
						],
						// For terminal confirmation card
						command: isTerminal ? (delta.toolArgs || '') : undefined,
						toolName: toolName,
					};
					assistantMsg.confirmation = confirmation;
					panel.updateMessage(assistantId, { toolCalls: calls, streamPhase: 'awaiting_approval', confirmation });
					break;
				}
				case 'tool_approval_resolved': {
					panel.setStreamPhase('tool_executing');
					panel.updateMessage(assistantId, { streamPhase: 'tool_executing' });
					break;
				}
				// ── AskUser cards ──────────────────────────────
				case 'ask_user_start': {
					const askUser = {
						id: delta.askUserId ?? `${delta.executionId}:${delta.nodeId}`,
						executionId: delta.executionId ?? '',
						nodeId: delta.nodeId ?? '',
						nodeName: delta.nodeName ?? '工作流',
						question: delta.question ?? '',
						options: (delta.options ?? []) as any,
						multiSelect: !!(delta.multiSelect),
						selectedIndices: [] as number[],
						status: 'pending' as const,
						createdAt: Date.now(),
					};
					if (!assistantMsg.askUsers) { assistantMsg.askUsers = []; }
					assistantMsg.askUsers = [...assistantMsg.askUsers, askUser];
					panel.updateMessage(assistantId, { askUsers: assistantMsg.askUsers });
					break;
				}
				case 'ask_user_progress': {
					if (assistantMsg.askUsers) {
						const status = delta.status as 'answered' | 'cancelled' | 'expired';
						assistantMsg.askUsers = assistantMsg.askUsers.map(au =>
							au.id === (delta.askUserId ?? `${delta.executionId}:${delta.nodeId}`)
								? { ...au, status, selection: delta.selection, answeredAt: Date.now() }
								: au
						);
						panel.updateMessage(assistantId, { askUsers: assistantMsg.askUsers });
					}
					break;
				}
				// ── TodoList ──────────────────────────────────
				case 'todo_list': {
					const todos = (delta.todos ?? []) as any[];
					assistantMsg.todos = todos.map((t: any) => ({
						id: t.id ?? `todo-${Date.now()}`,
						label: t.label ?? '',
						completed: !!t.completed,
						description: t.description,
						assignee: t.assignee,
					}));
					panel.updateMessage(assistantId, { todos: assistantMsg.todos });
					break;
				}
				// ── QuestionCarousel ───────────────────────────
				case 'question_carousel': {
					const questions = (delta.questions ?? []) as any[];
					assistantMsg.questions = questions.map((q: any) => ({
						id: q.id ?? `q-${Date.now()}`,
						label: q.label ?? '',
						tooltip: q.tooltip,
						category: q.category,
					}));
					panel.updateMessage(assistantId, { questions: assistantMsg.questions });
					break;
				}
				// ── References ───────────────────────────────
				case 'references': {
					const refs = (delta.references ?? []) as any[];
					assistantMsg.references = refs.map((r: any) => ({
						id: r.id ?? `ref-${Date.now()}`,
						kind: r.kind ?? 'file',
						name: r.name ?? '',
						uri: r.uri,
						range: r.range,
						description: r.description,
						state: r.state,
					}));
					panel.updateMessage(assistantId, { references: assistantMsg.references });
					break;
				}
				// ── Tip ─────────────────────────────────────
				case 'tip': {
					assistantMsg.tip = {
						id: delta.tipId ?? `tip-${Date.now()}`,
						content: delta.content ?? '',
						icon: delta.icon,
						action: delta.action ? { label: delta.action.label, tooltip: delta.action.tooltip, actionId: delta.action.actionId! } : undefined,
					};
					panel.updateMessage(assistantId, { tip: assistantMsg.tip });
					break;
				}
			// ── Progress ───────────────────────────────
			case 'progress': {
				const items = (delta.progress ?? []) as any[];
				assistantMsg.progress = items.map((p: any) => ({
					id: p.id ?? `prog-${Date.now()}`,
					content: p.content ?? '',
					status: p.status ?? 'pending',
					icon: p.icon,
					timestamp: p.timestamp,
				}));
				panel.updateMessage(assistantId, { progress: assistantMsg.progress });
				break;
			}
			// ── LiveWorkflowTraceView ────────────────────
			case 'workflow_start': {
				// Initialize a new workflow execution
				const executionId = delta.executionId ?? `exec-${Date.now()}`;
				const workflowExec: ILiveWorkflowExecution = {
					executionId,
					workflowName: delta.workflowName ?? 'Workflow',
					status: 'running',
					currentNodeId: delta.currentNodeId,
					subAgents: [],
					startTime: Date.now(),
				};
				// Store in assistant message (will be rendered by LiveWorkflowTraceView)
				if (!assistantMsg.workflowExecutions) { assistantMsg.workflowExecutions = {}; }
				assistantMsg.workflowExecutions[executionId] = workflowExec;
				panel.updateMessage(assistantId, { workflowExecutions: assistantMsg.workflowExecutions });
				break;
			}
			case 'workflow_end': {
				const executionId = delta.executionId ?? '';
				if (assistantMsg.workflowExecutions && assistantMsg.workflowExecutions[executionId]) {
					assistantMsg.workflowExecutions[executionId] = {
						...assistantMsg.workflowExecutions[executionId],
						status: (delta.status as 'cancelled' | 'completed' | 'failed' | 'running') ?? 'completed',
						endTime: Date.now(),
					};
					panel.updateMessage(assistantId, { workflowExecutions: assistantMsg.workflowExecutions });
				}
				break;
			}
			case 'workflow_subagent_start': {
				const executionId = delta.executionId ?? '';
				const subAgent: ILiveWorkflowSubAgent = {
					id: delta.subAgentId ?? `sa-${Date.now()}`,
					name: delta.subAgentName ?? 'Sub-agent',
					task: delta.task,
					status: 'running',
					startTime: Date.now(),
				};
				if (!assistantMsg.workflowExecutions) { assistantMsg.workflowExecutions = {}; }
				if (assistantMsg.workflowExecutions[executionId]) {
					assistantMsg.workflowExecutions[executionId].subAgents.push(subAgent);
				} else {
					// Create execution if it doesn't exist
					assistantMsg.workflowExecutions[executionId] = {
						executionId,
						workflowName: delta.workflowName ?? 'Workflow',
						status: 'running',
						subAgents: [subAgent],
						startTime: Date.now(),
					};
				}
				panel.updateMessage(assistantId, { workflowExecutions: assistantMsg.workflowExecutions });
				break;
			}
			case 'workflow_subagent_end': {
				const executionId = delta.executionId ?? '';
				const subAgentId = delta.subAgentId ?? '';
				if (assistantMsg.workflowExecutions && assistantMsg.workflowExecutions[executionId]) {
					const subAgents = assistantMsg.workflowExecutions[executionId].subAgents.map(sa =>
						sa.id === subAgentId
							? { ...sa, status: (delta.status ?? 'done') as any, output: delta.output ?? sa.output, error: delta.error ?? sa.error, endTime: Date.now() }
							: sa
					);
					assistantMsg.workflowExecutions[executionId] = {
						...assistantMsg.workflowExecutions[executionId],
						subAgents,
					};
					panel.updateMessage(assistantId, { workflowExecutions: assistantMsg.workflowExecutions });
				}
				break;
			}
			case 'workflow_delta': {
				// Streaming delta for a sub-agent (text/thinking/tool calls)
				const executionId = delta.executionId ?? '';
				const subAgentId = delta.subAgentId ?? '';
				if (assistantMsg.workflowExecutions && assistantMsg.workflowExecutions[executionId]) {
					const subAgents = assistantMsg.workflowExecutions[executionId].subAgents.map(sa =>
						sa.id === subAgentId
							? {
								...sa,
								streamedText: delta.content ? (sa.streamedText ?? '') + delta.content : sa.streamedText,
								streamedThinking: delta.thinking ? (sa.streamedThinking ?? '') + delta.thinking : sa.streamedThinking,
							}
							: sa
					);
					assistantMsg.workflowExecutions[executionId] = {
						...assistantMsg.workflowExecutions[executionId],
						subAgents,
					};
					panel.updateMessage(assistantId, { workflowExecutions: assistantMsg.workflowExecutions });
				}
				break;
			}
			case 'workflow_ask_user': {
				// Workflow is asking user for input
				const executionId = delta.executionId ?? '';
				const askUserEvent: ILiveWorkflowEvent = {
					id: delta.eventId ?? `event-${Date.now()}`,
					executionId,
					sessionId: delta.sessionId ?? '',
					timestamp: Date.now(),
					kind: 'ask_user',
					nodeId: delta.nodeId ?? '',
					nodeName: delta.nodeName,
					nodeType: delta.nodeType,
					ask: delta.question ?? '',
				};
				if (!assistantMsg.workflowEvents) { assistantMsg.workflowEvents = []; }
				assistantMsg.workflowEvents.push(askUserEvent);
				panel.updateMessage(assistantId, { workflowEvents: assistantMsg.workflowEvents });
				break;
			}
		case 'workflow_ask_user_end': {
			const eventId = delta.eventId ?? '';
				if (assistantMsg.workflowEvents) {
					assistantMsg.workflowEvents = assistantMsg.workflowEvents.map(evt =>
						evt.id === eventId ? { ...evt, kind: 'ask_user_end' as any } : evt
					);
					panel.updateMessage(assistantId, { workflowEvents: assistantMsg.workflowEvents });
				}
				break;
			}
			case 'workflow_collect_variables': {
				const executionId = delta.executionId ?? '';
				const collectVar: ILiveCollectVariable = {
					id: delta.collectId ?? `cv-${Date.now()}`,
					executionId,
					variables: delta.variables ?? [],
					values: delta.values ?? {},
					status: 'pending',
					createdAt: Date.now(),
				};
				if (!assistantMsg.collectVariables) { assistantMsg.collectVariables = {}; }
				assistantMsg.collectVariables[collectVar.id] = collectVar;
				panel.updateMessage(assistantId, { collectVariables: assistantMsg.collectVariables });
				break;
			}
			case 'workflow_collect_variables_end': {
				const collectId = delta.collectId ?? '';
				if (assistantMsg.collectVariables && assistantMsg.collectVariables[collectId]) {
					assistantMsg.collectVariables[collectId] = {
						...assistantMsg.collectVariables[collectId],
						status: (delta.status as 'pending' | 'skipped' | 'submitted') ?? 'submitted',
						values: (delta.values as Record<string, string>) ?? assistantMsg.collectVariables[collectId].values,
					};
					panel.updateMessage(assistantId, { collectVariables: assistantMsg.collectVariables });
				}
				break;
			}
			case 'workflow_breakpoint_hit': {
				const executionId = delta.executionId ?? '';
				const bpEvent: ILiveWorkflowEvent = {
					id: delta.eventId ?? `bp-${Date.now()}`,
					executionId,
					sessionId: delta.sessionId ?? '',
					timestamp: Date.now(),
					kind: 'breakpoint_hit',
					nodeId: delta.nodeId ?? '',
					nodeName: delta.nodeName,
					nodeType: delta.nodeType,
					summary: delta.summary ?? 'Breakpoint hit',
				};
				if (!assistantMsg.workflowEvents) { assistantMsg.workflowEvents = []; }
				assistantMsg.workflowEvents.push(bpEvent);
				panel.updateMessage(assistantId, { workflowEvents: assistantMsg.workflowEvents });
				break;
			}
			default:
				// Ignore other delta types in this lightweight panel
				break;
				}
			},
		);
	} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			assistantMsg.metadata = { ...assistantMsg.metadata, streamError: errorMsg };
			panel.updateMessage(assistantId, {
				isStreaming: false,
				isThinking: false,
				content: (assistantMsg.content || '') + `\n\n⚠ ${errorMsg}`,
				metadata: assistantMsg.metadata,
			});
		} finally {
			panel.setSending(false);
		}
	}

	private _adaptChatMessage(m: { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; thinking?: string; toolCalls?: any[]; turnId?: string; timestamp: string }): IAgentChatMessage | null {
		// 阶段E：统一适配入口。assistant 消息携带有序 parts（取代 textPosition 交织）；
		// 独立 'tool' 角色消息返回 null 由调用方过滤。
		return adaptPersistedChatMessage(m);
	}

	// ---------- model selector wiring ----------

	private async _refreshModelSelector(): Promise<void> {
		if (!this._agentChatPanel) {
			return;
		}
		try {
			const items = await this._modelSelector.getAvailableModels();

			// Provider list — unique by id, preserving order
			const seenProviders = new Set<string>();
			const providers: IPanelProviderInfo[] = [];
			for (const it of items) {
				if (!seenProviders.has(it.provider.id)) {
					seenProviders.add(it.provider.id);
					providers.push({ id: it.provider.id, label: it.provider.name });
				}
			}

			// Model list — unique by `${providerId}:${modelId}`
			const seenModels = new Set<string>();
			const models: IPanelModelInfo[] = [];
			for (const it of items) {
				const key = `${it.provider.id}:${it.model.id}`;
				if (!seenModels.has(key)) {
					seenModels.add(key);
					models.push({
						id: it.model.id,
						label: it.model.name,
						provider: it.provider.id,
						maxInputTokens: it.model.maxAllowedSize ?? it.model.contextWindow ?? it.model.maxInputTokens,
					});
				}
			}

			this._agentChatPanel.setProviders(providers);
			this._agentChatPanel.setModels(models);

			const selection = this._modelSelector.getSelection();
			if (selection) {
				this._agentChatPanel.setCurrentProvider(selection.providerId);
				this._agentChatPanel.setCurrentModel(selection.modelId);

				const matched = items.find(
					it => it.provider.id === selection.providerId && it.model.id === selection.modelId,
				);
				this._currentMaxContextTokens = matched?.model.maxAllowedSize
					?? matched?.model.contextWindow
					?? matched?.model.maxInputTokens
					?? undefined;
			} else {
				this._currentMaxContextTokens = undefined;
			}
		} catch {
			// ignore
		}
	}

	// ---------- checkpoint wiring ----------

	private async _refreshCheckpointBar(): Promise<void> {
		if (!this._currentAgentId || !this._currentSessionId || !this._agentChatPanel) {
			this._agentChatPanel?.setCheckpoint(null);
			return;
		}
		try {
			const list = await this._checkpointService.listCheckpoints(this._currentAgentId, this._currentSessionId);
			const live = list.filter(cp => !cp.isGhost);
			if (live.length === 0) {
				this._agentChatPanel.setCheckpoint(null);
				return;
			}
			// Aggregate file changes across all live checkpoints (de-dup by path, last wins)
			const byPath = new Map<string, { path: string; status: 'modified' | 'created' | 'deleted' }>();
			for (const cp of live) {
				if (!cp.files) {
					continue;
				}
				for (const f of cp.files) {
					const status: 'modified' | 'created' | 'deleted' =
						(f as any).status === 'created' ? 'created'
							: (f as any).status === 'deleted' ? 'deleted'
								: 'modified';
					byPath.set((f as any).path ?? (f as any).uri ?? '', {
						path: (f as any).path ?? (f as any).uri ?? '',
						status,
					});
				}
			}
			const files = Array.from(byPath.values()).filter(f => !!f.path);
			const latest = live[live.length - 1];
			const info: ICheckpointInfo = {
				id: latest.id,
				label: latest.label || (latest.type === 'tool_edit' ? '工具修改' : '用户检查点'),
				timestamp: latest.createdAt,
				fileCount: files.length || latest.fileSnapshotIds.length,
				files,
			};
			this._agentChatPanel.setCheckpoint(info);
		} catch {
			this._agentChatPanel.setCheckpoint(null);
		}
	}

	private async _handleCheckpointAction(
		action: 'undoAll' | 'keepAll' | 'openDiff',
		payload?: { filePath?: string },
	): Promise<void> {
		if (!this._currentAgentId || !this._currentSessionId) {
			return;
		}
		const agentId = this._currentAgentId;
		const sessionId = this._currentSessionId;
		try {
			if (action === 'undoAll') {
				await this._checkpointService.revertAllCheckpoints(agentId, sessionId);
				await this._checkpointService.deleteAllCheckpoints(agentId, sessionId);
				this._agentChatPanel?.setCheckpoint(null);
				return;
			}
			if (action === 'keepAll') {
				await this._checkpointService.deleteAllCheckpoints(agentId, sessionId);
				this._agentChatPanel?.setCheckpoint(null);
				return;
			}
			if (action === 'openDiff') {
				// Delegate to the "open all changes" command if available; otherwise no-op.
				try {
					await this._commandService.executeCommand(
						'agentStudio.openCheckpointDiff',
						{ agentId, sessionId, filePath: payload?.filePath },
					);
				} catch { /* command not registered — silently ignore */ }
			}
		} catch {
			// ignore
		}
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());

		// Store background and border as CSS variables for the card styling on .part
		container.style.setProperty('--part-background', this.getColor(agentsPanelBackground) || '');
		container.style.setProperty('--part-border-color', this.getColor(agentsPanelBorder) || 'transparent');
		container.style.setProperty('--part-foreground', this.getColor(agentsPanelForeground) || '');
		container.style.backgroundColor = this.getColor(agentsPanelBackground) || '';
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.CHATBAR_PART)) {
			return;
		}

		this._lastLayout = { width, height, top, left };

		// Account for the session composite bar height when visible
		const sessionBarHeight = this._sessionCompositeBar?.visible ? ChatBarPart.SESSION_BAR_HEIGHT : 0;

		// Layout content with reduced dimensions to account for visual margins and border
		const borderTotal = ChatBarPart.BORDER_WIDTH * 2;
		const marginLeft = this.layoutService.isVisible(Parts.SIDEBAR_PART) ? 0 : ChatBarPart.MARGIN_LEFT;
		super.layout(
			width - marginLeft - ChatBarPart.MARGIN_RIGHT - borderTotal,
			height - ChatBarPart.MARGIN_TOP - ChatBarPart.MARGIN_BOTTOM - borderTotal - sessionBarHeight,
			top, left
		);

		// Restore the full grid-allocated dimensions so that Part.relayout() works correctly.
		Part.prototype.layout.call(this, width, height, top, left);
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: 'chatbar',
			pinnedViewContainersKey: ChatBarPart.pinnedViewsKey,
			placeholderViewContainersKey: ChatBarPart.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey: ChatBarPart.viewContainersWorkspaceStateKey,
			icon: false,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: () => { },
			compositeSize: 0,
			iconSize: 16,
			overflowActionSize: 30,
			colors: theme => ({
				activeBackgroundColor: theme.getColor(agentsPanelBackground),
				inactiveBackgroundColor: theme.getColor(agentsPanelBackground),
				activeBorderBottomColor: theme.getColor(PANEL_ACTIVE_TITLE_BORDER),
				activeForegroundColor: theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND),
				inactiveForegroundColor: theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND),
				badgeBackground: theme.getColor(agentsBadgeBackground),
				badgeForeground: theme.getColor(agentsBadgeForeground),
				dragAndDropBorder: theme.getColor(PANEL_DRAG_AND_DROP_BORDER)
			}),
			compact: true
		};
	}

	protected shouldShowCompositeBar(): boolean {
		return false;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	override toJSON(): object {
		return {
			type: Parts.CHATBAR_PART
		};
	}
}
