/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/wikiView.css';

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
import { ILogService } from '../../../../../platform/log/common/log.js';
import { $ } from '../../../../../base/browser/dom.js';
import { IWikiTagService } from '../services/wikiTagService.js';
import { TAG_LEVEL_COLORS, REJECTION_REASONS } from '../../common/wikiTagTypes.js';
import type { IProposalItem, IStagingItem, ITagTreeNode, IEntityEntry, TagLevel } from '../../common/wikiTagTypes.js';

type WikiTab = 'review' | 'tree' | 'settings';

export class WikiViewPane extends ViewPane {

	private _body: HTMLElement | undefined;
	private _contentArea: HTMLElement | undefined;

	// State
	private _activeTab: WikiTab = 'review';

	// Auto-refresh timer (disabled)

	// Data cache
	private _proposals: IProposalItem[] = [];
	private _stagingItems: IStagingItem[] = [];
	private _tagTree: ITagTreeNode[] = [];
	private _entities: Record<string, IEntityEntry> = {};

	// Collapse states
	private _reviewCollapsed = false;
	private _stagingCollapsed = false;

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
		@IWikiTagService private readonly wikiTagService: IWikiTagService,
		@ILogService private readonly logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.wikiTagService.onDidChangeProposals(() => {
			if (this._activeTab === 'review') {
				this._loadReviewTab();
			}
		}));
		this._register(this.wikiTagService.onDidChangeStaging(() => {
			if (this._activeTab === 'review') {
				this._loadReviewTab();
			}
		}));
		this._register(this.wikiTagService.onDidChangeLibrary(() => {
			if (this._activeTab === 'tree') {
				this._loadTreeTab();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._body = container;
		this._body.classList.add('wiki-view');

		// Tab bar
		const tabBar = $('div.wiki-tabs');
		this._renderTabBar(tabBar);
		this._body.appendChild(tabBar);

		// Content area
		this._contentArea = $('div.wiki-content');
		this._body.appendChild(this._contentArea);

		// Initial render
		this._renderCurrentTab();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	// ─── Tab bar ─────────────────────────────────────────────

	private _renderTabBar(container: HTMLElement): void {
		const tabs: { key: WikiTab; label: string }[] = [
			{ key: 'review', label: '审核 & 入库' },
			{ key: 'tree', label: '标签树' },
		];

		for (const tab of tabs) {
			const btn = $('button.wiki-tab');
			btn.textContent = tab.label;
			if (tab.key === this._activeTab) {
				btn.classList.add('active');
			}
			btn.onclick = () => {
				this._activeTab = tab.key;
				container.querySelectorAll('.wiki-tab').forEach(el => el.classList.remove('active'));
				btn.classList.add('active');
				this._renderCurrentTab();
			};
			container.appendChild(btn);
		}

		// Settings button (gear icon)
		const settingsBtn = $('button.wiki-tab-settings');
		settingsBtn.textContent = '\u2699';
		settingsBtn.title = '设置';
		settingsBtn.onclick = () => {
			this._activeTab = 'settings';
			container.querySelectorAll('.wiki-tab').forEach(el => el.classList.remove('active'));
			settingsBtn.classList.add('active');
			this._renderCurrentTab();
		};
		if (this._activeTab === 'settings') {
			settingsBtn.classList.add('active');
		}
		container.appendChild(settingsBtn);

		// Refresh button
		const refreshBtn = $('button.wiki-tab-refresh');
		refreshBtn.textContent = '\u21BB';
		refreshBtn.title = '刷新';
		refreshBtn.onclick = () => {
			this._renderCurrentTab();
		};
		container.appendChild(refreshBtn);
	}

	// ─── Tab routing ─────────────────────────────────────────

	private _renderCurrentTab(): void {
		if (!this._contentArea) { return; }
		this._contentArea.replaceChildren();

		switch (this._activeTab) {
			case 'review':
				this._loadReviewTab();
				break;
			case 'tree':
				this._loadTreeTab();
				break;
			case 'settings':
				this._renderSettingsTab();
				break;
		}
	}

	// ═══════════════════════════════════════════════════════════
	// Tab 1: 审核 & 入库
	// ═══════════════════════════════════════════════════════════

	private async _loadReviewTab(): Promise<void> {
		if (!this._contentArea) { return; }
		this._contentArea.replaceChildren();

		const loading = $('div.wiki-loading');
		loading.textContent = '加载中...';
		this._contentArea.appendChild(loading);

		try {
			[this._proposals, this._stagingItems] = await Promise.all([
				this.wikiTagService.getProposals(),
				this.wikiTagService.getStagingItems(),
			]);
			this._contentArea.replaceChildren();
			this._renderReviewTab();
		} catch (err) {
			this._contentArea.replaceChildren();
			this._renderError(err instanceof Error ? err.message : String(err));
		}
	}

	private _renderReviewTab(): void {
		if (!this._contentArea) { return; }

		// ─── 待审核 section ───
		this._renderCollapsibleSection(
			this._contentArea,
			'待审核',
			this._proposals.length,
			this._reviewCollapsed,
			(collapsed) => { this._reviewCollapsed = collapsed; },
			(container) => { this._renderProposalsList(container); }
		);

		// ─── 待入库 section ───
		this._renderCollapsibleSection(
			this._contentArea,
			'待入库',
			this._stagingItems.length,
			this._stagingCollapsed,
			(collapsed) => { this._stagingCollapsed = collapsed; },
			(container) => { this._renderStagingList(container); }
		);
	}

	private _renderCollapsibleSection(
		parent: HTMLElement,
		title: string,
		count: number,
		isCollapsed: boolean,
		onToggle: (collapsed: boolean) => void,
		renderContent: (container: HTMLElement) => void,
	): void {
		const section = $('div.wiki-collapsible');

		// Header
		const header = $('div.wiki-collapsible-header');
		const arrow = $('span.wiki-collapsible-arrow');
		arrow.textContent = isCollapsed ? '\u25B6' : '\u25BC';
		header.appendChild(arrow);

		const titleEl = $('span.wiki-collapsible-title');
		titleEl.textContent = title;
		header.appendChild(titleEl);

		const badge = $('span.wiki-collapsible-badge');
		badge.textContent = String(count);
		badge.classList.add(count > 0 ? 'has-items' : 'empty');
		header.appendChild(badge);

		// Content
		const contentEl = $('div.wiki-collapsible-content');
		contentEl.style.display = isCollapsed ? 'none' : 'block';
		renderContent(contentEl);

		// Use local mutable state to track collapsed within this closure
		let collapsed = isCollapsed;
		header.onclick = () => {
			collapsed = !collapsed;
			onToggle(collapsed);
			arrow.textContent = collapsed ? '\u25B6' : '\u25BC';
			contentEl.style.display = collapsed ? 'none' : 'block';
		};

		section.appendChild(header);
		section.appendChild(contentEl);

		parent.appendChild(section);
	}

	// ─── Proposals list ──────────────────────────────────────

	private _renderProposalsList(container: HTMLElement): void {
		if (this._proposals.length === 0) {
			const empty = $('div.wiki-empty-inline');
			empty.textContent = '暂无待审核项';
			container.appendChild(empty);
			return;
		}

		for (const proposal of this._proposals) {
			container.appendChild(this._renderProposalCard(proposal));
		}
	}

	private _renderProposalCard(proposal: IProposalItem): HTMLElement {
		const card = $('div.wiki-proposal-card');

		// Color bar
		const colorBar = $('div.wiki-level-bar');
		colorBar.style.background = TAG_LEVEL_COLORS[proposal.level];
		card.appendChild(colorBar);

		// Content area
		const content = $('div.wiki-card-content');

		// First row: level label + name
		const titleRow = $('div.wiki-card-title-row');
		const levelLabel = $('span.wiki-level-label');
		levelLabel.textContent = proposal.level.toUpperCase();
		levelLabel.style.color = TAG_LEVEL_COLORS[proposal.level];
		titleRow.appendChild(levelLabel);

		const nameEl = $('span.wiki-card-name');
		nameEl.textContent = proposal.name;
		titleRow.appendChild(nameEl);
		content.appendChild(titleRow);

		// Description
		if (proposal.description) {
			const desc = $('p.wiki-card-desc');
			desc.textContent = proposal.description;
			content.appendChild(desc);
		}

		// Belongs-to path (for L1/L2)
		if (proposal.domain) {
			const path = $('p.wiki-card-path');
			let pathText = `\u6240\u5C5E: ${proposal.domain}`;
			if (proposal.parentL1) {
				pathText += ` \u2192 ${proposal.parentL1}`;
			}
			path.textContent = pathText;
			content.appendChild(path);
		}

		// Similar tags warning
		if (proposal.similar_existing && proposal.similar_existing.length > 0) {
			const warning = $('p.wiki-card-warning');
			warning.textContent = `\u26A0 \u8FD1\u4F3C: ${proposal.similar_existing.join(', ')}`;
			content.appendChild(warning);
		}

		card.appendChild(content);

		// Actions
		const actions = $('div.wiki-card-actions');

		const approveBtn = $('button.wiki-btn-approve') as HTMLButtonElement;
		approveBtn.textContent = '\u901A\u8FC7';
		approveBtn.onclick = async (e) => {
			e.stopPropagation();
			approveBtn.disabled = true;
			try {
				await this.wikiTagService.approveProposal(proposal.id);
			} catch (err) {
				this.logService.warn(`[WikiView] approve failed: ${err}`);
				approveBtn.disabled = false;
			}
		};
		actions.appendChild(approveBtn);

		const rejectBtn = $('button.wiki-btn-reject') as HTMLButtonElement;
		rejectBtn.textContent = '\u62D2\u7EDD';
		rejectBtn.onclick = async (e) => {
			e.stopPropagation();
			this._showRejectReasonDialog(proposal);
		};
		actions.appendChild(rejectBtn);

		card.appendChild(actions);

		return card;
	}

	// ─── Staging list ────────────────────────────────────────

	private _renderStagingList(container: HTMLElement): void {
		if (this._stagingItems.length === 0) {
			const empty = $('div.wiki-empty-inline');
			empty.textContent = '暂无待入库项';
			container.appendChild(empty);
			return;
		}

		for (const item of this._stagingItems) {
			container.appendChild(this._renderStagingCard(item));
		}
	}

	private _renderStagingCard(item: IStagingItem): HTMLElement {
		const card = $('div.wiki-staging-card');

		// Color bar
		const colorBar = $('div.wiki-level-bar');
		colorBar.style.background = TAG_LEVEL_COLORS[item.level];
		card.appendChild(colorBar);

		// Content area
		const content = $('div.wiki-card-content');

		// Title row with editable input
		const titleRow = $('div.wiki-card-title-row');
		const levelLabel = $('span.wiki-level-label');
		levelLabel.textContent = item.level.toUpperCase();
		levelLabel.style.color = TAG_LEVEL_COLORS[item.level];
		titleRow.appendChild(levelLabel);

		const nameInput = $('input.wiki-staging-input') as HTMLInputElement;
		nameInput.type = 'text';
		nameInput.value = item.name;
		titleRow.appendChild(nameInput);
		content.appendChild(titleRow);

		// Description
		if (item.description) {
			const desc = $('p.wiki-card-desc');
			desc.textContent = item.description;
			content.appendChild(desc);
		}

		// Belongs-to path
		if (item.domain) {
			const path = $('p.wiki-card-path');
			let pathText = `\u6240\u5C5E: ${item.domain}`;
			if (item.parentL1) {
				pathText += ` \u2192 ${item.parentL1}`;
			}
			path.textContent = pathText;
			content.appendChild(path);
		}

		// Validation status
		const validationEl = $('p.wiki-validation-status');
		validationEl.classList.add('valid');
		validationEl.textContent = '\u2713 \u540D\u79F0\u53EF\u7528';
		content.appendChild(validationEl);

		// Name input validation
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		nameInput.oninput = () => {
			if (debounceTimer) { clearTimeout(debounceTimer); }
			debounceTimer = setTimeout(async () => {
				const newName = nameInput.value.trim();
				if (!newName || newName === item.name) {
					validationEl.className = 'wiki-validation-status valid';
					validationEl.textContent = '\u2713 \u540D\u79F0\u53EF\u7528';
					return;
				}
				const result = await this.wikiTagService.validateName(item.id, newName);
				if (result.valid) {
					validationEl.className = 'wiki-validation-status valid';
					validationEl.textContent = '\u2713 \u540D\u79F0\u53EF\u7528';
				} else {
					validationEl.className = 'wiki-validation-status invalid';
					validationEl.textContent = `\u2717 ${result.message}`;
				}
			}, 300);
		};

		card.appendChild(content);

		// Actions
		const actions = $('div.wiki-card-actions');

		const commitBtn = $('button.wiki-btn-commit') as HTMLButtonElement;
		commitBtn.textContent = '\u5165\u5E93';
		commitBtn.onclick = async (e) => {
			e.stopPropagation();
			// First rename if changed
			const currentName = nameInput.value.trim();
			if (currentName && currentName !== item.name) {
				const renameResult = await this.wikiTagService.renameStagingItem(item.id, currentName);
				if (!renameResult.valid) {
					validationEl.className = 'wiki-validation-status invalid';
					validationEl.textContent = `\u2717 ${renameResult.message}`;
					return;
				}
			}
			commitBtn.disabled = true;
			try {
				await this.wikiTagService.commitToLibrary(item.id);
			} catch (err) {
				this.logService.warn(`[WikiView] commit failed: ${err}`);
				commitBtn.disabled = false;
			}
		};
		actions.appendChild(commitBtn);

		card.appendChild(actions);

		return card;
	}

	// ═══════════════════════════════════════════════════════════
	// Tab 2: 标签树
	// ═══════════════════════════════════════════════════════════

	private async _loadTreeTab(): Promise<void> {
		if (!this._contentArea) { return; }
		this._contentArea.replaceChildren();

		const loading = $('div.wiki-loading');
		loading.textContent = '加载中...';
		this._contentArea.appendChild(loading);

		try {
			[this._tagTree, this._entities] = await Promise.all([
				this.wikiTagService.getTagTree(),
				this.wikiTagService.listEntities(),
			]);
			this._contentArea.replaceChildren();
			this._renderTreeTab();
		} catch (err) {
			this._contentArea.replaceChildren();
			this._renderError(err instanceof Error ? err.message : String(err));
		}
	}

	private _renderTreeTab(): void {
		if (!this._contentArea) { return; }

		const treeContainer = $('div.wiki-tree');

		if (this._tagTree.length === 0 && Object.keys(this._entities).length === 0) {
			const empty = $('div.wiki-empty-inline');
			empty.textContent = '暂无已入库标签';
			treeContainer.appendChild(empty);
			this._contentArea.appendChild(treeContainer);
			return;
		}

		// Domain tree
		for (const domainNode of this._tagTree) {
			treeContainer.appendChild(this._renderTreeNode(domainNode, 0, domainNode.name));
		}

		// Entity section (separated)
		const entityNames = Object.keys(this._entities);
		if (entityNames.length > 0) {
			const separator = $('div.wiki-tree-separator');
			treeContainer.appendChild(separator);

			const entityHeader = $('div.wiki-tree-entity-header');
			const dot = $('div.wiki-tree-dot');
			dot.style.background = TAG_LEVEL_COLORS.entity;
			entityHeader.appendChild(dot);
			const label = $('span.wiki-tree-entity-label');
			label.textContent = '\u5168\u5C40 Entity';
			entityHeader.appendChild(label);
			treeContainer.appendChild(entityHeader);

			const entityList = $('div.wiki-tree-entity-list');
			for (const name of entityNames) {
				const item = $('div.wiki-tree-entity-item');
				const itemDot = $('div.wiki-tree-dot-sm');
				itemDot.style.background = TAG_LEVEL_COLORS.entity;
				item.appendChild(itemDot);
				const nameEl = $('span');
				nameEl.textContent = name;
				item.appendChild(nameEl);

				// Entity actions (rename / delete)
				const actions = $('div.wiki-tree-actions');
				const renameBtn = $('button.wiki-tree-action-btn');
				renameBtn.textContent = '\u270E';
				renameBtn.title = '重命名';
				renameBtn.onclick = (e) => {
					e.stopPropagation();
					this._startRename(item, 'entity', name);
				};
				actions.appendChild(renameBtn);

				const deleteBtn = $('button.wiki-tree-action-btn.danger');
				deleteBtn.textContent = '\u2715';
				deleteBtn.title = '删除';
				deleteBtn.onclick = (e) => {
					e.stopPropagation();
					this._confirmDelete('entity', name);
				};
				actions.appendChild(deleteBtn);
				item.appendChild(actions);

				entityList.appendChild(item);
			}
			treeContainer.appendChild(entityList);
		}

		this._contentArea.appendChild(treeContainer);

		// Legend
		this._renderLegend();
	}

	private _renderTreeNode(node: ITagTreeNode, depth: number, domainName: string): HTMLElement {
		const wrapper = $('div.wiki-tree-node');
		wrapper.style.paddingLeft = `${depth * 20}px`;

		const row = $('div.wiki-tree-row');

		// Color dot
		const dot = $('div.wiki-tree-dot');
		dot.style.background = TAG_LEVEL_COLORS[node.level];
		row.appendChild(dot);

		// Expand/collapse arrow (if has children)
		const hasChildren = node.children.length > 0;
		const arrow = $('span.wiki-tree-arrow');
		if (hasChildren) {
			arrow.textContent = '\u25BC';
			arrow.classList.add('clickable');
		}
		row.appendChild(arrow);

		// Name
		const nameEl = $('span.wiki-tree-name');
		nameEl.textContent = node.name;
		if (node.level === 'domain' || node.level === 'L1') {
			nameEl.classList.add('bold');
		}
		row.appendChild(nameEl);

		// Level hint
		const levelHint = $('span.wiki-tree-level-hint');
		levelHint.textContent = node.level === 'domain' ? 'Domain' : node.level;
		row.appendChild(levelHint);

		// Actions (rename / delete)
		const actions = $('div.wiki-tree-actions');
		const renameBtn = $('button.wiki-tree-action-btn');
		renameBtn.textContent = '\u270E';
		renameBtn.title = '重命名';
		renameBtn.onclick = (e) => {
			e.stopPropagation();
			this._startRename(row, node.level, node.name, domainName);
		};
		actions.appendChild(renameBtn);

		const deleteBtn = $('button.wiki-tree-action-btn.danger');
		deleteBtn.textContent = '\u2715';
		deleteBtn.title = '删除';
		deleteBtn.onclick = (e) => {
			e.stopPropagation();
			this._confirmDelete(node.level, node.name, domainName);
		};
		actions.appendChild(deleteBtn);
		row.appendChild(actions);

		wrapper.appendChild(row);

		// Children container
		if (hasChildren) {
			const childrenEl = $('div.wiki-tree-children');
			const connector = $('div.wiki-tree-connector');
			childrenEl.appendChild(connector);

			const childContent = $('div.wiki-tree-child-content');
			for (const child of node.children) {
				childContent.appendChild(this._renderTreeNode(child, 0, domainName));
			}
			childrenEl.appendChild(childContent);
			wrapper.appendChild(childrenEl);

			// Toggle
			let expanded = true;
			row.onclick = () => {
				expanded = !expanded;
				arrow.textContent = expanded ? '\u25BC' : '\u25B6';
				childrenEl.style.display = expanded ? 'flex' : 'none';
			};
			row.style.cursor = 'pointer';
		}

		return wrapper;
	}

	// ─── Rename inline ──────────────────────────────────────

	private _startRename(rowOrItem: HTMLElement, level: TagLevel, currentName: string, domain?: string): void {
		// Find the name span
		const nameEl = rowOrItem.querySelector('.wiki-tree-name, span:not(.wiki-tree-arrow):not(.wiki-tree-level-hint)') as HTMLElement | null;
		if (!nameEl) { return; }

		// Replace name with input
		const originalText = nameEl.textContent ?? currentName;
		const input = document.createElement('input');
		input.className = 'wiki-tree-rename-input';
		input.type = 'text';
		input.value = currentName;
		input.style.width = `${Math.max(80, currentName.length * 8 + 20)}px`;

		// Validation message
		const validationMsg = document.createElement('span');
		validationMsg.className = 'wiki-tree-rename-validation';

		nameEl.replaceWith(input);
		input.after(validationMsg);
		input.focus();
		input.select();

		// Hide actions and level hint during rename
		const actions = rowOrItem.querySelector('.wiki-tree-actions') as HTMLElement | null;
		const levelHint = rowOrItem.querySelector('.wiki-tree-level-hint') as HTMLElement | null;
		if (actions) { actions.style.display = 'none'; }
		if (levelHint) { levelHint.style.display = 'none'; }

		let debounceTimer: ReturnType<typeof setTimeout> | undefined;

		const doValidation = () => {
			if (debounceTimer) { clearTimeout(debounceTimer); }
			debounceTimer = setTimeout(async () => {
				const newName = input.value.trim();
				if (!newName || newName === currentName) {
					validationMsg.textContent = '';
					validationMsg.className = 'wiki-tree-rename-validation';
					input.classList.remove('invalid');
					return;
				}
				const result = await this.wikiTagService.validateTagRename(level, currentName, newName, domain);
				if (result.valid) {
					validationMsg.textContent = '\u2713 可用';
					validationMsg.className = 'wiki-tree-rename-validation valid';
					input.classList.remove('invalid');
				} else {
					validationMsg.textContent = `\u2717 ${result.message}`;
					validationMsg.className = 'wiki-tree-rename-validation invalid';
					input.classList.add('invalid');
				}
			}, 200);
		};

		input.oninput = doValidation;

		const finishRename = async (commit: boolean) => {
			if (debounceTimer) { clearTimeout(debounceTimer); }
			const newName = input.value.trim();

			if (commit && newName && newName !== currentName) {
				const result = await this.wikiTagService.renameTag(level, currentName, newName, domain);
				if (!result.valid) {
					// Show error briefly then revert
					validationMsg.textContent = `\u2717 ${result.message}`;
					validationMsg.className = 'wiki-tree-rename-validation invalid';
					setTimeout(() => revert(), 1500);
					return;
				}
				// Success — refresh the tree
				this._loadTreeTab();
				return;
			}
			revert();
		};

		const revert = () => {
			const newNameEl = document.createElement('span');
			newNameEl.className = 'wiki-tree-name';
			if (level === 'domain' || level === 'L1') {
				newNameEl.classList.add('bold');
			}
			newNameEl.textContent = originalText;
			input.replaceWith(newNameEl);
			validationMsg.remove();
			if (actions) { actions.style.display = ''; }
			if (levelHint) { levelHint.style.display = ''; }
		};

		input.onkeydown = (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				finishRename(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				finishRename(false);
			}
		};

		input.onblur = () => {
			// Small delay to allow click handlers
			setTimeout(() => finishRename(false), 150);
		};
	}

	// ─── Delete confirm ─────────────────────────────────────

	private _confirmDelete(level: TagLevel, name: string, domain?: string): void {
		if (!this._contentArea) { return; }

		// Collect items that will be deleted
		const itemsToDelete: Array<{ name: string; level: string }> = [];
		this._collectDeletionItems(level, name, domain, itemsToDelete);

		// Create overlay
		const overlay = $('div.wiki-delete-overlay');

		const dialog = $('div.wiki-delete-dialog');

		// Title
		const title = $('h3.wiki-delete-title');
		title.textContent = '确认删除标签';
		dialog.appendChild(title);

		// Description
		const desc = $('p.wiki-delete-desc');
		if (itemsToDelete.length > 1) {
			desc.textContent = `删除 "${name}" (${level === 'domain' ? 'Domain' : level}) 将同时移除其下所有子标签：`;
		} else {
			desc.textContent = `确定删除 "${name}" (${level === 'domain' ? 'Domain' : level === 'entity' ? 'Entity' : level})？`;
		}
		dialog.appendChild(desc);

		// Item list
		if (itemsToDelete.length > 0) {
			const list = $('div.wiki-delete-list');
			for (const item of itemsToDelete) {
				const itemEl = $('div.wiki-delete-list-item');
				const dot = $('span.wiki-delete-dot');
				dot.style.background = TAG_LEVEL_COLORS[item.level as keyof typeof TAG_LEVEL_COLORS] ?? '#888';
				itemEl.appendChild(dot);
				const label = $('span');
				label.textContent = `${item.name} (${item.level})`;
				itemEl.appendChild(label);
				list.appendChild(itemEl);
			}
			dialog.appendChild(list);
		}

		// Info about deletion record
		const info = $('p.wiki-delete-info');
		info.textContent = '删除记录将写入 deletions.json，LLM 将自动处理关联的知识块清理。';
		dialog.appendChild(info);

		// Buttons
		const btns = $('div.wiki-delete-btns');

		const cancelBtn = $('button.wiki-delete-cancel');
		cancelBtn.textContent = '取消';
		cancelBtn.onclick = () => { overlay.remove(); };
		btns.appendChild(cancelBtn);

		const confirmBtn = $('button.wiki-delete-confirm') as HTMLButtonElement;
		confirmBtn.textContent = `确认删除 (${itemsToDelete.length}项)`;
		confirmBtn.onclick = async () => {
			confirmBtn.disabled = true;
			confirmBtn.textContent = '删除中...';
			try {
				await this.wikiTagService.deleteTag(level, name, domain);
				overlay.remove();
				// Refresh
				this._loadTreeTab();
			} catch (err) {
				this.logService.warn(`[WikiView] delete failed: ${err}`);
				confirmBtn.disabled = false;
				confirmBtn.textContent = `确认删除 (${itemsToDelete.length}项)`;
			}
		};
		btns.appendChild(confirmBtn);

		dialog.appendChild(btns);
		overlay.appendChild(dialog);

		// Add to content area (on top)
		this._contentArea.appendChild(overlay);
	}

	private _collectDeletionItems(level: TagLevel, name: string, domain: string | undefined, items: Array<{ name: string; level: string }>): void {
		if (level === 'domain') {
			// Find this domain in the tree
			const domainNode = this._tagTree.find(d => d.name === name);
			if (domainNode) {
				for (const child of domainNode.children) {
					if (child.level === 'L1') {
						for (const l2 of child.children) {
							items.push({ name: l2.name, level: 'L2' });
						}
					}
					items.push({ name: child.name, level: child.level });
				}
			}
			items.push({ name, level: 'Domain' });
		} else if (level === 'entity') {
			items.push({ name, level: 'Entity' });
		} else if (level === 'L1') {
			// Find L1 in tree and get L2 children
			const domainNode = this._tagTree.find(d => d.name === domain);
			if (domainNode) {
				const l1Node = domainNode.children.find(c => c.name === name && c.level === 'L1');
				if (l1Node) {
					for (const l2 of l1Node.children) {
						items.push({ name: l2.name, level: 'L2' });
					}
				}
			}
			items.push({ name, level: 'L1' });
		} else {
			items.push({ name, level: 'L2' });
		}
	}

	private _renderLegend(): void {
		if (!this._contentArea) { return; }

		const legend = $('div.wiki-legend');
		const levels: Array<{ key: string; color: string }> = [
			{ key: 'Domain', color: TAG_LEVEL_COLORS.domain },
			{ key: 'Entity', color: TAG_LEVEL_COLORS.entity },
			{ key: 'L1', color: TAG_LEVEL_COLORS.L1 },
			{ key: 'L2', color: TAG_LEVEL_COLORS.L2 },
		];

		for (const { key, color } of levels) {
			const item = $('div.wiki-legend-item');
			const dot = $('div.wiki-legend-dot');
			dot.style.background = color;
			item.appendChild(dot);
			const label = $('span.wiki-legend-label');
			label.textContent = key;
			item.appendChild(label);
			legend.appendChild(item);
		}

		this._contentArea.appendChild(legend);
	}

	// ─── Reject reason dialog ──────────────────────────────

	private _showRejectReasonDialog(proposal: IProposalItem): void {
		if (!this._contentArea) { return; }

		// Create overlay
		const overlay = $('div.wiki-reject-overlay');

		const dialog = $('div.wiki-reject-dialog');

		// Title
		const title = $('h3.wiki-reject-title');
		title.textContent = '拒绝原因';
		dialog.appendChild(title);

		// Subtitle: which proposal
		const subtitle = $('p.wiki-reject-subtitle');
		subtitle.textContent = `拒绝标签: ${proposal.name} (${proposal.level.toUpperCase()})`;
		dialog.appendChild(subtitle);

		// Radio options
		const optionsContainer = $('div.wiki-reject-options');
		let selectedReason: string | null = null;

		for (const reason of REJECTION_REASONS) {
			const option = $('label.wiki-reject-option');

			const radio = $('input') as HTMLInputElement;
			radio.type = 'radio';
			radio.name = 'reject-reason';
			radio.value = reason;
			radio.className = 'wiki-reject-radio';
			radio.onchange = () => {
				selectedReason = reason;
				customInput.value = '';
				customInput.classList.remove('active');
			};
			option.appendChild(radio);

			const label = $('span.wiki-reject-option-text');
			label.textContent = reason;
			option.appendChild(label);

			optionsContainer.appendChild(option);
		}

		// Custom reason option
		const customOption = $('label.wiki-reject-option');
		const customRadio = $('input') as HTMLInputElement;
		customRadio.type = 'radio';
		customRadio.name = 'reject-reason';
		customRadio.value = '__custom__';
		customRadio.className = 'wiki-reject-radio';
		customOption.appendChild(customRadio);

		const customLabel = $('span.wiki-reject-option-text');
		customLabel.textContent = '其他原因';
		customOption.appendChild(customLabel);
		optionsContainer.appendChild(customOption);

		dialog.appendChild(optionsContainer);

		// Custom input
		const customInput = $('input.wiki-reject-custom-input') as HTMLInputElement;
		customInput.type = 'text';
		customInput.placeholder = '输入自定义拒绝原因...';
		customInput.onfocus = () => {
			customRadio.checked = true;
			customInput.classList.add('active');
		};
		customInput.oninput = () => {
			selectedReason = customInput.value.trim() || null;
		};
		customRadio.onchange = () => {
			selectedReason = customInput.value.trim() || null;
			customInput.classList.add('active');
			customInput.focus();
		};
		dialog.appendChild(customInput);

		// Buttons
		const btns = $('div.wiki-reject-btns');

		const cancelBtn = $('button.wiki-reject-cancel');
		cancelBtn.textContent = '取消';
		cancelBtn.onclick = () => { overlay.remove(); };
		btns.appendChild(cancelBtn);

		const confirmBtn = $('button.wiki-reject-confirm') as HTMLButtonElement;
		confirmBtn.textContent = '确认拒绝';
		confirmBtn.onclick = async () => {
			// Allow rejection without reason (reason is optional)
			const reason = selectedReason || undefined;
			confirmBtn.disabled = true;
			confirmBtn.textContent = '处理中...';
			try {
				await this.wikiTagService.rejectProposal(proposal.id, reason);
				overlay.remove();
			} catch (err) {
				this.logService.warn(`[WikiView] reject failed: ${err}`);
				confirmBtn.disabled = false;
				confirmBtn.textContent = '确认拒绝';
			}
		};
		btns.appendChild(confirmBtn);

		dialog.appendChild(btns);
		overlay.appendChild(dialog);
		this._contentArea.appendChild(overlay);
	}

	// ─── Utility renderers ───────────────────────────────────

	private _renderError(message: string): void {
		if (!this._contentArea) { return; }
		const errEl = $('div.wiki-error');
		errEl.textContent = message;
		this._contentArea.appendChild(errEl);
	}

	// ═══════════════════════════════════════════════════════════
	// Tab 3: 设置
	// ═══════════════════════════════════════════════════════════

	private async _renderSettingsTab(): Promise<void> {
		if (!this._contentArea) { return; }

		const settings = await this.wikiTagService.getSettings();

		const container = $('div.wiki-settings');

		// Title
		const title = $('h3.wiki-settings-title');
		title.textContent = '设置';
		container.appendChild(title);

		// ─── Wiki 数据目录 ───
		const pathField = this._createSettingsField(
			'Wiki 数据目录',
			'本地 LLM-Wiki 的存储路径',
			settings.wikiRoot,
			'E:/AITools/LLM-Wiki'
		);
		container.appendChild(pathField.container);

		// ─── 最大提议数量 ───
		const maxField = this._createSettingsField(
			'单次最大提议数量',
			'LLM 单次 propose 调用允许的最大标签数',
			String(settings.maxProposalCount),
			'20'
		);
		container.appendChild(maxField.container);

		// ─── Save button ───
		const actions = $('div.wiki-settings-actions');
		const saveBtn = $('button.wiki-btn-commit') as HTMLButtonElement;
		saveBtn.textContent = '保存设置';
		saveBtn.onclick = async () => {
			const newPath = pathField.input.value.trim();
			const newMax = parseInt(maxField.input.value.trim(), 10);

			if (!newPath) {
				this._renderSettingsMessage(container, '路径不能为空', true);
				return;
			}
			if (isNaN(newMax) || newMax < 1 || newMax > 100) {
				this._renderSettingsMessage(container, '数量必须为 1-100 之间的整数', true);
				return;
			}

			saveBtn.disabled = true;
			saveBtn.textContent = '保存中...';
			try {
				await this.wikiTagService.saveSettings({
					wikiRoot: newPath,
					maxProposalCount: newMax,
				});
				this._renderSettingsMessage(container, '设置已保存', false);
			} catch (err) {
				this._renderSettingsMessage(container, `保存失败: ${err instanceof Error ? err.message : String(err)}`, true);
			} finally {
				saveBtn.disabled = false;
				saveBtn.textContent = '保存设置';
			}
		};
		actions.appendChild(saveBtn);
		container.appendChild(actions);

		this._contentArea.appendChild(container);
	}

	private _createSettingsField(
		labelText: string,
		hint: string,
		value: string,
		placeholder: string,
	): { container: HTMLElement; input: HTMLInputElement } {
		const container = $('div.wiki-settings-field');

		const label = $('label.wiki-settings-label');
		label.textContent = labelText;
		container.appendChild(label);

		const input = $('input.wiki-settings-input') as HTMLInputElement;
		input.type = 'text';
		input.value = value;
		input.placeholder = placeholder;
		container.appendChild(input);

		const hintEl = $('p.wiki-settings-hint');
		hintEl.textContent = hint;
		container.appendChild(hintEl);

		return { container, input };
	}

	private _renderSettingsMessage(container: HTMLElement, message: string, isError: boolean): void {
		// Remove old message
		const old = container.querySelector('.wiki-settings-msg');
		if (old) { old.remove(); }

		const msg = $('div.wiki-settings-msg');
		msg.textContent = message;
		msg.classList.add(isError ? 'error' : 'success');
		container.appendChild(msg);
	}
}
