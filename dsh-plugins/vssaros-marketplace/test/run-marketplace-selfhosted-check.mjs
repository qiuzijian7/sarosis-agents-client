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

const { createMarketClient, describeMarketError, TOF_LOCAL_TICKET_REF, TOF_SYNCED_TICKET_REF, TOF_IDENTITY_REF, MARKET_JWT_REF } =
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
	const creds = fakeCredentials({ [TOF_LOCAL_TICKET_REF]: 'local-ticket' });
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
	const creds = fakeCredentials({ [TOF_LOCAL_TICKET_REF]: 't1' });
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
	const creds = fakeCredentials({ [TOF_LOCAL_TICKET_REF]: 't2', [MARKET_JWT_REF]: 'expired' });
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

// ── ③b 403 **不许**走重登（真机踩过：管理员接口的 403 被报成"没有 TOF 票据" ✗）──
{
	const creds = fakeCredentials({ [TOF_LOCAL_TICKET_REF]: 't', [MARKET_JWT_REF]: 'valid-jwt' });
	const f = fakeFetch((entry) => {
		if (entry.url.includes('/auth/tof')) { return { body: { token: 'new' } }; }
		return { status: 403, body: { error: '需要管理员权限' } };
	});
	const m = createMarketClient({ credentials: creds, config: { marketEndpoint: 'http://x' }, fetchImpl: f });
	let msg = '';
	try { await m.reviewList(); } catch (e) { msg = String(e.message ?? e); }
	check('403 直接抛出原文案（含"管理员"），不掩盖成登录问题', msg.includes('管理员'), msg);
	check('403 **不触发重登**（换票解决不了权限不足）',
		f.calls.filter(c => c.url.includes('/auth/tof')).length === 0,
		`实际换票 ${f.calls.filter(c => c.url.includes('/auth/tof')).length} 次`);
	// 401 仍然要重登（票据过期是常态）
	const creds2 = fakeCredentials({ [TOF_LOCAL_TICKET_REF]: 't2', [MARKET_JWT_REF]: 'expired' });
	let n = 0;
	const f2 = fakeFetch((entry) => {
		if (entry.url.includes('/auth/tof')) { n++; return { body: { token: `fresh-${n}` } }; }
		if (entry.headers.authorization === 'Bearer expired') { return { status: 401, body: { error: '过期' } }; }
		return { body: { items: [], total: 0 } };
	});
	const m2b = createMarketClient({ credentials: creds2, config: { marketEndpoint: 'http://x' }, fetchImpl: f2 });
	await m2b.reviewList();
	check('401 仍然自动重登一次（票据过期要续上）', n === 1, `实际 ${n} 次`);
}

