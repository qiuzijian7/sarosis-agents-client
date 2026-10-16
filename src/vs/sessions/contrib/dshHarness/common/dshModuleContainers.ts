/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内置模块 → ActivityBar 容器 的聚合表与"该注册哪些容器"的纯计算（方案 6.5 / 6.11.5 决议）。
 *
 * 决议①（v1.2.8）：插件清单保持单体（1 插件 : 1 容器），"多插件共容器"由本表在 VsSaros 侧聚合
 * ——`agentStudio.integration` 依赖 {skills, mcp}、`agentStudio.knowledgeBase` 依赖 {kb, memory}，
 * 任一依赖模块激活即注册容器，全部停用即注销。
 * 决议③：容器内的页面一律 `view.kind=page`（插件自托管），所以这里只登记"容器与依赖"，
 * 页面路由由插件清单给出。
 *
 * 纯逻辑、无 I/O：`planModuleContainers()` 的输入是「引擎 + 已装插件名 + 当前已注册容器」，
 * 输出是一份可执行的注册/注销计划；注册表操作留给渲染进程贡献（`dshActivityBarContribution.ts`）。
 */

import type { IVssarosActivityBar } from './vssarosPluginManifest.js';

export type DshModuleEngine = 'legacy' | 'dsh';

/** 内置模块 id（与 `@vssaros/dsh-<module>` 包名一一对应，见方案 6.6）。 */
export type DshModuleId =
	| 'skills' | 'mcp' | 'kb' | 'memory' | 'media' | 'codebase' | 'kanban' | 'workflow' | 'agents' | 'dashboard' | 'ide' | 'channels'
	// 2026-10-12：历史会话 sideview 的 dsh 页面（`@vssaros/dsh-sessions`）。
	// **它有自己的容器**（`vssaros.dsh.sessions`，`page-only`）—— 见下面 DSH_BUILTIN_MODULES 那条的说明。
	| 'sessions'
	// 2026-10-15：多平台内容导入（`@vssaros/dsh-web-content-import`）。**纯工具、无页面** ⇒ 无图标模块形态
	// （同 ide / channels：在 DSH_BUILTIN_MODULES、不在容器表、清单 view.kind='none'）。
	| 'web-content-import';

export interface IDshBuiltinModule {
	readonly module: DshModuleId;
	/** 插件包名（profile 里已装插件的身份，用于反查模块是否激活）。 */
	readonly pluginName: string;
	/** 方案 6.6 的模块级职责一句话说明（诊断与插件中心展示用）。 */
	readonly summary: string;
}

