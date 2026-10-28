// @vssaros/dsh-imagegen — **dsh 侧的 OpenAI 兼容图像 API 客户端**（2026-10-27）。
//
// ── 为什么要有它 ──────────────────────────────────────────────────────────────
// 用户拍板：「生图相关逻辑都在 dsh 侧实现，后续会废除 IDE 侧生图功能」。
// 而 dsh **本来就有**每个 BYOK provider 的 baseURL 与 API Key：
//   `vssaros-bridge` 的 `providers.sync` 把 IDE 的 provider 写进 `llm-pi-ai` 设置
//   （`providers.<route> = { api, baseURL, displayName, apiKeyEnv, headers, models }`），
//   **凭证也一并写进 dsh 的 `.credentials.yaml`**（`credentials.set(c.ref, c.value)`）。
// ⇒ 生图不需要再借 IDE 的 `/images/generations`，直接用 Host 里的这份配置即可。
//
// ── 与 IDE 侧那套的差异（都是"少猜"）─────────────────────────────────────────
//   · 不自己维护 provider 清单：路由键就是设置里的键（`vssaros-xxx` / `lm:xxx` / `lightai` 除外）；
//   · 不猜"哪家能生图"：模型 id 由调用方给（`gpt-image-1` / `dall-e-3` / 各家自有）
//     ⇒ 猜错只是 provider 回 4xx，我们如实报（不静默换成别家）；
//   · `b64_json` 优先、`url` 也认（有的网关只回 URL，Host 有网络，`normalizeImage` 会去取）。
//
// ── 端点形状（与 IDE `MainProcessModelProvider.generateImage` 逐条对齐）────────
//   POST `{baseURL}/images/generations`；404/405 ⇒ 回退 `{baseURL}/v1/images/generations`
//   改图：POST `{baseURL}/images/edits`（multipart/form-data，同样 404/405 回退 `/v1`）

/** 生图/改图都可能几十秒到几分钟（与 IDE 侧 10 分钟档同量级）。 */
const TIMEOUT_MS = 10 * 60 * 1000;

/** dsh 设置里 provider 所在的命名空间（pi-ai 适配器，见 `providerProfile.js`）。 */
const PROVIDERS_NS = 'llm-pi-ai';

/** 这些 id 不是"BYOK 路由"（LightAI 走自己的服务）。 */
const NOT_A_ROUTE = new Set(['lightai', 'lm:lightai']);

/**
 * 读 dsh 设置里的 provider 路由表。
 * @returns {Promise<Record<string, object>>} route → profile（读不到就空对象，绝不抛）
 */
export async function readProviderRoutes(settings) {
	if (!settings || typeof settings.describe !== 'function') { return {}; }
	try {
		const desc = await settings.describe(PROVIDERS_NS);
		const providers = desc && desc.value && typeof desc.value === 'object' ? desc.value.providers : undefined;
		return providers && typeof providers === 'object' ? providers : {};
	} catch {
		return {};
	}
}

/** 允许用 `lm:xxx` / `byok:xxx` / 裸 `xxx` 三种写法指同一个路由。 */
function candidateKeys(providerId) {
	const id = String(providerId ?? '').trim();
	if (!id) { return []; }
	const bare = id.replace(/^(lm|byok|provider)[:.]/i, '');
	const keys = [id, bare, 'vssaros-' + bare, 'vssaros-' + bare.replace(/^vssaros-/, '')];
	return [...new Set(keys.filter(Boolean))];
}

/**
 * 把一个 provider id 解析成**可直接发请求**的配置。
 * @param {{settings?: object, credentials?: object}} deps
 * @param {string} providerId
 * @returns {Promise<{id: string, route: string, baseURL: string, apiKey: string,
 *   headers?: Record<string,string>, api?: string} | undefined>}
 *   `undefined` = 不是 dsh 侧可直连的 provider（没这个路由 / 没 baseURL / 没 Key）
 */
