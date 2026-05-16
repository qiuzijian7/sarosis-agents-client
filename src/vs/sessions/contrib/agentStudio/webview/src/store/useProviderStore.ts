/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Provider Store (Zustand)
 *  Manages available Model Providers fetched from the Host via postMessage RPC.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest, postMessage } from '../bridge/messageClient';

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

			// 如果还没有选择，且有已认证的 Provider，自动选中第一个
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

		// Notify host to persist the selection
		postMessage('providers.select', { providerId, modelId, agentId });
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
