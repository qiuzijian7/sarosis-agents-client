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
	AGENT_STUDIO_DEFAULT_PROVIDER_SETTING,
	AGENT_STUDIO_DEFAULT_MODEL_SETTING,
} from '../../common/constants.js';

// ─── Provider Definitions ────────────────────────────────────────────────────

interface ProviderDefinition {
	id: string;
	name: string;
	icon: string;
	apiKeySetting: string;
	baseUrlSetting: string;
	defaultBaseUrl: string;
	description: string;
}

const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
	{
		id: 'openrouter',
		name: 'OpenRouter',
		icon: '🔀',
		apiKeySetting: AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL,
		defaultBaseUrl: 'https://openrouter.ai/api/v1',
		description: 'Access multiple AI models through OpenRouter',
	},
	{
		id: 'nous',
		name: 'Nous',
		icon: '🧠',
		apiKeySetting: AGENT_STUDIO_PROVIDER_NOUS_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_NOUS_BASE_URL,
		defaultBaseUrl: 'https://api.nous.com/v1',
		description: 'Nous AI platform',
	},
	{
		id: 'gemini',
		name: 'Gemini',
		icon: '💎',
		apiKeySetting: AGENT_STUDIO_PROVIDER_GEMINI_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL,
		defaultBaseUrl: 'https://generativelanguage.googleapis.com',
		description: 'Google Gemini AI models',
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		icon: '🅰️',
		apiKeySetting: AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL,
		defaultBaseUrl: 'https://api.anthropic.com',
		description: 'Anthropic Claude models',
	},
	{
		id: 'main',
		name: 'Main',
		icon: '🏠',
		apiKeySetting: AGENT_STUDIO_PROVIDER_MAIN_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_MAIN_BASE_URL,
		defaultBaseUrl: '',
		description: 'Primary custom provider endpoint',
	},
	{
		id: 'custom',
		name: 'Custom',
		icon: '⚙️',
		apiKeySetting: AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY,
		baseUrlSetting: AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL,
		defaultBaseUrl: '',
		description: 'Custom OpenAI-compatible endpoint',
	},
];

// ─── Provider View ───────────────────────────────────────────────────────────

/**
 * Provider View - Provider 配置面板
 *
 * 功能：管理 AI Provider 的 API Key 和 Base URL 配置，
 * 显示各 Provider 的连接状态，支持快速切换默认 Provider。
 */
export class ProviderViewPane extends ViewPane {

	private listContainer!: HTMLElement;
	private defaultProviderSelect!: HTMLSelectElement;
	private defaultModelInput!: HTMLInputElement;
	private statusMessage: string = '';

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
		const providerOptions = [
			{ value: 'auto', label: 'Auto（自动选择）' },
			{ value: 'openrouter', label: 'OpenRouter' },
			{ value: 'nous', label: 'Nous' },
			{ value: 'gemini', label: 'Gemini' },
			{ value: 'anthropic', label: 'Anthropic' },
			{ value: 'main', label: 'Main' },
			{ value: 'knot', label: 'Knot' },
			{ value: 'custom', label: 'Custom' },
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

		// Status message
		if (this.statusMessage) {
			const statusEl = $('div.provider-status-message');
			statusEl.textContent = this.statusMessage;
			container.appendChild(statusEl);
		}
	}

	private _renderProviders(): void {
		// Clear children safely (Trusted Types policy blocks innerHTML)
		while (this.listContainer.firstChild) {
			this.listContainer.removeChild(this.listContainer.firstChild);
		}

		for (const provider of PROVIDER_DEFINITIONS) {
			const card = $('div.provider-card');
			const isConfigured = !!this.configurationService.getValue<string>(provider.apiKeySetting);
			if (isConfigured) {
				card.classList.add('configured-highlight');
			}

			// Card header
			const cardHeader = $('div.provider-card-header');

			const iconEl = $('span.provider-card-icon');
			iconEl.textContent = provider.icon;
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
				} else {
					// Collapse all other cards first (accordion behavior)
					for (const otherCard of this.listContainer.children) {
						otherCard.classList.remove('provider-card-expanded');
					}
					card.classList.add('provider-card-expanded');
				}
			};

			// Auto-expand if not configured, or if this is the default provider
			const defaultProvider = this.configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_PROVIDER_SETTING) || 'auto';
			if (!isConfigured || provider.id === defaultProvider) {
				card.classList.add('provider-card-expanded');
			}

			this.listContainer.appendChild(card);
		}
	}

	private async _testConnection(provider: ProviderDefinition): Promise<void> {
		const apiKey = this.configurationService.getValue<string>(provider.apiKeySetting);
		if (!apiKey) {
			this.statusMessage = '⚠️ 请先填写 API Key';
			this._renderProviders();
			return;
		}

		this.statusMessage = `🔄 正在测试 ${provider.name} 连接...`;
		this._renderProviders();

		try {
			const baseUrl = this.configurationService.getValue<string>(provider.baseUrlSetting) || provider.defaultBaseUrl;
			if (!baseUrl) {
				this.statusMessage = '❌ 请配置 Base URL';
				this._renderProviders();
				return;
			}

			const testUrl = `${baseUrl.replace(/\/$/, '')}/models`;
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			};

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

		this._renderProviders();
		setTimeout(() => {
			this.statusMessage = '';
			this._renderProviders();
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
