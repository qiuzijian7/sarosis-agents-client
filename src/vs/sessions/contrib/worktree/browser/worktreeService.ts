/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { IWorktreeService, ISelectedWorktree } from '../common/worktreeService.js';
import { IWorktreeDetail, ICreateWorktreeInfo, IWorktreeOutputItem, IWorktreeInfoOptions, IWorktreeInfo, WorktreeStatus, IWorktreeStateEvent, IWorktreeCleanupCandidate, IWorktreeCleanupOptions, IWorktreeCleanupResult, DEFAULT_STALE_WORKTREE_MS, WORKTREE_BRANCH_PREFIX, WORKTREE_PUSH_BRANCH_ON_CREATE_SETTING, DEFAULT_WORKTREE_PUSH_BRANCH_ON_CREATE, WORKTREE_BASE_BRANCH_SETTING, DEFAULT_WORKTREE_BASE_BRANCH, resolveWorktreeBaseBranchMode, WorktreeBaseBranchMode } from '../common/worktreeTypes.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorktreeCheckpointService } from '../common/worktreeCheckpointService.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { timeout } from '../../../../base/common/async.js';

/**
 * Slugify a name: lowercase, replace non-alphanumeric with hyphens, collapse multiple hyphens.
 * Exported so the Worktree view can live-preview the derived branch/path for a typed name.
 */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Generate a random short slug for auto-naming.
 */
function generateSlug(): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < 8; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

/**
 * Service for managing git worktrees in the sessions window.
 * Executes git commands via child_process (electron main process context).
 *
 * Supports opencode-compatible two-phase creation:
 *   1. makeWorktreeInfo() → compute name/branch/directory (no git yet)
 *   2. createFromInfo() → git worktree add + boot (async)
 */
