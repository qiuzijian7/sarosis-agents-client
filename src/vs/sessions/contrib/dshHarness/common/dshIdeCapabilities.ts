/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE 能力的**执行**（反向通道 `ide.request` 的最后一站）。
 *
 * 授权在 `dshIdeAuthorization.ts`（主进程）、这里的输入是**已授权**的请求。本模块只管"读/展示 IDE 状态
 * 并整形"，不碰服务：真实服务（marker / editor / files / 工作区）由 `IIdeCapabilityEnv` 适配进来——
 * 于是这些逻辑**能单测**，而不必拉起工作台。
 *
 * 口径：
 * 1. **只读 + 只展示**：三个读能力（`getDiagnostics` / `getSelection`）不改任何状态；三个"打开类"能力
 *    （`openFile` / `reveal` / `showDiff`）只**打开/定位**，不写文件、不改内容。写入能力（`applyEdit` 之类）
 *    不在这一版里。
 * 2. **有上限**：回给 Host 的内容会进模型上下文，条数与文本都有硬上限，并**如实标注**被截断
 *    （`truncated` / `note`），绝不悄悄丢数据。
 * 3. **打开类能力的策略**（三条，都有来处，见下面 `openFile` 的注释）：
 *    - 一律开在**文件编辑区**（不指定分组会落到活动分组，而聊天框就是活动分组 ⇒ 会盖住聊天框）；
 *    - **默认不抢焦点**（`focus: true` 才切）——这些是**模型发起**的，与"用户点文件链接"不同；
 *    - 文件**不存在**不开（不产生空标签）、**工作区之外**不开（工具侧没有用户在场做确认）。
 */

import { URI } from '../../../../base/common/uri.js';
import { IMarker, MarkerSeverity } from '../../../../platform/markers/common/markers.js';

/** 一次诊断回执最多带多少条（进模型上下文，必须有上限）。 */
export const IDE_DIAGNOSTICS_LIMIT = 50;
/** 选区文本最多回多少字符。 */
export const IDE_SELECTION_TEXT_LIMIT = 4000;


/** 需要用户确认的动作 → 给用户看的一句话（说清"要做什么"，不然用户没法判断）。 */
export function describeBrowserAction(op: string, params: Record<string, unknown>): string {
	switch (op) {
		case 'navigate': return `打开网址：${String(params.url ?? '')}`;
		case 'click': return `点击页面元素 [${String(params.ref ?? '')}]`;
		case 'type': return `在元素 [${String(params.ref ?? '')}] 里输入：${String(params.text ?? '').slice(0, 80)}`;
		case 'pressEnter': return '按回车';
		case 'pressKey': return `按键：${String(params.key ?? '')}`;
		case 'scroll': return `滚动页面（${String(params.direction ?? '')} ${String(params.amount ?? '')}）`;
		case 'back': return '浏览器后退';
		case 'reset': return '重置浏览器连接（丢弃当前缓存页面）';
		default: return `浏览器操作：${op}`;
	}
}

/** 工作流画布的上限（节点 / 连线 / 上次操作摘要）。 */
export const IDE_CANVAS_NODES_LIMIT = 100;
export const IDE_CANVAS_EDGES_LIMIT = 200;
export const IDE_CANVAS_OPS_LIMIT = 20;

/**
 * `canvas` 能力的**只读** op（与既有工具 `canvas_get_state` / `canvas_get_task_status` 对齐）。
 */
export const IDE_CANVAS_READ_OPS = ['state', 'task_status'] as const;
/**
 * **改画布**的 op（三件，都需要用户逐次确认）：`apply_ops` 批次改节点/连线、`generate` 生成一张流程
 * （`run:true` 时**真的跑起来**）、`reverse_prompt` 让模型看图反推提示词写回节点。
 */
export const IDE_CANVAS_ACTION_OPS = ['apply_ops', 'generate', 'reverse_prompt'] as const;
/**
 * 画布侧认的两个**语义 op 类型**（不是普通节点类型）。
 *
 * `canvasTools.ts` 里的 `canvas_generate` / `canvas_reverse_prompt` 也各只发一条 `add_node`，
 * `type` 用这两个魔法字串——真正干活的是画布 webview（`buildGenerateFlow` 等，有单测）。
 * 也就是说：这两个 op **不需要"在模块内实现"**，dsh 侧要做的只是把同一份 op 构造出来，
 * 走那条已经有的桥（`apply_ops` 用的就是它）。
 *
 * ⚠ 字串是**跨进程契约**（dsh → webview）：上游改名不会编译报错，只会在真机上变成
 * "加了个看不懂的节点"。所以单测里有一条**跨源码一致性**断言直接读 `canvasTools.ts` 比对。
 */
export const IDE_CANVAS_GENERATE_FLOW_TYPE = '__generate_flow__';
export const IDE_CANVAS_REVERSE_PROMPT_TYPE = '__reverse_prompt__';

/** 一次 `apply_ops` 最多多少条（既有工具没有硬上限，但回执/日志/确认文案都需要一个）。 */
export const IDE_CANVAS_APPLY_OPS_LIMIT = 50;

