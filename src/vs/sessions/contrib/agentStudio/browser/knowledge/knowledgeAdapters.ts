/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — VS Code adapters
 *
 *  Bridges the portable engine (`IChatModel` / `IEmbedder`) to the project's
 *  existing services:
 *    - `BuiltInBYOKModelProvider` configuration  →  OpenAICompatibleJsonModel
 *    - `IAiEmbeddingVectorService`                →  IEmbedder
 *
 *  No `fetch`/network details leak into the engine; the engine only knows the
 *  `IChatModel` / `IEmbedder` contracts.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IAiEmbeddingVectorService } from '../../../../../workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { streamToBuffer } from '../../../../../base/common/buffer.js';
import { BUILTIN_BYOK_PROVIDERS, customProviderDataToDefinition, IBYOKProviderDefinition } from '../builtInBYOKModelProvider.js';
import type { CustomProviderData } from '../views/providerView.js';
import { AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING } from '../../common/constants.js';
import { IChatModel, OpenAICompatibleJsonModel, ExtractRequest, stripCodeFence } from './engine/llm.js';
import type { IModelProvider } from '../../common/providers.js';
import { IEmbedder } from './engine/embedder.js';
import { resolveEmbeddingConfigForProvider, embedTextsInBatches } from './builtinEmbeddingProvider.js';
import { resolveOrFallbackAdapter } from './embeddingProviders.js';

/** Per-provider sensible default model ids (override via tool `model` arg). */
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
	openrouter: 'openai/gpt-4o-mini',
	nous: 'nousresearch/deepseek-r1',
	gemini: 'gemini-2.0-flash',
	anthropic: 'claude-3-5-haiku-20241022',
	ollama: 'llama3.1',
	main: 'gpt-4o-mini',
	custom: 'gpt-4o-mini',
};

export interface ResolveChatModelOpts {
	/** BYOK provider id (e.g. 'openrouter'). Default: 'openrouter'. */
	providerId?: string;
	/** Model id. Falls back to the provider's default model. */
	modelId?: string;
}

/**
 * 创建基于 IRequestService（主进程网络层）的 fetch 兼容实现。
 * 绕过 Electron renderer 的 CORS 限制——主进程发起的请求不受同源策略约束。
 *
 * 返回的函数签名与 globalThis.fetch 一致：(input, init) => Promise<Response>。
 */
export function createMainProcessFetch(requestService: IRequestService): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		const method = (init?.method ?? 'POST').toUpperCase();
		const headers: Record<string, string> = {};
		if (init?.headers) {
			const h = init.headers as Record<string, string>;
			for (const k of Object.keys(h)) { headers[k] = h[k]; }
		}
		const body = init?.body ? String(init.body) : undefined;

		const context = await requestService.request({
			type: method,
			url,
			headers,
			data: body,
			followRedirects: 5,
			callSite: 'saros.agentStudio.knowledge.mainProcessFetch',
		}, CancellationToken.None);

		const statusCode = context.res.statusCode ?? 0;
		const responseText = (await streamToBuffer(context.stream)).toString();

		return new Response(responseText, {
			status: statusCode,
			statusText: context.res.headers?.['status-message'] as string ?? '',
			headers: context.res.headers as Record<string, string>,
		});
	};
}

/**
 * 返回所有可用于 chat 的 BYOK provider 定义：内置 provider + 用户在 UI 添加的
 * 自定义 provider（持久化在 `sessions.agentStudio.provider.customProviders`）。
 * 用于 chat 模型解析时也能命中自定义 provider（否则会被误判为「未配置」）。
 */
export function getAllChatProviderDefs(config: IConfigurationService): IBYOKProviderDefinition[] {
	const custom = (config.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || [])
		.filter(cp => cp && cp.id && !BUILTIN_BYOK_PROVIDERS.some(b => b.id === cp.id))
		.map(cp => {
			try { return customProviderDataToDefinition(cp); } catch { return undefined; }
		})
		.filter((d): d is IBYOKProviderDefinition => !!d);
	return [...BUILTIN_BYOK_PROVIDERS, ...custom];
}

/** True when the given provider def has both a base URL and a non-empty API key configured. */
function isProviderDefConfigured(config: IConfigurationService, def: IBYOKProviderDefinition): boolean {
	const baseUrl = (config.getValue<string>(def.baseUrlConfigKey) || '').trim() || def.defaultBaseUrl;
	const apiKey = (config.getValue<string>(def.apiKeyConfigKey) || '').trim();
	return !!baseUrl && !!apiKey;
}

/**
 * Find the first fully-configured (base URL + API key) chat provider, preferring
 * higher `priority`. Returns its id, or `undefined` when nothing is configured.
 * Used as an "auto" fallback so KB/curator operations follow whichever provider
 * the user actually set up — not a hard-coded default that has no API key.
 */
export function resolveConfiguredChatProviderId(config: IConfigurationService): string | undefined {
	const defs = getAllChatProviderDefs(config).slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	for (const def of defs) {
		if (isProviderDefConfigured(config, def)) { return def.id; }
	}
	return undefined;
}

