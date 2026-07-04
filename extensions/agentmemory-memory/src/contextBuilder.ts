/*---------------------------------------------------------------------------------------------
 *  上下文构建器 — 从多个来源组装 LLM 上下文，按优先级和 token 预算裁剪。
 *  参考 agentmemory src/functions/context.ts
 *
 *  与现有 _buildSystemPrompt 的区别：
 *    - _buildSystemPrompt：简单的字符串拼接
 *    - ContextBuilder：结构化构建（来源 + 优先级 + token 预算 + 格式化）
 *    - ContextBlock：1:1 对齐 agentmemory ContextBlock（priority + recency + budget）
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

// ─── P0: ContextBlock 抽象（1:1 对齐 agentmemory context.ts）───

export interface ContextBlock {
	/** 块类型 */
	type: 'slot' | 'lesson' | 'episodic' | 'semantic' | 'procedural' | 'working';
	/** 块内容（Markdown） */
	content: string;
	/** 估算 token 数（char/3） */
	tokens: number;
	/** 时间戳（用于排序） */
	recency: number;
	/** 排序优先级：0=固定槽位(永不变), 1=核心记忆, 2=动态召回 */
	priority: number;
	/** 来源 ID 列表（用于访问记录） */
	sourceIds?: string[];
}

/** 按 budget 贪心截断（固定优先级块不受截断） */
export function selectWithBudgetAndPriority(
	blocks: ContextBlock[],
	budget: number,
): { selected: ContextBlock[]; usedTokens: number; truncated: boolean } {
	const selected: ContextBlock[] = [];
	let usedTokens = 0;

	// 先按 (priority ASC, recency DESC) 排序
	const sorted = [...blocks].sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority;
		return b.recency - a.recency;
	});

	for (const block of sorted) {
		// 固定槽位（priority=0）不受 budget 限制
		if (block.priority === 0) {
			selected.push(block);
			usedTokens += block.tokens;
			continue;
		}
		if (usedTokens + block.tokens > budget) continue;
		selected.push(block);
		usedTokens += block.tokens;
	}

	return {
		selected: selected.sort((a, b) => {
			// 最终输出：先固定槽位，再按 recency 降序
			if (a.priority === 0 && b.priority !== 0) return -1;
			if (b.priority === 0 && a.priority !== 0) return 1;
			return b.recency - a.recency;
		}),
		usedTokens,
		truncated: selected.length < blocks.length,
	};
}

/**
 * 组装 <agentmemory-context> 标签
 * 对齐 agentmemory context.ts 的输出格式
 */
export function wrapAgentMemoryContext(
	blocks: ContextBlock[],
	budget: number,
	project?: string,
): { text: string; usedTokens: number; truncated: boolean } {
	const { selected, usedTokens, truncated } = selectWithBudgetAndPriority(blocks, budget);
	if (selected.length === 0) return { text: '', usedTokens: 0, truncated: false };

	const body = selected.map(b => b.content).join('\n\n');
	const projectAttr = project ? ` project="${escapeXmlAttr(project)}"` : '';
	const header = `<agentmemory-context${projectAttr}>`;
	const footer = `</agentmemory-context>`;
	const text = `${header}\n${body}\n${footer}`;
	const totalTokens = Math.ceil(text.length / 3);

	return { text, usedTokens: totalTokens, truncated };
}

function escapeXmlAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Original ContextBuilder (preserved) ────────────────────────────────

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
