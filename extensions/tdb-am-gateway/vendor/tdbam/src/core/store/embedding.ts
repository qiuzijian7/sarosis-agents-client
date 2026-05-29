/**
 * Embedding Service — STUB ONLY (sarosis local-first build).
 *
 * 本文件是 sarosis 本地化构建里 EmbeddingService 的"占位定义"。
 * 上游 TDB-AM 在此提供 OpenAI / 自托管 embedding 客户端，sarosis 按 Q7 决策：
 *   - 关闭向量召回，只走 FTS5 + 同义词 + 标签 + LLM 检索器
 *   - 因此真实 embedding 实现已在复制时剔除
 *
 * 本文件保留的目的：
 *   - 满足 8 处 `import type { EmbeddingService }` 的类型导入
 *   - 满足 vendor 内的方法调用面（embed / embedBatch / getDimensions / getProviderInfo / embedQuery）
 *   - 任何运行时调用 NoopEmbeddingService 的方法都会抛出，提示开发者：sarosis 不该走向量路径
 *
 * 未来若要接入第三方 mem 向量插件，可在此处恢复完整实现，并在 factory.ts 启用。
 */

export interface EmbeddingCallOptions {
	/** Optional batch size override. */
	batchSize?: number;
	/** Optional timeout override (ms). */
	timeoutMs?: number;
}

/**
 * Provider 元信息 —— 用于 sqlite.ts 在 init() 时检测 embedding provider/model
 * 是否变更（变更则需要 reindex）。
 *
 * 上游版本可能还包含 baseUrl / apiKey 字段；sarosis 关闭向量后这些都不需要。
 */
export interface EmbeddingProviderInfo {
	provider: string;
	model: string;
	dimensions: number;
}

/**
 * EmbeddingService —— 类型契约。
 * sarosis 本地化构建中没有实例会真正实现这个接口（除 NoopEmbeddingService 外）。
 */
export interface EmbeddingService {
	/** Vector dimensions (used for vec0 schema). 0 = vector path disabled. */
	getDimensions(): number;
	/** Get provider/model metadata for reindex detection. */
	getProviderInfo(): EmbeddingProviderInfo;
	/** Whether the embedding model is loaded and ready to embed. */
	isReady(): boolean;
	/** Trigger model warmup (e.g. download / lazy init). */
	startWarmup(): void;
	/** Embed a single text. Returns one Float32Array vector. */
	embed(text: string, opts?: EmbeddingCallOptions): Promise<Float32Array>;
	/** Embed a batch of texts. Returns one Float32Array per input. */
	embedBatch(texts: string[], opts?: EmbeddingCallOptions): Promise<Float32Array[]>;
	/** Embed a single query (often delegates to embed). */
	embedQuery(text: string, opts?: EmbeddingCallOptions): Promise<Float32Array>;
	/** Release any underlying resources. */
	close?(): Promise<void> | void;
	/** Dimension of produced vectors (read-only mirror of getDimensions). */
	readonly dimensions: number;
}

/**
 * NoopEmbeddingService — 永不就绪的空实现。
 *
 * 用于 factory.ts 在不启用向量路径时占位返回；调用 embed/embedBatch/embedQuery 都会
 * 拒绝执行（这与"关闭向量召回"的 Q7 决策一致）。运行路径里向量分支应该已经被
 * `dimensions=0` / `vecTablesReady=false` / `recallStrategy=keyword` 等守卫提前
 * 短路，理论上 stub 的方法不会被真正触发。
 */
export class NoopEmbeddingService implements EmbeddingService {
	readonly dimensions = 0;

	getDimensions(): number {
		return 0;
	}

	getProviderInfo(): EmbeddingProviderInfo {
		return { provider: "none", model: "noop", dimensions: 0 };
	}

	isReady(): boolean {
		return false;
	}

	startWarmup(): void {
		/* intentionally no-op in sarosis local-first build */
	}

	async embed(_text: string, _opts?: EmbeddingCallOptions): Promise<Float32Array> {
		throw new Error(
			"[memory-tdai][embedding] NoopEmbeddingService.embed() called — vector recall is disabled in sarosis build. " +
			"Use FTS5 / synonym / tag / LLM retriever paths instead.",
		);
	}

	async embedBatch(_texts: string[], _opts?: EmbeddingCallOptions): Promise<Float32Array[]> {
		throw new Error(
			"[memory-tdai][embedding] NoopEmbeddingService.embedBatch() called — vector recall is disabled in sarosis build.",
		);
	}

	async embedQuery(_text: string, _opts?: EmbeddingCallOptions): Promise<Float32Array> {
		throw new Error(
			"[memory-tdai][embedding] NoopEmbeddingService.embedQuery() called — vector recall is disabled in sarosis build.",
		);
	}

	close(): void {
		/* nothing to release */
	}
}

/**
 * createEmbeddingService — STUB.
 *
 * sarosis 本地化构建不真正创建 embedding service。该函数保留以兼容 factory 旧签名，
 * 任何调用都会抛错以暴露"误启用向量路径"的代码缺陷。
 */
export interface EmbeddingServiceConfig {
	provider: string;
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	dimensions?: number;
	maxInputChars?: number;
}

export function createEmbeddingService(
	_config: EmbeddingServiceConfig,
	_logger?: { warn?: (msg: string) => void; debug?: (msg: string) => void },
): EmbeddingService {
	throw new Error(
		"[memory-tdai][embedding] createEmbeddingService() is disabled in sarosis local-first build. " +
		"Vector recall has been removed (Q7=A). To re-enable, restore the upstream embedding.ts " +
		"and update factory.ts accordingly.",
	);
}
