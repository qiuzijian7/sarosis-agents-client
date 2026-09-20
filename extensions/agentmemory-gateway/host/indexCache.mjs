/*---------------------------------------------------------------------------------------------
 *  索引制品缓存（P0-2，2026-09-19）
 *
 *  背景：网关启动时**全量重建** BM25 + 向量索引，实测 10235 doc / 178.9MB db 耗时 4.2s
 *  （10235 条各做一次 trigram embedding + 倒排构建），且随库**线性增长**；接入真语义
 *  embedding（P0-1）后重建会变成**分钟级** ⇒ 必须有制品缓存。
 *
 *  制品（`<dataDir>/index/`）：
 *    bm25-cache.json.gz    { version, fingerprint, builtAt, docs, agents: { <agentId>: payload } }
 *    vector-cache.json.gz  { version, fingerprint, builtAt, docs, mode, agents: { <agentId>: [{id,vector}] } }
 *  （按 agent 分片：网关的索引本来就是 per-agent 实例，见 host.mjs `indexByAgent`）
 *
 *  新鲜度判据 = 启动时实测的 KV 指纹 `{ rows, maxUpdatedAt, sumLen }` 与制品内记录**完全一致**：
 *    · rows          → 覆盖删除（少一行就变）
 *    · maxUpdatedAt  → 覆盖写入 / 更新（`kv_store.updated_at`）
 *    · sumLen        → 覆盖「同一毫秒内改写同长度值」这种 rows 与 maxUpdatedAt 都不变的场景
 *  版本不符 / 指纹不符 / **文档数为 0** ⇒ 回退全量重建。
 *  ★ 最后一条是纪律：**「加载成功」≠「有数据」**（CodebaseGraph 曾把 8.2MB 制品写成 99 字节，
 *    而那个空制品**仍能成功解压成一张空图**，调用方便永远不再重建）。
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

export const INDEX_CACHE_VERSION = 1;
export const BM25_CACHE_FILE = 'bm25-cache.json.gz';
export const VECTOR_CACHE_FILE = 'vector-cache.json.gz';

/** KV 指纹比较。js-kv 后端没有 updated_at ⇒ 传 0；两边的 `?? 0` 保证同一制品可跨后端比较失败（等价于重建）。 */
export function fingerprintEqual(a, b) {
	if (!a || !b) { return false; }
	return Number(a.rows ?? -1) === Number(b.rows ?? -2)
		&& Number(a.maxUpdatedAt ?? 0) === Number(b.maxUpdatedAt ?? 0)
		&& Number(a.sumLen ?? -1) === Number(b.sumLen ?? -2);
}

/**
 * 制品可用性判据（纯函数）。
 * @param {object|null} meta 制品元数据
 * @param {object} currentFingerprint 本次启动实测的 KV 指纹
 * @param {number} [version]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateCache(meta, currentFingerprint, version = INDEX_CACHE_VERSION) {
	if (!meta || typeof meta !== 'object') {
		return { ok: false, reason: 'cache file missing or malformed' };
	}
	if (meta.version !== version) {
		return { ok: false, reason: `version mismatch (cache=${meta.version}, code=${version})` };
	}
	if (!meta.agents || typeof meta.agents !== 'object') {
		return { ok: false, reason: 'no agents section' };
	}
	if (!fingerprintEqual(meta.fingerprint, currentFingerprint)) {
		return {
			ok: false,
			reason: `KV changed since cache was built (cache=${JSON.stringify(meta.fingerprint)}, now=${JSON.stringify(currentFingerprint)})`,
		};
	}
	return { ok: true };
}

/**
 * 写制品。**原子替换**（temp + rename）——半写制品绝不能留在启动读取路径上。
 * `sync: true` 供 shutdown 使用（进程即将退出，允许阻塞主线程）。
 */
export async function writeCacheFile(file, obj, { sync = false } = {}) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// tmp 名必须唯一：并发落盘（如启动期 BM25+向量两次 save）会互相覆盖同一个 tmp
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const json = JSON.stringify(obj);
	if (sync) {
		fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(json, 'utf8')));
		fs.renameSync(tmp, file);
		return;
	}
	// 异步 gzip：制品可达数十 MB，gzipSync 会阻塞网关事件循环（→ renderer 5s 超时误判）
	const gz = await new Promise((resolve, reject) => {
		zlib.gzip(Buffer.from(json, 'utf8'), (err, buf) => (err ? reject(err) : resolve(buf)));
	});
	// 异步写文件 + 原子替换：writeFileSync/renameSync 会阻塞事件循环（数十 MB 时明显）
	await fs.promises.writeFile(tmp, gz);
	await fs.promises.rename(tmp, file);
}

/** 读制品；不存在返回 null，损坏抛出（调用方按「不可用 ⇒ 重建」处理）。 */
export function readCacheFile(file) {
	if (!fs.existsSync(file)) { return null; }
	return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

/**
 * 「已 dirty 后应等多久落盘」（纯函数，便于单测）。
 * 语义 = **节流而非防抖**：首个变更排定一次落盘，后续变更**不重置**计时器
 * （否则高频写入会让落盘永远不触发 —— 「只在 shutdown 保存 = 永不保存」的变体）。
 * 超过 maxDelayMs 的待发落盘直接立即执行。
 */
export function nextSaveDelayMs(dirtySinceMs, nowMs, { debounceMs = 30_000, maxDelayMs = 300_000 } = {}) {
	if (!dirtySinceMs) { return debounceMs; }
	const elapsed = nowMs - dirtySinceMs;
	if (elapsed >= maxDelayMs) { return 0; }
	return Math.min(debounceMs, maxDelayMs - elapsed);
}
