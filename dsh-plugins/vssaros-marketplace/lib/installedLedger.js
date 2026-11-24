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
export async function readInstalled(dataRoot, { strict = false } = {}) {
	try {
		const raw = await readFile(installedFilePath(dataRoot), { encoding: 'utf8' });
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) { if (strict) { throw new Error('安装台账必须是数组'); } return []; }
		if (strict && parsed.some(e => !e || typeof e.kind !== 'string' || typeof e.storeId !== 'string')) { throw new Error('安装台账含无效条目'); }
		return parsed.filter(e => e && typeof e.kind === 'string' && typeof e.storeId === 'string');
	} catch (error) {
		if (strict && error.code !== 'ENOENT') { throw new Error(`安装台账不可用，保留原文件：${error.message}`); }
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
		const entries = await readInstalled(dataRoot, { strict: true });
		const prev = entries.find(e => e.kind === entry.kind && e.storeId === entry.storeId);
		const next = entries.filter(e => !(e.kind === entry.kind && e.storeId === entry.storeId));
		// ★ 2026-11-24：IDE 侧 marketplaceService 双写**同一份**台账时只映射 6 个字段，
		//   会把 packageName / format 丢掉（它们是插件卸载、envelope 识别的真判据）。
		//   dsh 侧再 upsert 时不能再跟着丢 ⇒ 本次没带、旧条目有就继承；显式新值优先。
		//   owner 刻意不继承：组合包组件重装成独立资源时，继承旧 owner 会导致级联卸载误删。
		const packageName = entry.packageName || prev?.packageName || '';
		const format = entry.format || prev?.format || '';
		next.push({
			kind: entry.kind,
			storeId: entry.storeId,
			version: entry.version,
			...(packageName ? { packageName: String(packageName) } : {}),
			...(format ? { format: String(format) } : {}),
			...(entry.owner ? { owner: String(entry.owner) } : {}),
			installedAt: new Date().toISOString(),
			source: entry.source ?? prev?.source ?? 'installed',
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
		const entries = await readInstalled(dataRoot, { strict: true });
		const next = entries.filter(e => !(e.kind === kind && e.storeId === storeId));
		if (next.length === entries.length) { return entries; }
		await writeAtomic(installedFilePath(dataRoot), next);
		return next;
	});
}
