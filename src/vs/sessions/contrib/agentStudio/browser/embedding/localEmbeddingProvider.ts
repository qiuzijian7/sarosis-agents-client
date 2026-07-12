/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  localEmbeddingProvider.ts — 方案C 兜底：本地 transformers.js embedding。
 *
 *  仅在用户明确启用离线（embedding.local.enabled）或 API 主路径失败且本地已启用时，
 *  由 EmbeddingService 调用。使用 AMD 模块加载器惰性加载 @xenova/transformers，
 *  避免在未安装/未启用时污染主路径 bundle。
 *
 *  注意：transformers.js 体积较大，需作为 node 模块存在于运行环境；若加载失败，
 *  embed() 会抛出明确错误，由 EmbeddingService 上报并（若主路径可用）提示用户。
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { importAMDNodeModule } from '../../../../../amdX.js';
import {
	IEmbeddingProvider, EmbeddingProviderKind, buildEmbeddingTag,
} from '../../common/embeddingProvider.js';

/** 已知本地模型默认维度（用于未显式配置时兜底）。 */
const KNOWN_LOCAL_MODEL_DIMS: Record<string, number> = {
	'Xenova/all-MiniLM-L6-v2': 384,
	'Xenova/paraphrase-multilingual-MiniLM-L12-v2': 384,
	'Xenova/all-MiniLM-L12-v2': 384,
};

export class LocalEmbeddingProvider extends Disposable implements IEmbeddingProvider {

	readonly id = 'local';
	readonly kind: EmbeddingProviderKind = 'local';
	readonly model: string;
	readonly dimensions: number;
	readonly tag: string;

	private _modelPromise: Promise<any> | undefined;

	constructor(model: string = 'Xenova/all-MiniLM-L6-v2') {
		super();
		this.model = model;
		this.dimensions = KNOWN_LOCAL_MODEL_DIMS[model] ?? 384;
		this.tag = buildEmbeddingTag('local', model, this.dimensions);
	}

	/** 本地模型始终“可配置”（是否真正可用取决于运行时能否加载）。 */
	isConfigured(): boolean {
		return true;
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) { return []; }
		const extractor = await this._ensureModel();
		const output: any = await extractor(texts, { pooling: 'mean', normalize: true });
		return this._reshape(output, texts.length);
	}

	// ─── 内部 ───────────────────────────────────────────────────────────────

	private async _ensureModel(): Promise<any> {
		if (!this._modelPromise) {
			this._modelPromise = (async () => {
				let mod: any;
				try {
					mod = await importAMDNodeModule<any>('@xenova/transformers', 'dist/transformers.js');
				} catch (err) {
					throw new Error(
						`本地 embedding 模型加载失败（@xenova/transformers 未安装/不可用）：` +
						`${err instanceof Error ? err.message : String(err)}`
					);
				}
				const pipeline = mod?.pipeline;
				if (typeof pipeline !== 'function') {
					throw new Error('@xenova/transformers 未导出 pipeline()，本地 embedding 不可用');
				}
				return pipeline('feature-extraction', this.model);
			})();
		}
		return this._modelPromise;
	}

	private _reshape(output: any, count: number): number[][] {
		// transformers.js 返回 Tensor：.data (Float32Array) + .dims ([N, dim])
		const data: Float32Array | number[] = output?.data ?? output?.tensor?.data;
		const dims: number[] = output?.dims ?? [count, this.dimensions];
		if (!data) {
			throw new Error('本地 embedding 输出缺少 data 字段');
		}
		const dim = dims[dims.length - 1];
		const flat = Array.isArray(data) ? data : Array.from(data as Float32Array);
		const vectors: number[][] = [];
		for (let i = 0; i < count; i++) {
			vectors.push(flat.slice(i * dim, (i + 1) * dim));
		}
		return vectors;
	}
}
