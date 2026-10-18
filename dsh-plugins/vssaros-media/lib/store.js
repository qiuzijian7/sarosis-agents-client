// @vssaros/dsh-media — store（主机侧 I/O）：**只读**直连 VsSaros 主进程的 media.db。
//
// 数据根口径与前几个模块一致：`config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`；
// 媒体根：`config.mediaRoot` → `media-store-config.json` 的 `rootDir` → `<数据根>/media`。
//
// ── 为什么能直连（而不是像 kb / codebase 那样读一份 JSON 快照）───────────────
// VsSaros 的 `node/mediaStore.ts` 打开库时执行了 `PRAGMA journal_mode = WAL` +
// `PRAGMA busy_timeout = 5000`，其注释原文是「每个窗口是一个独立 renderer ⇒ 工程里永远存在
// **多个到 media.db 的连接**」—— 也就是说「多进程 / 多连接同时访问」**已经是这个库的既有前提**，
// 这里再加一个 Host 进程的只读连接，与"再开一个窗口"在机制上没有区别。而且 WAL 是**库级持久
// 属性** ⇒ 新连接自动继承，本模块不需要（也不应该）再设一次。
//
// ── 为什么只读 ──────────────────────────────────────────────────────────────
// 建表（`CREATE TABLE media_asset`）与迁移（逐列 `ALTER TABLE`）的真源在 VsSaros 侧。本模块若也
// 建表 / 改表，就变成**两个写者**：schema 一漂移，主进程那条 `_migrate()` 的列探测就会失配。
// ⇒ 一律 `readOnly: true` 打开，**不写一个字节**。（放开写能力的代价见文件末尾的说明。）
//
// ── 一条必须处理的路径差异（与 kb / codebase **不同**）──────────────────────
// kb / codebase 的数据直接住在 `<数据根>/...`；媒体根多一层**用户可改的覆盖**：
// `{userDataPath}/media-store-config.json` 的 `rootDir`（`electron-main/mediaStoreChannel.ts`
// 的 `_persistRootDir` / `_loadPersistedRootDir`）。只按默认值拼，会在"用户改过目录"的机器上
// 打开一个**空库**（甚至建出一个新的空库 ✗）⇒ 必须先把这一层读进来。

import { existsSync, readFileSync } from 'node:fs';
import { foundation } from './foundationRef.js';
import { homedir } from 'node:os';

import { join } from 'node:path';


export function dataRootOf(config) {
	// 委托到 @vssaros/dsh-foundation（重构 1.3：真源只有一份）；调用签名不变。
	return foundation().dataRootOf(config);
}

/** 媒体根：`config.mediaRoot` → `media-store-config.json` 的 `rootDir` → `<数据根>/media`。 */
export function mediaRootOf(config) {
	const configured = typeof config?.mediaRoot === 'string' ? config.mediaRoot.trim() : '';
	if (configured) {
		return configured;
	}
	const dataRoot = dataRootOf(config);
	try {
		// 覆盖层与 VsSaros 侧**同路径**：`{userDataPath}/media-store-config.json`，
		// 而 userDataPath = `homedir()/<dataFolderName>` = 这里的数据根（prod `.vssaros` / dev `.vssaros-dev`）。
		const raw = JSON.parse(readFileSync(join(dataRoot, 'media-store-config.json'), 'utf8'));
		const fromConfig = typeof raw?.rootDir === 'string' ? raw.rootDir.trim() : '';
		if (fromConfig) {
			return fromConfig;
		}
	} catch { /* 文件不存在 / 读不动 / 不是 JSON ⇒ 用默认位置（不猜、不建） */ }
	return join(dataRoot, 'media');
}

export function mediaDbPathOf(config) {
	return join(mediaRootOf(config), 'media.db');
}

/**
 * 打开只读连接。
 *
 * ⚠ `node:sqlite` 是 Node **内置**模块（22.5 引入）⇒ 这条路**零依赖**，不必装 better-sqlite3
 * （那需要与本机 Node ABI 匹配的原生二进制，插件是独立安装的包，很难保证）。dsh 要求的
 * Node 22.19+/24+ 都在这个范围内。
 *
 * ⚠ 但它仍是 `ExperimentalWarning` 级 API，**且早期 22.x 可能需要 `--experimental-sqlite`** ⇒
 * 这里用**动态 import 做能力探测**，失败时把原因如实抛给页面：不用静态 import 是因为那会在
 * **模块加载期**就挂掉整个插件（连工具一起消失 ✗）。
 */
