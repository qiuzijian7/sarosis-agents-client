/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * vssaros 插件清单的 schema、校验与命名空间规则（方案第 13.3 节 + 6.5 / 6.11.5）。
 *
 * 纯逻辑、无 I/O。两个使用方：
 * 1. VsSaros 侧组装 / 校验内置模块插件（`dsh-plugins/*\/package.json` 的 `vssaros` 字段）；
 * 2. 渲染进程的 `DshActivityBarContribution` 按已激活插件计算 ActivityBar 容器集合。
 *
 * v1.2.8 决议（2026-10-10，方案 6.11.5）：
 * - `activityBar` 保持单体，不做数组化；"多插件共容器"由 VsSaros 侧的容器聚合表计算
 *   （见 `dshModuleContainers.ts`），第三方插件仍强制 1 插件 : 1 容器；
 * - `view.kind` 默认 `page`（缺省时按 `module` 推导 `/x/<module>/`）；`section` 用于聚合模块寄居同容器宿主的页面
 *   （决议①，"只提供 page 区块"）；仅"必须内嵌 VsSaros
 *   原生组件"的页面才写 `native`；
 * - `vssaros.*` 是 VsSaros 常驻容器命名空间，插件（含内置模块）不得使用。
 */

export const VSSAROS_MANIFEST_VERSION = 1;

/** VsSaros 常驻容器命名空间（方案 6.11.5 ②）：插件清单不得声明此前缀。 */
export const VSSAROS_RESERVED_CONTAINER_PREFIX = 'vssaros.';

/** 第三方插件的 ActivityBar order 区间（方案 6.5）。 */
export const VSSAROS_THIRD_PARTY_ORDER_MIN = 200;
export const VSSAROS_THIRD_PARTY_ORDER_MAX = 899;

/** 页面形态（方案 6.3）：page = 插件 Host 自托管页面；native = VsSaros 原生视图。 */
export interface IVssarosPageView {
	readonly kind: 'page';
	/** 插件 Host 注册的前缀路由，如 `/x/vssaros-kanban/`。 */
	readonly route: string;
}

/**
 * 原生视图（`kind: 'native'`）：**VsSaros 自己画**的侧栏视图 —— 原生树、原生标题栏 / 工具栏、
 * 原生右键菜单与展开状态持久化，**不是** `WebContentsView` 里的一张插件网页。
 *
 * ★ 2026-10-30（用户要求「activitybar 中插件的 sideview 改用 vscode 原生的 UI 和功能」）：
 *   此前 `native` 只是**能被解析**（`parseView` 收下 `viewType`），但宿主编排
 *   （`dshActivityBarContribution.moduleViewHostOf`）**只有 page 一条路** ⇒ 声明了 native 的插件
 *   照样被塞进 `DshPluginViewPane`，等于这个形态从实现上不存在。本次把契约的另一半接上：
 *   `data` 说清"原生视图从哪里取数"，`actions` 说清"原生标题栏上放哪几个动作"。
 *
 * 为什么取数仍要一个 `route`、而不是让插件直接给 IDE 传数据：
 * 控制桥（`ide.request`）是**反向**通道（插件问 IDE），而侧栏是 IDE 问插件。原生视图要的是
 * "跟插件页同一份数据"，那就必须走**同一份** HTTP 接口（同一套 cookie 认证与权限口径）——
 * 否则侧栏与编辑区页会各算一份，迟早对不上（本仓已经为"两个 dashboard 不是同一份数据"付过代价）。
 */
export interface IVssarosNativeView {
	readonly kind: 'native';
	/** VsSaros 侧注册的视图类型，经控制桥 `module.<id>.*` 取数。 */
	readonly viewType: string;
	/**
	 * 原生视图的**数据来源**：插件 Host 上的一个 JSON 接口（如 `/x/agents/api/agents`）。
	 *
	 * 缺省 = 该视图自带数据（不需要 HTTP 取数）。给了就必须是站内绝对路径，
	 * 且**禁止**查询串 / 片段 / `..` —— 原生视图会原样拼到模块页基址后面取数，
	 * 放开查询串会让"取数"变成"任意请求"。
	 */
	readonly data?: IVssarosNativeData;
	/**
	 * 原生标题栏上的动作。**只有 id / 标题 / 图标是清单的东西**；"按下去做什么"由 IDE 侧的
	 * 视图实现决定（清单不能注入命令 —— 那是第三方插件拿到任意命令执行权的入口）。
	 */
	readonly actions?: readonly IVssarosNativeAction[];
}

/** 原生视图的数据来源（见 {@link IVssarosNativeView.data}）。 */
export interface IVssarosNativeData {
	/** 站内绝对路径，如 `/x/agents/api/agents`。 */
	readonly route: string;
}

/** 原生标题栏动作（见 {@link IVssarosNativeView.actions}）。 */
export interface IVssarosNativeAction {
	/** 动作 id：IDE 侧视图实现按它分派（未知 id 会被忽略并记日志）。 */
	readonly id: string;
	readonly title: string | { readonly zh: string; readonly en: string };
	/** `codicon:xxx`；缺省由 IDE 侧按动作 id 兜一个。 */
	readonly icon?: string;
}

