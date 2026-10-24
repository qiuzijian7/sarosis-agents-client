// LightAI（腾讯光子 lightflood：图片 / 视频 / 3D / 音频生成）的 **dsh 侧实现**（2026-10-22）。
//
// 用户原话："lightai provider 插件改成 dsh 侧实现，在 dsh 窗口版的设置页面中的模型中展示和配置"；
// 登录方式用户选 ①："用本仓的浏览器插件打开登录页、登录后自动读取 Cookie"。
//
// ── 与 IDE 扩展（extensions/lightai-provider）逐项对应 ──────────────────────────────────
//   · 登录：扩展用 Playwright 开浏览器 → 每秒读 cookie → `sessionid` + `uid` 同时出现 ⇒ `/api/user/check` 校验。
//     这里改由 **浏览器插件**（`ctx.vssarosBrowser.loginSession`，CDP）开登录页、读 cookie —— 判据一字不改。
//     扩展的"先无头复用 profile 里的旧会话"⇒ 这里是"先读浏览器里现有的 cookie，校验通过就不开页面"✓。
//     扩展的"有头登录前清 cookie（防 50008 旧票被立刻读回）"⇒ 这里**不清**（清的是整个浏览器、可能是用户自己的
//     Chrome ✗），改为"记下被拒的那一份，等值变了再校验"——同一个问题，零副作用 ✓。
//   · 请求头 / 接口 / 默认参数：逐字照抄 `browserLogin.ts` / `floodGen.ts` / `modelDiscovery.ts`。
//   · 模型清单：没有 API ⇒ 抓前端 bundle 正则提取（同扩展）；解析失败回落默认清单。
//
// ── 落点（凭据存储 = dsh `.credentials.yaml`）─────────────────────────────────────────────
//   `VSSAROS_LIGHTAI_COOKIE`（"sessionid=…; uid=…"，凭据）/ `_SESSION`（JSON：userId、模型清单、来源…，**无 cookie 值**）/
//   `_CONFIG`（JSON：用户改过的服务地址 / 计费字段）/ `_SIGNED_OUT`（用户主动登出过 ⇒ 挡住 IDE 一次性迁移）。
//   ⚠ 对外投影（status / HTTP / 桥回执）**绝不含** cookie 值（`sessionid` / `uid` 都是 cookie 值）✓。
//
// ── 生成链路（2026-10-22 二期）──────────────────────────────────────────────────────────
//   建任务 → 轮询 → 取产物在 `lightaiGen.js`（逐字照 `floodGen.ts`）；本服务给它**内部**凭证上下文，
//   对外（其他 Host 插件）只经 `ctx.vssarosLightAI` 的生成方法用 —— cookie 从不离开本插件 ✓。

import { FLOOD_MODELS, RATIOS, createFloodClient } from './lightaiGen.js';

export const LIGHTAI_COOKIE_REF = 'VSSAROS_LIGHTAI_COOKIE';
export const LIGHTAI_SESSION_REF = 'VSSAROS_LIGHTAI_SESSION';
export const LIGHTAI_CONFIG_REF = 'VSSAROS_LIGHTAI_CONFIG';
export const LIGHTAI_SIGNED_OUT_REF = 'VSSAROS_LIGHTAI_SIGNED_OUT';

/**
 * 聊天框「创作模型」里按类别选定的默认（JSON `{ image: 'picture_banana_2', video: … }`，2026-10-22）。
 * 放凭据存储：不新增落盘文件（新文件要登记 persistence 目录），也不触发 settings 重组 ✓。
 */
export const MEDIA_DEFAULTS_REF = 'VSSAROS_MEDIA_DEFAULTS';

/** 浏览器插件里登记的登录站点名（`vssaros-browser/lib/core/loginSession.js` 的 LOGIN_PROFILES）。 */
export const LIGHTAI_LOGIN_PROFILE = 'lightai';

/** 默认值：**必须与 IDE 扩展 `package.json` 的 `lightai.*` 默认值一致**（同一个服务、同一套计费字段）。 */
export const LIGHTAI_DEFAULTS = Object.freeze({
	floodApiBase: 'https://lightai-lightflood-v1-sd.aigclsp.com',
	apiBase: 'https://aigclsp.com',
	k: 'YXBwX2lkPTEzNyZhcHBfbmFtZT3mmbrog73lr7nor50mcHJvZHVjdF9pZD03MyZwcm9kdWN0X25hbWU96JCo572X5pavR1Lpobnnm64=&lang=zh_CN',
	userType: '内部用户',
	company: '腾讯-二方公司',
	appId: '137',
	appName: '智能对话',
	bizId: '73',
	projectName: '萨罗斯GR项目',
	loginTimeoutSeconds: 300,
	timeoutMs: 120_000,
});

/** 智能编排 app_id（= 169），与聊天的 137 不同（`floodGen.ts` 的 FLOOD_APP_ID）。 */
const FLOOD_APP_ID = '169';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36';

