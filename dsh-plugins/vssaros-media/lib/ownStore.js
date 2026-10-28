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
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

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
export function createOwnStore({ dataRoot, archiveDir, archiveLayout }) {
	const root = join(String(dataRoot), STORE_DIR);
	const objectsDir = join(root, 'objects');
	const dbPath = join(root, 'media.db');
	mkdirSync(objectsDir, { recursive: true });

	/**
	 * **自动归档目录**（2026-10-27：「生成时顺手落一份可读文件」）。
	 *
	 * 默认 `<数据根>/media-store/archive` —— **刻意放在同一个卷**上：归档走硬链接 ⇒ 不额外占空间。
	 * 指到别的盘（如 `D:\AI素材`）也能用，但那样会真的复制一份（页面的 usage / toast 会写明"占用"）。
	 * 传空串 = 关闭自动归档（手动「📤 导出到文件夹」仍可用）。
	 */
	const archiveRoot = archiveDir === undefined || archiveDir === null
		? join(root, 'archive')
		: String(archiveDir).trim();
	const archiveMode = ['provider', 'kind', 'date', 'flat'].includes(String(archiveLayout))
		? String(archiveLayout) : 'provider';
	/**
	 * 归档成败计数（不抛、不阻塞生图/入库 —— 用户的图已经生成好了）。
	 * 「重试」不单独做：导出本身**幂等**（同名跳过）⇒ 之后手动跑一次「导出到文件夹」就把漏的补齐。
	 */
	const archiveStats = { dir: archiveRoot, ok: 0, copied: 0, failed: 0, lastError: '' };

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
		const created = toAsset(stmt.byId.get(id));
		// ★ 2026-10-27：入库后顺手归档一份可读文件（失败不影响入库，见 archiveOne 的决策说明）
		const archivePath = archiveOne(created);
		return archivePath ? { ...created, archivePath } : created;
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

	/** 这条资产的文件是不是落在**我们自己的对象库**（`objects/`）里。 */
	function isManagedPath(filePath) {
		const p = String(filePath ?? '').replace(/\\/g, '/').toLowerCase();
		if (!p) { return false; }
		const root = objectsDir.replace(/\\/g, '/').toLowerCase();
		return p === root || p.startsWith(root + '/');
	}

	/** 可链接的文件类型（扩展名 → kind）。 */
	const LINK_KINDS = {
		image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'],
		video: ['mp4', 'webm', 'mov', 'mkv', 'avi'],
		audio: ['mp3', 'wav', 'flac', 'm4a', 'ogg'],
		text: ['txt', 'md', 'json'],
	};
	const MIME_BY_EXT = {
		png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
		bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
		mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
		mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg',
		txt: 'text/plain', md: 'text/markdown', json: 'application/json',
	};
	function kindOfExt(ext) {
		for (const kind of Object.keys(LINK_KINDS)) {
			if (LINK_KINDS[kind].includes(ext)) { return kind; }
		}
		return '';
	}

	/**
	 * **链接一个外部文件夹**（2026-10-27，用户问「能否显示文件夹里的独立文件」）：把目录里的媒体文件
	 * 登记成资产，**不复制、不移动字节** —— `file_path` 直接指向用户的原文件，预览走 `/api/bytes/<id>`。
	 *
	 * 与「导入」的区别：
	 *   · 导入 = 读字节 → 写进 `objects/<sha8>` → 之后与源文件无关（可删可移）；
	 *   · 链接 = 只登记路径；**源文件被移走/删掉，这条就看不到图**（这是"引用"的固有代价，页面会退化到字形）。
	 *
	 * 安全边界（必须守住）：
	 *   · `purge()` 对"不在 `objects/` 里"的资产**只删行、绝不删文件**（用户的文件不是我们的）；
	 *   · 幂等：同一个路径已登记过就跳过；`dryRun` 只扫描不落库。
	 *
	 * @param {{dir?: string, recursive?: boolean, dryRun?: boolean, limit?: number}} [options]
	 */
	function linkFolder(options = {}) {
		const dir = String(options.dir ?? '').trim();
		if (!dir) { return { ok: false, error: '要提供文件夹路径' }; }
		if (!existsSync(dir)) { return { ok: false, error: `文件夹不存在：${dir}` }; }
		let isDir = false;
		try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
		if (!isDir) { return { ok: false, error: `不是一个文件夹：${dir}` }; }
		const recursive = options.recursive !== false;
		const dryRun = options.dryRun === true;
		const limit = Math.min(Math.max(Number(options.limit) || 2000, 1), 5000);
		// 已登记的路径（大小写不敏感，Windows）
		const known = new Set(db.prepare('SELECT file_path FROM asset WHERE file_path IS NOT NULL').all()
			.map(row => String(row.file_path).replace(/\\/g, '/').toLowerCase()));
		const todo = [];
		const skip = { linked: 0, unreadable: 0, unsupported: 0, truncated: 0 };
		const walk = (current) => {
			let entries = [];
			try { entries = readdirSync(current, { withFileTypes: true }); } catch { skip.unreadable++; return; }
			for (const entry of entries) {
				const full = join(current, entry.name);
				if (entry.isDirectory()) {
					if (recursive) { walk(full); }
					continue;
				}
				const ext = String(entry.name).split('.').pop().toLowerCase();
				const kind = kindOfExt(ext);
				if (!kind) { skip.unsupported++; continue; }
				if (todo.length >= limit) { skip.truncated++; continue; }
				const key = full.replace(/\\/g, '/').toLowerCase();
				if (known.has(key)) { skip.linked++; continue; }
				let stat;
				try { stat = statSync(full); } catch { skip.unreadable++; continue; }
				if (!stat.isFile() || stat.size <= 0) { skip.unreadable++; continue; }
				let sha8;
				try {
					// 大文件（>32MB）不整段读：用「路径 + 大小 + 修改时间」当指纹（缩略图缓存仍然稳定）
					sha8 = stat.size > 32 * 1024 * 1024
						? sha8Of(Buffer.from(`${key}|${stat.size}|${Math.round(stat.mtimeMs)}`, 'utf8'))
						: sha8Of(readFileSync(full));
				} catch { skip.unreadable++; continue; }
				known.add(key);
				todo.push({ path: full, name: entry.name, ext, kind, sha8, bytes: stat.size, createdAt: Math.round(stat.mtimeMs) });
			}
		};
		walk(dir);
		const ids = [];
		if (!dryRun) {
			for (const item of todo) {
				const id = randomUUID();
				stmt.insert.run(
					id,
					null,
					item.sha8,
					item.kind,
					MIME_BY_EXT[item.ext] ?? null,
					item.ext,
					item.bytes,
					null,
					null,
					'folder',                 // provider：左栏「来源」里能单独筛出"链接文件夹"这批
					'folder',                 // source
					null,
					null,
					JSON.stringify({ linkedFolder: dir }),
					item.name,
					item.path,                // ★ 指向用户的原文件，不复制
					null,
					item.createdAt,
					null,
					null,
					null,
				);
				ids.push(id);
			}
		}
		return {
			ok: true,
			dryRun,
			dir,
			recursive,
			added: todo.length,
			skipped: skip,
			ids,
			items: todo.slice(0, 20).map(item => ({ name: item.name, kind: item.kind, path: item.path })),
		};
	}

	/** 导出时的文件名：可读 slug + sha8 前 6 位（可读，又不丢唯一性）。 */
	function exportNameOf(asset) {
		const base = String(asset.fileName ?? '').replace(/\.[a-z0-9]{1,5}$/i, '');
		const slug = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
		const ext = normalizeExt(asset.ext, asset.mime);
		return `${slug || 'asset'}-${String(asset.sha8 ?? '').slice(0, 6)}.${ext}`;
	}

	/** 导出/归档的目标绝对路径（`exportAssets` 与"入库即归档"共用同一套命名规则）。 */
	function exportTargetOf(asset, dir, layout) {
		const when = new Date(Number(asset.createdAt) || Date.now());
		const month = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`;
		const group = layout === 'flat' ? ''
			: layout === 'kind' ? ({ image: '图片', video: '视频', audio: '音频', text: '文本' })[String(asset.kind)] ?? String(asset.kind)
				: layout === 'date' ? month
					: (String(asset.provider ?? '') || 'local');
		const targetDir = layout === 'date' ? join(dir, month)
			: (group ? join(dir, group, month) : join(dir, month));
		return join(targetDir, exportNameOf(asset));
	}

	/**
	 * 把**刚入库**的一份字节顺手归档成可读文件（`archiveDir` 为空则跳过）。
	 *
	 * 决策（用户 2026-10-27 让我定）：
	 *   · **失败就静默降级**：绝不因为归档失败让生成/入库报错（图已经生成好了）；只记进 `archiveStats`，
	 *     由 `GET api/usage` 暴露，页面 toast 不打扰；
	 *   · **不做自动重试**：导出是幂等的（同名跳过），之后手动跑一次「导出到文件夹」就把漏的补齐 ⇒ "重试"就是那个按钮；
	 *   · 同卷硬链接（默认归档目录在 `media-store/archive` 内）⇒ 不占额外空间；异盘退复制并计入 `copied`。
	 * @returns {string} 归档后的绝对路径；没归档/失败 ⇒ 空串
	 */
	function archiveOne(asset) {
		if (!archiveRoot || !asset || !asset.filePath) { return ''; }
		if (!existsSync(asset.filePath)) { return ''; }
		try {
			const target = exportTargetOf(asset, archiveRoot, archiveMode);
			if (existsSync(target)) { return target; }
			mkdirSync(dirname(target), { recursive: true });
			let linked = false;
			try { linkSync(asset.filePath, target); linked = true; } catch { linked = false; }
			if (!linked) { copyFileSync(asset.filePath, target); archiveStats.copied++; }
			archiveStats.ok++;
			return target;
		} catch (e) {
			archiveStats.failed++;
			archiveStats.lastError = String(e?.message ?? e);
			return '';
		}
	}

	/** 按筛选条件/指定 id 收集要导出的资产（`list` 一页最多 500，这里自己翻页）。 */
	function collectForExport(filter, onlyIds, limit) {
		if (onlyIds) {
			return [...onlyIds].map(id => get(id)).filter(asset => asset && !asset.isDeleted);
		}
		const out = [];
		let offset = 0;
		while (out.length < limit) {
			let page = [];
			try {
				page = list({ ...filter, limit: Math.min(500, limit - out.length), offset }).items;
			} catch { break; }
			if (!page.length) { break; }
			out.push(...page);
			offset += page.length;
		}
		return out;
	}

	/**
	 * **导出到文件夹**（2026-10-27，用户问「生成物能否存成指定文件夹里的独立文件」）。
	 *
	 * 与「链接」相反：链接是"库里只记路径、看的是用户那份"；导出是"把库里的字节再落一份可读文件"。
	 * 两者互补，主库仍然是内容寻址的 `objects/`（保证去重、不裂图）——
	 * 导出目录只是**给人 / 给外部工具（PS、网盘、Finder）用的副本**，删了不影响库。
	 *
	 * 落盘结构：`<dir>/<provider 或 kind 或 月份>/<yyyy-MM>/<可读名>-<sha8前6>.<ext>`（`layout=flat` 时不分层）。
	 * 同卷优先**硬链接**（零额外空间），跨卷/不支持就退回复制；已存在则跳过（`overwrite` 才覆盖）。
	 *
	 * @param {{dir?: string, layout?: 'provider'|'kind'|'date'|'flat', ids?: string[], filter?: object,
	 *   dryRun?: boolean, overwrite?: boolean, hardlink?: boolean, limit?: number}} [options]
	 */
	function exportAssets(options = {}) {
		const dir = String(options.dir ?? '').trim();
		if (!dir) { return { ok: false, error: '要提供目标文件夹' }; }
		const layout = ['provider', 'kind', 'date', 'flat'].includes(String(options.layout))
			? String(options.layout) : 'provider';
		const dryRun = options.dryRun === true;
		const overwrite = options.overwrite === true;
		const hardlink = options.hardlink !== false;
		const limit = Math.min(Math.max(Number(options.limit) || 2000, 1), 5000);
		const onlyIds = Array.isArray(options.ids) && options.ids.length ? new Set(options.ids.map(String)) : null;
		const out = {
			ok: true, dryRun, dir, layout,
			exported: 0, linked: 0, copied: 0, bytes: 0,
			skipped: { noFile: 0, missing: 0, exists: 0, truncated: 0 },
			failed: [],
			items: [],
		};
		const rows = collectForExport(options.filter, onlyIds, limit);
		for (const asset of rows) {
			if (out.exported + Object.values(out.skipped).reduce((a, b) => a + b, 0) >= limit) { out.skipped.truncated++; continue; }
			// 仅引用资产（只有外链、没有本地文件）没有字节可导
			if (!asset.filePath) { out.skipped.noFile++; continue; }
			if (!existsSync(asset.filePath)) { out.skipped.missing++; continue; }
			const target = exportTargetOf(asset, dir, layout);
			const targetDir = dirname(target);
			if (existsSync(target) && !overwrite) { out.skipped.exists++; continue; }
			if (out.items.length < 20) { out.items.push({ id: asset.id, name: asset.fileName ?? '', to: target }); }
			if (dryRun) { out.exported++; continue; }
			try {
				mkdirSync(targetDir, { recursive: true });
				if (existsSync(target)) { rmSync(target, { force: true }); }
				let linked = false;
				if (hardlink) {
					try { linkSync(asset.filePath, target); linked = true; } catch { linked = false; }
				}
				if (!linked) { copyFileSync(asset.filePath, target); }
				out.exported++;
				if (linked) { out.linked++; } else { out.copied++; out.bytes += Number(asset.bytes) || 0; }
			} catch (e) {
				out.failed.push({ id: asset.id, name: asset.fileName ?? '', error: String(e?.message ?? e) });
			}
		}
		return out;
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
		// ★ 2026-10-27（链接文件夹）：**只删我们自己对象库里的文件**。
		//   链接资产（`file_path` 指向用户的目录）删的只能是"行"，绝不能碰用户的文件 ——
		//   那是"引用"，不是"副本"。`linkedFile: true` 让调用方能如实告诉用户"文件没动"。
		const linkedFile = !!asset.filePath && !isManagedPath(asset.filePath);
		if (!stillUsed && asset.sha8) {
			if (asset.filePath && !linkedFile) {
				try {
					const size = statSync(asset.filePath).size;
					rmSync(asset.filePath, { force: true });
					removedFile = true;
					freedBytes = size;
				} catch { /* 文件已经不在了 —— 行照删（正是要清理的状态） */ }
			}
			try { rmSync(thumbPathOf(asset.sha8), { force: true }); removedThumb = true; } catch { /* 同上 */ }
		}
		return { ok: true, id: String(id), removedFile, removedThumb, freedBytes, linkedFile };
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

	/**
	 * **变更版本号**（2026-10-27：让"助手改了库 → 打开着的页面自己刷新"）。
	 *
	 * 用 SQLite 的 `total_changes()`（本连接累计改动行数，含我们自己的写）——
	 * 比自己到处埋 `rev++` 可靠：**工具调用**（agent 走 `autoTag` 等）与 HTTP 写入走同一个连接，
	 * 都会让它变；页面只需要比较"变了没"。
	 * ⚠ 它随连接重置（Host 重启 ⇒ 回到 0）：页面同时也重新加载了，不存在误判。
	 */
	function revision() {
		try {
			return Number(db.prepare('SELECT total_changes() AS n').get()?.n ?? 0);
		} catch {
			return 0;
		}
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
		// 2026-10-27：链接外部文件夹（不复制字节）+ 导出可读副本 + 判定"这份文件是不是我们自己的"
		linkFolder, exportAssets, isManagedPath,
		// 2026-10-26：破坏性清理（对齐 IDE 侧那套 purgeDeleted / cleanOrphaned / usage）
		purge, purgeDeleted, cleanOrphaned, usage,
		stats, facets, revision, close,
		/** 自动归档的账目（目录 / 成功 / 复制 / 失败 / 最后一条错误）—— 暴露给 `GET api/usage`。 */
		archiveStats: () => ({ ...archiveStats }),
	};
}
