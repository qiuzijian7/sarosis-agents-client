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

import type { IVssarosActivityBar, IVssarosPluginManifest, IVssarosView } from './vssarosPluginManifest.js';

/** 参与计划计算的插件信息（渲染端拿到的就是 `IDshPluginInfo`；这里只取需要的字段，便于单测夹具）。 */
export interface IPluginWithManifest {
	readonly name: string;
	readonly enabled?: boolean;
	readonly manifest?: IVssarosPluginManifest;
}

export type DshModuleEngine = 'legacy' | 'dsh';

/** 内置模块 id（与 `@vssaros/dsh-<module>` 包名一一对应，见方案 6.6）。 */
export type DshModuleId =
	| 'skills' | 'mcp' | 'kb' | 'memory' | 'media' | 'codebase' | 'kanban' | 'workflow' | 'agents' | 'dashboard' | 'ide' | 'channels'
	// 2026-10-12：历史会话 sideview 的 dsh 页面（`@vssaros/dsh-sessions`）。
	// **它有自己的容器**（`vssaros.dsh.sessions`，`page-only`）—— 见下面 DSH_BUILTIN_MODULES 那条的说明。
	| 'sessions'
	// 2026-10-15：多平台内容导入（`@vssaros/dsh-web-content-import`）。**纯工具、无页面** ⇒ 无图标模块形态
	// （同 ide / channels：在 DSH_BUILTIN_MODULES、不在容器表、清单 view.kind='none'）。
	| 'web-content-import'
	// 2026-10-16（重构 2.1 试点）：定时任务（`@vssaros/dsh-scheduler`，官方 dsh-schedule 的薄壳）。
	// 自带容器 `vssaros.dsh.scheduler`（`page-only` —— legacy 调度器从不执行，无静态对应物）。
	| 'scheduler'
	// 2026-10-16（重构 2.4）：Saros Pocket 的 Host 路由（`/x/pocket/api/*`）。无图标模块（view.kind=none）。
	| 'pocket'
	// 2026-10-19：图表渲染（`@vssaros/dsh-pele`）。**纯引擎 + 一个工具、无页面** ⇒ 无图标模块形态
	// （同 web-content-import：在 DSH_BUILTIN_MODULES、不在容器表、清单 view.kind='none'）。
	// ⚠ 它同时是 IDE 侧渲染器的**产物来源**（`assets/pele.global.js`）⇒ 不是"只影响 dsh 会话"的普通插件。
	| 'pele'
	// 2026-10-21：图像生成（`@vssaros/dsh-imagegen`）。`image_generate` 工具 + 聊天框里的生图卡；
	// 画布工作台（Excalidraw）在这之上再加一页（P2 ⇒ 届时把 view.kind 从 'none' 改成 'page'）。
	| 'imagegen'
	// 2026-10-24：萨罗斯管理平台工作台（`@vssaros/dsh-studio`，整页 `/x/studio/`）。
	// ⚠ 补登记的原因：容器表（`vssaros.dsh.studio`）与页面表（:350）都已加，但**模块联合与
	//   内置模块表漏了** ⇒ 守卫报「声明了未登记的内置模块：studio」+「studio 没有插件包
	//   ⇒ DSH_MODULE_PAGES 里必须是 none」（后者是按内置表反查插件包失败后的连带结论）。
	| 'studio'
	// 2026-10-21：工作台商城（`@vssaros/dsh-market`）。读 dsh 公开市场目录 + Host 侧安装路由；
	// 界面在 chat-surface 的 `client.market.js` ⇒ 无图标模块形态（清单 view.kind='none'）。
	// ⚠ 2026-10-22 补回：本条与下面那行登记在 10-21 23:08 的本地重置里丢失，按清单重写。
	| 'market'
	// 2026-10-22：**自营商城**（`@vssaros/dsh-marketplace`）—— 与上面的 `market` 分工：
	//   `market` = 第三方工作台目录（dsh 公开市场，界面在设置面板）；
	//   `marketplace` = 我们的自营商城（独立页面 `/x/marketplace/`）⇒ 两条数据源、两条能力，互不覆盖 ✓。
	// 无 ActivityBar 图标：入口走工作台中间栏 / 命令（页面自带 route）。
	| 'marketplace'
	// 2026-10-22：并行 TUI 工作台（`@vssaros/dsh-parallel`）—— 一个工作台编排 N 个并行 LLM 会话，
	//   每格一个真 TUI（Host 侧 node-pty 起社区 `@tomowang/dsh-tui`，原始 ANSI 流 + xterm.js 渲染）。
	//   入口：主页「工作台」组件里的一行 item（`/x/parallel/`）。
	| 'parallel'
	// 2026-10-23：萨罗斯管理平台工作台（`@vssaros/dsh-studio`）—— 页面 `/x/studio/` 里 iframe 承载
	//   Saroasis Studio System 前端；平台右上角「AI 助手」在右侧栏打开 chat-surface。
	//   无 ActivityBar 图标：入口走主页卡片 / 侧栏启动器（页面自带 route）。
	// 2026-10-27：萨罗斯中转站工作台（`@vssaros/dsh-relay`，整页 `/x/relay/`）——
	//   页面里 iframe 承载 AnyDev 上部署的中转站 Web；本机登录 CodeBuddy provider 后，
	//   由 IDE 侧（`extensions/codebuddy-provider/src/relay.ts`）自动把本机注册成中转站节点。
	| 'relay'
	// 2026-10-28：小红书笔记工作台（`@vssaros/dsh-xhs-note`，整页 `/x/xhs-note/`）——
	//   主题与素材整理成笔记（标题/正文/话题标签），草稿落 `<数据根>/xhs-note/drafts/`。
	//   带 ActivityBar 图标（order 42）；⚠ 登记三张表必须同批（联合体 / 内置模块表 / 页面表）。
	| 'xhs-note'
	| 'studio';

