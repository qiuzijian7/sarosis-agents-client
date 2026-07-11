/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * KnowledgeInstaller —— 知识库的安装器实现。
 * 纯文件资源（docs/ + index.json），无平台服务依赖。
 *
 * 支持预建索引：若知识库包中携带 .ftindex.json / .kbkernel.json，安装时自动
 * 完成路径重映射 + 一致性校验，避免每个客户端重复构建全文索引。
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IPathService } from '../../../../../workbench/services/path/common/pathService.js';
import { IPackageInstaller, PackageManifest, IPreparePackResult } from '../../common/packageInstaller.js';
import { PackageKind, IInstallResult } from '../../common/marketplace.js';
import { KbFullTextIndex } from '../views/knowledgeBase/kbIndex.js';

const KB_SUBDIR = 'knowledge-base';

/** Pre-built index filenames carried in knowledge packages. */
const PREBUILT_INDEX_FILES = ['.ftindex.json', '.kbkernel.json'];

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

		// Detect pre-built index files BEFORE copy (we need to remap paths
		// from the source machine's absolute paths to this machine's paths).
		const prebuiltSource: { name: string; uri: URI }[] = [];
		for (const fn of PREBUILT_INDEX_FILES) {
			const uri = URI.joinPath(extractedDir, fn);
			if (await this.fileService.exists(uri)) {
				prebuiltSource.push({ name: fn, uri });
			}
		}

		// Try to remap pre-built index files in-place before copying.
		// Extract the source prefix from the first .ftindex.json found.
		let hasPrebuiltIndex = false;
		let sourcePrefix = '';
		if (prebuiltSource.length > 0) {
			const ftsFile = prebuiltSource.find(f => f.name === '.ftindex.json');
			if (ftsFile) {
				try {
					const raw = (await this.fileService.readFile(ftsFile.uri)).value.toString();
					const data = JSON.parse(raw);
					const firstDoc = data?.docs?.[0];
					if (firstDoc?.path && typeof firstDoc.path === 'string') {
						// Infer source prefix: the common ancestor directory of all docs,
						// e.g.  /home/alice/.saros/knowledge-base/feishu-kb-01
						sourcePrefix = this._inferSourcePrefix(data.docs);
					}
				} catch { /* remap will fail gracefully below */ }
			}

			if (sourcePrefix) {
				const targetPrefix = targetDir.fsPath;
				for (const file of prebuiltSource) {
					try {
						const raw = (await this.fileService.readFile(file.uri)).value.toString();
						const remapped = KbFullTextIndex.remapPaths(raw, sourcePrefix, targetPrefix);
						if (remapped) {
							await this.fileService.writeFile(file.uri, VSBuffer.fromString(remapped));
							this.logService.info(`[KnowledgeInstaller] remapped paths in ${file.name}: ${sourcePrefix} → ${targetPrefix}`);
						}
					} catch (err) {
						this.logService.warn(`[KnowledgeInstaller] remap failed for ${file.name}`, err);
					}
				}
			}

			// Validate the remapped index against the installed files on disk.
			const ftsIndex = prebuiltSource.find(f => f.name === '.ftindex.json');
			if (ftsIndex) {
				try {
					const raw = (await this.fileService.readFile(ftsIndex.uri)).value.toString();
					const v = await KbFullTextIndex.validateIndex(raw, this.fileService);
					if (v.valid > 0 && v.valid / v.total >= 0.7) {
						hasPrebuiltIndex = true;
						this.logService.info(`[KnowledgeInstaller] prebuilt index valid: ${v.valid}/${v.total} ok, ${v.stale} stale, ${v.missing} missing`);
					} else {
						this.logService.warn(`[KnowledgeInstaller] prebuilt index too stale (${v.valid}/${v.total} valid), will rebuild`);
					}
				} catch (err) {
					this.logService.warn('[KnowledgeInstaller] prebuilt index validation failed', err);
				}
			}
		}

		await this.fileService.createFolder(targetDir);
		await this.copyContents(extractedDir, targetDir);

		this.logService.info(`[KnowledgeInstaller] 安装完成: ${manifest.id} v${manifest.version} → ${targetDir.fsPath} (index=${hasIndex}, prebuilt=${hasPrebuiltIndex})`);

		return { kind: 'knowledge', storeId: manifest.id, version: manifest.version, targetDir: targetDir.fsPath, hasPrebuiltIndex };
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

		// Include pre-built index files if present — these will be shared with
		// other clients so they skip rebuilding the full-text index.
		for (const fn of PREBUILT_INDEX_FILES) {
			const idxUri = URI.joinPath(localDir, fn);
			if (await this.fileService.exists(idxUri)) {
				if (!files.includes(fn)) {
					files.push(fn);
					this.logService.info(`[KnowledgeInstaller] including prebuilt index in pack: ${fn}`);
				}
			}
		}

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

	/**
	 * Infer the common source prefix from the docs' paths in the serialized index.
	 * Uses the longest common prefix across all doc paths, truncated to the last
	 * directory separator. This produces the Vault root on the source machine.
	 */
	private _inferSourcePrefix(docs: { path?: string }[]): string {
		if (!docs || docs.length === 0) { return ''; }
		const paths = docs.map(d => d.path).filter((p): p is string => typeof p === 'string');
		if (paths.length === 0) { return ''; }

		// Find longest common prefix up to the last separator
		let prefix = paths[0];
		for (let i = 1; i < paths.length; i++) {
			while (!paths[i].startsWith(prefix)) {
				prefix = prefix.slice(0, prefix.lastIndexOf('/') > 0 ? prefix.lastIndexOf('/') : prefix.length);
				if (!prefix) { return ''; }
			}
		}
		// Trim to last directory separator to get the vault root
		const lastSep = prefix.lastIndexOf('/');
		return lastSep > 0 ? prefix.slice(0, lastSep) : prefix;
	}
}
