/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 知识库：**命令要的那几个动作**的宿主服务（2026-10-15 README 5.137 / 5.138 的「甲」）。
 *
 * ## 为什么必须抽出来（这是一次真机事故的根因，不是洁癖）
 * `moduleEngine=dsh` 时，容器 `agentStudio.knowledgeBase` 与视图 id `agentStudio.knowledgeBaseView`
 * **都被 dsh 插件页接管**（`dshActivityBarContribution.ts` 的 `MODULE_VIEW_HOSTS`；静态注册那条在
 * `_registerModuleToolIcon()` 里让位 ✗）⇒ 真源 `KnowledgeBaseViewPane` **根本不会被实例化**。
 * 而 `agentStudio.kb.*` 那几条命令当时是"命令 ⇒ 调视图的公开动作"（盲转型取视图）⇒ 拿到的是插件页
 * ⇒ `… is not a function` ⇒ 用户看到的就是**「点了没反应」**（⚙ / 🕸 / 配置文件夹 / 删除知识库 四个入口全中）。
 *
 * ⇒ 把"要状态才能做"的动作**从视图搬到这里**：视图与命令**共用同一份实现** ✓
 *（视图保留薄壳：它自己的按钮 / 右键菜单仍走这里 ⇒ 行为一字不改 ✓；dsh 引擎下没有视图也照样能用 ✓）。
 *
 * ## 分期（README 5.138）
 * · **第 1 期（本文件当前）**：库清单（storage）／知识库根／库目录（`库`·`笔记`）／op-log／
 *   ① 配置文件夹为知识库 ② 删除知识库。
 * · 第 2 期：关系图谱（`_graph` 那半边）。第 3 期：设置面板 host（`IKbSettingsHost` 那 20 个方法）。
 *
 * ## 单一真源（★ 两条不许破）
 * 1. **库清单的真源是 `IStorageService`**（键 `agentStudio.kb.vaults` / `agentStudio.kb.active`，
 *    与 `kbVaultState.ts` 同一对常量 ✓）；视图的 `_vaults` 只是它的**内存副本** ⇒
 *    本服务改完清单必须 `_onDidChangeVaults.fire()` 让视图整体重载 ✓（否则两个入口各说各话 ✗）。
 * 2. **知识库根只有一个算法**（`STORAGE_KB_DIR` 优先，否则 `<userHome>/.vssaros/knowledge-base`）——
 *    与 `kbVaultFs.resolveActiveVaultRoot` 同值；视图的 `rootUri` getter 已改为委托本服务 ✓。
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { localize } from '../../../../../nls.js';
// ★★★ 2026-10-20（第三轮定稿，真机日志：`openPaneComposite → ok` 且 `location: Panel` 已生效，屏上仍无 panel）：
//   **agents 窗口的 panel 是用 DOM inline `display:none` 隐藏的**（`agentLayoutWorkbench.ts:859-860`），
//   `PANEL_HIDDEN` 运行时状态从未置位 ⇒ `isVisible(PANEL_PART)` **恒为 true**
//   ⇒ `openPaneComposite` / `setPartHidden(false)` 都以为"已经可见"而什么也不做 ✗（返回 ok 却看不到）。
//   唯一可靠入口 = 标题栏按钮用的 DOM 事件 `agent-studio:toggle-panel`（`toggleAgentsPanel()`：
//   清 inline display + 恢复 35% 高度 + 打开容器）。**判据只能看 DOM**（display + offsetHeight）。
//   ⇒ 照搬 `dshHarness.contribution.ts:1187-1215` 已在 agents 布局真机验证过的同一套流程，不另起炉灶。
import { mainWindow } from '../../../../../base/browser/window.js';
import { IWorkbenchLayoutService, Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { KB_LIBRARY_SUBPATH, KB_NOTES_SUBPATH, KB_ROOT_SUBPATH } from './kbVaultFs.js';
import { appendKbOpLog, IKbOpLogEntry, KbOpChannel, KbOpStatus } from './kbOpLog.js';
import { resolveKbRoot } from './knowledgeStorage.js';
// ⚠ 键常量：与 `kbVaultState.ts` / `kbVaultFs.ts` **同值**（那两处是既有真源；这里只 import 用 ✓）
import { STORAGE_ACTIVE, STORAGE_KB_DIR, STORAGE_VAULTS } from './kbVaultState.js';
import { IEditorService, SIDE_GROUP } from '../../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService, GroupsOrder } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IWebContentExtractorService, ISharedWebContentExtractorService } from '../../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import { KbImportController } from '../kbImportController.js';
// 体检：规则与报告格式化都在这两个函数里（视图版与这里共用同一份 ✓）
import { formatLintReport, lintVault } from './kbLint.js';
// 去重检测：与原生视图共用同一份实现（合并流程暂不在此，见接口注释）
import { detectDuplicates, formatDedupReport } from './dedup.js';
// 审核队列：只读 list，不引入 write/approve（见 showReviewQueue 注释）
import { listReviewNotes } from './reviewStore.js';
import { CanvasEditorInput } from '../canvasEditor/canvasEditorInput.js';
import { KbMindmapGenerator } from '../views/knowledge/kbMindmapGenerator.js';
import type { IChatModel } from './llm.js';
import type { IMindmapData } from '../../common/mindmap/mindmapTypes.js';
import { IEmbeddingService } from '../../common/embeddingProvider.js';
import { IKbNativeKernelService, type IKbBuildRoot } from '../kbNativeKernelService.js';
import { KbGraphEditorInput } from '../kbGraphEditorInput.js';
import { KbSettingsEditorInput, IKbSettingsHost, type KbSettingsFocus } from '../kbSettingsEditorInput.js';
import { IDiagramRenderer } from '../peleDiagramRenderer.js';
import { IDrawioInlineRenderer } from '../drawioInlineRenderer.js';
import { KbLinkGraph, IKbGraphRoot } from '../views/knowledgeBase/kbGraph.js';
import { KbNativeKernel } from '../views/knowledgeBase/kbNativeKernel.js';
import { IKbVault, KbSection, newVaultId } from '../views/knowledgeBase/kbTypes.js';
import { resolveAuxEmbeddingProviderId, resolveAuxEmbeddingConfig } from './embeddingConfigResolver.js';
import { prepareDiagramsForSync } from './diagramSyncPrepare.js';
import { svgToPng } from './svgRasterizer.js';
import {
	AGENT_STUDIO_KB_FEISHU_CLI_PATH,
	AGENT_STUDIO_KB_FEISHU_SYNC_PARENT,
	AGENT_STUDIO_KB_FEISHU_SYNC_ON_CONFLICT,
	AGENT_STUDIO_KB_FEISHU_SYNC_INTERVAL,
	AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH,
	AGENT_STUDIO_KB_FEISHU_PRUNE_REMOTE,
} from '../../common/constants.js';
import {
	DEFAULT_LARK_CLI,
	KB_FEISHU_SYNC_SCRIPT_REL,
	LARK_CLI_MISSING_HINT,
	FEISHU_SPACE_MAP_FILE,
	buildSyncArgs,
	detectLarkCli,
	electronNodeLaunch,
	listWikiSpaces,
	createWikiSpace,
	sanitizeSpaceName,
	parseSpaceMap,
	deriveMappedSrcDirs,
	resolveSyncScript,
	serializeSpaceMap,
	type IKbSpaceMapping,
} from './feishuSyncCore.js';

export const IKbCommandService = createDecorator<IKbCommandService>('kbCommandService');

/**
 * 关系图谱的数据形状 —— ⚠ 直接取向构建器的返回类型（`IGraphNode` / `IGraphLink` 在 `kbGraph.ts` 里
 * 只是**局部**声明、没有导出 ✗）⇒ 这样定义一次，将来那边改名 / 换结构这里不会悄悄漂移 ✓。
 */
export type KbGraphData = ReturnType<KbLinkGraph['getGraphData']>;

/** 操作日志的附加字段（与视图里那份 `_logOp` 的入参同形 ✓）。 */
export interface IKbOpExtra {
	readonly source?: string;
	readonly target?: string;
	readonly detail?: Record<string, unknown>;
	readonly error?: string;
	readonly channel?: KbOpChannel;
}

export interface IKbCommandService {
	readonly _serviceBrand: undefined;

	/**
	 * 库清单 / 库目录变了（新增 / 删除 / 换根 / 换当前库）⇒ **视图（若在）据此整体重载** ✓。
	 * ⚠ 本事件是"内存副本追上真源"的唯一通道：视图不许自己再拼一套判断 ✗。
	 */
	readonly onDidChangeVaults: Event<void>;

	/** 知识库存储根（`agentStudio.knowledge.storage.path` 优先；与 `kbVaultFs.resolveActiveVaultRoot` 同值 ✓）。 */
	kbRootUri(): URI;
	/** 某个库的根目录（有 `customPath` 用它，否则 `<存储根>/<vaultId>` ✓）。 */
	vaultRootUri(vault: IKbVault): URI;
	/** 库内的分区目录（`库` / `笔记` ✓）。 */
	sectionUri(vault: IKbVault, section: KbSection): URI;

	/** 确保库根 / `库` / `笔记` 三处目录存在（带"已就绪"缓存，避免重复 IPC ✓）。 */
	ensureVaultFolders(vault: IKbVault): Promise<void>;
	/** 清掉某个库的"目录已就绪"缓存（换目录 / 新建时用 —— 不清会被短路 ✗）。 */
	invalidateVaultFolders(vaultId: string): void;

	/** 读库清单（storage 真源 ✓）。 */
	loadVaults(): IKbVault[];
	/**
	 * 写库清单（**只写，不广播**）。
	 *
	 * ⚠ 别在这里顺手广播 ✗：视图自己那 12 处保存（改名 / 开关库 / 排序 / 关联工作区…）都经它 ⇒
	 *   广播会让视图在每次保存后**整页重渲染**（内联重命名正被 `_renameActive` 保护着，那次重渲染会
	 *   把输入框连同用户没敲完的名字一起清掉 ✗）。**只有命令侧那两处增删**才广播（见 mutator ✓）。
	 */
	saveVaults(vaults: readonly IKbVault[]): void;
	/** 当前库 id（`agentStudio.kb.active` ✓）。 */
	activeVaultId(): string | undefined;
	/** 设当前库（只写 storage；视图在的话由事件驱动它重渲染 ✓）。 */
	setActiveVaultId(vaultId: string): void;
	/**
	 * 当前库**记录**（`active` 指向的那条；指向的没了就回落到第一个没关的 ✓ —— 与视图 `_activeVault`
	 * 的取值口径一致；都没有 ⇒ `undefined`）。
	 */
	activeVault(): IKbVault | undefined;

	/** 知识库操作日志根（`resolveKbRoot(...)` ✓ —— 与 Agent 工具侧同一份 `.op-log.jsonl`）。 */
	opLogRootDir(): string;
	/** 统一的操作日志入口（补 `ts` / `channel` 默认值 ✓ —— 视图的 `_logOp` 已委托到这里）。 */
	logOp(op: string, status: KbOpStatus, extra?: IKbOpExtra): Promise<void>;

	/**
	 * 「配置文件夹为知识库…」（真源 `configFolderAsVault` ✓）：**原生选目录** → 写清单 →
	 * 建 `库`/`笔记` → 设为当前。返回 `true` = 清单**真的**变了（宿主据此重启 Host 刷注入 ✓）；
	 * `false` = 用户取消（⇒ 不该重启 ✗）。
	 */
	addVaultFromFolder(): Promise<boolean>;
	/**
	 * 「删除知识库」（真源 `removeVault` ✓）：**原生确认框** → 递归删目录 → 移出清单。
	 * 返回 `true` = 清单真的变了；`false` = 用户取消 / 没这个库 / 删除失败（都已如实提示 ✓）。
	 */
	removeVaultById(vaultId: string): Promise<boolean>;

	/**
	 * 关系图谱的根目录：**只** `库` + `笔记` 两个分区（不含关联的代码仓库 ✓）——
	 * 与视图 `buildGraphRoots()` 同口径（供图谱构建与 EditorPane 内的「构建图谱」重扫 ✓）。
	 */
	graphRoots(vault: IKbVault): IKbGraphRoot[];
	/** 关系图谱的数据（`nodes` / `links`）：基于磁盘重建（与视图用的是**同一个** `KbLinkGraph` ✓）。 */
	noteGraphData(vault: IKbVault): Promise<KbGraphData>;
	/**
	 * 「🕸 关系图谱」：构建数据 ⇒ 在编辑区打开 `KbGraphEditorInput`（第 2 期搬进来的 ✓）。
	 * ⚠ 空图 / 没有可用库时**如实提示**（dsh 引擎这条路上没有视图能替你说话 ⇒ 静默＝"点了没反应" ✗）。
	 */
	openGraph(): Promise<void>;

	/**
	 * 「⚙ 知识库设置」：在编辑区打开 `KbSettingsEditorPane`（第 3 期搬进来的 ✓ —— host 的 21 个方法
	 * 全在服务里，dsh 引擎下没有视图也能开 ✓）。
	 */
	openSettings(focusSection?: KbSettingsFocus): Promise<void>;
	/** 「📂 打开知识库目录」（真源菜单里那一项 ✓）。 */
	openKbFolder(): Promise<void>;
	/**
	 * 飞书同步（`dry-run` 预览 / `apply` 实际写入）。**不抛**：失败已如实提示 + 进同步输出 ✓
	 * （视图的工具栏按钮与设置面板的按钮走同一份 ✓）。
	 */
	feishuSync(mode: 'dry-run' | 'apply'): Promise<void>;
	/**
	 * **仅 stat** 的文档统计（设置面板"统计"区用）：不读正文、不建索引 ⇒ 打开面板不会卡 ✓。
	 * ⚠ 与视图那份的差别如实记：视图取的是**已构建内核**的实时值，这里是**打开面板那一刻**的快照 ✓。
	 */
	docStats(vault: IKbVault | undefined): Promise<{ docs: number; bytes: number }>;
	/** 索引根：`库` + `笔记` + 该库**关联的**代码仓库（供向量重建与内核构建上下文 ✓）。 */
	indexRoots(vault: IKbVault): IKbBuildRoot[];

	/**
	 * 「导入链接 / URL」（真源菜单里那一项 ✓）：原生输入框 → 抓正文 + 下图片 → 落 `库/raw/<slug>.md`。
	 * 第 4 期搬进来的（**纯重构**：编排走共享的 `KbImportController.importUrl` ✓）—— 目的是让日后
	 * dsh 页要加这个按钮时**只需加一条桥命令**，不必再回到视图里挖实现 ✓。
	 */
	importFromUrl(): Promise<void>;

	/**
	 * 「🧠 思维导图」（真源工具栏那个按钮 ✓）：有 `.canvas` 就打开，没有先生成再打开。
	 * 第 5 期搬进来的（连带 `generateMindmapAfterImport` / `openCanvasEditor` ✓ —— 三块互为一体，
	 * 单独搬会是半拆 ✗，见 README 5.143）。
	 */
	openMindmap(): Promise<void>;

	/**
	 * 体检（2026-10-24 从 `KnowledgeBaseViewPane._runLint` 抽到服务层）。
	 *
	 * 为什么抽：`体检/去重/审核` 原来是视图的私有方法，React 侧栏（现在的主入口）**够不着**，
	 * 只能在「知识库（经典）」里用 ⇒ 两个入口能力不一致 ✗。
	 * 只搬**胶水**：规则在 `kbLint.lintVault`、报告格式化在 `formatLintReport`（原样复用，无第二实现 ✓）。
	 *
	 * @returns 检出的问题数（`-1` 表示失败）—— 视图侧据此决定要不要刷新树。
	 */
	runVaultLint(): Promise<number>;

	/**
	 * 整理去重**检测**（2026-10-24 从 `_runDedup` 抽离，只搬检测+报告）。
	 *
	 * ⚠ 不含「合并去重」：那是逐组确认的交互链（`_runDedupMerge`，选保留项 + 重写引用），
	 *   先在「知识库（经典）」里用。检测这一步已经能给出 `dedup-report.md`，足以判断要不要合并。
	 * @returns 疑似重复组数（`-1` 表示失败/无库）
	 */
	runVaultDedup(): Promise<number>;

	/**
	 * 审核队列**只读概览**（2026-10-24）：返回 `.review/` 待审篇数，并把前几篇的名字报给用户。
	 *
	 * ⚠ 刻意**不做移回/清空**：
	 *   · 那两个动作要求一个选择列表（`IQuickInputService`），而本服务没有注入它 ——
	 *     为一个“概览”去改构造函数签名不划算（会波及所有 DI 组装点）；
	 *   · 更重要的是它们**会改用户笔记**（移回 / 永久删除），在没有列表 UI 的前提下
	 *     只给一个“全部删掉”的确认框，风险不对等。
	 *   ⇒ 变更类操作仍在「知识库（经典）」里，这里只负责“让你知道有待审的东西”。
	 * @returns 待审篇数（`-1` = 失败/无库）
	 */
	showReviewQueue(): Promise<number>;
	/**
	 * 导入 / 构建完成后**自动生成或更新**思维导图（增量扫"笔记"区最近文件 → LLM 提结构 → 合并进 `.canvas` ✓）。
	 * 视图里那 3 个调用点（初始化后 / 导入后 / 构建后）现在都走服务 ✓。
	 */
	generateMindmapAfterImport(): Promise<void>;
	/** 打开 `.canvas` 思维导图编辑器（解析失败 ⇒ 退化成纯文本编辑器 ✓）。 */
	openCanvasEditor(uri: URI): Promise<void>;
}

/** SQLite FTS5 内核索引的自动启用阈值（大库才开）——**唯一真源**：视图与设置面板都读它 ✓。 */
export const KB_SQLITE_AUTO_THRESHOLD = 2000;

/**
 * 取知识库用的 LLM ChatModel（`AgentStudioService.createKbChatModel` 链 ✓）。
 *
 * ★ 2026-10-16（第 5 期）：原来它是视图的私有方法 `_getOrCreateChatModel()`，但**服务侧的思维导图生成**
 * 也要它 ⇒ 提成共享函数（视图那 2 处调用点也改用它 ✓ —— 否则就是两份实现 ✗）。
 */
export function resolveKbChatModel(agentStudioService: IAgentStudioService): IChatModel | null {
	try {
		const svc = agentStudioService as unknown as { createKbChatModel?: () => IChatModel | null };
		return svc.createKbChatModel?.() ?? null;
	} catch {
		return null;
	}
}

export class KbCommandService extends Disposable implements IKbCommandService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeVaults = this._register(new Emitter<void>());
	readonly onDidChangeVaults: Event<void> = this._onDidChangeVaults.event;

	/** 已确认目录存在的库 id（避免重复 `fileService.exists/createFolder` IPC ✓）。 */
	private readonly _foldersReady = new Set<string>();

	constructor(
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IFileService private readonly _fileService: IFileService,
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
		@IRequestService private readonly _requestService: IRequestService,
		@IWebContentExtractorService private readonly _webContentExtractorService: IWebContentExtractorService,
		@ISharedWebContentExtractorService private readonly _sharedWebContentExtractorService: ISharedWebContentExtractorService,
		@IEmbeddingService private readonly _embeddingService: IEmbeddingService,
		@IKbNativeKernelService private readonly _kernelService: IKbNativeKernelService,
		@IDiagramRenderer private readonly _mermaidRenderer: IDiagramRenderer,
		@IDrawioInlineRenderer private readonly _drawioRenderer: IDrawioInlineRenderer,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	// ── 路径 ────────────────────────────────────────────────────────────────────────────────

	kbRootUri(): URI {
		const custom = this._storageService.get(STORAGE_KB_DIR, StorageScope.APPLICATION);
		if (typeof custom === 'string' && custom.trim()) { return URI.file(custom.trim()); }
		return URI.joinPath(this._environmentService.userHome, ...KB_ROOT_SUBPATH.split('/'));
	}

	vaultRootUri(vault: IKbVault): URI {
		if (vault.customPath) { return URI.file(vault.customPath); }
		return URI.joinPath(this.kbRootUri(), vault.id);
	}

	sectionUri(vault: IKbVault, section: KbSection): URI {
		return URI.joinPath(this.vaultRootUri(vault), section === 'library' ? KB_LIBRARY_SUBPATH : KB_NOTES_SUBPATH);
	}

	// ── 库目录 ──────────────────────────────────────────────────────────────────────────────

	async ensureVaultFolders(vault: IKbVault): Promise<void> {
		if (this._foldersReady.has(vault.id)) { return; }
		try {
			const root = this.vaultRootUri(vault);
			const lib = this.sectionUri(vault, 'library');
			const notes = this.sectionUri(vault, 'notes');
			// ★★ 2026-09-23 诊断日志（照搬视图那份 ✓）：定位「知识库根下凭空多出 `<时间戳>-<随机>` 目录」——
			//   那个目录名 = `vault.id` ⇒ 只有**没有 `customPath` 的（旧）vault** 才会走 fallback ✓。
			if (!vault.customPath) {
				this._logService.warn(`[KB][vault-dir] legacy vault WITHOUT customPath → root=${root.fsPath} (id=${vault.id}, name=${vault.name})\nstack=${new Error().stack}`);
			}
			// 只建不存在的（`createFolder` 是重 IPC，即便目录已在也贵 ✓）
			if (!await this._fileService.exists(root)) {
				this._logService.info(`[KB][vault-dir] createFolder(root): ${root.fsPath} (id=${vault.id}, name=${vault.name}, customPath=${vault.customPath ?? '(none)'})\nstack=${new Error().stack}`);
				await this._fileService.createFolder(root);
			}
			if (!await this._fileService.exists(lib)) { await this._fileService.createFolder(lib); }
			if (!await this._fileService.exists(notes)) { await this._fileService.createFolder(notes); }
			this._foldersReady.add(vault.id);
		} catch (err) {
			this._logService.warn(`[KB] ensureVaultFolders failed (will retry on demand): ${err}`);
		}
	}

	invalidateVaultFolders(vaultId: string): void {
		this._foldersReady.delete(vaultId);
	}

	// ── 库清单（storage 真源）───────────────────────────────────────────────────────────────

	loadVaults(): IKbVault[] {
		try {
			const raw = this._storageService.get(STORAGE_VAULTS, StorageScope.APPLICATION);
			return raw ? JSON.parse(raw) as IKbVault[] : [];
		} catch {
			return [];
		}
	}

	saveVaults(vaults: readonly IKbVault[]): void {
		this._storageService.store(STORAGE_VAULTS, JSON.stringify(vaults), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	activeVaultId(): string | undefined {
		const id = this._storageService.get(STORAGE_ACTIVE, StorageScope.APPLICATION);
		return typeof id === 'string' && id.trim() ? id.trim() : undefined;
	}

	setActiveVaultId(vaultId: string): void {
		this._storageService.store(STORAGE_ACTIVE, vaultId, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	activeVault(): IKbVault | undefined {
		const vaults = this.loadVaults();
		const id = this.activeVaultId();
		// ★★ 2026-10-19 补第三档：**全部库都被标成 closed 时取第一个**。
		//   真机事故：`_kbVaultsSlim()` 明明读到了库（dsh 页面能显示「我的知识库」），
		//   但 `find(v => !v.closed)` 返回 undefined ⇒ `_syncToFeishu` 走 `!vault` 早退
		//   ⇒ 用户点「同步飞书」只看到一句警告、没有终端（B 那轮已给这条分支补了 op-log ✓）。
		//   语义：closed 只表示"不在侧栏常驻"这类偏好，**不等于"这个库不可用"** ⇒
		//   真要用它的时候（同步 / 写笔记）不该因为偏好拿不到它 ✗。
		const picked = vaults.find(v => v.id === id)   // ① 显式激活的那个（哪怕它 closed ✓ —— 用户选的就是它）
			?? vaults.find(v => !v.closed)             // ② 第一个未关闭的
			?? vaults[0];                              // ③ 兜底：全 closed 也要给一个（"有库却用不了"最费解 ✗）
		// ★ 2026-10-19：**取不到 / 落到兜底时留痕**。真机"根目录不对"这类问题，
		//   光看界面分不清是"清单空"还是"取到了另一个库"⇒ 这里把三个数打出来：
		//   vaults 总数、期望的 activeId、最终选中谁（以及它是不是靠兜底拿到的）。
		if (!picked) {
			this._logService.warn(`[KB] activeVault() 取不到任何库：vaults=${vaults.length} activeId=${id ?? '(空)'} closed=${vaults.filter(v => v.closed).length}`);
		} else if (id && picked.id !== id) {
			this._logService.warn(`[KB] activeVault() 未命中期望的库 ⇒ 落到兜底：期望 ${id}，实际 ${picked.id}（vaults=${vaults.length}，closed=${vaults.filter(v => v.closed).length}）`);
		}
		return picked;
	}

	// ── 操作日志 ────────────────────────────────────────────────────────────────────────────

	opLogRootDir(): string {
		const cfg = this._configurationService.getValue<string>('agentStudio.knowledge.storage.path');
		return resolveKbRoot(cfg, this._environmentService.userDataPath);
	}

	async logOp(op: string, status: KbOpStatus, extra?: IKbOpExtra): Promise<void> {
		await appendKbOpLog(this._fileService, this.opLogRootDir(), {
			ts: new Date().toISOString(),
			op, status,
			channel: extra?.channel ?? 'vault',
			source: extra?.source, target: extra?.target,
			detail: extra?.detail, error: extra?.error,
		} as IKbOpLogEntry);
	}

	// ── ① 配置文件夹为知识库 ────────────────────────────────────────────────────────────────

	async addVaultFromFolder(): Promise<boolean> {
		const picked = await this._fileDialogService.showOpenDialog({
			title: localize('kb.configFolder', '选择文件夹作为知识库'),
			canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
		});
		if (!picked || !picked.length) { return false; }
		const folder = picked[0];
		const name = folder.path.split('/').filter(Boolean).pop() || '知识库';
		const vaults = this.loadVaults();
		const vault: IKbVault = {
			id: newVaultId(), name, icon: '📁', sort: vaults.length,
			sortMode: 'createdASC', closed: false, path: folder.fsPath, customPath: folder.fsPath,
		};
		vaults.push(vault);
		// ⚠ 顺序照视图那份：先落清单 ⇒ 建目录 ⇒ 设为当前 ⇒（本服务额外）广播清单变化 ✓
		this.saveVaults(vaults);
		await this.ensureVaultFolders(vault);
		this.setActiveVaultId(vault.id);
		this._onDidChangeVaults.fire();                 // ← 命令侧改动才广播（见 saveVaults 的注释 ✓）
		this._notificationService.info(localize('kb.folderConfigured', '已配置文件夹为知识库：{0}', name));
		void this.logOp('vault.configFolder', 'success', { target: folder.fsPath, detail: { name } });
		return true;
	}

	// ── ② 删除知识库（永久，不可逆 ✓）──────────────────────────────────────────────────────

	async removeVaultById(vaultId: string): Promise<boolean> {
		const vaults = this.loadVaults();
		const vault = vaults.find(v => v.id === vaultId);
		if (!vault) { return false; }
		const confirm = await this._dialogService.confirm({
			message: localize('kb.removeVault', '确定删除知识库「{0}」及其全部内容？', vault.name),
			primaryButton: localize('kb.delete', '删除'),
		});
		if (!confirm.confirmed) { return false; }
		const rootUri = this.vaultRootUri(vault);
		try {
			await this._fileService.del(rootUri, { recursive: true });
		} catch (err) {
			// ⚠ 如实说（旧路径是让异常冒到命令层 ⇒ 用户只看到一条泛化警告 ✗）
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[KB] remove vault failed: ${msg}`);
			void this.logOp('vault.delete', 'failure', { target: rootUri.fsPath, error: msg });
			this._notificationService.warn(localize('kb.removeVaultFailed', '删除知识库失败：{0}', msg));
			return false;
		}
		const rest = vaults.filter(v => v.id !== vault.id);
		// ⚠ 顺序要紧：**先**落当前库 ⇒ **再**写清单 ⇒ **最后**广播。订阅方（视图）在广播那一刻读到的
		//   必须是终态；否则它会在"当前库已被删掉"的中间态上做一次回落判断 ✗（反向突变钉着这条 ✓）。
		const next = rest.find(v => !v.closed);          // 与视图旧行为一致：落到下一个没关的（没有就不动 storage ✓）
		if (next) { this.setActiveVaultId(next.id); }
		this.saveVaults(rest);
		this._onDidChangeVaults.fire();                  // ← 命令侧改动才广播（见 saveVaults 的注释 ✓）
		void this.logOp('vault.delete', 'success', { target: rootUri.fsPath, detail: { name: vault.name } });
		return true;
	}

	// ── ③ 关系图谱（第 2 期）────────────────────────────────────────────────────────────────

	graphRoots(vault: IKbVault): IKbGraphRoot[] {
		return (['library', 'notes'] as KbSection[]).map(s => ({ uri: this.sectionUri(vault, s), section: s }));
	}

	async noteGraphData(vault: IKbVault): Promise<KbGraphData> {
		// ⚠ 这里**每次现建一个** `KbLinkGraph`（而不是共用视图那个长驻实例 ✗）：视图那份还要喂反链 / 提及，
		//   两边共享一个可变对象只会互相踩。**构建器本身是同一个类** ⇒ 口径仍只有一份 ✓（视图 :5546 那条
		//   注释也写着"直接基于磁盘重建即可（开销很小）" ✓）。
		const graph = new KbLinkGraph(this._fileService);
		await graph.build(this.graphRoots(vault));
		return graph.getGraphData();
	}

	async openGraph(): Promise<void> {
		const vault = this.activeVault();
		if (!vault) {
			// ⚠ 视图旧行为是**静默 return** —— 那条路上有界面替你说话；命令这条路上静默就是"点了没反应" ✗
			this._notificationService.info(localize('kb.graphNoVault', '还没有可用的知识库：先「配置文件夹为知识库…」再打开关系图谱。'));
			return;
		}
		try {
			const { nodes, links } = await this.noteGraphData(vault);
			if (nodes.length === 0) {
				this._notificationService.info(localize('kb.graphEmpty', '知识库暂无可绘制的关系（先导入或创建带双链的笔记）'));
				return;
			}
			// 携带库/笔记分区根目录（不含关联的代码仓库），供图谱面板内的「构建图谱」按钮重新扫描 ✓
			const groups = this._editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
			await this._editorService.openEditor(
				new KbGraphEditorInput(nodes, links, '关系图谱', this.graphRoots(vault)),
				{ pinned: true },
				targetGroup,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this._logService.error('[KB graph] open failed', e);
			this._notificationService.error(localize('kb.graphOpenFailed', '打开关系图谱失败：{0}', msg));
		}
	}

	// ── ④ 设置面板（第 3 期）────────────────────────────────────────────────────────────────
	// 这批以前是**视图私有的**（`_createSettingsHost()` 那 21 个闭包）⇒ dsh 引擎下没有视图就开不了面板 ✗。
	// 搬过来之后视图只剩委托壳 ✓；下面每个方法都注明它与视图那份的差别（没有差别就是逐字搬 ✓）。

	indexRoots(vault: IKbVault): IKbBuildRoot[] {
		const roots: IKbBuildRoot[] = (['library', 'notes'] as KbSection[]).map(s => ({ uri: this.sectionUri(vault, s), section: s }));
		for (const p of vault.linkedFolders ?? []) {
			roots.push({ uri: URI.file(p), section: 'library' });
		}
		return roots;
	}

	async docStats(vault: IKbVault | undefined): Promise<{ docs: number; bytes: number }> {
		if (!vault) { return { docs: 0, bytes: 0 }; }
		try {
			// ⚠ **只 stat**（`collectDocMetas` 不读正文 ✓）：面板只是要数量/体积，为它建一次索引不值 ✗
			const kernel = new KbNativeKernel(this._fileService, this._embeddingService, resolveAuxEmbeddingProviderId(this._configurationService));
			const metas = await kernel.collectDocMetas(this.indexRoots(vault));
			return { docs: metas.length, bytes: metas.reduce((sum, m) => sum + (m.size ?? 0), 0) };
		} catch (err) {
			this._logService.warn(`[KB] docStats failed: ${err instanceof Error ? err.message : String(err)}`);
			return { docs: 0, bytes: 0 };
		}
	}

	async openKbFolder(): Promise<void> {
		const vault = this.activeVault();
		if (!vault) { return; }
		await this._openerService.open(this.vaultRootUri(vault), { openExternal: true });
	}

	// ── 飞书同步输出（终端 onData 的镜像 ✓；面板可能被重建 ⇒ 缓存在服务里才恢复得出来 ✓）──
	private _feishuSyncOutput = '';
	private readonly _feishuSyncListeners = new Set<(chunk: string) => void>();
	private _feishuSyncTerminalSub: { dispose(): void } | undefined;
	/**
	 * 上一次「同步到飞书」开的终端实例（★ 2026-10-19）。
	 *
	 * ⚠ 原来这里**只解绑 onData 订阅、从不关终端** ⇒ 用户每点一次同步就多一个
	 *   「KB → 飞书同步」终端（连点几次堆一排，还得手动一个个关 ✗）。
	 *   现在：新建前先 dispose 旧的（同一时刻只保留一次同步的终端）。
	 */
	private _feishuSyncTerminal: { isDisposed?: boolean; dispose(): void } | undefined;

	/** 广播一段同步输出（缓存 + 通知所有面板订阅者；单个订阅者异常不影响其它 ✓）。截断到最近 40k ✓。 */
	private _emitSyncOutput(chunk: string): void {
		if (!chunk) { return; }
		this._feishuSyncOutput = (this._feishuSyncOutput + chunk).slice(-40000);
		for (const listener of [...this._feishuSyncListeners]) {
			try { listener(chunk); } catch (err) {
				this._logService.warn(`[KB feishu] sync output listener failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/**
	 * 同步前把笔记里的 mermaid / drawio / canvas 渲染为 PNG 附件并改写引用（2026-09-23 ✓）。
	 * 编排在 `knowledge/diagramSyncPrepare.ts`（与 agent 的 `kb_feishu_sync` 工具**共用同一份** ✓）。
	 */
	private async _renderDiagramsBeforeSync(srcDirs: readonly string[], dryRun: boolean): Promise<void> {
		const vault = this.activeVault();
		if (!vault) { return; }
		let headerDone = false;
		const emit = (line: string): void => {
			if (!headerDone) {
				headerDone = true;
				this._emitSyncOutput(dryRun
					? '\n=== 预览图表与附件（只统计，不改动任何文件）===\n'
					: '\n=== 准备图表与附件（drawio/canvas → PNG；mermaid → 画板；html → 附件）===\n');
			}
			this._emitSyncOutput(line);
		};
		const result = await prepareDiagramsForSync({
			vaultRoot: this.vaultRootUri(vault),
			srcDirs,
			// ⚠ `dryRun` **必须**传下去（漏传＝真渲染＋改写笔记正文 ✗ —— 见 diagramSyncPrepare.ts:140 的契约 ✓）
			dryRun,
			fileService: this._fileService,
			renderMermaid: (src: string) => this._mermaidRenderer.renderToSvg(src, 'default'),
			renderDrawio: (src: string) => this._drawioRenderer.renderToSvg(src, 'default'),
			rasterize: (svg: string, scale?: number) => svgToPng(svg, { scale }),
			logService: this._logService,
			onProgress: emit,
		});
		if (!result.charts && !result.inlined && !result.attachments && !result.failures) { return; }
		emit(dryRun
			? `图表与附件预览：${result.charts} 张待转图片`
				+ `${result.inlined ? `，${result.inlined} 个 mermaid 转画板` : ''}`
				+ `${result.attachments ? `，${result.attachments} 个 HTML 附件` : ''}`
				+ ` —— 点「同步」时自动处理（**预览不改动文件**）。\n`
			: `图表与附件准备完成：${result.charts} 个转为图片`
				+ `${result.inlined ? `，${result.inlined} 个 mermaid 转画板` : ''}`
				+ `${result.attachments ? `，${result.attachments} 个 HTML 附件` : ''}`
				+ `${result.failures ? `，${result.failures} 个失败（已保留源码）` : ''}，改动 ${result.touched} 篇笔记。\n`);
	}

	/** 公开入口：**不抛**（失败如实提示 + 进同步输出 ✓）—— 视图工具栏与设置面板都走它 ✓。 */
	async feishuSync(mode: 'dry-run' | 'apply'): Promise<void> {
		try {
			await this._syncToFeishu(mode);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[KB feishu] sync launch failed: ${err instanceof Error ? err.stack ?? msg : msg}`);
			this._emitSyncOutput(`\n[启动失败] ${msg}\n`);
			this._notificationService.warn(localize('kb.feishuLaunchFailed', '飞书同步启动失败：{0}', msg));
		}
	}

	/**
	 * 确保底部 panel **用户真的看得见**，返回终端应建的位置。
	 *
	 * ★★★ 2026-10-20（「同步飞书不弹 panel」第三轮定稿）：与 `dshHarness.contribution.ts:1187-1215`
	 *   （页面「在终端打开」，2026-10-14 真机验证过）**同一套流程**，不另起炉灶 ——
	 *   · 判据只看 **DOM**（`display` + `offsetHeight`）：agents 布局的隐藏是纯 DOM 的，
	 *     `isVisible(PANEL_PART)` 恒为 true（`agentLayoutWorkbench.ts:970-974`），信它就会什么都不做 ✗；
	 *   · 展开只走标题栏同款的 DOM 事件 `agent-studio:toggle-panel`（`toggleAgentsPanel()` 补齐了
	 *     「清 inline display + 恢复 35% 高度 + 打开容器」四件事）；
	 *   · 状态与 DOM 不一致时第一次派发可能走"隐藏"分支 ⇒ 最多两次、每次复核 DOM；
	 *   · 本来就显示着 ⇒ **一次都不派发**（toggle 会把用户正看着的 panel 关掉 ✗）；
	 *   · 实在出不来 ⇒ 退到编辑区（至少看得见），并如实落日志。
	 */
	private async _ensureAgentsPanelShown(): Promise<TerminalLocation> {
		const panelElement = (): HTMLElement | undefined => {
			try { return this._layoutService.getContainer(mainWindow, Parts.PANEL_PART); } catch { return undefined; }
		};
		const shown = (el: HTMLElement | undefined): boolean => !!el && el.style.display !== 'none' && el.offsetHeight > 0;
		const wasShown = shown(panelElement());
		let panelShown = wasShown;
		for (let attempt = 0; !panelShown && attempt < 2; attempt++) {
			if (attempt > 0) {
				// 第 2 轮兜底：状态"谎报可见"时先对齐成 hidden，下一次切换必然落进"显示"分支
				try {
					if (this._layoutService.isVisible(Parts.PANEL_PART)) {
						this._layoutService.setPartHidden(true, Parts.PANEL_PART);
					}
				} catch { /* 对齐失败也照常派发，后面还会复核 */ }
			}
			mainWindow.document.dispatchEvent(new CustomEvent('agent-studio:toggle-panel'));
			await new Promise<void>(resolve => setTimeout(resolve, 200));
			panelShown = shown(panelElement());
		}
		const location = panelShown ? TerminalLocation.Panel : TerminalLocation.Editor;
		this._logService.info(`[KB] 飞书同步终端：panel=${wasShown ? '已显示' : (panelShown ? '原为隐藏，已展开 ✓' : '展不开 ⇒ 退到编辑区')} location=${location === TerminalLocation.Panel ? 'panel' : 'editor'}`);
		return location;
	}

	/**
	 * 诊断探针：建完同步终端后在 T+0 / 0.5s / 1.5s / 4s 采样 panel（只读）。
	 *
	 * 每行字段的判读：
	 * - `display` / `offsetH` / `rect`：panel 元素此刻是否真的占位（之后变成 none / 0 ⇒ 有别的代码收回了它）；
	 * - `termDom`：panel 里终端 DOM 的高度（`none` ⇒ 终端没进这个 panel）；
	 * - `hitInPanel`：panel 中心点最上层的 DOM 是否属于 panel（false ⇒ 被别的 DOM 盖住；
	 *   ⚠ 原生 WebContentsView 不在 DOM 里，**看不出来** —— 若各项都正常而屏上仍看不到，就只剩它）；
	 * - `target` / `disposed`：终端实例是否还活着、落在哪（1 = Panel，2 = Editor）。
	 */
	private _tracePanelAfterTerminal(terminal: { readonly target?: TerminalLocation; readonly isDisposed: boolean }): void {
		const sample = (tag: string): void => {
			try {
				const el = this._layoutService.getContainer(mainWindow, Parts.PANEL_PART);
				const r = el?.getBoundingClientRect();
				const termDom = el?.querySelector<HTMLElement>('.terminal-outer-container, .xterm');
				const hit = r && r.width > 0 && r.height > 0
					? mainWindow.document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
					: null;
				const rect = r ? `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : '-';
				this._logService.info(`[KB] panel 探针 ${tag}: display=${el?.style.display || '(空)'} offsetH=${el?.offsetHeight ?? -1} rect=${rect}`
					+ ` isVisible=${this._layoutService.isVisible(Parts.PANEL_PART)} termDom=${termDom ? termDom.offsetHeight : 'none'}`
					+ ` target=${terminal.target ?? '?'} disposed=${terminal.isDisposed}`
					+ ` hitInPanel=${!!(hit && el?.contains(hit))} hit=${hit ? String(hit.className || hit.tagName).slice(0, 60) : '-'}`
					+ ` win=${mainWindow.innerWidth}x${mainWindow.innerHeight}`);
			} catch (e) {
				this._logService.warn(`[KB] panel 探针 ${tag} 失败：${e instanceof Error ? e.message : String(e)}`);
			}
		};
		sample('T+0');
		for (const ms of [500, 1500, 4000]) {
			setTimeout(() => sample(`T+${ms}ms`), ms);
		}
	}

	/** 拼装并执行飞书同步脚本（在集成终端里跑，输出对用户可见 ✓；逐字搬自视图 :3124-3230 ✓）。 */
	private async _syncToFeishu(mode: 'dry-run' | 'apply'): Promise<void> {
		const vault = this.activeVault();
		if (!vault) {
			// ★★ 2026-10-19：这条分支**原先只弹一句警告就 return** —— 而它是四个早退分支里
			//   唯一**不写 op-log** 的 ⇒ 真机表现为「点了同步飞书：没终端、没日志、什么都没有」✗
			//   （另外三条 lark-cli / 脚本 / 目录映射 都会写 `feishu.sync failure`，一查就懂 ✓）。
			//   根因是 **IDE 侧 vault 清单（storage `agentStudio.kb.vaults`）为空**，而 dsh 侧
			//   用的是注入的 `kbVaults`（`e:\VsSarosVault`）⇒ 两侧清单不同源。
			//   这里先把**可观测性**补上（治本的同源改造见后续）。
			this._logService.warn('[KB feishu] 没有可用的 Vault ⇒ 未开始同步：IDE 侧的 vault 清单（storage agentStudio.kb.vaults）为空，而 dsh 侧用的是注入的 kbVaults —— 两处清单不同源。');
			void this.logOp('feishu.sync', 'failure', { target: mode, error: 'no active vault (IDE storage agentStudio.kb.vaults is empty; dsh side uses injected kbVaults)' });
			this._notificationService.warn(localize('kb.feishuNoVault', '没有可用的知识库 Vault，无法同步：IDE 侧的知识库清单是空的（可到「知识库设置」里添加一个指向你库目录的 vault）。'));
			return;
		}

		// ① 运行环境预检：飞书 CLI 未安装时立刻给安装引导，而不是让脚本跑到一半失败
		const cliPath = (this._configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_CLI_PATH) || DEFAULT_LARK_CLI).trim();
		const cli = await detectLarkCli(cliPath);
		if (cli.state === 'missing') {
			void this.logOp('feishu.sync', 'failure', { target: mode, error: 'lark-cli missing' });
			this._notificationService.warn(LARK_CLI_MISSING_HINT);
			return;
		}

		// ② 同步脚本内置：从产品资源目录定位（不再依赖工作区外部脚本）
		const script = await resolveSyncScript(this._fileService, this._environmentService);
		if (!script) {
			void this.logOp('feishu.sync', 'failure', { target: mode, error: 'builtin script not found' });
			this._notificationService.warn(localize('kb.feishuScriptMissing', '未找到内置同步脚本（{0}）——安装可能不完整，请重新安装应用。', KB_FEISHU_SYNC_SCRIPT_REL));
			return;
		}

		const rawInterval = this._configurationService.getValue<number>(AGENT_STUDIO_KB_FEISHU_SYNC_INTERVAL);

		// ★ 2026-09-24（用户定调）：「同步到飞书」**只同步「笔记」区里已配置映射的目录** ✓
		//   （未配置映射的目录不进入范围，也不自动建库 ✗ —— 见 `deriveMappedSrcDirs` ✓）。
		const effectiveSrcDirs = deriveMappedSrcDirs(await this._loadSpaceMap());
		if (effectiveSrcDirs.length === 0) {
			void this.logOp('feishu.sync', 'failure', { target: mode, error: 'no mapped dirs under 笔记' });
			this._notificationService.warn(localize('kb.feishuNoMappedDir', '尚未把「笔记」里的任何目录关联到飞书知识库，无法同步：请到「知识库设置 → 飞书同步 → 目录映射」添加一条映射。'));
			return;
		}
		this._emitSyncOutput(`\n同步范围（来自「目录映射」，仅『笔记』区）：${effectiveSrcDirs.join('、')}\n`);
		const parent = (this._configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_SYNC_PARENT) || 'my_library').trim();
		const onConflict = this._configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_SYNC_ON_CONFLICT) === 'skip' ? 'skip' : 'overwrite';

		// ③ 参数拼装走共享纯函数（与面板 / 脚本契约单点维护 ✓）
		const rawDepth = this._configurationService.getValue<number>(AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH);
		const args = buildSyncArgs(script.fsPath, {
			vaultPath: this.kbRootUri().fsPath,
			srcDirs: effectiveSrcDirs,
			parent,
			onConflict,
			intervalMs: Number.isFinite(rawInterval) && rawInterval >= 0 ? rawInterval : 800,
			categoryDepth: Number.isFinite(rawDepth) && rawDepth >= 0 ? rawDepth : 1,
			autoCreateSpaces: false,
			prune: this._configurationService.getValue<boolean>(AGENT_STUDIO_KB_FEISHU_PRUNE_REMOTE) === true,
			mode,
		});
		if (cliPath && cliPath !== DEFAULT_LARK_CLI) { args.push('--cli', cliPath); }

		const cwd = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;

		try {
			// ★ 2026-09-25：预览（dry-run）零副作用 —— `_renderDiagramsBeforeSync` 里把 dryRun 传下去 ✓
			await this._renderDiagramsBeforeSync(effectiveSrcDirs, mode !== 'apply');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.warn(`[KB feishu] diagram preparation failed (non-fatal): ${msg}`);
			this._emitSyncOutput(`\n[图表准备] 跳过（不影响同步）：${msg}\n`);
		}

		const launch = electronNodeLaunch();
		const runner = launch.executable ? 'electron-node' : 'system-node';
		void this.logOp('feishu.sync', 'success', { target: mode, detail: { srcCount: effectiveSrcDirs.length, parent, onConflict, cli: cli.version ?? cliPath, runner } });

		try {
			// ★★★ 先把 panel **真正显示出来**，再决定终端建在哪（理由见文件头 IWorkbenchLayoutService 的注释）。
			const panelLocation = await this._ensureAgentsPanelShown();
			const terminal = await this._terminalService.createTerminal({
				// 面板确实显示了才建在 Panel；显示不出来（布局里没有该部件）⇒ 退到编辑区，至少让用户看得见 ✓
				location: panelLocation,
				config: {
					name: `KB → 飞书同步（${mode === 'apply' ? '同步' : '预览'}）`,
					executable: launch.executable ?? 'node',
					args,
					cwd,
					env: launch.executable ? launch.env : undefined,
					waitOnExit: true, // 结束后保留终端，便于查看输出
				},
			});
			// ★ 2026-10-19：**先关掉上一次的同步终端**（见字段注释 —— 否则连点几次会堆一排终端 ✗）
			this._feishuSyncTerminalSub?.dispose();
			this._feishuSyncTerminalSub = undefined;
			if (this._feishuSyncTerminal && !this._feishuSyncTerminal.isDisposed) {
				try { this._feishuSyncTerminal.dispose(); } catch { /* 已被用户手动关掉 ⇒ 忽略 */ }
			}
			this._feishuSyncTerminal = terminal;
			// 把终端输出镜像给设置面板（用户不必切到终端 ✓；终端本身仍保留 ✓）
			this._feishuSyncTerminalSub = terminal.onData(chunk => this._emitSyncOutput(chunk));
			this._emitSyncOutput(`\n=== 启动飞书同步（${mode === 'apply' ? '同步' : '预览'}）===\n`);
			this._terminalService.setActiveInstance(terminal);
			await this._terminalService.revealTerminal(terminal);
			// 焦点落到新终端（面板刚展开时尤其需要：焦点还在别处，用户会以为没打开 ✓）
			if (panelLocation === TerminalLocation.Panel) {
				try { await terminal.focusWhenReady(true); } catch { /* 聚焦失败不致命 */ }
			}
			// ★ 2026-10-20 诊断（第四轮：日志说「已展开 ✓」，用户仍看不到）：建完终端后按时间采样 panel 真相，
			//   区分「之后被收回去」「展开了但被盖住」「终端没进 panel」三种情况。只读、不改任何状态。
			this._tracePanelAfterTerminal(terminal);
			// 显式反馈：同步跑在新终端里（可能开在别的面板/被折叠）⇒ 没有提示用户只会觉得「点了没反应」✗
			this._notificationService.info(localize('kb.feishuLaunched',
				'已启动飞书同步（{0}），正在终端中运行，可切到终端查看进度。', mode === 'apply' ? '同步' : '预览'));
		} catch (err) {
			this._logService.warn(`[KB] feishu sync launch failed: ${err instanceof Error ? err.message : String(err)}`);
			this._notificationService.warn(localize('kb.feishuLaunchFailed', '飞书同步启动失败：{0}', err instanceof Error ? err.message : String(err)));
		}
	}

	// ── 「本地目录 ↔ 飞书知识库」映射（vault 外层配置文件的读写 ✓）──────────────────────────
	// ⚠ 落点是**知识库存储根**（`kbRootUri()`）而不是库目录 —— 与内置脚本读的是同一份 ✓。

	private _spaceMapUri(): URI {
		return URI.joinPath(this.kbRootUri(), FEISHU_SPACE_MAP_FILE);
	}

	private async _loadSpaceMap(): Promise<IKbSpaceMapping[]> {
		try {
			return parseSpaceMap((await this._fileService.readFile(this._spaceMapUri())).value.toString());
		} catch {
			return [];
		}
	}

	private async _saveSpaceMap(list: ReadonlyArray<IKbSpaceMapping>): Promise<void> {
		try {
			await this._fileService.writeFile(this._spaceMapUri(), VSBuffer.fromString(serializeSpaceMap(list)));
		} catch (err) {
			this._logService.warn(`[KB] save space map failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 列出可选飞书知识库（未安装 CLI / 未登录 / 解析失败 ⇒ 空数组，面板据此给提示 ✓）。 */
	private async _listSpaces(): Promise<Array<{ spaceId: string; name: string }>> {
		const cliPath = (this._configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_CLI_PATH) || DEFAULT_LARK_CLI).trim() || DEFAULT_LARK_CLI;
		try {
			return await listWikiSpaces(cliPath);
		} catch {
			return [];
		}
	}

	/** 弹出输入框获取新知识库名称（取消 / 去引号后为空 ⇒ undefined ✓）。 */
	private async _promptSpaceName(): Promise<string | undefined> {
		const r = await this._dialogService.input({
			message: localize('kb.feishuNewSpace', '新建飞书知识库名称'),
			inputs: [{ value: '我的知识库' }],
		});
		if (!r.confirmed) { return undefined; }
		return sanitizeSpaceName(r.values?.[0]) || undefined;
	}

	/** 在飞书**新建**知识库（与内置脚本共用同一 lark-cli 路径；失败 ⇒ undefined 由面板提示 ✓）。 */
	private async _createSpace(name: string): Promise<{ spaceId: string; name: string } | undefined> {
		const cliPath = (this._configurationService.getValue<string>(AGENT_STUDIO_KB_FEISHU_CLI_PATH) || DEFAULT_LARK_CLI).trim() || DEFAULT_LARK_CLI;
		try {
			const created = await createWikiSpace(name, cliPath);
			if (created) {
				this._notificationService.info(localize('kb.feishuSpaceCreated', '已新建飞书知识库：{0}', created.name));
			}
			return created;
		} catch (err) {
			this._logService.warn(`[KB] create feishu space failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	/** 选择知识库内的目录（返回**相对知识库根**的路径；取消 / 越界 ⇒ undefined ✓）。 */
	private async _pickDirForMapping(): Promise<string | undefined> {
		const picked = await this._fileDialogService.showOpenDialog({
			canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
			defaultUri: this.kbRootUri(),
			title: '选择要映射到飞书知识库的目录（知识库内）',
		});
		const uri = picked?.[0];
		if (!uri) { return undefined; }
		// 用字符串前缀比较（避免额外引入 path 模块）；只在知识库根内选取
		const root = this.kbRootUri().fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
		const full = uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
		if (full === root || !full.startsWith(root + '/')) {
			this._notificationService.warn(localize('kb.spaceMapOutsideVault', '请选择知识库目录（或其子目录）内的文件夹。'));
			return undefined;
		}
		// ★ 2026-09-24（同步范围只认「笔记」区）：把选择器同样限制在「笔记」区内 ✓
		const notesRoot = `${root}/${KB_NOTES_SUBPATH}`;
		if (full !== notesRoot && !full.startsWith(notesRoot + '/')) {
			this._notificationService.warn(localize('kb.spaceMapOutsideNotes', '请选择「笔记」区内的文件夹（同步范围只包含「笔记」区里已关联的目录）。'));
			return undefined;
		}
		return full.slice(root.length + 1);
	}

	/** 打开设置面板引用的文件（如同步日志）；不存在时提示而非静默失败 ✓。 */
	private async _openSettingsFile(uri: URI): Promise<void> {
		try {
			await this._fileService.stat(uri);
		} catch {
			this._notificationService.info(localize('kb.fileMissing', '文件不存在：{0}', uri.fsPath));
			return;
		}
		await this._openerService.open(uri);
	}

	/** 调原生文件夹选择框，选取知识库目录（返回最终生效路径；取消 ⇒ undefined ✓）。 */
	private async _pickDir(current: string): Promise<string | undefined> {
		const picked = await this._fileDialogService.showOpenDialog({
			title: localize('kb.pickRoot', '选择知识库目录'),
			canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
			defaultUri: URI.file(current),
		});
		if (!picked || !picked.length) { return undefined; }
		return this._applyDir(picked[0].fsPath);
	}

	/**
	 * 应用新的知识库目录（**所选目录本身就是 Vault 根** ✓ —— 2026-09-23 的语义调整，不再多套一层
	 * `<时间戳>/`；与 «配置文件夹为知识库» 的 `customPath` 语义一致 ✓）。
	 */
	private async _applyDir(dir: string): Promise<string | undefined> {
		const fsPath = URI.file(dir).fsPath;
		const vaults = this.loadVaults();
		const vault = this.activeVault() ?? vaults[0];
		if (!vault) {
			this._notificationService.warn(localize('kb.noVaultForDir', '没有可用的知识库 Vault，请先创建。'));
			return undefined;
		}
		this._storageService.store(STORAGE_KB_DIR, fsPath, StorageScope.APPLICATION, StorageTarget.MACHINE);
		void this.logOp('vault.kbDir', 'success', { target: fsPath });
		// 所选目录即 Vault 根；`path` 与 `customPath` 保持同一真源
		const target = vaults.find(v => v.id === vault.id);
		if (target) {
			target.customPath = fsPath;
			target.path = fsPath;
		}
		this.invalidateVaultFolders(vault.id);       // 路径已变 ⇒ 重新判定「库/笔记」是否存在 ✓
		this.setActiveVaultId(vault.id);
		this.saveVaults(vaults);
		this._onDidChangeVaults.fire();              // 视图据此重渲染（dsh 引擎下没有视图也不影响 ✓）
		await this.ensureVaultFolders(target ?? vault);
		this._notificationService.info(localize('kb.rootChanged', '知识库目录已切换为：{0}', fsPath));
		return fsPath;
	}

	/** 使用当前 Embedding 设置重新构建**所有** Vault 的向量索引（决策链见视图原注释 ✓）。 */
	private async _rebuildVectorIndex(): Promise<void> {
		const providerId = resolveAuxEmbeddingProviderId(this._configurationService);
		const embCfg = resolveAuxEmbeddingConfig(this._configurationService);
		const vaults = this.loadVaults();
		const vault = this.activeVault();
		if (!vault || !vaults.length) {
			this._notificationService.warn(localize('kb.rebuildEmpty', '没有可用的知识库 Vault，请先创建或导入。'));
			return;
		}
		if (!this._embeddingService.getActiveTag()) {
			this._notificationService.warn('Embedding 服务未启用。请在设置中配置模型 Provider。');
			return;
		}
		this._notificationService.info(`使用模型 ${embCfg.modelId} (${embCfg.dimensions}d) 重新构建向量索引…`);
		this._agentStudioService.requestLibraryBadge({ source: 'kb', kind: 'building' });
		try {
			this._kernelService.invalidate();
			const roots = this.indexRoots(vault);
			if (roots.length === 0) {
				this._notificationService.warn('没有可索引的目录。');
				this._agentStudioService.requestLibraryBadge({ source: 'kb', kind: 'idle' });
				return;
			}
			// 让共享内核知道"这个库在哪、缓存落哪"（视图那份在 `rebuildSearchAssets` 里做同一件事 ✓）
			this._kernelService.setBuildContext(roots, URI.joinPath(this.vaultRootUri(vault), '.kbkernel.json'));
			await this._kernelService.buildVectorIndex(roots);
			// ★ 落盘：把构建结果写成紧凑二进制 `.kvindex`（dsh 侧语义检索的数据源 ✓）
			//   ⚠ **只在恰好一个 vault 时落** ✓：`buildVectorIndex` 是**合并索引** ⇒ 多库拆不出来，
			//     写出来会是"合并态却假装是某库的" ✗（多库要每库一份 ⇒ 得先按 vault 分块，另记 ✓）。
			if (vaults.length === 1) {
				try {
					await this._kernelService.exportVectorToFile(URI.joinPath(URI.file(vaults[0].path), '.kvindex'));
				} catch (err) {
					this._logService.warn(`[KB] 向量索引落盘失败（不影响内存态检索 ✓）：${String((err as { message?: string })?.message ?? err)}`);
				}
			}
			const st = this._kernelService.getVectorStatus();
			this._notificationService.info(`向量索引重建完成：${st.chunkCount} 个块（维度 ${st.dimensions}）。`);
			void this.logOp('settings.embedding.rebuild', 'success', {
				detail: { provider: providerId ?? 'auto', model: embCfg.modelId, dimensions: embCfg.dimensions, chunks: st.chunkCount },
			});
			this._agentStudioService.requestLibraryBadge({ source: 'kb', kind: 'idle' });
		} catch (err) {
			this._notificationService.error(`向量索引重建失败：${String((err as { message?: string })?.message ?? err)}`);
			void this.logOp('settings.embedding.rebuild', 'failure', {
				detail: { provider: providerId ?? 'auto', model: embCfg.modelId, dimensions: embCfg.dimensions },
				error: String(err),
			});
			this._agentStudioService.requestLibraryBadge({ source: 'kb', kind: 'idle' });
		}
	}

	/**
	 * 组装设置面板要的**视图能力**（21 个方法）—— 搬过来的唯一目的就是让"面板不再依赖视图" ✓。
	 * ⚠ 取值口径与原视图那份逐条对齐；统计是**打开那一刻的快照**（视图版是实时值 ✓，见 `docStats` ✓）。
	 */
	private _buildSettingsHost(vault: IKbVault | undefined, stats: { docs: number; bytes: number }): IKbSettingsHost {
		return {
			getRootPath: () => this.kbRootUri().fsPath,
			hasActiveVault: () => !!vault,
			getDocCount: () => stats.docs,
			getTotalSize: () => stats.bytes,
			// 「是否启用 SQLite FTS5 内核索引」：视图看的是**活对象**（`!!_kbSqliteStore`）；这里按
			// **同一条自动启用规则**回答（`docs > 阈值` ✓ —— 阈值常量只有一份 ✓），没有视图时这就是真相 ✓。
			isSqliteActive: () => stats.docs > KB_SQLITE_AUTO_THRESHOLD,
			getLinkedWorkspaceCount: () => vault?.linkedWorkspaces?.length ?? 0,
			logOp: (code, detail) => { void this.logOp(code, 'success', detail); },
			pickDir: (current) => this._pickDir(current),
			applyDir: (dir) => this._applyDir(dir),
			rebuildVectorIndex: () => { void this._rebuildVectorIndex(); },
			openKbFolder: () => { void this.openKbFolder(); },
			feishuSync: (mode) => { void this.feishuSync(mode); },
			getSyncOutput: () => this._feishuSyncOutput,
			onSyncOutput: (listener) => {
				this._feishuSyncListeners.add(listener);
				return { dispose: () => { this._feishuSyncListeners.delete(listener); } };
			},
			loadSpaceMap: () => this._loadSpaceMap(),
			saveSpaceMap: (list) => this._saveSpaceMap(list),
			listSpaces: () => this._listSpaces(),
			promptSpaceName: () => this._promptSpaceName(),
			createSpace: (name) => this._createSpace(name),
			pickDirForMapping: () => this._pickDirForMapping(),
			openFile: (uri) => { void this._openSettingsFile(uri); },
		};
	}

	// ── ⑤ 导入链接 / URL（第 4 期）──────────────────────────────────────────────────────────

	async importFromUrl(): Promise<void> {
		const r = await this._dialogService.input({
			message: localize('kb.importUrlHint', '导入链接 / URL（支持小红书 · 抖音 · 知乎 · YouTube · B站…）'),
			inputs: [{ value: 'https://', placeholder: '粘贴网页链接后回车' }],
		});
		if (!r.confirmed) { return; }
		const url = (r.values?.[0] ?? '').trim();
		if (!url || url === 'https://') { return; }
		// ★ 统一反馈：走「徽标 + 视图内状态」通道（**不发通知**），与其它导入/构建入口一致 ✓。
		//   抓正文 + 下图片可能持续数十秒，只弹一条 info 的话用户无从感知进度 ✓。
		this._agentStudioService.reportKbProcessing({ active: true, label: `导入链接中：${url}` });
		this._agentStudioService.requestLibraryBadge({ source: 'kb', kind: 'building' });
		try {
			const res = await KbImportController.importUrl({
				url,
				vaultRoot: this.kbRootUri(),
				fileService: this._fileService,
				logService: this._logService,
				requestService: this._requestService,
				extractor: this._webContentExtractorService,
				imageReader: this._sharedWebContentExtractorService,
			});
			if (res.ok) {
				void this.logOp('kb.importUrl', 'success', { target: url, detail: { images: res.images } });
				// 成功不再弹通知（过程反馈走徽标/视图内状态）；结果可在「库」里直接看到 ✓
				// ⚠ 视图侧原来是 `refreshSection('library')`；服务这层改用**已有事件**通知"该刷新了" ✓
				//   （视图在 ⇒ 它 debounce 后靶向刷新 ✓；dsh 引擎下没有视图 ⇒ 事件无人听，也无副作用 ✓）。
				this._agentStudioService.requestKbRefresh();
			} else {
				void this.logOp('kb.importUrl', 'failure', { target: url, detail: { message: res.message } });
				this._notificationService.warn(localize('kb.importUrlFailed', '导入失败：{0}', res.message));
			}
		} finally {
			// 收尾：清"处理中"状态；徽标转「有新增」，提示回资料库查看产出 ✓
			this._agentStudioService.reportKbProcessing({ active: false });
			this._agentStudioService.requestLibraryBadge({ source: 'kb', kind: 'new', count: 1 });
		}
	}

	// ── ⑥ 思维导图（第 5 期）────────────────────────────────────────────────────────────────

	/** 懒建的生成器（⚠ 视图里那份还在，供"改名 / 润色 / 合并"那几条流程用 —— 同一个类、无状态，两份实例无害 ✓）。 */
	private _mmGen?: KbMindmapGenerator;
	private _mm(): KbMindmapGenerator {
		this._mmGen ??= new KbMindmapGenerator(this._fileService, this._logService);
		return this._mmGen;
	}

	/** 打开 `.canvas` 思维导图编辑器（逐字搬自视图 :2618-2644 ✓）。 */
	async openCanvasEditor(uri: URI): Promise<void> {
		this._logService.info(`[KB canvas] _openCanvasEditor: ${uri.toString()}`);
		try {
			const raw = await this._fileService.readFile(uri);
			const text = raw.value.toString();
			this._logService.info(`[KB canvas] _openCanvasEditor: file read OK, length=${text.length}`);
			const data: IMindmapData = JSON.parse(text);
			if (!data.nodes) { data.nodes = []; }
			if (!data.edges) { data.edges = []; }
			if (data.mindmap === undefined) { data.mindmap = true; }
			this._logService.info(`[KB canvas] _openCanvasEditor: parsed nodes=${data.nodes.length}, edges=${data.edges.length}, mindmapFlag=${data.mindmap}`);
			const input = new CanvasEditorInput(uri, data);
			const groups = this._editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
			this._logService.info(`[KB canvas] _openCanvasEditor: opening CanvasEditorInput (targetGroup=${targetGroup})`);
			await this._editorService.openEditor(input, { pinned: true }, targetGroup);
		} catch (err) {
			this._logService.warn(`[KB canvas] _openCanvasEditor: FALLBACK to plain text editor. Error: ${err}`);
			const groups = this._editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
			this._editorService.openEditor({ resource: uri, options: { pinned: true } }, targetGroup);
		}
	}

	/** 导入后自动生成 / 更新思维导图（逐字搬自视图 :3822-3903，只有"刷新"那一步换成既有事件 ✓）。 */
	async generateMindmapAfterImport(): Promise<void> {
		const vault = this.activeVault();
		if (!vault) { return; }
		// 延迟执行，确保文件系统已落盘
		await new Promise(r => setTimeout(r, 600));
		try {
			const notesDir = this.sectionUri(vault, 'notes');
			// 增量策略：只取 mtime ≤ 5 分钟前的文件（刚导入/构建的）；少于 3 条时回退扫描全量
			// 扫描源为「笔记分区」而非「库分区」：HTML 等导入经「构建为笔记」后结构化内容落在
			// notes/（概念/对比/…），库分区往往只剩原始 .html，若只扫库分区会导致 libFiles 为空、
			// 思维导图永远不生成（此前 bug）。
			const recentCutoff = Date.now() - 5 * 60_000;
			const noteFiles: { fileName: string; content: string }[] = [];
			try {
				const st = await this._fileService.resolve(notesDir);
				const walk = async (d: typeof st) => {
					if (!d.children) { return; }
					for (const c of d.children) {
						if (c.isDirectory && !c.name.startsWith('.')) {
							try { await walk(await this._fileService.resolve(c.resource)); } catch { /* skip */ }
						} else if (!c.isDirectory && c.name.endsWith('.md')) {
							const isRecent = (c.mtime ?? 0) > recentCutoff;
							if (!isRecent) { continue; }
							try {
								const raw = await this._fileService.readFile(c.resource);
								const text = raw.value.toString().slice(0, 3000);
								const relName = c.resource.fsPath.slice(notesDir.fsPath.length + 1);
								noteFiles.push({ fileName: relName, content: text });
							} catch { /* skip */ }
						}
					}
				};
				await walk(st);
				// 增量太少则回退全量扫描（兜底：可能 mtime 未精确落盘）
				if (noteFiles.length < 3) {
					noteFiles.length = 0;
					const fullWalk = async (d: typeof st) => {
						if (!d.children) { return; }
						for (const c of d.children) {
							if (c.isDirectory && !c.name.startsWith('.')) {
								try { await fullWalk(await this._fileService.resolve(c.resource)); } catch { /* skip */ }
							} else if (!c.isDirectory && c.name.endsWith('.md')) {
								try {
									const raw = await this._fileService.readFile(c.resource);
									noteFiles.push({ fileName: c.resource.fsPath.slice(notesDir.fsPath.length + 1), content: raw.value.toString().slice(0, 3000) });
								} catch { /* skip */ }
							}
						}
					};
					await fullWalk(st);
				}
			} catch { /* 笔记区无文件 */ }
			if (noteFiles.length === 0) { return; }

			// 查找已有思维导图（笔记目录中任意 .canvas）
			const existingMap = await this._mm().listMindmaps(notesDir);
			let existingUri: URI | undefined;
			if (existingMap.size > 0) {
				existingUri = existingMap.get('mindmap.canvas') ?? existingMap.values().next().value;
			}

			const chatModel = resolveKbChatModel(this._agentStudioService);
			if (!chatModel) { return; }

			const result = await this._mm().generateOrUpdate(chatModel, notesDir, noteFiles, existingUri);
			if (result) {
				this._logService.info(`[mindmap] updated ${result.fsPath}`);
				// 视图版是 `refreshSection('notes')` ⇒ 服务这层改用**已有事件** ✓（与导入链接同一口径 ✓）
				this._agentStudioService.requestKbRefresh();
			}
		} catch (err) {
			this._logService.warn(`[mindmap] generation failed: ${err}`);
		}
	}

	/** 「🧠 思维导图」按钮（逐字搬自视图 :4992-5021 ✓）。 */
	async openMindmap(): Promise<void> {
		const vault = this.activeVault();
		if (!vault) {
			// ⚠ 与图谱同一条口径：视图旧版是**静默 return**（那儿有界面替你说话）；服务这条路上静默
			//   就是"点了没反应" ✗ ⇒ 如实说（这是本块唯一一处与视图版的**有意**差别 ✓）。
			this._notificationService.info(localize('kb.mindmapNoVault', '还没有可用的知识库：先「配置文件夹为知识库…」再打开思维导图。'));
			return;
		}
		try {
			const notesDir = this.sectionUri(vault, 'notes');
			// 查找已有思维导图
			const existingMap = await this._mm().listMindmaps(notesDir);
			let canvasUri: URI;
			if (existingMap.size > 0) {
				canvasUri = existingMap.get('mindmap.canvas') ?? existingMap.values().next().value!;
			} else {
				// 先生成
				this._notificationService.info('正在生成思维导图…');
				await this.generateMindmapAfterImport();
				const retryMap = await this._mm().listMindmaps(notesDir);
				if (retryMap.size === 0) {
					this._notificationService.warn('未找到可生成的内容，请先导入笔记。');
					return;
				}
				canvasUri = retryMap.get('mindmap.canvas') ?? retryMap.values().next().value!;
			}
			await this.openCanvasEditor(canvasUri);
		} catch (err) {
			this._logService.error('[KB mindmap] open failed', err);
			this._notificationService.error('打开思维导图失败：' + (err instanceof Error ? err.message : String(err)));
		}
	}

	/** 体检（实现见接口注释）。返回问题数；失败/无库返回 -1。 */
	async runVaultLint(): Promise<number> {
		const vault = this.activeVault();
		if (!vault) {
			this._notificationService.info(localize('kb.lintNoVault', '还没有可用的知识库：先「配置文件夹为知识库…」再做体检。'));
			return -1;
		}
		try {
			const notesDir = this.sectionUri(vault, 'notes');
			const libDir = this.sectionUri(vault, 'library');
			// ⚠ 扫描根是**笔记区**，库只作「来源目录」传入 —— 反过来会把库内引用全判成断链（误报）
			const issues = await lintVault(this._fileService, notesDir, libDir);
			const report = formatLintReport(notesDir, issues);
			await this._fileService.writeFile(URI.joinPath(notesDir, 'lint-report.md'), VSBuffer.fromString(report));
			await KbImportController.appendKbLog(this._fileService, notesDir, `体检：${issues.length} 项问题`);
			const cnt = (sev: string) => issues.filter(i => i.severity === sev).length;
			this._notificationService.info(`知识库体检完成：${issues.length} 项（error ${cnt('error')} / warning ${cnt('warning')} / info ${cnt('info')}），详见 lint-report.md`);
			return issues.length;
		} catch (err) {
			this._logService.error('[KB lint] failed', err);
			this._notificationService.error('体检失败：' + (err instanceof Error ? err.message : String(err)));
			return -1;
		}
	}

	/** 整理去重（检测 + 报告，见接口注释）。返回疑似重复组数；失败/无库 -1。 */
	async runVaultDedup(): Promise<number> {
		const vault = this.activeVault();
		if (!vault) {
			this._notificationService.info(localize('kb.dedupNoVault', '还没有可用的知识库：先「配置文件夹为知识库…」再整理去重。'));
			return -1;
		}
		try {
			const notesDir = this.sectionUri(vault, 'notes');
			const libDir = this.sectionUri(vault, 'library');
			// 签名只收 (fileService, notesDir)：去重只比较笔记正文，库目录不参与
			const groups = await detectDuplicates(this._fileService, notesDir);
			const report = formatDedupReport(notesDir, groups);
			await this._fileService.writeFile(URI.joinPath(notesDir, 'dedup-report.md'), VSBuffer.fromString(report));
			await KbImportController.appendKbLog(this._fileService, libDir, `整理去重：${groups.length} 组疑似重复`);
			const total = groups.reduce((s, g) => s + g.notes.length, 0);
			this._notificationService.info(`整理去重完成：${groups.length} 组疑似重复（共 ${total} 篇），详见 dedup-report.md。合并去重请用「知识库（经典）」。`);
			return groups.length;
		} catch (err) {
			this._logService.error('[KB dedup] failed', err);
			this._notificationService.error('整理去重失败：' + (err instanceof Error ? err.message : String(err)));
			return -1;
		}
	}

	/** 审核队列只读概览（见接口注释）。返回待审篇数；失败/无库 -1。 */
	async showReviewQueue(): Promise<number> {
		const vault = this.activeVault();
		if (!vault) {
			this._notificationService.info(localize('kb.reviewNoVault', '还没有可用的知识库：先「配置文件夹为知识库…」。'));
			return -1;
		}
		try {
			const notesDir = this.sectionUri(vault, 'notes');
			const notes = await listReviewNotes(this._fileService, notesDir) as readonly unknown[];
			if (!notes.length) {
				this._notificationService.info('审核队列为空');
				return 0;
			}
			// `listReviewNotes` 的元素形态可能是 URI，也可能是 {uri,name}；两种都兜住（只用 path 取文件名）
			const names = notes.slice(0, 5).map(n => {
				const raw = (n as { uri?: unknown })?.uri ?? n;
				return String((raw as URI | undefined)?.path ?? '').split('/').pop() ?? '';
			}).filter(Boolean);
			this._notificationService.info(
				`审核队列有 ${notes.length} 篇待审${names.length ? '：' + names.join('、') : ''}${notes.length > names.length ? ' …' : ''}。`
				+ '移回/清空请用「知识库（经典）」。',
			);
			return notes.length;
		} catch (err) {
			this._logService.error('[KB review] failed', err);
			this._notificationService.error('读取审核队列失败：' + (err instanceof Error ? err.message : String(err)));
			return -1;
		}
	}

	async openSettings(focusSection?: KbSettingsFocus): Promise<void> {
		const vault = this.activeVault();
		try {
			const stats = await this.docStats(vault);
			const input = new KbSettingsEditorInput(this._buildSettingsHost(vault, stats), focusSection);
			await this._editorService.openEditor(input, { pinned: true });
			void this.logOp('settings.open', 'success', { target: focusSection ?? 'default' });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[KB] failed to open settings editor: ${msg}`);
			this._notificationService.warn(localize('kb.settingsOpenFailed', '打开知识库设置失败：{0}', msg));
		}
	}
}

registerSingleton(IKbCommandService, KbCommandService, InstantiationType.Delayed);