/**
 * 聚合模块的页面**区块**（决议①："只提供 page 区块与工具"）。
 *
 * 用于寄居型模块：它**不占自己的容器、也不开自己的页面**，而是把一段界面挂进同容器里"宿主模块"的页面上
 * （现状**只剩一处**：`mcp` 寄居 `skills` 页 —— memory 已于 2026-10-12 升为独立工作台
 * `agentStudio.memory`，连同「知识库页内嵌记忆分区」一起摘掉了）。与之对应，插件只注册 `route`
 * （片段路由），**不注册**宿主的页面路由——两者都是 `/x/...` 前缀，撞上就是"谁先注册谁赢"的
 * 静默故障，所以清单必须把这件事写清楚、并由守卫校验。
 */
export interface IVssarosSectionView {
	readonly kind: 'section';
	/** 宿主模块的 module id：必须在同一容器内，且**不能是自己**。 */
	readonly host: string;
	/** 本插件自托管的片段路由（宿主页面按需取），如 `/x/mcp/section`。 */
	readonly route: string;
}

/**
 * **无图标模块**（headless）：不提供任何界面，也不占容器。
 *
 * 现状：`ide`（IDE 能力工具）与 `channels`（渠道适配器）在 `DSH_BUILTIN_MODULES` 里但**不在容器表**里——
 * 它们只注册工具、没有页面，此前清单只有 page / native / section 三种形态，**没法表达"我只有工具"**
 * （守卫也会因"找不到容器"直接拒绝）。`none` 就是这个形态：显式声明不提供界面，并与容器表**互斥**
 * （有容器的模块用 `none` 是自相矛盾，守卫会报）。
 */
export interface IVssarosNoneView {
	readonly kind: 'none';
}

export type IVssarosView = IVssarosPageView | IVssarosNativeView | IVssarosSectionView | IVssarosNoneView;

/** 页面桥 / `ide.request` 的能力名（方案 13.3）。新增名字时**同时**改白名单常量（下方）。 */
export type VssarosIdeCapability = 'openFile' | 'reveal' | 'showDiff' | 'getSelection' | 'getDiagnostics' | 'dashboardStats' | 'browser' | 'canvas' | 'mindmap' | 'taskboard' | 'workflow' | 'media' | 'skills' | 'mcp' | 'workbenches' | 'marketplace';

/**
 * IDE 能力白名单：**唯一真源**（清单校验与桥协议都用这一份）。
 *
 * 前六个是"编辑器上下文 / 数据读取与展示"（已实现，见 `dshIdeCapabilities.ts`）；`canvas` / `mindmap`
 * 是**工具族**——它们的实现留在 VsSaros，dsh 侧只注册入口（方案 6.6 表末行）。
 *
 * ⚠ 2026-10-14 更正：上面这段话原来把 `browser` 也算作"实现留在 VsSaros（浏览器控制/CDP）"—— 那是
 *   **3b 之前**的事 ✗。IDE 侧的 CDP 直连与 `validateBrowserAction` 已随 3b **一并删除**（README 4.78），
 *   浏览器工具整族现在归 `dsh-plugins/vssaros-browser`（**Host 进程**直连 CDP、动作确认走 dsh 审批缝 ✓）。
 *   名字**留在白名单里只为兼容**：较老的已装插件清单里可能还写着 `browser`，删掉这条会让它们的清单
 *   校验直接失败 ✗（`isVssarosIdeCapability` 是清单校验的词汇表 ✓）；但真发一次
 *   `ide.request{capability:'browser'}` 会被 `dshIdeCapabilities.ts` 的 default 分支拒掉
 *   （`IDE 能力未实现：browser（已实现：…）`）。真机侧由 `poc/dsh-p0/scripts/p3-14-ide-e2e.mjs` 的 ⑤
 *   钉住（"连**声明了** `browser` 的替身插件也走不通" ✓）—— 这就是它与我下面写的 `unreal` 的区别：
 *   `unreal` 是**决策删除**（走"未知能力"），`browser` 是**留着兼容**（走"未实现"）✓。
 *
 * **为什么给 mindmap 单开名字，而不是折叠进 `browser` / `canvas`**（方案 13.3 那条"能力名仍有缺口"
 * 的落点）：折叠会让**粒度变粗**——一个只声明 `canvas` 的插件会顺带拿到 mindmap 工具，
 * "按清单逐项授权"就退化成"整族放行"。名字多一个的代价只是清单里多一项，
 * 换来的是"这个插件到底能驱动 IDE 到什么程度"在安装那一刻仍然可读、可审。
 *
 * ★ 2026-10-13（数据面 E 组 / README 5.124）：新增 `dashboardStats` —— 把 IDE 侧**本地聚合**的用量与
 *   告警投影给 Host（`dshIdeCapabilities.ts` 的 `case 'dashboardStats'`；**只投影、不整包透传** ✓）。
 *   它是 B 组"两个 dashboard 不是同一份数据"（5.115）的**反向通道解法**：当时以为没有通道，只好让
 *   两侧都写明口径；通道其实早在协议 v2 就有了 ✓。
 *   ⚠ 加名字**必须同时**改上面那个联合类型（`VssarosIdeCapability`）—— 少了它这一行本身就是类型错误 ✓。
 *
 * ★ 2026-10-13：`unreal` 能力名**已删除** ✗ —— 该族（七个工具）现全部由 dsh 侧 `dsh-plugins/vssaros-unreal`
 *   自己实现（Host 直连 `http://127.0.0.1:8765/bridge/*`），**不再经 IDE 反向通道** ⇒ 这里留着一个
 *   永远不会有调用者的能力名只会误导清单（"这个插件能驱动 IDE"的语义被稀释 ✗）。
 *   删除的**后果**由 `dshIdeAuthorization.test.ts` 钉住：它现在是"**未知**能力"（MethodNotFound）而
 *   不是"未声明能力" —— 免得哪天有人顺手加回去，谁都看不出那是一次决策 ✗。
 */
