/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorktreeService } from '../common/worktreeService.js';
import { IWorktreeDetail, ICreateWorktreeInfo, IWorktreeOutputItem, IWorktreeInfoOptions, IWorktreeInfo, WorktreeStatus, IWorktreeStateEvent } from '../common/worktreeTypes.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { timeout } from '../../../../base/common/async.js';

/**
 * Slugify a name: lowercase, replace non-alphanumeric with hyphens, collapse multiple hyphens.
 */
function slugify(name: string): string {
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

	private _repositoryRoot: string | undefined;

	/** Track worktree states by directory path */
	private readonly _worktreeStates = new Map<string, WorktreeStatus>();
	/** Pending waiters for worktree ready/failed */
	private readonly _worktreeWaiters = new Map<string, Array<(status: WorktreeStatus) => void>>();

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._repositoryRoot = undefined;
			this._onDidChangeWorktrees.fire();
		}));
	}

	async getRepositoryRoot(): Promise<string | undefined> {
		if (this._repositoryRoot !== undefined) {
			this.logService.info(`[WorktreeService] getRepositoryRoot: cached "${this._repositoryRoot}"`);
			return this._repositoryRoot;
		}

		const folders = this.workspaceContextService.getWorkspace().folders;
		this.logService.info(`[WorktreeService] getRepositoryRoot: workspace folders count=${folders.length}`);
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
					this.logService.info(`[WorktreeService] getRepositoryRoot: found .git at "${folder.uri.fsPath}", repoRoot="${this._repositoryRoot}"`);
					return this._repositoryRoot;
				}
			} catch {
				this.logService.warn(`[WorktreeService] getRepositoryRoot: no .git in "${folder.uri.fsPath}"`);
			}
		}

		this.logService.error('[WorktreeService] getRepositoryRoot: no .git found in any workspace folder');
		return undefined;
	}

	async listWorktrees(repoPath: string): Promise<IWorktreeDetail[]> {
		try {
			this.logService.info(`[WorktreeService] listWorktrees: repoPath="${repoPath}"`);
			const output = await this.execGit(repoPath, ['worktree', 'list', '--porcelain']);
			this.logService.info(`[WorktreeService] listWorktrees: output="${output}"`);
			const result = this.parseWorktreeList(output, repoPath);
			this.logService.info(`[WorktreeService] listWorktrees: parsed ${result.length} worktrees`);
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
		this.logService.info('[WorktreeService] makeWorktreeInfo: called', { options });
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

		// Branch naming: use options.branch if provided, otherwise default to "worktree/<slug>"
		const branch = options?.detached ? undefined : (options?.branch || `worktree/${name}`);
		this.logService.info('[WorktreeService] makeWorktreeInfo: computed', { name, branch, detached: options?.detached });

		// Directory: <repoRoot>/.sarosisworkspace/.worktree/<name>
		const worktreeBase = repoRoot.replace(/[/\\]$/, '') + '/.sarosisworkspace/.worktree';
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
				this.logService.info(`[WorktreeService] makeWorktreeInfo: directory exists, will add suffix: ${finalDirectory}`);
			} catch {
				// Directory doesn't exist — good
			}

			// Check branch existence (if not detached)
			if (finalBranch) {
				try {
					await this.execGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${finalBranch}`]);
					// Branch exists, need to add suffix
					conflict = true;
					this.logService.info(`[WorktreeService] makeWorktreeInfo: branch exists, will add suffix: ${finalBranch}`);
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
			finalBranch = options?.detached ? undefined : (options?.branch ? `${options.branch}-${suffix}` : `worktree/${finalName}`);
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

		// Ensure .sarosisworkspace/.worktree directory exists
		const worktreeBaseUri = URI.joinPath(URI.file(repoRoot), '.sarosisworkspace', '.worktree');
		try {
			await this.fileService.stat(worktreeBaseUri);
			// Directory exists, good
		} catch {
			// Directory doesn't exist, create it
			this.logService.info(`[WorktreeService] Creating .sarosisworkspace/.worktree directory: ${worktreeBaseUri.fsPath}`);
			await this.fileService.createFolder(worktreeBaseUri);
		}

		// Phase 2a: git worktree add --no-checkout [-b <branch>] <dir>
		const args = ['worktree', 'add', '--no-checkout'];
		if (info.branch) {
			args.push('-b', info.branch);
		}
		args.push(info.directory);

		await this.execGit(repoRoot, args);

		// Phase 2b: git reset --hard (populate files)
		await this.execGit(info.directory, ['reset', '--hard']);

		// Phase 2c: push new branch to remote (so it appears on GitHub/GitLab)
		if (info.branch) {
			try {
				this.logService.info(`[WorktreeService] Pushing branch ${info.branch} to origin...`);
				await this.execGit(repoRoot, ['push', '-u', 'origin', info.branch]);
				this.logService.info(`[WorktreeService] Branch ${info.branch} pushed to origin successfully`);
			} catch (pushErr) {
				// Push failure is non-fatal — branch exists locally, user can push manually
				this.logService.warn(`[WorktreeService] Failed to push branch ${info.branch} to origin:`, pushErr);
			}
		}

		this._onDidChangeWorktrees.fire();

		// Boot phase (fire-and-forget, like opencode's fork pattern)
		this.bootWorktree(info);
	}

	private async bootWorktree(info: IWorktreeInfo): Promise<void> {
		try {
			// Verify the worktree is populated
			await this.execGit(info.directory, ['status', '--porcelain']);

			// Mark as ready
			this.setWorktreeState(info.directory, WorktreeStatus.Ready);
			this.logService.info(`[WorktreeService] Worktree boot complete: ${info.directory}`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.setWorktreeState(info.directory, WorktreeStatus.Failed, message);
			this.logService.error(`[WorktreeService] Worktree boot failed: ${info.directory}`, e);
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

		// 1. Stop fsmonitor daemon in the worktree
		try {
			await this.execGit(worktreePath, ['fsmonitor', '--stop']);
		} catch {
			// Not critical, continue
		}

		// 2. git worktree remove [--force]
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
			const stillExists = worktrees.some(w => w.path === worktreePath);
			if (!stillExists) {
				this.logService.info('[WorktreeService] Worktree already removed from git list');
			} else {
				throw e; // Re-throw if it still exists
			}
		}

		// 3. Manual cleanup of residual directory (opencode pattern)
		try {
			const dirUri = URI.file(worktreePath);
			const stat = await this.fileService.stat(dirUri);
			if (stat) {
				await this.fileService.del(dirUri, { recursive: true });
				this.logService.info(`[WorktreeService] Cleaned up residual directory: ${worktreePath}`);
			}
		} catch {
			// Directory already gone, that's fine
		}

		// 4. Delete the associated branch (opencode/<name> pattern)
		try {
			// Try to delete opencode/* branch matching the worktree name
			const worktreeName = worktreePath.split(/[/\\]/).pop();
			if (worktreeName) {
				const branchName = `opencode/${worktreeName}`;
				await this.execGit(repoRoot, ['branch', '-D', branchName]);
				this.logService.info(`[WorktreeService] Deleted branch: ${branchName}`);
			}
		} catch {
			// Branch may not exist or may be the current branch — ignore
		}

		// 5. Prune
		try {
			await this.execGit(repoRoot, ['worktree', 'prune']);
		} catch {
			// Not critical
		}

		// 6. Clean up state tracking
		this._worktreeStates.delete(worktreePath);

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
			this.logService.info(`[WorktreeService] execGit: git ${args.join(' ')} (cwd: ${cwd})`);

			// Use the ipcRenderer bridge exposed by the Electron preload script
			// to invoke the 'vscode:execGit' handler in the main process.
			const vscodeBridge = (globalThis as any).vscode;
			if (vscodeBridge?.ipcRenderer?.invoke) {
				try {
					this.logService.info('[WorktreeService] execGit: using vscode.ipcRenderer.invoke bridge');
					const result: { success: boolean; stdout: string; stderr: string; exitCode: number } =
						await vscodeBridge.ipcRenderer.invoke('vscode:execGit', cwd, args);
					if (result.success) {
						this.logService.info(`[WorktreeService] execGit: success, stdout length=${result.stdout.length}`);
						return result.stdout;
					}
					this.logService.error(`[WorktreeService] execGit: failed, stderr="${result.stderr}", exitCode=${result.exitCode}`);
					throw new Error(result.stderr || `git exited with code ${result.exitCode}`);
				} catch (invokeErr) {
					this.logService.warn('[WorktreeService] execGit: ipcRenderer.invoke failed, trying fallback:', invokeErr);
				}
			}

			// Fallback: use Node.js child_process if available in this context
			// (Electron renderer with nodeIntegration or contextBridge)
			if (typeof process !== 'undefined' && (process as any).versions?.electron) {
				this.logService.info('[WorktreeService] execGit: falling back to child_process.spawn');
				return await this._execGitNodeFallback(cwd, args);
			}

			// Last resort: report that git execution is not available
			this.logService.error('[WorktreeService] execGit: No git execution method available');
			throw new Error('Git execution not available in this context');
		} catch (err) {
			this.logService.error('[WorktreeService] execGit: error:', err);
			throw err;
		}
	}

	private _execGitNodeFallback(cwd: string, args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			try {
				// In Electron renderer, we can require child_process through the node integration
				// eslint-disable-next-line local/code-import-patterns
				const cp = require('child_process') as typeof import('child_process');
				this.logService.info(`[WorktreeService] _execGitNodeFallback: spawning git ${args.join(' ')} in ${cwd}`);
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
						this.logService.info(`[WorktreeService] _execGitNodeFallback: success, stdout length=${stdout.length}`);
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
}
