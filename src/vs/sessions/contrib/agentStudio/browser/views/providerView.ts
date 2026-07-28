/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
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
	AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY,
	AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL,
	AGENT_STUDIO_DEFAULT_PROVIDER_SETTING,
	AGENT_STUDIO_DEFAULT_MODEL_SETTING,
} from '../../common/constants.js';

// ─── Provider Definitions ────────────────────────────────────────────────────

export interface ProviderDefinition {
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

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
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
];

const AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING = 'sessions.agentStudio.provider.customProviders';

export interface CustomProviderData {
	id: string;
	name: string;
	apiKey: string;
	baseUrl: string;
	description: string;
	/** API 形态：'openai'（默认，OpenAI 兼容 /chat/completions）或 'anthropic'（原生 /v1/messages 网关） */
	apiType?: 'openai' | 'anthropic';
	/** 自定义 chat 端点路径；anthropic 默认 'v1/messages'，openai 默认 'chat/completions' */
	chatEndpointPath?: string;
	/** 自定义 models 发现端点路径（可选） */
	modelsEndpointPath?: string;
	/** 静态模型列表（anthropic 网关通常无 /models 发现，需在此声明模型 id，逗号/换行分隔） */
	models?: string[];
	/** API Key 认证头：'bearer'（默认）或 'x-api-key'（原生 Anthropic 网关） */
	apiKeyHeader?: 'bearer' | 'x-api-key';
	/** Anthropic 版本头（默认 '2023-06-01'） */
	anthropicVersion?: string;
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
		// 使用 oninput 确保选择改变时立即保存
		this.defaultProviderSelect.oninput = () => {
			this.configurationService.updateValue(AGENT_STUDIO_DEFAULT_PROVIDER_SETTING, this.defaultProviderSelect.value, ConfigurationTarget.USER);
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
		// 使用 oninput 而不是 onchange，确保每次输入都能立即保存，避免关闭窗口时丢失
		this.defaultModelInput.oninput = () => {
			this.configurationService.updateValue(AGENT_STUDIO_DEFAULT_MODEL_SETTING, this.defaultModelInput.value, ConfigurationTarget.USER);
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

		// 监听 customProviders 设置变化：任何入口（设置页表单 / 侧边栏 / 命令面板）添加或修改 provider，
		// 都会触发配置变更事件，自动重渲染当前列表，避免「添加后不显示」问题。
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING)) {
				this._renderProviders();
				this._refreshDefaultProviderSelect();
			}
		}));
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
			// 自定义 provider 显示 API 类型徽章
			if (!provider.isBuiltin) {
				const customEntry = (this.configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || []).find(cp => cp.id === provider.id);
				if (customEntry) {
					const typeBadge = $('span.provider-card-type-badge');
					typeBadge.textContent = customEntry.apiType === 'anthropic' ? 'Anthropic 网关' : 'OpenAI 兼容';
					typeBadge.classList.add(customEntry.apiType === 'anthropic' ? 'anthropic' : 'openai');
					infoEl.appendChild(typeBadge);
				}
			}
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
		// 保存并重新渲染（更新"已配置"徽章）
		const saveApiKey = () => {
				this.configurationService.updateValue(provider.apiKeySetting, apiKeyInput.value);
				this.expandedProviderId = provider.id;
				this._renderProviders();
			};
		apiKeyInput.onchange = saveApiKey;
		// onblur 作为备份，确保失去焦点时保存
		apiKeyInput.onblur = saveApiKey;
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
		// 使用 oninput 实时保存，onblur 作为备份
		const saveBaseUrl = () => {
				this.configurationService.updateValue(provider.baseUrlSetting, baseUrlInput.value);
			};
		baseUrlInput.oninput = saveBaseUrl;
		baseUrlInput.onblur = saveBaseUrl;
		baseUrlRow.appendChild(baseUrlInput);
		cardBody.appendChild(baseUrlRow);

		// ── 自定义 Provider 内联类型配置（Path B 增强：可直接编辑，无需删除重建） ──
		if (!provider.isBuiltin) {
			const cpEntry = (this.configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || []).find(cp => cp.id === provider.id);
			if (cpEntry) {
				const currentApiType = cpEntry.apiType || 'openai';

				const advLabel = $('div.provider-advanced-label');
				advLabel.textContent = '高级配置';
				cardBody.appendChild(advLabel);

				// API 类型
				const typeRow = $('div.provider-field');
				const typeLabel = $('label.provider-field-label');
				typeLabel.textContent = 'API 类型';
				typeRow.appendChild(typeLabel);
				const typeSelect = document.createElement('select');
				typeSelect.className = 'provider-field-input';
				const oOpenai = document.createElement('option');
				oOpenai.value = 'openai'; oOpenai.textContent = 'OpenAI 兼容（/chat/completions）';
				const oAnthro = document.createElement('option');
				oAnthro.value = 'anthropic'; oAnthro.textContent = 'Anthropic 网关（/v1/messages 原生）';
				typeSelect.appendChild(oOpenai); typeSelect.appendChild(oAnthro);
				typeSelect.value = currentApiType;
				typeSelect.onchange = () => {
					this._patchCustomProvider(provider.id, { apiType: typeSelect.value as 'openai' | 'anthropic' });
					this.expandedProviderId = provider.id;
					this._renderProviders();
				};
				typeRow.appendChild(typeSelect);
				cardBody.appendChild(typeRow);

				if (currentApiType === 'anthropic') {
					// 模型列表
					const modelsRow = $('div.provider-field');
					const modelsLabel = $('label.provider-field-label');
					modelsLabel.textContent = '模型列表（每行一个 id）';
					modelsRow.appendChild(modelsLabel);
					const modelsTa = document.createElement('textarea');
					modelsTa.className = 'provider-field-input';
					modelsTa.rows = 3;
					modelsTa.placeholder = 'claude-sonnet-4-20250514\nclaude-3-7-sonnet-20250219';
					modelsTa.value = (cpEntry.models || []).join('\n');
					const saveModels = () => {
						const models = modelsTa.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
						this._patchCustomProvider(provider.id, { models });
					};
					modelsTa.onchange = saveModels;
					modelsTa.onblur = saveModels;
					modelsRow.appendChild(modelsTa);
					cardBody.appendChild(modelsRow);

					// 认证头
					const headerRow = $('div.provider-field');
					const headerLabel = $('label.provider-field-label');
					headerLabel.textContent = '认证头';
					headerRow.appendChild(headerLabel);
					const headerSel = document.createElement('select');
					headerSel.className = 'provider-field-input';
					const hXkey = document.createElement('option');
					hXkey.value = 'x-api-key'; hXkey.textContent = 'x-api-key + anthropic-version（原生）';
					const hBearer = document.createElement('option');
					hBearer.value = 'bearer'; hBearer.textContent = 'Authorization: Bearer';
					headerSel.appendChild(hXkey); headerSel.appendChild(hBearer);
					headerSel.value = cpEntry.apiKeyHeader || 'x-api-key';
					headerSel.onchange = () => {
						this._patchCustomProvider(provider.id, { apiKeyHeader: headerSel.value as 'bearer' | 'x-api-key' });
						this.expandedProviderId = provider.id;
						this._renderProviders();
					};
					headerRow.appendChild(headerSel);
					cardBody.appendChild(headerRow);

					// anthropic-version
					const verRow = $('div.provider-field');
					const verLabel = $('label.provider-field-label');
					verLabel.textContent = 'anthropic-version';
					verRow.appendChild(verLabel);
					const verInput = document.createElement('input');
					verInput.type = 'text';
					verInput.className = 'provider-field-input';
					verInput.value = cpEntry.anthropicVersion || '2023-06-01';
					const saveVer = () => {
						this._patchCustomProvider(provider.id, { anthropicVersion: verInput.value.trim() || '2023-06-01' });
					};
					verInput.onchange = saveVer;
					verInput.onblur = saveVer;
					verRow.appendChild(verInput);
					cardBody.appendChild(verRow);
				} else {
					// Chat 端点路径
					const chatRow = $('div.provider-field');
					const chatLabel = $('label.provider-field-label');
					chatLabel.textContent = 'Chat 端点路径';
					chatRow.appendChild(chatLabel);
					const chatInput = document.createElement('input');
					chatInput.type = 'text';
					chatInput.className = 'provider-field-input';
					chatInput.placeholder = 'chat/completions';
					chatInput.value = cpEntry.chatEndpointPath || '';
					const saveChat = () => {
						const v = chatInput.value.trim();
						this._patchCustomProvider(provider.id, v ? { chatEndpointPath: v } : { chatEndpointPath: undefined });
					};
					chatInput.onchange = saveChat;
					chatInput.onblur = saveChat;
					chatRow.appendChild(chatInput);
					cardBody.appendChild(chatRow);

					// 模型发现端点
					const mRow = $('div.provider-field');
					const mLabel = $('label.provider-field-label');
					mLabel.textContent = '模型发现端点（可选）';
					mRow.appendChild(mLabel);
					const mInput = document.createElement('input');
					mInput.type = 'text';
					mInput.className = 'provider-field-input';
					mInput.placeholder = '留空使用 /models';
					mInput.value = cpEntry.modelsEndpointPath || '';
					const saveM = () => {
						const v = mInput.value.trim();
						this._patchCustomProvider(provider.id, v ? { modelsEndpointPath: v } : { modelsEndpointPath: undefined });
					};
					mInput.onchange = saveM;
					mInput.onblur = saveM;
					mRow.appendChild(mInput);
					cardBody.appendChild(mRow);
				}
			}
		}

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

	private _patchCustomProvider(id: string, patch: Partial<CustomProviderData>): void {
		const customProviders = this.configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || [];
		const idx = customProviders.findIndex(cp => cp.id === id);
		if (idx === -1) {
			return;
		}
		customProviders[idx] = { ...customProviders[idx], ...patch };
		this.configurationService.updateValue(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING, customProviders);
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

		// ── 基础字段 ──
		const baseFields: { id: string; label: string; placeholder: string; required?: boolean }[] = [
			{ id: 'add-provider-id', label: 'Provider ID', placeholder: '如：grnexus', required: true },
			{ id: 'add-provider-name', label: '显示名称', placeholder: '如：grNexus', required: true },
			{ id: 'add-provider-baseurl', label: 'Base URL', placeholder: 'https://grnexus.woa.com', required: true },
			{ id: 'add-provider-desc', label: '描述', placeholder: '可选描述' },
		];

		for (const field of baseFields) {
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

		// API Key / Token
		{
			const row = $('div.provider-field');
			const label = $('label.provider-field-label');
			label.textContent = 'API Key / Token';
			row.appendChild(label);
			const input = document.createElement('input');
			input.type = 'password';
			input.id = 'add-provider-apikey';
			input.className = 'provider-field-input';
			input.placeholder = '粘贴 API Key（可选，也可创建后在卡片中填写）';
			row.appendChild(input);
			formCard.appendChild(row);
		}

		// ── API 类型选择 ──
		const typeRow = $('div.provider-field');
		const typeLabel = $('label.provider-field-label');
		typeLabel.textContent = 'API 类型';
		typeRow.appendChild(typeLabel);
		const typeSelect = document.createElement('select');
		typeSelect.id = 'add-provider-apitype';
		typeSelect.className = 'provider-field-input';
		const openaiOpt = document.createElement('option');
		openaiOpt.value = 'openai';
		openaiOpt.textContent = 'OpenAI 兼容（/chat/completions）';
		const anthropicOpt = document.createElement('option');
		anthropicOpt.value = 'anthropic';
		anthropicOpt.textContent = 'Anthropic 网关（/v1/messages 原生）';
		typeSelect.appendChild(openaiOpt);
		typeSelect.appendChild(anthropicOpt);
		typeRow.appendChild(typeSelect);
		formCard.appendChild(typeRow);

		// ── Anthropic 专属字段 ──
		const anthroFields = $('div.provider-add-anthro');
		anthroFields.style.display = 'none';
		{
			const row = $('div.provider-field');
			const label = $('label.provider-field-label');
			label.textContent = '模型列表（每行一个 id）';
			row.appendChild(label);
			const ta = document.createElement('textarea');
			ta.id = 'add-provider-models';
			ta.className = 'provider-field-input';
			ta.placeholder = 'claude-sonnet-4-20250514\nclaude-3-7-sonnet-20250219';
			ta.rows = 3;
			row.appendChild(ta);
			anthroFields.appendChild(row);
		}
		{
			const row = $('div.provider-field');
			const label = $('label.provider-field-label');
			label.textContent = '认证头';
			row.appendChild(label);
			const sel = document.createElement('select');
			sel.id = 'add-provider-apikeyheader';
			sel.className = 'provider-field-input';
			const xkey = document.createElement('option');
			xkey.value = 'x-api-key';
			xkey.textContent = 'x-api-key + anthropic-version（原生）';
			const bearer = document.createElement('option');
			bearer.value = 'bearer';
			bearer.textContent = 'Authorization: Bearer';
			sel.appendChild(xkey);
			sel.appendChild(bearer);
			row.appendChild(sel);
			anthroFields.appendChild(row);
		}
		{
			const row = $('div.provider-field');
			const label = $('label.provider-field-label');
			label.textContent = 'anthropic-version';
			row.appendChild(label);
			const input = document.createElement('input');
			input.type = 'text';
			input.id = 'add-provider-anthropicversion';
			input.className = 'provider-field-input';
			input.value = '2023-06-01';
			row.appendChild(input);
			anthroFields.appendChild(row);
		}
		formCard.appendChild(anthroFields);

		// ── OpenAI 专属字段 ──
		const openaiFields = $('div.provider-add-openai');
		{
			const row = $('div.provider-field');
			const label = $('label.provider-field-label');
			label.textContent = 'Chat 端点路径';
			row.appendChild(label);
			const input = document.createElement('input');
			input.type = 'text';
			input.id = 'add-provider-chatpath';
			input.className = 'provider-field-input';
			input.placeholder = 'chat/completions';
			row.appendChild(input);
			openaiFields.appendChild(row);
		}
		{
			const row = $('div.provider-field');
			const label = $('label.provider-field-label');
			label.textContent = '模型发现端点（可选）';
			row.appendChild(label);
			const input = document.createElement('input');
			input.type = 'text';
			input.id = 'add-provider-modelspath';
			input.className = 'provider-field-input';
			input.placeholder = '留空使用 /models';
			row.appendChild(input);
			openaiFields.appendChild(row);
		}
		formCard.appendChild(openaiFields);

		const toggleType = () => {
			const isAnthro = typeSelect.value === 'anthropic';
			anthroFields.style.display = isAnthro ? '' : 'none';
			openaiFields.style.display = isAnthro ? 'none' : '';
		};
		typeSelect.onchange = toggleType;
		toggleType();

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

			const apiType = typeSelect.value as 'openai' | 'anthropic';
			const customProviders = this.configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || [];
			const entry: CustomProviderData = {
				id,
				name,
				apiKey: '',
				baseUrl: baseUrlInput.value.trim(),
				description: descInput.value.trim(),
				apiType,
			};

			// 保存 API Key 到独立设置项
			const apiKeyInput = document.getElementById('add-provider-apikey') as HTMLInputElement;
			if (apiKeyInput?.value.trim()) {
				this.configurationService.updateValue(`sessions.agentStudio.provider.${id}.apiKey`, apiKeyInput.value.trim());
			}
			if (apiType === 'anthropic') {
				const modelsTa = document.getElementById('add-provider-models') as HTMLTextAreaElement;
				entry.models = modelsTa.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
				entry.apiKeyHeader = (document.getElementById('add-provider-apikeyheader') as HTMLSelectElement).value as 'bearer' | 'x-api-key';
				entry.anthropicVersion = (document.getElementById('add-provider-anthropicversion') as HTMLInputElement).value.trim() || '2023-06-01';
			} else {
				const chatPath = (document.getElementById('add-provider-chatpath') as HTMLInputElement).value.trim();
				const modelsPath = (document.getElementById('add-provider-modelspath') as HTMLInputElement).value.trim();
				if (chatPath) { entry.chatEndpointPath = chatPath; }
				if (modelsPath) { entry.modelsEndpointPath = modelsPath; }
			}
			customProviders.push(entry);
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

		// Anthropic 原生网关无 /models 端点，跳过 HTTP 测试
		if (!provider.isBuiltin) {
			const cp = (this.configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || []).find(c => c.id === provider.id);
			if (cp?.apiType === 'anthropic') {
				this.statusMessage = `✅ ${provider.name}：Anthropic 网关（静态模型列表，无需 /models 发现）`;
				this._updateStatusMessage();
				setTimeout(() => { this.statusMessage = ''; this._updateStatusMessage(); }, 5000);
				return;
			}
		}

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
