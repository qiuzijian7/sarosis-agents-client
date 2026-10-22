#!/usr/bin/env node
// @vssaros/dsh-marketplace — **自持性**守卫（★ 2026-10-22 S1）
//
// 守的是什么：用户质疑「商城数据/逻辑都该在 dsh 侧，为什么要反向调用」后的架构修正
//   —— 只读面（认证 / list / detail / installed）必须**在 dsh 侧自己完成**，
//   **不经过 IDE 桥**（`ide.request`）。将来谁把它改回转发 ⇒ 本守卫变红 ✓。
//
// 做法：假 credentials（内存）+ 假 fetch（记录请求），**不联网、不启 Host**：
//   ① 票据优先级：本地自登 > IDE 同步
//   ② 首次请求会先换 JWT，之后复用
//   ③ 401 会**自动重登一次**再试（票据过期是常态）
//   ④ 服务端 zod 失败的 `details` **必须出现在错误文案里**（真机吃过这个亏）
//   ⑤ 台账读写（原子写 + 同 kind+storeId 覆盖 + 删除）
//   ⑥ **源码级断言**：`index.js` 里 `list/detail/installed` 必须走 `runLocal`，
//      不许再出现在 `callIde` 的路径上（防止"悄悄改回去"）
//
// 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-selfhosted-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const ROOT = path.resolve(HERE, '..', '..', '..');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

// foundation 要先绑定（marketClient 的 dataRootOf 经它取真源）
const foundationMod = await import(pathToFileURL(path.join(LIB, 'foundationRef.js')).href);
foundationMod.bindFoundation({
	dataRootOf: () => path.join(os.tmpdir(), 'vssaros-marketplace-selfcheck'),
	lockFileFor: (f) => `${f}.lock`,
	acquireFileLock: async () => async () => { },
	atomicWriteFile: async () => { },
	isPidAlive: () => false,
	escapeHtml: (s) => String(s),
	renderChips: () => '',
	renderShell: () => '',
	SHELL_CSS: '',
});

const { createMarketClient, describeMarketError, TOF_LOCAL_TICKET_REF, TOF_SYNCED_TICKET_REF, MARKET_JWT_REF } =
	await import(pathToFileURL(path.join(LIB, 'marketClient.js')).href);
const { readInstalled, upsertInstalled, removeInstalled } = await import(pathToFileURL(path.join(LIB, 'installedLedger.js')).href);

console.log('★ dsh 商城自持性守卫\n');

// ── 假 credentials（内存）────────────────────────────────────────
function fakeCredentials(initial = {}) {
	const store = new Map(Object.entries(initial));
	return {
		resolve: async (ref) => (store.has(ref) ? { value: store.get(ref) } : undefined),
		set: async (ref, value) => { store.set(ref, value); },
		unset: async (ref) => { store.delete(ref); },
		_store: store,
	};
}

// ── 假 fetch（记录请求，按剧本回）────────────────────────────────
function fakeFetch(handler) {
	const calls = [];
	const impl = async (url, init = {}) => {
		const entry = { url: String(url), method: init.method ?? 'GET', body: init.body, headers: init.headers ?? {} };
		calls.push(entry);
		const res = handler(entry);
		return {
			ok: (res.status ?? 200) < 400,
			status: res.status ?? 200,
			text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {})),
		};
	};
	impl.calls = calls;
	return impl;
}

