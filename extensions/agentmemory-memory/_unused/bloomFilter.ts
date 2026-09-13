/*---------------------------------------------------------------------------------------------
 *  布隆过滤器 — 快速概率性去重。
 *  参考 agentmemory src/functions/sketches.ts（概率数据结构）
 *
 *  与现有 DedupManager（SHA-256 精确去重）的区别：
 *    - DedupManager：精确匹配（SHA-256 哈希，5 分钟窗口），但 O(n) 查找
 *    - BloomFilter：概率性匹配（可能误报但不错漏），O(1) 查找
 *
 *  适用场景：
 *    1. 快速预过滤：先查 BloomFilter，命中再查精确去重
 *    2. 大规模去重：当记忆数 >1000 时，BloomFilter 比线性扫描快
 *    3. 跨 agent 去重：检测不同 agent 是否写入了相同内容
 *
 *  参数：
 *    - capacity: 预期元素数量（默认 10000）
 *    - falsePositiveRate: 误报率（默认 0.01 = 1%）
 *    - 自动计算 bitSize 和 hashCount
 *--------------------------------------------------------------------------------------------*/

export class BloomFilter {
	private _bitArray: Uint8Array;
	private _bitSize: number;
	private _hashCount: number;
	private _capacity: number;
	private _falsePositiveRate: number;
	private _count = 0;

	constructor(capacity: number = 10000, falsePositiveRate: number = 0.01) {
		this._capacity = capacity;
		this._falsePositiveRate = falsePositiveRate;

		// 计算最优 bitSize: m = -n * ln(p) / (ln(2)^2)
		this._bitSize = Math.ceil(
			(-capacity * Math.log(falsePositiveRate)) / (Math.log(2) ** 2),
		);
		// 计算最优 hashCount: k = (m/n) * ln(2)
		this._hashCount = Math.ceil((this._bitSize / capacity) * Math.log(2));

		this._bitArray = new Uint8Array(this._bitSize);
	}

	/**
	 * 计算哈希值（使用双重哈希技术，模拟 k 个哈希函数）
	 */
	private _getHashes(item: string): number[] {
		const hashes: number[] = [];
		let h1 = this._hash1(item);
		let h2 = this._hash2(item);

		for (let i = 0; i < this._hashCount; i++) {
			hashes.push(Math.abs((h1 + i * h2) % this._bitSize));
		}
		return hashes;
	}

	private _hash1(s: string): number {
		// FNV-1a hash
		let hash = 2166136261;
		for (let i = 0; i < s.length; i++) {
			hash ^= s.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return hash >>> 0;
	}

	private _hash2(s: string): number {
		// DJB2 hash
		let hash = 5381;
		for (let i = 0; i < s.length; i++) {
			hash = ((hash << 5) + hash) + s.charCodeAt(i);
		}
		return hash >>> 0;
	}

	/**
	 * 添加元素
	 */
	add(item: string): void {
		const hashes = this._getHashes(item);
		for (const h of hashes) {
			this._bitArray[h] = 1;
		}
		this._count++;
	}

	/**
	 * 检查元素是否可能存在
	 * true = 可能存在（有误报概率）
	 * false = 一定不存在
	 */
	mightContain(item: string): boolean {
		const hashes = this._getHashes(item);
		for (const h of hashes) {
			if (this._bitArray[h] === 0) return false;
		}
		return true;
	}

	/**
	 * 批量添加
	 */
	addAll(items: string[]): void {
		for (const item of items) {
			this.add(item);
		}
	}

	/**
	 * 批量检查（返回可能存在的元素）
	 */
	filterExisting(items: string[]): string[] {
		return items.filter(item => this.mightContain(item));
	}

	/**
	 * 获取当前误报率估计
	 */
	estimateFalsePositiveRate(): number {
		if (this._count === 0) return 0;
		// p ≈ (1 - e^(-kn/m))^k
		const exponent = (-this._hashCount * this._count) / this._bitSize;
		const base = 1 - Math.exp(exponent);
		return Math.pow(base, this._hashCount);
	}

	/**
	 * 获取填充率
	 */
	getFillRatio(): number {
		let setBits = 0;
		for (let i = 0; i < this._bitSize; i++) {
			if (this._bitArray[i] === 1) setBits++;
		}
		return setBits / this._bitSize;
	}

	/**
	 * 重置
	 */
	clear(): void {
		this._bitArray.fill(0);
		this._count = 0;
	}

	/**
	 * 获取统计
	 */
	getStats(): {
		count: number;
		capacity: number;
		bitSize: number;
		hashCount: number;
		fillRatio: number;
		estimatedFalsePositiveRate: number;
		memoryBytes: number;
	} {
		return {
			count: this._count,
			capacity: this._capacity,
			bitSize: this._bitSize,
			hashCount: this._hashCount,
			fillRatio: this.getFillRatio(),
			estimatedFalsePositiveRate: this.estimateFalsePositiveRate(),
			memoryBytes: this._bitArray.byteLength,
		};
	}
}

/**
 * HyperLogLog — 基数估计（估计唯一元素数量）
 * 用于快速统计不同 agent/会话/概念的数量
 */
export class HyperLogLog {
	private _registers: Uint8Array;
	private _precision: number;  // p (4-16)
	private _m: number;          // 2^p

	constructor(precision: number = 12) {
		this._precision = Math.max(4, Math.min(16, precision));
		this._m = 1 << this._precision;
		this._registers = new Uint8Array(this._m);
	}

	private _hash(s: string): number {
		let hash = 2166136261;
		for (let i = 0; i < s.length; i++) {
			hash ^= s.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return hash >>> 0;
	}

	add(item: string): void {
		const hash = this._hash(item);
		const index = hash >>> (32 - this._precision);
		const remaining = (hash << this._precision) >>> 0;
		const rank = remaining === 0 ? 32 - this._precision + 1 : Math.clz32(remaining) - this._precision + 1;
		if (rank > this._registers[index]) {
			this._registers[index] = rank;
		}
	}

	estimate(): number {
		let sum = 0;
		for (let i = 0; i < this._m; i++) {
			sum += 2 ** (-this._registers[i]);
		}
		const alpha = this._m === 16 ? 0.673
			: this._m === 32 ? 0.697
				: this._m === 64 ? 0.709
					: 0.7213 / (1 + 1.079 / this._m);
		const estimate = alpha * this._m * this._m / sum;

		// 小范围修正
		if (estimate <= 2.5 * this._m) {
			let zeros = 0;
			for (let i = 0; i < this._m; i++) {
				if (this._registers[i] === 0) zeros++;
			}
			if (zeros > 0) {
				return this._m * Math.log(this._m / zeros);
			}
		}

		return Math.round(estimate);
	}

	clear(): void {
		this._registers.fill(0);
	}

	getStats(): { estimatedCardinality: number; precision: number; registerCount: number; memoryBytes: number } {
		return {
			estimatedCardinality: this.estimate(),
			precision: this._precision,
			registerCount: this._m,
			memoryBytes: this._registers.byteLength,
		};
	}
}
