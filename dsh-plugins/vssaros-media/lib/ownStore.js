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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
		tags TEXT,
		note TEXT
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
		// ★ 2026-10-26（媒体库改版 A 案）：检查器里的「注释」（参考 Eagle 的 note 区块）。
		note: row.note ?? undefined,
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
		// ★ 2026-10-26：检查器「注释」列。老库就地补列（`ALTER TABLE` 可重复跑，判存在即可）。
		if (!columns.includes('note')) { db.exec('ALTER TABLE asset ADD COLUMN note TEXT'); }
	}

	const stmt = {
		byId: db.prepare('SELECT * FROM asset WHERE id = ?'),
		byOrigin: db.prepare('SELECT * FROM asset WHERE origin_id = ?'),
		insert: db.prepare(`INSERT INTO asset
			(id, origin_id, sha8, kind, mime, ext, bytes, width, height, provider, source, prompt, model,
			 meta_json, file_name, file_path, ref, created_at, is_deleted, favorite, board, tags, note)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`),
		setDeleted: db.prepare('UPDATE asset SET is_deleted = ? WHERE id = ?'),
		setFavorite: db.prepare('UPDATE asset SET favorite = ? WHERE id = ?'),
		setTags: db.prepare('UPDATE asset SET tags = ? WHERE id = ?'),
		setBoard: db.prepare('UPDATE asset SET board = ? WHERE id = ?'),
		setNote: db.prepare('UPDATE asset SET note = ? WHERE id = ?'),
		count: db.prepare('SELECT count(*) AS n FROM asset'),
	};

	/** 对象文件路径（内容寻址）。 */
	const objectPathOf = (sha8, ext) => join(objectsDir, sha8.slice(0, 2), `${sha8}.${normalizeExt(ext)}`);

	// ★ 2026-10-26（改版 A 案，用户拍板 ⑤）：缩略图缓存目录 `media-store/thumbs/<sha8>.webp`。
	//   内容寻址 ⇒ 与对象一一对应（320 份去重文件 ⇒ 最多 320 张缩略图），改文件名/改分组都不会失效。
	//   ⚠ Host 侧没有图像编码器（零依赖）⇒ 真正"把原图缩放成 webp"这一步由**页面**完成并回传（见 index.js
	//     的 `POST api/thumb/<id>`）；这里只负责"路径 + 命中判断 + 落盘"。装了 sharp 时可切成 Host 侧生成。
	const thumbsDir = join(root, 'thumbs');
	const thumbPathOf = sha8 => join(thumbsDir, `${String(sha8 ?? '')}.webp`);
	/** 这张的缩略图已经在缓存里了吗（页面据此决定首图 URL，省掉一次 404）。 */
	const hasThumbOf = sha8 => !!sha8 && existsSync(thumbPathOf(sha8));

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
			input.note ? String(input.note).slice(0, 4000) : null,
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
		// `onlyDeleted`（回收站视图：只要软删的）；`includeDeleted`（软删+未删一起，对账用）
		if (filter.onlyDeleted === true) { where.push('is_deleted = 1'); }
		else if (!filter.includeDeleted) { where.push('is_deleted = 0'); }
		if (filter.kind) { where.push('kind = ?'); args.push(String(filter.kind)); }
		if (filter.provider) { where.push('provider = ?'); args.push(String(filter.provider)); }
		if (filter.source) { where.push('source = ?'); args.push(String(filter.source)); }
		if (filter.board) { where.push('board = ?'); args.push(String(filter.board)); }
		if (filter.favorite === true) { where.push('favorite = 1'); }
		// ★ 2026-10-26（改版 A 案左栏）：Eagle 的「未标签 / 未分类」两个默认导航。
		//   `untagged` = 没有任何标签；`unclassified` = 没归分组（board 为空/NULL）。
		if (filter.untagged === true) { where.push("(tags IS NULL OR tags = '' OR tags = '[]')"); }
		if (filter.unclassified === true) { where.push("(board IS NULL OR board = '')"); }
		if (filter.query) {
			// ★ 2026-10-26：搜索**也搜标签与分组**（旧口径只搜 file_name/prompt/meta_json ⇒ 搜标签搜不到）。
			where.push('(file_name LIKE ? OR prompt LIKE ? OR meta_json LIKE ? OR tags LIKE ? OR board LIKE ?)');
			const like = `%${String(filter.query)}%`;
			args.push(like, like, like, like, like);
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

	/** 读字节（**同步**：工具/探针用；HTTP 路由请用 `readBytesAsync`，别堵事件循环）。 */
	function readBytes(id) {
		const asset = get(id);
		if (!asset) { return undefined; }
		try { return readFileSync(asset.filePath); } catch { return undefined; }
	}

	/**
	 * 异步读字节（HTTP 路由用）。
	 *
	 * ★ 2026-10-26 真机事故：`/x/media/api/bytes/<id>` 原来走 `readFileSync` ⇒ 页面一次性要 79 个
	 *   **视频**原文件时，Host 的主线程被同步 I/O 顶住，整个 dsh 界面（含切页签）一起卡死。
	 *   改成 `fsp.readFile` 后，大文件只占 I/O 带宽、不再占事件循环。
	 * @returns {Promise<{asset: object, bytes: Buffer}|undefined>} 资产或文件没了 ⇒ undefined
	 */
	async function readBytesAsync(id) {
		const asset = get(id);
		if (!asset) { return undefined; }
		try {
			const bytes = await readFile(asset.filePath);
			return bytes.length ? { asset, bytes } : undefined;
		} catch { return undefined; }
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

	/** 合并标签（在原有基础上追加；大小写不敏感去重）。返回最终列表。 */
	function addTags(id, tags) {
		const current = get(id);
		if (!current) { return undefined; }
		const merged = [...current.tags];
		const seen = new Set(merged.map(t => t.toLowerCase()));
		for (const raw of (Array.isArray(tags) ? tags : [])) {
			const name = String(raw ?? '').trim();
			if (!name || seen.has(name.toLowerCase())) { continue; }
			seen.add(name.toLowerCase());
			merged.push(name);
		}
		return setTags(id, merged);
	}

	/** 遍历未删资产（自带解析好的 tags）。 */
	function liveRows() {
		return db.prepare('SELECT * FROM asset WHERE is_deleted = 0').all().map(row => {
			let tags = [];
			try { tags = row.tags ? JSON.parse(row.tags) : []; } catch { tags = []; }
			return {
				id: String(row.id ?? ''),
				kind: String(row.kind ?? 'image'),
				fileName: row.file_name ? String(row.file_name) : '',
				filePath: row.file_path ? String(row.file_path) : '',
				ref: row.ref ? String(row.ref) : '',
				prompt: row.prompt ? String(row.prompt) : '',
				provider: row.provider ? String(row.provider) : 'local',
				width: Number(row.width ?? 0) || 0,
				height: Number(row.height ?? 0) || 0,
				createdAt: Number(row.created_at ?? 0) || 0,
				metaJson: row.meta_json ? String(row.meta_json) : '',
				board: row.board ? String(row.board) : '',
				tags: Array.isArray(tags) ? tags.map(String) : [],
			};
		});
	}

	/** 从文本里抽候选关键词（中文按 2–6 字连续串，英文/数字按词；去掉太通用的）。 */
	const STOP_WORDS = new Set(['the', 'and', 'with', 'for', 'a', 'an', 'of', 'to', 'in', 'on', 'image', 'picture', 'photo']);
	function keywordsOf(text, limit = 2) {
		const raw = String(text ?? '');
		if (!raw.trim()) { return []; }
		const out = [];
		// 英文/数字词
		for (const word of raw.match(/[A-Za-z][A-Za-z0-9_-]{1,15}/g) ?? []) {
			if (STOP_WORDS.has(word.toLowerCase())) { continue; }
			out.push(word);
			if (out.length >= limit * 2) { break; }
		}
		// 中文连续串（取 2–6 字，取前若干）
		for (const seg of raw.match(/[\u4e00-\u9fa5]{2,12}/g) ?? []) {
			out.push(seg.length > 6 ? seg.slice(0, 6) : seg);
			if (out.length >= limit * 2) { break; }
		}
		return [...new Set(out)].slice(0, limit);
	}

	/**
	 * **规则打标**：按元数据给资产补标签（不改已有标签，只追加）。
	 *
	 * ⚠ 说清楚这是"根据**元数据**"而不是"看图"：Host 侧没有图像编码器（见 `reference_host_no_image_encoder`），
	 *   也没有视觉模型 ⇒ 像素级语义（角色/风格/场景）打不了。这里能做的是**确定性、可复核**的规则：
	 *   · `orientation` 横/竖/方（需要 width/height）
	 *   · `size`        大图 / 小图（按像素数分档）
	 *   · `keyword`     从 prompt / 文件名抽词
	 *   · `month`       `YYYY-MM`（按 created_at）
	 *   · `provider`    `来源:xxx`
	 * 要语义标签，得先有视觉能力（LightAI 视觉 / IDE 侧实现 `visionAnalyze`），到时加一个 rule 即可。
	 *
	 * @param {{ids?: string[], limit?: number, rules?: string[], dryRun?: boolean}} [options]
	 */
	function autoTag(options = {}) {
		const rules = Array.isArray(options.rules) && options.rules.length
			? options.rules.map(String)
			: ['orientation', 'size', 'keyword'];
		const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 500);
		const onlyIds = Array.isArray(options.ids) && options.ids.length ? new Set(options.ids.map(String)) : null;
		const dryRun = options.dryRun === true;
		const changes = [];
		let scanned = 0;
		for (const row of liveRows()) {
			if (onlyIds && !onlyIds.has(row.id)) { continue; }
			if (scanned >= limit) { break; }
			scanned++;
			const add = [];
			if (rules.includes('orientation') && row.width && row.height) {
				const ratio = row.width / row.height;
				add.push(ratio > 1.15 ? '横图' : ratio < 0.87 ? '竖图' : '方图');
			}
			if (rules.includes('size') && row.width && row.height) {
				const pixels = row.width * row.height;
				if (pixels >= 2_000_000) { add.push('大图'); }
				else if (pixels > 0 && pixels <= 300_000) { add.push('小图'); }
			}
			if (rules.includes('keyword')) {
				for (const word of keywordsOf(row.prompt, 2)) { add.push(word); }
				const base = row.fileName.replace(/\.[a-z0-9]{1,5}$/i, '');
				for (const word of keywordsOf(base, 1)) { add.push(word); }
			}
			if (rules.includes('month') && row.createdAt) {
				const d = new Date(row.createdAt);
				add.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
			}
			if (rules.includes('provider')) { add.push(`来源:${row.provider}`); }
			const have = new Set(row.tags.map(t => t.toLowerCase()));
			const fresh = [...new Set(add)].filter(t => t && !have.has(t.toLowerCase()));
			if (!fresh.length) { continue; }
			changes.push({ id: row.id, name: row.fileName || row.id.slice(0, 8), add: fresh });
			if (!dryRun) { addTags(row.id, fresh); }
		}
		return { dryRun, rules, scanned, tagged: changes.length, changes };
	}

	/**
	 * **标签整理**：规范化 + 合并同义写法。
	 *   · 规范化 = 去首尾空白、内部连续空白折成一个、全角尖括号之类不动
	 *   · 合并 = 大小写不敏感（`Cat` / `cat` 留计数最多的写法）
	 * @param {{dryRun?: boolean}} [options]
	 */
	function mergeTags(options = {}) {
		const dryRun = options.dryRun === true;
		const groups = new Map();   // 小写键 → { forms: Map<原写法, 次数>, ids: [] }
		for (const row of liveRows()) {
			for (const tag of row.tags) {
				const norm = tag.trim().replace(/\s+/g, ' ');
				if (!norm) { continue; }
				const key = norm.toLowerCase();
				const group = groups.get(key) ?? { forms: new Map(), ids: [] };
				group.forms.set(norm, (group.forms.get(norm) ?? 0) + 1);
				group.ids.push(row.id);
				groups.set(key, group);
			}
		}
		const mapping = Object.create(null);
		for (const [, group] of groups) {
			if (group.forms.size <= 1) { continue; }
			// 保留出现最多、其次最长的写法
			const best = [...group.forms.entries()]
				.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
			for (const form of group.forms.keys()) {
				if (form !== best) { mapping[form] = best; }
			}
		}
		const touched = [];
		if (Object.keys(mapping).length) {
			for (const row of liveRows()) {
				let changed = false;
				const next = row.tags.map(tag => {
					const target = mapping[tag.trim().replace(/\s+/g, ' ')];
					if (target) { changed = true; return target; }
					return tag;
				});
				if (!changed) { continue; }
				touched.push(row.id);
				if (!dryRun) { setTags(row.id, next); }
			}
		}
		return {
			dryRun,
			mapping,
			mergedTags: Object.keys(mapping).length,
			affected: touched.length,
			before: facets().tags,
		};
	}

	/**
	 * **目录整理**：给**还没分组**的资产按规则算一个分组并落库（不覆盖已有分组）。
	 * @param {{mode?: 'provider'|'kind'|'date'|'tag', dryRun?: boolean, prefix?: string,
	 *   overwrite?: boolean, limit?: number}} [options]
	 */
	function planBoards(options = {}) {
		const mode = ['provider', 'kind', 'date', 'tag'].includes(String(options.mode)) ? String(options.mode) : 'provider';
		const prefix = String(options.prefix ?? '');
		const overwrite = options.overwrite === true;
		const dryRun = options.dryRun !== false;      // ⚠ 默认 **dryRun**：改结构是破坏性动作，必须显式 false
		const limit = Math.min(Math.max(Number(options.limit) || 500, 1), 2000);
		const kindLabel = { image: '图片', video: '视频', audio: '音频', text: '文本' };
		const planned = new Map();
		const moved = [];
		let skipped = 0;
		for (const row of liveRows()) {
			if (!overwrite && row.board) { skipped++; continue; }
			let board = '';
			if (mode === 'provider') { board = row.provider || 'local'; }
			else if (mode === 'kind') { board = kindLabel[row.kind] ?? row.kind; }
			else if (mode === 'date') {
				const d = new Date(row.createdAt);
				board = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
			} else if (mode === 'tag') { board = row.tags[0] ? String(row.tags[0]) : ''; }
			if (!board) { skipped++; continue; }
			const target = prefix ? `${prefix}${board}` : board;
			planned.set(target, (planned.get(target) ?? 0) + 1);
			if (moved.length < limit) {
				moved.push({ id: row.id, name: row.fileName || row.id.slice(0, 8), board: target });
				if (!dryRun) { setBoard(row.id, target); }
			}
		}
		return {
			dryRun,
			mode,
			boards: [...planned.entries()].map(([board, n]) => ({ board, n })).sort((a, b) => b.n - a.n),
			moved: moved.length,
			skipped,
			sample: moved.slice(0, 20),
		};
	}

	/**
	 * 永久删除一条（行 + 文件）。
	 *
	 * ★ 2026-10-26（用户拍板「清空回收站 / 永久删除」本轮补上）：以前只有软删，
	 *   而 IDE 侧那套画廊有 `purgeDeleted` / `cleanOrphaned` / `enforceQuota` ⇒ 搬过来。
	 * ⚠ **内容寻址**：同一个 `sha8` 可能对应多行（同一张图重复入库）⇒ 只有**再没有别的行引用**时
	 *   才删对象文件与缩略图，否则会把别的卡片一起弄裂。
	 * @returns {{ok: boolean, id?: string, removedFile?: boolean, removedThumb?: boolean, freedBytes?: number, error?: string}}
	 */
	function purge(id) {
		const asset = get(id);
		if (!asset) { return { ok: false, error: '没有这条资产' }; }
		db.prepare('DELETE FROM asset WHERE id = ?').run(String(id));
		let removedFile = false;
		let removedThumb = false;
		let freedBytes = 0;
		const stillUsed = Number(db.prepare('SELECT count(*) AS n FROM asset WHERE sha8 = ?').get(asset.sha8)?.n ?? 0) > 0;
		if (!stillUsed && asset.sha8) {
			if (asset.filePath) {
				try {
					const size = statSync(asset.filePath).size;
					rmSync(asset.filePath, { force: true });
					removedFile = true;
					freedBytes = size;
				} catch { /* 文件已经不在了 —— 行照删（正是要清理的状态） */ }
			}
			try { rmSync(thumbPathOf(asset.sha8), { force: true }); removedThumb = true; } catch { /* 同上 */ }
		}
		return { ok: true, id: String(id), removedFile, removedThumb, freedBytes };
	}

	/** 清空回收站（只动 `is_deleted = 1` 的行）。返回账目，失败逐条记账不假装成功。 */
	function purgeDeleted() {
		const rows = db.prepare('SELECT id FROM asset WHERE is_deleted = 1').all();
		const out = { count: 0, removedFiles: 0, removedThumbs: 0, freedBytes: 0, failed: [] };
		for (const row of rows) {
			const r = purge(row.id);
			if (!r.ok) { out.failed.push(String(row.id)); continue; }
			out.count++;
			if (r.removedFile) { out.removedFiles++; out.freedBytes += r.freedBytes; }
			if (r.removedThumb) { out.removedThumbs++; }
		}
		return out;
	}

	/**
	 * 删孤儿文件：`objects/` 下没有行引用、`thumbs/` 下没有对象对应的。
	 * 判据用「行里出现的 file_path」（大小写不敏感，Windows）+「行里的 sha8」双保险。
	 */
	function cleanOrphaned() {
		const shas = new Set(db.prepare('SELECT DISTINCT sha8 FROM asset WHERE sha8 IS NOT NULL').all().map(r => String(r.sha8)));
		const keepPaths = new Set(db.prepare('SELECT DISTINCT file_path FROM asset WHERE file_path IS NOT NULL AND file_path <> \'\'')
			.all().map(r => String(r.file_path).replace(/\\/g, '/').toLowerCase()));
		const out = { removedObjects: 0, removedThumbs: 0, freedBytes: 0 };
		if (existsSync(objectsDir)) {
			for (const bucket of readdirSync(objectsDir)) {
				const dir = join(objectsDir, bucket);
				let st;
				try { st = statSync(dir); } catch { continue; }
				if (!st.isDirectory()) { continue; }
				for (const name of readdirSync(dir)) {
					const full = join(dir, name);
					const key = full.replace(/\\/g, '/').toLowerCase();
					const sha8 = name.split('.')[0];
					if (keepPaths.has(key) || shas.has(sha8)) { continue; }
					try {
						const size = statSync(full).size;
						rmSync(full, { force: true });
						out.removedObjects++;
						out.freedBytes += size;
					} catch { /* 删不掉就留着，下次再清 */ }
				}
			}
		}
		if (existsSync(thumbsDir)) {
			for (const name of readdirSync(thumbsDir)) {
				const sha8 = name.replace(/\.webp$/i, '');
				if (shas.has(sha8)) { continue; }
				try { rmSync(join(thumbsDir, name), { force: true }); out.removedThumbs++; } catch { /* 同上 */ }
			}
		}
		return out;
	}

	/** 占用明细（页面在做破坏性操作前先给个数）。 */
	function usage() {
		const sumDir = (dir) => {
			let files = 0;
			let bytes = 0;
			if (!existsSync(dir)) { return { files, bytes }; }
			const walk = (d) => {
				let entries = [];
				try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
				for (const e of entries) {
					const p = join(d, e.name);
					if (e.isDirectory()) { walk(p); continue; }
					try { bytes += statSync(p).size; files++; } catch { /* 读不到就跳过 */ }
				}
			};
			walk(dir);
			return { files, bytes };
		};
		const live = Number(db.prepare('SELECT count(*) AS n FROM asset WHERE is_deleted = 0').get()?.n ?? 0);
		const deleted = Number(db.prepare('SELECT count(*) AS n FROM asset WHERE is_deleted = 1').get()?.n ?? 0);
		const deletedBytes = Number(db.prepare('SELECT sum(bytes) AS b FROM asset WHERE is_deleted = 1').get()?.b ?? 0);
		return {
			rows: { live, deleted, total: live + deleted },
			deletedBytes,
			objects: sumDir(objectsDir),
			thumbs: sumDir(thumbsDir),
		};
	}

	/** 写「注释」（空串 = 清空）。 */
	function setNote(id, note) {
		const text = String(note ?? '').trim();
		stmt.setNote.run(text ? text.slice(0, 4000) : null, String(id ?? ''));
		return get(id);
	}

	/**
	 * 左栏用的聚合（分组 / 标签 / 来源 / 类型计数 + 未标签 / 未分类 / 收藏 / 回收站）。
	 *
	 * 为什么不用 SQL 的 `json_each`：`tags` 是我们自己写的 JSON 数组，但老库/迁移来的行可能是 NULL
	 * 或畸形串 ⇒ 用 JS 聚合（667 行量级，一次不到 1ms）比赌 JSON1 扩展的存在更稳 ✓。
	 * @returns {{boards: {name: string, n: number}[], tags: ..., providers: ..., kinds: ...,
	 *   untagged: number, unclassified: number, favorite: number, deleted: number}}
	 */
	function facets() {
		const rows = db.prepare('SELECT kind, board, tags, provider FROM asset WHERE is_deleted = 0').all();
		const boards = new Map();
		const tags = new Map();
		const providers = new Map();
		const kinds = new Map();
		let untagged = 0;
		let unclassified = 0;
		for (const row of rows) {
			const board = row.board ? String(row.board) : '';
			if (board) { boards.set(board, (boards.get(board) ?? 0) + 1); } else { unclassified++; }
			let list = [];
			try { list = row.tags ? JSON.parse(row.tags) : []; } catch { list = []; }
			if (!Array.isArray(list) || list.length === 0) { untagged++; }
			for (const t of (Array.isArray(list) ? list : [])) {
				const name = String(t).trim();
				if (name) { tags.set(name, (tags.get(name) ?? 0) + 1); }
			}
			const provider = row.provider ? String(row.provider) : 'local';
			providers.set(provider, (providers.get(provider) ?? 0) + 1);
			kinds.set(String(row.kind), (kinds.get(String(row.kind)) ?? 0) + 1);
		}
		const desc = map => [...map.entries()]
			.map(([name, n]) => ({ name, n }))
			.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
		const favorite = db.prepare('SELECT count(*) AS n FROM asset WHERE is_deleted = 0 AND favorite = 1').get();
		const deleted = db.prepare('SELECT count(*) AS n FROM asset WHERE is_deleted = 1').get();
		return {
			boards: desc(boards),
			tags: desc(tags),
			providers: desc(providers),
			kinds: desc(kinds),
			untagged,
			unclassified,
			favorite: Number(favorite?.n ?? 0),
			deleted: Number(deleted?.n ?? 0),
		};
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
		root, dbPath, objectsDir, thumbsDir,
		thumbPathOf, hasThumbOf,
		importAsset, list, get, getByOrigin, readBytes, readBytesAsync,
		softDelete, restore, setFavorite, setTags, addTags, setBoard, setNote,
		// 2026-10-26：「媒体库管家」的三个整理动作（规则打标 / 标签整理 / 目录整理）
		autoTag, mergeTags, planBoards, liveRows,
		// 2026-10-26：破坏性清理（对齐 IDE 侧那套 purgeDeleted / cleanOrphaned / usage）
		purge, purgeDeleted, cleanOrphaned, usage,
		stats, facets, close,
	};
}
