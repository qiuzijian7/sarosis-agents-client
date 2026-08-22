/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「搜索根显式指向被默认排除的目录」时的排除项放行决策（纯逻辑，零依赖，可单测）。
 *
 * ## 事故（2026-08-22，日志 1787363991734）
 *
 * 模型连续 **7 次 `search_code`** 想在 `@comfyorg/litegraph` 的 bundle 里找符号
 * （`over_link_center` / `getLinkCenter` / `drawLink` …），全部 0 命中，最后退化为
 * 用 `execute_code` 跑 python 脚本 `open(...).read()` + `re.finditer` 手工扫文件。
 *
 * 脚本本身只读、合法（源码写入护栏正确放行），但这是被工具能力缺口逼出来的次优路径：
 * 无索引、全文件读入内存、输出不受搜索工具的截断保护（命中数一多直接炸上下文）。
 *
 * ## 实测确认的两层独立阻碍（缺一层都搜不到）
 *
 * 用仓内 ripgrep 对 `.../webview/node_modules/@comfyorg/litegraph/dist` 实测：
 *
 * | 条件 | 结果 |
 * |---|---|
 * | 无 exclude（默认遵守 .gitignore） | **0 命中** ← 第一层：`.gitignore` |
 * | `--no-ignore` | 3 文件命中（litegraph.es.js 7 处）|
 * | `--no-ignore` + `!**&#47;node_modules/**` | **0 命中** ← 第二层：exclude glob |
 *
 * 也就是说：
 *  1. **`.gitignore`** —— `node_modules` 在其中，ripgrep 默认跳过。对应
 *     `IFolderQuery.disregardIgnoreFiles`。
 *  2. **`DEFAULT_EXCLUDE_GLOBS`** —— `**&#47;node_modules/**` 按**完整路径**匹配，
 *     即便搜索根已经指到 node_modules 内部依然生效。
 *
 * ⚠ 这同时证伪了 `DEFAULT_EXCLUDE_GLOBS` 中 `.worktrees` 的注释所称「需要跨 worktree
 * 检索时显式传 path_filter 指向具体 worktree 即可绕过本排除」—— **实际绕不过**。
 * 本模块一并修正该行为。
 *
 * ## 决策原则
 *
 * **「用户/模型显式把搜索根指向某个默认被排除的目录」本身就是最强的意图表达** ——
 * 此时继续排除它是自相矛盾的（必然 0 结果，且不给任何解释）。故：
 *
 *  - 只放行**搜索根路径里实际出现的那些**目录名，其余排除项全部保留。
 *    例：根 = `…/node_modules/@comfyorg/litegraph/dist` → 放行 `node_modules` 与
 *    `dist`（该 bundle 恰好位于 `dist/` 下，两层都得放行才搜得到），但 `.git`、
 *    `out`、`coverage` 等照旧排除。
 *  - 命中任一项即同时置 `disregardIgnoreFiles` —— 否则第一层 `.gitignore` 仍会拦。
 *
 * 这样既不放宽默认搜索面（无显式根时行为完全不变），又让「我就是要搜这里」可达。
 */

/** 放行决策结果。 */
export interface ISearchScopeOverride {
	/** 需要从 exclude IExpression 中移除的 glob key（如 `**&#47;node_modules/**`）。 */
	readonly excludeGlobsToDrop: readonly string[];
	/** walk-fallback 需要放行的目录名（等价效果）。 */
	readonly noiseDirsToDrop: ReadonlySet<string>;
	/** 是否绕过 `.gitignore` / 全局 ignore（第一层阻碍）。 */
	readonly disregardIgnoreFiles: boolean;
	/** 是否产生了任何放行（便于调用方决定是否打日志）。 */
	readonly hasOverride: boolean;
	/** 人类可读原因，用于日志复盘。 */
	readonly reason: string;
}

/** 无放行的常量结果（无显式根的绝大多数调用走这里，零分配）。 */
const NO_OVERRIDE: ISearchScopeOverride = {
	excludeGlobsToDrop: [],
	noiseDirsToDrop: new Set<string>(),
	disregardIgnoreFiles: false,
	hasOverride: false,
	reason: 'search root does not point into any excluded directory',
};

/**
 * 把路径切成目录段。同时按 `/` 与 `\` 切分 —— Windows 上两种分隔符会混用
 * （日志实测模型同一会话里既传 `g:\a\b` 也传 `/g/a/b`）。
 */
function _pathSegments(p: string): string[] {
	return p.split(/[\\/]+/).filter(s => s.length > 0);
}

/**
 * 计算放行决策。
 *
 * @param resolvedPath 已解析的搜索根（绝对路径）。
 * @param noiseDirNames 默认被排除的**目录名**集合（`NOISE_DIR_NAMES`）。用目录名而非
 *        glob 做判据，因为 glob 形态多样（`**&#47;x/**`、`**&#47;x`），目录名唯一。
 */
export function computeSearchScopeOverride(
	resolvedPath: string | undefined,
	noiseDirNames: ReadonlySet<string>,
): ISearchScopeOverride {
	if (!resolvedPath) { return NO_OVERRIDE; }

	const hits = new Set<string>();
	for (const seg of _pathSegments(resolvedPath)) {
		if (noiseDirNames.has(seg)) { hits.add(seg); }
	}
	if (hits.size === 0) { return NO_OVERRIDE; }

	// 同一目录名可能对应多种 glob 形态，两种都移除（`**/x` 用于 DEFAULT_EXCLUDE_GLOBS
	// 里的文件级条目，如 `**/.env`；`**/x/**` 用于目录级）。移除不存在的 key 无副作用。
	const globs: string[] = [];
	for (const d of hits) {
		globs.push(`**/${d}/**`);
		globs.push(`**/${d}`);
	}

	const names = [...hits].sort().join(', ');
	return {
		excludeGlobsToDrop: globs,
		noiseDirsToDrop: hits,
		// 第一层：这些目录基本都在 .gitignore 中，不 disregard 则 ripgrep 依旧跳过。
		disregardIgnoreFiles: true,
		hasOverride: true,
		reason: `search root explicitly points into excluded dir(s): ${names} — allowing them for this query`,
	};
}

/**
 * 应用放行：返回移除了指定 key 的新 IExpression。
 *
 * 不原地改传入对象 —— 调用方的 exclude 表是**进程级缓存**（`_effectiveExcludeExprCache`），
 * 原地删除会永久污染后续所有搜索（把一次性放行变成全局放宽）。
 */
export function applyExcludeOverride(
	expr: Readonly<Record<string, boolean>>,
	override: ISearchScopeOverride,
): Record<string, boolean> {
	const out: Record<string, boolean> = { ...expr };
	for (const g of override.excludeGlobsToDrop) { delete out[g]; }
	return out;
}

/**
 * 应用放行：返回移除了指定目录名的新集合（walk-fallback 用）。
 *
 * 同样不改传入集合（`NOISE_DIR_NAMES` 是 static readonly，改了会污染全局）。
 */
export function applyNoiseDirsOverride(
	dirs: ReadonlySet<string>,
	override: ISearchScopeOverride,
): ReadonlySet<string> {
	if (!override.hasOverride) { return dirs; }
	const out = new Set(dirs);
	for (const d of override.noiseDirsToDrop) { out.delete(d); }
	return out;
}