/** 允许的画布操作种类（与 `canvasOpsBridge.ts` 的 `CanvasOp` 联合类型一致）。 */
export const IDE_CANVAS_OP_KINDS = ['add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'select'] as const;

/** 把一批画布操作说成人话（确认弹窗要让用户能判断"这条要不要允许"）。 */
export function describeCanvasOps(ops: readonly Record<string, unknown>[]): string {
	const tally = new Map<string, number>();
	for (const op of ops) {
		const kind = String(op.op);
		tally.set(kind, (tally.get(kind) ?? 0) + 1);
	}
	return `${ops.length} 个操作（${[...tally.entries()].map(([kind, count]) => `${kind} ×${count}`).join('、')}）`;
}

/**
 * 画布快照的**结构镜像**（真源是 `agentStudio` 的 `canvasContextStore`）。
 *
 * 刻意在 common 里**结构化声明**而不是 import 那边的类型：common 不该依赖 agentStudio，
 * 而这几个字段就是本能力要读的全部。
 */
export interface IIdeCanvasSnapshot {
	readonly nodes: readonly {
		readonly label?: string;
		readonly type?: string;
		readonly runState?: string;
		readonly errorMsg?: string;
	}[];
	readonly edges?: readonly { readonly source?: string; readonly target?: string }[];
	readonly lastOpsSummary?: readonly string[];
	readonly updatedAt?: string;
}

/** 当前活动编辑器的选区（值形态，便于单测）。 */
export interface IIdeActiveSelection {
	readonly resource: URI;
	readonly text: string;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
}

/** 打开时的行列范围（1-based，与编辑器一致）。 */
export interface IIdeSelectionRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

/**
 * `dashboardStats` 能力的**最小输入**（README 5.124，数据面 E 组）。
 *
 * ⚠ 刻意**不是** `IDashboardData` ✗：那个包里还有 sessions / skills / budgets / tokenByModel /
 * dailyBuckets…（量级大 ✓）⇒ 能力的**返回值必须小且稳定** ✓（同 `presentationMeta` 的纪律 ✓）。
 * 渲染进程从这里投影出这一小撮 ✓，派发器只负责整形 ✓（与它"不碰服务、只整形"的分工一致 ✓）。
 */
export interface IIdeDashboardSummary {
	/** 当前聚合口径（`IDashboardData` 的日期范围 ✓）。 */
	readonly range: string;
	readonly sessionCount: number;
	readonly activeSessions: number;
	readonly alertCount: number;
	/** 告警前几条（已截断 ✓ —— 全量不进通道 ✗）。 */
	readonly alertTop: readonly string[];
	/** KPI 卡片（同上：**已截断** ✓）。 */
	readonly kpis: readonly { readonly label: string; readonly value: string; readonly unit?: string; readonly detail?: string }[];
	readonly lastUpdated: number;
}

/** IDE 状态与编辑器操作的适配面（真实实现由渲染进程服务提供）。 */
export interface IIdeCapabilityEnv {
	/** 当前活动编辑器的资源；没有编辑器时 `undefined`。 */
	activeResource(): URI | undefined;
	/** 读诊断；传 `undefined` = 全工作区。 */
	readMarkers(resource: URI | undefined): readonly IMarker[];
	/** 当前活动文本编辑器的选区；没有时 `undefined`。 */
	activeSelection(): IIdeActiveSelection | undefined;
	/**
	 * **IDE 本地聚合**的用量/告警摘要（数据面 E 组 ✓）；服务还没数据时返回 `undefined` ✓。
	 *
	 * ⚠ 这是本接口里**第一个读 IDE 内存聚合**的成员 ✓（其余都读编辑器/工作区状态 ✓）—— 它的存在本身
	 * 就是"两个 dashboard 不是同一份数据"（README 5.115）那条结论的**解法** ✓：dsh 侧要统一口径，
	 * 就得从这里拿 ✓，而不是去猜 IDE 的库 ✗。
	 */
	dashboardSummary(): IIdeDashboardSummary | undefined;
	/**
	 * **商城可安装包的清单**（`skills` / `mcp` 两条能力用，2026-10-21）。
	 *
	 * ⚠ 认证（商城 JWT）在 IDE 侧（`IMarketplaceService` 复用 TOF 登录态）⇒ dsh 侧只发意图 ✓。
	 */
	marketList(kind: 'skill' | 'mcp', opts: { readonly q?: string; readonly limit: number }): Promise<{
		readonly items: readonly {
			readonly id: string;
			readonly slug: string;
			readonly name: string;
			readonly version: string;
			readonly description: string;
			readonly author: string;
			readonly category: string;
		}[];
		readonly total: number;
	}>;
	/** 把参数里的路径解析成资源（相对路径按工作区解析）；解析不了返回 `undefined`。 */
	resolvePath(path: string): URI | undefined;
	/** 资源是否存在（不存在就别开空标签）。 */
	exists(resource: URI): Promise<boolean>;
	/** 资源是否在工作区内（打开类能力只服务工作区内的文件）。 */
	isInsideWorkspace(resource: URI): boolean;
	/** 在**文件编辑区**打开资源（`focus=false` 时不抢焦点）。 */
	openResource(resource: URI, options: { readonly focus: boolean; readonly selection?: IIdeSelectionRange }): Promise<void>;
	/** 在资源管理器里定位资源（做不到时由适配层回退成打开）。 */
	revealInExplorer(resource: URI): Promise<void>;
	/** 打开只读 diff（两边都已在工作区内且存在）。 */
	openDiff(left: URI, right: URI, options: { readonly focus: boolean; readonly title?: string }): Promise<void>;
	/**
	 * **打开看板编辑器并定位一张卡片**（展示类：不改任何数据、不写文件）。
	 *
	 * 与原 `TasksViewPane` 点条目**同一条实现**（`views/tasksView.ts:250-257`）：
	 * `TaskOverviewEditorInput.getOrCreate()` → 在文件编辑区打开 → `focusTaskInBoard(title)` 高亮。
	 * 刻意按**标题**定位：那是两侧都拿得到的东西（卡片 id 只在看板内部流转），与既有实现同口径。
	 */
	focusTaskboard(title: string): Promise<void>;
	/**
	 * **打开工作流画布编辑器**（展示类：不改任何数据、不写文件）。
	 *
	 * 对应原 `WorkflowViewPane._openWorkflow` 的**前半**（`views/workflowView.ts:453-466`）：
	 * 按 id 取到 `IStoredWorkflow` → `new WorkflowEditorInput(wf)` → 已开则 reveal、否则打开。
	 * 那边还会顺带切聊天区选 agent（`_selectWorkflowAgentInChat`）—— 那是 UI 副作用，能力层不做。
	 */
	openWorkflow(id: string): Promise<{ readonly id: string; readonly name: string }>;

	/**
	 * **执行工作流里的单个节点**（`workflow` 能力的 `op:'executeNode'`），返回该节点的产出。
	 *
	 * 由 dsh 侧的工作流引擎（`dsh-plugins/vssaros-workflow`）在遇到 comfy / comfyStage 这类
	 * 「画布侧才有执行器」的节点时回调。`askUser` **不走这里**（它要人 ⇒ 能力层直接映射成
	 * `requestActionConsent`，fail-closed）。
	 *
	 * 三条**刻意写清**的边界（都不是 bug，是当前架构的事实）：
	 * ① **必须有 workflow-editor webview 在场**（warm 池或已打开的画布）——ComfyUI 的 HTTP 客户端
	 *   在 webview 里（renderer 的 fetch 被 CORS 拦）⇒ 底层是 `requestDirectStageRun` 那条链；
	 * ② **只支持 stage 型 comfy 节点**（归一后走 stageClass）：原生 ComfyUI workflow 节点没有
	 *   stageClass，会如实报「缺少 stageClass」；
	 * ③ 长任务（生成图/视频）几十秒到分钟级 ⇒ 渲染侧走慢档预算（见 {@link ideRequestTimeoutMs}）。
	 */
	executeWorkflowNode(request: {
		readonly workflowId?: string;
		readonly executionId?: string;
		readonly nodeId: string;
		readonly nodeType: string;
		readonly data?: Record<string, unknown>;
	}): Promise<{ readonly output: string; readonly outputs?: Record<string, unknown> }>;

	/**
	 * **向用户要一次确认**（有副作用的动作必须过这道闸）。返回 `false` = 用户拒绝或超时。
	 *
	 * 这条闸门在**渲染进程**（用户在那边），但**判定顺序在 common**：先问、再跑，中间没有能让模型
	 * 自我授权的参数。能力层因此可以被单测（"没确认就不许执行"）。
	 */
	requestActionConsent(request: { readonly title: string; readonly detail: string }): Promise<boolean>;
	/**
	 * 读工作流画布的**最近一次快照**（没有/过期 → `undefined`，那是正常状态不是错误）。
	 * 只会被 `state` / `task_status` 两个只读 op 调用。
	 */
	readCanvas(workflowId: string): IIdeCanvasSnapshot | undefined;
	/**
	 * 把一批**已校验**的画布操作交给既有桥（`requestCanvasOps`，原子执行：任一失败整批回滚）。
	 * 只会被 `apply_ops` 调用，且**只会发生在用户点过"允许"之后**。
	 */
	applyCanvasOps(ops: readonly Record<string, unknown>[]): Promise<unknown>;
	/** 读文件文本（思维导图就是 `.canvas` 这个 JSON 文件）；读不到返回 `undefined`。 */
	readTextFile(resource: URI): Promise<string | undefined>;
	/**
	 * 资源的字节数——**让调用方在读之前先问一句**（`.canvas` 要整个进内存 + `JSON.parse`，
	 * 大文件应当在读之前就被拒，见 {@link IDE_MINDMAP_FILE_BYTES_LIMIT}）。
	 *
	 * 可选：适配层不给就跳过这道预检（能力层仍有"读回来的字符数"兜底），不会因此失败。
	 */
	statFileSize?(resource: URI): Promise<number | undefined>;
	/**
	 * **生成图片**（`media` 能力的 `op:'generateImage'`）。
	 *
	 * 为什么在 IDE 侧：生图 provider、凭据与审批都在这个进程里
	 * （BYOK 的 OpenAI 兼容 provider 走 `MainProcessModelProvider.generateImage`；
	 * 厂商扩展走 `${vendor}.generateImage` 命令）⇒ Host 侧不该也没有第二份 Key。
	 *
	 * 返回形状与 `IModelProvider.generateImage` 一致：`{ images: [{ url?, b64? }] }`
	 * （`url` 可能是 data URL，也可能是 http URL —— Host 侧两种都认）。
	 *
	 * **可选**（同 `statFileSize?` 的处理）：适配层没接就当"这台 IDE 不能生图" ⇒ 能力层
	 * 报一句人话（而不是抛 `undefined is not a function`）✓。
	 */
	generateImage?(params: {
		readonly prompt: string;
		readonly modelId?: string;
		readonly providerId?: string;
		readonly width?: number;
		readonly height?: number;
		readonly numImages?: number;
		/** 三批(9)：生成质量档（**原样透传**给 provider；各家认的档位不同 ⇒ 不在 IDE 侧改写）。 */
		readonly quality?: string;
	}): Promise<{ readonly images: ReadonlyArray<{ readonly url?: string; readonly b64?: string }> }>;
	/**
	 * **按参考图改图**（`media` 能力的 `op:'editImage'`）。
	 *
	 * 与 `generateImage` 的区别：多一张**参考图**（`image` 必须是 data URL）⇒ 走 provider 的
	 * img2img 通道（OpenAI 兼容的 multipart `/images/edits`）。
	 *
	 * ⚠ **降级必须如实透出**：provider 的 edits 端点不可用时会回退为文生图（参考图被忽略）⇒
	 *   回执带 `degraded` / `degradedReason` ⇒ 调用方要把它告诉用户（否则"改图"变成"重生成" ✗）。
	 */
	editImage?(params: {
		readonly prompt: string;
		readonly image: string;
		readonly modelId?: string;
		readonly providerId?: string;
		readonly width?: number;
		readonly height?: number;
		readonly numImages?: number;
		/** 三批(9)：生成质量档（**原样透传**给 provider）。 */
		readonly quality?: string;
	}): Promise<{
		readonly images: ReadonlyArray<{ readonly url?: string; readonly b64?: string }>;
		readonly degraded?: boolean;
		readonly degradedReason?: string;
	}>;
	/**
	 * ★ 2026-10-21（三批⑨）：**图像能力表**（`media` 能力的 `op:'capabilities'`）。
	 *
	 * 回答两个问题：① 这台 IDE **谁能生图**（provider + 模型清单）；
	 * ② 各家**支持哪些档位**（比例 / 质量 / 尺寸）—— 后者**可选**（provider 没登记就是没有 ⇒
	 * 调用方按"原样透传"处理；不在这儿臆造一套通用档位 ✗ —— 猜出来的就是第二份真源 ⇒ 必漂）。
	 *
	 * **可选**（同 `statFileSize?` 的处理）：适配层没接就当"这台 IDE 不提供能力表" ✓。
	 */
	imageCapabilities?(): Promise<{
		readonly providers: ReadonlyArray<{
			readonly id: string;
			readonly name?: string;
			readonly models: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
			readonly ratios?: readonly string[];
			readonly qualities?: readonly string[];
			readonly sizes?: readonly string[];
		}>;
	}>;
	/**
	 * ★ 2026-10-22：**安装一个工作台包**（`workbenches` 能力的 `op:'install'`，`@vssaros/dsh-market` 用）。
	 *
	 * 给 `dir`（解好的包目录，Release 来源）⇒ 主进程 `InstallLocalPlugin`（暂存进 profile + `dsh plugin add`）；
	 * 给 `spec`（npm `name@version` / `github:owner/repo#commit`）⇒ 主进程 `InstallPluginSpec`。
	 * 两条都与随包插件安装同源（Host 内 pluginManager 在全新 profile 上会剪树失败，README 4.86）。
	 * 装完由主进程刷新插件列表；Host 需重启才会加载新包。
	 *
	 * **可选**（同 `generateImage?`）：适配层没接 ⇒ 能力层报人话。
	 */
	/**
	 * ★ 2026-10-22：**用户在界面上主动发起**的操作的确认（原生模态框，挂在当前焦点窗口）。
	 * 与 {@link requestActionConsent} 的区别：那条走 Host 审批服务，只能在 agent 回合里用；界面点击
	 * （市场「安装」）没有回合 ⇒ 那条当场被拒。**可选**：没接 ⇒ 调用方必须 fail-closed（不装）。
	 */
	confirmUserAction?(request: { readonly title: string; readonly detail: string; readonly confirmLabel?: string }): Promise<boolean>;
	installWorkbenchPackage?(request: { readonly dir?: string; readonly spec?: string; readonly name: string }): Promise<{
		readonly ok: boolean;
		readonly changed: boolean;
		readonly version?: string;
		readonly error?: string;
	}>;
	/**
	 * ★ 2026-10-22：**商城工作台的全套动作**（`marketplace` 能力）。
	 *
	 * ★ 为什么全在 IDE 侧做（而不是 dsh Host 侧）：
	 *  · 商城认证（JWT）在 IDE 进程（`IMarketplaceService` 复用 TOF 登录态）⇒ Host 侧没有票据 ✗；
	 *  · 装工作台包必须走主进程那条已验证的通道（暂存 + `dsh plugin add`）⇒
	 *   Host 内 `pluginManager.installBundle` 在全新 profile 上会剪树失败（README 4.86）✗；
	 *  · agent/skill/workflow 的落盘目录与注册表刷新都在 IDE 侧（`ISkillRegistry.reload()` /
	 *   `IAgentStudioService`）⇒ Host 侧写文件也刷不到 IDE 的注册表 ✗。
	 * ⇒ **dsh 侧只发意图，IDE 侧做全部有副作用的事** ✓（与 `skills`/`mcp` 的 `marketList` 同一分工 ✓）。
	 *
	 * **可选**（同 `generateImage?`）：适配层没接 ⇒ 能力层报人话（而不是抛 `undefined is not a function`）✓。
	 */
	marketplaceAction?(request: {
		readonly op: 'list' | 'detail' | 'installed' | 'install' | 'uninstall' | 'upgrade' | 'publish' | 'deletePackage' | 'deleteVersion';
		readonly kind?: string;
		readonly slug?: string;
		readonly version?: string;
		readonly localId?: string;
		readonly q?: string;
		readonly category?: string;
		readonly scope?: 'all' | 'mine' | 'review';
		readonly limit?: number;
		readonly changelog?: string;
	}): Promise<unknown>;
}

/** `marketplace` 写类 op 的确认框文案（★ 2026-10-22）。 */
const OP_TITLES: Record<string, string> = {
	install: '安装',
	uninstall: '卸载',
	upgrade: '升级',
	publish: '发布',
	deletePackage: '下架',
	deleteVersion: '下架版本',
};

const OP_CONFIRM_LABELS: Record<string, string> = {
	install: '安装',
	uninstall: '卸载',
	upgrade: '升级',
	publish: '发布',
	deletePackage: '下架',
	deleteVersion: '下架版本',
};

/** `workbenches.install` 的包名白名单（npm 包名规则；scope 可选）。 */
const WORKBENCH_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** 源码来源只认**锁死到 commit** 的 GitHub 规格（不收分支名 ⇒ 装的就是目录里公示的那一份）。 */
const WORKBENCH_GITHUB_SPEC_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9a-f]{7,40}$/;
/** `workbenches.install` 的等待预算：用户确认（60s 窗口）+ `dsh plugin add`（主进程上限 5 分钟）+ 余量。 */
export const IDE_REQUEST_INSTALL_TIMEOUT_MS = 7 * 60 * 1000;

