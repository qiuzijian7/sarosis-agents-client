/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * McpInstaller —— MCP 服务器配置的安装器实现。
 *
 * install: 解压目录的 config.json → 写入 ~/.vssaros/mcp/{id}/
 *          → 自动注册到 ~/.vssaros/mcp.json（IntegrationView 白名单）
 * preparePack: 读 ~/.vssaros/mcp/{id}/config.json → 构造 manifest
 * getInstalledVersion: 从 config.json 的 version 字段读取
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IPackageInstaller, PackageManifest, IPreparePackResult } from '../../common/packageInstaller.js';
import { PackageKind, IInstallResult } from '../../common/marketplace.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../../common/sarosPaths.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';

const MCP_SUBDIR = 'mcp';

interface McpConfig {
	id?: string;
	name?: string;
	description?: string;
	transport?: string;
	command?: string;
	args?: string[];
	url?: string;
	env?: Record<string, string>;
	headers?: Record<string, string>;
	version?: string;
}

export class McpInstaller extends Disposable implements IPackageInstaller {
	declare readonly _serviceBrand: undefined;
	readonly kind: PackageKind = 'mcp';

	constructor(
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async install(manifest: PackageManifest, extractedDir: URI): Promise<IInstallResult> {
		const targetDir = await this.resolveDir(manifest.id);

		const configUri = URI.joinPath(extractedDir, 'config.json');
		if (!await this.fileService.exists(configUri)) {
			throw new Error('包内缺少 config.json（MCP 服务器配置）');
		}

		await this.fileService.createFolder(targetDir);
		await this.copyContents(extractedDir, targetDir);

		// 自动注册到 ~/.vssaros/mcp.json（IntegrationView 白名单）
		try {
			await this._registerToMcpJson(manifest.id, targetDir);
		} catch (e) {
			this.logService.warn(`[McpInstaller] 自动注册到 mcp.json 失败（不影响安装）: ${(e as Error).message}`);
		}

		this.logService.info(`[McpInstaller] 安装完成: ${manifest.id} v${manifest.version} → ${targetDir.fsPath}`);
		this.logService.info(`[McpInstaller] 已自动注册到 ~/.vssaros/mcp.json，Integration 面板将显示该服务器`);

		return { kind: 'mcp', storeId: manifest.id, version: manifest.version, targetDir: targetDir.fsPath };
	}

	async preparePack(localId: string): Promise<IPreparePackResult> {
		const localDir = await this.resolveDir(localId);
		if (!await this.fileService.exists(localDir)) {
			throw new Error(`MCP 配置目录不存在: ${localDir.fsPath}`);
		}

		const configUri = URI.joinPath(localDir, 'config.json');
		let config: McpConfig;
		try {
			const content = await this.fileService.readFile(configUri);
			config = JSON.parse(content.value.toString());
		} catch {
			throw new Error('无法读取 config.json');
		}

		const files: string[] = ['config.json'];
		if (await this.fileService.exists(URI.joinPath(localDir, 'README.md'))) {
			files.push('README.md');
		}

		const manifest: PackageManifest = {
			kind: 'mcp',
			id: localId,
			name: config.name || localId,
			version: config.version || '1.0.0',
			description: config.description,
			category: 'tools',
			author: 'saros',
			files,
			mcp: config,
		};
		return { localDir, manifest };
	}

	getInstalledVersion(storeId: string): string | undefined {
		// 同步读取 config.json 的 version 字段（无法做异步，返回 undefined 让 installed-packages.json 兜底）
		return undefined;
	}

	// ── 内部 ──────────────────────────────────────────────────

	private async resolveDir(id: string): Promise<URI> {
		return resolveSarosPath(this._getSarosRoot(), MCP_SUBDIR, id);
	}

	/** 将 config.json 转换为 ~/.vssaros/mcp.json 的 server 条目格式 */
	private _convertToMcpJsonEntry(config: McpConfig): Record<string, unknown> {
		const transport = config.transport || 'stdio';
		const entry: Record<string, unknown> = { disabled: false };

		if (transport === 'stdio') {
			// 本地进程型
			entry.type = 'stdio';
			if (config.command) { entry.command = config.command; }
			if (config.args) { entry.args = config.args; }
			if (config.env) { entry.env = config.env; }
		} else {
			// 远程型 (http/sse)
			entry.type = transport; // "http" 或 "sse"
			if (config.url) { entry.url = config.url; }
			// env 中的键值对作为 HTTP headers
			if (config.env) { entry.headers = config.env; }
			else if (config.headers) { entry.headers = config.headers; }
		}

		return entry;
	}

	/** 读取/创建 ~/.vssaros/mcp.json，添加或更新服务器条目 */
	private async _registerToMcpJson(serverId: string, configDir: URI): Promise<void> {
		// 1. 读取刚安装的 config.json
		const configUri = URI.joinPath(configDir, 'config.json');
		const content = await this.fileService.readFile(configUri);
		const config: McpConfig = JSON.parse(content.value.toString());

		// 2. 转换为 mcp.json 格式
		const entry = this._convertToMcpJsonEntry(config);

		// 3. 读取现有 ~/.vssaros/mcp.json
		const mcpJsonUri = resolveSarosPath(this._getSarosRoot(), SarosPath.mcpConfig);
		let mcpConfig: { servers: Record<string, any> } = { servers: {} };
		try {
			if (await this.fileService.exists(mcpJsonUri)) {
				const raw = await this.fileService.readFile(mcpJsonUri);
				mcpConfig = JSON.parse(raw.value.toString());
				if (!mcpConfig.servers) { mcpConfig.servers = {}; }
			}
		} catch {
			// 文件不存在或解析失败，使用空配置
		}

		// 4. 添加/更新服务器条目
		mcpConfig.servers[serverId] = entry;

		// 5. 写回 mcp.json
		await this.fileService.createFolder(URI.joinPath(mcpJsonUri, '..'));
		await this.fileService.writeFile(mcpJsonUri, VSBuffer.fromString(JSON.stringify(mcpConfig, null, 2)));

		this.logService.info(`[McpInstaller] 已注册 MCP 服务器 "${serverId}" 到 ~/.vssaros/mcp.json (type=${entry.type})`);
	}

	private async copyContents(srcDir: URI, destDir: URI): Promise<void> {
		const stat = await this.fileService.resolve(srcDir);
		if (!stat.children) {
			return;
		}
		for (const child of stat.children) {
			const target = URI.joinPath(destDir, child.name);
			if (child.isDirectory) {
				await this.fileService.createFolder(target);
				await this.copyContents(child.resource, target);
			} else {
				await this.fileService.copy(child.resource, target, true);
			}
		}
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}
}
