/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { $, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { McpServerEditorInput } from './mcpServerEditorInput.js';
import { McpDetailEditorInput } from './mcpDetailEditorInput.js';
import { ResourceManagerEditorInput } from './resourceManagerEditorInput.js';
import { ResourceManagerEditorPane } from './resourceManagerEditorPane.js';
import { getMcpPresets, type IMcpServerPreset } from '../common/bundled-tools/bundledMcpPresets.js';
import { IMarketplaceService, IMarketplacePackage, IUpgradeInfo, PackageKind } from '../common/marketplace.js';
import { IWorkbenchMcpManagementService } from '../../../../workbench/services/mcp/common/mcpWorkbenchManagementService.js';
import { IEventBridgeService } from '../common/eventBridge.js';
import { IInstallableMcpServer } from '../../../../platform/mcp/common/mcpManagement.js';
import { IMcpServerConfiguration, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../common/sarosPaths.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface IInstalledEntry {
	kind: PackageKind;
	storeId: string;
	version: string;
}

// ─── EditorPane ──────────────────────────────────────────────────────────────

export class McpServerEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.mcpServer';

	private _container!: HTMLElement;
	private _gridEl!: HTMLElement;
	private _countEl!: HTMLElement;
	private _searchInput!: HTMLInputElement;
	private _refreshBtn!: HTMLButtonElement;

	// Data
	private _packages: readonly IMarketplacePackage[] = [];
	/** 已安装的 MCP：slug → 当前版本 */
	private _installedMap: Map<string, string> = new Map();
	/** 可升级的 MCP：slug → 升级信息 */
	private _upgrades: Map<string, IUpgradeInfo> = new Map();
	private _loading = false;
	private _installingSlugs = new Set<string>();
	private _searchQuery = '';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileService private readonly fileService: IFileService,
			@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@IEventBridgeService private readonly eventBridgeService: IEventBridgeService,
	) {
		super(McpServerEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = $('div.mcp-server-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		this._container.style.overflow = 'hidden';
		this._container.style.fontSize = '13px';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof McpServerEditorInput)) { return; }

		// Only build UI and load data on first open
		if (this._container.childElementCount === 0) {
			this._buildUI();
			await this._loadPackages();
		}
	}

	override layout(dimension: Dimension): void {
		this._container.style.width = `${dimension.width}px`;
		this._container.style.height = `${dimension.height}px`;
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  UI BUILD
	// ══════════════════════════════════════════════════════════════════════════

	private _buildUI(): void {
		clearNode(this._container);

		// ── Toolbar ──────────────────────────────────────────────────
		const toolbar = $('div.mcp-editor-toolbar');
		toolbar.style.display = 'flex';
		toolbar.style.alignItems = 'center';
		toolbar.style.gap = '12px';
		toolbar.style.padding = '12px 16px';
		toolbar.style.background = 'var(--vscode-sideBar-background, #252526)';
		toolbar.style.borderBottom = '1px solid var(--vscode-panel-border)';
		toolbar.style.flexShrink = '0';

		const title = $('h1.mcp-editor-title');
		title.textContent = '\u{1F50C} MCP Servers';
		title.style.margin = '0';
		title.style.fontSize = '15px';
		title.style.fontWeight = '600';
		title.style.whiteSpace = 'nowrap';
		toolbar.appendChild(title);

		// Search
		const searchWrap = $('div');
		searchWrap.style.flex = '1';
		searchWrap.style.maxWidth = '360px';
		searchWrap.style.display = 'flex';
		searchWrap.style.alignItems = 'center';
		searchWrap.style.gap = '6px';
		searchWrap.style.background = 'var(--vscode-input-background)';
		searchWrap.style.border = '1px solid var(--vscode-input-border, transparent)';
		searchWrap.style.borderRadius = '6px';
		searchWrap.style.padding = '5px 10px';

		const searchIcon = $('span');
		searchIcon.textContent = '\u{1F50D}';
		searchIcon.style.fontSize = '12px';
		searchIcon.style.opacity = '0.6';
		searchWrap.appendChild(searchIcon);

		this._searchInput = $('input') as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.placeholder = '搜索 MCP...';
		this._searchInput.style.flex = '1';
		this._searchInput.style.background = 'none';
		this._searchInput.style.border = 'none';
		this._searchInput.style.outline = 'none';
		this._searchInput.style.color = 'var(--vscode-input-foreground)';
		this._searchInput.style.fontSize = '12px';
		this._searchInput.oninput = () => {
			this._searchQuery = this._searchInput.value.trim().toLowerCase();
			this._renderGrid();
		};
		searchWrap.appendChild(this._searchInput);
		toolbar.appendChild(searchWrap);

		const spacer = $('div');
		spacer.style.flex = '1';
		toolbar.appendChild(spacer);

		// Refresh button
		this._refreshBtn = $('button.mcp-editor-refresh-btn') as HTMLButtonElement;
		this._refreshBtn.textContent = '\u{1F504}';
		this._refreshBtn.title = '刷新 MCP 列表';
		this._refreshBtn.style.padding = '5px 10px';
		this._refreshBtn.style.fontSize = '12px';
		this._refreshBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		this._refreshBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		this._refreshBtn.style.border = '1px solid var(--vscode-panel-border)';
		this._refreshBtn.style.borderRadius = '6px';
		this._refreshBtn.style.cursor = 'pointer';
		this._refreshBtn.onclick = () => { void this._loadPackages(); };
		toolbar.appendChild(this._refreshBtn);

		// + Add Server button → open ~/.vssaros/saros/mcp.json file
		const addBtn = $('button.mcp-editor-add-btn') as HTMLButtonElement;
		addBtn.textContent = '+ Add Server';
		addBtn.title = '打开 ~/.vssaros/saros/mcp.json 文件，手动编辑 MCP 服务器配置';
		addBtn.style.padding = '6px 14px';
		addBtn.style.fontSize = '13px';
		addBtn.style.fontWeight = '500';
		addBtn.style.background = 'var(--vscode-button-background)';
		addBtn.style.color = 'var(--vscode-button-foreground)';
		addBtn.style.border = 'none';
		addBtn.style.borderRadius = '4px';
		addBtn.style.cursor = 'pointer';
		addBtn.style.whiteSpace = 'nowrap';
		addBtn.onclick = () => { void this._openMcpJsonFile(); };
		toolbar.appendChild(addBtn);

		this._container.appendChild(toolbar);

		// ── Grid scroll area ────────────────────────────────────────
		const scrollArea = $('div.mcp-editor-scroll');
		scrollArea.style.flex = '1';
		scrollArea.style.overflowY = 'auto';
		scrollArea.style.padding = '18px 20px';

		// Section title
		const sectionTitle = $('div.mcp-editor-section-title');
		sectionTitle.style.display = 'flex';
		sectionTitle.style.alignItems = 'center';
		sectionTitle.style.gap = '8px';
		sectionTitle.style.marginBottom = '14px';

		const titleText = $('span');
		titleText.textContent = '\u{1F4E6} 商城 MCP ';
		titleText.style.fontSize = '14px';
		titleText.style.fontWeight = '600';
		titleText.style.color = 'var(--vscode-foreground)';
		sectionTitle.appendChild(titleText);

		this._countEl = $('span');
		this._countEl.style.fontSize = '12px';
		this._countEl.style.color = 'var(--vscode-textLink-foreground)';
		sectionTitle.appendChild(this._countEl);

		const src = $('span.mcp-editor-src');
		src.style.marginLeft = 'auto';
		src.style.fontSize = '11px';
		src.style.color = 'var(--vscode-descriptionForeground)';
		src.style.display = 'flex';
		src.style.alignItems = 'center';
		src.style.gap = '4px';
		const dot = $('span');
		dot.style.width = '7px';
		dot.style.height = '7px';
		dot.style.borderRadius = '50%';
		dot.style.background = 'var(--vscode-testing-iconPassed, #89d185)';
		dot.style.boxShadow = '0 0 6px var(--vscode-testing-iconPassed, #89d185)';
		src.appendChild(dot);
		src.appendChild(document.createTextNode('数据源：AnyDev 商城服务器'));
		sectionTitle.appendChild(src);

		scrollArea.appendChild(sectionTitle);

		// Grid container
		this._gridEl = $('div.mcp-editor-grid');
		this._gridEl.style.display = 'grid';
		this._gridEl.style.gridTemplateColumns = 'repeat(auto-fill, minmax(280px, 1fr))';
		this._gridEl.style.gap = '12px';
		scrollArea.appendChild(this._gridEl);

		this._container.appendChild(scrollArea);
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  DATA
	// ══════════════════════════════════════════════════════════════════════════

	private async _loadPackages(): Promise<void> {
		if (this._loading) { return; }
		this._loading = true;
		this._refreshBtn.textContent = '\u{23F3}';
		this._refreshBtn.disabled = true;

		// Show loading state
		clearNode(this._gridEl);
		const loading = $('div');
		loading.style.gridColumn = '1 / -1';
		loading.style.textAlign = 'center';
		loading.style.padding = '40px';
		loading.style.color = 'var(--vscode-descriptionForeground)';
		loading.textContent = '\u{23F3} 加载中...';
		this._gridEl.appendChild(loading);
		this._countEl.textContent = '';

		try {
			// 1. Fetch MCP packages from marketplace server (AnyDev)
			const result = await this.marketplaceService.listPackages({ kind: 'mcp' });
			this._packages = result.items;

			// 2. Read installed MCP entries (slug → version) from installed-packages.json
			this._installedMap = await this._readInstalledMcps();

			// 3. Check upgrades for installed MCPs
			this._upgrades.clear();
			if (this._installedMap.size > 0) {
				const checkItems = Array.from(this._installedMap.entries()).map(([storeId, version]) =>
					({ kind: 'mcp' as PackageKind, storeId, version }));
				try {
					const upgrades = await this.marketplaceService.checkUpgrades(checkItems);
					for (const u of upgrades) {
						if (u.kind === 'mcp') {
							this._upgrades.set(u.storeId, u);
						}
					}
				} catch (e) {
					console.warn('[McpServerEditor] Upgrade check failed:', e);
				}
			}

			this._renderGrid();
		} catch (err) {
			console.error('[McpServerEditor] Failed to load MCP packages:', err);
			clearNode(this._gridEl);
			// Built-in presets stay reachable even when the marketplace is down.
			const builtins = getMcpPresets().filter(p => p.builtin);
			if (builtins.length > 0) {
				this._gridEl.appendChild(this._builtinSectionHeader(builtins.length));
				for (const preset of builtins) {
					this._gridEl.appendChild(this._createBuiltinCard(preset));
				}
			}
			const errEl = $('div');
			errEl.style.gridColumn = '1 / -1';
			errEl.style.textAlign = 'center';
			errEl.style.padding = '40px';
			errEl.style.color = 'var(--vscode-errorForeground)';
			errEl.textContent = `商城加载失败: ${err instanceof Error ? err.message : String(err)}`;
			this._gridEl.appendChild(errEl);
		} finally {
			this._refreshBtn.textContent = '\u{1F504}';
			this._refreshBtn.disabled = false;
			this._loading = false;
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  RENDER
	// ══════════════════════════════════════════════════════════════════════════

	private _renderGrid(): void {
		if (!this._gridEl) { return; }
		clearNode(this._gridEl);

		// Built-in presets (Comfy MCP etc.) — always shown on top, search-filtered.
		const q = this._searchQuery;
		const builtins = getMcpPresets().filter(p => p.builtin && (
			!q || p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q)
		));
		if (builtins.length > 0) {
			this._gridEl.appendChild(this._builtinSectionHeader(builtins.length));
			for (const preset of builtins) {
				this._gridEl.appendChild(this._createBuiltinCard(preset));
			}
		}

		// Apply search filter
		let items = this._packages;
		if (q) {
			items = items.filter(p =>
				p.name.toLowerCase().includes(q) ||
				(p.description ?? '').toLowerCase().includes(q) ||
				(p.tags ?? []).some(t => t.toLowerCase().includes(q)) ||
				(p.category ?? '').toLowerCase().includes(q)
			);
		}

		this._countEl.textContent = `${items.length} 个`;

		if (items.length === 0) {
			const empty = $('div');
			empty.style.gridColumn = '1 / -1';
			empty.style.textAlign = 'center';
			empty.style.padding = '40px';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.textContent = this._searchQuery
				? `没有匹配 "${this._searchQuery}" 的 MCP`
				: '暂无可安装的 MCP';
			this._gridEl.appendChild(empty);
			return;
		}

		for (const pkg of items) {
			this._gridEl.appendChild(this._createCard(pkg));
		}
	}

	/** "内置 MCP" 区块标题（跨满网格）。 */
	private _builtinSectionHeader(count: number): HTMLElement {
		const header = $('div.mcp-editor-builtin-header');
		header.style.gridColumn = '1 / -1';
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.gap = '8px';
		header.style.marginTop = '6px';
		header.style.fontSize = '13px';
		header.style.fontWeight = '600';
		header.style.color = 'var(--vscode-descriptionForeground)';
		const label = $('span');
		label.textContent = '⭐ 内置 MCP';
		header.appendChild(label);
		const cnt = $('span');
		cnt.textContent = `${count} 个`;
		cnt.style.fontSize = '11px';
		cnt.style.color = 'var(--vscode-textLink-foreground)';
		header.appendChild(cnt);
		return header;
	}

	/** 内置预设卡片：点击打开 detail（支持一键"自动安装并配置"）。 */
	private _createBuiltinCard(preset: IMcpServerPreset): HTMLElement {
		const card = $('div.mcp-editor-card');
		card.style.background = 'var(--vscode-sideBar-background, #252526)';
		card.style.border = '1px solid var(--vscode-panel-border)';
		card.style.borderRadius = '8px';
		card.style.padding = '14px';
		card.style.cursor = 'pointer';
		card.style.transition = 'all 0.15s';
		card.style.display = 'flex';
		card.style.flexDirection = 'column';
		card.style.gap = '10px';
		card.style.borderLeft = '3px solid var(--vscode-textLink-foreground, #3794ff)';
		card.onmouseenter = () => { card.style.background = 'var(--vscode-list-hoverBackground)'; card.style.borderColor = 'var(--vscode-focusBorder)'; };
		card.onmouseleave = () => { card.style.background = 'var(--vscode-sideBar-background, #252526)'; card.style.borderColor = 'var(--vscode-panel-border)'; };
		card.onclick = () => { void this.editorService.openEditor(McpDetailEditorInput.getInstance(preset.id), { pinned: true }); };

		const top = $('div');
		top.style.display = 'flex';
		top.style.alignItems = 'flex-start';
		top.style.gap = '10px';

		const icon = $('div');
		icon.textContent = preset.icon || '\u{1F50C}';
		icon.style.width = '34px';
		icon.style.height = '34px';
		icon.style.flexShrink = '0';
		icon.style.display = 'flex';
		icon.style.alignItems = 'center';
		icon.style.justifyContent = 'center';
		icon.style.fontSize = '18px';
		icon.style.borderRadius = '8px';
		icon.style.background = 'var(--vscode-sideBarSectionHeader-background)';
		icon.style.border = '1px solid var(--vscode-panel-border)';
		top.appendChild(icon);

		const info = $('div');
		info.style.flex = '1';
		info.style.minWidth = '0';
		const nameRow = $('div');
		nameRow.style.display = 'flex';
		nameRow.style.alignItems = 'center';
		nameRow.style.gap = '6px';
		const nameEl = $('span');
		nameEl.textContent = preset.name;
		nameEl.style.fontSize = '13px';
		nameEl.style.fontWeight = '600';
		nameRow.appendChild(nameEl);
		const badge = $('span');
		badge.textContent = '内置';
		badge.style.fontSize = '10px';
		badge.style.padding = '1px 6px';
		badge.style.borderRadius = '8px';
		badge.style.background = 'var(--vscode-badge-background)';
		badge.style.color = 'var(--vscode-badge-foreground)';
		nameRow.appendChild(badge);
		info.appendChild(nameRow);
		if (preset.description) {
			const desc = $('div');
			desc.textContent = preset.description.length > 110 ? preset.description.slice(0, 110) + '…' : preset.description;
			desc.style.fontSize = '11px';
			desc.style.color = 'var(--vscode-descriptionForeground)';
			desc.style.marginTop = '3px';
			desc.style.lineHeight = '1.45';
			info.appendChild(desc);
		}
		top.appendChild(info);
		card.appendChild(top);

		const footer = $('div');
		footer.style.display = 'flex';
		footer.style.alignItems = 'center';
		footer.style.gap = '8px';
		footer.style.fontSize = '11px';
		footer.style.color = 'var(--vscode-descriptionForeground)';
		const type = $('span');
		type.textContent = preset.transportType === 'http' ? 'HTTP' : 'stdio';
		footer.appendChild(type);
		if (preset.autoInstall) {
			const hint = $('span');
			hint.textContent = '⚙ 支持自动安装并配置';
			hint.style.color = 'var(--vscode-textLink-foreground, #3794ff)';
			footer.appendChild(hint);
		}
		card.appendChild(footer);

		return card;
	}

	private _createCard(pkg: IMarketplacePackage): HTMLElement {
		const isInstalled = this._installedMap.has(pkg.slug);
		const isInstalling = this._installingSlugs.has(pkg.slug);
		const upgrade = this._upgrades.get(pkg.slug);

		const card = $('div.mcp-editor-card');
		card.style.background = 'var(--vscode-sideBar-background, #252526)';
		card.style.border = '1px solid var(--vscode-panel-border)';
		card.style.borderRadius = '8px';
		card.style.padding = '14px';
		card.style.cursor = 'pointer';
		card.style.transition = 'all 0.15s';
		card.style.display = 'flex';
		card.style.flexDirection = 'column';
		card.style.gap = '10px';
		// Left border accent by status
		if (isInstalled && upgrade) {
			card.style.borderLeft = '3px solid var(--vscode-editorWarning-foreground, #d29922)';
		} else if (isInstalled) {
			card.style.borderLeft = '3px solid var(--vscode-testing-iconPassed, #89d185)';
		}

		card.onmouseenter = () => {
			card.style.background = 'var(--vscode-list-hoverBackground)';
			card.style.borderColor = 'var(--vscode-focusBorder)';
		};
		card.onmouseleave = () => {
			card.style.background = 'var(--vscode-sideBar-background, #252526)';
			card.style.borderColor = 'var(--vscode-panel-border)';
		};

		// Click card → open ResourceManager detail window
		card.onclick = () => { void this._openInResourceManager(pkg); };

		// ── Top: icon + name + meta ─────────────────────────────────
		const top = $('div');
		top.style.display = 'flex';
		top.style.alignItems = 'flex-start';
		top.style.gap = '10px';

		const icon = $('div');
		icon.style.width = '36px';
		icon.style.height = '36px';
		icon.style.borderRadius = '8px';
		icon.style.display = 'flex';
		icon.style.alignItems = 'center';
		icon.style.justifyContent = 'center';
		icon.style.fontSize = '18px';
		icon.style.flexShrink = '0';
		icon.style.background = 'linear-gradient(135deg,#9b59b6,#8e44ad)';
		icon.textContent = pkg.icon || '\u{1F50C}';
		top.appendChild(icon);

		const info = $('div');
		info.style.flex = '1';
		info.style.minWidth = '0';

		const name = $('div');
		name.textContent = pkg.name;
		name.style.fontSize = '13px';
		name.style.fontWeight = '600';
		name.style.color = 'var(--vscode-foreground)';
		name.style.whiteSpace = 'nowrap';
		name.style.overflow = 'hidden';
		name.style.textOverflow = 'ellipsis';
		info.appendChild(name);

		const meta = $('div');
		meta.style.display = 'flex';
		meta.style.alignItems = 'center';
		meta.style.gap = '8px';
		meta.style.marginTop = '3px';

		if (pkg.latestVersion) {
			const ver = $('span');
			ver.textContent = `v${pkg.latestVersion}`;
			ver.style.fontSize = '11px';
			ver.style.color = 'var(--vscode-textLink-foreground)';
			meta.appendChild(ver);
		}
		if (typeof pkg.downloads === 'number' && pkg.downloads > 0) {
			const dl = $('span');
			dl.textContent = `\u2B07 ${this._formatCount(pkg.downloads)}`;
			dl.style.fontSize = '11px';
			dl.style.color = 'var(--vscode-descriptionForeground)';
			meta.appendChild(dl);
		}
		info.appendChild(meta);
		top.appendChild(info);
		card.appendChild(top);

		// ── Description ─────────────────────────────────────────────
		const desc = $('div');
		desc.textContent = pkg.description || '(暂无描述)';
		desc.style.fontSize = '12px';
		desc.style.color = 'var(--vscode-descriptionForeground)';
		desc.style.lineHeight = '1.5';
		desc.style.display = '-webkit-box';
		desc.style.webkitLineClamp = '2';
		(desc.style as any).webkitBoxOrient = 'vertical';
		desc.style.overflow = 'hidden';
		desc.style.minHeight = '36px';
		card.appendChild(desc);

		// ── Footer: tags + action ───────────────────────────────────
		const footer = $('div');
		footer.style.display = 'flex';
		footer.style.alignItems = 'center';
		footer.style.justifyContent = 'space-between';
		footer.style.marginTop = 'auto';
		footer.style.gap = '6px';

		const tagsEl = $('div');
		tagsEl.style.display = 'flex';
		tagsEl.style.gap = '4px';
		tagsEl.style.flexWrap = 'wrap';

		const tagList = (pkg.tags ?? []).slice(0, 3);
		if (pkg.category && !tagList.includes(pkg.category)) {
			tagList.unshift(pkg.category);
		}
		for (const tag of tagList) {
			const badge = $('span');
			badge.textContent = tag;
			badge.style.fontSize = '10px';
			badge.style.padding = '1px 8px';
			badge.style.borderRadius = '10px';
			badge.style.background = 'rgba(56,139,253,0.12)';
			badge.style.color = 'var(--vscode-textLink-foreground)';
			tagsEl.appendChild(badge);
		}
		footer.appendChild(tagsEl);

		// Action buttons
		const actions = $('div');
		actions.style.display = 'flex';
		actions.style.gap = '6px';

		if (isInstalling) {
			const loadingBadge = $('span');
			loadingBadge.textContent = '\u{23F3} 安装中';
			loadingBadge.style.fontSize = '11px';
			loadingBadge.style.padding = '3px 10px';
			loadingBadge.style.borderRadius = '4px';
			loadingBadge.style.background = 'rgba(14,99,156,0.15)';
			loadingBadge.style.color = 'var(--vscode-button-background)';
			actions.appendChild(loadingBadge);
		} else if (!isInstalled) {
			const installBtn = $('button') as HTMLButtonElement;
			installBtn.textContent = '\u2B07 安装';
			installBtn.style.fontSize = '11px';
			installBtn.style.padding = '3px 10px';
			installBtn.style.background = 'var(--vscode-button-background)';
			installBtn.style.color = 'var(--vscode-button-foreground)';
			installBtn.style.border = 'none';
			installBtn.style.borderRadius = '4px';
			installBtn.style.cursor = 'pointer';
			installBtn.style.whiteSpace = 'nowrap';
			installBtn.onclick = async (e) => {
				e.stopPropagation();
				await this._installPackage(pkg);
			};
			actions.appendChild(installBtn);
		} else {
			// Installed: show upgrade button (if available) + delete button
			if (upgrade) {
				const upgradeBtn = $('button') as HTMLButtonElement;
				upgradeBtn.textContent = `\u2B06 升级`;
				upgradeBtn.title = `升级到 v${upgrade.latest}`;
				upgradeBtn.style.fontSize = '11px';
				upgradeBtn.style.padding = '3px 10px';
				upgradeBtn.style.background = 'rgba(210,153,34,0.18)';
				upgradeBtn.style.color = 'var(--vscode-editorWarning-foreground, #d29922)';
				upgradeBtn.style.border = '1px solid rgba(210,153,34,0.4)';
				upgradeBtn.style.borderRadius = '4px';
				upgradeBtn.style.cursor = 'pointer';
				upgradeBtn.style.whiteSpace = 'nowrap';
				upgradeBtn.onclick = async (e) => {
					e.stopPropagation();
					await this._upgradePackage(pkg, upgrade);
				};
				actions.appendChild(upgradeBtn);
			} else {
				const installedBadge = $('span');
				installedBadge.textContent = '\u2713 已安装';
				installedBadge.style.fontSize = '11px';
				installedBadge.style.padding = '3px 10px';
				installedBadge.style.borderRadius = '4px';
				installedBadge.style.background = 'rgba(137,209,133,0.12)';
				installedBadge.style.color = 'var(--vscode-testing-iconPassed, #89d185)';
				installedBadge.style.border = '1px solid rgba(137,209,133,0.3)';
				actions.appendChild(installedBadge);
			}

			const deleteBtn = $('button') as HTMLButtonElement;
			deleteBtn.textContent = '\u{1F5D1} 删除';
			deleteBtn.style.fontSize = '11px';
			deleteBtn.style.padding = '3px 10px';
			deleteBtn.style.background = 'rgba(248,81,73,0.12)';
			deleteBtn.style.color = '#f85149';
			deleteBtn.style.border = '1px solid rgba(248,81,73,0.3)';
			deleteBtn.style.borderRadius = '4px';
			deleteBtn.style.cursor = 'pointer';
			deleteBtn.style.whiteSpace = 'nowrap';
			deleteBtn.onclick = async (e) => {
				e.stopPropagation();
				await this._uninstallPackage(pkg);
			};
			actions.appendChild(deleteBtn);
		}

		footer.appendChild(actions);
		card.appendChild(footer);
		return card;
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  ACTIONS
	// ══════════════════════════════════════════════════════════════════════════

	/** Open the MCP detail in a separate ResourceManagerEditorPane window */
	private async _openInResourceManager(pkg: IMarketplacePackage): Promise<void> {
		const input = ResourceManagerEditorInput.getInstance();
		const pane = await this.editorService.openEditor(input, { pinned: true });
		const control = pane?.getControl();
		if (control instanceof ResourceManagerEditorPane) {
			control.showMarketplacePackage(pkg);
		}
	}

	/** Sync a single MCP server config from ~/.vssaros/saros/mcp/{slug}/config.json to VS Code MCP config */
	private async _syncMcpToVsCode(slug: string): Promise<void> {
		try {
			const configUri = resolveSarosPath(this._getSarosRoot(), SarosPath.mcp, slug, 'config.json');
			if (!await this.fileService.exists(configUri)) {
				console.warn('[McpServerEditor] config.json not found for slug:', slug);
				return;
			}
			const content = await this.fileService.readFile(configUri);
			const config = JSON.parse(content.value.toString());

			// Build IMcpServerConfiguration from config.json
			const transport = config.transport || 'stdio';
			let serverConfig: IMcpServerConfiguration;
			if (transport === 'stdio') {
				serverConfig = {
					type: McpServerType.LOCAL,
					command: config.command || '',
					...(config.args ? { args: config.args } : {}),
					...(config.env ? { env: config.env } : {}),
				};
			} else {
				serverConfig = {
					type: McpServerType.REMOTE,
					url: config.url || '',
					...(config.headers ? { headers: config.headers } : {}),
				};
			}

			const installable: IInstallableMcpServer = { name: slug, config: serverConfig };
			await this.mcpManagementService.install(installable);
			console.log('[McpServerEditor] Synced MCP server to VS Code config:', slug);
		} catch (e) {
			console.warn('[McpServerEditor] Failed to sync MCP to VS Code config (non-fatal):', e);
		}
	}

	/** Install a marketplace MCP package */
	private async _installPackage(pkg: IMarketplacePackage): Promise<void> {
		if (this._installingSlugs.has(pkg.slug)) { return; }
		this._installingSlugs.add(pkg.slug);
		this._renderGrid();

		try {
			const result = await this.marketplaceService.download(pkg.slug, pkg.latestVersion ?? '', 'mcp');
			// Sync to VS Code MCP config so mcpService.servers discovers it
			await this._syncMcpToVsCode(pkg.slug);
			this.notificationService.info(`\u2705 ${pkg.name} v${result.version} 安装成功`);
			this.eventBridgeService.emit('mcp:servers-changed', { action: 'add', presetId: pkg.slug });
			await this._loadPackages();
		} catch (err) {
			this.notificationService.error(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._installingSlugs.delete(pkg.slug);
			this._renderGrid();
		}
	}

	/** Upgrade an installed MCP package to the latest version */
	private async _upgradePackage(pkg: IMarketplacePackage, upgrade: IUpgradeInfo): Promise<void> {
		if (this._installingSlugs.has(pkg.slug)) { return; }
		this._installingSlugs.add(pkg.slug);
		this._renderGrid();

		try {
			const result = await this.marketplaceService.download(pkg.slug, upgrade.latest, 'mcp');
			// Sync updated config to VS Code MCP config
			await this._syncMcpToVsCode(pkg.slug);
			this.notificationService.info(`\u2705 ${pkg.name} 已升级到 v${result.version}`);
			this.eventBridgeService.emit('mcp:servers-changed', { action: 'add', presetId: pkg.slug });
			await this._loadPackages();
		} catch (err) {
			this.notificationService.error(`升级失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._installingSlugs.delete(pkg.slug);
			this._renderGrid();
		}
	}

	/** Uninstall an installed MCP package (remove mcp.json entry, dir, installed record) */
	private async _uninstallPackage(pkg: IMarketplacePackage): Promise<void> {
		const confirmed = await this.dialogService.confirm({
			message: `确定要卸载 MCP 服务器 "${pkg.name}" 吗？`,
			primaryButton: '卸载',
			cancelButton: '取消',
		});
		if (!confirmed.confirmed) { return; }

		try {
			// 1. Remove entry from ~/.vssaros/saros/mcp.json
			await this._removeMcpJsonEntry(pkg.slug);

			// 2. Delete ~/.vssaros/saros/mcp/{slug}/ directory
			const mcpDirUri = resolveSarosPath(this._getSarosRoot(), SarosPath.mcp, pkg.slug);
			if (await this.fileService.exists(mcpDirUri)) {
				await this.fileService.del(mcpDirUri, { recursive: true });
			}

			// 3. Remove from installed-packages.json
			await this._removeInstalledEntry(pkg.slug);

			// 4. Uninstall from VS Code MCP config (if registered there)
			try {
				const installed = await this.mcpManagementService.getInstalled();
				const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
				const match = installed.find(s => s.name === pkg.slug || s.name === pkg.name || sanitize(s.name) === sanitize(pkg.slug));
				if (match) {
					await this.mcpManagementService.uninstall(match);
				}
			} catch (e) {
				console.warn('[McpServerEditor] mcpManagementService.uninstall failed (may not be registered):', e);
			}

			this.notificationService.info(`\u2705 ${pkg.name} 已卸载`);
			const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
			this.eventBridgeService.emit('mcp:servers-changed', { action: 'remove', serverId: sanitize(pkg.slug) });
			await this._loadPackages();
		} catch (err) {
			this.notificationService.error(`卸载失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  + ADD SERVER → OPEN ~/.vssaros/saros/mcp.json FILE
	// ══════════════════════════════════════════════════════════════════════════

	private async _openMcpJsonFile(): Promise<void> {
		try {
			const mcpJsonUri = await this._getMcpJsonUri();

			// Ensure file exists with default content if missing
			if (!await this.fileService.exists(mcpJsonUri)) {
				await this.fileService.createFolder(URI.joinPath(mcpJsonUri, '..'));
				await this.fileService.writeFile(mcpJsonUri, VSBuffer.fromString(JSON.stringify({ servers: {} }, null, 2)));
			}

			await this.editorService.openEditor({ resource: mcpJsonUri, options: { pinned: true } });
		} catch (err) {
			this.notificationService.error(`无法打开 mcp.json: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  FILE HELPERS (~/.vssaros/saros/mcp.json + installed-packages.json)
	// ══════════════════════════════════════════════════════════════════════════

	/** Get ~/.vssaros/saros/mcp.json URI */
	private async _getMcpJsonUri(): Promise<URI> {
		return resolveSarosPath(this._getSarosRoot(), SarosPath.mcpConfig);
	}

	/** Get ~/.vssaros/saros/installed-packages.json URI */
	private async _getInstalledPackagesUri(): Promise<URI> {
		return resolveSarosPath(this._getSarosRoot(), SarosPath.installedPackages);
	}

	/** Read installed MCP entries (slug → version) from installed-packages.json */
	private async _readInstalledMcps(): Promise<Map<string, string>> {
		const map = new Map<string, string>();
		try {
			const uri = await this._getInstalledPackagesUri();
			if (!await this.fileService.exists(uri)) { return map; }
			const content = await this.fileService.readFile(uri);
			const entries: IInstalledEntry[] = JSON.parse(content.value.toString());
			for (const e of entries) {
				if (e.kind === 'mcp') {
					map.set(e.storeId, e.version);
				}
			}
		} catch (e) {
			console.warn('[McpServerEditor] Failed to read installed-packages.json:', e);
		}
		return map;
	}

	/** Remove a single MCP entry from installed-packages.json */
	private async _removeInstalledEntry(slug: string): Promise<void> {
		try {
			const uri = await this._getInstalledPackagesUri();
			if (!await this.fileService.exists(uri)) { return; }
			const content = await this.fileService.readFile(uri);
			const entries: IInstalledEntry[] = JSON.parse(content.value.toString());
			const filtered = entries.filter(e => !(e.kind === 'mcp' && e.storeId === slug));
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(filtered, null, 2)));
		} catch (e) {
			console.warn('[McpServerEditor] Failed to remove installed entry:', e);
		}
	}

	/** Remove a single server entry from ~/.vssaros/saros/mcp.json */
	private async _removeMcpJsonEntry(name: string): Promise<void> {
		try {
			const uri = await this._getMcpJsonUri();
			if (!await this.fileService.exists(uri)) { return; }
			const content = await this.fileService.readFile(uri);
			const data = JSON.parse(content.value.toString());
			if (!data?.servers || !(name in data.servers)) { return; }
			delete data.servers[name];
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(data, null, 2)));
		} catch (e) {
			console.warn('[McpServerEditor] Failed to remove mcp.json entry:', e);
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  HELPERS
	// ══════════════════════════════════════════════════════════════════════════

	private _formatCount(n: number): string {
		if (n >= 10000) { return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}w`; }
		if (n >= 1000) { return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`; }
		return String(n);
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}
}
