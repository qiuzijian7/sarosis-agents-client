// @vssaros/dsh-marketplace — **离线便携包**（★ 2026-11-10 P2）
//
// 用途：把本机已装资源打包成一个文件，搬到另一台机器再导入；全程不经过商城服务端。
// 借鉴 dsh-desktop 的 `.dshpreset`：两步（预览 → 确认）、不覆盖同 id、
//   `mkdtemp` + `rename` 原子落盘、失败不留半个目录、冲突给出口（改名）。
//
// 与商城分发包的差别：格式沿用现有 tar.gz + 目录镜像（不引入新的打包实现、不改服务端
//   schema）；一个便携包可含多个资源，包内路径前缀 `items/<kind>/<id>/`。
// ⚠ 大小上限：包体通过 JSON(base64) 在自托管页与 Host 之间传 ⇒ 必须限死，
//   否则一个几十 MB 的包会把 Host 主线程和页面同时拖死。

import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { listTarGzEntries, packTarGz } from './tar.js';
import { COMPONENT_DIR, COMPONENT_ENTRY } from './components.js';
import { collectDir } from './publisher.js';
import { registerMcpServer, removeMcpCompletely } from './mcpInstall.js';
import { registerKnowledgeVault } from './installers.js';
import { upsertInstalled } from './installedLedger.js';
import { SIDECAR_FILE, sidecarOf } from './sidecar.js';

export const PORTABLE_FORMAT = 'vssaros-portable-bundle';
export const PORTABLE_VERSION = 1;
export const MAX_PACK_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 50;
const MANIFEST_FILE = 'manifest.json';
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 组合包清单不是资源本体，导出时剥离（导入后这些是独立资源）。 */
const EXCLUDE_IN_PORTABLE = new Set(['bot.json', 'components.json']);

async function pathExists(p) {
	try { await stat(p); return true; } catch { return false; }
}

function safeId(id, what) {
	const s = String(id ?? '').trim();
	if (!ID_RE.test(s)) { throw new Error(`${what} 非法：${s}（a-z0-9_-，小写字母开头，≤64）`); }
	return s;
}

/**
 * 导出：把选中的已装资源打成一个 tar.gz。
 *
 * @param {{dataRoot: string, entries: Array<{kind:string, storeId?:string, id?:string, version?:string}>}} args
 * @returns {Promise<{ok:true, manifest:object, bytes:number, base64:string}>}
 */
