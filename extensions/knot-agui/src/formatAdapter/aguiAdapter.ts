/*---------------------------------------------------------------------------------------------
 *  AG-UI format adapter — moved from inline logic in extension.ts
 *  Handles AG-UI protocol events and converts them to VS Code LanguageModelResponsePart.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

// ============================================================================
// SkipSignal — marks events that should be skipped (not reported to progress)
// ============================================================================

export class SkipSignal {
	static readonly instance = new SkipSignal();
	private constructor() {}
}

// ============================================================================
// AGUIParser
// ============================================================================

export class AGUIParser {
	/**
	 * Accumulated in-progress tool calls (keyed by toolCallId).
	 * Moved from KnotChatProvider._pendingToolCalls.
	 */
	private readonly _pendingToolCalls = new Map<string, { name: string; argsBuffer: string }>();

	/**
	 * Reset state (call when starting a new chat request).
	 */
	reset(): void {
		this._pendingToolCalls.clear();
	}

	/**
	 * Parse an AG-UI event and return a LanguageModelResponsePart (to report via progress),
	 * a SkipSignal (event handled, skip), or undefined (event ignored / unknown).
	 */
	parseEvent(event: Record<string, unknown>): vscode.LanguageModelResponsePart | SkipSignal | undefined {
		const eventType = String(event.type ?? event.event_type ?? '').toUpperCase().replace(/-/g, '_');
		const rawEvent = (event.rawEvent ?? {}) as Record<string, unknown>;

		// Tool-call lifecycle events (START / ARGS / END / RESULT)
		const toolCallResult = this._handleToolCallEvent(eventType, rawEvent, event);
		if (toolCallResult === SkipSignal.instance) {
			return SkipSignal.instance;
		} else if (toolCallResult) {
			// toolCallResult is LanguageModelResponsePart (from TOOL_CALL_END)
			return toolCallResult;
		}

		// Lifecycle / heartbeat events — silently ignore
		if (this._isLifecycleOrHeartbeat(eventType)) {
			return SkipSignal.instance;
		}

		// Text / thinking content events
		return this._translateEvent(eventType, rawEvent, event);
	}

	// --------------------------------------------------------------------------
	// Private: tool-call lifecycle
	// --------------------------------------------------------------------------

	private _handleToolCallEvent(
		normalizedType: string,
		rawEvent: Record<string, unknown>,
		event: Record<string, unknown>,
	): vscode.LanguageModelResponsePart | SkipSignal | undefined {
		switch (normalizedType) {
			case 'TOOL_CALL_START':
			case 'TOOLCALLSTART': {
				const callId = this._getString(['toolCallId', 'tool_call_id', 'id'], rawEvent, event);
				const toolName = this._getString(['toolCallName', 'name', 'tool_name'], rawEvent, event);
				this._pendingToolCalls.set(callId, { name: toolName, argsBuffer: '' });
				console.log(`[AGUIParser] Tool call started: ${toolName} (id=${callId})`);
				return SkipSignal.instance;
			}
			case 'TOOL_CALL_ARGS':
			case 'TOOLCALLARGS': {
				const callId = this._getString(['toolCallId', 'tool_call_id', 'id'], rawEvent, event);
				const pending = callId ? this._pendingToolCalls.get(callId) : undefined;
				if (pending) {
					const argsDelta = this._getString(['delta', 'args', 'arguments'], rawEvent, event);
					pending.argsBuffer += argsDelta;
				}
				return SkipSignal.instance;
			}
			case 'TOOL_CALL_END':
			case 'TOOLCALLEND': {
				const callId = this._getString(['toolCallId', 'tool_call_id', 'id'], rawEvent, event);
				const pending = callId ? this._pendingToolCalls.get(callId) : undefined;
				if (pending) {
					let parameters: any = {};
					try {
						// Clean noise tokens before parsing
						const cleaned = this._cleanModelText(pending.argsBuffer || '{}');
						parameters = JSON.parse(cleaned);
					} catch {
						parameters = { _raw_args: pending.argsBuffer };
					}

					// Add _meta so the bridge can extract display metadata and server_executed flag
					if (typeof parameters === 'object' && parameters !== null) {
						const isPhantom = PHANTOM_TOOL_NAMES.has(pending.name.toLowerCase());
						parameters._meta = {
							server_executed: true,
							display_name: pending.name,
							render_type: isPhantom ? 'none' : 'CodeApply',
							default_show: !isPhantom,
						};
					}

					const result = new vscode.LanguageModelToolCallPart(callId, pending.name, parameters);
					this._pendingToolCalls.delete(callId);
					console.log(`[AGUIParser] Tool call emitted: ${pending.name} (id=${callId})`);
					return result;
				} else {
					console.log(`[AGUIParser] Tool call ended (no pending call for id=${callId})`);
					return SkipSignal.instance;
				}
			}
			case 'TOOL_CALL_RESULT':
			case 'TOOLCALLRESULT': {
				const callId = this._getString(['toolCallId', 'tool_call_id', 'id'], rawEvent, event);
				console.log(`[AGUIParser] Tool call result received for id=${callId})`);
				return SkipSignal.instance;
			}
			default:
				return undefined;
		}
	}

	// --------------------------------------------------------------------------
	// Private: lifecycle / heartbeat detection
	// --------------------------------------------------------------------------

	private _isLifecycleOrHeartbeat(normalizedType: string): boolean {
		switch (normalizedType) {
			case 'HEARTBEAT':
			case 'STEP_STARTED':
			case 'STEPSTARTED':
			case 'STEP_FINISHED':
			case 'STEPFINISHED':
			case 'RUN_STARTED':
			case 'RUNSTARTED':
			case 'RUN_FINISHED':
			case 'RUNFINISHED':
			case 'RUN_ERROR':
			case 'RUNERROR':
				return true;
			default:
				return false;
		}
	}

	// --------------------------------------------------------------------------
	// Private: translate text / thinking events
	// --------------------------------------------------------------------------

	private _translateEvent(
		normalized: string,
		rawEvent: Record<string, unknown>,
		event: Record<string, unknown>,
	): vscode.LanguageModelResponsePart | undefined {
		// Get content from rawEvent (AG-UI protocol standard location)
		let content: string = '';
		if (rawEvent.content != null) {
			content = String(rawEvent.content);
		} else if (event.delta != null) {
			content = String(event.delta);
		}

		content = this._cleanModelText(content);

		switch (normalized) {
			case 'TEXT_MESSAGE_CONTENT':
			case 'TEXTMESSAGECONTENT':
				if (content) {
					return new vscode.LanguageModelTextPart(content);
				}
				return undefined;

			case 'THINKING_TEXT_MESSAGE_CONTENT':
			case 'THINKINGTEXTMESSAGECONTENT':
				// Thinking content: prepend [THINKING] marker for bridge layer
				if (content) {
					return new vscode.LanguageModelTextPart('[THINKING]' + content);
				}
				return undefined;

			case 'TEXT_MESSAGE_START':
			case 'TEXTMESSAGESTART':
			case 'TEXT_MESSAGE_END':
			case 'TEXTMESSAGEEND':
			case 'THINKING_TEXT_MESSAGE_START':
			case 'THINKINGTEXTMESSAGESTART':
			case 'THINKING_TEXT_MESSAGE_END':
			case 'THINKINGTEXTMESSAGEEND':
				// Text message lifecycle events: ignore
				return undefined;

			default:
				// Unknown event type — log and try to return content as text
				console.log(`[AGUIParser] _translateEvent: unhandled type='${normalized}'`);
				if (content && content.length > 0 && content !== '{}') {
					return new vscode.LanguageModelTextPart(content);
				}
				return undefined;
		}
	}

	// --------------------------------------------------------------------------
	// Private: helpers
	// --------------------------------------------------------------------------

	/**
	 * Get string value from rawEvent/event using a list of possible keys.
	 * Falls back to empty string if not found.
	 */
	private _getString(keys: string[], rawEvent: Record<string, unknown>, event: Record<string, unknown>): string {
		for (const key of keys) {
			const val = rawEvent[key] ?? event[key];
			if (val != null) {
				return String(val);
			}
		}
		return '';
	}

	/**
	 * Clean noise tokens (⊙, <|startoftext|>, <|endoftext|>, <think>, </think> etc.) from model output.
	 */
	private _cleanModelText(content: string): string {
		if (!content) {
			return content;
		}
		return content
			.replace(/⊙/g, '')
			.replace(/<\|(?:start|end)(?:oftext|ofthought)\|>/g, '')
			.replace(/<\|[^|]+\|>/g, '')
			.replace(/<\/?think\s*>/g, '');
	}
}

// ============================================================================
// Constants (moved from extension.ts)
// ============================================================================

/**
 * Tool names that are phantom / UI-indicator tools (render_type="none").
 * These tools signal a state change (e.g. "planning in progress") but
 * should NOT be rendered as visible tool-call cards in the chat UI.
 */
const PHANTOM_TOOL_NAMES = new Set([
	'task_planning',
	'taskplanning',
	'plan_task',
	'plan_tasks',
	'task_plan',
	'planning',
]);
