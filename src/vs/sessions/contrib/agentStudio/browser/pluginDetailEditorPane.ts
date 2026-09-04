/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/pluginDetailEditorPane.css';

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


const { $: $$ } = DOM;

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
	/** Runtime state for inline configuration fields: key → current value */
	private readonly _configFieldValues = new Map<string, unknown>();

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

		if (skills.length > 0) {
			const badge = $$('span.plugin-detail-badge');
			badge.textContent = `$(lightbulb) ${skills.length} skill${skills.length > 1 ? 's' : ''}`;
			badges.appendChild(badge);
		}
		if (commands.length > 0) {
			const badge = $$('span.plugin-detail-badge');
			badge.textContent = `$(terminal) ${commands.length} cmd${commands.length > 1 ? 's' : ''}`;
			badges.appendChild(badge);
		}
		if (agents.length > 0) {
			const badge = $$('span.plugin-detail-badge');
			badge.textContent = `$(robot) ${agents.length} agent${agents.length > 1 ? 's' : ''}`;
			badges.appendChild(badge);
		}
		if (mcpServers.length > 0) {
			const badge = $$('span.plugin-detail-badge.mcp');
			badge.textContent = '$(plug) MCP';
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
		const configProperties = this._getPluginConfigProperties(plugin);
		if (configProperties.length > 0) {
			this._configFieldValues.clear();
			const section = $$('div.plugin-detail-section');
			const sectionTitle = $$('h2.plugin-detail-section-title');
			sectionTitle.textContent = localize('configuration', 'Configuration ({0})', configProperties.length);
			section.appendChild(sectionTitle);

			const configContainer = $$('div.plugin-detail-config-container');

		for (const prop of configProperties) {
				// Skip standalone "models" configs — models are configured per agent for knot agents
			// Skip internal agentId (used for identification, not user-configurable)
			if (prop.key.endsWith('.agentId')) {
				continue;
			}

			// Skip standalone knot.models — models are configured per agent in the agents list
			if (prop.key === 'knot.models') {
				continue;
			}

				// Load current value from configuration service
				let currentValue = this.configurationService.getValue(prop.key);

				// 通用：任何 *.models 配置，若无用户值且默认值为空，尝试从插件目录下的 model.json 加载
				if (prop.key.endsWith('.models')) {
					const isEmpty =
						currentValue === undefined || currentValue === null ||
						(Array.isArray(currentValue) && currentValue.length === 0);
					const defaultIsEmpty = !prop.default || (Array.isArray(prop.default) && prop.default.length === 0);
					if (isEmpty && defaultIsEmpty) {
						const jsonModels = await this._loadModelsFromJsonFile(plugin);
						if (jsonModels && jsonModels.length > 0) {
							currentValue = jsonModels;
						}
					}
				}

				const value = currentValue !== undefined && currentValue !== null
					? currentValue
					: prop.default;
				this._configFieldValues.set(prop.key, value);

				const fieldEl = this._renderConfigField(prop, value);
				configContainer.appendChild(fieldEl);
			}

			section.appendChild(configContainer);

		// ─── Action Buttons ──────────────────────────────────
		const actionsRow = $$('div.plugin-detail-config-actions');

		// Save button
		const saveBtn = $$('button.plugin-detail-config-save-btn');
			saveBtn.textContent = localize('saveSettings', '保存设置');
			saveBtn.onclick = () => this._saveConfigFields(configProperties, saveBtn);
			actionsRow.appendChild(saveBtn);

			section.appendChild(actionsRow);

			// Status message area
			const statusEl = $$('div.plugin-detail-config-status');
			statusEl.id = 'plugin-config-status';
			section.appendChild(statusEl);

			scrollContainer.appendChild(section);
		}
	}

	// ─── Configuration Helpers ─────────────────────────────────

	/**
	 * Load models from the extension's model.json file.
	 * Returns null if the file cannot be read or parsed.
	 */
	private async _loadModelsFromJsonFile(plugin: IAgentPlugin): Promise<unknown[] | null> {
		try {
			const pluginLabel = plugin.label.toLowerCase();
			const pluginUriStr = plugin.uri.toString().toLowerCase();

			for (const ext of this.extensionService.extensions) {
				const extId = ext.identifier.value.toLowerCase();
				const extName = (ext.displayName || ext.name || '').toLowerCase();

				const isMatch =
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

		for (const ext of this.extensionService.extensions) {
			const extId = ext.identifier.value.toLowerCase();
			const extName = (ext.displayName || ext.name || '').toLowerCase();

			// Match by extension ID, name, or URI containing the extension folder
			const isMatch =
				extId.includes(pluginLabel) || pluginLabel.includes(extId) ||
				extName.includes(pluginLabel) || pluginLabel.includes(extName) ||
				pluginUriStr.includes(extId.replace(/\./g, '-'));

			if (!isMatch) { continue; }

			const contributes = (ext as any).contributes;
			if (!contributes?.configuration) { continue; }

			const config = contributes.configuration;
			const properties: Record<string, any> = config.properties || {};
			const result: IPluginConfigProperty[] = [];

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
					action: typeof xAction === 'string' && xAction ? xAction : undefined,
					actionLabel: typeof xActionLabel === 'string' && xActionLabel ? xActionLabel : undefined,
					readOnly: s['x-readonly'] === true,
				});
			}

			return result;
		}

		return [];
	}

	/**
	 * Render a single configuration field as a form row.
	 */
	private _renderConfigField(prop: IPluginConfigProperty, value: unknown): HTMLElement {
		const row = $$('div.plugin-detail-config-field');

		// Label
		const labelEl = $$('label.plugin-detail-config-label');
		labelEl.textContent = this._formatConfigKey(prop.key);
		labelEl.setAttribute('for', `config-${prop.key}`);
		row.appendChild(labelEl);

		// Description (with optional markdown link support)
		if (prop.markdownDescription || prop.description) {
			const descEl = $$('div.plugin-detail-config-desc');
			if (prop.markdownDescription) {
				// Parse markdown links: [label](url)
				const md = prop.markdownDescription;
				const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
				let lastIndex = 0;
				let match: RegExpExecArray | null;
				while ((match = linkRegex.exec(md)) !== null) {
					// Text before the link
					if (match.index > lastIndex) {
						descEl.appendChild(document.createTextNode(md.slice(lastIndex, match.index)));
					}
					// The link itself
					const linkEl = document.createElement('a');
					linkEl.className = 'plugin-detail-config-link';
					linkEl.textContent = match[1];
					linkEl.href = match[2];
					linkEl.title = match[2];
					linkEl.onclick = (e) => {
						e.preventDefault();
						window.open(match![2], '_blank', 'noopener');
					};
					descEl.appendChild(linkEl);
					lastIndex = match.index + match[0].length;
				}
				// Remaining text after the last link
				if (lastIndex < md.length) {
					descEl.appendChild(document.createTextNode(md.slice(lastIndex)));
				}
			} else {
				descEl.textContent = prop.description!;
			}
			row.appendChild(descEl);
		}

		// ─── 只读展示（x-readonly）────────────────────────────
		// 由插件自动写入的派生值（登录态 / Token / User ID 等）不适合让用户手改，
		// 这里渲染为只读文本，并且不写入 _configFieldValues（否则保存时会把值清成 undefined）。
		if (prop.readOnly) {
			const valueEl = $$('div.plugin-detail-config-readonly');
			const raw = value === undefined || value === null || value === '' ? '—' : String(value);
			valueEl.textContent = raw;
			valueEl.title = raw;
			row.appendChild(valueEl);
			return row;
		}

		// ─── 动作按钮（x-action）──────────────────────────────
		// 声明了 `x-action` 的属性渲染为按钮而非输入控件：点击直接执行命令，
		// 无需「保存设置」，也不写入配置。这样插件可自助扩展详情页交互，
		// 避免继续在此文件里堆积 `plugin.label === 'xxx'` 的特例分支。
		if (prop.action) {
			const actionBtn = $$('button.plugin-detail-config-save-btn') as HTMLButtonElement;
			actionBtn.type = 'button';
			actionBtn.textContent = prop.actionLabel || this._formatConfigKey(prop.key);
			actionBtn.onclick = async () => {
				actionBtn.disabled = true;
				const original = actionBtn.textContent;
				actionBtn.textContent = localize('running', '执行中…');
				try {
					await this.commandService.executeCommand(prop.action!);
					// 命令通常会改动配置（如登录后写入可用模型列表），
					// 重建 UI 让详情页立即反映最新值，无需手动关闭再打开。
					this._rerender();
				} catch (err) {
					console.error(`[PluginDetail] action "${prop.action}" failed:`, err);
					this._showActionMessage(
						localize('actionFailed', '❌ 执行失败：{0}', err instanceof Error ? err.message : String(err)),
						'error',
					);
				} finally {
					actionBtn.textContent = original;
					actionBtn.disabled = false;
				}
			};
			row.appendChild(actionBtn);
			return row;
		}

		// Input control based on type
		switch (prop.type) {
			case 'string': {
				const isPassword = prop.key.toLowerCase().includes('token') || prop.key.toLowerCase().includes('password') || prop.key.toLowerCase().includes('secret');
				const input = document.createElement('input');
				input.type = isPassword ? 'password' : 'text';
				input.id = `config-${prop.key}`;
				input.className = 'plugin-detail-config-input';
				input.value = String(value || '');
				input.placeholder = prop.default !== undefined ? String(prop.default) : '';
				input.oninput = () => { this._configFieldValues.set(prop.key, input.value); };
				row.appendChild(input);
				break;
			}
			case 'number': {
				const input = document.createElement('input');
				input.type = 'number';
				input.id = `config-${prop.key}`;
				input.className = 'plugin-detail-config-input plugin-detail-config-input-number';
				input.value = String(value ?? prop.default ?? 0);
				input.oninput = () => { this._configFieldValues.set(prop.key, Number(input.value) || 0); };
				row.appendChild(input);
				break;
			}
			case 'boolean': {
				const toggle = $$('label.plugin-detail-config-toggle');
				const checkbox = document.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.id = `config-${prop.key}`;
				checkbox.checked = !!value;
				checkbox.onchange = () => { this._configFieldValues.set(prop.key, checkbox.checked); };
				toggle.appendChild(checkbox);
				const slider = $$('span.plugin-detail-config-toggle-slider');
				toggle.appendChild(slider);
				row.appendChild(toggle);
				break;
			}
		case 'array': {
				// Special handling for agents list: expandable entries with id, name, per-agent models
				if (prop.key.endsWith('.agents')) {
					const agentsContainer = this._renderAgentsExpandableList(prop, value);
					row.appendChild(agentsContainer);
				} else if (/\.(image|video|model3d|audio)?models$/i.test(prop.key)) {
					// 通用：任何 *.models / *.imageModels / *.videoModels / *.model3dModels /
					// *.audioModels 的 array 配置都用可展开列表渲染（id / name /
					// maxInputTokens / maxAllowedSize…），与 codebuddy.models 保持一致；
					// 同时兼容 string[] 与 object[] 两种形态。
					const modelsContainer = this._renderModelsExpandableList(prop, value);
					row.appendChild(modelsContainer);
				} else {
					const textarea = document.createElement('textarea');
					textarea.id = `config-${prop.key}`;
					textarea.className = 'plugin-detail-config-textarea';
					const jsonValue = Array.isArray(value)
						? JSON.stringify(value, undefined, 2)
						: String(value || '[]');
					textarea.value = jsonValue;
					textarea.placeholder = '[]';
					textarea.rows = 5;
					textarea.oninput = () => { this._configFieldValues.set(prop.key, textarea.value); };
					row.appendChild(textarea);
				}
				break;
			}
			default: {
				// Fallback to text input
				const input = document.createElement('input');
				input.type = 'text';
				input.id = `config-${prop.key}`;
				input.className = 'plugin-detail-config-input';
				input.value = String(value || '');
				input.oninput = () => { this._configFieldValues.set(prop.key, input.value); };
				row.appendChild(input);
				break;
			}
		}

		return row;
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
	private _renderAgentsExpandableList(prop: IPluginConfigProperty, value: unknown): HTMLElement {
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
			this._configFieldValues.set(prop.key, result);
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
	private _renderModelsExpandableList(prop: IPluginConfigProperty, value: unknown): HTMLElement {
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
				this._configFieldValues.set(prop.key, modelsData.map(m => m.id).filter(id => !!id));
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
			this._configFieldValues.set(prop.key, result);
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
	private _saveConfigFields(configProperties: IPluginConfigProperty[], saveBtn: HTMLElement): void {
		const statusEl = this._container?.querySelector('#plugin-config-status') as HTMLElement | null;

		// Filter out internal properties (e.g. agentId used for identification)
		const propsToSave = configProperties.filter(p => {
			if (p.key.endsWith('.agentId')) { return false; }
			// 动作按钮（x-action）只是触发命令，不是配置值，不参与保存
			if (p.action) { return false; }
			// 只读展示（x-readonly）不写回：它们由插件自动维护，
			// 且 _renderConfigField 未把它们放入 _configFieldValues，强行保存会把值清成 undefined
			if (p.readOnly) { return false; }
			return true;
		});

		// Validate JSON/array fields (only for non-agents arrays)
		for (const prop of propsToSave) {
			if (prop.type === 'array' && !prop.key.endsWith('.agents')) {
				const rawValue = this._configFieldValues.get(prop.key);
				if (typeof rawValue === 'string') {
					try {
						JSON.parse(rawValue);
					} catch {
						if (statusEl) {
							statusEl.textContent = `⚠️ ${this._formatConfigKey(prop.key)} 必须是有效的 JSON 格式`;
							statusEl.className = 'plugin-detail-config-status error';
						}
						return;
					}
				}
			}
		}

		// Save each field
		for (const prop of propsToSave) {
			let value = this._configFieldValues.get(prop.key);
			// Parse JSON strings for array type (non-agents)
			if (prop.type === 'array' && !prop.key.endsWith('.agents') && typeof value === 'string') {
				try { value = JSON.parse(value); } catch { /* skip */ }
			}
			// agents field value is already an object array from _renderAgentsExpandableList
			this.configurationService.updateValue(prop.key, value, ConfigurationTarget.USER);
		}

		if (statusEl) {
			statusEl.textContent = '✅ 设置已保存';
			statusEl.className = 'plugin-detail-config-status success';
			setTimeout(() => {
				statusEl.textContent = '';
				statusEl.className = 'plugin-detail-config-status';
			}, 3000);
		}

		// Brief visual feedback on button
		const originalText = saveBtn.textContent;
		saveBtn.textContent = '✅ 已保存';
		setTimeout(() => { saveBtn.textContent = originalText; }, 2000);
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
