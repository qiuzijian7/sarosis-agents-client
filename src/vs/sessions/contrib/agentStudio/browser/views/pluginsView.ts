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
// ── VS Code 原生扩展（「扩展」tab）────────────────────────────────────────────
// ★ 只用**服务层** `IExtensionsWorkbenchService`（agents 窗口已在 sessions.common.main.ts 注册），
//   不引入上游 `extensions.contribution.ts` 的视图容器/命令 —— 取舍与后续阶段见
//   `doc/native-extensions-in-agents-window-plan.md`（L1 = 本 tab，L3 = 扩展贡献的视图可见性）。
import { IExtensionsWorkbenchService, IExtension } from '../../../../../workbench/contrib/extensions/common/extensions.js';
import { EnablementState } from '../../../../../workbench/services/extensionManagement/common/extensionManagement.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { AGENTS_WINDOW_EXTENSION_ALLOWLIST_SETTING, AGENTS_WINDOW_EXTENSION_MODE_SETTING, resolveAgentsWindowExtensionPolicy } from '../../../../../platform/extensionManagement/common/agentsWindowExtensionPolicy.js';
// ── L4「分发」所需：从 URL 安装 VSIX（产品未配置 extensionsGallery 时的内网分发路径）────────
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../../common/sarosPaths.js';
// ── 市场搜索：原生 gallery（需产品配置 extensionsGallery）────────────────────────
import { IExtensionGalleryManifestService, ExtensionGalleryManifestStatus } from '../../../../../platform/extensionManagement/common/extensionGalleryManifest.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';

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
	private readonly _activeTab = observableValue<'installed' | 'extensions' | 'marketplace'>('pluginsActiveTab', 'installed');
	private readonly _selectedPlugin = observableValue<IAgentPlugin | undefined>('selectedPlugin', undefined);

	/** 三个 tab 的按钮（`_switchTab` 统一维护 active 样式）。 */
	private _tabButtons!: Record<'installed' | 'extensions' | 'marketplace', HTMLButtonElement>;

	// ── VS Code 扩展 tab 状态（DOM 卡片渲染，非 WorkbenchList）──────────
	private _extensionsContainer!: HTMLElement;
	private _extensionsHeaderEl!: HTMLElement;
	private _extensionsListEl!: HTMLElement;

	// ── 「扩展」tab 的市场搜索状态 ──────────────────────────────────────
	/** 已发起搜索的关键词（与 `_searchQuery` 解耦：防抖后才赋值，避免每敲一个字符打一次网络）。 */
	private _marketQuery = '';
	private _marketSearching = false;
	/** 原生 gallery 结果（仅 gallery 可用时非空）。 */
	private _marketResults: IExtension[] = [];
	/** Saros 商城结果（内部资源：agent / skill / MCP / 知识库 / 工作流）。 */
	private _marketStoreResults: IMarketplacePackage[] = [];
	/** 给用户看的提示（如"未配置扩展市场"）。 */
	private _marketNotice = '';
	private _marketSearchTimer: ReturnType<typeof setTimeout> | undefined;
	private _marketSearchCts: CancellationTokenSource | undefined;

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
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ILogService private readonly logService: ILogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IExtensionGalleryManifestService private readonly extensionGalleryManifestService: IExtensionGalleryManifestService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._filteredPlugins = derived(reader => {
			const allPlugins = this.agentPluginService.plugins.read(reader);
			const query = this._searchQuery.read(reader).toLowerCase();
			const tab = this._activeTab.read(reader);

			// Only compute for 'installed' tab — extensions / marketplace are rendered separately via DOM
			if (tab !== 'installed') {
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

		// 原生扩展列表**不是** observable（`onChange` 是逐项事件 + `local` 是普通数组）
		// ⇒ 用 DOM 卡片渲染，仅在「扩展」tab 激活时按需重绘（避免后台无谓开销）。
		this._register(this.extensionsWorkbenchService.onChange(() => {
			if (this._activeTab.get() === 'extensions') {
				this._renderExtensions();
			}
		}));

		// 市场搜索的防抖定时器是裸 `setTimeout` + 有 CancellationTokenSource ⇒ 必须随视图销毁清理。
		this._register({
			dispose: () => {
				if (this._marketSearchTimer !== undefined) {
					clearTimeout(this._marketSearchTimer);
					this._marketSearchTimer = undefined;
				}
				this._marketSearchCts?.dispose();
				this._marketSearchCts = undefined;
			},
		});
	}

	override shouldShowWelcome(): boolean {
		return false;
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		console.debug('[PluginsViewPane] setVisible called:', visible, 'isExpanded:', this.isExpanded(), 'element in DOM:', !!this.element?.parentElement, 'bodyRendered:', !!(this as any)._bodyRendered);
		// Ensure the view is expanded when it becomes visible.
		// In single-view containers with mergeViewWithContainerWhenSingleView,
		// the view should always be expanded, but the container may not
		// auto-expand it if areExtensionsReady is false at creation time.
		if (visible && !this.isExpanded()) {
			console.debug('[PluginsViewPane] forcing expansion from setVisible');
			this.setExpanded(true);
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		console.debug('[PluginsViewPane] renderBody called, container:', container.tagName, container.className, 'parentElement:', container.parentElement?.tagName, container.parentElement?.className);

		// Remove .welcome class — it hides all non-.welcome-view children via
		// `.pane-body.welcome > :not(.welcome-view) { display: none }` in views.css
		container.classList.remove('welcome');
		container.classList.add('plugins-view');

		// Tabs —— Agent 插件 / VS Code 扩展 / 商城
		const tabs = append(container, $('.plugins-tabs'));
		const installedTab = append(tabs, $('button.plugins-tab.active')) as HTMLButtonElement;
		installedTab.textContent = localize('installed', "Installed");
		const extensionsTab = append(tabs, $('button.plugins-tab')) as HTMLButtonElement;
		extensionsTab.textContent = localize('extensionsTab', "Extensions");
		const marketplaceTab = append(tabs, $('button.plugins-tab')) as HTMLButtonElement;
		marketplaceTab.textContent = localize('marketplace', "Marketplace");
		this._tabButtons = { installed: installedTab, extensions: extensionsTab, marketplace: marketplaceTab };
		installedTab.onclick = () => this._switchTab('installed');
		extensionsTab.onclick = () => this._switchTab('extensions');
		marketplaceTab.onclick = () => this._switchTab('marketplace');

		// Search (works for all tabs)
		this.searchInput = append(container, $('input.plugins-search')) as HTMLInputElement;
		this.searchInput.placeholder = localize('searchPlugins', "Search Plugins...");
		this.searchInput.type = 'text';
		this.searchInput.oninput = () => {
			const value = this.searchInput.value;
			this._searchQuery.set(value, undefined);
			// Re-render the active DOM-rendered tab on search change
			if (this._activeTab.get() === 'marketplace' && !this._marketplaceLoading) {
				this._renderMarketplaceCards();
			} else if (this._activeTab.get() === 'extensions') {
				// 本地即时过滤 + 市场搜索（防抖 400ms）
				this._renderExtensions();
				this._scheduleMarketSearch(this._searchQuery.get().trim());
			}
		};

		// Installed list Container
		this.listContainer = append(container, $('.plugins-list-container'));

		// VS Code Extensions Container (hidden by default, rendered as DOM cards)
		this._extensionsContainer = append(container, $('.plugins-extensions-container'));
		this._extensionsContainer.style.cssText = 'display:none;flex:1;overflow-y:auto;';
		this._extensionsHeaderEl = append(this._extensionsContainer, $('.plugins-extensions-header'));
		this._extensionsListEl = append(this._extensionsContainer, $('.plugins-extensions-list'));

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
			console.debug('[PluginsViewPane] rAF DOM ancestor-width walk:');
			let node: HTMLElement | null = container;
			let depth = 0;
			while (node && depth < 15) {
				const cs = getComputedStyle(node);
				console.debug(`[PluginsViewPane]   depth=${depth} tag=${node.tagName} class="${node.className}" id="${node.id}" offsetW=${node.offsetWidth} offsetH=${node.offsetHeight} display=${cs.display} width=${cs.width} position=${cs.position} overflow=${cs.overflow}`);
				node = node.parentElement;
				depth++;
			}
			// Also log children of body
			console.debug('[PluginsViewPane]   body.isConnected:', container.isConnected, 'body.children.length:', container.children.length);
			for (let i = 0; i < container.children.length; i++) {
				const child = container.children[i] as HTMLElement;
				const ccs = getComputedStyle(child);
				console.debug(`[PluginsViewPane]   child[${i}]:`, child.tagName, child.className, 'display:', ccs.display, 'width:', ccs.width, 'height:', ccs.height, 'offsetW:', child.offsetWidth, 'offsetH:', child.offsetHeight);
			}
		});
	}

	private _switchTab(tab: 'installed' | 'extensions' | 'marketplace'): void {
		// Clear search when switching tabs
		this._searchQuery.set('', undefined);
		this.searchInput.value = '';

		this._activeTab.set(tab, undefined);

		// Update tab button styles
		for (const key of ['installed', 'extensions', 'marketplace'] as const) {
			this._tabButtons[key].classList.toggle('active', key === tab);
		}

		// Show/hide containers
		this.listContainer!.style.display = tab === 'installed' ? '' : 'none';
		this._extensionsContainer.style.display = tab === 'extensions' ? '' : 'none';
		this._marketplaceContainer.style.display = tab === 'marketplace' ? '' : 'none';
		this.searchInput.style.display = '';

		if (tab === 'installed') {
			this.searchInput.placeholder = localize('searchPlugins', "Search Plugins...");
		} else if (tab === 'extensions') {
			// 市场可用时明确提示"可搜市场"，否则说明只能用 VSIX（避免用户以为搜索坏了）。
			this.searchInput.placeholder = this._isGalleryAvailable()
				? localize('searchExtensionsAndMarket', "搜索已安装扩展与扩展市场…")
				: localize('searchExtensionsLocal', "搜索已安装扩展（未配置扩展市场）…");
			this._scheduleMarketSearch('');  // 切 tab 时清空市场状态（搜索框内容已被清空）
			this._renderExtensions();
		} else {
			this.searchInput.placeholder = '\u{1F50D} \u641C\u7D22\u5546\u57CE\u8D44\u6E90...'; // 🔍 搜索商城资源...
			// Load marketplace packages
			this._loadMarketplacePackages();
		}
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  VS CODE EXTENSIONS TAB（原生扩展管理面）
	// ══════════════════════════════════════════════════════════════════════════

	/**
	 * 列出 `IExtensionsWorkbenchService.local` 里的已安装 VS Code 扩展。
	 *
	 * ★ 数据源是 services 层（`IExtensionsWorkbenchService` 在 `sessions.common.main.ts` 已注册），
	 *   本 tab **不引入**上游 `extensions.contribution.ts` 的视图容器 —— 见方案文档 L1/L1a/L1b 取舍。
	 * ★ agents 窗口默认只放行声明式扩展：带代码的第三方扩展会显示「由环境禁用」，
	 *   那是策略（`saros.extensions.agentsWindow.mode`）的结果，不是缺陷。所以 header 里同时显示当前策略。
	 */
	private _renderExtensions(): void {
		if (!this._extensionsListEl || !this._extensionsHeaderEl) {
			return;
		}

		const policy = resolveAgentsWindowExtensionPolicy({
			mode: this.configurationService.getValue(AGENTS_WINDOW_EXTENSION_MODE_SETTING),
			allowlist: this.configurationService.getValue(AGENTS_WINDOW_EXTENSION_ALLOWLIST_SETTING),
		});
		const all = this.extensionsWorkbenchService.local;
		const query = this._searchQuery.get().trim().toLowerCase();
		const filtered = query ? all.filter(ext => this._extensionMatchesQuery(ext, query)) : all;

		// Header：计数 + 策略 + 安装 VSIX 入口
		clearNode(this._extensionsHeaderEl);
		const count = append(this._extensionsHeaderEl, $('span.plugins-ext-count'));
		count.textContent = localize('extensionsCount', "{0} / {1} 个已安装扩展", filtered.length, all.length);

		const installBtn = append(this._extensionsHeaderEl, $('button.plugins-ext-btn')) as HTMLButtonElement;
		installBtn.textContent = localize('installVsix', "安装 VSIX…");
		installBtn.title = localize('installVsixHint', "从本地选择 .vsix 文件安装（产品未配置扩展市场时的分发路径）。");
		installBtn.onclick = () => this._pickVsixAndInstall();

		const installUrlBtn = append(this._extensionsHeaderEl, $('button.plugins-ext-btn')) as HTMLButtonElement;
		installUrlBtn.textContent = localize('installVsixFromUrl', "从 URL 安装…");
		installUrlBtn.title = localize('installVsixFromUrlHint', "从 http(s) 直链下载 .vsix 并安装（内网制品库/共享盘）。");
		installUrlBtn.onclick = () => this._installVsixFromUrl();

		const policyEl = append(this._extensionsHeaderEl, $('span.plugins-ext-policy'));
		policyEl.textContent = `策略：${policy.mode}${policy.allowlist.length ? `（白名单 ${policy.allowlist.length}）` : ''}`;
		policyEl.title = localize('extensionsPolicyHint', "由设置 saros.extensions.agentsWindow.mode 控制：declarative = 仅声明式扩展可运行；allowlist = 额外放行白名单；all = 除黑名单外全部。改后需 Reload Window 才真正加载/卸载扩展。");

		clearNode(this._extensionsListEl);

		// ── 市场搜索结果（仅在有搜索词且已发起过搜索时渲染）──
		const raw = this._searchQuery.get().trim();
		if (raw && this._marketQuery === raw) {
			if (this._marketSearching) {
				append(this._extensionsListEl, $('div.plugins-ext-notice')).textContent = localize('marketSearching', "正在搜索市场…");
			}
			if (this._marketNotice) {
				append(this._extensionsListEl, $('div.plugins-ext-notice')).textContent = this._marketNotice;
			}
			if (this._marketResults.length) {
				this._extensionsListEl.appendChild(this._sectionTitle(localize('marketResults', "市场结果（{0}）", this._marketResults.length)));
				for (const ext of this._marketResults) {
					this._extensionsListEl.appendChild(this._createMarketInstallCard(ext));
				}
			}
			if (this._marketStoreResults.length) {
				this._extensionsListEl.appendChild(this._sectionTitle(localize('storeResults', "商城结果（{0}）", this._marketStoreResults.length)));
				for (const pkg of this._marketStoreResults) {
					this._extensionsListEl.appendChild(this._createMarketplaceCard(pkg));
				}
			}
		}

		// ── 已安装（本地即时过滤）──
		if (raw) {
			this._extensionsListEl.appendChild(this._sectionTitle(localize('installedSection', "已安装（{0}）", filtered.length)));
		}
		if (filtered.length === 0) {
			if (!raw) {
				const empty = append(this._extensionsListEl, $('div.plugins-ext-empty'));
				empty.textContent = all.length === 0
					? localize('extensionsNone', "尚未安装 VS Code 扩展，可用「安装 VSIX…」从本地安装。")
					: localize('extensionsNoMatch', "没有匹配的扩展。");
			}
			return;
		}

		for (const ext of filtered) {
			this._extensionsListEl.appendChild(this._createExtensionCard(ext));
		}
	}

	private _sectionTitle(text: string): HTMLElement {
		const el = $('div.plugins-ext-section');
		el.textContent = text;
		return el;
	}

	private _isGalleryAvailable(): boolean {
		return this.extensionGalleryManifestService.extensionGalleryManifestStatus === ExtensionGalleryManifestStatus.Available;
	}

	/** 防抖 400ms 后再发起市场搜索（逐字请求既浪费又容易乱序）。 */
	private _scheduleMarketSearch(query: string): void {
		if (this._marketSearchTimer !== undefined) {
			clearTimeout(this._marketSearchTimer);
			this._marketSearchTimer = undefined;
		}
		if (!query) {
			this._marketQuery = '';
			this._marketSearching = false;
			this._marketResults = [];
			this._marketStoreResults = [];
			this._marketNotice = '';
			this._marketSearchCts?.cancel();
			return;
		}
		this._marketSearchTimer = setTimeout(() => {
			this._marketSearchTimer = undefined;
			void this._searchMarketplace(query);
		}, 400);
	}

	/**
	 * 市场搜索：**双来源**（与原生「扩展」视图对齐的能力 + 本项目自建商城）。
	 *
	 * ① 原生扩展市场（VS Marketplace / 私有 gallery）—— `IExtensionsWorkbenchService.queryGallery()`。
	 *    ⚠ 需要产品在 `product.json` 配置 `extensionsGallery`；未配置时
	 *    `IExtensionGalleryManifestService.extensionGalleryManifestStatus !== Available`，
	 *    此时**不发请求**并给出可执行提示（见方案文档 L4-R1）。
	 * ② Saros 商城（内部资源：agent / skill / MCP / 知识库 / 工作流）—— 这条不需要任何额外配置，
	 *    是本产品"应用商城"目前真实可搜的那一半。
	 */
	private async _searchMarketplace(query: string): Promise<void> {
		this._marketSearchCts?.dispose();
		const cts = this._marketSearchCts = new CancellationTokenSource();

		this._marketQuery = query;
		this._marketSearching = true;
		this._marketNotice = '';
		this._marketResults = [];
		this._marketStoreResults = [];
		this._renderExtensions();

		const notes: string[] = [];

		// ① 原生扩展市场
		if (this._isGalleryAvailable()) {
			try {
				const pager = await this.extensionsWorkbenchService.queryGallery({ text: query, pageSize: 20 }, cts.token);
				if (!cts.token.isCancellationRequested) {
					this._marketResults = pager.firstPage;
				}
			} catch (err) {
				this.logService.error(`[PluginsViewPane] gallery 搜索失败: ${query}`, err);
				notes.push(localize('marketSearchFailed', "扩展市场搜索失败：{0}", err instanceof Error ? err.message : String(err)));
			}
		} else {
			notes.push(localize('marketNotConfigured', "未配置扩展市场（extensionsGallery）⇒ 只能搜已安装的扩展；可用「安装 VSIX…／从 URL 安装…」，或切到「商城」tab 搜内部资源。"));
		}

		// ② Saros 商城（顺带刷新"已安装"徽标，与商城 tab 同源）
		this._loadInstalledSlugs().catch(() => { /* best effort */ });
		try {
			const res = await this.marketplaceService.listPackages({ q: query, pageSize: 20, sort: 'popular' });
			if (!cts.token.isCancellationRequested) {
				this._marketStoreResults = [...res.items];
			}
		} catch (err) {
			this.logService.warn(`[PluginsViewPane] 商城搜索失败: ${query}`, err);
		}

		if (cts.token.isCancellationRequested) {
			return;
		}
		this._marketSearching = false;
		this._marketNotice = notes.join(' ');
		this.logService.info(`[PluginsViewPane] market search "${query}": gallery=${this._marketResults.length}, store=${this._marketStoreResults.length}${notes.length ? `, note=${notes.length}` : ''}`);
		this._renderExtensions();
	}

	/** 市场（gallery）结果行 —— 与"已安装"行区分：只有「安装」动作。 */
	private _createMarketInstallCard(ext: IExtension): HTMLElement {
		const card = $('div.plugins-ext-card.market');

		const top = $('div.plugins-ext-top');
		const name = $('span.plugins-ext-name');
		name.textContent = ext.displayName || ext.name || ext.identifier.id;
		name.title = ext.identifier.id;
		top.appendChild(name);

		const version = $('span.plugins-ext-version');
		version.textContent = `v${ext.version}`;
		top.appendChild(version);

		if (typeof ext.installCount === 'number') {
			top.appendChild(this._extensionBadge(`${ext.installCount}`, 'plugins-ext-badge-builtin', localize('installCountHint', "安装量")));
		}
		card.appendChild(top);

		const meta = $('div.plugins-ext-meta');
		meta.textContent = [ext.publisherDisplayName || ext.publisher, ext.identifier.id].filter(Boolean).join(' · ');
		card.appendChild(meta);

		if (ext.description) {
			const desc = $('div.plugins-ext-desc');
			desc.textContent = ext.description;
			card.appendChild(desc);
		}

		const actions = $('div.plugins-ext-actions');
		const installed = this.extensionsWorkbenchService.local
			.some(e => e.identifier.id.toLowerCase() === ext.identifier.id.toLowerCase());
		const btn = $('button.plugins-ext-btn') as HTMLButtonElement;
		btn.textContent = installed ? localize('extensionAlreadyInstalled', "已安装") : localize('extensionInstall', "安装");
		btn.disabled = installed;
		btn.onclick = () => this._installFromGallery(ext);
		actions.appendChild(btn);
		card.appendChild(actions);

		return card;
	}

	/** 从市场安装（`IExtension` 重载：由 gallery 元数据驱动，后续更新也走原生链路）。 */
	private async _installFromGallery(ext: IExtension): Promise<void> {
		try {
			this.logService.info(`[PluginsViewPane] install from gallery: ${ext.identifier.id}`);
			await this.extensionsWorkbenchService.install(ext);
			this.notificationService.info(localize('extensionInstalledFromMarket', "已安装 {0}；如未生效请 Reload Window。", ext.displayName || ext.identifier.id));
		} catch (err) {
			this.logService.error(`[PluginsViewPane] gallery install failed: ${ext.identifier.id}`, err);
			this.notificationService.error(localize('extensionInstallFailed', "安装扩展失败：{0}", err instanceof Error ? err.message : String(err)));
		} finally {
			this._renderExtensions();
		}
	}

	private _extensionMatchesQuery(ext: IExtension, query: string): boolean {
		return (ext.displayName || ext.name || '').toLowerCase().includes(query)
			|| (ext.identifier?.id ?? '').toLowerCase().includes(query)
			|| (ext.description ?? '').toLowerCase().includes(query)
			|| (ext.publisherDisplayName ?? '').toLowerCase().includes(query);
	}

	private _isExtensionEnabled(ext: IExtension): boolean {
		switch (ext.enablementState) {
			case EnablementState.EnabledGlobally:
			case EnablementState.EnabledWorkspace:
			case EnablementState.EnabledByEnvironment:
				return true;
			default:
				return false;
		}
	}

	private _extensionStateLabel(ext: IExtension): { text: string; cls: string; title: string } | undefined {
		switch (ext.enablementState) {
			case EnablementState.DisabledByEnvironment:
				return {
					text: localize('extStateByEnv', "由环境禁用"),
					cls: 'plugins-ext-badge-env',
					title: localize('extStateByEnvHint', "agents 窗口策略不允许该扩展运行（多为带代码的第三方扩展）。可用设置 saros.extensions.agentsWindow.mode 放开（allowlist / all），或改在 IDE 窗口中使用；内置扩展不受此限。"),
				};
			case EnablementState.DisabledByAllowlist:
				return { text: localize('extStateAllowlist', "被企业策略禁用"), cls: 'plugins-ext-badge-env', title: '' };
			case EnablementState.DisabledByTrustRequirement:
				return { text: localize('extStateTrust', "需要信任工作区"), cls: 'plugins-ext-badge-warn', title: '' };
			case EnablementState.DisabledByExtensionKind:
				return { text: localize('extStateKind', "不适用于本窗口"), cls: 'plugins-ext-badge-warn', title: '' };
			case EnablementState.DisabledByExtensionDependency:
				return { text: localize('extStateDependency', "依赖未满足"), cls: 'plugins-ext-badge-warn', title: '' };
			case EnablementState.DisabledByVirtualWorkspace:
				return { text: localize('extStateVirtual', "虚拟工作区不支持"), cls: 'plugins-ext-badge-warn', title: '' };
			case EnablementState.DisabledByInvalidExtension:
				return { text: localize('extStateInvalid', "扩展已损坏"), cls: 'plugins-ext-badge-env', title: '' };
			case EnablementState.DisabledByMalicious:
				return { text: localize('extStateMalicious', "已被标记为恶意"), cls: 'plugins-ext-badge-env', title: '' };
			case EnablementState.DisabledGlobally:
			case EnablementState.DisabledWorkspace:
				return { text: localize('extStateDisabled', "已禁用"), cls: 'plugins-ext-badge-off', title: '' };
			default:
				return undefined;
		}
	}

	private _createExtensionCard(ext: IExtension): HTMLElement {
		const card = $('div.plugins-ext-card');
		const enabled = this._isExtensionEnabled(ext);
		if (!enabled) {
			card.classList.add('disabled');
		}

		// Top：名称 + 版本 + 徽标
		const top = $('div.plugins-ext-top');
		const name = $('span.plugins-ext-name');
		name.textContent = ext.displayName || ext.name || ext.identifier.id;
		name.title = ext.identifier.id;
		top.appendChild(name);

		const version = $('span.plugins-ext-version');
		version.textContent = `v${ext.version}`;
		top.appendChild(version);

		if (ext.isBuiltin) {
			top.appendChild(this._extensionBadge(localize('extBadgeBuiltin', "内置"), 'plugins-ext-badge-builtin', ''));
		}
		const stateLabel = this._extensionStateLabel(ext);
		if (stateLabel) {
			top.appendChild(this._extensionBadge(stateLabel.text, stateLabel.cls, stateLabel.title));
		}
		if (ext.outdated) {
			top.appendChild(this._extensionBadge(localize('extBadgeUpdate', "有更新"), 'plugins-ext-badge-update', ''));
		}
		card.appendChild(top);

		const meta = $('div.plugins-ext-meta');
		meta.textContent = [ext.publisherDisplayName || ext.publisher, ext.identifier.id].filter(Boolean).join(' · ');
		card.appendChild(meta);

		if (ext.description) {
			const desc = $('div.plugins-ext-desc');
			desc.textContent = ext.description;
			card.appendChild(desc);
		}

		// Actions
		const actions = $('div.plugins-ext-actions');
		const toggle = $('button.plugins-ext-btn') as HTMLButtonElement;
		toggle.textContent = enabled ? localize('extensionDisable', "禁用") : localize('extensionEnable', "启用");
		toggle.onclick = () => this._setExtensionEnabled(ext, !enabled);
		actions.appendChild(toggle);

		if (!ext.isBuiltin) {
			const uninstall = $('button.plugins-ext-btn.danger') as HTMLButtonElement;
			uninstall.textContent = localize('extensionUninstall', "卸载");
			uninstall.onclick = () => this._uninstallExtension(ext);
			actions.appendChild(uninstall);
		}

		const location = ext.local?.location ?? ext.resourceExtension?.location;
		if (location) {
			const openDir = $('button.plugins-ext-btn') as HTMLButtonElement;
			openDir.textContent = localize('extensionOpenFolder', "打开目录");
			openDir.onclick = () => this.openerService.open(location, { openExternal: true });
			actions.appendChild(openDir);
		}
		card.appendChild(actions);

		return card;
	}

	private _extensionBadge(text: string, cls: string, title: string): HTMLElement {
		const badge = $('span.plugins-ext-badge');
		badge.classList.add(cls);
		badge.textContent = text;
		if (title) {
			badge.title = title;
		}
		return badge;
	}

	private async _setExtensionEnabled(ext: IExtension, enable: boolean): Promise<void> {
		try {
			await this.extensionsWorkbenchService.setEnablement(
				ext,
				enable ? EnablementState.EnabledGlobally : EnablementState.DisabledGlobally
			);
			this.logService.info(`[PluginsViewPane] ${enable ? 'enabled' : 'disabled'} extension "${ext.identifier.id}"`);
		} catch (err) {
			this.logService.error(`[PluginsViewPane] setEnablement("${ext.identifier.id}") failed`, err);
			this.notificationService.error(localize('extensionEnablementFailed', "修改扩展启用状态失败：{0}", err instanceof Error ? err.message : String(err)));
		} finally {
			this._renderExtensions();
		}
	}

	private async _uninstallExtension(ext: IExtension): Promise<void> {
		try {
			await this.extensionsWorkbenchService.uninstall(ext);
			this.logService.info(`[PluginsViewPane] uninstalled extension "${ext.identifier.id}"`);
			this.notificationService.info(localize('extensionUninstalled', "已卸载扩展：{0}", ext.identifier.id));
		} catch (err) {
			this.logService.error(`[PluginsViewPane] uninstall("${ext.identifier.id}") failed`, err);
			this.notificationService.error(localize('extensionUninstallFailed', "卸载扩展失败：{0}", err instanceof Error ? err.message : String(err)));
		} finally {
			this._renderExtensions();
		}
	}

	/**
	 * 本地安装 VSIX（文件选择）。
	 *
	 * ★ agents 窗口里**没有原生扩展市场**（`product.json` 未配置 `extensionsGallery` ⇒
	 * `CONTEXT_HAS_GALLERY=false`），所以 VSIX 是本窗口唯一的原生扩展安装通道
	 * （见 `doc/native-extensions-in-agents-window-plan.md` L4-R3）。
	 */
	private async _pickVsixAndInstall(): Promise<void> {
		let picked: URI[] | undefined;
		try {
			picked = await this.fileDialogService.showOpenDialog({
				title: localize('installVsixTitle', "选择 VSIX 扩展包"),
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: [{ name: 'VSIX', extensions: ['vsix'] }],
			});
		} catch (err) {
			this.logService.error('[PluginsViewPane] VSIX 文件选择失败', err);
			return;
		}
		if (!picked || picked.length === 0) {
			return;
		}
		await this._installVsixFromUri(picked[0]);
	}

	/**
	 * 从 http(s) 直链安装 VSIX（内网制品库 / 共享盘 / 发布物直链）。
	 *
	 * 为什么需要它：没有 gallery 时，用户拿到扩展的唯一方式是"有人给他一个 .vsix 文件"；
	 * 直链把这条链路变成可脚本化/可分享的（也能被自动化调用）。
	 *
	 * ★ 下载复用商城的流式通道 `marketplace.downloadToFile`（由内置扩展 tof-authentication 注册，
	 * agents 窗口在该扩展的必跑白名单里）—— 走扩展宿主的 Node 环境直接落盘，
	 * 避免把二进制经 IPC 搬进 renderer（商城下载同款做法）。
	 */
	private async _installVsixFromUrl(): Promise<void> {
		let url: string | undefined;
		try {
			url = await this.quickInputService.input({
				title: localize('installVsixFromUrlTitle', "从 URL 安装扩展（VSIX）"),
				placeHolder: 'https://…/my-extension-1.0.0.vsix',
				ignoreFocusLost: true,
				validateInput: async value => {
					if (!value) {
						return undefined;
					}
					return /^https?:\/\/\S+\.vsix$/i.test(value)
						? undefined
						: localize('installVsixFromUrlInvalid', "请输入以 http(s):// 开头、以 .vsix 结尾的下载地址");
				},
			});
		} catch (err) {
			this.logService.error('[PluginsViewPane] VSIX URL 输入失败', err);
			return;
		}
		if (!url) {
			return;
		}

		const tmpVsix = URI.joinPath(
			resolveSarosPath(userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome), SarosPath.tmp),
			`vsix-${Date.now()}.vsix`
		);
		try {
			await this.fileService.createFolder(URI.joinPath(tmpVsix, '..'));
			this.logService.info(`[PluginsViewPane] downloading VSIX from "${url}" → ${tmpVsix.fsPath}`);
			const resp = await this.commandService.executeCommand<{ statusCode: number }>(
				'marketplace.downloadToFile', { url, headers: {}, savePath: tmpVsix.fsPath }
			);
			if (!resp || resp.statusCode >= 400) {
				throw new Error(`HTTP ${resp?.statusCode ?? '无响应'}`);
			}
		} catch (err) {
			this.logService.error(`[PluginsViewPane] VSIX 下载失败: ${url}`, err);
			this.notificationService.error(localize('vsixDownloadFailed', "下载 VSIX 失败：{0}", err instanceof Error ? err.message : String(err)));
			return;
		}

		try {
			await this._installVsixFromUri(tmpVsix);
		} finally {
			try { await this.fileService.del(tmpVsix); } catch { /* ignore */ }
		}
	}

	/** VSIX 安装的统一出口（文件选择 / URL 下载共用）。 */
	private async _installVsixFromUri(vsix: URI): Promise<void> {
		try {
			this.logService.info(`[PluginsViewPane] installing VSIX "${vsix.toString()}"`);
			await this.extensionsWorkbenchService.install(vsix);
			this.notificationService.info(localize('extensionInstalled', "扩展安装完成；如未生效请 Reload Window。"));
		} catch (err) {
			this.logService.error('[PluginsViewPane] install VSIX failed', err);
			this.notificationService.error(localize('extensionInstallFailed', "安装扩展失败：{0}", err instanceof Error ? err.message : String(err)));
		} finally {
			this._renderExtensions();
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

		if (this._extensionsContainer) {
			this._extensionsContainer.style.height = `${listHeight}px`;
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
