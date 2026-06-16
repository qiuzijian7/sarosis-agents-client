/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';

import { NativeChatEditorInput } from './nativeChatEditorInput.js';
import { AgentChatPanel } from '../../../browser/agentChat/agentChatPanel.js';
import { IAgentStudioService, IAgentChatService } from '../../../common/agentStudioService.js';
import { ITaskOrchestrationService } from '../../../common/agentStudioService.js';
import type { AgentStatus as AgentChatAgentStatus } from '../../../browser/agentChat/agentChatTypes.js';
import type { OrchestrationPlan } from '../../../common/agentStudioTypes.js';
import * as DOM from '../../../../base/browser/dom.js';

/**
 * EditorPane that hosts AgentChatPanel natively in the DOM.
 *
 * This replaces the WebView/iframe-based AgentStudioEditorPane for chat,
 * eliminating the overlay synchronisation issues (bottom gap on resize),
 * iframe destruction on DOM reparent, and cross-origin communication overhead.
 *
 * The pane mounts the existing AgentChatPanel (which renders the full chat UI:
 * tabs, header, messages, input area) directly inside the editor container.
 */
export class NativeChatEditorPane extends EditorPane {

	static readonly ID = NativeChatEditorInput.EditorID;

	private _container: HTMLElement | undefined;
	private _chatPanel: AgentChatPanel | undefined;
	private _isInitialized = false;
	private _defaultAgentSelected = false;
	private _currentAgentId: string | null = null;
	private _currentSessionId: string | null = null;
	private _currentChatMode: 'chat' | 'craft' = 'chat';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
		@ITaskOrchestrationService private readonly _taskOrchestrationService: ITaskOrchestrationService,
		@IAgentChatService private readonly _chatService: IAgentChatService,
	) {
		super(NativeChatEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('native-chat-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		parent.appendChild(this._container);

		this._initChatPanel();
	}

	private _initChatPanel(): void {
		if (this._isInitialized || !this._container) {
			return;
		}

		this._chatPanel = this._register(new AgentChatPanel({
			onSendMessage: async (text: string, explicitSkillIds?: string[]) => {
				// TODO: Implement full message sending logic (refer to chatBarPart.ts _handleSendMessage)
				// For now, just call sendMessage with minimal parameters
				try {
					const agentId = this._currentAgentId ?? 'claw';
					const sessionId = this._currentSessionId ?? undefined;
					await this._chatService.sendMessage(
						agentId,
						text,
						{
							chatMode: this._currentChatMode,
							agentSessionId: sessionId,
							explicitSkillIds: explicitSkillIds,
						},
						(delta) => {
							// TODO: Handle stream delta (update UI)
							console.log('[NativeChatEditorPane] delta:', delta?.type);
						},
					);
				} catch (err) {
					console.error('[NativeChatEditorPane] sendMessage failed:', err);
				}
			},
			onCancelExecution: () => {
				// TODO: Use this._currentAgentId and this._currentSessionId when available
				try {
					const agentId = this._currentAgentId ?? 'claw';
					const sessionId = this._currentSessionId ?? undefined;
					this._chatService.cancelStream(agentId, sessionId);
				} catch (err) {
					console.error('[NativeChatEditorPane] cancelExecution failed:', err);
				}
			},
			onToggleCollapse: () => {
				document.dispatchEvent(new CustomEvent('agent-studio:toggle-right-column'));
			},
			onSelectAgent: (agentId: string) => {
				this._selectAndLoadAgent(agentId);
			},
			onChangeMode: (mode: 'chat' | 'craft') => {
				this._currentChatMode = mode;
				console.log(`[NativeChatEditorPane] onChangeMode: switched to ${mode} mode`);
				// TODO: Update UI or reconfigure chat panel if needed
			},
			onListSkills: () => [],
			onNewSession: async () => {
				// Create a new session for the current agent
				if (!this._currentAgentId) {
					console.warn('[NativeChatEditorPane] onNewSession: no agent selected');
					return;
				}
				try {
					const session = await this._chatService.createAgentSession(this._currentAgentId, `Session ${new Date().toLocaleString()}`);
					this._currentSessionId = session.id;
					console.log(`[NativeChatEditorPane] onNewSession: created session ${session.id}`);
					// TODO: Update UI to show the new session
				} catch (err) {
					console.error('[NativeChatEditorPane] onNewSession failed:', err);
				}
			},
			onOpenSession: async (sessionId: string) => {
				// Switch to the selected session
				if (!this._currentAgentId) {
					console.warn('[NativeChatEditorPane] onOpenSession: no agent selected');
					return;
				}
				try {
					this._currentSessionId = sessionId;
					console.log(`[NativeChatEditorPane] onOpenSession: switched to session ${sessionId}`);
					// TODO: Load session history and update UI
				} catch (err) {
					console.error('[NativeChatEditorPane] onOpenSession failed:', err);
				}
			},
			onRenameSession: async (sessionId: string, newName: string) => {
				if (!this._currentAgentId) {
					console.warn('[NativeChatEditorPane] onRenameSession: no agent selected');
					return;
				}
				try {
					await this._chatService.renameAgentSession(this._currentAgentId, sessionId, newName);
					console.log(`[NativeChatEditorPane] onRenameSession: renamed session ${sessionId} to "${newName}"`);
				} catch (err) {
					console.error('[NativeChatEditorPane] onRenameSession failed:', err);
				}
			},
			onDeleteSession: async (sessionId: string) => {
				if (!this._currentAgentId) {
					console.warn('[NativeChatEditorPane] onDeleteSession: no agent selected');
					return;
				}
				try {
					await this._chatService.deleteAgentSession(this._currentAgentId, sessionId);
					console.log(`[NativeChatEditorPane] onDeleteSession: deleted session ${sessionId}`);
					// If deleted session is current, switch to another session
					if (this._currentSessionId === sessionId) {
						const sessions = await this._chatService.listAgentSessions(this._currentAgentId);
						if (sessions.length > 0) {
							this._currentSessionId = sessions[0].id;
						} else {
							this._currentSessionId = null;
						}
					}
				} catch (err) {
					console.error('[NativeChatEditorPane] onDeleteSession failed:', err);
				}
			},
			// Orchestration plan callbacks
			onApprovePlan: async (planId: string) => {
				try {
					await this._taskOrchestrationService.approvePlan(planId);
				} catch (err) {
					console.error('[NativeChatEditorPane] approvePlan failed:', err);
				}
			},
			onRejectPlan: async (planId: string) => {
				try {
					await this._taskOrchestrationService.rejectPlan(planId);
				} catch (err) {
					console.error('[NativeChatEditorPane] rejectPlan failed:', err);
				}
			},
			onApproveWithoutExecute: async (planId: string) => {
				try {
					await this._taskOrchestrationService.approveWithoutExecute(planId);
				} catch (err) {
					console.error('[NativeChatEditorPane] approveWithoutExecute failed:', err);
				}
			},
			onTaskAction: async (planId: string, taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => {
				try {
					await this._taskOrchestrationService.taskAction(planId, taskId, action);
				} catch (err) {
					console.error('[NativeChatEditorPane] taskAction failed:', err);
				}
			},
			onUpdatePlan: async (planId: string, updates: Record<string, unknown>) => {
				try {
					await this._taskOrchestrationService.updatePlan(planId, updates);
				} catch (err) {
					console.error('[NativeChatEditorPane] updatePlan failed:', err);
				}
			},
			onUpdateTask: async (planId: string, taskId: string, updates: Record<string, unknown>) => {
				try {
					await this._taskOrchestrationService.updateTask(planId, taskId, updates);
				} catch (err) {
					console.error('[NativeChatEditorPane] updateTask failed:', err);
				}
			},
			onDecomposeTask: async (planId: string, taskId: string) => {
				try {
					// Get the plan to retrieve workspaceId and plannerId
					const plan = await this._taskOrchestrationService.getPlan(planId);
					if (plan) {
						await this._taskOrchestrationService.decomposeTask(planId, taskId, plan.workspaceId, plan.plannerId);
					}
				} catch (err) {
					console.error('[NativeChatEditorPane] decomposeTask failed:', err);
				}
			},
			onClosePlanDialog: (planId: string) => {
				// Just log for now, the dialog is closed in AgentChatPanel
				console.log('[NativeChatEditorPane] closePlanDialog:', planId);
			},
		}));

		this._container.appendChild(this._chatPanel.element);
		this._isInitialized = true;

		// Load available agents
		this._loadAvailableAgents();

		// Listen for agent selection from agentStudio webview/external sources
		this._register(this._agentStudioService.onDidSelectAgent(async (agentId) => {
			if (!agentId) {
				this._chatPanel?.setAgent(null);
				return;
			}
			await this._selectAndLoadAgent(agentId);
		}));

		// Listen for orchestration plan changes
		this._register(this._taskOrchestrationService.onDidChangePlan((plan: OrchestrationPlan) => {
			// When plan changes, show or update the orchestration plan dialog
			if (plan.status === 'pending_approval') {
				// Show dialog for pending approval plans
				this._chatPanel?.showOrchestrationPlanDialog(plan);
			} else if (plan.status === 'approved' || plan.status === 'executing') {
				// For approved/executing plans, show dialog if it's not already open,
				// or update the existing dialog
				this._chatPanel?.showOrchestrationPlanDialog(plan);
			} else if (plan.status === 'rejected' || plan.status === 'completed' || plan.status === 'error') {
				// For terminal states, close the dialog if it's open
				this._chatPanel?.closeOrchestrationPlanDialog();
			}
		}));

		// Listen for orchestration task changes
		this._register(this._taskOrchestrationService.onDidChangeTask(({ planId, task }) => {
			// When a task changes, we might want to refresh the current plan dialog
			// For now, we'll just log it
			console.log(`[NativeChatEditorPane] Task changed: planId=${planId}, taskId=${task.id}, status=${task.status}`);
			// TODO: refresh the current plan dialog if it's open
		}));

		console.log('[NativeChatEditorPane] Chat panel initialized');
	}

	private async _selectAndLoadAgent(agentId: string): Promise<void> {
		try {
			const emp = await this._agentStudioService.getAgent(agentId);
			if (emp && this._chatPanel) {
				this._currentAgentId = agentId;
				this._chatPanel.setAgent({
					id: emp.id,
					name: emp.name,
					role: emp.role,
					avatarUrl: emp.avatar,
					status: (emp.status ?? 'idle') as AgentChatAgentStatus,
					isPM: emp.id === 'pm' || emp.role?.toLowerCase().includes('project manager'),
					customPrompt: emp.systemPrompt,
					model: emp.model,
					provider: undefined,
				});
				// Auto-create or get active session for this agent
				try {
					const session = await this._chatService.getOrCreateActiveSession(agentId);
					this._currentSessionId = session.id;
					console.log(`[NativeChatEditorPane] Active session for agent ${agentId}: ${session.id}`);
				} catch (err) {
					console.warn('[NativeChatEditorPane] getOrCreateActiveSession failed:', err);
				}
			}
		} catch (err) {
			console.warn('[NativeChatEditorPane] _selectAndLoadAgent failed:', err);
		}
	}

	private async _loadAvailableAgents(): Promise<void> {
		try {
			const agents = await this._agentStudioService.getAgents();
			console.info(
				`[NativeChatEditorPane] _loadAvailableAgents: fetched ${agents?.length ?? 0} agents — ` +
				`ids=[${(agents ?? []).map(a => a.id).join(', ')}]`
			);
			if (this._chatPanel && agents) {
				this._chatPanel.setAvailableAgents(
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
						console.info(`[NativeChatEditorPane] _loadAvailableAgents: defaulting to agent "${target.id}" (${target.name})`);
						await this._selectAndLoadAgent(target.id);
					}
				}
			}
		} catch (err) {
			console.warn('[NativeChatEditorPane] _loadAvailableAgents failed:', err);
		}
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof NativeChatEditorInput)) {
			console.warn('[NativeChatEditorPane] setInput: not a NativeChatEditorInput, skipping');
			return;
		}

		if (token.isCancellationRequested) {
			return;
		}

		// The chat panel is already initialized in createEditor.
		// Re-entering setInput (e.g. after a group move) just needs to ensure
		// the panel element is in the container.
		if (this._chatPanel && this._container && !this._container.contains(this._chatPanel.element)) {
			this._container.appendChild(this._chatPanel.element);
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = '100%';
		}
	}

	override dispose(): void {
		this._chatPanel = undefined;
		this._isInitialized = false;
		super.dispose();
	}
}
