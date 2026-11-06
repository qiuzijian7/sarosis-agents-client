#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * check-dsh-codebuddy.mjs — 守卫：CodeBuddy 模型 provider 的 **dsh 侧实现**（2026-10-22）。
 *
 * 背景：用户要求"codebuddy provider 改成 dsh 侧实现"⇒ 登录 / token 刷新 / 模型目录 / 路由写入从 IDE 扩展
 *   （extensions/codebuddy-provider）搬到 Host 插件 `vssaros-bridge/lib/codebuddy.js`。
 *
 * **行为断言为主**（假 fetch + 假凭据 + 假 settings ⇒ 不联网、不开浏览器）：
 *   ① 登录：state → 开浏览器（URL 原样）→ 轮询拿到 token ⇒ 两个凭据 ref 落盘、路由写进 llm-pi-ai；
 *   ② 复用本机 CodeBuddy 登录态（~/.codebuddy/local_storage，gzip+base64）⇒ **不开浏览器**；
 *   ③ 刷新：离过期 <5 分钟 ⇒ 刷新并换新 token；刷新 401 ⇒ 清登录态 + 撤路由；刷新 5xx ⇒ **保留**；
 *   ④ 目录：allow-list ∪ chat-capable（生图 / 补全小模型排除；hy4 那类"不在 allow-list"的补进来）；
 *      `data.models` 为空 ⇒ 撤路由（权威的空）；网络失败 ⇒ **保留**路由（一次超时不能让模型全消失）；
 *   ⑤ 画像与 IDE 侧（`buildProvidersSyncArgs` 对 codebuddy 源的产出）**同形**：路由名 / 凭据 ref / 身份头 / 模型形状；
 *   ⑥ 对外投影（status / HTTP / 桥回执）**绝不含 token**；
 *   ⑦ 迁移：dsh 侧没登录 ⇒ 导入 IDE 扩展的登录态；已登录 ⇒ 不覆盖；
 *   ⑧ providers.sync 对 dsh 自持路由**不碰**（不删、不改、不覆盖凭据）—— 源码级接线断言；
 *   ⑨ 跨层对账：路由名 / 凭据 ref 与 IDE 侧 `providerRouteFor('codebuddy')` / `credentialRefFor('codebuddy')` 逐字一致；
 *      桥方法名与协议枚举一致。
 *
 * 判据纪律：绝对期望值；采集面缺失直接失败；改完必须做**反向突变**。
 * 用法：node dsh-plugins/check-dsh-codebuddy.mjs
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const problems = [];
const ok = label => console.log(`  ✓ ${label}`);
const fail = msg => problems.push(msg);

function code(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}
function read(rel) {
	const full = join(repo, rel);
	if (!existsSync(full)) { fail(`文件不存在：${rel}（采集面失效 ⇒ 不能当通过）`); return ''; }
	return readFileSync(full, 'utf8');
}

const cbRel = 'dsh-plugins/vssaros-bridge/lib/codebuddy.js';
const ppRel = 'dsh-plugins/vssaros-bridge/lib/providerProfile.js';
const indexRel = 'dsh-plugins/vssaros-bridge/lib/index.js';
const pkgRel = 'dsh-plugins/vssaros-bridge/package.json';
const protoRel = 'src/vs/sessions/contrib/dshHarness/common/dshBridgeProtocol.ts';
const planRel = 'src/vs/sessions/contrib/dshHarness/common/dshProviderSyncPlan.ts';
const indexSrc = code(read(indexRel));
if (!read(cbRel) || !read(ppRel) || !indexSrc) {
	console.error('[check-dsh-codebuddy] ✗ 采集面缺失 —— 不能当通过');
	process.exit(1);
}
const cb = await import(pathToFileURL(join(repo, cbRel)).href);
const pp = await import(pathToFileURL(join(repo, ppRel)).href);

// ── 假件 ────────────────────────────────────────────────────────────────────
function fakeCredentials(initial = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		async resolve(ref) { const v = store.get(ref); return v === undefined ? undefined : { value: v, source: 'file' }; },
		async describe(ref) { return { configured: store.has(ref), writable: true }; },
		async set(ref, value) { store.set(ref, value); },
		async unset(ref) { store.delete(ref); },
	};
}
function fakeSettings(initialProviders = {}) {
	let doc = { providers: JSON.parse(JSON.stringify(initialProviders)) };
	let revision = 1;
	const mutations = [];
	return {
		mutations,
		get providers() { return doc.providers; },
		describe() { return [{ ns: 'llm-pi-ai', value: doc, revision }]; },
		async mutate(ns, ops, rev) {
			if (ns !== 'llm-pi-ai') { throw new Error(`unexpected ns ${ns}`); }
			if (rev !== revision) { const e = new Error('SETTINGS_CONFLICT'); e.code = 'SETTINGS_CONFLICT'; throw e; }
			mutations.push(ops);
			const next = JSON.parse(JSON.stringify(doc));
			for (const op of ops) {
				const [head, key] = op.path;
				if (head !== 'providers') { throw new Error(`unexpected path ${op.path}`); }
				if (op.op === 'set') {
					if (key === undefined) { next.providers = op.value; } else { next.providers[key] = op.value; }
				} else if (op.op === 'unset') {
					delete next.providers[key];
				}
			}
			doc = next;
			revision++;
		},
	};
}
function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function jwt(claims) { return `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`; }

