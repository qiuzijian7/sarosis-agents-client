/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/settingsEditorPane.css';

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
import { SettingsEditorInput } from './settingsEditorInput.js';
import * as DOM from '../../../../base/browser/dom.js';
import { IWorkbenchThemeService, IWorkbenchColorTheme } from '../../../../workbench/services/themes/common/workbenchThemeService.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { renderProviderSettings } from './providerSettingsRenderer.js';
import {
	AGENT_STUDIO_LANGUAGE_SETTING,
	AGENT_STUDIO_SEND_KEY_SETTING,
	AGENT_STUDIO_BOT_NAME_SETTING,
	AGENT_STUDIO_SHOW_TOKEN_USAGE_SETTING,
	AGENT_STUDIO_NOTIFICATION_SOUND_SETTING,
	AGENT_STUDIO_BROWSER_NOTIFICATIONS_SETTING,
	AGENT_STUDIO_CHECK_UPDATES_SETTING,
	AGENT_STUDIO_AUX_VISION_PROVIDER,
	AGENT_STUDIO_AUX_VISION_MODEL,
	AGENT_STUDIO_AUX_WEB_EXTRACT_PROVIDER,
	AGENT_STUDIO_AUX_WEB_EXTRACT_MODEL,
	AGENT_STUDIO_AUX_SESSION_SEARCH_PROVIDER,
	AGENT_STUDIO_AUX_SESSION_SEARCH_MODEL,
	AGENT_STUDIO_AUX_COMPRESSION_PROVIDER,
	AGENT_STUDIO_AUX_COMPRESSION_MODEL,
	AGENT_STUDIO_AUX_GOAL_JUDGE_PROVIDER,
	AGENT_STUDIO_AUX_GOAL_JUDGE_MODEL,
	AGENT_STUDIO_AUX_CURATOR_PROVIDER,
	AGENT_STUDIO_AUX_CURATOR_MODEL,
	AGENT_STUDIO_DATA_PATH_SETTING,
	AGENT_STUDIO_CLI_PATH_SETTING,
	AGENT_STUDIO_CLI_DEFAULT_WORKDIR_SETTING,
	AGENT_STUDIO_CLI_AUTO_CONNECT_SETTING,
	AGENT_STUDIO_CLI_SAVE_HISTORY_SETTING,
} from '../common/constants.js';

const { $ } = DOM;

// ─── Settings Schema Definitions ──────────────────────────────────────────

interface SettingField {
	key: string;
	label: string;
	description: string;
	type: 'boolean' | 'string' | 'number' | 'select' | 'password' | 'json' | 'textarea' | 'vscode-theme';
	default: any;
	options?: { value: string; label: string }[];
	placeholder?: string;
	rows?: number;
	min?: number;
	max?: number;
}

interface SettingSection {
	id: string;
	label: string;
	icon: string;
	description: string;
	fields: SettingField[];
	defaultCollapsed?: boolean;
}

// ─── Preference Sections ─────────────────────────────────────────────

