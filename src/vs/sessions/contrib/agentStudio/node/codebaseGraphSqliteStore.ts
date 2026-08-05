/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Graph — SQLite mmap-backed store (Phase 2 根治 V8 4GB)
 * =================================================================
 *
 * 背景：原 `browser/codebaseGraphStore.ts` 把整张图（nodes/edges/多层索引/BM25）
 * 常驻 renderer 的 V8 堆。大项目（百万级节点）会撑爆 4GB 上限 → OOM 崩溃。
 *
 * 本存储把图数据搬到 **node/main 进程的 SQLite 文件**，关键设计：
 *   1. `PRAGMA mmap_size` 把 DB 文件映射进 OS 页缓存（进程原生堆，非 V8 JS 堆），
 *      图本体只留在磁盘，renderer 经 IPC 只取「查询结果」→ 绕开 V8 4GB。
 *   2. **FTS5 虚拟表替代内存 BM25Index**：全文检索走 SQLite，不再在 JS 堆建全量倒排。
 *   3. 节点 id 用 `INTEGER PRIMARY KEY` + `RETURNING`，边按数字 id 关联；
 *      **不维护内存 qn→id Map**（否则 node 进程自身也会撞 V8 4GB），id 解析走 SQL 索引。
 *   4. 所有方法 async —— 既适配未来 renderer→node 的 IPC 代理，也避免同步重活冻结。
 *
 * 与 `node/dashboardDatabase.ts` 同构：使用 VS Code 内置 `@vscode/sqlite3` 原生模块 +
 * Promise 包装 + 迁移。renderer（sandbox）不能直接 require 原生模块，故本文件只能跑在
 * node/main 进程，renderer 侧通过 IPC 代理（`ICodebaseGraphService` 子集）访问。
 */

import * as fs from 'fs';
import { createRequire } from 'node:module';
import { dirname } from '../../../../base/common/path.js';
import type { Database, RunResult } from '@vscode/sqlite3';
// 仅类型导入：esbuild/tsc 会擦除，不会把 renderer 代码打进 node bundle
import type { GraphNode, GraphEdge, VisualizationNode } from '../browser/codebaseGraphService.js';

// ---- Promise wrappers around callback-based @vscode/sqlite3 API ----

function dbExec(db: Database, sql: string): Promise<void> {
	return new Promise((resolve, reject) => {
		db.exec(sql, err => err ? reject(err) : resolve());
	});
}

function dbRun(db: Database, sql: string, params: unknown[]): Promise<{ changes: number; lastID: number }> {
	return new Promise((resolve, reject) => {
		db.run(sql, params, function (this: RunResult, err: Error | null) {
			if (err) { return reject(err); }
			resolve({ changes: this.changes, lastID: this.lastID });
		});
	});
}

function dbGet(db: Database, sql: string, params: unknown[]): Promise<Record<string, unknown> | undefined> {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (err: Error | null, row: Record<string, unknown> | undefined) => {
			if (err) { return reject(err); }
			resolve(row);
		});
	});
}

function dbAll(db: Database, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err: Error | null, rows: Record<string, unknown>[]) => {
			if (err) { return reject(err); }
			resolve(rows);
		});
	});
}

function dbClose(db: Database): Promise<void> {
	return new Promise((resolve, reject) => {
		db.close(err => err ? reject(err) : resolve());
	});
}

// makeSQLiteRequire 返回 getter 在 dbOpen 内部延迟调用，避免顶层 `new Promise` + 
// `createRequire` 组合被 VS Code renderer 侧的模块解析器意外触发。
let _sqliteRequire: ReturnType<typeof createRequire> | undefined;
function makeSQLiteRequire(): NodeRequire {
	if (!_sqliteRequire) {
		_sqliteRequire = createRequire(import.meta.url);
	}
	return _sqliteRequire;
}

function dbOpen(path: string): Promise<Database> {
	return new Promise((resolve, reject) => {
		const sqlite3 = makeSQLiteRequire()('@vscode/sqlite3');
		const db = new sqlite3.Database(path, (err: Error | null) => {
			if (err) { return reject(err); }
			resolve(db);
		});
	});
}

// ---- mmap window: DB 文件可远大于此值（SQLite 按需映射窗口），仅限制单次映射量 ----
const MMAP_SIZE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB 映射窗口

// ---- Migrations ----

export interface IGraphStoreMigration {
	readonly version: number;
	readonly sql: string;
}

