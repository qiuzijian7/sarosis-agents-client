/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workflow 版本管理服务 — 基于 isomorphic-git 的 workflow.json 文件 git 版本控制。
 * 薄壳：仅负责 id→目录解析、类型适配与日志；git 操作委托 `gitVersionCore`。
 */

import * as path from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { SarosPath, resolveSarosPath } from '../common/sarosPaths.js';
import {
	IWorkflowVersionService,
	type WorkflowCommitMeta,
	type WorkflowDiffResult,
	type WorkflowDiffHunk,
} from '../common/workflowVersionTypes.js';
import * as core from './gitVersionCore.js';

const TRACKED_FILE = 'workflow.json';
const AUTHOR: core.GitAuthor = { name: 'Sarosis Agent', email: 'agent@sarosis.local' };
const GITIGNORE: readonly string[] = [
	'# Workflow version management — only track workflow.json',
	'*.tmp',
	'*.log',
	'.DS_Store',
];

// ── 主类 ──

export class WorkflowVersionService extends Disposable implements IWorkflowVersionService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@INativeEnvironmentService private readonly envService: INativeEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		// git 实现宿主在主进程（renderer 沙箱无 fs/isomorphic-git）；绑定幂等
		core.initGitVersionBackend(mainProcessService);
	}

	// ── 可用性检查 ──

	isAvailable(): boolean {
		return core.isGitAvailable(this.logService);
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
			const dir = this._workflowDir(workflowId);
			await core.gitInitRepo(dir, {
				gitignore: GITIGNORE,
				initMessage: 'init: workflow created',
				author: AUTHOR,
				addPath: TRACKED_FILE,
				commitWhen: 'ifFileExists',
				ensureDir: true,
			});
			this.logService.info(`[WorkflowVersion] init: ${workflowId}`);
		} catch (err) {
			this.logService.warn(`[WorkflowVersion] init failed for ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── 自动提交 ──

	async autoCommit(workflowId: string, message?: string): Promise<string | null> {
		if (!this.isAvailable()) { return null; }
		try {
			const dir = this._workflowDir(workflowId);
			const sha = await core.gitCommitChanges(dir, {
				ensureInit: () => this.init(workflowId),
				addPaths: [TRACKED_FILE],
				author: AUTHOR,
				message,
				// 文件缺失时跳过提交；存在性检查在主进程执行（renderer 沙箱无 fs）
				requireExistsRelPath: TRACKED_FILE,
			});
			if (sha) { this.logService.info(`[WorkflowVersion] autoCommit: ${workflowId} → ${sha.slice(0, 7)}`); }
			return sha;
		} catch (err) {
			this.logService.warn(`[WorkflowVersion] autoCommit failed for ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	// ── 发布锚点 tag ──

	async tag(workflowId: string, tagName: string): Promise<void> {
		if (!this.isAvailable()) { return; }
		try {
			await core.gitCreateTag(this._workflowDir(workflowId), tagName);
			this.logService.info(`[WorkflowVersion] tagged ${workflowId}: ${tagName}`);
		} catch (err) {
			this.logService.warn(`[WorkflowVersion] tag failed for ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── 历史 ──

	async history(workflowId: string, limit: number = 50): Promise<WorkflowCommitMeta[]> {
		if (!this.isAvailable()) { return []; }
		try {
			const dir = this._workflowDir(workflowId);
			const commits = await core.gitLogCommits(dir, { filepath: TRACKED_FILE, limit });
			return commits.map(c => ({
				sha: c.sha,
				shortSha: c.shortSha,
				message: c.message,
				author: c.author,
				time: new Date(c.time * 1000).toISOString(),
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
			const dir = this._workflowDir(workflowId);
			const r = await core.gitFileDiffAtCommit(dir, TRACKED_FILE, sha);
			if (!r) { return null; }
			return { fromSha: r.fromSha ?? 'root', toSha: r.toSha, hunks: r.hunks, unified: r.unified };
		} catch (err) {
			this.logService.warn(`[WorkflowVersion] diff failed for ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	// ── 读取历史版本 ──

	async workflowAtVersion(workflowId: string, sha: string): Promise<string> {
		return core.gitReadFileAtCommit(this._workflowDir(workflowId), TRACKED_FILE, sha);
	}

	// ── 回滚 ──

	async rollback(workflowId: string, sha: string): Promise<string> {
		if (!this.isAvailable()) { throw new Error('Git 在当前环境不可用'); }
		const dir = this._workflowDir(workflowId);
		// 目标目录缺失时由主进程创建（renderer 沙箱无 fs）
		const content = await core.gitRollback(dir, TRACKED_FILE, sha, core.joinRepoPath(dir, TRACKED_FILE), { ensureDir: true });
		this.logService.info(`[WorkflowVersion] rollback: ${workflowId} → ${sha.slice(0, 7)}`);
		// 不自动提交 — 下次 updateWorkflow 触发 autoCommit 会捕获为恢复版本
		return content;
	}
}

// ── 兼容导出（纯函数，供测试与外部复用）──────────────────────────────────

export function parseUnifiedDiff(unified: string): readonly WorkflowDiffHunk[] {
	return core.parseUnifiedDiff(unified);
}

export function simpleDiff(oldText: string, newText: string): string {
	return core.simpleDiffText(oldText, newText);
}
