/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parsed output item from `git worktree list --porcelain`
 */
export interface IWorktreeOutputItem {
	/** Working tree path */
	worktree: string;
	/** HEAD commit hash */
	HEAD: string;
	/** Whether HEAD is detached */
	detached: boolean;
	/** Branch name (if not detached) */
	branch?: string;
	/** Whether this is the main worktree */
	isMain: boolean;
	/** Prunable info */
	prunable?: string;
	/** Locked reason */
	locked?: string;
	/** Whether this is a bare repository */
	isBare: boolean;
}

/**
 * Detailed information about a git worktree
 */
export interface IWorktreeDetail {
	/** Display name (branch name or detached HEAD short hash) */
	name: string;
	/** Absolute file system path */
	path: string;
	/** Full commit hash */
	hash: string;
	/** Whether HEAD is detached */
	detached: boolean;
	/** Whether this worktree is prunable */
	prunable: boolean;
	/** Whether this is a bare worktree */
	isBare: boolean;
	/** Whether the worktree is on a branch (vs detached/tag) */
	isBranch: boolean;
	/** Whether the worktree is locked */
	locked: boolean;
	/** Whether this is the main worktree */
	isMain: boolean;
	/** The main worktree folder path */
	mainFolder: string;
	/** Branch name if on a branch */
	branch?: string;

	// ─── Extended metadata (VS Code compatible) ─────────────────────────
	/** Base commit hash (the commit this worktree was created from) */
	baseCommit?: string;
	/** Base branch name (e.g. "main", "master") */
	baseBranch?: string;
	/** Upstream branch (e.g. "origin/feature-xyz") */
	upstreamBranch?: string;
	/** Pull request URL if this branch has an associated PR */
	pullRequestUrl?: string;
	/** Pull request state ("open", "closed", "merged") */
	pullRequestState?: string;
	/** Number of incoming changes (commits from remote) */
	incomingChanges?: number;
	/** Number of outgoing changes (local commits not pushed) */
	outgoingChanges?: number;
	/** Number of uncommitted changes (working tree modifications) */
	uncommittedChanges?: number;
	/** Whether this worktree has a GitHub remote */
	hasGitHubRemote?: boolean;
	/** Last commit message (for display in UI) */
	lastCommitMessage?: string;
}

/**
 * Information needed to create a new worktree
 */
export interface ICreateWorktreeInfo {
	/** Target folder path for the new worktree */
	folderPath: string;
	/** Name for the new worktree (branch name or display name) */
	name: string;
	/** Display label */
	label: string;
	/** Whether the reference is a branch */
	isBranch: boolean;
	/** Current working directory (repository root) */
	cwd: string;
}

/**
 * View and command identifiers for worktree management
 */
export const WORKTREE_VIEW_ID = 'sessions.worktree.list';
export const WORKTREE_VIEW_CONTAINER_ID = 'sessions.worktree.container';

export const enum WorktreeCommands {
	Refresh = 'sessions.worktree.refresh',
	Create = 'sessions.worktree.create',
	CreateWithBranch = 'sessions.worktree.createWithBranch',
	Delete = 'sessions.worktree.delete',
	Open = 'sessions.worktree.open',
	OpenInTerminal = 'sessions.worktree.openInTerminal',
	Remove = 'sessions.worktree.remove',
	Prune = 'sessions.worktree.prune',
	Reset = 'sessions.worktree.reset',
	/** ★ 2026-09-15：`git worktree lock` —— 保护 worktree 不被 `prune` 回收。 */
	Lock = 'sessions.worktree.lock',
	/** ★ 2026-09-15：解除 `lock`。 */
	Unlock = 'sessions.worktree.unlock',
	/** ★ 2026-09-15：扫描并清理陈旧 worktree / 孤儿分支（**先列候选再确认**，不自动删）。 */
	Cleanup = 'sessions.worktree.cleanup',
	/** ★ 2026-09-15：从该 worktree 的 checkpoint 列表里选一个回滚（先列后确认）。 */
	RollbackCheckpoint = 'sessions.worktree.rollbackCheckpoint',
}

