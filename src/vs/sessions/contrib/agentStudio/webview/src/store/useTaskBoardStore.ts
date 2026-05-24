/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Task Board Store (Zustand)
 *  Manages kanban task board state: tasks, drag, collapse, CRUD
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';
import { useDelegationStore, type Delegation } from './useDelegationStore';

export type TaskBoardStatus = 'todo' | 'running' | 'done' | 'cancelled' | 'archived';
export type TaskSource = 'task-board' | 'delegation';

export interface TaskBoardRecord {
	id: string;
	title: string;
	description?: string;
	status: TaskBoardStatus;
	source: TaskSource;
	assigneeId?: string;
	assigneeName?: string;
	fromEmployeeId?: string;
	fromEmployeeName?: string;
	toEmployeeId?: string;
	toEmployeeName?: string;
	workspaceId?: string;
	priority?: 'low' | 'medium' | 'high';
	dependencies?: string[];
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	result?: string;
	error?: string;
	sourceId?: string;
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
		fromEmployeeId: d.assignerId,
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

	// Actions
	loadTasks: (workspaceId?: string) => Promise<void>;
	updateTaskStatus: (taskId: string, status: TaskBoardStatus, source: TaskSource) => Promise<void>;
	createTask: (data: Partial<TaskBoardRecord>) => Promise<void>;
	deleteTask: (taskId: string, source: TaskSource) => Promise<void>;
	archiveTask: (taskId: string, source: TaskSource) => Promise<void>;
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

	loadTasks: async (workspaceId?: string) => {
		set({ isLoading: true });
		try {
			// Load standalone tasks
			const boardTasks = await sendRequest<{ workspaceId?: string }, TaskBoardRecord[]>(
				'taskBoard.list',
				{ workspaceId }
			);

			// Load delegations and convert
			const delegations = useDelegationStore.getState().delegations;
			const delegationTasks = delegations.map(delegationToRecord);

			// Merge both sources
			const allTasks = [
				...boardTasks.map(t => ({ ...t, source: 'task-board' as TaskSource })),
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
				// Map back to delegation status
				const delegationStatus = status === 'todo' ? 'pending' : status;
				await sendRequest('delegation.update', { id: taskId, status: delegationStatus });
			} else {
				await sendRequest('taskBoard.update', { id: taskId, status });
			}
			set(state => ({
				tasks: state.tasks.map(t => t.id === taskId ? { ...t, status } : t),
			}));
		} catch (err) {
			console.error('[TaskBoardStore] Failed to update task status:', err);
		}
	},

	createTask: async (data) => {
		try {
			const task = await sendRequest<Partial<TaskBoardRecord>, TaskBoardRecord>('taskBoard.create', data);
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
				tasks: state.tasks.map(t => t.id === taskId ? { ...t, status: 'archived' as TaskBoardStatus } : t),
			}));
		} catch (err) {
			console.error('[TaskBoardStore] Failed to archive task:', err);
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
		return get().tasks.filter(t => t.status === status);
	},
}));