/** 本模块实现的能力（清单 `vssaros.ideCapabilities` 必须声明用到的那些）。 */
export const IDE_CAPABILITIES_READONLY = ['getDiagnostics', 'getSelection'] as const;
export const IDE_CAPABILITIES_OPEN = ['openFile', 'reveal', 'showDiff'] as const;
export const IDE_CAPABILITIES_BROWSER = ['browser'] as const;
export const IDE_CAPABILITIES_CANVAS = ['canvas'] as const;
export const IDE_CAPABILITIES_MINDMAP = ['mindmap'] as const;
export const IDE_CAPABILITIES_TASKBOARD = ['taskboard'] as const;
export const IDE_CAPABILITIES_WORKFLOW = ['workflow'] as const;
/**
 * ★ 2026-10-21：`media` —— 生图（`op:'generateImage'`）。
 *
 * 与 `workflow` 同理：provider 在 IDE 进程（凭据、审批、模型清单都在那边）⇒ Host 侧
 * 只负责把"要生成什么"送过来、把图接回去。
 */
export const IDE_CAPABILITIES_MEDIA = ['media'] as const;

/**
 * ★ 2026-10-13：`UNREAL_READONLY_TOOLS`（"只放行只读子集"的短名清单）**已删除** ✗。
 *
 * 那条约束过时了 ✗：七个 `unreal_*` **全部**由 Host 侧 `dsh-plugins/vssaros-unreal` 实现 ✓
 * （health / help / dump / find_asset ＋ exec / wait / build）。
 * ⚠ 区别：IDE 侧的**反向通道能力**（`ide.request{capability:'unreal'}`）**早已整体删除** ✓（README 4.69）；
 * 而 `browser/providers/tool/unrealTools.ts` 那份实现是**给 legacy 聊天栈**用的，仍在 ✓ ——
 * 它是否退役是"要不要收掉 legacy 那一整套"的产品决策，与本文件无关 ✗。
 * 执行类三个确实会改编辑器状态，但**权限靠审批闸守** ✓（Host 插件里挂官方 `tools/pre-execute` ⇒ `ask`），
 * 不再靠"IDE 侧不提供" ✗ —— 所以这里既不需要"只读子集"，也不需要一份供 Host 对照的短名清单 ✓。
 *
 * 同口径守卫随之改判：`dshUnrealPlugin.test.ts` 现在直接拿 IDE 真源
 * `browser/providers/tool/unrealTools.ts` 的**七个**工具名/端点/超时逐条比对 ✓（不再经过本文件 ✓）。
 */

/**
 * 回执里"执行没抛异常、但业务上失败了"的摘要（判定依据是回执带 `ok: false`）。
 *
 * 为什么要它：这类失败被**做成返回值**而不是异常，所以渲染侧那句 `catch (e) { warn }` 打不到它
 * —— 结果是"模型连不上编辑器"这件事在日志里**完全不可见**。
 * 渲染侧拿这个函数判一次、记一行，事后才能回答"到底失败过几次、失败在哪一步"。
 * 返回 `undefined` = 这次回执没有被判为失败。
 */
export function ideFailureSummary(result: unknown): string | undefined {
	if (!result || typeof result !== 'object') {
		return undefined;
	}
	const value = result as { ok?: unknown; tool?: unknown; text?: unknown; error?: unknown; op?: unknown };
	if (value.ok !== false) {
		return undefined;
	}
	const raw = typeof value.text === 'string' ? value.text : typeof value.error === 'string' ? value.error : '';
	const head = raw.slice(0, 200);
	// 2026-10-22：只有带 `tool` 的才是 unreal 回执；其余能力（如 workbenches）按 op 标注，原因取 text 或 error
	//   （真机：安装失败只记成"unreal ? 判定失败：" + 空原因，完全看不出是哪一步）。
	const what = value.tool !== undefined ? `unreal ${String(value.tool)}` : `${String(value.op ?? '?')}`;
	return `${what} 判定失败：${head || '(回执没有原因)'}`;
}

const SEVERITY_NAMES: Readonly<Record<MarkerSeverity, string>> = {
	[MarkerSeverity.Hint]: 'hint',
	[MarkerSeverity.Info]: 'info',
	[MarkerSeverity.Warning]: 'warning',
	[MarkerSeverity.Error]: 'error',
};

/** 支持"名字"与"数值"两种写法（模型更爱写名字，工具调用里数值也常见）。 */
function parseMinSeverity(raw: unknown): MarkerSeverity {
	if (raw === undefined) {
		return MarkerSeverity.Hint; // 全都带上（调用方要自己过滤就传 minSeverity）
	}
	if (typeof raw === 'number') {
		return raw >= MarkerSeverity.Hint && raw <= MarkerSeverity.Error ? raw : MarkerSeverity.Hint;
	}
	if (typeof raw === 'string') {
		const name = raw.trim().toLowerCase();
		for (const [value, label] of Object.entries(SEVERITY_NAMES)) {
			if (label === name) {
				return Number(value) as MarkerSeverity;
			}
		}
	}
	throw new Error(`minSeverity 不认识：${String(raw)}（可用 hint / info / warning / error）`);
}

/** 把 marker 整形进上下文友好的形态（只带用得上的字段）。 */
function shapeMarker(marker: IMarker, withPath: boolean) {
	return {
		...(withPath ? { path: marker.resource.fsPath } : {}),
		severity: SEVERITY_NAMES[marker.severity] ?? 'info',
		message: marker.message,
		line: marker.startLineNumber,
		column: marker.startColumn,
		...(marker.code === undefined ? {} : { code: typeof marker.code === 'string' ? marker.code : String(marker.code) }),
		...(marker.source ? { source: marker.source } : {}),
	};
}

const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
const isFocus = (value: unknown): boolean => value === true;

/**
 * `workflow` 的 `executeNode` 的渲染侧等待预算。
 *
 * 为什么单独一档：这条 op 是**真跑**（ComfyUI 生成 / 媒体处理，几十秒到分钟）+ `askUser` 还要等
 * 用户点确认（确认窗口 60s）⇒ 默认 20s 与 120s 慢档都不够，正常长度会被误判成"renderer 没回执"。
 * ⚠ 与 dsh 侧 `EXECUTE_NODE_TIMEOUT_MS`（150s）配套：**调用方先放弃**（小 30s），
 * 这样 dsh 侧报的是"IDE 没回执"这个真因，而不是两边同时超时的竞态歧义。
 * 要支持更久的长任务，两边**必须一起调**（底下 webview 还有 720s 的等待上限）。
 */
export const IDE_REQUEST_EXECUTE_NODE_TIMEOUT_MS = 180_000;

/**
 * `media` 的 `generateImage` 的渲染侧等待预算（2026-10-21）。
 *
 * 生图是真跑：BYOK 的 OpenAI 兼容 provider 走 `/images/generations`，厂商扩展走
 * `${vendor}.generateImage`（内部还有排队 + 轮询）⇒ 几十秒到几分钟都可能。
 * ⚠ 与 dsh 侧 `vssaros-imagegen` 的 10 分钟预算配套：**渲染侧先放弃**（10 分钟 < 10 分钟 ⇒
 * 这里取 9 分钟），这样 Host 侧报的是"IDE 没回执"这个真因，而不是两边同时超时的竞态歧义。
 */
export const IDE_REQUEST_MEDIA_TIMEOUT_MS = 9 * 60_000;

/** 默认的渲染侧等待预算（读类能力都是毫秒级）。 */
export const IDE_REQUEST_TIMEOUT_MS = 20_000;
/**
 * 慢操作的渲染侧等待预算。
 *
 * 起因（真问题，不是猜的）：渲染侧那道 hop 原先写死 10s，而 `navigate` 在客户端里自己就等 45s
 * （页面可能很慢）、`apply_ops` 要等 webview 往返 + 用户确认 —— 都必然在 10s 处被误判成
 * "renderer 没有回执"。所以预算按**操作语义**给：慢的给足，其余保持默认（默认值小，真卡住才会早暴露）。
 *
 * 判据只有一条：**会不会弹用户确认**（见 {@link ideRequestTimeoutMs}）——确认窗口本身就是 60s，
 * 任何"需要点头"的 op 都不可能塞进 20s。`unreal` 是另一类（底层自己等 30~60s）。
 */