export interface IDshBuiltinModule {
	readonly module: DshModuleId;
	/** 插件包名（profile 里已装插件的身份，用于反查模块是否激活）。 */
	readonly pluginName: string;
	/** 方案 6.6 的模块级职责一句话说明（诊断与插件中心展示用）。 */
	readonly summary: string;
	/**
	 * `true` = 已登记但**插件还没写**（dsh-plugins/ 下没有对应目录）——预留位。
	 * 影响：激活判据照旧按"已装插件名"算（没装就不激活 ✓ 天然安全）；
	 * 守卫会反向钉住"planned 的模块不许有插件目录 / 非 planned 的必须有"（dshPluginPackages.test.ts）。
	 */
	readonly planned?: boolean;
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
	// 2026-10-16（重构 2.3）：渠道插件已建（`dsh-plugins/vssaros-channels`）——核心环（路由 + loopback
	// 适配器）落地；飞书/Telegram 真机适配器待真凭据对接。无图标模块（view.kind=none）。
	{ module: 'channels', pluginName: '@vssaros/dsh-channels', summary: 'IM 渠道（入站 → 专属会话 → runs 驱动 → 回传；无 ActivityBar 图标）' },
	// 2026-10-16（重构 2.1 试点）：定时任务模块 —— 官方 dsh-schedule 的薄壳（图标 + `/x/scheduler/` 页面 +
	// legacy agent.yaml 迁移入口）；调度本身是官方 bundle（宿主安装链登记，见 dshHostSupervisor）。
	{ module: 'scheduler', pluginName: '@vssaros/dsh-scheduler', summary: '定时任务（官方 dsh-schedule 薄壳：图标 + 清单页 + legacy 迁移；工作台 0.3.0 起复用官方原生任务管理页）' },
	// 2026-10-16（重构 2.4）：Saros Pocket 的 Host 路由（token 鉴权；无 ActivityBar 图标）。
	{ module: 'pocket', pluginName: '@vssaros/dsh-pocket', summary: 'Pocket 手机端的 Host 路由（列会话 + 发消息；无 ActivityBar 图标）' },
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
	// 2026-10-19：图表渲染（`render_diagram` 工具 + 随包 pele 引擎；IDE 渲染进程读同一份
	// `assets/pele.global.js`，聊天卡片 / 代码块 / 笔记 / .mermaid 预览全走它）。
	{ module: 'pele', pluginName: '@vssaros/dsh-pele', summary: 'Mermaid 图表渲染（随包 pele 引擎；dsh 工具与 IDE 渲染进程共用同一份产物）' },
	// 2026-10-21：图像生成（`@vssaros/dsh-imagegen`）。工具 `image_generate`（执行经控制桥回 IDE ⇒
	// 凭据与审批只有一份真源）+ 聊天框里的生图工具卡（官方 `tool.call.images` 画廊）。
	// 无图标模块形态（view.kind='none'）：画布工作台那页落地（P2）后才给活动栏一格。
	{ module: 'imagegen', pluginName: '@vssaros/dsh-imagegen', summary: '图像生成（生图工具 + 对话内出图；执行经控制桥回 IDE）' },
	// 2026-10-21：工作台商城（无 ActivityBar 图标；界面在 chat-surface 的设置面板里）。
	{ module: 'market', pluginName: '@vssaros/dsh-market', summary: '工作台商城：读 dsh 公开市场目录（协议 v2）+ Host 侧安装路由（无 ActivityBar 图标）' },
	// 2026-10-22：**自营商城工作台**（agent / skill / 工作台 / 工作流 四类商品）。
	// 与上面的 `market` 的分工：`market` = 第三方工作台目录（dsh 公开市场，界面在设置面板）；
	// `marketplace` = 我们自己的商城（独立页面 `/x/marketplace/`）⇒ 两条数据源、两条能力，互不覆盖 ✓。
	// 无 ActivityBar 图标：入口走工作台中间栏 / 命令（页面自带 route ⇒ 不必占活动栏一格）。
	{ module: 'marketplace', pluginName: '@vssaros/dsh-marketplace', summary: '自营商城工作台：agent/skill/工作台/工作流 的浏览、安装、升级、发布与管理（页面 /x/marketplace/）' },
	// 2026-10-22：并行 TUI 工作台（`/x/parallel/`）。一个工作台编排 N 个并行 LLM 会话，每格一个真 TUI。
	// 实测进程模型：N 格 = N 个**独立 dsh 进程**（社区 TUI 自带 core，不连 Host）；同 profile 可并行，
	// 写锁是**会话级**；每格 ≈ 71.6MB（带我们全套模块的空闲态）⇒ 12 格 ≈ 0.86GB。
	{ module: 'parallel', pluginName: '@vssaros/dsh-parallel', summary: '并行 TUI 工作台：并排编排多个并行 LLM 会话，每格一个 TUI（页面 /x/parallel/）' },
	// 2026-10-24：萨罗斯管理平台工作台（站点 iframe + 站点栏 + 右栏 AI 助手页签）。
	// 登记在三张表里必须同批完成（模块联合 / 内置模块表 / 页面表），漏一处就是「未登记的内置模块」✗。
	{ module: 'studio', pluginName: '@vssaros/dsh-studio', summary: '萨罗斯管理平台：承载平台前端页面，右上角 AI 助手在右栏打开助手会话（页面 /x/studio/）' },
	// 2026-10-27：萨罗斯中转站工作台（`@vssaros/dsh-relay`，整页 `/x/relay/`）。
	// 页面里 iframe 承载 AnyDev 上部署的中转站 Web（`http://21.6.92.5:8000/`）；
	// 本机登录 CodeBuddy provider 后由 IDE 侧自动注册成中转站节点（注册体只含身份与模型目录，
	// **不含任何 CodeBuddy 凭据** —— 中转站永不持有凭据）。
	{ module: 'relay', pluginName: '@vssaros/dsh-relay', summary: '萨罗斯中转站：承载 AnyDev 上部署的中转站 Web；本机登录 CodeBuddy provider 后自动注册为中转站节点（页面 /x/relay/）' },
	// 2026-10-28：小红书笔记工作台（`@vssaros/dsh-xhs-note`）。图标 + `/x/xhs-note/` 页面；
	// 草稿落 `<数据根>/xhs-note/drafts/`（服务端 `lib/store.js`，页面与工作台读同一份 ⇒ 不会漂移）。
	{ module: 'xhs-note', pluginName: '@vssaros/dsh-xhs-note', summary: '小红书笔记：主题与素材整理成笔记（标题/正文/话题标签），草稿落本机数据目录（页面 /x/xhs-note/）' },
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
	/**
	 * 任一依赖模块激活即显示；全部停用即注销（决议①聚合语义）。
	 * 清单驱动后（1.1）这里是**字符串**：第三方/未来模块的 id 不在 DshModuleId 联合里也能进表。
	 */
	readonly modules: readonly string[];
	readonly status: DshModuleContainerStatus;
	readonly activityBar: IVssarosActivityBar;
	/**
	 * 该容器**代表模块**的视图形态（清单 `vssaros.view`）。
	 *
	 * ★ 2026-10-30（用户要求「activitybar 中插件的 sideview 改用 vscode 原生的 UI 和功能」）：
	 *   宿主选择必须看这个字段 —— `kind: 'native'` 的容器要挂 IDE 自己画的原生视图，
	 *   而不是 `DshPluginViewPane` 里那张插件网页。此前 `IDshModuleContainer` 没有它，
	 *   于是"清单能声明 native"这件事在宿主层**读都读不到**（`parseView` 收了，却没人消费）。
	 *
	 * 缺省（`containersFromPlugins` 之外的硬编码表 / 老数据）没有该字段 ⇒ 调用方按 `page` 处理。
	 */
	readonly view?: IVssarosView;
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
		activityBar: { containerId: 'agentStudio.presetAgent', title: 'Bots', icon: 'codicon:robot', order: 60 },
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
		// 定时任务（重构 2.1 试点）：官方 dsh-schedule 的薄壳。`page-only` —— legacy 侧的自研调度器
		// **从来没有执行过**（`agentSchedulerService.ts:356` 对 async 生成器只 await 不迭代 ⇒ 没有任何
		// 存量行为要对齐）；legacy 侧的任务管理页是 taskOverviewEditorPane 里的一个 tab，与这格并存。
		containerId: 'vssaros.dsh.scheduler', modules: ['scheduler'], status: 'page-only',
		activityBar: { containerId: 'vssaros.dsh.scheduler', title: { zh: '定时任务', en: 'Scheduled Tasks' }, icon: 'codicon:clock', order: 95 },
	},
	{
		// 画布（2026-10-21）：`@vssaros/dsh-imagegen` 的画布工作台。
		// **page-only**：legacy 引擎侧没有画布（画布引擎 3.4MB 随 dsh 插件走 ⇒ 只在 dsh 侧存在）✓
		// order 85 = 排在「工作流」(80) 之后 —— 画布是**创作**入口（资料库系 110–113 是"看资料"）。
		containerId: 'vssaros.dsh.imagegen', modules: ['imagegen'], status: 'page-only',
		activityBar: { containerId: 'vssaros.dsh.imagegen', title: { zh: '画布', en: 'Canvas' }, icon: 'codicon:paintcan', order: 85 },
		note: '2026-10-21：画布工作台。侧栏页 = 状态 + 「打开画布工作台」按钮；真正的画布（Excalidraw，3.4MB 引擎）是**独立 webview**，在编辑区页签里全屏展开（塞进 dsh 客户端包会变成"每个聊天框都加载 3.4MB"）。',
	},
	{
		// 商城工作台（2026-10-22）：`@vssaros/dsh-marketplace` 的 `/x/marketplace/` 整页。
		// **page-only** —— legacy 引擎侧没有商城页（商城认证与安装链全在 dsh/IDE 侧）✓
		// order 86 = 紧跟画布(85) 之后（两者都是「创作/扩展」类入口，排在「看资料」110+ 之前 ✓）。
		containerId: 'vssaros.dsh.marketplace', modules: ['marketplace'], status: 'page-only',
		activityBar: { containerId: 'vssaros.dsh.marketplace', title: { zh: '商城', en: 'Marketplace' }, icon: 'codicon:extensions', order: 86 },
		note: '2026-10-22：自营商城工作台（agent / skill / 工作台 / 工作流 四类商品）。与「工作台商城」（market 模块 = dsh 公开市场的第三方工作台，界面在设置面板）**并存且分工明确** ✓。页面自带 route ⇒ IDE 直接开 `/x/marketplace/`；所有有副作用的动作经 `ide.request{capability:"marketplace"}` 落到 IDE 侧（认证/下载/注册表刷新只有一份真源）✓。',
	},
	{
		// 并行 TUI 工作台（2026-10-22）：`@vssaros/dsh-parallel` 的 `/x/parallel/` 整页（稿 A 网格）。
		// **page-only** —— legacy 引擎侧没有这一页（格位是 Host 侧 PTY + 浏览器 xterm.js，只存在于 dsh 侧）✓
		// order 87 = 紧跟商城(86) 之后（同为「扩展/创作」类入口，排在「看资料」110+ 之前 ✓）。
		// ⚠ 活动栏 title/icon/order 必须与插件清单 `vssaros.activityBar` **同值**（双轨对账守卫盯着）。
		containerId: 'vssaros.dsh.parallel', modules: ['parallel'], status: 'page-only',
		activityBar: { containerId: 'vssaros.dsh.parallel', title: { zh: '并行工作台', en: 'Parallel' }, icon: 'codicon:split-horizontal', order: 87 },
		note: '2026-10-22：并行 TUI 工作台（一屏 N 格，每格一个真 TUI）。实测：N 格 = N 个独立 dsh 进程（社区 TUI 自带 core，不连 Host），同 profile 可并行、写锁是会话级，每格 ≈ 71.6MB。0.1.0 只交付静态网格壳，格位后端（PTY 起停/推流/收割）下一步接。',
	},
	{
		// 萨罗斯管理平台工作台（2026-10-23）：`@vssaros/dsh-studio` 的 `/x/studio/` 整页。
		// **page-only** —— IDE 侧没有对应 legacy 页（页面 = 站点 iframe + 站点栏，只存在于 dsh 侧）✓
		// ★ 2026-10-23（修编译错误）：`IDshModuleContainer.activityBar` 是**必填**，而这条原先没写 ⇒
		//   `Property 'activityBar' is missing`（gulp 编译唯一剩下的一条）。当时注释说"入口走主页卡片 /
		//   侧栏启动器，所以不占活动栏"，但那与接口矛盾 —— 二者只能选一个：
		//   ① 补 activityBar（本条，活动栏多一格）；② 把字段改可选（试过 ⇒ 引出 6 处消费点报错，已回退）。
		//   ⇒ 选 ①：order 88（紧跟并行工作台 87、商城 86 之后，「创作/扩展」类），icon 与插件清单
		//   `workbench.icon` 同值（codicon:globe）。
		//   ⚠ 与插件清单 `vssaros.activityBar` **必须同值**（`dshPluginPackages.test.ts` 双轨对账盯着）。
		containerId: 'vssaros.dsh.studio', modules: ['studio'], status: 'page-only',
		activityBar: { containerId: 'vssaros.dsh.studio', title: { zh: '萨罗斯', en: 'Studio' }, icon: 'codicon:globe', order: 88 },
		note: '2026-10-23：萨罗斯管理平台工作台。页面 iframe 直连 http://saroasisstudiosystem.saroasis.woa.com:9999/（站点无 X-Frame-Options，可嵌）；页面自带底色与配色（自托管页拿不到 --dsw-alias-*）；「AI 助手」由 client 侧注册 shell.overlay 入口 + 右栏 studiochat 页签（复用官方 sidebar.chat.conversation）。',
	},
	{
		// 萨罗斯中转站工作台（2026-10-27）：`@vssaros/dsh-relay` 的 `/x/relay/` 整页。
		// **page-only** —— IDE 侧没有对应 legacy 页（页面 = 中转站 Web 的 iframe + 状态栏，只存在于 dsh 侧）✓
		// order 89 = 紧跟萨罗斯平台(88)之后（同为「平台/扩展」类入口，排在「看资料」110+ 之前 ✓）。
		// ⚠ 活动栏 title/icon/order 必须与插件清单 `vssaros.activityBar` **同值**（双轨对账守卫盯着）。
		containerId: 'vssaros.dsh.relay', modules: ['relay'], status: 'page-only',
		activityBar: { containerId: 'vssaros.dsh.relay', title: { zh: '中转站', en: 'Relay' }, icon: 'codicon:radio-tower', order: 89 },
		note: '2026-10-27：萨罗斯中转站工作台。页面 iframe 直连 AnyDev 环境「我的开发环境」（21.6.92.5）上的中转站 Web（http://zijianqiu-any1.devcloud.woa.com:8000/，该站不设 X-Frame-Options ⇒ 可嵌）；页面自带状态栏（可达性 / 版本 / 刷新 / 外开）与探针 `/x/relay/api/ping`。本机登录 CodeBuddy provider 后，IDE 侧自动把本机注册成中转站节点（只报身份 + 模型目录，不报凭据）。',
	},
	{
		// 小红书笔记工作台（2026-10-28）：`@vssaros/dsh-xhs-note` 的 `/x/xhs-note/` 整页。
		// **page-only** —— IDE 侧没有对应 legacy 页（笔记编辑与草稿都只在 dsh 侧）。
		// order 42 = 「创作」类入口，排在画布(85)/商城(86)之前。
		// ⚠ 活动栏 title/icon/order 必须与插件清单 `vssaros.activityBar` **同值**（双轨对账守卫盯着）。
		containerId: 'vssaros.dsh.xhs-note', modules: ['xhs-note'], status: 'page-only',
		activityBar: { containerId: 'vssaros.dsh.xhs-note', title: { zh: '小红书笔记', en: 'XHS Note' }, icon: 'codicon:comment-discussion', order: 42 },
		note: '2026-10-28：小红书笔记工作台。服务端 `lib/index.js` 注册 `/x/xhs-note`（kind=prefix）+ 页面壳；草稿落 `<数据根>/xhs-note/drafts/`，工作台里的 React 面板接管编辑。',
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
	readonly module: string;
	/**
	 * - `page`：插件 Host 自托管的整页（有 `route`）；
	 * - `section`：寄居同容器宿主的片段（有 `route` + `host`）；
	 * - `native`：**VsSaros 自绘**的原生侧栏视图（原生树 + 标题栏/工具栏）—— 它**没有页面路由**，
	 *   给的是数据接口（清单 `view.data.route`，如 `/x/agents/api/agents`），由
	 *   `dshNativeTreeViewPane` 消费（2026-10-30 起）；
	 * - `none`：纯工具、无界面。
	 */
	readonly kind: 'page' | 'section' | 'native' | 'none';
	/** `page` / `section` 的清单路由；`native` / `none` 没有。 */
	readonly route?: string;
	/** `section` 的宿主模块（清单 `view.host`）。 */
	readonly host?: string;
}