export const DSH_BUILTIN_MODULES: readonly IDshBuiltinModule[] = [
	{ module: 'skills', pluginName: '@vssaros/dsh-skills', summary: '内置与用户技能目录注册为 dsh 技能来源' },
	{ module: 'mcp', pluginName: '@vssaros/dsh-mcp', summary: 'MCP 服务器清单动态挂载' },
	{ module: 'kb', pluginName: '@vssaros/dsh-kb', summary: '资料库检索 / 导入 / 构建工具与页面' },
	{ module: 'memory', pluginName: '@vssaros/dsh-memory', summary: '工作记忆注入与记忆提取（独立工作台：/x/memory/）' },
	// 媒体库紧跟 memory（都属于「资料库」拆出来的四格之一）：它**只读**直连主进程 media.db。
	{ module: 'media', pluginName: '@vssaros/dsh-media', summary: '媒体库：只读直连主进程 media.db（资产列表 / 统计）' },
	{ module: 'codebase', pluginName: '@vssaros/dsh-codebase', summary: '代码图谱服务与查询工具（在 Host 进程内运行）' },
	{ module: 'kanban', pluginName: '@vssaros/dsh-kanban', summary: '看板存储与卡片工具' },
	{ module: 'workflow', pluginName: '@vssaros/dsh-workflow', summary: '工作流引擎（Host worker_threads）与画布' },
	{ module: 'agents', pluginName: '@vssaros/dsh-agents', summary: '.agent.md 注册为 dsh agent preset' },
	{ module: 'dashboard', pluginName: '@vssaros/dsh-dashboard', summary: '会话遥测 / 用量汇总（可选）' },
	{ module: 'ide', pluginName: '@vssaros/dsh-ide', summary: 'IDE 能力工具（无 ActivityBar 图标）' },
	{ module: 'channels', pluginName: '@vssaros/dsh-channels', summary: '飞书 / Telegram 渠道适配器（无 ActivityBar 图标）' },
	// 2026-10-12：历史会话 sideview 的 dsh 页面（`@vssaros/dsh-sessions`，只读，页面 + `/x/sessions/api/sessions`）。
	// ⚠ 它**不借用常驻容器** `sessionHistory.view`（那是 `DSH_ALWAYS_REGISTERED_CONTAINERS` 的一员，两条既有守卫
	//   明确要求"常驻容器不受模块引擎影响、且不得与模块容器表重叠"）—— 而是**自带一个容器**
	//   `vssaros.dsh.sessions`（`page-only`，范式同 canvas / 代码图谱）。
	//   于是**两个入口并存**：常驻的历史会话（壳侧 DOM pane，另一条流在维护）与这个 dsh 自绘页。
	//   为什么不让前者让位：那等于把另一条流**正在改**的 UI 就地换掉；要不要退休 DOM pane 是协调决定，
	//   不是实现细节（本表只加了一格图标，删掉即回退）。
	{ module: 'sessions', pluginName: '@vssaros/dsh-sessions', summary: '历史会话 dsh 页（按工作区分组 + 人格标记 + 运行/等待指示灯；只读）' },
	// 2026-10-15：多平台内容导入（纯工具、无页面 ⇒ 无图标模块形态；页面/容器都不加）。
	{ module: 'web-content-import', pluginName: '@vssaros/dsh-web-content-import', summary: '按 URL 抓平台文章/视频内容（HTTP+reader / yt-dlp+字幕/ASR），可写进知识库 库/raw/' },
];

/**
 * 模块化容器的状态：
 * - `existing`：VsSaros 已有对应页面（动态注册时直接复用现有 ViewPane / page 宿主）；
 * - `page-only`：**只由插件页面承载**——`engine=dsh` 时正常注册 page 宿主（`DshPluginViewPane`），
 *   但 `engine=legacy` 侧**故意没有**对应视图（如代码图谱：legacy 那个 `agentStudio.graphView` 是
 *   Git 提交历史图，不是代码图谱）。守卫对它的要求 = `planned` 的"静态侧完全没有" + 非 planned 的
 *   "必须有 page 宿主"；
 * - `planned`：方案规划了图标但**当前没有页面**，计划里只报告不注册（现在没有实例，语义保留）；
 * - `aggregated`：不单独占用容器，只影响所在容器的可见性（如 memory 寄居资料库页）。
 */
export type DshModuleContainerStatus = 'existing' | 'page-only' | 'planned' | 'aggregated';

export interface IDshModuleContainer {
	readonly containerId: string;
	/** 任一依赖模块激活即显示；全部停用即注销（决议①聚合语义）。 */
	readonly modules: readonly DshModuleId[];
	readonly status: DshModuleContainerStatus;
	readonly activityBar: IVssarosActivityBar;
	/** 计划采纳与否的说明（诊断 / 插件中心展示）。 */
	readonly note?: string;
}

/**
 * 由 VsSaros 侧驱动可见性的模块容器表（决策③：内部页面一律 page；`vssaros.*` 属 VsSaros 自有命名空间）。
 * 常驻容器（Workspace / Search / SCM / Session History / Plugins 与方案 6.5.1 的其它栏位）不在本表内：
 * 它们由静态注册负责，两种引擎下都始终存在。
 *
 * ⚠ 2026-10-12 记：把 Session History 登记进本表**已被两条既有守卫否决**（源码守卫的
 * 「常驻容器不受模块引擎影响（仍是静态注册）」+ 本表不变量「容器不重叠常驻集合」）——
 * 两套机制会争同一个容器。要让历史会话改由 dsh 插件页绘制，必须先决定是否**正式把它移出常驻集合**
 * （代价：不再是"两引擎都在"、独立聊天窗口左栏要另行承载）。在那之前插件 `@vssaros/dsh-sessions`
 * 的页面只能直接访问 `/x/sessions/`，不接活动栏。
 */