/**
 * Build an `IChatModel` from the user's configured BYOK provider.
 * Reads the provider's base URL + API key from Settings, then delegates to the
 * engine's OpenAI-compatible JSON model (which already implements the
 * json_schema → tool_call → instructed-JSON fallback ladder).
 */
export function resolveChatModel(
	config: IConfigurationService,
	opts: ResolveChatModelOpts = {},
	requestService?: IRequestService,
): IChatModel {
	const all = getAllChatProviderDefs(config);
	const def = all.find(p => p.id === (opts.providerId ?? 'openrouter'))
		?? all[0];

	const configuredBase = (config.getValue<string>(def.baseUrlConfigKey) || '').trim();
	const baseUrl = configuredBase || def.defaultBaseUrl;
	const apiKey = (config.getValue<string>(def.apiKeyConfigKey) || '').trim();
	const model = (opts.modelId?.trim())
		|| DEFAULT_MODEL_BY_PROVIDER[def.id]
		|| def.staticModels?.[0]?.id
		|| 'gpt-4o-mini';

	if (!baseUrl) {
		throw new Error(`Knowledge tools: provider "${def.id}" has no base URL configured (set it in Settings).`);
	}

	// 优先使用主进程网络层（IRequestService），绕过 renderer CORS 限制；
	// 降级到 globalThis.fetch（仅当 requestService 不可用时）。
	const fetchImpl: typeof fetch = requestService
		? createMainProcessFetch(requestService)
		: (input, init) => globalThis.fetch(input, init);

	return new OpenAICompatibleJsonModel({
		baseUrl,
		apiKey,
		model,
		timeoutMs: 180_000,
		verboseFallback: true,
		fetchImpl,
	});
}

/**
 * 判断目标 BYOK provider 是否已具备可用的 chat 配置（base URL + API key）。
 *
 * 用于「降级到本地启发式」的前置判定：当未配置任何 API key 时，
 * `resolveChatModel` 仍会构造出一个指向默认 base URL、但 apiKey 为空的模型，
 * 调用 `extract` 时才会触发 3 次 401 网络请求后才降级，既慢又产生噪声日志。
 * 提前用本函数判断，可跳过 LLM 直达关键词/启发式分支。
 */
export function isChatProviderConfigured(config: IConfigurationService, opts: ResolveChatModelOpts = {}): boolean {
	// 若显式指定了 providerId，就只判断该 provider；否则视作「是否存在任一已配置的
	// chat provider」，避免因默认 provider（openrouter/openai）未配 key 而误判为未配置。
	if (opts.providerId) {
		const def = getAllChatProviderDefs(config).find(p => p.id === opts.providerId);
		return !!def && isProviderDefConfigured(config, def);
	}
	return !!resolveConfiguredChatProviderId(config);
}

/**
 * 判断目标 embedding provider 是否已具备可用的 embedding 配置（base URL + API key）。
 *
 * 用于「导入库时是否自动构建语义索引」的前置判定：未配置任何 provider/API key 时，
 * 不应自动调用 `_importFolderRagAsync`（其内部经 `createKbEmbedder` 会抛
 * "KbEmbedder: provider 未配置" 的 WARN/噪声），仅完成目录关联即可。
 * 解析逻辑与 `createKbEmbedder` 保持一致：先按 providerId，再回退到默认 provider。
 */
export function isEmbedderConfigured(config: IConfigurationService, providerId?: string): boolean {
	const adapter = resolveOrFallbackAdapter(config, providerId);
	const effectiveProviderId = adapter?.providerId ?? providerId;
	if (!effectiveProviderId) { return false; }
	return !!resolveEmbeddingConfigForProvider(config, effectiveProviderId);
}

/**
 * Wrap `IAiEmbeddingVectorService` as the engine's `IEmbedder`.
 * The engine only needs embed(texts) → vectors[]; the project's embedding
 * provider supplies the actual vectors.
 *
 * With the built-in BYOK embedding provider (Phase 1), this will work
 * out of the box when the user has configured a model provider in Settings.
 */
export function createEmbedder(svc: IAiEmbeddingVectorService): IEmbedder {
	if (!svc.isEnabled()) {
		throw new Error(
			'Knowledge tools: embedding service is not enabled. ' +
			'Configure a model provider (OpenRouter / custom OpenAI-compatible) in Settings → Agent Studio → Model Providers.',
		);
	}
	return {
		// dimensions 由首次 embed 调用后动态探测
		dimensions: undefined,
		async embed(texts: string[]): Promise<number[][]> {
			const v = await svc.getEmbeddingVector(texts, CancellationToken.None);
			return v as number[][];
		},
		async embedOne(text: string): Promise<number[]> {
			const v = await svc.getEmbeddingVector([text], CancellationToken.None) as number[][];
			return v[0];
		},
	};
}

export type { ILogService };

// ─── AgentOS provider transport（与 Agent Chat 同一管线）─────────────────────

const AGENT_OS_SYSTEM_JSON = 'You are a precise data-extraction assistant. Always respond with valid JSON matching the requested schema and nothing else.';

