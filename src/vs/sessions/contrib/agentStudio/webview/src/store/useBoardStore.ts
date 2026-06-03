/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Board Store (Zustand)
 *  Multi-board isolation (P2): boards are scoped per workspace. Tasks filter by
 *  workspaceId + boardId. The active board is remembered per workspace.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';

/** Mirror of the host TaskBoard entity (sessions/common/agentStudioTypes.ts). */
export interface TaskBoard {
	id: string;
	name: string;
	workspaceId: string;
	order?: number;
	createdAt: string;
	updatedAt: string;
}

/** The implicit default board id (mirror of host DEFAULT_BOARD_ID). */
export const DEFAULT_BOARD_ID = 'default';

interface BoardState {
	/** Boards for the currently loaded workspace. */
	boards: TaskBoard[];
	/** workspaceId → active boardId (remembered locally, avoids multi-instance conflicts). */
	activeByWorkspace: Record<string, string>;
	/** The workspace boards were last loaded for. */
	loadedWorkspaceId: string | undefined;
	isLoading: boolean;

	// Actions
	loadBoards: (workspaceId?: string) => Promise<void>;
	createBoard: (name: string, workspaceId: string) => Promise<TaskBoard | undefined>;
	renameBoard: (boardId: string, name: string) => Promise<void>;
	deleteBoard: (boardId: string, workspaceId: string) => Promise<void>;
	switchBoard: (workspaceId: string, boardId: string) => void;

	// Computed
	getActiveBoardId: (workspaceId?: string) => string;
}

export const useBoardStore = create<BoardState>((set, get) => ({
	boards: [],
	activeByWorkspace: {},
	loadedWorkspaceId: undefined,
	isLoading: false,

	loadBoards: async (workspaceId?: string) => {
		set({ isLoading: true });
		try {
			const boards = await sendRequest<{ workspaceId?: string }, TaskBoard[]>(
				'board.list',
				{ workspaceId },
			);
			const safe = Array.isArray(boards) ? boards.filter(Boolean) : [];
			set(state => {
				// If the remembered active board no longer exists, fall back to default.
				const active = { ...state.activeByWorkspace };
				if (workspaceId) {
					const current = active[workspaceId];
					if (current && !safe.some(b => b.id === current)) {
						active[workspaceId] = DEFAULT_BOARD_ID;
					}
				}
				return { boards: safe, loadedWorkspaceId: workspaceId, activeByWorkspace: active, isLoading: false };
			});
		} catch (err) {
			console.error('[BoardStore] Failed to load boards:', err);
			set({ isLoading: false });
		}
	},

	createBoard: async (name, workspaceId) => {
		try {
			const board = await sendRequest<{ name: string; workspaceId: string }, TaskBoard>(
				'board.create',
				{ name, workspaceId },
			);
			if (board && board.id) {
				set(state => ({
					boards: [...state.boards, board],
					// Auto-switch to the newly created board.
					activeByWorkspace: { ...state.activeByWorkspace, [workspaceId]: board.id },
				}));
				return board;
			}
		} catch (err) {
			console.error('[BoardStore] Failed to create board:', err);
		}
		return undefined;
	},

	renameBoard: async (boardId, name) => {
		try {
			await sendRequest('board.rename', { boardId, name });
			set(state => ({
				boards: state.boards.map(b => b.id === boardId ? { ...b, name } : b),
			}));
		} catch (err) {
			console.error('[BoardStore] Failed to rename board:', err);
		}
	},

	deleteBoard: async (boardId, workspaceId) => {
		try {
			await sendRequest('board.delete', { boardId });
			set(state => {
				const active = { ...state.activeByWorkspace };
				// If we deleted the active board, fall back to default.
				if (active[workspaceId] === boardId) {
					active[workspaceId] = DEFAULT_BOARD_ID;
				}
				return {
					boards: state.boards.filter(b => b.id !== boardId),
					activeByWorkspace: active,
				};
			});
		} catch (err) {
			console.error('[BoardStore] Failed to delete board:', err);
		}
	},

	switchBoard: (workspaceId, boardId) => {
		set(state => ({
			activeByWorkspace: { ...state.activeByWorkspace, [workspaceId]: boardId },
		}));
	},

	getActiveBoardId: (workspaceId?: string) => {
		if (!workspaceId) {
			return DEFAULT_BOARD_ID;
		}
		return get().activeByWorkspace[workspaceId] ?? DEFAULT_BOARD_ID;
	},
}));