export async function exportPortable({ dataRoot, entries }) {
	if (!dataRoot) { throw new Error('拿不到数据根，无法导出便携包'); }
	const list = Array.isArray(entries) ? entries : [];
	if (!list.length) { throw new Error('没有选中任何资源'); }
	if (list.length > MAX_ITEMS) { throw new Error(`一次最多导出 ${MAX_ITEMS} 个资源（当前 ${list.length}）`); }
	const items = [];
	const packed = [];
	const seen = new Set();
	for (const e of list) {
		const kind = String(e?.kind ?? '');
		if (!COMPONENT_DIR[kind]) { throw new Error(`便携包不支持这一类：${kind}`); }
		const id = safeId(e?.storeId ?? e?.id, '资源 id');
		const key = `${kind}:${id}`;
		if (seen.has(key)) { continue; }
		seen.add(key);
		const dir = join(dataRoot, COMPONENT_DIR[kind], id);
		let st;
		try { st = await stat(dir); } catch { throw new Error(`本机没有这个资源：${key}（${dir}）`); }
		if (!st.isDirectory()) { throw new Error(`不是资源目录：${dir}`); }
		const files = (await collectDir(dir, { skipManifest: true, knowledge: kind === 'knowledge' }))
			.filter(f => !EXCLUDE_IN_PORTABLE.has(f.path) && f.path !== SIDECAR_FILE);
		if (!files.length) { throw new Error(`资源目录里没有可导出的文件：${key}`); }
		for (const f of files) {
			packed.push({ path: `items/${kind}/${id}/${f.path}`, data: f.data });
		}
		items.push({ kind, id, version: String(e?.version ?? '').trim(), files: files.length });
	}
	const manifest = {
		format: PORTABLE_FORMAT,
		version: PORTABLE_VERSION,
		exportedAt: new Date().toISOString(),
		sourceApp: 'VsSaros',
		items,
	};
	packed.push({ path: MANIFEST_FILE, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
	const gzBuffer = packTarGz(packed);
	if (gzBuffer.length > MAX_PACK_BYTES) {
		throw new Error(`便携包 ${(gzBuffer.length / 1024 / 1024).toFixed(1)}MB 超过 ${(MAX_PACK_BYTES / 1024 / 1024).toFixed(0)}MB 上限（请少选几个资源）`);
	}
	return { ok: true, manifest, bytes: gzBuffer.length, base64: gzBuffer.toString('base64') };
}

/** 解包 + 校验清单（发布端与导入端共用同一份判据）。 */
export async function readPortable(gzBuffer) {
	if (!Buffer.isBuffer(gzBuffer) || !gzBuffer.length) { throw new Error('便携包是空的'); }
	if (gzBuffer.length > MAX_PACK_BYTES) { throw new Error('便携包超过体积上限，拒绝解包'); }
	const { files } = await listTarGzEntries(gzBuffer, { maxBytes: 64 * 1024 * 1024, maxEntries: 2000 });
	const mf = files.find(f => f.path === MANIFEST_FILE);
	if (!mf) { throw new Error('便携包缺 manifest.json（不是 VsSaros 便携包）'); }
	let manifest;
	try { manifest = JSON.parse(mf.data.toString('utf8')); }
	catch { throw new Error('便携包的 manifest.json 不是合法 JSON'); }
	if (manifest?.format !== PORTABLE_FORMAT) { throw new Error('不是 VsSaros 便携包（format 不匹配）'); }
	if (manifest.version !== PORTABLE_VERSION) {
		throw new Error(`便携包版本 ${String(manifest.version)} 不受支持（当前只支持 ${PORTABLE_VERSION}）`);
	}
	if (!Array.isArray(manifest.items) || !manifest.items.length || manifest.items.length > MAX_ITEMS) {
		throw new Error('便携包的 items 必须是 1~50 条');
	}
	const seen = new Set();
	for (const it of manifest.items) {
		const kind = String(it?.kind ?? '');
		if (!COMPONENT_DIR[kind]) { throw new Error(`便携包含不支持的类型：${kind}`); }
		const id = safeId(it?.id, '包内资源 id');
		const key = `${kind}:${id}`;
		if (seen.has(key)) { throw new Error(`便携包里有重复资源：${key}`); }
		seen.add(key);
	}
	return { manifest, files };
}

/** 第一步：预览（只读，不写任何盘）。冲突项逐条列出，给用户改名的机会。 */
export async function previewPortable({ dataRoot, gzBuffer }) {
	if (!dataRoot) { throw new Error('拿不到数据根，无法预览便携包'); }
	const { manifest, files } = await readPortable(gzBuffer);
	const items = [];
	for (const it of manifest.items) {
		const prefix = `items/${it.kind}/${it.id}/`;
		const owned = files.filter(f => f.path.startsWith(prefix))
			.map(f => ({ path: f.path.slice(prefix.length), data: f.data }));
		const entry = COMPONENT_ENTRY[it.kind];
		if (entry && !owned.some(f => f.path === entry)) {
			throw new Error(`便携包里的「${it.kind}:${it.id}」缺入口文件 ${entry}（拒绝导入半个资源）`);
		}
		items.push({
			kind: it.kind,
			id: it.id,
			version: String(it.version ?? ''),
			files: owned.length,
			exists: await pathExists(join(dataRoot, COMPONENT_DIR[it.kind], it.id)),
			targetDir: join(dataRoot, COMPONENT_DIR[it.kind], it.id),
		});
	}
	return {
		ok: true,
		format: PORTABLE_FORMAT,
		exportedAt: String(manifest.exportedAt ?? ''),
		bytes: gzBuffer.length,
		items,
		conflicts: items.filter(i => i.exists).map(i => `${i.kind}:${i.id}`),
	};
}

/**
 * 第二步：原子导入。
 * · 冲突（同 kind+id 已存在）一律拒，除非 `renames` 给了新 id ⇒ 不覆盖别人的资源；
 * · 先全写到数据根下的临时目录，再逐个 `rename`（同盘原子），失败回滚已落位的目录；
 * · 侧车由本机重新生成（不把源机器的安装状态带过来）；
 * · mcp / knowledge 装完仍要注册，否则「装了却连不上 / 看不见」。
 */
export async function importPortable({ dataRoot, gzBuffer, renames = {} }) {
	if (!dataRoot) { throw new Error('拿不到数据根，无法导入便携包'); }
	const { manifest, files } = await readPortable(gzBuffer);
	const renameMap = (renames && typeof renames === 'object' && !Array.isArray(renames)) ? renames : {};
	const plan = manifest.items.map(it => {
		const id = safeId(renameMap[`${it.kind}:${it.id}`] ?? it.id, '导入目标 id');
		return {
			kind: it.kind,
			id,
			sourceId: it.id,
			prefix: `items/${it.kind}/${it.id}/`,
			version: String(it.version ?? '').trim() || '1.0.0',
			dir: join(dataRoot, COMPONENT_DIR[it.kind], id),
		};
	});
	// 冲突检查必须在任何写盘之前（否则会留下「装了 2/3 个资源」的残局）
	for (const p of plan) {
		if (await pathExists(p.dir)) {
			throw new Error(`「${p.kind}:${p.id}」本机已存在，不覆盖。请在冲突项里填新名字，或先卸载本机那份`);
		}
	}
	// mkdtemp 必须落在**数据根内**：跨盘 rename 会 EXDEV
	const tmpRoot = await mkdtemp(join(dataRoot, '.portable-import-'));
	const moved = [];
	try {
		for (const p of plan) {
			const staging = join(tmpRoot, p.kind, p.id);
			const rel = files.filter(f => f.path.startsWith(p.prefix))
				.map(f => ({ path: f.path.slice(p.prefix.length), data: f.data }));
			const entry = COMPONENT_ENTRY[p.kind];
			if (entry && !rel.some(f => f.path === entry)) {
				throw new Error(`「${p.kind}:${p.sourceId}」缺入口文件 ${entry}（拒绝导入半个资源）`);
			}
			for (const f of rel) {
				const abs = join(staging, f.path);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, f.data);
			}
			await writeFile(join(staging, SIDECAR_FILE),
				sidecarOf({ storeId: p.id, version: p.version }), 'utf8');
			await mkdir(dirname(p.dir), { recursive: true });
			await rename(staging, p.dir);
			moved.push(p);
		}
		for (const p of moved.filter(x => x.kind === 'mcp')) {
			const cfg = JSON.parse(await readFile(join(p.dir, 'config.json'), 'utf8'));
			await registerMcpServer(dataRoot, p.id, cfg);
		}
		for (const p of moved.filter(x => x.kind === 'knowledge')) {
			await registerKnowledgeVault({ dataRoot, id: p.id, name: p.id, dir: p.dir }).catch(() => undefined);
		}
		for (const p of moved) {
			await upsertInstalled(dataRoot, { kind: p.kind, storeId: p.id, version: p.version });
		}
		return { ok: true, imported: moved.map(p => ({ kind: p.kind, id: p.id, dir: p.dir })), bytes: gzBuffer.length };
	} catch (e) {
		for (const p of moved) {
			if (p.kind === 'mcp') { await removeMcpCompletely(dataRoot, p.id).catch(() => undefined); }
			await rm(p.dir, { recursive: true, force: true }).catch(() => undefined);
		}
		throw e;
	} finally {
		await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
	}
}
