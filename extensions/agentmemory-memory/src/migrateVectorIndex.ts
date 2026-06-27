/*---------------------------------------------------------------------------------------------
 *  向量索引迁移 — 当 embedding 模型/维度变化时迁移向量索引。
 *  1:1 复刻 agentmemory src/functions/migrate-vector-index.ts
 *
 *  场景：
 *    v1: 使用 all-MiniLM-L6-v2 (384 维)
 *    v2: 升级到 all-MiniLM-L12-v2 (768 维)
 *    需要重新 embedding 所有条目并迁移索引。
 *--------------------------------------------------------------------------------------------*/

export interface VectorMigrationConfig {
	fromModel: string;
	toModel: string;
	fromDimensions: number;
	toDimensions: number;
	batchSize: number;
}

export interface VectorMigrationResult {
	totalEntries: number;
	migrated: number;
	skipped: number;
	failed: number;
	errors: Array<{ id: string; error: string }>;
	elapsedMs: number;
	fromModel: string;
	toModel: string;
}

export interface MigratableVectorEntry {
	id: string;
	content: string;
	vector?: number[];
	modelName?: string;
	dimensions?: number;
}

export class VectorIndexMigrator {
	/**
	 * 迁移向量索引
	 */
	async migrate(
		entries: MigratableVectorEntry[],
		config: VectorMigrationConfig,
		embedFn: (content: string) => Promise<Float32Array | number[] | null>,
	): Promise<VectorMigrationResult> {
		const startTime = Date.now();
		const errors: Array<{ id: string; error: string }> = [];
		let migrated = 0;
		let skipped = 0;
		let failed = 0;

		for (let i = 0; i < entries.length; i += config.batchSize) {
			const batch = entries.slice(i, i + config.batchSize);

			for (const entry of batch) {
				// 跳过已经是目标模型的
				if (entry.modelName === config.toModel && entry.dimensions === config.toDimensions) {
					skipped++;
					continue;
				}

				try {
					const newVector = await embedFn(entry.content);
					if (newVector) {
						entry.vector = Array.from(newVector);
						entry.modelName = config.toModel;
						entry.dimensions = config.toDimensions;
						migrated++;
					} else {
						failed++;
						errors.push({ id: entry.id, error: 'embedding returned null' });
					}
				} catch (err) {
					failed++;
					errors.push({ id: entry.id, error: err instanceof Error ? err.message : String(err) });
				}
			}

			// 让出事件循环
			await Promise.resolve();
		}

		return {
			totalEntries: entries.length,
			migrated,
			skipped,
			failed,
			errors: errors.slice(0, 100),  // 限制错误数
			elapsedMs: Date.now() - startTime,
			fromModel: config.fromModel,
			toModel: config.toModel,
		};
	}

	/**
	 * 检查迁移需求
	 */
	checkMigrationNeeded(entries: MigratableVectorEntry[], targetModel: string, targetDimensions: number): {
		needed: boolean;
		total: number;
		needsMigration: number;
		alreadyMigrated: number;
		missing: number;
		byModel: Record<string, number>;
	} {
		const byModel: Record<string, number> = {};
		let needsMigration = 0;
		let alreadyMigrated = 0;
		let missing = 0;

		for (const entry of entries) {
			if (!entry.vector || entry.vector.length === 0) {
				missing++;
				continue;
			}
			const model = entry.modelName ?? 'unknown';
			byModel[model] = (byModel[model] ?? 0) + 1;

			if (model === targetModel && entry.dimensions === targetDimensions) {
				alreadyMigrated++;
			} else {
				needsMigration++;
			}
		}

		return {
			needed: needsMigration > 0 || missing > 0,
			total: entries.length,
			needsMigration,
			alreadyMigrated,
			missing,
			byModel,
		};
	}

	/**
	 * 估计迁移耗时
	 */
	estimateDuration(entryCount: number, avgEmbedMs: number = 50): { estimatedMs: number; estimatedMinutes: number } {
		const estimatedMs = entryCount * avgEmbedMs;
		return {
			estimatedMs,
			estimatedMinutes: Math.ceil(estimatedMs / 60000),
		};
	}
}
