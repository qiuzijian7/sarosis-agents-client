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
	// ★ 2026-10-22（用户报"dev 整个 app 卡死"）：**预装的 dsh 运行时**（`build/prepack-dsh-runtime.mjs`
	//   生成，gitignore）不是源码，是**第三方依赖的物化**——本机实测 **86,782 个文件**
	//   （其中 profile-seed 15,052 个），全被索引 ⇒ 本项目图谱涨到 **40 万节点 / 125 万边**，
	//   而它重写一次（我们重建运行时）还会让 watcher 看到"删了几千个文件" ⇒ 增量补丁 169s
	//   ⇒ DB 落后 19.4 万节点 ⇒ **强制全量追平**（实测 551,936ms ≈ 9.2 分钟）⇒ 主进程在
	//   1.2GB 的 WAL 上阻塞 ⇒ 整个 app 僵死（0% CPU、inspector 无响应）✗✗✗。
	//   ⇒ 排除它：既掐掉"量级失控"，也掐掉"重写运行时 ⇒ 误报删除 ⇒ 强制全量"这条链 ✓。
	'dsh-runtime',
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
		'.vscode-test', '.codebase-memory', '.sarosworkspace', 'dsh-runtime',
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
 * 计算「不属于当前工作区、需要从内存图 store 丢弃」的项目（2026-09-15；2026-09-16 加 **root 判据**）。
 *
 * 背景：`CodebaseGraphService` 是**窗口内单例**，而工作区切换走
 * `replaceWorkspaceFoldersInMemory()`（**不 reload renderer**）⇒ 旧工作区的图会永久驻留内存。
 * 实测同窗口 3 个工作区共 1,119,421 节点（S1Game 34 万 + UE5EA 78 万 + 本仓），
 * 后果：① 检索的项目收敛指向别的工作区（用户报「工作区是 sarosis 却按 S1Game 检索」）；
 * ② 巨量堆 + 每 folder 一个 watcher ⇒ UI 卡死。
 *
 * ★★ 2026-09-16 修（用户报「GR_ 与 PJDB 同名 S1Game 互相污染」）：
 * **项目名不是身份，root 才是**。旧判据只比名字 ⇒ 切到 `D:\GR_\S1Game` 时，内存里那份来自
 * `D:\PJDB\S1Game` 的 `S1Game` 因**同名**被判为「属于本工作区」而保留 ⇒ 旧工作区的图继续驻留
 * 并污染检索（上条事故的「同名变体」）。现在：只要该项目能从映射里查到 root，就**以
 * 「root 是否属于当前工作区」为准** ⇒ 只有**外来 root** 的同名项目会被丢弃 ✓。
 *
 * ⚠ 已知局限（无法在纯函数层解决，见服务侧 `[prune] same-name` 告警）：store / SQLite 的
 * 项目名是**唯一键**，因此「同一个项目名对应多个 root」（GR_ 与 PJDB 同时被加载过）时，
 * 两份数据在内存里**已经合并、无法再按 root 拆开** ⇒ 此时保留（不误删当前工作区的数据），
 * 只告警。彻底修需要「项目名按 root 唯一」（另议）。
 *
 * 保守回退（宁可**不删**，与「无工作区 ⇒ 返回空数组」同一条原则）：
 *   · 项目在映射里查不到 root（如 `_default`、或从 SQLite 按名载入尚未注册 root）⇒ 退回按名判据；
 *   · 未提供 `workspaceRoots` / `rootProjectMap`（旧调用方）⇒ 全部退回按名判据（行为不变）。
 *
 * 纯函数（服务本体依赖 DI、无法单测；判据下沉到这里锁死语义）。
 *
 * @param storeProjects 内存 store 当前的项目（只需 name）
 * @param workspaceProjects 当前工作区各 folder 对应的项目名（空数组 = 无工作区）
 * @param rootProjectMap **归一化 root → 项目名**（service 的 `_rootProjectMap`）
 * @param workspaceRoots 当前工作区各 folder 的**归一化 root**
 * @returns 需要丢弃的项目名；**无工作区时返回空数组**（宁可不判断，也不误删）
 */
