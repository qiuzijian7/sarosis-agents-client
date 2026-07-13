/*---------------------------------------------------------------------------------------------
 *  AG-UI to ChatMessage adapter (minimal correct version)
 *
 *  Converts LanguageModelResponsePart (received from knot-agui extension)
 *  to unified ChatMessage format (following void project's approach).
 *
 *  This adapter is used in agentOSService.ts inside the streaming loop.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage, AssistantMessage } from '../chatTypes.js';

/**
 * Streaming converter: processes LanguageModelResponsePart one by one.
 *
 *  Usage:
 *    const stream = new AGUIChatMessageBuilder();
 *    for await (const part of streamFromProvider) { stream.handlePart(part); }
 *    const messages = stream.getMessages();
 */
export class AGUIChatMessageBuilder {
	private readonly _messages: ChatMessage[] = [];
	// P0-leak-fix: accumulate streamed text in chunk arrays, join once when
	// materializing the message. Per-delta `_currentText += text` built V8
	// ConsString ropes that were retained in the rendered chat history.
	private _textChunks: string[] = [];
	private _thinkingChunks: string[] = [];
	private _currentAssistantIdx: number | null = null;

	constructor() {}

	handlePart(part: any): void {
		if (!part) return;

		// Text part: part.type === 'text' (LanguageModelTextPart)
		if (part.type === 'text') {
			const text = part.value !== undefined ? part.value : part.text;
			if (text) {
				this._textChunks.push(text);
				this._ensureAssistant();
			}
			return;
		}

		// Thinking part: part.type === 'thinking' OR part.value starts with '[THINKING]'
		if (part.type === 'thinking' || (typeof part.value === 'string' && part.value.startsWith('[THINKING]'))) {
			const text = part.value !== undefined ? part.value.replace(/^\[THINKING\]/, '') : part.text || '';
			if (text) {
				this._thinkingChunks.push(text);
				this._ensureAssistant();
			}
			return;
		}

		// Tool call part: part.type === 'tool_call' OR part has .name
		if (part.type === 'tool_call' || part.name !== undefined) {
			const toolName = part.name || part.toolName || 'unknown';
			const toolCallId = part.id || part.toolCallId || `tool_${Date.now()}`;
			const args = typeof part.input === 'string' ? part.input : JSON.stringify(part.input || {});

			// Create ToolMessage (role: 'tool', status: 'pending')
			const toolMsg: ChatMessage = {
				role: 'tool',
				id: toolCallId,
				name: toolName,
				params: typeof part.input === 'object' ? part.input as Record<string, unknown> : {},
				rawParams: { [toolName]: args },
				result: null,
				status: 'pending',
				timestamp: Date.now(),
			};
			this._messages.push(toolMsg);
			return;
		}

		// Tool result part: part.value starts with '[TOOL_RESULT]'
		if (typeof part.value === 'string' && part.value.startsWith('[TOOL_RESULT]')) {
			// Simplified: just log, real handler needs toolCallId tracking
			console.log('[AGUIChatMessageBuilder] tool_result part received (simplified handler)');
			return;
		}
	}

	getMessages(): ChatMessage[] {
		return this._messages;
	}

	private _ensureAssistant(): void {
		const _text = this._textChunks.join('');
		const _think = this._thinkingChunks.join('');
		if (this._currentAssistantIdx === null) {
			// Create new assistant message
			const msg: AssistantMessage = {
				role: 'assistant',
				content: _text,
				reasoning: '',
				thinking: _think ? [{ type: 'thinking', thinking: _think, signature: undefined }] : [],
				timestamp: Date.now(),
			};
			this._messages.push(msg);
			this._currentAssistantIdx = this._messages.length - 1;
		} else {
			// Update existing assistant message (need to replace, not mutate readonly)
			const existing = this._messages[this._currentAssistantIdx];
			if (existing && existing.role === 'assistant') {
				// Create new object and replace (readonly properties can't be mutated)
				const updated: AssistantMessage = {
					...existing as AssistantMessage,
					content: _text,
					thinking: _think ? [{ type: 'thinking', thinking: _think, signature: undefined }] : [],
				};
				this._messages[this._currentAssistantIdx] = updated;
			}
		}
	}

	reset(): void {
		this._messages.length = 0;
		this._textChunks.length = 0;
		this._thinkingChunks.length = 0;
		this._currentAssistantIdx = null;
	}
}

/**
 * Batch conversion helper (for non-streaming use cases).
 */
export function aguiPartsToChatMessages(parts: readonly any[]): ChatMessage[] {
	const builder = new AGUIChatMessageBuilder();
	for (const part of parts) {
		builder.handlePart(part);
	}
	return builder.getMessages();
}