/**
 * 默认清单（扩展 settings 的默认值）+ 展示名。`routable` = 生成路由表 `FLOOD_MODELS` 认识它
 * （发现到但路由表没有的模型 ⇒ 不知道它的 task_params 形状 ⇒ 生成时如实报"还没接入"）。
 */
export const KNOWN_MODELS = Object.freeze({
	picture_banana_2: 'Banana 2',
	picture_gpt_image_2: 'GPT Image 2',
	picture_seedream_50: 'Seedream 5.0',
	picture_midjourney_8_2: 'Midjourney 8.2',
	video_minimax_h3: 'MiniMax H3',
	video_hunyuan: '混元视频',
	model_hunyuan_3_5: '混元 3D 3.5',
	audio_speech_28: 'Speech 2.8',
	seed_audio_1: 'Seed Audio 1',
});
const DEFAULT_LISTS = Object.freeze({
	image: ['picture_banana_2', 'picture_gpt_image_2', 'picture_seedream_50', 'picture_midjourney_8_2'],
	video: ['video_minimax_h3', 'video_hunyuan'],
	model3d: ['model_hunyuan_3_5'],
	audio: ['audio_speech_28', 'seed_audio_1'],
});
const KINDS = ['image', 'video', 'model3d', 'audio'];

/** 状态校验（`/api/user/check`）的结果缓存时长：设置页每次打开都查一次网络太频繁。 */
const VALIDATE_TTL_MS = 10 * 60_000;
/** 状态校验的超时（比扩展的 120s 短：它挡在设置页加载路径上）。 */
const VALIDATE_TIMEOUT_MS = 15_000;
const POLL_MS = 1000;

const trimBase = s => String(s ?? '').trim().replace(/\/+$/, '');

/**
 * 解析 k 参数（base64 的 `app_id=137&app_name=…&product_id=73&product_name=…`）——同 `browserLogin.ts`。
 * `product_id` ⇒ bizId，`product_name` ⇒ projectName。
 */
export function parseKParams(k) {
	const b64 = String(k || '').split('&')[0].trim();
	if (!b64) { return {}; }
	let raw = '';
	try {
		raw = Buffer.from(b64.replace(/%3D/gi, '='), 'base64').toString('utf-8');
	} catch {
		return {};
	}
	const params = new URLSearchParams(raw);
	const pick = name => params.get(name) ?? undefined;
	return { appId: pick('app_id'), appName: pick('app_name'), bizId: pick('product_id'), projectName: pick('product_name') };
}

/** cookie 列表 ⇒ "sessionid=…; uid=…"（两个都有才算）。 */
export function cookieHeaderFrom(cookies) {
	const pick = name => (Array.isArray(cookies) ? cookies : []).find(c => c && c.name === name && c.value);
	const sid = pick('sessionid');
	const uid = pick('uid');
	return sid && uid ? `sessionid=${sid.value}; uid=${uid.value}` : undefined;
}

/** 校验失败的分类：`rejected` = 会话无效（要重新登录）；否则是网络 / 服务端临时问题。 */
class CheckError extends Error {
	constructor(message, { rejected = false, restricted = false } = {}) {
		super(message);
		this.rejected = rejected;
		this.restricted = restricted;
	}
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} catch (e) {
		if (controller.signal.aborted) { throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`); }
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * `POST <apiBase>/api/user/check` —— 校验 cookie 并取 userId（企微邮箱）。同 `resolveUserId`。
 * @throws {CheckError} rejected=true ⇒ 会话无效（code≠0 / 401 / 403）；restricted=true ⇒ 不在办公网
 */
export async function checkUser({ cookie, apiBase, floodApiBase, fetchImpl = fetch, timeoutMs = LIGHTAI_DEFAULTS.timeoutMs }) {
	const origin = trimBase(floodApiBase);
	let resp;
	try {
		resp = await fetchWithTimeout(fetchImpl, `${trimBase(apiBase)}/api/user/check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: '*/*', origin, referer: `${origin}/`, cookie },
			body: JSON.stringify({ perm: '*' }),
		}, timeoutMs);
	} catch (e) {
		throw new CheckError(`连接 LightAI 失败：${String(e?.message ?? e)}`);
	}
	const text = await resp.text().catch(() => '');
	if (/没有访问权限/.test(text)) {
		// 服务只接受腾讯办公网来源 IP（tools/lightai/README.md）—— 不是会话问题，别让用户白白重登 ✗
		throw new CheckError('LightAI 拒绝了当前网络（只接受腾讯办公网来源）', { restricted: true });
	}
	if (resp.status === 401 || resp.status === 403) {
		throw new CheckError(`LightAI 会话已失效（HTTP ${resp.status}）`, { rejected: true });
	}
	if (!resp.ok) {
		throw new CheckError(`LightAI 校验失败：HTTP ${resp.status}`);
	}
	let json;
	try { json = JSON.parse(text); } catch { throw new CheckError('LightAI 校验接口返回的不是 JSON'); }
	if (json?.code !== 0 || !json?.result?.username) {
		// 50008 等 = 会话过期 / 无效（扩展注释）⇒ rejected
		throw new CheckError(`LightAI 会话无效（code ${json?.code ?? '?'}${json?.message ? `：${String(json.message).slice(0, 80)}` : ''}）`, { rejected: true });
	}
	return { userId: String(json.result.username) };
}

