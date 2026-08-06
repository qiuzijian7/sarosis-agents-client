/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Knowledge Base View — 仿 SiYuan（思源笔记）的文件/数据管理机制与文件树 UI。
 *
 *  数据模型（双轨，对齐 SiYuan kernel）：
 *   - Vault（笔记本）= 磁盘上一个文件夹，元数据存于 IStorageService
 *   - 每个 Vault 下含两个分区文件夹：库（输入/待索引）、笔记（已规整内容树）
 *   - 文件即真实 .md/.txt/...，可被索引（索引库为后续派生产物）
 *
 *  UI（对齐 SiYuan app/src/layout/dock/Files.ts + _list.scss b3-list 风格）：
 *   - 多 Vault 切换下拉
 *   - 库 / 笔记 两个可折叠分区，各自带工具按钮
 *   - 库：导入数据源（Obsidian / 文件 / 文件夹 / 统一 URL 入口：小红书·抖音·知乎·YouTube·B站…）
 *   - 笔记：新建文件 / 新建文件夹 / 排序（14 种，对齐 SiYuan sortMenu）/ 全部折叠展开
 *   - 树节点懒加载展开、内联重命名、右键菜单（新建/重命名/删除/打开）
 *   - 折叠状态持久化（对齐 SiYuan LOCAL_FILESPATHS）
 *--------------------------------------------------------------------------------------------*/

import './media/kbView.css';

import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IFileService, IFileStat, FileChangesEvent, FileKind } from '../../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IFileDialogService, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IWorkingCopyFileService } from '../../../../../workbench/services/workingCopy/common/workingCopyFileService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IUndoRedoService, UndoRedoSource, UndoRedoGroup, UndoRedoElementType, IWorkspaceUndoRedoElement } from '../../../../../platform/undoRedo/common/undoRedo.js';
import { CodeDataTransfers } from '../../../../../platform/dnd/browser/dnd.js';
import { DataTransfers } from '../../../../../base/browser/dnd.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { basename as uriBasename, extname as uriExtname, isEqual } from '../../../../../base/common/resources.js';
import { IEditorService, SIDE_GROUP } from '../../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService, GroupsOrder, IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { EditorsOrder } from '../../../../../workbench/common/editor.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import { IModelSelectorService } from '../../common/modelSelector.js';
import { CodebaseGraphViewerEditorInput } from '../codebaseGraphViewerEditorInput.js';
import { KbImportController } from '../kbImportController.js';
import { lintVault, formatLintReport } from '../knowledge/kbLint.js';
import { detectDuplicates, formatDedupReport, mergeDuplicates, type DedupGroup } from '../knowledge/dedup.js';
import { writeReviewNote, listReviewNotes, approveReviewNote, routeLintToReview } from '../knowledge/reviewStore.js';
import { CodebaseIndexEditorInput } from '../codebaseIndexEditorInput.js';
import { ICodebaseGraphService } from '../codebaseGraphService.js';

import { type KbSearchMode } from './knowledgeBase/kbTreeViewer.js';
import { IIndexConfig, IndexMode, ICodebaseMemoryMcpService } from '../codebaseMemoryMcpService.js';
import { COMMON_EXCLUDE_DIRS } from '../../common/codebaseIndexDefaults.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { createKbSqliteStoreProxy } from '../kbSqliteStoreProxy.js';
import type { IKbSqliteBackend, IKbSqliteDoc } from '../../common/kbSqliteStoreChannel.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { $ } from '../../../../../base/browser/dom.js';
import { safeSetInnerHtml } from '../../../../../base/browser/domSanitize.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { Action, IAction, Separator } from '../../../../../base/common/actions.js';

import { localize } from '../../../../../nls.js';

import {
	IKbVault, IKbNode, KbSection,
	KbSortMode, KB_SORT_GROUPS, newVaultId,
} from './knowledgeBase/kbTypes.js';
import { KbMindmapGenerator } from './knowledge/kbMindmapGenerator.js';
import { STORAGE_VAULTS, STORAGE_ACTIVE, STORAGE_KB_DIR } from '../knowledge/kbVaultState.js';
import type { IChatModel } from '../knowledge/llm.js';
import { KbFullTextIndex, IKbSearchHit } from './knowledgeBase/kbIndex.js';
import { KbLinkGraph, IKbGraphRoot } from './knowledgeBase/kbGraph.js';
import { KbNativeKernel, INativeBacklinkResult } from './knowledgeBase/kbNativeKernel.js';
import { IKbNativeKernelService, type IKbBuildRoot } from '../kbNativeKernelService.js';
import { IEmbeddingService } from '../../common/embeddingProvider.js';
import { resolveAuxEmbeddingProviderId, resolveAuxEmbeddingConfig } from '../knowledge/embeddingConfigResolver.js';
import {
	AGENT_STUDIO_AUX_EMBEDDING_PROVIDER,
	AGENT_STUDIO_AUX_EMBEDDING_MODEL,
	AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS,
} from '../../common/constants.js';
import { KbWorkerManager } from './knowledgeBase/kbWorkerManager.js';
import { KbNoteEditorInput } from '../kbNoteEditorInput.js';
import { MemoryDetailEditorInput } from '../memoryDetailEditorInput.js';
import { CodebaseMemoryDetailEditorInput } from '../codebaseMemoryDetailEditorInput.js';
import { KbGraphEditorInput } from '../kbGraphEditorInput.js';
import { CanvasEditorInput } from '../canvasEditor/canvasEditorInput.js';
import type { IMindmapData } from '../../common/mindmap/mindmapTypes.js';
import { appendKbOpLog, type IKbOpLogEntry, type KbOpChannel, type KbOpStatus } from '../knowledge/kbOpLog.js';
import { resolveKbRoot } from '../knowledge/knowledgeStorage.js';
import { IKbVectorSearchHit } from './knowledgeBase/kbVectorIndex.js';

const KB_ROOT_SUBPATH = '.vssaros/knowledge-base';
const STORAGE_SORT_PREFIX = 'agentStudio.kb.sort.';
const STORAGE_EXPANDED_PREFIX = 'agentStudio.kb.expanded.';




type SectionFolderName = '库' | '笔记';

export class KnowledgeBaseViewPane extends ViewPane {

	private _body!: HTMLElement;
	private _vaultBar!: HTMLElement;
	private _vaultMenu!: HTMLElement;
	private _scroll!: HTMLElement;
	private _searchInput?: HTMLInputElement;

	/** ⚙ 设置面板按钮与下拉容器 */
	private _settingsBtn!: HTMLElement;
	private _settingsDD!: HTMLElement;

	/** 记忆库 Section 折叠状态 */
	private _memSectionCollapsed = false;
	private _codeSectionCollapsed = false;
	/** 记忆库 section 的 body 容器 */
	private _memSectionBody?: HTMLElement;
	/** 记忆库列表容器 */
	private _memList?: HTMLElement;

	private _vaults: IKbVault[] = [];
	private _activeVault: IKbVault | undefined;
	/** P3-3：文件监听 debounce handle。 */
	private _kbRefreshHandle: ReturnType<typeof setTimeout> | undefined;
	/** 重命名进行中：禁止任何视图重建（避免输入框被 replaceChildren 销毁导致重命名被取消）。 */
	private _renameActive = false;

	/** C 档虚拟化：rAF 分片渲染每帧渲染的节点上限（≤阈值时同步一次性渲染，省去 rAF 调度开销）。 */
	private static readonly KB_CHUNK_SIZE = 96;

	private _tagClassOpen = true;
	private _sortMode: KbSortMode = 'createdASC';
	/** P0: 搜索模式——全文检索或树内文件名筛选 */
	private _searchMode: KbSearchMode = 'fulltext';
	/** 知识库文件操作的撤销源，Ctrl+Z 时按此源撤销。 */
	private _kbUndoSource = new UndoRedoSource();
	/** 思维导图自动生成器（懒初始化） */
	private _mindmapGenerator?: KbMindmapGenerator;

	/** 已展开文件夹路径（持久化），用于懒加载树的展开恢复 */
	private _expandedFolders = new Set<string>();

	/** 正在加载中的文件夹 URI 字符串，避免重复加载 */
	private _loadingFolders = new Set<string>();

	/** 正在「构建为笔记」的库文件路径集合，用于文档 item 上显示「构建中」提示 */
	private _buildingPaths = new Set<string>();

	/** 搜索防竞态令牌：每次搜索自增，结果渲染前校验是否最新 */
	private _searchToken = 0;
	/** 侧边栏显示模式：文件树 | 最近编辑 */
	private _viewMode: 'tree' | 'recent' = 'tree';

	/** 全文倒排索引（替代遍历式搜索，对齐 FTS5 语义） */
	private _index: KbFullTextIndex;

	/** 双链图谱（[[...]] 反链映射） */
	private _graph: KbLinkGraph;

	/** 索引 / 图谱失效标记：文件变更后置位，下次搜索/选中时重建 */
	private _searchDirty = true;
	/** 防抖定时器：短时间内多次 markSearchDirty 只触发最后一次 rebuild */
	private _searchRebuildTimer: ReturnType<typeof setTimeout> | undefined;
	/** 搜索防抖定时器：避免逐键触发搜索（大库 SQLite IPC） */
	private _searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	/** 思维导图自动生成防抖（30 秒），防止频繁触发 LLM 调用 */
	private _mindmapDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	/** DOM 层多选：记录被选中的节点路径（Ctrl+Click 多选） */
	private _domSelectedPaths = new Set<string>();
	/** DOM 层最后选中项（Shift+Click 范围选择的锚点） */
	private _domLastSelectedPath: string | null = null;
	/** KB 文件剪贴板：{ uris, cut }。cut=true 表示剪切（粘贴时移动），false 表示复制。对齐 Explorer 剪贴板模型。 */
	private _kbClipboard: { uris: URI[]; cut: boolean } | null = null;
	/** 延迟构建标志：FTS 已就绪但提及索引/图谱未建（Worker 模式或手动延迟） */
	private _mentionPending = false;
	/** 大库标志（文档数 > KB_SQLITE_AUTO_THRESHOLD）：走 SQLite 增量同步，跳过内存倒排索引全量构建 */
	private _largeRepo = false;
	/** SQLite 上次同步时间戳（ms），增量同步只写入 mtime > 此值的文档。 */
	private _sqliteSyncMtime = 0;
	/** 导入 code-workspace 后自动展开的工作区分组名称（仅用于首次渲染）。 */
	private _autoExpandWsGroup: string | undefined = undefined;
	private _renderAllCount = 0;

	/** 反链面板容器 */
	private _backlinksEl?: HTMLElement;

	/** vssaros 内置内核（零外部依赖，始终可用） */
	private _nativeKernel: KbNativeKernel | undefined;

	/** Worker 管理器：将提及索引/图谱等重计算移到独立线程 */
	private _kbWorker: KbWorkerManager | undefined;

	/** SQLite 后端（主进程 FTS5，> 2000 文档自动启用）。 */
	private _kbSqliteStore: IKbSqliteBackend | undefined;

	/** 自动 SQLite 启用阈值（对齐 CodebaseGraph 的 _sqliteBackendEnabled）。 */
	private static readonly KB_SQLITE_AUTO_THRESHOLD = 2000;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
	@IHoverService hoverService: IHoverService,
	@IFileService private readonly fileService: IFileService,
	@IModelService private readonly modelService: IModelService,
	@ILanguageService private readonly languageService: ILanguageService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@ILogService private readonly logService: ILogService,
		@IRequestService private readonly requestService: IRequestService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	@IKbNativeKernelService private readonly _kbKernelService: IKbNativeKernelService,
	@IEmbeddingService private readonly _ragEmbeddingService: IEmbeddingService,
	@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
	@ICodebaseGraphService private readonly _codebaseGraphService: ICodebaseGraphService,
	@ICodebaseMemoryMcpService private readonly _cbmService: ICodebaseMemoryMcpService,
	@IMainProcessService private readonly _mainProcessService: IMainProcessService,
		@IModelSelectorService private readonly modelSelectorService: IModelSelectorService,
		@IWorkingCopyFileService private readonly workingCopyFileService: IWorkingCopyFileService,
		@IUndoRedoService private readonly undoRedoService: IUndoRedoService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._index = new KbFullTextIndex(this.fileService);
		this._graph = new KbLinkGraph(this.fileService);
		this._nativeKernel = new KbNativeKernel(
			this.fileService,
			this._ragEmbeddingService,
			// RAG 向量化使用「辅助模型 → Embedding」配置解析出的 provider（不再依赖 KB agent）。
			resolveAuxEmbeddingProviderId(this.configurationService),
		);
		// Share this already-built kernel with the BlockSuite note editor so it
		// can reuse the same backlink/mention index without re-scanning the vault.
		this._kbKernelService.setKernel(this._nativeKernel);

