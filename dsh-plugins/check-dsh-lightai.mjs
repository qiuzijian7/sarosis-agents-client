#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * check-dsh-lightai.mjs — 守卫：LightAI 的 **dsh 侧实现**（2026-10-22）。
 *
 * 用户原话："lightai provider 插件改成 dsh 侧实现，在 dsh 窗口版的设置页面中的模型中展示和配置"；
 * 登录方式用户选 ①："用本仓的浏览器插件打开登录页、登录后自动读取 Cookie"。
 *
 * **行为断言为主**（假 fetch + 假凭据 + 假浏览器 ⇒ 不联网、不开浏览器）：
 *   ① k 参数解析 = 扩展同一组默认值（绝对期望值）；
 *   ② `/api/user/check`：请求形状逐字对齐扩展；code≠0 / 401 ⇒ 会话无效；"没有访问权限" ⇒ 网络受限（**不是**失效）；5xx ⇒ 临时；
 *   ③ 登录·复用：浏览器里已有有效会话 ⇒ **不开页面**、直接登录；
 *   ④ 登录·开页面：旧会话被拒 ⇒ 开登录页 ⇒ 等 cookie **变了**才校验（不被旧票卡住）⇒ 落盘 + 关 tab；
 *   ⑤ 取消 / 没有浏览器插件：立刻结束、不落盘、错误说清楚；
 *   ⑥ 状态投影绝不含 cookie 值；会话失效 ⇒ expired；网络失败 ⇒ stale（仍算已登录）；校验结果有缓存；
 *   ⑦ 模型发现：bundle 解析 + 名字；`seed_audio_1` 这类发现不到的默认模型保住；routable 标记；
 *   ⑧ 测试连接：get_voucher 请求头逐字对齐扩展（app_id 169 / biz_id / user-data / cookie）；
 *   ⑨ 自定义设置：只收 https + aigclsp.com；迁移：格式 / 已登录 / 主动登出过 都不导；登出：模型清单保留、记标记；
 *   ⑩ 浏览器插件登录会话：只认登记站点 / 只回登记 cookie 名 / 只认 https / 无头明说；
 *   ⑪ 真跑 apply()：HTTP 面（status 200 / 写仅 POST / 未知 404 / config 校验 400 / 无 cookie 值）；
 *   ⑫ 接线（源码级）：桥方法、协议、主进程校验、IDE 一次性迁移、包清单；
 *   ⑬ 页面卡片（真装载 chunk）：状态映射 + 各状态的按钮 + 没有浏览器插件时登录按钮禁用 + 无 cookie 值。
 *
 * 判据纪律：绝对期望值；采集面缺失直接失败；改完必须做**反向突变**。
 * 用法：node dsh-plugins/check-dsh-lightai.mjs
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const problems = [];
const ok = label => console.log(`  ✓ ${label}`);
const fail = msg => problems.push(msg);
const failed = tag => problems.some(p => p.startsWith(tag));

function code(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}
function read(rel) {
	const full = join(repo, rel);
	if (!existsSync(full)) { fail(`文件不存在：${rel}（采集面失效 ⇒ 不能当通过）`); return ''; }
	return readFileSync(full, 'utf8');
}

const laRel = 'dsh-plugins/vssaros-bridge/lib/lightai.js';
const lsRel = 'dsh-plugins/vssaros-browser/lib/core/loginSession.js';
const indexRel = 'dsh-plugins/vssaros-bridge/lib/index.js';
const indexSrc = code(read(indexRel));
const protoSrc = code(read('src/vs/sessions/contrib/dshHarness/common/dshBridgeProtocol.ts'));
const harnessSrc = code(read('src/vs/sessions/contrib/dshHarness/common/dshHarness.ts'));
const channelSrc = code(read('src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts'));
const syncSrc = code(read('src/vs/sessions/contrib/dshHarness/electron-browser/dshProviderSync.ts'));
const browserIdx = code(read('dsh-plugins/vssaros-browser/lib/index.js'));
const chunkSrc = read('dsh-plugins/vssaros-chat-surface/lib/client.modelAccounts.js');
if (!read(laRel) || !read(lsRel) || !indexSrc || !chunkSrc) {
	console.error('[check-dsh-lightai] ✗ 采集面缺失 —— 不能当通过');
	process.exit(1);
}
const la = await import(pathToFileURL(join(repo, laRel)).href);
const ls = await import(pathToFileURL(join(repo, lsRel)).href);

// ── 假件 ────────────────────────────────────────────────────────────────────
const SID = 'sid-VALUE-0123456789abcdef';
const UID = 'uid-VALUE-fedcba9876543210';
const SID2 = 'sid-NEW-aaaaaaaaaaaaaaaa';
const COOKIE = `sessionid=${SID}; uid=${UID}`;
const COOKIE2 = `sessionid=${SID2}; uid=${UID}`;
const USER = 'zijianqiu@tencent.com';
const SECRETS = [SID, UID, SID2, 'JWT-VOUCHER-xyz'];

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
const jsonRes = (status, body, type = 'application/json') => ({
	ok: status >= 200 && status < 300, status,
	headers: { get: () => type },
	text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
	json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});
