/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * McpInstaller —— MCP 服务器配置的安装器实现。
 * 文件落地 config.json；完整 IMcpManagementService 自动注册留后续增强。
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IPackageInstaller, PackageManifest, IPreparePackResult } from '../../common/packageInstaller.js';
import { PackageKind, IInstallResult } from '../../common/marketplace.js';
import { IPathService } from '../../../../../workbench/services/path/common/pathService.js';

const MCP_SUBDIR = 'mcp-servers';

export class McpInstaller extends Disposable implements IPackageInstaller {
	declare readonly _serviceBrand: undefined;
	readonly kind: PackageKind = 'mcp';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IPathService private readonly pathService: IPathService,
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

		this.logService.info(`[McpInstaller] 安装完成: ${manifest.id} v${manifest.version} → ${targetDir.fsPath}`);
		this.logService.info(`[McpInstaller] 提示: 请在集成视图中手动添加该服务器（配置见 config.json）`);

		return { kind: 'mcp', storeId: manifest.id, version: manifest.version, targetDir: targetDir.fsPath };
	}

	async preparePack(localId: string): Promise<IPreparePackResult> {
		const localDir = await this.resolveDir(localId);
		if (!await this.fileService.exists(localDir)) {
			throw new Error(`MCP 配置目录不存在: ${localDir.fsPath}`);
		}

		const configUri = URI.joinPath(localDir, 'config.json');
		let config: { id?: string; name?: string; description?: string; transport?: string; command?: string; args?: string[]; url?: string };
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
			version: '1.0.0',
			description: config.description,
			category: 'tools',
			author: 'saros',
			files,
			mcp: config,
		};
		return { localDir, manifest };
	}

	getInstalledVersion(storeId: string): string | undefined {
		return undefined;
	}

	// ── 内部 ──────────────────────────────────────────────────

	private async resolveDir(id: string): Promise<URI> {
		const userHome = await this.pathService.userHome();
		return URI.joinPath(userHome, '.saros', MCP_SUBDIR, id);
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
}
