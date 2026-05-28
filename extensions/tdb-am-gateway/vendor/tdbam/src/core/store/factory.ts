/**
 * Store Factory — creates the storage backend and (stub) embedding service
 * for sarosis local-first build.
 *
 * sarosis 适配（参见 vendor/tdbam/COPY_MANIFEST.md 第 3 节）：
 *   - Q7=A 关闭向量召回 → 仅保留 SQLite FTS5 路径，移除 TCVDB 与 sqlite-vec
 *   - Q11=A 删除 bm25-local → 不再生成 BM25 sparse vector
 *   - embedding 服务降级为 NoopEmbeddingService，调用即抛错
 *
 * 上游原始实现额外支持：
 *   - "tcvdb" 后端（腾讯云 VectorDB，已剔除）
 *   - createEmbeddingService 实例（OpenAI/自托管 embedding，已剔除）
 *   - createBM25Encoder 实例（已剔除）
 */

import path from "node:path";
import type { MemoryTdaiConfig } from "../../config.js";
import type { IMemoryStore, IEmbeddingService, StoreLogger } from "./types.js";
import { VectorStore } from "./sqlite.js";
import { NoopEmbeddingService } from "./embedding.js";

// Re-export for convenience
export type { IMemoryStore, IEmbeddingService, StoreLogger };

const TAG = "[memory-tdai][factory]";

export interface StoreBundle {
  store: IMemoryStore;
  embedding: IEmbeddingService;
  /** Snapshot of current store config for manifest writing. */
  storeSnapshot: import("../../utils/manifest.js").StoreConfigSnapshot;
}

/**
 * Create the storage backend for sarosis (always SQLite without vector recall).
 *
 * @param config       Fully resolved plugin config.
 * @param options.dataDir    Plugin data directory.
 * @param options.logger     Logger instance.
 */
export function createStoreBundle(
  config: MemoryTdaiConfig,
  options: { dataDir: string; logger?: StoreLogger },
): StoreBundle {
  const { logger } = options;

  // sarosis 本地化构建中 storeBackend 仅支持 "sqlite"。
  // 若 config 指向 "tcvdb"，记录警告并回退（避免运行时崩溃）。
  if (config.storeBackend && config.storeBackend !== "sqlite") {
    logger?.warn?.(
      `${TAG} storeBackend="${config.storeBackend}" is not supported in sarosis build (vector recall disabled). ` +
      `Falling back to "sqlite". See vendor/tdbam/COPY_MANIFEST.md.`,
    );
  }

  // dimensions = 0 表示不启用 vec0 表（FTS5-only 路径）。
  // 即使 config.embedding.dimensions 配了非零值，也强制覆盖为 0 以避免无效的向量列。
  const dims = 0;
  const dbPath = path.join(options.dataDir, "vectors.db");
  const store = new VectorStore(dbPath, dims, logger);

  logger?.debug?.(
    `${TAG} Store created: backend=sqlite (sarosis local-first), dbPath=${dbPath}, ` +
    `dimensions=0 (vector recall disabled), embedding=noop`,
  );

  return {
    store,
    embedding: new NoopEmbeddingService() as unknown as IEmbeddingService,
    storeSnapshot: {
      type: "sqlite",
      sqlitePath: path.relative(options.dataDir, dbPath),
    },
  };
}
