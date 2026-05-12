/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../src/vs/base/common/cancellation.js';
import { IStorageService } from '../../../src/vs/platform/storage/common/storage.js';
import { ITelemetryService } from '../../../src/vs/platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../src/vs/platform/theme/common/themeService.js';
import { EditorPane } from '../../../src/vs/workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../src/vs/workbench/common/editor.js';
import { EditorInput } from '../../../src/vs/workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../src/vs/workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../src/vs/platform/editor/common/editor.js';
import { IConfigurationService } from '../../../src/vs/platform/configuration/common/configuration.js';
import { KnotSettingsEditorInput } from './knotSettingsEditorInput.js';
import * as DOM from '../../../src/vs/base/browser/dom.js';

const { $ } = DOM;

// ─── Settings Field Definition ────────────────────────────────────────────

interface KnotSettingField {
	key: string;
	label: string;
	description: string;
	type: 'boolean' | 'string' | 'number' | 'password' | 'json' | 'textarea';
	default: any;
	placeholder?: string;
	rows?: number;
	min?: number;
	max?: number;
}

// ─── Knot Settings Sections ───────────────────────────────────────────────

const KNOT_SETTINGS_FIELDS: KnotSettingField[] = [
	{ key: 'sessions.agentStudio.knot.token', label: 'API TOKEN', description: '个人或团队 Token（在 knot.woa.com 生成）', type: 'password', default: '', placeholder: '粘贴你的 Knot API Token' },
	{ key: 'sessions.agentStudio.knot.user', label: 'API USER（企微英文名）', description: '使用团队 Token 时必填；个人 Token 可留空', type: 'string', default: '', placeholder: '如 zhangsan' },
	{ key: 'sessions.agentStudio.knot.agentId', label: '默认 Agent ID', description: '留空则在模型选择器中手动选择', type: 'string', default: '', placeholder: '如 your-agent-id' },
	{ key: 'sessions.agentStudio.knot.models', label: '智能体列表', description: 'JSON 数组格式，每项含 id、name 和可选的 models 数组', type: 'json', default: [], placeholder: '[{"id": "agent-1", "name": "Agent 1", "models": ["model-1"]}]', rows: 6 },
	{ key: 'sessions.agentStudio.knot.baseUrl', label: 'API 端点', description: 'Knot AG-UI 服务端点地址', type: 'string', default: 'https://knot.woa.com', placeholder: 'https://knot.woa.com' },
	{ key: 'knot.streaming', label: '启用流式响应', description: '实时接收模型输出', type: 'boolean', default: true },
	{ key: 'knot.timeout', label: '请求超时（ms）', description: 'API 请求超时时间', type: 'number', default: 60000, min: 1000, max: 300000 },
];

// ─── Collapsed State (persisted via IStorageService) ────────────────────────

const COLLAPSED_STORAGE_KEY = 'knot.settings.collapsed';

// ─── Knot Settings Editor Pane ──────────────────────────────────────────────

/**
 * Independent settings pane for the Knot AG-UI plugin.
 *
 * Opens in the left editor area (not embedded in the main Settings page).
 * This follows the same EditorPane pattern as SettingsEditorPane but is
 * self-contained within the knot-agui extension.
 */