const PREFERENCES_SECTIONS: SettingSection[] = [
	{
		id: 'preferences-general',
		label: '通用',
		icon: '⚙️',
		description: '主题、语言和基本偏好',
		defaultCollapsed: false,
		fields: [
			// Theme is rendered as a VSCode-native theme picker using IWorkbenchThemeService
			{ key: 'workbench.colorTheme', label: '颜色主题', description: '选择 VS Code 颜色主题，应用于整个编辑器界面', type: 'vscode-theme' as any, default: '' },
			{ key: AGENT_STUDIO_LANGUAGE_SETTING, label: '语言', description: '显示语言', type: 'select', default: 'en', options: [
				{ value: 'en', label: 'English' },
				{ value: 'zh-CN', label: '简体中文' },
				{ value: 'ja', label: '日本語' },
			] },
			{ key: AGENT_STUDIO_SEND_KEY_SETTING, label: '发送键', description: '发送消息的快捷键', type: 'select', default: 'enter', options: [
				{ value: 'enter', label: 'Enter 发送，Shift+Enter 换行' },
				{ value: 'ctrl+enter', label: 'Ctrl+Enter 发送，Enter 换行' },
			] },
			// Default Provider and Model settings have been moved to the dedicated Provider view
			{ key: AGENT_STUDIO_BOT_NAME_SETTING, label: '助手名称', description: 'AI 助手在界面中的显示名称', type: 'string', default: 'Sarosis', placeholder: 'Sarosis' },
		],
	},
	{
		id: 'preferences-notifications',
		label: '通知',
		icon: '🔔',
		description: '提示音和通知设置',
		defaultCollapsed: true,
		fields: [
			{ key: AGENT_STUDIO_SHOW_TOKEN_USAGE_SETTING, label: '显示 Token 用量', description: '在每条助手回复下方显示输入/输出 Token 数量', type: 'boolean', default: false },
			{ key: AGENT_STUDIO_NOTIFICATION_SOUND_SETTING, label: '通知提示音', description: '助手完成回复时播放提示音', type: 'boolean', default: false },
			{ key: AGENT_STUDIO_BROWSER_NOTIFICATIONS_SETTING, label: '浏览器通知', description: '标签页在后台时，回复完成后显示系统通知', type: 'boolean', default: false },
			{ key: AGENT_STUDIO_CHECK_UPDATES_SETTING, label: '检查更新', description: '有新版本可用时显示更新提示横幅', type: 'boolean', default: true },
		],
	},
];

const AUX_PROVIDER_OPTIONS = [
	{ value: 'auto', label: 'Auto（自动）' },
	{ value: 'openrouter', label: 'OpenRouter' },
	{ value: 'nous', label: 'Nous' },
	{ value: 'gemini', label: 'Gemini' },
	{ value: 'anthropic', label: 'Anthropic' },
	{ value: 'main', label: 'Main' },
	{ value: 'knot', label: 'Knot' },
	{ value: 'custom', label: 'Custom' },
];

function makeAuxBlock(key: string, providerKey: string, modelKey: string, label: string, desc: string): SettingSection {
	return {
		id: `aux-${key}`,
		label,
		icon: key === 'vision' ? '👁️' : key === 'webExtract' ? '🌐' : key === 'sessionSearch' ? '🔍' : key === 'compression' ? '📦' : key === 'goalJudge' ? '🎯' : '🧑‍💻',
		description: desc,
		defaultCollapsed: true,
		fields: [
			{ key: providerKey, label: 'Provider', description: `Provider for ${label}`, type: 'select', default: 'auto', options: AUX_PROVIDER_OPTIONS },
			{ key: modelKey, label: 'Model', description: '留空使用默认模型', type: 'string', default: '', placeholder: '自定义模型名称' },
		],
	};
}

const AUX_SECTIONS: SettingSection[] = [
	makeAuxBlock('vision', AGENT_STUDIO_AUX_VISION_PROVIDER, AGENT_STUDIO_AUX_VISION_MODEL, 'Vision（图像分析）', '用于分析上传的图片'),
	makeAuxBlock('webExtract', AGENT_STUDIO_AUX_WEB_EXTRACT_PROVIDER, AGENT_STUDIO_AUX_WEB_EXTRACT_MODEL, 'Web Extract（网页摘要）', '用于在研究中摘要网页'),
	makeAuxBlock('sessionSearch', AGENT_STUDIO_AUX_SESSION_SEARCH_PROVIDER, AGENT_STUDIO_AUX_SESSION_SEARCH_MODEL, 'Session Search（历史摘要）', '用于摘要对话历史'),
	makeAuxBlock('compression', AGENT_STUDIO_AUX_COMPRESSION_PROVIDER, AGENT_STUDIO_AUX_COMPRESSION_MODEL, 'Compression（上下文压缩）', '用于压缩长上下文窗口'),
	makeAuxBlock('goalJudge', AGENT_STUDIO_AUX_GOAL_JUDGE_PROVIDER, AGENT_STUDIO_AUX_GOAL_JUDGE_MODEL, 'Goal Judge（目标评估）', '用于评估目标完成'),
	makeAuxBlock('curator', AGENT_STUDIO_AUX_CURATOR_PROVIDER, AGENT_STUDIO_AUX_CURATOR_MODEL, 'Curator（代码审查）', '用于审查代码变更'),
];

