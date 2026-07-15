/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  embeddingConfigResolver.ts — 知识库 / RAG embedding 配置的统一解析入口。
 *
 *  设计目标（解除对 knowledge-base-expert agent 的依赖）：
 *   - embedding 的 provider / model / dimensions 全部来自「设置 → 辅助模型 → Embedding」
 *     三个键（AGENT_STUDIO_AUX_EMBEDDING_*），而非 KB agent 的 per-agent 模型选择。
 *   - provider='auto' 时回退到全局 embedding.provider（AGENT_STUDIO_EMBEDDING_PROVIDER）；
 *     仍为空时返回 undefined，交由 EmbeddingService 主路径 / IAiEmbeddingVectorService 自行决策。
 *   - 默认值对齐产品要求：model=text-embedding-3-small，dimensions=512。
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	AGENT_STUDIO_AUX_EMBEDDING_PROVIDER,
	AGENT_STUDIO_AUX_EMBEDDING_MODEL,
	AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS,
	AGENT_STUDIO_EMBEDDING_PROVIDER,
} from '../../common/constants.js';

/** Embedding 默认模型（产品要求）。 */
export const DEFAULT_AUX_EMBEDDING_MODEL = 'text-embedding-3-small';
/** Embedding 默认维度（产品要求）。 */
export const DEFAULT_AUX_EMBEDDING_DIMENSIONS = 512;

export interface IAuxEmbeddingConfig {
	/** 原始 provider 选择（'auto' | 'openrouter' | ...）。 */
	readonly providerId: string;
	/** 向量化模型 id。 */
	readonly modelId: string;
	/** 向量维度。 */
	readonly dimensions: number;
}

/**
 * 读取「辅助模型 → Embedding」配置。永远返回一个可用的配置对象（带默认值）。
 */
export function resolveAuxEmbeddingConfig(config: IConfigurationService): IAuxEmbeddingConfig {
	const provider = (config.getValue<string>(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER) || 'auto').trim() || 'auto';
	const model = (config.getValue<string>(AGENT_STUDIO_AUX_EMBEDDING_MODEL) || '').trim() || DEFAULT_AUX_EMBEDDING_MODEL;
	const rawDim = config.getValue<number>(AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS);
	const dimensions = (typeof rawDim === 'number' && Number.isFinite(rawDim) && rawDim > 0)
		? Math.floor(rawDim)
		: DEFAULT_AUX_EMBEDDING_DIMENSIONS;
	return { providerId: provider, modelId: model, dimensions };
}

/**
 * 解析用于 embedding 的具体 provider id（供 KbVectorIndex / KbNativeKernel / createKbEmbedder 使用）。
 * - 辅助模型显式选择了非 'auto' → 直接返回该 provider。
 * - 'auto' → 回退到全局 embedding.provider；仍为空/为 'auto' → 返回 undefined
 *   （表示交由 EmbeddingService 主路径 / 全局向量服务自行决策）。
 */
export function resolveAuxEmbeddingProviderId(config: IConfigurationService): string | undefined {
	const raw = (config.getValue<string>(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER) || 'auto').trim();
	if (raw && raw !== 'auto') {
		return raw;
	}
	const global = (config.getValue<string>(AGENT_STUDIO_EMBEDDING_PROVIDER) || '').trim();
	if (global && global !== 'auto') {
		return global;
	}
	return undefined;
}
