/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase-Memory-MCP Bootstrap — 应用启动时自动检测、配置、启动。
 *
 * 如果二进制已安装：同步 ~/.saros/mcp.json → VS Code 配置 → 等待 MCP 服务重载 → 启动。
 * 如果未安装：日志提示，用户可在 EditorPane 中一键安装。
 *
 * Graph 存储路径重定向：
 *   codebase-memory-mcp 默认将 graph 存储在 {repo_path}/.codebase-memory/graph.db.zst
 *   本模块会在每个工作区创建 Junction：
 *     {workspace}/.codebase-memory → {workspace}/.sarosworkspace/.codebase-memory
 *   这样 graph 实际存储在 .sarosworkspace/.codebase-memory/ 中，与工作区数据统一管理。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IMcpService, IMcpServer, McpConnectionState } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { startServerAndWaitForLiveTools } from '../../../../workbench/contrib/mcp/common/mcpTypesUtils.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioLogService } from './agentStudioLogService.js';
import { timeout } from '../../../../base/common/async.js';
import { ICodebaseMemoryMcpService } from './codebaseMemoryMcpService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';

const LOG_TAG = '[CodebaseMemoryMcp]';
const SERVER_NAME = 'codebase-memory-mcp';

class CodebaseMemoryMcpBootstrapContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codebaseMemoryMcpBootstrap';

	constructor(
		@ICodebaseMemoryMcpService private readonly cbmService: ICodebaseMemoryMcpService,
		@IMcpService private readonly mcpService: IMcpService,
		@IAgentStudioLogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();

		// Listen for install/upgrade completion → auto-start server
		this._register(this.cbmService.onDidInstallComplete(() => {
			this.logService.info(LOG_TAG, 'Received onDidInstallComplete — starting server after delay...');
			// Wait for VS Code to process the config change before trying to start
			timeout(5000).then(() =>
				this._tryStartServer().catch(err =>
					this.logService.warn(LOG_TAG, 'Auto-start after install failed:', err))
			);
		}));

		this._bootstrap().catch(err => this.logService.error(LOG_TAG, 'Bootstrap failed:', err));
	}

	private async _bootstrap(): Promise<void> {
		// 0. Ensure .codebase-memory junction → .sarosworkspace/.codebase-memory
		//    This redirects graph storage into the workspace data directory.
		await this._ensureCodebaseMemoryJunction();

		// 1. Detect binary + sync ~/.saros/mcp.json → VS Code config
		await this.cbmService.ensureConfigured();

		// 1b. Check if binary is installed — skip server start if not
		const status = this.cbmService.getStatus();
		if (status.state === 'not_installed') {
			this.logService.info(LOG_TAG, 'Binary not installed yet. Open the Codebase Memory EditorPane to install.');
			return;
		}

		// 2. Wait for MCP service to reload config after sync (file watcher delay)
		this.logService.info(LOG_TAG, 'Config synced, waiting for MCP service to reload...');
		await timeout(5000);

		// 3. Try to start the server
		await this._tryStartServer();
	}

	/**
	 * For each workspace folder, create a junction/symlink:
	 *   {workspace}/.codebase-memory → {workspace}/.sarosworkspace/.codebase-memory
	 *
	 * This redirects codebase-memory-mcp's graph storage from the project root
	 * into the .sarosworkspace/ data directory, keeping the project root clean.
	 *
	 * - Windows: uses 'junction' type (no admin privileges required)
	 * - Unix: uses 'dir' symlink (may require elevated permissions)
	 */
	private async _ensureCodebaseMemoryJunction(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			this.logService.info(LOG_TAG, 'No workspace folder open, skipping junction creation.');
			return;
		}

		const isWindows = typeof process !== 'undefined' && process.platform === 'win32';

		for (const folder of folders) {
			const workspacePath = folder.uri.fsPath;
			const linkUri = URI.joinPath(URI.file(workspacePath), '.codebase-memory');
			const targetUri = URI.joinPath(URI.file(workspacePath), '.sarosworkspace', '.codebase-memory');

			try {
				// 1. Ensure .sarosworkspace/.codebase-memory/ directory exists
				try {
					await this.fileService.createFolder(targetUri);
					this.logService.info(LOG_TAG, `Ensured target directory: ${targetUri.fsPath}`);
				} catch {
					// Directory might already exist — that's fine
				}

				// 2. Check if .codebase-memory already exists
				const linkExists = await this.fileService.exists(linkUri);
				if (linkExists) {
					this.logService.info(LOG_TAG, `.codebase-memory already exists at ${linkUri.fsPath}, skipping junction creation.`);
					continue;
				}

				// 3. Create junction/symlink via hidden terminal (sandbox-safe)
				const command = isWindows
					? `mklink /J "${linkUri.fsPath}" "${targetUri.fsPath}"`
					: `ln -s "${targetUri.fsPath}" "${linkUri.fsPath}"`;

				try {
					const terminal = await this.terminalService.createTerminal({
						config: { name: 'CBM Junction Creator', hideFromUser: true } as any,
					});
					terminal.sendText(command, true);

					// Wait for the command to execute
					await timeout(3000);

					// Verify junction was created
					const created = await this.fileService.exists(linkUri);
					if (created) {
						this.logService.info(LOG_TAG, `Created junction: ${linkUri.fsPath} → ${targetUri.fsPath}`);
					} else {
						this.logService.info(LOG_TAG, `Junction creation may have failed. Graph will be stored in .codebase-memory directly.`);
					}

					// Dispose the hidden terminal
					terminal.dispose();
				} catch (err: any) {
					this.logService.info(LOG_TAG, `Could not create junction via terminal: ${err?.message || err}. Graph will be stored in .codebase-memory directly.`);
				}
			} catch (err) {
				this.logService.warn(LOG_TAG, `Failed to ensure junction for ${workspacePath}:`, err);
			}
		}
	}

	private async _tryStartServer(): Promise<void> {
		// Wait for MCP service to reload config after sync (file watcher delay)
		this.logService.info(LOG_TAG, 'Waiting for MCP service to discover the server...');
		await timeout(3000);

		const maxWaitMs = 30000;
		const startTime = Date.now();

		while (Date.now() - startTime < maxWaitMs) {
			const servers = this.mcpService.servers.get();
			const server = this._findServer(servers);
			if (server) {
				const connState = server.connectionState.get();
				this.logService.info(LOG_TAG,
					`Server discovered: ${server.definition.label}, state=${connState.state}`);

				// Already running — nothing to do
				if (connState.state === McpConnectionState.Kind.Running) {
					this.logService.info(LOG_TAG, 'Server already running.');
					return;
				}

				// Already starting — wait for it
				if (connState.state === McpConnectionState.Kind.Starting) {
					this.logService.info(LOG_TAG, 'Server is starting, waiting...');
					await timeout(10000);
					return;
				}

				// Error state — try stopping first, then restart
				if (connState.state === McpConnectionState.Kind.Error) {
					this.logService.info(LOG_TAG, 'Server in Error state, attempting stop + restart...');
					try {
						await (server as any).stop();
						this.logService.info(LOG_TAG, 'Server stopped, waiting before restart...');
					} catch (e: any) {
						this.logService.info(LOG_TAG, `Stop attempt: ${e?.message || e}`);
					}
					await timeout(3000);
				}

				// Start the server (with retry)
				for (let attempt = 1; attempt <= 2; attempt++) {
					try {
						this.logService.info(LOG_TAG, `Starting server (attempt ${attempt})...`);
						await Promise.race([
							startServerAndWaitForLiveTools(server, { promptType: 'all-untrusted', autoTrustChanges: true }),
							timeout(60000).then(() => { throw new Error('60s timeout'); }),
						]);
						this.logService.info(LOG_TAG, 'Server started successfully.');
						return;
					} catch (err) {
						this.logService.warn(LOG_TAG, `Server start attempt ${attempt} failed:`, err);
						if (attempt < 2) {
							this.logService.info(LOG_TAG, 'Retrying in 5 seconds...');
							try { await (server as any).stop(); } catch { /* ignore */ }
							await timeout(5000);
						}
					}
				}
				this.logService.info(LOG_TAG, 'Server can be started manually from the MCP tab.');
				return;
			}
			await timeout(500);
		}
		this.logService.warn(LOG_TAG, 'Server not discovered within 30s. Will auto-start when MCP tab is opened.');
	}

	private _findServer(servers: readonly IMcpServer[]): IMcpServer | undefined {
		const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
		const target = sanitize(SERVER_NAME);
		return servers.find(s => {
			const id = sanitize(s.definition.id);
			const label = sanitize(s.definition.label);
			return id === target || label === target ||
				id.includes('codebase_memory_mcp') || label.includes('codebase_memory_mcp');
		});
	}
}

registerWorkbenchContribution2(
	CodebaseMemoryMcpBootstrapContribution.ID,
	CodebaseMemoryMcpBootstrapContribution,
	WorkbenchPhase.AfterRestored,
);
