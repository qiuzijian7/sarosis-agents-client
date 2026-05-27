/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Workspace Store (Zustand)
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';

interface WorkspaceNode {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: Record<string, unknown>;
}

interface WorkspaceEdge {
	id: string;
	source: string;
	target: string;
	type?: string;
	data?: Record<string, unknown>;
}

interface Workspace {
	id: string;
	name: string;
	description?: string;
	/** Git worktree directory for agent isolation */
	worktreePath?: string;
	/** Branch name of the associated worktree */
	worktreeBranch?: string;
	/** Lifecycle status of the worktree (pending/ready/failed) */
	worktreeStatus?: 'none' | 'pending' | 'ready' | 'failed';
}

interface WorkspaceState {
	workspaces: Workspace[];
	activeWorkspaceId: string | null;
	nodes: WorkspaceNode[];
	edges: WorkspaceEdge[];
	viewport: { x: number; y: number; zoom: number };
	isLoading: boolean;
	/** True when in Fork (read-only) mode — canvas editing is disabled */
	isReadOnly: boolean;

	// Actions
	loadWorkspaces: () => Promise<void>;
	createWorkspace: (name: string, description?: string) => Promise<string | null>;
	createWorkspaceWithWorktree: (name: string, options?: { mode?: 'main' | 'create' | 'existing'; worktreeName?: string; existingPath?: string; detached?: boolean }) => Promise<string | null>;
	deleteWorkspace: (id: string) => Promise<boolean>;
	setActiveWorkspace: (id: string) => Promise<void>;
	updateNodes: (nodes: WorkspaceNode[]) => void;
	updateEdges: (edges: WorkspaceEdge[]) => void;
	updateViewport: (viewport: { x: number; y: number; zoom: number }) => void;
	saveLayout: () => Promise<void>;
	setReadOnly: (readOnly: boolean) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
	workspaces: [],
	activeWorkspaceId: null,
	nodes: [],
	edges: [],
	viewport: { x: 0, y: 0, zoom: 1 },
	isLoading: false,
	isReadOnly: false,

	loadWorkspaces: async () => {
		set({ isLoading: true });
		try {
			const workspaces = await sendRequest<unknown, Workspace[]>('workspace.list', {});
			// 恢复上次活动的工作区
			let activeWorkspaceId: string | null = null;
			try {
				activeWorkspaceId = await sendRequest<unknown, string | null>('workspace.getActive', {});
				// 验证恢复的 workspace ID 是否有效
				if (activeWorkspaceId && !workspaces.find(w => w.id === activeWorkspaceId)) {
					activeWorkspaceId = null;
				}
			} catch {
				// 获取失败，使用默认行为
			}
			set({ workspaces, activeWorkspaceId, isLoading: false });
			// 如果有上次活动的工作区，自动加载它
			if (activeWorkspaceId) {
				get().setActiveWorkspace(activeWorkspaceId);
			}
		} catch (err) {
			console.error('[WorkspaceStore] Failed to load workspaces:', err);
			set({ isLoading: false });
		}
	},

