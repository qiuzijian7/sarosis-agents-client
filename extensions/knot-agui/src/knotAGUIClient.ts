/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Knot AG-UI 协议客户端
 * 
 * 封装 AG-UI SSE 流式调用和事件转换逻辑。
 * 从 agentChatService 迁移而来，独立为可复用的客户端类。
 */

export class KnotAGUIClient {
	private readonly _token: string;
	private readonly _endpoint: string;
	private readonly _logService: any;

	constructor(options: { token: string; endpoint: string; logService?: any }) {
		this._token = options.token;
		this._endpoint = options.endpoint;
		this._logService = options.logService || console;
	}

	/**
	 * 发起 AG-UI 流式运行
	 * @param agentId - Agent ID（即 modelId）
	 * @param options - 运行选项（messages, systemPrompt, temperature 等）
	 * @returns 异步可迭代流，产生 IModelDelta 事件
	 */
	async *streamRun(agentId: string, options: {
		messages?: { role: string; content: string }[];
		model?: string;
		systemPrompt?: string;
		temperature?: number;
	}): AsyncGenerator<any> {
		const url = `${this._endpoint}/agents/${agentId}/chat`;

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this._token}`,
			},
			body: JSON.stringify({
				message: options.messages?.[options.messages.length - 1]?.content || '',
				model: options.model,
				systemPrompt: options.systemPrompt,
				temperature: options.temperature,
				stream: true,
			}),
		});

		if (!response.ok) {
			yield { type: 'error', content: `Knot API error: ${response.status} ${response.statusText}` };
			return;
		}

		const reader = response.body?.getReader();
		if (!reader) {
			yield { type: 'error', content: 'No response body' };
			return;
		}

		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const data = line.slice(6).trim();
					if (data === '[DONE]') continue;

					try {
						const event = JSON.parse(data);
						const delta = this._translateEvent(event);
						if (delta) yield delta;
					} catch {
						// Skip malformed JSON lines
					}
				}
			}
		} finally {
			yield { type: 'done' };
		}
	}

	/**
	 * 将 AG-UI 事件转换为 IModelDelta
	 */
	private _translateEvent(event: Record<string, unknown>): any | null {
		const eventType = (event.type || event.event_type || '').toString();
		const content = (event.content || event.text || event.delta || '').toString();

		// Filter empty-like content
		const trimmed = content.trim();
		if (trimmed === '{}' || trimmed === '[]' || trimmed === 'null' || trimmed === '""' || trimmed === "''") {
			return null;
		}

		const normalized = eventType.toUpperCase().replace(/([A-Z])/g, '_$1').replace(/^_/, '').replace(/__/g, '_');

		switch (normalized) {
			case 'TEXT_MESSAGE_START':
			case 'TEXT_MESSAGE_CONTENT':
				if (content) return { type: 'text', content };
				break;

			case 'THINKING_TEXT_MESSAGE_START':
			case 'THINKING_TEXT_MESSAGE_CONTENT':
				if (content) return { type: 'thinking', content };
				break;

			case 'TOOL_CALL_START':
				return {
					type: 'tool_call',
					toolCall: {
						id: (event.tool_call_id || event.id || '').toString(),
						name: (event.tool_name || event.name || '').toString(),
						arguments: '',
					},
				};

			case 'TOOL_CALL_ARGS':
				return {
					type: 'tool_call',
					toolCall: {
						id: (event.tool_call_id || event.id || '').toString(),
						name: '',
						arguments: content,
					},
				};

			case 'TOOL_CALL_END':
				return { type: 'done' };  // Simplified

			case 'TOOL_CALL_RESULT':
				return {
					type: 'done',  // Simplified - tool results are handled differently in new architecture
				};

			case 'RUN_ERROR':
				return { type: 'error', content: (event.error || 'Unknown error').toString() };

			default:
				this._logService?.debug?.(`[KnotAGUIClient] Unknown event: ${eventType}`);
				return null;
		}

		return null;
	}

	/**
	 * 重新加载配置
	 */
	reloadConfiguration(token: string, endpoint: string): void {
		this._token = token;
		this._endpoint = endpoint;
	}
}
