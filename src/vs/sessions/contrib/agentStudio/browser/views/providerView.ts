/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { VSSAROS_LLM_CHANNEL, type IHttpRequestResult } from '../../common/llmBridge.js';
import type { IModelItemConfig } from '../../common/providers.js';
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
	/** Per-model 详细配置（codebuddy-style model item UI，key = model ID） */
	modelConfigs?: Record<string, IModelItemConfig>;
	/** API Key 认证头：'bearer'（默认）或 'x-api-key'（原生 Anthropic 网关） */
	apiKeyHeader?: 'bearer' | 'x-api-key';
	/** Anthropic 版本头（默认 '2023-06-01'） */
	anthropicVersion?: string;
	/**
	 * 文生图端点路径（可选，默认 'images/generations'）。
	 * OpenAI 兼容的 text→image 端点，例如 'v1/images/generations'。
	 * 某些网关/代理（如 chatgpt2api）的文生图路径与标准 OpenAI 不同，
	 * 需在此配置正确路径以避免 405 Method Not Allowed。
	 */
	imageGenEndpointPath?: string;
	/**
	 * 文生图 HTTP 方法（可选，默认 'POST'）。
	 * OpenAI 兼容服务器使用 POST；某些网关/代理可能期望其他方法（如 GET）。
	 */
	imageGenMethod?: 'POST' | 'GET';
}

// ─── Provider View ───────────────────────────────────────────────────────────

/**
 * 构建模型发现端点 URL。
 * grnexus 等网关的 API 挂在 `/v1/` 下（`GET {base}/v1/models`），
 * 而 base URL 常填根域名（不带 /v1）。若 base 已含 `/vN` 版本段则直接拼 `/models`，
 * 否则补 `/v1/models`。避免出现 `.../v1/v1/models` 或 `.../models`（缺版本段）。
 */
