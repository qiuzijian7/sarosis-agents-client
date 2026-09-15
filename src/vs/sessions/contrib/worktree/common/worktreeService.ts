/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IObservable } from '../../../../base/common/observable.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorktreeDetail, ICreateWorktreeInfo, IWorktreeInfoOptions, IWorktreeInfo, WorktreeStatus, IWorktreeStateEvent, IWorktreeCleanupCandidate, IWorktreeCleanupOptions, IWorktreeCleanupResult } from './worktreeTypes.js';

export const IWorktreeService = createDecorator<IWorktreeService>('worktreeService');

/**
 * The worktree the user has explicitly selected by clicking an item in the
 * Worktree view. Used to drive the Changes view (sessions-customized
 * ChangesViewModel) to show this worktree's working-tree diff, independently of
 * the active session. `path` is the worktree directory; `branch` is its checked
 * out branch (for the header label).
 */
export interface ISelectedWorktree {
	readonly path: string;
	readonly branch?: string;
}

/**
 * Service for managing git worktrees in the sessions window.
 * Delegates git operations via the shared-process ILocalGitService or
 * direct git execution.
 *
 * Supports opencode-compatible two-phase creation:
 *   1. makeWorktreeInfo() → compute name/branch/directory (no git yet)
 *   2. createFromInfo() → git worktree add + boot (async)
 */
export interface IWorktreeService {
	readonly _serviceBrand: undefined;

	/** Event fired when worktree list changes */
	readonly onDidChangeWorktrees: Event<void>;

	/** Event fired when a worktree's lifecycle status changes (pending/ready/failed) */
	readonly onDidChangeWorktreeState: Event<IWorktreeStateEvent>;

	/**
	 * Event fired after a worktree is removed.
	 * Payload is the absolute directory path of the removed worktree.
	 * Consumers (e.g. AgentStudioService) use this to clear stale worktree
	 * bindings on agents/workspaces that pointed at the removed directory.
	 */
	readonly onDidRemoveWorktree: Event<string>;

	/**
	 * The worktree the user has explicitly selected in the Worktree view.
	 * `undefined` means "follow the active session" (default behaviour).
	 *
	 * The Changes view (ChangesViewModel) observes this and, when set, shows
	 * the selected worktree's diff instead of the active session's diff. This
	 * is the cross-contrib channel that lets clicking a worktree item switch
	 * the Changes/Graph content without owning a ChangesViewModel reference
	 * (it is created via createInstance, not a singleton).
	 */
	readonly selectedWorktree: IObservable<ISelectedWorktree | undefined>;

	/**
	 * Set (or clear with `undefined`) the explicitly selected worktree. Called
	 * by the Worktree view when an item is clicked.
	 */
	setSelectedWorktree(selection: ISelectedWorktree | undefined): void;

	/**
	 * List all worktrees for the given repository path.
	 * @param repoPath Absolute path to the git repository root
	 */
	listWorktrees(repoPath: string): Promise<IWorktreeDetail[]>;

	/**
	 * Create a new worktree (legacy single-phase).
	 */
	createWorktree(info: ICreateWorktreeInfo): Promise<IWorktreeDetail>;

	/**
	 * Phase 1: Generate worktree info without executing git commands.
	 * Computes a slugified name, branch name, and directory path.
	 * Checks for conflicts (existing directory, existing branch).
	 * Compatible with opencode's makeWorktreeInfo pattern.
	 */
	makeWorktreeInfo(options?: IWorktreeInfoOptions): Promise<IWorktreeInfo>;

	/**
	 * Phase 2: Create the worktree from pre-computed info.
	 * Executes: git worktree add --no-checkout [-b branch] dir
	 * Then: git reset --hard (populate files)
	 * Emits onDidChangeWorktreeState with Pending → Ready/Failed.
	 * Compatible with opencode's createFromInfo pattern.
	 */
	createFromInfo(info: IWorktreeInfo): Promise<void>;

	/**
	 * Reset a worktree to the default branch state.
	 * Executes: git fetch + git reset --hard + git clean -ffdx + submodule update.
	 * Compatible with opencode's reset pattern.
	 */
	resetWorktree(worktreePath: string): Promise<void>;

