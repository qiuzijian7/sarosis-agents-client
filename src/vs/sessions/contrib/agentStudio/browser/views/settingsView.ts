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

/**
 * Settings View - 设置面板
 * 功能：Agent Studio配置、UI偏好、工具权限、模型配置
 */
export class SettingsViewPane extends ViewPane {

	private contentContainer!: HTMLElement;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('settings-view');

		// Header with search
		const header = $('div.settings-header');
		const title = $('h3.settings-title');
		title.textContent = '⚙️ Settings';
		header.appendChild(title);

		const resetBtn = $('button.settings-reset-btn');
		resetBtn.textContent = 'Reset All';
		resetBtn.onclick = () => this._resetAll();
		header.appendChild(resetBtn);
		container.appendChild(header);

		// Search
		const searchInput = document.createElement('input');
		searchInput.className = 'settings-search';
		searchInput.placeholder = '🔍 Search settings...';
		searchInput.oninput = () => this._filterSettings(searchInput.value);
		container.appendChild(searchInput);

		// Content
		this.contentContainer = $('div.settings-content');
		this._renderSettings(SETTINGS);
		container.appendChild(this.contentContainer);
	}

	private _renderSettings(settings: SettingItem[]): void {
		this.contentContainer.innerHTML = '';

		// Group by category
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

	private _resetAll(): void {
		// Reset all settings to defaults
		this._renderSettings(SETTINGS);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.contentContainer) {
			this.contentContainer.style.height = `${height - 80}px`;
		}
	}
}
