#!/usr/bin/env node
// @vssaros/dsh-marketplace — **审核链**端到端验证（手动跑；需要 MARKETPLACE_REVIEW_REQUIRED=1 的服务端）
//
// 验证的是「作者发布 → 进待审 → 管理员审核」这条链在**真服务端**上的行为，
// 以及 dsh 侧客户端（`marketClient` 的 reviewList / reviewSetStatus / reviewSetFeatured）是否对齐：
//   ① 普通用户发布 ⇒ status=pending_review（不公开）
//   ② 公开列表**看不到**待审的包（作者自己能看到）
//   ③ 非管理员调 /admin/review ⇒ 403（如实报，不静默空列表）
//   ④ 管理员 reviewList 能看到；通过 ⇒ status=active ⇒ 公开可见
//   ⑤ 推荐位开关生效
//   ⑥ 拒绝 ⇒ removed ⇒ 公开列表消失
//
// 用法：
//   PORT=3045 DATA_DIR=./.e2e3 MARKETPLACE_REVIEW_REQUIRED=1 node dist/server.js
//   MARKET_BASE=http://127.0.0.1:3045 node dsh-plugins/vssaros-marketplace/test/verify-review-flow.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');

const foundationMod = await import(pathToFileURL(path.join(LIB, 'foundationRef.js')).href);
const { createMarketClient, MARKET_JWT_REF } = await import(pathToFileURL(path.join(LIB, 'marketClient.js')).href);
const { publishVersion } = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);

const BASE = (process.env.MARKET_BASE ?? '').replace(/\/+$/, '');
if (!BASE) { console.error('需要 MARKET_BASE（见文件头用法）'); process.exit(2); }

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-review-'));
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

/** 用服务端账号登录拿 JWT，返回一个"预置 JWT"的 client（跳过 TOF 网关，其余全走真实代码）。 */
async function clientOf(username, password) {
	const resp = await fetch(`${BASE}/api/v1/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	const text = await resp.text();
	if (!resp.ok) { throw new Error(`登录 ${username} 失败（HTTP ${resp.status}）：${text.slice(0, 160)}`); }
	const token = JSON.parse(text).token;
	const creds = {
		resolve: async (ref) => (ref === MARKET_JWT_REF ? { value: token } : undefined),
		set: async () => { },
		unset: async () => { },
	};
	return createMarketClient({ credentials: creds, config: { marketEndpoint: BASE }, log: () => { } });
}

console.log(`★ 审核链端到端（服务端 ${BASE}，需开启审核）\n`);

const admin = await clientOf(process.env.ADMIN_USER ?? 'admin', process.env.ADMIN_PASS ?? 'admin123');
check('0. 管理员登录', true);

// 普通用户（注册一个，确保不是 admin）
const uname = `e2euser${Date.now().toString().slice(-8)}`;
const regResp = await fetch(`${BASE}/api/v1/auth/register`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ username: uname, email: `${uname}@example.com`, password: 'e2epass123' }),
});
check('0. 普通用户注册成功', regResp.ok, `${regResp.status} ${(await regResp.text()).slice(0, 120)}`);
const user = await clientOf(uname, 'e2epass123');

const slug = `e2e-review-${Date.now().toString().slice(-8)}`;

// ── ① 普通用户发布 ⇒ 待审 ──────────────────────────────────────
{
	const dir = path.join(dataRoot, 'skills', slug);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: 审核链验证\n---\n\n正文\n`);
	const pub = await publishVersion({ market: user, dataRoot, kind: 'skill', localId: slug, version: '1.0.0', changelog: '待审' });
	check('① 普通用户发布成功', pub.ok === true, JSON.stringify(pub));
	const detail = await user.detail(slug);
	check('① 发布后状态是 pending_review（不直接公开）', detail.status === 'pending_review', detail.status);
}

// ── ② 公开面看不到；作者用 scope=mine 看得到 ───────────────────
//   服务端 scope 语义：all = 只含 active（**正确设计**：待审不该出现在公开列表）；
//   mine = 我发布的（含 pending_review / private）⇒ 作者后台要用 mine 看 ✓
{
	const publicList = await admin.list({ kind: 'skill', q: slug, pageSize: 10 });   // scope=all
	const mineList = await user.list({ kind: 'skill', q: slug, scope: 'mine', pageSize: 10 });
	check('② 公开面（scope=all）**看不到**待审的包', !publicList.items.some(p => p.slug === slug),
		JSON.stringify(publicList.items.map(p => p.slug)));
	check('② 作者用 scope=mine 能看到自己的待审包',
		mineList.items.some(p => p.slug === slug && p.status === 'pending_review'),
		JSON.stringify(mineList.items.map(p => `${p.slug}:${p.status}`)));
}

// ── ③ 非管理员调 /admin/review ⇒ 403 ──────────────────────────
{
	let msg = '';
	try { await user.reviewList(); } catch (e) { msg = String(e.message ?? e); }
	check('③ 非管理员看审核队列 ⇒ 403 且文案可读（含"管理员"）', msg.includes('管理员'), msg);
}

// ── ④ 管理员审核队列 + 通过 ───────────────────────────────────
{
	const q = await admin.reviewList();
	check('④ 管理员能看到审核队列（含刚发的包）', q.items.some(p => p.slug === slug), JSON.stringify(q.items.map(p => p.slug)));
	await admin.reviewSetStatus(slug, 'active');
	const after = await admin.detail(slug);
	check('④ 通过后状态是 active', after.status === 'active', after.status);
	const pub2 = await user.list({ kind: 'skill', q: slug, pageSize: 10 });
	check('④ active 后普通用户列表能看到', pub2.items.some(p => p.slug === slug));
}

// ── ⑤ 推荐位 ─────────────────────────────────────────────────
{
	await admin.reviewSetFeatured(slug, true);
	const d1 = await admin.detail(slug);
	check('⑤ 设为推荐生效', d1.featured === true, String(d1.featured));
	await admin.reviewSetFeatured(slug, false);
	const d2 = await admin.detail(slug);
	check('⑤ 取消推荐生效', d2.featured === false, String(d2.featured));
}

// ── ⑥ 拒绝 ⇒ removed ─────────────────────────────────────────
{
	await admin.reviewSetStatus(slug, 'removed');
	let gone = false;
	try { await admin.detail(slug); } catch { gone = true; }
	check('⑥ 拒绝（removed）后详情查询 404（已下架）', gone);
}

// 清理（管理员强制删）
try { await admin.request('DELETE', `/admin/packages/${encodeURIComponent(slug)}`); } catch { /* 已下架 */ }
fs.rmSync(dataRoot, { recursive: true, force: true });
console.log(`\n[marketplace review] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