		// 新工作区创建后自动关联进知识库「库」并构建索引（Task 3）。
		// onDidChangeWorkspace 目前无其它订阅者；linkFolder 自带去重，
		// 同一路径重复触发不会重复索引。
		this._register(this.agentStudioService.onDidChangeWorkspace((wsId) => {
			void this._autoLinkWorkspace(wsId);
		}));
		// 后台 KB agent 完成导入处理后触发刷新
		this._register(this.agentStudioService.onDidRequestKbRefresh(() => {
			this.refresh();
		}));
		// P3-3：监听 vault 文件变化（外部编辑/外部程序改动），debounce 后刷新 + 重建导航
		this._register(this.fileService.onDidFilesChange(e => this._onVaultFilesChange(e)));
	}

	// ═══════════════════════════════════════════════════════════
	//  Paths
	// ═══════════════════════════════════════════════════════════

	private get rootUri(): URI {
		const custom = this.storageService.get(STORAGE_KB_DIR, StorageScope.APPLICATION);
		if (custom) { return URI.file(custom); }
		return URI.joinPath((this.environmentService as INativeEnvironmentService).userHome, ...KB_ROOT_SUBPATH.split('/'));
	}

	private vaultUri(v: IKbVault): URI {
		if (v.customPath) { return URI.file(v.customPath); }
		return URI.joinPath(this.rootUri, v.id);
	}

	private sectionUri(v: IKbVault, section: KbSection): URI {
		const folder: SectionFolderName = section === 'library' ? '库' : '笔记';
		return URI.joinPath(this.vaultUri(v), folder);
	}

	/** 由文件系统路径推断所属分区（library/notes）。 */
	private sectionOfPath(path: string): KbSection {
		if (!this._activeVault) { return 'notes'; }
		const lib = this.sectionUri(this._activeVault, 'library').fsPath.replace(/\\/g, '/').toLowerCase();
		const norm = path.replace(/\\/g, '/').toLowerCase();
		return (norm === lib || norm.startsWith(lib + '/')) ? 'library' : 'notes';
	}

	// ═══════════════════════════════════════════════════════════
	//  Operation log (`.saros/kb/.op-log.jsonl`)
	// ═══════════════════════════════════════════════════════════

	/** 操作日志统一落盘到知识库存储根（默认 `~/.vssaros/knowledge-base`），与 Agent 工具路径共用同一份 `.op-log.jsonl`。 */
	private get _opLogRootDir(): string {
		const cfg = this.configurationService.getValue<string>('agentStudio.knowledge.storage.path');
		return resolveKbRoot(cfg, (this.environmentService as INativeEnvironmentService).userDataPath);
	}

	private async _logOp(
		op: string, status: KbOpStatus,
		extra?: { source?: string; target?: string; detail?: Record<string, unknown>; error?: string; channel?: KbOpChannel },
	): Promise<void> {
		await appendKbOpLog(this.fileService, this._opLogRootDir, {
			ts: new Date().toISOString(),
			op, status,
			channel: extra?.channel ?? 'vault',
			source: extra?.source, target: extra?.target,
			detail: extra?.detail, error: extra?.error,
		} as IKbOpLogEntry);
	}

	// ═══════════════════════════════════════════════════════════
	//  Storage helpers
	// ═══════════════════════════════════════════════════════════

	private loadVaults(): IKbVault[] {
		try {
			const raw = this.storageService.get(STORAGE_VAULTS, StorageScope.APPLICATION);
			return raw ? JSON.parse(raw) as IKbVault[] : [];
		} catch {
			return [];
		}
	}

	private saveVaults(): void {
		this.storageService.store(STORAGE_VAULTS, JSON.stringify(this._vaults), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private loadSort(vaultId: string): KbSortMode {
		return (this.storageService.get(STORAGE_SORT_PREFIX + vaultId, StorageScope.APPLICATION) as KbSortMode) || 'createdASC';
	}

	private saveSort(vaultId: string, mode: KbSortMode): void {
		this.storageService.store(STORAGE_SORT_PREFIX + vaultId, mode, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private saveExpanded(vaultId: string, section: KbSection): void {
		this.storageService.store(STORAGE_EXPANDED_PREFIX + vaultId + '.' + section, JSON.stringify([...this._expandedFolders]), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	// ═══════════════════════════════════════════════════════════
	//  Render
	// ═══════════════════════════════════════════════════════════

	protected override renderBody(container: HTMLElement): void {
		const t0 = performance.now();
		super.renderBody(container);
		this._body = container;
		this._body.classList.add('kb-view');

		// ── ═══ 知识库 Section Header ═══ ──
		const header = $('div.kb-header');
		const title = $('span.kb-title');
		title.textContent = '📚 知识库';
		header.appendChild(title);
		header.appendChild($('span.kb-spacer'));
		const graphBtn = $('span.kb-hbtn');
		graphBtn.textContent = '🕸️'; graphBtn.title = '关系图谱（在中间栏打开）';
		graphBtn.onclick = () => this._openGraph();
		header.appendChild(graphBtn);
		const mindmapBtn = $('span.kb-hbtn');
		mindmapBtn.textContent = '🧠'; mindmapBtn.title = '思维导图（打开或生成 .canvas）';
		mindmapBtn.onclick = () => void this._openMindmap();
		header.appendChild(mindmapBtn);
		const refreshBtn = $('span.kb-hbtn');
		refreshBtn.textContent = '⟳'; refreshBtn.title = '刷新';
		refreshBtn.onclick = () => this.refresh();
		header.appendChild(refreshBtn);
		const buildAllBtn = $('span.kb-hbtn');
		buildAllBtn.textContent = '🏗️'; buildAllBtn.title = '批量构建笔记（将库中所有未处理文件转为笔记）';
		buildAllBtn.onclick = () => { void this._batchBuildAll(); };
		header.appendChild(buildAllBtn);
		const settingsBtn = $('span.kb-hbtn');
		settingsBtn.textContent = '⚙'; settingsBtn.title = '知识库设置（根目录等）';
		settingsBtn.onclick = (e) => { e.stopPropagation(); this.toggleSettingsPanel(); };
		this._settingsBtn = settingsBtn;
		header.appendChild(settingsBtn);
		this._body.appendChild(header);

		// 设置面板（⚙ 下拉）
		this._settingsDD = $('div.kb-dropdown.kb-settings');

		// ── ═══ 知识库 Body ═══ ──
		const kbBody = $('div.kb-section-body-main');
		kbBody.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:120px;';

		// Vault switcher
		this._vaultBar = $('div.kb-vault-bar');
		kbBody.appendChild(this._vaultBar);
		this._vaultMenu = $('div.kb-vault-menu');
		kbBody.appendChild(this._vaultMenu);

		// Search row: 搜索框 + 搜索模式切换 + 排序按钮
		const searchRow = $('div.kb-search-row');
		const searchBox = $('div.kb-search-box');
		safeSetInnerHtml(searchBox, '<span>🔍</span>');
		const searchInput = document.createElement('input');
		searchInput.placeholder = '搜索知识库…';
		searchInput.oninput = () => this.applyFilter(searchInput.value.trim().toLowerCase());
		this._searchInput = searchInput;
		searchBox.appendChild(searchInput);

		// 搜索模式切换按钮（全文 / 文件名）
		const modeBtn = $('span.kb-search-mode-btn');
		modeBtn.title = '当前：全文检索（点击切换为文件名筛选）';
		modeBtn.textContent = '全文';
		modeBtn.onclick = (e) => {
			e.stopPropagation();
			this._searchMode = this._searchMode === 'fulltext' ? 'filename' : 'fulltext';
			const isFileMode = this._searchMode === 'filename';
			modeBtn.classList.toggle('filename', isFileMode);
			if (isFileMode) {
				modeBtn.textContent = '文件名';
				modeBtn.title = '当前：文件名筛选（点击切换为全文检索）';
				searchInput.placeholder = '输入文件名筛选…';
			} else {
				modeBtn.textContent = '全文';
				modeBtn.title = '当前：全文检索（点击切换为文件名筛选）';
				searchInput.placeholder = '搜索知识库…';
			}
			// 触发重新过滤
			this.applyFilter(searchInput.value.trim().toLowerCase());
		};
		searchBox.appendChild(modeBtn);

		// 排序按钮
		const sortBtn = $('span.kb-search-sort-btn');
		sortBtn.textContent = '↑↓';
		sortBtn.title = '排序';
		sortBtn.onclick = (e) => {
			e.stopPropagation();
			this.openSearchSortDropdown(sortBtn);
		};
		searchBox.appendChild(sortBtn);

		searchRow.appendChild(searchBox);
		kbBody.appendChild(searchRow);

		// Scroll area（文件树）— DOM 渲染层（单一层）
		this._scroll = $('div.kb-scroll');
		kbBody.appendChild(this._scroll);

		this._body.appendChild(kbBody);

		// DOM 层键盘快捷键（Delete/F2）— 挂在 scroll 区域
		this._scroll.tabIndex = -1; // 使 div 可聚焦以接收键盘事件
		this._scroll.addEventListener('keydown', (e) => {
			this.logService.info(`[KB-DOM] keydown: key=${e.key} sel=${this._domSelectedPaths.size}`);
			const selNodes: IKbNode[] = [];
			for (const p of this._domSelectedPaths) {
				const el = this._scroll.querySelector(`.kb-node[data-path="${this.cssEscape(p)}"]`) as HTMLElement | null;
				const node = el ? this.nodeFromEl(el) : null;
				if (node) { selNodes.push(node); }
			}
			if (e.key === 'Delete' && !e.ctrlKey && !e.altKey) {
				e.preventDefault();
				// Shift+Delete = 永久删除（对齐 Explorer Delete Permanently）；Delete = 移入回收站
				if (e.shiftKey) {
					if (selNodes.length > 1) { void this._batchDeleteNodesPermanent(selNodes); }
					else if (selNodes.length === 1) { void this._deleteNodePermanent(selNodes[0]); }
				} else {
					if (selNodes.length > 1) { void this._batchDeleteNodes(selNodes); }
					else if (selNodes.length === 1) { void this.deleteNode(selNodes[0]); }
				}
			}
			if (e.key === 'F2') {
				e.preventDefault();
				const el = this._scroll.querySelector(`.kb-node[data-path="${this.cssEscape(this._domLastSelectedPath ?? '')}"]`) as HTMLElement | null;
				if (el) { void this.startRename(el, this.nodeFromEl(el)!); }
			}
			// Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — KB 视图内文件操作撤销/重做（对齐 Explorer）
			if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
				e.preventDefault();
				if (e.shiftKey) { void this._kbRedo(); } else { void this._kbUndo(); }
			}
			if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
				e.preventDefault();
				void this._kbRedo();
			}
			// Ctrl+X / Ctrl+C / Ctrl+V — 剪切/复制/粘贴（对齐 Explorer）
			if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'x' || e.key === 'X')) {
				e.preventDefault(); this._kbCopyToClipboard(true);
			}
			if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
				e.preventDefault(); this._kbCopyToClipboard(false);
			}
			if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
				e.preventDefault();
				const target = this._resolvePasteTargetDir();
				if (target) { void this._kbPaste(target); }
			}
			// Ctrl+N / Ctrl+Shift+N — 新建文件 / 新建文件夹（对齐原全局命令，作用于当前选中分区）
			if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'n' || e.key === 'N')) {
				e.preventDefault();
				const section = this._domLastSelectedPath ? this.sectionOfPath(this._domLastSelectedPath) : 'notes';
				if (e.shiftKey) { void this.newFolder(section); } else { void this.newFile(section); }
			}
		});

		// ── ═══ 拖拽分隔条 ═══ ──
		const dragHandle = $('div.kb-drag-handle');
		dragHandle.style.cssText = 'height:3px;background:#2a2a2a;cursor:row-resize;flex-shrink:0;transition:background .1s;';
		dragHandle.onmouseenter = () => { dragHandle.style.background = '#094771'; };
		dragHandle.onmouseleave = () => { dragHandle.style.background = '#2a2a2a'; };
		dragHandle.title = '拖拽调整知识库 / 记忆库高度';
		this._body.appendChild(dragHandle);

		// ── ═══ 记忆库 Section ═══ ──
		const memSection = $('div.kb-mem-section');
		memSection.style.cssText = 'display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;';
		this._body.appendChild(memSection);

		// 记忆库 Header（可点击折叠/展开）
		const memHeader = $('div.kb-mem-header');
		memHeader.style.cssText = 'display:flex;align-items:center;gap:6px;padding:7px 12px;background:#1e1e1e;cursor:pointer;font-size:12px;font-weight:600;border-bottom:1px solid #2a2a2a;min-height:32px;flex-shrink:0;';
		memHeader.onclick = () => this._toggleMemorySection(memSection, memHeader);
		const memArrow = $('span.kb-mem-arrow');
		memArrow.textContent = '▼';
		memArrow.style.cssText = 'font-size:9px;transition:transform .15s;color:#888;width:12px;text-align:center;flex-shrink:0;';
		memHeader.appendChild(memArrow);
		const memIcon = $('span');
		memIcon.textContent = '🧠';
		memIcon.style.cssText = 'font-size:13px;flex-shrink:0;';
		memHeader.appendChild(memIcon);
		const memLabel = $('span');
		memLabel.textContent = '记忆库';
		memLabel.style.cssText = 'flex:1;color:#e0e0e0;';
		memHeader.appendChild(memLabel);
		// 刷新记忆按钮
		const memRefreshBtn = $('span');
		memRefreshBtn.textContent = '⟳';
		memRefreshBtn.title = '刷新记忆库';
		memRefreshBtn.style.cssText = 'width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:3px;cursor:pointer;font-size:13px;color:#aaa;flex-shrink:0;';
		memRefreshBtn.onclick = (e) => { e.stopPropagation(); this._renderMemoryList(); };
		memHeader.appendChild(memRefreshBtn);
		memSection.appendChild(memHeader);

		// 记忆库 Body
		this._memSectionBody = $('div.kb-mem-body');
		this._memSectionBody.style.cssText = 'flex:1;overflow-y:auto;min-height:60px;';
		memSection.appendChild(this._memSectionBody);

		// 记忆列表容器
		this._memList = $('div.kb-mem-list');

		// 初始状态：记忆库默认展开
		this._renderMemoryList();

		// 拖拽逻辑：记忆库 section 高度可拖拽调整
		this._setupMemoryDragResize(dragHandle, memSection);

		// ── ═══ 代码库 Section ═══ ──（独立于记忆库，不参与拖拽；单一入口直达 Codebase Detail Editor Pane）
		const codebaseSection = $('div.kb-codebase-section');
		codebaseSection.style.cssText = 'display:flex;flex-direction:column;flex-shrink:0;border-top:1px solid #2a2a2a;';
		this._body.appendChild(codebaseSection);

		const codeHeader = $('div.kb-codebase-header');
		codeHeader.style.cssText = 'display:flex;align-items:center;gap:6px;padding:7px 12px;background:#1e1e1e;font-size:12px;font-weight:600;border-bottom:1px solid #2a2a2a;min-height:32px;flex-shrink:0;cursor:pointer;';
		codeHeader.onclick = () => this._toggleCodebaseSection(codebaseSection, codeHeader);
		codeHeader.onmouseenter = () => { codeHeader.style.background = '#252525'; };
		codeHeader.onmouseleave = () => { codeHeader.style.background = '#1e1e1e'; };
		const codeHeaderIcon = $('span');
		codeHeaderIcon.textContent = '🧬';
		codeHeaderIcon.style.cssText = 'font-size:13px;flex-shrink:0;';
		const codeHeaderLabel = $('span');
		codeHeaderLabel.textContent = '代码库';
		codeHeaderLabel.style.cssText = 'flex:1;color:#e0e0e0;';
		const codeArrow = $('span');
		codeArrow.className = 'kb-code-arrow';
		codeArrow.textContent = '▼';
		codeArrow.style.cssText = 'font-size:9px;color:#777;flex-shrink:0;transition:transform .15s;';
		codeHeader.replaceChildren(codeHeaderIcon, codeHeaderLabel, codeArrow);
		codebaseSection.appendChild(codeHeader);

		const codeBody = $('div.kb-codebase-body');
		codeBody.style.cssText = 'padding:4px 0;';
		const codeEntry = $('div.kb-codebase-entry');
		codeEntry.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;font-size:12px;margin:4px 8px;border-radius:4px;background:#1e1e1e;border:1px solid #2a2a2a;';
		codeEntry.onmouseenter = () => { codeEntry.style.background = '#252525'; codeEntry.style.borderColor = '#3a3a3a'; };
		codeEntry.onmouseleave = () => { codeEntry.style.background = '#1e1e1e'; codeEntry.style.borderColor = '#2a2a2a'; };
		codeEntry.onclick = () => this._openCodebaseDetailEditor();
		const ceIcon = $('span');
		ceIcon.textContent = '🧬';
		ceIcon.style.cssText = 'font-size:18px;flex-shrink:0;';
		codeEntry.appendChild(ceIcon);
		const ceText = $('div');
		ceText.style.cssText = 'flex:1;min-width:0;';
		const ceTitle = $('div');
		ceTitle.textContent = '查看完整代码库';
		ceTitle.style.cssText = 'color:#ddd;';
		ceText.appendChild(ceTitle);
		const ceMeta = $('div');
		ceMeta.textContent = '点击打开 CodebaseDetailEditorPane';
		ceMeta.style.cssText = 'font-size:10px;color:#555;margin-top:2px;';
		ceText.appendChild(ceMeta);
		codeEntry.appendChild(ceText);
		const ceArrow = $('span');
		ceArrow.textContent = '→';
		ceArrow.style.cssText = 'color:#555;font-size:14px;flex-shrink:0;';
		codeEntry.appendChild(ceArrow);
		codeBody.appendChild(codeEntry);
		codebaseSection.appendChild(codeBody);

		// Global click closes popups
		document.addEventListener('click', this._onGlobalClick);

		// initVaults
		this.logService.info(`[KB perf] renderBody skeleton: ${(performance.now() - t0).toFixed(1)}ms, starting initVaults...`);
		void this.initVaults().then(() => {
			this.logService.info(`[KB perf] renderBody total: ${(performance.now() - t0).toFixed(1)}ms`);
			// 首次打开时补检：导入可能在视图关闭时完成，需要触发导图生成
			this._scheduleMindmapGenerationOnInit();
		}).catch((err) => {
			this.logService.error(`[KB] initVaults failed: ${err}`);
			this.notificationService.error(localize('kb.initFailed', '知识库初始化失败：{0}', String(err?.message ?? err)));
			if (this._scroll) {
				this._scroll.replaceChildren();
				const e = $('div.kb-empty-inline');
				e.textContent = `知识库加载失败：${String(err?.message ?? err)}`;
				this._scroll.appendChild(e);
			}
		});
	}

	// ═══════════════════════════════════════════════════════════
	//  记忆库 Section — 折叠 / 拖拽 / 列表渲染
	// ═══════════════════════════════════════════════════════════

	/** 折叠/展开记忆库 section */
	private _toggleMemorySection(memSection: HTMLElement, memHeader: HTMLElement): void {
		this._memSectionCollapsed = !this._memSectionCollapsed;
		const arrow = memHeader.querySelector('.kb-mem-arrow') as HTMLElement | null;
		if (this._memSectionCollapsed) {
			memSection.style.flex = '0 0 auto';
			if (this._memSectionBody) { this._memSectionBody.style.display = 'none'; }
			if (arrow) { arrow.style.transform = 'rotate(-90deg)'; }
			memHeader.style.borderBottom = 'none';
		} else {
			memSection.style.flex = '';
			memSection.style.overflow = 'hidden';
			if (this._memSectionBody) { this._memSectionBody.style.display = ''; }
			if (arrow) { arrow.style.transform = 'rotate(0deg)'; }
			memHeader.style.borderBottom = '1px solid #2a2a2a';
			// 展开时刷新记忆列表
			this._renderMemoryList();
		}
	}

	/** 折叠/展开代码库 section */
	private _toggleCodebaseSection(codebaseSection: HTMLElement, codeHeader: HTMLElement): void {
		this._codeSectionCollapsed = !this._codeSectionCollapsed;
		const arrow = codeHeader.querySelector('.kb-code-arrow') as HTMLElement | null;
		const body = codebaseSection.querySelector('.kb-codebase-body') as HTMLElement | null;
		if (this._codeSectionCollapsed) {
			if (body) { body.style.display = 'none'; }
			if (arrow) { arrow.style.transform = 'rotate(-90deg)'; }
			codeHeader.style.borderBottom = 'none';
		} else {
			if (body) { body.style.display = ''; }
			if (arrow) { arrow.style.transform = 'rotate(0deg)'; }
			codeHeader.style.borderBottom = '';
		}
	}

	/** 拖拽调整记忆库高度 */
	private _setupMemoryDragResize(dragHandle: HTMLElement, memSection: HTMLElement): void {
		let dragging = false;
		let startY = 0;
		let startHeight = 0;

		const onMouseDown = (e: MouseEvent) => {
			dragging = true;
			startY = e.clientY;
			startHeight = memSection.getBoundingClientRect().height;
			dragHandle.style.background = '#3794ff';
			document.body.style.userSelect = 'none';
			document.body.style.cursor = 'row-resize';
			e.preventDefault();
		};

		const onMouseMove = (e: MouseEvent) => {
			if (!dragging) { return; }
			const delta = startY - e.clientY; // 向上拖 = 扩大记忆库
			const newHeight = Math.max(60, Math.min(startHeight + delta, 600));
			memSection.style.height = `${newHeight}px`;
			memSection.style.flex = '0 0 auto';
		};

		const onMouseUp = () => {
			if (!dragging) { return; }
			dragging = false;
			dragHandle.style.background = '#2a2a2a';
			document.body.style.userSelect = '';
			document.body.style.cursor = '';
		};

		dragHandle.addEventListener('mousedown', onMouseDown);
		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
	}

	/**
	 * 渲染记忆库列表：点击展开 MemoryDetailEditorPane 在中间栏编辑。
	 * Memory 数据由 MemoryDetailEditorPane 独立管理；此处仅提供快捷入口。
	 */
	private _renderMemoryList(): void {
		if (!this._memSectionBody || !this._memList) { return; }

		this._memSectionBody.replaceChildren();
		const list = this._memList;
		list.replaceChildren();
		list.style.cssText = 'padding:4px 0;';

		// 点击入口块 — 打开 MemoryDetailEditorPane
		const entry = $('div.kb-mem-entry');
		entry.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;font-size:12px;margin:4px 8px;border-radius:4px;background:#1e1e1e;border:1px solid #2a2a2a;';
		entry.onclick = () => this._openMemoryDetailEditor();
		entry.onmouseenter = () => { entry.style.background = '#252525'; entry.style.borderColor = '#3a3a3a'; };
		entry.onmouseleave = () => { entry.style.background = '#1e1e1e'; entry.style.borderColor = '#2a2a2a'; };

		const entryIcon = $('span');
		entryIcon.textContent = '🧠';
		entryIcon.style.cssText = 'font-size:18px;flex-shrink:0;';
		entry.appendChild(entryIcon);

		const entryText = $('div');
		entryText.style.cssText = 'flex:1;min-width:0;';
		const entryTitle = $('div');
		entryTitle.textContent = '查看完整记忆';
		entryTitle.style.cssText = 'color:#ddd;';
		entryText.appendChild(entryTitle);
		const entryMeta = $('div');
		entryMeta.textContent = '点击打开 MemoryDetailEditorPane';
		entryMeta.style.cssText = 'font-size:10px;color:#555;margin-top:2px;';
		entryText.appendChild(entryMeta);
		entry.appendChild(entryText);

		const entryArrow = $('span');
		entryArrow.textContent = '→';
		entryArrow.style.cssText = 'color:#555;font-size:14px;flex-shrink:0;';
		entry.appendChild(entryArrow);

		list.appendChild(entry);

		// 固定槽位概览
		const slotsHint = $('div');
		slotsHint.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:6px 8px;';
		const slotNames = ['persona', 'user_preferences', 'tool_guidelines', 'project_context',
			'guidance', 'pending_items', 'session_patterns', 'self_notes'];
		for (const slot of slotNames) {
			const tag = $('span');
			tag.textContent = slot.replace(/_/g, ' ');
			tag.style.cssText = 'font-size:9px;background:#222;color:#666;border-radius:3px;padding:2px 6px;';
			slotsHint.appendChild(tag);
		}
		list.appendChild(slotsHint);

		this._memSectionBody.appendChild(list);
	}

	/** 打开「记忆库」编辑器面板（Memory Detail Editor Pane）。 */
	private _openMemoryDetailEditor(): void {
		try {
			const agentId = this.modelSelectorService.getSelectedAgentId() ?? 'default';
			const input = MemoryDetailEditorInput.getOrCreate(agentId);
			void this.editorService.openEditor(input, { pinned: true });
		} catch (err) {
			this.logService.error(`[KB] failed to open MemoryDetailEditorPane: ${err}`);
		}
	}

	/** 打开「代码库」编辑器面板（Codebase Memory Detail Editor Pane）。 */
	private _openCodebaseDetailEditor(): void {
		try {
			const input = CodebaseMemoryDetailEditorInput.getOrCreate();
			void this.editorService.openEditor(input, { pinned: true });
		} catch (err) {
			this.logService.error(`[KB] failed to open CodebaseDetailEditorPane: ${err}`);
		}
	}

	private _onGlobalClick = () => {
		this._vaultMenu.classList.remove('show');
		// 从视图根元素查找所有下拉（包括 positionDropdown 挂到 this.element 上的）
		(this.element as HTMLElement).querySelectorAll('.kb-dropdown.show').forEach(d => d.classList.remove('show'));
	};

	// layoutBody / focus — 定义在原文件尾部（覆盖原生树 layout）

	// ═══════════════════════════════════════════════════════════
	//  Vault lifecycle
	// ═══════════════════════════════════════════════════════════

	private async initVaults(): Promise<void> {
		this._vaults = this.loadVaults();
		const activeId = this.storageService.get(STORAGE_ACTIVE, StorageScope.APPLICATION);
		this._activeVault = this._vaults.find(v => v.id === activeId && !v.closed) ?? this._vaults.find(v => !v.closed);

		if (!this._activeVault) {
			// 首次使用：创建一个默认 Vault（对齐 SiYuan 首次启动的默认笔记本）
			await this.createVault('我的知识库', '📚');
			return;
		}

		await this.activateVault(this._activeVault);
	}

	/** 已确认文件夹存在的 Vault ID 集合（避免重复 createFolder IPC 调用）。 */
	private _vaultFoldersReady = new Set<string>();

	private async ensureVaultFolders(v: IKbVault): Promise<void> {
		if (this._vaultFoldersReady.has(v.id)) { return; }
		try {
			const root = this.vaultUri(v);
			const lib = this.sectionUri(v, 'library');
			const notes = this.sectionUri(v, 'notes');
			// Only create folders that don't already exist — createFolder is a
			// heavy IPC call even when the folder already exists on disk.
			if (!await this.fileService.exists(root)) { await this.fileService.createFolder(root); }
			if (!await this.fileService.exists(lib))  { await this.fileService.createFolder(lib); }
			if (!await this.fileService.exists(notes)) { await this.fileService.createFolder(notes); }
			this._vaultFoldersReady.add(v.id);
		} catch (err) {
			this.logService.warn(`[KB] ensureVaultFolders failed (will retry on demand): ${err}`);
		}
	}

	private async activateVault(v: IKbVault): Promise<void> {
		const t0 = performance.now();
		this.logService.info(`[KB DEBUG] activateVault(${v?.name}) called; v.linkedFolders=${(v as any)?.linkedFolders?.length ?? -1}; v.id=${v?.id}; stack=${(new Error()).stack}`);
		this._activeVault = v;
		this.storageService.store(STORAGE_ACTIVE, v.id, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._searchDirty = true;
		this._sortMode = this.loadSort(v.id);
		this._expandedFolders = new Set();
		await this.ensureVaultFolders(v);
		const t1 = performance.now();
		this.renderAll();
		this.logService.info(`[KB perf] activateVault(${v.name}): ensureFolders=${(t1 - t0).toFixed(1)}ms, renderAll=${(performance.now() - t1).toFixed(1)}ms, total=${(performance.now() - t0).toFixed(1)}ms`);
	}

	/** B 档「事件中枢」：vault 文件变化（库/笔记分区）→ debounce 后按真实变更 URI 做靶向增量刷新 + 重建确定性导航。 */
	private _onVaultFilesChange(e: FileChangesEvent): void {
		const v = this._activeVault;
		if (!v) { return; }
		const notes = this.sectionUri(v, 'notes');
		const lib = this.sectionUri(v, 'library');
		if (!e.affects(notes) && !e.affects(lib)) { return; }
		if (this._kbRefreshHandle !== undefined) { clearTimeout(this._kbRefreshHandle); }
		this._kbRefreshHandle = setTimeout(() => {
			this._kbRefreshHandle = undefined;
			// 重命名进行中跳过视图刷新，保护内联重命名输入框（逻辑态，非 hack）。
			// 其余一律走 _reloadForFileChanges 的靶向增量刷新——与显式操作共用 _reloadChildren，
			// 不再整段 replaceChildren 重建，因此无需「抑制窗」去重。
			if (this._renameActive) {
				this.logService.info('[KB] vault file change → skip (rename in progress)');
			} else {
				this.logService.info('[KB] vault file change detected → targeted incremental refresh');
				void this._reloadVisible(notes, lib);
			}
			void KbImportController.maintainKbNavigation(this.fileService, lib);
			// 触发思维导图自动生成（独立 30 秒防抖，避免频繁 LLM 调用）
			if (e.affects(lib)) {
				this._scheduleMindmapGeneration();
			}
		}, 300);
	}

	/**
	 * B 档「事件中枢」核心：vault 文件变化后做增量刷新——只重列「分区顶层」与「当前已展开的每个目录」，
	 * 替代原先「整段 refreshSection 重建 + 抑制窗去重」的粗暴做法。
	 * - 顶层重载由 _reloadChildren(null) 完成，保留关联文件夹行与已展开子树 DOM；
	 * - 每个已展开目录单独 _reloadChildren(path)，重列其直接子节点并复用更深层已展开子树
	 *   （preserved 机制，等价于 loadSectionTree 的展开恢复，但开销仅为「若干次单目录 listChildren」）；
	 * - 折叠（未展开）目录内的变化不在 DOM 中呈现，故跳过（与 Explorer 一致），用户展开时自然拉取最新。
	 * 全程走 _reloadChildren，绝不做 refreshSection 整段重建，因此不再需要「抑制窗」去重。
	 * 注：关联文件夹的内部内容在 watch 路径下不单独重载（其节点本身随顶层刷新），外部直改关联目录文件时
	 * 以显式 KB 操作或手动刷新为准——与本项目「KB 视图自身操作为主」的使用模型一致。
	 */
	private async _reloadVisible(notes: URI, lib: URI): Promise<void> {
		const run = async (section: KbSection) => {
			const toReload = new Set<string | null>([null]); // 顶层
			for (const p of this._expandedFolders) {
				const sec = this.sectionOfPath(p);
				if (sec === section) { toReload.add(p); }
			}
			for (const key of toReload) { await this._reloadChildren(section, key); }
		};
		await run('notes');
		await run('library');
	}

	/** 多选 .canvas 文件：合并为一个思维导图。 */
	private async _mergeCanvasFiles(files: IKbNode[]): Promise<void> {
		if (files.length < 2) { return; }
		try {
			if (!this._mindmapGenerator) {
				this._mindmapGenerator = new KbMindmapGenerator(this.fileService, this.logService);
			}
			// 委托生成器：读取全部 → 按内容去重合并 → 重排为思维导图 → 写入首个并删除其余
			const finalUri = await this._mindmapGenerator.mergeMindmaps(files.map(f => f.uri));
			if (!finalUri) {
				this.notificationService.warn('无法合并：需要至少 2 个有效的思维导图文件');
				return;
			}
			this.notificationService.info(`已合并 ${files.length} 个思维导图为思维导图`);
			await this.refreshSection('notes');
		} catch (err) {
			this.logService.warn(`[mindmap] merge failed: ${err}`);
			this.notificationService.warn(`合并思维导图失败: ${err}`);
		}
	}

	/** 补充/完善单个思维导图：让 LLM 在保留现有节点基础上改进描述并补充缺失概念。 */
	private async _supplementMindmap(node: IKbNode): Promise<void> {
		if (!node.name.endsWith('.canvas')) { return; }
		const chatModel = await this._getOrCreateChatModel();
		if (!chatModel) {
			this.notificationService.warn('未获取到 LLM 模型，无法补充思维导图');
			return;
		}
		if (!this._mindmapGenerator) {
			this._mindmapGenerator = new KbMindmapGenerator(this.fileService, this.logService);
		}
		try {
			this.notificationService.info('正在补充/完善思维导图…');
			const finalUri = await this._mindmapGenerator.refineMindmap(chatModel, node.uri);
			if (!finalUri) {
				this.notificationService.warn('该思维导图内容为空，无法补充');
				return;
			}
			await this.refreshSection('notes');
			this.notificationService.info('已补充/完善思维导图');
		} catch (err) {
			this.logService.warn(`[mindmap] refine failed: ${err}`);
			this.notificationService.warn(`补充思维导图失败: ${err}`);
		}
	}

	/** 按内容优化思维导图文件命名：用 LLM 建议的简短主题名（回退到内容推导）重命名。 */
	private async _optimizeMindmapName(node: IKbNode): Promise<void> {
		if (!node.name.endsWith('.canvas')) { return; }
		if (!this._mindmapGenerator) {
			this._mindmapGenerator = new KbMindmapGenerator(this.fileService, this.logService);
		}
		try {
			const data = await this._mindmapGenerator.readMindmap(node.uri);
			if (!data || data.nodes.length === 0) {
				this.notificationService.warn('该思维导图为空，无法生成名称');
				return;
			}
			// 1) 优先用 LLM 建议的简短主题名；2) 否则回退到确定性内容推导
			let newName = this._mindmapGenerator.deriveMindmapTitle(data);
			const chatModel = await this._getOrCreateChatModel();
			if (chatModel) {
				const suggested = await this._mindmapGenerator.suggestMindmapTitle(chatModel, data);
				if (suggested) { newName = suggested; }
			}
			if (newName === node.name) {
				this.notificationService.info(`名称已符合内容：「${node.name}」`);
				return;
			}
			let target = URI.joinPath(node.uri, '..', newName);
			let i = 2;
			while (await this.fileService.exists(target)) {
				const base = newName.replace(/\.canvas$/, '');
				target = URI.joinPath(node.uri, '..', `${base}-${i}.canvas`);
				i++;
			}
			await this.workingCopyFileService.move(
				[{ file: { source: node.uri, target } }],
				CancellationToken.None,
			);
			this._pushKbUndoElement(
				localize('kb.undoRenameCanvas', '重命名思维导图「{0}」为「{1}」', node.name, newName),
				'kb.rename',
				[node.uri, target],
				async () => { try { await this.workingCopyFileService.move([{ file: { source: target, target: node.uri } }], CancellationToken.None, { isUndoing: true }); } catch (e) { this.logService.warn(`[KB-Undo] rename-back failed: ${e}`); } await this.refreshSection('notes'); },
				async () => { try { await this.workingCopyFileService.move([{ file: { source: node.uri, target } }], CancellationToken.None); } catch (e) { this.logService.warn(`[KB-Redo] rename failed: ${e}`); } await this.refreshSection('notes'); },
			);
			await this.refreshSection('notes');
			this.notificationService.info(`已按内容重命名：「${node.name}」→「${newName}」`);
		} catch (err) {
			this.logService.warn(`[mindmap] rename failed: ${err}`);
			this.notificationService.warn(`重命名失败: ${err}`);
		}
	}

	/** 首次打开视图时检查：可能存在视图关闭期间完成的导入。 */
	private _scheduleMindmapGenerationOnInit(): void {
		if (!this._activeVault) { return; }
		// 2 秒延迟，确保 KbImportController 的 _openKbViewAndNavigate 已打开导航
		setTimeout(() => { this._scheduleMindmapGeneration(); }, 2_000);
	}

	/** 思维导图自动生成防抖调度（30 秒窗口合并）。 */
	private _scheduleMindmapGeneration(): void {
		if (this._mindmapDebounceTimer !== undefined) { clearTimeout(this._mindmapDebounceTimer); }
		this._mindmapDebounceTimer = setTimeout(() => {
			this._mindmapDebounceTimer = undefined;
			void this._generateMindmapAfterImport();
		}, 30_000);
	}

	private async createVault(name: string, icon = '📚'): Promise<void> {
		this.logService.info(`[KB DEBUG] createVault called name=${name}; existingActiveVault=${(this._activeVault as any)?.id ?? 'none'}; _vaults.length=${this._vaults?.length ?? -1}; stack=${(new Error()).stack}`);
		const vault: IKbVault = {
			id: newVaultId(),
			name,
			icon,
			sort: this._vaults.length,
			sortMode: 'createdASC',
			closed: false,
			path: '',
		};
		vault.path = this.vaultUri(vault).fsPath;
		this._vaults.push(vault);
		this.saveVaults();
		await this.ensureVaultFolders(vault);
		await this.activateVault(vault);
		this.notificationService.info(localize('kb.vaultCreated', '已创建知识库：{0}', name));
		void this._logOp('vault.create', 'success', { target: vault.path, detail: { name, icon: vault.icon } });
	}

	private async removeVault(v: IKbVault): Promise<void> {
		const confirm = await this.dialogService.confirm({
			message: localize('kb.removeVault', '确定删除知识库「{0}」及其全部内容？', v.name),
			primaryButton: localize('kb.delete', '删除'),
		});
		if (!confirm.confirmed) { return; }
		const path = this.vaultUri(v).fsPath;
		await this.fileService.del(this.vaultUri(v), { recursive: true });
		this._vaults = this._vaults.filter(x => x.id !== v.id);
		this.saveVaults();
		void this._logOp('vault.delete', 'success', { target: path, detail: { name: v.name } });
		this._activeVault = this._vaults.find(x => !x.closed);
		if (this._activeVault) {
			await this.activateVault(this._activeVault);
		} else {
			this._scroll.replaceChildren();
			this.renderVaultBar();
		}
	}

	private async renameVault(v: IKbVault, newName: string): Promise<void> {
		const oldName = v.name;
		v.name = newName;
		this.saveVaults();
		this.renderVaultBar();
		void this._logOp('vault.rename', 'success', { target: v.path, detail: { from: oldName, to: newName } });
	}

	// ═══════════════════════════════════════════════════════════
	//  Full render
	// ═══════════════════════════════════════════════════════════

	private renderAll(): void {
		this._renderAllCount++;
		const callId = this._renderAllCount;
		const t0 = performance.now();
		// 重建前清除搜索态
		if (this._searchInput) { this._searchInput.value = ''; }
		this._searchToken++;
		this.renderVaultBar();
		this._scroll.replaceChildren();
		if (this._viewMode === 'recent') {
			this.renderRecentView();
		} else {
			this._scroll.appendChild(this.renderSection('library'));
			this._scroll.appendChild(this.renderSection('notes'));
		}
		this.renderBacklinksPanel();
		// 填充 section body 内容（DOM 是当前主可见内容）
		void this.refreshSection('library');
		void this.refreshSection('notes');
		// 标签分类区块（设计图：单一可折叠标题，内含 标签搜索 + 分组列表）
		this._scroll.appendChild(this.renderTagClassificationSection());
		const _lf = this._activeVault?.linkedFolders?.length ?? -1;
		const _ws = this._activeVault?.linkedWorkspaces?.length ?? -1;
		this.logService.info(`[KB perf] renderAll #${callId} total: ${(performance.now() - t0).toFixed(1)}ms linkedFolders=${_lf} linkedWS=${_ws}`);
		// 诊断：运行时 linkedFolders 被清空时，抓取调用栈与 _vaults 状态以定位重置来源
		if (_lf === 0) {
			const _vaultsInfo = (this._vaults ?? []).map(v => `${v.id}:lf=${v.linkedFolders?.length ?? 0},ws=${v.linkedWorkspaces?.length ?? 0},closed=${!!v.closed}`).join(' | ');
			const _sameRef = this._vaults?.[0] === this._activeVault;
			this.logService.info(`[KB renderAll DEBUG] empty linkedFolders at #${callId}; activeVaultId=${this._activeVault?.id}; activeSameAsVaults0=${_sameRef}; _vaults.length=${this._vaults?.length ?? -1}; _vaults=[${_vaultsInfo}]; stack=${(new Error()).stack}`);
		}
	}

	// ═══════════════════════════════════════════════════════════
	//  标签分类区块（设计图：单一可折叠标题 → 标签搜索 + 分组列表）
	// ═══════════════════════════════════════════════════════════

	/** 标签分类区块：单一可折叠标题「🏷️ 标签分类」，内部含标签搜索（联想下拉 + 清除）与按标签分组的文档列表，#无标签 兜底。 */
	private renderTagClassificationSection(): HTMLElement {
		const sec = $('div.kb-section.kb-tagclass');
		if (this._tagClassOpen) { sec.classList.add('open'); }

		// ── 标题（可折叠） ──
		const header = $('div.kb-section-header');
		const arrow = $('span.kb-arrow'); arrow.textContent = '▶';
		const title = $('div.kb-title');
		const cat = $('span.kb-cat'); cat.textContent = '🏷️';
		const titleText = $('span'); titleText.textContent = '标签分类';
		const andBadge = $('span.kb-and-badge'); andBadge.textContent = '交集 AND';
		const countBadge = $('span.kb-count');
		title.replaceChildren(cat, titleText, andBadge, countBadge);
		header.append(arrow, title);
		header.onclick = () => {
			this._tagClassOpen = !this._tagClassOpen;
			sec.classList.toggle('open', this._tagClassOpen);
		};
		sec.append(header);

		const body = $('div.kb-section-body');

		// ① 标签搜索（位于分类内部：联想下拉 + 清除，实时过滤分组，不跳转）
		const searchRow = $('div.kb-tag-search');
		const box = $('div.kb-search-box');
		const searchIco = $('span'); searchIco.textContent = '🔍';
		const input = $('input') as HTMLInputElement;
		input.type = 'text';
		input.placeholder = '搜索标签…';
		input.autocomplete = 'off';
		const clearBtn = $('span.kb-search-clear'); clearBtn.textContent = '✕';
		clearBtn.style.display = 'none';
		box.append(searchIco, input, clearBtn);
		searchRow.append(box);
		const suggest = $('div.kb-suggest');
		searchRow.append(suggest);
		body.append(searchRow);

		// ② 标签分组列表
		const groupsEl = $('div.kb-tag-groups');
		body.append(groupsEl);

		sec.append(body);

		// ── 渲染分组（按搜索词过滤） ──
		const doRender = () => {
			const q = input.value.trim().toLowerCase();
			const tags = this._index.getAllTags()
				.filter(t => !q || t.tag.toLowerCase().includes(q))
				.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'));
			const untagged = q ? [] : this._index.getUntaggedDocs();
			groupsEl.replaceChildren();
			countBadge.textContent = String(tags.length + (untagged.length ? 1 : 0));
			if (tags.length === 0 && untagged.length === 0) {
				const empty = $('div.kb-empty-inline');
				empty.textContent = q ? '无匹配标签' : '暂无标签（在笔记中使用 #标签# 格式即可创建标签）';
				groupsEl.append(empty);
				return;
			}
			for (const t of tags) {
				groupsEl.append(this.renderTagGroup(t.tag, t.count));
			}
			if (untagged.length > 0) {
				groupsEl.append(this.renderTagGroup('无标签', untagged.length, untagged));
			}
		};

		// ── 联想下拉 ──
		const runSuggest = () => {
			const q = input.value.trim().toLowerCase();
			suggest.replaceChildren();
			if (!q) { suggest.classList.remove('show'); return; }
			const hits = this._index.searchTagsByPrefix(q).slice(0, 12);
			if (hits.length === 0) {
				const empty = $('div.kb-sug-empty'); empty.textContent = '无匹配标签';
				suggest.append(empty);
			} else {
				for (const tag of hits) {
					const cnt = this._index.getAllTags().find(x => x.tag.toLowerCase() === tag.toLowerCase())?.count ?? 0;
					const s = $('div.kb-sug');
					const ico = $('span.s-ico'); ico.textContent = '🏷️';
					const name = $('span.s-name'); name.textContent = `#${tag}`;
					const kind = $('span.s-kind'); kind.textContent = '标签';
					const cntEl = $('span.s-cnt'); cntEl.textContent = `${cnt} 篇`;
					s.append(ico, name, kind, cntEl);
					s.onmousedown = (e) => {
						e.preventDefault(); // 防止 input 失焦导致下拉先收起
						input.value = `#${tag}`;
						clearBtn.style.display = 'inline';
						doRender();
						suggest.classList.remove('show');
					};
					suggest.append(s);
				}
			}
			suggest.classList.add('show');
		};

		input.oninput = () => {
			clearBtn.style.display = input.value ? 'inline' : 'none';
			doRender();
			runSuggest();
		};
		clearBtn.onclick = () => {
			input.value = '';
			clearBtn.style.display = 'none';
			doRender();
			suggest.classList.remove('show');
			input.focus();
		};
		input.onblur = () => { setTimeout(() => suggest.classList.remove('show'), 100); };

		doRender();
		return sec;
	}

	/** 单个标签分组（可折叠），列出命中文档；untaggedDocs 透传用于「#无标签」兜底分组。 */
	private renderTagGroup(tag: string, count: number, untaggedDocs?: IKbSearchHit[]): HTMLElement {
		const group = $('div.kb-tag-group');
		const head = $('div.kb-tag-group-head');
		const gArrow = $('span.kb-arrow'); gArrow.textContent = '▶';
		const gName = $('span.kb-tag-group-name'); gName.textContent = tag === '无标签' ? '#无标签' : `#${tag}`;
		const gCount = $('span.kb-count'); gCount.textContent = `${count} 篇`;
		head.append(gArrow, gName, gCount);
		const gBody = $('div.kb-tag-group-body');
		head.onclick = () => { group.classList.toggle('open'); };
		group.append(head, gBody);

		const hits = untaggedDocs ?? this._index.searchByTag(tag, 200);
		for (const hit of hits) {
			const row = $('div.kb-tag-doc');
			const ico = this._fileIconEl(hit);
			const nm = $('span.kb-tag-doc-name'); nm.textContent = hit.name;
			row.append(ico, nm);
			row.onclick = () => this.openInEditor(hit);
			gBody.append(row);
		}
		return group;
	}

	/** 反链面板容器（始终存在，选中文件时填充；搜索态隐藏）。 */
	private renderBacklinksPanel(): void {
		let el = this._scroll.querySelector('.kb-backlinks') as HTMLElement | null;
		if (!el) {
			el = $('div.kb-backlinks');
			this._backlinksEl = el;
		} else {
			this._backlinksEl = el;
		}
		el.replaceChildren();
		const hint = $('div.kb-bl-hint'); hint.textContent = '选择一个文件以查看双链（出链 / 反链）';
		el.appendChild(hint);
		this._scroll.appendChild(el);
	}

	private renderVaultBar(): void {
		this._vaultBar.replaceChildren();
		const icon = $('span.kb-vault-icon');
		icon.textContent = this._activeVault?.icon ?? '📚';
		const select = $('div.kb-vault-select');
		const name = $('span.kb-vname');
		name.textContent = this._activeVault?.name ?? '—';
		const caret = $('span.kb-caret'); caret.textContent = '▼';
		select.append(icon, name, caret);
		select.onclick = (e) => { e.stopPropagation(); this.toggleVaultMenu(); };
		this._vaultBar.appendChild(select);

		// 「记忆库」按钮：打开 MemoryDetailEditorPane（替代原 activity-bar Memory 入口）
		const memBtn = $('span.kb-abtn');
		memBtn.textContent = '🧠';
		memBtn.title = '记忆库（打开 Memory Detail Editor Pane）';
		memBtn.style.cssText = 'margin-left:6px;cursor:pointer;';
		memBtn.onclick = (e) => { e.stopPropagation(); this._openMemoryDetailEditor(); };
		this._vaultBar.appendChild(memBtn);

		// 视图切换按钮：文件树 → 标签云 → 最近编辑
		const viewBtn = $('span.kb-abtn');
		const viewLabels: Record<string, string> = { tree: '📂', recent: '🕐' };
		const viewTitles: Record<string, string> = { tree: '文件树视图', recent: '最近编辑' };
		viewBtn.textContent = viewLabels[this._viewMode];
		viewBtn.title = viewTitles[this._viewMode];
		viewBtn.onclick = () => {
			const seq: Array<'tree' | 'recent'> = ['tree', 'recent'];
			const i = seq.indexOf(this._viewMode);
			this._viewMode = seq[(i + 1) % seq.length];
			this.renderAll();
		};
		this._vaultBar.appendChild(viewBtn);

		const newBtn = $('span.kb-abtn'); newBtn.textContent = '＋'; newBtn.title = '新建知识库';
		newBtn.onclick = async () => {
		const r = await this.dialogService.input({ message: localize('kb.newVault', '新建知识库名称'), inputs: [{ value: '我的知识库' }] });
		const name = r.values?.[0]?.trim();
		if (r.confirmed && name) { await this.createVault(name); }
		};
		this._vaultBar.appendChild(newBtn);

		const moreBtn = $('span.kb-abtn'); moreBtn.textContent = '⋯'; moreBtn.title = '更多';
		moreBtn.onclick = (e) => { e.stopPropagation(); this.toggleVaultMenu(); };
		this._vaultBar.appendChild(moreBtn);

		this.renderVaultMenu();
	}

	private renderVaultMenu(): void {
		this._vaultMenu.replaceChildren();
		const open = this._vaults.filter(v => !v.closed);
		const closed = this._vaults.filter(v => v.closed);

		const grpOpen = $('div.kb-grp'); grpOpen.textContent = '当前知识库'; this._vaultMenu.appendChild(grpOpen);
		for (const v of open) {
			this._vaultMenu.appendChild(this.vaultMenuItem(v, true));
		}
		if (closed.length) {
			const grpC = $('div.kb-grp'); grpC.textContent = '已关闭'; this._vaultMenu.appendChild(grpC);
			for (const v of closed) {
				this._vaultMenu.appendChild(this.vaultMenuItem(v, false));
			}
		}
		const divider = $('div.kb-divider'); this._vaultMenu.appendChild(divider);
		const cfg = $('div.kb-opt.add');
		safeSetInnerHtml(cfg, '<span>＋</span><span>配置文件夹为知识库…</span>');
		cfg.onclick = (e) => { e.stopPropagation(); this._vaultMenu.classList.remove('show'); void this.configFolderAsVault(); };
		this._vaultMenu.appendChild(cfg);
	}

	private vaultMenuItem(v: IKbVault, isOpen: boolean): HTMLElement {
		const opt = $('div.kb-opt');
		const check = $('span.kb-check'); check.textContent = (this._activeVault?.id === v.id) ? '✓' : '';
		const ic = $('span'); ic.textContent = v.icon;
		const nm = $('span'); nm.textContent = v.name;
		const path = $('span.kb-path'); path.textContent = v.path;
		opt.append(check, ic, nm, path);
		opt.onclick = (e) => {
			e.stopPropagation();
			this._vaultMenu.classList.remove('show');
			if (isOpen) {
				if (this._activeVault?.id !== v.id) { void this.activateVault(v); }
			} else {
				v.closed = false; this.saveVaults(); void this.activateVault(v);
			}
		};
		// right-click: rename / close / delete
		opt.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.vaultContextMenu(v, e); };
		return opt;
	}

	private toggleVaultMenu(): void {
		this._vaultMenu.classList.toggle('show');
	}

	private vaultContextMenu(v: IKbVault, ev?: MouseEvent): void {
		const actions: IAction[] = [
			new Action('kb.vaultRename', '重命名', undefined, true, async () => {
				const r = await this.dialogService.input({ message: '重命名知识库', inputs: [{ value: v.name }] });
				const nm = r.values?.[0]?.trim(); if (r.confirmed && nm) { await this.renameVault(v, nm); }
			}),
			new Action('kb.vaultToggle', v.closed ? '打开' : '关闭', undefined, true, () => {
				v.closed = !v.closed; this.saveVaults(); this.renderVaultMenu();
				if (v.closed && this._activeVault?.id === v.id) {
					this._activeVault = this._vaults.find(x => !x.closed);
					if (this._activeVault) { void this.activateVault(this._activeVault); }
				}
			}),
			new Separator(),
			new Action('kb.vaultLint', '体检（结构校验）', undefined, true, () => { void this._runLint(v); }),
			new Action('kb.vaultRouteLint', '隔离低质笔记（人环）', undefined, true, () => { void this._routeLintToReview(v); }),
			new Action('kb.vaultDedup', '整理去重', undefined, true, () => { void this._runDedup(v); }),
			new Action('kb.vaultReview', '审核队列…', undefined, true, () => { void this._showReviewQueue(v); }),
			new Separator(),
			new Action('kb.vaultDelete', '删除', undefined, true, () => { void this.removeVault(v); }),
		];
		const anchor = ev ? { x: ev.clientX, y: ev.clientY } : { x: 100, y: 100 };
		this.contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
	}

	/** P2-1 审核队列入口：列出 .review/ 待审核笔记，支持移回笔记根 / 清空。 */
	private async _showReviewQueue(v: IKbVault): Promise<void> {
		const vaultRoot = this.vaultUri(v);
		const notes = await listReviewNotes(this.fileService, vaultRoot);
		if (notes.length === 0) { this.notificationService.info('审核队列为空'); return; }
		const notesDir = this.sectionUri(v, 'notes');
		const items: { label: string; run: () => void }[] = notes.map(n => {
			const name = n.path.split('/').pop() ?? 'note.md';
			return { label: `↩ 移回：${name}`, run: () => { void this._approveReview(v, name, notesDir); } };
		});
		items.push({ label: `🗑 清空审核队列（${notes.length} 篇）`, run: () => { void this._discardAllReview(v); } });
		this.showSimpleMenu(items);
	}

	/** P2-1 回流：确认审核——把 .review/<name> 移回笔记根（destDir=notesDir，用户后续可归类）。 */
	private async _approveReview(v: IKbVault, name: string, notesDir: URI): Promise<void> {
		const vaultRoot = this.vaultUri(v);
		const libDir = this.sectionUri(v, 'library');
		try {
			await approveReviewNote(this.fileService, vaultRoot, name, notesDir);
			await KbImportController.appendKbLog(this.fileService, libDir, `确认审核移回：${name}`);
			await KbImportController.maintainKbNavigation(this.fileService, libDir);
			await this.refreshSection('notes');
			this.notificationService.info(`已移回笔记根：${name}`);
		} catch (err) { this.notificationService.error('移回失败：' + String(err)); }
	}

	/** P2-1：清空审核队列（删除全部待审核笔记，需确认）。 */
	private async _discardAllReview(v: IKbVault): Promise<void> {
		const vaultRoot = this.vaultUri(v);
		const notes = await listReviewNotes(this.fileService, vaultRoot);
		if (notes.length === 0) { return; }
		const confirm = await this.dialogService.confirm({ message: `确定删除审核队列全部 ${notes.length} 篇待审核笔记？此操作不可撤销。`, primaryButton: '删除' });
		if (!confirm.confirmed) { return; }
		for (const n of notes) { await this.fileService.del(n, { recursive: true }).catch(() => undefined); }
		const libDir = this.sectionUri(v, 'library');
		await KbImportController.appendKbLog(this.fileService, libDir, `清空审核队列：${notes.length} 篇`);
		this.notificationService.info(`已清空审核队列（${notes.length} 篇）`);
	}

	/** P3-2 视图入口：跑确定性结构校验，写 lint-report.md 并通知。扫描根为 `库/`（笔记与源文件混居）。 */
	private async _runLint(v: IKbVault): Promise<void> {
		const libDir = this.sectionUri(v, 'library');
		const notesDir = this.sectionUri(v, 'notes');
		try {
			const issues = await lintVault(this.fileService, libDir);
			const report = formatLintReport(libDir, issues);
			await this.fileService.writeFile(URI.joinPath(notesDir, 'lint-report.md'), VSBuffer.fromString(report));
			await KbImportController.appendKbLog(this.fileService, libDir, `体检：${issues.length} 项问题`);
			await this.refreshSection('notes');
			const cnt = (s: string) => issues.filter(i => i.severity === s).length;
			this.notificationService.info(`知识库体检完成：${issues.length} 项（error ${cnt('error')} / warning ${cnt('warning')} / info ${cnt('info')}），详见 lint-report.md`);
		} catch (err) { this.notificationService.error('体检失败：' + String(err)); }
	}

	/** P1 人环：把体检检出的低质量笔记（阈值 warning）隔离进 `.review/` 审核队列，等待人工确认后回流。 */
	private async _routeLintToReview(v: IKbVault): Promise<void> {
		const libDir = this.sectionUri(v, 'library');
		const vaultRoot = this.vaultUri(v);
		try {
			const issues = await lintVault(this.fileService, libDir);
			const { routed, skipped } = await routeLintToReview(this.fileService, vaultRoot, issues, 'warning');
			await KbImportController.appendKbLog(this.fileService, libDir, `隔离低质笔记：${routed.length} 篇移入审核队列`);
			await this.refreshSection('notes');
			if (routed.length === 0) {
				this.notificationService.info(`无达到隔离阈值（warning）的低质笔记；已跳过 ${skipped} 篇。可在「审核队列…」中查看既有待审核项。`);
			} else {
				this.notificationService.info(`已隔离 ${routed.length} 篇低质笔记到审核队列（阈值 warning）；可在「审核队列…」中人工确认后移回。`);
			}
		} catch (err) { this.notificationService.error('隔离失败：' + String(err)); }
	}

	/** P2-1 视图触发点：将笔记移入审核队列（.review/），原笔记删除。供低质量笔记人工隔离。 */
	private async _moveToReview(node: IKbNode): Promise<void> {
		if (!this._activeVault) { return; }
		const vaultRoot = this.vaultUri(this._activeVault);
		try {
			const content = (await this.fileService.readFile(node.uri)).value.toString();
			const name = node.uri.path.split('/').pop() ?? 'note.md';
			await writeReviewNote(this.fileService, vaultRoot, name, content);
			await this.fileService.del(node.uri, { recursive: true });
			const libDir = this.sectionUri(this._activeVault, 'library');
			await KbImportController.appendKbLog(this.fileService, libDir, `移入审核：${name}`);
			await KbImportController.maintainKbNavigation(this.fileService, libDir);
			await this.refreshSection('notes');
			this.notificationService.info(`已移入审核队列：${name}（位于 .review/，确认后可用 approveReviewNote 移回）`);
		} catch (err) { this.notificationService.error('移入审核失败：' + String(err)); }
	}

	/** P3-1 视图入口：跑去重检测，写 dedup-report.md 并通知（仅检测，不自动合并）。 */
	private async _runDedup(v: IKbVault): Promise<void> {
		const notesDir = this.sectionUri(v, 'notes');
		const libDir = this.sectionUri(v, 'library');
		try {
			const groups = await detectDuplicates(this.fileService, notesDir);
			const report = formatDedupReport(notesDir, groups);
			await this.fileService.writeFile(URI.joinPath(notesDir, 'dedup-report.md'), VSBuffer.fromString(report));
			await KbImportController.appendKbLog(this.fileService, libDir, `整理去重：${groups.length} 组疑似重复`);
			await this.refreshSection('notes');
			this.notificationService.info(`整理去重完成：${groups.length} 组疑似重复（共 ${groups.reduce((s, g) => s + g.notes.length, 0)} 篇），详见 dedup-report.md`);
			// P3-1 合并入口：检测到重复后进入逐组确认合并流程
			if (groups.length > 0) {
				const go = await this.dialogService.confirm({ message: `检测到 ${groups.length} 组疑似重复。是否进入合并流程（逐组确认保留项，自动重写引用）？`, primaryButton: '开始合并', cancelButton: '仅看报告' });
				if (go.confirmed) { await this._runDedupMerge(v, groups); }
			}
		} catch (err) { this.notificationService.error('整理去重失败：' + String(err)); }
	}

	/** P3-1 合并流程：逐组确认保留项（默认首项），确认后调 mergeDuplicates 删除其余并重写引用。 */
	private async _runDedupMerge(v: IKbVault, groups: DedupGroup[]): Promise<void> {
		const notesDir = this.sectionUri(v, 'notes');
		const libDir = this.sectionUri(v, 'library');
		const displayName = (u: URI): string => u.path.split('/').pop()!.replace(/\.(md|markdown)$/i, '');
		let merged = 0;
		for (const g of groups) {
			const keep = g.notes[0];
			const names = g.notes.map(displayName).join(', ');
			const confirm = await this.dialogService.confirm({
				message: `去重组「${g.key}」：保留 ${displayName(keep)}，删除其余 ${g.notes.length - 1} 篇（${names}）并把指向它们的引用重写为 ${displayName(keep)}？`,
				primaryButton: '合并',
				cancelButton: '跳过',
			});
			if (!confirm.confirmed) { continue; }
			const r = await mergeDuplicates(this.fileService, notesDir, g, keep);
			await KbImportController.appendKbLog(this.fileService, libDir, `合并去重「${g.key}」：删 ${r.deleted.length} 篇，重写 ${r.rewritten.length} 篇引用`);
			merged++;
		}
		if (merged > 0) {
			await KbImportController.maintainKbNavigation(this.fileService, libDir);
			await this.refreshSection('notes');
			this.notificationService.info(`已合并 ${merged} 组重复（引用已重写）`);
		} else {
			this.notificationService.info('未合并任何组');
		}
	}

	private async configFolderAsVault(): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('kb.configFolder', '选择文件夹作为知识库'),
			canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
		});
		if (!picked || !picked.length) { return; }
		const folder = picked[0];
		const name = folder.path.split('/').filter(Boolean).pop() || '知识库';
		const vault: IKbVault = {
			id: newVaultId(), name, icon: '📁', sort: this._vaults.length,
			sortMode: 'createdASC', closed: false, path: folder.fsPath, customPath: folder.fsPath,
		};
		this._vaults.push(vault);
		this.saveVaults();
		// 使用外部文件夹：在其下创建 库/笔记 子目录
		await this.ensureVaultFolders(vault);
		await this.activateVault(vault);
		this.notificationService.info(localize('kb.folderConfigured', '已配置文件夹为知识库：{0}', name));
		void this._logOp('vault.configFolder', 'success', { target: folder.fsPath, detail: { name } });
	}

	// ═══════════════════════════════════════════════════════════
	//  Section (库 / 笔记)
	// ═══════════════════════════════════════════════════════════

	private renderSection(section: KbSection): HTMLElement {
		const sec = $('div.kb-section');
		sec.setAttribute('data-section', section);

		const header = $('div.kb-section-header');
		const arrow = $('span.kb-arrow'); arrow.textContent = '▶';
		const title = $('span.kb-title'); title.textContent = section === 'library' ? '库' : '笔记';
		const count = $('span.kb-count'); count.textContent = '...';
		const spacer = $('span.kb-section-spacer');

		const toolbar = $('div.kb-section-toolbar');
		const newFileBtn = $('span.kb-tool-btn'); newFileBtn.textContent = '📄+'; newFileBtn.title = '新建文件';
		newFileBtn.onclick = (e) => { e.stopPropagation(); void this.newFile(section); };
		const newFolderBtn = $('span.kb-tool-btn'); newFolderBtn.textContent = '📁+'; newFolderBtn.title = '新建文件夹';
		newFolderBtn.onclick = (e) => { e.stopPropagation(); void this.newFolder(section); };
		toolbar.append(newFileBtn, newFolderBtn);

		header.append(arrow, title, count, spacer, toolbar);
		header.onclick = () => { sec.classList.toggle('open'); arrow.textContent = sec.classList.contains('open') ? '▼' : '▶'; };
		sec.append(header);

		const body = $('div.kb-section-body');
		body.setAttribute('data-section', section);
		// 拖拽到分区空白处 → 移出到分区根目录
		body.addEventListener('dragover', (ev) => {
			ev.preventDefault();
			body.classList.add('kb-drop-target');
			if (ev.dataTransfer) { ev.dataTransfer.dropEffect = (ev.ctrlKey || ev.altKey) ? 'copy' : 'move'; }
		});
		body.addEventListener('dragleave', () => { body.classList.remove('kb-drop-target'); });
		body.addEventListener('drop', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			body.classList.remove('kb-drop-target');
			const raw = ev.dataTransfer?.getData('application/x-kb-drag');
			if (!raw) { return; }
			try {
				const paths = JSON.parse(raw) as string[];
				const sectionUri = this.sectionUri(this._activeVault!, section);
				const isCopy = ev.ctrlKey || ev.altKey;
				this.logService.info(`[DnD-DOM] drop to section root: ${paths.length} items (mode=${isCopy ? 'copy' : 'move'})`);
				void this._doMoveFiles(paths, { name: section === 'library' ? '库' : '笔记', path: sectionUri.fsPath, uri: sectionUri, isDirectory: true, section, size: 0, mtime: 0, ctime: 0, childCount: 0 }, isCopy ? 'copy' : 'move');
			} catch { /* ignore */ }
		});
		sec.append(body);
		sec.classList.add('open');
		return sec;
	}

	private renderRecentView(): void {
		const sec = $('div.kb-section');
		const header = $('div.kb-section-header');
		const title = $('span.kb-title'); title.textContent = '最近';
		header.appendChild(title);
		sec.appendChild(header);
		const body = $('div.kb-section-body');
		body.textContent = '最近打开的文件将出现在这里…';
		sec.appendChild(body);
		this._scroll.appendChild(sec);
	}

	// ═══════════════════════════════════════════════════════════
	//  Tree
	// ═══════════════════════════════════════════════════════════

	private async loadSectionTree(section: KbSection, body: HTMLElement, countEl: HTMLElement): Promise<void> {
		if (!this._activeVault) { return; }
		const t0 = performance.now();
		body.replaceChildren();
		const loading = $('div.kb-loading'); loading.textContent = '加载中…'; body.appendChild(loading);
		try {
			const sectionUri = this.sectionUri(this._activeVault, section);
			const nodes = await this.listChildren(sectionUri, section);
			body.replaceChildren();
			if (nodes.length === 0) {
				const empty = $('div.kb-empty-inline'); empty.textContent = '暂无内容';
				body.appendChild(empty);
			} else {
				await this._appendNodesChunked(body, nodes, 0);
			}
			// 库分区：追加「已关联文件夹」条目（原位索引，可取消关联）
			if (section === 'library' && this._activeVault?.linkedFolders?.length) {
				// 收集所有工作区分组内的文件夹路径（用于跳过单独渲染）
				const wsFolderSet = new Set<string>();
				const wsGroups = this._activeVault.linkedWorkspaces ?? [];
				for (const w of wsGroups) {
					for (const fp of w.folders) { wsFolderSet.add(fp); }
				}
				this.logService.info(`[KB loadSectionTree] section=${section} linkedFolders=${this._activeVault.linkedFolders.length} wsGroups=${wsGroups.length} standaloneLinked=${this._activeVault.linkedFolders.filter(p => !wsFolderSet.has(p)).length} bodyChildren=${body.children.length} autoExpand="${this._autoExpandWsGroup ?? ''}"`);
				// 先渲染工作区分组节点（可展开，父节点名为 workspace 名称）
				for (const w of wsGroups) {
					const grpEl = this.renderLinkedWorkspaceGroup(w);
					body.appendChild(grpEl);
					this.logService.info(`[KB loadSectionTree] rendered ws group "${w.name}" — el visible=${grpEl.offsetParent !== null} html=${grpEl.outerHTML.substring(0, 120)}`);
				}
				// 再渲染不属于任何工作区分组的单独关联文件夹
				let standaloneRendered = 0;
				for (const p of this._activeVault.linkedFolders) {
					if (!wsFolderSet.has(p)) {
						body.appendChild(this.renderLinkedFolder(p));
						standaloneRendered++;
					}
				}
				if (standaloneRendered > 0) {
					this.logService.info(`[KB loadSectionTree] rendered ${standaloneRendered} standalone linked folders`);
				}
			} else if (section === 'library') {
				this.logService.info(`[KB loadSectionTree] section=library BUT linkedFolders is empty/null — nothing to render`);
			}
			// 统计包含 linked folders/workspace 分组的总节点数
			let linkCount = 0;
			if (section === 'library' && this._activeVault?.linkedFolders?.length) {
				linkCount += (this._activeVault.linkedWorkspaces ?? []).length; // 工作区分组
				const wsFolderSet = new Set<string>();
				for (const w of (this._activeVault.linkedWorkspaces ?? [])) {
					for (const fp of w.folders) { wsFolderSet.add(fp); }
				}
				// 不属任何分组的单独文件夹
				linkCount += this._activeVault.linkedFolders.filter(p => !wsFolderSet.has(p)).length;
			}
			countEl.textContent = String(this.countNodes(section, nodes) + linkCount);
			this.logService.info(`[KB loadSectionTree] countEl="${countEl.textContent}" (vaultNodes=${nodes.length} + linkCount=${linkCount}) body childNodes after=${body.children.length}`);
			// 恢复已展开文件夹（并行，避免逐个 await 造成的级联抖动；各文件夹写各自容器互不干扰）
			await Promise.all(nodes
				.filter(node => node.isDirectory && this._expandedFolders.has(node.path))
				.map(node => {
					const el = body.querySelector(`.kb-node[data-path="${this.cssEscape(node.path)}"]`);
					return el ? this.expandFolder(el as HTMLElement, node) : Promise.resolve();
				}));
			this.logService.info(`[KB perf] loadSectionTree(${section}): ${(performance.now() - t0).toFixed(1)}ms, ${nodes.length} nodes`);
		} catch (err) {
			this.logService.warn(`[KB] loadSectionTree(${section}) failed after ${(performance.now() - t0).toFixed(1)}ms: ${err}`);
			body.replaceChildren();
			const empty = $('div.kb-empty-inline'); empty.textContent = '加载失败'; body.appendChild(empty);
		}
	}

	private countNodes(_section: KbSection, nodes: IKbNode[]): number {
		// 仅统计顶层数量；如有需要可递归
		return nodes.length;
	}

	/**
	 * C 档虚拟化（rAF 分片渲染）：把大量同级节点的渲染分摊到多个动画帧，
	 * 避免千级节点时主线程被一次性 renderNode 阻塞导致 UI 冻结。
	 * - 容器先清空，再每帧追加 KB_CHUNK_SIZE 个节点；
	 * - 小规模（≤阈值）直接同步追加，省去 rAF 调度开销；
	 * - 返回 Promise 在全部追加完成后 resolve，供调用方 await 以保证后续依赖 DOM 的时序（如恢复展开子树、挂回关联行）。
	 * 注意：调用方若在调用前已捕获需复用的子树引用（如 _reloadChildren 的 preserved），须在其调用本方法前完成捕获——本方法会清空容器。
	 */
	private async _appendNodesChunked(container: HTMLElement, nodes: IKbNode[], depth: number): Promise<void> {
		container.replaceChildren();
		if (nodes.length === 0) { return; }
		if (nodes.length <= KnowledgeBaseViewPane.KB_CHUNK_SIZE) {
			for (const n of nodes) { container.appendChild(this.renderNode(n, depth)); }
			return;
		}
		await new Promise<void>(resolve => {
			let i = 0;
			const step = () => {
				const end = Math.min(i + KnowledgeBaseViewPane.KB_CHUNK_SIZE, nodes.length);
				for (; i < end; i++) { container.appendChild(this.renderNode(nodes[i], depth)); }
				if (i < nodes.length) { requestAnimationFrame(step); }
				else { resolve(); }
			};
			requestAnimationFrame(step);
		});
	}

	private async listChildren(uri: URI, section: KbSection): Promise<IKbNode[]> {
		const t0 = performance.now();
		let stat;
		try {
			stat = await this.fileService.resolve(uri);
		} catch {
			await this.fileService.createFolder(uri);
			stat = await this.fileService.resolve(uri);
		}
		const resolveMs = performance.now() - t0;
		if (!stat.children) { return []; }
		const nodes: IKbNode[] = stat.children.map(c => this.toKbNode(c, section));
		const sorted = this.sortNodes(nodes);
		if (nodes.length > 20 || resolveMs > 200) {
			this.logService.info(`[KB perf] listChildren(${uri.fsPath.slice(-30)}): ${(performance.now() - t0).toFixed(1)}ms (resolve=${resolveMs.toFixed(1)}ms, sort=${(performance.now() - t0 - resolveMs).toFixed(1)}ms, ${nodes.length} items)`);
		}
		return sorted;
	}

	private toKbNode(stat: IFileStat, section: KbSection): IKbNode {
		return {
			name: stat.name,
			path: stat.resource.fsPath,
			uri: stat.resource,
			isDirectory: stat.isDirectory,
			section,
			size: stat.size ?? 0,
			mtime: stat.mtime ?? 0,
			ctime: stat.ctime ?? 0,
			childCount: stat.children?.length ?? 0,
		};
	}

	private sortNodes(nodes: IKbNode[]): IKbNode[] {
		const dirs = nodes.filter(n => n.isDirectory);
		const files = nodes.filter(n => !n.isDirectory);
		const cmp = (a: IKbNode, b: IKbNode): number => {
			switch (this._sortMode) {
				case 'fileNameASC': return a.name.localeCompare(b.name);
				case 'fileNameDESC': return b.name.localeCompare(a.name);
				case 'fileNameNatASC': return this.naturalCompare(a.name, b.name);
				case 'fileNameNatDESC': return this.naturalCompare(b.name, a.name);
				case 'createdASC': return a.ctime - b.ctime;
				case 'createdDESC': return b.ctime - a.ctime;
				case 'modifiedASC': return a.mtime - b.mtime;
				case 'modifiedDESC': return b.mtime - a.mtime;
				case 'docSizeASC': return a.size - b.size;
				case 'docSizeDESC': return b.size - a.size;
				case 'subDocCountASC': return a.childCount - b.childCount;
				case 'subDocCountDESC': return b.childCount - a.childCount;
				case 'custom': return 0;
				default: return a.name.localeCompare(b.name);
			}
		};
		dirs.sort(cmp); files.sort(cmp);
		return [...dirs, ...files];
	}

	private naturalCompare(a: string, b: string): number {
		return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
	}

	/**
	 * 生成与 VS Code Explorer 一致的文件/文件夹图标：使用活动文件图标主题（getIconClasses）。
	 * 元素基础类为 `codicon codicon-file|codicion-folder`（提供 codicon 字形兜底），
	 * 再叠加 getIconClasses 返回的 `file-icon|folder-icon` + 扩展名/语言主题类。
	 * node 只需提供 `uri` 与 `isDirectory`（IKbNode / IKbSearchHit 均满足）。
	 */
	private _fileIconEl(node: { uri: URI; isDirectory: boolean }): HTMLElement {
		const icon = $('span.kb-ficon');
		const fileKind = node.isDirectory ? FileKind.FOLDER : FileKind.FILE;
		const cls = getIconClasses(this.modelService, this.languageService, node.uri, fileKind);
		const baseGlyph = node.isDirectory ? 'codicon-folder' : 'codicon-file';
		icon.className = `kb-ficon codicon ${baseGlyph} ${cls.join(' ')}`;
		return icon;
	}

	private renderNode(node: IKbNode, depth: number): HTMLElement {
		const el = $('div.kb-node');
		el.dataset.path = node.path;
		el.style.paddingLeft = `${6 + depth * 16}px`;
		if (node.isDirectory) { el.classList.add('dir'); }

		const twist = $('span.kb-twist');
		if (node.isDirectory) {
			twist.textContent = this._expandedFolders.has(node.path) ? '▾' : '▸';
			twist.onclick = (e) => { e.stopPropagation(); void this.expandFolder(el, node); };
		} else {
			twist.classList.add('empty');
		}
		el.appendChild(twist);

		const icon = this._fileIconEl(node);
		el.appendChild(icon);

		const name = $('span.kb-name'); name.textContent = node.name;
		el.appendChild(name);

		if (!node.isDirectory) {
			// 库分区中区分「原始来源」与「已建笔记」：构建笔记也落在库分区（库/概念/…），
			// 不能一律按分区显示「未索引」。非 Markdown 来源（html 等）= 未索引（待构建）；
			// .md 笔记（构建产物）= 已建笔记（显示大小）。
			const isRawLib = node.section === 'library' && !/\.(md|markdown)$/i.test(node.name);
			const meta = $('span.kb-meta');
			meta.textContent = isRawLib ? '未索引' : `${this.fmtSize(node.size)}`;
			el.appendChild(meta);
			const status = $('span.kb-status');
			status.classList.add(isRawLib ? 'raw' : 'indexed');
			status.title = isRawLib ? '待构建为笔记' : '已建笔记';
			el.appendChild(status);
		}

		// Actions (hover)
		const actions = $('div.kb-actions');
		const newBtn = $('span.kb-act'); newBtn.textContent = '📄'; newBtn.title = '新建文件';
		newBtn.onclick = (e) => { e.stopPropagation(); void this.newFile(node.section, node); };
		const newFolder = $('span.kb-act'); newFolder.textContent = '📁'; newFolder.title = '新建文件夹';
		newFolder.onclick = (e) => { e.stopPropagation(); void this.newFolder(node.section, node); };
		const renameBtn = $('span.kb-act'); renameBtn.textContent = '✎'; renameBtn.title = '重命名';
		renameBtn.onclick = (e) => { e.stopPropagation(); this.startRename(el, node); };
		const delBtn = $('span.kb-act'); delBtn.textContent = '🗑'; delBtn.title = '删除';
		delBtn.onclick = (e) => { e.stopPropagation(); void this.deleteNode(node); };
		actions.append(newBtn, newFolder, renameBtn, delBtn);
		el.appendChild(actions);

		el.onclick = (e) => {
			if (node.isDirectory) {
				this.selectNode(el, e);
				void this.expandFolder(el, node);
			} else {
				this.selectNode(el, e);
			}
			this._scroll.focus(); // 确保 scroll 获得焦点以接收 Delete/F2 快捷键
		};
		el.ondblclick = () => { if (!node.isDirectory) { this.openInEditor(node); } };
		el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.nodeContextMenu(e, el, node); };

		// ─── DOM 层拖拽支持 ───
		el.draggable = true;
		el.setAttribute('draggable', 'true');
		el.style.userSelect = 'none';
		el.dataset.section = node.section;
		el.addEventListener('dragstart', (ev) => {
			ev.stopPropagation();
			// 若当前项已选中，拖拽所有选中项；否则只拖拽当前一项
			const inSelection = this._domSelectedPaths.has(node.path);
			const draggedPaths = inSelection && this._domSelectedPaths.size > 1
				? Array.from(this._domSelectedPaths) : [node.path];
			ev.dataTransfer?.setData('text/plain', JSON.stringify(draggedPaths));
			ev.dataTransfer?.setData('application/x-kb-drag', JSON.stringify(draggedPaths));
			// 让 VS Code 资源管理器（及系统）识别本次拖拽为真实文件：
			//  - CodeDataTransfers.FILES: fsPath 数组（Explorer 据此做导入/移动）
			//  - DataTransfers.RESOURCES: URI 字符串数组（Explorer 据此解析资源）
			ev.dataTransfer?.setData(CodeDataTransfers.FILES, JSON.stringify(draggedPaths));
			ev.dataTransfer?.setData(DataTransfers.RESOURCES, JSON.stringify(draggedPaths.map(p => URI.file(p).toString())));
			if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'copyMove'; }
			this.logService.info(`[DnD-DOM] dragstart: ${draggedPaths.length} items (inSelection=${inSelection})`);
		});
		el.addEventListener('dragover', (ev) => {
			// 仅文件夹节点拦截 dragover（作为有效放置目标）；
			// 文件节点不拦截，让事件冒泡到 body（分区根）或上层目录节点——否则从文件夹内拖文件到根/其他位置时，
			// 鼠标经过的文件节点会吞掉 dragover 导致浏览器不允许在 body 上 drop。
			if (!node.isDirectory) { return; }
			ev.preventDefault();
			ev.stopPropagation();
			el.classList.add('kb-drop-target');
			if (ev.dataTransfer) { ev.dataTransfer.dropEffect = (ev.ctrlKey || ev.altKey) ? 'copy' : 'move'; }
		});
		el.addEventListener('dragleave', () => { el.classList.remove('kb-drop-target'); });
		el.addEventListener('drop', (ev) => {
			// 同上：仅文件夹节点处理 drop；文件节点让事件冒泡
			if (!node.isDirectory) { return; }
			ev.preventDefault();
			ev.stopPropagation();
			el.classList.remove('kb-drop-target');
			const raw = ev.dataTransfer?.getData('application/x-kb-drag');
			if (!raw) { return; }
			try {
				const paths = JSON.parse(raw) as string[];
				if (paths.includes(node.path)) { return; }
				const isCopy = ev.ctrlKey || ev.altKey;
				this.logService.info(`[DnD-DOM] drop: ${paths.length} items → ${node.name} (mode=${isCopy ? 'copy' : 'move'})`);
				void this._doMoveFiles(paths, node, isCopy ? 'copy' : 'move');
			} catch { /* ignore */ }
		});

		// 构建中提示：若该库文件正在构建笔记，渲染旋转图标
		if (this._buildingPaths.has(node.path)) { this._applyBuildingUi(el, true); }

		return el;
	}

	/** 设置/清除某库文件路径的「构建中」状态，并实时更新已渲染的文档 item。 */
	private _setNodeBuilding(path: string, building: boolean): void {
		if (building) { this._buildingPaths.add(path); }
		else { this._buildingPaths.delete(path); }
		const nodes = this._scroll.querySelectorAll('.kb-node');
		nodes.forEach((n) => {
			const el = n as HTMLElement;
			if (el.dataset.path === path) { this._applyBuildingUi(el, building); }
		});
	}

	/** 在文档 item 上应用/移除「构建中」旋转图标与样式。 */
	private _applyBuildingUi(el: HTMLElement, building: boolean): void {
		let badge = el.querySelector('.kb-building') as HTMLElement | null;
		if (building) {
			el.classList.add('kb-building');
			if (!badge) {
				badge = $('span.kb-building');
				badge.classList.add('codicon', 'codicon-loading');
				badge.title = '正在构建笔记…';
				el.appendChild(badge);
			}
		} else {
			el.classList.remove('kb-building');
			if (badge) { badge.remove(); }
		}
	}

	private async expandFolder(el: HTMLElement, node: IKbNode): Promise<void> {
		const uriKey = node.uri.toString();
		if (this._loadingFolders.has(uriKey)) { return; }
		const twist = el.querySelector('.kb-twist') as HTMLElement;
		const isOpen = this._expandedFolders.has(node.path);

		// 找到 children 容器（紧跟 el 之后的 .kb-children）
		let childrenEl = el.nextElementSibling as HTMLElement | null;
		if (childrenEl && !childrenEl.classList.contains('kb-children')) { childrenEl = null; }

		if (isOpen && childrenEl) {
			// 折叠
			this._expandedFolders.delete(node.path);
			childrenEl.remove();
			twist.textContent = '▸';
			this.saveExpandedForActive(node.section);
			return;
		}

		// 展开（懒加载）
		this._loadingFolders.add(uriKey);
		twist.textContent = '▾';
		this._expandedFolders.add(node.path);
		try {
			const nodes = await this.listChildren(node.uri, node.section);
			if (childrenEl) {
				// 复用现有 .kb-children 容器（清空交由分片渲染统一处理）
			} else {
				childrenEl = $('div.kb-children');
				el.after(childrenEl);
			}
			if (nodes.length === 0) {
				const empty = $('div.kb-empty-inline'); empty.style.paddingLeft = '20px'; empty.textContent = '空文件夹';
				childrenEl.appendChild(empty);
			} else {
				await this._appendNodesChunked(childrenEl, nodes, this.depthOf(el) + 1);
				// 递归恢复已展开的子目录（fire-and-forget，不阻塞分片渲染）
				for (const child of nodes) {
					if (child.isDirectory && this._expandedFolders.has(child.path)) {
						const childEl = this.findNodeEl(child.section, child.path);
						if (childEl) { void this.expandFolder(childEl, child); }
					}
				}
			}
			this.saveExpandedForActive(node.section);
		} catch (err) {
			this.logService.warn(`[KB] expandFolder failed: ${err}`);
		} finally {
			this._loadingFolders.delete(uriKey);
		}
	}

	private depthOf(el: HTMLElement): number {
		const pl = el.style.paddingLeft;
		const n = parseInt(pl.replace('px', ''), 10) || 6;
		return Math.round((n - 6) / 16);
	}

	private saveExpandedForActive(section: KbSection): void {
		if (this._activeVault) { this.saveExpanded(this._activeVault.id, section); }
	}

	private selectNode(el: HTMLElement, e?: MouseEvent): void {
		const path = el.dataset.path;
		if (!path) { return; }

		if (e?.ctrlKey || e?.metaKey) {
			// Ctrl+Click: 切换选中状态（多选）
			if (this._domSelectedPaths.has(path)) {
				this._domSelectedPaths.delete(path);
				el.classList.remove('selected');
			} else {
				this._domSelectedPaths.add(path);
				el.classList.add('selected');
			}
			this._domLastSelectedPath = path;
			return;
		}

		if (e?.shiftKey && this._domLastSelectedPath && this._domLastSelectedPath !== path) {
			// Shift+Click: 范围选择
			const allEls = Array.from(this._body.querySelectorAll('.kb-node')) as HTMLElement[];
			const anchorIdx = allEls.findIndex(n => n.dataset.path === this._domLastSelectedPath);
			const targetIdx = allEls.findIndex(n => n.dataset.path === path);
			if (anchorIdx >= 0 && targetIdx >= 0) {
				const [start, end] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
				for (let i = start; i <= end; i++) {
					const p = allEls[i].dataset.path;
					if (p) {
						this._domSelectedPaths.add(p);
						allEls[i].classList.add('selected');
					}
				}
			}
			return;
		}

		// 单选：清除所有选中，只选当前
		this._domSelectedPaths.clear();
		this._body.querySelectorAll('.kb-node.selected').forEach(n => n.classList.remove('selected'));
		this._domSelectedPaths.add(path);
		this._domLastSelectedPath = path;
		el.classList.add('selected');

		const node = this.nodeFromEl(el);
		if (node) {
			void this.updateBacklinks(node);
			// 点击文件 → 在中间栏直接打开编辑器
			if (!node.isDirectory) {
				if (node.uri.path.endsWith('.canvas')) {
					void this._openCanvasEditor(node.uri);
				} else {
					this._openNoteEditor(node);
				}
			}
		}
	}

	private fmtSize(bytes: number): string {
		if (bytes < 1024) { return `${bytes}B`; }
		if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)}KB`; }
		return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
	}

	// ═══════════════════════════════════════════════════════════
	//  File operations
	// ═══════════════════════════════════════════════════════════

	private targetDir(section: KbSection, parent?: IKbNode): URI {
		if (parent && parent.isDirectory) { return parent.uri; }
		return this.sectionUri(this._activeVault!, section);
	}

	private async uniqueName(dir: URI, base: string, ext = ''): Promise<URI> {
		let candidate = URI.joinPath(dir, base + ext);
		let i = 1;
		while (true) {
			try {
				await this.fileService.resolve(candidate);
				candidate = URI.joinPath(dir, `${base} (${i})${ext}`);
				i++;
			} catch {
				return candidate;
			}
		}
	}

	private async newFile(section: KbSection, parent?: IKbNode): Promise<void> {
		const dir = this.targetDir(section, parent);
		const uri = await this.uniqueName(dir, '未命名', '.md');
		await this.fileService.writeFile(uri, VSBuffer.fromString('# ' + uri.path.split('/').pop() + '\n'));
		void this._logOp('file.create', 'success', { target: uri.fsPath, detail: { section } });
		// 增量刷新：仅重列父目录（顶层=newFile 影响的层级），不整段重建，消除抖动
		if (parent) {
			// 刚展开的场景下 expandFolder 已渲染最新内容（含新文件），无需再走一次 listChildren
			const justExpanded = await this.ensureParentExpanded(parent);
			if (!justExpanded) { await this._reloadChildren(section, parent.path); }
		} else {
			await this._reloadChildren(section, null);
		}
		const el = this.findNodeEl(section, uri.fsPath);
		if (el) { this.selectNode(el); const node = this.nodeFromEl(el); if (node) { this.startRename(el, node); } }
	}

	private async newFolder(section: KbSection, parent?: IKbNode): Promise<void> {
		const dir = this.targetDir(section, parent);
		const uri = await this.uniqueName(dir, '未命名文件夹');
		await this.fileService.createFolder(uri);
		void this._logOp('folder.create', 'success', { target: uri.fsPath, detail: { section } });
		// 增量刷新：仅重列父目录（顶层=newFolder 影响的层级），不整段重建，消除抖动
		if (parent) {
			// 刚展开的场景下 expandFolder 已渲染最新内容（含新文件夹），无需再走一次 listChildren
			const justExpanded = await this.ensureParentExpanded(parent);
			if (!justExpanded) { await this._reloadChildren(section, parent.path); }
		} else {
			await this._reloadChildren(section, null);
		}
		const el = this.findNodeEl(section, uri.fsPath);
		if (el) { this.selectNode(el); const node = this.nodeFromEl(el); if (node) { this.startRename(el, node); } }
	}

	/**
	 * 确保指定文件夹的父节点已展开（子节点已在 DOM 中），用于新建文件/文件夹后定位子元素。
	 * 返回 true 表示本次执行了展开（expandFolder 内部已 listChildren 渲染最新内容，调用方无需再增量刷新）。
	 */
	private async ensureParentExpanded(parent: IKbNode): Promise<boolean> {
		const parentEl = this.findNodeEl(parent.section, parent.path);
		if (!parentEl) { return false; }
		// 已展开则无需再加载（expandFolder 遇到已展开会跳过 loading 检查直接折叠，所以这里做判断）
		if (this._expandedFolders.has(parent.path)) { return false; }
		await this.expandFolder(parentEl, parent);
		return true;
	}

	private async deleteNode(node: IKbNode): Promise<void> {
		const confirm = await this.dialogService.confirm({
			message: localize('kb.deleteNode', '确定删除「{0}」？', node.name),
			detail: localize('kb.deleteNodeDetail', '文件将移入回收站，可从回收站还原。'),
			primaryButton: localize('kb.delete', '删除'),
		});
		if (!confirm.confirmed) { return; }
		// P2c：删除「库」分区节点时，级联删除引用了它的笔记（基于 notes 的 sources[] frontmatter）
		let cascadeDeleted = 0;
		if (node.section === 'library' && this._activeVault) {
			const notesDir = this.sectionUri(this._activeVault, 'notes');
			const libDir = this.sectionUri(this._activeVault, 'library');
			cascadeDeleted = (await KbImportController.cascadeDeleteLibraryNotes(this.fileService, node.uri, notesDir)).length;
			if (cascadeDeleted > 0) {
				await KbImportController.maintainKbNavigation(this.fileService, libDir);
			}
		}
		try {
			// Explorer 对齐：优先移入系统回收站（软删除，可从回收站还原）
			await this._deleteToTrash(node.uri);
			void this._logOp('node.delete', 'success', { target: node.uri.fsPath, detail: { section: node.section, isDirectory: node.isDirectory, cascadeNotes: cascadeDeleted } });
		} catch (err) {
			void this._logOp('node.delete', 'failure', { target: node.uri.fsPath, detail: { section: node.section }, error: String(err) });
		}
		this._expandedFolders.delete(node.path);
		// 删除后同步清理关系图谱与搜索索引：in-memory 图谱 / FTS 内核索引不会随文件删除自动剔除，
		// 否则已删文档会残留在「关系图谱」节点、搜索结果、反链与 @提及 中（频繁删除后尤为明显）。
		// invalidate() 让内核下次全量重建走 _reconcile 剔除已删文件，markSearchDirty() 触发该重建（防抖合并频繁删除）。
		this._nativeKernel?.invalidate();
		this.markSearchDirty();
		// 增量移除（对齐 Explorer：仅移除被删节点的 DOM，不整段重建，消除抖动）
		this._removeNodeFromDom(node);
		if (cascadeDeleted > 0) {
			// 级联删除的笔记文件位于另一分区，整段重建一次（不影响当前分区视图）
			await this.refreshSection('notes');
		}
	}

	/** 永久删除（对齐 Explorer Shift+Delete / Delete Permanently）：不经过回收站，二次确认。 */
	private async _deleteNodePermanent(node: IKbNode): Promise<void> {
		const confirm = await this.dialogService.confirm({
			message: localize('kb.deletePermNode', '确定永久删除「{0}」？', node.name),
			detail: localize('kb.deletePermDetail', '此操作不可撤销，文件将被彻底删除且无法从回收站还原。'),
			primaryButton: localize('kb.deletePermBtn', '永久删除'),
		});
		if (!confirm.confirmed) { return; }
		let cascadeDeleted = 0;
		if (node.section === 'library' && this._activeVault) {
			const notesDir = this.sectionUri(this._activeVault, 'notes');
			const libDir = this.sectionUri(this._activeVault, 'library');
			cascadeDeleted = (await KbImportController.cascadeDeleteLibraryNotes(this.fileService, node.uri, notesDir)).length;
			if (cascadeDeleted > 0) { await KbImportController.maintainKbNavigation(this.fileService, libDir); }
		}
		try {
			await this.workingCopyFileService.delete([{ resource: node.uri, recursive: true, useTrash: false }], CancellationToken.None);
			void this._logOp('node.deletePermanent', 'success', { target: node.uri.fsPath, detail: { section: node.section, cascadeNotes: cascadeDeleted } });
		} catch (err) {
			void this._logOp('node.deletePermanent', 'failure', { target: node.uri.fsPath, error: String(err) });
			this.notificationService.warn(String(err));
		}
		this._expandedFolders.delete(node.path);
		// 增量移除（对齐 Explorer：仅移除被删节点的 DOM，不整段重建，消除抖动）
		this._removeNodeFromDom(node);
		if (cascadeDeleted > 0) { await this.refreshSection('notes'); }
	}

	private startRename(el: HTMLElement, node: IKbNode): void {
		const nameEl = el.querySelector('.kb-name') as HTMLElement;
		const actions = el.querySelector('.kb-actions') as HTMLElement | null;
		if (actions) { actions.style.display = 'none'; }
		this._renameActive = true; // 重命名期间禁止文件监听重建视图（防输入框被销毁）
		const input = document.createElement('input');
		input.className = 'kb-rename-input';
		input.value = node.name;
		nameEl.replaceWith(input);
		// 对齐 Explorer：文件默认只选中主名（不含扩展名），文件夹全选
		const dotIdx = node.isDirectory ? -1 : node.name.lastIndexOf('.');
		input.focus();
		if (dotIdx > 0) { input.setSelectionRange(0, dotIdx); } else { input.select(); }

		// 内联校验消息（复用 .kb-rename-msg 样式）
		const showMsg = (text: string | null) => {
			let msg = el.querySelector('.kb-rename-msg') as HTMLElement | null;
			if (!text) { msg?.remove(); return; }
			if (!msg) { msg = $('span.kb-rename-msg'); input.after(msg); }
			msg.className = 'kb-rename-msg invalid';
			msg.textContent = text;
		};
		input.addEventListener('input', () => { showMsg(this._validateRename(input.value.trim(), node)); });

		const finish = async (commit: boolean) => {
			const newName = input.value.trim();
			if (commit && newName && newName !== node.name) {
				// 提交前校验：非法字符 / 保留名（对齐 Explorer validateFileName）
				const invalid = this._validateRename(newName, node);
				if (invalid) { showMsg(invalid); input.focus(); return; }
				const target = URI.joinPath(node.uri, '..', newName);
				// 重名校验（大小写不敏感文件系统下同名不同 case 允许通过 move 处理）
				if (!isEqual(node.uri, target, true) && await this.fileService.exists(target)) {
					showMsg(localize('kb.renameExists', '此位置已存在名为「{0}」的文件或文件夹', newName));
					input.focus();
					return;
				}
				// 扩展名变更提示（文件）
				if (!node.isDirectory) {
					const oldExt = node.name.includes('.') ? node.name.slice(node.name.lastIndexOf('.')) : '';
					const newExt = newName.includes('.') ? newName.slice(newName.lastIndexOf('.')) : '';
					if (oldExt !== newExt) {
						const confirm = await this.dialogService.confirm({
							message: localize('kb.renameExtChange', '确定要将扩展名从「{0}」更改为「{1}」吗？', oldExt || '(无)', newExt || '(无)'),
							detail: localize('kb.renameExtChangeDetail', '更改扩展名可能导致文件无法正常打开。'),
							primaryButton: localize('kb.renameConfirm', '更改'),
						});
						if (!confirm.confirmed) { input.focus(); return; }
					}
				}
				const sourceUri = node.uri;
				try {
					await this.workingCopyFileService.move([{ file: { source: sourceUri, target } }], CancellationToken.None);
					void this._logOp('node.rename', 'success', { source: sourceUri.fsPath, target: target.fsPath, detail: { section: node.section } });
					// 注册 undo：改回原名
					this._pushKbUndoElement(
						localize('kb.undoRename', '重命名「{0}」为「{1}」', node.name, newName), 'kb.rename',
						[sourceUri, target],
						async () => {
						try { await this.workingCopyFileService.move([{ file: { source: target, target: sourceUri } }], CancellationToken.None, { isUndoing: true }); } catch (e) { this.logService.warn(`[KB-Undo] rename-back failed: ${e}`); }
						// 增量刷新：仅重列被改名节点的父目录
						await this._reloadChildren(node.section, this._parentReloadKey(node.section, node.path));
						},
						async () => {
						try { await this.workingCopyFileService.move([{ file: { source: sourceUri, target } }], CancellationToken.None); } catch (e) { this.logService.warn(`[KB-Redo] rename failed: ${e}`); }
						// 增量刷新：仅重列被改名节点的父目录
						await this._reloadChildren(node.section, this._parentReloadKey(node.section, node.path));
						},
					);
					this._renameActive = false; // 重命名完成，允许后续刷新
					// 增量刷新：仅重列被改名节点的父目录（重列后按原排序归位，不整段重建）
					await this._reloadChildren(node.section, this._parentReloadKey(node.section, node.path));
				} catch (err) {
					this._renameActive = false;
					this.notificationService.warn(String(err));
					void this._logOp('node.rename', 'failure', { source: sourceUri.fsPath, target: target.fsPath, error: String(err) });
					this.revertRename(el, node.name, actions);
				}
			} else {
				this._renameActive = false;
				this.revertRename(el, node.name, actions);
			}
		};

		input.onkeydown = (e) => {
			e.stopPropagation(); // 避免触发 scroll 层 Delete/F2/Ctrl+Z 快捷键
			if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
			else if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
		};
		input.onblur = () => { setTimeout(() => void finish(false), 150); };
	}

	/** 重命名校验（对齐 Explorer validateFileName）：返回错误消息或 null。 */
	private _validateRename(name: string, node: IKbNode): string | null {
		if (!name) { return localize('kb.renameEmpty', '必须提供文件或文件夹名称'); }
		if (name === node.name) { return null; }
		// Windows 非法字符 + 通用非法（/ 在所有平台非法，因为会被解释为路径分隔）
		if (/[\\/:*?"<>|]/.test(name)) {
			return localize('kb.renameInvalidChars', '名称不能包含以下字符: \\ / : * ? " < > |');
		}
		if (name === '.' || name === '..') { return localize('kb.renameDots', '名称无效'); }
		if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) {
			return localize('kb.renameReserved', '「{0}」是系统保留名称，不能使用', name);
		}
		if (/[. ]$/.test(name)) { return localize('kb.renameTrailing', '名称不能以「.」或空格结尾'); }
		if (name.length > 255) { return localize('kb.renameTooLong', '名称过长'); }
		return null;
	}

	private revertRename(el: HTMLElement, name: string, actions: HTMLElement | null): void {
		const input = el.querySelector('.kb-rename-input') as HTMLInputElement | null;
		const msg = el.querySelector('.kb-rename-msg') as HTMLElement | null;
		if (input) {
			const span = $('span.kb-name'); span.textContent = name;
			input.replaceWith(span);
		}
		if (msg) { msg.remove(); }
		if (actions) { actions.style.display = ''; }
	}

	private openInEditor(node: IKbNode): void {
		// Route .canvas 文件到思维导图编辑器
		if (node.uri.path.endsWith('.canvas')) {
			void this._openCanvasEditor(node.uri);
			return;
		}
		const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
		const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
		this.editorService.openEditor({ resource: node.uri, options: { pinned: true } }, targetGroup);
	}

	/**
	 * 打开 .canvas 思维导图编辑器。
	 * 读取 JSON Canvas 文件内容 → 解析 → 创建 CanvasEditorInput → 中间栏打开。
	 */
	private async _openCanvasEditor(uri: URI): Promise<void> {
		this.logService.info(`[KB canvas] _openCanvasEditor: ${uri.toString()}`);
		try {
			const raw = await this.fileService.readFile(uri);
			const text = raw.value.toString();
			this.logService.info(`[KB canvas] _openCanvasEditor: file read OK, length=${text.length}`);
			const data: IMindmapData = JSON.parse(text);
			// Ensure nodes/edges exist
			if (!data.nodes) { data.nodes = []; }
			if (!data.edges) { data.edges = []; }
			// Ensure mindmap flag
			if (data.mindmap === undefined) { data.mindmap = true; }
			this.logService.info(`[KB canvas] _openCanvasEditor: parsed nodes=${data.nodes.length}, edges=${data.edges.length}, mindmapFlag=${data.mindmap}`);

			const input = new CanvasEditorInput(uri, data);
			const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
			this.logService.info(`[KB canvas] _openCanvasEditor: opening CanvasEditorInput (targetGroup=${targetGroup})`);
			await this.editorService.openEditor(input, { pinned: true }, targetGroup);
		} catch (err) {
			this.logService.warn(`[KB canvas] _openCanvasEditor: FALLBACK to plain text editor. Error: ${err}`);
			// Fallback: open as plain text
			const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
			this.editorService.openEditor({ resource: uri, options: { pinned: true } }, targetGroup);
		}
	}

	private async refreshSection(section: KbSection): Promise<void> {
		this.markSearchDirty();
		// DOM 渲染：始终填充
		const body = this._scroll.querySelector(`.kb-section-body[data-section="${section}"]`) as HTMLElement | null;
		const countEl = body?.parentElement?.querySelector('.kb-count') as HTMLElement | null;
		if (body) { await this.loadSectionTree(section, body, countEl ?? $('span.kb-count')); }
	}

	private refresh(): void {
		if (this._activeVault) { this.markSearchDirty(); this.renderAll(); }
	}

	private async openKbFolder(): Promise<void> {
		if (!this._activeVault) { return; }
		await this.openerService.open(this.vaultUri(this._activeVault), { openExternal: true });
	}

	// ═══════════════════════════════════════════════════════════
	//  Settings panel (⚙) — 根目录自定义
	// ═══════════════════════════════════════════════════════════

	private toggleSettingsPanel(): void {
		if (this._settingsDD.classList.contains('show')) {
			this._settingsDD.classList.remove('show');
			return;
		}
		// 关闭其它下拉（导入/排序/设置互斥）
		this._body.querySelectorAll('.kb-dropdown.show').forEach(d => { if (d !== this._settingsDD) d.classList.remove('show'); });
		this.renderSettingsPanel();
		this.positionDropdown(this._settingsDD, this._settingsBtn);
		this._settingsDD.classList.add('show');
	}

	private renderSettingsPanel(): void {
		this._settingsDD.replaceChildren();

		const title = $('div.kb-dd-title'); title.textContent = '知识库设置';
		this._settingsDD.appendChild(title);

		// 知识库目录配置行（Vault 及其「库」「笔记」子文件夹均在此目录下）
		const row = $('div.kb-set-row');
		const label = $('span.kb-set-label'); label.textContent = '📁 知识库目录';
		const path = $('span.kb-set-path'); path.id = 'kbRootPath'; path.textContent = this.rootUri.fsPath;
		const browse = $('span.kb-set-btn.primary'); browse.id = 'kbRootBrowse'; browse.textContent = '📂'; browse.title = '浏览文件夹…';
		const manual = $('span.kb-set-btn'); manual.id = 'kbRootManual'; manual.textContent = '📄'; manual.title = '手动输入路径';
		row.append(label, path, browse, manual);
		this._settingsDD.appendChild(row);

		const hint = $('div.kb-set-hint'); hint.textContent = '点击 📂 选择文件夹，或 📄 手动输入路径（Vault 及其「库」「笔记」子文件夹均在此目录下）';
		this._settingsDD.appendChild(hint);

		// ── Embedding 模型配置 ──
		const embDivider = $('div.kb-divider');
		this._settingsDD.appendChild(embDivider);

		const embTitle = $('div.kb-dd-title'); embTitle.textContent = '🧬 Embedding 模型';
		this._settingsDD.appendChild(embTitle);

		const embCfg = resolveAuxEmbeddingConfig(this.configurationService);

		// Provider select — 动态获取已配置的 Embedding Provider 列表
		const providerRow = $('div.kb-set-row');
		const providerLabel = $('span.kb-set-label'); providerLabel.textContent = 'Provider';
		const providerSelect = document.createElement('select') as HTMLSelectElement;
		providerSelect.className = 'kb-set-select';

		// Auto 始终作为首个选项
		const autoOpt = document.createElement('option');
		autoOpt.value = 'auto'; autoOpt.textContent = 'Auto（自动）';
		if (embCfg.providerId === 'auto') { autoOpt.selected = true; }
		providerSelect.appendChild(autoOpt);

		// 从 IEmbeddingService 获取已激活（已配置 API Key）的 provider 列表
		const allProviders = this._ragEmbeddingService.listProviders();
		const configuredProviders = allProviders.filter(p => p.configured);
		for (const p of configuredProviders) {
			const o = document.createElement('option');
			o.value = p.id;
			o.textContent = `${p.kind === 'openai' ? 'OpenAI' : p.kind === 'knot' ? 'Knot' : 'Local'} / ${p.model} (${p.dimensions}d)`;
			if (p.id === embCfg.providerId) { o.selected = true; }
			providerSelect.appendChild(o);
		}
		// 若当前选中 provider 不在已配置列表中（可能被动态移除了），保留原值但不默认选中
		if (!embCfg.providerId || embCfg.providerId === 'auto') {
			// auto always valid
		} else if (!configuredProviders.some(p => p.id === embCfg.providerId)) {
			// 当前值不在已配置列表中 → 额外添加一个标记项，提示用户
			const o = document.createElement('option');
			o.value = embCfg.providerId;
			o.textContent = `${embCfg.providerId}（未配置）`;
			o.selected = true;
			o.disabled = false;
			providerSelect.appendChild(o);
		}

		providerSelect.onchange = () => {
			this.configurationService.updateValue(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER, providerSelect.value);
			void this._logOp('settings.embedding.provider', 'success', { target: providerSelect.value });
		};
		providerRow.append(providerLabel, providerSelect);
		this._settingsDD.appendChild(providerRow);

		const providerHint = $('div.kb-set-hint'); providerHint.textContent = 'Auto 表示跟随全局 Embedding Provider 设置';
		this._settingsDD.appendChild(providerHint);

		// Model input
		const modelRow = $('div.kb-set-row');
		const modelLabel = $('span.kb-set-label'); modelLabel.textContent = 'Model';
		const modelInput = document.createElement('input');
		modelInput.className = 'kb-set-input';
		modelInput.value = embCfg.modelId;
		modelInput.placeholder = 'text-embedding-3-small';
		modelInput.onchange = () => {
			const v = modelInput.value.trim();
			if (v) {
				this.configurationService.updateValue(AGENT_STUDIO_AUX_EMBEDDING_MODEL, v);
				void this._logOp('settings.embedding.model', 'success', { target: v });
			}
		};
		modelRow.append(modelLabel, modelInput);
		this._settingsDD.appendChild(modelRow);

		const modelHint = $('div.kb-set-hint'); modelHint.textContent = '向量化模型 ID（留空使用默认 text-embedding-3-small）';
		this._settingsDD.appendChild(modelHint);

		// Dimensions input
		const dimRow = $('div.kb-set-row');
		const dimLabel = $('span.kb-set-label'); dimLabel.textContent = 'Dimensions';
		const dimInput = document.createElement('input');
		dimInput.type = 'number';
		dimInput.className = 'kb-set-num';
		dimInput.value = String(embCfg.dimensions);
		dimInput.min = '1'; dimInput.max = '8192'; dimInput.step = '64';
		dimInput.onchange = () => {
			const v = parseInt(dimInput.value, 10);
			if (Number.isFinite(v) && v > 0) {
				this.configurationService.updateValue(AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS, v);
				void this._logOp('settings.embedding.dimensions', 'success', { target: String(v) });
			}
		};
		dimRow.append(dimLabel, dimInput);
		this._settingsDD.appendChild(dimRow);

		const dimHint = $('div.kb-set-hint'); dimHint.textContent = '向量维度（默认 512，范围 1-8192，修改后需重建索引）';
		this._settingsDD.appendChild(dimHint);

		// 重建向量索引按钮
		const rebuildRow = $('div.kb-set-row');
		const rebuildBtn = $('div.kb-set-action'); rebuildBtn.textContent = '🔄 重新构建向量索引';
		rebuildBtn.onclick = (e) => {
			e.stopPropagation();
			this._settingsDD.classList.remove('show');
			void this.rebuildVectorIndex();
		};
		rebuildRow.appendChild(rebuildBtn);
		this._settingsDD.appendChild(rebuildRow);

		// ── Vault 统计 ──
		if (this._activeVault) {
			const docs = this._nativeKernel?.allDocs() ?? [];
			const totalSize = docs.reduce((sum, d) => sum + (d.size || 0), 0);
			const sqliteActive = !!this._kbSqliteStore;
			const stats = $('div.kb-set-hint');
			stats.style.paddingTop = '8px';
			stats.style.borderTop = `1px solid var(--vscode-panel-border, #444)`;
			stats.style.marginTop = '4px';
			let statsHtml = [
				`📄 ${docs.length} 文档`,
				totalSize > 0 ? `· ${this._formatSize(totalSize)}` : '',
				sqliteActive ? '· 🗄️ SQLite FTS5' : '· 💾 内存索引',
			].filter(Boolean).join(' ');
			if (this._activeVault.linkedWorkspaces?.length) {
				statsHtml += ` · 🔧 ${this._activeVault.linkedWorkspaces.length} 工作区`;
			}
			safeSetInnerHtml(stats, statsHtml);
			this._settingsDD.appendChild(stats);
		}

		// 快捷入口：打开当前知识库文件夹
		const openRow = $('div.kb-set-row');
		const openBtn = $('div.kb-set-action'); openBtn.textContent = '📂 打开知识库文件夹';
		openBtn.onclick = (e) => { e.stopPropagation(); this._settingsDD.classList.remove('show'); void this.openKbFolder(); };
		openRow.appendChild(openBtn);
		this._settingsDD.appendChild(openRow);

		// 交互
		const rootPath = path;
		browse.onclick = (e) => { e.stopPropagation(); void this.pickKbDir(rootPath.textContent); };
		manual.onclick = (e) => {
			e.stopPropagation();
			const input = document.createElement('input');
			input.className = 'kb-set-input';
			input.value = rootPath.textContent;
			rootPath.replaceWith(input);
			input.focus(); input.select();
			let done = false;
			const commit = (save: boolean) => {
				if (done) { return; }
				done = true;
				const v = input.value.trim();
				if (save && v) { void this.applyKbDir(v); }
				else { this.renderSettingsPanel(); }
			};
			input.onkeydown = (ke) => {
				if (ke.key === 'Enter') { ke.preventDefault(); commit(true); }
				else if (ke.key === 'Escape') { ke.preventDefault(); commit(false); }
			};
			input.onblur = () => commit(true);
		};
	}

	/** 调原生文件夹选择框，选取知识库目录。 */
	private async pickKbDir(current: string): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('kb.pickRoot', '选择知识库目录'),
			canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
			defaultUri: URI.file(current),
		});
		if (!picked || !picked.length) { return; }
		await this.applyKbDir(picked[0].fsPath);
	}

	/** 应用新的知识库目录：持久化 + 迁移默认 Vault 路径 + 重新激活。 */
	private async applyKbDir(dir: string): Promise<void> {
		const fsPath = URI.file(dir).fsPath;
		this.storageService.store(STORAGE_KB_DIR, fsPath, StorageScope.APPLICATION, StorageTarget.MACHINE);
		void this._logOp('vault.kbDir', 'success', { target: fsPath });

		// 默认 Vault（无 customPath）的路径跟随新目录；外部配置的 Vault 不受影响
		for (const v of this._vaults) {
			if (!v.customPath) {
				v.path = URI.joinPath(URI.file(fsPath), v.id).fsPath;
			}
		}
		this.saveVaults();

		if (this._activeVault) {
			this._activeVault.path = this.vaultUri(this._activeVault).fsPath;
			await this.activateVault(this._activeVault);
		}
		// 刷新设置面板内的路径展示
		const rp = this._settingsDD.querySelector('#kbRootPath') as HTMLElement | null;
		if (rp) { rp.textContent = this.rootUri.fsPath; }
		this.notificationService.info(localize('kb.rootChanged', '知识库目录已切换为：{0}', fsPath));
	}

	/** 使用当前 Embedding 设置重新构建所有 Vault 的向量索引。 */
	private async rebuildVectorIndex(): Promise<void> {
		const providerId = resolveAuxEmbeddingProviderId(this.configurationService);
		const embCfg = resolveAuxEmbeddingConfig(this.configurationService);
		if (!this._vaults.length) {
			this.notificationService.warn(localize('kb.rebuildEmpty', '没有可用的知识库 Vault，请先创建或导入。'));
			return;
		}
		if (!this._ragEmbeddingService.getActiveTag()) {
			this.notificationService.warn('Embedding 服务未启用。请在设置中配置模型 Provider。');
			return;
		}
		this.notificationService.info(`🧬 使用模型 ${embCfg.modelId} (${embCfg.dimensions}d) 重新构建向量索引…`);
		try {
			// 失效现有内核索引，强制全量重建
			this._kbKernelService.invalidate();
			if (this._searchDirty) { await this.rebuildSearchAssets(); }
			const roots = this.buildRoots();
			if (roots.length === 0) {
				this.notificationService.warn('没有可索引的目录。');
				return;
			}
			await this._kbKernelService.buildVectorIndex(roots);
			const st = this._kbKernelService.getVectorStatus();
			this.notificationService.info(`✅ 向量索引重建完成：${st.chunkCount} 个块（维度 ${st.dimensions}）。`);
			void this._logOp('settings.embedding.rebuild', 'success', {
				detail: { provider: providerId ?? 'auto', model: embCfg.modelId, dimensions: embCfg.dimensions, chunks: st.chunkCount },
			});
		} catch (err) {
			this.notificationService.error(`❌ 向量索引重建失败：${String((err as any)?.message ?? err)}`);
			void this._logOp('settings.embedding.rebuild', 'failure', {
				detail: { provider: providerId ?? 'auto', model: embCfg.modelId, dimensions: embCfg.dimensions },
				error: String(err),
			});
		}
	}

	/** 大库（> 2000 文档）自动同步到主进程 SQLite FTS5，卸载 V8 内存文本。 */
	private async _syncKbToSqliteIfNeeded(
		vault: IKbVault | undefined,
		docs: { uri: URI; name: string; section: string; mtime: number; size: number; text: string }[],
	): Promise<void> {
		if (!vault || docs.length <= KnowledgeBaseViewPane.KB_SQLITE_AUTO_THRESHOLD) {
			// 小库或缩容：关闭 SQLite 后端释放资源
			if (this._kbSqliteStore) {
				void this._kbSqliteStore.close();
				this._kbSqliteStore = undefined;
				this._sqliteSyncMtime = 0;
			}
			return;
		}

		// 增量过滤：仅 mtime > 上次同步时间的文档
		const changed = docs.filter(d => d.mtime > this._sqliteSyncMtime);
		if (changed.length === 0) { return; }

		// 懒创建 SQLite 后端代理
		if (!this._kbSqliteStore) {
			try {
				this._kbSqliteStore = createKbSqliteStoreProxy(this._mainProcessService);
				await this._kbSqliteStore.open(
					URI.joinPath(this.vaultUri(vault), 'kb.db').fsPath,
				);
				this.logService.info(`[KB SQLite] opened for vault: ${vault.name} (${docs.length} docs)`);
				// 首次全量同步（reset mtime baseline）
				this._sqliteSyncMtime = 0;
			} catch (err) {
				this.logService.warn(`[KB SQLite] init failed, fallback to memory-only:', ${err}`);
				this._kbSqliteStore = undefined;
				return;
			}
		}

		try {
			const t0 = performance.now();
			const kbDocs = changed.map(d => ({
				uri: d.uri.toString(),
				name: d.name,
				section: d.section,
				mtime: d.mtime,
				size: d.size,
				text: d.text,
			}));
			await this._kbSqliteStore.upsertDocsBatch(kbDocs);
			this._sqliteSyncMtime = Date.now();
			this.logService.info(
				`[KB SQLite] synced ${kbDocs.length}/${docs.length} changed docs to FTS5 (${(performance.now() - t0).toFixed(1)}ms)`
			);
		} catch (err) {
			this.logService.warn(`[KB SQLite] sync failed:', ${err}`);
		}
	}

	/** 经主进程 SQLite FTS5 搜索（仅在 _kbSqliteStore 已启用时使用）。 */
	async _searchKbSqlite(query: string, limit: number = 20): Promise<IKbSearchHit[]> {
		if (!this._kbSqliteStore || !this._activeVault) { return []; }
		try {
			const results = await this._kbSqliteStore.search(query, limit);
			return results.map(r => {
				const hit: IKbSearchHit = {
					name: r.name,
					path: r.uri,
					uri: URI.parse(r.uri),
					isDirectory: false,
					section: (r.section as KbSection) || 'library',
					size: 0,
					mtime: 0,
					ctime: 0,
					childCount: 0,
					score: r.rank,
					snippet: r.snippet || '',
					matchedBy: 'content' as const,
				};
				return hit;
			});
		} catch {
			return [];
		}
	}

	/**
	 * 按需构建提及索引 + 图谱（首次访问反链/图谱面板时延迟执行）。
	 * 避免每次 rebuildSearchAssets 都 O(N×K)，大库下节省显著。
	 */
	private async _ensureMentionIndex(): Promise<void> {
		// 大库走 SQLite 增量同步，不构建内存提及索引（O(N×K) 会冻结主线程），直接跳过
		if (this._largeRepo) { this._mentionPending = false; return; }
		if (!this._mentionPending || !this._nativeKernel) { return; }
		this._mentionPending = false;

		// 优先使用 Worker（异步，不阻塞 UI）
		if (this._kbWorker) {
			const docs = this._nativeKernel.allDocs();
			if (docs.length === 0) { return; }
			const workerDocs = docs.map(d => ({ uri: d.uri, name: d.name, text: d.text, mtime: d.mtime, size: d.size }));
			try {
				const { mention: mentionEntries, graph: graphData } = await this._kbWorker.buildMentionAndGraph(workerDocs);
				this._nativeKernel.injectMentionIndex(mentionEntries, workerDocs);
				this._nativeKernel.injectGraph(graphData);
				this.logService.info(`[KB perf] lazy mention+graph via Worker: ${docs.length} docs`);
				return;
			} catch (err) {
				// Worker 失败，fall through to main thread
			}
		}

		// Fallback：主线程构建图谱 + 提及（FTS 已就绪）
		const roots = this.buildRoots();
		const kernelCache = this._activeVault
			? URI.joinPath(this.vaultUri(this._activeVault), '.kbkernel.json')
			: undefined;
		const t0 = performance.now();
		await this._nativeKernel.build(roots, kernelCache); // 全量：FTS 增量 + 图谱 + 提及
		this.logService.info(`[KB perf] lazy mention+graph main thread: ${(performance.now() - t0).toFixed(1)}ms`);
	}

	private baseName(uri: URI): string {
		return uri.path.split('/').filter(Boolean).pop() || 'import';
	}

	/** 检查路径是否为绝对路径（兼容 Windows 盘符和 Unix /）。 */
	private _isAbsolutePath(p: string): boolean {
		return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/');
	}

	private _formatSize(bytes: number): string {
		if (bytes < 1024) { return `${bytes} B`; }
		const kb = bytes / 1024;
		if (kb < 1024) { return `${kb.toFixed(1)} KB`; }
		const mb = kb / 1024;
		if (mb < 1024) { return `${mb.toFixed(1)} MB`; }
		return `${(mb / 1024).toFixed(1)} GB`;
	}

	// ═══════════════════════════════════════════════════════════
	//  URL import (web clip → Markdown)
	// ═══════════════════════════════════════════════════════════

	/** 关联外部文件夹：登记为索引根并原地索引（不复制任何文件）。 */
	// @ts-expect-error: reserved — direct link-folder path (bypassed by _routeImportToKbAgent)
	private async linkFolder(uri: URI): Promise<void> {
		if (!this._activeVault) { return; }
		const p = uri.fsPath;
		if (!(await this.fileService.exists(uri))) {
			this.notificationService.warn(localize('kb.linkMissing', '关联失败：文件夹不存在或无法访问：{0}', p));
			return;
		}
		const list = this._activeVault.linkedFolders ?? [];
		if (list.includes(p)) {
			this.notificationService.info(localize('kb.linkDup', '该文件夹已关联：{0}', this.baseName(uri)));
			return;
		}
		this._activeVault.linkedFolders = [...list, p];
		this.saveVaults();
		this.markSearchDirty();
		await this.rebuildSearchAssets();
		this.renderAll();
		this.notificationService.info(localize('kb.linked', '已关联文件夹（文件保持原位，原地索引）：{0}', this.baseName(uri)));
		void this._logOp('kb.link', 'success', { source: p });
	}

	/**
	 * 导入 .code-workspace 文件：解析 folders 数组，将所有工作区目录关联入库。
	 * 若 workspace 中包含 codebase-memory 配置，自动写入 ICodebaseMemoryMcpService。
	 * 支持从 UI 导入下拉和 workspaceView 右键触发。
	 */
	async importCodeWorkspace(wsUri?: URI): Promise<void> {
		if (!this._activeVault) { return; }

		let uri = wsUri;
		if (!uri) {
			// 从导入下拉触发：弹出文件选择器
			const picked = await this.fileDialogService.showOpenDialog({
				title: '选择 .code-workspace 文件',
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: [{ name: 'VS Code Workspace', extensions: ['code-workspace'] }],
			});
			if (!picked?.length) { return; }
			uri = picked[0];
		}

		if (!(await this.fileService.exists(uri))) {
			this.notificationService.warn(`工作区文件不存在：${uri.fsPath}`);
			return;
		}

		try {
			const content = await this.fileService.readFile(uri);
			const text = content.value.toString();
			const parsed = JSON.parse(text);

			// 1. 提取 folders 数组
			const folders: { path: string; name?: string }[] = parsed.folders;
			if (!Array.isArray(folders) || folders.length === 0) {
				this.notificationService.warn('.code-workspace 文件中没有 folders 配置');
				return;
			}

			// 2. 提取 codebase-memory 配置（顶层或 settings 内）
			const cbmConfig = (parsed['codebase-memory'])
				|| (parsed.settings && parsed.settings['codebase-memory']);
			if (cbmConfig && typeof cbmConfig === 'object') {
				const indexConfig: IIndexConfig = {
					mode: (cbmConfig.mode || 'fast') as IndexMode,
					excludeDirs: Array.isArray(cbmConfig.excludeDirs) ? cbmConfig.excludeDirs : [],
					keepDirs: Array.isArray(cbmConfig.keepDirs) ? cbmConfig.keepDirs : [],
					subPath: typeof cbmConfig.subPath === 'string' ? cbmConfig.subPath : undefined,
				};
				this._cbmService.setIndexConfig(indexConfig);
				this.logService.info(`[KB] code-workspace import: saved codebase-memory config (mode=${indexConfig.mode})`);
				void this._logOp('kb.import.codeWorkspace.cbm', 'success', {
					detail: { mode: indexConfig.mode, subPath: indexConfig.subPath ?? '' },
				});
			}

			// 3. 将每个 folder 路径关联入库（去重），按工作区分组
			const wsDir = URI.joinPath(uri, '..').fsPath; // workspace 文件所在目录
			const wsName = this.baseName(uri).replace(/\.code-workspace$/i, '');
			const existingList = new Set(this._activeVault.linkedFolders ?? []);
			let linkedCount = 0;
			let skippedCount = 0;

			const resolvedFolders: string[] = [];
			for (const f of folders) {
				if (!f.path || typeof f.path !== 'string') { continue; }

				const isAbs = this._isAbsolutePath(f.path);
				const folderPath = isAbs
					? URI.file(f.path).fsPath
					: URI.joinPath(URI.file(wsDir), f.path).fsPath;

				resolvedFolders.push(folderPath);
				if (!existingList.has(folderPath)) {
					existingList.add(folderPath);
					linkedCount++;
				} else {
					skippedCount++;
				}
			}

			if (linkedCount === 0 && skippedCount > 0) {
				this.notificationService.info(`工作区目录已全部关联，无需重复导入（${skippedCount} 个目录）`);
				this.logService.info(`[KB import] early-return path: linkedCount=0 skippedCount=${skippedCount}, calling renderAll`);
				this.renderAll();
				this.logService.info(`[KB import] early-return renderAll returned`);
				return;
			}

			// 持久化关联列表 + 工作区分组
			this._activeVault.linkedFolders = [...existingList];
			const wss = this._activeVault.linkedWorkspaces ?? [];
			const existingIdx = wss.findIndex(w => w.wsUri === uri.fsPath);
			if (existingIdx >= 0) {
				wss[existingIdx] = { name: wsName, wsUri: uri.fsPath, folders: resolvedFolders };
			} else {
				wss.push({ name: wsName, wsUri: uri.fsPath, folders: resolvedFolders });
			}
		this._activeVault.linkedWorkspaces = wss;
		this.saveVaults();
		this.markSearchDirty();
		this._autoExpandWsGroup = wsName;  // 导入后自动展开新分组

		// 先立即刷新 UI（关联已持久化），再在后台异步重建搜索索引。
		// 注意：对 UE5EA/S1Game 等巨型仓库，同步 FTS 构建会阻塞主线程数十分钟，
		// 导致视图长时间不刷新（与 _autoLinkWorkspace 一致，避免 OOM/卡死）。
		this.logService.info(`[KB import] main path: linkedCount=${linkedCount} skippedCount=${skippedCount}, calling renderAll`);
		this.renderAll();
		this.logService.info(`[KB import] main path renderAll returned`);

		void this.rebuildSearchAssets();

			const msg = linkedCount > 0
				? `已从 .code-workspace 关联 ${linkedCount} 个工作区目录${skippedCount > 0 ? `（${skippedCount} 个已存在跳过）` : ''}`
				: '工作区目录已全部关联';
			this.notificationService.info(msg);
			void this._logOp('kb.import.codeWorkspace', 'success', {
				detail: { linked: linkedCount, skipped: skippedCount, total: folders.length },
			});
		} catch (err) {
			const msg = String((err as any)?.message ?? err);
			this.notificationService.error(`导入 .code-workspace 失败：${msg}`);
			void this._logOp('kb.import.codeWorkspace', 'failure', { error: msg });
		}
	}

	/**
	 * 新工作区创建后自动关联进知识库「库」并根据内容类型触发索引（Task 3）。
	 *
	 * 行为：
	 *  - 前台：轻量登记（linkedFolders + save + renderAll），不调用 linkFolder /
	 *    rebuildSearchAssets（二者是大仓库 OOM 主因）。
	 *  - 后台类型判断：快速扫描顶层文件扩展名，检测是否为代码仓库。
	 *    • 代码仓库 → 额外触发 codebase tree-sitter 索引（_codebaseGraphService.indexWorkspace）。
	 *    • 纯文档 / 无脚本 → 不做额外索引。
	 *
	 * 同一路径重复触发幂等去重。
	 */
	private async _autoLinkWorkspace(wsId: string): Promise<void> {
		try {
			this.logService.info(`[KB DEBUG] _autoLinkWorkspace(wsId=${wsId}) start; activeVault=${(this._activeVault as any)?.id ?? 'none'}; current lf=${(this._activeVault as any)?.linkedFolders?.length ?? -1}; stack=${(new Error()).stack}`);
			const ws = await this.agentStudioService.getWorkspace(wsId);
			if (!ws?.path) { return; }
			// 确保存在可用（未关闭）的 vault
			if (!this._activeVault) {
				const fallback = (this._vaults ?? []).find((v) => !v.closed);
				if (!fallback) { return; }
				this._activeVault = fallback;
			}
			const uri = URI.file(ws.path);
			if (!(await this.fileService.exists(uri))) { return; }
			const p = ws.path;
			// 幂等去重（与 linkFolder 一致）
			const list = this._activeVault.linkedFolders ?? [];
			if (list.includes(p)) { return; }
			this._activeVault.linkedFolders = [...list, p];
			this.saveVaults();
			// 注意：不调用 markSearchDirty / rebuildSearchAssets（OOM 风险，见上方注释）
			this.renderAll();

			// 根据文件夹内容类型决定是否额外触发 codebase 源码索引
			this._detectAndIndexCodebase(p);
		} catch (err) {
			this.logService.warn('[KB] auto-link workspace failed', err);
		}
	}

	/**
	 * 检测文件夹是否为代码仓库（存在 .ts/.py/.go 等源码文件），
	 * 若是则后台触发 tree-sitter 代码图谱索引。
	 */
	private _detectAndIndexCodebase(folderPath: string): void {
		this._isCodeFolder(folderPath).then((isCode) => {
			if (isCode) {
				void this._triggerCodebaseIndex(folderPath);
			}
		}).catch(() => { /* best effort */ });
	}

	/** 扫描顶层 + 一层子目录的文件扩展名，判断是否为代码仓库（扫描上限 ~200 文件，避免 I/O 风暴）。 */
	private async _isCodeFolder(folderPath: string): Promise<boolean> {
		const CODE_EXTS = new Set([
			'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',  // JS/TS
			'py', 'pyx',                              // Python
			'go', 'java', 'rs',                        // Go / Java / Rust
			'c', 'cpp', 'cc', 'cxx', 'h', 'hpp',      // C/C++
			'cs', 'rb', 'php', 'swift', 'kt', 'scala', // 其他主流
		]);
		const MAX_CHECK = 200;
		const MAX_SUBDIR_ITEMS = 30;
		try {
			const root = await this.fileService.resolve(URI.file(folderPath));
			const items: IFileStat[] = [...(root.children ?? [])];
			let checked = 0;
			for (let i = 0; i < items.length && checked < MAX_CHECK; i++) {
				const item = items[i];
				checked++;
				const ext = item.name.includes('.') ? item.name.split('.').pop()?.toLowerCase() ?? '' : '';
				if (CODE_EXTS.has(ext)) { return true; }
				// 进入一层子目录（限制数量避免 I/O 过多）
				if (item.isDirectory && items.length < 300) {
					try {
						const sub = await this.fileService.resolve(item.resource);
						if (sub.children) {
							for (const c of sub.children.slice(0, MAX_SUBDIR_ITEMS)) {
								items.push(c);
							}
						}
					} catch { /* skip inaccessible subdirs */ }
				}
			}
			return false;
		} catch { return false; }
	}

	/** 后台触发代码图谱（tree-sitter）索引。 */
	private async _triggerCodebaseIndex(folderPath: string): Promise<void> {
		try {
			const config: IIndexConfig = {
				mode: 'fast' as IndexMode,
				// 单一来源见 common/codebaseIndexDefaults.ts（graphService 还会叠加 UE / .cbmignore）
				excludeDirs: COMMON_EXCLUDE_DIRS.slice(),
			};
			await this._codebaseGraphService.indexWorkspace(folderPath, config);
		} catch (err) {
			this.logService.warn('[KB] background codebase index failed', err);
		}
	}

	/** 取消关联外部文件夹：移除登记并重建索引。 */
	private async unlinkFolder(path: string): Promise<void> {
		if (!this._activeVault) { return; }
		const list = this._activeVault.linkedFolders ?? [];
		if (!list.includes(path)) { return; }
		this._activeVault.linkedFolders = list.filter(p => p !== path);
		// 清理该文件夹下所有仓库的 RAG session 映射（不删磁盘 session，仅移除登记）。
		if (this._activeVault.ragSessions) {
			const kept: Record<string, string> = {};
			for (const [repoRoot, sid] of Object.entries(this._activeVault.ragSessions)) {
				if (repoRoot !== path && !repoRoot.startsWith(path + '/') && !repoRoot.startsWith(path + '\\')) {
					kept[repoRoot] = sid;
				}
			}
			this._activeVault.ragSessions = Object.keys(kept).length ? kept : undefined;
		}
		this._activeVault.ragUnversionedSessionId = undefined;
		this.saveVaults();
		this.markSearchDirty();
		await this.rebuildSearchAssets();
		this.renderAll();
		this.notificationService.info(localize('kb.unlinked', '已取消关联：{0}', this.baseName(URI.file(path))));
		void this._logOp('kb.unlink', 'success', { target: path });
	}

	/** 批量取消关联多个文件夹（只触发 1 次 rebuild + 1 次 renderAll）。 */
	private async unlinkFoldersBatch(paths: string[], wsUri?: string): Promise<void> {
		if (!this._activeVault) { return; }
		const list = this._activeVault.linkedFolders ?? [];
		const removeSet = new Set(paths);
		this._activeVault.linkedFolders = list.filter(p => !removeSet.has(p));

		// 清理 RAG sessions（共享逻辑，参考 unlinkFolder）
		if (this._activeVault.ragSessions) {
			const kept: Record<string, string> = {};
			for (const [repoRoot, sid] of Object.entries(this._activeVault.ragSessions)) {
				if (!removeSet.has(repoRoot) && !paths.some(pp => repoRoot.startsWith(pp + '/') || repoRoot.startsWith(pp + '\\'))) {
					kept[repoRoot] = sid;
				}
			}
			this._activeVault.ragSessions = Object.keys(kept).length ? kept : undefined;
		}

		// 清理工作区分组
		if (wsUri && this._activeVault.linkedWorkspaces) {
			this._activeVault.linkedWorkspaces = this._activeVault.linkedWorkspaces.filter(w => w.wsUri !== wsUri);
		}

		this.saveVaults();
		this.markSearchDirty();
		await this.rebuildSearchAssets();
		this.renderAll();
		this.notificationService.info(`已取消关联 ${paths.length} 个文件夹`);
		void this._logOp('kb.unlinkBatch', 'success', { detail: { count: paths.length } });
	}

	/** 汇总当前 Vault 的全部索引根：库 / 笔记 分区 + 关联（链接）的外部文件夹。 */
	private buildRoots(): IKbBuildRoot[] {
		if (!this._activeVault) { return []; }
		const roots: IKbBuildRoot[] = (['library', 'notes'] as KbSection[]).map(s => ({
			uri: this.sectionUri(this._activeVault!, s),
			section: s,
		}));
		for (const p of this._activeVault.linkedFolders ?? []) {
			roots.push({ uri: URI.file(p), section: 'library' });
		}
		return roots;
	}

	/** 渲染一条「已关联文件夹」条目（库分区内），提供打开 / 取消关联操作。 */
	private renderLinkedFolder(path: string): HTMLElement {
		const el = $('div.kb-node.kb-linked');
		el.dataset.path = path;
		el.style.paddingLeft = '6px';
		el.classList.add('dir');

		const icon = $('span.kb-ficon'); icon.textContent = '🔗'; el.appendChild(icon);
		const name = $('span.kb-name'); name.textContent = `${this.baseName(URI.file(path))}（关联）`; el.appendChild(name);

		const actions = $('div.kb-actions');
		const openBtn = $('span.kb-act'); openBtn.textContent = '📂'; openBtn.title = '在文件管理器打开';
		openBtn.onclick = (e) => { e.stopPropagation(); void this.openerService.open(URI.file(path), { openExternal: true }); };
		const graphBtn = $('span.kb-act'); graphBtn.textContent = '🧬'; graphBtn.title = '代码图谱（索引库）';
		graphBtn.onclick = (e) => { e.stopPropagation(); const input = new CodebaseIndexEditorInput(path); void this.editorService.openEditor(input, { pinned: true }); };
		const unlinkBtn = $('span.kb-act'); unlinkBtn.textContent = '🔌'; unlinkBtn.title = '取消关联';
		unlinkBtn.onclick = (e) => { e.stopPropagation(); void this.unlinkFolder(path); };
		actions.append(openBtn, graphBtn, unlinkBtn);
		el.appendChild(actions);

		el.onclick = () => { void this.openerService.open(URI.file(path), { openExternal: true }); };
		el.oncontextmenu = (e) => {
			e.preventDefault(); e.stopPropagation();
			const actions: IAction[] = [
				new Action('kb.openExternal', '在文件管理器打开', undefined, true, () => { void this.openerService.open(URI.file(path), { openExternal: true }); }),
				new Action('kb.codeGraph', '代码图谱', undefined, true, () => { const input = new CodebaseGraphViewerEditorInput(path); void this.editorService.openEditor(input, { pinned: true }); }),
				new Separator(),
				new Action('kb.unlink', '取消关联', undefined, true, () => { void this.unlinkFolder(path); }),
			];
			this.contextMenuService.showContextMenu({ getAnchor: () => ({ x: e.clientX, y: e.clientY }), getActions: () => actions });
		};
		return el;
	}

	/**
	 * 渲染一个「工作区分组」父节点（从 .code-workspace 导入）。
	 * 展开后显示各 workspace folder 子节点。
	 */
	private renderLinkedWorkspaceGroup(ws: { name: string; wsUri: string; folders: string[] }): HTMLElement {
		const parent = $('div.kb-node.kb-linked-ws');
		parent.dataset.path = ws.wsUri;
		parent.style.paddingLeft = '6px';
		parent.classList.add('dir', 'kb-linked-group');

		const icon = $('span.kb-ficon'); icon.textContent = '🔧'; parent.appendChild(icon);
		const nameEl = $('span.kb-name'); nameEl.textContent = ws.name; parent.appendChild(nameEl);

		const menuBtn = $('span.kb-act'); menuBtn.textContent = '⋯'; menuBtn.title = '操作';
		menuBtn.onclick = (e) => { e.stopPropagation(); this._showWsGroupMenu(ws, e); };
		const actions = $('div.kb-actions');
		actions.appendChild(menuBtn);
		parent.appendChild(actions);

		const children = $('div.kb-children');
		children.style.display = 'none';
		for (const fp of ws.folders) {
			children.appendChild(this.renderLinkedFolder(fp));
		}
		parent.appendChild(children);

		// 导入 code-workspace 后自动展开新分组（one-shot）
		if (this._autoExpandWsGroup === ws.name) {
			children.style.display = 'block';
			icon.textContent = '📂';
			this._autoExpandWsGroup = undefined;  // 一次性消费
			// 自动滚动到新分组可见
			requestAnimationFrame(() => { parent.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); });
		}

		parent.onclick = () => {
			const isOpen = children.style.display !== 'none';
			children.style.display = isOpen ? 'none' : 'block';
			icon.textContent = isOpen ? '🔧' : '📂';
		};

		return parent;
	}

	private _showWsGroupMenu(ws: { name: string; wsUri: string; folders: string[] }, e: MouseEvent): void {
		const items = [
			{ label: '在文件管理器打开', run: () => { void this.openerService.open(URI.file(ws.wsUri), { openExternal: true }); } },
			...ws.folders.map(fp => ({
				label: `取消关联：${this.baseName(URI.file(fp))}`,
				run: () => { void this.unlinkFolder(fp); },
			})),
			{ label: '取消全部关联', run: () => {
				void this.unlinkFoldersBatch(ws.folders, ws.wsUri);
			}},
		];
		this.showSimpleMenu(items, e.clientX, e.clientY);
	}

	/** parse workspace DAG → topology（暂时未用，预留） */

	// ═══════════════════════════════════════════════════════════
	//  Sort
	// ═══════════════════════════════════════════════════════════

	/** 搜索栏旁的排序下拉（P0：全局可访问排序按钮）。 */
	private openSearchSortDropdown(anchorBtn: HTMLElement): void {
		this._body.querySelectorAll('.kb-dropdown.show').forEach(d => d.classList.remove('show'));
		const dd = $('div.kb-dropdown');
		dd.id = 'kbSortDD';
		for (const grp of KB_SORT_GROUPS) {
			const g = $('div.kb-sort-group');
			const label = $('div.kb-sort-label'); label.textContent = grp.group; g.appendChild(label);
			for (const opt of grp.options) {
				const o = $('div.kb-sort-opt');
				const ck = $('span.kb-ck'); ck.textContent = this._sortMode === opt.value ? '✓' : '';
				const txt = $('span'); txt.textContent = opt.label;
				o.append(ck, txt);
				o.onclick = (e) => {
					e.stopPropagation();
					this._sortMode = opt.value;
					if (this._activeVault) { this.saveSort(this._activeVault.id, opt.value); }
					dd.classList.remove('show');
					this.refresh();
				};
				g.appendChild(o);
			}
			dd.appendChild(g);
		}
		this.positionDropdown(dd, anchorBtn);
		dd.classList.add('show');
	}

	// ─── 构建为笔记（阶段 2：双阶段 LLM + FILE 块）─────────────────────

	/** 右键菜单：对单个库文件构建结构化笔记。 */
	private async _buildNoteFromLibrary(node: IKbNode): Promise<void> {
		this._setNodeBuilding(node.path, true);
		try {
			const vaultRoot = this.vaultUri(this._activeVault!);
			const built = await KbImportController.buildNotesFromLibrary(node.uri, vaultRoot, {
				fileService: this.fileService,
				configService: this.configurationService,
				logService: this.logService,
				notificationService: this.notificationService,
				agentStudioService: this.agentStudioService,
				requestService: this.requestService,
			});
			if (!built) { this.notificationService.warn('构建失败或 LLM 未生成笔记。'); return; }
			await this.refreshSection('notes');
			await this.refreshSection('library');
			this.markSearchDirty(); // 让新构建的笔记进入搜索索引 / 关系图谱
			// 构建流程最后一步：生成/刷新思维导图（确保产出的是思维导图画布）
			void this._generateMindmapAfterImport();
		} catch (err) {
			this.logService.warn(`[KB] buildNoteFromLibrary: ${err}`);
			this.notificationService.warn(`构建失败：${err}`);
		} finally {
			this._setNodeBuilding(node.path, false);
		}
	}

	/** 工具栏按钮：批量构建全部库中未处理文件。 */
	private async _batchBuildAll(): Promise<void> {
		try {
			if (!this._activeVault) { this.notificationService.warn('请先选择知识库。'); return; }
			const vaultRoot = this.vaultUri(this._activeVault);
			// 标记所有库文件 item 为「构建中」
			const libNodes = this._scroll.querySelectorAll('.kb-node[data-section="library"]:not(.dir)');
			libNodes.forEach((n) => { this._setNodeBuilding((n as HTMLElement).dataset.path ?? '', true); });
			try {
				await KbImportController.buildAllPendingNotes(vaultRoot, {
					fileService: this.fileService,
					configService: this.configurationService,
					logService: this.logService,
					notificationService: this.notificationService,
					agentStudioService: this.agentStudioService,
					requestService: this.requestService,
				});
			} finally {
				// 清除全部构建中标记（避免刷新后残留）
				Array.from(this._buildingPaths).forEach(p => this._setNodeBuilding(p, false));
			}
			await this.refreshSection('notes');
			await this.refreshSection('library');
			this.markSearchDirty(); // 让新构建的笔记进入搜索索引 / 关系图谱
			// 批量构建末尾：生成/刷新思维导图（确保产出的是思维导图画布）
			void this._generateMindmapAfterImport();
		} catch (err) {
			this.logService.warn(`[KB] batchBuildAll: ${err}`);
			this.notificationService.warn(`批量构建失败：${err}`);
		}
	}

	/** P2: 批量删除（多选确认）。 */
	private async _batchDeleteNodes(nodes: IKbNode[]): Promise<void> {
		const names = nodes.map(n => n.name).join('、');
		const confirm = await this.dialogService.confirm({
			message: localize('kb.batchDelete', '确定删除以下 {0} 项？\n{1}', nodes.length, names),
			detail: localize('kb.batchDeleteDetail', '文件将移入回收站，可从回收站还原。'),
			primaryButton: localize('kb.delete', '删除 ({0})', nodes.length),
		});
		if (!confirm.confirmed) { return; }
		for (const node of nodes) {
			try {
				await this._deleteToTrash(node.uri);
				this._expandedFolders.delete(node.path);
				// 增量移除（对齐 Explorer：逐个移除节点，不整段重建，消除批量删除抖动）
				this._removeNodeFromDom(node);
			} catch (err) {
				this.logService.warn(`[KB] batchDelete failed for ${node.name}: ${err}`);
			}
		}
		this._domSelectedPaths.clear();
		this._domLastSelectedPath = null;
		this.notificationService.info(localize('kb.batchDeleted', '已删除 {0} 项', nodes.length));
	}

	/** 批量永久删除（Shift+Delete，对齐 Explorer Delete Permanently）。 */
	private async _batchDeleteNodesPermanent(nodes: IKbNode[]): Promise<void> {
		const names = nodes.map(n => n.name).join('、');
		const confirm = await this.dialogService.confirm({
			message: localize('kb.batchDeletePerm', '确定永久删除以下 {0} 项？\n{1}', nodes.length, names),
			detail: localize('kb.batchDeletePermDetail', '此操作不可撤销，文件将被彻底删除且无法从回收站还原。'),
			primaryButton: localize('kb.deletePerm', '永久删除 ({0})', nodes.length),
		});
		if (!confirm.confirmed) { return; }
		for (const node of nodes) {
			try {
				await this.workingCopyFileService.delete([{ resource: node.uri, recursive: true, useTrash: false }], CancellationToken.None);
				this._expandedFolders.delete(node.path);
				// 增量移除（对齐 Explorer：逐个移除节点，不整段重建，消除批量删除抖动）
				this._removeNodeFromDom(node);
			} catch (err) {
				this.logService.warn(`[KB] batchDeletePermanent failed for ${node.name}: ${err}`);
			}
		}
		this._domSelectedPaths.clear();
		this._domLastSelectedPath = null;
		this.notificationService.info(localize('kb.batchDeletedPerm', '已永久删除 {0} 项', nodes.length));
	}

	/** DOM 层拖拽：移动/复制选中文件到目标文件夹（对齐 Explorer 行为）。
	 *  Explorer 规则：不能移到自身/后代/同级父目录；移动后源自动移除；
	 *  冲突时确认替换/跳过；复制模式冲突自动生成「xxx copy」；操作可 Ctrl+Z 撤销。 */
	private async _doMoveFiles(paths: string[], targetDirNode: IKbNode, mode: 'move' | 'copy' = 'move'): Promise<void> {
		const targetDirUri = targetDirNode.uri;
		let doneCount = 0;
		const errors: string[] = [];
		const verb = mode === 'copy' ? '复制' : '移动';
		// 记录成功的操作用于 undo：{ source, target, overwrote }
		const doneOps: { source: URI; target: URI; overwrote: boolean }[] = [];
		let replaceAll: boolean | undefined; // 多冲突时「全部替换/全部跳过」记忆

		for (const p of paths) {
			const srcUri = URI.file(p);
			// 不能移到自身
			if (isEqual(srcUri, targetDirUri, false)) { errors.push(`源与目标相同: ${p}`); continue; }
			// 不能移到自身子孙目录（父目录不能放入其子目录）
			if (this._isParentOf(srcUri, targetDirUri)) { errors.push(`目标在源内: ${p}`); continue; }
			// 同级父目录：移动无意义；复制则生成副本
			const parentUri = URI.joinPath(srcUri, '..');
			if (mode === 'move' && isEqual(parentUri, targetDirUri, false)) { errors.push(`已在目标目录: ${p}`); continue; }

			let targetUri = URI.joinPath(targetDirUri, srcUri.path.split(/[\\/]/).pop() ?? '');
			let overwrite = false;

			if (await this.fileService.exists(targetUri)) {
				if (mode === 'copy') {
					// 复制冲突：自动生成增量名「xxx copy」「xxx copy 2」（对齐 Explorer 粘贴行为）
					targetUri = await this._incrementalCopyName(targetUri);
				} else {
					// 移动冲突：确认替换 / 跳过（对齐 Explorer 覆盖确认）
					let replace: boolean;
					if (replaceAll !== undefined) {
						replace = replaceAll;
					} else {
						const name = uriBasename(targetUri);
						const confirm = await this.dialogService.confirm({
							message: localize('kb.moveConflict', '目标文件夹中已存在「{0}」，是否替换？', name),
							detail: paths.length > 1
								? localize('kb.moveConflictDetailMulti', '替换将覆盖目标文件夹中的同名文件。此选择将应用于本次所有冲突项。')
								: localize('kb.moveConflictDetail', '替换将覆盖目标文件夹中的同名文件，被覆盖内容无法通过撤销恢复。'),
							primaryButton: localize('kb.replace', '替换'),
							cancelButton: localize('kb.skip', '跳过'),
						});
						replace = confirm.confirmed;
						if (paths.length > 1) { replaceAll = replace; }
					}
					if (!replace) { errors.push(`已跳过（目标同名）: ${uriBasename(targetUri)}`); continue; }
					overwrite = true;
				}
			}

			try {
				if (mode === 'copy') {
					await this.workingCopyFileService.copy([{ file: { source: srcUri, target: targetUri }, overwrite }], CancellationToken.None);
				} else {
					await this.workingCopyFileService.move([{ file: { source: srcUri, target: targetUri }, overwrite }], CancellationToken.None);
				}
				doneOps.push({ source: srcUri, target: targetUri, overwrote: overwrite });
				doneCount++;
				this.logService.info(`[DnD-DOM] ${mode}: ${p} → ${targetDirNode.name}`);
				this._domSelectedPaths.delete(p);
			} catch (err) {
				errors.push(`${p}: ${err}`);
				this.logService.warn(`[DnD-DOM] ${mode} failed for ${p}: ${err}`);
			}
		}

		// 注册 undo（仅未覆盖的操作可安全回退；覆盖操作无法恢复被替换文件，不纳入撤销）
		const undoableOps = doneOps.filter(o => !o.overwrote);
		if (undoableOps.length > 0) {
			if (mode === 'move') {
				this._pushKbUndoElement(
					localize('kb.undoMove', '移动 {0} 项到「{1}」', undoableOps.length, targetDirNode.name), 'kb.move',
					undoableOps.flatMap(o => [o.source, o.target]),
					async () => { // undo: 移回原处
						for (const o of [...undoableOps].reverse()) {
							try { await this.workingCopyFileService.move([{ file: { source: o.target, target: o.source } }], CancellationToken.None, { isUndoing: true }); } catch (e) { this.logService.warn(`[KB-Undo] move-back failed: ${e}`); }
						}
						await this._reloadAfterMove(targetDirNode.section, targetDirNode, undoableOps.map(o => o.source));
					},
					async () => { // redo: 再次移动
						for (const o of undoableOps) {
							try { await this.workingCopyFileService.move([{ file: { source: o.source, target: o.target } }], CancellationToken.None); } catch (e) { this.logService.warn(`[KB-Redo] move failed: ${e}`); }
						}
						await this._reloadAfterMove(targetDirNode.section, targetDirNode, undoableOps.map(o => o.source));
					},
				);
			} else {
				this._pushKbUndoElement(
					localize('kb.undoCopy', '复制 {0} 项到「{1}」', undoableOps.length, targetDirNode.name), 'kb.copy',
					undoableOps.map(o => o.target),
					async () => { // undo: 删除副本
						for (const o of undoableOps) {
							try { await this.workingCopyFileService.delete([{ resource: o.target, recursive: true, useTrash: true }], CancellationToken.None, { isUndoing: true }); } catch (e) { this.logService.warn(`[KB-Undo] delete-copy failed: ${e}`); }
						}
						await this._reloadAfterMove(targetDirNode.section, targetDirNode, undoableOps.map(o => o.target));
					},
					async () => { // redo: 再次复制
						for (const o of undoableOps) {
							try { await this.workingCopyFileService.copy([{ file: { source: o.source, target: o.target } }], CancellationToken.None); } catch (e) { this.logService.warn(`[KB-Redo] copy failed: ${e}`); }
						}
						await this._reloadAfterMove(targetDirNode.section, targetDirNode, undoableOps.map(o => o.target));
					},
				);
			}
		}

		this._domSelectedPaths.clear();
		this._domLastSelectedPath = null;
		this._body.querySelectorAll('.kb-node.selected').forEach(n => n.classList.remove('selected'));
		await this._reloadAfterMove(targetDirNode.section, targetDirNode, doneOps.map(o => o.source));
		if (errors.length > 0) {
			this.notificationService.warn(`已${verb} ${doneCount} 项，${errors.length} 项未处理：${errors.join('; ')}`);
		} else if (doneCount > 0) {
			this.notificationService.info(`已${verb} ${doneCount} 项到「${targetDirNode.name}」（Ctrl+Z 可撤销）`);
		}
	}

	/** 复制冲突时生成增量名：「xxx copy.md」「xxx copy 2.md」（对齐 Explorer findValidPasteFileTarget）。 */
	private async _incrementalCopyName(targetUri: URI): Promise<URI> {
		const dir = URI.joinPath(targetUri, '..');
		const ext = uriExtname(targetUri);
		const base = uriBasename(targetUri).slice(0, uriBasename(targetUri).length - ext.length);
		for (let i = 1; i < 100; i++) {
			const name = i === 1 ? `${base} copy${ext}` : `${base} copy ${i}${ext}`;
			const candidate = URI.joinPath(dir, name);
			if (!(await this.fileService.exists(candidate))) { return candidate; }
		}
		return URI.joinPath(dir, `${base} copy ${Date.now()}${ext}`);
	}

	/** 把一次 KB 文件操作注册进 undo/redo 栈（workspace 级元素，挂在 KB 专属 UndoRedoSource 上）。 */
	private _pushKbUndoElement(label: string, code: string, resources: URI[], undo: () => Promise<void>, redo: () => Promise<void>): void {
		const element: IWorkspaceUndoRedoElement = {
			type: UndoRedoElementType.Workspace,
			resources,
			label,
			code,
			undo,
			redo,
		};
		this.undoRedoService.pushElement(element, UndoRedoGroup.None, this._kbUndoSource);
	}

	/** KB 视图内撤销（只作用于 KB 文件操作栈）。 */
	private async _kbUndo(): Promise<void> {
		if (!this.undoRedoService.canUndo(this._kbUndoSource)) {
			this.notificationService.info(localize('kb.nothingToUndo', '没有可撤销的知识库文件操作'));
			return;
		}
		await this.undoRedoService.undo(this._kbUndoSource);
	}

	/** KB 视图内重做。 */
	private async _kbRedo(): Promise<void> {
		if (!this.undoRedoService.canRedo(this._kbUndoSource)) { return; }
		await this.undoRedoService.redo(this._kbUndoSource);
	}

	/** 软删除：优先移入系统回收站（对齐 Explorer files.enableTrash 默认行为）；trash 不可用时回退硬删除。 */
	private async _deleteToTrash(uri: URI): Promise<void> {
		try {
			await this.workingCopyFileService.delete([{ resource: uri, recursive: true, useTrash: true }], CancellationToken.None);
		} catch (err) {
			this.logService.warn(`[KB] trash delete failed, falling back to permanent delete: ${err}`);
			await this.fileService.del(uri, { recursive: true });
		}
	}

	/** 检查 srcUri 是否是 targetDirUri 的父目录（或其祖先）。 */
	private _isParentOf(srcUri: URI, targetDirUri: URI): boolean {
		const srcPath = srcUri.path.toLowerCase();
		const targetPath = targetDirUri.path.toLowerCase();
		// 父目录判定：目标路径以源路径为前缀（不含相等）
		return targetPath.startsWith(srcPath + '/') && targetPath.length > srcPath.length + 1;
	}

	// ─── 剪贴板：剪切 / 复制 / 粘贴 / 复制路径 / 在系统资源管理器显示（对齐 Explorer） ───

	/** 当前用于剪贴板/批量操作的路径集：显式 paths > DOM 多选 > 单节点 fallback。 */
	private _pathsForClipboard(fallback?: string, explicitPaths?: string[]): string[] {
		if (explicitPaths && explicitPaths.length) { return explicitPaths; }
		if (this._domSelectedPaths.size > 0) { return Array.from(this._domSelectedPaths); }
		return fallback ? [fallback] : [];
	}

	/** 剪切或复制选中项到剪贴板（同时写入系统剪贴板，支持跨窗口）。 */
	private _kbCopyToClipboard(cut: boolean, fallback?: string, explicitPaths?: string[]): void {
		const paths = this._pathsForClipboard(fallback, explicitPaths);
		if (!paths.length) { return; }
		const uris = paths.map(p => URI.file(p));
		this._kbClipboard = { uris, cut };
		void this.clipboardService.writeResources(uris);
		// 剪切视觉反馈：半透明标记（对齐 Explorer cut 项变暗）
		for (const el of this._scroll.querySelectorAll('.kb-node.kb-cut')) { el.classList.remove('kb-cut'); }
		if (cut) {
			for (const p of paths) {
				this.findNodeEl(this.sectionOfPath(p), p)?.classList.add('kb-cut');
			}
		}
		this.notificationService.info(localize(
			cut ? 'kb.copied.cut' : 'kb.copied.copy',
			cut ? '已剪切 {0} 项' : '已复制 {0} 项', paths.length));
	}

	/** 粘贴到目标目录：剪切=移动（冲突确认），复制=复制（冲突增量命名）。复用 _doMoveFiles 的冲突/undo 逻辑。 */
	private async _kbPaste(targetDirNode: IKbNode): Promise<void> {
		let uris: URI[];
		let cut = false;
		if (this._kbClipboard && this._kbClipboard.uris.length) {
			uris = this._kbClipboard.uris;
			cut = this._kbClipboard.cut;
		} else {
			// 回退到系统剪贴板（从 VS Code Explorer / OS 复制的文件）→ 一律按「复制」处理，绝不删除外部源
			try { uris = await this.clipboardService.readResources(); } catch { uris = []; }
			uris = uris.filter(u => u.scheme === 'file');
		}
		if (!uris.length) {
			this.notificationService.info(localize('kb.clipboardEmpty', '剪贴板为空'));
			return;
		}
		const paths = uris.map(u => u.fsPath);
		await this._doMoveFiles(paths, targetDirNode, cut ? 'move' : 'copy');
		// 剪切粘贴成功后清空剪贴板（移动语义一次性），并移除剪切标记
		if (cut) {
			this._kbClipboard = null;
			for (const el of this._scroll.querySelectorAll('.kb-node.kb-cut')) { el.classList.remove('kb-cut'); }
		}
	}

	/** 解析粘贴目标目录：文件夹→自身；文件→其父目录；无→当前分区根。 */
	private _resolvePasteTargetDir(node?: IKbNode): IKbNode | null {
		if (!this._activeVault) { return null; }
		if (node) {
			if (node.isDirectory) { return node; }
			const parentUri = URI.joinPath(node.uri, '..');
			return { name: uriBasename(parentUri), path: parentUri.fsPath, uri: parentUri, isDirectory: true, section: node.section, size: 0, mtime: 0, ctime: 0, childCount: 0 };
		}
		// 键盘 Ctrl+V：以最后选中项为准，否则当前 notes 分区根
		const last = this._domLastSelectedPath;
		if (last) {
			const el = this.findNodeEl(this.sectionOfPath(last), last);
			const n = el ? this.nodeFromEl(el) : null;
			if (n) { return this._resolvePasteTargetDir(n); }
		}
		const sectionUri = this.sectionUri(this._activeVault, 'notes');
		return { name: '笔记', path: sectionUri.fsPath, uri: sectionUri, isDirectory: true, section: 'notes', size: 0, mtime: 0, ctime: 0, childCount: 0 };
	}

	/** 复制路径（绝对或相对知识库根）。 */
	private _kbCopyPath(node: IKbNode, relative: boolean): void {
		let text = node.uri.fsPath;
		if (relative && this._activeVault) {
			const vaultRoot = this.vaultUri(this._activeVault).fsPath;
			text = node.uri.fsPath.startsWith(vaultRoot)
				? node.uri.fsPath.slice(vaultRoot.length).replace(/^[\\/]/, '')
				: node.uri.fsPath;
		}
		void this.clipboardService.writeText(text);
		this.notificationService.info(localize('kb.pathCopied', '已复制路径'));
	}

	/** 在系统资源管理器中显示：文件→打开其父目录并定位；文件夹→打开自身。 */
	private _kbRevealInOS(node: IKbNode): void {
		const target = node.isDirectory ? node.uri : URI.joinPath(node.uri, '..');
		void this.openerService.open(target, { openExternal: true });
	}

	/** 导入后自动生成/更新思维导图（JSON Canvas 格式，落盘笔记目录）。
	 *  增量扫描最近导入内容 → LLM 提取结构化图谱 → 合并到已有 .canvas 或新建。 */
	private async _generateMindmapAfterImport(): Promise<void> {
		if (!this._activeVault) { return; }
		// 延迟执行，确保文件系统已落盘
		await new Promise(r => setTimeout(r, 600));
		try {
			if (!this._mindmapGenerator) {
				this._mindmapGenerator = new KbMindmapGenerator(
					this.fileService, this.logService,
				);
			}
			const notesDir = this.sectionUri(this._activeVault, 'notes');

		// 增量策略：只取 mtime ≤ 5 分钟前的文件（刚导入/构建的）；少于 3 条时回退扫描全量
		// 扫描源为「笔记分区」而非「库分区」：HTML 等导入经「构建为笔记」后结构化内容落在
		// notes/（概念/对比/…），库分区往往只剩原始 .html，若只扫库分区会导致 libFiles 为空、
		// 思维导图永远不生成（此前 bug）。
		const recentCutoff = Date.now() - 5 * 60_000;
		const noteFiles: { fileName: string; content: string }[] = [];
		try {
			const st = await this.fileService.resolve(notesDir);
			const walk = async (d: typeof st) => {
				if (!d.children) { return; }
				for (const c of d.children) {
					if (c.isDirectory && !c.name.startsWith('.')) {
						try { await walk(await this.fileService.resolve(c.resource)); } catch { /* skip */ }
					} else if (!c.isDirectory && c.name.endsWith('.md')) {
						const isRecent = (c.mtime ?? 0) > recentCutoff;
						if (!isRecent) { continue; }
						try {
							const raw = await this.fileService.readFile(c.resource);
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
							try { await fullWalk(await this.fileService.resolve(c.resource)); } catch { /* skip */ }
						} else if (!c.isDirectory && c.name.endsWith('.md')) {
							try {
								const raw = await this.fileService.readFile(c.resource);
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
			const existingMap = await this._mindmapGenerator.listMindmaps(notesDir);
			let existingUri: URI | undefined;
			if (existingMap.size > 0) {
				// 优先使用 mindmap.canvas，其次第一个
				existingUri = existingMap.get('mindmap.canvas') ?? existingMap.values().next().value;
			}

			// 获取 LLM 模型
			const chatModel = await this._getOrCreateChatModel();
			if (!chatModel) { return; }

		const result = await this._mindmapGenerator.generateOrUpdate(
			chatModel, notesDir, noteFiles, existingUri,
		);
			if (result) {
				this.logService.info(`[mindmap] updated ${result.fsPath}`);
				await this.refreshSection('notes');
			}
		} catch (err) {
			this.logService.warn(`[mindmap] generation failed: ${err}`);
		}
	}

	/** 获取 LLM ChatModel（复用 AgentStudioService.createKbChatModel 链）。
	 *  优先 agentStudioService，回退到本地配置解析。 */
	private async _getOrCreateChatModel(): Promise<IChatModel | null> {
		try {
			const svc = this.agentStudioService as unknown as { createKbChatModel?: () => IChatModel | null };
			const model = svc.createKbChatModel?.();
			if (model) { return model; }
		} catch { /* fall through */ }
		return null;
	}

	override focus(): void {
		super.focus();
		this._scroll?.focus();
	}

	// ═══════════════════════════════════════════════════════════
	//  Context menus
	// ═══════════════════════════════════════════════════════════

	private nodeContextMenu(e: MouseEvent, el: HTMLElement, node: IKbNode): void {
		// 右键命中多选集合中的节点 → 弹多选批量菜单（不折叠选择），对齐原树层多选菜单
		if (this._domSelectedPaths.size > 1 && this._domSelectedPaths.has(node.path)) {
			this._nodeMultiContextMenu(e, node);
			return;
		}
		this.selectNode(el);
		const pasteTarget = node.isDirectory ? node : this._resolvePasteTargetDir(node);
		const canPaste = !!this._kbClipboard?.uris.length;
		const actions: IAction[] = [
			// navigation：新建
			new Action('kb.newFile', localize('kb.newFile', '新建文件'), undefined, true, () => { void this.newFile(node.section, node.isDirectory ? node : undefined); }),
			new Action('kb.newFolder', localize('kb.newFolder', '新建文件夹'), undefined, true, () => { void this.newFolder(node.section, node.isDirectory ? node : undefined); }),
			new Separator(),
		];
		// 打开 / 在系统资源管理器显示
		if (!node.isDirectory) {
			actions.push(new Action('kb.open', localize('kb.open', '打开'), undefined, true, () => this.openInEditor(node)));
		}
		actions.push(new Action('kb.revealInOS', localize('kb.revealInOS', '在系统资源管理器中显示'), undefined, true, () => this._kbRevealInOS(node)));
		// 剪贴板
		actions.push(
			new Separator(),
			new Action('kb.cut', localize('kb.cut', '剪切'), undefined, true, () => this._kbCopyToClipboard(true, node.path)),
			new Action('kb.copy', localize('kb.copy', '复制'), undefined, true, () => this._kbCopyToClipboard(false, node.path)),
			new Action('kb.paste', localize('kb.paste', '粘贴'), undefined, canPaste, () => { if (pasteTarget) { void this._kbPaste(pasteTarget); } }),
			new Separator(),
			new Action('kb.copyPath', localize('kb.copyPath', '复制路径'), undefined, true, () => this._kbCopyPath(node, false)),
			new Action('kb.copyRelPath', localize('kb.copyRelPath', '复制相对路径'), undefined, true, () => this._kbCopyPath(node, true)),
			new Separator(),
			new Action('kb.rename', localize('kb.rename', '重命名'), undefined, true, () => this.startRename(el, node)),
			new Action('kb.delete', localize('kb.delete', '删除'), undefined, true, () => { void this.deleteNode(node); }),
			new Action('kb.deletePerm', localize('kb.deletePerm', '永久删除'), undefined, true, () => { void this._deleteNodePermanent(node); }),
		);
		// KB 专有动作
		if (!node.isDirectory && node.section === 'library') {
			actions.push(new Separator(), new Action('kb.buildNote', '构建为笔记', undefined, true, () => { void this._buildNoteFromLibrary(node); }));
		}
		if (!node.isDirectory && node.section === 'notes') {
			actions.push(new Action('kb.moveToReview', '移入审核', undefined, true, () => { void this._moveToReview(node); }));
		}
		// 笔记区 .canvas 思维导图：补充完善 / 按内容重命名
		if (!node.isDirectory && node.name.endsWith('.canvas') && node.section === 'notes') {
			actions.push(
				new Separator(),
				new Action('kb.supplementCanvas', '补充/完善思维导图', undefined, true, () => { void this._supplementMindmap(node); }),
				new Action('kb.optimizeCanvasName', '按内容重命名', undefined, true, () => { void this._optimizeMindmapName(node); }),
			);
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => actions,
		});
	}

	/** 多选右键菜单：批量剪切/复制/粘贴/删除/永久删除 + 多 .canvas 合并思维导图。 */
	private _nodeMultiContextMenu(e: MouseEvent, anchorNode: IKbNode): void {
		const nodes: IKbNode[] = [];
		for (const p of this._domSelectedPaths) {
			const elx = this.findNodeEl(this.sectionOfPath(p), p);
			const n = elx ? this.nodeFromEl(elx) : null;
			if (n) { nodes.push(n); }
		}
		if (!nodes.length) { return; }
		const selPaths = nodes.map(n => n.path);
		const pasteTarget = this._resolvePasteTargetDir(anchorNode);
		const canPaste = !!this._kbClipboard?.uris.length;
		const actions: IAction[] = [
			new Action('kb.cut', `剪切 (${nodes.length} 项)`, undefined, true, () => this._kbCopyToClipboard(true, undefined, selPaths)),
			new Action('kb.copy', `复制 (${nodes.length} 项)`, undefined, true, () => this._kbCopyToClipboard(false, undefined, selPaths)),
			new Action('kb.paste', '粘贴', undefined, canPaste, () => { if (pasteTarget) { void this._kbPaste(pasteTarget); } }),
			new Separator(),
			new Action('kb.delete', `删除 (${nodes.length} 项)`, undefined, true, () => { void this._batchDeleteNodes(nodes); }),
			new Action('kb.deletePerm', `永久删除 (${nodes.length} 项)`, undefined, true, () => { void this._batchDeleteNodesPermanent(nodes); }),
		];
		// 多选 .canvas 思维导图：合并为一个
		const canvasFiles = nodes.filter(s => !s.isDirectory && s.name.endsWith('.canvas'));
		if (canvasFiles.length >= 2 && canvasFiles.every(s => s.section === 'notes')) {
			actions.push(new Separator());
			actions.push(new Action('kb.mergeCanvas', `合并思维导图 (${canvasFiles.length} 个)`, undefined, true, () => { void this._mergeCanvasFiles(canvasFiles); }));
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => actions,
		});
	}

	private showSimpleMenu(items: { label: string; run: () => void }[], x?: number, y?: number): void {
		const dd = $('div.kb-dropdown');
		dd.style.position = 'fixed';
		for (const it of items) {
			const opt = $('div.kb-opt'); opt.textContent = it.label;
			opt.onclick = (e) => { e.stopPropagation(); dd.remove(); it.run(); };
			dd.appendChild(opt);
		}
		// 挂在视图自身的主题容器内（而非 document.body），确保 --vscode-* 主题变量可解析，
		// 否则菜单会因背景变量失效而显示为透明。
		(this.element as HTMLElement).appendChild(dd);
		dd.classList.add('show');
		const rect = dd.getBoundingClientRect();
		dd.style.left = `${Math.min(x ?? 100, window.innerWidth - rect.width - 8)}px`;
		dd.style.top = `${Math.min(y ?? 100, window.innerHeight - rect.height - 8)}px`;
		const close = () => { dd.remove(); document.removeEventListener('click', close); };
		setTimeout(() => document.addEventListener('click', close), 0);
	}

	// ═══════════════════════════════════════════════════════════
	//  Helpers
	// ═══════════════════════════════════════════════════════════

	private positionDropdown(dd: HTMLElement, anchor: HTMLElement): void {
		// 改挂到视图根容器（与 showSimpleMenu 对齐），保证 _body 不设 position: relative 时仍正确渲染
		(this.element as HTMLElement).appendChild(dd);
		const btnRect = anchor.getBoundingClientRect();
		dd.style.position = 'fixed';
		// 右对齐到按钮右边缘
		dd.style.right = `${Math.max(8, window.innerWidth - btnRect.right)}px`;
		// 顶部对齐到按钮底部
		dd.style.top = `${btnRect.bottom}px`;
		// 防止下拉过宽溢出左边界：用 activitybar 右侧作为下拉 left 的最小边界
		const abRight = (document.querySelector('.activitybar') as HTMLElement | null)?.getBoundingClientRect().right ?? 0;
		const availableWidth = window.innerWidth - Math.max(8, abRight + 8) - Math.max(8, window.innerWidth - btnRect.right);
		dd.style.maxWidth = `${Math.max(260, availableWidth)}px`;
		// 渲染后再次校正：若左侧仍被 activitybar 覆盖，则左移（右减 small）
		const ddRect = dd.getBoundingClientRect();
		if (ddRect.left < abRight) {
			dd.style.right = `${Math.max(8, window.innerWidth - btnRect.right + (abRight - ddRect.left))}px`;
		}
		// 顶部越界保护
		if (btnRect.bottom + ddRect.height > window.innerHeight - 8) {
			dd.style.top = `${Math.max(8, window.innerHeight - ddRect.height - 8)}px`;
		}
	}

	private cssEscape(s: string): string {
		return s.replace(/["\\]/g, '\\$&');
	}

	private findNodeEl(section: KbSection, path: string): HTMLElement | null {
		return this._scroll.querySelector(`.kb-section-body[data-section="${section}"] .kb-node[data-path="${this.cssEscape(path)}"]`) as HTMLElement | null;
	}

	private nodeFromEl(el: HTMLElement): IKbNode | null {
		const path = el.dataset.path;
		if (!path || !this._activeVault) { return null; }
		return {
			name: (el.querySelector('.kb-name') as HTMLElement)?.textContent ?? '',
			path,
			uri: URI.file(path),
			isDirectory: el.classList.contains('dir'),
			section: (el.closest('.kb-section-body') as HTMLElement)?.dataset.section as KbSection ?? 'notes',
			size: 0, mtime: 0, ctime: 0, childCount: 0,
		};
	}

	/**
	 * 增量移除已删除节点：只移除对应 DOM 元素并重算计数，绝不整段 replaceChildren 重建。
	 * 对齐 Explorer 的增量刷新（删除单个 tree element + 刷新其父节点），消除删除抖动。
	 * 文件监听引发的重复刷新已由 B 档「事件中枢」改为靶向增量刷新（见 _reloadForFileChanges），无需抑制窗。
	 */
	private _removeNodeFromDom(node: IKbNode): void {
		const section = node.section;
		const body = this._scroll.querySelector(`.kb-section-body[data-section="${section}"]`) as HTMLElement | null;
		if (!body) { return; }
		// 移除元素（目录则其嵌套后代一并移除）
		const el = this.findNodeEl(section, node.path);
		if (el) {
			// 目录：清理所选集合中的嵌套后代路径
			if (node.isDirectory) {
				for (const c of Array.from(el.querySelectorAll('.kb-node'))) {
					const cp = (c as HTMLElement).dataset.path as string | undefined;
					if (cp) { this._domSelectedPaths.delete(cp); }
				}
				// 子节点渲染在紧随其后的 .kb-children 兄弟容器（见 expandFolder 的 el.after），
				// 删除目录时必须一并移除该容器，否则子文件夹/子文件残留在视图中（看似未删除）。
				const childrenEl = el.nextElementSibling as HTMLElement | null;
				if (childrenEl && childrenEl.classList.contains('kb-children')) {
					childrenEl.remove();
				}
			}
			if (el.parentElement) { el.parentElement.removeChild(el); }
		}
		// 清理选择状态与上次选中
		this._domSelectedPaths.delete(node.path);
		if (this._domLastSelectedPath === node.path) { this._domLastSelectedPath = null; }
		// 重算计数：等于 body 顶层 .kb-node 数量（vault 节点 + 关联文件夹 + 工作区分组均为顶层 .kb-node，与原 countNodes+linkCount 等价）
		// 嵌套展开的子项位于 .kb-children 内，不计入顶层，故与 section 计数语义一致。
		const topCount = Array.from(body.children).filter(c => (c as HTMLElement).classList?.contains('kb-node')).length;
		const countEl = body.parentElement?.querySelector('.kb-count') as HTMLElement | null;
		if (countEl) { countEl.textContent = String(topCount); }
		// 分区变空时显示空态
		if (topCount === 0 && !body.querySelector('.kb-empty-inline')) {
			const empty = $('div.kb-empty-inline'); empty.textContent = '暂无内容';
			body.replaceChildren(empty);
		}
	}

	/**
	 * 增量刷新某目录的「直接子节点」（对齐 Explorer 的「刷新父节点」）：只对该目录的 .kb-children 容器
	 * 重新 listChildren 并重渲染，绝不做整段分区 replaceChildren；已展开的子目录 DOM 子树被保留复用，
	 * 因此开销仅为「单次 listChildren + 单容器重渲染」，消除 newFile/rename/move 的整段重建抖动。
	 * folderPath=null 表示分区根（刷新 body 顶层，并保留关联文件夹行与已展开子树）。
	 * 未展开（无 .kb-children 容器）的目录直接跳过——折叠子树不显示内容，无需刷新（与 Explorer 一致）。
	 */
	private async _reloadChildren(section: KbSection, folderPath: string | null): Promise<void> {
		if (!this._activeVault) { return; }
		const body = this._scroll.querySelector(`.kb-section-body[data-section="${section}"]`) as HTMLElement | null;
		if (!body) { return; }
		const container: HTMLElement | null = folderPath === null
			? body
			: (() => {
				const el = this.findNodeEl(section, folderPath);
				const sib = el?.nextElementSibling as HTMLElement | null;
				return (sib && sib.classList.contains('kb-children')) ? sib : null;
			})();
		if (!container) { return; }

		const parentUri = folderPath === null ? this.sectionUri(this._activeVault!, section) : URI.file(folderPath);
		let nodes: IKbNode[];
		try { nodes = await this.listChildren(parentUri, section); }
		catch { return; }

		// 保留已展开子目录的 DOM 子树（仅重列「直接子节点」，不做递归重建）
		const preserved = new Map<string, HTMLElement>();
		for (const child of Array.from(container.children) as HTMLElement[]) {
			if (child.classList.contains('kb-node') && child.classList.contains('dir') && this._expandedFolders.has(child.dataset.path ?? '')) {
				const kids = child.nextElementSibling as HTMLElement | null;
				if (kids && kids.classList.contains('kb-children')) { preserved.set(child.dataset.path ?? '', kids); }
			}
		}
		// 顶层刷新时还需保留关联条目行：单独关联文件夹（.kb-linked）与工作区分组（.kb-linked-ws，
		// 其子项在自身内部而非 sibling）。二者都是 body 直接子级，且 classList 精确匹配互不包含，必须分别判定。
		const linkedEls = folderPath === null
			? (Array.from(body.children) as HTMLElement[]).filter(c => c.classList.contains('kb-linked') || c.classList.contains('kb-linked-ws'))
			: [];

		const depth = folderPath === null ? 0 : (this.depthOf(container.previousElementSibling as HTMLElement) + 1);
		if (nodes.length === 0) {
			// 对齐原渲染的空态文案（顶层「暂无内容」/ 子目录「空文件夹」）
			const empty = $('div.kb-empty-inline');
			if (folderPath === null) { empty.textContent = '暂无内容'; } else { empty.style.paddingLeft = '20px'; empty.textContent = '空文件夹'; }
			container.replaceChildren(empty);
		} else {
			await this._appendNodesChunked(container, nodes, depth);
		}

		// 恢复已展开子目录的 DOM
		for (const n of nodes) {
			if (n.isDirectory && preserved.has(n.path)) {
				const el = this.findNodeEl(section, n.path);
				if (el && el.parentElement) { el.insertAdjacentElement('afterend', preserved.get(n.path)!); }
			}
		}
		// 顶层刷新：重新挂回关联条目行并同步计数徽章
		if (folderPath === null) {
			if (linkedEls.length > 0) {
				// 有关联条目时不应残留「暂无内容」占位
				body.querySelector('.kb-empty-inline')?.remove();
				for (const l of linkedEls) { body.appendChild(l); }
			}
			// 计数口径与 _removeNodeFromDom 一致：body 顶层 .kb-node 数（vault 节点 + 关联文件夹 + 工作区分组）
			const topCount = (Array.from(body.children) as HTMLElement[]).filter(c => c.classList?.contains('kb-node')).length;
			const countEl = body.parentElement?.querySelector('.kb-count') as HTMLElement | null;
			if (countEl) { countEl.textContent = String(topCount); }
		}
	}

	/** 路径比较归一化（与 sectionOfPath 同口径：统一斜杠 + 小写，兼容 Windows 盘符大小写差异）。 */
	private _normPath(p: string): string {
		return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	}

	/** 分区根路径（用于判断某路径的父级是否为分区根，从而把刷新键归一到 null）。 */
	private _sectionRootPath(section: KbSection): string {
		return this._activeVault ? this.sectionUri(this._activeVault, section).fsPath : '';
	}

	/** 把子节点路径换算成「父目录刷新键」：父级是分区根则返回 null，否则返回父目录路径。 */
	private _parentReloadKey(section: KbSection, childPath: string): string | null {
		const parent = URI.joinPath(URI.file(childPath), '..').fsPath;
		return this._normPath(parent) === this._normPath(this._sectionRootPath(section)) ? null : parent;
	}

	/**
	 * 移动/复制后的靶向增量刷新（替代 _refreshAllSections 重建所有分区）：
	 * 只重列「目标目录」与「各源文件所在父目录」的直接子节点；跨分区时按各路径所属分区分别刷新。
	 */
	private async _reloadAfterMove(section: KbSection, targetDirNode: IKbNode, children: URI[]): Promise<void> {
		const toReload = new Map<KbSection, Set<string | null>>();
		const add = (sec: KbSection, key: string | null) => {
			if (!toReload.has(sec)) { toReload.set(sec, new Set()); }
			toReload.get(sec)!.add(key);
		};
		// 目标目录：真实目录刷新其 .kb-children；分区根伪节点刷新顶层
		const targetIsRoot = this._normPath(targetDirNode.path) === this._normPath(this._sectionRootPath(section));
		add(section, targetDirNode.isDirectory && !targetIsRoot ? targetDirNode.path : null);
		// 各源/副本所在父目录
		for (const c of children) {
			const sec = this.sectionOfPath(c.fsPath);
			add(sec, this._parentReloadKey(sec, c.fsPath));
		}
		for (const [sec, keys] of toReload) {
			for (const key of keys) { await this._reloadChildren(sec, key); }
		}
	}

	/** DOM 层文件名过滤：按名称匹配显隐节点；目录在其自身或后代匹配时保留可见（对齐原 KbTreeFilter 行为）。 */
	private _applyDomFilenameFilter(query: string): void {
		const q = query.trim().toLowerCase();
		for (const body of Array.from(this._scroll.querySelectorAll('.kb-section-body[data-section]'))) {
			const nodes = Array.from(body.querySelectorAll('.kb-node')) as HTMLElement[];
			// 先按名称匹配标记文件节点
			const visible = new Map<HTMLElement, boolean>();
			for (const el of nodes) {
				const name = (el.querySelector('.kb-name')?.textContent ?? '').toLowerCase();
				visible.set(el, !q || name.includes(q));
			}
			// 目录：自身匹配或任一后代可见则保留（保证匹配项的祖先链可见）
			for (const el of nodes) {
				if (!el.classList.contains('dir')) { continue; }
				if (visible.get(el)) { continue; }
				const descendantVisible = Array.from(el.querySelectorAll('.kb-node')).some(c => visible.get(c as HTMLElement));
				visible.set(el, descendantVisible);
			}
			for (const el of nodes) { el.style.display = visible.get(el) ? '' : 'none'; }
		}
	}

	private applyFilter(_q: string): void {
		const q = _q.trim().toLowerCase();
		// 文件名模式：由 _applyDomFilenameFilter 处理树内过滤，不需要全文搜索路径
		if (this._searchMode === 'filename') {
			// 清除全文搜索结果
			const fr = this._scroll.querySelector('.kb-search-results') as HTMLElement | null;
			if (fr) { fr.classList.remove('show'); fr.replaceChildren(); }
			// 显示分区树，让树 filter 自行过滤可见性
			this._scroll.querySelectorAll('.kb-section').forEach(s => (s as HTMLElement).style.display = '');
			if (this._backlinksEl) { this._backlinksEl.style.display = ''; }
			this._applyDomFilenameFilter(q);
			return;
		}
		let resultsEl = this._scroll.querySelector('.kb-search-results') as HTMLElement | null;
		if (!q) {
			// 清空搜索：取消待处理搜索 + 恢复分区树
			if (this._searchDebounceTimer) { clearTimeout(this._searchDebounceTimer); this._searchDebounceTimer = undefined; }
			this._scroll.querySelectorAll('.kb-section').forEach(s => (s as HTMLElement).style.display = '');
			if (resultsEl) { resultsEl.classList.remove('show'); resultsEl.replaceChildren(); }
			if (this._backlinksEl) { this._backlinksEl.style.display = ''; }
			// 文件名模式下残留的过滤 → 清空恢复全部可见
			this._applyDomFilenameFilter('');
			return;
		}
		// 隐藏分区树，展示搜索结果容器
		this._scroll.querySelectorAll('.kb-section').forEach(s => (s as HTMLElement).style.display = 'none');
		if (this._backlinksEl) { this._backlinksEl.style.display = 'none'; }
		if (!resultsEl) {
			resultsEl = $('div.kb-search-results');
			this._scroll.appendChild(resultsEl);
		}
		resultsEl.classList.add('show');

		// 防抖 200ms：大库经 SQLite FTS5（主进程 IPC）避免逐键触发
		if (this._searchDebounceTimer) { clearTimeout(this._searchDebounceTimer); }
		this._searchDebounceTimer = setTimeout(() => {
			this._searchDebounceTimer = undefined;
			// 防抖期间搜索框可能已被清空 → 跳过过期搜索
			const currentQ = (this._searchInput as HTMLInputElement)?.value?.trim()?.toLowerCase() ?? '';
			if (currentQ !== q) { return; }
			void this.runSearch(q, resultsEl!);
		}, 200);
	}

	private async runSearch(q: string, resultsEl: HTMLElement): Promise<void> {
		const token = ++this._searchToken;
		if (!this._activeVault) { return; }
		const head = $('div.kb-search-head'); head.textContent = `搜索「${q}」中…`; resultsEl.replaceChildren(head);
		const matches = await this.searchFiles(q);
		if (token !== this._searchToken) { return; } // 已被新的搜索取代，丢弃过期结果
		resultsEl.replaceChildren();
		const h = $('div.kb-search-head');
		h.textContent = `找到 ${matches.length} 个结果（库 + 笔记）`;
		resultsEl.appendChild(h);
		if (matches.length === 0) {
			const empty = $('div.kb-empty-inline'); empty.textContent = '无匹配内容';
			resultsEl.appendChild(empty);
		} else {
			for (const m of matches) { resultsEl.appendChild(this.renderSearchHit(m, q)); }
		}
		// 语义检索融合：向量索引已构建时追加「语义相关」区块
		void this._appendVectorHits(q, resultsEl, token);
	}

	/** 全文检索（Tier 3：kernel 优先，回退本地索引）。 */
	private async searchFiles(q: string): Promise<IKbSearchHit[]> {
		if (!this._activeVault) { return []; }
		return this._searchFilesKernel(q);
	}

	/**
	 * 尝试从外部目录加载预建索引到当前 Vault。
	 *
	 * 场景：飞书知识库包携带 .ftindex.json / .kbkernel.json，安装后调用此方法
	 * 将索引复制到 Vault 根目录并加载，**跳过全量文件扫描与索引重建**。
	 *
	 * @param sourceDir 预建索引所在目录（即 knowledgeInstaller.install 的 targetDir）
	 * @returns true 表示索引有效并已加载，false 表示需要回退到 rebuildSearchAssets()
	 */
	async tryLoadPrebuiltIndex(sourceDir: URI): Promise<boolean> {
		if (!this._activeVault) { return false; }
		const vaultRoot = this.vaultUri(this._activeVault);
		const sourceFts = URI.joinPath(sourceDir, '.ftindex.json');

		if (!await this.fileService.exists(sourceFts)) {
			return false;
		}

		try {
			const raw = (await this.fileService.readFile(sourceFts)).value.toString();
			const v = await KbFullTextIndex.validateIndex(raw, this.fileService);
			if (v.valid === 0 || v.valid / v.total < 0.7) {
				this.logService.warn(`[KB] prebuilt index too stale (${v.valid}/${v.total} valid, ${v.stale} stale, ${v.missing} missing)`);
				return false;
			}

			// Copy index files to vault root (overwrite stale cache)
			const destFts = URI.joinPath(vaultRoot, '.ftindex.json');
			await this.fileService.copy(sourceFts, destFts, true);

			const sourceKernel = URI.joinPath(sourceDir, '.kbkernel.json');
			if (await this.fileService.exists(sourceKernel)) {
				const destKernel = URI.joinPath(vaultRoot, '.kbkernel.json');
				await this.fileService.copy(sourceKernel, destKernel, true);
			}

			// Load into running FTS + kernel (reconcile will handle any mismatches)
			await this.rebuildSearchAssets();
			this._searchDirty = false;

			this.logService.info(`[KB] loaded prebuilt index from ${sourceDir.fsPath}: ${v.valid}/${v.total} docs valid`);
			return true;
		} catch (err) {
			this.logService.warn('[KB] failed to load prebuilt index', err);
			return false;
		}
	}

	/**
	 * 重建全文索引与双链图谱。
	 * 大库（> KB_SQLITE_AUTO_THRESHOLD 文档）走 SQLite FTS5 增量同步，跳过内存倒排
	 * 索引的全量构建——内存索引对 28000 文件是 GB 级，主线程全量构建会冻结 UI 数十分钟。
	 * 增量同步只重读 mtime > SQLite 最大 mtime 的变更文件，后续打开秒级完成。
	 * 小库保持内存 BM25 + Worker 提及/图谱路径。
	 */
	private async rebuildSearchAssets(): Promise<void> {
		if (!this._activeVault) { return; }
		// 清待处理的防抖定时器（手动调用时取消延迟重建）
		if (this._searchRebuildTimer) { clearTimeout(this._searchRebuildTimer); this._searchRebuildTimer = undefined; }
		const t0 = performance.now();
		const vaultRoot = this.vaultUri(this._activeVault);
		const roots = this.buildRoots();

		// 关系图谱只覆盖库/笔记分区的 md 双链，与关联的代码仓库无关，
		// 因此不受 _largeRepo 影响，始终基于库+笔记根目录构建（体量很小，开销可忽略）。
		await this._buildNoteGraph();

		// 先做一次仅 stat 的元数据遍历，判定是否大库
		const metas = this._nativeKernel ? await this._nativeKernel.collectDocMetas(roots) : [];
		const isLarge = metas.length > KnowledgeBaseViewPane.KB_SQLITE_AUTO_THRESHOLD;
		this._largeRepo = isLarge;

		if (isLarge) {
			try {
				const t1 = performance.now();
				await this._rebuildLargeRepoSqlite(metas);
				this.logService.info(`[KB perf] large-repo SQLite incremental sync: ${(performance.now() - t1).toFixed(1)}ms (${metas.length} docs)`);
				this._kbKernelService.setBuildContext(roots, URI.joinPath(vaultRoot, '.kbkernel.json'));
			} catch (err) {
				this.logService.warn(`[KB] large-repo rebuild failed: ${err}`);
			}
			this._searchDirty = false;
			this.logService.info(`[KB perf] rebuildSearchAssets total: ${(performance.now() - t0).toFixed(1)}ms (large-repo, SQLite)`);
			return;
		}

		try {
			const kernelCache = URI.joinPath(vaultRoot, '.kbkernel.json');

			// 懒初始化 Worker 管理器
			if (!this._kbWorker) {
				this._kbWorker = new KbWorkerManager(this.logService, this.fileService);
			}

			// 尝试 Worker 模式：FTS 在主线程，提及索引+图谱移到独立线程
			const workerReady = await this._kbWorker.ensureWorker();
			if (workerReady && this._nativeKernel) {
				const t1 = performance.now();
				// 主线程仅做 FTS 索引构建（需要 IFileService 读文件）
				await this._nativeKernel.build(roots, kernelCache, { skipOffloads: true });
				this.logService.info(`[KB perf] _nativeKernel.build (FTS only, Worker mode): ${(performance.now() - t1).toFixed(1)}ms`);

				// 从 FTS 获取全部文档
				const docs = this._nativeKernel.allDocs();
				const workerDocs = docs.map(d => ({
					uri: d.uri,
					name: d.name,
					text: d.text,
					mtime: d.mtime,
					size: d.size,
				}));

				if (workerDocs.length > 0) {
					const wt1 = performance.now();
					// Worker 分批构建提及索引 + 图谱（避免一次性克隆全量文档文本 OOM）
					const { mention: mentionEntries, graph: graphData } = await this._kbWorker.buildMentionAndGraph(workerDocs);
					const wt2 = performance.now();
					this.logService.info(`[KB perf] Worker mention+graph: ${(wt2 - wt1).toFixed(1)}ms (${workerDocs.length} docs)`);

					// 注入 Worker 结果到内核
					this._nativeKernel.injectMentionIndex(mentionEntries, workerDocs);
					this._nativeKernel.injectGraph(graphData);
				}
			} else {
				// Fallback: 主线程构建 FTS；提及索引+图谱延迟到首次反链访问时按需构建
				const t1 = performance.now();
				await this._nativeKernel?.build(roots, kernelCache, { skipOffloads: true });
				this._mentionPending = true; // 提及索引延迟到 _ensureMentionIndex
				this.logService.info(`[KB perf] _nativeKernel.build (main thread, lazy mention): ${(performance.now() - t1).toFixed(1)}ms`);
			}

			this._kbKernelService.setBuildContext(roots, kernelCache);
			const t2 = performance.now();
			// 同步旧索引/图谱引用（从内核内存借数据，零额外 I/O）
			this._syncFromKernel();
			this.logService.info(`[KB perf] _syncFromKernel: ${(performance.now() - t2).toFixed(1)}ms`);

			// Phase 4：大库自动切主进程 SQLite FTS5
			void this._syncKbToSqliteIfNeeded(this._activeVault, this._nativeKernel?.allDocs() ?? []);
		} catch (err) {
			this.logService.warn(`[KB] rebuildSearchAssets failed: ${err}`);
		}
		this._searchDirty = false;
		this.logService.info(`[KB perf] rebuildSearchAssets total: ${(performance.now() - t0).toFixed(1)}ms`);
	}

	/**
	 * 大库重建：仅用 SQLite FTS5 做增量同步（不构建内存倒排索引，避免主线程冻结）。
	 * 读取元数据后只重读 mtime > SQLite 最大 mtime 的变更文件；并删除已从磁盘移除的文档。
	 * 无变更时仅做 stat 遍历 + 一次 max(mtime) 查询，秒级完成。
	 */
	private async _rebuildLargeRepoSqlite(metas: { uri: URI; name: string; section: KbSection; mtime: number; size: number }[]): Promise<void> {
		const vault = this._activeVault!;
		if (!this._kbSqliteStore) {
			try {
				this._kbSqliteStore = createKbSqliteStoreProxy(this._mainProcessService);
				await this._kbSqliteStore.open(URI.joinPath(this.vaultUri(vault), 'kb.db').fsPath);
				this.logService.info(`[KB SQLite] opened for large vault: ${vault.name} (${metas.length} docs)`);
			} catch (err) {
				this.logService.warn(`[KB SQLite] init failed: ${err}`);
				this._kbSqliteStore = undefined;
				return;
			}
		}
		// 局部持有 proxy 引用：避免与 _syncToSqlite 等并发路径（其失败时会把共享字段 _kbSqliteStore 置 undefined）竞态，
		// 导致后续 upsertDocsBatch 读取 undefined 属性报错。
		const store: IKbSqliteBackend = this._kbSqliteStore;

		// 增量：比对 DB 现有文档的 mtime+size，只重读变更文件；并删除已从磁盘移除的文档。
		// 一次 getAllUris 查询同时用于变更检测与删除清理。
		const dbDocs = await store.getAllUris();
		const dbMap = new Map<string, { mtime: number; size: number }>();
		for (const d of dbDocs) { dbMap.set(d.uri, { mtime: d.mtime, size: d.size }); }
		const metaSet = new Set(metas.map(m => m.uri.toString()));

		const changed = metas.filter(m => {
			const prev = dbMap.get(m.uri.toString());
			// 新增，或 mtime/size 任一变化 → 视为变更
			return !prev || prev.mtime !== m.mtime || prev.size !== m.size;
		});

		if (changed.length > 0) {
			const docs: IKbSqliteDoc[] = [];
			for (const m of changed) {
				if (m.size > 2 * 1024 * 1024) { continue; }
				try {
					const content = await this.fileService.readFile(m.uri);
					docs.push({ uri: m.uri.toString(), name: m.name, section: m.section, mtime: m.mtime, size: m.size, text: content.value.toString() });
				} catch { /* skip unreadable */ }
				if (docs.length % 64 === 0) { await new Promise<void>(r => setTimeout(r, 0)); }
			}
			if (docs.length > 0) {
				const t = performance.now();
				await store.upsertDocsBatch(docs);
				this.logService.info(`[KB SQLite] synced ${docs.length} changed docs (${(performance.now() - t).toFixed(1)}ms)`);
			}
		} else {
			this.logService.info(`[KB SQLite] no changed docs; incremental sync skipped`);
		}

		// 删除已从磁盘移除的文档（metas 中不存在的 DB 记录）
		try {
			let removed = 0;
			for (const u of dbDocs) {
				if (!metaSet.has(u.uri)) { await store.deleteDoc(u.uri); removed++; }
			}
			if (removed > 0) { this.logService.info(`[KB SQLite] removed ${removed} deleted docs`); }
		} catch (err) {
			this.logService.warn(`[KB SQLite] deletion sweep failed: ${err}`);
		}
		this._sqliteSyncMtime = Date.now();
	}

	/** 从 KbNativeKernel 同步 FTS 文档和图谱到旧引用变量（零 I/O）。 */
	private _syncFromKernel(): void {
		const docs = this._nativeKernel?.allDocs() ?? [];
		if (docs.length === 0) return;
		for (const d of docs) {
			this._index.updateDoc(d.uri, d.name, d.section as KbSection, d.mtime, d.size, d.text);
		}
		// 大库 SQLite 模式：搜索走 FTS5，图谱不需要实时更新（反链面板按需延迟加载）
		if (!this._kbSqliteStore) {
			this._graph.buildFromDocs(docs as { uri: URI; name: string; section: KbSection; mtime: number; text: string }[]);
		}
	}

	/** 标记索引 / 图谱失效，防抖 300ms 后触发重建（避免串行操作重复重建）。 */
	private markSearchDirty(): void {
		this._searchDirty = true;
		if (this._searchRebuildTimer) { clearTimeout(this._searchRebuildTimer); }
		this._searchRebuildTimer = setTimeout(() => {
			this._searchRebuildTimer = undefined;
			void this.rebuildSearchAssets();
		}, 300);
	}

	private renderSearchHit(hit: IKbSearchHit, q: string): HTMLElement {
		const el = $('div.kb-search-hit');
		const icon = this._fileIconEl(hit); el.appendChild(icon);
		const name = $('span.kb-name');
		// 名称命中：高亮匹配片段
		const idx = hit.name.toLowerCase().indexOf(q);
		if (idx >= 0 && hit.matchedBy === 'name') {
			name.append(
				document.createTextNode(hit.name.slice(0, idx)),
				Object.assign(document.createElement('mark'), { textContent: hit.name.slice(idx, idx + q.length) }),
				document.createTextNode(hit.name.slice(idx + q.length)),
			);
		} else {
			name.textContent = hit.name;
		}
		el.appendChild(name);
		const badge = $('span.kb-hit-badge'); badge.textContent = hit.matchedBy === 'name' ? '名称' : '正文';
		el.appendChild(badge);
		const path = $('span.kb-hit-path');
		const vaultRoot = this._activeVault ? this.vaultUri(this._activeVault).fsPath : '';
		path.textContent = hit.path.replace(vaultRoot, '').replace(/\\/g, '/');
		el.appendChild(path);
		if (hit.snippet) {
			const snip = $('div.kb-hit-snippet'); snip.textContent = hit.snippet;
			el.appendChild(snip);
		}
		el.onclick = () => this.openInEditor(hit);
		el.oncontextmenu = (e) => { e.preventDefault(); this.nodeContextMenu(e, el, hit); };
		return el;
	}

	// ═══════════════════════════════════════════════════════════
	//  Backlinks ([[双链]] 反链映射面板)
	// ═══════════════════════════════════════════════════════════

	private async updateBacklinks(node: IKbNode): Promise<void> {
		const el = this._backlinksEl;
		if (!el) { return; }
		if (node.isDirectory) {
			el.replaceChildren();
			const hint = $('div.kb-bl-hint'); hint.textContent = '选择一个文件以查看双链（出链 / 反链）';
			el.appendChild(hint);
			return;
		}

		// Tier 3: 内置内核（含提及）优先，外部 kernel 可选增强
		const { outgoing, back, mentions } = await this._getBacklinksKernel(node);

		el.replaceChildren();
		const header = $('div.kb-bl-header');
		header.textContent = '🔗 双链 📦';
		el.appendChild(header);

		if (outgoing.length === 0 && back.length === 0 && mentions.length === 0) {
			const empty = $('div.kb-bl-empty'); empty.textContent = '暂无双链';
			el.appendChild(empty);
			return;
		}

		if (outgoing.length) {
			const g = $('div.kb-bl-group');
			const t = $('div.kb-bl-title'); t.textContent = `出链 (${outgoing.length})`; g.appendChild(t);
			for (const o of outgoing) {
				const item = $('div.kb-bl-item');
				const ic = $('span.kb-bl-ic'); ic.textContent = o.targetUri ? '→' : '⚠'; item.appendChild(ic);
				const lbl = $('span.kb-bl-label'); lbl.textContent = o.label; item.appendChild(lbl);
				if (o.targetUri) { item.onclick = () => this.openUri(o.targetUri!); }
				else { item.classList.add('missing'); item.title = '库内未找到该笔记'; }
				g.appendChild(item);
			}
			el.appendChild(g);
		}

		if (back.length) {
			const g = $('div.kb-bl-group');
			const t = $('div.kb-bl-title'); t.textContent = `反链 (${back.length})`; g.appendChild(t);
			for (const b of back) {
				const item = $('div.kb-bl-item');
				const ic = $('span.kb-bl-ic'); ic.textContent = '↩'; item.appendChild(ic);
				const lbl = $('span.kb-bl-label'); lbl.textContent = b.name; item.appendChild(lbl);
				if (b.snippet) { const sn = $('div.kb-bl-snippet'); sn.textContent = b.snippet; item.appendChild(sn); }
				item.onclick = () => this.openUri(b.uri);
				g.appendChild(item);
			}
			el.appendChild(g);
		}

		// 提及面板（对齐 SiYuan Backlink.ts 的「提及」列表）
		if (mentions.length) {
			const g = $('div.kb-bl-group');
			const t = $('div.kb-bl-title'); t.textContent = `提及 (${mentions.length})`; g.appendChild(t);
			for (const m of mentions) {
				const item = $('div.kb-bl-item');
				const ic = $('span.kb-bl-ic'); ic.textContent = '💬'; item.appendChild(ic);
				const lbl = $('span.kb-bl-label'); lbl.textContent = m.name; item.appendChild(lbl);
				if (m.snippet) { const sn = $('div.kb-bl-snippet'); sn.textContent = m.snippet; item.appendChild(sn); }
				item.onclick = () => this.openUri(m.uri);
				g.appendChild(item);
			}
			el.appendChild(g);
		}
	}

	private openUri(uri: URI): void {
		const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
		const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
		this.editorService.openEditor({ resource: uri, options: { pinned: true } }, targetGroup);
	}

	// ═══════════════════════════════════════════════════════════
	//  内置内核（KbNativeKernel）— 检索 / 反链 / 图谱
	// ═══════════════════════════════════════════════════════════

	/**
	 * 点击文件 → 在中间栏文件编辑器打开 WYSIWYG 笔记编辑器。
	 * 复用 KbNoteEditorInput / KnowledgeBaseNoteEditorPane（Protyle/Lute 渲染管线）。
	 */
	private _openNoteEditor(node: IKbNode): void {
		const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
		const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
		const resourceKey = node.uri.toString();
		// 复用已打开的同一笔记 input，避免每次点击都 new 一个被丢弃、从未 dispose 的
		// KbNoteEditorInput（造成 LEAKED DISPOSABLE）。
		let input: KbNoteEditorInput | undefined;
		let openInGroup: IEditorGroup | typeof SIDE_GROUP = targetGroup;
		for (const g of groups) {
			for (const ed of g.getEditors(EditorsOrder.SEQUENTIAL)) {
				if (ed instanceof KbNoteEditorInput && ed.resource.toString() === resourceKey) {
					input = ed;
					openInGroup = g;
					break;
				}
			}
			if (input) { break; }
		}
		if (!input) {
			input = new KbNoteEditorInput(node.uri, node.name);
		}
		this.editorService.openEditor(
			input,
			{ pinned: true },
			openInGroup,
		);
	}











	/** 搜索结果融合：向量索引已构建时，追加「语义相关」区块到全文结果下方。 */
	private async _appendVectorHits(q: string, resultsEl: HTMLElement, token: number): Promise<void> {
		try {
			const status = this._kbKernelService.getVectorStatus();
			if (!status.built || status.chunkCount === 0) { return; }
			const hits = await this._kbKernelService.searchVector(q, 5, resolveAuxEmbeddingProviderId(this.configurationService));
			if (token !== this._searchToken) { return; } // 已被新搜索取代
			if (!hits.length) { return; }
			const sep = $('div.kb-search-head'); sep.textContent = `🧠 语义相关 ${hits.length} 条（向量索引）`;
			resultsEl.appendChild(sep);
			for (const h of hits) {
				resultsEl.appendChild(this._renderVectorHit(h));
			}
		} catch {
			// 语义检索失败不影响全文结果展示
		}
	}

	/** 渲染单条向量语义命中。 */
	private _renderVectorHit(hit: IKbVectorSearchHit): HTMLElement {
		const el = $('div.kb-search-hit');
		el.style.borderLeft = '2px solid var(--vscode-textLink-foreground,#3794ff)';
		const icon = $('span.kb-ficon'); icon.textContent = '🧠'; el.appendChild(icon);
		const name = $('span.kb-name'); name.textContent = hit.docName; el.appendChild(name);
		const badge = $('span.kb-hit-badge'); badge.textContent = `${(hit.score * 100).toFixed(0)}%`; el.appendChild(badge);
		const path = $('span.kb-hit-path');
		const vaultRoot = this._activeVault ? this.vaultUri(this._activeVault).fsPath : '';
		path.textContent = hit.docId.replace(vaultRoot, '').replace(/\\/g, '/');
		el.appendChild(path);
		if (hit.text) {
			const snip = $('div.kb-hit-snippet');
			snip.textContent = hit.text.length > 160 ? hit.text.slice(0, 160) + '…' : hit.text;
			el.appendChild(snip);
		}
		el.onclick = () => this.openUri(URI.parse(hit.docId));
		el.oncontextmenu = (e) => { e.preventDefault(); this.openUri(URI.parse(hit.docId)); };
		return el;
	}

	/**
	 * 点击「🕸️ 关系图谱」→ 在中间栏文件编辑器打开独立的关系图谱 EditorPane。
	 * 数据来自已构建的双链图谱（KbLinkGraph.getGraphData），节点单击可在中心
	 * Tab 打开对应笔记，对齐 SiYuan 的 openGraph → 中心 Tab 范式。
	 */
	private async _openGraph(): Promise<void> {
		if (!this._activeVault) { return; }
		try {
			// 关系图谱与搜索索引是两条独立链路：图谱只覆盖库/笔记分区的文档，
			// 直接基于磁盘重建即可（开销很小），不依赖可能失败的搜索索引/Worker 构建，
			// 否则搜索索引构建抛错会让图谱按钮静默无响应。
			if (this._searchDirty) {
				// 先尝试重建搜索索引，失败不影响图谱打开
				this.rebuildSearchAssets().catch(e => this.logService.warn('[KB graph] search index rebuild failed (non-fatal)', e));
			}
			await this._buildNoteGraph();
			const { nodes, links } = this._graph.getGraphData();
			if (nodes.length === 0) {
				this.notificationService.info('知识库暂无可绘制的关系（先导入或创建带双链的笔记）');
				return;
			}
			// 携带库/笔记分区根目录（不含关联的代码仓库），供「关系图谱」EditorPane 内的「构建图谱」按钮重新扫描
			const roots = this.buildGraphRoots();
			const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
			await this.editorService.openEditor(
				new KbGraphEditorInput(nodes, links, '关系图谱', roots),
				{ pinned: true },
				targetGroup,
			);
		} catch (e) {
			this.logService.error('[KB graph] open failed', e);
			this.notificationService.error('打开关系图谱失败：' + (e instanceof Error ? e.message : String(e)));
		}
	}

	/**
	 * 点击「🧠 思维导图」按钮 → 打开或生成 .canvas 思维导图。
	 * 如果已有 mindmap.canvas 文件 → 直接在 CanvasEditorPane 打开；
	 * 否则先触发生成再打开。
	 */
	private async _openMindmap(): Promise<void> {
		if (!this._activeVault) { return; }
		if (!this._mindmapGenerator) {
			this._mindmapGenerator = new KbMindmapGenerator(this.fileService, this.logService);
		}
		try {
			const notesDir = this.sectionUri(this._activeVault, 'notes');
			// 查找已有思维导图
			const existingMap = await this._mindmapGenerator.listMindmaps(notesDir);
			let canvasUri: URI;
			if (existingMap.size > 0) {
				canvasUri = existingMap.get('mindmap.canvas') ?? existingMap.values().next().value!;
			} else {
				// 先生成
				this.notificationService.info('正在生成思维导图…');
				await this._generateMindmapAfterImport();
				// 再次检查
				const retryMap = await this._mindmapGenerator.listMindmaps(notesDir);
				if (retryMap.size === 0) {
					this.notificationService.warn('未找到可生成的内容，请先导入笔记。');
					return;
				}
				canvasUri = retryMap.get('mindmap.canvas') ?? retryMap.values().next().value!;
			}
			await this._openCanvasEditor(canvasUri);
		} catch (err) {
			this.logService.error('[KB mindmap] open failed', err);
			this.notificationService.error('打开思维导图失败：' + (err instanceof Error ? err.message : String(err)));
		}
	}

	/** 关系图谱根目录：仅库+笔记分区（排除关联的代码仓库），供图谱构建与 EditorPane 重扫使用。 */
	private buildGraphRoots(): IKbGraphRoot[] {
		if (!this._activeVault) { return []; }
		return (['library', 'notes'] as KbSection[]).map(s => ({
			uri: this.sectionUri(this._activeVault!, s),
			section: s,
		}));
	}

	/** 构建关系图谱：仅扫描库+笔记分区的 md 文件（双链），与关联的 UE 代码仓库无关，开销很小。 */
	private async _buildNoteGraph(): Promise<void> {
		if (!this._activeVault) { return; }
		await this._graph.build(this.buildGraphRoots());
	}

	// -- Kernel-enhanced search / backlinks (Tier 3) --

	/** 搜索文件：内置内核（BM25，始终可用）。 */
	private async _searchFilesKernel(q: string): Promise<IKbSearchHit[]> {
		return this._searchFilesLocal(q);
	}

	private async _searchFilesLocal(q: string): Promise<IKbSearchHit[]> {
		if (!this._activeVault) { return []; }
		if (this._searchDirty) { await this.rebuildSearchAssets(); }

		// 大库：SQLite FTS5 + 内存 BM25 双源并行查，合并去重
		if (this._kbSqliteStore) {
			try {
				const t0 = performance.now();
				const [sqlResults, bm25Results] = await Promise.all([
					this._searchKbSqlite(q, 20),
					Promise.resolve(this._index.search(q)),
				]);
				const merged = this._mergeSearchResults(sqlResults, bm25Results, 20);
				this.logService.info(`[KB perf] SQLite+BM25 merged search: ${(performance.now() - t0).toFixed(1)}ms, ${merged.length} results`);
				return merged;
			} catch (err) {
				this.logService.warn(`[KB SQLite] search fallback to memory:', ${err}`);
			}
		}

		// 小库 → 内存 BM25
		return this._index.search(q);
	}

	/** 合并双源搜索结果：按 URI 去重，分数归一化后排序。 */
	private _mergeSearchResults(sqlResults: IKbSearchHit[], bm25Results: IKbSearchHit[], maxResults: number): IKbSearchHit[] {
		const seen = new Map<string, IKbSearchHit>();

		// 归一化：SQLite rank 为负数（越小越好），BM25 为正（越高越好）→ 统一为 0-1 降序
		const normalize = (r: IKbSearchHit, source: 'sql' | 'bm25') => {
			if (source === 'sql') {
				// rank 接近 0 最好，转为 1 - signmoid(range)
				r.score = Math.max(0, Math.min(1, 1 - Math.abs(r.score) / 10));
			} else {
				// BM25 分数越大越好，转为 0-1
				r.score = Math.min(1, Math.abs(r.score) / 100);
			}
		};

		for (const r of bm25Results) {
			normalize(r, 'bm25');
			seen.set(r.uri.toString(), r);
		}
		for (const r of sqlResults) {
			normalize(r, 'sql');
			const existing = seen.get(r.uri.toString());
			if (existing) {
				// 保留高分数来源的 snippet
				if (r.score > existing.score) {
					existing.snippet = r.snippet || existing.snippet;
					existing.score = r.score;
				}
			} else {
				seen.set(r.uri.toString(), r);
			}
		}

		return [...seen.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, maxResults);
	}

	/**
	 * 获取反链 + 提及：内置内核（始终可用，含提及）。
	 * 返回结构扩展 mentions 字段（对齐 SiYuan 反链面板的「反链 / 提及」双列表）。
	 */
	private async _getBacklinksKernel(node: IKbNode): Promise<{
		outgoing: { label: string; targetName: string; targetUri?: URI }[];
		back: { uri: URI; name: string; snippet: string; type?: 'ref' | 'mention' }[];
		mentions: { uri: URI; name: string; snippet: string }[];
	}> {
		// 1. vssaros 内置内核（含提及，移植 backlink.go buildTreeBackmention）
		if (this._nativeKernel && this._nativeKernel.isBuilt) {
			// 延迟构建提及索引＋图谱（首次访问反链时按需构建，避免每次 rebuild 都 O(N×K)）
			await this._ensureMentionIndex();
			const docId = node.uri.toString();
			const result: INativeBacklinkResult = await this._nativeKernel.getBacklink2(docId);
			return {
				outgoing: this._nativeKernel.outgoingLinks(docId),
				back: result.backlinks.map(b => ({
					uri: b.uri,
					name: b.name,
					snippet: b.snippet,
					type: b.type,
				})),
				mentions: result.backmentions.map(m => ({
					uri: m.uri,
					name: m.name,
					snippet: m.snippet,
				})),
			};
		}

		// 2. 最终回退：旧版本地图谱（无提及）
		return { ...this._getBacklinksLocal(node), mentions: [] };
	}

	private _getBacklinksLocal(node: IKbNode): { outgoing: { label: string; targetName: string; targetUri?: URI }[]; back: { uri: URI; name: string; snippet: string }[] } {
		const docId = node.uri.toString();
		return {
			outgoing: this._graph.outgoingLinks(docId),
			back: this._graph.backlinks(docId),
		};
	}

	// ═══════════════════════════════════════════════════════════
	//  Unified KB import → knowledge-base-expert agent skills
	// ═══════════════════════════════════════════════════════════

	// ── End of import skill generators ─────────────────────

	override dispose(): void {
		document.removeEventListener('click', this._onGlobalClick);
		if (this._searchRebuildTimer) { clearTimeout(this._searchRebuildTimer); this._searchRebuildTimer = undefined; }
		if (this._searchDebounceTimer) { clearTimeout(this._searchDebounceTimer); this._searchDebounceTimer = undefined; }
		this._kbWorker?.dispose();
		this._kbWorker = undefined;
		super.dispose();
	}
}