function floodBaseHeaders({ floodApiBase, bizId, userId, cookie }) {
	const base = trimBase(floodApiBase);
	return {
		accept: '*/*',
		'user-agent': UA,
		origin: base,
		referer: `${base}/flow`,
		app_id: FLOOD_APP_ID,
		biz_id: String(bizId),
		version: '1.0',
		'user-data': Buffer.from(`${userId}-lightai`).toString('base64'),
		cookie,
	};
}

/** `GET /api/light_flood/canvas/get_voucher` ⇒ lf_canvas_auth JWT（"测试连接"= 能拿到它）。同 `getVoucher`。 */
export async function getVoucher({ floodApiBase, bizId, userId, cookie, fetchImpl = fetch, timeoutMs = 30_000 }) {
	const res = await fetchWithTimeout(fetchImpl, `${trimBase(floodApiBase)}/api/light_flood/canvas/get_voucher`, {
		headers: floodBaseHeaders({ floodApiBase, bizId, userId, cookie }),
	}, timeoutMs);
	if (!res.ok) { throw new Error(`获取 LightAI 编排凭证失败：HTTP ${res.status}`); }
	const j = await res.json().catch(() => null);
	if (!j || j.code !== 200 || !j.data) { throw new Error('获取 LightAI 编排凭证失败：响应缺少 data'); }
	return j.data;
}

/**
 * 模型发现：首页 HTML → 入口 JS → 最多 3 层展开 chunk（≤80 个）→ 正则提取 `value:"picture_…"` 与就近 `name:"…"`。
 * 逐字照 `modelDiscovery.ts`。解析不到 ⇒ undefined（调用方回落默认）。
 */
export async function discoverModels({ floodApiBase, cookie, fetchImpl = fetch, timeoutMs = LIGHTAI_DEFAULTS.timeoutMs }) {
	const base = trimBase(floodApiBase);
	const headers = { accept: '*/*', 'user-agent': UA, origin: base, referer: `${base}/flow`, cookie };
	const deadline = Date.now() + timeoutMs;
	const left = () => Math.max(1000, deadline - Date.now());
	const htmlResp = await fetchWithTimeout(fetchImpl, `${base}/`, { headers: { ...headers, accept: 'text/html' } }, left());
	if (!htmlResp.ok) { throw new Error(`首页拉取失败：HTTP ${htmlResp.status}`); }
	const html = await htmlResp.text();
	const entryUrls = [...new Set([...html.matchAll(/src="(\/[^"]+\.js)"/g)].map(m => m[1]))];
	if (entryUrls.length === 0) { return undefined; }
	const CHUNK_RE = /"((?:\.\/)?assets\/[A-Za-z0-9_-]+\.js)"/g;
	const fetched = new Map();
	let frontier = [...entryUrls];
	for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
		const next = [];
		for (const u of frontier) {
			if (fetched.has(u) || fetched.size > 80) { continue; }
			try {
				const r = await fetchWithTimeout(fetchImpl, `${base}${u}`, { headers }, left());
				if (!r.ok) { continue; }
				const js = await r.text();
				fetched.set(u, js);
				for (const c of js.matchAll(CHUNK_RE)) {
					const raw = c[1].replace(/^\.\//, '');
					const p = raw.startsWith('/') ? raw : `/${raw}`;
					if (!fetched.has(p) && !next.includes(p)) { next.push(p); }
				}
			} catch {
				continue;
			}
		}
		frontier = next;
	}
	const MODEL_RE = /value:\s*"((?:picture|video|model|audio)_[A-Za-z0-9_]+)"/g;
	const NAME_RE = /name:\s*"([^"]{1,60})"/g;
	const order = [];
	const names = {};
	const seen = new Set();
	for (const js of fetched.values()) {
		MODEL_RE.lastIndex = 0;
		let m;
		while ((m = MODEL_RE.exec(js))) {
			const id = m[1];
			if (seen.has(id)) { continue; }
			seen.add(id);
			order.push(id);
			const lookback = js.slice(Math.max(0, m.index - 800), m.index);
			NAME_RE.lastIndex = 0;
			let nm;
			let last = '';
			while ((nm = NAME_RE.exec(lookback))) { last = nm[1]; }
			if (last) { names[id] = last; }
		}
	}
	const lists = {
		image: order.filter(id => id.startsWith('picture_')),
		video: order.filter(id => id.startsWith('video_')),
		model3d: order.filter(id => id.startsWith('model_')),
		audio: order.filter(id => id.startsWith('audio_')),
	};
	if (KINDS.every(k => lists[k].length === 0)) { return undefined; }
	return { ...lists, names };
}

