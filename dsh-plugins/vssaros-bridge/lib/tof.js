/*---------------------------------------------------------------------------------------------
 * dsh 侧**独立**的 TOF/OA 企业身份客户端（vendored 自 extensions/tof-authentication）。
 *
 * 为什么要有它（2026-10-21，用户裁决："两侧用同一份 TOF/OA 企业身份"）：
 *   原方案只有一条路 —— IDE 侧登录 → 票据经控制桥同步到 dsh（`tof.sync`）。
 *   那是"**依附 IDE**"的：dsh 单独跑（没有 IDE / IDE 没开）时，Host 手里就**没有身份**，
 *   商城、内网服务、内网 MCP 全部用不了 ⇒ dsh 侧自己也要能登。
 *
 * 协议（网关定的，客户端 1:1 复用，与 IDE 侧那份完全一致）：
 *   1. 登录 URL = https://passport.woa.com/modules/passport/signin.ashx?oauth=true&appkey=<paasid>&url=<网关回调>
 *   2. 网关回调 = <siteBaseUrl>/api/v1/auth/tof/callback?cb_port=<本地端口>&state=<state>
 *      ⇒ 网关 302 到 http://127.0.0.1:<port>/got?identity=<ticket>&state=<state>（state 必匹配）
 *   3. 票据用法 = header `x-tai-identity: <ticket>`；GET <gatewayBaseUrl>/api/v1/whoami ⇒ 工号/姓名/团队
 *
 * ⚠ dsh **没有**"打开外部 URL"的服务（无 openExternal / openUrl）⇒ 开浏览器只能 spawn。
 *   Windows 上**不能**用 `cmd /c start`：URL 里的 `&` 会被 cmd 当命令分隔符 ⇒ 改走 rundll32
 *   （url.dll,FileProtocolHandler），失败再退 explorer.exe（两者都不经过 shell ⇒ 不吃 `&`）✓。
 *
 * ⚠ **票据绝不出现在工具回执 / 页面**（dsh 凭据是明文落盘的，比 SecretStorage 的暴露面更大）⇒
 *   本文件所有对外投影都只给工号 / 姓名 / 团队 / 过期时间 ✓。
 *--------------------------------------------------------------------------------------------*/

import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * dsh 侧**自登**票据的凭据 ref。
 *
 * ⚠ 与 IDE 同步过来的那份（`VSSAROS_TOF_TICKET`）**故意分开**：两条路可能同时存在
 *   （IDE 登过一次、dsh 又自己登过一次 ⇒ 两张不同票据、同一身份）⇒ 分开存才不会互相覆盖 ✓。
 *   读取时按"本地自登 > IDE 同步"的优先级取（见 createTofService）✓。
 */
export const TOF_LOCAL_CREDENTIAL_REF = 'VSSAROS_TOF_TICKET_DSH';

/** dsh 侧自登**身份**的缓存（whoami 投影的 JSON）——网关临时不可达时还能报出"是谁登的" ✓。 */
export const TOF_IDENTITY_CREDENTIAL_REF = 'VSSAROS_TOF_IDENTITY_DSH';

/**
 * "用户在 dsh 侧**主动登出**过"的标记（值 '1'，2026-10-22）。
 *
 * 登录挪到 dsh 侧后，IDE 会把旧扩展里的登录态**一次性**迁过来（`tof.sync`）——没有这个标记，
 * 用户在 dsh 侧一登出，IDE 下次启动就把旧扩展里的票原样导回来（"登出不掉" ✗）。
 * 用户在 dsh 侧再次登录时撤掉。同 CodeBuddy 的 `VSSAROS_CODEBUDDY_SIGNED_OUT`。
 */
export const TOF_SIGNED_OUT_REF = 'VSSAROS_TOF_SIGNED_OUT';

/** status() 结果缓存时长：status 每次都打一遍网关 whoami ⇒ 设置页/IDE 频繁查时不能每次都联网 ✓。 */
const STATUS_TTL_MS = 60_000;

