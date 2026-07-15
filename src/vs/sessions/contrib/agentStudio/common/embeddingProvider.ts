/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  embeddingProvider.ts — RAG 向量化 Provider Layer 接口定义。
 *
 *  设计（对齐用户方案 A 为主 / 方案 C 兜底）：
 *  - IEmbeddingProvider：单一 embed(texts) 抽象，屏蔽 OpenAI / Knot 内部 API / 本地模型的差异。
 *  - EmbeddingService：编排 primary provider（方案A）→ 失败降级 local（方案C），
 *    并自动生成 provider+model+dimension 的 tag（如 "openai/text-embedding-3-small@512"）。
 *  - tag 用于 Phase 3：向量表按 tag 冗余存储，provider/model 切换时只重建 tag 不匹配的 chunk。
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

/** Embedding 提供方类型。 */
export type EmbeddingProviderKind = 'openai' | 'knot' | 'local';

/** 一次 embed 调用产出的结果（向量 + 用于溯源的 tag）。 */
export interface IEmbeddingResult {
	/** 与输入 texts 一一对应的向量（行优先，每行 dim 维）。 */
	vectors: number[][];
	/** 产出这些向量所用的 provider tag，如 "openai/text-embedding-3-small@512"。 */
	tag: string;
	/** 实际使用的 provider id。 */
	providerId: string;
	/** 实际使用的模型名。 */
	model: string;
	/** 向量维度。 */
	dimensions: number;
}

/** 单个 Embedding Provider 抽象（方案A/B/C 各实现一个）。 */
export interface IEmbeddingProvider {
	readonly id: string;
	readonly kind: EmbeddingProviderKind;
	readonly model: string;
	readonly dimensions: number;
	/** 自动生成的 tag：`${id}/${model}@${dim}`。 */
	readonly tag: string;
	/** 当前是否可用（API key 已配置 / 本地模型可加载）。 */
	isConfigured(): boolean;
	/** 批量向量化。实现应自行做超时与错误抛出，交由 EmbeddingService 决策降级。 */
	embed(texts: string[]): Promise<number[][]>;
}

/** EmbeddingService.embed 的可选参数。 */
export interface IEmbeddingOptions {
	/** 强制使用某个 provider（如 'local'），覆盖默认主路径选择。 */
	providerId?: string;
	/** 取消令牌。 */
	token?: CancellationToken;
}

/** Provider 元信息（供 UI / 诊断展示）。 */
export interface IEmbeddingProviderInfo {
	id: string;
	kind: EmbeddingProviderKind;
	model: string;
	dimensions: number;
	tag: string;
	configured: boolean;
}

/** EmbeddingService 健康状态。 */
export interface IEmbeddingStatus {
	activeProviderId: string | undefined;
	tag: string | undefined;
	lastError: string | undefined;
}

// ─── Tag 工具 ────────────────────────────────────────────────────────────────

export const EMBEDDING_TAG_SEPARATOR = '@';

/** 构造 tag：`${providerId}/${model}@${dimensions}`。 */
export function buildEmbeddingTag(providerId: string, model: string, dimensions: number): string {
	return `${providerId}/${model}@${dimensions}`;
}

/** 解析 tag 回 { providerId, model, dimensions }。非法返回 undefined。 */
export function parseEmbeddingTag(tag: string): { providerId: string; model: string; dimensions: number } | undefined {
	if (!tag) { return undefined; }
	const at = tag.lastIndexOf('@');
	if (at < 0) { return undefined; }
	const dims = parseInt(tag.slice(at + 1), 10);
	if (!Number.isFinite(dims) || dims <= 0) { return undefined; }
	const head = tag.slice(0, at);
	const slash = head.indexOf('/');
	if (slash < 0) { return undefined; }
	return {
		providerId: head.slice(0, slash),
		model: head.slice(slash + 1),
		dimensions: dims,
	};
}

// ─── EmbeddingService 装饰器 ───────────────────────────────────────────────────

export const IEmbeddingService = createDecorator<IEmbeddingService>('embeddingService');

export interface IEmbeddingService {
	readonly _serviceBrand: undefined;

	/**
	 * 向量化文本。主路径为配置选中的 provider（方案A）；
	 * 若主路径失败且本地兜底已启用，则透明降级到本地模型（方案C）。
	 * 返回的 tag 标识实际产出所用的 provider/model/dim，供向量表按 tag 增量重建。
	 */
	embed(texts: string[], opts?: IEmbeddingOptions): Promise<IEmbeddingResult>;

	/** 当前会使用的 provider tag（主路径已配置则返回主路径，否则若本地启用则返回 local tag）。 */
	getActiveTag(): string | undefined;

	/**
	 * 返回指定 provider（按需即时构建）的 tag；不传或传空则用当前激活 provider。
	 * 用于让 RAG 向量索引按 KB agent 的 provider 计算 tag（而非主路径 provider）。
	 */
	getTagForProvider(providerId?: string): string | undefined;

	/** 当前激活 provider 的向量维度（用于预分配向量存储）。 */
	getActiveDimensions(): number | undefined;

	/** 列出所有已知 provider 的元信息。 */
	listProviders(): IEmbeddingProviderInfo[];

	/** 当前健康状态（激活 provider / tag / 最近一次错误）。 */
	getStatus(): IEmbeddingStatus;
}