export function planForeignProjectPrune(
	storeProjects: readonly string[],
	workspaceProjects: readonly string[],
	rootProjectMap?: ReadonlyMap<string, string>,
	workspaceRoots?: readonly string[],
): string[] {
	if (workspaceProjects.length === 0) { return []; }
	const keepByName = new Set(workspaceProjects);

	// root 判据：项目名 → 它已知的 root 列表（同名不同目录 ⇒ 一个名字对多个 root）
	const wsRoots = new Set(workspaceRoots ?? []);
	const projectRoots = new Map<string, readonly string[]>();
	if (rootProjectMap) {
		for (const [root, proj] of rootProjectMap) {
			const arr = projectRoots.get(proj);
			if (arr) { (arr as string[]).push(root); } else { projectRoots.set(proj, [root]); }
		}
	}

	return storeProjects.filter(p => {
		if (wsRoots.size > 0) {
			const roots = projectRoots.get(p);
			// 有 root 信息 ⇒ 以 root 为准：保留条件是「**任一** root 属于当前工作区」
			// ⇒ 反过来说，**没有任何** root 属于工作区 = 上一条事故的「同名残留」⇒ 丢弃。
			if (roots) { return !roots.some(r => wsRoots.has(r)); }
		}
		// 无 root 信息（`_default` / 按名载入 / 旧调用方）⇒ 按名（保守）：不在工作区项目名里才丢
		return !keepByName.has(p);
	});
}

/**
 * 是否应**延迟加载**某 folder 的图谱（2026-09-15 用户裁决「方案 C」）。
 *
 * 背景：`codebaseGraphBootstrap._bootstrap()` 原本无条件加载**所有** folder 的图，
 * 而图谱解压/反序列化是 CPU/内存密集的**同步**重活 —— 实测：
 *   · `sarosis-agents-client` 8.2MB ⇒ 21.6s / 17.9 万节点
 *   · `S1Game` 7MB ⇒ 6.8s / 16 万节点
 *   · **`UE5EA`（S1Game 工作区的非主 root）24.6MB ⇒ 数十秒 / 87.6 万节点**
 * ⇒ 每次切到「含大图非主 root」的工作区都整窗卡死数十秒（用户报「切换工作区后 app 卡死」）。
 *
 * 但**默认检索作用域只到主 root**（`_resolveActiveProject()` 按 folder 顺序取第一个有映射的
 * 项目；`searchGraphAsync` 用 `params.project ?? _projectName`）⇒ 非主图在「打开工作区」
 * 这一刻并不必要 ⇒ 延迟到**真正用到**时（codebase 工具 / 子代理预检会调
 * `ensureDeferredGraphsLoaded()`）再加载。
 *
 * 纯函数（bootstrap 是 DI 贡献类、无法单测；判据下沉到这里锁死语义）。
 *
 * @param folderIndex 该 folder 在工作区 `folders` 中的下标（**0 = 主 root，永不延迟**）
 * @param artifactSizeBytes `graph.db.zst` 的字节数（文件不存在/读不到时传 0）
 * @param deferLargeNonPrimaryRootsMB 设置值（MB）；**<= 0 表示关闭延迟**（保持旧行为）
 * @param alreadyDeferred 该 folder 是否已在延迟集合里（幂等：一旦延迟就保持）
 */
export function shouldDeferGraphLoad(
	folderIndex: number,
	artifactSizeBytes: number,
	deferLargeNonPrimaryRootsMB: number,
	alreadyDeferred = false,
): boolean {
	// 幂等优先：已延迟的直接保持，避免每次 folder 事件又 stat 一遍并可能改判。
	if (alreadyDeferred) { return true; }
	// 关闭延迟 ⇒ 旧行为（打开工作区即加载全部）。
	if (deferLargeNonPrimaryRootsMB <= 0) { return false; }
	// 主 root 永不延迟 —— 它就是默认检索作用域，延迟它等于让首次查询缺数据。
	if (folderIndex <= 0) { return false; }
	return artifactSizeBytes > deferLargeNonPrimaryRootsMB * 1024 * 1024;
}

/** 外部产物重载的**节流下限**：连续检测到外部写入时，两次重载之间的最小间隔（见下）。 */
export const EXTERNAL_ARTIFACT_RELOAD_MIN_INTERVAL_MS = 5000;

/** 外部产物**轮询**间隔（IDE 侧 `codebaseGraphBootstrap` 的定时器用它）。 */
export const EXTERNAL_ARTIFACT_POLL_INTERVAL_MS = 10_000;

