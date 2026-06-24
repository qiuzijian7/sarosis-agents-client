/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * KnowledgeInstaller —— 知识库的安装器实现。
 * 纯文件资源（docs/ + index.json），无平台服务依赖；RAG registry 留后续增强。
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IPathService } from '../../../../../workbench/services/path/common/pathService.js';
import { IPackageInstaller, PackageManifest, IPreparePackResult } from '../../common/packageInstaller.js';
import { PackageKind, IInstallResult } from '../../common/marketplace.js';

const KB_SUBDIR = 'knowledge-base';

export class KnowledgeInstaller extends Disposable implements IPackageInstaller {
	declare readonly _serviceBrand: undefined;
	readonly kind: PackageKind = 'knowledge';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();
	}

	async install(manifest: PackageManifest, extractedDir: URI): Promise<IInstallResult> {
		const targetDir = await this.resolveDir(manifest.id);

		const indexUri = URI.joinPath(extractedDir, 'index.json');
		const hasIndex = await this.fileService.exists(indexUri);

		await this.fileService.createFolder(targetDir);
		await this.copyContents(extractedDir, targetDir);

		this.logService.info(`[KnowledgeInstaller] 安装完成: ${manifest.id} v${manifest.version} → ${targetDir.fsPath} (index=${hasIndex})`);

		return { kind: 'knowledge', storeId: manifest.id, version: manifest.version, targetDir: targetDir.fsPath };
	}

	async preparePack(localId: string): Promise<IPreparePackResult> {
		const localDir = await this.resolveDir(localId);
		if (!await this.fileService.exists(localDir)) {
			throw new Error(`知识库目录不存在: ${localDir.fsPath}`);
		}

		let version = '1.0.0';
		let name = localId;
		let description: string | undefined;
		const indexUri = URI.joinPath(localDir, 'index.json');
		if (await this.fileService.exists(indexUri)) {
			try {
				const content = await this.fileService.readFile(indexUri);
				const parsed = JSON.parse(content.value.toString());
				version = parsed.version || version;
				name = parsed.name || name;
				description = parsed.description;
			} catch { /* ignore */ }
		}

		const files = await this.collectFiles(localDir, localDir);

		const manifest: PackageManifest = {
			kind: 'knowledge',
			id: localId,
			name,
			version,
			description,
			category: 'docs',
			author: 'saros',
			files,
			knowledge: { id: localId, name, description, embedding: { provider: 'none' } },
		};
		return { localDir, manifest };
	}

	getInstalledVersion(storeId: string): string | undefined {
		// 在浏览器环境中，我们无法同步读取文件系统
		// 升级检查将依赖 installed-packages.json（由 MarketplaceService 维护）
		return undefined;
	}

	// ── 内部 ──────────────────────────────────────────────────

	private async resolveDir(id: string): Promise<URI> {
		const userHome = await this.pathService.userHome();
		return URI.joinPath(userHome, '.saros', KB_SUBDIR, id);
	}

	private async collectFiles(baseDir: URI, currentDir: URI): Promise<string[]> {
		const result: string[] = [];
		const stat = await this.fileService.resolve(currentDir);
		if (!stat.children) {
			return result;
		}
		for (const child of stat.children) {
			if (child.isDirectory) {
				const sub = await this.collectFiles(baseDir, child.resource);
				result.push(...sub);
			} else {
				const rel = child.resource.fsPath.slice(baseDir.fsPath.length + 1).replace(/\\/g, '/');
				result.push(rel);
			}
		}
		return result;
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
