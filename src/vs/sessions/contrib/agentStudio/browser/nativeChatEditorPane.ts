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

import { NativeChatEditorInput, type IChatRuntimeState, type ChatTabStatus } from './nativeChatEditorInput.js';
import { WorkflowTraceController } from './workflowTraceController.js';
import { CheckpointManager } from './checkpointManager.js';
import { CompressionDetailEditorInput } from './compressionDetailEditorInput.js';
import { MemoryDetailEditorInput } from './memoryDetailEditorInput.js';
import { MemoryDetailEditorPane } from './memoryDetailEditorPane.js';
import { CodebaseMemoryDetailEditorInput } from './codebaseMemoryDetailEditorInput.js';
import { AgentSettingsEditorInput } from './agentSettingsEditorInput.js';
import { AgentChatPanel } from '../../../browser/agentChat/agentChatPanel.js';
import { XtermCliPanel } from '../../../browser/agentChat/xtermTui/xtermCliPanel.js';
import type { IChatPanel } from '../../../browser/agentChat/iChatPanel.js';
import { IAgentStudioService, IAgentChatService, ChatMode } from '../../../common/agentStudioService.js';
import { ITaskOrchestrationService } from '../../../common/agentStudioService.js';
import { IModelSelectorService } from '../common/modelSelector.js';
import { ICheckpointService } from '../common/checkpointService.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { UrlPreviewEditorInput } from './urlPreviewEditorInput.js';
import type { AgentStatus as AgentChatAgentStatus, IProviderInfo as IPanelProviderInfo, IModelInfo as IPanelModelInfo, IAgentSessionMeta, IAgentChatMessage, IContextUsage, IChatAttachment } from '../../../browser/agentChat/agentChatTypes.js';
import { adaptPersistedChatMessage } from '../../../browser/agentChat/agentChatTypes.js';
import type { ChatMessage } from '../../../common/agentStudioTypes.js';
// OrchestrationPlan import removed — task orchestration entry point closed
import * as DOM from '../../../../base/browser/dom.js';
import { clearNode } from '../../../../base/browser/dom.js';

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
	/** 多实例计数器（仅调试用），每个 pane 创建时自增。 */
	private static _nextPaneId = 1;

	private _container: HTMLElement | undefined;
	private _chatPanel: IChatPanel | undefined;
	/** 多实例调试：每个 pane 的唯一标识（递增计数器），用于日志区分。 */
	private readonly _paneId: number = NativeChatEditorPane._nextPaneId++;
	private _isInitialized = false;
	private _defaultAgentSelected = false;
	private _currentAgentId: string | null = null;
	private _currentAgentSkills: string[] = [];
	private _currentSessionId: string | null = null;
	private _currentChatMode: ChatMode | undefined = undefined;
	private _currentWorkspaceId: string | null = null;
	private _isSending = false;
	private _currentMaxContextTokens: number | undefined;
	/**
	 * Whether this pane's editor tab is currently the active (focused) tab
	 * in its group. Tracked via {@link IEditorGroup.onDidActiveEditorChange}.
	 *
	 * Drives the "pending" → "idle" transition: when execution finishes while
	 * the tab is not active, the status dot turns white (pending) to signal
	 * unread results; activating the tab clears it to idle.
	 */
	private _isTabActive = false;
	/** Reusable streaming-send function, captured from the panel's onSendMessage. */
	private _sendMessageInternal!: (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[]) => Promise<void>;
	/**
	 * Async race guard: incremented before each `_selectAndLoadAgent` call.
	 * Only the latest generation's result is applied — stale loads are silently discarded.
	 * Prevents rapid tab switches from causing agent/session cross-talk.
	 */
	private _loadGeneration = 0;
	/** Workflow trace controller — manages live workflow execution state. */
	private _workflowTrace: WorkflowTraceController | undefined;
	/** Checkpoint manager — refresh bar and handle actions. */
	private _checkpointMgr: CheckpointManager | undefined;

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
		this._logService.debug(`[NativeChatEditorPane#${this._paneId}] createEditor`);
		// 首次进入时从 input 获取 chatId（setInput 会随后被调用确认）
		if (this.input instanceof NativeChatEditorInput) {
			this._currentInputChatId = this.input.chatId;
		}
		NativeChatEditorPane._injectTabStatusStyles();
		const t0 = performance.now();
		this._logService.debug(`[NativeChatEditorPane][Init] createEditor START t=${t0.toFixed(0)}ms`);
		this._container = document.createElement('div');
		this._container.classList.add('native-chat-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		parent.appendChild(this._container);

		this._initChatPanel();
		this._logService.debug(`[NativeChatEditorPane][Init] createEditor END t=${(performance.now() - t0).toFixed(1)}ms`);
	}

	/**
	 * Inject the chat tab status-dot CSS exactly once into the document head.
	 *
	 * The dot is rendered via a `::before` pseudo-element on the tab label,
	 * whose classes come from {@link NativeChatEditorInput.getLabelExtraClasses}.
	 * VS Code applies those classes to the `.monaco-icon-label` inside each
	 * `.tab` element, so the selector scopes the dot to chat tabs only.
	 */
	private static _tabStatusStylesInjected = false;
	private static _injectTabStatusStyles(): void {
		if (NativeChatEditorPane._tabStatusStylesInjected) { return; }
		NativeChatEditorPane._tabStatusStylesInjected = true;
		const style = document.createElement('style');
		style.id = 'native-chat-tab-status-dot';
		style.textContent = `
/* Chat editor tab status indicator dot.
   The status classes are emitted by NativeChatEditorInput.getLabelExtraClasses()
   and applied by VS Code to the .monaco-icon-label inside each editor tab.
   VS Code also uses that label's ::before pseudo-element for codicon icons,
   so we force a solid dot with explicit reset of font/icon properties. */
.tabs-container .tab .monaco-icon-label.chat-tab-status::before,
.tabs-container .tab .chat-tab-status::before {
	content: '' !important;
	display: inline-block !important;
	font-family: inherit !important;
	font-size: 0 !important;
	font-weight: normal !important;
	line-height: 7px !important;
	text-decoration: none !important;
	border: 0 !important;
	outline: 0 !important;
	padding: 0 !important;
	margin: 0 6px 0 2px !important;
	width: 7px !important;
	min-width: 7px !important;
	max-width: 7px !important;
	height: 7px !important;
	min-height: 7px !important;
	max-height: 7px !important;
	aspect-ratio: 1 / 1 !important;
	border-radius: 50% !important;
	vertical-align: middle !important;
	background: transparent !important;
	flex: 0 0 7px !important;
	align-self: center !important;
	box-sizing: border-box !important;
	overflow: hidden !important;
}
/* Running — green, pulsing */
.tabs-container .tab .monaco-icon-label.chat-tab-status-running::before,
.tabs-container .tab .chat-tab-status-running::before {
	background: #3fb950 !important;
	box-shadow: 0 0 4px rgba(63, 185, 80, 0.6) !important;
	animation: chat-tab-status-pulse 1.4s ease-in-out infinite !important;
}
/* Error — red */
.tabs-container .tab .monaco-icon-label.chat-tab-status-error::before,
.tabs-container .tab .chat-tab-status-error::before {
	background: #f85149 !important;
	box-shadow: 0 0 4px rgba(248, 81, 73, 0.5) !important;
}
/* Pending (finished, unread) — white/gray */
.tabs-container .tab .monaco-icon-label.chat-tab-status-pending::before,
.tabs-container .tab .chat-tab-status-pending::before {
	background: #d6deeb !important;
	opacity: 0.85 !important;
}
@keyframes chat-tab-status-pulse {
	0%, 100% { opacity: 1; transform: scale(1); }
	50% { opacity: 0.45; transform: scale(0.8); }
}
`;
		document.head.appendChild(style);
	}

	private _initChatPanel(): void {
		if (this._isInitialized || !this._container) {
			return;
		}
		const t0 = performance.now();
		this._logService.debug(`[NativeChatEditorPane][Init] _initChatPanel START`);

		// Choose panel type based on cliMode.
		// - XtermCliPanel: xterm.js-based TUI rendering (true terminal emulator)
		// - AgentChatPanel: rich bubble UI (default)
		// Both implement IChatPanel so the rest of the pane code is agnostic.
		const useCliPanel = this.input instanceof NativeChatEditorInput && this.input.cliMode;
		const PanelCtor = useCliPanel ? XtermCliPanel : AgentChatPanel;
		this._chatPanel = this._register(new PanelCtor({
			onSendMessage: (this._sendMessageInternal = async (text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[]) => {
				// 注：防重入逻辑已下移到 AgentChatPanel._handleSendMessage（流式时入队，非流式时直接发送）
				// 此处不再拦截，让 Panel 的队列机制处理并发发送。
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

							// Inter-turn safety net: 如果 _isSending 因某种原因被置 false
							// （如错误、取消、或 done 之后），当新一轮 agent loop 真正有
							// 交互性 delta 到来时，重新激活 sending 状态，确保按钮显示
							// stop 图标、输入框禁用、流式滚动路径生效。
							if (!this._isSending) {
								const reActivateTypes = ['text', 'thinking', 'tool_start', 'tool_args', 'tool_end', 'tool_result', 'phase_change'];
								if (reActivateTypes.includes(delta.type)) {
									this._chatPanel?.setSending(true);
									this._isSending = true;
								}
							}

							switch (delta.type) {
								case 'text':
									// First text delta → ensure assistant message exists, then update
									ensureAssistantMsg();
									if (!assistantMsg || !assistantId) return;
									const textContent = delta.fullText !== undefined ? delta.fullText : (assistantMsg.content + (delta.content ?? ''));
									assistantMsg.content = textContent;
									this._applyStreamPhase('llm_streaming');
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
									this._applyStreamPhase('tool_executing');
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
										this._applyStreamPhase('llm_streaming');
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
										this._applyStreamPhase(delta.phase);
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
									this._applyStreamPhase('idle');
									this._chatPanel?.updateMessage(assistantId, {
										toolCalls: assistantMsg.toolCalls ? assistantMsg.toolCalls.slice() : undefined,
										isStreaming: false,
										isThinking: false,
										streamPhase: 'idle',
										metadata: { ...(assistantMsg.metadata || {}), durationMs },
									});
								}
								// done handler 不再调用 setSending(false)——
								// sending 在整个 agent loop 期间保持 true。
								// 仅当 loop 完成时才置 false（await sendMessage 之后）。
								break;
							}
							case 'error':
									// Ensure assistant msg exists to show error state
									if (!assistantAdded && assistantId === null) {
										ensureAssistantMsg();
									}
									if (assistantId) {
										this._applyStreamPhase('error');
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
					// Agent loop fully completed (not per-turn) — reset sending state
					this._chatPanel?.setSending(false);
					this._isSending = false;
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
					// Cancel workflow if active (delegated to controller)
					this._workflowTrace?.cancelExecution();
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
				this._logService.debug(`[NativeChatEditorPane#${this._paneId}] onSelectAgent (dropdown): agentId=${agentId} _currentAgentId=${this._currentAgentId}`);
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
		onGetAgentSkills: () => {
			return this._currentAgentSkills;
		},
		onAddSkill: async (skillId: string) => {
			if (!this._currentAgentId) { return; }
			if (this._currentAgentSkills.includes(skillId)) { return; }
			const newSkills = [...this._currentAgentSkills, skillId];
			await this._agentStudioService.updateAgent(this._currentAgentId, { skills: newSkills } as any);
			this._currentAgentSkills = newSkills;
		},
		onRemoveSkill: async (skillId: string) => {
			if (!this._currentAgentId) { return; }
			const newSkills = this._currentAgentSkills.filter(s => s !== skillId);
			await this._agentStudioService.updateAgent(this._currentAgentId, { skills: newSkills } as any);
			this._currentAgentSkills = newSkills;
		},
		onOpenHtmlPreview: () => {
			// 打开 agent 的 config.html 文件（检查并创建默认文件，用文本编辑器打开）
			if (!this._currentAgentId) {
				this._logService.info('[NativeChatEditorPane] onOpenHtmlPreview: no agent selected');
				return;
			}
			(async () => {
				try {
					const agentId = this._currentAgentId!;
					const agentDir = await this._agentStudioService.getAgentDir(agentId);
					const configHtmlUri = URI.joinPath(agentDir, 'config.html');

					// 检查 config.html 是否存在，不存在则创建默认文件
					if (!(await this._fileService.exists(configHtmlUri))) {
						const safeName = agentId.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
						const defaultHtml = `<!DOCTYPE html>
<html lang="zh-CN" data-template-edit-mode="slots">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeName} · Panel</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    line-height: 1.6;
    color: #1f2328;
    background: #ffffff;
    padding: 40px 28px;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  .lead { color: #57606a; margin: 0 0 28px; }
  .card {
    border: 1px solid #d0d7de;
    border-radius: 10px;
    padding: 20px 22px;
    margin: 14px 0;
  }
  .card h2 { font-size: 17px; margin: 0 0 6px; }
  .card p { margin: 0; color: #424a53; }
</style>
</head>
<body>
  <div class="wrap">
    <h1 data-edit-slot data-slot-type="text">${safeName} 的面板</h1>
    <p class="lead" data-edit-slot data-slot-type="text">在 AI 中描述你想要的页面，或直接编辑这段 HTML。</p>
    <div class="card">
      <h2 data-edit-slot data-slot-type="text">开始使用</h2>
      <p data-edit-slot data-slot-type="text">这是一个零依赖、可在浏览器内编辑的单文件 HTML 文档。</p>
    </div>
  </div>
</body>
</html>
`;
						await this._fileService.createFolder(agentDir);
						await this._fileService.writeFile(configHtmlUri, VSBuffer.fromString(defaultHtml));
						this._logService.info(`[NativeChatEditorPane] Created default config.html for agent ${agentId}`);
					}

					// 在中心（中间栏）的文本编辑器中打开 config.html
					// GroupsOrder.GRID_APPEARANCE[0] 对应中间栏主编辑器组
					const centerGroup = this._editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE)[0];
					await this._editorService.openEditor({ resource: configHtmlUri }, centerGroup);
					this._logService.info(`[NativeChatEditorPane] Opened config.html for agent ${agentId} in center editor group`);
				} catch (err) {
					this._logService.error('[NativeChatEditorPane] onOpenHtmlPreview failed:', err);
				}
			})();
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
					// 持久化 session 到 input（拖拽到新 group 时恢复用）
					if (this.input instanceof NativeChatEditorInput && this._currentAgentId) {
						this.input.setAgentInfo(this.input.name, this._currentAgentId, session.id);
					}
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
					this._logService.debug(`[NativeChatEditorPane] onOpenSession: switched to session ${sessionId}`);
					// 持久化 session 到 input（拖拽到新 group 时恢复用）
					if (this.input instanceof NativeChatEditorInput && this._currentAgentId) {
						this.input.setAgentInfo(this.input.name, this._currentAgentId, sessionId);
					}
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
							if (this.input instanceof NativeChatEditorInput) {
								this.input.setAgentInfo(this.input.name, agentId, sessions[0].id);
							}
							try {
								const history = await this._chatService.getHistory(agentId, this._currentSessionId);
								this._chatPanel?.setMessages(this._adaptHistoryMessages(history));
							} catch {
								this._chatPanel?.setMessages([]);
							}
							this._activateCheckpointSession(agentId, this._currentSessionId);
					} else {
						this._currentSessionId = null;
						if (this.input instanceof NativeChatEditorInput) {
							this.input.setAgentInfo(this.input.name, agentId, null);
						}
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
			// 工作区选择器回调
			onLoadWorkspaces: async () => {
				await this._loadWorkspaces();
				// 返回已加载的工作区列表（供 panel 下拉框渲染）
				return this._agentStudioService.getWorkspaces().then(workspaces =>
					workspaces.filter(ws => ws.path).map(ws => ({
						id: ws.id,
						name: ws.name,
						path: ws.path!,
					}))
				);
			},
			/** 切换工作区 → 仅更新面板本地状态，不影响全局活跃工作区（侧边栏等） */
			onSelectWorkspace: async (workspaceId: string, _workspaceName: string) => {
				this._currentWorkspaceId = workspaceId;
				// NOTE: 不调用 setActiveWorkspace() —— 保持聊天面板的工作区独立于侧边栏
				// 清空旧 worktree 并重新加载新 workspace 的 worktree 列表
				this._chatPanel?.setWorktrees([]);
				this._chatPanel?.setSelectedWorktree('');
				await this._loadWorktrees();
				this._logService.debug(`[NativeChatEditorPane] onSelectWorkspace: switched to ${workspaceId}`);
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
				// Optimistically mark the AskUser as answered, then resume the paused workflow.
				// Both are delegated to the WorkflowTraceController, which owns the
				// _askUsers state and the live-workflow message refresh.
				this._workflowTrace?.markAskUserAnswered(askUserId, selection);
				this._workflowTrace?.resumeExecution(executionId, selection).catch(err => {
					this._logService.error('[NativeChatEditorPane] Failed to resume workflow:', err);
					// Rollback optimistic update on failure.
					this._workflowTrace?.rollbackAskUser(askUserId);
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

		// 主动调用一次 panel.layout()，确保面板使用正确的容器尺寸初始化
		// （xterm TUI 需要根据容器高度计算内部布局）
		if (this._container) {
			const rect = this._container.getBoundingClientRect();
			this._chatPanel.layout(rect.width, rect.height);
		}

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
			input.fromAgentChat = true; // 标记从聊天框跳转，仅显示当前 agent 数据
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
		// 多实例核心修复：仅在 pane 首次初始化且无 agent 时响应全局 onDidSelectAgent。
		// 已有 agent 的 pane 忽略全局事件——agent 切换通过自己的 dropdown 回调
		// (onSelectAgent → _selectAndLoadAgent) 处理，避免预设面板点击导致所有 pane 同步切换。
		this._register(this._agentStudioService.onDidSelectAgent(async (agentId) => {
			this._logService.debug(`[NativeChatEditorPane#${this._paneId}] onDidSelectAgent: agentId=${agentId} _currentAgentId=${this._currentAgentId}`);
			// 已有 agent 加载完成的 pane 忽略全局事件
			if (this._currentAgentId) {
				return;
			}
			if (!agentId) {
				this._chatPanel?.setAgent(null);
				return;
			}
			await this._selectAndLoadAgent(agentId);
		}));

		// Orchestration plan listeners removed — task orchestration entry point is closed.

		// Listen for streaming deltas from task execution / external sendMessage calls.
		// When the pane's agent matches, sync sending state (disable send button during
		// task execution) and reload history when the stream completes.
		this._register(this._chatService.onDidStreamDelta(({ agentId, delta }) => {
			if (agentId !== this._currentAgentId) { return; }
			if (!this._chatPanel) { return; }
			// Update sending state based on stream lifecycle
			if (delta.type === 'done' || delta.type === 'error') {
				this._chatPanel.setSending(false);
				// Reload history to show all messages from the completed stream
				void this._selectAndLoadAgent(this._currentAgentId!);
			} else if (delta.type === 'phase_change') {
				const phase = (delta as any).phase as string;
				this._chatPanel.setSending(phase !== 'idle');
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
		// NOTE: 移除 agentStudio:workspace-changed 监听器 ——
		// 聊天面板的 workspace 独立于侧边栏全局活跃工作区。
		// 聊天面板仅通过自身的 workspace 下拉框切换，不跟随外部变更。

		// Track whether this pane's editor tab is the active (focused) tab in
		// its group. Used to decide the pending→idle transition of the tab
		// status dot: a finished run leaves a white "pending" dot only when
		// the user has not yet activated the tab; activating it clears it.
		this._isTabActive = this.group.activeEditor === this.input;
		this._register(this.group.onDidActiveEditorChange((e) => {
			const nowActive = e.editor === this.input;
			if (nowActive === this._isTabActive) { return; }
			this._isTabActive = nowActive;
			// User just focused the tab → clear any unread "pending" dot.
			if (nowActive && this.input instanceof NativeChatEditorInput) {
				if (this.input.getTabStatus() === 'pending') {
					this.input.setTabStatus('idle');
				}
			}
		}));

		// ── Initialize extracted controllers ────────────────────────────
		// Checkpoint manager — encapsulates refresh + action logic
		this._checkpointMgr = this._register(new CheckpointManager(
			this._checkpointService, this._commandService,
		));
		this._register(this._checkpointService.onDidCreateCheckpoint((cp) => {
			if (cp.agentId === this._currentAgentId && cp.sessionId === this._currentSessionId) {
				void this._checkpointMgr?.refreshBar(this._chatPanel, this._currentAgentId, this._currentSessionId);
			}
		}));

		// Workflow trace controller — manages live workflow execution state
		this._workflowTrace = this._register(new WorkflowTraceController(
			this._workflowExecutionService, this._chatService, this._logService,
		));
		const pane = this;
		this._workflowTrace.start({
			get chatPanel() { return pane._chatPanel; },
			get currentAgentId() { return pane._currentAgentId; },
			get currentSessionId() { return pane._currentSessionId; },
			onWorkflowAgentChanged: (agentId, sessionId) => {
				pane._currentAgentId = agentId;
				pane._currentSessionId = sessionId;
			},
			onWorkflowEnded: () => {
				pane._isSending = false;
			},
			adaptHistoryMessages: (history) => pane._adaptHistoryMessages(history),
			activateCheckpointSession: (agentId, sessionId) => pane._activateCheckpointSession(agentId, sessionId),
			refreshSessionList: () => pane._refreshSessionList(),
		});

		this._logService.debug('[NativeChatEditorPane] Chat panel initialized');
	}

	// _scheduleDeltaRefresh and _refreshLiveWorkflowMessage have been moved to
	// WorkflowTraceController. The pane now delegates workflow trace events to
	// this._workflowTrace via start() in _initChatPanel().

	private async _selectAndLoadAgent(agentId: string): Promise<void> {
		const t0 = performance.now();
		const gen = ++this._loadGeneration;
		this._logService.debug(`[NativeChatEditorPane#${this._paneId}] _selectAndLoadAgent: agentId=${agentId} gen=${gen}`);
		try {
			const emp = await this._agentStudioService.getAgent(agentId);
			this._logService.debug(`[NativeChatEditorPane][Init] getAgent done t=${(performance.now() - t0).toFixed(1)}ms`);
			if (emp && this._chatPanel) {
				// Race guard: if a newer load was initiated, discard this stale result.
				if (gen !== this._loadGeneration) {
					this._logService.info(`[NativeChatEditorPane] _selectAndLoadAgent: gen=${gen} superseded by gen=${this._loadGeneration}, discarding`);
					return;
				}
				this._currentAgentId = agentId;
				this._currentAgentSkills = emp.skills ?? [];
				this._logService.debug(`[NativeChatEditorPane#${this._paneId}] _selectAndLoadAgent: setting _currentAgentId to ${agentId}`);
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
				// 窗口重载恢复：优先使用 input 上的 sessionId
				const restoredSessionId = (this.input instanceof NativeChatEditorInput) ? this.input.sessionId : undefined;
				let session: IAgentSessionMeta;
				if (restoredSessionId) {
					// 尝试查找恢复的 session
					const allSessions = await this._chatService.listAgentSessions(agentId);
					const restored = allSessions.find(s => s.id === restoredSessionId);
					if (restored) {
						session = restored;
						this._logService.info(`[NativeChatEditorPane] _selectAndLoadAgent: restored session ${session.id} from editor input`);
					} else {
						session = await this._chatService.getOrCreateActiveSession(agentId);
					}
				} else {
					this._logService.debug(`[NativeChatEditorPane][Init] calling getOrCreateActiveSession t=${(performance.now() - t0).toFixed(1)}ms`);
					session = await this._chatService.getOrCreateActiveSession(agentId);
				}
					// Race guard after async: discard if a newer load superseded this one.
					if (gen !== this._loadGeneration) {
						this._logService.info(`[NativeChatEditorPane] _selectAndLoadAgent: gen=${gen} superseded after getOrCreateActiveSession, discarding`);
						return;
					}
				this._currentSessionId = session.id;
				// 持久化 agentId + sessionId 到 input，窗口重载恢复时使用
				if (this.input instanceof NativeChatEditorInput) {
					this.input.setAgentInfo(emp.name, agentId, session.id);
				}
				this._logService.debug(`[NativeChatEditorPane][Init] getOrCreateActiveSession done session=${session.id} t=${(performance.now() - t0).toFixed(1)}ms`);

					// Load history messages for this session
					try {
						this._logService.debug(`[NativeChatEditorPane][Init] calling getHistory t=${(performance.now() - t0).toFixed(1)}ms`);
						const history = await this._chatService.getHistory(agentId, this._currentSessionId);
						// Race guard after async history load
						if (gen !== this._loadGeneration) {
							this._logService.info(`[NativeChatEditorPane] _selectAndLoadAgent: gen=${gen} superseded after getHistory, discarding`);
							return;
						}
						this._logService.debug(`[NativeChatEditorPane][Init] getHistory done count=${history?.length ?? 0} t=${(performance.now() - t0).toFixed(1)}ms`);
						// Yield to event loop: let the input box render and become
						// interactive BEFORE the heavy synchronous setMessages call
						// (which blocks ~1.4s for 259 messages).
						const adapted = this._adaptHistoryMessages(history);
						await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
						// Final race guard after rAF yield
						if (gen !== this._loadGeneration) {
							this._logService.info(`[NativeChatEditorPane] _selectAndLoadAgent: gen=${gen} superseded after rAF, discarding`);
							return;
						}
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
				await this._loadWorkspaces();
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
	/**
	 * 活跃 chat 变化时的处理：重载聊天面板的消息历史。
	 *
	 * - 同一 agent 下的多 chat 切换：仅重载消息，不切换 agent
	 * - 新建 chat（untitled）：清空面板 + 聚焦输入框
	 * - 首次激活：不触发（避免与 _initChatPanel 的初始加载冲突）
	 */
	/** 公共入口：聚焦聊天输入框（供 preset 点击聊天按钮后聚焦用）。 */
	focusInput(): void {
		this._chatPanel?.focusInput();
	}

	// ─── Tab status indicator helpers ──────────────────────────────────

	/**
	 * Apply a stream phase to BOTH the chat panel UI and the editor tab
	 * status dot. Wraps {@link AgentChatPanel.setStreamPhase} so every phase
	 * transition also updates {@link NativeChatEditorInput.setTabStatus}.
	 *
	 * Mapping:
	 *  - llm_streaming / tool_executing → 'running' (green)
	 *  - error                          → 'error'   (red)
	 *  - idle                           → 'pending' if tab not active, else 'idle'
	 */
	private _applyStreamPhase(phase: string): void {
		this._chatPanel?.setStreamPhase(phase as any);
		this._updateTabStatusForPhase(phase);
	}

	/**
	 * Recompute the tab status dot from a stream phase. Called on every
	 * phase transition (live deltas + state restore on tab switch).
	 */
	private _updateTabStatusForPhase(phase: string): void {
		if (!(this.input instanceof NativeChatEditorInput)) { return; }
		let status: ChatTabStatus;
		switch (phase) {
			case 'llm_streaming':
			case 'tool_executing':
				status = 'running';
				break;
			case 'error':
				status = 'error';
				break;
			case 'idle':
				// Execution finished: white "pending" dot if the user hasn't
				// viewed the tab yet; otherwise clear to idle.
				status = this._isTabActive ? 'idle' : 'pending';
				break;
			default:
				return; // unknown phase, leave current status unchanged
		}
		this.input.setTabStatus(status);
	}

	private async _ensureSession(): Promise<{ agentId: string; sessionId: string } | null> {
		const agentId = this._currentAgentId ?? 'claw';
		let sessionId = this._currentSessionId ?? undefined;
		if (!sessionId) {
			try {
				const session = await this._chatService.getOrCreateActiveSession(agentId);
				sessionId = session.id;
				this._currentSessionId = sessionId;
				if (this.input instanceof NativeChatEditorInput) {
					this.input.setAgentInfo(this.input.name, agentId, sessionId);
				}
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
		// Delegated to CheckpointManager
		await this._checkpointMgr?.refreshBar(this._chatPanel, this._currentAgentId, this._currentSessionId);
	}

	private async _handleCheckpointAction(action: 'undoAll' | 'keepAll' | 'openDiff', payload?: { filePath?: string; checkpointId?: string }): Promise<void> {
		try {
			// Delegated to CheckpointManager
			await this._checkpointMgr?.handleAction(this._chatPanel, this._currentAgentId, this._currentSessionId, action, payload);
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

			// 默认选中 agent（多级 fallback）：
			//   1. 窗口重载恢复的 input.agentId（优先）
			//   2. id / presetId 完全等于 'saros-claw' / 'claw'
			//   3. id / presetId / name / role 不区分大小写包含 'claw'
			//   4. 上面都没匹配到 → 列表第一个 agent
			if (!this._defaultAgentSelected && agents.length > 0) {
				const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '');
				const matchExact = (a: any) => a.id === 'saros-claw' || a.id === 'claw' || (a as any).presetId === 'claw' || (a as any).presetId === 'saros-claw';
				const matchFuzzy = (a: any) => lower(a.id).includes('claw') || lower((a as any).presetId).includes('claw') || lower(a.name).includes('claw') || lower(a.role).includes('claw');

				// 1. 窗口重载恢复的 agentId 优先
				const restoredAgentId = (this.input instanceof NativeChatEditorInput) ? this.input.agentId : undefined;
				let target: any | undefined;
				if (restoredAgentId) {
					target = agents.find(a => a.id === restoredAgentId || (a as any).presetId === restoredAgentId);
					if (target) {
						this._logService.info(`[NativeChatEditorPane] _loadAvailableAgents: restoring agent "${target.id}" from editor input`);
					}
				}

				// 2-4. claw 精确/模糊/fallback
				if (!target) {
					target = agents.find(matchExact) ?? agents.find(matchFuzzy) ?? agents[0];
				}

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
					// 与 _resolveContextWindow 对齐：maxInputTokens 是单次请求的上限，
				// maxAllowedSize 是 input+output 总量，不应作为分母（会使进度条百分比虚低）。
				maxInputTokens: it.model.maxInputTokens ?? it.model.contextWindow ?? it.model.maxAllowedSize,
					supportsImages: it.model.supportsImages,
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
				this._currentMaxContextTokens = matched?.model.maxInputTokens
					?? matched?.model.contextWindow
					?? matched?.model.maxAllowedSize
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
			// 优先使用面板本地 workspace，若为空则从全局活跃工作区继承（仅首次加载）
			const workspaceId = this._currentWorkspaceId || this._agentStudioService.getActiveWorkspaceId() || undefined;
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

	/** 加载工作区列表（供 AgentChatPanel 的 onLoadWorkspaces 回调使用） */
	private async _loadWorkspaces(): Promise<void> {
		if (!this._chatPanel) { return; }
		try {
			const workspaces = await this._agentStudioService.getWorkspaces();
			const items = workspaces
				.filter(ws => ws.path) // 过滤掉没有路径的 legacy 虚拟工作区
				.map(ws => ({
					id: ws.id,
					name: ws.name,
					path: ws.path!,
				}));
			this._chatPanel.setWorkspaces(items);
			// 设置当前选中的工作区：优用面板本地状态，若为空则从全局活跃工作区继承（仅首次加载）
			if (!this._currentWorkspaceId) {
				this._currentWorkspaceId = this._agentStudioService.getActiveWorkspaceId() || null;
			}
			const activeId = this._currentWorkspaceId || (items.length > 0 ? items[0].id : '');
			if (activeId) {
				this._chatPanel.setSelectedWorkspace(activeId);
			}
			this._logService.debug(`[NativeChatEditorPane] _loadWorkspaces: loaded ${items.length} workspaces, active=${activeId}`);
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _loadWorkspaces failed:', err);
		}
	}

	/** 获取 worktree 列表（供 AgentChatPanel 的 onLoadWorktrees 回调使用） */
	private async _getWorktrees(): Promise<ReadonlyArray<{ path: string; branch: string; outgoingChanges?: number; incomingChanges?: number; uncommittedChanges?: number }>> {
		const workspaceId = this._currentWorkspaceId || this._agentStudioService.getActiveWorkspaceId() || undefined;
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

	/** 当前 setInput 正在处理的 chatId（用于防止重复切换）。 */
	private _currentInputChatId: string | undefined;

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this._logService.debug(`[NativeChatEditorPane#${this._paneId}] setInput: type=${input.constructor.name}, resource=${input.resource?.toString()}`);
		await super.setInput(input, options, context, token);

		if (!(input instanceof NativeChatEditorInput)) {
			this._logService.info('[NativeChatEditorPane] setInput: not a NativeChatEditorInput, skipping');
			return;
		}

		if (token.isCancellationRequested) {
			return;
		}

		const newChatId = input.chatId;

		// 同一个 chatId，无需切换
		if (newChatId === this._currentInputChatId) {
			this._logService.debug(`[NativeChatEditorPane#${this._paneId}] setInput: same chatId, skipping state switch`);
			return;
		}

		this._logService.info(`[NativeChatEditorPane#${this._paneId}] setInput: chatId=${newChatId} (prev=${this._currentInputChatId})`);

		// ── 1. 保存当前 chat 的运行时状态到旧的 input ──
		// VS Code 复用同一个 EditorPane，面板的 messages/streamPhase/isSending
		// 属于 pane 而非 chat。切换前必须存到 input 上，切回时恢复。
		this._saveCurrentRuntimeState();

		// ── 2. 切换到新 chat ──
		this._currentInputChatId = newChatId;

		// 从 NativeChatEditorInput 恢复状态（单一真相源）
		this._currentSessionId = input.sessionId ?? null;

		// ── 3. 恢复新 chat 的运行时状态 ──
		const saved = input.getRuntimeState();
		if (saved) {
			// 有保存的运行时状态 → 直接恢复，无需服务器 round-trip
			this._logService.info(`[NativeChatEditorPane#${this._paneId}] setInput: restoring runtime state (msgs=${saved.messages.length}, phase=${saved.streamPhase})`);

			this._currentAgentId = input.agentId ?? null;
			this._defaultAgentSelected = saved.agentLoaded;

			// 恢复此 tab 保存的 model selection（每个 tab 独立切换 model）
			// 全局 IModelSelectorService 是单例，切换 tab 时需要恢复该 tab 的选择
			if (saved.modelSelection) {
				this._modelSelector.setSelection(saved.modelSelection);
			}

			// 恢复 agent 显示（如有）
			if (input.agentId) {
				void this._restoreAgentDisplay(input.agentId, saved);
			} else {
				// 无 agent → 加载默认
				this._defaultAgentSelected = false;
				this._loadAvailableAgents();
			}
		} else {
			// 无运行时状态 → 首次加载或拖拽到新 group
			if (input.agentId) {
				this._currentAgentId = input.agentId;
				this._defaultAgentSelected = true;
				void this._selectAndLoadAgent(input.agentId);
			} else {
				this._defaultAgentSelected = false;
				this._loadAvailableAgents();
			}
		}

		// The chat panel is already initialized in createEditor.
		// Re-entering setInput (e.g. after a group move) just needs to ensure
		// the panel element is in the container.
		if (this._chatPanel && this._container && !this._container.contains(this._chatPanel.element)) {
			this._container.appendChild(this._chatPanel.element);
		}

		// Sync CLI mode from the input — each tab remembers its own CLI mode.
		// If the cliMode differs from the currently active panel type, swap panels.
		this._syncPanelType(input.cliMode);
	}

	/**
	 * Ensure the active panel matches the desired cliMode. If the current
	 * panel type doesn't match (e.g. switching from a rich tab to a CLI tab),
	 * save state → dispose old panel → create new panel → restore state.
	 *
	 * Called from setInput() when switching tabs and from toggleCliMode()
	 * when the user explicitly toggles CLI mode.
	 */
	private _syncPanelType(desiredCliMode: boolean): void {
		if (!this._chatPanel) { return; }
		const currentIsCli = this._chatPanel instanceof XtermCliPanel;
		if (currentIsCli === desiredCliMode) { return; }

		// Save runtime state
		const messages = this._chatPanel.getMessages();
		const agent = this._chatPanel.getAgent();
		const streamPhase = (this._chatPanel as any)?._streamPhase ?? 'idle';
		const isSending = this._isSending;

		// Dispose old panel
		this._chatPanel.dispose();
		this._chatPanel = undefined;
		this._isInitialized = false;

		if (this._container) {
			clearNode(this._container);
		}

		// Create new panel
		this._initChatPanel();

		// Restore state — capture panel reference locally. Use type assertion
		// because TypeScript's control-flow analysis narrows `this._chatPanel`
		// to `never` after the `= undefined` assignment above, even though
		// `_initChatPanel()` creates a new panel internally.
		const newPanel = this._chatPanel as IChatPanel | undefined;
		if (newPanel) {
			if (agent) {
				newPanel.setAgent(agent);
			}
			newPanel.setMessages(messages);
			newPanel.setStreamPhase(streamPhase as any);
			if (isSending) {
				newPanel.setSending(true);
			}
			// 主动调用一次 layout()，确保新创建的 xterm panel 正确布局
			// 修复：从 web 切换到 CLI 时的空白问题
			if (this._container) {
				const rect = this._container.getBoundingClientRect();
				newPanel.layout(rect.width, rect.height);
			}
			newPanel.focusInput();
		}

		// Re-populate provider/model lists
		void this._refreshModelSelector();
	}

	/**
	 * 保存当前面板的运行时状态到当前 input 上。
	 * 在 setInput 切换到新 chat 之前调用，确保流式消息、思考状态等不丢失。
	 */
	private _saveCurrentRuntimeState(): void {
		if (!this._currentInputChatId) { return; }
		const currentInput = this.input;
		if (!(currentInput instanceof NativeChatEditorInput)) { return; }

		// 从 _chatPanel 读取当前状态
		const messages = this._chatPanel?.getMessages() ?? [];
		const streamPhase = (this._chatPanel as any)?._streamPhase ?? 'idle';
		const isSending = (this._chatPanel as any)?._isSending ?? false;

		// 保存当前 tab 的 model selection（全局单例 IModelSelectorService 的当前值）
		const modelSel = this._modelSelector.getSelection();

		currentInput.saveRuntimeState({
			messages: [...messages],  // shallow copy
			streamPhase,
			isSending,
			agentLoaded: this._defaultAgentSelected,
			modelSelection: modelSel ? { ...modelSel } : undefined,
		});

		this._logService.debug(`[NativeChatEditorPane#${this._paneId}] saved runtime state for ${this._currentInputChatId}: msgs=${messages.length}, phase=${streamPhase}`);
	}

	/**
	 * 从保存的运行时状态恢复面板显示（不触发服务器请求）。
	 * 用于 tab 切换时快速恢复消息列表 + 流式状态。
	 */
	private async _restoreAgentDisplay(agentId: string, saved: IChatRuntimeState): Promise<void> {
		const gen = ++this._loadGeneration;
		try {
			const emp = await this._agentStudioService.getAgent(agentId);
			if (gen !== this._loadGeneration) { return; }  // race guard
			if (emp && this._chatPanel) {
				this._currentAgentId = agentId;
				this._currentAgentSkills = emp.skills ?? [];
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
				if (this.input instanceof NativeChatEditorInput) {
					this.input.setAgentInfo(emp.name, emp.id);
				}

				// 恢复保存的消息（含流式占位符）
				if (saved.messages.length > 0) {
					this._chatPanel.setMessages(saved.messages as any);
				}

				// 恢复流式状态
				this._isTabActive = this.group.activeEditor === this.input;
				this._applyStreamPhase(saved.streamPhase);
				if (saved.isSending) {
					this._chatPanel.setSending(true);
					this._isSending = true;
				}

				// 加载 workspace + worktree + session 列表（轻量，不阻塞渲染）
				void this._loadWorkspaces().then(() => void this._loadWorktrees());
				void this._refreshSessionList();

				// 聚焦输入框
				this._chatPanel.focusInput();
			}
		} catch (err) {
			this._logService.info('[NativeChatEditorPane] _restoreAgentDisplay failed:', err);
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = '100%';
		}
		// Propagate layout to the active chat panel so that
		// panel-specific layout (e.g. xterm TUI height recalculation)
		// runs when the editor is resized or the panel type changes.
		if (this._chatPanel) {
			this._chatPanel.layout(dimension.width, dimension.height);
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
	 * Toggle CLI-style mode on the current chat tab.
	 *
	 * Instead of toggling a CSS class on the existing panel, this method
	 * **swaps the entire panel implementation**: it saves the current
	 * runtime state (messages, stream phase, sending flag), disposes the
	 * old panel, creates a new one of the opposite type (AgentChatPanel ↔
	 * CliChatEditorPanel), and restores the state into it. This keeps the
	 * CLI rendering logic completely isolated from the rich bubble UI.
	 */
	toggleCliMode(): void {
		if (!(this.input instanceof NativeChatEditorInput)) { return; }
		const next = !this.input.cliMode;
		this.input.setCliMode(next);
		this._syncPanelType(next);
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
