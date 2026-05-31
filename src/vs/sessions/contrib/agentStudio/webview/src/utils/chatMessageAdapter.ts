/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - ChatMessage Adapter
 *
 *  Converts IChatStreamDelta (from Host) to unified ChatMessage format (chatTypes.ts).
 *  Follows Void's approach: WebView works with unified ChatMessage format.
 *
 *  Usage:
 *    const builder = new ChatMessageBuilder();
 *    for (const delta of streamFromHost) { builder.handleDelta(delta); }
 *    const messages = builder.getMessages();
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage, AssistantMessage, ToolMessage, ToolMessageStatus, ThinkingBlock, ToolResult } from '../../../../common/chatTypes.js';
import type { IChatStreamDelta } from '../../../../common/providers.js';

/**
 * Builds ChatMessage[] from IChatStreamDelta stream.
 * This is the adapter that makes tool cards compatible with different message formats
 * (by normalizing to ChatMessage).
 */
export class ChatMessageBuilder {
	private readonly _messages: ChatMessage[] = [];
	private _currentText = '';
	private _currentThinking = '';
	private _currentAssistantIdx: number | null = null;

	constructor() {}

	handleDelta(delta: IChatStreamDelta): void {
		if (!delta) return;

		switch (delta.type) {
			case 'text':
				this._appendText(delta.content || '');
				break;
			case 'thinking':
				this._appendThinking(delta.content || '');
				break;
			case 'tool_start':
				this._startTool(delta.toolCallId || '', delta.toolName || 'unknown', delta);
				break;
			case 'tool_args':
				// tool_args contains partial JSON arguments
				// We don't update tool params here (args are assembled by host)
				break;
			case 'tool_end':
				this._endTool(delta.toolCallId || '', delta.success);
				break;
			case 'tool_result':
				this._setToolResult(delta.toolCallId || '', delta.content);
				break;
			case 'error':
				// Error handling - could create error message
				break;
			case 'done':
				// Stream complete - finalize
				this._finalize();
				break;
			default:
				// Ignore other delta types (references, progress, confirmation, etc.)
				break;
		}
	}

	getMessages(): ChatMessage[] {
		return this._messages;
	}

	reset(): void {
		this._messages.length = 0;
		this._currentText = '';
		this._currentThinking = '';
		this._currentAssistantIdx = null;
	}

	private _appendText(text: string): void {
		this._currentText += text;
		this._ensureAssistant();
	}

	private _appendThinking(thinking: string): void {
		this._currentThinking += thinking;
		this._ensureAssistant();
	}

	private _startTool(id: string, name: string, delta: IChatStreamDelta): void {
		// Create ToolMessage with status 'pending'
		// ToolMessage type: base & _ToolMessagePending
		const toolMsg: ToolMessage = {
			role: 'tool',
			id,
			name,
			params: {},
			rawParams: {},
			result: null,
			status: 'pending',
			timestamp: Date.now(),
			// _ToolMessagePending: status='pending', result=null (already satisfied)
		} as unknown as ToolMessage;

		this._messages.push(toolMsg);
	}

	private _endTool(id: string, success: boolean | undefined): void {
		// Find the tool message and update status
		const idx = this._messages.findIndex(m => m.role === 'tool' && m.id === id);
		if (idx >= 0 && success !== undefined) {
			const msg = this._messages[idx] as ToolMessage;
			// Create updated message (readonly - need to replace)
			const updated: ToolMessage = {
				...msg,
				status: (success ? 'success' : 'error') as ToolMessageStatus,
				result: success ? { content: [] as any } : null,
			} as unknown as ToolMessage;
			this._messages[idx] = updated;
		}
	}

	private _setToolResult(id: string, content: string | undefined): void {
		// Find the tool message and set result
		const idx = this._messages.findIndex(m => m.role === 'tool' && m.id === id);
		if (idx >= 0) {
			const msg = this._messages[idx] as ToolMessage;
			const updated: ToolMessage = {
				...msg,
				result: { content: [{ type: 'text', text: content || '' }] } as ToolResult,
			} as unknown as ToolMessage;
			this._messages[idx] = updated;
		}
	}

	private _ensureAssistant(): void {
		if (this._currentAssistantIdx === null) {
			// Create new assistant message
			const thinkingBlocks: ThinkingBlock[] = this._currentThinking
				? [{ type: 'thinking', thinking: this._currentThinking, signature: undefined }]
				: [];
			
			const msg: AssistantMessage = {
				role: 'assistant',
				content: this._currentText,
				reasoning: '',
				thinking: thinkingBlocks,
				timestamp: Date.now(),
			} as unknown as AssistantMessage;

			this._messages.push(msg);
			this._currentAssistantIdx = this._messages.length - 1;
		} else {
			// Update existing assistant message (need to replace, not mutate readonly)
			const existing = this._messages[this._currentAssistantIdx];
			if (existing && existing.role === 'assistant') {
				const thinkingBlocks: ThinkingBlock[] = this._currentThinking
					? [{ type: 'thinking', thinking: this._currentThinking, signature: undefined }]
					: [];
				
				const updated: AssistantMessage = {
					...existing as AssistantMessage,
					content: this._currentText,
					thinking: thinkingBlocks,
				} as unknown as AssistantMessage;
				this._messages[this._currentAssistantIdx] = updated;
			}
		}
	}

	private _finalize(): void {
		// Finalize any pending state
		// Could add completion metadata, etc.
	}
}

/**
 * Batch conversion helper (for non-streaming use cases).
 */
export function deltasToChatMessages(deltas: readonly IChatStreamDelta[]): ChatMessage[] {
	const builder = new ChatMessageBuilder();
	for (const delta of deltas) {
		builder.handleDelta(delta);
	}
	return builder.getMessages();
}
