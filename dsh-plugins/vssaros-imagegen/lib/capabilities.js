/**
 * 图像能力表（三批⑨）：**从 IDE 拿**"这台机器谁能生图 + 各家支持哪些档位"。
 *
 * 为什么不在插件侧自己维护一张表（上游 `capabilities.ts` 那样）：
 *   比例/质量/尺寸档是**各家 provider 私有**的 ⇒ 在我们这边抄一份就是**第二份真源** ⇒ 必漂 ✗。
 *   真源在 IDE 侧（provider 自己的定义与模型清单）⇒ 我们只**读**它
 *   （`media` 能力的 `op:'capabilities'`）✓。
 *
 * 缓存：能力表变化很慢（用户改了 Key / 加了模型才会变）⇒ 缓存 60s，别每次调用都过桥一趟。
 */

/** 能力表缓存时长。 */
const CACHE_TTL_MS = 60_000;

// ── LightAI 直连（2026-10-22，用户："让 dsh 里生图直接用 LightAI，不再绕道 IDE"）──────────────────
//   bridge 插件提供 `vssarosLightAI`（建任务 → 轮询 → 取产物都在 Host 里）⇒ 选中 LightAI 时**不经 IDE**。

/** 指 LightAI 的 provider id：dsh 直连用 `lightai`；`lm:lightai` 是 IDE 侧那个注册名（照样走直连）。 */
export const LIGHTAI_PROVIDER_IDS = new Set(['lightai', 'lm:lightai']);
export const LIGHTAI_PROVIDER_ID = 'lightai';

/**
 * 这一次生图走哪条路（纯函数 ⇒ 守卫直接断言）。
 *
 * ★ 2026-10-27（用户：「生图逻辑都在 dsh 侧，后续废除 IDE 生图」）：新增 **`dsh`** 这一档 ——
 *   BYOK 的 OpenAI 兼容 provider 现在也能在 Host 里直连（`lib/imageApi.js`），
 *   因为 dsh 设置里本来就有每个 provider 的 `baseURL`，Key 也在 dsh 的 `.credentials.yaml` 里
 *   （`vssaros-bridge` 的 `providers.sync` 两样都写）。
 *
 *   · 指定了 provider ⇒ LightAI 走 LightAI；**是 dsh 路由就走 dsh**；都不是才交给 IDE；
 *   · 只指定了 model ⇒ `picture_*`（LightAI 形状）走 LightAI；其它走 dsh（模型 id 已经足够具体）；
 *   · 都没指定 ⇒ LightAI 已登录就 LightAI，其次 dsh（只有一个可直连的 provider 时），否则 IDE。
 * @returns {'lightai' | 'dsh' | 'ide'}
 */
export function pickImageRoute(target, { lightaiReady = false, dshProviders = [] } = {}) {
	const provider = String(target?.provider ?? '').trim();
	const model = String(target?.model ?? '').trim();
	const dsh = new Set((dshProviders ?? []).map(p => String(typeof p === 'string' ? p : p?.id ?? '')).filter(Boolean));
	const dshId = ids => id => dsh.has(id) || [...dsh].some(k => k.toLowerCase() === String(id).toLowerCase());
	if (provider) {
		if (LIGHTAI_PROVIDER_IDS.has(provider)) { return 'lightai'; }
		if (dshId()(provider)) { return 'dsh'; }
		// `lm:xxx` / `byok:xxx` 这种前缀写法也认（dsh 路由键与 IDE 的 id 不完全一致）
		const bare = provider.replace(/^(lm|byok|provider)[:.]/i, '');
		if (bare !== provider && dshId()(bare)) { return 'dsh'; }
		return 'ide';
	}
	if (model) { return /^picture_/.test(model) ? 'lightai' : (dsh.size > 0 ? 'dsh' : 'ide'); }
	if (lightaiReady) { return 'lightai'; }
	return dsh.size > 0 ? 'dsh' : 'ide';
}

/** dsh 侧 LightAI 是否可直接生图（服务在 + 已登录）。读不到状态 ⇒ 当不可用。 */
export async function lightaiReady(state) {
	const service = state?.lightai;
	if (!service || typeof service.status !== 'function') { return false; }
	try {
		return (await service.status())?.signedIn === true;
	} catch {
		return false;
	}
}

