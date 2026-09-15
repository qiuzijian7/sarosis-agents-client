/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorktreeCheckpointService, IWorktreeCheckpoint } from '../common/worktreeCheckpointService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';

/** 所有 checkpoint ref 的前缀（`refs/vssaros/checkpoints/<sessionId>/<name>`）。 */
const CHECKPOINT_REF_PREFIX = 'refs/vssaros/checkpoints/';

/**
 * Worktree Checkpoint Service - supports rollback to a previous state.
 * Compatible with VS Code's ChatSessionWorktreeCheckpointService.
 *
 * Checkpoints are implemented using git refs (under refs/vssaros/checkpoints/).
 * Each checkpoint is a lightweight git reference pointing to a commit.
 *
 * ★★ 2026-09-15 重大修复：原先 checkpoint **只记录 `HEAD` 的 commit hash**
 * （`rev-parse HEAD` + `update-ref`），完全不捕获工作树。后果（实测确认）：
 *
 *   ① agent 改文件通常**不 commit** ⇒ `HEAD` 不动 ⇒ 一次会话里 `baseline` 与所有
 *      `request-<id>` 指向**同一个 commit**，checkpoint 之间**无法区分**；
 *   ② `rollbackToCheckpoint()` 用 `reset --hard <该 ref>`，而该 ref 就是 HEAD
 *      ⇒ 净效果是**丢弃 agent 的全部未提交改动**，且 checkpoint 里**没有任何东西可恢复**
 *      —— 名义上是"回滚到检查点"，实际上是"销毁按钮"。
 *
 * 现改为**真快照**（与上游 VS Code agentHost 同思路）：
 *   `GIT_INDEX_FILE=<临时索引> git add -A` → `write-tree` → `commit-tree`（悬挂 commit）
 *   → `update-ref <checkpoint ref>`。
 * 关键点（已用真实 git 实测）：
 *   · 临时索引**必须放在工作树之外**（本服务放在 `git rev-parse --absolute-git-dir` 得到的
 *     git 目录内）—— 若放在工作树里，`add -A` 会**把临时索引自己**也加进快照
 *     （实测 `ls-tree` 里出现 `.tmp-ckpt.index.lock`），并让 `git status` 多出未跟踪项；
 *   · 用隔离索引 ⇒ **真实暂存区、HEAD、分支、工作树全部零改动**
 *     （实测快照前后 `git status --porcelain` 逐字节一致）；
 *   · `add -A` 尊重 `.gitignore` ⇒ `node_modules` 等不会进快照；
 *   · **未跟踪文件会被捕获** —— 这正是 agent 产出新文件的主要形态。
 * 回滚改用 `git restore --source=<ref> --worktree --staged -- .`（**不用** `reset --hard`），
 * 这样能真正还原快照内容且不动 HEAD / 分支。
 */