export const DSH_MODULE_CONTAINERS: readonly IDshModuleContainer[] = [
	{
		containerId: 'vssaros.dsh.codebase', modules: ['codebase'], status: 'existing',
		// ★ 2026-10-12（Q2 决议，用户：「继续执行」= 采纳对比稿推荐的 B）：order **25 → 113**，
		//   挪到「资料库系」另三格之后（知识库 110 / 记忆库 111 / 媒体库 112 ⇒ 代码库 113 = 家族末位），
		//   四格从此**相邻** ✓。原值 25 是它当年作为「代码图谱」时的位置（那时它还不属于资料库系）⇒
		//   拆分完成后才显出"离队"（对比稿：`doc/activitybar-order-q2.html`）。
		// ⚠ 与静态注册侧（`agentStudio.contribution.ts` 的 `_registerModuleToolIcon`）**必须同值** ——
		//   否则两套引擎下位置不一致；只改一处会被 `dshModuleContainers.test.ts` 的
		//   "模块插件的清单与 VsSaros 聚合表逐项一致（含 order）"当场抓住 ✓。
		// ⚠ 对**已用过的窗口**不生效：活动栏顺序首次运行即落在 storage `workbench.activity.pinnedViewlets2`
		//   （`updateCompositeBarItemsFromStorage()` 以它为准，注册期 order 只决定**新出现**的容器插在哪）。
		activityBar: { containerId: 'vssaros.dsh.codebase', title: { zh: '代码库', en: 'Codebase' }, icon: 'codicon:type-hierarchy', order: 113 },
		note: '2026-10-12（「资料库」拆分第一刀）：**page-only → existing**，显示名「代码图谱」→「代码库」。原因是它被提升为「资料库」4 个 tab 之一（code）的独立工作台：`engine=dsh` 仍走插件页面 `/x/codebase/`；`engine=legacy` 侧现在**有**静态入口 `CodebaseLibraryViewPane`（索引统计 + 日志 + 图谱查看器入口；原先 legacy 无入口是因为当时 legacy 侧根本没有这个 tab 的宿主）。⚠ 容器 id / 视图 id `vssaros.dsh.codebaseView` **一字未改**（改 id 会丢用户已存的活动栏布局）。图谱的**生产**（tree-sitter 索引）仍在 IDE 侧。｜ 2026-10-12（Q2）：order `25 → 113`，与另三格（110/111/112）聚成一段 ✓。',
	},
	{
		containerId: 'agentStudio.presetAgent', modules: ['agents'], status: 'existing',
		activityBar: { containerId: 'agentStudio.presetAgent', title: 'Agents', icon: 'codicon:robot', order: 60 },
	},
	{
		containerId: 'agentStudio.tasks', modules: ['kanban'], status: 'existing',
		activityBar: { containerId: 'agentStudio.tasks', title: 'Tasks', icon: 'codicon:tasklist', order: 70 },
	},
	{
		containerId: 'agentStudio.workflow', modules: ['workflow'], status: 'existing',
		activityBar: { containerId: 'agentStudio.workflow', title: 'Workflow', icon: 'codicon:list-tree', order: 80 },
	},
	{
		containerId: 'agentStudio.integration', modules: ['skills', 'mcp'], status: 'existing',
		// 2026-10-15：显示名「集成」→「工具」（用户要求）—— 这个容器装的就是**技能 + MCP（= 模型可用的工具面）**，
		// 「集成」这个词在中文里既指 MCP 服务器也指数据集成，指代不清 ✓。改的是**标题**，容器 id / 视图 id /
		// 存储键**一字未动**（R1：改 id 会丢用户已存的活动栏布局与视图状态 ✗）。
		// ⚠ 与 `vssaros-skills` 清单里的 `vssaros.activityBar.title` **必须同值**（两处都双语 ✓）。
		activityBar: { containerId: 'agentStudio.integration', title: { zh: '工具', en: 'Tools' }, icon: 'codicon:extensions', order: 90 },
		note: '决议①共容器：skills / mcp 任一激活即显示。｜ 2026-10-15：显示名「集成」→「工具」（容器 id 未动 ✓）。',
	},
	{
		containerId: 'agentStudio.knowledgeBase', modules: ['kb'], status: 'existing',
		activityBar: { containerId: 'agentStudio.knowledgeBase', title: { zh: '知识库', en: 'Knowledge Base' }, icon: 'codicon:book', order: 110 },
		note: '2026-10-12（「资料库」拆分）：**不再共容器** —— `memory` 已拆成一格（见下），本容器现在只由 `kb` 决定可见性；显示名由「资料库」改回「知识库」。⚠ 容器 id 与存储键**一字未动**（R1：不改就丢不掉用户已有的活动栏布局）。（画布**不**寄居这里：它有自己的一格 —— 它读同一份数据，但页面是整页而非片段。）',
	},
	{
		containerId: 'agentStudio.memory', modules: ['memory'], status: 'existing',
		activityBar: { containerId: 'agentStudio.memory', title: { zh: '记忆库', en: 'Memory' }, icon: 'codicon:database', order: 111 },
		note: '2026-10-12（「资料库」拆分）：由资料库页的「记忆」tab 提升为独立工作台 —— 这一刀**正对着决议①的「kb / memory 共容器」**（`DSH_MODULE_PAGES` 里 memory 同时从 `section` 变 `page`）。IDE 侧宿主 `MemoryLibraryViewPane`；容器 id / 视图 id 均为**新建**（不复用 kb 的）。',
	},
	{
		containerId: 'agentStudio.media', modules: ['media'], status: 'existing',
		activityBar: { containerId: 'agentStudio.media', title: { zh: '媒体库', en: 'Media' }, icon: 'codicon:file-media', order: 112 },
		note: '2026-10-12（「资料库」拆分）：由资料库页的「媒体库」tab 提升为独立工作台。IDE 侧宿主 `MediaLibraryViewPane`（经主进程 ProxyChannel 读 mediaStore）；dsh 侧是 `@vssaros/dsh-media` 的只读整页 `/x/media/` —— 它**直连同一个 `{rootDir}/media.db`**（Node 内置 `node:sqlite`，`readOnly: true`）。「多连接并发」是该库既有前提（VsSaros 侧开着 WAL + busy_timeout）；建表 / 迁移的真源仍只在 VsSaros 侧。',
	},
	{
		// 历史会话的 dsh 页（2026-10-12）：`page-only` —— **不自造 legacy 入口**（同 canvas / 代码图谱）：
		// legacy 侧的历史会话是那个**常驻容器** `sessionHistory.view`（壳侧 DOM pane），容器 id / 视图 id 都不同，
		// 两者**并存**（本格只是"dsh 自绘那版"的入口）。见 DSH_BUILTIN_MODULES 里 sessions 那条的说明。
		containerId: 'vssaros.dsh.sessions', modules: ['sessions'], status: 'page-only',
		activityBar: { containerId: 'vssaros.dsh.sessions', title: { zh: '历史会话（插件页）', en: 'Session History (plugin page)' }, icon: 'codicon:comment-discussion', order: 120 },
		note: '2026-10-12：内容由 `@vssaros/dsh-sessions` 的 `/x/sessions/` 承载（分组 / 5 条空闲配额 / 人格标记 / 运行+等待指示灯，只读）。与常驻的历史会话**并存**：后者仍是壳侧 DOM pane（另一条流在维护），本格不接管它（接管 = 换掉别人正在改的 UI，属协调决定）。',
	},
	{
		containerId: 'agentStudio.dashboard', modules: ['dashboard'], status: 'existing',
		// order 5 = **活动栏第一位**（2026-10-12 用户要求；原 150 = 最后一位）。
		// 静态注册侧（`agentStudio.contribution.ts` 的 `_registerModuleToolIcon`）必须同值，
		// 否则两套引擎下 Dashboard 的位置会不一致。
		// ★ 2026-10-13：**显示名与图标**改为「主页 / 小房子」（用户要求）。
		//   ⚠ 只改显示：`containerId` / module id（`dashboard`）/ 路由（`/x/dashboard/`）/ 页面锚点
		//   （`data-vssaros-page="dashboard"`）一律不动 —— 它们被探针（p3-09 / p3-46）、静态注册侧
		//   与活动栏顺序 storage（`workbench.activity.pinnedViewlets2` 按**容器 id** 记）钉着 ⇒ 改必炸 ✗。
		//   ⚠ 与静态注册侧（`agentStudio.contribution.ts` 的 `_registerModuleToolIcon`）**必须同值** ✓
		activityBar: { containerId: 'agentStudio.dashboard', title: '主页', icon: 'codicon:home', order: 5 },
	},
];