export const DSH_MODULE_PAGES: readonly IDshModulePage[] = [
	// 2026-10-30：agents 改成**原生侧栏视图**（`vssaros.agents.roster` 树 + 刷新/开完整页两个动作）⇒
	//   kind=native、不再有页面路由；地址在清单 `view.data.route`（数据接口），由 dshNativeTreeViewPane 消费。
	{ module: 'agents', kind: 'native' },
	{ module: 'codebase', kind: 'page', route: '/x/codebase/' },
	{ module: 'dashboard', kind: 'page', route: '/x/dashboard/' },
	{ module: 'kanban', kind: 'page', route: '/x/kanban/' },
	// ★ 2026-10-23（知识库 UI 统一）／2026-10-24 修正：
	//   **route 必须保持规范形态 `/x/kb/`** —— `dshPluginPackages.test.ts` 有一条硬校验
	//   「view.route 必须等于该模块的规范默认路由」。我一度把它改成 `/x/kb/sideview`，
	//   结果打红（`vssaros-kb 的 view.route 与聚合表推导的默认路由不一致`）。
	//   ⇒ 「让窗口模式用 React 页」不该靠改路由，而是靠**这个路由返回什么**：
	//     插件侧 `lib/index.js` 现在把 `/x/kb/` 直接出 `web/sideview.html`（与 IDE 侧栏同一份
	//     bundle），旧页退到 `/x/kb/classic`（renderPage 兜底）仍可回退 ✓。
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
	{ module: 'scheduler', kind: 'page', route: '/x/scheduler/' },
	{ module: 'pocket', kind: 'none' },
	// 2026-10-15：多平台内容导入（纯工具、无页面）⇒ kind='none'（与插件清单 view.kind 一致 ✓）。
	{ module: 'web-content-import', kind: 'none' },
	// 2026-10-21：图像生成 + 画布工作台（`/x/imagegen/` 侧栏页；画布本体在 `/x/imagegen/canvas/` 子路由）。
	{ module: 'imagegen', kind: 'page', route: '/x/imagegen/' },
	// 2026-10-22：自营商城工作台（整页 `/x/marketplace/`）—— 与「工作台商城」（market 模块）**并存** ✓。
	{ module: 'marketplace', kind: 'page', route: '/x/marketplace/' },
	// 2026-10-22：并行 TUI 工作台（整页 `/x/parallel/`，稿 A 网格）。
	// ⚠ 这条是主页「工作台」组件点「打开」的**白名单**（`openModulePage` 精确匹配 → 前缀归属）⇒
	//   漏登记的表现是"点了没反应"（宿主 warn「不在模块页表里」）✗。
	{ module: 'parallel', kind: 'page', route: '/x/parallel/' },
	// 2026-10-23：萨罗斯管理平台工作台（整页 `/x/studio/`）。
	// ⚠ 这条同时是主页/侧栏点「打开」的**白名单**（`openModulePage` 精确匹配）⇒ 漏登记 = 点了没反应。
	{ module: 'studio', kind: 'page', route: '/x/studio/' },
	// 2026-10-27：萨罗斯中转站工作台（整页 `/x/relay/`，页面里 iframe 承载 AnyDev 上的中转站 Web）。
	// ⚠ 这条同时是主页/侧栏点「打开」的**白名单**（`openModulePage` 精确匹配）⇒ 漏登记 = 点了没反应。
	{ module: 'relay', kind: 'page', route: '/x/relay/' },
	// 2026-10-28：小红书笔记工作台（整页 `/x/xhs-note/`，与服务端 `ROUTE_PREFIX` 逐字一致）。
	// ⚠ 这条同时是主页/侧栏点「打开」的**白名单**（`openModulePage` 精确匹配）⇒ 漏登记 = 点了没反应。
	{ module: 'xhs-note', kind: 'page', route: '/x/xhs-note/' },
];

