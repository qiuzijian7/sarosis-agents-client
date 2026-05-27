/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../../base/common/event.js';

/**
 * Result of a git operation
 */
export interface IGitOperationResult {
	success: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Result of commit + push across multiple remotes
 */
export interface ICommitAndPushResult {
	commitResult: IGitOperationResult;
	pushResults: Map<string, IGitOperationResult>;
	/** Human-readable summary of what happened */
	summary: string;
}

export interface IGitRemote {
	name: string;
	url: string;
}

export interface IGitStatus {
	hasChanges: boolean;
	staged: string[];
	unstaged: string[];
	untracked: string[];
	branch: string;
	ahead: number;
	behind: number;
}

export const IGitCommitService = createDecorator<IGitCommitService>('agentStudio.gitCommitService');

/**
 * Single git log entry
 */
export interface IGitLogEntry {
	hash: string;
	shortHash: string;
	message: string;
	author: string;
	email: string;
	date: string;
	relativeDate: string;
	refs: string;
}

export interface IGitCommitService {
	readonly _serviceBrand: undefined;

	readonly onDidCommitAndPush: Event<ICommitAndPushResult>;

	/**
	 * Set the working directory for git operations
	 */
	setWorkingDirectory(cwd: string): void;

	/**
	 * Get the current git status
	 */
	getStatus(): Promise<IGitStatus>;

	/**
	 * List all configured remotes
	 */
	getRemotes(): Promise<IGitRemote[]>;

	/**
	 * Get commit history (git log)
	 * @param count Number of commits to retrieve
	 */
	getLog(count?: number): Promise<IGitLogEntry[]>;

	/**
	 * Commit all changes (git add -A + git commit) and push to all remotes
	 * @param message Commit message. If not provided, auto-generates based on changes.
	 * @param remotes Specific remotes to push to. If empty, pushes to all remotes.
	 */
	commitAndPushAll(message?: string, remotes?: string[]): Promise<ICommitAndPushResult>;

	/**
	 * Just commit without pushing
	 */
	commitAll(message?: string): Promise<IGitOperationResult>;

	/**
	 * Push to specific remotes (or all if not specified)
	 */
	pushToRemotes(remotes?: string[]): Promise<Map<string, IGitOperationResult>>;
}

/**
 * GitCommitService — executes git operations via a spawned process.
 *
 * [Sarosis] In the sessions workbench (Electron renderer), we execute git
 * commands by posting messages to the main process via IPC. Since the
 * sessions workbench runs in a browser context, we use a technique similar
 * to the terminal service: spawn git commands through the native host.
 *
 * For simplicity and reliability in this Electron environment, we use
 * a direct approach with the global `window.__sarosisExecGit` bridge
 * that the preload script exposes, or fall back to fetch-based IPC.
 */
export class GitCommitService extends Disposable implements IGitCommitService {
	declare readonly _serviceBrand: undefined;

	private _cwd: string = '';

	private readonly _onDidCommitAndPush = this._register(new Emitter<ICommitAndPushResult>());
	readonly onDidCommitAndPush: Event<ICommitAndPushResult> = this._onDidCommitAndPush.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	setWorkingDirectory(cwd: string): void {
		this._cwd = cwd;
		this._logService.info(`[GitCommitService] Working directory set to: ${cwd}`);
	}