/**
 * 发现结果 ⇒ 展示清单。发现到的在前；路由表认识、但这次没发现到的默认模型补在后面
 * （`seed_audio_1` 不符合 `audio_` 前缀、永远发现不到 —— 扩展里它会被覆盖丢掉 ✗，这里保住）✓。
 */
export function buildModelLists(discovered) {
	const out = {};
	for (const kind of KINDS) {
		const ids = [...(discovered?.[kind] ?? [])];
		for (const id of DEFAULT_LISTS[kind]) { if (!ids.includes(id)) { ids.push(id); } }
		out[kind] = ids.map(id => {
			const route = FLOOD_MODELS[id];
			return {
				id,
				name: discovered?.names?.[id] || KNOWN_MODELS[id] || id,
				routable: !!route,
				// 灯火价（路由表里的 lightPoints；没接入的模型没有价 ⇒ 界面上不显示）
				...(route && Number.isFinite(route.lightPoints) ? { price: route.lightPoints, unit: '灯火' } : {}),
			};
		});
	}
	return out;
}

/** 用户可改的配置字段（自定义设置）。其余（app / 项目）来自 k 参数。 */
function sanitizeConfigPatch(patch) {
	const out = {};
	if (!patch || typeof patch !== 'object') { return out; }
	if (patch.floodApiBase !== undefined) {
		const v = trimBase(patch.floodApiBase);
		let u;
		try { u = new URL(v); } catch { throw new Error('服务地址不是合法 URL'); }
		if (u.protocol !== 'https:') { throw new Error('服务地址必须是 https'); }
		if (!/(^|\.)aigclsp\.com$/i.test(u.hostname)) { throw new Error('服务地址必须在 aigclsp.com 之下（登录页与会话 cookie 都在这个域）'); }
		out.floodApiBase = `${u.protocol}//${u.host}`;
	}
	for (const key of ['userType', 'company']) {
		if (patch[key] !== undefined) {
			const v = String(patch[key]).trim();
			if (!v || v.length > 64 || /[\r\n\u0000]/.test(v)) { throw new Error(`${key} 必须是 1–64 个字符`); }
			out[key] = v;
		}
	}
	return out;
}

/**
 * @param {object} deps
 * @param {object} deps.credentials dsh 凭据服务
 * @param {() => any} deps.browser 取浏览器插件服务（`ctx.vssarosBrowser`；缺席 ⇒ undefined）
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {(why: string) => void} [deps.onChange]
 * @param {(line: string) => void} [deps.log]
 * @param {object} [deps.config] 插件配置覆盖（loginTimeoutSeconds 等）
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.genSleep] 生成轮询的 sleep（守卫注入）
 * @param {number} [deps.genPollMs] 生成轮询间隔（守卫注入；默认 5s 同扩展）
 */
