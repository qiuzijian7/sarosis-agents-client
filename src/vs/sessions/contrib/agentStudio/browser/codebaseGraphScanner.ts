/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 索引文件扫描（2026-09-09 从 `codebaseGraphService.ts` 拆出，P1-5 拆分 God Object 第二步）。
 *
 * 职责：给定根路径 + 排除集 + keepDirs，**遍历出待索引的源文件绝对路径列表**。
 * 不含排除集的解析（见 CodebaseGraphExcludeResolver）、不含解析/建图。
 *
 * 关键语义（改动前务必读）：
 * - 隐藏项（点开头）跳过；深度 > 30 停止；token 取消立即返回。
 * - **被排除目录的 keepDirs 例外**：目录命中排除集时，若它在 keepDirs 路径上：
 *   - 是 keep 的**祖先**（keep 是其子孙）→ 只沿 `_scanKeepPath` 逐级下钻到 keep，
 *     **禁止全量遍历祖先**（否则 Content 等巨型目录会因一次 keep 命中而海量扫描）；
 *   - 是 keep **精确命中** → 整目录全扫（含全部子树）；
 *   - 否则跳过。
 * - 只有扩展名命中 `EXTENSION_TO_WASM_LANG` 的文件才进结果。
 */

import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { EXTENSION_TO_WASM_LANG } from '../common/codebaseIndexDefaults.js';
import { CodebaseGraphExcludeResolver } from './codebaseGraphExcludeResolver.js';
// 凭据 / 密钥名真源（与 file_read 读守卫、grep 排除 glob 同一对表）。
import { isSensitiveName } from './providers/tool/sensitivePaths.js';

export class CodebaseGraphScanner {

	private _scanFileCount = 0; // 扫描累计计数（用于进度频率控制）
	private _scanRootPath = ''; // 扫描根路径（用于计算相对路径判断 keepDirs）

	/**
	 * @param excludeResolver 由调用方（service）注入——它是普通类而非 DI 服务，
	 *   不能用于参数装饰器注入。
	 */
	constructor(
		private readonly _excludeResolver: CodebaseGraphExcludeResolver,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) { }

	/**
	 * 扫描出待索引文件（绝对路径）。
	 * @param onProgress 进度回调（原为 service 的 _onDidIndexProgress.fire，此处解耦为回调）
	 */
	async scanFiles(
		rootPath: string,
		excludeDirs: Set<string>,
		subPath: string | undefined,
		token: CancellationToken,
		keepDirs?: string[],
		onProgress?: (message: string) => void,
	): Promise<string[]> {
		const scanPath = subPath
			? URI.joinPath(URI.file(rootPath), subPath).fsPath
			: rootPath;
		const results: string[] = [];
		this._scanFileCount = 0;
		this._scanRootPath = scanPath.replace(/\\/g, '/');
		// 构建 keepDirs 匹配集合（大小写不敏感，标准化为 / 分隔）
		const keepSet = new Set<string>();
		if (keepDirs) {
			for (const k of keepDirs) {
				keepSet.add(k.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase());
			}
		}
		this._logService.info('[CodebaseGraph]', `[scan] start: ${scanPath}, excludeDirs=${[...excludeDirs].join(',')}, keepDirs=${[...keepSet].join(',')}`);
		onProgress?.(`📁 扫描目录: ${scanPath}`);
		await this._scanDir(URI.file(scanPath), excludeDirs, results, token, 0, keepSet, onProgress);
		this._logService.info('[CodebaseGraph]', `[scan] done: ${results.length} files`);
		onProgress?.(`📁 扫描完成: 找到 ${results.length} 个源文件`);
		return results;
	}

	// 大小写不敏感的排除匹配（带缓存）；语义由 common 的 matchesExcludeDir 纯函数保证（有单测覆盖）
	private _isExcluded(name: string, excludeDirs: Set<string>): boolean {
		return this._excludeResolver.isExcluded(name, excludeDirs);
	}

