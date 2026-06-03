/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Swarm Store (Zustand)
 *  Mirrors the host ISwarmService: holds active swarm topologies (root → workers →
 *  verifier → synthesizer), receives `swarm.updated` push events, and exposes
 *  create/status/blackboard/cancel actions.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';

export type SwarmPhase =
	| 'planning'
	| 'running'
	| 'verifying'
	| 'synthesizing'
	| 'done'
	| 'cancelled'
	| 'failed'
	| 'interrupted';

export type SwarmWorkerStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export type SwarmWorkerRole = 'worker' | 'verifier' | 'synthesizer';

export interface SwarmWorkerState {
	readonly taskId: string;
	subAgentId?: string;
	readonly title: string;
	readonly role: SwarmWorkerRole;
	status: SwarmWorkerStatus;
	output?: string;
	error?: string;
}

export interface SwarmStatus {
	readonly swarmId: string;
	readonly rootTaskId: string;
	readonly title: string;
	readonly workspaceId?: string;
	phase: SwarmPhase;
	readonly workers: SwarmWorkerState[];
	verifier?: SwarmWorkerState;
	synthesizer?: SwarmWorkerState;
	finalOutput?: string;
	readonly createdAt: number;
	updatedAt: number;
}

export type BlackboardEntryType = 'progress' | 'result' | 'blocked' | 'insight';

export interface BlackboardEntry {
	readonly workerId: string;
	readonly workerTitle?: string;
	readonly timestamp: number;
	readonly content: string;
	readonly type: BlackboardEntryType;
}

export interface SwarmWorkerSpec {
	readonly profile?: string;
	readonly title: string;
	readonly body: string;
	readonly skills?: string[];
	readonly priority?: 'low' | 'medium' | 'high';
	readonly maxRuntimeSeconds?: number;
}

export interface SwarmCreateSpec {
	readonly title: string;
	readonly goal?: string;
	readonly workspaceId?: string;
	readonly parentTaskId?: string;
	readonly workers: SwarmWorkerSpec[];
	readonly enableVerifier?: boolean;
	readonly enableSynthesizer?: boolean;
}

interface SwarmState {
	/** swarmId → status snapshot */
	swarms: Record<string, SwarmStatus>;
	/** swarmId → blackboard entries (chronological) */
	blackboards: Record<string, BlackboardEntry[]>;
	isCreating: boolean;

	// Actions
	createSwarm: (spec: SwarmCreateSpec) => Promise<string | undefined>;
	loadSwarms: (workspaceId?: string) => Promise<void>;
	refreshStatus: (swarmId: string) => Promise<void>;
	loadBlackboard: (swarmId: string) => Promise<void>;
	cancelSwarm: (swarmId: string) => Promise<void>;

	// Event sink (called from index.tsx message router on `swarm.updated`)
	onUpdated: (status: SwarmStatus) => void;

	// Computed
	listSwarms: () => SwarmStatus[];
	getSwarm: (swarmId: string) => SwarmStatus | undefined;
	/** Find the swarm whose root/worker task matches the given board task id. */
	getSwarmForTask: (taskId: string) => SwarmStatus | undefined;
}

export const useSwarmStore = create<SwarmState>((set, get) => ({
	swarms: {},
	blackboards: {},
	isCreating: false,

	createSwarm: async (spec) => {
		set({ isCreating: true });
		try {
			const swarmId = await sendRequest<SwarmCreateSpec, string>('swarm.create', spec, 0);
			set({ isCreating: false });
			// Host fires `swarm.updated` immediately after topology is built;
			// proactively pull status as a fallback.
			if (swarmId) {
				void get().refreshStatus(swarmId);
			}
			return swarmId;
		} catch (err) {
			console.error('[SwarmStore] Failed to create swarm:', err);
			set({ isCreating: false });
			return undefined;
		}
	},

	loadSwarms: async (workspaceId?: string) => {
		try {
			const list = await sendRequest<{ workspaceId?: string }, SwarmStatus[]>(
				'swarm.list',
				{ workspaceId }
			);
			if (Array.isArray(list)) {
				set(state => {
					const next = { ...state.swarms };
					for (const s of list) { next[s.swarmId] = s; }
					return { swarms: next };
				});
			}
		} catch (err) {
			console.error('[SwarmStore] Failed to load swarms:', err);
		}
	},

	refreshStatus: async (swarmId: string) => {
		try {
			const status = await sendRequest<{ swarmId: string }, SwarmStatus | undefined>(
				'swarm.status',
				{ swarmId }
			);
			if (status) {
				set(state => ({ swarms: { ...state.swarms, [swarmId]: status } }));
			}
		} catch (err) {
			console.error('[SwarmStore] Failed to refresh swarm status:', err);
		}
	},

	loadBlackboard: async (swarmId: string) => {
		try {
			const entries = await sendRequest<{ swarmId: string }, BlackboardEntry[]>(
				'swarm.blackboard',
				{ swarmId }
			);
			set(state => ({
				blackboards: { ...state.blackboards, [swarmId]: Array.isArray(entries) ? entries : [] },
			}));
		} catch (err) {
			console.error('[SwarmStore] Failed to load blackboard:', err);
		}
	},

	cancelSwarm: async (swarmId: string) => {
		// Optimistic: mark cancelled locally; host pushes the confirmed snapshot.
		set(state => {
			const s = state.swarms[swarmId];
			if (!s) { return {}; }
			return { swarms: { ...state.swarms, [swarmId]: { ...s, phase: 'cancelled' as SwarmPhase } } };
		});
		try {
			await sendRequest<{ swarmId: string }, void>('swarm.cancel', { swarmId });
		} catch (err) {
			console.error('[SwarmStore] Failed to cancel swarm:', err);
		}
	},

	onUpdated: (status) => {
		if (!status || !status.swarmId) { return; }
		set(state => ({ swarms: { ...state.swarms, [status.swarmId]: status } }));
	},

	listSwarms: () => Object.values(get().swarms).sort((a, b) => b.createdAt - a.createdAt),

	getSwarm: (swarmId) => get().swarms[swarmId],

	getSwarmForTask: (taskId) => {
		for (const s of Object.values(get().swarms)) {
			if (s.rootTaskId === taskId) { return s; }
			if (s.workers.some(w => w.taskId === taskId)) { return s; }
			if (s.verifier?.taskId === taskId) { return s; }
			if (s.synthesizer?.taskId === taskId) { return s; }
		}
		return undefined;
	},
}));
