/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Memory Service — 索引配置管理 + 团队图谱共享 (Git)
 *
 * 设计变更（2026-07-03）：
 *   原本此服务负责下载/安装/配置 codebase-memory-mcp.exe 外部二进制，
 *   并通过 MCP stdio 协议与之通信。
 *   现已移除所有外部二进制相关逻辑，改为：
 *   - 索引功能委托给内置 ICodebaseGraphService（基于 tree-sitter WASM）
 *   - 团队共享仍通过 Git 推送到远程仓库
 *   - 索引配置持久化到 workspace storage
 *
 *   这样 Agent 系统通过 builtinToolProvider 暴露的内置 codebase 工具
 *   （search_graph / query_graph / get_architecture 等）直接调用
 *   ICodebaseGraphService，无需外部 MCP 服务器中转。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioLogService } from './agentStudioLogService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ICodebaseGraphService, IIndexConfig as IGraphIndexConfig } from './codebaseGraphService.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export const ICodebaseMemoryMcpService = createDecorator<ICodebaseMemoryMcpService>('ICodebaseMemoryMcpService');

export interface ICodebaseMemoryMcpService {
	readonly _serviceBrand: undefined;
	/** Fired with progress lines during indexing. */
	readonly onDidIndexProgress: Event<string>;
	/** Fired after indexing completes (success or failure). */
	readonly onDidIndexComplete: Event<IIndexResult>;
	/** Fired after a graph sync attempt (push to remote Git repo). */
	readonly onDidSyncGraph: Event<ISyncGraphResult>;
	/** Index the workspace repository (delegates to ICodebaseGraphService). */
	indexRepository(workspacePath?: string): Promise<IIndexResult>;
	/** Whether an indexing operation is currently in progress. */
	readonly isIndexing: boolean;
	/** Cancel an in-progress indexing operation. */
	cancelIndex(): void;
	/** Get saved index configuration (mode + exclude dirs). */
	getIndexConfig(): IIndexConfig;
	/** Save index configuration to workspace storage. */
	setIndexConfig(config: IIndexConfig): void;
	/** Write .cbmignore file with exclude patterns before indexing. */
	writeCbmIgnore(excludeDirs: string[], targetPath?: string): Promise<void>;
	/** Sync graph to remote Git repository for team sharing. */
	syncGraph(workspacePath?: string): Promise<ISyncGraphResult>;
	/** Get local graph status (exists, size, last modified, git info). */
	getGraphStatus(workspacePath?: string): Promise<IGraphStatus>;
	/** Pull graph from remote Git repository (team sharing). */
	pullGraph(workspacePath?: string): Promise<IPullGraphResult>;
}

/** Index mode controls how many files are indexed. */
export type IndexMode = 'full' | 'moderate' | 'fast';

/** Configuration for codebase indexing. */
export interface IIndexConfig {
	mode: IndexMode;
	excludeDirs: string[];
	/** 保留目录（即使父目录被排除也不跳过），相对路径如 "Content/Script" */
	keepDirs?: string[];
	/** Optional sub-directory path relative to workspace root (e.g. "src/vs/sessions"). Empty = index entire workspace. */
	subPath?: string;
}

export interface ISyncGraphResult {
	success: boolean;
	message: string;
	branch?: string;
	remote?: string;
}

export interface IGraphStatus {
	exists: boolean;
	graphPath?: string;
	size?: number;
	lastModified?: string;
	nodeCount?: number;
	edgeCount?: number;
	gitBranch?: string;
	gitCommit?: string;
	gitRemote?: string;
}

export interface IPullGraphResult {
	success: boolean;
	message: string;
	branch?: string;
}

export interface IIndexResult {
	success: boolean;
	message: string;
	duration?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const LOG_TAG = '[CodebaseMemory]';

/** Remote Git repository for team graph sharing. */
const GRAPH_SYNC_REMOTE = 'https://git.woa.com/zijianqiu/vssaros-codebase-memory.git';

// ─── Service Implementation ─────────────────────────────────────────────────

export class CodebaseMemoryMcpService extends Disposable implements ICodebaseMemoryMcpService {
	_serviceBrand: undefined;

	private readonly _onDidIndexProgress = this._register(new Emitter<string>());
	readonly onDidIndexProgress = this._onDidIndexProgress.event;

	private readonly _onDidIndexComplete = this._register(new Emitter<IIndexResult>());
	readonly onDidIndexComplete = this._onDidIndexComplete.event;

