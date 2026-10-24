#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * check-dsh-tof-owned.mjs — 守卫：企业身份（TOF/OA）**归 dsh 侧持有、IDE 只读**（2026-10-22）。
 *
 * 用户原话："登录也转移到 dsh 侧实现，ide 侧仅读取状态"。
 *
 * **行为断言为主**（假凭据 + 假 whoami + 假"浏览器"——它直接去敲 loopback 回调 ⇒ 不联网、不开浏览器）：
 *   ① 登录全链路：开浏览器（URL 带 cb_port/state）→ 回调 → whoami ⇒ 票落本地 ref、身份缓存、onChange 触发、
 *      "主动登出"标记被撤；登录中 status 带 signingIn + 截止时刻；
 *   ② 取消：登录中 cancelSignIn() ⇒ 立刻以"已取消"结束（不干等 180s）、不落票；
 *   ③ 状态缓存：60s 内不重复打网关；登出后作废；网关临时失败（stale）不缓存；
 *   ④ 过期：网关 401 ⇒ signedIn=false + expired（**不**当已登录、**不**自动重登）；
 *   ⑤ 用户主动登出：两份票都清 + 记标记 ⇒ status.signedOutByUser；回执 / status 不含票据；
 *   ⑥ 真跑 apply()：HTTP `/x/vssaros-bridge/api/tof/*`（status 200 / 写操作仅 POST / 未知 404 / 无票据）；
 *   ⑦ 桥接线（源码级）：tof.status/signin/signout/ticket 分发、tof.sync 在"主动登出"后拒收、
 *      登录态变化反向通知 tof.changed；协议枚举与之一致；
 *   ⑧ IDE 侧（源码级）：自动重登已删；dsh 镜像实现注册覆盖；主进程就地应答 tof.changed 并广播；
 *      dsh 持有时不再 tof.sync 回推；页面账号行走 HTTP 面。
 *
 * 判据纪律：绝对期望值；采集面缺失直接失败；改完必须做**反向突变**。
 * 用法：node dsh-plugins/check-dsh-tof-owned.mjs
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const tofRel = 'dsh-plugins/vssaros-bridge/lib/tof.js';
const indexRel = 'dsh-plugins/vssaros-bridge/lib/index.js';
const indexSrc = code(read(indexRel));
const protoSrc = code(read('src/vs/sessions/contrib/dshHarness/common/dshBridgeProtocol.ts'));
const harnessSrc = code(read('src/vs/sessions/contrib/dshHarness/common/dshHarness.ts'));
const channelSrc = code(read('src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts'));
const legacySrc = code(read('src/vs/sessions/contrib/agentStudio/browser/tofAuthService.ts'));
const mirrorSrc = code(read('src/vs/sessions/contrib/dshHarness/electron-browser/dshTofAuthService.ts'));
const contribSrc = code(read('src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts'));
const serviceSrc = code(read('src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts'));
const accountSrc = code(read('dsh-plugins/vssaros-chat-surface/lib/client.account.js'));
if (!indexSrc || !protoSrc || !mirrorSrc || !accountSrc) {
	console.error('[check-dsh-tof-owned] ✗ 采集面缺失 —— 不能当通过');
	process.exit(1);
}
const tof = await import(pathToFileURL(join(repo, tofRel)).href);

