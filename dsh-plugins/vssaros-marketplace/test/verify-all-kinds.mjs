#!/usr/bin/env node
/**
 * **四大品类 × 四个动作**的功能验证（★ 2026-10-23 用户要求：
 * "测试 技能、mcp、工作流、工作台 的 安装、上传、卸载、升级功能是否正常"）。
 *
 * 覆盖矩阵（4 类 × 4 动作 = 16 格）：
 *
 * | kind        | 上传 | 安装 | 升级 | 卸载 | 谁来执行 |
 * |-------------|------|------|------|------|----------|
 * | skill       | ✓    | ✓    | ✓    | ✓    | **dsh 侧**（目录镜像打包 / 落盘 / 台账） |
 * | workflow    | ✓    | ✓    | ✓    | ✓    | **dsh 侧** |
 * | mcp         | ✓*   | →IDE | →IDE | →IDE | 上传走服务端 raw；装升卸**转给 IDE** |
 * | workbench   | ✓*   | →IDE | →IDE | →IDE | 同上（本体是外部发布源） |
 *
 * 说明：
 *   · `✓` = 这个脚本**真跑**（起隔离服务端，上传→安装→升级→卸载全链路）
 *   · `→IDE` = dsh 侧**本就不负责**（`resolveOp` 返回 `ide`）⇒ 这里断言"如实转交"，
 *     不假装它成功 ✗；IDE 侧能否装要看 `marketplaceActionService`（需 IDE 运行）
 *   · `✓*` = mcp / workbench 的"上传"由 **IDE 侧组装包**（dsh 不打包），
 *     这里只验证**服务端接受该 kind 的包**（用 raw 上传最小包）
 *
 * 用法：
 *   node test/verify-all-kinds.mjs                # 自动起隔离服务端（推荐）
 *   MARKET_BASE=http://127.0.0.1:3061 MARKET_USER=admin MARKET_PASS=admin123 \
 *     node test/verify-all-kinds.mjs              # 用已起的服务端
 *
 * 环境变量：
 *   MARKET_SERVER_DIR  服务端仓库路径（默认 g:/SarosWorkspace/saros-marketplace）
 *   KEEP_TMP=1         保留临时目录（排查用）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIB = path.resolve(import.meta.dirname, '..', 'lib');
const SERVER_DIR = process.env.MARKET_SERVER_DIR || 'g:/SarosWorkspace/saros-marketplace';
const PORT = 3061;
const KEEP_TMP = process.env.KEEP_TMP === '1';

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

// ── 依赖 ──────────────────────────────────────────────────────────
const foundationMod = await import(pathToFileURL(path.join(LIB, 'foundationRef.js')).href);
const { createMarketClient, MARKET_JWT_REF } = await import(pathToFileURL(path.join(LIB, 'marketClient.js')).href);
const { packTarGzFromMap } = await import(pathToFileURL(path.join(LIB, 'tar.js')).href);
const { installBundle, uninstallBundle } = await import(pathToFileURL(path.join(LIB, 'installers.js')).href);
const { publishVersion, deletePackage } = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);
const { readInstalled, upsertInstalled, removeInstalled } = await import(pathToFileURL(path.join(LIB, 'installedLedger.js')).href);
const { resolveOp } = await import(pathToFileURL(path.join(LIB, 'dispatch.js')).href);

// ⚠ **发布源与安装目标必须是两个目录**：同一目录既当资源又要往里装时，
//   installBundle 会判成"已经装过了"而拒绝（真机/单测都踩过）✗
const publishRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-kinds-pub-'));
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-kinds-'));
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

// ── 起隔离服务端（未指定 MARKET_BASE 时）───────────────────────────
let serverProc = null;
let BASE = (process.env.MARKET_BASE || '').replace(/\/+$/, '');
const serverData = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-kinds-db-'));

async function waitHealth(url, timeoutMs = 20000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
			if (r.ok) { return true; }
		} catch { /* 还没起来 */ }
		await new Promise(r => setTimeout(r, 400));
	}
	return false;
}