export const VSSAROS_IDE_CAPABILITIES: readonly VssarosIdeCapability[] = [
	'openFile', 'reveal', 'showDiff', 'getSelection', 'getDiagnostics',
	'dashboardStats',
	'browser', 'canvas', 'mindmap',
	// 展示类（不写任何数据）：打开看板编辑器并**定位**一张卡片 —— 原 `TasksViewPane` 点条目的行为
	// （`views/tasksView.ts:250-257` 的 `TaskOverviewEditorInput` + `focusTaskInBoard`）。
	'taskboard',
	// 同上，展示类：打开**工作流画布**编辑器 —— 对应原 `WorkflowViewPane._openWorkflow`
	// （`views/workflowView.ts:453-466`）的"点条目先开画布"那一半；那边之后还会切聊天区选 agent
	// （`_selectWorkflowAgentInChat`），那是 UI 副作用，能力层**不做**。
	'workflow',
	// ★ 2026-10-21：`media` —— **生图**（`op:'generateImage'`）。
	// 生图 provider、凭据与审批都在 IDE 进程 ⇒ dsh 侧插件（`@vssaros/dsh-imagegen`）
	// 经控制桥回调 IDE 来出图，Host 侧不存第二份 Key。
	'media',
	// ★ 2026-10-21：`skills` / `mcp` —— **商城清单**（`op:'marketList'`）。
	// 商城认证（JWT）在 IDE 进程（`IMarketplaceService` 复用 TOF 登录态）⇒ dsh 侧
	// `@vssaros/dsh-skills` 的 `skill_market` 与 `@vssaros/dsh-mcp` 的 `mcp_market`
	// 经控制桥回调 IDE 取清单（只读，不写任何数据 ✓）。
	// ⚠ 这两个能力此前**长期是坏的**：清单没声明 + IDE 侧没 case ⇒ 真机只表现为"市场不可用"✗。
	'skills', 'mcp',
	// ★ 2026-10-22：`workbenches` —— **安装第三方工作台**（`op:'install'`，`@vssaros/dsh-market` 用）。
	// 有副作用（往 profile 装包，包的服务端会以 Host 的权限运行）⇒ IDE 侧**必须先问用户**（fail-closed）；
	// 装包走主进程那条已验证的通道（暂存 + `dsh plugin add`），不走 Host 的 pluginManager（全新 profile 上会剪树失败）。
	'workbenches',
	// ★ 2026-10-22：`marketplace` —— **商城工作台的全套动作**
	// （`op: list|detail|install|uninstall|upgrade|publish|deletePackage|deleteVersion`）。
	//
	// ★ 为什么单开名字而不是复用 `skills`/`mcp`/`workbenches`：
	//   · `skills`/`mcp` 的 `marketList` 是**只读清单**（op 只有那一个）⇒ 装/卸/升级/发布
	//     不在它们的能力面里 ✗；
	//   · `workbenches` 只有 `op:'install'`（且**只**针对第三方工作台）⇒ 不覆盖
	//     agent/skill/workflow 的安装，也不覆盖卸载/升级/发布 ✗。
	//   ⇒ 商城工作台要一次覆盖 4 类商品 + 发布/维护/删除 ⇒ 单开一个 `marketplace` 能力 ✓
	//     （与"能力名粒度 = 授权粒度"的既有原则一致：`mindmap` 从 `browser` 折出来同理 ✓）。
	//
	// ★ 与 `workbenches` 的分工：`marketplace` 是**商城自营商品**（我们自己的服务端），
	//   `workbenches` 是**第三方工作台目录**（dsh 公开市场）⇒ 两条数据源，两条能力 ✓。
	'marketplace',
];

export interface IVssarosActivityBar {
	/** 容器 ID：内置模块沿用既有 ID；第三方必须以插件名为前缀（方案 6.5 / R1）。 */
	readonly containerId: string;
	readonly title: string | { readonly zh: string; readonly en: string };
	/** `codicon:xxx` 或包内 SVG 相对路径。 */
	readonly icon: string;
	readonly order: number;
}

/**
 * ★ 2026-10-22：**工作台描述符**（`doc/workbench-refactor-plan.md` §4.2 / P0-2）。
 *
 * 对标 dsh-desktop 的 `desktopWorkbenches.register(descriptor, Component)`（`client.js:852-883`）：
 * 字段名与取值范围**逐条照官方**，校验失败一律抛错（官方也是抛 —— "必须"项不满足 = 不登记，不是降级）。
 * 区别只有两处：
 * - **身份**：官方只认 `https://github.com/<owner>/<repo>`；内置工作台没有真实仓库（官方禁止捏造）⇒
 *   保留命名空间 `vssaros:<module>`，只许 `@vssaros/*` 包用，且必须等于自己的 module；
 * - **`panes`**（我们独有）：声明本工作台有哪几个 Pane（`catalog` 目录页 / `core` 核心页），
 *   驱动 IDE / dsh 窗口的承载位（`doc/workbench-authoring-standard.md` 稿 A）。
 *
 * 可选字段（v1 清单即可声明；没声明 = 该插件还不是"已注册的工作台"）。
 */
