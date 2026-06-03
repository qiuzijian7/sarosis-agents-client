/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Provider Store (Zustand)
 *  Manages available Model Providers fetched from the Host via postMessage RPC.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest, postMessage } from '../bridge/messageClient';

// Lazy-loaded stores to avoid circular dependency
let _employeeStore: { getState: () => any; setState: (updater: any) => void } | null = null;
function getEmployeeStore() {
	if (!_employeeStore) {
		try {
			const mod = require('./useEmployeeStore');
			_employeeStore = mod.useEmployeeStore;
		} catch (err) {
			console.warn('[ProviderStore] Failed to load useEmployeeStore:', err);
			return null;
		}
	}
	return _employeeStore;
}

let _chatStore: { getState: () => any } | null = null;
function getChatStore() {
	if (!_chatStore) {
		try {
			const mod = require('./useChatStore');
			_chatStore = mod.useChatStore;
		} catch (err) {
			console.warn('[ProviderStore] Failed to load useChatStore:', err);
			return null;
		}
	}
	return _chatStore;
}

export interface ProviderModelInfo {
	id: string;
	name: string;
	descriptionZh?: string;    // 中文描述
	descriptionEn?: string;    // 英文描述
	maxInputTokens?: number;   // 最大输入 token 数
	maxOutputTokens?: number;  // 最大输出 token 数
	maxAllowedSize?: number;   // 最大上下文大小（input + output）
	supportsToolCall?: boolean; // 是否支持工具调用
	supportsImages?: boolean;  // 是否支持图片
	supportsReasoning?: boolean; // 是否支持推理/思考模式
	onlyReasoning?: boolean;   // 是否仅推理模式
	reasoningType?: 'budget-slider' | 'effort-slider' | false; // 推理 UI 形态（预算滑块 / 努力滑块）
	temperature?: number;      // 温度参数
	vendor?: string;           // 供应商
	credits?: string;          // Credits 信息
}

export interface ProviderAgentInfo {
	id: string;
	name: string;
	models?: string[];
}

export interface ProviderInfo {
	id: string;
	name: string;
	authStatus: string; // 'authenticated' | 'not-configured' | 'failed' | 'validating'
	supportsAgents?: boolean;
	models: ProviderModelInfo[];
	agents?: ProviderAgentInfo[];
}

interface ProviderSelection {
	providerId: string;
	providerName: string;
	modelId: string;
	agentId?: string;
}

/**
 * 单个模型的 thinking/reasoning 配置。
 * 按 `${providerId}::${modelId}` 维度持久化，切换模型时各自独立。
 */
export interface ReasoningConfig {
	/** 是否开启思考模式 */
	enabled: boolean;
	/** 思考预算（token 数），budget-slider 类模型使用 */
	budget?: number;
	/** 思考工作量等级，effort-slider 类模型使用 */
	effort?: 'low' | 'medium' | 'high';
}

// thinking 配置默认值（参考 void）
const DEFAULT_REASONING_BUDGET = 1024;   // void budget slider 默认 1024 tokens
const DEFAULT_REASONING_EFFORT: 'low' | 'medium' | 'high' = 'low';
const REASONING_STORAGE_KEY = 'agentStudio.reasoningConfig';

function loadReasoningConfigFromStorage(): Record<string, ReasoningConfig> {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(REASONING_STORAGE_KEY) : null;
		if (raw) {
			return JSON.parse(raw) as Record<string, ReasoningConfig>;
		}
	} catch (err) {
		console.warn('[ProviderStore] Failed to load reasoning config from storage:', err);
	}
	return {};
}

function saveReasoningConfigToStorage(map: Record<string, ReasoningConfig>): void {
	try {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(REASONING_STORAGE_KEY, JSON.stringify(map));
		}
	} catch (err) {
		console.warn('[ProviderStore] Failed to save reasoning config to storage:', err);
	}
}

function reasoningKey(providerId: string, modelId: string): string {
	return `${providerId}::${modelId}`;
}

interface ProviderState {
	providers: ProviderInfo[];
	selection: ProviderSelection | null;
	isLoading: boolean;
	/** 各模型的 thinking 配置，键为 `${providerId}::${modelId}` */
	reasoningConfig: Record<string, ReasoningConfig>;