/**
 * 默认参数：**必须与 IDE 侧 `extensions/tof-authentication` 的默认一致**（同一个网关、同一个 appkey）。
 * 不一致 ⇒ 两边登出来的票据在对方那边认不出 ⇒ "两侧同一身份"就成了空话 ✗。
 */
export const TOF_DEFAULTS = Object.freeze({
	paasid: 'sls_mcp_app',
	siteBaseUrl: 'http://saroasis-mcp.woa.com',
	gatewayBaseUrl: 'http://21.169.46.116:8080',
	timeoutSeconds: 180,
});

const TAIHU_SIGNIN_URL = 'https://passport.woa.com/modules/passport/signin.ashx';
const TOF_CALLBACK_PATH = '/api/v1/auth/tof/callback';

/** 票据的最小长度（IDE 侧那份校验用的是 10 —— 两边同一把尺子）。 */
const MIN_TICKET_LENGTH = 10;

/**
 * 本地 loopback HTTP 服务：捕获 TOF OAuth 回调返回的 identity ticket。
 *
 * 流程：start() 起 http server 监听 127.0.0.1:0（随机端口）→ 浏览器登录后网关 302 到
 * http://127.0.0.1:<port>/got?identity=<ticket>&state=<state> → waitForTicket() 返回票据 → stop() 关服务。
 *
 * ⚠ **只监听回环地址**（127.0.0.1）—— 票据是凭据，不能被同网段的人捡到 ✗。
 */
export class TofLoopbackServer {
	constructor() {
		this._state = randomBytes(16).toString('base64url');
		this._server = http.createServer((req, res) => this._handleRequest(req, res));
		this._port = undefined;
		this._resolveTicket = undefined;
		this._reject = undefined;
		this._timeoutHandle = undefined;
	}

	get state() {
		return this._state;
	}

	get port() {
		return this._port;
	}

	/** 构造浏览器登录 URL（回调指向本 server 的端口）。 */
	buildSigninUrl({ paasid, siteBaseUrl }) {
		const base = String(siteBaseUrl ?? TOF_DEFAULTS.siteBaseUrl).replace(/\/$/, '');
		const gwCallback = `${base}${TOF_CALLBACK_PATH}?cb_port=${this._port}&state=${encodeURIComponent(this._state)}`;
		return `${TAIHU_SIGNIN_URL}?oauth=true&appkey=${encodeURIComponent(paasid)}&url=${encodeURIComponent(gwCallback)}`;
	}

	async start(timeoutSeconds) {
		return new Promise((resolve, reject) => {
			const portTimeout = setTimeout(() => {
				reject(new Error('启动本地回调服务超时（5s）'));
			}, 5000);

			this._server.on('listening', () => {
				const address = this._server.address();
				if (typeof address === 'object' && address) {
					this._port = address.port;
				} else {
					clearTimeout(portTimeout);
					reject(new Error('无法确定本地服务端口'));
					return;
				}
				clearTimeout(portTimeout);
				this._timeoutHandle = setTimeout(() => {
					this._fail(new Error(`登录超时（${timeoutSeconds}s）—— 浏览器里没有完成登录`));
				}, Number(timeoutSeconds) * 1000);
				// ⚠ unref：超时定时器不该拖住 Host 进程（dsh 退出时不能因为它挂住）✓
				this._timeoutHandle.unref?.();
				resolve();
			});

			this._server.on('error', (err) => {
				clearTimeout(portTimeout);
				this._fail(new Error(`本地回调服务错误：${err?.message ?? err}`));
			});

			this._server.listen(0, '127.0.0.1');
		});
	}

	/** 等浏览器跳回 /got?identity=...&state=... ⇒ 返回票据。 */
	waitForTicket() {
		return new Promise((resolve, reject) => {
			this._resolveTicket = resolve;
			this._reject = reject;
		});
	}

	/** 取消正在等的登录（设置页 / IDE 点「取消」）⇒ waitForTicket 以"已取消"失败 ✓。 */
	cancel() {
		this._fail(new Error('已取消登录'));
	}