/**
 * 各内置模块的**页面形态与路由**（与该模块插件清单的 `vssaros.view` 一致，守卫逐项比对）。
 *
 * 为什么 VsSaros 侧也留一份：容器注册发生在**渲染进程的 ActivityBar 贡献**里，那里读不到插件清单
 * （`IDshPluginInfo` 只有 name / spec / version / enabled）——要在"这个容器该显示哪一页"上不查文件，
 * 就得有一份可查询的表。**它不是第二真源**：`dshPluginPackages.test.ts` 会把它与各插件包的清单
 * 逐项比对（含"没有插件包的模块必须是 none"），改清单不改表会先红。
 *
 * 路由尾斜杠与清单一致（比对时归一化）；`section` 记下宿主模块（清单 `view.host`）。
 */
export interface IDshModulePage {
	readonly module: DshModuleId;
	readonly kind: 'page' | 'section' | 'none';
	/** `page` / `section` 的清单路由；`none` 没有。 */
	readonly route?: string;
	/** `section` 的宿主模块（清单 `view.host`）。 */
	readonly host?: DshModuleId;
}

export const DSH_MODULE_PAGES: readonly IDshModulePage[] = [
	{ module: 'agents', kind: 'page', route: '/x/agents/' },
	{ module: 'codebase', kind: 'page', route: '/x/codebase/' },
	{ module: 'dashboard', kind: 'page', route: '/x/dashboard/' },
	{ module: 'kanban', kind: 'page', route: '/x/kanban/' },
	{ module: 'kb', kind: 'page', route: '/x/kb/' },
	{ module: 'skills', kind: 'page', route: '/x/skills/' },
	{ module: 'workflow', kind: 'page', route: '/x/workflow/' },
	// 2026-10-12（「资料库」拆分）：memory 从「寄居 kb 的片段」变**独立整页**（容器 `agentStudio.memory`）。
	// 插件侧旧的 `/x/memory/section` 片段路由**已删** —— 同批摘掉了知识库页的内嵌记忆分区
	// （`dsh-plugins/vssaros-kb` 的 `fetchMemorySection` 与 `data-vssaros-kb-memory-section` 都没了）。
	{ module: 'memory', kind: 'page', route: '/x/memory/' },
	{ module: 'media', kind: 'page', route: '/x/media/' },
	// 2026-10-12：历史会话 dsh 页（容器 `vssaros.dsh.sessions`）。用它必须与清单 `view.kind` 一致
	// （守卫「DSH_MODULE_PAGES 与插件清单逐项一致」会逐项比对）。
	{ module: 'sessions', kind: 'page', route: '/x/sessions/' },
	// `mcp` **服务器**的挂载仍在 VsSaros 启动时做（一台服务器一个组合行，只能靠 `--patch` 覆盖层）；
	// 但"实际挂了什么、哪些被跳过、为什么"由 `@vssaros/dsh-mcp` 提供一个只读片段，寄居同容器的 skills 页。
	{ module: 'mcp', kind: 'section', route: '/x/mcp/section', host: 'skills' },
	{ module: 'ide', kind: 'none' },
	{ module: 'channels', kind: 'none' },
	// 2026-10-15：多平台内容导入（纯工具、无页面）⇒ kind='none'（与插件清单 view.kind 一致 ✓）。
	{ module: 'web-content-import', kind: 'none' },
];

