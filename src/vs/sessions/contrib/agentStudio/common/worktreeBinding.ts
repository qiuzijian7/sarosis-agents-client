/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Worktree 绑定判定 —— agentDriverService（工作根/提示词）与 workspaceSecurity（工具沙箱）
 * 的**唯一共享口径**。
 *
 * ## 背景（2026-08-20，日志 1787211923566）
 *
 * 用户报「我用的是 main 分支，为什么会检索 feat-chat 分支」。排查发现 workspace 层
 * 干净（`0 relatedFolder(s)`、`worktreePath=<none>`、`git branch --show-current`=main），
 * 但 `AgentBinding.worktreePath` 残留指向 `.worktrees/feat-chat` —— 该绑定是
 * **agent 实例级持久化状态，与 git 分支无关，切分支不会自动解除**，于是注入提示词的
 * 工作根是落后分支（feat-chat 停在 d8d0b137，main 已到 862b912e），模型在旧代码里
 * 反复找不到目标 → 换参重搜 → 跑满 50 轮迭代 → 输出大量重复文字。
 *
 * 同一份日志还暴露一个真实缺陷：`worktreePath` **可以等于主仓路径**
 * （用户在 UI 里把 agent 绑回主仓 / 选择 "main"），但此前两处调用点都
 * **无条件**把它当作 worktree：
 *   - `agentDriverService`：`_composeWorkspaceContextText(..., isWorktree: true)`
 *     → 提示词谎称「你运行在一个与主仓隔离的 worktree 分支内」；且该分支会
 *     **跳过 auto-sync**，工作根不再跟随 VS Code 当前打开的文件夹。
 *   - `workspaceSecurity`：走 worktree「独占沙箱」分支而非常规多根分支
 *     → `worktreeStrictIsolation=true` 时会少放行 VS Code 工作区文件夹与
 *     relatedFolders，多根工程（引擎 + 项目）里读引擎源码会被误拦。
 *
 * 因此：**worktreePath 与 workspace 主路径等价时，视为「未绑定 worktree」**。
 */

/**
 * 路径规范化（仅用于等价比较，不用于实际 IO）。
 *
 * 统一分隔符为 `/`、去尾部分隔符；Windows 下同时忽略大小写与盘符大小写差异。
 * 之所以不用 `extUri.isEqual`：本模块被 common 层（无 URI 上下文）与
 * browser 层共用，且比较对象是已落库的**字符串**路径（可能来自不同来源，
 * 混用 `\` 与 `/`，如日志中同时出现
 * `G:/CustomWorkspaces/.../feat-chat` 与 `g:\CustomWorkspaces\...`）。
 */
export function normalizeWorktreePathForCompare(p: string | undefined): string | undefined {
	if (!p) { return undefined; }
	const unified = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
	if (!unified) { return undefined; }
	// Windows 路径大小写不敏感；POSIX 下保留原样以免误判同名不同大小写目录
	return isWindowsLikePath(unified) ? unified.toLowerCase() : unified;
}

/** 粗判是否 Windows 风格路径（盘符 `X:` 开头或 UNC `//host`）。 */
function isWindowsLikePath(unifiedPath: string): boolean {
	return /^[a-zA-Z]:\//.test(unifiedPath) || unifiedPath.startsWith('//');
}

/**
 * 解析「有效的 worktree 绑定」。
 *
 * @param worktreePath `AgentBinding.worktreePath`（可能为空、可能等于主仓路径）
 * @param workspacePath 该 agent 所属 Saros workspace 的主路径
 * @returns 规范化并去尾斜杠后的 worktree 根；若未绑定、或绑定目标就是主仓本身
 *          （即"其实没有隔离"），返回 `undefined` —— 调用方据此走常规多根逻辑。
 *
 * 注意返回的是**原始形态**（仅去尾部分隔符）而非小写化结果，避免把
 * 大小写敏感环境下的真实路径改坏；小写化只发生在内部比较。
 */
export function resolveEffectiveWorktreeRoot(
	worktreePath: string | undefined,
	workspacePath: string | undefined,
): string | undefined {
	const trimmed = worktreePath?.replace(/[\\/]+$/, '');
	if (!trimmed) { return undefined; }
	const a = normalizeWorktreePathForCompare(trimmed);
	const b = normalizeWorktreePathForCompare(workspacePath);
	if (a && b && a === b) {
		// 绑定目标 == 主仓：不是真正的 worktree 隔离
		return undefined;
	}
	return trimmed;
}

/** `.worktrees/<branch>/` 容器目录名（与 dev-worktree.ps1 及 COMMON_EXCLUDE_DIRS 一致）。 */
const WORKTREE_CONTAINER_DIRS = ['.worktrees', '.worktree'] as const;