	// Actions
	loadProviders: () => Promise<void>;
	loadSelectionForEmployee: (employeeId: string) => Promise<void>;
	selectProvider: (providerId: string, modelId: string, agentId?: string) => void;
	updateProviders: (providers: ProviderInfo[]) => void;
	openProviderSettings: (providerId?: string) => void;
	/** 设置当前选中模型的 thinking 配置（部分更新） */
	setReasoningConfig: (patch: Partial<ReasoningConfig>) => void;

	// Computed
	authenticatedProviders: () => ProviderInfo[];
	/** 当前选中模型的能力信息 */
	currentModelInfo: () => ProviderModelInfo | null;
	/** 当前选中模型的 thinking 配置（带默认值兜底） */
	currentReasoningConfig: () => ReasoningConfig | null;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
	providers: [],
	selection: null,
	isLoading: false,
	reasoningConfig: loadReasoningConfigFromStorage(),

	loadProviders: async () => {
		set({ isLoading: true });
		try {
			const providers = await sendRequest<unknown, ProviderInfo[]>(
				'providers.list',
				{}
			);
			set({ providers, isLoading: false });

		// Try to restore selection from the active employee's agent.yaml first,
		// then fall back to the global selection saved in settings.json
		const activeEmployeeId = getChatStore()?.getState()?.activeEmployeeId;
		console.log(`[ProviderStore] loadProviders: activeEmployeeId=${activeEmployeeId}`);

			try {
				let savedSelection: { providerId: string; modelId: string; agentId?: string } | null = null;

				if (activeEmployeeId) {
					// Prefer employee-specific selection from agent.yaml
					savedSelection = await sendRequest<{ employeeId: string }, { providerId: string; modelId: string; agentId?: string } | null>(
						'providers.getSelectionForEmployee',
						{ employeeId: activeEmployeeId }
					);
					console.log(`[ProviderStore] loadProviders: agent.yaml selection for ${activeEmployeeId}:`, savedSelection);
				}

				if (!savedSelection) {
					// Fall back to global selection
					savedSelection = await sendRequest<unknown, { providerId: string; modelId: string; agentId?: string } | null>(
						'providers.getSelection',
						{}
					);
					console.log('[ProviderStore] loadProviders: global selection fallback:', savedSelection);
				}

			if (savedSelection) {
				const provider = (providers || []).find(p => p.id === savedSelection!.providerId);
				// Tolerate transient non-authenticated states (e.g. 'validating'):
				// as long as the saved provider is REGISTERED, keep its selection.
				// `updateProviders` will keep this stable when the auth status
				// transitions, and `providers.changed` will catch us up.
				// We only fall back to auto-select if the saved provider has
				// truly disappeared from the host's registry.
				if (provider) {
					set({
						selection: {
							providerId: savedSelection.providerId,
							providerName: provider.name,
							modelId: savedSelection.modelId,
							agentId: savedSelection.agentId,
						},
					});
					// Sync restored selection to Host so AgentOSService._activeSelection
					// matches what the webview shows.
					postMessage('providers.select', {
						providerId: savedSelection.providerId,
						modelId: savedSelection.modelId,
						agentId: savedSelection.agentId,
						employeeId: activeEmployeeId || undefined,
					});
					console.log(
						`[ProviderStore] loadProviders: restored selection → ${savedSelection.providerId}/${savedSelection.modelId} ` +
						`(authStatus=${provider.authStatus})`,
					);
					return; // 成功恢复了保存的选择，不再自动选中
				}
				console.log(
					`[ProviderStore] loadProviders: saved provider '${savedSelection.providerId}' ` +
					`not registered — falling back to auto-select`,
				);
			}
			} catch {
				// ignore — fallback to auto-select below
			}

			// 如果没有保存的选择（或已不可用），自动选中第一个已认证的 Provider
			const { selection } = get();
			if (!selection) {
				const authenticated = (providers || []).filter(
					p => p.authStatus === 'authenticated'
				);
				if (authenticated.length > 0) {
					const first = authenticated[0];
					const firstModel = first.models[0];
					const firstAgent = first.agents?.[0];
					if (firstModel) {
						set({
							selection: {
								providerId: first.id,
								providerName: first.name,
								modelId: firstModel.id,
								agentId: firstAgent?.id,
							},
						});
						// Sync auto-selected provider to Host
						postMessage('providers.select', {
							providerId: first.id,
							modelId: firstModel.id,
							agentId: firstAgent?.id,
							employeeId: activeEmployeeId || undefined,
						});
						console.log(`[ProviderStore] loadProviders: auto-selected first authenticated → ${first.id}/${firstModel.id}`);
					}
				}
			}
		} catch (err) {
			console.error('[ProviderStore] Failed to load providers:', err);
			set({ isLoading: false });
		}
	},

