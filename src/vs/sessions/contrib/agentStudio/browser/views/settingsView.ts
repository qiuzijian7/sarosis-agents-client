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
import { $ } from '../../../../../base/browser/dom.js';
import {
	ISettingsTabRegistry,
	ISettingsTabDescriptor,
	ISettingsFieldDescriptor,
	ISettingsActionDescriptor,
} from './settingsTabRegistry.js';

// ─── General Settings (built-in, always present) ─────────────────────────────

interface SettingItem {
	id: string;
	label: string;
	description: string;
	type: 'boolean' | 'string' | 'number' | 'select';
	value: any;
	options?: string[];
	category: string;
}

const SETTINGS: SettingItem[] = [
	{ id: 'agent.autoApprove', label: 'Auto-approve tool calls', description: 'Automatically approve agent tool calls without confirmation', type: 'boolean', value: false, category: 'Agent' },
	{ id: 'agent.maxIterations', label: 'Max iterations', description: 'Maximum number of tool-calling iterations per conversation', type: 'number', value: 90, category: 'Agent' },
	{ id: 'agent.defaultModel', label: 'Default model', description: 'Default AI model for new agents', type: 'select', value: 'claude-sonnet-4-20250514', options: ['claude-sonnet-4-20250514', 'gpt-4o', 'gemini-2.5-pro'], category: 'Agent' },
	{ id: 'ui.theme', label: 'UI Theme', description: 'Agent Studio color theme', type: 'select', value: 'dark', options: ['dark', 'light', 'auto'], category: 'Appearance' },
	{ id: 'ui.fontSize', label: 'Font size', description: 'Base font size for the interface', type: 'number', value: 14, category: 'Appearance' },
	{ id: 'ui.showToolProgress', label: 'Show tool progress', description: 'Display tool execution progress in chat', type: 'boolean', value: true, category: 'Appearance' },
	{ id: 'workspace.autoSave', label: 'Auto-save workspace', description: 'Automatically save workspace changes', type: 'boolean', value: true, category: 'Workspace' },
	{ id: 'workspace.dataPath', label: 'Data directory', description: 'Custom path for Agent Studio data', type: 'string', value: '', category: 'Workspace' },
	{ id: 'chat.streamResponse', label: 'Stream responses', description: 'Show responses as they are generated', type: 'boolean', value: true, category: 'Chat' },
	{ id: 'chat.historyLimit', label: 'History limit', description: 'Maximum messages to keep in chat history', type: 'number', value: 100, category: 'Chat' },
	{ id: 'tools.confirmDestructive', label: 'Confirm destructive actions', description: 'Ask before file deletion or system commands', type: 'boolean', value: true, category: 'Tools' },
	{ id: 'tools.sandboxMode', label: 'Sandbox mode', description: 'Run tools in a sandboxed environment', type: 'boolean', value: false, category: 'Tools' },
];

// ─── Settings View ────────────────────────────────────────────────────────────

/**
 * Settings View - 设置面板
 *
 * 架构：
 * - "General" 页签：内置通用设置，硬编码在 SETTINGS 数组中
 * - 插件页签：由 ISettingsTabRegistry 自动发现已安装扩展的
 *   `contributes.agentStudioSettingsTab` 声明，无需修改本文件
 *
 * 新增插件设置页签只需在插件的 package.json 中添加：
 * ```json
 * "contributes": {
 *   "agentStudioSettingsTab": {
 *     "id": "my-plugin",
 *     "label": "🧩 My Plugin",
 *     "description": "My plugin settings",
 *     "fields": [
 *       { "key": "myPlugin.apiKey", "label": "API Key", "type": "password" }
 *     ],
 *     "actions": [
 *       { "id": "test", "label": "测试连接" }
 *     ]
 *   }
 * }
 * ```
 */
export class SettingsViewPane extends ViewPane {

	private contentContainer!: HTMLElement;
	private tabsContainer!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private activeTab: string = 'general';
	private statusMessage: string = '';

