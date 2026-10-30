// @vssaros/dsh-bridge — CodeBuddy 模型 provider 的 **dsh 侧实现**（2026-10-22）。
//
// 为什么搬到 Host：用户要求"codebuddy provider 改成 dsh 侧实现，在 dsh 窗口版设置页的模型里展示和配置"
//   ⇒ 登录 / token 刷新 / 模型目录 / 路由写入全部在 Host 里做，不再依赖 IDE 扩展宿主
//   （此前链路：扩展 `_codebuddy.dshProviderConfig` → IDE 渲染进程收集 → 桥 `providers.sync` 写 profile ⇒
//    没有 IDE 工作台就没有 CodeBuddy 模型，且 token 过期后无人刷新）。
//
// 移植来源（行为逐条对齐，便于对照复核）：
//   · 登录：`extensions/codebuddy-provider/src/auth.ts`（cli-external-link：state → 浏览器 → 轮询 token）
//   · 刷新：同上 `_doRefreshToken`（X-Refresh-Token；401/403 ⇒ 清登录态；5xx ⇒ 保留稍后再试）
//   · 目录：`extensions/codebuddy-provider/src/extension.ts` 的 `fetchModelsFromConfigApi`
//     （GET /v3/config；craft/ask allow-list ∪ chat-capable；**不回落**内置 model.json —— 2026-10-11 产品口径）
//   · 导出形状：同文件 `_codebuddy.dshProviderConfig`（baseURL = {endpoint}/v2、身份头去掉 Authorization）
//
// 安全边界（与 TOF 票据同一档，见 tof.js 文件头）：
//   · access token 存在 `VSSAROS_CODEBUDDY_KEY`（= pi-ai 路由的 apiKeyEnv，**按请求解析** ⇒ 刷新后立即生效）；
//   · refresh token 等会话信息存在 `VSSAROS_CODEBUDDY_SESSION`（JSON）；两者都在 dsh 的 `.credentials.yaml`
//     （**明文**，同 UID 进程可读）—— 与此前 IDE 侧经 providers.sync 写进同一处的做法相同，暴露面没有扩大；
//   · **任何对外投影（HTTP / 桥回执）都不含 token** —— 只有 userId / 租户 / 过期时间 / 模型数。
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildRouteProfile, sanitizeHeaders, writeOwnedRoute } from './providerProfile.js';

/** dsh 里的路由名（与 IDE 侧 `providerRouteFor('codebuddy')` 一致 ⇒ 会话里已记录的引用不失效）。 */
export const CODEBUDDY_ROUTE = 'vssaros-codebuddy';
export const CODEBUDDY_DISPLAY_NAME = 'CodeBuddy';
/** access token 的凭据引用（与 IDE 侧 `credentialRefFor('codebuddy')` **逐字一致** ⇒ 换所有权不改 profile）。 */
export const CODEBUDDY_CREDENTIAL_REF = 'VSSAROS_CODEBUDDY_KEY';
/**
 * ★ OAuth access token 的**专用** ref（只有本桥写 ⇒ 不会被 `providers.sync` 抢）。
 *
 * 背景（2026-10-28）：`VSSAROS_CODEBUDDY_KEY` 同时被
 *   ① 本桥（OAuth access token）与 ② IDE `providers.sync`（**API Key**）写
 * ⇒ 后写者赢 ⇒ Host 侧可能拿到 API Key ⇒ 平台对它的 `/v3/config` 拒答 ⇒ 节点模型数为 0。
 * ⇒ 需要 OAuth 的调用方（例如中转站 Node Agent 拉模型目录）读**这个** ref ✓
 */
export const CODEBUDDY_ACCESS_TOKEN_REF = 'VSSAROS_CODEBUDDY_ACCESS_TOKEN';
/** 会话信息（refresh token / 过期时间 / 来源）的凭据引用（JSON 字符串）。 */
export const CODEBUDDY_SESSION_REF = 'VSSAROS_CODEBUDDY_SESSION';
/**
 * "用户在 dsh 侧**主动登出**过"的标记（值 '1'）。过渡期 IDE 会把扩展里的登录态迁过来 ——
 * 没有这个标记，用户在 dsh 侧一登出、下一轮同步就被 IDE 原样导回来（登出不掉 ✗）。
 * 用户在 dsh 侧再次登录时清掉。
 */
export const CODEBUDDY_SIGNED_OUT_REF = 'VSSAROS_CODEBUDDY_SIGNED_OUT';

export const CODEBUDDY_DEFAULTS = Object.freeze({
	endpoint: 'https://copilot.tencent.com',
	authPlatform: 'ide',
	/** 浏览器登录的总等待上限（扩展是 120 次 × 1s；这里给 5 分钟，企业 SSO 常要多跳几次）。 */
	loginTimeoutSeconds: 300,
	/** 模型目录缓存（与扩展 `MODELS_CACHE_TTL_MS` 同值）。 */
	modelsTtlMs: 5 * 60_000,
	requestTimeoutMs: 15_000,
});

/** token 离过期不足这么久就刷新（与扩展 `getAccessToken` 的 5 分钟同值）。 */
export const REFRESH_SKEW_MS = 5 * 60_000;

