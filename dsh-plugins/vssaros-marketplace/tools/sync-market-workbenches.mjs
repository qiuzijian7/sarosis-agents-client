#!/usr/bin/env node
/**
 * 把**dsh 公开市场**的工作台目录同步进自营商城（★ 2026-10-23 用户：
 * "商城中，缺少 设置→工作台商城 中的数据，将其数据爬取并上传到我们的商城数据库中"）。
 *
 * 数据源（协议 v2）：
 *   `https://market.dshdesktop.com/index.json`
 *   ⇒ `{ schemaVersion: 2, workbenches: [{ id:'owner/repo', owner, repository, url,
 *        name, description, category, version, license, stars, screenshots[], distribution }] }`
 *   （IDE「设置 → 工作台商城」读的就是它；dsh Host 的 `/x/market/api/catalog` 只是它的快照+策展）
 *
 * 映射：
 *   商城 kind      = `workbench`
 *   商城 slug      = `<owner>-<repo>`（19 个全唯一；带 owner 前缀防不同人同名仓库撞车）
 *   商城 name      = `name`（没有则用 repository）
 *   商城 description = `description`（服务端上限 2048，脚本与 publisher 都会截断）
 *   商城 category  = `category`
 *   distribution   = 原样映射（`github-source` ⇒ name=owner/repo + commit；`github-release` ⇒ url）
 *   缩略图         = `screenshots[0]` → 下载 → 上传到**我们自己的** `/api/v1/covers` → 写进 icon
 *
 * 幂等：已存在的版本会被服务端拒 ⇒ 记为 skipped（`--force` 才会重发版本）。
 *
 * 用法：
 *   node tools/sync-market-workbenches.mjs              # 同步（缺的补、已有的跳过）
 *   node tools/sync-market-workbenches.mjs --covers     # 同时把缩略图抓成自持（推荐）
 *   node tools/sync-market-workbenches.mjs --dry        # 只看会做什么
 *   node tools/sync-market-workbenches.mjs --limit 3
 *
 * 环境变量：
 *   MARKET_ENDPOINT   默认 http://21.6.92.5:3040
 *   MARKET_CATALOG    覆盖目录地址（默认上面的官方地址）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIB = path.resolve(import.meta.dirname, '..', 'lib');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const WITH_COVERS = args.has('--covers');
const FORCE = args.has('--force');
const LIMIT = (() => {
	const i = process.argv.indexOf('--limit');
	const n = i >= 0 ? Number(process.argv[i + 1]) : 0;
	return Number.isFinite(n) && n > 0 ? n : 0;
})();

const ENDPOINT = (process.env.MARKET_ENDPOINT || 'http://21.6.92.5:3040').replace(/\/$/, '');
const CATALOG_URL = process.env.MARKET_CATALOG || 'https://market.dshdesktop.com/index.json';
const CONCURRENCY = 3;

const { createMarketClient, TOF_LOCAL_TICKET_REF, TOF_IDENTITY_REF } = await import(
	pathToFileURL(path.join(LIB, 'marketClient.js')).href
);
const { publishDistribution } = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);

// ── 凭据（与 dsh 页面同一份 TOF 票据）─────────────────────────────
const CRED_FILE = path.join(os.homedir(), '.vssaros-dev/dsh-home/.credentials.yaml');
function grabCred(ref) {
	const text = fs.readFileSync(CRED_FILE, 'utf8');
	const m = new RegExp(ref + '[ \\t]*:[ \\t]*(.+)$', 'm').exec(text);
	return m ? m[1].trim().replace(/^'/, '').replace(/'$/, '') : undefined;
}
const store = new Map();
store.set(TOF_LOCAL_TICKET_REF, grabCred('VSSAROS_TOF_TICKET_DSH'));
store.set(TOF_IDENTITY_REF, grabCred('VSSAROS_TOF_IDENTITY_DSH'));
const credentials = {
	resolve: async (ref) => (store.has(ref) ? { value: store.get(ref) } : undefined),
	set: async (ref, value) => { store.set(ref, value); },
};
const market = createMarketClient({ credentials, config: { marketEndpoint: ENDPOINT }, log: () => {} });

// ── 工具 ──────────────────────────────────────────────────────────
/**
 * 文案归一：公开市场的 `description` 是**多语言对象** `{ zh, en }`（19/19 都是）。
 *
 * ⚠ 血泪：第一版用 `String(w.description)` ⇒ 入库成字面量 **`[object Object]`**
 *   （商城卡片上真的就这么显示了，用户截图反馈"很多 [object Object]"）✗
 *
 * @param {unknown} v
 * @returns {string}
 */