// ── 假件 ────────────────────────────────────────────────────────────────────
const TICKET = 'tof-ticket-AAAAAAAAAAAAAAAAAAAA';
const TICKET_IDE = 'tof-ticket-IDE-BBBBBBBBBBBBBBBBB';
const IDE_REF = 'VSSAROS_TOF_TICKET';
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
function fakeWhoami(mode = { kind: 'ok' }) {
	const fn = async (ticket) => {
		fn.calls++;
		if (mode.kind === 'reject') { throw new Error('网关拒绝了凭据（401）：ticket expired'); }
		if (mode.kind === 'down') { throw new Error('whoami 请求失败：connect ECONNREFUSED'); }
		return { user_id: 'taihu:staffid:12345', staff_id: '12345', login_name: 'zijianqiu', team: 'SAROS', is_admin: false, expires_at: '2099-01-01T00:00:00Z', _t: ticket };
	};
	fn.calls = 0;
	return fn;
}
/** 假浏览器：拿到登录 URL 后直接去敲本地回调（带对的 state 与票据）。 */
function fakeBrowser({ hit = true } = {}) {
	const fn = async (url) => {
		fn.urls.push(url);
		if (!hit) { return; }
		const inner = new URL(decodeURIComponent(new URL(url).searchParams.get('url')));
		const port = inner.searchParams.get('cb_port');
		const state = inner.searchParams.get('state');
		setTimeout(() => {
			http.get(`http://127.0.0.1:${port}/got?identity=${encodeURIComponent(TICKET)}&state=${encodeURIComponent(state)}`, res => res.resume()).on('error', () => { });
		}, 30);
	};
	fn.urls = [];
	return fn;
}
function leaks(value, secrets) {
	const keys = [];
	const strings = [];
	const walk = v => {
		if (v === null || v === undefined) { return; }
		if (typeof v === 'string') { strings.push(v); return; }
		if (typeof v !== 'object') { return; }
		for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
	};
	walk(value);
	return keys.some(k => /ticket|identity|secret|token|passport/i.test(k)) || strings.some(s => secrets.includes(s));
}

// ── ① 登录全链路 ────────────────────────────────────────────────────────────
{
	const credentials = fakeCredentials({ [tof.TOF_SIGNED_OUT_REF]: '1' });
	const changes = [];
	const browser = fakeBrowser();
	const svc = tof.createTofService({ credentials, ideCredentialRef: IDE_REF, whoami: fakeWhoami(), openUrl: browser, onChange: w => changes.push(w), config: { timeoutSeconds: 20 } });
	const p = svc.signIn();
	await new Promise(r => setTimeout(r, 5));
	const during = await svc.status();
	const out = await p;
	if (!during.signingIn || !(during.signInDeadline > Date.now())) { fail(`① 登录中 status 应带 signingIn + 截止时刻：${JSON.stringify(during)}`); }
	if (browser.urls.length !== 1 || !/passport\.woa\.com/.test(browser.urls[0]) || !/cb_port%3D\d+/.test(browser.urls[0])) { fail(`① 开浏览器的 URL 不对：${browser.urls[0]}`); }
	if (credentials.store.get(tof.TOF_LOCAL_CREDENTIAL_REF) !== TICKET) { fail('① 登录后票据没落到 dsh 本地 ref ✗'); }
	if (credentials.store.has(tof.TOF_SIGNED_OUT_REF)) { fail('① 用户主动登录后"主动登出"标记没撤 ⇒ IDE 的一次性迁移会一直被拒 ✗'); }
	if (!changes.includes('signin')) { fail('① 登录成功没触发 onChange ⇒ IDE 不会立刻知道 ✗'); }
	if (out.signedIn !== true || out.loginName !== 'zijianqiu' || out.userId !== 'taihu:staffid:12345') { fail(`① 登录回执不对（userId 必须原样带过去）：${JSON.stringify(out)}`); }
	if (leaks(out, [TICKET])) { fail('① 登录回执漏出了票据 ✗'); }
	const after = await svc.status();
	if (after.signingIn || after.signedIn !== true || after.hasCredential !== true) { fail(`① 登录后 status 不对：${JSON.stringify(after)}`); }
	if (!problems.some(x => x.startsWith('①'))) { ok('① 登录全链路：开浏览器 → 回调 → whoami ⇒ 落票 / 撤标记 / 通知 / 登录中可见'); }
}