/** 容器页路由的解析结果（见 {@link pageRouteForActiveModules}）。 */
export interface IDshModulePageResolution {
	readonly module: string;
	readonly kind: 'page' | 'section';
	readonly route: string;
	/** 2026-10-22：该模块的插件已迁成 React 工作台（见 `hasWorkbenchClient`）⇒ 编辑区开 'workbench' 视图。 */
	readonly workbenchClient?: boolean;
}

/** 给页面解析结果补上"已迁成 React 工作台"标记（纯函数；只认已启用、清单 module 对得上的包）。 */
export function withWorkbenchClient<T extends IDshModulePageState>(state: T, plugins: readonly (IPluginWithManifest & { readonly workbenchClient?: boolean })[]): T {
	const page = state.page;
	if (!page || page.kind !== 'page') {
		return state;
	}
	const owner = plugins.find(p => p.enabled !== false && p.manifest?.module === page.module);
	return owner?.workbenchClient ? { ...state, page: { ...page, workbenchClient: true } } : state;
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
	activeModules: readonly string[],
	pages: readonly IDshModulePage[] = DSH_MODULE_PAGES,
): IDshModulePageResolution | undefined {
	const active = new Set(activeModules);
	const candidates = container.modules
		.filter(module => active.has(module))
		.map(module => pages.find(page => page.module === module))
		// native **不参与页面解析**：它没有页面路由（走 dshNativeTreeViewPane 的宿主编排），
		// 所以这里只收 page / section（native 的 route 本来就是 undefined，双保险）。
		.filter((page): page is IDshModulePage & { route: string; kind: 'page' | 'section' } => !!page?.route && (page.kind === 'page' || page.kind === 'section'));
	const picked = candidates.find(page => page.kind === 'page') ?? candidates[0];
	// 现构一个对象（而不是直接把表里的行交出去）：返回值就是声明的那三个字段，
	// 不会顺带泄漏 `host` 之类的表内部信息（测试里用 deepStrictEqual 也才写得准）。
	return picked ? { module: picked.module, kind: picked.kind, route: picked.route } : undefined;
}