function pickText(v) {
	if (v === null || v === undefined) { return ''; }
	if (typeof v === 'string') { return v; }
	if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
	if (Array.isArray(v)) { return v.map(pickText).filter(Boolean).join(' / '); }
	if (typeof v === 'object') {
		for (const k of ['zh', 'zh-CN', 'zhCn', 'cn', 'en', 'default']) {
			if (typeof v[k] === 'string' && v[k].trim()) { return v[k]; }
		}
		for (const k of Object.keys(v)) {
			if (typeof v[k] === 'string' && v[k].trim()) { return v[k]; }
		}
		return '';
	}
	return String(v);
}

/** 目录 id（`owner/repo`）→ 商城 slug（`owner-repo`，符合 `[a-z0-9][a-z0-9_-]*`）。 */
function slugOf(item) {
	const raw = String(item?.id || `${item?.owner ?? ''}/${item?.repository ?? ''}`);
	return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/**
 * 目录的 `distribution` → 服务端 `DistributionSchema`。
 *
 * 服务端只认三种：npm（name）/ github-release（url）/ github-source（name=owner/repo + commit）。
 * **映射不了就返回 null**（宁可跳过这个商品，也不要编一个假的来源 ✗）。
 */
function toDistribution(item) {
	const d = item?.distribution;
	const repo = String(item?.id || '');
	if (!d || typeof d !== 'object') {
		// 没给 distribution 但有 GitHub 地址 ⇒ 当 github-source（目录里的商品本体就是仓库）
		return repo.includes('/') ? { type: 'github-source', name: repo.toLowerCase() } : null;
	}
	if (d.type === 'github-release' && d.url) { return { type: 'github-release', url: String(d.url) }; }
	if (d.type === 'github-source' && repo.includes('/')) {
		return { type: 'github-source', name: repo.toLowerCase(), ...(d.commit ? { commit: String(d.commit) } : {}) };
	}
	if (d.type === 'npm' && d.name) { return { type: 'npm', name: String(d.name) }; }
	return null;
}

async function mapLimit(items, limit, worker) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) { return; }
			out[i] = await worker(items[i], i);
		}
	}));
	return out;
}

