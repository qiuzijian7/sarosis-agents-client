/*---------------------------------------------------------------------------------------------
 *  向量索引 — 基于 @xenova/transformers 的本地语义检索。
 *  参考 agentmemory src/state/vector-index.ts
 *
 *  embedding: all-MiniLM-L6-v2 (384 维, WASM 实现, 离线免费)
 *  首次使用时自动下载 ONNX 模型 (~25MB), 之后完全离线
 *--------------------------------------------------------------------------------------------*/

export interface VectorSearchResult {
	id: string;
	score: number;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

// 懒加载 transformers.js pipeline (避免未使用时加载 ONNX runtime)
let _pipeline: any = null;
let _pipelinePromise: Promise<any> | null = null;
let _pipelineUnavailable = false;  // 永久标记加载失败，避免无限重试

async function getPipeline(): Promise<any> {
	if (_pipeline) return _pipeline;
	if (_pipelineUnavailable) return null;  // 短路：之前加载失败
	if (_pipelinePromise) return _pipelinePromise;
	_pipelinePromise = (async () => {
		try {
			const xfSpec = ['@xenova', 'transformers'].join('/');
			const mod = await import(/* @vite-ignore */ xfSpec);
			const { pipeline, env } = mod;
			// 允许从远程加载模型 (首次使用)
			env.allowRemoteModels = true;
			env.allowLocalModels = false;
			// 配置 ONNX WASM 文件路径（从 CDN 加载，避免本地文件访问问题）
			const envAny = env as any;
			if (envAny.backends?.onnx?.wasm) {
				envAny.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.1/dist/';
			}
			_pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
			return _pipeline;
		} catch (err) {
			// @xenova/transformers is an optional dependency — not installed is normal.
			// Log once at debug level (not warn) to avoid console noise on every session start.
			// The trigram fallback (embedSync) provides adequate vector search without it.
			console.debug('[AgentMemory] @xenova/transformers not available — using trigram fallback for vector search');
			_pipeline = null;
			_pipelineUnavailable = true;  // 永久标记不可用，避免后续重复尝试
			throw err;
		} finally {
			_pipelinePromise = null;
		}
	})();
	return _pipelinePromise;
}

export async function embed(text: string): Promise<Float32Array | null> {
	try {
		const extractor = await getPipeline();
		if (!extractor) return null;
		const output = await extractor(text, { pooling: 'mean', normalize: true });
		return new Float32Array(output.data);
	} catch {
		return null;
	}
}

export function embedSync(text: string): Float32Array | null {
	// 简易 fallback: 基于字符 n-gram 的伪向量 (仅在 embedding 不可用时使用)
	// 不如真正的 embedding, 但比纯子串匹配好
	const vec = new Float32Array(384);
	const normalized = text.toLowerCase();
	for (let i = 0; i < normalized.length - 2; i++) {
		const trigram = normalized.charCodeAt(i) + normalized.charCodeAt(i + 1) * 31 + normalized.charCodeAt(i + 2) * 961;
		vec[trigram % 384] += 1;
	}
	// 归一化
	let norm = 0;
	for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];
	norm = Math.sqrt(norm);
	if (norm > 0) {
		for (let i = 0; i < 384; i++) vec[i] /= norm;
	}
	return vec;
}

export class VectorIndex {
	private vectors = new Map<string, Float32Array>();
	private _available = true;
	private _dimension = 0;
	/**
	 * P2 内存边界：向量索引最多保留的条数。每条 384 维 Float32Array ≈ 1.5KB，
	 * 无上限时全量常驻会撞 ext host 4GB cage。超过后 FIFO 淘汰最早的向量。
	 * 可通过环境变量 AGENTMEMORY_VECTOR_MAX_DOCS 覆盖。
	 *
	 * 默认 1000（1000 × 1.5KB ≈ 1.5MB，是 ext host 里安全的常驻上限）。
	 */
	private readonly _maxDocs: number = (() => {
		const raw = (globalThis as any)?.process?.env?.['AGENTMEMORY_VECTOR_MAX_DOCS'];
		const n = raw ? parseInt(raw, 10) : NaN;
		return Number.isFinite(n) && n > 0 ? n : 1000;
	})();

