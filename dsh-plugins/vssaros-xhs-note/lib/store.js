// @vssaros/dsh-xhs-note — 草稿存储（落 DSH 数据根，不是 localStorage）。
//
// 硬伤对照（doc/xhs-workbench-fix-plan.md 硬伤 1）：
//   · 一稿一文件（`drafts/<id>.json`）：单表每次保存要重写全部，200 篇会卡；
//   · 写入 = 临时文件 + rename（断电不会留半个 JSON）；
//   · `rev` 乐观锁：两个窗口同时改同一篇，后者拿 409 而不是互相覆盖；
//   · 上限 200 篇（元数据列表只读头部，不用把全文读进来）；
//   · 旧 localStorage 数据一次性迁移，标记写在**数据根**（换机重迁也只导一次）。
import { mkdir, readdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { foundation } from './foundationRef.js';

export const PLUGIN_SLUG = 'xhs-note';
export const MAX_DRAFTS = 200;
export const MAX_BODY_BYTES = 64 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{7,39}$/;

/**
 * 数据根：**委托** `@vssaros/dsh-foundation`（唯一真源：`config.dataRoot` → `$VSSAROS_DATA_ROOT` → `~/.vssaros`）。
 *
 * 为什么不内联一份：`check-host-config.mjs` 盯着"委托 N 份 + 真源 1 处"，
 *   再写第三份实现就会红；而且两套回落链迟早分叉（这就是 `vssaros-marketplace/lib/marketClient.js` 的前车之鉴）。
 */
export function dataRootOf(config) {
	// 委托到 @vssaros/dsh-foundation（重构 1.3：真源只有一份）；调用签名不变。
	return foundation().dataRootOf(config);
}

export function draftsDirOf(config) {
	return join(dataRootOf(config), PLUGIN_SLUG, 'drafts');
}

export class DraftConflictError extends Error {
	constructor() { super('这篇草稿已被别处修改（rev 不匹配），请刷新后重试'); this.code = 'CONFLICT'; }
}

const fileOf = (dir, id) => join(dir, id + '.json');
const assertId = (id) => {
	if (!ID_RE.test(String(id || ''))) { throw new Error('草稿 id 不合法'); }
	return String(id);
};
const newId = () => {
	const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
	return (stamp + '-' + randomBytes(3).toString('hex')).toLowerCase();
};

/** 原子写：先写同目录临时文件再 rename（同一分区上 rename 是原子的）。 */
async function writeAtomic(file, text) {
	const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(3).toString('hex');
	await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
	await rename(tmp, file);
}

const normalize = (body, prev) => {
	const title = String(body?.title ?? prev?.title ?? '').trim().slice(0, 200);
	const text = String(body?.body ?? prev?.body ?? '');
	if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) { throw new Error('正文太大（>64KB）'); }
	return {
		id: prev?.id || String(body?.id || '') || newId(),
		topic: String(body?.topic ?? prev?.topic ?? '').trim().slice(0, 200),
		title,
		body: text,
		tags: String(body?.tags ?? prev?.tags ?? '').trim().slice(0, 500),
		style: String(body?.style ?? prev?.style ?? '').slice(0, 40),
		savedAt: new Date().toISOString(),
		rev: (prev?.rev || 0) + 1,
	};
};

/** 列表：只读每篇的元数据（标题/时间/rev），按 savedAt 倒序。 */
export async function listDrafts(config) {
	const dir = draftsDirOf(config);
	let names = [];
	try { names = await readdir(dir); } catch (e) {
		if (e?.code === 'ENOENT') { return { drafts: [], dir, missing: dir }; }
		throw new Error(`草稿目录读取失败（${dir}）：${e?.message ?? e}`);
	}
	const drafts = [];
	for (const name of names) {
		if (!name.endsWith('.json') || name.startsWith('.')) { continue; }
		try {
			const raw = JSON.parse(await readFile(join(dir, name), 'utf8'));
			drafts.push({ id: raw.id || name.replace(/\.json$/, ''), title: raw.title || '', topic: raw.topic || '', savedAt: raw.savedAt || '', rev: raw.rev || 0 });
		} catch { /* 坏文件跳过，不拖垮列表 */ }
	}
	drafts.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
	return { drafts: drafts.slice(0, MAX_DRAFTS), dir, missing: '' };
}

export async function readDraft(config, id) {
	assertId(id);
	try { return JSON.parse(await readFile(fileOf(draftsDirOf(config), String(id)), 'utf8')); }
	catch (e) { if (e?.code === 'ENOENT') { return null; } throw e; }
}

/** 新建（无 id）或更新（带 id + rev）。更新时 rev 不匹配 ⇒ DraftConflictError。 */
export async function writeDraft(config, body) {
	const dir = draftsDirOf(config);
	await mkdir(dir, { recursive: true });
	const wanted = String(body?.id || '');
	let prev = null;
	if (wanted) {
		prev = await readDraft(config, wanted);
		if (!prev) { throw new Error('草稿不存在（可能已被删除）'); }
		if (Number(body?.rev) !== Number(prev.rev)) { throw new DraftConflictError(); }
	} else {
		const { drafts } = await listDrafts(config);
		if (drafts.length >= MAX_DRAFTS) { throw new Error(`草稿已达上限（${MAX_DRAFTS} 篇），请先删掉一些`); }
	}
	const record = normalize(body, prev);
	if (!record.title && !String(record.body).trim()) { throw new Error('标题与正文不能都为空'); }
	await writeAtomic(fileOf(dir, record.id), JSON.stringify(record, null, 2));
	return { id: record.id, rev: record.rev, savedAt: record.savedAt };
}

export async function deleteDraft(config, id) {
	assertId(id);
	try { await unlink(fileOf(draftsDirOf(config), String(id))); return { deleted: true }; }
	catch (e) { if (e?.code === 'ENOENT') { return { deleted: false }; } throw e; }
}

/**
 * 旧 localStorage 草稿一次性迁移（幂等）。
 *
 * 标记写在**数据根** `.migrated-localstorage`：换机后重新迁移也只会导一次；
 * 页面侧迁移后**不删** localStorage 那份（留作最后一道保险）。
 */
export async function migrateLegacy(config, items) {
	const dir = draftsDirOf(config);
	await mkdir(dir, { recursive: true });
	const marker = join(dir, '.migrated-localstorage');
	try { await stat(marker); return { imported: 0, skipped: true }; } catch { /* 没迁过 */ }
	const list = Array.isArray(items) ? items.slice(0, MAX_DRAFTS) : [];
	let imported = 0;
	for (const item of list) {
		try {
			// ⚠ 这里**直接落盘**而不是走 `writeDraft`：后者看到 `id` 会当成"更新"（要 rev），
			//   而迁移是"按旧 id 建档" ⇒ 走 create 语义。
			const record = normalize({
				topic: item?.topic, title: item?.title, body: item?.body, tags: item?.tags,
				id: 'legacy-' + String(item?.id || newId()).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30),
			}, null);
			await writeAtomic(fileOf(dir, record.id), JSON.stringify(record, null, 2));
			imported += 1;
		} catch { /* 单条坏数据跳过 */ }
	}
	await writeFile(marker, new Date().toISOString(), 'utf8');
	return { imported, skipped: false };
}
