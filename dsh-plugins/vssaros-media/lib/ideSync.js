// @vssaros/dsh-media — ideSync：把 **IDE 侧 media.db 里新出现的资产**收编进 dsh 侧真源（2026-10-24）。
//
// ── 为什么需要它（P4 的取舍）────────────────────────────────────────────────
//   用户拍板 A：「IDE 侧媒体库下线，dsh 成为唯一真源」。但 **IDE → dsh 没有现成的写通道**：
//   IDE 侧到 Host 只有主进程的**命名管道 JSON-RPC**（`dshBridgeClient.call`），而 Host 的 HTTP
//   需要 `authUrl` token（只在主进程，renderer 拿不到）⇒ 要"实时转发 ComfyUI 产出"，必须动
//   IDE 的 TS（加 RPC method + 编译 + reload 窗口）。
//   ⇒ 本轮改成 **dsh 侧增量收编**：IDE 那条 `media.import` 原样保留（当作"暂存区"），
//     dsh 侧按需把"origin_id 还没入库"的资产拉过来。IDE **零改动**，且与一次性迁移同一套幂等口径
//     （`origin_id` 唯一索引 ⇒ 重复收编是 no-op）。
//   ⚠ 代价（如实说）：不是实时 —— 收编发生在"页面打开 / 显式调 `/x/media/api/sync`"时。
//     等 IDE 侧下线（P4 第二段）时，这条就会成为唯一入口，必要时再加定时器。
//
// ── 与 `store.js` 的分工 ────────────────────────────────────────────────────
//   `store.js`：**只读镜像**（页面并存期对账 / 老工具），只跑 list/stats 那种只读查询。
//   本模块：**写路径**（只读打开 IDE db → 读字节 → 写 dsh 库），一次一条，边收边记。
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaDbPathOf } from './store.js';

const require_ = createRequire(import.meta.url);

/** SQLite primary result code：`errcode & 0xff === 10` 即 `SQLITE_IOERR`（与 store.js 同口径）。 */
const SQLITE_IOERR = 10;
function isIoError(error) {
	const code = Number(error?.errcode);
	if (Number.isFinite(code) && (code & 0xff) === SQLITE_IOERR) { return true; }
	return /disk I\/O error|SQLITE_IOERR/i.test(String(error?.message ?? error));
}

/**
 * 只读打开 IDE 的 media.db。直连失败（主进程正持有该文件对象 ⇒ `disk I/O error`）⇒ 退私有快照。
 * @returns {{db: object, via: 'direct'|'snapshot', cleanup: () => void}}
 */
function openIdeDb(dbPath) {
	const { DatabaseSync } = require_('node:sqlite');
	const tryOpen = p => {
		const db = new DatabaseSync(p, { readOnly: true });
		// 惰性打开 ⇒ 必须真读一页才算探活（与 store.js 的教训同）
		db.prepare('SELECT * FROM media_asset LIMIT 1').all();
		return db;
	};
	try {
		return { db: tryOpen(dbPath), via: 'direct', cleanup: () => { } };
	} catch (e) {
		if (!isIoError(e)) { throw e; }
		const dir = mkdtempSync(join(tmpdir(), 'vssaros-media-idesync-'));
		copyFileSync(dbPath, join(dir, 'media.db'));
		const wal = `${dbPath}-wal`;
		// ⚠ 非空的 -wal 必须一起拷：不拷就会静默丢掉"最近提交"的那批资产
		if (existsSync(wal) && statSync(wal).size > 0) { copyFileSync(wal, join(dir, 'media.db-wal')); }
		return { db: tryOpen(join(dir, 'media.db')), via: 'snapshot', cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败无所谓 */ } } };
	}
}

/**
 * 收编 IDE 侧**尚未入 dsh 库**的资产。
 *
 * @param {object} input
 * @param {object} input.config 插件配置（用它算 IDE 的 media.db 路径）
 * @param {object} input.store  dsh 侧真源（ownStore）
 * @returns {Promise<{ok: boolean, error?: string, via?: string, scanned: number, imported: number,
 *   alreadyThere: number, skippedNoFile: number, skippedMissing: number, skippedEmpty: number}>}
 */
