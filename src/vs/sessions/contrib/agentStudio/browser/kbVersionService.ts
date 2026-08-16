/*---------------------------------------------------------------------------------------------
 *  KbVersionService — AutoGit per-note version history (SoloMD v2.2 port).
 *
 *  Every save snapshots the vault into a local `.git` repo so users get
 *  unlimited undo + per-file history without having to learn git.
 *
 *  薄壳：仅负责 vault 解析、相对路径计算、类型适配与日志；git 操作委托 `gitVersionCore`。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioLogService } from './agentStudioLogService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import type {
	KbWorkspaceStatus,
	KbCommitMeta,
	KbDiffResult,
} from './kbVersionTypes.js';
import * as core from './gitVersionCore.js';

// ─── DI Service Identifier ──────────────────────────────────────────────────

export const IKbVersionService = createDecorator<KbVersionService>('kbVersionService');

// ─── 常量 ───────────────────────────────────────────────────────────────────

const AUTHOR: core.GitAuthor = { name: 'Saros', email: 'vssaros@local' };
const GITIGNORE: readonly string[] = [
	'# Saros KB AutoGit defaults',
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
];

/** status 的 dirty 检测仅关注文本类文件（扩展名列表需跨 IPC，故用数据而非回调） */
const TEXT_FILE_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt'];

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

/**
 * Resolve the vault root from a KB note's resource URI.
 *
 * KB notes are stored at `~/.vssaros/knowledge-base/<vaultId>/笔记/xxx.md`.
 * The vault root is the `<vaultId>` directory — two levels up from the file.
 */
function resolveVaultRoot(fileUri: URI): URI | null {
	const parts = fileUri.fsPath.replace(/\\/g, '/').split('/');
	const kbIdx = parts.findIndex(p => p === 'knowledge-base');
	if (kbIdx === -1 || kbIdx + 1 >= parts.length) return null;
	// Vault root = knowledge-base/<vaultId>/
	const vaultParts = parts.slice(0, kbIdx + 2);
	return URI.file(vaultParts.join('/'));
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class KbVersionService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IAgentStudioLogService private readonly _log: ILogService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		// git 实现宿主在主进程（renderer 沙箱无 fs/isomorphic-git）；绑定幂等
		core.initGitVersionBackend(mainProcessService);
	}

	/** Check if git backend (主进程 isomorphic-git) is available. */
	isAvailable(): boolean {
		return core.isGitAvailable(this._log);
	}

	/** Resolve the vault root from a KB note URI. */
	resolveVaultRoot(fileUri: URI): URI | null {
		if (!core.isGitAvailable()) { return null; }
		return resolveVaultRoot(fileUri);
	}

	/** Read-only workspace status check. */
	async status(vaultRoot: URI): Promise<KbWorkspaceStatus> {
		return core.gitRepoStatus(toFsPath(vaultRoot), { dirtyFileExtensions: TEXT_FILE_EXTENSIONS });
	}

	/** `git init` + initial commit + default .gitignore. */
	async init(vaultRoot: URI): Promise<void> {
		if (!core.isGitAvailable()) { throw new Error('isomorphic-git not available'); }
		const dir = toFsPath(vaultRoot);
		await core.gitInitRepo(dir, {
			gitignore: GITIGNORE,
			initMessage: 'init: Saros KB vault',
			author: AUTHOR,
			addPath: '.',
			commitWhen: 'always',
		});
		this._log.info('[KbVersionService] git init completed', dir);
	}

	/**
	 * Stage + commit. Returns the new SHA, or `null` if nothing changed
	 * (tree OID matches HEAD).
	 */
	async autoCommit(vaultRoot: URI, docPath?: URI): Promise<string | null> {
		if (!core.isGitAvailable()) { return null; }
		const dir = toFsPath(vaultRoot);
		try {
			const addPaths = docPath
				? (toRelPath(dir, toFsPath(docPath)) ? [toRelPath(dir, toFsPath(docPath))!] : [])
				: ['.'];
			const sha = await core.gitCommitChanges(dir, {
				ensureInit: () => this.init(vaultRoot),
				addPaths,
				author: AUTHOR,
			});
			if (sha) { this._log.info('[KbVersionService] autoCommit', sha.substring(0, 7)); }
			return sha;
		} catch (e) {
			this._log.warn('[KbVersionService] autoCommit failed', e);
			return null;
		}
	}

	/** Get commit history filtered by a single file path. */
	async fileHistory(vaultRoot: URI, docPath: URI, limit: number = 50): Promise<KbCommitMeta[]> {
		if (!core.isGitAvailable()) { return []; }
		const dir = toFsPath(vaultRoot);
		const rel = toRelPath(dir, toFsPath(docPath));
		if (!rel) { return []; }
		try {
			const commits = await core.gitLogCommits(dir, { filepath: rel, limit });
			return commits.map(c => ({
				sha: c.sha,
				shortSha: c.shortSha,
				message: c.message.split('\n')[0] ?? '',
				author: c.author,
				time: c.time,
			}));
		} catch (e) {
			this._log.warn('[KbVersionService] fileHistory failed', e);
			return [];
		}
	}

	/** Get unified diff for a single file at a specific commit. */
	async fileDiff(vaultRoot: URI, docPath: URI, sha: string): Promise<KbDiffResult | null> {
		if (!core.isGitAvailable()) { return null; }
		const dir = toFsPath(vaultRoot);
		const rel = toRelPath(dir, toFsPath(docPath));
		if (!rel) { return null; }
		try {
			return await core.gitFileDiffAtCommit(dir, rel, sha);
		} catch (e) {
			this._log.warn('[KbVersionService] fileDiff failed', e);
			return null;
		}
	}

	/** Get file content at a specific commit version. */
	async fileAtVersion(vaultRoot: URI, docPath: URI, sha: string): Promise<string> {
		if (!core.isGitAvailable()) { throw new Error('isomorphic-git not available'); }
		const dir = toFsPath(vaultRoot);
		const rel = toRelPath(dir, toFsPath(docPath));
		if (!rel) { throw new Error('file outside vault'); }
		return core.gitReadFileAtCommit(dir, rel, sha);
	}

	/**
	 * Rollback (overwrite) the working copy with the file content at the
	 * specified commit. Does NOT auto-commit — the next save's AutoGit will
	 * capture the rollback as a new version.
	 */
	async rollbackFile(vaultRoot: URI, docPath: URI, sha: string): Promise<string> {
		if (!core.isGitAvailable()) { throw new Error('isomorphic-git not available'); }
		const dir = toFsPath(vaultRoot);
		const rel = toRelPath(dir, toFsPath(docPath));
		if (!rel) { throw new Error('file outside vault'); }
		// 写回由主进程完成（renderer 沙箱无 fs）
		const content = await core.gitRollback(dir, rel, sha, toFsPath(docPath));
		this._log.info('[KbVersionService] rollbackFile', sha.substring(0, 7));
		return content;
	}
}
