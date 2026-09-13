/*---------------------------------------------------------------------------------------------
 *  降级链 — 按优先级依次尝试多个提供者，直到成功。
 *  参考 agentmemory src/providers/fallback-chain.ts
 *
 *  与现有 Dual Provider 架构的区别：
 *    - Dual Provider：静态优先级（AgentMemory > SessionMemory > TdbAm）
 *    - FallbackChain：动态降级（try A → fail → try B → fail → try C）
 *
 *  核心场景：
 *    1. Embedding 降级：@xenova/transformers → trigram → random
 *    2. 搜索降级：hybrid(BM25+Vector+Graph) → BM25-only → substring-only
 *    3. 持久化降级：file server → memory-only → localStorage
 *
 *  与 CircuitBreaker 配合：
 *    每个提供者前可加熔断器，熔断时自动跳到下一个
 *--------------------------------------------------------------------------------------------*/

export interface FallbackProvider<T = unknown> {
	name: string;
	priority: number;          // 数字越小优先级越高
	available: boolean;         // 是否可用
	execute: () => Promise<T>;
}

export interface FallbackResult<T> {
	success: boolean;
	result?: T;
	providerUsed?: string;
	errors: Array<{ provider: string; error: string }>;
	fallbackChain: string[];
}

export class FallbackChain<T = unknown> {
	private _providers: FallbackProvider<T>[] = [];

	/**
	 * 添加提供者
	 */
	add(provider: FallbackProvider<T>): this {
		this._providers.push(provider);
		this._providers.sort((a, b) => a.priority - b.priority);
		return this;
	}

	/**
	 * 执行降级链
	 */
	async execute(): Promise<FallbackResult<T>> {
		const errors: Array<{ provider: string; error: string }> = [];
		const fallbackChain: string[] = [];

		for (const provider of this._providers) {
			if (!provider.available) {
				fallbackChain.push(`${provider.name} (unavailable)`);
				continue;
			}

			fallbackChain.push(provider.name);

			try {
				const result = await provider.execute();
				return {
					success: true,
					result,
					providerUsed: provider.name,
					errors,
					fallbackChain,
				};
			} catch (err) {
				errors.push({
					provider: provider.name,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return {
			success: false,
			errors,
			fallbackChain,
		};
	}

	/**
	 * 获取提供者列表
	 */
	getProviders(): Array<{ name: string; priority: number; available: boolean }> {
		return this._providers.map(p => ({
			name: p.name,
			priority: p.priority,
			available: p.available,
		}));
	}

	/**
	 * 设置提供者可用性
	 */
	setAvailable(name: string, available: boolean): boolean {
		const provider = this._providers.find(p => p.name === name);
		if (provider) {
			provider.available = available;
			return true;
		}
		return false;
	}

	/**
	 * 清除所有提供者
	 */
	clear(): void {
		this._providers = [];
	}
}

/**
 * 带熔断器的降级链
 */
export class CircuitProtectedFallbackChain<T = unknown> {
	private _chain = new FallbackChain<T>();
	private _circuitCheck?: (name: string) => boolean;
	private _circuitSuccess?: (name: string) => void;
	private _circuitFailure?: (name: string) => void;

	constructor(opts?: {
		circuitCheck?: (name: string) => boolean;
		circuitSuccess?: (name: string) => void;
		circuitFailure?: (name: string) => void;
	}) {
		this._circuitCheck = opts?.circuitCheck;
		this._circuitSuccess = opts?.circuitSuccess;
		this._circuitFailure = opts?.circuitFailure;
	}

	add(provider: FallbackProvider<T>): this {
		// Wrap with circuit breaker check
		const originalExecute = provider.execute;
		const name = provider.name;
		const circuitCheck = this._circuitCheck;
		const circuitSuccess = this._circuitSuccess;
		const circuitFailure = this._circuitFailure;

		provider.execute = async () => {
			if (circuitCheck && !circuitCheck(name)) {
				throw new Error(`Circuit breaker open for ${name}`);
			}
			try {
				const result = await originalExecute();
				circuitSuccess?.(name);
				return result;
			} catch (err) {
				circuitFailure?.(name);
				throw err;
			}
		};

		this._chain.add(provider);
		return this;
	}

	async execute(): Promise<FallbackResult<T>> {
		return this._chain.execute();
	}

	getProviders(): Array<{ name: string; priority: number; available: boolean }> {
		return this._chain.getProviders();
	}

	clear(): void {
		this._chain.clear();
	}
}