async function openDb(config) {
	const dbPath = mediaDbPathOf(config);
	if (!existsSync(dbPath)) {
		throw new Error(`媒体库尚未建立：找不到 ${dbPath}（VsSaros 侧还没写过媒体？）`);
	}
	let sqlite;
	try {
		sqlite = await import('node:sqlite');
	} catch (e) {
		throw new Error(`本机 Node 没有可用的 node:sqlite（需要 22.19+/24+）：${String(e?.message ?? e)}`);
	}
	// `readOnly: true`：连**打开**都不允许写（比"代码里只写 SELECT"强一层）。
	// 库已是 WAL（主进程开的）⇒ 只读连接照常可读。
	const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
	return { db, close: () => { try { db.close(); } catch { /* 关不掉不影响结果 */ } } };
}

/**
 * 列出资产（默认不含软删）。
 *
 * ⚠ 列名逐条对齐 VsSaros 的 `MediaRow` / `CREATE TABLE media_asset`
 * （`node/mediaStore.ts` 的 L40-81）。这是一条**跨进程 schema 契约**：改列名必须两边同时改。
 * （它不在任何守卫的覆盖范围内 —— 是选"直连"换来的长期成本，已如实记在插件说明里。）
 */
export async function listAssets(config, { kind, limit = 30, includeDeleted = false } = {}) {
	const { db, close } = await openDb(config);
	try {
		const where = [];
		const params = [];
		if (!includeDeleted) { where.push('is_deleted = 0'); }
		if (kind) {
			where.push('kind = ?');
			params.push(String(kind));
		}
		const capped = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 30));
		const sql = 'SELECT id, kind, ref, file_name, size_bytes, created_at, favorite, board, tags, is_deleted'
			+ ' FROM media_asset'
			+ (where.length ? ` WHERE ${where.join(' AND ')}` : '')
			+ ' ORDER BY created_at DESC LIMIT ?';
		const rows = db.prepare(sql).all(...params, capped);
		return rows.map(row => ({
			id: String(row.id),
			kind: String(row.kind),
			ref: String(row.ref),
			fileName: row.file_name == null ? undefined : String(row.file_name),
			sizeBytes: row.size_bytes == null ? undefined : Number(row.size_bytes),
			createdAt: Number(row.created_at),
			favorite: Number(row.favorite) === 1,
			board: row.board == null ? undefined : String(row.board),
			tags: parseTags(row.tags),
			deleted: Number(row.is_deleted) === 1,
		}));
	} finally {
		close();
	}
}

/** 汇总统计（资产数 / 回收站数 / 占用字节 / 分类计数）。 */
export async function statsOf(config) {
	const { db, close } = await openDb(config);
	try {
		const one = (sql) => Number(db.prepare(sql).get()?.n ?? 0);
		const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM media_asset WHERE is_deleted = 0 GROUP BY kind').all();
		const byKind = {};
		for (const row of rows) {
			byKind[String(row.kind)] = Number(row.n);
		}
		return {
			assetCount: one('SELECT COUNT(*) AS n FROM media_asset WHERE is_deleted = 0'),
			deletedCount: one('SELECT COUNT(*) AS n FROM media_asset WHERE is_deleted = 1'),
			totalBytes: one('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM media_asset WHERE is_deleted = 0'),
			byKind,
		};
	} finally {
		close();
	}
}

/** `tags` 列是 JSON 数组字符串（VsSaros 侧 `setTags` 写入）；坏内容按空数组处理。 */
function parseTags(raw) {
	if (typeof raw !== 'string' || !raw.trim()) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.map(t => String(t)).filter(Boolean) : [];
	} catch {
		return [];
	}
}

// ── 关于「写」────────────────────────────────────────────────────────────────
// 本模块技术上**可以**写同一个库（同一个文件、同样的连接方式），但要放开必须先定三条纪律，
// 否则两个写者会互相踩：
//   ① WAL + `busy_timeout` 已经就位（主进程设的，库级持久）✓ 但写事务必须**短**；
//   ② **不建表、不改表** —— schema 真源只有一个（VsSaros 侧）；
//   ③ 冲突语义要明说：两侧同时改同一行时**后写覆盖先写**（无冲突检测）。对"标星 / 打标签 /
//      改分组"这类低频手动操作可接受；换成"批量导入"就必须改走 VsSaros 侧的 IPC。