export class KnotSettingsEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.knotSettings';

	private _container: HTMLElement | undefined;
	private _scrollWrapper!: HTMLElement;
	private _contentContainer!: HTMLElement;
	private _statusMessage: string = '';
	private _initialized = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(KnotSettingsEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('knot-settings-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		parent.appendChild(this._container);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof KnotSettingsEditorInput)) {
			return;
		}

		if (!this._initialized && this._container) {
			this._buildSettingsUI(this._container);
			this._initialized = true;
		}
	}

	// ─── Build UI ──────────────────────────────────────────────────────────

	private _buildSettingsUI(container: HTMLElement): void {
		// Scrollable wrapper
		this._scrollWrapper = document.createElement('div');
		this._scrollWrapper.className = 'knot-settings-scroll';
		container.appendChild(this._scrollWrapper);

		// Header
		const header = $('div.knot-settings-header');
		const headerLeft = $('div.knot-settings-header-left');
		const icon = $('span.knot-settings-header-icon');
		icon.textContent = '🔗';
		headerLeft.appendChild(icon);
		const title = $('h2.knot-settings-title');
		title.textContent = 'Knot AG-UI Settings';
		headerLeft.appendChild(title);
		header.appendChild(headerLeft);

		const headerRight = $('div.knot-settings-header-right');
		const resetBtn = $('button.knot-settings-reset-btn');
		resetBtn.textContent = 'Reset';
		resetBtn.onclick = () => this._resetAll();
		headerRight.appendChild(resetBtn);
		header.appendChild(headerRight);
		this._scrollWrapper.appendChild(header);

		// Description
		const desc = $('div.knot-settings-desc');
		desc.textContent = '通过 Knot AG-UI 协议连接企业智能体，支持流式对话和工具调用。';
		this._scrollWrapper.appendChild(desc);

		// Content
		this._contentContainer = $('div.knot-settings-content');
		this._scrollWrapper.appendChild(this._contentContainer);

		this._renderFields();

		// Actions
		const actionsRow = $('div.knot-settings-actions');
		const testBtn = $('button.knot-settings-btn.knot-settings-btn-secondary');
		testBtn.textContent = '测试连接';
		testBtn.onclick = () => this._handleTestConnection();
		actionsRow.appendChild(testBtn);

		const saveBtn = $('button.knot-settings-btn.knot-settings-btn-primary');
		saveBtn.textContent = '保存设置';
		saveBtn.onclick = () => this._saveAll();
		actionsRow.appendChild(saveBtn);

		this._scrollWrapper.appendChild(actionsRow);
	}

	// ─── Render Fields ────────────────────────────────────────────────────

	private _renderFields(): void {
		this._contentContainer.replaceChildren();

		for (const field of KNOT_SETTINGS_FIELDS) {
			const fieldEl = this._renderField(field);
			this._contentContainer.appendChild(fieldEl);
		}

		// Status message
		if (this._statusMessage) {
			const statusEl = $('div.knot-settings-status');
			statusEl.textContent = this._statusMessage;
			this._contentContainer.appendChild(statusEl);
		}
	}

	private _renderField(field: KnotSettingField): HTMLElement {
		const card = $('div.knot-field-card');
		const labelEl = $('label.knot-field-label');
		labelEl.textContent = field.label;
		labelEl.setAttribute('for', `knot-field-${field.key}`);
		card.appendChild(labelEl);

		if (field.description) {
			const descEl = $('div.knot-field-desc');
			descEl.textContent = field.description;
			card.appendChild(descEl);
		}

		const currentValue = this._getConfigValue(field);

		switch (field.type) {
			case 'password': {
				const input = document.createElement('input');
				input.type = 'password';
				input.id = `knot-field-${field.key}`;
				input.className = 'knot-input';
				input.value = String(currentValue || '');
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, input.value); };
				card.appendChild(input);
				break;
			}
			case 'string': {
				const input = document.createElement('input');
				input.type = 'text';
				input.id = `knot-field-${field.key}`;
				input.className = 'knot-input';
				input.value = String(currentValue || '');
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, input.value); };
				card.appendChild(input);
				break;
			}
			case 'number': {
				const input = document.createElement('input');
				input.type = 'number';
				input.id = `knot-field-${field.key}`;
				input.className = 'knot-input knot-input-number';
				input.value = String(currentValue ?? 0);
				if (field.min !== undefined) { input.min = String(field.min); }
				if (field.max !== undefined) { input.max = String(field.max); }
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, Number(input.value) || 0); };
				card.appendChild(input);
				break;
			}
			case 'boolean': {
				const toggle = this._createToggle(!!currentValue, (val) => {
					this.configurationService.updateValue(field.key, val);
				});
				card.appendChild(toggle);
				break;
			}
			case 'json': {
				const textarea = document.createElement('textarea');
				textarea.id = `knot-field-${field.key}`;
				textarea.className = 'knot-textarea';
				const jsonValue = Array.isArray(currentValue)
					? JSON.stringify(currentValue, undefined, 2)
					: (typeof currentValue === 'object' && currentValue !== null)
						? JSON.stringify(currentValue, undefined, 2)
						: String(currentValue || '[]');
				textarea.value = jsonValue;
				textarea.placeholder = field.placeholder || '[{ "id": "...", "name": "..." }]';
				textarea.rows = field.rows || 6;
				textarea.onchange = () => {
					try {
						const parsed = JSON.parse(textarea.value);
						this.configurationService.updateValue(field.key, parsed);
					} catch {
						// Keep raw string - will validate on save
					}
				};
				card.appendChild(textarea);
				break;
			}
			case 'textarea': {
				const textarea = document.createElement('textarea');
				textarea.id = `knot-field-${field.key}`;
				textarea.className = 'knot-textarea';
				textarea.value = String(currentValue || '');
				textarea.placeholder = field.placeholder || '';
				textarea.rows = field.rows || 4;
				textarea.onchange = () => { this.configurationService.updateValue(field.key, textarea.value); };
				card.appendChild(textarea);
				break;
			}
		}

		return card;
	}

	private _getConfigValue(field: KnotSettingField): any {
		const configValue = this.configurationService.getValue(field.key);
		if (configValue !== undefined && configValue !== null) {
			return configValue;
		}
		return field.default;
	}

	private _createToggle(checked: boolean, onChange: (val: boolean) => void): HTMLElement {
		const toggle = $('label.knot-toggle');
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = checked;
		checkbox.onchange = () => { onChange(checkbox.checked); };
		toggle.appendChild(checkbox);
		const slider = $('span.knot-toggle-slider');
		toggle.appendChild(slider);
		return toggle;
	}

	// ─── Test Connection ──────────────────────────────────────────────────

	private async _handleTestConnection(): Promise<void> {
		const token = this.configurationService.getValue<string>('sessions.agentStudio.knot.token');
		if (!token) {
			this._statusMessage = '⚠️ 请先填写 API Token';
			this._renderFields();
			return;
		}

		this._statusMessage = '🔄 正在测试连接...';
		this._renderFields();

		try {
			const baseUrl = this.configurationService.getValue<string>('sessions.agentStudio.knot.baseUrl') || 'https://knot.woa.com';
			const apiUrl = `${baseUrl}/apigw/api/v1/agents`;
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'x-knot-api-token': token,
			};
			const user = this.configurationService.getValue<string>('sessions.agentStudio.knot.user');
			if (user) {
				headers['x-knot-api-user'] = user;
			}

			const response = await fetch(apiUrl, { method: 'GET', headers });
			if (response.ok) {
				this._statusMessage = '✅ 连接成功！';
			} else {
				const errorText = await response.text().catch(() => '');
				this._statusMessage = `❌ 连接失败 (${response.status}): ${errorText.slice(0, 100)}`;
			}
		} catch (error) {
			this._statusMessage = `❌ 连接失败: ${error}`;
		}

		this._renderFields();
		setTimeout(() => {
			this._statusMessage = '';
			this._renderFields();
		}, 5000);
	}

	// ─── Save ─────────────────────────────────────────────────────────────

	private _saveAll(): void {
		// Validate JSON fields
		for (const field of KNOT_SETTINGS_FIELDS) {
			if (field.type === 'json') {
				const textarea = this._contentContainer.querySelector(`#knot-field-${field.key}`) as HTMLTextAreaElement | null;
				if (textarea) {
					try {
						const parsed = JSON.parse(textarea.value);
						this.configurationService.updateValue(field.key, parsed);
					} catch {
						this._statusMessage = `⚠️ ${field.label} 必须是有效的 JSON 格式`;
						this._renderFields();
						return;
					}
				}
			}
		}

		this._statusMessage = '✅ 设置已保存';
		this._renderFields();
		setTimeout(() => {
			this._statusMessage = '';
			this._renderFields();
		}, 3000);
	}

	// ─── Reset ────────────────────────────────────────────────────────────

	private _resetAll(): void {
		for (const field of KNOT_SETTINGS_FIELDS) {
			this.configurationService.updateValue(field.key, field.default);
		}

		this._statusMessage = '✅ 已恢复默认设置';
		this._renderFields();
		setTimeout(() => {
			this._statusMessage = '';
			this._renderFields();
		}, 3000);
	}

	// ─── EditorPane Overrides ──────────────────────────────────────────────

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}
}