	private readonly _onDidSyncGraph = this._register(new Emitter<ISyncGraphResult>());
	readonly onDidSyncGraph = this._onDidSyncGraph.event;

	// 索引状态管理：防止重复索引 + 支持取消
	private _isIndexing = false;
	get isIndexing(): boolean { return this._isIndexing; }
	private _indexCts?: CancellationTokenSource;

	// 索引配置：持久化 mode + 排除目录
	private static readonly STORAGE_KEY_INDEX_CONFIG = 'codebaseMemory.indexConfig';
	private static readonly DEFAULT_EXCLUDE_DIRS = ['node_modules', '.git', 'build', 'out', 'dist', '.vscode-test', 'extensions', 'test', 'tests', 'resources', 'dev', 'docs', 'doc', 'scripts', '.worktrees', 'deploy-package', 'cli', 'Intermediate', 'Saved', 'Binaries', 'Build'];

	constructor(
		@IAgentStudioLogService private readonly logService: ILogService,
		@ICodebaseGraphService private readonly graphService: ICodebaseGraphService,
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		// 转发 graphService 的索引进度事件（统一出口）
		this._register(this.graphService.onDidIndexProgress(line => {
			this._onDidIndexProgress.fire(line);
		}));
		this._register(this.graphService.onDidIndexComplete(result => {
			// 映射 IGraphIndexResult → IIndexResult（结构兼容，仅取共同字段）
			const mapped: IIndexResult = {
				success: result.success,
				message: result.message,
				duration: result.duration,
			};
			this._isIndexing = false;
			this._onDidIndexComplete.fire(mapped);
		}));
	}

	// ─── Index Repository (delegates to ICodebaseGraphService) ────────────────

	async indexRepository(workspacePath?: string): Promise<IIndexResult> {
		// 0. 防止重复索引
		if (this._isIndexing) {
			const result: IIndexResult = { success: false, message: '索引正在进行中，请等待完成或取消后再试' };
			return result;
		}

		// 1. Resolve workspace path
		let wsPath = workspacePath;
		let baseWsUri: URI | undefined;
		if (!wsPath) {
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) {
				const result: IIndexResult = { success: false, message: 'No workspace folder open' };
				this._onDidIndexComplete.fire(result);
				return result;
			}
			baseWsUri = folders[0].uri;
			wsPath = baseWsUri.fsPath;
		}

		// 1b. 读取索引配置：如果配置了 subPath，只索引子目录（避免大型工作区全量索引导致内存爆炸）
		const indexConfig = this.getIndexConfig();
		this.logService.info(LOG_TAG, `Index config: mode=${indexConfig.mode}, subPath=${indexConfig.subPath || '(none)'}, excludeDirs=${indexConfig.excludeDirs.length} items`);
		if (indexConfig.subPath && indexConfig.subPath.trim() && baseWsUri) {
			const fullUri = URI.joinPath(baseWsUri, indexConfig.subPath.trim());
			wsPath = fullUri.fsPath;
		} else if (baseWsUri) {
			// subPath 为空时警告：大型工作区全量索引可能超时
			this._onDidIndexProgress.fire(`⚠ 未设置索引路径，将索引整个工作区。如索引超时，请在配置中设置"索引路径"（如 src/vs/sessions）`);
		}
		this.logService.info(LOG_TAG, `Repo path for indexing: ${wsPath}`);

		this._isIndexing = true;
		this._indexCts = new CancellationTokenSource();

		this.logService.info(LOG_TAG, `Starting indexWorkspace for "${wsPath}"...`);
		this._onDidIndexProgress.fire(`▶ 开始索引代码库: ${wsPath}`);

		const startTime = Date.now();

