/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Kanban Diagnostics Store (Zustand)
 *  Mirrors the host IKanbanDiagnosticsService: holds active diagnostics (alerts),
 *  receives push events, and exposes run/dismiss actions + remediation triggers.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';
import { useTaskBoardStore } from './useTaskBoardStore';

export type DiagnosticSeverity = 'warning' | 'error' | 'critical';

export type DiagnosticRule =
	| 'triage_not_actionable'
	| 'repeated_failures'
	| 'stuck_in_blocked'
	| 'stranded_in_ready';

export type DiagnosticActionType =
	| 'unblock'
	| 'reclaim'
	| 'specify'
	| 'decompose'
	| 'cancel'
	| 'dismiss';

export interface DiagnosticAction {
	readonly type: DiagnosticActionType;
	readonly taskId?: string;
}

export interface Diagnostic {
	readonly id: string;
	readonly kind: DiagnosticRule;
	readonly severity: DiagnosticSeverity;
	readonly title: string;
	readonly detail: string;
	readonly taskId?: string;
	readonly workspaceId?: string;
	readonly actions: DiagnosticAction[];
	readonly firstSeenAt: number;
	readonly lastSeenAt: number;
	readonly count: number;
	readonly data: Record<string, unknown>;
}

interface DiagnosticsState {
	diagnostics: Diagnostic[];
	isRunning: boolean;

	// Actions
	loadDiagnostics: () => Promise<void>;
	runDiagnostics: (workspaceId?: string) => Promise<void>;
	dismissDiagnostic: (id: string) => Promise<void>;
	/** Apply a remediation action attached to a diagnostic. */
	applyAction: (diagnostic: Diagnostic, action: DiagnosticAction) => Promise<void>;

	// Event sinks (called from index.tsx message router)
	onDetected: (diagnostic: Diagnostic) => void;
	onChanged: (diagnostics: Diagnostic[]) => void;

	// Computed
	getBySeverity: (severity: DiagnosticSeverity) => Diagnostic[];
	getForTask: (taskId: string) => Diagnostic[];
}

export const useDiagnosticsStore = create<DiagnosticsState>((set, get) => ({
	diagnostics: [],
	isRunning: false,

	loadDiagnostics: async () => {
		try {
			const list = await sendRequest<Record<string, never>, Diagnostic[]>('diagnostics.list', {});
			set({ diagnostics: Array.isArray(list) ? list : [] });
		} catch (err) {
			console.error('[DiagnosticsStore] Failed to load diagnostics:', err);
		}
	},

	runDiagnostics: async (workspaceId?: string) => {
		set({ isRunning: true });
		try {
			const list = await sendRequest<{ workspaceId?: string }, Diagnostic[]>(
				'diagnostics.run',
				{ workspaceId }
			);
			set({ diagnostics: Array.isArray(list) ? list : [], isRunning: false });
		} catch (err) {
			console.error('[DiagnosticsStore] Failed to run diagnostics:', err);
			set({ isRunning: false });
		}
	},

	dismissDiagnostic: async (id: string) => {
		// Optimistic removal; host pushes a diagnostics.changed snapshot to confirm.
		set(state => ({ diagnostics: state.diagnostics.filter(d => d.id !== id) }));
		try {
			await sendRequest<{ id: string }, void>('diagnostics.dismiss', { id });
		} catch (err) {
			console.error('[DiagnosticsStore] Failed to dismiss diagnostic:', err);
		}
	},

	applyAction: async (diagnostic, action) => {
		const taskStore = useTaskBoardStore.getState();
		const taskId = action.taskId ?? diagnostic.taskId;
		try {
			switch (action.type) {
				case 'specify':
					if (taskId) { await taskStore.specifyTask(taskId); }
					break;
				case 'decompose':
					if (taskId) { await taskStore.decomposeTask(taskId); }
					break;
				case 'unblock':
					if (taskId) { await taskStore.updateTaskStatus(taskId, 'todo', 'task-board'); }
					break;
				case 'reclaim':
					if (taskId) { await taskStore.updateTaskStatus(taskId, 'ready', 'task-board'); }
					break;
				case 'cancel':
					if (taskId) { await taskStore.updateTaskStatus(taskId, 'cancelled', 'task-board'); }
					break;
				case 'dismiss':
				default:
					break;
			}
		} catch (err) {
			console.error('[DiagnosticsStore] Failed to apply action:', err);
		} finally {
			// Whatever the remediation, dismiss the diagnostic so it clears from the UI;
			// the next host scan will re-raise it if the condition still holds.
			await get().dismissDiagnostic(diagnostic.id);
		}
	},

	onDetected: (diagnostic) => {
		set(state => {
			const idx = state.diagnostics.findIndex(d => d.id === diagnostic.id);
			if (idx >= 0) {
				const next = state.diagnostics.slice();
				next[idx] = diagnostic;
				return { diagnostics: next };
			}
			return { diagnostics: [...state.diagnostics, diagnostic] };
		});
	},

	onChanged: (diagnostics) => {
		set({ diagnostics: Array.isArray(diagnostics) ? diagnostics : [] });
	},

	getBySeverity: (severity) => get().diagnostics.filter(d => d.severity === severity),
	getForTask: (taskId) => get().diagnostics.filter(d => d.taskId === taskId),
}));
