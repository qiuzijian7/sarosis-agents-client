/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Provider Store (Zustand)
 *  Manages available Model Providers fetched from the Host via postMessage RPC.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest, postMessage } from '../bridge/messageClient';
import { useEmployeeStore } from './useEmployeeStore';
import { useChatStore } from './useChatStore';

export interface ProviderModelInfo {
	id: string;
	name: string;
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

interface ProviderState {
	providers: ProviderInfo[];
	selection: ProviderSelection | null;
	isLoading: boolean;

	// Actions
	loadProviders: () => Promise<void>;
	selectProvider: (providerId: string, modelId: string, agentId?: string) => void;
	updateProviders: (providers: ProviderInfo[]) => void;
	openProviderSettings: (providerId?: string) => void;

	// Computed
	authenticatedProviders: () => ProviderInfo[];
}

export const useProviderStore = create<ProviderState>((set, get) => ({
	providers: [],
	selection: null,
	isLoading: false,

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
			const activeEmployeeId = useChatStore.getState().activeEmployeeId;
			try {
				let savedSelection: { providerId: string; modelId: string; agentId?: string } | null = null;

				if (activeEmployeeId) {
					// Prefer employee-specific selection from agent.yaml
					savedSelection = await sendRequest<{ employeeId: string }, { providerId: string; modelId: string; agentId?: string } | null>(
						'providers.getSelectionForEmployee',
						{ employeeId: activeEmployeeId }
					);
				}

				if (!savedSelection) {
					// Fall back to global selection
					savedSelection = await sendRequest<unknown, { providerId: string; modelId: string; agentId?: string } | null>(
						'providers.getSelection',
						{}
					);
				}

				if (savedSelection) {
					const provider = (providers || []).find(p => p.id === savedSelection!.providerId);
					if (provider && provider.authStatus === 'authenticated') {
						set({
							selection: {
								providerId: savedSelection.providerId,
								providerName: provider.name,
								modelId: savedSelection.modelId,
								agentId: savedSelection.agentId,
							},
						});
						return; // 成功恢复了保存的选择，不再自动选中
					}
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
					}
				}
			}
		} catch (err) {
			console.error('[ProviderStore] Failed to load providers:', err);
			set({ isLoading: false });
		}
	},

	selectProvider: (providerId: string, modelId: string, agentId?: string) => {
		const { providers } = get();
		const provider = providers.find(p => p.id === providerId);
		if (!provider) return;

		set({
			selection: {
				providerId,
				providerName: provider.name,
				modelId,
				agentId,
			},
		});

		// Include the active employeeId so that the host can persist to agent.yaml
		const activeEmployeeId = useChatStore.getState().activeEmployeeId;

		// Notify host to persist the selection (both global + agent.yaml)
		postMessage('providers.select', { providerId, modelId, agentId, employeeId: activeEmployeeId });

		// Sync the active employee's model/provider fields so that
		// EmployeeCard and chat header update in real-time
		if (activeEmployeeId) {
			useEmployeeStore.setState(state => ({
				employees: state.employees.map(e =>
					e.id === activeEmployeeId
						? { ...e, provider: provider.name, model: modelId }
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

		// 如果当前选中的 Provider 已不可用，或还没有选择，自动重选
		if (selection) {
			const still = providers.find(
				p => p.id === selection.providerId && p.authStatus === 'authenticated'
			);
			if (!still) {
				// 当前 Provider 已不可用，自动选择第一个已认证 Provider
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
}));