export interface IVssarosWorkbench {
	/** 工作台名（必填；官方 `register.title`）。≤ 24 字。 */
	readonly title: string | { readonly zh: string; readonly en: string };
	/** 一句话说明它解决什么问题（官方 `description`）。≤ 200 字。 */
	readonly description?: string;
	/** `codicon:xxx`；缺省沿用 `activityBar.icon`。 */
	readonly icon?: string;
	/** 工作台身份：内置 `vssaros:<module>`，第三方 `https://github.com/<owner>/<repo>`。缺省（内置）按 module 推导。 */
	readonly repository: string;
	/** true = 业务整页 + 按需会话；false/缺省 = 标准分栏（官方 §4.1）。 */
	readonly customFrame?: boolean;
	/** 官方 `headerLayout`：`compact` 需要文档内唯一 `data-dsh-workbench-toolbar`。 */
	readonly headerLayout?: 'default' | 'compact';
	/** 官方 `layout`：业务区在哪侧、占主内容区多少（0.25–0.7）。 */
	readonly layout?: { readonly businessSide?: 'left' | 'right'; readonly businessWidth?: number };
	/** 我们独有：Pane 声明（缺省 `['catalog','core']`）。 */
	readonly panes: readonly VssarosWorkbenchPane[];
}

export type VssarosWorkbenchPane = 'catalog' | 'core';

/** 内置工作台的身份前缀（`vssaros:<module>`）。 */
export const VSSAROS_WORKBENCH_REPOSITORY_SCHEME = 'vssaros:';
const GITHUB_REPOSITORY_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
/** 与官方同口径：`businessWidth` 的合法区间。 */
export const VSSAROS_WORKBENCH_BUSINESS_WIDTH_MIN = 0.25;
export const VSSAROS_WORKBENCH_BUSINESS_WIDTH_MAX = 0.7;

/**
 * 工作台身份（小写 `owner/repo`；内置为 `vssaros/<module>`）—— 市场卡片、入口与会话归属共用这一个键。
 * 与官方 `repositoryIdentity`（`client.js:414-420`）同口径：GitHub owner/repo 一律小写。
 */
