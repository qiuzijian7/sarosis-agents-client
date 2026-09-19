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
		// esbuild CJS bundle（测试 runner 等）下 import.meta.url 为 undefined →
		// createRequire(undefined) 抛 ERR_INVALID_ARG_VALUE。回退 cwd 解析
		// （runner 已把项目 node_modules 加进 globalPaths）。
		const base = typeof import.meta.url === 'string'
			? import.meta.url
			: `${process.cwd().replace(/[\\/]+$/, '')}/package.json`;
		_sqliteRequire = createRequire(base);
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
	{
		version: 2,
		// 2026-08-06 P1 瘦身：FTS5 改 external content（索引与原文分离，省 ~400MB）+ 删重复索引
		//   - content='nodes' + content_rowid='id'：nodes_fts 只存倒排索引，原文（body 等）放 nodes 表。
		//     rebuild 仍可用；DELETE rowid 语义正常（已验证）；无条件 DELETE FROM nodes_fts 会
		//     SQLITE_CORRUPT_VTAB（FTS5 行为），故 clear() 改用 delete-all 命令。
		//   - idx_nodes_qn 与 UNIQUE(project, qualified_name) 自动索引完全重复 → 删除省 ~100MB。
		sql: [
			// ① nodes 增加 body 列（external content 的内容来源，rebuild 依赖）
			`ALTER TABLE nodes ADD COLUMN body TEXT NOT NULL DEFAULT ''`,
			// ② 存量回填 body：从旧 contentful FTS 原文复制（新库无旧表，UPDATE 0 行幂等）
			`UPDATE nodes SET body = (SELECT f.body FROM nodes_fts f WHERE f.rowid = nodes.id) WHERE EXISTS (SELECT 1 FROM nodes_fts f WHERE f.rowid = nodes.id)`,
			// ③ 删除与 UNIQUE(project, qualified_name) 重复的显式索引
			`DROP INDEX IF EXISTS idx_nodes_qn`,
			// ④ 重建 FTS 为 external content（只存索引）
			`DROP TABLE IF EXISTS nodes_fts`,
			`CREATE VIRTUAL TABLE nodes_fts USING fts5(
				name, qualified_name, file_path, body,
				content='nodes', content_rowid='id', tokenize='unicode61'
			)`,
			// ⑤ 从 nodes 重建索引（external content 支持 rebuild）
			`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`,
		].join(';\n'),
	},
];

/**
 * ★★ 2026-09-18（对齐 CBM 的自定义分词 `cbm_camel_split`）：把标识符按
 * camelCase / PascalCase / 连续大写（缩略词）/ 下划线边界**拆成词元**，用于追加进 FTS body。
 *
 * 为什么必须做：FTS5 默认 `unicode61` 分词器**不拆驼峰** ⇒ `UpdateCloudClient` 在倒排里是
 * **一个**词元 ⇒ 搜 `cloud`、`Update Cloud` 在 FTS 路径上**零命中**，只能退回
 * `LIKE '%cloud%'` 全表扫描（正是「检索偏慢 + 召回奇怪」的来源之一 ✗）。
 * CBM 靠 C 侧注册 FTS5 自定义分词器解决；本仓没有原生分词器能力，改为
 * 「**写入时把拆分结果一并塞进 body**」—— 效果等价（都让倒排里出现 `cloud` 这个词元 ✓），
 * 且**不改查询侧语义**（查询仍按 `"词元"` 匹配，未被拆的原名照样命中 ✓）。
 *
 * 例：`UpdateCloudClient` → `Update Cloud Client`；`HTTPServer` → `HTTP Server`；
 * `getUserID` → `get User ID`；`Assets/S1Game/PlayerController.cpp` → `Assets S1Game PlayerController cpp`。
 *
 * ⚠ 只对**标识符类**字段调用（name / qualifiedName / filePath）—— 不碰 docstring：
 *   自然语言本就被 unicode61 正常分词，且那些字段体积大，拆它们只会让索引膨胀 ✗。
 */
