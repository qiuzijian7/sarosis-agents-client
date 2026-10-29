// vendor/axios-shim —— 只给 **vendored 飞书 SDK** 用的最小 axios 兼容层（2026-10-29）
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// `@larksuiteoapi/node-sdk` 的 `lib/index.js` 顶部 `require('axios')`。而我们的交付形态是
// "vendor 进包"（`scripts/vendor-lark-sdk.mjs`），依赖原本被复制到 `vendor/node_modules/` ——
// 但 **npm 打包会无条件剥掉任何 node_modules 目录**（即使写进 `files`）⇒ 装到 profile 后
// 只剩 `vendor/node-sdk`，第一次点「启动入站」必然
// `Cannot find module 'axios'` ⇒ 飞书入站**从来没真正跑起来过**（真机 2026-10-29 定案）。
//
// ⇒ 不再借 `node_modules` 目录名，改成**普通目录 + 相对 require**（SDK 里那一行由 vendor 脚本改写：
//   `require('axios')` → `require('../../deps/axios.js')`）。
//
// ★ 本文件是**真源**（入库）：`scripts/vendor/axios.cjs` → 由 `scripts/vendor-lark-sdk.mjs`
//   复制为 `lib/adapters/vendor/deps/axios.js`（后者在 .gitignore 里，是生成物）。
//
// ── 实现范围（按 SDK 的真实用法裁剪，不多做）──────────────────────────────────
// 真机核对过 SDK 只用这四样：
//   ① `axios.create()`                     → 返回实例（defaults/interceptors/request/get/post/…）
//   ② `instance.interceptors.request.use()` → 改 `headers['User-Agent']`
//   ③ `instance.interceptors.response.use()`→ 直接返回 `resp.data`（**所以成功值就是 data**）
//   ④ `axios.AxiosError` + `e.response.data` → 非 2xx 必须抛带 `response` 的错误
// 另外 SDK 会 `instance.request({ method, url, headers, data, params?, responseType? })`
// 与 `instance.post(url, data, config)`。
//
// ⚠ 这是**给 SDK 用的内部件**，不是公共 axios：没有 cancel、没有 proxy 代理、没有
//   follow-redirects 的细节控制、没有 browser adapter。将来 SDK 换成 fetch 就删掉它。
'use strict';

const DEFAULT_TIMEOUT_MS = 30_000;