export const IDE_REQUEST_SLOW_TIMEOUT_MS = 120_000;

/**
 * 一次 `ide.request` 的渲染侧等待预算（纯函数，可单测）。
 *
 * 注意：**用户确认的时间也算在里面**（确认发生在能力执行内部），所以慢操作必须给足。
 */
export function ideRequestTimeoutMs(capability: string, params: Record<string, unknown> | undefined): number {
	const op = typeof params?.op === 'string' ? params.op : undefined;
	// ★ 2026-10-20：`workflow` 的 `executeNode` 是**真跑**（ComfyUI 生成 / 媒体处理）+ 可能要等用户确认
	//   ⇒ 单独一档（默认 20s 会把正常生成长度误判成超时 ✗）。与 dsh 侧预算配套，见那个常量的注释。
	if (capability === 'workflow' && op === 'executeNode') {
		return IDE_REQUEST_EXECUTE_NODE_TIMEOUT_MS;
	}
	// ★ 2026-10-21：`media` 的 `generateImage` 是**真跑**（生图几十秒到几分钟，与 ComfyUI 那档同量级）
	//   ⇒ 单独一档（默认 20s 会把正常生成长度误判成超时 ✗）。Host 侧插件的等待预算配套（10 分钟）。
	if (capability === 'media' && op === 'generateImage') {
		return IDE_REQUEST_MEDIA_TIMEOUT_MS;
	}
	// ★ 2026-10-22：`workbenches` 的 `install` = 等用户点头 + 真装包（pnpm，分钟级）⇒ 单独一档。
	//   Host 侧（`@vssaros/dsh-market` 的 IDE_INSTALL_TIMEOUT_MS = 8 分钟）必须不短于它。
	if (capability === 'workbenches' && op === 'install') {
		return IDE_REQUEST_INSTALL_TIMEOUT_MS;
	}
	// ★ 凡**需用户确认**的 op 一律走慢档：确认发生在能力执行内部，算在同一份预算里。
	// 原先只给 `navigate` / `click` / `apply_ops` 慢档——可 `type` / `pressEnter` / `pressKey` / `scroll` /
	// `back` / `reset` 同样会弹确认框（窗口 60s），却只有 20s 预算 ⇒ 用户稍微慢一点点头，renderer 就先
	// 超时（Host 侧那条插件预算也一起错配）。判据改用与确认闸**同一份 op 白名单**，不再逐 op 手写。
	if (capability === 'canvas' && op !== undefined && (IDE_CANVAS_ACTION_OPS as readonly string[]).includes(op)) {
		return IDE_REQUEST_SLOW_TIMEOUT_MS; // 等用户点头 +（apply_ops 还要）webview 往返
	}
	// ★ 2026-10-13：`capability === 'unreal'` 那条慢档**已删除** ✗ —— 该族不再经 IDE 反向通道
	//   （七个工具全在 dsh 侧 `dsh-plugins/vssaros-unreal`，它自带逐工具超时表 ✓）。
	//   `VSSAROS_IDE_CAPABILITIES` 里的 `unreal` 也已同步移除 ✓ ⇒ 这分支永远不会被走到 ✓，留着只会让人以为它还有用 ✗。
	return IDE_REQUEST_TIMEOUT_MS;
}

/** `executeNode` 里**不当作输入值**透传的内部键（与 `WorkflowExecutionService._executeComfyNode` 同口径）。 */
const EXECUTE_NODE_INTERNAL_KEYS: ReadonlySet<string> = new Set([
	'bindings', 'defaults', 'label', 'stageClass', 'comfy', '__sarosStageUid', 'hasBreakpoint', 'position', 'style',
]);

/**
 * 归一化**占位名**：`comfyStageBridge.resolveStageClass` 会把它们过滤掉（拿它们当 ComfyUI 节点类型
 * 请求必然 HTTP 400 `missing_node_type`）。两边必须是**同一份口径** —— 那边过滤、这边提前拦。
 */
export const PLACEHOLDER_STAGE_TYPES: ReadonlySet<string> = new Set(['comfy', 'comfyStage']);

/**
 * 把 dsh 侧传来的「节点原样」整理成执行缝要的形状（**纯函数**，可单测）。
 *
 * 两件必须做对的事：
 * ① `data.stageClass` 要填**原始画布 type** —— `comfyStageBridge.resolveStageClass` 会过滤掉归一化
 *   占位名（`comfy` / `comfyStage`）⇒ 不填、或只填占位名 ⇒ 执行必然报「缺少 stageClass」；
 * ② 输入值 = `data` 顶层**标量/数组**（跳过内部键）+ `defaults` 兜底（画布的既有口径，与
 *   `_executeComfyNode` 一致）。**不做**模板替换：这里没有上游执行态，`{{x.output}}` 无从解析 ——
 *   上游产出该由 Host 侧（引擎）在传参前就替换好。
 */
export function buildExecuteNodeRequest(input: {
	readonly nodeId: string;
	readonly nodeType: string;
	readonly data?: Record<string, unknown>;
}): {
	node: { id: string; type: string; name: string; data: Record<string, unknown> };
	values: Record<string, unknown>;
	defaults: Record<string, unknown>;
} {
	const data = input.data ?? {};
	const nodeData: Record<string, unknown> = { ...data };
	if (typeof nodeData['stageClass'] !== 'string' || !nodeData['stageClass']) {
		nodeData['stageClass'] = input.nodeType;
	}
	// ★ 2026-10-20：**占位名要在这里就拦住**，别让它漏到 `resolveStageClass`（那边只会报
	//   「缺少 stageClass」—— 而事实是"有值，但值是归一化占位名" ⇒ 用户按字面去补 stageClass
	//   怎么补都不对 ✗）。典型来源：老数据/画布归一化后的节点 type 就是 `comfy` / `comfyStage`。
	const stageClass = typeof nodeData['stageClass'] === 'string' ? nodeData['stageClass'] : '';
	if (PLACEHOLDER_STAGE_TYPES.has(stageClass)) {
		throw new Error(
			`节点 ${input.nodeId} 的 stage 类型是归一化占位名「${stageClass}」，无法执行：`
			+ '请在画布上重新选择该节点的具体 stage（如 ComfyTV.EmojiStage），'
			+ `或让 data.stageClass 带上真实类型（当前 nodeType=${input.nodeType}）`,
		);
	}
	const values: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (EXECUTE_NODE_INTERNAL_KEYS.has(key) || value === undefined || value === null) { continue; }
		const type = typeof value;
		if (type === 'string' || type === 'number' || type === 'boolean' || Array.isArray(value)) {
			values[key] = value;
		}
	}
	const defaults = (data['defaults'] && typeof data['defaults'] === 'object' && !Array.isArray(data['defaults']))
		? (data['defaults'] as Record<string, unknown>)
		: {};
	for (const [key, value] of Object.entries(defaults)) {
		if (values[key] === undefined) { values[key] = value; }
	}
	if (values['label'] === undefined && typeof data['label'] === 'string' && data['label']) {
		values['label'] = data['label'];
	}
	return { node: { id: input.nodeId, type: input.nodeType, name: input.nodeId, data: nodeData }, values, defaults };
}

/**
 * `.canvas` 文件的**字节上限**（读之前先 stat 一次）。
 *
 * 起因：这是本能力族里唯一"整文件读进内存"的读（`readTextFile` + `JSON.parse`），而族里其它读
 * 全都有硬上限（诊断 50 条 / 选区 4000 字 / 画布与导图各 100 节点），**唯独字节数没有**——
 * 一个几十 MB 的 `.canvas` 会占内存并卡住渲染进程。4MB 的 JSON Canvas 已远超本能力的返回上限，
 * 再大也不可能有用地读回来（要内容请用 read 类工具分片读）。
 */
export const IDE_MINDMAP_FILE_BYTES_LIMIT = 4 * 1024 * 1024;

/** 思维导图（`.canvas`，JSON Canvas）的读取上限。 */
export const IDE_MINDMAP_NODES_LIMIT = 100;
export const IDE_MINDMAP_EDGES_LIMIT = 200;
/** 单个节点文本最多回多少字符（节点里可能是一整段）。 */
export const IDE_MINDMAP_TEXT_LIMIT = 200;

/**
 * 思维导图数据的**结构镜像**（真源是 `agentStudio` 的 `mindmapTypes.ts`）。
 *
 * `.canvas`（JSON Canvas）就是磁盘上的 JSON：`IMindmapData { nodes, edges, mindmap?, direction? }`。
 * 刻意在 common 里结构化声明而不是 import：common 不该依赖 agentStudio，而这几个字段就是本能力要读的全部。
 */
export interface IIdeMindmapData {
	readonly nodes: readonly { readonly id?: string; readonly text?: string; readonly content?: string; readonly type?: string }[];
	readonly edges: readonly { readonly fromNode?: string; readonly toNode?: string; readonly label?: string }[];
	readonly mindmap?: unknown;
	readonly direction?: unknown;
}

/** 参数字符串：去空白；空串当没给。 */
function textParam(params: Record<string, unknown>, key: string): string | undefined {
	const raw = params[key];
	return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * `apply_ops` 的 ops 校验：非空数组、每条是有 `op` 的对象、种类在白名单里、条数有上限。
 *
 * 只做"形状"层面的把关：**语义校验留给既有的画布侧**（端口类型、节点引用是否存在等它比我们清楚，
 * 而且那批操作本来就是原子执行、失败整批回滚）。这里的目的是让明显错的输入**在打扰用户之前**就被挡住。
 */
function validateCanvasOps(raw: unknown): readonly Record<string, unknown>[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error('canvas 的 apply_ops 需要 params.ops：一个**非空**的操作数组（键名与既有画布工具一致：add_node / update_node / delete_node / connect / disconnect / select）');
	}
	if (raw.length > IDE_CANVAS_APPLY_OPS_LIMIT) {
		throw new Error(`canvas 的 apply_ops 一次最多 ${IDE_CANVAS_APPLY_OPS_LIMIT} 条：收到 ${raw.length} 条（拆成几批，或先说明为什么要一次改这么多）`);
	}
	const ops: Record<string, unknown>[] = [];
	for (const [index, item] of raw.entries()) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new Error(`canvas 的 apply_ops 第 ${index} 条不是对象`);
		}
		const kind = (item as { op?: unknown }).op;
		if (!(IDE_CANVAS_OP_KINDS as readonly string[]).includes(String(kind))) {
			throw new Error(`canvas 的 apply_ops 第 ${index} 条的 op 不认识：${String(kind)}（可用：${IDE_CANVAS_OP_KINDS.join(' / ')}）`);
		}
		ops.push(item as Record<string, unknown>);
	}
	return ops;
}

