/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ISessionStore } from './sessionStore.js';

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

	// ── Memory Operations ─────────────────────────────────────────────────

	insertMemory(entry: Omit<IMemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'accessCount'>): string;
	updateMemory(id: string, updates: Partial<Omit<IMemoryEntry, 'id' | 'createdAt' | 'updatedAt'>>): void;
	deleteMemory(id: string): void;
	getMemories(filter?: IMemoryFilter): IMemoryEntry[];
	incrementMemoryAccess(id: string): void;

	// ── Enhanced Search ────────────────────────────────────────────────────

	searchWithRelevance(query: string, options?: ISearchOptions): IEnhancedSearchResult[];

	// ── Compression Log ────────────────────────────────────────────────────

	logCompression(entry: Omit<ICompressionLogEntry, 'id' | 'compressedAt'>): void;
	getCompressionHistory(sessionId: string): ICompressionLogEntry[];
	getLatestCompression(sessionId: string): ICompressionLogEntry | undefined;
}
