/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider Settings Renderer — 渲染 Provider 管理界面（供 SettingsEditorPane 和 ProviderViewPane 重用）
 *
 * 这个模块将 Provider 列表、添加/删除、测试连接等 UI 逻辑提取为纯函数，
 * 避免在 SettingsEditorPane 中重复 ProviderViewPane 的渲染代码。
 */

import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { $ } from '../../../../base/browser/dom.js';
import type { ProviderDefinition, CustomProviderData } from './views/providerView.js';
import { PROVIDER_DEFINITIONS, buildModelsUrl } from './views/providerView.js';
import type { IModelItemConfig } from '../common/providers.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { VSSAROS_LLM_CHANNEL, type IHttpRequestResult } from '../common/llmBridge.js';
import { fetchModelsDevCatalog, lookupModelsDev, mapModelsDevToConfig } from './modelsDevCatalog.js';
import {
	AGENT_STUDIO_DEFAULT_PROVIDER_SETTING,
	AGENT_STUDIO_DEFAULT_MODEL_SETTING,
} from '../common/constants.js';

// ─── Re-export types for convenience ─────────────────────────────

export type { ProviderDefinition, CustomProviderData };

// ─── Constants ─────────────────────────────────────────────────

const AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING = 'sessions.agentStudio.provider.customProviders';

// ─── Helper: read custom providers from configuration ─────────────────

function getCustomProviders(configurationService: IConfigurationService): CustomProviderData[] {
	return configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || [];
}

function getAllProviders(configurationService: IConfigurationService): ProviderDefinition[] {
	const customProviders = getCustomProviders(configurationService);
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

// ─── Helper: patch a single custom provider entry ─────────────

/**
 * 从 Provider 自带的 /models 端点拉取模型列表（仿 opencode 模型发现思路）。
 * - 模型端点统一 `{base}/v1/models`（base 已含 /vN 则 `{base}/models`，见 buildModelsUrl）
 * - OpenAI 兼容：`Authorization: Bearer {apiKey}`
 * - Anthropic 网关：`x-api-key + anthropic-version`
 * - 返回格式兼容 OpenAI `{data:[{id:"..."}]}` 与裸数组 `[{id:"..."}]`
 */
async function fetchModelsList(
	baseUrl: string,
	apiKey: string,
	apiType: 'openai' | 'anthropic',
	mainProcessService: IMainProcessService,
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
	const channel = mainProcessService.getChannel(VSSAROS_LLM_CHANNEL);
	const result = await channel.call<IHttpRequestResult>('httpRequest', { url, method: 'GET', headers });
	if (!result.ok) {
		throw new Error(`HTTP ${result.status} ${result.statusText}`);
	}
	const data = JSON.parse(result.body);
	// OpenAI 标准格式
	if (Array.isArray(data?.data)) {
		return data.data.map((m: any) => m.id || m.name).filter((s: unknown): s is string => typeof s === 'string' && !!s);
	}
	// 裸数组
	if (Array.isArray(data)) {
		return data.map((m: any) => typeof m === 'string' ? m : (m.id || m.name)).filter((s: unknown): s is string => typeof s === 'string' && !!s);
	}
	// 单个模型
	if (data?.id || data?.name) {
		return [data.id || data.name];
	}
	throw new Error('未识别的响应格式（期望 {data:[...]} 或 [...]）');
}

function patchCustomProvider(
	configurationService: IConfigurationService,
	id: string,
	patch: Partial<CustomProviderData>,
): void {
	const customProviders = getCustomProviders(configurationService);
	const idx = customProviders.findIndex(cp => cp.id === id);
	if (idx === -1) { return; }
	customProviders[idx] = { ...customProviders[idx], ...patch };
	configurationService.updateValue(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING, customProviders);
}

// ─── Renderer State (held per render call) ─────────────────────────

interface RendererState {
	expandedProviderId: string | null;
	statusMessage: string;
	listContainer: HTMLElement | null;
	statusMessageEl: HTMLElement | null;
	defaultProviderSelect: HTMLSelectElement | null;
	defaultModelInput: HTMLInputElement | null;
	mainProcessService: IMainProcessService;
}

// ─── Main Render Function ───────────────────────────────────────

/**
 * Render the full Provider settings UI into the given container.
 * Returns a dispose function to clean up event listeners if needed.
 */
export function renderProviderSettings(
	container: HTMLElement,
	configurationService: IConfigurationService,
	mainProcessService: IMainProcessService,
): () => void {
	const state: RendererState = {
		expandedProviderId: null,
		statusMessage: '',
		listContainer: null,
		statusMessageEl: null,
		defaultProviderSelect: null,
		defaultModelInput: null,
		mainProcessService,
	};

	// Clear container
	while (container.firstChild) {
		container.removeChild(container.firstChild);
	}

	container.classList.add('provider-view');

	// ─── Header ───────────────────────────────────────────────
	const header = $('div.provider-header');
	const title = $('h3.provider-title');
	title.textContent = '🔌 Providers';
	header.appendChild(title);
	container.appendChild(header);

	// ─── Default Provider & Model section ─────────────────────
	const defaultSection = $('div.provider-default-section');
	const defaultHeader = $('div.provider-default-header');
	defaultHeader.textContent = '默认配置';
	defaultSection.appendChild(defaultHeader);

	// Default Provider
	const providerRow = $('div.provider-default-row');
	const providerLabel = $('label.provider-default-label');
	providerLabel.textContent = '默认 Provider';
	providerRow.appendChild(providerLabel);

	state.defaultProviderSelect = document.createElement('select');
	state.defaultProviderSelect.className = 'provider-default-select';
	const currentProvider = configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_PROVIDER_SETTING) || 'auto';
	const allProviders = getAllProviders(configurationService);
	const providerOptions = [
		{ value: 'auto', label: 'Auto（自动选择）' },
		...allProviders.map(p => ({ value: p.id, label: p.name })),
	];
	for (const opt of providerOptions) {
		const option = document.createElement('option');
		option.value = opt.value;
		option.textContent = opt.label;
		option.selected = opt.value === currentProvider;
		state.defaultProviderSelect.appendChild(option);
	}
	state.defaultProviderSelect.oninput = () => {
		configurationService.updateValue(AGENT_STUDIO_DEFAULT_PROVIDER_SETTING, state.defaultProviderSelect!.value, ConfigurationTarget.USER);
	};
	providerRow.appendChild(state.defaultProviderSelect);
	defaultSection.appendChild(providerRow);

	// Default Model
	const modelRow = $('div.provider-default-row');
	const modelLabel = $('label.provider-default-label');
	modelLabel.textContent = '默认模型';
	modelRow.appendChild(modelLabel);

	state.defaultModelInput = document.createElement('input');
	state.defaultModelInput.type = 'text';
	state.defaultModelInput.className = 'provider-default-input';
	state.defaultModelInput.placeholder = '留空使用系统默认';
	const currentModel = configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_MODEL_SETTING) || '';
	state.defaultModelInput.value = currentModel;
	state.defaultModelInput.oninput = () => {
		configurationService.updateValue(AGENT_STUDIO_DEFAULT_MODEL_SETTING, state.defaultModelInput!.value, ConfigurationTarget.USER);
	};
	modelRow.appendChild(state.defaultModelInput);
	defaultSection.appendChild(modelRow);

	container.appendChild(defaultSection);

	// ─── Provider list ─────────────────────────────────────
	state.listContainer = $('div.provider-list');
	renderProviderList(state, configurationService);
	container.appendChild(state.listContainer);

	// ─── Add Provider button ─────────────────────────────
	const addBtnRow = $('div.provider-add-row');
	const addBtn = $('button.provider-add-btn');
	addBtn.textContent = '+ 添加 Provider';
	addBtn.onclick = () => showAddProviderForm(state, configurationService);
	addBtnRow.appendChild(addBtn);
	container.appendChild(addBtnRow);

	// ─── Status message ──────────────────────────────────
	state.statusMessageEl = $('div.provider-status-message');
	updateStatusMessage(state);
	container.appendChild(state.statusMessageEl);

	// 监听 customProviders 设置变化：任何入口（设置页表单 / 侧边栏 / 命令面板）添加或修改 provider，
	// 都会触发配置变更事件，自动重渲染当前列表，避免「添加后不显示」问题。
	const configListener = configurationService.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING)) {
			renderProviderList(state, configurationService);
			refreshDefaultProviderSelect(state, configurationService);
		}
	});

	// Return dispose function
	return () => {
		configListener.dispose();
	};
}

