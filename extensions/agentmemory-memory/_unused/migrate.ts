/*---------------------------------------------------------------------------------------------
 *  模式迁移 — 记忆格式版本升级工具。
 *  参考 agentmemory src/functions/migrate.ts
 *
 *  当记忆格式在版本间变化时，需要迁移已有数据。
 *  例如：
 *    v1 → v2: 添加 strength 字段（默认 1.0）
 *    v2 → v3: 添加 concepts 字段（从内容中提取）
 *    v3 → v4: 添加 sourceObservationIds 字段
 *
 *  核心能力：
 *    1. getCurrentVersion() — 获取当前数据版本
 *    2. migrate(targetVersion) — 迁移到目标版本
 *    3. registerMigration(from, to, fn) — 注册迁移函数
 *    4. inferMissingFields(entries) — 推断缺失字段
 *--------------------------------------------------------------------------------------------*/

export interface MigratableEntry {
	id: string;
	type: string;
	content: string;
	timestamp: number;
	strength: number;
	accessCount: number;
	lastAccessedAt: number;
	metadata?: Record<string, unknown>;
	supersededBy?: string;
	_version?: number;  // 数据版本号
}

export interface MigrationResult {
	fromVersion: number;
	toVersion: number;
	migrated: number;
	skipped: number;
	errors: string[];
	dryRun: boolean;
}

type MigrationFn = (entry: MigratableEntry) => MigratableEntry;

const CURRENT_VERSION = 4;

export class MigrationManager {
	private _migrations = new Map<string, MigrationFn>();
	private _registeredVersions = new Set<number>();

	constructor() {
		// 注册内置迁移
		this._registerBuiltins();
	}

	private _registerBuiltins(): void {
		// v0 → v1: 添加 strength 字段
		this.register(0, 1, (entry) => ({
			...entry,
			strength: entry.strength ?? 1.0,
			_version: 1,
		}));

		// v1 → v2: 添加 concepts 字段（从内容中提取）
		this.register(1, 2, (entry) => {
			const concepts = (entry.metadata?.['concepts'] as string[]) ?? this._extractConcepts(entry.content);
			return {
				...entry,
				metadata: {
					...entry.metadata,
					concepts: concepts.length > 0 ? concepts : undefined,
				},
				_version: 2,
			};
		});

		// v2 → v3: 添加 sourceObservationIds
		this.register(2, 3, (entry) => ({
			...entry,
			metadata: {
				...entry.metadata,
				sourceObservationIds: entry.metadata?.['sourceObservationIds'] ?? [entry.id],
			},
			_version: 3,
		}));

		// v3 → v4: 添加 accessTimestamps
		this.register(3, 4, (entry) => {
			const accessTimestamps = (entry.metadata?.['accessTimestamps'] as number[]) ??
				(entry.lastAccessedAt > 0 ? [entry.lastAccessedAt] : []);
			return {
				...entry,
				metadata: {
					...entry.metadata,
					accessTimestamps,
				},
				_version: 4,
			};
		});
	}

	private _extractConcepts(content: string): string[] {
		const concepts = new Set<string>();
		const matches = content.matchAll(/\b(\w{4,})\b/g);
		const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'been', 'were', 'they', 'your', 'what', 'when', 'some', 'more']);
		for (const m of matches) {
			const word = m[1].toLowerCase();
			if (!stopWords.has(word) && word.length <= 20) {
				concepts.add(word);
			}
		}
		return Array.from(concepts).slice(0, 10);
	}

	/**
	 * 注册迁移函数
	 */
	register(fromVersion: number, toVersion: number, fn: MigrationFn): void {
		const key = `${fromVersion}→${toVersion}`;
		this._migrations.set(key, fn);
		this._registeredVersions.add(fromVersion);
		this._registeredVersions.add(toVersion);
	}

	/**
	 * 迁移条目到目标版本
	 */
	migrate(entries: MigratableEntry[], targetVersion: number = CURRENT_VERSION, dryRun: boolean = false): MigrationResult {
		const errors: string[] = [];
		let migrated = 0;
		let skipped = 0;

		for (const entry of entries) {
			let currentVersion = entry._version ?? 0;

			if (currentVersion >= targetVersion) {
				skipped++;
				continue;
			}

			let migratedEntry = { ...entry };

			while (currentVersion < targetVersion) {
				const nextVersion = currentVersion + 1;
				const key = `${currentVersion}→${nextVersion}`;
				const fn = this._migrations.get(key);

				if (!fn) {
					errors.push(`No migration from v${currentVersion} to v${nextVersion} for entry ${entry.id}`);
					break;
				}

				try {
					migratedEntry = fn(migratedEntry);
					currentVersion = nextVersion;
				} catch (err) {
					errors.push(`Migration failed for entry ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
					break;
				}
			}

			if (currentVersion === targetVersion) {
				if (!dryRun) {
					Object.assign(entry, migratedEntry);
				}
				migrated++;
			}
		}

		return {
			fromVersion: entries.length > 0 ? (entries[0]._version ?? 0) : 0,
			toVersion: targetVersion,
			migrated,
			skipped,
			errors,
			dryRun,
		};
	}

	/**
	 * 推断缺失字段
	 */
	inferMissingFields(entries: MigratableEntry[]): {
		inferredStrength: number;
		inferredConcepts: number;
		inferredSourceIds: number;
		inferredAccessTimestamps: number;
	} {
		let inferredStrength = 0;
		let inferredConcepts = 0;
		let inferredSourceIds = 0;
		let inferredAccessTimestamps = 0;

		for (const entry of entries) {
			if (entry.strength === undefined) {
				entry.strength = 1.0;
				inferredStrength++;
			}
			if (!entry.metadata?.['concepts']) {
				entry.metadata = entry.metadata ?? {};
				entry.metadata['concepts'] = this._extractConcepts(entry.content);
				inferredConcepts++;
			}
			if (!entry.metadata?.['sourceObservationIds']) {
				entry.metadata = entry.metadata ?? {};
				entry.metadata['sourceObservationIds'] = [entry.id];
				inferredSourceIds++;
			}
			if (!entry.metadata?.['accessTimestamps'] && entry.lastAccessedAt > 0) {
				entry.metadata = entry.metadata ?? {};
				entry.metadata['accessTimestamps'] = [entry.lastAccessedAt];
				inferredAccessTimestamps++;
			}
		}

		return { inferredStrength, inferredConcepts, inferredSourceIds, inferredAccessTimestamps };
	}

	/**
	 * 获取当前版本
	 */
	getCurrentVersion(): number {
		return CURRENT_VERSION;
	}

	/**
	 * 获取已注册的版本列表
	 */
	getRegisteredVersions(): number[] {
		return Array.from(this._registeredVersions).sort((a, b) => a - b);
	}

	/**
	 * 获取迁移统计
	 */
	getMigrationStats(entries: MigratableEntry[]): {
		total: number;
		byVersion: Record<number, number>;
		needsMigration: number;
		currentVersion: number;
	} {
		const byVersion: Record<number, number> = {};
		let needsMigration = 0;

		for (const entry of entries) {
			const v = entry._version ?? 0;
			byVersion[v] = (byVersion[v] ?? 0) + 1;
			if (v < CURRENT_VERSION) {
				needsMigration++;
			}
		}

		return {
			total: entries.length,
			byVersion,
			needsMigration,
			currentVersion: CURRENT_VERSION,
		};
	}
}