export async function resolveDshProvider(deps, providerId) {
	const wanted = String(providerId ?? '').trim();
	if (!wanted || NOT_A_ROUTE.has(wanted)) { return undefined; }
	const routes = await readProviderRoutes(deps?.settings);
	if (!routes || Object.keys(routes).length === 0) { return undefined; }
	const lower = new Map(Object.keys(routes).map(k => [k.toLowerCase(), k]));
	let route = '';
	for (const key of candidateKeys(wanted)) {
		if (routes[key]) { route = key; break; }
		const hit = lower.get(key.toLowerCase());
		if (hit) { route = hit; break; }
	}
	if (!route) { return undefined; }
	const profile = routes[route] ?? {};
	const baseURL = String(profile.baseURL ?? profile.baseUrl ?? '').trim();
	if (!/^https?:\/\//i.test(baseURL)) { return undefined; }
	// 凭据：`apiKeyEnv` 是**引用**（dsh `.credentials.yaml` 的键），按请求现解析
	let apiKey = '';
	const ref = String(profile.apiKeyEnv ?? profile.apiKeyRef ?? '').trim();
	if (ref && deps?.credentials && typeof deps.credentials.resolve === 'function') {
		try { apiKey = String((await deps.credentials.resolve(ref))?.value ?? ''); } catch { apiKey = ''; }
	}
	// 没有 Key 也可能是"网关自带鉴权头"（`headers` 里带 Authorization）⇒ 有 headers 就放行
	const headers = profile.headers && typeof profile.headers === 'object' ? { ...profile.headers } : undefined;
	if (!apiKey && !(headers && Object.keys(headers).some(k => /authorization|api-key|x-api-key/i.test(k)))) {
		return undefined;
	}
	return { id: wanted, route, baseURL, apiKey, ...(headers ? { headers } : {}), ...(profile.api ? { api: String(profile.api) } : {}) };
}

/**
 * 取一个可直连的 provider：给了 id 就按 id；**没给就取第一个**（按 id 排序，保证可复现）。
 *
 * 场景：`edit_image` 的入参没有 `provider`（它只有 `model` / `source`）⇒ 路由判定说 dsh 之后
 * 得自己挑一个能用的；挑不到就返回 undefined，由调用方如实报错（不猜、不静默换别家）。
 */
export async function pickDshProvider(deps, providerId) {
	const wanted = String(providerId ?? '').trim();
	if (wanted) { return resolveDshProvider(deps, wanted); }
	const ids = (await listDshProviders(deps)).map(item => item.id).sort();
	if (ids.length === 0) { return undefined; }
	return resolveDshProvider(deps, ids[0]);
}

/** 这一批里哪些 provider id 是 dsh 可直连的（能力表 / 路由判定用）。 */
export async function listDshProviders(deps) {
	const routes = await readProviderRoutes(deps?.settings);
	const out = [];
	for (const route of Object.keys(routes)) {
		if (NOT_A_ROUTE.has(route)) { continue; }
		const one = await resolveDshProvider(deps, route);
		if (one) { out.push({ id: route, name: String(routes[route]?.displayName ?? route), baseURL: one.baseURL }); }
	}
	return out;
}

function authHeaders(provider) {
	const headers = { 'content-type': 'application/json', ...(provider.headers ?? {}) };
	if (provider.apiKey && !Object.keys(headers).some(k => /authorization|api-key|x-api-key/i.test(k))) {
		headers.authorization = `Bearer ${provider.apiKey}`;
	}
	return headers;
}

/** 把响应体归一成 `[{ b64 }]` / `[{ url }]`（与 IDE 回执同形，供 `normalizeImage` 消化）。 */
function toRawImages(payload) {
	const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.images) ? payload.images : [];
	const out = [];
	for (const item of data) {
		if (!item || typeof item !== 'object') {
			// 有的网关直接回字符串数组（base64 或 URL）
			if (typeof item === 'string' && item.trim()) {
				out.push(/^https?:\/\//i.test(item) ? { url: item } : { b64: item });
			}
			continue;
		}
		const b64 = item.b64_json ?? item.b64 ?? item.image_base64;
		if (typeof b64 === 'string' && b64.trim()) { out.push({ b64 }); continue; }
		const url = item.url ?? item.image_url;
		if (typeof url === 'string' && url.trim()) { out.push({ url }); }
	}
	return out;
}

/**
 * POST 一个图像端点，**404/405 自动回退 `/v1` 前缀**（各家网关的 baseURL 口径不一致）。
 * @returns {Promise<{rawImages: object[], modelId: string}>}
 */
async function postImageEndpoint(provider, path, init, { signal, model } = {}) {
	const base = provider.baseURL.replace(/\/+$/, '');
	const urls = [`${base}${path}`];
	if (!/\/v1$/i.test(base)) { urls.push(`${base}/v1${path}`); }
	let lastError = '';
	for (const [index, url] of urls.entries()) {
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		if (signal) {
			if (signal.aborted) { controller.abort(); }
			else { signal.addEventListener('abort', onAbort, { once: true }); }
		}
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			const response = await fetch(url, { ...init, signal: controller.signal });
			if (response.status === 404 || response.status === 405) {
				lastError = `HTTP ${response.status} ${url}`;
				continue;
			}
			const text = await response.text();
			if (!response.ok) {
				throw new Error(`图像 API 返回 HTTP ${response.status}（${String(model || provider.id)}）：${text.slice(0, 300)}`);
			}
			let payload;
			try { payload = JSON.parse(text); } catch { throw new Error('图像 API 回了非 JSON：' + text.slice(0, 200)); }
			const rawImages = toRawImages(payload);
			if (rawImages.length === 0) {
				throw new Error('图像 API 成功但没返回图片（data 为空）：' + text.slice(0, 200));
			}
			return { rawImages, modelId: String(payload?.model ?? model ?? '') };
		} catch (err) {
			// 已经是最后一档 / 不是"端点不存在" ⇒ 直接抛（不吞错）
			if (index === urls.length - 1 || !/HTTP 40[45]/.test(String(err?.message ?? ''))) { throw err; }
			lastError = String(err?.message ?? err);
		} finally {
			clearTimeout(timer);
			if (signal) { signal.removeEventListener?.('abort', onAbort); }
		}
	}
	throw new Error(`图像端点不可用（${provider.id}）：${lastError || '未知原因'}`);
}

