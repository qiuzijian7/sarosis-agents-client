/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee Store (Zustand)
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest, postMessage } from '../bridge/messageClient';
import { useWorkspaceStore } from './useWorkspaceStore';

export type AgentType = 'planner' | 'pm' | 'worker';

export interface Employee {
	id: string;
	name: string;
	role: string;
	email?: string;
	avatar?: string;
	avatarStyle?: string;
	avatarSeed?: string;
	presetId?: string;
	model?: string;
	provider?: string;
	customPrompt?: string;
	/** Skill IDs referenced by this agent (new architecture: skills stored in ~/.sarosis/skills-library/) */
	skills?: string[];
	/** Number of skills that are missing from the skill library (for UI warning badge) */
	skillErrorCount?: number;
	status: 'idle' | 'working' | 'thinking' | 'error' | 'offline';
	/**
	 * Agent type: planner (can orchestrate), pm (can dispatch, max 1 per workspace), worker (default).
	 */
	agentType?: AgentType;
	teamId?: string;
	workspaceId?: string;
	position?: { x: number; y: number };
	/** LLM temperature (0-2) */
	temperature?: number;
	/** Max tokens for LLM response */
	maxTokens?: number;
	tokenUsage?: number | { input: number; output: number; total: number };
	isPM?: boolean;
	sortOrder?: number;
	subagentOf?: string | null;
	category?: string;
	/** Path to the agent instance directory under .sarosisworkspace/agents/{slug}/ */
	agentDir?: string;
	/** Number of skills that are missing from the skill library (for UI warning badge) */
	skillErrorCount?: number;
	/** Missing skill IDs - for UI dialog display */
	missingSkillIds?: string[];
	/**
	 * Bootstrap templates from a preset, used when creating the agent instance directory.
	 * Transient — only used during creation, not persisted.
	 */
	bootstrapTemplates?: {
		agentsMd?: string;
		soulMd?: string;
		identityMd?: string;
		toolsMd?: string;
		memoryMd?: string;
	};
	/** Memory configuration for the agent */
	memoryConfig?: MemoryConfig;
	/** Knowledge base configuration for the agent */
	knowledgeConfig?: KnowledgeConfig;
	/**
	 * ConfigMD configuration — Markdown file as canonical data source rendered as HTML.
	 * Mirrors AgentConfigMd in src/vs/sessions/common/agentStudioTypes.ts.
	 */
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
}

/** Memory entry persisted across sessions */
export interface MemoryEntry {
	id: string;
	key: string;
	value: string;
	category?: string;
	createdAt?: string;
	updatedAt?: string;
}

/** Memory configuration */
export interface MemoryConfig {
	/** Whether memory is enabled */
	enabled: boolean;
	/** Maximum number of memory entries */
	maxEntries: number;
	/** Memory strategy: 'sliding_window' | 'summary' | 'full' */
	strategy: 'sliding_window' | 'summary' | 'full';
	/** Sliding window size (for sliding_window strategy) */
	windowSize?: number;
	/** Custom memory entries */
	entries: MemoryEntry[];
}

/** Knowledge base source */
export interface KnowledgeSource {
	id: string;
	name: string;
	type: 'file' | 'url' | 'text' | 'vector_store';
	/** Source path/URL/text content */
	source: string;
	/** Whether this source is enabled */
	enabled: boolean;
	/** Optional description */
	description?: string;
	/** Optional tags */
	tags?: string[];
}

/** Knowledge base configuration */
export interface KnowledgeConfig {
	/** Whether knowledge base is enabled */
	enabled: boolean;
	/** Retrieval strategy: 'keyword' | 'semantic' | 'hybrid' */
	retrievalStrategy: 'keyword' | 'semantic' | 'hybrid';
	/** Maximum number of results to retrieve */
	maxResults: number;
	/** Knowledge sources */
	sources: KnowledgeSource[];
}

/** Portable export format for an agent instance */
export interface AgentExportData {
	readonly version: 1;
	readonly exportedAt: string;
	readonly employee: Partial<Employee>;
	readonly agentConfig: Record<string, unknown>;
	readonly files: {
		readonly agentsMd?: string;
		readonly soulMd?: string;
		readonly identityMd?: string;
		readonly toolsMd?: string;
		readonly memoryMd?: string;
	};
}

interface EmployeeState {
	employees: Employee[];
	selectedEmployeeId: string | null;
	searchQuery: string;
	isLoading: boolean;

