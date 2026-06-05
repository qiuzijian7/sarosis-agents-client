/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ping-pong alternating tool pair loop detector.
 *
 * 作用：检测"两个工具交替执行无进展"的模式 —— A→B→A→B 反复循环。
 * 例如：模型在 terminal 和 file_read 之间来回反复，每次都失败/返回同结果，
 * 但既不切换策略也不输出文本，而是不断在两个工具间跳来跳去。
 *
 * 算法：
 *   - 维护一个固定大小的滑动窗口（默认 6 次工具调用）
 *   - 检查窗口内是否有"恰好交替"的两工具对 (A, B)，且出现 ≥ 2 个完整轮次
 *   - 命中后返回 halt（退出主循环）
 *
 * 配合点：
 *   - push(toolName)：每次工具调用前/后记录工具名
 *   - check()：每次工具调用后检查当前窗口
 *   - reset()：每个新 turn 开始时重置
 */

export interface IPingPongHaltDecision {
	action: 'halt';
	detector: 'ping_pong_alternating_loop';
	message: string;
	alternatingPair: [string, string];
	alternatingPairCount: number;
}

// ─── 配置 ─────────────────────────────────────────────────────────────────

export interface IPingPongConfig {
	/**
	 * 滑动窗口大小（工具调用次数），默认 6。
	 * 窗口越大越保守（需要更多次调用才能触发），越小越激进。
	 * 对于 IDE 嵌入式 Agent，6 次（约等于 3 对交替）是合适的默认值。
	 */
	windowSize: number;
	/**
	 * 触发 halt 所需的交替轮次（每个工具各出现一次 = 1 轮），默认 2。
	 * 例如 window=6, minTurns=2：
	 *   A→B→A→B→A→B (A出现3次, B出现3次) → halt
	 *   A→B→A→B→A→C (C打断了交替) → 不 halt（直到窗口重置）
	 */
	minAlternatingTurns: number;
}

export const DEFAULT_PING_PONG_CONFIG: IPingPongConfig = {
	windowSize: 6,
	minAlternatingTurns: 2,
};

// ─── 实现 ─────────────────────────────────────────────────────────────────

/**
 * Ping-pong alternating loop detector。
 *
 * 用法：
 *   const detector = new PingPongDetector();
 *   for each tool call:
 *     detector.push(toolName);
 *     const halt = detector.check();
 *     if (halt) { // break + summary }
 *   // 每个新 turn:
 *     detector.reset();
 */
export class PingPongDetector {
	private readonly _config: IPingPongConfig;
	private readonly _window: string[] = [];

	constructor(config?: Partial<IPingPongConfig>) {
		this._config = { ...DEFAULT_PING_PONG_CONFIG, ...config };
	}

	/** 记录一次工具调用（工具名）。 */
	push(toolName: string): void {
		this._window.push(toolName);
		// 窗口大小固定，超出时移除最旧的
		while (this._window.length > this._config.windowSize) {
			this._window.shift();
		}
	}

	/**
	 * 检查当前窗口是否构成 ping-pong 交替模式。
	 * 应在每次 push() 之后调用。
	 *
	 * 返回 halt 决策或 null（正常）。
	 */
	check(): IPingPongHaltDecision | null {
		const ws = this._window;
		if (ws.length < 4) {
			return null; // 至少需要 A→B→A→B 才能算交替
		}

		// 取窗口末尾 [工具数] 个元素（最近的一次完整窗口）
		const size = Math.min(ws.length, this._config.windowSize);
		// 从窗口最后往前看：取最近的 size 个（size 可能是 4/5/6...）
		const recent = ws.slice(-size);

		// 检测交替模式：相邻元素必须恰好交替 (A, B, A, B, ...)
		// 即：recent[0] !== recent[1] && recent[1] !== recent[2] && ...
		// 且：相邻不相等（严格交替）+ 首尾相同（形成闭环）
		let alternating = true;
		for (let i = 0; i < recent.length - 1; i++) {
			if (recent[i] === recent[i + 1]) {
				alternating = false;
				break;
			}
		}

		if (!alternating) {
			return null;
		}

		// 交替成立。计算交替对 (A, B) 和交替轮次数。
		// 交替序列形如 A B A B A B ...（严格交替）
		const toolSet = new Set<string>();
		for (const t of recent) {
			toolSet.add(t);
		}

		// 只有恰好 2 个工具交替时才构成 ping-pong
		if (toolSet.size !== 2) {
			return null;
		}

		const [a, b] = Array.from(toolSet);

		// 交替轮次数 = 相邻不同对的数量，即 (recent.length / 2)
		// 或者更准确地：统计 recent[i] !== recent[i+1] 的次数（相邻对数）
		let adjacentPairs = 0;
		for (let i = 0; i < recent.length - 1; i++) {
			if (recent[i] !== recent[i + 1]) {
				adjacentPairs++;
			}
		}
		const alternatingTurns = Math.floor(adjacentPairs / 2);

		if (alternatingTurns >= this._config.minAlternatingTurns) {
			return {
				action: 'halt',
				detector: 'ping_pong_alternating_loop',
				message: `Detected ping-pong loop: tools "${a}" and "${b}" alternating ${alternatingTurns} complete turns (${recent.length} calls) with no progress. Stop alternating between these two tools and try a different approach, or admit you are stuck.`,
				alternatingPair: [a, b],
				alternatingPairCount: alternatingTurns,
			};
		}

		return null;
	}

	/** 重置窗口。每个新 turn 开始时调用。 */
	reset(): void {
		this._window.length = 0;
	}

	/** 当前窗口内容（诊断用）。 */
	get window(): readonly string[] {
		return [...this._window];
	}
}