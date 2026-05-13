/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IToolProvider, IToolDefinition, IToolCall, IToolResult, IToolResultContent
} from '../../../src/vs/sessions/contrib/agentStudio/common/providers.js';
import { BaseProviderAdapter, IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { HermesBridge } from './hermesBridge.js';

/**
 * Hermes Tool Provider
 *
 * Bridges hermes-agent's ToolRegistry (70+ tools) to the IToolProvider interface.
 * Tools are discovered by querying the hermes-agent bridge process, which
 * auto-discovers tools from the tools/ directory based on enabled toolsets
 * and environment variables.
 *
 * Tool Categories:
 *   - Web: web_search, web_extract, browser_*
 *   - Files: read_file, write_file, patch, search_files
 *   - Terminal: terminal, execute_code
 *   - Vision: vision_analyze, image_generate
 *   - Memory: memory, session_search
 *   - Planning: todo, delegate_task
 *   - System: clarify, send_message
 *   - Automation: cronjob, computer_use
 */

export class HermesToolProvider extends BaseProviderAdapter<HermesBridge> implements IToolProvider {
	readonly id = 'hermes-agent-tools';
	readonly name = 'Hermes Agent Tools';

	private _toolsCache = new Map<string, IToolDefinition[]>();
	private _bridge: HermesBridge | undefined;

	constructor(context: IAgentOSPluginContext) {
		super('hermes-agent-tools', context);
	}

	// ─── IToolProvider ─────────────────────────────────────────

	async listTools(agentId: string): Promise<IToolDefinition[]> {
		// Check cache first
		if (this._toolsCache.has(agentId)) {
			return this._toolsCache.get(agentId)!;
		}

		const bridge = await this.ensureConnected();

		try {
			const result = await bridge.request('list_tools', { agentId }) as Array<{
				name: string;
				description: string;
				parameters: Record<string, unknown>;
				toolset: string;
			}>;

			const tools: IToolDefinition[] = result.map(tool => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.parameters,
				category: tool.toolset,
				source: 'hermes-agent',
			}));

			this._toolsCache.set(agentId, tools);
			return tools;
		} catch (err) {
			this._logService.error('[Hermes-Tools] Failed to list tools:', err);
			return [];
		}
	}

	async executeTool(agentId: string, toolCall: IToolCall): Promise<IToolResult> {
		const bridge = await this.ensureConnected();

		try {
			const result = await bridge.request('execute_tool', {
				agentId,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				arguments: toolCall.arguments,
			}) as {
				success: boolean;
				content?: string;
				error?: string;
				metadata?: Record<string, unknown>;
			};

			const contents: IToolResultContent[] = [];
			if (result.content) {
				contents.push({
					type: 'text',
					text: result.content,
				});
			}

			return {
				toolCallId: toolCall.id,
				success: result.success,
				content: contents,
				error: result.error,
			};
		} catch (err) {
			return {
				toolCallId: toolCall.id,
				success: false,
				content: [{
					type: 'text',
					text: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
				}],
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ─── BaseProviderAdapter ───────────────────────────────────

	protected async connectNativeAPI(): Promise<HermesBridge> {
		const sharedBridge = (globalThis as any).__hermesBridge as HermesBridge | undefined;
		if (sharedBridge?.isRunning) {
			this._bridge = sharedBridge;
			return sharedBridge;
		}

		const config = this._readConfig();
		const bridge = new HermesBridge(config);
		this._bridge = bridge;
		await bridge.start();

		(globalThis as any).__hermesBridge = bridge;
		return bridge;
	}

	override dispose(): void {
		this._toolsCache.clear();
		this._bridge = undefined;
		super.dispose();
	}

	/**
	 * Invalidate tool cache (e.g. after toolset config change)
	 */
	invalidateCache(): void {
		this._toolsCache.clear();
	}

	// ─── Internal ──────────────────────────────────────────────

	private _readConfig() {
		const config = this._context.configurationService;
		const prefix = 'sessions.agentStudio.hermes';
		return {
			pythonPath: config.getValue<string>(`${prefix}.pythonPath`) || 'python3',
			hermesSourcePath: config.getValue<string>(`${prefix}.hermesSourcePath`) || '',
			hermesHome: config.getValue<string>(`${prefix}.hermesHome`) || '',
			provider: config.getValue<string>(`${prefix}.provider`) || '',
			model: config.getValue<string>(`${prefix}.model`) || '',
			apiKey: config.getValue<string>(`${prefix}.apiKey`) || '',
			baseUrl: config.getValue<string>(`${prefix}.baseUrl`) || '',
			enabledToolsets: config.getValue<string[]>(`${prefix}.enabledToolsets`) || [],
			disabledToolsets: config.getValue<string[]>(`${prefix}.disabledToolsets`) || [],
			maxIterations: config.getValue<number>(`${prefix}.maxIterations`) || 90,
			memoryProvider: config.getValue<string>(`${prefix}.memoryProvider`) || '',
			timeout: config.getValue<number>('hermes.timeout') || 300000,
			streaming: config.getValue<boolean>('hermes.streaming') ?? true,
		};
	}
}