/** IDE 身份头取值（对齐扩展抓包常量；网关按 X-IDE-* 做归属/限流判定）。 */
const IDE_TYPE = 'VSCode';
const IDE_NAME = 'VSCode';
const IDE_VERSION = '1.122.0';
const PRODUCT_VERSION = '4.3.20019762';

/** 未登录态请求要带的"别给我塞身份"头（扩展 `_requestAuthState` / `_pollForToken` 原样）。 */
const NO_AUTH_HEADERS = Object.freeze({
	'X-No-Authorization': 'true',
	'X-No-User-Id': 'true',
	'X-No-Enterprise-Id': 'true',
	'X-No-Department-Info': 'true',
});

// ─── 纯函数（守卫 `check-dsh-codebuddy.mjs` 逐条断言）─────────────────────────

/** 解 JWT payload（不验签，只取 claims）。 */
export function decodeJwtPayload(token) {
	try {
		const parts = String(token ?? '').split('.');
		if (parts.length !== 3) { return undefined; }
		const payload = parts[1];
		const padded = payload + '=='.slice(0, (4 - payload.length % 4) % 4);
		return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
	} catch {
		return undefined;
	}
}

/** 从 JWT 的 iss 取租户 id（`.../realms/sso-<tenantId>`）。 */
export function extractTenantIdFromIss(iss) {
	const match = /\/realms\/sso-([^/]+)$/.exec(String(iss ?? ''));
	return match ? match[1] : undefined;
}

/** token 里的身份（userId = sub，tenantId 取自 iss）—— 对外投影用，**不含 token 本身**。 */
export function identityOf(accessToken) {
	const jwt = decodeJwtPayload(accessToken);
	const userId = typeof jwt?.sub === 'string' ? jwt.sub : '';
	const tenantId = typeof jwt?.iss === 'string' ? (extractTenantIdFromIss(jwt.iss) ?? '') : '';
	const name = typeof jwt?.preferred_username === 'string' ? jwt.preferred_username
		: typeof jwt?.name === 'string' ? jwt.name : '';
	return { userId, tenantId, name };
}

/**
 * 网关身份头（**不含** Authorization —— token 走路由的 apiKeyEnv，每次请求现解析）。
 * 与扩展 `buildCodeBuddyIdentityHeaders` 去掉 Authorization 后**逐键一致**。
 */
export function identityHeaders(accessToken) {
	const { userId, tenantId } = identityOf(accessToken);
	return {
		'X-IDE-Type': IDE_TYPE,
		'X-IDE-Name': IDE_NAME,
		'X-IDE-Version': IDE_VERSION,
		'X-Product-Version': PRODUCT_VERSION,
		'X-Env-ID': 'production',
		'X-User-Id': userId,
		'X-Enterprise-Id': tenantId,
		'X-Tenant-Id': tenantId,
		'X-Domain': 'tencent.sso.codebuddy.cn',
		'X-Product': 'SaaS',
		'User-Agent': `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${PRODUCT_VERSION}`,
	};
}

/** 过期时刻（毫秒）：秒/毫秒两种写法都认；都没有 ⇒ 1 小时后（扩展 `_calcExpiry` 同口径）。 */
export function calcExpiry(expiresAt, expiresIn, now = Date.now()) {
	const at = Number(expiresAt);
	if (Number.isFinite(at) && at > 0) {
		return at > 1e12 ? at : at * 1000;
	}
	const inSec = Number(expiresIn);
	if (Number.isFinite(inSec) && inSec > 0) {
		return now + inSec * 1000;
	}
	return now + 3600_000;
}

/** 该会话是否该刷新了（离过期不足 `REFRESH_SKEW_MS`）。 */
export function needsRefresh(session, now = Date.now()) {
	return !session || !Number.isFinite(session.expiresAt) || session.expiresAt <= now + REFRESH_SKEW_MS;
}

/** 目录条目能不能当聊天模型用（扩展 `isChatCapableModel` 原样：排除生图 / 补全小模型）。 */
export function isChatCapableModel(model) {
	if (!model || !model.id) { return false; }
	const tags = Array.isArray(model.tags) ? model.tags : [];
	if (tags.some(t => typeof t === 'string' && t.includes('image'))) { return false; }
	if (!model.maxInputTokens && (model.maxOutputTokens ?? 0) <= 256) { return false; }
	return true;
}

