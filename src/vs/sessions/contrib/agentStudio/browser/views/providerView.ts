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
	AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY,
	AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL,
	AGENT_STUDIO_PROVIDER_NOUS_API_KEY,
	AGENT_STUDIO_PROVIDER_NOUS_BASE_URL,
	AGENT_STUDIO_PROVIDER_GEMINI_API_KEY,
	AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL,
	AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY,
	AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL,
	AGENT_STUDIO_PROVIDER_MAIN_API_KEY,
	AGENT_STUDIO_PROVIDER_MAIN_BASE_URL,
	AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY,
	AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL,
	AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY,
	AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL,
	AGENT_STUDIO_DEFAULT_PROVIDER_SETTING,
	AGENT_STUDIO_DEFAULT_MODEL_SETTING,
} from '../../common/constants.js';

// ─── Provider Definitions ────────────────────────────────────────────────────

interface ProviderDefinition {
	id: string;
	name: string;
	icon: string;
	iconColor: string;
	apiKeySetting: string;
	baseUrlSetting: string;
	defaultBaseUrl: string;
	description: string;
	isBuiltin: boolean;
}

const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
	{
		id: 'openrouter',
		name: 'OpenRouter',
		icon: 'OR',
		iconColor: '#1E88E5',
		apiKeySetting: AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL,
		defaultBaseUrl: 'https://openrouter.ai/api/v1',
		description: 'Access multiple AI models through OpenRouter',
		isBuiltin: true,
	},
	{
		id: 'nous',
		name: 'Nous',
		icon: 'N',
		iconColor: '#FF6B6B',
		apiKeySetting: AGENT_STUDIO_PROVIDER_NOUS_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_NOUS_BASE_URL,
		defaultBaseUrl: 'https://api.nous.com/v1',
		description: 'Nous AI platform',
		isBuiltin: true,
	},
	{
		id: 'gemini',
		name: 'Gemini',
		icon: 'G',
		iconColor: '#8B5CF6',
		apiKeySetting: AGENT_STUDIO_PROVIDER_GEMINI_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL,
		defaultBaseUrl: 'https://generativelanguage.googleapis.com',
		description: 'Google Gemini AI models',
		isBuiltin: true,
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		icon: 'A',
		iconColor: '#D97757',
		apiKeySetting: AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL,
		defaultBaseUrl: 'https://api.anthropic.com',
		description: 'Anthropic Claude models',
		isBuiltin: true,
	},
	{
		id: 'ollama',
		name: 'Ollama',
		icon: '🦙',
		iconColor: '#6B4F3D',
		apiKeySetting: AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL,
		defaultBaseUrl: 'http://localhost:11434',
		description: 'Local AI models via Ollama',
		isBuiltin: true,
	},
	{
		id: 'main',
		name: 'Main',
		icon: 'M',
		iconColor: '#10B981',
		apiKeySetting: AGENT_STUDIO_PROVIDER_MAIN_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_MAIN_BASE_URL,
		defaultBaseUrl: '',
		description: 'Primary custom provider endpoint',
		isBuiltin: true,
	},
	{
		id: 'custom',
		name: 'Custom',
		icon: '+',
		iconColor: '#6B7280',
		apiKeySetting: AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL,
		defaultBaseUrl: '',
		description: 'Custom OpenAI-compatible endpoint',
		isBuiltin: true,
	},
];

const AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING = 'sessions.agentStudio.provider.customProviders';

interface CustomProviderData {
	id: string;
	name: string;
	apiKey: string;
	baseUrl: string;
	description: string;
}

// ─── Provider View ───────────────────────────────────────────────────────────

/**
 * Provider View - Provider 配置面板
 *
 * 功能：管理 AI Provider 的 API Key 和 Base URL 配置，
 * 显示各 Provider 的连接状态，支持快速切换默认 Provider。
 */
