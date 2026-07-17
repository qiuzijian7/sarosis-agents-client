/*---------------------------------------------------------------------------------------------
 *  KbVersionService — AutoGit per-note version history (SoloMD v2.2 port).
 *
 *  Every save snapshots the vault into a local `.git` repo so users get
 *  unlimited undo + per-file history without having to learn git.
 *
 *  Uses `isomorphic-git` (pure JS, no native deps) loaded via `nodeRequire`
 *  in the desktop Electron renderer. The `fs` module is also loaded via
 *  `nodeRequire` and passed to isomorphic-git as the `fs` parameter.
 *
 *  The `.git` repo lives at the vault root (`~/.saros/knowledge-base/<vaultId>/`),
 *  covering all `.md` files in that vault.
 *
 *  Ported from SoloMD `git_history.rs` (Rust + libgit2).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioLogService } from './agentStudioLogService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type {
	KbWorkspaceStatus,
	KbCommitMeta,
	KbDiffResult,
	KbDiffHunk,
	KbDiffLine,
} from './kbVersionTypes.js';

// ─── DI Service Identifier ──────────────────────────────────────────────────

export const IKbVersionService = createDecorator<KbVersionService>('kbVersionService');

// ─── nodeRequire (safe access to Node.js require in Electron renderer) ──────

function nodeRequire(moduleName: string): any {
	if (typeof globalThis !== 'undefined' && typeof (globalThis as any).require === 'function') {
		try { return (globalThis as any).require(moduleName); } catch { return undefined; }
	}
	return undefined;
}

// Lazily-loaded modules
let _git: any | undefined;
let _fs: any | undefined;
let _diff: any | undefined;

function getGit(): any {
	if (_git === undefined) {
		_git = nodeRequire('isomorphic-git') ?? null;
	}
	return _git;
}

function getFs(): any {
	if (_fs === undefined) {
		_fs = nodeRequire('fs') ?? null;
	}
	return _fs;
}

function getDiff(): any {
	if (_diff === undefined) {
		_diff = nodeRequire('diff') ?? null;
	}
	return _diff;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert a URI to a local filesystem path string. */
function toFsPath(uri: URI): string {
	return uri.fsPath;
}

/**
 * Convert an absolute file path to a forward-slash repo-relative path.
 * Returns `null` if the file is outside the vault root.
 */
function toRelPath(vaultRootPath: string, filePath: string): string | null {
	const root = vaultRootPath.replace(/\\/g, '/').replace(/\/$/, '');
	const abs = filePath.replace(/\\/g, '/');
	if (!abs.startsWith(root + '/')) return null;
	return abs.substring(root.length + 1);
}

/** Default auto-commit message: `auto: 2026-07-11 19:24:05` (UTC). */
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

/**
 * Resolve the vault root from a KB note's resource URI.
 *
 * KB notes are stored at `~/.saros/knowledge-base/<vaultId>/笔记/xxx.md`.
 * The vault root is the `<vaultId>` directory — two levels up from the file
 * (file → `笔记/` → `<vaultId>/`). We also handle subdirectories within `笔记/`.
 *
 * Strategy:
 * 1. Walk up from the file looking for a `.git` directory (already initialized).
 * 2. If not found, walk up looking for the `knowledge-base` segment and take
 *    the next path component as the vault root.
 */
function resolveVaultRoot(fileUri: URI, fsModule: any): URI | null {
	const parts = fileUri.fsPath.replace(/\\/g, '/').split('/');
	const kbIdx = parts.findIndex(p => p === 'knowledge-base');
	if (kbIdx === -1 || kbIdx + 1 >= parts.length) return null;
	// Vault root = knowledge-base/<vaultId>/
	const vaultParts = parts.slice(0, kbIdx + 2);
	return URI.file(vaultParts.join('/'));
}

