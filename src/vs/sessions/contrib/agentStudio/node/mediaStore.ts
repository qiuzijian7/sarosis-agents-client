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
import { loadBetterSqlite3 } from './betterSqlite3.js';

// 主进程方可用 better-sqlite3；不可用 → 抛明确错误（构造时）。
// ⚠ 壳加载成功 ≠ 能用：原生绑定（better_sqlite3.node）由 betterSqlite3.ts 显式解析
// 并通过 `nativeBinding` 传入 —— 打包产物里它可能只落在 node_modules.asar.unpacked
// 下，而 bindings 默认只查包内 build/Release（2026-09-14 "media store unavailable" 事故根因）。
const { Database, nativeBinding, diagnostic: SQLITE_DIAGNOSTIC } = loadBetterSqlite3();

/** 供 channel 层拼错误信息（安装包缺原生绑定时便于定位）。 */
export const BETTER_SQLITE3_DIAGNOSTIC = SQLITE_DIAGNOSTIC;

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
	tags: string | null;
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
  favorite    INTEGER DEFAULT 0,
  tags        TEXT
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
				throw new Error(`better-sqlite3 is unavailable — media store cannot open (${SQLITE_DIAGNOSTIC})`);
			}
			return new Database(path.join(rootDir, 'media.db'), nativeBinding ? { nativeBinding } : {}) as unknown as SqliteDatabase;
		});
		fs.mkdirSync(opts.rootDir, { recursive: true });
		this.db = factory(opts.rootDir);
		this._applyPragmas();
		this.db.exec(CREATE_TABLE);
		this._migrate();
	}

	/**
	 * PRAGMA 与 `kbSqliteStore` / `codebaseGraphSqliteStore` **对齐**（2026-09-15）。
	 *
	 * ── 为什么 media.db 也需要（与「单实例 / 多实例」无关）────────────────────────
	 * **每个窗口是一个独立 renderer** ⇒ 工程里永远存在**多个到 `media.db` 的连接**
	 * （每个窗口一个），哪怕切回「单实例多窗口」（模型 A）也一样。此前只有 kb/graph
	 * 补了 PRAGMA，media 漏了 ⇒ 并发写会立刻抛 `SQLITE_BUSY`（甚至留下损坏库）：
	 *   · `journal_mode = WAL`：多连接并发读 + 单写者，不再读写互斥；崩溃恢复更稳；
	 *   · `busy_timeout = 5000`：抢不到锁时**等待 5s** 而不是立即失败。
	 *
	 * ⚠ 走 `exec` 而非 `pragma()`：本文件的 `SqliteDatabase` 接口只声明了 `exec`/`prepare`
	 *   （测试用 fake 实现也只需满足这两条）；`PRAGMA` 的返回值用 `exec` 会被忽略，正合所需。
	 * ⚠ PRAGMA 失败不能阻塞打开（只读介质等极端情况）—— 降级为旧行为即可。
	 */
	private _applyPragmas(): void {
		try {
			this.db.exec('PRAGMA journal_mode = WAL');
			this.db.exec('PRAGMA busy_timeout = 5000');
		} catch { /* 忽略：降级为无 PRAGMA 的旧行为，不影响可用性 */ }
	}

	/**
	 * 轻量迁移：`CREATE TABLE IF NOT EXISTS` **不会给已存在的旧库补列** ⇒
	 * 新增列必须逐列探测后 ALTER（SQLite 的 ADD COLUMN 是 O(1) 元数据操作）。
	 */
	private _migrate(): void {
		const cols = this.db.prepare('PRAGMA table_info(media_asset)').all() as Array<{ name: string }>;
		const has = (n: string) => cols.some(c => c.name === n);
		if (!has('tags')) {
			this.db.exec('ALTER TABLE media_asset ADD COLUMN tags TEXT');
		}
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
		} else if (/^https?:\/\//i.test(ref)) {
			// 远程 URL 引用（如 chatgpt2api 返回的 http://host/images/xxx.png）：
			// webview 的 CSP `img-src` 对 http 只放行 127.0.0.1/localhost，
			// 直连远程 http 会被拦截（图片不显示）。这里在主进程主动下载落盘，
			// 之后 `_handleMediaGetUrl` 走 filePath 分支读文件转 data URL 展示，
			// 同时保留 ref 作为原始引用（离线/兜底均可用本地文件）。
			const downloaded = await this._downloadRemoteToFile(id, ref, entry.kind === 'video' ? 'mp4' : 'png');
			if (downloaded) {
				fileName = downloaded.fileName;
				filePath = downloaded.filePath;
				sizeBytes = downloaded.sizeBytes;
			}
			// 下载失败：保持纯 URL 引用（原行为，仅索引不落盘）。
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
		/** 精确匹配某个标签（JSON 数组元素级匹配）。 */
		tag?: string;
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
		// 标签：tags 存 JSON 数组字符串 ⇒ 用 `%"tag"%` 精确匹配元素，避免子串误命中
		if (filter.tag) { where.push('tags LIKE ?'); params.push(tagLikePattern(filter.tag)); }

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

	/**
	 * 本地化：把「仅 URL 引用」的资产**下载并落盘**到媒体库目录。
	 *
	 * ⚠ 与 `importAsset` 的关系：**导入时已经会自动本地化**（`_downloadRemoteToFile`，
	 *   30s 超时）。本方法不是"新增能力"，而是给**当时下载失败、以纯引用残留**的资产
	 *   一次重试机会 —— 那类资产在 CSP 不放行 `http:` 的当下显示不出来。
	 *   因此这里复用同一个下载实现，避免两套下载/扩展名推断逻辑漂移。
	 *
	 * 幂等：已落盘（file_path 存在且文件在盘上）或非 http(s) 引用 ⇒ 原样返回，不重复下载。
	 */
	async localize(id: string): Promise<any> {
		const row = this.db.prepare('SELECT * FROM media_asset WHERE id = ?').get(id) as MediaRow | undefined;
		if (!row) { throw new Error(`media asset not found: ${id}`); }
		if (row.file_path && fs.existsSync(row.file_path)) { return this._toAsset(row); }
		const url = row.ref;
		if (!/^https?:\/\//i.test(url)) {
			throw new Error(`asset is not a remote reference: ${url}`);
		}
		const fallbackExt = row.kind === 'video' ? 'mp4' : row.kind === 'audio' ? 'mp3' : 'png';
		const downloaded = await this._downloadRemoteToFile(row.id, url, fallbackExt);
		if (!downloaded) {
			throw new Error(`download failed: ${url}`);
		}
		this.db.prepare(
			'UPDATE media_asset SET file_path = ?, file_name = ?, size_bytes = ? WHERE id = ?'
		).run(downloaded.filePath, downloaded.fileName, downloaded.sizeBytes, id);
		return this.get(id);
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

	/** 下载远程 http(s) 图片/视频并落盘到媒体库。成功返回文件元信息，失败返回 null（回退为纯 URL 引用）。
	 *  fallbackExt：URL/content-type 都推断不出时的兜底扩展名（视频资产传 'mp4'，避免 mp4 存成 .png）。 */
	private async _downloadRemoteToFile(id: string, url: string, fallbackExt = 'png'): Promise<{ fileName: string; filePath: string; sizeBytes: number } | null> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 30_000);
		try {
			const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
			if (!res.ok) { return null; }
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.byteLength === 0) { return null; }
			const ext = this._extForRemote(url, res.headers.get('content-type'), fallbackExt);
			const rel = this._writeFile(id, ext, buf);
			return {
				fileName: path.basename(rel),
				filePath: path.join(this.opts.rootDir, rel),
				sizeBytes: buf.byteLength,
			};
		} catch {
			return null;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/** 从远程 URL 路径后缀或 content-type 推断落盘扩展名。 */
	private _extForRemote(url: string, contentType?: string | null, fallbackExt = 'png'): string {
		const m = url.match(/\.(\w+)(?:[?#]|$)/i);
		if (m) {
			const e = m[1].toLowerCase();
			// ★ 视频扩展名（2026-09-08）：视频直出模式（gif_enable=false）的产物
			//   是 mp4——旧白名单只有图片，推断不到 → 兜底 'png' → mp4 内容存成
			//   .png（用户实测「没有生成 mp4，生成了一个 png 图像」）。
			if (/^(png|jpe?g|webp|gif|avif|bmp|svg|mp4|webm|mov|m4v|mkv)$/.test(e)) { return e === 'jpeg' ? 'jpg' : e; }
		}
		if (contentType) {
			const ct = contentType.split(';')[0].trim().toLowerCase();
			if (ct === 'image/png') { return 'png'; }
			if (ct === 'image/jpeg' || ct === 'image/jpg') { return 'jpg'; }
			if (ct === 'image/webp') { return 'webp'; }
			if (ct === 'image/gif') { return 'gif'; }
			if (ct === 'image/avif') { return 'avif'; }
			if (ct === 'image/bmp') { return 'bmp'; }
			if (ct === 'image/svg+xml') { return 'svg'; }
			// ★ 视频 mime（2026-09-08）
			if (ct === 'video/mp4' || ct === 'application/mp4') { return 'mp4'; }
			if (ct === 'video/webm') { return 'webm'; }
			if (ct === 'video/quicktime') { return 'mov'; }
		}
		return fallbackExt;
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
			tags: parseTags(r.tags),
		};
	}

	// ─── 标签（tags）──────────────────────────────────────────────────

	/** 覆写资产的标签集合（去重 + 去空白；空数组即清空）。 */
	async setTags(id: string, tags: string[]): Promise<void> {
		this.db.prepare('UPDATE media_asset SET tags = ? WHERE id = ?').run(serializeTags(tags), id);
	}

	/** 列出全部已使用过的标签（仅未删除资产），按出现次数降序。 */
	async listTags(): Promise<string[]> {
		const rows = this.db.prepare(
			'SELECT tags FROM media_asset WHERE is_deleted = 0 AND tags IS NOT NULL'
		).all() as Array<{ tags: string | null }>;
		const counts = new Map<string, number>();
		for (const r of rows) {
			for (const t of parseTags(r.tags)) {
				counts.set(t, (counts.get(t) ?? 0) + 1);
			}
		}
		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([t]) => t);
	}
}

/** 标签序列化为 JSON 数组字符串（保持稳定顺序，便于 LIKE 命中）。 */
function serializeTags(tags: readonly string[]): string | null {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of tags) {
		const t = raw.trim();
		if (!t || seen.has(t)) { continue; }
		seen.add(t);
		out.push(t);
	}
	return out.length ? JSON.stringify(out) : null;
}

/** 反序列化标签（脏数据一律退化为空数组，不让列表渲染炸掉）。 */
function parseTags(raw: string | null | undefined): string[] {
	if (!raw) { return []; }
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	} catch { return []; }
}

/** 单标签的 SQL LIKE 判据（JSON 数组里精确匹配一个元素）。 */
export function tagLikePattern(tag: string): string {
	return `%"${tag.replace(/"/g, '""')}"%`;
}
