/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 版本管理服务 — 基于 isomorphic-git 的 .agent.md 文件 git 版本控制。
 * 参考 KbVersionService 实现，复用相同的 nodeRequire + isomorphic-git 模式。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import {
	IAgentVersionService,
	type AgentCommitMeta,
	type AgentDiffResult,
	type AgentDiffHunk,
} from '../common/agentVersionTypes.js';

// ── 动态加载 isomorphic-git / fs / diff（仅 Electron renderer）──

let _gitModule: any;
let _fsModule: any;
let _diffModule: any;

function nodeRequire(id: string): any {
	return (globalThis as any).require?.(id);
}

function getGit(): any {
	if (!_gitModule) { _gitModule = nodeRequire('isomorphic-git'); }
	return _gitModule;
}
function getFs(): any {
	if (!_fsModule) { _fsModule = nodeRequire('fs'); }
	return _fsModule;
}
function getDiff(): any {
	if (!_diffModule) {
		try { _diffModule = nodeRequire('diff'); } catch { /* diff lib optional */ }
	}
	return _diffModule;
}

// ── 默认 .gitignore ──

function writeDefaultGitignore(fs: any, dir: string): void {
	const content = [
		'# Agent version management — exclude non-definition files',
		'config.html',
		'.DS_Store',
		'*.tmp',
		'*.log',
	].join('\n');
	fs.writeFileSync(require('path').join(dir, '.gitignore'), content, 'utf8');
}

// ── 辅助函数 ──

async function toRelPath(_agentId: string): Promise<string> {
	// agent 目录下仅追踪 .agent.md
	return '.agent.md';
}

// ── 主类 ──

export class AgentVersionService extends Disposable implements IAgentVersionService {

	declare readonly _serviceBrand: undefined;

	private _studioService: IAgentStudioService | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/** Lazy accessor to break circular DI: agentStudioService → agentVersionService → agentStudioService */
	private get studioService(): IAgentStudioService {
		if (!this._studioService) {
			this._studioService = this.instantiationService.invokeFunction(accessor => accessor.get(IAgentStudioService));
		}
		return this._studioService;
	}

	private async _agentDir(agentId: string): Promise<string> {
		const uri = await this.studioService.getAgentDir(agentId);
		return uri.fsPath;
	}

	// ── 初始化 ──

