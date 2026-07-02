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
import { IEditorGroup, IEditorGroupsService, GroupsOrder } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMcpService } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { ISkillRegistry } from '../common/skills.js';
import { SIDE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';

import { NativeChatEditorInput } from './nativeChatEditorInput.js';
import { CompressionDetailEditorInput } from './compressionDetailEditorInput.js';
import { MemoryDetailEditorInput } from './memoryDetailEditorInput.js';
import { MemoryDetailEditorPane } from './memoryDetailEditorPane.js';
import { CodebaseMemoryDetailEditorInput } from './codebaseMemoryDetailEditorInput.js';
import { AgentSettingsEditorInput } from './agentSettingsEditorInput.js';
import { HtmlPreviewEditorInput } from './htmlPreviewEditorInput.js';
import { AgentChatPanel } from '../../../browser/agentChat/agentChatPanel.js';
import { IAgentStudioService, IAgentChatService, ChatMode } from '../../../common/agentStudioService.js';
import { ITaskOrchestrationService } from '../../../common/agentStudioService.js';
import { IModelSelectorService } from '../common/modelSelector.js';
import { ICheckpointService } from '../common/checkpointService.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { UrlPreviewEditorInput } from './urlPreviewEditorInput.js';
import type { AgentStatus as AgentChatAgentStatus, IProviderInfo as IPanelProviderInfo, IModelInfo as IPanelModelInfo, IAgentSessionMeta, IAgentChatMessage, ICheckpointInfo, ILiveWorkflowAskUser, IContextUsage, IChatAttachment } from '../../../browser/agentChat/agentChatTypes.js';
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
	private _sendMessageInternal!: (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[]) => Promise<void>;
	/** Live workflow execution state for trace rendering in Native Chat. */
	private _liveWorkflowExecId: string | null = null;
	private _liveWorkflowMsgId: string | null = null;
	private _liveWorkflowSubAgents: any[] = [];
	private _liveWorkflowEvents: any[] = [];
	private _liveWorkflowCollectVars: Record<string, any> = {};
	private _liveWorkflowAskUsers: ILiveWorkflowAskUser[] = [];
	private _liveWorkflowReady = false;
	/** Throttle timer for delta-driven UI refreshes. During streaming, hundreds of
	 *  delta events fire in rapid succession; without throttling each one triggers
	 *  a full DOM rebuild via updateMessage(), overwhelming the UI thread. */
	private _deltaRefreshTimer: ReturnType<typeof setTimeout> | null = null;

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
		@IWorkflowExecutionService private readonly _workflowExecutionService: IWorkflowExecutionService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
		@IMcpService private readonly _mcpService: IMcpService,
		@ISkillRegistry private readonly _skillRegistry: ISkillRegistry,
	) {
		super(NativeChatEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const t0 = performance.now();
		this._logService.debug(`[NativeChatEditorPane][Init] createEditor START t=${t0.toFixed(0)}ms`);
		this._container = document.createElement('div');
		this._container.classList.add('native-chat-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		parent.appendChild(this._container);

		this._initChatPanel();
		this._logService.debug(`[NativeChatEditorPane][Init] createEditor END t=${(performance.now() - t0).toFixed(1)}ms`);
	}

	private _initChatPanel(): void {
		if (this._isInitialized || !this._container) {
			return;
		}
		const t0 = performance.now();
		this._logService.debug(`[NativeChatEditorPane][Init] _initChatPanel START`);

		this._chatPanel = this._register(new AgentChatPanel({
			onSendMessage: (this._sendMessageInternal = async (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[]) => {
				// 防重入：如果正在发送中，忽略重复调用
				if (this._isSending) {
					this._logService.info('[NativeChatEditorPane] onSendMessage: already sending, ignoring duplicate');
					return;
				}
				try {
					// Converge the multi-layer session id: always resolve a concrete
					// agent + session before sending so the stream never falls into the
					// "noSession bucket" (the historical cross-talk root cause).
					const ensured = await this._ensureSession();
					if (!ensured) {
						this._logService.info('[NativeChatEditorPane] onSendMessage: no usable agent/session');
						return;
					}
					const agentId = ensured.agentId;
					const sessionId: string = ensured.sessionId;

					// 将附件内容注入消息文本——文件附件以 <file> 标签包裹，
					// 图片附件标注文件名（视觉能力取决于模型支持）
					let fullText = text;
					if (attachments && attachments.length > 0) {
						for (const att of attachments) {
							if (att.type === 'file') {
								// 文本文件 data 为原文，二进制文件 data 为 base64
								const isText = att.mimeType.startsWith('text/') || att.mimeType === 'application/json';
								const content = isText ? att.data : `[binary file, ${att.size} bytes]`;
								fullText += `\n\n<file name="${att.name}">\n${content}\n</file>`;
							} else if (att.type === 'image') {
								fullText += `\n\n[image: ${att.name}]`;
							}
						}
					}

					// Optimistically add user message
					const userMsg: IAgentChatMessage = {
						id: `msg_${Date.now()}_user`,
						role: 'user',
						content: fullText,
						timestamp: Date.now(),
					};
					this._chatPanel?.addMessage(userMsg);

					// Set sending state BEFORE await — switches send button to stop icon immediately
					this._chatPanel?.setSending(true);
					this._isSending = true;

					// Create assistant message immediately with isThinking=true so the user
					// sees a "正在思考..." indicator while waiting for the first LLM delta.
					let assistantId: string | null = `msg_${Date.now()}_assistant`;
					const turnId = `turn_${Date.now()}`;
					let assistantMsg: IAgentChatMessage | null = {
						id: assistantId,
						role: 'assistant',
						content: '',
						timestamp: Date.now(),
						isStreaming: true,
						isThinking: true,
						streamPhase: 'llm_streaming',
						turnId,
					};
					this._chatPanel?.addMessage(assistantMsg);
					let assistantAdded = true;

					// No longer lazy — message is created above. This is kept as a no-op
					// guard for any code paths that still call it.
					const ensureAssistantMsg = () => {
						if (assistantAdded) { return; }
						// Fallback: should not normally reach here since message is pre-created.
						assistantId = `msg_${Date.now()}_assistant`;
						assistantMsg = {
							id: assistantId,
							role: 'assistant',
							content: '',
							timestamp: Date.now(),
							isStreaming: true,
							isThinking: true,
							streamPhase: 'llm_streaming',
							turnId: `turn_${Date.now()}`,
						};
						this._chatPanel?.addMessage(assistantMsg);
						assistantAdded = true;
					};

					await this._chatService.sendMessage(
						agentId,
						fullText,
						{
							chatMode: this._currentChatMode,
							agentSessionId: sessionId,
							explicitSkillIds: explicitSkillIds,
						},
						(delta) => {
							if (!delta) return;

							// Inter-turn gap: agent loop continued after `done` set _isSending=false.
							// Re-activate streaming state so the panel uses the streaming scroll path
							// (avoids the non-streaming 80px threshold falsely disabling auto-scroll
							// when content growth between turns makes distFromBottom >= 80).
							if (!this._isSending && (delta.type === 'text' || delta.type === 'thinking' || delta.type === 'tool_start' || delta.type === 'tool_result')) {
								this._chatPanel?.setSending(true);
								this._isSending = true;
							}

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
										isThinking: false,
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
										isThinking: false,
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
										endCall.status = 'success';
										// After a tool completes, the LLM will process the result and
										// generate the next response. Show "正在思考..." while waiting.
										this._chatPanel?.setStreamPhase('llm_streaming');
										this._chatPanel?.updateMessage(assistantId, {
											toolCalls: assistantMsg.toolCalls!.slice(),
											isStreaming: true,
											isThinking: true,
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
										if (resultCall.status === 'running') { resultCall.status = 'success'; }
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
												if (tc.status === 'running') { tc.status = 'success'; }
											}
										}
										// 单次 LLM 开始到结束的耗时（ms）
										const durationMs = Date.now() - (assistantMsg.timestamp || Date.now());
										this._chatPanel?.setStreamPhase('idle');
										this._chatPanel?.updateMessage(assistantId, {
											toolCalls: assistantMsg.toolCalls ? assistantMsg.toolCalls.slice() : undefined,
											isStreaming: false,
											isThinking: false,
											streamPhase: 'idle',
											metadata: { ...(assistantMsg.metadata || {}), durationMs },
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
										const total = delta.usage.totalTokens ?? (input + output);
										const cachedRead = delta.usage.cachedTokens ?? 0;
										const cacheWrite = delta.usage.cacheWriteTokens ?? 0;
										const credit = delta.usage.credit;
										const cacheMiss = Math.max(0, input - cachedRead - cacheWrite);
										const cacheHitRate = input > 0 ? (cachedRead / input) * 100 : 0;
										const tokenUsage = { input, output, total, cached: cachedRead || undefined, cachedRead: cachedRead || undefined, cacheWrite: cacheWrite || undefined, cacheMiss, reasoning: 0, cacheHitRate, credit };
										assistantMsg.tokenUsage = tokenUsage;
										this._chatPanel?.updateMessage(assistantId, { tokenUsage });
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
								case 'context_compacted': {
									// 上下文压缩完成：更新上下文环基线 + 添加压缩提示卡片
									const compacted = (delta as any).compactedInputTokens ?? 0;
									if (compacted > 0) {
										this._chatPanel?.setCompactedBaseline(compacted);
										// 持久化到 localStorage，窗口重载后可恢复 token 进度条基线
										this._saveCompactedBaseline(compacted);
									}
									const limit = this._currentMaxContextTokens ?? 0;
									if (limit > 0 && compacted > 0) {
										const ratio = Math.max(0, Math.min(1, compacted / limit));
										this._chatPanel?.setContextUsage({
											used: compacted,
											limit,
											ratio,
											percent: ratio * 100,
										} as IContextUsage);
									}
									// 添加压缩提示卡片（对齐 webview 的 CompressionNoticeCard）
									const origCount = (delta as any).compressionOriginalCount ?? 0;
									const compCount = (delta as any).compressionCompressedCount ?? 0;
									const tokensSaved = (delta as any).compressionTokensSaved ?? 0;
									const durationMs = (delta as any).compressionDurationMs ?? 0;
									if (origCount > 0 && compCount > 0 && compCount < origCount) {
										this._chatPanel?.addCompressionNotice({
											originalCount: origCount,
											compressedCount: compCount,
											tokensSaved,
											durationMs,
											beforeText: (delta as any).compressionBeforeText,
											afterText: (delta as any).compressionAfterText,
											summary: (delta as any).compressionSummary,
										});
									}
									break;
								}
								case 'memory_extracted': {
									// LLM 输出 <memory_extract> 标签被捕获 → 显示记忆卡片（同步，已提取）
									const memContent = (delta as any).content ?? '';
									const memMeta = (delta as any).metadata ?? {};
									if (memContent) {
										this._chatPanel?.addMemoryNotice({
											content: memContent,
											memoryType: memMeta.memoryType,
											priority: memMeta.priority,
											sceneName: memMeta.sceneName,
											assistantContentPreview: memMeta.assistantContentPreview,
											iteration: memMeta.iteration,
											status: 'saved',
										});
									}
									break;
								}
								case 'memory_writing': {
									// L0 记忆写入开始 → 显示 pending 卡片（含 noticeId 供后续更新）
									const memContent = (delta as any).content ?? '';
									const memMeta = (delta as any).metadata ?? {};
									if (memContent) {
										this._chatPanel?.addMemoryNotice({
											content: memContent,
											memoryType: memMeta.memoryType,
											priority: memMeta.priority,
											sceneName: memMeta.sceneName,
											assistantContentPreview: memMeta.assistantContentPreview,
											iteration: memMeta.iteration,
											noticeId: memMeta.noticeId,
											status: 'pending',
										});
									}
									break;
								}
								case 'memory_written': {
									// L0 记忆写入成功 → 更新 pending 卡片为 saved（或移除空内容卡片）
									const memMeta = (delta as any).metadata ?? {};
									if (memMeta.noticeId) {
										if (memMeta.remove) {
											this._chatPanel?.removeMemoryNotice(memMeta.noticeId);
										} else {
											this._chatPanel?.updateMemoryNotice(memMeta.noticeId, 'saved', (delta as any).content);
										}
									}
									break;
								}
								case 'memory_write_failed': {
									// L0 记忆写入失败 → 更新 pending 卡片为 failed
									const memMeta = (delta as any).metadata ?? {};
									if (memMeta.noticeId) {
										this._chatPanel?.updateMemoryNotice(memMeta.noticeId, 'failed', (delta as any).content);
									}
									break;
								}
							case 'memory_injected': {
								// 记忆上下文已注入 system prompt → 显示注入通知卡片
								const memContent = (delta as any).content ?? '';
								const memMeta = (delta as any).metadata ?? {};
								if (memContent) {
									this._chatPanel?.addMemoryNotice({
										content: memContent,
										memoryType: 'injected',
										status: 'saved',
										entries: memMeta.entries,
									});
								}
								break;
							}
							case 'skill_extracted' as any: {
								// 技能沉淀完成 → 显示技能沉淀通知卡片（可点击跳转）
								const skillContent = (delta as any).content ?? '';
								const skillMeta = (delta as any).metadata ?? {};
								if (skillContent) {
									this._chatPanel?.addMemoryNotice({
										content: skillContent,
										memoryType: 'skill',
										status: 'saved',
										skillId: skillMeta.skillId,
										skillTitle: skillMeta.title,
										agentId: skillMeta.agentId,
										clickable: true,
									});
								}
								break;
							}
								default:
									break;
							}
						},
					);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] sendMessage failed:', err);
					this._chatPanel?.setSending(false);
					this._isSending = false;
				}
			}),
			onEditMessage: (messageId: string, newText: string) => {
				void this._handleEditMessage(messageId, newText);
			},
			onCancelExecution: () => {
				try {
					// If a workflow execution is active, cancel it (this aborts
					// the in-flight LLM call and fires execution_end).
					if (this._liveWorkflowExecId) {
						this._workflowExecutionService.cancelExecution(this._liveWorkflowExecId).catch(err => {
							this._logService.error('[NativeChatEditorPane] cancelWorkflowExecution failed:', err);
						});
					}
					// Also cancel any in-flight chat stream
					const agentId = this._currentAgentId ?? 'claw';
					const sessionId = this._currentSessionId ?? undefined;
					this._chatService.cancelStream(agentId, sessionId);
					// 立即恢复 UI 状态——cancelStream 中断 AbortController 后，
					// for-await 循环仅在下个 delta 到达时才 break，done/error delta
					// 不会被发射，setSending(false) 不会被调用。这里手动恢复按钮 + 输入框。
					this._chatPanel?.setSending(false);
					this._isSending = false;
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] cancelExecution failed:', err);
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
				// Persist the chat mode so it survives reloads.
				try { localStorage.setItem('agentChatMode', mode); } catch { /* ignore */ }
			},
			onOpenSettings: async () => {
				// Open agent settings page (refer to AgentChat.tsx settings button)
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onOpenSettings: no agent selected');
					return;
				}
				try {
					const agent = await this._agentStudioService.getAgent(this._currentAgentId);
					if (!agent) {
						this._logService.info(`[NativeChatEditorPane] onOpenSettings: agent ${this._currentAgentId} not found`);
						return;
					}
					const input = new AgentSettingsEditorInput(agent.id, agent.name);
					await this.group.openEditor(input, { pinned: true });
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onOpenSettings failed:', err);
				}
			},
			onListSkills: () => {
			return this._skillRegistry.getSkills().map(s => ({
				id: s.id,
				name: s.name ?? s.id,
				description: s.description ?? '',
				activation: s.activation,
				source: s.source,
				version: s.version,
				enabled: s.enabled,
				category: s.category,
			}));
		},
		onListMcpServers: () => {
			// 从 IMcpService 获取 MCP 服务器列表
			const servers = this._mcpService.servers.get();
			return servers.map(server => ({
				name: server.definition.label,
				status: server.connectionState.get().state === 2 ? 'connected' : // McpConnectionState.Kind.Running = 2
					server.connectionState.get().state === 1 ? 'starting' :
					server.connectionState.get().state === 3 ? 'error' : 'stopped',
				toolCount: server.tools.get().length,
			}));
		},
		onOpenMcpSettings: () => {
			// 打开 VS Code 原生 MCP 设置界面
			this._commandService.executeCommand('workbench.action.openSettings', 'mcp').catch(err => {
				this._logService.error('[NativeChatEditorPane] onOpenMcpSettings failed:', err);
			});
		},
		onOpenHtmlPreview: () => {
			// 在中间栏（当前激活的编辑器组）打开 config HTML 预览
			if (!this._currentAgentId) {
				this._logService.info('[NativeChatEditorPane] onOpenHtmlPreview: no agent selected');
				return;
			}
			try {
				const resource = URI.from({ scheme: 'saros-html-preview', path: `/${this._currentAgentId}` });
				const input = new HtmlPreviewEditorInput(resource, 'HTML 预览', this._currentAgentId);
				// 不传 group 参数 → 在当前激活的编辑器组（中间栏）打开
				this._editorService.openEditor(input, { pinned: true }).catch(err => {
					this._logService.error('[NativeChatEditorPane] onOpenHtmlPreview failed:', err);
				});
			} catch (err) {
				this._logService.error('[NativeChatEditorPane] onOpenHtmlPreview error:', err);
			}
		},
			onNewSession: async () => {
				// Create a new session for the current agent
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onNewSession: no agent selected');
					return;
				}
				try {
					const session = await this._chatService.createAgentSession(this._currentAgentId, `Session ${new Date().toLocaleString()}`);
					this._currentSessionId = session.id;
					this._logService.debug(`[NativeChatEditorPane] onNewSession: created session ${session.id}`);
					// Clear messages in UI
					this._chatPanel?.setMessages([]);
					// 新会话无压缩历史 → 重置压缩基线
					this._restoreCompactedBaseline();
					// New session has no checkpoints yet — reset bar & scope checkpoints to it.
					this._activateCheckpointSession(this._currentAgentId, session.id);
					// Refresh session list
					await this._refreshSessionList();
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onNewSession failed:', err);
				}
			},
			onOpenSession: async (sessionId: string) => {
				// Switch to the selected session and reload its history
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onOpenSession: no agent selected');
					return;
				}
				const agentId = this._currentAgentId;
				try {
					this._currentSessionId = sessionId;
					const history = await this._chatService.getHistory(agentId, sessionId);
					this._chatPanel?.setMessages(this._adaptHistoryMessages(history));
					// 恢复压缩基线（窗口重载后 token 进度条保持压缩后数值）
					this._restoreCompactedBaseline();
					// Scope checkpoints to the newly opened session & refresh the bar.
					this._activateCheckpointSession(agentId, sessionId);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onOpenSession failed:', err);
					this._chatPanel?.setMessages([]);
				}
			},
			onRenameSession: async (sessionId: string, newName: string) => {
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onRenameSession: no agent selected');
					return;
				}
				try {
					await this._chatService.renameAgentSession(this._currentAgentId, sessionId, newName);
					this._logService.debug(`[NativeChatEditorPane] onRenameSession: renamed session ${sessionId} to "${newName}"`);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onRenameSession failed:', err);
				}
			},
			onDeleteSession: async (sessionId: string) => {
				if (!this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onDeleteSession: no agent selected');
					return;
				}
				const agentId = this._currentAgentId;
				try {
					await this._chatService.deleteAgentSession(agentId, sessionId);
					this._logService.debug(`[NativeChatEditorPane] onDeleteSession: deleted session ${sessionId}`);
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
					this._logService.error('[NativeChatEditorPane] onDeleteSession failed:', err);
				}
			},
			// Orchestration plan callbacks
			onApprovePlan: async (planId: string) => {
				try {
					await this._taskOrchestrationService.approvePlan(planId);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] approvePlan failed:', err);
				}
			},
			onRejectPlan: async (planId: string) => {
				try {
					await this._taskOrchestrationService.rejectPlan(planId);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] rejectPlan failed:', err);
				}
			},
			onApproveWithoutExecute: async (planId: string) => {
				try {
					await this._taskOrchestrationService.approveWithoutExecute(planId);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] approveWithoutExecute failed:', err);
				}
			},
			onTaskAction: async (planId: string, taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => {
				try {
					await this._taskOrchestrationService.taskAction(planId, taskId, action);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] taskAction failed:', err);
				}
			},
			onUpdatePlan: async (planId: string, updates: Record<string, unknown>) => {
				try {
					await this._taskOrchestrationService.updatePlan(planId, updates);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] updatePlan failed:', err);
				}
			},
			onUpdateTask: async (planId: string, taskId: string, updates: Record<string, unknown>) => {
				try {
					await this._taskOrchestrationService.updateTask(planId, taskId, updates);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] updateTask failed:', err);
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
					this._logService.error('[NativeChatEditorPane] decomposeTask failed:', err);
				}
			},
			onClosePlanDialog: (planId: string) => {
				// Just log for now, the dialog is closed in AgentChatPanel
				this._logService.debug('[NativeChatEditorPane] closePlanDialog:', planId);
			},
			onSelectWorktree: async (worktree: { path: string; branch: string }) => {
				const workspaceId = this._agentStudioService.getActiveWorkspaceId() || this._currentWorkspaceId || undefined;
				if (!workspaceId || !this._currentAgentId) {
					this._logService.info('[NativeChatEditorPane] onSelectWorktree: missing workspaceId or agentId');
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
					this._logService.debug(`[NativeChatEditorPane] onSelectWorktree: switched to worktree ${worktree.path}`);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onSelectWorktree failed:', err);
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
					this._logService.info('[NativeChatEditorPane] onClearWorktree: missing workspaceId or agentId');
					return;
				}
				try {
					await this._agentStudioService.upsertAgentBinding(workspaceId, this._currentAgentId, {
						worktreePath: undefined,
						worktreeBranch: undefined,
					});
					// Update local state
					this._chatPanel?.setSelectedWorktree('');
					this._logService.debug(`[NativeChatEditorPane] onClearWorktree: switched to main repo`);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onClearWorktree failed:', err);
				}
			},
			onScrollToMessage: (_messageId: string) => {
				// Scrolling is handled internally by AgentChatPanel._scrollToMessage().
				// This callback is a notification hook only — no host-side action needed.
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
			onCheckpointAction: (action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string; checkpointId?: string }) => {
				void this._handleCheckpointAction(action, payload);
			},
			onConfirmationAction: (confirmationId: string, buttonId: string) => {
				void this._handleConfirmationAction(confirmationId, buttonId);
			},
			onAskUserSubmit: (askUserId: string, executionId: string, nodeId: string, selection: string | string[]) => {
				this._logService.debug('[NativeChatEditorPane] onAskUserSubmit:', askUserId, executionId, nodeId, selection);
				// Optimistically mark the AskUser as answered
				this._liveWorkflowAskUsers = this._liveWorkflowAskUsers.map(a =>
					a.id === askUserId
						? { ...a, status: 'answered' as const, selection, answeredAt: Date.now() }
						: a
				);
				this._refreshLiveWorkflowMessage();
				// Resume the paused workflow execution
				this._workflowExecutionService.resumeExecution(executionId, selection).catch(err => {
					this._logService.error('[NativeChatEditorPane] Failed to resume workflow:', err);
					// Rollback on failure
					this._liveWorkflowAskUsers = this._liveWorkflowAskUsers.map(a =>
						a.id === askUserId
							? { ...a, status: 'pending' as const, selection: undefined, answeredAt: undefined }
							: a
					);
					this._refreshLiveWorkflowMessage();
				});
			},
			onClarifySubmit: (toolCallId: string, selection: string) => {
				// 用户在 clarify 卡片中选择了选项 → 将选择作为新消息发送给 LLM
				this._logService.info('[NativeChatEditorPane] onClarifySubmit:', toolCallId, selection);
				void this._sendMessageInternal?.(selection);
			},
			onQuestionClick: (question: { label: string }) => {
				// Send the suggested question as a new user message.
				if (question?.label) {
					void this._sendMessageInternal?.(question.label);
				}
			},
			onReferenceClick: (ref: { kind: string; uri?: string; name: string; range?: { startLine: number } }) => {
				// Open file references in the editor, URL references in the URL preview.
				if (ref?.kind === 'url' && ref.uri) {
					const input = UrlPreviewEditorInput.getOrCreate(ref.uri);
					this._editorService.openEditor(input, { pinned: true }).catch(err => {
						this._logService.error('[NativeChatEditorPane] onReferenceClick: failed to open URL:', err);
					});
				} else if (ref?.kind === 'file' || ref?.kind === 'code' || ref?.kind === 'symbol') {
					const filePath = ref.uri || ref.name;
					if (filePath) {
						void this._openFileInEditor(filePath, ref.range?.startLine);
					}
				}
			},
			onTipAction: (_tipId: string, _actionId: string) => {
				// Tip actions are forward-compatible hooks. Common actionIds like
				// 'openSettings' or 'openMarket' can be routed here in the future.
				// For now, tip actions are handled by the panel's internal logic.
			},
			onTipDismiss: (_tipId: string) => {
				// Tip dismissal is a UI-only operation. The AgentChatPanel handles
				// hiding the tip card internally; no host-side persistence needed.
			},
			onApplyCode: (code: string, language: string, filePath?: string) => {
				void this._handleApplyCode(code, language, filePath);
			},
			onSubmitVariables: (executionId: string, values: Record<string, string>) => {
				this._logService.debug('[NativeChatEditorPane] onSubmitVariables:', executionId, values);
				this._workflowExecutionService.submitWorkflowVariables(executionId, values).catch(err => {
					this._logService.error('[NativeChatEditorPane] Failed to submit variables:', err);
				});
			},
			onOpenFile: (filePath: string, content?: string) => {
				if (content) {
					// 纯内容附件（如 Console Logs）— 在 untitled 编辑器中显示
					this._editorService.openEditor({
						resource: URI.from({ scheme: 'untitled', path: filePath }),
						contents: content,
					}).catch(err => {
						this._logService.error('[NativeChatEditorPane] onOpenFile: failed to open content:', err);
					});
				} else {
					// 真实文件路径 — 在编辑器中打开文件
					void this._openFileInEditor(filePath);
				}
			},
			// P0-2: @mention 文件搜索
			onSearchFiles: async (query: string): Promise<Array<{ path: string; name: string }>> => {
				return this._searchWorkspaceFiles(query);
			},
			// P0-2: @提及文件选择后添加为上下文
			onAddFileContext: (filePath: string) => {
				void this._addFileContextToChat(filePath);
			},
			// P1-1: 终端运行代码
			onRunInTerminal: (code: string) => {
				void this._runInTerminal(code);
			},
			// P1-3: 添加编辑器选中代码到聊天
			onAddSelectionToChat: () => {
				void this._addEditorSelectionToChat();
			},
			onOpenLink: (url: string) => {
				// 其他 http(s) 链接在编辑器区域（webview iframe）中打开
				const input = UrlPreviewEditorInput.getOrCreate(url);
				this._editorService.openEditor(input, { pinned: true }).catch(err => {
					this._logService.error('[NativeChatEditorPane] onOpenLink: failed to open URL preview:', err);
				});
			},
		}));

		this._container.appendChild(this._chatPanel.element);
		this._isInitialized = true;
		this._logService.debug(`[NativeChatEditorPane][Init] _initChatPanel panel constructed + appended t=${(performance.now() - t0).toFixed(1)}ms`);

		// 设置系统消息面板的详情回调
		this._chatPanel?.setOpenCompressionDetailCallback((data) => {
			const input = CompressionDetailEditorInput.getOrCreate(data as any);
			this._editorService.openEditor(input, { pinned: true }).catch(err => {
				this._logService.error('[NativeChatEditorPane] Failed to open compression detail:', err);
			});
		});
		this._chatPanel?.setOpenMemoryDetailCallback((agentId, memoryType, contentPreview) => {
			const input = MemoryDetailEditorInput.getOrCreate(agentId);
			input.targetMemoryId = null;
			input.targetLayer = memoryType ?? null;
			this._editorService.openEditor(input, { pinned: true }).then(() => {
				const pane = this._editorService.activeEditorPane;
				if (pane instanceof MemoryDetailEditorPane) {
					// 技能沉淀消息点击：跳转到技能页签
					if (memoryType === 'skill') {
						(pane as any)._currentView = 'skills';
						(pane as any)._renderFull();
					} else {
						pane.navigateToTarget(memoryType ?? undefined, contentPreview);
					}
				}
			}).catch(err => {
				this._logService.error('[NativeChatEditorPane] Failed to open memory detail:', err);
			});
		});
		this._chatPanel?.setOpenCodebaseDetailCallback(() => {
			const input = CodebaseMemoryDetailEditorInput.getOrCreate();
			this._editorService.openEditor(input, { pinned: true }).catch(err => {
				this._logService.error('[NativeChatEditorPane] Failed to open codebase memory detail:', err);
			});
		});
		this._logService.debug(`[NativeChatEditorPane][Init] callbacks set up t=${(performance.now() - t0).toFixed(1)}ms`);

		// Load available agents
		this._logService.debug(`[NativeChatEditorPane][Init] calling _loadAvailableAgents t=${(performance.now() - t0).toFixed(1)}ms`);
		this._loadAvailableAgents();

		// Model selector wiring — initialize provider/model data for toolbar
		// Debounce: multiple onDidChangeAvailableModels events fire in rapid
		// succession as providers register (observed 7+ calls). Only refresh
		// once after the burst settles.
		let modelSelectorTimer: ReturnType<typeof setTimeout> | null = null;
		const debouncedRefreshModelSelector = () => {
			if (modelSelectorTimer) { clearTimeout(modelSelectorTimer); }
			modelSelectorTimer = setTimeout(() => {
				modelSelectorTimer = null;
				void this._refreshModelSelector();
			}, 300);
		};
		this._logService.debug(`[NativeChatEditorPane][Init] calling _refreshModelSelector (debounced) t=${(performance.now() - t0).toFixed(1)}ms`);
		debouncedRefreshModelSelector();
		this._register(this._modelSelector.onDidChangeSelection(() => {
			debouncedRefreshModelSelector();
		}));
		this._register(this._modelSelector.onDidChangeAvailableModels(() => {
			debouncedRefreshModelSelector();
		}));
		this._register({ dispose: () => { if (modelSelectorTimer) { clearTimeout(modelSelectorTimer); } } });

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

		// Listen for orchestration task changes — refresh the plan dialog if open
		this._register(this._taskOrchestrationService.onDidChangeTask(async ({ planId }) => {
			// Reload the plan and update the dialog if it's currently shown
			const plan = await this._taskOrchestrationService.getPlan(planId);
			if (plan) {
				this._chatPanel?.showOrchestrationPlanDialog(plan);
			}
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

		// ── Workflow execution: build live workflow message in Native Chat,
		//    handle variable collection, subagent updates, and execution end. ──
		this._register(this._workflowExecutionService.onDidExecutionTrace(async (trace) => {
			// Skip events from other sessions, EXCEPT for the workflow-root
			// subagent_start which carries the NEW session we need to switch to.
			//
			// v7: also allow events that belong to the current execution (same
			// executionId). Non-root subagent events carry the SUB-AGENT's own
			// sessionId which differs from the owner session, so a pure sessionId
			// match would incorrectly drop them.
			const isWorkflowRoot = trace.kind === 'subagent_start' && (trace as any).nodeId === '__workflow__';
			const isCurrentExecution = this._liveWorkflowExecId && trace.executionId === this._liveWorkflowExecId;
			if (!isWorkflowRoot && !isCurrentExecution && this._currentSessionId && trace.sessionId && trace.sessionId !== this._currentSessionId) {
				return;
			}


			switch (trace.kind) {
				case 'subagent_start': {
					if (trace.nodeId === '__workflow__') {
						// Workflow root: switch session + create live message
						const { workflowAgentId, sessionId, nodeName } = trace;
						this._logService.debug(`[NativeChatEditorPane] Workflow started: agent=${workflowAgentId}, session=${sessionId}, name=${nodeName}`);
						this._currentAgentId = workflowAgentId;
						this._currentSessionId = sessionId;
						this._liveWorkflowExecId = trace.executionId;
						this._liveWorkflowMsgId = `wf_live_${trace.executionId}`;
						this._liveWorkflowSubAgents = [];
						this._liveWorkflowEvents = [];
						this._liveWorkflowCollectVars = {};
						this._liveWorkflowAskUsers = [];
						this._liveWorkflowReady = false;
						// Update chat input: switch send button to stop icon + start context ring tracking
						this._chatPanel?.setSending(true);
						this._isSending = true;
						this._chatPanel?.setStreamPhase('llm_streaming');
						this._chatPanel?.setStreamTextBuffer('');
						this._chatPanel?.setStreamThinkingBuffer('');
						try {
							const history = await this._chatService.getHistory(workflowAgentId, sessionId);
							this._chatPanel?.setMessages(this._adaptHistoryMessages(history));
							this._activateCheckpointSession(workflowAgentId, sessionId);
							await this._refreshSessionList();
						} catch (err) {
							this._logService.info('[NativeChatEditorPane] Failed to load workflow session history:', err);
						}
						// Add live workflow assistant message with CURRENT state
						// (events arriving during await already updated the arrays)
						this._chatPanel?.addMessage({
							id: this._liveWorkflowMsgId!,
							role: 'assistant',
							content: `▶ **${nodeName}** — 执行中...`,
							timestamp: Date.now(),
							isStreaming: true,
							workflowExecutions: {
								[trace.executionId]: {
									executionId: trace.executionId,
									workflowName: nodeName,
									status: 'running' as const,
									subAgents: this._liveWorkflowSubAgents,
									startTime: Date.now(),
								},
							},
							workflowEvents: this._liveWorkflowEvents,
							...(Object.keys(this._liveWorkflowCollectVars).length > 0
								? { collectVariables: this._liveWorkflowCollectVars }
								: {}),
						} as any);
						this._liveWorkflowReady = true;
						// Safeguard: flush any state that accumulated during the await above.
						// Events arriving between handler-start and addMessage updated the arrays
						// but _refreshLiveWorkflowMessage returned early (!ready). Now that the
						// message exists and ready=true, force a refresh so the DOM reflects
						// the full accumulated state (subagents + toolCalls).
						if (this._liveWorkflowSubAgents.length > 0) {
							this._refreshLiveWorkflowMessage();
						}
					} else {
						// Non-root subagent start: add to subAgents list
						this._logService.debug(`[NativeChatEditorPane] subagent_start: node=${trace.nodeId}, name=${trace.nodeName}, type=${trace.nodeType}`);

						// Fallback: if __workflow__ root event was missed (timing race
						// or event dropped), auto-initialize the live workflow container
						// so the sub-agent card can still render.
						if (!this._liveWorkflowMsgId || !this._liveWorkflowExecId) {
							this._logService.info(`[NativeChatEditorPane] subagent_start without __workflow__ root — auto-initializing live workflow (execId=${trace.executionId})`);
							this._liveWorkflowExecId = trace.executionId;
							this._liveWorkflowMsgId = `wf_live_${trace.executionId}`;
							this._liveWorkflowSubAgents = [];
							this._liveWorkflowEvents = [];
							this._liveWorkflowCollectVars = {};
							this._liveWorkflowAskUsers = [];
							this._liveWorkflowReady = false;
							// Update chat input: switch send button to stop icon + start context ring tracking
							this._chatPanel?.setSending(true);
							this._isSending = true;
							this._chatPanel?.setStreamPhase('llm_streaming');
							this._chatPanel?.setStreamTextBuffer('');
							this._chatPanel?.setStreamThinkingBuffer('');
							if (trace.workflowAgentId) { this._currentAgentId = trace.workflowAgentId; }
							if (trace.sessionId) { this._currentSessionId = trace.sessionId; }
							// Create the live workflow message immediately
							this._chatPanel?.addMessage({
								id: this._liveWorkflowMsgId!,
								role: 'assistant',
								content: `▶ **${trace.nodeName || trace.nodeId}** — 执行中...`,
								timestamp: Date.now(),
								isStreaming: true,
								workflowExecutions: {
									[trace.executionId]: {
										executionId: trace.executionId,
										workflowName: trace.nodeName || trace.nodeId,
										status: 'running' as const,
										subAgents: this._liveWorkflowSubAgents,
										startTime: Date.now(),
									},
								},
								workflowEvents: this._liveWorkflowEvents,
							} as any);
							this._liveWorkflowReady = true;
						}

						this._liveWorkflowSubAgents.push({
							id: trace.nodeId,
							name: trace.nodeName,
							type: trace.nodeType,
							task: trace.task,
							status: 'running' as const,
							startTime: Date.now(),
						});
						this._liveWorkflowEvents.push({
							id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
							executionId: trace.executionId,
							sessionId: trace.sessionId,
							timestamp: Date.now(),
							kind: 'subagent_start' as const,
							nodeId: trace.nodeId,
							nodeName: trace.nodeName,
							nodeType: trace.nodeType,
						});
						this._refreshLiveWorkflowMessage();
					}
					break;
				}
				case 'collect_variables': {
					this._logService.debug(`[NativeChatEditorPane] collect_variables: executionId=${trace.executionId}, vars=${trace.variables.map((v: any) => v.name).join(',')}`);
					this._liveWorkflowEvents.push({
						id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						executionId: trace.executionId,
						sessionId: trace.sessionId,
						timestamp: Date.now(),
						kind: 'collect_variables' as const,
						nodeId: '',
					});
					this._liveWorkflowCollectVars[trace.executionId] = {
						id: trace.executionId,
						executionId: trace.executionId,
						variables: trace.variables,
						values: {},
						status: 'pending' as const,
						createdAt: Date.now(),
					};
					this._refreshLiveWorkflowMessage();
					break;
				}
				case 'collect_variables_end': {
					this._logService.debug(`[NativeChatEditorPane] collect_variables_end: executionId=${trace.executionId}, status=${trace.status}`);
					this._liveWorkflowEvents.push({
						id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						executionId: trace.executionId,
						sessionId: trace.sessionId,
						timestamp: Date.now(),
						kind: 'collect_variables_end' as const,
						nodeId: '',
						status: trace.status,
					});
					this._liveWorkflowCollectVars[trace.executionId] = {
						id: trace.executionId,
						executionId: trace.executionId,
						variables: [],
						values: {},
						status: (trace.status === 'submitted' ? 'submitted' : 'skipped') as 'submitted' | 'skipped',
						createdAt: Date.now(),
					};
					this._refreshLiveWorkflowMessage();
					break;
				}
				case 'delta': {
					// Update subAgent streamed text / tool calls.
					// IMPORTANT: _sanitizeDelta() in workflowExecutionService.ts maps the raw
					// stream chunk fields to: toolCallId, toolName, arguments, content.
					// We must read those same field names here — NOT d.id/d.name/d.args.
					const d = trace.delta as any;
					if (d?.type === 'tool_start' || d?.type === 'tool_end' || d?.type === 'tool_args' || d?.type === 'tool_result') {
						this._logService.debug(`[NativeChatEditorPane] delta: node=${trace.nodeId}, type=${d.type}, tool=${d.toolName ?? d.name ?? d.id}`, JSON.stringify(d).slice(0, 200));
					}
					const sa = this._liveWorkflowSubAgents.find(s => s.id === trace.nodeId);

					// ── Stream phase + context ring updates ──
					// Keep the chat input's token progress bar and send button in sync
					// with workflow subagent streaming activity.
					if (d) {
						if (d.type === 'text') {
							this._chatPanel?.setStreamPhase('llm_streaming');
						} else if (d.type === 'thinking') {
							this._chatPanel?.setStreamPhase('llm_streaming');
						} else if (d.type === 'tool_start' || d.type === 'tool_args' || d.type === 'tool_end' || d.type === 'tool_result') {
							this._chatPanel?.setStreamPhase('tool_executing');
						}
						// Usage delta — update real token counts for the context ring
						if (d.type === 'usage' && d.usage) {
							const limit = this._currentMaxContextTokens ?? 0;
							if (limit > 0 || d.usage.inputTokens || d.usage.outputTokens) {
								this._chatPanel?.setStreamUsage({
									input: d.usage.inputTokens ?? 0,
									output: d.usage.outputTokens ?? 0,
									seen: true,
								});
							}
						}
					}

					if (sa && d) {
						if (d.type === 'text' && d.content) {
							sa.streamedText = (sa.streamedText ?? '') + d.content;
							// Update stream text buffer for context ring estimation
							this._chatPanel?.setStreamTextBuffer(sa.streamedText);
						} else if (d.type === 'thinking' && d.content) {
							sa.streamedThinking = (sa.streamedThinking ?? '') + d.content;
							this._chatPanel?.setStreamThinkingBuffer(sa.streamedThinking ?? '');
						} else if (d.type === 'tool_start') {
							sa.toolCalls = sa.toolCalls ?? [];
							sa.toolCalls.push({
								id: d.toolCallId ?? d.id ?? `tc_${Date.now()}`,
								name: d.toolName ?? d.name ?? '',
								status: 'running',
								args: d.arguments ?? d.args ?? '',
							});
						} else if (d.type === 'tool_args') {
							// Match by sanitized field name (toolCallId) with fallback
							const tc = sa.toolCalls?.find((t: any) => t.id === (d.toolCallId ?? d.id));
							if (tc) { tc.args = (tc.args ?? '') + (d.content ?? d.arguments ?? d.args ?? ''); }
						} else if (d.type === 'tool_end') {
							const tc = sa.toolCalls?.find((t: any) => t.id === (d.toolCallId ?? d.id));
							if (tc) { tc.status = 'done'; tc.result = d.content ?? d.result ?? ''; }
						} else if (d.type === 'tool_result') {
							// Some streams emit tool_result instead of tool_end
							const tc = sa.toolCalls?.find((t: any) => t.id === (d.toolCallId ?? d.id));
							if (tc) {
								tc.result = d.content ?? d.result ?? '';
								if (tc.status === 'running') { tc.status = 'done'; }
							}
						}
					}
					this._scheduleDeltaRefresh();
					break;
				}
				case 'subagent_end': {
					const sa = this._liveWorkflowSubAgents.find(s => s.id === trace.nodeId);
					if (sa) {
						sa.status = trace.status === 'done' ? 'done' as const : trace.status === 'cancelled' ? 'cancelled' as const : 'error' as const;
						sa.output = trace.output;
						sa.error = trace.error;
						sa.endTime = Date.now();
					}
					this._liveWorkflowEvents.push({
						id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						executionId: trace.executionId,
						sessionId: trace.sessionId,
						timestamp: Date.now(),
						kind: 'subagent_end' as const,
						nodeId: trace.nodeId,
						status: trace.status,
						summary: trace.output?.slice(0, 200),
					});
					this._refreshLiveWorkflowMessage();
					break;
				}
				case 'ask_user': {
					this._logService.debug(`[NativeChatEditorPane] ask_user: node=${trace.nodeId}, question=${trace.question?.substring(0, 60)}`);
					const askId = `${trace.executionId}:${trace.nodeId}`;
					// Dedup: skip if already registered
					if (!this._liveWorkflowAskUsers.some(a => a.id === askId)) {
						const entry: ILiveWorkflowAskUser = {
							id: askId,
							executionId: trace.executionId,
							nodeId: trace.nodeId,
							nodeName: trace.nodeName ?? trace.nodeId,
							question: trace.question ?? '',
							options: trace.options ?? [],
							multiSelect: trace.multiSelect ?? false,
							selectedIndices: [],
							status: 'pending',
							createdAt: Date.now(),
						};
						this._liveWorkflowAskUsers.push(entry);
					}
					this._liveWorkflowEvents.push({
						id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						executionId: trace.executionId,
						sessionId: trace.sessionId,
						timestamp: Date.now(),
						kind: 'ask_user' as const,
						nodeId: trace.nodeId,
						nodeName: trace.nodeName,
						summary: `❓ ${trace.question?.substring(0, 60) ?? ''}`,
					});
					this._refreshLiveWorkflowMessage();
					break;
				}
				case 'ask_user_end': {
					this._logService.debug(`[NativeChatEditorPane] ask_user_end: node=${trace.nodeId}, status=${trace.status}`);
					const askId = `${trace.executionId}:${trace.nodeId}`;
					const status = (trace.status as 'answered' | 'cancelled' | 'expired') ?? 'answered';
					if (status !== 'answered') {
						this._liveWorkflowAskUsers = this._liveWorkflowAskUsers.map(a =>
							a.id === askId && a.status === 'pending'
								? { ...a, status, answeredAt: Date.now() }
								: a
						);
					}
					this._liveWorkflowEvents.push({
						id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						executionId: trace.executionId,
						sessionId: trace.sessionId,
						timestamp: Date.now(),
						kind: 'ask_user_end' as const,
						nodeId: trace.nodeId,
						status: trace.status,
						summary: `已${status === 'answered' ? '回答' : status === 'cancelled' ? '取消' : '过期'}`,
					});
					this._refreshLiveWorkflowMessage();
					break;
				}
				case 'execution_end': {
					this._logService.debug(`[NativeChatEditorPane] execution_end: status=${trace.status}`);

					// Snapshot data BEFORE any state mutation — we need it for the final
					// card update AND for a safety-net delayed refresh.
					const snapExecId = this._liveWorkflowExecId;
					const snapMsgId = this._liveWorkflowMsgId;
					const snapEvents = this._liveWorkflowEvents.slice();
					const snapSubAgents = this._liveWorkflowSubAgents.slice();
					const snapWorkflowName = (() => {
						const we = snapEvents.find(e => e.kind === 'subagent_start' && e.nodeId === '__workflow__');
						return we?.nodeName ?? '';
					})();
					const finalStatus = trace.status === 'completed' ? 'completed' as const
						: trace.status === 'failed' ? 'failed' as const
							: 'cancelled' as const;

					// ── Step 1: Update the live workflow card to final status ──
					this._refreshLiveWorkflowMessage({
						workflowExecutions: snapExecId ? {
							[snapExecId]: {
								executionId: snapExecId,
								workflowName: snapWorkflowName,
								status: finalStatus,
								subAgents: snapSubAgents,
								startTime: Date.now(),
								endTime: Date.now(),
							},
						} : undefined,
					});

					// ── Step 2: Reset chat input state immediately ──
					this._chatPanel?.setSending(false);
					this._isSending = false;
					this._chatPanel?.setStreamPhase('idle');
					this._chatPanel?.setStreamTextBuffer('');
					this._chatPanel?.setStreamThinkingBuffer('');
					this._chatPanel?.setStreamUsage(null);

					// ── Step 3: Safety-net delayed refresh ──
					// The _updateMessageDom rebuild may be batched by the browser.
					// Schedule one more refresh in the next animation frame to guarantee
					// the card renders with completed/failed/cancelled status (not stuck
					// on "执行中...").  We capture values in closure so they survive the
					// async gap below where _liveWorkflow* fields are cleared.
					if (snapExecId && snapMsgId) {
						const safetyExecId = snapExecId;
						const safetyMsgId = snapMsgId;
						requestAnimationFrame(() => {
							if (!safetyExecId || !this._chatPanel) { return; }
							// Re-push final status even if _liveWorkflow* was already cleared.
							// This uses updateMessage directly (bypassing the !ready guard)
							// since we know the message exists in the DOM.
							this._chatPanel.updateMessage(safetyMsgId, {
								isStreaming: false,
								workflowExecutions: {
									[safetyExecId]: {
										executionId: safetyExecId,
										workflowName: snapWorkflowName,
										status: finalStatus,
										subAgents: snapSubAgents,
										startTime: Date.now(),
										endTime: Date.now(),
									},
								},
								workflowEvents: snapEvents,
							} as any);
						});
					}

					// ── Step 4: Clear live state (AFTER the safety-net closure captured its values) ──
					// Do NOT clear _liveWorkflowReady or _liveWorkflowMsgId before the
					// requestAnimationFrame above fires, or the closure's updateMessage
					// is the only way to fix stale UI.
					this._liveWorkflowExecId = null;
					this._liveWorkflowMsgId = null;
					this._liveWorkflowSubAgents = [];
					this._liveWorkflowEvents = [];
					this._liveWorkflowCollectVars = {};
					this._liveWorkflowAskUsers = [];
					this._liveWorkflowReady = false;

					break;
				}
			}
		}));

		this._logService.debug('[NativeChatEditorPane] Chat panel initialized');
	}

	/**
	 * Throttled refresh for delta events. During streaming, hundreds of deltas
	 * fire in rapid succession; this coalesces them into at most one DOM update
	 * per 100ms. Non-delta events (subagent_end, ask_user, etc.) call
	 * _refreshLiveWorkflowMessage directly, which cancels any pending delta refresh.
	 */
	private _scheduleDeltaRefresh(): void {
		if (this._deltaRefreshTimer) { return; } // already scheduled
		this._deltaRefreshTimer = setTimeout(() => {
			this._deltaRefreshTimer = null;
			this._refreshLiveWorkflowMessage();
		}, 100);
	}

	/** Update the live workflow message in the chat panel with current state. */
	private _refreshLiveWorkflowMessage(overrides?: Record<string, unknown>): void {
		// Cancel any pending throttled delta refresh — this is an immediate refresh.
		if (this._deltaRefreshTimer) {
			clearTimeout(this._deltaRefreshTimer);
			this._deltaRefreshTimer = null;
		}
		if (!this._liveWorkflowMsgId || !this._liveWorkflowExecId) { return; }
		// Skip if the message hasn't been added to the chat panel yet.
		// State is already captured in the arrays; addMessage will include it.
		if (!this._liveWorkflowReady) { return; }
		const updates: Record<string, unknown> = {
			workflowExecutions: {
				[this._liveWorkflowExecId]: {
					executionId: this._liveWorkflowExecId,
					workflowName: '',
					status: 'running',
					subAgents: this._liveWorkflowSubAgents,
					startTime: Date.now(),
				},
			},
			workflowEvents: this._liveWorkflowEvents,
			...(Object.keys(this._liveWorkflowCollectVars).length > 0
				? { collectVariables: this._liveWorkflowCollectVars }
				: {}),
			...(this._liveWorkflowAskUsers.length > 0
				? { askUsers: this._liveWorkflowAskUsers }
				: {}),
			...overrides,
		};
		this._chatPanel?.updateMessage(this._liveWorkflowMsgId, updates);
	}

	private async _selectAndLoadAgent(agentId: string): Promise<void> {
		const t0 = performance.now();
		this._logService.debug(`[NativeChatEditorPane][Init] _selectAndLoadAgent START agentId=${agentId}`);
		try {
			const emp = await this._agentStudioService.getAgent(agentId);
			this._logService.debug(`[NativeChatEditorPane][Init] getAgent done t=${(performance.now() - t0).toFixed(1)}ms`);
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
					this._logService.debug(`[NativeChatEditorPane][Init] calling getOrCreateActiveSession t=${(performance.now() - t0).toFixed(1)}ms`);
					const session = await this._chatService.getOrCreateActiveSession(agentId);
					this._currentSessionId = session.id;
					this._logService.debug(`[NativeChatEditorPane][Init] getOrCreateActiveSession done session=${session.id} t=${(performance.now() - t0).toFixed(1)}ms`);

					// Load history messages for this session
					try {
						this._logService.debug(`[NativeChatEditorPane][Init] calling getHistory t=${(performance.now() - t0).toFixed(1)}ms`);
						const history = await this._chatService.getHistory(agentId, this._currentSessionId);
						this._logService.debug(`[NativeChatEditorPane][Init] getHistory done count=${history?.length ?? 0} t=${(performance.now() - t0).toFixed(1)}ms`);
						// Yield to event loop: let the input box render and become
						// interactive BEFORE the heavy synchronous setMessages call
						// (which blocks ~1.4s for 259 messages).
						const adapted = this._adaptHistoryMessages(history);
						await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
						this._logService.debug(`[NativeChatEditorPane][Init] setMessages START (after yield) t=${(performance.now() - t0).toFixed(1)}ms`);
						this._chatPanel.setMessages(adapted);
						this._logService.debug(`[NativeChatEditorPane][Init] setMessages done t=${(performance.now() - t0).toFixed(1)}ms`);
						// 恢复压缩基线（窗口重载后 token 进度条保持压缩后数值）
						this._restoreCompactedBaseline();
					} catch (err) {
						this._logService.info('[NativeChatEditorPane] Failed to load history:', err);
						this._chatPanel.setMessages([]);
					}
					// Register active session for checkpoint scoping & refresh checkpoint bar
					this._activateCheckpointSession(agentId, this._currentSessionId);
					this._logService.debug(`[NativeChatEditorPane][Init] _selectAndLoadAgent END t=${(performance.now() - t0).toFixed(1)}ms`);
				} catch (err) {
					this._logService.info('[NativeChatEditorPane] getOrCreateActiveSession failed:', err);
				}
				// Load worktrees for the selected agent
				await this._loadWorktrees();
				// Refresh chat-history panel
				await this._refreshSessionList();
			}
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _selectAndLoadAgent failed:', err);
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

	/** 持久化压缩基线到 localStorage（key 按 agentId:sessionId 隔离）。 */
	private _saveCompactedBaseline(baseline: number): void {
		if (!this._currentAgentId || !this._currentSessionId) { return; }
		try {
			const key = `saros:compactedBaseline:${this._currentAgentId}:${this._currentSessionId}`;
			localStorage.setItem(key, String(baseline));
		} catch { /* localStorage may be unavailable */ }
	}

	/** 从 localStorage 恢复压缩基线（窗口重载后 token 进度条保持压缩后数值）。
	 *  新会话或无压缩历史时清除基线，避免残留旧值。 */
	private _restoreCompactedBaseline(): void {
		if (!this._currentAgentId || !this._currentSessionId) {
			this._chatPanel?.setCompactedBaseline(0);
			return;
		}
		try {
			const key = `saros:compactedBaseline:${this._currentAgentId}:${this._currentSessionId}`;
			const saved = localStorage.getItem(key);
			if (saved) {
				const baseline = parseInt(saved, 10);
				if (baseline > 0) {
					this._chatPanel?.setCompactedBaseline(baseline);
					return;
				}
			}
		} catch { /* localStorage may be unavailable */ }
		// 无保存的基线 → 重置为 0（新会话或从未压缩过）
		this._chatPanel?.setCompactedBaseline(0);
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
				this._logService.error('[NativeChatEditorPane] _ensureSession failed:', err);
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
			this._logService.error('[NativeChatEditorPane] _handleEditMessage: truncate failed:', err);
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
			this._chatPanel?.setCheckpoints([]);
			return;
		}
		try {
			const list = await this._checkpointService.listCheckpoints(this._currentAgentId, this._currentSessionId);
			// Build ICheckpointInfo for each checkpoint (including ghosts)
			const infos: ICheckpointInfo[] = [];
			for (const cp of list) {
				const files = (cp.files ?? []).map(f => {
					// ICheckpointFileChange has: uri (URI string), fsPath (filesystem path), fileName, additions, deletions
					// Use fsPath for the editor (URI.file() compatible); fall back to uri parsed via URI.parse
					const cf = f as { fsPath?: string; uri?: string; fileName?: string; additions?: number; deletions?: number };
					let resolvedPath = cf.fsPath ?? '';
					if (!resolvedPath && cf.uri) {
						try { resolvedPath = URI.parse(cf.uri).fsPath; } catch { resolvedPath = cf.uri; }
					}
					// Derive status: only-additions → created; only-deletions → deleted; otherwise modified
					const adds = cf.additions ?? 0;
					const dels = cf.deletions ?? 0;
					const status: 'modified' | 'created' | 'deleted' =
						(adds > 0 && dels === 0) ? 'created' :
							(adds === 0 && dels > 0) ? 'deleted' : 'modified';
					return { path: resolvedPath, status };
				}).filter(f => !!f.path);
				infos.push({
					id: cp.id,
					label: cp.label || (cp.type === 'tool_edit' ? '工具修改' : '用户检查点'),
					timestamp: cp.createdAt,
					fileCount: files.length || cp.fileSnapshotIds.length,
					files,
				});
			}
			this._chatPanel.setCheckpoints(infos);
		} catch {
			this._chatPanel.setCheckpoints([]);
		}
	}

	private async _handleCheckpointAction(action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string; checkpointId?: string }): Promise<void> {
		if (!this._currentAgentId || !this._currentSessionId) {
			return;
		}
		const agentId = this._currentAgentId;
		const sessionId = this._currentSessionId;
		try {
			if (action === 'undoAll') {
				await this._checkpointService.revertAllCheckpoints(agentId, sessionId);
				await this._checkpointService.deleteAllCheckpoints(agentId, sessionId);
				this._chatPanel?.setCheckpoints([]);
				return;
			}
			if (action === 'keepAll') {
				await this._checkpointService.deleteAllCheckpoints(agentId, sessionId);
				this._chatPanel?.setCheckpoints([]);
				return;
			}
			if (action === 'openDiff') {
				try {
					await this._commandService.executeCommand(
						'agentStudio.openCheckpointDiff',
						{ agentId, sessionId, filePath: payload?.filePath, checkpointId: payload?.checkpointId },
					);
				} catch { /* command not registered — silently ignore */ }
			}
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _handleCheckpointAction failed:', err);
		}
	}

	private async _loadAvailableAgents(): Promise<void> {
		const t0 = performance.now();
		this._logService.debug(`[NativeChatEditorPane][Init] _loadAvailableAgents START`);
		try {
			const agents = await this._agentStudioService.getAgents();
			this._logService.debug(`[NativeChatEditorPane][Init] _loadAvailableAgents getAgents done count=${agents?.length ?? 0} t=${(performance.now() - t0).toFixed(1)}ms`);
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
			this._logService.info('[NativeChatEditorPane] _loadAvailableAgents failed:', err);
		}
	}

	// ---------- model selector wiring (mirrors chatBarPart.ts) ----------

	private async _refreshModelSelector(): Promise<void> {
		if (!this._chatPanel) {
			return;
		}
		const t0 = performance.now();
		this._logService.debug(`[NativeChatEditorPane][Init] _refreshModelSelector START`);
		try {
			const items = await this._modelSelector.getAvailableModels();
			this._logService.debug(`[NativeChatEditorPane][Init] _refreshModelSelector getAvailableModels done count=${items?.length ?? 0} t=${(performance.now() - t0).toFixed(1)}ms`);

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
			this._logService.info('[NativeChatEditorPane] _refreshModelSelector failed:', err);
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
				this._logService.info('[NativeChatEditorPane] _loadWorktrees: no workspaceId');
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
			this._logService.debug(`[NativeChatEditorPane] _loadWorktrees: loaded ${items.length} worktrees for workspace ${workspaceId}`);
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _loadWorktrees failed:', err);
			this._chatPanel.setWorktrees([]);
		}
	}

	/** 获取 worktree 列表（供 AgentChatPanel 的 onLoadWorktrees 回调使用） */
	private async _getWorktrees(): Promise<ReadonlyArray<{ path: string; branch: string; outgoingChanges?: number; incomingChanges?: number; uncommittedChanges?: number }>> {
		const workspaceId = this._agentStudioService.getActiveWorkspaceId() || this._currentWorkspaceId || undefined;
		if (!workspaceId) {
			this._logService.info('[NativeChatEditorPane] _getWorktrees: no workspaceId');
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
			this._logService.info('[NativeChatEditorPane] _getWorktrees failed:', err);
			return [];
		}
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof NativeChatEditorInput)) {
			this._logService.info('[NativeChatEditorPane] setInput: not a NativeChatEditorInput, skipping');
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

	// ─── File / Code helpers ──────────────────────────────────────────

	/**
	 * P0-3: Apply code — 对已有文件打开 diff 编辑器（原始 vs 新内容），
	 * 用户保存右侧编辑器 = 接受变更，关闭不保存 = 拒绝。
	 * 无 filePath 时打开 untitled 编辑器。回退到直接写入。
	 */
	private async _handleApplyCode(code: string, _language: string, filePath?: string): Promise<void> {
		try {
			if (filePath) {
				let resource: URI;
				if (this._isAbsolutePath(filePath)) {
					resource = URI.file(filePath);
				} else {
					const folders = this._workspaceContextService.getWorkspace().folders;
					if (folders.length === 0) {
						await this._editorService.openEditor({ resource: undefined, contents: code, options: { pinned: true } });
						return;
					}
					resource = URI.joinPath(folders[0].uri, filePath);
				}
				// 读取原始内容
				let originalContent: string;
				try {
					const fc = await this._fileService.readFile(resource);
					originalContent = fc.value.toString();
				} catch {
					// 文件不存在 → 直接创建
					await this._fileService.writeFile(resource, VSBuffer.fromString(code));
					await this._openFileInEditor(filePath);
					return;
				}
				if (originalContent === code) {
					await this._openFileInEditor(filePath);
					return;
				}
				// P0-3: 打开 diff 编辑器
				const fileName = filePath.split(/[\\/]/).pop() || filePath;
				// 使用 modelService 获取已打开文件的语言 ID（如果有）
				const existingModel = this._modelService.getModel(resource);
				const langId = _language || existingModel?.getLanguageId() || undefined;
				await this._editorService.openEditor({
					original: { resource },
					modified: { resource: undefined, contents: code, languageId: langId },
					label: `Apply: ${fileName}`,
					description: '保存右侧编辑器以接受变更',
					options: { pinned: true },
				} as any);
			} else {
				await this._editorService.openEditor({
					resource: undefined,
					contents: code,
					options: { pinned: true },
				});
			}
		} catch (err) {
			this._logService.error('[NativeChatEditorPane] _handleApplyCode failed:', err);
			// 回退：直接写入
			if (filePath) {
				try {
					const resource = URI.file(filePath);
					await this._fileService.writeFile(resource, VSBuffer.fromString(code));
					await this._openFileInEditor(filePath);
				} catch { /* ignore */ }
			}
		}
	}

	/**
	 * Open a file in the center editor area (first/leftmost group).
	 * Resolves relative paths against workspace folders.
	 */
	private async _openFileInEditor(filePath: string, lineNumber?: number): Promise<void> {
		try {
			let absPath = filePath;

			// Resolve relative paths against workspace folders
			if (!this._isAbsolutePath(absPath)) {
				const folders = this._workspaceContextService.getWorkspace().folders;
				for (const folder of folders) {
					const candidate = URI.joinPath(folder.uri, absPath);
					try {
						const stat = await this._fileService.stat(candidate);
						if (stat) {
							absPath = candidate.fsPath;
							break;
						}
					} catch {
						// File doesn't exist in this folder, try next
					}
				}
			}

			const resource = URI.file(absPath);
			const groups = this._editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];

			const selection = lineNumber && lineNumber > 0
				? { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 }
				: undefined;

			await this._editorService.openEditor({
				resource,
				options: {
					pinned: false,
					...(selection ? { selection } : {}),
				},
			}, targetGroup);
		} catch (err) {
			this._logService.error('[NativeChatEditorPane] _openFileInEditor failed:', err);
		}
	}

	private _isAbsolutePath(p: string): boolean {
		if (!p) { return false; }
		if (p.startsWith('/') || p.startsWith('\\\\')) { return true; }
		return /^[a-zA-Z]:[\\/]/.test(p);
	}

	/**
	 * P0-2: 搜索工作区文件——递归遍历 workspace folders，按文件名模糊匹配。
	 * 跳过 node_modules/.git/dist/out 等目录，限制深度 4 层 + 最多 200 个结果。
	 */
	private async _searchWorkspaceFiles(query: string): Promise<Array<{ path: string; name: string }>> {
		const results: Array<{ path: string; name: string }> = [];
		const q = query.toLowerCase();
		const MAX_RESULTS = 50;
		const MAX_DEPTH = 4;
		const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.codebuddy', '__pycache__', '.sarosworkspace']);

		const searchRecursive = async (uri: URI, depth: number): Promise<void> => {
			if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) { return; }
			try {
				const entry = await this._fileService.resolve(uri, { resolveMetadata: false });
				if (!entry.children) { return; }
				for (const child of entry.children) {
					if (results.length >= MAX_RESULTS) { return; }
					if (child.isDirectory) {
						if (SKIP_DIRS.has(child.name) || child.name.startsWith('.')) { continue; }
						await searchRecursive(child.resource, depth + 1);
					} else {
						if (child.name.toLowerCase().includes(q)) {
							// 路径相对于 workspace folder
							const wsFolder = this._workspaceContextService.getWorkspace().folders[0];
							const relPath = child.resource.fsPath.replace(wsFolder?.uri.fsPath ?? '', '').replace(/^[\\/]/, '');
							results.push({ name: child.name, path: relPath || child.name });
						}
					}
				}
			} catch { /* ignore permission errors */ }
		};

		const workspace = this._workspaceContextService.getWorkspace();
		for (const folder of workspace.folders) {
			await searchRecursive(folder.uri, 0);
		}
		return results;
	}

	/**
	 * 添加内容到聊天框作为附件（供外部命令调用）。
	 * 使用 addTextContext 而非 addFileContext，因为内容可能不是真实文件（如 Console Logs）。
	 */
	addContentToChat(name: string, content: string): void {
		this._chatPanel?.addTextContext(name, content);
	}

	/**
	 * P0-2: 读取文件内容并添加为聊天上下文附件。
	 */
	private async _addFileContextToChat(filePath: string): Promise<void> {
		try {
			let uri: URI;
			if (this._isAbsolutePath(filePath)) {
				uri = URI.file(filePath);
			} else {
				const folders = this._workspaceContextService.getWorkspace().folders;
				if (folders.length === 0) { return; }
				uri = URI.joinPath(folders[0].uri, filePath);
			}
			const content = await this._fileService.readFile(uri);
			const text = content.value.toString();
			// 文件过大时截断
			const maxSize = 100 * 1024; // 100KB
			const truncated = text.length > maxSize ? text.slice(0, maxSize) + '\n... (truncated)' : text;
			this._chatPanel?.addFileContext(filePath, truncated);
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _addFileContextToChat: failed to read file:', filePath, err);
		}
	}

	/**
	 * P1-1: 在集成终端中运行代码。
	 * 先聚焦/创建终端，然后通过 sendSequence 发送代码。
	 */
	private async _runInTerminal(code: string): Promise<void> {
		try {
			// 聚焦现有终端（如果不存在会自动创建）
			await this._commandService.executeCommand('workbench.action.terminal.focus');
			// 发送代码到终端
			await this._commandService.executeCommand('workbench.action.terminal.sendSequence', { text: code + '\n' });
		} catch (err) {
			this._logService.error('[NativeChatEditorPane] _runInTerminal failed:', err);
			// 回退：尝试创建新终端
			try {
				await this._commandService.executeCommand('workbench.action.terminal.new');
				await this._commandService.executeCommand('workbench.action.terminal.sendSequence', { text: code + '\n' });
			} catch (err2) {
				this._logService.error('[NativeChatEditorPane] _runInTerminal fallback failed:', err2);
			}
		}
	}

	/**
	 * P1-3: 获取编辑器当前选中的代码，添加为聊天上下文附件。
	 * 参考 Void SidebarChat 的 CodeSelection 上下文功能。
	 */
	private async _addEditorSelectionToChat(): Promise<void> {
		try {
			const codeEditor = this._editorService.activeTextEditorControl as any;
			if (!codeEditor || typeof codeEditor.getModel !== 'function') { return; }
			const model = codeEditor.getModel();
			if (!model) { return; }
			const selection = codeEditor.getSelection();
			if (!selection || selection.isEmpty) { return; }
			const selectedText = model.getValueInRange(selection);
			if (!selectedText.trim()) { return; }
			// 获取文件名
			const resource = model.uri;
			const fileName = resource?.path.split('/').pop() || 'selection';
			this._chatPanel?.addFileContext(`${fileName} (L${selection.startLineNumber}-${selection.endLineNumber})`, selectedText);
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _addEditorSelectionToChat: no active editor or selection:', err);
		}
	}

	/**
	 * Handle confirmation card button clicks (tool approval / denial).
	 * Updates the message to remove the confirmation card and dispatches
	 * the decision through the command service.
	 */
	private async _handleConfirmationAction(confirmationId: string, buttonId: string): Promise<void> {
		try {
			// Dispatch the tool approval decision. The chat service / tool
			// approval handler listens for this command and resolves the
			// pending approval promise, unblocking the agent loop.
			await this._commandService.executeCommand('agentStudio.confirmationAction', confirmationId, buttonId);
		} catch {
			// Command may not be registered in all configurations — that's OK,
			// the confirmation card is still dismissed in the UI.
		}
	}

	override dispose(): void {
		this._chatPanel = undefined;
		this._isInitialized = false;
		super.dispose();
	}
}
