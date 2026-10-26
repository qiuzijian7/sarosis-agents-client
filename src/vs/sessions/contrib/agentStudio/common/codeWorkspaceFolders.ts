/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `.code-workspace` 文件的唯一解析口径（2026-10-26 新增）。
 *
 * 为什么抽出来：这份解析原本只在 `src/vs/sessions/browser/parts/sidebarPart.ts` 的私有方法
 * `_resolveCodeWorkspaceFolders()` 里 ⇒「从 .code-workspace 导入多根工作区」若自己再写一份，
 * 就是两份格式解析 ⇒ 以后格式演进两处不同步 ⇒「有的文件能导入、有的不能」✗。
 * ⇒ 现在解析只有这一份，sidebarPart 与新命令都调它 ✓。
 *
 * 必须用 JSONC 解析（`.code-workspace` 允许注释与尾逗号；本仓自己的
 * `sarosis-agents-client.code-workspace` 里就有大段注释）。`JSON.parse` 遇注释直接抛错
 * ⇒ 解析结果恒为空 ⇒ 退化成一个根 ✗。
 *
 * 纯函数（无 IO）：文件读取由调用方做（IDE 侧用 `IFileService`）⇒ 可单测 ✓。
 */

import { parse as parseJsonc, ParseError } from '../../../../base/common/json.js';
import { URI } from '../../../../base/common/uri.js';
import { resolveFolderPath } from './workspaceFileFolders.js';

/** `.code-workspace` 里 `folders[]` 的一条（结构最小子集：只关心 path / uri / name）。 */
export interface ICodeWorkspaceFolderEntry {
	readonly path?: string;
	readonly uri?: string;
	readonly name?: string;
}

/** 解析出来的一条根（`path` 已是绝对路径）。 */
export interface ICodeWorkspaceFolder {
	readonly path: string;
	readonly name: string;
}

export interface ICodeWorkspaceParseResult {
	/** `folders[0]` 解析后的绝对路径（= 主根）；没有可解析的 folder 时为 `undefined`。 */
	readonly primaryPath?: string;
	/** `folders[1..]` 解析后的绝对路径（= 其余根）。 */
	readonly extraFolders: readonly ICodeWorkspaceFolder[];
	/** `settings["files.exclude"]`（原生 Explorer 的隐藏规则）。 */
	readonly filesExclude?: Record<string, boolean>;
	/** `settings["codebase-memory"]`（本仓的图谱索引配置）。 */
	readonly codebaseMemory?: { mode?: string; excludeDirs?: string[]; keepDirs?: string[] };
	/** JSONC 解析器容忍掉的错误数（>0 = 文件有点问题，但不致命 —— 原生也是容忍的）。 */
	readonly parseErrorCount: number;
}

/** 解析 `.code-workspace` 的文本。baseDir = 相对路径的基准目录（= 工作区文件所在目录）。 */
export function parseCodeWorkspaceFolders(text: string, baseDir: string): ICodeWorkspaceParseResult {
	const parseErrors: ParseError[] = [];
	let parsed: any;
	try {
		parsed = parseJsonc(text, parseErrors);
	} catch {
		parsed = undefined;
	}
	const folders: ICodeWorkspaceFolderEntry[] = Array.isArray(parsed?.folders) ? parsed.folders : [];

	/** 一条 folder → 绝对路径（`path` 相对工作区文件；`uri` 只认 file://）。 */
	const resolveOne = (folder: ICodeWorkspaceFolderEntry): string | undefined => {
		let rawPath = typeof folder.path === 'string' ? folder.path.trim() : '';
		if (!rawPath && typeof folder.uri === 'string' && folder.uri.trim()) {
			try {
				const uri = URI.parse(folder.uri.trim());
				// 非 file://（远程 scheme）不认 ⇒ 跳过这条（不能当本地目录用 ✗）。
				if (uri.scheme !== 'file') { return undefined; }
				rawPath = uri.fsPath;
			} catch {
				return undefined;
			}
		}
		if (!rawPath) { return undefined; }
		return resolveFolderPath(baseDir, rawPath);
	};

	const primaryPath = folders.length > 0 ? resolveOne(folders[0]) : undefined;
	const extraFolders: ICodeWorkspaceFolder[] = [];
	for (const f of folders.slice(1)) {
		const p = resolveOne(f);
		if (!p) { continue; }
		extraFolders.push({ path: p, name: typeof f.name === 'string' ? f.name : '' });
	}

	const filesExclude = (parsed?.settings?.['files.exclude'] && typeof parsed.settings['files.exclude'] === 'object')
		? parsed.settings['files.exclude'] as Record<string, boolean>
		: undefined;
	const cbmRaw = parsed?.settings?.['codebase-memory'];
	const codebaseMemory = (cbmRaw && typeof cbmRaw === 'object')
		? {
			mode: typeof cbmRaw.mode === 'string' ? cbmRaw.mode : undefined,
			excludeDirs: Array.isArray(cbmRaw.excludeDirs) ? cbmRaw.excludeDirs.filter((x: unknown): x is string => typeof x === 'string') : undefined,
			keepDirs: Array.isArray(cbmRaw.keepDirs) ? cbmRaw.keepDirs.filter((x: unknown): x is string => typeof x === 'string') : undefined,
		}
		: undefined;

	return { primaryPath, extraFolders, filesExclude, codebaseMemory, parseErrorCount: parseErrors.length };
}
