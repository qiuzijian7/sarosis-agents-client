/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { URI } from '../../../../base/common/uri.js';
import type { Database, RunResult } from '@vscode/sqlite3';
import type { ICheckpoint, IFileSnapshot, IFileSnapshotData } from '../common/checkpointTypes.js';
import { dirname } from '../../../../base/common/path.js';
import type { ILogService } from '../../../../platform/log/common/log.js';

/**
 * A single numbered migration. Migrations are applied in order of
 * {@link version} and tracked via `PRAGMA user_version`.
 */
export interface ICheckpointDatabaseMigration {
	/** Monotonically-increasing version number (1-based). */
	readonly version: number;
	/** SQL to execute for this migration. */
	readonly sql: string;
}

/**
 * The set of migrations that define the current checkpoint database schema.
 * New migrations should be **appended** to this array with the next version
 * number. Never reorder or mutate existing entries.
 */
export const checkpointDatabaseMigrations: readonly ICheckpointDatabaseMigration[] = [
	{
		// v1: checkpoint schema keyed by agent_id (the sole identity field).
		version: 1,
		sql: [
			`CREATE TABLE IF NOT EXISTS checkpoints (
				id            TEXT PRIMARY KEY NOT NULL,
				agent_id      TEXT NOT NULL,
				session_id    TEXT NOT NULL,
				type          TEXT NOT NULL,
				label         TEXT NOT NULL,
				description   TEXT,
				created_at    INTEGER NOT NULL,
				is_ghost      INTEGER NOT NULL DEFAULT 0,
				message_id    TEXT
			)`,
			`CREATE TABLE IF NOT EXISTS file_snapshots (
				id            TEXT PRIMARY KEY NOT NULL,
				checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
				uri           TEXT NOT NULL,
				language_id   TEXT,
				content       TEXT NOT NULL,
				created_at    INTEGER NOT NULL
			)`,
			`CREATE INDEX IF NOT EXISTS idx_file_snapshots_checkpoint_id
				ON file_snapshots(checkpoint_id)`,
			`CREATE INDEX IF NOT EXISTS idx_checkpoints_agent_session
				ON checkpoints(agent_id, session_id)`,
		].join(';\n'),
	},
];

// ---- Promise wrappers around callback-based @vscode/sqlite3 API -------------------

function dbExec(db: Database, sql: string): Promise<void> {
	return new Promise((resolve, reject) => {
		db.exec(sql, err => err ? reject(err) : resolve());
	});
}

function dbRun(db: Database, sql: string, params: unknown[]): Promise<{ changes: number; lastID: number }> {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function (this: RunResult, err: Error | null) {
			if (err) {
				return reject(err);
			}
			resolve({ changes: this.changes, lastID: this.lastID });
		});
	});
}

function dbGet(db: Database, sql: string, params: unknown[]): Promise<Record<string, unknown> | undefined> {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (err: Error | null, row: Record<string, unknown> | undefined) => {
			if (err) {
				return reject(err);
			}
			resolve(row);
		});
	});
}

function dbAll(db: Database, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err: Error | null, rows: Record<string, unknown>[]) => {
			if (err) {
				return reject(err);
			}
			resolve(rows);
		});
	});
}

function dbClose(db: Database): Promise<void> {
	return new Promise((resolve, reject) => {
		db.close(err => err ? reject(err) : resolve());
	});
}

function dbOpen(path: string): Promise<Database> {
	return new Promise((resolve, reject) => {
		// In VS Code extension host, @vscode/sqlite3 should be available via require()
		// eslint-disable-next-line local/code-no-var-require
		const sqlite3 = require('@vscode/sqlite3');
		const db = new sqlite3.Database(path, (err: Error | null) => {
			if (err) {
				return reject(err);
			}
			resolve(db);
		});
	});
}

// ---- CheckpointStorage class ---------------------------------------------

export class CheckpointStorage {
	private db: Database | undefined;

	constructor(private readonly logService: ILogService) {}

	/**
	 * Initialize the database connection and run any pending migrations.
	 */
	async initialize(dbPath: string): Promise<void> {

		// Ensure directory exists
		const dir = dirname(dbPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		// Open database
		this.db = await dbOpen(dbPath);
		this.logService.info(`[CheckpointStorage] Opened database: ${dbPath}`);

		// Run migrations
		await this.runMigrations();
	}

	/**
	 * Close the database connection.
	 */
	async close(): Promise<void> {
		if (this.db) {
			await dbClose(this.db);
			this.db = undefined;
			this.logService.info('[CheckpointStorage] Closed database');
		}
	}

	/**
	 * Run any pending migrations.
	 */
	private async runMigrations(): Promise<void> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		// Get current user_version
		const pragmaRow = await dbGet(this.db, 'PRAGMA user_version', []);
		const currentVersion = (pragmaRow?.user_version as number) || 0;
		this.logService.info(`[CheckpointStorage] Current DB version: ${currentVersion}`);

		// Apply pending migrations
		for (const migration of checkpointDatabaseMigrations) {
			if (migration.version > currentVersion) {
				this.logService.info(`[CheckpointStorage] Applying migration v${migration.version}`);
				await dbExec(this.db, 'BEGIN');
				try {
					await dbExec(this.db, migration.sql);
					await dbExec(this.db, `PRAGMA user_version = ${migration.version}`);
					await dbExec(this.db, 'COMMIT');
					this.logService.info(`[CheckpointStorage] Migration v${migration.version} applied successfully`);
				} catch (err) {
					await dbExec(this.db, 'ROLLBACK');
					this.logService.error(`[CheckpointStorage] Migration v${migration.version} failed: ${err}`);
					throw err;
				}
			}
		}
	}

	// ---- Checkpoint operations -------------------------------------------------

