/*---------------------------------------------------------------------------------------------
 *  CLIP Embedding Provider — 图像+文本多模态嵌入。
 *  1:1 复刻 agentmemory src/providers/embedding/clip.ts
 *
 *  模型: Xenova/clip-vit-base-patch32 (512 维)
 *  依赖: @xenova/transformers（与本地文本嵌入共用）
 *
 *  支持：
 *    - 文本嵌入（feature-extraction pipeline）
 *    - 图像嵌入（image-feature-extraction pipeline）
 *    - data URI 和文件路径两种图像输入
 *--------------------------------------------------------------------------------------------*/

import type { EmbeddingProvider } from './noopProvider.js';

type TransformersModule = {
	pipeline: (task: string, model: string) => Promise<ClipPipeline>;
	RawImage: { fromBlob: (blob: Blob) => Promise<RawImageInstance> };
};

type RawImageInstance = unknown;

type ClipPipeline = (
	input: string[] | RawImageInstance | RawImageInstance[],
	options?: { pooling?: string; normalize?: boolean },
) => Promise<{ tolist: () => number[][]; data: Float32Array }>;

const DEFAULT_MODEL = 'Xenova/clip-vit-base-patch32';
const DIMENSIONS = 512;

function normalize(vec: Float32Array): Float32Array {
	let sum = 0;
	for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
	const norm = Math.sqrt(sum);
	if (norm === 0) return vec;
	const out = new Float32Array(vec.length);
	for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
	return out;
}

async function loadImage(t: TransformersModule, src: string): Promise<RawImageInstance> {
	if (src.startsWith('data:')) {
		const comma = src.indexOf(',');
		const b64 = comma >= 0 ? src.slice(comma + 1) : src;
		const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
		const blob = new Blob([buf]);
		return t.RawImage.fromBlob(blob);
	}
	// 文件路径：在浏览器/sandbox 环境下可能不可用
	const fs = await import('node:fs/promises').catch(() => null);
	if (fs) {
		const data = await fs.readFile(src);
		const blob = new Blob([data]);
		return t.RawImage.fromBlob(blob);
	}
	throw new Error(`Cannot load image from path: ${src} (fs unavailable)`);
}

export class ClipEmbeddingProvider implements EmbeddingProvider {
	readonly name = 'clip';
	readonly dimensions = DIMENSIONS;
	private _textExtractor: ClipPipeline | null = null;
	private _imageExtractor: ClipPipeline | null = null;
	private _transformers: TransformersModule | null = null;
	private readonly _modelId: string;

	constructor(modelId: string = DEFAULT_MODEL) {
		this._modelId = modelId;
	}

	async embed(text: string): Promise<Float32Array | number[] | null> {
		const [vec] = await this.embedBatch([text]);
		return vec;
	}

	async embedBatch(texts: string[]): Promise<Float32Array[]> {
		const extractor = await this._getTextExtractor();
		const output = await extractor(texts, { pooling: 'mean', normalize: true });
		return output.tolist().map(v => new Float32Array(v));
	}

	async embedImage(src: string): Promise<Float32Array> {
		const t = await this._getTransformers();
		const image = await loadImage(t, src);
		const extractor = await this._getImageExtractor();
		const output = await extractor(image);
		const vec = output.data ?? new Float32Array(output.tolist()[0] || []);
		return normalize(vec);
	}

	private async _getTransformers(): Promise<TransformersModule> {
		if (this._transformers) return this._transformers;
		try {
			this._transformers = (await import('@xenova/transformers')) as unknown as TransformersModule;
		} catch {
			throw new Error('Install @xenova/transformers for CLIP image embeddings: npm install @xenova/transformers');
		}
		return this._transformers;
	}

	private async _getTextExtractor(): Promise<ClipPipeline> {
		if (this._textExtractor) return this._textExtractor;
		const t = await this._getTransformers();
		this._textExtractor = await t.pipeline('feature-extraction', this._modelId);
		return this._textExtractor;
	}

	private async _getImageExtractor(): Promise<ClipPipeline> {
		if (this._imageExtractor) return this._imageExtractor;
		const t = await this._getTransformers();
		this._imageExtractor = await t.pipeline('image-feature-extraction', this._modelId);
		return this._imageExtractor;
	}
}
