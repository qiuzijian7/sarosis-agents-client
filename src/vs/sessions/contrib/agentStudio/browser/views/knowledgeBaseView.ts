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
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IFileDialogService, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEditorService, SIDE_GROUP } from '../../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService, GroupsOrder, IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { EditorsOrder } from '../../../../../workbench/common/editor.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IRequestService, asText } from '../../../../../platform/request/common/request.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import { IConfigHtmlService } from '../../../../common/agentStudioService.js';
import { IModelSelectorService } from '../../common/modelSelector.js';
import { ISkillRegistry } from '../../common/skills.js';
import { IAgentOSService } from '../../common/agentOS.js';
import { SarosPath, resolveSarosPath } from '../../common/sarosPaths.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { CodebaseGraphViewerEditorInput } from '../codebaseGraphViewerEditorInput.js';
import { KbImportController } from '../kbImportController.js';
import { validateSafeUrl } from '../knowledge/urlSafety.js';
import { UrlIngestCache } from '../knowledge/urlIngestCache.js';
import { sanitizeUrlContent } from '../knowledge/urlContentSanitizer.js';
import { UrlIngestQueue, type QueueItem } from '../knowledge/urlIngestQueue.js';
import { lintVault, formatLintReport } from '../knowledge/kbLint.js';
import { detectDuplicates, formatDedupReport, mergeDuplicates, type DedupGroup } from '../knowledge/dedup.js';
import { writeReviewNote, listReviewNotes, approveReviewNote, routeLintToReview } from '../knowledge/reviewStore.js';
import { CodebaseIndexEditorInput } from '../codebaseIndexEditorInput.js';
import { ICodebaseGraphService } from '../codebaseGraphService.js';

