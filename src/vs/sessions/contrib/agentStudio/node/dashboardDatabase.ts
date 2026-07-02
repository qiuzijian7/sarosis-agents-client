/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Dashboard SQLite Database Service
 *
 * 替代原有的 JSON 文件持久化方案（~/.saros/dashboard-stats.json），
 * 将 Dashboard 所有数据存储在 SQLite 数据库中：
 *   ~/.saros/dashboard/dashboard.db
 *
 * 使用 VS Code 内置的 @vscode/sqlite3 原生模块。
 */

import * as fs from 'fs';
import type { Database, RunResult } from '@vscode/sqlite3';
import { dirname } from '../../../../base/common/path.js';

// ---- Types ----

export interface IDashboardMetricsSnapshot {
	/** 快照时间戳（ISO 8601） */
	ts: string;
	/** 累计输入 Token */
	inputTokens: number;
	/** 累计输出 Token */
	outputTokens: number;
	/** 累计缓存 Token */
	cachedTokens: number;
	/** 压缩总次数 */
	compressionCount: number;
	/** 记忆总条数 */
	memoryTotal: number;
	/** 代码图谱节点数 */
	graphNodes: number;
	/** 活跃会话数 */
	sessionCount: number;
	/** 当前活跃模型 */
	activeModel?: string;
}

export interface IDailyBucket {
	day: string;
	input_tokens: number;
	output_tokens: number;
	cached_tokens: number;
	compression_count: number;
	memory_total: number;
	graph_nodes: number;
	session_count: number;
}

export interface IDashboardCumulativeStats {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCachedTokens: number;
	compressionCount: number;
	compressionIneffectiveCount: number;
	compressionBeforeTokens: number;
	compressionAfterTokens: number;
	l1ExtractionCount: number;
	l2ExtractionCount: number;
	l3ExtractionCount: number;
	activeModelId: string;
	/** tool_name → call_count */
	toolCallCounts: Record<string, number>;
}

// ---- Migrations ----

export interface IDashboardDatabaseMigration {
	readonly version: number;
	readonly sql: string;
}

