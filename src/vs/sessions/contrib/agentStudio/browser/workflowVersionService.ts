/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workflow 版本管理服务 — 基于 isomorphic-git 的 workflow.json 文件 git 版本控制。
 *
 * 每个 workflow 在其存储目录（~/.vssaros/workflows/<id>/）下维护一个独立的 .git 仓库，
 * 追踪 workflow.json 的每次保存变更。与 AgentVersionService / SkillVersionService 模式一致。
 *
 * 使用 isomorphic-git（纯 JS，无原生依赖）通过 nodeRequire 在 Electron renderer 加载。
 */

import * as path from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { SarosPath, resolveSarosPath } from '../common/sarosPaths.js';
import {
	IWorkflowVersionService,
	type WorkflowCommitMeta,
	type WorkflowDiffResult,
	type WorkflowDiffHunk,
} from '../common/workflowVersionTypes.js';

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
	const gitignorePath = path.join(dir, '.gitignore');
	// 仅追踪 workflow.json 本身，忽略其他临时文件
	const content = [
		'# Workflow version management — only track workflow.json',
		'*.tmp',
		'*.log',
		'.DS_Store',
	].join('\n');
	try {
		fs.writeFileSync(gitignorePath, content, 'utf8');
	} catch { /* ignore */ }
}

// ── 追踪的文件路径 ──

const TRACKED_FILE = 'workflow.json';

// ── 主类 ──

