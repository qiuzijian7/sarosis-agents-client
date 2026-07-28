/*---------------------------------------------------------------------------------------------
 *  搜索工具分组（数据驱动，2026-07-28）。
 *
 *  主循环「search_graph 引导」逻辑依赖本表区分两类搜索工具：
 *    - 文本/文件名搜索（search_files 等 grep 类）：连击计数的对象
 *    - 结构/语义搜索（search_graph 等索引类）：引导 LLM 优先使用的目标
 *
 *  集中为数据表而非散落在判断逻辑里的字面量，新增搜索工具时只需改本文件。
 *  与 toolsetConfig.ts 的分组正交：toolset 决定「是否发送给 LLM」，
 *  本表决定「探索策略引导」。
 *--------------------------------------------------------------------------------------------*/

/**
 * 结构/语义搜索工具 — 查询代码索引/知识图谱，适合
 * 「X 如何实现 / 调用链 / 架构关系 / 模块边界」类问题。
 */
export const STRUCTURAL_SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
	'search_graph',
	'query_graph',
	'trace_path',
	'get_architecture',
	'get_code_snippet',
	'get_graph_schema',
	// search_code 走索引快路径（matched=0 才回落 ripgrep），语义上属于索引类
	'search_code',
]);

/**
 * 文本/文件名搜索工具 — 精确字符串/glob 匹配。
 * 连续使用而不触及结构工具时触发 search_graph 引导。
 */
export const TEXT_SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
	'search_files',
]);
