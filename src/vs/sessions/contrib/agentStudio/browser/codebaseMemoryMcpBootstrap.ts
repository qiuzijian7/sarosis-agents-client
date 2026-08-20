/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Memory Bootstrap — 应用启动时自动加载/索引代码图谱。
 *
 * 设计变更（2026-07-03）：
 *   原本此模块负责：
 *   1. 创建 .codebase-memory → .sarosworkspace/.codebase-memory junction
 *   2. 检测 codebase-memory-mcp.exe 二进制
 *   3. 同步 ~/.vssaros/mcp.json → VS Code 配置
 *   4. 启动 MCP 服务器
 *   5. 自动索引工作区到 MCP 服务器内存数据库
 *
 *   现已移除所有外部二进制相关逻辑（1-4），改为：
 *   - 触发 ICodebaseMemoryMcpService.indexRepository()
 *   - 该方法委托给内置 ICodebaseGraphService（tree-sitter WASM）
 *   - 无需外部 MCP 服务器，Agent 通过 builtinToolProvider 暴露的
 *     内置 codebase 工具（search_graph / query_graph 等）直接查询
 *
 *   图谱文件仍存储在 {workspace}/.codebase-memory/graph.db.zst，
 *   团队共享仍通过 syncGraph/pullGraph（Git 推送）。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioLogService } from './agentStudioLogService.js';
import { ICodebaseMemoryMcpService } from './codebaseMemoryMcpService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkbenchMcpManagementService } from '../../../../workbench/services/mcp/common/mcpWorkbenchManagementService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../common/sarosPaths.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';

const LOG_TAG = '[CodebaseMemory]';
const SERVER_NAME = 'codebase-memory-mcp';

class CodebaseMemoryMcpBootstrapContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codebaseMemoryMcpBootstrap';

	/** 一次性标记：是否已完成残留 MCP 配置清理 */
	private static readonly STORAGE_KEY_CLEANUP = 'codebaseMemory.legacyMcpConfigCleaned';

	constructor(
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ICodebaseMemoryMcpService private readonly cbmService: ICodebaseMemoryMcpService,
		@IAgentStudioLogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
			@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this._bootstrap().catch(err => this.logService.error(LOG_TAG, 'Bootstrap failed:', err));
	}

	private async _bootstrap(): Promise<void> {
		// [TRACE] codebaseMemoryMcpBootstrap._bootstrap 入口
		this.logService.info(LOG_TAG, `[TRACE] codebaseMemoryMcpBootstrap._bootstrap triggered`);
		// 0. 一次性清理：移除 ~/.vssaros/mcp.json 和 VS Code 用户配置中
		//    残留的 codebase-memory-mcp 外部 MCP 服务器条目
		await this._cleanupLegacyMcpConfig();

		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			this.logService.info(LOG_TAG, 'No workspace folder open, skipping.');
			return;
		}

		// Check if graph.db.zst exists for the first workspace folder.
		// If not, auto-index via the built-in ICodebaseGraphService (delegated through cbmService).
		const wsUri = folders[0].uri;
		const indexConfig = this.cbmService.getIndexConfig();

		// 当配置了 subPath 时，graph 在 {subPath}/.codebase-memory；否则在 workspace 根目录
		let checkBaseUri = wsUri;
		if (indexConfig.subPath && indexConfig.subPath.trim()) {
			checkBaseUri = URI.joinPath(wsUri, indexConfig.subPath.trim());
		}

		const graphFileUri = URI.joinPath(checkBaseUri, '.codebase-memory', 'graph.db.zst');

		let graphExists = false;
		try {
			graphExists = await this.fileService.exists(graphFileUri);
		} catch { /* ignore */ }

		if (graphExists) {
			this.logService.info(LOG_TAG, `Existing graph found at ${graphFileUri.fsPath}, skipping auto-index.`);
			return;
		}

		// 2026-08-19：从文件夹添加工作区（根目录无 .code-workspace 文件）时禁用自动索引，
		// 改由 LLM 在 codebase 工具触发时询问用户后手动发起（见 codebaseTools.noGraphGuidance）。
		if (!await this._hasCodeWorkspaceFile()) {
			this.logService.info(LOG_TAG, 'No .code-workspace file detected — skipping auto-index (defer to manual/LLM-triggered indexing).');
			return;
		}

		// No existing graph — auto-index
		this.logService.info(LOG_TAG, 'No existing graph found, starting auto-index via built-in tree-sitter...');
		try {
			const result = await this.cbmService.indexRepository(folders[0].uri.fsPath);
			if (result.success) {
				this.logService.info(LOG_TAG, `Auto-index completed: ${result.message}`);
			} else {
				this.logService.warn(LOG_TAG, `Auto-index failed: ${result.message}`);
			}
		} catch (err: any) {
			this.logService.warn(LOG_TAG, `Auto-index error: ${err?.message || err}`);
		}
	}

	/**
	 * 一次性清理：移除旧版外部 codebase-memory-mcp.exe 的 MCP 配置残留。
	 *
	 * 清理范围：
	 *   1. ~/.vssaros/mcp.json 中的 codebase-memory-mcp 条目
	 *   2. VS Code 用户级 MCP 配置中安装的 codebase-memory-mcp
	 *
	 * 仅在首次执行（storage 标记未设置）时运行，后续启动跳过。
	 */
	private async _cleanupLegacyMcpConfig(): Promise<void> {
		try {
			const alreadyCleaned = this.storageService.getBoolean(
				CodebaseMemoryMcpBootstrapContribution.STORAGE_KEY_CLEANUP,
				StorageScope.APPLICATION,
				false,
			);
			if (alreadyCleaned) { return; }

			this.logService.info(LOG_TAG, 'Cleaning up legacy codebase-memory-mcp MCP config...');

			// 1. 清理 ~/.vssaros/mcp.json
			const sarosConfigUri = resolveSarosPath(this._getSarosRoot(), SarosPath.mcpConfig);
			try {
				const exists = await this.fileService.exists(sarosConfigUri);
				if (exists) {
					const raw = await this.fileService.readFile(sarosConfigUri);
					const data = JSON.parse(raw.value.toString());
					if (data?.servers?.[SERVER_NAME]) {
						delete data.servers[SERVER_NAME];
						await this.fileService.writeFile(sarosConfigUri, VSBuffer.fromString(JSON.stringify(data, null, 2)));
						this.logService.info(LOG_TAG, `Removed "${SERVER_NAME}" from ~/.vssaros/mcp.json`);
					}
				}
			} catch (e: any) {
				this.logService.warn(LOG_TAG, `Failed to clean ~/.vssaros/mcp.json: ${e?.message || e}`);
			}

			// 2. 清理 VS Code 用户级 MCP 配置
			try {
				const installed = await this.mcpManagementService.getInstalled();
				const legacy = installed.find(s => s.name === SERVER_NAME);
				if (legacy) {
					await this.mcpManagementService.uninstall(legacy as any);
					this.logService.info(LOG_TAG, `Uninstalled "${SERVER_NAME}" from VS Code MCP config.`);
				}
			} catch (e: any) {
				this.logService.warn(LOG_TAG, `Failed to uninstall from VS Code MCP config: ${e?.message || e}`);
			}

			// 标记清理完成
			this.storageService.store(
				CodebaseMemoryMcpBootstrapContribution.STORAGE_KEY_CLEANUP,
				true,
				StorageScope.APPLICATION,
				StorageTarget.MACHINE,
			);
			this.logService.info(LOG_TAG, 'Legacy MCP config cleanup completed.');
		} catch (err: any) {
			this.logService.warn(LOG_TAG, `Legacy config cleanup error: ${err?.message || err}`);
		}
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}

	/** 判定工作区是否由 .code-workspace 文件打开（区别于「从文件夹添加」）。 */
	private async _hasCodeWorkspaceFile(): Promise<boolean> {
		try {
			const folders = this.workspaceContextService.getWorkspace().folders;
			for (const f of folders) {
				try {
					const rootStat = await this.fileService.resolve(f.uri);
					if (!rootStat?.children) { continue; }
					const has = rootStat.children.some(c =>
						!c.isDirectory && (c.name ?? '').toLowerCase().endsWith('.code-workspace'));
					if (has) { return true; }
				} catch { /* 单个 folder 不可读，跳过 */ }
			}
		} catch { /* ignore */ }
		return false;
	}
}

registerWorkbenchContribution2(
	CodebaseMemoryMcpBootstrapContribution.ID,
	CodebaseMemoryMcpBootstrapContribution,
	WorkbenchPhase.AfterRestored,
);