export class WorkflowVersionService extends Disposable implements IWorkflowVersionService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@INativeEnvironmentService private readonly envService: INativeEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	// ── 可用性检查 ──

	isAvailable(): boolean {
		return typeof (globalThis as any).require === 'function' && !!nodeRequire('isomorphic-git');
	}

	// ── 路径解析 ──

	private _workflowDir(workflowId: string): string {
		const workflowsDir = resolveSarosPath(URI.file(this.envService.userDataPath), SarosPath.workflows);
		return path.join(workflowsDir.fsPath, workflowId);
	}

	// ── 初始化 ──

	async init(workflowId: string): Promise<void> {
		if (!this.isAvailable()) { return; }
		try {
			const git = getGit();
			const fs = getFs();
			const dir = this._workflowDir(workflowId);

			// 如果已初始化则跳过
			try {
				await git.log({ fs, dir, depth: 1 });
				return;
			} catch { /* 未初始化，继续 */ }

			// 确保目录存在
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			writeDefaultGitignore(fs, dir);
			await git.init({ fs, dir, defaultBranch: 'main' });

			// 如果 workflow.json 已存在，做初始提交
			const filePath = path.join(dir, TRACKED_FILE);
			if (fs.existsSync(filePath)) {
				await git.add({ fs, dir, filepath: TRACKED_FILE });
				await git.commit({
					fs, dir,
					message: 'init: workflow created',
					author: { name: 'Sarosis Agent', email: 'agent@sarosis.local' },
				});
			}
			this.logService.info(`[WorkflowVersion] init: ${workflowId}`);
		} catch (err) {
			this.logService.warn(`[WorkflowVersion] init failed for ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── 自动提交 ──

	async autoCommit(workflowId: string): Promise<string | null> {
		if (!this.isAvailable()) { return null; }
		try {
			const git = getGit();
			const fs = getFs();
			const dir = this._workflowDir(workflowId);

			// 未初始化则先初始化
			try { await git.log({ fs, dir, depth: 1 }); } catch {
				await this.init(workflowId);
				// 初始化可能已将当前文件作为初始提交，检查是否仍有变更
				try { await git.log({ fs, dir, depth: 1 }); } catch { return null; }
			}

			const filePath = path.join(dir, TRACKED_FILE);
			if (!fs.existsSync(filePath)) {
				return null;
			}

			// 暂存文件
			try {
				await git.add({ fs, dir, filepath: TRACKED_FILE });
			} catch {
				try { await git.remove({ fs, dir, filepath: TRACKED_FILE }); } catch { /* ignore */ }
			}

			// 比较 tree OID，无变化则跳过
			const treeOid = await git.writeTree({ fs, dir }) as string;
			let headOid: string | undefined;
			try {
				headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' }) as string | undefined;
			} catch { /* 新仓库无 HEAD */ }

			if (headOid) {
				const commit = await git.readCommit({ fs, dir, oid: headOid });
				if (treeOid === (commit as any).commit.tree) {
					return null; // 无变化
				}
			}

			const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
			const sha = await git.commit({
				fs, dir,
				message: `auto: ${now}`,
				author: { name: 'Sarosis Agent', email: 'agent@sarosis.local' },
			}) as string;

			this.logService.info(`[WorkflowVersion] autoCommit: ${workflowId} → ${sha?.slice(0, 7)}`);
			return sha;
		} catch (err) {
			this.logService.warn(`[WorkflowVersion] autoCommit failed for ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	// ── 历史 ──

	async history(workflowId: string, limit: number = 50): Promise<WorkflowCommitMeta[]> {
		if (!this.isAvailable()) { return []; }
		try {
			const git = getGit();
			const fs = getFs();
			const dir = this._workflowDir(workflowId);

			const log = await git.log({ fs, dir, ref: 'HEAD', filepath: TRACKED_FILE, depth: limit });

			return log.map((c: any) => ({
				sha: c.oid,
				shortSha: c.oid.slice(0, 7),
				message: c.commit.message,
				author: c.commit.author.name,
				time: new Date(c.commit.author.timestamp * 1000).toISOString(),
			}));
		} catch (err) {
			this.logService.warn(`[WorkflowVersion] history failed for ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	// ── Diff ──

	async diff(workflowId: string, sha: string): Promise<WorkflowDiffResult | null> {
		if (!this.isAvailable()) { return null; }
		try {
			const git = getGit();
			const fs = getFs();
			const dir = this._workflowDir(workflowId);

			// 读取目标版本
			const target = await git.readBlob({ fs, dir, oid: sha, filepath: TRACKED_FILE });
			const newContent = new TextDecoder().decode(target.blob);

			// 读取父版本
			const commit = await git.readCommit({ fs, dir, oid: sha });
			const parentSha = (commit as any).commit.parent?.[0];
			let oldContent = '';
			if (parentSha) {
				try {
					const parent = await git.readBlob({ fs, dir, oid: parentSha, filepath: TRACKED_FILE });
					oldContent = new TextDecoder().decode(parent.blob);
				} catch { /* 初始提交无父版本 */ }
			}

			const diffLib = getDiff();
			let unified: string;
			if (diffLib) {
				unified = diffLib.createPatch(
					TRACKED_FILE, oldContent, newContent,
					parentSha?.slice(0, 7) || 'root', sha.slice(0, 7),
				);
			} else {
				unified = `--- ${TRACKED_FILE} (${parentSha?.slice(0, 7) || 'root'})\n+++ ${TRACKED_FILE} (${sha.slice(0, 7)})\n${simpleDiff(oldContent, newContent)}`;
			}

			return {
				fromSha: parentSha || 'root',
				toSha: sha,
				hunks: diffLib ? parseUnifiedDiff(unified) : [],
				unified,
			};
		} catch (err) {
			this.logService.warn(`[WorkflowVersion] diff failed for ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	// ── 读取历史版本 ──

	async workflowAtVersion(workflowId: string, sha: string): Promise<string> {
		const git = getGit();
		const fs = getFs();
		const dir = this._workflowDir(workflowId);
		const blob = await git.readBlob({ fs, dir, oid: sha, filepath: TRACKED_FILE });
		return new TextDecoder().decode(blob.blob);
	}

	// ── 回滚 ──

	async rollback(workflowId: string, sha: string): Promise<string> {
		const fs = getFs();
		const dir = this._workflowDir(workflowId);
		const content = await this.workflowAtVersion(workflowId, sha);

		const filePath = path.join(dir, TRACKED_FILE);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(filePath, content, 'utf8');
		this.logService.info(`[WorkflowVersion] rollback: ${workflowId} → ${sha.slice(0, 7)}`);

		// 不自动提交 — 下次 updateWorkflow 触发 autoCommit 会捕获为恢复版本

		return content;
	}
}

// ── 导出纯函数（可单测）───────────────────────────────────────────────

/**
 * 解析 unified diff 文本为结构化 hunks。
 */
export function parseUnifiedDiff(unified: string): readonly WorkflowDiffHunk[] {
	const hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: Array<{ kind: 'context' | 'add' | 'remove'; text: string }> }> = [];
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
