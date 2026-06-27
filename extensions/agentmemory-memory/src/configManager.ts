/*---------------------------------------------------------------------------------------------
 *  统一配置管理 — 集中管理所有模块的配置。
 *
 *  解决问题：各模块独立管理配置（RetentionScorer、QuotaManager、RateLimiter 等），
 *  缺乏统一入口。ConfigManager 提供：
 *    1. 集中存储所有配置
 *    2. 热重载（运行时修改不需重启）
 *    3. 配置验证
 *    4. 配置版本化
 *    5. 配置导入/导出
 *--------------------------------------------------------------------------------------------*/

export interface MemorySystemConfig {
	version: string;
	decay: {
		lambda: number;
		sigma: number;
		tierThresholds: { hot: number; warm: number; cold: number };
	};
	ebbinghaus: {
		decayDays: number;
		decayFactor: number;
		minStrength: number;
		strengthFloor: number;
	};
	quota: {
		maxMemoriesPerAgent: number;
		maxShortTermPerAgent: number;
		maxTokenBudget: number;
		maxImageStorageBytes: number;
		maxSessionsPerAgent: number;
		policy: 'reject' | 'evict' | 'warn';
	};
	rateLimit: {
		writeCapacity: number;
		writeRefillRate: number;
		searchCapacity: number;
		searchRefillRate: number;
	};
	search: {
		rrfK: number;
		bm25Weight: number;
		vectorWeight: number;
		graphWeight: number;
		textWeight: number;
		maxPerSession: number;
	};
	persistence: {
		flushDelayMs: number;
		shortTermLimit: number;
		maxLongTermEntries: number;
		sweepIntervalMs: number;
	};
	embedding: {
		model: string;
		dimensions: number;
		lazyLoad: boolean;
		fallbackToTrigram: boolean;
	};
	hooks: {
		enabled: boolean;
		injectContext: boolean;
	};
	health: {
		monitoringIntervalMs: number;
		autoResolveAlerts: boolean;
	};
}

const DEFAULT_CONFIG: MemorySystemConfig = {
	version: '1.0.0',
	decay: { lambda: 0.01, sigma: 0.3, tierThresholds: { hot: 0.7, warm: 0.4, cold: 0.15 } },
	ebbinghaus: { decayDays: 30, decayFactor: 0.9, minStrength: 0.1, strengthFloor: 0.15 },
	quota: {
		maxMemoriesPerAgent: 5000, maxShortTermPerAgent: 200, maxTokenBudget: 4000,
		maxImageStorageBytes: 104857600, maxSessionsPerAgent: 5, policy: 'warn',
	},
	rateLimit: { writeCapacity: 10, writeRefillRate: 5, searchCapacity: 20, searchRefillRate: 10 },
	search: { rrfK: 60, bm25Weight: 0.35, vectorWeight: 0.40, graphWeight: 0.15, textWeight: 0.10, maxPerSession: 3 },
	persistence: { flushDelayMs: 5000, shortTermLimit: 200, maxLongTermEntries: 5000, sweepIntervalMs: 21600000 },
	embedding: { model: 'all-MiniLM-L6-v2', dimensions: 384, lazyLoad: true, fallbackToTrigram: true },
	hooks: { enabled: true, injectContext: false },
	health: { monitoringIntervalMs: 60000, autoResolveAlerts: true },
};

export interface ConfigChangeRecord {
	timestamp: number;
	path: string;          // e.g. 'decay.lambda'
	oldValue: unknown;
	newValue: unknown;
}

type ConfigChangeHandler = (config: MemorySystemConfig, changes: ConfigChangeRecord[]) => void;

export class ConfigManager {
	private _config: MemorySystemConfig;
	private _changeHistory: ConfigChangeRecord[] = [];
	private _handlers = new Set<ConfigChangeHandler>();
	private _maxHistory = 200;
	// Cached frozen copy — avoids expensive JSON.parse(JSON.stringify) on every get()/getSection() call
	private _cachedClone: MemorySystemConfig | null = null;

	constructor(config?: Partial<MemorySystemConfig>) {
		this._config = this._merge(DEFAULT_CONFIG, config ?? {});
	}

	/**
	 * 获取配置（返回缓存的冻结副本，仅在配置变更时重新克隆）
	 */
	get(): MemorySystemConfig {
		if (this._cachedClone) return this._cachedClone;
		this._cachedClone = this._deepClone(this._config);
		return this._cachedClone;
	}

	/**
	 * 获取配置片段（从缓存副本读取，避免重复深拷贝）
	 */
	getSection<K extends keyof MemorySystemConfig>(key: K): MemorySystemConfig[K] {
		return this.get()[key];
	}