	/** Runtime state for plugin tab fields: tabId → fieldKey → current value */
	private pluginFieldValues = new Map<string, Map<string, any>>();

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
		@ISettingsTabRegistry private readonly settingsTabRegistry: ISettingsTabRegistry,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.settingsTabRegistry.onDidChangeTabs(() => {
			this._loadPluginConfig();
			this._renderTabs();
			// If current tab no longer exists, switch to general
			if (this.activeTab !== 'general' && !this.settingsTabRegistry.getTab(this.activeTab)) {
				this.activeTab = 'general';
			}
			this._renderActiveTab();
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('settings-view');

		// Header
		const header = $('div.settings-header');
		const title = $('h3.settings-title');
		title.textContent = '⚙️ Settings';
		header.appendChild(title);

		const resetBtn = $('button.settings-reset-btn');
		resetBtn.textContent = 'Reset All';
		resetBtn.onclick = () => this._resetAll();
		header.appendChild(resetBtn);
		container.appendChild(header);

		// Tabs
		this.tabsContainer = $('div.settings-tabs');
		this._renderTabs();
		container.appendChild(this.tabsContainer);

		// Search (only for general tab)
		this.searchInput = document.createElement('input');
		this.searchInput.className = 'settings-search';
		this.searchInput.placeholder = '🔍 Search settings...';
		this.searchInput.oninput = () => {
			if (this.activeTab === 'general') {
				this._filterSettings(this.searchInput.value);
			}
		};
		container.appendChild(this.searchInput);

		// Content
		this.contentContainer = $('div.settings-content');
		container.appendChild(this.contentContainer);

		// Load plugin config and render
		this._loadPluginConfig();
		this._renderActiveTab();
	}

	// ─── Tab Bar ──────────────────────────────────────────────────────────────

	private _renderTabs(): void {
		this.tabsContainer.replaceChildren();

		const tabs: { id: string; label: string }[] = [
			{ id: 'general', label: 'General' },
		];

		// Add tabs from registry
		for (const tab of this.settingsTabRegistry.tabs) {
			tabs.push({ id: tab.id, label: tab.label });
		}

		for (const tab of tabs) {
			const btn = $('button.settings-tab');
			btn.textContent = tab.label;
			if (tab.id === this.activeTab) {
				btn.classList.add('active');
			}
			btn.onclick = () => {
				this.activeTab = tab.id;
				this.tabsContainer.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				// Show/hide search
				this.searchInput.style.display = tab.id === 'general' ? '' : 'none';
				this._renderActiveTab();
			};
			this.tabsContainer.appendChild(btn);
		}
	}

	private _renderActiveTab(): void {
		this.contentContainer.replaceChildren();
		this.statusMessage = '';

		if (this.activeTab === 'general') {
			this._renderSettings(SETTINGS);
		} else {
			const tab = this.settingsTabRegistry.getTab(this.activeTab);
			if (tab) {
				this._renderPluginTab(tab);
			}
		}
	}

	// ─── General Settings ─────────────────────────────────────────────────────

	private _renderSettings(settings: SettingItem[]): void {
		const categories = new Map<string, SettingItem[]>();
		for (const setting of settings) {
			if (!categories.has(setting.category)) {
				categories.set(setting.category, []);
			}
			categories.get(setting.category)!.push(setting);
		}

		for (const [category, items] of categories) {
			const section = $('div.settings-section');
			const catHeader = $('div.settings-category-header');
			catHeader.textContent = category;
			section.appendChild(catHeader);

			for (const item of items) {
				const row = $('div.setting-row');
				const info = $('div.setting-info');
				const labelEl = $('div.setting-label');
				labelEl.textContent = item.label;
				info.appendChild(labelEl);
				const descEl = $('div.setting-desc');
				descEl.textContent = item.description;
				info.appendChild(descEl);
				row.appendChild(info);

				const control = $('div.setting-control');
				this._createControl(control, item);
				row.appendChild(control);

				section.appendChild(row);
			}

			this.contentContainer.appendChild(section);
		}
	}

	private _createControl(container: HTMLElement, item: SettingItem): void {
		switch (item.type) {
			case 'boolean': {
				const toggle = $('label.setting-toggle');
				const checkbox = document.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.checked = item.value;
				checkbox.onchange = () => { item.value = checkbox.checked; };
				toggle.appendChild(checkbox);
				const slider = $('span.toggle-slider');
				toggle.appendChild(slider);
				container.appendChild(toggle);
				break;
			}
			case 'string': {
				const input = document.createElement('input');
				input.type = 'text';
				input.className = 'setting-text-input';
				input.value = item.value;
				input.onchange = () => { item.value = input.value; };
				container.appendChild(input);
				break;
			}
			case 'number': {
				const input = document.createElement('input');
				input.type = 'number';
				input.className = 'setting-number-input';
				input.value = String(item.value);
				input.onchange = () => { item.value = Number(input.value); };
				container.appendChild(input);
				break;
			}
			case 'select': {
				const select = document.createElement('select');
				select.className = 'setting-select';
				for (const opt of item.options || []) {
					const option = document.createElement('option');
					option.value = opt;
					option.textContent = opt;
					option.selected = opt === item.value;
					select.appendChild(option);
				}
				select.onchange = () => { item.value = select.value; };
				container.appendChild(select);
				break;
			}
		}
	}

	private _filterSettings(query: string): void {
		const lowerQuery = query.toLowerCase();
		const filtered = SETTINGS.filter(s =>
			s.label.toLowerCase().includes(lowerQuery) ||
			s.description.toLowerCase().includes(lowerQuery) ||
			s.category.toLowerCase().includes(lowerQuery)
		);
		this._renderSettings(filtered);
	}

	// ─── Plugin Tab (Generic Renderer) ────────────────────────────────────────

	private _loadPluginConfig(): void {
		for (const tab of this.settingsTabRegistry.tabs) {
			const fieldMap = new Map<string, any>();
			for (const field of tab.fields) {
				const configValue = this.configurationService.getValue(field.key);
				if (configValue !== undefined && configValue !== null) {
					fieldMap.set(field.key, configValue);
				} else if (field.default !== undefined) {
					fieldMap.set(field.key, field.default);
				} else {
					// Type-appropriate defaults
					switch (field.type) {
						case 'boolean': fieldMap.set(field.key, false); break;
						case 'number': fieldMap.set(field.key, 0); break;
						case 'json': fieldMap.set(field.key, []); break;
						default: fieldMap.set(field.key, ''); break;
					}
				}
			}
			this.pluginFieldValues.set(tab.id, fieldMap);
		}
	}

	private _renderPluginTab(tab: ISettingsTabDescriptor): void {
		// Section header
		if (tab.description || tab.label) {
			const head = $('div.plugin-tab-section-head');
			const titleEl = $('div.plugin-tab-section-title');
			titleEl.textContent = tab.label;
			head.appendChild(titleEl);
			if (tab.description) {
				const metaEl = $('div.plugin-tab-section-meta');
				metaEl.textContent = tab.description;
				head.appendChild(metaEl);
			}
			this.contentContainer.appendChild(head);
		}

		// Hint
		if (tab.hint) {
			const hint = $('div.plugin-tab-hint');
			hint.textContent = tab.hint;
			this.contentContainer.appendChild(hint);
		}

		// Fields
		const fieldMap = this.pluginFieldValues.get(tab.id);
		if (fieldMap) {
			for (const field of tab.fields) {
				const fieldEl = this._renderPluginField(tab.id, field, fieldMap);
				this.contentContainer.appendChild(fieldEl);
			}
		}

		// Actions
		const actionsRow = $('div.plugin-tab-actions');
		// Custom actions
		for (const action of (tab.actions || [])) {
			const btn = $('button.plugin-tab-btn');
			btn.textContent = action.label;
			if (action.cssClass) {
				btn.classList.add(`plugin-tab-btn-${action.cssClass}`);
			} else {
				btn.classList.add('plugin-tab-btn-secondary');
			}
			btn.onclick = () => this._handlePluginAction(tab, action);
			actionsRow.appendChild(btn);
		}
		// Save button (always present)
		const saveBtn = $('button.plugin-tab-btn.plugin-tab-btn-primary');
		saveBtn.textContent = '保存设置';
		saveBtn.onclick = () => this._savePluginTab(tab);
		actionsRow.appendChild(saveBtn);
		this.contentContainer.appendChild(actionsRow);

		// Status message
		if (this.statusMessage) {
			const statusEl = $('div.plugin-tab-status-message');
			statusEl.textContent = this.statusMessage;
			this.contentContainer.appendChild(statusEl);
		}
	}

	private _renderPluginField(tabId: string, field: ISettingsFieldDescriptor, fieldMap: Map<string, any>): HTMLElement {
		const container = $('div.plugin-tab-field');
		const labelEl = $('label.plugin-tab-field-label');
		labelEl.textContent = field.label;
		if (field.key) {
			labelEl.setAttribute('for', `settings-${tabId}-${field.key}`);
		}
		container.appendChild(labelEl);

		if (field.description || field.link) {
			const descEl = $('div.plugin-tab-field-desc');
			if (field.description) {
				descEl.appendChild(document.createTextNode(field.description));
			}
			if (field.link) {
				if (field.description) {
					descEl.appendChild(document.createTextNode(' '));
				}
				const linkEl = document.createElement('a');
				linkEl.className = 'plugin-tab-field-link';
				linkEl.textContent = field.link.label;
				linkEl.href = field.link.href;
				linkEl.title = field.link.href;
				linkEl.onclick = (e) => {
					e.preventDefault();
					window.open(field.link!.href, '_blank', 'noopener');
				};
				descEl.appendChild(linkEl);
			}
			container.appendChild(descEl);
		}

		const currentValue = fieldMap.get(field.key);

		switch (field.type) {
			case 'password': {
				const input = document.createElement('input');
				input.type = 'password';
				input.id = `settings-${tabId}-${field.key}`;
				input.className = 'plugin-tab-input';
				input.value = String(currentValue || '');
				input.placeholder = field.placeholder || '';
				input.oninput = () => { fieldMap.set(field.key, input.value); };
				container.appendChild(input);
				break;
			}
			case 'text': {
				const input = document.createElement('input');
				input.type = 'text';
				input.id = `settings-${tabId}-${field.key}`;
				input.className = 'plugin-tab-input';
				input.value = String(currentValue || '');
				input.placeholder = field.placeholder || '';
				input.oninput = () => { fieldMap.set(field.key, input.value); };
				container.appendChild(input);
				break;
			}
			case 'number': {
				const input = document.createElement('input');
				input.type = 'number';
				input.id = `settings-${tabId}-${field.key}`;
				input.className = 'plugin-tab-input plugin-tab-input-number';
				input.value = String(currentValue ?? 0);
				if (field.min !== undefined) { input.min = String(field.min); }
				if (field.max !== undefined) { input.max = String(field.max); }
				input.placeholder = field.placeholder || '';
				input.oninput = () => { fieldMap.set(field.key, Number(input.value) || 0); };
				container.appendChild(input);
				break;
			}
			case 'boolean': {
				const toggle = this._createToggle(!!currentValue, (val) => { fieldMap.set(field.key, val); });
				container.appendChild(toggle);
				break;
			}
			case 'select': {
				const select = document.createElement('select');
				select.id = `settings-${tabId}-${field.key}`;
				select.className = 'plugin-tab-select';
				for (const opt of field.options || []) {
					const option = document.createElement('option');
					option.value = opt;
					option.textContent = opt;
					option.selected = opt === String(currentValue);
					select.appendChild(option);
				}
				select.onchange = () => { fieldMap.set(field.key, select.value); };
				container.appendChild(select);
				break;
			}
			case 'json': {
				const textarea = document.createElement('textarea');
				textarea.id = `settings-${tabId}-${field.key}`;
				textarea.className = 'plugin-tab-textarea';
				const jsonValue = Array.isArray(currentValue)
					? JSON.stringify(currentValue, undefined, 2)
					: (typeof currentValue === 'object' && currentValue !== null)
						? JSON.stringify(currentValue, undefined, 2)
						: String(currentValue || '[]');
				textarea.value = jsonValue;
				textarea.placeholder = field.placeholder || '[{ "id": "...", "name": "..." }]';
				textarea.rows = field.rows || 6;
				textarea.oninput = () => { fieldMap.set(field.key, textarea.value); };
				container.appendChild(textarea);
				break;
			}
			case 'textarea': {
				const textarea = document.createElement('textarea');
				textarea.id = `settings-${tabId}-${field.key}`;
				textarea.className = 'plugin-tab-textarea';
				textarea.value = String(currentValue || '');
				textarea.placeholder = field.placeholder || '';
				textarea.rows = field.rows || 4;
				textarea.oninput = () => { fieldMap.set(field.key, textarea.value); };
				container.appendChild(textarea);
				break;
			}
		}

		return container;
	}

	private _createToggle(checked: boolean, onChange: (val: boolean) => void): HTMLElement {
		const toggle = $('label.setting-toggle');
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = checked;
		checkbox.onchange = () => { onChange(checkbox.checked); };
		toggle.appendChild(checkbox);
		const slider = $('span.toggle-slider');
		toggle.appendChild(slider);
		return toggle;
	}

	// ─── Plugin Actions ───────────────────────────────────────────────────────

	private async _handlePluginAction(tab: ISettingsTabDescriptor, action: ISettingsActionDescriptor): Promise<void> {
		// Dispatch action by ID pattern
		// Built-in action handlers for common patterns
		switch (action.id) {
			case 'testConnection':
				await this._handleTestConnection(tab);
				break;
			default:
				// For unknown actions, fire a command via the extension host
				// The extension can register a command handler for: `${tab.id}.${action.id}`
				this.statusMessage = `⚡ Action "${action.label}" triggered`;
				this._renderActiveTab();
				setTimeout(() => {
					this.statusMessage = '';
					if (this.activeTab === tab.id) { this._renderActiveTab(); }
				}, 2000);
				break;
		}
	}

	private async _handleTestConnection(tab: ISettingsTabDescriptor): Promise<void> {
		const fieldMap = this.pluginFieldValues.get(tab.id);
		if (!fieldMap) { return; }

		// Look for token and baseUrl fields
		const tokenField = tab.fields.find(f => f.type === 'password' || f.key.includes('token'));
		const baseUrlField = tab.fields.find(f => f.key.includes('baseUrl') || f.key.includes('endpoint'));
		const userField = tab.fields.find(f => f.key.includes('user') || f.key.includes('User'));

		const token = tokenField ? String(fieldMap.get(tokenField.key) || '') : '';
		if (!token) {
			this.statusMessage = '⚠️ 请先填写 API Token';
			this._renderActiveTab();
			return;
		}

		this.statusMessage = '🔄 正在测试连接...';
		this._renderActiveTab();

		try {
			const baseUrl = baseUrlField
				? String(fieldMap.get(baseUrlField.key) || baseUrlField.default || 'https://knot.woa.com')
				: 'https://knot.woa.com';
			const apiUrl = `${baseUrl}/apigw/api/v1/agents`;
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
			};
			if (tokenField) {
				headers[`x-${tab.id}-api-token`] = token;
			}
			if (userField) {
				const user = String(fieldMap.get(userField.key) || '');
				if (user) {
					headers[`x-${tab.id}-api-user`] = user;
				}
			}

			const response = await fetch(apiUrl, { method: 'GET', headers });
			if (response.ok) {
				this.statusMessage = '✅ 连接成功！';
			} else {
				const errorText = await response.text().catch(() => '');
				this.statusMessage = `❌ 连接失败 (${response.status}): ${errorText.slice(0, 100)}`;
			}
		} catch (error) {
			this.statusMessage = `❌ 连接失败: ${error}`;
		}

		this._renderActiveTab();
		setTimeout(() => {
			this.statusMessage = '';
			if (this.activeTab === tab.id) { this._renderActiveTab(); }
		}, 5000);
	}