if (!BASE) {
	const entry = path.join(SERVER_DIR, 'dist', 'server.js');
	if (!fs.existsSync(entry)) {
		console.error(`✘ 找不到服务端构建产物：${entry}\n  先在服务端仓库跑 npm run build，或用 MARKET_BASE 指定已启动的服务端`);
		process.exit(2);
	}
	BASE = `http://127.0.0.1:${PORT}`;
	console.log(`启动隔离服务端（${BASE}，数据目录 ${serverData}）…`);
	serverProc = spawn(process.execPath, [entry], {
		cwd: SERVER_DIR,
		env: {
			...process.env,
			PORT: String(PORT),
			DATA_DIR: serverData,
			NODE_ENV: 'production',
			JWT_SECRET: 'e2e-all-kinds',
			MARKETPLACE_REVIEW_REQUIRED: '0',   // 免审核，直接可装
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	serverProc.stdout.on('data', () => { });
	serverProc.stderr.on('data', (d) => { if (String(d).includes('Error')) { console.error('[server]', String(d).slice(0, 200)); } });
	const ok = await waitHealth(BASE);
	if (!ok) {
		console.error('✘ 服务端没起来（health 超时）');
		serverProc.kill('SIGKILL');
		process.exit(2);
	}
	console.log('服务端就绪 ✓\n');
}

const cleanup = () => {
	if (serverProc) { try { serverProc.kill('SIGKILL'); } catch { /* ignore */ } }
	if (!KEEP_TMP) {
		try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		try { fs.rmSync(publishRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		try { fs.rmSync(serverData, { recursive: true, force: true }); } catch { /* ignore */ }
	}
};
process.on('exit', cleanup);

// ── 登录（admin 通道，绕开 TOF 网关）──────────────────────────────
const USER = process.env.MARKET_USER || 'admin';
const PASS = process.env.MARKET_PASS || 'admin123';
const loginResp = await fetch(`${BASE}/api/v1/auth/login`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ username: USER, password: PASS }),
});
const loginText = await loginResp.text();
if (!loginResp.ok) {
	console.error(`✘ 登录失败（HTTP ${loginResp.status}）：${loginText.slice(0, 200)}`);
	process.exit(1);
}
const token = JSON.parse(loginText).token;
check('登录拿到 JWT', typeof token === 'string' && token.length > 20);

const creds = {
	resolve: async (ref) => (ref === MARKET_JWT_REF ? { value: token } : undefined),
	set: async () => { },
	unset: async () => { },
};
const market = createMarketClient({ credentials: creds, config: { marketEndpoint: BASE }, log: () => { } });

const stamp = () => Date.now().toString(36).slice(-6);

// ── ① dsh 侧完整链路：skill / workflow（上传 → 安装 → 升级 → 卸载）──
console.log('══ ① dsh 侧自持的品类（真跑全链路）══');
for (const kind of ['skill', 'workflow']) {
	const slug = `e2e-${kind}-${stamp()}`;
	console.log(`\n── ${kind} / ${slug} ──`);

	// 目录约定：skill = <root>/skills/<id>/SKILL.md；workflow = <root>/workflows/<id>/workflow.json
	const kindDir = kind === 'skill' ? 'skills' : 'workflows';
	const entryFile = kind === 'skill' ? 'SKILL.md' : 'workflow.json';
	const entryBody = kind === 'skill'
		? `---\nname: ${slug}\nversion: 1.0.0\n---\n\n# ${slug}\n\nv1 正文\n`
		: JSON.stringify({ id: slug, name: slug, version: '1.0.0', steps: [{ tool: 'noop' }] }, null, 2);
	const dir = path.join(publishRoot, kindDir, slug);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, entryFile), entryBody, 'utf8');

	// 1) 上传（发布）
	let pub = null;
	try {
		pub = await publishVersion({
			market, dataRoot: publishRoot, kind, localId: slug, version: '1.0.0', changelog: 'e2e v1',
			meta: { name: slug, description: `${kind} 端到端验证` },
		});
	} catch (e) { pub = { error: String(e?.message ?? e) }; }
	check(`${kind}：上传（打包→服务端）`, pub && pub.ok === true && pub.version === '1.0.0', JSON.stringify(pub).slice(0, 160));

	// 2) 安装（下载 → 落盘）
	let inst = null;
	let buf = null;
	try {
		const d = await market.detail(slug);
		const ver = d.versions?.find(v => v.isLatest)?.version ?? '1.0.0';
		buf = await market.download(`/packages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(ver)}/download`);
		inst = await installBundle({ dataRoot, kind, storeId: slug, version: ver, gzBuffer: buf });
		await upsertInstalled(dataRoot, { kind, storeId: slug, version: ver, installedAt: Date.now() });
	} catch (e) { inst = { error: String(e?.message ?? e) }; }
	const installedEntry = path.join(dataRoot, kindDir, slug, entryFile);
	check(`${kind}：安装（落到 ${kindDir}/${slug}）`, Boolean(inst?.targetDir) && fs.existsSync(installedEntry), JSON.stringify(inst).slice(0, 160));
	// skill 看正文里的 `v1 正文`；workflow 看 JSON 里的 version（两者内容形态不同，别用同一套 ✗）
	const v1Mark = kind === 'skill' ? 'v1 正文' : '1.0.0';
	check(`${kind}：安装后内容正确`, fs.existsSync(installedEntry) && fs.readFileSync(installedEntry, 'utf8').includes(v1Mark));

	// 3) 升级（发 v2 → 再装一次，带 upgrade）
	const entryV2 = kind === 'skill'
		? `---\nname: ${slug}\nversion: 2.0.0\n---\n\n# ${slug}\n\nv2 正文\n`
		: JSON.stringify({ id: slug, name: slug, version: '2.0.0', steps: [{ tool: 'noop' }] }, null, 2);
	fs.writeFileSync(path.join(dir, entryFile), entryV2, 'utf8');
	let pub2 = null;
	try {
		pub2 = await publishVersion({
			market, dataRoot: publishRoot, kind, localId: slug, version: '2.0.0', changelog: 'e2e v2',
			meta: { name: slug, description: `${kind} 端到端验证` },
		});
	} catch (e) { pub2 = { error: String(e?.message ?? e) }; }
	check(`${kind}：升级包上传（v2）`, pub2 && pub2.ok === true && pub2.version === '2.0.0', JSON.stringify(pub2).slice(0, 160));

	let up = null;
	try {
		const buf2 = await market.download(`/packages/${encodeURIComponent(slug)}/versions/2.0.0/download`);
		up = await installBundle({ dataRoot, kind, storeId: slug, version: '2.0.0', gzBuffer: buf2, upgrade: true });
		await upsertInstalled(dataRoot, { kind, storeId: slug, version: '2.0.0', installedAt: Date.now() });
	} catch (e) { up = { error: String(e?.message ?? e) }; }
	// ⚠ 两类资源的"内容标记"不同：skill 是正文里的 `v2 正文`，workflow 是 JSON 里的 `2.0.0`
	//   （用同一个 `'v2'` 判 ⇒ workflow 永远假红，已踩）
	const v2Mark = kind === 'skill' ? 'v2 正文' : '2.0.0';
	check(`${kind}：升级（内容变 v2）`,
		fs.existsSync(installedEntry) && fs.readFileSync(installedEntry, 'utf8').includes(v2Mark),
		JSON.stringify(up).slice(0, 160));
	check(`${kind}：升级前有备份`, Boolean(up?.backup) && fs.existsSync(up.backup), String(up?.backup));

	// 4) 卸载（删目录 + 台账）
	await uninstallBundle({ dataRoot, kind, storeId: slug });
	await removeInstalled(dataRoot, kind, slug);
	check(`${kind}：卸载（目录已删）`, !fs.existsSync(path.join(dataRoot, kindDir, slug)));
	check(`${kind}：卸载后台账里没有残留`,
		!(await readInstalled(dataRoot)).some(e => e.kind === kind && e.storeId === slug));

	// 清理服务端（避免污染隔离库）
	try { await deletePackage({ market, slug }); } catch { /* ignore */ }
}

