/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VsSaros 已配置的模型 provider → 控制桥 `providers.sync` 负载的纯构建器（可单测）。
 *
 * 收集器（electron-browser/dshProviderSync.ts）负责读设置/注册表/扩展命令，把结果
 * 整理成本文件的输入类型；这里只做映射与整形：路由名、协议映射、凭证引用名、模型截断。
 *
 * 路由全部带 `vssaros-` 前缀（桥插件只管理这个前缀，用户在 dsh 设置页自加的条目不受影响）。
 */

import { DshProviderApi, DshReasoningEffort, IBridgeProviderEntry, IBridgeProviderModel, IBridgeProvidersSyncArgs } from './dshBridgeProtocol.js';

/** 一个模型条目（收集侧共用形状；与 `IBridgeProviderModel` 同形）。 */
export interface IDshModelRef {
	readonly id: string;
	readonly name?: string;
	/** 支持推理/思考模式（dsh 侧据此决定是否走 reasoning 通道）。 */
	readonly reasoning?: boolean;
	/** 支持图片输入（dsh 侧据此给模型声明 `input: ['text','image']`）。 */
	readonly supportsImages?: boolean;
	/** 上下文窗口（dsh 侧写成模型级 `contextWindow`；缺省交给 pi-ai 默认）。 */
	readonly contextWindow?: number;
	/** 最大输出 token（dsh 侧写成模型级 `maxTokens`；缺省交给 pi-ai 默认）。 */
	readonly maxTokens?: number;
	/** 平台目录给的推荐档位（决定路由级默认档位；见 `IBridgeProviderModel.effort`）。 */
	readonly effort?: DshReasoningEffort;
}

/** 一个 provider 源的收集输入（凭证可以是空 = 本地无 key 端点）。 */
export interface IDshProviderSource {
	/** VsSaros 侧 id（如 openrouter / 自定义 provider id / codebuddy）。 */
	readonly id: string;
	readonly displayName: string;
	/** 'openai'（默认）或 'anthropic'（原生 Messages 网关）。 */
	readonly apiType?: 'openai' | 'anthropic';
	readonly baseURL: string;
	/** 已配置的凭证（apiKey / 登录 token）；空串/缺省 = 无 key。 */
	readonly credential?: string;
	/** 额外请求头（如 codebuddy 网关的 X-IDE-* 身份头）；缺省 = 无。 */
	readonly headers?: Record<string, string>;
	/** 已知模型（注册表缓存 / 静态声明）；空数组 = 不接入（dsh 的 profile 要求非空）。 */
	readonly models: readonly IDshModelRef[];
}

/** 路由名：`vssaros-<id>`（小写、仅 [a-z0-9-]，超长截断到协议上限内）。 */
export function providerRouteFor(id: string): string {
	const slug = id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
	return `vssaros-${slug}`.slice(0, 49);
}

/** 凭证引用名：`VSSAROS_<ID>_KEY`（大写、-→_；与路由一一对应）。 */
export function credentialRefFor(id: string): string {
	const slug = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
	return `VSSAROS_${slug}_KEY`.slice(0, 69);
}

/** apiType → dsh 线协议。 */
export function providerApiFor(apiType: 'openai' | 'anthropic' | undefined): DshProviderApi {
	return apiType === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
}

/**
 * 合并**扩展登录态 provider** 的两份模型清单：AgentOS 注册表那份（`_modelsOf`，与原生下拉同源）
 * 与扩展命令返回的那份（`cfg.models`）。
 *
 * 为什么以**注册表为主**：原生聊天框的下拉就是 `getModelProviders() → provider.listModels()`
 * （`lm:<vendor>` 由 `LanguageModelsToAgentOSBridge` 实时映射 VS Code LM 缓存），所以注册表那份
 * 与"用户在原生看到的模型列表"**同源同刻**；扩展命令返回的是 `/v3/config` 服务端清单（取不到才回落
 * 内置 `model.json`），可能落后或偏少（实测它就缺过新模型）。
 *
 * 为什么仍要**并集**：
 *  1. 注册表可能瞬时读不到（服务时序 / LM 缓存未填充 / 8 秒超时 → `_modelsOf` 给空数组），
 *     此时命令清单是唯一兜底；
 *  2. 命令侧能给出**显式** `reasoning` 能力位，而注册表这条经 VS Code LM API 会丢能力声明
 *     （官方 bridge 注释亦承认要靠启发式反推）⇒ 同 id 时以命令侧的 `reasoning: true` 为准。
 * 顺序保持"注册表在前、命令补充在后"（dsh 模型选择器按此顺序展示）。
 */
