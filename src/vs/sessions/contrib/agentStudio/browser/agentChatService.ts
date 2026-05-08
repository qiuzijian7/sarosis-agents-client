/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IAgentChatService, IChatStreamDelta, IChatSendOptions } from '../common/agentStudio.js';
import type { ChatMessage } from '../common/types.js';
import { AGENT_STUDIO_KNOT_TOKEN_SETTING, AGENT_STUDIO_KNOT_AGENT_ID_SETTING, AGENT_STUDIO_KNOT_BASE_URL_SETTING } from '../common/constants.js';

/**
 * AgentChatService implements Knot AG-UI protocol translation with 16ms frame throttling.
 * Migrated from sarosis-webui's /api/chat/knot/route.ts
 */
export class AgentChatService extends Disposable implements IAgentChatService {
	declare readonly _serviceBrand: undefined;

	private readonly _activeStreams = new Map<string, AbortController>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
	}

	async sendMessage(
		employeeId: string,
		message: string,
		options: IChatSendOptions,
		onDelta: (delta: IChatStreamDelta) => void,
	): Promise<ChatMessage> {
		// Cancel any existing stream for this employee
		this.cancelStream(employeeId);

		const controller = new AbortController();
		this._activeStreams.set(employeeId, controller);

		const token = this.configurationService.getValue<string>(AGENT_STUDIO_KNOT_TOKEN_SETTING);
		const agentId = this.configurationService.getValue<string>(AGENT_STUDIO_KNOT_AGENT_ID_SETTING);
		const baseUrl = this.configurationService.getValue<string>(AGENT_STUDIO_KNOT_BASE_URL_SETTING) || 'https://knot.woa.com';

		if (!token || !agentId) {
			throw new Error('Knot AG-UI token and agent ID must be configured');
		}

		const url = `${baseUrl}/api/v1/agents/${agentId}/chat`;

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${token}`,
				},
				body: JSON.stringify({
					message,
					model: options.model,
					systemPrompt: options.systemPrompt,
					temperature: options.temperature,
					stream: true,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(`Knot API error: ${response.status} ${response.statusText}`);
			}

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error('No response body');
			}

			const decoder = new TextDecoder();
			let fullContent = '';
			let fullThinking = '';
			let buffer = '';

			// Frame throttling: accumulate chunks and flush at 16ms intervals
			let pendingChunks: IChatStreamDelta[] = [];
			let flushTimer: ReturnType<typeof setInterval> | undefined;

			const startThrottle = () => {
				if (!flushTimer) {
					flushTimer = setInterval(() => {
						if (pendingChunks.length > 0) {
							// Flush all pending chunks in one batch
							for (const chunk of pendingChunks) {
								onDelta(chunk);
							}
							pendingChunks = [];
						}
					}, 16);
				}
			};

			const stopThrottle = () => {
				if (flushTimer) {
					clearInterval(flushTimer);
					flushTimer = undefined;
				}
				// Flush remaining
				if (pendingChunks.length > 0) {
					for (const chunk of pendingChunks) {
						onDelta(chunk);
					}
					pendingChunks = [];
				}
			};

			const pushDelta = (delta: IChatStreamDelta) => {
				pendingChunks.push(delta);
			};

			startThrottle();

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (!line.startsWith('data: ')) {
							continue;
						}
						const data = line.slice(6).trim();
						if (data === '[DONE]') {
							continue;
						}

						try {
							const event = JSON.parse(data);
							const eventType = event.type || event.event_type || '';

							// Translate AG-UI events to our protocol
							this._translateEvent(eventType, event, pushDelta, (text) => { fullContent += text; }, (thinking) => { fullThinking += thinking; });
						} catch {
							// Skip malformed JSON lines
						}
					}
				}
			} finally {
				stopThrottle();
			}

			// Send completion
			onDelta({ type: 'done' });

			// Build final ChatMessage
			const chatMessage: ChatMessage = {
				id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
				role: 'assistant',
				content: fullContent,
				employeeId,
				thinking: fullThinking || undefined,
				timestamp: new Date().toISOString(),
			};

			return chatMessage;

		} finally {
			this._activeStreams.delete(employeeId);
		}
	}

	/**
	 * Translate Knot AG-UI event types to our internal IChatStreamDelta protocol.
	 * Supports both UPPER_SNAKE_CASE and PascalCase formats.
	 */
	private _translateEvent(
		eventType: string,
		event: Record<string, unknown>,
		pushDelta: (delta: IChatStreamDelta) => void,
		appendContent: (text: string) => void,
		appendThinking: (text: string) => void,
	): void {
		const normalized = eventType.toUpperCase().replace(/([A-Z])/g, '_$1').replace(/^_/, '').replace(/__/g, '_');
		const content = (event.content || event.text || event.delta || '') as string;

		// Filter empty-like content
		if (content && this._isEmptyLikeContent(content)) {
			return;
		}

		switch (normalized) {
			case 'TEXT_MESSAGE_START':
			case 'TEXT_MESSAGE_CONTENT':
				if (content) {
					pushDelta({ type: 'text', content });
					appendContent(content);
				}
				break;

			case 'TEXT_MESSAGE_END':
				// No action needed, stream continues
				break;

			case 'THINKING_TEXT_MESSAGE_START':
			case 'THINKING_TEXT_MESSAGE_CONTENT':
				if (content) {
					pushDelta({ type: 'thinking', content });
					appendThinking(content);
				}
				break;

			case 'THINKING_TEXT_MESSAGE_END':
				break;

			case 'TOOL_CALL_START':
				pushDelta({
					type: 'tool_start',
					toolCallId: event.tool_call_id as string || event.id as string,
					toolName: event.tool_name as string || event.name as string,
				});
				break;

			case 'TOOL_CALL_ARGS':
				pushDelta({
					type: 'tool_args',
					content: content || event.args as string,
					toolCallId: event.tool_call_id as string || event.id as string,
				});
				break;

			case 'TOOL_CALL_END':
				pushDelta({
					type: 'tool_end',
					toolCallId: event.tool_call_id as string || event.id as string,
				});
				break;

			case 'TOOL_CALL_RESULT':
				pushDelta({
					type: 'tool_result',
					content: content || JSON.stringify(event.result),
					toolCallId: event.tool_call_id as string || event.id as string,
				});
				break;

			case 'RUN_STARTED':
			case 'STEP_STARTED':
			case 'STEP_FINISHED':
			case 'RUN_FINISHED':
				// Lifecycle events - log but don't push
				this.logService.debug(`[AgentStudio] Lifecycle: ${normalized}`);
				break;

			case 'RUN_ERROR':
				pushDelta({
					type: 'error',
					content: (event.error as string) || 'Unknown error',
				});
				break;

			default:
				this.logService.debug(`[AgentStudio] Unknown event: ${eventType}`);
		}
	}

	private _isEmptyLikeContent(content: string): boolean {
		const trimmed = content.trim();
		return trimmed === '{}' || trimmed === '[]' || trimmed === 'null' || trimmed === '""' || trimmed === "''";
	}

	async getHistory(_employeeId: string, _sessionId?: string): Promise<ChatMessage[]> {
		// TODO: Read from persisted chat history
		return [];
	}

	async clearHistory(_employeeId: string, _sessionId?: string): Promise<void> {
		// TODO: Clear persisted chat history
	}

	cancelStream(employeeId: string): void {
		const controller = this._activeStreams.get(employeeId);
		if (controller) {
			controller.abort();
			this._activeStreams.delete(employeeId);
		}
	}
}
