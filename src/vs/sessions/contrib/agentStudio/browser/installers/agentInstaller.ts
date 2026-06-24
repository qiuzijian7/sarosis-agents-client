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
import { IPathService } from '../../../../../workbench/services/path/common/pathService.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import { Agent } from '../../../../common/agentStudioTypes.js';
import { IPackageInstaller, PackageManifest, IPreparePackResult } from '../../common/packageInstaller.js';
import { PackageKind, IInstallResult } from '../../common/marketplace.js';
import * as path from '../../../../../base/common/path.js';

export class AgentInstaller extends Disposable implements IPackageInstaller {
	declare readonly _serviceBrand: undefined;
	readonly kind: PackageKind = 'agent';

	constructor(
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IPathService private readonly pathService: IPathService,
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
			files?: { agentsMd?: string; soulMd?: string; identityMd?: string; toolsMd?: string; memoryMd?: string };
		};

		// 复用 createAgent 落地：写 custom-agents.json + .agent.md（若有 agentsMd）
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
		this.logService.info(`[AgentInstaller] 安装完成: ${manifest.id} v${manifest.version}`);

		const targetDir = await this.resolveAgentsCustomDir();
		return { kind: 'agent', storeId: manifest.id, version: manifest.version, targetDir: targetDir.fsPath };
	}

	async preparePack(localId: string): Promise<IPreparePackResult> {
		const agent = await this.agentStudioService.getAgent(localId);
		if (!agent) {
			throw new Error(`agent 不存在: ${localId}`);
		}

		// 读取 .agent.md 引导文件（若存在）
		const slug = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
		const agentMdUri = URI.joinPath(await this.resolveAgentsCustomDir(), `${slug}.agent.md`);
		let agentMd: string | undefined;
		if (await this.fileService.exists(agentMdUri)) {
			agentMd = (await this.fileService.readFile(agentMdUri)).value.toString();
		}

		// 组装 AgentExportData
		const exportData = {
			version: 1 as const,
			exportedAt: new Date().toISOString(),
			agent: {
				id: agent.id, name: agent.name, role: agent.role, description: agent.description,
				icon: agent.icon, model: agent.model, skills: agent.skills, tools: agent.tools,
				category: agent.category, systemPrompt: agent.systemPrompt, temperature: agent.temperature,
				source: 'custom',
			},
			agentConfig: {},
			files: { agentMd },
		};

		// 写入临时目录供 tar 打包
		const userHome = await this.pathService.userHome();
		const tmpBase = path.join(userHome.fsPath, '.saros', 'tmp');
		await this.fileService.createFolder(URI.file(tmpBase));
		
		const tmpDir = path.join(tmpBase, `saros-agent-pack-${Date.now()}`);
		await this.fileService.createFolder(URI.file(tmpDir));
		
		await this.fileService.writeFile(URI.joinPath(URI.file(tmpDir), 'agent.json'), VSBuffer.fromString(JSON.stringify(exportData, null, 2)));
		const files = ['agent.json'];
		if (agentMd) {
			await this.fileService.writeFile(URI.joinPath(URI.file(tmpDir), 'AGENTS.md'), VSBuffer.fromString(agentMd));
			files.push('AGENTS.md');
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
		};
		return { localDir: URI.file(tmpDir), manifest };
	}

	getInstalledVersion(storeId: string): string | undefined {
		return undefined;
	}

	private async resolveAgentsCustomDir(): Promise<URI> {
		const userHome = await this.pathService.userHome();
		return URI.joinPath(userHome, '.saros', 'agents', 'custom');
	}
}