	/**
	 * Remove (delete) a worktree.
	 * Enhanced with opencode pattern: stops fsmonitor, force remove, cleanup directory, delete branch.
	 * @param worktreePath Absolute path of the worktree to remove
	 * @param force Whether to force removal even with uncommitted changes
	 */
	removeWorktree(worktreePath: string, force?: boolean): Promise<void>;

	/**
	 * Prune stale worktree metadata.
	 * @param repoPath Absolute path to the git repository root
	 */
	pruneWorktrees(repoPath: string): Promise<void>;

	// ─── Lock / Unlock（★ 2026-09-15 补）────────────────────────────
	//
	// `locked` 此前**只解析不操作**：UI 已经能显示锁定图标与 `WorktreeIsLocked`
	// 上下文键，但没有任何入口能真的上锁。补上这半边。
	//
	// 语义（git 原生）：被 lock 的 worktree **不会**被 `git worktree prune` 回收，
	// 也不会被 `git worktree remove` 删除（除非 --force）。用于保护"正在被某个
	// 长任务使用、但目录暂时看起来是空的/不可达的"工作树 —— 例如网络盘、或
	// 正在被另一台机器挂着的目录。

	/**
	 * 给 worktree 上锁（`git worktree lock`），使其不被 `prune` 回收。
	 * @param worktreePath worktree 绝对路径
	 * @param reason 可选的锁定理由（`--reason`，会出现在 `git worktree list` 输出里）
	 */
	lockWorktree(worktreePath: string, reason?: string): Promise<void>;

	/** 解除 worktree 的锁（`git worktree unlock`）。 */
	unlockWorktree(worktreePath: string): Promise<void>;

	// ─── Cleanup（★ 2026-09-15 补）──────────────────────────────────

	/**
	 * **只读**扫描清理候选：陈旧 worktree + 孤儿分支。
	 *
	 * 本方法**不做任何修改**。删除必须由调用方在用户确认后调 {@link cleanupWorktrees}。
	 *
	 * 判据（两条都要求「**没有未推送提交**」—— 那是会丢的真实工作）：
	 *   · `stale-worktree`：非主树、未锁定、无未推送提交，且目录 mtime 早于阈值；
	 *   · `orphan-branch`：在 {@link WORKTREE_BRANCH_PREFIX} 命名空间内、没有任何
	 *     worktree 占用它、且无未推送提交（历史 bug 导致删 worktree 时分支没被删，
	 *     这类分支会只增不减）。
	 *
	 * @param repoPath git 仓库根
	 * @param options.staleAfterMs 陈旧阈值，默认 {@link DEFAULT_STALE_WORKTREE_MS}（14 天）
	 */
	listCleanupCandidates(repoPath: string, options?: IWorktreeCleanupOptions): Promise<IWorktreeCleanupCandidate[]>;

	/**
	 * 执行清理（对给定候选逐个删除）。
	 *
	 * ⚠ **必须由用户确认后调用** —— 本方法自身不做二次确认。
	 * 逐个执行、失败不中断（结果里 `removed` / `failed` 分开返回）。
	 */
	cleanupWorktrees(repoPath: string, candidates: readonly IWorktreeCleanupCandidate[]): Promise<IWorktreeCleanupResult>;

	/**
	 * Launch the worktree's VsSaros instance ("debug" the worktree): compile
	 * the worktree's out/ (transpile-client) then start a dev-mode instance
	 * that loads that worktree's source. Reuses the main repo's electron binary
	 * (which is decoupled from the code directory), so no re-packaging needed.
	 *
	 * @param worktreePath Absolute directory path of the worktree.
	 * @returns success flag + stderr on failure.
	 */
	launchDebug(worktreePath: string): Promise<{ success: boolean; stderr: string }>;

	/**
	 * Resolve the "debug in terminal" plan for a worktree: detect the project type
	 * and return the build + launch commands (without executing them). The caller
	 * runs them in the integrated terminal so the user sees the compile output live.
	 */
	resolveDebugPlan(worktreePath: string): Promise<{ success: boolean; strategy?: string; label?: string; buildCommand?: string; launchCommand?: string; env?: Record<string, string>; stderr?: string }>;

	/**
	 * Get the repository root path for the current workspace.
	 * Returns undefined if no git repo is found.
	 */
	getRepositoryRoot(): Promise<string | undefined>;

