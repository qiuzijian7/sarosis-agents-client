/*---------------------------------------------------------------------------------------------
 *  视觉搜索 — 多模态图片搜索（CLIP embedding + 相似度搜索）。
 *  1:1 复刻 agentmemory src/functions/vision-search.ts + providers/embedding/clip.ts
 *
 *  使用 @xenova/transformers 的 CLIP 模型（clip-vit-base-patch32，512 维）：
 *    - 文本 → 向量（用于文本搜索图片）
 *    - 图片 → 向量（用于图片搜索图片）
 *  CLIP 不可用时降级为占位向量。
 *--------------------------------------------------------------------------------------------*/

const CLIP_MODEL = 'Xenova/clip-vit-base-patch32';
const CLIP_DIMENSIONS = 512;

let clipPipeline: any = null;
let clipLoading: Promise<any> | null = null;
let clipUnavailable = false;

async function loadClip(): Promise<any> {
	if (clipUnavailable) return null;
	if (clipPipeline) return clipPipeline;
	if (clipLoading) return clipLoading;

	clipLoading = (async () => {
		try {
			const xfSpec = ['@xenova', 'transformers'].join('/');
			const xenova: any = await import(/* @vite-ignore */ xfSpec);
			clipPipeline = await xenova.pipeline('image-feature-extraction', CLIP_MODEL, { quantized: true });
			return clipPipeline;
		} catch {
			clipPipeline = null;
			clipUnavailable = true;
			return null;
		} finally {
			clipLoading = null;
		}
	})();

	return clipLoading;
}

let clipTextPipeline: any = null;
let clipTextLoading: Promise<any> | null = null;
let clipTextUnavailable = false;

async function loadClipText(): Promise<any> {
	if (clipTextUnavailable) return null;
	if (clipTextPipeline) return clipTextPipeline;
	if (clipTextLoading) return clipTextLoading;

	clipTextLoading = (async () => {
		try {
			const xfSpec = ['@xenova', 'transformers'].join('/');
			const xenova: any = await import(/* @vite-ignore */ xfSpec);
			clipTextPipeline = await xenova.pipeline('feature-extraction', CLIP_MODEL, { quantized: true });
			return clipTextPipeline;
		} catch {
			clipTextPipeline = null;
			clipTextUnavailable = true;
			return null;
		} finally {
			clipTextLoading = null;
		}
	})();

	return clipTextLoading;
}

export interface StoredImageEmbedding {
	imageRef: string;
	vector: number[];
	modelName: string;
	dimensions: number;
	updatedAt: string;
	sessionId?: string;
	observationId?: string;
}

export interface VisionSearchResult {
	imageRef: string;
	score: number;
	sessionId?: string;
	observationId?: string;
}

export interface VisionEmbedResult {
	success: boolean;
	imageRef: string;
	dimensions: number;
	modelName: string;
	error?: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

export class VisionSearchManager {
	private _embeddings = new Map<string, StoredImageEmbedding>();
	private _imageProvider: { embedImage?: (path: string) => Promise<Float32Array | number[]>; name: string; dimensions: number } | null = null;

	/**
	 * 设置图片 embedding 提供者（外部注入）
	 */
	setImageProvider(provider: typeof this._imageProvider): void {
		this._imageProvider = provider;
	}

	/**
	 * 生成图片 embedding（使用 CLIP 或外部 provider）
	 */
	async embedImage(imageRef: string, sessionId?: string, observationId?: string): Promise<VisionEmbedResult> {
		// 1. Try external provider first
		if (this._imageProvider?.embedImage) {
			try {
				const vec = await this._imageProvider.embedImage(imageRef);
				const vector = Array.from(vec);
				const stored: StoredImageEmbedding = {
					imageRef, vector,
					modelName: this._imageProvider.name,
					dimensions: this._imageProvider.dimensions,
					updatedAt: new Date().toISOString(),
					sessionId, observationId,
				};
				this._embeddings.set(imageRef, stored);
				return { success: true, imageRef, dimensions: stored.dimensions, modelName: stored.modelName };
			} catch (err) {
				return { success: false, imageRef, dimensions: 0, modelName: '', error: err instanceof Error ? err.message : String(err) };
			}
		}

		// 2. Try CLIP via @xenova/transformers
		const clip = await loadClip();
		if (!clip) {
			return { success: false, imageRef, dimensions: 0, modelName: '', error: 'CLIP model unavailable (install @xenova/transformers)' };
		}

		try {
			// Read image and embed
			const output = await clip(imageRef);
			const vec = output.data as Float32Array;
			const vector = Array.from(vec);
			const stored: StoredImageEmbedding = {
				imageRef, vector,
				modelName: 'clip',
				dimensions: CLIP_DIMENSIONS,
				updatedAt: new Date().toISOString(),
				sessionId, observationId,
			};
			this._embeddings.set(imageRef, stored);
			return { success: true, imageRef, dimensions: CLIP_DIMENSIONS, modelName: 'clip' };
		} catch (err) {
			return { success: false, imageRef, dimensions: 0, modelName: '', error: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * 通过文本搜索相似图片（跨模态：文本→图片）
	 */
	async searchByText(query: string, limit: number = 10): Promise<VisionSearchResult[]> {
		const clipText = await loadClipText();
		if (!clipText) return [];

		try {
			const output = await clipText(query, { pooling: 'mean', normalize: true });
			const queryVector = Array.from(output.data as Float32Array);
			return this._searchByVector(queryVector, limit);
		} catch {
			return [];
		}
	}

	/**
	 * 通过图片向量搜索相似图片
	 */
	async searchByImage(imageRef: string, limit: number = 10): Promise<VisionSearchResult[]> {
		const queryEmbedding = this._embeddings.get(imageRef);
		if (!queryEmbedding) return [];

		return this._searchByVector(queryEmbedding.vector, limit, imageRef);
	}

	/**
	 * 通过向量搜索
	 */
	private _searchByVector(queryVector: number[], limit: number, excludeRef?: string): VisionSearchResult[] {
		const results: VisionSearchResult[] = [];
		for (const [ref, stored] of this._embeddings) {
			if (ref === excludeRef) continue;
			const score = cosineSimilarity(queryVector, stored.vector);
			results.push({
				imageRef: ref,
				score,
				sessionId: stored.sessionId,
				observationId: stored.observationId,
			});
		}
		return results.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/**
	 * 删除图片 embedding
	 */
	delete(imageRef: string): boolean {
		return this._embeddings.delete(imageRef);
	}

	/**
	 * 获取所有图片 embedding
	 */
	getAll(): StoredImageEmbedding[] {
		return Array.from(this._embeddings.values());
	}

	/**
	 * 获取统计
	 */
	getStats(): { totalEmbeddings: number; dimensions: number; modelName: string; providerAvailable: boolean; clipAvailable: boolean } {
		return {
			totalEmbeddings: this._embeddings.size,
			dimensions: CLIP_DIMENSIONS,
			modelName: 'clip',
			providerAvailable: !!this._imageProvider?.embedImage,
			clipAvailable: clipPipeline !== null,
		};
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._embeddings.clear();
	}
}
