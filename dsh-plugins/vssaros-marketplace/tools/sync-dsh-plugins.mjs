#!/usr/bin/env node
/**
 * 把 **dsh 插件市场**（设置 → 插件市场）的目录爬进自营商城（★ 2026-10-24 用户需求）。
 *
 * ## 数据源（查证过程）
 * 「设置 → 插件市场」= `@vssaros/dsh-market` 模块，它**自己不维护目录**，
 * 读策展注册表（`src/vs/sessions/contrib/agentStudio/browser/dshMarketCatalog.ts`）：
 * **`https://awesome-dsh-plugin.com/plugins.json`** ⇒ `{ plugins: [...] }`
 *
 * 实测 **6704 条**，字段：
 * ```
 * name        'dsh-j-space'              包名（⚠ 会撞车：`dsh-memory` 有 13 个不同作者）
 * owner       'AnonyJcy'
 * url         https://github.com/<owner>/<repo>    兜底安装源
 * page        目录详情页
 * npm         npm 包名（**首选安装源**，3445 条有）
 * version     版本（与 npm 同时存在，3445 条有）
 * category    24 种（agi/ui/theme/model/memory/tools/...）
 * description **{ en, zh } 多语言对象**（⚠ 直接 String() 会变成 `[object Object]`）
 * capabilities 声明能力（fs-read / fs-write / env …，5181 条有）
 * stars / downloads / install / added …
 * ```
 * ⚠ **目录里没有 logo 字段** ⇒ 商城用 emoji + 稳定渐变兜底（不伪造缩略图）。
 *
 * ## slug 规则
 * `owner-name` 规范化（**实测 0 撞车**；`name` 单独用会撞 328 个）。
 * 超 64 字符（服务端上限，实测 4 条最多 71）⇒ 截断并加 4 位 hash 保唯一。
 *
 * ## 用法
 * ```bash
 * node tools/sync-dsh-plugins.mjs --dry --limit 5     # 先看
 * node tools/sync-dsh-plugins.mjs --limit 100         # 小批量
 * node tools/sync-dsh-plugins.mjs                     # 全量 6704（慢，建议后台跑）
 * ```
 * 幂等：已存在 ⇒ 跳过发版本，但顺带修正文案。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const LIB = path.resolve(HERE, '..', 'lib');
const ENDPOINT = (process.env.MARKET_ENDPOINT || 'http://21.6.92.5:3040').replace(/\/+$/, '');
const CATALOG_URL = process.env.PLUGIN_CATALOG || 'https://awesome-dsh-plugin.com/plugins.json';
const CONCURRENCY = 5;

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const LIMIT = (() => {
	const i = argv.indexOf('--limit');
	if (i < 0) { return 0; }
	const n = Number(argv[i + 1]);
	return Number.isFinite(n) && n > 0 ? n : 0;
})();

const {
	createMarketClient, TOF_LOCAL_TICKET_REF, TOF_IDENTITY_REF,
} = await import(pathToFileURL(path.join(LIB, 'marketClient.js')).href);
const { publishDistribution } = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);

// ── 凭据（嵌套 YAML：票据在 `refs:` 下，正则不能加行首锚点）──────────────
function loadTofCredentials() {
	const file = path.join(os.homedir(), '.vssaros-dev', 'dsh-home', '.credentials.yaml');
	const store = new Map();
	if (!fs.existsSync(file)) { return store; }
	const text = fs.readFileSync(file, 'utf8');
	const grab = (key) => {
		const m = new RegExp(key + '[ \\t]*:[ \\t]*(.+)$', 'm').exec(text);
		return m ? m[1].trim().replace(/^['"]/, '').replace(/['"]$/, '') : undefined;
	};
	const ticket = grab('VSSAROS_TOF_TICKET_DSH');
	const identity = grab('VSSAROS_TOF_IDENTITY_DSH');
	if (ticket) { store.set(TOF_LOCAL_TICKET_REF, ticket); }
	if (identity) { store.set(TOF_IDENTITY_REF, identity); }
	return store;
}

const kv = loadTofCredentials();
const market = createMarketClient({
	credentials: {
		resolve: async (ref) => (kv.has(ref) ? { value: kv.get(ref) } : undefined),
		set: async (ref, value) => { kv.set(ref, value); },
		unset: async (ref) => { kv.delete(ref); },
	},
	config: { marketEndpoint: ENDPOINT },
	log: () => {},
});

// ── 文案归一（`description` 是 `{en, zh}` 对象）──────────────────────
/** 中文优先，再 en/default，最后第一个非空字符串。 */
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

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

/**
 * slug：`owner-name`；超 64 截断 + 4 位 hash（服务端上限 64，实测有 71 的）。
 * `name` 单独用会撞车（328 个，如 `dsh-memory` 有 13 个作者）⇒ 必须带 owner。
 */
function slugOf(entry) {
	const raw = norm(`${entry.owner}-${entry.name}`);
	if (raw.length <= 64) { return raw; }
	const h = createHash('sha1').update(raw).digest('hex').slice(0, 4);
	return `${raw.slice(0, 59).replace(/-$/, '')}-${h}`;
}

