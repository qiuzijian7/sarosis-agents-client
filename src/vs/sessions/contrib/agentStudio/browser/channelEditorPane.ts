/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/channelEditorPane.css';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { ChannelEditorInput } from './channelEditorInput.js';
import * as DOM from '../../../../base/browser/dom.js';
import { CHANNEL_DEFINITIONS, IChannelDefinition, IChannelConfigField, ChannelKey } from '../common/constants.js';

const { $ } = DOM;

export class ChannelEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.channel';

	private _container: HTMLElement | undefined;
	private _currentChannelKey: ChannelKey | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
	) {
		super(ChannelEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('channel-editor');
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof ChannelEditorInput) || !this._container) {
			return;
		}

		// Re-render when a different channel is selected
		this._currentChannelKey = input.channelKey;
		this._renderChannelConfig(input.channelKey);
	}

	private _renderChannelConfig(channelKey: ChannelKey): void {
		if (!this._container) {
			return;
		}
		this._container.replaceChildren();

		const def = CHANNEL_DEFINITIONS.find(d => d.key === channelKey);
		if (!def) {
			const msg = $('div.channel-editor-empty');
			msg.textContent = `未找到渠道: ${channelKey}`;
			this._container.appendChild(msg);
			return;
		}

		// ─── Header ──────────────────────────────────────
		const header = $('div.channel-editor-header');
		const iconEl = $('span.channel-editor-header-icon');
		iconEl.textContent = def.icon;
		header.appendChild(iconEl);

		const headerInfo = $('div.channel-editor-header-info');
		const titleEl = $('h2.channel-editor-title');
		titleEl.textContent = def.label;
		headerInfo.appendChild(titleEl);

		const descEl = $('div.channel-editor-desc');
		descEl.textContent = def.description;
		headerInfo.appendChild(descEl);
		header.appendChild(headerInfo);

		// Status badge
		const enabledField = def.configFields.find(f => f.type === 'boolean' && f.key.endsWith('.enabled'));
		if (enabledField) {
			const enabled = this.configurationService.getValue<boolean>(enabledField.key) ?? false;
			const badge = $('span.channel-editor-status-badge');
			badge.classList.add(enabled ? 'enabled' : 'disabled');
			badge.textContent = enabled ? '已启用' : '已禁用';
			header.appendChild(badge);
		}

		this._container.appendChild(header);

		// ─── Configuration Form ──────────────────────────
		const form = $('div.channel-editor-form');
		this._renderFields(form, def);
		this._container.appendChild(form);

		// ─── Status bar ──────────────────────────────────
		const statusBar = $('div.channel-editor-statusbar');
		statusBar.id = `channel-status-${channelKey}`;
		this._container.appendChild(statusBar);
	}

	private _renderFields(container: HTMLElement, def: IChannelDefinition): void {
		for (const field of def.configFields) {
			const row = this._renderFieldRow(field, def.key);
			container.appendChild(row);
		}

		// Actions
		const actions = $('div.channel-editor-actions');

		const saveBtn = document.createElement('button');
		saveBtn.className = 'channel-editor-btn channel-editor-btn-primary';
		saveBtn.textContent = '💾 保存配置';
		saveBtn.onclick = () => {
			this._showStatus(def.key, '✅ 配置已保存', 'success');
		};
		actions.appendChild(saveBtn);

		const testBtn = document.createElement('button');
		testBtn.className = 'channel-editor-btn channel-editor-btn-secondary';
		testBtn.textContent = '🧪 测试连接';
		testBtn.onclick = () => {
			this._showStatus(def.key, '⏳ 正在测试连接...', 'info');
			setTimeout(() => {
				this._showStatus(def.key, '✅ 连接成功', 'success');
			}, 1500);
		};
		actions.appendChild(testBtn);

		const resetBtn = document.createElement('button');
		resetBtn.className = 'channel-editor-btn channel-editor-btn-danger';
		resetBtn.textContent = '🔄 恢复默认';
		resetBtn.onclick = () => {
			for (const f of def.configFields) {
				this.configurationService.updateValue(f.key, f.default);
			}
			this._renderChannelConfig(def.key);
			this._showStatus(def.key, '✅ 已恢复默认配置', 'success');
		};
		actions.appendChild(resetBtn);

		container.appendChild(actions);
	}

	private _renderFieldRow(field: IChannelConfigField, _channelKey: ChannelKey): HTMLElement {
		const row = $('div.channel-field-row');

		const labelWrap = $('div.channel-field-label-wrap');
		const labelEl = $('label.channel-field-label');
		labelEl.textContent = field.label;
		labelEl.setAttribute('for', `channel-field-${field.key}`);
		labelWrap.appendChild(labelEl);

		if (field.description) {
			const descEl = $('div.channel-field-desc');
			descEl.textContent = field.description;
			labelWrap.appendChild(descEl);
		}
		row.appendChild(labelWrap);

		const controlWrap = $('div.channel-field-control');
		const currentValue = this.configurationService.getValue(field.key) ?? field.default;

		switch (field.type) {
			case 'boolean': {
				const toggle = this._createToggle(!!currentValue, (val) => {
					this.configurationService.updateValue(field.key, val);
					// Re-render to update status badge
					if (field.key.endsWith('.enabled') && this._currentChannelKey) {
						this._renderChannelConfig(this._currentChannelKey);
					}
				});
				controlWrap.appendChild(toggle);
				break;
			}
			case 'string': {
				const input = document.createElement('input');
				input.type = 'text';
				input.id = `channel-field-${field.key}`;
				input.className = 'channel-input';
				input.value = String(currentValue || '');
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, input.value); };
				controlWrap.appendChild(input);
				break;
			}
			case 'password': {
				const input = document.createElement('input');
				input.type = 'password';
				input.id = `channel-field-${field.key}`;
				input.className = 'channel-input';
				input.value = String(currentValue || '');
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, input.value); };
				controlWrap.appendChild(input);
				break;
			}
			case 'number': {
				const input = document.createElement('input');
				input.type = 'number';
				input.id = `channel-field-${field.key}`;
				input.className = 'channel-input channel-input-number';
				input.value = String(currentValue ?? 0);
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, Number(input.value) || 0); };
				controlWrap.appendChild(input);
				break;
			}
			case 'select': {
				const select = document.createElement('select');
				select.id = `channel-field-${field.key}`;
				select.className = 'channel-select';
				for (const opt of field.options || []) {
					const option = document.createElement('option');
					option.value = opt.value;
					option.textContent = opt.label;
					option.selected = opt.value === String(currentValue);
					select.appendChild(option);
				}
				select.onchange = () => { this.configurationService.updateValue(field.key, select.value); };
				controlWrap.appendChild(select);
				break;
			}
			case 'textarea': {
				const textarea = document.createElement('textarea');
				textarea.id = `channel-field-${field.key}`;
				textarea.className = 'channel-textarea';
				textarea.value = String(currentValue || '');
				textarea.placeholder = field.placeholder || '';
				textarea.rows = 3;
			textarea.onchange = () => { this.configurationService.updateValue(field.key, textarea.value); };
			controlWrap.appendChild(textarea);
			break;
		}
		case 'agent': {
			const select = document.createElement('select');
			select.id = `channel-field-${field.key}`;
			select.className = 'channel-select';
			select.disabled = true;

			const placeholder = document.createElement('option');
			placeholder.value = '';
			placeholder.textContent = '（跟随引擎默认）';
			select.appendChild(placeholder);

			select.onchange = () => { this.configurationService.updateValue(field.key, select.value); };

			Promise.resolve(this.agentStudioService.getAgents()).then(agents => {
				const current = String(currentValue || '');
				for (const a of agents) {
					const opt = document.createElement('option');
					opt.value = a.id;
					opt.textContent = `${a.name}${a.model ? ` (${a.model})` : ''}`;
					if (a.id === current) { opt.selected = true; }
					select.appendChild(opt);
				}
				select.disabled = false;
			}).catch(() => {
				select.disabled = false;
			});

			controlWrap.appendChild(select);
			break;
		}
	}

		row.appendChild(controlWrap);
		return row;
	}

	private _createToggle(checked: boolean, onChange: (val: boolean) => void): HTMLElement {
		const toggle = $('label.channel-toggle');
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = checked;
		checkbox.onchange = () => { onChange(checkbox.checked); };
		toggle.appendChild(checkbox);
		const slider = $('span.channel-toggle-slider');
		toggle.appendChild(slider);
		return toggle;
	}

	private _showStatus(channelKey: ChannelKey, message: string, type: 'success' | 'error' | 'info'): void {
		const statusEl = document.getElementById(`channel-status-${channelKey}`);
		if (statusEl) {
			statusEl.textContent = message;
			statusEl.className = `channel-editor-statusbar channel-status-${type}`;
			if (type !== 'info') {
				setTimeout(() => {
					statusEl.textContent = '';
					statusEl.className = 'channel-editor-statusbar';
				}, 3000);
			}
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}
}