// ─── Provider Sections ───────────────────────────────────────────────
// Provider configuration (API Key, Base URL, Default Provider/Model) has
// been moved to the dedicated Provider sidebar view (ProviderViewPane).
// The TOC entry still shows "Provider 配置" but renders a redirect notice.

const CLI_SECTION: SettingSection = {
	id: 'cli',
	label: 'Local CLI',
	icon: '💻',
	description: '本地 CLI 后端连接设置',
	defaultCollapsed: true,
	fields: [
		{ key: AGENT_STUDIO_CLI_PATH_SETTING, label: 'CLI 路径', description: 'CLI 可执行文件路径（如 /usr/local/bin/hermes）', type: 'string', default: '', placeholder: '/usr/local/bin/hermes' },
		{ key: AGENT_STUDIO_CLI_DEFAULT_WORKDIR_SETTING, label: '默认工作目录', description: 'CLI 会话的默认工作目录', type: 'string', default: '', placeholder: '~/.hermes/workspace' },
		{ key: AGENT_STUDIO_CLI_AUTO_CONNECT_SETTING, label: '自动连接', description: '启动 WebUI 时自动连接到本地 CLI 后端', type: 'boolean', default: true },
		{ key: AGENT_STUDIO_CLI_SAVE_HISTORY_SETTING, label: '保存命令历史', description: '保存 CLI 交互历史以便回溯和复用', type: 'boolean', default: true },
	],
};

const DATA_SECTION: SettingSection = {
	id: 'data',
	label: '数据存储',
	icon: '📁',
	description: '数据目录和工作区设置',
	defaultCollapsed: true,
	fields: [
		{ key: AGENT_STUDIO_DATA_PATH_SETTING, label: '数据目录', description: '自定义 Agent Studio 数据路径，默认使用工作区 .agent-studio/data/', type: 'string', default: '', placeholder: '/path/to/data' },
	],
};

// ─── TOC Entries (VSCode-native style) ──────────────────────────────────────────

interface TocEntry {
	id: string;
	label: string;
	icon: string;
	sections: SettingSection[];
	/** Custom content renderer — when provided, overrides default _renderCollapsibleSections */
	renderContent?: (container: HTMLElement, parent: SettingsEditorPane) => void;
}

const TOC_ENTRIES: TocEntry[] = [
	{ id: 'preferences', label: '通用设置', icon: '⚙️', sections: PREFERENCES_SECTIONS },
	{ id: 'auxiliary', label: '辅助模型', icon: '🧠', sections: AUX_SECTIONS },
	{ id: 'cli', label: 'CLI 设置', icon: '💻', sections: [CLI_SECTION, DATA_SECTION] },
	{
		id: 'provider',
		label: 'Provider',
		icon: '🔌',
		sections: [],
		renderContent: (container: HTMLElement, parent: SettingsEditorPane) => {
			renderProviderSettings(container, parent.configurationService);
		},
	},
];

// ─── Settings Editor Pane (VSCode-native layout) ──────────────────────────────────────────