// ─── Provider List Rendering ──────────────────────────────

function renderProviderList(
	state: RendererState,
	configurationService: IConfigurationService,
): void {
	if (!state.listContainer) { return; }

	// Clear children safely
	while (state.listContainer.firstChild) {
		state.listContainer.removeChild(state.listContainer.firstChild);
	}

	for (const provider of getAllProviders(configurationService)) {
		const card = $('div.provider-card');
		const isApiKeyOptionalProvider = provider.id === 'ollama';
		const hasApiKey = !!configurationService.getValue<string>(provider.apiKeySetting);
		const hasBaseUrl = !!(configurationService.getValue<string>(provider.baseUrlSetting) || provider.defaultBaseUrl);
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
			const customEntry = getCustomProviders(configurationService).find(cp => cp.id === provider.id);
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
				deleteCustomProvider(provider.id, state, configurationService);
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
		apiKeyInput.value = configurationService.getValue<string>(provider.apiKeySetting) || '';
		const saveApiKey = () => {
			configurationService.updateValue(provider.apiKeySetting, apiKeyInput.value);
			state.expandedProviderId = provider.id;
			renderProviderList(state, configurationService);
		};
		apiKeyInput.onchange = saveApiKey;
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
		baseUrlInput.value = configurationService.getValue<string>(provider.baseUrlSetting) || '';
		const saveBaseUrl = () => {
			configurationService.updateValue(provider.baseUrlSetting, baseUrlInput.value);
		};
		baseUrlInput.oninput = saveBaseUrl;
		baseUrlInput.onblur = saveBaseUrl;
		baseUrlRow.appendChild(baseUrlInput);
		cardBody.appendChild(baseUrlRow);

		// ── 自定义 Provider 内联类型配置（Path B 增强：可直接编辑，无需删除重建） ──
		if (!provider.isBuiltin) {
			const cpEntry = getCustomProviders(configurationService).find(cp => cp.id === provider.id);
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
					patchCustomProvider(configurationService, provider.id, { apiType: typeSelect.value as 'openai' | 'anthropic' });
					state.expandedProviderId = provider.id;
					renderProviderList(state, configurationService);
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
						patchCustomProvider(configurationService, provider.id, { models });
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
						patchCustomProvider(configurationService, provider.id, { apiKeyHeader: headerSel.value as 'bearer' | 'x-api-key' });
						state.expandedProviderId = provider.id;
						renderProviderList(state, configurationService);
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
						patchCustomProvider(configurationService, provider.id, { anthropicVersion: verInput.value.trim() || '2023-06-01' });
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
						patchCustomProvider(configurationService, provider.id, v ? { chatEndpointPath: v } : { chatEndpointPath: undefined });
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
						patchCustomProvider(configurationService, provider.id, v ? { modelsEndpointPath: v } : { modelsEndpointPath: undefined });
					};
					mInput.onchange = saveM;
					mInput.onblur = saveM;
					mRow.appendChild(mInput);
					cardBody.appendChild(mRow);
				}

				// 模型清单（不弹窗，inline 在 cardBody）
				renderCardModelList(cardBody, provider, cpEntry, state, configurationService);
			}
		}

		// Actions
		const actionsRow = $('div.provider-card-actions');

		// Test connection
		const testBtn = $('button.provider-card-btn.provider-card-btn-secondary');
		testBtn.textContent = '测试连接';
		testBtn.onclick = () => testConnection(provider, state, configurationService);
		actionsRow.appendChild(testBtn);

		// Clear
		if (isConfigured) {
			const clearBtn = $('button.provider-card-btn.provider-card-btn-danger');
			clearBtn.textContent = '清除';
			clearBtn.onclick = () => {
				configurationService.updateValue(provider.apiKeySetting, '');
				configurationService.updateValue(provider.baseUrlSetting, provider.defaultBaseUrl);
				state.expandedProviderId = provider.id;
				renderProviderList(state, configurationService);
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
				state.expandedProviderId = null;
			} else {
				// Collapse all other cards first (accordion behavior)
				for (const otherCard of state.listContainer!.children) {
					otherCard.classList.remove('provider-card-expanded');
				}
				card.classList.add('provider-card-expanded');
				state.expandedProviderId = provider.id;
			}
		};

		// Restore expanded state from previous render
		if (state.expandedProviderId === provider.id) {
			card.classList.add('provider-card-expanded');
		}

		state.listContainer.appendChild(card);
	}
}

