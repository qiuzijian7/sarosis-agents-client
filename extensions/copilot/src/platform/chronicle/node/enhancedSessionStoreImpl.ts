/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from './sessionStore.js';
import type { IEnhancedSessionStore, IMemoryEntry, IMemoryFilter, ISearchOptions, IEnhancedSearchResult, ICompressionLogEntry } from '../common/enhancedSessionStore.js';

// ── Schema Version (bumped to 4 for memories and compression_log tables) ───

const SCHEMA_VERSION = 4;

/**
 * Enhanced Session Store that extends the base SessionStore with:
 * - memories table for cross-session memory management
 * - compression_log table for compression history
 * - Enhanced FTS5 search with relevance scoring
 *
 * This class handles schema migration from v3 to v4.
 */
export class EnhancedSessionStore extends SessionStore implements IEnhancedSessionStore {
	declare readonly _serviceBrand: undefined;

	// ── Constructor ──────────────────────────────────────────────────────

	private _enhancedSchemaReady = false;

	constructor(dbPath: string) {
		super(dbPath);
	}

	// ── Schema Migration (add v4 migration on top of parent) ─────────────

	private ensureEnhancedSchema(db: DatabaseSync): void {
		if (this._enhancedSchemaReady) {
			return;
		}
		this._enhancedSchemaReady = true;

		// Check current schema version
		const versionRow = (() => {
			try {
				const stmt = db.prepare('SELECT version FROM schema_version LIMIT 1');
				return stmt.get() as unknown as { version: number } | undefined;
			} catch {
				return undefined;
			}
		})();

		const currentVersion = versionRow?.version ?? 0;

		if (currentVersion >= SCHEMA_VERSION) {
			return;
		}

		// ── Migration v3 → v4: Add memories and compression_log tables ──

		if (currentVersion < 4) {
			// Create memories table
			db.exec(`
				CREATE TABLE IF NOT EXISTS memories (
					id            TEXT    PRIMARY KEY,
					session_id    TEXT    REFERENCES sessions(id),
					category      TEXT    NOT NULL DEFAULT 'general',
					content       TEXT    NOT NULL,
					importance    REAL    NOT NULL DEFAULT 0.5,
					access_count  INTEGER NOT NULL DEFAULT 0,
					created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
					updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
					expires_at    TEXT,
					source        TEXT    NOT NULL DEFAULT 'auto'
				);

				CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
				CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
				CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
			`);

			// Create compression_log table
			db.exec(`
				CREATE TABLE IF NOT EXISTS compression_log (
					id                INTEGER PRIMARY KEY AUTOINCREMENT,
					session_id        TEXT    NOT NULL REFERENCES sessions(id),
					compressed_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
					strategy          TEXT    NOT NULL,
					input_tokens      INTEGER,
					output_tokens     INTEGER,
					turns_compressed  INTEGER,
					turns_preserved   INTEGER,
					savings_percent   REAL,
					summary_preview   TEXT
				);

				CREATE INDEX IF NOT EXISTS idx_compression_session ON compression_log(session_id);
			`);

			// Update schema version to 4
			db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
		}
	}

	// ── Private Helpers ──────────────────────────────────────────────────

	private override ensureDb(): DatabaseSync {
		// Access parent's private ensureDb() via prototype to avoid infinite recursion
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const db = (SessionStore.prototype as any).ensureDb.call(this) as DatabaseSync;
		// Run v4 migration (memories + compression_log) on first access
		this.ensureEnhancedSchema(db);
		return db;
	}

	private generateId(): string {
		return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}

	// ── Memory Operations ────────────────────────────────────────────────

	insertMemory(entry: Omit<IMemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'accessCount'>): string {
		const db = this.ensureDb();
		const id = this.generateId();
		const now = new Date().toISOString();

		db.prepare(`
			INSERT INTO memories (id, session_id, category, content, importance, access_count, created_at, updated_at, expires_at, source)
			VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
		`).run(
			id,
			entry.sessionId ?? null,
			entry.category ?? 'general',
			entry.content,
			entry.importance ?? 0.5,
			now,
			now,
			entry.expiresAt ?? null,
			entry.source ?? 'auto'
		);

		// Index memory content in FTS5
		const sourceId = `memory:${id}`;
		db.prepare('DELETE FROM search_index WHERE source_id = ?').run(sourceId);
		db.prepare(
			'INSERT INTO search_index (content, session_id, source_type, source_id) VALUES (?, ?, ?, ?)'
		).run(
			entry.content,
			entry.sessionId ?? '',
			'memory',
			sourceId
		);

		return id;
	}