export function workbenchIdentityOf(workbench: Pick<IVssarosWorkbench, 'repository'>): string {
	const repository = workbench.repository;
	if (repository.startsWith(VSSAROS_WORKBENCH_REPOSITORY_SCHEME)) {
		return `vssaros/${repository.slice(VSSAROS_WORKBENCH_REPOSITORY_SCHEME.length).toLowerCase()}`;
	}
	const m = GITHUB_REPOSITORY_RE.exec(repository);
	if (!m) {
		throw new VssarosManifestError(`工作台身份无法解析：${repository}`);
	}
	return `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
}

export interface IVssarosPluginManifest {
	readonly manifestVersion: 1;
	/** 模块 id（`skills` / `mcp` / `kb` / ...）；缺省表示该插件不归属任何内置模块。 */
	readonly module?: string;
	readonly activityBar?: IVssarosActivityBar;
	/** 缺省 = `{ kind: 'page', route: '/x/<module>/' }`（决议③默认 page）。 */
	readonly view: IVssarosView;
	readonly ideCapabilities?: readonly VssarosIdeCapability[];
	/** 独占写入的数据路径（单写者声明，方案 6.8）。 */
	readonly owns?: readonly string[];
	/** 对应的旧模块 id；插件启用时触发所有权切换（方案 6.8）。 */
	readonly legacyCounterpart?: string;
	/** 工作台描述符（可选；见 `IVssarosWorkbench`）。 */
	readonly workbench?: IVssarosWorkbench;
}

/** 清单不合法时抛出；调用方据此忽略该插件（fail-closed，不猜字段）。 */
export class VssarosManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VssarosManifestError';
	}
}

const MODULE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CONTAINER_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/;
const ROUTE_RE = /^\/[A-Za-z0-9._~/-]{0,199}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 从包名推导容器前缀：去掉 scope（`@acme/dsh-graph-viewer` → `dsh-graph-viewer`）。 */
export function containerPrefixOf(pluginName: string): string {
	const slash = pluginName.lastIndexOf('/');
	return slash >= 0 ? pluginName.slice(slash + 1) : pluginName;
}

/**
 * 该包名是不是 **VsSaros 自己的内置模块插件**（⇒ 解析清单时允许沿用 `agentStudio.*`
 * 容器 ID 与小 order 等"自家担保"的写法）。
 *
 * 真源只此一处：`dshHarnessChannel._readPluginManifest`（UI 注册）与
 * `readCapabilityDeclarations`（IDE 能力授权）必须同口径 —— 2026-10-17 的事故正是
 * 两条路径口径不一致（后者漏传 `builtin`）导致内置插件全部零能力。
 */
export function isBuiltinPluginName(pluginName: string): boolean {
	return pluginName.startsWith('@vssaros/');
}

function parseTitle(raw: unknown, field: string): string | { zh: string; en: string } {
	if (typeof raw === 'string' && raw.trim()) {
		return raw;
	}
	if (isPlainObject(raw) && typeof raw.zh === 'string' && typeof raw.en === 'string' && raw.zh.trim() && raw.en.trim()) {
		return { zh: raw.zh, en: raw.en };
	}
	throw new VssarosManifestError(`${field} 必须是字符串或 { zh, en }`);
}

function parseActivityBar(raw: unknown, options: IParseManifestOptions): IVssarosActivityBar {
	if (!isPlainObject(raw)) {
		throw new VssarosManifestError('vssaros.activityBar 必须是对象');
	}
	const containerId = typeof raw.containerId === 'string' ? raw.containerId.trim() : '';
	if (!containerId || !CONTAINER_ID_RE.test(containerId)) {
		throw new VssarosManifestError('vssaros.activityBar.containerId 缺失或格式不合法');
	}
	if (!options.builtin && containerId.startsWith(VSSAROS_RESERVED_CONTAINER_PREFIX)) {
		// 第三方插件不得使用 VsSaros 自有命名空间（决议②）。内置模块由 VsSaros 担保，
		// 允许用 `vssaros.dsh.codebase` 这类新建容器 ID（方案 6.5）。
		throw new VssarosManifestError(`容器 ID 不得使用 VsSaros 常驻命名空间（${VSSAROS_RESERVED_CONTAINER_PREFIX}*）：${containerId}`);
	}
	const order = raw.order;
	if (typeof order !== 'number' || !Number.isInteger(order)) {
		throw new VssarosManifestError('vssaros.activityBar.order 必须是整数');
	}
	if (!options.builtin) {
		// 第三方：order 落在 200–899，且容器 ID 以插件名为前缀（方案 6.5）。
		if (order < VSSAROS_THIRD_PARTY_ORDER_MIN || order > VSSAROS_THIRD_PARTY_ORDER_MAX) {
			throw new VssarosManifestError(`第三方插件的 order 必须落在 ${VSSAROS_THIRD_PARTY_ORDER_MIN}–${VSSAROS_THIRD_PARTY_ORDER_MAX}：${order}`);
		}
		const prefix = options.pluginName ? containerPrefixOf(options.pluginName) : undefined;
		if (prefix && containerId !== prefix && !containerId.startsWith(`${prefix}.`)) {
			throw new VssarosManifestError(`第三方插件的容器 ID 必须以插件名为前缀（${prefix}）：${containerId}`);
		}
	}
	const icon = typeof raw.icon === 'string' ? raw.icon.trim() : '';
	if (!icon) {
		throw new VssarosManifestError('vssaros.activityBar.icon 不能为空');
	}
	return { containerId, title: parseTitle(raw.title, 'vssaros.activityBar.title'), icon, order };
}

/** 原生视图的取数路由：站内绝对路径，**不许**带查询串 / 片段（见 `IVssarosNativeView.data`）。 */
function parseNativeData(raw: unknown): IVssarosNativeData | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!isPlainObject(raw)) {
		throw new VssarosManifestError('vssaros.view.data 必须是对象');
	}
	for (const key of Object.keys(raw)) {
		if (key !== 'route') {
			throw new VssarosManifestError(`vssaros.view.data 不认识的字段：${key}`);
		}
	}
	const route = typeof raw.route === 'string' ? raw.route.trim() : '';
	// `ROUTE_RE` 本身就不含 `?` / `#`，但那是字符集层面的"恰好"——这里把意图写明，
	// 将来谁放宽了字符集也不会顺手把查询串放进来。
	if (!route || !ROUTE_RE.test(route) || route.includes('..') || route.includes('?') || route.includes('#')) {
		throw new VssarosManifestError('vssaros.view.data.route 缺失或不合法（站内绝对路径，不含 .. / ? / #）');
	}
	return { route };
}

const NATIVE_ACTION_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** 原生标题栏动作：最多 8 个（侧栏标题栏放不下更多，且多到那个数量就该进"..."菜单）。 */
function parseNativeActions(raw: unknown): readonly IVssarosNativeAction[] | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!Array.isArray(raw)) {
		throw new VssarosManifestError('vssaros.view.actions 必须是数组');
	}
	if (raw.length > 8) {
		throw new VssarosManifestError('vssaros.view.actions 最多 8 项');
	}
	const seen = new Set<string>();
	return raw.map((item, i) => {
		if (!isPlainObject(item)) {
			throw new VssarosManifestError(`vssaros.view.actions[${i}] 必须是对象`);
		}
		for (const key of Object.keys(item)) {
			if (key !== 'id' && key !== 'title' && key !== 'icon') {
				throw new VssarosManifestError(`vssaros.view.actions[${i}] 不认识的字段：${key}`);
			}
		}
		const id = typeof item.id === 'string' ? item.id.trim() : '';
		if (!id || !NATIVE_ACTION_ID_RE.test(id)) {
			throw new VssarosManifestError(`vssaros.view.actions[${i}].id 缺失或格式不合法（小写字母开头，可含数字与 -）`);
		}
		if (seen.has(id)) {
			// 重复 id ⇒ IDE 侧按 id 分派会二义（点一个动作触发两次），必须挡在清单层。
			throw new VssarosManifestError(`vssaros.view.actions 里 id 重复：${id}`);
		}
		seen.add(id);
		const icon = item.icon === undefined ? undefined : (typeof item.icon === 'string' ? item.icon.trim() : '');
		if (item.icon !== undefined && !icon) {
			throw new VssarosManifestError(`vssaros.view.actions[${i}].icon 必须是非空字符串`);
		}
		return {
			id,
			title: parseTitle(item.title, `vssaros.view.actions[${i}].title`),
			...(icon ? { icon } : {}),
		};
	});
}

