/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  embeddingService.ts — RAG 向量化编排服务。
 *
 *  主路径（方案A）：按 embedding.provider 选中的 provider 向量化，密钥复用现有 BYOK 配置。
 *  兜底（方案C）：主路径失败且本地已启用时，透明降级到本地 transformers.js 模型。
 *  自动 tag：每次 embed 返回 provider/model/dim 的 tag（如 "openai/text-embedding-3-small@512"），
 *           供未来向量表按 tag 增量重建（Phase 3）。
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IAgentStudioLogService } from '../agentStudioLogService.js';
import {
	IEmbeddingService, IEmbeddingProvider, IEmbeddingResult, IEmbeddingOptions,
	IEmbeddingProviderInfo, IEmbeddingStatus,
} from '../../common/embeddingProvider.js';
import {
	OpenAIEmbeddingProvider, IEmbeddingProviderDefinition,
} from './openAIEmbeddingProvider.js';
import { LocalEmbeddingProvider } from './localEmbeddingProvider.js';

// 再导出接口，便于调用方从单一模块引入 IEmbeddingService + 实现。
export { IEmbeddingService } from '../../common/embeddingProvider.js';

import {
	AGENT_STUDIO_EMBEDDING_PROVIDER, AGENT_STUDIO_EMBEDDING_MODEL, AGENT_STUDIO_EMBEDDING_DIMENSIONS,
	AGENT_STUDIO_EMBEDDING_API_KEY, AGENT_STUDIO_EMBEDDING_BASE_URL,
	AGENT_STUDIO_EMBEDDING_LOCAL_ENABLED, AGENT_STUDIO_EMBEDDING_LOCAL_MODEL,
	AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY, AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL,
	AGENT_STUDIO_PROVIDER_NOUS_API_KEY, AGENT_STUDIO_PROVIDER_NOUS_BASE_URL,
	AGENT_STUDIO_PROVIDER_GEMINI_API_KEY, AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL,
	AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY, AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL,
	AGENT_STUDIO_PROVIDER_MAIN_API_KEY, AGENT_STUDIO_PROVIDER_MAIN_BASE_URL,
	AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY, AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL,
	AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY, AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL,
} from '../../common/constants.js';

