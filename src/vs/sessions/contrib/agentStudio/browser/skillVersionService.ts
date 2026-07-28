/*---------------------------------------------------------------------------------------------
 *  SkillVersionService — AutoGit per-skill version history.
 *
 *  Every save of SKILL.md snapshots into a local `.git` repo so users get
 *  unlimited undo + version history without having to learn git.
 *
 *  Uses `isomorphic-git` (pure JS, no native deps) loaded via `nodeRequire`
 *  in the desktop Electron renderer.
 *
 *  The `.git` repo lives at the skill root (`~/.vssaros/skills/{skillId}/`),
 *  tracking SKILL.md and all support files in that directory.
 *
 *  Pattern: mirrors KbVersionService but adapted for single-skill repos.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { SarosPath, resolveSarosPath } from '../common/sarosPaths.js';
import * as path from '../../../../base/common/path.js';

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

// ─── nodeRequire ────────────────────────────────────────────────────────────

function nodeRequire(moduleName: string): any {
	if (typeof globalThis !== 'undefined' && typeof (globalThis as any).require === 'function') {
		try { return (globalThis as any).require(moduleName); } catch { return undefined; }
	}
	return undefined;
}

let _git: any | undefined;
let _fs: any | undefined;
let _diff: any | undefined;

function getGit(): any {
	if (_git === undefined) { _git = nodeRequire('isomorphic-git') ?? null; }
	return _git;
}
function getFs(): any {
	if (_fs === undefined) { _fs = nodeRequire('fs') ?? null; }
	return _fs;
}
function getDiff(): any {
	if (_diff === undefined) { _diff = nodeRequire('diff') ?? null; }
	return _diff;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function defaultAutoMessage(): string {
	const now = new Date();
	const y = now.getUTCFullYear();
	const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
	const d = String(now.getUTCDate()).padStart(2, '0');
	const h = String(now.getUTCHours()).padStart(2, '0');
	const mi = String(now.getUTCMinutes()).padStart(2, '0');
	const s = String(now.getUTCSeconds()).padStart(2, '0');
	return `auto: ${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function toFsPath(uri: URI): string {
	return uri.fsPath;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class SkillVersionService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly log: ILogService,
		@INativeEnvironmentService private readonly envService: INativeEnvironmentService,
	) { }

	/** Check if isomorphic-git is available (desktop Electron renderer only). */
	isAvailable(): boolean {
		return getGit() != null && getFs() != null;
	}

	/** Resolve the skill root directory. */
	async getSkillRoot(skillId: string): Promise<URI> {
		const skillsDir = resolveSarosPath(URI.file(this.envService.userDataPath), SarosPath.skills);
		return URI.file(path.join(skillsDir.fsPath, skillId));
	}

	/** Read-only status check for a skill repo. */
	async status(skillId: string): Promise<SkillWorkspaceStatus> {
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) {
			return { initialized: false, headSha: null, headMessage: null, dirty: false, branch: null };
		}

		const dir = toFsPath(await this.getSkillRoot(skillId));
		try {
			// Check if .git exists
			try {
				await git.log({ fs: fsModule, dir, depth: 1 });
			} catch {
				return { initialized: false, headSha: null, headMessage: null, dirty: false, branch: null };
			}

			let headSha: string | null = null;
			let headMessage: string | null = null;
			try {
				const commits = await git.log({ fs: fsModule, dir, depth: 1 });
				if (commits.length > 0) {
					headSha = commits[0].oid;
					headMessage = commits[0].commit?.message?.split('\n')[0] ?? null;
				}
			} catch { /* empty */ }

			let dirty = false;
			try {
				const matrix = await git.statusMatrix({ fs: fsModule, dir });
				for (const row of matrix) {
					if (row[1] !== row[2] || row[2] !== row[3]) {
						dirty = true;
						break;
					}
				}
			} catch { /* ignore */ }

			return { initialized: true, headSha, headMessage, dirty, branch: 'main' };
		} catch {
			return { initialized: false, headSha: null, headMessage: null, dirty: false, branch: null };
		}
	}

	/** `git init` + write .gitignore + initial commit. */
	async init(skillId: string): Promise<void> {
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) { throw new Error('isomorphic-git not available'); }

		const dir = toFsPath(await this.getSkillRoot(skillId));

		// Skip excluded dirs
		const gi = `${dir}/.gitignore`;
		if (!fsModule.existsSync(gi)) {
			fsModule.writeFileSync(gi, [
				'# Sarosis Skill AutoGit',
				'.DS_Store', 'Thumbs.db', '*.tmp', '*~',
			].join('\n') + '\n', 'utf8');
		}

		await git.init({ fs: fsModule, dir, defaultBranch: 'main' });
		await git.add({ fs: fsModule, dir, filepath: '.' });
		try {
			await git.commit({
				fs: fsModule, dir,
				message: 'init: skill snapshot',
				author: { name: 'Sarosis', email: 'vssaros@local' },
			});
		} catch { /* empty repo — OK */ }
		this.log.info(`[SkillVersion] git init: ${skillId}`);
	}

	/**
	 * Stage all changes + commit. Returns new SHA, or null if nothing changed.
	 * @param message Optional commit message (default: auto timestamp)
	 */
	async autoCommit(skillId: string, message?: string): Promise<string | null> {
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) { return null; }

		const dir = toFsPath(await this.getSkillRoot(skillId));

		try {
			// Auto-init if not yet initialized
			let needInit = false;
			try { await git.log({ fs: fsModule, dir, depth: 1 }); } catch { needInit = true; }
			if (needInit) { await this.init(skillId); }
		} catch {
			return null;
		}

		try {
			await git.add({ fs: fsModule, dir, filepath: '.' });

			// Check if tree changed
			let headOid: string | null = null;
			try {
				headOid = await git.resolveRef({ fs: fsModule, dir, ref: 'HEAD' });
			} catch { /* unborn */ }

			const oid = await git.writeTree({ fs: fsModule, dir });
			if (headOid) {
				const headCommit = await git.readCommit({ fs: fsModule, dir, oid: headOid });
				if (headCommit.commit.tree === oid) {
					return null; // No changes
				}
			}

			const sha = await git.commit({
				fs: fsModule, dir,
				message: message || defaultAutoMessage(),
				author: { name: 'Sarosis', email: 'vssaros@local' },
			});
			this.log.info(`[SkillVersion] autoCommit ${skillId}: ${sha.substring(0, 7)}`);
			return sha;
		} catch (e) {
			this.log.warn(`[SkillVersion] autoCommit failed for ${skillId}`, e);
			return null;
		}
	}

	/** Get commit history for the skill (all files). */
	async history(skillId: string, limit: number = 50): Promise<SkillCommitMeta[]> {
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) { return []; }

		const dir = toFsPath(await this.getSkillRoot(skillId));
		try {
			const commits = await git.log({ fs: fsModule, dir, ref: 'HEAD', depth: limit });
			return commits.map((c: any) => ({
				sha: c.oid,
				shortSha: c.oid.substring(0, 7),
				message: c.commit?.message?.split('\n')[0] ?? '',
				author: c.commit?.author?.name ?? '?',
				time: c.commit?.author?.timestamp ?? 0,
			}));
		} catch {
			return [];
		}
	}

	/** Read SKILL.md content at a specific commit. */
	async readVersion(skillId: string, sha: string): Promise<string | null> {
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) { return null; }

		const dir = toFsPath(await this.getSkillRoot(skillId));
		try {
			const { blob } = await git.readBlob({
				fs: fsModule, dir, oid: sha,
				filepath: 'SKILL.md',
			});
			return Buffer.from(blob).toString('utf8');
		} catch {
			return null;
		}
	}

	/** Get unified diff between two commits (null = HEAD for toSha). */
	async diff(skillId: string, fromSha: string, toSha?: string): Promise<SkillDiffResult | null> {
		const git = getGit();
		const fsModule = getFs();
		const diffLib = getDiff();
		if (!git || !fsModule) { return null; }

		const dir = toFsPath(await this.getSkillRoot(skillId));

		try {
			const resolveRef = async (ref: string) => {
				if (ref === 'HEAD') {
					return await git.resolveRef({ fs: fsModule, dir, ref: 'HEAD' });
				}
				return ref;
			};
			const targetSha = toSha ? await resolveRef(toSha) : null;

			const fromText = await this.readVersion(skillId, fromSha) ?? '';
			const targetObj = targetSha
				? await git.readBlob({ fs: fsModule, dir, oid: targetSha, filepath: 'SKILL.md' })
				: null;
			const toText = targetObj
				? Buffer.from(targetObj.blob).toString('utf8')
				: (fsModule.readFileSync(`${dir}/SKILL.md`, 'utf8') as string);

			let unified = '';
			if (diffLib) {
				const patch = diffLib.createTwoFilesPatch(
					`a/SKILL.md`, `b/SKILL.md`,
					fromText, toText,
					`v${fromSha.substring(0, 7)}`, targetSha ? `v${targetSha.substring(0, 7)}` : 'WORKING',
				);
				unified = patch;
			} else {
				unified = `--- a/SKILL.md\n+++ b/SKILL.md\n@@ ... @@\n${fromText}\n---\n${toText}`;
			}

			return { fromSha, toSha: targetSha ?? 'WORKING', unified };
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
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) { throw new Error('isomorphic-git not available'); }

		const dir = toFsPath(await this.getSkillRoot(skillId));

		// Read SKILL.md at target version
		const content = await this.readVersion(skillId, sha);
		if (content === null) { throw new Error(`Version ${sha.substring(0, 7)} not found`); }

		// Write to disk
		fsModule.writeFileSync(`${dir}/SKILL.md`, content, 'utf8');
		this.log.info(`[SkillVersion] rollback ${skillId} to ${sha.substring(0, 7)}`);
	}

	/**
	 * Create a lightweight tag (typically vX.Y.Z after publishing to marketplace).
	 */
	async tag(skillId: string, tagName: string): Promise<void> {
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) { return; }

		const dir = toFsPath(await this.getSkillRoot(skillId));
		try {
			await git.tag({ fs: fsModule, dir, ref: tagName, message: `Release ${tagName}` });
			this.log.info(`[SkillVersion] tagged ${skillId}: ${tagName}`);
		} catch (e) {
			this.log.warn(`[SkillVersion] tag failed for ${skillId}`, e);
		}
	}
}