	/**
	 * Load the provider/model selection for a specific employee from agent.yaml.
	 * Called when the active employee changes (after setActiveEmployee).
	 * This fixes the race condition where loadProviders() runs before
	 * activeEmployeeId is set, causing agent.yaml config to be missed.
	 *
	 * Resolution priority:
	 *   1. agent.yaml has a valid + authenticated provider → use it.
	 *   2. agent.yaml has provider but it's not authenticated / not found
	 *      → fall back to the first authenticated provider AND persist the
	 *        new selection back to agent.yaml so future opens are stable.
	 *   3. agent.yaml has no model section → same as (2).
	 */
	loadSelectionForEmployee: async (employeeId: string) => {
		const { providers } = get();
		if (!employeeId || providers.length === 0) {
			console.log(`[ProviderStore] loadSelectionForEmployee: skipped (employeeId=${employeeId}, providers=${providers.length})`);
			return;
		}

		console.log(`[ProviderStore] loadSelectionForEmployee: loading for ${employeeId}`);

		const applySelection = (
			providerId: string,
			providerName: string,
			modelId: string,
			agentId?: string,
		) => {
			set({ selection: { providerId, providerName, modelId, agentId } });
		};

		// Helper: pick the first authenticated provider and persist the choice
		const pickAndPersistFallback = (reason: string) => {
			const authenticated = providers.filter(p => p.authStatus === 'authenticated');
			if (authenticated.length === 0) {
				console.log(`[ProviderStore] loadSelectionForEmployee: ${reason}, but no authenticated provider available`);
				set({ selection: null });
				return;
			}
			const first = authenticated[0];
			const firstModel = first.models[0];
			const firstAgent = first.agents?.[0];
			if (!firstModel) {
				console.log(`[ProviderStore] loadSelectionForEmployee: ${reason}, first authenticated provider has no models`);
				return;
			}
			applySelection(first.id, first.name, firstModel.id, firstAgent?.id);
			console.log(`[ProviderStore] loadSelectionForEmployee: ${reason} → auto-picked ${first.id}/${firstModel.id} and persisting back to agent.yaml`);
			// Persist the auto-picked selection to agent.yaml so the chat bar
			// and canvas card stay in sync next time and don't drift to a
			// stale global fallback again.
			postMessage('providers.select', {
				providerId: first.id,
				modelId: firstModel.id,
				agentId: firstAgent?.id,
				employeeId,
			});
			// Also reflect on the employee card immediately
			getEmployeeStore()?.setState(state => ({
				employees: state.employees.map(e =>
					e.id === employeeId
						? { ...e, provider: first.id, model: firstModel.id }
						: e
				),
			}));
		};

		try {
			// Read the employee's agent.yaml model config
			const savedSelection = await sendRequest<{ employeeId: string }, { providerId: string; modelId: string; agentId?: string } | null>(
				'providers.getSelectionForEmployee',
				{ employeeId }
			);

			if (savedSelection && savedSelection.providerId && savedSelection.modelId) {
				const provider = providers.find(p => p.id === savedSelection.providerId);

				// ── Case A: provider is registered AND already authenticated ──
				if (provider && provider.authStatus === 'authenticated') {
					applySelection(
						savedSelection.providerId,
						provider.name,
						savedSelection.modelId,
						savedSelection.agentId,
					);
					console.log(`[ProviderStore] loadSelectionForEmployee: restored → ${savedSelection.providerId}/${savedSelection.modelId}` +
						(savedSelection.agentId ? ` [agent: ${savedSelection.agentId}]` : ''));

					// ── Critical: sync the restored selection back to the Host ──
					// Without this, only the webview local state is updated.
					// The Host's AgentOSService._activeSelection (which is what
					// `executeAgentTurn` actually uses to route chat requests)
					// would still hold the previous/global selection, causing
					// messages to be sent via the wrong provider (e.g. OpenRouter
					// instead of the employee's configured Knot provider).
					postMessage('providers.select', {
						providerId: savedSelection.providerId,
						modelId: savedSelection.modelId,
						agentId: savedSelection.agentId,
						employeeId,
					});

					return;
				}

				// ── Case B: provider IS registered but not yet authenticated ──
				// (e.g. it is still 'validating' during async initialisation, or
				// it briefly drops to 'failed' / 'not-configured' between events).
				// We MUST NOT fall back here, because:
				//   • the provider is real and configured;
				//   • a `providers.changed` event will arrive shortly with the
				//     final status — `updateProviders` already keeps a still-
				//     present provider's selection stable;
				//   • falling back would silently rewrite agent.yaml from
				//     (correct) Knot → (wrong) OpenRouter, and on the next
				//     reload the user would see OpenRouter even though their
				//     config was originally Knot.
				if (provider) {
					applySelection(
						savedSelection.providerId,
						provider.name,
						savedSelection.modelId,
						savedSelection.agentId,
					);
					console.log(
						`[ProviderStore] loadSelectionForEmployee: provider '${savedSelection.providerId}' ` +
						`registered but authStatus='${provider.authStatus}' — keeping selection, waiting for providers.changed.`,
					);
					// Optimistically sync to host as well; the host's chat path
					// will surface a clear error if the provider truly cannot
					// authenticate, instead of us silently switching providers.
					postMessage('providers.select', {
						providerId: savedSelection.providerId,
						modelId: savedSelection.modelId,
						agentId: savedSelection.agentId,
						employeeId,
					});
					return;
				}

				// ── Case C: provider in agent.yaml is unknown to the host ──
				// (the provider was uninstalled or its id changed). Only NOW
				// is it safe to fall back and rewrite agent.yaml.
				pickAndPersistFallback(
					`provider '${savedSelection.providerId}' from agent.yaml is not registered`
				);
				return;
			}

			// No valid model section in agent.yaml at all
			pickAndPersistFallback(`no valid model config in agent.yaml for ${employeeId}`);
		} catch (err) {
			console.warn(`[ProviderStore] loadSelectionForEmployee: failed for ${employeeId}`, err);
		}
	},