/**
 * **dsh 侧**写进 `artifact.json` 的 `producer` 取值 —— 两侧的**所有权契约**（2026-10-13，用户裁决
 * 「权限都在 dsh 侧全权处理、逻辑也都转移到 dsh 侧」）。
 *
 * 语义：**这个目录里的图谱归 dsh 负责**。IDE 侧见到它 ⇒ **不索引、不落盘、不删目录**，
 * 只负责"读 + 发现变化就重载"（见 `codebaseGraphBootstrap` 的外部产物感知 ✓）。
 *
 * 为什么用"制品里带一个键"而不是"IDE 侧配置项"：
 *   · **权限在 dsh**：谁产出谁声明 ✓ —— IDE 不需要（也不应该）自己判断"该不该让路" ✗；
 *   · 不需要动 IDE 的配置表（那张表在并发改动区，且新增配置项 = 用户还需手动开 ✓）；
 *   · 天然可逆：dsh 的制品被删掉、或 IDE 后来自己写了一份（不带这个键）⇒ 权限就回到 IDE ✓。
 *
 * ⚠ **向后兼容**：IDE 侧对 `artifact.json` 是**按键内联读取**（只认 `node_count` / `saved_at` 等 ✔），
 * 多一个键不影响它 ✓（dsh 侧同理 ✓）。⇒ 两侧都不需要"严格 schema"的迁移 ✓。
 */
export const DSH_ARTIFACT_PRODUCER = 'vssaros-dsh';

