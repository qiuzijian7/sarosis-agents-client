/*---------------------------------------------------------------------------------------------
 *  G10: GraphRAG Answer Generation — 对齐 cognee search/operations.py generate_single_completion
 *
 *  从记忆搜索结果 + 图谱上下文中生成结构化答案。
 *  不直接调用 LLM，而是生成结构化 prompt 供上层调用。
 *--------------------------------------------------------------------------------------------*/

export interface AnswerContext {
	query: string;
	searchResults: Array<{ content: string; score: number; source: string }>;
	graphContext?: string;
	agentMemory?: string;
}

export interface AnswerResult {
	prompt: string;
	contextSummary: string;
	sourceCount: number;
}

/**
 * 生成 GraphRAG 答案 prompt
 * 上层 (agentOSService) 拿到此 prompt 后调用 LLM 生成最终答案
 */
export function generateAnswerPrompt(ctx: AnswerContext): AnswerResult {
	const { query, searchResults, graphContext, agentMemory } = ctx;

	// 构建上下文块
	const contextBlocks: string[] = [];

	// 1. Agent Memory (记忆)
	if (agentMemory && agentMemory.trim()) {
		contextBlocks.push(`<memory>\n${agentMemory}\n</memory>`);
	}

	// 2. Graph Context (图谱)
	if (graphContext && graphContext.trim()) {
		contextBlocks.push(`<graph_context>\n${graphContext}\n</graph_context>`);
	}

	// 3. Search Results (搜索结果)
	if (searchResults.length > 0) {
		const resultsBlock = searchResults
			.map((r, i) => `[${i + 1}] (score: ${r.score.toFixed(3)}, source: ${r.source})\n${r.content.slice(0, 500)}`)
			.join('\n\n');
		contextBlocks.push(`<search_results>\n${resultsBlock}\n</search_results>`);
	}

	const contextStr = contextBlocks.join('\n\n');

	const prompt = `Based on the following context, answer the user's question.

${contextStr}

User question: ${query}

Instructions:
- Use only information from the provided context
- If the context doesn't contain relevant information, say "I don't have enough information to answer this"
- Cite sources by their index number [1], [2], etc.
- Be concise and direct`;

	const contextSummary = `Memory: ${agentMemory ? 'yes' : 'no'}, Graph: ${graphContext ? 'yes' : 'no'}, Search results: ${searchResults.length}`;

	return {
		prompt,
		contextSummary,
		sourceCount: searchResults.length,
	};
}