export class WorktreeCheckpointService extends Disposable implements IWorktreeCheckpointService {
	readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
	}

	/**
	 * 把 worktree 的**完整工作树状态**（含未提交改动与未跟踪文件）快照成一个悬挂 commit，
	 * 并让 `refName` 指向它。
	 *
	 * 全程使用**隔离索引**（`GIT_INDEX_FILE`，放在系统临时目录、**仓库之外**）⇒ 不改动
	 * 真实暂存区 / HEAD / 分支 / 工作树。已用真实 git 实测：快照前后 `git status --porcelain`
	 * 逐字节一致。
	 *
	 * 超时放宽到 120s：`add -A` 用全新索引时需**逐文件**计算 hash 与旧索引比较，
	 * 大仓可能远超默认 30s。
	 */
	private async _captureWorkingTreeAsCommit(worktreePath: string, refName: string, message: string): Promise<string> {
		const TIMEOUT_MS = 120_000;

		// ★ 临时索引必须放在**工作树之外**。
		//
		// 实测教训：第一版把它放在仓库根（`.tmp-ckpt.index`）⇒ `git add -A` **把临时索引自己
		// 也加进了快照**（`ls-tree` 里能看到 `.tmp-ckpt.index.lock`），并让 `git status` 多出
		// 一条未跟踪项。放到 `.git/` 下则安全：**git 从不把 git 目录计入工作树**，
		// 且 `.git` 里本来就有 git 自己写的临时文件。
		// 用 `--absolute-git-dir` 而不是硬拼路径：linked worktree 的 git 目录是
		// `<主仓>/.git/worktrees/<name>/`（`.git` 在 worktree 里只是个**文件**）。
		const gitDir = (await this.execGit(worktreePath, ['rev-parse', '--absolute-git-dir'], undefined, TIMEOUT_MS)).trim();
		if (!gitDir) {
			throw new Error('rev-parse --absolute-git-dir returned empty');
		}
		const indexPath = `${gitDir.replace(/[/\\]+$/, '')}/vssaros-ckpt-${generateUuid()}.index`;
		const env = { GIT_INDEX_FILE: indexPath };

		try {
			// ① 用隔离索引把工作树全部内容 stage 进来（尊重 .gitignore ⇒ node_modules 等不入快照）
			await this.execGit(worktreePath, ['add', '-A'], env, TIMEOUT_MS);

			// ② 写 tree 对象
			const tree = (await this.execGit(worktreePath, ['write-tree'], env, TIMEOUT_MS)).trim();
			if (!tree) {
				throw new Error('write-tree returned empty tree');
			}

			// ③ 建悬挂 commit（不移动 HEAD / 分支）。unborn 分支（无 HEAD）时省略 -p。
			let head: string | undefined;
			try {
				head = (await this.execGit(worktreePath, ['rev-parse', 'HEAD'], undefined, TIMEOUT_MS)).trim() || undefined;
			} catch {
				head = undefined; // 尚无提交（unborn）——commit-tree 不带 -p 依然成立
			}

			const commitArgs = ['commit-tree', tree];
			if (head) {
				commitArgs.push('-p', head);
			}
			commitArgs.push('-m', message);
			const commit = (await this.execGit(worktreePath, commitArgs, env, TIMEOUT_MS)).trim();
			if (!commit) {
				throw new Error('commit-tree returned empty commit');
			}

			// ④ 让 checkpoint ref 指向它
			await this.execGit(worktreePath, ['update-ref', refName, commit], undefined, TIMEOUT_MS);
			return commit;
		} finally {
			// 临时索引必须清掉 —— 放在系统临时目录里，泄漏会累积。
			try {
				const indexUri = URI.file(indexPath);
				if (await this.fileService.exists(indexUri)) {
					await this.fileService.del(indexUri);
				}
			} catch {
				// 清理失败只影响磁盘占用，不影响正确性。
			}
		}
	}

	async createBaselineCheckpoint(sessionId: string, worktreePath: string): Promise<string | undefined> {
		try {
			this.logService.info(`[WorktreeCheckpoint] Creating baseline checkpoint for session ${sessionId} at ${worktreePath}`);

			// Create checkpoint ref: refs/vssaros/checkpoints/{sessionId}/baseline
			const refName = `refs/vssaros/checkpoints/${sessionId}/baseline`;
			// ★ 真快照（含未提交改动 + 未跟踪文件），不是只记 HEAD。
			const commit = await this._captureWorkingTreeAsCommit(worktreePath, refName, `vssaros baseline checkpoint (session ${sessionId})`);

			this.logService.info(`[WorktreeCheckpoint] Baseline checkpoint created: ${refName} -> ${commit}`);
			return refName;
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to create baseline checkpoint:', e);
			return undefined;
		}
	}

	async createPostTurnCheckpoint(sessionId: string, worktreePath: string, requestId: string): Promise<string | undefined> {
		try {
			this.logService.info(`[WorktreeCheckpoint] Creating post-turn checkpoint for request ${requestId}`);

			// Create checkpoint ref: refs/vssaros/checkpoints/{sessionId}/request-{requestId}
			const refName = `refs/vssaros/checkpoints/${sessionId}/request-${requestId}`;
			// ★ 真快照（含未提交改动 + 未跟踪文件），不是只记 HEAD。
			const commit = await this._captureWorkingTreeAsCommit(worktreePath, refName, `vssaros checkpoint (request ${requestId})`);

			this.logService.info(`[WorktreeCheckpoint] Post-turn checkpoint created: ${refName} -> ${commit}`);
			return refName;
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to create post-turn checkpoint:', e);
			return undefined;
		}
	}

	async getCheckpoints(sessionId: string, worktreePath: string): Promise<readonly IWorktreeCheckpoint[]> {
		try {
			this.logService.info(`[WorktreeCheckpoint] Getting checkpoints for session ${sessionId}`);

			// List all checkpoint refs for this session
			const refPattern = `refs/vssaros/checkpoints/${sessionId}/*`;
			const stdout = await this.execGit(worktreePath, ['for-each-ref', '--format=%(refname) %(objectname) %(creatordate:unix)', refPattern]).catch(() => '');
			const checkpoints = this._parseCheckpointRefs(stdout);

			this.logService.info(`[WorktreeCheckpoint] Found ${checkpoints.length} checkpoint(s)`);
			return checkpoints;
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to get checkpoints:', e);
			return [];
		}
	}

	/**
	 * ★ 2026-09-15：列出**该 worktree 上所有** checkpoint（不限 session）。
	 *
	 * 为什么必需：`getCheckpoints(sessionId, …)` 要求已知 sessionId，而 Worktree 视图并不知道
	 * （视图里创建 checkpoint 用的是 `sessionId = item.path` 这个占位，见 `worktreeView.ts` 的 TODO）。
	 * 用户要从 UI 选还原点，就必须能按 worktree 反查 —— 否则 `rollbackToCheckpoint()`
	 * 在本仓**没有任何可达调用点**（唯一调用者是 `worktreeCheckpointCommands.ts` 里那批
	 * 从未被注册的命令），即"快照只进不出"。
	 *
	 * 按时间**倒序**返回（最近的在最前），便于 UI 直接展示。
	 */
	async listCheckpointsForWorktree(worktreePath: string): Promise<readonly IWorktreeCheckpoint[]> {
		try {
			const stdout = await this.execGit(worktreePath, ['for-each-ref', '--format=%(refname) %(objectname) %(creatordate:unix)', CHECKPOINT_REF_PREFIX]).catch(() => '');
			const checkpoints = this._parseCheckpointRefs(stdout);
			this.logService.info(`[WorktreeCheckpoint] Found ${checkpoints.length} checkpoint(s) for worktree ${worktreePath}`);
			return [...checkpoints].sort((a, b) => b.timestamp - a.timestamp);
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to list checkpoints for worktree:', e);
			return [];
		}
	}

	/**
	 * 解析 `for-each-ref --format='%(refname) %(objectname) %(creatordate:unix)'` 的输出。
	 *
	 * ref 形态：`refs/vssaros/checkpoints/<sessionId>/<name>`。
	 * sessionId 可能**自身含 `/`**（视图用 `item.path` 当 sessionId，而 Windows 路径含 `\`→ 已被
	 * 归一化为 `/`）⇒ 不能按第一个 `/` 切，必须**从右边**取最后一段作为 name。
	 */
	private _parseCheckpointRefs(stdout: string): IWorktreeCheckpoint[] {
		const checkpoints: IWorktreeCheckpoint[] = [];
		if (!stdout.trim()) {
			return checkpoints;
		}
		for (const line of stdout.trim().split('\n')) {
			const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)$/);
			if (!match) {
				continue;
			}
			const [, ref, commitHash, timestampStr] = match;
			const rest = ref.slice(CHECKPOINT_REF_PREFIX.length); // <sessionId>/<name>
			const lastSlash = rest.lastIndexOf('/');
			if (lastSlash <= 0) {
				continue; // 没有 sessionId 段，非法 ref
			}
			const sessionId = rest.slice(0, lastSlash);
			const name = rest.slice(lastSlash + 1);
			checkpoints.push({
				ref,
				commitHash,
				name,
				timestamp: parseInt(timestampStr, 10) * 1000, // convert to ms
				isBaseline: name === 'baseline',
				sessionId,
			});
		}
		return checkpoints;
	}

	async rollbackToCheckpoint(worktreePath: string, checkpointRef: string): Promise<boolean> {
		try {
			this.logService.info(`[WorktreeCheckpoint] Rolling back to checkpoint ${checkpointRef} at ${worktreePath}`);

			// 2026-09-12：ref 不存在时**显式判定**并给精准日志（warn + 原因），而不是让
			// show-ref 的非零退出冒泡成笼统的「Failed to rollback」—— 后者会让排障者
			// 误以为 reset 失败（实际是目标 ref 压根不存在）。
			// 注：此判定取自已删除的 node 版实现 —— 那份实现唯一的「比 browser 版更正确」
			// 之处（其余逻辑两者等价，但 node 版用字符串拼 shell 命令存在注入风险）。
			let refExists = '';
			try {
				refExists = await this.execGit(worktreePath, ['show-ref', '--verify', checkpointRef]);
			} catch {
				// `show-ref --verify` 对不存在的 ref 返回非零 → 视为「不存在」，下方统一处理
			}
			if (!refExists.trim()) {
				this.logService.warn(`[WorktreeCheckpoint] Checkpoint ref ${checkpointRef} does not exist`);
				return false;
			}

			// ★★ 2026-09-15 改用 `git restore --source=<ref>`，**不再用 `reset --hard`**。
			//
			// 为什么必须换（原实现是"销毁按钮"）：旧 checkpoint 只记 HEAD，`reset --hard <ref>`
			// 等于 `reset --hard HEAD` ⇒ **丢弃全部未提交改动**，而 checkpoint 里没有任何东西可恢复。
			// 即便在真快照之后，`reset --hard` 也有两个问题：
			//   ① 它把 HEAD / 当前分支**指到**该 checkpoint commit ⇒ 把"回滚工作树"变成
			//      "移动分支历史"，污染 agent 的分支（且会让后续 commit 基于悬挂 commit）；
			//   ② 它不还原快照里的**未跟踪文件**（那些是 agent 产出新文件的主要形态）。
			//
			// `restore --source=<ref> --worktree --staged -- .` 恰好做对的事：
			//   · 把快照里的内容写回**工作树**（`--worktree`）与**暂存区**（`--staged`）——
			//     包括快照时还是未跟踪的文件（它们已在快照 tree 里）；
			//   · **不动 HEAD / 分支**；
			//   · 对"快照之后新出现、且不在快照里"的文件**不删除** —— 与旧行为
			//     （`reset --hard` 同样不删未跟踪文件）保持一致，属**刻意保守**：
			//     回滚是修复动作，不该顺手销毁用户可能手动创建的东西。
			await this.execGit(worktreePath, ['restore', '--source', checkpointRef, '--worktree', '--staged', '--', '.']);

			this.logService.info(`[WorktreeCheckpoint] Rollback completed successfully (restored working tree + index from ${checkpointRef})`);
			return true;
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to rollback:', e);
			return false;
		}
	}

	async deleteSessionCheckpoints(sessionId: string, worktreePath: string): Promise<void> {
		try {
			this.logService.info(`[WorktreeCheckpoint] Deleting all checkpoints for session ${sessionId}`);

			// Get all checkpoint refs for this session
			const refPattern = `refs/vssaros/checkpoints/${sessionId}/*`;
			const stdout = await this.execGit(worktreePath, ['for-each-ref', '--format=%(refname)', refPattern]).catch(() => '');

			if (!stdout.trim()) {
				this.logService.info(`[WorktreeCheckpoint] No checkpoints to delete`);
				return;
			}

			// Delete each ref
			for (const line of stdout.trim().split('\n')) {
				const refName = line.trim();
				if (refName) {
					await this.execGit(worktreePath, ['update-ref', '-d', refName]).catch((err) => {
						this.logService.warn(`[WorktreeCheckpoint] Failed to delete ref ${refName}:`, err);
					});
					this.logService.info(`[WorktreeCheckpoint] Deleted checkpoint ref: ${refName}`);
				}
			}

			this.logService.info(`[WorktreeCheckpoint] All checkpoints deleted for session ${sessionId}`);
		} catch (e) {
			this.logService.error('[WorktreeCheckpoint] Failed to delete checkpoints:', e);
		}
	}

	/**
	 * Execute a git command using the same method as WorktreeService.
	 * This ensures compatibility with the current architecture.
	 */
	private async execGit(cwd: string, args: string[], env?: Record<string, string>, timeoutMs?: number): Promise<string> {
		try {
			this.logService.info(`[WorktreeCheckpoint] execGit: git ${args.join(' ')} (cwd: ${cwd}${env ? `, env=${Object.keys(env).join(',')}` : ''})`);

			// Use the ipcRenderer bridge exposed by the Electron preload script
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				let result: { success: boolean; stdout: string; stderr: string; exitCode: number } | undefined;
				try {
					// ★ 第 4/5 个参数：白名单 env（`GIT_INDEX_FILE`）与超时覆盖。
					// 主进程侧对 env 做白名单、对 timeoutMs 做钳制（见 `app.ts` 的 `vscode:execGit`）。
					result = await vscodeBridge.ipcRenderer.invoke('vscode:execGit', cwd, args, env, timeoutMs);
				} catch (invokeErr) {
					this.logService.warn('[WorktreeCheckpoint] execGit: ipcRenderer.invoke failed:', invokeErr);
				}

				if (result !== undefined) {
					if (result.success) {
						return result.stdout;
					}
					throw new Error(result.stderr || `git exited with code ${result.exitCode}`);
				}
			}

			// Fallback: use Node.js child_process if available
			if (typeof process !== 'undefined' && (process as any).versions?.electron) {
				return await this._execGitNodeFallback(cwd, args, env, timeoutMs);
			}

			throw new Error('Git execution not available in this context');
		} catch (err) {
			this.logService.error('[WorktreeCheckpoint] execGit: error:', err);
			throw err;
		}
	}

	private _execGitNodeFallback(cwd: string, args: string[], env?: Record<string, string>, timeoutMs?: number): Promise<string> {
		return new Promise((resolve, reject) => {
			try {
				const cp = require('child_process') as typeof import('child_process');
				const child = cp.spawn('git', args, {
					cwd,
					env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env ?? {}) },
					windowsHide: true,
				});
				// 降级通道同样要有超时（与主进程侧默认值保持一致），否则网络 hang 会永久挂住。
				const effectiveTimeoutMs = timeoutMs ?? 30_000;
				const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, effectiveTimeoutMs);
				child.on('close', () => clearTimeout(killer));
				child.on('error', () => clearTimeout(killer));

				let stdout = '';
				let stderr = '';

				child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
				child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

				child.on('error', (err: Error) => {
					reject(new Error(`git spawn error: ${err.message}`));
				});

				child.on('close', (code: number) => {
					if (code === 0) {
						resolve(stdout);
					} else {
						reject(new Error(stderr || `git exited with code ${code}`));
					}
				});
			} catch (err) {
				reject(err);
			}
		});
	}
}
