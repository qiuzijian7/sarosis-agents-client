/*---------------------------------------------------------------------------------------------
 *  SkillVersionService — AutoGit per-skill version history.
 *
 *  Every save of SKILL.md snapshots into a local `.git` repo so users get
 *  unlimited undo + version history without having to learn git.
 *
 *  薄壳：仅负责 id→目录解析、类型适配与日志；git 操作委托 `gitVersionCore`。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { SarosPath, resolveSarosPath } from '../common/sarosPaths.js';
import * as path from '../../../../base/common/path.js';
import * as core from './gitVersionCore.js';

// ─── DI Identifier ──────────────────────────────────────────────────────────

export const ISkillVersionService = createDecorator<SkillVersionService>('skillVersionService');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SkillWorkspaceStatus {
	readonly initialized: boolean;
	readonly headSha: string | null;
	readonly headMessage: string | null;
	readonly dirty: boolean;
	readonly branch: string | null;
}

export interface SkillCommitMeta {
	readonly sha: string;
	readonly shortSha: string;
	readonly message: string;
	readonly author: string;
	readonly time: number;       // unix timestamp
}

export interface SkillDiffResult {
	readonly fromSha: string;
	readonly toSha: string;
	readonly unified: string;    // unified diff text
}

// ─── 常量 ───────────────────────────────────────────────────────────────────

const TRACKED_FILE = 'SKILL.md';
const AUTHOR: core.GitAuthor = { name: 'Saros', email: 'vssaros@local' };
const GITIGNORE: readonly string[] = [
	'# Saros Skill AutoGit',
	'.DS_Store', 'Thumbs.db', '*.tmp', '*~',
];

// ─── Service ────────────────────────────────────────────────────────────────

export class SkillVersionService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly log: ILogService,
		@INativeEnvironmentService private readonly envService: INativeEnvironmentService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		// git 实现宿主在主进程（renderer 沙箱无 fs/isomorphic-git）；绑定幂等
		core.initGitVersionBackend(mainProcessService);
	}

	/** Check if git backend (主进程 isomorphic-git) is available. */
	isAvailable(): boolean {
		return core.isGitAvailable(this.log);
	}

	/** Resolve the skill root directory. */
	async getSkillRoot(skillId: string): Promise<URI> {
		const skillsDir = resolveSarosPath(URI.file(this.envService.userDataPath), SarosPath.skills);
		return URI.file(path.join(skillsDir.fsPath, skillId));
	}

	/** Read-only status check for a skill repo. */
	async status(skillId: string): Promise<SkillWorkspaceStatus> {
		const dir = (await this.getSkillRoot(skillId)).fsPath;
		return core.gitRepoStatus(dir);
	}

	/** `git init` + write .gitignore + initial commit. */
	async init(skillId: string): Promise<void> {
		if (!core.isGitAvailable()) { throw new Error('isomorphic-git not available'); }
		const dir = (await this.getSkillRoot(skillId)).fsPath;
		await core.gitInitRepo(dir, {
			gitignore: GITIGNORE,
			initMessage: 'init: skill snapshot',
			author: AUTHOR,
			addPath: '.',
			commitWhen: 'always',
		});
		this.log.info(`[SkillVersion] git init: ${skillId}`);
	}

	/**
	 * Stage all changes + commit. Returns new SHA, or null if nothing changed.
	 * @param message Optional commit message (default: auto timestamp)
	 */
	async autoCommit(skillId: string, message?: string): Promise<string | null> {
		if (!core.isGitAvailable()) { return null; }
		const dir = (await this.getSkillRoot(skillId)).fsPath;
		try {
			const sha = await core.gitCommitChanges(dir, {
				ensureInit: () => this.init(skillId),
				addPaths: ['.'],
				author: AUTHOR,
				message,
			});
			if (sha) { this.log.info(`[SkillVersion] autoCommit ${skillId}: ${sha.substring(0, 7)}`); }
			return sha;
		} catch (e) {
			this.log.warn(`[SkillVersion] autoCommit failed for ${skillId}`, e);
			return null;
		}
	}

	/** Get commit history for the skill (all files). */
	async history(skillId: string, limit: number = 50): Promise<SkillCommitMeta[]> {
		if (!core.isGitAvailable()) { return []; }
		const dir = (await this.getSkillRoot(skillId)).fsPath;
		try {
			const commits = await core.gitLogCommits(dir, { limit });
			return commits.map(c => ({
				sha: c.sha,
				shortSha: c.shortSha,
				message: c.message.split('\n')[0] ?? '',
				author: c.author,
				time: c.time,
			}));
		} catch {
			return [];
		}
	}

	/** Read SKILL.md content at a specific commit. */
	async readVersion(skillId: string, sha: string): Promise<string | null> {
		if (!core.isGitAvailable()) { return null; }
		const dir = (await this.getSkillRoot(skillId)).fsPath;
		try {
			return await core.gitReadFileAtCommit(dir, TRACKED_FILE, sha);
		} catch {
			return null;
		}
	}

	/** Get unified diff between two commits (null = HEAD for toSha). */
	async diff(skillId: string, fromSha: string, toSha?: string): Promise<SkillDiffResult | null> {
		if (!core.isGitAvailable()) { return null; }
		const dir = (await this.getSkillRoot(skillId)).fsPath;
		try {
			return await core.gitRangeDiff(dir, TRACKED_FILE, core.joinRepoPath(dir, TRACKED_FILE), fromSha, toSha);
		} catch (e) {
			this.log.warn(`[SkillVersion] diff failed for ${skillId}`, e);
			return null;
		}
	}

	/**
	 * Rollback the working directory to a specific commit.
	 * Does NOT auto-commit after rollback (user can review and save).
	 */
	async rollback(skillId: string, sha: string): Promise<void> {
		if (!core.isGitAvailable()) { throw new Error('isomorphic-git not available'); }
		const dir = (await this.getSkillRoot(skillId)).fsPath;

		const exists = await core.gitReadFileAtCommit(dir, TRACKED_FILE, sha).then(() => true, () => false);
		if (!exists) { throw new Error(`Version ${sha.substring(0, 7)} not found`); }

		// 写回由主进程完成（renderer 沙箱无 fs）
		await core.gitRollback(dir, TRACKED_FILE, sha, core.joinRepoPath(dir, TRACKED_FILE));
		this.log.info(`[SkillVersion] rollback ${skillId} to ${sha.substring(0, 7)}`);
	}

	/**
	 * Create a lightweight tag (typically vX.Y.Z after publishing to marketplace).
	 */
	async tag(skillId: string, tagName: string): Promise<void> {
		if (!core.isGitAvailable()) { return; }
		const dir = (await this.getSkillRoot(skillId)).fsPath;
		try {
			await core.gitCreateTag(dir, tagName);
			this.log.info(`[SkillVersion] tagged ${skillId}: ${tagName}`);
		} catch (e) {
			this.log.warn(`[SkillVersion] tag failed for ${skillId}`, e);
		}
	}
}
