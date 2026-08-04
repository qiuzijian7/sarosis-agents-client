/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import { IAgentStudioService } from '../../common/agentStudio.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { applySavedOrder, CardDragSorter, CardOrderStore, CardPinStore, showCardContextMenu } from './cardItemBehaviors.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { $ } from '../../../../../base/browser/dom.js';
import { IEditorService, SIDE_GROUP } from '../../../../../workbench/services/editor/common/editorService.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { AgentSettingsEditorInput } from '../agentSettingsEditorInput.js';
import { AgentCreateEditorInput } from '../agentCreateEditorInput.js';
import type { Agent } from '../../../../common/agentStudioTypes.js';
import type { IAgentFolderUploadFile } from '../../../../common/agentStudioService.js';
import { IMarketplaceService, IMarketplacePackage, PackageKind } from '../../common/marketplace.js';
import { IAgentVersionService } from '../../common/agentVersionTypes.js';
import { bumpPatch, suggestNextVersion, validatePublishVersion, isVersionConflictError } from '../publishVersioning.js';
import { filterUserFacingAgents } from '../../common/builtinAgents.js';

// ─── Preset Data Model ────────────────────────────────────────────────────────

export type PresetCategory = 'Development' | 'Research' | 'Creative' | 'Management' | 'DevOps' | 'Analytics';

export const PRESET_CATEGORIES: { id: PresetCategory | 'All'; label: string }[] = [
	{ id: 'All', label: 'All' },
	{ id: 'Development', label: 'Dev' },
	{ id: 'Research', label: 'Research' },
	{ id: 'Creative', label: 'Creative' },
	{ id: 'Management', label: 'Mgmt' },
	{ id: 'DevOps', label: 'DevOps' },
	{ id: 'Analytics', label: 'Data' },
];

// ─── View Pane ────────────────────────────────────────────────────────────────

/**
 * Preset Agent View - 预设Agent模板管理
 * 功能：
 *  - 浏览内置/自定义预设模板（分类筛选 + 搜索）
 *  - 查看预设详情（展开/折叠）
 *  - 一键 Deploy 预设为 Agent
 *  - 创建自定义预设（内联表单）
 *  - 删除自定义预设
 */
