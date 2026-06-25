/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase-Memory-MCP Service — 检测、安装、升级、配置 MCP 服务器。
 *
 * 安装方式：从 GitHub 下载 install.sh/install.ps1 脚本并执行，
 * 脚本自动下载预编译二进制到系统路径。
 * 安装完成后自动配置 MCP 服务器到用户级配置。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchMcpManagementService } from '../../../../workbench/services/mcp/common/mcpWorkbenchManagementService.js';
import { IMcpService } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { IInstallableMcpServer } from '../../../../platform/mcp/common/mcpManagement.js';
import { McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CodebaseMemoryState = 'not_installed' | 'installing' | 'installed' | 'running';

export interface ICodebaseMemoryMcpStatus {
	state: CodebaseMemoryState;
	binaryPath?: string;
	version?: string;
	latestVersion?: string;
	mcpConfigured: boolean;
	mcpRunning: boolean;
	installLog: string[];
}

export const ICodebaseMemoryMcpService = createDecorator<ICodebaseMemoryMcpService>('ICodebaseMemoryMcpService');

export interface ICodebaseMemoryMcpService {
	readonly _serviceBrand: undefined;
	readonly onDidStatusChange: Event<ICodebaseMemoryMcpStatus>;
	readonly onDidInstallLog: Event<string>;
	/** Fired after a successful install/upgrade, so bootstrap can auto-start the server. */
	readonly onDidInstallComplete: Event<void>;
	/** Fired after a graph sync attempt (push to remote Git repo). */
	readonly onDidSyncGraph: Event<ISyncGraphResult>;
	getStatus(): ICodebaseMemoryMcpStatus;
	refreshStatus(): Promise<void>;
	/** Detect binary, configure MCP if found (no download). For bootstrap use. */
	ensureConfigured(): Promise<boolean>;
	install(): Promise<void>;
	upgrade(): Promise<void>;
	openEditor(): Promise<void>;
	/** Sync graph to remote Git repository for team sharing. */
	syncGraph(workspacePath?: string): Promise<ISyncGraphResult>;
}

export interface ISyncGraphResult {
	success: boolean;
	message: string;
	branch?: string;
	remote?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SERVER_NAME = 'codebase-memory-mcp';
const LOG_TAG = '[CodebaseMemoryMcp]';
const GITHUB_LATEST_API = 'https://api.github.com/repos/DeusData/codebase-memory-mcp/releases/latest';
const INSTALL_SCRIPT_WIN = 'https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1';
const INSTALL_SCRIPT_UNIX = 'https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh';

/** Remote Git repository for team graph sharing. */
const GRAPH_SYNC_REMOTE = 'https://git.woa.com/zijianqiu/vssaros-codebase-memory.git';

// ─── Service Implementation ─────────────────────────────────────────────────

export class CodebaseMemoryMcpService extends Disposable implements ICodebaseMemoryMcpService {
	_serviceBrand: undefined;

	private readonly _onDidStatusChange = this._register(new Emitter<ICodebaseMemoryMcpStatus>());
	readonly onDidStatusChange = this._onDidStatusChange.event;

	private readonly _onDidInstallLog = this._register(new Emitter<string>());
	readonly onDidInstallLog = this._onDidInstallLog.event;

	private readonly _onDidInstallComplete = this._register(new Emitter<void>());
	readonly onDidInstallComplete = this._onDidInstallComplete.event;

	private readonly _onDidSyncGraph = this._register(new Emitter<ISyncGraphResult>());
	readonly onDidSyncGraph = this._onDidSyncGraph.event;

	private _status: ICodebaseMemoryMcpStatus = {
		state: 'not_installed',
		mcpConfigured: false,
		mcpRunning: false,
		installLog: [],
	};

	constructor(
		@ILogService private readonly logService: ILogService,
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@IMcpService private readonly mcpService: IMcpService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IStorageService private readonly storageService: IStorageService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	getStatus(): ICodebaseMemoryMcpStatus {
		return { ...this._status, installLog: [...this._status.installLog] };
	}

	private _setStatus(patch: Partial<ICodebaseMemoryMcpStatus>): void {
		this._status = { ...this._status, ...patch };
		this._onDidStatusChange.fire(this.getStatus());
	}

	private _log(line: string): void {
		this._status.installLog.push(line);
		this._onDidInstallLog.fire(line);
		this.logService.info(LOG_TAG, line);
	}

	/** Refresh status: detect binary, version, MCP config, running state. */
	async refreshStatus(): Promise<void> {
		const binaryPath = await this._detectBinary();
		const version = binaryPath ? this._detectVersion(binaryPath) : undefined;
		const latestVersion = await this._fetchLatestVersion().catch(() => undefined);

		let mcpConfigured = false;
		try {
			const installed = await this.mcpManagementService.getInstalled();
			mcpConfigured = installed.some(s => s.name === SERVER_NAME);
		} catch { /* ignore */ }
		// Also check ~/.saros/mcp.json
		if (!mcpConfigured) {
			const sarosConfig = await this._readSarosMcpConfig();
			mcpConfigured = !!sarosConfig?.servers?.[SERVER_NAME];
		}

		const mcpRunning = this._isMcpRunning();

		const state: CodebaseMemoryState = mcpRunning ? 'running' : (binaryPath ? 'installed' : 'not_installed');
		this._setStatus({ state, binaryPath, version, latestVersion, mcpConfigured, mcpRunning });
	}

	/** Detect binary, sync ~/.saros/mcp.json → VS Code config. For bootstrap use. */
	async ensureConfigured(): Promise<boolean> {
		// 1. Ensure ~/.saros/mcp.json exists with default codebase-memory-mcp entry
		await this._ensureSarosMcpConfig();

		// 2. ALWAYS update config with thirdparty path (regardless of binary detection)
		//    This ensures the config always points to <appRoot>/resources/thirdparty/.../codebase-memory-mcp.exe
		//    even before the binary is installed there. Old configs with system paths are overwritten.
		const thirdpartyPath = this._getThirdpartyBinaryPath();
		await this._updateSarosMcpConfig(SERVER_NAME, {
			type: McpServerType.LOCAL,
			command: thirdpartyPath,
		});
		this.logService.info(LOG_TAG, 'Config updated to thirdparty path:', thirdpartyPath);

		// 3. Sync all servers from ~/.saros/mcp.json to VS Code user config
		await this._syncToVsCodeConfig();

		// 4. Clear disabled state (server may have been disabled by a previous failed auto-start)
		this._clearDisabledState();

		// 5. Refresh status
		await this.refreshStatus();
		return this._status.mcpConfigured;
	}

	/** Clear disabled state for codebase-memory-mcp (stored by IntegrationView). */
	private _clearDisabledState(): void {
		const STORAGE_KEY = 'agentStudio.mcpDisabledServers';
		const idsToClear = ['codebase_memory_mcp', 'mcp_config_usrlocal_codebase_memory_mcp'];
		try {
			const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE, '[]');
			if (!raw) { return; }
			const arr: string[] = JSON.parse(raw);
			const filtered = arr.filter((id: string) => !idsToClear.includes(id));
			if (filtered.length !== arr.length) {
				this.storageService.store(STORAGE_KEY, JSON.stringify(filtered), StorageScope.WORKSPACE, StorageTarget.USER);
				this.logService.info(LOG_TAG, 'Cleared disabled state for codebase-memory-mcp.');
			}
		} catch { /* ignore parse errors */ }
	}

	/** Install: download + execute install script, then configure MCP. */
	async install(): Promise<void> {
		if (this._status.state === 'installing') { return; }
		this._setStatus({ state: 'installing' });
		this._log('▶ 开始安装 codebase-memory-mcp...');

		try {
			await this._runInstallScript();
			this._log('✓ 安装脚本执行完成');

			// Detect the newly installed binary
			const binaryPath = await this._detectBinary();
			if (!binaryPath) {
				this._log('⚠ 未能检测到已安装的二进制文件，可能需要重启或手动添加 PATH');
				this._setStatus({ state: 'not_installed' });
				return;
			}
			this._log(`✓ 检测到二进制: ${binaryPath}`);

			// Configure MCP: write to ~/.saros/mcp.json + sync to VS Code
			await this._updateSarosMcpConfig(SERVER_NAME, {
				type: McpServerType.LOCAL,
				command: binaryPath,
			});
			await this._syncToVsCodeConfig();
			this._log('✓ MCP 配置已写入 ~/.saros/mcp.json 并同步到 VS Code');

			// Refresh full status
			await this.refreshStatus();
			this._log('✓ 安装完成！');

			// Notify bootstrap to auto-start the server
			this._onDidInstallComplete.fire();
			this.logService.info(LOG_TAG, 'Fired onDidInstallComplete — bootstrap will auto-start the server.');
		} catch (err) {
			this._log(`✗ 安装失败: ${err}`);
			this._setStatus({ state: 'not_installed' });
		}
	}

	/** Upgrade: same as install (install script overwrites existing binary). */
	async upgrade(): Promise<void> {
		this._log('▶ 开始升级 codebase-memory-mcp...');
		await this.install();
	}

	async openEditor(): Promise<void> {
		// Implemented in EditorPane registration — this is a placeholder
		// The EditorPane is opened via IEditorService from the contribution layer
	}

	// ─── Binary Detection ────────────────────────────────────────────────────

	/** Get the thirdparty base directory: <appRoot>/resources/thirdparty/ */
	private _getThirdpartyDir(): string {
		const appRoot = this.environmentService.appRoot;
		const sep = this._isWindows() ? '\\' : '/';
		return `${appRoot}${sep}resources${sep}thirdparty`;
	}

	/** Get the tool-specific directory: <thirdparty>/<toolName>/ */
	private _getToolDir(): string {
		const sep = this._isWindows() ? '\\' : '/';
		return `${this._getThirdpartyDir()}${sep}${SERVER_NAME}`;
	}

	/** Get the binary path: <thirdparty>/<toolName>/codebase-memory-mcp[.exe] */
	private _getThirdpartyBinaryPath(): string {
		const sep = this._isWindows() ? '\\' : '/';
		const ext = this._isWindows() ? '.exe' : '';
		return `${this._getToolDir()}${sep}${SERVER_NAME}${ext}`;
	}

	/** Detect if running on Windows (navigator.userAgent is always available in renderer). */
	private _isWindows(): boolean {
		// Check process.platform (Node.js global, available in Electron renderer)
		if (typeof process !== 'undefined' && process.platform === 'win32') { return true; }
		// Check navigator.platform (most reliable in Electron: "Win32" on Windows)
		if (typeof navigator !== 'undefined' && typeof navigator.platform === 'string' && navigator.platform.startsWith('Win')) { return true; }
		// Check navigator.userAgent (fallback)
		if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' && navigator.userAgent.includes('Win')) { return true; }
		return false;
	}

	private async _detectBinary(): Promise<string | undefined> {
		const candidates: string[] = [];

		// Only check thirdparty directory: <appRoot>/resources/thirdparty/<toolName>/<toolName>[.exe]
		const thirdpartyPath = this._getThirdpartyBinaryPath();
		candidates.push(thirdpartyPath);

		// Check candidate paths via IFileService
		for (const c of candidates) {
			try {
				const uri = URI.file(c);
				if (await this.fileService.exists(uri)) {
					this.logService.info(LOG_TAG, `Binary found at: ${c}`);
					return c;
				}
			} catch { /* ignore */ }
		}

		this.logService.info(LOG_TAG, `Binary not found at: ${candidates.join(', ')}`);
		return undefined;
	}

	private _detectVersion(binaryPath: string): string | undefined {
		const cp = this._node('child_process');
		if (!cp) { return undefined; }
		try {
			return cp.execSync(`"${binaryPath}" --version`, { encoding: 'utf-8', timeout: 3000 }).trim();
		} catch { return undefined; }
	}

	// ─── Install Script Execution (via Terminal) ─────────────────────────────

	private async _runInstallScript(): Promise<void> {
		const isWin = this._isWindows();

		// Diagnostic: log platform detection details
		const procPlatform = (typeof process !== 'undefined' && process.platform) || 'undefined';
		const navPlatform = (typeof navigator !== 'undefined' && navigator.platform) || 'undefined';
		const navUA = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent.substring(0, 60) : 'undefined';
		this._log(`▶ 平台检测: isWin=${isWin}, process.platform=${procPlatform}, navigator.platform=${navPlatform}`);
		this.logService.info(LOG_TAG, `Platform: process=${procPlatform}, nav.platform=${navPlatform}, nav.ua=${navUA}...`);

		const toolDir = this._getToolDir();

		// Ensure the tool directory exists: <appRoot>/resources/thirdparty/<toolName>/
		try {
			await this.fileService.createFolder(URI.file(toolDir));
			this._log(`📁 已创建目录: ${toolDir}`);
		} catch { /* might already exist */ }

		const command = isWin
			? `powershell -ExecutionPolicy Bypass -Command "iwr -Uri '${INSTALL_SCRIPT_WIN}' -OutFile $env:TEMP\\cbm-install.ps1; & $env:TEMP\\cbm-install.ps1 --skip-config --dir='${toolDir}'"`
			: `curl -fsSL '${INSTALL_SCRIPT_UNIX}' | bash -s -- --skip-config --dir='${toolDir}'`;

		this._log(`▶ 执行安装命令 (${isWin ? 'Windows PowerShell' : 'Unix bash'})...`);
		this._log(`$ ${command}`);

		// Create a terminal and run the install command
		const terminal = await this.terminalService.createAndFocusTerminal({
			config: { name: 'Codebase Memory MCP Installer' } as any,
		});
		terminal.sendText(command, true);
		this._log('📋 安装脚本已在终端中启动，请在终端中查看详细输出...');

		// Wait for the install to complete by polling for the binary
		const maxWaitMs = 300000; // 5 min
		const pollIntervalMs = 3000;
		const startTime = Date.now();
		let pollCount = 0;

		while (Date.now() - startTime < maxWaitMs) {
			await new Promise(r => setTimeout(r, pollIntervalMs));
			pollCount++;
			const binaryPath = await this._detectBinary();
			if (binaryPath) {
				this._log(`✓ 安装完成！检测到二进制: ${binaryPath}`);
				return;
			}
			// Show progress every 10s
			if (pollCount % 3 === 0) {
				const elapsed = Math.floor((Date.now() - startTime) / 1000);
				this._log(`⏳ 等待安装完成... (${elapsed}s)`);
			}
		}
		this._log('⚠ 安装超时（5分钟），请检查终端输出确认安装状态');
	}

	// ─── ~/.saros/mcp.json Config Management ──────────────────────────────────

	/** Get ~/.saros/mcp.json URI. */
	private async _getSarosMcpConfigUri(): Promise<URI> {
		const userHome = await this.pathService.userHome();
		return URI.joinPath(userHome, '.saros', 'mcp.json');
	}

	/** Ensure ~/.saros/mcp.json exists, create with default codebase-memory-mcp if not. */
	private async _ensureSarosMcpConfig(): Promise<void> {
		const configUri = await this._getSarosMcpConfigUri();
		try {
			const exists = await this.fileService.exists(configUri);
			if (exists) { return; }
		} catch { /* ignore */ }

		const defaultConfig = {
			servers: {
				[SERVER_NAME]: {
					type: 'stdio',
					command: this._getThirdpartyBinaryPath(),
				},
			},
		};
		const dirUri = URI.joinPath(configUri, '..');
		try { await this.fileService.createFolder(dirUri); } catch { /* might already exist */ }
		await this.fileService.writeFile(configUri, VSBuffer.fromString(JSON.stringify(defaultConfig, null, 2)));
		this.logService.info(LOG_TAG, 'Created ~/.saros/mcp.json with default config.');
	}

	/** Read and parse ~/.saros/mcp.json. Returns undefined on error. */
	private async _readSarosMcpConfig(): Promise<{ servers: Record<string, any> } | undefined> {
		const configUri = await this._getSarosMcpConfigUri();
		try {
			const content = await this.fileService.readFile(configUri);
			return JSON.parse(content.value.toString());
		} catch (e) {
			this.logService.warn(LOG_TAG, 'Failed to read ~/.saros/mcp.json:', e);
			return undefined;
		}
	}

	/** Update a single server entry in ~/.saros/mcp.json. */
	private async _updateSarosMcpConfig(name: string, config: any): Promise<void> {
		const data = await this._readSarosMcpConfig() ?? { servers: {} };
		data.servers = data.servers ?? {};
		data.servers[name] = config;
		const configUri = await this._getSarosMcpConfigUri();
		await this.fileService.writeFile(configUri, VSBuffer.fromString(JSON.stringify(data, null, 2)));
	}

	/** Sync all servers from ~/.saros/mcp.json to VS Code user config.
	 * Always reinstalls to ensure command paths are up-to-date (e.g. PATH → full path). */
	private async _syncToVsCodeConfig(): Promise<void> {
		const data = await this._readSarosMcpConfig();
		if (!data?.servers) { return; }

		for (const [name, config] of Object.entries(data.servers)) {
			try {
				const installable: IInstallableMcpServer = {
					name,
					config: config as any,
				};
				await this.mcpManagementService.install(installable, { target: ConfigurationTarget.USER });
				this.logService.info(LOG_TAG, `Synced "${name}" to VS Code user config (command: ${(config as any)?.command}).`);
			} catch (e) {
				this.logService.warn(LOG_TAG, `Failed to sync "${name}":`, e);
			}
		}
	}

	// ─── MCP Running Check ───────────────────────────────────────────────────

	private _isMcpRunning(): boolean {
		const servers = this.mcpService.servers.get();
		const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
		const target = sanitize(SERVER_NAME);
		return servers.some(s => {
			const id = sanitize(s.definition.id);
			const label = sanitize(s.definition.label);
			return (id === target || label === target) &&
				s.connectionState.get().state === 2 /* McpConnectionState.Kind.Running */;
		});
	}

	// ─── GitHub Latest Version ───────────────────────────────────────────────

	private async _fetchLatestVersion(): Promise<string | undefined> {
		// Use fetch (available in Electron renderer) to check GitHub releases
		try {
			const resp = await fetch(GITHUB_LATEST_API, {
				headers: {
					'Accept': 'application/vnd.github.v3+json',
					'User-Agent': 'VsSaros-CodebaseMemoryMcp', // GitHub API requires User-Agent
				},
				signal: AbortSignal.timeout(5000),
			});
			if (!resp.ok) { return undefined; }
			const json = await resp.json() as { tag_name?: string };
			return json.tag_name;
		} catch { return undefined; }
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
		const graphDir = path.join(wsPath, '.sarosworkspace', '.codebase-memory');

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
				message: `Graph directory not found: ${graphDir}. Run index_repository first.`,
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

	// ─── Node.js Module Loader ───────────────────────────────────────────────

	private _node(name: string): any {
		try { return (globalThis as any).require?.(name); } catch { return undefined; }
	}
}
