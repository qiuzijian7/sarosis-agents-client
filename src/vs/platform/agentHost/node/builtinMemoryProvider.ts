/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IEnhancedSessionStore, IMemoryEntry } from '../common/enhancedSessionStore.js';
import { IMemoryProvider, IToolSchema } from '../common/memoryService.js';

/**
 * Built-in Memory Provider that uses the EnhancedSessionStore for storage.
 *
 * This provider implements the core memory management functionality:
 * - Persistent memory storage in SQLite (via EnhancedSessionStore)
 * - FTS5-based memory search
 * - Memory tools for LLM (memory_write, memory_search, memory_delete)
 * - Basic auto-extraction from conversations
 * - Memory context injection for prefetch
 */
export class BuiltinMemoryProvider extends Disposable implements IMemoryProvider {
	readonly id = 'builtin';
	readonly name = 'Built-in Memory';

	private _currentSessionId?: string;

	constructor(
		@IEnhancedSessionStore private readonly sessionStore: IEnhancedSessionStore,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	// ── Lifecycle ─────────────────────────────────────────────────

	async initialize(sessionId: string): Promise<void> {
		this._currentSessionId = sessionId;
		this.logService.debug('[BuiltinMemoryProvider] Initialized for session', sessionId);
	}

	async onSessionSwitch(sessionId: string): Promise<void> {
		this._currentSessionId = sessionId;
		this.logService.debug('[BuiltinMemoryProvider] Switched to session', sessionId);
	}

	override dispose(): void {
		this._currentSessionId = undefined;
		super.dispose();
	}

	// ── System Prompt ────────────────────────────────────────────

	systemPromptBlock(): string {
		return [
			'## Memory',
			'You have access to a persistent memory system.',
			'Use `memory_write` to save important information for future sessions.',
			'Use `memory_search` to recall relevant past knowledge.',
			'Categories: user_preference, project_knowledge, decision, general.',
			'',
			'When writing memories:',
			'- Be concise but informative',
			'- Include context (why this matters, when it was decided)',
			'- Set appropriate importance (0.0-1.0)',
			'- Use relevant category',
		].join('\n');
	}

	// ── Prefetch ────────────────────────────────────────────────

	async prefetch(query: string): Promise<string> {
		if (!this._currentSessionId) {
			return '';
		}

		try {
			const results = this.sessionStore.searchWithRelevance(query, {
				maxResults: 5,
				sourceTypes: ['memory', 'checkpoint_overview'],
			});

			if (results.length === 0) {
				return '';
			}

			const lines = results.map(r =>
				`[${r.sourceType}] ${r.content.substring(0, 300)}`
			);

			return lines.join('\n');
		} catch (err) {
			this.logService.error('[BuiltinMemoryProvider] Prefetch failed', err);
			return '';
		}
	}

	queuePrefetch(query: string): void {
		// Async, non-blocking prefetch for next turn
		this.prefetch(query).catch(err => {
			this.logService.error('[BuiltinMemoryProvider] Queued prefetch failed', err);
		});
	}

	// ── Turn Sync & Auto-Extraction ─────────────────────────────

	async syncTurn(userMessage: string, assistantResponse: string): Promise<void> {
		if (!this._currentSessionId) {
			return;
		}

		try {
			// Basic heuristic extraction (will be enhanced with LLM in later phase)
			await this._extractMemories(userMessage, assistantResponse);
		} catch (err) {
			this.logService.error('[BuiltinMemoryProvider] SyncTurn failed', err);
		}
	}

	private async _extractMemories(userMessage: string, assistantResponse: string): Promise<void> {
		// Simple heuristic extraction for Phase 1
		// Will be enhanced with LLM-based extraction in Phase 2

		const combined = `${userMessage}\n${assistantResponse}`;

		// Pattern 1: User explicitly asks to remember
		if (/remember|don't forget|always remember/i.test(userMessage)) {
			const content = this._extractKeyInfo(combined);
			if (content) {
				this.sessionStore.insertMemory({
					content,
					category: 'user_preference',
					importance: 0.8,
					sessionId: this._currentSessionId,
					source: 'auto',
				});
			}
		}

		// Pattern 2: Decision made (contains "decided", "chose", "will use")
		if (/decided|chose|will use|going with/i.test(assistantResponse)) {
			const content = this._extractKeyInfo(assistantResponse);
			if (content) {
				this.sessionStore.insertMemory({
					content,
					category: 'decision',
					importance: 0.7,
					sessionId: this._currentSessionId,
					source: 'auto',
				});
			}
		}

		// Pattern 3: Project knowledge (contains code references, file paths)
		if (/function|class|interface|import|from|require/i.test(combined)) {
			const content = this._extractKeyInfo(combined);
			if (content && content.length > 50) {
				this.sessionStore.insertMemory({
					content: content.substring(0, 500),
					category: 'project_knowledge',
					importance: 0.6,
					sessionId: this._currentSessionId,
					source: 'auto',
				});
			}
		}
	}

	private _extractKeyInfo(text: string): string | null {
		// Simple extraction: take the first 2-3 substantial lines
		const lines = text.split('\n')
			.map(l => l.trim())
			.filter(l => l.length > 20)
			.slice(0, 3);

		return lines.length > 0 ? lines.join(' | ') : null;
	}

	// ── Tool Schemas ────────────────────────────────────────────

	getToolSchemas(): readonly IToolSchema[] {
		return [
			{
				name: 'memory_write',
				description: 'Save important information to persistent memory for future sessions. Use this to remember user preferences, project decisions, and key information.',
				parameters: {
					type: 'object',
					properties: {
						content: {
							type: 'string',
							description: 'The information to remember. Be concise but include context.',
						},
						category: {
							type: 'string',
							enum: ['user_preference', 'project_knowledge', 'decision', 'general'],
							description: 'Category of the memory.',
							default: 'general',
						},
						importance: {
							type: 'number',
							minimum: 0,
							maximum: 1,
							description: 'Importance score (0.0 to 1.0). Default 0.5.',
							default: 0.5,
						},
						expires_at: {
							type: 'string',
							description: 'Optional expiration date (ISO 8601 format).',
						},
					},
					required: ['content'],
				},
			},
			{
				name: 'memory_search',
				description: 'Search persistent memory for relevant past knowledge. Use this before making decisions that might be influenced by past context.',
				parameters: {
					type: 'object',
					properties: {
						query: {
							type: 'string',
							description: 'Search query. Use keywords and phrases.',
						},
						limit: {
							type: 'number',
							description: 'Maximum number of results. Default 5.',
							default: 5,
						},
						category: {
							type: 'string',
							description: 'Filter by category.',
							enum: ['user_preference', 'project_knowledge', 'decision', 'general'],
						},
					},
					required: ['query'],
				},
			},
			{
				name: 'memory_delete',
				description: 'Delete a specific memory entry by ID. Use this to remove outdated or incorrect memories.',
				parameters: {
					type: 'object',
					properties: {
						id: {
							type: 'string',
							description: 'Memory entry ID to delete.',
						},
					},
					required: ['id'],
				},
			},
		];
	}

	// ── Tool Call Handler ───────────────────────────────────────

	async handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
		try {
			switch (name) {
				case 'memory_write':
					return await this._handleMemoryWrite(args);
				case 'memory_search':
					return await this._handleMemorySearch(args);
				case 'memory_delete':
					return await this._handleMemoryDelete(args);
				default:
					return JSON.stringify({ error: `Unknown tool: ${name}` });
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.logService.error(`[BuiltinMemoryProvider] Tool ${name} failed`, err);
			return JSON.stringify({ error: errorMsg });
		}
	}

	private async _handleMemoryWrite(args: Record<string, unknown>): Promise<string> {
		const content = args['content'] as string;
		if (!content) {
			return JSON.stringify({ error: 'content is required' });
		}

		const category = (args['category'] as IMemoryEntry['category']) ?? 'general';
		const importance = (args['importance'] as number) ?? 0.5;
		const expiresAt = args['expires_at'] as string | undefined;

		const id = this.sessionStore.insertMemory({
			content,
			category,
			importance: Math.max(0, Math.min(1, importance)),
			sessionId: this._currentSessionId,
			expiresAt,
			source: 'tool',
		});

		return JSON.stringify({
			success: true,
			id,
			message: `Memory saved to ${category} category with importance ${importance}`,
		});
	}

	private async _handleMemorySearch(args: Record<string, unknown>): Promise<string> {
		const query = args['query'] as string;
		if (!query) {
			return JSON.stringify({ error: 'query is required' });
		}

		const limit = (args['limit'] as number) ?? 5;
		const category = args['category'] as string | undefined;

		const memories = this.sessionStore.getMemories({
			category,
			limit,
			includeExpired: false,
		});

		if (memories.length === 0) {
			return JSON.stringify({
				success: true,
				results: [],
				message: 'No relevant memories found.',
			});
		}

		// Also search FTS5 for relevance
		const searchResults = this.sessionStore.searchWithRelevance(query, {
			maxResults: limit,
			sourceTypes: ['memory'],
		});

		return JSON.stringify({
			success: true,
			results: searchResults.map(r => ({
				content: r.content,
				relevance: r.combinedRank ?? r.rank,
				sourceType: r.sourceType,
			})),
			count: searchResults.length,
		});
	}

	private async _handleMemoryDelete(args: Record<string, unknown>): Promise<string> {
		const id = args['id'] as string;
		if (!id) {
			return JSON.stringify({ error: 'id is required' });
		}

		this.sessionStore.deleteMemory(id);

		return JSON.stringify({
			success: true,
			message: `Memory ${id} deleted.`,
		});
	}

	// ── Pre-Compression Hook ────────────────────────────────────

	async onPreCompress(): Promise<string> {
		// Provide relevant memories as additional context for compression summary
		if (!this._currentSessionId) {
			return '';
		}

		const memories = this.sessionStore.getMemories({
			sessionId: this._currentSessionId,
			limit: 10,
			minImportance: 0.6,
		});

		if (memories.length === 0) {
			return '';
		}

		return [
			'## Relevant Memories for Context:',
			...memories.map(m => `- [${m.category}] ${m.content.substring(0, 200)}`),
		].join('\n');
	}
}