	async init(agentId: string): Promise<void> {
		try {
			const git = getGit();
			const fs = getFs();
			const dir = await this._agentDir(agentId);

			// 如果已初始化则跳过
			try {
				await git.log({ fs, dir, depth: 1 });
				return;
			} catch { /* 未初始化，继续 */ }

			writeDefaultGitignore(fs, dir);
			await git.init({ fs, dir, defaultBranch: 'main' });
			await git.add({ fs, dir, filepath: '.agent.md' });
			await git.commit({
				fs, dir,
				message: 'init: agent created',
				author: { name: 'Sarosis Agent', email: 'agent@sarosis.local' },
			});
			this.logService.info(`[AgentVersion] init: ${agentId}`);
		} catch (err) {
			this.logService.warn(`[AgentVersion] init failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── 自动提交 ──

	async autoCommit(agentId: string): Promise<string | null> {
		try {
			const git = getGit();
			const fs = getFs();
			const dir = await this._agentDir(agentId);

			// 未初始化则先初始化
			try { await git.log({ fs, dir, depth: 1 }); } catch {
				await this.init(agentId);
				await git.log({ fs, dir, depth: 1 });
			}

			const relPath = await toRelPath(agentId);

			// 暂存文件（处理文件已删除的情况）
			try {
				await git.add({ fs, dir, filepath: relPath });
			} catch {
				try { await git.remove({ fs, dir, filepath: relPath }); } catch { /* ignore */ }
			}

			const treeOid = await git.writeTree({ fs, dir }) as string;
			const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
			const commit = await git.readCommit({ fs, dir, oid: headOid });

			// Tree OID 相同则无变化，跳过
			if (treeOid === (commit as any).commit.tree) {
				return null;
			}

			const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
			const sha = await git.commit({
				fs, dir,
				message: `auto: ${now}`,
				author: { name: 'Sarosis Agent', email: 'agent@sarosis.local' },
			}) as string;

			this.logService.info(`[AgentVersion] autoCommit: ${agentId} → ${sha?.slice(0, 7)}`);
			return sha;
		} catch (err) {
			this.logService.warn(`[AgentVersion] autoCommit failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	// ── 历史 ──

	async history(agentId: string, limit: number = 50): Promise<AgentCommitMeta[]> {
		try {
			const git = getGit();
			const fs = getFs();
			const dir = await this._agentDir(agentId);

			const relPath = await toRelPath(agentId);
			const log = await git.log({ fs, dir, ref: 'HEAD', filepath: relPath, depth: limit });

			return log.map((c: any) => ({
				sha: c.oid,
				shortSha: c.oid.slice(0, 7),
				message: c.commit.message,
				author: c.commit.author.name,
				time: new Date(c.commit.author.timestamp * 1000).toISOString(),
			}));
		} catch (err) {
			this.logService.warn(`[AgentVersion] history failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	// ── Diff ──

	async diff(agentId: string, sha: string): Promise<AgentDiffResult | null> {
		try {
			const git = getGit();
			const fs = getFs();
			const dir = await this._agentDir(agentId);
			const relPath = await toRelPath(agentId);

			// 读取目标版本
			const target = await git.readBlob({ fs, dir, oid: sha, filepath: relPath });
			const newContent = new TextDecoder().decode(target.blob);

			// 读取父版本
			const commit = await git.readCommit({ fs, dir, oid: sha });
			const parentSha = (commit as any).commit.parent?.[0];
			let oldContent = '';
			if (parentSha) {
				try {
					const parent = await git.readBlob({ fs, dir, oid: parentSha, filepath: relPath });
					oldContent = new TextDecoder().decode(parent.blob);
				} catch { /* 初始提交无父版本 */ }
			}

			const diffLib = getDiff();
			let unified: string;
			if (diffLib) {
				unified = diffLib.createPatch(
					relPath, oldContent, newContent, parentSha?.slice(0, 7) || 'root', sha.slice(0, 7),
				);
			} else {
				unified = `--- ${relPath} (${parentSha?.slice(0, 7) || 'root'})\n+++ ${relPath} (${sha.slice(0, 7)})\n${this._simpleDiff(oldContent, newContent)}`;
			}

			return {
				fromSha: parentSha || 'root',
				toSha: sha,
				hunks: diffLib ? this._parseUnifiedDiff(unified) : [],
				unified,
			};
		} catch (err) {
			this.logService.warn(`[AgentVersion] diff failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	// ── 读取历史版本 ──

	async fileAtVersion(agentId: string, sha: string): Promise<string> {
		const git = getGit();
		const fs = getFs();
		const dir = await this._agentDir(agentId);
		const relPath = await toRelPath(agentId);
		const blob = await git.readBlob({ fs, dir, oid: sha, filepath: relPath });
		return new TextDecoder().decode(blob.blob);
	}

	// ── 回滚 ──

	async rollback(agentId: string, sha: string): Promise<string> {
		const fs = getFs();
		const dir = await this._agentDir(agentId);
		const content = await this.fileAtVersion(agentId, sha);

		const filePath = require('path').join(dir, '.agent.md');
		fs.writeFileSync(filePath, content, 'utf8');
		this.logService.info(`[AgentVersion] rollback: ${agentId} → ${sha.slice(0, 7)}`);

		// 不自动提交 — 下次 updateAgent 触发 autoCommit 会捕获为恢复版本

		return content;
	}

	// ── private helpers ──

	private _parseUnifiedDiff(unified: string): readonly AgentDiffHunk[] {
		return parseUnifiedDiff(unified);
	}

	private _simpleDiff(oldText: string, newText: string): string {
		return simpleDiff(oldText, newText);
	}
}

// ── 导出纯函数（可单测）───────────────────────────────────────────────

/**
 * 解析 unified diff 文本为结构化 hunks。
 * 支持 @@ ... @@ header、+/-/空格 行。
 */
export function parseUnifiedDiff(unified: string): readonly AgentDiffHunk[] {
	const hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: Array<{ kind: 'context' | 'add' | 'remove'; text: string }> }[] = [];
	const hunkRe = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/;
	let current: typeof hunks[0] | null = null;

	for (const line of unified.split('\n')) {
		const hm = line.match(hunkRe);
		if (hm) {
			current = {
				oldStart: parseInt(hm[1]), oldLines: parseInt(hm[2]),
				newStart: parseInt(hm[3]), newLines: parseInt(hm[4]),
				lines: [],
			};
			hunks.push(current);
		} else if (current) {
			if (line.startsWith('+')) {
				current.lines.push({ kind: 'add', text: line.slice(1) });
			} else if (line.startsWith('-')) {
				current.lines.push({ kind: 'remove', text: line.slice(1) });
			} else if (line.startsWith(' ')) {
				current.lines.push({ kind: 'context', text: line.slice(1) });
			}
		}
	}
	return hunks;
}

/**
 * 简单的逐行 diff（无需 diff 库）。
 * 行首 `+` 为新增，`-` 为删除，`  ` 为相同。
 */
export function simpleDiff(oldText: string, newText: string): string {
	const oldLines = oldText.split('\n');
	const newLines = newText.split('\n');
	const result: string[] = [];
	const maxLen = Math.max(oldLines.length, newLines.length);
	for (let i = 0; i < maxLen; i++) {
		const ol = oldLines[i] ?? '';
		const nl = newLines[i] ?? '';
		if (ol === nl) {
			result.push(`  ${ol}`);
		} else {
			if (ol) { result.push(`- ${ol}`); }
			if (nl) { result.push(`+ ${nl}`); }
		}
	}
	return result.join('\n');
}