export function buildModelsUrl(baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, '');
	return /\/v\d+(\.\d+)*$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

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
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
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

					// 文生图端点路径（可选，默认 images/generations）
					const imgPathRow = $('div.provider-field');
					const imgPathLabel = $('label.provider-field-label');
					imgPathLabel.textContent = '文生图端点（可选）';
					imgPathRow.appendChild(imgPathLabel);
					const imgPathInput = document.createElement('input');
					imgPathInput.type = 'text';
					imgPathInput.className = 'provider-field-input';
					imgPathInput.placeholder = '留空使用 images/generations';
					imgPathInput.value = cpEntry.imageGenEndpointPath || '';
					const saveImgPath = () => {
						const v = imgPathInput.value.trim();
						this._patchCustomProvider(provider.id, v ? { imageGenEndpointPath: v } : { imageGenEndpointPath: undefined });
					};
					imgPathInput.onchange = saveImgPath;
					imgPathInput.onblur = saveImgPath;
					imgPathRow.appendChild(imgPathInput);
					cardBody.appendChild(imgPathRow);

					// 文生图 HTTP 方法（可选，默认 POST）
					const imgMethodRow = $('div.provider-field');
					const imgMethodLabel = $('label.provider-field-label');
					imgMethodLabel.textContent = '文生图方法（可选）';
					imgMethodRow.appendChild(imgMethodLabel);
					const imgMethodSel = document.createElement('select');
					imgMethodSel.className = 'provider-field-input';
					const optPost = document.createElement('option');
					optPost.value = 'POST';
					optPost.textContent = 'POST（标准）';
					const optGet = document.createElement('option');
					optGet.value = 'GET';
					optGet.textContent = 'GET';
					imgMethodSel.appendChild(optPost);
					imgMethodSel.appendChild(optGet);
					imgMethodSel.value = cpEntry.imageGenMethod || 'POST';
					const saveImgMethod = () => {
						const v = imgMethodSel.value as 'POST' | 'GET';
						this._patchCustomProvider(provider.id, { imageGenMethod: v });
					};
					imgMethodSel.onchange = saveImgMethod;
					imgMethodRow.appendChild(imgMethodSel);
					cardBody.appendChild(imgMethodRow);
				}

				// 模型清单（Path B 增强：不弹窗，直接在卡片内勾选）
				this._renderCardModelList(cardBody, provider, cpEntry);
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

	/**
	 * 从 Provider 自带的 /models 端点拉取模型列表（仿 opencode 模型发现思路）。
	 * 模型端点统一 `{base}/v1/models`（base 已含 /vN 则 `{base}/models`，见 buildModelsUrl）。
	 * - OpenAI 兼容：`Authorization: Bearer {apiKey}`
	 * - Anthropic 网关：`x-api-key + anthropic-version`
	 */
	private async _fetchModelsList(
		baseUrl: string,
		apiKey: string,
		apiType: 'openai' | 'anthropic',
	): Promise<string[]> {
		const url = buildModelsUrl(baseUrl);
		const headers: Record<string, string> = { 'Accept': 'application/json' };
		if (apiType === 'anthropic') {
			if (apiKey) { headers['x-api-key'] = apiKey; }
			headers['anthropic-version'] = '2023-06-01';
		} else {
			if (apiKey) { headers['Authorization'] = `Bearer ${apiKey}`; }
		}
		// 经主进程 IPC 执行，绕过 renderer 的 CORS preflight 限制
		const channel = this.mainProcessService.getChannel(VSSAROS_LLM_CHANNEL);
		const result = await channel.call<IHttpRequestResult>('httpRequest', { url, method: 'GET', headers });
		if (!result.ok) {
			throw new Error(`HTTP ${result.status} ${result.statusText}`);
		}
		const data = JSON.parse(result.body);
		if (Array.isArray(data?.data)) {
			return data.data.map((m: any) => m.id || m.name).filter((s: unknown): s is string => typeof s === 'string' && !!s);
		}
		if (Array.isArray(data)) {
			return data.map((m: any) => typeof m === 'string' ? m : (m.id || m.name)).filter((s: unknown): s is string => typeof s === 'string' && !!s);
		}
		if (data?.id || data?.name) {
			return [data.id || data.name];
		}
		throw new Error('未识别的响应格式（期望 {data:[...]} 或 [...]）');
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

		// ── 获取模型列表 ──
		const fetchRow = $('div.provider-field.provider-fetch-row');
		const fetchBtn = document.createElement('button');
		fetchBtn.type = 'button';
		fetchBtn.id = 'add-provider-fetch-models';
		fetchBtn.className = 'provider-fetch-btn';
		fetchBtn.textContent = '🔄 获取模型列表';
		const fetchHint = $('span.provider-fetch-hint');
		fetchHint.textContent = '自动探测模型端点（{baseUrl}/v1/models）';
		fetchRow.appendChild(fetchBtn);
		fetchRow.appendChild(fetchHint);
		formCard.appendChild(fetchRow);

		const fetchResults = $('div.provider-fetch-results');
		fetchResults.id = 'add-provider-fetch-results';
		fetchResults.style.display = 'none';
		formCard.appendChild(fetchResults);

		fetchBtn.onclick = async () => {
			const baseUrlEl = document.getElementById('add-provider-baseurl') as HTMLInputElement;
			const apiKeyEl = document.getElementById('add-provider-apikey') as HTMLInputElement;
			const apiTypeEl = document.getElementById('add-provider-apitype') as HTMLSelectElement;
			const baseUrl = baseUrlEl.value.trim().replace(/\/+$/, '');
			const apiKey = apiKeyEl.value.trim();
			const apiType = apiTypeEl.value as 'openai' | 'anthropic';

			if (!baseUrl) {
				this.statusMessage = '⚠️ 请先填写 Base URL';
				this._updateStatusMessage();
				return;
			}

			fetchBtn.disabled = true;
			fetchBtn.textContent = '⏳ 拉取中...';
			fetchResults.style.display = 'block';
			fetchResults.replaceChildren();
			const loadingMsg = $('div');
			loadingMsg.textContent = '正在请求模型列表...';
			fetchResults.appendChild(loadingMsg);

			try {
				const models = await this._fetchModelsList(baseUrl, apiKey, apiType);
				fetchResults.replaceChildren();
				if (models.length === 0) {
					const empty = $('div');
					empty.textContent = '未发现任何模型';
					empty.className = 'provider-fetch-empty';
					fetchResults.appendChild(empty);
					return;
				}

				const header = $('div.provider-fetch-header');
				header.textContent = `发现 ${models.length} 个模型（勾选要启用的）`;
				fetchResults.appendChild(header);

				const selectAll = document.createElement('input');
				selectAll.type = 'checkbox';
				selectAll.id = 'fetch-select-all';
				selectAll.checked = true;
				const selectAllLabel = $('label.provider-fetch-select-all');
				selectAllLabel.appendChild(selectAll);
				selectAllLabel.appendChild(document.createTextNode(' 全选 / 反选'));
				fetchResults.appendChild(selectAllLabel);

				const list = $('div.provider-fetch-list');
				const checkboxes: HTMLInputElement[] = [];
				for (const m of models) {
					const item = $('label.provider-fetch-item');
					const cb = document.createElement('input');
					cb.type = 'checkbox';
					cb.value = m;
					cb.checked = true;
					cb.id = `fetch-cb-${m.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
					const text = $('span');
					text.textContent = m;
					item.appendChild(cb);
					item.appendChild(text);
					list.appendChild(item);
					checkboxes.push(cb);
				}
				fetchResults.appendChild(list);

				selectAll.onchange = () => {
					const checked = selectAll.checked;
					checkboxes.forEach(cb => { cb.checked = checked; });
				};

				const applyBtn = document.createElement('button');
				applyBtn.type = 'button';
				applyBtn.className = 'provider-fetch-apply-btn';
				applyBtn.textContent = '✅ 应用选择';
				applyBtn.onclick = () => {
					const selected = checkboxes.filter(cb => cb.checked).map(cb => cb.value);
					const modelsTa = document.getElementById('add-provider-models') as HTMLTextAreaElement;
					if (modelsTa) {
						modelsTa.value = selected.join('\n');
					}
					this.statusMessage = `✅ 已应用 ${selected.length} 个模型到表单`;
					this._updateStatusMessage();
				};
				fetchResults.appendChild(applyBtn);
			} catch (err: any) {
				fetchResults.replaceChildren();
				const errMsg = $('div.provider-fetch-error');
				errMsg.textContent = `❌ 拉取失败：${err.message || String(err)}（可能是 CORS 拦截，请联系网关管理员或直接手动填写模型列表）`;
				fetchResults.appendChild(errMsg);
			} finally {
				fetchBtn.disabled = false;
				fetchBtn.textContent = '🔄 获取模型列表';
			}
		};

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
		{
			const row = $('div.provider-field');
			const label = $('label.provider-field-label');
			label.textContent = '文生图端点（可选）';
			row.appendChild(label);
			const input = document.createElement('input');
			input.type = 'text';
			input.id = 'add-provider-imagegenpath';
			input.className = 'provider-field-input';
			input.placeholder = '留空使用 images/generations';
			row.appendChild(input);
			openaiFields.appendChild(row);
		}
		{
			const row = $('div.provider-field');
			const label = $('label.provider-field-label');
			label.textContent = '文生图方法（可选）';
			row.appendChild(label);
			const sel = document.createElement('select');
			sel.id = 'add-provider-imagemethod';
			sel.className = 'provider-field-input';
			const optPost = document.createElement('option');
			optPost.value = 'POST';
			optPost.textContent = 'POST（标准）';
			const optGet = document.createElement('option');
			optGet.value = 'GET';
			optGet.textContent = 'GET';
			sel.appendChild(optPost);
			sel.appendChild(optGet);
			row.appendChild(sel);
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
				const imgGenPath = (document.getElementById('add-provider-imagegenpath') as HTMLInputElement)?.value?.trim();
				const imgGenMethod = (document.getElementById('add-providerimagemethod') as HTMLSelectElement)?.value as 'POST' | 'GET' | undefined;
				if (chatPath) { entry.chatEndpointPath = chatPath; }
				if (modelsPath) { entry.modelsEndpointPath = modelsPath; }
				if (imgGenPath) { entry.imageGenEndpointPath = imgGenPath; }
				if (imgGenMethod) { entry.imageGenMethod = imgGenMethod; }
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

	/**
	 * 渲染卡片内嵌模型清单区块（不弹窗，直接在 cardBody 内展示）。
	 * 首次渲染用 cpEntry.models 作为初始勾选；点击"重新拉取"从 {baseUrl}/v1/models 拉取，
	 * 拉到的模型与已勾选合并展示。点"保存"批量写回 cp.models（patch 模式保留其他字段）。
	 */
	private _renderCardModelList(
		cardBody: HTMLElement,
		provider: ProviderDefinition,
		cpEntry: CustomProviderData,
	): void {
		const section = $('div.provider-card-model-section');
		const header = $('div.provider-card-model-header');
		const title = $('span.provider-card-model-title');
		title.textContent = `模型清单（${cpEntry.models?.length ?? 0} 个）`;
		header.appendChild(title);

		const actions = $('div.provider-card-model-actions');

		const fetchBtn = document.createElement('button');
		fetchBtn.className = 'provider-card-btn provider-card-btn-secondary';
		fetchBtn.textContent = '🔄 重新拉取';
		actions.appendChild(fetchBtn);

		const selectAllCb = document.createElement('input');
		selectAllCb.type = 'checkbox';
		selectAllCb.checked = true;
		const selectAllLabel = $('label.provider-card-model-selectall');
		selectAllLabel.appendChild(selectAllCb);
		selectAllLabel.appendChild(document.createTextNode(' 全选'));
		actions.appendChild(selectAllLabel);

		const saveBtn = document.createElement('button');
		saveBtn.className = 'provider-card-btn provider-card-btn-primary';
		saveBtn.textContent = '✅ 保存';
		saveBtn.disabled = true;
		saveBtn.title = '勾选变更后启用';
		actions.appendChild(saveBtn);

		header.appendChild(actions);
		section.appendChild(header);

		const listEl = $('div.provider-card-model-list');
		const cbs: HTMLInputElement[] = [];
		const renderList = (modelIds: string[]) => {
			listEl.replaceChildren();
			cbs.length = 0;
			const selectedSet = new Set(cpEntry.models || []);
			for (const m of modelIds) {
				const item = $('label.provider-card-model-item');
				const cb = document.createElement('input');
				cb.type = 'checkbox';
				cb.value = m;
				cb.checked = selectedSet.has(m);
				cb.id = `cb-model-${provider.id}-${m.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
				const text = $('span');
				text.textContent = m;
				item.appendChild(cb);
				item.appendChild(text);
				listEl.appendChild(item);
				cbs.push(cb);
			}
			title.textContent = `模型清单（${modelIds.length} 个）`;
		};
		renderList(cpEntry.models || []);
		section.appendChild(listEl);

		const hint = $('div.provider-card-model-hint');
		hint.textContent = '💡 启动 app 时自动维护当前模型清单（仿 opencode models.dev）';
		section.appendChild(hint);

		cardBody.appendChild(section);

		const markDirty = () => {
			saveBtn.disabled = false;
			saveBtn.title = '';
		};
		for (const cb of cbs) {
			cb.onchange = markDirty;
		}
		selectAllCb.onchange = () => {
			const checked = selectAllCb.checked;
			cbs.forEach(cb => { cb.checked = checked; cb.dispatchEvent(new Event('change')); });
			if (cbs.length > 0) { markDirty(); }
		};

		fetchBtn.onclick = async () => {
			const apiKey = this.configurationService.getValue<string>(provider.apiKeySetting);
			const baseUrl = this.configurationService.getValue<string>(provider.baseUrlSetting) || provider.defaultBaseUrl;
			const apiType = cpEntry.apiType || 'openai';
			if (!baseUrl) {
				this.statusMessage = '❌ 请先配置 Base URL';
				this._updateStatusMessage();
				return;
			}
			fetchBtn.disabled = true;
			const oldLabel = fetchBtn.textContent;
			fetchBtn.textContent = '⏳ 拉取中...';
			try {
				const fetched = await this._fetchModelsList(baseUrl, apiKey, apiType);
				// 合并：fetched 在前，已勾选但不在 fetched 中的追加在最后
				const fetchedSet = new Set(fetched);
				const merged = [...fetched, ...(cpEntry.models || []).filter(m => !fetchedSet.has(m))];
				renderList(merged);
				// 全选回填
				for (const cb of cbs) { cb.checked = true; }
				markDirty();
				this.statusMessage = `✅ 拉到 ${fetched.length} 个模型`;
				this._updateStatusMessage();
				setTimeout(() => { this.statusMessage = ''; this._updateStatusMessage(); }, 4000);
			} catch (err: any) {
				this.statusMessage = `❌ 拉取失败：${err.message || String(err)}`;
				this._updateStatusMessage();
				setTimeout(() => { this.statusMessage = ''; this._updateStatusMessage(); }, 6000);
			} finally {
				fetchBtn.disabled = false;
				fetchBtn.textContent = oldLabel;
			}
		};

		saveBtn.onclick = () => {
			const selected = cbs.filter(cb => cb.checked).map(cb => cb.value);
			this._patchCustomProvider(provider.id, { models: selected });
			saveBtn.disabled = true;
			saveBtn.title = '已保存';
			this.statusMessage = `✅ 已保存 ${selected.length} 个模型`;
			this._updateStatusMessage();
			setTimeout(() => { this.statusMessage = ''; this._updateStatusMessage(); }, 4000);
		};
	}

/**
	 * 卡片内嵌模型清单区块（不弹窗）。渲染逻辑见 _renderCardModelList。
	 * 旧的 _refreshCardModels + _showModelPickerDialog 已替换为内嵌版本。
	 */

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
			// Ollama 走 /api/tags；其他（OpenAI 兼容）走 buildModelsUrl 智能补 /v1
			const isOllama = provider.id === 'ollama';
			const testUrl = isOllama
				? `${baseUrl.replace(/\/+$/, '')}/api/tags`
				: buildModelsUrl(baseUrl);
			const headers: Record<string, string> = {};
			if (apiKey) {
				headers['Authorization'] = `Bearer ${apiKey}`;
			}

			// 经主进程 IPC 执行，绕过 renderer 的 CORS preflight 限制
			const channel = this.mainProcessService.getChannel(VSSAROS_LLM_CHANNEL);
			const result = await channel.call<IHttpRequestResult>('httpRequest', { url: testUrl, method: 'GET', headers });
			if (result.ok) {
				this.statusMessage = `✅ ${provider.name} 连接成功！`;
			} else {
				this.statusMessage = `❌ ${provider.name} 连接失败 (${result.status})：${result.statusText || ''}`;
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