	private async _scanDir(dirUri: URI, excludeDirs: Set<string>, results: string[], token: CancellationToken, depth: number, keepSet: Set<string>, onProgress?: (message: string) => void): Promise<void> {
		if (token.isCancellationRequested) { return; }
		if (depth > 30) { return; }

		let stat;
		try {
			stat = await this._fileService.resolve(dirUri);
		} catch {
			return;
		}

		if (!stat.children) { return; }

		let dirCount = 0, fileCount = 0;
		for (const child of stat.children) {
			if (token.isCancellationRequested) { return; }
			if (child.name.startsWith('.') && child.name !== '.' && child.name !== '..') {
				continue;
			}
			// ★★ 凭据 / 密钥名恒不索引（2026-09-13）—— 判定真源 `sensitivePaths.isSensitiveName`
			// （与 `file_read` 读守卫、grep 排除 glob 同一对表，新增表项自动生效）。
			//
			// 为什么必须显式判：索引里存的是**文件内容**，而此前这里**没有任何敏感名判定** ——
			// 它靠「点开头跳过」+「扩展名白名单」两道规则**恰好**挡住了全部敏感名
			// （`.env` / `.npmrc` / `.git-credentials` 是点文件；`auth.json` 的 `.json`
			// 不在 `EXTENSION_TO_WASM_LANG` 里）。那是**巧合而非控制**：一旦有人往白名单
			// 加上 `.json`（很自然的扩展），`auth.json` 的内容就会进图，并被 `search_graph`
			// 原样返回给模型 —— 而索引是**跨会话持久化**的，泄露面比一次 file_read 更大。
			if (isSensitiveName(child.name)) {
				this._logService.debug('[CodebaseGraph]', `[scan] skip sensitive name: ${child.name}`);
				continue;
			}
			// 检查排除规则 + keepDirs 例外
			if (this._isExcluded(child.name, excludeDirs)) {
				// 如果是目录，检查是否在 keepDirs 中（通过相对路径匹配）
				if (child.isDirectory && keepSet.size > 0) {
					const childPath = child.resource.fsPath.replace(/\\/g, '/');
					const relPath = this._scanRootPath && childPath.startsWith(this._scanRootPath)
						? childPath.substring(this._scanRootPath.length).replace(/^\/+/, '')
						: child.name;
					// 检查 relPath 或其父路径是否匹配 keepSet 中的任一条目
					const relPathLower = relPath.toLowerCase();
					let shouldKeep = false;
					for (const keep of keepSet) {
						// 精确匹配或 keep 是 relPath 的子路径前缀
						if (relPathLower === keep || relPathLower.startsWith(keep + '/') || keep.startsWith(relPathLower + '/')) {
							shouldKeep = true;
							break;
						}
					}
					if (shouldKeep) {
						// 该被排除目录是"通向 keep 的祖先"（keep 是其子孙）→ 只沿 keep 路径下钻，
						// 禁止全量遍历祖先（防止 Content 等巨型目录因 keep 命中而卡死/海量扫描）
						const isKeepAncestor = [...keepSet].some(k => k.startsWith(relPathLower + '/'));
						if (isKeepAncestor) {
							this._logService.info('[CodebaseGraph]', `[scan] keep-path descend through excluded ancestor: ${relPath}`);
							await this._scanKeepPath(child.resource, relPathLower, excludeDirs, results, token, keepSet, depth + 1, onProgress);
							continue;
						}
						this._logService.info('[CodebaseGraph]', `[scan] keeping excluded dir: ${relPath}`);
						// 继续扫描此目录（keep 精确命中）
					} else {
						continue;
					}
				} else {
					continue;
				}
			}
			if (child.isDirectory) {
				dirCount++;
				await this._scanDir(child.resource, excludeDirs, results, token, depth + 1, keepSet, onProgress);
			} else if (child.isFile) {
				fileCount++;
				const ext = this._getExtension(child.name);
				if (ext && EXTENSION_TO_WASM_LANG[ext]) {
					results.push(child.resource.fsPath);
					this._scanFileCount++;
					// 每 500 个文件 fire 一次进度（降低日志噪声）
					if (this._scanFileCount % 500 === 0) {
						const dirName = dirUri.fsPath.split(/[\\/]/).pop() || '';
						onProgress?.(`📁 扫描中: ${results.length} 文件 (${dirName})`);
					}
				}
			}
		}

		// 根目录和深层目录都记录日志（降级为 debug，避免刷屏）
		if (depth <= 2 || dirCount > 5) {
			const dirName = dirUri.fsPath.split(/[\\/]/).pop() || dirUri.fsPath;
			this._logService.debug('[CodebaseGraph]', `[scan] depth=${depth} dir=${dirName} dirs=${dirCount} files=${fileCount} total=${results.length}`);
		}
	}

