/*---------------------------------------------------------------------------------------------
 *  useConfigHtmlStore — UI state for the ConfigHtml panel (per-agent local state).
 *  Holds the rendered HTML + version + load status. No Markdown source is tracked.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';

export type ConfigHtmlView = 'preview' | 'source';

interface AgentConfigHtmlState {
	loaded: boolean;
	loading: boolean;
	error?: string;
	html: string;
	version: number;
	view: ConfigHtmlView;
}

interface ConfigHtmlStore {
	byAgent: Record<string, AgentConfigHtmlState>;
	visible: Record<string, boolean>;

	getAgentState: (agentId: string) => AgentConfigHtmlState;
	setVisible: (agentId: string, v: boolean) => void;
	isVisible: (agentId: string) => boolean;

	setView: (agentId: string, view: ConfigHtmlView) => void;
	setLoading: (agentId: string, loading: boolean) => void;
	setError: (agentId: string, error?: string) => void;
	setState: (
		agentId: string,
		patch: Partial<Pick<AgentConfigHtmlState, 'html' | 'version' | 'loaded'>>,
	) => void;
	setHtmlLocal: (agentId: string, html: string) => void;
}

const defaultState: AgentConfigHtmlState = {
	loaded: false,
	loading: false,
	html: '',
	version: 0,
	view: 'preview',
};

export const useConfigHtmlStore = create<ConfigHtmlStore>((set, get) => ({
	byAgent: {},
	visible: {},

	getAgentState: (agentId) => get().byAgent[agentId] || defaultState,

	setVisible: (agentId, v) => set((s) => ({ visible: { ...s.visible, [agentId]: v } })),
	isVisible: (agentId) => get().visible[agentId] !== false,

	setView: (agentId, view) => set((s) => ({
		byAgent: {
			...s.byAgent,
			[agentId]: { ...(s.byAgent[agentId] || defaultState), view },
		},
	})),

	setLoading: (agentId, loading) => set((s) => ({
		byAgent: {
			...s.byAgent,
			[agentId]: { ...(s.byAgent[agentId] || defaultState), loading },
		},
	})),

	setError: (agentId, error) => set((s) => ({
		byAgent: {
			...s.byAgent,
			[agentId]: { ...(s.byAgent[agentId] || defaultState), error, loaded: !!error ? false : (s.byAgent[agentId]?.loaded ?? false) },
		},
	})),

	setState: (agentId, patch) => set((s) => ({
		byAgent: {
			...s.byAgent,
			[agentId]: { ...(s.byAgent[agentId] || defaultState), ...patch },
		},
	})),

	setHtmlLocal: (agentId, html) => set((s) => {
		const prev = s.byAgent[agentId] || defaultState;
		return {
			byAgent: {
				...s.byAgent,
				[agentId]: { ...prev, html },
			},
		};
	}),
}));
