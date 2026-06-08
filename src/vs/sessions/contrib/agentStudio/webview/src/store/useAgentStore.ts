/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Agent Store (Zustand)
 *  v3: unified agent store — replaces useEmployeeStore entirely
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest, postMessage } from '../bridge/messageClient';
import { useWorkspaceStore } from './useWorkspaceStore';

export type AgentCategory = 'General' | 'Development' | 'Research' | 'Creative' | 'Management' | 'DevOps' | 'Analytics';
export type AgentStatus = 'idle' | 'working' | 'thinking' | 'error' | 'offline';
export type AgentType = 'planner' | 'worker';

export interface Agent {
	id: string;
	name: string;
	role: string;
	description: string;
	icon: string;
	avatar?: string;
	avatarStyle?: string;
	avatarSeed?: string;
	presetId?: string;
	email?: string;
	category: AgentCategory;

	// ── Chat configuration ──────────────────────────
	model?: string | string[] | { primary: string; fallbacks: string[] };
	provider?: string;
	providerId?: string;
	modelId?: string;
	systemPrompt: string;
	customPrompt?: string;
	temperature?: number;
	maxTokens?: number;
	tokenUsage?: number | { input: number; output: number; total: number };

	// ── Capabilities ────────────────────────────────
	skills: string[];
	skillErrorCount?: number;
	missingSkillIds?: string[];
	tools: string[];

	// ── Advanced (optional) ─────────────────────────
	handOffs?: Array<{ agent: string; label: string; prompt: string; send: boolean }>;
	hooks?: Record<string, unknown>;
	visibility?: { userInvocable: boolean; agentInvocable: boolean };
	agents?: string[];
	confidenceThreshold?: number;
	parallelStrategy?: 'voting' | 'coverage';

	// ── Organization ────────────────────────────────
	agentType?: AgentType;
	teamId?: string;
	workspaceId?: string;
	position?: { x: number; y: number };
	isPM?: boolean;
	sortOrder?: number;
	subagentOf?: string | null;
	connections?: Array<{ id: string; sourceId: string; targetId: string; type: string; label?: string }>;

	// ── Disk paths ──────────────────────────────────
	agentDir?: string;
	worktreePath?: string;
	worktreeBranch?: string;

	// ── Bootstrap (transient, not persisted) ────────
	bootstrapTemplates?: {
		agentsMd?: string;
		soulMd?: string;
		identityMd?: string;
		toolsMd?: string;
		memoryMd?: string;
	};

	// ── Memory ──────────────────────────────────────
	memoryConfig?: {
		enabled: boolean;
		maxEntries: number;
		strategy: 'summary' | 'full' | 'sliding_window';
		windowSize?: number;
		scope?: 'agent' | 'workspace' | 'global';
		entries: MemoryEntry[];
	};

	// ── Knowledge ───────────────────────────────────
	knowledgeConfig?: {
		enabled: boolean;
		retrievalStrategy: 'keyword' | 'semantic' | 'hybrid';
		maxResults: number;
		sources: KnowledgeSource[];
	};

	// ── ConfigMD ────────────────────────────────────
	configMd?: {
		mdPath: string;
		parserPath?: string;
		stylesPath?: string;
		displayMode: 'side' | 'replace' | 'tab';
		defaultView?: 'preview' | 'source' | 'split';
		editable?: boolean;
		size?: { width?: string; height?: string; minWidth?: string; minHeight?: string; resizable?: boolean };
		sandboxLevel?: 'strict' | 'standard' | 'permissive';
		autoShow?: boolean;
		syncDebounceMs?: number;
		capabilities?: string[];
	};

	// ── Metadata ────────────────────────────────────
	source: 'builtin' | 'custom';
	status: AgentStatus;
	createdAt: string;
	updatedAt: string;
}

export interface MemoryEntry {
	id: string;
	key: string;
	value: string;
	category?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface KnowledgeSource {
	id: string;
	name: string;
	type: 'file' | 'url' | 'text' | 'vector_store';
	source: string;
	enabled: boolean;
	description?: string;
	tags?: string[];
}

/** Portable export format */
export interface AgentExportData {
	readonly version: 1;
	readonly exportedAt: string;
	readonly agent: Partial<Agent>;
	readonly agentConfig: Record<string, unknown>;
	readonly files: {
		readonly agentsMd?: string;
		readonly soulMd?: string;
		readonly identityMd?: string;
		readonly toolsMd?: string;
		readonly memoryMd?: string;
	};
}

interface AgentState {
	agents: Agent[];
	selectedAgentId: string | null;
	searchQuery: string;
	isLoading: boolean;

