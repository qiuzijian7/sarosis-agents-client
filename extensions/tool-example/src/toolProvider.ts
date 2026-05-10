/*---------------------------------------------------------------------------------------------
 *  Tool Example Provider - Shell Implementation
 *  Implements IToolProvider interface
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../src/vs/base/common/event.js';
import { Disposable } from '../../../../src/vs/base/common/lifecycle.js';
import { IToolProvider, IToolDefinition, IToolCall, IToolResult } from '../../../../src/vs/sessions/contrib/agentStudio/common/providers.js';

/**
 * Example Tool Provider - 提供基础工具（echo, time, etc.）
 */
export class ToolExampleProvider extends Disposable implements IToolProvider {
	readonly id = 'tool-example';
	readonly name = 'Tool Example';

	private readonly _tools: IToolDefinition[] = [
		{
			name: 'echo',
			description: 'Echo input text',
			inputSchema: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'Text to echo' }
				},
				required: ['text']
			},
			category: 'utility'
		},
		{
			name: 'get_time',
			description: 'Get current time',
			inputSchema: {
				type: 'object',
				properties: {}
			},
			category: 'utility'
		}
	];

	constructor() {
		super();
	}

	async listTools(agentId: string): Promise<IToolDefinition[]> {
		return this._tools;
	}

	async executeTool(agentId: string, toolCall: IToolCall): Promise<IToolResult> {
		try {
			if (toolCall.name === 'echo') {
				const text = toolCall.arguments['text'] as string || '';
				return {
					toolCallId: toolCall.id,
					success: true,
					content: [{ type: 'text', text: `Echo: ${text}` }]
				};
			}

			if (toolCall.name === 'get_time') {
				const now = new Date().toISOString();
				return {
					toolCallId: toolCall.id,
					success: true,
					content: [{ type: 'text', text: `Current time: ${now}` }]
				};
			}

			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: `Unknown tool: ${toolCall.name}`
			};
		} catch (err) {
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: err instanceof Error ? err.message : String(err)
			};
		}
	}
}