	private _savePluginTab(tab: ISettingsTabDescriptor): void {
		const fieldMap = this.pluginFieldValues.get(tab.id);
		if (!fieldMap) { return; }

		// Validate JSON fields
		for (const field of tab.fields) {
			if (field.type === 'json') {
				const rawValue = fieldMap.get(field.key);
				if (typeof rawValue === 'string') {
					try {
						JSON.parse(rawValue);
					} catch {
						this.statusMessage = `⚠️ ${field.label} 必须是有效的 JSON 格式`;
						this._renderActiveTab();
						return;
					}
				}
			}
		}

		// Save all fields to configuration
		for (const field of tab.fields) {
			let value = fieldMap.get(field.key);
			// Parse JSON strings before saving
			if (field.type === 'json' && typeof value === 'string') {
				try {
					value = JSON.parse(value);
				} catch {
					// skip — already validated above
				}
			}
			this.configurationService.updateValue(field.key, value);
		}

		this.statusMessage = '✅ 设置已保存';
		this._renderActiveTab();

		setTimeout(() => {
			this.statusMessage = '';
			if (this.activeTab === tab.id) { this._renderActiveTab(); }
		}, 3000);
	}

	// ─── Reset ────────────────────────────────────────────────────────────────

	private _resetAll(): void {
		if (this.activeTab === 'general') {
			this._renderSettings(SETTINGS);
		} else {
			const tab = this.settingsTabRegistry.getTab(this.activeTab);
			if (tab) {
				this._loadPluginConfig();
				this._renderActiveTab();
			}
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.contentContainer) {
			this.contentContainer.style.height = `${height - 80}px`;
		}
	}
}
