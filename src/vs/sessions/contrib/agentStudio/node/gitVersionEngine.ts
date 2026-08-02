/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Git 版本管理引擎（主进程实现）。
 *
 * 各资源（agent / skill / workflow / kb）版本管理的实际 git 操作全部在此执行。
 * 之所以宿主在主进程：workbench renderer 以 Chromium 沙箱运行，既无 Node `require`，
 * 沙箱 preload 的 `require` 也只是受限 polyfill（仅 electron/events/timers/url），
 * `fs` 与 `isomorphic-git` 均无法在 renderer 加载。
 *
 * 经 `electron-main/gitVersionChannel.ts` 以 `ProxyChannel` 暴露给 renderer。
 * 与 `node/kbSqliteStore.ts` 同范式：npm 依赖用 `require` 惰性加载 + try/catch 降级。
 */

import * as fs from 'fs';
import { createRequire } from 'node:module';
import {
	joinRepoPath,
	defaultAutoMessage,
	parseUnifiedDiff,
	simpleDiffResult,
} from '../common/gitVersionPure.js';
import type {
	GitAvailability,
	GitCommitMeta,
	GitCommitRequest,
	GitDiffResult,
	GitInitOptions,
	GitRangeDiffResult,
	GitRollbackOptions,
	GitStatusRequest,
	GitWorkspaceStatus,
	IGitVersionBackend,
} from '../common/gitVersionBackend.js';

// ─── npm 依赖加载（仅主进程可用）───────────────────────────────────────

/**
 * 主进程以 **ESM** 运行（`package.json` 的 `"type": "module"`），裸 `require`
 * 是未定义的全局 —— 必须用 `createRequire` 显式构造（同 `bootstrap-node.ts`）。
 * 直接写 `require('isomorphic-git')` 只会抛 ReferenceError 并被 catch 吞掉，
 * 表现为"Git 不可用"的静默降级。
 */
const nodeRequire = createRequire(import.meta.url);

/** CJS/ESM 双形态归一：优先取带目标方法的那一层。 */
function pickModule(mod: any, probe: string): any {
	if (!mod) { return null; }
	if (typeof mod[probe] === 'function') { return mod; }
	if (mod.default && typeof mod.default[probe] === 'function') { return mod.default; }
	return null;
}

let _git: any = null;
let _http: any = null;
let _diff: any = null;
let _loadError: string | null = null;

try {
	_git = pickModule(nodeRequire('isomorphic-git'), 'log');
	if (!_git) { _loadError = 'isomorphic-git 导出形态异常'; }
} catch (err) {
	_loadError = `isomorphic-git 加载失败: ${err instanceof Error ? err.message : String(err)}`;
}

try {
	// clone/fetch 需要 http 传输层（node 侧实现）
	_http = pickModule(nodeRequire('isomorphic-git/http/node'), 'request');
} catch {
	_http = null;
}

try {
	// diff 缺失不致命：走 simpleDiffResult 兜底
	_diff = pickModule(nodeRequire('diff'), 'createPatch');
} catch {
	_diff = null;
}

function decode(blob: Uint8Array): string {
	return new TextDecoder().decode(blob);
}

function writeGitignore(dir: string, lines: readonly string[]): void {
	const gi = joinRepoPath(dir, '.gitignore');
	try { if (fs.existsSync(gi)) { return; } } catch { /* 继续尝试写入 */ }
	try { fs.writeFileSync(gi, lines.join('\n') + '\n', 'utf8'); } catch { /* 非致命 */ }
}

const EMPTY_STATUS: GitWorkspaceStatus = {
	initialized: false, headSha: null, headMessage: null, dirty: false, branch: null,
};

// ─── 引擎 ──────────────────────────────────────────────────────────────

export class GitVersionEngine implements IGitVersionBackend {

	async isAvailable(): Promise<GitAvailability> {
		const reasons: string[] = [];
		if (!_git) { reasons.push(_loadError ?? 'isomorphic-git 不可用'); }
		return { available: !!_git, reasons };
	}