/** 容器页路由的解析结果（见 {@link pageRouteForActiveModules}）。 */
export interface IDshModulePageResolution {
	readonly module: DshModuleId;
	readonly kind: 'page' | 'section';
	readonly route: string;
}

/**
 * 一个容器**该加载哪一页**：按"已激活 + 真有页面"的模块选，而**不是**容器声明的第一个。
 *
 * 起因（真问题）：注册路径原先用 {@link defaultPageRoute}（= `/x/<modules[0]>/`）。共容器里若只装了
 * 另一个模块（只装 `mcp`、只装 `memory`、只装 `codebase`），那条路由**属于没装的插件** ⇒ 这个面板
 * 必然是 404（"模块图标可见、点开什么都没有"这种最难查）。
 *
 * 规则：按容器声明顺序找第一个"已激活**且**有 route"的模块，**优先 `page`**；只有 `section` 时用它的
 * route（片段本身也是可服务的 HTML）；一个都没有 ⇒ `undefined`（面板给状态说明，不是 404）。
 */
export function pageRouteForActiveModules(
	container: IDshModuleContainer,
	activeModules: readonly DshModuleId[],
	pages: readonly IDshModulePage[] = DSH_MODULE_PAGES,
): IDshModulePageResolution | undefined {
	const active = new Set(activeModules);
	const candidates = container.modules
		.filter(module => active.has(module))
		.map(module => pages.find(page => page.module === module))
		.filter((page): page is IDshModulePage & { route: string; kind: 'page' | 'section' } => !!page?.route && page.kind !== 'none');
	const picked = candidates.find(page => page.kind === 'page') ?? candidates[0];
	// 现构一个对象（而不是直接把表里的行交出去）：返回值就是声明的那三个字段，
	// 不会顺带泄漏 `host` 之类的表内部信息（测试里用 deepStrictEqual 也才写得准）。
	return picked ? { module: picked.module, kind: picked.kind, route: picked.route } : undefined;
}

