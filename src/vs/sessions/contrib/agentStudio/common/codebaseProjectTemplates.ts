/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 常见项目类型的索引模板（2026-08-19）。
 *
 * 目的：当工作区是「从文件夹添加」的多项目父目录（无 .code-workspace）时，
 * 让 codebase 工具在检测到未索引的巨型目录后，向用户推荐一个「项目类型 → 该忽略的目录」
 * 的索引模板，避免全量索引把 UE/Unity/Node 依赖等非源码目录一起扫进去。
 *
 * 每个模板声明：
 *  - markers: 判定该类型的特征文件/目录（只做顶层名匹配，不递归，避免扫描开销）
 *  - excludeDirs: 该类型应排除的目录名（并入 COMMON_EXCLUDE_DIRS 使用，见 mergeExcludeDirs）
 *  - label / hint: 供 LLM 与用户在对话里理解的描述
 *
 * 注意：目录名匹配与 codebaseGraphService._isExcluded 一致，大小写不敏感。
 */

export interface IProjectIndexTemplate {
	/** 唯一 key，供工具结果回传（如 "unreal"）。 */
	id: string;
	/** 展示名。 */
	label: string;
	/** 判定特征：顶层存在这些文件/目录名之一即命中（大小写不敏感）。 */
	markers: readonly string[];
	/** 该类型应排除的目录名。 */
	excludeDirs: readonly string[];
	/** 给用户的一句话说明。 */
	hint: string;
}

export const PROJECT_INDEX_TEMPLATES: readonly IProjectIndexTemplate[] = Object.freeze([
	{
		id: 'unreal',
		label: 'Unreal Engine',
		markers: ['*.uproject', 'Engine', 'Binaries', 'Intermediate'],
		excludeDirs: [
			'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache',
			'ThirdParty', 'Content', 'Config', 'Build', 'Programs', 'Documentation',
		],
		hint: '忽略引擎构建产物与二进制资产，保留 Source / Plugins 源码。',
	},
	{
		id: 'unity',
		label: 'Unity',
		markers: ['Assets', 'ProjectSettings', 'Packages'],
		excludeDirs: ['Library', 'Temp', 'obj', 'Logs', 'Builds', 'Build', 'UserSettings'],
		hint: '忽略 Library/Temp 等生成目录，保留 Assets/Scripts 源码。',
	},
	{
		id: 'node',
		label: 'Node.js / 前端',
		markers: ['package.json', 'node_modules', 'yarn.lock', 'pnpm-lock.yaml'],
		excludeDirs: ['node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache'],
		hint: '忽略依赖与构建产物，保留 src/lib 源码。',
	},
	{
		id: 'java',
		label: 'Java / Maven / Gradle',
		markers: ['pom.xml', 'build.gradle', 'settings.gradle', 'gradlew'],
		excludeDirs: ['target', 'build', 'out', '.gradle', '.idea', 'bin'],
		hint: '忽略 target/build 编译产物，保留 src/main 源码。',
	},
	{
		id: 'dotnet',
		label: '.NET / C#',
		markers: ['*.sln', '*.csproj'],
		excludeDirs: ['bin', 'obj', 'packages', 'TestResults', 'artifacts'],
		hint: '忽略 bin/obj 编译产物，保留 *.cs 源码。',
	},
	{
		id: 'python',
		label: 'Python',
		markers: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
		excludeDirs: ['__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache'],
		hint: '忽略虚拟环境与字节码缓存，保留 .py 源码。',
	},
]);

/**
 * 根据顶层文件/目录名判定命中的项目类型模板。
 * @param topLevelNames 工作区根目录的顶层条目名（文件与目录都算）。
 * @param existingExclude 已确定的排除目录名（避免重复）。
 */
export function detectProjectTemplates(
	topLevelNames: readonly string[],
	existingExclude?: ReadonlySet<string>,
): IProjectIndexTemplate[] {
	if (!topLevelNames?.length) { return []; }
	const lower = topLevelNames.map(n => n.toLowerCase());
	const hits: IProjectIndexTemplate[] = [];
	for (const tpl of PROJECT_INDEX_TEMPLATES) {
		const matched = tpl.markers.some(m => {
			// 简单 glob 尾匹配：'*.uproject' → 任意 .uproject 文件；否则目录名精确匹配
			if (m.startsWith('*.')) {
				const ext = m.slice(1).toLowerCase();
				return lower.some(n => n.endsWith(ext));
			}
			return lower.includes(m.toLowerCase());
		});
		if (!matched) { continue; }
		if (existingExclude && tpl.excludeDirs.every(d => existingExclude.has(d.toLowerCase()))) {
			continue; // 该模板的排除项已被覆盖，跳过
		}
		hits.push(tpl);
	}
	return hits;
}
