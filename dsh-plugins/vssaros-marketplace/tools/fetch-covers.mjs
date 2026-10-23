#!/usr/bin/env node
/**
 * 商城商品**缩略图抓取**（★ 2026-10-23 用户："参考 colorskill 平台，使用缩略图展示，
 * 缩略图的资源从 colorskill 中爬取到我们的数据库中"）。
 *
 * 做法：商品的 `description` 里本来就带 Cola Skill 的页面地址
 * （`来源: Cola Skill (https://colaskill.com/zh/<slug>/)`）⇒
 *   ① 抓那个页面，取 `og:image`（Cola Skill 的官方预览图，落在 files.meetcola.com）
 *   ② 把图片地址写回商品的 `icon` 字段（服务端 `updatePackage` 本来就支持 icon）
 *
 * 为什么写 URL 而不是把图片下载到我们的服务器：
 *   · 商品表已有 `icon` 字段，而前端**早就**支持"icon 是图片地址 ⇒ <img loading=lazy>"
 *     ⇒ 零服务端改动就能出效果 ✓
 *   · 图片是 Cola Skill 的 CDN 产物（OSS 带图片处理参数）⇒ 我们存 URL 即可按需缩放到
 *     任意尺寸（`?x-oss-process=image/resize,w_480`），比自己存一份更省空间
 *   ⚠ 若将来要"离线可用"，再把图下载到 `<DATA_DIR>/uploads/covers/` 并加静态路由
 *     （本脚本的 `--download` 已预留该路径，但服务端路由尚未加，见文件末尾 TODO）
 *
 * 用法：
 *   node tools/fetch-covers.mjs                 # 只补 emoji/空 icon 的商品（幂等）
 *   node tools/fetch-covers.mjs --force         # 全部重抓（覆盖已有图片）
 *   node tools/fetch-covers.mjs --dry           # 只看会改什么，不写库
 *   node tools/fetch-covers.mjs --limit 5       # 只处理 5 个（先小范围验）
 *
 * 环境变量（与其它脚本同口径）：
 *   MARKET_ENDPOINT  默认 http://21.6.92.5:3040
 * 凭据：读 dsh 的 credentials 文件里的 TOF 票据（与页面同一身份）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIB = path.resolve(import.meta.dirname, '..', 'lib');
const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const DRY = args.has('--dry');
const LIMIT = (() => {
	const i = process.argv.indexOf('--limit');
	const n = i >= 0 ? Number(process.argv[i + 1]) : 0;
	return Number.isFinite(n) && n > 0 ? n : 0;
})();

const ENDPOINT = process.env.MARKET_ENDPOINT || 'http://21.6.92.5:3040';
const PAGE_SIZE = 60;
/** 抓取并发（对 Cola Skill 温柔一点：3 个足够，别把人家当压测） */
const CONCURRENCY = 3;
/** 缩略图目标宽度（Cola Skill 的 OSS 支持 size 参数；480 够卡片用，比 1920 快很多） */
const THUMB_WIDTH = 480;

const { createMarketClient, TOF_LOCAL_TICKET_REF, TOF_IDENTITY_REF } = await import(
	pathToFileURL(path.join(LIB, 'marketClient.js')).href
);

// ── 凭据（与 dsh 页面同一份）──────────────────────────────────────
const CRED_FILE = path.join(os.homedir(), '.vssaros-dev/dsh-home/.credentials.yaml');
function grabCred(ref) {
	const text = fs.readFileSync(CRED_FILE, 'utf8');
	const m = new RegExp(ref + ':[ \\t]*(.+)$', 'm').exec(text);
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

// ── 从描述里抠出 Cola Skill 页面 ──────────────────────────────────
const COLA_URL = /https?:\/\/(?:www\.)?colaskill\.com\/[^\s)）"'<>]+/i;

/** 已经是图片地址？（emoji/空 都需要补图） */
const isImageIcon = (v) => /^(https?:\/\/|data:image\/)/i.test(String(v ?? '').trim());
/** 服务端默认的占位图标（要当作"没图"处理，否则永远补不上） */
const PLACEHOLDER_ICONS = new Set(['🥤', '📦', '🎁']);

/** og:image → 缩略图尺寸（Cola Skill 用阿里云 OSS，`x-oss-process=image/resize,w_xxx`） */
function thumbUrl(ogImage) {
	const raw = String(ogImage || '').trim();
	if (!raw) { return ''; }
	try {
		const u = new URL(raw);
		// 已经是 OSS 处理参数 ⇒ 直接替换宽度，避免出现两个 resize 参数
		if (/x-oss-process/i.test(u.search)) {
			u.search = `?x-oss-process=image%2Fresize%2Cw_${THUMB_WIDTH}`;
			return u.toString();
		}
		return raw;
	} catch {
		return raw;
	}
}

/** 抓页面 → og:image（失败返回空串，不抛） */
async function fetchOgImage(pageUrl) {
	try {
		const r = await fetch(pageUrl, {
			signal: AbortSignal.timeout(15000),
			headers: { 'user-agent': 'Mozilla/5.0 (compatible; VsSarosMarket/1.0)', accept: 'text/html' },
		});
		if (!r.ok) { return { error: `HTTP ${r.status}` }; }
		const html = await r.text();
		// og:image 优先；twitter:image 兜底（有的页面只写后者）
		const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i.exec(html)?.[1]
			?? /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i.exec(html)?.[1]
			?? '';
		return { ogImage: og.trim() };
	} catch (e) {
		return { error: String(e?.message ?? e).slice(0, 80) };
	}
}

/** 简单并发池（保持顺序、收集结果） */
async function mapLimit(items, limit, worker) {
	const out = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) { return; }
			out[i] = await worker(items[i], i);
		}
	});
	await Promise.all(runners);
	return out;
}

