/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../base/common/event.js';

// ── Service Identifier ───────────────────────────────────────────────────────

export const IMemoryService = createDecorator<IMemoryService>('memoryService');

// ── Memory Change Event ─────────────────────────────────────────────────────

export interface IMemoryChangeEvent {
	readonly type: 'added' | 'updated' | 'deleted';
	readonly memoryId: string;
	readonly category: string;
}

// ── Tool Schema (for LLM tool calling) ────────────────────────────────────

export interface IToolSchema {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
}

// ── Memory Provider Interface ───────────────────────────────────────────────

export interface IMemoryProvider {
	readonly id: string;
	readonly name: string;
	dispose(): void;

	/**
	 * Initialize the provider for a specific session.
	 */
	initialize(sessionId: string): Promise<void>;

	/**
	 * Return a system prompt fragment describing the memory capabilities.
	 */
	systemPromptBlock(): string;

	/**
	 * Prefetch relevant memories for the given query.
	 * Returns formatted memory context string.
	 */
	prefetch(query: string): Promise<string>;

	/**
	 * Queue prefetch (async, non-blocking).
	 */
	queuePrefetch(query: string): void;

	/**
	 * Sync turn data after a turn completes.
	 * Auto-extract memorable content.
	 */
	syncTurn(userMessage: string, assistantResponse: string): Promise<void>;

	/**
	 * Get tool schemas provided by this provider.
	 */
	getToolSchemas(): readonly IToolSchema[];

	/**
	 * Handle a tool call from the LLM.
	 */
	handleToolCall(name: string, args: Record<string, unknown>): Promise<string>;

	/**
	 * Called when session switches.
	 */
	onSessionSwitch(sessionId: string): Promise<void>;

	/**
	 * Optional: called before compression to provide additional context for summary.
	 */
	onPreCompress?(): Promise<string>;
}

// ── Memory Service Interface ────────────────────────────────────────────────

export interface IMemoryService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when memories change.
	 */
	readonly onDidChangeMemories: Event<IMemoryChangeEvent>;

	// ── Lifecycle ─────────────────────────────────────────────────────

	/**
	 * Initialize all providers for a session.
	 */
	initialize(sessionId: string): Promise<void>;

	/**
	 * Notify all providers of session switch.
	 */
	onSessionSwitch(sessionId: string): Promise<void>;

	/**
	 * Shutdown and cleanup.
	 */
	shutdown(): Promise<void>;

	/**
	 * Dispose the service and all providers.
	 */
	dispose(): void;

	// ── Context Injection ────────────────────────────────────────────

	/**
	 * Prefetch relevant memories for the upcoming message.
	 * Returns the memory context string to inject.
	 */
	prefetch(sessionId: string, userMessage: string): Promise<string>;

	/**
	 * Build the system prompt block for memory.
	 */
	buildSystemPromptBlock(): string;

	// ── Turn Sync ────────────────────────────────────────────────────

	/**
	 * Sync conversation to memory storage after turn completes.
	 * Auto-extracts memorable content.
	 */
	syncTurn(sessionId: string, userMessage: string, assistantResponse: string): Promise<void>;

	/**
	 * Queue prefetch for the next turn (async, non-blocking).
	 */
	queuePrefetch(sessionId: string, userMessage: string): void;

	// ── Memory CRUD ──────────────────────────────────────────────────

	/**
	 * Write a memory entry.
	 * Returns the ID of the created memory.
	 */
	writeMemory(entry: {
		readonly content: string;
		readonly category?: string;
		readonly importance?: number;
		readonly sessionId?: string;
		readonly expiresAt?: string;
		readonly source?: 'auto' | 'user' | 'tool';
	}): Promise<string>;

	/**
	 * Read memories matching the filter.
	 */
	readMemories(filter?: {
		readonly category?: string;
		readonly sessionId?: string;
		readonly minImportance?: number;
		readonly limit?: number;
		readonly includeExpired?: boolean;
	}): Promise<readonly IMemoryEntry[]>;

	/**
	 * Search memories using full-text search.
	 */
	searchMemories(query: string, limit?: number): Promise<readonly ISearchResult[]>;

	/**
	 * Delete a memory entry by ID.
	 */
	deleteMemory(id: string): Promise<void>;

	// ── Tool Routing ───────────────────────────────────────────────

	/**
	 * Get all memory-related tool schemas from all providers.
	 */
	getToolSchemas(): readonly IToolSchema[];

	/**
	 * Handle a memory-related tool call.
	 * Routes to the appropriate provider.
	 */
	handleToolCall(toolName: string, args: Record<string, unknown>): Promise<string>;

	// ── Provider Management ─────────────────────────────────────────

	/**
	 * Register a memory provider.
	 * Returns a disposable to unregister.
	 */
	registerProvider(provider: IMemoryProvider): { dispose(): void };

	/**
	 * Get registered providers.
	 */
	getProviders(): readonly IMemoryProvider[];
}

// ── Memory Entry (re-exported from enhancedSessionStore) ───────────────────

export interface IMemoryEntry {
	readonly id: string;
	readonly sessionId?: string;
	readonly category: 'user_preference' | 'project_knowledge' | 'decision' | 'general';
	readonly content: string;
	readonly importance: number;        // [0.0, 1.0]
	readonly accessCount: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly expiresAt?: string;
	readonly source: 'auto' | 'user' | 'tool';
}

// ── Search Result ─────────────────────────────────────────────────────────

export interface ISearchResult {
	readonly content: string;
	readonly sessionId: string;
	readonly sourceType: string;
	readonly sourceId: string;
	readonly rank: number;
	readonly importance?: number;
	readonly combinedRank?: number;
}