/**
 * ★ 2026-11-02：OAuth access token 的落点从 `VSSAROS_CODEBUDDY_KEY` 改成**专用 ref**
 * `VSSAROS_CODEBUDDY_ACCESS_TOKEN`（产品 2026-10-30 改动）。
 *
 * 为什么：`VSSAROS_CODEBUDDY_KEY` 同时被 ① 本桥（OAuth token）与 ② IDE `providers.sync`（API Key）写
 * ⇒ 后写者赢 ⇒ Host 拿到 API Key ⇒ 平台对 `/v3/config` 拒答 ⇒ 模型数为 0。
 * `KEY` 仍是**路由的 `apiKeyEnv`**（pi-ai 从它读 key），所以下面 197/364/410 那几处刻意保持 `KEY`。
 */
const ACCESS_REF = 'VSSAROS_CODEBUDDY_ACCESS_TOKEN';

const TOKEN_A = jwt({ sub: 'user-123', iss: 'https://tencent.sso.codebuddy.cn/auth/realms/sso-tenantX', preferred_username: 'tester' });
const TOKEN_B = jwt({ sub: 'user-123', iss: 'https://tencent.sso.codebuddy.cn/auth/realms/sso-tenantX', v: 2 });
const REFRESH = 'REFRESH-TOKEN-0123456789';

const CONFIG_JSON = {
	code: 0,
	data: {
		agents: [{ name: 'craft', models: ['hy3', 'deepseek-v4', 'missing-meta'] }, { name: 'ask', models: ['x'] }],
		models: [
			{ id: 'hy3', name: 'Hunyuan 3', maxInputTokens: 128000, maxOutputTokens: 8192, supportsReasoning: true, reasoning: { effort: 'high' } },
			{ id: 'deepseek-v4', name: 'deepseek-v4', maxInputTokens: 128000, maxOutputTokens: 8192, supportsReasoning: true, reasoning: { effort: 'medium' } },
			// supportsImages：2026-10-30 起必须原样带出（平台目录里 images 全 true）
			{ id: 'hy4', name: 'Hunyuan 4', maxInputTokens: 256000, maxOutputTokens: 16384, supportsReasoning: true, supportsImages: true },
			{ id: 'img-gen', name: '生图', maxInputTokens: 4000, maxOutputTokens: 4000, tags: ['image-generation'] },
			{ id: 'nes-3b', name: 'NES', maxOutputTokens: 128 },
		],
	},
};
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

/** 可编排的假 fetch：按 URL 片段路由；记下每次调用（含 headers）。 */
function fakeFetch(routes) {
	const calls = [];
	const fn = async (url, init = {}) => {
		calls.push({ url, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) } });
		for (const [frag, handler] of routes) {
			if (url.includes(frag)) { return typeof handler === 'function' ? handler(url, init, calls) : handler; }
		}
		throw new Error(`fake fetch: 未编排的 URL ${url}`);
	};
	fn.calls = calls;
	return fn;
}

function collect(value, out = []) {
	if (value === null || value === undefined) { return out; }
	if (typeof value === 'string') { out.push(value); return out; }
	if (typeof value !== 'object') { return out; }
	for (const v of Array.isArray(value) ? value : Object.values(value)) { collect(v, out); }
	return out;
}
const leaksToken = (obj, tokens) => collect(obj).some(s => tokens.some(t => s.includes(t)));

const emptyDir = mkdtempSync(join(tmpdir(), 'cb-ls-empty-'));
let clock = 1_800_000_000_000;
const now = () => clock;
const noSleep = async () => { clock += 1000; };

function makeService(over = {}) {
	return cb.createCodeBuddyService({
		credentials: over.credentials ?? fakeCredentials(),
		settings: over.settings ?? fakeSettings(),
		fetchImpl: over.fetchImpl,
		openExternal: over.openExternal ?? (async () => true),
		now,
		sleep: noSleep,
		localStorageDir: over.localStorageDir ?? emptyDir,
		log: () => { },
		...(over.onRouteWritten ? { onRouteWritten: over.onRouteWritten } : {}),
	});
}