	async isRepo(dir: string): Promise<boolean> {
		if (!_git) { return false; }
		try { await _git.log({ fs, dir, depth: 1 }); return true; } catch { return false; }
	}

	async initRepo(dir: string, opts: GitInitOptions): Promise<boolean> {
		if (!_git) { return false; }
		if (await this.isRepo(dir)) { return false; }
		if (opts.ensureDir && !fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
		writeGitignore(dir, opts.gitignore);
		await _git.init({ fs, dir, defaultBranch: 'main' });
		if (opts.addPath !== null) {
			const shouldCommit = opts.commitWhen === 'always' || fs.existsSync(joinRepoPath(dir, opts.addPath));
			if (shouldCommit) {
				await _git.add({ fs, dir, filepath: opts.addPath });
				try { await _git.commit({ fs, dir, message: opts.initMessage, author: opts.author }); } catch { /* 空仓库 */ }
			}
		}
		return true;
	}

	async cloneRepo(dir: string, url: string): Promise<void> {
		if (!_git) { throw new Error(`isomorphic-git 不可用: ${_loadError ?? '未知'}`); }
		if (!_http) { throw new Error('isomorphic-git/http/node 加载失败，无法克隆远程仓库'); }
		if (!/^https?:\/\//i.test(url)) { throw new Error(`仅支持 http(s) git URL（不支持 ssh/git@）: ${url}`); }
		fs.mkdirSync(dir, { recursive: true });
		await _git.clone({ fs, http: _http, dir, url, depth: 1, singleBranch: true });
	}

	async commitChanges(dir: string, req: GitCommitRequest): Promise<string | null> {
		if (!_git) { return null; }
		if (!(await this.isRepo(dir))) { return null; }
		if (req.requireExistsRelPath && !fs.existsSync(joinRepoPath(dir, req.requireExistsRelPath))) { return null; }
		for (const p of req.addPaths) {
			try { await _git.add({ fs, dir, filepath: p }); }
			catch { try { await _git.remove({ fs, dir, filepath: p }); } catch { /* ignore */ } }
		}
		// 空提交检测：statusMatrix 行 = [filepath, HEAD, WORKDIR, STAGE]。
		// HEAD 与 STAGE 一致说明暂存区相对上一提交无差异 → 跳过。
		// （不能用 git.writeTree —— isomorphic-git 的 writeTree 需显式 tree 入参，
		//   并非"把索引写成 tree"，直接调用会抛 MissingParameterError。）
		const matrix = await _git.statusMatrix({ fs, dir }) as Array<[string, number, number, number]>;
		if (!matrix.some(row => row[1] !== row[3])) { return null; }
		return await _git.commit({ fs, dir, message: req.message || defaultAutoMessage(), author: req.author }) as string;
	}

	async logCommits(dir: string, opts: { filepath?: string; limit: number }): Promise<GitCommitMeta[]> {
		if (!_git) { return []; }
		const logOpts: any = { fs, dir, ref: 'HEAD', depth: opts.limit };
		if (opts.filepath) { logOpts.filepath = opts.filepath; }
		const log = await _git.log(logOpts);
		return log.map((c: any) => ({
			sha: c.oid,
			shortSha: c.oid.substring(0, 7),
			message: c.commit?.message ?? '',
			author: c.commit?.author?.name ?? '?',
			time: c.commit?.author?.timestamp ?? 0,
		}));
	}

	async readFileAtCommit(dir: string, filepath: string, sha: string): Promise<string> {
		if (!_git) { throw new Error('isomorphic-git not available'); }
		const blob = await _git.readBlob({ fs, dir, oid: sha, filepath });
		return decode(blob.blob);
	}

	async fileDiffAtCommit(dir: string, filepath: string, sha: string): Promise<GitDiffResult | null> {
		if (!_git) { return null; }
		let newContent = '';
		try { newContent = decode((await _git.readBlob({ fs, dir, oid: sha, filepath })).blob); } catch { newContent = ''; }
		let oldContent = ''; let fromSha: string | null = null;
		try {
			const commit = await _git.readCommit({ fs, dir, oid: sha });
			const parent = commit.commit.parent?.[0];
			if (parent) {
				fromSha = parent;
				try { oldContent = decode((await _git.readBlob({ fs, dir, oid: parent, filepath })).blob); } catch { /* 父版无此文件 */ }
			}
		} catch { /* root */ }
		if (!_diff) { return simpleDiffResult(fromSha, sha, oldContent, newContent); }
		const filename = filepath.split('/').pop() || filepath;
		const unified = _diff.createPatch(filename, oldContent, newContent, fromSha?.slice(0, 7) || 'root', sha.slice(0, 7), { context: 3 });
		return { fromSha, toSha: sha, hunks: parseUnifiedDiff(unified), unified };
	}

	async rangeDiff(dir: string, filepath: string, absPath: string, fromSha: string, toSha?: string): Promise<GitRangeDiffResult | null> {
		if (!_git) { return null; }
		const targetSha: string | null = toSha
			? (toSha === 'HEAD' ? await _git.resolveRef({ fs, dir, ref: 'HEAD' }) as string : toSha)
			: null;
		const fromText = await this.readFileAtCommit(dir, filepath, fromSha).catch(() => '');
		const toText = targetSha
			? await this.readFileAtCommit(dir, filepath, targetSha).catch(() => '')
			: fs.readFileSync(absPath, 'utf8');
		let unified: string;
		if (_diff) {
			unified = _diff.createTwoFilesPatch(`a/${filepath}`, `b/${filepath}`, fromText, toText, `v${fromSha.slice(0, 7)}`, targetSha ? `v${targetSha.slice(0, 7)}` : 'WORKING');
		} else {
			unified = `--- a/${filepath}\n+++ b/${filepath}\n@@ ... @@\n${fromText}\n---\n${toText}`;
		}
		return { fromSha, toSha: targetSha ?? 'WORKING', unified };
	}

	async createTag(dir: string, tagName: string): Promise<void> {
		if (!_git) { return; }
		await _git.tag({ fs, dir, ref: tagName, message: `Release ${tagName}` });
	}

	async repoStatus(dir: string, opts?: GitStatusRequest): Promise<GitWorkspaceStatus> {
		if (!_git) { return EMPTY_STATUS; }
		const exts = opts?.dirtyFileExtensions;
		try {
			let headSha: string | null = null; let headMessage: string | null = null;
			try {
				const commits = await _git.log({ fs, dir, depth: 1 });
				if (commits.length > 0) { headSha = commits[0].oid; headMessage = commits[0].commit?.message?.split('\n')[0] ?? null; }
			} catch { return EMPTY_STATUS; /* 未初始化 */ }
			let dirty = false;
			try {
				const matrix = await _git.statusMatrix({ fs, dir });
				for (const row of matrix) {
					const fp = row[0] as string;
					if (exts && exts.length > 0 && !exts.some(e => fp.endsWith(e))) { continue; }
					if (row[1] !== row[2] || row[2] !== row[3]) { dirty = true; break; }
				}
			} catch { /* ignore */ }
			return { initialized: true, headSha, headMessage, dirty, branch: 'main' };
		} catch { return EMPTY_STATUS; }
	}

	async rollback(dir: string, filepath: string, sha: string, absPath: string, opts?: GitRollbackOptions): Promise<string> {
		const content = await this.readFileAtCommit(dir, filepath, sha);
		if (opts?.ensureDir) {
			const parent = joinRepoPath(absPath, '..');
			if (!fs.existsSync(parent)) { fs.mkdirSync(parent, { recursive: true }); }
		}
		fs.writeFileSync(absPath, content, 'utf8');
		return content;
	}
}