/** 假 LightAI：`valid` 里的 cookie 才算有效；记下每个请求。 */
function fakeLightAI({ valid = [COOKIE, COOKIE2], mode = 'ok' } = {}) {
	const calls = [];
	const f = async (url, init = {}) => {
		calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
		const u = String(url);
		if (u.endsWith('/api/user/check')) {
			if (mode === 'down') { throw new Error('connect ECONNREFUSED'); }
			if (mode === 'restricted') { return jsonRes(403, '{"detail":"没有访问权限"}'); }
			if (mode === '500') { return jsonRes(500, 'oops', 'text/plain'); }
			const ck = init.headers?.cookie;
			return valid.includes(ck)
				? jsonRes(200, { code: 0, result: { username: USER, sessionid: SID, openid: UID } })
				: jsonRes(200, { code: 50008, message: 'session expired' });
		}
		if (u.endsWith('/api/light_flood/canvas/get_voucher')) {
			return valid.includes(init.headers?.cookie) ? jsonRes(200, { code: 200, data: 'JWT-VOUCHER-xyz' }) : jsonRes(200, { code: 401 });
		}
		if (/aigclsp\.com\/$/.test(u)) { return jsonRes(200, '<html><script src="/assets/index-abc.js"></script></html>', 'text/html'); }
		if (u.endsWith('/assets/index-abc.js')) { return jsonRes(200, 'import("./assets/models-1.js");', 'text/javascript'); }
		if (u.endsWith('/assets/models-1.js')) {
			return jsonRes(200, '{name:"香蕉二号",value:"picture_banana_2"},{name:"新图模型",value:"picture_new_x"},{name:"视频H3",value:"video_minimax_h3"},{name:"语音",value:"audio_speech_28"}', 'text/javascript');
		}
		return jsonRes(404, 'nope', 'text/plain');
	};
	f.calls = calls;
	return f;
}
/** 假浏览器插件：`jar` 是浏览器里当前的 cookie；`afterOpen` 在打开登录页后若干次轮询再换成新 cookie。 */
function fakeBrowser({ jar = [], afterOpen = null, afterPolls = 2, headless = false } = {}) {
	let polls = 0;
	let opened = false;
	const b = {
		opens: [], closes: 0, reads: 0,
		loginSession: {
			headless,
			async open(name, url) { b.opens.push({ name, url }); opened = true; },
			async cookies(name) {
				b.reads++;
				if (opened && afterOpen && ++polls >= afterPolls) { jar = afterOpen; }
				return name === 'lightai' ? jar : [];
			},
			async close() { b.closes++; return { closed: true }; },
		},
	};
	return b;
}
const jarOf = (sid, uid) => [{ name: 'sessionid', value: sid, domain: '.aigclsp.com' }, { name: 'uid', value: uid, domain: '.aigclsp.com' }];
function leaks(value) {
	const keys = [];
	const strings = [];
	const walk = v => {
		if (v === null || v === undefined) { return; }
		if (typeof v === 'string') { strings.push(v); return; }
		if (typeof v !== 'object') { return; }
		for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
	};
	walk(value);
	return keys.some(k => /cookie|sessionid|token|secret|voucher|password/i.test(k)) || strings.some(s => SECRETS.some(x => s.includes(x)));
}
const fastSleep = () => new Promise(r => setTimeout(r, 1));

// ── ① k 参数 ────────────────────────────────────────────────────────────────
{
	const k = la.parseKParams(la.LIGHTAI_DEFAULTS.k);
	const want = { appId: '137', appName: '智能对话', bizId: '73', projectName: '萨罗斯GR项目' };
	if (JSON.stringify(k) !== JSON.stringify(want)) { fail(`① k 参数解析与扩展默认值不一致：${JSON.stringify(k)}`); }
	else if (la.LIGHTAI_DEFAULTS.floodApiBase !== 'https://lightai-lightflood-v1-sd.aigclsp.com' || la.LIGHTAI_DEFAULTS.apiBase !== 'https://aigclsp.com') { fail('① 服务地址默认值与扩展不一致 ✗'); }
	else { ok('① k 参数解析 / 服务地址默认值与 IDE 扩展一致'); }
}

