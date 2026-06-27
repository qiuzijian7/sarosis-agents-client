/*---------------------------------------------------------------------------------------------
 *  流压缩 — 基于对话流模式的压缩。
 *  参考 agentmemory src/functions/flow-compress.ts
 *
 *  与现有 compressor.ts 的区别：
 *    - compressor：单条记忆的结构化提取（facts/concepts/files/title）
 *    - flowCompress：多条记忆的模式识别 + 流压缩
 *
 *  核心能力：
 *    1. identifyFlow(entries) — 识别对话流模式
 *    2. compressFlow(entries) — 压缩流模式为单条摘要
 *    3. detectRepeatedPatterns(entries) — 检测重复模式
 *
 *  流模式类型：
 *    - linear: 线性流程（A → B → C）
 *    - branching: 分支流程（A → {B, C}）
 *    - loop: 循环流程（A → B → A → B）
 *    - retry: 重试流程（A → fail → A → success）
 *--------------------------------------------------------------------------------------------*/

export interface FlowPattern {
	id: string;
	type: 'linear' | 'branching' | 'loop' | 'retry' | 'mixed';
	entries: Array<{ id: string; content: string; role: string; timestamp: number }>;
	pattern: string;          // 模式描述
	summary: string;          // 压缩摘要
	repetitionCount: number;  // 重复次数
	createdAt: string;
}

export interface FlowCompressResult {
	patterns: FlowPattern[];
	compressedSummaries: string[];
	originalEntryCount: number;
	compressedEntryCount: number;
	compressionRatio: number;
}

export interface FlowEntry {
	id: string;
	content: string;
	role: string;  // 'user' | 'assistant' | 'tool'
	timestamp: number;
	metadata?: Record<string, unknown>;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 检测重复模式（滑动窗口）
 */
function detectRepeatedPatterns(entries: FlowEntry[]): Array<{ pattern: string[]; count: number; indices: number[][] }> {
	if (entries.length < 4) return [];

	const patterns: Array<{ pattern: string[]; count: number; indices: number[][] }> = [];
	const seen = new Set<string>();

	// 尝试不同窗口大小（2-5）
	for (let windowSize = 2; windowSize <= Math.min(5, Math.floor(entries.length / 2)); windowSize++) {
		for (let i = 0; i <= entries.length - windowSize; i++) {
			const window = entries.slice(i, i + windowSize);
			const key = window.map(e => `${e.role}:${e.content.slice(0, 30)}`).join('|');

			if (seen.has(key)) continue;
			seen.add(key);

			// 计算重复次数
			const indices: number[][] = [[i]];
			for (let j = i + windowSize; j <= entries.length - windowSize; j++) {
				const candidate = entries.slice(j, j + windowSize);
				const candidateKey = candidate.map(e => `${e.role}:${e.content.slice(0, 30)}`).join('|');
				if (candidateKey === key) {
					indices.push([j]);
				}
			}

			if (indices.length >= 2) {
				patterns.push({
					pattern: window.map(e => `${e.role}: ${e.content.slice(0, 50)}`),
					count: indices.length,
					indices,
				});
			}
		}
	}

	return patterns.sort((a, b) => b.count - a.count);
}

/**
 * 识别流类型
 */
function identifyFlowType(entries: FlowEntry[]): FlowPattern['type'] {
	// 检测重试模式（tool 调用后跟 error，然后再次调用）
	for (let i = 0; i < entries.length - 3; i++) {
		if (entries[i].role === 'tool' && entries[i + 1]?.role === 'assistant'
			&& entries[i + 2]?.role === 'tool'
			&& /error|fail/i.test(entries[i].content) && !/error|fail/i.test(entries[i + 2].content)) {
			return 'retry';
		}
	}

	// 检测循环模式
	const roleSequence = entries.map(e => e.role);
	for (let i = 0; i < roleSequence.length - 3; i++) {
		if (roleSequence[i] === roleSequence[i + 2] && roleSequence[i + 1] === roleSequence[i + 3]) {
			return 'loop';
		}
	}

	// 检测分支模式（同一时间多个 tool 调用）
	const toolEntries = entries.filter(e => e.role === 'tool');
	if (toolEntries.length >= 2) {
		const timestamps = toolEntries.map(e => e.timestamp);
		for (let i = 0; i < timestamps.length - 1; i++) {
			if (Math.abs(timestamps[i] - timestamps[i + 1]) < 1000) {
				return 'branching';
			}
		}
	}

	return 'linear';
}

function compressEntries(entries: FlowEntry[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		const content = entry.content.slice(0, 200);
		lines.push(`[${entry.role}] ${content}`);
	}
	return lines.join('\n');
}

export class FlowCompressor {
	private _patterns = new Map<string, FlowPattern[]>();

