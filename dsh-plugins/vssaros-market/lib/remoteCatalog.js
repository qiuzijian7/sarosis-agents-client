// @vssaros/dsh-market — **远程目录读取器**（有 I/O ⇒ 与纯逻辑分开）。
//
// 语义照 dsh-desktop 的工作台目录读取器（`packages/dsh-desktop-workbenches/catalog.mjs`）复刻：
//   · 内存缓存 15 分钟（`CACHE_MAX_AGE_MS`）；
//   · 磁盘快照（临时文件 → rename ⇒ 不会读到写了一半的快照）；
//   · 远程读失败 ⇒ 回落到「内存里上一次成功的 / 磁盘上的快照」，并标 `stale`（界面据此提示）；
//   · 体积上限 2MB（`content-length` 与实际字节都查）与 30 秒超时（`AbortController`）；
//   · `cachedOnly` 只读缓存不触网（界面首屏用：先出上次读到的，再后台刷新）。
//
// ⚠ **只读远程目录**：这个读取器不安装任何东西（安装走 Host 的 pluginManager ⇒ 见 `lib/index.js`）。
// ⚠ 快照写在**数据根**下（`<数据根>/market/catalog-snapshot.json`）—— 随包兜底目录不受影响。
// ⚠ 快照里存的是**原始已发布目录**（不是归一化后的形状）—— 否则再读快照时过不了协议校验（✗）。

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { DEFAULT_CATALOG_URL, normalizeCatalog } from './catalog.js';

/** 目录最大字节数（2MB）—— 超过就当「这不是一份目录」。 */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
/** 一次远程读取的超时（30s）。 */
export const FETCH_TIMEOUT_MS = 30_000;
/** 内存缓存的最长寿命（15 分钟）。 */
export const CACHE_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * 造一个目录读取器。
 *
 * @param {object} options
 * @param {typeof fetch} [options.fetch] 注入的 fetch（测试用；默认全局 fetch）。
 * @param {string} options.url 目录地址（http/https）。
 * @param {string} [options.cachePath] 磁盘快照路径（不给 ⇒ 不落盘）。
 * @param {() => number} [options.now] 时钟（测试用）。
 * @returns {() => Promise<{catalog: object|null, stale: boolean, error: string|null, fetchedAt: number}>}
 */
export function createRemoteReader({
	fetch: fetchCatalog = globalThis.fetch,
	url = DEFAULT_CATALOG_URL,
	cachePath,
	now = Date.now,
} = {}) {
	let cached = null;   // 内存里最近一次**成功**读到的目录
	let fetchedAt = 0;   // 那次成功的时间戳
	let pending = null;  // 在途请求（并发读共享一次网络往返）

	const readSnapshot = async () => {
		if (!cachePath) { return undefined; }
		try {
			const raw = await readFile(cachePath, 'utf8');
			if (raw.length > MAX_CATALOG_BYTES * 2) { return undefined; } // 快照异常大 ⇒ 不信
			const snapshot = JSON.parse(raw);
			if (!snapshot || typeof snapshot !== 'object') { return undefined; }
			if (snapshot.url !== url) { return undefined; }             // 换了地址 ⇒ 旧快照作废
			if (!Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt < 0) { return undefined; }
			return normalizeCatalog(snapshot.catalog);
		} catch {
			return undefined;  // 快照没有 / 坏了 ⇒ 当没有（不报错）
		}
	};

	const writeSnapshot = async (rawCatalog) => {
		if (!cachePath) { return; }
		const temporary = `${cachePath}.${randomUUID()}.tmp`;
		try {
			await mkdir(dirname(cachePath), { recursive: true });
			// 存**原始已发布目录**（不是归一化后的形状）—— 否则再读快照时过不了协议校验 ✗
			await writeFile(temporary, JSON.stringify({ schemaVersion: 1, url, fetchedAt, catalog: rawCatalog }), { flag: 'wx', mode: 0o600 });
			await rename(temporary, cachePath);   // 原子换名 ⇒ 不会读到半份快照 ✓
		} catch {
			/* 快照写不进去不影响主路径（只是下次没有回落） */
		} finally {
			await unlink(temporary).catch(() => { /* 本来就没有 */ });
		}
	};

	const fetchFresh = async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error('目录请求超时')), FETCH_TIMEOUT_MS);
		try {
			const response = await fetchCatalog(url, { headers: { accept: 'application/json' }, signal: controller.signal });
			if (!response || !response.ok) {
				throw new Error(`目录返回 HTTP ${response ? response.status : '(无响应)'}`);
			}
			const length = Number(response.headers?.get?.('content-length'));
			if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) {
				throw new Error('目录体积超过上限（2MB）');
			}
			const text = await response.text();
			if (text.length > MAX_CATALOG_BYTES) { throw new Error('目录体积超过上限（2MB）'); }
			let parsed;
			try { parsed = JSON.parse(text); } catch (e) { throw new Error(`目录不是合法 JSON：${e?.message ?? e}`); }
			const catalog = normalizeCatalog(parsed);
			cached = parsed;   // 内存里存**原始**目录（快照与回落都按原始目录走校验 ✓）
			fetchedAt = now();
			await writeSnapshot(parsed);
			return { catalog, stale: false, error: null, fetchedAt };
		} finally {
			clearTimeout(timer);
		}
	};

	return async function readCatalog({ force = false, cachedOnly = false } = {}) {
		if (cachedOnly) {
			// 只读缓存：先用内存里上一次成功的，没有再读磁盘快照；**不触网**（首屏秒出 ✓）
			const snapshot = cached || (await readSnapshot());
			if (!snapshot) { return { catalog: null, stale: false, error: null, fetchedAt: 0 }; }
			return { catalog: snapshot, stale: true, error: null, fetchedAt };
		}
		if (!force && cached && now() - fetchedAt < CACHE_MAX_AGE_MS) {
			return { catalog: normalizeCatalog(cached), stale: false, error: null, fetchedAt };
		}
		if (!pending) {
			pending = fetchFresh().catch(async (error) => {
				// 回落：内存里上一次成功的（原始目录 ⇒ 这里再校验一次）⇒ 磁盘快照 ⇒ 都没有就抛
				const fallback = cached ? normalizeCatalog(cached) : (await readSnapshot());
				if (fallback) {
					return { catalog: fallback, stale: true, error: String(error?.message ?? error), fetchedAt };
				}
				throw error;
			}).finally(() => { pending = undefined; });
		}
		return pending;
	};
}