	async stop() {
		if (this._timeoutHandle) {
			clearTimeout(this._timeoutHandle);
			this._timeoutHandle = undefined;
		}
		return new Promise((resolve) => {
			// ⚠ 浏览器那条连接可能还挂着（keep-alive）⇒ `close()` 会等它结束 ⇒ stop 挂住 ✗
			//   ⇒ 先把现存连接掐掉（Node 18.2+ 有这个 API；老版本没有就退回原行为）✓
			this._server.closeAllConnections?.();
			this._server.close(() => resolve());
		});
	}

	_handleRequest(req, res) {
		try {
			const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
			if (reqUrl.pathname !== '/got') {
				res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end('<html><body><h2>404 Not Found</h2></body></html>');
				return;
			}
			const identity = reqUrl.searchParams.get('identity') ?? '';
			const stateParam = reqUrl.searchParams.get('state') ?? '';
			if (stateParam !== this._state) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end('<html><body><h2>Login Failed</h2><p>state mismatch</p></body></html>');
				this._fail(new Error('回调的 state 与本地不匹配（可能存在 CSRF）'));
				return;
			}
			if (!identity || identity.length < MIN_TICKET_LENGTH) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end('<html><body><h2>Login Failed</h2><p>missing identity</p></body></html>');
				this._fail(new Error('回调缺少 identity 票据'));
				return;
			}
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login Success</title></head>'
				+ '<body style="font-family:sans-serif;max-width:560px;margin:80px auto;text-align:center">'
				+ '<h2>Login Success</h2><p>Identity ticket received.</p>'
				+ '<p style="color:#888">You can close this page and return to the client.</p></body></html>');
			this._succeed(identity);
		} catch (e) {
			this._fail(e instanceof Error ? e : new Error(String(e)));
		}
	}

	_succeed(ticket) {
		if (this._resolveTicket) {
			const resolve = this._resolveTicket;
			this._resolveTicket = undefined;
			this._reject = undefined;
			resolve(ticket);
		}
	}

	_fail(err) {
		if (this._reject) {
			const reject = this._reject;
			this._resolveTicket = undefined;
			this._reject = undefined;
			reject(err);
		}
	}
}

/**
 * 调网关 `/api/v1/whoami` 验证票据并取身份。
 *
 * ⚠ 走 **Node 的 http/https**（不是 fetch）：网关默认是**明文 HTTP**（`http://21.169.46.116:8080`）
 *   ⇒ 页面侧会被 Mixed Content 拦死，但 Node 侧没有这个限制 ✓（这也正是"登录只能在 Node 侧做"的原因）。
 */
export async function fetchWhoami(ticket, gatewayBaseUrl) {
	const base = String(gatewayBaseUrl ?? TOF_DEFAULTS.gatewayBaseUrl).replace(/\/$/, '');
	const url = `${base}/api/v1/whoami`;
	const result = await sendGet(url, { 'x-tai-identity': ticket, Accept: 'application/json' });

	if (result.statusCode === 401) {
		let detail = '';
		try {
			const errData = JSON.parse(result.body);
			detail = errData?.detail?.message ?? errData?.message ?? '';
		} catch { /* 非 JSON 正文 ⇒ 不给细节 */ }
		throw new Error(`网关拒绝了凭据（401）：${detail}`);
	}
	if (result.statusCode >= 400) {
		throw new Error(`whoami 失败：HTTP ${result.statusCode}`);
	}

	let data;
	try {
		data = JSON.parse(result.body);
	} catch {
		throw new Error('whoami 返回的数据不是 JSON');
	}
	if (!data || !data.staff_id || !data.login_name) {
		throw new Error('whoami 返回的数据缺少 staff_id / login_name');
	}
	return {
		user_id: data.user_id ?? `taihu:staffid:${data.staff_id}`,
		staff_id: String(data.staff_id),
		login_name: String(data.login_name),
		team: data.team ?? null,
		is_admin: !!data.is_admin,
		expires_at: data.expires_at ?? '',
	};
}