// ─── 原生树组件（VS Code WorkbenchCompressibleAsyncDataTree）───────────
import { ITreeContextMenuEvent } from '../../../../../base/browser/ui/tree/tree.js';
import { WorkbenchCompressibleAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { createFileIconThemableTreeContainerScope } from '../../../../../workbench/contrib/files/browser/views/explorerView.js';
import {
	KbTreeDelegate, KbTreeDataSource, KbNodeRenderer, KbSectionRenderer,
	KbTreeFilter, KbTreeSorter, KbTreeAccessibilityProvider, kbTreeIdentityProvider,
	KbTreeDragAndDrop,
	type KbTreeElement, type IKbTreeSection,
} from './knowledgeBase/kbTreeViewer.js';

function isSectionNode(e: KbTreeElement): e is IKbTreeSection {
	return (e as IKbTreeSection).kind === 'section';
}
import { IIndexConfig, IndexMode, ICodebaseMemoryMcpService } from '../codebaseMemoryMcpService.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { createKbSqliteStoreProxy } from '../kbSqliteStoreProxy.js';
import type { IKbSqliteBackend, IKbSqliteDoc } from '../../common/kbSqliteStoreChannel.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { dirname } from '../../../../../base/common/resources.js';
import { VSBuffer, streamToBuffer } from '../../../../../base/common/buffer.js';
import { IWebContentExtractorService, ISharedWebContentExtractorService } from '../../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { $ } from '../../../../../base/browser/dom.js';
import { safeSetInnerHtml } from '../../../../../base/browser/domSanitize.js';

import { localize } from '../../../../../nls.js';

import {
	IKbVault, IKbNode, KbSection, KB_SECTION_LABEL,
	KbSortMode, KB_SORT_GROUPS, KB_IMPORT_ITEMS, KbImportKind, newVaultId,
} from './knowledgeBase/kbTypes.js';
import {
	detectPlatform, parseMetaTags, guessMediaExt, isDownloadableMedia,
	composeArticleMarkdown, composeVideoMarkdown,
	findMarkdownImageUrls, rewriteMarkdownImageUrls, toSecureScheme, type IKbMetaTags,
} from './knowledgeBase/kbUrlScraper.js';
import { KbFullTextIndex, IKbSearchHit } from './knowledgeBase/kbIndex.js';
import { KbLinkGraph, IKbGraphRoot } from './knowledgeBase/kbGraph.js';
import { KbNativeKernel, INativeBacklinkResult } from './knowledgeBase/kbNativeKernel.js';
import { IKbNativeKernelService, type IKbBuildRoot } from '../kbNativeKernelService.js';
import { IEmbeddingService } from '../../common/embeddingProvider.js';
import { resolveAuxEmbeddingProviderId, resolveAuxEmbeddingConfig } from '../knowledge/embeddingConfigResolver.js';
import { isEmbedderConfigured, isChatProviderConfigured } from '../knowledge/knowledgeAdapters.js';
import {
	AGENT_STUDIO_AUX_EMBEDDING_PROVIDER,
	AGENT_STUDIO_AUX_EMBEDDING_MODEL,
	AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS,
	AGENT_STUDIO_CHAT_VIEW_ID,
} from '../../common/constants.js';
import { KbWorkerManager } from './knowledgeBase/kbWorkerManager.js';
import { KbNoteEditorInput } from '../kbNoteEditorInput.js';
import { MemoryDetailEditorInput } from '../memoryDetailEditorInput.js';
import { KbGraphEditorInput } from '../kbGraphEditorInput.js';
import { appendKbOpLog, type IKbOpLogEntry, type KbOpChannel, type KbOpStatus } from '../knowledge/kbOpLog.js';
import { resolveKbRoot } from '../knowledge/knowledgeStorage.js';
import { IKbVectorSearchHit } from './knowledgeBase/kbVectorIndex.js';

const KB_ROOT_SUBPATH = '.vssaros/knowledge-base';
const STORAGE_VAULTS = 'agentStudio.kb.vaults';
const STORAGE_ACTIVE = 'agentStudio.kb.active';
/** 知识库目录：单一路径，Vault 及其「库」「笔记」子文件夹均在此目录下。 */
const STORAGE_KB_DIR = 'agentStudio.kb.kbDir';
const STORAGE_SORT_PREFIX = 'agentStudio.kb.sort.';
const STORAGE_EXPANDED_PREFIX = 'agentStudio.kb.expanded.';
const STORAGE_SECTION_PREFIX = 'agentStudio.kb.section.';




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
	/** 记忆库 section 的 body 容器 */
	private _memSectionBody?: HTMLElement;
	/** 记忆库列表容器 */
	private _memList?: HTMLElement;

	private _vaults: IKbVault[] = [];
	private _activeVault: IKbVault | undefined;
	/** P3-3：文件监听 debounce handle。 */
	private _kbRefreshHandle: ReturnType<typeof setTimeout> | undefined;
	/** P1-2：URL 导入持久化队列 + 重试 */
	private _urlQueue: UrlIngestQueue | undefined;
	/** VS Code 原生文件树（替代手动 DOM 渲染） */
	private _kbTree!: WorkbenchCompressibleAsyncDataTree<null, KbTreeElement, FuzzyScore>;
	private _kbTreeContainer!: HTMLElement;

	private _libraryOpen = true;
	private _notesOpen = true;
	private _sortMode: KbSortMode = 'createdASC';

	/** 已展开文件夹路径（持久化），用于懒加载树的展开恢复 */
	private _expandedFolders = new Set<string>();

	/** 正在加载中的文件夹 URI 字符串，避免重复加载 */
	private _loadingFolders = new Set<string>();

	/** 搜索防竞态令牌：每次搜索自增，结果渲染前校验是否最新 */
	private _searchToken = 0;
	/** 侧边栏显示模式：文件树 | 标签云 | 最近编辑 */
	private _viewMode: 'tree' | 'tags' | 'recent' = 'tree';

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
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@ILogService private readonly logService: ILogService,
		@IRequestService private readonly requestService: IRequestService,
		@IWebContentExtractorService private readonly _webContentExtractor: IWebContentExtractorService,
		@ISharedWebContentExtractorService private readonly _sharedWebContentExtractor: ISharedWebContentExtractorService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	@IKbNativeKernelService private readonly _kbKernelService: IKbNativeKernelService,
	@IEmbeddingService private readonly _ragEmbeddingService: IEmbeddingService,
	@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
	@ICodebaseGraphService private readonly _codebaseGraphService: ICodebaseGraphService,
	@ICodebaseMemoryMcpService private readonly _cbmService: ICodebaseMemoryMcpService,
	@IMainProcessService private readonly _mainProcessService: IMainProcessService,
	@IModelSelectorService private readonly modelSelectorService: IModelSelectorService,
	@IViewsService private readonly viewsService: IViewsService,
	@IConfigHtmlService private readonly configHtmlService: IConfigHtmlService,
	@ISkillRegistry private readonly _skillRegistry: ISkillRegistry,
	@IAgentOSService private readonly _agentOSService: IAgentOSService,
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

	private loadSectionOpen(section: KbSection): boolean {
		const raw = this.storageService.get(STORAGE_SECTION_PREFIX + section, StorageScope.APPLICATION);
		return raw === undefined ? true : raw === '1';
	}

	private saveSectionOpen(section: KbSection): void {
		this.storageService.store(STORAGE_SECTION_PREFIX + section, this._libraryOpen && section === 'library' || this._notesOpen && section === 'notes' ? '1' : '0', StorageScope.APPLICATION, StorageTarget.MACHINE);
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

		// Search
		const searchRow = $('div.kb-search-row');
		const searchBox = $('div.kb-search-box');
		safeSetInnerHtml(searchBox, '<span>🔍</span>');
		const searchInput = document.createElement('input');
		searchInput.placeholder = '搜索知识库 (全文 / 标题 / 标签)…';
		searchInput.oninput = () => this.applyFilter(searchInput.value.trim().toLowerCase());
		this._searchInput = searchInput;
		searchBox.appendChild(searchInput);
		searchRow.appendChild(searchBox);
		kbBody.appendChild(searchRow);

		// Scroll area (file tree) — 使用 VS Code 原生 WorkbenchCompressibleAsyncDataTree
		this._scroll = $('div.kb-scroll');
		this._kbTreeContainer = $('div.kb-tree-container');
		this._kbTreeContainer.style.cssText = 'flex:1;overflow:hidden;';
		// 先挂 scroll 容器，后续 initVaults 后通过 _createKbTree 注入原生树
		this._scroll.appendChild(this._kbTreeContainer);
		kbBody.appendChild(this._scroll);

		this._body.appendChild(kbBody);

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

		// Global click closes popups
		document.addEventListener('click', this._onGlobalClick);

		// initVaults
		this.logService.info(`[KB perf] renderBody skeleton: ${(performance.now() - t0).toFixed(1)}ms, starting initVaults...`);
		void this.initVaults().then(() => {
			this._createKbTree();
			this.logService.info(`[KB perf] renderBody total: ${(performance.now() - t0).toFixed(1)}ms`);
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
		this._libraryOpen = this.loadSectionOpen('library');
		this._notesOpen = this.loadSectionOpen('notes');
		await this.ensureVaultFolders(v);
		const t1 = performance.now();
		this.renderAll();
		this.logService.info(`[KB perf] activateVault(${v.name}): ensureFolders=${(t1 - t0).toFixed(1)}ms, renderAll=${(performance.now() - t1).toFixed(1)}ms, total=${(performance.now() - t0).toFixed(1)}ms`);
	}

	/** P3-3：vault 文件变化（库/笔记分区）→ debounce 刷新视图 + 重建确定性导航。 */
	private _onVaultFilesChange(e: { affects(uri: URI): boolean }): void {
		const v = this._activeVault;
		if (!v) { return; }
		const notes = this.sectionUri(v, 'notes');
		const lib = this.sectionUri(v, 'library');
		if (!e.affects(notes) && !e.affects(lib)) { return; }
		if (this._kbRefreshHandle !== undefined) { clearTimeout(this._kbRefreshHandle); }
		this._kbRefreshHandle = setTimeout(() => {
			this._kbRefreshHandle = undefined;
			this.logService.info('[KB] vault file change detected → refresh + maintain navigation');
			void this.refreshSection('notes');
			void this.refreshSection('library');
			void KbImportController.maintainKbNavigation(this.fileService, notes);
		}, 300);
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
		// 重建前清除搜索态，避免结果元素被清空但搜索框仍残留文字
		if (this._searchInput) { this._searchInput.value = ''; }
		this._searchToken++; // 使进行中的搜索结果失效
		this.renderVaultBar();
		this._scroll.replaceChildren();
		if (this._viewMode === 'tags') {
			this.renderTagView();
		} else if (this._viewMode === 'recent') {
			this.renderRecentView();
		} else {
			this._scroll.appendChild(this.renderSection('library'));
			this._scroll.appendChild(this.renderSection('notes'));
		}
		// 重建原生树容器（被 replaceChildren 清空）并重新挂载树
		this._kbTreeContainer = $('div.kb-tree-container');
		this._kbTreeContainer.style.cssText = 'flex:1;overflow:hidden;';
		this._scroll.appendChild(this._kbTreeContainer);
		this._createKbTree();
		this.renderBacklinksPanel();
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
	//  最近编辑视图
	// ═══════════════════════════════════════════════════════════

	private renderRecentView(): void {
		const container = $('div.kb-recent');
		const allDocs = this._index.allDocs();
		if (allDocs.length === 0) {
			const empty = $('div.kb-empty-inline');
			empty.textContent = '暂无笔记（先在库或笔记分区中导入/创建笔记）';
			container.appendChild(empty);
			this._scroll.appendChild(container);
			return;
		}
		// 按最后修改时间降序，取最近 50 篇
		allDocs.sort((a, b) => b.mtime - a.mtime);
		const recent = allDocs.slice(0, 50);
		const limitEl = $('div.kb-recent-limit');
		limitEl.textContent = `最近 ${recent.length} 篇笔记（共 ${allDocs.length} 篇）`;
		container.appendChild(limitEl);
		for (const doc of recent) {
			const item = $('div.kb-recent-item');
			const icon = $('span.kb-ficon');
			icon.textContent = doc.name.endsWith('.md') ? '📝' : '📄';
			const name = $('span.kb-recent-name');
			name.textContent = doc.name;
			const time = $('span.kb-recent-time');
			time.textContent = this._formatRelativeTime(doc.mtime);
			item.append(icon, name, time);
			item.onclick = () => {
				this._openNoteEditor({
					uri: doc.uri, name: doc.name, path: doc.uri.fsPath,
					isDirectory: false, section: doc.section,
					size: doc.size, mtime: doc.mtime, ctime: 0, childCount: 0,
				});
			};
			container.appendChild(item);
		}
		this._scroll.appendChild(container);
	}

	/** 相对时间格式化（今天/昨天/N天前/N周前/日期）。 */
	private _formatRelativeTime(mtime: number): string {
		if (!mtime) { return ''; }
		const now = Date.now();
		const diffMs = now - mtime;
		const diffMin = Math.floor(diffMs / 60000);
		if (diffMin < 1) { return '刚刚'; }
		if (diffMin < 60) { return `${diffMin} 分钟前`; }
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) { return `${diffHr} 小时前`; }
		const diffDay = Math.floor(diffHr / 24);
		if (diffDay === 1) { return '昨天'; }
		if (diffDay < 7) { return `${diffDay} 天前`; }
		if (diffDay < 30) { return `${Math.floor(diffDay / 7)} 周前`; }
		const d = new Date(mtime);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}

	// ═══════════════════════════════════════════════════════════
	//  标签云视图
	// ═══════════════════════════════════════════════════════════

	private renderTagView(): void {
		const tags = this._index.getAllTags();
		const container = $('div.kb-tags');
		if (tags.length === 0) {
			const empty = $('div.kb-empty-inline');
			empty.textContent = '暂无标签（在笔记中使用 #标签# 格式即可创建标签）';
			container.appendChild(empty);
			this._scroll.appendChild(container);
			return;
		}
		// 按引用数降序，同名升序
		tags.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
		for (const t of tags) {
			const item = $('div.kb-tag-item');
			const nameEl = $('span.kb-tag-name');
			nameEl.textContent = `#${t.tag}`;
			const countEl = $('span.kb-tag-count');
			countEl.textContent = `${t.count}`;
			item.append(nameEl, countEl);
			item.onclick = () => { this._filterByTag(t.tag); };
			container.appendChild(item);
		}
		this._scroll.appendChild(container);
	}

	/** 点标签 → 用标签索引精确搜索，展示命中文档列表。 */
	private _filterByTag(tag: string): void {
		this._viewMode = 'tree'; // 切回文件树模式展示结果
		if (this._searchInput) {
			this._searchInput.value = `#${tag}`;
		}
		// 隐藏分区树，展示标签搜索结果
		this._scroll.querySelectorAll('.kb-section').forEach(s => (s as HTMLElement).style.display = 'none');
		if (this._backlinksEl) { this._backlinksEl.style.display = 'none'; }
		let resultsEl = this._scroll.querySelector('.kb-search-results') as HTMLElement | null;
		if (!resultsEl) {
			resultsEl = $('div.kb-search-results');
			this._scroll.appendChild(resultsEl);
		}
		resultsEl.classList.add('show');
		resultsEl.replaceChildren();
		const hits = this._index.searchByTag(tag, 100);
		const h = $('div.kb-search-head');
		h.textContent = `标签 #${tag}（${hits.length} 个文档）`;
		resultsEl.appendChild(h);
		if (hits.length === 0) {
			const empty = $('div.kb-empty-inline'); empty.textContent = '无文档使用此标签';
			resultsEl.appendChild(empty);
			return;
		}
		for (const hit of hits) {
			resultsEl.appendChild(this.renderSearchHit(hit, tag));
		}
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
		const viewLabels: Record<string, string> = { tree: '📂', tags: '🏷️', recent: '🕐' };
		const viewTitles: Record<string, string> = { tree: '文件树视图', tags: '标签云视图', recent: '最近编辑' };
		viewBtn.textContent = viewLabels[this._viewMode];
		viewBtn.title = viewTitles[this._viewMode];
		viewBtn.onclick = () => {
			const seq: Array<'tree' | 'tags' | 'recent'> = ['tree', 'tags', 'recent'];
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
		opt.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.vaultContextMenu(v); };
		return opt;
	}

	private toggleVaultMenu(): void {
		this._vaultMenu.classList.toggle('show');
	}

	private vaultContextMenu(v: IKbVault): void {
		const items: { label: string; run: () => void }[] = [
			{ label: '重命名', run: async () => { const r = await this.dialogService.input({ message: '重命名知识库', inputs: [{ value: v.name }] }); const nm = r.values?.[0]?.trim(); if (r.confirmed && nm) { await this.renameVault(v, nm); } } },
			{ label: v.closed ? '打开' : '关闭', run: () => { v.closed = !v.closed; this.saveVaults(); this.renderVaultMenu(); if (v.closed && this._activeVault?.id === v.id) { this._activeVault = this._vaults.find(x => !x.closed); if (this._activeVault) { void this.activateVault(this._activeVault); } } } },
			{ label: '体检（结构校验）', run: () => { void this._runLint(v); } },
			{ label: '隔离低质笔记（人环）', run: () => { void this._routeLintToReview(v); } },
			{ label: '整理去重', run: () => { void this._runDedup(v); } },
			{ label: '审核队列…', run: () => { void this._showReviewQueue(v); } },
			{ label: '删除', run: () => { void this.removeVault(v); } },
		];
		this.showSimpleMenu(items);
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
		try {
			await approveReviewNote(this.fileService, vaultRoot, name, notesDir);
			await KbImportController.appendKbLog(this.fileService, notesDir, `确认审核移回：${name}`);
			await KbImportController.maintainKbNavigation(this.fileService, notesDir);
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
		const notesDir = this.sectionUri(v, 'notes');
		await KbImportController.appendKbLog(this.fileService, notesDir, `清空审核队列：${notes.length} 篇`);
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
			await KbImportController.appendKbLog(this.fileService, notesDir, `体检：${issues.length} 项问题`);
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
			const notesDir = this.sectionUri(v, 'notes');
			await KbImportController.appendKbLog(this.fileService, notesDir, `隔离低质笔记：${routed.length} 篇移入审核队列`);
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
			const notesDir = this.sectionUri(this._activeVault, 'notes');
			await KbImportController.appendKbLog(this.fileService, notesDir, `移入审核：${name}`);
			await KbImportController.maintainKbNavigation(this.fileService, notesDir);
			await this.refreshSection('notes');
			this.notificationService.info(`已移入审核队列：${name}（位于 .review/，确认后可用 approveReviewNote 移回）`);
		} catch (err) { this.notificationService.error('移入审核失败：' + String(err)); }
	}

	/** P3-1 视图入口：跑去重检测，写 dedup-report.md 并通知（仅检测，不自动合并）。 */
	private async _runDedup(v: IKbVault): Promise<void> {
		const notesDir = this.sectionUri(v, 'notes');
		try {
			const groups = await detectDuplicates(this.fileService, notesDir);
			const report = formatDedupReport(notesDir, groups);
			await this.fileService.writeFile(URI.joinPath(notesDir, 'dedup-report.md'), VSBuffer.fromString(report));
			await KbImportController.appendKbLog(this.fileService, notesDir, `整理去重：${groups.length} 组疑似重复`);
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
			await KbImportController.appendKbLog(this.fileService, notesDir, `合并去重「${g.key}」：删 ${r.deleted.length} 篇，重写 ${r.rewritten.length} 篇引用`);
			merged++;
		}
		if (merged > 0) {
			await KbImportController.maintainKbNavigation(this.fileService, notesDir);
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
		const open = section === 'library' ? this._libraryOpen : this._notesOpen;
		const sectionEl = $('div.kb-section');
		sectionEl.classList.add(section === 'library' ? 'sec-library' : 'sec-notes');
		if (open) { sectionEl.classList.add('open'); }

		// Header
		const header = $('div.kb-section-header');
		const arrow = $('span.kb-arrow'); arrow.textContent = '▾';
		const titleWrap = $('span.kb-title');
		const cat = $('span.kb-cat'); cat.textContent = section === 'library' ? '📂' : '📦';
		const tlabel = $('span'); tlabel.textContent = KB_SECTION_LABEL[section];
		const count = $('span.kb-count'); count.textContent = '0';
		titleWrap.append(cat, tlabel, count);
		header.append(arrow, titleWrap);

		// Toolbar
		const toolbar = $('div.kb-section-toolbar');
		if (section === 'library') {
			const newFile = $('span.kb-sec-btn'); newFile.textContent = '📄'; newFile.title = '新建文件';
			newFile.onclick = (e) => { e.stopPropagation(); void this.newFile(section); };
			const newFolder = $('span.kb-sec-btn'); newFolder.textContent = '📁'; newFolder.title = '新建文件夹';
			newFolder.onclick = (e) => { e.stopPropagation(); void this.newFolder(section); };
			const importBtn = $('span.kb-sec-btn.primary'); importBtn.textContent = '📥'; importBtn.title = '导入数据源';
			importBtn.onclick = (e) => { e.stopPropagation(); this.openImportDropdown(sectionEl, importBtn); };
		// 笔记沉淀（占位：功能开发中，暂未实现）
		const sedimentBtn = $('span.kb-sec-btn'); sedimentBtn.textContent = '💾'; sedimentBtn.title = '笔记沉淀（功能开发中，敬请期待）';
		sedimentBtn.onclick = (e) => { e.stopPropagation(); void this._onNoteSedimentationClick(); };
		toolbar.append(newFile, newFolder, importBtn, sedimentBtn);
		} else {
			const newFile = $('span.kb-sec-btn'); newFile.textContent = '📄'; newFile.title = '新建文件';
			newFile.onclick = (e) => { e.stopPropagation(); void this.newFile(section); };
			const newFolder = $('span.kb-sec-btn'); newFolder.textContent = '📁'; newFolder.title = '新建文件夹';
			newFolder.onclick = (e) => { e.stopPropagation(); void this.newFolder(section); };
			const sortBtn = $('span.kb-sec-btn'); sortBtn.textContent = '↑↓'; sortBtn.title = '排序';
			sortBtn.onclick = (e) => { e.stopPropagation(); this.openSortDropdown(sectionEl, sortBtn); };
			const toggleBtn = $('span.kb-sec-btn'); toggleBtn.id = 'kbToggleAll'; toggleBtn.textContent = '⊏'; toggleBtn.title = '全部折叠 / 全部展开';
			toggleBtn.onclick = (e) => { e.stopPropagation(); this.toggleAllSections(toggleBtn); };
			toolbar.append(newFile, newFolder, sortBtn, toggleBtn);
		}
		header.appendChild(toolbar);
		header.onclick = (e) => {
			if ((e.target as HTMLElement).closest('.kb-section-toolbar')) { return; }
			this.toggleSection(section, sectionEl);
		};
		sectionEl.appendChild(header);

		// Body (tree)
		const body = $('div.kb-section-body');
		body.dataset.section = section;
		sectionEl.appendChild(body);
		void this.loadSectionTree(section, body, count);

		return sectionEl;
	}

	private toggleSection(section: KbSection, el: HTMLElement): void {
		const open = el.classList.toggle('open');
		if (section === 'library') { this._libraryOpen = open; } else { this._notesOpen = open; }
		this.saveSectionOpen(section);
	}

	private toggleAllSections(btn: HTMLElement): void {
		const anyOpen = this._libraryOpen || this._notesOpen;
		this._libraryOpen = !anyOpen;
		this._notesOpen = !anyOpen;
		this.saveSectionOpen('library');
		this.saveSectionOpen('notes');
		this.renderAll();
		btn.textContent = anyOpen ? '⊐' : '⊏';
		btn.title = anyOpen ? '全部展开' : '全部折叠';
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
				for (const node of nodes) {
					body.appendChild(this.renderNode(node, 0));
				}
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
			// 恢复已展开文件夹（一级，await 确保子节点恢复到 DOM 后再返回）
			for (const node of nodes) {
				if (node.isDirectory && this._expandedFolders.has(node.path)) {
					const el = body.querySelector(`.kb-node[data-path="${this.cssEscape(node.path)}"]`);
					if (el) { await this.expandFolder(el as HTMLElement, node); }
				}
			}
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

		const icon = $('span.kb-ficon');
		icon.textContent = node.isDirectory ? '📁' : this.fileEmoji(node.name);
		el.appendChild(icon);

		const name = $('span.kb-name'); name.textContent = node.name;
		el.appendChild(name);

		if (!node.isDirectory) {
			const meta = $('span.kb-meta');
			meta.textContent = node.section === 'library' ? '未索引' : `${this.fmtSize(node.size)}`;
			el.appendChild(meta);
			const status = $('span.kb-status');
			status.classList.add(node.section === 'library' ? 'raw' : 'indexed');
			status.title = node.section === 'library' ? '待索引' : '已索引';
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

		el.onclick = () => {
			if (node.isDirectory) {
				// 点击文件夹行：选中并伸缩（展开/折叠）
				this.selectNode(el);
				void this.expandFolder(el, node);
			} else {
				this.selectNode(el);
			}
		};
		el.ondblclick = () => { if (!node.isDirectory) { this.openInEditor(node); } };
		el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); this.nodeContextMenu(e, el, node); };

		return el;
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
			if (childrenEl) { childrenEl.replaceChildren(); } else {
				childrenEl = $('div.kb-children');
				el.after(childrenEl);
			}
			if (nodes.length === 0) {
				const empty = $('div.kb-empty-inline'); empty.style.paddingLeft = '20px'; empty.textContent = '空文件夹';
				childrenEl.appendChild(empty);
			} else {
				for (const child of nodes) {
					const childEl = this.renderNode(child, this.depthOf(el) + 1);
					childrenEl.appendChild(childEl);
					if (child.isDirectory && this._expandedFolders.has(child.path)) {
						void this.expandFolder(childEl, child);
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

	private selectNode(el: HTMLElement): void {
		this._body.querySelectorAll('.kb-node.selected').forEach(n => n.classList.remove('selected'));
		el.classList.add('selected');
		const node = this.nodeFromEl(el);
		if (node) {
			void this.updateBacklinks(node);
			// 点击文件 → 在中间栏直接打开 WYSIWYG 编辑器（对齐 SiYuan 中心 Tab 范式）
			if (!node.isDirectory) {
				this._openNoteEditor(node);
			}
		}
	}

	private fileEmoji(name: string): string {
		const ext = name.split('.').pop()?.toLowerCase();
		switch (ext) {
			case 'md': case 'markdown': return '📝';
			case 'pdf': return '📕';
			case 'doc': case 'docx': return '📘';
			case 'txt': return '📄';
			case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': return '🖼️';
			case 'mp4': case 'mov': case 'webm': return '🎬';
			case 'mp3': case 'wav': case 'm4a': return '🎵';
			case 'json': case 'yaml': case 'yml': return '⚙️';
			case 'html': case 'htm': return '🌐';
			default: return '📄';
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
		await this.refreshSection(section);
		// 确保父目录已展开（子节点在 DOM 中），再选中并进入重命名
		if (parent) { await this.ensureParentExpanded(parent); }
		const el = this.findNodeEl(section, uri.fsPath);
		if (el) { this.selectNode(el); const node = this.nodeFromEl(el); if (node) { this.startRename(el, node); } }
	}

	private async newFolder(section: KbSection, parent?: IKbNode): Promise<void> {
		const dir = this.targetDir(section, parent);
		const uri = await this.uniqueName(dir, '未命名文件夹');
		await this.fileService.createFolder(uri);
		void this._logOp('folder.create', 'success', { target: uri.fsPath, detail: { section } });
		await this.refreshSection(section);
		if (parent) { await this.ensureParentExpanded(parent); }
		const el = this.findNodeEl(section, uri.fsPath);
		if (el) { this.selectNode(el); const node = this.nodeFromEl(el); if (node) { this.startRename(el, node); } }
	}

	/** 确保指定文件夹的父节点已展开（子节点已在 DOM 中），用于新建文件/文件夹后定位子元素。 */
	private async ensureParentExpanded(parent: IKbNode): Promise<void> {
		const parentEl = this.findNodeEl(parent.section, parent.path);
		if (!parentEl) { return; }
		// 已展开则无需再加载（expandFolder 遇到已展开会跳过 loading 检查直接折叠，所以这里做判断）
		if (this._expandedFolders.has(parent.path)) { return; }
		await this.expandFolder(parentEl, parent);
	}

	private async deleteNode(node: IKbNode): Promise<void> {
		const confirm = await this.dialogService.confirm({
			message: localize('kb.deleteNode', '确定删除「{0}」？', node.name),
			primaryButton: localize('kb.delete', '删除'),
		});
		if (!confirm.confirmed) { return; }
		// P2c：删除「库」分区节点时，级联删除引用了它的笔记（基于 notes 的 sources[] frontmatter）
		let cascadeDeleted = 0;
		if (node.section === 'library' && this._activeVault) {
			const notesDir = this.sectionUri(this._activeVault, 'notes');
			cascadeDeleted = (await KbImportController.cascadeDeleteLibraryNotes(this.fileService, node.uri, notesDir)).length;
			if (cascadeDeleted > 0) {
				await KbImportController.maintainKbNavigation(this.fileService, notesDir);
			}
		}
		try {
			await this.fileService.del(node.uri, { recursive: true });
			void this._logOp('node.delete', 'success', { target: node.uri.fsPath, detail: { section: node.section, isDirectory: node.isDirectory, cascadeNotes: cascadeDeleted } });
		} catch (err) {
			void this._logOp('node.delete', 'failure', { target: node.uri.fsPath, detail: { section: node.section }, error: String(err) });
		}
		this._expandedFolders.delete(node.path);
		await this.refreshSection(node.section);
		if (cascadeDeleted > 0) {
			await this.refreshSection('notes');
		}
	}

	private startRename(el: HTMLElement, node: IKbNode): void {
		const nameEl = el.querySelector('.kb-name') as HTMLElement;
		const actions = el.querySelector('.kb-actions') as HTMLElement | null;
		if (actions) { actions.style.display = 'none'; }
		const input = document.createElement('input');
		input.className = 'kb-rename-input';
		input.value = node.name;
		nameEl.replaceWith(input);
		input.focus(); input.select();

		const finish = async (commit: boolean) => {
			const newName = input.value.trim();
			if (commit && newName && newName !== node.name) {
				const target = URI.joinPath(node.uri, '..', newName);
				try {
					await this.fileService.move(node.uri, target, false);
					void this._logOp('node.rename', 'success', { source: node.uri.fsPath, target: target.fsPath, detail: { section: node.section } });
					await this.refreshSection(node.section);
				} catch (err) {
					this.notificationService.warn(String(err));
					void this._logOp('node.rename', 'failure', { source: node.uri.fsPath, target: target.fsPath, error: String(err) });
					this.revertRename(el, node.name, actions);
				}
			} else {
				this.revertRename(el, node.name, actions);
			}
		};

		input.onkeydown = (e) => {
			if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
			else if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
		};
		input.onblur = () => { setTimeout(() => void finish(false), 150); };
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
		const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
		const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
		this.editorService.openEditor({ resource: node.uri, options: { pinned: true } }, targetGroup);
	}

	private async refreshSection(section: KbSection): Promise<void> {
		this.markSearchDirty();
		// 优先刷新原生树
		this._refreshKbTree();
		// 兼容旧 DOM 渲染：若树不可用则回退至 DOM 渲染
		if (!this._kbTree) {
			const body = this._scroll.querySelector(`.kb-section-body[data-section="${section}"]`) as HTMLElement | null;
			const countEl = body?.parentElement?.querySelector('.kb-count') as HTMLElement | null;
			if (body) { await this.loadSectionTree(section, body, countEl ?? $('span.kb-count')); }
		}
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

	// ═══════════════════════════════════════════════════════════
	//  Import
	// ═══════════════════════════════════════════════════════════

	private openImportDropdown(anchorSection: HTMLElement, anchorBtn: HTMLElement): void {
		// 移除已有
		this._body.querySelectorAll('.kb-dropdown.show').forEach(d => d.classList.remove('show'));
		const dd = $('div.kb-dropdown');
		dd.id = 'kbImportDD';
		for (const item of KB_IMPORT_ITEMS) {
			if (item.kind === 'codeWorkspace') {
				const div = $('div.kb-divider'); dd.appendChild(div);
				const title = $('div.kb-dd-title'); title.textContent = '从工作区导入'; dd.appendChild(title);
			}
			if (item.kind === 'url') {
				const div = $('div.kb-divider'); dd.appendChild(div);
				const title = $('div.kb-dd-title'); title.textContent = '从 URL 导入'; dd.appendChild(title);
			}
			const opt = $('div.kb-opt');
			safeSetInnerHtml(opt, `<span class="kb-ic">${item.icon}</span><span class="kb-txt">${item.label}</span><span class="kb-sub">${item.sub}</span>`);
			opt.onclick = (e) => { e.stopPropagation(); dd.classList.remove('show'); void this.handleImport(item.kind); };
			dd.appendChild(opt);
		}
		this.positionDropdown(dd, anchorBtn);
		dd.classList.add('show');
	}

	private async handleImport(kind: KbImportKind): Promise<void> {
		if (!this._activeVault) { return; }
		const target = this.sectionUri(this._activeVault, 'library');

		// ── URL 导入 → 确定性下载 + SSRF 防护 + 缓存 + 库分区按 schema 落盘（两阶段：库→笔记） ──
		if (kind === 'url') {
			const r = await this.dialogService.input({
				message: localize('kb.enterUrl', '粘贴要导入的链接（小红书 / 抖音 / 知乎 / B站 / YouTube / 微博 / 公众号 …）'),
				inputs: [{ value: '', placeholder: 'https://...' }],
			});
			const url = r.values?.[0]?.trim();
			if (!r.confirmed || !url) { return; }

			// P1 SSRF 防护
			const safety = validateSafeUrl(url);
			if (!safety.safe) {
				this.notificationService.warn(localize('kb.urlBlocked', 'URL 被安全策略拒绝：{0}', safety.reason ?? 'unknown'));
				return;
			}

			// P0 内容去重：检查 URL 是否已导入
			const cache = new UrlIngestCache(this.vaultUri(this._activeVault));
			try {
				// 先只检查 URL 是否已导入（无内容时无法 hash，后续会补）
				const cachedPath = await cache.check(this.fileService, url, url); // key=url+urlHash → 仅 URL 同（近似检查）
				if (cachedPath) {
					this.notificationService.info(localize('kb.urlCached', '该 URL 已导入过：{0}', cachedPath));
					return;
				}
			} catch { /* cache read fail → proceed */ }

			// 确定性下载 + 落盘到库分区
			this.notificationService.info(localize('kb.urlFetching', '正在下载并导入...'));
			try {
				await this.importFromUrl(url, target);

				// 导入成功后：通知用户可稍后构建笔记
				this.notificationService.info(localize('kb.urlImportedToLib', '已保存到知识库「库」分区。可右键文件「构建为笔记」生成结构化笔记。'));
			} catch (err) {
				this.logService.warn(`[KB] URL import error: ${err}`);
				this.notificationService.warn(localize('kb.urlFetchFailed', '导入失败：{0}', String(err)));
			}
			return;
		}

		// ── Obsidian 库 / 文件夹关联导入 → 走 知识库专家 agent 技能 ──
		if (kind === 'obsidian' || kind === 'folder') {
			if (kind === 'folder') {
				const mode = await this.askImportFolderMode();
				if (!mode) { return; }
				// copy 模式：保持原位拷贝（不需要 agent 技能）
				if (mode !== 'link') {
					const picked = await this.fileDialogService.showOpenDialog({
						title: '导入文件夹（拷贝）', canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
					});
					if (picked?.length) {
						const dest = URI.joinPath(target, this.baseName(picked[0]));
						await this.copyRecursive(picked[0], dest);
						void this._logOp('kb.import.folder', 'success', { source: picked[0].fsPath, target: dest.fsPath });
						void this._importFolderRagAsync(dest.fsPath, this._activeVault);
					}
					await this.refreshSection('library');
					return;
				}
				// link 模式：继续走 agent 技能
			}

			const title = kind === 'obsidian' ? '导入 Obsidian 库' : '关联文件夹';
			const picked = await this.fileDialogService.showOpenDialog({
				title, canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
			});
			if (!picked?.length) { return; }

			const folderPath = picked[0].fsPath;
			const skillId = 'kb-import-obsidian';
			const vaultName = this._activeVault.name;
			const libPath = target.fsPath;
			const notesPath = this.sectionUri(this._activeVault, 'notes').fsPath;
			await this._routeImportToKbAgent(
				skillId,
				this._buildImportObsidianSkillMd(),
				`[skill:${skillId}] 请将以下文件夹导入到知识库「${vaultName}」中（关联模式：扫描原文件，不复制，结果落盘到库和笔记分区）：\n\n文件夹路径: \`${folderPath}\`\n库分区路径: \`${libPath}\`\n笔记分区路径: \`${notesPath}\`\n\n请按照 skill 描述的完整链（扫描→分类→落盘库→结构化抽取→落盘笔记→操作日志）处理。`,
				`${title}: ${folderPath}`,
			);
			return;
		}

		// ── 文件导入 / codeWorkspace：保持原路径（纯文件操作，不走 agent）──
		try {
			if (kind === 'files') {
				const picked = await this.fileDialogService.showOpenDialog({ title: '导入文件', canSelectFiles: true, canSelectFolders: false, canSelectMany: true });
				if (picked?.length) {
					for (const f of picked) {
						const dest = URI.joinPath(target, this.baseName(f));
						await this.copyRecursive(f, dest);
						void this._logOp('kb.import.files', 'success', { source: f.fsPath, target: dest.fsPath });
					}
				}
			} else if (kind === 'codeWorkspace') {
				this.logService.info(`[KB import handler] before importCodeWorkspace() — linkedFolders=${this._activeVault?.linkedFolders?.length ?? 0}`);
				await this.importCodeWorkspace();
				this.logService.info(`[KB import handler] after importCodeWorkspace() — linkedFolders=${this._activeVault?.linkedFolders?.length ?? 0}`);
			}
		} catch (err) {
			void this._logOp('kb.import', 'failure', { detail: { kind }, error: String(err) });
		}
		await this.refreshSection('library');
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

	private async copyRecursive(source: URI, target: URI): Promise<void> {
		let stat;
		try {
			stat = await this.fileService.resolve(source);
		} catch (err) {
			this.logService.warn(`[KB] copyRecursive resolve failed: ${err}`);
			return;
		}
		if (stat.isDirectory) {
			await this.fileService.createFolder(target);
			for (const child of stat.children ?? []) {
				await this.copyRecursive(child.resource, URI.joinPath(target, child.name));
			}
		} else {
			try {
				const content = await this.fileService.readFile(source);
				await this.fileService.writeFile(target, content.value);
			} catch (err) {
				this.logService.warn(`[KB] copy file failed: ${err}`);
			}
		}
	}

	// ═══════════════════════════════════════════════════════════
	//  URL import (web clip → Markdown)
	// ═══════════════════════════════════════════════════════════

	/**
	 * 导入文件夹前询问用户意图：
	 *  - 'link'：关联外部文件夹（保持文件原位，原地索引）
	 *  - 'copy'：拷贝文件夹内容到 VsSaros 知识库根目录（库分区）
	 *  - undefined：用户取消
	 */
	private async askImportFolderMode(srcPath?: string): Promise<'link' | 'copy' | undefined> {
		const base = srcPath ? this.baseName(URI.file(srcPath)) : '';
		const r = await this.dialogService.prompt<'link' | 'copy'>({
			message: base
				? localize('kb.importFolderMode.title', '导入文件夹「{0}」：关联还是拷贝？', base)
				: localize('kb.importFolderMode.title.generic', '导入文件夹：关联还是拷贝？'),
			detail: localize(
				'kb.importFolderMode.detail',
				'「关联」保持文件在当前位置不动，仅登记为索引根（原位扫描，不占知识库空间）；「拷贝」会把文件夹内容复制到 VsSaros 知识库根目录的「库」分区。',
			),
			buttons: [
				{ label: localize('kb.importFolderMode.link', '关联（保持文件原位）'), run: () => 'link' as const },
				{ label: localize('kb.importFolderMode.copy', '拷贝到知识库'), run: () => 'copy' as const },
			],
			cancelButton: localize('kb.cancel', '取消'),
		});
		return r.result;
	}

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
		// 后台构建「每 git 仓库 = 一个 RAG session」语义索引（与全文索引解耦，故障隔离）。
		void this._importFolderRagAsync(p, this._activeVault);
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

			const newFolders: string[] = [];
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
					newFolders.push(folderPath);
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

			// 4. 后台 RAG 语义索引（每个新增目录建一个 session）
			for (const p of newFolders) {
				void this._importFolderRagAsync(p, this._activeVault);
			}
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
	 *  - 后台 RAG：_importFolderRagAsync（chunked，安全）。
	 *  - 后台类型判断：快速扫描顶层文件扩展名，检测是否为代码仓库。
	 *    • 代码仓库 → 额外触发 codebase tree-sitter 索引（_codebaseGraphService.indexWorkspace）。
	 *    • 纯文档 / 无脚本 → 仅保留 RAG 知识图谱索引。
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
			// 后台 RAG 语义索引（chunked，安全）
			void this._importFolderRagAsync(p, this._activeVault);

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
				excludeDirs: ['node_modules', '.git', 'build', 'dist', 'out', '.next', 'tmp', 'out-build', 'out-test', 'out-vscode'],
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
		// 同步清理全局文件夹 RAG 索引（repoRoot→sessionId 映射），避免 kb_search_repo 检索到已取消关联的仓库。
		try { await this.agentStudioService.unlinkFolderRag(path); } catch (e) { this.logService.warn('[KB] failed to unlink folder RAG index', e); }
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

	/**
	 * 后台为导入的文件夹构建「每 git 仓库 = 一个 RAG session」语义索引（方案 A）。
	 * 与全文索引（rebuildSearchAssets）解耦：即使语义构建失败 / 部分失败，全文索引仍可用。
	 * 完成后把 repoRoot→sessionId 映射写回 vault 元数据，供后续跨库检索 / git pull 增量重摄入。
	 */
	private async _importFolderRagAsync(folderPath: string, vault: IKbVault): Promise<void> {
		if (!vault) { return; }
		// 未配置任何可用 embedder（无 API key）时不自动构建语义索引，仅完成目录关联即可，
		// 避免 createKbEmbedder 抛 "KbEmbedder 未配置" 的 WARN/噪声。需要时再手动触发。
		if (!isEmbedderConfigured(this.configurationService)) {
			this.logService.info(`[KB] 跳过文件夹 RAG 自动索引（未配置 embedder provider/API key）: ${folderPath}`);
			return;
		}
		try {
			const result = await this.agentStudioService.importFolderToRag(folderPath, { includeUnversioned: false });
			const errEntries = result.errors ?? {};
			if (Object.keys(errEntries).length) {
				this.logService.warn(`[KB] folder RAG partial failure for ${folderPath}:`, errEntries);
			}
			vault.ragSessions = { ...(vault.ragSessions ?? {}), ...result.sessions };
			vault.ragUnversionedSessionId = result.unversionedSessionId ?? vault.ragUnversionedSessionId ?? null;
			this.saveVaults();
			const n = Object.keys(result.sessions).length;
			const errN = Object.keys(errEntries).length;
			if (errN) {
				this.notificationService.info(localize('kb.folderRag.partial', '已为「{0}」构建 {1} 个仓库语义索引（{2} 个失败，全文索引仍可用）', this.baseName(URI.file(folderPath)), n, errN));
			} else {
				this.notificationService.info(localize('kb.folderRag.done', '已为「{0}」构建 {1} 个仓库语义索引（可跨库检索）', this.baseName(URI.file(folderPath)), n));
			}
			void this._logOp('kb.import.folderRag', 'success', { source: folderPath, detail: { sessions: result.sessions, errors: errEntries } });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[KB] folder RAG import failed for ${folderPath}:`, err);
			this.notificationService.warn(localize('kb.folderRag.failed', '文件夹语义索引构建失败（全文索引仍可用）：{0}', msg));
			void this._logOp('kb.import.folderRag', 'failure', { source: folderPath, error: msg });
		}
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
			this.showSimpleMenu([
				{ label: '在文件管理器打开', run: () => { void this.openerService.open(URI.file(path), { openExternal: true }); } },
				{ label: '代码图谱', run: () => { const input = new CodebaseGraphViewerEditorInput(path); void this.editorService.openEditor(input, { pinned: true }); } },
				{ label: '取消关联', run: () => { void this.unlinkFolder(path); } },
			], e.clientX, e.clientY);
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
	/** 确定性下载 URL 内容并保存到库分区（两阶段工作流的阶段 1）。
	 *  P1-2：经持久化队列 + 重试，失败自动恢复。 */
	private async importFromUrl(url: string, target: URI): Promise<void> {
		const platform = detectPlatform(url);
		this.notificationService.info(localize('kb.urlFetching', '正在抓取「{0}」：{1}', platform.name, url));
		const queue = this._getUrlQueue();
		await queue.enqueue(url, target.fsPath);
		await queue.run((item: QueueItem) => this._processUrlItem(item));
	}

	// ─── P0-3 + P1-2：URL 导入处理（队列消费 + 内容清洗管道）─────────────

	private _getUrlQueue(): UrlIngestQueue {
		if (!this._urlQueue) {
			this._urlQueue = new UrlIngestQueue(this.vaultUri(this._activeVault!), this.fileService, this.logService);
		}
		return this._urlQueue;
	}

	/** 队列 handler：提取 → 清洗 → 组装 → 落盘。异常上抛以触发队列重试。 */
	private async _processUrlItem(item: QueueItem): Promise<void> {
		const url = item.url;
		const target = URI.file(item.targetFsPath);
		const platform = detectPlatform(url);

		// 内容抽取 + 元信息（并行）
		const uri = URI.parse(url);
		const [extractRes, ogMeta] = await Promise.all([
			this._webContentExtractor.extract([uri], { followRedirects: true, trustedDomains: ['*'] }),
			this.fetchOgMeta(url),
		]);
		const ext = extractRes[0];
		if (!ext || ext.status === 'redirect') {
			throw new Error(ext?.status === 'redirect' ? `需跳转至 ${ext.toURI}` : '未能获取页面内容');
		}
		let body = ext.status === 'ok' ? ext.result : (ext.result ?? '');
		const meta: IKbMetaTags = {
			title: ext.title || ogMeta.title || undefined,
			author: ogMeta.author,
			siteName: ogMeta.siteName ?? platform.name,
			description: ogMeta.description,
			date: ogMeta.date,
			cover: ogMeta.cover,
			videoUrl: ogMeta.videoUrl,
			durationSec: ogMeta.durationSec,
			tags: ogMeta.tags,
		};
		const base = this.slugFromUrl(url);
		const mediaDir = URI.joinPath(target, 'media');

		// P0-3：内容清洗管道（去 HTML 残留 / 脚本 / 样式 / 实体解码 / 空白规范化）
		const sanitized = sanitizeUrlContent(body, url, platform.type);
		body = sanitized.text;

		if (platform.type === 'video') {
			// 视频：先 best-effort 下载直链媒体，再落盘元数据 Markdown
			let mediaLocalPath: string | undefined;
			let downloaded = false;
			if (meta.videoUrl && isDownloadableMedia(meta.videoUrl)) {
				mediaLocalPath = await this.tryDownloadMedia(meta.videoUrl, mediaDir, base, true);
				downloaded = !!mediaLocalPath;
			}
			const md = composeVideoMarkdown({ url, platformName: platform.name, meta, mediaLocalPath, downloaded });
			const fileUri = await this.uniqueName(target, base, '.md');
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(md));
			await this.refreshSection('library');
			this.notificationService.info(localize(
				downloaded ? 'kb.urlImportedVideo' : 'kb.urlImportedMeta',
				downloaded ? '已抓取视频并导入：{0}' : '已记录视频元信息（未能直接下载文件）：{0}',
				fileUri.path.split('/').pop(),
			));
			void this._logOp('kb.import.url', 'success', { source: url, target: fileUri.fsPath, detail: { platform: platform.id, type: 'video', downloaded } });
			return;
		}

		// 图文 / mixed：本地化正文内图片 + 组装 Markdown
		const localizedBody = await this.localizeBodyImages(body, mediaDir, base);
		let coverLocalPath: string | undefined;
		if (meta.cover) {
			coverLocalPath = await this.tryDownloadImage(meta.cover, mediaDir, base + '_cover');
		}
		const extraNote = !localizedBody.trim()
			? '\n> ⚠️ 未能抓取正文（页面可能需要登录或启用了强反爬）。已保留链接与元信息，可手动补齐。\n'
			: '';
		const md = composeArticleMarkdown({ url, platformName: platform.name, meta, body: localizedBody + extraNote, coverLocalPath });
		const fileUri = await this.uniqueName(target, base, '.md');
		await this.fileService.writeFile(fileUri, VSBuffer.fromString(md));
		await this.refreshSection('library');
		this.notificationService.info(localize('kb.urlImported', '已导入：{0}', fileUri.path.split('/').pop()));
		void this._logOp('kb.import.url', 'success', { source: url, target: fileUri.fsPath, detail: { platform: platform.id, type: platform.type } });
	}

	/** 经主进程网络层（IRequestService，绕过渲染进程 CORS）取回页面 HTML 并解析 OG 元信息。失败返回空对象。 */
	private async fetchOgMeta(url: string): Promise<IKbMetaTags> {
		try {
			const context = await this.requestService.request({
				type: 'GET',
				url: toSecureScheme(url),
				followRedirects: 5,
				headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SarosisKB/1.0)' },
				callSite: 'saros.knowledgeBase.urlImport.og',
			}, CancellationToken.None);
			const status = context.res.statusCode;
			if (!status || status < 200 || status >= 300) { return {}; }
			return parseMetaTags((await asText(context)) ?? '');
		} catch (err) {
			this.logService.warn(`[KB] fetchOgMeta failed: ${err}`);
			return {};
		}
	}

	/** best-effort 下载媒体（视频，经 IRequestService 流式写入）到目录；失败返回 undefined。 */
	private async tryDownloadMedia(url: string, dir: URI, base: string, isVideo = false): Promise<string | undefined> {
		try {
			await this.fileService.createFolder(dir);
			const secureUrl = toSecureScheme(url);
			const context = await this.requestService.request({
				type: 'GET',
				url: secureUrl,
				followRedirects: 5,
				headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SarosisKB/1.0)', 'Referer': secureUrl },
				callSite: 'saros.knowledgeBase.urlImport.media',
			}, CancellationToken.None);
			const status = context.res.statusCode;
			if (!status || status < 200 || status >= 300) { return undefined; }
			const mime = (context.res.headers['content-type'] as string | undefined) ?? '';
			if (isVideo && !isDownloadableMedia(url, mime)) { return undefined; }
			const ext = guessMediaExt(url, mime);
			const fileUri = await this.uniqueName(dir, base, '.' + ext);
			const buf = await streamToBuffer(context.stream);
			await this.fileService.writeFile(fileUri, buf);
			return fileUri.fsPath;
		} catch (err) {
			this.logService.warn(`[KB] media download failed: ${err}`);
			return undefined;
		}
	}

	/** best-effort 下载单张图片（经 SharedWebContentExtractor，已校验 image/* MIME）到目录；失败返回 undefined。 */
	private async tryDownloadImage(url: string, dir: URI, base: string): Promise<string | undefined> {
		try {
			const buf = await this._sharedWebContentExtractor.readImage(URI.parse(url), CancellationToken.None);
			if (!buf) { return undefined; }
			await this.fileService.createFolder(dir);
			const ext = guessMediaExt(url);
			const fileUri = await this.uniqueName(dir, base, '.' + ext);
			await this.fileService.writeFile(fileUri, buf);
			return fileUri.fsPath;
		} catch (err) {
			this.logService.warn(`[KB] image download failed: ${err}`);
			return undefined;
		}
	}

	/**
	 * 把正文 Markdown 中的远程图片（![alt](url)）下载到 media/ 并改写为本地相对路径。
	 * 复用 Markdown 内嵌的 URL（WebContentExtractor 已把 AX 树里的图片转成 ![]()）。
	 */
	private async localizeBodyImages(body: string, dir: URI, base: string): Promise<string> {
		const imgUrls = findMarkdownImageUrls(body);
		const replacements = new Map<string, string>();
		const tasks: Promise<void>[] = [];
		imgUrls.forEach((imgUrl, idx) => {
			const localName = `${base}_img${idx}`;
			tasks.push(
				this.tryDownloadImage(imgUrl, dir, localName).then(local => {
					if (local) { replacements.set(imgUrl, local); }
				})
			);
		});
		if (tasks.length) { await Promise.all(tasks); }
		return rewriteMarkdownImageUrls(body, replacements);
	}



	private slugFromUrl(url: string): string {
		try {
			const u = new URL(url);
			const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
			const clean = last.replace(/[\\/:*?"<>|#.]/g, '_').slice(0, 60);
			return clean || 'import';
		} catch {
			return 'import';
		}
	}

	// ═══════════════════════════════════════════════════════════
	//  Sort
	// ═══════════════════════════════════════════════════════════

	private openSortDropdown(anchorSection: HTMLElement, anchorBtn: HTMLElement): void {
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
		} catch (err) {
			this.logService.warn(`[KB] buildNoteFromLibrary: ${err}`);
			this.notificationService.warn(`构建失败：${err}`);
		}
	}

	/** 工具栏按钮：批量构建全部库中未处理文件。 */
	private async _batchBuildAll(): Promise<void> {
		try {
			if (!this._activeVault) { this.notificationService.warn('请先选择知识库。'); return; }
			const vaultRoot = this.vaultUri(this._activeVault);
			await KbImportController.buildAllPendingNotes(vaultRoot, {
				fileService: this.fileService,
				configService: this.configurationService,
				logService: this.logService,
				notificationService: this.notificationService,
				agentStudioService: this.agentStudioService,
				requestService: this.requestService,
			});
			await this.refreshSection('notes');
			await this.refreshSection('library');
		} catch (err) {
			this.logService.warn(`[KB] batchBuildAll: ${err}`);
			this.notificationService.warn(`批量构建失败：${err}`);
		}
	}

	// ═══════════════════════════════════════════════════════════
	//  原生文件树（WorkbenchCompressibleAsyncDataTree）
	// ═══════════════════════════════════════════════════════════

	private _createKbTree(): void {
		if (!this._activeVault || !this._kbTreeContainer) { return; }
		const vault = this._activeVault;
		const container = this._kbTreeContainer;

		// 清除旧树实例
		if (this._kbTree) {
			this._kbTree.dispose();
		}

		const libraryUri = this.sectionUri(vault, 'library');
		const notesUri = this.sectionUri(vault, 'notes');

		this._register(createFileIconThemableTreeContainerScope(container, this.themeService));

		const dataSource = new KbTreeDataSource(
			this.fileService,
			() => ({ libraryUri, notesUri }),
			() => this._sortMode,
		);

		const filter = new KbTreeFilter(() => this._searchInput?.value?.trim().toLowerCase() ?? '');

		// 拖拽移动：把文件/文件夹拖到分区根或目录节点上 → 移动到该目录
		const dnd = new KbTreeDragAndDrop(
			this.fileService,
			(section) => this.sectionUri(vault, section),
			() => this._refreshKbTree(),
		);

		this._kbTree = this._register(this.instantiationService.createInstance(
			WorkbenchCompressibleAsyncDataTree<null, KbTreeElement, FuzzyScore>,
			'KnowledgeBase', container,
			new KbTreeDelegate(),
			{ isIncompressible: () => true },
			[new KbSectionRenderer(), new KbNodeRenderer()],
			dataSource,
			{
			accessibilityProvider: new KbTreeAccessibilityProvider(),
			filter,
			dnd,
			sorter: new KbTreeSorter(),
				multipleSelectionSupport: false,
				identityProvider: kbTreeIdentityProvider(),
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel(e: KbTreeElement) {
						return isSectionNode(e) ? e.label : e.name;
					},
					getCompressedNodeKeyboardNavigationLabel(e: KbTreeElement[]) {
						return e.map(x => isSectionNode(x) ? x.label : x.name).join('/');
					},
				},
			},
		));

		// 双击/Enter 打开文件
		this._register(this._kbTree.onDidOpen(e => {
			if (e.element && !isSectionNode(e.element) && !e.element.isDirectory) {
				this.openInEditor(e.element);
			}
		}));

		// 右键菜单
		this._register(this._kbTree.onContextMenu((e: ITreeContextMenuEvent<KbTreeElement>) => {
			if (!e.element || isSectionNode(e.element)) { return; }
			const node = e.element as IKbNode;
			const items: { label: string; run: () => void }[] = [
				{ label: '新建文件', run: () => { void this.newFile(node.section, node.isDirectory ? node : undefined); } },
				{ label: '新建文件夹', run: () => { void this.newFolder(node.section, node.isDirectory ? node : undefined); } },
				{ label: '重命名', run: () => { /* TODO: tree rename */ } },
				{ label: '删除', run: () => { void this.deleteNode(node); } },
			];
			if (!node.isDirectory) { items.push({ label: '打开', run: () => this.openInEditor(node) }); }
			if (!node.isDirectory && node.section === 'library') {
				items.push({ label: '构建为笔记', run: () => { void this._buildNoteFromLibrary(node); } });
			}
			if (!node.isDirectory && node.section === 'notes') {
				items.push({ label: '移入审核', run: () => { void this._moveToReview(node); } });
			}
			const me = e.browserEvent as MouseEvent;
			this.showSimpleMenu(items, me.clientX, me.clientY);
		}));

		this._kbTree.layout();
		this._kbTree.setInput(null);

		// 默认展开两个 section
		this._kbTree.expandAll();
	}

	private _refreshKbTree(): void {
		if (!this._kbTree || !this._activeVault) { return; }
		// 递归刷新所有已展开节点：重新向 DataSource 查询，保留用户展开状态，
		// 新增/删除/重命名的文件与文件夹会即时反映（替代 setInput(null)，
		// 后者只重建 root 且仅展开两个 section，导致已展开子文件夹折叠且内容不刷新）。
		void this._kbTree.updateChildren();
		// 保证「库 / 笔记」两个 root section 始终展开，便于用户看到变化
		this._kbTree.expandAll();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._kbTree?.layout(height, width);
	}

	override focus(): void {
		super.focus();
		this._kbTree?.domFocus();
	}

	// ═══════════════════════════════════════════════════════════
	//  Context menus
	// ═══════════════════════════════════════════════════════════

	private nodeContextMenu(e: MouseEvent, el: HTMLElement, node: IKbNode): void {
		this.selectNode(el);
		const items: { label: string; run: () => void }[] = [
			{ label: '新建文件', run: () => { void this.newFile(node.section, node.isDirectory ? node : undefined); } },
			{ label: '新建文件夹', run: () => { void this.newFolder(node.section, node.isDirectory ? node : undefined); } },
			{ label: '重命名', run: () => this.startRename(el, node) },
			{ label: '删除', run: () => { void this.deleteNode(node); } },
		];
		if (!node.isDirectory) { items.push({ label: '打开', run: () => this.openInEditor(node) }); }
		// 库文件：构建为笔记（双阶段 LLM + FILE 块）
		if (!node.isDirectory && node.section === 'library') {
			items.push({ label: '构建为笔记', run: () => { void this._buildNoteFromLibrary(node); } });
		}
		// P2-1：笔记节点可「移入审核」（低质量笔记先隔离到 .review/，供人工确认）
		if (!node.isDirectory && node.section === 'notes') {
			items.push({ label: '移入审核', run: () => { void this._moveToReview(node); } });
		}
		this.showSimpleMenu(items, e.clientX, e.clientY);
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

	private applyFilter(_q: string): void {
		const q = _q.trim().toLowerCase();
		let resultsEl = this._scroll.querySelector('.kb-search-results') as HTMLElement | null;
		if (!q) {
			// 清空搜索：取消待处理搜索 + 恢复分区树
			if (this._searchDebounceTimer) { clearTimeout(this._searchDebounceTimer); this._searchDebounceTimer = undefined; }
			this._scroll.querySelectorAll('.kb-section').forEach(s => (s as HTMLElement).style.display = '');
			if (resultsEl) { resultsEl.classList.remove('show'); resultsEl.replaceChildren(); }
			if (this._backlinksEl) { this._backlinksEl.style.display = ''; }
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

		// 增量：比对 DB 现有文档的 mtime+size，只重读变更文件；并删除已从磁盘移除的文档。
		// 一次 getAllUris 查询同时用于变更检测与删除清理。
		const dbDocs = await this._kbSqliteStore.getAllUris();
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
				await this._kbSqliteStore.upsertDocsBatch(docs);
				this.logService.info(`[KB SQLite] synced ${docs.length} changed docs (${(performance.now() - t).toFixed(1)}ms)`);
			}
		} else {
			this.logService.info(`[KB SQLite] no changed docs; incremental sync skipped`);
		}

		// 删除已从磁盘移除的文档（metas 中不存在的 DB 记录）
		try {
			let removed = 0;
			for (const u of dbDocs) {
				if (!metaSet.has(u.uri)) { await this._kbSqliteStore.deleteDoc(u.uri); removed++; }
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
		const icon = $('span.kb-ficon'); icon.textContent = this.fileEmoji(hit.name); el.appendChild(icon);
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
		if (this._searchDirty) {
			await this.rebuildSearchAssets();
		}
		const { nodes, links } = this._graph.getGraphData();
		if (nodes.length === 0) {
			this.notificationService.info('知识库暂无可绘制的关系（先导入或创建带双链的笔记）');
			return;
		}
		// 携带库/笔记分区根目录（不含关联的代码仓库），供「关系图谱」EditorPane 内的「构建图谱」按钮重新扫描
		const roots = this.buildGraphRoots();
		const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
		const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
		this.editorService.openEditor(
			new KbGraphEditorInput(nodes, links, '关系图谱', roots),
			{ pinned: true },
			targetGroup,
		);
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

	private static readonly KB_AGENT_ID = 'knowledge-base-expert';

	/**
	 * Check whether the knowledge-base-expert agent has a configured chat provider
	 * (API key + base URL). Returns a user-facing error message when not configured.
	 */
	private _checkKbAgentProvider(): string | null {
		// 只要存在任一已配置 API key 的 chat provider 即可；KB agent 不绑定特定 provider。
		if (isChatProviderConfigured(this.configurationService)) {
			return null; // OK
		}
		const configPath = '设置 → Agent Studio → Model Providers';
		return `知识库专家 Agent 尚未配置 Chat Provider（API key + base URL）。请在「${configPath}」中添加 Provider 后重试。`;
	}

	/**
	 * Route an import action through the knowledge-base-expert agent's skill.
	 *
	 * 1. Checks that a chat provider is configured — if not, notifies and returns.
	 * 2. Ensures the import skill SKILL.md exists in the user skills directory.
	 * 3. Opens the KB agent chat and sends the `[skill:xxx]` command.
	 *
	 * @param skillId   Skill ID (e.g. 'kb-import-url', 'kb-import-message')
	 * @param skillMd   SKILL.md content to write if the skill doesn't exist
	 * @param message   The message text to send to the agent (after opening chat)
	 * @param label     Short label for the notification (e.g. 'URL 导入')
	 */
	private async _routeImportToKbAgent(
		skillId: string,
		skillMd: string,
		message: string,
		label: string,
	): Promise<void> {
		const agentId = KnowledgeBaseViewPane.KB_AGENT_ID;

		// 0. Guard: check provider
		const providerErr = this._checkKbAgentProvider();
		if (providerErr) {
			this.notificationService.warn(providerErr);
			return;
		}

		try {
			// 1. Ensure skill exists + mount to agent
			await this._ensureImportSkill(agentId, skillId, skillMd);

			// 2. Open KB agent chat
			this.modelSelectorService.setSelectedAgentId(agentId);
			this.agentStudioService.fireSelectAgent(agentId);
			await this.viewsService.openView(AGENT_STUDIO_CHAT_VIEW_ID, true);

			// 3. Send import command
			this.configHtmlService.requestChatSend(agentId, message);

			this.notificationService.info(`已将「${label}」发送至「知识库专家」Agent 处理`);
		} catch (err) {
			this.logService.error(`[KB] ${label} send failed:`, err);
			this.notificationService.error(`${label} 发送失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Ensure a KB import skill SKILL.md exists and is mounted to the agent.
	 * Idempotent — if the file already exists, only registry reload + agent binding runs.
	 */
	private async _ensureImportSkill(agentId: string, skillId: string, mdContent: string): Promise<void> {
		const skillsRoot = resolveSarosPath(
			URI.file((this.environmentService as INativeEnvironmentService).userDataPath),
			SarosPath.skills,
		);
		const skillMdUri = URI.joinPath(skillsRoot, skillId, 'SKILL.md');

		try {
			await this.fileService.stat(skillMdUri);
		} catch {
			await this.fileService.createFolder(dirname(skillMdUri));
			await this.fileService.writeFile(skillMdUri, VSBuffer.fromString(mdContent));
			this.logService.info(`[KB] created ${skillId} skill at ${skillMdUri.toString()}`);
		}

		// Re-scan so SkillRegistry discovers it
		await this._skillRegistry.reload();

		// Mount to agent
		const agent = await this.agentStudioService.getAgent(agentId);
		if (agent && !(agent.skills ?? []).includes(skillId)) {
			const skills = [...(agent.skills ?? []), skillId];
			await this.agentStudioService.updateAgent(agentId, { skills } as any);
			this.logService.info(`[KB] mounted ${skillId} skill to agent ${agentId}`);
		}

		// Sync to memory engine
		try {
			const memProvider = this._agentOSService.getActiveMemoryProvider();
			if (memProvider?.writeSkillFile) {
				await memProvider.writeSkillFile(agentId, skillId);
			}
		} catch { /* ignore */ }
	}

	// ── Import skill SKILL.md generators ──────────────────────

	private _buildImportObsidianSkillMd(): string {
		return `---
name: kb-import-obsidian
description: 导入 Obsidian 库（关联文件夹）：扫描 .md 文件 → 自动分类落盘到「库」→ 结构化抽取 → 输出笔记到「笔记」→ 记录操作日志
---

# 导入 Obsidian 库（kb-import-obsidian）

## 输入
- 调用方通过消息提供 Obsidian 库根目录的绝对路径。

## 流程（完整链）
1. **扫描**：列出 \`.md\` 文件，保留原始 \`[[wikilinks]]\` 和 frontmatter。跳过 \`.obsidian/\`、\`.trash/\` 等非内容目录。
2. **自动分类**：解析 frontmatter（tags/aliases/category）和目录结构，自动确定分类；缺省按原 Obsidian 目录结构映射到 \`<vault>/库/<category>/\`。
3. **落盘到库**：复制 Markdown 到 \`<vault>/库/<category>/\`（保留双链语法）。
4. **结构化抽取**：对每篇文档执行结构化抽取，提炼实体/概念/流程，生成带 \`[[wikilinks]]\` 的笔记。跨文档的双链（如 \`[[Another Note]]\`）转换为可追踪的内部链接。
5. **落盘到笔记**：将结构化笔记写入 \`<vault>/笔记/<category>/\`（增量合并同名笔记）。
6. **操作日志**：每条导入完成后向 \`<kb-root>/.op-log.jsonl\` 追加一行 JSONL 记录。

## 输出
- 导入完成后，向用户报告：导入数量 / 库路径 / 笔记路径 / 操作日志摘要`;
	}

	// ── End of import skill generators ─────────────────────

	// ─── 笔记沉淀（占位：功能开发中，暂未实现）──────────────

	private async _onNoteSedimentationClick(): Promise<void> {
		// TODO: 笔记沉淀功能开发中，暂未实现，仅占位
		this.notificationService.info('笔记沉淀功能开发中，敬请期待');
	}

	// ─── 结构化抽取（打开「知识库专家」Agent 自动抽取当前「库」分区，未来笔记沉淀功能落地后复用）─────────────

	private async _onStructuredExtractClick(): Promise<void> {
		if (!this._activeVault) {
			this.notificationService.warn('请先选择一个知识库');
			return;
		}
		const agentId = KnowledgeBaseViewPane.KB_AGENT_ID;
		const skillId = 'structured-extract';

		try {
			// 1. Ensure skill exists and is mounted
			await this._ensureStructuredExtractSkill(agentId, skillId);

			// 2. Open KB agent chat
			this.modelSelectorService.setSelectedAgentId(agentId);
			this.agentStudioService.fireSelectAgent(agentId);
			await this.viewsService.openView(AGENT_STUDIO_CHAT_VIEW_ID, true);

			// 3. Send structured-extract command
			const libUri = this.sectionUri(this._activeVault, 'library');
			const message =
				`[skill:${skillId}] 请对当前知识库「${this._activeVault.name}」的「库」分区（路径：${libUri.fsPath}）进行结构化抽取：` +
				`逐文档阅读，提炼实体/概念/流程，整理为带 [[wikilinks]] 的结构化笔记输出到「笔记」分区；若同名笔记已存在则增量合并。`;
			this.configHtmlService.requestChatSend(agentId, message);

			this.notificationService.info(`已打开「知识库专家」并发送结构化抽取指令（库分区：${libUri.fsPath}）`);
		} catch (err) {
			this.logService.error(`[KB] 结构化抽取失败: ${err}`);
			this.notificationService.error(`结构化抽取失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _ensureStructuredExtractSkill(agentId: string, skillId: string): Promise<void> {
		const skillsRoot = resolveSarosPath(
			URI.file((this.environmentService as INativeEnvironmentService).userDataPath),
			SarosPath.skills,
		);
		const skillMdUri = URI.joinPath(skillsRoot, skillId, 'SKILL.md');

		try {
			await this.fileService.stat(skillMdUri);
		} catch {
			// 技能文件不存在 → 写入默认 SKILL.md
			const md = this._buildStructuredExtractSkillMd(skillId);
			await this.fileService.createFolder(dirname(skillMdUri));
			await this.fileService.writeFile(skillMdUri, VSBuffer.fromString(md));
			this.logService.info(`[KB] created ${skillId} skill at ${skillMdUri.toString()}`);
		}

		// 重新扫描技能目录，让 SkillRegistry 发现它
		await this._skillRegistry.reload();

		// 挂载到 知识库专家 agent
		const agent = await this.agentStudioService.getAgent(agentId);
		if (agent && !(agent.skills ?? []).includes(skillId)) {
			const skills = [...(agent.skills ?? []), skillId];
			await this.agentStudioService.updateAgent(agentId, { skills } as any);
			this.logService.info(`[KB] mounted ${skillId} skill to agent ${agentId}`);
		}

		// 同步到记忆引擎（best-effort）
		try {
			const memProvider = this._agentOSService.getActiveMemoryProvider();
			if (memProvider?.writeSkillFile) {
				await memProvider.writeSkillFile(agentId, skillId);
			}
		} catch { /* 忽略 */ }
	}

	private _buildStructuredExtractSkillMd(skillId: string): string {
		return `---
name: ${skillId}
description: 对知识库「库」分区文档进行结构化抽取，输出带 wikilinks 的结构化笔记到「笔记」分区
---

# 结构化抽取（Structured Extraction）

你负责把知识库「库」分区中的非结构化文档，转化为结构化、可检索、互相链接的笔记。

## 输入
- 由调用方通过消息提供目标「库」分区路径（或具体文档）。

## 流程
1. 列出「库」分区中的文档，逐篇阅读。
2. 对每篇文档提炼：
   - 核心实体 / 概念（名词短语）
   - 关键流程 / 步骤
   - 关键结论 / 参数 / 命令
3. 为提炼出的概念生成独立的 Markdown 笔记，文件名用概念 slug，正文包含：
   - 一句话定义
   - 要点列表
   - 与相关概念的 [[wikilink]] 双向链接
4. 将笔记写入「笔记」分区；若同名笔记已存在，执行增量合并（去重、补全、保留来源引用）。
5. 完成后输出一份抽取摘要（共处理 N 篇文档、新建 M 条笔记、更新 K 条笔记）。

## 约束
- 使用中文。
- 只基于「库」分区真实内容抽取，不臆造。
- 笔记之间尽量用 [[概念]] 互链，形成知识网络。
`;
	}

	override dispose(): void {
		document.removeEventListener('click', this._onGlobalClick);
		if (this._searchRebuildTimer) { clearTimeout(this._searchRebuildTimer); this._searchRebuildTimer = undefined; }
		if (this._searchDebounceTimer) { clearTimeout(this._searchDebounceTimer); this._searchDebounceTimer = undefined; }
		this._kbWorker?.dispose();
		this._kbWorker = undefined;
		super.dispose();
	}
}