	add(id: string, embedding: Float32Array): void {
		// 重新插入以更新 FIFO 顺序
		if (this.vectors.has(id)) { this.vectors.delete(id); }
		this.vectors.set(id, embedding);
		if (this._dimension === 0 && embedding.length > 0) {
			this._dimension = embedding.length;
		}
		// P2: 超出上限时 FIFO 淘汰
		if (this._maxDocs > 0) {
			while (this.vectors.size > this._maxDocs) {
				const oldest = this.vectors.keys().next().value as string | undefined;
				if (oldest === undefined) { break; }
				this.vectors.delete(oldest);
			}
		}
	}

	remove(id: string): void {
		this.vectors.delete(id);
	}

	async search(query: string, limit = 20): Promise<VectorSearchResult[]> {
		if (this.vectors.size === 0) return [];

		const queryVec = await embed(query);
		if (!queryVec) {
			// Fallback to sync embedding
			const syncVec = embedSync(query);
			if (!syncVec) return [];
			return this._searchWithVec(syncVec, limit);
		}
		return this._searchWithVec(queryVec, limit);
	}

	private _searchWithVec(queryVec: Float32Array, limit: number): VectorSearchResult[] {
		const results: VectorSearchResult[] = [];
		for (const [id, vec] of this.vectors) {
			const score = cosineSimilarity(queryVec, vec);
			results.push({ id, score });
		}
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, limit);
	}

	get size(): number { return this.vectors.size; }
	get available(): boolean { return this._available; }
	get dimension(): number { return this._dimension; }

	clear(): void {
		this.vectors.clear();
		this._dimension = 0;
	}

	// ─── P3-1: Vector persistence ───────────────────────────────────────

	/**
	 * Export all vectors as serializable data (for disk persistence).
	 * Returns an array of { id, vector } where vector is a regular number[]
	 * (JSON-serializable, unlike Float32Array).
	 */
	exportVectors(): Array<{ id: string; vector: number[] }> {
		const result: Array<{ id: string; vector: number[] }> = [];
		for (const [id, vec] of this.vectors) {
			result.push({ id, vector: Array.from(vec) });
		}
		return result;
	}

	/**
	 * Import vectors from serialized data (restored from disk).
	 * Skips entries that already exist (does not overwrite).
	 */
	importVectors(data: Array<{ id: string; vector: number[] }>): number {
		let imported = 0;
		for (const entry of data) {
			if (this.vectors.has(entry.id)) continue;
			const vec = new Float32Array(entry.vector);
			this.vectors.set(entry.id, vec);
			if (this._dimension === 0 && vec.length > 0) {
				this._dimension = vec.length;
			}
			imported++;
		}
		return imported;
	}

	/**
	 * Export as JSON string (for direct disk I/O).
	 */
	serialize(): string {
		return JSON.stringify({
			v: 2,
			size: this.vectors.size,
			dimensions: this._dimension || 384,
			vectors: this.exportVectors(),
			savedAt: Date.now(),
		});
	}

	/**
	 * Import from JSON string (loaded from disk).
	 * Returns the number of vectors imported.
	 * Supports v1 (no dimension check) and v2 (with dimension metadata).
	 */
	deserialize(json: string): number {
		try {
			const parsed = JSON.parse(json) as { v: number; dimensions?: number; vectors: Array<{ id: string; vector: number[] }> };
			if (!Array.isArray(parsed.vectors)) return 0;
			// v2+: validate dimension if metadata present
			if (parsed.v >= 2 && typeof parsed.dimensions === 'number' && parsed.dimensions > 0) {
				const storedDim = parsed.dimensions;
				if (this._dimension > 0 && this._dimension !== storedDim) {
					// Dimension mismatch — refuse to load (caller should rebuild)
					return 0;
				}
			}
			return this.importVectors(parsed.vectors);
		} catch {
			return 0;
		}
	}
}
