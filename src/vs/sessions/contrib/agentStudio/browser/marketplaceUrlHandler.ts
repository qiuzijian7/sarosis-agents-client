/*---------------------------------------------------------------------------------------------.
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IURLHandler, IOpenURLOptions } from '../../../../platform/url/common/url.js';
import { IMarketplaceService } from '../common/marketplace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import type { PackageKind } from '../common/marketplace.js';

/**
 * MCP 配置结构（与 mcpInstaller.ts 中的 McpConfig 一致）。
 */
interface McpConfig {
	transport?: 'stdio' | 'sse' | 'streamable-http';
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	description?: string;
	version?: string;
}

/**
 * Handles `vssaros://marketplace/install` and `vssaros://marketplace/install-mcp` URIs.
 *
 * URL formats:
 *   vssaros://marketplace/install?slug=<slug>&version=<version>&kind=<kind>
 *     → Downloads the package zip and installs it (all kinds).
 *
 *   vssaros://marketplace/install-mcp?slug=<slug>&name=<name>&config=<base64-json>
 *     → Writes MCP config directly to ~/.saros/mcp/{slug}/config.json and
 *       registers in ~/.saros/mcp.json (no zip download needed).
 *
 * Flow:
 *   1. User clicks "安装到 VsSaros" on the web marketplace detail page
 *   2. Browser opens vssaros:// URL → OS launches VsSaros
 *   3. This handler receives the URI, parses params
 *   4. Calls marketplaceService.download() OR writes config directly (install-mcp)
 *   5. Shows progress notification and success/error message
 */
export class MarketplaceUrlHandler extends Disposable implements IURLHandler {

	static readonly ID = 'workbench.handler.marketplace';

	constructor(
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProgressService private readonly progressService: IProgressService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();
	}

	async handleURL(uri: URI, _options?: IOpenURLOptions): Promise<boolean> {
		// Only handle vssaros://marketplace/*
		if (uri.authority !== 'marketplace') {
			return false;
		}

		const path = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;

		// install-mcp: direct config write (no zip download)
		if (path === 'install-mcp') {
			return this._handleInstallMcp(new URLSearchParams(uri.query));
		}

		// install: zip download + install
		if (path !== 'install') {
			return false;
		}

		// Parse query params
		const params = new URLSearchParams(uri.query);
		const slug = params.get('slug');
		const version = params.get('version');
		const kind = params.get('kind') as PackageKind | null;

		if (!slug || !version || !kind) {
			this.notificationService.error(
				`安装参数不完整。需要 slug、version 和 kind 参数。\nURL: ${uri.toString()}`
			);
			return true;
		}

		const validKinds: PackageKind[] = ['skill', 'mcp', 'agent', 'knowledge'];
		if (!validKinds.includes(kind)) {
			this.notificationService.error(`不支持的资源类型: ${kind}`);
			return true;
		}

		const kindLabel: Record<PackageKind, string> = {
			skill: '技能',
			mcp: 'MCP 服务器',
			agent: 'Agent',
			knowledge: '知识库',
			workflow: '工作流',
		};

		// Show progress and install
		this.notificationService.info(`正在从商城安装 ${kindLabel[kind]}: ${slug} v${version}...`);

		try {
			const result = await this.progressService.withProgress(
				{
					location: ProgressLocation.Notification,
					title: `安装 ${kindLabel[kind]}: ${slug} v${version}`,
					cancellable: false,
				},
				async () => {
					return await this.marketplaceService.download(slug, version, kind);
				}
			);

			this.notificationService.info(
				`✅ ${kindLabel[kind]} "${slug}" v${result.version} 安装成功！\n` +
				`安装位置: ${result.targetDir}`
			);

			// Installation complete — the Integration view will refresh
			// on next activation; no explicit command needed.

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.notificationService.error(
				`❌ 安装失败: ${kindLabel[kind]} "${slug}" v${version}\n${msg}`
			);
		}

		return true;
	}