// ─── Add Provider Form ───────────────────────────────────

function showAddProviderForm(
	state: RendererState,
	configurationService: IConfigurationService,
): void {
	if (!state.listContainer) { return; }

	// Remove existing form if any
	const existingForm = state.listContainer.querySelector('.provider-add-form');
	if (existingForm) {
		existingForm.remove();
		return;
	}

	const formCard = $('div.provider-add-form');

	const formTitle = $('div.provider-add-form-title');
	formTitle.textContent = '添加自定义 Provider';
	formCard.appendChild(formTitle);

	const fields: { id: string; label: string; placeholder: string; required?: boolean }[] = [
		{ id: 'add-provider-id', label: 'Provider ID', placeholder: '如：grnexus', required: true },
		{ id: 'add-provider-name', label: '显示名称', placeholder: '如：grNexus', required: true },
		{ id: 'add-provider-baseurl', label: 'Base URL', placeholder: 'https://grnexus.woa.com', required: true },
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
			state.statusMessage = '⚠️ 请先填写 Base URL';
			updateStatusMessage(state);
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
			const models = await fetchModelsList(baseUrl, apiKey, apiType, state.mainProcessService);
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
				// 同步到"模型列表" textarea（id=add-provider-models）
				const modelsTa = document.getElementById('add-provider-models') as HTMLTextAreaElement;
				if (modelsTa) {
					modelsTa.value = selected.join('\n');
				}
				state.statusMessage = `✅ 已应用 ${selected.length} 个模型到表单`;
				updateStatusMessage(state);
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
			state.statusMessage = '⚠️ 请填写 Provider ID 和名称';
			updateStatusMessage(state);
			return;
		}

		// Check for duplicates
		const allProviders = getAllProviders(configurationService);
		if (allProviders.some(p => p.id === id)) {
			state.statusMessage = `⚠️ Provider "${id}" 已存在`;
			updateStatusMessage(state);
			return;
		}

		const apiType = typeSelect.value as 'openai' | 'anthropic';
		const customProviders = getCustomProviders(configurationService);
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
			configurationService.updateValue(`sessions.agentStudio.provider.${id}.apiKey`, apiKeyInput.value.trim());
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
		configurationService.updateValue(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING, customProviders);

		state.statusMessage = `✅ Provider "${name}" 已添加`;
		renderProviderList(state, configurationService);
		refreshDefaultProviderSelect(state, configurationService);
		updateStatusMessage(state);
		setTimeout(() => {
			state.statusMessage = '';
			updateStatusMessage(state);
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
	state.listContainer.appendChild(formCard);
}

// ─── Delete Custom Provider ──────────────────────────────

function deleteCustomProvider(
	id: string,
	state: RendererState,
	configurationService: IConfigurationService,
): void {
	const customProviders = getCustomProviders(configurationService);
	const filtered = customProviders.filter(cp => cp.id !== id);
	configurationService.updateValue(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING, filtered);

	// Also clear any stored apiKey/baseUrl for this provider
	configurationService.updateValue(`sessions.agentStudio.provider.${id}.apiKey`, undefined);
	configurationService.updateValue(`sessions.agentStudio.provider.${id}.baseUrl`, undefined);

	state.statusMessage = `✅ Provider 已删除`;
	renderProviderList(state, configurationService);
	refreshDefaultProviderSelect(state, configurationService);
	updateStatusMessage(state);
	setTimeout(() => {
		state.statusMessage = '';
		updateStatusMessage(state);
	}, 2000);
}

// ─── Refresh Default Provider Select ─────────────────────

function refreshDefaultProviderSelect(state: RendererState, configurationService: IConfigurationService): void {
	if (!state.defaultProviderSelect) { return; }

	while (state.defaultProviderSelect.firstChild) {
		state.defaultProviderSelect.removeChild(state.defaultProviderSelect.firstChild);
	}
	const allProviders = getAllProviders(configurationService);
	const providerOptions = [
		{ value: 'auto', label: 'Auto（自动选择）' },
		...allProviders.map(p => ({ value: p.id, label: p.name })),
	];
	const currentProvider = configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_PROVIDER_SETTING) || 'auto';
	for (const opt of providerOptions) {
		const option = document.createElement('option');
		option.value = opt.value;
		option.textContent = opt.label;
		option.selected = opt.value === currentProvider;
		state.defaultProviderSelect.appendChild(option);
	}
}

// ─── Test Connection ─────────────────────────────────────

/**
 * 卡片内嵌模型清单（不弹窗）。在 cardBody 中追加：
 * 标题 + 「重新拉取/全选/保存」按钮 + 复选框网格 + 提示。
 * 初始化用 cpEntry.models；点击「重新拉取」走主进程 IPC 拉取并合并已勾选；「保存」批量写回 cp.models。
 */
/**
 * 渲染模型清单区域（codebuddy-style 详情 UI）
 *
 * 每个模型展示为可展开的详情卡片，包含：
 * - 基本信息：模型 ID、显示名称、供应商
 * - Token 限制：最大输出/输入/上下文
 * - 能力开关：工具调用、图片、推理、优先级、默认模型
 * - 参数：温度、Top P/K、重复惩罚
 * - 推理配置：强度、轻量/推理模型 ID 关联
 * - 描述：中英文描述、标签、Credits
 * - "从 models.dev 补全" 按钮（自动填充已知模型参数）
 */
function renderCardModelList(
	cardBody: HTMLElement,
	provider: ProviderDefinition,
	cpEntry: CustomProviderData,
	state: RendererState,
	configurationService: IConfigurationService,
): void {
	const section = $('div.provider-card-model-section');

	// ── 描述文字（仿截图） ──
	const desc = $('div.provider-card-model-desc');
	desc.textContent = '可用模型列表。每个模型包含完整的配置信息：\'id\': 模型 ID（如 \'gpt-5.5\'） - \'name\': 显示名称（如 \'GPT-5.5\'） - \'Vendor\': 供应商（如 \'OpenAI\'） - \'maxOutputTokens\': 最大输出 Token 数 - \'maxInputTokens\': 最大输入 Token 数 - supportsToolCall: 是否支持工具调用 - supportsImages: 是否支持图片 - maxAllowedSize: 最大上下文大小（input + output） - temperature: 温度参数 - supportsReasoning: 是否支持推理 - reasoning: 推理配置（包含 effort 字段） - onlyReasoning: 是否仅推理 - descriptionEn: 英文描述 - descriptionZh: 中文描述 - credits: 点击 [添加模型] 按钮添加新模型。';
	section.appendChild(desc);

	const header = $('div.provider-card-model-header');
	const title = $('span.provider-card-model-title');
	title.textContent = `Models`;
	header.appendChild(title);

	const actions = $('div.provider-card-model-actions');

	// 批量从 models.dev 补全按钮
	const devBatchBtn = document.createElement('button');
	devBatchBtn.className = 'provider-card-btn provider-card-btn-secondary';
	devBatchBtn.textContent = '🔍 从 models.dev 刷新';
	devBatchBtn.title = '批量查询 models.dev 目录，自动填充所有模型的已知参数';
	actions.appendChild(devBatchBtn);

	const fetchBtn = document.createElement('button');
	fetchBtn.className = 'provider-card-btn provider-card-btn-secondary';
	fetchBtn.textContent = '🔄 重新拉取';
	actions.appendChild(fetchBtn);

	const saveBtn = document.createElement('button');
	saveBtn.className = 'provider-card-btn provider-card-btn-primary';
	saveBtn.textContent = '✅ 保存配置';
	saveBtn.disabled = true;
	actions.appendChild(saveBtn);

	header.appendChild(actions);
	section.appendChild(header);

	// 模型列表容器（每个模型一个可展开的详情卡片）
	const listEl = $('div.provider-card-model-list');

	/** 当前所有模型的脏标记 */
	const dirtyFlags = new Map<string, boolean>();
	/** 收集所有模型配置 */
	const collectModelConfigs = (): Record<string, IModelItemConfig> => {
		const configs: Record<string, IModelItemConfig> = {};
		listEl.querySelectorAll<HTMLElement>(':scope > .model-detail-card').forEach(cardEl => {
			const mid = cardEl.getAttribute('data-model-id');
			if (!mid) return;
			configs[mid] = readModelConfigFromCard(cardEl, mid);
		});
		return configs;
	};

	/** 标记脏 */
	const markDirty = (modelId?: string) => {
		if (modelId) dirtyFlags.set(modelId, true);
		saveBtn.disabled = false;
	};

	/** 渲染单个模型详情卡片 */
	const renderModelCard = (modelId: string, config?: IModelItemConfig) => {
		const card = $('div.model-detail-card');
		card.setAttribute('data-model-id', modelId);

		// ── 卡片头部（模型 ID + 展开/折叠） ──
		const cardHeader = $('div.model-detail-header');
		const modelName = $('span.model-detail-name');
		modelName.textContent = config?.name || modelId;

		const toggleBtn = document.createElement('button');
		toggleBtn.className = 'model-detail-toggle';
		toggleBtn.textContent = '▶';
		toggleBtn.title = '展开/收起详情';

		const removeBtn = document.createElement('button');
		removeBtn.className = 'model-detail-remove';
		removeBtn.textContent = '✕';
		removeBtn.title = '移除此模型';

		cardHeader.appendChild(toggleBtn);
		cardHeader.appendChild(modelName);
		cardHeader.appendChild(removeBtn);
		card.appendChild(cardHeader);

		// ── 可展开的详情体 ──
		const cardBodyInner = $('div.model-detail-body');
		cardBodyInner.style.display = 'none';

		// 基本信息区
		const basicGroup = createFieldGroup('基本信息');
		basicGroup.appendChild(createTextField('模型 ID', 'model-id', modelId, true));
		basicGroup.appendChild(createTextField('显示名称', 'model-name', config?.name || ''));
		basicGroup.appendChild(createTextField('供应商', 'model-vendor', config?.vendor || ''));
		cardBodyInner.appendChild(basicGroup);

		// Token 区
		const tokenGroup = createFieldGroup('Token 限制');
		tokenGroup.appendChild(createNumberField('最大输出 Token', 'max-output-tokens', config?.maxOutputTokens));
		tokenGroup.appendChild(createNumberField('最大输入 Token', 'max-input-tokens', config?.maxInputTokens));
		tokenGroup.appendChild(createNumberField('最大上下文大小', 'max-context-size', config?.maxContextSize));
		cardBodyInner.appendChild(tokenGroup);

		// 能力开关区
		const capGroup = createFieldGroup('能力开关');
		capGroup.appendChild(createToggleField('支持工具调用', 'supports-tool-call', config?.supportsToolCall ?? true));
		capGroup.appendChild(createToggleField('支持图片', 'supports-images', config?.supportsImages ?? false));
		capGroup.appendChild(createToggleField('支持推理', 'supports-reasoning', config?.supportsReasoning ?? false));
		capGroup.appendChild(createToggleField('优先模型', 'priority', config?.priority ?? false));
		capGroup.appendChild(createToggleField('默认模型', 'is-default', config?.isDefault ?? false));
		capGroup.appendChild(createToggleField('支持图片参数', 'supports-image-params', config?.supportsImageParams ?? false));
		cardBodyInner.appendChild(capGroup);

		// 参数区
		const paramGroup = createFieldGroup('参数');
		paramGroup.appendChild(createNumberField('温度参数', 'temperature', config?.temperature, undefined, undefined, 3));
		paramGroup.appendChild(createNumberField('Top P', 'top-p', config?.topP, undefined, undefined, 2));
		paramGroup.appendChild(createNumberField('Top K', 'top-k', config?.topK));
		paramGroup.appendChild(createNumberField('重复惩罚', 'repeat-penalty', config?.repeatPenalty, undefined, undefined, 2));
		cardBodyInner.appendChild(paramGroup);

		// 推理配置区
		const reasonGroup = createFieldGroup('推理配置');
		reasonGroup.appendChild(createSelectField('推理强度', 'reasoning-effort', config?.reasoningEffort || '', ['auto', 'low', 'medium', 'high']));
		reasonGroup.appendChild(createTextField('推理需要', 'reasoning-required', config?.reasoningRequired || ''));
		reasonGroup.appendChild(createTextField('轻量模型 ID', 'lightweight-model-id', config?.lightweightModelId || ''));
		reasonGroup.appendChild(createTextField('关联的轻量模型 ID', 'associated-lightweight-model-id', config?.associatedLightweightModelId || ''));
		reasonGroup.appendChild(createTextField('推理模型 ID', 'reasoning-model-id', config?.reasoningModelId || ''));
		reasonGroup.appendChild(createTextField('关联的推理模型 ID', 'associated-reasoning-model-id', config?.associatedReasoningModelId || ''));
		reasonGroup.appendChild(createTextField('使用多态', 'use-polymorphic', config?.usePolymorphic || ''));
		cardBodyInner.appendChild(reasonGroup);

		// 描述区
		const descGroup = createFieldGroup('描述与元数据');
		descGroup.appendChild(createTextField('英文描述', 'description-en', config?.descriptionEn || '', true));
		descGroup.appendChild(createTextField('中文描述', 'description-zh', config?.descriptionZh || '', true));
		descGroup.appendChild(createTextField('Credits', 'credits', config?.credits || ''));
		descGroup.appendChild(createTextField('标签（逗号分隔）', 'tags', config?.tags || ''));
		cardBodyInner.appendChild(descGroup);

		// ── models.dev 补全按钮 ──
		const devRow = $('div.model-detail-row.model-dev-row');
		const devLabel = $('span.model-detail-label');
		devLabel.textContent = 'models.dev';
		const devBtn = document.createElement('button');
		devBtn.className = 'provider-card-btn provider-card-btn-secondary model-dev-fetch-btn';
		devBtn.textContent = '🔍 从 models.dev 补全参数';
		devBtn.title = '通过 models.dev API 自动填充该模型的已知参数';
		devRow.appendChild(devLabel);
		devRow.appendChild(devBtn);
		cardBodyInner.appendChild(devRow);

		// 绑定事件
		let expanded = false;
		toggleBtn.onclick = () => {
			expanded = !expanded;
			cardBodyInner.style.display = expanded ? '' : 'none';
			toggleBtn.textContent = expanded ? '▼' : '▶';
		};

		removeBtn.onclick = () => {
			if (confirm(`确认移除模型 "${modelId}"？`)) {
				card.remove();
				markDirty(modelId);
				title.textContent = `模型清单（${listEl.querySelectorAll(':scope > .model-detail-card').length} 个）`;
			}
		};

		// 所有 input 变更时标记脏
		cardBodyInner.querySelectorAll('input, textarea, select').forEach(el => {
			el.addEventListener('input', () => markDirty(modelId));
			el.addEventListener('change', () => markDirty(modelId));
		});

		// models.dev 补全
		devBtn.onclick = async () => {
			devBtn.disabled = true;
			const oldText = devBtn.textContent;
			devBtn.textContent = '⏳ 查询中...';
			try {
				const devConfig = await fetchFromModelsDev(modelId, state.mainProcessService);
				if (devConfig) {
					populateCardFromConfig(cardBodyInner, devConfig);
					markDirty(modelId);
					state.statusMessage = `✅ 已从 models.dev 补全 ${modelId}`;
				} else {
					state.statusMessage = `⚠️ models.dev 未找到 ${modelId}，请手动填写`;
				}
				updateStatusMessage(state);
				setTimeout(() => { state.statusMessage = ''; updateStatusMessage(state); }, 4000);
			} catch (err: any) {
				state.statusMessage = `❌ models.dev 查询失败：${err.message || String(err)}`;
				updateStatusMessage(state);
				setTimeout(() => { state.statusMessage = ''; updateStatusMessage(state); }, 6000);
			} finally {
				devBtn.disabled = false;
				devBtn.textContent = oldText;
			}
		};

		card.appendChild(cardBodyInner);
		return card;
	};

	// 初始渲染所有模型
	const renderList = (modelIds: string[]) => {
		listEl.replaceChildren();
		dirtyFlags.clear();
		const existingConfigs = cpEntry.modelConfigs || {};
		for (const m of modelIds) {
			listEl.appendChild(renderModelCard(m, existingConfigs[m]));
		}
		title.textContent = `模型清单（${modelIds.length} 个）`;
	};
	renderList(cpEntry.models || []);
	section.appendChild(listEl);

	// 提示
	const hint = $('div.provider-card-model-hint');
	hint.textContent = '💡 点击 ▶ 展开模型详情；点击 "从 models.dev 补全" 自动填充已知参数';
	section.appendChild(hint);

	cardBody.appendChild(section);

	// ── 批量从 models.dev 补全 ──
	devBatchBtn.onclick = async () => {
		devBatchBtn.disabled = true;
		const oldLabel = devBatchBtn.textContent;
		devBatchBtn.textContent = '⏳ 查询 models.dev...';
		try {
			const catalog = await fetchModelsDevCatalog(state.mainProcessService);
			let filled = 0;
			listEl.querySelectorAll<HTMLElement>(':scope > .model-detail-card').forEach(cardEl => {
				const mid = cardEl.getAttribute('data-model-id');
				if (!mid) return;
				const hit = lookupModelsDev(catalog, mid);
				if (!hit) return;
				const bodyInner = cardEl.querySelector<HTMLElement>(':scope > .model-detail-body');
				if (bodyInner) {
					populateCardFromConfig(bodyInner, mapModelsDevToConfig(hit.model, hit.providerName, mid));
					filled++;
				}
			});
			markDirty();
			state.statusMessage = `✅ 从 models.dev 批量补全了 ${filled} / ${listEl.querySelectorAll(':scope > .model-detail-card').length} 个模型`;
			updateStatusMessage(state);
			setTimeout(() => { state.statusMessage = ''; updateStatusMessage(state); }, 4000);
		} catch (err: any) {
			state.statusMessage = `❌ models.dev 批量查询失败：${err.message || String(err)}`;
			updateStatusMessage(state);
			setTimeout(() => { state.statusMessage = ''; updateStatusMessage(state); }, 6000);
		} finally {
			devBatchBtn.disabled = false;
			devBatchBtn.textContent = oldLabel;
		}
	};

	// ── 重新拉取 ──
	fetchBtn.onclick = async () => {
		const apiKey = configurationService.getValue<string>(provider.apiKeySetting);
		const baseUrl = configurationService.getValue<string>(provider.baseUrlSetting) || provider.defaultBaseUrl;
		const apiType = cpEntry.apiType || 'openai';
		if (!baseUrl) {
			state.statusMessage = '❌ 请先配置 Base URL';
			updateStatusMessage(state);
			return;
		}
		fetchBtn.disabled = true;
		const oldLabel = fetchBtn.textContent;
		fetchBtn.textContent = '⏳ 拉取中...';
		try {
			const fetched = await fetchModelsList(baseUrl, apiKey, apiType, state.mainProcessService);
			const existingIds = new Set(cpEntry.models || []);
			const added = fetched.filter(m => !existingIds.has(m));
			const merged = [...(cpEntry.models || []), ...added];
			renderList(merged);
			markDirty();
			state.statusMessage = `✅ 拉到 ${fetched.length} 个模型（新增 ${added.length}）`;
			updateStatusMessage(state);
			setTimeout(() => { state.statusMessage = ''; updateStatusMessage(state); }, 4000);
		} catch (err: any) {
			state.statusMessage = `❌ 拉取失败：${err.message || String(err)}`;
			updateStatusMessage(state);
			setTimeout(() => { state.statusMessage = ''; updateStatusMessage(state); }, 6000);
		} finally {
			fetchBtn.disabled = false;
			fetchBtn.textContent = oldLabel;
		}
	};

	// ── 保存 ──
	saveBtn.onclick = () => {
		const modelIds: string[] = [];
		listEl.querySelectorAll(':scope > .model-detail-card').forEach(cardEl => {
			const mid = cardEl.getAttribute('data-model-id');
			if (mid) modelIds.push(mid);
		});
		const configs = collectModelConfigs();
		patchCustomProvider(configurationService, provider.id, { models: modelIds, modelConfigs: configs });
		saveBtn.disabled = true;
		dirtyFlags.clear();
		state.statusMessage = `✅ 已保存 ${modelIds.length} 个模型配置`;
		updateStatusMessage(state);
		setTimeout(() => { state.statusMessage = ''; updateStatusMessage(state); }, 4000);
	};
}

// ════════════════════════════════════════════════════════════════════════
//  Model Detail Card 辅助函数（codebuddy-style 表单字段工厂）
// ════════════════════════════════════════════════════════════════════════

/** 创建字段分组标题 */
function createFieldGroup(label: string): HTMLElement {
	const group = $('div.model-field-group');
	const title = $('div.model-field-group-title');
	title.textContent = label;
	group.appendChild(title);
	return group;
}

/** 创建文本输入行 */
function createTextField(label: string, id: string, value: string, multiLine?: boolean): HTMLElement {
	const row = $('div.model-detail-row');
	const lbl = $('span.model-detail-label');
	lbl.textContent = label;
	row.appendChild(lbl);
	if (multiLine) {
		const ta = document.createElement('textarea');
		ta.className = 'model-detail-input model-detail-textarea';
		ta.id = id;
		ta.value = value;
		ta.rows = 2;
		row.appendChild(ta);
	} else {
		const inp = document.createElement('input');
		inp.type = 'text';
		inp.className = 'model-detail-input';
		inp.id = id;
		inp.value = value;
		row.appendChild(inp);
	}
	return row;
}

/** 创建数字输入行 */
function createNumberField(label: string, id: string, value?: number, min?: number, max?: number, step?: number): HTMLElement {
	const row = $('div.model-detail-row');
	const lbl = $('span.model-detail-label');
	lbl.textContent = label;
	row.appendChild(lbl);
	const inp = document.createElement('input');
	inp.type = 'number';
	inp.className = 'model-detail-input model-detail-number';
	inp.id = id;
	if (value !== undefined && value !== null) inp.value = String(value);
	if (min !== undefined) inp.min = String(min);
	if (max !== undefined) inp.max = String(max);
	if (step !== undefined) inp.step = String(step);
	row.appendChild(inp);
	return row;
}

/** 创建 Toggle 开关行 */
function createToggleField(label: string, id: string, checked?: boolean): HTMLElement {
	const row = $('div.model-detail-row');
	const lbl = $('span.model-detail-label');
	lbl.textContent = label;
	row.appendChild(lbl);
	const wrap = $('span.model-toggle-wrap');
	const cb = document.createElement('input');
	cb.type = 'checkbox';
	cb.className = 'model-toggle-input';
	cb.id = id;
	cb.checked = !!checked;
	wrap.appendChild(cb);
	const slider = $('span.model-toggle-slider');
	wrap.appendChild(slider);
	row.appendChild(wrap);
	return row;
}

/** 创建 Select 下拉行 */
function createSelectField(label: string, id: string, value: string, options: string[]): HTMLElement {
	const row = $('div.model-detail-row');
	const lbl = $('span.model-detail-label');
	lbl.textContent = label;
	row.appendChild(lbl);
	const sel = document.createElement('select');
	sel.className = 'model-detail-input model-detail-select';
	sel.id = id;
	// 空选项
	const optEmpty = document.createElement('option');
	optEmpty.value = '';
	optEmpty.textContent = '—';
	sel.appendChild(optEmpty);
	for (const o of options) {
		const opt = document.createElement('option');
		opt.value = o;
		opt.textContent = o;
		if (o === value) opt.selected = true;
		sel.appendChild(opt);
	}
	row.appendChild(sel);
	return row;
}

/** 从卡片 DOM 读取模型配置 */
function readModelConfigFromCard(cardEl: HTMLElement, modelId: string): IModelItemConfig {
	const getVal = (id: string) => {
		const el = cardEl.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
		if (!el) return undefined;
		if (el.type === 'checkbox') return (el as HTMLInputElement).checked;
		if (el.type === 'number') {
			const v = el.value;
			return v === '' ? undefined : Number(v);
		}
		return el.value || undefined;
	};
	return {
		id: modelId,
		name: getVal('model-name') as string | undefined,
		vendor: getVal('model-vendor') as string | undefined,
		maxOutputTokens: getVal('max-output-tokens') as number | undefined,
		maxInputTokens: getVal('max-input-tokens') as number | undefined,
		maxContextSize: getVal('max-context-size') as number | undefined,
		supportsToolCall: getVal('supports-tool-call') as boolean | undefined,
		supportsImages: getVal('supports-images') as boolean | undefined,
		temperature: getVal('temperature') as number | undefined,
		supportsReasoning: getVal('supports-reasoning') as boolean | undefined,
		priority: getVal('priority') as boolean | undefined,
		reasoningEffort: getVal('reasoning-effort') as string | undefined,
		reasoningRequired: getVal('reasoning-required') as string | undefined,
		lightweightModelId: getVal('lightweight-model-id') as string | undefined,
		associatedLightweightModelId: getVal('associated-lightweight-model-id') as string | undefined,
		reasoningModelId: getVal('reasoning-model-id') as string | undefined,
		associatedReasoningModelId: getVal('associated-reasoning-model-id') as string | undefined,
		usePolymorphic: getVal('use-polymorphic') as string | undefined,
		descriptionEn: getVal('description-en') as string | undefined,
		descriptionZh: getVal('description-zh') as string | undefined,
		credits: getVal('credits') as string | undefined,
		tags: getVal('tags') as string | undefined,
		topP: getVal('top-p') as number | undefined,
		topK: getVal('top-k') as number | undefined,
		repeatPenalty: getVal('repeat-penalty') as number | undefined,
		isDefault: getVal('is-default') as boolean | undefined,
		supportsImageParams: getVal('supports-image-params') as boolean | undefined,
	};
}

/** 用 models.dev 返回的数据填充卡片表单 */
function populateCardFromConfig(cardBody: HTMLElement, config: IModelItemConfig): void {
	const setVal = (id: string, val: any) => {
		const el = cardBody.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
		if (!el) return;
		if (el.type === 'checkbox') {
			(el as HTMLInputElement).checked = !!val;
		} else if (el.type === 'number') {
			el.value = (val === undefined || val === null) ? '' : String(val);
		} else {
			el.value = val || '';
		}
	};
	setVal('model-name', config.name);
	setVal('model-vendor', config.vendor);
	setVal('max-output-tokens', config.maxOutputTokens);
	setVal('max-input-tokens', config.maxInputTokens);
	setVal('max-context-size', config.maxContextSize);
	setVal('supports-tool-call', config.supportsToolCall);
	setVal('supports-images', config.supportsImages);
	setVal('temperature', config.temperature);
	setVal('supports-reasoning', config.supportsReasoning);
	setVal('priority', config.priority);
	setVal('is-default', config.isDefault);
	setVal('supports-image-params', config.supportsImageParams);
	setVal('reasoning-effort', config.reasoningEffort);
	setVal('reasoning-required', config.reasoningRequired);
	setVal('lightweight-model-id', config.lightweightModelId);
	setVal('associated-lightweight-model-id', config.associatedLightweightModelId);
	setVal('reasoning-model-id', config.reasoningModelId);
	setVal('associated-reasoning-model-id', config.associatedReasoningModelId);
	setVal('use-polymorphic', config.usePolymorphic);
	setVal('description-en', config.descriptionEn);
	setVal('description-zh', config.descriptionZh);
	setVal('credits', config.credits);
	setVal('tags', config.tags);
	setVal('top-p', config.topP);
	setVal('top-k', config.topK);
	setVal('repeat-penalty', config.repeatPenalty);
}

/**
 * 从 models.dev 获取模型信息
 *
 * 使用方式（仿 opencode）：
 * 1. 通过 mainProcess IPC 拉取整份目录 https://models.opencode.ai/api.json（内存缓存 1h TTL）
 * 2. 本地按模型 id / name 查表，映射到 IModelItemConfig
 *
 * 数据源参考 opencode 实现（models.dev 自托管镜像）。
 */
async function fetchFromModelsDev(modelId: string, mainProcessService: IMainProcessService): Promise<IModelItemConfig | null> {
	try {
		const catalog = await fetchModelsDevCatalog(mainProcessService);
		const hit = lookupModelsDev(catalog, modelId);
		if (!hit) {
			return null;
		}
		return mapModelsDevToConfig(hit.model, hit.providerName, modelId);
	} catch {
		return null;
	}
}

async function testConnection(
	provider: ProviderDefinition,
	state: RendererState,
	configurationService: IConfigurationService,
): Promise<void> {
	const apiKey = configurationService.getValue<string>(provider.apiKeySetting);
	const baseUrl = configurationService.getValue<string>(provider.baseUrlSetting) || provider.defaultBaseUrl;

	if (!baseUrl) {
		state.statusMessage = '❌ 请配置 Base URL';
		updateStatusMessage(state);
		return Promise.resolve();
	}

	state.statusMessage = `🔄 正在测试 ${provider.name} 连接...`;
	updateStatusMessage(state);

	// Anthropic 原生网关无 /models 端点，跳过 HTTP 测试
	if (!provider.isBuiltin) {
		const cp = getCustomProviders(configurationService).find(c => c.id === provider.id);
		if (cp?.apiType === 'anthropic') {
			state.statusMessage = `✅ ${provider.name}：Anthropic 网关（静态模型列表，无需 /models 发现）`;
			updateStatusMessage(state);
			setTimeout(() => { state.statusMessage = ''; updateStatusMessage(state); }, 5000);
			return Promise.resolve();
		}
	}

	try {
		const isOllama = provider.id === 'ollama';
		// Ollama 走 /api/tags；其他（OpenAI 兼容）走 buildModelsUrl 智能补 /v1
		const testUrl = isOllama
			? `${baseUrl.replace(/\/+$/, '')}/api/tags`
			: buildModelsUrl(baseUrl);
		const headers: Record<string, string> = {};
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}

		// 经主进程 IPC 执行，绕过 renderer 的 CORS preflight 限制
		const channel = state.mainProcessService.getChannel(VSSAROS_LLM_CHANNEL);
		const result = await channel.call<IHttpRequestResult>('httpRequest', { url: testUrl, method: 'GET', headers });
		if (result.ok) {
			state.statusMessage = `✅ ${provider.name} 连接成功！`;
		} else {
			state.statusMessage = `❌ ${provider.name} 连接失败 (${result.status})：${result.statusText || ''}`;
		}
	} catch (error) {
		state.statusMessage = `❌ ${provider.name} 连接失败: ${error}`;
	}

	updateStatusMessage(state);
	setTimeout(() => {
		state.statusMessage = '';
		updateStatusMessage(state);
	}, 5000);

	return Promise.resolve();
}

// ─── Update Status Message ───────────────────────────────

function updateStatusMessage(state: RendererState): void {
	if (!state.statusMessageEl) { return; }
	state.statusMessageEl.textContent = state.statusMessage;
	state.statusMessageEl.style.display = state.statusMessage ? 'block' : 'none';
}
