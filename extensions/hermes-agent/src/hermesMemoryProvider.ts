/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IMemoryProvider, IMemoryContext, IMemoryEntry, IDocumentRef
} from '../../../src/vs/sessions/contrib/agentStudio/common/providers.js';
import { BaseProviderAdapter, IAgentOSPluginContext } from '../../../src/vs/sessions/contrib/agentStudio/common/adapters.js';
import { HermesBridge } from './hermesBridge.js';
import { URI } from '../../../src/vs/base/common/uri.js';

/**
 * Hermes Memory Provider
 *
 * Bridges hermes-agent's memory system to the IMemoryProvider interface.
 * Supports both the built-in file-based memory (MEMORY.md / USER.md) and
 * plugin memory providers (Honcho, Mem0, SuperMemory, etc.).
 *
 * Memory Types in Hermes:
 *   - Built-in: File-based persistent memory (MEMORY.md + USER.md snapshots)
 *   - Honcho: AI-native memory with dialectical Q&A
 *   - Mem0: Automated memory management
 *   - SuperMemory: Cloud-based memory
 *   - Hindsight, Byterover, Holographic, OpenViking, RetainDB
 */

export class HermesMemoryProvider extends BaseProviderAdapter<HermesBridge> implements IMemoryProvider {
	readonly id = 'hermes-agent-memory';
	readonly name = 'Hermes Agent Memory';

	private _bridge: HermesBridge | undefined;

	constructor(context: IAgentOSPluginContext) {
		super('hermes-agent-memory', context);
	}

	// ─── IMemoryProvider ───────────────────────────────────────

	async loadContext(agentId: string, sessionId: string): Promise<IMemoryContext> {
		const bridge = await this.ensureConnected();

		try {
			const result = await bridge.request('memory.load_context', {
				agentId,
				sessionId,
			}) as {
				shortTermMemories?: Array<{ id: string; content: string; timestamp?: number; metadata?: Record<string, unknown> }>;
				longTermMemories?: Array<{ id: string; content: string; timestamp?: number; metadata?: Record<string, unknown> }>;
				systemPrompt?: string;
			};

			return {
				shortTermMemories: (result.shortTermMemories || []).map(m => ({
					id: m.id,
					type: 'short_term' as const,
					content: m.content,
					timestamp: m.timestamp,
					metadata: m.metadata,
				})),
				longTermMemories: (result.longTermMemories || []).map(m => ({
					id: m.id,
					type: 'long_term' as const,
					content: m.content,
					timestamp: m.timestamp,
					metadata: m.metadata,
				})),
				systemPrompt: result.systemPrompt,
			};
		} catch (err) {
			this._logService.error('[Hermes-Memory] Failed to load context:', err);
			return { shortTermMemories: [], longTermMemories: [] };
		}
	}

	async writeMemory(agentId: string, entry: IMemoryEntry): Promise<void> {
		const bridge = await this.ensureConnected();

		try {
			await bridge.request('memory.write', {
				agentId,
				entry: {
					id: entry.id,
					type: entry.type,
					content: entry.content,
					metadata: entry.metadata,
					timestamp: entry.timestamp,
				},
			});
		} catch (err) {
			this._logService.error('[Hermes-Memory] Failed to write memory:', err);
			throw this.wrapError('writeMemory', err);
		}
	}

	async searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]> {
		const bridge = await this.ensureConnected();

		try {
			const result = await bridge.request('memory.search', {
				agentId,
				query,
			}) as Array<{
				id: string;
				content: string;
				score?: number;
				timestamp?: number;
				metadata?: Record<string, unknown>;
			}>;

			return result.map(m => ({
				id: m.id,
				type: 'long_term' as const, // search results are typically from long-term
				content: m.content,
				score: m.score,
				timestamp: m.timestamp,
				metadata: m.metadata,
			}));
		} catch (err) {
			this._logService.error('[Hermes-Memory] Failed to search memory:', err);
			return [];
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