// ── ② /api/user/check ──────────────────────────────────────────────────────
{
	const f = fakeLightAI();
	const r = await la.checkUser({ cookie: COOKIE, apiBase: 'https://aigclsp.com', floodApiBase: 'https://lightai-lightflood-v1-sd.aigclsp.com', fetchImpl: f });
	const c = f.calls[0];
	if (r.userId !== USER) { fail(`② 校验通过应回 userId：${JSON.stringify(r)}`); }
	if (c.url !== 'https://aigclsp.com/api/user/check' || c.method !== 'POST' || c.body !== '{"perm":"*"}'
		|| c.headers.origin !== 'https://lightai-lightflood-v1-sd.aigclsp.com' || c.headers.referer !== 'https://lightai-lightflood-v1-sd.aigclsp.com/' || c.headers.cookie !== COOKIE) {
		fail(`② 请求形状与扩展不一致：${JSON.stringify(c)}`);
	}
	const kind = async (mode, cookie = COOKIE) => {
		try { await la.checkUser({ cookie, apiBase: 'https://aigclsp.com', floodApiBase: 'https://x.aigclsp.com', fetchImpl: fakeLightAI({ mode }) }); return 'ok'; } catch (e) { return e.rejected ? 'rejected' : (e.restricted ? 'restricted' : 'transient'); }
	};
	if (await kind('ok', 'sessionid=bad; uid=bad') !== 'rejected') { fail('② code≠0（50008）应判为会话无效 ✗'); }
	if (await kind('restricted') !== 'restricted') { fail('② "没有访问权限"应判为网络受限（不是会话失效 ⇒ 不该让用户白白重登）✗'); }
	if (await kind('500') !== 'transient' || await kind('down') !== 'transient') { fail('② 5xx / 网络失败应判为临时问题 ✗'); }
	if (!failed('②')) { ok('② /api/user/check：请求形状对齐扩展；失效 / 网络受限 / 临时 三类分清'); }
}

// ── ③ 登录·复用浏览器里已有的会话 ─────────────────────────────────────────────
{
	const credentials = fakeCredentials({ [la.LIGHTAI_SIGNED_OUT_REF]: '1' });
	const br = fakeBrowser({ jar: jarOf(SID, UID) });
	const changes = [];
	const svc = la.createLightAIService({ credentials, browser: () => br, fetchImpl: fakeLightAI(), sleep: fastSleep, onChange: w => changes.push(w) });
	await svc.signIn();
	if (br.opens.length !== 0) { fail('③ 浏览器里已有有效会话时不该再开登录页 ✗'); }
	if (credentials.store.get(la.LIGHTAI_COOKIE_REF) !== COOKIE) { fail('③ 复用的会话没落盘 ✗'); }
	if (credentials.store.has(la.LIGHTAI_SIGNED_OUT_REF)) { fail('③ 用户主动登录后"主动登出"标记没撤 ✗'); }
	const st = await svc.status();
	if (st.signedIn !== true || st.userId !== USER || st.via !== 'browser-profile') { fail(`③ 复用登录后的状态不对：${JSON.stringify({ signedIn: st.signedIn, userId: st.userId, via: st.via })}`); }
	if (!changes.includes('signin')) { fail('③ 登录成功没触发 onChange ✗'); }
	if (!failed('③')) { ok('③ 浏览器里已有有效会话 ⇒ 不开页面直接登录（落盘 / 撤标记 / 通知）'); }
}

// ── ④ 登录·开页面（旧会话被拒 ⇒ 等新 cookie）──────────────────────────────────
{
	const credentials = fakeCredentials();
	const br = fakeBrowser({ jar: jarOf('sid-OLD', UID), afterOpen: jarOf(SID2, UID), afterPolls: 3 });
	const f = fakeLightAI({ valid: [COOKIE2] });
	const svc = la.createLightAIService({ credentials, browser: () => br, fetchImpl: f, sleep: fastSleep });
	await svc.signIn();
	const checks = f.calls.filter(c => c.url.endsWith('/api/user/check')).map(c => c.headers.cookie);
	if (br.opens.length !== 1 || br.opens[0].name !== 'lightai' || br.opens[0].url !== 'https://lightai-lightflood-v1-sd.aigclsp.com/flow?lang=zh_CN') { fail(`④ 应只开一次登录页，地址同扩展：${JSON.stringify(br.opens)}`); }
	if (checks.filter(c => c.includes('sid-OLD')).length !== 1) { fail(`④ 被拒的旧会话应只校验一次（之后等它变）——实际校验了 ${checks.filter(c => c.includes('sid-OLD')).length} 次 ✗`); }
	if (credentials.store.get(la.LIGHTAI_COOKIE_REF) !== COOKIE2) { fail('④ 新登录的会话没落盘 ✗'); }
	if (br.closes < 1) { fail('④ 登录完成后没关登录 tab ✗'); }
	if (!failed('④')) { ok('④ 旧会话被拒 ⇒ 开登录页 ⇒ cookie 变了才校验 ⇒ 落盘 + 关 tab'); }
}