	/**
	 * Create a new checkpoint with its file snapshots.
	 */
	async createCheckpoint(
		checkpoint: ICheckpoint,
		fileSnapshots: IFileSnapshotData[],
	): Promise<void> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		await dbExec(this.db, 'BEGIN');
		try {
			// Insert checkpoint (agent_id is the sole identity field).
			await dbRun(
				this.db,
				`INSERT INTO checkpoints (id, agent_id, session_id, type, label, description, created_at, is_ghost, message_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					checkpoint.id,
					checkpoint.agentId,
					checkpoint.sessionId,
					checkpoint.type,
					checkpoint.label,
					checkpoint.description ?? null,
					checkpoint.createdAt,
					checkpoint.isGhost ? 1 : 0,
					checkpoint.messageId ?? null,
				],
			);

			// Insert file snapshots
			for (const snapshot of fileSnapshots) {
				const snapshotId = `${checkpoint.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				await dbRun(
					this.db,
					`INSERT INTO file_snapshots (id, checkpoint_id, uri, language_id, content, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					[
						snapshotId,
						checkpoint.id,
						snapshot.uri.toString(),
						snapshot.languageId ?? null,
						snapshot.content,
						Date.now(),
					],
				);
			}

			await dbExec(this.db, 'COMMIT');
			this.logService.info(`[CheckpointStorage] Created checkpoint: ${checkpoint.id} with ${fileSnapshots.length} snapshots`);
		} catch (err) {
			await dbExec(this.db, 'ROLLBACK');
			this.logService.error(`[CheckpointStorage] Failed to create checkpoint: ${err}`);
			throw err;
		}
	}

	/**
	 * Get a checkpoint by ID.
	 */
	async getCheckpoint(checkpointId: string): Promise<ICheckpoint | undefined> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		const row = await dbGet(
			this.db,
			`SELECT * FROM checkpoints WHERE id = ?`,
			[checkpointId],
		);

		if (!row) {
			return undefined;
		}

		return this.rowToCheckpoint(row);
	}

	/**
	 * Get all checkpoints for an agent+session.
	 * Query by agent_id only.
	 */
	async listCheckpoints(agentId: string, sessionId: string): Promise<ICheckpoint[]> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		const rows = await dbAll(
			this.db,
			`SELECT * FROM checkpoints
			 WHERE agent_id = ? AND session_id = ?
			 ORDER BY created_at ASC`,
			[agentId, sessionId],
		);

		return rows.map(row => this.rowToCheckpoint(row));
	}

	/**
	 * Delete a checkpoint and its file snapshots (cascade).
	 */
	async deleteCheckpoint(checkpointId: string): Promise<void> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		const result = await dbRun(
			this.db,
			`DELETE FROM checkpoints WHERE id = ?`,
			[checkpointId],
		);

		this.logService.info(`[CheckpointStorage] Deleted checkpoint: ${checkpointId} (${result.changes} rows)`);
	}

	/**
	 * Update checkpoint (label, description, isGhost).
	 */
	async updateCheckpoint(
		checkpointId: string,
		updates: Partial<Pick<ICheckpoint, 'label' | 'description' | 'isGhost'>>,
	): Promise<void> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		const setClauses: string[] = [];
		const params: unknown[] = [];

		if (updates.label !== undefined) {
			setClauses.push('label = ?');
			params.push(updates.label);
		}
		if (updates.description !== undefined) {
			setClauses.push('description = ?');
			params.push(updates.description);
		}
		if (updates.isGhost !== undefined) {
			setClauses.push('is_ghost = ?');
			params.push(updates.isGhost ? 1 : 0);
		}

		if (setClauses.length === 0) {
			return;
		}

		params.push(checkpointId);
		await dbRun(
			this.db,
			`UPDATE checkpoints SET ${setClauses.join(', ')} WHERE id = ?`,
			params,
		);

		this.logService.info(`[CheckpointStorage] Updated checkpoint: ${checkpointId}`);
	}

	// ---- File snapshot operations -----------------------------------------------

	/**
	 * Get all file snapshots for a checkpoint.
	 */
	async getFileSnapshots(checkpointId: string): Promise<IFileSnapshot[]> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		const rows = await dbAll(
			this.db,
			`SELECT * FROM file_snapshots WHERE checkpoint_id = ?`,
			[checkpointId],
		);

		return rows.map(row => this.rowToFileSnapshot(row));
	}

	/**
	 * Get a single file snapshot by ID.
	 */
	async getFileSnapshot(snapshotId: string): Promise<IFileSnapshot | undefined> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		const row = await dbGet(
			this.db,
			`SELECT * FROM file_snapshots WHERE id = ?`,
			[snapshotId],
		);

		if (!row) {
			return undefined;
		}

		return this.rowToFileSnapshot(row);
	}

	// ---- Helper methods -------------------------------------------------------

	private rowToCheckpoint(row: Record<string, unknown>): ICheckpoint {
		// agent_id is the sole identity field.
		return {
			id: row.id as string,
			agentId: row.agent_id as string,
			sessionId: row.session_id as string,
			type: row.type as 'user_edit' | 'tool_edit',
			label: row.label as string,
			description: row.description as string | undefined,
			createdAt: row.created_at as number,
			fileSnapshotIds: [], // TODO: fetch separately if needed
			isGhost: (row.is_ghost as number) === 1,
			messageId: row.message_id as string | undefined,
		};
	}

	private rowToFileSnapshot(row: Record<string, unknown>): IFileSnapshot {
		return {
			id: row.id as string,
			checkpointId: row.checkpoint_id as string,
			uri: URI.parse(row.uri as string),
			languageId: row.language_id as string | undefined,
			content: row.content as string,
		};
	}
}
