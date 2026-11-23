// @vssaros/dsh-marketplace — 升级备份点：列举 / 计划 / 恢复（★ 2026-11-23）
//
// 背景：`installers.js::backupBeforeUpgrade` 升级前会把旧目录复制到
//   `<数据根>/.upgrade-backup/<id>-<ts>/`（`ts` = ISO 时间把 `:` / `.` 换成 `-`），
//   但**一直没有「列出来 / 恢复」的入口** ⇒ 备份只能靠人工翻目录，等于没有回滚能力 ✗。
//
// 本模块是这条链路的**单一真源**（纯判据 + IO，零网络、零 IDE 依赖）：
//   · 只认能解析出 `<id>-<ts>` 的目录，别的（含本次回滚留下的 pre-restore）一律跳过；
//   · 恢复时先把**当前**版本原子挪到备份区，再把备份**复制**回目标（备份点保留 ⇒ 可重复回滚）；
//   · 中途失败要把当前版本放回去，绝不留下半个目录；
//   · 下发给页面的投影**不含磁盘路径**（`validateRollbackPoint` 只留展示字段）。
//
// ⚠ `storeId` 一律过 `assertSafeStoreId`（与安装器同口径）⇒ 不许靠 `../` 跑出数据根 ✗。

import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafeStoreId, targetRootOf } from './installers.js';

export const BACKUP_DIR = '.upgrade-backup';

/** `2026-11-23T12-34-56-789Z` —— backupBeforeUpgrade 生成的时间戳形状。 */
const TS_RE = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;

async function exists(p) {
	try { await stat(p); return true; } catch { return false; }
}

/** 解析备份目录名；带连字符的 slug（`vssaros-release-pipeline`）也要认。 */
export function parseBackupDirName(name) {
	const s = String(name ?? '');
	const m = TS_RE.exec(s);
	if (!m) { return undefined; }
	const id = s.slice(0, m.index).replace(/-$/, '');
	if (!id || id.includes('-pre-restore')) { return undefined; }
	return { id, ts: m[1] };
}

/**
 * 列可回滚点（按时间倒序）。`storeId` 可只筛某一件；没备份 / 备份区不存在 ⇒ 空数组，
 * **不是错误**（面板显示「暂无可回滚版本」即可）。
 */
export async function listRollbackPoints({ dataRoot, kind = '', storeId = '' } = {}) {
	const root = join(String(dataRoot ?? ''), BACKUP_DIR);
	let entries = [];
	try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
	const out = [];
	for (const ent of entries) {
		if (!ent.isDirectory()) { continue; }
		const parsed = parseBackupDirName(ent.name);
		if (!parsed) { continue; }
		if (storeId && parsed.id !== String(storeId)) { continue; }
		const dir = join(root, ent.name);
		let createdAt = parsed.ts;
		try { createdAt = new Date((await stat(dir)).mtimeMs).toISOString(); } catch { /* 用目录名里的时间戳兜底 */ }
		out.push({ id: parsed.id, ts: parsed.ts, kind: String(kind ?? ''), createdAt, name: ent.name, dir });
	}
	out.sort((a, b) => b.ts.localeCompare(a.ts) || b.name.localeCompare(a.name));
	return out;
}

/** 恢复前的计划（纯判据 + 一次目录探测）；`ts` 缺省 = 最近一次备份。 */
export async function planRollback({ dataRoot, kind, storeId, ts } = {}) {
	const id = assertSafeStoreId(storeId, 'storeId');
	let root;
	try { root = targetRootOf(String(dataRoot ?? ''), String(kind ?? '')); }
	catch (e) { return { ok: false, reason: String(e?.message ?? e) }; }
	const targetDir = join(root, id);
	const points = await listRollbackPoints({ dataRoot, kind, storeId: id });
	const point = ts ? points.find(p => p.ts === String(ts)) : points[0];
	if (!point) {
		return { ok: false, reason: ts ? `找不到「${id}」在 ${ts} 的备份` : `「${id}」没有可回滚的备份` };
	}
	return { ok: true, id, kind: String(kind), ts: point.ts, backupDir: point.dir, targetDir, currentExists: await exists(targetDir) };
}

/**
 * 恢复一个备份点。**保留备份目录**（用 cp 而不是 rename）⇒ 同一个点可以反复回滚。
 * 失败时把当前版本放回去，返回 `{ok:false,error}`，不把异常抛成 500。
 */
export async function restoreRollbackPoint({ dataRoot, kind, storeId, ts } = {}) {
	let plan;
	try { plan = await planRollback({ dataRoot, kind, storeId, ts }); }
	catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
	if (!plan.ok) { return { ok: false, error: plan.reason }; }

	const backupRoot = join(String(dataRoot), BACKUP_DIR);
	await mkdir(backupRoot, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const savedCurrent = join(backupRoot, `${plan.id}-${stamp}-pre-restore`);
	let moved = '';
	if (plan.currentExists) {
		try {
			await rename(plan.targetDir, savedCurrent);   // 同盘原子，先把现状留住
			moved = savedCurrent;
		} catch (e) { return { ok: false, error: `当前版本挪不走，未执行回滚：${String(e?.message ?? e)}` }; }
	}
	try {
		await cp(plan.backupDir, plan.targetDir, { recursive: true });
		return { ok: true, id: plan.id, kind: plan.kind, ts: plan.ts, restoredFrom: plan.ts, currentSavedTo: moved };
	} catch (e) {
		try { await rm(plan.targetDir, { recursive: true, force: true }); } catch { /* 本来就没写进去 */ }
		if (moved) {
			try { await rename(moved, plan.targetDir); } catch { /* 还原失败要靠 currentSavedTo 人工救 */ }
		}
		return { ok: false, error: `恢复失败（已尽力还原）：${String(e?.message ?? e)}` };
	}
}

/** 推给页面的投影：只留展示字段，**绝不把磁盘路径下发**。 */
export function validateRollbackPoint(value) {
	if (!value || typeof value !== 'object') { return undefined; }
	const v = value;
	if (typeof v.id !== 'string' || !v.id || typeof v.ts !== 'string' || !v.ts) { return undefined; }
	return {
		id: v.id.slice(0, 200),
		ts: v.ts.slice(0, 64),
		kind: typeof v.kind === 'string' ? v.kind.slice(0, 32) : '',
		createdAt: typeof v.createdAt === 'string' ? v.createdAt.slice(0, 64) : '',
	};
}