	// Actions
	loadAgents: (workspaceId?: string) => Promise<void>;
	selectAgent: (id: string | null, _skipBroadcast?: boolean) => void;
	setSearchQuery: (query: string) => void;
	createAgent: (data: Partial<Agent>) => Promise<Agent>;
	updateAgent: (id: string, data: Partial<Agent>) => Promise<void>;
	deleteAgent: (id: string) => Promise<void>;
	exportAgent: (id: string) => Promise<AgentExportData>;
	importAgent: (data: AgentExportData, workspaceId?: string) => Promise<Agent>;

	// Computed
	filteredAgents: () => Agent[];
	getPlanners: () => Agent[];
	isSelectedPlanner: () => boolean;
}

export const useAgentStore = create<AgentState>((set, get) => ({
	agents: [],
	selectedAgentId: null,
	searchQuery: '',
	isLoading: false,

	loadAgents: async (workspaceId?: string) => {
		set({ isLoading: true });
		try {
			const agents = await sendRequest<{ workspaceId?: string }, Agent[]>(
				'agents.list',
				{ workspaceId }
			);
			set({ agents, isLoading: false });
		} catch (err) {
			console.error('[AgentStore] Failed to load agents:', err);
			set({ isLoading: false });
		}
	},

	selectAgent: (id, _skipBroadcast = false) => {
		set({ selectedAgentId: id });
		if (!_skipBroadcast) {
			postMessage('agents.selected', { agentId: id });
		}
	},

	setSearchQuery: (query) => set({ searchQuery: query }),

	createAgent: async (data) => {
		if (useWorkspaceStore.getState().isReadOnly) {
			throw new Error('Fork mode: cannot create agents');
		}
		const agent = await sendRequest<Partial<Agent>, Agent>('agents.create', data);
		set(state => ({ agents: [...state.agents, agent] }));
		return agent;
	},

	updateAgent: async (id, data) => {
		if (useWorkspaceStore.getState().isReadOnly) {
			throw new Error('Fork mode: cannot modify agents');
		}
		await sendRequest('agents.update', { id, data });
		set(state => ({
			agents: state.agents.map(a => a.id === id ? { ...a, ...data } : a),
		}));
	},

	deleteAgent: async (id) => {
		if (useWorkspaceStore.getState().isReadOnly) {
			throw new Error('Fork mode: cannot delete agents');
		}
		await sendRequest('agents.delete', { id });
		set(state => ({
			agents: state.agents.filter(a => a.id !== id),
			selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId,
		}));
	},

	exportAgent: async (id) => {
		const exportData = await sendRequest<{ id: string }, AgentExportData>('agents.export', { id });
		return exportData;
	},

	importAgent: async (data, workspaceId) => {
		const agent = await sendRequest<{ exportData: AgentExportData; workspaceId?: string }, Agent>(
			'agents.import',
			{ exportData: data, workspaceId },
		);
		set(state => ({ agents: [...state.agents, agent] }));
		return agent;
	},

	filteredAgents: () => {
		const { agents, searchQuery } = get();
		if (!searchQuery) { return agents; }
		const q = searchQuery.toLowerCase();
		return agents.filter(a =>
			a?.name?.toLowerCase().includes(q) ||
			a?.role?.toLowerCase().includes(q)
		);
	},

	getPlanners: () => {
		return get().agents.filter(a =>
			a.agentType === 'planner'
			|| a.presetId === 'planner'
			|| a.role?.toLowerCase().includes('planner')
			|| a.name?.toLowerCase() === 'planner'
		);
	},

	isSelectedPlanner: () => {
		const { agents, selectedAgentId } = get();
		if (!selectedAgentId) { return false; }
		const agent = agents.find(a => a.id === selectedAgentId);
		return agent?.agentType === 'planner'
			|| agent?.presetId === 'planner'
			|| agent?.role?.toLowerCase().includes('planner')
			|| agent?.name?.toLowerCase() === 'planner';
	},
}));
