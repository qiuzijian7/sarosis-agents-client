/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  openAIEmbeddingProvider.ts — 方案A 主路径：OpenAI 兼容 embedding provider。
 *
 *  通过配置键驱动密钥（复用现有 BYOK provider 密钥配置），POST `${baseUrl}/embeddings`。
 *  额外支持：
 *  - dimensions 参数（OpenAI text-embedding-3-* 支持降维到 512）。
 *  - override 配置键优先于 fallback（选中的 BYOK provider）配置键，再回退到 defaultBaseUrl。
 *  KnotEmbeddingProvider 继承本类，叠加内部 API 鉴权头，复用同一套 embed 逻辑。
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import {
	IEmbeddingProvider, EmbeddingProviderKind, buildEmbeddingTag,
} from '../../common/embeddingProvider.js';

/** Embedding provider 定义（镜像 builtInBYOKModelProvider 的 IBYOKProviderDefinition 配置键模式）。 */
export interface IEmbeddingProviderDefinition {
	/** provider id，进入 tag 前缀，如 'openai' / 'custom' / 'knot'。 */
	readonly id: string;
	/** 展示名。 */
	readonly name: string;
	readonly kind: EmbeddingProviderKind;
	readonly model: string;
	readonly dimensions: number;
	/** 可选：最高优先级的专属覆盖密钥配置键。 */
	readonly overrideApiKeyConfigKey?: string;
	readonly overrideBaseUrlConfigKey?: string;
	/** 可选：复用现有 BYOK provider 的密钥配置键（方案A 复用现有密钥）。 */
	readonly fallbackApiKeyConfigKey?: string;
	readonly fallbackBaseUrlConfigKey?: string;
	/** 默认 base URL（无配置时使用）。 */
	readonly defaultBaseUrl: string;
	/** embeddings 端点路径（默认 'embeddings'）。 */
	readonly embeddingsPath?: string;
	/** 额外请求头工厂（如 Knot 内部鉴权）。 */
	readonly extraHeaders?: () => Record<string, string>;
}

/** OpenAI 兼容 embedding provider。 */
export class OpenAIEmbeddingProvider extends Disposable implements IEmbeddingProvider {

	readonly id: string;
	readonly kind: EmbeddingProviderKind;
	readonly model: string;
	readonly dimensions: number;
	readonly tag: string;

	private readonly _definition: IEmbeddingProviderDefinition;
	private readonly _configurationService: IConfigurationService;
	private readonly _logService: ILogService;

	constructor(
		definition: IEmbeddingProviderDefinition,
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		super();
		this._definition = definition;
		this.id = definition.id;
		this.kind = definition.kind;
		this.model = definition.model;
		this.dimensions = definition.dimensions;
		this.tag = buildEmbeddingTag(definition.id, definition.model, definition.dimensions);
		this._configurationService = configurationService;
		this._logService = logService;
	}

	isConfigured(): boolean {
		const baseUrl = this._getBaseUrl();
		if (!baseUrl) { return false; }
		// OpenAI 兼容端点通常需要 api key（knot 等内部 API 可能 optional，由 fallback 键决定）。
		const apiKey = this._getApiKey();
		return !!apiKey;
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) { return []; }

		const apiKey = this._getApiKey();
		const baseUrl = this._getBaseUrl();
		if (!baseUrl) {
			throw new Error(`[${this.id}] embedding base URL 未配置`);
		}

		const path = this._definition.embeddingsPath ?? 'embeddings';
		const url = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

		// text-embedding-3-* 支持降维；其它模型忽略此字段也无妨。
		const body: Record<string, unknown> = { model: this.model, input: texts };
		if (this.dimensions > 0) {
			body.dimensions = this.dimensions;
		}

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
			...(this._definition.extraHeaders?.() ?? {}),
		};

		this._logService.info(`[${this.id}] embedding: url=${url}, model=${this.model}, texts=${texts.length}`);
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 60_000);

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (err) {
			throw new Error(`[${this.id}] embedding 请求失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			clearTimeout(timeoutId);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`[${this.id}] embedding HTTP ${response.status}：${text.slice(0, 500)}`);
		}

		const data: any = await response.json();
		const arr: any[] = Array.isArray(data?.data) ? data.data : [];
		if (arr.length !== texts.length) {
			throw new Error(`[${this.id}] embedding 返回数量不匹配：期望 ${texts.length}，实际 ${arr.length}`);
		}
		// 按 index 排序，保证与输入顺序一致
		arr.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		return arr.map(d => {
			const vec = d?.embedding;
			if (!Array.isArray(vec)) {
				throw new Error(`[${this.id}] embedding 返回格式异常：缺少 embedding 字段`);
			}
			return vec as number[];
		});
	}

	// ─── 配置键解析（override > fallback > default） ──────────────────────────

	private _getApiKey(): string {
		const def = this._definition;
		const override = def.overrideApiKeyConfigKey
			? (this._configurationService.getValue<string>(def.overrideApiKeyConfigKey) || '').trim()
			: '';
		if (override) { return override; }
		if (def.fallbackApiKeyConfigKey) {
			return (this._configurationService.getValue<string>(def.fallbackApiKeyConfigKey) || '').trim();
		}
		return '';
	}

	private _getBaseUrl(): string {
		const def = this._definition;
		const override = def.overrideBaseUrlConfigKey
			? (this._configurationService.getValue<string>(def.overrideBaseUrlConfigKey) || '').trim()
			: '';
		if (override) { return override; }
		if (def.fallbackBaseUrlConfigKey) {
			const fallback = (this._configurationService.getValue<string>(def.fallbackBaseUrlConfigKey) || '').trim();
			if (fallback) { return fallback; }
		}
		return def.defaultBaseUrl;
	}
}


