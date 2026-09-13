/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 索引排除集解析（2026-09-09 从 `codebaseGraphService.ts` 拆出，P1-5 拆分 God Object 第一步）。
 *
 * 职责边界：**只负责「哪些目录不参与索引」的决策**，不含文件遍历逻辑
 * （`_scanFiles` / `_scanDir` 的 keepDirs 例外下钻较为精细，留待后续单独拆分）。
 *
 * 排除集 = 档位基线（`saros.codebaseGraph.excludeProfile`）
 *        + code-workspace 的 `search.exclude` / `files.exclude`
 *        + `<root>/.cbmignore`
 *        + 调用方额外指定。
 *
 * `.cbmignore` 解析结果按 root 缓存；配置变更 / 重新索引时调 `invalidate()` 失效。
 */

import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	mergeExcludeDirs, parseCbmIgnore, extractExcludeDirNames, excludeDirsForProfile, matchesExcludeDir,
} from '../common/codebaseIndexDefaults.js';

/** 与 CodebaseGraphService._normalizeRoot 同口径（去尾分隔符、统一 /、小写）。 */
function normalizeRoot(p: string): string {
	return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

export class CodebaseGraphExcludeResolver {

	/** .cbmignore 解析缓存：归一化 root → 目录名列表 */
	private readonly _cbmIgnoreCache = new Map<string, string[]>();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) { }

	/** 读取 code-workspace 的 `search.exclude` / `files.exclude` 配置，提取目录名。 */
	private _readWorkspaceExcludes(rootPath: string): string[] {
		const resource = URI.file(rootPath);
		const searchExclude = this._configurationService.getValue<Record<string, boolean | { when?: string }>>('search.exclude', { resource });
		const filesExclude = this._configurationService.getValue<Record<string, boolean | { when?: string }>>('files.exclude', { resource });
		return mergeExcludeDirs(extractExcludeDirNames(searchExclude), extractExcludeDirNames(filesExclude));
	}

	/** 读取并解析 `<root>/.cbmignore`。不存在时返回空列表（常态，不记日志）。 */
	private async _readCbmIgnore(rootPath: string): Promise<string[]> {
		const key = normalizeRoot(rootPath);
		const cached = this._cbmIgnoreCache.get(key);
		if (cached !== undefined) { return cached; }
		let dirs: string[] = [];
		try {
			const content = await this._fileService.readFile(joinPath(URI.file(rootPath), '.cbmignore'));
			dirs = parseCbmIgnore(content.value.toString());
		} catch {
			// 文件不存在是常态
		}
		this._cbmIgnoreCache.set(key, dirs);
		return dirs;
	}

	/** 解析某个 root 的最终排除目录集合。 */
	async resolve(rootPath: string, extra?: readonly string[]): Promise<Set<string>> {
		const cbmIgnore = await this._readCbmIgnore(rootPath);
		const wsExcludes = this._readWorkspaceExcludes(rootPath);
		// 档位：balanced（默认，兼容现状，排除 test/docs/scripts 等）/
		// full（保留这些源码目录，测试与脚本代码可被检索，索引更慢）。
		const profile = this._configurationService.getValue<string>('saros.codebaseGraph.excludeProfile');
		const baseExcludes = profile === 'full' ? excludeDirsForProfile('full') : excludeDirsForProfile('balanced');
		const merged = mergeExcludeDirs(
			baseExcludes,
			wsExcludes,
			cbmIgnore,
			extra,
		);
		if (wsExcludes.length || cbmIgnore.length) {
			this._logService.info('[CodebaseGraph]', `[exclude] ${rootPath}: workspace=${wsExcludes.length} items, cbmignore=${cbmIgnore.length} items, total=${merged.length}`);
		}
		return new Set(merged);
	}

	/** 使 `.cbmignore` 缓存失效（配置变更 / 重新索引时调用）。 */
	invalidate(rootPath: string): void {
		this._cbmIgnoreCache.delete(normalizeRoot(rootPath));
	}

	// ─── 遍历期匹配（带缓存，供 _scanDir 逐目录调用）─────────────────────────

	private _excludeLowerCache: Set<string> | undefined;
	private _excludeLowerKey = '';

	/**
	 * 大小写不敏感的目录名匹配。逐目录调用频率极高（整仓数十万次），故对
	 * lowercase 集合做缓存（按 excludeDirs 内容签名失效）；语义由
	 * `matchesExcludeDir` 纯函数保证（有单测覆盖）。
	 */
	isExcluded(name: string, excludeDirs: Set<string>): boolean {
		if (excludeDirs.has(name)) { return true; }
		const key = [...excludeDirs].sort().join(',');
		if (this._excludeLowerKey !== key) {
			this._excludeLowerCache = new Set([...excludeDirs].map(d => d.toLowerCase()));
			this._excludeLowerKey = key;
		}
		return this._excludeLowerCache?.has(name.toLowerCase()) ?? matchesExcludeDir(name, excludeDirs);
	}
}
