/*---------------------------------------------------------------------------------------------
 *  分支感知 — 基于 Git 分支/Worktree 的记忆隔离。
 *  参考 agentmemory src/functions/branch-aware.ts
 *
 *  在代码编辑器场景下，用户经常在多个 worktree/分支间切换。
 *  不同分支的工作上下文应隔离，避免 feat-a 的记忆污染 feat-b 的搜索结果。
 *
 *  核心能力：
 *    1. detectWorktree(cwd) — 检测当前目录是否为 worktree，返回分支信息
 *    2. scopedAgentId(baseAgentId, branch) — 生成分支限定的 agentId
 *    3. listBranchSessions(baseAgentId) — 列出某仓库所有分支的会话
 *    4. mergeBranchMemories(from, to) — 分支合并时迁移记忆
 *
 *  注意：本模块不直接执行 git 命令（renderer 沙箱限制），
 *  而是由调用方（主进程/扩展宿主）传入 git 信息，本模块只做隔离逻辑。
 *--------------------------------------------------------------------------------------------*/

export interface WorktreeInfo {
	cwd: string;
	isWorktree: boolean;
	branch: string | null;
	topLevel: string;
	mainRepoRoot: string;
	gitDir: string | null;
	commonDir: string | null;
	detectedAt: string;
}

export interface BranchSession {
	branch: string;
	agentId: string;
	scopedAgentId: string;
	lastActiveAt: number;
	memoryCount: number;
}

export interface MergeResult {
	migrated: number;
	skipped: number;
	conflicts: string[];
}

const BRANCH_SCOPE_SEPARATOR = '::';
const MAX_BRANCH_NAME_LEN = 40;

function sanitizeBranchName(branch: string): string {
	// 分支名可能包含 /, -, _ 等，替换为安全字符
	return branch
		.replace(/[\\/:*?"<>|]/g, '-')
		.slice(0, MAX_BRANCH_NAME_LEN)
		.toLowerCase();
}

export class BranchAwareManager {
	private _worktrees = new Map<string, WorktreeInfo>();          // cwd → info
	private _branchSessions = new Map<string, Map<string, BranchSession>>();  // baseAgentId → branch → session

	/**
	 * 注册 worktree 信息（由扩展宿主通过 git 命令获取后传入）
	 */
	registerWorktree(info: Omit<WorktreeInfo, 'detectedAt'>): WorktreeInfo {
		const full: WorktreeInfo = { ...info, detectedAt: new Date().toISOString() };
		this._worktrees.set(info.cwd, full);
		return full;
	}

	/**
	 * 获取 worktree 信息（如果已注册）
	 */
	getWorktree(cwd: string): WorktreeInfo | null {
		return this._worktrees.get(cwd) ?? null;
	}

	/**
	 * 生成分支限定的 agentId
	 * 格式：baseAgentId::branchName
	 * 当 branch 为 null（非 git 仓库或 detached HEAD）时返回原 agentId
	 */
	scopedAgentId(baseAgentId: string, branch: string | null): string {
		if (!branch || branch === 'main' || branch === 'master') {
			// 主分支不隔离，直接使用 base agentId
			return baseAgentId;
		}
		const sanitized = sanitizeBranchName(branch);
		return `${baseAgentId}${BRANCH_SCOPE_SEPARATOR}${sanitized}`;
	}

	/**
	 * 从 scopedAgentId 解析出 baseAgentId
	 */
	parseBaseAgentId(scopedAgentId: string): string {
		const idx = scopedAgentId.indexOf(BRANCH_SCOPE_SEPARATOR);
		return idx >= 0 ? scopedAgentId.slice(0, idx) : scopedAgentId;
	}

	/**
	 * 从 scopedAgentId 解析出分支名
	 */
	parseBranch(scopedAgentId: string): string | null {
		const idx = scopedAgentId.indexOf(BRANCH_SCOPE_SEPARATOR);
		if (idx < 0) return null;
		return scopedAgentId.slice(idx + BRANCH_SCOPE_SEPARATOR.length);
	}

	/**
	 * 记录分支会话活动
	 */
	recordSession(baseAgentId: string, branch: string, scopedAgentId: string, memoryCount: number = 0): void {
		let branches = this._branchSessions.get(baseAgentId);
		if (!branches) {
			branches = new Map();
			this._branchSessions.set(baseAgentId, branches);
		}
		branches.set(branch, {
			branch,
			agentId: baseAgentId,
			scopedAgentId,
			lastActiveAt: Date.now(),
			memoryCount,
		});
	}

	/**
	 * 列出某仓库（baseAgentId）所有分支的会话
	 */
	listBranchSessions(baseAgentId: string): BranchSession[] {
		const branches = this._branchSessions.get(baseAgentId);
		if (!branches) return [];
		return Array.from(branches.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	}

	/**
	 * 分支合并时迁移记忆（from → to）
	 * 在 git merge / branch delete 时调用
	 */
	planMerge(fromScoped: string, toScoped: string, fromEntries: unknown[]): MergeResult {
		// 这里只做计划，实际迁移由 memoryProvider 执行
		// 主要逻辑：检测内容冲突（相同 concepts 但不同内容）
		const conflicts: string[] = [];
		let migrated = 0;
		let skipped = 0;

		for (const entry of fromEntries) {
			const e = entry as { content?: string; metadata?: Record<string, unknown> };
			if (!e.content || e.content.trim().length === 0) {
				skipped++;
				continue;
			}
			// 简单冲突检测：相同 sourceObservationId 视为冲突
			const sourceId = e.metadata?.['sourceObservationId'];
			if (sourceId && typeof sourceId === 'string') {
				conflicts.push(sourceId);
			}
			migrated++;
		}

		return { migrated, skipped, conflicts };
	}

	/**
	 * 清理已删除分支的会话记录
	 */
	pruneDeletedBranches(baseAgentId: string, activeBranches: string[]): number {
		const branches = this._branchSessions.get(baseAgentId);
		if (!branches) return 0;
		let pruned = 0;
		for (const [branch] of branches) {
			if (!activeBranches.includes(branch)) {
				branches.delete(branch);
				pruned++;
			}
		}
		return pruned;
	}

	/**
	 * 获取统计信息
	 */
	getStats(): { totalWorktrees: number; totalBranchSessions: number; branchesByAgent: Array<{ agentId: string; count: number }> } {
		let totalBranchSessions = 0;
		const branchesByAgent: Array<{ agentId: string; count: number }> = [];
		for (const [agentId, branches] of this._branchSessions) {
			totalBranchSessions += branches.size;
			branchesByAgent.push({ agentId, count: branches.size });
		}
		return {
			totalWorktrees: this._worktrees.size,
			totalBranchSessions,
			branchesByAgent: branchesByAgent.sort((a, b) => b.count - a.count),
		};
	}

	/**
	 * 清除所有状态
	 */
	clear(): void {
		this._worktrees.clear();
		this._branchSessions.clear();
	}
}