/** 单条目录条目 ⇒ 路由模型（与扩展 `_codebuddy.dshProviderConfig` 导出形状一致）。 */
function toRouteModel(raw) {
	const id = String(raw.id);
	const name = typeof raw.name === 'string' && raw.name && raw.name !== id ? raw.name : undefined;
	const effort = raw.reasoning && typeof raw.reasoning === 'object' ? raw.reasoning.effort : undefined;
	return {
		id,
		...(name ? { name } : {}),
		...(raw.supportsReasoning === true ? { reasoning: true } : {}),
		// ★ 2026-10-30：**图像能力位必须带出去**。平台目录逐模型给了 `supportsImages`
		// （登录后 console.table 里那列 `images` 全是 true），此前这里只导 reasoning ⇒
		// 本文件是 dsh 侧**自持** CodeBuddy 的唯一模型来源（`providers.sync` 会跳过
		// `DSH_OWNED_ROUTES`）⇒ 少这一位，dsh 就把所有模型当纯文本，
		// 工具产出的图被剥离并报「model does not declare image input support」。
		// 翻译成 pi-ai 的 `input: ['text','image']` 由 providerProfile.buildRouteProfile 负责。
		...(raw.supportsImages === true ? { supportsImages: true } : {}),
		// ★ 2026-10-30：**上下文长度**。平台目录逐模型给了 `maxInputTokens` /
		// `maxOutputTokens`（console.table 的 maxInput / maxOutput），此前这里只导
		// reasoning ⇒ dsh 侧一直用 pi-ai 缺省窗口 ⇒ 压缩阈值按错窗口算：
		// 要么过早压缩白扔上下文，要么超窗才报错。
		// 翻译成 pi-ai 的模型级 `contextWindow` / `maxTokens` 由
		// providerProfile.buildRouteProfile 负责。只导正有限数。
		...(typeof raw.maxInputTokens === 'number' && Number.isFinite(raw.maxInputTokens) && raw.maxInputTokens > 0
			? { contextWindow: raw.maxInputTokens } : {}),
		...(typeof raw.maxOutputTokens === 'number' && Number.isFinite(raw.maxOutputTokens) && raw.maxOutputTokens > 0
			? { maxTokens: raw.maxOutputTokens } : {}),
		...(effort === 'low' || effort === 'medium' || effort === 'high' ? { effort } : {}),
	};
}

/**
 * `/v3/config` 响应 ⇒ 聊天模型清单。
 *
 * 规则（扩展 `fetchModelsFromConfigApi` 原样）：
 *  ① 有 craft（否则 ask）agent 的 allow-list ⇒ 先按它的顺序列（缺元数据的照样列），
 *     再补 `data.models` 里通过 `isChatCapableModel`、但不在 allow-list 的（2026-10-10：hy4 就是这样漏的）；
 *  ② 没有 allow-list ⇒ 只按启发式过滤；
 *  ③ 结果为空 ⇒ `[]`（**权威的空**：调用方据此撤路由，不回落任何静态快照）。
 *
 * @returns {{ models: Array<{id:string,name?:string,reasoning?:true,effort?:string}>, rawCount:number, allowList:string|null }|null}
 *   null = 响应结构不对 / code≠0（**不是**权威的空 ⇒ 调用方保留现状）
 */
export function resolveChatModels(json) {
	if (!json || typeof json !== 'object' || json.code !== 0 || !json.data || typeof json.data !== 'object') {
		return null;
	}
	const rawModels = Array.isArray(json.data.models) ? json.data.models.filter(m => m && m.id) : [];
	const agents = Array.isArray(json.data.agents) ? json.data.agents : [];
	if (rawModels.length === 0) {
		return { models: [], rawCount: 0, allowList: null };
	}
	const metaById = new Map(rawModels.map(m => [m.id, m]));
	const agent = agents.find(a => a?.name === 'craft') ?? agents.find(a => a?.name === 'ask');
	const allowList = Array.isArray(agent?.models) && agent.models.length > 0 ? agent.models : undefined;
	const out = [];
	const seen = new Set();
	if (allowList) {
		for (const id of allowList) {
			if (!id || seen.has(id)) { continue; }
			seen.add(id);
			out.push(toRouteModel(metaById.get(id) ?? { id }));
		}
	}
	for (const m of rawModels) {
		if (seen.has(m.id) || !isChatCapableModel(m)) { continue; }
		seen.add(m.id);
		out.push(toRouteModel(m));
	}
	return { models: out.filter(m => m.id), rawCount: rawModels.length, allowList: allowList ? String(agent.name) : null };
}

/**
 * 路由条目（`providers.sync` 负载同形）：与 IDE 侧 `buildProvidersSyncArgs` 对 codebuddy 源的产出**同形**。
 *
 * @param {{ baseURL:string, accessToken:string, models:Array }} args
 */
export function codebuddyRouteEntry({ baseURL, accessToken, models }) {
	return {
		route: CODEBUDDY_ROUTE,
		displayName: CODEBUDDY_DISPLAY_NAME,
		api: 'openai-completions',
		baseURL: String(baseURL).trim().replace(/\/+$/, ''),
		credentialRef: CODEBUDDY_CREDENTIAL_REF,
		headers: sanitizeHeaders(identityHeaders(accessToken)),
		// 与 IDE 侧同一上限（跨进程校验器 `models.length > 200` 拒绝）。
		models: models.slice(0, 200).filter(m => m && typeof m.id === 'string' && m.id),
	};
}

// ─── 本机 CodeBuddy 登录态复用（官方 CLI 的 ~/.codebuddy/local_storage）──────────────

const gunzipAsync = promisify(gunzip);