export class ProviderViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private statusMessageEl!: HTMLElement;
	private defaultProviderSelect!: HTMLSelectElement;
	private defaultModelInput!: HTMLInputElement;
	private statusMessage: string = '';
	private expandedProviderId: string | null = null;

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
			container.classList.add('provider-view');

			// Header
			const header = $('div.provider-header');
			const title = $('h3.provider-title');
			title.textContent = '🔌 Providers';
			header.appendChild(title);
			container.appendChild(header);

		// Default Provider & Model section
		const defaultSection = $('div.provider-default-section');
		const defaultHeader = $('div.provider-default-header');
		defaultHeader.textContent = '默认配置';
		defaultSection.appendChild(defaultHeader);

		// Default Provider
		const providerRow = $('div.provider-default-row');
		const providerLabel = $('label.provider-default-label');
		providerLabel.textContent = '默认 Provider';
		providerRow.appendChild(providerLabel);

		this.defaultProviderSelect = document.createElement('select');
		this.defaultProviderSelect.className = 'provider-default-select';
		const currentProvider = this.configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_PROVIDER_SETTING) || 'auto';
		const allProviders = this._getAllProviders();
		const providerOptions = [
			{ value: 'auto', label: 'Auto（自动选择）' },
			...allProviders.map(p => ({ value: p.id, label: p.name })),
		];
		for (const opt of providerOptions) {
			const option = document.createElement('option');
			option.value = opt.value;
			option.textContent = opt.label;
			option.selected = opt.value === currentProvider;
			this.defaultProviderSelect.appendChild(option);
		}
		this.defaultProviderSelect.onchange = () => {
			this.configurationService.updateValue(AGENT_STUDIO_DEFAULT_PROVIDER_SETTING, this.defaultProviderSelect.value);
		};
		providerRow.appendChild(this.defaultProviderSelect);
		defaultSection.appendChild(providerRow);



		// Default Model
		const modelRow = $('div.provider-default-row');
		const modelLabel = $('label.provider-default-label');
		modelLabel.textContent = '默认模型';
		modelRow.appendChild(modelLabel);

		this.defaultModelInput = document.createElement('input');
		this.defaultModelInput.type = 'text';
		this.defaultModelInput.className = 'provider-default-input';
		this.defaultModelInput.placeholder = '留空使用系统默认';
		const currentModel = this.configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_MODEL_SETTING) || '';
		this.defaultModelInput.value = currentModel;
		this.defaultModelInput.onchange = () => {
			this.configurationService.updateValue(AGENT_STUDIO_DEFAULT_MODEL_SETTING, this.defaultModelInput.value);
		};
		modelRow.appendChild(this.defaultModelInput);
		defaultSection.appendChild(modelRow);

		container.appendChild(defaultSection);

		// Provider list
		this.listContainer = $('div.provider-list');
		this._renderProviders();
		container.appendChild(this.listContainer);

		// Add Provider button
		const addBtnRow = $('div.provider-add-row');
		const addBtn = $('button.provider-add-btn');
		addBtn.textContent = '+ 添加 Provider';
		addBtn.onclick = () => this._showAddProviderForm();
		addBtnRow.appendChild(addBtn);
		container.appendChild(addBtnRow);

		// Status message (persistent element, updated dynamically)
		this.statusMessageEl = $('div.provider-status-message');
		this._updateStatusMessage();
		container.appendChild(this.statusMessageEl);
	}

	private _updateStatusMessage(): void {
		this.statusMessageEl.textContent = this.statusMessage;
		this.statusMessageEl.style.display = this.statusMessage ? 'block' : 'none';
	}

	private _getAllProviders(): ProviderDefinition[] {
		const customProviders = this.configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || [];
		const customDefs: ProviderDefinition[] = customProviders.map(cp => ({
			id: cp.id,
			name: cp.name,
			icon: cp.name.slice(0, 2).toUpperCase(),
			iconColor: '#6B7280',
			apiKeySetting: `sessions.agentStudio.provider.${cp.id}.apiKey`,
			baseUrlSetting: `sessions.agentStudio.provider.${cp.id}.baseUrl`,
			defaultBaseUrl: cp.baseUrl || '',
			description: cp.description || `${cp.name} provider`,
			isBuiltin: false,
		}));
		return [...PROVIDER_DEFINITIONS, ...customDefs];
	}

	private _renderProviders(): void {
		// Clear children safely (Trusted Types policy blocks innerHTML)
		while (this.listContainer.firstChild) {
			this.listContainer.removeChild(this.listContainer.firstChild);
		}

		for (const provider of this._getAllProviders()) {
			const card = $('div.provider-card');
			// Ollama and similar local providers don't need API key — just a base URL
			const isApiKeyOptionalProvider = provider.id === 'ollama';
			const hasApiKey = !!this.configurationService.getValue<string>(provider.apiKeySetting);
			const hasBaseUrl = !!(this.configurationService.getValue<string>(provider.baseUrlSetting) || provider.defaultBaseUrl);
			const isConfigured = isApiKeyOptionalProvider ? hasBaseUrl : hasApiKey;
			if (isConfigured) {
				card.classList.add('configured-highlight');
			}

			// Card header
			const cardHeader = $('div.provider-card-header');

			const iconEl = $('span.provider-card-icon');
			iconEl.textContent = provider.icon;
			iconEl.style.backgroundColor = provider.iconColor;
			cardHeader.appendChild(iconEl);

			const infoEl = $('div.provider-card-info');
			const nameRow = $('div.provider-card-name-row');
			const nameEl = $('span.provider-card-name');
			nameEl.textContent = provider.name;
			nameRow.appendChild(nameEl);

			const statusBadge = $('span.provider-card-status');
			if (isConfigured) {
				statusBadge.textContent = '已配置';
				statusBadge.classList.add('configured');
			} else {
				statusBadge.textContent = '未配置';
				statusBadge.classList.add('not-configured');
			}
			nameRow.appendChild(statusBadge);
			infoEl.appendChild(nameRow);

			const descEl = $('div.provider-card-desc');
			descEl.textContent = provider.description;
			infoEl.appendChild(descEl);
			cardHeader.appendChild(infoEl);

			// Chevron indicator
			const chevronEl = $('span.provider-card-chevron');
			chevronEl.textContent = '▸';
			cardHeader.appendChild(chevronEl);

			// Delete button for custom providers
			if (!provider.isBuiltin) {
				const deleteBtn = $('span.provider-card-delete');
				deleteBtn.textContent = '✕';
				deleteBtn.title = '删除此 Provider';
				deleteBtn.onclick = (e) => {
					e.stopPropagation();
					this._deleteCustomProvider(provider.id);
				};
				cardHeader.appendChild(deleteBtn);
			}

			card.appendChild(cardHeader);

			// Card body (collapsible config fields)
			const cardBody = $('div.provider-card-body');

			// API Key
			const apiKeyRow = $('div.provider-field');
			const apiKeyLabel = $('label.provider-field-label');
			apiKeyLabel.textContent = 'API Key';
			apiKeyLabel.setAttribute('for', `provider-apikey-${provider.id}`);
			apiKeyRow.appendChild(apiKeyLabel);

			const apiKeyInput = document.createElement('input');
			apiKeyInput.type = 'password';
			apiKeyInput.id = `provider-apikey-${provider.id}`;
			apiKeyInput.className = 'provider-field-input';
			apiKeyInput.placeholder = `粘贴你的 ${provider.name} API Key`;
			apiKeyInput.value = this.configurationService.getValue<string>(provider.apiKeySetting) || '';
			apiKeyInput.onchange = () => {
				this.configurationService.updateValue(provider.apiKeySetting, apiKeyInput.value);
				this.expandedProviderId = provider.id;
				this._renderProviders();
			};
			apiKeyRow.appendChild(apiKeyInput);
			cardBody.appendChild(apiKeyRow);

			// Base URL
			const baseUrlRow = $('div.provider-field');
			const baseUrlLabel = $('label.provider-field-label');
			baseUrlLabel.textContent = 'Base URL';
			baseUrlLabel.setAttribute('for', `provider-baseurl-${provider.id}`);
			baseUrlRow.appendChild(baseUrlLabel);

			const baseUrlInput = document.createElement('input');
			baseUrlInput.type = 'text';
			baseUrlInput.id = `provider-baseurl-${provider.id}`;
			baseUrlInput.className = 'provider-field-input';
			baseUrlInput.placeholder = provider.defaultBaseUrl || '自定义端点地址';
			baseUrlInput.value = this.configurationService.getValue<string>(provider.baseUrlSetting) || '';
			baseUrlInput.onchange = () => {
				this.configurationService.updateValue(provider.baseUrlSetting, baseUrlInput.value);
			};
			baseUrlRow.appendChild(baseUrlInput);
			cardBody.appendChild(baseUrlRow);

			// Actions
			const actionsRow = $('div.provider-card-actions');

			// Test connection
			const testBtn = $('button.provider-card-btn.provider-card-btn-secondary');
			testBtn.textContent = '测试连接';
			testBtn.onclick = () => this._testConnection(provider);
			actionsRow.appendChild(testBtn);

			// Clear
			if (isConfigured) {
				const clearBtn = $('button.provider-card-btn.provider-card-btn-danger');
				clearBtn.textContent = '清除';
				clearBtn.onclick = () => {
					this.configurationService.updateValue(provider.apiKeySetting, '');
					this.configurationService.updateValue(provider.baseUrlSetting, provider.defaultBaseUrl);
					this.expandedProviderId = provider.id;
					this._renderProviders();
				};
				actionsRow.appendChild(clearBtn);
			}

			cardBody.appendChild(actionsRow);
			card.appendChild(cardBody);

			// Toggle card body visibility
			cardHeader.onclick = () => {
				const isExpanded = card.classList.contains('provider-card-expanded');
				if (isExpanded) {
					card.classList.remove('provider-card-expanded');
					this.expandedProviderId = null;
				} else {
					// Collapse all other cards first (accordion behavior)
					for (const otherCard of this.listContainer.children) {
						otherCard.classList.remove('provider-card-expanded');
					}
					card.classList.add('provider-card-expanded');
					this.expandedProviderId = provider.id;
				}
			};

			// Restore expanded state from previous render
			if (this.expandedProviderId === provider.id) {
				card.classList.add('provider-card-expanded');
			}

			this.listContainer.appendChild(card);
		}
	}

	private _showAddProviderForm(): void {
		// Remove existing form if any
		const existingForm = this.listContainer.querySelector('.provider-add-form');
		if (existingForm) {
			existingForm.remove();
			return;
		}

		const formCard = $('div.provider-add-form');

		const formTitle = $('div.provider-add-form-title');
		formTitle.textContent = '添加自定义 Provider';
		formCard.appendChild(formTitle);

		const fields: { id: string; label: string; placeholder: string; required?: boolean }[] = [
			{ id: 'add-provider-id', label: 'Provider ID', placeholder: '如：my-provider', required: true },
			{ id: 'add-provider-name', label: '显示名称', placeholder: '如：My Provider', required: true },
			{ id: 'add-provider-baseurl', label: 'Base URL', placeholder: 'https://api.example.com/v1' },
			{ id: 'add-provider-desc', label: '描述', placeholder: '可选描述' },
		];

		for (const field of fields) {
			const row = $('div.provider-field');
			const label = $('label.provider-field-label');
			label.textContent = field.label;
			row.appendChild(label);

			const input = document.createElement('input');
			input.type = 'text';
			input.id = field.id;
			input.className = 'provider-field-input';
			input.placeholder = field.placeholder;
			if (field.required) {
				input.required = true;
			}
			row.appendChild(input);
			formCard.appendChild(row);
		}

		const actionsRow = $('div.provider-card-actions');

		const saveBtn = $('button.provider-card-btn.provider-card-btn-primary');
		saveBtn.textContent = '保存';
		saveBtn.onclick = () => {
			const idInput = document.getElementById('add-provider-id') as HTMLInputElement;
			const nameInput = document.getElementById('add-provider-name') as HTMLInputElement;
			const baseUrlInput = document.getElementById('add-provider-baseurl') as HTMLInputElement;
			const descInput = document.getElementById('add-provider-desc') as HTMLInputElement;

			const id = idInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
			const name = nameInput.value.trim();
			if (!id || !name) {
				this.statusMessage = '⚠️ 请填写 Provider ID 和名称';
				this._updateStatusMessage();
				return;
			}

			// Check for duplicates
			const allProviders = this._getAllProviders();
			if (allProviders.some(p => p.id === id)) {
				this.statusMessage = `⚠️ Provider "${id}" 已存在`;
				this._updateStatusMessage();
				return;
			}

			const customProviders = this.configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || [];
			customProviders.push({
				id,
				name,
				apiKey: '',
				baseUrl: baseUrlInput.value.trim(),
				description: descInput.value.trim(),
			});
			this.configurationService.updateValue(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING, customProviders);

			this.statusMessage = `✅ Provider "${name}" 已添加`;
			this._renderProviders();
			this._refreshDefaultProviderSelect();
			this._updateStatusMessage();
			setTimeout(() => {
				this.statusMessage = '';
				this._updateStatusMessage();
			}, 2000);
		};
		actionsRow.appendChild(saveBtn);

		const cancelBtn = $('button.provider-card-btn.provider-card-btn-secondary');
		cancelBtn.textContent = '取消';
		cancelBtn.onclick = () => {
			formCard.remove();
		};
		actionsRow.appendChild(cancelBtn);

		formCard.appendChild(actionsRow);
		this.listContainer.appendChild(formCard);
	}

	private _deleteCustomProvider(id: string): void {
		const customProviders = this.configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || [];
		const filtered = customProviders.filter(cp => cp.id !== id);
		this.configurationService.updateValue(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING, filtered);

		// Also clear any stored apiKey/baseUrl for this provider
		this.configurationService.updateValue(`sessions.agentStudio.provider.${id}.apiKey`, undefined);
		this.configurationService.updateValue(`sessions.agentStudio.provider.${id}.baseUrl`, undefined);

		this.statusMessage = `✅ Provider 已删除`;
		this._renderProviders();
		this._refreshDefaultProviderSelect();
		this._updateStatusMessage();
		setTimeout(() => {
			this.statusMessage = '';
			this._updateStatusMessage();
		}, 2000);
	}

	private _refreshDefaultProviderSelect(): void {
		while (this.defaultProviderSelect.firstChild) {
			this.defaultProviderSelect.removeChild(this.defaultProviderSelect.firstChild);
		}
		const allProviders = this._getAllProviders();
		const providerOptions = [
			{ value: 'auto', label: 'Auto（自动选择）' },
			...allProviders.map(p => ({ value: p.id, label: p.name })),
		];
		const currentProvider = this.configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_PROVIDER_SETTING) || 'auto';
		for (const opt of providerOptions) {
			const option = document.createElement('option');
			option.value = opt.value;
			option.textContent = opt.label;
			option.selected = opt.value === currentProvider;
			this.defaultProviderSelect.appendChild(option);
		}
	}

	private async _testConnection(provider: ProviderDefinition): Promise<void> {
		const apiKey = this.configurationService.getValue<string>(provider.apiKeySetting);
		const baseUrl = this.configurationService.getValue<string>(provider.baseUrlSetting) || provider.defaultBaseUrl;

		if (!baseUrl) {
			this.statusMessage = '❌ 请配置 Base URL';
			this._updateStatusMessage();
			return;
		}

		this.statusMessage = `🔄 正在测试 ${provider.name} 连接...`;
		this._updateStatusMessage();

		try {
			// Ollama uses /api/tags instead of /models
			const isOllama = provider.id === 'ollama';
			const testPath = isOllama ? '/api/tags' : '/models';
			const testUrl = `${baseUrl.replace(/\/$/, '')}${testPath}`;
			const headers: Record<string, string> = {};
			if (apiKey) {
				headers['Authorization'] = `Bearer ${apiKey}`;
			}

			const response = await fetch(testUrl, { method: 'GET', headers });
			if (response.ok) {
				this.statusMessage = `✅ ${provider.name} 连接成功！`;
			} else {
				const errorText = await response.text().catch(() => '');
				this.statusMessage = `❌ ${provider.name} 连接失败 (${response.status}): ${errorText.slice(0, 100)}`;
			}
		} catch (error) {
			this.statusMessage = `❌ ${provider.name} 连接失败: ${error}`;
		}

		this._updateStatusMessage();
		setTimeout(() => {
			this.statusMessage = '';
			this._updateStatusMessage();
		}, 5000);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			const listHeight = Math.max(0, height - 160);
			this.listContainer.style.height = `${listHeight}px`;
		}
	}
}
