/*---------------------------------------------------------------------------------------------
 *  search_code path_filter 归一化（2026-07-28，日志 1785228894680）。
 *
 *  背景：模型常把搜索结果展示的绝对路径（f:\GR_qiuzijian_main\UE5EA\Engine\...）
 *  转化为「根目录名开头的相对路径」（UE5EA/Engine/...）传给 path_filter。
 *  VS Code textSearch 的 includePattern 按【各搜索根相对路径】匹配——根内路径
 *  是 Engine/... 不含 UE5EA/ 段，glob 恒 0 命中（19/19 no-match，连确定存在的
 *  GarbageCollection.cpp 都搜不到）。
 *
 *  归一化规则（纯函数、数据驱动——根目录名列表由调用方从 workspace folders 取）：
 *    1. 统一分隔符 \ → /；
 *    2. 剥离开头连续的 globstar（`**`）与 `./` 前缀（对匹配意图无意义，
 *       顺带修复「globstar 拼绝对盘符路径」这类畸形 glob——1785134772329 的姊妹形态）；
 *    3. 绝对路径原样返回（由调用方 _isAbsPath 分支直通）；
 *    4. 首路径段与任一 workspace folder 目录名匹配（大小写不敏感）→ 剥掉该段；
 *       剥后为空 = 模型意图「整个根」→ 返回 undefined（不过滤）。
 *  注：本注释中不写 globstar+斜杠 连排（其含注释终止序列），故用「globstar」代称。
 *--------------------------------------------------------------------------------------------*/

/**
 * 归一化 path_filter。返回 undefined 表示无需 include 过滤（搜整个根）。
 *
 * @param pathFilter  模型传入的原始 path_filter（任意形态）
 * @param rootDirNames 各 workspace folder 的目录名（fsPath 末段），大小写不敏感比较
 */