/** 解析路由（含"没指定时看 LightAI 登录没 / dsh 侧有哪些可直连的 provider"）。 */
export async function resolveImageRoute(state, target) {
	const provider = String(target?.provider ?? '').trim();
	const model = String(target?.model ?? '').trim();
	if (provider || model) {
		// 显式指定时也要 dsh 那一档（否则 BYOK 会被误判成 ide）
		return pickImageRoute(target, { dshProviders: await dshProviderIds(state) });
	}
	const [ready, dsh] = await Promise.all([lightaiReady(state), dshProviderIds(state)]);
	return pickImageRoute(target, { lightaiReady: ready, dshProviders: dsh });
}

/**
 * dsh 侧可直连的 provider（懒算 + 短缓存：读设置 + 解析凭据都是本地操作，但别每次生图都扫一遍）。
 *
 * ⚠ 缓存必须**按 settings 服务实例**分（WeakMap），不能用模块级单例：
 *   同一进程里换一份 settings（探针会连续 apply 多次；宿主里也可能重挂服务）时，
 *   上一份的 id 会被当成这一份的 ⇒ 路由判到 `dsh` 却解析不到 provider（2026-10-27 探针 ⑧ 抓到的真 bug）。
 * @returns {Promise<string[]>} provider id 列表（空 = 没有可直连的，路由会回落 IDE）
 */
const dshCache = new WeakMap();
export async function dshProviderIds(state) {
	const settings = state?.settings;
	const entry = settings && typeof settings === 'object' ? dshCache.get(settings) : undefined;
	if (entry && Date.now() - entry.at < 15_000) { return entry.ids; }
	let ids = [];
	try {
		const { listDshProviders } = await import('./imageApi.js');
		const list = await listDshProviders({ settings, credentials: state?.credentials });
		ids = list.map(item => String(item.id));
	} catch { ids = []; }
	if (settings && typeof settings === 'object') { dshCache.set(settings, { at: Date.now(), ids }); }
	return ids;
}

