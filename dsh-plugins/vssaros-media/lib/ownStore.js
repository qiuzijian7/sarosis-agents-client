// @vssaros/dsh-media — ownStore：**dsh 侧的媒体库真源**（2026-10-24，用户拍板"A：IDE 侧下线，全部搬 dsh"）。
//
// ── 为什么要有它 ────────────────────────────────────────────────────────────
//   原来媒体库的真源在 IDE 主进程（`{dataRoot}/media/media.db` + `{yyyy}/{mm}/{uuid}.{ext}`），
//   dsh 侧只能**只读镜像**（`lib/store.js` 的 `readOnly: true`：直连会 `disk I/O error`，且
//   "两个写者 ⇒ schema 必漂"）。用户决定把媒体库整体搬到 dsh 侧 ⇒ 这里就是新的唯一真源。
//
// ── 布局（与 IDE 侧**不同**，刻意不撞目录）───────────────────────────────────
//   `{dataRoot}/media-store/media.db`                     元数据（node:sqlite，只有我们一个写者）
//   `{dataRoot}/media-store/objects/<sha8[0..2]>/<sha8>.<ext>`
//     ⇒ **内容寻址**：同一张图只存一份（迁移时 562 个文件里大量重复会被自动合并）；
//       文件名可预测 ⇒ 备份/对账都简单。
//
// ── 与 IDE 侧字段的对应 ──────────────────────────────────────────────────────
//   IDE `media_asset`：id / provider / kind / ref / file_name / file_path / mime / meta_json /
//   created_at / size_bytes / is_deleted / board / favorite / tags
//   ⇒ 本模块：origin_id（= IDE 的 id，**唯一索引** ⇒ 迁移可重复跑且幂等）/ 其余同义 + sha8。
//
// ⚠ 迁移口径：`origin_id` 只用于"从 IDE 来"的那批；dsh 侧新产生的资产 origin_id 为 NULL。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * 加载内置 `node:sqlite`。
 *
 * ★ 用 `createRequire` 而不是 `process.getBuiltinModule`：后者要 node ≥ 22.3 且各版本行为不一
 *   （本机 22.22 有，但别赌用户的 Host）；内置模块 `require` 一定拿得到 ✓。
 */
function loadSqlite() {
	const req = createRequire(import.meta.url);
	return req('node:sqlite');
}

/** 媒体库根目录名（在数据根下面）。 */
const STORE_DIR = 'media-store';

