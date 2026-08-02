/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Git 版本控制门面 — 各资源（agent / skill / workflow / kb）版本管理 service 的共享入口。
 *
 * 本模块为**纯模块**（无 DI、无资源 id 概念）。各 VersionService 作为薄壳：
 * 负责 id→目录解析、相对路径计算、类型适配与日志，实际 git 操作全部委托本模块。
 *
 * ## 为什么不在 renderer 直接跑 isomorphic-git
 * workbench renderer 以 **Chromium 沙箱**运行（`windows.ts` 强制 `sandbox: true`）：
 * - 无 Node `require`；`globalThis.require` 只是 AMD 加载器 shim，连 `fs` 都解析不了；
 * - 沙箱 preload 的 `require` 是受限 polyfill，仅支持 `electron`/`events`/`timers`/`url`，
 *   同样无法 `require('fs')` 或 `require('isomorphic-git')`。
 *
 * 因此实现已迁至主进程（`node/gitVersionEngine.ts`），本模块经 `ProxyChannel` 代理调用。
 * 使用前必须先调用 `initGitVersionBackend(mainProcessService)`（4 个 VersionService
 * 均在构造函数中调用，幂等）。
 */

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import {
	GIT_VERSION_CHANNEL,
	type GitAuthor,
	type GitCommitMeta,
	type GitDiffHunk,
	type GitDiffLine,
	type GitDiffResult,
	type GitInitOptions,
	type GitRangeDiffResult,
	type GitRollbackOptions,
	type GitStatusRequest,
	type GitWorkspaceStatus,
	type IGitVersionBackend,
} from '../common/gitVersionBackend.js';

// 类型对外转发：壳层沿用 `core.GitAuthor` 等写法，无需感知契约文件位置。
export type {
	GitAuthor,
	GitCommitMeta,
	GitDiffHunk,
	GitDiffLine,
	GitDiffResult,
	GitInitOptions,
	GitRangeDiffResult,
	GitRollbackOptions,
	GitStatusRequest,
	GitWorkspaceStatus,
};

// 纯函数对外转发（renderer 侧直接可用，无需 IPC）。
export { joinRepoPath, defaultAutoMessage, parseUnifiedDiff, simpleDiffText } from '../common/gitVersionPure.js';

// ─── 后端接入 ──────────────────────────────────────────────────────────

let _backend: IGitVersionBackend | undefined;
/** 主进程探测结果；undefined = 探测未完成（乐观视为可用，实际调用仍走主进程） */
let _available: boolean | undefined;
let _reasons: readonly string[] = [];
let _warned = false;
/** 探测是否因 IPC 层失败而告负（可重试）；引擎明确答复"不可用"则为终态，不再重试 */
let _probeFailedTransiently = false;
let _probing = false;
let _lastProbeAt = 0;
/** 重探冷却，避免 UI 高频调用把 IPC 打爆 */
const PROBE_RETRY_COOLDOWN_MS = 5_000;

/**
 * 「通道不存在」类错误的识别。`ChannelServer` 对未注册的 channel 会在 1s 后回
 * `Unknown channel` —— 在开发期，最常见成因是**只重载了窗口、主进程仍是旧进程**
 * （renderer 已加载新代码，主进程未重启故未注册该 channel）。
 */
function isUnknownChannelError(msg: string): boolean {
	return msg.includes('Unknown channel') || msg.includes('timed out after');
}

function describeUnavailable(): string {
	const raw = _reasons.join('; ');
	if (raw && isUnknownChannelError(raw)) {
		return `主进程未注册 git 通道（${raw}）。开发期常见成因：只重载了窗口，主进程仍是旧进程 —— 请完全退出应用后重新启动。`;
	}
	return raw || '主进程 isomorphic-git 加载失败';
}

/** 向主进程发起一次可用性探测（结果写入模块级缓存）。 */
function probeBackend(): void {
	const b = _backend;
	if (!b || _probing) { return; }
	_probing = true;
	_lastProbeAt = Date.now();
	b.isAvailable().then(
		r => {
			_probing = false;
			_available = r.available;
			_reasons = r.reasons;
			// 引擎给出了明确答复 → 终态，无需重试
			_probeFailedTransiently = false;
		},
		err => {
			_probing = false;
			_available = false;
			_reasons = [err instanceof Error ? err.message : String(err)];
			// IPC 层失败（通道未注册 / 主进程尚未就绪）→ 允许后续重探，避免一次
			// 早期失败把整个窗口生命周期内的 git 能力永久钉死为不可用
			_probeFailedTransiently = true;
			_warned = false;
		},
	);
}

/**
 * 绑定主进程 git 后端。幂等 —— 4 个 VersionService 均在构造函数中调用，
 * 谁先构造谁完成绑定，避免依赖 contribution 启动顺序。
 */
export function initGitVersionBackend(mainProcessService: IMainProcessService): void {
	if (_backend) { return; }
	_backend = ProxyChannel.toService<IGitVersionBackend>(mainProcessService.getChannel(GIT_VERSION_CHANNEL));
	probeBackend();
}

