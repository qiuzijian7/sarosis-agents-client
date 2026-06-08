/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Workspace Session Store (Zustand)
 *  Manages Root/Fork mode and session switching.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';
import { useWorkspaceStore } from './useWorkspaceStore';

// Lazy-loaded stores to avoid circular dependency
let _chatStore: { getState: () => any } | null = null;
function getChatStore() {
	if (!_chatStore) {
		try {
			const mod = require('./useChatStore');
			_chatStore = mod.useChatStore;
		} catch (err) {
			console.warn('[WorkspaceSessionStore] Failed to load useChatStore:', err);
			return null;
		}
	}
	return _chatStore;
}

let _agentStore: { getState: () => any; setState: (updater: any) => void } | null = null;
function getAgentStore() {
	if (!_agentStore) {
		try {
			const mod = require('./useAgentStore');
			_agentStore = mod.useAgentStore;
		} catch (err) {
			console.warn('[WorkspaceSessionStore] Failed to load useAgentStore:', err);
			return null;
		}
	}
	return _agentStore;
}

// ─── Types (mirroring host-side types for webview) ─────────────────────────

export type WorkspaceMode = 'root' | 'fork';
export type WorkspaceSessionSource = 'scheduled_task' | 'manual';
export type WorkspaceSessionStatus = 'pending' | 'running' | 'completed' | 'error' | 'archived';

export interface AgentSessionEntry {
	readonly agentId: string;
	readonly sessionId: string;
	readonly createdAt: string;
	updatedAt: string;
	messageCount: number;
	status: 'active' | 'idle' | 'completed' | 'error';
}

export interface WorkspaceSession {
	readonly id: string;
	readonly workspaceId: string;
	name: string;
	source: WorkspaceSessionSource;
	scheduledTaskId?: string;
	status: WorkspaceSessionStatus;
	agentSessions: AgentSessionEntry[];
	readonly snapshotAgentIds: string[];
	readonly createdAt: string;
	updatedAt: string;
	completedAt?: string;
	error?: string;
}

// ─── Store Interface ───────────────────────────────────────────────────────

interface WorkspaceSessionState {
	/** All Fork sessions for the current workspace */
	sessions: WorkspaceSession[];
	/** Currently active Fork session ID, null = Root mode */
	activeSessionId: string | null;
	/** Current mode (derived from activeSessionId) */
	mode: WorkspaceMode;
	/** Loading state */
	isLoading: boolean;
	/** Stream generation counter — incremented on every session switch to discard stale deltas */
	streamGeneration: number;

	// ─── Actions ───
	loadSessions: (workspaceId: string) => Promise<void>;
	createFork: (params: {
		workspaceId: string;
		name: string;
		source: WorkspaceSessionSource;
		scheduledTaskId?: string;
	}) => Promise<WorkspaceSession | null>;
	switchToSession: (sessionId: string) => Promise<void>;
	switchToRoot: () => Promise<void>;
	updateSessionStatus: (sessionId: string, status: WorkspaceSessionStatus, error?: string) => Promise<void>;
	deleteSession: (sessionId: string) => Promise<void>;
	archiveSession: (sessionId: string) => Promise<void>;

	// ─── Agent Session helpers ───
	getAgentSessionId: (agentId: string) => string | null;
	getActiveAgentSessions: () => AgentSessionEntry[];
	getActiveSession: () => WorkspaceSession | null;
}

// ─── Store ─────────────────────────────────────────────────────────────────