// ── ② 取消 ──────────────────────────────────────────────────────────────────
{
	const credentials = fakeCredentials();
	// 登录超时给 3s：取消若失效，登录要等到超时才结束 ⇒ 下面"5s 内结束"必然失败、且守卫不会挂死 ✓
	//   （给 120s 时，取消失效会让守卫干等两分钟 ⇒ 调用方先超时、突变脚本来不及还原文件 ✗，实测踩过）
	const svc = tof.createTofService({ credentials, ideCredentialRef: IDE_REF, whoami: fakeWhoami(), openUrl: fakeBrowser({ hit: false }), config: { timeoutSeconds: 3 } });
	const started = Date.now();
	const p = svc.signIn().then(() => 'resolved', e => String(e?.message ?? e));
	await new Promise(r => setTimeout(r, 50));
	const cancelled = svc.cancelSignIn();
	const result = await p;
	if (!cancelled || !/已取消/.test(result) || Date.now() - started > 2000) { fail(`② 取消没生效：cancelled=${cancelled} result=${result}`); }
	else if (credentials.store.size !== 0) { fail('② 取消后居然落了票 ✗'); }
	else if ((await svc.status()).signingIn) { fail('② 取消后 status 仍是"登录中" ✗'); }
	else { ok('② 取消 ⇒ 立刻结束（不干等超时）、不落票、不再"登录中"'); }
}

// ── ③ 状态缓存 ──────────────────────────────────────────────────────────────
{
	let clock = 1_000_000;
	const who = fakeWhoami();
	const credentials = fakeCredentials({ [tof.TOF_LOCAL_CREDENTIAL_REF]: TICKET });
	const svc = tof.createTofService({ credentials, ideCredentialRef: IDE_REF, whoami: who, now: () => clock });
	await svc.status(); await svc.status(); await svc.status();
	if (who.calls !== 1) { fail(`③ 60s 内应只打一次网关（实际 ${who.calls} 次）——设置页轮询会把网关打爆 ✗`); }
	clock += 61_000;
	await svc.status();
	if (who.calls !== 2) { fail(`③ 缓存过期后应重查（实际 ${who.calls} 次）`); }
	await svc.status({ fresh: true });
	if (who.calls !== 3) { fail('③ fresh: true 应跳过缓存 ✗'); }
	await svc.signOut({});
	const st = await svc.status();
	if (st.signedIn !== false) { fail('③ 登出后 status 仍是缓存里的"已登录" ⇒ 缓存没作废 ✗'); }
	const down = fakeWhoami({ kind: 'down' });
	const svc2 = tof.createTofService({ credentials: fakeCredentials({ [tof.TOF_LOCAL_CREDENTIAL_REF]: TICKET }), ideCredentialRef: IDE_REF, whoami: down, now: () => clock });
	await svc2.status(); await svc2.status();
	if (down.calls !== 2) { fail('③ 网关临时失败（stale）不该被缓存 ⇒ 下次要再试 ✗'); }
	if (!problems.some(x => x.startsWith('③'))) { ok('③ 状态缓存：60s 内只打一次网关 / 过期重查 / fresh 跳过 / 登出作废 / stale 不缓存'); }
}

// ── ④ 过期（401）⇒ 未登录 ─────────────────────────────────────────────────────
{
	const svc = tof.createTofService({ credentials: fakeCredentials({ [IDE_REF]: TICKET_IDE }), ideCredentialRef: IDE_REF, whoami: fakeWhoami({ kind: 'reject' }) });
	const st = await svc.status();
	if (st.signedIn !== false || st.expired !== true || st.hasCredential !== true) {
		fail(`④ 网关拒票（401）应为 signedIn=false + expired + hasCredential：${JSON.stringify(st)}（当成已登录 ⇒ 商城 / 反馈全拿着死票去请求 ✗）`);
	} else if (leaks(st, [TICKET_IDE])) {
		fail('④ 过期 status 漏出了票据 ✗');
	} else {
		ok('④ 网关 401 ⇒ 未登录 + expired（不当已登录、不自动重登）');
	}
}