	updateMemory(id: string, updates: Partial<Omit<IMemoryEntry, 'id' | 'createdAt' | 'updatedAt'>>): void {
		const db = this.ensureDb();
		const now = new Date().toISOString();

		const sets: string[] = [];
		const values: (string | number | null)[] = [];

		if (updates.category !== undefined) { sets.push('category = ?'); values.push(updates.category); }
		if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
		if (updates.importance !== undefined) { sets.push('importance = ?'); values.push(updates.importance); }
		if (updates.accessCount !== undefined) { sets.push('access_count = ?'); values.push(updates.accessCount); }
		if (updates.expiresAt !== undefined) { sets.push('expires_at = ?'); values.push(updates.expiresAt); }
		if (updates.source !== undefined) { sets.push('source = ?'); values.push(updates.source); }

		sets.push('updated_at = ?');
		values.push(now);
		values.push(id);

		if (sets.length > 0) {
			db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values);
		}

		// Re-index in FTS5 if content changed
		if (updates.content !== undefined) {
			const memory = this.getMemoryById(id);
			if (memory) {
				const sourceId = `memory:${id}`;
				db.prepare('DELETE FROM search_index WHERE source_id = ?').run(sourceId);
				db.prepare(
					'INSERT INTO search_index (content, session_id, source_type, source_id) VALUES (?, ?, ?, ?)'
				).run(
					updates.content,
					memory.sessionId ?? '',
					'memory',
					sourceId
				);
			}
		}
	}

	deleteMemory(id: string): void {
		const db = this.ensureDb();

		// Remove from FTS5
		db.prepare('DELETE FROM search_index WHERE source_id = ?').run(`memory:${id}`);

		// Remove from memories table
		db.prepare('DELETE FROM memories WHERE id = ?').run(id);
	}

	getMemories(filter?: IMemoryFilter): IMemoryEntry[] {
		const db = this.ensureDb();

		let sql = 'SELECT * FROM memories WHERE 1=1';
		const params: (string | number | null)[] = [];

		if (filter?.category) {
			sql += ' AND category = ?';
			params.push(filter.category);
		}

		if (filter?.sessionId) {
			sql += ' AND (session_id = ? OR session_id IS NULL)';
			params.push(filter.sessionId);
		}

		if (filter?.minImportance !== undefined) {
			sql += ' AND importance >= ?';
			params.push(filter.minImportance);
		}

		if (!filter?.includeExpired) {
			sql += " AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
		}

		sql += ' ORDER BY importance DESC, access_count DESC';

		if (filter?.limit) {
			sql += ' LIMIT ?';
			params.push(filter.limit);
		}

		const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

		return rows.map(row => this.rowToMemoryEntry(row));
	}

	incrementMemoryAccess(id: string): void {
		const db = this.ensureDb();
		db.prepare('UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?')
			.run(new Date().toISOString(), id);
	}

	private getMemoryById(id: string): IMemoryEntry | undefined {
		const db = this.ensureDb();
		const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
		return row ? this.rowToMemoryEntry(row) : undefined;
	}

	private rowToMemoryEntry(row: Record<string, unknown>): IMemoryEntry {
		return {
			id: row['id'] as string,
			sessionId: row['session_id'] as string | undefined,
			category: row['category'] as IMemoryEntry['category'],
			content: row['content'] as string,
			importance: row['importance'] as number,
			accessCount: row['access_count'] as number,
			createdAt: row['created_at'] as string,
			updatedAt: row['updated_at'] as string,
			expiresAt: row['expires_at'] as string | undefined,
			source: row['source'] as IMemoryEntry['source'],
		};
	}

	// ── Enhanced Search ──────────────────────────────────────────────────

	searchWithRelevance(query: string, options?: ISearchOptions): IEnhancedSearchResult[] {
		const db = this.ensureDb();

		let sql = `
			SELECT
				si.content,
				si.session_id,
				si.source_type,
				si.source_id,
				bm25(search_index) AS rank
		`;

		// Optionally join with memories table for importance weighting
		if (options?.sourceTypes?.includes('memory') || !options?.sourceTypes) {
			sql += `,
				COALESCE(m.importance, 0.5) AS importance,
				bm25(search_index) * (1.0 + COALESCE(m.importance, 0.0)) AS combined_rank
			`;
		} else {
			sql += `,
				0.5 AS importance,
				bm25(search_index) AS combined_rank
			`;
		}

		sql += `
			FROM search_index si
		`;

		// Left join with memories for importance weighting
		sql += `
			LEFT JOIN memories m ON si.source_id = 'memory:' || m.id
		`;

		// WHERE clause
		sql += ` WHERE search_index MATCH ?`;
		const params: (string | number | null)[] = [query];

		if (options?.sourceTypes) {
			const placeholders = options.sourceTypes.map(() => '?').join(',');
			sql += ` AND si.source_type IN (${placeholders})`;
			params.push(...options.sourceTypes);
		}

		if (options?.sessionId) {
			sql += ` AND si.session_id = ?`;
			params.push(options.sessionId);
		}

		// ORDER BY combined rank
		sql += ` ORDER BY combined_rank`;

		if (options?.maxResults) {
			sql += ` LIMIT ?`;
			params.push(options.maxResults);
		}

		const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

		return rows.map(row => ({
			content: row['content'] as string,
			sessionId: row['session_id'] as string,
			sourceType: row['source_type'] as string,
			sourceId: row['source_id'] as string,
			rank: row['rank'] as number,
			importance: row['importance'] as number | undefined,
			combinedRank: row['combined_rank'] as number | undefined,
		}));
	}

	// ── Compression Log ─────────────────────────────────────────────────

	logCompression(entry: Omit<ICompressionLogEntry, 'id' | 'compressedAt'>): void {
		const db = this.ensureDb();
		db.prepare(`
			INSERT INTO compression_log
				(session_id, strategy, input_tokens, output_tokens, turns_compressed, turns_preserved, savings_percent, summary_preview)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			entry.sessionId,
			entry.strategy,
			entry.inputTokens ?? null,
			entry.outputTokens ?? null,
			entry.turnsCompressed,
			entry.turnsPreserved,
			entry.savingsPercent ?? null,
			entry.summaryPreview ?? null
		);
	}

	getCompressionHistory(sessionId: string): ICompressionLogEntry[] {
		const db = this.ensureDb();
		const rows = db.prepare(
			'SELECT * FROM compression_log WHERE session_id = ? ORDER BY compressed_at DESC'
		).all(sessionId) as Array<Record<string, unknown>>;

		return rows.map(row => this.rowToCompressionLogEntry(row));
	}

	getLatestCompression(sessionId: string): ICompressionLogEntry | undefined {
		const db = this.ensureDb();
		const row = db.prepare(
			'SELECT * FROM compression_log WHERE session_id = ? ORDER BY compressed_at DESC LIMIT 1'
		).get(sessionId) as Record<string, unknown> | undefined;

		return row ? this.rowToCompressionLogEntry(row) : undefined;
	}

	private rowToCompressionLogEntry(row: Record<string, unknown>): ICompressionLogEntry {
		return {
			id: row['id'] as number,
			sessionId: row['session_id'] as string,
			compressedAt: row['compressed_at'] as string,
			strategy: row['strategy'] as ICompressionLogEntry['strategy'],
			inputTokens: row['input_tokens'] as number | undefined,
			outputTokens: row['output_tokens'] as number | undefined,
			turnsCompressed: row['turns_compressed'] as number,
			turnsPreserved: row['turns_preserved'] as number,
			savingsPercent: row['savings_percent'] as number | undefined,
			summaryPreview: row['summary_preview'] as string | undefined,
		};
	}

	// ── IDisposable ─────────────────────────────────────────────────────

	dispose(): void {
		super.close();
	}
}