function sendGet(url, headers) {
	return new Promise((resolve, reject) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			reject(new Error(`无效的网关 URL：${url}`));
			return;
		}
		const isHttps = parsed.protocol === 'https:';
		const requestFn = isHttps ? https.request : http.request;
		const clientReq = requestFn({
			hostname: parsed.hostname,
			port: parsed.port || (isHttps ? 443 : 80),
			path: `${parsed.pathname}${parsed.search}`,
			method: 'GET',
			headers,
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
		});
		const timeoutHandle = setTimeout(() => {
			clientReq.destroy();
			reject(new Error('whoami 请求超时（30s）'));
		}, 30000);
		clientReq.on('error', (err) => {
			clearTimeout(timeoutHandle);
			reject(new Error(`whoami 请求失败：${err?.message ?? err}`));
		});
		clientReq.on('close', () => clearTimeout(timeoutHandle));
		clientReq.end();
	});
}

/**
 * 用系统默认浏览器打开 URL（dsh 没有 openExternal ⇒ 只能 spawn）。
 *
 * ⚠ Windows 上**不用** `cmd /c start`：URL 里带 `&`（passport URL 有多个查询参数）会被 cmd
 *   当成命令分隔符 ⇒ 打开的是被截断的地址 ⇒ 回调永远不来 ⇒ "点了没反应" ✗。
 *   这里走 rundll32（url.dll,FileProtocolHandler），失败再退 explorer.exe —— 两者都**不经 shell** ✓。
 *
 * ⚠ `windowsHide: true` 必带：Host 是 node.exe、没有可继承的控制台 ⇒ 漏了会闪一个 conhost 窗口
 *   （守卫 `check-spawn-hide.mjs` 盯着这条 ✓）。
 */
export function openExternalUrl(url) {
	const target = String(url ?? '').trim();
	if (!target) {
		return Promise.reject(new Error('要打开的 URL 为空'));
	}
	const plans = process.platform === 'win32'
		? [
			{ command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] },
			{ command: 'explorer.exe', args: [target] },
		]
		: process.platform === 'darwin'
			? [{ command: 'open', args: [target] }]
			: [{ command: 'xdg-open', args: [target] }];
	return spawnOpen(plans, 0);
}

function spawnOpen(plans, index) {
	return new Promise((resolve, reject) => {
		const plan = plans[index];
		if (!plan) {
			reject(new Error('没有可用的"打开浏览器"方式（本机缺少 rundll32 / explorer / open / xdg-open）'));
			return;
		}
		let child;
		try {
			child = spawn(plan.command, plan.args, {
				windowsHide: true,
				detached: true,
				stdio: 'ignore',
			});
		} catch (e) {
			reject(new Error(`打开浏览器失败：${String(e?.message ?? e)}`));
			return;
		}
		let settled = false;
		child.once?.('spawn', () => {
			if (settled) { return; }
			settled = true;
			child.unref?.();
			resolve(true);
		});
		child.once?.('error', (e) => {
			if (settled) { return; }
			settled = true;
			// 还有下一个候选就换它试 ⇒ 失败原因留给最后一个 ✓
			if (index + 1 < plans.length) {
				spawnOpen(plans, index + 1).then(resolve, reject);
				return;
			}
			reject(new Error(`打开浏览器失败：${String(e?.message ?? e)}`));
		});
	});
}

/**
 * 走一遍完整流程：起 loopback → 开浏览器 → 等回调 → whoami 验证。
 *
 * @param {object} cfg 网关 / appkey / 超时
 * @param {object} [deps] `whoami` 可注入（守卫用它做**行为**断言 ⇒ 不联网 ✓）
 * @returns {{ ticket: string, user: object }} 票据只在这里出现一次（调用方负责落盘，不外泄）✓
 */
export async function signinViaBrowser(cfg, deps = {}) {
	const whoami = typeof deps.whoami === 'function' ? deps.whoami : fetchWhoami;
	const openUrl = typeof deps.openUrl === 'function' ? deps.openUrl : openExternalUrl;
	const server = new TofLoopbackServer();
	// 取消钩子（2026-10-22）：登录挪到 dsh 侧后，设置页 / IDE 需要能"取消登录"——
	//   让 waitForTicket 立刻以"已取消"失败 ⇒ finally 关掉 loopback ✓（不然只能干等 180s 超时 ✗）。
	if (typeof deps.onServer === 'function') { deps.onServer(server); }
	try {
		await server.start(cfg.timeoutSeconds);
		const signinUrl = server.buildSigninUrl(cfg);
		await openUrl(signinUrl);
		const ticket = await server.waitForTicket();
		const user = await whoami(ticket, cfg.gatewayBaseUrl);
		return { ticket, user };
	} finally {
		await server.stop();
	}
}

