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
 *   - 库：导入数据源（Obsidian / 文件 / 文件夹 / 飞书·小红书·B站·抖音·知乎 URL）
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
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { $ } from '../../../../../base/browser/dom.js';
import { safeSetInnerHtml } from '../../../../../base/browser/domSanitize.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { localize } from '../../../../../nls.js';

import {
	IKbVault, IKbNode, KbSection, KB_SECTION_LABEL,
	KbSortMode, KB_SORT_GROUPS, KB_IMPORT_ITEMS, KbImportKind, newVaultId,
} from './knowledgeBase/kbTypes.js';
import { KbFullTextIndex, IKbSearchHit } from './knowledgeBase/kbIndex.js';
import { KbLinkGraph } from './knowledgeBase/kbGraph.js';
import { injectLuteScript } from './knowledgeBase/kbLute.js';
import { KbKernelClient, IKernelSearchBlock, IKernelBacklink2Result } from './knowledgeBase/kbKernelApi.js';
import { KbNativeKernel, INativeBacklinkResult } from './knowledgeBase/kbNativeKernel.js';
import { KbNoteEditorInput } from '../kbNoteEditorInput.js';
import { KbGraphEditorInput } from '../kbGraphEditorInput.js';

const KB_ROOT_SUBPATH = '.saros/knowledge-base';
const STORAGE_VAULTS = 'agentStudio.kb.vaults';
const STORAGE_ACTIVE = 'agentStudio.kb.active';
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

	/** 全文倒排索引（替代遍历式搜索，对齐 FTS5 语义） */
	private _index: KbFullTextIndex;

	/** 双链图谱（[[...]] 反链映射） */
	private _graph: KbLinkGraph;

	/** 索引 / 图谱失效标记：文件变更后置位，下次搜索/选中时重建 */
	private _searchDirty = true;

	/** 反链面板容器 */
	private _backlinksEl?: HTMLElement;

	/** SiYuan Kernel 客户端（可选，kernel 运行时自动激活） */
	private _kernelClient: KbKernelClient | undefined;

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
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._index = new KbFullTextIndex(this.fileService);
		this._graph = new KbLinkGraph(this.fileService);
		this._nativeKernel = new KbNativeKernel(this.fileService);
	}

	// ═══════════════════════════════════════════════════════════
	//  Paths
	// ═══════════════════════════════════════════════════════════

	private get rootUri(): URI {
		return URI.joinPath((this.environmentService as INativeEnvironmentService).userHome, ...KB_ROOT_SUBPATH.split('/'));
	}

	private vaultUri(v: IKbVault): URI {
		return URI.joinPath(this.rootUri, v.id);
	}

	private sectionUri(v: IKbVault, section: KbSection): URI {
		const folder: SectionFolderName = section === 'library' ? '库' : '笔记';
		return URI.joinPath(this.vaultUri(v), folder);
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
		settingsBtn.textContent = '⚙'; settingsBtn.title = '打开知识库所在文件夹';
		settingsBtn.onclick = () => this.openKbFolder();
		header.appendChild(settingsBtn);
		this._body.appendChild(header);

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

		// Scroll area
		this._scroll = $('div.kb-scroll');
		this._body.appendChild(this._scroll);

		// Global click closes popups
		document.addEventListener('click', this._onGlobalClick);

		// 注入 SiYuan Lute 引擎并初始化（vendored lute.min.js）
		this._initLute();

		// initVaults 为异步链，失败会被吞掉导致整块空白；显式 catch 以暴露真实错误
		void this.initVaults().catch((err) => {
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

	private async ensureVaultFolders(v: IKbVault): Promise<void> {
		// best-effort：建文件夹失败不应阻断渲染（listChildren 会在用到时按需再建）
		try {
			await this.fileService.createFolder(this.vaultUri(v));
			await this.fileService.createFolder(this.sectionUri(v, 'library'));
			await this.fileService.createFolder(this.sectionUri(v, 'notes'));
		} catch (err) {
			this.logService.warn(`[KB] ensureVaultFolders failed (will retry on demand): ${err}`);
		}
	}

	private async activateVault(v: IKbVault): Promise<void> {
		this._activeVault = v;
		this.storageService.store(STORAGE_ACTIVE, v.id, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._searchDirty = true;
		this._sortMode = this.loadSort(v.id);
		this._expandedFolders = new Set();
		this._libraryOpen = this.loadSectionOpen('library');
		this._notesOpen = this.loadSectionOpen('notes');
		await this.ensureVaultFolders(v);
		this.renderAll();
	}

	private async createVault(name: string, icon = '📚'): Promise<void> {
		const vault: IKbVault = {
			id: newVaultId(),
			name,
			icon,
			sort: this._vaults.length,
			sortMode: 'createdASC',
			closed: false,
			path: URI.joinPath(this.rootUri, newVaultId()).fsPath,
		};
		vault.path = URI.joinPath(this.rootUri, vault.id).fsPath;
		this._vaults.push(vault);
		this.saveVaults();
		await this.ensureVaultFolders(vault);
		await this.activateVault(vault);
		this.notificationService.info(localize('kb.vaultCreated', '已创建知识库：{0}', name));
	}

	private async removeVault(v: IKbVault): Promise<void> {
		const confirm = await this.dialogService.confirm({
			message: localize('kb.removeVault', '确定删除知识库「{0}」及其全部内容？', v.name),
			primaryButton: localize('kb.delete', '删除'),
		});
		if (!confirm.confirmed) { return; }
		await this.fileService.del(this.vaultUri(v), { recursive: true });
		this._vaults = this._vaults.filter(x => x.id !== v.id);
		this.saveVaults();
		this._activeVault = this._vaults.find(x => !x.closed);
		if (this._activeVault) {
			await this.activateVault(this._activeVault);
		} else {
			this._scroll.replaceChildren();
			this.renderVaultBar();
		}
	}

	private async renameVault(v: IKbVault, newName: string): Promise<void> {
		v.name = newName;
		this.saveVaults();
		this.renderVaultBar();
	}

	// ═══════════════════════════════════════════════════════════
	//  Full render
	// ═══════════════════════════════════════════════════════════

	private renderAll(): void {
		// 重建前清除搜索态，避免结果元素被清空但搜索框仍残留文字
		if (this._searchInput) { this._searchInput.value = ''; }
		this._searchToken++; // 使进行中的搜索结果失效
		this.renderVaultBar();
		this._scroll.replaceChildren();
		this._scroll.appendChild(this.renderSection('library'));
		this._scroll.appendChild(this.renderSection('notes'));
		this.renderBacklinksPanel();
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
			sortMode: 'createdASC', closed: false, path: folder.fsPath,
		};
		this._vaults.push(vault);
		this.saveVaults();
		// 使用外部文件夹：在其下创建 库/笔记 子目录
		await this.ensureVaultFolders(vault);
		await this.activateVault(vault);
		this.notificationService.info(localize('kb.folderConfigured', '已配置文件夹为知识库：{0}', name));
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
			const importBtn = $('span.kb-sec-btn.primary'); importBtn.textContent = '📥'; importBtn.title = '导入数据源';
			importBtn.onclick = (e) => { e.stopPropagation(); this.openImportDropdown(sectionEl, importBtn); };
			toolbar.appendChild(importBtn);
		} else {
			const newFile = $('span.kb-sec-btn'); newFile.textContent = '✏️'; newFile.title = '新建文件';
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
			countEl.textContent = String(this.countNodes(section, nodes));
			// 恢复已展开文件夹（一级）
			for (const node of nodes) {
				if (node.isDirectory && this._expandedFolders.has(node.path)) {
					const el = body.querySelector(`.kb-node[data-path="${this.cssEscape(node.path)}"]`);
					if (el) { void this.expandFolder(el as HTMLElement, node); }
				}
			}
		} catch (err) {
			this.logService.warn(`[KB] loadSectionTree failed: ${err}`);
			body.replaceChildren();
			const empty = $('div.kb-empty-inline'); empty.textContent = '加载失败'; body.appendChild(empty);
		}
	}

	private countNodes(_section: KbSection, nodes: IKbNode[]): number {
		// 仅统计顶层数量；如有需要可递归
		return nodes.length;
	}

	private async listChildren(uri: URI, section: KbSection): Promise<IKbNode[]> {
		let stat;
		try {
			stat = await this.fileService.resolve(uri);
		} catch {
			await this.fileService.createFolder(uri);
			stat = await this.fileService.resolve(uri);
		}
		if (!stat.children) { return []; }
		const nodes: IKbNode[] = stat.children.map(c => this.toKbNode(c, section));
		return this.sortNodes(nodes);
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
		const newBtn = $('span.kb-act'); newBtn.textContent = '✏️'; newBtn.title = '新建文件';
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
		await this.refreshSection(section);
		// 立即进入重命名
		const el = this.findNodeEl(section, uri.fsPath);
		if (el) { this.selectNode(el); const node = this.nodeFromEl(el); if (node) { this.startRename(el, node); } }
	}

	private async newFolder(section: KbSection, parent?: IKbNode): Promise<void> {
		const dir = this.targetDir(section, parent);
		const uri = await this.uniqueName(dir, '未命名文件夹');
		await this.fileService.createFolder(uri);
		await this.refreshSection(section);
		const el = this.findNodeEl(section, uri.fsPath);
		if (el) { this.selectNode(el); const node = this.nodeFromEl(el); if (node) { this.startRename(el, node); } }
	}

	private async deleteNode(node: IKbNode): Promise<void> {
		const confirm = await this.dialogService.confirm({
			message: localize('kb.deleteNode', '确定删除「{0}」？', node.name),
			primaryButton: localize('kb.delete', '删除'),
		});
		if (!confirm.confirmed) { return; }
		await this.fileService.del(node.uri, { recursive: true });
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
					await this.refreshSection(node.section);
				} catch (err) {
					this.notificationService.warn(String(err));
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
	//  Import
	// ═══════════════════════════════════════════════════════════

	private openImportDropdown(anchorSection: HTMLElement, anchorBtn: HTMLElement): void {
		// 移除已有
		this._body.querySelectorAll('.kb-dropdown.show').forEach(d => d.classList.remove('show'));
		const dd = $('div.kb-dropdown');
		dd.id = 'kbImportDD';
		for (const item of KB_IMPORT_ITEMS) {
			if (item.kind === 'feishu') {
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

		// URL 类：利用渲染进程的 fetch + DOMParser 直接抓取并按 Markdown 落盘（对齐 SiYuan 网页剪藏）。
		// 受限站点（跨域 / 需登录）会清晰报错，引导用户改用「导入文件」。
		const urlKinds: KbImportKind[] = ['feishu', 'xiaohongshu', 'bilibili', 'douyin', 'zhihu'];
		if (urlKinds.includes(kind)) {
		const r = await this.dialogService.input({
			message: localize('kb.enterUrl', '粘贴「{0}」的内容链接', kind),
			inputs: [{ value: '', placeholder: 'https://...' }],
		});
		const url = r.values?.[0]?.trim();
		if (r.confirmed && url) {
			await this.importFromUrl(kind, url, target);
		}
			return;
		}

		if (kind === 'folder') {
			const picked = await this.fileDialogService.showOpenDialog({ title: '导入文件夹', canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
			if (picked?.length) { await this.copyRecursive(picked[0], URI.joinPath(target, this.baseName(picked[0]))); }
		} else if (kind === 'files') {
			const picked = await this.fileDialogService.showOpenDialog({ title: '导入文件', canSelectFiles: true, canSelectFolders: false, canSelectMany: true });
			if (picked?.length) { for (const f of picked) { await this.copyRecursive(f, URI.joinPath(target, this.baseName(f))); } }
		} else if (kind === 'obsidian') {
			const picked = await this.fileDialogService.showOpenDialog({ title: '导入 Obsidian 库', canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
			if (picked?.length) {
				// Obsidian：保留 .md 与 [[双链]]，作为普通 Markdown 复制（双链后续可映射为反链）
				await this.copyRecursive(picked[0], URI.joinPath(target, this.baseName(picked[0])));
				this.notificationService.info(localize('kb.obsidianImported', '已导入 Obsidian 库（Markdown + 双链保留），放入「库」待索引。'));
			}
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

	private async importFromUrl(kind: KbImportKind, url: string, target: URI): Promise<void> {
		this.notificationService.info(localize('kb.urlFetching', '正在抓取 {0} …', url));
		try {
			const md = await this.fetchUrlAsMarkdown(url);
			const name = this.slugFromUrl(url, kind);
			const fileUri = await this.uniqueName(target, name, '.md');
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(md));
			await this.refreshSection('library');
			this.notificationService.info(localize('kb.urlImported', '已导入：{0}', fileUri.path.split('/').pop()));
		} catch (err) {
			this.logService.warn(`[KB] importFromUrl failed: ${err}`);
			this.notificationService.warn(localize('kb.urlFetchFailed', '抓取失败（可能受跨域限制或需登录）：{0}', String(err)));
		}
	}

	/** 经主进程网络层发起请求（IRequestService，绕过渲染进程 CORS），HTML 走轻量抽取，纯文本原样保存。 */
	private async fetchUrlAsMarkdown(url: string): Promise<string> {
		const context = await this.requestService.request({
			type: 'GET',
			url,
			followRedirects: 5,
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SarosisKB/1.0)' },
			callSite: 'saros.knowledgeBase.urlImport',
		}, CancellationToken.None);
		const status = context.res.statusCode;
		if (!status || status < 200 || status >= 300) { throw new Error(`HTTP ${status ?? 'unknown'}`); }
		const raw = (await asText(context)) ?? '';
		const ct = (context.res.headers['content-type'] as string | undefined) ?? '';
		if (ct.includes('html')) { return this.htmlToMarkdown(raw, url); }
		return raw;
	}

	private htmlToMarkdown(html: string, url: string): string {
		// 标题：正则提取（DOMParser.parseFromString 受本 fork Trusted Types 策略拦截，故走正则）
		const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
		const title = (titleMatch ? titleMatch[1] : '').replace(/\s+/g, ' ').trim() || url;
		// 正文：经白名单 dompurify policy 解析（safeSetInnerHtml），绕过 TrustedHTML 约束
		const div = document.createElement('div');
		safeSetInnerHtml(div, html);
		div.querySelectorAll('script,style,noscript,svg,head,nav,footer,iframe').forEach(n => n.remove());
		const text = div.textContent ?? '';
		const clean = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
		return `# ${title}\n\n> 来源：${url}\n\n${clean}\n`;
	}

	private slugFromUrl(url: string, kind: KbImportKind): string {
		try {
			const u = new URL(url);
			const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
			const clean = last.replace(/[\\/:*?"<>|#.]/g, '_').slice(0, 60);
			return clean || kind;
		} catch {
			return kind;
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
			return;
		}
		for (const m of matches) { resultsEl.appendChild(this.renderSearchHit(m, q)); }
	}

	/** 全文检索（Tier 3：kernel 优先，回退本地索引）。 */
	private async searchFiles(q: string): Promise<IKbSearchHit[]> {
		if (!this._activeVault) { return []; }
		return this._searchFilesKernel(q);
	}

	/** 重建全文索引与双链图谱（扫描当前 Vault 的库 + 笔记两分区）。 */
	private async rebuildSearchAssets(): Promise<void> {
		if (!this._activeVault) { return; }
		const roots = (['library', 'notes'] as KbSection[]).map(s => ({ uri: this.sectionUri(this._activeVault!, s), section: s }));
		try {
			// 内置内核（主后端，含提及索引）
			await this._nativeKernel?.build(roots);
			// 兼容：同时构建旧索引/图谱（部分代码仍直接引用）
			await this._index.build(roots);
			await this._graph.build(roots);
		} catch (err) {
			this.logService.warn(`[KB] rebuildSearchAssets failed: ${err}`);
		}
		this._searchDirty = false;
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
		const kernelBadge = this._ensureKernelClient()?.isAvailable ? ' 🔌' : ' 📦';
		header.textContent = `🔗 双链${kernelBadge}`;
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
	//  Tier 3 — Lute 块级渲染 + Kernel API 集成
	// ═══════════════════════════════════════════════════════════

	/** 注入 SiYuan Lute 引擎脚本（vendored 自 local SiYuan 源）。 */
	private async _initLute(): Promise<void> {
		try {
			// 必须用 FileAccess.asBrowserUri 得到 Electron CSP 允许的 vscode-file:// 绝对路径；
			// 不能用 './media/...' 相对路径（在 Workbench ViewPane 中相对 workbench 页面解析，脚本永远加载不到）。
			const luteUrl = (window as unknown as Record<string, string | undefined>)['luteUrl']
				?? FileAccess.asBrowserUri('vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/media/lute/lute.min.js').toString();
			await injectLuteScript(luteUrl);
		} catch (err) {
			this.logService.warn(`[KB] initLute failed: ${err}`);
		}
	}

	/** 懒初始化 SiYuan Kernel 客户端（尝试连接本地 kernel 6768 默认端口）。 */
	private _ensureKernelClient(): KbKernelClient | undefined {
		if (this._kernelClient) { return this._kernelClient; }
		try {
			this._kernelClient = new KbKernelClient('http://127.0.0.1:6806');
			return this._kernelClient;
		} catch {
			return undefined;
		}
	}

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
		const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
		const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
		this.editorService.openEditor(
			new KbGraphEditorInput(nodes, links, '关系图谱'),
			{ pinned: true },
			targetGroup,
		);
	}

	// -- Kernel-enhanced search / backlinks (Tier 3) --

	/** 搜索文件：内置内核（始终可用）优先，外部 kernel 为可选增强。 */
	private async _searchFilesKernel(q: string): Promise<IKbSearchHit[]> {
		// 1. 尝试外部 SiYuan kernel（FTS5，质量更高）
		const kernel = this._ensureKernelClient();
		if (kernel) {
			try {
				const healthy = await kernel.healthCheck();
				if (healthy) {
					const result = await kernel.fullTextSearchBlock(q);
					return this._mapKernelSearchToHits(result.blocks ?? []);
				}
			} catch { /* fall through to native */ }
		}

		// 2. 回退到 vssaros 内置内核（BM25 + Lute 增强，始终可用）
		return this._searchFilesLocal(q);
	}

	private async _searchFilesLocal(q: string): Promise<IKbSearchHit[]> {
		if (!this._activeVault) { return []; }
		if (this._searchDirty) { await this.rebuildSearchAssets(); }
		return this._index.search(q);
	}

	/** 将 kernel 搜索结果映射为本地 IKbSearchHit 类型。 */
	private _mapKernelSearchToHits(blocks: IKernelSearchBlock[]): IKbSearchHit[] {
		return blocks.map(b => ({
			uri: URI.file(b.path ?? b.hPath ?? ''),
			name: b.path?.split('/').pop() ?? b.hPath?.split('/').pop() ?? '未知',
			path: b.path ?? b.hPath ?? '',
			section: 'notes' as KbSection,
			size: 0,
			mtime: 0,
			ctime: 0,
			childCount: 0,
			isDirectory: false,
			matchedBy: 'name' as const,
			score: 0,
			snippet: b.content?.slice(0, 200) ?? '',
		}));
	}

	/**
	 * 获取反链 + 提及：内置内核（始终可用，含提及）优先，外部 kernel 为可选增强。
	 * 返回结构扩展 mentions 字段（对齐 SiYuan 反链面板的「反链 / 提及」双列表）。
	 */
	private async _getBacklinksKernel(node: IKbNode): Promise<{
		outgoing: { label: string; targetName: string; targetUri?: URI }[];
		back: { uri: URI; name: string; snippet: string; type?: 'ref' | 'mention' }[];
		mentions: { uri: URI; name: string; snippet: string }[];
	}> {
		// 1. 尝试外部 SiYuan kernel
		const kernel = this._ensureKernelClient();
		if (kernel) {
			try {
				const healthy = await kernel.healthCheck();
				if (healthy) {
					const blockId = node.uri.toString();
					const result: IKernelBacklink2Result = await kernel.getBacklink2(blockId);
					return {
						outgoing: [],
						back: (result.backlinks ?? []).map(b => ({
							uri: URI.file(b.path ?? b.hPath ?? ''),
							name: b.hPath?.split('/').pop() ?? '未知',
							snippet: b.content?.slice(0, 100) ?? '',
							type: 'ref' as const,
						})),
						mentions: (result.backmentions ?? []).map(b => ({
							uri: URI.file(b.path ?? b.hPath ?? ''),
							name: b.hPath?.split('/').pop() ?? '未知',
							snippet: b.content?.slice(0, 100) ?? '',
						})),
					};
				}
			} catch { /* fall through to native */ }
		}

		// 2. vssaros 内置内核（含提及，移植 backlink.go buildTreeBackmention）
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

		// 3. 最终回退：旧版本地图谱（无提及）
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
		this._kernelClient = undefined;
		document.removeEventListener('click', this._onGlobalClick);
		super.dispose();
	}
}
