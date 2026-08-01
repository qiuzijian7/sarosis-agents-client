/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase 索引排除目录 —— 单一来源（P1）。
 *
 * 此前存在三份互不一致的硬编码列表：
 *  A. codebaseGraphService.DEFAULT_EXCLUDE_DIRS（38 项，auto-index + watcher）
 *  B. codebaseMemoryMcpService.DEFAULT_EXCLUDE_DIRS（22 项，手动 MCP 索引）
 *  C. codebaseIndexEditorPane 内联列表（7 项 × 2 处，UI 默认值 + 兜底）
 * A ⊃ B ⊃ C 且内容不同 —— 同一工作区经不同入口索引会得到不同文件集。
 * 现全部改为引用本模块。
 *
 * UE / 游戏引擎目录（Content、Plugins、Config、Binaries…）不再硬编码进全局默认，
 * 也不再按 `*.uproject` 自动探测叠加 —— 这类项目特异性排除应在 **code-workspace 的
 * `search.exclude` / `files.exclude`** 中显式配置（索引器读取并提取目录名，见
 * `extractExcludeDirNames`）。{@link UNREAL_EXCLUDE_DIRS} 仅作为"建议加入 code-workspace
 * `search.exclude`"的参考清单保留。
 *
 * 注意：匹配是**大小写不敏感**的（见 codebaseGraphService._isExcluded），
 * 因此这里不需要同时列出 `build` 与 `Build`。
 */

/** 通用排除目录：依赖、构建产物、缓存、临时目录。适用于任何语言/框架的项目。 */
export const COMMON_EXCLUDE_DIRS: readonly string[] = Object.freeze([
	// 依赖与版本控制
	'node_modules', '.git', '.worktrees',
	// 构建 / 分发产物
	'build', 'out', 'out-build', 'out-test', 'out-vscode', 'dist', 'target', 'deploy-package', 'coverage',
	// 框架缓存
	'.next', '.nuxt', '__pycache__', '.cache',
	// 临时目录
	'tmp', 'temp', 'enc_temp_folder',
	// 工具自身产物
	'.vscode-test', '.codebase-memory', '.sarosworkspace',
	// 非源码资产 / 文档 / 脚本（索引价值低、体量大）
	'test', 'tests', 'resources', 'docs', 'doc', 'scripts', 'dev', 'extensions', 'cli',
]);

/**
 * Unreal Engine 项目建议排除目录 —— **仅供配置 code-workspace 的 `search.exclude` 时参考**，
 * 不再由索引器自动探测叠加。
 *
 * 用法：在 `<workspace>.code-workspace` 的 `settings.search.exclude` 中为每个目录加一条
 * glob（形式 = 双星号 + 斜杠 + 目录名，值为 true），例如：
 *   - Binaries、Intermediate、Saved、DerivedDataCache、ThirdParty、Plugins、Content、Config、Build、Programs
 * 索引器会读取该配置并提取目录名并入排除集（见 `extractExcludeDirNames`）。
 */
export const UNREAL_EXCLUDE_DIRS: readonly string[] = Object.freeze([
	'Binaries', 'Intermediate', 'Programs', 'Saved', 'DerivedDataCache',
	'ThirdParty', 'Plugins', 'Content', 'Config', 'Build',
]);

/**
 * 合并若干排除目录列表，按大小写不敏感去重并保持首次出现顺序。
 */
export function mergeExcludeDirs(...lists: readonly (readonly string[] | undefined)[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of lists) {
		if (!list) { continue; }
		for (const raw of list) {
			const name = (raw ?? '').trim();
			if (!name) { continue; }
			const key = name.toLowerCase();
			if (seen.has(key)) { continue; }
			seen.add(key);
			out.push(name);
		}
	}
	return out;
}

/**
 * 从 VS Code 的 `search.exclude` / `files.exclude` 配置（glob → 启用开关映射）中提取
 * 目录名，供索引排除集合并。
 *
 * 仅提取"干净的目录段"：形如"双星号 + 斜杠 + 目录名"（例如 Intermediate、Intermediate 后接结尾双星号、
 * Binaries）都会得到目录名 Intermediate / Binaries。含通配符的段（例如双星号 + 斜杠 + 星号以 .log 结尾、
 * 星号以 .code-workspace 结尾）视为文件级排除，跳过 —— 索引器按**目录名**精确匹配，文件名会永不命中。
 *
 * 配置值可能是 `boolean` 或带 `when` 子句的对象 `{ when?: string }`；仅显式 `false` 视为不启用。
 */
export function extractExcludeDirNames(excludeMap: Record<string, boolean | { when?: string }> | undefined): string[] {
	if (!excludeMap) { return []; }
	const out: string[] = [];
	for (const [pattern, raw] of Object.entries(excludeMap)) {
		if (!raw) { continue; }
		const segs = pattern.split('/').map(s => s.trim()).filter(s => s && s !== '**');
		if (!segs.length) { continue; }
		const last = segs[segs.length - 1];
		// 含通配符 → 文件/模糊排除，非目录名，跳过
		if (last.includes('*') || last.includes('?')) { continue; }
		out.push(last);
	}
	return mergeExcludeDirs(out);
}

/**
 * 解析 `.cbmignore` 内容为目录名列表（P4：此前只写不读，形同死文件）。
 *
 * 仅支持"目录名/相对目录路径"这一种最小语义（写入端 writeCbmIgnore 也只写这一种）：
 * - `#` 开头为注释，空行忽略
 * - 去掉首尾 `/`，去掉 Windows 反斜杠
 * - 含通配符的行忽略（扫描器按目录名精确匹配，不支持 glob）
 */
export function parseCbmIgnore(content: string): string[] {
	const out: string[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) { continue; }
		if (line.includes('*') || line.includes('?')) { continue; }
		const normalized = line.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		if (!normalized) { continue; }
		// 只取最后一段：扫描器按目录 **名** 匹配（Set<string> + basename）
		const segments = normalized.split('/').filter(Boolean);
		const name = segments[segments.length - 1];
		if (name) { out.push(name); }
	}
	return mergeExcludeDirs(out);
}