function parseView(raw: unknown, module: string | undefined): IVssarosView {
	if (raw === undefined) {
		// 决议③：默认 page；route 按 module 推导，缺 module 无法推导 → 报错（不猜）。
		if (!module) {
			throw new VssarosManifestError('缺省 view 时必须有 vssaros.module（用于推导默认 page 路由）');
		}
		return { kind: 'page', route: `/x/${module}/` };
	}
	if (!isPlainObject(raw)) {
		throw new VssarosManifestError('vssaros.view 必须是对象');
	}
	const kind = raw.kind;
	if (kind === 'page') {
		const route = typeof raw.route === 'string' ? raw.route.trim() : '';
		if (!route || !ROUTE_RE.test(route) || route.includes('..')) {
			throw new VssarosManifestError('vssaros.view.route 缺失或不合法（需以 / 开头、不含 ..）');
		}
		return { kind: 'page', route };
	}
	if (kind === 'native') {
		const viewType = typeof raw.viewType === 'string' ? raw.viewType.trim() : '';
		if (!viewType || !CONTAINER_ID_RE.test(viewType)) {
			throw new VssarosManifestError('vssaros.view.viewType 缺失或格式不合法');
		}
		// ⚠ 未知字段一律报错（与 `workbench` 同口径）：`data` 写成 `dataRoute` 这种笔误，
		//   如果被静默吞掉，表现就是"原生视图起来了但一片空白"——比直接报错难查得多。
		for (const key of Object.keys(raw)) {
			if (key !== 'kind' && key !== 'viewType' && key !== 'data' && key !== 'actions') {
				throw new VssarosManifestError(`vssaros.view（kind=native）不认识的字段：${key}`);
			}
		}
		const data = parseNativeData(raw.data);
		const actions = parseNativeActions(raw.actions);
		return {
			kind: 'native',
			viewType,
			...(data ? { data } : {}),
			...(actions ? { actions } : {}),
		};
	}
	if (kind === 'section') {
		const host = typeof raw.host === 'string' ? raw.host.trim() : '';
		if (!host || !CONTAINER_ID_RE.test(host)) {
			throw new VssarosManifestError('vssaros.view.host 缺失或格式不合法（宿主模块 id）');
		}
		if (module && host === module) {
			throw new VssarosManifestError('vssaros.view.host 不能是自己（寄居区块的宿主必须是同容器里的另一个模块）');
		}
		const route = typeof raw.route === 'string' ? raw.route.trim() : '';
		if (!route || !ROUTE_RE.test(route) || route.includes('..')) {
			throw new VssarosManifestError('vssaros.view.route 缺失或不合法（片段路由需以 / 开头、不含 ..）');
		}
		return { kind: 'section', host, route };
	}
	if (kind === 'none') {
		// 显式声明"没有界面"：不允许再带界面字段（写混了就是自相矛盾，早点报）
		for (const field of ['route', 'host', 'viewType', 'data', 'actions'] as const) {
			if (raw[field] !== undefined) {
				throw new VssarosManifestError(`vssaros.view.kind=none 表示不提供界面，不能再带 ${field}`);
			}
		}
		return { kind: 'none' };
	}
	throw new VssarosManifestError(`vssaros.view.kind 必须是 page / native / section / none：${String(kind)}`);
}

function parseStringArray(raw: unknown, field: string): readonly string[] | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!Array.isArray(raw)) {
		throw new VssarosManifestError(`${field} 必须是数组`);
	}
	if (raw.length > 16) {
		throw new VssarosManifestError(`${field} 最多 16 项`);
	}
	for (const item of raw) {
		if (typeof item !== 'string' || !item.trim()) {
			throw new VssarosManifestError(`${field} 的每一项都必须是非空字符串`);
		}
	}
	return raw.map(s => s.trim());
}

export interface IParseManifestOptions {
	/** 声明方包名（`@acme/dsh-graph-viewer`）；给出时对第三方执行前缀与 order 约束。 */
	readonly pluginName?: string;
	/** true = VsSaros 自身的内置模块插件：允许沿用既有 `agentStudio.*` 容器 ID 与 order。 */
	readonly builtin?: boolean;
}

const WORKBENCH_PANES: readonly VssarosWorkbenchPane[] = ['catalog', 'core'];
const WORKBENCH_KEYS = new Set(['title', 'description', 'icon', 'repository', 'customFrame', 'headerLayout', 'layout', 'panes']);

/** 标题长度按"字"算（码点数）；中英文同一上限，避免英文长名把窄入口撑爆。 */
function lengthOf(s: string): number {
	return [...s].length;
}

/**
 * 校验 `vssaros.workbench`。规则逐条对齐官方 `register()`（`client.js:852-883`）：
 * title 必填 / customFrame 布尔 / headerLayout ∈ {default, compact} /
 * layout.businessSide ∈ {left, right} / layout.businessWidth ∈ [0.25, 0.7]；
 * 外加身份规则（见 `IVssarosWorkbench`）与 panes。未知字段直接报错（写错名字 ≠ 没写，不静默吞）。
 */