/** 容器页状态：该加载的页面（可能没有）+ 各模块的激活/页面情况（给"点开为什么是空的"这类说明用）。 */
export interface IDshModulePageState {
	readonly page?: IDshModulePageResolution;
	readonly modules: readonly { readonly module: DshModuleId; readonly active: boolean; readonly route?: string }[];
}

/** 由"容器 + 已激活模块"算出页面状态（纯函数；说明文案也由它派生，免得两处各判一次）。 */
export function resolveContainerPageState(
	container: IDshModuleContainer,
	activeModules: readonly DshModuleId[],
	pages: readonly IDshModulePage[] = DSH_MODULE_PAGES,
): IDshModulePageState {
	const active = new Set(activeModules);
	return {
		page: pageRouteForActiveModules(container, activeModules, pages),
		modules: container.modules.map(module => {
			const entry = pages.find(page => page.module === module);
			return { module, active: active.has(module), ...(entry?.route ? { route: entry.route } : {}) };
		}),
	};
}

/**
 * 常驻容器（两种引擎下都由静态注册负责，模块化容器表不得与之重叠）。
 * 清单口径见方案 6.5 与 6.5.1；此处用于不变式测试与文档对齐。
 */
export const DSH_ALWAYS_REGISTERED_CONTAINERS: readonly string[] = [
	// 侧栏（6.5 常驻）
	'agentStudio.workspace', 'agentStudio.search', 'workbench.view.scm', 'sessionHistory.view', 'agentStudio.plugins',
	// 其它栏位（6.5.1，决议②）
	'vssaros.panel.output', 'terminal', 'workbench.panel.repl', 'workbench.panel.markers',
	'workbench.view.agentSessions.changesContainer', 'workbench.panel.chat',
];

const MODULE_BY_PLUGIN_NAME = new Map<string, DshModuleId>(DSH_BUILTIN_MODULES.map(m => [m.pluginName, m.module]));

/** 已装插件包名 → 内置模块 id；不是内置模块（第三方 / 基础插件）返回 undefined。 */
export function moduleIdForPluginName(pluginName: string): DshModuleId | undefined {
	return MODULE_BY_PLUGIN_NAME.get(pluginName.trim());
}

/** 容器反查（贡献侧按容器 id 取依赖与默认路由；找不到即 fail-fast，避免静默注册错容器）。 */
export function moduleContainerOf(containerId: string): IDshModuleContainer {
	const found = DSH_MODULE_CONTAINERS.find(c => c.containerId === containerId);
	if (!found) {
		throw new Error(`未知的模块容器：${containerId}`);
	}
	return found;
}

/**
 * 决议③的**声明**页面路由：`/x/<首个依赖模块>/`（方案 13.3：`view` 缺省时按 `module` 推导）。
 * 插件清单给出 `view.route` 后以清单为准——两处的比对见源码守卫测试。
 *
 * ⚠ **不要拿它当"该加载哪一页"**（共容器时首个模块可能压根没装 ⇒ 404）。那是
 * {@link pageRouteForActiveModules} 的事；这个函数只剩两个用途：守卫与清单比对、诊断文案。
 */
