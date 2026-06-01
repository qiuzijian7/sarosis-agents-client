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
import { ProviderDefinition, CustomProviderData, PROVIDER_DEFINITIONS } from './views/providerView.js';
import {
	AGENT_STUDIO_DEFAULT_PROVIDER_SETTING,
	AGENT_STUDIO_DEFAULT_MODEL_SETTING,
} from '../common/constants.js';

// ─── Re-export types for convenience ─────────────────────────────

export { ProviderDefinition, CustomProviderData };

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

	// Return dispose function (no-op for now, but could clean up listeners)
	return () => {
		// Nothing to dispose in this simple implementation
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

		const customProviders = getCustomProviders(configurationService);
		customProviders.push({
			id,
			name,
			apiKey: '',
			baseUrl: baseUrlInput.value.trim(),
			description: descInput.value.trim(),
		});
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
