#!/usr/bin/env node
// @vssaros/dsh-marketplace — **GitHub 外部源**真服务端验收（手动跑）
//
// 验证「本体是一个 GitHub 地址」这条链在**真服务端**上成立：
//   ① 用 GitHub 地址发布（不打包、不上传本体）⇒ 服务端登记 distribution
//   ② 列表/详情能看到，且 `distributionType` 是 github-source（不是 bundle）
//   ③ 该版本**没有资产**（说明确实没传本体）
//   ④ 同一个包再发新版本（走 GitHub）能叠加
//   ⑤ 非法源被本地拒（不会打到服务端）
//
// ⚠ 不访问 GitHub 本体（CI/离线也能跑）：只验"登记与查询"这一段；
//   真正的下载/解包/定位根由 `run-marketplace-github-check.mjs`（假 fetch）+ 真机验证覆盖。
//
// 用法：
//   PORT=3051 DATA_DIR=./.e2e-gh MARKETPLACE_REVIEW_REQUIRED=0 node dist/server.js
//   MARKET_BASE=http://127.0.0.1:3051 node dsh-plugins/vssaros-marketplace/test/verify-github-source.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');

const foundationMod = await import(pathToFileURL(path.join(LIB, 'foundationRef.js')).href);
const { createMarketClient, MARKET_JWT_REF } = await import(pathToFileURL(path.join(LIB, 'marketClient.js')).href);
const { publishExternal } = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);

const BASE = (process.env.MARKET_BASE ?? '').replace(/\/+$/, '');
if (!BASE) { console.error('需要 MARKET_BASE（见文件头用法）'); process.exit(2); }

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-ghsv-'));
foundationMod.bindFoundation({
	dataRootOf: () => dataRoot,
	lockFileFor: (f) => `${f}.lock`,
	acquireFileLock: async () => async () => { },
	atomicWriteFile: async () => { },
	isPidAlive: () => false,
	escapeHtml: (s) => String(s),
	renderChips: () => '',
	renderShell: () => '',
	SHELL_CSS: '',
});

const resp = await fetch(`${BASE}/api/v1/auth/login`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ username: process.env.MARKET_USER ?? 'admin', password: process.env.MARKET_PASS ?? 'admin123' }),
});
const loginText = await resp.text();
if (!resp.ok) { console.error(`登录失败：${resp.status} ${loginText.slice(0, 160)}`); process.exit(2); }
const token = JSON.parse(loginText).token;
const market = createMarketClient({
	credentials: {
		resolve: async (ref) => (ref === MARKET_JWT_REF ? { value: token } : undefined),
		set: async () => { },
		unset: async () => { },
	},
	config: { marketEndpoint: BASE },
	log: () => { },
});

console.log(`★ GitHub 外部源 · 真服务端（${BASE}）\n`);
const stamp = Date.now().toString().slice(-8);
const slug = `gh-ext-${stamp}`;

// ── ① 用 GitHub 地址发布（skill）───────────────────────────────
{
	const r = await publishExternal({
		market,
		kind: 'skill',
		localId: slug,
		version: '1.0.0',
		source: 'https://github.com/LearnPrompt/ai-news-radar/tree/main',
		changelog: '外部源首发',
		meta: { name: 'AI 资讯雷达（GitHub 源）', description: '本体在 GitHub 上' },
	});
	check('① 用 GitHub 地址发布成功（不打包）', r.ok === true && r.external === true, JSON.stringify(r));
	check('① 服务端登记的是 github-source',
		r.distribution?.type === 'github-source' && r.distribution?.name === 'LearnPrompt/ai-news-radar',
		JSON.stringify(r.distribution));
	check('① 归一化出 commit（main）', r.distribution?.commit === 'main', String(r.distribution?.commit));
}

// ── ② 列表/详情能看到，且类型是 github-source ─────────────────
{
	const d = await market.detail(slug);
	check('② 详情能查到', d?.slug === slug, String(d?.slug));
	check('② 包级 distribution_type 是 github-source',
		d?.distribution_type === 'github-source', String(d?.distribution_type));

	const listed = await market.list({ kind: 'skill', q: slug, pageSize: 10 });
	check('② 列表里能看到', listed.items.some(p => p.slug === slug),
		JSON.stringify(listed.items.map(p => p.slug)));
}

// ── ③ 该版本**没有资产**（证明本体真没上传）───────────────────
{
	const d = await market.detail(slug);
	const v = (d?.versions ?? []).find(x => x.version === '1.0.0');
	check('③ 版本存在', Boolean(v), JSON.stringify(d?.versions?.map(x => x.version)));
	const size = Number(v?.asset_size ?? v?.size ?? 0);
	check('③ 版本没有资产体积（本体没上传，只有来源）', size === 0, `asset_size=${size}`);
	check('③ 版本的 manifest 里带 distribution',
		v?.manifest?.distribution?.type === 'github-source',
		JSON.stringify(v?.manifest?.distribution));
}

// ── ④ 再发一个 GitHub 版本（叠加）─────────────────────────────
{
	const r = await publishExternal({
		market, kind: 'skill', localId: slug, version: '1.1.0',
		source: 'LearnPrompt/ai-news-radar',   // 裸 owner/repo 也要认
	});
	check('④ 裸 owner/repo 也能发布', r.ok === true && r.distribution?.type === 'github-source');
	const d = await market.detail(slug);
	const versions = (d?.versions ?? []).map(x => x.version).sort();
	check('④ 两个版本都在', versions.includes('1.0.0') && versions.includes('1.1.0'), versions.join(','));
	check('④ created=false（包已存在，不是重复建）', r.created === false);
}

// ── ⑤ 非法源被**本地**拒（不浪费服务端请求）───────────────────
{
	let msg = '';
	try {
		await publishExternal({ market, kind: 'skill', localId: `${slug}-bad`, version: '1.0.0', source: 'https://evil.com/a/b' });
	} catch (e) { msg = String(e.message ?? e); }
	check('⑤ 非 GitHub 域 ⇒ 本地就拒', msg.includes('GitHub') || msg.includes('evil.com'), msg);

	const d = await market.list({ kind: 'skill', q: `${slug}-bad`, pageSize: 5 }).catch(() => ({ items: [] }));
	check('⑤ 被拒的包**没有**在服务端产生（失败不留下垃圾）',
		!(d?.items ?? []).some(p => p.slug === `${slug}-bad`));
}

// 清理（admin 强制下架）
try { await market.request('DELETE', `/admin/packages/${encodeURIComponent(slug)}`); } catch { /* ignore */ }
fs.rmSync(dataRoot, { recursive: true, force: true });
console.log(`\n[marketplace github-source e2e] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
