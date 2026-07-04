/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/pluginsView.css';

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
import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { IDisposable, dispose, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IListVirtualDelegate, IListRenderer } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { IAgentPluginService, IAgentPlugin } from '../../../../../workbench/contrib/chat/common/plugins/agentPluginService.js';
import { ContributionEnablementState, IEnablementModel, isContributionEnabled } from '../../../../../workbench/contrib/chat/common/enablement.js';
import { IObservable, autorun, derived, observableValue } from '../../../../../base/common/observable.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { Action } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { PluginDetailEditorInput } from '../pluginDetailEditorInput.js';
import { IEditorService, SIDE_GROUP } from '../../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IMarketplaceService, IMarketplacePackage, PackageKind } from '../../common/marketplace.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';

// --- Constants ---

const PLUGIN_LIST_ELEMENT_HEIGHT = 72;

const KIND_LABEL: Record<PackageKind, string> = {
	skill: 'Skill',
	agent: 'Agent',
	mcp: 'MCP',
	knowledge: '\u77E5\u8BC6\u5E93', // 知识库
	workflow: '\u5DE5\u4F5C\u6D41', // 工作流
};

const KIND_ICON: Record<PackageKind, string> = {
	skill: '\u{1F4C4}',
	agent: '\u{1F916}',
	mcp: '\u{1F50C}',
	knowledge: '\u{1F4DA}',
	workflow: '\u{1F527}',
};

// --- Data Types ---

export interface IPluginDisplayInfo {
	readonly plugin: IAgentPlugin;
	readonly label: string;
	readonly description: string;
	readonly version: string;
	readonly author: string;
	readonly enabled: boolean;
	readonly skillCount: number;
	readonly commandCount: number;
	readonly agentCount: number;
	readonly hasMcp: boolean;
}

// --- Delegate ---

class PluginListDelegate implements IListVirtualDelegate<IPluginDisplayInfo> {
	getHeight(): number { return PLUGIN_LIST_ELEMENT_HEIGHT; }
	getTemplateId(): string { return 'agentPlugin'; }
}

// --- Renderer ---

interface IPluginTemplateData {
	root: HTMLElement;
	element: HTMLElement;
	iconContainer: HTMLElement;
	name: HTMLElement;
	description: HTMLElement;
	footer: HTMLElement;
	author: HTMLElement;
	badges: HTMLElement;
	actionbar: ActionBar;
	disposables: IDisposable[];
	pluginDisposables: DisposableStore;
}

class PluginListRenderer implements IListRenderer<IPluginDisplayInfo, IPluginTemplateData> {

	constructor(
		private readonly enablementModel: IEnablementModel,
	) { }

	get templateId(): string { return 'agentPlugin'; }

