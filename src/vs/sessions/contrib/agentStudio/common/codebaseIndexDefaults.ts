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
	// IDE/工具配置与缓存（UE 的 compile_commands_* 预处理产物也在 .vscode 下，动辄数万文件）
	'.vscode', '.idea', '.vs', '.vscode-server', '.ugs',
	// 非源码资产 / 文档 / 脚本（索引价值低、体量大）
	'test', 'tests', 'resources', 'docs', 'doc', 'scripts', 'dev', 'extensions', 'cli',
	// 构建/调试产物目录（esbuild bundle 的 .mjs 输出，如 webview/e2e/entry.mjs 196KB）
	// 每次 esbuild 打包 mtime 变化会触发 CodebaseGraphWatcher 全项目增量索引。
	'e2e', 'generated-images', '_removed_extensions',
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
 * 排除档位（2026-09-09，配置项 `saros.codebaseGraph.excludeProfile`）。
 *
 * 背景：`COMMON_EXCLUDE_DIRS` 里的 `test` / `tests` / `docs` / `scripts` / `resources`
 * / `cli` / `extensions` 属**源码可读但价值存疑**的目录——排除它们会让测试/脚本代码
 * 无法被检索（Find Symbol / Open File 找不到测试里的符号）。但全量索引这些目录会
 * 显著拉长索引时间。故做成档位，由用户按仓库取舍。
 *
 * - `balanced`（默认，兼容现状）：全部排除，索引最快。
 * - `full`：保留测试/文档/脚本等源码目录，只排除依赖与构建产物 —— 覆盖完整、索引更慢。
 */
export const EXCLUDE_PROFILES = {
	/** 两档共有的「必排除」：依赖、版本控制、构建产物、缓存、IDE 配置。 */
	core: [
		'node_modules', '.git', '.worktrees',
		'build', 'out', 'out-build', 'out-test', 'out-vscode', 'dist', 'target', 'deploy-package', 'coverage',
		'.next', '.nuxt', '__pycache__', '.cache',
		'tmp', 'temp', 'enc_temp_folder',
		'.vscode-test', '.codebase-memory', '.sarosworkspace',
		'.vscode', '.idea', '.vs', '.vscode-server', '.ugs',
		'generated-images', '_removed_extensions',
	],
	/** balanced 档额外排除：源码可读但索引价值存疑的目录（测试/文档/脚本/资源）。 */
	balancedOnly: [
		'test', 'tests', 'resources', 'docs', 'doc', 'scripts', 'dev', 'extensions', 'cli', 'e2e',
	],
} as const;

/** 按档位取排除目录清单。 */
export function excludeDirsForProfile(profile: 'balanced' | 'full'): readonly string[] {
	return profile === 'full'
		? EXCLUDE_PROFILES.core
		: [...EXCLUDE_PROFILES.core, ...EXCLUDE_PROFILES.balancedOnly];
}

/** 逐文件索引结果状态（下沉到 common，供 store/service/测试共用）。 */
export type FileCoverageStatus = 'indexed' | 'skipped' | 'parse_error' | 'timeout' | 'partial';

/**
 * 解析后**是否应记录哈希基线**（把 service 内的策略抽为可测纯函数，2026-09-09）。
 *
 * 背景：哈希基线的语义必须是「成功处理过」。旧实现无论成败都记 → 解析大面积失败后
 * 失败被永久固化（6000 文件永不重试，图只剩被编辑过的文件）。
 *
 * - `parse_error` / `timeout`：可恢复的失败 → **不记**（下轮 watcher 重报后重试）；
 *   失败累计达到 retryMax 才记，防止「失败文件每轮都重报」的翻烧饼。计数是会话级内存
 *   的，实例重启清零 —— 环境修复（如 wasm 可用）后重启即自愈。
 * - 其余（indexed / partial / skipped）：记哈希。skipped 属防护类（不支持的扩展名、
 *   超大文件、minified），永远不会成功，必须记基线否则每轮重报。
 *
 * @param failCount 已含本次在内的累计失败次数
 */
export function shouldRecordHashAfterParse(status: FileCoverageStatus, failCount: number, retryMax: number = 3): boolean {
	if (status === 'parse_error' || status === 'timeout') {
		return failCount >= retryMax;
	}
	return true;
}

/**
 * 目录名是否命中排除集（纯函数，2026-09-09）。
 *
 * 语义：**按目录名精确匹配**（不含路径），且**大小写不敏感**（Windows 与 Linux 仓库
 * 目录大小写不一致很常见，如 `Build` vs `build`）。
 *
 * 抽出目的：`_scanDir` 的遍历逻辑（尤其 keepDirs 例外下钻）后续要拆出 service，
 * 先把这段最容易出错的匹配语义做成可测纯函数，作为搬迁的回归锚点。
 *
 * @param name 目录/文件**名**（非路径）
 * @param excludeDirs 排除目录名集合（大小写任意）
 */
/**
 * 参与索引的扩展名 → tree-sitter wasm 语言名（2026-09-09 从 codebaseGraphService 下沉，
 * 供 service 与 CodebaseGraphScanner 共用）。**未列出的扩展名不参与索引**。
 */
