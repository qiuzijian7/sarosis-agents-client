/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * AgentInstaller —— agent 资源的安装器实现。
 *
 * install: 解析 agent.json(AgentExportData) → IAgentStudioService.createAgent() 复用落地
 * preparePack: 从 getAgent 读定义 + .agent.md → 组装临时目录(AgentExportData) 供 tar
 * getInstalledVersion: 异步受限返回 undefined（升级检查走 installed-packages.json）
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IAgentStudioService } from '../../common/agentStudio.js';

import { Agent } from '../../../../common/agentStudioTypes.js';
import { IPackageInstaller, PackageManifest, IPreparePackResult } from '../../common/packageInstaller.js';
import { PackageKind, IInstallResult } from '../../common/marketplace.js';
import * as path from '../../../../../base/common/path.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../../common/sarosPaths.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';

export class AgentInstaller extends Disposable implements IPackageInstaller {
	declare readonly _serviceBrand: undefined;
	readonly kind: PackageKind = 'agent';

	constructor(
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	
	) {
		super();
	}

	async install(manifest: PackageManifest, extractedDir: URI): Promise<IInstallResult> {
		const agentJsonUri = URI.joinPath(extractedDir, 'agent.json');
		if (!await this.fileService.exists(agentJsonUri)) {
			throw new Error('包内缺少 agent.json');
		}
		const raw = (await this.fileService.readFile(agentJsonUri)).value.toString();
		const exportData = JSON.parse(raw) as {
			agent: Partial<Agent>;
			agentConfig?: Record<string, unknown>;
			files?: { agentsMd?: string; soulMd?: string; identityMd?: string; toolsMd?: string; memoryMd?: string; configHtml?: string; htmlEntry?: string; htmlContent?: string; htmlStyles?: string };
		};

		// ── Resolve target agent dir: ~/.vssaros/saros/agents/{agentId}/ ──
		const agentId = exportData.agent.id || manifest.id;
		const agentDir = await this.agentStudioService.getAgentDir(agentId);

		// Ensure directory exists (create if first install)
		try {
			await this.fileService.resolve(agentDir);
		} catch {
			await this.fileService.createFolder(agentDir);
		}

		// ── Install HTML/ConfigHTML files into the agent dir ──
		let htmlPath: string | undefined;
		if (manifest.htmlFiles?.entry) {
			// Copy html/ directory from package to agent dir
			const htmlSourceDir = URI.joinPath(extractedDir, 'html');
			if (await this.fileService.exists(htmlSourceDir)) {
				const destHtmlDir = URI.joinPath(agentDir, 'html');
				await this._copyDirectory(htmlSourceDir, destHtmlDir);
			}
			htmlPath = manifest.htmlFiles.entry.replace(/^html\//, '');
		} else if (exportData.files?.htmlContent) {
			// Fallback: write inline HTML content to config.html
			const configHtmlUri = URI.joinPath(agentDir, 'config.html');
			await this.fileService.writeFile(configHtmlUri, VSBuffer.fromString(exportData.files.htmlContent));
			htmlPath = 'config.html';
		}

		// ── Install config source (HTML source file) ──
		if (exportData.files?.configHtml) {
			const configFileName = exportData.agent.configHtml?.htmlPath || 'config.html';
			const configUri = URI.joinPath(agentDir, configFileName);
			await this.fileService.writeFile(configUri, VSBuffer.fromString(exportData.files.configHtml));
		}

		// 复用 createAgent 落地：写 ~/.vssaros/saros/agents/{id}/agent.json + .agent.md（若有 agentsMd）
		const createData: Partial<Agent> & { bootstrapTemplates?: { agentsMd?: string } } = {
			...exportData.agent,
			version: manifest.version,
			storeId: manifest.id,
			source: 'custom' as const,
		};
		if (exportData.files?.agentsMd) {
			createData.bootstrapTemplates = { agentsMd: exportData.files.agentsMd };
		}

		await this.agentStudioService.createAgent(createData);
		this.logService.info(`[AgentInstaller] 安装完成: ${manifest.id} v${manifest.version}${htmlPath ? ' (含 ConfigHTML)' : ''}`);

		return { kind: 'agent', storeId: manifest.id, version: manifest.version, targetDir: agentDir.fsPath };
	}

	/**
	 * Recursively copy a directory's contents.
	 */
	private async _copyDirectory(src: URI, dest: URI): Promise<void> {
		const entries = await this.fileService.resolve(src);
		if (!entries.children) { return; }
		await this.fileService.createFolder(dest);
		for (const child of entries.children) {
			const srcChild = URI.joinPath(src, child.name);
			const destChild = URI.joinPath(dest, child.name);
			if (child.isDirectory) {
				await this._copyDirectory(srcChild, destChild);
			} else {
				const content = await this.fileService.readFile(srcChild);
				await this.fileService.writeFile(destChild, content.value);
			}
		}
	}

	async preparePack(localId: string): Promise<IPreparePackResult> {
		const agent = await this.agentStudioService.getAgent(localId);
		if (!agent) {
			throw new Error(`agent 不存在: ${localId}`);
		}

		// Resolve the agent's directory: ~/.vssaros/saros/agents/{agentId}/
		const agentDir = await this.agentStudioService.getAgentDir(localId);

		// Read .agent.md from the agent directory
		const agentMdUri = URI.joinPath(agentDir, '.agent.md');
		let agentMd: string | undefined;
		if (await this.fileService.exists(agentMdUri)) {
			agentMd = (await this.fileService.readFile(agentMdUri)).value.toString();
		}

		// ── 收集 ConfigHTML 内容（从 agent 目录直接读取） ──
		let configMdContent: string | undefined;
		let htmlEntry: string | undefined;
		let htmlContent: string | undefined;
		let htmlStyles: string | undefined;
		let htmlFilesManifest: PackageManifest['htmlFiles'] | undefined;

		// Try reading config.html from the agent directory
		const configFileName = agent.configHtml?.htmlPath || 'config.html';
		const configUri = URI.joinPath(agentDir, configFileName);
		if (await this.fileService.exists(configUri)) {
			try {
				configMdContent = (await this.fileService.readFile(configUri)).value.toString();
				// Treat as HTML directly (ConfigHtml mode)
				const isHtml = configMdContent.toLowerCase().includes('<!doctype') || /<html[\s>]/i.test(configMdContent);
				if (isHtml) {
					htmlContent = configMdContent;
					htmlEntry = 'index.html';
				}
			} catch { /* read error, skip */ }
		}

		// 组装 AgentExportData
		const exportData = {
			version: 1 as const,
			exportedAt: new Date().toISOString(),
			agent: {
				id: agent.id, name: agent.name, role: agent.role, description: agent.description,
				icon: agent.icon, model: agent.model, skills: agent.skills, tools: agent.tools,
				category: agent.category, systemPrompt: agent.systemPrompt, temperature: agent.temperature,
				configHtml: agent.configHtml,
				source: 'custom',
			},
			agentConfig: {},
			files: {
				agentMd,
				configHtml: configMdContent,
				htmlEntry,
				htmlContent,
				htmlStyles,
			},
		};

		// 写入临时目录供 tar 打包
		const tmpBase = resolveSarosPath(this._getSarosRoot(), SarosPath.tmp).fsPath;
		await this.fileService.createFolder(URI.file(tmpBase));

		const tmpDir = path.join(tmpBase, `saros-agent-pack-${Date.now()}`);
		await this.fileService.createFolder(URI.file(tmpDir));

		await this.fileService.writeFile(URI.joinPath(URI.file(tmpDir), 'agent.json'), VSBuffer.fromString(JSON.stringify(exportData, null, 2)));
		const files = ['agent.json'];
		if (agentMd) {
			await this.fileService.writeFile(URI.joinPath(URI.file(tmpDir), 'AGENTS.md'), VSBuffer.fromString(agentMd));
			files.push('AGENTS.md');
		}

		// Write HTML files to html/ directory in the package
		if (htmlContent) {
			const htmlDir = path.join(tmpDir, 'html');
			await this.fileService.createFolder(URI.file(htmlDir));
			await this.fileService.writeFile(
				URI.joinPath(URI.file(htmlDir), 'index.html'),
				VSBuffer.fromString(htmlContent),
			);
			files.push('html/index.html');
			if (htmlStyles) {
				await this.fileService.writeFile(
					URI.joinPath(URI.file(htmlDir), 'styles.css'),
					VSBuffer.fromString(htmlStyles),
				);
				files.push('html/styles.css');
			}
			htmlFilesManifest = {
				entry: 'html/index.html',
				assets: htmlStyles ? ['html/styles.css'] : [],
			};
		}

		// Write config source file (if available)
		if (configMdContent) {
			const configDir = path.join(tmpDir, 'config');
			await this.fileService.createFolder(URI.file(configDir));
			await this.fileService.writeFile(
				URI.joinPath(URI.file(configDir), configFileName),
				VSBuffer.fromString(configMdContent),
			);
			files.push(`config/${configFileName}`);
		}

		const manifest: PackageManifest = {
			kind: 'agent',
			id: localId,
			name: agent.name,
			version: agent.version || '1.0.0',
			description: agent.description,
			category: agent.category,
			author: 'saros',
			files,
			htmlFiles: htmlFilesManifest,
		};
		return { localDir: URI.file(tmpDir), manifest };
	}

	getInstalledVersion(storeId: string): string | undefined {
		return undefined;
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}
}