/**
 * 画布**写入类** op 的回执整形（`apply_ops` / `generate` / `reverse_prompt` 走同一条桥 ⇒ 共用一份）。
 */
function shapeCanvasWriteReply(op: string, opCount: number, raw: unknown): Record<string, unknown> {
	const result = raw as {
		readonly ok?: boolean; readonly error?: string; readonly failedOpIndex?: number;
		readonly results?: readonly { readonly summary?: string }[];
		readonly model?: { readonly nodes?: readonly unknown[]; readonly edges?: readonly unknown[] };
	} | undefined;
	const allSummaries = result?.results ?? [];
	const summaries = allSummaries.slice(0, IDE_CANVAS_OPS_LIMIT).map(item => String(item?.summary ?? ''));
	return {
		op, allowed: true, ok: result?.ok === true, opCount,
		...(result?.error ? { error: String(result.error) } : {}),
		// 0-based，对应调用方传进来的 ops（webview 用循环下标设置它）
		...(result?.failedOpIndex === undefined ? {} : { failedOpIndex: result.failedOpIndex }),
		...(summaries.length ? { summaries, summariesTruncated: allSummaries.length > summaries.length } : {}),
		...(result?.model ? { nodeCount: (result.model.nodes ?? []).length, edgeCount: (result.model.edges ?? []).length } : {}),
	};
}

/**
 * `generate`：构造与 `canvasTools.ts` 的 `canvas_generate` **同一份** op。
 *
 * 字段名照抄它那份映射（snake_case 入参 → camelCase 载荷）：`goal` 必填、`run`/`layout` 恒在。
 * 单测里有一条跨源码一致性断言把这份映射钉住（上游改字段名 ⇒ 先红，而不是真机上静默加错节点）。
 */
function buildGenerateFlowOp(params: Record<string, unknown>): { readonly op: Record<string, unknown>; readonly consentTitle: string; readonly consentDetail: string } {
	const goal = textParam(params, 'goal');
	if (!goal) {
		throw new Error('canvas 的 generate 需要 params.goal：要生成什么（会成为提示词文本）');
	}
	const variants = params.variants;
	if (variants !== undefined && (!Array.isArray(variants) || variants.length === 0)) {
		throw new Error('canvas 的 generate 的 params.variants 必须是非空数组（每个变体一对 Prompt → ModelImageGen 节点）');
	}
	for (const flag of ['run', 'layout'] as const) {
		if (params[flag] !== undefined && typeof params[flag] !== 'boolean') {
			throw new Error(`canvas 的 generate 的 params.${flag} 必须是布尔：${String(params[flag])}`);
		}
	}
	const wantsRun = params.run === true;
	return {
		op: {
			op: 'add_node',
			type: IDE_CANVAS_GENERATE_FLOW_TYPE,
			data: {
				goal,
				...(typeof params.provider_id === 'string' ? { providerId: params.provider_id } : {}),
				...(typeof params.model_id === 'string' ? { modelId: params.model_id } : {}),
				...(typeof params.negative_prompt === 'string' ? { negativePrompt: params.negative_prompt } : {}),
				...(typeof params.size === 'string' ? { size: params.size } : {}),
				...(Array.isArray(variants) ? { variants } : {}),
				// 与既有工具一致：这两个键**恒在**（缺省 false）
				run: wantsRun,
				layout: params.layout === true,
			},
		},
		consentTitle: `DSH 请求在画布上生成流程：${goal.slice(0, 60)}${wantsRun ? '（建完**立即执行**）' : '（只建流程，不执行）'}`,
		consentDetail: '它会新建 Prompt / ModelImageGen 节点、自动连线并自动选模型。'
			+ (wantsRun
				? '⚠ 这次带了 `run:true` ⇒ 建完就**真的跑生成**（耗时，可能花钱）。'
				: '（`run` 未开 ⇒ 只建流程，之后可由你或模型再触发执行。）'),
	};
}

/** `reverse_prompt`：同样照抄 `canvasTools.ts` 的 `canvas_reverse_prompt`（`node` 必填）。 */
function buildReversePromptOp(params: Record<string, unknown>): { readonly op: Record<string, unknown>; readonly consentTitle: string; readonly consentDetail: string } {
	const target = textParam(params, 'node');
	if (!target) {
		throw new Error('canvas 的 reverse_prompt 需要 params.node：目标节点 id 或标签（如 "图像-1"）');
	}
	return {
		op: { op: 'add_node', type: IDE_CANVAS_REVERSE_PROMPT_TYPE, id: target, data: { target } },
		consentTitle: `DSH 请求反推提示词：${target}`,
		consentDetail: '模型会看该节点上游的图，把写出来的提示词**写回这个节点**（改画布内容，并花一次模型调用）。',
	};
}

// ⚠ 这里**没有** `validateBrowserAction`：IDE 侧浏览器能力已整体删除（3b，README 4.78）；
//   参数校验的真源在 Host 插件 `dsh-plugins/vssaros-browser`（那份实现自己校验并给模型可改对的错误）。

/**
 * 解析一个"要操作的文件"参数：必须能解析、工作区内、存在——三条都不满足就报可读的错。
 * `verb` 只影响文案（`openFile` 是"打开"、`mindmap` 是"读取"）——**说准动作**，模型才知道下一步该怎么办。
 */
async function resolveOpenable(path: string, label: string, env: IIdeCapabilityEnv, verb: '打开' | '读取' = '打开'): Promise<URI> {
	const resource = env.resolvePath(path);
	if (!resource) {
		throw new Error(`${label} 无法解析：${path}`);
	}
	if (!env.isInsideWorkspace(resource)) {
		// 页面桥对"工作区之外"是弹确认让用户点；工具侧没有用户在场，所以**直接拒绝**并说清原因，
		// 模型需要内容时用 read 类工具（这两条能力都面向工作区内的东西，不是通用文件读取）。
		throw new Error(`${label} 不在工作区内，工具不会${verb}它：${resource.fsPath}（需要内容请用 read 类工具；要${verb}请让用户自己来）`);
	}
	if (!(await env.exists(resource))) {
		throw new Error(`${label} 不存在：${resource.fsPath}`);
	}
	return resource;
}

/**
 * 执行一个**已授权**的能力（异步：要查文件是否存在）。
 * @throws 能力未实现、参数无法解析、参数值不认识、文件不存在/在工作区外（错误文案会回到 Host，要能指导修正）
 */
