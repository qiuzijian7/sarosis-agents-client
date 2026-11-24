// @vssaros/dsh-marketplace — 已安装台账（★ 2026-10-22 S1：dsh 侧自持）
//
// ★ 台账是**同一份文件**：`<数据根>/installed-packages.json`
//   （IDE 侧 `marketplaceService` 也读写它 ⇒ 两侧看到的"我装了什么"必须一致 ✓）。
//   形状（与 IDE 侧 `IInstalledEntry` 逐字段一致）：
//     `[{ kind, storeId, version, installedAt, source?: 'installed'|'published' }]`
//
// ★ 为什么 dsh 侧要自己读写：安装动作正在搬回 dsh 侧（S2）⇒ 台账必须由**执行安装的那一侧**写，
//   否则"装完了但台账没有" ⇒ 已安装页签与升级检查都看不到它 ✗。
//
// ★ 2026-11-24 跨进程锁（推翻此前「最终一致够用」的判断）：
//   dsh Host 与 IDE renderer 是**两个进程**，各自 read→改→write 同一份文件；
//   原子写只防半截 JSON，**不防丢更新**。典型：A 读到 N 条 → B 读 N 条写回 N+1 →
//   A 用自己的 N 条写回 N+1 ⇒ B 那条（可能带 owner/packageName）消失，级联卸载随之失灵。
//   ⇒ 两侧改争**同一把** `<file>.lock`（复用 foundation / fileWriteLock 的既有同协议实现），
//   语义对齐服务端 sync_jobs 的 claim / running / release：'wx' 独占抢占、5s 等待、
//   15s stale 且持有者进程已不在才破门、finally 释放。
//   ⚠ foundation 未绑定 / 老 Host 缺锁 API ⇒ **能力探测降级**为原「进程内串行 + 原子写」，
//   绝不因锁不可用而写失败（离线回归与探针进程都走这条）。
//
// ★ 解析失败的策略：**不覆盖**坏文件（宁可这次记不上，也不要把用户已有的台账清空 ✗）。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { foundation } from './foundationRef.js';

/** 台账文件名（与 IDE 侧 `SarosPath.installedPackages` 同值）。 */
export const INSTALLED_FILE = 'installed-packages.json';

/** 台账绝对路径：`<数据根>/installed-packages.json`。 */
export function installedFilePath(dataRoot) {
	return join(dataRoot, INSTALLED_FILE);
}

/** 本进程内的写串行（避免自己跟自己抢 ⇒ 同进程 10 并发不会耗尽 5s 锁等待 ✓）。 */
let writeQueue = Promise.resolve();
function serialized(task) {
	const next = writeQueue.then(task, task);
	writeQueue = next.catch(() => undefined);
	return next;
}

/** 跨进程锁能力探测：拿不到就降级（不抛），与 IDE 侧 writeFileAtomicSafe 同口径。 */
function lockService() {
	try {
		const svc = foundation();
		// 只借锁，不借写：跨进程互斥靠 acquireFileLock；原子写仍用本模块自己的 tmp+rename。
		// （foundation stub / 老 Host 里的 atomicWriteFile 可能是空实现，委托出去会丢整份台账 ✗）
		if (svc && ['lockFileFor', 'acquireFileLock'].every(key => typeof svc[key] === 'function')) {
			return svc;
		}
	} catch { /* 未绑定 foundation / 探针进程 ⇒ 降级 */ }
	return null;
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
		const svc = lockService();
		// ⚠ 锁文件本身也在 dataRoot 下 ⇒ 目录必须先建好，否则 open('wx') 会 ENOENT
		await mkdir(dirname(file), { recursive: true });
		// 锁 + 读 + 改 + 写必须在同一临界区：读放在锁外仍会丢更新 ✗
		const release = svc ? await svc.acquireFileLock(svc.lockFileFor(file), { label: '商城安装台账' }) : null;
		try {
			const entries = await readInstalled(dataRoot, { strict: true });
			const prev = entries.find(e => e.kind === entry.kind && e.storeId === entry.storeId);
			const next = entries.filter(e => !(e.kind === entry.kind && e.storeId === entry.storeId));
			// ★ 2026-11-24：IDE 侧双写**同一份**台账时只映射 6 个字段，
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
		} finally {
			if (release) { await release(); }
		}
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
		const file = installedFilePath(dataRoot);
		const svc = lockService();
		await mkdir(dirname(file), { recursive: true });
		const release = svc ? await svc.acquireFileLock(svc.lockFileFor(file), { label: '商城安装台账' }) : null;
		try {
			const entries = await readInstalled(dataRoot, { strict: true });
			const next = entries.filter(e => !(e.kind === kind && e.storeId === storeId));
			if (next.length === entries.length) { return entries; }
			await writeAtomic(file, next);
			return next;
		} finally {
			if (release) { await release(); }
		}
	});
}