// ── ⑤ 取消 / 没有浏览器插件 ────────────────────────────────────────────────
{
	const credentials = fakeCredentials();
	const br = fakeBrowser({ jar: [] });
	const svc = la.createLightAIService({ credentials, browser: () => br, fetchImpl: fakeLightAI(), sleep: () => new Promise(r => setTimeout(r, 10)), config: { loginTimeoutSeconds: 30 } });
	const started = Date.now();
	const p = svc.signIn().then(() => 'resolved', e => String(e?.message ?? e));
	await new Promise(r => setTimeout(r, 40));
	const during = await svc.status();
	const cancelled = svc.cancelSignIn();
	const result = await p;
	if (!during.signingIn || !(during.signInDeadline > Date.now())) { fail(`⑤ 登录中 status 应带 signingIn + 截止时刻：${JSON.stringify(during)}`); }
	if (!cancelled || !/已取消/.test(result) || Date.now() - started > 3000) { fail(`⑤ 取消没生效：${result}`); }
	if (credentials.store.size !== 0) { fail('⑤ 取消后居然落了盘 ✗'); }
	if (br.closes < 1) { fail('⑤ 取消后没关登录 tab ✗'); }
	const none = la.createLightAIService({ credentials: fakeCredentials(), browser: () => undefined, fetchImpl: fakeLightAI(), sleep: fastSleep });
	const err = await none.signIn().then(() => '', e => String(e?.message ?? e));
	if (!/浏览器插件/.test(err)) { fail(`⑤ 没有浏览器插件时应明说"需要浏览器插件"：${err}`); }
	if ((await none.status()).browserAvailable !== false) { fail('⑤ status 应如实报 browserAvailable=false（界面据此禁用登录按钮）✗'); }
	if (!failed('⑤')) { ok('⑤ 取消 ⇒ 立刻结束 / 不落盘 / 关 tab；没有浏览器插件 ⇒ 明说且状态如实'); }
}

// ── ⑥ 状态投影 / 失效 / stale / 缓存 ────────────────────────────────────────
{
	const session = JSON.stringify({ userId: USER, source: 'browser', signedInAt: 1 });
	const f = fakeLightAI();
	const svc = la.createLightAIService({ credentials: fakeCredentials({ [la.LIGHTAI_COOKIE_REF]: COOKIE, [la.LIGHTAI_SESSION_REF]: session }), browser: () => fakeBrowser(), fetchImpl: f });
	const st = await svc.status();
	await svc.status(); await svc.status();
	if (st.signedIn !== true || st.hasCredential !== true) { fail(`⑥ 有效会话应为已登录：${JSON.stringify(st).slice(0, 200)}`); }
	if (f.calls.filter(c => c.url.endsWith('/api/user/check')).length !== 1) { fail('⑥ 校验结果应缓存（设置页每次打开都打网关 ✗）'); }
	if (leaks(st)) { fail('⑥ 状态投影里漏出了 cookie 值 / 凭据键名 ✗'); }
	const exp = la.createLightAIService({ credentials: fakeCredentials({ [la.LIGHTAI_COOKIE_REF]: 'sessionid=bad; uid=bad', [la.LIGHTAI_SESSION_REF]: session }), fetchImpl: fakeLightAI() });
	const s2 = await exp.status();
	if (s2.signedIn !== false || s2.expired !== true || s2.userId) { fail(`⑥ 会话被拒应为未登录 + expired（且不再显示账号）：${JSON.stringify(s2).slice(0, 200)}`); }
	const down = la.createLightAIService({ credentials: fakeCredentials({ [la.LIGHTAI_COOKIE_REF]: COOKIE, [la.LIGHTAI_SESSION_REF]: session }), fetchImpl: fakeLightAI({ mode: 'down' }) });
	const s3 = await down.status();
	if (s3.signedIn !== true || s3.stale !== true || !s3.error) { fail(`⑥ 网络失败应为 stale（仍算已登录，不让用户白白重登）：${JSON.stringify(s3).slice(0, 200)}`); }
	if (!failed('⑥')) { ok('⑥ 状态投影无 cookie 值；失效 ⇒ expired；网络失败 ⇒ stale；校验结果有缓存'); }
}

// ── ⑦ 模型发现 ──────────────────────────────────────────────────────────────
{
	const d = await la.discoverModels({ floodApiBase: 'https://lightai-lightflood-v1-sd.aigclsp.com', cookie: COOKIE, fetchImpl: fakeLightAI() });
	if (!d || JSON.stringify(d.image) !== '["picture_banana_2","picture_new_x"]' || d.names.picture_new_x !== '新图模型') { fail(`⑦ bundle 解析不对：${JSON.stringify(d)}`); }
	const lists = la.buildModelLists(d);
	const audio = lists.audio.map(m => m.id);
	if (!audio.includes('seed_audio_1')) { fail('⑦ seed_audio_1（不符合 audio_ 前缀、永远发现不到）被丢了 ✗'); }
	const nx = lists.image.find(m => m.id === 'picture_new_x');
	const bn = lists.image.find(m => m.id === 'picture_banana_2');
	if (!nx || nx.routable !== false || !bn || bn.routable !== true || bn.name !== '香蕉二号') { fail(`⑦ routable / 名字不对：${JSON.stringify(lists.image)}`); }
	const def = la.buildModelLists(undefined);
	if (def.image.length !== 4 || def.video.length !== 2 || def.model3d.length !== 1 || def.audio.length !== 2) { fail('⑦ 默认清单与扩展默认值不一致 ✗'); }
	if (!failed('⑦')) { ok('⑦ 模型发现：bundle 解析 + 名字；发现不到的默认模型保住；routable 标记；默认清单对齐扩展'); }
}