// ── ⑤ 用户主动登出 ──────────────────────────────────────────────────────────
{
	const credentials = fakeCredentials({ [tof.TOF_LOCAL_CREDENTIAL_REF]: TICKET, [IDE_REF]: TICKET_IDE });
	const changes = [];
	const svc = tof.createTofService({ credentials, ideCredentialRef: IDE_REF, whoami: fakeWhoami(), onChange: w => changes.push(w) });
	const out = await svc.signOut({ all: true, byUser: true });
	const st = await svc.status();
	if (credentials.store.has(tof.TOF_LOCAL_CREDENTIAL_REF) || credentials.store.has(IDE_REF)) { fail('⑤ 主动登出没把两份票都清掉 ✗'); }
	else if (credentials.store.get(tof.TOF_SIGNED_OUT_REF) !== '1' || st.signedOutByUser !== true) { fail('⑤ 主动登出没记标记 ⇒ IDE 下次启动会把旧扩展里的票迁回来（登出不掉）✗'); }
	else if (!changes.includes('signout')) { fail('⑤ 登出没触发 onChange ✗'); }
	else if (leaks(out, [TICKET, TICKET_IDE]) || leaks(st, [TICKET, TICKET_IDE])) { fail('⑤ 登出回执 / status 漏出了票据 ✗'); }
	else { ok('⑤ 主动登出 ⇒ 两份票都清 + 记标记 + 通知；回执无票据'); }
}

// ── ⑥ 真跑 apply()：HTTP 面 ─────────────────────────────────────────────────
{
	const routes = [];
	const credentials = fakeCredentials({ [tof.TOF_LOCAL_CREDENTIAL_REF]: TICKET, [tof.TOF_IDENTITY_CREDENTIAL_REF]: JSON.stringify({ signedIn: true, loginName: 'zijianqiu', staffId: '12345' }) });
	const ctx = {
		webServer: { register: r => { routes.push(r); return () => { }; }, port: 7000, host: '127.0.0.1' },
		connection: { requestRejection: () => 0, authenticatedUrl: u => u },
		settings: { get: () => ({}), set: async () => { }, getValue: () => undefined, watch: () => () => { } },
		credentials,
		llm: { listProviders: () => [], listModels: async () => [] },
		tools: { register: () => () => { } },
		agents: {}, sessionController: {}, workspaceRegistry: {},
		effect: fn => { try { fn(); } catch { /* 可选服务 */ } },
		on: () => () => { },
		inject: () => { },
		provide: () => { },
		get: () => undefined,
	};
	const bridge = await import(pathToFileURL(join(repo, indexRel)).href);
	try { bridge.apply(ctx, { tof: { gatewayBaseUrl: 'http://127.0.0.1:1' } }); } catch (e) { fail(`⑥ apply() 抛错：${String(e?.message ?? e)}`); }
	const route = routes.find(r => r.path === '/x/vssaros-bridge');
	const call = (method, url) => new Promise(done => {
		const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b ?? ''; done(this); } };
		route.handler({ method, url, headers: {} }, res);
	});
	if (!route) {
		fail('⑥ apply() 没注册 /x/vssaros-bridge 前缀路由 ✗');
	} else {
		const st = await call('GET', '/x/vssaros-bridge/api/tof/status');
		let body = {};
		try { body = JSON.parse(st.body); } catch { /* 下面断言会报 */ }
		if (st.code !== 200 || body?.ok !== true || typeof body?.status?.signedIn !== 'boolean') { fail(`⑥ GET tof/status 应 200 + 状态投影：code=${st.code} body=${st.body.slice(0, 200)}`); }
		if (leaks(body, [TICKET])) { fail('⑥ HTTP tof/status 回执漏出了票据 ✗'); }
		const wrong = await call('GET', '/x/vssaros-bridge/api/tof/signout');
		if (wrong.code !== 405) { fail(`⑥ 写操作用 GET 应 405（实际 ${wrong.code}）——否则一个 <img src> 就能把用户登出 ✗`); }
		const unknown = await call('GET', '/x/vssaros-bridge/api/tof/nope');
		if (unknown.code !== 404) { fail(`⑥ 未知操作应 404（实际 ${unknown.code}）`); }
		const out = await call('POST', '/x/vssaros-bridge/api/tof/signout');
		if (out.code !== 200 || credentials.store.has(tof.TOF_LOCAL_CREDENTIAL_REF) || credentials.store.get(tof.TOF_SIGNED_OUT_REF) !== '1') {
			fail(`⑥ POST tof/signout 应清票 + 记"主动登出"：code=${out.code}`);
		}
		const cb = await call('GET', '/x/vssaros-bridge/api/codebuddy/status');
		if (cb.code !== 200) { fail('⑥ 加 TOF 路由把 CodeBuddy 的 HTTP 面弄坏了 ✗'); }
		if (!problems.some(x => x.startsWith('⑥'))) { ok('⑥ 真跑 apply()：tof/status 200 / 写操作仅 POST / 未知 404 / 登出记标记 / 无票据 / CodeBuddy 照旧'); }
	}
}