export function defaultPageRoute(container: IDshModuleContainer): string {
	return `/x/${container.modules[0]}/`;
}

/** 模块 → 承载它的容器（共容器时返回首个声明该模块的容器）；仅用于展示与诊断。 */
export function containerOfModule(module: DshModuleId): IDshModuleContainer | undefined {
	return DSH_MODULE_CONTAINERS.find(c => c.modules.includes(module));
}

/** 已装插件名集合 → 激活的内置模块集合（按 `DSH_BUILTIN_MODULES` 顺序，便于稳定断言）。 */
export function activeModulesOf(installedPlugins: readonly string[]): DshModuleId[] {
	const installed = new Set(installedPlugins.map(n => n.trim()));
	return DSH_BUILTIN_MODULES.filter(m => installed.has(m.pluginName)).map(m => m.module);
}

/** 方案 6.4：每个模块一个激活上下文键（`vssaros.dsh.plugin.<module>.active`）。 */
export function moduleContextKey(module: DshModuleId): string {
	return `vssaros.dsh.plugin.${module}.active`;
}

export interface IModuleContainerPlanInput {
	readonly engine: DshModuleEngine;
	/** profile 里已装的插件名（`IDshPluginInfo.name`）。 */
	readonly installedPlugins: readonly string[];
	/**
	 * 用户在插件中心**显式停用**的插件名（方案 4.3「停用」）。
	 * 「已装但停用」与「未装」在计划里等价（不激活）——区别只体现在插件中心的展示。
	 */
	readonly disabledPlugins?: readonly string[];
	/** 当前已注册的容器 id（用于算出需要注销的部分）。 */
	readonly registeredContainerIds: readonly string[];
}

export interface IModuleContainerPlan {
	readonly engine: DshModuleEngine;
	readonly activeModules: readonly DshModuleId[];
	/** 需要注册的容器（依赖已激活、状态 existing、当前未注册）。 */
	readonly registrations: readonly IDshModuleContainer[];
	/** 需要注销的容器 id（依赖全部停用、或插件被卸载）。 */
	readonly deregistrations: readonly string[];
	/** 依赖已激活但当前没有页面（如代码图谱）：只报告，不注册。 */
	readonly pending: readonly IDshModuleContainer[];
	readonly contextKeys: Readonly<Record<string, boolean>>;
}

/**
 * 计算 ActivityBar 容器集合的目标状态。
 *
 * `engine=legacy` 时返回空计划：静态注册是唯一写者（两套机制绝不并存，避免同 id 双注册）。
 * `engine=dsh` 时：模块激活 = 对应插件**已装且未被停用**（插件中心开关见 `disabledPlugins`）；
 * 聚合语义与停用与否无关。
 */
export function planModuleContainers(input: IModuleContainerPlanInput): IModuleContainerPlan {
	if (input.engine !== 'dsh') {
		return { engine: input.engine, activeModules: [], registrations: [], deregistrations: [], pending: [], contextKeys: {} };
	}
	const disabled = new Set((input.disabledPlugins ?? []).map(name => name.trim()));
	const activeModules = activeModulesOf(input.installedPlugins.filter(name => !disabled.has(name.trim())));
	const active = new Set(activeModules);
	const registered = new Set(input.registeredContainerIds);

	const registrations: IDshModuleContainer[] = [];
	const deregistrations: string[] = [];
	const pending: IDshModuleContainer[] = [];
	for (const container of DSH_MODULE_CONTAINERS) {
		const isActive = container.modules.some(m => active.has(m));
		const isRegistered = registered.has(container.containerId);
		if (!isActive) {
			if (isRegistered) {
				deregistrations.push(container.containerId);
			}
			continue;
		}
		if (container.status === 'planned') {
			pending.push(container);
			continue;
		}
		if (!isRegistered) {
			registrations.push(container);
		}
	}

	const contextKeys: Record<string, boolean> = {};
	for (const m of DSH_BUILTIN_MODULES) {
		contextKeys[moduleContextKey(m.module)] = active.has(m.module);
	}
	return { engine: input.engine, activeModules, registrations, deregistrations, pending, contextKeys };
}
