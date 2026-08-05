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
 * path_filter 清洗（P1，2026-07-29，kimi 搜索根模型）：
 * 剥 globstar 与 `./` 前缀及「根目录名首段」（UE5EA/Engine/... → Engine/...，
 * 事故 1785228894680）；绝对路径直通。返回 '' 表示不过滤（裸根名 UE5EA）。
 * 输出再按是否含 `*` 分流：含 `*` → includePattern glob；否则 → 搜索根。
 * （注：块注释中不写 globstar+斜杠 连排——其含注释终止序列。）
 */
export function normalizeSearchPathFilter(pathFilter: string, rootDirNames: readonly string[]): string {
	let s = String(pathFilter ?? '').replace(/\\/g, '/').trim();
	for (;;) {
		if (s.startsWith('**/')) { s = s.slice(3); continue; }
		if (s.startsWith('./')) { s = s.slice(2); continue; }
		break;
	}
	if (!s) { return ''; }
	// 绝对路径（f:/... 或 /...）直通（搜索根语义，不进 includePattern）
	if (/^[a-zA-Z]:\//.test(s) || s.startsWith('/')) { return s.replace(/\/+$/, ''); }
	// 首段 = 某根目录名（不区分大小写、非 glob）→ 剥掉；剥空 = 不过滤（裸根名）
	const firstSeg = s.split('/')[0];
	if (firstSeg && !firstSeg.includes('*')
		&& rootDirNames.some(n => n.length > 0 && n.toLowerCase() === firstSeg.toLowerCase())) {
		return s.slice(firstSeg.length).replace(/^\/+/, '');
	}
	return s;
}

/**
 * 清洗后的 path_filter（无 `*`）→ 搜索根候选绝对路径。
 * 绝对路径单候选直通；相对路径在各 workspace root 下展开。
 * 返回顺序即优先级；调用方逐个 stat，取首个存在者。
 */
export function searchRootCandidates(cleanedPath: string, workspaceRoots: readonly string[]): string[] {
	const pf = String(cleanedPath ?? '').replace(/\\/g, '/').trim().replace(/\/+$/, '');
	if (!pf || pf.includes('*')) { return []; }
	if (/^[a-zA-Z]:\//.test(pf) || pf.startsWith('/')) { return [pf]; }
	return workspaceRoots
		.map(r => String(r ?? '').replace(/\\/g, '/').replace(/\/+$/, ''))
		.filter(root => root.length > 0)
		.map(root => `${root}/${pf}`);
}

/**
 * search_code 空命中引导（P3，2026-07-29 三合一：include 过严 / 无过滤符号幻觉 /
 * 连空换工具）。替换旧的 noMatchWithIncludeHint + noMatchNoFilterHint +
 * searchCodeEmptyStreakHint 三个函数——调用方一次调用即可。
 *
 * @param includeGlob 本次 include 过滤（有则提示过滤过严，无则引导验证符号名）
 * @param streak      连续 0 命中连击数
 * @param shouldGuide 连击是否达阈值（达则追加"换 search_graph"强引导）
 * @param walkDegraded 本次是否处于 ripgrep 不可用降级（2026-08-05，日志 1785894964584：
 *        降级时不得声称 include 过滤已生效——walk 回退的过滤语义不同且大目录可能未扫全）
 */
export function searchOutcomeHint(includeGlob: string | undefined, streak: number, shouldGuide: boolean, walkDegraded = false): string {
	const parts: string[] = [];
	if (walkDegraded) {
		parts.push(
			'ripgrep is unavailable in this environment — content search ran as a slow directory walk ' +
			'(file-name filter applied, but very large trees may be only partially scanned before the visit cap). ' +
			'Prefer: (1) narrow path_filter to an exact subdirectory or file path, (2) file_read on the known path, ' +
			'or (3) search_files to locate the exact file first.'
		);
	} else if (includeGlob) {
		parts.push(
			`0 matches with include filter "${includeGlob}". The path filter may be too restrictive: ` +
			'paths are matched RELATIVE to each project root — do NOT prefix with the root folder name. ' +
			'Consider retrying without path_filter.'
		);
	} else {
		parts.push(
			'No matches anywhere (no path filter applied). The symbols likely do not exist as written — ' +
			'verify the exact name first with search_files (file lookup) or search_graph (structural search), rather than rewriting the query with more guesses.'
		);
	}
	if (shouldGuide) {
		parts.push(
			`search_code returned no matches ${streak} times in a row. Rewriting the query with more symbol guesses is not working — ` +
			'STOP retrying search_code with similar queries. Instead: (1) use search_graph / query_graph for semantic/structural lookup, ' +
			'or (2) run search_files to confirm the exact symbol/file name first, or (3) drop path_filter and search wider.'
		);
	}
	return '\n[tool-hint] ' + parts.join('\n[tool-hint] ');
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

/**
 * glob → RegExp（Node-walk 回退路径的文件名过滤，2026-08-05，日志 1785894964584）。
 *
 * 背景：ripgrep 不可用时 walk 回退此前**丢弃 fileGlob**（形参下划线前缀），
 * 指定文件名过滤完全失效 → 全树逐文件 grep，5000 文件预算在 Engine/Plugins
 * 等噪声目录耗尽，永远到不了 Engine/Source（12+ 次 search_code 恒 27-32s 全 no matches）。
 *
 * 转换规则：
 *  - 剥离开头 globstar+斜杠（任意深度语义由 `(^|.../)` 前缀表达）；
 *  - globstar → 跨目录任意序列（用可打印占位串防被单 `*` 规则二次吃掉——
 *    既有 `_globToRegex`/`globToRegex` 内联版均踩过此坑：globstar 先转 `.*`，
 *    其中的 `*` 又被后续规则转成 `[^/]*`，退化为「恰好一层目录」；
 *    注意勿用控制字符占位——经工具链写入时会丢失成空串）；
 *  - 单 `*` → 不跨目录；`?` → 单非分隔字符；`{a,b}` → `(a|b)`；
 *  - 纯 globstar 输入返回 undefined（= 不过滤）。
 *
 * 匹配目标：以 `(^|.../)` 前缀锚定路径段边界，对绝对路径与根相对路径均可用
 * （比 ripgrep 的根锚定语义略宽，回退场景宁宽勿漏）。
 */
export function globToRegexForSearch(glob: string): RegExp | undefined {
	let g = String(glob ?? '').replace(/\\/g, '/').trim();
	if (!g) { return undefined; }
	// 纯 globstar（任意深度全匹配）= 不过滤
	if (/^(\*\*\/)*\*\*$/.test(g)) { return undefined; }
	while (g.startsWith('**/')) { g = g.slice(3); }
	if (!g) { return undefined; }
	const body = g
		.replace(/[.+^$()|[\]\\]/g, '\\$&')
		.replace(/\{(.*?)\}/g, (_m, inner) => '(' + String(inner).replace(/,/g, '|') + ')')
		.replace(/\*\*/g, '@@GS@@')           // 占位：防被单 * 规则吃掉
		.replace(/\*/g, '[^/]*')
		.replace(/\?/g, '[^/]')
		.replace(/@@GS@@/g, '.*');            // 还原 globstar
	return new RegExp('(^|.*/)' + body + '$', 'i');
}