export const dashboardDatabaseMigrations: readonly IDashboardDatabaseMigration[] = [
	{
		version: 1,
		sql: [
			// 累计统计表：替代 JSON 文件
			`CREATE TABLE IF NOT EXISTS cumulative_stats (
				key   TEXT PRIMARY KEY NOT NULL,
				value TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
			// 时间序列快照表：支持趋势图和时间范围查询
			`CREATE TABLE IF NOT EXISTS metrics_snapshots (
				id               INTEGER PRIMARY KEY AUTOINCREMENT,
				ts               TEXT NOT NULL,
				input_tokens     INTEGER DEFAULT 0,
				output_tokens    INTEGER DEFAULT 0,
				cached_tokens    INTEGER DEFAULT 0,
				compression_count INTEGER DEFAULT 0,
				memory_total     INTEGER DEFAULT 0,
				graph_nodes      INTEGER DEFAULT 0,
				session_count    INTEGER DEFAULT 0,
				active_model     TEXT
			)`,
			`CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON metrics_snapshots(ts)`,
			// 工具调用统计表
			`CREATE TABLE IF NOT EXISTS tool_call_stats (
				tool_name  TEXT PRIMARY KEY NOT NULL,
				call_count INTEGER DEFAULT 0,
				last_called TEXT
			)`,
			// 布局配置表
			`CREATE TABLE IF NOT EXISTS dashboard_config (
				key        TEXT PRIMARY KEY NOT NULL,
				value      TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
			// 自定义面板数据表
			`CREATE TABLE IF NOT EXISTS custom_panel_data (
				panel_id     TEXT PRIMARY KEY NOT NULL,
				source_id    TEXT,
				data         TEXT NOT NULL,
				last_updated TEXT NOT NULL
			)`,
			// 数据源注册表
			`CREATE TABLE IF NOT EXISTS custom_data_sources (
				source_id      TEXT PRIMARY KEY NOT NULL,
				name           TEXT NOT NULL,
				interval_ms    INTEGER DEFAULT 0,
				last_collected TEXT
			)`,
		].join(';\n'),
	},
];

// ---- Promise wrappers around callback-based @vscode/sqlite3 API ----

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
		// @vscode/sqlite3 is available via require() in the VS Code extension host
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

// ---- DashboardDatabase class ----

/**
 * 基于 @vscode/sqlite3 的 Dashboard 数据存储服务。
 *
 * 使用方式：
 *   const db = new DashboardDatabase();
 *   await db.initialize('~/.saros/dashboard/dashboard.db');
 *   await db.setStat('totalInputTokens', '847000');
 *   const val = await db.getStat('totalInputTokens');
 *   await db.close();
 */
export class DashboardDatabase {
	private db: Database | undefined;
	private _ready = false;

	/** 获取数据库就绪状态 */
	get ready(): boolean { return this._ready; }

	// ---- Lifecycle ----

	/**
	 * 初始化数据库连接，创建目录并运行迁移。
	 * @param dbPath 数据库文件完整路径
	 */
	async initialize(dbPath: string): Promise<void> {
		// 确保目录存在
		const dir = dirname(dbPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		// 打开数据库
		this.db = await dbOpen(dbPath);
		// 启用外键约束
		await dbExec(this.db, 'PRAGMA foreign_keys = ON');

		// 运行迁移
		await this._runMigrations();

		this._ready = true;
	}

	/**
	 * 关闭数据库连接。
	 */
	async close(): Promise<void> {
		if (this.db) {
			await dbClose(this.db);
			this.db = undefined;
			this._ready = false;
		}
	}

	private async _runMigrations(): Promise<void> {
		if (!this.db) {
			throw new Error('[DashboardDB] Database not initialized');
		}

		const row = await dbGet(this.db, 'PRAGMA user_version', []);
		const currentVersion = (row?.user_version as number | undefined) ?? 0;

		const pending = dashboardDatabaseMigrations
			.filter(m => m.version > currentVersion)
			.sort((a, b) => a.version - b.version);

		for (const migration of pending) {
			await dbExec(this.db, 'BEGIN');
			try {
				await dbExec(this.db, migration.sql);
				await dbExec(this.db, `PRAGMA user_version = ${migration.version}`);
				await dbExec(this.db, 'COMMIT');
			} catch (err) {
				await dbExec(this.db, 'ROLLBACK');
				throw err;
			}
		}
	}

	private _ensureDb(): Database {
		if (!this.db) {
			throw new Error('[DashboardDB] Database not initialized. Call initialize() first.');
		}
		return this.db;
	}

	// ---- Cumulative Stats (累计统计) ----

	/**
	 * 获取单个统计值。
	 */
	async getStat(key: string): Promise<string | null> {
		const db = this._ensureDb();
		const row = await dbGet(db, 'SELECT value FROM cumulative_stats WHERE key = ?', [key]);
		return row ? (row.value as string) : null;
	}

	/**
	 * 设置单个统计值（UPSERT）。
	 */
	async setStat(key: string, value: string): Promise<void> {
		const db = this._ensureDb();
		await dbRun(
			db,
			'INSERT OR REPLACE INTO cumulative_stats (key, value, updated_at) VALUES (?, ?, ?)',
			[key, value, new Date().toISOString()]
		);
	}

	/**
	 * 批量获取所有累计统计。
	 */
	async getAllStats(): Promise<Record<string, string>> {
		const db = this._ensureDb();
		const rows = await dbAll(db, 'SELECT key, value FROM cumulative_stats', []);
		const stats: Record<string, string> = {};
		for (const row of rows) {
			stats[row.key as string] = row.value as string;
		}
		return stats;
	}

	/**
	 * 批量设置累计统计（一次事务）。
	 */
	async setAllStats(stats: Record<string, string>): Promise<void> {
		const db = this._ensureDb();
		await dbExec(db, 'BEGIN');
		try {
			for (const [key, value] of Object.entries(stats)) {
				await dbRun(
					db,
					'INSERT OR REPLACE INTO cumulative_stats (key, value, updated_at) VALUES (?, ?, ?)',
					[key, value, new Date().toISOString()]
				);
			}
			await dbExec(db, 'COMMIT');
		} catch (err) {
			await dbExec(db, 'ROLLBACK');
			throw err;
		}
	}

	// ---- Metrics Snapshots (时间序列快照) ----

	/**
	 * 插入一条时间序列快照。
	 */
	async insertSnapshot(snap: IDashboardMetricsSnapshot): Promise<void> {
		const db = this._ensureDb();
		await dbRun(
			db,
			`INSERT INTO metrics_snapshots
			 (ts, input_tokens, output_tokens, cached_tokens, compression_count,
			  memory_total, graph_nodes, session_count, active_model)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				snap.ts,
				snap.inputTokens,
				snap.outputTokens,
				snap.cachedTokens,
				snap.compressionCount,
				snap.memoryTotal,
				snap.graphNodes,
				snap.sessionCount,
				snap.activeModel ?? '',
			]
		);
	}

	/**
	 * 查询指定时间范围内的快照。
	 * @param rangeMs 向前查询的时间范围（毫秒）
	 */
	async querySnapshots(rangeMs: number): Promise<IDashboardMetricsSnapshot[]> {
		const db = this._ensureDb();
		const cutoff = new Date(Date.now() - rangeMs).toISOString();
		const rows = await dbAll(
			db,
			'SELECT * FROM metrics_snapshots WHERE ts > ? ORDER BY ts ASC',
			[cutoff]
		);
		return rows.map(row => ({
			ts: row.ts as string,
			inputTokens: row.input_tokens as number,
			outputTokens: row.output_tokens as number,
			cachedTokens: row.cached_tokens as number,
			compressionCount: row.compression_count as number,
			memoryTotal: row.memory_total as number,
			graphNodes: row.graph_nodes as number,
			sessionCount: row.session_count as number,
			activeModel: row.active_model as string | undefined,
		}));
	}

	/**
	 * 按天聚合快照（趋势图降采样）。
	 * @param rangeMs 向前查询的时间范围（毫秒）
	 */
	async dailyBuckets(rangeMs: number): Promise<IDailyBucket[]> {
		const db = this._ensureDb();
		const cutoff = new Date(Date.now() - rangeMs).toISOString();
		const rows = await dbAll(
			db,
			`SELECT DATE(ts) AS day,
			        MAX(input_tokens) AS input_tokens,
			        MAX(output_tokens) AS output_tokens,
			        MAX(cached_tokens) AS cached_tokens,
			        MAX(compression_count) AS compression_count,
			        MAX(memory_total) AS memory_total,
			        MAX(graph_nodes) AS graph_nodes,
			        MAX(session_count) AS session_count
			 FROM metrics_snapshots
			 WHERE ts > ?
			 GROUP BY DATE(ts)
			 ORDER BY day ASC`,
			[cutoff]
		);
		return rows.map(row => ({
			day: row.day as string,
			input_tokens: row.input_tokens as number,
			output_tokens: row.output_tokens as number,
			cached_tokens: row.cached_tokens as number,
			compression_count: row.compression_count as number,
			memory_total: row.memory_total as number,
			graph_nodes: row.graph_nodes as number,
			session_count: row.session_count as number,
		}));
	}

	/**
	 * 清理超过指定天数的快照。
	 * @param maxAgeDays 最大保留天数
	 */
	async cleanupOldSnapshots(maxAgeDays: number = 90): Promise<void> {
		const db = this._ensureDb();
		const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
		await dbRun(db, 'DELETE FROM metrics_snapshots WHERE ts < ?', [cutoff]);
		// 回收空间
		await dbExec(db, 'VACUUM');
	}

	// ---- Tool Call Stats (工具调用统计) ----

	/**
	 * 获取所有工具调用计数。
	 */
	async getToolCallCounts(): Promise<Record<string, number>> {
		const db = this._ensureDb();
		const rows = await dbAll(db, 'SELECT tool_name, call_count FROM tool_call_stats', []);
		const counts: Record<string, number> = {};
		for (const row of rows) {
			counts[row.tool_name as string] = row.call_count as number;
		}
		return counts;
	}

	/**
	 * 增加指定工具的调用计数（UPSERT）。
	 */
	async incrementToolCall(toolName: string): Promise<void> {
		const db = this._ensureDb();
		const now = new Date().toISOString();
		await dbRun(
			db,
			`INSERT INTO tool_call_stats (tool_name, call_count, last_called)
			 VALUES (?, 1, ?)
			 ON CONFLICT(tool_name)
			 DO UPDATE SET call_count = call_count + 1, last_called = ?`,
			[toolName, now, now]
		);
	}

	/**
	 * 批量设置工具调用计数（用于从旧数据迁移或从内存同步）。
	 */
	async setToolCallCounts(counts: Record<string, number>): Promise<void> {
		const db = this._ensureDb();
		const now = new Date().toISOString();
		await dbExec(db, 'BEGIN');
		try {
			for (const [toolName, callCount] of Object.entries(counts)) {
				await dbRun(
					db,
					`INSERT OR REPLACE INTO tool_call_stats (tool_name, call_count, last_called)
					 VALUES (?, ?, ?)`,
					[toolName, callCount, now]
				);
			}
			await dbExec(db, 'COMMIT');
		} catch (err) {
			await dbExec(db, 'ROLLBACK');
			throw err;
		}
	}

	// ---- Dashboard Config (布局配置) ----

	/**
	 * 获取配置值。
	 */
	async getConfig(key: string): Promise<unknown | null> {
		const db = this._ensureDb();
		const row = await dbGet(db, 'SELECT value FROM dashboard_config WHERE key = ?', [key]);
		if (!row) { return null; }
		try { return JSON.parse(row.value as string); }
		catch { return null; }
	}

	/**
	 * 设置配置值。
	 */
	async setConfig(key: string, value: unknown): Promise<void> {
		const db = this._ensureDb();
		await dbRun(
			db,
			'INSERT OR REPLACE INTO dashboard_config (key, value, updated_at) VALUES (?, ?, ?)',
			[key, JSON.stringify(value), new Date().toISOString()]
		);
	}

	// ---- Custom Panel Data (自定义面板数据) ----

	/**
	 * 获取自定义面板数据。
	 */
	async getCustomData(panelId: string): Promise<Record<string, unknown> | null> {
		const db = this._ensureDb();
		const row = await dbGet(db, 'SELECT data FROM custom_panel_data WHERE panel_id = ?', [panelId]);
		if (!row) { return null; }
		try { return JSON.parse(row.data as string); }
		catch { return null; }
	}

	/**
	 * 设置自定义面板数据。
	 */
	async setCustomData(panelId: string, sourceId: string, data: Record<string, unknown>): Promise<void> {
		const db = this._ensureDb();
		await dbRun(
			db,
			`INSERT OR REPLACE INTO custom_panel_data (panel_id, source_id, data, last_updated)
			 VALUES (?, ?, ?, ?)`,
			[panelId, sourceId, JSON.stringify(data), new Date().toISOString()]
		);
	}

	// ---- Custom Data Sources (数据源注册) ----

	/**
	 * 注册数据源。
	 */
	async registerDataSource(sourceId: string, name: string, intervalMs: number = 0): Promise<void> {
		const db = this._ensureDb();
		await dbRun(
			db,
			`INSERT OR REPLACE INTO custom_data_sources (source_id, name, interval_ms, last_collected)
			 VALUES (?, ?, ?, ?)`,
			[sourceId, name, intervalMs, null]
		);
	}

	/**
	 * 更新数据源的最后采集时间。
	 */
	async updateDataSourceCollected(sourceId: string): Promise<void> {
		const db = this._ensureDb();
		await dbRun(
			db,
			'UPDATE custom_data_sources SET last_collected = ? WHERE source_id = ?',
			[new Date().toISOString(), sourceId]
		);
	}
}
