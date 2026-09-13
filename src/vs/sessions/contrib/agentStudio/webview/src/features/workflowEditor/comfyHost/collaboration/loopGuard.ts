/**
 * 循环护栏 —— 迭代上限 + 重复行为检测。
 *
 * ## 问题（本项目现状）
 *
 * 多 agent 协同最大的运行风险是**失控**：
 *   - `Saros.Loop` / `Saros.Parallel` 容器的 body 可以递归嵌套，**无深度/次数上限**；
 *   - 动态委派（放开 `maxSpawnDepth` 后）理论上可无限派生；
 *   - 子代理陷入「反复调用同一工具/重复同一段话」时，靠 10 分钟超时才终止——
 *     期间 token 已经在烧（Anthropic 实测多 agent 是单 agent 的 15× token）。
 *
 * ## 设计（来源：open-multi-agent `agent/loop-detector.ts`）
 *
 * **滑动窗口 + 连续重复计数**：记录每回合的工具调用签名/文本签名，窗口内出现
 * `maxRepeats` 次连续相同即判定循环。签名需**确定性**（对象 key 排序、工具按名排序），
 * 否则参数顺序变化会绕过检测。
 *
 * 动作由调用方决定（warn / terminate），本模块只做判定——保持纯逻辑可测。
 */

export interface LoopDetectionInfo {
	kind: 'tool_repetition' | 'text_repetition';
	repetitions: number;
	detail: string;
}

export interface LoopDetector {
	/** 记录一次工具调用批次；命中循环返回信息，否则 null。 */
	recordToolCalls(calls: ReadonlyArray<{ name: string; input?: unknown }>): LoopDetectionInfo | null;
	/** 记录一次文本输出；命中循环返回信息，否则 null。 */
	recordText(text: string): LoopDetectionInfo | null;
	/** 清空窗口（新一轮用户输入时调用）。 */
	reset(): void;
	readonly windowSize: number;
	readonly maxRepeats: number;
}

export interface LoopDetectorOptions {
	/** 连续重复多少次判定循环，默认 3。 */
	maxRepetitions?: number;
	/** 滑动窗口大小，默认 4（且不小于 maxRepetitions）。 */
	window?: number;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) { return value.map(sortKeys); }
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(obj).sort()) { out[k] = sortKeys(obj[k]); }
		return out;
	}
	return value;
}

/** 确定性签名：工具按 name 排序、参数按 key 排序后序列化。 */
export function computeToolSignature(calls: ReadonlyArray<{ name: string; input?: unknown }>): string {
	return JSON.stringify(
		calls
			.map(c => ({ name: c.name, input: sortKeys(c.input ?? null) }))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
	);
}

export function createLoopDetector(opts: LoopDetectorOptions = {}): LoopDetector {
	const maxRepeats = Math.max(2, opts.maxRepetitions ?? 3);
	const windowSize = Math.max(opts.window ?? 4, maxRepeats);
	const toolBuf: string[] = [];
	const textBuf: string[] = [];

	const push = (buf: string[], entry: string): void => {
		buf.push(entry);
		while (buf.length > windowSize) { buf.shift(); }
	};

	/** 从尾部往前数连续相同项。 */
	const consecutiveRepeats = (buf: string[]): number => {
		if (buf.length === 0) { return 0; }
		const last = buf[buf.length - 1];
		let n = 0;
		for (let i = buf.length - 1; i >= 0 && buf[i] === last; i--) { n++; }
		return n;
	};

	return {
		recordToolCalls(calls) {
			if (calls.length === 0) { return null; }
			const sig = computeToolSignature(calls);
			push(toolBuf, sig);
			const count = consecutiveRepeats(toolBuf);
			if (count < maxRepeats) { return null; }
			return {
				kind: 'tool_repetition',
				repetitions: count,
				detail: `连续 ${count} 次相同工具调用（${calls.map(c => c.name).join(', ')}）`,
			};
		},
		recordText(text) {
			// 归一化：去空白差异，避免仅格式变化绕过检测
			const norm = text.replace(/\s+/g, ' ').trim();
			if (!norm) { return null; }
			push(textBuf, norm);
			const count = consecutiveRepeats(textBuf);
			if (count < maxRepeats) { return null; }
			return {
				kind: 'text_repetition',
				repetitions: count,
				detail: `连续 ${count} 次重复输出：${norm.slice(0, 80)}…`,
			};
		},
		reset() { toolBuf.length = 0; textBuf.length = 0; },
		get windowSize() { return windowSize; },
		get maxRepeats() { return maxRepeats; },
	};
}

/**
 * 迭代护栏：为 Loop/Parallel 容器与动态派生提供**显式上限**。
 *
 * 用法：每次迭代前 `next()`，返回 false 表示已达上限（调用方应停止并报明确错误，
 * 而非静默截断——静默截断会让用户以为「循环正常结束」）。
 */
export interface IterationGuard {
	/** 进入下一次迭代；false = 超限。 */
	next(): boolean;
	readonly count: number;
	readonly limit: number;
	/** 是否已触顶。 */
	exhausted(): boolean;
}

export function createIterationGuard(maxIterations: number, label = 'loop'): IterationGuard {
	const limit = Math.max(1, Math.floor(maxIterations));
	let count = 0;
	return {
		next() {
			if (count >= limit) { return false; }
			count++;
			return true;
		},
		get count() { return count; },
		get limit() { return limit; },
		exhausted: () => count >= limit,
		// label 参与错误信息构造（调用方拼「${label} 超过 ${limit} 次迭代」）
		toString: () => `${label}: ${count}/${limit}`,
	} as IterationGuard;
}