	/**
	 * Get ALL repository root paths for the current workspace.
	 * Scans every workspace folder (home dir + related code folders + worktree)
	 * and returns those that contain a `.git` entry. Used by the Worktree view
	 * to list worktrees across all related repositories, not just the first.
	 */
	getAllRepositoryRoots(): Promise<string[]>;

	/**
	 * Filter the given candidate directory paths down to those that are git
	 * repository roots (contain a `.git` entry), de-duplicated and order-preserving.
	 *
	 * Unlike {@link getAllRepositoryRoots} this does NOT read the global VS Code
	 * workspace folders — the caller supplies the exact candidate set. The
	 * Worktree view uses this to scope the list to ONLY the active workspace's
	 * related code repositories, instead of whatever mixed roots happen to be
	 * injected into the global folder set (home dir, sibling worktrees, etc.).
	 *
	 * @param candidatePaths Absolute directory paths to probe.
	 */
	filterGitRepositoryRoots(candidatePaths: readonly string[]): Promise<string[]>;

	/**
	 * Get the current lifecycle status of a worktree by its directory path.
	 */
	getWorktreeState(directory: string): WorktreeStatus;

	/**
	 * Wait for a worktree to reach Ready or Failed status.
	 * Returns the final status. Useful for session creation flow.
	 */
	waitForWorktreeReady(directory: string, timeoutMs?: number): Promise<WorktreeStatus>;

	/**
	 * Get the default branch name for the repository (e.g. "main", "master").
	 */
	getDefaultBranch(repoPath: string): Promise<string>;

	/**
	 * List local git branches that are NOT currently checked out by any worktree.
	 * Used for the "create worktree" flow to avoid branch conflicts.
	 * @param repoPath Absolute path to the git repository root
	 */
	listGitBranches(repoPath: string): Promise<string[]>;

	// ─── Extended metadata (VS Code compatible) ─────────────────────

	/**
	 * Get extended metadata for a worktree (base commit, PR info, change counts).
	 * This enriches the basic IWorktreeDetail with information that requires
	 * additional git commands (beyond `git worktree list`).
	 */
	getWorktreeMetadata(worktreePath: string): Promise<Partial<IWorktreeDetail>>;

	/**
	 * Get the list of changed files in a worktree compared to its base.
	 * Returns file paths with their change status (added/modified/deleted).
	 * Compatible with VS Code's getWorktreeChanges.
	 */
	getWorktreeChanges(worktreePath: string): Promise<readonly { filePath: string; status: 'added' | 'modified' | 'deleted' }[]>;

	/**
	 * Refresh worktree metadata (re-fetch from git).
	 * Triggers onDidChangeWorktreeState event if metadata changed.
	 */
	refreshWorktreeMetadata(worktreePath: string): Promise<void>;

	/**
	 * Check if a worktree has uncommitted changes.
	 * Quick check without full diff - uses `git status --porcelain`.
	 */
	hasUncommittedChanges(worktreePath: string): Promise<boolean>;

	/**
	 * ★ 该 worktree 是否有**未推送到任何 remote** 的提交。
	 *
	 * 用于「删 worktree 时要不要连带删分支」的判据 —— 与 hermes-agent-studio 一致：
	 * **未推送的提交 = 会丢的真实工作**，此时保留分支（只删工作目录）；已推送的才删。
	 *
	 * 实现：`git log --oneline HEAD --not --remotes`（无输出 ⇒ 全部已推送）。
	 * ⚠ 仓库**没有任何 remote** 时该命令不会排除任何提交 ⇒ 恒为 true ⇒ 分支只增不减。
	 *   那种情况下不存在"推送"这个去处，故显式返回 false。
	 */
	hasUnpushedCommits(worktreePath: string): Promise<boolean>;

	// ─── Checkpoint lifecycle (VS Code compatible) ─────────────────

	/**
	 * Notify that a request is starting for a session.
	 * This triggers baseline checkpoint creation.
	 * @param sessionId The session ID
	 * @param worktreePath The worktree path
	 */
	notifyRequestStart(sessionId: string, worktreePath: string): Promise<void>;

	/**
	 * Notify that a request has completed for a session.
	 * This triggers post-turn checkpoint creation.
	 * @param sessionId The session ID
	 * @param worktreePath The worktree path
	 * @param requestId The request ID
	 */
	notifyRequestComplete(sessionId: string, worktreePath: string, requestId: string): Promise<void>;
}
