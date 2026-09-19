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
/** 上次加载失败的原因（供健康度/日志暴露；之前只有一个 console.debug，等于没有信号）。 */
let _pipelineError: string | null = null;

/**
 * 网关注入的模型根目录（`<root>/Xenova/all-MiniLM-L6-v2/...`）。
 *
 * ⚠ **两种入口对路径形态的要求相反**（实测踩到）：
 *   · Node 入口用 `fs` 读文件 ⇒ 必须给**普通路径**（给 `file://` 会报 "file was not found locally"）
 *   · web 入口用 `fetch` 读文件 ⇒ 必须给 **file:// URL**（给裸 `C:/x` 会 "fetch failed"）
 * 所以这里导出两个函数，由调用方按入口选。
 */
function modelDirFs(): string | null {
	const env = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env;
	const dir = env?.['AGENTMEMORY_MODEL_DIR'];
	if (typeof dir === 'string' && dir.length > 0) return dir;
	// 只注入了 file:// URL 时也能反推出普通路径（否则 Node 入口会静默退回包内默认 `models/`）
	const url = env?.['AGENTMEMORY_MODEL_URL'];
	if (typeof url !== 'string' || !url.startsWith('file://')) return null;
	let p = url.replace(/^file:\/\//, '');            // '/C:/Users/x'（Win）| '/home/x'（POSIX）
	if (/^\/[A-Za-z]:/.test(p)) { p = p.slice(1); }   // Win: 去掉多余前导 '/'；POSIX 必须保留
	return decodeURIComponent(p);
}

function modelDirUrl(): string | null {
	const env = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env;
	const url = env?.['AGENTMEMORY_MODEL_URL'];
	if (typeof url === 'string' && url.length > 0) return url.replace(/\/+$/, '');
	const dir = modelDirFs();
	if (!dir) return null;
	const p = dir.replace(/\\/g, '/');
	if (p.startsWith('/')) return 'file://' + p;              // /home/x    ⇒ file:///home/x
	return 'file:///' + p.replace(/^\/+/, '');                // C:/Users/x ⇒ file:///C:/Users/x
}
/** 网关注入的本地 wasm 目录（file URL，结尾带 /）——避免默认去 jsdelivr CDN 取。 */
function resolveWasmDir(): string | null {
	const v = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.['AGENTMEMORY_WASM_DIR'];
	return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * P0-1（2026-09-19）：**改走 web/WASM 构建**，这是本环境让真 embedding 可用的关键。
 *
 * 背景（探针实测）：
 *  · 包默认入口（`package.json.main` = `src/transformers.js`）会 `require('sharp')` —— sharp 是原生
 *    模块且本仓 `node_modules/sharp` **装坏**（`Cannot find module '../build/Release/sharp-win32-x64.node'`）
 *    ⇒ 整个 pipeline 直接抛错、`embed()` 恒返回 null ⇒ 一直是 trigram 伪向量。
 *    而 **sharp 只服务图像输入，文本 embedding 完全不需要它**。
 *  · `dist/transformers.js` 是 web/WASM 构建：不 require sharp，且 `dist/` 内**自带** `ort-wasm-*.wasm`
 *    ⇒ 把 `wasmPaths` 指到本地目录即可，**不需要 CDN/外网**（原实现指向 jsdelivr，离线/内网必失败）。
 *  · web 构建的两个 Node 适配前提：① 需要 `self` 全局（下面补）；② 用 `fetch` 读文件 ⇒
 *    `file://` 需由宿主装 shim（见 `agentmemory-gateway/host/host.mjs` 的 `installFileFetchShim`）。
 *
 * 模型资产**不再运行时下载**（Node fetch 不走系统代理，实测 `fetch failed`），改为预下载到
 * `<AGENTMEMORY_MODEL_DIR>/Xenova/all-MiniLM-L6-v2/` 后离线加载。
 */
async function getPipeline(): Promise<any> {
	if (_pipeline) return _pipeline;
	if (_pipelineUnavailable) return null;  // 短路：之前加载失败
	if (_pipelinePromise) return _pipelinePromise;
	_pipelinePromise = (async () => {
		// **两条入口都试**（本机实测两条各自有一个前置缺口，修好任意一条即可工作）：
		//  ① Node 入口（包默认 main = src/transformers.js）：需要 `sharp` + `onnxruntime-node`
		//     两个原生模块。本仓 `sharp` 装坏（`Cannot find module '../build/Release/sharp-win32-x64.node'`）
		//     ⇒ import 期即抛错。修好 sharp（或装对 prebuilt）这条路就通。
		//  ② web/WASM 入口（dist/transformers.js）：不 require sharp，但它的 webpack bundle **内联了
		//     自己的 onnxruntime-common、却没有内联 onnxruntime-web** ⇒ 运行时 `env.backends.onnx`
		//     永远是空对象（`InferenceSession` undefined）⇒ `constructSession` 报
		//     `Cannot read properties of undefined (reading 'create')`。需要让 ort-web 与该 bundle
		//     同实例（或改用 onnxruntime-node 后端）。
		// 失败原因**合并记录**到 _pipelineError —— 网关进程的 console.debug 不落盘，静默降级等于零信号。
		const specs = [
			['@xenova', 'transformers'].join('/'),
			['@xenova', 'transformers', 'dist', 'transformers.js'].join('/'),
		];
		const errors: string[] = [];
		const g = globalThis as { self?: unknown };
		if (typeof g.self === 'undefined') { g.self = globalThis; }
		for (const spec of specs) {
			try {
				const isWebBundle = spec.includes('dist');
				const mod: any = await import(/* @vite-ignore */ spec);
				const { pipeline, env } = mod;
				const pEnv = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env;
				// 路径形态按入口区分：Node 入口 = fs（普通路径）；web 入口 = fetch（file:// URL）
				const modelPath = isWebBundle ? modelDirUrl() : modelDirFs();
				env.allowLocalModels = true;
				if (modelPath) { env.localModelPath = modelPath; }
				if (isWebBundle) {
					env.allowRemoteModels = false; // web 入口读文件走 fetch，自动下载路径不可靠
				} else {
					// ★ 本地没有则**允许远程自动下载**（2026-09-19 修正：此前记的「Node fetch 不通 / 拉不到 HF」
					//   是误判 —— 本机系统代理 ProxyEnable=0、Node fetch 直连 `hf-mirror.com` 实测 **200** ✓；
					//   那些 `fetch failed` 其实是 **读本地文件**失败（localModelPath 形态不对））。
					// 下载落 cacheDir（与 localModelPath 同一目录）⇒ 下次直接命中，等价于预下载。
					const host = pEnv?.['AGENTMEMORY_MODEL_HOST'];
					env.remoteHost = typeof host === 'string' && host.length > 0 ? host : 'https://hf-mirror.com/';
					env.allowRemoteModels = true;
					if (modelPath) { env.cacheDir = modelPath; }
				}
				env.useBrowserCache = false;
				const wasmDir = resolveWasmDir();
				// wasm 后端只有 web 入口需要（Node 入口走 onnxruntime-node 原生模块）
				if (isWebBundle && wasmDir && env.backends?.onnx?.wasm) {
					env.backends.onnx.wasm.wasmPaths = wasmDir;
					// Node 里没有 Worker/SharedArrayBuffer 语义 ⇒ 必须单线程，否则 wasm 后端起不来
					env.backends.onnx.wasm.numThreads = 1;
					env.backends.onnx.wasm.proxy = false;
				}
				_pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
				return _pipeline;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				errors.push(`${spec}: ${msg.split('\n')[0]}`);
			}
		}
		_pipelineError = errors.join(' | ');
		_pipeline = null;
		_pipelineUnavailable = true;  // 永久标记不可用，避免后续重复尝试
		throw new Error(`embedding unavailable — ${_pipelineError}`);
	})();
	return _pipelinePromise;
}

/** 真 embedding 的可用性诊断（供网关 `[mem-summary]` / 健康检查暴露，替代静默降级）。 */
export function getEmbeddingDiagnostics(): { available: boolean; loading: boolean; error: string | null; modelDir: string | null; wasmDir: string | null } {
	return {
		available: _pipeline !== null,
		loading: _pipelinePromise !== null,
		error: _pipelineError,
		modelDir: modelDirUrl(),
		wasmDir: resolveWasmDir(),
	};
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

	/**
	 * P0-2（2026-09-19）：**缓存恢复专用** —— `importVectors` 直接写入 vectors 表（不重算
	 * embedding，这正是缓存的意义），但 mode 必须随缓存一起恢复：查询向量与库内向量**必须同源**
	 * （trigram 查询去比对 model 库 = 两个语义空间的余弦得分无意义，见本文件顶部 P1-6(b) 说明）。
	 * ⚠ 正常写入路径请用 `addText` / `addModelVector`（它们会自行设置 mode）。
	 */
	setMode(mode: VectorIndexMode): void {
		this._mode = mode;
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