function deepFindToken(data, depth, now) {
	if (depth > 5 || !data || typeof data !== 'object') { return undefined; }
	if (typeof data.accessToken === 'string' && data.accessToken.length > 10) {
		return { accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: calcExpiry(data.expiresAt, data.expires_in, now) };
	}
	const skip = new Set(['models', 'config', 'links', 'commitMessage', 'completion', 'productName', '$schema']);
	for (const key of Object.keys(data)) {
		if (skip.has(key)) { continue; }
		const found = deepFindToken(data[key], depth + 1, now);
		if (found) { return found; }
	}
	return undefined;
}

/** 从一条已解码的 local_storage 条目里取 token（扩展 `_extractTokenFromDecodedEntry` 原样的三条路径）。 */
export function extractLocalStorageToken(data, now = Date.now()) {
	const auth = data?.session?.auth;
	if (auth?.accessToken) {
		return { accessToken: auth.accessToken, refreshToken: auth.refreshToken, expiresAt: calcExpiry(auth.expiresAt, auth.expires_in, now) };
	}
	const accounts = data?.session?.accounts;
	if (Array.isArray(accounts)) {
		for (const account of accounts) {
			const a = account?.auth;
			if (a?.accessToken) {
				const expiresAt = calcExpiry(a.expiresAt, a.expires_in, now);
				if (expiresAt > now) {
					return { accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt };
				}
			}
		}
	}
	return deepFindToken(data, 0, now);
}

/**
 * 读本机 CodeBuddy（官方 IDE/CLI）的 local_storage：返回 `{ token?, ioa }`。
 * 目录不存在/读不动一律当"没有"（这是锦上添花的复用路径，不能让登录因此失败）。
 */
export async function readLocalCodeBuddyState(dir, now = Date.now()) {
	const result = { token: undefined, ioa: false };
	let files = [];
	try { files = await readdir(dir); } catch { return result; }
	for (const file of files) {
		let parsed;
		try { parsed = JSON.parse(await readFile(join(dir, file), 'utf8')); } catch { continue; }
		if (parsed === 'iOA') { result.ioa = true; continue; }
		if (!result.token && typeof parsed === 'string' && parsed.startsWith('H4sI')) {
			try {
				// 异步解压（守卫 dshPluginPackages：Host 里不许同步解压 ⇒ 大条目会卡住 Host 主线程 ✗）
				const decoded = JSON.parse((await gunzipAsync(Buffer.from(parsed, 'base64'))).toString());
				const token = extractLocalStorageToken(decoded, now);
				if (token && token.expiresAt > now) { result.token = token; }
			} catch { /* 跳过解不开的条目 */ }
		}
	}
	return result;
}

/** 本机 local_storage 目录（`CODEBUDDY_CONFIG_DIR` 优先，与官方 CLI 一致）。 */
export function defaultLocalStorageDir(env = process.env) {
	return join(env.CODEBUDDY_CONFIG_DIR || join(homedir(), '.codebuddy'), 'local_storage');
}

// ─── 服务 ───────────────────────────────────────────────────────────────────

/**
 * dsh 侧 CodeBuddy 服务。
 *
 * @param {object} deps
 * @param {object} deps.credentials ctx.credentials
 * @param {object} deps.settings ctx.settings（写 `llm-pi-ai` 的 `providers.vssaros-codebuddy`）
 * @param {function} [deps.fetchImpl] 默认全局 fetch（守卫注入假实现 ⇒ 不联网）
 * @param {function} [deps.openExternal] 打开系统浏览器（默认由调用方传 tof.js 的 openExternalUrl）
 * @param {function} [deps.onRouteWritten] 路由写完后的回调（index.js 用它对齐默认模型）
 * @param {object} [deps.config] 覆盖 endpoint / authPlatform / loginTimeoutSeconds
 * @param {function} [deps.now]
 * @param {function} [deps.sleep]
 * @param {string} [deps.localStorageDir]
 * @param {function} [deps.log]
 */