export class SettingsEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudioSettings';

	private _container: HTMLElement | undefined;
	private _tocContainer!: HTMLElement;
	private _contentScrollWrapper!: HTMLElement;
	private _contentContainer!: HTMLElement;
	private _searchInput!: HTMLInputElement;
	private _activeTocId: string = 'preferences';
	private _statusMessage: string = '';
	private _initialized = false;
	private readonly _disposables = new DisposableStore();

	/** Track collapsed state by section id */
	private _collapsedState = new Map<string, boolean>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService readonly configurationService: IConfigurationService,
		@IWorkbenchThemeService private readonly workbenchThemeService: IWorkbenchThemeService,
	) {
		super(SettingsEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('as-settings-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		parent.appendChild(this._container);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof SettingsEditorInput)) {
			return;
		}

		if (!this._initialized && this._container) {
			this._buildSettingsUI(this._container);
			this._initialized = true;
		}
	}

	// ─── Build Settings UI (VSCode-native style) ──────────────────────────────

	private _buildSettingsUI(container: HTMLElement): void {
		this._loadCollapsedState();

		// ─── Header (fixed at top) ───────────────────────────────────────
		const header = $('div.as-settings-header');
		const headerLeft = $('div.as-settings-header-left');
		const icon = $('span.as-settings-header-icon');
		icon.textContent = '⚙️';
		headerLeft.appendChild(icon);
		const title = $('h2.as-settings-title');
		title.textContent = '设置';
		headerLeft.appendChild(title);
		header.appendChild(headerLeft);

		const headerRight = $('div.as-settings-header-right');
		const resetBtn = $('button.as-settings-reset-btn');
		resetBtn.textContent = '恢复默认';
		resetBtn.title = '将所有设置恢复为默认值';
		resetBtn.onclick = () => this._resetAll();
		headerRight.appendChild(resetBtn);
		header.appendChild(headerRight);
		container.appendChild(header);

		// ─── Search bar ─────────────────────────────────────────────────
		const searchWrap = $('div.as-settings-search-wrap');
		const searchIcon = $('span.as-settings-search-icon');
		searchIcon.textContent = '🔍';
		searchWrap.appendChild(searchIcon);
		this._searchInput = document.createElement('input');
		this._searchInput.className = 'as-settings-search-input';
		this._searchInput.placeholder = '搜索设置...';
		this._searchInput.oninput = () => {
			this._filterSettings(this._searchInput.value);
		};
		searchWrap.appendChild(this._searchInput);
		container.appendChild(searchWrap);

		// ─── Split View: TOC (left) | Content (right) ─────────────────
		const splitContainer = $('div.as-settings-split-container');
		splitContainer.style.flex = '1';
		splitContainer.style.overflow = 'hidden';
		splitContainer.style.display = 'flex';

		// Left: TOC sidebar
		this._tocContainer = $('div.as-settings-toc');
		this._renderToc();

		// Right: Content area (scrollable)
		this._contentScrollWrapper = $('div.as-settings-content-scroll');
		this._contentContainer = $('div.as-settings-content');

		splitContainer.appendChild(this._tocContainer);
		splitContainer.appendChild(this._contentScrollWrapper);
		this._contentScrollWrapper.appendChild(this._contentContainer);
		container.appendChild(splitContainer);

		// Render initial content
		this._renderTocContent();
	}

	// ─── TOC Sidebar ─────────────────────────────────────────────────

	private _renderToc(): void {
		this._tocContainer.replaceChildren();
		this._tocContainer.className = 'as-settings-toc';

		const tocTitle = $('div.as-settings-toc-title');
		tocTitle.textContent = '设置分类';
		this._tocContainer.appendChild(tocTitle);

		const tocList = $('div.as-settings-toc-list');
		for (const entry of TOC_ENTRIES) {
			const tocItem = $('div.as-settings-toc-item');
			tocItem.dataset.tocId = entry.id;
			if (entry.id === this._activeTocId) {
				tocItem.classList.add('active');
			}

			const tocIcon = $('span.as-settings-toc-icon');
			tocIcon.textContent = entry.icon;
			tocItem.appendChild(tocIcon);

			const tocLabel = $('span.as-settings-toc-label');
			tocLabel.textContent = entry.label;
			tocItem.appendChild(tocLabel);

			tocItem.onclick = () => {
				this._activeTocId = entry.id;
				this._tocContainer.querySelectorAll('.as-settings-toc-item').forEach(el => el.classList.remove('active'));
				tocItem.classList.add('active');
				this._renderTocContent();
			};

			tocList.appendChild(tocItem);
		}
		this._tocContainer.appendChild(tocList);
	}

	private _renderTocContent(): void {
		this._contentContainer.replaceChildren();
		this._statusMessage = '';

		const entry = TOC_ENTRIES.find(e => e.id === this._activeTocId);
		if (!entry) { return; }

		// Use custom renderer if provided, otherwise fall back to collapsible sections
		if (entry.renderContent) {
			entry.renderContent(this._contentContainer, this);
		} else {
			// Render sections for this TOC entry
			this._renderCollapsibleSections(entry.sections);
		}

		// Status message
		if (this._statusMessage) {
			const statusEl = $('div.as-plugin-status');
			statusEl.textContent = this._statusMessage;
			this._contentContainer.appendChild(statusEl);
		}
	}

	// ─── Collapsible Section Rendering ──────────────────────────────────────

	private _renderCollapsibleSections(sections: SettingSection[]): void {
		for (const section of sections) {
			const isCollapsed = this._collapsedState.get(section.id) ?? (section.defaultCollapsed ?? false);
			const sectionEl = $('div.as-section');
			sectionEl.dataset.sectionId = section.id;

			// Section header (collapsible)
			const header = $('div.as-section-header');
			header.setAttribute('role', 'button');
			header.setAttribute('tabindex', '0');
			header.setAttribute('aria-expanded', String(!isCollapsed));

			const chevron = $('span.as-section-chevron');
			chevron.textContent = isCollapsed ? '▶' : '▼';
			header.appendChild(chevron);

			const sectionIcon = $('span.as-section-icon');
			sectionIcon.textContent = section.icon;
			header.appendChild(sectionIcon);

			const headerInfo = $('div.as-section-header-info');
			const sectionLabel = $('span.as-section-label');
			sectionLabel.textContent = section.label;
			headerInfo.appendChild(sectionLabel);
			const sectionDesc = $('span.as-section-desc');
			sectionDesc.textContent = section.description;
			headerInfo.appendChild(sectionDesc);
			header.appendChild(headerInfo);

			// Toggle collapse
			const toggleCollapse = () => {
				const nowCollapsed = !sectionEl.classList.contains('as-section-collapsed');
				if (nowCollapsed) {
					sectionEl.classList.add('as-section-collapsed');
					chevron.textContent = '▶';
					header.setAttribute('aria-expanded', 'false');
				} else {
					sectionEl.classList.remove('as-section-collapsed');
					chevron.textContent = '▼';
					header.setAttribute('aria-expanded', 'true');
				}
				this._collapsedState.set(section.id, nowCollapsed);
				this._saveCollapsedState();
			};
			header.onclick = toggleCollapse;
			header.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(); } };

			sectionEl.appendChild(header);

			// Section body
			const body = $('div.as-section-body');
			for (const field of section.fields) {
				const row = this._renderFieldRow(field);
				body.appendChild(row);
			}
			sectionEl.appendChild(body);

			if (isCollapsed) {
				sectionEl.classList.add('as-section-collapsed');
			}

			this._contentContainer.appendChild(sectionEl);
		}
	}

	private _renderFieldRow(field: SettingField): HTMLElement {
		// ─── Special: VSCode Native Theme Picker ──────────────────
		if (field.type === 'vscode-theme') {
			return this._renderVscodeThemePickerRow(field);
		}

		const row = $('div.as-field-row');
		const labelWrap = $('div.as-field-label-wrap');
		const labelEl = $('label.as-field-label');
		labelEl.textContent = field.label;
		labelEl.setAttribute('for', `as-field-${field.key}`);
		labelWrap.appendChild(labelEl);
		if (field.description) {
			const descEl = $('div.as-field-desc');
			descEl.textContent = field.description;
			labelWrap.appendChild(descEl);
		}
		row.appendChild(labelWrap);

		const controlWrap = $('div.as-field-control');
		const currentValue = this._getConfigValue(field);

		switch (field.type) {
			case 'boolean': {
				const toggle = this._createToggle(!!currentValue, (val) => {
					this.configurationService.updateValue(field.key, val);
				});
				controlWrap.appendChild(toggle);
				break;
			}
			case 'string': {
				const input = document.createElement('input');
				input.type = 'text';
				input.id = `as-field-${field.key}`;
				input.className = 'as-input';
				input.value = String(currentValue || '');
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, input.value); };
				controlWrap.appendChild(input);
				break;
			}
			case 'password': {
				const input = document.createElement('input');
				input.type = 'password';
				input.id = `as-field-${field.key}`;
				input.className = 'as-input';
				input.value = String(currentValue || '');
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, input.value); };
				controlWrap.appendChild(input);
				break;
			}
			case 'number': {
				const input = document.createElement('input');
				input.type = 'number';
				input.id = `as-field-${field.key}`;
				input.className = 'as-input as-input-number';
				input.value = String(currentValue ?? 0);
				if (field.min !== undefined) { input.min = String(field.min); }
				if (field.max !== undefined) { input.max = String(field.max); }
				input.placeholder = field.placeholder || '';
				input.onchange = () => { this.configurationService.updateValue(field.key, Number(input.value) || 0); };
				controlWrap.appendChild(input);
				break;
			}
			case 'select': {
				const select = document.createElement('select');
				select.id = `as-field-${field.key}`;
				select.className = 'as-select';
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
			case 'json': {
				const textarea = document.createElement('textarea');
				textarea.id = `as-field-${field.key}`;
				textarea.className = 'as-textarea';
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
				controlWrap.appendChild(textarea);
				break;
			}
			case 'textarea': {
				const textarea = document.createElement('textarea');
				textarea.id = `as-field-${field.key}`;
				textarea.className = 'as-textarea';
				textarea.value = String(currentValue || '');
				textarea.placeholder = field.placeholder || '';
				textarea.rows = field.rows || 4;
				textarea.onchange = () => { this.configurationService.updateValue(field.key, textarea.value); };
				controlWrap.appendChild(textarea);
				break;
			}
		}

		row.appendChild(controlWrap);
		return row;
	}

	// ─── VSCode Native Theme Picker ──────────────────────────────────

	/** Color palette for theme type groups */
	private static readonly THEME_GROUP_COLORS: Record<string, { bg: string; sidebar: string; accent: string; fg: string; border: string }> = {
		[ColorScheme.DARK]:                 { bg: '#1e1e1e', sidebar: '#252526', accent: '#3794ff', fg: '#cccccc', border: '#3c3c3c' },
		[ColorScheme.LIGHT]:                { bg: '#ffffff', sidebar: '#f5f5f5', accent: '#0078d4', fg: '#1e1e1e', border: '#e0e0e0' },
		[ColorScheme.HIGH_CONTRAST_DARK]:   { bg: '#000000', sidebar: '#0a0a0a', accent: '#ffff00', fg: '#ffffff', border: '#6fc3df' },
		[ColorScheme.HIGH_CONTRAST_LIGHT]:  { bg: '#ffffff', sidebar: '#f5f5f5', accent: '#0f4a85', fg: '#000000', border: '#0f4a85' },
	};

	private static readonly THEME_GROUP_LABELS: Record<string, string> = {
		[ColorScheme.DARK]: '深色主题',
		[ColorScheme.LIGHT]: '浅色主题',
		[ColorScheme.HIGH_CONTRAST_DARK]: '高对比度深色',
		[ColorScheme.HIGH_CONTRAST_LIGHT]: '高对比度浅色',
	};

	private _renderVscodeThemePickerRow(field: SettingField): HTMLElement {
		const container = $('div.as-theme-picker-container');

		// Label + description
		const labelWrap = $('div.as-field-label-wrap');
		const labelEl = $('label.as-field-label');
		labelEl.textContent = field.label;
		labelWrap.appendChild(labelEl);
		if (field.description) {
			const descEl = $('div.as-field-desc');
			descEl.textContent = field.description;
			labelWrap.appendChild(descEl);
		}
		container.appendChild(labelWrap);

		// Loading placeholder
		const loadingEl = $('div.as-theme-loading');
		loadingEl.textContent = '加载主题列表...';
		container.appendChild(loadingEl);

		// Async: Load themes and render cards
		this._loadAndRenderThemes(container, loadingEl);

		return container;
	}

	private async _loadAndRenderThemes(container: HTMLElement, loadingEl: HTMLElement): Promise<void> {
		try {
			const allThemes = await this.workbenchThemeService.getColorThemes();
			const currentTheme = this.workbenchThemeService.getColorTheme();

			// Remove loading indicator
			loadingEl.remove();

			// Group themes by ColorScheme type
			const groups = new Map<ColorScheme, IWorkbenchColorTheme[]>();
			for (const theme of allThemes) {
				const type = theme.type as ColorScheme;
				if (!groups.has(type)) {
					groups.set(type, []);
				}
				groups.get(type)!.push(theme);
			}

			// Sort each group by label
			for (const [, themes] of groups) {
				themes.sort((a, b) => a.label.localeCompare(b.label));
			}

			// Render groups in order: Dark, Light, HC Dark, HC Light
			const groupOrder: ColorScheme[] = [
				ColorScheme.DARK,
				ColorScheme.LIGHT,
				ColorScheme.HIGH_CONTRAST_DARK,
				ColorScheme.HIGH_CONTRAST_LIGHT,
			];

			for (const schemeType of groupOrder) {
				const themes = groups.get(schemeType);
				if (!themes || themes.length === 0) {
					continue;
				}

				const groupLabel = SettingsEditorPane.THEME_GROUP_LABELS[schemeType] || schemeType;

				// Group header
				const groupHeader = $('div.as-theme-group-header');
				const groupTitle = $('span.as-theme-group-title');
				groupTitle.textContent = `${groupLabel}（${themes.length}）`;
				groupHeader.appendChild(groupTitle);
				container.appendChild(groupHeader);

				// Theme cards grid
				const grid = $('div.as-theme-grid');

				for (const theme of themes) {
					const card = this._createThemeCard(theme, currentTheme, grid);
					grid.appendChild(card);
				}

				container.appendChild(grid);
			}

			// Listen for theme changes to update active state
			this._disposables.add(
				this.workbenchThemeService.onDidColorThemeChange((newTheme) => {
					this._updateActiveThemeCard(container, newTheme);
				})
			);
		} catch (e) {
			loadingEl.textContent = '加载主题列表失败';
			console.error('[SettingsEditorPane] Failed to load themes:', e);
		}
	}

	private _createThemeCard(
		theme: IWorkbenchColorTheme,
		currentTheme: IWorkbenchColorTheme,
		grid: HTMLElement,
	): HTMLElement {
		const card = document.createElement('button');
		card.className = 'as-theme-card';
		card.type = 'button';
		card.dataset.themeId = theme.id;
		card.title = theme.settingsId || theme.label;
		if (theme.id === currentTheme.id) {
			card.classList.add('as-theme-card-active');
		}

		const schemeType = theme.type as ColorScheme;
		const colors = SettingsEditorPane.THEME_GROUP_COLORS[schemeType]
			|| SettingsEditorPane.THEME_GROUP_COLORS[ColorScheme.DARK];

		// Mini preview
		const preview = $('div.as-theme-preview');
		preview.style.backgroundColor = colors.bg;
		preview.style.border = `1px solid ${colors.border}`;

		// Sidebar strip
		const sidebarStrip = $('div.as-theme-preview-sidebar');
		sidebarStrip.style.backgroundColor = colors.sidebar;

		// Content area
		const content = $('div.as-theme-preview-content');

		// Title bar
		const titleBar = $('div.as-theme-preview-titlebar');
		titleBar.style.backgroundColor = colors.sidebar;
		for (const dotColor of ['#ff5f57', '#febc2e', '#28c840']) {
			const dot = $('span.as-theme-preview-dot');
			dot.style.backgroundColor = dotColor;
			titleBar.appendChild(dot);
		}
		content.appendChild(titleBar);

		// Text lines
		for (let i = 0; i < 3; i++) {
			const line = $('div.as-theme-preview-line');
			line.style.backgroundColor = i === 0 ? colors.accent : colors.fg;
			line.style.opacity = i === 0 ? '0.8' : '0.25';
			line.style.width = i === 0 ? '60%' : i === 1 ? '85%' : '45%';
			content.appendChild(line);
		}

		preview.appendChild(sidebarStrip);
		preview.appendChild(content);
		card.appendChild(preview);

		// Label
		const cardLabel = $('span.as-theme-card-label');
		cardLabel.textContent = theme.label;
		card.appendChild(cardLabel);

		// Active check mark
		if (theme.id === currentTheme.id) {
			const checkMark = $('span.as-theme-card-check');
			checkMark.textContent = '✓';
			card.appendChild(checkMark);
		}

		// Click handler - use VS Code native theme service
		card.onclick = () => {
			this.workbenchThemeService.setColorTheme(theme.id, 'auto');
		};

		return card;
	}

	/** Update which card shows the active check mark after a theme change */
	private _updateActiveThemeCard(container: HTMLElement, newTheme: IWorkbenchColorTheme): void {
		container.querySelectorAll('.as-theme-card').forEach(c => {
			const el = c as HTMLElement;
			const isActive = el.dataset.themeId === newTheme.id;
			el.classList.toggle('as-theme-card-active', isActive);

			// Remove old check marks
			const oldCheck = el.querySelector('.as-theme-card-check');
			if (oldCheck) { oldCheck.remove(); }

			// Add check mark to newly active card
			if (isActive) {
				const newCheck = $('span.as-theme-card-check');
				newCheck.textContent = '✓';
				el.appendChild(newCheck);
			}
		});
	}


	private _getConfigValue(field: SettingField): any {
		const configValue = this.configurationService.getValue(field.key);
		if (configValue !== undefined && configValue !== null) {
			return configValue;
		}
		return field.default;
	}

	private _createToggle(checked: boolean, onChange: (val: boolean) => void): HTMLElement {
		const toggle = $('label.as-toggle');
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = checked;
		checkbox.onchange = () => { onChange(checkbox.checked); };
		toggle.appendChild(checkbox);
		const slider = $('span.as-toggle-slider');
		toggle.appendChild(slider);
		return toggle;
	}

	// ─── Search / Filter ────────────────────────────────────────────────────

	private _filterSettings(query: string): void {
		const lowerQuery = query.toLowerCase();
		if (!lowerQuery) {
			this._renderTocContent();
			return;
		}

		// Filter across all TOC entries
		this._contentContainer.replaceChildren();
		const allSections = [
			...PREFERENCES_SECTIONS,
			...AUX_SECTIONS,
			CLI_SECTION,
			DATA_SECTION,
		];

		const filtered: SettingSection[] = [];
		for (const section of allSections) {
			const matchedFields = section.fields.filter(f =>
				f.label.toLowerCase().includes(lowerQuery) ||
				f.description.toLowerCase().includes(lowerQuery) ||
				f.key.toLowerCase().includes(lowerQuery)
			);
			if (matchedFields.length > 0 || section.label.toLowerCase().includes(lowerQuery)) {
				filtered.push({
					...section,
					fields: matchedFields.length > 0 ? matchedFields : section.fields,
					defaultCollapsed: false,
				});
			}
		}

		this._renderCollapsibleSections(filtered);
	}

	// ─── Reset ──────────────────────────────────────────────────────

	private _resetAll(): void {
		const allSections = [...PREFERENCES_SECTIONS, ...AUX_SECTIONS, CLI_SECTION, DATA_SECTION];
		for (const section of allSections) {
			for (const field of section.fields) {
				this.configurationService.updateValue(field.key, field.default);
			}
		}

		this._statusMessage = '✅ 已恢复默认设置';
		this._renderTocContent();
		setTimeout(() => {
			this._statusMessage = '';
			this._renderTocContent();
		}, 3000);
	}

	// ─── EditorPane Overrides ───────────────────────────────────────

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	/** Load collapsed state from localStorage */
	private _loadCollapsedState(): void {
		try {
			const stored = localStorage.getItem('agentStudio.settings.collapsedState');
			if (stored) {
				const parsed = JSON.parse(stored);
				this._collapsedState = new Map<string, boolean>(Object.entries(parsed));
			}
		} catch (e) {
			this._collapsedState = new Map<string, boolean>();
		}
	}

	/** Save collapsed state to localStorage */
	private _saveCollapsedState(): void {
		try {
			const obj = Object.fromEntries(this._collapsedState);
			localStorage.setItem('agentStudio.settings.collapsedState', JSON.stringify(obj));
		} catch (e) {
			// Ignore storage errors
		}
	}

	override dispose(): void {
		this._disposables.dispose();
		super.dispose();
	}
}