	async getStatus(): Promise<IGitStatus> {
		const result = await this._execGit(['status', '--porcelain=v2', '--branch']);
		if (!result.success) {
			return { hasChanges: false, staged: [], unstaged: [], untracked: [], branch: '', ahead: 0, behind: 0 };
		}

		const lines = result.stdout.split('\n').filter(l => l.trim());
		const staged: string[] = [];
		const unstaged: string[] = [];
		const untracked: string[] = [];
		let branch = '';
		let ahead = 0;
		let behind = 0;

		for (const line of lines) {
			if (line.startsWith('# branch.head ')) {
				branch = line.substring('# branch.head '.length);
			} else if (line.startsWith('# branch.ab ')) {
				const match = line.match(/\+(\d+) -(\d+)/);
				if (match) {
					ahead = parseInt(match[1], 10);
					behind = parseInt(match[2], 10);
				}
			} else if (line.startsWith('1 ') || line.startsWith('2 ')) {
				// Changed entries: "1 XY sub mH mI mW hH hI path" or "2 XY sub ... path\torigPath"
				const xy = line.substring(2, 4);
				const pathPart = line.split('\t')[0]; // before tab (for renames)
				const pathSegments = pathPart.split(' ');
				const filePath = pathSegments[pathSegments.length - 1];

				if (xy[0] !== '.') {
					staged.push(filePath);
				}
				if (xy[1] !== '.') {
					unstaged.push(filePath);
				}
			} else if (line.startsWith('? ')) {
				untracked.push(line.substring(2));
			}
		}

		return {
			hasChanges: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
			staged,
			unstaged,
			untracked,
			branch,
			ahead,
			behind,
		};
	}

	async getRemotes(): Promise<IGitRemote[]> {
		const result = await this._execGit(['remote', '-v']);
		if (!result.success) {
			return [];
		}

		const remotes = new Map<string, string>();
		for (const line of result.stdout.split('\n')) {
			const match = line.match(/^(\S+)\s+(\S+)\s+\(push\)/);
			if (match) {
				remotes.set(match[1], match[2]);
			}
		}

		return Array.from(remotes.entries()).map(([name, url]) => ({ name, url }));
	}

	async getLog(count: number = 50): Promise<IGitLogEntry[]> {
		// Format: hash | shortHash | message | author | email | date ISO | relativeDate | refs
		const format = '%H|%h|%s|%an|%ae|%aI|%ar|%D';
		const result = await this._execGit(['log', `-${count}`, `--pretty=format:${format}`]);
		if (!result.success || !result.stdout.trim()) {
			return [];
		}

		const entries: IGitLogEntry[] = [];
		for (const line of result.stdout.split('\n')) {
			const parts = line.split('|');
			if (parts.length >= 7) {
				entries.push({
					hash: parts[0],
					shortHash: parts[1],
					message: parts[2],
					author: parts[3],
					email: parts[4],
					date: parts[5],
					relativeDate: parts[6],
					refs: parts[7] ?? '',
				});
			}
		}
		return entries;
	}

	async commitAll(message?: string): Promise<IGitOperationResult> {
		// Stage all changes
		const addResult = await this._execGit(['add', '-A']);
		if (!addResult.success) {
			this._logService.error('[GitCommitService] git add -A failed:', addResult.stderr);
			return addResult;
		}

		// Check if there's anything to commit
		const diffResult = await this._execGit(['diff', '--cached', '--stat']);
		if (diffResult.success && !diffResult.stdout.trim()) {
			return { success: true, stdout: 'Nothing to commit', stderr: '', exitCode: 0 };
		}

		// Generate commit message if not provided
		if (!message) {
			message = await this._generateCommitMessage();
		}

		// Commit
		const commitResult = await this._execGit(['commit', '-m', message]);
		this._logService.info(`[GitCommitService] Commit result: ${commitResult.success ? 'OK' : 'FAIL'}`);
		return commitResult;
	}

	async pushToRemotes(remotes?: string[]): Promise<Map<string, IGitOperationResult>> {
		const results = new Map<string, IGitOperationResult>();

		// Get all remotes if not specified
		if (!remotes || remotes.length === 0) {
			const allRemotes = await this.getRemotes();
			remotes = allRemotes.map(r => r.name);
		}

		if (remotes.length === 0) {
			this._logService.warn('[GitCommitService] No remotes found to push to');
			return results;
		}

		// Push to all remotes in parallel
		const pushPromises = remotes.map(async (remote) => {
			const result = await this._execGit(['push', remote]);
			results.set(remote, result);
			this._logService.info(`[GitCommitService] Push to "${remote}": ${result.success ? 'OK' : 'FAIL'}`);
		});

		await Promise.allSettled(pushPromises);
		return results;
	}