/** axios 的错误形状（SDK 靠 `instanceof axios.AxiosError` 与 `e.response.data` 判错）。 */
class AxiosError extends Error {
	constructor(message, code, config, request, response) {
		super(String(message || 'request failed'));
		this.name = 'AxiosError';
		this.isAxiosError = true;
		this.code = code;
		this.config = config;
		this.request = request;
		this.response = response;
	}
	static isAxiosError(e) {
		return !!(e && e.isAxiosError === true);
	}
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
	&& !(typeof FormData !== 'undefined' && v instanceof FormData)
	&& !(typeof URLSearchParams !== 'undefined' && v instanceof URLSearchParams)
	&& !(typeof Buffer !== 'undefined' && Buffer.isBuffer(v));

/** `{ a: 1, b: [1,2] }` → `a=1&b=1&b=2`（axios 的默认序列化口径，够 SDK 用）。 */
function toQuery(params) {
	if (!params) { return ''; }
	if (typeof params === 'string') { return params.replace(/^\?/, ''); }
	const usp = new URLSearchParams();
	for (const key of Object.keys(params)) {
		const v = params[key];
		if (v === undefined || v === null) { continue; }
		if (Array.isArray(v)) { for (const item of v) { usp.append(key, String(item)); } }
		else { usp.append(key, String(v)); }
	}
	return usp.toString();
}

function headersToObject(h) {
	const out = {};
	try {
		if (h && typeof h.forEach === 'function') { h.forEach((v, k) => { out[String(k).toLowerCase()] = v; }); }
	} catch { /* 忽略 */ }
	return out;
}

function makeInstance(baseDefaults) {
	const reqHandlers = [];
	const resHandlers = [];

	async function request(rawConfig) {
		let config = {
			method: 'get',
			timeout: DEFAULT_TIMEOUT_MS,
			...(baseDefaults || {}),
			...(rawConfig || {}),
			headers: { ...((baseDefaults || {}).headers || {}), ...((rawConfig || {}).headers || {}) },
		};
		/* 请求拦截器：SDK 在这里补 User-Agent（所以 headers 必须是**真对象**，不能是 undefined） */
		for (const h of reqHandlers) {
			if (typeof h.onFulfilled === 'function') { config = h.onFulfilled(config) || config; }
		}
		config.headers = { ...(config.headers || {}) };

		const method = String(config.method || 'get').toUpperCase();
		const base = String(config.baseURL || '');
		const qs = toQuery(config.params);
		const url = base + String(config.url || '') + (qs ? (String(config.url || '').includes('?') ? '&' : '?') + qs : '');

		const init = { method, headers: config.headers };
		if (method !== 'GET' && method !== 'HEAD' && config.data !== undefined && config.data !== null) {
			const data = config.data;
			if (typeof data === 'string' || (typeof Buffer !== 'undefined' && Buffer.isBuffer(data))) {
				init.body = data;
			} else if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
				init.body = data.toString();
			} else if (typeof FormData !== 'undefined' && data instanceof FormData) {
				init.body = data;
			} else if (isPlainObject(data) || Array.isArray(data)) {
				init.body = JSON.stringify(data);
				if (!Object.keys(config.headers).some((k) => k.toLowerCase() === 'content-type')) {
					config.headers['content-type'] = 'application/json';
				}
			} else {
				init.body = String(data);
			}
		}

		const timeout = Number(config.timeout) > 0 ? Number(config.timeout) : 0;
		const controller = timeout ? new AbortController() : null;
		const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
		if (controller) { init.signal = controller.signal; }

		let res;
		try {
			res = await fetch(url, init);
		} catch (e) {
			if (timer) { clearTimeout(timer); }
			const aborted = String((e && e.name) || '') === 'AbortError';
			throw new AxiosError(
				aborted ? `timeout of ${timeout}ms exceeded` : String((e && e.message) || e),
				aborted ? 'ECONNABORTED' : 'ERR_NETWORK',
				config,
				null,
				null,
			);
		}
		if (timer) { clearTimeout(timer); }

		let data;
		const rt = String(config.responseType || '').toLowerCase();
		try {
			if (rt === 'arraybuffer') { data = Buffer.from(await res.arrayBuffer()); }
			else if (rt === 'blob') { data = await res.blob(); }
			else if (rt === 'text') { data = await res.text(); }
			else {
				const text = await res.text();
				if (!text) { data = ''; }
				else { try { data = JSON.parse(text); } catch { data = text; } }
			}
		} catch (e) {
			throw new AxiosError(String((e && e.message) || e), 'ERR_BAD_RESPONSE', config, null, null);
		}

		const response = {
			data,
			status: res.status,
			statusText: res.statusText || '',
			headers: headersToObject(res.headers),
			config,
			request: null,
		};

		/* axios 的顺序：非 2xx 先在 settle 里抛（response 拦截器的 fulfilled 不跑）。
		   SDK 注册的 response 拦截器只有 fulfilled，所以这里必须是"抛错带 response"。 */
		if (res.status < 200 || res.status >= 300) {
			throw new AxiosError(
				`Request failed with status code ${res.status}`,
				res.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
				config,
				null,
				response,
			);
		}

		let out = response;
		for (const h of resHandlers) {
			if (typeof h.onFulfilled === 'function') { out = h.onFulfilled(out); }
		}
		return out;
	}

	const instance = {
		defaults: baseDefaults || {},
		interceptors: {
			request: { use: (onFulfilled, onRejected) => { reqHandlers.push({ onFulfilled, onRejected }); return reqHandlers.length - 1; } },
			response: { use: (onFulfilled, onRejected) => { resHandlers.push({ onFulfilled, onRejected }); return resHandlers.length - 1; } },
		},
		request,
		get: (url, config) => request({ ...(config || {}), method: 'get', url }),
		delete: (url, config) => request({ ...(config || {}), method: 'delete', url }),
		head: (url, config) => request({ ...(config || {}), method: 'head', url }),
		options: (url, config) => request({ ...(config || {}), method: 'options', url }),
		post: (url, data, config) => request({ ...(config || {}), method: 'post', url, data }),
		put: (url, data, config) => request({ ...(config || {}), method: 'put', url, data }),
		patch: (url, data, config) => request({ ...(config || {}), method: 'patch', url, data }),
	};
	return instance;
}

const axios = makeInstance({ headers: {} });
axios.create = (config) => makeInstance({ headers: {}, ...(config || {}) });
axios.AxiosError = AxiosError;
axios.isAxiosError = AxiosError.isAxiosError;
axios.default = axios;

module.exports = axios;