	/**
	 * 压缩条目流
	 */
	compress(agentId: string, entries: FlowEntry[]): FlowCompressResult {
		if (!entries || entries.length === 0) {
			return { patterns: [], compressedSummaries: [], originalEntryCount: 0, compressedEntryCount: 0, compressionRatio: 1 };
		}

		const patterns: FlowPattern[] = [];

		// 1. 检测重复模式
		const repeated = detectRepeatedPatterns(entries);
		for (const rep of repeated.slice(0, 5)) {  // 取前 5 个
			const pattern: FlowPattern = {
				id: generateId('fp'),
				type: rep.count >= 3 ? 'loop' : 'retry',
				entries: entries.slice(rep.indices[0][0], rep.indices[0][0] + rep.pattern.length),
				pattern: rep.pattern.join(' → '),
				summary: `Repeated pattern (${rep.count}x): ${rep.pattern[0]}`,
				repetitionCount: rep.count,
				createdAt: new Date().toISOString(),
			};
			patterns.push(pattern);
		}

		// 2. 识别整体流类型
		const flowType = identifyFlowType(entries);
		const allEntries = entries.map(e => ({
			id: e.id,
			content: e.content,
			role: e.role,
			timestamp: e.timestamp,
		}));

		// 3. 生成压缩摘要
		const compressedSummaries: string[] = [];

		// 如果有重复模式，压缩重复部分
		if (patterns.length > 0) {
			for (const pattern of patterns) {
				compressedSummaries.push(`[Pattern: ${pattern.type}, ${pattern.repetitionCount}x] ${pattern.summary}`);
			}
		}

		// 生成整体流摘要
		const overallSummary = `[${flowType}] ${entries.length} entries: ${compressEntries(entries.slice(0, 5))}`;
		compressedSummaries.push(overallSummary);

		// 存储模式
		let agentPatterns = this._patterns.get(agentId);
		if (!agentPatterns) {
			agentPatterns = [];
			this._patterns.set(agentId, agentPatterns);
		}
		agentPatterns.push(...patterns);
		if (agentPatterns.length > 50) {
			agentPatterns.splice(0, agentPatterns.length - 50);
		}

		const compressedCount = patterns.length + 1;  // 模式数 + 整体摘要
		return {
			patterns,
			compressedSummaries,
			originalEntryCount: entries.length,
			compressedEntryCount: compressedCount,
			compressionRatio: compressedCount > 0 ? entries.length / compressedCount : 1,
		};
	}

	/**
	 * 获取 agent 的流模式历史
	 */
	getPatterns(agentId: string): FlowPattern[] {
		return this._patterns.get(agentId) ?? [];
	}

	/**
	 * 获取统计
	 */
	getStats(agentId?: string): { totalPatterns: number; patternsByType: Record<string, number>; avgRepetition: number } {
		const patterns = agentId
			? (this._patterns.get(agentId) ?? [])
			: Array.from(this._patterns.values()).flat();

		const byType: Record<string, number> = {};
		for (const p of patterns) {
			byType[p.type] = (byType[p.type] ?? 0) + 1;
		}

		const avgRepetition = patterns.length > 0
			? patterns.reduce((s, p) => s + p.repetitionCount, 0) / patterns.length
			: 0;

		return {
			totalPatterns: patterns.length,
			patternsByType: byType,
			avgRepetition: Math.round(avgRepetition * 10) / 10,
		};
	}

	/**
	 * 清除
	 */
	clear(agentId?: string): void {
		if (agentId) {
			this._patterns.delete(agentId);
		} else {
			this._patterns.clear();
		}
	}
}