	/**
	 * Handle `vssaros://marketplace/install-mcp` — write MCP config directly to
	 * `~/.saros/mcp/{slug}/config.json` and register in `~/.saros/mcp.json`.
	 *
	 * This bypasses the zip download flow: the web marketplace sends the MCP
	 * configuration (transport/command/args/env/url) as a base64-encoded JSON
	 * parameter, and the client writes it directly.
	 */
	private async _handleInstallMcp(params: URLSearchParams): Promise<boolean> {
		const slug = params.get('slug');
		const name = params.get('name');
		const configB64 = params.get('config');

		if (!slug || !configB64) {
			this.notificationService.error(
				`安装 MCP 参数不完整。需要 slug 和 config 参数。`
			);
			return true;
		}

		// Decode base64 config
		let config: McpConfig;
		try {
			const configJson = decodeURIComponent(escape(atob(configB64)));
			config = JSON.parse(configJson) as McpConfig;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.notificationService.error(`MCP 配置解析失败: ${msg}`);
			return true;
		}

		this.notificationService.info(`正在安装 MCP 配置: ${slug}...`);

		try {
			const result = await this.progressService.withProgress(
				{
					location: ProgressLocation.Notification,
					title: `安装 MCP: ${name || slug}`,
					cancellable: false,
				},
				async () => {
					return await this._writeMcpConfig(slug, name || slug, config);
				}
			);

			this.notificationService.info(
				`✅ MCP "${slug}" 安装成功！\n` +
				`配置文件: ${result.configPath}\n` +
				`已注册到: ~/.saros/mcp.json`
			);

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.notificationService.error(`❌ MCP 安装失败: "${slug}"\n${msg}`);
		}

		return true;
	}

	/**
	 * Write MCP config to `~/.saros/mcp/{slug}/config.json` and register
	 * in `~/.saros/mcp.json`. Mirrors the logic in mcpInstaller.ts.
	 */
	private async _writeMcpConfig(slug: string, name: string, config: McpConfig): Promise<{ configPath: string }> {
		const userHome = await this.pathService.userHome();
		const mcpDir = URI.joinPath(userHome, '.saros', 'mcp', slug);
		const configFileUri = URI.joinPath(mcpDir, 'config.json');
		const mcpJsonUri = URI.joinPath(userHome, '.saros', 'mcp.json');

		// 1. Create directory ~/.saros/mcp/{slug}/
		await this.fileService.createFolder(mcpDir);

		// 2. Write config.json (with id/name/version filled in)
		const configToWrite = {
			id: slug,
			name,
			description: config.description,
			transport: config.transport || 'stdio',
			command: config.command,
			args: config.args,
			env: config.env,
			url: config.url,
			headers: config.headers,
			version: config.version || '1.0.0',
		};
		await this.fileService.writeFile(
			configFileUri,
			VSBuffer.fromString(JSON.stringify(configToWrite, null, 2))
		);

		// 3. Read existing ~/.saros/mcp.json (or create empty)
		let mcpJson: { servers: Record<string, unknown> } = { servers: {} };
		try {
			const content = await this.fileService.readFile(mcpJsonUri);
			mcpJson = JSON.parse(content.value.toString());
			if (!mcpJson.servers) {
				mcpJson.servers = {};
			}
		} catch {
			// File doesn't exist yet — use empty config
		}

		// 4. Convert config to mcp.json entry format (mirrors mcpInstaller._convertToMcpJsonEntry)
		const transport = config.transport || 'stdio';
		const entry: Record<string, unknown> = { disabled: false };

		if (transport === 'stdio') {
			entry.type = 'stdio';
			if (config.command) { entry.command = config.command; }
			if (config.args) { entry.args = config.args; }
			if (config.env) { entry.env = config.env; }
		} else {
			entry.type = transport;  // "sse" or "http"
			if (config.url) { entry.url = config.url; }
			if (config.headers) { entry.headers = config.headers; }
			else if (config.env) { entry.headers = config.env; }
		}

		// 5. Register in mcp.json
		mcpJson.servers[slug] = entry;
		await this.fileService.writeFile(
			mcpJsonUri,
			VSBuffer.fromString(JSON.stringify(mcpJson, null, 2))
		);

		return { configPath: mcpDir.fsPath };
	}
}
