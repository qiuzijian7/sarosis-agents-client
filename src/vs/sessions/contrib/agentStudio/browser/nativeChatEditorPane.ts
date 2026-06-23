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
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';

import { NativeChatEditorInput } from './nativeChatEditorInput.js';
import { AgentSettingsEditorInput } from './agentSettingsEditorInput.js';
import { AgentChatPanel } from '../../../browser/agentChat/agentChatPanel.js';
import { IAgentStudioService, IAgentChatService, ChatMode } from '../../../common/agentStudioService.js';
import { ITaskOrchestrationService } from '../../../common/agentStudioService.js';
import { IModelSelectorService } from '../common/modelSelector.js';
import { ICheckpointService } from '../common/checkpointService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { AgentStatus as AgentChatAgentStatus, IProviderInfo as IPanelProviderInfo, IModelInfo as IPanelModelInfo, IAgentSessionMeta, IAgentChatMessage, ICheckpointInfo } from '../../../browser/agentChat/agentChatTypes.js';
import { adaptPersistedChatMessage } from '../../../browser/agentChat/agentChatTypes.js';
import type { ChatMessage } from '../../../common/agentStudioTypes.js';
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
	private _currentChatMode: ChatMode | undefined = undefined;
	private _currentWorkspaceId: string | null = null;
	private _isSending = false;
	private _currentMaxContextTokens: number | undefined;
	/** Reusable streaming-send function, captured from the panel's onSendMessage. */
	private _sendMessageInternal!: (text: string, explicitSkillIds?: string[]) => Promise<void>;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
		@ITaskOrchestrationService private readonly _taskOrchestrationService: ITaskOrchestrationService,
		@IAgentChatService private readonly _chatService: IAgentChatService,
		@IModelSelectorService private readonly _modelSelector: IModelSelectorService,
		@ICheckpointService private readonly _checkpointService: ICheckpointService,
		@ICommandService private readonly _commandService: ICommandService,
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
			onSendMessage: (this._sendMessageInternal = async (text: string, explicitSkillIds?: string[]) => {
				// 防重入：如果正在发送中，忽略重复调用
				if (this._isSending) {
					console.warn('[NativeChatEditorPane] onSendMessage: already sending, ignoring duplicate');
					return;
				}
				try {
					// Converge the multi-layer session id: always resolve a concrete
					// agent + session before sending so the stream never falls into the
					// "noSession bucket" (the historical cross-talk root cause).
					const ensured = await this._ensureSession();
					if (!ensured) {
						console.warn('[NativeChatEditorPane] onSendMessage: no usable agent/session');
						return;
					}
					const agentId = ensured.agentId;
					const sessionId: string = ensured.sessionId;

					// Optimistically add user message
					const userMsg: IAgentChatMessage = {
						id: `msg_${Date.now()}_user`,
						role: 'user',
						content: text,
						timestamp: Date.now(),
					};
					this._chatPanel?.addMessage(userMsg);

					// Set sending state BEFORE await — switches send button to stop icon immediately
					this._chatPanel?.setSending(true);
					this._isSending = true;

					// Assistant message — created lazily on first meaningful delta (text/thinking/tool_start).
					// This avoids showing an empty placeholder bubble with "AI 正在输出..." text.
					let assistantId: string | null = null;
					let assistantMsg: IAgentChatMessage | null = null;
					let assistantAdded = false;

					const ensureAssistantMsg = () => {
						if (assistantAdded) { return; }
						assistantId = `msg_${Date.now()}_assistant`;
						const turnId = `turn_${Date.now()}`;
						assistantMsg = {
							id: assistantId,
							role: 'assistant',
							content: '',
							timestamp: Date.now(),
							isStreaming: true,
							streamPhase: 'llm_streaming',
							turnId,
						};
						this._chatPanel?.addMessage(assistantMsg);
						assistantAdded = true;
					};
					
					await this._chatService.sendMessage(
						agentId,
						text,
						{
							chatMode: this._currentChatMode,
							agentSessionId: sessionId,
							explicitSkillIds: explicitSkillIds,
						},
						(delta) => {
							if (!delta) return;
							
							switch (delta.type) {
								case 'text':
									// First text delta → ensure assistant message exists, then update
									ensureAssistantMsg();
									if (!assistantMsg || !assistantId) return;
									const textContent = delta.fullText !== undefined ? delta.fullText : (assistantMsg.content + (delta.content ?? ''));
									assistantMsg.content = textContent;
									this._chatPanel?.setStreamPhase('llm_streaming');
									this._chatPanel?.setStreamTextBuffer(textContent);
									this._chatPanel?.updateMessage(assistantId, {
										content: textContent,
										isStreaming: true,
										streamPhase: 'llm_streaming',
									});
									break;
								case 'thinking':
									ensureAssistantMsg();
									if (!assistantMsg || !assistantId) return;
									const thinkingContent = delta.fullThinking !== undefined ? delta.fullThinking : ((assistantMsg.thinking ?? '') + (delta.content ?? ''));
									assistantMsg.thinking = thinkingContent;
									this._chatPanel?.setStreamThinkingBuffer(thinkingContent);
									this._chatPanel?.updateMessage(assistantId, {
										thinking: thinkingContent,
										isThinking: true,
									});
									break;
								case 'tool_start': {
									// First tool delta → ensure assistant message exists
									ensureAssistantMsg();
									if (!assistantMsg || !assistantId) return;
									if (!assistantMsg.toolCalls) { assistantMsg.toolCalls = []; }
									assistantMsg.toolCalls.push({
										id: delta.toolCallId ?? `tool_${Date.now()}`,
										name: delta.toolName ?? '',
										args: '',
										status: 'running',
										displayName: delta.displayName,
										renderType: delta.renderType,
										defaultShow: delta.defaultShow,
										textPosition: typeof delta.textPosition === 'number' ? delta.textPosition : (assistantMsg.content?.length ?? 0),
									});
									this._chatPanel?.setStreamPhase('tool_executing');
									this._chatPanel?.updateMessage(assistantId, {
										toolCalls: assistantMsg.toolCalls.slice(),
										isStreaming: true,
										streamPhase: 'tool_executing',
									});
									break;
								}
								case 'tool_args': {
									if (!assistantMsg || !assistantId) return;
									const argCall = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === delta.toolCallId);
									if (argCall) {
										argCall.args = (argCall.args ?? '') + (delta.content ?? '');
										this._chatPanel?.updateMessage(assistantId, {
											toolCalls: assistantMsg.toolCalls!.slice(),
											isStreaming: true,
											streamPhase: 'tool_executing',
										});
									}
									break;
								}
								case 'tool_end': {
									if (!assistantMsg || !assistantId) return;
									const endCall = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === delta.toolCallId);
									if (endCall) {
										endCall.status = 'completed';
										this._chatPanel?.updateMessage(assistantId, {
											toolCalls: assistantMsg.toolCalls!.slice(),
											isStreaming: true,
											streamPhase: 'llm_streaming',
										});
									}
									break;
								}
								case 'tool_result': {
									if (!assistantMsg || !assistantId) return;
									const resultCall = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === delta.toolCallId);
									if (resultCall) {
										resultCall.result = delta.content;
										if (resultCall.status === 'running') { resultCall.status = 'completed'; }
										this._chatPanel?.updateMessage(assistantId, {
											toolCalls: assistantMsg.toolCalls!.slice(),
										});
									}
									break;
								}
								case 'phase_change':
									// Phase changes can arrive before any content — don't create msg for them
									if (delta.phase) {
										this._chatPanel?.setStreamPhase(delta.phase);
									}
									if (delta.phase && assistantId) {
										this._chatPanel?.updateMessage(assistantId, {
											streamPhase: delta.phase,
											isStreaming: delta.phase !== 'idle',
										});
									}
									break;
								case 'done': {
									// Edge case: if no content ever arrived, ensure msg exists for done-state
									if (!assistantAdded && assistantId === null) {
										ensureAssistantMsg();
									}
									if (assistantMsg && assistantId) {
										if (assistantMsg.toolCalls) {
											for (const tc of assistantMsg.toolCalls) {
												if (tc.status === 'running') { tc.status = 'completed'; }
											}
										}
										this._chatPanel?.setStreamPhase('idle');
										this._chatPanel?.updateMessage(assistantId, {
											toolCalls: assistantMsg.toolCalls ? assistantMsg.toolCalls.slice() : undefined,
											isStreaming: false,
											isThinking: false,
											streamPhase: 'idle',
										});
									}
									this._chatPanel?.setSending(false);
									this._isSending = false;
									break;
								}
								case 'error':
									// Ensure assistant msg exists to show error state
									if (!assistantAdded && assistantId === null) {
										ensureAssistantMsg();
									}
									if (assistantId) {
										this._chatPanel?.setStreamPhase('error');
										this._chatPanel?.updateMessage(assistantId, {
											isStreaming: false,
											isThinking: false,
											streamPhase: 'error',
											content: ((assistantMsg?.content) || '') + `\n\n⚠️ ${typeof delta.content === 'string' ? delta.content : '执行失败'}`,
										});
									}
									this._chatPanel?.setSending(false);
									this._isSending = false;
									break;
								case 'usage':
									if (delta.usage && assistantMsg && assistantId) {
										const input = delta.usage.inputTokens ?? 0;
										const output = delta.usage.outputTokens ?? 0;
										const total = input + output;
										assistantMsg.tokenUsage = { input, output, total };
										this._chatPanel?.updateMessage(assistantId, {
											tokenUsage: { input, output, total },
										});
										// 更新上下文环进度条
										const limit = this._currentMaxContextTokens ?? 0;
										if (limit > 0) {
											this._chatPanel?.setStreamUsage({
												input: delta.usage.inputTokens ?? 0,
												output: delta.usage.outputTokens ?? 0,
												seen: true,
											});
										}
									}
									break;
								default:
									break;
							}
						},
					);
				} catch (err) {
					console.error('[NativeChatEditorPane] sendMessage failed:', err);
					this._chatPanel?.setSending(false);
					this._isSending = false;
				}
			}),
			onEditMessage: (messageId: string, newText: string) => {
				void this._handleEditMessage(messageId, newText);
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
			onChangeMode: (mode: ChatMode) => {
				this._currentChatMode = mode;
				console.log(`[NativeChatEditorPane] onChangeMode: switched to ${mode} mode`);
				// TODO: Update UI or reconfigure chat panel if needed
			},
		onOpenSettings: async () => {
			// Open agent settings page (refer to AgentChat.tsx settings button)
			if (!this._currentAgentId) {
				console.warn('[NativeChatEditorPane] onOpenSettings: no agent selected');
				return;
			}
			try {
				const agent = await this._agentStudioService.getAgent(this._currentAgentId);
				if (!agent) {
					console.warn(`[NativeChatEditorPane] onOpenSettings: agent ${this._currentAgentId} not found`);
					return;
				}
				const input = new AgentSettingsEditorInput(agent.id, agent.name);
				await this.group.openEditor(input, { pinned: true });
			} catch (err) {
				console.error('[NativeChatEditorPane] onOpenSettings failed:', err);
			}
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
				// Clear messages in UI
				this._chatPanel?.setMessages([]);
				// New session has no checkpoints yet — reset bar & scope checkpoints to it.
				this._activateCheckpointSession(this._currentAgentId, session.id);
				// Refresh session list
				await this._refreshSessionList();
			} catch (err) {
				console.error('[NativeChatEditorPane] onNewSession failed:', err);
			}
		},
			onOpenSession: async (sessionId: string) => {
				// Switch to the selected session and reload its history
				if (!this._currentAgentId) {
					console.warn('[NativeChatEditorPane] onOpenSession: no agent selected');
					return;
				}
				const agentId = this._currentAgentId;
				try {
					this._currentSessionId = sessionId;
					const history = await this._chatService.getHistory(agentId, sessionId);
					this._chatPanel?.setMessages(this._adaptHistoryMessages(history));
					// Scope checkpoints to the newly opened session & refresh the bar.
					this._activateCheckpointSession(agentId, sessionId);
				} catch (err) {
					console.error('[NativeChatEditorPane] onOpenSession failed:', err);
					this._chatPanel?.setMessages([]);
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
				const agentId = this._currentAgentId;
				try {
					await this._chatService.deleteAgentSession(agentId, sessionId);
					console.log(`[NativeChatEditorPane] onDeleteSession: deleted session ${sessionId}`);
					// If the deleted session is the current one, switch to the most recent
					// remaining session (or clear the view) and reload history + checkpoints.
					if (this._currentSessionId === sessionId) {
						const sessions = await this._chatService.listAgentSessions(agentId);
						if (sessions.length > 0) {
							this._currentSessionId = sessions[0].id;
							try {
								const history = await this._chatService.getHistory(agentId, this._currentSessionId);
								this._chatPanel?.setMessages(this._adaptHistoryMessages(history));
							} catch {
								this._chatPanel?.setMessages([]);
							}
							this._activateCheckpointSession(agentId, this._currentSessionId);
						} else {
							this._currentSessionId = null;
							this._chatPanel?.setMessages([]);
							this._chatPanel?.setCheckpoint(null);
						}
					}
					await this._refreshSessionList();
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
			onSelectWorktree: async (worktree: { path: string; branch: string }) => {
				const workspaceId = this._agentStudioService.getActiveWorkspaceId() || this._currentWorkspaceId || undefined;
				if (!workspaceId || !this._currentAgentId) {
					console.warn('[NativeChatEditorPane] onSelectWorktree: missing workspaceId or agentId');
					return;
				}
				try {
					await this._agentStudioService.upsertAgentBinding(workspaceId, this._currentAgentId, {
						worktreePath: worktree.path,
						worktreeBranch: worktree.branch,
					});
					// Update local state
					this._currentWorkspaceId = workspaceId;
					this._chatPanel?.setSelectedWorktree(worktree.path);
					console.log(`[NativeChatEditorPane] onSelectWorktree: switched to worktree ${worktree.path}`);
				} catch (err) {
					console.error('[NativeChatEditorPane] onSelectWorktree failed:', err);
				}
			},
			// 参考 React WorktreeSwitcher 逻辑：下拉框打开时主动加载 worktree 列表
			onLoadWorktrees: async () => {
				return await this._getWorktrees();
			},
			// 参考 React WorktreeSwitcher 逻辑：清除 worktree 选择（切换到"主仓库"）
			onClearWorktree: async () => {
				const workspaceId = this._agentStudioService.getActiveWorkspaceId() || this._currentWorkspaceId || undefined;
				if (!workspaceId || !this._currentAgentId) {
					console.warn('[NativeChatEditorPane] onClearWorktree: missing workspaceId or agentId');
					return;
				}
				try {
					await this._agentStudioService.upsertAgentBinding(workspaceId, this._currentAgentId, {
						worktreePath: undefined,
						worktreeBranch: undefined,
					});
					// Update local state
					this._chatPanel?.setSelectedWorktree('');
					console.log(`[NativeChatEditorPane] onClearWorktree: switched to main repo`);
				} catch (err) {
					console.error('[NativeChatEditorPane] onClearWorktree failed:', err);
				}
			},
			onScrollToMessage: (messageId: string) => {
				console.log('[NativeChatEditorPane] onScrollToMessage:', messageId);
				// TODO: Implement scroll to message logic
			},
			onSelectProvider: (providerId: string) => {
				const cur = this._modelSelector.getSelection();
				this._modelSelector.setSelection({
					providerId,
					modelId: cur?.modelId ?? '',
					agentId: cur?.agentId,
				});
				void this._refreshModelSelector();
			},
			onSelectModel: (modelId: string) => {
				const cur = this._modelSelector.getSelection();
				if (!cur) { return; }
				this._modelSelector.setSelection({
					providerId: cur.providerId,
					modelId,
					agentId: cur.agentId,
				});
				void this._refreshModelSelector();
			},
			onCheckpointAction: (action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string }) => {
				void this._handleCheckpointAction(action, payload);
			},
			onConfirmationAction: (confirmationId: string, buttonId: string) => {
				console.log('[NativeChatEditorPane] onConfirmationAction:', confirmationId, buttonId);
				// TODO: Implement confirmation action logic
			},
			onAskUserSubmit: (askUserId: string, executionId: string, nodeId: string, selection: string | string[]) => {
				console.log('[NativeChatEditorPane] onAskUserSubmit:', askUserId, executionId, nodeId, selection);
				// TODO: Implement ask user submit logic
			},
			onQuestionClick: (question: any) => {
				console.log('[NativeChatEditorPane] onQuestionClick:', question);
				// TODO: Implement question click logic
			},
			onReferenceClick: (ref: any) => {
				console.log('[NativeChatEditorPane] onReferenceClick:', ref);
				// TODO: Implement reference click logic
			},
			onTipAction: (tipId: string, actionId: string) => {
				console.log('[NativeChatEditorPane] onTipAction:', tipId, actionId);
				// TODO: Implement tip action logic
			},
			onTipDismiss: (tipId: string) => {
				console.log('[NativeChatEditorPane] onTipDismiss:', tipId);
				// TODO: Implement tip dismiss logic
			},
			onApplyCode: (code: string, language: string, filePath?: string) => {
				console.log('[NativeChatEditorPane] onApplyCode:', language, filePath);
				// TODO: Implement apply code logic (refer to chatBarPart.ts)
			},
			onOpenFile: (filePath: string) => {
				console.log('[NativeChatEditorPane] onOpenFile:', filePath);
				// TODO: Implement open file logic (refer to chatBarPart.ts)
			},
		}));

		this._container.appendChild(this._chatPanel.element);
		this._isInitialized = true;

		// Load available agents
		this._loadAvailableAgents();

		// Model selector wiring — initialize provider/model data for toolbar
		void this._refreshModelSelector();
		this._register(this._modelSelector.onDidChangeSelection(() => {
			void this._refreshModelSelector();
		}));
		this._register(this._modelSelector.onDidChangeAvailableModels(() => {
			void this._refreshModelSelector();
		}));

		// Listen for agent selection from agentStudio webview/external sources
		this._register(this._agentStudioService.onDidSelectAgent(async (agentId) => {
			if (!agentId) {
				this._chatPanel?.setAgent(null);
				return;
			}
			// Don't reload agent (which calls setMessages and wipes streaming state)
			// while a message is being sent/streaming.
			if (this._isSending) {
				console.info('[NativeChatEditorPane] onDidSelectAgent: ignored — currently streaming');
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

		// Listen for worktree changes (agent binding or list changes)
		this._register(addDisposableListener(mainWindow, 'agentStudio:agent-worktree-changed', (e: Event) => {
			const detail = (e as CustomEvent).detail as { workspaceId?: string; agentId?: string; worktreePath?: string; worktreeBranch?: string };
			if (detail?.workspaceId && detail.workspaceId !== this._currentWorkspaceId) { return; }
			if (detail?.agentId && detail.agentId !== this._currentAgentId) { return; }
			// Update selected worktree
			if (detail?.worktreePath) {
				this._chatPanel?.setSelectedWorktree(detail.worktreePath);
			}
		}));
		this._register(addDisposableListener(mainWindow, 'agentStudio:worktree-changed', (_e: Event) => {
			// Reload worktree list
			void this._loadWorktrees();
		}));

		// Checkpoint wiring — refresh the bar whenever a checkpoint is created for the active session.
		this._register(this._checkpointService.onDidCreateCheckpoint((cp) => {
			if (cp.agentId === this._currentAgentId && cp.sessionId === this._currentSessionId) {
				void this._refreshCheckpointBar();
			}
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
					icon: emp.icon,
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
					
					// Load history messages for this session
					try {
						const history = await this._chatService.getHistory(agentId, this._currentSessionId);
						this._chatPanel.setMessages(this._adaptHistoryMessages(history));
					} catch (err) {
						console.warn('[NativeChatEditorPane] Failed to load history:', err);
						this._chatPanel.setMessages([]);
					}
					// Register active session for checkpoint scoping & refresh checkpoint bar
					this._activateCheckpointSession(agentId, this._currentSessionId);
				} catch (err) {
					console.warn('[NativeChatEditorPane] getOrCreateActiveSession failed:', err);
				}
				// Load worktrees for the selected agent
				await this._loadWorktrees();
			}
		} catch (err) {
			console.warn('[NativeChatEditorPane] _selectAndLoadAgent failed:', err);
		}
	}

	/**
	 * 将服务端持久化的 ChatMessage[] 适配为面板使用的 IAgentChatMessage[]。
	 * 阶段E：复用共享 adaptPersistedChatMessage —— assistant 消息携带有序 parts
	 * （取代 textPosition 交织），独立 'tool' 角色消息被过滤。与 ChatBarPart 完全对齐。
	 */
	private _adaptHistoryMessages(history: ChatMessage[]): IAgentChatMessage[] {
		return (history ?? [])
			.map(m => adaptPersistedChatMessage(m))
			.filter((m): m is IAgentChatMessage => !!m);
	}

	// ---------- checkpoint wiring (aligned with ChatBarPart) ----------

	/**
	 * Ensures a concrete agent id + session id is available before a send.
	 *
	 * Session id convergence: the various layers (`_currentSessionId`,
	 * `AgentSessionMeta.id`, checkpoint session, provider session) all refer to
	 * the same logical agent session. If the UI never resolved one (e.g. agent
	 * load failed), we lazily create/resolve it via `getOrCreateActiveSession`
	 * so the stream is never persisted into the agent-only "noSession bucket",
	 * which historically caused history cross-talk between sessions.
	 */
	private async _ensureSession(): Promise<{ agentId: string; sessionId: string } | null> {
		const agentId = this._currentAgentId ?? 'claw';
		let sessionId = this._currentSessionId ?? undefined;
		if (!sessionId) {
			try {
				const session = await this._chatService.getOrCreateActiveSession(agentId);
				sessionId = session.id;
				this._currentSessionId = sessionId;
				this._activateCheckpointSession(agentId, sessionId);
			} catch (err) {
				console.error('[NativeChatEditorPane] _ensureSession failed:', err);
				return null;
			}
		}
		return { agentId, sessionId };
	}

	/**
	 * Handles an inline user-message edit (edit → truncate → regenerate).
	 *
	 * The panel has already removed the edited message and everything after it
	 * from the in-memory view. Here we truncate the persisted history to drop
	 * the edited user message (and everything after), then re-send the new text
	 * through the normal streaming flow.
	 */
	private async _handleEditMessage(messageId: string, newText: string): Promise<void> {
		if (!this._currentAgentId) {
			return;
		}
		const agentId = this._currentAgentId;
		const sessionId = this._currentSessionId ?? undefined;
		try {
			const history = await this._chatService.getHistory(agentId, sessionId);
			const idx = history.findIndex(m => m.id === messageId);
			if (idx <= 0) {
				await this._chatService.clearHistory(agentId, sessionId);
			} else {
				await this._chatService.deleteMessagesAfter(agentId, sessionId, history[idx - 1].id);
			}
		} catch (err) {
			console.error('[NativeChatEditorPane] _handleEditMessage: truncate failed:', err);
			return;
		}
		await this._sendMessageInternal(newText);
	}

	/** Register the active checkpoint session and refresh the checkpoint bar. */
	private _activateCheckpointSession(agentId: string, sessionId: string | null | undefined): void {
		if (!sessionId) {
			this._chatPanel?.setCheckpoint(null);
			return;
		}
		try {
			this._checkpointService.setActiveSession(agentId, sessionId);
		} catch { /* ignore */ }
		void this._refreshCheckpointBar();
	}

	private async _refreshCheckpointBar(): Promise<void> {
		if (!this._currentAgentId || !this._currentSessionId || !this._chatPanel) {
			this._chatPanel?.setCheckpoint(null);
			return;
		}
		try {
			const list = await this._checkpointService.listCheckpoints(this._currentAgentId, this._currentSessionId);
			const live = list.filter(cp => !cp.isGhost);
			if (live.length === 0) {
				this._chatPanel.setCheckpoint(null);
				return;
			}
			// Aggregate file changes across all live checkpoints (de-dup by path, last wins)
			const byPath = new Map<string, { path: string; status: 'modified' | 'created' | 'deleted' }>();
			for (const cp of live) {
				if (!cp.files) { continue; }
				for (const f of cp.files) {
					const status: 'modified' | 'created' | 'deleted' =
						(f as any).status === 'created' ? 'created'
							: (f as any).status === 'deleted' ? 'deleted'
								: 'modified';
					const path = (f as any).path ?? (f as any).uri ?? '';
					byPath.set(path, { path, status });
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
			this._chatPanel.setCheckpoint(info);
		} catch {
			this._chatPanel.setCheckpoint(null);
		}
	}

	private async _handleCheckpointAction(action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string }): Promise<void> {
		if (!this._currentAgentId || !this._currentSessionId) {
			return;
		}
		const agentId = this._currentAgentId;
		const sessionId = this._currentSessionId;
		try {
			if (action === 'undoAll') {
				await this._checkpointService.revertAllCheckpoints(agentId, sessionId);
				await this._checkpointService.deleteAllCheckpoints(agentId, sessionId);
				this._chatPanel?.setCheckpoint(null);
				return;
			}
			if (action === 'keepAll') {
				await this._checkpointService.deleteAllCheckpoints(agentId, sessionId);
				this._chatPanel?.setCheckpoint(null);
				return;
			}
			if (action === 'openDiff') {
				try {
					await this._commandService.executeCommand(
						'agentStudio.openCheckpointDiff',
						{ agentId, sessionId, filePath: payload?.filePath },
					);
				} catch { /* command not registered — silently ignore */ }
			}
		} catch (err) {
			console.warn('[NativeChatEditorPane] _handleCheckpointAction failed:', err);
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
						console.info(`[NativeChatEditorPane] _loadAvailableAgents: defaulting to agent "${target.id}" (${target.name})`);
						await this._selectAndLoadAgent(target.id);
					}
				}
			}
		} catch (err) {
			console.warn('[NativeChatEditorPane] _loadAvailableAgents failed:', err);
		}
	}

	// ---------- model selector wiring (mirrors chatBarPart.ts) ----------

	private async _refreshModelSelector(): Promise<void> {
		if (!this._chatPanel) {
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
					providers.push({ 
						id: it.provider.id, 
						label: it.provider.name,
						supportsAgents: it.provider.supportsAgents 
					});
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

			this._chatPanel.setProviders(providers);
			this._chatPanel.setModels(models);

			const selection = this._modelSelector.getSelection();
			if (selection) {
				this._chatPanel.setCurrentProvider(selection.providerId);
				this._chatPanel.setCurrentModel(selection.modelId);

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
		} catch (err) {
			console.warn('[NativeChatEditorPane] _refreshModelSelector failed:', err);
		}
	}

	// ---------- session list logic ----------

	private async _refreshSessionList(): Promise<void> {
		if (!this._currentAgentId || !this._chatPanel) {
			return;
		}
		try {
			const sessions = await this._chatService.listAgentSessions(this._currentAgentId);
			if (Array.isArray(sessions)) {
				const metas: IAgentSessionMeta[] = sessions.map((s: any) => ({
					id: s.id,
					name: s.name ?? '未命名会话',
					createdAt: s.createdAt ?? new Date().toISOString(),
					updatedAt: s.updatedAt ?? s.createdAt ?? new Date().toISOString(),
					messageCount: s.messageCount ?? 0,
				}));
				this._chatPanel.setAgentSessions(metas);
			} else {
				this._chatPanel.setAgentSessions([]);
			}
		} catch {
			this._chatPanel.setAgentSessions([]);
		}
	}

	// ---------- worktree logic (mirrors React AgentChat.tsx) ----------

	private async _loadWorktrees(): Promise<void> {
		if (!this._chatPanel) {
			return;
		}
		try {
			const workspaceId = this._agentStudioService.getActiveWorkspaceId() || this._currentWorkspaceId || undefined;
			if (!workspaceId) {
				console.warn('[NativeChatEditorPane] _loadWorktrees: no workspaceId');
				this._chatPanel.setWorktrees([]);
				this._chatPanel.setSelectedWorktree('');
				return;
			}
			this._currentWorkspaceId = workspaceId;
			const worktrees = await this._agentStudioService.getWorktrees(workspaceId);
			// Adapt to IWorktreeItem format (include change counts for VS Code compatibility)
			const items = worktrees.map(wt => ({
				path: wt.path,
				branch: wt.branch,
				outgoingChanges: wt.outgoingChanges,
				incomingChanges: wt.incomingChanges,
				uncommittedChanges: wt.uncommittedChanges,
			}));
			this._chatPanel.setWorktrees(items);
			// Set selected worktree from agent binding
			if (this._currentAgentId) {
				try {
					const binding = await this._agentStudioService.getAgentBinding(workspaceId, this._currentAgentId);
					if (binding?.worktreePath) {
						this._chatPanel.setSelectedWorktree(binding.worktreePath);
					}
				} catch {
					// ignore
				}
			}
			console.log(`[NativeChatEditorPane] _loadWorktrees: loaded ${items.length} worktrees for workspace ${workspaceId}`);
		} catch (err) {
			console.warn('[NativeChatEditorPane] _loadWorktrees failed:', err);
			this._chatPanel.setWorktrees([]);
		}
	}

	/** 获取 worktree 列表（供 AgentChatPanel 的 onLoadWorktrees 回调使用） */
	private async _getWorktrees(): Promise<ReadonlyArray<{ path: string; branch: string; outgoingChanges?: number; incomingChanges?: number; uncommittedChanges?: number }>> {
		const workspaceId = this._agentStudioService.getActiveWorkspaceId() || this._currentWorkspaceId || undefined;
		if (!workspaceId) {
			console.warn('[NativeChatEditorPane] _getWorktrees: no workspaceId');
			return [];
		}
		try {
			const worktrees = await this._agentStudioService.getWorktrees(workspaceId);
			return worktrees.map(wt => ({
				path: wt.path,
				branch: wt.branch,
				outgoingChanges: wt.outgoingChanges,
				incomingChanges: wt.incomingChanges,
				uncommittedChanges: wt.uncommittedChanges,
			}));
		} catch (err) {
			console.warn('[NativeChatEditorPane] _getWorktrees failed:', err);
			return [];
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
