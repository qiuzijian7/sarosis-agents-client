// @vssaros/dsh-marketplace — 商城客户端（★ 2026-10-22 S1：**dsh 侧自持**认证与只读面）
//
// ★ 为什么要搬回 dsh 侧（用户质疑后的架构修正）：
//   上一版把 list/detail/installed 也经 `ide.request` 打到 IDE ⇒ **违背"能力落在 dsh 侧"**。
//   取证后发现当初的三条理由里只有一条成立：
//     ① 「商城 JWT 在 IDE 进程 ⇒ Host 没有票据」——**错（已过时）**：
//        `@vssaros/dsh-bridge` 的 `tof.js` 早已让 Host 有独立 TOF 登录（`tof_signin`，
//        票据存 `ctx.credentials` 的 `VSSAROS_TOF_TICKET_DSH`），且 dsh 是 Node 进程**有 fetch**；
//        IDE 侧绕扩展宿主只是为了绕 renderer 的 CORS / 无 sha256 / 无 tar ⇒ **这三条 dsh 都没有** ✓
//     ② 「装工作台包必须走主进程 `dsh plugin add`」——**成立**（且装完要重启 Host，Host 不能自杀重启）
//     ③ 「落盘目录与注册表刷新都在 IDE 侧」——**一半错**：目录是同一处（数据根），
//        dsh 侧本来就在写；真正缺的只是"让 IDE 界面即时看见"（skill 需 reload，agent/workflow 不需要）✓
//   ⇒ 本文件的职责：**认证 + 只读面全在 dsh 侧**；只有 workbench 的装/卸仍要借道 IDE 主进程。
//
// ★ 票据从哪来（两条路，按"本地自登 > IDE 同步"读 —— 与 `vssaros-bridge/lib/tof.js` 同口径）：
//   - `VSSAROS_TOF_TICKET_DSH`：dsh 自己 `tof_signin` 拿到的
//   - `VSSAROS_TOF_TICKET`：IDE 侧同步过来的
//   拿到票据后 `POST /api/v1/auth/tof` 换**商城 JWT**，存自己的 ref（不与上面两份混）✓
//
// ★ 错误一律带服务端的 `details`：
//   服务端 zod 校验失败只回 `{ error:'参数校验失败', details:[…issues] }`
//   —— 只取 `error` 会让人看不出是哪个参数不合法（真机踩过：远端服务端版本落后，缺一个 kind 枚举）✗

import { foundation } from './foundationRef.js';

/** dsh 自登的 TOF 票据（与 `vssaros-bridge/lib/tof.js` 的 `TOF_LOCAL_CREDENTIAL_REF` 同值）。 */
export const TOF_LOCAL_TICKET_REF = 'VSSAROS_TOF_TICKET_DSH';
/** IDE 侧同步过来的 TOF 票据（同 `vssaros-bridge/lib/index.js` 的 `TOF_CREDENTIAL_REF`）。 */
export const TOF_SYNCED_TICKET_REF = 'VSSAROS_TOF_TICKET';
/** dsh 侧自登的身份投影（JSON，可为空 —— 网关可达时不必要）。 */
export const TOF_IDENTITY_REF = 'VSSAROS_TOF_IDENTITY_DSH';
/** 商城 JWT 在 dsh 侧的落点（**自己的 ref**，不与上面两份混 ✓）。 */
export const MARKET_JWT_REF = 'VSSAROS_MARKET_JWT';

/** 商城服务端默认地址（与 IDE 侧 `marketplaceService.DEFAULT_ENDPOINT` 同值）。 */
export const DEFAULT_MARKET_ENDPOINT = 'http://21.6.92.5:3040';

/**
 * 数据根（`config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`）。
 *
 * ⚠ 这里**只做委托**（`foundation().dataRootOf`）—— 真源只有 `@vssaros/dsh-foundation` 那一份。
 *   之前写成"自己实现"会被守卫 `check-host-config.mjs` 判成**第三份实现**（1.3 之后不许有）✗。
 */
export function dataRootOf(config) {
	// 委托到 @vssaros/dsh-foundation（重构 1.3：真源只有一份）；调用签名不变。
	return foundation().dataRootOf(config);
}