	selectProvider: (providerId: string, modelId: string, agentId?: string) => {
		const { providers } = get();
		const provider = providers.find(p => p.id === providerId);
		if (!provider) return;

		// Normalize modelId: strip knot-style prefix "knot/<uuid>::" → bare model name
		const bareModelId = modelId.includes('::') ? modelId.split('::').pop()! : modelId;

		set({
			selection: {
				providerId,
				providerName: provider.name,
				modelId: bareModelId,
				agentId,
			},
		});

		// Include the active employeeId so that the host can persist to agent.yaml
		const activeEmployeeId = getChatStore()?.getState()?.activeEmployeeId;

		// Notify host to persist the selection (both global + agent.yaml)
		postMessage('providers.select', { providerId, modelId, agentId, employeeId: activeEmployeeId });

		// Sync the active employee's model/provider fields so that
		// EmployeeCard and chat header update in real-time
		if (activeEmployeeId) {
			getEmployeeStore()?.setState(state => ({
				employees: state.employees.map(e =>
					e.id === activeEmployeeId
						? { ...e, provider: providerId, model: bareModelId }
						: e
				),
			}));
		}
	},

	openProviderSettings: (providerId?: string) => {
		// Ask the host to open provider-specific settings
		postMessage('providers.openSettings', { providerId });
	},