export function normalizePathFilterForRoots(pathFilter: string, rootDirNames: readonly string[]): string | undefined {
	let s = String(pathFilter ?? '').replace(/\\/g, '/').trim();
	if (!s) { return undefined; }

	// 剥离开头连续的 **/ 与 ./（可能叠加出现，如 `**/./src`）
	for (;;) {
		if (s.startsWith('**/')) { s = s.slice(3); continue; }
		if (s.startsWith('./')) { s = s.slice(2); continue; }
		break;
	}
	if (!s) { return undefined; }

	// 绝对路径（f:/... 或 /...）原样返回，由调用方绝对路径分支直通
	if (/^[a-zA-Z]:\//.test(s) || s.startsWith('/')) { return s; }

	// 首段 = workspace folder 目录名 → 剥掉（include glob 按根相对路径匹配，
	// 含根目录自身名恒 0 命中）
	const firstSeg = s.split('/')[0];
	if (firstSeg && rootDirNames.some(n => n.length > 0 && n.toLowerCase() === firstSeg.toLowerCase())) {
		const rest = s.slice(firstSeg.length).replace(/^\/+/, '');
		// 剥后为空：模型意图就是「整个项目根」→ 不过滤
		return rest || undefined;
	}
	return s;
}

/**
 * include 过滤非空且全根 no-match 时的输出 hint（打破模型「重写 query 重试」
 * 无效循环——真正的问题是过滤过严而非 query，日志 1785228894680 中模型对同一
 * include 重写正则重试 12 次）。
 */
export function noMatchWithIncludeHint(includeGlob: string): string {
	return (
		`\n[tool-hint] 0 matches with include filter "${includeGlob}". The path filter may be too restrictive: ` +
		'paths are matched RELATIVE to each project root — do NOT prefix with the root folder name. ' +
		'Consider retrying without path_filter.'
	);
}

/**
 * search_code 无任何 include 过滤仍全库 0 命中时的提示（2026-07-28，日志
 * 1785231958842：include 为空的空命中此前静默无提示，模型闷头重写 query 空转）。
 * 此时问题不在过滤而在符号本身——多半是符号名幻觉/拼写错误。引导先用
 * search_files / search_graph 验证符号真实存在，而非继续重写 query 猜测。
 */
export function noMatchNoFilterHint(): string {
	return (
		'\n[tool-hint] No matches anywhere (no path filter applied). The symbols likely do not exist as written — ' +
		'verify the exact name first with search_files (file lookup) or search_graph (structural search), rather than rewriting the query with more guesses.'
	);
}

/**
 * search_code 的 file_pattern（file_glob）glob 归一化（2026-07-28，日志 1785231958842）。
 * 引擎 _globToRegex 中 `*` 不跨目录：裸文件名（GarbageCollection.cpp）或裸扩展名
 * glob（*.cpp）只匹配各搜索根直属文件，嵌套文件恒 0 命中（log 中 8 次空命中）。
 * 模型预期 ripgrep gitignore 语义（裸模式匹配任意深度），故无 `/` 时补 globstar 前缀
 * （与 _globFromPathFilter 的相对文件处理一致）。已含 `/` 的模式原样返回。
 */
export function normalizeFileGlobForSearch(glob: string): string {
	const g = String(glob ?? '').trim();
	if (!g) { return g; }
	return g.includes('/') ? g : `**/${g}`;
}

/**
 * search_code 连续 N 次 0 命中（换符号猜测仍无果）时的引导 hint（2026-07-28，
 * 日志 1785231958842：模型对同一目标反复换符号/重写 query 重试 search_code，
 * 每次参数不同绕过 exact-repeat 熔断，烧光子代理预算）。这类失败通常是
 * 「符号名猜错/幻觉」或「path_filter 过严」——重写 query 无解，应换工具。
 */
export function searchCodeEmptyStreakHint(streakCount: number): string {
	return (
		`\n[tool-hint] search_code returned no matches ${streakCount} times in a row. Rewriting the query with more symbol guesses is not working — ` +
		'the symbols likely do not exist as written, or path_filter is too restrictive. ' +
		'STOP retrying search_code with similar queries. Instead: (1) use search_graph / query_graph for semantic/structural lookup (robust to exact naming), ' +
		'or (2) run search_files to confirm the exact symbol/file name first, or (3) drop path_filter and search wider.'
	);
}

/**
 * search_code 连续空结果连击推进（纯函数，便于单测）。
 * 输入当前连击数与本次是否 0 命中，返回新连击数与是否应引导（达阈值倍数）。
 * 由 SearchHelpers.recordSearchCodeEmptyStreak 持 per-agentId Map 包装调用。
 */
export function advanceSearchCodeEmptyStreak(
	current: number, isEmpty: boolean, threshold: number,
): { streak: number; shouldGuide: boolean } {
	const streak = isEmpty ? current + 1 : 0;
	return { streak, shouldGuide: streak > 0 && threshold > 0 && streak % threshold === 0 };
}

/** search_code 空搜引导阈值：主 agent。 */
export const SEARCH_CODE_EMPTY_STREAK_THRESHOLD_MAIN = 3;
/** search_code 空搜引导阈值：子代理（预算更紧，更早引导）。 */
export const SEARCH_CODE_EMPTY_STREAK_THRESHOLD_SUBAGENT = 2;

/**
 * search_code 空搜引导阈值（数据驱动，按 agentId 类型）。
 * 子代理（agentId 前缀 subagent-，搜索任务多为 explore 型）预算更紧，需更早从
 * grep 空转切到 search_graph，故阈值更低（2）；主 agent 阈值 3。
 * （日志 1785237941547：explore 子代理 search_code 91% 空仍死磕 grep、零 search_graph。）
 */
export function searchCodeEmptyStreakThresholdFor(agentId: string | undefined): number {
	return (agentId ?? '').startsWith('subagent-')
		? SEARCH_CODE_EMPTY_STREAK_THRESHOLD_SUBAGENT
		: SEARCH_CODE_EMPTY_STREAK_THRESHOLD_MAIN;
}