/**
 * 文生图 / 图生图（带参考图时走 edits）。
 * @param {object} provider `resolveDshProvider` 的结果
 * @param {{prompt: string, model?: string, size?: string, n?: number, quality?: string,
 *   reference?: Array<{bytes: Uint8Array, mediaType: string, name?: string}>, signal?: AbortSignal}} [options]
 * @returns {Promise<{rawImages: object[], providedBy: string, modelId: string}>}
 */
export async function generateViaDsh(provider, options = {}) {
	const prompt = String(options.prompt ?? '');
	const model = String(options.model ?? '').trim();
	const n = Math.max(1, Math.min(4, Number(options.n) || 1));
	const size = String(options.size ?? '').trim();
	const quality = String(options.quality ?? '').trim();
	const reference = Array.isArray(options.reference) ? options.reference.filter(r => r && r.bytes && r.bytes.length) : [];

	if (reference.length > 0) {
		// 图生图：multipart（与 IDE 侧 `/images/edits` 同口径）
		const form = new FormData();
		if (model) { form.append('model', model); }
		form.append('prompt', prompt);
		if (n > 1) { form.append('n', String(n)); }
		if (size) { form.append('size', size); }
		if (quality) { form.append('quality', quality); }
		reference.forEach((item, index) => {
			const blob = new Blob([item.bytes], { type: item.mediaType || 'image/png' });
			form.append('image', blob, item.name || `image-${index + 1}.png`);
		});
		const headers = { ...(provider.headers ?? {}) };
		if (provider.apiKey && !Object.keys(headers).some(k => /authorization|api-key|x-api-key/i.test(k))) {
			headers.authorization = `Bearer ${provider.apiKey}`;
		}
		const result = await postImageEndpoint(provider, '/images/edits', { method: 'POST', headers, body: form }, { signal: options.signal, model });
		return { ...result, providedBy: provider.id };
	}

	const body = { prompt, n, ...(model ? { model } : {}), ...(size ? { size } : {}), ...(quality ? { quality } : {}) };
	const result = await postImageEndpoint(provider, '/images/generations', {
		method: 'POST',
		headers: authHeaders(provider),
		body: JSON.stringify(body),
	}, { signal: options.signal, model });
	return { ...result, providedBy: provider.id };
}
