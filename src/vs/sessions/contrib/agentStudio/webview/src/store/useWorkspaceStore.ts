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
}

interface WorkspaceState {
	workspaces: Workspace[];
	activeWorkspaceId: string | null;
	nodes: WorkspaceNode[];
	edges: WorkspaceEdge[];
	viewport: { x: number; y: number; zoom: number };
	isLoading: boolean;

	// Actions
	loadWorkspaces: () => Promise<void>;
	createWorkspace: (name: string, description?: string) => Promise<string | null>;
	setActiveWorkspace: (id: string) => Promise<void>;
	updateNodes: (nodes: WorkspaceNode[]) => void;
	updateEdges: (edges: WorkspaceEdge[]) => void;
	updateViewport: (viewport: { x: number; y: number; zoom: number }) => void;
	saveLayout: () => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
	workspaces: [],
	activeWorkspaceId: null,
	nodes: [],
	edges: [],
	viewport: { x: 0, y: 0, zoom: 1 },
	isLoading: false,

	loadWorkspaces: async () => {
		set({ isLoading: true });
		try {
			const workspaces = await sendRequest<unknown, Workspace[]>('workspace.list', {});
			set({ workspaces, isLoading: false });
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

	setActiveWorkspace: async (id: string) => {
		set({ isLoading: true, activeWorkspaceId: id });
		try {
			const workspace = await sendRequest<{ id: string }, { layout?: { nodes: WorkspaceNode[]; edges: WorkspaceEdge[]; viewport?: { x: number; y: number; zoom: number } } }>('workspace.get', { id });
			set({
				nodes: workspace?.layout?.nodes || [],
				edges: workspace?.layout?.edges || [],
				viewport: workspace?.layout?.viewport || { x: 0, y: 0, zoom: 1 },
				isLoading: false,
			});
		} catch (err) {
			console.error('[WorkspaceStore] Failed to load workspace:', err);
			set({ isLoading: false });
		}
	},

	updateNodes: (nodes) => set({ nodes }),
	updateEdges: (edges) => set({ edges }),
	updateViewport: (viewport) => set({ viewport }),

	saveLayout: async () => {
		const { activeWorkspaceId, nodes, edges, viewport } = get();
		if (!activeWorkspaceId) { return; }
		try {
			await sendRequest('workspace.updateLayout', {
				workspaceId: activeWorkspaceId,
				nodes,
				edges,
				viewport,
			});
		} catch (err) {
			console.error('[WorkspaceStore] Failed to save layout:', err);
		}
	},
}));
