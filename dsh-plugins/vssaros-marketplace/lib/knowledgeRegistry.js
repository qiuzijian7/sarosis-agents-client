// @vssaros/dsh-marketplace — **knowledge 注册表**（★ 2026-11-10 P3）
//
// 为什么单开一层：原先 `installers.js` 的 register/unregister 是「读整个数组 → 改 →
//   整文件覆写」的 read-modify-write，且 KB 数据根靠「从 dataRoot 向上 5 层猜」。
//   三个真实断点（由跨插件调研取证）：
//     ① 路径解析不对称 —— KB 侧真源是 `config.kbRoot || join(dataRoot,'knowledge-base')`
//        （`vssaros-kb/lib/store.js` 的 `kbRootOf`）；用户配了自定义 kbRoot ⇒ 商城永远
//        找不到、静默只写包内标记 ⇒ 装完在知识库里看不见。
//     ② 并发写丢条目 —— 两个安装/卸载并发时后写者覆盖前者（无锁、非原子）。
//     ③ 登记失败被 call site 的 `catch {}` 吞掉 ⇒ 「装好了却看不见」没有诊断。
//
// 本模块负责 ①②（原子写 + 串行队列 + 与 KB 同口径的路径解析）；
// ③ 由调用方把 `{ok:false,why}` 如实回执，不再吞（见 installers.js / index.js）。
//
// ⚠ 与 vssaros-kb 的契约仍然是**注册表文件**：两端各自保留同值常量
//   `MARKET_VAULTS_FILE`（`check-marketplace-knowledge.mjs` 静态钉住），KB 侧只读。

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const MARKET_VAULTS_FILE = '.market-vaults.json';

/** 进程内写串行（与 installedLedger.js 同款：读-改-写不丢更新）。 */
let queue = Promise.resolve();
function serialized(task) {
	const next = queue.then(task, task);
	queue = next.catch(() => undefined);
	return next;
}

async function isDir(p) {
	try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/**
 * 解析 KB 数据根：显式 kbRoot 优先 ⇒ `join(dataRoot,'knowledge-base')` ⇒ 旧布局向上猜。
 * 与 `vssaros-kb/lib/store.js` 的 `kbRootOf` 同口径；向上猜只作兼容兜底。
 * 找不到返回 `''`，调用方**必须如实报**，不许当成成功。
 */
export async function resolveKbRoot(dataRoot, explicit) {
	const given = String(explicit ?? '').trim();
	if (given) { return resolve(given); }
	const base = String(dataRoot ?? '').trim();
	if (!base) { return ''; }
	const direct = join(base, 'knowledge-base');
	if (await isDir(direct)) { return direct; }
	let cur = resolve(base);
	for (let i = 0; i < 5; i++) {
		const up = dirname(cur);
		if (!up || up === cur) { break; }
		cur = up;
		const cand = join(cur, 'knowledge-base');
		if (await isDir(cand)) { return cand; }
	}
	return '';
}

async function readList(file) {
	try {
		const list = JSON.parse(await readFile(file, 'utf8')) ?? [];
		return Array.isArray(list) ? list : [];
	} catch {
		// 文件不存在 / 坏 JSON ⇒ 空清单（**不覆盖坏文件**：不把用户已有的登记清空）
		return [];
	}
}

/** 原子写：tmp + rename，写一半崩掉不会留下半个 JSON。 */
async function writeListAtomic(file, list) {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
	await rename(tmp, file);
}

/** 读清单（只读，用于守卫/诊断）。 */
export function listVaults({ dataRoot, kbRoot }) {
	return serialized(async () => {
		const root = await resolveKbRoot(dataRoot, kbRoot);
		if (!root) { return { ok: false, why: 'kb-data-root-not-found', items: [] }; }
		return { ok: true, items: await readList(join(root, MARKET_VAULTS_FILE)) };
	});
}

/** 登记/覆盖一个商城知识库（同 id 覆盖，与旧行为一致）。 */
export function addVault({ dataRoot, kbRoot, entry }) {
	return serialized(async () => {
		const root = await resolveKbRoot(dataRoot, kbRoot);
		if (!root) { return { ok: false, why: 'kb-data-root-not-found' }; }
		const file = join(root, MARKET_VAULTS_FILE);
		const list = await readList(file);
		const idx = list.findIndex(v => v && v.id === entry.id);
		if (idx >= 0) { list[idx] = entry; } else { list.push(entry); }
		try {
			await writeListAtomic(file, list);
			return { ok: true, path: file };
		} catch (e) {
			return { ok: false, why: String(e?.message ?? e) };
		}
	});
}

/** 反登记（卸载/回滚时用，按 id 精确删，不动别人的条目）。 */
export function removeVault({ dataRoot, kbRoot, id }) {
	return serialized(async () => {
		const root = await resolveKbRoot(dataRoot, kbRoot);
		if (!root) { return { ok: false, why: 'kb-data-root-not-found' }; }
		const file = join(root, MARKET_VAULTS_FILE);
		const list = await readList(file);
		const next = list.filter(v => !v || v.id !== id);
		try {
			if (next.length !== list.length) { await writeListAtomic(file, next); }
			return { ok: true, path: file };
		} catch (e) {
			return { ok: false, why: String(e?.message ?? e) };
		}
	});
}