export const useWorkspaceSessionStore = create<WorkspaceSessionState>((set, get) => ({
	sessions: [],
	activeSessionId: null,
	mode: 'root',
	isLoading: false,
	streamGeneration: 0,

	loadSessions: async (workspaceId: string) => {
		set({ isLoading: true });
		try {
			const sessions = await sendRequest<{ workspaceId: string }, WorkspaceSession[]>(
				'workspaceSession.list',
				{ workspaceId },
			);
			set({ sessions: sessions || [], isLoading: false });
		} catch (err) {
			console.error('[WorkspaceSessionStore] Failed to load sessions:', err);
			set({ isLoading: false });
		}
	},

	createFork: async (params) => {
		try {
			const session = await sendRequest<any, WorkspaceSession>(
				'workspaceSession.create',
				params,
			);
			if (session) {
				set(state => ({ sessions: [session, ...state.sessions] }));
			}
			return session || null;
		} catch (err) {
			console.error('[WorkspaceSessionStore] Failed to create fork:', err);
			return null;
		}
	},

	switchToSession: async (sessionId: string) => {
		const { sessions } = get();
		const session = sessions.find(s => s.id === sessionId);
		if (!session) {
			console.warn(`[WorkspaceSessionStore] Session ${sessionId} not found`);
			return;
		}

		// Cancel any active stream before switching
		getChatStore()?.getState()?.cancelStream();

		// Increment generation to discard stale deltas
		set(state => ({
			activeSessionId: sessionId,
			mode: 'fork',
			streamGeneration: state.streamGeneration + 1,
		}));

		// Set workspace to read-only
		useWorkspaceStore.getState().setReadOnly(true);

		// Notify host
		const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
		if (workspaceId) {
			await sendRequest('workspaceSession.switch', { workspaceId, sessionId }).catch(() => {});
		}

		// Reload chat for currently selected agent with fork's session
		const selectedId = getAgentStore()?.getState()?.selectedAgentId;
		if (selectedId) {
			const agentSessionId = get().getAgentSessionId(selectedId);
			getChatStore()?.getState()?.loadHistoryForSession(selectedId, agentSessionId ?? undefined);
		}
	},

	switchToRoot: async () => {
		// Cancel any active stream before switching
		getChatStore()?.getState()?.cancelStream();

		set(state => ({
			activeSessionId: null,
			mode: 'root',
			streamGeneration: state.streamGeneration + 1,
		}));

		// Restore canvas editing
		useWorkspaceStore.getState().setReadOnly(false);

		// Notify host
		const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
		if (workspaceId) {
			await sendRequest('workspaceSession.switchRoot', { workspaceId }).catch(() => {});
		}

		// Reload chat for currently selected agent (default session)
		const selectedId = getAgentStore()?.getState()?.selectedAgentId;
		if (selectedId) {
			getChatStore()?.getState()?.loadHistoryForSession(selectedId, undefined);
		}
	},

	updateSessionStatus: async (sessionId, status, error) => {
		const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
		if (!workspaceId) { return; }
		try {
			await sendRequest('workspaceSession.updateStatus', {
				workspaceId,
				sessionId,
				status,
				error,
			});
			set(state => ({
				sessions: state.sessions.map(s =>
					s.id === sessionId ? { ...s, status, error, updatedAt: new Date().toISOString() } : s,
				),
			}));
		} catch (err) {
			console.error('[WorkspaceSessionStore] Failed to update status:', err);
		}
	},

	deleteSession: async (sessionId) => {
		const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
		if (!workspaceId) { return; }
		try {
			await sendRequest('workspaceSession.delete', { workspaceId, sessionId });
			set(state => {
				const sessions = state.sessions.filter(s => s.id !== sessionId);
				const activeSessionId = state.activeSessionId === sessionId ? null : state.activeSessionId;
				const mode = activeSessionId ? 'fork' : 'root';
				return { sessions, activeSessionId, mode };
			});
			// If we just deleted the active session, restore read-write
			if (get().activeSessionId === null) {
				useWorkspaceStore.getState().setReadOnly(false);
			}
		} catch (err) {
			console.error('[WorkspaceSessionStore] Failed to delete session:', err);
		}
	},

	archiveSession: async (sessionId) => {
		const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
		if (!workspaceId) { return; }
		try {
			await sendRequest('workspaceSession.archive', { workspaceId, sessionId });
			set(state => ({
				sessions: state.sessions.map(s =>
					s.id === sessionId ? { ...s, status: 'archived' as const } : s,
				),
			}));
		} catch (err) {
			console.error('[WorkspaceSessionStore] Failed to archive session:', err);
		}
	},

	getAgentSessionId: (agentId: string) => {
		const { activeSessionId, sessions } = get();
		if (!activeSessionId) { return null; }
		const session = sessions.find(s => s.id === activeSessionId);
		if (!session) { return null; }
		const entry = session.agentSessions.find(a => a.agentId === agentId);
		return entry?.sessionId ?? null;
	},

	getActiveAgentSessions: () => {
		const { activeSessionId, sessions } = get();
		if (!activeSessionId) { return []; }
		const session = sessions.find(s => s.id === activeSessionId);
		return session?.agentSessions || [];
	},

	getActiveSession: () => {
		const { activeSessionId, sessions } = get();
		if (!activeSessionId) { return null; }
		return sessions.find(s => s.id === activeSessionId) ?? null;
	},
}));