/** 现有 BYOK provider 配置键映射（embedding.provider 选中后复用其密钥）。 */
const BYOK_KEY_MAP: Record<string, { apiKey: string; baseUrl: string; defaultBaseUrl: string; optional?: boolean }> = {
	openrouter: { apiKey: AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY, baseUrl: AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL, defaultBaseUrl: 'https://openrouter.ai/api/v1' },
	nous: { apiKey: AGENT_STUDIO_PROVIDER_NOUS_API_KEY, baseUrl: AGENT_STUDIO_PROVIDER_NOUS_BASE_URL, defaultBaseUrl: 'https://api.nous.com/v1' },
	gemini: { apiKey: AGENT_STUDIO_PROVIDER_GEMINI_API_KEY, baseUrl: AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL, defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
	anthropic: { apiKey: AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY, baseUrl: AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL, defaultBaseUrl: 'https://api.anthropic.com' },
	main: { apiKey: AGENT_STUDIO_PROVIDER_MAIN_API_KEY, baseUrl: AGENT_STUDIO_PROVIDER_MAIN_BASE_URL, defaultBaseUrl: '' },
	custom: { apiKey: AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY, baseUrl: AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL, defaultBaseUrl: '' },
	ollama: { apiKey: AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY, baseUrl: AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL, defaultBaseUrl: 'http://localhost:11434', optional: true },
};

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

export class EmbeddingService extends Disposable implements IEmbeddingService {

	readonly _serviceBrand: undefined;

	private _primary: IEmbeddingProvider;
	private readonly _local: LocalEmbeddingProvider;
	/** 按需为指定 BYOK provider 即时构建的 embedding provider 缓存（RAG 用 KB agent 的 provider 时）。 */
	private readonly _byokProviders = new Map<string, IEmbeddingProvider>();
	private _lastError: string | undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IAgentStudioLogService private readonly _agentLogService: ILogService,
	) {
		super();

		const localModel = (this._configurationService.getValue<string>(AGENT_STUDIO_EMBEDDING_LOCAL_MODEL) || '').trim()
			|| DEFAULT_LOCAL_MODEL;
		this._local = new LocalEmbeddingProvider(localModel);
		this._primary = this._buildPrimary();

		// 配置变更时重建主路径 provider（模型/维度/选中 provider 变化都需重建）
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			const keys = [
				AGENT_STUDIO_EMBEDDING_PROVIDER, AGENT_STUDIO_EMBEDDING_MODEL, AGENT_STUDIO_EMBEDDING_DIMENSIONS,
				AGENT_STUDIO_EMBEDDING_API_KEY, AGENT_STUDIO_EMBEDDING_BASE_URL,
				AGENT_STUDIO_EMBEDDING_LOCAL_MODEL,
				...Object.values(BYOK_KEY_MAP).flatMap(k => [k.apiKey, k.baseUrl]),
			];
			if (keys.some(k => e.affectsConfiguration(k))) {
				this._primary = this._buildPrimary();
				this._onDidChange.fire();
			}
		}));
	}

	// ─── IEmbeddingService ─────────────────────────────────────────────────

	async embed(texts: string[], opts?: IEmbeddingOptions): Promise<IEmbeddingResult> {
		const target = opts?.providerId
			? this._resolveById(opts.providerId)
			: this._primary;

		if (!target) {
			throw new Error(`未找到 embedding provider：${opts?.providerId ?? '(primary)'}`);
		}

		try {
			const vectors = await target.embed(texts);
			this._lastError = undefined;
			return {
				vectors,
				tag: target.tag,
				providerId: target.id,
				model: target.model,
				dimensions: target.dimensions,
			};
		} catch (err) {
			const primaryErr = err instanceof Error ? err.message : String(err);

			// 兜底（方案C）：仅当本路径非本地、且本地已启用时降级
			const localEnabled = this._configurationService.getValue<boolean>(AGENT_STUDIO_EMBEDDING_LOCAL_ENABLED);
			if (target.kind !== 'local' && localEnabled && this._local.isConfigured()) {
				this._agentLogService.warn(`[EmbeddingService] 主路径 ${target.id} 失败，降级本地模型：${primaryErr}`);
				try {
					const vectors = await this._local.embed(texts);
					this._lastError = undefined;
					return {
						vectors,
						tag: this._local.tag,
						providerId: 'local',
						model: this._local.model,
						dimensions: this._local.dimensions,
					};
				} catch (e2) {
					this._lastError = `主路径：${primaryErr}；本地兜底：${e2 instanceof Error ? e2.message : String(e2)}`;
					throw new Error(this._lastError);
				}
			}

			this._lastError = primaryErr;
			throw err;
		}
	}

	getActiveTag(): string | undefined {
		if (this._primary.isConfigured()) {
			return this._primary.tag;
		}
		const localEnabled = this._configurationService.getValue<boolean>(AGENT_STUDIO_EMBEDDING_LOCAL_ENABLED);
		if (localEnabled && this._local.isConfigured()) {
			return this._local.tag;
		}
		return undefined;
	}

	getTagForProvider(providerId?: string): string | undefined {
		if (!providerId) {
			return this.getActiveTag();
		}
		const p = this._resolveById(providerId);
		if (p && p.isConfigured()) {
			return p.tag;
		}
		return undefined;
	}

	getActiveDimensions(): number | undefined {
		if (this._primary.isConfigured()) {
			return this._primary.dimensions;
		}
		const localEnabled = this._configurationService.getValue<boolean>(AGENT_STUDIO_EMBEDDING_LOCAL_ENABLED);
		if (localEnabled && this._local.isConfigured()) {
			return this._local.dimensions;
		}
		return undefined;
	}

	listProviders(): IEmbeddingProviderInfo[] {
		const all: IEmbeddingProvider[] = [this._primary];
		if (this._primary.id !== this._local.id) {
			all.push(this._local);
		}
		return all.map(p => ({
			id: p.id,
			kind: p.kind,
			model: p.model,
			dimensions: p.dimensions,
			tag: p.tag,
			configured: p.isConfigured(),
		}));
	}

	getStatus(): IEmbeddingStatus {
		return {
			activeProviderId: this._primary.isConfigured() ? this._primary.id
				: (this._configurationService.getValue<boolean>(AGENT_STUDIO_EMBEDDING_LOCAL_ENABLED) ? 'local' : undefined),
			tag: this.getActiveTag(),
			lastError: this._lastError,
		};
	}

	// ─── 内部：构建主路径 provider ──────────────────────────────────────────

	private _resolveById(id: string): IEmbeddingProvider | undefined {
		if (id === this._local.id) { return this._local; }
		if (id === this._primary.id) { return this._primary; }
		// 按需为指定 BYOK provider 即时构建（RAG 使用 KB agent 的 provider 时）。
		if (BYOK_KEY_MAP[id]) {
			let p = this._byokProviders.get(id);
			if (!p) {
				p = this._buildByokProvider(id);
				this._byokProviders.set(id, p);
			}
			return p;
		}
		return undefined;
	}

	/** 为指定 BYOK provider 即时构建一个 OpenAI 兼容的 embedding provider（模型/维度取 embedding 设置）。 */
	private _buildByokProvider(id: string): IEmbeddingProvider {
		const model = (this._configurationService.getValue<string>(AGENT_STUDIO_EMBEDDING_MODEL) || '').trim()
			|| 'text-embedding-3-small';
		const dimensions = this._configurationService.getValue<number>(AGENT_STUDIO_EMBEDDING_DIMENSIONS) || 512;
		const byok = BYOK_KEY_MAP[id];
		const def: IEmbeddingProviderDefinition = {
			id,
			name: id,
			kind: 'openai',
			model,
			dimensions,
			fallbackApiKeyConfigKey: byok.apiKey,
			fallbackBaseUrlConfigKey: byok.baseUrl,
			defaultBaseUrl: byok.defaultBaseUrl,
		};
		return new OpenAIEmbeddingProvider(def, this._configurationService, this._logService);
	}

	private _buildPrimary(): IEmbeddingProvider {
		const selected = (this._configurationService.getValue<string>(AGENT_STUDIO_EMBEDDING_PROVIDER) || 'openai').trim();
		const model = (this._configurationService.getValue<string>(AGENT_STUDIO_EMBEDDING_MODEL) || '').trim()
			|| 'text-embedding-3-small';
		const dimensions = this._configurationService.getValue<number>(AGENT_STUDIO_EMBEDDING_DIMENSIONS) || 512;

		if (selected === 'local') {
			return this._local;
		}

		const byok = BYOK_KEY_MAP[selected];
		if (byok) {
			// 复用现有 BYOK provider 密钥配置（方案A 复用现有密钥）
			const def: IEmbeddingProviderDefinition = {
				id: selected,
				name: selected,
				kind: 'openai',
				model,
				dimensions,
				fallbackApiKeyConfigKey: byok.apiKey,
				fallbackBaseUrlConfigKey: byok.baseUrl,
				defaultBaseUrl: byok.defaultBaseUrl,
			};
			return new OpenAIEmbeddingProvider(def, this._configurationService, this._logService);
		}

		// 默认：OpenAI 直连，密钥可经 embedding 专属覆盖键配置
		const def: IEmbeddingProviderDefinition = {
			id: 'openai',
			name: 'OpenAI',
			kind: 'openai',
			model,
			dimensions,
			overrideApiKeyConfigKey: AGENT_STUDIO_EMBEDDING_API_KEY,
			overrideBaseUrlConfigKey: AGENT_STUDIO_EMBEDDING_BASE_URL,
			defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
		};
		return new OpenAIEmbeddingProvider(def, this._configurationService, this._logService);
	}
}
