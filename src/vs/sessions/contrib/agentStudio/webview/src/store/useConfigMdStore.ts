/*---------------------------------------------------------------------------------------------
 *  useConfigMdStore — UI state for the ConfigMD panel (per-agent local state).
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';

export type ConfigMdView = 'preview' | 'source' | 'split';

interface AgentConfigMdState {
	loaded: boolean;
	loading: boolean;
	error?: string;
	markdown: string;
	html: string;
	stylesContent?: string;
	version: number;
	view: ConfigMdView;
	dirty: boolean;          // local edits not yet flushed
	lastError?: string;
}

interface ConfigMdStore {
	byAgent: Record<string, AgentConfigMdState>;
	visible: Record<string, boolean>;

	getAgentState: (agentId: string) => AgentConfigMdState;
	setVisible: (agentId: string, v: boolean) => void;
	isVisible: (agentId: string) => boolean;

	setView: (agentId: string, view: ConfigMdView) => void;
	setLoading: (agentId: string, loading: boolean) => void;
	setError: (agentId: string, error?: string) => void;
	setState: (
		agentId: string,
		patch: Partial<Pick<AgentConfigMdState, 'markdown' | 'html' | 'stylesContent' | 'version' | 'loaded' | 'dirty'>>,
	) => void;
	updateMarkdownLocal: (agentId: string, markdown: string) => void;
}

const defaultState: AgentConfigMdState = {
	loaded: false,
	loading: false,
	markdown: '',
	html: '',
	version: 0,
	view: 'split',
	dirty: false,
};

export const useConfigMdStore = create<ConfigMdStore>((set, get) => ({
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
			[agentId]: { ...(s.byAgent[agentId] || defaultState), error, lastError: error },
		},
	})),

	setState: (agentId, patch) => set((s) => ({
		byAgent: {
			...s.byAgent,
			[agentId]: { ...(s.byAgent[agentId] || defaultState), ...patch },
		},
	})),

	updateMarkdownLocal: (agentId, markdown) => set((s) => {
		const prev = s.byAgent[agentId] || defaultState;
		return {
			byAgent: {
				...s.byAgent,
				[agentId]: { ...prev, markdown, dirty: true },
			},
		};
	}),
}));
