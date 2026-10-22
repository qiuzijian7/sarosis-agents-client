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
import { IListRenderer } from '../../../../../base/browser/ui/list/list.js';
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
// dsh 插件商城页（编辑区，2026-10-14）：本视图的「添加插件」段给一个按钮打开它（宽页才放得下社区目录的浏览）
import { DshPluginMarketEditorInput } from '../dshPluginMarketEditorInput.js';
import { IEditorService, SIDE_GROUP } from '../../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IMarketplaceService, IMarketplacePackage, PackageKind } from '../../common/marketplace.js';
import { dshPluginRecommendations } from '../../common/dshPluginRecommendations.js';
// 插件自带技能（`<插件包>/skills`）：装完要刷技能库才看得见（见 `_dshInstallPlugin` ✓）
import { ISkillRegistry } from '../../common/skills.js';
// 安装通道选择（本地 / 主进程 spec / 商城那条）：真安装与"取消"按钮共用同一判据 ✓
import { dshInstallTransport } from '../../common/dshPluginTransport.js';
import { IDshMarketEntry, dshMarketInstallSpec, fetchDshMarketCatalog } from '../dshMarketCatalog.js';
// ── dsh 插件来源（方案 4.5）──────────────────────────────────────────────────
// 分层：dsh 通道服务在 electron-browser 层，本视图在 browser 层 ⇒ 只经钩子取实现
// （同 `dshChatHost.ts`）；未注册（总开关关闭）时「DSH」页签不出现。
import { DshPluginCenterHmr, getDshPluginCenterHost, IDshBundle, IDshBundledInstallResult, IDshBundledPluginRow, IDshInspectResult, IDshInstallResult, IDshPluginBundlesSnapshot, IDshPluginCenterHost, IDshPluginCenterRow } from '../dshPluginCenterHost.js';
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

/** 插件中心页签；`dsh` 仅在 dsh 总开关打开时存在（方案 4.5）。 */
/**
 * 视图页签。**三个**（方案 B，2026-10-11 归并）：
 * - `installed`：Agent 插件（dsh profile 组合）；
 * - `extensions`：VS Code 原生扩展 **+ 两个市场的搜索**（gallery 与内部商城）**+ 无搜索词时的商城浏览**；
 * - `dsh`：dsh 运行时（状态 / 组合 / 启停 / 添加插件）。
 *
 * 为什么删掉独立的 `marketplace` 页签：`extensions` 页签的搜索**本来就同时搜两个市场**
 * （渲染"市场结果 / 商城结果 / 已安装"三个分组），独立页签只多出"无搜索词时按热度浏览"这一件事
 * ⇒ 把它作为 `extensions` 页签**未输入搜索词时的初始内容**，页签从 4 个降到 3 个，
 * 用户也不必再猜 "Extensions" 与 "Marketplace" 的区别（原来要在提示条里教"切到商城 tab"）。
 */
type PluginsTab = 'installed' | 'extensions' | 'dsh';

/**
 * 「DSH」页签内的三段（方案 5.16 批次 2）：
 * `official` = 官方随附组合包（可选、默认关）；`installed` = 已安装组合包 + VsSaros 侧启停；
 * `add` = 添加插件（批次 4 落安装链路）。
 */
// ⚠ 2026-10-12（方案 B 第 4 步"全搬"）：原来的段类型 `DshMarketSegment`（随包模块 / 官方 / 已安装 / 添加插件）
// 已取消——四段全部搬走，只留**运行态现场**（现场模块 + 启停开关）与「添加插件」入口，不再需要切段。


const KIND_LABEL: Record<PackageKind, string> = {
	skill: 'Skill',
	agent: 'Agent',
	mcp: 'MCP',
	knowledge: '\u77E5\u8BC6\u5E93', // 知识库
	workflow: '\u5DE5\u4F5C\u6D41', // 工作流
	// ★ 2026-10-22：工作台（dsh 插件包）
	workbench: '工作台',
};

