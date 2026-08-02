/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Git 版本管理后端契约（renderer ↔ 主进程 IPC）。
 *
 * 背景：workbench renderer 以 **Chromium 沙箱**运行（`windows.ts` 强制 `sandbox: true`），
 * 既没有 Node `require`，沙箱 preload 的 `require` 也只是仅支持
 * `electron`/`events`/`timers`/`url` 的受限 polyfill —— 因此 `fs` / `isomorphic-git`
 * **不可能**在 renderer 内加载。git 实现改为宿主在主进程（`node/gitVersionEngine.ts`），
 * renderer 经 `ProxyChannel` 透明代理（对齐 `codebaseGraphStoreChannel` / `kbSqliteStoreChannel`）。
 *
 * 本文件是三端（common 契约 / node 实现 / browser 代理）唯一的类型与方法名来源。
 * 所有参数与返回值必须 **IPC 可序列化**：原回调式选项（`ensureInit` / `preStageCheck` /
 * `dirtyFileFilter`）在此一律降级为数据描述。
 */

/** 主进程 channel 名（`registerChannel` / `getChannel` 共用）。 */
export const GIT_VERSION_CHANNEL = 'vssaros-git-version';

// ─── 数据类型 ──────────────────────────────────────────────────────────

export interface GitAuthor {
	readonly name: string;
	readonly email: string;
}

export interface GitCommitMeta {
	readonly sha: string;
	readonly shortSha: string;
	/** 完整提交消息（未截断，可能含多行） */
	readonly message: string;
	readonly author: string;
	/** unix 秒时间戳 */
	readonly time: number;
}

export interface GitDiffLine {
	readonly kind: 'context' | 'add' | 'remove';
	readonly text: string;
}

export interface GitDiffHunk {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	readonly lines: GitDiffLine[];
}

export interface GitDiffResult {
	/** 父提交 sha；root 提交为 null */
	readonly fromSha: string | null;
	readonly toSha: string;
	readonly hunks: GitDiffHunk[];
	readonly unified: string;
}

export interface GitRangeDiffResult {
	readonly fromSha: string;
	readonly toSha: string;
	readonly unified: string;
}

export interface GitWorkspaceStatus {
	readonly initialized: boolean;
	readonly headSha: string | null;
	readonly headMessage: string | null;
	readonly dirty: boolean;
	readonly branch: string | null;
}

// ─── 请求选项（全部可序列化）───────────────────────────────────────────

export interface GitInitOptions {
	/** .gitignore 内容行（仅当不存在时写入） */
	readonly gitignore: readonly string[];
	readonly initMessage: string;
	readonly author: GitAuthor;
	/** 初始 add 的路径（'.' = 全部；具体文件 = 单文件）；null = 不做初始提交 */
	readonly addPath: string | null;
	/** 何时做初始提交：'always' 总是；'ifFileExists' 仅当 addPath 文件存在 */
	readonly commitWhen: 'always' | 'ifFileExists';
	/** init 前确保目录存在（workflow 用） */
	readonly ensureDir?: boolean;
}

export interface GitCommitRequest {
	/** 要暂存的相对路径；每个 add 失败时回退 remove（处理文件删除） */
	readonly addPaths: readonly string[];
	readonly author: GitAuthor;
	/** 自定义提交消息（缺省用 `defaultAutoMessage()`） */
	readonly message?: string;
	/**
	 * 暂存前要求该相对路径存在，否则放弃提交（返回 null）。
	 * 取代原 `preStageCheck` 回调 —— 回调无法跨 IPC，且 renderer 无 fs。
	 */
	readonly requireExistsRelPath?: string;
}

export interface GitStatusRequest {
	/**
	 * dirty 检测仅统计这些扩展名（如 `['.md', '.txt']`）；省略/为空 = 统计全部文件。
	 * 取代原 `dirtyFileFilter` 回调。
	 */
	readonly dirtyFileExtensions?: readonly string[];
}

export interface GitRollbackOptions {
	/** 写回前确保目标文件所在目录存在（workflow 用） */
	readonly ensureDir?: boolean;
}

export interface GitAvailability {
	readonly available: boolean;
	/** 不可用时的诊断原因（如 `isomorphic-git 加载失败`） */
	readonly reasons: readonly string[];
}

// ─── 后端接口 ──────────────────────────────────────────────────────────

/**
 * 主进程 git 后端。方法名即 IPC command 名（`ProxyChannel` 直接透传），
 * 改名需同步 `node/gitVersionEngine.ts` 与 `browser/gitVersionCore.ts`。
 */
export interface IGitVersionBackend {

	/** isomorphic-git / fs 是否可在主进程加载。结果由主进程缓存。 */
	isAvailable(): Promise<GitAvailability>;

	/** dir 是否已是含至少一个提交的 git 仓库。 */
	isRepo(dir: string): Promise<boolean>;

	/** 初始化 dir 为 git 仓库（已初始化则跳过）。返回是否新初始化。 */
	initRepo(dir: string, opts: GitInitOptions): Promise<boolean>;

	/**
	 * 浅克隆 http(s) git 仓库到 dir（depth=1, singleBranch）。
	 * dir 不存在时自动创建；失败（网络/认证/非 http(s) URL）抛错。
	 * 仅支持 http(s) URL —— isomorphic-git 的 http 传输不支持 ssh（git@host:...）。
	 */
	cloneRepo(dir: string, url: string): Promise<void>;

	/** 暂存 + 提交。未初始化 / 无变化 / 预检失败均返回 null，否则返回新 sha。 */
	commitChanges(dir: string, req: GitCommitRequest): Promise<string | null>;

	logCommits(dir: string, opts: { filepath?: string; limit: number }): Promise<GitCommitMeta[]>;

	readFileAtCommit(dir: string, filepath: string, sha: string): Promise<string>;

	/** 单文件在 sha 提交相对其父提交的 diff（root 提交则 fromSha=null）。 */
	fileDiffAtCommit(dir: string, filepath: string, sha: string): Promise<GitDiffResult | null>;

	/** 两提交间（或提交与工作区）的单文件 diff。toSha 省略 = 工作区。 */
	rangeDiff(dir: string, filepath: string, absPath: string, fromSha: string, toSha?: string): Promise<GitRangeDiffResult | null>;

	createTag(dir: string, tagName: string): Promise<void>;

	repoStatus(dir: string, opts?: GitStatusRequest): Promise<GitWorkspaceStatus>;

	/** 把 sha 版本的文件内容写回 absPath，返回写回的内容。 */
	rollback(dir: string, filepath: string, sha: string, absPath: string, opts?: GitRollbackOptions): Promise<string>;
}