	updateProviders: (providers: ProviderInfo[]) => {
		const { selection } = get();
		set({ providers });

		// ── Guard: respect employee-level selection ──────────────────
		// When a providers.changed event fires (e.g. because a provider's
		// auth status transitions through 'validating' → 'authenticated'
		// during async initialisation), we must NOT blindly replace the
		// current employee-level selection with the "first authenticated
		// provider".  The previous code matched on
		//   `p.id === selection.providerId && p.authStatus === 'authenticated'`
		// which meant a temporarily-validating provider (like Knot during
		// startup) caused the selection to snap to OpenRouter.
		//
		// New policy:
		//   • If the selected provider STILL EXISTS in the new list
		//     (regardless of transient auth status) → keep the selection.
		//     It will become usable once validation completes.
		//   • If the selected provider has been REMOVED entirely from
		//     the list, or ALL providers lost authentication → fall back.
		//   • If there is no selection at all → auto-pick.

		if (selection) {
			const existsInList = providers.find(p => p.id === selection.providerId);
			if (existsInList) {
				// Provider still registered.  If its auth status changed to
				// authenticated and the providerName might have updated, patch
				// the selection's display name but keep the same provider/model.
				if (existsInList.authStatus === 'authenticated' && existsInList.name !== selection.providerName) {
					set({
						selection: {
							...selection,
							providerName: existsInList.name,
						},
					});
				}
				// Otherwise do nothing — keep the current selection stable.
				console.log(`[ProviderStore] updateProviders: keeping selection ${selection.providerId}/${selection.modelId} (provider exists, authStatus=${existsInList.authStatus})`);
			} else {
				// Provider truly removed from the list → fall back
				console.log(`[ProviderStore] updateProviders: provider ${selection.providerId} removed from list, auto-selecting fallback`);
				const authenticated = providers.filter(p => p.authStatus === 'authenticated');
				if (authenticated.length > 0) {
					const first = authenticated[0];
					const firstModel = first.models[0];
					const firstAgent = first.agents?.[0];
					if (firstModel) {
						set({
							selection: {
								providerId: first.id,
								providerName: first.name,
								modelId: firstModel.id,
								agentId: firstAgent?.id,
							},
						});
					}
				} else {
					set({ selection: null });
				}
			}
		} else {
			// 没有选择，自动选第一个已认证的
			const authenticated = providers.filter(p => p.authStatus === 'authenticated');
			if (authenticated.length > 0) {
				const first = authenticated[0];
				const firstModel = first.models[0];
				const firstAgent = first.agents?.[0];
				if (firstModel) {
					set({
						selection: {
							providerId: first.id,
							providerName: first.name,
							modelId: firstModel.id,
							agentId: firstAgent?.id,
						},
					});
				}
			}
		}
	},

	authenticatedProviders: () => {
		const { providers } = get();
		return providers.filter(p => p.authStatus === 'authenticated');
	},

	currentModelInfo: () => {
		const { providers, selection } = get();
		if (!selection) {
			return null;
		}
		const provider = providers.find(p => p.id === selection.providerId);
		if (!provider) {
			return null;
		}
		const model = provider.models.find(m => m.id === selection.modelId) ?? null;
		// [VISION-DEBUG] node 3: webview store — resolved selected model capability
		console.log(
			`[VISION-DEBUG][store.currentModelInfo] sel=${selection.providerId}/${selection.modelId} ` +
			`found=${!!model} supportsImages=${model?.supportsImages} ` +
			`modelCount=${provider.models.length}`,
		);
		return model;
	},

	currentReasoningConfig: () => {
		const { selection, reasoningConfig } = get();
		if (!selection) {
			return null;
		}
		const model = get().currentModelInfo();
		// 模型不支持推理时返回 null（UI 不显示控件）
		const supportsReasoning = model?.supportsReasoning || model?.reasoningType;
		if (!supportsReasoning) {
			return null;
		}
		const key = reasoningKey(selection.providerId, selection.modelId);
		const saved = reasoningConfig[key];
		const isEffort = model?.reasoningType === 'effort-slider';
		// 兜底默认值：onlyReasoning 模型默认开启，否则默认关闭
		return {
			enabled: saved?.enabled ?? (model?.onlyReasoning ?? false),
			budget: saved?.budget ?? (isEffort ? undefined : DEFAULT_REASONING_BUDGET),
			effort: saved?.effort ?? (isEffort ? DEFAULT_REASONING_EFFORT : undefined),
		};
	},

	setReasoningConfig: (patch: Partial<ReasoningConfig>) => {
		const { selection, reasoningConfig } = get();
		if (!selection) {
			return;
		}
		const key = reasoningKey(selection.providerId, selection.modelId);
		const current = get().currentReasoningConfig() ?? { enabled: false };
		const next: ReasoningConfig = { ...current, ...patch };
		const updated = { ...reasoningConfig, [key]: next };
		set({ reasoningConfig: updated });
		saveReasoningConfigToStorage(updated);
	},
}));