/**
 * 基于 AgentOS `IModelProvider.chat()` 的 {@link IChatModel} 适配器——与 Agent Chat
 * 完全同一条传输管线：LM 桥接 provider（`lm:<vendor>`）经扩展宿主调用，BYOK provider
 * 用各自的客户端。由此避开「渲染进程直连 fetch 受 CORS 约束」的硬限制（内部网关
 * 如 grnexus 不回 ACAO 头时，OpenAI 兼容直连路径在 preflight 即失败）。
 *
 * 结构化抽取走 instructed-JSON（schema 注入 prompt + 从响应文本解析 JSON），
 * 对任意 provider/model 均可用，无需 json_schema / tool_call 能力探测。
 */
export class AgentOsProviderChatModel implements IChatModel {
	constructor(
		private readonly _provider: IModelProvider,
		private readonly _modelId: string,
		private readonly _agentId?: string,
	) { }

	async complete(system: string | undefined, user: string, temperature = 0.2): Promise<string> {
		const messages = [
			...(system ? [{ role: 'system' as const, content: system }] : []),
			{ role: 'user' as const, content: user },
		];
		let text = '';
		// 注意：system 已内联进 messages；不再经 options.systemPrompt 重复注入，
		// 避免部分 provider（如 Anthropic 系）因连续两条 system 消息报角色交替错误。
		const stream = this._provider.chat(
			this._modelId,
			messages,
			{ temperature },
			this._agentId ? { agentId: this._agentId } : undefined,
		);
		for await (const delta of stream) {
			if (delta.type === 'text' && delta.content) {
				text += delta.content;
			} else if (delta.type === 'error') {
				throw new Error(delta.error || 'model returned an error');
			} else if (delta.type === 'done') {
				break;
			}
		}
		return text;
	}

	async extract<T = Record<string, unknown>>(req: ExtractRequest): Promise<T> {
		const instructed = `${req.prompt}\n\nReturn ONLY a JSON object matching this schema, no prose, no markdown fences:\n${JSON.stringify(req.schema)}`;
		const content = await this.complete(req.system ?? AGENT_OS_SYSTEM_JSON, instructed, req.temperature ?? 0);
		return JSON.parse(stripCodeFence(content)) as T;
	}
}

/**
 * 当 `providerId` 命中已注册的 AgentOS model provider 时，构建
 * {@link AgentOsProviderChatModel}；否则返回 undefined（调用方回退到
 * 旧的 OpenAI 兼容直连路径）。
 */
export function createAgentOsChatModel(
	providers: readonly IModelProvider[],
	opts: { providerId: string; modelId: string; agentId?: string },
): IChatModel | undefined {
	const provider = providers.find(p => p.id === opts.providerId);
	if (!provider || !opts.modelId) { return undefined; }
	return new AgentOsProviderChatModel(provider, opts.modelId, opts.agentId);
}

/**
 * 知识库专属 embedder：使用指定 BYOK provider 的 baseUrl/apiKey（即知识库 agent
 * 当前配置的 provider），模型取传入的 embedding 模型（复用 embedding 设置）。
 *
 * 这与 `createEmbedder`（走全局 IAiEmbeddingVectorService）不同：KB 操作的 embedding
 * 必须跟着知识库 agent 的 provider 走，而非遍历所有 provider 取首个可用。
 */
export function createKbEmbedder(
	config: IConfigurationService,
	logService: ILogService,
	opts: { providerId: string; model: string; dimensions: number },
): IEmbedder {
	const log = (msg: string) => logService.trace(`[KbEmbedder] ${msg}`);

	// Phase 3：经由供应商适配器层验证配置 → 解析 URL/key/model（对标 Hyper-Extract create_embedder）
	const adapter = resolveOrFallbackAdapter(config, opts.providerId);
	const effectiveProviderId = adapter?.providerId ?? opts.providerId;

	const resolved = resolveEmbeddingConfigForProvider(config, effectiveProviderId);
	if (!resolved) {
		// 诊断：列出用户已配置的 provider，给出可操作提示
		const configured = BUILTIN_BYOK_PROVIDERS
			.filter(p => (config.getValue<string>(p.apiKeyConfigKey) || '').trim())
			.map(p => p.id);
		const hint = configured.length
			? `已配置 API key 的 provider: ${configured.join(', ')}。请在 Settings → Agent Studio → Auxiliary Models → Embedding 中选择其中之一。`
			: '暂无已配置 API key 的 provider。请先在 Settings → Agent Studio → Model Providers 中配置 API key 与 base URL。';
		throw new Error(
			`KbEmbedder: provider "${effectiveProviderId}" 未配置。${hint}`
		);
	}

	const baseUrl = resolved.baseUrl;
	const apiKey = resolved.apiKey;
	const model = opts.model?.trim() || resolved.model;
	const dimensions = opts.dimensions || resolved.dimensions;

	return {
		dimensions,
		async embed(texts: string[]): Promise<number[][]> {
			return embedTextsInBatches(baseUrl, apiKey, model, texts, CancellationToken.None, log);
		},
		async embedOne(text: string): Promise<number[]> {
			const v = await embedTextsInBatches(baseUrl, apiKey, model, [text], CancellationToken.None, log);
			return v[0];
		},
	};
}
