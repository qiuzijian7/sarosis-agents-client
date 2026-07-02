/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import type { AgentChatPanel } from '../../../browser/agentChat/agentChatPanel.js';
import type { IAgentChatMessage, IContextUsage, IChatAttachment } from '../../../browser/agentChat/agentChatTypes.js';
import type { IChatStreamDelta } from '../common/agentStudio.js';

/**
 * Interface for the pane to provide services the handler needs.
 */
export interface IChatStreamHandlerCallbacks {
	readonly chatPanel: AgentChatPanel | undefined;
	readonly currentAgentId: string | null;
	readonly currentSessionId: string | null;
	readonly currentChatMode: string | undefined;
	readonly currentMaxContextTokens: number | undefined;
	ensureSession(): Promise<{ agentId: string; sessionId: string } | null>;
	onMessageUpdated(): void;
	saveCompactedBaseline(compacted: number): void;
}

/**
 * ChatStreamHandler — encapsulates the streaming send-message flow
 * (user message → assistant placeholder → delta updates → done/error).
 *
 * Extracted from NativeChatEditorPane to isolate the complex delta
 * switch-case (~500 lines) from the EditorPane lifecycle code.
 *
 * Usage:
 *   const handler = new ChatStreamHandler(chatService, logService);
 *   handler.setCallbacks(callbacks);
 *   await handler.sendMessage(text, explicitSkillIds, attachments);
 */
export class ChatStreamHandler extends Disposable {

	private _isSending = false;
	private _callbacks: IChatStreamHandlerCallbacks | undefined;

	constructor(
		private readonly _chatService: any, // IAgentChatService
		private readonly _logService: any, // ILogService
	) {
		super();
	}

	setCallbacks(callbacks: IChatStreamHandlerCallbacks): void {
		this._callbacks = callbacks;
	}

	get isSending(): boolean {
		return this._isSending;
	}