	// Actions
	loadEmployees: (workspaceId?: string) => Promise<void>;
	selectEmployee: (id: string | null, _skipBroadcast?: boolean) => void;
	setSearchQuery: (query: string) => void;
	createEmployee: (data: Partial<Employee>) => Promise<Employee>;
	updateEmployee: (id: string, data: Partial<Employee>) => Promise<void>;
	deleteEmployee: (id: string) => Promise<void>;
	exportEmployee: (id: string) => Promise<AgentExportData>;
	importEmployee: (data: AgentExportData, workspaceId?: string) => Promise<Employee>;

	// Computed
	filteredEmployees: () => Employee[];
	/** Get all planners in the workspace */
	getPlanners: () => Employee[];
	/** Get the workspace PM (at most one) */
	getPM: () => Employee | undefined;
	/** Check if the selected employee is a planner */
	isSelectedPlanner: () => boolean;
	/** Check if the selected employee is the PM */
	isSelectedPM: () => boolean;
}

export const useEmployeeStore = create<EmployeeState>((set, get) => ({
	employees: [],
	selectedEmployeeId: null,
	searchQuery: '',
	isLoading: false,

	loadEmployees: async (workspaceId?: string) => {
		set({ isLoading: true });
		try {
			const employees = await sendRequest<{ workspaceId?: string }, Employee[]>(
				'employees.list',
				{ workspaceId }
			);
			set({ employees, isLoading: false });
		} catch (err) {
			console.error('[EmployeeStore] Failed to load employees:', err);
			set({ isLoading: false });
		}
	},

	selectEmployee: (id, _skipBroadcast = false) => {
		set({ selectedEmployeeId: id });
		if (!_skipBroadcast) {
			postMessage('employees.selected', { employeeId: id });
		}
	},
	setSearchQuery: (query) => set({ searchQuery: query }),

	createEmployee: async (data) => {
		if (useWorkspaceStore.getState().isReadOnly) {
			throw new Error('Fork 模式下不可创建 Agent');
		}
		const employee = await sendRequest<Partial<Employee>, Employee>('employees.create', data);
		set(state => ({ employees: [...state.employees, employee] }));
		return employee;
	},

	updateEmployee: async (id, data) => {
		if (useWorkspaceStore.getState().isReadOnly) {
			throw new Error('Fork 模式下不可修改 Agent 配置');
		}
		await sendRequest('employees.update', { id, data });
		set(state => ({
			employees: state.employees.map(e => e.id === id ? { ...e, ...data } : e),
		}));
	},

	deleteEmployee: async (id) => {
		if (useWorkspaceStore.getState().isReadOnly) {
			throw new Error('Fork 模式下不可删除 Agent');
		}
		await sendRequest('employees.delete', { id });
		set(state => ({
			employees: state.employees.filter(e => e.id !== id),
			selectedEmployeeId: state.selectedEmployeeId === id ? null : state.selectedEmployeeId,
		}));
	},

	exportEmployee: async (id) => {
		const exportData = await sendRequest<{ id: string }, AgentExportData>('employees.export', { id });
		return exportData;
	},

	importEmployee: async (data, workspaceId) => {
		const employee = await sendRequest<{ exportData: AgentExportData; workspaceId?: string }, Employee>(
			'employees.import',
			{ exportData: data, workspaceId },
		);
		set(state => ({ employees: [...state.employees, employee] }));
		return employee;
	},

	filteredEmployees: () => {
		const { employees, searchQuery } = get();
		if (!searchQuery) { return employees; }
		const q = searchQuery.toLowerCase();
		return employees.filter(e =>
			e.name.toLowerCase().includes(q) ||
			e.role.toLowerCase().includes(q)
		);
	},

	getPlanners: () => {
		return get().employees.filter(e =>
			e.agentType === 'planner'
			|| e.presetId === 'planner'
			|| e.role?.toLowerCase().includes('planner')
			|| e.name?.toLowerCase() === 'planner'
		);
	},

	getPM: () => {
		return get().employees.find(e => e.agentType === 'pm');
	},

	isSelectedPlanner: () => {
		const { employees, selectedEmployeeId } = get();
		if (!selectedEmployeeId) { return false; }
		const emp = employees.find(e => e.id === selectedEmployeeId);
		return emp?.agentType === 'planner'
			|| emp?.presetId === 'planner'
			|| emp?.role?.toLowerCase().includes('planner')
			|| emp?.name?.toLowerCase() === 'planner';
	},

	isSelectedPM: () => {
		const { employees, selectedEmployeeId } = get();
		if (!selectedEmployeeId) { return false; }
		const emp = employees.find(e => e.id === selectedEmployeeId);
		return emp?.agentType === 'pm';
	},
}));