	/**
	 * 设置配置（深层路径）
	 */
	set(path: string, value: unknown): { success: boolean; error?: string } {
		const validation = this._validate(path, value);
		if (!validation.success) return validation;

		const oldValue = this._getNested(this._config, path);
		this._setNested(this._config, path, value);
		this._cachedClone = null; // Invalidate cache on change

		this._changeHistory.push({
			timestamp: Date.now(),
			path,
			oldValue,
			newValue: value,
		});
		if (this._changeHistory.length > this._maxHistory) {
			this._changeHistory.shift();
		}

		this._notifyHandlers([{ timestamp: Date.now(), path, oldValue, newValue: value }]);

		return { success: true };
	}

	/**
	 * 批量更新
	 */
	update(updates: Record<string, unknown>): { success: boolean; errors: string[] } {
		const errors: string[] = [];
		const changes: ConfigChangeRecord[] = [];

		for (const [path, value] of Object.entries(updates)) {
			const validation = this._validate(path, value);
			if (!validation.success) {
				errors.push(`${path}: ${validation.error}`);
				continue;
			}
			const oldValue = this._getNested(this._config, path);
			this._setNested(this._config, path, value);
			changes.push({ timestamp: Date.now(), path, oldValue, newValue: value });
		}

		if (changes.length > 0) {
			this._cachedClone = null; // Invalidate cache on change
			this._changeHistory.push(...changes);
			if (this._changeHistory.length > this._maxHistory) {
				this._changeHistory = this._changeHistory.slice(-this._maxHistory);
			}
			this._notifyHandlers(changes);
		}

		return { success: errors.length === 0, errors };
	}

	/**
	 * 重置为默认值
	 */
	reset(): void {
		const changes: ConfigChangeRecord[] = [];
		for (const key of Object.keys(this._config) as Array<keyof MemorySystemConfig>) {
			changes.push({
				timestamp: Date.now(),
				path: key,
				oldValue: JSON.parse(JSON.stringify(this._config[key])),
				newValue: JSON.parse(JSON.stringify(DEFAULT_CONFIG[key])),
			});
		}
		this._config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
		this._cachedClone = null;
		this._notifyHandlers(changes);
	}

	/**
	 * 订阅配置变更
	 */
	onChange(handler: ConfigChangeHandler): () => void {
		this._handlers.add(handler);
		return () => this._handlers.delete(handler);
	}

	/**
	 * 获取变更历史
	 */
	getChangeHistory(limit: number = 50): ConfigChangeRecord[] {
		return this._changeHistory.slice(-limit).reverse();
	}

	/**
	 * 导出配置
	 */
	export(): string {
		return JSON.stringify(this._config, null, 2);
	}

	/**
	 * 导入配置
	 */
	import(json: string): { success: boolean; error?: string } {
		try {
			const parsed = JSON.parse(json);
			this._config = this._merge(DEFAULT_CONFIG, parsed);
			this._cachedClone = null;
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	// ─── Private ─────────────────────────────────────────────────────────────

	/**
	 * Deep clone using structuredClone (available in Node.js 17+) — much faster than
	 * JSON.parse(JSON.stringify()) for nested objects without functions/circular refs.
	 */
	private _deepClone<T>(obj: T): T {
		if (typeof structuredClone === 'function') {
			try { return structuredClone(obj); } catch { /* fallback below */ }
		}
		return JSON.parse(JSON.stringify(obj));
	}

	private _validate(path: string, value: unknown): { success: boolean; error?: string } {
		if (!path || typeof path !== 'string') {
			return { success: false, error: 'path must be a non-empty string' };
		}
		const parts = path.split('.');
		if (parts.length === 0) return { success: false, error: 'invalid path' };

		// 数值范围验证
		if (typeof value === 'number') {
			if (path.includes('lambda') && value <= 0) return { success: false, error: 'lambda must be positive' };
			if (path.includes('weight') && (value < 0 || value > 1)) return { success: false, error: 'weight must be 0-1' };
			if (path.includes('refillRate') && value <= 0) return { success: false, error: 'refillRate must be positive' };
			if (path.includes('capacity') && value < 1) return { success: false, error: 'capacity must be >= 1' };
		}

		return { success: true };
	}

	private _getNested(obj: unknown, path: string): unknown {
		return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
	}

	private _setNested(obj: unknown, path: string, value: unknown): void {
		const parts = path.split('.');
		let current = obj as Record<string, unknown>;
		for (let i = 0; i < parts.length - 1; i++) {
			if (current[parts[i]] === undefined || current[parts[i]] === null) {
				current[parts[i]] = {};
			}
			current = current[parts[i]] as Record<string, unknown>;
		}
		current[parts[parts.length - 1]] = value;
	}

	private _merge<T>(base: T, override: Partial<T>): T {
		const result = JSON.parse(JSON.stringify(base));
		for (const key of Object.keys(override) as Array<keyof T>) {
			const val = override[key];
			if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
				result[key] = this._merge(result[key] ?? {}, val);
			} else if (val !== undefined) {
				result[key] = val;
			}
		}
		return result;
	}

	private _notifyHandlers(changes: ConfigChangeRecord[]): void {
		for (const handler of this._handlers) {
			try {
				handler(this._config, changes);
			} catch (err) {
				console.warn('[ConfigManager] handler failed:', err);
			}
		}
	}
}