	async commitAndPushAll(message?: string, remotes?: string[]): Promise<ICommitAndPushResult> {
		this._logService.info('[GitCommitService] Starting commitAndPushAll...');

		// Step 1: Commit
		const commitResult = await this.commitAll(message);

		// Step 2: Push to all remotes (even if commit said "nothing to commit", there might be unpushed commits)
		const pushResults = await this.pushToRemotes(remotes);

		// Build summary
		const summary = this._buildSummary(commitResult, pushResults);

		const result: ICommitAndPushResult = {
			commitResult,
			pushResults,
			summary,
		};

		this._onDidCommitAndPush.fire(result);
		return result;
	}

	// ─── Private helpers ─────────────────────────────────────

	private async _generateCommitMessage(): Promise<string> {
		// Get a short summary of changes
		const result = await this._execGit(['diff', '--cached', '--stat', '--no-color']);
		if (!result.success || !result.stdout.trim()) {
			return 'chore: update files';
		}

		const lines = result.stdout.trim().split('\n');
		const summaryLine = lines[lines.length - 1]; // e.g. "3 files changed, 10 insertions(+), 2 deletions(-)"
		const fileCount = lines.length - 1;

		if (fileCount === 1) {
			const fileName = lines[0].split('|')[0].trim();
			return `update ${fileName}`;
		}

		return `update ${fileCount} files\n\n${summaryLine}`;
	}

	private _buildSummary(commitResult: IGitOperationResult, pushResults: Map<string, IGitOperationResult>): string {
		const parts: string[] = [];

		if (commitResult.success) {
			if (commitResult.stdout.includes('Nothing to commit')) {
				parts.push('✓ No new changes to commit');
			} else {
				parts.push('✓ Committed successfully');
			}
		} else {
			parts.push(`✗ Commit failed: ${commitResult.stderr}`);
		}

		for (const [remote, result] of pushResults) {
			if (result.success) {
				parts.push(`✓ Pushed to ${remote}`);
			} else {
				parts.push(`✗ Push to ${remote} failed: ${result.stderr}`);
			}
		}

		return parts.join('\n');
	}

	private async _execGit(args: string[]): Promise<IGitOperationResult> {
		try {
			this._logService.trace(`[GitCommitService] Executing: git ${args.join(' ')} (cwd: ${this._cwd})`);

			// Use the global bridge exposed by the Electron preload script
			// This is available in the sessions Electron renderer
			const sarosisGit = (globalThis as any).__sarosisExecGit;
			if (typeof sarosisGit === 'function') {
				return await sarosisGit(this._cwd, args);
			}

			// Fallback: use Node.js child_process if available in this context
			// (Electron renderer with nodeIntegration or contextBridge)
			if (typeof process !== 'undefined' && (process as any).versions?.electron) {
				return await this._execGitNodeFallback(args);
			}

			// Last resort: report that git execution is not available
			this._logService.error('[GitCommitService] No git execution method available');
			return { success: false, stdout: '', stderr: 'Git execution not available in this context', exitCode: -1 };
		} catch (err) {
			this._logService.error('[GitCommitService] git exec error:', err);
			return { success: false, stdout: '', stderr: String(err), exitCode: -1 };
		}
	}

	private _execGitNodeFallback(args: string[]): Promise<IGitOperationResult> {
		return new Promise((resolve) => {
			try {
				// In Electron renderer, we can require child_process through the node integration
				// eslint-disable-next-line local/code-import-patterns
				const cp = require('child_process') as typeof import('child_process');
				const child = cp.spawn('git', args, {
					cwd: this._cwd,
					env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
					windowsHide: true,
				});

				let stdout = '';
				let stderr = '';

				child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
				child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

				child.on('error', (err) => {
					resolve({ success: false, stdout, stderr: err.message, exitCode: -1 });
				});

				child.on('close', (code) => {
					resolve({ success: code === 0, stdout, stderr, exitCode: code ?? -1 });
				});
			} catch (err) {
				resolve({ success: false, stdout: '', stderr: String(err), exitCode: -1 });
			}
		});
	}
}