// ── ⑦ 桥接线（源码级）─────────────────────────────────────────────────────────
{
	for (const m of ['tof.status', 'tof.signin', 'tof.signout', 'tof.ticket']) {
		if (!new RegExp(`case '${m.replace('.', '\\.')}':`).test(indexSrc)) { fail(`⑦ 桥插件没分发 ${m} ✗`); }
	}
	if (!/case 'tof\.signout':[\s\S]{0,400}signOut\(\{\s*all:\s*true,\s*byUser:\s*true\s*\}\)/.test(indexSrc)) { fail('⑦ 桥方法 tof.signout 必须 all:true + byUser:true（IDE 的退出登录 = 用户主动登出）✗'); }
	if (!/signedOutByUser === true[\s\S]{0,160}ignored: 'signed-out-by-user'/.test(indexSrc)) { fail('⑦ tof.sync 在用户主动登出后必须拒收 IDE 推来的票（否则 IDE 一启动就把旧票导回来 ⇒ 登出不掉）✗'); }
	if (!/onChange:\s*why\s*=>\s*notifyTofChanged\(why\)/.test(indexSrc) || !/callIDE\('tof\.changed'/.test(indexSrc)) { fail('⑦ 登录态变化没反向通知 IDE（tof.changed）⇒ IDE 不会立刻刷新 ✗'); }
	if (!/for \(const info of clients\.values\(\)\)[\s\S]{0,200}instanceId: info\.instanceId/.test(indexSrc)) { fail('⑦ tof.changed 必须发给**每个** IDE 客户端（callIDE 默认只发第一个）✗'); }
	const methods = { TofStatus: 'tof.status', TofSignIn: 'tof.signin', TofSignOut: 'tof.signout', TofTicket: 'tof.ticket' };
	for (const [k, v] of Object.entries(methods)) {
		if (!new RegExp(`${k} = '${v.replace('.', '\\.')}'`).test(protoSrc)) { fail(`⑦ 协议枚举缺 ${k} = '${v}' ✗`); }
	}
	if (!/TofChanged = 'tof\.changed'/.test(protoSrc)) { fail("⑦ 反向方法枚举缺 TofChanged = 'tof.changed' ✗"); }
	if (!problems.some(x => x.startsWith('⑦'))) { ok('⑦ 桥接线：四条方法分发 / 主动登出语义 / tof.sync 拒收 / 广播 tof.changed / 协议对账'); }
}

// ── ⑧ IDE 侧（源码级）─────────────────────────────────────────────────────────
{
	if (/_reloginIfExpired|Auto re-login|this\.login\(\)/.test(legacySrc.replace(/async login\(\)[\s\S]*?\n\t\}/, ''))) {
		fail('⑧ IDE TofAuthService 里还留着"票过期就自动开浏览器重登"（用户：IDE 侧只读状态）✗');
	}
	if (!/readonly holder = 'ide'/.test(legacySrc)) { fail("⑧ 旧实现没声明 holder = 'ide' ✗"); }
	if (!/registerSingleton\(ITofAuthService, DshTofAuthService, InstantiationType\.Delayed\)/.test(contribSrc)) { fail('⑧ 桌面版没用 DshTofAuthService 覆盖注册 ⇒ IDE 仍自己登录 ✗'); }
	if (!/DshHarnessChannelCommand\.TofSignIn/.test(mirrorSrc) || !/DshHarnessChannelCommand\.TofSignOut/.test(mirrorSrc) || !/DshHarnessChannelCommand\.TofTicket/.test(mirrorSrc)) { fail('⑧ 镜像实现没把登录 / 登出 / 取票交给 dsh ✗'); }
	if (!/DshHarnessChannelEvent\.OnDidChangeTof/.test(mirrorSrc)) { fail('⑧ 镜像实现没听 tof.changed ⇒ dsh 页面登录后 IDE 不刷新 ✗'); }
	if (!/method not found/i.test(mirrorSrc)) { fail('⑧ 镜像实现没识别老 Host（method not found）⇒ 版本错配时登录整个消失 ✗'); }
	if (/IDshHarnessService/.test(mirrorSrc)) { fail('⑧ 镜像实现依赖了 IDshHarnessService ⇒ 与它互相依赖成环 ✗'); }
	if (!/request\.method === DshBridgeReverseMethod\.TofChanged[\s\S]{0,200}_handleTofChanged\(\)/.test(channelSrc) || !/DshHarnessChannelEvent\.OnDidChangeTof[\s\S]{0,80}_onDidChangeTof\.event/.test(channelSrc)) {
		fail('⑧ 主进程没就地应答 tof.changed 并广播给渲染进程（落进 IDE 能力闸会被拒）✗');
	}
	for (const c of ['TofStatus', 'TofSignIn', 'TofSignOut', 'TofTicket']) {
		if (!new RegExp(`case DshHarnessChannelCommand\\.${c}:`).test(channelSrc)) { fail(`⑧ 主进程通道没处理 ${c} ✗`); }
	}
	if (!/OnDidChangeTof = 'onDidChangeTof'/.test(harnessSrc)) { fail('⑧ 通道事件枚举缺 OnDidChangeTof ✗'); }
	if (!/this\._tofAuth\.holder === 'dsh'[\s\S]{0,160}changed: false/.test(serviceSrc)) { fail('⑧ dsh 持有身份时 IDE 仍在 tof.sync 回推票据 ✗'); }
	// ⚠ 判据钉**调用点**（菜单动作真的先走 HTTP）：只查 `tofHttpAction(action)` 会被函数**定义**本身匹配 ⇒ 假绿（反向突变实测）✗
	if (!/\/x\/vssaros-bridge\/api\/tof\//.test(accountSrc) || !/\(action === "signInIde" \|\| action === "signOutIde"\) && tofHttpAction\(action\)\) \{ return; \}/.test(accountSrc)) { fail('⑧ 页面账号行没走 dsh 的 HTTP 面 ⇒ 独立桌面窗口里登不了 ✗'); }
	if (!problems.some(x => x.startsWith('⑧'))) { ok('⑧ IDE 侧：自动重登已删 / 镜像覆盖注册 / 登录登出取票交给 dsh / 老 Host 退回 / 主进程广播 / 不回推 / 页面走 HTTP'); }
}

// ── ⑨ 页面账号行（真装载 chunk，假 fetch）：新桥走 HTTP；老桥（404 / HTML 状态页）退回页面桥 ─────────────
// 源码正则（⑧）只能证明"写了"；这里证明"真按这条路走"，且老桥插件下不会变成"点了没反应"✓。
{
	const src = read('dsh-plugins/vssaros-chat-surface/lib/client.account.js');
	const load = () => {
		let captured = null;
		const win = { __ModuleLoader__: { load: m => { captured = m; } }, addEventListener() { }, removeEventListener() { } };
		const doc = { documentElement: { dataset: { vssarosAuth: JSON.stringify({ signedIn: true, loginName: 'ide-pushed' }) } }, addEventListener() { }, removeEventListener() { } };
		new Function('window', 'document', 'require', 'module', 'exports', src)(win, doc, () => ({ useState: v => [v, () => { }], useEffect() { }, createElement: () => null }), { exports: {} }, {});
		return { t: captured.factory(() => ({ useState: v => [v, () => { }], useEffect() { }, createElement: () => null })).__test, win };
	};
	const calls = [];
	const realFetch = globalThis.fetch;
	const respond = (status, type, body) => Promise.resolve({ status, headers: { get: () => type }, json: async () => JSON.parse(body) });
	try {
		// 新桥：JSON 状态 ⇒ 以 dsh 为准；登录走 POST /api/tof/signin，不碰页面桥
		globalThis.fetch = (url, init) => {
			calls.push({ url: String(url), method: init?.method ?? 'GET' });
			if (String(url).endsWith('/status')) { return respond(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, status: { signedIn: true, loginName: 'dsh-owned', staffId: '1', team: 'T' } })); }
			return respond(202, 'application/json', JSON.stringify({ ok: true, status: { signedIn: false, signingIn: true } }));
		};
		const a = load();
		let bridgeCalled = false;
		a.win.vssarosDsh = { signInIde: () => { bridgeCalled = true; return Promise.resolve(); } };
		await a.t.fetchTofStatus();   // chunk 自己的探测（= 挂载时那一下）
		if (a.t.tofHttp.available !== true || a.t.readAuth().loginName !== 'dsh-owned') { fail('⑨ 新桥：账号行没以 dsh 侧状态为准（还在用 IDE 推来的）✗'); }
		calls.length = 0;
		a.t.runMenuAction('signInIde');
		await new Promise(r => setTimeout(r, 20));
		if (!calls.some(c => c.url.endsWith('/api/tof/signin') && c.method === 'POST')) { fail(`⑨ 新桥：点「登录」没 POST /api/tof/signin：${JSON.stringify(calls)}`); }
		if (bridgeCalled) { fail('⑨ 新桥：点「登录」还走了页面桥 signInIde（独立桌面窗口里没有这座桥）✗'); }
		a.t.setPendingAction('');
		if (a.t.tofHttp.pollTimer) { clearTimeout(a.t.tofHttp.pollTimer); a.t.tofHttp.pollTimer = null; }

		// 老桥：前缀路由回 HTML 状态页（200 非 JSON）⇒ chunk 必须自己判成"没有 HTTP 面"⇒ 读 IDE 推来的、登录走页面桥
		const b = load();
		let bridge2 = false;
		b.win.vssarosDsh = { signInIde: () => { bridge2 = true; return Promise.resolve(); } };
		globalThis.fetch = (url, init) => { calls.push({ url: String(url), method: init?.method ?? 'GET' }); return respond(200, 'text/html; charset=utf-8', '"<main>"'); };
		await b.t.fetchTofStatus();
		if (b.t.tofHttp.available !== false) { fail(`⑨ 老桥：HTML 状态页（200 非 JSON）没被判成"没有 HTTP 面"（available=${b.t.tofHttp.available}）⇒ 账号行会显示空状态、登录点了没反应 ✗`); }
		if (b.t.readAuth().loginName !== 'ide-pushed') { fail('⑨ 老桥：没退回 IDE 推来的状态 ✗'); }
		b.t.runMenuAction('signInIde');
		await new Promise(r => setTimeout(r, 10));
		if (!bridge2) { fail('⑨ 老桥：点「登录」没退回页面桥 ⇒ 点了没反应 ✗'); }
		b.t.setPendingAction('');
	} finally {
		globalThis.fetch = realFetch;
	}
	if (!problems.some(x => x.startsWith('⑨'))) { ok('⑨ 页面账号行（真装载）：新桥以 dsh 为准 + 登录走 HTTP；老桥（HTML 200）退回 IDE 推送 + 页面桥'); }
}

if (problems.length) {
	console.error(`\n[check-dsh-tof-owned] ✗ ${problems.length} 处问题：`);
	for (const p of problems) { console.error(`  - ${p}`); }
	process.exit(1);
}
console.log('\n[check-dsh-tof-owned] ✓ 企业身份归 dsh 侧持有、IDE 只读：登录 / 取消 / 缓存 / 过期 / 登出 / HTTP / 接线全部通过');
process.exit(0);