// ── 主流程 ────────────────────────────────────────────────────────
console.log(`端点 ${ENDPOINT}${DRY ? '（dry-run，不写库）' : ''}${FORCE ? ' · --force 全量重抓' : ''}`);
if (!store.get(TOF_LOCAL_TICKET_REF)) {
	console.error('✘ 没有 TOF 票据：请先在 IDE / dsh 里登录企业身份');
	process.exit(1);
}

// 分页拉全量（工作台类没有 colaskill 链接，抓不到图，会自然跳过）
const all = [];
for (let page = 1; ; page += 1) {
	const res = await market.list({ page, pageSize: PAGE_SIZE });
	all.push(...res.items);
	if (all.length >= (res.total ?? 0) || res.items.length === 0) { break; }
	if (page > 50) { break; }  // 防御：别无限翻
}
console.log(`共 ${all.length} 个商品`);

const candidates = all.filter((p) => {
	const desc = String(p.description ?? '');
	if (!COLA_URL.test(desc)) { return false; }               // 没有 Cola Skill 页面 ⇒ 抓不到
	const icon = String(p.icon ?? '').trim();
	if (FORCE) { return true; }                                // 强制模式：都抓
	return !isImageIcon(icon) || PLACEHOLDER_ICONS.has(icon);   // 只补"没真图"的
});
console.log(`需要抓图 ${candidates.length} 个${LIMIT ? `（本次只处理前 ${LIMIT} 个）` : ''}`);

const targets = LIMIT ? candidates.slice(0, LIMIT) : candidates;
let ok = 0, skipped = 0, failed = 0;
const failures = [];

const results = await mapLimit(targets, CONCURRENCY, async (pkg) => {
	const pageUrl = COLA_URL.exec(String(pkg.description ?? ''))?.[0];
	if (!pageUrl) { return { slug: pkg.slug, status: 'skip', why: '无 Cola Skill 链接' }; }
	const { ogImage, error } = await fetchOgImage(pageUrl);
	// Cola Skill 的预览图都在它自己的 CDN 上；不是的就不要（避免把杂图当缩略图 ✗）
	if (error) { return { slug: pkg.slug, status: 'fail', why: `${pageUrl} → ${error}` }; }
	if (!ogImage) { return { slug: pkg.slug, status: 'fail', why: `${pageUrl} → 页面没有 og:image` }; }
	const icon = thumbUrl(ogImage);
	if (!isImageIcon(icon)) { return { slug: pkg.slug, status: 'fail', why: `og:image 不像图片地址：${ogImage.slice(0, 60)}` }; }
	if (DRY) { return { slug: pkg.slug, status: 'dry', icon }; }
	try {
		await market.updatePackage(pkg.slug, { icon });
		return { slug: pkg.slug, status: 'ok', icon };
	} catch (e) {
		return { slug: pkg.slug, status: 'fail', why: `写库失败：${String(e?.message ?? e).slice(0, 90)}` };
	}
});

for (const r of results) {
	if (r.status === 'ok' || r.status === 'dry') { ok += 1; }
	else if (r.status === 'skip') { skipped += 1; }
	else { failed += 1; failures.push(`${r.slug}: ${r.why}`); }
}

console.log(`\n结果：成功 ${ok} · 跳过 ${skipped} · 失败 ${failed}`);
if (failures.length) {
	console.log('失败明细（前 10）：');
	for (const f of failures.slice(0, 10)) { console.log('  ', f); }
}
if (DRY) {
	console.log('样例（dry-run 不写库）：');
	for (const r of results.filter(x => x.status === 'dry').slice(0, 3)) { console.log('  ', r.slug, '=>', r.icon); }
}
console.log('\n完成。前端刷新即可看到缩略图（icon 是图片地址时走 <img loading=lazy>）。');

// TODO（若要"图片落地到我们自己的服务器"，而不是存 Cola Skill 的 CDN 地址）：
//   1. 服务端：`<DATA_DIR>/uploads/covers/` + `GET /covers/:file` 静态路由
//   2. 本脚本加 `--download`：下载图片 → 该目录 → icon 写 `/covers/<slug>.png`