/**
 * 「越界访问未绑定的 worktree 副本」检测（2026-08-20，日志 1787217670299）。
 *
 * ## 为什么需要它：搜索与读写的结构性不对称
 *
 * `.worktrees/**` 对 **搜索/索引** 是硬排除的（`searchHelpers.DEFAULT_EXCLUDE_GLOBS`
 * / `NOISE_DIR_NAMES` / `codebaseIndexDefaults.COMMON_EXCLUDE_DIRS`，理由是 3 份
 * worktree 副本让 `.ts` 数量从 9112 膨胀到 33480，且全是其他分支的过期代码）。
 *
 * 但对 **file_read / file_write / patch / execute_code** 却完全可达：
 *   - `workspaceSecurity` 明确「仅写/删触发沙箱判定，读操作直接返回已解析路径」；
 *   - 写操作因主仓根本身是 allowedRoot，其子目录 `.worktrees/**` 天然放行；
 *   - `execute_code` 是 shell，对 `cd` 没有任何路径约束。
 *
 * 后果（实测）：模型拿到一个 `.worktrees/feat-chat/...` 路径后，search_code 永远
 * 配合不上（根是主仓且该目录被排除）→ 它改用 shell 当搜索引擎（28 次 execute_code
 * vs 3 次 search_code），并在**落后分支的过期副本**里找主仓才有的符号，连续 10+ 轮
 * 一无所获（`findstr` exit 1），而同一批符号在主仓 search_code 一次即命中。
 *
 * @param resolvedPath 已解析的绝对路径（或任意含 `.worktrees/<name>/` 的路径串）
 * @param boundWorktreeRoot 当前 agent **实际绑定**的 worktree 根（`resolveEffectiveWorktreeRoot`
 *        的结果）。落在该根内的访问是合法的（用户就是要在这个 worktree 里干活）。
 * @returns 命中越界时返回诊断信息；合法/无关路径返回 `undefined`。
 */
export function detectStaleWorktreeAccess(
	resolvedPath: string | undefined,
	boundWorktreeRoot: string | undefined,
): { worktreeRoot: string; branchName: string; mainRepoEquivalent: string } | undefined {
	const unified = String(resolvedPath ?? '').replace(/[\\/]+/g, '/');
	if (!unified) { return undefined; }
	const lower = unified.toLowerCase();

	// 定位 `/<container>/<branch>/` 段。必须要求容器目录后还有一段分支名，
	// 否则 `.../.worktrees` 本身（列目录）会被误判。
	let containerIdx = -1;
	let container = '';
	for (const dir of WORKTREE_CONTAINER_DIRS) {
		const idx = lower.indexOf(`/${dir}/`);
		if (idx >= 0 && (containerIdx < 0 || idx < containerIdx)) {
			containerIdx = idx;
			container = dir;
		}
	}
	if (containerIdx < 0) { return undefined; }

	const afterContainer = containerIdx + container.length + 2; // `/` + dir + `/`
	const rest = unified.slice(afterContainer);
	const slashInRest = rest.indexOf('/');
	const branchName = slashInRest >= 0 ? rest.slice(0, slashInRest) : rest;
	if (!branchName) { return undefined; }

	const repoRoot = unified.slice(0, containerIdx);            // `.worktrees` 的父目录 = 主仓根
	const worktreeRoot = `${repoRoot}/${container}/${branchName}`;
	const tail = slashInRest >= 0 ? rest.slice(slashInRest + 1) : '';

	// 已绑定该 worktree（或其子目录）→ 合法访问，不干预。
	const boundNorm = normalizeWorktreePathForCompare(boundWorktreeRoot);
	if (boundNorm) {
		const wtNorm = normalizeWorktreePathForCompare(worktreeRoot);
		// 绑定根等于该 worktree，或绑定根就在该 worktree 内部（更深的子目录绑定）
		if (wtNorm && (wtNorm === boundNorm || boundNorm.startsWith(`${wtNorm}/`))) {
			return undefined;
		}
	}

	return {
		worktreeRoot,
		branchName,
		mainRepoEquivalent: tail ? `${repoRoot}/${tail}` : repoRoot,
	};
}

/**
 * 越界访问 worktree 的统一提示文案（工具层复用，保证口径一致）。
 * `action` 用于区分场景，如 `'read'` / `'write'` / `'shell command'`。
 */
export function staleWorktreeWarning(
	info: { worktreeRoot: string; branchName: string; mainRepoEquivalent: string },
	action: string,
): string {
	return (
		`[worktree-warning] This ${action} targets the git worktree copy "${info.branchName}" ` +
		`(${info.worktreeRoot}), which this agent is NOT bound to. ` +
		'That directory is a separate checkout of a DIFFERENT branch and is usually STALE. ' +
		'It is also excluded from search_code / search_files / the code graph, so content search ' +
		'can never corroborate what you read there. ' +
		`Use the main-repository path instead: ${info.mainRepoEquivalent}`
	);
}
