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
import { IAgentStudioService, IAgentChatService } from '../../common/agentStudioService.js';
import { IWorktreeService } from '../../contrib/worktree/common/worktreeService.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IModelSelectorService } from '../../contrib/agentStudio/common/modelSelector.js';
import { ICheckpointService } from '../../contrib/agentStudio/common/checkpointService.js';
import { autorun } from '../../../base/common/observable.js';
import type { AgentStatus as AgentChatAgentStatus, ChatMode, IAgentChatMessage, IAgentSessionMeta, IWorktreeItem, IProviderInfo as IPanelProviderInfo, IModelInfo as IPanelModelInfo, ICheckpointInfo, IContextUsage } from '../agentChat/agentChatTypes.js';
import { uniqueMsgId } from '../agentChat/agentChatTypes.js';

export class ChatBarPart extends AbstractPaneCompositePart { // TODO: should not be a AbstractPaneCompositePart but instead a custom Part with a CompositeBar

	static readonly activeViewSettingsKey = 'workbench.chatbar.activepanelid';
	static readonly pinnedViewsKey = 'workbench.chatbar.pinnedPanels';
	static readonly placeholderViewContainersKey = 'workbench.chatbar.placeholderPanels';
	static readonly viewContainersWorkspaceStateKey = 'workbench.chatbar.viewContainersWorkspaceState';

	override readonly minimumWidth: number = 300;
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
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
			onSendMessage: (text: string) => {
				void this._handleSendMessage(text);
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
			onSelectWorktree: (path: string) => {
				this._worktreeService.setSelectedWorktree(path ? { path } : undefined);
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
			onOpenSettings: () => {
				void this._commandService.executeCommand('workbench.action.openSettings');
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
				this._agentChatPanel.setMessages(history.map(m => this._adaptChatMessage(m)));
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
			if (this._agentChatPanel && agents) {
				this._agentChatPanel.setAvailableAgents(
					agents.map(emp => ({
						id: emp.id,
						name: emp.name,
						role: emp.role,
						avatarUrl: emp.avatar,
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
			const sessions = await (this._chatService as any).listAgentSessions?.(agentId);
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
			this._agentChatPanel.setMessages(history.map(m => this._adaptChatMessage(m)));
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
			await (this._chatService as any).renameAgentSession?.(this._currentAgentId, sessionId, newName);
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
			await (this._chatService as any).deleteAgentSession?.(this._currentAgentId, sessionId);
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

	private async _handleSendMessage(text: string): Promise<void> {
		if (!this._currentAgentId || !this._agentChatPanel) {
			return;
		}
		const trimmed = (text ?? '').trim();
		if (!trimmed) {
			return;
		}

		const panel = this._agentChatPanel;
		const agentId = this._currentAgentId;

		// Optimistically append the user message
		const userMsg: IAgentChatMessage = {
			id: uniqueMsgId(),
			role: 'user',
			content: trimmed,
			timestamp: Date.now(),
		};
		panel.addMessage(userMsg);

		// Create a streaming assistant placeholder
		const assistantId = uniqueMsgId();
		const assistantMsg: IAgentChatMessage = {
			id: assistantId,
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			isStreaming: true,
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
				},
				(delta) => {
					switch (delta.type) {
						case 'text': {
							const next = (delta.fullText !== undefined)
								? delta.fullText
								: (assistantMsg.content + (delta.content ?? ''));
							assistantMsg.content = next;
							panel.updateMessage(assistantId, { content: next, isStreaming: true });
							break;
						}
						case 'thinking': {
							const next = (delta.fullThinking !== undefined)
								? delta.fullThinking
								: ((assistantMsg.thinking ?? '') + (delta.content ?? ''));
							assistantMsg.thinking = next;
							panel.updateMessage(assistantId, { thinking: next, isThinking: true, currentStep: 'thinking' });
							break;
						}
						case 'tool_start': {
							const calls = (assistantMsg.toolCalls ?? []).slice();
							calls.push({
								id: delta.toolCallId ?? `tc-${calls.length}`,
								name: delta.toolName ?? 'tool',
								args: delta.content,
								status: 'running',
							});
							assistantMsg.toolCalls = calls;
							panel.updateMessage(assistantId, { toolCalls: calls, currentStep: 'execute_tool' });
							break;
						}
						case 'tool_end':
						case 'tool_result': {
							const calls = (assistantMsg.toolCalls ?? []).map(c =>
								c.id === delta.toolCallId
									? { ...c, status: 'completed' as const, result: delta.content ?? c.result }
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
									const used = input; // input-token consumption is what the ring shows
									const ratio = Math.max(0, Math.min(1, used / limit));
									panel.setContextUsage({
										used,
										limit,
										ratio,
										percent: ratio * 100,
									} satisfies IContextUsage);
								}
							}
							break;
						}
						case 'context_compacted': {
							const compacted = delta.compactedInputTokens ?? 0;
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
						case 'done': {
							panel.updateMessage(assistantId, { isStreaming: false, isThinking: false });
							break;
						}
						case 'error': {
							panel.updateMessage(assistantId, {
								isStreaming: false,
								isThinking: false,
								content: (assistantMsg.content || '') + `\n\n⚠ ${delta.content ?? '执行失败'}`,
							});
							break;
						}
						default:
							// Ignore other delta types in this lightweight panel
							break;
					}
				},
			);
		} catch (err) {
			panel.updateMessage(assistantId, {
				isStreaming: false,
				isThinking: false,
				content: `⚠ ${err instanceof Error ? err.message : String(err)}`,
			});
		} finally {
			panel.setSending(false);
		}
	}

	private _adaptChatMessage(m: { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; thinking?: string; toolCalls?: any[]; timestamp: string }): IAgentChatMessage {
		const role: IAgentChatMessage['role'] = m.role === 'tool' ? 'system' : m.role;
		const ts = (() => {
			const t = Date.parse(m.timestamp);
			return Number.isFinite(t) ? t : Date.now();
		})();
		return {
			id: m.id,
			role,
			content: m.content,
			timestamp: ts,
			thinking: m.thinking,
			toolCalls: Array.isArray(m.toolCalls)
				? m.toolCalls.map((c: any, i: number) => ({
					id: c.id ?? `tc-${i}`,
					name: c.name ?? 'tool',
					args: typeof c.args === 'string' ? c.args : (c.args ? JSON.stringify(c.args) : undefined),
					result: typeof c.result === 'string' ? c.result : (c.result ? JSON.stringify(c.result) : undefined),
					status: c.status === 'running' ? 'running' : 'completed',
				}))
				: undefined,
		};
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