	createWorkspace: async (name: string, description?: string) => {
		try {
			const result = await sendRequest<{ name: string; description?: string }, { id: string }>('workspace.create', { name, description });
			if (result?.id) {
				// Reload workspaces list and switch to new one
				const workspaces = await sendRequest<unknown, Workspace[]>('workspace.list', {});
				set({ workspaces, activeWorkspaceId: result.id, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
				return result.id;
			}
			return null;
		} catch (err) {
			console.error('[WorkspaceStore] Failed to create workspace:', err);
			return null;
		}
	},

	/**
	 * Create a workspace with worktree isolation (opencode pattern).
	 * Supports three modes: 'main' (no worktree), 'create' (new worktree), 'existing' (use existing).
	 */
	createWorkspaceWithWorktree: async (name: string, options?: { mode?: 'main' | 'create' | 'existing'; worktreeName?: string; existingPath?: string; detached?: boolean }) => {
		try {
			const result = await sendRequest<{ name: string; mode?: string; name?: string; existingPath?: string; detached?: boolean }, { id: string }>(
				'workspace.createWithWorktree',
				{ name, ...options },
			);
			if (result?.id) {
				const workspaces = await sendRequest<unknown, Workspace[]>('workspace.list', {});
				set({ workspaces, activeWorkspaceId: result.id, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
				return result.id;
			}
			return null;
		} catch (err) {
			console.error('[WorkspaceStore] Failed to create workspace with worktree:', err);
			return null;
		}
	},

	deleteWorkspace: async (id: string) => {
		try {
			await sendRequest<{ id: string }, void>('workspace.delete', { id });
			const workspaces = await sendRequest<unknown, Workspace[]>('workspace.list', {});
			const { activeWorkspaceId } = get();
			// If the deleted workspace was active, clear the selection
			const newActiveId = activeWorkspaceId === id
				? (workspaces[0]?.id ?? null)
				: activeWorkspaceId;
			set({ workspaces, activeWorkspaceId: newActiveId });
			return true;
		} catch (err) {
			console.error('[WorkspaceStore] Failed to delete workspace:', err);
			return false;
		}
	},

	setActiveWorkspace: async (id: string) => {
		set({ isLoading: true, activeWorkspaceId: id });
		try {
			const workspace = await sendRequest<{ id: string }, any>('workspace.get', { id });
			
			// Load edges from layout.edges, fallback to connections if layout.edges is empty
			let edges = workspace?.layout?.edges || [];
			if (edges.length === 0 && workspace?.connections) {
				// Build edges from connections as fallback
				edges = workspace.connections.map((conn: any) => ({
					id: conn.id,
					source: conn.sourceId,
					target: conn.targetId,
					type: conn.type,
					data: { label: conn.label },
				}));
			}
			
			set({
				nodes: workspace?.layout?.nodes || [],
				edges: edges,
				viewport: workspace?.layout?.viewport || { x: 0, y: 0, zoom: 1 },
				isLoading: false,
			});
			
			// 持久化最后活动的工作区ID
			try {
				await sendRequest('workspace.setActive', { id });
			} catch (err) {
				console.warn('[WorkspaceStore] Failed to persist active workspace:', err);
			}
		} catch (err) {
			console.error('[WorkspaceStore] Failed to load workspace:', err);
			set({ isLoading: false });
		}
	},

	updateNodes: (nodes) => set({ nodes }),
	updateEdges: (edges) => set({ edges }),
	updateViewport: (viewport) => set({ viewport }),

	saveLayout: async () => {
		const { activeWorkspaceId, nodes, edges, viewport, isReadOnly } = get();
		if (!activeWorkspaceId || isReadOnly) {
			console.warn('[WorkspaceStore] saveLayout skipped:', { activeWorkspaceId, isReadOnly });
			return;
		}
		try {
			// Strip non-serializable data (e.g. onSelect/onDelete callbacks)
			// from nodes before sending via postMessage (structured clone).
			const serializableNodes = nodes.map(n => ({
				id: n.id,
				type: n.type,
				position: n.position,
				data: {},
			}));
			console.log('[WorkspaceStore] saveLayout sending:', {
				workspaceId: activeWorkspaceId,
				nodeCount: serializableNodes.length,
				positions: serializableNodes.map(n => ({ id: n.id, pos: n.position })),
			});
			await sendRequest('workspace.updateLayout', {
				workspaceId: activeWorkspaceId,
				nodes: serializableNodes,
				edges,
				viewport,
			});
			console.log('[WorkspaceStore] saveLayout response received');
		} catch (err) {
			console.error('[WorkspaceStore] Failed to save layout:', err);
		}
	},

	setReadOnly: (readOnly: boolean) => set({ isReadOnly: readOnly }),
}));