export class WorktreeService extends Disposable implements IWorktreeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorktrees = this._register(new Emitter<void>());
	readonly onDidChangeWorktrees = this._onDidChangeWorktrees.event;

	private readonly _onDidChangeWorktreeState = this._register(new Emitter<IWorktreeStateEvent>());
	readonly onDidChangeWorktreeState = this._onDidChangeWorktreeState.event;

	private readonly _onDidRemoveWorktree = this._register(new Emitter<string>());
	readonly onDidRemoveWorktree = this._onDidRemoveWorktree.event;

	private readonly _selectedWorktree: ISettableObservable<ISelectedWorktree | undefined> = observableValue<ISelectedWorktree | undefined>('selectedWorktree', undefined);
	readonly selectedWorktree = this._selectedWorktree;

	setSelectedWorktree(selection: ISelectedWorktree | undefined): void {

		this._selectedWorktree.set(selection, undefined);
	}

	private _repositoryRoot: string | undefined;

	/** Track worktree states by directory path */
	private readonly _worktreeStates = new Map<string, WorktreeStatus>();
	/** Pending waiters for worktree ready/failed */
	private readonly _worktreeWaiters = new Map<string, Array<(status: WorktreeStatus) => void>>();

	/** Short-lived cache for getWorktreeMetadata (30s TTL) to avoid redundant git commands */
	private readonly _metadataCache = new Map<string, { result: Partial<IWorktreeDetail>; timestamp: number }>();
	private static readonly METADATA_CACHE_TTL = 30_000; // 30 seconds

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._repositoryRoot = undefined;
			this._onDidChangeWorktrees.fire();
		}));

		// Invalidate metadata cache when worktree state changes
		this._register(this._onDidChangeWorktreeState.event(e => {
			this._metadataCache.delete(e.directory);
			this.logService.debug(`[WorktreeService] metadata cache invalidated for ${e.directory}`);
		}));

		// Invalidate entire metadata cache when worktree list changes or a worktree is removed
		this._register(this._onDidChangeWorktrees.event(() => {
			this._metadataCache.clear();
			this.logService.debug('[WorktreeService] metadata cache cleared (worktree list changed)');
		}));
		this._register(this._onDidRemoveWorktree.event(path => {
			this._metadataCache.delete(path);
			this.logService.debug(`[WorktreeService] metadata cache invalidated for removed worktree ${path}`);
		}));
	}

	async getRepositoryRoot(): Promise<string | undefined> {
		if (this._repositoryRoot !== undefined) {
			this.logService.debug(`[WorktreeService] getRepositoryRoot: cached "${this._repositoryRoot}"`);
			return this._repositoryRoot;
		}

		const folders = this.workspaceContextService.getWorkspace().folders;
		this.logService.debug(`[WorktreeService] getRepositoryRoot: workspace folders count=${folders.length}`);
		if (folders.length === 0) {
			this.logService.error('[WorktreeService] getRepositoryRoot: no workspace folders!');
			return undefined;
		}

		// Check each workspace folder for a .git directory
		for (const folder of folders) {
			const gitPath = URI.joinPath(folder.uri, '.git');
			try {
				const stat = await this.fileService.stat(gitPath);
				if (stat) {
					this._repositoryRoot = folder.uri.fsPath;
					this.logService.debug(`[WorktreeService] getRepositoryRoot: found .git at "${folder.uri.fsPath}", repoRoot="${this._repositoryRoot}"`);
					return this._repositoryRoot;
				}
			} catch {
				this.logService.warn(`[WorktreeService] getRepositoryRoot: no .git in "${folder.uri.fsPath}"`);
			}
		}

		this.logService.error('[WorktreeService] getRepositoryRoot: no .git found in any workspace folder');
		return undefined;
	}

	async getAllRepositoryRoots(): Promise<string[]> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		this.logService.debug(`[WorktreeService] getAllRepositoryRoots: workspace folders count=${folders.length}`);
		if (folders.length === 0) {
			this.logService.warn('[WorktreeService] getAllRepositoryRoots: no workspace folders');
			return [];
		}

		const roots = await this.filterGitRepositoryRoots(folders.map(f => f.uri.fsPath));
		this.logService.debug(`[WorktreeService] getAllRepositoryRoots: ${roots.length} repo root(s)`);
		return roots;
	}

	async filterGitRepositoryRoots(candidatePaths: readonly string[]): Promise<string[]> {
		const roots: string[] = [];
		const seen = new Set<string>();
		for (const fsPath of candidatePaths) {
			if (!fsPath) {
				continue;
			}
			const norm = fsPath.replace(/[\\/]+$/, '').toLowerCase();
			if (seen.has(norm)) {
				continue;
			}
			const gitPath = URI.joinPath(URI.file(fsPath), '.git');
			try {
				const stat = await this.fileService.stat(gitPath);
				if (stat) {
					seen.add(norm);
					roots.push(fsPath);
					this.logService.debug(`[WorktreeService] filterGitRepositoryRoots: found .git at "${fsPath}"`);
				}
			} catch {
				// No .git in this folder, skip
			}
		}
		return roots;
	}

	async listWorktrees(repoPath: string): Promise<IWorktreeDetail[]> {
		try {
			this.logService.debug(`[WorktreeService] listWorktrees: repoPath="${repoPath}"`);
			const output = await this.execGit(repoPath, ['worktree', 'list', '--porcelain']);
			this.logService.debug(`[WorktreeService] listWorktrees: output="${output}"`);
			const result = this.parseWorktreeList(output, repoPath);
			this.logService.debug(`[WorktreeService] listWorktrees: parsed ${result.length} worktrees`);
			return result;
		} catch (e) {
			this.logService.error('[WorktreeService] Failed to list worktrees:', e);
			return [];
		}
	}

	async createWorktree(info: ICreateWorktreeInfo): Promise<IWorktreeDetail> {
		const args = ['worktree', 'add'];

		if (info.isBranch) {
			args.push('-b', info.name);
		}

		args.push(info.folderPath);

		if (info.isBranch) {
			args.push('HEAD');
		}

		await this.execGit(info.cwd, args);
		this._onDidChangeWorktrees.fire();

		// Return the newly created worktree info
		const worktrees = await this.listWorktrees(info.cwd);
		const created = worktrees.find(w => w.path === info.folderPath);
		if (!created) {
			throw new Error(`Failed to find newly created worktree at ${info.folderPath}`);
		}
		return created;
	}

	// ─── Two-phase creation (opencode pattern) ──────────────────────────────────

	async makeWorktreeInfo(options?: IWorktreeInfoOptions): Promise<IWorktreeInfo> {
		this.logService.debug('[WorktreeService] makeWorktreeInfo: called', { options });
		const repoRoot = await this.getRepositoryRoot();
		if (!repoRoot) {
			throw new Error('No git repository found');
		}

		// Generate name
		const rawName = options?.name || generateSlug();
		let name = slugify(rawName);
		if (!name) {
			name = generateSlug();
		}

		// Branch naming: use options.branch if provided, otherwise default to "<WORKTREE_BRANCH_PREFIX><slug>"
		// ⚠ 必须用常量：这个前缀曾经在 `removeWorktree()` 里被写成另一个值
		// （`opencode/<name>`）⇒ 分支永远删不掉。清理「孤儿分支」也按同一常量扫描。
		const branch = options?.detached ? undefined : (options?.branch || `${WORKTREE_BRANCH_PREFIX}${name}`);
		this.logService.debug('[WorktreeService] makeWorktreeInfo: computed', { name, branch, detached: options?.detached });

		// Directory: <repoRoot>/.worktrees/<name>
		// The worktree lives inside the git repository root (the folder that
		// actually contains .git).
		//
		// ★ 2026-09-15：排除不再要求用户手动加 `.gitignore`（原注释就是这么写的，
		// 把责任推给了用户）。`createFromInfo()` 现在会自动把 `.worktrees/` 注册进
		// 仓库**本地**的 `.git/info/exclude`（见 `_ensureWorktreeDirIgnored`）——
		// 用本地排除文件而非 `.gitignore`，是为了**不修改受版本控制的用户资产**。
		//
		// ⚠ 注意两套约定不一致（待裁决，暂不改）：上游 agentHost 把 worktree 放在
		// 仓库**外**的兄弟目录 `<repoParent>/<repoName>.worktrees`
		// （`platform/agentHost/node/copilot/copilotAgent.ts:131`），本服务放在仓库**内**。
		const worktreeBase = repoRoot.replace(/[/\\]$/, '') + '/.worktrees';
		const directory = worktreeBase + '/' + name;

		// Conflict detection: check both directory and branch existence in a single loop
		let attempts = 0;
		let finalName = name;
		let finalDirectory = directory;
		let finalBranch = branch;

		while (attempts < 26) {
			let conflict = false;

			// Check directory existence
			try {
				const dirUri = URI.file(finalDirectory);
				await this.fileService.stat(dirUri);
				// Directory exists, need to add suffix
				conflict = true;
				this.logService.debug(`[WorktreeService] makeWorktreeInfo: directory exists, will add suffix: ${finalDirectory}`);
			} catch {
				// Directory doesn't exist — good
			}

			// Check branch existence (if not detached)
			if (finalBranch) {
				try {
					await this.execGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${finalBranch}`]);
					// Branch exists, need to add suffix
					conflict = true;
					this.logService.debug(`[WorktreeService] makeWorktreeInfo: branch exists, will add suffix: ${finalBranch}`);
				} catch {
					// Branch doesn't exist — good
				}
			}

			if (!conflict) {
				break;
			}

			// Add suffix and retry
			const suffix = String.fromCharCode(97 + attempts); // a, b, c, ...
			finalName = `${name}-${suffix}`;
			finalDirectory = worktreeBase + '/' + finalName;
			finalBranch = options?.detached ? undefined : (options?.branch ? `${options.branch}-${suffix}` : `${WORKTREE_BRANCH_PREFIX}${finalName}`);
			attempts++;
		}

		return { name: finalName, branch: finalBranch, directory: finalDirectory };
	}

	async createFromInfo(info: IWorktreeInfo): Promise<void> {
		const repoRoot = await this.getRepositoryRoot();
		if (!repoRoot) {
			throw new Error('No git repository found');
		}

		// Set pending state
		this.setWorktreeState(info.directory, WorktreeStatus.Pending);

		// Ensure <repoRoot>/.worktrees directory exists
		const worktreeBaseUri = URI.joinPath(URI.file(repoRoot), '.worktrees');
		try {
			await this.fileService.stat(worktreeBaseUri);
			// Directory exists, good
		} catch {
			// Directory doesn't exist, create it
			this.logService.debug(`[WorktreeService] Creating .worktrees directory: ${worktreeBaseUri.fsPath}`);
			await this.fileService.createFolder(worktreeBaseUri);
		}

		// ★★ 自动把 `.worktrees/` 注册进仓库的**本地**排除文件（2026-09-15 补）。
		// 原实现只在 `makeWorktreeInfo` 的注释里写了「Add ".worktrees/" to the repo's
		// .gitignore」—— 把这件事**推给了用户**。详见 `_ensureWorktreeDirIgnored`。
		await this._ensureWorktreeDirIgnored(repoRoot);

		// Phase 2a: git worktree add --no-checkout [--no-track] [-b <branch>] <dir> [<start-point>]
		//
		// ★ 2026-09-15 两处修正：
		//
		// ① **`--no-track`**：即使仓库把 `branch.autoSetupMerge` 设为 `always`，
		//    也不要让新分支自动跟踪起点。否则 `git status` 会对一个**从未推送过**的分支显示
		//    "落后/领先 origin/…"，极具误导性。上游 agentHost 同样显式传 `--no-track`。
		//    （只在 `-b` 建新分支时才有意义；detached 情形不传。）
		//
		// ② **起点可控**：默认仍从**主仓当前 HEAD** 建（保留既有行为），
		//    设置 `sessions.worktree.baseBranchOnCreate = 'default'` 时改从
		//    `origin/<默认分支>` 建 —— 与上游一致，也与 `resetWorktree()`（重置到默认分支）
		//    的基准保持一致。语义取舍见 `WorktreeBaseBranchMode` 的注释。
		const args = ['worktree', 'add', '--no-checkout'];
		if (info.branch) {
			args.push('--no-track', '-b', info.branch);
		}
		args.push(info.directory);

		const startPoint = await this._resolveStartPoint(repoRoot);
		if (startPoint) {
			args.push(startPoint);
		}
		this.logService.info(
			`[WorktreeService] worktree add | branch=${info.branch ?? '<detached>'} | ` +
			`startPoint=${startPoint ?? '<current HEAD>'} | dir=${info.directory}`,
		);

		// ★★ 失败回滚（2026-09-15 补）。
		//
		// 原先：`worktree add` 成功、但后面任一步（`reset --hard` 等）抛错时，
		// 只在 `bootWorktree` 里置 `Failed` 就结束 ⇒ 留下「git 已登记、内容不完整」的
		// 半成品 worktree + 一个孤立分支，用户得手工 `git worktree remove`。
		//
		// 现在：把 2a 之后的步骤包起来，失败则**清掉半成品**再抛错（调用方能拿到原因）。
		let worktreeCreated = false;
		try {
			await this.execGit(repoRoot, args);
			worktreeCreated = true;

			// Phase 2b: git reset --hard (populate files)
			await this.execGit(info.directory, ['reset', '--hard']);

			// Phase 2c: push new branch to remote (so it appears on GitHub/GitLab)
			//
			// ★★ 2026-09-15：改为**受设置控制，默认不推送**。
			// 原实现无条件 push，但 worktree 的定位是实验性隔离 —— 推分支是**远端可见副作用**
			// （团队看到一堆 `worktree/*`、可能按分支触发 CI），应当 opt-in。
			// 与上游 agentHost 一致（那边从不 push）。设置键见
			// `WORKTREE_PUSH_BRANCH_ON_CREATE_SETTING`（默认 false）。
			if (info.branch && !this._shouldPushBranchOnCreate()) {
				this.logService.info(`[WorktreeService] Skipping push of branch ${info.branch} (sessions.worktree.pushBranchOnCreate is false)`);
			} else if (info.branch) {
				try {
					this.logService.info(`[WorktreeService] Pushing branch ${info.branch} to origin...`);
					await this.execGit(repoRoot, ['push', '-u', 'origin', info.branch]);
					this.logService.info(`[WorktreeService] Branch ${info.branch} pushed to origin successfully`);
				} catch (pushErr) {
					// Push failure is non-fatal — branch exists locally, user can push manually
					this.logService.warn(`[WorktreeService] Failed to push branch ${info.branch} to origin:`, pushErr);
				}
			}

			// Phase 2d: 修复 single-branch clone 的 fetch refspec。
			// 若仓库是 single-branch clone（remote.origin.fetch 只跟踪默认分支，如
			// +refs/heads/main:refs/remotes/origin/main），push 新分支后本地
			// refs/remotes/origin/<branch> 永远无法创建，导致 git 扩展解析 upstream
			// 失败（"upstream branch not stored as a remote-tracking branch"），
			// publish 按钮永远显示 "Publish Branch"（看似"没反应"）。修正为通配符即可。
			await this.ensureWildcardFetchRefspec(repoRoot);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (worktreeCreated) {
				await this.rollbackCreateFromInfo(repoRoot, info, message);
			}
			this.setWorktreeState(info.directory, WorktreeStatus.Failed, message);
			throw err;
		}

		this._onDidChangeWorktrees.fire();

		// Boot phase (fire-and-forget, like opencode's fork pattern)
		this.bootWorktree(info);
	}

	/**
	 * 该目录看起来是不是一个**真实 git 仓库根**（存在 `.git`）。
	 *
	 * 仅用于删除前的安全闸门：`git worktree list` 不认识、但目录里又有 `.git`
	 * ⇒ 它是某个仓库本身，**不能**按"残留目录"删掉。
	 */
	private async _looksLikeGitRepo(directory: string): Promise<boolean> {
		try {
			return await this.fileService.exists(URI.joinPath(URI.file(directory), '.git'));
		} catch {
			return false;
		}
	}

	/**
	 * 回滚 `createFromInfo` 的半成品（`worktree add` 已成功、后续步骤失败）。
	 *
	 * 步骤与 `removeWorktree` 对齐：移除 worktree → 清残留目录 → 删刚建的分支 → prune。
	 * 这里可以安全 `branch -D`：分支由本方法的 `-b` **刚刚创建**（`makeWorktreeInfo`
	 * 已保证无同名冲突），且创建过程失败 ⇒ 分支上不可能有用户工作。
	 * 任何一步失败都只 warn —— 回滚是尽力而为，不能掩盖原始错误。
	 */
	private async rollbackCreateFromInfo(repoRoot: string, info: IWorktreeInfo, cause: string): Promise<void> {
		this.logService.warn(`[WorktreeService] Rolling back partially created worktree ${info.directory} (cause: ${cause})`);

		try {
			await this.execGit(repoRoot, ['worktree', 'remove', '--force', info.directory]);
		} catch (e) {
			this.logService.warn('[WorktreeService] rollback: worktree remove failed, continuing:', e);
		}

		try {
			const dirUri = URI.file(info.directory);
			if (await this.fileService.exists(dirUri)) {
				await this.fileService.del(dirUri, { recursive: true });
			}
		} catch (e) {
			this.logService.warn('[WorktreeService] rollback: residual directory cleanup failed:', e);
		}

		if (info.branch) {
			try {
				await this.execGit(repoRoot, ['branch', '-D', info.branch]);
				this.logService.debug(`[WorktreeService] rollback: deleted branch ${info.branch}`);
			} catch (e) {
				this.logService.warn('[WorktreeService] rollback: branch delete failed, continuing:', e);
			}
		}

		try {
			await this.execGit(repoRoot, ['worktree', 'prune']);
		} catch { /* not critical */ }

		this._worktreeStates.delete(info.directory);
		this._onDidChangeWorktrees.fire();
	}

	/**
	 * 确保 `remote.origin.fetch` 使用通配符 refspec（`+refs/heads/*:refs/remotes/origin/*`）。
	 *
	 * 背景：single-branch clone（`git clone --single-branch` / `--depth 1`）会把 fetch
	 * refspec 设为只跟踪默认分支（如 `+refs/heads/main:refs/remotes/origin/main`）。此时
	 * push 新分支后，本地 `refs/remotes/origin/<branch>` 无法创建，`@{u}` 解析失败
	 * （"upstream branch 'x' not stored as a remote-tracking branch"），git 扩展的
	 * HEAD.upstream 恒为 undefined，publish 按钮不变成 Sync、看似"没反应"（实际已 push 成功）。
	 */
	private async ensureWildcardFetchRefspec(repoRoot: string): Promise<void> {
		try {
			let fetch = '';
			try {
				fetch = (await this.execGit(repoRoot, ['config', '--get', 'remote.origin.fetch'])).trim();
			} catch {
				// 无 origin remote 或无 fetch 配置 —— 无需修复
				return;
			}

			if (!fetch || fetch.includes('*')) {
				// 已含通配符，或为空，无需修正
				return;
			}

			this.logService.info(`[WorktreeService] Fixing single-branch fetch refspec: "${fetch}" → wildcard`);
			await this.execGit(repoRoot, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
		} catch (e) {
			this.logService.warn('[WorktreeService] ensureWildcardFetchRefspec failed:', e);
		}
	}

	private async bootWorktree(info: IWorktreeInfo): Promise<void> {
		try {
			// Verify the worktree is populated
			await this.execGit(info.directory, ['status', '--porcelain']);

			// ★★ 2026-09-15：补上**项目相关的准备**（原实现缺这一步 ⇒ "虚假就绪"）。
			//
			// 原实现只跑一条 `git status --porcelain` 就置 Ready。但"能跑起来"还需要项目相关的
			// 接线 —— 例如本仓（VS Code fork）需要把主仓的 `node_modules` 以 junction 接到 worktree
			// （否则无法编译/跑测试），以及内置扩展的 `out/` junction。
			//
			// 这些准备工作**其实早就存在**，却埋在「点调试」的路径里
			// （`worktreeDebugStrategies.resolveWorktreeDebugPlan` 会执行 vscode-fork 的 prep；
			// `dev-worktree.ps1` 也做同样两件事）⇒ **不点调试就永远不会准备**。
			// 于是 `waitForWorktreeReady()` 返回 Ready 后，调用方以为可用、实际连依赖都没接上。
			//
			// 这里复用同一套策略（**只 prep，不 build**）：编译仍按需（点调试时才跑
			// `transpile-client`），所以创建流程不会因此变慢。
			await this._prepareWorktree(info.directory);

			// Mark as ready
			this.setWorktreeState(info.directory, WorktreeStatus.Ready);
			this.logService.debug(`[WorktreeService] Worktree boot complete: ${info.directory}`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.setWorktreeState(info.directory, WorktreeStatus.Failed, message);
			this.logService.error(`[WorktreeService] Worktree boot failed: ${info.directory}`, e);
		}
	}

	/**
	 * 解析新分支的**起点**（`git worktree add` 的 start point）。
	 *
	 * - 默认模式 `current` ⇒ 返回 `undefined`，让 git 用它自己的默认（当前 HEAD）。
	 * - `default` 模式 ⇒ 优先 `origin/<默认分支>`（**远端基线**，与上游一致：避免从本地
	 *   可能已落后的分支开始）；远端没有该分支时退回本地默认分支名。
	 *
	 * 任何失败都只 warn 并返回 `undefined`（回落 git 默认）—— 起点解析失败不该阻断创建。
	 */
	private async _resolveStartPoint(repoRoot: string): Promise<string | undefined> {
		try {
			if (this._getBaseBranchMode() !== 'default') {
				return undefined; // git 默认：当前 HEAD（保留既有行为）
			}

			const base = await this.getDefaultBranch(repoRoot);
			if (!base) {
				return undefined;
			}

			// 有远端且远端存在该分支 ⇒ 用 remote-tracking ref（上游做法）。
			try {
				const remotes = (await this.execGit(repoRoot, ['remote'])).trim();
				if (remotes) {
					await this.execGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${base}`]);
					return `origin/${base}`;
				}
			} catch {
				// 远端没有该分支 ⇒ 退回本地分支名
			}

			// ★ 本地兜底**同样必须先探测**：`worktree add <start-point>` 遇到不存在的 ref 会
			// `fatal: invalid reference` **整体失败**（实测 exit 128）⇒ 宁可回落到 git 默认
			// （当前 HEAD），也不要让"起点配置"把创建搞挂。
			try {
				await this.execGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${base}`]);
				return base;
			} catch {
				this.logService.warn(`[WorktreeService] base branch "${base}" not found; falling back to current HEAD`);
				return undefined;
			}
		} catch (e) {
			this.logService.warn('[WorktreeService] _resolveStartPoint failed, falling back to current HEAD:', e);
			return undefined;
		}
	}

	/** 读取 {@link WORKTREE_BASE_BRANCH_SETTING}（未知值回落默认）。 */
	private _getBaseBranchMode(): WorktreeBaseBranchMode {
		try {
			const configurationService = this._instantiationService.invokeFunction(
				accessor => accessor.get(IConfigurationService),
			);
			return resolveWorktreeBaseBranchMode(configurationService.getValue(WORKTREE_BASE_BRANCH_SETTING));
		} catch {
			return DEFAULT_WORKTREE_BASE_BRANCH;
		}
	}

	/**
	 * 创建 worktree 时是否把新分支推到 `origin`。
	 *
	 * 设置键 {@link WORKTREE_PUSH_BRANCH_ON_CREATE_SETTING}，**默认 false**（见该常量注释）。
	 * 用 `=== true` 判定（而非真值判定）：设置未注册/读取失败时 `getValue` 返回 `undefined`，
	 * 此时必须按"不推送"处理 —— 远端副作用宁可不做。
	 *
	 * 沿用本类既有风格：延迟取服务，避免改动构造签名。
	 */
	private _shouldPushBranchOnCreate(): boolean {
		try {
			const configurationService = this._instantiationService.invokeFunction(
				accessor => accessor.get(IConfigurationService),
			);
			return configurationService.getValue<boolean>(WORKTREE_PUSH_BRANCH_ON_CREATE_SETTING) === true;
		} catch {
			return DEFAULT_WORKTREE_PUSH_BRANCH_ON_CREATE;
		}
	}

	/**
	 * 执行**项目相关**的准备工作（复用调试策略的 prep 路径）。
	 *
	 * 只做「接线」不做「编译」：`resolveDebugPlan()` 会按项目类型探测策略并执行该策略的准备步骤
	 * （本仓 = `node_modules` junction + 内置扩展 `out` junction，均为幂等），
	 * 但**不跑 build、不启动实例** —— 那是用户点「调试」时的事。
	 *
	 * ⚠ 失败只 warn：准备属"锦上添花"，绝不能因此把 worktree 判为 Failed
	 * （git 层面它已经可用了）。
	 */
	private async _prepareWorktree(worktreePath: string): Promise<void> {
		try {
			const plan = await this.resolveDebugPlan(worktreePath);
			this.logService.info(
				`[WorktreeService] Worktree prepared | strategy=${plan.strategy ?? '<none>'} | ` +
				`label=${plan.label ?? '<none>'} | success=${plan.success}`,
			);
		} catch (e) {
			this.logService.warn('[WorktreeService] worktree preparation failed (non-fatal):', e);
		}
	}

	// ─── Reset (opencode pattern) ───────────────────────────────────────────────

	async resetWorktree(worktreePath: string): Promise<void> {
		const repoRoot = await this.getRepositoryRoot();
		if (!repoRoot) {
			throw new Error('No git repository found');
		}

		// 1. Get default branch
		const defaultBranch = await this.getDefaultBranch(repoRoot);

		// 2. Fetch from remote
		try {
			await this.execGit(worktreePath, ['fetch', 'origin']);
		} catch {
			this.logService.warn('[WorktreeService] fetch failed during reset, continuing...');
		}

		// 3. git reset --hard <defaultBranch>
		await this.execGit(worktreePath, ['reset', '--hard', defaultBranch]);

		// 4. git clean -ffdx
		try {
			await this.execGit(worktreePath, ['clean', '-ffdx']);
		} catch (e) {
			// Retry once for locked files (Windows)
			this.logService.warn('[WorktreeService] clean failed, retrying...', e);
			await timeout(1000);
			try {
				await this.execGit(worktreePath, ['clean', '-ffdx']);
			} catch {
				this.logService.warn('[WorktreeService] clean retry failed, continuing...');
			}
		}

		// 5. git submodule update --init --recursive --force
		try {
			await this.execGit(worktreePath, ['submodule', 'update', '--init', '--recursive', '--force']);
		} catch {
			this.logService.warn('[WorktreeService] submodule update failed, continuing...');
		}

		// 6. git submodule foreach --recursive git reset --hard
		try {
			await this.execGit(worktreePath, ['submodule', 'foreach', '--recursive', 'git', 'reset', '--hard']);
		} catch {
			this.logService.warn('[WorktreeService] submodule reset failed, continuing...');
		}

		// 7. Verify clean state
		const status = await this.execGit(worktreePath, ['status', '--porcelain']);
		if (status.trim()) {
			this.logService.warn('[WorktreeService] Worktree still has uncommitted changes after reset');
		}

		this.logService.info(`[WorktreeService] Worktree reset complete: ${worktreePath}`);
	}

	// ─── Enhanced remove (opencode pattern) ─────────────────────────────────────

	async removeWorktree(worktreePath: string, force: boolean = false): Promise<void> {
		const repoRoot = await this.getRepositoryRoot();
		if (!repoRoot) {
			throw new Error('No git repository found');
		}

		const norm = (p: string) => p.replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();
		const targetKey = norm(worktreePath);

		// ① 先取该 worktree 的**真实分支** —— 必须在 `worktree remove` 之前。
		//    之后 git 就不再报告它了，只能靠路径猜分支名（原先就是猜 `opencode/<name>`，
		//    而实际分支是 `worktree/<name>` ⇒ **分支从来没被删掉过**，只增不减）。
		const before = await this.listWorktrees(repoRoot);
		const entry = before.find(w => norm(w.path) === targetKey);
		const branchToDelete = entry?.branch;

		// ② 幂等：git 已不认识它、目录也不存在 ⇒ 直接当作成功
		//    （opencode `worktree/index.ts:407-414` 同做法：重复删除不应报错）。
		let dirExists = false;
		try {
			dirExists = await this.fileService.exists(URI.file(worktreePath));
		} catch { /* treat as missing */ }

		if (!entry && !dirExists) {
			this.logService.debug(`[WorktreeService] removeWorktree: nothing to do (already gone): ${worktreePath}`);
			try {
				await this.execGit(repoRoot, ['worktree', 'prune']);
			} catch { /* not critical */ }
			this._worktreeStates.delete(worktreePath);
			this._onDidRemoveWorktree.fire(worktreePath.replace(/[/\\]+$/, ''));
			this._onDidChangeWorktrees.fire();
			return;
		}

		// ★★ 安全闸门（**必须在任何删除动作之前**）。
		//
		// 本方法的第 ⑤ 步会「清理残留目录」。若传入的路径其实是**真实仓库根**，
		// 那一步就等于**删掉用户的仓库**。`worktreeBinding.ts:19-29` 记载过这种情形：
		// 绑定里的 `worktreePath` **可以等于主仓路径**（历史数据/脏绑定）。
		// git 自身能挡住 `worktree remove <main>`，但挡不住我们自己的目录清理 —— 所以自己挡。
		if (entry?.isMain) {
			throw new Error(`Cannot delete the main worktree (${worktreePath}) — it is the repository itself.`);
		}
		if (!entry && dirExists && await this._looksLikeGitRepo(worktreePath)) {
			throw new Error(`Refusing to delete ${worktreePath}: git does not track it as a worktree, but it looks like a git repository.`);
		}

		// ③ Stop fsmonitor daemon in the worktree
		try {
			await this.execGit(worktreePath, ['fsmonitor', '--stop']);
		} catch {
			// Not critical, continue
		}

		// ④ git worktree remove [--force]（git 不认识它时跳过，直接走残留目录清理）
		if (entry) {
			const args = ['worktree', 'remove', worktreePath];
			if (force) {
				args.push('--force');
			}

			try {
				await this.execGit(repoRoot, args);
			} catch (e) {
				// If remove fails, check if it's already gone
				this.logService.warn('[WorktreeService] worktree remove failed, verifying...', e);
				const worktrees = await this.listWorktrees(repoRoot);
				const stillExists = worktrees.some(w => norm(w.path) === targetKey);
				if (!stillExists) {
					this.logService.debug('[WorktreeService] Worktree already removed from git list');
				} else {
					throw e; // Re-throw if it still exists
				}
			}
		}

		// ⑤ Manual cleanup of residual directory (opencode pattern)
		try {
			const dirUri = URI.file(worktreePath);
			const stat = await this.fileService.stat(dirUri);
			if (stat) {
				await this.fileService.del(dirUri, { recursive: true });
				this.logService.debug(`[WorktreeService] Cleaned up residual directory: ${worktreePath}`);
			}
		} catch {
			// Directory already gone, that's fine
		}

		// ⑥ 删分支：用**真实分支名**（修上面的硬编码 bug），并且**不销毁未推送的工作**。
		//
		// `git worktree remove` 只删工作目录，提交留在分支上 ⇒ 无条件 `branch -D`
		// 等于静默丢弃真实工作。判据与 hermes-agent-studio 一致：
		//   非 force + 有未推送提交 ⇒ **保留分支**（只删目录）；否则删除。
		if (branchToDelete) {
			try {
				if (!force && await this.hasUnpushedCommits(worktreePath)) {
					this.logService.info(`[WorktreeService] Branch "${branchToDelete}" kept: it has unpushed commits (pass force=true to delete).`);
				} else {
					await this.execGit(repoRoot, ['branch', '-D', branchToDelete]);
					this.logService.debug(`[WorktreeService] Deleted branch: ${branchToDelete}`);
				}
			} catch {
				// Branch may not exist, may be checked out elsewhere, or may be the current
				// branch — none of which should fail the worktree removal.
			}
		}

		// ⑦ Prune
		try {
			await this.execGit(repoRoot, ['worktree', 'prune']);
		} catch {
			// Not critical
		}

		// 6. Clean up state tracking
		this._worktreeStates.delete(worktreePath);

		// 7. Notify consumers that this worktree was removed, so they can clear
		//    stale bindings (e.g. AgentStudioService clears agents/workspaces
		//    that pointed at this directory). Normalize trailing separators so
		//    listeners can compare paths reliably.
		this._onDidRemoveWorktree.fire(worktreePath.replace(/[/\\]+$/, ''));

		this._onDidChangeWorktrees.fire();
	}

	async pruneWorktrees(repoPath: string): Promise<void> {
		await this.execGit(repoPath, ['worktree', 'prune']);
		this._onDidChangeWorktrees.fire();
	}

	// ─── State tracking ─────────────────────────────────────────────────────────

	getWorktreeState(directory: string): WorktreeStatus {
		return this._worktreeStates.get(directory) ?? WorktreeStatus.None;
	}

	async waitForWorktreeReady(directory: string, timeoutMs: number = 30000): Promise<WorktreeStatus> {
		const current = this._worktreeStates.get(directory);
		if (current === WorktreeStatus.Ready || current === WorktreeStatus.Failed) {
			return current;
		}

		return new Promise<WorktreeStatus>((resolve) => {
			const timer = setTimeout(() => {
				// Timeout — remove waiter and resolve with current state
				const waiters = this._worktreeWaiters.get(directory);
				if (waiters) {
					const idx = waiters.indexOf(resolve);
					if (idx >= 0) {
						waiters.splice(idx, 1);
					}
				}
				resolve(this._worktreeStates.get(directory) ?? WorktreeStatus.Pending);
			}, timeoutMs);

			// Wrap resolve to also clear the timer
			const wrappedResolve = (status: WorktreeStatus) => {
				clearTimeout(timer);
				resolve(status);
			};

			let waiters = this._worktreeWaiters.get(directory);
			if (!waiters) {
				waiters = [];
				this._worktreeWaiters.set(directory, waiters);
			}
			waiters.push(wrappedResolve);
		});
	}

	async getDefaultBranch(repoPath: string): Promise<string> {
		// Try to get from remote HEAD
		try {
			const output = await this.execGit(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
			const match = output.match(/refs\/remotes\/origin\/(.+)/);
			if (match) {
				return match[1];
			}
		} catch {
			// Fallback
		}

		// Try HEAD
		try {
			const output = await this.execGit(repoPath, ['symbolic-ref', '--short', 'HEAD']);
			if (output.trim()) {
				return output.trim();
			}
		} catch {
			// Fallback
		}

		// Default fallback
		return 'main';
	}

	// --- Private helpers ---

	private setWorktreeState(directory: string, status: WorktreeStatus, message?: string): void {
		this._worktreeStates.set(directory, status);
		this._onDidChangeWorktreeState.fire({ directory, status, message });

		// Notify waiters
		if (status === WorktreeStatus.Ready || status === WorktreeStatus.Failed) {
			const waiters = this._worktreeWaiters.get(directory);
			if (waiters) {
				this._worktreeWaiters.delete(directory);
				for (const waiter of waiters) {
					waiter(status);
				}
			}
		}
	}

	private async execGit(cwd: string, args: string[]): Promise<string> {
		try {
			this.logService.debug(`[WorktreeService] execGit: git ${args.join(' ')} (cwd: ${cwd})`);

			// Use the ipcRenderer bridge exposed by the Electron preload script
			// to invoke the 'vscode:execGit' handler in the main process.
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				let result: { success: boolean; stdout: string; stderr: string; exitCode: number } | undefined;
				try {
					this.logService.debug('[WorktreeService] execGit: using vscode.ipcRenderer.invoke bridge');
					result = await vscodeBridge.ipcRenderer.invoke('vscode:execGit', cwd, args);
				} catch (invokeErr) {
					// ONLY a genuine IPC transport failure lands here — fall through to the
					// child_process fallback below. We must NOT put git's own result handling
					// inside this try: a non-zero git exit (e.g. "fatal: branch already exists",
					// directory conflict, etc.) would otherwise throw inside this catch, be
					// mistaken for an IPC channel failure, drop to the fallback path, and finally
					// get mis-reported as "Git execution not available in this context" — hiding
					// the real git error. This is exactly the createWorktree failure we hit.
					this.logService.warn('[WorktreeService] execGit: ipcRenderer.invoke failed, trying fallback:', invokeErr);
				}

				// The IPC call completed as a transport. Surface git's actual result here,
					// OUTSIDE the try above, so real git errors propagate verbatim to the caller.
					if (result !== undefined) {
						if (result.success) {
							this.logService.debug(`[WorktreeService] execGit: success, stdout length=${result.stdout.length}`);
							return result.stdout;
						}
					// Use info (not warn/error) because non-zero exit codes are normal git behavior
					// (e.g. "no upstream configured", "no changes", etc.) and are handled by callers.
					this.logService.debug(`[WorktreeService] execGit: git exited with code ${result.exitCode}, stderr="${result.stderr}"`);
					throw new Error(result.stderr || `git exited with code ${result.exitCode}`);
					}
			}

			// Fallback: use Node.js child_process if available in this context
			// (Electron renderer with nodeIntegration or contextBridge)
			if (typeof process !== 'undefined' && (process as any).versions?.electron) {
				this.logService.debug('[WorktreeService] execGit: falling back to child_process.spawn');
				return await this._execGitNodeFallback(cwd, args);
			}

			// Last resort: report that git execution is not available
			this.logService.error('[WorktreeService] execGit: No git execution method available');
			throw new Error('Git execution not available in this context');
		} catch (err) {
			// Use info (not warn): most errors here are expected git command failures (non-zero exit)
			// which are already logged above; unexpected errors (IPC failure, etc.) are rare.
			this.logService.debug('[WorktreeService] execGit: error:', err);
			throw err;
		}
	}

	/**
	 * Launch a worktree's VsSaros instance ("debug"): compile the worktree's
	 * out/ then start a dev-mode instance loading that worktree's source. The
	 * heavy lifting (junction node_modules → transpile-client → detached spawn)
	 * happens in the main process via the 'vscode:launchWorktreeDebug' IPC
	 * handler, mirroring scripts/code.bat + dev-worktree.ps1.
	 */
	async launchDebug(worktreePath: string): Promise<{ success: boolean; stderr: string }> {
		try {
			this.logService.debug(`[WorktreeService] launchDebug: ${worktreePath}`);
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				return await vscodeBridge.ipcRenderer.invoke('vscode:launchWorktreeDebug', { worktreePath });
			}
			return { success: false, stderr: 'IPC bridge (vscode.ipcRenderer.invoke) not available in this context' };
		} catch (err) {
			this.logService.debug('[WorktreeService] launchDebug: error:', err);
			return { success: false, stderr: (err as Error)?.message ?? String(err) };
		}
	}

	async resolveDebugPlan(worktreePath: string): Promise<{ success: boolean; strategy?: string; label?: string; buildCommand?: string; launchCommand?: string; env?: Record<string, string>; stderr?: string }> {
		try {
			this.logService.debug(`[WorktreeService] resolveDebugPlan: ${worktreePath}`);
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				return await vscodeBridge.ipcRenderer.invoke('vscode:resolveWorktreeDebugPlan', { worktreePath });
			}
			return { success: false, stderr: 'IPC bridge (vscode.ipcRenderer.invoke) not available in this context' };
		} catch (err) {
			this.logService.debug('[WorktreeService] resolveDebugPlan: error:', err);
			return { success: false, stderr: (err as Error)?.message ?? String(err) };
		}
	}

	private _execGitNodeFallback(cwd: string, args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			try {
				// In Electron renderer, we can require child_process through the node integration
				// eslint-disable-next-line local/code-import-patterns
				const cp = require('child_process') as typeof import('child_process');
				this.logService.debug(`[WorktreeService] _execGitNodeFallback: spawning git ${args.join(' ')} in ${cwd}`);
				const child = cp.spawn('git', args, {
					cwd,
					env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
					windowsHide: true,
				});

				let stdout = '';
				let stderr = '';

				child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
				child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

				child.on('error', (err) => {
					this.logService.error(`[WorktreeService] _execGitNodeFallback: spawn error: ${err.message}`);
					reject(new Error(`git spawn error: ${err.message}`));
				});

				child.on('close', (code) => {
					if (code === 0) {
						this.logService.debug(`[WorktreeService] _execGitNodeFallback: success, stdout length=${stdout.length}`);
						resolve(stdout);
					} else {
						this.logService.error(`[WorktreeService] _execGitNodeFallback: failed, code=${code}, stderr="${stderr}"`);
						reject(new Error(stderr || `git exited with code ${code}`));
					}
				});
			} catch (err) {
				this.logService.error('[WorktreeService] _execGitNodeFallback: exception:', err);
				reject(err);
			}
		});
	}

	private parseWorktreeList(output: string, mainFolder: string): IWorktreeDetail[] {
		const items: IWorktreeDetail[] = [];
		const lines = output.split('\n');

		let current: Partial<IWorktreeOutputItem> = {};
		let firstWorktree = true;

		for (const line of lines) {
			if (line.startsWith('worktree ')) {
				if (current.worktree) {
					items.push(this.toWorktreeDetail(current as IWorktreeOutputItem, firstWorktree, mainFolder));
					firstWorktree = false;
				}
				current = { worktree: line.substring('worktree '.length) };
			} else if (line.startsWith('HEAD ')) {
				current.HEAD = line.substring('HEAD '.length);
			} else if (line.startsWith('branch ')) {
				current.branch = line.substring('branch '.length).replace('refs/heads/', '');
			} else if (line === 'detached') {
				current.detached = true;
			} else if (line === 'bare') {
				current.isBare = true;
			} else if (line.startsWith('prunable')) {
				current.prunable = line.substring('prunable '.length) || 'true';
			} else if (line.startsWith('locked')) {
				current.locked = line.substring('locked '.length) || 'true';
			} else if (line === '' && current.worktree) {
				items.push(this.toWorktreeDetail(current as IWorktreeOutputItem, firstWorktree, mainFolder));
				firstWorktree = false;
				current = {};
			}
		}

		// Handle last item
		if (current.worktree) {
			items.push(this.toWorktreeDetail(current as IWorktreeOutputItem, firstWorktree, mainFolder));
		}

		return items;
	}

	private toWorktreeDetail(item: IWorktreeOutputItem, isMain: boolean, mainFolder: string): IWorktreeDetail {
		const isBranch = !!item.branch;
		const name = isBranch
			? item.branch!
			: item.HEAD ? item.HEAD.substring(0, 7) : 'unknown';

		return {
			name,
			path: item.worktree,
			hash: item.HEAD ?? '',
			detached: item.detached ?? false,
			prunable: !!item.prunable,
			isBare: item.isBare ?? false,
			isBranch,
			locked: !!item.locked,
			isMain,
			mainFolder,
			branch: item.branch,
		};
	}

	async listGitBranches(repoPath: string): Promise<string[]> {
		try {
			// 1. List all local branches
			const branchOutput = await this.execGit(repoPath, ['branch', '--format=%(refname:short)']);
			const allBranches = branchOutput
				.split('\n')
				.map(b => b.trim())
				.filter(b => b.length > 0);

			// 2. Get branches already checked out in worktrees (cannot be reused)
			const worktreeOutput = await this.execGit(repoPath, ['worktree', 'list', '--porcelain']);
			const usedBranches = new Set<string>();
			for (const line of worktreeOutput.split('\n')) {
				if (line.startsWith('branch ')) {
					const branchRef = line.slice(7).trim();
					const branchName = branchRef.replace(/^refs\/heads\//, '');
					usedBranches.add(branchName);
				}
			}

			// 3. Exclude branches already in use by a worktree
			const result = allBranches.filter(b => !usedBranches.has(b));
			return result;
		} catch (e) {
			this.logService.warn('[WorktreeService] Failed to list branches:', e);
			return [];
		}
	}

	// ─── Extended metadata (VS Code compatible) ─────────────────────────

	async getWorktreeMetadata(worktreePath: string): Promise<Partial<IWorktreeDetail>> {
		try {
			// Check cache first (avoids redundant git commands when called frequently)
			const cached = this._metadataCache.get(worktreePath);
			if (cached && (Date.now() - cached.timestamp) < WorktreeService.METADATA_CACHE_TTL) {
				this.logService.debug(`[WorktreeService] getWorktreeMetadata: cache hit for ${worktreePath}`);
				return cached.result;
			}

			this.logService.debug(`[WorktreeService] getWorktreeMetadata: computing for ${worktreePath}`);

			const metadata: Partial<IWorktreeDetail> = {};

			// 1. Get current branch and upstream
			let currentBranch: string | undefined;
			try {
				const branchOutput = await this.execGit(worktreePath, ['symbolic-ref', '--short', 'HEAD']);
				currentBranch = branchOutput.trim();
				metadata.branch = currentBranch;

				// Try to get upstream branch
				try {
					const upstreamOutput = await this.execGit(worktreePath, ['rev-parse', '--abbrev-ref', `${currentBranch}@{upstream}`]);
					metadata.upstreamBranch = upstreamOutput.trim();
				} catch {
					// No upstream branch
				}
			} catch {
				metadata.detached = true;
			}

			// 2. Get incoming/outgoing changes (compared to upstream)
			if (currentBranch && metadata.upstreamBranch) {
				try {
					// Outgoing: commits in local branch but not in upstream
					const outgoingOutput = await this.execGit(worktreePath, ['rev-list', '--count', `${metadata.upstreamBranch}..HEAD`]);
					metadata.outgoingChanges = parseInt(outgoingOutput.trim(), 10) || 0;
				} catch {
					metadata.outgoingChanges = 0;
				}

				try {
					// Incoming: commits in upstream but not in local branch
					const incomingOutput = await this.execGit(worktreePath, ['rev-list', '--count', `HEAD..${metadata.upstreamBranch}`]);
					metadata.incomingChanges = parseInt(incomingOutput.trim(), 10) || 0;
				} catch {
					metadata.incomingChanges = 0;
				}
			}

			// 3. Get uncommitted changes count
			try {
				const statusOutput = await this.execGit(worktreePath, ['status', '--porcelain']);
				metadata.uncommittedChanges = statusOutput.trim() ? statusOutput.trim().split('\n').length : 0;
			} catch {
				metadata.uncommittedChanges = 0;
			}

			// 4. Check for GitHub remote
			try {
				const remoteOutput = await this.execGit(worktreePath, ['remote', '-v']);
				metadata.hasGitHubRemote = remoteOutput.includes('github.com');
			} catch {
				metadata.hasGitHubRemote = false;
			}

			// 5. Get last commit message
			try {
				const logOutput = await this.execGit(worktreePath, ['log', '-1', '--pretty=%s']);
				metadata.lastCommitMessage = logOutput.trim();
			} catch {
				// Ignore
			}

			this.logService.debug(`[WorktreeService] getWorktreeMetadata: result=`, metadata);

			// Store in cache
			this._metadataCache.set(worktreePath, { result: metadata, timestamp: Date.now() });

			return metadata;
		} catch (e) {
			this.logService.error('[WorktreeService] getWorktreeMetadata failed:', e);
			return {};
		}
	}

	async getWorktreeChanges(worktreePath: string): Promise<readonly { filePath: string; status: 'added' | 'modified' | 'deleted' }[]> {
		try {
			this.logService.debug(`[WorktreeService] getWorktreeChanges: ${worktreePath}`);

			// Use git status --porcelain to get ALL changed files (staged + unstaged + untracked)
			const output = await this.execGit(worktreePath, ['status', '--porcelain']);
			if (!output.trim()) {
				return [];
			}

			const changes: { filePath: string; status: 'added' | 'modified' | 'deleted' }[] = [];
			for (const line of output.trim().split('\n')) {
				// Format: XY FILE (or "?? FILE" for untracked)
				// X = index status, Y = working tree status
				const match = line.match(/^(..)\t(.+)$/);
				if (!match) {
					continue;
				}

				const [, statusCodes, filePath] = match;
				const indexStatus = statusCodes[0];
				const workingStatus = statusCodes[1];

				// Map git status codes to our simplified status
				let status: 'added' | 'modified' | 'deleted';
				if (indexStatus === 'A' || indexStatus === '?' || workingStatus === '?' || indexStatus === 'A') {
					status = 'added';  // Added or untracked
				} else if (indexStatus === 'D' || workingStatus === 'D') {
					status = 'deleted';  // Deleted
				} else {
					status = 'modified';  // Modified, renamed, etc.
				}

				changes.push({ filePath, status });
			}

			this.logService.debug(`[WorktreeService] getWorktreeChanges: ${changes.length} changed file(s)`);
			return changes;
		} catch (e) {
			this.logService.error('[WorktreeService] getWorktreeChanges failed:', e);
			return [];
		}
	}

	async refreshWorktreeMetadata(worktreePath: string): Promise<void> {
		try {
			this.logService.debug(`[WorktreeService] refreshWorktreeMetadata: ${worktreePath}`);

			// Re-fetch metadata (result can be used to update cache if needed)
			await this.getWorktreeMetadata(worktreePath);

			// Notify listeners
			this._onDidChangeWorktreeState.fire({
				directory: worktreePath,
				status: WorktreeStatus.Ready,
			});

			this.logService.debug(`[WorktreeService] refreshWorktreeMetadata: completed`);
		} catch (e) {
			this.logService.error('[WorktreeService] refreshWorktreeMetadata failed:', e);
		}
	}

	async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
		try {
			const output = await this.execGit(worktreePath, ['status', '--porcelain']);
			return output.trim().length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * ★ 该 worktree 是否有**未推送到任何 remote** 的提交（hermes-agent-studio 判据）。
	 *
	 * 为什么需要：`git worktree remove` 只删工作目录，**提交留在分支上**。
	 * 所以「删 worktree 顺手 `branch -D`」在分支有未推送提交时 = **静默销毁真实工作**。
	 * 判据用于：非 force 删除时，有未推送提交 ⇒ **保留分支**（只删目录）。
	 */
	async hasUnpushedCommits(worktreePath: string): Promise<boolean> {
		return this._hasUnpushedCommits(worktreePath, 'HEAD');
	}

	/**
	 * `ref` 相对**所有 remote** 是否有未推送提交。
	 *
	 * ⚠ 无 remote 时 `--not --remotes` 不排除任何提交 ⇒ 恒为 true ⇒ 分支只增不减。
	 * 那种情况下不存在"推送"这个去处，显式返回 false（否则永远删不掉分支）。
	 */
	private async _hasUnpushedCommits(cwd: string, ref: string): Promise<boolean> {
		try {
			const remotes = (await this.execGit(cwd, ['remote'])).trim();
			if (!remotes) {
				return false;
			}
			const output = await this.execGit(cwd, ['log', '--oneline', ref, '--not', '--remotes']);
			return output.trim().length > 0;
		} catch (e) {
			// 无法判定时**保守**返回 false：调用方只在"确定有未推送"时才保留分支，
			// 若这里恒为 true 会让分支永久累积；而误删分支的代价由 force 语义兜底。
			this.logService.warn(`[WorktreeService] hasUnpushedCommits(${ref}) failed, treating as none:`, e);
			return false;
		}
	}

	/**
	 * 把 `.worktrees/` 注册进仓库的**本地**排除文件（`.git/info/exclude`）。
	 *
	 * ── 为什么必需 ────────────────────────────────────────────────────────
	 * 本服务把 worktree 建在**仓库内**（`<repoRoot>/.worktrees/<name>`），而原实现只在
	 * `makeWorktreeInfo` 的注释里写了一句「Add ".worktrees/" to the repo's .gitignore」
	 * —— 把这件事**推给了用户**。忘加的后果不是小事：
	 *   · worktree 是**一整份源码副本** ⇒ 主 checkout 的 `git status` 立刻涌出成千上万条
	 *     「未跟踪」条目，SCM 面板被淹没；
	 *   · 更糟的是「全部暂存」/ `git add -A` 会把整份副本**提交进仓库**。
	 *
	 * ── 为什么写 `.git/info/exclude` 而**不是** `.gitignore` ──────────────
	 * `.gitignore` 是**受版本控制的用户资产** —— 程序去改它，就是 2026-09-14
	 * 「用户手写的 `.code-workspace` 被回写」那类事故的同一条路，绝不能再走。
	 * `.git/info/exclude` 是 git 为「本仓库本地的忽略规则」提供的**官方位置**：
	 * 不进版本控制、不与他人共享、随时可删 ⇒ 效果相同而风险为零。
	 *
	 * 幂等 + 非阻断：
	 *   · 先问 git（`check-ignore`）—— 已被忽略（无论来自 `.gitignore` 还是别处配置）
	 *     就**什么都不做**，绝不重复追加；
	 *   · 任何失败只 warn：这是便利措施，不能阻断 worktree 创建。
	 */
	private async _ensureWorktreeDirIgnored(repoRoot: string): Promise<void> {
		const IGNORE_ENTRY = '.worktrees/';
		try {
			// `check-ignore -q` 在「已忽略」时 exit 0（`execGit` 对非零退出抛错）。
			await this.execGit(repoRoot, ['check-ignore', '-q', '.worktrees']);
			return;
		} catch {
			// 未被忽略 ⇒ 走下面的兜底写入。
		}

		try {
			const excludeUri = URI.joinPath(URI.file(repoRoot), '.git', 'info', 'exclude');
			// `.git` 是**文件**时（repoRoot 本身是个 worktree / submodule）该路径不存在。
			// 那种情况下它不是仓库主目录，不该往里写；也**不创建** —— 宁可不做，
			// 也别在陌生布局里凭空造文件。
			if (!await this.fileService.exists(excludeUri)) {
				this.logService.debug('[WorktreeService] .git/info/exclude not found; skipping worktree ignore registration');
				return;
			}
			const existing = (await this.fileService.readFile(excludeUri)).value.toString();
			const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
			const appended = `${separator}\n# Added by VsSaros: keep in-repo worktrees out of SCM\n${IGNORE_ENTRY}\n`;
			await this.fileService.writeFile(excludeUri, VSBuffer.fromString(existing + appended));
			this.logService.info(`[WorktreeService] Registered "${IGNORE_ENTRY}" in .git/info/exclude (${repoRoot})`);
		} catch (e) {
			// 只 warn —— 排除是便利措施，绝不能阻断 worktree 创建。
			this.logService.warn('[WorktreeService] failed to register .worktrees/ in .git/info/exclude:', e);
		}
	}

	// ─── Lock / Unlock（★ 2026-09-15）───────────────────────────────────────────

	/**
	 * `git worktree lock` —— 保护 worktree 不被 `prune` 回收。
	 *
	 * 为什么值得有：`pruneWorktrees()` 会回收"git 认为不可达"的工作树元数据；
	 * 而工作树所在目录若在**网络盘 / 暂时不可达的挂载点**上（或另一台机器正挂着），
	 * git 会误判为可回收 —— lock 是唯一的原生防护手段。
	 * 此前本服务**只解析** `locked` 状态（UI 也能显示锁定图标）却没有设置入口。
	 */
	async lockWorktree(worktreePath: string, reason?: string): Promise<void> {
		const args = ['worktree', 'lock'];
		if (reason) {
			args.push('--reason', reason);
		}
		args.push(worktreePath);
		await this.execGit((await this.getRepositoryRoot()) ?? worktreePath, args);
		this.logService.info(`[WorktreeService] Locked worktree: ${worktreePath}${reason ? ` (reason: ${reason})` : ''}`);
		this._onDidChangeWorktrees.fire();
	}

	/** `git worktree unlock`。 */
	async unlockWorktree(worktreePath: string): Promise<void> {
		await this.execGit((await this.getRepositoryRoot()) ?? worktreePath, ['worktree', 'unlock', worktreePath]);
		this.logService.info(`[WorktreeService] Unlocked worktree: ${worktreePath}`);
		this._onDidChangeWorktrees.fire();
	}

	// ─── Cleanup（★ 2026-09-15）────────────────────────────────────────────────

	/**
	 * **只读**扫描清理候选（陈旧 worktree + 孤儿分支）。
	 *
	 * ⚠ 本方法**不做任何修改** —— 删除必须由用户在确认后单独触发
	 * （{@link cleanupWorktrees}）。原因：本仓的 worktree 是用户**长期资产**，
	 * 不像 hermes-agent-studio 那种「一次会话一个、可按时长自动回收」的一次性目录；
	 * 按龄自动删会销毁用户工作，属产品决策而非实现细节。
	 *
	 * 两类候选的共同硬前提：**没有未推送提交** —— 那是真正会丢的工作。
	 */
	async listCleanupCandidates(repoPath: string, options?: IWorktreeCleanupOptions): Promise<IWorktreeCleanupCandidate[]> {
		const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_WORKTREE_MS;
		const candidates: IWorktreeCleanupCandidate[] = [];
		const now = Date.now();

		let worktrees: IWorktreeDetail[] = [];
		try {
			worktrees = await this.listWorktrees(repoPath);
		} catch (e) {
			this.logService.warn('[WorktreeService] listCleanupCandidates: listWorktrees failed:', e);
			return [];
		}

		// ① 陈旧 worktree：主树 / 裸库 / 已锁定 / 有未推送提交 —— 一律排除。
		for (const w of worktrees) {
			if (w.isMain || w.isBare || w.locked) {
				continue;
			}
			if (await this._hasUnpushedCommits(w.path, 'HEAD')) {
				continue;
			}

			let lastModifiedMs: number | undefined;
			try {
				lastModifiedMs = (await this.fileService.stat(URI.file(w.path))).mtime;
			} catch {
				// 目录已不可达：git 仍登记着它 ⇒ 这属于 prune 的范畴（元数据回收），
				// 不当作"陈旧 worktree"候选（避免误删正在挂载中的路径）。
				continue;
			}

			const age = now - lastModifiedMs;
			if (age < staleAfterMs) {
				continue;
			}
			const days = Math.floor(age / (24 * 60 * 60 * 1000));
			candidates.push({
				kind: 'stale-worktree',
				path: w.path,
				branch: w.branch,
				lastModifiedMs,
				reason: `${days} 天未改动，且没有未推送的提交`,
			});
		}

		// ② 孤儿分支：本仓命名空间内、没有任何 worktree 占用、且无未推送提交。
		//    这类分支的来源是历史 bug（删 worktree 时删错了分支名）⇒ 只增不减。
		const occupied = new Set(worktrees.map(w => w.branch).filter((b): b is string => !!b));
		let branches: string[] = [];
		try {
			branches = await this.listGitBranches(repoPath);
		} catch (e) {
			this.logService.warn('[WorktreeService] listCleanupCandidates: listGitBranches failed:', e);
		}
		for (const raw of branches) {
			const branch = raw.replace(/^refs\/heads\//, '').trim();
			if (!branch || branch === 'HEAD') {
				continue;
			}
			if (!branch.startsWith(WORKTREE_BRANCH_PREFIX)) {
				continue;
			}
			if (occupied.has(branch)) {
				continue;
			}
			if (await this._hasUnpushedCommits(repoPath, branch)) {
				continue;
			}
			candidates.push({
				kind: 'orphan-branch',
				branch,
				reason: '没有任何 worktree 使用它，且没有未推送的提交',
			});
		}

		this.logService.info(`[WorktreeService] listCleanupCandidates: ${candidates.length} candidate(s) in ${repoPath}`);
		return candidates;
	}

	/**
	 * 执行清理（逐个删除给定候选）。
	 *
	 * ⚠ **调用方必须已获得用户确认** —— 本方法不做二次确认。
	 * 逐个执行、失败不中断：`removed` / `failed` 分开返回，避免"部分失败"被吞掉。
	 *
	 * 删除 worktree 时用 `force=false`：万一候选扫描与实际状态之间发生了变化
	 * （例如扫描后用户往里写了东西），非 force 会让 git 拒绝删除脏工作树 ⇒ 安全。
	 */
	async cleanupWorktrees(repoPath: string, candidates: readonly IWorktreeCleanupCandidate[]): Promise<IWorktreeCleanupResult> {
		const removed: string[] = [];
		const failed: { target: string; error: string }[] = [];

		for (const candidate of candidates) {
			const target = candidate.path ?? candidate.branch ?? '<unknown>';
			try {
				if (candidate.kind === 'stale-worktree' && candidate.path) {
					await this.removeWorktree(candidate.path, false);
					removed.push(candidate.path);
				} else if (candidate.kind === 'orphan-branch' && candidate.branch) {
					await this.execGit(repoPath, ['branch', '-D', candidate.branch]);
					removed.push(candidate.branch);
				}
			} catch (e) {
				failed.push({ target, error: e instanceof Error ? e.message : String(e) });
				this.logService.warn(`[WorktreeService] cleanup failed for ${target}:`, e);
			}
		}

		if (removed.length > 0) {
			this._onDidChangeWorktrees.fire();
		}
		this.logService.info(`[WorktreeService] cleanupWorktrees: removed=${removed.length} failed=${failed.length}`);
		return { removed, failed };
	}

	// ─── Checkpoint lifecycle (VS Code compatible) ─────────────────────

	async notifyRequestStart(sessionId: string, worktreePath: string): Promise<void> {
		try {
			this.logService.debug(`[WorktreeService] notifyRequestStart: session=${sessionId}, worktree=${worktreePath}`);

		// Lazily get the checkpoint service
		const checkpointService = this._instantiationService?.invokeFunction((accessor: any) => {
			try {
				return accessor.get(IWorktreeCheckpointService);
			} catch {
				return undefined;
			}
		});

		if (checkpointService) {
			await checkpointService.createBaselineCheckpoint(sessionId, worktreePath);
			this.logService.debug(`[WorktreeService] notifyRequestStart: baseline checkpoint created`);
		} else {
			this.logService.warn(`[WorktreeService] notifyRequestStart: WorktreeCheckpointService not available`);
		}
		} catch (e) {
			this.logService.error('[WorktreeService] notifyRequestStart failed:', e);
		}
	}

	async notifyRequestComplete(sessionId: string, worktreePath: string, requestId: string): Promise<void> {
		try {
			this.logService.debug(`[WorktreeService] notifyRequestComplete: session=${sessionId}, request=${requestId}`);

		// Lazily get the checkpoint service
		const checkpointService = this._instantiationService?.invokeFunction((accessor: any) => {
			try {
				return accessor.get(IWorktreeCheckpointService);
			} catch {
				return undefined;
			}
		});

		if (checkpointService) {
			await checkpointService.createPostTurnCheckpoint(sessionId, worktreePath, requestId);
			this.logService.debug(`[WorktreeService] notifyRequestComplete: post-turn checkpoint created`);
		} else {
			this.logService.warn(`[WorktreeService] notifyRequestComplete: WorktreeCheckpointService not available`);
		}
		} catch (e) {
			this.logService.error('[WorktreeService] notifyRequestComplete failed:', e);
		}
	}
}