function parseWorkbench(raw: unknown, module: string | undefined, activityBar: IVssarosActivityBar | undefined, view: IVssarosView, options: IParseManifestOptions): IVssarosWorkbench {
	if (!isPlainObject(raw)) {
		throw new VssarosManifestError('vssaros.workbench 必须是对象');
	}
	for (const key of Object.keys(raw)) {
		if (!WORKBENCH_KEYS.has(key)) {
			throw new VssarosManifestError(`vssaros.workbench 不认识的字段：${key}`);
		}
	}
	if (view.kind === 'none') {
		throw new VssarosManifestError('vssaros.workbench 要求有界面：view.kind=none 的插件不能声明工作台');
	}
	const title = parseTitle(raw.title, 'vssaros.workbench.title');
	for (const t of typeof title === 'string' ? [title] : [title.zh, title.en]) {
		if (lengthOf(t.trim()) > 24) {
			throw new VssarosManifestError(`vssaros.workbench.title 不能超过 24 字：${t}`);
		}
	}
	let description: string | undefined;
	if (raw.description !== undefined) {
		if (typeof raw.description !== 'string' || !raw.description.trim()) {
			throw new VssarosManifestError('vssaros.workbench.description 必须是非空字符串');
		}
		if (lengthOf(raw.description) > 200) {
			throw new VssarosManifestError('vssaros.workbench.description 不能超过 200 字');
		}
		description = raw.description.trim();
	}
	let icon: string | undefined;
	if (raw.icon !== undefined) {
		if (typeof raw.icon !== 'string' || !raw.icon.trim()) {
			throw new VssarosManifestError('vssaros.workbench.icon 必须是非空字符串');
		}
		icon = raw.icon.trim();
	} else if (activityBar) {
		icon = activityBar.icon;
	}
	// 身份
	let repository: string;
	if (raw.repository === undefined) {
		if (!options.builtin || !module) {
			throw new VssarosManifestError('vssaros.workbench.repository 必填（第三方工作台须是 https://github.com/<owner>/<repo>）');
		}
		repository = `${VSSAROS_WORKBENCH_REPOSITORY_SCHEME}${module}`;
	} else {
		if (typeof raw.repository !== 'string' || !raw.repository.trim()) {
			throw new VssarosManifestError('vssaros.workbench.repository 必须是非空字符串');
		}
		repository = raw.repository.trim();
	}
	if (repository.startsWith(VSSAROS_WORKBENCH_REPOSITORY_SCHEME)) {
		if (!options.builtin) {
			throw new VssarosManifestError(`保留身份 ${VSSAROS_WORKBENCH_REPOSITORY_SCHEME}* 只许 VsSaros 内置插件使用：${repository}`);
		}
		if (repository !== `${VSSAROS_WORKBENCH_REPOSITORY_SCHEME}${module ?? ''}`) {
			throw new VssarosManifestError(`内置工作台身份必须等于 ${VSSAROS_WORKBENCH_REPOSITORY_SCHEME}<module>（${VSSAROS_WORKBENCH_REPOSITORY_SCHEME}${module ?? '?'}）：${repository}`);
		}
	} else if (!GITHUB_REPOSITORY_RE.test(repository)) {
		throw new VssarosManifestError(`vssaros.workbench.repository 必须是 https://github.com/<owner>/<repo>：${repository}`);
	}
	if (raw.customFrame !== undefined && typeof raw.customFrame !== 'boolean') {
		throw new VssarosManifestError('vssaros.workbench.customFrame 必须是布尔值');
	}
	if (raw.headerLayout !== undefined && raw.headerLayout !== 'default' && raw.headerLayout !== 'compact') {
		throw new VssarosManifestError(`vssaros.workbench.headerLayout 必须是 default / compact：${String(raw.headerLayout)}`);
	}
	let layout: IVssarosWorkbench['layout'];
	if (raw.layout !== undefined) {
		if (!isPlainObject(raw.layout)) {
			throw new VssarosManifestError('vssaros.workbench.layout 必须是对象');
		}
		for (const key of Object.keys(raw.layout)) {
			if (key !== 'businessSide' && key !== 'businessWidth') {
				throw new VssarosManifestError(`vssaros.workbench.layout 不认识的字段：${key}`);
			}
		}
		const side = raw.layout.businessSide;
		if (side !== undefined && side !== 'left' && side !== 'right') {
			throw new VssarosManifestError(`vssaros.workbench.layout.businessSide 必须是 left / right：${String(side)}`);
		}
		const width = raw.layout.businessWidth;
		if (width !== undefined && (typeof width !== 'number' || !Number.isFinite(width) || width < VSSAROS_WORKBENCH_BUSINESS_WIDTH_MIN || width > VSSAROS_WORKBENCH_BUSINESS_WIDTH_MAX)) {
			throw new VssarosManifestError(`vssaros.workbench.layout.businessWidth 必须在 ${VSSAROS_WORKBENCH_BUSINESS_WIDTH_MIN}–${VSSAROS_WORKBENCH_BUSINESS_WIDTH_MAX} 之间：${String(width)}`);
		}
		layout = { ...(side ? { businessSide: side } : {}), ...(width !== undefined ? { businessWidth: width } : {}) };
	}
	let panes: readonly VssarosWorkbenchPane[] = WORKBENCH_PANES;
	if (raw.panes !== undefined) {
		if (!Array.isArray(raw.panes) || raw.panes.length === 0) {
			throw new VssarosManifestError('vssaros.workbench.panes 必须是非空数组');
		}
		const seen = new Set<string>();
		for (const p of raw.panes) {
			if (!WORKBENCH_PANES.includes(p as VssarosWorkbenchPane)) {
				throw new VssarosManifestError(`vssaros.workbench.panes 只能是 catalog / core：${String(p)}`);
			}
			if (seen.has(p as string)) {
				throw new VssarosManifestError(`vssaros.workbench.panes 重复：${String(p)}`);
			}
			seen.add(p as string);
		}
		panes = raw.panes as VssarosWorkbenchPane[];
	}
	return {
		title,
		...(description ? { description } : {}),
		...(icon ? { icon } : {}),
		repository,
		...(raw.customFrame !== undefined ? { customFrame: raw.customFrame as boolean } : {}),
		...(raw.headerLayout !== undefined ? { headerLayout: raw.headerLayout as 'default' | 'compact' } : {}),
		...(layout ? { layout } : {}),
		panes,
	};
}

