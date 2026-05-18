/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IToolProvider, IToolDefinition, IToolCall, IToolResult, IToolResultContent } from '../../../common/providers.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';

/**
 * Tool Provider 实现
 *
 * 管理工具注册和执行。支持：
 * 1. 内置工具注册（如 file_read, file_write, shell_exec）
 * 2. MCP Gateway 工具发现（后续实现）
 * 3. 插件注册的工具
 */
export class ToolProvider extends Disposable implements IToolProvider {

	readonly id: string = 'default-tool-provider';
	readonly name: string = 'Default Tool Provider';

	private readonly _onDidChangeTools: Emitter<void>;
	readonly onDidChangeTools: Event<void>;

	private readonly _logService: ILogService;

	/** 注册的工具定义 */
	private readonly _toolDefinitions = new Map<string, IToolDefinition>();

	/** 注册的工具处理器 */
	private readonly _toolHandlers = new Map<string, (args: Record<string, unknown>) => Promise<IToolResultContent[]>>();

	/** 被禁用的工具集合 */
	private readonly _disabledTools = new Set<string>();

	constructor(
		@ILogService logService: ILogService,
	) {
		super();

		this._onDidChangeTools = this._register(new Emitter<void>());
		this.onDidChangeTools = this._onDidChangeTools.event;
		this._logService = logService;

		// 注册内置工具
		this._registerBuiltinTools();
	}

	/**
	 * 注册一个工具
	 */
	registerTool(
		definition: IToolDefinition,
		handler: (args: Record<string, unknown>) => Promise<IToolResultContent[]>,
	): IDisposable {
		if (this._toolDefinitions.has(definition.name)) {
			this._logService.warn(`[ToolProvider] Tool ${definition.name} already registered, overwriting`);
		}

		this._toolDefinitions.set(definition.name, definition);
		this._toolHandlers.set(definition.name, handler);
		this._onDidChangeTools.fire();

		this._logService.info(`[ToolProvider] Registered tool: ${definition.name}`);

		return {
			dispose: () => {
				this._toolDefinitions.delete(definition.name);
				this._toolHandlers.delete(definition.name);
				this._onDidChangeTools.fire();
				this._logService.info(`[ToolProvider] Unregistered tool: ${definition.name}`);
			},
		};
	}

	async listTools(_agentId: string): Promise<IToolDefinition[]> {
		const out: IToolDefinition[] = [];
		for (const [name, def] of this._toolDefinitions) {
			if (this._disabledTools.has(name)) { continue; }
			out.push(def);
		}
		return out;
	}

	/**
	 * 获取所有工具定义（包括被禁用的，供 UI 显示）
	 */
	async getAllToolDefinitions(_agentId: string): Promise<IToolDefinition[]> {
		return Array.from(this._toolDefinitions.values());
	}

	/**
	 * 启用工具
	 */
	async enableTool(_agentId: string, toolName: string): Promise<void> {
		if (this._disabledTools.has(toolName)) {
			this._disabledTools.delete(toolName);
			this._onDidChangeTools.fire();
			this._logService.info(`[ToolProvider] Enabled tool: ${toolName}`);
		}
	}

	/**
	 * 禁用工具
	 */
	async disableTool(_agentId: string, toolName: string): Promise<void> {
		if (this._toolDefinitions.has(toolName) && !this._disabledTools.has(toolName)) {
			this._disabledTools.add(toolName);
			this._onDidChangeTools.fire();
			this._logService.info(`[ToolProvider] Disabled tool: ${toolName}`);
		}
	}

	/**
	 * 检查工具是否已启用
	 */
	async isToolEnabled(_agentId: string, toolName: string): Promise<boolean> {
		return !this._disabledTools.has(toolName);
	}

	/**
	 * 获取所有工具的启用状态
	 */
	async getToolsEnabledState(_agentId: string): Promise<Record<string, boolean>> {
		const state: Record<string, boolean> = {};
		for (const name of this._toolDefinitions.keys()) {
			state[name] = !this._disabledTools.has(name);
		}
		return state;
	}

	/**
	 * 批量设置工具的启用状态
	 */
	async setToolsEnabledState(_agentId: string, state: Record<string, boolean>): Promise<void> {
		let changed = false;
		for (const [name, enabled] of Object.entries(state)) {
			if (!this._toolDefinitions.has(name)) { continue; }
			const currentlyEnabled = !this._disabledTools.has(name);
			if (enabled && !currentlyEnabled) {
				this._disabledTools.delete(name);
				changed = true;
			} else if (!enabled && currentlyEnabled) {
				this._disabledTools.add(name);
				changed = true;
			}
		}
		if (changed) {
			this._onDidChangeTools.fire();
			this._logService.info(`[ToolProvider] Batch updated tool enabled state`);
		}
	}

	async executeTool(_agentId: string, toolCall: IToolCall): Promise<IToolResult> {
		const handler = this._toolHandlers.get(toolCall.name);
		if (!handler) {
			this._logService.warn(`[ToolProvider] No handler for tool: ${toolCall.name}`);
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: `Unknown tool: ${toolCall.name}`,
			};
		}

		try {
			this._logService.debug(`[ToolProvider] Executing tool: ${toolCall.name}`);
			const content = await handler(toolCall.arguments);
			return {
				toolCallId: toolCall.id,
				success: true,
				content,
			};
		} catch (error) {
			this._logService.error(`[ToolProvider] Tool ${toolCall.name} failed:`, error);
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [],
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	// ─── 内置工具 ─────────────────────────────────────

	private _registerBuiltinTools(): void {
		// Echo 工具 — 用于测试
		this.registerTool(
			{
				name: 'echo',
				description: 'Echo back the input text. Useful for testing tool execution.',
				inputSchema: {
					type: 'object',
					properties: {
						text: { type: 'string', description: 'Text to echo back' },
					},
					required: ['text'],
				},
				category: 'utility',
			},
			async (args) => {
				const text = String(args.text || '');
				return [{ type: 'text' as const, text }];
			},
		);

		// 当前时间工具
		this.registerTool(
			{
				name: 'get_current_time',
				description: 'Get the current date and time.',
				inputSchema: {
					type: 'object',
					properties: {
						timezone: { type: 'string', description: 'Timezone (e.g. UTC, Asia/Shanghai)' },
					},
				},
				category: 'utility',
			},
			async (args) => {
				const tz = String(args.timezone || 'local');
				const now = new Date();
				const text = tz === 'UTC'
					? now.toUTCString()
					: now.toLocaleString();
				return [{ type: 'text' as const, text: `Current time (${tz}): ${text}` }];
			},
		);
	}
}
