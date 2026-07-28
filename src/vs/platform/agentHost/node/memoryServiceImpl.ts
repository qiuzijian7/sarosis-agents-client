/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { ILogService } from '../../log/common/log.js';
import { IEnhancedSessionStore, IMemoryEntry, IEnhancedSearchResult } from '../common/enhancedSessionStore.js';
import { IMemoryService, IMemoryProvider, IToolSchema, IMemoryChangeEvent } from '../common/memoryService.js';

/**
 * Memory Service implementation that coordinates multiple memory providers.
 *
 * This is the main entry point for memory management, ported from Hermes Agent's
 * memory_manager.py. It supports:
 * - Multiple memory providers (builtin, extensions)
 * - Tool routing to appropriate providers
 * - Context injection via prefetch
 * - Auto-extraction from conversations
 */
export class MemoryService extends Disposable implements IMemoryService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeMemories = this._register(new Emitter<IMemoryChangeEvent>());
	readonly onDidChangeMemories = this._onDidChangeMemories.event;

	private readonly _providers: IMemoryProvider[] = [];
	private readonly _toolToProvider = new Map<string, IMemoryProvider>();
	private _currentSessionId?: string;

	constructor(
		@IEnhancedSessionStore private readonly sessionStore: IEnhancedSessionStore,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._registerBuiltinProvider();
	}

	// ── Lifecycle ─────────────────────────────────────────────────

	async initialize(sessionId: string): Promise<void> {
		this._currentSessionId = sessionId;
		for (const provider of this._providers) {
			try {
				await provider.initialize(sessionId);
			} catch (err) {
				this.logService.error(`[MemoryService] Failed to initialize provider ${provider.id}`, err);
			}
		}
		this.logService.info('[MemoryService] Initialized for session', sessionId);
	}

	async onSessionSwitch(sessionId: string): Promise<void> {
		this._currentSessionId = sessionId;
		for (const provider of this._providers) {
			try {
				await provider.onSessionSwitch(sessionId);
			} catch (err) {
				this.logService.error(`[MemoryService] Failed to switch session for provider ${provider.id}`, err);
			}
		}
	}

	async shutdown(): Promise<void> {
		for (const provider of this._providers) {
			try {
				provider.dispose();
			} catch (err) {
				this.logService.error(`[MemoryService] Failed to dispose provider ${provider.id}`, err);
			}
		}
		this._providers.length = 0;
		this._toolToProvider.clear();
		this.logService.info('[MemoryService] Shutdown complete');
	}

	// ── Context Injection ─────────────────────────────────────────

	async prefetch(sessionId: string, userMessage: string): Promise<string> {
		if (!this._config.enabled) {
			return '';
		}

		const results: string[] = [];

		for (const provider of this._providers) {
			try {
				const result = await provider.prefetch(userMessage);
				if (result) {
					results.push(result);
				}
			} catch (err) {
				this.logService.error(`[MemoryService] Prefetch failed for provider ${provider.id}`, err);
			}
		}

		if (results.length === 0) {
			return '';
		}

		return [
			'<memory-context>',
			'<!-- The following is recalled memory context, NOT new user input. -->',
			...results,
			'</memory-context>',
		].join('\n');
	}

	buildSystemPromptBlock(): string {
		const blocks: string[] = [];

		for (const provider of this._providers) {
			const block = provider.systemPromptBlock();
			if (block) {
				blocks.push(block);
			}
		}

		return blocks.join('\n\n');
	}

	// ── Turn Sync ─────────────────────────────────────────────────

	async syncTurn(sessionId: string, userMessage: string, assistantResponse: string): Promise<void> {
		for (const provider of this._providers) {
			try {
				await provider.syncTurn(userMessage, assistantResponse);
			} catch (err) {
				this.logService.error(`[MemoryService] SyncTurn failed for provider ${provider.id}`, err);
			}
		}
	}

	queuePrefetch(sessionId: string, userMessage: string): void {
		for (const provider of this._providers) {
			try {
				provider.queuePrefetch(userMessage);
			} catch (err) {
				this.logService.error(`[MemoryService] QueuePrefetch failed for provider ${provider.id}`, err);
			}
		}
	}

	// ── Memory CRUD ──────────────────────────────────────────────

	async writeMemory(entry: {
		readonly content: string;
		readonly category?: string;
		readonly importance?: number;
		readonly sessionId?: string;
		readonly expiresAt?: string;
		readonly source?: 'auto' | 'user' | 'tool';
	}): Promise<string> {
		// Persist directly via the session store (the builtin provider's storage backend).
		// The legacy `memory_write` tool has been removed, so write straight to storage.
		if (!this.sessionStore) {
			throw new Error('No memory provider registered');
		}

		const id = this.sessionStore.insertMemory({
		content: entry.content,
		category: (entry.category as IMemoryEntry['category']) ?? 'general',
			importance: entry.importance ?? 0.5,
			sessionId: this._currentSessionId,
			expiresAt: entry.expiresAt,
			source: 'tool',
		});

		this._onDidChangeMemories.fire({
			type: 'added',
			memoryId: id,
			category: entry.category ?? 'general',
		});
		return id;
	}

	async readMemories(filter?: {
		readonly category?: string;
		readonly sessionId?: string;
		readonly minImportance?: number;
		readonly limit?: number;
		readonly includeExpired?: boolean;
	}): Promise<readonly IMemoryEntry[]> {
		return this.sessionStore.getMemories(filter);
	}

	async searchMemories(query: string, limit: number = 5): Promise<readonly IEnhancedSearchResult[]> {
		const results = this.sessionStore.searchWithRelevance(query, {
			maxResults: limit,
			sourceTypes: ['memory'],
		});
		return results;
	}

	async deleteMemory(id: string): Promise<void> {
		const memory = this._getMemoryById(id);
		this.sessionStore.deleteMemory(id);

		if (memory) {
			this._onDidChangeMemories.fire({
				type: 'deleted',
				memoryId: id,
				category: memory.category,
			});
		}
	}

	// ── Tool Routing ─────────────────────────────────────────────

	getToolSchemas(): readonly IToolSchema[] {
		const schemas: IToolSchema[] = [];
		for (const provider of this._providers) {
			schemas.push(...provider.getToolSchemas());
		}
		return schemas;
	}

	async handleToolCall(toolName: string, args: Record<string, unknown>): Promise<string> {
		const provider = this._toolToProvider.get(toolName);
		if (!provider) {
			return JSON.stringify({ error: `Unknown memory tool: ${toolName}` });
		}

		return provider.handleToolCall(toolName, args);
	}

	// ── Provider Management ──────────────────────────────────────

	registerProvider(provider: IMemoryProvider): { dispose(): void } {
		this._providers.push(provider);

		// Register tool routes
		const schemas = provider.getToolSchemas();
		for (const schema of schemas) {
			this._toolToProvider.set(schema.name, provider);
		}

		// Initialize for current session if available
		if (this._currentSessionId) {
			provider.initialize(this._currentSessionId).catch(err => {
				this.logService.error(`[MemoryService] Failed to init registered provider ${provider.id}`, err);
			});
		}

		this.logService.info('[MemoryService] Registered provider', provider.id);

		// Return disposable to unregister
		return {
			dispose: () => {
				const index = this._providers.indexOf(provider);
				if (index >= 0) {
					this._providers.splice(index, 1);
				}
				for (const schema of schemas) {
					this._toolToProvider.delete(schema.name);
				}
				provider.dispose();
			},
		};
	}

	getProviders(): readonly IMemoryProvider[] {
		return [...this._providers];
	}

	// ── Private Helpers ─────────────────────────────────────────

	private _registerBuiltinProvider(): void {
		// The builtin provider will be registered by the platform when available
		// This is called after DI initialization
	}

	private _getMemoryById(id: string): IMemoryEntry | undefined {
		const memories = this.sessionStore.getMemories({ limit: 1 });
		return memories.find(m => m.id === id);
	}

	private get _config(): { enabled: boolean } {
		// TODO: Read from configuration service
		return { enabled: true };
	}
}