// ── ① 票据优先级 ─────────────────────────────────────────────────
{
	const creds = fakeCredentials({ [TOF_LOCAL_TICKET_REF]: 'local-ticket', [TOF_SYNCED_TICKET_REF]: 'ide-ticket' });
	const m = createMarketClient({ credentials: creds, config: {}, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
	check('票据优先取 dsh 自登的那份（VSSAROS_TOF_TICKET_DSH）', (await m.tofTicket()) === 'local-ticket');

	const creds2 = fakeCredentials({ [TOF_SYNCED_TICKET_REF]: 'ide-ticket' });
	const m2 = createMarketClient({ credentials: creds2, config: {}, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
	check('只有 IDE 同步的票据时也能用（VSSAROS_TOF_TICKET）', (await m2.tofTicket()) === 'ide-ticket');

	const m3 = createMarketClient({ credentials: fakeCredentials(), config: {}, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
	check('没有票据时 tofTicket 返回 undefined（调用方如实报错）', (await m3.tofTicket()) === undefined);
}

// ── ② 首次请求先换 JWT，之后复用 ─────────────────────────────────
{
	const creds = fakeCredentials({ [TOF_SYNCED_TICKET_REF]: 't1' });
	const f = fakeFetch((entry) => {
		if (entry.url.includes('/auth/tof')) { return { body: { token: 'jwt-1' } }; }
		if (entry.url.includes('/packages')) { return { body: { items: [{ id: 'a', kind: 'skill', slug: 's1', name: 'S1' }], total: 1 } }; }
		return { status: 404, body: { error: 'nope' } };
	});
	const m = createMarketClient({ credentials: creds, config: { marketEndpoint: 'http://x' }, fetchImpl: f });
	const list1 = await m.list({});
	const list2 = await m.list({});
	check('list 能拿到数据', list1.total === 1 && list2.total === 1);
	const authCalls = f.calls.filter(c => c.url.includes('/auth/tof'));
	check('JWT 只换一次（之后复用，不重复登录）', authCalls.length === 1, `实际 ${authCalls.length} 次`);
	check('JWT 存进了 dsh 侧自己的 ref', creds._store.get(MARKET_JWT_REF) === 'jwt-1');
	const pkgCalls = f.calls.filter(c => c.url.includes('/packages'));
	check('业务请求带上了 Bearer', pkgCalls.length > 0 && /^Bearer jwt-1$/.test(pkgCalls[0].headers.authorization), JSON.stringify(pkgCalls[0]?.headers ?? {}));
}

// ── ③ 401 自动重登一次 ──────────────────────────────────────────
{
	const creds = fakeCredentials({ [TOF_SYNCED_TICKET_REF]: 't2', [MARKET_JWT_REF]: 'expired' });
	let n = 0;
	const f = fakeFetch((entry) => {
		if (entry.url.includes('/auth/tof')) { n++; return { body: { token: `fresh-${n}` } }; }
		const bearer = entry.headers.authorization;
		if (bearer === 'Bearer expired') { return { status: 401, body: { error: '登录已过期' } }; }
		return { body: { items: [], total: 0 } };
	});
	const m = createMarketClient({ credentials: creds, config: { marketEndpoint: 'http://x' }, fetchImpl: f });
	const res = await m.list({});
	check('401 后自动换票重试成功（不让用户手动重登）', res.total === 0 && f.calls.filter(c => c.url.includes('/auth/tof')).length === 1);
}

// ── ④ 服务端 details 必须出现在错误文案里 ─────────────────────────
{
	const msg = describeMarketError(400, JSON.stringify({
		error: '参数校验失败',
		details: [{ path: ['kind'], message: "Invalid enum value. Expected 'agent' | 'skill'" }],
	}));
	check('错误文案带上 details 的 路径+消息', msg.includes('参数校验失败') && msg.includes('kind') && msg.includes('Invalid enum value'), msg);
	check('非 JSON body 不炸（退回 HTTP 状态）', describeMarketError(500, '<html>oops</html>').includes('500'));

	const creds = fakeCredentials({ [TOF_SYNCED_TICKET_REF]: 't3' });
	const f = fakeFetch((entry) => {
		if (entry.url.includes('/auth/tof')) { return { body: { token: 'j' } }; }
		return { status: 400, body: { error: '参数校验失败', details: [{ path: ['kind'], message: 'bad kind' }] } };
	});
	const m = createMarketClient({ credentials: creds, config: { marketEndpoint: 'http://x' }, fetchImpl: f });
	let threw = '';
	try { await m.list({ kind: 'workbench' }); } catch (e) { threw = String(e.message ?? e); }
	check('list 失败时抛出带 details 的错误', threw.includes('workbench') === false && threw.includes('bad kind'), threw);
}

// ── ⑤ 台账读写 ──────────────────────────────────────────────────
{
	const dataRoot = path.join(os.tmpdir(), `vssaros-mp-ledger-${process.pid}-${Date.now()}`);
	const a = await upsertInstalled(dataRoot, { kind: 'skill', storeId: 's1', version: '1.0.0' });
	check('台账写入后可读回', a.length === 1 && a[0].storeId === 's1');
	const b = await upsertInstalled(dataRoot, { kind: 'skill', storeId: 's1', version: '1.1.0' });
	check('同 kind+storeId 覆盖（不重复）', b.length === 1 && b[0].version === '1.1.0');
	await upsertInstalled(dataRoot, { kind: 'workbench', storeId: 'w1', version: '0.1.0' });
	const c = await readInstalled(dataRoot);
	check('不同 kind 各存一条', c.length === 2);
	const d = await removeInstalled(dataRoot, 'skill', 's1');
	check('按 kind+storeId 删除', d.length === 1 && d[0].kind === 'workbench');
	// 坏文件不覆盖
	fs.writeFileSync(path.join(dataRoot, 'installed-packages.json'), '{not json');
	check('台账是坏 JSON 时读取返回空数组（不抛）', (await readInstalled(dataRoot)).length === 0);
	await upsertInstalled(dataRoot, { kind: 'skill', storeId: 's9', version: '1.0.0' });
	check('坏文件被一次成功写入修复（而不是继续坏着）', (await readInstalled(dataRoot)).length === 1);
	fs.rmSync(dataRoot, { recursive: true, force: true });
}

// ── ⑥ 源码级：只读 op 必须走 runLocal，不许回到 callIde ──────────
{
	const idx = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
	check('index.js 声明了 LOCAL_OPS（list/detail/installed）', /const LOCAL_OPS = new Set\(\['list', 'detail', 'installed'\]\)/.test(idx));
	check('路由里 LOCAL_OPS 优先走 runLocal', /if \(LOCAL_OPS\.has\(op\)\)[\s\S]{0,200}runLocal\(op, params\)/.test(idx));
	// callIde 的函数体里不许再出现 list/detail/installed 的分支
	const bodyStart = idx.indexOf('async function callIde(');
	const bodyEnd = idx.indexOf('/** 页面外壳', bodyStart) > 0 ? idx.indexOf('/** 页面外壳', bodyStart) : idx.length;
	const callIdeBody = idx.slice(bodyStart, bodyEnd);
	check('callIde 里不再处理 list/detail/installed（否则等于又搬回 IDE）',
		!/['"](list|detail|installed)['"]/.test(callIdeBody), callIdeBody.slice(0, 160));
}

console.log(`\n[marketplace self-hosted] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