/** 下载截图 → 上传到我们自己的 `/api/v1/covers` → 返回自家 URL。 */
async function uploadCover({ slug, imageUrl, token }) {
	try {
		const img = await fetch(imageUrl, {
			signal: AbortSignal.timeout(25000),
			headers: { 'user-agent': 'Mozilla/5.0 (compatible; VsSarosMarket/1.0)', accept: 'image/*' },
		});
		if (!img.ok) { return { error: `下载 HTTP ${img.status}` }; }
		const buf = Buffer.from(await img.arrayBuffer());
		if (buf.length === 0) { return { error: '下载到 0 字节' }; }
		const ext = /\.(png|jpe?g|webp|gif)(?:$|\?)/i.exec(imageUrl)?.[1]?.toLowerCase().replace('jpeg', 'jpg') || 'png';
		const r = await fetch(`${ENDPOINT}/api/v1/covers?${new URLSearchParams({ slug, ext })}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
			body: buf,
			signal: AbortSignal.timeout(30000),
		});
		const body = await r.json().catch(() => ({}));
		if (!r.ok) { return { error: `上传 HTTP ${r.status}：${String(body?.error ?? '').slice(0, 60)}` }; }
		return { url: `${ENDPOINT}${body.url}`, bytes: buf.length };
	} catch (e) {
		return { error: String(e?.message ?? e).slice(0, 90) };
	}
}

// ── 主流程 ────────────────────────────────────────────────────────
console.log(`目录 ${CATALOG_URL}\n商城 ${ENDPOINT}${DRY ? '（dry-run）' : ''}${WITH_COVERS ? ' · 抓缩略图' : ''}`);

const res = await fetch(CATALOG_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
if (!res.ok) {
	console.error(`✘ 拉目录失败：HTTP ${res.status}`);
	process.exit(1);
}
const catalog = await res.json();
const list = Array.isArray(catalog.workbenches) ? catalog.workbenches
	: Array.isArray(catalog.items) ? catalog.items : [];
console.log(`目录条目 ${list.length} 个（schemaVersion ${catalog.schemaVersion ?? '?'}）`);

// 只同步"可安装/已上架"的（目录里可能有下架/探针失败的）
const usable = list.filter((w) => {
	if (w.listed === false) { return false; }
	if (w.installable === false) { return false; }
	return Boolean(toDistribution(w));
});
console.log(`可同步 ${usable.length} 个（跳过 ${list.length - usable.length}：下架/不可装/来源无法映射）`);

const targets = LIMIT ? usable.slice(0, LIMIT) : usable;
let token = '';
if (WITH_COVERS && targets.length > 0) {
	token = await market.login();
	console.log('已登录（缩略图将上传到本商城自持）');
}

let created = 0, skipped = 0, coverOk = 0;
const failures = [];

const results = await mapLimit(targets, CONCURRENCY, async (w) => {
	const slug = slugOf(w);
	const version = String(w.version || '').trim() || '0.1.0';
	const dist = toDistribution(w);
	const meta = {
		// ⚠ 必须走 pickText：`description` 是 `{zh,en}` 对象，直接 String() 会变成 `[object Object]`
		name: pickText(w.name) || pickText(w.nameEn) || pickText(w.repository) || slug,
		description: pickText(w.description) || pickText(w.descriptionEn),
		...(w.category ? { category: pickText(w.category) } : {}),
	};
	if (DRY) { return { slug, version, status: 'dry', dist }; }
	try {
		const r = await publishDistribution({ market, kind: 'workbench', localId: slug, version, distribution: dist, changelog: '从 dsh 公开市场同步', meta });
		return { slug, version, status: 'ok', created: r.created, dist };
	} catch (e) {
		const msg = String(e?.message ?? e);
		if (/已存在|已被占用|HTTP 409|重复/.test(msg)) {
			// ★ 2026-10-23：版本已存在 ⇒ **顺便把文案修正一次**。
			//   第一版把 `description` 存成了 `[object Object]`（多语言对象直接 String()）
			//   ⇒ 重跑本脚本即可自动治愈，不用手工改库 ✓
			let fixed = false;
			try {
				await market.updatePackage(slug, {
					name: meta.name,
					...(meta.description ? { description: meta.description } : {}),
					...(meta.category ? { category: meta.category } : {}),
				});
				fixed = true;
			} catch { /* 修不了也不影响同步结论 */ }
			return { slug, version, status: 'skip', fixedText: fixed };
		}
		return { slug, version, status: 'fail', why: msg.slice(0, 100) };
	}
});

// 缩略图（串行上传，避免一次打太多请求到自家服务端）
if (WITH_COVERS && !DRY) {
	for (const w of targets) {
		const shot = Array.isArray(w.screenshots) ? w.screenshots[0] : null;
		if (!shot?.url) { continue; }
		const slug = slugOf(w);
		const up = await uploadCover({ slug, imageUrl: shot.url, token });
		if (!up.url) { failures.push(`${slug}: 缩略图 ${up.error}`); continue; }
		try {
			await market.updatePackage(slug, { icon: up.url });
			coverOk += 1;
		} catch (e) {
			failures.push(`${slug}: 写 icon 失败 ${String(e?.message ?? e).slice(0, 70)}`);
		}
	}
}

for (const r of results) {
	if (r.status === 'ok') { created += r.created ? 1 : 0; if (!r.created) { skipped += 1; } }
	else if (r.status === 'skip') { skipped += 1; }
	else if (r.status === 'dry') { /* 只打样例 */ }
	else { failures.push(`${r.slug}: ${r.why}`); }
}

console.log(`\n结果：新增 ${created} · 跳过（已存在） ${skipped} · 失败 ${results.filter(r => r.status === 'fail').length}${WITH_COVERS ? ` · 缩略图自持 ${coverOk}` : ''}`);
if (failures.length) {
	console.log('问题明细（前 10）：');
	for (const f of failures.slice(0, 10)) { console.log('  ', f); }
}
if (DRY) {
	console.log('样例（dry-run）：');
	for (const r of results.slice(0, 3)) { console.log('  ', r.slug, 'v' + r.version, JSON.stringify(r.dist)); }
}
console.log('\n完成。刷新商城「工作台」页签即可看到（kind=workbench）。');
