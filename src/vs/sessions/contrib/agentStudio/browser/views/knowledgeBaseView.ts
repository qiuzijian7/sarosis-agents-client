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
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
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
	findMarkdownImageUrls, rewriteMarkdownImageUrls, type IKbMetaTags,
} from './knowledgeBase/kbUrlScraper.js';
import { KbFullTextIndex, IKbSearchHit } from './knowledgeBase/kbIndex.js';
import { KbLinkGraph } from './knowledgeBase/kbGraph.js';
import { KbNativeKernel, INativeBacklinkResult } from './knowledgeBase/kbNativeKernel.js';
import { IKbNativeKernelService, type IKbBuildRoot } from '../kbNativeKernelService.js';
import { IEmbeddingService } from '../../common/embeddingProvider.js';
import { resolveAuxEmbeddingProviderId } from '../knowledge/embeddingConfigResolver.js';
import { KbNoteEditorInput } from '../kbNoteEditorInput.js';
import { KbGraphEditorInput } from '../kbGraphEditorInput.js';
import { appendKbOpLog, type IKbOpLogEntry, type KbOpChannel, type KbOpStatus } from '../knowledge/kbOpLog.js';
import { resolveKbRoot } from '../knowledge/knowledgeStorage.js';
import { IKbVectorSearchHit, KB_RAG_INDEX_FILE } from './knowledgeBase/kbVectorIndex.js';

const KB_ROOT_SUBPATH = '.saros/knowledge-base';
const STORAGE_VAULTS = 'agentStudio.kb.vaults';
const STORAGE_ACTIVE = 'agentStudio.kb.active';
const STORAGE_ROOT_DIR = 'agentStudio.kb.rootDir';
const STORAGE_SORT_PREFIX = 'agentStudio.kb.sort.';
const STORAGE_EXPANDED_PREFIX = 'agentStudio.kb.expanded.';
const STORAGE_SECTION_PREFIX = 'agentStudio.kb.section.';