	renderTemplate(container: HTMLElement): IPluginTemplateData {
		const root = container;
		const element = append(root, $('.agent-plugin-list-item'));

		// Icon
		const iconContainer = append(element, $('.icon-container'));
		const iconEl = append(iconContainer, $('span.plugin-icon-codicon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.extensions));

		// Details
		const details = append(element, $('.details'));
		const headerContainer = append(details, $('.header-container'));
		const header = append(headerContainer, $('.header'));
		const name = append(header, $('span.name'));
		const badges = append(header, $('span.badges'));
		const description = append(details, $('.description.ellipsis'));
		const footer = append(details, $('.footer'));
		const author = append(footer, $('span.author'));

		// Action bar
		const actionbar = new ActionBar(footer, { focusOnlyEnabledItems: true });
		actionbar.setFocusable(false);

		return {
			root, element, iconContainer, name, description,
			footer, author, badges, actionbar,
			disposables: [actionbar],
			pluginDisposables: new DisposableStore()
		};
	}

	renderElement(item: IPluginDisplayInfo, _index: number, data: IPluginTemplateData): void {
		// 释放之前的 DisposableStore 并创建新的
		data.pluginDisposables.dispose();
		data.pluginDisposables = new DisposableStore();

		data.name.textContent = item.label;
		data.description.textContent = item.description;
		data.author.textContent = item.author;

		data.element.classList.toggle('disabled', !item.enabled);

		// Badges
		data.badges.replaceChildren();
		if (item.skillCount > 0) {
			append(data.badges, $('span.plugin-badge')).textContent = `${item.skillCount} skill${item.skillCount > 1 ? 's' : ''}`;
		}
		if (item.commandCount > 0) {
			append(data.badges, $('span.plugin-badge')).textContent = `${item.commandCount} cmd${item.commandCount > 1 ? 's' : ''}`;
		}
		if (item.agentCount > 0) {
			append(data.badges, $('span.plugin-badge')).textContent = `${item.agentCount} agent${item.agentCount > 1 ? 's' : ''}`;
		}
		if (item.hasMcp) {
			append(data.badges, $('span.plugin-badge.mcp')).textContent = 'MCP';
		}

		// Actions
		// 使用 DisposableStore 来管理 Action 对象的生命周期
		// 这确保了 GC 追踪器能正确追踪这些对象，避免 LEAKED DISPOSABLE 警告
		const actions: Action[] = [];

		if (item.enabled) {
			actions.push(new Action(
				'agentPlugin.disable',
				localize('disable', "Disable"),
				ThemeIcon.asClassName(Codicon.eyeWatch),
				true,
				() => this._toggleEnablement(item, false)
			));
		} else {
			actions.push(new Action(
				'agentPlugin.enable',
				localize('enable', "Enable"),
				ThemeIcon.asClassName(Codicon.eye),
				true,
				() => this._toggleEnablement(item, true)
			));
		}

		actions.push(new Action(
			'agentPlugin.remove',
			localize('remove', "Remove"),
			ThemeIcon.asClassName(Codicon.trash),
			true,
			() => item.plugin.remove()
		));

		// 将创建的 Action 对象添加到 DisposableStore 中
		// 这样它们会被正确追踪和管理
		for (const action of actions) {
			data.pluginDisposables.add(action);
		}

		data.actionbar.clear();
		data.actionbar.push(actions, { icon: true, label: false });
	}

	private _toggleEnablement(item: IPluginDisplayInfo, enable: boolean): void {
		const key = item.plugin.uri.toString();
		this.enablementModel.setEnabled(
			key,
			enable ? ContributionEnablementState.EnabledProfile : ContributionEnablementState.DisabledProfile
		);
	}

	disposeTemplate(data: IPluginTemplateData): void {
		data.pluginDisposables.dispose();
		data.disposables = dispose(data.disposables);
	}
}

// --- Accessibility Provider ---

class PluginListAccessibilityProvider implements IListAccessibilityProvider<IPluginDisplayInfo> {
	getAriaLabel(item: IPluginDisplayInfo): string {
		return `${item.label}, ${item.author}, ${item.description}`;
	}
	getWidgetAriaLabel(): string {
		return localize('plugins', "Plugins");
	}
}

// --- Main ViewPane ---

/**
 * Plugins View — Plugin management sidebar.
 *
 * Data source: `IAgentPluginService.plugins` (IObservable)
 * Rendering: `WorkbenchList` with card-style renderer (mirrors VSCode Extensions view)
 */
export class PluginsViewPane extends ViewPane {

	private list: WorkbenchList<IPluginDisplayInfo> | undefined;
	private searchInput!: HTMLInputElement;
	private detailContainer: HTMLElement | undefined;
	private listContainer: HTMLElement | undefined;

	// ── Marketplace state ─────────────────────────────────
	private _marketplaceContainer!: HTMLElement;
	private _marketplaceStatusEl!: HTMLElement;
	private _marketplaceGridEl!: HTMLElement;
	private _marketplacePackages: IMarketplacePackage[] = [];
	private _marketplaceLoading = false;
	private _marketplaceError = '';
	private _installingIds: Set<string> = new Set();
	/** Set of installed storeIds (slug) for showing "已安装" badge */
	private _installedSlugs: Set<string> = new Set();

	private readonly _searchQuery = observableValue<string>('pluginsSearchQuery', '');
	private readonly _activeTab = observableValue<'installed' | 'marketplace'>('pluginsActiveTab', 'installed');
	private readonly _selectedPlugin = observableValue<IAgentPlugin | undefined>('selectedPlugin', undefined);

	private readonly _filteredPlugins: IObservable<readonly IPluginDisplayInfo[]>;

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
		@IAgentPluginService private readonly agentPluginService: IAgentPluginService,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._filteredPlugins = derived(reader => {
			const allPlugins = this.agentPluginService.plugins.read(reader);
			const query = this._searchQuery.read(reader).toLowerCase();
			const tab = this._activeTab.read(reader);

			// Only compute for 'installed' tab — marketplace is rendered separately via DOM
			if (tab === 'marketplace') {
				return [];
			}

			const displayItems = allPlugins.map(p => this._toDisplayInfo(p, reader));

			if (query) {
				return displayItems.filter(p =>
					p.label.toLowerCase().includes(query) ||
					p.description.toLowerCase().includes(query) ||
					p.author.toLowerCase().includes(query)
				);
			}

			return displayItems;
		});
	}

	override shouldShowWelcome(): boolean {
		return false;
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		console.warn('[PluginsViewPane] setVisible called:', visible, 'isExpanded:', this.isExpanded(), 'element in DOM:', !!this.element?.parentElement, 'bodyRendered:', !!(this as any)._bodyRendered);
		// Ensure the view is expanded when it becomes visible.
		// In single-view containers with mergeViewWithContainerWhenSingleView,
		// the view should always be expanded, but the container may not
		// auto-expand it if areExtensionsReady is false at creation time.
		if (visible && !this.isExpanded()) {
			console.warn('[PluginsViewPane] forcing expansion from setVisible');
			this.setExpanded(true);
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		console.warn('[PluginsViewPane] renderBody called, container:', container.tagName, container.className, 'parentElement:', container.parentElement?.tagName, container.parentElement?.className);

		// Remove .welcome class — it hides all non-.welcome-view children via
		// `.pane-body.welcome > :not(.welcome-view) { display: none }` in views.css
		container.classList.remove('welcome');
		container.classList.add('plugins-view');

		// Tabs
		const tabs = append(container, $('.plugins-tabs'));
		const installedTab = append(tabs, $('button.plugins-tab.active')) as HTMLButtonElement;
		installedTab.textContent = localize('installed', "Installed");
		installedTab.onclick = () => this._switchTab(installedTab, marketplaceTab, 'installed');

		const marketplaceTab = append(tabs, $('button.plugins-tab')) as HTMLButtonElement;
		marketplaceTab.textContent = localize('marketplace', "Marketplace");
		marketplaceTab.onclick = () => this._switchTab(installedTab, marketplaceTab, 'marketplace');

		// Search (works for both tabs)
		this.searchInput = append(container, $('input.plugins-search')) as HTMLInputElement;
		this.searchInput.placeholder = localize('searchPlugins', "Search Plugins...");
		this.searchInput.type = 'text';
		this.searchInput.oninput = () => {
			const value = this.searchInput.value;
			this._searchQuery.set(value, undefined);
			// Re-render marketplace cards on search change if marketplace tab is active
			if (this._activeTab.get() === 'marketplace' && !this._marketplaceLoading) {
				this._renderMarketplaceCards();
			}
		};

		// Installed list Container
		this.listContainer = append(container, $('.plugins-list-container'));

		// Marketplace Container (hidden by default, rendered as DOM cards)
		this._marketplaceContainer = append(container, $('.plugins-marketplace-container'));
		this._marketplaceContainer.style.display = 'none';
		this._marketplaceContainer.style.cssText = 'display:none;flex:1;overflow-y:auto;';

		// Marketplace status area (loading / error / empty)
		this._marketplaceStatusEl = append(this._marketplaceContainer, $('.plugins-marketplace-status'));

		// Marketplace card grid
		this._marketplaceGridEl = append(this._marketplaceContainer, $('.plugins-marketplace-grid'));

		// Detail Container (hidden by default)
		this.detailContainer = append(container, $('.plugins-detail-container.hidden'));

		// Fix .empty class on ancestor composite part — this class shows an
		// empty-message overlay and may prevent the composite area from rendering.
		requestAnimationFrame(() => {
			const paneCompositePart = this.element?.closest('.pane-composite-part') as HTMLElement | null;
			if (paneCompositePart) {
				paneCompositePart.classList.remove('empty');
				const emptyMessage = paneCompositePart.querySelector('.empty-pane-message-area') as HTMLElement | null;
				if (emptyMessage) {
					emptyMessage.style.display = 'none';
				}
			}

			// Diagnostic: walk entire DOM ancestor chain logging width
			console.warn('[PluginsViewPane] rAF DOM ancestor-width walk:');
			let node: HTMLElement | null = container;
			let depth = 0;
			while (node && depth < 15) {
				const cs = getComputedStyle(node);
				console.warn(`[PluginsViewPane]   depth=${depth} tag=${node.tagName} class="${node.className}" id="${node.id}" offsetW=${node.offsetWidth} offsetH=${node.offsetHeight} display=${cs.display} width=${cs.width} position=${cs.position} overflow=${cs.overflow}`);
				node = node.parentElement;
				depth++;
			}
			// Also log children of body
			console.warn('[PluginsViewPane]   body.isConnected:', container.isConnected, 'body.children.length:', container.children.length);
			for (let i = 0; i < container.children.length; i++) {
				const child = container.children[i] as HTMLElement;
				const ccs = getComputedStyle(child);
				console.warn(`[PluginsViewPane]   child[${i}]:`, child.tagName, child.className, 'display:', ccs.display, 'width:', ccs.width, 'height:', ccs.height, 'offsetW:', child.offsetWidth, 'offsetH:', child.offsetHeight);
			}
		});
	}

	private _switchTab(installedTab: HTMLButtonElement, marketplaceTab: HTMLButtonElement, tab: 'installed' | 'marketplace'): void {
		// Clear search when switching tabs
		this._searchQuery.set('', undefined);
		this.searchInput.value = '';

		this._activeTab.set(tab, undefined);

		// Update tab button styles
		installedTab.classList.toggle('active', tab === 'installed');
		marketplaceTab.classList.toggle('active', tab === 'marketplace');

		// Show/hide containers
		if (tab === 'installed') {
			this.searchInput.placeholder = localize('searchPlugins', "Search Plugins...");
			this.searchInput.style.display = '';
			this._marketplaceContainer.style.display = 'none';
			this.listContainer!.style.display = '';
		} else {
			this.searchInput.placeholder = '\u{1F50D} \u641C\u7D22\u5546\u57CE\u8D44\u6E90...'; // 🔍 搜索商城资源...
			this.searchInput.style.display = '';
			this.listContainer!.style.display = 'none';
			this._marketplaceContainer.style.display = '';
			// Load marketplace packages
			this._loadMarketplacePackages();
		}
	}

	private _showPluginDetail(plugin: IAgentPlugin): void {
		if (!this.detailContainer || !this.listContainer) {
			return;
		}

		// 隐藏列表，显示详情
		this.listContainer.classList.add('hidden');
		this.detailContainer.classList.remove('hidden');
		this.detailContainer.replaceChildren();

		// 返回按钮
		const backButton = append(this.detailContainer, $('button.plugins-detail-back'));
		backButton.textContent = '< Back to List';
		backButton.onclick = () => {
			this._selectedPlugin.set(undefined, undefined);
			if (this.detailContainer) this.detailContainer.classList.add('hidden');
			if (this.listContainer) this.listContainer.classList.remove('hidden');
		};

		// 插件名称
		const nameEl = append(this.detailContainer, $('h2.plugins-detail-name'));
		nameEl.textContent = plugin.label;

		// 插件描述
		const descEl = append(this.detailContainer, $('p.plugins-detail-desc'));
		descEl.textContent = plugin.fromMarketplace?.description || 'No description available';

		// 插件作者
		const authorEl = append(this.detailContainer, $('p.plugins-detail-author'));
		authorEl.textContent = `Author: ${plugin.fromMarketplace?.marketplace || 'Unknown'}`;

		// 插件 URI
		const uriEl = append(this.detailContainer, $('p.plugins-detail-uri'));
		uriEl.textContent = `Location: ${plugin.uri.toString()}`;

		// Skills 列表
		const skills = plugin.skills.get();
		if (skills.length > 0) {
			const skillsHeader = append(this.detailContainer, $('h3'));
			skillsHeader.textContent = `Skills (${skills.length})`;
			const skillsList = append(this.detailContainer, $('ul.plugins-detail-skills'));
			for (const skill of skills) {
				const li = append(skillsList, $('li'));
				li.textContent = skill.name || 'Unknown skill';
			}
		}

		// Commands 列表
		const commands = plugin.commands.get();
		if (commands.length > 0) {
			const cmdsHeader = append(this.detailContainer, $('h3'));
			cmdsHeader.textContent = `Commands (${commands.length})`;
			const cmdsList = append(this.detailContainer, $('ul.plugins-detail-commands'));
			for (const cmd of commands) {
				const li = append(cmdsList, $('li'));
				li.textContent = cmd.name || 'Unknown command';
			}
		}
	}

	private _toDisplayInfo(plugin: IAgentPlugin, reader: any): IPluginDisplayInfo {
		const mp = plugin.fromMarketplace;
		const enablementState = plugin.enablement.read(reader);
		const skills = plugin.skills.read(reader);
		const commands = plugin.commands.read(reader);
		const agents = plugin.agents.read(reader);
		const mcpServers = plugin.mcpServerDefinitions.read(reader);

		return {
			plugin,
			label: plugin.label,
			description: mp?.description ?? this._fallbackDescription(plugin),
			version: mp?.version ?? '',
			author: mp?.marketplace ?? this._fallbackAuthor(plugin.uri),
			enabled: isContributionEnabled(enablementState),
			skillCount: skills.length,
			commandCount: commands.length,
			agentCount: agents.length,
			hasMcp: mcpServers.length > 0,
		};
	}

	private _fallbackDescription(plugin: IAgentPlugin): string {
		const parts: string[] = [];
		const cmdCount = plugin.commands.get().length;
		const skillCount = plugin.skills.get().length;
		const agentCount = plugin.agents.get().length;
		if (cmdCount) { parts.push(`${cmdCount} command${cmdCount > 1 ? 's' : ''}`); }
		if (skillCount) { parts.push(`${skillCount} skill${skillCount > 1 ? 's' : ''}`); }
		if (agentCount) { parts.push(`${agentCount} agent${agentCount > 1 ? 's' : ''}`); }
		if (plugin.mcpServerDefinitions.get().length) { parts.push('MCP'); }
		return parts.length ? parts.join(', ') : basename(plugin.uri);
	}

	private _fallbackAuthor(uri: URI): string {
		const segments = uri.path.split('/').filter(Boolean);
		return segments.length > 1 ? segments[segments.length - 2] : 'Local';
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  MARKETPLACE TAB
	// ══════════════════════════════════════════════════════════════════════════

	private async _loadMarketplacePackages(): Promise<void> {
		if (this._marketplaceLoading) { return; }
		this._marketplaceLoading = true;
		this._marketplaceError = '';
		this._showMarketplaceStatus('\u23F3 \u52A0\u8F7D\u4E2D...'); // ⏳ 加载中...

		try {
			// Load installed slugs in parallel (to show "已安装" badges)
			this._loadInstalledSlugs().catch(() => { /* ignore */ });

			const result = await this.marketplaceService.listPackages({ pageSize: 1000, sort: 'popular' });
			this._marketplacePackages = [...result.items];
			this._renderMarketplaceCards();
		} catch (err) {
			console.error('[PluginsViewPane] Marketplace load error:', err);
			this._marketplaceError = err instanceof Error ? err.message : String(err);
			this._hideMarketplaceStatus();
			this._showMarketplaceStatus(
				`\u26A0 \u52A0\u8F7D\u5931\u8D25: ${this._marketplaceError}` // ⚠ 加载失败: ...
			);
		} finally {
			this._marketplaceLoading = false;
		}
	}

	private async _loadInstalledSlugs(): Promise<void> {
		try {
			const installed = await this.marketplaceService.getInstalled();
			this._installedSlugs = new Set(installed.map(i => i.storeId));
		} catch {
			// Ignore — installed badges are best-effort
		}
	}

	private _showMarketplaceStatus(msg: string): void {
		clearNode(this._marketplaceStatusEl);
		this._marketplaceStatusEl.style.display = '';
		const el = $('div.plugins-marketplace-message');
		el.textContent = msg;
		this._marketplaceStatusEl.appendChild(el);
	}

	private _hideMarketplaceStatus(): void {
		clearNode(this._marketplaceStatusEl);
		this._marketplaceStatusEl.style.display = 'none';
	}

	private _renderMarketplaceCards(): void {
		clearNode(this._marketplaceStatusEl);
		clearNode(this._marketplaceGridEl);

		const pkgs = this._marketplacePackages;
		if (pkgs.length === 0) {
			this._showMarketplaceStatus('\u5546\u57CE\u4E2D\u6682\u65E0\u53EF\u7528\u8D44\u6E90'); // 商城中暂无可用资源
			return;
		}

		// Apply search filter
		const query = this._searchQuery.get();
		let filtered = pkgs;
		if (query) {
			filtered = pkgs.filter(p =>
				p.name.toLowerCase().includes(query) ||
				(p.description ?? '').toLowerCase().includes(query) ||
				p.tags.some(t => t.toLowerCase().includes(query))
			);
		}

		// Count header
		const header = $('div.plugins-marketplace-header');
		header.textContent = `\u{1F6D2} \u5546\u57CE\u8D44\u6E90 (${filtered.length})`; // 🛒 商城资源 (N)
		this._marketplaceGridEl.appendChild(header);

		if (filtered.length === 0) {
			this._showMarketplaceStatus('\u6CA1\u6709\u5339\u914D\u7684\u8D44\u6E90'); // 没有匹配的资源
			return;
		}

		// Card grid
		const grid = $('div.plugins-marketplace-cards');
		for (const pkg of filtered) {
			grid.appendChild(this._createMarketplaceCard(pkg));
		}
		this._marketplaceGridEl.appendChild(grid);
	}

	private _createMarketplaceCard(pkg: IMarketplacePackage): HTMLElement {
		const card = $('div.plugins-marketplace-card');

		// Top: icon + name + kind badge
		const top = $('div.mp-card-top');
		const icon = $('div.mp-card-icon');
		icon.textContent = pkg.icon ?? KIND_ICON[pkg.kind] ?? '\u{1F4E6}';
		top.appendChild(icon);

		const info = $('div.mp-card-info');
		const name = $('div.mp-card-name');
		name.textContent = pkg.name;
		info.appendChild(name);

		const meta = $('div.mp-card-meta');
		const kindBadge = $('span.mp-card-kind');
		kindBadge.textContent = KIND_LABEL[pkg.kind] ?? pkg.kind;
		meta.appendChild(kindBadge);

		if (pkg.latestVersion) {
			const ver = $('span.mp-card-version');
			ver.textContent = `v${pkg.latestVersion}`;
			meta.appendChild(ver);
		}

		if (pkg.authorName) {
			const author = $('span.mp-card-author');
			author.textContent = pkg.authorName;
			meta.appendChild(author);
		}
		info.appendChild(meta);
		top.appendChild(info);
		card.appendChild(top);

		// Description
		if (pkg.description) {
			const desc = $('div.mp-card-desc');
			desc.textContent = pkg.description;
			card.appendChild(desc);
		}

		// Footer: downloads + install button
		const footer = $('div.mp-card-footer');
		if (pkg.downloads !== undefined) {
			const stats = $('span.mp-card-stats');
			stats.textContent = `\u2B07 ${pkg.downloads}`;
			footer.appendChild(stats);
		}

		const slug = pkg.slug;
		const isInstalled = this._installedSlugs.has(slug);
		const isInstalling = this._installingIds.has(slug);

		const actionBtn = $('button.mp-card-install-btn') as HTMLButtonElement;
		if (isInstalled) {
			actionBtn.textContent = '\u2713 \u5DF2\u5B89\u88C5'; // ✓ 已安装
			actionBtn.classList.add('installed');
			actionBtn.disabled = true;
		} else if (isInstalling) {
			actionBtn.textContent = '\u23F3 \u5B89\u88C5\u4E2D...'; // ⏳ 安装中...
			actionBtn.disabled = true;
		} else {
			actionBtn.textContent = '\u2B07 \u5B89\u88C5'; // ⬇ 安装
			actionBtn.onclick = (e) => {
				e.stopPropagation();
				this._installPkg(pkg, actionBtn);
			};
		}
		footer.appendChild(actionBtn);
		card.appendChild(footer);

		return card;
	}

	private async _installPkg(pkg: IMarketplacePackage, btn: HTMLButtonElement): Promise<void> {
		const slug = pkg.slug;
		if (this._installingIds.has(slug)) { return; }
		if (!pkg.latestVersion) {
			this.notificationService.warn(`\u8D44\u6E90 "${pkg.name}" \u6CA1\u6709\u53EF\u7528\u7248\u672C\u3002`);
			return;
		}

		btn.textContent = '\u23F3 \u5B89\u88C5\u4E2D...'; // ⏳ 安装中...
		btn.disabled = true;
		this._installingIds.add(slug);

		try {
			const result = await this.marketplaceService.download(slug, pkg.latestVersion, pkg.kind);
			this._installedSlugs.add(slug);
			btn.textContent = '\u2713 \u5DF2\u5B89\u88C5'; // ✓ 已安装
			btn.classList.add('installed');
			this.notificationService.info(`\u2705 ${pkg.name} v${result.version} \u5B89\u88C5\u6210\u529F\u3002`);
		} catch (err) {
			btn.textContent = '\u2B07 \u5B89\u88C5'; // ⬇ 安装
			btn.disabled = false;
			this.notificationService.error(`\u5B89\u88C5\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._installingIds.delete(slug);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		const listHeight = Math.max(0, height - 80);

		if (this.listContainer) {
			this.listContainer.style.height = `${listHeight}px`;
		}

		if (this._marketplaceContainer) {
			this._marketplaceContainer.style.height = `${listHeight}px`;
		}

		// Defer WorkbenchList creation until container has positive dimensions
		if (!this.list && this.listContainer && width > 0 && listHeight > 0) {
			const delegate = new PluginListDelegate();
			const renderer = new PluginListRenderer(this.agentPluginService.enablementModel);
			const accessibilityProvider = new PluginListAccessibilityProvider();

			this.list = this.instantiationService.createInstance(
				WorkbenchList,
				'AgentPluginsList',
				this.listContainer,
				delegate,
				[renderer],
				{
					multipleSelectionSupport: false,
					setRowLineHeight: false,
					horizontalScrolling: false,
					accessibilityProvider,
					openOnSingleClick: true,
				}
			) as WorkbenchList<IPluginDisplayInfo>;

			this._register(this.list);

			this._register(this.list.onDidChangeSelection(e => {
				if (e.elements.length > 0) {
					const selected = e.elements[0];
					this._selectedPlugin.set(selected.plugin, undefined);
					// Open plugin detail in editor area (like VS Code native Extensions view)
					try {
						const input = new PluginDetailEditorInput(selected.plugin);
						this.instantiationService.invokeFunction((accessor: any) => {
							const editorService = accessor.get(IEditorService);
							const editorGroupsService = accessor.get(IEditorGroupsService);

							// Close any existing PluginDetailEditorInput tabs so that
							// switching plugins replaces the current tab rather than
							// opening a new one each time.
							for (const group of editorGroupsService.getGroups(0)) {
								const existing = group.editors.find((ed: EditorInput) => ed instanceof PluginDetailEditorInput);
								if (existing) {
									group.closeEditor(existing, { preserveFocus: true });
								}
							}

							// Re-query groups after closing (group layout may change)
							const targetGroup = editorGroupsService.getGroups(0)[0];
							if (targetGroup) {
								editorService.openEditor(input, { pinned: true }, targetGroup);
							} else {
								editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
							}
						});
					} catch (err) {
						console.warn('[PluginsViewPane] openEditor failed, falling back to sidebar detail:', err);
						this._showPluginDetail(selected.plugin);
					}
				}
			}));

			// Layout BEFORE first splice so rows compute positions against known dimensions
			this.list.layout(listHeight, width);

			// Reactively update the list when filtered plugins change (replaces setInterval polling)
			this._register(autorun(reader => {
				const items = this._filteredPlugins.read(reader);
				if (this.list) {
					this.list.splice(0, this.list.length, items);
				}
			}));
		} else if (this.list) {
			this.list.layout(listHeight, width);
		}
	}
}