	private _getExtension(fileName: string): string {
		const idx = fileName.lastIndexOf('.');
		return idx >= 0 ? fileName.substring(idx).toLowerCase() : '';
	}

	/**
	 * 沿 keep 路径逐级下钻（每级只进入通向 keep 的下一段），直到某目录本身是 keep 精确命中时，
	 * 再对该目录执行完整 _scanDir。用于"被排除祖先仅因 keep 保留"的场景：
	 * 例如 keep=content/script 时，只遍历 Content/Script 分支，跳过 Content/Art、Content/Audio 等。
	 * relPathLower 为 dirUri 相对扫描根的路径（小写 / 分隔）。
	 */
	private async _scanKeepPath(dirUri: URI, relPathLower: string, excludeDirs: Set<string>, results: string[], token: CancellationToken, keepSet: Set<string>, depth: number, onProgress?: (message: string) => void): Promise<void> {
		// 提取 dirUri 下所有"通向 keep"的下一段目录名
		const nextSegs = new Set<string>();
		let exactKeep = false;
		for (const keep of keepSet) {
			if (keep === relPathLower) { exactKeep = true; }
			else if (keep.startsWith(relPathLower + '/')) {
				nextSegs.add(keep.slice(relPathLower.length + 1).split('/')[0]);
			}
		}
		// 当前目录本身就是 keep 精确目录 → 整目录全扫（含其全部子树）
		if (exactKeep) {
			this._logService.info('[CodebaseGraph]', `[scan] keep-path reached keep dir: ${relPathLower}`);
			await this._scanDir(dirUri, excludeDirs, results, token, depth, keepSet, onProgress);
			return;
		}
		// 否则只沿下一段目录下钻（不遍历祖先的其他内容）。
		//
		// ★ 修正（2026-09-09，由新增单测暴露）：原实现直接用**小写化**的 seg 拼 URI 去 stat
		// ——keepDirs 经小写化处理后，在大小写**敏感**的文件系统（Linux）上若与磁盘实际
		// 大小写不一致（keep=content/script vs 磁盘 Content/Script）会 stat 失败 →
		// keep 分支静默丢空。Windows 因不敏感恰好掩盖了该缺陷。
		// 现改为：列出实际子目录，用小写名匹配 nextSegs，再以**真实 child.resource** 下钻。
		const resolved = await this._fileService.resolve(dirUri).catch(() => undefined);
		if (!resolved?.children) { return; }
		for (const child of resolved.children) {
			if (token.isCancellationRequested) { return; }
			if (!child.isDirectory) { continue; }
			const segLower = child.name.toLowerCase();
			if (!nextSegs.has(segLower)) { continue; }
			this._logService.info('[CodebaseGraph]', `[scan] keep-path descend: ${relPathLower}/${segLower}`);
			await this._scanKeepPath(child.resource, `${relPathLower}/${segLower}`, excludeDirs, results, token, keepSet, depth + 1, onProgress);
		}
	}
}
