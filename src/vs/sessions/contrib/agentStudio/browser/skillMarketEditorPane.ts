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
import { $, clearNode } from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { SkillMarketEditorInput } from './skillMarketEditorInput.js';
import { ISkillInstallService, ISkillHubEntry, ISkillHubDefinition } from '../common/skillHubTypes.js';
import { ISkillRegistry } from '../common/skills.js';


// ─── Helpers ─────────────────────────────────────────────────────────────────

function skillIconForCategory(category?: string): string {
	switch (category) {
		case 'code': return '\u{1F4BB}';
		case 'git': return '\u{1F500}';
		case 'meta': return '\u{1F9E0}';
		case 'docs': return '\u{1F4DD}';
		case 'review': return '\u{1F50D}';
		case 'writing': return '\u270D\uFE0F';
		case 'data': return '\u{1F4CA}';
		default: return '\u{1F4E6}';
	}
}

// ─── Types ──────────────────────────────────────────────────────────────────

type ViewState =
	| { mode: 'hubs' }
	| { mode: 'hub-entries'; hubId: string };

interface FilterState {
	query: string;
	category: string;
	hubFilter: string;
}

/** 页面初始展示的条目数量，避免一次性渲染上千条卡片造成卡顿 */
const ENTRY_PAGE_SIZE = 60;

// ─── EditorPane ──────────────────────────────────────────────────────────────