// ── ④ 服务端 details 必须出现在错误文案里 ─────────────────────────
{
	const msg = describeMarketError(400, JSON.stringify({
		error: '参数校验失败',
		details: [{ path: ['kind'], message: "Invalid enum value. Expected 'agent' | 'skill'" }],
	}));
	check('错误文案带上 details 的 路径+消息', msg.includes('参数校验失败') && msg.includes('kind') && msg.includes('Invalid enum value'), msg);
	check('非 JSON body 不炸（退回 HTTP 状态）', describeMarketError(500, '<html>oops</html>').includes('500'));

	const creds = fakeCredentials({ [TOF_LOCAL_TICKET_REF]: 't3' });
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
	// ⚠ 断言"**至少包含** list/detail/installed"，而不是写死整行 ——
	//   后来加新 op（如 `publishables`）时不该让这条守卫假红 ✓
	// ★ 2026-10-23：`LOCAL_OPS` 已并入 `dispatch.js` 的 `LOCAL_READ_OPS`（单一真源）。
	//   这里改成验证**分派结果**，而不是某个变量名 —— 后者一改名就假红 ✗
	const { resolveOp } = await import(pathToFileURL(path.join(LIB, 'dispatch.js')).href);
	check('只读面（list/detail/installed）由 dispatch 判为 local-read',
		['list', 'detail', 'installed'].every(op => resolveOp(op, {}) === 'local-read'));
	check('路由改用 resolveOp 分派，本地分支走 runLocalByTarget',
		/resolveOp\(op, params\)/.test(idx) && /runLocalByTarget\(target, op, params\)/.test(idx));
	// callIde 的函数体里不许再出现 list/detail/installed 的分支
	const bodyStart = idx.indexOf('async function callIde(');
	const bodyEnd = idx.indexOf('/** 页面外壳', bodyStart) > 0 ? idx.indexOf('/** 页面外壳', bodyStart) : idx.length;
	const callIdeBody = idx.slice(bodyStart, bodyEnd);
	check('callIde 里不再处理 list/detail/installed（否则等于又搬回 IDE）',
		!/['"](list|detail|installed)['"]/.test(callIdeBody), callIdeBody.slice(0, 160));
}

// ── agent 重扫：**可选**注入（★ 2026-10-22 晚）────────────────────
//   `vssaros-agents` 的 syncPresets 只在激活时跑一次 ⇒ 装完 agent 要重启才成 preset。
//   marketplace 侧预留了调用点：对方 provide 了就即时生效，没 provide 就如实报"要重启"。
//   ⚠ 必须是**回调式可选 inject**：静态 inject 缺服务会让插件永久 pending ✗（历史事故）
{
	const idxSrc = fs.readFileSync(path.resolve(HERE, '..', 'lib', 'index.js'), 'utf8');
	check('agent 重扫用**可选**注入（缺服务不能让插件 pending）',
		idxSrc.includes("ctx.inject(['vssarosAgents']") && idxSrc.includes('typeof scope.vssarosAgents?.rescan'));
	check('重扫服务不在 ⇒ 返回 restart（不假装即时生效）',
		/let agentsRescan = 'restart'/.test(idxSrc) && /restartRequired: agentsRescan !== 'ok'/.test(idxSrc));
	check('重扫失败也如实回报（不吞成成功）',
		/agentsRescan = `failed: \$\{String\(e\?\.message/.test(idxSrc));
}

// ── 票据来源：**两张都要试**（2026-10-23 真机踩到的登录失败）──────────────
//   症状：IDE 里明明已登录，商城一直报「TOF 票据无效或已过期」。
//   根因：`tofTicket()` 用 `??` 只做**存在性**回退 —— 本地票据**存在但过期**时，
//        永远不会去试 IDE 同步的那张 ✗
{
	// 7a2. ★ 有 TOF 服务时**只问服务**（单一真源），不再自己读两份凭据拼优先级
	{
		const creds = fakeCredentials({
			[TOF_LOCAL_TICKET_REF]: 'stale-local',
			[TOF_SYNCED_TICKET_REF]: 'fresh-synced',
		});
		const tried = [];
		const f = fakeFetch((entry) => {
			if (!entry.url.includes('/auth/tof')) { return { body: { items: [], total: 0 } }; }
			tried.push(JSON.parse(entry.body).ticket);
			return { body: { token: 'jwt-from-service' } };
		});
		let providerCalls = 0;
		const m = createMarketClient({
			credentials: creds,
			config: { marketEndpoint: 'http://x' },
			fetchImpl: f,
			// 服务说"该用 IDE 那张" ⇒ 本插件就照用，**不自己判优先级** ✓
			tofProvider: async () => { providerCalls++; return { ticket: 'fresh-synced', source: 'ide' }; },
		});
		await m.login();
		check('有 TOF 服务时**只向服务要票据**（一次调用，不再自己拼优先级）',
			providerCalls === 1 && tried.length === 1 && tried[0] === 'fresh-synced',
			`provider ${providerCalls} 次；试过 ${tried.join(',')}`);
		const src = await m.tofTicketSources();
		check('self-check 标明票据来自 TOF 服务（而不是"本地/同步"两路）',
			src.length === 1 && src[0].source.includes('TOF 服务'), JSON.stringify(src));
	}

	// 7a3. TOF 服务在但回答"没有票据" ⇒ **不猜**（不去翻凭据，直接报要登录）
	{
		const creds = fakeCredentials({ [TOF_SYNCED_TICKET_REF]: 'still-there' });
		const f = fakeFetch(() => ({ body: { token: 'should-not-be-used' } }));
		const m = createMarketClient({
			credentials: creds,
			config: { marketEndpoint: 'http://x' },
			fetchImpl: f,
			tofProvider: async () => ({ ticket: undefined, source: 'none' }),
		});
		let msg = '';
		try { await m.login(); } catch (e) { msg = String(e.message ?? e); }
		check('TOF 服务答"没有票据" ⇒ 直接提示登录（**不偷偷用凭据里的旧票**）',
			msg.includes('没有 TOF 票据') && f.calls.length === 0, `${msg} | 请求 ${f.calls.length} 次`);
	}

	// 7a4. ★ 真机定位到的登录失败根因：身份字段是**驼峰**（dsh 的 projectUser 输出 loginName），
	//      此前读 `login_name` ⇒ 永远 undefined ⇒ 服务端 fallback（`if (!tofUser && loginName)`）
	//      永远进不去 ⇒ 网关 whoami 一失败就直接 401「且无 fallback 用户信息」✗
	{
		const creds = fakeCredentials({
			[TOF_LOCAL_TICKET_REF]: 't',
			[TOF_IDENTITY_REF]: JSON.stringify({ signedIn: true, loginName: 'zijianqiu', staffId: '161765', isAdmin: false }),
		});
		let sent = null;
		const f = fakeFetch((entry) => {
			if (entry.url.includes('/auth/tof')) { sent = JSON.parse(entry.body); return { body: { token: 'jwt' } }; }
			return { body: { items: [], total: 0 } };
		});
		const m = createMarketClient({ credentials: creds, config: { marketEndpoint: 'http://x' }, fetchImpl: f });
		await m.login();
		check('身份是驼峰时，登录请求体带 loginName / staffId（否则服务端 fallback 永不生效）',
			sent && sent.loginName === 'zijianqiu' && sent.staffId === '161765' && sent.isAdmin === false,
			JSON.stringify(sent));
	}

	// 7a5. 下划线形态也要认（老数据兼容，别为了洁癖删掉）
	{
		const creds = fakeCredentials({
			[TOF_LOCAL_TICKET_REF]: 't',
			[TOF_IDENTITY_REF]: JSON.stringify({ login_name: 'legacy', staff_id: '9' }),
		});
		let sent = null;
		const f = fakeFetch((entry) => {
			if (entry.url.includes('/auth/tof')) { sent = JSON.parse(entry.body); return { body: { token: 'jwt' } }; }
			return { body: { items: [], total: 0 } };
		});
		const m = createMarketClient({ credentials: creds, config: { marketEndpoint: 'http://x' }, fetchImpl: f });
		await m.login();
		check('老数据（下划线 login_name/staff_id）也兼容', sent && sent.loginName === 'legacy' && sent.staffId === '9', JSON.stringify(sent));
	}

	// 7b. 票据过期 ⇒ 报错要说清来源 + **给可执行的重登指引**
	{
		const creds2 = fakeCredentials({ [TOF_LOCAL_TICKET_REF]: 'expired', [TOF_SYNCED_TICKET_REF]: 'legacy-unused' });
		const f2 = fakeFetch(() => ({ status: 401, body: { error: 'TOF 票据无效或已过期' } }));
		const m2 = createMarketClient({ credentials: creds2, config: { marketEndpoint: 'http://x' }, fetchImpl: f2 });
		let msg = '';
		try { await m2.login(); } catch (e) { msg = String(e.message ?? e); }
		check('票据过期 ⇒ 报错含来源 + 「重新登录」指引', msg.includes('dsh 登录的票据') && /重新登录/.test(msg), msg);
		// ★ 2026-10-23（用户「不该有多个」）：**不再读 IDE 同步那份**（已废弃路线）
		check('**不再读取已废弃的 `VSSAROS_TOF_TICKET`**（IDE 同步那份）',
			!f2.calls.some(c => c.body && String(c.body).includes('legacy-unused')),
			`请求体里出现了旧票：${f2.calls.map(c => c.body).join('|')}`);
	}
}

// ── 输出形状：list / detail / reviewList / installed 必须**同一份口径** ────
//   背景：这三处曾各自手写一遍 pkg → 前端映射 ⇒ 加字段时漏一处就是
//   "列表有、详情没有"这类静默不一致 ✗（真踩过：detail 忘了 visibility ⇒ 编辑表单把可见性重置）
{
	const shape = await import(pathToFileURL(path.join(LIB, 'shape.js')).href);
	const { toPackageSummary, toPackageDetail, toInstalledItem } = shape;

	// 列表形态（服务端 list 返回）
	const listPkg = {
		id: 'p1', kind: 'skill', slug: 'demo', name: '演示',
		latest_version: '2.1.0', description: '介绍', author_name: '张三',
		category: '宣发', icon: '🚀', tags: ['a', 'b'], status: 'active',
		distribution_type: 'github-source', distribution_meta: { type: 'github-source', name: 'o/r' },
		permissions: { canInstall: true },
	};
	const summary = toPackageSummary(listPkg);
	check('形状：列表把 latest_version 映射成 version', summary.version === '2.1.0');
	check('形状：列表带上 category/icon/tags/distribution',
		summary.category === '宣发' && summary.icon === '🚀'
		&& summary.tags.length === 2 && summary.distributionType === 'github-source');

	// 详情形态（服务端 detail 返回：作者在 author 对象里、可能只有 version）
	// ⚠ 用**与 list 相同的输入**造，才能验证"公共字段一致"这条（输入不同输出当然不同）
	const detailPkg = {
		...listPkg,
		// detail 接口没有 latest_version，只有 version（真实差异）
		latest_version: undefined,
		version: '2.1.0',
		author_name: undefined,
		author: { display_name: '张三', username: 'zhangsan' },
		visibility: 'private', featured: true,
		// 注意：服务端在 `routes.ts` 里已把 `is_latest` 转成**布尔**
		//（`is_latest: Boolean(v.is_latest)`）⇒ 这里按真实契约造 `true` 而不是 1
		versions: [{ id: 'v1', version: '2.1.0', changelog: 'x', sha256: 'abc', asset_size: 100, is_latest: true, manifest: { a: 1 } }],
	};
	const detail = toPackageDetail(detailPkg);

	// ★ 最关键的一条：公共字段必须**逐字一致**（这是抽出 shape.js 的全部意义）
	const PUBLIC_KEYS = ['id', 'kind', 'slug', 'name', 'version', 'description', 'author',
		'category', 'icon', 'tags', 'status', 'distributionType', 'distribution', 'permissions'];
	const diffs = PUBLIC_KEYS.filter(k => JSON.stringify(summary[k]) !== JSON.stringify(detail[k]));
	check('形状：**list 与 detail 的公共字段完全一致**（改一处不会漏另一处）',
		diffs.length === 0, diffs.map(k => `${k}: ${JSON.stringify(summary[k])} vs ${JSON.stringify(detail[k])}`).join('; '));

	check('形状：详情能从 author 对象里取到作者（列表用 author_name）', detail.author === '张三', detail.author);
	check('形状：详情带 visibility / featured（编辑表单回显要用）',
		detail.visibility === 'private' && detail.featured === true);
	check('形状：版本列表字段映射（asset_size→size、is_latest→isLatest）',
		detail.versions[0].size === 100 && detail.versions[0].isLatest === true
		&& detail.versions[0].manifest?.a === 1);

	// 缺省值：服务端少给字段时不能出 undefined（前端会显示 "undefined"）
	const bare = toPackageSummary({ id: 'x', kind: 'mcp', slug: 'x', name: 'x' });
	check('形状：缺字段时给安全的空值（不出现 undefined）',
		bare.version === '' && bare.description === '' && bare.author === ''
		&& Array.isArray(bare.tags) && bare.status === 'active' && bare.distributionType === 'bundle');
	check('形状：tags 非数组时归一成空数组', toPackageSummary({ tags: 'not-an-array' }).tags.length === 0);

	// 审核队列：默认状态不同（几乎都是待审），且带 featured/pendingSince
	const review = toPackageSummary({ id: 'r', kind: 'skill', slug: 'r', name: 'r' }, { review: true });
	check('形状：审核队列默认 status = pending_review（列表默认 active）',
		review.status === 'pending_review' && summary.status === 'active');
	check('形状：审核队列带 featured / pendingSince',
		review.featured === false && review.pendingSince === null);

	// 已安装项（本地台账，没有服务端 pkg）
	const inst = toInstalledItem({ kind: 'skill', storeId: 'demo', version: '1.0.0', installedAt: 123 }, '2.0.0');
	check('形状：已安装项标记可升级', inst.upgradable === true && inst.latestVersion === '2.0.0');
	const instNo = toInstalledItem({ kind: 'skill', storeId: 'demo', version: '2.0.0' }, '');
	check('形状：没有新版本时 upgradable = false', instNo.upgradable === false && instNo.latestVersion === '');
}


console.log(`\n[marketplace self-hosted] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