export const graphStoreMigrations: readonly IGraphStoreMigration[] = [
	{
		version: 1,
		sql: [
			// 节点表：id 为整数主键，避免字符串 id 的存储/比较开销
			`CREATE TABLE IF NOT EXISTS nodes (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				project         TEXT    NOT NULL,
				name            TEXT    NOT NULL DEFAULT '',
				label           TEXT    NOT NULL DEFAULT '',
				type            TEXT    NOT NULL DEFAULT '',
				qualified_name  TEXT    NOT NULL DEFAULT '',
				file_path       TEXT,
				start_line      INTEGER,
				end_line        INTEGER,
				in_degree       INTEGER NOT NULL DEFAULT 0,
				out_degree      INTEGER NOT NULL DEFAULT 0,
				properties_json TEXT    NOT NULL DEFAULT '{}',
				UNIQUE(project, qualified_name)
			)`,
			`CREATE INDEX IF NOT EXISTS idx_nodes_project   ON nodes(project)`,
			`CREATE INDEX IF NOT EXISTS idx_nodes_file     ON nodes(file_path)`,
			`CREATE INDEX IF NOT EXISTS idx_nodes_qn       ON nodes(project, qualified_name)`,
			`CREATE INDEX IF NOT EXISTS idx_nodes_type     ON nodes(type)`,
			`CREATE INDEX IF NOT EXISTS idx_nodes_degree   ON nodes((in_degree + out_degree) DESC)`,

			// 边表：source/target 为节点整数 id
			`CREATE TABLE IF NOT EXISTS edges (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				source          INTEGER NOT NULL,
				target          INTEGER NOT NULL,
				type            TEXT    NOT NULL DEFAULT '',
				properties_json TEXT    NOT NULL DEFAULT '{}'
			)`,
			`CREATE INDEX IF NOT EXISTS idx_edges_source   ON edges(source)`,
			`CREATE INDEX IF NOT EXISTS idx_edges_target   ON edges(target)`,
			`CREATE INDEX IF NOT EXISTS idx_edges_rel      ON edges(source, type)`,

			// 文件哈希（增量索引用）：整体 JSON 存储，规避 FileHash 结构耦合
			`CREATE TABLE IF NOT EXISTS file_hashes (
				key         TEXT PRIMARY KEY,
				data_json   TEXT NOT NULL
			)`,

			// 布局缓存（可视化坐标）
			`CREATE TABLE IF NOT EXISTS layout (
				node_id INTEGER PRIMARY KEY,
				x       REAL NOT NULL DEFAULT 0,
				y       REAL NOT NULL DEFAULT 0,
				z       REAL NOT NULL DEFAULT 0
			)`,

			// FTS5 全文索引（替代内存 BM25Index）：自带内容、rowid 对齐 nodes.id
			// 注：不使用 contentless（'content='）模式，因其不支持 'rebuild' 整表重建。
			`CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
				name, qualified_name, file_path, body,
				tokenize='unicode61'
			)`,
		].join(';\n'),
	},
];

// ---- Row → GraphNode 映射 ----

interface NodeRow {
	id: number;
	project: string;
	name: string;
	label: string;
	type: string;
	qualified_name: string;
	file_path: string | null;
	start_line: number | null;
	end_line: number | null;
	in_degree: number;
	out_degree: number;
	properties_json: string;
}

function rowToNode(r: NodeRow): GraphNode {
	const properties = safeParseJSON(r.properties_json);
	return {
		id: String(r.id),
		name: r.name,
		type: r.type || r.label,
		label: r.label || r.type,
		filePath: r.file_path ?? undefined,
		qualifiedName: r.qualified_name || undefined,
		inDegree: r.in_degree,
		outDegree: r.out_degree,
		startLine: r.start_line ?? undefined,
		endLine: r.end_line ?? undefined,
		project: r.project,
		properties,
	};
}

function safeParseJSON(s: string): Record<string, any> {
	try { return JSON.parse(s); } catch { return {}; }
}

interface EdgeRow {
	id: number;
	source: number;
	target: number;
	type: string;
	properties_json: string;
}

function rowToEdge(r: EdgeRow): GraphEdge {
	return {
		source: String(r.source),
		target: String(r.target),
		type: r.type,
		properties: safeParseJSON(r.properties_json),
	};
}

// ---- Visualization helpers (移植自 browser 端 _nodeSize / _stellarColor) ----

function nodeSize(connections: number): number {
	if (connections >= 100) { return 18; }
	if (connections >= 50) { return 14; }
	if (connections >= 20) { return 10; }
	if (connections >= 10) { return 8; }
	if (connections >= 5) { return 6; }
	return 4;
}

function stellarColor(connections: number): string {
	if (connections >= 100) { return '#ff4d4f'; } // 红 — 枢纽
	if (connections >= 50) { return '#ff9f40'; }  // 橙
	if (connections >= 20) { return '#ffd666'; }  // 黄
	if (connections >= 10) { return '#73d13d'; }  // 绿
	if (connections >= 5) { return '#40a9ff'; }   // 蓝
	return '#9254de';                              // 紫 — 叶节点
}

