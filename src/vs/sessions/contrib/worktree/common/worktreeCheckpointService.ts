/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IWorktreeCheckpointService = createDecorator<IWorktreeCheckpointService>('worktreeCheckpointService');

/**
 * Worktree Checkpoint Service - supports rollback to a previous state.
 * Compatible with VS Code's ChatSessionWorktreeCheckpointService.
 *
 * Checkpoints are implemented using git refs (under refs/vssaros/checkpoints/).
 * Each checkpoint is a lightweight git reference pointing to a commit.
 */
export interface IWorktreeCheckpointService {
	readonly _serviceBrand: undefined;

	/**
	 * Create a baseline checkpoint for a worktree before an agent request starts.
	 * This captures the current state so the user can roll back later.
	 *
	 * @param sessionId The agent session ID
	 * @param worktreePath The worktree path
	 * @returns The checkpoint ref name (e.g., "refs/vssaros/checkpoints/{sessionId}/baseline")
	 */
	createBaselineCheckpoint(sessionId: string, worktreePath: string): Promise<string | undefined>;

	/**
	 * Create a post-turn checkpoint after an agent request completes.
	 * This allows the user to roll back to the state after each turn.
	 *
	 * @param sessionId The agent session ID
	 * @param worktreePath The worktree path
	 * @param requestId The request ID (used as checkpoint name)
	 * @returns The checkpoint ref name
	 */
	createPostTurnCheckpoint(sessionId: string, worktreePath: string, requestId: string): Promise<string | undefined>;

	/**
	 * Get all checkpoints for a session.
	 */
	getCheckpoints(sessionId: string, worktreePath: string): Promise<readonly IWorktreeCheckpoint[]>;

	/**
	 * ★ 2026-09-15：列出**该 worktree 上所有** checkpoint（不限 session）。
	 *
	 * 为什么需要它：{@link getCheckpoints} 要求调用方**已知 sessionId**，而 Worktree 视图
	 * 并不知道（视图里创建 checkpoint 时用的是 `sessionId = item.path` 这个占位，
	 * 见 `worktreeView.ts` 的 TODO）。用户想从 UI 选一个还原点，就必须能**按 worktree 反查**。
	 *
	 * ref 形态 `refs/vssaros/checkpoints/<sessionId>/<name>` ⇒ 从 ref 名解析出 sessionId
	 * 填进 {@link IWorktreeCheckpoint.sessionId}。
	 */
	listCheckpointsForWorktree(worktreePath: string): Promise<readonly IWorktreeCheckpoint[]>;

	/**
	 * Roll back a worktree to a specific checkpoint.
	 *
	 * ★ 2026-09-15 实现变更：**不再用 `git reset --hard`**（那会移动 HEAD/当前分支，且不还原
	 * 快照里的未跟踪文件），改用
	 * `git restore --source=<ref> --worktree --staged -- .` —— 还原工作树与暂存区，
	 * 但**不动 HEAD / 分支**。
	 *
	 * @param worktreePath The worktree path
	 * @param checkpointRef The checkpoint ref (e.g., "refs/vssaros/checkpoints/{sessionId}/baseline")
	 * @returns Whether the rollback was successful
	 */
	rollbackToCheckpoint(worktreePath: string, checkpointRef: string): Promise<boolean>;

	/**
	 * Delete all checkpoints for a session (e.g., when the session is deleted).
	 */
	deleteSessionCheckpoints(sessionId: string, worktreePath: string): Promise<void>;
}

/**
 * A single worktree checkpoint.
 */
export interface IWorktreeCheckpoint {
	/** Checkpoint ref name */
	ref: string;
	/** Commit hash this checkpoint points to */
	commitHash: string;
	/** Human-readable name (e.g., "baseline", "request-abc123") */
	name: string;
	/** Timestamp when the checkpoint was created */
	timestamp: number;
	/** Whether this is a baseline checkpoint */
	isBaseline: boolean;
	/**
	 * ★ 2026-09-15：该 checkpoint 所属的 session id（从 ref 名解析）。
	 * 由 {@link IWorktreeCheckpointService.listCheckpointsForWorktree} 填充 ——
	 * 按 worktree 反查时，多条记录可能来自不同 session，UI 需要能区分。
	 */
	sessionId?: string;
}