const KIND_ICON: Record<PackageKind, string> = {
	skill: '\u{1F4C4}',
	agent: '\u{1F916}',
	mcp: '\u{1F50C}',
	knowledge: '\u{1F4DA}',
	workflow: '\u{1F527}',
	// ★ 2026-10-22：工作台
	workbench: '\u{1F5A5}',
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

// --- Main ViewPane ---

/**
 * Plugins View — Plugin management sidebar.
 *
 * Data source: `IAgentPluginService.plugins` (IObservable)
 * Rendering: **DOM 分组列表**（4b，2026-10-11）——与「扩展」页签同一套渲染机制；此前是 `WorkbenchList`。
 *   外观没变：行仍用 `.agent-plugin-list-item` 那套（它本来就自洽：flex + padding + hover），
 *   模板/动作也仍走 `PluginListRenderer`，只是**由 DOM 容器承载**并把行**按来源分组**。
 */
export class PluginsViewPane extends ViewPane {

	/** 插件页签的渲染层（`listContainer` 是滚动容器，这里是它内部供 `replaceChildren` 的那一层）。 */
	private _installedListEl: HTMLElement | undefined;
	/** 行渲染器（沿用列表时代那一份，避免"换个承载就换一套外观"）。 */
	private _pluginRowRenderer: PluginListRenderer | undefined;
	/** 上一轮渲染出来的行模板数据：整层重绘前逐个 `disposeTemplate`（释放 ActionBar / 动作，否则泄漏）。 */
	private _renderedRowTemplates: IPluginTemplateData[] = [];
	private searchInput!: HTMLInputElement;
	/** 「打开插件商城（编辑区）」入口行（搜索框正下方，仅 dsh 页签显示）。 */
	private _openMarketRow!: HTMLElement;
	private detailContainer: HTMLElement | undefined;
	private listContainer: HTMLElement | undefined;

	// ── Marketplace state ─────────────────────────────────

	private _marketplaceStatusEl!: HTMLElement;
	private _marketplaceGridEl!: HTMLElement;
	private _marketplacePackages: IMarketplacePackage[] = [];
	/** 社区插件目录（`dsh-market` 的那份内容；`undefined` = 还没读过）。 */
	private _dshMarketEntries: readonly IDshMarketEntry[] | undefined;
	private _dshMarketError = '';
	private _dshMarketLoading = false;
	private _marketplaceLoading = false;
	private _marketplaceError = '';
	private _installingIds: Set<string> = new Set();
	/** Set of installed storeIds (slug) for showing "已安装" badge */
	private _installedSlugs: Set<string> = new Set();

	private readonly _searchQuery = observableValue<string>('pluginsSearchQuery', '');
	private readonly _activeTab = observableValue<PluginsTab>('pluginsActiveTab', 'installed');
	private readonly _selectedPlugin = observableValue<IAgentPlugin | undefined>('selectedPlugin', undefined);

	// ── 「DSH」tab 状态（方案 4.5：dsh 运行时状态 + 已装插件 + 启停开关）──
	private _dshHost: IDshPluginCenterHost | undefined;
	private _dshContainer: HTMLElement | undefined;
	private _dshStatusEl: HTMLElement | undefined;
	private _dshListEl: HTMLElement | undefined;
	private _dshRows: readonly IDshPluginCenterRow[] = [];
	private _dshHmr: DshPluginCenterHmr = 'unknown';
	private _dshLoading = false;
	// ── 「DSH」页签内的四段（方案 5.16 批次 2 + 「随包模块」）：随包模块 / 官方随附 / 已安装 / 添加插件 ──
	/**
	 * 默认落在「随包模块」段：这是**用户真正要干的事**（随产品分发的模块插件一键装上），
	 * 而「官方」段是随发行的可选组合包（多数人不碰）。默认为空段会让新用户看不到入口。
	 */

	/** 随包模块清单（`dsh-plugins/*` + profile 实装版本）；`undefined` = 还没取到。 */
	private _dshBundled: readonly IDshBundledPluginRow[] | undefined;
	/** 随包清单的加载闸（「插件」页签与「运行时」页签共用这份数据，避免两边并发重复加载）。 */
	private _dshBundledLoading = false;
	/** 正在安装的随包插件名（按钮置灰用）。 */
	private _dshBundledBusy: string | undefined;
	/** 随包安装的结果话术（跨重绘保留）。 */
	private _dshBundledNote: string | undefined;
	// ── 「添加插件」段的界面状态（方案 5.16 批次 4）：都存字段，段切换/重绘后不丢 ──
	/** spec 输入框内容。 */
	private _dshSpec = '';
	/** 最近一次预检的结果（含被检的 spec，spec 改了要重检）。 */
	private _dshInspect: { readonly spec: string; readonly result: IDshInspectResult } | undefined;
	/** 进行中的安装（requestId 用于取消）；undefined = 没有安装在跑。 */
	private _dshInstalling: { readonly requestId: string; readonly spec: string } | undefined;
	/** 安装/卸载的结果话术（跨重绘保留，显示在添加插件段）。 */
	private _dshInstallNote: string | undefined;
	/** 等待显式允许的构建脚本（Host 回填的 `pendingBuilds`）：非空时给「允许并重装」按钮。 */
	private _dshPendingApproval: { readonly spec: string; readonly builds: readonly string[] } | undefined;

	private _dshBundles: IDshPluginBundlesSnapshot | undefined;

	/** tab 按钮（`_switchTab` 统一维护 active 样式）；`dsh` 只在总开关打开时存在。 */
	private _tabButtons!: Partial<Record<PluginsTab, HTMLButtonElement>>;

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
		// 插件可能自带技能（`<插件包>/skills`）⇒ 装完要刷技能库（见 `_dshInstallPlugin` 的 finally ✓）
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
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

		// Tabs —— 已装插件 / VS Code 扩展 / dsh 组合包（**T1 改名 + S1 分段控件**，2026-10-14）
		//
		// 为什么改名（IA 诊断见 `doc/dsh-plugin-center-ia-tabs-mockup.html`）：原来「插件 / 扩展 / 运行时」
		// 三个标签**不在同一维度** —— 前两个是"东西的种类"，"运行时"是**进程状态**；而且「插件」与「运行时」
		// 各列了一份插件清单 ⇒ 用户分不清哪个是"我装的"。现在三个标签直呼其物（含"已装 / 可获取"的区分），
		// Host 状态改由**页签上的状态点**表达，不再占页签位。
		//
		// 无障碍（S1）：容器 `role=tablist`、按钮 `role=tab` + `aria-selected` + **roving tabindex**
		// （选中项 0、其余 -1）+ 方向键 / Home / End 直接切换。计数与状态点只更新 `textContent` / 一个类名，
		// **不重建按钮**（重建会让焦点与 e2e 的点击目标失效）。
		// ⚠ 保留 `.plugins-tab` / `.active` 类名：e2e 与守卫都按 `document.querySelectorAll('.plugins-tabs button')` 取它。
		const tabs = append(container, $('.plugins-tabs'));
		tabs.setAttribute('role', 'tablist');
		tabs.setAttribute('aria-label', localize('pluginsTabsAria', "插件中心分类"));
		const makeTab = (key: PluginsTab, label: string): HTMLButtonElement => {
			const btn = append(tabs, $('button.plugins-tab')) as HTMLButtonElement;
			btn.id = `plugins-tab-${key}`;
			btn.setAttribute('role', 'tab');
			btn.setAttribute('aria-selected', 'false');
			btn.tabIndex = -1;
			append(btn, $('span.plugins-tab-label')).textContent = label;
			append(btn, $('span.plugins-tab-count')).textContent = '';
			btn.onclick = () => this._switchTab(key);
			return btn;
		};
		const installedTab = makeTab('installed', localize('pluginsTabInstalled', "已装插件"));
		const extensionsTab = makeTab('extensions', localize('pluginsTabExtensions', "VS Code 扩展"));
		this._tabButtons = { installed: installedTab, extensions: extensionsTab };

		// dsh 插件来源页签（方案 4.5）：总开关关闭时钩子不存在，页签与容器都不建。
		this._dshHost = getDshPluginCenterHost();
		if (this._dshHost) {
			const dshTab = makeTab('dsh', localize('pluginsTabRuntime', "dsh 组合包"));
			const dot = append(dshTab, $('span.plugins-tab-dot'));
			dot.title = localize('pluginsTabDshDotHint', "实心＝已连上 Host（能读到组合包清单）");
			this._tabButtons.dsh = dshTab;
		}

		// 方向键 / Home / End 在页签间移动（**选中即激活**：VS Code 侧栏的 tab 就是这个口径，不必再按回车）
		tabs.addEventListener('keydown', (e: KeyboardEvent) => {
			if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { return; }
			e.preventDefault();
			const order: PluginsTab[] = this._tabButtons.dsh ? ['installed', 'extensions', 'dsh'] : ['installed', 'extensions'];
			const current = Math.max(0, order.indexOf(this._activeTab.get()));
			const next = e.key === 'Home' ? 0
				: e.key === 'End' ? order.length - 1
					: e.key === 'ArrowLeft' ? (current - 1 + order.length) % order.length
						: (current + 1) % order.length;
			this._switchTab(order[next]);
			this._tabButtons[order[next]]?.focus();
		});

		// Search (works for all tabs)
		this.searchInput = append(container, $('input.plugins-search')) as HTMLInputElement;
		// 占位符随页签切换（见 `_switchTab`）；默认（插件页签）用中文——原来这里是英文 "Search Plugins..."，
		// 与本视图其它中文串混排。
		this.searchInput.placeholder = localize('searchInstalledPlugins', "搜索已装插件（名称 / 描述）…");
		this.searchInput.type = 'text';
		// ── 「打开插件商城（编辑区）」入口（2026-10-15 挪位：添加插件段 → 搜索框正下方）────────────
		// 用户实测反馈：按钮埋在「添加插件」段（列表最底部）根本看不见 ⇒ 提到搜索框下、页签内容之上。
		// 只对 dsh 组合包页签显示（显隐在 `_switchTab` 里与容器同步）；样式复用 `plugins-dsh-add-open`。
		this._openMarketRow = append(container, $('div.plugins-dsh-add-open'));
		const openBtn = append(this._openMarketRow, $('button.plugins-btn')) as HTMLButtonElement;
		openBtn.textContent = localize('dshOpenMarket', "打开插件商城（编辑区）");
		openBtn.title = localize('dshOpenMarketHint', "在编辑区打开完整商城：搜索社区目录、按来源筛选、一键安装（与这里同一套安装通道判据）。");
		openBtn.onclick = () => this._openDshPluginMarket();
		this.searchInput.oninput = () => {
			const value = this.searchInput.value;
			this._searchQuery.set(value, undefined);
			// Re-render the active DOM-rendered tab on search change
			if (this._activeTab.get() === 'extensions') {
				// 本地即时过滤 + 市场搜索（防抖 400ms）
				this._renderExtensions();
				this._scheduleMarketSearch(this._searchQuery.get().trim());
			} else if (this._activeTab.get() === 'dsh') {
				// 本地即时过滤（插件清单已在内存里，不重新拉取）。
				this._renderDshRows();
			}
		};

		// Installed list Container（4b：DOM 滚动容器 + 内部渲染层，不再是 WorkbenchList）
		this.listContainer = append(container, $('.plugins-list-container'));
		this._installedListEl = append(this.listContainer, $('.plugins-installed-list'));
		// 列表时代的无障碍由 `IListAccessibilityProvider` 给；DOM 版用语义化角色 + 行级 aria-label 顶上。
		this._installedListEl.setAttribute('role', 'list');
		// 面板语义（S1）：`role=tabpanel` + 由对应页签 aria-controls 指过来（面板与页签互为参照）。
		this.listContainer.id = 'plugins-panel-installed';
		this.listContainer.setAttribute('role', 'tabpanel');
		this.listContainer.setAttribute('aria-labelledby', 'plugins-tab-installed');
		this._tabButtons.installed?.setAttribute('aria-controls', 'plugins-panel-installed');

		// 清单变化（插件服务 / 搜索词）时重绘当前页签——与「扩展」页签同一套做法（原来挂在列表创建里）。
		// 顺带刷页签计数（S1）：插件清单变了，"已装插件"那个数就该跟着变。
		this._register(autorun(reader => {
			const items = this._filteredPlugins.read(reader);
			if (this._activeTab.get() === 'installed') {
				this._renderInstalledTab(items);
			}
			this._updateTabBadges();
		}));

		// VS Code Extensions Container (hidden by default, rendered as DOM cards)
		// ⚠ 初始隐藏靠 **CSS 的 `display:none`**，不靠内联样式：`_switchTab` **只在点击时调用**（构造时
		// 不调）⇒ 若把"默认隐藏"留在这里而它被删掉，首次绘制就是三个容器全可见。
		// 2026-10-11 收敛：本视图**不再有 `style.cssText`**（静态样式一律进 `pluginsView.css`，守卫盯住）。
		this._extensionsContainer = append(container, $('.plugins-extensions-container'));
		this._extensionsHeaderEl = append(this._extensionsContainer, $('.plugins-extensions-header'));
		this._extensionsListEl = append(this._extensionsContainer, $('.plugins-extensions-list'));
		this._extensionsContainer.id = 'plugins-panel-extensions';
		this._extensionsContainer.setAttribute('role', 'tabpanel');
		this._extensionsContainer.setAttribute('aria-labelledby', 'plugins-tab-extensions');
		this._tabButtons.extensions?.setAttribute('aria-controls', 'plugins-panel-extensions');

		// 商城浏览（原独立页签，现并入「扩展」页签**未输入搜索词时的初始内容**）：
		// 两个节点**先创建、不挂载**，由 `_renderExtensions()` 在无搜索词时挂到扩展列表末尾 ⇒
		// 跟着扩展列表一起滚动（此前是独立容器 + 独立滚动条：一半高、两套滚动条）。
		this._marketplaceStatusEl = $('.plugins-marketplace-status');
		this._marketplaceGridEl = $('.plugins-marketplace-grid');

		// 「DSH」Container (hidden by default, rendered as DOM rows)
		if (this._dshHost) {
			this._dshContainer = append(container, $('.plugins-dsh-container'));
			this._dshContainer.id = 'plugins-panel-dsh';
			this._dshContainer.setAttribute('role', 'tabpanel');
			this._dshContainer.setAttribute('aria-labelledby', 'plugins-tab-dsh');
			this._tabButtons.dsh?.setAttribute('aria-controls', 'plugins-panel-dsh');
			this._dshStatusEl = append(this._dshContainer, $('.plugins-dsh-status'));
			this._dshListEl = append(this._dshContainer, $('.plugins-dsh-list'));
			// 清单 / Host 状态变化时（启停开关、重启、装插件）重绘当前页签。
			this._register(this._dshHost.onDidChange(() => {
				if (this._activeTab.get() === 'dsh') {
					void this._renderDshTab();
				}
			}));
		}

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

	private _switchTab(tab: PluginsTab): void {
		// Clear search when switching tabs
		this._searchQuery.set('', undefined);
		this.searchInput.value = '';

		this._activeTab.set(tab, undefined);

		// Update tab button styles（`.active` 继续保留给 e2e / 守卫；无障碍状态另走 aria-selected + roving tabindex）
		for (const key of ['installed', 'extensions', 'dsh'] as const) {
			const btn = this._tabButtons[key];
			if (!btn) { continue; }
			const on = key === tab;
			btn.classList.toggle('active', on);
			btn.setAttribute('aria-selected', on ? 'true' : 'false');
			btn.tabIndex = on ? 0 : -1;   // roving tabindex：只有选中的那个页签进 Tab 键顺序
		}

		// Show/hide containers（商城的节点在扩展列表里，不再有独立容器）
		//
		// ⚠ 两个 DOM 容器这里必须给**显式值**（`flex` / `block`）而不是 `''`：它们的 CSS 默认值是
		// `display:none`（初始隐藏的**唯一**来源，见构造处的注释）⇒ 用 `''` 清掉内联后回落到 `none`，
		// 页签就再也显示不出来了。`listContainer` 保持 `''`（CSS 没写 `display`，回落即 `block`）。
		this.listContainer!.style.display = tab === 'installed' ? '' : 'none';
		this._extensionsContainer.style.display = tab === 'extensions' ? 'flex' : 'none';
		if (this._dshContainer) {
			this._dshContainer.style.display = tab === 'dsh' ? 'block' : 'none';
		}
		this.searchInput.style.display = '';
		// 商城入口只对 dsh 页签显示（它开的是 dsh 插件商城页）
		if (this._openMarketRow) {
			this._openMarketRow.style.display = tab === 'dsh' ? '' : 'none';
		}

		// 页签上的计数 / 状态点（S1）：三个页签都要刷新（与当前是哪个无关），放这里各分支都能走到。
		this._updateTabBadges();

		if (tab === 'installed') {
			this.searchInput.placeholder = localize('searchInstalledPlugins', "搜索已装插件（名称 / 描述）…");
			this._renderInstalledTab(this._filteredPlugins.get());
			return;
		}

		if (tab === 'extensions') {
			// 市场可用时明确提示"可搜市场"，否则说明只能用 VSIX（避免用户以为搜索坏了）。
			this.searchInput.placeholder = this._isGalleryAvailable()
				? localize('searchExtensionsAndMarket', "搜索已安装扩展、扩展市场与商城…")
				: localize('searchExtensionsLocal', "搜索已安装扩展（未配置扩展市场）…");
			this._scheduleMarketSearch('');  // 切 tab 时清空市场状态（搜索框内容已被清空）
			this._renderExtensions();
			return;
		}

		// 剩下的就是「dsh 组合包」（dsh）
		this.searchInput.placeholder = localize('searchDshPlugins', "搜索组合包 / 模块（名称）…");
		void this._renderDshTab();
	}

	/**
	 * 页签上的**计数**与**状态点**（S1，2026-10-14；设计见 `doc/dsh-plugin-center-ia-tabs-mockup.html`）。
	 *
	 * 计数口径（各自页签里"我能看到几条"）：
	 *  · 已装插件 = Agent 插件清单长度（搜索**前**的全量，避免搜索时计数乱跳）；
	 *  · VS Code 扩展 = 本地扩展数；
	 *  · dsh 组合包 = profile 里**已装**的组合包数。
	 *
	 * 状态点：只在 dsh 组合包页签上 —— 能读到组合包清单就说明 Host 在跑（**不额外探活**：为一个圆点去连 Host 不值当）。
	 *
	 * ⚠ 只改 `textContent` 与一个类名，**不重建按钮**：重建会让用户焦点、以及 e2e 的点击目标失效
	 *   （e2e 会先点页签再在同一次求值里读 DOM）。
	 */
	private _updateTabBadges(): void {
		const setCount = (key: PluginsTab, count: number | undefined): void => {
			const el = this._tabButtons[key]?.querySelector('.plugins-tab-count');
			if (!el) { return; }
			el.textContent = count === undefined ? '' : String(count);
			el.classList.toggle('is-zero', count === 0);
		};
		setCount('installed', this._filteredPlugins.get().length);
		setCount('extensions', this.extensionsWorkbenchService.local.length);
		const bundles = this._dshBundles?.bundles;
		setCount('dsh', bundles ? bundles.filter(b => b.installed).length : undefined);
		this._tabButtons.dsh?.querySelector('.plugins-tab-dot')?.classList.toggle('on', !!bundles);
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
		// 本地扩展数变了 ⇒ 页签计数跟着变（S1）
		this._updateTabBadges();

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
			// ── 社区目录（dsh-market）也要**在搜索里过滤**（2026-10-13）──
			// 为什么放这里：`_renderDshMarketSection` 本来就带"按搜索词过滤 name/owner/npm/description"，
			// 而且它给用户的提示写着"在搜索框里输入关键词可筛" —— 此前只在**无搜索词**的浏览态渲染，
			// 于是那句话对不上（一输入关键词这段就整个消失）。这里把它接进搜索路径，顺序与浏览态一致：
			// 市场结果 → 商城结果 → 社区目录 → 已安装。
			// ⚠ 进搜索路径前先清空那个容器：它里面可能还存着"无搜索词"时的「商城资源（36）」浏览卡片。
			clearNode(this._marketplaceGridEl);
			this._extensionsListEl.appendChild(this._marketplaceGridEl);
			this._renderDshMarketSection();
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
		} else {
			for (const ext of filtered) {
				this._extensionsListEl.appendChild(this._createExtensionCard(ext));
			}
		}

		// ── 商城浏览（**未输入搜索词**时的初始内容；有搜索词时用上面的「商城结果」分组代替）──
		// 方案 B：原独立的「Marketplace」页签并入这里——它的搜索与上面的「商城结果」重复，唯一独有的
		// 是"无查询时按热度浏览"，正好补在这个位置；节点挂在扩展列表末尾 ⇒ 同一滚动区。
		// ⚠ 不能写在上面那个"没有已安装扩展就提前返回"的分支后面：全新 profile 恰恰是最需要看到商城的场景。
		if (!raw) {
			this._extensionsListEl.appendChild(this._marketplaceStatusEl);
			this._extensionsListEl.appendChild(this._marketplaceGridEl);
			if (this._marketplacePackages.length === 0) {
				void this._loadMarketplacePackages();      // 首次进入时拉一次（内部有 loading 去重）
			} else {
				this._renderMarketplaceCards();
			}
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
			notes.push(localize('marketNotConfigured', "未配置扩展市场（extensionsGallery）⇒ 搜索只能覆盖已安装扩展与内部商城；可用「安装 VSIX…／从 URL 安装…」，内部商城资源就在下方「商城资源」列表里。"));
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

	/**
	 * 打开一个插件的详情：优先**编辑器区**的详情页签（像 VS Code 扩展视图），失败才退回侧栏详情。
	 *
	 * 这段原来写在 WorkbenchList 的 `onDidChangeSelection` 里；4b 换成 DOM 列表时提出成方法，
	 * 行**点击**与**键盘激活**都走它（行为与列表时代一致）。
	 */
	private _openPluginDetails(plugin: IAgentPlugin): void {
		this._selectedPlugin.set(plugin, undefined);
		try {
			const input = new PluginDetailEditorInput(plugin);
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
			this._showPluginDetail(plugin);
		}
	}

	/**
	 * 插件页签的渲染主体：**DOM 分组列表**（4b，2026-10-11）。
	 *
	 * 分组判据只用 `IAgentPlugin.fromMarketplace`——它是插件接口里唯一可靠的"来源"标记（`uri` 前缀
	 * 随安装位置/短名变化，不能当来源用）⇒ 两段：**本地与内置** / **商城安装**。段标题走基础件
	 * `.plugins-section`（与其它页签同一套外观）。
	 */
	private _renderInstalledTab(items: readonly IPluginDisplayInfo[]): void {
		const host = this._installedListEl;
		if (!host) {
			return;
		}
		if (this._pluginRowRenderer) {
			for (const data of this._renderedRowTemplates) {
				this._pluginRowRenderer.disposeTemplate(data);
			}
		}
		this._renderedRowTemplates = [];
		host.replaceChildren();

		if (items.length === 0) {
			const empty = append(host, $('div.plugins-empty'));
			empty.textContent = this._searchQuery.get()
				? localize('pluginsNoMatch', "没有匹配的插件。")
				: localize('pluginsNoPlugins', "还没有插件。");
			return;
		}

		const local: IPluginDisplayInfo[] = [];
		const fromMarket: IPluginDisplayInfo[] = [];
		for (const item of items) {
			(item.plugin.fromMarketplace ? fromMarket : local).push(item);
		}
		const sections = [
			{ label: localize('pluginsSectionLocal', "本地与内置"), rows: local },
			{ label: localize('pluginsSectionMarket', "商城安装"), rows: fromMarket },
		];
		for (const section of sections) {
			if (section.rows.length === 0) {
				continue;
			}
			append(host, $('div.plugins-section')).textContent = `${section.label}（${section.rows.length}）`;
			for (const item of section.rows) {
				this._renderPluginRow(host, item);
			}
		}

		// 「随包模块」段（方案 B 第 4 步第 2 小步，2026-10-12 从「运行时」页签搬来）：它本质是**插件**清单
		// （随产品分发、可一键装进 profile），放在这里与其它来源分组同类。两个注意点：
		// ① 这条链**不依赖 Host 运行**（读随包目录 + profile 清单）⇒ Host 没起来也能列出来装；
		// ② 数据是惰性的 ⇒ 首次进来先踢一次加载（`_dshBundledLoading` 两边共用同一份，避免重复读盘）。
		if (this._dshHost) {
			const query = this._searchQuery.get().trim().toLowerCase();
			if (this._dshBundled === undefined || this._dshBundles === undefined) {
				void this._loadBundledForInstalledTab();
			}
			// 顺序按方案 B 的来源表：本地与内置 / 商城安装 → **随包模块** → **已安装组合包** → **官方随附**。
			// 后两段是 2026-10-12「全搬」从「运行时」页签搬来的组合包清单。
			this._renderBundledInto(host, query, true);
			const data = this._dshBundles;
			const installed = (data?.bundles ?? []).filter(b => b.installed && (!query || b.name.toLowerCase().includes(query)));
			const official = (data?.bundles ?? []).filter(b => b.optional && (!query || b.name.toLowerCase().includes(query)));
			if (installed.length) {
				append(host, $('div.plugins-section')).textContent
					= `${localize('pluginsSectionInstalledBundles', "已安装组合包")}（${installed.length}）`;
				for (const b of installed) {
					this._renderDshBundleCard(host, b, 'installed');
				}
			}
			if (official.length) {
				append(host, $('div.plugins-section')).textContent
					= `${localize('pluginsSectionOfficialBundles', "官方随附")}（${official.length}）`;
				for (const b of official) {
					this._renderDshBundleCard(host, b, 'official');
				}
			}
		}
	}

	/** 只为「插件」页签加载随包清单（不碰 Host 运行状态）；完成后重绘当前页签。 */
	private async _loadBundledForInstalledTab(): Promise<void> {
		const host = this._dshHost;
		if (!host || this._dshBundledLoading) {
			return;
		}
		this._dshBundledLoading = true;
		try {
			const [bundles, bundled] = await Promise.all([
				host.loadBundles().catch(() => undefined),
				host.listBundledPlugins().catch(() => undefined),
			]);
			if (bundles) {
				this._dshBundles = bundles;
			}
			this._dshBundled = bundled;
		} finally {
			this._dshBundledLoading = false;
			if (this._activeTab.get() === 'installed') {
				this._renderInstalledTab(this._filteredPlugins.get());
			}
		}
	}

	/**
	 * 一行插件（DOM）。**模板与渲染都沿用 `PluginListRenderer`**（换承载不换外观），
	 * 只补两件列表时代由列表提供的东西：点击打开详情（点行内按钮不算）、键盘可达（Enter / 空格）。
	 */
	private _renderPluginRow(host: HTMLElement, item: IPluginDisplayInfo): void {
		const renderer = this._pluginRowRenderer ??= new PluginListRenderer(this.agentPluginService.enablementModel);
		const row = append(host, $('div.plugins-installed-row'));
		row.setAttribute('role', 'listitem');
		row.setAttribute('aria-label', `${item.label}, ${item.author}, ${item.description}`);
		const data = renderer.renderTemplate(row);
		renderer.renderElement(item, 0, data);
		this._renderedRowTemplates.push(data);

		row.onclick = e => {
			const target = e.target as HTMLElement | null;
			// 点在行内的按钮 / 动作条上时**不算**打开详情。列表时代这两者会叠在一起（动作按钮的点击
			// 也冒泡成选中 ⇒ 顺手把详情弹出来），这里把那个副作用去掉。
			if (target && target.closest('button, .monaco-action-bar')) {
				return;
			}
			this._openPluginDetails(item.plugin);
		};
		row.tabIndex = 0;
		row.onkeydown = e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._openPluginDetails(item.plugin);
			}
		};
	}

	/**
	 * 在**编辑区**打开「dsh 插件商城」页（2026-10-14）。
	 *
	 * 为什么单独一页而不是在本视图里做：本视图宽约 380px，只够放"策展推荐 + 手输 spec"；社区目录 4500+ 条的
	 * 浏览（搜索、来源筛选、★/下载量）需要宽度 ⇒ 照 `AgentMarketEditorInput` 的先例做成编辑区页面 ✓。
	 * 单例输入 + `Singleton` capability ⇒ 重复点只聚焦同一个 tab，不堆页面。
	 * 分组选择照 AgentMarket 的先例：只有一个 group 时开在侧组，否则复用第一个 group（避免把用户当前编辑挤走）。
	 */
	private _openDshPluginMarket(): void {
		const input = DshPluginMarketEditorInput.getInstance();
		this.instantiationService.invokeFunction((accessor: any) => {
			const editorService = accessor.get(IEditorService);
			const groups = accessor.get(IEditorGroupsService).getGroups(0);
			const target = groups.length <= 1 ? SIDE_GROUP : groups[0];
			void editorService.openEditor(input, { pinned: true }, target);
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
			this._renderDshMarketSection();
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
			this._renderDshMarketSection();
			return;
		}

		// Card grid
		const grid = $('div.plugins-marketplace-cards');
		for (const pkg of filtered) {
			grid.appendChild(this._createMarketplaceCard(pkg));
		}
		this._marketplaceGridEl.appendChild(grid);
		this._renderDshMarketSection();
	}

	/**
	 * 「插件商城」里的**社区目录**段（= `dsh-market` 展示的那份内容，见 `browser/dshMarketCatalog.ts`）。
	 *
	 * 为什么直接抓站点 JSON 而不去问那个插件：站点带 `access-control-allow-origin: *` ⇒ 渲染进程可直接取；
	 * 插件自身也没有"转发目录"的路由；这样我们的商城**不依赖它是否已装**。
	 *
	 * 展示口径：按 star 取前 12 条（全量 4579 条渲染成 DOM 卡片会卡），搜索框的词会就地过滤。
	 * 安装：**npm 包名优先**（与市场自己的策略一致），预检通过才真装；状态就地写在卡片里。
	 *
	 * `host` 参数（2026-10-13）：**同一段要挂在两个地方** —— 无搜索词时挂 `_marketplaceGridEl`（商城浏览态），
	 * 有搜索词时挂**扩展列表**（与「市场结果 / 商城结果」并列）。此前只挂前者，而本段自带"按搜索词过滤"，
	 * 于是那句给用户看的「在搜索框里输入关键词可筛」对不上（一输入关键词这段就没了）。
	 */
	 private _renderDshMarketSection(host: HTMLElement = this._marketplaceGridEl): void {
	 const header = $('div.plugins-marketplace-header');
		header.textContent = this._dshMarketEntries
			? `\u793E\u533A\u63D2\u4EF6\u5E02\u573A\uFF08dsh-market\uFF09\u00B7 \u5171 ${this._dshMarketEntries.length} \u6761`
			: '\u793E\u533A\u63D2\u4EF6\u5E02\u573A\uFF08dsh-market\uFF09';
		host.appendChild(header);

		if (this._dshMarketLoading) {
			host.appendChild($('div.plugins-meta')).textContent = localize('dshMarketLoading', "正在读取社区目录…");
			return;
		}
		if (this._dshMarketError) {
			const box = append(host, $('div.plugins-meta'));
			box.textContent = localize('dshMarketError', "读不到社区目录：{0}", this._dshMarketError);
			const retry = append(host, $('button.plugins-btn')) as HTMLButtonElement;
			retry.textContent = localize('dshMarketRetry', "重试");
			retry.onclick = () => {
				this._dshMarketError = '';
				this._loadDshMarketCatalog(true);
			};
			return;
		}
		if (!this._dshMarketEntries) {
			host.appendChild($('div.plugins-meta')).textContent = localize('dshMarketIdle', "正在读取社区目录…");
			this._loadDshMarketCatalog(false);
			return;
		}

		const query = this._searchQuery.get().trim().toLowerCase();
		const matching = query
			? this._dshMarketEntries.filter(e => e.name.toLowerCase().includes(query)
				|| e.owner.toLowerCase().includes(query)
				|| (e.npm ?? '').toLowerCase().includes(query)
				|| e.description.toLowerCase().includes(query))
			: this._dshMarketEntries;
		const top = [...matching].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)).slice(0, 12);
		if (!top.length) {
			host.appendChild($('div.plugins-meta')).textContent = localize('dshMarketNoMatch', "社区目录里没有匹配的插件。");
			return;
		}
		const grid = $('div.plugins-marketplace-cards');
		for (const entry of top) {
			grid.appendChild(this._createDshMarketCard(entry));
		}
		host.appendChild(grid);
		host.appendChild($('div.plugins-meta')).textContent = localize('dshMarketNote', "共 {0} 条匹配，按 star 取前 12 条；在搜索框里输入关键词可筛。", matching.length);
	}

	private _loadDshMarketCatalog(force: boolean): void {
		if (this._dshMarketLoading) {
			return;
		}
		this._dshMarketLoading = true;
		this._dshMarketError = '';
		void fetchDshMarketCatalog({ force }).then(
			entries => {
				this._dshMarketEntries = entries;
			},
			e => {
				// 刻意不做"内置快照兜底"：目录每天在长，过时的答案不是降级而是错误（与市场同一口径）。
				this._dshMarketError = e instanceof Error ? e.message : String(e);
			}
		).finally(() => {
			this._dshMarketLoading = false;
			// 目录到货后要重绘**两种**状态（2026-10-13）：此前只重绘"无搜索词"的浏览态，
			// 带搜索词时那一段会一直停在"正在读取社区目录…"（因为搜索路径现在也渲染它）。
			// 走 `_renderExtensions()` 一次覆盖两边（它内部会按当前搜索词重绘各分组）。
			if (this._activeTab.get() === 'extensions') {
				this._renderExtensions();
			}
		});
	}

	private _createDshMarketCard(entry: IDshMarketEntry): HTMLElement {
		const card = $('div.plugins-card');
		const head = append(card, $('div.plugins-row-head'));
		append(head, $('span.plugins-name')).textContent = entry.name;
		if (entry.version) {
			append(head, $('span.plugins-version')).textContent = `v${entry.version}`;
		}
		append(head, $('span.plugins-badge.is-info')).textContent = localize('dshMarketSource', "社区");
		if (entry.category) {
			append(head, $('span.plugins-meta')).textContent = entry.category;
		}
		append(card, $('div.plugins-meta')).textContent = entry.description;
		const meta = append(card, $('div.plugins-meta'));
		meta.textContent = [
			entry.owner ? `@${entry.owner}` : undefined,
			entry.stars !== undefined ? `\u2605 ${entry.stars}` : undefined,
			entry.downloads !== undefined ? `\u2193 ${entry.downloads}` : undefined,
			entry.npm ? `npm: ${entry.npm}` : localize('dshMarketGitOnly', "仅仓库（git）"),
			entry.capabilities.length ? localize('dshMarketCaps', "能力：{0}", entry.capabilities.join('/')) : undefined,
		].filter(Boolean).join(' \u00B7 ');

		const row = append(card, $('div.plugins-row-head'));
		const status = append(row, $('div.plugins-meta'));
		const btn = append(row, $('button.plugins-btn.plugins-dsh-row-btn')) as HTMLButtonElement;
		btn.textContent = localize('dshMarketInstall', "安装");
		btn.title = localize('dshMarketInstallHint', "先预检再安装（装的是这条的 npm 包；没有 npm 时回落仓库地址）。");
		btn.onclick = () => void this._installDshMarketEntry(entry, status, btn);
		return card;
	}

	private async _installDshMarketEntry(entry: IDshMarketEntry, status: HTMLElement, btn: HTMLButtonElement): Promise<void> {
		const host = this._dshHost;
		if (!host) {
			status.textContent = localize('dshMarketNoHost', "插件中心未启用（Host 组件未加载），不能安装。");
			return;
		}
		const spec = dshMarketInstallSpec(entry);
		btn.disabled = true;
		status.textContent = localize('dshMarketInspecting', "预检 {0} …", spec);
		try {
			const ins = await host.inspectBundle(spec);
			if (ins.status !== 'accepted') {
				const why = (ins as { message?: string }).message ?? ins.status;
				status.textContent = localize('dshMarketRefused', "预检未通过：{0}", why);
				btn.disabled = false;
				return;
			}
			status.textContent = localize('dshMarketInstalling', "安装中…（首次装依赖可能要几分钟）");
			const r = await host.installBundle(spec, `vssaros-market-${Date.now().toString(36)}`);
			status.textContent = r.changed
				? localize('dshMarketInstalled', "已安装（{0}）{1}", r.application, r.warnings?.length ? localize('dshMarketWarnings', " · {0} 条警告", r.warnings.length) : '')
				: localize('dshMarketNoop', "profile 组合没有变化。");
		} catch (e) {
			status.textContent = localize('dshMarketFailed', "失败：{0}", e instanceof Error ? e.message : String(e));
			btn.disabled = false;
		}
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

	// ══════════════════════════════════════════════════════════════════════════
	//  DSH TAB（方案 4.5：运行时状态 + 已装插件 + 启停开关）
	// ══════════════════════════════════════════════════════════════════════════

	/**
	 * 拉取并渲染「DSH」页签：顶部一行运行时状态（含「重启 Host」），下面是插件行与启停开关。
	 *
	 * 口径（与 4.3 一致）：**启停 = 改 profile 组合**（`dsh.profile.bundles` 的成员；停用只移出
	 * 组合，依赖与数据保留），需重启 Host（或 dsh-hmr 热重载）后 dsh 侧真正生效；置灰的项是
	 * Host 运行必需（基础组合 / VsSaros 控制桥）。
	 */
	private async _renderDshTab(): Promise<void> {
		const host = this._dshHost;
		if (!host || !this._dshListEl || !this._dshStatusEl || this._dshLoading) {
			return;
		}
		this._dshLoading = true;
		try {
			// 三条链并发：VsSaros 侧清单（含启停开关）+ Host 侧组合包视图（批次 2）+ 随包模块清单。
			// 随包那条**不依赖 Host**（读随包目录 + profile 清单），所以 Host 没起来时也能列出来装。
			const [snapshot, bundles, bundled] = await Promise.all([
				host.load(),
				host.loadBundles(),
				host.listBundledPlugins().catch(() => undefined),
			]);
			this._dshRows = snapshot.rows;
			this._dshHmr = snapshot.hmr;
			this._dshBundles = bundles;
			this._dshBundled = bundled;
			this._renderDshStatus(host);
			this._renderDshRows();
			// 组合包数 / Host 状态点（S1）：读完才有数，所以在这一步之后刷一次页签。
			this._updateTabBadges();
		} finally {
			this._dshLoading = false;
		}
	}

	/** HMR 状态文案（决定改完组合是"热重载"还是"需重启"）。 */
	private _hmrHint(): string {
		switch (this._dshHmr) {
			case 'active':
				return localize('dshHmrOn', "热重载已启用（dsh-hmr）：改动约 2 秒生效");
			case 'disabled':
				return localize('dshHmrOff', "热重载已停用：改动需重启 Host 生效");
			default:
				return localize('dshHmrUnknown', "热重载状态未知：若改动未生效请重启 Host");
		}
	}

	private _renderDshStatus(host: IDshPluginCenterHost): void {
		if (!this._dshStatusEl) {
			return;
		}
		clearNode(this._dshStatusEl);
		// 样式在 `pluginsView.css` 的 `.plugins-dsh-status`（原来写在这行的内联 cssText 里）
		const text = append(this._dshStatusEl, $('span.plugins-dsh-status-text'));
		// 运行态摘要来自 Host 的 `pluginInventory.list`（方案 5.16 批次 2：`运行中 N / 共 M 项 · 预设 P`）。
		const inv = this._dshBundles?.inventory;
		const invText = inv ? localize('dshInventory', " · 运行中 {0}/{1} 项 · 预设 {2}", inv.enabledEntries, inv.entries, inv.agentPresets) : '';
		text.textContent = `${host.statusText()} · ${this._hmrHint()}${invText}`;
		const restart = append(this._dshStatusEl, $('button.plugins-ext-btn')) as HTMLButtonElement;
		restart.textContent = localize('dshRestartHost', "重启 Host");
		restart.title = localize('dshRestartHostHint', "启停改的是 profile 组合（dsh.profile.bundles）：热重载已启用时约 2 秒自动生效，否则需重启 Host（替换已装包版本也需重启）。");
		restart.onclick = () => {
			restart.disabled = true;
			text.textContent = localize('dshRestarting', "正在重启 Host…");
			void host.restartHost().then(
				msg => {
					text.textContent = msg;
					return this._renderDshTab();
				},
				e => {
					text.textContent = `${localize('dshRestartFailed', "重启失败")}：${e instanceof Error ? e.message : String(e)}`;
				}).finally(() => { restart.disabled = false; });
		};
	}

	/** 安装源一句话（添加插件段与卡片的副标题用）。 */
	private _dshRegistriesText(): string {
		const r = this._dshBundles?.registries;
		if (!r) {
			return localize('dshRegistryUnknown', "未知（Host 未运行）");
		}
		const primary = r.registry ?? r.resolved ?? localize('dshRegistryPnpm', "pnpm 自身配置的源");
		const fb = r.fallbackRegistries.length ? localize('dshRegistryFallback', "，备用 {0} 个", r.fallbackRegistries.length) : '';
		return `${primary}${fb}`;
	}

	/**
	 * 「随包模块」段：**随产品分发**的模块插件清单 + 一键安装（方案 5.16 的补充）。
	 *
	 * 为什么要有这一段：`dsh-plugins/` 里的模块插件（skills / mcp / kb / memory / codebase / kanban /
	 * workflow / agents / dashboard / ide）此前只能靠用户**手敲 spec**（`file:G:\…\dsh-plugins\…`）才装得上，
	 * 而那条路还会踩 pnpm 的**跨盘符**限制。这里把"装了没有、能不能升"直接列出来；安装走主进程
	 * （先暂存到 profile 再 `dsh plugin add`），与启动时装伴生插件**同一条路**。
	 *
	 * 四种状态由 `row.state` 给（真源在主进程 `mergeBundledWithInstalled`，见 `IDshBundledPluginState`）：
	 * 未装=安装、相等=已安装、profile 更旧=升级、profile 更新=改回；「装了但停用」另标一句
	 * （否则用户点"安装"会以为没生效）。
	 *
	 * ⚠ 这里**不再自己比版本** ✗（此前徽标与按钮各比一次 ⇒ 装了更新版本时话术互相矛盾，2026-10-12 修）。
	 */
	private _renderBundledInto(target: HTMLElement, query: string, forInstalledTab = false): void {
		const host = this._dshHost;
		const box = append(target, $('div.plugins-dsh-bundled'));
		// 分组标题复用基础件（与「扩展」页签的分组标题同一外观）
		const title = append(box, $('div.plugins-section'));
		title.textContent = localize('dshBundledTitle', "随包模块插件");
		const sub = append(box, $('div.plugins-dsh-intro'));
		sub.textContent = forInstalledTab
			// 「插件」页签里没有"上面的重启 Host"按钮 ⇒ 文案别指错地方
			? localize('dshBundledIntroInstalled', "随产品分发的模块插件（{0} 个）：点「安装」即写进当前 profile——先把包复制到 profile 内，再 `dsh plugin add`，不依赖网络，也不受仓库盘符影响。热重载已启用时约 2 秒生效，否则需重启 Host（「运行时」页签里有那个按钮）。", String(this._dshBundled?.length ?? 0))
			: localize('dshBundledIntro', "随产品分发的模块插件（{0} 个）：点「安装」即写进当前 profile——先把包复制到 profile 内，再 `dsh plugin add`，不依赖网络，也不受仓库盘符影响。热重载已启用时约 2 秒生效，否则需点上面的「重启 Host」。", String(this._dshBundled?.length ?? 0));

		if (!host) {
			append(box, $('div.plugins-dsh-off')).textContent = localize('dshBundledNoHost', "插件中心未启用（或 Host 组件未加载）时不能安装。");
			return;
		}
		if (this._dshBundled === undefined) {
			append(box, $('div.plugins-dsh-empty')).textContent = localize('dshBundledLoading', "正在读取随包目录…");
			return;
		}
		if (!this._dshBundled.length) {
			append(box, $('div.plugins-dsh-empty')).textContent = localize('dshBundledEmpty', "随包目录里没有模块插件（打包时没带 `dsh-plugins/`？）。");
			return;
		}

		const rows = this._dshBundled.filter(r => !query
			|| r.name.toLowerCase().includes(query)
			|| (r.description ?? '').toLowerCase().includes(query));
		for (const row of rows) {
			// 卡片 + 行内件全部走基础件（`.plugins-card` / `.plugins-row-head` / `.plugins-name` /
			// `.plugins-version` / `.plugins-meta`），与「扩展」「商城」两个页签同一套外观
			const card = append(box, $('div.plugins-card.plugins-dsh-bundled-row'));
			const head = append(card, $('div.plugins-row-head'));
			const nameEl = append(head, $('span.plugins-name'));
			nameEl.textContent = row.name;
			const verEl = append(head, $('span.plugins-version'));
			verEl.textContent = `v${row.version}${row.module ? ` · ${row.module}` : ''}`;

			// ★ 2026-10-12：方向**一律读 `row.state`**（真源在主进程 `mergeBundledWithInstalled`）——
			//   本视图**不许**再自己比版本 ✗：此前徽标按"不等即升级"、按钮另用自己的 `_compareVersions`，
			//   在"profile 里装了更新版本"（开发机常见）时两者互相矛盾：徽标"可升级" / 按钮"改回" ✗。
			const stateEl = append(head, $('span.plugins-meta'));
			stateEl.textContent = row.state === 'missing'
				? localize('dshBundledNotInstalled', "未安装")
				: row.state === 'installed'
					? localize('dshBundledInstalled', "已安装 v{0}", row.installedVersion)
					: row.state === 'upgradable'
						? localize('dshBundledUpgradable', "已安装 v{0} · 可升级", row.installedVersion)
						// 措辞描述**事实**（高于随包版本），不写"可降级"——按钮那边才是动作（"改回"）
						: localize('dshBundledDowngradable', "已安装 v{0} · 高于随包版本", row.installedVersion);
			if (row.installedDisabled) {
				stateEl.textContent += localize('dshBundledDisabled', "（已停用）");
			}

			const btn = append(head, $('button.plugins-btn.plugins-dsh-row-btn')) as HTMLButtonElement;
			const busy = this._dshBundledBusy === row.name;
			btn.textContent = busy
				? localize('dshBundledBusy', "安装中…")
				: row.state === 'installed'
					? localize('dshBundledDone', "已安装")
					: row.state === 'missing'
						? localize('dshBundledInstall', "安装")
						: row.state === 'upgradable'
							? localize('dshBundledUpgrade', "升级到 v{0}", row.version)
							: localize('dshBundledDowngrade', "改回 v{0}", row.version);
			btn.disabled = busy || row.state === 'installed';
			btn.title = row.state === 'installed'
				? localize('dshBundledDoneHint', "profile 里已经是这个版本（随包版本变了这里会出现「升级」）。")
				: localize('dshBundledInstallHint', "装进当前 profile；模块 ActivityBar 图标随之出现（清单变化即刻重算）。");
			btn.onclick = () => void this._installBundledPlugin(row);

			if (row.description) {
				const desc = append(card, $('div.plugins-dsh-desc'));
				desc.textContent = row.description.slice(0, 200);
			}
		}

		if (this._dshBundledNote) {
			// 提示条复用基础件（`.plugins-notice`，换行/间距由 `.plugins-dsh-note` 补）
			const note = append(box, $('div.plugins-notice.plugins-dsh-note'));
			note.textContent = this._dshBundledNote;
		}
	}

	// ★ 2026-10-12 删除了私有的 `_compareVersions`：方向现在由 `row.state` 给
	//   （真源 `dshBundledPlugins.mergeBundledWithInstalled` + `comparePluginVersions`）——
	//   同一份版本比较保留两处实现，就是"徽标说可升级、按钮说改回"那类矛盾的温床 ✗。

	/** 安装一个随包插件：结果落 `_dshBundledNote`，最后重取清单（按钮变「已安装」）。 */
	private async _installBundledPlugin(row: IDshBundledPluginRow): Promise<void> {
		const host = this._dshHost;
		if (!host || this._dshBundledBusy) {
			return;
		}
		this._dshBundledBusy = row.name;
		this._dshBundledNote = localize('dshBundledInstalling', "正在安装 {0} v{1} …", row.name, row.version);
		this._renderDshRows();
		try {
			const r = await host.installBundledPlugin(row.name);
			this._dshBundledNote = r.ok
				? r.changed
					? localize('dshBundledInstalledNote', "已安装 {0} v{1}。热重载已启用时约 2 秒生效；否则点「重启 Host」。", row.name, r.version ?? row.version)
					: localize('dshBundledNoChangeNote', "{0} 已是 v{1}，profile 没有变化。", row.name, r.version ?? row.version)
				: `${localize('dshBundledFailed', "安装失败")}：${r.error ?? localize('dshBundledFailedUnknown', "原因见 Host 日志")}`;
		} catch (e) {
			this._dshBundledNote = `${localize('dshBundledFailed', "安装失败")}：${e instanceof Error ? e.message : String(e)}`;
		} finally {
			this._dshBundledBusy = undefined;
			// 重取清单：装上了 ⇒ 该行变「已安装」，「已安装」段也会多一行。
			await this._renderDshTab();
		}
	}

	/**
	 * 「添加插件」段（方案 5.16 批次 4）：spec 输入 → 预检（inspect）→ 安装（带取消）→ 结果话术。
	 *
	 * 三条口径：
	 * ① **先预检再安装**：预检会告诉我们它是什么（包名/版本/是否组合包）与为什么不行；`bundle === false`
	 *    直接挡住（装个不是组合包的包只会污染 profile 依赖）；
	 * ② 安装是**长任务**（首次装依赖可能几分钟），所以必须带 requestId 才能取消，且话术以 Host 的
	 *    `application` 为准（applied / restart-required / failed）；
	 * ③ pnpm 10 默认拦构建脚本：失败带 `pendingBuilds` 时给「允许并重试」，不静默失败。
	 */
	/**
	 * profile 清单里**官方 dsh 包**的版本约束（给推荐清单钉版本用）。
	 *
	 * 取法：`@deepseek-ai/dsh-*` 那些行的 `spec`（清单里的版本约束就是 `0.2.0-rc.2` 这种形态），取第一个能解析出
	 * 版本号的行；拿不到就返回 `undefined`（推荐清单**不写版本**，由 dsh 自己的 peer 预检兜底）。
	 *
	 * 为什么不用写死常量：profile 的 dsh 版本会随升级变（`dsh --profile … upgrade`），写死必然过期——而
	 * 版本不匹配时 dsh 会在 pnpm 之前直接拦下，用户只会看到"不兼容"，很难自己反应过来该改版本号。
	 */
	private _profileDshVersion(): string | undefined {
		for (const row of this._dshRows) {
			if (!row.name.startsWith('@deepseek-ai/dsh-')) {
				continue;
			}
			const m = /(?:^|@)(\d[^\s@]*)$/.exec(row.spec.trim());
			if (m) {
				return m[1];
			}
		}
		return undefined;
	}

	private _renderDshAddSegment(): void {
		const host = this._dshHost;
		const box = append(this._dshListEl!, $('div.plugins-dsh-add'));
		// 分组标题 / 输入行 / 输入框：样式全在 `pluginsView.css`（原为内联）
		const title = append(box, $('div.plugins-section'));
		title.textContent = localize('dshAddTitle', "添加插件");

		// 「打开插件商城（编辑区）」按钮 2026-10-15 挪到**搜索框正下方**（埋在列表底部的这里没人看得见，
		// 用户实测反馈）⇒ 见构造函数里 `_openMarketRow`；侧栏本段只留"策展推荐 + 手输 spec"。

		// 推荐（方案 A，2026-10-12；2026-10-13 扩为两类；2026-10-14 第三方档清空）：**策展清单**——
		// dsh 没有官方商城（调研见 doc §4.4），"发现"这一层只能我们自己提供；内容 = 运行时里真的声明了
		// `dsh.bundle.patch` 的官方可选包 **+**（机制保留的）第三方档。后者现在**刻意是空的** ✓：
		// 唯一那条 `@tt-a1i/archify-dsh` 已改成**默认随包**（vendored 进 `dsh-plugins/vssaros-archify/`、
		// 由启动序列自动装）⇒ 它不该再出现在这里（两条安装路径并存 = 其中一条还要用户点、还要联网 ✗）。
		// 理由与纪律见 `common/dshPluginRecommendations.ts` 的 ★ 两类条目。
		// ⚠ 点一下**只填 spec + 预检，不直接安装**：安装仍要用户看过预检结果后自己点（不让人一次误点就改 profile）。
		//   将来若再加第三方条目：note 里必须写明"第三方"与实际作用 —— 装之前就该知道这是谁的东西（标题不能只说"官方" ✗）。
		const reco = dshPluginRecommendations(this._profileDshVersion());
		if (reco.length) {
			const wrap = append(box, $('div.plugins-dsh-reco'));
			append(wrap, $('div.plugins-section')).textContent = localize('dshRecoTitle', "推荐（官方可选组合包与策展的技能包）");
			for (const item of reco) {
				const card = append(wrap, $('div.plugins-card.plugins-dsh-reco-row'));
				const head = append(card, $('div.plugins-row-head'));
				append(head, $('span.plugins-name')).textContent = item.label;
				append(head, $('span.plugins-version')).textContent = item.spec;
				const fill = append(head, $('button.plugins-btn.plugins-dsh-row-btn')) as HTMLButtonElement;
				fill.textContent = localize('dshRecoFill', "填入并检查");
				fill.title = localize('dshRecoFillHint', "把这条 spec 填进下面的输入框并立刻预检；确认是组合包后再点「安装」。");
				fill.onclick = () => {
					this._dshSpec = item.spec;
					this._renderDshRows();
					void this._dshInspectSpec(item.spec);
				};
				append(card, $('div.plugins-meta')).textContent = item.note;
			}
		}


		// 输入行：spec + 检查 + 安装/取消
		const row = append(box, $('div.plugins-dsh-add-row'));
		const input = append(row, $('input.plugins-dsh-spec')) as HTMLInputElement;
		input.type = 'text';
		input.value = this._dshSpec;
		input.placeholder = localize('dshAddPlaceholder', "包名（可带版本）、Git 地址、压缩包 URL 或本地绝对路径");

		const busy = !!this._dshInstalling;
		const inspected = this._dshInspect && this._dshInspect.spec === this._dshSpec.trim() ? this._dshInspect.result : undefined;

		const inspectBtn = append(row, $('button.plugins-btn')) as HTMLButtonElement;
		inspectBtn.textContent = localize('dshAddInspect', "检查");
		inspectBtn.title = localize('dshAddInspectHint', "安装前读一次这个 spec 指向什么（会查安装源，可能需要几秒）。");
		inspectBtn.disabled = busy || !this._dshSpec.trim();
		inspectBtn.onclick = () => void this._dshInspectSpec(input.value.trim());

		const installBtn = append(row, $('button.plugins-btn')) as HTMLButtonElement;
		// 只有预检通过、且确认是组合包（或这种 spec 形态读不出来 bundle 标志）才可装。
		const installable = !!inspected && inspected.status === 'accepted' && inspected.bundle !== false;
		installBtn.textContent = busy ? localize('dshAddInstalling', "安装中…") : localize('dshAddInstall', "安装");
		installBtn.disabled = busy || !installable;
		if (!installable && !busy) {
			installBtn.title = localize('dshAddInstallNeedsInspect', "先「检查」并确认它是组合包（不是组合包的包不该装进 profile）。");
		}
		installBtn.onclick = () => void this._dshInstallPlugin(this._dshSpec.trim());

		// 走主进程那两条（本地目录 / 按 spec）都是**一次调用、没有可取消的长任务**：不给「取消」，
		// 免得点了没反应像是坏了。
		// ★ 判据与真安装**同一个纯函数**（`common/dshPluginTransport.ts`）：这里若自己写 `kind !== 'path'`，
		//   注册表规格（`spec` 那条）就会长出一个点了没反应的取消按钮 ✗（2026-10-13）。
		if (busy && dshInstallTransport(inspected, false) === 'marketplace') {
			const cancel = append(row, $('button.plugins-btn.off')) as HTMLButtonElement;
			cancel.textContent = localize('dshAddCancel', "取消");
			cancel.onclick = () => void this._dshCancelInstall();
		}

		// 输入时**只就地更新按钮可用性**，不整段重绘（重绘会丢焦点与光标位置）。
		// 这条是实测修出来的：早先只在 oninput 里记值，按钮的 disabled 还是旧渲染的值 ⇒
		// 用户打完字「检查」仍是灰的，点不动（e2e 复现：inspect 框一直不出现）。
		input.oninput = () => {
			this._dshSpec = input.value;
			const filled = !!this._dshSpec.trim();
			inspectBtn.disabled = busy || !filled;
			// spec 改了 ⇒ 之前那次预检的结果不再对应它，安装必须先重新检查。
			if (!this._dshInspect || this._dshInspect.spec !== this._dshSpec.trim()) {
				installBtn.disabled = true;
			}
		};

		// 预检结果
		if (inspected) {
			const box2 = append(box, $('div.plugins-dsh-inspect'));
			const ok = inspected.status === 'accepted';
			// 颜色改由 CSS 的 `.plugins-dsh-inspect(.is-refused)` 给（原来是模板字符串拼内联）
			box2.classList.toggle('is-refused', !ok);
			if (ok) {
				box2.textContent = [
					inspected.name ? `${inspected.name}${inspected.version ? ` v${inspected.version}` : ''}` : undefined,
					localize('dshAddKind', "形态 {0}", inspected.kind ?? '?'),
					inspected.bundle === false ? localize('dshAddNotBundle', "不是组合包：装它不会带来任何 dsh 能力，已阻止安装") : localize('dshAddIsBundle', "是组合包"),
					inspected.host ? localize('dshAddHost', "抓取自 {0}", inspected.host) : undefined,
					inspected.description ? inspected.description.slice(0, 160) : undefined,
				].filter(Boolean).join(' · ');
			} else {
				box2.textContent = localize('dshAddRefused', "不能安装（{0}）：{1}", inspected.problem ?? 'unknown', inspected.reason ?? '');
			}
		}

		// 结果话术（安装/卸载后保留，段切换也在）
		if (this._dshInstallNote) {
			const note = append(box, $('div.plugins-notice.plugins-dsh-note'));
			note.textContent = this._dshInstallNote;
		}

		// pnpm 拦下构建脚本 ⇒ 给一次显式批准（Host 侧写进 profile 的 allowBuilds 并重装）。
		// 名字取自 Host 回填的 `pendingBuilds`（不是我们猜的），Host 侧对"已不再 pending"的名字会报
		// `stale-approval`——那时候要重新安装一次拿最新的待批列表。
		const pending = this._dshPendingApproval;
		if (pending && pending.spec === this._dshSpec.trim() && !busy) {
			const row2 = append(box, $('div.plugins-dsh-approve-row'));
			const approve = append(row2, $('button.plugins-btn')) as HTMLButtonElement;
			approve.textContent = localize('dshAddApproveBuilds', "允许构建脚本并重装（{0} 个）", pending.builds.length);
			approve.title = localize('dshAddApproveHint', "只批准这些包：{0}。批准会写进 profile 的 pnpm-workspace.yaml（allowBuilds），随后重装。", pending.builds.join('、'));
			approve.onclick = () => void this._dshInstallPlugin(pending.spec, pending.builds);
			const why = append(row2, $('span.plugins-meta'));
			why.textContent = localize('dshAddApproveWhy', "构建脚本会以你的用户权限执行——只批准你认识的包。");
		}

		const body = append(box, $('div.plugins-dsh-body'));
		body.textContent = localize('dshAddBody', "接受包名（可带版本）、Git 地址、压缩包或本地绝对路径；安装前会先在所选安装源读一次这个 spec 指向什么。安装源当前为：{0}。安装会以当前用户权限在 Host 进程内运行插件代码，并影响所有使用该 profile 的会话。", this._dshRegistriesText());
		if (!host) {
			append(box, $('div.plugins-dsh-off')).textContent = localize('dshAddNoHost', "插件中心未启用或 Host 未运行时不能安装（安装要用 Host 的 profile 写锁与 pnpm）。");
		}
	}

	/** 预检一个 spec（结果存字段；段重绘后仍显示）。 */
	private async _dshInspectSpec(spec: string): Promise<void> {
		const host = this._dshHost;
		if (!host || !spec) {
			return;
		}
		this._dshInstallNote = localize('dshAddInspecting', "正在读取 {0} …", spec);
		this._renderDshRows();
		try {
			const result = await host.inspectBundle(spec);
			this._dshInspect = { spec, result };
			this._dshInstallNote = undefined;
		} catch (e) {
			this._dshInspect = undefined;
			this._dshInstallNote = `${localize('dshAddInspectFailed', "检查失败")}：${e instanceof Error ? e.message : String(e)}`;
		}
		this._renderDshRows();
	}

	/** 安装（带 requestId：取消与 Host 侧进度都按它关联；`approvedBuilds` 用于批准 pnpm 拦下的构建脚本）。 */
	private async _dshInstallPlugin(spec: string, approvedBuilds?: readonly string[]): Promise<void> {
		const host = this._dshHost;
		if (!host || !spec || this._dshInstalling) {
			return;
		}
		const requestId = this._dshNewRequestId();
		this._dshInstalling = { requestId, spec };
		/**
		 * **选哪条通道**：真源是纯函数 `common/dshPluginTransport.ts`（与上面渲染"取消"按钮用的是**同一个**
		 * 判据 —— 两处各写一遍就会漂成"按钮在、请求不存在"✗）。
		 *
		 * 为什么不全走商城那条：它的安装在 Host 内 `pluginManager`，在**全新 profile** 上会把未被 lockfile
		 * 声明的那棵树剪掉（实测 `Packages: -43`）并判 `operation-error` ⇒ 首启用户点"安装"必失败
		 * （README 4.86，守护测试 `dshFreshProfileInstall.test.ts`）。主进程那条（随包一键安装同源）已验证
		 * 在新 profile 上可用 ⇒ `path` 与 `registry` 都走它 ✓。
		 *
		 * 为什么还留着商城那条：**构建脚本批准**（`approvedBuilds` / `pendingBuilds`）、进度与取消只有它有；
		 * 且 git / tarball 要不要 pnpm 解析也归它 ⇒ 两条路互补。`spec` 那条失败时下面会**回落**到商城那条 ✓。
		 */
		const inspect = this._dshInspect?.spec === spec.trim() ? this._dshInspect.result : undefined;
		const transport = dshInstallTransport(inspect, !!approvedBuilds);
		this._dshInstallNote = transport === 'local'
			? localize('dshAddInstallingLocal', "正在把本地目录装进 profile：{0} …", spec)
			: transport === 'spec'
				// 这条**没有**取消能力 ⇒ 文案不能写"可取消"（商城那条才可取消 ✗）
				? localize('dshAddInstallingSpec', "正在装 {0} …（主进程 dsh plugin add，没有取消；依赖多时会慢）", spec)
				: localize('dshAddInstallingNote', "正在安装 {0} …（依赖多时可能要几分钟，可取消）", spec);
		this._renderDshRows();
		try {
			if (transport === 'local') {
				const local = await host.installLocalPlugin(spec);
				this._dshInstallNote = this._dshLocalInstallText(local, spec);
				this._dshPendingApproval = undefined;
			} else if (transport === 'spec') {
				const name = inspect?.name?.trim();
				if (!name) {
					// 选路函数要求有名字才走这条；这里再挡一次是为了**不静默走错路**（真发生就是选路函数坏了）
					throw new Error('缺少预检包名：请先点「检查」再安装（装完要按包名核对版本）。');
				}
				const specInstall = await host.installPluginSpec(spec, name);
				this._dshInstallNote = this._dshLocalInstallText(specInstall, spec);
				this._dshPendingApproval = undefined;
				if (!specInstall.ok) {
					// ★ 回落商城那条：只有它能在 pnpm 拦下构建脚本时给出 `pendingBuilds`（"允许并重装"入口）
					//   与更细的失败原因 ⇒ 主进程这条装不上时别只报"装不上"就完事 ✗
					this._dshInstallNote += `\n${localize('dshSpecInstallFallback', "改用商城那条再试一次（它能批准构建脚本、也能取消）…")}`;
					this._renderDshRows();
					const r = await host.installBundle(spec, requestId, approvedBuilds);
					this._dshInstallNote = `${this._dshInstallNote}\n${this._dshInstallResultText(r, spec)}`;
					this._dshPendingApproval = r.pendingBuilds?.length ? { spec, builds: r.pendingBuilds } : undefined;
				}
			} else {
				const r = await host.installBundle(spec, requestId, approvedBuilds);
				this._dshInstallNote = this._dshInstallResultText(r, spec);
				// 待批构建脚本：非空就是"再点一次允许并重装"的入口（名字来自 Host，不猜）。
				this._dshPendingApproval = r.pendingBuilds?.length ? { spec, builds: r.pendingBuilds } : undefined;
			}
		} catch (e) {
			this._dshInstallNote = `${localize('dshAddInstallFailed', "安装失败")}：${e instanceof Error ? e.message : String(e)}`;
			this._dshPendingApproval = undefined;
		} finally {
			this._dshInstalling = undefined;
			this._dshInspect = undefined;
			// 清单变了（装上了 / 改了组合）要重取，否则"已安装"段看不到新包。
			await this._renderDshTab();
			// ★ 技能库跟着刷一次（2026-10-13）：插件可能**自带技能**（`<插件包>/skills`，如
			// `@tt-a1i/archify-dsh` 带的 archify）—— 它是否出现在 IDE 技能库里，取决于 profile 的
			// `dsh.profile.bundles`（见 `common/dshPluginSkillRoots.ts`），而那份文件刚被这次安装改写。
			// 不刷的话，用户装完插件去技能库看是**空的**，只能重启窗口才出现（"装了个寂寞" ✗）。
			// 失败也刷：代价只是一次目录扫描，而漏刷的代价是"技能看不见"这种最难查的错觉 ✗。
			void this.skillRegistry.reload().catch(err => this.logService.warn(`[PluginsView] 插件安装后刷新技能库失败：${err instanceof Error ? err.message : String(err)}`));
		}
	}

	/**
	 * 本地目录安装结果 → 一句话。
	 *
	 * 复用商城那套话术形状（`application` 是权威结论），但**是否立即生效按 HMR 口径**：本地安装是
	 * 在主进程（Host 之外）写 profile，与随包一键安装同一情形——HMR 已启用约 2 秒生效，否则要重启 Host。
	 * 失败时额外补 `error`（`dsh plugin add` 的实装版本对不上 / 目录不是包 / 运行时解析失败），
	 * 商城那套只有 `failureKind` / `exitCode`，这里不能丢原因。
	 */
	private _dshLocalInstallText(r: IDshBundledInstallResult, spec: string): string {
		const target = r.name || spec;
		const line = this._dshInstallResultText({
			changed: r.changed,
			application: r.ok ? (this._dshHmr === 'active' ? 'applied' : 'restart-required') : 'failed',
			target,
			...(r.ok ? { bundle: r.version ? `${target} v${r.version}` : target } : { errorCode: 'local-install-failed' }),
		}, spec);
		return r.ok || !r.error ? line : `${line}\n${r.error}`;
	}

	private async _dshCancelInstall(): Promise<void> {
		const host = this._dshHost;
		const running = this._dshInstalling;
		if (!host || !running) {
			return;
		}
		const status = await host.cancelInstall(running.requestId).catch(() => 'not-running' as const);
		this._dshInstallNote = status === 'cancelled'
			? localize('dshAddCancelled', "已取消安装，profile 文件已还原。")
			: status === 'too-late'
				? localize('dshAddCancelTooLate', "太晚了：安装已进入应用阶段，等它结束（结果会显示在这里）。")
				: localize('dshAddCancelNotRunning', "这次安装已经结束了。");
		this._renderDshRows();
	}

	/** 卸载一个组合包（两步确认，避免误点；真源仍是 Host 的 removeBundle）。 */
	private async _dshRemoveBundle(name: string, button: HTMLButtonElement): Promise<void> {
		const host = this._dshHost;
		if (!host) {
			return;
		}
		if (button.dataset.confirm !== '1') {
			button.dataset.confirm = '1';
			button.textContent = localize('dshRemoveConfirm', "确认卸载");
			button.title = localize('dshRemoveConfirmHint', "再点一次即卸载（依赖与组合选择一并撤掉；包文件可能仍在 node_modules）。");
			return;
		}
		button.disabled = true;
		this._dshInstallNote = localize('dshRemovingNote', "正在卸载 {0} …", name);
		this._renderDshRows();
		try {
			const r = await host.removeBundle(name);
			this._dshInstallNote = this._dshInstallResultText(r, name);
		} catch (e) {
			this._dshInstallNote = `${localize('dshRemoveFailed', "卸载失败")}：${e instanceof Error ? e.message : String(e)}`;
		} finally {
			await this._renderDshTab();
		}
	}

	/**
	 * 安装/卸载结果 → 一句话（方案 5.16 批次 4）。
	 * `application` 是权威结论；再补 pnpm 诊断（失败类别 / 退出码 / 待批准构建 / 日志路径）。
	 */
	private _dshInstallResultText(r: IDshInstallResult, target: string): string {
		const lines: string[] = [];
		switch (r.application) {
			case 'applied':
				lines.push(localize('dshInstallApplied', "已安装并生效：{0}", r.bundle ?? r.target));
				break;
			case 'restart-required':
				lines.push(localize('dshInstallRestart', "已安装，需重启 Host 生效：{0}", r.bundle ?? r.target));
				break;
			case 'overridden':
				lines.push(localize('dshInstallOverridden', "已写入，但被更高层 patch 覆盖：{0}", r.bundle ?? r.target));
				break;
			case 'cancelled':
				lines.push(localize('dshInstallCancelled', "安装已取消：{0}", target));
				break;
			case 'failed':
			default:
				lines.push(`${localize('dshInstallFailedShort', "未成功")}：${target}${r.errorCode ? ` [${r.errorCode}]` : ''}`);
				break;
		}
		if (r.changed === false && r.application !== 'failed') {
			lines.push(localize('dshInstallNoChange', "（profile 没有变化）"));
		}
		if (r.failureKind) {
			lines.push(localize('dshInstallFailureKind', "失败类别：{0}", r.failureKind));
		}
		if (r.errorCode === 'stale-approval') {
			// Host 侧对"已不在待批列表里的名字"会拒绝整批批准（不写任何 allowBuilds）。
			lines.push(localize('dshInstallStaleApproval', "待批列表已变（可能刚有别的安装跑过）：重新「检查」并按新的待批列表批准。"));
		}
		if (r.errorCode === 'ambiguous-install') {
			// 实测：包已在 profile 依赖表里时再装一次，Host 算不出"这次装了哪个"（前后无差异）而报它。
			lines.push(localize('dshInstallAmbiguous', "该包已在 profile 依赖里：先卸载它，或换成另一个版本/路径再装。"));
		}
		if (r.timedOut) {
			lines.push(localize('dshInstallTimeout', "pnpm 长时间无输出已被终止（可能是网络或源不可达）。"));
		}
		if (r.pendingBuilds?.length) {
			lines.push(localize('dshInstallPendingBuilds', "这些包要执行构建脚本，pnpm 默认拦下：{0}（在 Host 侧允许后重装即可）", r.pendingBuilds.join('、')));
		}
		if (r.warnings?.length) {
			lines.push(localize('dshInstallWarnings', "{0} 条警告：{1}", r.warnings.length, r.warnings[0]));
		}
		if (r.logPath) {
			lines.push(localize('dshInstallLog', "完整日志：{0}", r.logPath));
		}
		return lines.join('\n');
	}

	/** 安装请求 id（自己生成，形态受控：白名单 `[A-Za-z0-9_-]`）。 */
	private _dshNewRequestId(): string {
		const rand = Math.random().toString(36).slice(2, 10);
		return `vssaros-${Date.now().toString(36)}-${rand}`;
	}

	/**
	 * 一个组合包卡片（方案 5.16：官方随附 / 已安装共用）。
	 * 本批只读：`official` 段说明"开关在下一批接入"，`installed` 段展示组合选择状态与行。
	 */
	private _renderDshBundleCard(target: HTMLElement, b: IDshBundle, kind: 'official' | 'installed'): void {
		// 卡片 + 行内件全部走共用基础件（`.plugins-card` / `.plugins-row-head` / `.plugins-name` /
		// `.plugins-version` / `.plugins-badge`），与「扩展」「商城」「随包模块」三处同一套外观。
		const card = append(target, $('div.plugins-card.plugins-dsh-bundle'));
		const head = append(card, $('div.plugins-row-head'));
		const name = append(head, $('span.plugins-name'));
		name.textContent = b.name;
		if (b.version) {
			append(head, $('span.plugins-version')).textContent = `v${b.version}`;
		}
		const badge = append(head, $('span.plugins-badge'));
		if (kind === 'official') {
			badge.classList.add(b.enabled ? 'is-ok' : 'is-off');
			badge.textContent = b.enabled
				? localize('dshBadgeOfficialOn', "官方 · 已启用")
				: localize('dshBadgeOfficialOff', "官方 · 未启用");
			badge.title = localize('dshBadgeOfficialHint', "随发行提供、默认关闭、不可卸载；启用开关在下一批接入（Host 侧的 setBundleEnabled）。");
		} else {
			badge.classList.add(b.enabled ? 'is-ok' : 'is-off');
			badge.textContent = b.enabled ? localize('dshBadgeInstalledOn', "已选中") : localize('dshBadgeInstalledOff', "未选中");
			badge.title = localize('dshBadgeInstalledHint', "是否在 profile 的 dsh.profile.bundles 里（选中 ≠ 加载成功）。");
		}
		if (b.error) {
			append(head, $('span.plugins-error')).textContent = b.error;
		}
		const meta = append(card, $('div.plugins-dsh-desc'));
		meta.textContent = [
			b.description ? b.description.slice(0, 120) : undefined,
			localize('dshBundleRows', "{0} 行", b.rows.length),
			b.removable ? undefined : localize('dshBundleNotRemovable', "不可卸载"),
		].filter(Boolean).join(' · ');

		// 卸载（方案 5.16 批次 4）：只有 profile 自己持有的包可卸（`removable`）；官方随附的组合包
		// 由 dsh 安装随附，卸载没有意义。两步确认，避免误点。
		if (kind === 'installed' && b.removable && this._dshHost) {
			const remove = append(card, $('button.plugins-btn.plugins-dsh-card-btn')) as HTMLButtonElement;
			remove.textContent = localize('dshRemove', "卸载");
			remove.title = localize('dshRemoveHint', "从 profile 卸掉这个组合包：依赖与 `dsh.profile.bundles` 的选择一并撤掉。");
			remove.onclick = () => void this._dshRemoveBundle(b.name, remove);
		}

		if (b.rows.length) {
			const live = this._dshBundles?.pluginRows ?? [];
			const rowList = append(card, $('div.plugins-dsh-rows'));
			for (const r of b.rows) {
				const liveRow = r.entryId ? live.find(p => p.entryId === r.entryId) : undefined;
				const line = append(rowList, $('div.plugins-row-head'));
				const label = append(line, $('span'));
				label.textContent = `${r.moduleName}（${liveRow === undefined ? localize('dshRowNotLive', "未加载") : liveRow.enabled === false ? localize('dshRowDisabled', "已停用") : localize('dshRowLive', "运行中")}）`;
				// 行级启停（方案 5.16 批次 3）：写 `cordis.patch.yml` 的 disabled 覆盖，需 Host 运行
				// （`entryId` 是宿主侧存活条目的 id；没有它就没有可写的目标行）。
				if (r.entryId) {
					const toggle = append(line, $('button.plugins-btn')) as HTMLButtonElement;
					const on = liveRow?.enabled !== false;
					toggle.textContent = on ? localize('dshRowDisable', "停用行") : localize('dshRowEnable', "启用行");
					toggle.onclick = () => {
						toggle.disabled = true;
						const host = this._dshHost;
						if (!host) {
							return;
						}
						void host.setRowEnabled(r.entryId!, !on).then(
							res => {
								const text = this._dshStatusEl?.querySelector('.plugins-dsh-status-text');
								if (text) {
									text.textContent = res.changed
										? `${this._toggleResultText(this._dshHmr, res)}${res.warnings?.length ? ` (${res.warnings.length} 条警告)` : ''}`
										: localize('dshToggleNoop', "profile 组合没有变化。");
								}
								return this._renderDshTab();
							},
							e => {
								toggle.disabled = false;
								const text = this._dshStatusEl?.querySelector('.plugins-dsh-status-text');
								if (text) {
									text.textContent = `${localize('dshRowToggleFailed', "行级启停失败")}：${e instanceof Error ? e.message : String(e)}`;
								}
							});
					};
				}
			}
		}
	}

	/**
	 * 切换成功后"接下来会发生什么"的准确说法。
	 * 方案 5.16 批次 3：**Host 给出的 `application` 优先**（它是权威结论）；Host 未运行（`via: 'file'`）
	 * 时才退回按 HMR 状态推断。
	 */
	private _afterToggleText(hmr: DshPluginCenterHmr, result?: { readonly via?: 'host' | 'file'; readonly application?: string | null }): string {
		if (result?.via === 'host' && result.application) {
			switch (result.application) {
				case 'applied':
					return localize('dshAppliedHot', "已应用（Host 热重载完成）。");
				case 'restart-required':
					return localize('dshAppliedRestart', "已保存：需重启 Host 生效。");
				case 'overridden':
					return localize('dshAppliedOverridden', "已保存，但被更高层的 patch 覆盖：需检查 profile 覆盖项。");
				case 'failed':
					return localize('dshAppliedFailed', "Host 未能应用这次改动（见错误码）。");
				default:
					return localize('dshAppliedOther', "Host 返回：{0}。", result.application);
			}
		}
		// `via: 'file'` 现在有两种来源：Host 未运行（降级写入），以及 **Host 跑了但没能应用 ⇒ 退回写文件**
		// （4.52/4.53 的兜底）。所以不能再说"Host 未运行"——那会把兜底说成一个不存在的前提。
		const fileNote = result?.via === 'file' ? localize('dshViaFile', "（Host 没能应用，直接改了 profile）") : '';
		switch (hmr) {
			case 'active':
				return localize('dshToggleHot', "已更新 profile 组合：热重载中（约 2 秒生效）。") + fileNote;
			case 'disabled':
				return localize('dshToggleRestart', "已更新 profile 组合：Host 未启用热重载，需重启 Host 生效。") + fileNote;
			default:
				return localize('dshToggleMaybe', "已更新 profile 组合：若未生效请重启 Host。") + fileNote;
		}
	}

	/**
	 * 启停结果 → 状态行的一句话：`application` 话术 + 错误码 + **原始诊断**。
	 *
	 * 为什么集中到一个入口：组合包与行级两条路原先各写一遍——行级那处**写死** `via: 'host'`，于是
	 * "Host 失败 ⇒ 文件级兜底"（4.53 起会真的走到）会被说成"已应用（Host 热重载完成）"；两处又都
	 * 只贴错误码、**丢掉 `diagnostic`**，而 `operation-error` 这类非预期异常只有诊断说得清原因
	 * （预期拒绝才有枚举码）——界面于是退回"只剩操作失败"，正是 README 4.51 的病根。
	 */
	private _toggleResultText(hmr: DshPluginCenterHmr, result: {
		readonly via?: 'host' | 'file';
		readonly application?: string | null;
		readonly errorCode?: string;
		readonly stage?: string | null;
		readonly diagnostic?: string;
	}): string {
		const head = `${this._afterToggleText(hmr, result)}${result.errorCode ? ` [${result.errorCode}]` : ''}`;
		// 诊断是 Host 的原始报错（多行自由文本）：状态行里压成一行、只给前 200 字符，完整原文放 tooltip
		const detail = (result.diagnostic ?? '').replace(/\s+/g, ' ').trim();
		if (!detail) {
			return head;
		}
		if (this._dshStatusEl) {
			this._dshStatusEl.title = detail;
		}
		return `${head}｜${detail.length > 200 ? `${detail.slice(0, 200)}…` : detail}`;
	}

	/** 渲染三段切换条（当前段高亮；点按切段并重绘）。 */
	/**
	 * 「运行时」页签主体：**运行状态 + 现场清单 + 添加插件**。
	 *
	 * ⚠ 2026-10-12（方案 B 第 4 步"全搬"）：「官方随附」「已安装组合包」两段**已搬到「插件」页签**
	 * （它们是"插件来源"清单，与其它来源分组同类）；这里只留**运行态的现场**——profile 里**当前活着**
	 * 的模块及其启停开关（改它会触发 HMR 或需重启 Host，属**运行态**操作）+ 添加插件入口。
	 * 段切换条随之取消（只剩一段没有意义）。
	 */
	private _renderDshRows(): void {
		if (!this._dshListEl) {
			return;
		}
		const query = this._searchQuery.get().trim().toLowerCase();
		const data = this._dshBundles;
		clearNode(this._dshListEl);

		if (data?.error) {
			append(this._dshListEl, $('div.plugins-dsh-empty')).textContent = data.error;
		}

		const heading = append(this._dshListEl, $('div.plugins-dsh-heading'));
		heading.textContent = localize('dshSideListHeading', "VsSaros 侧模块（启停开关）");

		const rows = query ? this._dshRows.filter(r => r.name.toLowerCase().includes(query)) : this._dshRows;
		if (!rows.length) {
			const empty = append(this._dshListEl, $('div.plugins-dsh-empty'));
			empty.textContent = this._dshRows.length
				? localize('dshNoMatch', "没有匹配的插件。")
				: localize('dshNoPlugins', "profile 里还没有插件：启动一次 Host 会自动装入伴生插件（bridge / chat-surface）。");
		}
		for (const row of rows) {
			// 行式 item：样式全在 `pluginsView.css`（`.plugins-dsh-row/-info/-name/-meta`，原为内联）
			const el = append(this._dshListEl, $('div.plugins-dsh-row'));
			el.classList.toggle('disabled', !row.enabled);
			const info = append(el, $('div.plugins-dsh-info'));
			const name = append(info, $('div.plugins-dsh-name'));
			name.textContent = row.name;
			const meta = append(info, $('div.plugins-dsh-meta'));
			meta.textContent = [
				row.version ? `v${row.version}` : row.spec,
				row.containerId ? `容器 ${row.containerId}` : undefined,
				row.enabled ? undefined : localize('dshDisabled', "已停用"),
			].filter(Boolean).join(' · ');

			const toggle = append(el, $('button.plugins-ext-btn')) as HTMLButtonElement;
			toggle.textContent = row.enabled ? localize('dshDisable', "停用") : localize('dshEnable', "启用");
			toggle.classList.toggle('off', !row.enabled);
			if (row.undisablable) {
				// 基础组合 / 控制桥：置灰并说明原因（点下去只会报错）。
				toggle.disabled = true;
				toggle.title = localize('dshUndisablable', "Host 运行必需（基础组合 / VsSaros 控制桥），不能停用。");
			}
			toggle.onclick = () => {
				const host = this._dshHost;
				if (!host) {
					return;
				}
				toggle.disabled = true;
				void host.setEnabled(row.name, !row.enabled).then(
					result => {
						this._dshRows = result.rows;
						this._dshHmr = result.hmr;
						this._renderDshRows();
						const text = this._dshStatusEl?.querySelector('.plugins-dsh-status-text');
						if (text) {
							text.textContent = result.changed
								? this._toggleResultText(result.hmr, result)
								: localize('dshToggleNoop', "profile 组合没有变化。");
						}
					},
					e => {
						toggle.disabled = false;
						const text = this._dshStatusEl?.querySelector('.plugins-dsh-status-text');
						if (text) {
							text.textContent = `${localize('dshToggleFailed', "切换失败")}：${e instanceof Error ? e.message : String(e)}`;
						}
					});
			};
		}

		// 「添加插件」入口（原为第 4 段）：不再需要切段，直接跟在现场清单后面。
		this._renderDshAddSegment();
	}

	protected override layoutBody(height: number, _width: number): void {
		super.layoutBody(height, _width);
		const listHeight = Math.max(0, height - 80);

		if (this.listContainer) {
			this.listContainer.style.height = `${listHeight}px`;
		}

		if (this._dshContainer) {
			this._dshContainer.style.height = `${listHeight}px`;
		}

		if (this._extensionsContainer) {
			this._extensionsContainer.style.height = `${listHeight}px`;
		}

		// 4b（2026-10-11）：这里原来是**懒创建 WorkbenchList** 的一大块（含 selection→详情编辑器、
		// autorun→splice 两条接线）。插件页签现在是 **DOM 分组列表**（`_renderInstalledTab` /
		// `_renderPluginRow`，重绘接线在构造里）⇒ 这里只剩容器高度；行外观没变（`.agent-plugin-list-item`
		// 本来就自洽），承载从列表换成 DOM。
	}
}
