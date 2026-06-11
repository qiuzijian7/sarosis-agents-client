/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Task Board Store (Zustand)
 *  Manages kanban task board state: tasks, drag, collapse, CRUD
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';
import { useDelegationStore, type Delegation } from './useDelegationStore';
import { useBoardStore } from './useBoardStore';

export type TaskBoardStatus = 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'done' | 'cancelled' | 'archived';
export type TaskSource = 'task-board' | 'delegation';

/** Metadata for a file attached to a task (content stored host-side, P2). */
export interface TaskAttachment {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	createdAt: string;
}

export interface TaskBoardRecord {
	id: string;
	title: string;
	description?: string;
	status: TaskBoardStatus;
	source: TaskSource;
	assigneeId?: string;
	assigneeName?: string;
	worktreePath?: string;
	fromAgentId?: string;
	fromAgentName?: string;
	toAgentId?: string;
	toAgentName?: string;
	workspaceId?: string;
	boardId?: string;
	priority?: 'low' | 'medium' | 'high';
	dependencies?: string[];
	attachments?: TaskAttachment[];
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	result?: string;
	error?: string;
	sourceId?: string;
	/** v10: associated workflow ID (set when creating task with a workflow). */
	workflowId?: string;
}

// Delegation status → TaskBoard status mapping
const DELEGATION_STATUS_MAP: Record<string, TaskBoardStatus> = {
	pending: 'todo',
	running: 'running',
	done: 'done',
	error: 'done',
	cancelled: 'cancelled',
};

function delegationToRecord(d: Delegation): TaskBoardRecord {
	return {
		id: d.id,
		title: d.title || (d.description && d.description.length > 60 ? d.description.slice(0, 60) + '...' : d.description || ''),
		description: d.description,
		status: DELEGATION_STATUS_MAP[d.status] || 'todo',
		source: 'delegation',
		assigneeId: d.assigneeId,
		fromAgentId: d.assignerId,
		workspaceId: d.workspaceId,
		dependencies: d.dependencies,
		createdAt: d.createdAt,
		finishedAt: d.completedAt,
		result: d.result,
		error: d.error,
	};
}

interface TaskBoardState {
	tasks: TaskBoardRecord[];
	isCollapsed: boolean;
	isLoading: boolean;
	dragTargetId: string | null;
	focusedTaskId: string | null;
	/** Task id currently undergoing an LLM triage op (specify/decompose), for spinner UI. */
	triagePendingId: string | null;

	// Actions
	loadTasks: (workspaceId?: string, boardId?: string) => Promise<void>;
	updateTaskStatus: (taskId: string, status: TaskBoardStatus, source: TaskSource) => Promise<void>;
	createTask: (data: Partial<TaskBoardRecord>) => Promise<void>;
	deleteTask: (taskId: string, source: TaskSource) => Promise<void>;
	archiveTask: (taskId: string, source: TaskSource) => Promise<void>;
	specifyTask: (taskId: string) => Promise<void>;
	decomposeTask: (taskId: string, options?: { fanout?: boolean; maxSubTasks?: number; assignee?: string }) => Promise<void>;
	/** Upload a file as an attachment to a task. */
	addAttachment: (taskId: string, file: File) => Promise<void>;
	/** Remove an attachment from a task. */
	removeAttachment: (taskId: string, attachmentId: string) => Promise<void>;
	/** Fetch an attachment's bytes and trigger a browser download. */
	downloadAttachment: (taskId: string, attachment: TaskAttachment) => Promise<void>;
	toggleCollapse: () => void;
	setDragTarget: (id: string | null) => void;
	focusTask: (taskId: string) => void;
	clearFocus: () => void;

	// Computed
	getTasksByStatus: (status: TaskBoardStatus) => TaskBoardRecord[];
}