// ── ⑧ 测试连接（get_voucher 请求头）──────────────────────────────────────────
{
	const f = fakeLightAI();
	const svc = la.createLightAIService({ credentials: fakeCredentials({ [la.LIGHTAI_COOKIE_REF]: COOKIE, [la.LIGHTAI_SESSION_REF]: JSON.stringify({ userId: USER }) }), fetchImpl: f });
	const st = await svc.test();
	const c = f.calls.find(x => x.url.endsWith('/get_voucher'));
	const h = c?.headers ?? {};
	if (!c || h.app_id !== '169' || h.biz_id !== '73' || h.version !== '1.0' || h['user-data'] !== Buffer.from(`${USER}-lightai`).toString('base64') || h.cookie !== COOKIE || h.referer !== 'https://lightai-lightflood-v1-sd.aigclsp.com/flow') {
		fail(`⑧ get_voucher 请求头与扩展不一致：${JSON.stringify(h)}`);
	}
	if (st.lastTest?.ok !== true) { fail(`⑧ 测试连接成功应记 lastTest.ok：${JSON.stringify(st.lastTest)}`); }
	if (leaks(st)) { fail('⑧ 测试结果里漏出了编排凭证 / cookie ✗'); }
	if (!failed('⑧')) { ok('⑧ 测试连接：get_voucher 请求头逐字对齐扩展；结果无凭证'); }
}

// ── ⑨ 自定义设置 / 迁移 / 登出 ─────────────────────────────────────────────
{
	const credentials = fakeCredentials();
	const svc = la.createLightAIService({ credentials, fetchImpl: fakeLightAI() });
	const bad = async patch => svc.setConfig(patch).then(() => false, () => true);
	if (!(await bad({ floodApiBase: 'http://x.aigclsp.com' })) || !(await bad({ floodApiBase: 'https://evil.example.com' })) || !(await bad({ userType: '' }))) {
		fail('⑨ 自定义设置没挡住 http / 非 aigclsp.com / 空值 ✗（服务地址决定 cookie 发往哪里）');
	}
	const st = await svc.setConfig({ floodApiBase: 'https://other.aigclsp.com/', company: '腾讯' });
	if (st.floodApiBase !== 'https://other.aigclsp.com' || st.company !== '腾讯') { fail(`⑨ 自定义设置没生效：${st.floodApiBase} / ${st.company}`); }
	// 迁移
	const imp = la.createLightAIService({ credentials: fakeCredentials(), fetchImpl: fakeLightAI() });
	if ((await imp.importSession({ cookie: 'foo=bar', userId: USER })).reason !== 'invalid') { fail('⑨ 迁移应拒绝格式不对的 cookie ✗'); }
	if ((await imp.importSession({ cookie: COOKIE, userId: USER })).imported !== true) { fail('⑨ 迁移没导入 ✗'); }
	if ((await imp.importSession({ cookie: COOKIE2, userId: USER })).reason !== 'already-signed-in') { fail('⑨ dsh 侧已有会话时迁移不该覆盖 ✗'); }
	const outCreds = fakeCredentials({ [la.LIGHTAI_SIGNED_OUT_REF]: '1' });
	const imp2 = la.createLightAIService({ credentials: outCreds, fetchImpl: fakeLightAI() });
	if ((await imp2.importSession({ cookie: COOKIE, userId: USER })).reason !== 'signed-out-by-user') { fail('⑨ 用户在 dsh 侧主动登出过 ⇒ 迁移必须拒绝（否则"登出不掉"）✗'); }
	// 登出
	const sc = fakeCredentials({ [la.LIGHTAI_COOKIE_REF]: COOKIE, [la.LIGHTAI_SESSION_REF]: JSON.stringify({ userId: USER, models: la.buildModelLists(undefined), modelsSource: 'discovered' }) });
	const so = la.createLightAIService({ credentials: sc, fetchImpl: fakeLightAI() });
	const after = await so.signOut({ byUser: true });
	if (sc.store.has(la.LIGHTAI_COOKIE_REF) || sc.store.get(la.LIGHTAI_SIGNED_OUT_REF) !== '1') { fail('⑨ 主动登出应清 cookie + 记标记 ✗'); }
	if (after.signedIn !== false || after.userId || JSON.parse(sc.store.get(la.LIGHTAI_SESSION_REF) ?? '{}').userId) { fail('⑨ 登出后不该还留着账号 ✗'); }
	if ((after.models?.image ?? []).length !== 4) { fail('⑨ 登出不该丢模型清单 ✗'); }
	if (!failed('⑨')) { ok('⑨ 自定义设置只收 https+aigclsp.com；迁移挡住格式错 / 已登录 / 主动登出过；登出清账号留清单'); }
}

