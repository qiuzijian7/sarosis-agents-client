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
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { WorkflowMarketEditorInput } from './workflowMarketEditorInput.js';
import { IMarketplaceService, IMarketplacePackage } from '../common/marketplace.js';
import { IWorkflowStorageService, IStoredWorkflow } from '../common/workflowStorage.js';

export class WorkflowMarketEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.workflowMarket';

	private _container!: HTMLElement;
	private _gridEl!: HTMLElement;
	private _countEl!: HTMLElement;
	private _searchInput!: HTMLInputElement;

	private _packages: readonly IMarketplacePackage[] = [];
	private _loading = false;
	private _installingSlugs = new Set<string>();
	private _installedWorkflowIds = new Set<string>();
	private _searchQuery = '';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@IWorkflowStorageService private readonly workflowStorage: IWorkflowStorageService,
	) {
		super(WorkflowMarketEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = $('div.workflow-market-editor');
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
		if (!(input instanceof WorkflowMarketEditorInput)) { return; }

		if (this._container.childElementCount === 0) {
			this._buildUI();
			await this._loadPackages();
		}
	}

	override layout(dimension: Dimension): void {
		this._container.style.width = `${dimension.width}px`;
		this._container.style.height = `${dimension.height}px`;
	}

	// ─── UI Build ───────────────────────────────────────────────

	private _buildUI(): void {
		clearNode(this._container);

		// Header
		const header = $('div.wfm-header');
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.gap = '12px';
		header.style.padding = '10px 16px';
		header.style.background = 'var(--vscode-sideBar-background, #252526)';
		header.style.borderBottom = '1px solid var(--vscode-panel-border)';
		header.style.flexShrink = '0';

		const title = $('h1');
		title.textContent = '🔀 Workflow Marketplace';
		title.style.fontSize = '14px';
		title.style.fontWeight = '600';
		title.style.margin = '0';
		title.style.color = 'var(--vscode-foreground)';
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
		searchIcon.textContent = '🔍';
		searchIcon.style.fontSize = '12px';
		searchIcon.style.opacity = '0.6';
		searchWrap.appendChild(searchIcon);

		this._searchInput = $('input') as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.placeholder = '搜索工作流...';
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

		// Refresh button
		const actions = $('div');
		actions.style.display = 'flex';
		actions.style.gap = '8px';
		actions.style.marginLeft = 'auto';

		const refreshBtn = $('button') as HTMLButtonElement;
		refreshBtn.textContent = '🔄';
		refreshBtn.title = '刷新';
		refreshBtn.style.padding = '4px 8px';
		refreshBtn.style.fontSize = '12px';
		refreshBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		refreshBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		refreshBtn.style.border = '1px solid var(--vscode-panel-border)';
		refreshBtn.style.borderRadius = '6px';
		refreshBtn.style.cursor = 'pointer';
		refreshBtn.onclick = () => { void this._loadPackages(); };
		actions.appendChild(refreshBtn);

		header.appendChild(actions);
		this._container.appendChild(header);

		// Grid area
		const scrollArea = $('div.wfm-grid-scroll');
		scrollArea.style.flex = '1';
		scrollArea.style.overflowY = 'auto';
		scrollArea.style.padding = '16px 20px';

		const sectionTitle = $('div');
		sectionTitle.style.display = 'flex';
		sectionTitle.style.alignItems = 'center';
		sectionTitle.style.gap = '8px';
		sectionTitle.style.marginBottom = '14px';

		const titleText = $('span');
		titleText.textContent = '🔀 商城工作流 ';
		titleText.style.fontSize = '14px';
		titleText.style.fontWeight = '600';
		sectionTitle.appendChild(titleText);

		this._countEl = $('span');
		this._countEl.style.fontSize = '12px';
		this._countEl.style.color = 'var(--vscode-textLink-foreground)';
		sectionTitle.appendChild(this._countEl);
		scrollArea.appendChild(sectionTitle);

		this._gridEl = $('div.wfm-grid');
		this._gridEl.style.display = 'grid';
		this._gridEl.style.gridTemplateColumns = 'repeat(auto-fill, minmax(260px, 1fr))';
		this._gridEl.style.gap = '12px';
		scrollArea.appendChild(this._gridEl);

		this._container.appendChild(scrollArea);
	}

	// ─── Data ──────────────────────────────────────────────────

	private async _loadPackages(): Promise<void> {
		if (this._loading) { return; }
		this._loading = true;

		clearNode(this._gridEl);
		const loading = $('div');
		loading.style.gridColumn = '1 / -1';
		loading.style.textAlign = 'center';
		loading.style.padding = '40px';
		loading.style.color = 'var(--vscode-descriptionForeground)';
		loading.textContent = '⏳ 加载中...';
		this._gridEl.appendChild(loading);
		this._countEl.textContent = '';

		try {
			// 加载商城包和已安装工作流
			const [result, installedWorkflows] = await Promise.all([
				this.marketplaceService.listPackages({ kind: 'workflow' }),
				this.workflowStorage.listWorkflows().catch(() => [] as IStoredWorkflow[]),
			]);

			// 过滤内置工作流：商城不展示已随产品内置的工作流
			const builtinWfIds = new Set(
				installedWorkflows.filter(w => w.source === 'builtin').map(w => w.id)
			);
			this._packages = result.items.filter(pkg =>
				!builtinWfIds.has(pkg.slug) && !builtinWfIds.has(pkg.id)
			);
			this._installedWorkflowIds = new Set(installedWorkflows.map(w => w.id));
			this._renderGrid();
		} catch (err) {
			console.error('[WorkflowMarket] Failed to load packages:', err);
			clearNode(this._gridEl);
			const errEl = $('div');
			errEl.style.gridColumn = '1 / -1';
			errEl.style.textAlign = 'center';
			errEl.style.padding = '40px';
			errEl.style.color = 'var(--vscode-errorForeground)';
			errEl.textContent = `加载失败: ${err instanceof Error ? err.message : String(err)}`;
			this._gridEl.appendChild(errEl);
		} finally {
			this._loading = false;
		}
	}

	// ─── Render ─────────────────────────────────────────────────

	private _renderGrid(): void {
		if (!this._gridEl) { return; }
		clearNode(this._gridEl);

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
				? `没有匹配 "${this._searchQuery}" 的工作流`
				: '暂无可安装的工作流';
			this._gridEl.appendChild(empty);
			return;
		}

		for (const pkg of items) {
			this._gridEl.appendChild(this._createCard(pkg));
		}
	}

	private _createCard(pkg: IMarketplacePackage): HTMLElement {
		const isInstalled = this._installedWorkflowIds.has(pkg.id);
		const isInstalling = this._installingSlugs.has(pkg.slug);

		const card = $('div.wfm-card');
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

		card.onclick = () => this._installWorkflow(pkg);

		// Top: icon + name + meta
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
		icon.style.background = 'linear-gradient(135deg,#3498db,#2980b9)';
		icon.textContent = pkg.icon || '🔀';
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

		if (pkg.authorName) {
			const author = $('span');
			author.textContent = `👤 ${pkg.authorName}`;
			author.style.fontSize = '11px';
			author.style.color = 'var(--vscode-descriptionForeground)';
			meta.appendChild(author);
		}
		if (pkg.updatedAt) {
			const date = $('span');
			date.textContent = `🕐 ${this._formatDate(pkg.updatedAt)}`;
			date.style.fontSize = '11px';
			date.style.color = 'var(--vscode-descriptionForeground)';
			meta.appendChild(date);
		}
		if (pkg.latestVersion) {
			const ver = $('span');
			ver.textContent = `v${pkg.latestVersion}`;
			ver.style.fontSize = '11px';
			ver.style.color = 'var(--vscode-textLink-foreground)';
			meta.appendChild(ver);
		}
		if (typeof pkg.downloads === 'number' && pkg.downloads > 0) {
			const dl = $('span');
			dl.textContent = `⬇ ${this._formatCount(pkg.downloads)}`;
			dl.style.fontSize = '11px';
			dl.style.color = 'var(--vscode-descriptionForeground)';
			meta.appendChild(dl);
		}
		info.appendChild(meta);
		top.appendChild(info);
		card.appendChild(top);

		// Description
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

		// Footer: tags + action
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
			const installedBadge = $('span');
			installedBadge.textContent = '✓ 已安装';
			installedBadge.style.fontSize = '11px';
			installedBadge.style.padding = '3px 10px';
			installedBadge.style.borderRadius = '4px';
			installedBadge.style.background = 'rgba(35,134,54,0.15)';
			installedBadge.style.color = '#23a85f';
			footer.appendChild(installedBadge);
		} else if (isInstalling) {
			const loadingBadge = $('span');
			loadingBadge.textContent = '⏳ 安装中';
			loadingBadge.style.fontSize = '11px';
			loadingBadge.style.padding = '3px 10px';
			loadingBadge.style.borderRadius = '4px';
			loadingBadge.style.background = 'rgba(14,99,156,0.15)';
			loadingBadge.style.color = 'var(--vscode-button-background)';
			footer.appendChild(loadingBadge);
		} else {
			const installBtn = $('button') as HTMLButtonElement;
			installBtn.textContent = '⬇ 安装';
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
				await this._installWorkflow(pkg);
			};
			footer.appendChild(installBtn);
		}

		card.appendChild(footer);
		return card;
	}

	// ─── Actions ────────────────────────────────────────────────

	private async _installWorkflow(pkg: IMarketplacePackage): Promise<void> {
		if (this._installingSlugs.has(pkg.slug)) { return; }
		this._installingSlugs.add(pkg.slug);
		this._renderGrid();

		try {
			await this.marketplaceService.download(pkg.slug, pkg.latestVersion ?? '', 'workflow');
			this.notificationService.info(`✅ ${pkg.name} 安装成功`);
			this._renderGrid();
		} catch (err) {
			this.notificationService.error(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._installingSlugs.delete(pkg.slug);
			this._renderGrid();
		}
	}

	// ─── Helpers ───────────────────────────────────────────────

	private _formatCount(n: number): string {
		if (n >= 10000) { return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}w`; }
		if (n >= 1000) { return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`; }
		return String(n);
	}

	/** 将时间戳格式化为 YYYY-MM-DD */
	private _formatDate(ts: number): string {
		const d = new Date(ts);
		const pad = (n: number) => n < 10 ? `0${n}` : `${n}`;
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
}
