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
import { PROVIDER_DEFINITIONS } from './views/providerView.js';
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
}

// ─── Main Render Function ───────────────────────────────────────

/**
 * Render the full Provider settings UI into the given container.
 * Returns a dispose function to clean up event listeners if needed.
 */
export function renderProviderSettings(
	container: HTMLElement,
	configurationService: IConfigurationService,
): () => void {
	const state: RendererState = {
		expandedProviderId: null,
		statusMessage: '',
		listContainer: null,
		statusMessageEl: null,
		defaultProviderSelect: null,
		defaultModelInput: null,
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
		const testPath = isOllama ? '/api/tags' : '/models';
		const testUrl = `${baseUrl.replace(/\/$/, '')}${testPath}`;
		const headers: Record<string, string> = {};
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}

		const response = await fetch(testUrl, { method: 'GET', headers });
		if (response.ok) {
			state.statusMessage = `✅ ${provider.name} 连接成功！`;
		} else {
			const errorText = await response.text().catch(() => '');
			state.statusMessage = `❌ ${provider.name} 连接失败 (${response.status}): ${errorText.slice(0, 100)}`;
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
