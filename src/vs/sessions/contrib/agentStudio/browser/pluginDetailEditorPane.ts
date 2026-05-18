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
				this._buildUI(this._container);
				this._initialized = true;
			} else if (this._container && this._initialized) {
				// Plugin changed, rebuild UI
				this._initialized = false;
				this._container.replaceChildren();
				this._buildUI(this._container);
				this._initialized = true;
			}
		} catch (err) {
			console.error('[PluginDetailEditorPane] setInput failed:', err);
			if (this._container) {
				this._container.textContent = `Error loading plugin detail: ${err}`;
			}
		}
	}

	private _buildUI(container: HTMLElement): void {
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

		// Config button (only for knot-agui plugin)
		if (plugin.label === 'knot-agui') {
			const configBtn = $$('button.plugin-detail-config-btn');
			configBtn.textContent = localize('configure', 'Configure');
			configBtn.title = 'Open Knot AG-UI Settings';
			configBtn.onclick = () => {
				this.commandService.executeCommand('knot.openSettings').catch((err: Error) => {
					console.warn('[PluginDetailEditorPane] Failed to open Knot settings:', err);
					// Fallback: try global function
					const openFn = (globalThis as any).__knotOpenSettings;
					if (typeof openFn === 'function') {
						openFn();
					}
				});
			};
			headerRight.appendChild(configBtn);
		}

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

		// ─── Skills Section ────────────────────────────────────
		if (skills.length > 0) {
			const section = $$('div.plugin-detail-section');
			const sectionTitle = $$('h2.plugin-detail-section-title');
			sectionTitle.textContent = localize('skills', 'Skills ({0})', skills.length);
			section.appendChild(sectionTitle);

			const skillList = $$('ul.plugin-detail-list');
			for (const skill of skills) {
				const li = $$('li.plugin-detail-list-item');
				const skillName = $$('span.plugin-detail-skill-name');
				skillName.textContent = skill.name || 'Unknown skill';
				li.appendChild(skillName);
				skillList.appendChild(li);
			}
			section.appendChild(skillList);
			scrollContainer.appendChild(section);
		}

		// ─── Commands Section ──────────────────────────────────
		if (commands.length > 0) {
			const section = $$('div.plugin-detail-section');
			const sectionTitle = $$('h2.plugin-detail-section-title');
			sectionTitle.textContent = localize('commands', 'Commands ({0})', commands.length);
			section.appendChild(sectionTitle);

			const cmdList = $$('ul.plugin-detail-list');
			for (const cmd of commands) {
				const li = $$('li.plugin-detail-list-item');
				const cmdName = $$('span.plugin-detail-cmd-name');
				cmdName.textContent = cmd.name || 'Unknown command';
				li.appendChild(cmdName);
				cmdList.appendChild(li);
			}
			section.appendChild(cmdList);
			scrollContainer.appendChild(section);
		}

		// ─── Agents Section ───────────────────────────────────
		if (agents.length > 0) {
			const section = $$('div.plugin-detail-section');
			const sectionTitle = $$('h2.plugin-detail-section-title');
			sectionTitle.textContent = localize('agents', 'Agents ({0})', agents.length);
			section.appendChild(sectionTitle);

			const agentList = $$('ul.plugin-detail-list');
			for (const agent of agents) {
				const li = $$('li.plugin-detail-list-item');
				const agentName = $$('span.plugin-detail-agent-name');
				agentName.textContent = agent.name || 'Unknown agent';
				li.appendChild(agentName);
				agentList.appendChild(li);
			}
			section.appendChild(agentList);
			scrollContainer.appendChild(section);
		}

		// ─── MCP Servers Section ──────────────────────────────
		if (mcpServers.length > 0) {
			const section = $$('div.plugin-detail-section');
			const sectionTitle = $$('h2.plugin-detail-section-title');
			sectionTitle.textContent = localize('mcpServers', 'MCP Servers ({0})', mcpServers.length);
			section.appendChild(sectionTitle);

			const mcpList = $$('ul.plugin-detail-list');
			for (const mcp of mcpServers) {
				const li = $$('li.plugin-detail-list-item');
				const mcpName = $$('span.plugin-detail-mcp-name');
				mcpName.textContent = mcp.name || 'Unknown MCP server';
				li.appendChild(mcpName);
				mcpList.appendChild(li);
			}
			section.appendChild(mcpList);
			scrollContainer.appendChild(section);
		}

		// ─── Knot CLI Status Section (only for knot-agui) ────
		if (plugin.label === 'knot-agui') {
			const cliSection = this._renderKnotCliSection();
			scrollContainer.appendChild(cliSection);
		}

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
				// Skip the standalone "models" and "agentId" configs — models are embedded in agents, agentId is removed
				if ((prop.key.endsWith('.models') && !prop.key.endsWith('.agents')) || prop.key.endsWith('.agentId')) {
					continue;
				}

				// Load current value from configuration service
				const currentValue = this.configurationService.getValue(prop.key);
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

			// Test Connection button (if token field exists)
			const hasToken = configProperties.some(p => p.key.includes('token'));
			if (hasToken) {
				const testBtn = $$('button.plugin-detail-config-save-btn.secondary');
				testBtn.textContent = localize('testConnection', '测试连接');
				testBtn.onclick = () => this._handleTestConnection(configProperties, testBtn);
				actionsRow.appendChild(testBtn);
			}

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
				result.push({
					key,
					type: String(s.type || 'string'),
					default: s.default,
					description: String(s.description || s.markdownDescription || ''),
					markdownDescription: s.markdownDescription ? String(s.markdownDescription) : undefined,
					scope: s.scope ? String(s.scope) : undefined,
					items: s.items as IPluginConfigProperty['items'],
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
				// Special handling for agents list: expandable entries with id, name, models
				if (prop.key.endsWith('.agents')) {
					const agentsContainer = this._renderAgentsExpandableList(prop, value);
					row.appendChild(agentsContainer);
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
	 * Render the agents configuration as an expandable list.
	 * Each entry has: id, name, models (comma-separated).
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
			models: Array.isArray(a.models) ? a.models.join(',') : ''
		}));

		const syncToConfig = () => {
			const result = agentsData.map(a => ({
				id: a.id,
				name: a.name,
				models: a.models ? a.models.split(',').map(m => m.trim()).filter(Boolean) : []
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

		// Models field (comma-separated)
		const modelsRow = $$('div.plugin-detail-agent-field-row');
		const modelsLabel = $$('label.plugin-detail-agent-field-label');
		modelsLabel.textContent = 'Models';
		modelsRow.appendChild(modelsLabel);
		const modelsInput = document.createElement('input');
		modelsInput.type = 'text';
		modelsInput.className = 'plugin-detail-config-input';
		modelsInput.value = agent.models;
		modelsInput.placeholder = '模型ID，多个用逗号分隔 (e.g. gpt-4,claude-3)';
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

		// Filter out skipped properties (e.g. standalone models, agentId)
		const propsToSave = configProperties.filter(p => {
			if (p.key.endsWith('.models') && !p.key.endsWith('.agents')) { return false; }
			if (p.key.endsWith('.agentId')) { return false; }
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

	/**
	 * Test connection using the plugin's API configuration.
	 */
	private async _handleTestConnection(configProperties: IPluginConfigProperty[], testBtn: HTMLElement): Promise<void> {
		const statusEl = this._container?.querySelector('#plugin-config-status') as HTMLElement | null;

		const tokenProp = configProperties.find(p => p.key.includes('token'));
		const baseUrlProp = configProperties.find(p => p.key.includes('baseUrl') || p.key.includes('endpoint'));
		const userProp = configProperties.find(p => p.key.includes('.user') && !p.key.includes('timeout'));

		const token = tokenProp ? String(this._configFieldValues.get(tokenProp.key) || '') : '';
		if (!token) {
			if (statusEl) {
				statusEl.textContent = '⚠️ 请先填写 API Token';
				statusEl.className = 'plugin-detail-config-status error';
			}
			return;
		}

		testBtn.textContent = '🔄 测试中...';
		if (statusEl) {
			statusEl.textContent = '🔄 正在测试连接...';
			statusEl.className = 'plugin-detail-config-status';
		}

		try {
			const baseUrl = baseUrlProp
				? String(this._configFieldValues.get(baseUrlProp.key) || baseUrlProp.default || 'https://knot.woa.com')
				: 'https://knot.woa.com';
			const apiUrl = `${baseUrl}/apigw/api/v1/agents`;
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };

			headers['x-knot-api-token'] = token;
			if (userProp) {
				const user = String(this._configFieldValues.get(userProp.key) || '');
				if (user) { headers['x-knot-api-user'] = user; }
			}

			const response = await fetch(apiUrl, { method: 'GET', headers });
			if (response.ok) {
				if (statusEl) {
					statusEl.textContent = '✅ 连接成功！';
					statusEl.className = 'plugin-detail-config-status success';
				}
			} else {
				const errorText = await response.text().catch(() => '');
				if (statusEl) {
					statusEl.textContent = `❌ 连接失败 (${response.status}): ${errorText.slice(0, 100)}`;
					statusEl.className = 'plugin-detail-config-status error';
				}
			}
		} catch (error) {
			if (statusEl) {
				statusEl.textContent = `❌ 连接失败: ${error}`;
				statusEl.className = 'plugin-detail-config-status error';
			}
		}

		testBtn.textContent = localize('testConnection', '测试连接');
		setTimeout(() => {
			if (statusEl) {
				statusEl.textContent = '';
				statusEl.className = 'plugin-detail-config-status';
			}
		}, 5000);
	}

	// ─── Knot CLI status ───────────────────────────────────────

	/**
	 * Build the "Knot CLI" status card. Shown only for the `knot-agui` plugin.
	 * Auto-runs the `knot.checkCli` command on first render and offers an
	 * install button that delegates to `knot.installCli` (which the extension
	 * routes through an integrated terminal so the user sees progress).
	 */
	private _renderKnotCliSection(): HTMLElement {
		const section = $$('div.plugin-detail-section');
		const sectionTitle = $$('h2.plugin-detail-section-title');
		sectionTitle.textContent = localize('knotCli', 'Knot CLI');
		section.appendChild(sectionTitle);

		const card = $$('div.plugin-detail-cli-card');

		// Status row: badge + summary text
		const statusRow = $$('div.plugin-detail-cli-status-row');
		const badge = $$('span.plugin-detail-cli-badge.checking');
		badge.textContent = localize('knotCli.checking', '检查中…');
		statusRow.appendChild(badge);

		const summary = $$('span.plugin-detail-cli-summary');
		summary.textContent = localize('knotCli.detectingMsg', '正在检测 knot-cli 是否已安装…');
		statusRow.appendChild(summary);
		card.appendChild(statusRow);

		// Detail line: version / path / error
		const detail = $$('div.plugin-detail-cli-detail');
		card.appendChild(detail);

		// Description
		const desc = $$('div.plugin-detail-cli-desc');
		desc.appendChild(document.createTextNode(localize(
			'knotCli.desc',
			'Knot CLI 是 Knot 平台官方命令行工具，用于在终端 / CI 环境直接调用智能体。详情见 ',
		)));
		const docLink = document.createElement('a');
		docLink.className = 'plugin-detail-config-link';
		docLink.textContent = 'knot.woa.com/settings/token';
		docLink.href = 'https://knot.woa.com/settings/token';
		docLink.title = 'https://knot.woa.com/settings/token';
		docLink.onclick = (e) => {
			e.preventDefault();
			window.open('https://knot.woa.com/settings/token', '_blank', 'noopener');
		};
		desc.appendChild(docLink);
		desc.appendChild(document.createTextNode('。'));
		card.appendChild(desc);

		// Action buttons
		const actions = $$('div.plugin-detail-cli-actions');
		const recheckBtn = $$('button.plugin-detail-config-save-btn.secondary') as HTMLButtonElement;
		recheckBtn.textContent = localize('knotCli.recheck', '重新检测');
		actions.appendChild(recheckBtn);

		const installBtn = $$('button.plugin-detail-config-save-btn') as HTMLButtonElement;
		installBtn.textContent = localize('knotCli.install', '安装 Knot CLI');
		actions.appendChild(installBtn);

		card.appendChild(actions);

		// Inline status / hint message
		const msg = $$('div.plugin-detail-cli-msg');
		card.appendChild(msg);

		section.appendChild(card);

		// Helper: render current detection result into the badge / summary / detail rows.
		const applyStatus = (status: { installed: boolean; version?: string; path?: string; error?: string } | undefined, errorText?: string): void => {
			badge.classList.remove('checking', 'installed', 'missing', 'error');
			if (errorText) {
				badge.classList.add('error');
				badge.textContent = localize('knotCli.errorBadge', '检测失败');
				summary.textContent = errorText;
				detail.textContent = '';
				installBtn.disabled = false;
				return;
			}
			if (!status) {
				badge.classList.add('checking');
				badge.textContent = localize('knotCli.checking', '检查中…');
				summary.textContent = '';
				detail.textContent = '';
				return;
			}
			if (status.installed) {
				badge.classList.add('installed');
				badge.textContent = localize('knotCli.installedBadge', '已安装');
				summary.textContent = status.version
					? localize('knotCli.installedSummary', 'knot-cli 已就绪：{0}', status.version)
					: localize('knotCli.installedSummaryNoVer', 'knot-cli 已就绪');
				detail.textContent = status.path ? `${status.path}` : '';
				installBtn.textContent = localize('knotCli.reinstall', '重新安装');
			} else {
				badge.classList.add('missing');
				badge.textContent = localize('knotCli.missingBadge', '未安装');
				summary.textContent = localize('knotCli.missingSummary', '未在 PATH 与常见目录中检测到 knot-cli。');
				detail.textContent = status.error ? localize('knotCli.lastError', '上次错误：{0}', status.error) : '';
				installBtn.textContent = localize('knotCli.install', '安装 Knot CLI');
			}
		};

		const setMsg = (text: string, kind: 'info' | 'success' | 'error' | '' = ''): void => {
			msg.textContent = text;
			msg.className = 'plugin-detail-cli-msg' + (kind ? ' ' + kind : '');
		};

		const runCheck = async (): Promise<void> => {
			recheckBtn.disabled = true;
			installBtn.disabled = true;
			applyStatus(undefined);
			try {
				const status = await this.commandService.executeCommand<{ installed: boolean; version?: string; path?: string; error?: string }>('knot.checkCli');
				applyStatus(status ?? { installed: false, error: 'no result' });
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				applyStatus(undefined, errMsg);
			} finally {
				recheckBtn.disabled = false;
				installBtn.disabled = false;
			}
		};

		recheckBtn.onclick = () => { void runCheck(); };

		installBtn.onclick = async () => {
			// Pull token from the in-memory config field map (so user need not save first)
			// or fall back to the persisted setting.
			let token = '';
			for (const [k, v] of this._configFieldValues.entries()) {
				if (k.endsWith('.token')) {
					token = String(v ?? '').trim();
					break;
				}
			}
			if (!token) {
				token = String(this.configurationService.getValue('knot.token') ?? '').trim();
			}
			if (!token) {
				setMsg(localize(
					'knotCli.tokenMissing',
					'⚠️ 请先在下方 Configuration 中填写并保存 Knot Token，然后再点击安装。',
				), 'error');
				return;
			}
			installBtn.disabled = true;
			recheckBtn.disabled = true;
			setMsg(localize('knotCli.installing', '🔄 已在终端中启动安装命令，请在打开的终端中查看进度。安装完成后请点击「重新检测」。'), 'info');
			try {
				const result = await this.commandService.executeCommand<{ ok: boolean; message: string }>('knot.installCli', token);
				if (result?.ok) {
					setMsg(localize(
						'knotCli.installLaunched',
						'✅ 安装命令已下发到终端。完成后请执行 source ~/.bashrc 或新开终端，再点击「重新检测」。',
					), 'success');
					// Schedule an automatic re-check shortly, in case install finishes quickly.
					setTimeout(() => { void runCheck(); }, 8000);
				} else {
					setMsg(localize('knotCli.installFailed', '❌ 安装失败：{0}', result?.message ?? 'unknown'), 'error');
				}
			} catch (err) {
				setMsg(localize('knotCli.installFailed', '❌ 安装失败：{0}', err instanceof Error ? err.message : String(err)), 'error');
			} finally {
				installBtn.disabled = false;
				recheckBtn.disabled = false;
			}
		};

		// Kick off auto-detection.
		void runCheck();

		return section;
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
			if (this._container) {
				this._initialized = false;
				this._container.replaceChildren();
				this._buildUI(this._container);
				this._initialized = true;
			}
		} catch (err) {
			console.error('[PluginDetailEditorPane] _toggleEnablement failed:', err);
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