/** whoami 结果 ⇒ 对外投影（**没有票据**）✓。 */
export function projectUser(user, source) {
	return {
		signedIn: true,
		// 网关给的标准用户 ID（IDE 把它当数据归属键用 ⇒ 必须原样带过去，不能在 IDE 侧按工号猜 ✗）
		userId: String(user?.user_id ?? (user?.staff_id ? `taihu:staffid:${user.staff_id}` : '')),
		staffId: String(user?.staff_id ?? ''),
		loginName: String(user?.login_name ?? ''),
		team: user?.team ?? null,
		isAdmin: !!user?.is_admin,
		expiresAt: user?.expires_at ?? '',
		source,
	};
}

/**
 * dsh 侧的企业身份服务。
 *
 * 票据读回用的是 `credentials.resolve(ref)`（`describe` 只回"有没有"、不回值 ⇒ 拿不到票据 ✗）。
 *
 * @param {object} args
 * @param {object} args.credentials dsh 的凭据服务（ctx.credentials）
 * @param {string} args.ideCredentialRef IDE 侧同步过来的那份票据的 ref（由调用方传入 ⇒ 两侧不会各写一份常量）
 * @param {object} [args.config] 覆盖 paasid / siteBaseUrl / gatewayBaseUrl / timeoutSeconds
 * @param {function} [args.whoami] whoami 实现（默认真实现；守卫注入假实现 ⇒ 行为断言不联网 ✓）
 * @param {function} [args.onChange] 登录态变了（登录成功 / 登出）后回调（不带票据）——index.js 用它通知 IDE 刷新 ✓
 * @param {function} [args.openUrl] 开浏览器的实现（守卫注入 ⇒ 不真开浏览器 ✓）
 * @param {function} [args.now] 时钟（守卫注入）
 */
