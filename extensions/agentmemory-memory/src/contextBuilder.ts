/*---------------------------------------------------------------------------------------------
 *  上下文构建器 — 从多个来源组装 LLM 上下文，按优先级和 token 预算裁剪。
 *  参考 agentmemory src/functions/context.ts
 *
 *  与现有 _buildSystemPrompt 的区别：
 *    - _buildSystemPrompt：简单的字符串拼接
 *    - ContextBuilder：结构化构建（来源 + 优先级 + token 预算 + 格式化）
 *
 *  上下文来源（按优先级）：
 *    1. persona slot        — Agent 人格（固定）
 *    2. user_preferences    — 用户偏好（固定）
 *    3. project_context     — 项目上下文（固定）
 *    4. tool_guidelines     — 工具准则（固定）
 *    5. pinned memories     — 固定记忆（始终注入）
 *    6. working memory      — 任务级工作记忆
 *    7. long-term memories  — 长期记忆（按相关性排序）
 *    8. consolidation       — 固化摘要
 *    9. recent context      — 最近短期记忆
 *
 *  Token 预算分配：
 *    固定来源（1-4）：无限制
 *    动态来源（5-9）：按优先级分配剩余预算
 *--------------------------------------------------------------------------------------------*/

export interface ContextSource {
	name: string;
	priority: number;       // 1（最高）- 10（最低）
	content: string;
	tokenEstimate: number;
	pinned: boolean;         // 固定来源不可裁剪
	category: 'slot' | 'memory' | 'working' | 'consolidation' | 'recent' | 'custom';
}

export interface ContextBuildResult {
	systemPrompt: string;
	sources: Array<{ name: string; priority: number; included: boolean; tokens: number }>;
	totalTokens: number;
	budget: number;
	overflow: number;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export class ContextBuilder {
	private _defaultBudget: number;

	constructor(defaultBudget: number = 4000) {
		this._defaultBudget = defaultBudget;
	}

	/**
	 * 构建上下文
	 */
	build(sources: ContextSource[], budget?: number): ContextBuildResult {
		const tokenBudget = budget ?? this._defaultBudget;
		const result: ContextBuildResult = {
			systemPrompt: '',
			sources: [],
			totalTokens: 0,
			budget: tokenBudget,
			overflow: 0,
		};

		// 分离固定和动态来源
		const pinned = sources.filter(s => s.pinned).sort((a, b) => a.priority - b.priority);
		const dynamic = sources.filter(s => !s.pinned).sort((a, b) => a.priority - b.priority);

		// 先计算固定来源占用的 token
		let pinnedTokens = 0;
		for (const source of pinned) {
			pinnedTokens += source.tokenEstimate;
			result.sources.push({
				name: source.name,
				priority: source.priority,
				included: true,
				tokens: source.tokenEstimate,
			});
		}

		// 动态来源的可用预算
		const dynamicBudget = Math.max(0, tokenBudget - pinnedTokens);
		let dynamicTokens = 0;
		const includedDynamic: ContextSource[] = [];

		for (const source of dynamic) {
			if (dynamicTokens + source.tokenEstimate <= dynamicBudget) {
				includedDynamic.push(source);
				dynamicTokens += source.tokenEstimate;
				result.sources.push({
					name: source.name,
					priority: source.priority,
					included: true,
					tokens: source.tokenEstimate,
				});
			} else {
				result.sources.push({
					name: source.name,
					priority: source.priority,
					included: false,
					tokens: source.tokenEstimate,
				});
			}
		}

		// 构建系统提示
		const parts: string[] = [];
		const byCategory = new Map<ContextSource['category'], ContextSource[]>();

		for (const source of [...pinned, ...includedDynamic]) {
			const list = byCategory.get(source.category) ?? [];
			list.push(source);
			byCategory.set(source.category, list);
		}

		// 按类别组织输出
		const categoryOrder: ContextSource['category'][] = ['slot', 'working', 'memory', 'consolidation', 'recent', 'custom'];
		const categoryLabels: Record<ContextSource['category'], string> = {
			slot: '## Slots',
			working: '## Working Memory',
			memory: '## Long-term Memory',
			consolidation: '## Consolidated Knowledge',
			recent: '## Recent Context',
			custom: '## Additional Context',
		};

		for (const category of categoryOrder) {
			const items = byCategory.get(category);
			if (!items || items.length === 0) continue;

			parts.push(categoryLabels[category]);
			for (const item of items) {
				if (item.name && item.name !== item.content.slice(0, 50)) {
					parts.push(`### ${item.name}`);
				}
				parts.push(item.content);
				parts.push('');
			}
		}

		result.systemPrompt = parts.join('\n');
		result.totalTokens = pinnedTokens + dynamicTokens;
		result.overflow = Math.max(0, pinnedTokens + dynamicTokens - tokenBudget);

		return result;
	}

	/**
	 * 从记忆条目构建来源
	 */
	fromMemories(
		pinnedSlots: Array<{ name: string; content: string }>,
		longTermMemories: Array<{ id: string; content: string; score?: number; metadata?: Record<string, unknown> }>,
		shortTermMemories: Array<{ id: string; content: string }>,
		workingMemory: Array<{ key: string; value: string; category?: string }>,
		consolidationContext: string,
	): ContextSource[] {
		const sources: ContextSource[] = [];

		// Pinned slots
		for (const slot of pinnedSlots) {
			sources.push({
				name: slot.name,
				priority: 1,
				content: slot.content,
				tokenEstimate: estimateTokens(slot.content),
				pinned: true,
				category: 'slot',
			});
		}

		// Working memory
		for (const item of workingMemory) {
			sources.push({
				name: item.key,
				priority: 5,
				content: item.value,
				tokenEstimate: estimateTokens(item.value),
				pinned: false,
				category: 'working',
			});
		}

		// Long-term memories
		const sortedLong = longTermMemories
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
		for (const mem of sortedLong) {
			sources.push({
				name: mem.id,
				priority: 6,
				content: mem.content,
				tokenEstimate: estimateTokens(mem.content),
				pinned: false,
				category: 'memory',
			});
		}

		// Consolidation
		if (consolidationContext) {
			sources.push({
				name: 'consolidation',
				priority: 7,
				content: consolidationContext,
				tokenEstimate: estimateTokens(consolidationContext),
				pinned: false,
				category: 'consolidation',
			});
		}

		// Recent context (short-term)
		for (const mem of shortTermMemories.slice(-10)) {
			sources.push({
				name: mem.id,
				priority: 8,
				content: mem.content,
				tokenEstimate: estimateTokens(mem.content),
				pinned: false,
				category: 'recent',
			});
		}

		return sources;
	}

	/**
	 * 获取默认预算
	 */
	getDefaultBudget(): number {
		return this._defaultBudget;
	}

	/**
	 * 设置默认预算
	 */
	setDefaultBudget(budget: number): void {
		this._defaultBudget = Math.max(500, budget);
	}
}