function camelSplitTokens(ident: string): string {
	if (!ident) { return ''; }
	const out: string[] = [];
	for (const part of ident.split(/[^A-Za-z0-9]+/)) {
		if (!part) { continue; }
		// 两处边界：① 小写/数字 → 大写（fooBar）；② 连续大写 → 大写+小写 的拐点（HTTPServer）
		for (const t of part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' ')) {
			if (t.length >= 2) { out.push(t); }   // 丢弃单字符词元（`i`/`n` 之类，纯噪音）
		}
	}
	return out.join(' ');
}

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
		// 行 id：仅作 keyset 分页游标（见 GraphEdge.id 注释），调用方不得当 store 边 id 用
		id: String(r.id),
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

	/**
	 * ★★★ 2026-09-18（P1-1 第二步）：导出「**SQLite 快照**」制品（`VACUUM INTO`）。
	 *
	 * 为什么用 `VACUUM INTO` 而不是拷贝文件：`VACUUM INTO` 产出的是一份**已整理、无 WAL 残留**的
	 * 单文件副本（拷贝活库会撕裂 WAL、拿不到一致快照 ✗）。
	 * ⚠ SQLite 规定目标文件**必须不存在** ⇒ 调用方负责先删/用临时名，再原子改名。
	 * 载入端拿到它即可直接 `open(path, { readOnly: true })` 分页取数 ⇒ **完全不解析 JSON** ✓
	 * （真机「解析 JSON」3 folder ≈ 7320ms 就此归零）。
	 */
	async exportSnapshot(targetPath: string): Promise<{ nodeCount: number; edgeCount: number }> {
		// ⚠ `db` 是可选类型（store 未 open 时为 undefined）⇒ 必须守卫，否则整个调用链会静默传 undefined 给驱动 ✗
		const db = this.db;
		if (!db) { throw new Error('exportSnapshot: database is not open'); }
		// 路径里的单引号要按 SQL 字面量转义（Windows 路径含 ' 的极端情况）
		await dbExec(db, `VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
		const nodeRows = await dbAll(db, 'SELECT COUNT(*) AS c FROM nodes', []);
		const edgeRows = await dbAll(db, 'SELECT COUNT(*) AS c FROM edges', []);
		return {
			nodeCount: Number(nodeRows[0]?.c ?? 0),
			edgeCount: Number(edgeRows[0]?.c ?? 0),
		};
	}

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
		let didMigrate = false;
		for (const m of pending) {
			await dbExec(db, 'BEGIN');
			try {
				await dbExec(db, m.sql);
				await dbExec(db, `PRAGMA user_version = ${m.version}`);
				await dbExec(db, 'COMMIT');
				didMigrate = true;
			} catch (err) {
				await dbExec(db, 'ROLLBACK');
				throw err;
			}
		}
		if (didMigrate) {
			// 迁移后旧 FTS 表空间进入 freelist，文件不缩小；VACUUM 压缩归还磁盘。
			// 大库（1-2GB）耗时数秒~数十秒，仅迁移时执行一次。
			try { await dbExec(db, 'VACUUM'); } catch { /* 空间不足等场景降级：下次同步自然复用 */ }
			// FTS rebuild 产生大量 WAL 页，checkpoint TRUNCATE 收敛
			try { await dbExec(db, `PRAGMA wal_checkpoint(TRUNCATE)`); } catch { /* 忙则跳过 */ }
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
		const body = this._buildFTSBody(node);
		const explicitId = node.id !== undefined ? Number(node.id) : undefined;

		if (explicitId !== undefined) {
			await dbRun(db,
				`INSERT INTO nodes (id, project, name, label, type, qualified_name, file_path, start_line, end_line, in_degree, out_degree, properties_json, body)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT(id) DO UPDATE SET
				   project=excluded.project, name=excluded.name, label=excluded.label, type=excluded.type,
				   qualified_name=excluded.qualified_name, file_path=excluded.file_path,
				   start_line=excluded.start_line, end_line=excluded.end_line,
				   in_degree=excluded.in_degree, out_degree=excluded.out_degree, properties_json=excluded.properties_json, body=excluded.body`,
				[explicitId, project, node.name, label, type, qn, node.filePath ?? null,
					node.startLine ?? null, node.endLine ?? null, node.inDegree ?? 0, node.outDegree ?? 0, props, body]);
			await this._upsertFTS(explicitId, node);
			return explicitId;
		}

		const res = await dbRun(db,
			`INSERT INTO nodes (project, name, label, type, qualified_name, file_path, start_line, end_line, in_degree, out_degree, properties_json, body)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
			 ON CONFLICT(project, qualified_name) DO UPDATE SET
			   name=excluded.name, label=excluded.label, type=excluded.type,
			   file_path=excluded.file_path, start_line=excluded.start_line, end_line=excluded.end_line,
			   in_degree=excluded.in_degree, out_degree=excluded.out_degree, properties_json=excluded.properties_json, body=excluded.body
			 RETURNING id`,
			[project, node.name, label, type, qn, node.filePath ?? null,
				node.startLine ?? null, node.endLine ?? null, node.inDegree ?? 0, node.outDegree ?? 0, props, body]);
		const id = res.lastID;
		await this._upsertFTS(id, node);
		return id;
	}

	private async _upsertFTS(id: number, node: GraphNode): Promise<void> {
		const db = this._ensureDb();
		const body = this._buildFTSBody(node);
		// v2 起为 external content（content='nodes'）：INSERT 只更新倒排索引，
		// 原文（含 body）存 nodes 表；rebuild 时从 nodes 读，故 upsertNode 必须同步写 nodes.body。
		// rowid 与 nodes.id 对齐（content_rowid='id'）。
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
		// ★★ 2026-09-18：追加**标识符拆分词元**（见 `camelSplitTokens`）—— 让 `cloud` 这类
		// **词元级**查询能命中 `UpdateCloudClient`（旧实现只能靠 `LIKE '%cloud%'` 全表扫描兜底 ✗）。
		const split = camelSplitTokens([node.name, node.qualifiedName ?? '', node.filePath ?? ''].join(' '));
		if (split) { parts.push(split); }
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

	/**
	 * WAL checkpoint + TRUNCATE：压缩 WAL 文件，避免大同步后 WAL 膨胀导致读查询变慢。
	 * WAL 模式下读需合并 WAL，WAL 达数百 MB 时读延迟显著；同步完成/分批后调用此方法把 WAL 收敛回主库。
	 */
	async checkpoint(): Promise<void> {
		const db = this._ensureDb();
		try {
			await dbExec(db, `PRAGMA wal_checkpoint(TRUNCATE)`);
		} catch {
			try { await dbExec(db, `PRAGMA wal_checkpoint(PASSIVE)`); } catch { /* 忙则跳过 */ }
		}
	}

	/** 清空全部图数据（保留表结构） */
	async clear(): Promise<void> {
		const db = this._ensureDb();
		// FTS5 external content 表不支持无 WHERE 的 DELETE（SQLITE_CORRUPT_VTAB），
		// 须用 'delete-all' 命令清空索引。
		await dbExec(db, `INSERT INTO nodes_fts(nodes_fts) VALUES('delete-all'); DELETE FROM edges; DELETE FROM nodes; DELETE FROM file_hashes; DELETE FROM layout;`);
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

	/**
	 * 删除单个文件的所有节点及其关联边/FTS/布局行（增量索引补丁用，替代全量 deleteProject+重建）。
	 * 返回被删节点 id 列表（调用方一般无需；文件级节点数远小于 SQLITE_MAX_VARIABLE_NUMBER 上限）。
	 */
	async deleteNodesByFile(project: string, filePath: string): Promise<number[]> {
		const db = this._ensureDb();
		let ids: number[] = [];
		await this.transaction(async () => {
			const rows = await dbAll(db,
				`SELECT id FROM nodes WHERE project = ? AND file_path = ?`, [project, filePath]) as unknown as { id: number }[];
			ids = rows.map(r => r.id);
			if (ids.length === 0) { return; }
			// 用子查询而非 IN(字面量)，避免超大单文件超过 SQLITE_MAX_VARIABLE_NUMBER（默认 999）。
			await dbRun(db, `DELETE FROM nodes_fts WHERE rowid IN (SELECT id FROM nodes WHERE project = ? AND file_path = ?)`, [project, filePath]);
			await dbRun(db, `DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE project = ? AND file_path = ?) OR target IN (SELECT id FROM nodes WHERE project = ? AND file_path = ?)`, [project, filePath, project, filePath]);
			await dbRun(db, `DELETE FROM layout WHERE node_id IN (SELECT id FROM nodes WHERE project = ? AND file_path = ?)`, [project, filePath]);
			await dbRun(db, `DELETE FROM nodes WHERE project = ? AND file_path = ?`, [project, filePath]);
		});
		return ids;
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
	 *
	 * @param project 传入时**下推到 SQL** 限定单项目（2026-09-15）。
	 *
	 * 为什么必须下推（用户日志 2026-09-15）：SQLite 文件是**跨工作区共享**的持久层
	 * （`<userData>/codebase-graph/graph.db`），里面还留着历史工作区的项目（S1Game 34 万 +
	 * UE5EA …）。本方法原先不带 project ⇒ 跨全库按 bm25 取前 N 条，**候选池被外来项目占满**
	 * （实测 needle="test" 的 231 条候选全是 S1Game:148 + UE5EA:83，本项目命中根本没进池），
	 * renderer 侧再按 project 收敛 ⇒ 结果恒为 0（「Find Symbol 搜不到任何东西」）。
	 * 过滤下推后：① 结果正确；② bm25 排序集也缩小到本项目（顺带缓解慢查询）。
	 *
	 * @param excludeTypes 排除的节点类型（**非符号**容器/桩节点，2026-09-15）。
	 *   与 project 同理**必须下推**：`label='file'` 的 CONTAINS 桩节点（`*.test.ts` 等）
	 *   会在 bm25/LIKE 排序里占据大量名额，把真正的符号挤出 `LIMIT` —— 只在 renderer
	 *   后置过滤已经晚了（Find Symbol 搜 `test` 时 200 条里大半是文件名）。
	 *   大小写不敏感（图里 `file` 与 `File` 并存）。
	 *
	 * @param nameOnly 只匹配 `name` 列（符号名），2026-09-15。
	 *   两个理由，缺一不可：
	 *   ① **不该匹配**：FTS 索引了 `name, qualified_name, file_path, body`，`MATCH "test"`
	 *      会命中 QN 里的 `…/classifyLLM.test.ts` ⇒ 搜 `test` 返回 `MockClassifyLLM`
	 *      （用户截图报障）；
	 *   ② **FTS 的语义也不对**：即使加 `name:` 列过滤，FTS 是**词元**匹配 —— 只命中词元恰为
	 *      `test` 的名字，`testHelper` 反而漏掉；而 Find Symbol 要的是**符号名子串**。
	 *   ⇒ 故 `nameOnly` 时**跳过 FTS**，直接走 `name LIKE '%q%'`（子串语义，按连接度排序）。
	 */
	async searchNodes(query: string, nodeType?: string, limit = 200, project?: string, excludeTypes?: readonly string[], nameOnly?: boolean): Promise<GraphNode[]> {
		const db = this._ensureDb();
		const q = query.trim();
		if (!q) { return []; }
		const typeFilter = nodeType ? ` AND type = ?` : '';
		const typeArg = nodeType ? [nodeType] : [];
		// project 过滤：FTS 路径走 JOIN 别名 n；LIKE 路径是单表（无别名）
		const projArg = project ? [project] : [];
		const projFilterFts = project ? ` AND n.project = ?` : '';
		const projFilterLike = project ? ` AND project = ?` : '';
		// 类型排除（同上：别名差异）。`lower()` 只为兼容 `file`/`File` 两种写法；
		// type 列本就无索引、LIKE 路径本就是全表扫描，代价可忽略。
		const exArg = (excludeTypes ?? []).map(t => t.toLowerCase());
		const exPlaceholders = exArg.map(() => '?').join(',');
		const exFilterFts = exArg.length > 0 ? ` AND lower(n.type) NOT IN (${exPlaceholders})` : '';
		const exFilterLike = exArg.length > 0 ? ` AND lower(type) NOT IN (${exPlaceholders})` : '';

	// FTS5 优先（单词同样走 MATCH，bm25 排序；对齐 C 版 bm25() SQL 语义）。
	// 空结果或 MATCH 异常时退回 LIKE——FTS 按词索引，子串查询（"Handle" 命中
	// "MyHandler"）必须由 LIKE 兜底。
	const tFtsStart = Date.now();
	let ftsRows = 0;
	let fallbackReason = nameOnly ? 'name-only' : '';
	// nameOnly（符号名检索，2026-09-15）：**跳过 FTS** 直接走 LIKE —— FTS 是**词元**匹配且
	// 索引了 qualified_name/file_path/body ⇒ ① 会命中 QN 里的文件路径（搜 `test` 返回
	// `…/classifyLLM.test.ts::MockClassifyLLM`）；② 即使加 `name:` 列过滤，也只命中词元恰为
	// `test` 的名字，`testHelper` 反而漏掉。而 Find Symbol 要的是**符号名子串**语义。
	if (!nameOnly) {
		try {
			const matchExpr = q.split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
			// ★★★ 2026-09-18（对齐 CBM `mcp.c` 的**两步 BM25**）：**内层纯 FTS 取候选 → 外层再 join+过滤**。
			//
			// 旧实现是单条「JOIN + WHERE(type/project/exclude) + ORDER BY bm25 LIMIT ?」⇒ FTS5 必须
			// 持续产出按 bm25 排序的行、**直到凑够 limit 条通过过滤的**，等于把整条倒排链都打了分
			// （WAND / MaxScore 的提前终止被过滤条件屏蔽 ✗）。两步后内层只有 FTS ⇒ 提前终止生效 ✓。
			//
			// ⚠ 正确性保护（宁慢不丢）：内层候选**被截断**（= 达到上限）且过滤后不足 limit 条时，
			// **退回原单条 SQL** 求精确结果；未截断时两步结果与旧实现**逐条等价**（含 bm25 顺序，
			// 见下面按 `ids` 顺序还原）。
			const candLimit = Math.max(2000, limit * 8);
			const cands = await dbAll(db,
				`SELECT rowid AS rid FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts) LIMIT ?`,
				[matchExpr, candLimit]) as unknown as { rid: number }[];
			let rows: NodeRow[] = [];
			const truncated = cands.length >= candLimit;
			if (cands.length > 0) {
				const ids = cands.map(c => Number(c.rid));
				const ph = ids.map(() => '?').join(',');
				// 外层：单表（无别名）⇒ 复用为 LIKE 路径构建的无别名过滤片段 ✓
				const outer = await dbAll(db,
					`SELECT * FROM nodes WHERE id IN (${ph})${typeFilter}${projFilterLike}${exFilterLike}`,
					[...ids, ...typeArg, ...projArg, ...exArg]) as unknown as NodeRow[];
				// 还原内层 bm25 顺序（`IN` 不保证顺序）
				const byId = new Map(outer.map(r => [Number((r as { id?: number }).id), r]));
				rows = ids.map(id => byId.get(id)).filter((r): r is NodeRow => !!r);
			}
			if (truncated && rows.length < limit) {
				// 候选可能被截断 ⇒ 用原精确查询兜底（语义与改动前完全一致）
				rows = await dbAll(db,
					`SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.rowid
					 WHERE nodes_fts MATCH ? ${typeFilter}${projFilterFts}${exFilterFts}
					 ORDER BY bm25(nodes_fts) LIMIT ?`,
					[matchExpr, ...typeArg, ...projArg, ...exArg, limit]) as unknown as NodeRow[];
				console.warn(`[CBSearch][trace] searchNodes two-step truncated (cands=${cands.length}) ⇒ exact fallback rows=${rows.length}`);
			}
			if (rows.length) {
				ftsRows = rows.length;
				if (Date.now() - tFtsStart > 500) { console.warn(`[searchNodes][diag] FTS hit path slow: ${Date.now() - tFtsStart}ms q="${q.slice(0, 40)}" proj=${project ?? '-'} rows=${rows.length}`); }
				// [CBSearch] 召回路径追踪：FTS 命中
				console.warn(`[CBSearch][trace] searchNodes q="${q.slice(0, 60)}" type=${nodeType ?? '-'} proj=${project ?? '-'} ex=${exArg.join('/') || '-'} path=FTS(two-step) match="${matchExpr.slice(0, 80)}" cands=${cands.length} rows=${ftsRows} ${Date.now() - tFtsStart}ms`);
				return rows.map(rowToNode);
			}
			fallbackReason = 'fts-zero-hit';
			// FTS5 无命中 → 退回 LIKE
		} catch { fallbackReason = 'fts-match-error'; /* MATCH 表达式异常 → 退回 LIKE */ }
	}
	const tFts = Date.now() - tFtsStart;

	const tLikeStart = Date.now();
	const likeArg = `%${q}%`;
	// nameOnly：只匹配 `name`（符号名子串）；否则保持「name 或 qualified_name」旧口径
	const likeWhere = nameOnly ? `name LIKE ?` : `(name LIKE ? OR qualified_name LIKE ?)`;
	const likeArgs = nameOnly ? [likeArg] : [likeArg, likeArg];
	const rows = await dbAll(db,
		`SELECT * FROM nodes WHERE ${likeWhere} ${typeFilter}${projFilterLike}${exFilterLike}
		 ORDER BY (in_degree + out_degree) DESC LIMIT ?`,
		[...likeArgs, ...typeArg, ...projArg, ...exArg, limit]) as unknown as NodeRow[];
	const tLike = Date.now() - tLikeStart;
	// [CBSearch] 召回路径追踪：LIKE 兜底（多词查询注意——LIKE 是整串子串，几乎不命中多词）
	console.warn(`[CBSearch][trace] searchNodes q="${q.slice(0, 60)}" type=${nodeType ?? '-'} proj=${project ?? '-'} ex=${exArg.join('/') || '-'} path=LIKE reason=${fallbackReason} like="${likeArg.slice(0, 80)}" rows=${rows.length} FTS=${tFts}ms LIKE=${tLike}ms`);
	// diag：LIKE 兜底全表扫描是常见性能瓶颈（FTS 未命中/未索引时触发），单独计时
	if (tFts > 200 || tLike > 200) {
		console.warn(`[searchNodes][diag] q="${q.slice(0, 40)}" limit=${limit} proj=${project ?? '-'} FTS=${tFts}ms LIKE=${tLike}ms rows=${rows.length}`);
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
	 *
	 * @param afterId **keyset 分页**游标（2026-09-16）：只返回 `id > afterId` 的行，优先于 `offset`。
	 *   为什么不用 `LIMIT/OFFSET`：大表上 OFFSET 是 **O(offset) 累计** —— 每页都要从头扫过前
	 *   offset 行（下面 `getAllEdges` 更糟：project 过滤的子查询每页还要重跑一次）⇒ 翻到后面
	 *   每页都要跳几十万行。本方法按 `id ASC` 稳定有序，用「上一页最后一行的 id」作游标即 O(n) 总量。
	 */
	async getAllNodes(project?: string, limit?: number, offset?: number, afterId?: number): Promise<GraphNode[]> {
		const db = this._ensureDb();
		const where: string[] = [];
		const args: unknown[] = [];
		if (project) { where.push('project = ?'); args.push(project); }
		if (afterId !== undefined) { where.push('id > ?'); args.push(afterId); }
		let sql = `SELECT * FROM nodes${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC`;
		if (limit !== undefined) {
			sql += ` LIMIT ?`;
			args.push(limit);
			// keyset 与 offset 互斥：给了 afterId 就不再跳 offset（两套语义叠加会漏行）
			if (offset !== undefined && afterId === undefined) { sql += ` OFFSET ?`; args.push(offset); }
		}
		const rows = await dbAll(db, sql, args) as unknown as NodeRow[];
		return rows.map(rowToNode);
	}

	/**
	 * 返回所有边（可选按 project 过滤，仅返回两端节点都在该 project 的边）。
	 * 对齐内存 store.getAllEdges()，加分页。
	 *
	 * @param afterId **keyset 分页**游标（2026-09-16，语义同 `getAllNodes`）：`e.id > afterId`，
	 *   优先于 `offset`。对边尤其重要：project 过滤是个 `source IN (SELECT id FROM nodes WHERE
	 *   project=?)` 子查询，`OFFSET` 分页会让它**每页重跑一次**（几十万节点 × 上百页）。
	 *   返回的 `GraphEdge.id` 即本行的 SQLite 行 id，调用方用它作下一页游标（**仅游标用途**）。
	 */
	async getAllEdges(project?: string, limit?: number, offset?: number, afterId?: number): Promise<GraphEdge[]> {
		const db = this._ensureDb();
		let sql: string;
		const args: unknown[] = [];
		if (project) {
			const sub = `SELECT id FROM nodes WHERE project = ?`;
			args.push(project, project);
			sql = `SELECT e.* FROM edges e WHERE e.source IN (${sub}) AND e.target IN (${sub})`;
			if (afterId !== undefined) { sql += ` AND e.id > ?`; args.push(afterId); }
			sql += ` ORDER BY e.id ASC`;
		} else {
			sql = `SELECT * FROM edges`;
			if (afterId !== undefined) { sql += ` WHERE id > ?`; args.push(afterId); }
			sql += ` ORDER BY id ASC`;
		}
		if (limit !== undefined) {
			sql += ` LIMIT ?`; args.push(limit);
			if (offset !== undefined && afterId === undefined) { sql += ` OFFSET ?`; args.push(offset); }
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