/** Git 是否可用（主进程 isomorphic-git 可加载）。探测完成前乐观返回 true。 */
export function isGitAvailable(log?: { warn(msg: string): void }): boolean {
	if (!_backend) {
		if (log && !_warned) { _warned = true; log.warn('[GitVersion] 不可用: 主进程后端未绑定（initGitVersionBackend 未调用）'); }
		return false;
	}
	if (_available === false) {
		if (log && !_warned) { _warned = true; log.warn(`[GitVersion] 不可用: ${describeUnavailable()}`); }
		// 仅 IPC 层失败才重探；重探是异步的，本次仍返回 false，下次调用即可能恢复
		if (_probeFailedTransiently && Date.now() - _lastProbeAt >= PROBE_RETRY_COOLDOWN_MS) { probeBackend(); }
		return false;
	}
	return true;
}

/**
 * 不可用时的人类可读原因（可用时返回 undefined）。供 UI 展示，
 * 避免笼统的"当前环境不支持"把桌面端的通道/加载问题误导为环境问题。
 */
export function gitUnavailableReason(): string | undefined {
	if (!_backend) { return '主进程后端未绑定（initGitVersionBackend 未调用）'; }
	if (_available === false) { return describeUnavailable(); }
	return undefined;
}

// ─── 操作转发 ──────────────────────────────────────────────────────────

/** 初始化 dir 为 git 仓库（已初始化则跳过）。返回是否新初始化。 */
export async function gitInitRepo(dir: string, opts: GitInitOptions): Promise<boolean> {
	return _backend ? _backend.initRepo(dir, opts) : false;
}

/** 浅克隆 http(s) git 仓库到 dir。后端未绑定时抛错。 */
export async function gitCloneRepo(dir: string, url: string): Promise<void> {
	if (!_backend) { throw new Error('git backend not available'); }
	return _backend.cloneRepo(dir, url);
}

export interface GitCommitOptions {
	/** 未初始化时调用（壳层提供，内部应调 init）——留在 renderer 侧，因需回调壳层逻辑 */
	readonly ensureInit: () => Promise<void>;
	/** 要暂存的相对路径；每个 add 失败时回退 remove（处理文件删除） */
	readonly addPaths: readonly string[];
	readonly author: GitAuthor;
	/** 自定义提交消息（缺省用 defaultAutoMessage） */
	readonly message?: string;
	/**
	 * 暂存前要求该相对路径存在，否则放弃提交（返回 null）。workflow 用于目标文件缺失时跳过。
	 * 取代原 `preStageCheck` 回调：renderer 无 fs，存在性检查须在主进程做。
	 */
	readonly requireExistsRelPath?: string;
}

/** 暂存 + 提交。无变化返回 null，否则返回新 sha。 */
export async function gitCommitChanges(dir: string, opts: GitCommitOptions): Promise<string | null> {
	const b = _backend;
	if (!b) { return null; }
	if (!await b.isRepo(dir)) {
		await opts.ensureInit();
		if (!await b.isRepo(dir)) { return null; }
	}
	return b.commitChanges(dir, {
		addPaths: opts.addPaths,
		author: opts.author,
		message: opts.message,
		requireExistsRelPath: opts.requireExistsRelPath,
	});
}

export async function gitLogCommits(dir: string, opts: { filepath?: string; limit: number }): Promise<GitCommitMeta[]> {
	return _backend ? _backend.logCommits(dir, opts) : [];
}

export async function gitReadFileAtCommit(dir: string, filepath: string, sha: string): Promise<string> {
	if (!_backend) { throw new Error('git backend not available'); }
	return _backend.readFileAtCommit(dir, filepath, sha);
}

/** 单文件在 sha 提交相对其父提交的 diff（root 提交则 fromSha=null）。 */
export async function gitFileDiffAtCommit(dir: string, filepath: string, sha: string): Promise<GitDiffResult | null> {
	return _backend ? _backend.fileDiffAtCommit(dir, filepath, sha) : null;
}

/** 两提交间（或提交与工作区）的单文件 diff（skill 用）。toSha 省略 = 工作区。 */
export async function gitRangeDiff(dir: string, filepath: string, absPath: string, fromSha: string, toSha?: string): Promise<GitRangeDiffResult | null> {
	return _backend ? _backend.rangeDiff(dir, filepath, absPath, fromSha, toSha) : null;
}

export async function gitCreateTag(dir: string, tagName: string): Promise<void> {
	if (_backend) { await _backend.createTag(dir, tagName); }
}

export async function gitRepoStatus(dir: string, opts?: GitStatusRequest): Promise<GitWorkspaceStatus> {
	if (!_backend) { return { initialized: false, headSha: null, headMessage: null, dirty: false, branch: null }; }
	return _backend.repoStatus(dir, opts);
}

/** 把 sha 版本的文件内容写回 absPath，返回写回的内容。 */
export async function gitRollback(dir: string, filepath: string, sha: string, absPath: string, opts?: GitRollbackOptions): Promise<string> {
	if (!_backend) { throw new Error('git backend not available'); }
	return _backend.rollback(dir, filepath, sha, absPath, opts);
}
