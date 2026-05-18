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

	getAgentState: (employeeId: string) => AgentConfigMdState;
	setVisible: (employeeId: string, v: boolean) => void;
	isVisible: (employeeId: string) => boolean;

	setView: (employeeId: string, view: ConfigMdView) => void;
	setLoading: (employeeId: string, loading: boolean) => void;
	setError: (employeeId: string, error?: string) => void;
	setState: (
		employeeId: string,
		patch: Partial<Pick<AgentConfigMdState, 'markdown' | 'html' | 'stylesContent' | 'version' | 'loaded' | 'dirty'>>,
	) => void;
	updateMarkdownLocal: (employeeId: string, markdown: string) => void;
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

	getAgentState: (employeeId) => get().byAgent[employeeId] || defaultState,

	setVisible: (employeeId, v) => set((s) => ({ visible: { ...s.visible, [employeeId]: v } })),
	isVisible: (employeeId) => get().visible[employeeId] !== false,

	setView: (employeeId, view) => set((s) => ({
		byAgent: {
			...s.byAgent,
			[employeeId]: { ...(s.byAgent[employeeId] || defaultState), view },
		},
	})),

	setLoading: (employeeId, loading) => set((s) => ({
		byAgent: {
			...s.byAgent,
			[employeeId]: { ...(s.byAgent[employeeId] || defaultState), loading },
		},
	})),

	setError: (employeeId, error) => set((s) => ({
		byAgent: {
			...s.byAgent,
			[employeeId]: { ...(s.byAgent[employeeId] || defaultState), error, lastError: error },
		},
	})),

	setState: (employeeId, patch) => set((s) => ({
		byAgent: {
			...s.byAgent,
			[employeeId]: { ...(s.byAgent[employeeId] || defaultState), ...patch },
		},
	})),

	updateMarkdownLocal: (employeeId, markdown) => set((s) => {
		const prev = s.byAgent[employeeId] || defaultState;
		return {
			byAgent: {
				...s.byAgent,
				[employeeId]: { ...prev, markdown, dirty: true },
			},
		};
	}),
}));