export class SkillMarketEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.skillMarket';

	private _container!: HTMLElement;

	// Data
	private _view: ViewState = { mode: 'hubs' };
	private _filter: FilterState = { query: '', category: 'All', hubFilter: 'All' };
	private _loading = false;
	private _installingIds: Set<string> = new Set();
	/** 当前 hub-entries 视图下展示的最大条目数（点击「加载更多」递增） */
	private _entryDisplayLimit = ENTRY_PAGE_SIZE;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IDialogService private readonly dialogService: IDialogService,
		@ISkillInstallService private readonly skillInstallService: ISkillInstallService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
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

		// Listen for skill changes (install/uninstall) to refresh installed state
		this._register(this.skillRegistry.onDidChangeSkills(() => {
			this._renderContent();
		}));
		this._register(this.skillInstallService.onDidChangeEntries(() => {
			this._renderContent();
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

		// Build UI on first open
		if (this._container.childElementCount === 0) {
			this._buildUI();
		}

		// Reset view to hubs on each open
		this._view = { mode: 'hubs' };
		this._renderContent();
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
		const toolbar = $('div.skill-market-toolbar');
		toolbar.style.display = 'flex';
		toolbar.style.alignItems = 'center';
		toolbar.style.justifyContent = 'space-between';
		toolbar.style.padding = '12px 16px';
		toolbar.style.borderBottom = '1px solid var(--vscode-panel-border)';
		toolbar.style.flexShrink = '0';

		const left = $('div.skill-market-toolbar-left');
		left.style.display = 'flex';
		left.style.alignItems = 'center';
		left.style.gap = '12px';

		const title = $('h2.skill-market-title');
		title.textContent = '\u{1F9E9} Skill Marketplace';
		title.style.margin = '0';
		title.style.fontSize = '18px';
		title.style.fontWeight = '600';
		left.appendChild(title);

		// Back button (visible when browsing hub entries)
		const backBtn = $('button.skill-market-back-btn') as HTMLButtonElement;
		backBtn.textContent = '\u2190 Back to Hubs';
		backBtn.title = 'Return to hub list';
		backBtn.style.display = 'none';
		backBtn.style.padding = '6px 12px';
		backBtn.style.fontSize = '12px';
		backBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		backBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		backBtn.style.border = 'none';
		backBtn.style.borderRadius = '4px';
		backBtn.style.cursor = 'pointer';
		backBtn.id = 'skill-market-back-btn';
		backBtn.onclick = () => {
			this._view = { mode: 'hubs' };
			this._filter.query = '';
			this._entryDisplayLimit = ENTRY_PAGE_SIZE;
			this._renderContent();
		};
		left.appendChild(backBtn);

		toolbar.appendChild(left);

		const right = $('div.skill-market-toolbar-right');
		right.style.display = 'flex';
		right.style.alignItems = 'center';
		right.style.gap = '8px';

		// Filter input
		const filterInput = $('input.skill-market-filter') as HTMLInputElement;
		filterInput.type = 'text';
		filterInput.placeholder = '\u{1F50D} Filter skills by name, description, or category...';
		filterInput.style.padding = '6px 10px';
		filterInput.style.fontSize = '12px';
		filterInput.style.border = '1px solid var(--vscode-input-border)';
		filterInput.style.borderRadius = '4px';
		filterInput.style.background = 'var(--vscode-input-background)';
		filterInput.style.color = 'var(--vscode-input-foreground)';
		filterInput.style.width = '280px';
		filterInput.style.outline = 'none';
		filterInput.id = 'skill-market-filter-input';
		filterInput.oninput = () => {
			this._filter.query = filterInput.value.trim().toLowerCase();
			this._entryDisplayLimit = ENTRY_PAGE_SIZE;
			this._renderContent();
		};
		right.appendChild(filterInput);

		const refreshBtn = $('button.skill-market-refresh-btn') as HTMLButtonElement;
		refreshBtn.textContent = '\u{1F504} Refresh';
		refreshBtn.title = 'Refresh skill hubs';
		refreshBtn.style.padding = '6px 12px';
		refreshBtn.style.fontSize = '12px';
		refreshBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		refreshBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		refreshBtn.style.border = 'none';
		refreshBtn.style.borderRadius = '4px';
		refreshBtn.style.cursor = 'pointer';
		refreshBtn.onclick = () => { void this._refreshAll(); };
		right.appendChild(refreshBtn);

		toolbar.appendChild(right);

		this._container.appendChild(toolbar);

		// ── Content area ────────────────────────────────────────────
		const content = $('div.skill-market-content');
		content.id = 'skill-market-content';
		content.style.flex = '1';
		content.style.overflowY = 'auto';
		content.style.padding = '16px';
		this._container.appendChild(content);
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  DATA
	// ══════════════════════════════════════════════════════════════════════════

	private async _refreshAll(): Promise<void> {
		if (this._loading) { return; }
		this._loading = true;
		const refreshBtn = this._container.querySelector('.skill-market-refresh-btn') as HTMLButtonElement;
		if (refreshBtn) {
			refreshBtn.textContent = '\u23F3 Loading...';
			refreshBtn.disabled = true;
		}

		try {
			await this.skillInstallService.refreshAll();
		} catch (err) {
			console.error('[SkillMarketEditor] Failed to refresh:', err);
		}

		if (refreshBtn) {
			refreshBtn.textContent = '\u{1F504} Refresh';
			refreshBtn.disabled = false;
		}
		this._loading = false;
		this._renderContent();
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  RENDER
	// ══════════════════════════════════════════════════════════════════════════

	private _renderContent(): void {
		const content = this._container.querySelector('#skill-market-content') as HTMLElement;
		if (!content) { return; }

		// Update back button visibility
		const backBtn = this._container.querySelector('#skill-market-back-btn') as HTMLElement;
		if (backBtn) {
			backBtn.style.display = this._view.mode === 'hub-entries' ? '' : 'none';
		}

		// Update filter placeholder
		const filterInput = this._container.querySelector('#skill-market-filter-input') as HTMLInputElement;
		if (filterInput) {
			if (this._view.mode === 'hubs') {
				filterInput.placeholder = '\u{1F50D} Filter hubs...';
			} else {
				filterInput.placeholder = '\u{1F50D} Filter skills by name, description, or category...';
			}
		}

		switch (this._view.mode) {
			case 'hubs':
				this._renderHubs(content);
				break;
			case 'hub-entries':
				this._renderHubEntries(content, this._view.hubId);
				break;
		}
	}

	// ── Hubs View ─────────────────────────────────────────────────

	private _renderHubs(container: HTMLElement): void {
		clearNode(container);

		const hubs = this.skillInstallService.getHubs();
		const installedIds = new Set(
			this.skillRegistry.getSkills().map(s => s.id)
		);

		// Apply filter
		const q = this._filter.query;
		let filteredHubs = hubs.slice();
		if (q) {
			filteredHubs = filteredHubs.filter(h =>
				h.name.toLowerCase().includes(q) ||
				h.id.toLowerCase().includes(q) ||
				h.description.toLowerCase().includes(q)
			);
		}

		// Section: Hubs
		const hubSection = $('div.skill-market-section');
		const hubHeader = $('div.skill-market-section-header');
		hubHeader.style.display = 'flex';
		hubHeader.style.alignItems = 'center';
		hubHeader.style.justifyContent = 'space-between';
		hubHeader.style.marginBottom = '12px';

		const hubTitle = $('h3.skill-market-section-title');
		hubTitle.textContent = 'Skill Hubs';
		if (filteredHubs.length !== hubs.length) {
			hubTitle.textContent += ` (${filteredHubs.length}/${hubs.length} shown)`;
		} else {
			hubTitle.textContent += ` (${hubs.length})`;
		}
		hubTitle.style.margin = '0';
		hubTitle.style.fontSize = '14px';
		hubTitle.style.fontWeight = '600';
		hubHeader.appendChild(hubTitle);

		hubSection.appendChild(hubHeader);

		if (filteredHubs.length === 0) {
			const empty = $('p.skill-market-empty');
			empty.textContent = q
				? `No hubs match "${q}". Try a different search term.`
				: 'No skill hubs available.';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.style.fontSize = '13px';
			empty.style.textAlign = 'center';
			empty.style.padding = '24px';
			hubSection.appendChild(empty);
		} else {
			const hubGrid = $('div.skill-market-hub-grid');
			hubGrid.style.display = 'grid';
			hubGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(300px, 1fr))';
			hubGrid.style.gap = '12px';

			for (const hub of filteredHubs) {
				const card = this._buildHubCard(hub, installedIds);
				hubGrid.appendChild(card);
			}
			hubSection.appendChild(hubGrid);
		}

		container.appendChild(hubSection);

		// Divider
		const divider = $('hr.skill-market-divider');
		divider.style.margin = '20px 0';
		divider.style.border = 'none';
		divider.style.borderTop = '1px solid var(--vscode-panel-border)';
		container.appendChild(divider);

		// Section: Local Install
		this._renderLocalInstallSection(container);

		// Divider
		const divider2 = $('hr.skill-market-divider');
		divider2.style.margin = '20px 0';
		divider2.style.border = 'none';
		divider2.style.borderTop = '1px solid var(--vscode-panel-border)';
		container.appendChild(divider2);

		// Section: URL Install
		this._renderUrlInstallSection(container);
	}

	private _buildHubCard(hub: ISkillHubDefinition, installedIds: Set<string>): HTMLElement {
		const card = $('div.skill-market-hub-card');
		card.style.padding = '16px';
		card.style.border = '1px solid var(--vscode-panel-border)';
		card.style.borderRadius = '8px';
		card.style.cursor = 'pointer';
		card.style.transition = 'border-color 0.15s, background 0.15s';
		card.style.display = 'flex';
		card.style.flexDirection = 'column';
		card.style.gap = '8px';

		if (hub.official) {
			card.style.borderColor = 'var(--vscode-focusBorder, #007fd4)';
		}

		card.onmouseenter = () => {
			card.style.borderColor = 'var(--vscode-focusBorder)';
			card.style.background = 'var(--vscode-list-hoverBackground)';
		};
		card.onmouseleave = () => {
			card.style.borderColor = hub.official ? 'var(--vscode-focusBorder, #007fd4)' : 'var(--vscode-panel-border)';
			card.style.background = '';
		};
		card.onclick = () => {
			this._view = { mode: 'hub-entries', hubId: hub.id };
			this._filter.query = '';
			this._entryDisplayLimit = ENTRY_PAGE_SIZE;
			this._renderContent();
		};

		// Card header
		const cardHeader = $('div.skill-market-hub-card-header');
		cardHeader.style.display = 'flex';
		cardHeader.style.alignItems = 'center';
		cardHeader.style.gap = '10px';

		const hubIcon = $('span.skill-market-hub-icon');
		hubIcon.textContent = hub.icon ?? '\u{1F4E6}';
		hubIcon.style.fontSize = '24px';
		hubIcon.style.flexShrink = '0';
		cardHeader.appendChild(hubIcon);

		const headerInfo = $('div');
		headerInfo.style.flex = '1';

		const nameRow = $('div');
		nameRow.style.display = 'flex';
		nameRow.style.alignItems = 'center';
		nameRow.style.gap = '8px';

		const hubName = $('span.skill-market-hub-name');
		hubName.textContent = hub.name;
		hubName.style.fontSize = '15px';
		hubName.style.fontWeight = '600';
		nameRow.appendChild(hubName);

		if (hub.official) {
			const officialBadge = $('span.skill-market-hub-official');
			officialBadge.textContent = 'Official';
			officialBadge.style.fontSize = '10px';
			officialBadge.style.padding = '2px 6px';
			officialBadge.style.borderRadius = '8px';
			officialBadge.style.background = 'rgba(0, 127, 212, 0.15)';
			officialBadge.style.color = 'var(--vscode-focusBorder, #007fd4)';
			officialBadge.style.fontWeight = '500';
			nameRow.appendChild(officialBadge);
		}

		headerInfo.appendChild(nameRow);

		const hubType = $('div.skill-market-hub-type');
		hubType.textContent = hub.type === 'github' ? 'GitHub' : hub.type.toUpperCase();
		hubType.style.fontSize = '11px';
		hubType.style.color = 'var(--vscode-descriptionForeground)';
		headerInfo.appendChild(hubType);

		cardHeader.appendChild(headerInfo);
		card.appendChild(cardHeader);

		// Description
		const hubDesc = $('p.skill-market-hub-desc');
		hubDesc.textContent = hub.description;
		hubDesc.style.margin = '0';
		hubDesc.style.fontSize = '12px';
		hubDesc.style.color = 'var(--vscode-descriptionForeground)';
		hubDesc.style.lineHeight = '1.4';
		card.appendChild(hubDesc);

		// Browse button
		const browseBtn = $('button.skill-market-browse-btn');
		browseBtn.textContent = 'Browse Skills \u2192';
		browseBtn.style.alignSelf = 'flex-start';
		browseBtn.style.padding = '6px 14px';
		browseBtn.style.fontSize = '12px';
		browseBtn.style.fontWeight = '500';
		browseBtn.style.background = 'var(--vscode-button-background)';
		browseBtn.style.color = 'var(--vscode-button-foreground)';
		browseBtn.style.border = 'none';
		browseBtn.style.borderRadius = '4px';
		browseBtn.style.cursor = 'pointer';
		browseBtn.onclick = (e) => {
			e.stopPropagation();
			this._view = { mode: 'hub-entries', hubId: hub.id };
			this._filter.query = '';
			this._entryDisplayLimit = ENTRY_PAGE_SIZE;
			this._renderContent();
		};
		card.appendChild(browseBtn);

		return card;
	}

	// ── Hub Entries View ──────────────────────────────────────────

	private async _renderHubEntries(container: HTMLElement, hubId: string): Promise<void> {
		clearNode(container);

		const hub = this.skillInstallService.getHubs().find(h => h.id === hubId);
		const installedIds = new Set(
			this.skillRegistry.getSkills().map(s => s.id)
		);

		// Hub header
		const hubHeader = $('div.skill-market-hub-detail-header');
		hubHeader.style.display = 'flex';
		hubHeader.style.alignItems = 'center';
		hubHeader.style.gap = '10px';
		hubHeader.style.marginBottom = '16px';
		hubHeader.style.padding = '12px 16px';
		hubHeader.style.border = '1px solid var(--vscode-panel-border)';
		hubHeader.style.borderRadius = '8px';
		hubHeader.style.background = 'var(--vscode-sideBarSectionHeader-background)';

		const hubIcon = $('span');
		hubIcon.textContent = hub?.icon ?? '\u{1F4E6}';
		hubIcon.style.fontSize = '20px';
		hubHeader.appendChild(hubIcon);

		const hubInfo = $('div');
		hubInfo.style.flex = '1';

		const hubName = $('div');
		hubName.textContent = hub?.name ?? hubId;
		hubName.style.fontSize = '14px';
		hubName.style.fontWeight = '600';
		hubInfo.appendChild(hubName);

		const hubUrl = $('div');
		hubUrl.textContent = hub?.url ?? '';
		hubUrl.style.fontSize = '11px';
		hubUrl.style.color = 'var(--vscode-descriptionForeground)';
		hubUrl.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
		hubInfo.appendChild(hubUrl);

		hubHeader.appendChild(hubInfo);
		container.appendChild(hubHeader);

		// Fetch or use cached entries
		let entries: readonly ISkillHubEntry[] = [];
		const cachedEntries = this.skillInstallService.getCachedEntries(hubId);

		if (cachedEntries.length > 0) {
			entries = cachedEntries;
		} else {
			// Show loading
			const loading = $('div.skill-market-loading');
			loading.textContent = '\u23F3 Loading skills from hub...';
			loading.style.textAlign = 'center';
			loading.style.padding = '24px';
			loading.style.color = 'var(--vscode-descriptionForeground)';
			loading.style.fontSize = '13px';
			container.appendChild(loading);

			try {
				entries = await this.skillInstallService.fetchHubEntries(hubId);
				loading.remove();
			} catch (err) {
				loading.textContent = `\u26A0\uFE0F Failed to load: ${err instanceof Error ? err.message : String(err)}`;
				return;
			}
		}

		// Filter
		const q = this._filter.query;
		let filteredEntries = entries.slice();
		if (q) {
			filteredEntries = filteredEntries.filter(e =>
				e.name.toLowerCase().includes(q) ||
				e.id.toLowerCase().includes(q) ||
				(e.description ?? '').toLowerCase().includes(q) ||
				(e.category ?? '').toLowerCase().includes(q) ||
				(e.tags ?? []).some(t => t.toLowerCase().includes(q)) ||
				(e.author ?? '').toLowerCase().includes(q)
			);
		}

		// Update installed status
		for (const entry of filteredEntries) {
			(entry as any).installed = installedIds.has(entry.id);
		}

		// Count
		const countBar = $('div.skill-market-entry-count');
		countBar.style.display = 'flex';
		countBar.style.alignItems = 'center';
		countBar.style.justifyContent = 'space-between';
		countBar.style.marginBottom = '12px';

		const countText = $('span');
		if (filteredEntries.length !== entries.length) {
			countText.textContent = `${filteredEntries.length} / ${entries.length} 个技能匹配`;
		} else {
			countText.textContent = `共 ${entries.length} 个技能可用`;
		}
		countText.style.fontSize = '12px';
		countText.style.color = 'var(--vscode-descriptionForeground)';
		countBar.appendChild(countText);

		container.appendChild(countBar);

		if (filteredEntries.length === 0) {
			const empty = $('p.skill-market-empty');
			empty.textContent = q
				? `没有匹配 "${q}" 的技能，换个关键词试试。`
				: '该 Hub 中暂无技能，点击 Refresh 重新加载。';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.style.fontSize = '13px';
			empty.style.textAlign = 'center';
			empty.style.padding = '24px';
			container.appendChild(empty);
			return;
		}

		// Entry grid (limited by _entryDisplayLimit for big hubs like knot-market)
		const limit = this._entryDisplayLimit;
		const shown = filteredEntries.slice(0, limit);

		const grid = $('div.skill-market-entry-grid');
		grid.style.display = 'grid';
		grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(280px, 1fr))';
		grid.style.gap = '10px';

		for (const entry of shown) {
			grid.appendChild(this._buildEntryCard(entry, hubId));
		}
		container.appendChild(grid);

		// Load-more footer
		if (filteredEntries.length > limit) {
			const moreWrap = $('div');
			moreWrap.style.textAlign = 'center';
			moreWrap.style.marginTop = '14px';
			const moreBtn = $('button') as HTMLButtonElement;
			moreBtn.textContent = `加载更多 (${filteredEntries.length - limit} 项剩余)`;
			moreBtn.style.padding = '8px 20px';
			moreBtn.style.fontSize = '12px';
			moreBtn.style.background = 'var(--vscode-button-secondaryBackground)';
			moreBtn.style.color = 'var(--vscode-button-secondaryForeground)';
			moreBtn.style.border = 'none';
			moreBtn.style.borderRadius = '4px';
			moreBtn.style.cursor = 'pointer';
			moreBtn.onclick = () => {
				this._entryDisplayLimit += ENTRY_PAGE_SIZE;
				this._renderContent();
			};
			moreWrap.appendChild(moreBtn);
			container.appendChild(moreWrap);
		}
	}

	/**
	 * 构建单个 skill 卡片（参考 MCP server 卡片样式）。
	 * - 14px 内边距、8px 圆角、面板边框，hover 高亮
	 * - 头部：emoji icon + 名称 + 安装/已安装按钮
	 * - 主体：2 行描述
	 * - 页脚：tag/category badge
	 */
	private _buildEntryCard(entry: ISkillHubEntry, hubId: string): HTMLElement {
		const isInstalled = entry.installed ?? this.skillInstallService.isInstalled(entry.id);
		const isInstalling = this._installingIds.has(entry.id);

		const card = $('div.skill-market-entry-card');
		card.style.padding = '14px 16px';
		card.style.border = '1px solid var(--vscode-panel-border)';
		card.style.borderRadius = '8px';
		card.style.transition = 'border-color 0.15s, background 0.15s';
		card.style.display = 'flex';
		card.style.flexDirection = 'column';
		card.style.gap = '8px';

		card.onmouseenter = () => {
			card.style.borderColor = 'var(--vscode-focusBorder)';
			card.style.background = 'var(--vscode-list-hoverBackground)';
		};
		card.onmouseleave = () => {
			card.style.borderColor = 'var(--vscode-panel-border)';
			card.style.background = '';
		};

		// Header: icon + name + action button
		const header = $('div');
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.gap = '8px';

		const iconBox = $('div');
		iconBox.style.width = '28px';
		iconBox.style.height = '28px';
		iconBox.style.flexShrink = '0';
		iconBox.style.borderRadius = '6px';
		iconBox.style.display = 'flex';
		iconBox.style.alignItems = 'center';
		iconBox.style.justifyContent = 'center';
		iconBox.style.overflow = 'hidden';
		iconBox.style.fontSize = '16px';
		iconBox.style.background = 'var(--vscode-input-background)';
		if (entry.icon && /^https?:\/\//.test(entry.icon)) {
			const img = $('img') as HTMLImageElement;
			img.src = entry.icon;
			img.style.width = '100%';
			img.style.height = '100%';
			img.style.objectFit = 'cover';
			img.onerror = () => { iconBox.textContent = skillIconForCategory(entry.category); };
			iconBox.appendChild(img);
		} else if (entry.icon) {
			iconBox.textContent = entry.icon;
		} else {
			iconBox.textContent = skillIconForCategory(entry.category);
		}
		header.appendChild(iconBox);

		const nameWrap = $('div');
		nameWrap.style.flex = '1';
		nameWrap.style.minWidth = '0';
		const cardName = $('div');
		cardName.textContent = entry.name;
		cardName.title = entry.name;
		cardName.style.fontSize = '13px';
		cardName.style.fontWeight = '600';
		cardName.style.whiteSpace = 'nowrap';
		cardName.style.overflow = 'hidden';
		cardName.style.textOverflow = 'ellipsis';
		nameWrap.appendChild(cardName);

		// Subtitle: author / version / downloads
		const subParts: string[] = [];
		if (entry.author) {
			subParts.push(`@${entry.author}`);
		}
		if (entry.version) {
			subParts.push(`v${entry.version}`);
		}
		if (typeof entry.downloadCount === 'number' && entry.downloadCount > 0) {
			subParts.push(`\u2B07 ${this._formatCount(entry.downloadCount)}`);
		}
		if (subParts.length > 0) {
			const subtitle = $('div');
			subtitle.textContent = subParts.join('  ·  ');
			subtitle.style.fontSize = '11px';
			subtitle.style.color = 'var(--vscode-descriptionForeground)';
			subtitle.style.whiteSpace = 'nowrap';
			subtitle.style.overflow = 'hidden';
			subtitle.style.textOverflow = 'ellipsis';
			subtitle.style.marginTop = '2px';
			nameWrap.appendChild(subtitle);
		}
		header.appendChild(nameWrap);

		// Action / status
		if (isInstalled) {
			const installedBadge = $('span');
			installedBadge.textContent = '\u2713 Installed';
			installedBadge.style.fontSize = '11px';
			installedBadge.style.padding = '4px 10px';
			installedBadge.style.borderRadius = '4px';
			installedBadge.style.background = 'rgba(137, 209, 133, 0.15)';
			installedBadge.style.color = 'var(--vscode-testing-iconPassed, #89d185)';
			installedBadge.style.fontWeight = '500';
			installedBadge.style.flexShrink = '0';
			header.appendChild(installedBadge);
		} else if (isInstalling) {
			const loadingBadge = $('span');
			loadingBadge.textContent = '\u23F3 安装中';
			loadingBadge.style.fontSize = '11px';
			loadingBadge.style.padding = '4px 10px';
			loadingBadge.style.borderRadius = '4px';
			loadingBadge.style.background = 'rgba(0, 127, 212, 0.15)';
			loadingBadge.style.color = 'var(--vscode-focusBorder, #007fd4)';
			loadingBadge.style.fontWeight = '500';
			loadingBadge.style.flexShrink = '0';
			header.appendChild(loadingBadge);
		} else {
			const installBtn = $('button') as HTMLButtonElement;
			installBtn.textContent = '\u2B07 安装';
			installBtn.style.fontSize = '11px';
			installBtn.style.padding = '4px 10px';
			installBtn.style.flexShrink = '0';
			installBtn.style.background = 'var(--vscode-button-background)';
			installBtn.style.color = 'var(--vscode-button-foreground)';
			installBtn.style.border = 'none';
			installBtn.style.borderRadius = '4px';
			installBtn.style.cursor = 'pointer';
			installBtn.onclick = async (e) => {
				e.stopPropagation();
				if (this._installingIds.has(entry.id)) { return; }
				this._installingIds.add(entry.id);
				this._renderContent();

				const result = await this.skillInstallService.installFromHub(hubId, entry.id);
				this._installingIds.delete(entry.id);

				if (result.success) {
					(entry as any).installed = true;
					this._renderContent();
				} else {
					this._renderContent();
					await this.dialogService.info(
						`Failed to install "${entry.name}": ${result.error ?? 'Unknown error'}`,
						'Installation Failed'
					);
				}
			};
			header.appendChild(installBtn);
		}
		card.appendChild(header);

		// Description
		const desc = $('p');
		desc.textContent = entry.description || '(暂无描述)';
		desc.style.margin = '0';
		desc.style.fontSize = '12px';
		desc.style.color = 'var(--vscode-descriptionForeground)';
		desc.style.lineHeight = '1.4';
		desc.style.display = '-webkit-box';
		desc.style.webkitLineClamp = '2';
		(desc.style as any).webkitBoxOrient = 'vertical';
		desc.style.overflow = 'hidden';
		card.appendChild(desc);

		// Footer: category + tags
		const footer = $('div');
		footer.style.display = 'flex';
		footer.style.flexWrap = 'wrap';
		footer.style.gap = '4px';
		footer.style.alignItems = 'center';

		const tagSet = new Set<string>();
		if (entry.category) {
			tagSet.add(entry.category);
		}
		for (const t of (entry.tags ?? [])) {
			if (t) { tagSet.add(t); }
		}
		const tagList = Array.from(tagSet).slice(0, 4);

		if (tagList.length === 0 && entry.activation) {
			tagList.push(entry.activation);
		}

		for (let i = 0; i < tagList.length; i++) {
			const tag = tagList[i];
			const badge = $('span');
			badge.textContent = tag;
			badge.style.fontSize = '10px';
			badge.style.padding = '2px 6px';
			badge.style.borderRadius = '8px';
			if (i === 0) {
				badge.style.background = 'var(--vscode-badge-background)';
				badge.style.color = 'var(--vscode-badge-foreground)';
			} else {
				badge.style.background = 'var(--vscode-input-background)';
				badge.style.color = 'var(--vscode-descriptionForeground)';
			}
			footer.appendChild(badge);
		}

		card.appendChild(footer);

		return card;
	}

	private _formatCount(n: number): string {
		if (n >= 10000) {
			return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}w`;
		}
		if (n >= 1000) {
			return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
		}
		return String(n);
	}

	// ── Local File Install Section ─────────────────────────────────

	private _renderLocalInstallSection(container: HTMLElement): void {
		const section = $('div.skill-market-section');
		const title = $('h3.skill-market-section-title');
		title.textContent = '\u{1F4C1} Install from Local File';
		title.style.margin = '0 0 8px 0';
		title.style.fontSize = '14px';
		title.style.fontWeight = '600';
		section.appendChild(title);

		const desc = $('p');
		desc.textContent = 'Import a SKILL.md file from your computer';
		desc.style.color = 'var(--vscode-descriptionForeground)';
		desc.style.fontSize = '12px';
		desc.style.margin = '0 0 10px 0';
		section.appendChild(desc);

		const actions = $('div');
		actions.style.display = 'flex';
		actions.style.gap = '8px';

		const fileInput = $('input') as HTMLInputElement;
		fileInput.type = 'file';
		fileInput.accept = '.md,.markdown';
		fileInput.style.display = 'none';
		fileInput.onchange = async () => {
			const file = fileInput.files?.[0];
			if (!file) { return; }
			const text = await file.text();
			const result = await this.skillInstallService.installFromContent(text);
			if (result.success) {
				void this.skillRegistry.reload();
				this._renderContent();
			} else {
				await this.dialogService.info(
					`Failed to install skill: ${result.error ?? 'Unknown error'}`,
					'Installation Failed'
				);
			}
		};
		actions.appendChild(fileInput);

		const browseBtn = $('button') as HTMLButtonElement;
		browseBtn.textContent = '\u{1F4C1} Browse SKILL.md';
		browseBtn.style.padding = '8px 16px';
		browseBtn.style.fontSize = '13px';
		browseBtn.style.background = 'var(--vscode-button-background)';
		browseBtn.style.color = 'var(--vscode-button-foreground)';
		browseBtn.style.border = 'none';
		browseBtn.style.borderRadius = '4px';
		browseBtn.style.cursor = 'pointer';
		browseBtn.onclick = () => fileInput.click();
		actions.appendChild(browseBtn);

		const pasteBtn = $('button') as HTMLButtonElement;
		pasteBtn.textContent = '\u{1F4CB} Paste Content';
		pasteBtn.style.padding = '8px 16px';
		pasteBtn.style.fontSize = '13px';
		pasteBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		pasteBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		pasteBtn.style.border = 'none';
		pasteBtn.style.borderRadius = '4px';
		pasteBtn.style.cursor = 'pointer';
		pasteBtn.onclick = () => this._showPasteDialog();
		actions.appendChild(pasteBtn);

		section.appendChild(actions);
		container.appendChild(section);
	}

	// ── URL Install Section ────────────────────────────────────────

	private _renderUrlInstallSection(container: HTMLElement): void {
		const section = $('div.skill-market-section');
		const title = $('h3.skill-market-section-title');
		title.textContent = '\u{1F310} Install from URL';
		title.style.margin = '0 0 8px 0';
		title.style.fontSize = '14px';
		title.style.fontWeight = '600';
		section.appendChild(title);

		const desc = $('p');
		desc.textContent = 'Install from a direct SKILL.md URL (GitHub raw, Gist, etc.)';
		desc.style.color = 'var(--vscode-descriptionForeground)';
		desc.style.fontSize = '12px';
		desc.style.margin = '0 0 10px 0';
		section.appendChild(desc);

		const urlRow = $('div');
		urlRow.style.display = 'flex';
		urlRow.style.gap = '8px';

		const urlInput = $('input') as HTMLInputElement;
		urlInput.type = 'text';
		urlInput.placeholder = 'https://raw.githubusercontent.com/.../SKILL.md';
		urlInput.style.flex = '1';
		urlInput.style.padding = '8px 10px';
		urlInput.style.fontSize = '13px';
		urlInput.style.border = '1px solid var(--vscode-input-border)';
		urlInput.style.borderRadius = '4px';
		urlInput.style.background = 'var(--vscode-input-background)';
		urlInput.style.color = 'var(--vscode-input-foreground)';
		urlInput.style.outline = 'none';
		urlRow.appendChild(urlInput);

		const urlBtn = $('button') as HTMLButtonElement;
		urlBtn.textContent = 'Install';
		urlBtn.style.padding = '8px 16px';
		urlBtn.style.fontSize = '13px';
		urlBtn.style.background = 'var(--vscode-button-background)';
		urlBtn.style.color = 'var(--vscode-button-foreground)';
		urlBtn.style.border = 'none';
		urlBtn.style.borderRadius = '4px';
		urlBtn.style.cursor = 'pointer';
		urlBtn.style.flexShrink = '0';
		urlBtn.onclick = async () => {
			const url = urlInput.value.trim();
			if (!url) { return; }
			urlBtn.textContent = 'Installing...';
			urlBtn.disabled = true;
			try {
				const content = await this._fetchUrlContent(url);
				if (!content) { throw new Error('Failed to download content'); }
				const result = await this.skillInstallService.installFromContent(content);
				if (result.success) {
					void this.skillRegistry.reload();
					this._renderContent();
					urlInput.value = '';
				} else {
					await this.dialogService.info(
						`Failed to install: ${result.error ?? 'Unknown error'}`,
						'Installation Failed'
					);
				}
			} catch (err) {
				await this.dialogService.info(
					`Error: ${err instanceof Error ? err.message : String(err)}`,
					'Installation Failed'
				);
			} finally {
				urlBtn.textContent = 'Install';
				urlBtn.disabled = false;
			}
		};
		urlRow.appendChild(urlBtn);

		section.appendChild(urlRow);
		container.appendChild(section);
	}

	// ── Paste Dialog ────────────────────────────────────────────────

	private _showPasteDialog(): void {
		const existing = this._container.querySelector('.skill-market-overlay');
		if (existing) { existing.remove(); return; }

		const overlay = $('div.skill-market-overlay');
		overlay.style.position = 'absolute';
		overlay.style.top = '0';
		overlay.style.left = '0';
		overlay.style.right = '0';
		overlay.style.bottom = '0';
		overlay.style.background = 'rgba(0, 0, 0, 0.5)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '1000';
		overlay.onclick = (e) => {
			if (e.target === overlay) { overlay.remove(); }
		};

		const dialog = $('div.skill-market-dialog');
		dialog.style.background = 'var(--vscode-editor-background)';
		dialog.style.border = '1px solid var(--vscode-panel-border)';
		dialog.style.borderRadius = '8px';
		dialog.style.width = '500px';
		dialog.style.display = 'flex';
		dialog.style.flexDirection = 'column';
		dialog.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.35)';
		dialog.onclick = (e) => e.stopPropagation();

		const dHeader = $('div');
		dHeader.style.display = 'flex';
		dHeader.style.alignItems = 'center';
		dHeader.style.justifyContent = 'space-between';
		dHeader.style.padding = '16px 20px 12px';

		const dTitle = $('h3');
		dTitle.textContent = 'Paste SKILL.md Content';
		dTitle.style.margin = '0';
		dTitle.style.fontSize = '16px';
		dTitle.style.fontWeight = '600';
		dHeader.appendChild(dTitle);

		const dClose = $('button') as HTMLButtonElement;
		dClose.textContent = '\u2715';
		dClose.style.padding = '4px 8px';
		dClose.style.background = 'transparent';
		dClose.style.color = 'var(--vscode-descriptionForeground)';
		dClose.style.border = 'none';
		dClose.style.borderRadius = '4px';
		dClose.style.cursor = 'pointer';
		dClose.style.fontSize = '14px';
		dClose.onclick = () => overlay.remove();
		dHeader.appendChild(dClose);

		dialog.appendChild(dHeader);

		const dBody = $('div');
		dBody.style.padding = '8px 20px 16px';

		const textarea = $('textarea') as HTMLTextAreaElement;
		textarea.placeholder = 'Paste the SKILL.md content here...\n\n---\nname: my-skill\ndescription: ...\n---\nSkill body...';
		textarea.style.width = '100%';
		textarea.style.height = '200px';
		textarea.style.padding = '10px';
		textarea.style.fontSize = '12px';
		textarea.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
		textarea.style.border = '1px solid var(--vscode-input-border)';
		textarea.style.borderRadius = '4px';
		textarea.style.background = 'var(--vscode-input-background)';
		textarea.style.color = 'var(--vscode-input-foreground)';
		textarea.style.resize = 'vertical';
		textarea.style.outline = 'none';
		textarea.style.boxSizing = 'border-box';
		dBody.appendChild(textarea);

		dialog.appendChild(dBody);

		const dFooter = $('div');
		dFooter.style.display = 'flex';
		dFooter.style.justifyContent = 'flex-end';
		dFooter.style.gap = '8px';
		dFooter.style.padding = '12px 20px';
		dFooter.style.borderTop = '1px solid var(--vscode-panel-border)';

		const cancelBtn = $('button') as HTMLButtonElement;
		cancelBtn.textContent = 'Cancel';
		cancelBtn.style.padding = '8px 16px';
		cancelBtn.style.fontSize = '13px';
		cancelBtn.style.background = 'var(--vscode-button-secondaryBackground)';
		cancelBtn.style.color = 'var(--vscode-button-secondaryForeground)';
		cancelBtn.style.border = 'none';
		cancelBtn.style.borderRadius = '4px';
		cancelBtn.style.cursor = 'pointer';
		cancelBtn.onclick = () => overlay.remove();
		dFooter.appendChild(cancelBtn);

		const installBtn = $('button') as HTMLButtonElement;
		installBtn.textContent = 'Install';
		installBtn.style.padding = '8px 20px';
		installBtn.style.fontSize = '13px';
		installBtn.style.fontWeight = '500';
		installBtn.style.background = 'var(--vscode-button-background)';
		installBtn.style.color = 'var(--vscode-button-foreground)';
		installBtn.style.border = 'none';
		installBtn.style.borderRadius = '4px';
		installBtn.style.cursor = 'pointer';
		installBtn.onclick = async () => {
			const content = textarea.value.trim();
			if (!content) { return; }
			installBtn.textContent = 'Installing...';
			installBtn.disabled = true;
			const result = await this.skillInstallService.installFromContent(content);
			if (result.success) {
				overlay.remove();
				void this.skillRegistry.reload();
				this._renderContent();
			} else {
				installBtn.textContent = 'Install';
				installBtn.disabled = false;
				await this.dialogService.info(
					`Failed to install: ${result.error ?? 'Unknown error'}`,
					'Installation Failed'
				);
			}
		};
		dFooter.appendChild(installBtn);

		dialog.appendChild(dFooter);
		overlay.appendChild(dialog);
		this._container.appendChild(overlay);
	}

	// ── Helpers ─────────────────────────────────────────────────────

	private async _fetchUrlContent(url: string): Promise<string | undefined> {
		try {
			const response = await fetch(url);
			if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
			return await response.text();
		} catch {
			return undefined;
		}
	}
}