/**
 * 校验并规范化 `package.json` 的 `vssaros` 字段。不合法时抛 `VssarosManifestError`，
 * 由调用方忽略该插件并记录日志（不猜测、不降级成半可用状态）。
 */
export function parseVssarosManifest(raw: unknown, options: IParseManifestOptions = {}): IVssarosPluginManifest {
	if (!isPlainObject(raw)) {
		throw new VssarosManifestError('vssaros 清单必须是对象');
	}
	if (raw.manifestVersion !== VSSAROS_MANIFEST_VERSION) {
		throw new VssarosManifestError(`vssaros.manifestVersion 必须为 ${VSSAROS_MANIFEST_VERSION}`);
	}
	let module: string | undefined;
	if (raw.module !== undefined) {
		if (typeof raw.module !== 'string' || !MODULE_ID_RE.test(raw.module)) {
			throw new VssarosManifestError('vssaros.module 格式不合法（小写字母开头，字母/数字/连字符）');
		}
		module = raw.module;
	}
	const activityBar = raw.activityBar === undefined ? undefined : parseActivityBar(raw.activityBar, options);
	const view = parseView(raw.view, module);

	let ideCapabilities: readonly VssarosIdeCapability[] | undefined;
	if (raw.ideCapabilities !== undefined) {
		const list = parseStringArray(raw.ideCapabilities, 'vssaros.ideCapabilities');
		if (!list) {
			throw new VssarosManifestError('vssaros.ideCapabilities 必须是数组');
		}
		for (const cap of list) {
			if (!VSSAROS_IDE_CAPABILITIES.includes(cap as VssarosIdeCapability)) {
				throw new VssarosManifestError(`未支持的能力名：${cap}（可用：${VSSAROS_IDE_CAPABILITIES.join(' / ')}）`);
			}
		}
		ideCapabilities = list as readonly VssarosIdeCapability[];
	}

	const owns = parseStringArray(raw.owns, 'vssaros.owns');
	let legacyCounterpart: string | undefined;
	if (raw.legacyCounterpart !== undefined) {
		if (typeof raw.legacyCounterpart !== 'string' || !raw.legacyCounterpart.trim()) {
			throw new VssarosManifestError('vssaros.legacyCounterpart 必须是非空字符串');
		}
		legacyCounterpart = raw.legacyCounterpart.trim();
	}
	const workbench = raw.workbench === undefined ? undefined : parseWorkbench(raw.workbench, module, activityBar, view, options);

	return {
		manifestVersion: VSSAROS_MANIFEST_VERSION,
		...(module ? { module } : {}),
		...(activityBar ? { activityBar } : {}),
		view,
		...(ideCapabilities ? { ideCapabilities } : {}),
		...(owns ? { owns } : {}),
		...(legacyCounterpart ? { legacyCounterpart } : {}),
		...(workbench ? { workbench } : {}),
	};
}

/** 便利函数：不抛错的版本，返回 `{ manifest }` 或 `{ error }`。 */
export function tryParseVssarosManifest(raw: unknown, options: IParseManifestOptions = {}):
	{ readonly manifest: IVssarosPluginManifest; readonly error?: undefined } | { readonly manifest?: undefined; readonly error: string } {
	try {
		return { manifest: parseVssarosManifest(raw, options) };
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

/** 工作台宿主插件的包名（客户端服务 `desktopWorkbenches` 的提供方）。 */
export const VSSAROS_WORKBENCH_HOST_PACKAGE = '@vssaros/dsh-workbenches';

/**
 * 该包是否已迁成 **React 工作台**（2026-10-22，doc/workbench-refactor-plan.md §5 步骤 4）：
 * 清单声明了 `vssaros.workbench`、有客户端入口，且 `dsh.client.inject` 含宿主包（加载链完整的唯一判据，
 * 与守卫 `dshPluginPackages.test.ts` 的"加载链完整"同口径）。纯函数：只看 package.json 的形状。
 */
export function hasWorkbenchClient(pkg: unknown): boolean {
	if (!isPlainObject(pkg)) {
		return false;
	}
	const vssaros = pkg.vssaros;
	if (!isPlainObject(vssaros) || !isPlainObject(vssaros.workbench)) {
		return false;
	}
	const exportsField = pkg.exports;
	if (!isPlainObject(exportsField) || exportsField['./client'] === undefined) {
		return false;
	}
	const dsh = pkg.dsh;
	const client = isPlainObject(dsh) ? dsh.client : undefined;
	const inject = isPlainObject(client) ? client.inject : undefined;
	return Array.isArray(inject) && inject.includes(VSSAROS_WORKBENCH_HOST_PACKAGE);
}

/** 清单里的 ActivityBar 图标是否为包内 SVG 相对路径（否则按 codicon 处理）。 */
export function isRelativeIconPath(icon: string): boolean {
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(icon);
	return !scheme && !icon.startsWith('/') && !icon.includes('..');
}