/** LightAI 在能力表里的那一项（已登录才有）。 */
async function lightaiProviderEntry(state) {
	if (!(await lightaiReady(state))) { return undefined; }
	try {
		const { models } = await state.lightai.models('image');
		if (!models || models.length === 0) { return undefined; }
		return {
			id: LIGHTAI_PROVIDER_ID,
			name: 'LightAI（dsh 直连）',
			models: models.map(m => ({ id: m.id, ...(m.name ? { name: m.name } : {}) })),
			...(Array.isArray(state.lightai.ratios) && state.lightai.ratios.length ? { ratios: [...state.lightai.ratios] } : {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * 能力表缓存（读一次、缓存一会儿）。
 * @param {object} state 宿主状态（要 state.bridge 与 state.pluginName）
 */
export function createCapabilityCache(state) {
	/** IDE 那部分（过桥，缓存 60s）。LightAI 那项每次现算（它的状态在 bridge 里另有缓存）。 */
	let ideCached = undefined;
	let inflight = undefined;
	let merged = undefined;

	async function loadIde(force) {
		if (!force && ideCached && Date.now() - ideCached.at < CACHE_TTL_MS) { return ideCached; }
		// 并发调用只过桥一次（其余等同一个 promise ✓）。
		if (inflight) { return inflight; }
		inflight = (async () => {
			const bridge = state.bridge;
			if (!bridge || typeof bridge.callIDE !== 'function') {
				throw new Error('读图像能力表要经控制桥回 IDE，但 vssarosBridge 不在（bridge 插件没装/没连）');
			}
			const reply = await bridge.callIDE('ide.request', {
				capability: 'media',
				pluginId: state.pluginName,
				params: { op: 'capabilities' },
			}, { timeoutMs: 30_000 });
			if (!reply || reply.ok === false) {
				throw new Error('读图像能力表失败：' + String(reply?.error ?? reply?.text ?? 'IDE 没回'));
			}
			const providers = Array.isArray(reply.providers) ? reply.providers : [];
			ideCached = { at: Date.now(), providers };
			return ideCached;
		})();
		try {
			return await inflight;
		} finally {
			inflight = undefined;
		}
	}

	async function load(options) {
		const force = options?.force === true;
		// ★ 2026-10-27：dsh 侧可直连的 provider 也进能力表（不依赖 IDE）
		const [lightai, ide, dsh] = await Promise.all([
			lightaiProviderEntry(state),
			loadIde(force).then(v => ({ ok: true, v }), e => ({ ok: false, e })),
			(async () => {
				try {
					const { listDshProviders } = await import('./imageApi.js');
					return await listDshProviders({ settings: state?.settings, credentials: state?.credentials });
				} catch { return []; }
			})(),
		]);
		// IDE 读不到、LightAI 和 dsh 都没有 ⇒ 如实报 IDE 那边的错（老行为）；有别的就不因 IDE 不在而失败 ✓
		if (!ide.ok && !lightai && dsh.length === 0) { throw ide.e; }
		const ideIds = new Set(dsh.map(item => item.id));
		const ideProviders = ide.ok
			? ide.v.providers.filter(p => !LIGHTAI_PROVIDER_IDS.has(String(p?.id ?? '')) && !ideIds.has(String(p?.id ?? '')))
			: [];
		// dsh 那几项没有"模型清单"（设置里只有聊天模型）⇒ 标明"模型 id 要你自己给"
		const dshEntries = dsh.map(item => ({
			id: item.id,
			name: item.name + '（dsh 直连）',
			models: [],
			needsModel: true,
		}));
		merged = {
			at: Date.now(),
			providers: [...(lightai ? [lightai] : []), ...dshEntries, ...ideProviders],
			...(!ide.ok ? { ideError: String(ide.e?.message ?? ide.e) } : {}),
		};
		return merged;
	}

	return {
		load,
		peek() { return merged; },
	};
}

/**
 * 能力表 ⇒ 人读的一段话（给模型看 ⇒ 它才知道"能选谁"）。
 * @param {{providers?: Array<object>} | undefined} capabilities
 * @returns {string}
 */
export function formatCapabilities(capabilities) {
	const providers = capabilities?.providers ?? [];
	if (providers.length === 0) {
		return '现在**没有任何能生图的 provider**（能力表是空的）——在 设置 → 模型 → LightAI 登录，或在 IDE 设置里配好图像模型，否则生图会失败。';
	}
	const lines = [];
	for (const provider of providers) {
		const models = Array.isArray(provider?.models) ? provider.models : [];
		const modelIds = models.map(model => model.id).join('、');
		const parts = ['模型：' + (modelIds || '(没有标记为可生图的模型)')];
		const ratios = provider?.ratios;
		if (Array.isArray(ratios) ? ratios.length > 0 : false) { parts.push('比例：' + ratios.join('、')); }
		const qualities = provider?.qualities;
		if (Array.isArray(qualities) ? qualities.length > 0 : false) { parts.push('质量：' + qualities.join('、')); }
		const sizes = provider?.sizes;
		if (Array.isArray(sizes) ? sizes.length > 0 : false) { parts.push('尺寸：' + sizes.join('、')); }
		const title = provider?.name ? provider.name + '（' + provider.id + '）' : String(provider?.id ?? '?');
		lines.push('- ' + title + ' — ' + parts.join('；'));
	}
	const ideNote = capabilities?.ideError ? '\n（IDE 侧的图像 provider 这次没读到：' + capabilities.ideError + '）' : '';
	return '能生图的 provider（不指定 provider/model 时：LightAI 已登录就用它，否则用 IDE 侧默认那个）：\n' + lines.join('\n') + ideNote;
}

/**
 * 按某个 provider 的能力表**校正**参数（三批⑧ 的"按各家能力表修正 ratio/quality"）。
 *
 * ⚠ 表里**没登记**的档位 ⇒ 原样透传（不猜、不替 provider 做决定 ✗）；
 *   表里登记了、而请求的值不在其中 ⇒ **去掉该参数**（provider 用它自己的默认档）并记一条说明 ✓。
 *
 * @param {{provider?: string, quality?: string, size?: string}} target
 * @param {{providers?: Array<object>} | undefined} capabilities
 * @returns {{quality: string, size: string, notes: string[]}}
 */
export function fitToCapabilities(target, capabilities) {
	const notes = [];
	const providerId = String(target?.provider ?? '').trim();
	const provider = (capabilities?.providers ?? []).find(item => String(item?.id ?? '') === providerId);
	const out = { quality: '', size: '' };
	const quality = String(target?.quality ?? '').trim();
	if (quality) {
		const known = Array.isArray(provider?.qualities) ? provider.qualities : [];
		if (known.length === 0) {
			out.quality = quality;
		} else if (known.includes(quality)) {
			out.quality = quality;
		} else {
			notes.push('provider ' + providerId + ' 不支持质量档「' + quality + '」⇒ 已去掉（用它自己的默认档）');
		}
	}
	const size = String(target?.size ?? '').trim();
	if (size) {
		const known = Array.isArray(provider?.sizes) ? provider.sizes : [];
		if (known.length === 0) {
			out.size = size;
		} else if (known.includes(size)) {
			out.size = size;
		} else {
			notes.push('provider ' + providerId + ' 不支持尺寸「' + size + '」⇒ 已去掉');
		}
	}
	return { quality: out.quality, size: out.size, notes };
}