// ── ⑩ 浏览器插件的登录会话（窄口子）─────────────────────────────────────────
{
	const commands = [];
	const opened = [];
	let closed = 0;
	const view = { openForLogin: async url => { opened.push(url); return { targetId: 'T1' }; }, closeOwnedPage: async () => { closed++; } };
	const baseClient = { forSession: key => { view.key = key; return view; } };
	const browserCommand = async (method, params) => {
		commands.push({ method, params });
		if (method === 'Storage.getCookies') {
			return { cookies: [
				{ name: 'sessionid', value: SID, domain: '.aigclsp.com' },
				{ name: 'uid', value: UID, domain: 'lightai-lightflood-v1-sd.aigclsp.com' },
				{ name: 'other', value: 'x', domain: '.aigclsp.com' },
				{ name: 'sessionid', value: 'evil', domain: '.notaigclsp.com' },
				{ name: 'sessionid', value: 'g', domain: '.google.com' },
			] };
		}
		return {};
	};
	const svc = ls.createLoginSessions({ baseClient, browserCommand, headless: false });
	const url = 'https://lightai-lightflood-v1-sd.aigclsp.com/flow?lang=zh_CN';
	await svc.open('lightai', url);
	if (opened[0] !== url || view.key !== 'vssaros-login:lightai' || !commands.some(c => c.method === 'Target.activateTarget' && c.params.targetId === 'T1')) { fail(`⑩ 开登录页：地址 / 专属 tab 键 / 切到前台 不对：${JSON.stringify({ opened, key: view.key })}`); }
	const got = await svc.cookies('lightai', url);
	if (JSON.stringify(got.map(c => c.name + '=' + c.value).sort()) !== JSON.stringify([`sessionid=${SID}`, `uid=${UID}`])) { fail(`⑩ 只该回登记站点的登记 cookie：${JSON.stringify(got)}`); }
	const rej = async fn => fn().then(() => false, () => true);
	if (!(await rej(() => svc.cookies('github', 'https://github.com/')))) { fail('⑩ 没登记的站点也能读 cookie ✗'); }
	if (!(await rej(() => svc.cookies('lightai', 'https://evil.example.com/')))) { fail('⑩ 登记站点之外的域名也能读 ✗'); }
	if (!(await rej(() => svc.open('lightai', 'http://lightai-lightflood-v1-sd.aigclsp.com/')))) { fail('⑩ 非 https 登录页也能开 ✗'); }
	const hl = ls.createLoginSessions({ baseClient, browserCommand, headless: true });
	const msg = await hl.open('lightai', url).then(() => '', e => String(e?.message ?? e));
	if (!/无头/.test(msg)) { fail('⑩ 无头模式下开登录页应明说（不能假装在等用户登录）✗'); }
	await svc.close('lightai');
	if (closed !== 1) { fail('⑩ close 没关自己开的那个 tab ✗'); }
	if (!/loginSession,/.test(browserIdx) || !/createLoginSessions\(\{/.test(browserIdx)) { fail('⑩ 浏览器插件没把 loginSession 放进 vssarosBrowser 服务 ✗'); }
	const bpkg = JSON.parse(read('dsh-plugins/vssaros-browser/package.json'));
	if (!bpkg.files.includes('lib/core/loginSession.js')) { fail('⑩ 浏览器插件 files 没列 loginSession.js ⇒ 装出来的插件缺文件 ✗'); }
	if (!failed('⑩')) { ok('⑩ 浏览器插件登录会话：登记站点 / 登记 cookie 名 / https / 专属 tab / 切前台 / 无头明说 / 已接进服务'); }
}

// ── ⑪ 真跑 apply()：HTTP 面 ─────────────────────────────────────────────────
{
	const routes = [];
	const credentials = fakeCredentials({ [la.LIGHTAI_COOKIE_REF]: COOKIE, [la.LIGHTAI_SESSION_REF]: JSON.stringify({ userId: USER }) });
	const realFetch = globalThis.fetch;
	globalThis.fetch = fakeLightAI();
	const ctx = {
		webServer: { register: r => { routes.push(r); return () => { }; }, port: 7000, host: '127.0.0.1' },
		connection: { requestRejection: () => 0, authenticatedUrl: u => u },
		settings: { describe: () => [], mutate: async () => { } },
		credentials,
		llm: {}, tools: { register: () => () => { } }, agents: {}, sessionController: {}, workspaceRegistry: {},
		effect: fn => { try { fn(); } catch { /* 可选服务 */ } },
		on: () => () => { }, inject: () => { }, provide: () => { }, get: () => undefined,
	};
	try {
		const bridge = await import(pathToFileURL(join(repo, indexRel)).href);
		try { bridge.apply(ctx, {}); } catch (e) { fail(`⑪ apply() 抛错：${String(e?.message ?? e)}`); }
		const route = routes.find(r => r.path === '/x/vssaros-bridge');
		const call = (method, url, body) => new Promise(done => {
			const listeners = {};
			const req = { method, url, headers: {}, on: (ev, fn) => { listeners[ev] = fn; return req; }, destroy() { } };
			const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b ?? ''; done(this); } };
			route.handler(req, res);
			setTimeout(() => { if (body !== undefined) { listeners.data?.(Buffer.from(body)); } listeners.end?.(); }, 5);
		});
		if (!route) { fail('⑪ apply() 没注册 /x/vssaros-bridge 前缀路由 ✗'); }
		else {
			const st = await call('GET', '/x/vssaros-bridge/api/lightai/status');
			const body = JSON.parse(st.body || '{}');
			if (st.code !== 200 || body.ok !== true || body.status?.signedIn !== true || body.status?.userId !== USER) { fail(`⑪ GET lightai/status 不对：${st.code} ${st.body.slice(0, 160)}`); }
			if (leaks(body)) { fail('⑪ HTTP 状态回执漏出 cookie 值 ✗'); }
			if ((await call('GET', '/x/vssaros-bridge/api/lightai/signout')).code !== 405) { fail('⑪ 写操作用 GET 应 405 ✗（否则一个 <img src> 就能把用户登出）'); }
			if ((await call('GET', '/x/vssaros-bridge/api/lightai/nope')).code !== 404) { fail('⑪ 未知操作应 404 ✗'); }
			const badCfg = await call('POST', '/x/vssaros-bridge/api/lightai/config', JSON.stringify({ floodApiBase: 'https://evil.example.com' }));
			if (badCfg.code !== 400) { fail(`⑪ 非法服务地址应 400（实际 ${badCfg.code}）`); }
			const goodCfg = await call('POST', '/x/vssaros-bridge/api/lightai/config', JSON.stringify({ company: '腾讯' }));
			if (goodCfg.code !== 200 || JSON.parse(goodCfg.body).status?.company !== '腾讯') { fail(`⑪ 合法配置应 200 且生效：${goodCfg.code} ${goodCfg.body.slice(0, 120)}`); }
			if ((await call('GET', '/x/vssaros-bridge/api/codebuddy/status')).code !== 200) { fail('⑪ 加 LightAI 路由把 CodeBuddy 的 HTTP 面弄坏了 ✗'); }
			if ((await call('GET', '/x/vssaros-bridge/api/tof/status')).code !== 200) { fail('⑪ 加 LightAI 路由把 TOF 的 HTTP 面弄坏了 ✗'); }
		}
	} finally {
		globalThis.fetch = realFetch;
	}
	if (!failed('⑪')) { ok('⑪ 真跑 apply()：status 200 / 写仅 POST / 未知 404 / config 校验 400 / 无 cookie 值 / CodeBuddy·TOF 照旧'); }
}