export function createTofService({ credentials, ideCredentialRef, config = {}, log = () => {}, whoami = fetchWhoami, onChange = () => {}, openUrl, now = () => Date.now() }) {
	const cfg = {
		paasid: String(config.paasid ?? TOF_DEFAULTS.paasid).trim() || TOF_DEFAULTS.paasid,
		siteBaseUrl: String(config.siteBaseUrl ?? TOF_DEFAULTS.siteBaseUrl).trim() || TOF_DEFAULTS.siteBaseUrl,
		gatewayBaseUrl: String(config.gatewayBaseUrl ?? TOF_DEFAULTS.gatewayBaseUrl).trim() || TOF_DEFAULTS.gatewayBaseUrl,
		timeoutSeconds: (() => {
			const n = Number(config.timeoutSeconds);
			return Number.isFinite(n) && n > 0 ? Math.min(900, Math.floor(n)) : TOF_DEFAULTS.timeoutSeconds;
		})(),
	};

	const readRef = async (ref) => {
		if (!credentials || typeof credentials.resolve !== 'function' || !ref) { return undefined; }
		try {
			const resolved = await credentials.resolve(ref);
			const value = resolved?.value;
			return typeof value === 'string' && value ? value : undefined;
		} catch {
			return undefined;
		}
	};
	const writeRef = async (ref, value) => {
		if (!credentials || typeof credentials.set !== 'function') {
			throw new Error('凭据服务不可用（credentials 缺席）—— 无法保存票据');
		}
		await credentials.set(ref, value);
	};
	const dropRef = async (ref) => {
		if (!credentials || typeof credentials.unset !== 'function' || !ref) { return false; }
		try {
			const before = await credentials.describe(ref);
			await credentials.unset(ref);
			return before?.configured === true;
		} catch {
			return false;
		}
	};

	/** 有效票据：**本地自登 > IDE 同步**（两边各登一次 ⇒ 两张票、同一身份 ⇒ 取本地那张）✓。 */
	const effectiveTicket = async () => {
		const local = await readRef(TOF_LOCAL_CREDENTIAL_REF);
		if (local) { return { ticket: local, source: 'dsh' }; }
		const synced = await readRef(ideCredentialRef);
		if (synced) { return { ticket: synced, source: 'ide' }; }
		return { ticket: undefined, source: 'none' };
	};

	const readIdentityCache = async () => {
		const raw = await readRef(TOF_IDENTITY_CREDENTIAL_REF);
		if (!raw) { return undefined; }
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? parsed : undefined;
		} catch {
			return undefined;
		}
	};

	/** 状态缓存（status 每次都打网关 whoami）；登录 / 登出 / IDE 同步写票后**作废** ✓。 */
	let statusCache = null;   // { at, value }
	const invalidate = () => { statusCache = null; };
	const fireChange = (why) => {
		invalidate();
		try { onChange(why); } catch { /* 通知失败不影响登录本身 */ }
	};

	/** 登录（开浏览器）。并发调用共用同一次登录 ⇒ 不会开出两个浏览器窗口 ✓。 */
	let inflight = null;
	let signInDeadline = null;   // 浏览器登录的等待截止时刻（epoch ms）⇒ 设置页显示倒计时
	let pendingServer = null;    // 正在等回调的 loopback ⇒ cancelSignIn() 用
	let lastError = '';
	const signIn = async (overrides = {}) => {
		if (inflight) { return inflight; }
		const merged = { ...cfg, ...overrides };
		lastError = '';
		signInDeadline = now() + merged.timeoutSeconds * 1000;
		const run = (async () => {
			const { ticket, user } = await signinViaBrowser(merged, { whoami, ...(openUrl ? { openUrl } : {}), onServer: s => { pendingServer = s; } });
			await writeRef(TOF_LOCAL_CREDENTIAL_REF, ticket);
			await writeRef(TOF_IDENTITY_CREDENTIAL_REF, JSON.stringify({ ...projectUser(user, 'dsh'), signedInAt: Date.now() }));
			// 用户主动登录 ⇒ 撤掉"主动登出过"标记（之后 IDE 的一次性迁移照常可用）✓
			await dropRef(TOF_SIGNED_OUT_REF);
			log(`[vssaros-tof] dsh 侧登录成功：${user.login_name}（${user.staff_id}）`);
			return projectUser(user, 'dsh');
		})();
		inflight = run;
		try {
			const out = await run;
			fireChange('signin');
			return out;
		} catch (e) {
			lastError = String(e?.message ?? e);
			throw e;
		} finally {
			inflight = null;
			pendingServer = null;
			signInDeadline = null;
		}
	};

	/** 取消正在进行的浏览器登录 ⇒ 返回"是否真有一次在等"。 */
	const cancelSignIn = () => {
		const s = pendingServer;
		if (s && typeof s.cancel === 'function') { s.cancel(); return true; }
		return false;
	};

	/** 401 = 网关明确不认这张票（过期 / 被吊销）⇒ 是"已失效"，不是"网关临时不可达" ✓。 */
	const isRejected = (e) => /（401）|\b401\b/.test(String(e?.message ?? e));

	/** 身份部分（不含"登录中"这类瞬时字段 ⇒ 可以缓存）。 */
	const identity = async () => {
		const { ticket, source } = await effectiveTicket();
		const signedOutByUser = (await readRef(TOF_SIGNED_OUT_REF)) === '1';
		if (!ticket) {
			const cached = await readIdentityCache();
			return cached
				? { ...cached, signedIn: true, stale: true, hasCredential: false, signedOutByUser, error: '当前没有可用票据，下面是缓存的身份信息' }
				: { signedIn: false, hasCredential: false, signedOutByUser };
		}
		try {
			const user = await whoami(ticket, cfg.gatewayBaseUrl);
			return { ...projectUser(user, source), stale: false, hasCredential: true, signedOutByUser };
		} catch (e) {
			const cached = await readIdentityCache();
			if (isRejected(e)) {
				// ★ 票过期：如实说"未登录（已失效）"——**不**自动开浏览器重登（2026-10-22 用户：IDE 侧只读状态，
				//   登录要由用户自己点；以前 IDE 启动时票过期就自动弹浏览器 ✗）。票先留着：用户重登时会被覆盖 ✓
				return {
					signedIn: false,
					expired: true,
					hasCredential: true,
					signedOutByUser,
					source,
					error: '企业身份已失效（网关拒绝了票据），请重新登录',
					...(cached ? { loginName: cached.loginName, staffId: cached.staffId } : {}),
				};
			}
			return {
				signedIn: true,
				stale: true,
				hasCredential: true,
				signedOutByUser,
				error: String(e?.message ?? e),
				source,
				...(cached ? { staffId: cached.staffId, loginName: cached.loginName, team: cached.team ?? null, isAdmin: !!cached.isAdmin, expiresAt: cached.expiresAt ?? '' } : {}),
			};
		}
	};

	/**
	 * 当前身份：有票就 whoami（结果缓存 60s；`fresh: true` 强制重查）；网关不可达时退回缓存（并标 stale）；
	 * 网关明确拒票（401）⇒ 未登录 + expired ✓。另带"登录中"状态（设置页显示倒计时 / 取消）。
	 */
	const status = async ({ fresh = false } = {}) => {
		let value;
		if (!fresh && statusCache && now() - statusCache.at < STATUS_TTL_MS) {
			value = statusCache.value;
		} else {
			value = await identity();
			// 网关临时失败（stale）不缓存 ⇒ 下次再试；成功 / 明确失效才缓存 ✓
			if (!value.stale) { statusCache = { at: now(), value }; }
		}
		return {
			...value,
			signingIn: !!inflight,
			...(inflight && signInDeadline ? { signInDeadline } : {}),
			...(!value.error && lastError && !value.signedIn ? { error: lastError } : {}),
		};
	};

	/**
	 * 登出。默认**只清 dsh 自己那份**；`all: true` 连 IDE 同步过来的那份一起清
	 * （IDE 仍持有登录态 ⇒ 它下次连上/登录态变化时会把票再同步回来 ⇒ 如实告诉调用方 ✓）。
	 * `byUser: true`（设置页 / IDE 的「退出登录」）⇒ 记下"主动登出过"⇒ IDE 不会再把旧扩展里的票迁回来 ✓。
	 */
	const signOut = async ({ all = false, byUser = false } = {}) => {
		cancelSignIn();
		const before = await effectiveTicket();
		await dropRef(TOF_LOCAL_CREDENTIAL_REF);
		await dropRef(TOF_IDENTITY_CREDENTIAL_REF);
		let ideCleared = false;
		if (all) {
			ideCleared = await dropRef(ideCredentialRef);
		}
		if (byUser) {
			try { await writeRef(TOF_SIGNED_OUT_REF, '1'); } catch { /* 写不进也不影响登出本身 */ }
		}
		lastError = '';
		// ⚠ "IDE 那份还在"要看**实际是否还在**（不是看刚才用的是哪一张）——
		//   两份都在时，有效票据是本地那张，但 IDE 那份**仍然留着** ⇒ 登出后它还会被同步回来 ✗。
		const ideStillThere = all ? false : (await readRef(ideCredentialRef)) !== undefined;
		fireChange('signout');
		return {
			signedIn: false,
			cleared: before.ticket ? true : false,
			source: before.source,
			ideStillSynced: ideStillThere,
			...(ideCleared ? { ideCleared: true } : {}),
		};
	};

	return {
		config: cfg,
		refs: { local: TOF_LOCAL_CREDENTIAL_REF, identity: TOF_IDENTITY_CREDENTIAL_REF, ide: ideCredentialRef, signedOut: TOF_SIGNED_OUT_REF },
		signIn,
		cancelSignIn,
		signOut,
		status,
		/** IDE 同步写票（`tof.sync`）等外部改动后调：作废状态缓存 ✓。 */
		invalidate,
		/** 给**同 Host 内**的其他插件、以及经本机命名管道的 IDE 用的取票口子（页面一律不给 ⇒ 页面永远拿不到票据 ✓）。 */
		ticket: effectiveTicket,
	};
}