export function createLightAIService({ credentials, browser = () => undefined, fetchImpl = fetch, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), onChange = () => { }, log = () => { }, config = {}, genSleep, genPollMs }) {
	const loginTimeoutSeconds = (() => {
		const n = Number(config.loginTimeoutSeconds);
		return Number.isFinite(n) && n >= 30 ? Math.min(900, Math.floor(n)) : LIGHTAI_DEFAULTS.loginTimeoutSeconds;
	})();

	const readRef = async ref => {
		if (!credentials || typeof credentials.resolve !== 'function') { return undefined; }
		try {
			const r = await credentials.resolve(ref);
			return typeof r?.value === 'string' && r.value ? r.value : undefined;
		} catch {
			return undefined;
		}
	};
	const readJson = async ref => {
		const raw = await readRef(ref);
		if (!raw) { return undefined; }
		try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : undefined; } catch { return undefined; }
	};
	const writeRef = async (ref, value) => {
		if (!credentials || typeof credentials.set !== 'function') { throw new Error('凭据服务不可用 —— 无法保存 LightAI 登录态'); }
		await credentials.set(ref, value);
	};
	const dropRef = async ref => {
		try { await credentials?.unset?.(ref); } catch { /* 缺席即可 */ }
	};

	const effectiveConfig = async () => {
		const saved = (await readJson(LIGHTAI_CONFIG_REF)) ?? {};
		const k = parseKParams(LIGHTAI_DEFAULTS.k);
		return {
			floodApiBase: saved.floodApiBase || LIGHTAI_DEFAULTS.floodApiBase,
			apiBase: LIGHTAI_DEFAULTS.apiBase,
			userType: saved.userType || LIGHTAI_DEFAULTS.userType,
			company: saved.company || LIGHTAI_DEFAULTS.company,
			appId: k.appId || LIGHTAI_DEFAULTS.appId,
			appName: k.appName || LIGHTAI_DEFAULTS.appName,
			bizId: k.bizId || LIGHTAI_DEFAULTS.bizId,
			projectName: k.projectName || LIGHTAI_DEFAULTS.projectName,
		};
	};
	const entryUrl = cfg => `${trimBase(cfg.floodApiBase)}/flow?lang=zh_CN`;

	let changeSeq = 0;
	const fireChange = why => {
		changeSeq++;
		try { onChange(why); } catch { /* 通知失败不影响主流程 */ }
	};

	// ── 会话校验（带缓存）────────────────────────────────────────────────────
	/** { at, cookie, ok, rejected, restricted, error } —— 绑定到"校验的是哪一份 cookie"，换了 cookie 自动作废 ✓。 */
	let validation = null;
	let validating = null;
	const validate = async (cookie, { force = false } = {}) => {
		if (!force && validation && validation.cookie === cookie && now() - validation.at < VALIDATE_TTL_MS) { return validation; }
		if (validating) { return validating; }
		validating = (async () => {
			const cfg = await effectiveConfig();
			try {
				const { userId } = await checkUser({ cookie, apiBase: cfg.apiBase, floodApiBase: cfg.floodApiBase, fetchImpl, timeoutMs: VALIDATE_TIMEOUT_MS });
				validation = { at: now(), cookie, ok: true, userId };
			} catch (e) {
				validation = { at: now(), cookie, ok: false, rejected: !!e?.rejected, restricted: !!e?.restricted, error: String(e?.message ?? e) };
			}
			return validation;
		})();
		try { return await validating; } finally { validating = null; }
	};

	// ── 登录 ────────────────────────────────────────────────────────────────
	let signingIn = null;
	let signInDeadline = null;
	let cancelRequested = false;
	let lastError = '';

	const finish = async (cookie, userId, source) => {
		await writeRef(LIGHTAI_COOKIE_REF, cookie);
		const prev = (await readJson(LIGHTAI_SESSION_REF)) ?? {};
		await writeRef(LIGHTAI_SESSION_REF, JSON.stringify({
			userId,
			source,
			signedInAt: now(),
			...(prev.models ? { models: prev.models, modelsFetchedAt: prev.modelsFetchedAt, modelsSource: prev.modelsSource } : {}),
		}));
		await dropRef(LIGHTAI_SIGNED_OUT_REF);
		validation = { at: now(), cookie, ok: true, userId };
		lastError = '';
		log(`[vssaros-lightai] 已登录：${userId}（${source}）`);
		fireChange('signin');
		// 模型清单在后台刷（抓 bundle 可能要十几秒，不挡登录完成）
		void refreshModels().catch(() => undefined);
	};

	const signIn = async () => {
		if (signingIn) { return signingIn; }
		cancelRequested = false;
		lastError = '';
		const run = (async () => {
			const loginSession = browser()?.loginSession;
			if (!loginSession || typeof loginSession.open !== 'function' || typeof loginSession.cookies !== 'function') {
				throw new Error('LightAI 登录需要浏览器插件（@vssaros/dsh-browser ≥ 0.4.8）—— 请在「内置插件」里启用它');
			}
			const cfg = await effectiveConfig();
			const url = entryUrl(cfg);
			signInDeadline = now() + loginTimeoutSeconds * 1000;
			fireChange('signin-started');
			const read = async () => cookieHeaderFrom(await loginSession.cookies(LIGHTAI_LOGIN_PROFILE, url));
			// ① 浏览器里已经有有效会话（以前登过）⇒ 不开页面，直接用 ✓
			let rejectedCookie;
			const existing = await read();
			if (existing) {
				const v = await validate(existing, { force: true });
				if (v.ok) { await finish(existing, v.userId, 'browser-profile'); return; }
				if (!v.rejected) { throw new Error(v.error); }   // 网络 / 办公网限制 ⇒ 开页面也没用，如实说
				rejectedCookie = existing;                       // 旧会话被拒 ⇒ 等它被新登录替换
			}
			// ② 开登录页，等用户在浏览器里登录（轮询 cookie；值变了才校验 ⇒ 不会被旧票卡住）
			await loginSession.open(LIGHTAI_LOGIN_PROFILE, url);
			try {
				while (now() < signInDeadline) {
					if (cancelRequested) { throw new Error('已取消登录'); }
					const c = await read().catch(() => undefined);
					if (c && c !== rejectedCookie) {
						const v = await validate(c, { force: true });
						if (v.ok) { await finish(c, v.userId, 'browser'); return; }
						if (v.rejected) { rejectedCookie = c; } else { throw new Error(v.error); }
					}
					await sleep(POLL_MS);
				}
				throw new Error(`登录超时（${loginTimeoutSeconds}s），没有在浏览器里检测到 LightAI 会话`);
			} finally {
				try { await loginSession.close(LIGHTAI_LOGIN_PROFILE); } catch { /* 用户已经关了 */ }
			}
		})();
		signingIn = run;
		try {
			await run;
		} catch (e) {
			lastError = String(e?.message ?? e);
			throw e;
		} finally {
			signingIn = null;
			signInDeadline = null;
			fireChange('signin-ended');
		}
	};

	const cancelSignIn = () => {
		if (!signingIn) { return false; }
		cancelRequested = true;
		return true;
	};

	const signOut = async ({ byUser = false } = {}) => {
		cancelSignIn();
		await dropRef(LIGHTAI_COOKIE_REF);
		const prev = (await readJson(LIGHTAI_SESSION_REF)) ?? {};
		await dropRef(LIGHTAI_SESSION_REF);
		// 模型清单不随登出丢（下次登录前也能看见有哪些模型）——单独留一份不含身份的
		if (prev.models) {
			await writeRef(LIGHTAI_SESSION_REF, JSON.stringify({ models: prev.models, modelsFetchedAt: prev.modelsFetchedAt, modelsSource: prev.modelsSource }));
		}
		if (byUser) { await writeRef(LIGHTAI_SIGNED_OUT_REF, '1'); }
		validation = null;
		lastError = '';
		fireChange('signout');
		return status();
	};

	// ── 模型 / 测试 / 配置 ──────────────────────────────────────────────────
	let refreshing = null;
	let modelsError = '';
	const refreshModels = async () => {
		if (refreshing) { return refreshing; }
		refreshing = (async () => {
			const cookie = await readRef(LIGHTAI_COOKIE_REF);
			if (!cookie) { throw new Error('还没登录 LightAI'); }
			const cfg = await effectiveConfig();
			let discovered;
			try {
				discovered = await discoverModels({ floodApiBase: cfg.floodApiBase, cookie, fetchImpl });
				modelsError = discovered ? '' : '没能从 LightAI 前端解析出模型（可能改版了）—— 先用默认清单';
			} catch (e) {
				modelsError = `获取模型失败：${String(e?.message ?? e)}`;
			}
			const session = (await readJson(LIGHTAI_SESSION_REF)) ?? {};
			if (discovered || !session.models) {
				await writeRef(LIGHTAI_SESSION_REF, JSON.stringify({
					...session,
					models: buildModelLists(discovered),
					modelsFetchedAt: now(),
					modelsSource: discovered ? 'discovered' : 'default',
				}));
			}
			fireChange('models');
		})();
		try { await refreshing; } finally { refreshing = null; }
		return status();
	};

	let lastTest = null;
	const test = async () => {
		const cookie = await readRef(LIGHTAI_COOKIE_REF);
		const session = (await readJson(LIGHTAI_SESSION_REF)) ?? {};
		if (!cookie || !session.userId) { throw new Error('还没登录 LightAI'); }
		const cfg = await effectiveConfig();
		try {
			await getVoucher({ floodApiBase: cfg.floodApiBase, bizId: cfg.bizId, userId: session.userId, cookie, fetchImpl });
			lastTest = { ok: true, at: now(), message: '连接正常（编排凭证已获取）' };
		} catch (e) {
			lastTest = { ok: false, at: now(), message: `${String(e?.message ?? e)}（会话可能已过期）` };
		}
		fireChange('test');
		return status();
	};

	const setConfig = async patch => {
		const clean = sanitizeConfigPatch(patch);
		const saved = (await readJson(LIGHTAI_CONFIG_REF)) ?? {};
		await writeRef(LIGHTAI_CONFIG_REF, JSON.stringify({ ...saved, ...clean }));
		if (clean.floodApiBase && clean.floodApiBase !== saved.floodApiBase) { validation = null; }
		fireChange('config');
		return status();
	};

	/**
	 * 一次性迁移（过渡期）：IDE 扩展 settings 里的 `lightai.cookie` / `lightai.userId` ⇒ dsh 侧。
	 * dsh 侧已有 cookie / 用户在 dsh 侧主动登出过 ⇒ 不导 ✓。导入后照常按 TTL 校验（失效就显示失效）。
	 */
	const importSession = async ({ cookie, userId } = {}) => {
		if (typeof cookie !== 'string' || !/(^|;\s*)sessionid=[^;]+/.test(cookie) || !/(^|;\s*)uid=[^;]+/.test(cookie) || cookie.length > 4096 || /[\r\n\u0000]/.test(cookie)) {
			return { imported: false, reason: 'invalid' };
		}
		if (typeof userId !== 'string' || !userId.trim() || userId.length > 256) {
			return { imported: false, reason: 'invalid' };
		}
		if (await readRef(LIGHTAI_COOKIE_REF)) { return { imported: false, reason: 'already-signed-in' }; }
		if ((await readRef(LIGHTAI_SIGNED_OUT_REF)) === '1') { return { imported: false, reason: 'signed-out-by-user' }; }
		await writeRef(LIGHTAI_COOKIE_REF, cookie);
		const prev = (await readJson(LIGHTAI_SESSION_REF)) ?? {};
		await writeRef(LIGHTAI_SESSION_REF, JSON.stringify({ ...prev, userId: userId.trim(), source: 'ide-import', signedInAt: now() }));
		validation = null;
		log(`[vssaros-lightai] 已从 IDE 扩展迁入登录态：${userId.trim()}`);
		fireChange('import');
		if (!prev.models) { void refreshModels().catch(() => undefined); }
		return { imported: true };
	};

	// ── 状态投影（**无 cookie 值**）────────────────────────────────────────────
	const status = async () => {
		const cfg = await effectiveConfig();
		const cookie = await readRef(LIGHTAI_COOKIE_REF);
		const session = (await readJson(LIGHTAI_SESSION_REF)) ?? {};
		const signedOutByUser = (await readRef(LIGHTAI_SIGNED_OUT_REF)) === '1';
		const br = browser();
		let signedIn = false;
		let expired = false;
		let stale = false;
		let error = '';
		// 登录进行中不校验（cookie 随时会被新登录替换；界面此时显示"登录中"）
		if (cookie && !signingIn) {
			const v = await validate(cookie);
			if (v.ok) { signedIn = true; }
			else if (v.rejected) { expired = true; error = 'LightAI 登录已失效，请重新登录'; }
			else { signedIn = true; stale = true; error = v.error; }   // 网络 / 办公网限制：会话本身可能还好
		}
		if (!error && lastError && !signedIn) { error = lastError; }
		return {
			signedIn,
			signingIn: !!signingIn,
			...(signingIn && signInDeadline ? { signInDeadline } : {}),
			...(expired ? { expired: true } : {}),
			...(stale ? { stale: true } : {}),
			...(error ? { error } : {}),
			signedOutByUser,
			hasCredential: !!cookie,
			...(signedIn && session.userId ? { userId: String(session.userId) } : {}),
			...(session.source ? { via: String(session.source) } : {}),
			...(session.signedInAt ? { signedInAt: session.signedInAt } : {}),
			appId: cfg.appId,
			appName: cfg.appName,
			bizId: cfg.bizId,
			projectName: cfg.projectName,
			userType: cfg.userType,
			company: cfg.company,
			floodApiBase: cfg.floodApiBase,
			models: session.models ?? buildModelLists(undefined),
			modelsSource: session.models ? (session.modelsSource ?? 'discovered') : 'default',
			...(session.modelsFetchedAt ? { modelsFetchedAt: session.modelsFetchedAt } : {}),
			...(modelsError ? { modelsError } : {}),
			refreshing: !!refreshing,
			...(lastTest ? { lastTest } : {}),
			browserAvailable: !!br?.loginSession,
			...(br?.loginSession?.headless ? { browserHeadless: true } : {}),
			rev: changeSeq,
		};
	};

	// ── 生成（二期）────────────────────────────────────────────────────────────
	/** 生成用的凭证上下文（**只给本模块的生成客户端**；不进任何回执）。没登录 / 已失效 ⇒ 抛人话。 */
	const generationContext = async () => {
		const cookie = await readRef(LIGHTAI_COOKIE_REF);
		const session = (await readJson(LIGHTAI_SESSION_REF)) ?? {};
		if (!cookie || !session.userId) {
			throw new Error('LightAI 还没登录 —— 在 设置 → 模型 → LightAI 点「登录」');
		}
		if (validation && validation.cookie === cookie && validation.rejected) {
			throw new Error('LightAI 登录已失效 —— 在 设置 → 模型 → LightAI 重新登录');
		}
		return { cookie, userId: String(session.userId), cfg: await effectiveConfig() };
	};
	const flood = createFloodClient({
		context: generationContext,
		// 取凭证失败 ⇒ 会话多半失效 ⇒ 作废校验缓存（下次 status 重查，设置页如实显示"失效"）✓
		onAuthFailure: () => { validation = null; fireChange('auth-failure'); },
		fetchImpl,
		now,
		...(genPollMs ? { pollMs: genPollMs } : {}),
		...(genSleep ? { sleep: genSleep } : {}),
		log,
	});

	/**
	 * 用户在聊天框「创作模型」里选的默认（2026-10-22，方案 A + S2）。存在凭据存储里
	 * （`VSSAROS_MEDIA_DEFAULTS`，JSON `{ image: 'picture_banana_2', video: … }`）——
	 * 与 LightAI 配置同一处：不落新文件（新落盘文件要登记 persistence 目录），也不触发 settings 重组。
	 */
	const readDefaults = async () => (await readJson(MEDIA_DEFAULTS_REF)) ?? {};
	/** 该类的默认模型 id：优先用户选的（且路由表还认识），否则第一个能生成的。 */
	const defaultOf = async (kind, lists) => {
		const picked = String((await readDefaults())[kind] ?? '').trim();
		if (picked && FLOOD_MODELS[picked] && FLOOD_MODELS[picked].kind === kind) { return picked; }
		return (lists[kind] ?? []).find(m => m.routable)?.id ?? '';
	};

	/** 某类里路由表认识的模型（按设置页显示的顺序）+ 默认模型。 */
	const modelsOf = async kind => {
		const session = (await readJson(LIGHTAI_SESSION_REF)) ?? {};
		const lists = session.models ?? buildModelLists(undefined);
		const models = (lists[kind] ?? []).filter(m => m.routable)
			.map(m => ({ id: m.id, name: m.name, ...(Number.isFinite(m.price) ? { price: m.price, unit: m.unit } : {}) }));
		return { models, defaultModel: await defaultOf(kind, lists) };
	};

	/**
	 * 生成一次（kind = image / video / model3d / audio）。没给 modelId ⇒ 用户选的默认 → 第一个能生成的。
	 * @returns {Promise<object>} image: `{ modelId, images: [{url}] }`；其余同扩展的回执形状
	 */
	const generate = async (kind, params = {}, opts = {}) => {
		let modelId = String(params.modelId ?? '').trim();
		if (!modelId) {
			const session = (await readJson(LIGHTAI_SESSION_REF)) ?? {};
			modelId = await defaultOf(kind, session.models ?? buildModelLists(undefined));
			if (!modelId) { throw new Error(`LightAI 没有可用的${{ image: '图片', video: '视频', model3d: '3D', audio: '音频' }[kind] ?? kind}模型`); }
		}
		return flood.generate(kind, { ...params, modelId }, opts);
	};

	/**
	 * **创作模型目录**（给聊天框的下拉框用，2026-10-22）：按 provider 分组、每类给全部模型
	 * （含路由表还不认识的 —— 界面要置灰并说明原因）+ 当前各类默认 + 该 provider 的状态。
	 * ⚠ 只含 dsh 侧能生成的 provider（用户已定：不经 IDE）✓
	 */
	const catalog = async () => {
		const st = await status();
		const session = (await readJson(LIGHTAI_SESSION_REF)) ?? {};
		const lists = session.models ?? buildModelLists(undefined);
		const picks = await readDefaults();
		const defaults = {};
		for (const kind of KINDS) { defaults[kind] = { provider: 'lightai', model: await defaultOf(kind, lists) }; }
		return {
			providers: [{
				id: 'lightai',
				name: 'LightAI',
				route: 'dsh 直连',
				unit: '灯火',
				status: {
					signedIn: st.signedIn === true,
					signingIn: st.signingIn === true,
					expired: st.expired === true,
					hasCredential: st.hasCredential === true,
					signedOutByUser: st.signedOutByUser === true,
					...(st.error ? { error: String(st.error) } : {}),
				},
				kinds: {
					image: lists.image ?? [],
					video: lists.video ?? [],
					model3d: lists.model3d ?? [],
					audio: lists.audio ?? [],
				},
			}],
			defaults,
			/** 用户显式选过哪些（界面用来区分"默认第一个"和"我选的"）。 */
			picked: Object.fromEntries(Object.entries(picks).filter(([, v]) => typeof v === 'string')),
		};
	};

	/**
	 * 记下某一类选了哪个模型。校验：kind 合法、provider 只有 lightai（多 provider 以后再放）、
	 * 模型必须在**该类的路由表**里（否则"选得了、跑不了" ✗）。
	 */
	const setDefault = async ({ kind, provider, model } = {}) => {
		if (!KINDS.includes(kind)) { throw new Error(`未知的类别：${String(kind)}（只能是 ${KINDS.join(' / ')}）`); }
		const pid = String(provider ?? 'lightai').trim() || 'lightai';
		if (pid !== 'lightai') { throw new Error(`未知的 provider：${pid}（现在只有 lightai 由 dsh 侧提供）`); }
		const id = String(model ?? '').trim();
		const route = FLOOD_MODELS[id];
		if (!id || !route || route.kind !== kind) {
			throw new Error(`这个模型现在用不了：${id || '(空)'}（dsh 侧还没接入它的生成参数）`);
		}
		const next = { ...(await readDefaults()), [kind]: id };
		await writeRef(MEDIA_DEFAULTS_REF, JSON.stringify(next));
		return catalog();
	};

	return {
		refs: { cookie: LIGHTAI_COOKIE_REF, session: LIGHTAI_SESSION_REF, config: LIGHTAI_CONFIG_REF, signedOut: LIGHTAI_SIGNED_OUT_REF },
		status,
		signIn,
		cancelSignIn,
		signOut,
		refreshModels,
		test,
		setConfig,
		importSession,
		modelsOf,
		generate,
		catalog,
		setDefault,
		ratios: RATIOS,
	};
}