export class PresetAgentViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private searchInput!: HTMLInputElement;
	/** 唯一数据源：来自 AgentStudioService.getAgents()（读取 ~/.vssaros/agents/{id}/.agent.md）。 */
	private agents: Agent[] = [];
	private activeCategory: PresetCategory | 'All' = 'All';
	private isDeploying = false;

	// ── Marketplace data (for version comparison: upgrade/delete buttons) ──
	/** Server-side agent packages keyed by slug (e.g. "agent-coder" → package) */
	private _marketPackages = new Map<string, IMarketplacePackage>();
	/** Installed agent packages keyed by storeId (= slug), value = local version */
	private _installedVersions = new Map<string, string>();
	/** Self-published agent packages keyed by storeId, value = published version（本机发布的记录，区别于商城安装） */
	private _publishedVersions = new Map<string, string>();
	/** Upgrading preset IDs (to show spinner / disable button) */
	private _upgradingIds = new Set<string>();
	/** Deleting preset IDs */
	private _deletingIds = new Set<string>();

	/** 排序 + 置顶持久化 + 拖拽排序（共享实现） */
	private _orderStore!: CardOrderStore;
	private _pinStore!: CardPinStore;
	private _dragSorter!: CardDragSorter;

	/**
	 * @deprecated Unused field — tracked via workspace change event but never read.
	 * Kept for documenting the workspace tracking intent.
	 */

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
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@IAgentVersionService private readonly agentVersionService: IAgentVersionService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._listenActiveWorkspace();
		// 从服务读取 agent（唯一数据源：~/.vssaros/agents/{id}/.agent.md）
		this._loadAgents();
		// Listen for agent changes (create/update/delete) and refresh the list
		this._register(this.agentStudioService.onDidChangeAgents(() => {
			this._loadAgents();
		}));
		// 商城安装/发布/卸载记录变化（如从 agent editorpane 上传成功）→ 重拉商城数据刷新 item 状态
		this._register(this.marketplaceService.onDidChangeInstalled(() => {
			this._loadMarketplaceData().catch(err =>
				console.warn('[PresetAgentView] Failed to reload marketplace data:', err),
			);
		}));
		// Load marketplace data for version comparison (upgrade/delete buttons)
		this._loadMarketplaceData().catch(err =>
			console.warn('[PresetAgentView] Failed to load marketplace data:', err),
		);

		// 拖拽排序 + 置顶 + 持久化（与 skill / workflow 视图共用实现）
		this._orderStore = new CardOrderStore(this.storageService, 'agentStudio.presetOrder.v1');
		this._pinStore = new CardPinStore(this.storageService, 'agentStudio.presetPinned.v1');
		this._dragSorter = new CardDragSorter({
			getContainer: () => this.listContainer,
			getVisibleIds: () => this._getFilteredPresets().map(p => p.id),
			onReorder: (ids) => { this._orderStore.save(ids); this._renderPresets(); },
		});
	}

	/**
	 * Listen for the global `agent-studio:active-workspace-changed` event
	 * fired by AgentStudioWorkspaceToolbar so we always know which workspace
	 * is selected in the Canvas.
	 */
	private _listenActiveWorkspace(): void {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.workspaceId) {
				// _activeWorkspaceId removed — workspace tracking handled by AgentInstanceService
			}
		};
		document.addEventListener('agent-studio:active-workspace-changed', handler);
		this._register({ dispose: () => document.removeEventListener('agent-studio:active-workspace-changed', handler) });

		// Also try to initialise from existing workspaces so that deploy
		// works even before the user manually switches workspace.
		this._initActiveWorkspaceId();
	}

	/**
	 * Eagerly resolve the active workspace ID by matching the current VS Code
	 * folder against known workspaces. If only one workspace exists we use it
	 * unconditionally.
	 */
	private async _initActiveWorkspaceId(): Promise<void> {
		try {
			const workspaces = await this.agentStudioService.getWorkspaces();
			if (workspaces.length === 0) { return; }

			// If there's exactly one workspace, just use it
			if (workspaces.length === 1) {
				// _activeWorkspaceId removed — workspace tracking handled by AgentInstanceService
				return;
			}

			// Otherwise try path-matching
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) { return; }
			const folderPath = folders[0].uri.fsPath;
			const match = workspaces.find(ws =>
				ws.path && ws.path.toLowerCase() === folderPath.toLowerCase()
			);
			if (match) {
				// _activeWorkspaceId removed — workspace tracking handled by AgentInstanceService
			}
	} catch {
		// best-effort
		}
	}

	/**
	 * 从 AgentStudioService 读取所有 agent（唯一数据源：
	 * ~/.vssaros/agents/{id}/.agent.md），刷新卡片列表与计数。
	 */
	private async _loadAgents(): Promise<void> {
		try {
			const agents = await this.agentStudioService.getAgents();
			// 仅对外展示白名单内置 agent + 自定义 agent；其余内置 agent 仅内部使用
			this.agents = filterUserFacingAgents(agents);
			this._renderPresets();
			this._updateCount();
		} catch (err) {
			console.warn('[PresetAgentView] Failed to load agents:', err);
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('preset-agent-view');

		// Diagnostic: confirm renderBody is called
		const diag = document.createElement('div');
		diag.style.cssText = 'padding:8px 12px;color:#e74c3c;font-size:12px;background:#2d2d2d;border-bottom:1px solid #444;';
		diag.textContent = '⏳ Loading presets…';
		container.appendChild(diag);

		try {
			this._doRenderBody(container);
		} catch (err) {
			diag.textContent = `❌ Render error: ${err instanceof Error ? err.message : String(err)}`;
			diag.style.color = '#ff6b6b';
			console.error('[PresetAgentView] renderBody error:', err);
			return;
		}
		diag.remove();
	}

	private _doRenderBody(container: HTMLElement): void {
		// ── Header ───────────────────────────────────────────────────────────
		const header = $('div.preset-header');

		const titleRow = $('div.preset-title-row');
		const title = $('h3.preset-title');
		title.textContent = '🤖 Agent Presets';
		titleRow.appendChild(title);

		const countBadge = $('span.preset-count');
		const totalPresets = this.agents.length;
		countBadge.textContent = `${totalPresets} presets`;
		titleRow.appendChild(countBadge);
		header.appendChild(titleRow);

		const actions = $('div.preset-header-actions');

		const createBtn = $('button.preset-create-btn');
		createBtn.textContent = '✏ 创建';
		createBtn.title = '创建自定义 Agent';
		createBtn.onclick = () => this._openCreateAgentPane();
		actions.appendChild(createBtn);

		// Install 下拉菜单：从商城 / 从文件夹
		actions.style.position = 'relative';
		const installBtn = $('button.preset-install-btn');
		installBtn.textContent = '⬇ Install ▾';
		installBtn.title = '安装 Agent：从商城 / 从文件夹';
		installBtn.onclick = (e) => {
			e.stopPropagation();
			this._toggleInstallDropdown(actions);
		};
		actions.appendChild(installBtn);

		header.appendChild(actions);

		container.appendChild(header);

		// ── Search ───────────────────────────────────────────────────────────
		const searchBox = $('div.preset-search-box');
		const searchIcon = $('span.preset-search-icon');
		searchIcon.textContent = '🔍';
		searchBox.appendChild(searchIcon);

		this.searchInput = document.createElement('input');
		this.searchInput.type = 'text';
		this.searchInput.className = 'preset-search-input';
		this.searchInput.placeholder = 'Search presets...';
		this.searchInput.oninput = () => this._renderPresets();
		searchBox.appendChild(this.searchInput);
		container.appendChild(searchBox);

		// ── Category Filters ───────────────────────────────────────────────
		const filterRow = $('div.preset-category-filters');
		for (const cat of PRESET_CATEGORIES) {
			const btn = $('button.preset-cat-btn');
			btn.textContent = cat.label;
			if (cat.id === 'All') { btn.classList.add('active'); }
			btn.onclick = () => {
				filterRow.querySelectorAll('.preset-cat-btn').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				this.activeCategory = cat.id as PresetCategory | 'All';
				this._renderPresets();
			};
			filterRow.appendChild(btn);
		}
		container.appendChild(filterRow);

		// ── Preset List ──────────────────────────────────────────────────────
		this.listContainer = $('div.preset-grid');
		this._renderPresets();
		container.appendChild(this.listContainer);
	}

	// ── Install Dropdown (marketplace / folder) ─────────────────────────────

	/** 「⬇ Install」下拉菜单：从商城安装 / 从文件夹安装 */
	private _toggleInstallDropdown(anchor: HTMLElement): void {
		// 已展开则关闭（toggle 语义）
		const existing = anchor.querySelector('.preset-install-dropdown');
		if (existing) {
			existing.remove();
			return;
		}

		const menu = $('div.preset-install-dropdown');
		menu.style.position = 'absolute';
		menu.style.top = '100%';
		menu.style.right = '0';
		menu.style.zIndex = '1000';
		menu.style.minWidth = '180px';
		menu.style.background = 'var(--vscode-editor-background)';
		menu.style.border = '1px solid var(--vscode-panel-border)';
		menu.style.borderRadius = '6px';
		menu.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)';
		menu.style.padding = '4px';
		menu.style.marginTop = '4px';

		const close = () => {
			menu.remove();
			document.removeEventListener('click', onOutside, true);
		};
		const onOutside = (e: MouseEvent) => {
			if (!menu.contains(e.target as Node)) { close(); }
		};

		const addItem = (label: string, desc: string, onClick: () => void) => {
			const item = $('div');
			item.style.padding = '6px 10px';
			item.style.borderRadius = '4px';
			item.style.cursor = 'pointer';
			const title = $('div');
			title.textContent = label;
			title.style.fontSize = '12px';
			title.style.color = 'var(--vscode-foreground)';
			item.appendChild(title);
			const d = $('div');
			d.textContent = desc;
			d.style.fontSize = '11px';
			d.style.color = 'var(--vscode-descriptionForeground)';
			d.style.marginTop = '2px';
			item.appendChild(d);
			item.onmouseenter = () => { item.style.background = 'var(--vscode-list-hoverBackground)'; };
			item.onmouseleave = () => { item.style.background = ''; };
			item.onclick = (e) => { e.stopPropagation(); close(); onClick(); };
			menu.appendChild(item);
		};

		addItem('\u{1F6D2} 从商城安装', '浏览 Agent Marketplace', () => {
			void this.commandService.executeCommand('agentStudio.openMarket');
		});
		addItem('\u{1F5C2} 从文件夹安装', '选择本地 Agent 文件夹（含 .agent.md）', () => this._pickAndInstallAgentFolder());

		anchor.appendChild(menu);
		// 延迟注册外部点击关闭，避免本次点击立即触发
		setTimeout(() => document.addEventListener('click', onOutside, true), 0);
	}

	/** 用 Chromium 原生 webkitdirectory 选择 agent 文件夹并安装（沙箱安全） */
	private _pickAndInstallAgentFolder(): void {
		const input = $('input') as HTMLInputElement;
		input.type = 'file';
		input.style.display = 'none';
		input.setAttribute('webkitdirectory', '');
		input.onchange = async () => {
			const fileList = input.files;
			input.remove();
			if (!fileList || fileList.length === 0) { return; }
			const files: IAgentFolderUploadFile[] = [];
			for (const file of Array.from(fileList)) {
				// webkitRelativePath 形如 "<文件夹>/.agent.md"，去掉首段根文件夹名
				const rawPath = file.webkitRelativePath || file.name;
				const relativePath = rawPath.includes('/') ? rawPath.split('/').slice(1).join('/') : file.name;
				const data = new Uint8Array(await file.arrayBuffer());
				files.push({ relativePath, data });
			}
			const result = await this.agentStudioService.installAgentFromFolder(files);
			if (result.success) {
				this.notificationService.info(`已安装 Agent "${result.agentName}"`);
				// 列表刷新由 onDidChangeAgents 订阅自动触发
			} else {
				await this.dialogService.info('安装失败', result.error ?? '未知错误');
			}
		};
		this.element.appendChild(input);
		input.click();
	}

	// ── Render Preset Cards ──────────────────────────────────────────────────

	/**
	 * Resolve the marketplace slug for a given preset.
	 * Server slugs follow the pattern "agent-{presetId}", with special cases
	 * (e.g. "data" → "agent-data-analyst").
	 */
	private _getMarketSlug(preset: Agent): string {
		// Special mapping for presets whose names differ from slug pattern
		const slugOverrides: Record<string, string> = {
			'data': 'agent-data-analyst',
		};
		if (slugOverrides[preset.id]) { return slugOverrides[preset.id]; }
		// Builtin agents use agent-{id} pattern on the marketplace server
		const isBuiltin = preset.source === 'builtin';
		return isBuiltin ? `agent-${preset.id}` : preset.id;
	}

	/**
	 * Load marketplace agent packages + installed records for version comparison.
	 * Called once on construction; safe to re-call to refresh.
	 */
	private async _loadMarketplaceData(): Promise<void> {
		try {
			// Fetch server-side agent packages
			const { items } = await this.marketplaceService.listPackages({ kind: 'agent' as PackageKind, pageSize: 200 });
			this._marketPackages.clear();
			for (const pkg of items) {
				this._marketPackages.set(pkg.slug, pkg);
			}

			// Fetch installed records (from installed-packages.json — marketplace-installed).
			// source=published 的记录是本机自己发布的，单独进 _publishedVersions：
			// 既不算"商城已安装"（不挡上传按钮），又可用作本地版本比对（修复 vundefined）。
			const installed = await this.marketplaceService.getInstalled();
			this._installedVersions.clear();
			this._publishedVersions.clear();
			for (const entry of installed) {
				if (entry.kind !== 'agent') { continue; }
				if (entry.source === 'published') {
					this._publishedVersions.set(entry.storeId, entry.version);
				} else {
					this._installedVersions.set(entry.storeId, entry.version);
				}
			}

			// Also load local builtin agent versions (from agentStudioService)
			// so builtin agents that ship with the app show their version too.
			try {
				const agents = await this.agentStudioService.getAgents();
				for (const agent of agents) {
					const slug = this._getMarketSlug(agent);
					// Only set if not already present from installed-packages.json
					// (marketplace-installed version takes priority)
					if (agent.version && !this._installedVersions.has(slug)) {
						this._installedVersions.set(slug, agent.version);
					}
				}
			} catch { /* best-effort — local agent list may fail */ }

			// Re-render to show upgrade/delete buttons
			this._renderPresets();
		} catch (err) {
			console.warn('[PresetAgentView] Failed to load marketplace data:', err);
		}
	}

	/**
	 * Compare semver versions. Returns true if `server` > `local`.
	 */
	private _isVersionHigher(server: string | undefined, local: string | undefined): boolean {
		if (!server) { return false; }
		if (!local) { return true; }
		const parseVer = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
		const s = parseVer(server);
		const l = parseVer(local);
		for (let i = 0; i < Math.max(s.length, l.length); i++) {
			const sv = s[i] ?? 0;
			const lv = l[i] ?? 0;
			if (sv > lv) { return true; }
			if (sv < lv) { return false; }
		}
		return false;
	}

	private _getFilteredPresets(): Agent[] {
		let presets = [...this.agents];

		// Category filter
		if (this.activeCategory !== 'All') {
			presets = presets.filter(p => p.category === this.activeCategory);
		}

		// Search filter
		const query = this.searchInput?.value?.toLowerCase().trim();
		if (query) {
			presets = presets.filter(p =>
				p.name.toLowerCase().includes(query) ||
				p.role.toLowerCase().includes(query) ||
				p.description.toLowerCase().includes(query) ||
				(p.skills ?? []).some(s => s.toLowerCase().includes(query))
			);
		}

		// 持久化排序 + 置顶优先（共享实现）
		return applySavedOrder(presets, this._orderStore.load(), p => p.id, this._pinStore.load());
	}

	private _renderPresets(): void {
		try {
			if (!this.listContainer) { return; }
			this.listContainer.textContent = '';
			const presets = this._getFilteredPresets();

			if (presets.length === 0) {
				const empty = $('div.preset-empty');
				const emptyIcon = $('div.empty-icon');
				emptyIcon.textContent = '🔍';
				empty.appendChild(emptyIcon);

				const emptyText = $('p');
				emptyText.textContent = 'No presets match your search';
				empty.appendChild(emptyText);

				const emptyHint = $('p.empty-hint');
				emptyHint.textContent = 'Try adjusting your search or category filter';
				empty.appendChild(emptyHint);

				this.listContainer.appendChild(empty);
				return;
			}

			for (const preset of presets) {
				const card = this._createPresetCard(preset);
				this.listContainer.appendChild(card);
			}
		} catch (err) {
			console.error('[PresetAgentView] _renderPresets error:', err);
			if (this.listContainer) {
				this.listContainer.textContent = '';
				const errEl = document.createElement('div');
				errEl.style.cssText = 'padding:16px;color:#ff6b6b;font-size:12px;';
				errEl.textContent = `Failed to render presets: ${err instanceof Error ? err.message : String(err)}`;
				this.listContainer.appendChild(errEl);
			}
		}
	}

	private _createPresetCard(preset: Agent): HTMLElement {
		const card = $('div.preset-card');

		// ── Resolve marketplace status ──
		const slug = this._getMarketSlug(preset);
		const serverPkg = this._marketPackages.get(slug);
		const installedVersion = this._installedVersions.get(slug);
		const publishedVersion = this._publishedVersions.get(slug);
		// 本地有效版本：商城安装 > 本机发布 > agent 声明版本（修复自发布 agent 显示 vundefined）
		const localVersion = installedVersion ?? publishedVersion ?? preset.version;
		const serverVersion = serverPkg?.latestVersion;
		const isInstalled = !!installedVersion;
		const isSelfPublished = !!publishedVersion;
		const canUpgrade = this._isVersionHigher(serverVersion, localVersion);
		const isUpgrading = this._upgradingIds.has(preset.id);
		const isDeleting = this._deletingIds.has(preset.id);
		const isLoading = isUpgrading || isDeleting;

		// 上传可见性：自定义 + 非商城安装 + 有权限 + 有新版本可发（与商城同步则隐藏，避免无意义重传）
		const isCustom = preset.source === 'custom';
		const nextLocalVersion = preset.version ?? publishedVersion;
		const hasNewToUpload = !serverVersion || this._isVersionHigher(nextLocalVersion, serverVersion);
		const showUpload = isCustom && !isInstalled && this.agentStudioService.canUploadAgent(preset) && hasNewToUpload;

		// ── Status class on card ──
		if (isLoading) { card.classList.add('loading'); }
		else if (canUpgrade) { card.classList.add('upgradable'); }
		else if (isInstalled || isSelfPublished) { card.classList.add('installed'); }

		// 置顶标记
		const isPinned = this._pinStore.isPinned(preset.id);
		if (isPinned) { card.classList.add('pinned'); }

		// ── Status bar (left vertical accent) ──
		const statusBar = $('div.preset-status-bar');
		card.appendChild(statusBar);

		// ── Icon ──
		const iconEl = $('div.preset-icon');
		iconEl.textContent = preset.icon;
		card.appendChild(iconEl);

		// ── Body (name + version badge + role + skills) ──
		const body = $('div.preset-body');

		const titleRow = $('div.preset-title-row');

		const nameEl = $('span.preset-name');
		nameEl.textContent = preset.name;
		titleRow.appendChild(nameEl);

		// 置顶图标
		if (isPinned) {
			const pinIcon = $('span.preset-pin-icon');
			pinIcon.textContent = '📌';
			pinIcon.title = '已置顶';
			titleRow.appendChild(pinIcon);
		}

		// 内置标识
		if (preset.source === 'builtin') {
			const builtinBadge = $('span.builtin-badge');
			builtinBadge.textContent = '内置';
			builtinBadge.title = '产品内置 Agent';
			titleRow.appendChild(builtinBadge);
		}

		// Version badge
		if (isInstalled || isSelfPublished || serverVersion) {
			const verBadge = $('span.preset-version-badge');
			if (isLoading) {
				verBadge.textContent = isUpgrading ? '升级中...' : '卸载中...';
				verBadge.classList.add('outdated');
			} else if (canUpgrade) {
				verBadge.textContent = `v${localVersion} → v${serverVersion}`;
				verBadge.classList.add('outdated');
			} else if (isInstalled) {
				verBadge.textContent = `v${installedVersion}`;
				verBadge.classList.add('installed');
			} else if (isSelfPublished) {
				verBadge.textContent = `v${publishedVersion}`;
				verBadge.classList.add('installed');
			} else {
				verBadge.textContent = `v${serverVersion}`;
				verBadge.classList.add('remote');
			}
			titleRow.appendChild(verBadge);
		}
		body.appendChild(titleRow);

		const roleEl = $('div.preset-role');
		roleEl.textContent = preset.role;
		body.appendChild(roleEl);

		// Skill chips (always visible, compact)
		if ((preset.skills?.length ?? 0) > 0) {
			const skillsEl = $('div.preset-skills');
			for (const skill of preset.skills!.slice(0, 3)) {
				const chip = $('span.skill-chip');
				chip.textContent = skill;
				skillsEl.appendChild(chip);
			}
			if ((preset.skills?.length ?? 0) > 3) {
				const more = $('span.skill-chip');
				more.textContent = `+${(preset.skills?.length ?? 0) - 3}`;
				more.classList.add('more');
				skillsEl.appendChild(more);
			}
			body.appendChild(skillsEl);
		}
		card.appendChild(body);

		// ── Actions (right side) ──
		const actions = $('div.preset-actions');

		if (isLoading) {
			// Spinner replaces all buttons during load
			const spinner = $('div.preset-spinner');
			actions.appendChild(spinner);
		} else {
			// Upgrade button (with red dot indicator)
			if (canUpgrade) {
				const upgradeBtn = $('button.preset-btn.upgrade') as HTMLButtonElement;
				upgradeBtn.textContent = '⬆';
				upgradeBtn.title = `升级 ${preset.name} (v${localVersion} → v${serverVersion})`;
				const dot = $('span.preset-btn-dot');
				upgradeBtn.appendChild(dot);
				upgradeBtn.onclick = (e) => {
					e.stopPropagation();
					this._upgradePreset(preset, slug, serverVersion!);
				};
				actions.appendChild(upgradeBtn);
			}

			// Delete button — 内置 agent 不可删除
			if (preset.source !== 'builtin') {
				const deleteBtn = $('button.preset-btn.delete') as HTMLButtonElement;
				deleteBtn.textContent = '🗑';
				deleteBtn.title = `删除 ${preset.name}`;
				deleteBtn.onclick = (e) => {
					e.stopPropagation();
					this._deletePreset(preset, slug);
				};
				actions.appendChild(deleteBtn);
			}

			// Upload button — 自定义 + 有权限 + 有新版本可发（与商城同步时隐藏）
			if (showUpload) {
				const uploadBtn = $('button.preset-btn.upload') as HTMLButtonElement;
				uploadBtn.textContent = '📤';
				uploadBtn.title = `上传 "${preset.name}" 到商城`;
				uploadBtn.onclick = (e) => {
					e.stopPropagation();
					this._publishPreset(preset);
				};
				actions.appendChild(uploadBtn);
			}

			// Chat button (primary)
			const chatBtn = $('button.preset-btn.chat') as HTMLButtonElement;
			chatBtn.textContent = '💬';
			chatBtn.title = `与 ${preset.name} 对话`;
			chatBtn.onclick = (e) => {
				e.stopPropagation();
				this._chatWithPreset(preset);
			};
			actions.appendChild(chatBtn);
		}

		card.appendChild(actions);

		// Click anywhere on the card (except buttons) → open agent settings editor pane
		card.onclick = () => {
			this._openPresetEditor(preset);
		};

		// 右键菜单：置顶 / 复制 / 删除 / 升级(按需) / 上传(按需)（共享实现）
		card.oncontextmenu = (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (isLoading) { return; }
			showCardContextMenu(this.contextMenuService, e, {
				pinned: isPinned,
				onTogglePin: () => { this._pinStore.toggle(preset.id); this._renderPresets(); },
				onDuplicate: () => { void this._duplicatePreset(preset); },
				upgradeLabel: canUpgrade && serverVersion ? `升级到 v${serverVersion}` : undefined,
				onUpgrade: canUpgrade && serverVersion ? () => { void this._upgradePreset(preset, slug, serverVersion); } : undefined,
				onUpload: showUpload ? () => { void this._publishPreset(preset); } : undefined,
				onDelete: preset.source !== 'builtin' ? () => { void this._deletePreset(preset, slug); } : undefined,
			});
		};

		// 拖拽排序（共享实现，顺序持久化到 storage）
		this._dragSorter.attach(card, preset.id);

		return card;
	}

	// ── Chat ─────────────────────────────────────────────────────────────────

	/**
	 * 点击预设的"💬聊天"按钮：
	 * 1. 遍历已打开的编辑器 pane，查找是否有 agentId 匹配的聊天框
	 * 2. 若有 → 聚焦该聊天框 + 聚焦输入框
	 * 3. 若无 → 在 agent editor part 中打开新的聊天 tab
	 */
	private async _chatWithPreset(preset: Agent): Promise<void> {
		if (this.isDeploying) { return; }
		this.isDeploying = true;

		try {
			// 1. 查找已有的匹配聊天框
			const found = this._findChatPaneForAgent(preset.id);
			if (found) {
				// 切换到该 tab 并聚焦输入框
				if (found.group) {
					await found.group.openEditor(found.input, { pinned: true });
				}
				// 聚焦聊天输入框 — 通过 visibleEditorPanes 找到对应的 NativeChatEditorPane
				for (const pane of this.editorService.visibleEditorPanes) {
					if (pane.input === found.input) {
						(pane as any).focusInput?.();
						break;
					}
				}
				return;
			} else {
				// 2. 打开新聊天 tab — 默认开在独立的 group 中
				const { NativeChatEditorInput } = await import('../nativeChatEditorInput.js');
				const input = NativeChatEditorInput.create(undefined, preset.id, undefined, preset.name);
				// 找到 agent part，创建新 group 确保新聊天开在独立 group 中
				const agentPart = (this.editorGroupsService as any).agentPart;
				if (agentPart?.activeGroup) {
					// 修复：全部页签关闭后活动 group 为空时，复用空 group，
					// 避免拆出「空 group + 聊天 group」两个分栏。
					const active = agentPart.activeGroup;
					const targetGroup = active.editors.length === 0
						? active
						: (agentPart.groups.find((g: { editors: readonly unknown[] }) => g.editors.length === 0)
							?? agentPart.addGroup(active, 3 /* GroupDirection.RIGHT */));
					await targetGroup.openEditor(input, { pinned: true });
				} else {
					await this.editorService.openEditor(input, { pinned: true });
				}
				this.notificationService.info(
					`已打开 "${preset.name}" 聊天框。`
				);
			}
		} catch (err) {
			this.notificationService.error(
				`Failed to start chat with "${preset.name}": ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			this.isDeploying = false;
		}
	}

	/**
	 * 在所有编辑器 group 中查找 agentId 匹配的 NativeChatEditorInput。
	 *
	 * **修复**：旧实现仅遍历 `visibleEditorPanes`，导致后台（非活跃）
	 * tab 中的 chat 无法被找到，造成重复打开。
	 * 新实现遍历所有 group 的 `editors` 数组，覆盖后台 tab。
	 *
	 * @returns 匹配的 input 及其 group，或 undefined
	 */
	private _findChatPaneForAgent(agentId: string): { input: EditorInput; group: IEditorGroup | undefined } | undefined {
		for (const group of this.editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */)) {
			for (const editor of group.editors) {
				// 检查 typeId 匹配 NativeChatEditorInput（避免动态 import 的类型问题）
				if (editor.typeId === 'workbench.editors.nativeChatInput') {
					const ed = editor as any;
					if (ed.agentId === agentId) {
						return { input: editor, group };
					}
				}
			}
		}
		return undefined;
	}

	// ── Open Preset Editor ──────────────────────────────────────────────────

	private async _openPresetEditor(preset: Agent): Promise<void> {
		// Open the agent settings editor pane only.
		// NOTE: do NOT call fireSelectAgent() here — that would switch the
		// main chat panel to chat with this agent, which is NOT what the user
		// wants. The click should only open the independent editor pane.
		try {
			const input = new AgentSettingsEditorInput(preset.id, preset.name);
			const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
			await this.editorService.openEditor(input, { pinned: true }, targetGroup);
		} catch (err) {
			this.notificationService.error(
				`Failed to open settings for "${preset.name}": ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	// ── Open Create Agent Pane ─────────────────────────────────────────────

	private async _openCreateAgentPane(): Promise<void> {
		try {
			const input = AgentCreateEditorInput.getInstance();
			const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
			await this.editorService.openEditor(input, { pinned: true }, targetGroup);
		} catch (err) {
			this.notificationService.error(
				`Failed to open create agent pane: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	// ── Duplicate Agent ────────────────────────────────────────────────────

	private async _duplicatePreset(preset: Agent): Promise<void> {
		try {
			// Create a copy with "(副本)" suffix in the name
			const copyName = `${preset.name} (副本)`;
			const agentData: Partial<import('../../../../common/agentStudioTypes.js').Agent> = {
				name: copyName,
				role: preset.role,
				description: preset.description,
				icon: preset.icon,
				model: preset.model,
				skills: [...preset.skills],
				tools: preset.tools ? [...preset.tools] : [],
				category: preset.category,
				systemPrompt: preset.systemPrompt,
				temperature: preset.temperature,
				source: 'custom',
			};
			const created = await this.agentStudioService.createAgent(agentData);
			this.notificationService.info(`已复制为 "${copyName}"`);

			// Open the settings editor for the new duplicated agent
			const input = new AgentSettingsEditorInput(created.id, created.name);
			const groups = this.editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];
			await this.editorService.openEditor(input, { pinned: true }, targetGroup);
		} catch (err) {
			this.notificationService.error(
				`复制 Agent 失败: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	// ── Upgrade / Delete (marketplace-installed agents) ──────────────────────

	private async _upgradePreset(preset: Agent, slug: string, version: string): Promise<void> {
		if (this._upgradingIds.has(preset.id)) { return; }
		this._upgradingIds.add(preset.id);
		this._renderPresets();

		try {
			this.notificationService.info(`正在升级 "${preset.name}" 到 v${version}...`);
			await this.marketplaceService.download(slug, version, 'agent' as PackageKind);
			// Update local version tracking
			this._installedVersions.set(slug, version);

			// Auto-download missing dependencies
			try {
				const pkg = await this.marketplaceService.getPackage(slug);
				const manifest = pkg.versions.find(v => v.version === version)?.manifest
					|| pkg.versions.find(v => v.isLatest)?.manifest;
				if (manifest) {
					const skillRefs = (manifest as any).skillRefs as string[] | undefined;
					const mcpRefs = (manifest as any).mcpRefs as string[] | undefined;
					const allMissing = [
						...(skillRefs || []).filter(s => !this._installedVersions.has(s)),
						...(mcpRefs || []).filter(m => !this._installedVersions.has(m)),
					];
					if (allMissing.length > 0) {
						for (const depSlug of allMissing) {
							try {
								await this.marketplaceService.download(depSlug, '', 'skill' as PackageKind);
								this._installedVersions.set(depSlug, '1.0.0');
							} catch { /* skip */ }
						}
					}
				}
			} catch { /* best-effort */ }

			this.notificationService.info(`"${preset.name}" 已升级到 v${version}`);
		} catch (err) {
			this.notificationService.error(
				`升级 "${preset.name}" 失败: ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			this._upgradingIds.delete(preset.id);
			this._renderPresets();
		}
	}

	private async _deletePreset(preset: Agent, slug: string): Promise<void> {
		if (this._deletingIds.has(preset.id)) { return; }

		const localVersion = this._installedVersions.get(slug);
		const isInstalled = !!localVersion;

		// Confirm before deleting
		const confirmed = await this.dialogService.confirm({
			message: `确定要删除 "${preset.name}" 吗？`,
			detail: isInstalled
				? `这将从本地移除已安装的智能体 (v${localVersion})。\n该操作不可撤销。`
				: `这将删除该 Agent 的定义和相关文件。\n该操作不可撤销。`,
			primaryButton: '删除',
			cancelButton: '取消',
		});
		if (!confirmed.confirmed) { return; }

		this._deletingIds.add(preset.id);
		this._renderPresets();

		try {
			// If installed from marketplace, uninstall it
			if (isInstalled) {
				await this.marketplaceService.uninstall(slug, 'agent' as PackageKind);
				this._installedVersions.delete(slug);
			}

			// 从服务删除 agent（删除 ~/.saros/agents/{id}/ 目录）
			try {
				await this.agentStudioService.deleteAgent(preset.id);
			} catch {
				// Agent may be a builtin that can't be deleted — ignore
			}

			this._updateCount();
			this.notificationService.info(`"${preset.name}" 已删除`);
		} catch (err) {
			this.notificationService.error(
				`删除 "${preset.name}" 失败: ${err instanceof Error ? err.message : String(err)}`
			);
		} finally {
			this._deletingIds.delete(preset.id);
			this._renderPresets();
		}
	}

	// ── Publish (Upload) ─────────────────────────────────────────────────────

	private async _publishPreset(preset: Agent): Promise<void> {
		// Permission guard: only the owner (or an unclaimed agent) may upload.
		if (!this.agentStudioService.canUploadAgent(preset)) {
			this.notificationService.warn(`仅创建者(owner)可上传该 Agent「${preset.name}」`);
			return;
		}

		const name = preset.name;

		// 版本预检：拉取商城远端信息（无包则 undefined），用于建议版本号与发布前校验。
		const remote = await this.marketplaceService.getPackage(preset.id).catch(() => undefined);
		let version = remote ? suggestNextVersion(remote) : (preset.version || '1.0.0');

		while (true) {
			// Ask for version before publishing
			const result = await this.dialogService.input({
				title: `上传 "${name}" 到商城`,
				message: `输入版本号 (如 1.0.0)`,
				inputs: [
					{ value: version, placeholder: '版本号' },
					{ value: '', placeholder: '更新说明 changelog（可选），如：修复表格抽取越界' },
				],
				primaryButton: '上传',
				cancelButton: '取消',
			});
			if (!result.confirmed) { return; }

			version = result.values?.[0]?.trim() || version;
			const changelog = result.values?.[1]?.trim() || undefined;

			// 发布前校验：格式 / 历史版本查重 / 必须大于 latest
			const versionError = validatePublishVersion(version, remote);
			if (versionError) {
				this.notificationService.warn(versionError);
				continue;
			}

			try {
				// Collect skill/MCP refs from preset
				const skillRefs = preset.skills || [];
				const mcpRefs = preset.tools?.filter(t => t.startsWith('mcp:')) || [];

				// Auto-upload missing dependencies first
				await this._uploadMissingDeps(skillRefs, version, preset.id);

				this.notificationService.info(`正在上传 "${name}" v${version}...`);
				// Use preset.id directly — preparePack resolves agent by this ID
				const { version: published } = await this.marketplaceService.publish(preset.id, 'agent' as PackageKind, {
					name,
					version,
					description: preset.description || undefined,
					category: preset.category || undefined,
					skillRefs: skillRefs.length > 0 ? skillRefs : undefined,
					mcpRefs: mcpRefs.length > 0 ? mcpRefs : undefined,
					changelog,
				});
				// 发布锚点：autoCommit + git tag，关联商城版本与本地 git 历史（best-effort）
				try {
					await this.agentVersionService.autoCommit(preset.id, `publish: v${published} to marketplace`);
					await this.agentVersionService.tag(preset.id, `v${published}`);
				} catch { /* non-critical */ }
				// Track as self-published after successful upload（与 _loadMarketplaceData 口径一致）
				const slug = this._getMarketSlug(preset);
				this._publishedVersions.set(slug, published);
				this._renderPresets();
				this.notificationService.info(`"${name}" v${published} 已上传到商城`);
				// Claim ownership so non-owners cannot re-upload later.
				await this.agentStudioService.claimAgentOwnership(preset.id);
				return;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.notificationService.error(`上传 "${name}" 失败: ${msg}`);
				// 版本冲突：自动递增版本号并重新弹框，引导用户重试。
				if (isVersionConflictError(msg)) {
					version = bumpPatch(version);
					continue;
				}
				return;
			}
		}
	}

	/** Auto-upload missing skill dependencies before uploading the agent. */
	private async _uploadMissingDeps(skillRefs: string[], version: string, agentId?: string): Promise<number> {
		let uploadedCount = 0;
		for (const slug of skillRefs) {
			// 与 Agent 同名的依赖：slug 全局唯一，先发布 skill 会抢占标识导致 agent 发布被服务端拒绝，跳过并指引改名
			if (agentId && slug === agentId) {
				this.notificationService.warn(`关联 Skill "${slug}" 与 Agent 同名，商城标识全局唯一。请先将该 Skill 改名（如 ${slug}-skill）并更新 Agent 的 skills 引用后再上传`);
				continue;
			}
			try {
				const exists = await this._checkPackageExists(slug);
				if (!exists) {
					try {
						this.notificationService.info(`正在上传关联 Skill: ${slug}...`);
						await this.marketplaceService.publish(slug, 'skill' as PackageKind, { version });
						uploadedCount++;
					} catch {
						this.notificationService.warn(`关联 Skill "${slug}" 无法上传（本地不存在或上传失败），已跳过`);
					}
				}
			} catch { /* skip on check failure */ }
		}
		if (uploadedCount > 0) {
			this.notificationService.info(`已自动上传 ${uploadedCount} 个关联 Skill`);
		}
		return uploadedCount;
	}

	private async _checkPackageExists(slug: string): Promise<boolean> {
		try {
			await this.marketplaceService.getPackage(slug);
			return true;
		} catch {
			return false;
		}
	}

	// ── Count ───────────────────────────────────────────────────────────────

	/** 更新总数徽章（来源：~/.saros/agents/ 下的 agent 数量）。 */
	private _updateCount(): void {
		const countBadge = this.element?.querySelector('.preset-count');
		if (countBadge) {
			countBadge.textContent = `${this.agents.length} presets`;
		}
	}

	// ── Layout ───────────────────────────────────────────────────────────────

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		// The container is .pane-body which also has .preset-agent-view class.
		// It sits inside .pane (display:flex, flex-direction:column).
		// We override flex:1 with flex:none + explicit pixel height to ensure
		// the container gets exactly the right height from the splitview layout.
		// The children (.preset-header, .preset-search-box, etc.) are flex-shrink:0,
		// and .preset-grid uses flex:1 + min-height:0 to fill remaining space.
		const container = this.listContainer?.parentElement;
		if (container) {
			container.style.height = `${height}px`;
			container.style.flex = 'none';
		}
		// Debug: log layout dimensions and parent hierarchy with class names
		console.log(`[PresetAgent] layoutBody: height=${height}, width=${width}`);
		if (container) {
			let el: HTMLElement | null = container;
			let level = 0;
			const labels = ['container(body)', 'pane', 'split-view-view', 'split-view-container', 'scrollable', 'monaco-pane-view', 'composite?', 'content?', 'part?'];
			while (el && level < 9) {
				console.log(`[PresetAgent] L${level}(${labels[level]}): class="${el.className}", clientH=${el.clientHeight}, styleH="${el.style.height}", offsetH=${el.offsetHeight}`);
				el = el.parentElement;
				level++;
			}
		}
	}
}
