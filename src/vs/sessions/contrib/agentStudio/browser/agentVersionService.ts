/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 版本管理服务 — 基于 isomorphic-git 的 .agent.md 文件 git 版本控制。
 * 薄壳：仅负责 id→目录解析、类型适配与日志；git 操作委托 `gitVersionCore`。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import {
	IAgentVersionService,
	type AgentCommitMeta,
	type AgentDiffResult,
	type AgentDiffHunk,
} from '../common/agentVersionTypes.js';
import * as core from './gitVersionCore.js';

const TRACKED_FILE = '.agent.md';
const AUTHOR: core.GitAuthor = { name: 'Sarosis Agent', email: 'agent@sarosis.local' };
const GITIGNORE: readonly string[] = [
	'# Agent version management — exclude non-definition files',
	'config.html',
	'.DS_Store',
	'*.tmp',
	'*.log',
];

// ── 主类 ──

export class AgentVersionService extends Disposable implements IAgentVersionService {

	declare readonly _serviceBrand: undefined;

	private _studioService: IAgentStudioService | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		// git 实现宿主在主进程（renderer 沙箱无 fs/isomorphic-git）；绑定幂等
		core.initGitVersionBackend(mainProcessService);
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

	isAvailable(): boolean {
		return core.isGitAvailable(this.logService);
	}

	// ── 初始化 ──

	async init(agentId: string): Promise<void> {
		if (!core.isGitAvailable()) { return; }
		try {
			const dir = await this._agentDir(agentId);
			await core.gitInitRepo(dir, {
				gitignore: GITIGNORE,
				initMessage: 'init: agent created',
				author: AUTHOR,
				addPath: TRACKED_FILE,
				commitWhen: 'always',
			});
			this.logService.info(`[AgentVersion] init: ${agentId}`);
		} catch (err) {
			this.logService.warn(`[AgentVersion] init failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── 自动提交 ──

	async autoCommit(agentId: string, message?: string): Promise<string | null> {
		if (!core.isGitAvailable()) { return null; }
		try {
			const dir = await this._agentDir(agentId);
			const sha = await core.gitCommitChanges(dir, {
				ensureInit: () => this.init(agentId),
				addPaths: [TRACKED_FILE],
				author: AUTHOR,
				message,
			});
			if (sha) { this.logService.info(`[AgentVersion] autoCommit: ${agentId} → ${sha.slice(0, 7)}`); }
			return sha;
		} catch (err) {
			this.logService.warn(`[AgentVersion] autoCommit failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	// ── 发布锚点 tag ──

	async tag(agentId: string, tagName: string): Promise<void> {
		if (!core.isGitAvailable()) { return; }
		try {
			await core.gitCreateTag(await this._agentDir(agentId), tagName);
			this.logService.info(`[AgentVersion] tagged ${agentId}: ${tagName}`);
		} catch (err) {
			this.logService.warn(`[AgentVersion] tag failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── 历史 ──

	async history(agentId: string, limit: number = 50): Promise<AgentCommitMeta[]> {
		if (!core.isGitAvailable()) { return []; }
		try {
			const dir = await this._agentDir(agentId);
			const commits = await core.gitLogCommits(dir, { filepath: TRACKED_FILE, limit });
			return commits.map(c => ({
				sha: c.sha,
				shortSha: c.shortSha,
				message: c.message,
				author: c.author,
				time: new Date(c.time * 1000).toISOString(),
			}));
		} catch (err) {
			this.logService.warn(`[AgentVersion] history failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	// ── Diff ──

	async diff(agentId: string, sha: string): Promise<AgentDiffResult | null> {
		if (!core.isGitAvailable()) { return null; }
		try {
			const dir = await this._agentDir(agentId);
			const r = await core.gitFileDiffAtCommit(dir, TRACKED_FILE, sha);
			if (!r) { return null; }
			return { fromSha: r.fromSha ?? 'root', toSha: r.toSha, hunks: r.hunks, unified: r.unified };
		} catch (err) {
			this.logService.warn(`[AgentVersion] diff failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	// ── 读取历史版本 ──

	async fileAtVersion(agentId: string, sha: string): Promise<string> {
		const dir = await this._agentDir(agentId);
		return core.gitReadFileAtCommit(dir, TRACKED_FILE, sha);
	}

	// ── 回滚 ──

	async rollback(agentId: string, sha: string): Promise<string> {
		if (!core.isGitAvailable()) { throw new Error('Git 在当前环境不可用'); }
		const dir = await this._agentDir(agentId);
		const content = await core.gitRollback(dir, TRACKED_FILE, sha, core.joinRepoPath(dir, TRACKED_FILE));
		this.logService.info(`[AgentVersion] rollback: ${agentId} → ${sha.slice(0, 7)}`);
		// 不自动提交 — 下次 updateAgent 触发 autoCommit 会捕获为恢复版本
		return content;
	}
}

// ── 兼容导出（纯函数，供测试与外部复用）──────────────────────────────────

export function parseUnifiedDiff(unified: string): readonly AgentDiffHunk[] {
	return core.parseUnifiedDiff(unified);
}

export function simpleDiff(oldText: string, newText: string): string {
	return core.simpleDiffText(oldText, newText);
}