export async function syncFromIdeDb({ config, store }) {
	const dbPath = mediaDbPathOf(config);
	const result = {
		ok: true, via: 'none', scanned: 0, imported: 0, alreadyThere: 0,
		// ★ 2026-10-24：只有 `ref` 的那些（ComfyUI `/view?…`，文件没落盘）收成**仅引用资产**
		importedAsRef: 0,
		skippedNoFile: 0, skippedMissing: 0, skippedEmpty: 0,
	};
	if (!existsSync(dbPath)) {
		// IDE 侧还没写过媒体（新机器）⇒ 不是错误，如实说"没东西可收编"
		return { ...result, error: undefined, via: 'missing' };
	}
	let opened;
	try {
		opened = openIdeDb(dbPath);
	} catch (e) {
		return { ...result, ok: false, error: String(e?.message ?? e) };
	}
	result.via = opened.via;
	try {
		const rows = opened.db.prepare(`SELECT id, provider, kind, ref, file_name, file_path, mime, meta_json,
			created_at, size_bytes, is_deleted, board, favorite, tags FROM media_asset ORDER BY created_at ASC`).all();
		result.scanned = rows.length;
		for (const row of rows) {
			if (store.getByOrigin(row.id)) { result.alreadyThere += 1; continue; }
			if (!row.file_path) {
				// ★ 2026-10-24：**只有 ref、没有字节**（IDE 侧那 103 条多是 ComfyUI 的
				//   `/view?filename=…`，文件从来没落盘）⇒ 收成**仅引用资产**（有条目、预览走那个 URL），
				//   而不是丢掉。真正什么都没有（ref 也空）才算 skippedNoFile。
				if (!row.ref) { result.skippedNoFile += 1; continue; }
				let tags = [];
				try { tags = row.tags ? JSON.parse(row.tags) : []; } catch { tags = []; }
				const refAsset = store.importAsset({
					ref: String(row.ref),
					kind: String(row.kind || 'image'),
					mime: row.mime || undefined,
					ext: String(row.file_name || row.ref).split('.').pop(),
					provider: String(row.provider || 'local'),
					source: String(row.provider) === 'comfyui' ? 'comfyui' : 'local',
					originId: row.id,
					createdAt: row.created_at,
					fileName: row.file_name || undefined,
					board: row.board || undefined,
					tags,
					metaJson: row.meta_json || JSON.stringify({ migratedFrom: 'ide', refOnly: true }),
				});
				if (!refAsset) { result.skippedNoFile += 1; continue; }
				if (row.favorite) { store.setFavorite(refAsset.id, true); }
				if (row.is_deleted) { store.softDelete(refAsset.id); }
				result.importedAsRef += 1;
				continue;
			}
			if (!existsSync(row.file_path)) {
				// 有 file_path 但文件没了：若还有 ref，也按"仅引用"收（宁可留条目）
				if (!row.ref) { result.skippedMissing += 1; continue; }
				let tags = [];
				try { tags = row.tags ? JSON.parse(row.tags) : []; } catch { tags = []; }
				const refAsset = store.importAsset({
					ref: String(row.ref),
					kind: String(row.kind || 'image'),
					mime: row.mime || undefined,
					ext: String(row.file_name || row.ref).split('.').pop(),
					provider: String(row.provider || 'local'),
					source: String(row.provider) === 'comfyui' ? 'comfyui' : 'local',
					originId: row.id,
					createdAt: row.created_at,
					fileName: row.file_name || undefined,
					board: row.board || undefined,
					tags,
					metaJson: row.meta_json || JSON.stringify({ migratedFrom: 'ide', refOnly: true, missingFile: row.file_path }),
				});
				if (!refAsset) { result.skippedMissing += 1; continue; }
				if (row.favorite) { store.setFavorite(refAsset.id, true); }
				if (row.is_deleted) { store.softDelete(refAsset.id); }
				result.importedAsRef += 1;
				continue;
			}
			let bytes;
			try { bytes = readFileSync(row.file_path); } catch { result.skippedMissing += 1; continue; }
			if (bytes.length === 0) { result.skippedEmpty += 1; continue; }
			let tags = [];
			try { tags = row.tags ? JSON.parse(row.tags) : []; } catch { tags = []; }
			const asset = store.importAsset({
				bytes,
				kind: String(row.kind || 'image'),
				mime: row.mime || undefined,
				ext: String(row.file_name || row.file_path).split('.').pop(),
				provider: String(row.provider || 'local'),
				source: String(row.provider) === 'comfyui' ? 'comfyui' : 'local',
				originId: row.id,
				createdAt: row.created_at,
				fileName: row.file_name || undefined,
				board: row.board || undefined,
				tags,
				metaJson: row.meta_json || JSON.stringify({ migratedFrom: 'ide', ref: row.ref ?? null }),
			});
			if (!asset) { result.skippedEmpty += 1; continue; }
			if (row.favorite) { store.setFavorite(asset.id, true); }
			if (row.is_deleted) { store.softDelete(asset.id); }
			result.imported += 1;
		}
		return result;
	} catch (e) {
		return { ...result, ok: false, error: String(e?.message ?? e) };
	} finally {
		try { opened.db.close(); } catch { /* 已关 */ }
		opened.cleanup();
	}
}

