/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/pluginDetailEditorPane.css';
import { IConfigFieldInput, IConfigGroupInput, IConfigStatusItem, IConfigView, renderConfigView } from './pluginConfigView.js';
import {
	configFieldKind,
	groupConfigProperties,
	isConfigValueModified,
	isHiddenConfigProperty,
	matchesConfigFilter,
	orderConfigFields,
	readConfigSections,
	splitMarkdownDescription,
} from './pluginConfigLayout.js';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { PluginDetailEditorInput } from './pluginDetailEditorInput.js';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAgentPlugin, IAgentPluginService } from '../../../../workbench/contrib/chat/common/plugins/agentPluginService.js';
import { IEnablementModel, ContributionEnablementState, isContributionEnabled } from '../../../../workbench/contrib/chat/common/enablement.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';


const { $: $$ } = DOM;

/**
 * 判断某个扩展是否是「插件目录的宿主扩展」。
 *
 * 插件通过 `contributes.chatPlugins: [{ path: './plugin' }]` 声明，其目录必然**位于该扩展目录之内**，
 * 所以「URI 包含关系」是确定性的归属判定；而 `plugin.label` 只是 `basename(插件目录的父目录)`
 * （见 `agentPluginServiceImpl.ts` 的 `label: fromMarketplace?.name ?? basename(parentUri)`），
 * 一旦扩展**目录名与包名不一致**（如目录 `saros-pocket` / 包名 `saros-agents-pocket`），
 * 旧的模糊包含匹配就会全部落空，详情页的 Configuration 区随之缺失。
 */
function isPluginOwnerExtension(plugin: IAgentPlugin, extensionLocation: URI): boolean {
	return isEqualOrParent(plugin.uri, extensionLocation);
}

/**
 * Represents a configuration property extracted from a plugin's package.json
 * `contributes.configuration.properties`.
 */
interface IPluginConfigProperty {
	key: string;
	type: string;
	default?: unknown;
	description?: string;
	markdownDescription?: string;
	scope?: string;
	items?: { type?: string; properties?: Record<string, unknown> };
	/** 该属性所属的 configuration section 标题（扩展用数组形态声明分组时才有） */
	group?: string;
	/** 所属 section 的说明 / 图标（非标准字段，扩展可用来给分组加副标题与图标） */
	groupDescription?: string;
	groupIcon?: string;
	/** `x-advanced`：低频 / 易错项，收进「高级」（默认收起） */
	advanced?: boolean;
	/** `x-actionRow`：动作按钮所在行（同一行排在一起，如「连接」「公网隧道」「密码」） */
	actionRow?: string;
	/** `x-actionPrimary`：主操作按钮（主色） */
	actionPrimary?: boolean;
	/** `x-actionDanger`：危险操作（红色，执行前需确认） */
	actionDanger?: boolean;
	/** `x-panel`：该动作在详情页里由**内嵌面板**承担（按钮不再出现，避免又跳一个独立页面） */
	inlinePanel?: boolean;
	/** 枚举值（string/number 类型）：存在时渲染为下拉框 */
	enum?: unknown[];
	/**
	 * 可选：由 schema 的 `x-action` 声明的命令 id。存在时该属性渲染为**动作按钮**
	 * （点击即执行命令），而不是输入控件，且不参与保存——它不是真正的配置值。
	 * 这样插件无需在此处堆 `plugin.label === 'xxx'` 特例即可拥有自己的按钮。
	 */
	action?: string;
	/** 可选：按钮文案，由 schema 的 `x-actionLabel` 声明；缺省用格式化后的 key。 */
	actionLabel?: string;
	/**
	 * 可选：由 schema 的 `x-readonly` 声明。为 true 时该属性以只读文本展示，
	 * 不渲染输入控件，且不参与保存——适用于由插件自动写入的派生值（如登录态、Token、User ID）。
	 */
	readOnly?: boolean;
}