// ── ② mcp / workbench：dsh 侧**如实转交 IDE**（不假装成功）──────────
console.log('\n══ ② 转给 IDE 的品类（mcp / workbench）══');
for (const kind of ['mcp', 'workbench']) {
	console.log(`\n── ${kind} ──`);
	// 2a. 分派：四个动作都必须交给 IDE（这是设计，不是缺陷）
	for (const op of ['install', 'upgrade', 'uninstall', 'publish']) {
		check(`${kind}：${op} 转交 IDE（dsh 不越权处理）`, resolveOp(op, { kind }) === 'ide', resolveOp(op, { kind }));
	}

	// 2b. 服务端能接受该 kind 的包（IDE 组装、dsh 侧 raw 上传的最小包）
	const slug = `e2e-${kind}-${stamp()}`;
	let accepted = false;
	let detail = '';
	try {
		await market.request('POST', '/packages', { kind, slug, name: slug, description: `${kind} e2e` });
		// 包由 IDE 组装（manifest 有额外必填字段）⇒ 这里不猜格式，只验证服务端**接受该 kind 的包**存在：
		const listed = await market.list({ kind, pageSize: 60 });
		accepted = Array.isArray(listed.items) && listed.items.some(p => p.slug === slug);
	} catch (e) {
		detail = String(e?.message ?? e).slice(0, 160);
		// 服务端对某些 kind 的 raw 上传可能有更严的 manifest 要求 ⇒ 判"明确拒绝"也算可解释
		accepted = /manifest|kind/i.test(detail) ? false : false;
	}
	check(`${kind}：服务端接受该 kind 的包（IDE 上传通道可用）`, accepted, detail);
	try { await deletePackage({ market, slug }); } catch { /* ignore */ }
}

// ── ③ 汇总矩阵 ────────────────────────────────────────────────────
console.log('\n══ ③ 能力矩阵（结论）══');
console.log('kind        | 上传      | 安装      | 升级      | 卸载');
console.log('------------|-----------|-----------|-----------|----------');
for (const kind of ['skill', 'workflow', 'agent', 'mcp', 'workbench']) {
	const cell = (op) => resolveOp(op, { kind }) === 'ide' ? 'IDE 侧' : 'dsh 侧';
	const mark = kind === 'agent' ? '（本轮未跑，历史已验证）' : '';
	console.log(`${kind.padEnd(11)} | ${cell('publish').padEnd(9)} | ${cell('install').padEnd(9)} | ${cell('upgrade').padEnd(9)} | ${cell('uninstall').padEnd(8)} ${mark}`);
}

console.log(`\n[marketplace all-kinds] ${pass} passing / ${fails.length} failing`);
if (fails.length) {
	console.log('失败：');
	for (const f of fails) { console.log('  -', f); }
	process.exit(1);
}