export const enum WorktreeContextKeys {
	HasWorktrees = 'sessions.worktree.hasWorktrees',
	WorktreeCount = 'sessions.worktree.count',
	WorktreeIsMain = 'sessions.worktree.isMain',
	WorktreeIsDetached = 'sessions.worktree.isDetached',
	WorktreeIsLocked = 'sessions.worktree.isLocked',
	WorktreeIsPrunable = 'sessions.worktree.isPrunable',
}

/**
 * ★ 本仓自建 worktree 分支的命名空间。
 *
 * `makeWorktreeInfo()` 建的分支默认是 `<前缀><slug>`。提成常量是因为它曾经**漂移过**：
 * `removeWorktree()` 里删分支时写死了另一个前缀（`opencode/<name>`），
 * 于是分支从来没被删掉过（只增不减）。清理「孤儿分支」也必须用同一常量，
 * 否则又会扫错集合。
 */
export const WORKTREE_BRANCH_PREFIX = 'worktree/';

// ─── Cleanup（陈旧 worktree / 孤儿分支）─────────────────────────────────────

/** 清理候选的种类。 */
export type WorktreeCleanupKind = 'stale-worktree' | 'orphan-branch';

/**
 * 一条**清理候选**。
 *
 * ⚠ 这是**只读扫描**的结果，不代表已经被删除 —— 删除必须由用户确认后单独触发。
 * 本仓的 worktree 是用户长期资产（不是 hermes 那种一次性的），按龄自动删会销毁用户工作。
 */
export interface IWorktreeCleanupCandidate {
	readonly kind: WorktreeCleanupKind;
	/** worktree 目录（仅 `stale-worktree`）。 */
	readonly path?: string;
	/** 分支名（两种 kind 都可能有）。 */
	readonly branch?: string;
	/** 目录最后修改时间（ms epoch），用于展示「多久没动过」。 */
	readonly lastModifiedMs?: number;
	/** 被列为候选的**理由**（直接展示给用户，必须能自解释）。 */
	readonly reason: string;
}

export interface IWorktreeCleanupOptions {
	/** 超过这个时长未被修改的 worktree 才列为候选。默认 14 天。 */
	readonly staleAfterMs?: number;
}

/** 清理结果：成功与失败分开返回，避免「部分失败」被吞掉。 */
export interface IWorktreeCleanupResult {
	readonly removed: readonly string[];
	readonly failed: readonly { readonly target: string; readonly error: string }[];
}

/** `listCleanupCandidates()` 的默认陈旧阈值：14 天。 */
export const DEFAULT_STALE_WORKTREE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * ★ 2026-09-15：创建 worktree 时是否把新分支推到 `origin`。
 *
 * ── 为什么默认 **false** ──────────────────────────────────────────────
 * 原实现无条件 `git push -u origin <branch>`。但 worktree 的定位是**实验性隔离**：
 *   · 推分支是**远端可见的副作用**（团队成员会看到一堆 `worktree/*` 分支）；
 *   · 可能**触发 CI**（按分支 push 触发的流水线会被这些实验分支反复打爆）；
 *   · 而"想分享/备份"是少数场景，且用户随时可以自己 push。
 * ⇒ 远端副作用应当**显式选择**（opt-in），而不是创建 worktree 的默认行为。
 * 与上游 agentHost 一致：那边**从不 push**（只 `worktree add`）。
 */
export const WORKTREE_PUSH_BRANCH_ON_CREATE_SETTING = 'sessions.worktree.pushBranchOnCreate';

/** 见 {@link WORKTREE_PUSH_BRANCH_ON_CREATE_SETTING}：默认不推送。 */
export const DEFAULT_WORKTREE_PUSH_BRANCH_ON_CREATE = false;

