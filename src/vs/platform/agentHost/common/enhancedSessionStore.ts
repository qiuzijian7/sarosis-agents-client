/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';

// TODO: Import from actual Chronicle SessionStore when available
// Temporary interface definition
export interface ISessionStore {
	readonly _serviceBrand: undefined;
	dispose(): void;
	// Add other required methods from ISessionStore
}

// ── Service Identifier ───────────────────────────────────────────────────────────

export const IEnhancedSessionStore = createDecorator<IEnhancedSessionStore>('enhancedSessionStore');

// ── Memory Entry Interface ───────────────────────────────────────────────────────

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

// ── Memory Filter ───────────────────────────────────────────────────────────────

export interface IMemoryFilter {
	readonly category?: string;
	readonly sessionId?: string;
	readonly minImportance?: number;
	readonly limit?: number;
	readonly includeExpired?: boolean;
}

// ── Search Options ──────────────────────────────────────────────────────────────

export interface ISearchOptions {
	readonly maxResults?: number;
	readonly sourceTypes?: string[];     // 'turn' | 'checkpoint_*' | 'memory' | 'workspace_artifact'
	readonly sessionId?: string;         // limit to specific session
	readonly minRank?: number;           // BM25 minimum score
}

// ── Search Result (enhanced) ───────────────────────────────────────────────────

export interface IEnhancedSearchResult {
	readonly content: string;
	readonly sessionId: string;
	readonly sourceType: string;
	readonly sourceId: string;
	readonly rank: number;               // BM25 score
	readonly importance?: number;         // memory importance (if sourceType === 'memory')
	readonly combinedRank?: number;       // BM25 * (1 + importance)
}

// ── Compression Log Entry ──────────────────────────────────────────────────────

export interface ICompressionLogEntry {
	readonly id?: number;
	readonly sessionId: string;
	readonly compressedAt: string;
	readonly strategy: 'auto' | 'manual' | 'focused';
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly turnsCompressed: number;
	readonly turnsPreserved: number;
	readonly savingsPercent?: number;
	readonly summaryPreview?: string;
}

// ── Enhanced Session Store Interface ───────────────────────────────────────────

export interface IEnhancedSessionStore extends ISessionStore {
	readonly _serviceBrand: undefined;
	dispose(): void;

	// ── Memory Operations ─────────────────────────────────────────────────

	/**
	 * Insert a new memory entry.
	 * Returns the ID of the inserted memory.
	 */
	insertMemory(entry: Omit<IMemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'accessCount'>): string;

	/**
	 * Update an existing memory entry.
	 */
	updateMemory(id: string, updates: Partial<Omit<IMemoryEntry, 'id' | 'createdAt' | 'updatedAt'>>): void;

	/**
	 * Delete a memory entry by ID.
	 */
	deleteMemory(id: string): void;

	/**
	 * Get memories matching the filter.
	 */
	getMemories(filter?: IMemoryFilter): IMemoryEntry[];

	/**
	 * Increment the access count for a memory entry.
	 */
	incrementMemoryAccess(id: string): void;

	// ── Enhanced Search ────────────────────────────────────────────────────

	/**
	 * Search with relevance scoring and filtering options.
	 */
	searchWithRelevance(query: string, options?: ISearchOptions): IEnhancedSearchResult[];

	// ── Compression Log ────────────────────────────────────────────────────

	/**
	 * Log a compression operation.
	 */
	logCompression(entry: Omit<ICompressionLogEntry, 'id' | 'compressedAt'>): void;

	/**
	 * Get compression history for a session.
	 */
	getCompressionHistory(sessionId: string): ICompressionLogEntry[];

	/**
	 * Get the latest compression entry for a session.
	 */
	getLatestCompression(sessionId: string): ICompressionLogEntry | undefined;
}
