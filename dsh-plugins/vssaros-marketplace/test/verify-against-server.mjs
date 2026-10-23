#!/usr/bin/env node
// @vssaros/dsh-marketplace — **真机端到端**验证（连一个真实商城服务端跑全链）
//
// ⚠ 这是**手动跑**的验收脚本，**不进** `check:dsh-plugins`（它需要一个在跑的服务端）。
//   其余守卫用假 HTTP（不联网）；本脚本的价值恰恰是**证明假 HTTP 与真实契约一致** ✓
//
// 它验证的是「dsh 侧自持」这条链在**真服务端**上的行为：
//   登录换 JWT → list → publish（打包上传）→ list 能看到 → install（下载解包落盘 + sha256）
//   → 升级 → uninstall → deleteVersion → deletePackage
//
// 用法：
//   1. 起一个服务端（隔离数据，别用线上）：
//        PORT=3043 DATA_DIR=./.e2e-data MARKETPLACE_REVIEW_REQUIRED=0 node dist/server.js
//   2. 跑本脚本：
//        MARKET_BASE=http://127.0.0.1:3043 MARKET_USER=admin MARKET_PASS=<密码> \
//        node dsh-plugins/vssaros-marketplace/test/verify-against-server.mjs
//
// 说明：dsh 侧的 `marketClient` 只走「TOF 票据 → JWT」那条路；本脚本用服务端的
//   用户名/密码登录拿 JWT，然后**预置**到假 credentials 的 `VSSAROS_MARKET_JWT` 里
//   ⇒ 跳过 TOF 那一步（那一步依赖企业网关，本地验证没有）✓ 其余全走真实代码路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');

// 用真源：foundation 绑定（dataRootOf 走它）
const foundationMod = await import(pathToFileURL(path.join(LIB, 'foundationRef.js')).href);
const { createMarketClient, MARKET_JWT_REF } = await import(pathToFileURL(path.join(LIB, 'marketClient.js')).href);
const { packTarGzFromMap } = await import(pathToFileURL(path.join(LIB, 'tar.js')).href);
const { installBundle, uninstallBundle } = await import(pathToFileURL(path.join(LIB, 'installers.js')).href);
const { publishVersion, deletePackage, deleteVersion } = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);
const { readInstalled, upsertInstalled, removeInstalled } = await import(pathToFileURL(path.join(LIB, 'installedLedger.js')).href);

const BASE = (process.env.MARKET_BASE ?? '').replace(/\/+$/, '');
const USER = process.env.MARKET_USER ?? '';
const PASS = process.env.MARKET_PASS ?? '';
if (!BASE || !USER || !PASS) {
	console.error('需要 MARKET_BASE / MARKET_USER / MARKET_PASS（见文件头用法）');
	process.exit(2);
}

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

const slug = `e2e-skill-${Date.now()}`;
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-e2e-'));
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

console.log(`★ 真机端到端（服务端 ${BASE}）\n`);

// ── 0. 登录拿 JWT（服务端用户名/密码通道；只为本地验证绕开 TOF 网关）──────
const loginResp = await fetch(`${BASE}/api/v1/auth/login`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ username: USER, password: PASS }),
});
const loginText = await loginResp.text();
if (!loginResp.ok) {
	console.error(`登录失败（HTTP ${loginResp.status}）：${loginText.slice(0, 200)}`);
	process.exit(1);
}
const token = JSON.parse(loginText).token;
check('0. 服务端登录拿到 JWT', typeof token === 'string' && token.length > 20);

/** 假 credentials：预置 JWT ⇒ 其余全走真实 client ✓ */
const creds = {
	resolve: async (ref) => (ref === MARKET_JWT_REF ? { value: token } : undefined),
	set: async () => { },
	unset: async () => { },
};
const market = createMarketClient({ credentials: creds, config: { marketEndpoint: BASE }, log: () => { } });

// ── 1. 列表（真实 HTTP）──────────────────────────────────────────
{
	const res = await market.list({ kind: 'skill', pageSize: 5 });
	check('1. list 走真实服务端（kind=skill 能查）', Array.isArray(res.items) && typeof res.total === 'number', JSON.stringify(res).slice(0, 120));
}

