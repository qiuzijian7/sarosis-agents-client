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

/**
 * 能力表缓存（读一次、缓存一会儿）。
 * @param {object} state 宿主状态（要 state.bridge 与 state.pluginName）
 */
export function createCapabilityCache(state) {
	let cached = undefined;
	let inflight = undefined;

	async function load(options) {
		const force = options?.force === true;
		if (!force) {
			if (cached) {
				const age = Date.now() - cached.at;
				if (age < CACHE_TTL_MS) { return cached; }
			}
		}
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
			cached = { at: Date.now(), providers };
			return cached;
		})();
		try {
			return await inflight;
		} finally {
			inflight = undefined;
		}
	}

	return {
		load,
		peek() { return cached; },
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
		return '这台 IDE 现在**没有登记任何能生图的 provider**（能力表是空的）——先在 IDE 设置里把图像模型配好，否则生图会失败。';
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
	return '这台 IDE 能生图的 provider：\n' + lines.join('\n');
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