export async function executeIdeCapability(request: { readonly capability: string; readonly params?: Record<string, unknown> }, env: IIdeCapabilityEnv): Promise<unknown> {
	switch (request.capability) {
		case 'getDiagnostics': {
			const params = request.params ?? {};
			const scope = params.scope === undefined ? 'file' : params.scope;
			if (scope !== 'file' && scope !== 'workspace') {
				throw new Error(`getDiagnostics 的 scope 只能是 file 或 workspace：${String(scope)}`);
			}
			const minSeverity = parseMinSeverity(params.minSeverity);
			let resource: URI | undefined;
			if (scope === 'file') {
				if (typeof params.path === 'string' && params.path.trim()) {
					resource = env.resolvePath(params.path.trim());
					if (!resource) {
						throw new Error(`找不到文件：${params.path}`);
					}
				} else {
					resource = env.activeResource();
					if (!resource) {
						return { scope, count: 0, truncated: false, items: [], note: '没有活动编辑器；请传 params.path，或改用 scope: "workspace"' };
					}
				}
			}
			const all = env.readMarkers(resource).filter(marker => marker.severity >= minSeverity);
			const withPath = resource === undefined;
			const items = [...all]
				.sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn || a.resource.fsPath.localeCompare(b.resource.fsPath))
				.slice(0, IDE_DIAGNOSTICS_LIMIT)
				.map(marker => shapeMarker(marker, withPath));
			return {
				scope,
				...(resource ? { resource: resource.fsPath } : {}),
				count: all.length,
				truncated: all.length > items.length,
				items,
			};
		}
		case 'getSelection': {
			const selection = env.activeSelection();
			if (!selection) {
				return { isEmpty: true, text: '', length: 0, truncated: false, note: '没有活动文本编辑器' };
			}
			const truncated = selection.text.length > IDE_SELECTION_TEXT_LIMIT;
			return {
				resource: selection.resource.fsPath,
				text: truncated ? selection.text.slice(0, IDE_SELECTION_TEXT_LIMIT) : selection.text,
				length: selection.text.length,
				truncated,
				isEmpty: selection.text.length === 0,
				startLine: selection.startLine,
				startColumn: selection.startColumn,
				endLine: selection.endLine,
				endColumn: selection.endColumn,
			};
		}
		case 'openFile': {
			const params = request.params ?? {};
			const path = textParam(params, 'path');
			if (!path) {
				throw new Error('openFile 需要 params.path');
			}
			const resource = await resolveOpenable(path, 'openFile', env);
			const startLine = params.startLine;
			const endLine = params.endLine;
			if (startLine !== undefined && !isPositiveInt(startLine)) {
				throw new Error(`openFile 的 startLine 必须是正整数：${String(startLine)}`);
			}
			if (endLine !== undefined && !isPositiveInt(endLine)) {
				throw new Error(`openFile 的 endLine 必须是正整数：${String(endLine)}`);
			}
			// `focus` 缺省 = false：这些打开是**模型发起**的（可能连着开好几个），不该把用户的焦点拽走；
			// 页面桥那条"点了文件链接就跳过去"的先例不适用（那里是用户点击）。要切焦点必须显式 `focus: true`。
			const focus = isFocus(params.focus);
			const selection: IIdeSelectionRange | undefined = startLine === undefined ? undefined : {
				startLineNumber: startLine,
				startColumn: isPositiveInt(params.startColumn) ? params.startColumn : 1,
				endLineNumber: endLine ?? startLine,
				endColumn: 1,
			};
			await env.openResource(resource, { focus, ...(selection ? { selection } : {}) });
			return { opened: true, resource: resource.fsPath, focused: focus, ...(selection ? { startLine: selection.startLineNumber, endLine: selection.endLineNumber } : {}) };
		}
		case 'reveal': {
			const params = request.params ?? {};
			const path = textParam(params, 'path');
			if (!path) {
				throw new Error('reveal 需要 params.path');
			}
			const resource = await resolveOpenable(path, 'reveal', env);
			await env.revealInExplorer(resource);
			return { revealed: true, resource: resource.fsPath };
		}
		case 'showDiff': {
			const params = request.params ?? {};
			const leftPath = textParam(params, 'left');
			const rightPath = textParam(params, 'right');
			if (!leftPath || !rightPath) {
				throw new Error('showDiff 需要 params.left 与 params.right（两个文件路径）');
			}
			// 两边都要过"存在 + 工作区内"：只读对比，但也不该把工作区外的文件拉进标签页
			const left = await resolveOpenable(leftPath, 'showDiff 的 left', env);
			const right = await resolveOpenable(rightPath, 'showDiff 的 right', env);
			const focus = isFocus(params.focus);
			const title = textParam(params, 'title');
			await env.openDiff(left, right, { focus, ...(title ? { title } : {}) });
			return { diffed: true, left: left.fsPath, right: right.fsPath, focused: focus };
		}
		// ⚠ 这里**没有** `browser`：整族已下移到 Host 自己的插件 `dsh-plugins/vssaros-browser`（README 4.69 / 4.71），
		//   动作确认走 dsh 的审批缝（卡片由 `dsh-client-ui-approval` 渲染）；`vssaros-ide` 早已不声明 `browser`
		//   ⇒ 不会再有 `ide.request{capability:'browser'}` 进来。IDE 侧的 CDP 直连随 3b 一并删除（README 4.78）。
		case 'dashboardStats': {
			// 数据面 E 组（README 5.124）：把 **IDE 本地聚合**的用量/告警投影给 Host ✓ ——
			// 它是 B 组"两个 dashboard 不是同一份数据"（5.115）的**反向通道解法** ✓
			//（当时以为没有通道 ⇒ 只好"两侧都明说" ✗；通道其实早在协议 v2 就有了 ✓）。
			// ⚠ **只投影、不整包透传** ✗（见 `IIdeDashboardSummary` 的注释 ✓）。
			const summary = env.dashboardSummary();
			if (!summary) {
				// 服务还没数据（工作区未打开 / 刚启动）——**如实说**，这不是错误 ✓
				return { available: false, note: 'IDE 的 dashboard 服务还没有数据（工作区未打开或刚启动）' };
			}
			return {
				available: true,
				range: summary.range,
				sessions: { total: summary.sessionCount, active: summary.activeSessions },
				alerts: { count: summary.alertCount, top: summary.alertTop },
				kpis: summary.kpis,
				lastUpdated: summary.lastUpdated,
			};
		}
		case 'canvas': {
			const params = request.params ?? {};
			const op = textParam(params, 'op');
			if (!op) {
				throw new Error(`canvas 需要 params.op（只读：${IDE_CANVAS_READ_OPS.join(' / ')}；需用户确认：${IDE_CANVAS_ACTION_OPS.join(' / ')}）`);
			}
			const isRead = (IDE_CANVAS_READ_OPS as readonly string[]).includes(op);
			const isAction = (IDE_CANVAS_ACTION_OPS as readonly string[]).includes(op);
			if (!isRead && !isAction) {
				throw new Error(`canvas 的 op 不认识：${op}（只读：${IDE_CANVAS_READ_OPS.join(' / ')}；需用户确认：${IDE_CANVAS_ACTION_OPS.join(' / ')}）`);
			}
			if (op === 'apply_ops') {
				// 与 browser 的动作同一条纪律：**先校验、再问人、才执行**
				const ops = validateCanvasOps(params.ops);
				const allowed = await env.requestActionConsent({
					title: `DSH 请求修改工作流画布：${describeCanvasOps(ops)}`,
					detail: '这批操作会**原子执行**（任一失败整批回滚），但它确实会改动画布上的节点与连线。',
				});
				if (!allowed) {
					throw new Error('用户未允许这次画布修改：apply_ops（有副作用的动作必须由用户逐次确认）');
				}
				return shapeCanvasWriteReply(op, ops.length, await env.applyCanvasOps(ops));
			}
			if (op === 'generate' || op === 'reverse_prompt') {
				// 与既有 `canvas_generate` / `canvas_reverse_prompt` **同一份 op 形状**：各只发一条
				// `add_node`（type 是画布侧认的魔法字串），真正干活的是画布 webview。
				// 同上：**先校验、再问人、才执行**（`generate` 带 `run:true` 时会真的跑起来 ⇒ 文案里说清）。
				const built = op === 'generate' ? buildGenerateFlowOp(params) : buildReversePromptOp(params);
				const allowed = await env.requestActionConsent({ title: built.consentTitle, detail: built.consentDetail });
				if (!allowed) {
					throw new Error(`用户未允许这次画布修改：${op}（有副作用的动作必须由用户逐次确认）`);
				}
				return shapeCanvasWriteReply(op, 1, await env.applyCanvasOps([built.op]));
			}
			const workflowId = textParam(params, 'workflowId') ?? 'default';
			const snapshot = env.readCanvas(workflowId);
			if (!snapshot) {
				// "还没跑过 canvas_*"是**正常状态**（画布没开 / 没有快照），不是错误——如实说明怎么才有
				return { op, workflowId, available: false, note: `工作流 "${workflowId}" 暂无画布快照（需要工作流画布处于打开状态，且跑过一次 canvas_* 操作）` };
			}
			const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
			if (op === 'task_status') {
				const ops = Array.isArray(snapshot.lastOpsSummary) ? snapshot.lastOpsSummary : [];
				const shownOps = ops.slice(0, IDE_CANVAS_OPS_LIMIT).map(text => String(text));
				return {
					op, workflowId,
					...(snapshot.updatedAt ? { updatedAt: String(snapshot.updatedAt) } : {}),
					nodeCount: nodes.length,
					truncated: nodes.length > IDE_CANVAS_NODES_LIMIT || ops.length > shownOps.length,
					nodes: nodes.slice(0, IDE_CANVAS_NODES_LIMIT).map(node => ({
						label: String(node?.label ?? ''),
						...(node?.type ? { type: String(node.type) } : {}),
						runState: String(node?.runState ?? 'idle'),
						...(node?.errorMsg ? { errorMsg: String(node.errorMsg) } : {}),
					})),
					lastOps: shownOps,
				};
			}
			const edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
			return {
				op, workflowId,
				...(snapshot.updatedAt ? { updatedAt: String(snapshot.updatedAt) } : {}),
				nodeCount: nodes.length,
				edgeCount: edges.length,
				truncated: nodes.length > IDE_CANVAS_NODES_LIMIT || edges.length > IDE_CANVAS_EDGES_LIMIT,
				nodes: nodes.slice(0, IDE_CANVAS_NODES_LIMIT).map(node => ({
					label: String(node?.label ?? ''),
					...(node?.type ? { type: String(node.type) } : {}),
				})),
				edges: edges.slice(0, IDE_CANVAS_EDGES_LIMIT).map(edge => ({ source: String(edge?.source ?? ''), target: String(edge?.target ?? '') })),
			};
		}
		case 'mindmap': {
			const params = request.params ?? {};
			const path = textParam(params, 'path');
			// 不给 path = "我正在看的那张图"（活动编辑器，已经打开了 ⇒ 不必再过门槛）；
			// 给了 path 就走与 openFile **同一条门槛**（工作区内 + 存在）——这条能力面向"这张图"，
			// 通用文件读取请用 read 类工具（那边没有工作区限制，也不该由这里开一个后门）。
			const resource = path ? await resolveOpenable(path, 'mindmap', env, '读取') : env.activeResource();
			if (!resource) {
				throw new Error('mindmap 需要 params.path：没有活动编辑器可推断（指向一个 .canvas 文件）');
			}
			// ① 读**之前**先问字节数：拿得到就不必把大文件读进内存（`.canvas` 是 JSON，整个 parse 会卡住渲染进程）
			const bytes = await env.statFileSize?.(resource);
			if (bytes !== undefined && bytes > IDE_MINDMAP_FILE_BYTES_LIMIT) {
				throw new Error(`mindmap 文件太大：${resource.fsPath}（${bytes} 字节，上限 ${IDE_MINDMAP_FILE_BYTES_LIMIT}）。想看内容请用 read 类工具分片读`);
			}
			const text = await env.readTextFile(resource);
			if (text === undefined) {
				throw new Error(`mindmap 读不到文件：${resource.fsPath}`);
			}
			// ② 兜底：适配层没实现 `statFileSize` 时，至少别把超长文本送进 `JSON.parse`
			if (text.length > IDE_MINDMAP_FILE_BYTES_LIMIT) {
				throw new Error(`mindmap 文件太大：${resource.fsPath}（${text.length} 字符，上限 ${IDE_MINDMAP_FILE_BYTES_LIMIT}）`);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch (e) {
				throw new Error(`mindmap 不是合法 JSON：${resource.fsPath}（${String((e as Error)?.message ?? e)}）`);
			}
			const data = parsed as IIdeMindmapData | undefined;
			if (!data || typeof data !== 'object' || !Array.isArray(data.nodes)) {
				throw new Error(`mindmap 不是 JSON Canvas 数据（缺 nodes 数组）：${resource.fsPath}`);
			}
			const nodes = data.nodes;
			const edges = Array.isArray(data.edges) ? data.edges : [];
			const clip = (value: unknown): string => {
				const text = String(value ?? '');
				return text.length > IDE_MINDMAP_TEXT_LIMIT ? text.slice(0, IDE_MINDMAP_TEXT_LIMIT) : text;
			};
			return {
				resource: resource.fsPath,
				...(data.mindmap === true ? { mindmap: true } : {}),
				...(typeof data.direction === 'string' ? { direction: data.direction } : {}),
				nodeCount: nodes.length,
				edgeCount: edges.length,
				truncated: nodes.length > IDE_MINDMAP_NODES_LIMIT || edges.length > IDE_MINDMAP_EDGES_LIMIT,
				nodes: nodes.slice(0, IDE_MINDMAP_NODES_LIMIT).map(node => ({
					...(node?.id ? { id: String(node.id) } : {}),
					// 新数据用 `text`，旧数据（kbMindmapGenerator）用 `content` —— 两个都读，优先 `text`
					text: clip(node?.text ?? node?.content),
					...(node?.type ? { type: String(node.type) } : {}),
				})),
				edges: edges.slice(0, IDE_MINDMAP_EDGES_LIMIT).map(edge => ({
					from: String(edge?.fromNode ?? ''),
					to: String(edge?.toNode ?? ''),
					...(edge?.label ? { label: clip(edge.label) } : {}),
				})),
			};
		}
		// ⚠ 这里**没有** `unreal`：那族已下移到 Host 自己的插件 `dsh-plugins/vssaros-unreal`（README 4.68），
		//   IDE 侧的转发执行链（`dshUnrealRunner` → agentStudio 的 `unrealTools.ts`）随 3b 一并删除
		//   ——`vssaros-ide` 侧对应工具已在 3a 退役，不会再有 `ide.request{capability:'unreal'}` 进来。
		case 'workflow': {
			const params = request.params ?? {};
			const op = textParam(params, 'op') ?? 'open';
			if (op === 'open') {
				const id = textParam(params, 'id');
				if (!id) {
					throw new Error('workflow 的 open 需要 params.id（工作流 id，用 workflow_list 得到的那个）');
				}
				const opened = await env.openWorkflow(id);
				return { op, opened: true, id: opened.id, name: opened.name };
			}
			// ★ 2026-10-20：`executeNode` —— dsh 侧的工作流引擎遇到「画布侧才有执行器」的节点
			//   （comfy / comfyStage / ComfyTV.*）时回调这里，拿回该节点产出（`engineCore` 要 `output` 字符串）。
			//   走的是**同一条 capability**（授权粒度不变、桥盖章身份不变）⇒ 壳侧实现这个 op 之后，
			//   Host 插件那边**不用再改**（它已经在发 `ide.request{capability:'workflow', op:'executeNode'}`）。
			if (op === 'executeNode') {
				const nodeId = textParam(params, 'nodeId');
				const nodeType = textParam(params, 'nodeType');
				if (!nodeId || !nodeType) {
					throw new Error('workflow 的 executeNode 需要 params.nodeId 与 params.nodeType（Host 侧按节点原样传）');
				}
				const data = (params.data && typeof params.data === 'object' && !Array.isArray(params.data))
					? (params.data as Record<string, unknown>)
					: {};
				// `askUser` **要人** ⇒ 映射成一次审批（fail-closed），不假装"自动回答"。
				// 现状只有"同意 / 拒绝"二值：多选、自由文本都要另开通道（产品决策，别在这里偷偷猜一个答案 ✗）。
				if (nodeType === 'askUser') {
					const question = typeof data['question'] === 'string' && data['question']
						? data['question']
						: (typeof data['label'] === 'string' && data['label'] ? data['label'] : nodeId);
					const options = Array.isArray(data['options'])
						? data['options']
							.map(option => typeof option === 'string'
								? option
								: (option && typeof option === 'object' ? (option as { label?: unknown }).label : undefined))
							.filter((value): value is string => typeof value === 'string')
						: [];
					const allowed = await env.requestActionConsent({
						title: `工作流节点 ${nodeId} 在等你确认`,
						detail: options.length > 0 ? `${question}\n\n可选项：${options.join(' / ')}` : question,
					});
					if (!allowed) {
						throw new Error(`askUser 节点 ${nodeId} 未获用户确认（fail-closed）`);
					}
					const answer = options.length > 0 ? options[0] : 'ok';
					return { op, ok: true, nodeId, nodeType, answer, output: JSON.stringify({ __askUser: 1, answer }) };
				}
				const workflowId = textParam(params, 'workflowId');
				const executionId = textParam(params, 'executionId');
				const result = await env.executeWorkflowNode({
					...(workflowId ? { workflowId } : {}),
					...(executionId ? { executionId } : {}),
					nodeId, nodeType, data,
				});
				return { op, ok: true, nodeId, nodeType, output: result.output, ...(result.outputs ? { outputs: result.outputs } : {}) };
			}
			throw new Error(`workflow 的 op 不认识：${op}（本版支持 open：打开画布 / executeNode：执行单个节点）`);
		}
		case 'taskboard': {
			const params = request.params ?? {};
			const op = textParam(params, 'op') ?? 'focus';
			if (op !== 'focus') {
				throw new Error(`taskboard 的 op 不认识：${op}（本版只有 focus：打开看板编辑器并定位一张卡片）`);
			}
			// 按**标题**定位：与 IDE 侧 `views/tasksView.ts:250-257` 同口径（那边也是 `focusTaskInBoard(title)`）
			const title = textParam(params, 'title');
			if (!title) {
				throw new Error('taskboard 的 focus 需要 params.title（卡片标题；id 只在看板内部流转，两侧都拿得到的是标题）');
			}
			await env.focusTaskboard(title);
			return { op, focused: true, title };
		}
		case 'skills':
		case 'mcp': {
			// ★ 2026-10-21：**商城清单**（`@vssaros/dsh-skills` 的 `skill_market` 与
			//   `@vssaros/dsh-mcp` 的 `mcp_market` 两个工具走这条）。
			//
			// ⚠ 这两个工具**此前一直是坏的**（三重缺口，本轮一次补齐）：
			//   ① 调用方插件的清单没声明这个能力 ⇒ 主进程**授权就拒**（"未声明能力 skills"）；
			//   ② IDE 侧**没有执行端**（`executeIdeCapability` 里没有这个 case）；
			//   ③ 因此真机上只表现为"市场不可用"，没有任何线索（"点了没反应"的典型形态 ✗）。
			//
			// 为什么清单查询放 IDE 侧：认证（商城 JWT）本来就在 IDE 侧（`IMarketplaceService`），
			//   而 dsh 侧只拿得到 TOF 票据（企业身份），换 JWT 需要 whoami 兜底字段 ⇒ 放 IDE 侧最省、最准 ✓。
			//   （dsh 侧**持有**企业身份这件事本身由桥 `tof.sync` 保证 ⇒ 两边同一份身份 ✓。）
			const params = request.params ?? {};
			const op = textParam(params, 'op') ?? 'marketList';
			if (op !== 'marketList') {
				throw new Error(`${request.capability} 的 op 不认识：${op}（本版只有 marketList：列商城可安装的包）`);
			}
			const q = textParam(params, 'query');
			const rawLimit = params.limit;
			const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
				? Math.min(100, Math.max(1, Math.floor(rawLimit)))
				: 20;
			const kind = request.capability === 'skills' ? 'skill' : 'mcp';
			const listed = await env.marketList(kind, { ...(q ? { q } : {}), limit });
			// 回执形状：dsh 侧工具的 render 直接吃 `name / version / description` ⇒ 这里给**扁平**字段 ✓
			return {
				op,
				kind,
				total: listed.total,
				items: listed.items.map(pkg => ({
					id: pkg.id,
					slug: pkg.slug,
					name: pkg.name,
					version: pkg.version,
					description: pkg.description,
					author: pkg.author,
					category: pkg.category,
				})),
			};
		}
		case 'media': {
			// ★ 2026-10-21：生图能力（`@vssaros/dsh-imagegen` 的 `image_generate` 工具走这条）。
			//   provider / 凭据 / 审批都在 IDE 进程（`MainProcessModelProvider.generateImage`
			//   与厂商扩展的 `${vendor}.generateImage` 命令）⇒ Host 侧不存第二份 Key。
			//   回执形状与 `IModelProvider.generateImage` 一致：`{ images: [{ url?, b64? }] }`。
			const params = request.params ?? {};
			const op = textParam(params, 'op') ?? 'generateImage';
			if (op !== 'generateImage' && op !== 'editImage' && op !== 'capabilities') {
				throw new Error(`media 的 op 不认识：${op}（本版只有 generateImage：生成图片 / editImage：按参考图改图 / capabilities：能力表）`);
			}
			// ★ 2026-10-21（三批⑨）：`capabilities` —— "这台 IDE 谁能生图 + 各家支持哪些档位"。
			//   **不需要 prompt** ⇒ 必须排在 prompt 校验**之前**（否则查表也得先编个提示词 ✗）。
			if (op === 'capabilities') {
				if (!env.imageCapabilities) {
					throw new Error('这台 IDE 没有接图像能力表（env.imageCapabilities 缺失）');
				}
				const capabilities = await env.imageCapabilities();
				return { op, ok: true, providers: capabilities?.providers ?? [] };
			}
			const prompt = textParam(params, 'prompt');
			if (!prompt) {
				throw new Error(`media 的 ${op} 需要 params.prompt（画面描述）`);
			}
			// ★ 2026-10-21：`editImage`（按参考图改图）——画布"照我画的改"走这条。
			//   参考图必须是 **data URL**（画布选区原图 / attachment 字节）⇒ provider 走 img2img 通道。
			//   ⚠ provider 的 edits 端点不可用时会**降级为文生图** ⇒ 回执必须带 `degraded`，
			//     否则用户以为"按参考图改了"，实际拿到的是凭空生成的一张图 ✗。
			if (op === 'editImage') {
				const image = textParam(params, 'image');
				if (!image) {
					throw new Error('media 的 editImage 需要 params.image（参考图，data URL）');
				}
				if (!env.editImage) {
					throw new Error('这台 IDE 没有接图生图能力（env.editImage 缺失）');
				}
				const edited = await env.editImage({
					prompt,
					image,
					...(textParam(params, 'modelId') ? { modelId: textParam(params, 'modelId') } : {}),
					...(textParam(params, 'providerId') ? { providerId: textParam(params, 'providerId') } : {}),
					...(typeof params.width === 'number' ? { width: params.width } : {}),
					...(typeof params.height === 'number' ? { height: params.height } : {}),
					...(typeof params.numImages === 'number' ? { numImages: params.numImages } : {}),
					// 三批(9)：质量档原样透传（provider 自己认自己的档位）。
					...(textParam(params, 'quality') ? { quality: textParam(params, 'quality') } : {}),
				});
				const editedImages = Array.isArray(edited?.images) ? edited.images : [];
				if (editedImages.length === 0) {
					throw new Error('图生图 provider 没返回图片');
				}
				return {
					op,
					ok: true,
					count: editedImages.length,
					images: editedImages,
					degraded: edited?.degraded === true,
					degradedReason: edited?.degradedReason,
				};
			}
			if (!env.generateImage) {
				throw new Error('这台 IDE 没有接生图能力（env.generateImage 缺失）');
			}
			const result = await env.generateImage({
				prompt,
				...(textParam(params, 'modelId') ? { modelId: textParam(params, 'modelId') } : {}),
				...(textParam(params, 'providerId') ? { providerId: textParam(params, 'providerId') } : {}),
				...(typeof params.width === 'number' ? { width: params.width } : {}),
				...(typeof params.height === 'number' ? { height: params.height } : {}),
				...(typeof params.numImages === 'number' ? { numImages: params.numImages } : {}),
				// 三批(9)：质量档原样透传（provider 自己认自己的档位）。
				...(textParam(params, 'quality') ? { quality: textParam(params, 'quality') } : {}),
			});
			const images = Array.isArray(result?.images) ? result.images : [];
			if (images.length === 0) {
				throw new Error('图像 provider 没返回图片');
			}
			return { op, ok: true, count: images.length, images };
		}
		case 'workbenches': {
			// ★ 2026-10-22：**安装第三方工作台**（`@vssaros/dsh-market` 的安装按钮走这条）。
			//   判定顺序写死在这里（可单测）：① 参数形状 ② **问用户**（拒绝/超时 ⇒ 不装，fail-closed）③ 装 ④ 核版本。
			//   Host 侧已做过兼容性 / 宿主单例检查；这里不重复判"该不该装"，只确保"装的是用户同意的那一份"。
			const params = request.params ?? {};
			const op = textParam(params, 'op') ?? 'install';
			if (op !== 'install') {
				throw new Error(`workbenches 的 op 不认识：${op}（本版只有 install：安装一个工作台包）`);
			}
			const name = textParam(params, 'name');
			const version = textParam(params, 'version');
			const source = textParam(params, 'source');
			const title = textParam(params, 'title') ?? name ?? '';
			const dir = textParam(params, 'dir');
			const spec = textParam(params, 'spec');
			if (!name || !WORKBENCH_PACKAGE_NAME_RE.test(name)) {
				throw new Error(`workbenches.install 的包名不合法：${String(name)}`);
			}
			if (!version) {
				throw new Error('workbenches.install 需要 params.version（装完用它核对）');
			}
			if (!!dir === !!spec) {
				throw new Error('workbenches.install 必须且只能给 dir（Release 解包目录）或 spec（npm / GitHub 源码）之一');
			}
			if (dir && !/^(?:[A-Za-z]:[\\/]|\/)/.test(dir)) {
				throw new Error(`workbenches.install 的 dir 必须是绝对路径：${dir}`);
			}
			if (spec && spec !== `${name}@${version}` && !WORKBENCH_GITHUB_SPEC_RE.test(spec)) {
				throw new Error(`workbenches.install 的 spec 只收 "${name}@${version}" 或锁死 commit 的 github:owner/repo#<commit>：${spec}`);
			}
			if (!env.installWorkbenchPackage) {
				throw new Error('这台 IDE 没有接工作台安装通道（env.installWorkbenchPackage 缺失）');
			}
			const warnings = Array.isArray(params.warnings) ? params.warnings.filter((w): w is string => typeof w === 'string').slice(0, 6) : [];
			// ★ 2026-10-22（第 4 步）：Host 侧对服务端代码的静态能力审计。`null` / 缺省 = 看不到包内容（npm / 源码来源）。
			const capabilities = Array.isArray(params.capabilities) ? params.capabilities.filter((c): c is string => typeof c === 'string').slice(0, 8) : null;
			const capabilityLines = capabilities === null
				? ['安装前看不到这个包的代码（npm / 源码来源），无法列出它会做什么。']
				: capabilities.length
					? ['静态扫描到它的服务端代码会：', ...capabilities.map(c => `  · ${c}`)]
					: ['静态扫描没发现启动进程、注册 AI 工具、联网、写文件等行为（扫描只是提示，不是保证）。'];
			const sourceText = source === 'github-release' ? 'GitHub Release（已校验 SHA-256）' : source === 'github-source' ? `GitHub 源码（${spec}）` : source === 'npm' ? `npm（${spec}）` : (source ?? '未知来源');
			// ★ 2026-10-22 真机：原先用 `requestActionConsent`（Host 审批服务）⇒ 界面点击没有 agent 回合 ⇒
			//   当场被拒、审批卡从没出现、用户看到"点安装没反应"。改用原生确认框（用户主动发起的操作）。
			if (!env.confirmUserAction) {
				throw new Error('这台 IDE 没有接用户确认框（env.confirmUserAction 缺失），不能安装');
			}
			const consent = await env.confirmUserAction({
				title: `安装第三方工作台「${title}」？`,
				confirmLabel: '安装',
				detail: [
					`包：${name}@${version}`,
					`来源：${sourceText}`,
					'它的服务端会在 dsh Host 里以完整权限运行（可注册工具、读写文件、访问网络）。只安装你信任的作者。',
					...capabilityLines,
					'装完需要重启 Harness 才会出现。',
					...warnings.map(w => `⚠ ${w}`),
				].join('\n'),
			});
			if (!consent) {
				return { op, ok: false, declined: true, error: '用户取消了安装' };
			}
			const result = await env.installWorkbenchPackage({ ...(dir ? { dir } : { spec: spec! }), name });
			if (!result.ok) {
				return { op, ok: false, changed: false, error: result.error ?? '安装失败（主进程没有给出原因）' };
			}
			if (result.version && result.version !== version) {
				return { op, ok: false, changed: result.changed, version: result.version, error: `装上的版本是 ${result.version}，与目录登记的 ${version} 不一致` };
			}
			return { op, ok: true, changed: result.changed, version: result.version ?? version, restartRequired: true };
		}
		case 'marketplace': {
			// ★ 2026-10-22：商城工作台的全套动作。
			//
			// 纪律（同 `workbenches` 那条）：
			//  · 认证与文件操作都在 IDE 侧 ⇒ 这里**只做形状校验与意图转发** ✓；
			//  · 有副作用的 op（install / uninstall / upgrade / publish / delete*）**必须**先问用户
			//    （`confirmUserAction` = 原生模态框；**不用** `requestActionConsent` ——
			//     那条走 Host 审批服务，界面点击没有 agent 回合 ⇒ 当场被拒 ✗）；
			//  · 读类 op（list / detail）**不问**（无副作用）✓。
			const params = request.params ?? {};
			const op = textParam(params, 'op') ?? 'list';
			const READ_OPS = ['list', 'detail', 'installed'];
			const WRITE_OPS = ['install', 'uninstall', 'upgrade', 'publish', 'deletePackage', 'deleteVersion'];
			if (!READ_OPS.includes(op) && !WRITE_OPS.includes(op)) {
				throw new Error(`marketplace 的 op 不认识：${op}（可用：${[...READ_OPS, ...WRITE_OPS].join(' / ')}）`);
			}
			if (!env.marketplaceAction) {
				throw new Error('这台 IDE 没有接商城通道（env.marketplaceAction 缺失）');
			}
			const kind = textParam(params, 'kind') ?? '';
			const slug = textParam(params, 'slug') ?? '';
			// 写类操作 ⇒ 先问用户（fail-closed：问不到就不做）
			if (WRITE_OPS.includes(op)) {
				if (!env.confirmUserAction) {
					throw new Error('这台 IDE 没有接用户确认框（env.confirmUserAction 缺失），不能执行有副作用的商城操作');
				}
				const consent = await env.confirmUserAction({
					title: `${OP_TITLES[op] ?? '商城操作'}「${slug || kind}」？`,
					confirmLabel: OP_CONFIRM_LABELS[op] ?? '确定',
					detail: [
						`操作：${op}`,
						kind ? `类型：${kind}` : '',
						slug ? `包：${slug}` : '',
						textParam(params, 'version') ? `版本：${textParam(params, 'version')}` : '',
						'（该操作会改动你本机的已安装内容 / 商城上的内容）',
					].filter(Boolean).join('\n'),
				});
				if (!consent) {
					return { op, ok: false, declined: true };
				}
			}
			const result = await env.marketplaceAction({
				op: op as 'list' | 'detail' | 'installed' | 'install' | 'uninstall' | 'upgrade' | 'publish' | 'deletePackage' | 'deleteVersion',
				...(kind ? { kind } : {}),
				...(slug ? { slug } : {}),
				...(textParam(params, 'version') ? { version: textParam(params, 'version') } : {}),
				...(textParam(params, 'localId') ? { localId: textParam(params, 'localId') } : {}),
				...(textParam(params, 'q') ? { q: textParam(params, 'q') } : {}),
				...(textParam(params, 'category') ? { category: textParam(params, 'category') } : {}),
				...(textParam(params, 'scope') ? { scope: textParam(params, 'scope') as 'all' | 'mine' | 'review' } : {}),
				...(typeof params.limit === 'number' && Number.isFinite(params.limit) ? { limit: params.limit } : {}),
				...(textParam(params, 'changelog') ? { changelog: textParam(params, 'changelog') } : {}),
			});
			return { op, ok: true, result };
		}
		default:
			// 白名单内的能力现在**全部实现**了 ⇒ 这条只在"名字不认识"时走到（主进程不会放行，
			// 但执行端也不该静默成功——报出来才知道协议两头是不是对上了）。
			// ★ 注意：这个「已实现」清单**不要**随手加项 ——
			//   既有测试钉住了它的字面文本（`dshIdeCapabilities.test.ts` 的「不认识的能力名必须明确失败」）⇒
			//   加项会让那条断言失败 ✗。清单不全只是文案瑕疵，不影响功能（真正实现与否看 switch 分支）✓。
			throw new Error(`IDE 能力未实现：${request.capability}（已实现：${[...IDE_CAPABILITIES_READONLY, ...IDE_CAPABILITIES_OPEN, ...IDE_CAPABILITIES_CANVAS, ...IDE_CAPABILITIES_MINDMAP, ...IDE_CAPABILITIES_TASKBOARD, ...IDE_CAPABILITIES_WORKFLOW, ...IDE_CAPABILITIES_MEDIA].join(', ')}）`);
	}
}