/** 容器页状态：该加载的页面（可能没有）+ 各模块的激活/页面情况（给"点开为什么是空的"这类说明用）。 */
export interface IDshModulePageState {
	readonly page?: IDshModulePageResolution;
	readonly modules: readonly { readonly module: string; readonly active: boolean; readonly route?: string }[];
}

/** 由"容器 + 已激活模块"算出页面状态（纯函数；说明文案也由它派生，免得两处各判一次）。 */
export function resolveContainerPageState(
	container: IDshModuleContainer,
	activeModules: readonly string[],
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

// ─── 清单驱动的派生（重构 1.1，2026-10-16）─────────────────────────────────────
// 目标：新增一个模块插件 ⇒ 壳代码改动为 0。容器、页面、激活集合全部从已装插件的
// `vssaros` 清单派生；上面的两张表降级为「legacy 静态注册的基准」与「守卫的比对基准」。
//
// 派生规则（与表逐项对齐，守卫 `dshPluginPackages.test.ts` 会双向核对）：
// - 容器成员 = 清单里 `activityBar.containerId` 相同的模块聚合（skills+mcp 共容器 ⇒ 两份清单
//   写同一个 containerId；这与"决议①由 VsSaros 侧聚合"不冲突——聚合键本来就在清单里）。
// - 页面 = 清单 `view`（page→route、section→route+host、none→无）。
// - 模块激活 = 插件已装且未停用且清单带 module。
// 缺 manifest 或 manifest 不合法（主进程已过滤）⇒ 不参与派生，不猜字段。

/** 从已装插件清单派生模块容器表。 */
export function containersFromPlugins(plugins: readonly IPluginWithManifest[]): readonly IDshModuleContainer[] {
	const byContainer = new Map<string, { modules: string[]; activityBar: IVssarosActivityBar }>();
	// 第一遍：有自己 activityBar 的模块先落位（拿到容器键）。
	for (const plugin of plugins) {
		const manifest = plugin.manifest;
		if (!manifest?.module || !manifest.activityBar) {
			continue;
		}
		const containerId = manifest.activityBar.containerId;
		const entry = byContainer.get(containerId) ?? { modules: [], activityBar: manifest.activityBar };
		if (!entry.modules.includes(manifest.module)) {
			entry.modules.push(manifest.module);
		}
		byContainer.set(containerId, entry);
	}
	// 第二遍：寄居模块（view.kind=section）并入**宿主模块所在容器**——它没有自己的图标，
	// 但它的激活要让宿主容器显示出来（与硬编码表的"容器 members 含 mcp"同语义 ✓）。
	const containerOfModule = new Map<string, string>();
	for (const [containerId, entry] of byContainer) {
		for (const m of entry.modules) {
			containerOfModule.set(m, containerId);
		}
	}
	for (const plugin of plugins) {
		const manifest = plugin.manifest;
		if (!manifest?.module || manifest.view.kind !== 'section') {
			continue;
		}
		const hostContainer = containerOfModule.get(manifest.view.host);
		if (!hostContainer) {
			continue; // 宿主没装/没图标 ⇒ 寄居模块没有落点（容器不显示，页面路由仍在）
		}
		const entry = byContainer.get(hostContainer)!;
		if (!entry.modules.includes(manifest.module)) {
			entry.modules.push(manifest.module);
		}
	}
	// 与硬编码表同序：按 order 排序（order 相同按 containerId 字典序，保证稳定）。
	return [...byContainer.entries()]
		.map(([containerId, { modules, activityBar }]) => {
			// 视图形态：取**该容器首个模块**清单里的 `view`（共容器时成员都写同一个容器 id，
			// 且承载页由容器声明的那一个模块负责 ⇒ 取首个即可；跨形态共容器是清单守卫会挡的事）。
			const view = viewOfContainer(plugins, modules[0]);
			return {
				containerId,
				modules,
				// 清单驱动的容器没有「legacy 侧已有静态宿主」的概念（那是静态注册的事）⇒ 一律按 existing 注册。
				status: 'existing' as const,
				activityBar,
				...(view ? { view } : {}),
			};
		})
		.sort((a, b) => a.activityBar.order - b.activityBar.order || a.containerId.localeCompare(b.containerId));
}

/** 取某模块在其插件清单里声明的 `vssaros.view`（找不到 ⇒ undefined，调用方按 page 处理）。 */
function viewOfContainer(plugins: readonly IPluginWithManifest[], moduleId: string | undefined): IVssarosView | undefined {
	if (!moduleId) {
		return undefined;
	}
	return plugins.find(p => p.manifest?.module === moduleId)?.manifest?.view;
}

/** 从已装插件清单派生页面表。 */
export function pagesFromPlugins(plugins: readonly IPluginWithManifest[]): readonly IDshModulePage[] {
	const pages: IDshModulePage[] = [];
	for (const plugin of plugins) {
		const manifest = plugin.manifest;
		if (!manifest?.module) {
			continue;
		}
		const view = manifest.view;
		if (view.kind === 'page') {
			pages.push({ module: manifest.module, kind: 'page', route: view.route });
		} else if (view.kind === 'section') {
			pages.push({ module: manifest.module, kind: 'section', route: view.route, host: view.host });
		} else if (view.kind === 'native') {
			// 2026-10-30：native **进表**（`kind: 'native'`，没有页面路由）—— 与硬编码表双轨对账时
			//   必须能派生出来，否则 agents 这类「原生视图」模块在派生侧整行缺失、对账静默漏掉一格。
			pages.push({ module: manifest.module, kind: 'native' });
		} else if (view.kind === 'none') {
			pages.push({ module: manifest.module, kind: 'none' });
		}
	}
	return pages;
}

/** 清单驱动的模块激活集合：插件已装且未停用且清单带 module。 */
export function activeModulesFromPlugins(plugins: readonly IPluginWithManifest[]): string[] {
	return plugins
		.filter(p => p.enabled !== false && p.manifest?.module)
		.map(p => p.manifest!.module!);
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
	/**
	 * 清单驱动（重构 1.1）：给出时**替代** `DSH_MODULE_CONTAINERS` 参与计算。
	 * 调用方用 `containersFromPlugins()` 从已装插件清单派生。
	 */
	readonly containers?: readonly IDshModuleContainer[];
	/** 清单驱动下插件→模块的映射（给出时替代 `DSH_BUILTIN_MODULES` 的插件名反查）。 */
	readonly pluginModules?: ReadonlyMap<string, string>;
}

export interface IModuleContainerPlan {
	readonly engine: DshModuleEngine;
	readonly activeModules: readonly string[];
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
	const containers = input.containers ?? DSH_MODULE_CONTAINERS;
	const pluginModules = input.pluginModules ?? MODULE_BY_PLUGIN_NAME;
	const disabled = new Set((input.disabledPlugins ?? []).map(name => name.trim()));
	const activeModules = input.installedPlugins.filter(name => !disabled.has(name.trim()))
		.map(name => pluginModules.get(name.trim()))
		.filter((m): m is string => !!m);
	const active = new Set(activeModules);
	const registered = new Set(input.registeredContainerIds);

	const registrations: IDshModuleContainer[] = [];
	const deregistrations: string[] = [];
	const pending: IDshModuleContainer[] = [];
	for (const container of containers) {
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

	// 上下文键集合：清单驱动时用派生的模块集合（新模块不进 DSH_BUILTIN_MODULES 也有键 ✓）；
	// 否则用内置表（旧口径不变）。
	const keyModules = input.pluginModules ? [...new Set(input.pluginModules.values())] : DSH_BUILTIN_MODULES.map(m => m.module as string);
	const contextKeys: Record<string, boolean> = {};
	for (const m of keyModules) {
		contextKeys[moduleContextKey(m as DshModuleId)] = active.has(m);
	}
	return { engine: input.engine, activeModules, registrations, deregistrations, pending, contextKeys };
}
