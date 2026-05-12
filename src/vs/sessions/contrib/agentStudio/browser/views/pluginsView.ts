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
import { append, $ as $h } from '../../../../../base/browser/dom.js';
import { IDisposable, dispose } from '../../../../../base/common/lifecycle.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IListVirtualDelegate, IListRenderer } from '../../../../../base/browser/ui/list/list.js';
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
	pluginDisposables: IDisposable[];
}

class PluginListRenderer implements IListRenderer<IPluginDisplayInfo, IPluginTemplateData> {

	constructor(
		private readonly enablementModel: IEnablementModel,
	) { }

	get templateId(): string { return 'agentPlugin'; }

	renderTemplate(container: HTMLElement): IPluginTemplateData {
		const root = container;
		const element = append(root, $h('.agent-plugin-list-item'));

		// Icon
		const iconContainer = append(element, $h('.icon-container'));
		const iconEl = append(iconContainer, $h('span.plugin-icon-codicon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.extensions));

		// Details
		const details = append(element, $h('.details'));
		const headerContainer = append(details, $h('.header-container'));
		const header = append(headerContainer, $h('.header'));
		const name = append(header, $h('span.name'));
		const badges = append(header, $h('span.badges'));
		const description = append(details, $h('.description.ellipsis'));
		const footer = append(details, $h('.footer'));
		const author = append(footer, $h('span.author'));

		// Action bar
		const actionbar = new ActionBar(footer, { focusOnlyEnabledItems: true });
		actionbar.setFocusable(false);

		return {
			root, element, iconContainer, name, description,
			footer, author, badges, actionbar,
			disposables: [actionbar],
			pluginDisposables: []
		};
	}

	renderElement(item: IPluginDisplayInfo, _index: number, data: IPluginTemplateData): void {
		data.pluginDisposables = dispose(data.pluginDisposables);

		data.name.textContent = item.label;
		data.description.textContent = item.description;
		data.author.textContent = item.author;

		data.element.classList.toggle('disabled', !item.enabled);

		// Badges
		data.badges.replaceChildren();
		if (item.skillCount > 0) {
			append(data.badges, $h('span.plugin-badge')).textContent = `${item.skillCount} skill${item.skillCount > 1 ? 's' : ''}`;
		}
		if (item.commandCount > 0) {
			append(data.badges, $h('span.plugin-badge')).textContent = `${item.commandCount} cmd${item.commandCount > 1 ? 's' : ''}`;
		}
		if (item.agentCount > 0) {
			append(data.badges, $h('span.plugin-badge')).textContent = `${item.agentCount} agent${item.agentCount > 1 ? 's' : ''}`;
		}
		if (item.hasMcp) {
			append(data.badges, $h('span.plugin-badge.mcp')).textContent = 'MCP';
		}

		// Actions
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
		data.pluginDisposables = dispose(data.pluginDisposables);
		data.disposables = dispose(data.disposables);
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

	private list!: WorkbenchList<IPluginDisplayInfo>;
	private searchInput!: HTMLInputElement;

	private readonly _searchQuery = observableValue<string>('pluginsSearchQuery', '');
	private readonly _activeTab = observableValue<'installed' | 'marketplace'>('pluginsActiveTab', 'installed');

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

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('plugins-view');

		// Tabs
		const tabs = append(container, $h('.plugins-tabs'));
		const installedTab = append(tabs, $h('button.plugins-tab.active'));
		installedTab.textContent = localize('installed', "Installed");
		installedTab.onclick = () => {
			this._activeTab.set('installed', undefined);
			tabs.querySelectorAll('.plugins-tab').forEach(b => b.classList.remove('active'));
			installedTab.classList.add('active');
		};

		const marketplaceTab = append(tabs, $h('button.plugins-tab'));
		marketplaceTab.textContent = localize('marketplace', "Marketplace");
		marketplaceTab.onclick = () => {
			this._activeTab.set('marketplace', undefined);
			tabs.querySelectorAll('.plugins-tab').forEach(b => b.classList.remove('active'));
			marketplaceTab.classList.add('active');
		};

		// Search
		this.searchInput = append(container, $h('input.plugins-search')) as HTMLInputElement;
		this.searchInput.placeholder = localize('searchPlugins', "Search Plugins...");
		this.searchInput.type = 'text';
		this.searchInput.oninput = () => {
			this._searchQuery.set(this.searchInput.value, undefined);
		};

		// List
		const listContainer = append(container, $h('.plugins-list-container'));
		const delegate = new PluginListDelegate();
		const renderer = new PluginListRenderer(this.agentPluginService.enablementModel);

		this.list = this.instantiationService.createInstance(
			WorkbenchList,
			'AgentPluginsList',
			listContainer,
			delegate,
			[renderer],
			{
				multipleSelectionSupport: false,
				setRowLineHeight: false,
				horizontalScrolling: false,
				accessibilityProvider: {
					getAriaLabel(item: IPluginDisplayInfo): string {
						return `${item.label}, ${item.author}, ${item.description}`;
					},
					getWidgetAriaLabel(): string {
						return localize('plugins', "Plugins");
					}
				},
				openOnSingleClick: false,
			}
		) as WorkbenchList<IPluginDisplayInfo>;

		this._register(autorun(reader => {
			const items = this._filteredPlugins.read(reader);
			this.list.splice(0, this.list.length, items);
		}));
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
		this.list?.layout(height - 80, width);
	}
}