function fnv1a(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

// ---- Store class ----

export interface IGraphStoreOpenOptions {
	/** 覆盖默认 mmap 窗口（字节）。DB 文件本身可远大于此值。 */
	mmapSizeBytes?: number;
	/** 只读打开（用于仅需查询、不写入的场景） */
	readOnly?: boolean;
}

export class CodebaseGraphSqliteStore {
	private db: Database | undefined;
	private _ready = false;
	private _dbPath = '';
	private _mmap = MMAP_SIZE_BYTES;

	get ready(): boolean { return this._ready; }
	get dbPath(): string { return this._dbPath; }

	async open(dbPath: string, opts: IGraphStoreOpenOptions = {}): Promise<void> {
		this._dbPath = dbPath;
		this._mmap = opts.mmapSizeBytes ?? MMAP_SIZE_BYTES;
		const dir = dirname(dbPath);
		if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

		const openPath = opts.readOnly ? `${dbPath}?mode=ro` : dbPath;
		this.db = await dbOpen(openPath);

		// 关键：mmap 把 DB 文件映射进 OS 页缓存（进程原生堆，非 V8 堆）
		await dbExec(this.db, `PRAGMA mmap_size = ${this._mmap}`);
		await dbExec(this.db, 'PRAGMA journal_mode = WAL');
		await dbExec(this.db, 'PRAGMA synchronous = NORMAL');
		// 多开（--instance）：并发写时等待锁释放而非立即 SQLITE_BUSY（5s 上限）
		await dbExec(this.db, 'PRAGMA busy_timeout = 5000');
		// 页面缓存（负数表示 KiB）：-131072 = 128 MiB
		await dbExec(this.db, 'PRAGMA cache_size = -131072');
		await dbExec(this.db, 'PRAGMA foreign_keys = OFF');

		await this._runMigrations();
		this._ready = true;
	}

	async close(): Promise<void> {
		if (this.db) {
			await dbClose(this.db);
			this.db = undefined;
		}
		this._ready = false;
	}

	private _ensureDb(): Database {
		if (!this.db) { throw new Error('[GraphSqliteStore] not opened; call open() first'); }
		return this.db;
	}

	private async _runMigrations(): Promise<void> {
		const db = this._ensureDb();
		const row = await dbGet(db, 'PRAGMA user_version', []);
		const current = (row?.user_version as number | undefined) ?? 0;
		const pending = graphStoreMigrations
			.filter(m => m.version > current)
			.sort((a, b) => a.version - b.version);
		for (const m of pending) {
			await dbExec(db, 'BEGIN');
			try {
				await dbExec(db, m.sql);
				await dbExec(db, `PRAGMA user_version = ${m.version}`);
				await dbExec(db, 'COMMIT');
			} catch (err) {
				await dbExec(db, 'ROLLBACK');
				throw err;
			}
		}
	}

	// ─── Write path ───────────────────────────────────────────────────────

	/**
	 * 批量写入包装：在事务内执行，百万级节点也不会逐条 fsync。
	 * 回调里可多次调用 upsertNode / upsertEdge 等。
	 */
	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		const db = this._ensureDb();
		await dbExec(db, 'BEGIN');
		try {
			const r = await fn();
			await dbExec(db, 'COMMIT');
			return r;
		} catch (err) {
			await dbExec(db, 'ROLLBACK');
			throw err;
		}
	}

	/**
	 * 插入或更新单个节点。返回其整数 id（供边关联）。
	 * 支持调用方显式指定 id（重新加载既有 artifact 时保持边引用一致）。
	 */
	async upsertNode(node: GraphNode & { id?: string | number }): Promise<number> {
		const db = this._ensureDb();
		const project = node.project ?? '_default';
		const qn = node.qualifiedName ?? '';
		const label = node.label ?? node.type ?? '';
		const type = node.type ?? node.label ?? '';
		const props = JSON.stringify(node.properties ?? {});
		const explicitId = node.id !== undefined ? Number(node.id) : undefined;

		if (explicitId !== undefined) {
			await dbRun(db,
				`INSERT INTO nodes (id, project, name, label, type, qualified_name, file_path, start_line, end_line, in_degree, out_degree, properties_json)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT(id) DO UPDATE SET
				   project=excluded.project, name=excluded.name, label=excluded.label, type=excluded.type,
				   qualified_name=excluded.qualified_name, file_path=excluded.file_path,
				   start_line=excluded.start_line, end_line=excluded.end_line,
				   in_degree=excluded.in_degree, out_degree=excluded.out_degree, properties_json=excluded.properties_json`,
				[explicitId, project, node.name, label, type, qn, node.filePath ?? null,
					node.startLine ?? null, node.endLine ?? null, node.inDegree ?? 0, node.outDegree ?? 0, props]);
			await this._upsertFTS(explicitId, node);
			return explicitId;
		}

		const res = await dbRun(db,
			`INSERT INTO nodes (project, name, label, type, qualified_name, file_path, start_line, end_line, in_degree, out_degree, properties_json)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?)
			 ON CONFLICT(project, qualified_name) DO UPDATE SET
			   name=excluded.name, label=excluded.label, type=excluded.type,
			   file_path=excluded.file_path, start_line=excluded.start_line, end_line=excluded.end_line,
			   in_degree=excluded.in_degree, out_degree=excluded.out_degree, properties_json=excluded.properties_json
			 RETURNING id`,
			[project, node.name, label, type, qn, node.filePath ?? null,
				node.startLine ?? null, node.endLine ?? null, node.inDegree ?? 0, node.outDegree ?? 0, props]);
		const id = res.lastID;
		await this._upsertFTS(id, node);
		return id;
	}

	private async _upsertFTS(id: number, node: GraphNode): Promise<void> {
		const db = this._ensureDb();
		const body = this._buildFTSBody(node);
		// content='' 外部内容表：用 rowid 关联 nodes.id
		try {
			await dbRun(db,
				`INSERT INTO nodes_fts (rowid, name, qualified_name, file_path, body) VALUES (?,?,?,?,?)`,
				[id, node.name, node.qualifiedName ?? '', node.filePath ?? '', body]);
		} catch {
			await dbRun(db,
				`DELETE FROM nodes_fts WHERE rowid = ?`, [id]);
			await dbRun(db,
				`INSERT INTO nodes_fts (rowid, name, qualified_name, file_path, body) VALUES (?,?,?,?,?)`,
				[id, node.name, node.qualifiedName ?? '', node.filePath ?? '', body]);
		}
	}

	private _buildFTSBody(node: GraphNode): string {
		const parts: string[] = [node.name, node.qualifiedName ?? ''];
		if (node.filePath) { parts.push(node.filePath); }
		if (node.properties) {
			const keys = ['signature', 'docstring', 'returnType', 'paramTypes', 'return_type', 'param_types', 'doc'];
			for (const k of keys) {
				const v = (node.properties as Record<string, any>)[k];
				if (typeof v === 'string' && v) { parts.push(v); }
				else if (Array.isArray(v)) { parts.push(v.join(' ')); }
			}
		}
		return parts.join(' ');
	}

	async upsertNodesBatch(nodes: (GraphNode & { id?: string | number })[]): Promise<number[]> {
		const ids: number[] = [];
		await this.transaction(async () => {
			for (const n of nodes) {
				ids.push(await this.upsertNode(n));
			}
		});
		return ids;
	}

	async upsertEdge(edge: GraphEdge & { sourceId?: number; targetId?: number }): Promise<void> {
		const db = this._ensureDb();
		const source = edge.sourceId ?? Number(edge.source);
		const target = edge.targetId ?? Number(edge.target);
		const props = JSON.stringify(edge.properties ?? {});
		await dbRun(db,
			`INSERT INTO edges (source, target, type, properties_json) VALUES (?,?,?,?)
			 ON CONFLICT DO NOTHING`,
			[source, target, edge.type, props]);
	}

	async upsertEdgesBatch(edges: (GraphEdge & { sourceId?: number; targetId?: number })[]): Promise<void> {
		await this.transaction(async () => {
			for (const e of edges) { await this.upsertEdge(e); }
		});
	}

	async setFileHash(key: string, data: Record<string, any>): Promise<void> {
		const db = this._ensureDb();
		await dbRun(db,
			`INSERT INTO file_hashes (key, data_json) VALUES (?,?)
			 ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json`,
			[key, JSON.stringify(data)]);
	}

	async getFileHash(key: string): Promise<Record<string, any> | undefined> {
		const db = this._ensureDb();
		const row = await dbGet(db, `SELECT data_json FROM file_hashes WHERE key = ?`, [key]);
		return row ? safeParseJSON(row.data_json as string) : undefined;
	}

	async setLayout(nodeId: number, x: number, y: number, z: number): Promise<void> {
		const db = this._ensureDb();
		await dbRun(db,
			`INSERT INTO layout (node_id, x, y, z) VALUES (?,?,?,?)
			 ON CONFLICT(node_id) DO UPDATE SET x=excluded.x, y=excluded.y, z=excluded.z`,
			[nodeId, x, y, z]);
	}

	/** 批量重建 FTS5（整库载入后调用，比逐条插入更快） */
	async rebuildFTS(): Promise<void> {
		const db = this._ensureDb();
		await dbExec(db, `INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`);
	}

	/** 清空全部图数据（保留表结构） */
	async clear(): Promise<void> {
		const db = this._ensureDb();
		await dbExec(db, 'DELETE FROM nodes_fts; DELETE FROM edges; DELETE FROM nodes; DELETE FROM file_hashes; DELETE FROM layout;');
	}

	async deleteProject(project: string, opts?: { keepFileHashes?: boolean }): Promise<void> {
		const db = this._ensureDb();
		await this.transaction(async () => {
			// 用子查询替代 IN(大量字面量)，避免超过 SQLITE_MAX_VARIABLE_NUMBER（默认 999）。
			// 注意：dbExec 不支持参数绑定，带占位符的 DELETE 必须用 dbRun（旧代码因此必抛错）。
			await dbRun(db, `DELETE FROM nodes_fts WHERE rowid IN (SELECT id FROM nodes WHERE project = ?)`, [project]);
			await dbRun(db, `DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE project = ?) OR target IN (SELECT id FROM nodes WHERE project = ?)`, [project, project]);
			await dbRun(db, `DELETE FROM layout WHERE node_id IN (SELECT id FROM nodes WHERE project = ?)`, [project]);
			await dbRun(db, `DELETE FROM nodes WHERE project = ?`, [project]);
			// keepFileHashes：同步场景下保留增量索引哈希（删了会导致下次全量重解析）
			if (!opts?.keepFileHashes) {
				await dbRun(db, `DELETE FROM file_hashes WHERE key LIKE ?`, [`${project}:%`]);
			}
		});
	}

	// ─── Read path ────────────────────────────────────────────────────────

	async getNode(id: number): Promise<GraphNode | undefined> {
		const db = this._ensureDb();
		const row = await dbGet(db, `SELECT * FROM nodes WHERE id = ?`, [id]) as NodeRow | undefined;
		return row ? rowToNode(row) : undefined;
	}

	async getNodeByQN(project: string, qn: string): Promise<GraphNode | undefined> {
		const db = this._ensureDb();
		const row = await dbGet(db,
			`SELECT * FROM nodes WHERE project = ? AND qualified_name = ?`, [project, qn]) as unknown as NodeRow | undefined;
		return row ? rowToNode(row) : undefined;
	}

	async getNodesByFile(project: string, filePath: string): Promise<GraphNode[]> {
		const db = this._ensureDb();
		const rows = await dbAll(db,
			`SELECT * FROM nodes WHERE project = ? AND file_path = ?`, [project, filePath]) as unknown as NodeRow[];
		return rows.map(rowToNode);
	}

	/**
	 * 全文/子串检索。
	 * - 优先 FTS5 MATCH（单/多词均可，bm25 排序）
	 * - 空结果/异常 → LIKE 子串匹配 name/qualified_name（兜底子串语义）
	 */
	async searchNodes(query: string, nodeType?: string, limit = 200): Promise<GraphNode[]> {
		const db = this._ensureDb();
		const q = query.trim();
		if (!q) { return []; }
		const typeFilter = nodeType ? ` AND type = ?` : '';
		const typeArg = nodeType ? [nodeType] : [];

	// FTS5 优先（单词同样走 MATCH，bm25 排序；对齐 C 版 bm25() SQL 语义）。
	// 空结果或 MATCH 异常时退回 LIKE——FTS 按词索引，子串查询（"Handle" 命中
	// "MyHandler"）必须由 LIKE 兜底。
	const tFtsStart = Date.now();
	let ftsRows = 0;
	let fallbackReason = '';
	try {
		const matchExpr = q.split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
		const rows = await dbAll(db,
			`SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.rowid
			 WHERE nodes_fts MATCH ? ${typeFilter}
			 ORDER BY bm25(nodes_fts) LIMIT ?`,
			[matchExpr, ...typeArg, limit]) as unknown as NodeRow[];
		if (rows.length) {
			ftsRows = rows.length;
			if (Date.now() - tFtsStart > 500) { console.warn(`[searchNodes][diag] FTS hit path slow: ${Date.now() - tFtsStart}ms q="${q.slice(0, 40)}" rows=${rows.length}`); }
			// [CBSearch] 召回路径追踪：FTS 命中
			console.warn(`[CBSearch][trace] searchNodes q="${q.slice(0, 60)}" type=${nodeType ?? '-'} path=FTS match="${matchExpr.slice(0, 80)}" rows=${ftsRows} ${Date.now() - tFtsStart}ms`);
			return rows.map(rowToNode);
		}
		fallbackReason = 'fts-zero-hit';
		// FTS5 无命中 → 退回 LIKE
	} catch { fallbackReason = 'fts-match-error'; /* MATCH 表达式异常 → 退回 LIKE */ }
	const tFts = Date.now() - tFtsStart;

	const tLikeStart = Date.now();
	const likeArg = `%${q}%`;
	const rows = await dbAll(db,
		`SELECT * FROM nodes WHERE (name LIKE ? OR qualified_name LIKE ?) ${typeFilter}
		 ORDER BY (in_degree + out_degree) DESC LIMIT ?`,
		[likeArg, likeArg, ...typeArg, limit]) as unknown as NodeRow[];
	const tLike = Date.now() - tLikeStart;
	// [CBSearch] 召回路径追踪：LIKE 兜底（多词查询注意——LIKE 是整串子串，几乎不命中多词）
	console.warn(`[CBSearch][trace] searchNodes q="${q.slice(0, 60)}" type=${nodeType ?? '-'} path=LIKE reason=${fallbackReason} like="${likeArg.slice(0, 80)}" rows=${rows.length} FTS=${tFts}ms LIKE=${tLike}ms`);
	// diag：LIKE 兜底全表扫描是常见性能瓶颈（FTS 未命中/未索引时触发），单独计时
	if (tFts > 200 || tLike > 200) {
		console.warn(`[searchNodes][diag] q="${q.slice(0, 40)}" limit=${limit} FTS=${tFts}ms LIKE=${tLike}ms rows=${rows.length}`);
	}
	return rows.map(rowToNode);
	}

	/** 语义检索（FTS5 bm25 排序，返回 id→score） */
	async semanticSearch(query: string, limit = 20): Promise<{ node: GraphNode; score: number }[]> {
		const db = this._ensureDb();
		const q = query.trim();
		if (!q) { return []; }
		const matchExpr = q.split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
		const rows = await dbAll(db,
			`SELECT n.*, bm25(nodes_fts) AS rank FROM nodes_fts f JOIN nodes n ON n.id = f.rowid
			 WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ?`,
			[matchExpr, limit]);
		return rows.map(r => ({
			node: rowToNode(r as unknown as NodeRow),
			score: -(r.rank as number),
		}));
	}

	/**
	 * 主进程流式 grep（P2）：对项目已索引文件在磁盘上逐文件读取匹配，文件内容不跨
	 * IPC —— 只有命中行回传（对齐 C 版外部 grep 常驻零内存语义）。供 SQLite 后端
	 * 启用且 renderer 内存图已释放后的 search_code 路径使用。
	 */
	async grepContent(
		query: string,
		opts: { project?: string; roots: string[]; rootByProject?: Record<string, string>; filePattern?: string; limit?: number; useRegex?: boolean; maxFiles?: number; deadlineMs?: number },
	): Promise<{ matches: { filePath: string; lineNo: number; text: string }[]; scannedFiles: number; totalFiles: number }> {
		const db = this._ensureDb();
		const q = String(query ?? '');
		if (!q.trim()) { return { matches: [], scannedFiles: 0, totalFiles: 0 }; }
		const limit = Math.max(1, opts.limit ?? 50);
		const maxFiles = Math.max(1, opts.maxFiles ?? 40000);
		// 2026-07-26（日志 1785081279790）：wall-clock 预算——跨全部项目时清单
		// ~2-3 万文件，8 并发读盘 grep 实测 30s+；到点返回部分结果（部分覆盖
		// 语义由 scannedFiles/totalFiles 天然表达），不再无界阻塞。
		const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : Number.POSITIVE_INFINITY;
		const MAX_FILE_BYTES = 1024 * 1024;
		const matches: { filePath: string; lineNo: number; text: string }[] = [];

		// 项目的已索引文件清单（相对路径）；project 缺省 = 跨全部项目
		// （2026-07-26：多项目图谱下内容搜索必须覆盖所有项目，否则系统性漏检）。
		// SELECT 带 project 列：配合 rootByProject 直接拼根，消除逐文件 existsSync
		// 探测 IO（跨项目清单 × roots 逐个探测 ≈ 数万次随机 IO，是耗时大头之一）。
		const rows = opts.project
			? await dbAll(db,
				`SELECT DISTINCT file_path AS fp, project FROM nodes WHERE project = ? AND file_path != ''`,
				[opts.project])
			: await dbAll(db,
				`SELECT DISTINCT file_path AS fp, project FROM nodes WHERE file_path != ''`,
				[]);
		const relPaths = rows.map(r => String(r.fp));
		const projOf = rows.map(r => String(r.project));
		const totalFiles = relPaths.length;

		// 匹配器
		let regex: RegExp | undefined;
		if (opts.useRegex) {
			try { regex = new RegExp(q, 'i'); } catch { /* 非法正则退回字面匹配 */ }
		}
		const needle = q.toLowerCase();
		const hit = (line: string): boolean => regex ? regex.test(line) : line.toLowerCase().includes(needle);

		// filePattern glob → RegExp（简化 glob：* ? **）
		let globRe: RegExp | undefined;
		if (opts.filePattern) {
			const g = opts.filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
				.replace(/\*\*/g, ' ').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
				.replace(/ /g, '.*');
			try { globRe = new RegExp(g, 'i'); } catch { /* 忽略非法 glob */ }
		}

		const roots = (opts.roots ?? []).map(r => String(r).replace(/[\\/]+$/, ''));
		const rootByProject = opts.rootByProject;
		let scanned = 0;
		let idx = 0;
		const CONCURRENCY = 8;
		const worker = async (): Promise<void> => {
			while (idx < relPaths.length && matches.length < limit && scanned < maxFiles && Date.now() < deadline) {
				const myIdx = idx++;
				const rel = relPaths[myIdx];
				// 2026-07-27（日志 1785114566754）：匹配前规范化反斜杠——索引 filePath
				// 可能是 Windows 反斜杠存储形态，正斜杠 glob 匹配必败（假 0 命中）。
				if (globRe && !globRe.test(rel.replace(/\\/g, '/'))) { continue; }
				// 优先 project→root 直拼（零 IO）；无映射再逐根探测（兼容旧调用方）
				let abs: string | undefined;
				const directRoot = rootByProject?.[projOf[myIdx]];
				if (directRoot) {
					const cand = `${directRoot}/${rel}`;
					if (fs.existsSync(cand)) { abs = cand; }
				}
				if (!abs) {
					for (const root of roots) {
						const cand = `${root}/${rel}`;
						if (fs.existsSync(cand)) { abs = cand; break; }
					}
				}
				if (!abs) { continue; }
				scanned++;
				try {
					const st = await fs.promises.stat(abs);
					if (st.size > MAX_FILE_BYTES) { continue; }
					const content = await fs.promises.readFile(abs, 'utf8');
					const lines = content.split('\n');
					for (let i = 0; i < lines.length && matches.length < limit; i++) {
						if (hit(lines[i])) {
							matches.push({ filePath: rel, lineNo: i + 1, text: lines[i].trim().substring(0, 300) });
						}
					}
				} catch { /* 跳过不可读文件 */ }
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, relPaths.length)) }, () => worker()));
		return { matches, scannedFiles: scanned, totalFiles };
	}

	/**
	 * 取边：指定 nodeId 时返回与之相连（出/入）的全部边；否则分页返回全量边。
	 */
	async getEdges(nodeId?: number, offset = 0, limit = 10000): Promise<GraphEdge[]> {
		const db = this._ensureDb();
		let rows: EdgeRow[];
		if (nodeId !== undefined) {
			rows = await dbAll(db,
				`SELECT * FROM edges WHERE source = ? OR target = ?`, [nodeId, nodeId]) as unknown as EdgeRow[];
		} else {
			rows = await dbAll(db,
				`SELECT * FROM edges ORDER BY id LIMIT ? OFFSET ?`, [limit, offset]) as unknown as EdgeRow[];
		}
		return rows.map(rowToEdge);
	}

	async getTotalNodeCount(project?: string): Promise<number> {
		const db = this._ensureDb();
		const row = project
			? await dbGet(db, `SELECT COUNT(*) AS c FROM nodes WHERE project = ?`, [project])
			: await dbGet(db, `SELECT COUNT(*) AS c FROM nodes`, []);
		return (row?.c as number) ?? 0;
	}

	async getTotalEdgeCount(): Promise<number> {
		const db = this._ensureDb();
		const row = await dbGet(db, `SELECT COUNT(*) AS c FROM edges`, []);
		return (row?.c as number) ?? 0;
	}

	/**
	 * 可视化节点：按连接度（in+out）降序分页。
	 * 仅物化 offset..offset+limit 区间，renderer 堆只持有这一页 → 不再常驻全图。
	 */
	async getVisualizationNodes(offset: number, limit: number, project?: string): Promise<{ nodes: VisualizationNode[]; total: number }> {
		const db = this._ensureDb();
		const projFilter = project ? `WHERE project = ?` : '';
		const projArg = project ? [project] : [];
		const totalRow = await dbGet(db, `SELECT COUNT(*) AS c FROM nodes ${projFilter}`, projArg);
		const total = (totalRow?.c as number) ?? 0;

		const rows = await dbAll(db,
			`SELECT n.*, l.x AS lx, l.y AS ly, l.z AS lz
			 FROM nodes n LEFT JOIN layout l ON l.node_id = n.id
			 ${projFilter}
			 ORDER BY (n.in_degree + n.out_degree) DESC, n.id ASC
			 LIMIT ? OFFSET ?`,
			[...projArg, limit, offset]) as unknown as (NodeRow & { lx: number | null; ly: number | null; lz: number | null })[];

		const nodes: VisualizationNode[] = rows.map(r => {
			const connections = (r.in_degree || 0) + (r.out_degree || 0);
			const fp = r.file_path || r.qualified_name || r.name || '';
			const parts = fp.replace(/\\/g, '/').split('/');
			const clusterKey = parts.slice(0, 3).join('/');
			const h = fnv1a(clusterKey);
			const angle = ((h & 0xFFFF) / 65535) * Math.PI * 2;
			const radius = 500 + ((h >> 16) & 0xFF) / 255 * 250;
			const seed = fnv1a(r.qualified_name || fp);
			const jx = ((seed & 0xFF) / 255 - 0.5) * 40;
			const jy = (((seed >> 8) & 0xFF) / 255 - 0.5) * 40;
			const z = r.lz ?? -Math.min(connections, 20) * 15;
			return {
				id: String(r.id),
				name: r.name,
				type: r.label,
				filePath: r.file_path ?? undefined,
				qualifiedName: r.qualified_name || undefined,
				x: r.lx ?? radius * Math.cos(angle) + jx,
				y: r.ly ?? radius * Math.sin(angle) + jy,
				z,
				size: nodeSize(connections),
				color: stellarColor(connections),
				inDegree: r.in_degree || 0,
				outDegree: r.out_degree || 0,
			};
		});
		return { nodes, total };
	}

	async getVisualizationEdges(offset: number, limit: number): Promise<GraphEdge[]> {
		return this.getEdges(undefined, offset, limit);
	}

	async listProjects(): Promise<{ name: string; nodeCount: number; edgeCount: number }[]> {
		const db = this._ensureDb();
		const rows = await dbAll(db,
			`SELECT project, COUNT(*) AS nc FROM nodes GROUP BY project ORDER BY project`, []);
		return Promise.all(rows.map(async r => {
			const name = r.project as string;
			// 边计数按节点归属近似：该 project 节点参与的边
			const eRow = await dbGet(db,
				`SELECT COUNT(*) AS c FROM edges WHERE source IN (SELECT id FROM nodes WHERE project = ?)
				 OR target IN (SELECT id FROM nodes WHERE project = ?)`, [name, name]);
			return { name, nodeCount: r.nc as number, edgeCount: (eRow?.c as number) ?? 0 };
		}));
	}

	/**
	 * 已索引文件清单（2026-07-26，P1b）：search_files target=files 的快路径——
	 * 文件名 glob 直接匹配索引清单（亚秒级），免去全 folder ripgrep 扫描（17.5s）。
	 * project 缺省跨全部项目；返回 (file_path, project) 便于调用方拼绝对根。
	 */
	async listIndexedFilePaths(project?: string): Promise<{ filePath: string; project: string }[]> {
		const db = this._ensureDb();
		const rows = project
			? await dbAll(db,
				`SELECT DISTINCT file_path AS fp, project FROM nodes WHERE project = ? AND file_path != '' ORDER BY fp`,
				[project])
			: await dbAll(db,
				`SELECT DISTINCT file_path AS fp, project FROM nodes WHERE file_path != '' ORDER BY fp`,
				[]);
		return rows.map(r => ({ filePath: String(r.fp), project: String(r.project) }));
	}

	async getNodeTypes(project?: string): Promise<Record<string, number>> {
		const db = this._ensureDb();
		const rows = project
			? await dbAll(db, `SELECT type, COUNT(*) AS c FROM nodes WHERE project = ? GROUP BY type`, [project])
			: await dbAll(db, `SELECT type, COUNT(*) AS c FROM nodes GROUP BY type`, []);
		const out: Record<string, number> = {};
		for (const r of rows) { out[r.type as string] = r.c as number; }
		return out;
	}

	async getEdgeTypes(project?: string): Promise<Record<string, number>> {
		const db = this._ensureDb();
		if (project) {
			const rows = await dbAll(db,
				`SELECT e.type AS type, COUNT(*) AS c FROM edges e
				 JOIN nodes n ON n.id = e.source WHERE n.project = ? GROUP BY e.type`, [project]);
			const out: Record<string, number> = {};
			for (const r of rows) { out[r.type as string] = r.c as number; }
			return out;
		}
		const rows = await dbAll(db, `SELECT type, COUNT(*) AS c FROM edges GROUP BY type`, []);
		const out: Record<string, number> = {};
		for (const r of rows) { out[r.type as string] = r.c as number; }
		return out;
	}

	/**
	 * 返回所有节点（可选按 project 过滤，支持分页）。
	 * 对齐内存 store.getAllNodes() 语义，但加上了分页以避免 IPC 全量传输。
	 */
	async getAllNodes(project?: string, limit?: number, offset?: number): Promise<GraphNode[]> {
		const db = this._ensureDb();
		const filter = project ? 'WHERE project = ?' : '';
		const args: unknown[] = project ? [project] : [];
		let sql = `SELECT * FROM nodes ${filter} ORDER BY id ASC`;
		if (limit !== undefined) {
			sql += ` LIMIT ?`;
			args.push(limit);
			if (offset !== undefined) { sql += ` OFFSET ?`; args.push(offset); }
		}
		const rows = await dbAll(db, sql, args) as unknown as NodeRow[];
		return rows.map(rowToNode);
	}

	/**
	 * 返回所有边（可选按 project 过滤，仅返回两端节点都在该 project 的边）。
	 * 对齐内存 store.getAllEdges()，加分页。
	 */
	async getAllEdges(project?: string, limit?: number, offset?: number): Promise<GraphEdge[]> {
		const db = this._ensureDb();
		if (project) {
			const sub = `SELECT id FROM nodes WHERE project = ?`;
			const args: unknown[] = [project, project];
			let sql = `SELECT e.* FROM edges e WHERE e.source IN (${sub}) AND e.target IN (${sub}) ORDER BY e.id ASC`;
			if (limit !== undefined) {
				sql += ` LIMIT ?`; args.push(limit);
				if (offset !== undefined) { sql += ` OFFSET ?`; args.push(offset); }
			}
			const rows = await dbAll(db, sql, args) as unknown as EdgeRow[];
			return rows.map(rowToEdge);
		}
		let sql = `SELECT * FROM edges ORDER BY id ASC`;
		const args: unknown[] = [];
		if (limit !== undefined) {
			sql += ` LIMIT ?`; args.push(limit);
			if (offset !== undefined) { sql += ` OFFSET ?`; args.push(offset); }
		}
		const rows = await dbAll(db, sql, args) as unknown as EdgeRow[];
		return rows.map(rowToEdge);
	}

	/** 别名，对齐内存 store.getNodeCount(project?) */
	async getNodeCount(project?: string): Promise<number> {
		return this.getTotalNodeCount(project);
	}

	/**
	 * 按连接度（in+out）降序取 top-N 节点。
	 * 对齐内存 store.getTopNodesByDegree(project, maxNodes)。
	 */
	async getTopNodesByDegree(project: string, maxNodes: number): Promise<GraphNode[]> {
		const db = this._ensureDb();
		const rows = await dbAll(db,
			`SELECT * FROM nodes WHERE project = ? ORDER BY (in_degree + out_degree) DESC, id ASC LIMIT ?`,
			[project, maxNodes]) as unknown as NodeRow[];
		return rows.map(rowToNode);
	}

	/**
	 * 获取端点均在给定 id 集合内的边（用于可视化）。
	 * 对齐内存 store.getEdgesBetweenNodes(keptIds)。
	 *
	 * 使用参数化 IN(...)，批量上限默认 900（SQLITE_MAX_VARIABLE_NUMBER 默认 999 的安全值）。
	 * 超限时分批查询后合并。
	 */
	async getEdgesBetweenNodes(ids: number[]): Promise<GraphEdge[]> {
		const db = this._ensureDb();
		const MAX_VARS = 900;
		if (ids.length === 0) { return []; }
		if (ids.length <= MAX_VARS) {
			const holders = ids.map(() => '?').join(', ');
			const rows = await dbAll(db,
				`SELECT * FROM edges WHERE source IN (${holders}) AND target IN (${holders})`,
				[...ids, ...ids]) as unknown as EdgeRow[];
			return rows.map(rowToEdge);
		}
		// 超大 id 集合分批
		const all: GraphEdge[] = [];
		for (let i = 0; i < ids.length; i += MAX_VARS) {
			const chunk = ids.slice(i, i + MAX_VARS);
			const holders = chunk.map(() => '?').join(', ');
			const rows = await dbAll(db,
				`SELECT * FROM edges WHERE source IN (${holders}) AND target IN (${holders})`,
				[...chunk, ...chunk]) as unknown as EdgeRow[];
			for (const r of rows) { all.push(rowToEdge(r)); }
		}
		return all;
	}

	/**
	 * 获取以指定节点为 source 的所有边。
	 * 对齐内存 store.getEdgesBySource(nodeId)。
	 */
	async getEdgesBySource(nodeId: number): Promise<GraphEdge[]> {
		const db = this._ensureDb();
		const rows = await dbAll(db,
			`SELECT * FROM edges WHERE source = ?`, [nodeId]) as unknown as EdgeRow[];
		return rows.map(rowToEdge);
	}
}