/**
 * ★ 2026-09-15：创建 worktree 时，新分支的**起点**。
 *
 * - `current`（**默认**）：沿用 git 默认 —— 从主仓**当前 HEAD** 建分支。
 *   保留既有行为（不制造惊喜），且"从我正在做的事继续"通常正是用户想要的。
 * - `default`：从 `origin/<默认分支>`（无远端时退回本地默认分支）建 —— 与上游 agentHost 一致
 *   （`copilotAgent` 用 `origin/<base>` 作 start point）。
 *
 * ⚠ 为什么要做成可配置：两种语义都说得通，但**不能同时**成立 ——
 *   · 从当前 HEAD 建 ⇒ 新 worktree 会带上当前分支的未推送状态；
 *   · `resetWorktree()` 却是重置到**默认分支** ⇒ 创建与重置的基准不一致。
 * 让用户显式选，比替用户猜好。
 */
export type WorktreeBaseBranchMode = 'current' | 'default';

/** 设置键：新分支起点。 */
export const WORKTREE_BASE_BRANCH_SETTING = 'sessions.worktree.baseBranchOnCreate';

/** 见 {@link WORKTREE_BASE_BRANCH_SETTING}：默认保留 git 原行为（当前 HEAD）。 */
export const DEFAULT_WORKTREE_BASE_BRANCH: WorktreeBaseBranchMode = 'current';

/**
 * 把设置值收敛成合法模式。**未知值一律回落默认**（不抛错）——
 * 同步/创建路径不该因为一个拼错的设置而失败。
 */
export function resolveWorktreeBaseBranchMode(raw: unknown): WorktreeBaseBranchMode {
	return raw === 'default' ? 'default' : DEFAULT_WORKTREE_BASE_BRANCH;
}

// ─── Two-phase creation (opencode pattern) ──────────────────────────────────

/**
 * Options for generating worktree info (phase 1 of two-phase creation).
 * Compatible with opencode's makeWorktreeInfo pattern.
 */
export interface IWorktreeInfoOptions {
	/** Display name for the worktree (will be slugified for branch name). Auto-generated if omitted. */
	name?: string;
	/** Branch name. If provided and branch exists, checkout existing branch.
	 * If provided and branch does not exist, create new branch.
	 * If omitted, branch defaults to "worktree/<slug>" (unless detached=true). */
	branch?: string;
	/** If true, create a detached HEAD worktree without a branch. */
	detached?: boolean;
}

/**
 * Pre-computed worktree info (output of phase 1, input of phase 2).
 * Compatible with opencode's WorktreeInfo pattern.
 */
export interface IWorktreeInfo {
	/** Slugified name (e.g. "feature-auth") */
	name: string;
	/** Branch name (e.g. "opencode/feature-auth"), undefined if detached */
	branch?: string;
	/** Absolute file system path where the worktree will be created */
	directory: string;
}

// ─── Worktree state tracking ────────────────────────────────────────────────

/**
 * Lifecycle status of a worktree (compatible with opencode's pending/ready/failed).
 */
export const enum WorktreeStatus {
	/** Not using worktree isolation */
	None = 'none',
	/** Worktree is being created (git worktree add + boot) */
	Pending = 'pending',
	/** Worktree is ready for use */
	Ready = 'ready',
	/** Worktree creation or boot failed */
	Failed = 'failed',
}

/**
 * Event payload when a worktree's status changes.
 */
export interface IWorktreeStateEvent {
	/** Absolute path of the worktree directory */
	directory: string;
	/** New status */
	status: WorktreeStatus;
	/** Optional message (e.g. error details when status=Failed) */
	message?: string;
}

/**
 * Options for creating a workspace with worktree isolation.
 */
export interface IWorktreeWorkspaceOptions {
	/** How to handle worktree for this workspace */
	mode: 'main' | 'create' | 'existing';
	/** Name for the new worktree (only for mode='create'). Auto-generated if omitted. */
	name?: string;
	/** Existing worktree path (only for mode='existing') */
	existingPath?: string;
	/** Whether to create a detached worktree (only for mode='create') */
	detached?: boolean;
}