/** HTML escape helper (used by RAG Ask KB response rendering). */
function _escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

	private _vaults: IKbVault[] = [];
	private _activeVault: IKbVault | undefined;

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

	/** 反链面板容器 */
	private _backlinksEl?: HTMLElement;

	/** vssaros 内置内核（零外部依赖，始终可用） */
	private _nativeKernel: KbNativeKernel | undefined;

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
	}

	// ═══════════════════════════════════════════════════════════
	//  Paths
	// ═══════════════════════════════════════════════════════════

	private get rootUri(): URI {
		const custom = this.storageService.get(STORAGE_ROOT_DIR, StorageScope.APPLICATION);
		if (custom) { return URI.file(custom); }
		return URI.joinPath((this.environmentService as INativeEnvironmentService).userHome, ...KB_ROOT_SUBPATH.split('/'));
	}

	private vaultUri(v: IKbVault): URI {
		if (v.customPath) { return URI.file(v.customPath); }
		return URI.joinPath(this.rootUri, v.id);
	}

	private sectionUri(v: IKbVault, section: KbSection): URI {
		if (section === 'notes' && v.notesPath) {
			// 笔记分区可单独配置根目录（指向外部文件夹）
			return URI.file(v.notesPath);
		}
		const folder: SectionFolderName = section === 'library' ? '库' : '笔记';
		return URI.joinPath(this.vaultUri(v), folder);
	}

	// ═══════════════════════════════════════════════════════════
	//  Operation log (`.saros/kb/.op-log.jsonl`)
	// ═══════════════════════════════════════════════════════════

	/** 操作日志统一落盘到知识库存储根（默认 `~/.saros/kb`），与 Agent 工具路径共用同一份 `.op-log.jsonl`。 */
	private get _opLogRootDir(): string {
		const cfg = this.configurationService.getValue<string>('agentStudio.knowledge.storage.path');
		return resolveKbRoot(cfg, (this.environmentService as INativeEnvironmentService).userHome.fsPath);
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

		// Header
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
		const settingsBtn = $('span.kb-hbtn');
		settingsBtn.textContent = '⚙'; settingsBtn.title = '知识库设置（根目录等）';
		settingsBtn.onclick = (e) => { e.stopPropagation(); this.toggleSettingsPanel(); };
		this._settingsBtn = settingsBtn;
		header.appendChild(settingsBtn);
		this._body.appendChild(header);

		// 设置面板（⚙ 下拉）：含根目录自定义；默认不挂入 DOM，打开时由 positionDropdown 定位
		this._settingsDD = $('div.kb-dropdown.kb-settings');

		// Vault switcher
		this._vaultBar = $('div.kb-vault-bar');
		this._body.appendChild(this._vaultBar);
		this._vaultMenu = $('div.kb-vault-menu');
		this._body.appendChild(this._vaultMenu);

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
		this._body.appendChild(searchRow);

		// Ask KB — RAG 问答区（Phase 3）
		this._renderAskKb();

		// Scroll area
		this._scroll = $('div.kb-scroll');
		this._body.appendChild(this._scroll);

		// Global click closes popups
		document.addEventListener('click', this._onGlobalClick);

		// initVaults 为异步链，失败会被吞掉导致整块空白；显式 catch 以暴露真实错误
		this.logService.info(`[KB perf] renderBody skeleton: ${(performance.now() - t0).toFixed(1)}ms, starting initVaults...`);
		void this.initVaults().then(() => {
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

	private _onGlobalClick = () => {
		this._vaultMenu.classList.remove('show');
		this._body.querySelectorAll('.kb-dropdown.show').forEach(d => d.classList.remove('show'));
	};

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

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

	private async createVault(name: string, icon = '📚'): Promise<void> {
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
		this.renderBacklinksPanel();
		this.logService.info(`[KB perf] renderAll total: ${(performance.now() - t0).toFixed(1)}ms`);
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
			{ label: '删除', run: () => { void this.removeVault(v); } },
		];
		this.showSimpleMenu(items);
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
		// RAG 向量索引（构建 / 导入 .kbrag.json / 导出 .kbrag.json）
		const ragBtn = $('span.kb-sec-btn'); ragBtn.textContent = '🧠'; ragBtn.title = 'RAG 向量索引：构建 / 导入 / 导出 .kbrag.json（语义搜索）';
		ragBtn.onclick = (e) => { e.stopPropagation(); this.openRagDropdown(sectionEl, ragBtn); };
		toolbar.append(newFile, newFolder, importBtn, ragBtn);
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
				for (const p of this._activeVault.linkedFolders) {
					body.appendChild(this.renderLinkedFolder(p));
				}
			}
			countEl.textContent = String(this.countNodes(section, nodes));
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
		try {
			await this.fileService.del(node.uri, { recursive: true });
			void this._logOp('node.delete', 'success', { target: node.uri.fsPath, detail: { section: node.section, isDirectory: node.isDirectory } });
		} catch (err) {
			void this._logOp('node.delete', 'failure', { target: node.uri.fsPath, detail: { section: node.section }, error: String(err) });
		}
		this._expandedFolders.delete(node.path);
		await this.refreshSection(node.section);
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
		this.markSearchDirty(); // 文件变更后索引/图谱失效
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

		// 根目录配置行
		const row = $('div.kb-set-row');
		const label = $('span.kb-set-label'); label.textContent = '📁 根目录';
		const path = $('span.kb-set-path'); path.id = 'kbRootPath'; path.textContent = this.rootUri.fsPath;
		const browse = $('span.kb-set-btn.primary'); browse.id = 'kbRootBrowse'; browse.textContent = '📂'; browse.title = '浏览文件夹…';
		const manual = $('span.kb-set-btn'); manual.id = 'kbRootManual'; manual.textContent = '📄'; manual.title = '手动输入路径';
		row.append(label, path, browse, manual);
		this._settingsDD.appendChild(row);

		const hint = $('div.kb-set-hint'); hint.textContent = '点击 📂 选择文件夹，或 📄 手动输入路径（知识库根目录，默认 Vault 将随之迁移）';
		this._settingsDD.appendChild(hint);

		// 笔记根目录配置行（仅当前激活 Vault；留空回退到 Vault 内默认「笔记」）
		if (this._activeVault) {
			const notesRow = $('div.kb-set-row');
			const notesLabel = $('span.kb-set-label'); notesLabel.textContent = '📝 笔记根目录';
			const notesPath = $('span.kb-set-path'); notesPath.id = 'kbNotesPath';
			notesPath.textContent = this.sectionUri(this._activeVault, 'notes').fsPath;
			notesPath.title = this._activeVault.notesPath ?? '未自定义（使用默认「笔记」子文件夹）';
			const notesBrowse = $('span.kb-set-btn.primary'); notesBrowse.id = 'kbNotesBrowse'; notesBrowse.textContent = '📂'; notesBrowse.title = '浏览笔记根目录…';
			const notesManual = $('span.kb-set-btn'); notesManual.id = 'kbNotesManual'; notesManual.textContent = '📄'; notesManual.title = '手动输入 / 清空笔记根目录';
			notesRow.append(notesLabel, notesPath, notesBrowse, notesManual);
			this._settingsDD.appendChild(notesRow);

			const notesHint = $('div.kb-set-hint'); notesHint.textContent = '将「笔记」分区指向自定义文件夹（留空则使用 Vault 内默认的「笔记」）';
			this._settingsDD.appendChild(notesHint);

			notesBrowse.onclick = (e) => { e.stopPropagation(); void this.pickNotesPath(notesPath.textContent); };
			notesManual.onclick = (e) => {
				e.stopPropagation();
				const input = document.createElement('input');
				input.className = 'kb-set-input';
				input.value = notesPath.textContent;
				input.placeholder = '留空回退到默认「笔记」';
				notesPath.replaceWith(input);
				input.focus(); input.select();
				let done = false;
				const commitNotes = (save: boolean) => {
					if (done) { return; }
					done = true;
					if (save) { void this.applyNotesPath(input.value.trim()); }
					else { this.renderSettingsPanel(); }
				};
				input.onkeydown = (ke) => {
					if (ke.key === 'Enter') { ke.preventDefault(); commitNotes(true); }
					else if (ke.key === 'Escape') { ke.preventDefault(); commitNotes(false); }
				};
				input.onblur = () => commitNotes(true);
			};
		}

		// 快捷入口：打开当前知识库文件夹
		const openRow = $('div.kb-set-row');
		const openBtn = $('div.kb-set-action'); openBtn.textContent = '📂 打开知识库文件夹';
		openBtn.onclick = (e) => { e.stopPropagation(); this._settingsDD.classList.remove('show'); void this.openKbFolder(); };
		openRow.appendChild(openBtn);
		this._settingsDD.appendChild(openRow);

		// 交互
		const rootPath = path;
		browse.onclick = (e) => { e.stopPropagation(); void this.pickRootDir(rootPath.textContent); };
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
				if (save && v) { void this.applyRootDir(v); }
				else { this.renderSettingsPanel(); }
			};
			input.onkeydown = (ke) => {
				if (ke.key === 'Enter') { ke.preventDefault(); commit(true); }
				else if (ke.key === 'Escape') { ke.preventDefault(); commit(false); }
			};
			input.onblur = () => commit(true);
		};
	}

	/** 调原生文件夹选择框，选取知识库根目录。 */
	private async pickRootDir(current: string): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('kb.pickRoot', '选择知识库根目录'),
			canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
			defaultUri: URI.file(current),
		});
		if (!picked || !picked.length) { return; }
		await this.applyRootDir(picked[0].fsPath);
	}

	/** 应用新的知识库根目录：持久化 + 迁移默认 Vault 路径 + 重新激活。 */
	private async applyRootDir(dir: string): Promise<void> {
		const fsPath = URI.file(dir).fsPath;
		this.storageService.store(STORAGE_ROOT_DIR, fsPath, StorageScope.APPLICATION, StorageTarget.MACHINE);
		void this._logOp('vault.rootDir', 'success', { target: fsPath });

		// 默认 Vault（无 customPath）的路径跟随新根目录；外部配置的 Vault 不受影响
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
		this.notificationService.info(localize('kb.rootChanged', '知识库根目录已切换为：{0}', fsPath));
	}

	/** 调原生文件夹选择框，选取「笔记」分区根目录。 */
	private async pickNotesPath(current: string): Promise<void> {
		const picked = await this.fileDialogService.showOpenDialog({
			title: localize('kb.pickNotes', '选择「笔记」根目录'),
			canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
			defaultUri: URI.file(current),
		});
		if (!picked || !picked.length) { return; }
		await this.applyNotesPath(picked[0].fsPath);
	}

	/** 应用「笔记」分区根目录：持久化 + 刷新笔记分区（及索引/图谱）。 */
	private async applyNotesPath(dir: string): Promise<void> {
		if (!this._activeVault) { return; }
		const v = this._activeVault;
		const fsPath = dir ? URI.file(dir).fsPath : '';
		// 若指向 Vault 内默认「笔记」子文件夹，则视为未自定义（回退默认）
		const defaultNotes = URI.joinPath(this.vaultUri(v), '笔记').fsPath;
		v.notesPath = fsPath && fsPath !== defaultNotes ? fsPath : undefined;
		this.saveVaults();
		void this._logOp('vault.notesPath', 'success', { target: v.notesPath ?? '(default)' });

		// 重建 Vault（确保自定义目录存在 + 刷新笔记树 / 索引上下文）
		await this.activateVault(v);

		// 刷新设置面板内的笔记路径展示
		const np = this._settingsDD.querySelector('#kbNotesPath') as HTMLElement | null;
		if (np) {
			np.textContent = this.sectionUri(v, 'notes').fsPath;
			np.title = v.notesPath ?? '未自定义（使用默认「笔记」子文件夹）';
		}
		this.notificationService.info(
			v.notesPath
				? localize('kb.notesChanged', '「笔记」根目录已切换为：{0}', v.notesPath)
				: localize('kb.notesReset', '「笔记」根目录已回退为默认「笔记」子文件夹'),
		);
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

		// 统一 URL 导入入口：粘贴任意链接，由 KbUrlScraper 自动识别平台（小红书 / 抖音 / 知乎 / YouTube …），
		// 再按图文 / 视频策略抓取并落盘。受限站点（跨域 / 需登录）会清晰报错。
		if (kind === 'url') {
			const r = await this.dialogService.input({
				message: localize('kb.enterUrl', '粘贴要导入的链接（小红书 / 抖音 / 知乎 / B站 / YouTube / 微博 / 公众号 …）'),
				inputs: [{ value: '', placeholder: 'https://...' }],
			});
			const url = r.values?.[0]?.trim();
			if (r.confirmed && url) {
				await this.importFromUrl(url, target);
			}
			return;
		}

		try {
			if (kind === 'folder') {
				const picked = await this.fileDialogService.showOpenDialog({ title: '导入文件夹', canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
				if (picked?.length) {
					// 导入文件夹：先询问「关联（保持原位）/ 拷贝到知识库」
					const mode = await this.askImportFolderMode(picked[0].fsPath);
					if (mode === 'link') {
						await this.linkFolder(picked[0]);
					} else if (mode === 'copy') {
					const dest = URI.joinPath(target, this.baseName(picked[0]));
					await this.copyRecursive(picked[0], dest);
					void this._logOp('kb.import.folder', 'success', { source: picked[0].fsPath, target: dest.fsPath });
					// 拷贝完成后构建语义索引（目标目录已就绪）。
					void this._importFolderRagAsync(dest.fsPath, this._activeVault);
					}
				}
			} else if (kind === 'files') {
				const picked = await this.fileDialogService.showOpenDialog({ title: '导入文件', canSelectFiles: true, canSelectFolders: false, canSelectMany: true });
				if (picked?.length) {
					for (const f of picked) {
						const dest = URI.joinPath(target, this.baseName(f));
						await this.copyRecursive(f, dest);
						void this._logOp('kb.import.files', 'success', { source: f.fsPath, target: dest.fsPath });
					}
				}
			} else if (kind === 'obsidian') {
				const picked = await this.fileDialogService.showOpenDialog({ title: '导入 Obsidian 库', canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
				if (picked?.length) {
					// Obsidian：保留 .md 与 [[双链]]，作为普通 Markdown 复制（双链后续可映射为反链）
					const dest = URI.joinPath(target, this.baseName(picked[0]));
					await this.copyRecursive(picked[0], dest);
					this.notificationService.info(localize('kb.obsidianImported', '已导入 Obsidian 库（Markdown + 双链保留），放入「库」待索引。'));
					void this._logOp('kb.import.obsidian', 'success', { source: picked[0].fsPath, target: dest.fsPath });
				}
			}
		} catch (err) {
			void this._logOp('kb.import', 'failure', { detail: { kind }, error: String(err) });
		}
		await this.refreshSection('library');
	}

	private baseName(uri: URI): string {
		return uri.path.split('/').filter(Boolean).pop() || 'import';
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
	private async askImportFolderMode(srcPath: string): Promise<'link' | 'copy' | undefined> {
		const base = this.baseName(URI.file(srcPath));
		const r = await this.dialogService.prompt<'link' | 'copy'>({
			message: localize('kb.importFolderMode.title', '导入文件夹「{0}」：关联还是拷贝？', base),
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

	/**
	 * 后台为导入的文件夹构建「每 git 仓库 = 一个 RAG session」语义索引（方案 A）。
	 * 与全文索引（rebuildSearchAssets）解耦：即使语义构建失败 / 部分失败，全文索引仍可用。
	 * 完成后把 repoRoot→sessionId 映射写回 vault 元数据，供后续跨库检索 / git pull 增量重摄入。
	 */
	private async _importFolderRagAsync(folderPath: string, vault: IKbVault): Promise<void> {
		if (!vault) { return; }
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
		const unlinkBtn = $('span.kb-act'); unlinkBtn.textContent = '🔌'; unlinkBtn.title = '取消关联';
		unlinkBtn.onclick = (e) => { e.stopPropagation(); void this.unlinkFolder(path); };
		actions.append(openBtn, unlinkBtn);
		el.appendChild(actions);

		el.onclick = () => { void this.openerService.open(URI.file(path), { openExternal: true }); };
		el.oncontextmenu = (e) => {
			e.preventDefault(); e.stopPropagation();
			this.showSimpleMenu([
				{ label: '在文件管理器打开', run: () => { void this.openerService.open(URI.file(path), { openExternal: true }); } },
				{ label: '取消关联', run: () => { void this.unlinkFolder(path); } },
			]);
		};
		return el;
	}

	/**
	 * 统一 URL 导入入口：粘贴任意链接，自动识别平台（小红书 / 抖音 / 知乎 / YouTube / B站 / 微博 / 公众号 …），
	 * 再按图文（article / mixed）或视频（video）策略抓取并落盘到「库」分区。
	 */
	private async importFromUrl(url: string, target: URI): Promise<void> {
		const platform = detectPlatform(url);
		this.notificationService.info(localize('kb.urlFetching', '正在抓取「{0}」：{1}', platform.name, url));
		try {
			// 内容抽取：复用主进程 WebContentExtractor（真实 Chromium 渲染，天然支持 SPA / 反爬站点，
			//   等价于 Obsidian Clipper 的「扩展 content script 拿实时 DOM」能力，比正则更干净且能抓抖音/小红书/YouTube）。
			// 元信息：并行用 IRequestService 取 OG meta（封面 / 作者 / 视频直链），用于补充与媒体下载。
			const uri = URI.parse(url);
			const [extractRes, ogMeta] = await Promise.all([
				this._webContentExtractor.extract([uri], { followRedirects: true, trustedDomains: ['*'] }),
				this.fetchOgMeta(url),
			]);
			const ext = extractRes[0];
			if (!ext || ext.status === 'redirect') {
				throw new Error(ext?.status === 'redirect' ? `需跳转至 ${ext.toURI}` : '未能获取页面内容');
			}
			const body = ext.status === 'ok' ? ext.result : (ext.result ?? '');
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

			// 图文 / mixed：本地化正文内图片（下载到 media/ 并改写本地路径），再组装 Markdown；
			// mixed / article 额外抓封面图。
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
		} catch (err) {
			this.logService.warn(`[KB] importFromUrl failed: ${err}`);
			this.notificationService.warn(localize('kb.urlFetchFailed', '抓取失败（可能受跨域限制或需登录）：{0}', String(err)));
			void this._logOp('kb.import.url', 'failure', { source: url, error: String(err) });
		}
	}

	/** 经主进程网络层（IRequestService，绕过渲染进程 CORS）取回页面 HTML 并解析 OG 元信息。失败返回空对象。 */
	private async fetchOgMeta(url: string): Promise<IKbMetaTags> {
		try {
			const context = await this.requestService.request({
				type: 'GET',
				url,
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
			const context = await this.requestService.request({
				type: 'GET',
				url,
				followRedirects: 5,
				headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SarosisKB/1.0)', 'Referer': url },
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
		this._body.appendChild(dd);
		const btnRect = anchor.getBoundingClientRect();
		const bodyRect = this._body.getBoundingClientRect();
		dd.style.position = 'absolute';
		dd.style.right = `${bodyRect.right - btnRect.right}px`;
		dd.style.top = `${btnRect.bottom - bodyRect.top}px`;
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
			// 清空搜索：恢复分区树视图
			this._scroll.querySelectorAll('.kb-section').forEach(s => (s as HTMLElement).style.display = '');
			if (resultsEl) { resultsEl.classList.remove('show'); resultsEl.replaceChildren(); }
			if (this._backlinksEl) { this._backlinksEl.style.display = ''; }
			return;
		}
		// 隐藏分区树，展示搜索结果
		this._scroll.querySelectorAll('.kb-section').forEach(s => (s as HTMLElement).style.display = 'none');
		if (this._backlinksEl) { this._backlinksEl.style.display = 'none'; }
		if (!resultsEl) {
			resultsEl = $('div.kb-search-results');
			this._scroll.appendChild(resultsEl);
		}
		resultsEl.classList.add('show');
		void this.runSearch(q, resultsEl);
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

	/** 重建全文索引与双链图谱（扫描当前 Vault 的库 + 笔记两分区 + 关联目录）。 */
	private async rebuildSearchAssets(): Promise<void> {
		if (!this._activeVault) { return; }
		const t0 = performance.now();
		const vaultRoot = this.vaultUri(this._activeVault);
		const roots = this.buildRoots();
		try {
			const kernelCache = URI.joinPath(vaultRoot, '.kbkernel.json');
			const t1 = performance.now();
			// 内置内核一次性完成 FTS + 图谱 + 提及索引构建
			await this._nativeKernel?.build(roots, kernelCache);
			this.logService.info(`[KB perf] _nativeKernel.build: ${(performance.now() - t1).toFixed(1)}ms`);
			this._kbKernelService.setBuildContext(roots, kernelCache);
			const t2 = performance.now();
			// 同步旧索引/图谱引用（从内核内存借数据，零额外 I/O）
			this._syncFromKernel();
			this.logService.info(`[KB perf] _syncFromKernel: ${(performance.now() - t2).toFixed(1)}ms`);
		} catch (err) {
			this.logService.warn(`[KB] rebuildSearchAssets failed: ${err}`);
		}
		this._searchDirty = false;
		this.logService.info(`[KB perf] rebuildSearchAssets total: ${(performance.now() - t0).toFixed(1)}ms`);
	}

	/** 从 KbNativeKernel 同步 FTS 文档和图谱到旧引用变量（零 I/O）。 */
	private _syncFromKernel(): void {
		const docs = this._nativeKernel?.allDocs() ?? [];
		if (docs.length === 0) return;
		for (const d of docs) {
			this._index.updateDoc(d.uri, d.name, d.section as KbSection, d.mtime, d.size, d.text);
		}
		this._graph.buildFromDocs(docs as { uri: URI; name: string; section: KbSection; mtime: number; text: string }[]);
	}

	/** 标记索引 / 图谱失效，下次搜索或选中时重建。 */
	private markSearchDirty(): void {
		this._searchDirty = true;
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

	// ═══════════════════════════════════════════════════════════
	//  RAG (Phase 3) — Ask KB + Build RAG Knowledge Base
	// ═══════════════════════════════════════════════════════════

	/** Ask KB 输入区 DOM 引用 */
	private _askKbInput?: HTMLInputElement;
	private _askKbResult?: HTMLElement;

	/** 渲染 Ask KB 问答区（搜索栏与内容区之间） */
	private _renderAskKb(): void {
		const row = $('div.kb-ask-row');
		row.style.cssText = 'display:flex;gap:4px;padding:4px 8px;margin:2px 0;';

		const input = document.createElement('input');
		input.placeholder = '🧠 向知识库提问（语义检索，需先构建向量索引）';
		input.style.cssText = 'flex:1;border:1px solid var(--vscode-input-border,#3c3c3c);background:var(--vscode-input-background,#1e1e1e);color:var(--vscode-input-foreground,#ccc);padding:4px 8px;border-radius:4px;font-size:12px;';
		input.onkeydown = (e) => {
			if (e.key === 'Enter') { void this._doAskKb(input.value.trim()); }
		};
		this._askKbInput = input;

		const askBtn = document.createElement('button');
		askBtn.textContent = 'Ask';
		askBtn.title = '向 RAG 知识库提问（基于已构建的向量索引）';
		askBtn.style.cssText = 'border:none;background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,white);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap;';
		askBtn.onclick = () => { void this._doAskKb(input.value.trim()); };

		row.appendChild(input);
		row.appendChild(askBtn);
		this._body.appendChild(row);

		// 结果区
		const result = $('div.kb-ask-result');
		result.style.cssText = 'display:none;padding:4px 8px 8px;font-size:12px;line-height:1.5;color:var(--vscode-foreground,#ccc);max-height:200px;overflow-y:auto;border-bottom:1px solid var(--vscode-widget-border,#3c3c3c);';
		this._askKbResult = result;
		this._body.appendChild(result);
	}

	/** 执行 RAG 问答（语义检索式：向量索引取 top 块直接作为答案预览）。 */
	private async _doAskKb(query: string): Promise<void> {
		const resultEl = this._askKbResult;
		const inputEl = this._askKbInput;
		if (!query || !resultEl || !inputEl || !this._activeVault) { return; }

		inputEl.disabled = true;
		resultEl.style.display = 'block';
		resultEl.innerHTML = '<span style="color:var(--vscode-descriptionForeground,#888)">⏳ 语义检索中…</span>';

		try {
			const status = this._kbKernelService.getVectorStatus();
			if (!status.built || status.chunkCount === 0) {
				resultEl.innerHTML = '<span style="color:var(--vscode-errorForeground,#f48771)">❌ 向量索引尚未构建或为空。请在库分区点击 🧠 → 构建向量索引（或导入 .kbrag.json）。</span>';
				return;
			}

			const hits = await this._kbKernelService.searchVector(query, 6, resolveAuxEmbeddingProviderId(this.configurationService));
			if (!hits.length) {
				resultEl.innerHTML = '<span style="color:var(--vscode-descriptionForeground,#888)">未找到相关知识片段。</span>';
				return;
			}

			const vaultRoot = this.vaultUri(this._activeVault).fsPath;
			const parts = hits.map((h, i) => {
				const p = h.docId.replace(vaultRoot, '').replace(/\\/g, '/');
				const txt = h.text.length > 240 ? h.text.slice(0, 240) + '…' : h.text;
				return `<div style="margin:6px 0;padding:6px 8px;border-left:2px solid var(--vscode-textLink-foreground,#3794ff);background:var(--vscode-editor-background,#1e1e1e)">
					<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--vscode-descriptionForeground,#888)">
						<span>#${i + 1} · ${_escapeHtml(h.docName)}</span><span>${(h.score * 100).toFixed(0)}%</span>
					</div>
					<div style="margin-top:2px">${_escapeHtml(txt)}</div>
					<div style="font-size:10px;color:var(--vscode-descriptionForeground,#888);margin-top:2px">📄 ${_escapeHtml(p)}</div>
				</div>`;
			});
			resultEl.innerHTML = `<div style="font-weight:bold;margin-bottom:4px;color:var(--vscode-textLink-foreground,#3794ff)">🧠 语义检索到 ${hits.length} 条相关知识</div>${parts.join('')}`;
			void this._logOp('kb.ask', 'success', { detail: { query, hits: hits.length } });
		} catch (err) {
			resultEl.innerHTML = `<span style="color:var(--vscode-errorForeground,#f48771)">❌ 检索失败：${_escapeHtml(String(err?.message ?? err))}</span>`;
		} finally {
			inputEl.disabled = false;
			inputEl.value = '';
		}
	}

	/** 打开 RAG 向量索引下拉（构建 / 导入 .kbrag.json / 导出 .kbrag.json）。 */
	private openRagDropdown(anchorSection: HTMLElement, anchorBtn: HTMLElement): void {
		this._body.querySelectorAll('.kb-dropdown.show').forEach(d => d.classList.remove('show'));
		const dd = $('div.kb-dropdown');
		dd.id = 'kbRagDD';
		const items: { icon: string; label: string; sub: string; run: () => void }[] = [
			{ icon: '🧠', label: '构建向量索引', sub: '针对当前知识库切块→向量化（语义搜索）', run: () => void this._buildVectorIndex() },
			{ icon: '📥', label: '导入 .kbrag.json', sub: '载入预构建的向量库文件', run: () => void this._importKbrag() },
			{ icon: '📤', label: '导出 .kbrag.json', sub: '保存当前向量库供分享/备份', run: () => void this._exportKbrag() },
		];
		for (const it of items) {
			const opt = $('div.kb-opt');
			safeSetInnerHtml(opt, `<span class="kb-ic">${it.icon}</span><span class="kb-txt">${it.label}</span><span class="kb-sub">${it.sub}</span>`);
			opt.onclick = (e) => { e.stopPropagation(); dd.classList.remove('show'); void it.run(); };
			dd.appendChild(opt);
		}
		this.positionDropdown(dd, anchorBtn);
		dd.classList.add('show');
	}

	/** 构建向量索引（per-folder RAG）：切块 → 向量化，存于共享内核。 */
	private async _buildVectorIndex(): Promise<void> {
		if (!this._activeVault) {
			this.notificationService.warn('请先选择一个知识库');
			return;
		}
		if (!this._ragEmbeddingService.getActiveTag()) {
			this.notificationService.warn('Embedding 服务未启用。请在设置中配置模型 Provider（OpenRouter / 自定义 API）。');
			return;
		}
		const vault = this._activeVault;
		this.notificationService.info(`🧠 开始构建「${vault.name}」向量索引（切块 → 向量化）…`);
		try {
			if (this._searchDirty) { await this.rebuildSearchAssets(); }
			const roots = this.buildRoots();
			if (roots.length === 0) {
				this.notificationService.warn('没有可索引的目录。');
				return;
			}
			await this._kbKernelService.buildVectorIndex(roots);
			const st = this._kbKernelService.getVectorStatus();
			this.notificationService.info(`✅ 向量索引构建完成：${st.chunkCount} 个块（维度 ${st.dimensions}）。现在搜索与 Ask 可用语义检索。`);
			void this._logOp('kb.vector.build', 'success', { detail: { vault: vault.id, chunks: st.chunkCount } });
		} catch (err) {
			this.notificationService.error(`❌ 向量索引构建失败：${String(err?.message ?? err)}`);
			void this._logOp('kb.vector.build', 'failure', { detail: { vault: vault.id }, error: String(err) });
		}
	}

	/** 从磁盘导入预构建的 .kbrag.json 向量库。 */
	private async _importKbrag(): Promise<void> {
		if (!this._activeVault) { return; }
		const picked = await this.fileDialogService.showOpenDialog({
			title: '导入 .kbrag.json 向量库',
			canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
			filters: [{ name: 'KB RAG Index', extensions: ['kbrag.json', 'json'] }],
		});
		if (!picked || !picked.length) { return; }
		try {
			const ok = await this._kbKernelService.importVectorFromFile(picked[0]);
			if (ok) {
				const st = this._kbKernelService.getVectorStatus();
				this.notificationService.info(`✅ 已导入向量库：${st.chunkCount} 个块（维度 ${st.dimensions}）。${st.tag ? 'tag: ' + st.tag : ''}`);
				void this._logOp('kb.vector.import', 'success', { source: picked[0].fsPath, detail: { chunks: st.chunkCount } });
			} else {
				this.notificationService.warn('导入失败：文件无效，或缺少激活的 Embedding provider 无法重新向量化。');
				void this._logOp('kb.vector.import', 'failure', { source: picked[0].fsPath });
			}
		} catch (err) {
			this.notificationService.error(`❌ 导入失败：${String(err?.message ?? err)}`);
		}
	}

	/** 导出当前向量库为 .kbrag.json。 */
	private async _exportKbrag(): Promise<void> {
		if (!this._activeVault) { return; }
		const st = this._kbKernelService.getVectorStatus();
		if (!st.built || st.chunkCount === 0) {
			this.notificationService.warn('向量索引为空，请先构建或导入。');
			return;
		}
		const defaultUri = URI.joinPath(this.vaultUri(this._activeVault), KB_RAG_INDEX_FILE);
		const saveUri = await this.fileDialogService.showSaveDialog({
			title: '导出 .kbrag.json 向量库',
			defaultUri,
			filters: [{ name: 'KB RAG Index', extensions: ['kbrag.json', 'json'] }],
		});
		if (!saveUri) { return; }
		try {
			await this._kbKernelService.exportVectorToFile(saveUri);
			this.notificationService.info(`✅ 已导出向量库到：${saveUri.fsPath}`);
			void this._logOp('kb.vector.export', 'success', { target: saveUri.fsPath });
		} catch (err) {
			this.notificationService.error(`❌ 导出失败：${String(err?.message ?? err)}`);
		}
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
		// 携带知识库分区根目录（含关联目录），供「关系图谱」EditorPane 内的「构建图谱」按钮重新扫描
		const roots = this.buildRoots();
		const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
		const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
		this.editorService.openEditor(
			new KbGraphEditorInput(nodes, links, '关系图谱', roots),
			{ pinned: true },
			targetGroup,
		);
	}

	// -- Kernel-enhanced search / backlinks (Tier 3) --

	/** 搜索文件：内置内核（BM25，始终可用）。 */
	private async _searchFilesKernel(q: string): Promise<IKbSearchHit[]> {
		return this._searchFilesLocal(q);
	}

	private async _searchFilesLocal(q: string): Promise<IKbSearchHit[]> {
		if (!this._activeVault) { return []; }
		if (this._searchDirty) { await this.rebuildSearchAssets(); }
		return this._index.search(q);
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

	override dispose(): void {
		document.removeEventListener('click', this._onGlobalClick);
		super.dispose();
	}
}