/** 从清单里读"谁产出的"（读不出 / 不是字符串 ⇒ `undefined`）。 */
export function artifactProducerOf(manifest: unknown): string | undefined {
	if (!manifest || typeof manifest !== 'object') { return undefined; }
	const raw = (manifest as { producer?: unknown }).producer;
	return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * 这份清单是不是 **dsh 产出**的（⇒ IDE 侧不该写它所在的目录）。
 *
 * 保守口径（与判据族其它成员一致 ✓）：
 *   · 清单不是对象 / 缺 `producer` / `producer` 不是字符串 ⇒ **false**（= 当成"本窗口的制品"，
 *     行为与今天完全一致 ✓ —— 老制品、手写制品、我们自己的制品都走这条 ✓）；
 *   · 只有明确等于 `DSH_ARTIFACT_PRODUCER` 才 true ✓（不做"包含/前缀"之类的宽松匹配 ✗）。
 */
export function isDshProducedManifest(manifest: unknown): boolean {
	return artifactProducerOf(manifest) === DSH_ARTIFACT_PRODUCER;
}

/** 一次「这份图有多新」的观测（磁盘上的制品 / 内存里已加载的那份，**同口径** ✓）。 */
export interface IArtifactFreshness {
	/** `artifact.json` 自称的保存时间（ms）—— **首选判据**（IDE 与 dsh 两侧写的是同一个键 ✓） */
	savedAt?: number;
	/** `artifact.json` 的 mtime（ms）—— `savedAt` 缺失时的兜底（老制品 / 别人手写的） */
	mtimeMs?: number;
	/**
	 * 制品里的节点数。**用途有三，都不是"新旧判据"**：
	 *   ① 报告（"换成了多大的图"）；
	 *   ② **空制品守卫**（磁盘 0 节点不许换掉内存里的好图）；
	 *   ③ **自我写识别**（见下 `decideExternalArtifactReload` 的第 6 条）。
	 */
	nodeCount?: number;
	/** 制品里的边数（同上，仅用于 ③ 自我写识别 —— 单看节点数可能在"重排后节点数相同"时误判）。 */
	edgeCount?: number;
}

export interface IExternalReloadContext {
	/**
	 * 本窗口**正在写盘 / 正在索引** ⇒ 一律不重载。
	 *
	 * 为什么这条必须在最前面：重载 = `deleteProject` + 重新解析制品 ⇒ 会把**尚未落盘的内存状态**
	 * 一起丢掉（增量索引中途 / `_saveGraph` 的 30s 防抖窗口内）✗✗。
	 */
	writeInFlight: boolean;
	/** 上次因外部写入重载的时间（ms）；未重载过 ⇒ 传 `undefined` */
	lastReloadAt?: number;
	/** 当前时间（ms）—— 显式传入，纯函数不读时钟 ✓ */
	now: number;
	/** 覆盖节流下限（ms）；缺省 `EXTERNAL_ARTIFACT_RELOAD_MIN_INTERVAL_MS` */
	minIntervalMs?: number;
}

export type ExternalReloadDecision =
	| { reload: true; reason: string; onDiskFreshness: number }
	/**
	 * `adoptAsBaseline`：不重载，但**调用方必须把基线更新成磁盘那份** ✓
	 * （唯一情形 = 判定"磁盘上这份就是本窗口自己刚落盘的内存镜像"，见第 6 条）。
	 */
	| { reload: false; reason: string; adoptAsBaseline?: boolean };

/** 取"多新"：优先 `savedAt`，读不出才退回 mtime（**两侧必须用同一个函数**，否则判据会自相矛盾）✓。 */
export function artifactFreshnessOf(state: IArtifactFreshness | undefined): number | undefined {
	if (!state) { return undefined; }
	const declared = Number(state.savedAt);
	if (Number.isFinite(declared) && declared > 0) { return declared; }
	const mtime = Number(state.mtimeMs);
	return Number.isFinite(mtime) && mtime > 0 ? Math.round(mtime) : undefined;
}

/**
 * 要不要因为「**别人把制品换新了**」而重载内存里的图（2026-10-13，所有权交接的 IDE 半边）。
 *
 * ## 为什么需要它
 *
 * 交接之后 `<工作区>/.codebase-memory/` 的**写者会变成 dsh**（Host 进程里的 `@vssaros/dsh-codebase`，
 * 见 `doc/codebase-index-to-dsh-plan.html` §5 P3）。而 IDE 这边的图谱是**一次性读进内存**的
 * （`CodebaseGraphService._graph`）—— 没有任何机制会去发现"盘上那份被换了" ⇒
 * **IDE 会永远用着打开工作区那一刻的旧图** ✗✗（用户视角：「dsh 明明重新索引了，IDE 里行号还是旧的」）。
 *
 * ⇒ 这一层就是"感知外部写入"，它让**同步消费者一个字都不用改**（对照：把 `hasGraphData()` /
 * `getClassHierarchy()` 那些同步读全部 async 化的代价要大得多，且会踩源码级顺序断言）。
 *
 * ## 判据（逐条都有理由，且**保守**）
 *
 *   1. 磁盘上读不出"多新" ⇒ **不重载**（不猜 ✗）；
 *   2. 内存里还没加载过 ⇒ **不重载**（首次加载走既有 bootstrap / 延迟加载路径 ✓，这里只负责"换新"）；
 *   3. 本窗口在写盘/索引 ⇒ **不重载**（会丢未落盘的状态 ✗）；
 *   4. 磁盘那份**不比**内存里那份新 ⇒ 不重载（**含平手**：平手最常见的情形就是"我们自己刚写完" ✓）；
 *   5. 磁盘制品**节点数为 0** 而内存里有节点 ⇒ **不重载**（本仓有过 8.2MB 图被覆盖成 99 字节的事故，
 *      `_saveGraph` 的 0 节点守卫就是为它加的 ⇒ 这里同样不许拿空图换掉好图 ✗）；
 *   6. 磁盘那份**比内存新、且节点数与边数都与内存里的**一致 ⇒ 判为「**本窗口自己刚落盘的那份**」，
 *      不重载、但把基线跟着更新 ✓；
 *      ⚠ 这一条必须要有：IDE 的落盘是**延迟合并**的（`SAVE_DEBOUNCE_MS`）—— 盘上的 `saved_at` 会比
 *      我们最后一次记录的基线**新**，而内容其实就是内存里这份 ⇒ 没有这条就会把自己的写当外部写、
 *      白做一次"删项目 + 重新解析"的重活 ✗（连续增量索引时尤其明显）；
 *   7. 距上次外部重载不足 `minIntervalMs` ⇒ 不重载（重载是"删项目 + 重新解析"的重活，
 *      连续外部写入时必须节流 ✓）。
 *
 * ⚠ **调用方的一条硬纪律**：本窗口**自己**做完一次加载/索引之后，必须把"内存里这份图对应哪次保存"
 * 记成基线 ✓（加载完 ⇒ 基线 = 当时磁盘的 `saved_at`；索引完 ⇒ 内存比磁盘新，等落盘后由第 6 条
 * 自动把基线跟上去 ✓）。否则第 4 条会把我们**自己的写**当成外部写 ✗。
 *
 * ⚠ **本函数不解决、也解决不了的**：本窗口**待发的延迟保存**（30s 防抖窗口内）可能覆盖别人才写下的
 * 新制品（**写-写竞争**）✗ —— 那要靠"IDE 侧索引器让路/停写"那一刀（`doc/codebase-index-to-dsh-plan.html`
 * §5 P3 待办 ①）。这里刻意**不去 flush**（`flushPendingSave()`）：把延迟写提前落下只会让那次覆盖更早发生，
 * 并不能避免它 ✓（不如把这件事留给它该待的地方 ✓）。
 *
 * 纯函数（bootstrap 是 DI 贡献类、无法单测；判据下沉到这里锁死语义 —— 与 `shouldDeferGraphLoad` 同款）。
 */
export function decideExternalArtifactReload(
	onDisk: IArtifactFreshness | undefined,
	loaded: IArtifactFreshness | undefined,
	ctx: IExternalReloadContext,
): ExternalReloadDecision {
	const diskFresh = artifactFreshnessOf(onDisk);
	if (diskFresh === undefined) {
		return { reload: false, reason: '磁盘上读不出"多新"（没有 artifact.json / 缺 saved_at 与 mtime）⇒ 不猜 ✗' };
	}
	const loadedFresh = artifactFreshnessOf(loaded);
	if (loadedFresh === undefined) {
		return { reload: false, reason: '本窗口还没加载过这个项目的图 ⇒ 首次加载走既有路径（这里只负责"换新"）' };
	}
	if (ctx.writeInFlight) {
		return { reload: false, reason: '本窗口正在写盘/索引 ⇒ 不重载（会把尚未落盘的内存状态一起丢掉 ✗）' };
	}
	if (diskFresh <= loadedFresh) {
		return { reload: false, reason: `磁盘上的不比内存里的新（${diskFresh} ≤ ${loadedFresh}）—— 平手最常见的情形就是"我们自己刚写完" ✓` };
	}
	// 空制品守卫：只在"本来有图"时生效（内存里 0 节点 ⇒ 换不换都一样，交给上面第 4 条 ✓）
	const diskNodes = Number(onDisk?.nodeCount);
	const loadedNodes = Number(loaded?.nodeCount);
	if (Number.isFinite(diskNodes) && diskNodes === 0 && Number.isFinite(loadedNodes) && loadedNodes > 0) {
		return { reload: false, reason: `磁盘制品是空的（0 节点）而内存里有 ${loadedNodes} 个 ⇒ 不拿空图换好图 ✗` };
	}
	// 第 6 条：自我写识别 —— 节点数**与边数**都一致 ⇒ 盘上这份就是内存镜像（延迟落盘的那次）✓
	const diskEdges = Number(onDisk?.edgeCount);
	const loadedEdges = Number(loaded?.edgeCount);
	if (Number.isFinite(diskNodes) && Number.isFinite(loadedNodes) && diskNodes === loadedNodes
		&& Number.isFinite(diskEdges) && Number.isFinite(loadedEdges) && diskEdges === loadedEdges) {
		return {
			reload: false,
			adoptAsBaseline: true,
			reason: `磁盘上的比基线新（${diskFresh} > ${loadedFresh}），但节点/边数与内存里的逐个一致（${diskNodes}/${diskEdges}）⇒ 判为**本窗口自己刚落盘**的那份 ⇒ 只更新基线，不重载 ✓`,
		};
	}
	const minInterval = ctx.minIntervalMs ?? EXTERNAL_ARTIFACT_RELOAD_MIN_INTERVAL_MS;
	if (ctx.lastReloadAt !== undefined && ctx.now - ctx.lastReloadAt < minInterval) {
		return { reload: false, reason: `距上次外部重载不足 ${minInterval}ms（节流；重载是"删项目 + 重新解析"的重活 ✓）` };
	}
	return {
		reload: true,
		onDiskFreshness: diskFresh,
		reason: `磁盘上的制品比内存里的新（${diskFresh} > ${loadedFresh}${Number.isFinite(diskNodes) ? `，节点 ${diskNodes}≠${Number.isFinite(loadedNodes) ? loadedNodes : '?'}` : ''}）⇒ 别人重写过这份图，重载 ✓`,
	};
}