export const EXTENSION_TO_WASM_LANG: Record<string, string> = {
	'.ts': 'typescript',
	'.tsx': 'tsx',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.mjs': 'javascript',
	'.py': 'python',
	'.go': 'go',
	'.rs': 'rust',
	'.java': 'java',
	'.rb': 'ruby',
	'.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
	'.cs': 'c-sharp',
	'.php': 'php',
};

export function matchesExcludeDir(name: string, excludeDirs: Set<string>): boolean {
	if (excludeDirs.size === 0) { return false; }
	if (excludeDirs.has(name)) { return true; }
	const lower = name.toLowerCase();
	for (const d of excludeDirs) {
		if (d.toLowerCase() === lower) { return true; }
	}
	return false;
}

/**
 * 判定 filePath 是否为绝对路径（图内 filePath 契约要求为**项目相对路径**）。
 *
 * 契约背景（2026-09-09）：Worker 内 walkAST 把传入的 filePath 原样写进节点，
 * 增量解析曾误传绝对路径（`g:\...`）→ 图里混入绝对路径，OpenFileModal 用
 * `joinPath(root, abs)` 拼出错误 URI 静默打不开。生产路径已修，此处用于
 * **运行时契约检测**（store.upsertNode 统计 → 健康度暴露），防回归。
 */
export function isAbsoluteGraphPath(p: string): boolean {
	if (!p) { return false; }
	// Windows: C:\ / C:/ ；UNC: \\server\share
	if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) { return true; }
	// POSIX 绝对路径（相对路径不会以 / 开头）
	return p.startsWith('/');
}

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

/**
 * **非符号**节点类型（容器 / 桩节点）—— 「搜符号」类入口（Find Symbol 等）必须排除它们。
 *
 * 2026-09-15（用户截图报障）：Find Symbol 搜 `test` 时 200 条候选里大半是
 * `label='file'` 的 CONTAINS stub 节点（`toolArgsJson.test.ts`、`kbBlocksCodec.test.ts` …）
 * —— 它们是 `addEdge()` 为让 CONTAINS 边不悬空而实体化的**文件名桩**，不是符号，
 * 却把真正的 `variable`/`function` 命中挤出了 LIMIT。
 *
 * ★ 为什么用**黑名单**而不是符号白名单：索引器/新语言提取器会不断新增类型
 * （如 `module`，未来可能的 `macro`/`typedef`），白名单会把新类型**静默藏掉**；
 * 黑名单只排除「确定不是符号」的容器/桩类型，新类型默认仍然可见。
 *
 * 比较时**大小写不敏感**（图里同时存在 `file`（addEdge 桩）与 `File`（架构视图合成））。
 */
export const NON_SYMBOL_NODE_TYPES: readonly string[] = ['file', 'folder', 'project'];

export const AST_TO_NODE_TYPE: Record<string, string> = {
	'function_declaration': 'function',
	'function_definition': 'function',
	'function_item': 'function',
	'method_definition': 'function',
	'method_declaration': 'function',
	'constructor_declaration': 'function',
	'destructor_declaration': 'function',
	'class_declaration': 'class',
	'class_definition': 'class',
	'class_specifier': 'class',
	'impl_item': 'class',
	'struct_specifier': 'class',
	'interface_declaration': 'interface',
	'type_alias_declaration': 'interface',
	'trait_item': 'interface',
	'protocol_declaration': 'interface',
	'enum_declaration': 'enum',
	'enum_item': 'enum',
	'enum_specifier': 'enum',
	'variable_declarator': 'variable',
	'global_variable_declaration': 'variable',
	'const_item': 'variable',
	'static_item': 'variable',
};

/**
 * 计算「不属于当前工作区、需要从内存图 store 丢弃」的项目（2026-09-15）。
 *
 * 背景：`CodebaseGraphService` 是**窗口内单例**，而工作区切换走
 * `replaceWorkspaceFoldersInMemory()`（**不 reload renderer**）⇒ 旧工作区的图会永久驻留内存。
 * 实测同窗口 3 个工作区共 1,119,421 节点（S1Game 34 万 + UE5EA 78 万 + 本仓），
 * 后果：① 检索的项目收敛指向别的工作区（用户报「工作区是 sarosis 却按 S1Game 检索」）；
 * ② 巨量堆 + 每 folder 一个 watcher ⇒ UI 卡死。
 *
 * 纯函数（服务本体依赖 DI、无法单测；判据下沉到这里锁死语义）。
 *
 * @param storeProjects 内存 store 当前的项目（只需 name）
 * @param workspaceProjects 当前工作区各 folder 对应的项目名（空数组 = 无工作区）
 * @returns 需要丢弃的项目名；**无工作区时返回空数组**（宁可不判断，也不误删）
 */
export function planForeignProjectPrune(
	storeProjects: readonly string[],
	workspaceProjects: readonly string[],
): string[] {
	if (workspaceProjects.length === 0) { return []; }
	const keep = new Set(workspaceProjects);
	return storeProjects.filter(p => !keep.has(p));
}