export function mergeExtensionModels(
	registryModels: readonly IDshModelRef[],
	commandModels: readonly IDshModelRef[] | undefined,
): IDshModelRef[] {
	const out: IDshModelRef[] = [];
	const index = new Map<string, number>();
	// 不产出 `name: undefined` 这类"显式空键"：合并结果要与"缺省即不展示"语义一致（也便于 deepStrictEqual 断言）。
	const entry = (
		id: string,
		name: string | undefined,
		reasoning: boolean,
		effort: DshReasoningEffort | undefined,
		supportsImages: boolean,
		contextWindow: number | undefined,
		maxTokens: number | undefined,
	): IDshModelRef => ({
		id,
		...(name ? { name } : {}),
		...(reasoning ? { reasoning: true } : {}),
		// ★ 2026-10-30：图像能力与 reasoning 同款口径 —— **任一来源声明即为真**。
		// 只保留「真」（`false` 与缺省等价）⇒ 不会因为某一侧没这个字段就把能力抹掉。
		...(supportsImages ? { supportsImages: true } : {}),
		// 容量位只在拿到正有限数时写（0/NaN 一律不写 ⇒ 不把 pi-ai 默认覆盖成 0）。
		...(_positiveCapacity(contextWindow) ? { contextWindow } : {}),
		...(_positiveCapacity(maxTokens) ? { maxTokens } : {}),
		...(effort ? { effort } : {}),
	});
	for (const m of registryModels) {
		if (m?.id && !index.has(m.id)) {
			index.set(m.id, out.length);
			out.push(entry(m.id, m.name, m.reasoning === true, m.effort, m.supportsImages === true, m.contextWindow, m.maxTokens));
		}
	}
	for (const m of commandModels ?? []) {
		if (!m?.id) {
			continue;
		}
		const at = index.get(m.id);
		if (at === undefined) {
			index.set(m.id, out.length);
			out.push(entry(m.id, m.name, m.reasoning === true, m.effort, m.supportsImages === true, m.contextWindow, m.maxTokens));
			continue;
		}
		const prev = out[at];
		// effort 只有命令侧有（注册表经 LM API 丢能力/参数位）⇒ 合并时保留已有的那份。
		// supportsImages 取并集：注册表那份来自 LM 元数据（可信），命令侧来自平台目录 ——
		// 任一侧说支持就不该被判成纯文本（判错的代价是「图被静默剥离」）。
		// 容量位同样「有则取」：平台目录是权威（逐模型给了 maxInputTokens/maxOutputTokens），
		// 注册表那份经 LM API 未必带 ⇒ 先取命令侧，缺了才回落注册表。
		out[at] = entry(
			prev.id,
			prev.name ?? m.name,
			prev.reasoning === true || m.reasoning === true,
			prev.effort ?? m.effort,
			prev.supportsImages === true || m.supportsImages === true,
			_positiveCapacity(m.contextWindow) ? m.contextWindow : prev.contextWindow,
			_positiveCapacity(m.maxTokens) ? m.maxTokens : prev.maxTokens,
		);
	}
	return out;
}

/**
 * 容量值是否可用（正有限数）。
 *
 * ★ 2026-10-30：`0` / `NaN` / `Infinity` 都不是合法窗口。把它们写进 profile 会把 pi-ai 的
 * 默认值覆盖成「零上下文」⇒ 比不写更糟。所以这里统一挡掉，只让真实容量过关。
 */
function _positiveCapacity(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * 单个 provider 的模型上限。取 **200**：跨进程校验器（`validateProvidersSyncArgs`）的硬上限就是
 * `models.length > 200` 拒绝，此前取 100 会在"注册表 ∪ 扩展命令"的并集场景下**静默丢掉尾部模型**
 * （codebuddy 的清单本身就有 70+ 条，两侧页数不一致时合并后很容易越界）。
 */
const MAX_MODELS_PER_PROVIDER = 200;

/** 头的整形：去空值、截断到协议上限（跨进程校验器还会再收一次）。 */
function sanitizeHeaders(h: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!h) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h).slice(0, 16)) {
		const value = typeof v === 'string' ? v.trim() : '';
		if (k && value) {
			out[k] = value.slice(0, 512);
		}
	}
	return Object.keys(out).length ? out : undefined;
}

/** 把收集到的源整形成 sync 负载；跳过未通过整形（缺 baseURL / 模型为空）的源并记入 skipped。 */
export function buildProvidersSyncArgs(sources: readonly IDshProviderSource[]): IBridgeProvidersSyncArgs & { skipped: string[] } {
	const providers: IBridgeProviderEntry[] = [];
	const credentials: { ref: string; value: string }[] = [];
	const skipped: string[] = [];
	const seenRoutes = new Set<string>();
	for (const src of sources) {
		const baseURL = src.baseURL.trim().replace(/\/+$/, '');
		const models: IBridgeProviderModel[] = src.models.slice(0, MAX_MODELS_PER_PROVIDER)
			.filter(m => m.id && typeof m.id === 'string')
			.map(m => ({
				id: m.id,
				name: m.name && m.name !== m.id ? m.name : undefined,
				...(m.reasoning === true ? { reasoning: true } : {}),
				...(m.supportsImages === true ? { supportsImages: true } : {}),
				// ★ 2026-10-30：容量位（正有限数才写；缺省不写 ⇒ 交给 pi-ai 默认）。
				...(_positiveCapacity(m.contextWindow) ? { contextWindow: m.contextWindow } : {}),
				...(_positiveCapacity(m.maxTokens) ? { maxTokens: m.maxTokens } : {}),
				...(m.effort ? { effort: m.effort } : {}),
			}));
		if (!baseURL || models.length === 0) {
			skipped.push(src.id);
			continue;
		}
		const route = providerRouteFor(src.id);
		if (seenRoutes.has(route)) {
			skipped.push(`${src.id}（路由 ${route} 撞名）`);
			continue;
		}
		seenRoutes.add(route);
		const credential = src.credential?.trim();
		const credentialRef = credential ? credentialRefFor(src.id) : undefined;
		if (credential && credentialRef) {
			credentials.push({ ref: credentialRef, value: credential });
		}
		providers.push({
			route,
			displayName: src.displayName.slice(0, 80),
			api: providerApiFor(src.apiType),
			baseURL,
			credentialRef,
			headers: sanitizeHeaders(src.headers),
			models,
		});
	}
	return { providers, credentials, skipped };
}