/**
 * 三个工具的定义（官方契约：必须有 output { schema, render }，注册期就拒 ✗）。
 *
 * ⚠ **回执里绝不含票据**（工具回执会进模型上下文与页面 ⇒ 等同"下发页面" ✗）。
 */
export function tofToolDefinitions(service) {
	const identitySchema = {
		type: 'object',
		properties: {
			signedIn: { type: 'boolean' },
			staffId: { type: 'string' },
			loginName: { type: 'string' },
			team: { type: 'string' },
			isAdmin: { type: 'boolean' },
			expiresAt: { type: 'string' },
			source: { type: 'string' },
			stale: { type: 'boolean' },
			error: { type: 'string' },
		},
	};
	const describeIdentity = (value) => {
		if (!value || value.signedIn !== true) { return '未登录（dsh 侧没有企业身份）'; }
		const who = value.loginName || value.staffId || '未知';
		const team = value.team ? `（${value.team}）` : '';
		const stale = value.stale ? ' · 信息可能已过期' : '';
		const err = value.error ? ` · ${value.error}` : '';
		return `已登录：${who}${team}${stale}${err}`;
	};

	return [
		{
			name: 'tof_signin',
			description: '用企业身份（TOF/OA）登录 dsh 侧：会打开系统浏览器走 passport 登录，拿到票据后调用网关 whoami 验证身份，票据存进 dsh 的凭据存储（不返回给模型）。dsh 独立跑、没有 IDE 时用这个。已登录时不必再登。',
			parameters: {
				type: 'object',
				properties: {
					timeoutSeconds: { type: 'number', description: '等浏览器登录完成的最长秒数（默认 180）' },
				},
			},
			output: {
				schema: identitySchema,
				render: (_args, value) => [{ type: 'text', text: describeIdentity(value) }],
			},
			isConcurrencySafe: () => false,
			async execute(args = {}) {
				const overrides = {};
				const timeout = Number(args?.timeoutSeconds);
				if (Number.isFinite(timeout) && timeout > 0) { overrides.timeoutSeconds = timeout; }
				try {
					return await service.signIn(overrides);
				} catch (e) {
					return { signedIn: false, error: String(e?.message ?? e) };
				}
			},
		},
		{
			name: 'tof_status',
			description: '查 dsh 侧的企业身份（TOF/OA）状态：当前是否已登录、工号、姓名、团队、票据过期时间，以及身份来自 dsh 自登还是 IDE 同步。只读，不开浏览器。',
			parameters: { type: 'object', properties: {} },
			output: {
				schema: identitySchema,
				render: (_args, value) => [{ type: 'text', text: describeIdentity(value) }],
			},
			isConcurrencySafe: () => true,
			async execute() {
				try {
					return await service.status();
				} catch (e) {
					return { signedIn: false, error: String(e?.message ?? e) };
				}
			},
		},
		{
			name: 'tof_signout',
			description: '登出 dh 侧的企业身份（TOF/OA）：清掉 dsh 自己那张票据。默认不动 IDE 同步过来的那份（IDE 仍登录着的话，它会把票据再同步回来）；要连那份一起清就传 all=true。',
			parameters: {
				type: 'object',
				properties: {
					all: { type: 'boolean', description: '是否连 IDE 同步过来的那份票据一起清掉' },
				},
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						signedIn: { type: 'boolean' },
						cleared: { type: 'boolean' },
						source: { type: 'string' },
						ideStillSynced: { type: 'boolean' },
						ideCleared: { type: 'boolean' },
					},
				},
				render: (_args, value) => [{
					type: 'text',
					text: value?.signedIn === false
						? `已登出 dsh 侧的企业身份${value?.ideStillSynced ? '（IDE 侧仍登录着，票据可能被再同步回来）' : ''}`
						: '登出失败',
				}],
			},
			isConcurrencySafe: () => false,
			async execute(args = {}) {
				try {
					return await service.signOut({ all: args?.all === true });
				} catch (e) {
					return { signedIn: false, error: String(e?.message ?? e) };
				}
			},
		},
	];
}