/** 目录条目 → 商城条目（映射不了返回 `{ skip }`）。 */
function toEntry(p) {
	const slug = slugOf(p);
	if (!slug) { return { skip: '算不出 slug' }; }
	const repoPath = /github\.com\/([^/\s]+\/[^/\s?#]+)/i.exec(String(p.url ?? ''))?.[1]?.replace(/\.git$/i, '') ?? '';
	// 安装源：**npm 优先**（与 dsh-market 自己的策略一致），否则 github-source
	let distribution;
	if (p.npm) { distribution = { type: 'npm', name: String(p.npm) }; }
	else if (repoPath) { distribution = { type: 'github-source', name: repoPath }; }
	else { return { skip: '既没有 npm 也没有 github 地址' }; }

	const zh = pickText(p.description);
	const caps = Array.isArray(p.capabilities) ? p.capabilities.map(c => String(c)).filter(Boolean) : [];
	// 描述里带上能力声明（装之前该让用户看见 —— 目录的 `capabilityRedLines` 就是这个用意）
	const desc = [zh, caps.length ? `能力：${caps.join('、')}` : ''].filter(Boolean).join('\n\n').slice(0, 1500);

	return {
		slug,
		name: String(p.name ?? slug).slice(0, 128),
		distribution,
		version: String(p.version ?? '1.0.0').trim() || '1.0.0',
		description: desc,
		category: p.category ? String(p.category) : 'plugin',
		owner: String(p.owner ?? ''),
		page: p.page ? String(p.page) : '',
	};
}

// ── 主流程 ──────────────────────────────────────────────────────
async function main() {
	console.log(`目录: ${CATALOG_URL}`);
	console.log(`目标商城: ${ENDPOINT}`);

	const r = await fetch(CATALOG_URL, { headers: { accept: 'application/json', 'user-agent': 'VsSarosMarket/1.0' }, signal: AbortSignal.timeout(30000) });
	if (!r.ok) { throw new Error(`拉目录失败 HTTP ${r.status}`); }
	const raw = await r.json();
	const plugins = raw?.plugins;
	if (!Array.isArray(plugins)) { throw new Error('目录格式不认识（缺 plugins 数组）'); }
	console.log(`目录共 ${plugins.length} 个插件`);

	const all = [];
	for (const p of plugins) {
		const e = toEntry(p);
		if (e.skip) { continue; }
		all.push(e);
	}
	const seen = new Set();
	const entries = all.filter(e => (seen.has(e.slug) ? false : (seen.add(e.slug), true)));
	console.log(`可同步 ${entries.length}（去重后；npm 源 ${entries.filter(e => e.distribution.type === 'npm').length}）`);

	const targets = LIMIT ? entries.slice(0, LIMIT) : entries;
	if (!DRY) {
		await market.login();
		console.log('已登录');
	}
	console.log(`本次处理 ${targets.length} 个${DRY ? '【dry-run】' : ''}\n`);

	let created = 0;
	let skipped = 0;
	let failed = 0;
	const failures = [];

	let idx = 0;
	const started = Date.now();
	await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
		while (idx < targets.length) {
			const e = targets[idx];
			idx += 1;
			const meta = {
				name: e.name,
				...(e.description ? { description: e.description } : {}),
				category: e.category,
			};
			if (DRY) {
				if (created < 8) {
					console.log(`  [dry] ${e.slug.padEnd(38)} ${e.version.padEnd(10)} ${e.distribution.type}:${e.distribution.name}`);
				}
				created += 1;
				continue;
			}
			try {
				await publishDistribution({
					market, kind: 'plugin', localId: e.slug, version: e.version,
					distribution: e.distribution,
					changelog: `来自 dsh 插件市场${e.owner ? `（${e.owner}）` : ''}`,
					meta,
				});
				created += 1;
			} catch (err) {
				const msg = String(err?.message ?? err);
				if (/已存在|已被占用|HTTP 409|重复/.test(msg)) {
					skipped += 1;
					try {
						await market.updatePackage(e.slug, {
							name: meta.name,
							...(meta.description ? { description: meta.description } : {}),
							category: meta.category,
						});
					} catch { /* 修不了不影响结论 */ }
				} else {
					failed += 1;
					failures.push(`${e.slug}: ${msg.slice(0, 90)}`);
				}
			}
			if ((created + skipped + failed) % 200 === 0) {
				process.stdout.write(`\r  进度 ${created + skipped + failed}/${targets.length}`);
			}
		}
	}));

	const secs = Math.round((Date.now() - started) / 1000);
	console.log('');
	if (DRY) { console.log(`【dry-run】会处理 ${created} 个`); return; }
	console.log(`新增 ${created} · 已存在 ${skipped} · 失败 ${failed}（耗时 ${secs}s）`);
	if (failures.length) {
		console.log('失败明细（前 12 条）：');
		failures.slice(0, 12).forEach(f => console.log('  -', f));
	}
}

await main();