// ── 2. 造本地资源并发布（打包 → 上传）────────────────────────────
{
	const dir = path.join(dataRoot, 'skills', slug);
	fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: 端到端验证技能\n---\n\n正文\n`);
	fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');

	const pub = await publishVersion({ market, dataRoot, kind: 'skill', localId: slug, version: '1.0.0', changelog: 'e2e 首发' });
	check('2. publish 成功（服务端接受了我们打的包）', pub.ok === true && pub.version === '1.0.0', JSON.stringify(pub));
	check('2. 首次发布 ⇒ created=true（建包了）', pub.created === true);
}

// ── 3. 列表/详情能看到刚发的包 + manifest 通过服务端校验 ──────────
{
	const res = await market.list({ kind: 'skill', q: slug, pageSize: 10 });
	const found = res.items.find(p => p.slug === slug);
	check('3. 刚发布的包能查到（说明 manifest.id===slug 通过校验）', Boolean(found), JSON.stringify(res.items.map(p => p.slug)));
	const detail = await market.detail(slug);
	const latest = (detail.versions ?? []).find(v => v.is_latest === true);
	check('3. 详情有版本且带 sha256', Boolean(latest?.version) && typeof latest.sha256 === 'string' && latest.sha256.length === 64);
	check('3. 包内 manifest 的 kind 被服务端认可', detail.kind === 'skill', detail.kind);

	// ── 4. 下载 + 解包 + 落盘（**卸掉本地目录**后重装，确保真的来自服务端）──
	fs.rmSync(path.join(dataRoot, 'skills', slug), { recursive: true, force: true });
	const gz = await market.download(`/packages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(latest.version)}/download`);
	check('4. 下载到 tar.gz（非空）', Buffer.isBuffer(gz) && gz.length > 100, `${gz.length} bytes`);
	const installed = await installBundle({ dataRoot, kind: 'skill', storeId: slug, version: latest.version, gzBuffer: gz });
	const md = fs.readFileSync(path.join(installed.targetDir, 'SKILL.md'), 'utf8');
	check('4. 落盘成功且 frontmatter 回写了 storeId/version', md.includes(`storeId: ${slug}`) && md.includes('version: 1.0.0'), md.split('\n').slice(0, 6).join(' | '));
	check('4. 子目录文件也在', fs.existsSync(path.join(installed.targetDir, 'scripts', 'run.sh')));
	await upsertInstalled(dataRoot, { kind: 'skill', storeId: slug, version: latest.version });
	check('4. 台账记了一笔', (await readInstalled(dataRoot)).some(e => e.storeId === slug));

	// ── 5. 升级：改内容 → 发 1.1.0 → 装上升级 ──────────────────
	fs.writeFileSync(path.join(dataRoot, 'skills', slug, 'SKILL.md'), `---\nname: ${slug}\ndescription: 端到端验证技能\n---\n\n正文 v2\n`);
	const pub2 = await publishVersion({ market, dataRoot, kind: 'skill', localId: slug, version: '1.1.0', changelog: 'e2e 升级' });
	check('5. 同包再发版本 ⇒ created=false（走"已有包"分支）', pub2.created === false);
	const up = await market.checkUpgrades([{ kind: 'skill', storeId: slug, version: '1.0.0' }]);
	check('5. 升级检查能发现 1.1.0', up.some(u => u.storeId === slug), JSON.stringify(up).slice(0, 160));
	const gz2 = await market.download(`/packages/${encodeURIComponent(slug)}/versions/1.1.0/download`);
	const upgraded = await installBundle({ dataRoot, kind: 'skill', storeId: slug, version: '1.1.0', gzBuffer: gz2, upgrade: true });
	check('5. upgrade 覆盖成功且**备份了旧目录**', fs.readFileSync(path.join(upgraded.targetDir, 'SKILL.md'), 'utf8').includes('正文 v2') && Boolean(upgraded.backup));
	await upsertInstalled(dataRoot, { kind: 'skill', storeId: slug, version: '1.1.0' });

	// ── 6. 卸载 ────────────────────────────────────────────────
	await uninstallBundle({ dataRoot, kind: 'skill', storeId: slug });
	await removeInstalled(dataRoot, 'skill', slug);
	check('6. 卸载删目录 + 清台账', !fs.existsSync(path.join(dataRoot, 'skills', slug)) && (await readInstalled(dataRoot)).length === 0);

	// ── 7. 下架版本 / 下架整个包 ────────────────────────────────
	const dv = await deleteVersion({ market, slug, version: '1.0.0' });
	check('7. 下架旧版本成功', dv.ok === true);
	const dp = await deletePackage({ market, slug });
	check('7. 下架整个包成功', dp.ok === true);
	const after = await market.list({ kind: 'skill', q: slug, pageSize: 10 });
	check('7. 下架后列表里查不到了', !after.items.some(p => p.slug === slug), JSON.stringify(after.items.map(p => p.slug)));
}

// ── 8. 真实服务端的错误路径（details 要能带出来）──────────────────
{
	let msg = '';
	try { await market.list({ kind: 'not-a-kind' }); } catch (e) { msg = String(e.message ?? e); }
	check('8. 非法 kind ⇒ 错误文案带服务端 details（能看出哪个参数不对）',
		msg.includes('参数校验失败') && /kind/.test(msg), msg.slice(0, 160));
}

// ── 9. agent：真服务端 → dsh 侧安装（★ 2026-10-22 晚搬过来的能力）──────
//   ⚠ dsh 侧**暂不支持发布 agent bundle**（`PUBLISHABLE_KINDS` 不含 agent：IDE 侧安装器
//     只认 agent.json，dsh 的目录镜像它装不了）⇒ 这里用**服务端 raw 上传**模拟
//     "别人用 IDE 发布的 agent 包"，验证 dsh 侧**装得对**（这才是本轮搬的东西）。
{
	const agentSlug = `e2e-agent-${Date.now().toString().slice(-6)}`;
	// ★ 2026-10-22 晚：agent **发布也搬到 dsh 侧了** ⇒ 这里是完整闭环：
	//   本机 agent 目录 → publishVersion（目录镜像打包）→ 服务端 → 下载 → installBundle 落盘
	// ⚠ 发布源与安装目标必须**分开**两个数据根：同一个目录既有 `.agent.md` 又要往里装
	//   会撞"已装过"的保护 ✗（真机上也不会是同一个人做这两步）
	const publishRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-pubroot-'));
	const agentDir = path.join(publishRoot, 'agents', agentSlug);
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, '.agent.md'), `---\nid: ${agentSlug}\nname: E2E 演示 Agent\ntools:\n  - read\n---\n\n你是端到端验证用的 agent\n`);
	const pub = await publishVersion({
		market, dataRoot: publishRoot, kind: 'agent', localId: agentSlug, version: '1.0.0', changelog: 'e2e',
		meta: { name: 'E2E 演示 Agent', description: '端到端验证' },
	});
	check('9. dsh 侧能发布 agent（目录镜像）', pub.ok === true && pub.version === '1.0.0', JSON.stringify(pub));
	const uploaded = { version: pub.version };
	fs.rmSync(publishRoot, { recursive: true, force: true });

	// 下载回来（模拟 dsh 侧安装的第一步），再落盘
	const buf = await market.download(`/packages/${encodeURIComponent(agentSlug)}/versions/${encodeURIComponent(uploaded.version)}/download`);
	const res = await installBundle({
		dataRoot, kind: 'agent', storeId: agentSlug, version: uploaded.version, gzBuffer: buf,
	});
	const mdPath = path.join(res.targetDir, '.agent.md');
	check('9. agent 装到 <数据根>/agents/<id>/.agent.md',
		res.targetDir === path.join(dataRoot, 'agents', agentSlug) && fs.existsSync(mdPath), res.targetDir);
	// 本次走的是**目录镜像**（dsh 侧发布格式）⇒ 验证 frontmatter 与正文都完整落地。
	// （另一种格式——IDE 的 `agent.json` + `files.agentsMd`——在 installer 套件的 ⑨ 组单测覆盖 ✓）
	const installedMd = fs.readFileSync(mdPath, 'utf8');
	check('9. 目录镜像的 .agent.md 原样落地（frontmatter + 正文都在）',
		installedMd.includes(`id: ${agentSlug}`) && installedMd.includes('你是端到端验证用的 agent'));
	check('9. 包里的临时文件（agent.json/manifest.json）不落盘',
		!fs.existsSync(path.join(res.targetDir, 'agent.json'))
		&& !fs.existsSync(path.join(res.targetDir, 'manifest.json')));

	// 卸载
	await uninstallBundle({ dataRoot, kind: 'agent', storeId: agentSlug });
	check('9. agent 能卸载', !fs.existsSync(res.targetDir));
	try { await market.request('DELETE', `/admin/packages/${encodeURIComponent(agentSlug)}`); } catch { /* ignore */ }
}

fs.rmSync(dataRoot, { recursive: true, force: true });
console.log(`\n[marketplace e2e] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
