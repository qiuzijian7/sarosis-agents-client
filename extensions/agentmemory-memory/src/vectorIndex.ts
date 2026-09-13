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

export type VectorIndexMode = 'trigram' | 'model';

export class VectorIndex {
	private vectors = new Map<string, Float32Array>();
	private _available = true;
	private _dimension = 0;
	/**
	 * P1-6(b)：向量表征形态。由**写入路径**决定——addText（trigram 同步伪向量）
	 * 置 trigram，addModelVector（外部真语义 embedding）置 model。
	 * 查询向量必须与库的写入形态同源（两种语义空间的余弦得分不可比）。
	 */
	private _mode: VectorIndexMode = 'trigram';
	/**
	 * P2 内存边界：向量索引最多保留的条数。每条 384 维 Float32Array ≈ 1.5KB。
	 * 超过后 FIFO 淘汰最早的向量。可通过环境变量 AGENTMEMORY_VECTOR_MAX_DOCS
	 * 覆盖；构造参数优先级最高（测试用）。
	 *
	 * P1-8（2026-09-09）：默认 1000 → 5000（同 BM25：引擎已迁入网关专用进程，
	 * ext host 4GB cage 约束失效；5000 × 1.5KB ≈ 7.5MB 安全）。淘汰经
	 * evictedCount 暴露，由网关 [mem-summary] 上报。
	 */
	private _maxDocs: number = (() => {
		const raw = (globalThis as any)?.process?.env?.['AGENTMEMORY_VECTOR_MAX_DOCS'];
		const n = raw ? parseInt(raw, 10) : NaN;
		return Number.isFinite(n) && n > 0 ? n : 5000;
	})();
	/** P1-8: 因 _maxDocs 上限被 FIFO 淘汰的向量累计数 */
	private _evictedCount = 0;

	constructor(maxDocs?: number) {
		if (Number.isFinite(maxDocs) && (maxDocs as number) > 0) {
			this._maxDocs = maxDocs as number;
		}
	}

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
				this._evictedCount++;
			}
		}
	}

	/**
	 * 便捷方法：直接用文本添加（内部 trigram 同步 embedding，无需 transformers）。
	 * 用于 gateway 子进程等只需 trigram fallback 的同步场景。查询侧 search()
	 * 按 _mode 分流（trigram 库 → embedSync 查询，两侧语义空间一致）。
	 */
	addText(id: string, text: string): void {
		this._mode = 'trigram';
		const vec = embedSync(text);
		if (vec) { this.add(id, vec); }
	}

	/**
	 * P1-6(b)：写入外部真语义 embedding（embeddingProviders 工厂恢复后使用）。
	 * 与 addText 互斥——混写会导致语义空间不一致。
	 */
	addModelVector(id: string, embedding: Float32Array): void {
		this._mode = 'model';
		this.add(id, embedding);
	}

	remove(id: string): void {
		this.vectors.delete(id);
	}

	async search(query: string, limit = 20): Promise<VectorSearchResult[]> {
		if (this.vectors.size === 0) return [];

		// P1-6(b)：查询向量按库的写入形态分流。旧实现无条件先尝试真模型
		// embedding——若 CDN 恰好可用，真语义查询向量会去对比 trigram 库向量
		//（两个语义空间无关，余弦得分无意义），且白白触发 25MB 模型下载。
		let queryVec: Float32Array | null;
		if (this._mode === 'model') {
			queryVec = await embed(query);
			if (!queryVec) { queryVec = embedSync(query); }
		} else {
			queryVec = embedSync(query);
		}
		if (!queryVec) return [];
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
	/** P1-6(b): 当前向量表征形态（trigram 伪向量 / 真语义 model） */
	get mode(): VectorIndexMode { return this._mode; }
	/** P1-8: 因上限被 FIFO 淘汰的向量累计数（淘汰 = KV 在但检索不可达） */
	get evictedCount(): number { return this._evictedCount; }

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