export function createCodeBuddyService(deps) {
	const {
		credentials,
		settings,
		fetchImpl = (...args) => fetch(...args),
		openExternal = async () => { throw new Error('未提供打开浏览器的实现'); },
		onRouteWritten = () => { },
		config = {},
		now = () => Date.now(),
		sleep = ms => new Promise(r => setTimeout(r, ms)),
		localStorageDir = defaultLocalStorageDir(),
		log = () => { },
	} = deps;
	const cfg = {
		endpoint: (String(config.endpoint ?? '').trim() || CODEBUDDY_DEFAULTS.endpoint).replace(/\/+$/, ''),
		authPlatform: String(config.authPlatform ?? '').trim() || CODEBUDDY_DEFAULTS.authPlatform,
		loginTimeoutSeconds: (() => {
			const n = Number(config.loginTimeoutSeconds);
			return Number.isFinite(n) && n > 0 ? Math.min(900, Math.floor(n)) : CODEBUDDY_DEFAULTS.loginTimeoutSeconds;
		})(),
	};
	/** 有效 baseURL 的解析器（index.js 在接上 IDE 后换成"经计费代理"；默认直连）。 */
	let resolveBaseURL = async real => real;

	let signingIn = null;          // 进行中的登录（并发调用共用同一次）
	let signInDeadline = null;     // 浏览器登录的等待截止时刻（epoch ms；设置页显示倒计时用）
	let cancelRequested = false;
	let lastError = '';
	let modelsCache = null;        // { models, fetchedAt, rawCount, allowList }
	let routeChain = Promise.resolve();
	let lastRoute = { written: false, models: 0, at: 0, why: '' };

	const timed = async (url, init, timeoutMs = CODEBUDDY_DEFAULTS.requestTimeoutMs) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetchImpl(url, { ...init, signal: controller.signal });
		} catch (e) {
			const cause = e?.cause ? `（${e.cause.code ?? ''} ${e.cause.message ?? ''}）` : '';
			if (e?.name === 'AbortError') {
				throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${url}${cause} —— 检查网络/系统代理`);
			}
			throw new Error(`请求失败：${url}：${String(e?.message ?? e)}${cause}`);
		} finally {
			clearTimeout(timer);
		}
	};

	// ── 会话持久化（凭据存储）──────────────────────────────────────────────
	const readRef = async ref => {
		if (!credentials || typeof credentials.resolve !== 'function') { return undefined; }
		try {
			const v = (await credentials.resolve(ref))?.value;
			return typeof v === 'string' && v ? v : undefined;
		} catch {
			return undefined;
		}
	};
	const readSession = async () => {
		// ★ 2026-10-28：access token 优先从**专用 ref** 读（`VSSAROS_CODEBUDDY_ACCESS_TOKEN`）。
		//   原因：`VSSAROS_CODEBUDDY_KEY` 那个槽位有**两个写入方** —— 本桥（OAuth token）与
		//   IDE 的 `providers.sync`（**API Key**）⇒ 后写者赢 ⇒ 从旧 ref 读到的可能已是 API Key
		//   ⇒ 拿它拉模型目录会被平台拒答（code:12403）⇒ 节点模型数 0 ✗
		//   ⇒ OAuth token 另存专用 ref（只有本桥写）⇒ 这里优先读它；旧 ref 只作**回退**
		//   （老数据：那时那一份确实是 OAuth token）。
		const accessToken = await readRef(CODEBUDDY_ACCESS_TOKEN_REF) || await readRef(CODEBUDDY_CREDENTIAL_REF);
		if (!accessToken) { return undefined; }
		let meta = {};
		const raw = await readRef(CODEBUDDY_SESSION_REF);
		if (raw) {
			try { meta = JSON.parse(raw) ?? {}; } catch { meta = {}; }
		}
		return {
			accessToken,
			refreshToken: typeof meta.refreshToken === 'string' && meta.refreshToken ? meta.refreshToken : undefined,
			// 老数据（IDE providers.sync 写的那份）没有会话信息 ⇒ 当作"未知过期"，能用就用、401 再说。
			expiresAt: Number.isFinite(meta.expiresAt) ? meta.expiresAt : Number.POSITIVE_INFINITY,
			source: typeof meta.source === 'string' ? meta.source : 'legacy',
			signedInAt: Number.isFinite(meta.signedInAt) ? meta.signedInAt : undefined,
		};
	};
	const saveSession = async ({ accessToken, refreshToken, expiresAt, source, signedInAt }) => {
		if (!credentials || typeof credentials.set !== 'function') {
			throw new Error('凭据服务不可用（credentials 缺席）—— 无法保存 CodeBuddy 登录态');
		}
		// ★ 2026-10-28：**OAuth token 只写专用 ref**（`VSSAROS_CODEBUDDY_ACCESS_TOKEN`）。
		//   ⚠ **不再写** `VSSAROS_CODEBUDDY_KEY` —— 那个槽位是 pi-ai 路由的 `apiKeyEnv`，
		//     归 `providers.sync`（**API Key**）所有 ⇒ 本桥往里写 OAuth token 就是**抢**
		//     ⇒ 谁后写谁赢 ⇒ 路由可能拿到 OAuth token（目录拉不到）或 API Key（目录被拒答）⇒
		//     表现为"节点模型数 0"这类玄学问题 ✗
		await credentials.set(CODEBUDDY_ACCESS_TOKEN_REF, accessToken);
		//   （聊天仍用 API Key —— pi-ai 的 apiKeyEnv 指向 `VSSAROS_CODEBUDDY_KEY` ⇒ 不变 ✓）
		await credentials.set(CODEBUDDY_SESSION_REF, JSON.stringify({
			...(refreshToken ? { refreshToken } : {}),
			expiresAt,
			source,
			signedInAt: signedInAt ?? now(),
		}));
		// 用户在 dsh 侧**主动登录**（浏览器 / 复用本机）⇒ 撤掉"主动登出过"的标记（迁移与刷新不动它）
		if (source === 'cli_external_link' || source === 'local_storage') {
			try { await credentials.unset?.(CODEBUDDY_SIGNED_OUT_REF); } catch { /* 缺席即可 */ }
		}
	};
	const signedOutByUser = async () => (await readRef(CODEBUDDY_SIGNED_OUT_REF)) === '1';
	const clearSession = async () => {
		for (const ref of [CODEBUDDY_CREDENTIAL_REF, CODEBUDDY_ACCESS_TOKEN_REF, CODEBUDDY_SESSION_REF]) {
			try { await credentials?.unset?.(ref); } catch { /* 幂等：缺席即可 */ }
		}
		modelsCache = null;
	};

	// ── token 刷新（扩展 `_doRefreshToken` 同口径）───────────────────────────
	let refreshing = null;
	const refresh = async session => {
		if (refreshing) { return refreshing; }
		refreshing = (async () => {
			if (!session?.refreshToken) { return undefined; }
			let res;
			try {
				res = await timed(`${cfg.endpoint}/v2/plugin/auth/token/refresh`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'X-Refresh-Token': session.refreshToken, 'X-Auth-Refresh-Source': 'plugin' },
					body: '{}',
				});
			} catch (e) {
				lastError = `刷新登录态失败：${String(e?.message ?? e)}`;
				return undefined;   // 网络问题：保留旧会话，下一轮再试
			}
			if (res.status === 401 || res.status === 403) {
				lastError = `CodeBuddy 登录已失效（刷新返回 HTTP ${res.status}），请重新登录`;
				log(`[vssaros-codebuddy] refresh rejected (HTTP ${res.status}) ⇒ 清掉登录态`);
				await clearSession();
				return null;        // null = 明确失效（区别于 undefined 的"暂时失败"）
			}
			if (!res.ok) {
				lastError = `刷新登录态失败：HTTP ${res.status}（稍后自动重试）`;
				return undefined;
			}
			const data = (await res.json().catch(() => ({})))?.data ?? {};
			if (!data.accessToken) {
				lastError = '刷新登录态失败：响应里没有 accessToken';
				return undefined;
			}
			const next = {
				accessToken: data.accessToken,
				refreshToken: data.refreshToken ?? session.refreshToken,
				expiresAt: calcExpiry(data.expiresAt, undefined, now()),
				source: session.source,
				signedInAt: session.signedInAt,
			};
			await saveSession(next);
			lastError = '';
			log('[vssaros-codebuddy] token refreshed');
			return next;
		})();
		try {
			return await refreshing;
		} finally {
			refreshing = null;
		}
	};

	/** 当前可用的 access token（必要时先刷新）；没有 ⇒ undefined。 */
	const accessToken = async () => {
		const session = await readSession();
		if (!session) { return undefined; }
		if (!needsRefresh(session, now())) { return session.accessToken; }
		if (!session.refreshToken) {
			// 没有 refresh token（老数据 / 导入的只有 access token）：过期了就是过期了
			return session.expiresAt > now() ? session.accessToken : undefined;
		}
		const next = await refresh(session);
		if (next) { return next.accessToken; }
		if (next === null) { return undefined; }
		// 暂时刷新失败：没真过期就先用着
		return session.expiresAt > now() ? session.accessToken : undefined;
	};

	// ── 模型目录 ──────────────────────────────────────────────────────────────
	/**
	 * @returns {Promise<Array|null>} 模型清单；`[]` = 平台权威地说"没有"；null = 这次取不到（保留现状）
	 */
	const fetchModels = async ({ force = false, retried = false } = {}) => {
		if (!force && modelsCache && now() - modelsCache.fetchedAt < CODEBUDDY_DEFAULTS.modelsTtlMs) {
			return modelsCache.models;
		}
		const token = await accessToken();
		if (!token) { return []; }
		let res;
		try {
			res = await timed(`${cfg.endpoint}/v3/config`, {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${token}`,
					...identityHeaders(token),
					Accept: 'application/json, text/plain, */*',
					'X-Requested-With': 'XMLHttpRequest',
					'X-Request-Trace-Id': randomUUID(),
					'X-Request-ID': randomUUID().replace(/-/g, ''),
				},
			});
		} catch (e) {
			lastError = `取模型目录失败：${String(e?.message ?? e)}`;
			return null;
		}
		if (res.status === 401) {
			// 目录接口 401 ⇒ token 不被认：先试一次刷新（只试一次，防递归）。
			//   刷新成功 ⇒ 重取；刷新**暂时**失败（网络/5xx）⇒ 保留现状（返回 null，不撤路由 ✓）；
			//   刷新被拒 / 没有 refresh token ⇒ 登录态确实失效 ⇒ 清掉并返回权威的空。
			const session = await readSession();
			if (session?.refreshToken && !retried) {
				const next = await refresh(session);
				if (next) { return fetchModels({ force: true, retried: true }); }
				if (next === undefined) {
					lastError = `目录接口 HTTP 401，刷新登录态暂时失败（${lastError || '稍后自动重试'}）`;
					return null;
				}
			} else {
				await clearSession();
			}
			lastError = 'CodeBuddy 登录已失效（目录接口 HTTP 401），请重新登录';
			return [];
		}
		if (!res.ok) {
			lastError = `取模型目录失败：HTTP ${res.status}`;
			return null;
		}
		const resolved = resolveChatModels(await res.json().catch(() => null));
		if (!resolved) {
			lastError = '取模型目录失败：响应结构不对（code≠0 或缺 data）';
			return null;
		}
		modelsCache = { ...resolved, fetchedAt: now() };
		if (resolved.models.length === 0) {
			lastError = resolved.rawCount === 0
				? '平台对当前账号没有返回任何模型（data.models 为空）—— 换有模型的账号登录'
				: '平台目录里没有可用的聊天模型';
		} else {
			lastError = '';
		}
		log(`[vssaros-codebuddy] models: ${resolved.models.length}（raw ${resolved.rawCount}，allow-list=${resolved.allowList ?? '无'}）`);
		return resolved.models;
	};

	// ── 路由写入（串行化：并发触发只排队，不互相覆盖）────────────────────────
	const syncRoute = (reason = '') => {
		const run = routeChain.then(async () => {
			const token = await accessToken();
			if (!token) {
				const r = await writeOwnedRoute(settings, CODEBUDDY_ROUTE, null);
				lastRoute = { written: false, models: 0, at: now(), why: r.changed ? 'removed（未登录）' : 'absent' };
				if (r.changed) { log(`[vssaros-codebuddy] route removed（未登录；${reason}）`); }
				return lastRoute;
			}
			const models = await fetchModels();
			if (models === null) {
				// 这次取不到目录（网络/网关）：**保留现状**（不撤路由 ⇒ 不会因为一次超时就让模型全消失）
				lastRoute = { ...lastRoute, at: now(), why: `kept（${lastError}）` };
				return lastRoute;
			}
			if (models.length === 0) {
				const r = await writeOwnedRoute(settings, CODEBUDDY_ROUTE, null);
				lastRoute = { written: false, models: 0, at: now(), why: r.changed ? 'removed（目录为空）' : 'absent（目录为空）' };
				return lastRoute;
			}
			const baseURL = await resolveBaseURL(`${cfg.endpoint}/v2`).catch(() => `${cfg.endpoint}/v2`);
			const entry = codebuddyRouteEntry({ baseURL, accessToken: token, models });
			const r = await writeOwnedRoute(settings, CODEBUDDY_ROUTE, buildRouteProfile(entry));
			lastRoute = { written: true, models: models.length, at: now(), why: r.changed ? `written（${r.why.join('+') || reason}）` : 'unchanged' };
			if (r.changed) {
				log(`[vssaros-codebuddy] route written: ${models.length} models（${r.why.join('+') || '?'}；${reason}）`);
			}
			try { await onRouteWritten(entry); } catch (e) { log(`[vssaros-codebuddy] onRouteWritten failed: ${String(e?.message ?? e)}`); }
			return lastRoute;
		});
		routeChain = run.catch(e => {
			lastError = `写模型路由失败：${String(e?.message ?? e)}`;
			log(`[vssaros-codebuddy] syncRoute failed: ${lastError}`);
		});
		return run;
	};

	// ── 登录（扩展 `login()` 同顺序：先复用本机登录态，再走浏览器）──────────────
	const signIn = async () => {
		if (signingIn) { return signingIn; }
		cancelRequested = false;
		signingIn = (async () => {
			lastError = '';
			const local = await readLocalCodeBuddyState(localStorageDir, now());
			if (local.token) {
				await saveSession({ ...local.token, source: 'local_storage' });
				log('[vssaros-codebuddy] 复用本机 CodeBuddy 登录态（~/.codebuddy/local_storage）');
				await syncRoute('signin:local');
				return status();
			}
			// ① 要一个 state + 登录页地址
			const stateRes = await timed(`${cfg.endpoint}/v2/plugin/auth/state?platform=${encodeURIComponent(cfg.authPlatform)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...NO_AUTH_HEADERS },
				body: '{}',
			}, 30_000);
			if (!stateRes.ok) {
				throw new Error(`请求 CodeBuddy 登录状态失败：HTTP ${stateRes.status}`);
			}
			const stateData = (await stateRes.json().catch(() => ({})))?.data ?? {};
			if (!stateData.state || !stateData.authUrl) {
				throw new Error('CodeBuddy 登录状态响应不完整（缺 state / authUrl）');
			}
			let authUrl = String(stateData.authUrl);
			if (local.ioa) {
				authUrl += `${authUrl.includes('?') ? '&' : '?'}ioa=1`;
			}
			// ② 开浏览器
			await openExternal(authUrl);
			log('[vssaros-codebuddy] 已打开浏览器，等待登录完成…');
			// ③ 轮询 token（每秒一次；单次 10s 超时；总时长受 loginTimeoutSeconds 限制）
			const deadline = now() + cfg.loginTimeoutSeconds * 1000;
			signInDeadline = deadline;
			const pollUrl = `${cfg.endpoint}/v2/plugin/auth/token?state=${encodeURIComponent(stateData.state)}`;
			while (now() < deadline) {
				if (cancelRequested) { throw new Error('已取消登录'); }
				try {
					const res = await timed(pollUrl, { method: 'GET', headers: { ...NO_AUTH_HEADERS } }, 10_000);
					if (res.ok) {
						const data = (await res.json().catch(() => ({})))?.data ?? {};
						if (data.accessToken) {
							await saveSession({
								accessToken: data.accessToken,
								refreshToken: data.refreshToken,
								expiresAt: calcExpiry(data.expiresAt, undefined, now()),
								source: 'cli_external_link',
							});
							modelsCache = null;
							log('[vssaros-codebuddy] 登录成功');
							await syncRoute('signin');
							return status();
						}
					}
				} catch { /* 单次轮询失败（超时/网络抖动）⇒ 继续下一次 */ }
				await sleep(1000);
			}
			throw new Error(`登录超时：${cfg.loginTimeoutSeconds} 秒内没有在浏览器里完成登录`);
		})();
		try {
			return await signingIn;
		} catch (e) {
			lastError = String(e?.message ?? e);
			throw e;
		} finally {
			signingIn = null;
			signInDeadline = null;
		}
	};

	const cancelSignIn = () => {
		cancelRequested = true;
		return !!signingIn;
	};

	const signOut = async () => {
		cancelRequested = true;
		await clearSession();
		// 记下"用户主动登出过"：过渡期 IDE 的一次性迁移看到它就不再把扩展里的登录态导回来 ✓
		try { await credentials?.set?.(CODEBUDDY_SIGNED_OUT_REF, '1'); } catch { /* 写不进也不影响登出本身 */ }
		lastError = '';
		await syncRoute('signout');
		log('[vssaros-codebuddy] 已登出');
		return status();
	};

	/**
	 * 从 IDE 扩展迁移登录态（过渡期一次性）：**dsh 侧已有登录态时不覆盖**（除非 force）。
	 * @returns {Promise<{imported:boolean, reason?:string}>}
	 */
	const importSession = async ({ accessToken: token, refreshToken, expiresAt, force = false }) => {
		if (typeof token !== 'string' || token.length < 10) {
			return { imported: false, reason: 'invalid-token' };
		}
		const existing = await readSession();
		if (existing && existing.source !== 'legacy' && !force) {
			return { imported: false, reason: 'already-signed-in' };
		}
		if (!force && await signedOutByUser()) {
			// 用户在 dsh 侧主动登出过 ⇒ 尊重它，不拿 IDE 里的登录态再登回去 ✓
			return { imported: false, reason: 'signed-out-by-user' };
		}
		await saveSession({
			accessToken: token,
			refreshToken: typeof refreshToken === 'string' && refreshToken ? refreshToken : undefined,
			expiresAt: calcExpiry(expiresAt, undefined, now()),
			source: 'ide-import',
		});
		modelsCache = null;
		log('[vssaros-codebuddy] 已从 IDE 扩展导入登录态');
		await syncRoute('import');
		return { imported: true };
	};

	/** 对外状态（**不含 token**）。 */
	const status = async () => {
		const session = await readSession();
		const who = session ? identityOf(session.accessToken) : { userId: '', tenantId: '', name: '' };
		return {
			provider: 'codebuddy',
			route: CODEBUDDY_ROUTE,
			endpoint: cfg.endpoint,
			signedIn: !!session,
			signingIn: !!signingIn,
			...(signingIn && signInDeadline ? { signInDeadline } : {}),
			...(session ? {
				source: session.source,
				userId: who.userId,
				tenantId: who.tenantId,
				...(who.name ? { name: who.name } : {}),
				expiresAt: Number.isFinite(session.expiresAt) ? session.expiresAt : null,
				canRefresh: !!session.refreshToken,
			} : {}),
			models: modelsCache ? modelsCache.models.length : null,
			modelIds: modelsCache ? modelsCache.models.slice(0, 200).map(m => m.id) : [],
			// 展示名（与 modelIds 一一对应；平台没给名字就用 id）—— 设置页「查看模型」用
			modelNames: modelsCache ? modelsCache.models.slice(0, 200).map(m => m.name || m.id) : [],
			modelsFetchedAt: modelsCache ? modelsCache.fetchedAt : null,
			routeWritten: lastRoute.written,
			routeNote: lastRoute.why,
			...(lastError ? { error: lastError } : {}),
		};
	};

	// ── 后台维护：token 快过期就刷新、目录过期就重取（变化才写路由）──────────────
	let timer;
	const tick = async () => {
		const session = await readSession();
		if (!session) { return; }
		if (session.refreshToken && needsRefresh(session, now())) {
			await refresh(session);
		}
		if (!modelsCache || now() - modelsCache.fetchedAt >= CODEBUDDY_DEFAULTS.modelsTtlMs) {
			await syncRoute('tick');
		}
	};
	const start = ({ initialDelayMs = 2_000, intervalMs = 60_000 } = {}) => {
		const first = setTimeout(() => { void syncRoute('start'); }, initialDelayMs);
		first.unref?.();
		timer = setInterval(() => { void tick().catch(() => undefined); }, intervalMs);
		timer.unref?.();
		return () => { clearTimeout(first); clearInterval(timer); };
	};

	return {
		config: cfg,
		refs: { access: CODEBUDDY_CREDENTIAL_REF, session: CODEBUDDY_SESSION_REF, signedOut: CODEBUDDY_SIGNED_OUT_REF },
		setBaseURLResolver: fn => { resolveBaseURL = typeof fn === 'function' ? fn : (async real => real); },
		status,
		signIn,
		cancelSignIn,
		signOut,
		importSession,
		refreshModels: async () => { modelsCache = null; return syncRoute('refresh'); },
		syncRoute,
		start,
		/** 守卫用：直接驱动一次后台维护。 */
		tick,
	};
}
