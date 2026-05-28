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
import { $, append } from '../../../../../base/browser/dom.js';
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

// --- Constants ---

const PLUGIN_LIST_ELEMENT_HEIGHT = 72;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._filteredPlugins = derived(reader => {
			const allPlugins = this.agentPluginService.plugins.read(reader);
			const query = this._searchQuery.read(reader).toLowerCase();
			const tab = this._activeTab.read(reader);

			const displayItems = allPlugins.map(p => this._toDisplayInfo(p, reader));

			const filtered = tab === 'installed'
				? displayItems
				: displayItems.filter(p => p.plugin.fromMarketplace !== undefined);

			if (query) {
				return filtered.filter(p =>
					p.label.toLowerCase().includes(query) ||
					p.description.toLowerCase().includes(query) ||
					p.author.toLowerCase().includes(query)
				);
			}

			return filtered;
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
		const installedTab = append(tabs, $('button.plugins-tab.active'));
		installedTab.textContent = localize('installed', "Installed");
		installedTab.onclick = () => {
			this._activeTab.set('installed', undefined);
			tabs.querySelectorAll('.plugins-tab').forEach(b => b.classList.remove('active'));
			installedTab.classList.add('active');
		};

		const marketplaceTab = append(tabs, $('button.plugins-tab'));
		marketplaceTab.textContent = localize('marketplace', "Marketplace");
		marketplaceTab.onclick = () => {
			this._activeTab.set('marketplace', undefined);
			tabs.querySelectorAll('.plugins-tab').forEach(b => b.classList.remove('active'));
			marketplaceTab.classList.add('active');
		};

		// Search
		this.searchInput = append(container, $('input.plugins-search')) as HTMLInputElement;
		this.searchInput.placeholder = localize('searchPlugins', "Search Plugins...");
		this.searchInput.type = 'text';
		this.searchInput.oninput = () => {
			this._searchQuery.set(this.searchInput.value, undefined);
		};

		// List Container
		this.listContainer = append(container, $('.plugins-list-container'));

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

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		console.warn('[PluginsViewPane] layoutBody called: h=', height, 'w=', width, 'hasList=', !!this.list, 'hasListContainer=', !!this.listContainer);
		const listHeight = Math.max(0, height - 80);

		if (this.listContainer) {
			this.listContainer.style.height = `${listHeight}px`;
			this.listContainer.style.width = `${width}px`;
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