try {
	// ── ① 浏览器登录全链路 ─────────────────────────────────────────────────
	{
		const credentials = fakeCredentials();
		const settings = fakeSettings({ 'user-route': { api: 'openai-completions', baseURL: 'https://x', displayName: 'U', models: [] } });
		let pollCount = 0;
		const opened = [];
		const fetchImpl = fakeFetch([
			['/v2/plugin/auth/state', (url, init) => {
				if (init.method !== 'POST' || init.headers['X-No-Authorization'] !== 'true') { throw new Error('state 请求形状不对'); }
				return res(200, { data: { state: 'S1', authUrl: 'https://copilot.tencent.com/login?state=S1&x=1' } });
			}],
			['/v2/plugin/auth/token?state=S1', () => (++pollCount < 3 ? res(200, { data: {} }) : res(200, { data: { accessToken: TOKEN_A, refreshToken: REFRESH, expiresAt: Math.floor((clock + 3600_000) / 1000) } }))],
			['/v3/config', (url, init) => {
				if (init.headers.Authorization !== `Bearer ${TOKEN_A}`) { throw new Error('目录请求没带 Bearer token'); }
				return res(200, CONFIG_JSON);
			}],
		]);
		const svc = makeService({ credentials, settings, fetchImpl, openExternal: async u => { opened.push(u); return true; } });
		const st = await svc.signIn();
		if (opened.length !== 1 || opened[0] !== 'https://copilot.tencent.com/login?state=S1&x=1') {
			fail(`① 打开的登录地址不对：${JSON.stringify(opened)}（应原样打开 authUrl，含 & 参数）`);
		}
		if (credentials.store.get(ACCESS_REF) !== TOKEN_A) { fail(`① access token 没落到 ${ACCESS_REF} ✗`); }
		// ★ 2026-10-30 的隔离必须守住：OAuth token **不许**再写进 `VSSAROS_CODEBUDDY_KEY`
		// （那个 ref 归 IDE providers.sync 的 API Key，混写会导致平台拒答 /v3/config）。
		if (credentials.store.get('VSSAROS_CODEBUDDY_KEY') === TOKEN_A) { fail('① OAuth token 又写进了 VSSAROS_CODEBUDDY_KEY（与 API Key 抢同一个 ref）✗'); }
		const sess = JSON.parse(credentials.store.get('VSSAROS_CODEBUDDY_SESSION') ?? '{}');
		if (sess.refreshToken !== REFRESH || typeof sess.expiresAt !== 'number' || sess.expiresAt <= clock || sess.source !== 'cli_external_link') {
			fail(`① 会话信息不对：${JSON.stringify({ ...sess, refreshToken: sess.refreshToken ? '(有)' : '(无)' })}`);
		}
		const route = settings.providers['vssaros-codebuddy'];
		if (!route) {
			fail('① 登录后没写 vssaros-codebuddy 路由 ✗');
		} else {
			const ids = route.models.map(m => m.id);
			const want = ['hy3', 'deepseek-v4', 'missing-meta', 'hy4'];
			if (JSON.stringify(ids) !== JSON.stringify(want)) { fail(`④ 模型清单 ${JSON.stringify(ids)}（应为 ${JSON.stringify(want)}：allow-list 顺序 + 补入 chat-capable，排除生图/补全小模型）`); }
			if (route.apiKeyEnv !== 'VSSAROS_CODEBUDDY_KEY') { fail(`⑤ apiKeyEnv=${route.apiKeyEnv}（应为 VSSAROS_CODEBUDDY_KEY）`); }
			if (route.baseURL !== 'https://copilot.tencent.com/v2') { fail(`⑤ baseURL=${route.baseURL}（默认直连应为 https://copilot.tencent.com/v2）`); }
			if (route.api !== 'openai-completions' || route.displayName !== 'CodeBuddy') { fail(`⑤ api/displayName 不对：${route.api}/${route.displayName}`); }
			if (route.headers?.Authorization) { fail('⑤ 画像 headers 里出现了 Authorization（token 应只走 apiKeyEnv）✗'); }
			if (route.headers?.['X-User-Id'] !== 'user-123' || route.headers?.['X-Tenant-Id'] !== 'tenantX') { fail(`⑤ 身份头没从 JWT 取对：${JSON.stringify(route.headers)}`); }
			if (route.reasoning !== undefined) { fail(`⑤ 路由级默认档位：混有未声明推理的模型（missing-meta）时不应写，实际 ${route.reasoning}`); }
			if (!settings.providers['user-route']) { fail('① 写 CodeBuddy 路由时把用户自加的路由弄丢了 ✗（必须是 path 级 set）'); }
		}
		if (st.signedIn !== true || st.userId !== 'user-123' || st.models !== 4) { fail(`① 登录后状态不对：${JSON.stringify(st)}`); }
		if (leaksToken(st, [TOKEN_A, REFRESH])) { fail('⑥ status() 投影里漏出了 token ✗'); }
		if (!problems.length) { ok('① 浏览器登录：state → 开浏览器（URL 原样）→ 轮询 → 落凭据 → 写路由（不动别的路由）'); }

		// ── ③a 刷新：离过期 <5 分钟 ⇒ 刷新换新 token ──
		clock = sess.expiresAt - 60_000;
		let refreshCalls = 0;
		const fetch2 = fakeFetch([
			['/v2/plugin/auth/token/refresh', (url, init) => {
				refreshCalls++;
				if (init.headers['X-Refresh-Token'] !== REFRESH) { throw new Error('刷新没带 X-Refresh-Token'); }
				return res(200, { data: { accessToken: TOKEN_B, expiresAt: Math.floor((clock + 7200_000) / 1000) } });
			}],
			['/v3/config', res(200, CONFIG_JSON)],
		]);
		const svc2 = makeService({ credentials, settings, fetchImpl: fetch2 });
		await svc2.tick();
		if (refreshCalls !== 1 || credentials.store.get(ACCESS_REF) !== TOKEN_B) {
			fail(`③ 快过期没刷新（refresh 调用 ${refreshCalls} 次；token=${credentials.store.get(ACCESS_REF) === TOKEN_B ? 'B' : 'A'}）✗`);
		} else if (JSON.parse(credentials.store.get('VSSAROS_CODEBUDDY_SESSION')).refreshToken !== REFRESH) {
			fail('③ 刷新响应没给新 refreshToken 时应保留旧的 ✗');
		} else {
			ok('③ 离过期 <5 分钟 ⇒ 自动刷新换新 token（refreshToken 保留）');
		}

		// ── ③b 刷新 5xx ⇒ 保留登录态与路由 ──
		clock = JSON.parse(credentials.store.get('VSSAROS_CODEBUDDY_SESSION')).expiresAt - 60_000;
		const fetch3 = fakeFetch([['/v2/plugin/auth/token/refresh', res(503, {})], ['/v3/config', res(200, CONFIG_JSON)]]);
		const svc3 = makeService({ credentials, settings, fetchImpl: fetch3 });
		await svc3.tick();
		if (!credentials.store.has(ACCESS_REF) || !settings.providers['vssaros-codebuddy']) {
			fail('③ 刷新遇到 5xx 就清了登录态 / 撤了路由 ✗（应保留，下一轮再试）');
		} else {
			ok('③ 刷新 5xx ⇒ 保留登录态与路由（暂时失败不等于失效）');
		}

		// ── ④b 网络失败取目录 ⇒ 保留路由 ──
		clock += 10 * 60_000;
		const before = JSON.stringify(settings.providers['vssaros-codebuddy']);
		const fetch4 = fakeFetch([['/v2/plugin/auth/token/refresh', res(200, { data: { accessToken: TOKEN_B, expiresAt: Math.floor((clock + 7200_000) / 1000) } })], ['/v3/config', () => { throw new Error('ECONNRESET'); }]]);
		const svc4 = makeService({ credentials, settings, fetchImpl: fetch4 });
		await svc4.syncRoute('test');
		if (JSON.stringify(settings.providers['vssaros-codebuddy']) !== before) {
			fail('④ 取目录网络失败时改动/撤掉了路由 ✗（一次超时不能让模型全消失）');
		} else {
			ok('④ 取目录网络失败 ⇒ 路由原样保留');
		}

		// ── ③c 刷新 401 ⇒ 清登录态 + 撤路由 ──
		clock = JSON.parse(credentials.store.get('VSSAROS_CODEBUDDY_SESSION')).expiresAt - 60_000;
		const fetch5 = fakeFetch([['/v2/plugin/auth/token/refresh', res(401, {})], ['/v3/config', res(200, CONFIG_JSON)]]);
		const svc5 = makeService({ credentials, settings, fetchImpl: fetch5 });
		await svc5.tick();
		await svc5.syncRoute('after-401');
		const st5 = await svc5.status();
		if (credentials.store.has(ACCESS_REF) || settings.providers['vssaros-codebuddy']) {
			fail('③ 刷新 401 后没清登录态 / 没撤路由 ✗');
		} else if (st5.signedIn !== false || !/重新登录/.test(st5.error ?? '')) {
			fail(`③ 刷新 401 后状态应为未登录并提示重新登录：${JSON.stringify(st5)}`);
		} else {
			ok('③ 刷新 401 ⇒ 清登录态 + 撤路由 + 如实提示重新登录');
		}
	}

	// ── ② 复用本机 CodeBuddy 登录态（不开浏览器）──────────────────────────────
	{
		const dir = mkdtempSync(join(tmpdir(), 'cb-ls-'));
		const entry = { session: { auth: { accessToken: TOKEN_A, refreshToken: REFRESH, expiresAt: Math.floor((clock + 3600_000) / 1000) } } };
		writeFileSync(join(dir, 'k1'), JSON.stringify(gzipSync(Buffer.from(JSON.stringify(entry))).toString('base64')));
		const credentials = fakeCredentials();
		const settings = fakeSettings();
		const opened = [];
		const fetchImpl = fakeFetch([['/v3/config', res(200, CONFIG_JSON)]]);
		const svc = makeService({ credentials, settings, fetchImpl, localStorageDir: dir, openExternal: async u => { opened.push(u); } });
		const st = await svc.signIn();
		if (opened.length !== 0) { fail('② 本机已有 CodeBuddy 登录态时仍打开了浏览器 ✗'); }
		else if (credentials.store.get(ACCESS_REF) !== TOKEN_A || st.source !== 'local_storage') { fail(`② 没复用本机登录态：${JSON.stringify(st)}`); }
		else { ok('② 本机 ~/.codebuddy/local_storage 有登录态 ⇒ 直接复用，不开浏览器'); }
		rmSync(dir, { recursive: true, force: true });
	}

	// ── ④c 平台返回空目录 ⇒ 撤路由（权威的空）────────────────────────────────
	{
		const credentials = fakeCredentials({ VSSAROS_CODEBUDDY_KEY: TOKEN_A, VSSAROS_CODEBUDDY_SESSION: JSON.stringify({ refreshToken: REFRESH, expiresAt: clock + 3600_000, source: 'cli_external_link' }) });
		const settings = fakeSettings({ 'vssaros-codebuddy': { api: 'openai-completions', baseURL: 'https://old', displayName: 'CodeBuddy', models: [{ id: 'old' }] } });
		const fetchImpl = fakeFetch([['/v3/config', res(200, { code: 0, data: { models: null, agents: null } })]]);
		const svc = makeService({ credentials, settings, fetchImpl });
		await svc.syncRoute('test');
		if (settings.providers['vssaros-codebuddy']) { fail('④ 平台返回空目录（data.models=null）时没撤路由 ✗（产品口径：不回落旧快照）'); }
		else { ok('④ 平台空目录 ⇒ 撤路由（不回落任何静态快照）'); }
	}

	// ── ④d/④e（2026-11-05 真机反馈包）：**模型列表里 CodeBuddy 周期性/持续不显示** ──
	//   日志：`token refreshed` → `route removed（未登录；tick）` → `route written` 反复出现。
	//   旧代码在目录接口 401（重试后仍 401）或 token 已过期且刷新暂时失败时，
	//   直接 clearSession() / 撤路由 ⇒ 那一行模型从选择器里消失，下一轮 tick 又迁移回来。
	{
		// ④d 目录接口连续 401（刷新成功但重取仍 401）⇒ 保留登录态与路由
		clock = 1_800_000_000_000;
		const credentials = fakeCredentials({
			[ACCESS_REF]: TOKEN_A,
			VSSAROS_CODEBUDDY_SESSION: JSON.stringify({ refreshToken: REFRESH, expiresAt: clock + 3600_000, source: 'cli_external_link' }),
		});
		const settings = fakeSettings({ 'vssaros-codebuddy': { api: 'openai-completions', baseURL: 'https://old', displayName: 'CodeBuddy', models: [{ id: 'hy3' }] } });
		const fetchImpl = fakeFetch([
			['/v2/plugin/auth/token/refresh', res(200, { data: { accessToken: TOKEN_B, expiresAt: Math.floor((clock + 7200_000) / 1000) } })],
			['/v3/config', res(401, {})],
		]);
		const svc = makeService({ credentials, settings, fetchImpl });
		await svc.syncRoute('401-retry');
		if (!credentials.store.has(ACCESS_REF) || !settings.providers['vssaros-codebuddy']) {
			fail('④ 目录接口连续 401 就清了登录态 / 撤了模型路由 ✗（token 刚轮换/网关抖动的 401 ≠ 登出失效）');
		} else {
			ok('④ 目录接口 401（重试后仍失败）⇒ 保留登录态与模型路由');
		}
	}
	{
		// ④e 会话已过期 + 刷新 5xx ⇒ accessToken() 暂不可用，但会话还在 ⇒ 不撤路由
		clock = 1_800_000_000_000;
		const credentials = fakeCredentials({
			[ACCESS_REF]: TOKEN_A,
			VSSAROS_CODEBUDDY_SESSION: JSON.stringify({ refreshToken: REFRESH, expiresAt: clock - 1000, source: 'cli_external_link' }),
		});
		const settings = fakeSettings({ 'vssaros-codebuddy': { api: 'openai-completions', baseURL: 'https://old', displayName: 'CodeBuddy', models: [{ id: 'hy3' }] } });
		const fetchImpl = fakeFetch([
			['/v2/plugin/auth/token/refresh', res(503, {})],
			['/v3/config', res(200, CONFIG_JSON)],
		]);
		const svc = makeService({ credentials, settings, fetchImpl });
		await svc.syncRoute('expired-5xx');
		if (!settings.providers['vssaros-codebuddy']) {
			fail('④ 会话已过期但刷新仅暂时失败（5xx）就撤了模型路由 ✗（暂时失败 ≠ 登出）');
		} else {
			ok('④ 已过期 + 刷新 5xx ⇒ 会话仍在就不撤模型路由');
		}
	}

	// ── 纯函数：isChatCapableModel / resolveChatModels / 身份头 ──────────────────
	{
		const r = cb.resolveChatModels({ code: 0, data: { agents: [], models: CONFIG_JSON.data.models } });
		const ids = r.models.map(m => m.id);
		if (JSON.stringify(ids) !== JSON.stringify(['hy3', 'deepseek-v4', 'hy4'])) { fail(`④ 无 allow-list 时启发式结果 ${JSON.stringify(ids)}（应为 hy3/deepseek-v4/hy4）`); }
		if (cb.resolveChatModels({ code: 1, data: {} }) !== null) { fail('④ code≠0 应返回 null（不是权威的空）✗'); }
		const hy3 = r.models.find(m => m.id === 'hy3');
		// ★ 2026-11-02：跟随 2026-10-30 新增的两位 —— `contextWindow`（来自 maxInputTokens）
		// 与 `maxTokens`（来自 maxOutputTokens）。少了它们 dsh 会用 pi-ai 缺省窗口压缩上下文。
		// 键顺序即产品 `toRouteModel` 的构造顺序（JSON.stringify 逐字比较）。
		if (JSON.stringify(hy3) !== JSON.stringify({ id: 'hy3', name: 'Hunyuan 3', reasoning: true, contextWindow: 128000, maxTokens: 8192, effort: 'high' })) {
			fail(`⑤ 模型形状不对：${JSON.stringify(hy3)}（应含 contextWindow/maxTokens，与扩展 dshProviderConfig 导出同形）`);
		}
		// ★ 2026-10-30 的图像能力位：`supportsImages` 必须带出去（否则 dsh 把模型当纯文本，剥掉图片）
		const hy4 = r.models.find(m => m.id === 'hy4');
		if (!hy4 || hy4.supportsImages !== true) { fail(`⑤ supportsImages 没带出去：${JSON.stringify(hy4)}（应 true）`); }
		// 有限正数才写：`nes-3b` 只有 maxOutputTokens=128（远小于窗口）⇒ 不得凭空给 contextWindow
		const nes = r.models.find(m => m.id === 'nes-3b');
		if (nes && 'contextWindow' in nes) { fail(`⑤ 缺失容量位的模型不该凭猜测补 contextWindow：${JSON.stringify(nes)}`); }
		const dv4 = r.models.find(m => m.id === 'deepseek-v4');
		if ('name' in dv4) { fail('⑤ name 与 id 相同时不应导出 name ✗'); }
		const h = cb.identityHeaders(TOKEN_A);
		const wantKeys = ['X-IDE-Type', 'X-IDE-Name', 'X-IDE-Version', 'X-Product-Version', 'X-Env-ID', 'X-User-Id', 'X-Enterprise-Id', 'X-Tenant-Id', 'X-Domain', 'X-Product', 'User-Agent'];
		if (JSON.stringify(Object.keys(h)) !== JSON.stringify(wantKeys)) { fail(`⑤ 身份头键集 ${JSON.stringify(Object.keys(h))} 与扩展 buildCodeBuddyIdentityHeaders（去 Authorization）不一致`); }
		if (!problems.length) { ok('④⑤ 目录解析 / 模型形状 / 身份头与扩展原实现逐条一致'); }
	}

	// ── ⑦ 迁移 ─────────────────────────────────────────────────────────────
	{
		const credentials = fakeCredentials();
		const settings = fakeSettings();
		const fetchImpl = fakeFetch([['/v3/config', res(200, CONFIG_JSON)]]);
		const svc = makeService({ credentials, settings, fetchImpl });
		const r1 = await svc.importSession({ accessToken: TOKEN_A, refreshToken: REFRESH, expiresAt: clock + 3600_000 });
		const r2 = await svc.importSession({ accessToken: TOKEN_B, refreshToken: 'OTHER-REFRESH-000', expiresAt: clock + 3600_000 });
		if (!r1.imported || r2.imported || r2.reason !== 'already-signed-in' || credentials.store.get(ACCESS_REF) !== TOKEN_A) {
			fail(`⑦ 迁移语义不对：r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}（dsh 侧已登录时不得覆盖）`);
		} else if (!settings.providers['vssaros-codebuddy']) {
			fail('⑦ 导入后没写路由 ✗');
		} else {
			ok('⑦ 迁移：未登录 ⇒ 导入；已登录 ⇒ 不覆盖');
		}
		// 老数据（IDE providers.sync 写的那份，没有会话信息）⇒ 允许被导入覆盖（换来 refresh token）
		const legacy = fakeCredentials({ VSSAROS_CODEBUDDY_KEY: TOKEN_A });
		const svcL = makeService({ credentials: legacy, settings: fakeSettings(), fetchImpl });
		const rl = await svcL.importSession({ accessToken: TOKEN_B, refreshToken: REFRESH, expiresAt: clock + 3600_000 });
		if (!rl.imported) { fail('⑦ 老数据（只有 access token、没有会话信息）应允许导入覆盖 ✗'); }
		// 登出 ⇒ 两个凭据 ref 清掉 + 撤路由 + 记下"主动登出过"
		await svc.signOut();
		// 三个 ref 都要清（2026-10-30 起 token 在 ACCESS_TOKEN，`KEY` 可能残留 IDE 写的 API Key
		// ⇒ 登出必须连它一起验，否则"登出后 pi-ai 还能用旧 key 调"）
		if (credentials.store.has(ACCESS_REF) || credentials.store.has('VSSAROS_CODEBUDDY_KEY') || credentials.store.has('VSSAROS_CODEBUDDY_SESSION') || settings.providers['vssaros-codebuddy']) {
			fail('⑦ 登出后凭据/路由没清干净 ✗');
		} else if (credentials.store.get('VSSAROS_CODEBUDDY_SIGNED_OUT') !== '1') {
			fail('⑦ 登出没记下"主动登出过"标记 ⇒ 下一轮 IDE 迁移会把登录态原样导回来（登出不掉）✗');
		} else {
			ok('⑦ 登出 ⇒ 两个凭据 ref 清掉 + 撤路由 + 记下主动登出');
		}
		// ★ 主动登出后，过渡期 IDE 的迁移**不得**把扩展里的登录态再导回来
		const r3 = await svc.importSession({ accessToken: TOKEN_A, refreshToken: REFRESH, expiresAt: clock + 3600_000 });
		if (r3.imported || r3.reason !== 'signed-out-by-user' || credentials.store.has(ACCESS_REF)) {
			fail(`⑦ 主动登出后 IDE 迁移又把登录态导回来了：${JSON.stringify(r3)} ✗（用户会发现"登出不掉"）`);
		} else {
			ok('⑦ 主动登出后 ⇒ IDE 迁移被拒（signed-out-by-user）');
		}
		// 用户在 dsh 侧再次主动登录 ⇒ 标记撤掉
		const dirL = mkdtempSync(join(tmpdir(), 'cb-ls2-'));
		writeFileSync(join(dirL, 'k1'), JSON.stringify(gzipSync(Buffer.from(JSON.stringify({ session: { auth: { accessToken: TOKEN_A, refreshToken: REFRESH, expiresAt: Math.floor((clock + 3600_000) / 1000) } } }))).toString('base64')));
		const svcRe = makeService({ credentials, settings, fetchImpl, localStorageDir: dirL });
		await svcRe.signIn();
		if (credentials.store.has('VSSAROS_CODEBUDDY_SIGNED_OUT')) { fail('⑦ 用户再次主动登录后"主动登出过"标记没撤 ⇒ 之后的迁移会一直被拒 ✗'); }
		else { ok('⑦ 再次主动登录 ⇒ 撤掉主动登出标记'); }
		rmSync(dirL, { recursive: true, force: true });
	}

	// ── ⑤ 与 IDE 侧画像同形（同一份输入 ⇒ buildRouteProfile 产物逐字段相同）───────────
	{
		const entry = cb.codebuddyRouteEntry({ baseURL: 'https://copilot.tencent.com/v2/', accessToken: TOKEN_A, models: [{ id: 'hy3', name: 'Hunyuan 3', reasoning: true, effort: 'high' }] });
		const want = {
			route: 'vssaros-codebuddy', displayName: 'CodeBuddy', api: 'openai-completions', baseURL: 'https://copilot.tencent.com/v2',
			credentialRef: 'VSSAROS_CODEBUDDY_KEY',
		};
		for (const [k, v] of Object.entries(want)) {
			if (entry[k] !== v) { fail(`⑤ 路由条目 ${k}=${JSON.stringify(entry[k])}（应为 ${JSON.stringify(v)}）`); }
		}
		const profile = pp.buildRouteProfile(entry);
		if (profile.reasoning !== 'high' || JSON.stringify(profile.models[0].reasoningEfforts) !== JSON.stringify({ off: null, low: 'low', medium: 'medium', high: 'high' })) {
			fail(`⑤ 画像推理位不对：${JSON.stringify(profile)}`);
		}
		const why = [];
		if (!pp.sameProfile(profile, JSON.parse(JSON.stringify(profile)), why)) { fail(`⑤ sameProfile 对自身不等价：${why}`); }
		if (!problems.length) { ok('⑤ 路由条目 / 画像与 IDE 侧 providers.sync 同形（换所有权不重写 profile）'); }
	}

	// ── ⑧ providers.sync 不碰 dsh 自持路由（源码级接线）─────────────────────────
	{
		const m = /const DSH_OWNED_ROUTES = new Set\(\[([^\]]*)\]\)/.exec(indexSrc);
		if (!m || !/CODEBUDDY_ROUTE/.test(m[1])) { fail('⑧ index.js 缺 DSH_OWNED_ROUTES（或其中没有 CODEBUDDY_ROUTE）✗'); }
		const syncAt = indexSrc.indexOf("case 'providers.sync':");
		const syncBlock = syncAt >= 0 ? indexSrc.slice(syncAt, indexSrc.indexOf('case ', syncAt + 30)) : '';
		const checks = [
			[/if \(!p \|\| DSH_OWNED_ROUTES\.has\(p\.route\)\) \{ continue; \}/, '负载里的自持路由必须跳过'],
			[/!ours\[k\] && !DSH_OWNED_ROUTES\.has\(k\)/, '"残留路由"清理必须排除自持路由'],
			[/!k\.startsWith\('vssaros-'\) \|\| DSH_OWNED_ROUTES\.has\(k\)/, '整批写回时必须保留自持路由'],
			[/!ownedRefs\.has\(c\.ref\)/, '自持路由的凭据不得被 IDE 负载覆盖'],
		];
		for (const [re, label] of checks) {
			if (!re.test(syncBlock)) { fail(`⑧ providers.sync：${label} ✗`); }
		}
		// 自持 provider 的入口必须在管道早退之前（dsh 独立跑也能登录、能出模型）
		const createAt = indexSrc.indexOf('createCodeBuddyService(');
		const earlyAt = indexSrc.indexOf('if (!pipe || !token)');
		if (createAt < 0 || earlyAt < 0 || createAt > earlyAt) { fail('⑧ CodeBuddy 服务建在管道早退之后 ⇒ dsh 独立跑时没有 CodeBuddy ✗'); }
		// HTTP 子路径**不能**写成 case（会被 dshBridgeParity 当成桥方法）
		if (/case '(status|signin|signout|refresh|cancel)'\s*:/.test(indexSrc)) { fail('⑧ HTTP 子路径写成了 case \'<op>\'（dshBridgeParity 会把它当桥方法 ⇒ 守卫红）✗'); }
		if (!problems.some(p => p.startsWith('⑧'))) { ok('⑧ providers.sync 不碰自持路由（跳过 / 不清理 / 保留 / 不覆盖凭据）+ 入口在早退之前'); }
	}

	// ── ⑨ 跨层对账 + 随包清单 ─────────────────────────────────────────────────
	{
		const plan = read(planRel);
		const proto = code(read(protoRel));
		// IDE 侧派生规则就地复算（与 dshProviderSyncPlan.ts 同算法；对算法本身也做文本锚定 ⇒ 改一边必红）
		if (!/return `vssaros-\$\{slug\}`\.slice\(0, 49\);/.test(plan) || !/return `VSSAROS_\$\{slug\}_KEY`\.slice\(0, 69\);/.test(plan)) {
			fail('⑨ dshProviderSyncPlan.ts 的路由名/凭据名派生规则变了 ⇒ 本守卫的对账基准失效，请同步更新 ✗');
		}
		if (cb.CODEBUDDY_ROUTE !== 'vssaros-codebuddy' || cb.CODEBUDDY_CREDENTIAL_REF !== 'VSSAROS_CODEBUDDY_KEY') {
			fail(`⑨ 路由名/凭据名与 IDE 侧派生不一致：${cb.CODEBUDDY_ROUTE} / ${cb.CODEBUDDY_CREDENTIAL_REF}`);
		}
		for (const method of ['codebuddy.status', 'codebuddy.import']) {
			if (!proto.includes(`'${method}'`)) { fail(`⑨ 协议 DshBridgeMethod 缺 '${method}' ✗`); }
			if (!indexSrc.includes(`case '${method}':`)) { fail(`⑨ 桥插件缺 case '${method}' ✗`); }
		}
		if (!proto.includes("'credit.route'") || !/callIDE\('credit\.route'/.test(indexSrc)) {
			fail("⑨ 反向方法 'credit.route'：协议或桥插件调用缺一侧 ✗");
		}
		const pkg = JSON.parse(read(pkgRel));
		for (const f of ['lib/codebuddy.js', 'lib/providerProfile.js']) {
			if (!pkg.files?.includes(f)) { fail(`⑨ package.json files 缺 ${f} ⇒ 装出来的包少模块 ⇒ 整个桥插件 failed to import ✗`); }
		}
		if (!problems.some(p => p.startsWith('⑨'))) { ok('⑨ 跨层对账（路由名 / 凭据名 / 桥方法 / 反向方法）+ 随包清单齐'); }
	}

	// ── ⑪ 模型目录可见性（2026-11-04 安装版「CodeBuddy 登录后聊天框看不到模型信息」）────────
	//   日志/真机结论：dev 的 cordis.patch.yml 里早就持久化了 `llm-pi-ai.providers.vssaros-codebuddy`
	//   与 `agent-default-model`，所以启动即就绪；安装版全新 profile 全靠登录瞬间的一次 volatile 写入
	//   （不落盘、事件早于页面订阅、Host 重启即丢）⇒ 目录停在空快照。
	//   修法不是落盘失效数据（baseURL 含随机端口 / token 会过期），而是：
	//     ① 路由写入后补发目录刷新事件；② 客户端注册时再补发；③ Host 启动 2s 内重放路由；
	//     ④ `saveSelection` 为 no-op 时不再打"改写成功"的假日志。
	{
		const checks = [
			[/const notifyModelDirectory = \(why\) => \{/, '必须有目录刷新通知（覆盖页面订阅晚于路由写入的窗口）'],
			[/ctx\.emit\('llm\/adapters-updated'\)/, '必须补发 llm/adapters-updated（ModelCatalogDirectory 的四个刷新事件之一）'],
			[/ctx\.emit\('settings\/document-updated', 'llm-pi-ai'\)/, '必须补发 settings/document-updated'],
			[/notifyModelDirectory\('route-written'\)/, '路由写入成功后必须立刻通知目录刷新'],
			[/notifyModelDirectory\('client-register'\)/, '客户端注册时必须再补发一次（页面此刻才订阅）'],
			[/codebuddy\.start\(\{ initialDelayMs: 2_000 \}\)/, 'Host 启动后必须尽快重放路由（不能等 20s ⇒ 页面已首拉空目录）'],
			[/const applied = !!after && after\.provider === want\.provider && after\.model === want\.model;/, 'saveSelection 后必须读回校验（官方在无 configEditor 时是 no-op）'],
			[/改写未生效（saveSelection 为 no-op）/, '改写未生效时必须明确留痕，不许再打"请求改写"的假成功文案'],
		];
		for (const [re, label] of checks) {
			if (!re.test(indexSrc)) { fail(`⑪ 模型目录可见性：${label} ✗`); }
		}
		// 反向保护：不许把路由写回持久化配置（volatile 是有意为之）
		if (/writeFileSync\([^)]*cordis\.patch\.yml/.test(indexSrc)) {
			fail('⑪ 不许把路由/凭据写进 cordis.patch.yml（volatile 字段故意不落盘：baseURL 含随机端口、token 会过期）✗');
		}
		if (!problems.some(p => p.startsWith('⑪'))) { ok('⑪ 路由写入/客户端注册补发目录刷新 + 启动 2s 重放 + saveSelection 真实性校验'); }
	}

	// ── ⑩ 真跑 apply()：HTTP 面接通（GET status 200 / 写操作只认 POST / 未知操作 404 / 回执无 token）────────
	// 正则断言（⑧）只能证明"写了"，这里证明"真能用"：用宽松假 ctx 跑插件真实的 apply()（不配 pipe ⇒ 走独立模式）。
	{
		const routes = [];
		const disposers = [];
		const credentials = fakeCredentials({ VSSAROS_CODEBUDDY_KEY: TOKEN_A, VSSAROS_CODEBUDDY_SESSION: JSON.stringify({ refreshToken: REFRESH, expiresAt: Date.now() + 3600_000, source: 'cli_external_link' }) });
		const ctx = {
			webServer: { register: r => { routes.push(r); return () => { }; }, port: 7000, host: '127.0.0.1' },
			connection: { requestRejection: () => 0, authenticatedUrl: u => u },
			settings: fakeSettings(),
			credentials,
			llm: { listProviders: () => [], listModels: async () => [] },
			tools: { register: () => () => { } },
			agents: {}, sessionController: {}, workspaceRegistry: {},
			effect: fn => { const d = fn(); if (typeof d === 'function') { disposers.push(d); } },
			on: () => () => { },
			inject: () => { },
			provide: () => { },
			get: () => undefined,
		};
		const bridge = await import(pathToFileURL(join(repo, indexRel)).href);
		try {
			bridge.apply(ctx, {});
		} catch (e) {
			fail(`⑩ apply() 抛错：${String(e?.message ?? e)}（插件整体加载失败 ⇒ 桥 / TOF / CodeBuddy 全没 ✗）`);
		}
		const route = routes.find(r => r.path === '/x/vssaros-bridge');
		const call = (method, url) => new Promise(resolveCall => {
			const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b ?? ''; resolveCall(this); } };
			route.handler({ method, url, headers: {} }, res);
		});
		if (!route) {
			fail('⑩ apply() 没注册 /x/vssaros-bridge 前缀路由 ✗');
		} else {
			const st = await call('GET', '/x/vssaros-bridge/api/codebuddy/status');
			let body = {};
			try { body = JSON.parse(st.body); } catch { /* 下面断言会报 */ }
			if (st.code !== 200 || body?.status?.signedIn !== true || body?.status?.userId !== 'user-123') {
				fail(`⑩ GET status 应 200 且读到凭据里的登录态：code=${st.code} body=${st.body.slice(0, 200)}`);
			}
			if (leaksToken(body, [TOKEN_A, REFRESH])) { fail('⑩ HTTP status 回执漏出了 token ✗'); }
			const wrongMethod = await call('GET', '/x/vssaros-bridge/api/codebuddy/signout');
			if (wrongMethod.code !== 405) { fail(`⑩ 写操作用 GET 应 405（实际 ${wrongMethod.code}）——否则一个 <img src> 就能把用户登出 ✗`); }
			const unknown = await call('GET', '/x/vssaros-bridge/api/codebuddy/nope');
			if (unknown.code !== 404) { fail(`⑩ 未知操作应 404（实际 ${unknown.code}）`); }
			const page = await call('GET', '/x/vssaros-bridge');
			if (page.code !== 200 || !/data-vssaros-page="status"/.test(page.body)) { fail('⑩ 原有状态页被新路由分流弄坏了 ✗'); }
			if (!problems.some(p => p.startsWith('⑩'))) { ok('⑩ 真跑 apply()：HTTP 面接通（status 200 / 写操作仅 POST / 未知 404 / 状态页照旧 / 无 token）'); }
		}
		for (const d of disposers) { try { d(); } catch { /* ignore */ } }
	}
} finally {
	rmSync(emptyDir, { recursive: true, force: true });
}

if (problems.length) {
	console.error(`\n[check-dsh-codebuddy] ✗ ${problems.length} 处问题：`);
	for (const p of problems) { console.error(`  - ${p}`); }
	process.exit(1);
}
console.log('\n[check-dsh-codebuddy] ✓ CodeBuddy dsh 侧实现：登录 / 刷新 / 目录 / 画像 / 迁移 / 接线全部通过');
// 真跑 apply() 会留下插件自己的定时器/监听（看门狗等）⇒ 显式退出，别让守卫挂住 CI ✓
process.exit(0);