		try {
			// 2. 写入 .cbmignore 排除规则到索引目录
			if (indexConfig.excludeDirs.length > 0) {
				this._onDidIndexProgress.fire(`▶ 写入 .cbmignore (排除: ${indexConfig.excludeDirs.join(', ')})`);
				try {
					await this.writeCbmIgnore(indexConfig.excludeDirs, wsPath);
				} catch (e: any) {
					this.logService.warn(LOG_TAG, `Failed to write .cbmignore: ${e.message || e}`);
				}
			}

			this._onDidIndexProgress.fire(`▶ 调用内置 tree-sitter 索引 (mode: ${indexConfig.mode})...`);

			// 3. 委托给 ICodebaseGraphService.indexWorkspace()（基于 tree-sitter WASM，无外部二进制）
			const graphConfig: IGraphIndexConfig = {
				mode: indexConfig.mode,
				excludeDirs: indexConfig.excludeDirs,
				keepDirs: indexConfig.keepDirs,
				subPath: indexConfig.subPath,
			};

			const graphResult = await this.graphService.indexWorkspace(wsPath, graphConfig, this._indexCts.token);

			const duration = Math.round((Date.now() - startTime) / 1000);
			const result: IIndexResult = {
				success: graphResult.success,
				message: graphResult.message,
				duration,
			};
			this._onDidIndexProgress.fire(`✓ ${graphResult.message}`);
			this._onDidIndexComplete.fire(result);
			return result;

		} catch (err: any) {
			const duration = Math.round((Date.now() - startTime) / 1000);
			const isCancelled = this._indexCts?.token.isCancellationRequested;
			const msg = isCancelled
				? `索引已取消 (${duration}s)`
				: `索引失败: ${err.message || String(err)}`;
			this._onDidIndexProgress.fire(`✗ ${msg}`);
			this.logService.error(LOG_TAG, msg, err);
			const result: IIndexResult = { success: false, message: msg, duration };
			this._onDidIndexComplete.fire(result);
			return result;
		} finally {
			this._isIndexing = false;
			this._indexCts?.dispose();
			this._indexCts = undefined;
		}
	}

	/** 取消正在进行的索引操作 */
	cancelIndex(): void {
		if (this._isIndexing && this._indexCts) {
			this._onDidIndexProgress.fire(`▶ 正在取消索引...`);
			this._indexCts.cancel();
			this.graphService.cancelIndex();
		}
	}

	// ─── Index Configuration ──────────────────────────────────────────────

	getIndexConfig(): IIndexConfig {
		const stored = this.storageService.get(
			CodebaseMemoryMcpService.STORAGE_KEY_INDEX_CONFIG,
			StorageScope.WORKSPACE,
		);
		if (stored) {
			try {
				const parsed = JSON.parse(stored);
				const storedExcludes = Array.isArray(parsed.excludeDirs) ? parsed.excludeDirs : [];
				// Merge: 确保新增的默认排除目录（如 Intermediate/Saved/Binaries）出现在列表中
				const defaults = CodebaseMemoryMcpService.DEFAULT_EXCLUDE_DIRS;
				const merged = [...storedExcludes];
				for (const d of defaults) {
					if (!merged.some(m => m.toLowerCase() === d.toLowerCase())) {
						merged.push(d);
					}
				}
				return {
					mode: parsed.mode || 'fast',
					excludeDirs: merged,
					keepDirs: Array.isArray(parsed.keepDirs) ? parsed.keepDirs : undefined,
					subPath: typeof parsed.subPath === 'string' ? parsed.subPath : undefined,
				};
			} catch { /* fallthrough to default */ }
		}
		return { mode: 'fast', excludeDirs: CodebaseMemoryMcpService.DEFAULT_EXCLUDE_DIRS.slice() };
	}

	setIndexConfig(config: IIndexConfig): void {
		this.storageService.store(
			CodebaseMemoryMcpService.STORAGE_KEY_INDEX_CONFIG,
			JSON.stringify(config),
			StorageScope.WORKSPACE,
			StorageTarget.USER,
		);
	}

