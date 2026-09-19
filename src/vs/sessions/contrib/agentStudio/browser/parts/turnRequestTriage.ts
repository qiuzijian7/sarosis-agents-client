/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Turn request triage — 无状态的「请求分流」辅助集合。
 *
 * 本模块只含纯函数与常量：不持有 per-turn 闭包状态，不依赖主循环的可变变量，
 * 因此可被主执行器、测试与其他 turn 子模块安全复用。
 */

/**
 * 轻量/会话型请求命中时需要屏蔽的工具名片段。
 *
 * 用于阻止对明显非任务消息（"test1"、问候、纯确认）触发代码库深度探索与图谱构建。
 */
export const TRIVIAL_BLOCKED_TOOLS = [
	'search_graph', 'query_graph', 'search_code', 'get_architecture',
	'trace_path', 'get_code_snippet', 'index_repository',
	'search_files', 'read_skill', 'list_skills',
	'delegate_task', 'transfer_to_agent', 'plan_explore',
];

/**
 * 工具失败恢复提示（借鉴 Hermes-Agent `_tool_failure_recovery_hint`）。
 *
 * 白名单表：未登记的工具返回 `null`，调用方据此跳过提示注入。
 */
export function getToolFailureRecoveryHint(toolName: string): string | null {
	const hints: Record<string, string> = {
		terminal: 'For terminal failures, try a diagnostic command first (e.g., `pwd && ls`), ' +
			'then use an absolute path, a simpler command, or a different tool such as file_read/patch.',
		search_files: 'Search returned no results. Try a narrower directory, a simpler pattern, ' +
			'or use search_graph / query_graph to explore code by structure instead of by text.',
		file_read: 'File read failed. Check the path exists with file_list, or try search_graph ' +
			'to locate the file by its function/class names.',
		file_write: 'File write failed. Verify the parent directory exists, check write permissions, ' +
			'or try patch for targeted edits instead of full rewrites.',
		patch: 'Patch failed. The search text may not match exactly — try reading the file first ' +
			'to verify the current content, then use a smaller or more unique search string.',
		file_list: 'Directory listing failed. Check the path exists with `pwd` or an absolute path.',
		index_repository: 'Indexing failed. The workspace may already have a graph loaded — ' +
			'check index_status first, or try a different mode (fast/moderate/full).',
		search_graph: 'Graph search returned no results. Try a wider name pattern, a different label filter, ' +
			'or check index_status to verify the graph is loaded.',
	};
	return hints[toolName] ?? null;
}

/** 取请求中最后一条 user 消息的纯文本内容；非字符串内容（多模态）视为空串。 */
export function extractUserText(request: any): string {
	const msgs = request?.messages || [];
	const userMsgs = msgs.filter((m: any) => m?.role === 'user');
	const last = userMsgs[userMsgs.length - 1];
	if (!last) { return ''; }
	return typeof last.content === 'string' ? last.content : '';
}

/**
 * 判定是否为轻量/会话型请求。
 *
 * 仅匹配明确的问候/测试/确认短语，并额外排除含代码/任务信号的消息，避免误伤真实任务。
 */
export function isTrivialRequest(raw: string): boolean {
	if (!raw) { return true; }
	// 去掉可能的 agent 选择前缀（如 "gr test1" → "test1"）
	let text = raw.trim();
	const stripped = text.replace(/^[A-Za-z0-9_\-]+\s+/, '');
	if (stripped.length > 0 && stripped.length < text.length) {
		text = stripped;
	}
	if (text.length === 0 || text.length > 40) { return false; }
	// ⚠ 中文词条一律**不能**用 `\b` 收尾：`\b` 是 ASCII 单词边界，只在 `\w`
	// （[A-Za-z0-9_]）与非 `\w` 的交界处成立。CJK 字符本身不属于 `\w`，
	// 所以 `/^你好\b/` 对 "你好" 恒为 false —— 2026-09-18 实测该行所有中文
	// 条目（你好/您好/在吗/好的/收到/明白/了解/谢谢…）全部从未命中过，
	// 中文问候因此一直在触发完整探索工具集与图谱构建。
	// 这里改用「串尾或后接非中文字符」作为等价边界。
	const CJK_END = '(?![\\u4e00-\\u9fa5])';
	const trivialPatterns = [
		/^test\d*$/i,
		/^测试\d*$/i,
		/^(hi|hello|hey|yo|hiya)\b/i,
		new RegExp(`^(你好|您好|在吗|在不在|有人吗)${CJK_END}`),
		/^(ok|okay|thanks|thank you|thx)\b/i,
		new RegExp(`^(好的|收到|明白|了解|谢谢)${CJK_END}`),
		/^(t|t1|t2|t3)\b/i,
	];
	if (!trivialPatterns.some(p => p.test(text))) { return false; }
	// 含代码/任务信号 → 不是 trivial。
	// 同上：中文信号词（优化/修复/分析…）不能夹在 `\b` 之间，否则永不命中。
	// 故拆成两条：ASCII 词用 `\b` 保证整词匹配，中文词直接子串匹配。
	const asciiSignals = /\b(gc|bug|fix|impl|implement|optim|analyze|refactor|function|class|module|code|file|read|write|search|graph|why|how|deploy|build|run|create|add|update|delete|generate|config|init|install|set|start|stop|show|list|get)\b/i;
	const cjkSignals = /(优化|修复|实现|分析|函数|模块|代码|文件|读|写|查|搜索|图谱|原理|怎么|如何|构建|运行|创建|添加|更新|删除|生成|配置|初始化|安装|设置|启动|停止|显示|列出|获取)/;
	if (asciiSignals.test(text) || cjkSignals.test(text)) { return false; }
	// 含路径/扩展名 → 不是 trivial
	if (/[\\/]|\.\w{1,6}\b/.test(text)) { return false; }
	return true;
}