export const useTaskBoardStore = create<TaskBoardState>((set, get) => ({
	tasks: [],
	isCollapsed: false,
	isLoading: false,
	dragTargetId: null,
	focusedTaskId: null,
	triagePendingId: null,

	loadTasks: async (workspaceId?: string, boardId?: string) => {
		set({ isLoading: true });
		try {
			// Load standalone tasks (ensure array even if response is unexpected)
			const boardTasks = await sendRequest<{ workspaceId?: string; boardId?: string }, TaskBoardRecord[]>(
				'taskBoard.list',
				{ workspaceId, boardId }
			);
			const safeBoardTasks = Array.isArray(boardTasks) ? boardTasks : [];

			// Load delegations and convert (filter out any undefined delegations).
			// Delegations are not board-scoped; only show them on the default board
			// to avoid leaking cross-board into every board view.
			const showDelegations = !boardId || boardId === 'default';
			const delegations = useDelegationStore.getState().delegations;
			const safeDelegations = showDelegations && Array.isArray(delegations) ? delegations : [];
			const delegationTasks = safeDelegations.map(delegationToRecord).filter(Boolean);

			// Merge both sources (filter out any undefined to prevent render crashes)
			const allTasks = [
				...safeBoardTasks.filter(Boolean).map(t => ({ ...t, source: 'task-board' as TaskSource })),
				...delegationTasks,
			];

			set({ tasks: allTasks, isLoading: false });
		} catch (err) {
			console.error('[TaskBoardStore] Failed to load tasks:', err);
			set({ isLoading: false });
		}
	},

	updateTaskStatus: async (taskId, status, source) => {
		try {
			if (source === 'delegation') {
				// Map back to delegation status (delegation only supports pending/running/done/cancelled).
				// triage/ready/blocked are task-board-only refinements → collapse to pending.
				const delegationStatus =
					(status === 'todo' || status === 'triage' || status === 'ready' || status === 'blocked')
						? 'pending'
						: status;
				await sendRequest('delegation.update', { id: taskId, status: delegationStatus });
			} else {
				await sendRequest('taskBoard.update', { id: taskId, status });
			}
			set(state => ({
				tasks: state.tasks.filter(Boolean).map(t => t.id === taskId ? { ...t, status } : t),
			}));
		} catch (err) {
			console.error('[TaskBoardStore] Failed to update task status:', err);
		}
	},

	createTask: async (data) => {
		try {
			// Inject the active board so manually-created tasks land in the
			// currently-viewed board (falls back to default board server-side
			// when no workspace/board is resolvable).
			const payload: Partial<TaskBoardRecord> = { ...data };
			if (!payload.boardId && payload.workspaceId) {
				const active = useBoardStore.getState().activeByWorkspace[payload.workspaceId];
				if (active) { payload.boardId = active; }
			}
			const task = await sendRequest<Partial<TaskBoardRecord>, TaskBoardRecord>('taskBoard.create', payload);
			set(state => ({ tasks: [...state.tasks, { ...task, source: 'task-board' }] }));
		} catch (err) {
			console.error('[TaskBoardStore] Failed to create task:', err);
		}
	},

	deleteTask: async (taskId, source) => {
		try {
			if (source === 'delegation') {
				await sendRequest('delegation.delete', { id: taskId });
			} else {
				await sendRequest('taskBoard.delete', { id: taskId });
			}
			set(state => ({ tasks: state.tasks.filter(t => t.id !== taskId) }));
		} catch (err) {
			console.error('[TaskBoardStore] Failed to delete task:', err);
		}
	},

	archiveTask: async (taskId, source) => {
		try {
			await sendRequest('taskBoard.archive', { id: taskId });
			set(state => ({
				tasks: state.tasks.filter(Boolean).map(t => t.id === taskId ? { ...t, status: 'archived' as TaskBoardStatus } : t),
			}));
		} catch (err) {
			console.error('[TaskBoardStore] Failed to archive task:', err);
		}
	},

	specifyTask: async (taskId) => {
		set({ triagePendingId: taskId });
		try {
			const updated = await sendRequest<{ taskId: string }, TaskBoardRecord>('triage.specify', { taskId });
			if (updated && updated.id) {
				set(state => ({
					tasks: state.tasks.filter(Boolean).map(t => t.id === updated.id ? { ...t, ...updated, source: 'task-board' as TaskSource } : t),
				}));
			} else {
				// Fall back to a full reload if the host returned nothing usable.
				await get().loadTasks();
			}
		} catch (err) {
			console.error('[TaskBoardStore] Failed to specify task:', err);
		} finally {
			set({ triagePendingId: null });
		}
	},

	decomposeTask: async (taskId, options) => {
		set({ triagePendingId: taskId });
		try {
			await sendRequest<{ taskId: string; fanout?: boolean; maxSubTasks?: number; assignee?: string }, TaskBoardRecord[]>(
				'triage.decompose',
				{ taskId, ...(options ?? {}) }
			);
			// Subtasks were created host-side; reload to pick up the new tasks + parent status.
			await get().loadTasks();
		} catch (err) {
			console.error('[TaskBoardStore] Failed to decompose task:', err);
		} finally {
			set({ triagePendingId: null });
		}
	},

	addAttachment: async (taskId: string, file: File) => {
		try {
			// Read the file as base64 (strip the data: URL prefix).
			const base64Content = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const result = reader.result as string;
					const comma = result.indexOf(',');
					resolve(comma >= 0 ? result.slice(comma + 1) : result);
				};
				reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
				reader.readAsDataURL(file);
			});
			const attachment = await sendRequest<
				{ taskId: string; name: string; mimeType: string; base64Content: string },
				TaskAttachment
			>('attachment.add', {
				taskId,
				name: file.name,
				mimeType: file.type || 'application/octet-stream',
				base64Content,
			});
			set(state => ({
				tasks: state.tasks.map(t =>
					t.id === taskId
						? { ...t, attachments: [...(t.attachments ?? []), attachment] }
						: t
				),
			}));
		} catch (err) {
			console.error('[TaskBoardStore] Failed to add attachment:', err);
		}
	},

	removeAttachment: async (taskId: string, attachmentId: string) => {
		try {
			await sendRequest<{ taskId: string; attachmentId: string }, void>('attachment.remove', { taskId, attachmentId });
			set(state => ({
				tasks: state.tasks.map(t =>
					t.id === taskId
						? { ...t, attachments: (t.attachments ?? []).filter(a => a.id !== attachmentId) }
						: t
				),
			}));
		} catch (err) {
			console.error('[TaskBoardStore] Failed to remove attachment:', err);
		}
	},

	downloadAttachment: async (taskId: string, attachment: TaskAttachment) => {
		try {
			const base64Content = await sendRequest<{ taskId: string; attachmentId: string }, string>(
				'attachment.read',
				{ taskId, attachmentId: attachment.id }
			);
			// Decode base64 → Blob → trigger download.
			const binary = atob(base64Content);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
			const blob = new Blob([bytes], { type: attachment.mimeType || 'application/octet-stream' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = attachment.name;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (err) {
			console.error('[TaskBoardStore] Failed to download attachment:', err);
		}
	},

	toggleCollapse: () => set(state => ({ isCollapsed: !state.isCollapsed })),
	setDragTarget: (id) => set({ dragTargetId: id }),
	focusTask: (taskId: string) => {
		set({ focusedTaskId: taskId });
		// Auto-clear focus after 4 seconds
		setTimeout(() => {
			const current = get().focusedTaskId;
			if (current === taskId) { set({ focusedTaskId: null }); }
		}, 4000);
	},
	clearFocus: () => set({ focusedTaskId: null }),

	getTasksByStatus: (status) => {
		return get().tasks.filter(t => t && t.status === status);
	},
}));
