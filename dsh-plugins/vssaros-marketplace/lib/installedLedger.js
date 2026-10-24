// @vssaros/dsh-marketplace — 已安装台账（★ 2026-10-22 S1：dsh 侧自持）
//
// ★ 台账是**同一份文件**：`<数据根>/installed-packages.json`
//   （IDE 侧 `marketplaceService` 也读写它 ⇒ 两侧看到的"我装了什么"必须一致 ✓）。
//   形状（与 IDE 侧 `IInstalledEntry` 逐字段一致）：
//     `[{ kind, storeId, version, installedAt, source?: 'installed'|'published' }]`
//
// ★ 为什么 dsh 侧要自己读写：安装动作正在搬回 dsh 侧（S2）⇒ 台账必须由**执行安装的那一侧**写，
//   否则"装完了但台账没有" ⇒ 已安装页签与升级检查都看不到它 ✗。
//   两侧同时写同一份文件的风险由**原子写 + 读-改-写串行**兜住（本进程内串行；跨进程窗口很小，
//   且台账是"最终一致"就够用的数据 —— 不引跨进程锁，代价与收益不成比例 ✓）。
//
// ★ 解析失败的策略：**不覆盖**坏文件（宁可这次记不上，也不要把用户已有的台账清空 ✗）。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 台账文件名（与 IDE 侧 `SarosPath.installedPackages` 同值）。 */
export const INSTALLED_FILE = 'installed-packages.json';

/** 台账绝对路径：`<数据根>/installed-packages.json`。 */
export function installedFilePath(dataRoot) {
	return join(dataRoot, INSTALLED_FILE);
}

/** 本进程内的写串行（避免自己跟自己抢 ⇒ 读-改-写丢更新 ✓）。 */
let writeQueue = Promise.resolve();
function serialized(task) {
	const next = writeQueue.then(task, task);
	writeQueue = next.catch(() => undefined);
	return next;
}

/** 读台账；文件不存在/坏 ⇒ 空数组（**不改文件**）。 */
export async function readInstalled(dataRoot) {
	try {
		const raw = await readFile(installedFilePath(dataRoot), { encoding: 'utf8' });
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) { return []; }
		return parsed.filter(e => e && typeof e.kind === 'string' && typeof e.storeId === 'string');
	} catch {
		return [];
	}
}

/** 原子写（tmp + rename）：写一半崩掉不会留下半个 JSON ✓。 */
async function writeAtomic(file, entries) {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, JSON.stringify(entries, null, 2), { encoding: 'utf8' });
	await rename(tmp, file);
}

/**
 * 记一条「已安装」（同 kind+storeId 覆盖）。
 *
 * @param {string} dataRoot
 * @param {{ kind: string, storeId: string, version: string, source?: 'installed'|'published' }} entry
 */
export async function upsertInstalled(dataRoot, entry) {
	return serialized(async () => {
		const file = installedFilePath(dataRoot);
		const entries = await readInstalled(dataRoot);
		const next = entries.filter(e => !(e.kind === entry.kind && e.storeId === entry.storeId));
		next.push({
			kind: entry.kind,
			storeId: entry.storeId,
			version: entry.version,
			// ★ 2026-10-24：插件（npm 包）的卸载只能按**包名**；slug 是商城自己的标识
			//   （zuoyunlai-dsh-pet-plugin），和包名（dsh-pet-plugin）不是一回事 ⇒ 装的时候记下来。
			...(entry.packageName ? { packageName: String(entry.packageName) } : {}),
			installedAt: new Date().toISOString(),
			source: entry.source ?? 'installed',
		});
		await writeAtomic(file, next);
		return next;
	});
}

/**
 * 删一条「已安装」（只动台账，不删目录）。
 *
 * @param {string} dataRoot
 * @param {string} kind
 * @param {string} storeId
 */
export async function removeInstalled(dataRoot, kind, storeId) {
	return serialized(async () => {
		const entries = await readInstalled(dataRoot);
		const next = entries.filter(e => !(e.kind === kind && e.storeId === storeId));
		if (next.length === entries.length) { return entries; }
		await writeAtomic(installedFilePath(dataRoot), next);
		return next;
	});
}