	async writeCbmIgnore(excludeDirs: string[], targetPath?: string): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }
		let baseUri = folders[0].uri;
		if (targetPath && targetPath !== folders[0].uri.fsPath) {
			baseUri = URI.file(targetPath);
		}
		const cbmIgnoreUri = URI.joinPath(baseUri, '.cbmignore');
		const lines = excludeDirs.map(d => d.trim()).filter(d => d);
		const content = lines.map(d => d.endsWith('/') ? d : `${d}/`).join('\n') + '\n';
		await this.fileService.writeFile(cbmIgnoreUri, VSBuffer.fromString(content));
	}

	// ─── Graph Status ─────────────────────────────────────────────────────

	async getGraphStatus(workspacePath?: string): Promise<IGraphStatus> {
		// 1. Resolve workspace path
		let wsPath = workspacePath;
		let baseWsUri: URI | undefined;
		if (!wsPath) {
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) {
				return { exists: false };
			}
			baseWsUri = folders[0].uri;
			wsPath = baseWsUri.fsPath;
		}

		// 1b. 读取索引配置：如果配置了 subPath，graph 文件在子目录的 .codebase-memory 中
		const indexConfig = this.getIndexConfig();
		let checkPath = wsPath;
		if (indexConfig.subPath && indexConfig.subPath.trim() && baseWsUri) {
			const fullUri = URI.joinPath(baseWsUri, indexConfig.subPath.trim());
			checkPath = fullUri.fsPath;
		}

		// 2. Check graph dir using IFileService (works in sandbox/renderer)
		//    当使用 subPath 时，graph 在 {subPath}/.codebase-memory；否则在 workspace 根目录
		const candidates = [
			URI.joinPath(URI.file(checkPath), '.codebase-memory'),
			URI.joinPath(URI.file(wsPath), '.sarosworkspace', '.codebase-memory'),
			URI.joinPath(URI.file(wsPath), '.codebase-memory'),
		];

		let graphDirUri: URI | undefined;
		for (const candidate of candidates) {
			try {
				if (await this.fileService.exists(candidate)) {
					graphDirUri = candidate;
					break;
				}
			} catch { /* ignore */ }
		}

		// 3. Get graph.db.zst stats (if dir exists)
		if (graphDirUri) {
			const graphFileUri = URI.joinPath(graphDirUri, 'graph.db.zst');
			let size: number | undefined;
			let lastModified: string | undefined;
			let graphPath: string | undefined;

			try {
				const stat = await this.fileService.stat(graphFileUri);
				if (stat) {
					graphPath = graphFileUri.fsPath;
					size = stat.size;
					lastModified = new Date(stat.mtime).toISOString();
				}
			} catch { /* file doesn't exist yet */ }

			// If graph.db.zst exists on disk, use it
			if (graphPath) {
				// 4. Get git info (only if child_process is available)
				let gitBranch: string | undefined;
				let gitCommit: string | undefined;
				let gitRemote: string | undefined;
				const graphDir = graphDirUri.fsPath;
				try { gitBranch = this._gitExec('rev-parse --abbrev-ref HEAD', graphDir); } catch { /* not a git repo */ }
				try { gitCommit = this._gitExec('rev-parse --short HEAD', graphDir); } catch { /* no commits */ }
				try { gitRemote = this._gitExec('remote get-url origin', graphDir); } catch { /* no remote */ }

				// 5. Get node/edge counts from ICodebaseGraphService if graph is loaded in memory
				let nodeCount: number | undefined;
				let edgeCount: number | undefined;
				try {
					if (this.graphService.hasGraphData()) {
						nodeCount = this.graphService.getTotalNodeCount();
						edgeCount = this.graphService.getTotalEdgeCount();
					}
				} catch { /* graph not loaded */ }

				return { exists: true, graphPath, size, lastModified, nodeCount, edgeCount, gitBranch, gitCommit, gitRemote };
			}
		}

		return { exists: false };
	}

	// ─── Graph Sync (Team Sharing) ────────────────────────────────────────────

	async syncGraph(workspacePath?: string): Promise<ISyncGraphResult> {
		// 1. Resolve workspace path
		let wsPath = workspacePath;
		if (!wsPath) {
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) {
				const result: ISyncGraphResult = { success: false, message: 'No workspace folder open' };
				this._onDidSyncGraph.fire(result);
				return result;
			}
			wsPath = folders[0].uri.fsPath;
		}

		// 2. Extract project name and graph dir
		const path = this._node('path');
		if (!path) {
			const result: ISyncGraphResult = { success: false, message: 'Node.js path module not available' };
			this._onDidSyncGraph.fire(result);
			return result;
		}
		const projectName = path.basename(wsPath);
		const graphDir = path.join(wsPath, '.codebase-memory');

		// 3. Check graph dir exists
		const fs = this._node('fs');
		if (!fs) {
			const result: ISyncGraphResult = { success: false, message: 'Node.js fs module not available' };
			this._onDidSyncGraph.fire(result);
			return result;
		}
		if (!fs.existsSync(graphDir)) {
			const result: ISyncGraphResult = {
				success: false,
				message: `Graph directory not found: ${graphDir}. Run indexRepository first.`,
			};
			this._onDidSyncGraph.fire(result);
			return result;
		}

		// 4. Run git sync
		try {
			this.logService.info(LOG_TAG, `Syncing graph for project "${projectName}"...`);

			this._gitExec('init', graphDir);

			// Set remote
			try {
				this._gitExec(`remote set-url origin ${GRAPH_SYNC_REMOTE}`, graphDir);
			} catch {
				this._gitExec(`remote add origin ${GRAPH_SYNC_REMOTE}`, graphDir);
			}

			// Create/switch to project branch
			try {
				this._gitExec(`checkout ${projectName}`, graphDir);
			} catch {
				try {
					this._gitExec(`checkout -b ${projectName} origin/${projectName}`, graphDir);
				} catch {
					this._gitExec(`checkout -b ${projectName}`, graphDir);
				}
			}

			// Stage + commit
			this._gitExec('add -A', graphDir);
			const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
			try {
				this._gitExec(`commit -m "Update graph: ${timestamp}"`, graphDir);
			} catch {
				// No changes to commit — that's ok
			}

			// Push
			try {
				this._gitExec(`push -u origin ${projectName}`, graphDir);
			} catch {
				// Try pull --rebase then push
				try {
					this._gitExec(`pull origin ${projectName} --rebase --no-edit`, graphDir);
					this._gitExec(`push -u origin ${projectName}`, graphDir);
				} catch (pullErr: any) {
					throw new Error(`Push failed: ${pullErr?.message || pullErr}`);
				}
			}

			const result: ISyncGraphResult = {
				success: true,
				message: `Graph synced to origin/${projectName}`,
				branch: projectName,
				remote: GRAPH_SYNC_REMOTE,
			};
			this.logService.info(LOG_TAG, `✓ ${result.message}`);
			this._onDidSyncGraph.fire(result);
			return result;
		} catch (err: any) {
			const result: ISyncGraphResult = {
				success: false,
				message: `Sync failed: ${err?.message || err}`,
			};
			this.logService.warn(LOG_TAG, result.message);
			this._onDidSyncGraph.fire(result);
			return result;
		}
	}

	/** Execute a git command synchronously in the given directory. */
	private _gitExec(args: string, cwd: string): string {
		const cp = this._node('child_process');
		if (!cp) { throw new Error('child_process not available'); }
		const cmd = `git ${args}`;
		this.logService.info(LOG_TAG, `$ ${cmd}`);
		try {
			return cp.execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
		} catch (err: any) {
			throw new Error(err.stderr?.trim() || err.message);
		}
	}

	async pullGraph(workspacePath?: string): Promise<IPullGraphResult> {
		// 1. Resolve workspace path
		let wsPath = workspacePath;
		if (!wsPath) {
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) {
				const result: IPullGraphResult = { success: false, message: 'No workspace folder open' };
				return result;
			}
			wsPath = folders[0].uri.fsPath;
		}

		// 2. Extract project name and graph dir
		const path = this._node('path');
		if (!path) {
			const result: IPullGraphResult = { success: false, message: 'Node.js path module not available' };
			return result;
		}
		const projectName = path.basename(wsPath);
		const graphDir = path.join(wsPath, '.codebase-memory');

		// 3. Check graph dir exists (create if not)
		const fs = this._node('fs');
		if (!fs) {
			const result: IPullGraphResult = { success: false, message: 'Node.js fs module not available' };
			return result;
		}
		if (!fs.existsSync(graphDir)) {
			fs.mkdirSync(graphDir, { recursive: true });
		}

		// 4. Run git pull
		try {
			this.logService.info(LOG_TAG, `Pulling graph for project "${projectName}"...`);

			// Init git repo if not already
			try {
				this._gitExec('status', graphDir);
			} catch {
				this._gitExec('init', graphDir);
			}

			// Set remote
			try {
				this._gitExec(`remote set-url origin ${GRAPH_SYNC_REMOTE}`, graphDir);
			} catch {
				this._gitExec(`remote add origin ${GRAPH_SYNC_REMOTE}`, graphDir);
			}

			// Fetch + checkout or reset
			this._gitExec(`fetch origin`, graphDir);
			try {
				this._gitExec(`checkout ${projectName}`, graphDir);
			} catch {
				this._gitExec(`checkout -b ${projectName} origin/${projectName}`, graphDir);
			}
			this._gitExec(`reset --hard origin/${projectName}`, graphDir);

			const result: IPullGraphResult = {
				success: true,
				message: `Graph pulled from origin/${projectName}`,
				branch: projectName,
			};
			this.logService.info(LOG_TAG, `✓ ${result.message}`);
			return result;
		} catch (err: any) {
			const result: IPullGraphResult = {
				success: false,
				message: `Pull failed: ${err?.message || err}`,
			};
			this.logService.warn(LOG_TAG, result.message);
			return result;
		}
	}

	// ─── Node.js Module Loader ───────────────────────────────────────────────

	private _node(name: string): any {
		try { return (globalThis as any).require?.(name); } catch { return undefined; }
	}
}