export class PluginDetailEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.pluginDetail';

	private _container: HTMLElement | undefined;
	private _plugin: IAgentPlugin | undefined;
	private _initialized = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentPluginService private readonly agentPluginService: IAgentPluginService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IFileService private readonly fileService: IFileService,
		// 「快速访问」页签里的内嵌访问面板：用 webview 元素挂载（工作台 CSP 只放行 vscode-webview:，
		// 直接 iframe 一个 http:// 页面会被拦）。
		@IWebviewService private readonly _webviewService: IWebviewService,
	) {
		super(PluginDetailEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('plugin-detail-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		try {
			await super.setInput(input, options, context, token);

			if (!(input instanceof PluginDetailEditorInput)) {
				return;
			}

			this._plugin = (input as PluginDetailEditorInput).plugin;

			if (this._container && !this._initialized) {
				await this._buildUI(this._container);
				this._initialized = true;
			} else if (this._container && this._initialized) {
				// Plugin changed, rebuild UI
				this._initialized = false;
				this._container.replaceChildren();
				await this._buildUI(this._container);
				this._initialized = true;
			}
		} catch (err) {
			console.error('[PluginDetailEditorPane] setInput failed:', err);
			if (this._container) {
				this._container.textContent = `Error loading plugin detail: ${err}`;
			}
		}
	}

	private async _buildUI(container: HTMLElement): Promise<void> {
		if (!this._plugin) {
			container.textContent = 'No plugin selected.';
			return;
		}

		const plugin = this._plugin;
		const mp = plugin.fromMarketplace;
		const enablementState = plugin.enablement.get();
		const isEnabled = isContributionEnabled(enablementState);

		// ─── Scrollable Container ─────────────────────────────────────
		const scrollContainer = $$('div.plugin-detail-scroll');
		container.appendChild(scrollContainer);

		// ─── Header Section ─────────────────────────────────────
		// Layout: [Icon] [Name, Author]     [Action Button]
		const header = $$('div.plugin-detail-header');

		// Left: Icon + Info
		const headerLeft = $$('div.plugin-detail-header-left');

		// Icon
		const iconContainer = $$('div.plugin-detail-icon');
		const iconEl = $$('span.plugin-detail-icon-codicon');
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.extensions));
		iconContainer.appendChild(iconEl);
		headerLeft.appendChild(iconContainer);

		// Title info
		const titleInfo = $$('div.plugin-detail-title-info');

		const nameEl = $$('h1.plugin-detail-name');
		nameEl.textContent = plugin.label;
		titleInfo.appendChild(nameEl);

		const authorEl = $$('p.plugin-detail-author');
		authorEl.textContent = mp?.marketplace || 'Local Plugin';
		titleInfo.appendChild(authorEl);

		// Badges (skills, commands, agents, mcp)
		const badges = $$('div.plugin-detail-badges');
		const skills = plugin.skills.get();
		const commands = plugin.commands.get();
		const agents = plugin.agents.get();
		const mcpServers = plugin.mcpServerDefinitions.get();

		// $(codicon) 需经 renderLabelWithIcons 解析为图标元素，textContent 直写会显示字面文本
		const setBadge = (badge: HTMLElement, text: string): void => {
			for (const el of renderLabelWithIcons(text)) {
				badge.appendChild(typeof el === 'string' ? document.createTextNode(el) : el);
			}
		};
		if (skills.length > 0) {
			const badge = $$('span.plugin-detail-badge');
			setBadge(badge, `$(lightbulb) ${skills.length} skill${skills.length > 1 ? 's' : ''}`);
			badges.appendChild(badge);
		}
		if (commands.length > 0) {
			const badge = $$('span.plugin-detail-badge');
			setBadge(badge, `$(terminal) ${commands.length} cmd${commands.length > 1 ? 's' : ''}`);
			badges.appendChild(badge);
		}
		if (agents.length > 0) {
			const badge = $$('span.plugin-detail-badge');
			setBadge(badge, `$(robot) ${agents.length} agent${agents.length > 1 ? 's' : ''}`);
			badges.appendChild(badge);
		}
		if (mcpServers.length > 0) {
			const badge = $$('span.plugin-detail-badge.mcp');
			setBadge(badge, '$(plug) MCP');
			badges.appendChild(badge);
		}
		titleInfo.appendChild(badges);
		headerLeft.appendChild(titleInfo);
		header.appendChild(headerLeft);

		// Right: Action Button
		const headerRight = $$('div.plugin-detail-header-right');

		const actionBtn = $$('button.plugin-detail-action-btn');
		if (isEnabled) {
			actionBtn.textContent = localize('disable', 'Disable');
			actionBtn.classList.add('disable');
			actionBtn.onclick = () => this._toggleEnablement(plugin, false);
		} else {
			actionBtn.textContent = localize('enable', 'Enable');
			actionBtn.classList.add('enable');
			actionBtn.onclick = () => this._toggleEnablement(plugin, true);
		}
		headerRight.appendChild(actionBtn);

		// Remove button (secondary)
		const removeBtn = $$('button.plugin-detail-remove-btn');
		removeBtn.textContent = localize('remove', 'Remove');
		removeBtn.onclick = () => {
			plugin.remove();
		};
		headerRight.appendChild(removeBtn);

		header.appendChild(headerRight);
		scrollContainer.appendChild(header);

		// ─── Separator ─────────────────────────────────────────
		const separator = $$('div.plugin-detail-separator');
		scrollContainer.appendChild(separator);

		// ─── Description Section ─────────────────────────────────
		const descSection = $$('div.plugin-detail-section');
		const descTitle = $$('h2.plugin-detail-section-title');
		descTitle.textContent = localize('description', 'Description');
		descSection.appendChild(descTitle);

		const descContent = $$('div.plugin-detail-description');
		descContent.textContent = mp?.description || 'No description available.';
		descSection.appendChild(descContent);
		scrollContainer.appendChild(descSection);

		// ─── Info Grid ──────────────────────────────────────────
		// VS Code-style two-column info grid
		const infoGrid = $$('div.plugin-detail-info-grid');

		// Version
		if (mp?.version) {
			const row = $$('div.plugin-detail-info-row');
			const label = $$('span.plugin-detail-info-label');
			label.textContent = localize('version', 'Version');
			row.appendChild(label);
			const value = $$('span.plugin-detail-info-value');
			value.textContent = mp.version;
			row.appendChild(value);
			infoGrid.appendChild(row);
		}

		// Location (URI)
		{
			const row = $$('div.plugin-detail-info-row');
			const label = $$('span.plugin-detail-info-label');
			label.textContent = localize('location', 'Location');
			row.appendChild(label);
			const value = $$('span.plugin-detail-info-value');
			value.textContent = plugin.uri.toString();
			value.title = plugin.uri.toString();
			row.appendChild(value);
			infoGrid.appendChild(row);
		}

		// Publisher / Source
		{
			const row = $$('div.plugin-detail-info-row');
			const label = $$('span.plugin-detail-info-label');
			label.textContent = localize('source', 'Source');
			row.appendChild(label);
			const value = $$('span.plugin-detail-info-value');
			value.textContent = mp?.marketplace || 'Local';
			row.appendChild(value);
			infoGrid.appendChild(row);
		}

		scrollContainer.appendChild(infoGrid);

		// ─── Contributions (compact grid) ──────────────────────
		const hasSkills = skills.length > 0;
		const hasCommands = commands.length > 0;
		const hasAgents = agents.length > 0;
		const hasMcp = mcpServers.length > 0;
		if (hasSkills || hasCommands || hasAgents || hasMcp) {
			const section = $$('div.plugin-detail-section');
			const sectionTitle = $$('h2.plugin-detail-section-title');
			sectionTitle.textContent = localize('contributions', 'Contributions');
			section.appendChild(sectionTitle);

			const grid = $$('div.plugin-detail-info-grid');
			if (hasSkills) {
				const row = $$('div.plugin-detail-info-row');
				const label = $$('span.plugin-detail-info-label');
				label.textContent = localize('skills', 'Skills');
				row.appendChild(label);
				const value = $$('span.plugin-detail-info-value');
				value.textContent = skills.map(s => s.name || 'Unknown skill').join(', ');
				row.appendChild(value);
				grid.appendChild(row);
			}
			if (hasCommands) {
				const row = $$('div.plugin-detail-info-row');
				const label = $$('span.plugin-detail-info-label');
				label.textContent = localize('commands', 'Commands');
				row.appendChild(label);
				const value = $$('span.plugin-detail-info-value');
				value.textContent = commands.map(c => c.name || 'Unknown command').join(', ');
				row.appendChild(value);
				grid.appendChild(row);
			}
			if (hasAgents) {
				const row = $$('div.plugin-detail-info-row');
				const label = $$('span.plugin-detail-info-label');
				label.textContent = localize('agents', 'Agents');
				row.appendChild(label);
				const value = $$('span.plugin-detail-info-value');
				value.textContent = agents.map(a => a.name || 'Unknown agent').join(', ');
				row.appendChild(value);
				grid.appendChild(row);
			}
			if (hasMcp) {
				const row = $$('div.plugin-detail-info-row');
				const label = $$('span.plugin-detail-info-label');
				label.textContent = localize('mcpServers', 'MCP Servers');
				row.appendChild(label);
				const value = $$('span.plugin-detail-info-value');
				value.textContent = mcpServers.map(m => m.name || 'Unknown MCP server').join(', ');
				row.appendChild(value);
				grid.appendChild(row);
			}
			section.appendChild(grid);
			scrollContainer.appendChild(section);
		}

		// 插件特例分支已全部移除：
		//  - CodeBuddy 的登录/登出/刷新模型按钮与登录状态 → 通用 `x-action` / `x-readonly` 约定
		//  - Knot CLI 状态区块 → 随 Knot 插件一并移除
		// 现由 `contributes.configuration` + `x-action` / `x-readonly` 统一驱动，无 plugin.label 特例。

		// ─── Configuration Section (from contributes.configuration) ──
		// 布局（分组 / 折叠 / 过滤 / sticky 保存条）见 pluginConfigView.ts，
		// 判定规则（分组、紧凑化、改动检测）见 pluginConfigLayout.ts。
		const configProperties = this._getPluginConfigProperties(plugin);
		if (configProperties.length > 0) {
			scrollContainer.appendChild(await this._buildConfigurationSection(plugin, configProperties));
		}
	}

	/**
	 * 构建 Configuration 区。
	 *
	 * 把「manifest 里的 schema」翻译成「视图要的字段列表」：
	 *  - `x-action` → 动作按钮；`x-readonly` → 只读展示；其余按类型渲染控件；
	 *  - 任意 `*.models` 在无用户值且默认值为空时，回退读插件目录下的 `model.json`；
	 *  - `agents` / `models` 这类结构复杂的数组交给本类已有的展开列表控件（custom 回调）。
	 */
	private async _buildConfigurationSection(plugin: IAgentPlugin, configProperties: IPluginConfigProperty[]): Promise<HTMLElement> {
		const visible = configProperties.filter(prop => !isHiddenConfigProperty(prop));
		const groups = groupConfigProperties(visible);
		// `x-panel` 标记的动作（如「打开访问面板」）在详情页里由**内嵌面板**承担：
		// 它的按钮不再出现（否则点了还会开一个独立标签页，与"在页签内显示"矛盾）。
		const inlinePanelActions = visible.filter(prop => prop.inlinePanel === true);

		const groupInputs: IConfigGroupInput[] = [];
		for (const group of groups) {
			const fields: IConfigFieldInput[] = [];
			const isActionsGroup = group.kind === 'actions';
			for (const prop of orderConfigFields(group.props)) {
				if (isActionsGroup && prop.inlinePanel === true) { continue; }
				const value = await this._resolveConfigValue(plugin, prop);
				const { description, links } = splitMarkdownDescription(prop.markdownDescription, prop.description);
				fields.push({
					key: prop.key,
					label: prop.actionLabel ?? this._formatConfigKey(prop.key),
					description,
					links,
					type: prop.type,
					value,
					defaultValue: prop.default,
					kind: configFieldKind(prop),
					actionId: prop.action,
					actionRow: prop.actionRow,
					primary: prop.actionPrimary === true,
					danger: prop.actionDanger === true,
					secret: /token|password|secret/i.test(prop.key),
					options: prop.enum?.map(v => ({ value: String(v), label: String(v) })),
					custom: (ctx) => {
						if (prop.readOnly || prop.action) { return null; }
						if (prop.key.endsWith('.agents')) {
							return this._renderAgentsExpandableList(prop, ctx.value, ctx.setValue);
						}
						if (/\.(image|video|model3d|audio)?models$/i.test(prop.key)) {
							return this._renderModelsExpandableList(prop, ctx.value, ctx.setValue);
						}
						return null;
					},
				});
			}
			groupInputs.push({
				id: group.id,
				title: group.title,
				subtitle: group.description,
				icon: group.props.find(p => !!p.groupIcon)?.groupIcon,
				kind: group.kind === 'advanced' ? 'advanced' : group.kind === 'actions' ? 'actions' : 'normal',
				fields,
				// 「快速访问」页签里把访问面板**内嵌**显示（用户要求：不要再跳转独立页面）
				embed: isActionsGroup && inlinePanelActions.length > 0
					? this._createInlinePanelEmbed(plugin, inlinePanelActions[0])
					: undefined,
			});
		}

		const view = renderConfigView(
			{
				title: localize('configuration', 'Configuration ({0})', visible.length),
				groups: groupInputs,
				labels: {
					filterPlaceholder: localize('filterSettings', '过滤设置…'),
					noMatch: localize('noMatchingSettings', '没有匹配的设置项'),
					modified: localize('modifiedSetting', '已修改（与默认值不同）'),
					resetField: localize('resetSetting', '恢复默认值'),
					modifiedSummary: (count: number) => localize('modifiedSummary', '{0} 项已修改', count),
					save: localize('saveSettings', '保存设置'),
					saved: localize('settingsSaved', '已保存'),
					resetAll: localize('resetAllSettings', '全部重置为默认'),
					undo: localize('undoSettings', '撤销更改'),
					fallbackTitles: {
						switch: localize('switchesGroup', '开关'),
						value: localize('valuesGroup', '其他设置'),
						readonly: localize('statusGroup', '状态'),
						// 动作按钮统一进「快速访问」页签（与「手机连接」「App 能力与安全」同级）
						action: localize('quickAccessGroup', '快速访问'),
						advanced: localize('advancedGroup', '高级'),
					},
					quickActionsTitle: localize('quickActions', '⚡ 快捷操作'),
					switchesTitle: localize('switchesCard', '开关'),
					valuesTitle: localize('valuesCard', '需要填写'),
					statusTitle: localize('statusCard', '状态'),
					advancedHint: localize('advancedHint', '低频 / 易错项：端口、令牌、路径等。改错会导致连不上，请对照文档修改。'),
					copy: localize('copy', '复制'),
					copied: localize('copied', '已复制'),
					searchHint: (count: number) => localize('searchHint', '搜索结果：{0} 项', count),
				},
				onSave: () => this._saveConfigValues(visible, view.getValues(), view),
				onResetAll: () => view.setStatus(localize('resetToDefaults', '已重置为默认值（点「保存设置」生效）')),
				onAction: (actionId, button) => this._runConfigAction(actionId, button),
			},
			{ isModified: isConfigValueModified, matches: (field, query) => matchesConfigFilter(field, field.label, query) },
		);

		// 状态条：数据来自扩展注册的命令（老版本 / 其他插件没有这条命令 → 状态条自动隐藏，不显示假状态）
		void this._probeStatusItems(plugin).then(items => {
			try { view.setStatusItems(items); } catch { /* 视图已销毁 */ }
		});

		return view.element;
	}

	/**
	 * 构建「快速访问」页签里的**内嵌访问面板**。
	 *
	 * 为什么这么做：原来点「打开访问面板」会另开一个 webview 标签页（跳走），
	 * 用户反馈「不要再跳转打开独立页面」。这里用 `IWebviewService` 在页签内容区里
	 * 挂一个 webview 元素 —— 面板 HTML 与消息处理都复用扩展那一份：
	 *   · HTML  ← 命令 `<prefix>.panelHtml`（扩展注入 CSP 与 logo data URI）
	 *   · 消息  → 命令 `<prefix>.panel`（与独立面板共用同一个 handlePanelCommand）
	 * 拿不到命令（旧版扩展 / 别的插件）时不硬撑：给一行说明 + 「在新标签打开」的退路。
	 */
	private _createInlinePanelEmbed(plugin: IAgentPlugin, panelAction: IPluginConfigProperty): IConfigGroupInput['embed'] {
		const prefix = this._pluginConfigPrefix(plugin);
		const host = DOM.$('div.plugin-detail-config-panelhost');
		const note = DOM.$('div.plugin-detail-config-panelnote');
		note.textContent = localize('inlinePanelLoading', '正在加载访问面板…');
		host.appendChild(note);

		void (async () => {
			try {
				const html = await this.commandService.executeCommand(`${prefix}.panelHtml`) as string | undefined;
				if (!html) { throw new Error('empty panel html'); }
				const webview = this._webviewService.createWebviewElement({
					title: localize('pocketPanel', 'Saros Pocket · 访问面板'),
					options: { retainContextWhenHidden: true },
					contentOptions: { allowScripts: true, allowForms: true },
					extension: undefined,
				});
				this._register(webview);
				// 面板消息 → 命令中转（扩展侧是同一套处理逻辑）→ 结果回投给 webview
				// ★★★ 2026-09-21：**订阅必须登记** ✗ —— `onMessage()` 返回的是一个
				// `IDisposable`（事件订阅 ✓），原来直接丢掉 ⇒ 触发
				// `[LEAKED DISPOSABLE] ... CREATED via ElectronWebviewElement._event [as onMessage]`
				// ✗✓（`GCBasedDisposableTracker` 在 GC 时报告未释放 ✓）。
				// 交给 `_register` ⇒ 面板 dispose 时自动释放 ✓，与上面 `_register(webview)` 同源 ✓。
				// ⚠ 时序安全 ✓：本块是 `await executeCommand(...)` **之后**才执行的 ✓，
				// 若面板已在这期间被销毁 ⇒ `_register` 会**立即释放**该订阅 ✓
				//（DisposableStore 对已 dispose 的 store 新增项一律即刻 dispose ✓），不会二次泄漏 ✓。
				this._register(webview.onMessage(async (e: { message: unknown }) => {
					try {
						const r = await this.commandService.executeCommand(`${prefix}.panel`, e.message) as
							{ status?: unknown; error?: string } | undefined;
						if (r?.status) { webview.postMessage({ command: 'status', status: r.status }); }
						if (r?.error) { webview.postMessage({ command: 'error', text: r.error }); }
					} catch (err) {
						webview.postMessage({ command: 'error', text: err instanceof Error ? err.message : String(err) });
					}
				}));
				webview.mountTo(host, mainWindow);
				webview.setHtml(html);
				note.remove(); // 面板接管显示
			} catch (err) {
				console.warn('[PluginDetail] inline panel unavailable:', err);
				note.textContent = localize('inlinePanelUnavailable',
					'内嵌面板不可用（需要 {0} 提供 panelHtml 命令）；可点右上角「在新标签打开」。', prefix || 'pocket');
				note.classList.add('warn');
			}
		})();

		return {
			element: host,
			title: panelAction.actionLabel ?? localize('panelInlineTitle', '访问面板（已内嵌）'),
			hint: localize('panelInlineHint', '面板直接显示在这里，不再另外打开页面。'),
			actions: [
				{ label: localize('panelOpenInTab', '在新标签打开'), onClick: () => void this.commandService.executeCommand(`${prefix}.openPanel`) },
				{ label: localize('panelReload', '刷新'), onClick: () => this._rerender() },
			],
		};
	}

	/** 取某插件配置区的键前缀（如 `sarosPocket`），用于命令名拼装。 */
	private _pluginConfigPrefix(plugin: IAgentPlugin): string {
		const first = this._getPluginConfigProperties(plugin)[0];
		return first ? first.key.split('.')[0] : '';
	}

	/**
	 * 探测状态条数据：优先用宿主扩展注册的 `<prefix>.status` 命令（pocket 提供），
	 * 失败就返回空数组（状态条整条不渲染）—— 只有真实数据，不猜。
	 */
	private async _probeStatusItems(plugin: IAgentPlugin): Promise<IConfigStatusItem[]> {
		const props = this._getPluginConfigProperties(plugin);
		const prefix = props.length > 0 ? props[0].key.split('.')[0] : '';
		const groupIdFor = (keyFragment: string) => {
			const hit = props.find(p => p.group && p.key.includes(keyFragment));
			return hit?.group ? `declared:${hit.group}` : undefined;
		};
		let raw: any = null;
		for (const command of [`${prefix}.status`, `${prefix}.getStatus`]) {
			try {
				raw = await this.commandService.executeCommand(command);
				if (raw && typeof raw === 'object') { break; }
			} catch { /* 命令不存在 / 旧版本 */ }
		}
		if (!raw || typeof raw !== 'object') { return []; }

		const items: IConfigStatusItem[] = [];
		if (raw.lanEnabled !== undefined) {
			items.push({
				label: localize('statusLan', '局域网'),
				value: raw.lanEnabled === false ? localize('statusOff', '已关闭') : String(raw.lanUrl ?? localize('statusOn', '已开启')),
				state: raw.lanEnabled === false ? 'off' : 'ok',
				groupId: groupIdFor('lanEnabled'),
			});
		}
		if (raw.tunnelUrl !== undefined || raw.tunnelRunning !== undefined) {
			items.push({
				label: localize('statusPublic', '公网'),
				value: raw.tunnelUrl ? String(raw.tunnelUrl) : localize('statusNotEnabled', '未开启'),
				state: raw.tunnelUrl ? 'ok' : 'off',
				groupId: groupIdFor('tunnelMode'),
			});
		}
		if (raw.desktopInputSupported !== undefined) {
			items.push({
				label: localize('statusInput', '远程键鼠'),
				value: raw.desktopInputAllowed
					? localize('statusInputAllowed', '电脑端已允许 · 手机上打开才生效')
					: localize('statusInputDenied', '电脑端未允许'),
				state: raw.desktopInputAllowed ? 'ok' : 'warn',
				groupId: groupIdFor('allowDesktopInput'),
			});
		}
		if (raw.upstreamOk !== undefined) {
			items.push({
				label: localize('statusUpstream', '上游'),
				value: raw.upstreamOk ? localize('statusUpstreamOk', '已连接') : localize('statusUpstreamOff', '未启动（桌面版正常）'),
				state: raw.upstreamOk ? 'ok' : 'off',
			});
		}
		return items;
	}

	/** 取设置当前值；`*.models` 无用户值且默认值空时回退读插件目录的 model.json。 */
	private async _resolveConfigValue(plugin: IAgentPlugin, prop: IPluginConfigProperty): Promise<unknown> {
		const currentValue = this.configurationService.getValue(prop.key);
		if (prop.key.endsWith('.models')) {
			const isEmpty = currentValue === undefined || currentValue === null
				|| (Array.isArray(currentValue) && currentValue.length === 0);
			const defaultIsEmpty = !prop.default || (Array.isArray(prop.default) && prop.default.length === 0);
			if (isEmpty && defaultIsEmpty) {
				const jsonModels = await this._loadModelsFromJsonFile(plugin);
				if (jsonModels && jsonModels.length > 0) {
					return jsonModels;
				}
			}
		}
		return currentValue !== undefined && currentValue !== null ? currentValue : prop.default;
	}

	/** 执行 x-action 按钮：命令跑完重建 UI（命令通常会改配置），期间按钮禁用并显示进度。 */
	private async _runConfigAction(actionId: string, button: HTMLButtonElement): Promise<void> {
		const original = button.textContent;
		button.disabled = true;
		button.textContent = localize('running', '执行中…');
		try {
			await this.commandService.executeCommand(actionId);
			this._rerender();
		} catch (err) {
			console.error(`[PluginDetail] action "${actionId}" failed:`, err);
			this._showActionMessage(
				localize('actionFailed', '❌ 执行失败：{0}', err instanceof Error ? err.message : String(err)),
				'error',
			);
		} finally {
			button.textContent = original;
			button.disabled = false;
		}
	}

	// ─── Configuration Helpers ─────────────────────────────────

	/**
	 * 候选扩展：**宿主扩展**（插件目录位于其扩展目录内）排在最前，其余扩展追加在后兜底。
	 *
	 * 顺序很重要——下面的循环取「第一个命中者」。宿主关系是确定性的，模糊的 ID/名称包含
	 * 匹配只是兼容旧数据的兜底（它可能让名字恰好互相包含的无关扩展抢答）。
	 */
	private _candidateExtensions(plugin: IAgentPlugin) {
		const all = this.extensionService.extensions;
		const owners = all.filter(ext => isPluginOwnerExtension(plugin, ext.extensionLocation));
		return owners.length > 0 ? [...owners, ...all] : all;
	}

	/**
	 * Load models from the extension's model.json file.
	 * Returns null if the file cannot be read or parsed.
	 */
	private async _loadModelsFromJsonFile(plugin: IAgentPlugin): Promise<unknown[] | null> {
		try {
			const pluginLabel = plugin.label.toLowerCase();
			const pluginUriStr = plugin.uri.toString().toLowerCase();

			for (const ext of this._candidateExtensions(plugin)) {
				const extId = ext.identifier.value.toLowerCase();
				const extName = (ext.displayName || ext.name || '').toLowerCase();

				// 宿主扩展（URI 包含）优先；其余按 ID / 显示名 / 目录名模糊匹配兜底
				const isMatch =
					isPluginOwnerExtension(plugin, ext.extensionLocation) ||
					extId.includes(pluginLabel) || pluginLabel.includes(extId) ||
					extName.includes(pluginLabel) || pluginLabel.includes(extName) ||
					pluginUriStr.includes(extId.replace(/\./g, '-'));

				if (!isMatch) { continue; }

				const modelJsonUri = URI.joinPath(ext.extensionLocation, 'model.json');
				const content = await this.fileService.readFile(modelJsonUri);
				const json = JSON.parse(content.value.toString());
				const models = json?.models;
				if (Array.isArray(models) && models.length > 0) {
					console.log(`[PluginDetail] Loaded ${models.length} models from ${modelJsonUri.toString()}`);
					return models;
				}
			}
		} catch (error) {
			console.error('[PluginDetail] Failed to load model.json:', error);
		}
		return null;
	}

	/**
	 * Extract configuration properties from the plugin's matching extension.
	 * Looks up `contributes.configuration.properties` in the extension manifest.
	 */
	private _getPluginConfigProperties(plugin: IAgentPlugin): IPluginConfigProperty[] {
		const pluginLabel = plugin.label.toLowerCase();
		const pluginUriStr = plugin.uri.toString().toLowerCase();

		for (const ext of this._candidateExtensions(plugin)) {
			const extId = ext.identifier.value.toLowerCase();
			const extName = (ext.displayName || ext.name || '').toLowerCase();

			// 宿主扩展（URI 包含）优先；其余按 ID / 显示名 / 目录名模糊匹配兜底
			const isMatch =
				isPluginOwnerExtension(plugin, ext.extensionLocation) ||
				extId.includes(pluginLabel) || pluginLabel.includes(extId) ||
				extName.includes(pluginLabel) || pluginLabel.includes(extName) ||
				pluginUriStr.includes(extId.replace(/\./g, '-'));

			if (!isMatch) { continue; }

			const contributes = (ext as any).contributes;
			if (!contributes?.configuration) { continue; }

			// 两种合法形态：单对象（整个插件一个 Configuration 区），或**数组**（多个带 title 的 section）
			// ——后者是 VS Code 原生的分组机制，详情页据此分组渲染。统一收敛成 section 列表。
			const sections = readConfigSections(contributes.configuration);
			const result: IPluginConfigProperty[] = [];

			for (const section of sections) {
			const properties: Record<string, any> = section.properties || {};
			for (const [key, schema] of Object.entries(properties)) {
				if (!schema || typeof schema !== 'object') { continue; }
				const s = schema as Record<string, unknown>;
				// 通用动作按钮约定：schema 上的 `x-action`（命令 id）与 `x-actionLabel`（按钮文案）。
				// 任意插件都可借此在详情页获得按钮，无需在本文件里新增 plugin.label 特例。
				const xAction = s['x-action'];
				const xActionLabel = s['x-actionLabel'];
				result.push({
					key,
					type: String(s.type || 'string'),
					default: s.default,
					description: String(s.description || s.markdownDescription || ''),
					markdownDescription: s.markdownDescription ? String(s.markdownDescription) : undefined,
					scope: s.scope ? String(s.scope) : undefined,
					items: s.items as IPluginConfigProperty['items'],
					group: typeof section.title === 'string' && section.title ? section.title : undefined,
					groupDescription: typeof (section as { description?: unknown }).description === 'string'
						? String((section as { description?: unknown }).description) : undefined,
					groupIcon: typeof (section as { 'x-icon'?: unknown })['x-icon'] === 'string'
						? String((section as { 'x-icon'?: unknown })['x-icon']) : undefined,
					advanced: s['x-advanced'] === true,
					actionRow: typeof s['x-actionRow'] === 'string' && s['x-actionRow'] ? String(s['x-actionRow']) : undefined,
					actionPrimary: s['x-actionPrimary'] === true,
					actionDanger: s['x-actionDanger'] === true,
					inlinePanel: s['x-panel'] === true,
					enum: Array.isArray(s.enum) ? s.enum : undefined,
					action: typeof xAction === 'string' && xAction ? xAction : undefined,
					actionLabel: typeof xActionLabel === 'string' && xActionLabel ? xActionLabel : undefined,
					readOnly: s['x-readonly'] === true,
				});
			}
			}

			return result;
		}

		return [];
	}



	/**
	 * 在配置区底部的状态条显示一条消息（复用「保存设置」下方的 status 元素）。
	 */
	private _showActionMessage(text: string, kind: 'success' | 'error' | '' = ''): void {
		const statusEl = this._container?.querySelector('#plugin-config-status') as HTMLElement | null;
		if (!statusEl) { return; }
		statusEl.textContent = text;
		statusEl.className = 'plugin-detail-config-status' + (kind ? ' ' + kind : '');
		if (statusEl.textContent) {
			setTimeout(() => {
				statusEl.textContent = '';
				statusEl.className = 'plugin-detail-config-status';
			}, 3000);
		}
	}

	/**
	 * Render the agents configuration as an expandable list.
	 * Each entry has: id, name, models.
	 */
	private _renderAgentsExpandableList(prop: IPluginConfigProperty, value: unknown, setValue: (value: unknown) => void): HTMLElement {
		const container = $$('div.plugin-detail-agents-list');
		const agents: Array<{ id?: string; name?: string; models?: string[] }> = Array.isArray(value) ? [...value] : [];

		// Ensure at least one default entry exists
		if (agents.length === 0) {
			agents.push({ id: '', name: '', models: [] });
		}

		// Store a mutable reference to agents data
		const agentsData = agents.map(a => ({
			id: a.id || '',
			name: a.name || '',
			models: Array.isArray(a.models) ? a.models.join(',') : '',
		}));

		const syncToConfig = () => {
			const result = agentsData.map(a => ({
				id: a.id,
				name: a.name,
				models: a.models ? a.models.split(',').map(m => m.trim()).filter(Boolean) : [],
			}));
			setValue(result);
		};

		const renderEntries = () => {
			// Clear existing entries (keep the "add" button)
			const existingEntries = container.querySelectorAll('.plugin-detail-agent-entry');
			existingEntries.forEach(el => el.remove());

			// Remove existing add button
			const existingAddBtn = container.querySelector('.plugin-detail-agents-add-btn');
			if (existingAddBtn) { existingAddBtn.remove(); }

			for (let i = 0; i < agentsData.length; i++) {
				const entry = this._renderAgentEntry(agentsData, i, syncToConfig, renderEntries);
				container.appendChild(entry);
			}

			// Add button
			const addBtn = $$('button.plugin-detail-agents-add-btn');
			addBtn.textContent = '+ 添加 Agent';
			addBtn.onclick = () => {
				agentsData.push({ id: '', name: '', models: '' });
				syncToConfig();
				renderEntries();
			};
			container.appendChild(addBtn);
		};

		renderEntries();
		syncToConfig();
		return container;
	}

	/**
	 * Render a single agent entry with id, name, models fields and expand/collapse.
	 */
	private _renderAgentEntry(
		agentsData: Array<{ id: string; name: string; models: string }>,
		index: number,
		syncToConfig: () => void,
		rerenderAll: () => void,
	): HTMLElement {
		const agent = agentsData[index];
		const entry = $$('div.plugin-detail-agent-entry');

		// Header row (always visible): shows summary + expand/collapse toggle + delete
		const header = $$('div.plugin-detail-agent-entry-header');

		const expandBtn = $$('span.plugin-detail-agent-expand-btn');
		expandBtn.textContent = '▶';
		header.appendChild(expandBtn);

		const summary = $$('span.plugin-detail-agent-entry-summary');
		summary.textContent = agent.name || agent.id || `Agent ${index + 1}`;
		header.appendChild(summary);

		const deleteBtn = $$('button.plugin-detail-agent-delete-btn');
		deleteBtn.textContent = '✕';
		deleteBtn.title = '删除此 Agent';
		deleteBtn.onclick = (e) => {
			e.stopPropagation();
			agentsData.splice(index, 1);
			syncToConfig();
			rerenderAll();
		};
		header.appendChild(deleteBtn);

		entry.appendChild(header);

		// Body (expandable fields)
		const body = $$('div.plugin-detail-agent-entry-body');
		body.style.display = 'none';

		// ID field
		const idRow = $$('div.plugin-detail-agent-field-row');
		const idLabel = $$('label.plugin-detail-agent-field-label');
		idLabel.textContent = 'ID';
		idRow.appendChild(idLabel);
		const idInput = document.createElement('input');
		idInput.type = 'text';
		idInput.className = 'plugin-detail-config-input';
		idInput.value = agent.id;
		idInput.placeholder = 'Agent ID';
		idInput.oninput = () => {
			agent.id = idInput.value;
			summary.textContent = agent.name || agent.id || `Agent ${index + 1}`;
			syncToConfig();
		};
		idRow.appendChild(idInput);
		body.appendChild(idRow);

		// Name field
		const nameRow = $$('div.plugin-detail-agent-field-row');
		const nameLabel = $$('label.plugin-detail-agent-field-label');
		nameLabel.textContent = 'Name';
		nameRow.appendChild(nameLabel);
		const nameInput = document.createElement('input');
		nameInput.type = 'text';
		nameInput.className = 'plugin-detail-config-input';
		nameInput.value = agent.name;
		nameInput.placeholder = 'Agent 显示名称';
		nameInput.oninput = () => {
			agent.name = nameInput.value;
			summary.textContent = agent.name || agent.id || `Agent ${index + 1}`;
			syncToConfig();
		};
		nameRow.appendChild(nameInput);
		body.appendChild(nameRow);

		// Models field (comma-separated model IDs)
		const modelsRow = $$('div.plugin-detail-agent-field-row');
		const modelsLabel = $$('label.plugin-detail-agent-field-label');
		modelsLabel.textContent = 'Models';
		modelsRow.appendChild(modelsLabel);
		const modelsInput = document.createElement('input');
		modelsInput.type = 'text';
		modelsInput.className = 'plugin-detail-config-input';
		modelsInput.value = agent.models;
		modelsInput.placeholder = '模型 ID，多个用逗号分隔 (e.g. deepseek-v3.1,glm-5.1)';
		modelsInput.oninput = () => {
			agent.models = modelsInput.value;
			syncToConfig();
		};
		modelsRow.appendChild(modelsInput);
		body.appendChild(modelsRow);

		entry.appendChild(body);

		// Toggle expand/collapse
		header.onclick = () => {
			const isExpanded = body.style.display !== 'none';
			body.style.display = isExpanded ? 'none' : 'block';
			expandBtn.textContent = isExpanded ? '▶' : '▼';
			entry.classList.toggle('expanded', !isExpanded);
		};

		return entry;
	}

	/**
	 * Render the models configuration as an expandable list.
	 * Each entry has full model fields: id, name, vendor, maxOutputTokens, maxInputTokens,
	 * supportsToolCall, supportsImages, maxAllowedSize, temperature, supportsReasoning,
	 * onlyReasoning, reasoning, relatedModels, disabledMultimodal, descriptionEn,
	 * descriptionZh, credits, tags, top_p, top_k, repetition_penalty, isDefault, supportsExtra.
	 */
	private _renderModelsExpandableList(prop: IPluginConfigProperty, value: unknown, setValue: (value: unknown) => void): HTMLElement {
		console.log(`[PluginDetail] _renderModelsExpandableList called for ${prop.key}, value:`, value);
		const container = $$('div.plugin-detail-models-list');

		// 模型条目既支持「对象数组」（codebuddy.models：id/name/maxInputTokens/...），
		// 也支持「字符串数组」（lightai.models：仅模型 id）。
		type ModelLike = {
			id?: string;
			name?: string;
			vendor?: string;
			maxOutputTokens?: number;
			maxInputTokens?: number;
			supportsToolCall?: boolean;
			supportsImages?: boolean;
			maxAllowedSize?: number;
			temperature?: number;
			supportsReasoning?: boolean;
			onlyReasoning?: boolean;
			reasoning?: { effort?: string; summary?: string };
			relatedModels?: { lite?: string; reasoning?: string };
			disabledMultimodal?: boolean;
			descriptionEn?: string;
			descriptionZh?: string;
			credits?: string;
			tags?: string[];
			top_p?: number;
			top_k?: number;
			repetition_penalty?: number;
			isDefault?: boolean;
			supportsExtra?: boolean;
		};

		const rawModels: unknown[] = Array.isArray(value) ? [...value] : [];
		// 原始就是字符串数组时，展示层补全为对象；保存时再还原为字符串（见 syncToConfig），
		// 避免把插件期望的 string[] 写成 object[] 导致模型读不到。
		const isStringList = rawModels.length > 0 && typeof rawModels[0] === 'string';
		const models: ModelLike[] = isStringList
			? (rawModels as string[]).map(s => ({ id: s, name: s }))
			: rawModels as ModelLike[];

		// Ensure at least one default entry exists
		if (models.length === 0) {
			models.push({ id: '', name: '', maxInputTokens: 128000, maxAllowedSize: 128000 });
		}

		// Store a mutable reference to models data
		const modelsData = models.map(m => ({
			id: m.id || '',
			name: m.name || '',
			vendor: m.vendor || '',
			maxOutputTokens: m.maxOutputTokens || 0,
			maxInputTokens: m.maxInputTokens || 128000,
			supportsToolCall: m.supportsToolCall ?? false,
			supportsImages: m.supportsImages ?? false,
			maxAllowedSize: m.maxAllowedSize || 128000,
			temperature: m.temperature ?? 1,
			supportsReasoning: m.supportsReasoning ?? false,
			onlyReasoning: m.onlyReasoning ?? false,
			reasoning: {
				effort: m.reasoning?.effort || 'medium',
				summary: m.reasoning?.summary || 'auto'
			},
			relatedModels: {
				lite: m.relatedModels?.lite || '',
				reasoning: m.relatedModels?.reasoning || ''
			},
			disabledMultimodal: m.disabledMultimodal ?? false,
			descriptionEn: m.descriptionEn || '',
			descriptionZh: m.descriptionZh || '',
			credits: m.credits || '',
			tags: Array.isArray(m.tags) ? m.tags : [],
			top_p: m.top_p ?? 1,
			top_k: m.top_k ?? 0,
			repetition_penalty: m.repetition_penalty ?? 1,
			isDefault: m.isDefault ?? false,
			supportsExtra: m.supportsExtra ?? false
		}));

		const syncToConfig = () => {
			// 原始是字符串数组 → 保存回字符串数组，保持插件读取格式不变
			if (isStringList) {
				setValue(modelsData.map(m => m.id).filter(id => !!id));
				return;
			}
			const result = modelsData.map(m => ({
				id: m.id,
				name: m.name,
				vendor: m.vendor,
				maxOutputTokens: m.maxOutputTokens,
				maxInputTokens: m.maxInputTokens,
				supportsToolCall: m.supportsToolCall,
				supportsImages: m.supportsImages,
				maxAllowedSize: m.maxAllowedSize,
				temperature: m.temperature,
				supportsReasoning: m.supportsReasoning,
				onlyReasoning: m.onlyReasoning,
				reasoning: m.reasoning,
				relatedModels: m.relatedModels,
				disabledMultimodal: m.disabledMultimodal,
				descriptionEn: m.descriptionEn,
				descriptionZh: m.descriptionZh,
				credits: m.credits,
				tags: m.tags,
				top_p: m.top_p,
				top_k: m.top_k,
				repetition_penalty: m.repetition_penalty,
				isDefault: m.isDefault,
				supportsExtra: m.supportsExtra
			}));
			setValue(result);
		};

		const renderEntries = () => {
			// Clear existing entries (keep the "add" button)
			const existingEntries = container.querySelectorAll('.plugin-detail-model-entry');
			existingEntries.forEach(el => el.remove());

			// Remove existing add button
			const existingAddBtn = container.querySelector('.plugin-detail-models-add-btn');
			if (existingAddBtn) { existingAddBtn.remove(); }

			for (let i = 0; i < modelsData.length; i++) {
				const entry = this._renderModelEntry(modelsData, i, syncToConfig, renderEntries);
				container.appendChild(entry);
			}

			// Add button
			const addBtn = $$('button.plugin-detail-models-add-btn');
			addBtn.textContent = '+ 添加模型';
			addBtn.onclick = () => {
				modelsData.push({
				id: '', name: '', vendor: '', maxOutputTokens: 0, maxInputTokens: 128000,
				supportsToolCall: false, supportsImages: false, maxAllowedSize: 128000,
				temperature: 1, supportsReasoning: false, onlyReasoning: false,
				reasoning: { effort: 'medium', summary: 'auto' },
				relatedModels: { lite: '', reasoning: '' },
				disabledMultimodal: false, descriptionEn: '', descriptionZh: '',
				credits: '', tags: [], top_p: 1, top_k: 0, repetition_penalty: 1,
				isDefault: false, supportsExtra: false
			});
				syncToConfig();
				renderEntries();
			};
			container.appendChild(addBtn);
		};

		renderEntries();
		syncToConfig();
		return container;
	}

	/**
	 * Render a single model entry with full model fields and expand/collapse.
	 */
	private _renderModelEntry(
		modelsData: Array<{
			id: string;
			name: string;
			vendor: string;
			maxOutputTokens: number;
			maxInputTokens: number;
			supportsToolCall: boolean;
			supportsImages: boolean;
			maxAllowedSize: number;
			temperature: number;
			supportsReasoning: boolean;
			onlyReasoning: boolean;
			reasoning: { effort: string; summary: string };
			relatedModels: { lite: string; reasoning: string };
			disabledMultimodal: boolean;
			descriptionEn: string;
			descriptionZh: string;
			credits: string;
			tags: string[];
			top_p: number;
			top_k: number;
			repetition_penalty: number;
			isDefault: boolean;
			supportsExtra: boolean;
		}>,
		index: number,
		syncToConfig: () => void,
		rerenderAll: () => void,
	): HTMLElement {
		const model = modelsData[index];
		const entry = $$('div.plugin-detail-model-entry');

		// Header row (always visible): shows summary + expand/collapse toggle + delete
		const header = $$('div.plugin-detail-model-entry-header');

		const expandBtn = $$('span.plugin-detail-model-expand-btn');
		expandBtn.textContent = '▶';
		header.appendChild(expandBtn);

		const summary = $$('span.plugin-detail-model-entry-summary');
		summary.textContent = model.name || model.id || `模型 ${index + 1}`;
		header.appendChild(summary);

		const deleteBtn = $$('button.plugin-detail-model-delete-btn');
		deleteBtn.textContent = '✕';
		deleteBtn.title = '删除此模型';
		deleteBtn.onclick = (e) => {
			e.stopPropagation();
			modelsData.splice(index, 1);
			syncToConfig();
			rerenderAll();
		};
		header.appendChild(deleteBtn);

		entry.appendChild(header);

		// Body (expandable fields)
		const body = $$('div.plugin-detail-model-entry-body');
		body.style.display = 'none';

		// Helper to create a text field row
		const createTextRow = (label: string, value: string, placeholder: string, onChange: (val: string) => void) => {
			const row = $$('div.plugin-detail-model-field-row');
			const lbl = $$('label.plugin-detail-model-field-label');
			lbl.textContent = label;
			row.appendChild(lbl);
			const input = document.createElement('input');
			input.type = 'text';
			input.className = 'plugin-detail-config-input';
			input.value = value;
			input.placeholder = placeholder;
			input.oninput = () => { onChange(input.value); syncToConfig(); };
			row.appendChild(input);
			body.appendChild(row);
		};

		// Helper to create a number field row
		const createNumberRow = (label: string, value: number, placeholder: string, onChange: (val: number) => void) => {
			const row = $$('div.plugin-detail-model-field-row');
			const lbl = $$('label.plugin-detail-model-field-label');
			lbl.textContent = label;
			row.appendChild(lbl);
			const input = document.createElement('input');
			input.type = 'number';
			input.className = 'plugin-detail-config-input plugin-detail-config-input-number';
			input.value = String(value);
			input.placeholder = placeholder;
			input.oninput = () => { onChange(Number(input.value) || 0); syncToConfig(); };
			row.appendChild(input);
			body.appendChild(row);
		};

		// Helper to create a boolean toggle row
		const createBoolRow = (label: string, value: boolean, onChange: (val: boolean) => void) => {
			const row = $$('div.plugin-detail-model-field-row');
			const lbl = $$('label.plugin-detail-model-field-label');
			lbl.textContent = label;
			row.appendChild(lbl);
			const toggle = $$('label.plugin-detail-config-toggle');
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = value;
			checkbox.onchange = () => { onChange(checkbox.checked); syncToConfig(); };
			toggle.appendChild(checkbox);
			const slider = $$('span.plugin-detail-config-toggle-slider');
			toggle.appendChild(slider);
			row.appendChild(toggle);
			body.appendChild(row);
		};

		// ID field
		createTextRow('模型 ID', model.id, '模型 ID（如：gpt-5.5）', (v) => {
			model.id = v;
			summary.textContent = model.name || model.id || `模型 ${index + 1}`;
		});

		// Name field
		createTextRow('显示名称', model.name, '模型显示名称（如：GPT-5.5）', (v) => {
			model.name = v;
			summary.textContent = model.name || model.id || `模型 ${index + 1}`;
		});

		// Vendor field
		createTextRow('供应商', model.vendor, '供应商标识（如：i, f, a）', (v) => { model.vendor = v; });

		// maxOutputTokens field
		createNumberRow('最大输出 Token', model.maxOutputTokens, '最大输出 Token 数', (v) => { model.maxOutputTokens = v; });

		// maxInputTokens field
		createNumberRow('最大输入 Token', model.maxInputTokens, '最大输入 Token 数', (v) => { model.maxInputTokens = v; });

		// maxAllowedSize field
		createNumberRow('最大上下文大小', model.maxAllowedSize, '最大上下文大小（input + output）', (v) => { model.maxAllowedSize = v; });

		// supportsToolCall
		createBoolRow('支持工具调用', model.supportsToolCall, (v) => { model.supportsToolCall = v; });

		// supportsImages
		createBoolRow('支持图片', model.supportsImages, (v) => { model.supportsImages = v; });

		// temperature
		createNumberRow('温度参数', model.temperature, '温度参数（如：1）', (v) => { model.temperature = v; });

		// supportsReasoning
		createBoolRow('支持推理', model.supportsReasoning, (v) => { model.supportsReasoning = v; });

		// onlyReasoning
		createBoolRow('仅推理', model.onlyReasoning, (v) => { model.onlyReasoning = v; });

		// reasoning effort
		createTextRow('推理强度', model.reasoning.effort, 'low / medium / high', (v) => { model.reasoning.effort = v; });

		// reasoning summary
		createTextRow('推理摘要', model.reasoning.summary, 'auto / detailed / concise', (v) => { model.reasoning.summary = v; });

		// relatedModels lite
		createTextRow('轻量版模型 ID', model.relatedModels.lite, '关联的轻量版模型 ID', (v) => { model.relatedModels.lite = v; });

		// relatedModels reasoning
		createTextRow('推理版模型 ID', model.relatedModels.reasoning, '关联的推理版模型 ID', (v) => { model.relatedModels.reasoning = v; });

		// disabledMultimodal
		createBoolRow('禁用多模态', model.disabledMultimodal, (v) => { model.disabledMultimodal = v; });

		// descriptionEn
		createTextRow('英文描述', model.descriptionEn, '模型英文描述', (v) => { model.descriptionEn = v; });

		// descriptionZh
		createTextRow('中文描述', model.descriptionZh, '模型中文描述', (v) => { model.descriptionZh = v; });

		// credits
		createTextRow('Credits', model.credits, '模型 credits 信息', (v) => { model.credits = v; });

		// tags
		const tagsRow = $$('div.plugin-detail-model-field-row');
		const tagsLabel = $$('label.plugin-detail-model-field-label');
		tagsLabel.textContent = '标签';
		tagsRow.appendChild(tagsLabel);
		const tagsInput = document.createElement('input');
		tagsInput.type = 'text';
		tagsInput.className = 'plugin-detail-config-input';
		tagsInput.value = model.tags.join(', ');
		tagsInput.placeholder = '标签，多个用逗号分隔';
		tagsInput.oninput = () => {
			model.tags = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
			syncToConfig();
		};
		tagsRow.appendChild(tagsInput);
		body.appendChild(tagsRow);

		// top_p
		createNumberRow('Top P', model.top_p, 'Top P 采样参数', (v) => { model.top_p = v; });

		// top_k
		createNumberRow('Top K', model.top_k, 'Top K 采样参数', (v) => { model.top_k = v; });

		// repetition_penalty
		createNumberRow('重复惩罚', model.repetition_penalty, '重复惩罚参数', (v) => { model.repetition_penalty = v; });

		// isDefault
		createBoolRow('默认模型', model.isDefault, (v) => { model.isDefault = v; });

		// supportsExtra
		createBoolRow('支持额外参数', model.supportsExtra, (v) => { model.supportsExtra = v; });

		entry.appendChild(body);

		// Toggle expand/collapse
		header.onclick = () => {
			const isExpanded = body.style.display !== 'none';
			body.style.display = isExpanded ? 'none' : 'block';
			expandBtn.textContent = isExpanded ? '▶' : '▼';
			entry.classList.toggle('expanded', !isExpanded);
		};

		return entry;
	}

	/**
	 * Format a configuration key into a human-readable label.
	 * e.g. "sessions.agentStudio.knot.token" → "Token"
	 * e.g. "knot.streaming" → "Streaming"
	 */
	private _formatConfigKey(key: string): string {
		const parts = key.split('.');
		const last = parts[parts.length - 1];
		// CamelCase → spaces, capitalize first letter
		return last.replace(/([a-z])([A-Z])/g, '$1 $2')
			.replace(/^./, s => s.toUpperCase());
	}

	/**
	 * Save all configuration field values to the configuration service.
	 */
	private _saveConfigValues(configProperties: IPluginConfigProperty[], values: Map<string, unknown>, view: IConfigView): void {
		// 动作按钮（x-action）只是触发命令；只读展示（x-readonly）由插件自动维护 —— 两者都不写回，
		// 否则会把值清成 undefined。
		const propsToSave = configProperties.filter(p => !p.action && !p.readOnly && !isHiddenConfigProperty(p));

		// array 字段先是文本域里的字符串，校验 JSON 后再解析；agents / models 已是对象数组
		const parsed = new Map<string, unknown>();
		for (const prop of propsToSave) {
			let value = values.get(prop.key);
			const isStructuredArray = prop.type === 'array' && !prop.key.endsWith('.agents')
				&& !/\.(image|video|model3d|audio)?models$/i.test(prop.key);
			if (isStructuredArray && typeof value === 'string') {
				try {
					value = JSON.parse(value);
				} catch {
					view.setStatus(localize('invalidJson', '⚠️ {0} 必须是有效的 JSON 格式', this._formatConfigKey(prop.key)), 'error');
					return;
				}
			}
			parsed.set(prop.key, value);
		}

		for (const [key, value] of parsed) {
			this.configurationService.updateValue(key, value, ConfigurationTarget.USER);
		}

		view.setStatus(localize('settingsSaved', '✅ 设置已保存'), 'success');
	}

	// ─── Enablement ─────────────────────────────────────────

	private _toggleEnablement(plugin: IAgentPlugin, enable: boolean): void {
		try {
			const key = plugin.uri.toString();
			const model: IEnablementModel = (this.agentPluginService as any).enablementModel;
			if (model) {
				model.setEnabled(
					key,
					enable ? ContributionEnablementState.EnabledProfile : ContributionEnablementState.DisabledProfile
				);
			}
			// Re-render
			this._rerender();
			} catch (err) {
			console.error('[PluginDetailEditorPane] _toggleEnablement failed:', err);
			}
			}

			/**
			* 重建详情页 UI。
			* 供「配置被命令/外部改动」后调用（如 x-action 登录后写入了模型列表），
			* 使页面立即反映最新配置值，无需用户手动关闭再打开。
			*/
			private _rerender(): void {
			if (this._container) {
			this._initialized = false;
			this._container.replaceChildren();
			this._buildUI(this._container);
			this._initialized = true;
			}
			}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override dispose(): void {
		super.dispose();
	}
}
