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
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { SkillMarketEditorInput } from './skillMarketEditorInput.js';
import { ResourceManagerEditorInput } from './resourceManagerEditorInput.js';
import { ResourceManagerEditorPane } from './resourceManagerEditorPane.js';
import { IMarketplaceService, IMarketplacePackage } from '../common/marketplace.js';
import { ISkillRegistry } from '../common/skills.js';
import { ISkillInstallService, ISkillFolderUploadFile } from '../common/skillHubTypes.js';

// ─── EditorPane ──────────────────────────────────────────────────────────────

export class SkillMarketEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.skillMarket';

	private _container!: HTMLElement;
	private _gridEl!: HTMLElement;
	private _countEl!: HTMLElement;
	private _searchInput!: HTMLInputElement;

	// Data
	private _packages: readonly IMarketplacePackage[] = [];
	private _loading = false;
	private _installingSlugs = new Set<string>();
	private _searchQuery = '';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notificationService: INotificationService,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@ISkillInstallService private readonly skillInstallService: ISkillInstallService,
	) {
		super(SkillMarketEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = $('div.skill-market-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		this._container.style.overflow = 'hidden';
		this._container.style.fontSize = '13px';
		parent.appendChild(this._container);

		// Listen for skill changes to refresh installed state
		this._register(this.skillRegistry.onDidChangeSkills(() => {
			this._renderGrid();
		}));
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof SkillMarketEditorInput)) { return; }

		// Only build UI and load data on first open; don't reload on tab switch
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

		// ── Header ──────────────────────────────────────────────────
		const header = $('div.sm-header');
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.gap = '12px';
		header.style.padding = '10px 16px';
		header.style.background = 'var(--vscode-sideBar-background, #252526)';
		header.style.borderBottom = '1px solid var(--vscode-panel-border)';
		header.style.flexShrink = '0';

		const title = $('h1');
		title.textContent = '\u{1F9E9} Skill Marketplace';
		title.style.fontSize = '14px';
		title.style.fontWeight = '600';
		title.style.margin = '0';
		title.style.color = 'var(--vscode-foreground)';
		title.style.whiteSpace = 'nowrap';
		header.appendChild(title);

		// Search
		const searchWrap = $('div');
		searchWrap.style.flex = '1';
		searchWrap.style.maxWidth = '360px';
		searchWrap.style.display = 'flex';
		searchWrap.style.alignItems = 'center';
		searchWrap.style.gap = '6px';
		searchWrap.style.background = 'var(--vscode-input-background)';
		searchWrap.style.border = '1px solid var(--vscode-input-border)';
		searchWrap.style.borderRadius = '6px';
		searchWrap.style.padding = '4px 10px';

		const searchIcon = $('span');
		searchIcon.textContent = '\u{1F50D}';
		searchIcon.style.fontSize = '12px';
		searchIcon.style.opacity = '0.6';
		searchWrap.appendChild(searchIcon);

		this._searchInput = $('input') as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.placeholder = '搜索技能...';
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
		header.appendChild(searchWrap);

		// Action buttons
		const actions = $('div');
		actions.style.display = 'flex';
		actions.style.gap = '8px';
		actions.style.marginLeft = 'auto';

		// Refresh button
		const refreshBtn = $('button') as HTMLButtonElement;
		refreshBtn.textContent = '\u{1F504}';
		refreshBtn.title = '刷新技能列表';
		refreshBtn.style.padding = '4px 8px';
		refreshBtn.style.fontSize = '12px';
		refreshBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		refreshBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		refreshBtn.style.border = '1px solid var(--vscode-panel-border)';
		refreshBtn.style.borderRadius = '6px';
		refreshBtn.style.cursor = 'pointer';
		refreshBtn.onclick = () => { void this._loadPackages(); };
		actions.appendChild(refreshBtn);

		const folderBtn = $('button') as HTMLButtonElement;
		folderBtn.textContent = '\u{1F5C2} 从文件夹安装';
		folderBtn.title = '选择包含 SKILL.md 的技能文件夹，整体复制到 ~/.vssaros/skills（过滤 .git/__pycache__ 等并初始化 .git）';
		folderBtn.style.padding = '4px 12px';
		folderBtn.style.fontSize = '12px';
		folderBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		folderBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		folderBtn.style.border = '1px solid var(--vscode-panel-border)';
		folderBtn.style.borderRadius = '6px';
		folderBtn.style.cursor = 'pointer';
		folderBtn.style.whiteSpace = 'nowrap';
		folderBtn.onclick = () => this._showFolderInstallDialog();
		actions.appendChild(folderBtn);

		const urlBtn = $('button') as HTMLButtonElement;
		urlBtn.textContent = '\u{1F517} 从 URL 安装';
		urlBtn.style.padding = '4px 12px';
		urlBtn.style.fontSize = '12px';
		urlBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		urlBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		urlBtn.style.border = '1px solid var(--vscode-panel-border)';
		urlBtn.style.borderRadius = '6px';
		urlBtn.style.cursor = 'pointer';
		urlBtn.style.whiteSpace = 'nowrap';
		urlBtn.onclick = () => this._showUrlInstallDialog();
		actions.appendChild(urlBtn);

		header.appendChild(actions);
		this._container.appendChild(header);

		// ── Grid scroll area ────────────────────────────────────────
		const scrollArea = $('div.sm-grid-scroll');
		scrollArea.style.flex = '1';
		scrollArea.style.overflowY = 'auto';
		scrollArea.style.padding = '16px 20px';

		// Section title
		const sectionTitle = $('div');
		sectionTitle.style.display = 'flex';
		sectionTitle.style.alignItems = 'center';
		sectionTitle.style.gap = '8px';
		sectionTitle.style.marginBottom = '14px';

		const titleText = $('span');
		titleText.textContent = '\u{1F4E6} 商城技能 ';
		titleText.style.fontSize = '14px';
		titleText.style.fontWeight = '600';
		titleText.style.color = 'var(--vscode-foreground)';
		sectionTitle.appendChild(titleText);

		this._countEl = $('span');
		this._countEl.style.fontSize = '12px';
		this._countEl.style.color = 'var(--vscode-textLink-foreground)';
		sectionTitle.appendChild(this._countEl);
		scrollArea.appendChild(sectionTitle);

		// Grid container
		this._gridEl = $('div.sm-grid');
		this._gridEl.style.display = 'grid';
		this._gridEl.style.gridTemplateColumns = 'repeat(auto-fill, minmax(260px, 1fr))';
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

		// Show loading state
		clearNode(this._gridEl);
		const loading = $('div');
		loading.style.gridColumn = '1 / -1';
		loading.style.textAlign = 'center';
		loading.style.padding = '40px';
		loading.style.color = 'var(--vscode-descriptionForeground)';
		loading.textContent = '\u23F3 加载中...';
		this._gridEl.appendChild(loading);
		this._countEl.textContent = '';

		try {
			const result = await this.marketplaceService.listPackages({ kind: 'skill' });
			// 过滤内置技能：商城不展示已随产品内置的技能
			const builtinSkillIds = new Set(
				this.skillRegistry.getSkills()
					.filter(s => s.source === 'builtin')
					.map(s => s.id)
			);
			this._packages = result.items.filter(pkg =>
				!builtinSkillIds.has(pkg.slug) && !builtinSkillIds.has(pkg.id)
			);
			this._renderGrid();
		} catch (err) {
			console.error('[SkillMarket] Failed to load packages:', err);
			clearNode(this._gridEl);
			const errEl = $('div');
			errEl.style.gridColumn = '1 / -1';
			errEl.style.textAlign = 'center';
			errEl.style.padding = '40px';
			errEl.style.color = 'var(--vscode-errorForeground)';
			const rawMsg = err instanceof Error ? err.message : String(err);
			const isNetworkError = /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(rawMsg);
			errEl.textContent = isNetworkError
				? '无法连接到商城服务器，请检查网络或服务器状态后重试'
				: `加载失败: ${rawMsg}`;
			const retryBtn = $('button');
			retryBtn.textContent = '🔄 重试';
			retryBtn.style.marginTop = '12px';
			retryBtn.style.cursor = 'pointer';
			retryBtn.onclick = () => this._loadPackages();
			errEl.appendChild(document.createElement('br'));
			errEl.appendChild(retryBtn);
			this._gridEl.appendChild(errEl);
		} finally {
			this._loading = false;
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  RENDER
	// ══════════════════════════════════════════════════════════════════════════

	private _renderGrid(): void {
		if (!this._gridEl) { return; }
		clearNode(this._gridEl);

		// Build installed lookup: match by id, slug, or name (case-insensitive)
		const installedSkills = this.skillRegistry.getSkills();
		const installedIds = new Set(installedSkills.map(s => s.id));
		const installedNames = new Set(installedSkills.map(s => s.name.toLowerCase()));

		// Apply search filter
		let items = this._packages;
		if (this._searchQuery) {
			items = items.filter(p =>
				p.name.toLowerCase().includes(this._searchQuery) ||
				(p.description ?? '').toLowerCase().includes(this._searchQuery) ||
				(p.tags ?? []).some(t => t.toLowerCase().includes(this._searchQuery))
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
				? `没有匹配 "${this._searchQuery}" 的技能`
				: '暂无可安装的技能';
			this._gridEl.appendChild(empty);
			return;
		}

		for (const pkg of items) {
			this._gridEl.appendChild(this._createCard(pkg, installedIds, installedNames));
		}
	}

	private _createCard(pkg: IMarketplacePackage, installedIds: Set<string>, installedNames: Set<string>): HTMLElement {
		// Match by id, slug, or name (case-insensitive) to handle ID mismatch
		const isInstalled = installedIds.has(pkg.slug) || installedIds.has(pkg.id) || installedNames.has(pkg.name.toLowerCase());
		const isInstalling = this._installingSlugs.has(pkg.slug);

		const card = $('div.sm-card');
		card.style.background = 'var(--vscode-sideBar-background, #252526)';
		card.style.border = '1px solid var(--vscode-panel-border)';
		card.style.borderRadius = '8px';
		card.style.padding = '14px';
		card.style.cursor = 'pointer';
		card.style.transition = 'all 0.15s';
		card.style.display = 'flex';
		card.style.flexDirection = 'column';
		card.style.gap = '10px';

		card.onmouseenter = () => {
			card.style.background = 'var(--vscode-list-hoverBackground)';
			card.style.borderColor = 'var(--vscode-button-background)';
		};
		card.onmouseleave = () => {
			card.style.background = 'var(--vscode-sideBar-background, #252526)';
			card.style.borderColor = 'var(--vscode-panel-border)';
		};

		// Click card → open ResourceManagerEditorPane
		card.onclick = () => this._openInResourceManager(pkg);

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
		icon.textContent = pkg.icon || '\u{1F4A1}';
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
			badge.style.background = 'rgba(56,139,253,0.1)';
			badge.style.color = 'var(--vscode-textLink-foreground)';
			tagsEl.appendChild(badge);
		}
		footer.appendChild(tagsEl);

		// Action button
		if (isInstalled) {
			// Show delete button for installed skills
			const deleteBtn = $('button') as HTMLButtonElement;
			deleteBtn.textContent = '\u2715 删除';
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
			footer.appendChild(deleteBtn);
		} else if (isInstalling) {
			const loadingBadge = $('span');
			loadingBadge.textContent = '\u23F3 安装中';
			loadingBadge.style.fontSize = '11px';
			loadingBadge.style.padding = '3px 10px';
			loadingBadge.style.borderRadius = '4px';
			loadingBadge.style.background = 'rgba(14,99,156,0.15)';
			loadingBadge.style.color = 'var(--vscode-button-background)';
			footer.appendChild(loadingBadge);
		} else {
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
			footer.appendChild(installBtn);
		}

		card.appendChild(footer);
		return card;
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  ACTIONS
	// ══════════════════════════════════════════════════════════════════════════

	/** Open the skill detail in a separate ResourceManagerEditorPane */
	private async _openInResourceManager(pkg: IMarketplacePackage): Promise<void> {
		const input = ResourceManagerEditorInput.getInstance();
		const pane = await this.editorService.openEditor(input, { pinned: true });
		const control = pane?.getControl();
		if (control instanceof ResourceManagerEditorPane) {
			control.showMarketplacePackage(pkg);
		}
	}

	/** Install a marketplace skill package */
	private async _installPackage(pkg: IMarketplacePackage): Promise<void> {
		if (this._installingSlugs.has(pkg.slug)) { return; }
		this._installingSlugs.add(pkg.slug);
		this._renderGrid();

		try {
			const result = await this.marketplaceService.download(pkg.slug, pkg.latestVersion ?? '', 'skill');
			await this.skillRegistry.reload();
			this.notificationService.info(`\u2705 ${pkg.name} v${result.version} 安装成功`);
		} catch (err) {
			this.notificationService.error(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._installingSlugs.delete(pkg.slug);
			this._renderGrid();
		}
	}

	/** Uninstall a skill package */
	private async _uninstallPackage(pkg: IMarketplacePackage): Promise<void> {
		// Find the installed skill by slug, id, or name
		const skills = this.skillRegistry.getSkills();
		const skill = skills.find(s => s.id === pkg.slug || s.id === pkg.id || s.name.toLowerCase() === pkg.name.toLowerCase());
		if (!skill) {
			this.notificationService.warn(`未找到已安装的技能: ${pkg.name}`);
			return;
		}

		const confirmed = await this.dialogService.confirm({
			message: `确定要卸载技能 "${pkg.name}" 吗？`,
			primaryButton: '卸载',
			cancelButton: '取消',
		});
		if (!confirmed.confirmed) { return; }

		try {
			const success = await this.skillInstallService.uninstallSkill(skill.id);
			if (!success) {
				this.notificationService.error(`卸载失败：无法卸载技能 "${pkg.name}"（可能不支持该来源的技能卸载）`);
				return;
			}
			await this.skillRegistry.reload();
			this.notificationService.info(`\u2705 ${pkg.name} 已卸载`);
			this._renderGrid();
		} catch (err) {
			this.notificationService.error(`卸载失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  INSTALL DIALOGS
	// ══════════════════════════════════════════════════════════════════════════

	private _showFolderInstallDialog(): void {
		// 用 Chromium 原生 webkitdirectory 选择文件夹（沙箱安全，不依赖原生对话框 IPC）
		const input = $('input') as HTMLInputElement;
		input.type = 'file';
		input.style.display = 'none';
		input.setAttribute('webkitdirectory', '');
		input.onchange = async () => {
			const fileList = input.files;
			input.remove();
			if (!fileList || fileList.length === 0) { return; }
			const files: ISkillFolderUploadFile[] = [];
			for (const file of Array.from(fileList)) {
				// webkitRelativePath 形如 "<文件夹>/SKILL.md"，去掉首段根文件夹名
				const rawPath = file.webkitRelativePath || file.name;
				const relativePath = rawPath.includes('/') ? rawPath.split('/').slice(1).join('/') : file.name;
				const data = new Uint8Array(await file.arrayBuffer());
				files.push({ relativePath, data });
			}
			const result = await this.skillInstallService.installFromFolderUpload(files);
			if (result.success) {
				this.notificationService.info(`已安装技能 "${result.skillName}"`);
				this._renderGrid();
			} else {
				await this.dialogService.info('安装失败', result.error ?? '未知错误');
			}
		};
		this._container.appendChild(input);
		input.click();
	}

	private _showUrlInstallDialog(): void {
		const overlay = $('div');
		overlay.style.position = 'absolute';
		overlay.style.inset = '0';
		overlay.style.background = 'rgba(0,0,0,0.5)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '1000';
		overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); } };

		const dialog = $('div');
		dialog.style.background = 'var(--vscode-editor-background)';
		dialog.style.border = '1px solid var(--vscode-panel-border)';
		dialog.style.borderRadius = '8px';
		dialog.style.width = '460px';
		dialog.style.maxWidth = '90vw';
		dialog.style.boxShadow = '0 8px 32px rgba(0,0,0,0.4)';
		dialog.onclick = (e) => e.stopPropagation();

		// Header
		const head = $('div');
		head.style.display = 'flex';
		head.style.alignItems = 'center';
		head.style.justifyContent = 'space-between';
		head.style.padding = '14px 18px';
		head.style.borderBottom = '1px solid var(--vscode-panel-border)';

		const title = $('span');
		title.textContent = '\u{1F517} 从 URL 安装';
		title.style.fontSize = '14px';
		title.style.fontWeight = '600';
		head.appendChild(title);

		const closeBtn = $('button') as HTMLButtonElement;
		closeBtn.textContent = '\u2715';
		closeBtn.style.background = 'none';
		closeBtn.style.border = 'none';
		closeBtn.style.color = 'var(--vscode-descriptionForeground)';
		closeBtn.style.cursor = 'pointer';
		closeBtn.style.fontSize = '16px';
		closeBtn.onclick = () => overlay.remove();
		head.appendChild(closeBtn);
		dialog.appendChild(head);

		// Body
		const body = $('div');
		body.style.padding = '18px';

		const urlInput = $('input') as HTMLInputElement;
		urlInput.type = 'text';
		urlInput.placeholder = 'https://raw.githubusercontent.com/.../SKILL.md';
		urlInput.style.width = '100%';
		urlInput.style.padding = '6px 10px';
		urlInput.style.background = 'var(--vscode-input-background)';
		urlInput.style.border = '1px solid var(--vscode-input-border)';
		urlInput.style.borderRadius = '4px';
		urlInput.style.color = 'var(--vscode-input-foreground)';
		urlInput.style.fontSize = '12px';
		urlInput.style.outline = 'none';
		urlInput.style.boxSizing = 'border-box';
		body.appendChild(urlInput);

		const hint = $('div');
		hint.textContent = '支持 SKILL.md 文件 URL 或 Zip 包下载链接';
		hint.style.fontSize = '11px';
		hint.style.color = 'var(--vscode-descriptionForeground)';
		hint.style.marginTop = '8px';
		body.appendChild(hint);

		// Third-party skill hub links
		const hubSection = $('div');
		hubSection.style.marginTop = '14px';
		hubSection.style.paddingTop = '12px';
		hubSection.style.borderTop = '1px solid var(--vscode-panel-border)';

		const hubLabel = $('div');
		hubLabel.textContent = '\u{1F310} 第三方 Skill Hub：';
		hubLabel.style.fontSize = '11px';
		hubLabel.style.color = 'var(--vscode-descriptionForeground)';
		hubLabel.style.marginBottom = '6px';
		hubSection.appendChild(hubLabel);

		const hubLinks = $('div');
		hubLinks.style.display = 'flex';
		hubLinks.style.flexWrap = 'wrap';
		hubLinks.style.gap = '6px';

		const hubs = [
			{ name: 'Knot Skills', url: 'https://knot.woa.com/skills' },
			{ name: 'GitHub', url: 'https://github.com/topics/skill-md' },
			{ name: 'Anthropic Skills', url: 'https://github.com/anthropics/anthropic-cookbook/tree/main/skills' },
		];

		for (const hub of hubs) {
			const link = $('a') as HTMLAnchorElement;
			link.textContent = hub.name;
			link.href = hub.url;
			link.style.fontSize = '11px';
			link.style.padding = '2px 10px';
			link.style.borderRadius = '10px';
			link.style.background = 'rgba(56,139,253,0.1)';
			link.style.color = 'var(--vscode-textLink-foreground)';
			link.style.textDecoration = 'none';
			link.style.cursor = 'pointer';
			link.style.whiteSpace = 'nowrap';
			link.onclick = (e) => {
				e.preventDefault();
				urlInput.value = hub.url;
				urlInput.focus();
			};
			hubLinks.appendChild(link);
		}
		hubSection.appendChild(hubLinks);

		const hubHint = $('div');
		hubHint.textContent = '点击链接填充 URL，或在外部浏览器中打开浏览可用的技能';
		hubHint.style.fontSize = '10px';
		hubHint.style.color = 'var(--vscode-descriptionForeground)';
		hubHint.style.marginTop = '6px';
		hubHint.style.opacity = '0.7';
		hubSection.appendChild(hubHint);

		body.appendChild(hubSection);
		dialog.appendChild(body);

		// Actions
		const actions = $('div');
		actions.style.display = 'flex';
		actions.style.gap = '10px';
		actions.style.justifyContent = 'flex-end';
		actions.style.padding = '0 18px 18px';

		const cancelBtn = $('button') as HTMLButtonElement;
		cancelBtn.textContent = '取消';
		cancelBtn.style.padding = '6px 14px';
		cancelBtn.style.fontSize = '12px';
		cancelBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		cancelBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		cancelBtn.style.border = '1px solid var(--vscode-panel-border)';
		cancelBtn.style.borderRadius = '4px';
		cancelBtn.style.cursor = 'pointer';
		cancelBtn.onclick = () => overlay.remove();
		actions.appendChild(cancelBtn);

		const installBtn = $('button') as HTMLButtonElement;
		installBtn.textContent = '下载并安装';
		installBtn.style.padding = '6px 14px';
		installBtn.style.fontSize = '12px';
		installBtn.style.background = 'var(--vscode-button-background)';
		installBtn.style.color = 'var(--vscode-button-foreground)';
		installBtn.style.border = 'none';
		installBtn.style.borderRadius = '4px';
		installBtn.style.cursor = 'pointer';
		installBtn.onclick = async () => {
			const url = urlInput.value.trim();
			if (!url) { return; }
			installBtn.textContent = '安装中...';
			installBtn.disabled = true;
			try {
				const response = await fetch(url);
				if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
				const content = await response.text();
				const result = await this.skillInstallService.installFromContent(content);
				if (result.success) {
					overlay.remove();
					void this.skillRegistry.reload();
					this._renderGrid();
				} else {
					throw new Error(result.error ?? '未知错误');
				}
			} catch (err) {
				installBtn.textContent = '下载并安装';
				installBtn.disabled = false;
				this.notificationService.error(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
			}
		};
		actions.appendChild(installBtn);
		dialog.appendChild(actions);

		overlay.appendChild(dialog);
		this._container.appendChild(overlay);
		urlInput.focus();
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  HELPERS
	// ══════════════════════════════════════════════════════════════════════════

	private _formatCount(n: number): string {
		if (n >= 10000) { return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}w`; }
		if (n >= 1000) { return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`; }
		return String(n);
	}
}