	/**
	 * Send a message and handle the streaming response.
	 * Creates user + assistant messages optimistically, then applies
	 * delta updates (text, thinking, tool calls, usage, memory, workflow).
	 */
	async sendMessage(text: string, explicitSkillIds?: string[], attachments?: IChatAttachment[]): Promise<void> {
		const cb = this._callbacks;
		if (!cb || !cb.chatPanel) { return; }
		const panel = cb.chatPanel;

		if (this._isSending) {
			this._logService.info('[ChatStreamHandler] already sending, ignoring duplicate');
			return;
		}

		const trimmed = (text ?? '').trim();
		if (!trimmed) { return; }

		const ensured = await cb.ensureSession();
		if (!ensured) { return; }
		const agentId = ensured.agentId;
		const sessionId = ensured.sessionId;

		// Inject attachments into message text
		let fullText = text;
		if (attachments && attachments.length > 0) {
			for (const att of attachments) {
				if (att.type === 'file') {
					const isText = att.mimeType.startsWith('text/') || att.mimeType === 'application/json';
					const content = isText ? att.data : `[binary file, ${att.size} bytes]`;
					fullText += `\n\n<file name="${att.name}">\n${content}\n</file>`;
				} else if (att.type === 'image') {
					fullText += `\n\n[image: ${att.name}]`;
				}
			}
		}

		// Optimistic user message
		const userMsg: IAgentChatMessage = {
			id: `msg_${Date.now()}_user`,
			role: 'user',
			content: fullText,
			timestamp: Date.now(),
		};
		panel.addMessage(userMsg);
		panel.setSending(true);
		this._isSending = true;

		// Assistant placeholder
		let assistantId: string | null = `msg_${Date.now()}_assistant`;
		let assistantMsg: IAgentChatMessage | null = {
			id: assistantId,
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			isStreaming: true,
			isThinking: true,
			streamPhase: 'llm_streaming',
			turnId: `turn_${Date.now()}`,
		};
		panel.addMessage(assistantMsg);
		let assistantAdded = true;

		const ensureAssistantMsg = () => {
			if (assistantAdded) { return; }
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
			panel.addMessage(assistantMsg);
			assistantAdded = true;
		};

		try {
			await this._chatService.sendMessage(
				agentId,
				fullText,
				{
					chatMode: cb.currentChatMode as any,
					agentSessionId: sessionId,
					explicitSkillIds,
				},
				(delta: IChatStreamDelta) => {
					if (!delta) { return; }

					// Re-activate streaming if inter-turn gap
					if (!this._isSending && (delta.type === 'text' || delta.type === 'thinking' || delta.type === 'tool_start' || delta.type === 'tool_result')) {
						panel.setSending(true);
						this._isSending = true;
					}

					switch (delta.type) {
						case 'text': {
							ensureAssistantMsg();
							if (!assistantMsg || !assistantId) { return; }
							const textContent = (delta as any).fullText !== undefined ? (delta as any).fullText : (assistantMsg.content + ((delta as any).content ?? ''));
							assistantMsg.content = textContent;
							panel.setStreamPhase('llm_streaming');
							panel.setStreamTextBuffer(textContent);
							panel.updateMessage(assistantId, {
								content: textContent,
								isStreaming: true,
								isThinking: false,
								streamPhase: 'llm_streaming',
							});
							break;
						}
						case 'thinking': {
							ensureAssistantMsg();
							if (!assistantMsg || !assistantId) { return; }
							const thinkingContent = (delta as any).fullThinking !== undefined ? (delta as any).fullThinking : ((assistantMsg.thinking ?? '') + ((delta as any).content ?? ''));
							assistantMsg.thinking = thinkingContent;
							panel.setStreamThinkingBuffer(thinkingContent);
							panel.updateMessage(assistantId, {
								thinking: thinkingContent,
								isThinking: true,
							});
							break;
						}
						case 'tool_start': {
							ensureAssistantMsg();
							if (!assistantMsg || !assistantId) { return; }
							if (!assistantMsg.toolCalls) { assistantMsg.toolCalls = []; }
							assistantMsg.toolCalls.push({
								id: (delta as any).toolCallId ?? `tool_${Date.now()}`,
								name: (delta as any).toolName ?? '',
								args: '',
								status: 'running',
								displayName: (delta as any).displayName,
								renderType: (delta as any).renderType,
								defaultShow: (delta as any).defaultShow,
								textPosition: typeof (delta as any).textPosition === 'number' ? (delta as any).textPosition : (assistantMsg.content?.length ?? 0),
							});
							panel.setStreamPhase('tool_executing');
							panel.updateMessage(assistantId, {
								toolCalls: assistantMsg.toolCalls.slice(),
								isStreaming: true,
								isThinking: false,
								streamPhase: 'tool_executing',
							});
							break;
						}
						case 'tool_args': {
							if (!assistantMsg || !assistantId) { return; }
							const argCall = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === (delta as any).toolCallId);
							if (argCall) {
								argCall.args = (argCall.args ?? '') + ((delta as any).content ?? '');
								panel.updateMessage(assistantId, {
									toolCalls: assistantMsg.toolCalls!.slice(),
									isStreaming: true,
									streamPhase: 'tool_executing',
								});
							}
							break;
						}
						case 'tool_end': {
							if (!assistantMsg || !assistantId) { return; }
							const endCall = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === (delta as any).toolCallId);
							if (endCall) {
								endCall.status = 'success';
								panel.setStreamPhase('llm_streaming');
								panel.updateMessage(assistantId, {
									toolCalls: assistantMsg.toolCalls!.slice(),
									isStreaming: true,
									isThinking: true,
									streamPhase: 'llm_streaming',
								});
							}
							break;
						}
						case 'tool_result': {
							if (!assistantMsg || !assistantId) { return; }
							const resultCall = (assistantMsg.toolCalls ?? []).find((tc: any) => tc.id === (delta as any).toolCallId);
							if (resultCall) {
								resultCall.result = (delta as any).content;
								if (resultCall.status === 'running') { resultCall.status = 'success'; }
								panel.updateMessage(assistantId, { toolCalls: assistantMsg.toolCalls!.slice() });
							}
							break;
						}
						case 'phase_change': {
							if ((delta as any).phase) {
								panel.setStreamPhase((delta as any).phase);
							}
							if ((delta as any).phase && assistantId) {
								panel.updateMessage(assistantId, {
									streamPhase: (delta as any).phase,
									isStreaming: (delta as any).phase !== 'idle',
								});
							}
							break;
						}
						case 'done': {
							if (!assistantAdded && assistantId === null) { ensureAssistantMsg(); }
							if (assistantMsg && assistantId) {
								if (assistantMsg.toolCalls) {
									for (const tc of assistantMsg.toolCalls) {
										if (tc.status === 'running') { tc.status = 'success'; }
									}
								}
								const durationMs = Date.now() - (assistantMsg.timestamp || Date.now());
								panel.setStreamPhase('idle');
								panel.updateMessage(assistantId, {
									toolCalls: assistantMsg.toolCalls ? assistantMsg.toolCalls.slice() : undefined,
									isStreaming: false,
									isThinking: false,
									streamPhase: 'idle',
									metadata: { ...(assistantMsg.metadata || {}), durationMs },
								});
							}
							panel.setSending(false);
							this._isSending = false;
							break;
						}
						case 'error': {
							if (!assistantAdded && assistantId === null) { ensureAssistantMsg(); }
							if (assistantId) {
								panel.setStreamPhase('error');
								panel.updateMessage(assistantId, {
									isStreaming: false,
									isThinking: false,
									streamPhase: 'error',
									content: ((assistantMsg?.content) || '') + `\n\n⚠️ ${typeof (delta as any).content === 'string' ? (delta as any).content : '执行失败'}`,
								});
							}
							panel.setSending(false);
							this._isSending = false;
							break;
						}
						case 'usage': {
							if ((delta as any).usage && assistantMsg && assistantId) {
								const input = (delta as any).usage.inputTokens ?? 0;
								const output = (delta as any).usage.outputTokens ?? 0;
								const total = (delta as any).usage.totalTokens ?? (input + output);
								const cachedRead = (delta as any).usage.cachedTokens ?? 0;
								const cacheWrite = (delta as any).usage.cacheWriteTokens ?? 0;
								const credit = (delta as any).usage.credit;
								const cacheMiss = Math.max(0, input - cachedRead - cacheWrite);
								const cacheHitRate = input > 0 ? (cachedRead / input) * 100 : 0;
								assistantMsg.tokenUsage = { input, output, total, cached: cachedRead || undefined, cachedRead: cachedRead || undefined, cacheWrite: cacheWrite || undefined, cacheMiss, reasoning: 0, cacheHitRate, credit };
								panel.updateMessage(assistantId, { tokenUsage: assistantMsg.tokenUsage });
								const limit = cb.currentMaxContextTokens ?? 0;
								if (limit > 0) {
									panel.setStreamUsage({
										input: (delta as any).usage.inputTokens ?? 0,
										output: (delta as any).usage.outputTokens ?? 0,
										seen: true,
									});
								}
							}
							break;
						}
						case 'context_compacted': {
							const compacted = (delta as any).compactedInputTokens ?? 0;
							if (compacted > 0) {
								panel.setCompactedBaseline(compacted);
								cb.saveCompactedBaseline(compacted);
							}
							const limit = cb.currentMaxContextTokens ?? 0;
							if (limit > 0 && compacted > 0) {
								const ratio = Math.max(0, Math.min(1, compacted / limit));
								panel.setContextUsage({
									used: compacted,
									limit,
									ratio,
									percent: ratio * 100,
								} as IContextUsage);
							}
							break;
						}
						case 'memory_extracted':
						case 'memory_writing':
						case 'memory_written':
						case 'memory_write_failed':
						case 'memory_injected':
						case 'skill_extracted':
							// Memory/skill delta handling delegated to AgentChatPanel
							// via addMemoryNotice / updateMemoryNotice / removeMemoryNotice
							// These are handled by the panel's internal delta processor.
							break;
						default:
							break;
					}
				},
			);
		} catch (err) {
			this._logService.error('[ChatStreamHandler] sendMessage failed:', err);
			panel.setSending(false);
			this._isSending = false;
		}
	}

	/** Cancel the current stream. */
	cancelStream(): void {
		const cb = this._callbacks;
		if (!cb || !cb.currentAgentId) { return; }
		this._chatService.cancelStream(cb.currentAgentId, cb.currentSessionId ?? undefined);
		cb.chatPanel?.setSending(false);
		this._isSending = false;
	}

	override dispose(): void {
		super.dispose();
	}
}