// ── ⑫ 接线（源码级）─────────────────────────────────────────────────────────
{
	if (!/case 'lightai\.status':/.test(indexSrc) || !/case 'lightai\.import':[\s\S]{0,400}lightai\.importSession\(\{ cookie: p\.cookie, userId: p\.userId \}\)/.test(indexSrc)) { fail("⑫ 桥插件没分发 lightai.status / lightai.import ✗"); }
	if (!/ctx\.inject\?\.\(\['vssarosBrowser'\]/.test(indexSrc)) { fail('⑫ 桥插件没以**可选**方式取浏览器插件服务（硬依赖会让浏览器插件不在时整个桥插件 pending）✗'); }
	if (!/LightAIStatus = 'lightai\.status'/.test(protoSrc) || !/LightAIImport = 'lightai\.import'/.test(protoSrc)) { fail('⑫ 协议枚举缺 LightAI 方法 ✗'); }
	if (!/LightAIStatus = 'lightAIStatus'/.test(harnessSrc) || !/LightAIImport = 'lightAIImport'/.test(harnessSrc)) { fail('⑫ 通道命令枚举缺 LightAI ✗'); }
	if (!/case DshHarnessChannelCommand\.LightAIImport:[\s\S]{0,400}validateLightAIImportArgs\(arg\)/.test(channelSrc)) { fail('⑫ 主进程转发 lightai.import 前没校验负载 ✗'); }
	if (!/getValue<string>\('lightai\.cookie'\)/.test(syncSrc) || !/status\.hasCredential \|\| status\.signedOutByUser/.test(syncSrc) || !/void this\._migrateLightAI\(\)/.test(syncSrc)) { fail('⑫ IDE 一次性迁移缺失 / 没挡住"已有会话 / 主动登出过" / 挡在了 provider 同步路径上 ✗'); }
	const bpkg = JSON.parse(read('dsh-plugins/vssaros-bridge/package.json'));
	if (!bpkg.files.includes('lib/lightai.js')) { fail('⑫ 桥插件 files 没列 lib/lightai.js ⇒ 装出来的插件起不来 ✗'); }
	if (!failed('⑫')) { ok('⑫ 接线：桥方法 / 可选取浏览器服务 / 协议 / 主进程校验 / IDE 一次性迁移 / 包清单'); }
}

// ── ⑬ 页面卡片（真装载 chunk）──────────────────────────────────────────────
{
	let captured = null;
	const reactStub = {
		useState: v => [typeof v === 'function' ? v() : v, () => { }],
		useEffect() { }, useRef: () => ({ current: null }),
		createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
	};
	new Function('window', chunkSrc)({ __ModuleLoader__: { load: m => { captured = m; } } });
	const t = captured.factory(() => reactStub).__test;
	const cases = [[null, 'unknown'], [{ signingIn: true }, 'pending'], [{ signedIn: true }, 'in'], [{ signedIn: true, stale: true }, 'in'], [{ expired: true }, 'expired'], [{ error: '登录超时' }, 'error'], [{ error: '已取消登录' }, 'out'], [{}, 'out']];
	for (const [s, want] of cases) { if (t.laState(s) !== want) { fail(`⑬ laState(${JSON.stringify(s)}) 应为 ${want}，实际 ${t.laState(s)}`); } }
	const render = status => {
		t.laStore.available = true; t.laStore.status = status; t.laStore.lastFetch = Date.now(); t.laStore.busy = '';
		const out = t.LightAICard();
		const buttons = [];
		const texts = [];
		const walk = n => {
			if (n === null || n === undefined || n === false) { return; }
			if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return; }
			if (typeof n.type === 'function') { walk(n.type(n.props)); return; }
			if (n.type === 'button') { buttons.push({ label: n.children.filter(c => typeof c === 'string').join(''), disabled: !!n.props.disabled }); }
			for (const c of n.children || []) { walk(c); }
		};
		walk(out);
		return { out, buttons, text: texts.join(' ') };
	};
	const base = { browserAvailable: true, models: la.buildModelLists(undefined), modelsSource: 'default', appName: '智能对话', projectName: '萨罗斯GR项目' };
	const signedOut = render({ ...base, signedIn: false });
	const login = signedOut.buttons.find(b => b.label === '登录');
	if (!login || login.disabled) { fail(`⑬ 未登录时应有可点的「登录」：${JSON.stringify(signedOut.buttons)}`); }
	const noBrowser = render({ ...base, signedIn: false, browserAvailable: false });
	if (!noBrowser.buttons.find(b => b.label === '登录')?.disabled || !/浏览器插件/.test(noBrowser.text)) { fail('⑬ 没有浏览器插件时「登录」应禁用并说明原因（点了没反应 ✗）'); }
	const pending = render({ ...base, signingIn: true, signInDeadline: Date.now() + 60_000 });
	if (!pending.buttons.some(b => b.label === '取消') || !/最长等待 [01]:\d\d/.test(pending.text)) { fail(`⑬ 登录中应有「取消」与倒计时：${pending.text.slice(0, 120)}`); }
	const signedIn = render({ ...base, signedIn: true, userId: USER, via: 'browser' });
	const labels = signedIn.buttons.map(b => b.label);
	for (const want of ['获取模型', '测试连接', '登出']) { if (!labels.includes(want)) { fail(`⑬ 已登录时缺「${want}」：${JSON.stringify(labels)}`); } }
	if (!/zijianqiu@tencent\.com/.test(signedIn.text) || !/萨罗斯GR项目/.test(signedIn.text)) { fail('⑬ 已登录时没显示账号 / 项目 ✗'); }
	if (!labels.some(l => /^图片 4$/.test(l)) || !labels.some(l => /^音频 2$/.test(l))) { fail(`⑬ 已登录时应有按类别的模型数：${JSON.stringify(labels)}`); }
	const expired = render({ ...base, signedIn: false, expired: true, error: 'LightAI 登录已失效，请重新登录' });
	if (!expired.buttons.some(b => b.label === '重新登录')) { fail('⑬ 登录失效时应有「重新登录」✗'); }
	if (t.laState(null) === 'unknown' && render(null).out !== null) { fail('⑬ 没拿到状态时不该出卡片 ✗'); }
	if (!failed('⑬')) { ok('⑬ 页面卡片：状态映射 / 未登录·登录中·已登录·失效 各自的按钮 / 无浏览器插件禁用登录并说明'); }
}

if (problems.length) {
	console.error(`\n[check-dsh-lightai] ✗ ${problems.length} 处问题：`);
	for (const p of problems) { console.error(`  - ${p}`); }
	process.exit(1);
}
console.log('\n[check-dsh-lightai] ✓ LightAI dsh 侧实现：登录（浏览器插件）/ 校验 / 模型 / 测试 / 配置 / 迁移 / HTTP / 页面卡片全部通过');
process.exit(0);