/** 商城服务端地址：`config.marketEndpoint` → env `VSSAROS_MARKET_ENDPOINT` → 默认。 */
export function marketEndpointOf(config) {
	const configured = typeof config?.marketEndpoint === 'string' ? config.marketEndpoint.trim() : '';
	if (configured) { return configured.replace(/\/+$/, ''); }
	const fromEnv = typeof process.env.VSSAROS_MARKET_ENDPOINT === 'string' ? process.env.VSSAROS_MARKET_ENDPOINT.trim() : '';
	return (fromEnv || DEFAULT_MARKET_ENDPOINT).replace(/\/+$/, '');
}

/**
 * 把服务端的错误体整理成可读文案（**带上 details**）。
 *
 * @param {number} status
 * @param {string} body
 */
export function describeMarketError(status, body) {
	let msg = `HTTP ${status}`;
	try {
		const parsed = body ? JSON.parse(body) : null;
		if (parsed?.error) { msg = String(parsed.error); }
		const details = parsed?.details;
		if (Array.isArray(details) && details.length) {
			const brief = details
				.map(d => `${Array.isArray(d?.path) && d.path.length ? d.path.join('.') : '(根)'}：${String(d?.message ?? d)}`)
				.join('；');
			msg = `${msg}（${brief}）`;
		}
	} catch { /* body 不是 JSON ⇒ 保持 HTTP 状态文案 */ }
	return msg;
}

/**
 * 建一个商城客户端。
 *
 * @param {object} args
 * @param {object} args.credentials dsh 的凭据服务（`ctx.credentials`）
 * @param {object} args.config 插件 config（取 endpoint / dataRoot）
 * @param {(line: string) => void} [args.log]
 * @param {typeof fetch} [args.fetchImpl] 守卫注入假实现（不联网 ✓）
 */
/**
 * @param {object} args
 * @param {object} args.credentials dsh 凭据服务（存商城 JWT 用）
 * @param {object} args.config 插件配置
 * @param {() => Promise<{ ticket?: string, source?: string }>} [args.tofProvider]
 *   ★ 2026-10-23：**TOF 票据的唯一真源** —— `vssarosTof.ticket()`（bridge 提供的服务）。
 *   有这个就走它（优先级/兜底/刷新都在 bridge 一处）；没有才降级去读 credentials（见 `tofTicketCandidates`）。
 *   为什么不自己拼：两份票据并存时，各插件自己判优先级就会出现"口径打架"
 *   （本插件曾把"本地优先"写成硬编码，结果本地票据过期时永远试不到 IDE 那张 ✗）。
 */
