/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IExecutionProvider, IAgentTurnRequest, IChatStreamDelta, ISlotRegistry
} from '../../../src/vs/sessions/contrib/agentStudio/common/providers.js';
import { BaseProviderAdapter, IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { HermesBridge } from './hermesBridge.js';

interface IModelOptions {
	messages: Array<{ role: string; content: string }>;
	provider?: string;
	model?: string;
	systemPrompt?: string;
	temperature?: number;
	maxTokens?: number;
	maxIterations?: number;
	sessionId?: string;
}

/**
 * Hermes Execution Provider
 *
 * Bridges hermes-agent's AIAgent.run_conversation() loop to IExecutionProvider.
 * The execution loop runs in the Python bridge process, streaming events back
 * via JSON-RPC over stdio.
 *
 * Agent Loop Flow:
 *   1. Receive IAgentTurnRequest from OS
 *   2. Forward to hermes bridge as chat.stream request
 *   3. Bridge runs AIAgent.run_conversation() in Python
 *   4. Stream events back: text, thinking, tool_start/args/end/result, done/error
 *   5. Map events to IChatStreamDelta and yield to OS
 *
 * The ExecutionProvider can optionally use the SlotRegistry to integrate with
 * other capability providers (e.g. use OS Memory Provider instead of Hermes native).
 */

export class HermesExecutionProvider extends BaseProviderAdapter<HermesBridge> implements IExecutionProvider {
	readonly id = 'hermes-agent-execution';
	readonly name = 'Hermes Agent Execution';
	private _bridge?: HermesBridge;

	constructor(context: IAgentOSPluginContext) {
		super('hermes-agent-execution', context);
	}

	// ─── IExecutionProvider ────────────────────────────────────

	async *runAgentLoop(
		request: IAgentTurnRequest,
		slots: ISlotRegistry,
	): AsyncIterable<IChatStreamDelta> {
		const bridge = await this.ensureConnected();

		// Convert messages to hermes format
		const messages = request.messages.map(m => ({
			role: m.role,
			content: m.content,
			...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
			...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
		}));

		// Optionally integrate with OS Memory Provider
		const osMemory = slots.getActiveMemoryProvider();
		let memoryContext = '';
		if (osMemory && request.sessionId) {
			try {
				const ctx = await osMemory.loadContext(request.agentId, request.sessionId || '');
				memoryContext = [
					...ctx.shortTermMemories.map(m => m.content),
					...ctx.longTermMemories.map(m => m.content),
				].join('\n');
			} catch {
				// Fallback to hermes native memory
			}
		}

		// Build system prompt with optional OS memory injection
		let systemPrompt = request.systemPrompt || '';
		if (memoryContext) {
			systemPrompt += `\n\n[OS Memory Context]\n${memoryContext}`;
		}

	// Stream from hermes bridge
	const stream = bridge.streamChat({
			messages,
			systemPrompt: systemPrompt || undefined,
			temperature: request.options?.temperature,
			maxTokens: request.options?.maxTokens,
			maxIterations: (request.options as any)?.maxIterations,
			sessionId: request.sessionId,
		});

		let currentToolCallId: string | undefined;
		let currentToolName: string | undefined;

		for await (const event of stream) {
			switch (event.method) {
				case 'chat.delta': {
					const deltaType = event.params?.['deltaType'] as string;
					const content = event.params?.['content'] as string;
					if (deltaType === 'text' && content) {
						yield { type: 'text', content };
					} else if (deltaType === 'thinking' && content) {
						yield { type: 'thinking', content };
					}
					break;
				}
				case 'chat.tool_start': {
					currentToolCallId = event.params?.['toolCallId'] as string;
					currentToolName = event.params?.['toolName'] as string;
					yield {
						type: 'tool_start',
						toolCallId: currentToolCallId,
						toolName: currentToolName,
					};
					break;
				}
				case 'chat.tool_args': {
					yield {
						type: 'tool_args',
						toolCallId: event.params?.['toolCallId'] as string,
						content: event.params?.['args'] as string,
					};
					break;
				}
				case 'chat.tool_end': {
					yield {
						type: 'tool_end',
						toolCallId: event.params?.['toolCallId'] as string,
					};
					currentToolCallId = undefined;
					currentToolName = undefined;
					break;
				}
				case 'chat.tool_result': {
					yield {
						type: 'tool_result',
						toolCallId: event.params?.['toolCallId'] as string,
						content: event.params?.['result'] as string,
						metadata: event.params?.['metadata'] as Record<string, unknown>,
					};
					break;
				}
				case 'chat.done': {
					yield { type: 'done' };
					return;
				}
				case 'chat.error': {
					yield { type: 'error', content: event.params?.['error'] as string };
					return;
				}
			}
		}
	}

	// ─── BaseProviderAdapter ───────────────────────────────────

	protected async connectNativeAPI(): Promise<HermesBridge> {
		// Share the bridge with ModelProvider — both use the same process
		// The bridge is a singleton per plugin; we look it up via globalThis
		const sharedBridge = (globalThis as any).__hermesBridge as HermesBridge | undefined;
		if (sharedBridge?.isRunning) {
			this._bridge = sharedBridge;
			return sharedBridge;
		}

		const config = this._readConfig();
		const bridge = new HermesBridge(config);
		this._bridge = bridge;
		await bridge.start();

		// Store for sharing
		(globalThis as any).__hermesBridge = bridge;
		return bridge;
	}

	override dispose(): void {
		// Don't stop the bridge here — the extension controls lifecycle
		this._bridge = undefined;
		super.dispose();
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
