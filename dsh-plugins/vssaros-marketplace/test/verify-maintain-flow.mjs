#!/usr/bin/env node
// @vssaros/dsh-marketplace — **维护链**端到端验证（手动跑；需要真服务端）
//
// 验证「可维护」这条链在真服务端上的行为：
//   ① 分页：pageSize=2 时 page=1/2 各回 2 条、total 是总数（此前页面固定 60 条 ⇒ 500+ 条看不到 ✗）
//   ② 编辑元数据：改名 / 介绍 / 分类 / 图标 / 可见性 都生效，且**未传的字段保持不变**
//   ③ 可见性 private 生效：别人看不到、自己能看到
//   ④ 非作者调 updatePackage ⇒ 403（服务端 assertAuthor 判权）
//
// 用法：
//   PORT=3046 DATA_DIR=./.e2e4 MARKETPLACE_REVIEW_REQUIRED=0 node dist/server.js
//   MARKET_BASE=http://127.0.0.1:3046 node dsh-plugins/vssaros-marketplace/test/verify-maintain-flow.mjs
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

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-maintain-'));
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

async function clientOf(username, password) {
	const resp = await fetch(`${BASE}/api/v1/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	const text = await resp.text();
	if (!resp.ok) { throw new Error(`登录 ${username} 失败：${resp.status} ${text.slice(0, 140)}`); }
	const token = JSON.parse(text).token;
	return createMarketClient({
		credentials: {
			resolve: async (ref) => (ref === MARKET_JWT_REF ? { value: token } : undefined),
			set: async () => { },
			unset: async () => { },
		},
		config: { marketEndpoint: BASE },
		log: () => { },
	});
}

console.log(`★ 维护链端到端（服务端 ${BASE}）\n`);

const stamp = Date.now().toString().slice(-8);
const owner = await clientOf('admin', process.env.ADMIN_PASS ?? 'admin123');
const other = await (async () => {
	const uname = `maintuser${stamp}`;
	const r = await fetch(`${BASE}/api/v1/auth/register`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username: uname, email: `${uname}@example.com`, password: 'maintpass123' }),
	});
	check('0. 第二个普通用户注册', r.ok, String(r.status));
	return clientOf(uname, 'maintpass123');
})();

// 发 3 个包（分页用例需要 ≥3 条）
const slugs = [`maint-a-${stamp}`, `maint-b-${stamp}`, `maint-c-${stamp}`];
for (const slug of slugs) {
	const dir = path.join(dataRoot, 'skills', slug);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: 维护链验证\n---\n\n正文\n`);
	await publishVersion({ market: owner, dataRoot, kind: 'skill', localId: slug, version: '1.0.0' });
}

// ── ① 分页 ────────────────────────────────────────────────────
{
	const p1 = await owner.list({ kind: 'skill', q: stamp, pageSize: 2, page: 1 });
	const p2 = await owner.list({ kind: 'skill', q: stamp, pageSize: 2, page: 2 });
	check('① 第一页回 2 条', p1.items.length === 2, `${p1.items.length}`);
	check('① total 是**总数**（不是本页条数）', p1.total === 3, `total=${p1.total}`);
	check('① 第二页回剩下的 1 条且与第一页不重复',
		p2.items.length === 1 && !p1.items.some(a => p2.items.some(b => b.slug === a.slug)),
		`p2=${JSON.stringify(p2.items.map(i => i.slug))}`);
}

// ── ② 编辑元数据：改动生效 + 未传字段不变 ─────────────────────
{
	const slug = slugs[0];
	const before = await owner.detail(slug);
	const updated = await owner.updatePackage(slug, {
		name: '改过的名字',
		description: '改过的介绍',
		category: '测试分类',
		icon: '🧪',
	});
	check('② 改名生效', updated?.name === '改过的名字', updated?.name);
	check('② 改介绍生效', updated?.description === '改过的介绍');
	check('② 改分类/图标生效', updated?.category === '测试分类' && updated?.icon === '🧪');
	check('② **未传的字段保持不变**（visible 仍是 public）', updated?.visibility === (before.visibility ?? 'public'), `${updated?.visibility} vs ${before.visibility}`);
	// 只改一个字段
	const onlyIcon = await owner.updatePackage(slug, { icon: '🔥' });
	check('② 只传一个字段 ⇒ 其它字段不被清空',
		onlyIcon?.icon === '🔥' && onlyIcon?.name === '改过的名字' && onlyIcon?.description === '改过的介绍',
		JSON.stringify({ icon: onlyIcon?.icon, name: onlyIcon?.name, desc: onlyIcon?.description }));
}

// ── ③ 可见性 private 生效 ─────────────────────────────────────
{
	const slug = slugs[1];
	await owner.updatePackage(slug, { visibility: 'private' });
	const mine = await owner.detail(slug);
	check('③ 作者能看到自己的 private 包', mine?.visibility === 'private');
	let otherErr = '';
	try { await other.detail(slug); } catch (e) { otherErr = String(e.message ?? e); }
	check('③ 别人看不到 private 包（403/404）', /无权|不存在/.test(otherErr), otherErr || '(没报错!)');
	const otherList = await other.list({ kind: 'skill', q: stamp, pageSize: 20 });
	check('③ private 包不出现在别人的列表里', !otherList.items.some(p => p.slug === slug),
		JSON.stringify(otherList.items.map(p => p.slug)));
}

// ── ④ 非作者（非管理员）改别人的包 ⇒ 403 ──────────────────────
{
	let msg = '';
	try { await other.updatePackage(slugs[2], { name: '我改别人的' }); } catch (e) { msg = String(e.message ?? e); }
	check('④ 非作者改别人的包 ⇒ 403（不静默成功）', /无权|admin|管理|作者/i.test(msg) && msg.length > 0, msg || '(没报错!)');
}

// 清理
for (const slug of slugs) {
	try { await owner.request('DELETE', `/admin/packages/${encodeURIComponent(slug)}`); } catch { /* ignore */ }
}
fs.rmSync(dataRoot, { recursive: true, force: true });
console.log(`\n[marketplace maintain] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
