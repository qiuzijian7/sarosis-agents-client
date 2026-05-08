/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Delegation Store (Zustand)
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';

export interface Delegation {
	id: string;
	title: string;
	description?: string;
	assigneeId: string;
	assignerId?: string;
	workspaceId: string;
	status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	parentTaskId?: string;
	dependencies?: string[];
	result?: string;
	error?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

interface DelegationState {
	delegations: Delegation[];
	statusFilter: string | null;
	isLoading: boolean;

	// Actions
	loadDelegations: (workspaceId?: string) => Promise<void>;
	createDelegation: (data: Partial<Delegation>) => Promise<Delegation>;
	updateDelegation: (id: string, data: Partial<Delegation>) => Promise<void>;
	deleteDelegation: (id: string) => Promise<void>;
	executePlan: (goal: string, workspaceId: string) => Promise<void>;
	setStatusFilter: (status: string | null) => void;

	// Computed
	filteredDelegations: () => Delegation[];
}

export const useDelegationStore = create<DelegationState>((set, get) => ({
	delegations: [],
	statusFilter: null,
	isLoading: false,

	loadDelegations: async (workspaceId?: string) => {
		set({ isLoading: true });
		try {
			const delegations = await sendRequest<{ workspaceId?: string }, Delegation[]>(
				'delegation.list',
				{ workspaceId }
			);
			set({ delegations, isLoading: false });
		} catch (err) {
			console.error('[DelegationStore] Failed to load delegations:', err);
			set({ isLoading: false });
		}
	},

	createDelegation: async (data) => {
		const delegation = await sendRequest<Partial<Delegation>, Delegation>('delegation.create', data);
		set(state => ({ delegations: [...state.delegations, delegation] }));
		return delegation;
	},

	updateDelegation: async (id, data) => {
		await sendRequest('delegation.update', { id, ...data });
		set(state => ({
			delegations: state.delegations.map(d => d.id === id ? { ...d, ...data } : d),
		}));
	},

	deleteDelegation: async (id) => {
		await sendRequest('delegation.delete', { id });
		set(state => ({
			delegations: state.delegations.filter(d => d.id !== id),
		}));
	},

	executePlan: async (goal, workspaceId) => {
		set({ isLoading: true });
		try {
			const result = await sendRequest<{ goal: string; workspaceId: string }, { delegations: Delegation[]; summary: string }>(
				'delegation.autoPlan',
				{ goal, workspaceId }
			);
			set(state => ({
				delegations: [...state.delegations, ...result.delegations],
				isLoading: false,
			}));
		} catch (err) {
			console.error('[DelegationStore] Auto-plan failed:', err);
			set({ isLoading: false });
		}
	},

	setStatusFilter: (status) => set({ statusFilter: status }),

	filteredDelegations: () => {
		const { delegations, statusFilter } = get();
		if (!statusFilter) { return delegations; }
		return delegations.filter(d => d.status === statusFilter);
	},
}));