export function createMarketClient({ credentials, config, log = () => { }, fetchImpl = fetch, tofProvider = null }) {
	const root = () => marketEndpointOf(config);
	const apiBase = () => `${root()}/api/v1`;

	/** 读一份凭据值（读不到返回 undefined，不抛）。 */
	async function readRef(ref) {
		if (!credentials || typeof credentials.resolve !== 'function') { return undefined; }
		try {
			const resolved = await credentials.resolve(ref);
			const value = resolved?.value;
			return typeof value === 'string' && value ? value : undefined;
		} catch {
			return undefined;
		}
	}

	async function writeRef(ref, value) {
		if (!credentials || typeof credentials.set !== 'function') {
			throw new Error('凭据服务不可用（credentials 缺席）—— 无法保存商城 JWT');
		}
		await credentials.set(ref, value);
	}

	/** 取 TOF 票据：**本地自登 > IDE 同步**（与 tof.js 同口径 ✓）。 */
	async function tofTicket() {
		return (await readRef(TOF_LOCAL_TICKET_REF)) ?? (await readRef(TOF_SYNCED_TICKET_REF));
	}

	/**
	 * 列出**所有**可用的 TOF 票据来源（★ 2026-10-23 修）。
	 *
	 * 真机踩到的坑：`tofTicket()` 用 `??` 只做**存在性**回退 ——
	 * 本地那张**存在但已过期**时，就永远不会去试 IDE 同步的那张 ✗
	 * ⇒ 用户明明在 IDE 里是登录状态，商城却一直报"票据无效或已过期"。
	 *
	 * 现在：两张都拿出来（去重），登录时**逐张尝试**，任一成功即用 ✓
	 *
	 * @returns {Promise<{ ticket: string, source: string }[]>}
	 */
	async function credentialTicketCandidates() {
		// ★ 2026-10-23（用户「tof 应该在 dsh 侧，不应该有多个」）：
		//   **只读 dsh 自登的那一张**。
		//   `VSSAROS_TOF_TICKET`（IDE 同步）是**已废弃路线** —— 2026-10-22 就定了
		//   「登录归 dsh 侧，IDE 只读状态」（见 `dshTofAuthService.login()`：dsh 模式下
		//   直接 call `TofSignIn`）。真机也证实：`refs` 里**只有** `…_DSH`，同步那份从未写入过 ✗
		//   ⇒ 继续读它只会掩盖"该重新登录"这个真实结论。
		const local = await readRef(TOF_LOCAL_TICKET_REF);
		return local ? [{ ticket: local, source: 'dsh 登录的票据（降级读取）' }] : [];
	}

	/**
	 * 票据候选：**先问 TOF 服务（唯一真源），它给的不能用才降级读凭据**。
	 *
	 * ★ 2026-10-23（用户要求「tof 应该在 dsh 侧，不应该有多个」）：
	 *   本插件**不再自己决定"用哪张票"** —— 那属于 TOF 服务（`vssarosTof`，bridge 提供），
	 *   由它统一处理优先级/刷新。此前这里硬编码「本地优先」，与服务口径重复且会打架 ✗
	 *
	 * ⚠ 降级只发生在"服务给的票换不到 JWT"时（`login()` 里二次调用），
	 *   目的是**别让环境问题把功能彻底废掉**；正常情况下只走服务这一条路 ✓
	 *
	 * @param {boolean} [forceCredentials] true = 直接读凭据（不试服务）
	 */
	async function tofTicketCandidates(forceCredentials = false) {
		if (!forceCredentials && typeof tofProvider === 'function') {
			try {
				const got = await tofProvider();
				if (got && typeof got.ticket === 'string' && got.ticket) {
					const where = got.source === 'ide' ? 'IDE 同步' : got.source === 'dsh' ? 'dsh 自登' : String(got.source ?? '未知');
					return [{ ticket: got.ticket, source: `TOF 服务（${where}）` }];
				}
				// 服务明确回答"没有票据" ⇒ 不猜（别偷偷翻凭据里的旧票 ✗）
				return [];
			} catch (e) {
				log(`[marketplace] TOF 服务取票失败，降级读凭据：${String(e?.message ?? e)}`);
			}
		}
		return credentialTicketCandidates();
	}

	/**
	 * 用 TOF 票据换商城 JWT（成功后就存起来）。
	 *
	 * 顺序：**先 TOF 服务**（唯一真源）→ 它给的票换不到才**降级**读凭据。
	 * 降级会打日志（说明"该修的是 TOF 服务/登录态，不是靠 marketplace 猜"）。
	 */
	async function login() {
		// 身份投影可能没有（只同步了票据）⇒ 只传 ticket 也能登（网关可达时服务端自己查 whoami ✓）
		let identity = null;
		const rawIdentity = await readRef(TOF_IDENTITY_REF);
		if (rawIdentity) {
			try { identity = JSON.parse(rawIdentity); } catch { identity = null; }
		}
		// ★ 2026-10-23（真机定位到的登录失败根因）：**字段名要读驼峰**。
		//   dsh 侧 `projectUser()` 写进凭据的是 `{ loginName, staffId, isAdmin, … }`（驼峰），
		//   而这里原先读 `identity.login_name`（下划线）⇒ 永远是 undefined ⇒
		//   服务端 `/auth/tof` 的 fallback 分支（`if (!tofUser && loginName)`）**永远进不去**
		//   ⇒ 网关那边 whoami 一失败就直接 401「且无 fallback 用户信息」✗
		//   （两种写法都认：老数据可能是下划线，别为了洁癖把兼容删掉）
		const pick = (a, b) => (a === undefined || a === null || a === '' ? b : a);
		const idLoginName = pick(identity?.loginName, identity?.login_name);
		const idStaffId = pick(identity?.staffId, identity?.staff_id);
		const idIsAdmin = pick(identity?.isAdmin, identity?.is_admin);
		const failures = [];

		/** 逐张尝试，成功返回 token，否则收集失败原因。 */
		const attempt = async (candidates) => {
			for (const candidate of candidates) {
				// `loginName` 是服务端 fallback 的**触发条件**（`if (!tofUser && loginName)`）
				// ⇒ 传了它，网关侧 whoami 失败也不会 401，而是用这份已验证过的身份 ✓
				const body = JSON.stringify({
					ticket: candidate.ticket,
					...(idLoginName ? { loginName: String(idLoginName) } : {}),
					...(idStaffId ? { staffId: String(idStaffId) } : {}),
					...(idIsAdmin === undefined || idIsAdmin === null ? {} : { isAdmin: idIsAdmin === true }),
				});
				const resp = await fetchImpl(`${apiBase()}/auth/tof`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body,
				});
				const text = await resp.text().catch(() => '');
				if (!resp.ok) {
					failures.push(`${candidate.source}被拒（${describeMarketError(resp.status, text)}）`);
					continue;
				}
				let parsed = null;
				try { parsed = JSON.parse(text); } catch { parsed = null; }
				const got = typeof parsed?.token === 'string' ? parsed.token : '';
				if (!got) {
					failures.push(`${candidate.source}：服务端没有返回 token`);
					continue;
				}
				await writeRef(MARKET_JWT_REF, got);
				log(`[marketplace] 商城登录成功（来源=${candidate.source}，endpoint=${root()}）`);
				return got;
			}
			return null;
		};

		const primary = await tofTicketCandidates();
		if (primary.length === 0) {
			throw new Error(
				'没有 TOF 票据：请先登录（dsh 侧 `tof_signin`，或让 IDE 同步登录态）',
			);
		}
		const usedService = String(primary[0]?.source ?? '').startsWith('TOF 服务');
		const fromService = await attempt(primary);
		if (fromService) { return fromService; }

		// 降级：**只有**服务那条路失败时才翻凭据（并明确记录"这是降级"）
		if (usedService) {
			const fallback = await credentialTicketCandidates();
			if (fallback.length > 0) {
				log('[marketplace] ⚠ TOF 服务的票据换不到 JWT，降级尝试凭据里的票据（根因应修 TOF 服务/重新登录）');
				const got = await attempt(fallback);
				if (got) { return got; }
			}
		}

		// 全部失败才报错，并**说清试过哪些 + 怎么修**
		// ★ 2026-10-23：指引写具体 —— 真机验证过 IDE 的「重新登录」在 dsh 模式下会
		//   `call TofSignIn`（把登录交给 dsh 侧、开系统浏览器）⇒ 用户点它就够了 ✓
		throw new Error(
			`商城登录失败：${failures.join('；')}`
			+ ' ⇒ 企业身份（TOF）票据已过期：请在 IDE 里点「重新登录」（会打开浏览器，登录由 dsh 侧完成），'
			+ '或在 dsh 里执行 `tof_signin`',
		);
	}

	/**
	 * 带鉴权的请求；401/403 时**重登一次**再试（票据过期是常态，不该让用户手动重登）。
	 *
	 * @param {string} method
	 * @param {string} urlPath 以 `/` 开头、不含 `/api/v1`
	 * @param {object} [body]
	 */
	async function request(method, urlPath, body) {
		const once = async (token) => {
			const headers = {};
			if (body !== undefined) { headers['content-type'] = 'application/json'; }
			if (token) { headers.authorization = `Bearer ${token}`; }
			return fetchImpl(`${apiBase()}${urlPath}`, {
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		};
		let token = await readRef(MARKET_JWT_REF);
		if (!token) { token = await login(); }
		let resp = await once(token);
		// ⚠ **只在 401 重登**：401 = 票据过期（换一张就好）；
		//   403 = **权限不足**（如非管理员调 /admin/*）⇒ 重登毫无意义，还会把真实原因
		//   盖成"没有 TOF 票据"（真机踩过：管理员接口的 403 被报成登录问题 ✗）
		if (resp.status === 401) {
			token = await login();
			resp = await once(token);
		}
		const text = await resp.text().catch(() => '');
		if (!resp.ok) {
			throw new Error(describeMarketError(resp.status, text));
		}
		if (!text) { return undefined; }
		try { return JSON.parse(text); } catch { return undefined; }
	}

	/**
	 * **二进制**下载（包本体）：`request` 只处理 JSON ⇒ 这里单独一条 ✓。
	 *
	 * @param {string} urlPath 以 `/` 开头、不含 `/api/v1`
	 * @returns {Promise<Buffer>}
	 */
	async function download(urlPath) {
		const once = async (token) => {
			const headers = {};
			if (token) { headers.authorization = `Bearer ${token}`; }
			return fetchImpl(`${apiBase()}${urlPath}`, { method: 'GET', headers });
		};
		let token = await readRef(MARKET_JWT_REF);
		if (!token) { token = await login(); }
		let resp = await once(token);
		// ⚠ 只在 401 重登（403 = 权限不足，换票无用）—— 与 request() 同一口径 ✓
		if (resp.status === 401) {
			token = await login();
			resp = await once(token);
		}
		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw new Error(`下载失败：${describeMarketError(resp.status, text)}`);
		}
		if (typeof resp.arrayBuffer !== 'function') {
			throw new Error('下载失败：这个 fetch 实现不支持二进制（arrayBuffer）');
		}
		return Buffer.from(await resp.arrayBuffer());
	}

	/**
	 * **二进制上传**（raw tar.gz）：`POST /packages/:slug/versions/raw`。
	 *
	 * 服务端契约（`versions.ts` 的 `/raw`）：`Content-Type: application/x-gzip`、
	 * `X-Changelog: <urlencoded>`、body = tar.gz 字节 ✓
	 *
	 * @param {string} urlPath
	 * @param {Buffer} buffer
	 * @param {{ changelog?: string }} [opts]
	 */
	async function upload(urlPath, buffer, opts = {}) {
		const once = async (token) => {
			const headers = { 'content-type': 'application/x-gzip' };
			if (opts.changelog) { headers['x-changelog'] = encodeURIComponent(String(opts.changelog)); }
			if (token) { headers.authorization = `Bearer ${token}`; }
			return fetchImpl(`${apiBase()}${urlPath}`, { method: 'POST', headers, body: buffer });
		};
		let token = await readRef(MARKET_JWT_REF);
		if (!token) { token = await login(); }
		let resp = await once(token);
		// ⚠ 只在 401 重登（403 = 权限不足，换票无用）—— 与 request() 同一口径 ✓
		if (resp.status === 401) {
			token = await login();
			resp = await once(token);
		}
		const text = await resp.text().catch(() => '');
		if (!resp.ok) {
			throw new Error(`上传失败：${describeMarketError(resp.status, text)}`);
		}
		try { return text ? JSON.parse(text) : undefined; } catch { return undefined; }
	}

	/**
	 * 列商品（服务端筛：kind / q / category / scope）。
	 *
	 * @param {{ kind?: string, q?: string, category?: string, scope?: 'all'|'mine'|'review', pageSize?: number }} opts
	 */
	async function list(opts = {}) {
		const qs = new URLSearchParams();
		if (opts.kind) { qs.set('kind', opts.kind); }
		if (opts.q) { qs.set('q', opts.q); }
		if (opts.category) { qs.set('category', opts.category); }
		if (opts.scope) { qs.set('scope', opts.scope); }
		// ★ 2026-10-22：分页（商城里 skill/mcp 各 500+ 条 ⇒ 不分页等于看不到大部分 ✗）
		if (opts.page) { qs.set('page', String(opts.page)); }
		// 排序（服务端 `sort: recent|popular|name`；不传就是服务端默认 recent ✓）
		if (opts.sort) { qs.set('sort', opts.sort); }
		qs.set('pageSize', String(opts.pageSize ?? 50));
		const res = await request('GET', `/packages?${qs.toString()}`);
		return {
			items: Array.isArray(res?.items) ? res.items : [],
			total: Number(res?.total) || 0,
			page: Number(res?.page) || (opts.page ?? 1),
			pageSize: Number(res?.pageSize) || (opts.pageSize ?? 50),
		};
	}

	/** 商品详情（含版本列表 + permissions）。 */
	async function detail(slug) {
		if (!slug) { throw new Error('marketplace.detail 需要 slug'); }
		return request('GET', `/packages/${encodeURIComponent(slug)}`);
	}

	/**
	 * 编辑包元数据（作者或管理员；服务端 `assertAuthor` 判权）。
	 *
	 * 只传**要改的字段**（服务端用 `COALESCE` ⇒ 不传的保持不变 ✓）；
	 * `kind`/`slug` 不可改（它们是身份）⇒ 这里不收。
	 */
	async function updatePackage(idOrSlug, patch) {
		if (!idOrSlug) { throw new Error('updatePackage 需要 slug 或 id'); }
		const body = {};
		if (typeof patch.name === 'string' && patch.name.trim()) { body.name = patch.name.trim(); }
		if (typeof patch.description === 'string') { body.description = patch.description; }
		if (typeof patch.category === 'string') { body.category = patch.category; }
		if (typeof patch.icon === 'string') { body.icon = patch.icon; }
		if (patch.visibility === 'public' || patch.visibility === 'private') { body.visibility = patch.visibility; }
		if (Array.isArray(patch.tags)) { body.tags = patch.tags.map(t => String(t)).filter(Boolean); }
		if (Object.keys(body).length === 0) { throw new Error('没有要改的字段'); }
		return request('PUT', `/packages/${encodeURIComponent(idOrSlug)}`, body);
	}

	/**
	 * 管理员：审核队列（待审核的包）。
	 *
	 * 服务端 `/admin/*` 整段挂了 `requireAuth + requireAdmin` ⇒ 非管理员会 403，
	 * 这里**如实抛**（页面上显示"需要管理员权限"，不静默空列表）✓
	 */
	async function reviewList() {
		const res = await request('GET', '/admin/review');
		return { items: Array.isArray(res?.items) ? res.items : [], total: Number(res?.total) || 0 };
	}

	/** 管理员：改包状态（`active` 通过 / `removed` 拒绝下架 / `pending_review` 打回）。 */
	async function reviewSetStatus(idOrSlug, status) {
		if (!idOrSlug) { throw new Error('reviewStatus 需要 slug 或 id'); }
		if (!['active', 'pending_review', 'removed'].includes(status)) {
			throw new Error(`reviewStatus 的 status 不认识：${status}`);
		}
		return request('PUT', `/admin/packages/${encodeURIComponent(idOrSlug)}/status`, { status });
	}

	/** 管理员：推荐位开关。 */
	async function reviewSetFeatured(idOrSlug, featured) {
		if (!idOrSlug) { throw new Error('reviewFeature 需要 slug 或 id'); }
		return request('PUT', `/admin/packages/${encodeURIComponent(idOrSlug)}/featured`, { featured: featured === true });
	}

	/** 升级检查（批量）。 */
	async function checkUpgrades(items) {
		if (!Array.isArray(items) || items.length === 0) { return []; }
		const res = await request('POST', '/upgrade/check', { items });
		return Array.isArray(res?.updates) ? res.updates : [];
	}

	/**
	 * **只报状态**（供 self-check / 排障）：每个票据来源在不在、多长 ——
	 * **绝不回传票据值** ✓（凭据值一旦进了日志/页面就等于泄露）
	 */
	async function tofTicketSources() {
		const list = await tofTicketCandidates();
		return list.map(c => ({ source: c.source, present: true, length: c.ticket.length }));
	}

	return {
		login, request, download, upload, list, detail, checkUpgrades,
		reviewList, reviewSetStatus, reviewSetFeatured, updatePackage,
		tofTicketSources,
		endpoint: root, tofTicket,
	};
}