/** 元数据表（我们唯一写者 ⇒ 建表与迁移都在这儿）。 */
const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS asset (
		id TEXT PRIMARY KEY,
		origin_id TEXT,
		sha8 TEXT NOT NULL,
		kind TEXT NOT NULL,
		mime TEXT,
		ext TEXT,
		bytes INTEGER,
		width INTEGER,
		height INTEGER,
		provider TEXT,
		source TEXT,
		prompt TEXT,
		model TEXT,
		meta_json TEXT,
		file_name TEXT,
		file_path TEXT NOT NULL,
		ref TEXT,
		created_at INTEGER NOT NULL,
		is_deleted INTEGER NOT NULL DEFAULT 0,
		favorite INTEGER NOT NULL DEFAULT 0,
		board TEXT,
		tags TEXT
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_origin ON asset(origin_id) WHERE origin_id IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS idx_asset_created ON asset(created_at DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_asset_sha ON asset(sha8)`,
	`CREATE INDEX IF NOT EXISTS idx_asset_kind ON asset(kind)`,
];

/** 扩展名归一（`jpeg` ⇒ `jpg`；未知就原样，别乱猜）。 */
export function normalizeExt(ext, mime) {
	const raw = String(ext || '').trim().replace(/^\./, '').toLowerCase();
	if (raw === 'jpeg') { return 'jpg'; }
	if (raw) { return raw; }
	const fromMime = String(mime || '').split('/')[1] || '';
	return fromMime === 'jpeg' ? 'jpg' : (fromMime || 'bin');
}

/** 字节 ⇒ sha256 前 8 位（内容寻址键；与 imagegen 工作区落盘同一口径）。 */
export function sha8Of(bytes) {
	return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

/** 行 ⇒ 对外形状（页面 / API / 工具共用；字段名与 IDE 侧 `MediaAsset` 尽量同义）。 */
function toAsset(row) {
	if (!row) { return undefined; }
	let tags = [];
	try { tags = row.tags ? JSON.parse(row.tags) : []; } catch { tags = []; }
	return {
		id: row.id,
		originId: row.origin_id ?? undefined,
		sha8: row.sha8,
		kind: row.kind,
		mime: row.mime ?? undefined,
		ext: row.ext ?? undefined,
		bytes: row.bytes ?? undefined,
		width: row.width ?? undefined,
		height: row.height ?? undefined,
		provider: row.provider ?? undefined,
		source: row.source ?? undefined,
		prompt: row.prompt ?? undefined,
		model: row.model ?? undefined,
		metaJson: row.meta_json ?? undefined,
		fileName: row.file_name ?? undefined,
		filePath: row.file_path,
		// ★ 2026-10-24：仅引用资产（无字节）⇒ `ref` 有值、`filePath` 是空串
		ref: row.ref ?? undefined,
		createdAt: row.created_at,
		isDeleted: row.is_deleted === 1,
		favorite: row.favorite === 1,
		board: row.board ?? undefined,
		tags,
	};
}

/**
 * 建一个 dsh 侧媒体库。
 * @param {object} options
 * @param {string} options.dataRoot 数据根（`~/.vssaros-dev`）
 * @returns {object} 库 API（见下面各方法）
 */
export function createOwnStore({ dataRoot }) {
	const root = join(String(dataRoot), STORE_DIR);
	const objectsDir = join(root, 'objects');
	const dbPath = join(root, 'media.db');
	mkdirSync(objectsDir, { recursive: true });

	// node:sqlite 是**惰性打开**（构造不报错）⇒ 第一条语句才是真正的探活。
	const { DatabaseSync } = loadSqlite();
	const db = new DatabaseSync(dbPath);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA busy_timeout = 5000');
	db.exec('PRAGMA synchronous = NORMAL');
	for (const sql of SCHEMA) { db.exec(sql); }
	// ★ 2026-10-24：老库补列（`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列）。
	//   `ref` 供**仅引用资产**用（只有 URL/相对名、没有字节 —— IDE 侧那 103 条 ComfyUI `/view?…`）。
	{
		const columns = db.prepare('PRAGMA table_info(asset)').all().map(column => String(column.name));
		if (!columns.includes('ref')) { db.exec('ALTER TABLE asset ADD COLUMN ref TEXT'); }
	}

	const stmt = {
		byId: db.prepare('SELECT * FROM asset WHERE id = ?'),
		byOrigin: db.prepare('SELECT * FROM asset WHERE origin_id = ?'),
		insert: db.prepare(`INSERT INTO asset
			(id, origin_id, sha8, kind, mime, ext, bytes, width, height, provider, source, prompt, model,
			 meta_json, file_name, file_path, ref, created_at, is_deleted, favorite, board, tags)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`),
		setDeleted: db.prepare('UPDATE asset SET is_deleted = ? WHERE id = ?'),
		setFavorite: db.prepare('UPDATE asset SET favorite = ? WHERE id = ?'),
		setTags: db.prepare('UPDATE asset SET tags = ? WHERE id = ?'),
		setBoard: db.prepare('UPDATE asset SET board = ? WHERE id = ?'),
		count: db.prepare('SELECT count(*) AS n FROM asset'),
	};

	/** 对象文件路径（内容寻址）。 */
	const objectPathOf = (sha8, ext) => join(objectsDir, sha8.slice(0, 2), `${sha8}.${normalizeExt(ext)}`);

	/**
	 * 入库一条资产。**幂等**：`originId` 已存在 ⇒ 直接返回已有那条（迁移可重复跑）。
	 * @param {object} input
	 * @param {Uint8Array} [input.bytes] 图字节（必填之一）
	 * @param {string} [input.base64] base64（不带 data: 前缀）
	 * @returns {object|undefined} 资产；内容为空 ⇒ undefined
	 */
	function importAsset(input = {}) {
		const bytes = input.bytes
			? Buffer.from(input.bytes)
			: (input.base64 ? Buffer.from(String(input.base64), 'base64') : undefined);
		const hasBytes = !!bytes && bytes.length > 0;
		const ref = input.ref ? String(input.ref).trim() : '';
		// ★ 2026-10-24：**仅引用资产**（只有 URL/相对名、没有字节）。IDE 侧有 103 条这种
		//   （ComfyUI 的 `/view?filename=…`，文件根本没落盘）⇒ 宁可"有条目但预览可能失效"，
		//   也不该让用户的东西凭空消失。要求至少给 bytes 或 ref 之一。
		if (!hasBytes && !ref) { return undefined; }
		const originId = input.originId ? String(input.originId) : undefined;
		if (originId) {
			const existing = stmt.byOrigin.get(originId);
			if (existing) { return toAsset(existing); }   // 幂等：迁移重复跑不会产生第二行
		}
		// 内容寻址键：有字节按字节；纯引用按 ref 字符串（同一 ref 也去重）
		const sha8 = sha8Of(hasBytes ? bytes : Buffer.from(ref, 'utf8'));
		const ext = normalizeExt(input.ext ?? String(input.fileName ?? ref).split('.').pop(), input.mime);
		const filePath = hasBytes ? objectPathOf(sha8, ext) : '';
		if (hasBytes && !existsSync(filePath)) {
			// 原子写：临时文件 + rename（同目录 ⇒ 同卷）；已存在就跳过（内容寻址 ⇒ 同内容同文件）
			mkdirSync(join(objectsDir, sha8.slice(0, 2)), { recursive: true });
			const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
			writeFileSync(tmp, bytes);
			try {
				if (!existsSync(filePath)) { renameSync(tmp, filePath); } else { rmSync(tmp, { force: true }); }
			} catch (e) {
				rmSync(tmp, { force: true });
				throw e;
			}
		}
		const id = randomUUID();
		stmt.insert.run(
			id,
			originId ?? null,
			sha8,
			String(input.kind || 'image'),
			input.mime ?? null,
			ext,
			hasBytes ? bytes.length : null,
			Number.isFinite(Number(input.width)) ? Number(input.width) : null,
			Number.isFinite(Number(input.height)) ? Number(input.height) : null,
			input.provider ?? null,
			input.source ?? null,
			input.prompt ? String(input.prompt).slice(0, 2000) : null,
			input.model ?? null,
			input.metaJson ?? (input.meta ? JSON.stringify(input.meta) : null),
			input.fileName ?? null,
			filePath,
			ref || null,
			Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : Date.now(),
			input.board ?? null,
			Array.isArray(input.tags) && input.tags.length ? JSON.stringify(input.tags) : null,
		);
		return toAsset(stmt.byId.get(id));
	}

	/**
	 * 列资产（默认只列未删除的，按生成时间倒序）。
	 * @param {object} [filter]
	 * @returns {{items: object[], total: number}}
	 */
	function list(filter = {}) {
		const where = [];
		const args = [];
		if (!filter.includeDeleted) { where.push('is_deleted = 0'); }
		if (filter.kind) { where.push('kind = ?'); args.push(String(filter.kind)); }
		if (filter.provider) { where.push('provider = ?'); args.push(String(filter.provider)); }
		if (filter.source) { where.push('source = ?'); args.push(String(filter.source)); }
		if (filter.board) { where.push('board = ?'); args.push(String(filter.board)); }
		if (filter.favorite === true) { where.push('favorite = 1'); }
		if (filter.query) {
			where.push('(file_name LIKE ? OR prompt LIKE ? OR meta_json LIKE ?)');
			const like = `%${String(filter.query)}%`;
			args.push(like, like, like);
		}
		if (filter.tag) { where.push('tags LIKE ?'); args.push(`%"${String(filter.tag)}"%`); }
		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const totalRow = db.prepare(`SELECT count(*) AS n FROM asset ${clause}`).get(...args);
		const limit = Number.isFinite(Number(filter.limit)) && Number(filter.limit) > 0 ? Math.min(500, Number(filter.limit)) : 100;
		const offset = Number.isFinite(Number(filter.offset)) && Number(filter.offset) > 0 ? Number(filter.offset) : 0;
		const rows = db.prepare(`SELECT * FROM asset ${clause} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).all(...args, limit, offset);
		return { items: rows.map(toAsset), total: Number(totalRow?.n ?? 0) };
	}

	/** 按 id 取一条。 */
	function get(id) {
		return toAsset(stmt.byId.get(String(id ?? '')));
	}

	/** 按来源 id（IDE media.db 的 id）取一条 —— 迁移对账用。 */
	function getByOrigin(originId) {
		return toAsset(stmt.byOrigin.get(String(originId ?? '')));
	}

	/** 读字节（页面/接口要渲染时用）。文件丢了 ⇒ undefined（不假装有）。 */
	function readBytes(id) {
		const asset = get(id);
		if (!asset) { return undefined; }
		try { return readFileSync(asset.filePath); } catch { return undefined; }
	}

	/** 软删（回收站语义，与 IDE 侧一致）。 */
	function softDelete(id) {
		stmt.setDeleted.run(1, String(id ?? ''));
		return get(id);
	}

	/** 从回收站恢复。 */
	function restore(id) {
		stmt.setDeleted.run(0, String(id ?? ''));
		return get(id);
	}

	/** 收藏 / 取消收藏。 */
	function setFavorite(id, favorite) {
		stmt.setFavorite.run(favorite ? 1 : 0, String(id ?? ''));
		return get(id);
	}

	/** 写标签（去重后存 JSON 数组）。 */
	function setTags(id, tags) {
		const cleaned = [...new Set((Array.isArray(tags) ? tags : []).map(String).map(s => s.trim()).filter(Boolean))];
		stmt.setTags.run(cleaned.length ? JSON.stringify(cleaned) : null, String(id ?? ''));
		return get(id);
	}

	/** 归到某个面板/分组（空串 = 取消）。 */
	function setBoard(id, board) {
		stmt.setBoard.run(String(board ?? '').trim() || null, String(id ?? ''));
		return get(id);
	}

	/** 统计（页面头部的"N 张图 / N 段视频"）。 */
	function stats() {
		const byKind = db.prepare('SELECT kind, count(*) AS n FROM asset WHERE is_deleted = 0 GROUP BY kind').all();
		const byProvider = db.prepare('SELECT provider, count(*) AS n FROM asset WHERE is_deleted = 0 GROUP BY provider').all();
		const bytesRow = db.prepare('SELECT sum(bytes) AS b FROM asset WHERE is_deleted = 0').get();
		return {
			total: Number(stmt.count.get()?.n ?? 0),
			live: byKind.reduce((sum, row) => sum + Number(row.n ?? 0), 0),
			bytes: Number(bytesRow?.b ?? 0),
			byKind,
			byProvider,
			root,
			dbPath,
		};
	}

	/** 关库（探针/退出时用）。 */
	function close() {
		try { db.close(); } catch { /* 已经关了 */ }
	}

	return {
		root, dbPath, objectsDir,
		importAsset, list, get, getByOrigin, readBytes,
		softDelete, restore, setFavorite, setTags, setBoard, stats, close,
	};
}