/** Write a default .gitignore into the vault root (idempotent). */
function writeDefaultGitignore(vaultRootPath: string, fsModule: any): void {
	const gi = `${vaultRootPath}/.gitignore`;
	try {
		if (fsModule.existsSync(gi)) return;
	} catch {
		// Ignore stat errors — we'll try to write anyway.
	}
	const body = [
		'# Sarosis KB AutoGit defaults',
		'.DS_Store',
		'Thumbs.db',
		'desktop.ini',
		'*.tmp',
		'*~',
		'.vscode/',
		'# KB metadata caches',
		'.ftindex.json',
		'.kbkernel.json',
		'# Attachments (managed separately)',
		'*.attachments/',
	].join('\n') + '\n';
	try {
		fsModule.writeFileSync(gi, body, 'utf8');
	} catch {
		// Non-fatal — the repo still works without .gitignore.
	}
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class KbVersionService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IAgentStudioLogService private readonly _log: ILogService,
	) { }

	/** Check if isomorphic-git is available (desktop Electron renderer only). */
	isAvailable(): boolean {
		return getGit() != null && getFs() != null;
	}

	/** Resolve the vault root from a KB note URI. */
	resolveVaultRoot(fileUri: URI): URI | null {
		const fsModule = getFs();
		if (!fsModule) return null;
		return resolveVaultRoot(fileUri, fsModule);
	}

	/** Read-only workspace status check. */
	async status(vaultRoot: URI): Promise<KbWorkspaceStatus> {
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) {
			return { initialized: false, headSha: null, headMessage: null, dirty: false, branch: null };
		}
		const dir = toFsPath(vaultRoot);
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
			} catch { /* empty repo */ }

			// Check dirty status — restrict to .md/.txt files
			let dirty = false;
			try {
				const matrix = await git.statusMatrix({ fs: fsModule, dir });
				for (const row of matrix) {
					const filepath = row[0] as string;
					if (filepath.endsWith('.md') || filepath.endsWith('.markdown') || filepath.endsWith('.txt')) {
						// row: [filepath, HEAD, WORKDIR, STAGE]
						// HEAD=0 means untracked, WORKDIR!=HEAD means modified
						if (row[1] !== row[2] || row[2] !== row[3]) {
							dirty = true;
							break;
						}
					}
				}
			} catch { /* ignore */ }

			return { initialized: true, headSha, headMessage, dirty, branch: 'main' };
		} catch (e) {
			this._log.warn('[KbVersionService] status failed', e);
			return { initialized: false, headSha: null, headMessage: null, dirty: false, branch: null };
		}
	}

	/** `git init` + initial commit + default .gitignore. */
	async init(vaultRoot: URI): Promise<void> {
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) throw new Error('isomorphic-git not available');

		const dir = toFsPath(vaultRoot);
		writeDefaultGitignore(dir, fsModule);

		await git.init({ fs: fsModule, dir, defaultBranch: 'main' });
		// Stage all .md files
		await git.add({ fs: fsModule, dir, filepath: '.' });
		// Initial commit (may be empty)
		try {
			await git.commit({
				fs: fsModule, dir,
				message: 'init: Sarosis KB vault',
				author: { name: 'Sarosis', email: 'vssaros@local' },
			});
		} catch {
			// Empty repo — no files to commit yet, that's OK.
		}
		this._log.info('[KbVersionService] git init completed', dir);
	}

	/**
	 * Stage + commit. Returns the new SHA, or `null` if nothing changed
	 * (tree OID matches HEAD).
	 */
	async autoCommit(vaultRoot: URI, docPath?: URI): Promise<string | null> {
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) return null;

		const dir = toFsPath(vaultRoot);
		try {
			// Ensure repo is initialized
			let needInit = false;
			try {
				await git.log({ fs: fsModule, dir, depth: 1 });
			} catch {
				needInit = true;
			}
			if (needInit) {
				await this.init(vaultRoot);
			}

			// Stage the specific file (or all changes if no docPath)
			if (docPath) {
				const rel = toRelPath(dir, toFsPath(docPath));
				if (rel) {
					try {
						await git.add({ fs: fsModule, dir, filepath: rel });
					} catch (e) {
						// File might not exist (deleted) — try remove
						try { await git.remove({ fs: fsModule, dir, filepath: rel }); } catch { /* ignore */ }
					}
				}
			} else {
				await git.add({ fs: fsModule, dir, filepath: '.' });
			}

			// Check if there's anything to commit by comparing tree OID
			let headOid: string | null = null;
			try {
				const head = await git.resolveRef({ fs: fsModule, dir, ref: 'HEAD' });
				headOid = head;
			} catch { /* unborn HEAD */ }

			// Build the new tree from the index
			const oid = await git.writeTree({ fs: fsModule, dir });
			if (headOid) {
				const headCommit = await git.readCommit({ fs: fsModule, dir, oid: headOid });
				if (headCommit.commit.tree === oid) {
					return null; // No changes — skip commit
				}
			}

			const sha = await git.commit({
				fs: fsModule, dir,
				message: defaultAutoMessage(),
				author: { name: 'Sarosis', email: 'vssaros@local' },
			});
			this._log.info('[KbVersionService] autoCommit', sha.substring(0, 7));
			return sha;
		} catch (e) {
			this._log.warn('[KbVersionService] autoCommit failed', e);
			return null;
		}
	}

	/** Get commit history filtered by a single file path. */
	async fileHistory(vaultRoot: URI, docPath: URI, limit: number = 50): Promise<KbCommitMeta[]> {
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) return [];

		const dir = toFsPath(vaultRoot);
		const rel = toRelPath(dir, toFsPath(docPath));
		if (!rel) return [];

		try {
			// isomorphic-git log with filepath filter
			const commits = await git.log({
				fs: fsModule, dir,
				ref: 'HEAD',
				filepath: rel,
				limit,
			});
			return commits.map((c: any) => ({
				sha: c.oid,
				shortSha: c.oid.substring(0, 7),
				message: c.commit?.message?.split('\n')[0] ?? '',
				author: c.commit?.author?.name ?? '?',
				time: c.commit?.author?.timestamp ?? 0,
			}));
		} catch (e) {
			this._log.warn('[KbVersionService] fileHistory failed', e);
			return [];
		}
	}

	/** Get unified diff for a single file at a specific commit. */
	async fileDiff(vaultRoot: URI, docPath: URI, sha: string): Promise<KbDiffResult | null> {
		const git = getGit();
		const fsModule = getFs();
		const diffLib = getDiff();
		if (!git || !fsModule) return null;

		const dir = toFsPath(vaultRoot);
		const rel = toRelPath(dir, toFsPath(docPath));
		if (!rel) return null;

		try {
			// Read the file content at the target commit
			let newContent = '';
			try {
				const blob = await git.readBlob({ fs: fsModule, dir, oid: sha, filepath: rel });
				newContent = new TextDecoder().decode(blob.blob);
			} catch {
				// File didn't exist at this commit — diff from empty
				newContent = '';
			}

			// Read the file content at the parent commit
			let oldContent = '';
			let fromSha: string | null = null;
			try {
				const commit = await git.readCommit({ fs: fsModule, dir, oid: sha });
				if (commit.commit.parent.length > 0) {
					fromSha = commit.commit.parent[0];
					try {
						const parentBlob = await git.readBlob({ fs: fsModule, dir, oid: fromSha, filepath: rel });
						oldContent = new TextDecoder().decode(parentBlob.blob);
					} catch {
						// File didn't exist at parent — diff from empty
					}
				}
			} catch { /* root commit */ }

			// Generate unified diff using the `diff` library
			if (!diffLib) {
				// Fallback: simple line-by-line comparison
				return this._simpleDiff(fromSha, sha, oldContent, newContent);
			}

			const filename = rel.split('/').pop() || 'file';
			const patch = diffLib.createPatch(filename, oldContent, newContent, fromSha ?? 'empty', sha, { context: 3 });
			const hunks = this._parseUnifiedDiff(patch);

			return { fromSha, toSha: sha, hunks, unified: patch };
		} catch (e) {
			this._log.warn('[KbVersionService] fileDiff failed', e);
			return null;
		}
	}

	/** Get file content at a specific commit version. */
	async fileAtVersion(vaultRoot: URI, docPath: URI, sha: string): Promise<string> {
		const git = getGit();
		const fsModule = getFs();
		if (!git || !fsModule) throw new Error('isomorphic-git not available');

		const dir = toFsPath(vaultRoot);
		const rel = toRelPath(dir, toFsPath(docPath));
		if (!rel) throw new Error('file outside vault');

		const blob = await git.readBlob({ fs: fsModule, dir, oid: sha, filepath: rel });
		return new TextDecoder().decode(blob.blob);
	}

	/**
	 * Rollback (overwrite) the working copy with the file content at the
	 * specified commit. Does NOT auto-commit — the next save's AutoGit will
	 * capture the rollback as a new version.
	 */
	async rollbackFile(vaultRoot: URI, docPath: URI, sha: string): Promise<string> {
		const content = await this.fileAtVersion(vaultRoot, docPath, sha);
		const fsModule = getFs();
		if (!fsModule) throw new Error('fs not available');
		fsModule.writeFileSync(toFsPath(docPath), content, 'utf8');
		this._log.info('[KbVersionService] rollbackFile', sha.substring(0, 7));
		return content;
	}

	// ─── Private diff helpers ──────────────────────────────────────────────

	/** Parse a unified diff patch string into structured hunks. */
	private _parseUnifiedDiff(patch: string): KbDiffHunk[] {
		const lines = patch.split('\n');
		const hunks: KbDiffHunk[] = [];
		let currentHunk: KbDiffHunk | null = null;

		for (const line of lines) {
			// Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
			const hunkMatch = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
			if (hunkMatch) {
				if (currentHunk) hunks.push(currentHunk);
				currentHunk = {
					oldStart: parseInt(hunkMatch[1], 10),
					oldLines: parseInt(hunkMatch[2], 10),
					newStart: parseInt(hunkMatch[3], 10),
					newLines: parseInt(hunkMatch[4], 10),
					lines: [],
				};
				continue;
			}
			if (!currentHunk) continue;
			if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('\\ ')) continue;

			if (line.startsWith('+')) {
				currentHunk.lines.push({ kind: 'add', text: line.substring(1) });
			} else if (line.startsWith('-')) {
				currentHunk.lines.push({ kind: 'remove', text: line.substring(1) });
			} else if (line.startsWith(' ')) {
				currentHunk.lines.push({ kind: 'context', text: line.substring(1) });
			}
		}
		if (currentHunk) hunks.push(currentHunk);
		return hunks;
	}

	/** Fallback simple diff when `diff` library is not available. */
	private _simpleDiff(fromSha: string | null, toSha: string, oldContent: string, newContent: string): KbDiffResult {
		const oldLines = oldContent.split('\n');
		const newLines = newContent.split('\n');
		const lines: KbDiffLine[] = [];
		const maxLen = Math.max(oldLines.length, newLines.length);
		for (let i = 0; i < maxLen; i++) {
			if (i < oldLines.length && i < newLines.length) {
				if (oldLines[i] === newLines[i]) {
					lines.push({ kind: 'context', text: oldLines[i] });
				} else {
					lines.push({ kind: 'remove', text: oldLines[i] });
					lines.push({ kind: 'add', text: newLines[i] });
				}
			} else if (i < oldLines.length) {
				lines.push({ kind: 'remove', text: oldLines[i] });
			} else if (i < newLines.length) {
				lines.push({ kind: 'add', text: newLines[i] });
			}
		}
		const hunk: KbDiffHunk = {
			oldStart: 1, oldLines: oldLines.length,
			newStart: 1, newLines: newLines.length,
			lines,
		};
		const unified = lines.map(l => (l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' ') + l.text).join('\n');
		return { fromSha, toSha, hunks: [hunk], unified };
	}
}
