/*---------------------------------------------------------------------------------------------
 *  mediaStore.ts — 生成图片资产库 Node 实现（主进程）。
 *
 *  文件为主 + SQLite 元数据（对齐 InvokeAI）：
 *    - 文件：{root}/{yyyy}/{mm}/{id}.{ext}
 *    - 元数据：{root}/media.db（better-sqlite3，主进程方可用，同 kbSqliteStore 范式）
 *    - 软删除：is_deleted=1，restore 恢复；文件在软删除时保留（回收站），永久清理在 P2 配额阶段。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// ⚠ 主进程编译产物是 **ESM**（package.json `"type": "module"`），ESM scope 里没有
// `require` —— 裸 `require('better-sqlite3')` 会抛
// `ReferenceError: require is not defined in ES module scope`，被下面的 catch 吞掉
// 后 Database 恒为 null，于是所有媒体库命令都报 "media store unavailable"。
// 必须用 createRequire，与图谱的 `@vscode/sqlite3`、gitVersionEngine 等既有范式一致。
const nodeRequire = createRequire(import.meta.url);

// 主进程方可用 better-sqlite3；不可用 → 抛明确错误（构造时）
let Database: any;
try {
	// better-sqlite3 是 CJS 模块，require 直接返回构造函数本身（无 .default）。
	// 注意：esbuild/TS 的 `import X from 'better-sqlite3'` 会转成 `({ default: X } = require(...))`，
	// 对 CJS 模块解构 .default 会得到 undefined，故这里用直接赋值。
	Database = nodeRequire('better-sqlite3');
} catch {
	Database = null;
}

// ── SQLite 抽象（便于测试注入 node:sqlite 等真实 SQL 引擎）──────────────
export interface SqliteStatement {
	run(...params: any[]): unknown;
	get(...params: any[]): Record<string, unknown> | undefined;
	all(...params: any[]): Record<string, unknown>[];
}
export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
}
export type DatabaseFactory = (rootDir: string) => SqliteDatabase;

export interface MediaStoreOptions {
	rootDir: string;
}

export interface MediaRow {
	id: string;
	workflow_id: string | null;
	node_id: string | null;
	provider: string | null;
	kind: string;
	ref: string;
	file_name: string | null;
	file_path: string | null;
	mime: string | null;
	meta_json: string | null;
	created_at: number;
	size_bytes: number | null;
	is_deleted: number;
	board: string | null;
	favorite: number;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS media_asset (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT,
  node_id     TEXT,
  provider    TEXT,
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  file_name   TEXT,
  file_path   TEXT,
  mime        TEXT,
  meta_json   TEXT,
  created_at  INTEGER NOT NULL,
  size_bytes  INTEGER,
  is_deleted  INTEGER DEFAULT 0,
  board       TEXT,
  favorite    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_media_node  ON media_asset(node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_media_wf    ON media_asset(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_media_deleted ON media_asset(is_deleted, created_at);
`;

export class MediaStore {
	private readonly db: SqliteDatabase;

	constructor(
		private readonly opts: MediaStoreOptions,
		dbFactory?: DatabaseFactory,
	) {
		const factory: DatabaseFactory = dbFactory ?? ((rootDir) => {
			if (!Database) {
				throw new Error('better-sqlite3 is unavailable — media store cannot open');
			}
			return new Database(path.join(rootDir, 'media.db')) as unknown as SqliteDatabase;
		});
		fs.mkdirSync(opts.rootDir, { recursive: true });
		this.db = factory(opts.rootDir);
		this.db.exec(CREATE_TABLE);
	}

	/** 当前媒体库根目录（绝对路径，供 UI 展示/编辑）。 */
	getRootDir(): string {
		return this.opts.rootDir;
	}

	/** 写入资产：base64 落盘 + URL 引用。至少提供 ref 或 base64 之一。 */
	async importAsset(entry: {
		ref?: string;
		base64?: string;
		ext?: string;
		kind?: string;
		mime?: string;
		workflowId?: string;
		nodeId?: string;
		provider?: string;
		metaJson?: string;
	}): Promise<any> {
		const id = randomUUID();
		const now = Date.now();
		let ref = entry.ref ?? '';
		let fileName: string | null = null;
		let filePath: string | null = null;
		let sizeBytes: number | null = null;

		if (entry.base64) {
			const ext = entry.ext || 'png';
			const buf = Buffer.from(entry.base64, 'base64');
			const rel = this._writeFile(id, ext, buf);
			fileName = path.basename(rel);
			filePath = path.join(this.opts.rootDir, rel);
			sizeBytes = buf.byteLength;
			ref = ref || rel;
		}

		this.db.prepare(`
			INSERT INTO media_asset
				(id, workflow_id, node_id, provider, kind, ref, file_name, file_path, mime, meta_json, created_at, size_bytes, is_deleted, board, favorite)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0)
		`).run(
			id,
			entry.workflowId ?? null,
			entry.nodeId ?? null,
			entry.provider ?? null,
			entry.kind ?? 'image',
			ref,
			fileName,
			filePath,
			entry.mime ?? null,
			entry.metaJson ?? null,
			now,
			sizeBytes,
		);
		return this.get(id);
	}

	async list(filter: {
		workflowId?: string;
		provider?: string;
		kind?: string;
		query?: string;
		board?: string;
		favorite?: boolean;
		includeDeleted?: boolean;
		limit?: number;
		offset?: number;
	} = {}): Promise<{ total: number; items: any[] }> {
		const where: string[] = [];
		const params: any[] = [];
		if (!filter.includeDeleted) { where.push('is_deleted = 0'); }
		if (filter.workflowId) { where.push('workflow_id = ?'); params.push(filter.workflowId); }
		if (filter.provider) { where.push('provider = ?'); params.push(filter.provider); }
		if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
		if (filter.board !== undefined) { where.push('board IS ' + (filter.board ? '?' : 'NULL')); if (filter.board) { params.push(filter.board); } }
		if (filter.favorite) { where.push('favorite = 1'); }
		if (filter.query) { where.push('(file_name LIKE ? OR ref LIKE ? OR meta_json LIKE ?)'); const q = `%${filter.query}%`; params.push(q, q, q); }

		const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
		const offset = filter.offset ?? 0;

		const total = (this.db.prepare(`SELECT COUNT(*) c FROM media_asset ${whereSql}`).get(...params) as { c: number }).c;
		const rows = this.db.prepare(
			`SELECT * FROM media_asset ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
		).all(...params, limit, offset) as unknown as MediaRow[];
		return { total, items: rows.map(r => this._toAsset(r)) };
	}

	async get(id: string): Promise<any | null> {
		const row = this.db.prepare('SELECT * FROM media_asset WHERE id = ?').get(id) as MediaRow | undefined;
		return row ? this._toAsset(row) : null;
	}

	async getFilePath(id: string): Promise<string | null> {
		const row = this.db.prepare('SELECT file_path FROM media_asset WHERE id = ?').get(id) as { file_path: string | null } | undefined;
		if (!row?.file_path) { return null; }
		return fs.existsSync(row.file_path) ? row.file_path : null;
	}

	/**
	 * 把本地文件读成 data URL 字符串（webview 沙箱不能直接用本地路径，data URL 是唯一安全方式）。
	 * webview 拿到后直接 <img src=...> 显示，体积 ~33% 开销可接受（缩略图 96×96 通常 < 10KB）。
	 * mime 按扩展名推断（不读 magic bytes，开销最低，列表场景已够）。
	 */
	async getAsDataUrl(id: string): Promise<string | null> {
		const fp = await this.getFilePath(id);
		if (!fp) { return null; }
		const buf = await fs.promises.readFile(fp);
		const mime = this._extToMime(fp);
		return `data:${mime};base64,${buf.toString('base64')}`;
	}

	private _extToMime(p: string): string {
		const e = path.extname(p).toLowerCase();
		switch (e) {
			case '.png': return 'image/png';
			case '.jpg': case '.jpeg': return 'image/jpeg';
			case '.gif': return 'image/gif';
			case '.webp': return 'image/webp';
			case '.svg': return 'image/svg+xml';
			case '.bmp': return 'image/bmp';
			case '.mp4': return 'video/mp4';
			case '.webm': return 'video/webm';
			case '.mov': return 'video/quicktime';
			case '.mp3': return 'audio/mpeg';
			case '.wav': return 'audio/wav';
			case '.ogg': return 'audio/ogg';
			default: return 'application/octet-stream';
		}
	}

	async remove(id: string): Promise<void> {
		this.db.prepare('UPDATE media_asset SET is_deleted = 1 WHERE id = ?').run(id);
	}

	async restore(id: string): Promise<void> {
		this.db.prepare('UPDATE media_asset SET is_deleted = 0 WHERE id = ?').run(id);
	}

	async setFavorite(id: string, favorite: boolean): Promise<void> {
		this.db.prepare('UPDATE media_asset SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id);
	}

	async setBoard(id: string, board: string | null): Promise<void> {
		this.db.prepare('UPDATE media_asset SET board = ? WHERE id = ?').run(board, id);
	}

	// ─── 配额 / 清理（P2）──────────────────────────────────────────────

	async stats(): Promise<{ assetCount: number; deletedCount: number; totalBytes: number; dirSizeBytes: number }> {
		const alive = this.db.prepare('SELECT COUNT(*) c FROM media_asset WHERE is_deleted = 0').get() as { c: number };
		const deleted = this.db.prepare('SELECT COUNT(*) c FROM media_asset WHERE is_deleted = 1').get() as { c: number };
		const size = this.db.prepare('SELECT COALESCE(SUM(size_bytes), 0) s FROM media_asset WHERE is_deleted = 0').get() as { s: number };
		return {
			assetCount: alive.c,
			deletedCount: deleted.c,
			totalBytes: size.s,
			dirSizeBytes: this._dirSize(),
		};
	}

	/** 物理删除回收站资产（行 + 文件）。 */
	async purgeDeleted(): Promise<{ count: number; freedBytes: number }> {
		const rows = this.db.prepare('SELECT * FROM media_asset WHERE is_deleted = 1').all() as unknown as MediaRow[];
		let count = 0;
		let freedBytes = 0;
		for (const r of rows) {
			if (r.file_path) {
				try {
					const st = fs.statSync(r.file_path);
					fs.unlinkSync(r.file_path);
					freedBytes += st.size;
				} catch { /* missing file is fine */ }
			}
			this.db.prepare('DELETE FROM media_asset WHERE id = ?').run(r.id);
			count++;
		}
		return { count, freedBytes };
	}

	/**
	 * ★ 清理孤儿项：DB 有 file_path 但磁盘文件已不存在（app 重装 / rootDir 变化
	 * / 外部删除等残留）。直接硬删（文件已无，无需 unlink），返回清理数 + 释放的
	 * 记录字节。UI 表现为"不可用"（getAsDataUrl 返回 null）。
	 * 与 purgeDeleted 差别：purgeDeleted 只清 is_deleted=1 回收站；本方法清
	 * is_deleted=0 但磁盘文件缺失的「活」行。
	 */
	async cleanOrphaned(): Promise<{ count: number; freedBytes: number }> {
		const rows = this.db.prepare(
			'SELECT id, file_path, size_bytes FROM media_asset WHERE is_deleted = 0 AND file_path IS NOT NULL AND file_path != \'\''
		).all() as Array<{ id: string; file_path: string; size_bytes: number | null }>;
		let count = 0;
		let freedBytes = 0;
		for (const r of rows) {
			if (!fs.existsSync(r.file_path)) {
				this.db.prepare('DELETE FROM media_asset WHERE id = ?').run(r.id);
				count++;
				freedBytes += r.size_bytes ?? 0;
			}
		}
		return { count, freedBytes };
	}

	/**
	 * 配额清理：天龄 + 容量双维度，软删除最旧的"未收藏 && 未分组"资产，
	 * 然后物理清理回收站（含此前用户主动删除的）。收藏/入板的资产永不自动清理。
	 */
	async enforceQuota(opts?: { maxDays?: number; maxTotalBytes?: number }): Promise<{ removed: number; freedBytes: number }> {
		const maxDays = opts?.maxDays;
		const maxTotalBytes = opts?.maxTotalBytes;

		if (maxDays) {
			const cutoff = Date.now() - maxDays * 24 * 3600 * 1000;
			const old = this.db.prepare(`
				SELECT id FROM media_asset
				WHERE is_deleted = 0 AND favorite = 0 AND board IS NULL AND created_at < ?
				ORDER BY created_at ASC
			`).all(cutoff) as Array<{ id: string }>;
			for (const r of old) {
				this.db.prepare('UPDATE media_asset SET is_deleted = 1 WHERE id = ?').run(r.id);
			}
		}

		if (maxTotalBytes) {
			for (;;) {
				const alive = this.db.prepare('SELECT COALESCE(SUM(size_bytes), 0) s FROM media_asset WHERE is_deleted = 0').get() as { s: number };
				if (alive.s <= maxTotalBytes) { break; }
				const victim = this.db.prepare(`
					SELECT id FROM media_asset
					WHERE is_deleted = 0 AND favorite = 0 AND board IS NULL
					ORDER BY created_at ASC LIMIT 1
				`).get() as { id: string } | undefined;
				if (!victim) { break; }
				this.db.prepare('UPDATE media_asset SET is_deleted = 1 WHERE id = ?').run(victim.id);
			}
		}

		const purged = await this.purgeDeleted();
		return { removed: purged.count, freedBytes: purged.freedBytes };
	}

	// ─── helpers ─────────────────────────────────────────────────────────

	private _dirSize(): number {
		if (!fs.existsSync(this.opts.rootDir)) { return 0; }
		let total = 0;
		const walk = (p: string): void => {
			for (const e of fs.readdirSync(p, { withFileTypes: true })) {
				const full = path.join(p, e.name);
				if (e.isDirectory()) { walk(full); }
				else if (e.isFile()) {
					try { total += fs.statSync(full).size; } catch { /* ignore */ }
				}
			}
		};
		walk(this.opts.rootDir);
		return total;
	}

	private _writeFile(id: string, ext: string, buf: Buffer): string {
		const d = new Date();
		const relDir = path.join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'));
		const absDir = path.join(this.opts.rootDir, relDir);
		fs.mkdirSync(absDir, { recursive: true });
		const rel = path.join(relDir, `${id}.${ext}`);
		fs.writeFileSync(path.join(this.opts.rootDir, rel), buf);
		return rel;
	}

	private _toAsset(r: MediaRow): any {
		return {
			id: r.id,
			workflowId: r.workflow_id ?? undefined,
			nodeId: r.node_id ?? undefined,
			provider: r.provider ?? undefined,
			kind: r.kind,
			ref: r.ref,
			fileName: r.file_name ?? undefined,
			filePath: r.file_path ?? undefined,
			mime: r.mime ?? undefined,
			metaJson: r.meta_json ?? undefined,
			createdAt: r.created_at,
			sizeBytes: r.size_bytes ?? undefined,
			isDeleted: !!r.is_deleted,
			board: r.board ?? undefined,
			favorite: !!r.favorite,
		};
	}
}
